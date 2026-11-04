-- =====================================================================
-- Classroom360 — instructor work hours, school operating hours,
-- lecture and laboratory units, and importing a term's teaching load
--   1. Instructors: full-time / part-time and the hours they work (instructor_work_hours)
--   2. School operating hours per weekday (school_hours); nothing can be scheduled outside them
--   3. Courses carry lecture units and laboratory units; a section is a lecture or a lab part
--   4. save_instructor():       add or edit one instructor and their work hours
--   5. import_teaching_load():  a file's worth of instructors, courses and sections in one step,
--                               with a dry run that shows exactly what would happen
-- Run after 20261103000005_generated_schedules.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Instructors: employment type and work hours
--    No work-hour rows = available whenever the school is open.
--    With rows = may only be scheduled inside those windows.
--    (instructor_unavailability still blocks specific stretches inside a window.)
-- ---------------------------------------------------------------------
create type public.employment_type as enum ('full_time', 'part_time');

alter table public.instructors
  add column employment_type public.employment_type not null default 'full_time';

create table public.instructor_work_hours (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  day_of_week   smallint not null check (day_of_week between 1 and 7),
  start_time    time not null,
  end_time      time not null,
  check (end_time > start_time),
  slot int4range generated always as (
    int4range(
      day_of_week * 1440 + (extract(epoch from start_time) / 60)::int,
      day_of_week * 1440 + (extract(epoch from end_time) / 60)::int
    )
  ) stored,
  constraint work_hours_no_overlap exclude using gist (instructor_id with =, slot with &&)
);
create index instructor_work_hours_instructor_idx on public.instructor_work_hours (instructor_id);

grant select on public.instructor_work_hours to authenticated;   -- writes only through save_instructor() / import_teaching_load()
grant all on public.instructor_work_hours to service_role;

alter table public.instructor_work_hours enable row level security;
-- Everyone who plans a schedule reads them (a shared instructor's hours bind every department).
-- Nobody writes the table directly: save_instructor() and import_teaching_load() do, after their own checks.
create policy work_hours_select on public.instructor_work_hours for select to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean', 'program_chair')
      or instructor_id = (select private.my_instructor())
    )
  );

-- ---------------------------------------------------------------------
-- 2. School operating hours, per weekday (no row = closed that day)
-- ---------------------------------------------------------------------
create table public.school_hours (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 1 and 7),
  opens_at    time not null,
  closes_at   time not null,
  primary key (tenant_id, day_of_week),
  check (closes_at > opens_at)
);

alter table public.school_hours enable row level security;
create policy school_hours_select on public.school_hours for select to authenticated
  using (tenant_id = (select private.my_tenant()));
create policy school_hours_write on public.school_hours for all to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) = 'admin')
  with check (tenant_id = (select private.my_tenant()) and (select private.my_role()) = 'admin');

grant select, insert, update, delete on public.school_hours to authenticated;   -- row-level security limits writes to admins
grant all on public.school_hours to service_role;

create trigger audit_school_hours after insert or update or delete on public.school_hours
  for each row execute function private.audit_row_change();

-- Every school starts with Monday to Saturday in its existing operating window (07:00-21:00 unless changed).
insert into public.school_hours (tenant_id, day_of_week, opens_at, closes_at)
select t.id, d, t.operating_start, t.operating_end
  from public.tenants t, generate_series(1, 6) d;

create function private.seed_school_hours() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.school_hours (tenant_id, day_of_week, opens_at, closes_at)
  select new.id, d, new.operating_start, new.operating_end from generate_series(1, 6) d
  on conflict do nothing;
  return new;
end $$;
create trigger tenants_seed_school_hours after insert on public.tenants
  for each row execute function private.seed_school_hours();

-- Keep the older single window on the tenant (used by room requests) equal to the widest day.
create function private.sync_tenant_window() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := coalesce(new.tenant_id, old.tenant_id);
  v_open   time;
  v_close  time;
begin
  select min(opens_at), max(closes_at) into v_open, v_close from public.school_hours where tenant_id = v_tenant;
  if v_open is not null then
    update public.tenants set operating_start = v_open, operating_end = v_close
     where id = v_tenant and (operating_start is distinct from v_open or operating_end is distinct from v_close);
  end if;
  return null;
end $$;
create trigger school_hours_sync_tenant after insert or update or delete on public.school_hours
  for each row execute function private.sync_tenant_window();

-- A meeting may only be saved inside school hours (when the school has set any).
-- Runs after schedule_entries_sync, which fills in tenant_id.
create function private.check_school_hours() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'returned' then
    return new;
  end if;
  if exists (select 1 from public.school_hours h where h.tenant_id = new.tenant_id)
     and not exists (
       select 1 from public.school_hours h
        where h.tenant_id = new.tenant_id and h.day_of_week = new.day_of_week
          and new.start_time >= h.opens_at and new.end_time <= h.closes_at
     ) then
    raise exception 'outside school hours: the school is not open at that time' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger schedule_entries_sync_hours
  before insert or update of day_of_week, start_time, end_time on public.schedule_entries
  for each row execute function private.check_school_hours();

