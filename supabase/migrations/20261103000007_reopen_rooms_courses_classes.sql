-- =====================================================================
-- Classroom360 — reopening a timetable, room types, and managing courses and classes by hand
--   1. set_schedule_status() can reopen a timetable ('draft'): a dean or administrator takes a submitted,
--      approved or published timetable back for editing (a note is required); a program chair can
--      withdraw their own submission. The locker stops honouring the classes until it is published again.
--   2. schedule_review_note() also returns that reopening note, so the chair sees why
--   3. Room types are stored in one spelling ("Chemistry Laboratory" -> chemistry_lab) for rooms and courses
--   4. Course changes are audited
--   5. save_class() / delete_class(): add, change or remove one class (its lecture and lab parts) by hand
-- Run after 20261103000006_work_hours_school_hours_and_import.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Reopen a timetable
-- ---------------------------------------------------------------------
create or replace function public.set_schedule_status(
  p_term_id    uuid,
  p_program_id uuid,
  p_to         public.schedule_status,
  p_note       text default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_role   public.user_role := private.my_role();
  v_tenant uuid := private.my_tenant();
  v_from   public.schedule_status[];
  v_count  integer;
begin
  if v_role is null or v_role = 'instructor' then
    raise exception 'not allowed to change schedule status' using errcode = '42501';
  end if;

  if not exists (select 1 from public.programs where id = p_program_id and tenant_id = v_tenant) then
    raise exception 'program not found' using errcode = 'P0002';
  end if;

  if v_role = 'program_chair' and not private.program_in_my_department(p_program_id) then
    raise exception 'program belongs to another department' using errcode = '42501';
  end if;

  case p_to
    when 'submitted' then
      v_from := array['draft', 'returned']::public.schedule_status[];
    when 'approved' then
      v_from := array['submitted']::public.schedule_status[];
    when 'returned' then
      v_from := array['submitted']::public.schedule_status[];
      if p_note is null or btrim(p_note) = '' then
        raise exception 'a note is required when returning a schedule' using errcode = '22023';
      end if;
    when 'published' then
      v_from := array['approved']::public.schedule_status[];
    when 'draft' then
      if v_role = 'program_chair' then
        -- a chair may take back what they submitted, as long as the dean has not acted on it
        v_from := array['submitted']::public.schedule_status[];
      else
        v_from := array['submitted', 'approved', 'published']::public.schedule_status[];
        if p_note is null or btrim(p_note) = '' then
          raise exception 'a note is required when reopening a schedule' using errcode = '22023';
        end if;
      end if;
    else
      raise exception 'unsupported transition to %', p_to using errcode = '22023';
  end case;

  if p_to in ('approved', 'returned', 'published') and v_role not in ('admin', 'dean') then
    raise exception 'only a dean or administrator can do this' using errcode = '42501';
  end if;

  update public.schedule_entries
     set status = p_to
   where tenant_id  = v_tenant
     and term_id    = p_term_id
     and program_id = p_program_id
     and status     = any (v_from);
  get diagnostics v_count = row_count;

  -- only transitions that actually changed something are worth an audit entry
  if v_count > 0 then
    insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, new_data, justification)
    values (
      v_tenant, auth.uid(), 'SCHEDULE_' || upper(p_to::text), 'schedule_entries', p_program_id::text,
      jsonb_build_object('term_id', p_term_id, 'program_id', p_program_id, 'entries', v_count),
      p_note
    );
  end if;

  return v_count;
end $$;

