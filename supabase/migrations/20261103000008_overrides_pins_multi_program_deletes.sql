-- =====================================================================
-- Classroom360 — overrides, pinned meetings, several programs at once, safe deletes
--   1. override_schedule_entry(): a dean or administrator moves ONE submitted, approved or published
--      meeting (room, day, time) without reopening the whole timetable. A justification is required,
--      the change is audited, and the database refuses to change a locked meeting any other way.
--      schedule_overrides() lists the overrides so the chair and the instructor can see why.
--   2. Pinned meetings: a chair pins draft meetings so Generate schedule keeps them in place.
--   3. apply_generated_schedules(): save a timetable generated for several programs in ONE transaction.
--      apply_generated_schedule() (one program) keeps working and honours pins too.
--   4. delete_room() and delete_course(): refuse to delete something that classes, requests or a
--      locker door still depend on (the foreign keys would silently delete those too).
--   5. assign_card(): give an instructor an RFID card (replacing the old one) with the card number written
--      the way the locker station reads it.
--   6. set_locker_doors(): choose which room's key is in each of the four doors, including swapping two keys
--      (a room can be on only one door; the swap is checked at the end of the call).
-- Run after 20261103000007_reopen_rooms_courses_classes.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Override a locked meeting
-- ---------------------------------------------------------------------
-- Set by override_schedule_entry() for its own transaction only.
create function private.schedule_entries_lock_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null
     and old.status in ('submitted', 'approved', 'published')
     and (old.room_id is distinct from new.room_id
          or old.day_of_week is distinct from new.day_of_week
          or old.start_time is distinct from new.start_time
          or old.end_time is distinct from new.end_time)
     and coalesce(current_setting('app.override_ok', true), '') <> 'on' then
    raise exception 'a submitted, approved or published meeting can only be changed by an override with a justification, or after the schedule is reopened'
      using errcode = '42501';
  end if;
  return new;
end $$;
create trigger schedule_entries_lock_guard before update on public.schedule_entries
  for each row execute function private.schedule_entries_lock_guard();

-- an override belongs to a locked meeting: once the timetable is back in draft (reopened or rejected) it is just a draft
create function private.schedule_entries_clear_override() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status in ('draft', 'returned') and old.status not in ('draft', 'returned') then
    new.is_override := false;
  end if;
  return new;
end $$;
create trigger schedule_entries_clear_override before update of status on public.schedule_entries
  for each row execute function private.schedule_entries_clear_override();

-- the override writes its own, richer audit entry: skip the generic "meeting moved" row for it
drop trigger if exists audit_schedule_entries_moved on public.schedule_entries;
create trigger audit_schedule_entries_moved
  after update on public.schedule_entries
  for each row
  when ((old.room_id is distinct from new.room_id
         or old.day_of_week is distinct from new.day_of_week
         or old.start_time  is distinct from new.start_time
         or old.end_time    is distinct from new.end_time)
        and coalesce(current_setting('app.override_ok', true), '') <> 'on')
  execute function private.audit_row_change();

