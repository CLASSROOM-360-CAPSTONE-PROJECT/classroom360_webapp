-- =====================================================================
-- Classroom360 — demo seed data: LRC building, 3rd floor, four-door key locker
-- Run after ALL the migrations (1 to 6). Safe to run again: it rebuilds the demo institution ("hcc")
-- from scratch, and keeps any accounts that have already signed up (same roles).
-- Running it again erases that institution's schedules, locker logs and audit history,
-- so use it on demo or test projects only.
-- Everything below is fictional placeholder data: delete it before real use.
-- =====================================================================
do $$
declare
  v_tenant   uuid := gen_random_uuid();
  v_campus   uuid;
  v_building uuid;
  v_dept     uuid;
  v_term     uuid;
  v_keep     jsonb;
  v_l301     uuid;
  v_l303     uuid;
  v_l304     uuid;
  v_e303     uuid;
  v_e401     uuid;
  v_e331     uuid;
  v_log      uuid;
begin
  if to_regclass('public.room_requests') is null then
    raise exception 'Run supabase/migrations/20261103000004_cross_department_and_requests.sql before this seed.';
  end if;
  if to_regclass('public.instructor_work_hours') is null then
    raise exception 'Run supabase/migrations/20261103000006_work_hours_school_hours_and_import.sql before this seed.';
  end if;

  -- Seeding is not an administrator's action, so keep it out of the audit trail.
  alter table public.departments        disable trigger audit_departments;
  alter table public.programs           disable trigger audit_programs;
  alter table public.rooms              disable trigger audit_rooms;
  alter table public.lockers            disable trigger audit_lockers;
  alter table public.rfid_cards         disable trigger audit_rfid_cards;
  alter table public.instructors        disable trigger audit_instructors;
  alter table public.profiles           disable trigger audit_profiles;
  alter table public.schedule_entries   disable trigger audit_schedule_entries_deleted;

  -- remember who has already signed up, then rebuild the demo institution
  select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) into v_keep
    from public.profiles p
    join public.tenants t on t.id = p.tenant_id
   where t.slug = 'hcc';
  delete from public.tenants where slug = 'hcc';

  insert into public.tenants (id, name, slug)
  values (v_tenant, 'Holy Cross Colleges, Inc.', 'hcc');

  insert into public.campuses (tenant_id, name)
  values (v_tenant, 'Sta. Lucia Campus') returning id into v_campus;

  insert into public.buildings (tenant_id, campus_id, code, name)
  values (v_tenant, v_campus, 'LRC', 'Learning Resource Center') returning id into v_building;

  -- Third floor: four rooms, one key each, in a four-door locker
  insert into public.rooms (tenant_id, building_id, code, name, floor, capacity, facilities)
  values
    (v_tenant, v_building, 'LRC-301', 'Room 301', 3, 40, '{}'),
    (v_tenant, v_building, 'LRC-302', 'Room 302', 3, 40, '{}'),
    (v_tenant, v_building, 'LRC-303', 'Room 303', 3, 45, '{}'),
    (v_tenant, v_building, 'LRC-304', 'Room 304', 3, 30, '{electronics_lab,computer_lab}');

  insert into public.lockers (tenant_id, room_id, station_label, compartment_no)
  select v_tenant, r.id, 'LRC 3F Key Locker', (row_number() over (order by r.code))::smallint
    from public.rooms r
   where r.tenant_id = v_tenant;

  insert into public.departments (tenant_id, code, name)
  values (v_tenant, 'SCITE', 'School of Computing, Information Technology and Engineering')
  returning id into v_dept;

  insert into public.programs (tenant_id, department_id, code, name)
  values
    (v_tenant, v_dept, 'BSCPE', 'BS Computer Engineering'),
    (v_tenant, v_dept, 'BSIT',  'BS Information Technology');

  insert into public.terms (tenant_id, name, starts_on, ends_on, is_active)
  values (v_tenant, 'AY 2026-2027, 1st Semester', date '2026-08-17', date '2026-12-19', true)
  returning id into v_term;

  insert into public.instructors (tenant_id, employee_no, full_name, email, department_id)
  values
    (v_tenant, 'E-001', 'Maria Santos',     'maria.santos@example.edu',     v_dept),
    (v_tenant, 'E-002', 'Jose Reyes',       'jose.reyes@example.edu',       v_dept),
    (v_tenant, 'E-003', 'Ana Cruz',         'ana.cruz@example.edu',         v_dept),
    (v_tenant, 'E-004', 'Paolo Garcia',     'paolo.garcia@example.edu',     v_dept),
    (v_tenant, 'E-005', 'Lourdes Mendoza',  'lourdes.mendoza@example.edu',  v_dept),
    (v_tenant, 'E-006', 'Ramon Villanueva', 'ramon.villanueva@example.edu', v_dept);

  -- One part-time instructor, who only works Tuesday and Thursday (everyone else can teach whenever the school is open)
  update public.instructors
     set employment_type = 'part_time', max_weekly_hours = 12
   where tenant_id = v_tenant and employee_no = 'E-005';
  insert into public.instructor_work_hours (tenant_id, instructor_id, day_of_week, start_time, end_time)
  select v_tenant, i.id, d.dow, time '08:00', time '17:00'
    from public.instructors i
   cross join (values (2), (4)) as d(dow)
   where i.tenant_id = v_tenant and i.employee_no = 'E-005';

  insert into public.rfid_cards (tenant_id, instructor_id, card_uid)
  select v_tenant, i.id, '04A1B2C30' || right(i.employee_no, 1)
    from public.instructors i
   where i.tenant_id = v_tenant;

  insert into public.courses (tenant_id, department_id, code, title, units, required_facility)
  values
    (v_tenant, v_dept, 'CPE 401', 'Computer Engineering Design Project 1', 3.0, null),
    (v_tenant, v_dept, 'CPE 331', 'Software Design',                       3.0, null),
    (v_tenant, v_dept, 'CPE 321', 'Data Communications',                   3.0, null),
    (v_tenant, v_dept, 'CPE 311', 'Microprocessors Laboratory',            1.0, 'electronics_lab'),
    (v_tenant, v_dept, 'IT 201',  'Data Structures and Algorithms',        3.0, null),
    (v_tenant, v_dept, 'IT 211',  'Database Systems',                      3.0, null),
    (v_tenant, v_dept, 'IT 221',  'Web Systems and Technologies',          3.0, null),
    (v_tenant, v_dept, 'GE 101',  'Purposive Communication',               3.0, null);

  insert into public.sections
    (tenant_id, term_id, course_id, program_id, code, year_level, cohort, enrollment, instructor_id,
     meetings_per_week, minutes_per_meeting)
  select v_tenant, v_term, c.id, p.id, v.sec, v.yr, v.cohort, v.enr, i.id, v.mtg, v.mins
    from (values
      ('CPE401-4A', 'CPE 401', 'BSCPE', 4, '4A', 28, 1, 2,  90),
      ('CPE331-3A', 'CPE 331', 'BSCPE', 3, '3A', 36, 2, 2,  90),
      ('CPE321-3A', 'CPE 321', 'BSCPE', 3, '3A', 36, 3, 2,  90),
      ('CPE311-3A', 'CPE 311', 'BSCPE', 3, '3A', 28, 3, 1, 180),
      ('IT201-2A',  'IT 201',  'BSIT',  2, '2A', 40, 4, 2,  90),
      ('IT211-3A',  'IT 211',  'BSIT',  3, '3A', 38, 5, 2,  90),
      ('IT221-3A',  'IT 221',  'BSIT',  3, '3A', 38, 4, 2,  90),
      ('GE101-1A',  'GE 101',  'BSIT',  1, '1A', 42, 6, 2,  90)
    ) as v(sec, course, prog, yr, cohort, enr, inst_no, mtg, mins)
    join public.courses  c on c.tenant_id = v_tenant and c.code = v.course
    join public.programs p on p.tenant_id = v_tenant and p.code = v.prog
    join public.instructors i on i.tenant_id = v_tenant and i.employee_no = 'E-00' || v.inst_no;

  -- A published, conflict-free week across the four rooms (ISO days: 1 = Monday ... 5 = Friday)
  insert into public.schedule_entries
    (tenant_id, term_id, section_id, room_id, day_of_week, start_time, end_time, status)
  select v_tenant, v_term, s.id, r.id, v.dow, v.st::time, v.en::time, 'published'
    from (values
      ('CPE401-4A', 'LRC-304', 1, '08:00', '09:30'),
      ('CPE401-4A', 'LRC-304', 3, '08:00', '09:30'),
      ('CPE331-3A', 'LRC-301', 1, '09:30', '11:00'),
      ('CPE331-3A', 'LRC-301', 3, '09:30', '11:00'),
      ('CPE321-3A', 'LRC-302', 1, '11:00', '12:30'),
      ('CPE321-3A', 'LRC-302', 3, '11:00', '12:30'),
      ('GE101-1A',  'LRC-303', 1, '13:00', '14:30'),
      ('GE101-1A',  'LRC-303', 3, '13:00', '14:30'),
      ('IT201-2A',  'LRC-303', 2, '08:00', '09:30'),
      ('IT201-2A',  'LRC-303', 4, '08:00', '09:30'),
      ('IT211-3A',  'LRC-302', 2, '09:30', '11:00'),
      ('IT211-3A',  'LRC-302', 4, '09:30', '11:00'),
      ('IT221-3A',  'LRC-301', 2, '13:00', '14:30'),
      ('IT221-3A',  'LRC-301', 4, '13:00', '14:30'),
      ('CPE311-3A', 'LRC-304', 5, '13:00', '16:00')
    ) as v(sec, room, dow, st, en)
    join public.sections s on s.tenant_id = v_tenant and s.term_id = v_term and s.code = v.sec
    join public.rooms    r on r.tenant_id = v_tenant and r.code = v.room;

  -- ---- demo activity so the dashboard has something to show ----
  select l.id into v_l301 from public.lockers l join public.rooms r on r.id = l.room_id where r.code = 'LRC-301';
  select l.id into v_l303 from public.lockers l join public.rooms r on r.id = l.room_id where r.code = 'LRC-303';
  select l.id into v_l304 from public.lockers l join public.rooms r on r.id = l.room_id where r.code = 'LRC-304';

  select se.id into v_e303 from public.schedule_entries se join public.rooms r on r.id = se.room_id
   where r.code = 'LRC-303' and se.day_of_week = 1;
  select se.id into v_e401 from public.schedule_entries se join public.rooms r on r.id = se.room_id
   where r.code = 'LRC-304' and se.day_of_week = 1 and se.start_time = time '08:00';
  select se.id into v_e331 from public.schedule_entries se join public.rooms r on r.id = se.room_id
   where r.code = 'LRC-301' and se.day_of_week = 1;

  -- key currently out for Room 303
  insert into public.access_logs (tenant_id, locker_id, card_uid_presented, instructor_id, schedule_entry_id, decision, reason, occurred_at)
  select v_tenant, v_l303, c.card_uid, c.instructor_id, v_e303, 'granted', 'scheduled_match', now() - interval '16 minutes'
    from public.rfid_cards c where c.tenant_id = v_tenant and c.card_uid = '04A1B2C306';

  -- unknown card at Room 301
  insert into public.access_logs (tenant_id, locker_id, card_uid_presented, decision, reason, occurred_at)
  values (v_tenant, v_l301, 'DEADBEEF00', 'denied', 'unregistered_credential', now() - interval '2 hours');

  -- valid card, wrong time
  insert into public.access_logs (tenant_id, locker_id, card_uid_presented, instructor_id, decision, reason, occurred_at)
  select v_tenant, v_l301, c.card_uid, c.instructor_id, 'denied', 'outside_scheduled_time', now() - interval '95 minutes'
    from public.rfid_cards c where c.tenant_id = v_tenant and c.card_uid = '04A1B2C302';

  -- key taken and returned for Room 301 earlier today
  insert into public.access_logs (tenant_id, locker_id, card_uid_presented, instructor_id, schedule_entry_id, decision, reason, occurred_at)
  select v_tenant, v_l301, c.card_uid, c.instructor_id, v_e331, 'granted', 'scheduled_match', now() - interval '3 hours'
    from public.rfid_cards c where c.tenant_id = v_tenant and c.card_uid = '04A1B2C302'
  returning id into v_log;
  insert into public.key_return_events (tenant_id, locker_id, access_log_id, key_detected, occurred_at)
  values (v_tenant, v_l301, v_log, true, now() - interval '150 minutes');

  -- Room 304 key taken yesterday and never returned -> outstanding
  insert into public.access_logs (tenant_id, locker_id, card_uid_presented, instructor_id, schedule_entry_id, decision, reason, occurred_at)
  select v_tenant, v_l304, c.card_uid, c.instructor_id, v_e401, 'granted', 'scheduled_match', now() - interval '1 day 4 hours'
    from public.rfid_cards c where c.tenant_id = v_tenant and c.card_uid = '04A1B2C301';

  -- camera: Room 303 occupied as scheduled; Room 304 occupied with no class scheduled
  insert into public.occupancy_events (tenant_id, room_id, is_occupied, confidence, occurred_at)
  select v_tenant, r.id, true, 0.93, now() - interval '2 minutes'
    from public.rooms r where r.tenant_id = v_tenant and r.code in ('LRC-303', 'LRC-304');

  -- teacher requests for a free room: one waiting, one approved, one rejected (all in the future)
  insert into public.room_requests
    (tenant_id, instructor_id, room_id, requested_for, start_time, end_time, reason, status, decided_at, decision_note)
  select v_tenant, i.id, r.id,
         (now() at time zone 'Asia/Manila')::date + v.days, v.st::time, v.en::time, v.reason, v.status::public.request_status,
         case when v.status = 'pending' then null else now() - interval '30 minutes' end, v.note
    from (values
      ('E-003', 'LRC-301', 1, '16:00', '17:30', 'Make-up class for the section that missed Monday.',   'pending',  null),
      ('E-002', 'LRC-302', 1, '16:00', '17:00', 'Consultation hour before the midterm exam.',          'approved', null),
      ('E-004', 'LRC-304', 2, '16:00', '18:00', 'Extra lab session for the capstone teams.',           'rejected', 'The electronics lab is closed for inventory that day.')
    ) as v(emp, room, days, st, en, reason, status, note)
    join public.instructors i on i.tenant_id = v_tenant and i.employee_no = v.emp
    join public.rooms       r on r.tenant_id = v_tenant and r.code = v.room;

  -- put existing sign-in accounts back (same roles) and link them to matching instructors
  insert into public.profiles (id, tenant_id, email, full_name, role, department_id)
  select k.id, v_tenant, k.email, k.full_name, k.role, case when k.department_id is not null then v_dept end
    from jsonb_to_recordset(v_keep) as k(id uuid, email text, full_name text, role public.user_role, department_id uuid);

  update public.instructors i
     set profile_id = p.id
    from public.profiles p
   where i.tenant_id = v_tenant and p.tenant_id = v_tenant
     and i.profile_id is null and lower(i.email) = lower(p.email);

  alter table public.departments        enable trigger audit_departments;
  alter table public.programs           enable trigger audit_programs;
  alter table public.rooms              enable trigger audit_rooms;
  alter table public.lockers            enable trigger audit_lockers;
  alter table public.rfid_cards         enable trigger audit_rfid_cards;
  alter table public.instructors        enable trigger audit_instructors;
  alter table public.profiles           enable trigger audit_profiles;
  alter table public.schedule_entries   enable trigger audit_schedule_entries_deleted;

  -- the nine-door demo data is gone, so the four-door rule (added NOT VALID) can now be enforced for old rows too
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.lockers'::regclass and conname = 'lockers_four_doors_check' and not convalidated
  ) then
    alter table public.lockers validate constraint lockers_four_doors_check;
  end if;
end $$;