-- Room requests follow the day's hours too.
create function private.check_request_hours() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  h public.school_hours%rowtype;
begin
  if not exists (select 1 from public.school_hours x where x.tenant_id = new.tenant_id) then
    return new;
  end if;
  select * into h from public.school_hours
   where tenant_id = new.tenant_id and day_of_week = extract(isodow from new.requested_for)::int;
  if not found then
    raise exception 'the school is closed on that day' using errcode = '22023';
  end if;
  if new.start_time < h.opens_at or new.end_time > h.closes_at then
    raise exception 'requests must fall within school hours for that day (% to %)',
      to_char(h.opens_at, 'HH24:MI'), to_char(h.closes_at, 'HH24:MI') using errcode = '22023';
  end if;
  return new;
end $$;
create trigger room_requests_school_hours before insert on public.room_requests
  for each row execute function private.check_request_hours();

-- ---------------------------------------------------------------------
-- 3. Lecture and laboratory units
--    1 lecture unit = 1 hour a week; 1 laboratory unit = 3 hours a week. A course's total units
--    is lecture + laboratory. A course with laboratory hours is scheduled as two kinds of section:
--    the lecture part (any room) and the lab part (a room of the required type).
--    courses.required_facility is the room type the LAB part needs; a course with no lab hours
--    uses it for its ordinary meetings instead.
-- ---------------------------------------------------------------------
alter table public.courses
  add column lecture_units numeric(3,1) not null default 0 check (lecture_units >= 0),
  add column lab_units     numeric(3,1) not null default 0 check (lab_units >= 0);

create function private.courses_sync_units() returns trigger
language plpgsql as $$
begin
  if coalesce(new.lecture_units, 0) = 0 and coalesce(new.lab_units, 0) = 0 then
    -- only the total was given (older code, or a quick insert)
    if new.required_facility is not null then new.lab_units := new.units; else new.lecture_units := new.units; end if;
  else
    new.units := new.lecture_units + new.lab_units;
  end if;
  return new;
end $$;
create trigger courses_sync_units before insert or update on public.courses
  for each row execute function private.courses_sync_units();

update public.courses set units = units;   -- fills lecture/lab units for the courses that already exist

alter table public.sections
  add column component text not null default 'lecture' check (component in ('lecture', 'lab'));
update public.sections s set component = 'lab'
  from public.courses c
 where c.id = s.course_id and c.lecture_units = 0 and c.lab_units > 0;

create function private.sections_default_component() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.component = 'lecture'
     and exists (select 1 from public.courses c where c.id = new.course_id and c.lecture_units = 0 and c.lab_units > 0) then
    new.component := 'lab';
  end if;
  return new;
end $$;
create trigger sections_default_component before insert on public.sections
  for each row execute function private.sections_default_component();

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
-- 'Chemistry Laboratory' -> 'chemistry_lab', 'Computer Lab' -> 'computer_lab'
create function private.norm_facility(t text) returns text
language sql immutable as $$
  select nullif(trim(both '_' from regexp_replace(regexp_replace(lower(coalesce(t, '')), 'laboratory', 'lab', 'g'), '[^a-z0-9]+', '_', 'g')), '')
$$;

-- How a course's units turn into weekly meetings.
--   lecture: up to 1.5 h = one meeting; up to 4 h = two meetings; more = three (3 h -> 2 x 90 min)
--   lab:     one meeting per lab unit, 3 hours each (1 lab unit -> one 3-hour meeting)
create function private.meeting_plan(p_lecture numeric, p_lab numeric)
returns table (component text, meetings integer, minutes integer)
language sql immutable as $$
  select 'lecture'::text,
         (case when p_lecture <= 1.5 then 1 when p_lecture <= 4 then 2 else 3 end)::integer,
         round(p_lecture * 60 / (case when p_lecture <= 1.5 then 1 when p_lecture <= 4 then 2 else 3 end))::integer
   where p_lecture > 0
  union all
  select 'lab'::text, greatest(ceil(p_lab), 1)::integer, round(p_lab * 180 / greatest(ceil(p_lab), 1))::integer
   where p_lab > 0
  order by 1 desc
$$;

-- work-hour windows as a sorted list with times as HH:MM, so two lists can be compared
create function private.norm_windows(p jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('day_of_week', w.day_of_week, 'start_time', to_char(w.start_time, 'HH24:MI'),
                                               'end_time', to_char(w.end_time, 'HH24:MI')) order by w.day_of_week, w.start_time), '[]'::jsonb)
    from jsonb_to_recordset(p) as w(day_of_week smallint, start_time time, end_time time)
$$;

create function private.issue(p_row integer, p_level text, p_message text) returns jsonb
language sql immutable as $$
  select jsonb_build_object('row', p_row, 'level', p_level, 'message', p_message)