-- ---------------------------------------------------------------------
-- 2. The latest decision on a program's schedule, now including a reopening
-- ---------------------------------------------------------------------
create or replace function public.schedule_review_note(p_term_id uuid, p_program_id uuid)
returns table (action text, note text, actor_name text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.action, a.justification, coalesce(nullif(pr.full_name, ''), pr.email), a.created_at
    from public.audit_logs a
    left join public.profiles pr on pr.id = a.actor_id
   where a.tenant_id  = private.my_tenant()
     and a.table_name = 'schedule_entries'
     and a.action in ('SCHEDULE_RETURNED', 'SCHEDULE_APPROVED', 'SCHEDULE_PUBLISHED', 'SCHEDULE_DRAFT')
     and a.record_id  = p_program_id::text
     and (a.new_data ->> 'term_id') = p_term_id::text
     and (
       private.my_role() in ('admin', 'dean')
       or (private.my_role() = 'program_chair' and private.program_in_my_department(p_program_id))
     )
   order by a.id desc
   limit 1
$$;

-- ---------------------------------------------------------------------
-- 3. One spelling for room types
-- ---------------------------------------------------------------------
create function private.norm_facility_list(p text[]) returns text[]
language sql immutable as $$
  select coalesce(array_agg(f order by f), '{}'::text[])
    from (select distinct private.norm_facility(x) as f from unnest(coalesce(p, '{}'::text[])) as x) s
   where f is not null
$$;

create function private.rooms_norm_facilities() returns trigger
language plpgsql as $$
begin
  new.facilities := private.norm_facility_list(new.facilities);
  return new;
end $$;
create trigger rooms_norm_facilities before insert or update on public.rooms
  for each row execute function private.rooms_norm_facilities();

-- runs before courses_sync_units (triggers fire in name order), which looks at required_facility
create function private.courses_norm_facility() returns trigger
language plpgsql as $$
begin
  new.required_facility := private.norm_facility(new.required_facility);
  return new;
end $$;
create trigger courses_norm_facility before insert or update on public.courses
  for each row execute function private.courses_norm_facility();

-- tidy what is already there (only rows that actually change)
update public.rooms   set facilities        = private.norm_facility_list(facilities)
 where facilities is distinct from private.norm_facility_list(facilities);
update public.courses set required_facility = private.norm_facility(required_facility)
 where required_facility is distinct from private.norm_facility(required_facility);

-- ---------------------------------------------------------------------
-- 4. Course changes are audited (rooms already are)
-- ---------------------------------------------------------------------
create trigger audit_courses after insert or update or delete on public.courses
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------
-- 5. save_class: one class = a course taken by one student block in one term.
--    A course with lecture and lab units becomes two sections (lecture part, lab part), exactly as the file
--    import does. Calling it again for the same class changes the student count and instructor (and the
--    meeting pattern, unless a part already has submitted, approved or published meetings).
--    Admin and dean: any program. Program chair: programs of their own department.
-- ---------------------------------------------------------------------
create function public.save_class(
  p_term_id       uuid,
  p_course_id     uuid,
  p_program_id    uuid,
  p_year          integer,
  p_block         text,
  p_students      integer default null,
  p_instructor_id uuid    default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role    public.user_role := private.my_role();
  v_tenant  uuid := private.my_tenant();
  v_course  public.courses%rowtype;
  v_prog    public.programs%rowtype;
  v_inst    public.instructors%rowtype;
  v_block   text := upper(btrim(coalesce(p_block, '')));
  v_cohort  text;
  v_sec     public.sections%rowtype;
  v_code    text;
  v_try     integer;
  v_kept    integer;
  v_fac     text;
  v_max_cap integer;
  v_hours   numeric;
  v_parts   jsonb := '[]'::jsonb;
  v_warn    jsonb := '[]'::jsonb;
  v_new     boolean := false;
  x         record;
begin
  if v_role is null or v_role not in ('admin', 'dean', 'program_chair') then
    raise exception 'not allowed to manage classes' using errcode = '42501';
  end if;
  if not exists (select 1 from public.terms where id = p_term_id and tenant_id = v_tenant) then
    raise exception 'term not found' using errcode = 'P0002';
  end if;
  select * into v_prog from public.programs where id = p_program_id and tenant_id = v_tenant;
  if not found then
    raise exception 'program not found' using errcode = 'P0002';
  end if;
  if v_role = 'program_chair' and not private.program_in_my_department(p_program_id) then
    raise exception 'program belongs to another department' using errcode = '42501';
  end if;
  select * into v_course from public.courses where id = p_course_id and tenant_id = v_tenant;
  if not found then
    raise exception 'course not found' using errcode = 'P0002';
  end if;
  if p_year is null or p_year not between 1 and 6 then
    raise exception 'the year level must be 1 to 6' using errcode = '22023';
  end if;
  if v_block = '' or length(v_block) > 12 then
    raise exception 'give the section or block (for example A), up to 12 characters' using errcode = '22023';
  end if;
  if p_students is not null and p_students not between 0 and 1000 then
    raise exception 'the number of students must be between 0 and 1000' using errcode = '22023';
  end if;
  if p_instructor_id is not null then
    select * into v_inst from public.instructors where id = p_instructor_id and tenant_id = v_tenant and is_active;
    if not found then
      raise exception 'instructor not found' using errcode = 'P0002';
    end if;
  end if;
  if v_course.lecture_units = 0 and v_course.lab_units = 0 then
    raise exception '% has no lecture or lab units yet; set them on the course first', v_course.code using errcode = '22023';
  end if;

  v_cohort := case when v_block ~ '^[0-9]' then v_block else p_year::text || v_block end;
  v_fac    := v_course.required_facility;

  for x in select * from private.meeting_plan(v_course.lecture_units, v_course.lab_units) loop
    if x.minutes not between 30 and 300 then
      raise exception 'a % meeting would be % minutes; it must be between 30 and 300 (check the course units)', x.component, x.minutes
        using errcode = '22023';
    end if;
    if x.minutes % 30 <> 0 then
      v_warn := v_warn || to_jsonb(format('A %s meeting of %s minutes is placed as %s minutes on the 30-minute grid.',
                                          x.component, x.minutes, ceil(x.minutes / 30.0)::integer * 30));
    end if;
    v_code := regexp_replace(upper(v_course.code), '\s', '', 'g') || '-' || v_cohort
              || case when x.component = 'lab' and v_course.lecture_units > 0 then '-LAB' else '' end;

    select * into v_sec from public.sections
     where tenant_id = v_tenant and term_id = p_term_id and program_id = p_program_id and course_id = p_course_id
       and year_level = p_year and cohort = v_cohort and component = x.component;
    if found then
      select count(*) into v_kept from public.schedule_entries e
       where e.section_id = v_sec.id and e.status not in ('draft', 'returned');
      if v_kept > 0 and (v_sec.meetings_per_week <> x.meetings or v_sec.minutes_per_meeting <> x.minutes) then
        v_warn := v_warn || to_jsonb(format('%s already has %s submitted, approved or published meetings, so its meeting pattern was not changed.', v_sec.code, v_kept));
        update public.sections set enrollment = coalesce(p_students, enrollment), instructor_id = p_instructor_id where id = v_sec.id;
      else
        if (v_sec.meetings_per_week <> x.meetings or v_sec.minutes_per_meeting <> x.minutes)
           and exists (select 1 from public.schedule_entries e where e.section_id = v_sec.id) then
          v_warn := v_warn || to_jsonb(format('%s has draft meetings that no longer match; generate its schedule again.', v_sec.code));
        end if;
        update public.sections
           set meetings_per_week = x.meetings, minutes_per_meeting = x.minutes,
               enrollment = coalesce(p_students, enrollment), instructor_id = p_instructor_id
         where id = v_sec.id;
      end if;
      v_code := v_sec.code;
    else
      v_new := true;
      v_try := 1;
      while exists (select 1 from public.sections where tenant_id = v_tenant and term_id = p_term_id and code = v_code) loop
        v_code := regexp_replace(upper(v_course.code), '\s', '', 'g') || '-' || v_cohort
                  || case when x.component = 'lab' and v_course.lecture_units > 0 then '-LAB' else '' end
                  || '-' || v_prog.code || case when v_try > 1 then '-' || v_try::text else '' end;
        v_try := v_try + 1;
        exit when v_try > 50;
      end loop;
      insert into public.sections (tenant_id, term_id, course_id, program_id, code, year_level, cohort, enrollment, instructor_id,
                                   meetings_per_week, minutes_per_meeting, component)
      values (v_tenant, p_term_id, p_course_id, p_program_id, v_code, p_year, v_cohort, coalesce(p_students, 0), p_instructor_id,
              x.meetings, x.minutes, x.component)
      returning * into v_sec;
    end if;
    v_parts := v_parts || jsonb_build_object('id', v_sec.id, 'code', v_code, 'component', x.component,
                                             'meetings', x.meetings, 'minutes', x.minutes);

    if (x.component = 'lab' or v_course.lab_units = 0) and v_fac is not null
       and not exists (select 1 from public.rooms where tenant_id = v_tenant and is_active and v_fac = any(facilities)) then
      v_warn := v_warn || to_jsonb(format('No room has the type "%s". Add a room with that type, or this part cannot be placed.', replace(v_fac, '_', ' ')));
    end if;
  end loop;

  select max(capacity) into v_max_cap from public.rooms where tenant_id = v_tenant and is_active;
  if p_students is not null and v_max_cap is not null and p_students > v_max_cap then
    v_warn := v_warn || to_jsonb(format('%s students is more than any room seats (largest: %s).', p_students, v_max_cap));
  end if;
  if p_instructor_id is not null then
    select coalesce(sum(s.meetings_per_week * s.minutes_per_meeting), 0) / 60.0 into v_hours
      from public.sections s where s.instructor_id = p_instructor_id and s.term_id = p_term_id;
    if v_hours > v_inst.max_weekly_hours then
      v_warn := v_warn || to_jsonb(format('%s would now teach %s hours a week; the limit is %s.', v_inst.full_name, round(v_hours, 1), v_inst.max_weekly_hours));
    end if;
  end if;

  insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, new_data)
  values (v_tenant, auth.uid(), 'CLASS_SAVED', 'sections', (v_parts -> 0 ->> 'id'),
          jsonb_build_object('term_id', p_term_id, 'course', v_course.code, 'program', v_prog.code, 'cohort', v_cohort,
                             'students', p_students, 'instructor', v_inst.full_name, 'created', v_new));
  return jsonb_build_object('created', v_new, 'sections', v_parts, 'warnings', v_warn);
end $$;

-- ---------------------------------------------------------------------
-- delete_class: remove a class (all its parts) and the draft meetings that go with it.
-- Refused while any part has submitted, approved or published meetings: reopen the timetable first.
-- ---------------------------------------------------------------------
create function public.delete_class(p_section_id uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_role   public.user_role := private.my_role();
  v_tenant uuid := private.my_tenant();
  v_s      public.sections%rowtype;
  v_ids    uuid[];
  v_kept   integer;
  v_code   text;
begin
  if v_role is null or v_role not in ('admin', 'dean', 'program_chair') then
    raise exception 'not allowed to manage classes' using errcode = '42501';
  end if;
  select * into v_s from public.sections where id = p_section_id and tenant_id = v_tenant;
  if not found then
    raise exception 'class not found' using errcode = 'P0002';
  end if;
  if v_role = 'program_chair' and not private.program_in_my_department(v_s.program_id) then
    raise exception 'program belongs to another department' using errcode = '42501';
  end if;

  select array_agg(id), min(code) into v_ids, v_code
    from public.sections
   where tenant_id = v_tenant and term_id = v_s.term_id and program_id = v_s.program_id and course_id = v_s.course_id
     and year_level is not distinct from v_s.year_level and cohort is not distinct from v_s.cohort;

  select count(*) into v_kept from public.schedule_entries e
   where e.section_id = any (v_ids) and e.status not in ('draft', 'returned');
  if v_kept > 0 then
    raise exception 'This class has % submitted, approved or published meetings. Reopen the timetable first, then delete it.', v_kept
      using errcode = '55006';
  end if;

  delete from public.sections where id = any (v_ids);

  insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, new_data)
  values (v_tenant, auth.uid(), 'CLASS_DELETED', 'sections', p_section_id::text,
          jsonb_build_object('term_id', v_s.term_id, 'section', v_code, 'parts', cardinality(v_ids)));
  return cardinality(v_ids);
end $$;

revoke all on function public.save_class(uuid, uuid, uuid, integer, text, integer, uuid) from public, anon;
grant execute on function public.save_class(uuid, uuid, uuid, integer, text, integer, uuid) to authenticated, service_role;
revoke all on function public.delete_class(uuid) from public, anon;
grant execute on function public.delete_class(uuid) to authenticated, service_role;