create function public.override_schedule_entry(
  p_entry_id      uuid,
  p_room_id       uuid,
  p_day           integer,
  p_start         time,
  p_end           time,
  p_justification text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role     public.user_role := private.my_role();
  v_tenant   uuid := private.my_tenant();
  e          record;
  s          record;
  c          record;
  r          record;
  old_room   text;
  v_need     text;
  v_warn     text[] := '{}';
  v_n        integer;
begin
  if v_role is null or v_role not in ('admin', 'dean') then
    raise exception 'only a dean or administrator can override a locked meeting' using errcode = '42501';
  end if;

  select * into e from public.schedule_entries where id = p_entry_id and tenant_id = v_tenant;
  if not found then
    raise exception 'meeting not found' using errcode = 'P0002';
  end if;
  if e.status not in ('submitted', 'approved', 'published') then
    raise exception 'this meeting is not locked: change it with Edit timetable' using errcode = '55006';
  end if;
  if p_justification is null or length(btrim(p_justification)) < 8 then
    raise exception 'a justification of at least a few words is required' using errcode = '22023';
  end if;
  if p_day is null or p_day not between 1 and 7 or p_start is null or p_end is null or p_end <= p_start then
    raise exception 'the day or time is not valid' using errcode = '22023';
  end if;
  select * into r from public.rooms where id = p_room_id and tenant_id = v_tenant and is_active;
  if not found then
    raise exception 'that room does not exist or is out of use' using errcode = '22023';
  end if;
  if r.id = e.room_id and p_day = e.day_of_week and p_start = e.start_time and p_end = e.end_time then
    raise exception 'nothing to change: that is where the meeting already is' using errcode = '22023';
  end if;

  select code into old_room from public.rooms where id = e.room_id;

  -- the update below is checked by the same exclusion constraints and school-hours rule as everything else;
  -- a clash or a closed hour raises here and nothing is changed
  perform set_config('app.override_ok', 'on', true);
  update public.schedule_entries
     set room_id = p_room_id, day_of_week = p_day, start_time = p_start, end_time = p_end, is_override = true
   where id = p_entry_id;
  perform set_config('app.override_ok', '', true);

  -- things worth a second look (the override still goes through)
  select * into s from public.sections where id = e.section_id;
  select * into c from public.courses  where id = s.course_id;
  if r.capacity < s.enrollment then
    v_warn := v_warn || format('Room %s seats %s but the class has %s students.', r.code, r.capacity, s.enrollment);
  end if;
  v_need := case
              when c.required_facility is null then null
              when s.component = 'lab' or coalesce(c.lab_units, 0) = 0 then c.required_facility
              else null
            end;
  if v_need is not null and not (v_need = any (r.facilities)) then
    v_warn := v_warn || format('Room %s is not a %s room, which this class needs.', r.code, replace(v_need, '_', ' '));
  end if;
  if e.instructor_id is not null then
    if exists (select 1 from public.instructor_work_hours w where w.instructor_id = e.instructor_id)
       and not exists (
         select 1 from public.instructor_work_hours w
          where w.instructor_id = e.instructor_id and w.day_of_week = p_day
            and w.start_time <= p_start and w.end_time >= p_end) then
      v_warn := v_warn || 'The new time is outside the instructor''s work hours.'::text;
    end if;
    if exists (
         select 1 from public.instructor_unavailability u
          where u.instructor_id = e.instructor_id and u.day_of_week = p_day
            and u.start_time < p_end and u.end_time > p_start) then
      v_warn := v_warn || 'The instructor marked the new time as unavailable.'::text;
    end if;
  end if;
  select count(*) into v_n
    from public.room_requests q
   where q.tenant_id = v_tenant and q.room_id = p_room_id and q.status in ('pending', 'approved')
     and q.requested_for >= current_date and extract(isodow from q.requested_for)::int = p_day
     and q.start_time < p_end and q.end_time > p_start;
  if v_n > 0 then
    v_warn := v_warn || format('%s room request%s for %s at that time %s still on hold: check them in Room requests.',
                               v_n, case when v_n = 1 then '' else 's' end, r.code, case when v_n = 1 then 'is' else 'are' end);
  end if;

  insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, old_data, new_data, justification)
  values (
    v_tenant, auth.uid(), 'SCHEDULE_OVERRIDE', 'schedule_entries', p_entry_id::text,
    jsonb_build_object('room_id', e.room_id, 'room_code', old_room, 'day_of_week', e.day_of_week,
                       'start_time', e.start_time, 'end_time', e.end_time, 'status', e.status),
    jsonb_build_object('term_id', e.term_id, 'program_id', e.program_id, 'section_id', e.section_id,
                       'room_id', p_room_id, 'room_code', r.code, 'day_of_week', p_day,
                       'start_time', p_start, 'end_time', p_end, 'status', e.status),
    btrim(p_justification)
  );

  return jsonb_build_object('entry_id', p_entry_id, 'status', e.status, 'warnings', to_jsonb(v_warn));
end $$;

