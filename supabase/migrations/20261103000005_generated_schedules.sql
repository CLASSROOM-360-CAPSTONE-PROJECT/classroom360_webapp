-- =====================================================================
-- Classroom360 — saving an automatically generated schedule
--   1. apply_generated_schedule(): replace a program's draft/returned meetings with the
--      generated ones in ONE transaction, so a failed save never leaves the chair with
--      half a timetable (or none)
--   2. A bulk replacement is summarised by one audit entry instead of one DELETE entry per meeting
-- The solver itself runs in the chair's browser. This function is the only door its result
-- goes through, and the database's own exclusion constraints (room, instructor, student block,
-- across every department) still have the last word on every inserted row.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Quiet the per-row DELETE audit while a bulk replacement is running
-- ---------------------------------------------------------------------
drop trigger if exists audit_schedule_entries_deleted on public.schedule_entries;
create trigger audit_schedule_entries_deleted
  after delete on public.schedule_entries
  for each row
  when (coalesce(current_setting('app.bulk_replace', true), '') <> 'on')
  execute function private.audit_row_change();

-- ---------------------------------------------------------------------
-- 2. apply_generated_schedule
--    p_entries: [{section_id, room_id, day_of_week, start_time, end_time}, ...]
--    p_job:     {runtime_ms, soft_penalty, unplaced, message}   (all optional)
--    Only the program's draft and returned meetings are replaced. Anything already
--    submitted, approved or published stays exactly as it is.
-- ---------------------------------------------------------------------
create function public.apply_generated_schedule(
  p_term_id    uuid,
  p_program_id uuid,
  p_entries    jsonb,
  p_job        jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role     public.user_role := private.my_role();
  v_tenant   uuid := private.my_tenant();
  v_bad      text;
  v_replaced integer;
  v_inserted integer;
  v_job      uuid;
begin
  if v_role is null or v_role = 'instructor' then
    raise exception 'not allowed to generate a schedule' using errcode = '42501';
  end if;
  if not exists (select 1 from public.programs where id = p_program_id and tenant_id = v_tenant) then
    raise exception 'program not found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.terms where id = p_term_id and tenant_id = v_tenant) then
    raise exception 'term not found' using errcode = 'P0002';
  end if;
  if v_role = 'program_chair' and not private.program_in_my_department(p_program_id) then
    raise exception 'program belongs to another department' using errcode = '42501';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'entries must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_entries) = 0 then
    raise exception 'nothing to save: the generated schedule is empty' using errcode = '22023';
  end if;
  if jsonb_array_length(p_entries) > 2000 then
    raise exception 'too many meetings in one request' using errcode = '22023';
  end if;

  -- one generation per program at a time
  perform pg_advisory_xact_lock(hashtextextended('generate:' || p_program_id::text, 0));

  -- every meeting must belong to a section of this program and term ...
  select coalesce(e.section_id::text, '(missing section)') into v_bad
    from jsonb_to_recordset(p_entries)
           as e(section_id uuid, room_id uuid, day_of_week smallint, start_time time, end_time time)
    left join public.sections s
           on s.id = e.section_id and s.tenant_id = v_tenant
          and s.term_id = p_term_id and s.program_id = p_program_id
   where s.id is null
   limit 1;
  if found then
    raise exception 'meeting for a section outside this program: %', v_bad using errcode = '22023';
  end if;

  -- ... in a room of this school that is in use ...
  select coalesce(e.room_id::text, '(missing room)') into v_bad
    from jsonb_to_recordset(p_entries)
           as e(section_id uuid, room_id uuid, day_of_week smallint, start_time time, end_time time)
    left join public.rooms r
           on r.id = e.room_id and r.tenant_id = v_tenant and r.is_active
   where r.id is null
   limit 1;
  if found then
    raise exception 'meeting in a room that does not exist or is out of use: %', v_bad using errcode = '22023';
  end if;

  -- ... at a sensible time ...
  perform 1
    from jsonb_to_recordset(p_entries)
           as e(section_id uuid, room_id uuid, day_of_week smallint, start_time time, end_time time)
   where e.day_of_week is null or e.day_of_week not between 1 and 7
      or e.start_time is null or e.end_time is null or e.end_time <= e.start_time
   limit 1;
  if found then
    raise exception 'a meeting has an invalid day or time' using errcode = '22023';
  end if;

  -- ... and no section may end up with more weekly meetings than it has
  select s.code into v_bad
    from public.sections s
    join (
      select e.section_id, count(*) as n
        from jsonb_to_recordset(p_entries)
               as e(section_id uuid, room_id uuid, day_of_week smallint, start_time time, end_time time)
       group by e.section_id
    ) g on g.section_id = s.id
   where g.n + (
           select count(*) from public.schedule_entries x
            where x.section_id = s.id and x.status not in ('draft', 'returned')
         ) > s.meetings_per_week
   limit 1;
  if found then
    raise exception 'section % would have more meetings than it needs', v_bad using errcode = '22023';
  end if;

  -- replace the old draft/returned meetings of this program
  perform set_config('app.bulk_replace', 'on', true);
  delete from public.schedule_entries
   where tenant_id  = v_tenant
     and term_id    = p_term_id
     and program_id = p_program_id
     and status in ('draft', 'returned');
  get diagnostics v_replaced = row_count;
  perform set_config('app.bulk_replace', '', true);

  -- tenant, program, instructor and student block are filled in by schedule_entries_sync;
  -- the exclusion constraints reject any clash and roll the whole call back
  insert into public.schedule_entries (tenant_id, term_id, section_id, room_id, day_of_week, start_time, end_time, status)
  select v_tenant, p_term_id, e.section_id, e.room_id, e.day_of_week, e.start_time, e.end_time, 'draft'
    from jsonb_to_recordset(p_entries)
           as e(section_id uuid, room_id uuid, day_of_week smallint, start_time time, end_time time);
  get diagnostics v_inserted = row_count;

  insert into public.solve_jobs (tenant_id, term_id, program_id, requested_by, status, runtime_ms,
                                 hard_violations, soft_penalty, message, finished_at)
  values (
    v_tenant, p_term_id, p_program_id, auth.uid(), 'feasible',
    nullif(p_job ->> 'runtime_ms', '')::integer,
    0,
    nullif(p_job ->> 'soft_penalty', '')::numeric,
    left(nullif(p_job ->> 'message', ''), 500),
    now()
  )
  returning id into v_job;

  insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, new_data)
  values (
    v_tenant, auth.uid(), 'SCHEDULE_GENERATED', 'schedule_entries', p_program_id::text,
    jsonb_build_object(
      'term_id', p_term_id, 'program_id', p_program_id,
      'replaced', v_replaced, 'entries', v_inserted,
      'unplaced', coalesce(nullif(p_job ->> 'unplaced', '')::integer, 0),
      'solve_job_id', v_job
    )
  );

  return jsonb_build_object('job_id', v_job, 'replaced', v_replaced, 'inserted', v_inserted);
end $$;

revoke all on function public.apply_generated_schedule(uuid, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.apply_generated_schedule(uuid, uuid, jsonb, jsonb) to authenticated, service_role;