$$;

-- ---------------------------------------------------------------------
-- 4. save_instructor
--    p_work_hours: [{"day_of_week": 1, "start_time": "08:00", "end_time": "17:00"}, ...]
--                  [] = no restriction (any time the school is open)
--    Admin and dean: any department. Program chair: their own department only.
-- ---------------------------------------------------------------------
create function public.save_instructor(
  p_id               uuid,
  p_full_name        text,
  p_employee_no      text,
  p_email            text,
  p_employment       public.employment_type,
  p_max_weekly_hours integer,
  p_work_hours       jsonb default '[]'::jsonb,
  p_department_id    uuid default null,
  p_is_active        boolean default true
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_role   public.user_role := private.my_role();
  v_tenant uuid := private.my_tenant();
  v_dept   uuid := private.my_department();
  v_old    public.instructors%rowtype;
  v_id     uuid;
  v_name   text := btrim(regexp_replace(coalesce(p_full_name, ''), '\s+', ' ', 'g'));
  v_target uuid;
begin
  if v_role is null or v_role not in ('admin', 'dean', 'program_chair') then
    raise exception 'not allowed to manage instructors' using errcode = '42501';
  end if;
  if v_name = '' then
    raise exception 'the instructor needs a name' using errcode = '22023';
  end if;
  if p_employment is null then
    raise exception 'choose full-time or part-time' using errcode = '22023';
  end if;
  if p_max_weekly_hours is null or p_max_weekly_hours < 1 or p_max_weekly_hours > 60 then
    raise exception 'weekly teaching hours must be between 1 and 60' using errcode = '22023';
  end if;
  if p_work_hours is null or jsonb_typeof(p_work_hours) <> 'array' then
    raise exception 'work hours must be a list' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_work_hours) as w(day_of_week smallint, start_time time, end_time time)
     where w.day_of_week is null or w.day_of_week not between 1 and 7
        or w.start_time is null or w.end_time is null or w.end_time <= w.start_time
  ) then
    raise exception 'a work-hour window has an invalid day or time' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_to_recordset(p_work_hours) as a(day_of_week smallint, start_time time, end_time time)
      join jsonb_to_recordset(p_work_hours) as b(day_of_week smallint, start_time time, end_time time)
        on a.day_of_week = b.day_of_week and (a.start_time, a.end_time) <> (b.start_time, b.end_time)
       and a.start_time < b.end_time and b.start_time < a.end_time
  ) then
    raise exception 'work-hour windows on the same day overlap' using errcode = '22023';
  end if;

  if p_id is not null then
    select * into v_old from public.instructors where id = p_id and tenant_id = v_tenant;
    if not found then
      raise exception 'instructor not found' using errcode = 'P0002';
    end if;
  end if;

  if v_role = 'program_chair' then
    if v_dept is null then
      raise exception 'your account has no department yet; ask an administrator' using errcode = '42501';
    end if;
    if p_id is not null and v_old.department_id is distinct from v_dept then
      raise exception 'that instructor belongs to another department' using errcode = '42501';
    end if;
    v_target := v_dept;
  else
    v_target := coalesce(p_department_id, case when p_id is not null then v_old.department_id end);
  end if;
  if v_target is not null and not exists (select 1 from public.departments where id = v_target and tenant_id = v_tenant) then
    raise exception 'department not found' using errcode = 'P0002';
  end if;

  begin
    if p_id is null then
      insert into public.instructors (tenant_id, employee_no, full_name, email, department_id, max_weekly_hours, employment_type, is_active)
      values (v_tenant, nullif(btrim(coalesce(p_employee_no, '')), ''), v_name, lower(nullif(btrim(coalesce(p_email, '')), '')),
              v_target, p_max_weekly_hours, p_employment, coalesce(p_is_active, true))
      returning id into v_id;
    else
      update public.instructors
         set employee_no = nullif(btrim(coalesce(p_employee_no, '')), ''),
             full_name = v_name,
             email = lower(nullif(btrim(coalesce(p_email, '')), '')),
             department_id = v_target,
             max_weekly_hours = p_max_weekly_hours,
             employment_type = p_employment,
             is_active = coalesce(p_is_active, true)
       where id = p_id
      returning id into v_id;
    end if;
  exception when unique_violation then
    raise exception 'another instructor already has that employee number or email' using errcode = '23505';
  end;

  delete from public.instructor_work_hours where instructor_id = v_id;
  insert into public.instructor_work_hours (tenant_id, instructor_id, day_of_week, start_time, end_time)
  select v_tenant, v_id, w.day_of_week, w.start_time, w.end_time
    from jsonb_to_recordset(p_work_hours) as w(day_of_week smallint, start_time time, end_time time);

  insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, new_data)
  values (v_tenant, auth.uid(), 'INSTRUCTOR_SAVED', 'instructors', v_id::text,
          jsonb_build_object('full_name', v_name, 'employment', p_employment, 'max_weekly_hours', p_max_weekly_hours, 'work_hours', p_work_hours));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- 5. import_teaching_load