-- the overrides still in force for a term (and optionally one program): who, why, from where to where
create function public.schedule_overrides(p_term_id uuid, p_program_id uuid default null)
returns table (
  entry_id uuid, program_id uuid, section_code text, course_code text, instructor_name text,
  actor_name text, justification text, created_at timestamptz,
  from_room text, from_day integer, from_start time, from_end time,
  to_room text, to_day integer, to_start time, to_end time
)
language sql stable security definer set search_path = '' as $$
  select x.* from (
    select distinct on (a.record_id)
           e.id, e.program_id, s.code, c.code, i.full_name,
           coalesce(nullif(pr.full_name, ''), pr.email), a.justification, a.created_at,
           a.old_data ->> 'room_code', (a.old_data ->> 'day_of_week')::int,
           (a.old_data ->> 'start_time')::time, (a.old_data ->> 'end_time')::time,
           a.new_data ->> 'room_code', (a.new_data ->> 'day_of_week')::int,
           (a.new_data ->> 'start_time')::time, (a.new_data ->> 'end_time')::time
      from public.audit_logs a
      join public.schedule_entries e on e.id::text = a.record_id
      join public.sections s on s.id = e.section_id
      left join public.courses c on c.id = s.course_id
      left join public.instructors i on i.id = e.instructor_id
      left join public.profiles pr on pr.id = a.actor_id
     where a.tenant_id = private.my_tenant()
       and a.action = 'SCHEDULE_OVERRIDE'
       and a.table_name = 'schedule_entries'
       and e.tenant_id = private.my_tenant()
       and e.is_override
       and e.term_id = p_term_id
       and (p_program_id is null or e.program_id = p_program_id)
       and (
         private.my_role() in ('admin', 'dean')
         or (private.my_role() = 'program_chair' and private.program_in_my_department(e.program_id))
         or (private.my_role() = 'instructor' and e.status = 'published' and e.instructor_id = private.my_instructor())
       )
     order by a.record_id, a.id desc
  ) x
  order by 8 desc
$$;

-- ---------------------------------------------------------------------
-- 2. Pinned meetings
-- ---------------------------------------------------------------------
alter table public.schedule_entries add column is_pinned boolean not null default false;
comment on column public.schedule_entries.is_pinned is
  'A chair pinned this draft meeting: generating the program again keeps it in place and plans the rest around it.';

-- ---------------------------------------------------------------------
-- 3. Saving a generated timetable for one or several programs
--    p_entries: [{section_id, room_id, day_of_week, start_time, end_time}, ...]
--    p_job:     {runtime_ms, soft_penalty, unplaced, unplaced_by_program{program_id: n}, message}
--    Only the programs' draft and returned meetings that are not pinned are replaced.
-- ---------------------------------------------------------------------
create function private.apply_generated_many(
  p_term_id     uuid,
  p_program_ids uuid[],
  p_entries     jsonb,
  p_job         jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role     public.user_role := private.my_role();
  v_tenant   uuid := private.my_tenant();
  v_progs    uuid[];
  v_prog     uuid;
  v_bad      text;
  v_replaced integer := 0;
  v_inserted integer := 0;
  v_r        integer;
  v_n        integer;
  v_job      uuid;
  v_jobs     uuid[] := '{}';
  v_per      jsonb := '[]'::jsonb;
begin
  if v_role is null or v_role = 'instructor' then
    raise exception 'not allowed to generate a schedule' using errcode = '42501';
  end if;
  if not exists (select 1 from public.terms where id = p_term_id and tenant_id = v_tenant) then
    raise exception 'term not found' using errcode = 'P0002';
  end if;
  if p_program_ids is null or cardinality(p_program_ids) = 0 then
    raise exception 'choose at least one program' using errcode = '22023';
  end if;
  select array_agg(distinct x order by x) into v_progs from unnest(p_program_ids) as x;
  if cardinality(v_progs) > 30 then
    raise exception 'too many programs in one request' using errcode = '22023';
  end if;
  foreach v_prog in array v_progs loop
    if not exists (select 1 from public.programs where id = v_prog and tenant_id = v_tenant) then
      raise exception 'program not found' using errcode = 'P0002';
    end if;
    if v_role = 'program_chair' and not private.program_in_my_department(v_prog) then
      raise exception 'program belongs to another department' using errcode = '42501';
    end if;
  end loop;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'entries must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_entries) = 0 then
    raise exception 'nothing to save: the generated schedule is empty' using errcode = '22023';
  end if;
  if jsonb_array_length(p_entries) > 4000 then
    raise exception 'too many meetings in one request' using errcode = '22023';
  end if;

  -- one generation per program at a time (locks taken in a fixed order, so two requests cannot deadlock)
  foreach v_prog in array v_progs loop
    perform pg_advisory_xact_lock(hashtextextended('generate:' || v_prog::text, 0));
  end loop;

  -- every meeting must belong to a section of these programs and this term ...
  select coalesce(e.section_id::text, '(missing section)') into v_bad
    from jsonb_to_recordset(p_entries)
           as e(section_id uuid, room_id uuid, day_of_week smallint, start_time time, end_time time)
    left join public.sections s
           on s.id = e.section_id and s.tenant_id = v_tenant
          and s.term_id = p_term_id and s.program_id = any (v_progs)
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

  -- ... and no section may end up with more weekly meetings than it has (kept meetings count: submitted,
  -- approved, published, and pinned drafts)
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
            where x.section_id = s.id and (x.status not in ('draft', 'returned') or x.is_pinned)
         ) > s.meetings_per_week
   limit 1;
  if found then
    raise exception 'section % would have more meetings than it needs', v_bad using errcode = '22023';
  end if;

  -- replace the old draft/returned meetings of these programs, except the pinned ones
  perform set_config('app.bulk_replace', 'on', true);
  delete from public.schedule_entries
   where tenant_id  = v_tenant
     and term_id    = p_term_id
     and program_id = any (v_progs)
     and status in ('draft', 'returned')
     and not is_pinned;
  get diagnostics v_replaced = row_count;
  perform set_config('app.bulk_replace', '', true);

  -- tenant, program, instructor and student block are filled in by schedule_entries_sync;
  -- the exclusion constraints reject any clash and roll the whole call back
  insert into public.schedule_entries (tenant_id, term_id, section_id, room_id, day_of_week, start_time, end_time, status)
  select v_tenant, p_term_id, e.section_id, e.room_id, e.day_of_week, e.start_time, e.end_time, 'draft'
    from jsonb_to_recordset(p_entries)
           as e(section_id uuid, room_id uuid, day_of_week smallint, start_time time, end_time time);
  get diagnostics v_inserted = row_count;

  -- one solve job and one audit entry per program, so each program's history stays its own
  foreach v_prog in array v_progs loop
    select count(*) into v_n
      from jsonb_to_recordset(p_entries)
             as e(section_id uuid, room_id uuid, day_of_week smallint, start_time time, end_time time)
      join public.sections s on s.id = e.section_id
     where s.program_id = v_prog;

    insert into public.solve_jobs (tenant_id, term_id, program_id, requested_by, status, runtime_ms,
                                   hard_violations, soft_penalty, message, finished_at)
    values (
      v_tenant, p_term_id, v_prog, auth.uid(), 'feasible',
      nullif(p_job ->> 'runtime_ms', '')::integer,
      0,
      nullif(p_job ->> 'soft_penalty', '')::numeric,
      left(nullif(p_job ->> 'message', ''), 500),
      now()
    )
    returning id into v_job;
    v_jobs := v_jobs || v_job;

    insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, new_data)
    values (
      v_tenant, auth.uid(), 'SCHEDULE_GENERATED', 'schedule_entries', v_prog::text,
      jsonb_build_object(
        'term_id', p_term_id, 'program_id', v_prog,
        'replaced', v_replaced, 'entries', v_n,
        'unplaced', coalesce(
          nullif(p_job -> 'unplaced_by_program' ->> v_prog::text, '')::integer,
          case when cardinality(v_progs) = 1 then nullif(p_job ->> 'unplaced', '')::integer end,
          0),
        'programs_together', cardinality(v_progs),
        'solve_job_id', v_job
      )
    );
    v_per := v_per || jsonb_build_array(jsonb_build_object('program_id', v_prog, 'inserted', v_n));
  end loop;

  return jsonb_build_object('job_id', v_jobs[1], 'job_ids', to_jsonb(v_jobs), 'replaced', v_replaced,
                            'inserted', v_inserted, 'programs', v_per);
end $$;

-- the one-program function from migration 5 now shares the same code (and honours pinned meetings)
create or replace function public.apply_generated_schedule(
  p_term_id    uuid,
  p_program_id uuid,
  p_entries    jsonb,
  p_job        jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_program_id is null then
    raise exception 'program not found' using errcode = 'P0002';
  end if;
  return private.apply_generated_many(p_term_id, array[p_program_id], p_entries, coalesce(p_job, '{}'::jsonb));
end $$;

create function public.apply_generated_schedules(
  p_term_id     uuid,
  p_program_ids uuid[],
  p_entries     jsonb,
  p_job         jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return private.apply_generated_many(p_term_id, p_program_ids, p_entries, coalesce(p_job, '{}'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- 4. Deleting a room or a course only when nothing depends on it
-- ---------------------------------------------------------------------
create function public.delete_room(p_room_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := private.my_tenant();
  r        record;
  v_n      integer;
begin
  if private.my_role() is distinct from 'admin' then
    raise exception 'only an administrator can delete a room' using errcode = '42501';
  end if;
  select * into r from public.rooms where id = p_room_id and tenant_id = v_tenant;
  if not found then
    raise exception 'room not found' using errcode = 'P0002';
  end if;
  select count(*) into v_n from public.schedule_entries where room_id = p_room_id;
  if v_n > 0 then
    raise exception 'room % holds % class meeting(s). Take it out of service instead, or move those meetings first.', r.code, v_n
      using errcode = '55006';
  end if;
  select count(*) into v_n from public.room_requests where room_id = p_room_id;
  if v_n > 0 then
    raise exception 'room % has % room request(s) in its history. Take it out of service instead.', r.code, v_n
      using errcode = '55006';
  end if;
  if exists (select 1 from public.lockers where room_id = p_room_id) then
    raise exception 'room % has a locker door assigned. Turn that door off first, or keep the room and take it out of service.', r.code
      using errcode = '55006';
  end if;
  delete from public.rooms where id = p_room_id;
end $$;

create function public.delete_course(p_course_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_role   public.user_role := private.my_role();
  v_tenant uuid := private.my_tenant();
  c        record;
  v_n      integer;
begin
  select * into c from public.courses where id = p_course_id and tenant_id = v_tenant;
  if not found then
    raise exception 'course not found' using errcode = 'P0002';
  end if;
  if v_role is null or v_role not in ('admin', 'dean', 'program_chair') then
    raise exception 'not allowed to delete a course' using errcode = '42501';
  end if;
  if v_role = 'program_chair' and c.department_id is distinct from private.my_department() then
    raise exception 'course belongs to another department' using errcode = '42501';
  end if;
  select count(*) into v_n from public.sections where course_id = p_course_id;
  if v_n > 0 then
    raise exception 'course % is used by % class(es). Delete those classes first.', c.code, v_n using errcode = '55006';
  end if;
  delete from public.courses where id = p_course_id;
end $$;

-- ---------------------------------------------------------------------
-- 5. RFID cards
--    The locker station sends the card number in capitals with no spaces or colons ("04:a1:b2" -> "04A1B2"),
--    and authorize_key_request() compares it exactly, so the same rule is applied here when a card is saved.
-- ---------------------------------------------------------------------
create function private.norm_card_uid(p text) returns text
language sql immutable as $$
  select upper(regexp_replace(coalesce(p, ''), '[^0-9A-Za-z]', '', 'g'))
$$;

create function public.assign_card(p_instructor_id uuid, p_card_uid text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant  uuid := private.my_tenant();
  v_uid     text := private.norm_card_uid(p_card_uid);
  v_inst    record;
  v_card    record;
  v_other   text;
  v_deact   integer;
  v_exists  boolean;
begin
  if private.my_role() is distinct from 'admin' then
    raise exception 'only an administrator can assign a card' using errcode = '42501';
  end if;
  if length(v_uid) < 4 or length(v_uid) > 32 then
    raise exception 'a card number has 4 to 32 letters and digits' using errcode = '22023';
  end if;
  select * into v_inst from public.instructors where id = p_instructor_id and tenant_id = v_tenant;
  if not found then
    raise exception 'instructor not found' using errcode = 'P0002';
  end if;

  select * into v_card from public.rfid_cards where tenant_id = v_tenant and card_uid = v_uid;
  v_exists := found;   -- FOUND is overwritten by the next statements
  if v_exists and v_card.is_active and v_card.instructor_id <> p_instructor_id then
    select full_name into v_other from public.instructors where id = v_card.instructor_id;
    raise exception 'that card is already assigned to %', coalesce(v_other, 'another instructor') using errcode = '55006';
  end if;

  -- an instructor holds one active card: a new one replaces the old
  update public.rfid_cards set is_active = false
   where tenant_id = v_tenant and instructor_id = p_instructor_id and is_active and card_uid <> v_uid;
  get diagnostics v_deact = row_count;

  if v_exists then
    update public.rfid_cards set instructor_id = p_instructor_id, is_active = true, issued_at = now() where id = v_card.id;
  else
    insert into public.rfid_cards (tenant_id, instructor_id, card_uid) values (v_tenant, p_instructor_id, v_uid);
  end if;

  return jsonb_build_object('card_uid', v_uid, 'instructor', v_inst.full_name, 'replaced', v_deact);
end $$;

-- ---------------------------------------------------------------------
-- 6. Which key is in which door
--    A room's key is in one door only. That rule is checked at the end of the call (deferrable), so two
--    keys can trade doors in one go. A door that already has a history is never deleted: its access log
--    belongs to it.
--    p_doors: [{door: 1..4, room_id: uuid, is_active: true|false}, ...]
-- ---------------------------------------------------------------------
alter table public.lockers drop constraint lockers_room_id_key;
alter table public.lockers add constraint lockers_room_id_key unique (room_id) deferrable initially immediate;

create function public.set_locker_doors(p_station text, p_doors jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant  uuid := private.my_tenant();
  v_station text := btrim(coalesce(p_station, ''));
  d         record;
  v_row     public.lockers%rowtype;
  v_changed integer := 0;
  v_code    text;
begin
  if private.my_role() is distinct from 'admin' then
    raise exception 'only an administrator can set up the locker doors' using errcode = '42501';
  end if;
  if v_station = '' or length(v_station) > 60 then
    raise exception 'give the locker a name' using errcode = '22023';
  end if;
  if p_doors is null or jsonb_typeof(p_doors) <> 'array' or jsonb_array_length(p_doors) = 0 then
    raise exception 'choose at least one door' using errcode = '22023';
  end if;

  for d in select * from jsonb_to_recordset(p_doors) as x(door integer, room_id uuid, is_active boolean) loop
    if d.door is null or d.door not between 1 and 4 then
      raise exception 'a door number is 1 to 4' using errcode = '22023';
    end if;
  end loop;
  if (select count(distinct (x.door)) from jsonb_to_recordset(p_doors) as x(door integer, room_id uuid, is_active boolean))
     <> jsonb_array_length(p_doors) then
    raise exception 'a door appears twice' using errcode = '22023';
  end if;
  if (select count(distinct (x.room_id)) from jsonb_to_recordset(p_doors) as x(door integer, room_id uuid, is_active boolean))
     <> jsonb_array_length(p_doors) then
    raise exception 'a room''s key can be in one door only' using errcode = '22023';
  end if;

  set constraints public.lockers_room_id_key deferred;

  for d in select * from jsonb_to_recordset(p_doors) as x(door integer, room_id uuid, is_active boolean) order by 1 loop
    select code into v_code from public.rooms where id = d.room_id and tenant_id = v_tenant and is_active;
    if not found then
      raise exception 'door %: that room does not exist or is out of use', d.door using errcode = '22023';
    end if;
    select * into v_row from public.lockers where tenant_id = v_tenant and station_label = v_station and compartment_no = d.door;
    if found then
      if v_row.room_id is distinct from d.room_id or v_row.is_active is distinct from coalesce(d.is_active, true) then
        update public.lockers set room_id = d.room_id, is_active = coalesce(d.is_active, true) where id = v_row.id;
        v_changed := v_changed + 1;
      end if;
    else
      insert into public.lockers (tenant_id, room_id, station_label, compartment_no, is_active)
      values (v_tenant, d.room_id, v_station, d.door, coalesce(d.is_active, true));
      v_changed := v_changed + 1;
    end if;
  end loop;

  -- the deferred "one door per room" rule is checked now, so a clash is reported against the room's code
  begin
    set constraints public.lockers_room_id_key immediate;
  exception when unique_violation then
    raise exception 'a room''s key can be in one door only: another door of this or another locker still holds one of these rooms' using errcode = '55006';
  end;

  return jsonb_build_object('station', v_station, 'changed', v_changed);
end $$;

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
-- the shared worker is only reachable through the two public functions above
revoke all on function private.apply_generated_many(uuid, uuid[], jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.override_schedule_entry(uuid, uuid, integer, time, time, text) from public, anon;
grant execute on function public.override_schedule_entry(uuid, uuid, integer, time, time, text) to authenticated, service_role;
revoke all on function public.schedule_overrides(uuid, uuid) from public, anon;
grant execute on function public.schedule_overrides(uuid, uuid) to authenticated, service_role;
revoke all on function public.apply_generated_schedule(uuid, uuid, jsonb, jsonb) from public, anon;
grant execute on function public.apply_generated_schedule(uuid, uuid, jsonb, jsonb) to authenticated, service_role;
revoke all on function public.apply_generated_schedules(uuid, uuid[], jsonb, jsonb) from public, anon;
grant execute on function public.apply_generated_schedules(uuid, uuid[], jsonb, jsonb) to authenticated, service_role;
revoke all on function public.delete_room(uuid) from public, anon;
grant execute on function public.delete_room(uuid) to authenticated, service_role;
revoke all on function public.delete_course(uuid) from public, anon;
grant execute on function public.delete_course(uuid) to authenticated, service_role;
revoke all on function public.assign_card(uuid, text) from public, anon;
grant execute on function public.assign_card(uuid, text) to authenticated, service_role;
revoke all on function public.set_locker_doors(text, jsonb) from public, anon;
grant execute on function public.set_locker_doors(text, jsonb) to authenticated, service_role;