--    p_rows: one object per line of the file, already cleaned up by the app:
--      { "row": 2,
--        "instructor": {"name", "employee_no", "email", "employment": "full_time|part_time",
--                       "max_weekly_hours", "work_hours": [{"day_of_week","start_time","end_time"}]},
--        "course":     {"code", "title", "lecture_units", "lab_units", "room_type"},
--        "program": "BSIT", "year": 2, "section": "A", "students": 38 }
--    p_apply = false: nothing is kept; the result shows what would happen (the preview).
--    p_apply = true:  everything is saved, or nothing if any line has an error.
--    Program chairs: their own department's programs only. Instructors and courses that belong to
--    another department can be used but are never changed.
-- ---------------------------------------------------------------------
create function public.import_teaching_load(p_term_id uuid, p_rows jsonb, p_apply boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role   public.user_role := private.my_role();
  v_tenant uuid := private.my_tenant();
  v_dept   uuid := private.my_department();

  v_issues jsonb := '[]'::jsonb;
  v_detail jsonb := '[]'::jsonb;
  v_errors integer := 0;
  n_inst_new integer := 0;  n_inst_upd integer := 0;
  n_course_new integer := 0; n_course_upd integer := 0;
  n_sec_new integer := 0;   n_sec_upd integer := 0;
  v_weekly_min integer := 0;
  v_seen_inst  uuid[] := '{}';
  v_seen_course uuid[] := '{}';
  v_seen_sec   uuid[] := '{}';
  v_warned_fac text[] := '{}';
  v_inst_state jsonb := '{}'::jsonb;     -- instructor id -> what the file already said about them

  r        record;
  x        record;
  v_n      integer;
  v_prog   record;
  v_year   integer;
  v_section text;
  v_cohort text;
  v_ccode  text;
  v_title  text;
  v_lec    numeric;
  v_lab    numeric;
  v_fac    text;
  v_students integer;
  v_course public.courses%rowtype;
  v_course_found boolean;
  v_can_edit boolean;
  v_iname  text;
  v_emp    text;
  v_email  text;
  v_ids    uuid[];
  v_inst   public.instructors%rowtype;
  v_inst_found boolean;
  v_employment public.employment_type;
  v_maxh   integer;
  v_wh     jsonb;
  v_inst_id uuid;
  v_inst_label text;
  v_plan   jsonb;
  v_sec    public.sections%rowtype;
  v_code   text;
  v_try    integer;
  v_kept   integer;
  v_max_cap integer;
  v_changed boolean;
begin
  if v_role is null or v_role not in ('admin', 'dean', 'program_chair') then
    raise exception 'not allowed to import a teaching load' using errcode = '42501';
  end if;
  if not exists (select 1 from public.terms where id = p_term_id and tenant_id = v_tenant) then
    raise exception 'term not found' using errcode = 'P0002';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'the file has no rows to import' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 1500 then
    raise exception 'too many rows in one import (limit 1500)' using errcode = '22023';
  end if;
  if v_role = 'program_chair' and v_dept is null then
    raise exception 'your account has no department yet; ask an administrator' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('import:' || v_tenant::text, 0));
  select coalesce(max(capacity), 0) into v_max_cap from public.rooms where tenant_id = v_tenant and is_active;

  begin   -- everything below is undone for a dry run, or when any line has an error
    for r in select e.value as v, e.ord as ord from jsonb_array_elements(p_rows) with ordinality as e(value, ord) loop
      v_n := coalesce((r.v ->> 'row')::integer, r.ord::integer);
      begin   -- one line: a failure here is reported against the line and the next line goes on
        -- ---- read and check the line -------------------------------------------------
        v_year    := nullif(r.v ->> 'year', '')::integer;
        v_section := upper(btrim(coalesce(r.v ->> 'section', '')));
        v_ccode   := upper(btrim(regexp_replace(coalesce(r.v #>> '{course,code}', ''), '\s+', ' ', 'g')));
        v_title   := nullif(btrim(coalesce(r.v #>> '{course,title}', '')), '');
        v_lec     := coalesce(nullif(r.v #>> '{course,lecture_units}', '')::numeric, 0);
        v_lab     := coalesce(nullif(r.v #>> '{course,lab_units}', '')::numeric, 0);
        v_fac     := private.norm_facility(r.v #>> '{course,room_type}');
        v_students := nullif(r.v ->> 'students', '')::integer;

        if v_ccode = '' then
          v_issues := v_issues || private.issue(v_n, 'error', 'The course code is missing.'); v_errors := v_errors + 1; continue;
        end if;
        if v_year is null or v_year not between 1 and 6 then
          v_issues := v_issues || private.issue(v_n, 'error', 'The year level must be a number from 1 to 6.'); v_errors := v_errors + 1; continue;
        end if;
        if v_section = '' then
          v_issues := v_issues || private.issue(v_n, 'error', 'The section is missing.'); v_errors := v_errors + 1; continue;
        end if;
        if v_lec < 0 or v_lab < 0 or v_lec > 12 or v_lab > 6 then
          v_issues := v_issues || private.issue(v_n, 'error', 'Units look wrong (lecture 0 to 12, laboratory 0 to 6).'); v_errors := v_errors + 1; continue;
        end if;
        if v_students is not null and v_students < 0 then
          v_issues := v_issues || private.issue(v_n, 'error', 'The number of students cannot be negative.'); v_errors := v_errors + 1; continue;
        end if;

        select p.id, p.code, p.department_id into v_prog
          from public.programs p
         where p.tenant_id = v_tenant and upper(p.code) = upper(btrim(coalesce(r.v ->> 'program', '')));
        if not found then
          v_issues := v_issues || private.issue(v_n, 'error', format('Program "%s" is not set up. Add it on the Departments page first.', coalesce(r.v ->> 'program', '')));
          v_errors := v_errors + 1; continue;
        end if;
        if v_role = 'program_chair' and v_prog.department_id is distinct from v_dept then
          v_issues := v_issues || private.issue(v_n, 'error', format('Program %s belongs to another department.', v_prog.code));
          v_errors := v_errors + 1; continue;
        end if;

        v_cohort := case when v_section ~ '^[0-9]' then v_section else v_year::text || v_section end;

        -- ---- course -----------------------------------------------------------------
        select * into v_course from public.courses where tenant_id = v_tenant and upper(code) = v_ccode;
        v_course_found := found;
        if v_course_found then
          v_can_edit := v_role in ('admin', 'dean') or (v_role = 'program_chair' and v_course.department_id = v_dept);
          if v_can_edit then
            if v_lec + v_lab = 0 then   -- the line did not say: keep what is stored
              v_lec := v_course.lecture_units; v_lab := v_course.lab_units;
            end if;
            v_fac := coalesce(v_fac, v_course.required_facility);
            if (v_title is not null and v_title <> v_course.title) or v_lec <> v_course.lecture_units
               or v_lab <> v_course.lab_units or v_fac is distinct from v_course.required_facility then
              update public.courses
                 set title = coalesce(v_title, title), lecture_units = v_lec, lab_units = v_lab, required_facility = v_fac
               where id = v_course.id;
              if not v_course.id = any(v_seen_course) then n_course_upd := n_course_upd + 1; end if;
            end if;
          else
            if (v_lec + v_lab > 0 and (v_lec <> v_course.lecture_units or v_lab <> v_course.lab_units))
               or (v_fac is not null and v_fac is distinct from v_course.required_facility) then
              v_issues := v_issues || private.issue(v_n, 'warning',
                format('%s belongs to another department, so its stored units and room type were used and not changed.', v_course.code));
            end if;
            v_lec := v_course.lecture_units; v_lab := v_course.lab_units; v_fac := v_course.required_facility;
          end if;
          if not v_course.id = any(v_seen_course) then v_seen_course := v_seen_course || v_course.id; end if;
        else
          if v_lec + v_lab = 0 then
            v_issues := v_issues || private.issue(v_n, 'error', format('%s has no lecture or laboratory units.', v_ccode));
            v_errors := v_errors + 1; continue;
          end if;
          insert into public.courses (tenant_id, department_id, code, title, lecture_units, lab_units, required_facility)
          values (v_tenant, v_prog.department_id, v_ccode, coalesce(v_title, v_ccode), v_lec, v_lab, v_fac)
          returning * into v_course;
          v_seen_course := v_seen_course || v_course.id;
          n_course_new := n_course_new + 1;
        end if;
        if v_lec + v_lab = 0 then
          v_issues := v_issues || private.issue(v_n, 'error', format('%s has no lecture or laboratory units.', v_ccode));
          v_errors := v_errors + 1; continue;
        end if;

        -- ---- instructor -------------------------------------------------------------
        v_inst_id := null; v_inst_label := null;
        v_iname := btrim(regexp_replace(coalesce(r.v #>> '{instructor,name}', ''), '\s+', ' ', 'g'));
        if v_iname = '' or upper(v_iname) in ('TBA', 'TBD', 'N/A', 'NONE', '-') then
          v_issues := v_issues || private.issue(v_n, 'warning', 'No instructor is assigned yet, so instructor clashes cannot be checked for this section.');
        else
          v_emp   := nullif(btrim(coalesce(r.v #>> '{instructor,employee_no}', '')), '');
          v_email := lower(nullif(btrim(coalesce(r.v #>> '{instructor,email}', '')), ''));
          v_employment := nullif(r.v #>> '{instructor,employment}', '')::public.employment_type;
          v_maxh := nullif(r.v #>> '{instructor,max_weekly_hours}', '')::integer;
          v_wh := case when jsonb_typeof(r.v #> '{instructor,work_hours}') = 'array' and jsonb_array_length(r.v #> '{instructor,work_hours}') > 0
                       then r.v #> '{instructor,work_hours}' end;
          if v_maxh is not null and v_maxh not between 1 and 60 then
            v_issues := v_issues || private.issue(v_n, 'error', 'Weekly teaching hours must be between 1 and 60.'); v_errors := v_errors + 1; continue;
          end if;
          if v_wh is not null and exists (
            select 1 from jsonb_to_recordset(v_wh) as w(day_of_week smallint, start_time time, end_time time)
             where w.day_of_week is null or w.day_of_week not between 1 and 7 or w.start_time is null or w.end_time is null or w.end_time <= w.start_time
          ) then
            v_issues := v_issues || private.issue(v_n, 'error', 'A work-hour window has an invalid day or time.'); v_errors := v_errors + 1; continue;
          end if;
          if v_wh is not null and exists (
            select 1 from jsonb_to_recordset(v_wh) as a(day_of_week smallint, start_time time, end_time time)
              join jsonb_to_recordset(v_wh) as b(day_of_week smallint, start_time time, end_time time)
                on a.day_of_week = b.day_of_week and (a.start_time, a.end_time) <> (b.start_time, b.end_time)
               and a.start_time < b.end_time and b.start_time < a.end_time
          ) then
            v_issues := v_issues || private.issue(v_n, 'error', 'Work-hour windows on the same day overlap.'); v_errors := v_errors + 1; continue;
          end if;

          v_ids := '{}';
          if v_emp is not null then
            select coalesce(array_agg(id), '{}') into v_ids from public.instructors where tenant_id = v_tenant and employee_no = v_emp;
          end if;
          if cardinality(v_ids) = 0 and v_email is not null then
            select coalesce(array_agg(id), '{}') into v_ids from public.instructors where tenant_id = v_tenant and lower(email) = v_email;
          end if;
          if cardinality(v_ids) = 0 then
            select coalesce(array_agg(id), '{}') into v_ids from public.instructors
             where tenant_id = v_tenant and lower(regexp_replace(full_name, '\s+', ' ', 'g')) = lower(v_iname);
          end if;
          if cardinality(v_ids) > 1 then
            v_issues := v_issues || private.issue(v_n, 'error', format('More than one instructor is called "%s". Add an employee number or email to say which.', v_iname));
            v_errors := v_errors + 1; continue;
          end if;

          if cardinality(v_ids) = 1 then
            select * into v_inst from public.instructors where id = v_ids[1];
            v_inst_id := v_inst.id; v_inst_label := v_inst.full_name;
            v_can_edit := v_role in ('admin', 'dean') or (v_role = 'program_chair' and v_inst.department_id = v_dept);
            if v_can_edit then
              v_changed := false;
              if (v_employment is not null and v_employment <> v_inst.employment_type)
                 or (v_maxh is not null and v_maxh <> v_inst.max_weekly_hours)
                 or (v_emp is not null and v_inst.employee_no is null)
                 or (v_email is not null and v_inst.email is null) then
                update public.instructors
                   set employment_type = coalesce(v_employment, employment_type),
                       max_weekly_hours = coalesce(v_maxh, max_weekly_hours),
                       employee_no = coalesce(employee_no, v_emp),
                       email = coalesce(email, v_email)
                 where id = v_inst.id;
                v_changed := true;
              end if;
              if v_wh is not null and private.norm_windows(v_wh) is distinct from (
                   select private.norm_windows(coalesce(jsonb_agg(jsonb_build_object('day_of_week', w.day_of_week, 'start_time', w.start_time, 'end_time', w.end_time)), '[]'::jsonb))
                     from public.instructor_work_hours w where w.instructor_id = v_inst.id) then
                delete from public.instructor_work_hours where instructor_id = v_inst.id;
                insert into public.instructor_work_hours (tenant_id, instructor_id, day_of_week, start_time, end_time)
                select v_tenant, v_inst.id, w.day_of_week, w.start_time, w.end_time
                  from jsonb_to_recordset(v_wh) as w(day_of_week smallint, start_time time, end_time time);
                v_changed := true;
              end if;
              if v_changed and not v_inst.id = any(v_seen_inst) then n_inst_upd := n_inst_upd + 1; end if;
            elsif (v_employment is not null and v_employment <> v_inst.employment_type)
               or (v_maxh is not null and v_maxh <> v_inst.max_weekly_hours) or v_wh is not null then
              if not v_inst.id = any(v_seen_inst) then
                v_issues := v_issues || private.issue(v_n, 'warning',
                  format('%s belongs to another department, so their type, hours and work hours were left as they are.', v_inst.full_name));
              end if;
            end if;
          else
            insert into public.instructors (tenant_id, employee_no, full_name, email, department_id, max_weekly_hours, employment_type)
            values (v_tenant, v_emp, v_iname, v_email,
                    case when v_role = 'program_chair' then v_dept else v_prog.department_id end,
                    coalesce(v_maxh, case when v_employment = 'part_time' then 12 else 24 end),
                    coalesce(v_employment, 'full_time'))
            returning * into v_inst;
            v_inst_id := v_inst.id; v_inst_label := v_inst.full_name;
            if v_wh is not null then
              insert into public.instructor_work_hours (tenant_id, instructor_id, day_of_week, start_time, end_time)
              select v_tenant, v_inst.id, w.day_of_week, w.start_time, w.end_time
                from jsonb_to_recordset(v_wh) as w(day_of_week smallint, start_time time, end_time time);
            end if;
            n_inst_new := n_inst_new + 1;
          end if;

          -- the same instructor described differently on another line of the file
          if v_inst_state ? (v_inst_id::text || ':emp') then
            if (v_employment is not null and v_inst_state ->> (v_inst_id::text || ':emp') is distinct from v_employment::text)
               or (v_wh is not null and v_inst_state -> (v_inst_id::text || ':wh') is distinct from private.norm_windows(v_wh)) then
              v_issues := v_issues || private.issue(v_n, 'warning',
                format('%s is described differently on another line. The last one wins.', v_iname));
            end if;
          end if;
          if v_employment is not null then v_inst_state := v_inst_state || jsonb_build_object(v_inst_id::text || ':emp', v_employment::text); end if;
          if v_wh is not null then v_inst_state := v_inst_state || jsonb_build_object(v_inst_id::text || ':wh', private.norm_windows(v_wh)); end if;
          if not v_inst_id = any(v_seen_inst) then v_seen_inst := v_seen_inst || v_inst_id; end if;
        end if;

        -- ---- sections: a lecture part and/or a lab part --------------------------------
        v_plan := '[]'::jsonb;
        for x in select * from private.meeting_plan(v_lec, v_lab) loop
          if x.minutes not between 30 and 300 then
            v_issues := v_issues || private.issue(v_n, 'error', format('A %s meeting would be %s minutes; it must be between 30 and 300.', x.component, x.minutes));
            v_errors := v_errors + 1; continue;
          end if;
          if x.minutes % 30 <> 0 then
            v_issues := v_issues || private.issue(v_n, 'warning',
              format('A %s meeting of %s minutes is placed as %s minutes on the 30-minute grid.', x.component, x.minutes, ceil(x.minutes / 30.0)::integer * 30));
          end if;
          v_code := regexp_replace(v_ccode, '\s', '', 'g') || '-' || v_cohort || case when x.component = 'lab' and v_lec > 0 then '-LAB' else '' end;

          select * into v_sec from public.sections
           where tenant_id = v_tenant and term_id = p_term_id and program_id = v_prog.id and course_id = v_course.id
             and year_level = v_year and cohort = v_cohort and component = x.component;
          if found then
            if v_sec.id = any(v_seen_sec) then
              v_issues := v_issues || private.issue(v_n, 'error', format('%s appears more than once in the file.', v_sec.code));
              v_errors := v_errors + 1; continue;
            end if;
            v_seen_sec := v_seen_sec || v_sec.id;
            select count(*) into v_kept from public.schedule_entries e where e.section_id = v_sec.id and e.status not in ('draft', 'returned');
            if v_kept > 0 and (v_sec.meetings_per_week <> x.meetings or v_sec.minutes_per_meeting <> x.minutes) then
              v_issues := v_issues || private.issue(v_n, 'warning',
                format('%s already has %s submitted, approved or published meetings, so its meeting pattern was not changed.', v_sec.code, v_kept));
              update public.sections set enrollment = coalesce(v_students, enrollment), instructor_id = coalesce(v_inst_id, instructor_id) where id = v_sec.id;
            else
              if (v_sec.meetings_per_week <> x.meetings or v_sec.minutes_per_meeting <> x.minutes)
                 and exists (select 1 from public.schedule_entries e where e.section_id = v_sec.id) then
                v_issues := v_issues || private.issue(v_n, 'warning', format('%s has draft meetings that no longer match; generate its schedule again.', v_sec.code));
              end if;
              update public.sections
                 set meetings_per_week = x.meetings, minutes_per_meeting = x.minutes,
                     enrollment = coalesce(v_students, enrollment), instructor_id = coalesce(v_inst_id, instructor_id)
               where id = v_sec.id;
            end if;
            n_sec_upd := n_sec_upd + 1;
            v_code := v_sec.code;
          else
            v_try := 1;
            while exists (select 1 from public.sections where tenant_id = v_tenant and term_id = p_term_id and code = v_code) loop
              v_code := regexp_replace(v_ccode, '\s', '', 'g') || '-' || v_cohort || case when x.component = 'lab' and v_lec > 0 then '-LAB' else '' end
                        || '-' || v_prog.code || case when v_try > 1 then '-' || v_try::text else '' end;
              v_try := v_try + 1;
              exit when v_try > 50;
            end loop;
            insert into public.sections (tenant_id, term_id, course_id, program_id, code, year_level, cohort, enrollment, instructor_id,
                                         meetings_per_week, minutes_per_meeting, component)
            values (v_tenant, p_term_id, v_course.id, v_prog.id, v_code, v_year, v_cohort, coalesce(v_students, 0), v_inst_id,
                    x.meetings, x.minutes, x.component)
            returning * into v_sec;
            v_seen_sec := v_seen_sec || v_sec.id;
            n_sec_new := n_sec_new + 1;
          end if;
          v_weekly_min := v_weekly_min + x.meetings * x.minutes;
          v_plan := v_plan || jsonb_build_object('component', x.component, 'code', v_code, 'meetings', x.meetings, 'minutes', x.minutes,
            'room_type', case when x.component = 'lab' or v_lab = 0 then v_fac end);

          if (x.component = 'lab' or v_lab = 0) and v_fac is not null
             and not exists (select 1 from public.rooms where tenant_id = v_tenant and is_active and v_fac = any(facilities))
             and not v_fac = any(v_warned_fac) then
            v_warned_fac := v_warned_fac || v_fac;
            v_issues := v_issues || private.issue(v_n, 'warning',
              format('No room has the type "%s". Give a room that type, or these sections cannot be placed.', v_fac));
          end if;
        end loop;

        if v_students is null then
          v_issues := v_issues || private.issue(v_n, 'warning', 'No student count, so room size is not checked for this section.');
        elsif v_students > v_max_cap then
          v_issues := v_issues || private.issue(v_n, 'warning', format('%s students is more than any room seats (largest: %s).', v_students, v_max_cap));
        end if;

        v_detail := v_detail || jsonb_build_object('row', v_n, 'instructor', v_inst_label, 'program', v_prog.code, 'course', v_course.code,
          'title', v_course.title, 'year', v_year, 'cohort', v_cohort, 'students', v_students,
          'lecture_units', v_lec, 'lab_units', v_lab, 'plan', v_plan);
      exception
        when unique_violation then
          v_issues := v_issues || private.issue(v_n, 'error', 'An employee number, email or section code on this line is already used by another record.');
          v_errors := v_errors + 1;
        when others then
          v_issues := v_issues || private.issue(v_n, 'error', 'Could not be saved: ' || sqlerrm);
          v_errors := v_errors + 1;
      end;
    end loop;

    -- ---- load check: what each instructor now teaches this term --------------------------
    for x in
      select i.id, i.full_name, i.max_weekly_hours as cap,
             coalesce(sum(s.meetings_per_week * s.minutes_per_meeting), 0) / 60.0 as hours,
             (select coalesce(sum(extract(epoch from w.end_time - w.start_time)), 0) / 3600.0 from public.instructor_work_hours w where w.instructor_id = i.id) as window_hours
        from public.instructors i
        left join public.sections s on s.instructor_id = i.id and s.term_id = p_term_id
       where i.id = any(v_seen_inst)
       group by i.id
    loop
      if x.hours > x.cap then
        v_issues := v_issues || private.issue(null, 'warning',
          format('%s would teach %s hours a week this term, over their limit of %s.', x.full_name, round(x.hours, 1), x.cap));
      end if;
      if x.window_hours > 0 and x.hours > x.window_hours then
        v_issues := v_issues || private.issue(null, 'warning',
          format('%s would teach %s hours a week but only works %s hours a week.', x.full_name, round(x.hours, 1), round(x.window_hours, 1)));
      end if;
    end loop;

    if p_apply and v_errors = 0 then
      insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, new_data)
      values (v_tenant, auth.uid(), 'TEACHING_LOAD_IMPORTED', 'sections', p_term_id::text,
              jsonb_build_object('term_id', p_term_id, 'rows', jsonb_array_length(p_rows),
                'instructors_new', n_inst_new, 'courses_new', n_course_new, 'sections_new', n_sec_new, 'sections_updated', n_sec_upd));
    else
      raise exception 'rolled back' using errcode = 'P0900';
    end if;
  exception when sqlstate 'P0900' then
    null;
  end;

  return jsonb_build_object(
    'applied', p_apply and v_errors = 0,
    'errors', v_errors,
    'issues', v_issues,
    'rows', v_detail,
    'summary', jsonb_build_object(
      'instructors_new', n_inst_new, 'instructors_updated', n_inst_upd,
      'courses_new', n_course_new, 'courses_updated', n_course_upd,
      'sections_new', n_sec_new, 'sections_updated', n_sec_upd,
      'weekly_hours', round(v_weekly_min / 60.0, 1))
  );
end $$;

revoke all on function public.save_instructor(uuid, text, text, text, public.employment_type, integer, jsonb, uuid, boolean) from public, anon;
grant execute on function public.save_instructor(uuid, text, text, text, public.employment_type, integer, jsonb, uuid, boolean) to authenticated, service_role;
revoke all on function public.import_teaching_load(uuid, jsonb, boolean) from public, anon;
grant execute on function public.import_teaching_load(uuid, jsonb, boolean) to authenticated, service_role;
