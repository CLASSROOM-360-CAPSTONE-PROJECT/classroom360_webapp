-- =====================================================================
-- Classroom360 — core schema
-- Shared backend for the web app, the Flutter mobile app and the locker
-- station firmware. Every table carries tenant_id (tenant isolation is
-- enforced by row-level security in the next migration).
-- =====================================================================

create extension if not exists btree_gist;

create schema if not exists private;

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------
create type public.user_role       as enum ('admin', 'dean', 'program_chair', 'instructor');
create type public.schedule_status as enum ('draft', 'submitted', 'approved', 'published', 'returned');
create type public.access_decision as enum ('granted', 'denied');
create type public.solve_status    as enum ('queued', 'running', 'feasible', 'infeasible', 'error');

create function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------
-- Institutional group
-- ---------------------------------------------------------------------
create table public.tenants (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  slug            text not null unique,
  timezone        text not null default 'Asia/Manila',
  -- minutes before and after a class during which its instructor may still take / return the key
  grace_minutes   smallint not null default 10 check (grace_minutes between 0 and 60),
  operating_start time not null default '07:00',
  operating_end   time not null default '21:00',
  created_at      timestamptz not null default now()
);

create table public.campuses (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create table public.buildings (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  campus_id  uuid not null references public.campuses(id) on delete cascade,
  code       text not null,
  name       text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table public.rooms (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  building_id uuid not null references public.buildings(id) on delete restrict,
  code        text not null,
  name        text not null,
  floor       smallint not null default 1,
  capacity    integer not null check (capacity > 0),
  facilities  text[] not null default '{}',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

create table public.departments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  code       text not null,
  name       text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table public.programs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  department_id uuid not null references public.departments(id) on delete cascade,
  code          text not null,
  name          text not null,
  created_at    timestamptz not null default now(),
  unique (tenant_id, code)
);

-- ---------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------
-- One profile per Supabase auth user. Role and tenant are assigned by the
-- backend (never taken from client-supplied metadata).
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  role          public.user_role not null default 'instructor',
  full_name     text,
  email         text,
  department_id uuid references public.departments(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Instructors are scheduling records; they may or may not have an app login.
create table public.instructors (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  profile_id       uuid unique references public.profiles(id) on delete set null,
  employee_no      text,
  full_name        text not null,
  email            text,
  department_id    uuid references public.departments(id) on delete set null,
  max_weekly_hours smallint not null default 24 check (max_weekly_hours > 0),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (tenant_id, employee_no),
  unique (tenant_id, email)
);

-- Declared periods in which an instructor cannot be scheduled (hard constraint input).
create table public.instructor_unavailability (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  day_of_week   smallint not null check (day_of_week between 1 and 7),
  start_time    time not null,
  end_time      time not null,
  note          text,
  check (end_time > start_time)
);

-- ---------------------------------------------------------------------
-- Academic group
-- ---------------------------------------------------------------------
create table public.terms (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name      text not null,
  starts_on date not null,
  ends_on   date not null,
  is_active boolean not null default false,
  check (ends_on > starts_on),
  unique (tenant_id, name)
);

create table public.courses (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  department_id     uuid references public.departments(id) on delete set null,
  code              text not null,
  title             text not null,
  units             numeric(3,1) not null default 3.0,
  -- facility the room must provide, e.g. 'computer_lab' (hard constraint)
  required_facility text,
  unique (tenant_id, code)
);

create table public.sections (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  term_id            uuid not null references public.terms(id) on delete cascade,
  course_id          uuid not null references public.courses(id) on delete cascade,
  program_id         uuid not null references public.programs(id) on delete cascade,
  code               text not null,
  year_level         smallint check (year_level between 1 and 6),
  cohort             text,                       -- student block, e.g. '4A'
  enrollment         integer not null default 0 check (enrollment >= 0),
  instructor_id      uuid references public.instructors(id) on delete set null,
  meetings_per_week  smallint not null default 2 check (meetings_per_week between 1 and 6),
  minutes_per_meeting smallint not null default 90 check (minutes_per_meeting between 30 and 300),
  unique (tenant_id, term_id, code)
);

-- ---------------------------------------------------------------------
-- Scheduling group
-- ---------------------------------------------------------------------
-- One row = one weekly meeting of a section in a room.
-- program_id, instructor_id, cohort_key and tenant_id are copied from the
-- section by a trigger so that the exclusion constraints below can see them.
create table public.schedule_entries (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  term_id       uuid not null references public.terms(id) on delete cascade,
  section_id    uuid not null references public.sections(id) on delete cascade,
  program_id    uuid references public.programs(id) on delete set null,
  instructor_id uuid references public.instructors(id) on delete set null,
  cohort_key    text,
  room_id       uuid not null references public.rooms(id) on delete restrict,
  day_of_week   smallint not null check (day_of_week between 1 and 7),   -- ISO: Monday = 1
  start_time    time not null,
  end_time      time not null,
  status        public.schedule_status not null default 'draft',
  is_override   boolean not null default false,
  created_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (end_time > start_time),
  -- minutes since Monday 00:00, used for overlap tests
  slot int4range generated always as (
    int4range(
      day_of_week * 1440 + (extract(epoch from start_time) / 60)::int,
      day_of_week * 1440 + (extract(epoch from end_time) / 60)::int
    )
  ) stored,

  -- Hard constraints enforced by the database itself, so no client defect
  -- (and no override) can persist a double booking.
  constraint no_room_double_booking
    exclude using gist (tenant_id with =, term_id with =, room_id with =, slot with &&)
    where (status <> 'returned'),
  constraint no_instructor_double_booking
    exclude using gist (tenant_id with =, term_id with =, instructor_id with =, slot with &&)
    where (status <> 'returned' and instructor_id is not null),
  constraint no_cohort_double_booking
    exclude using gist (tenant_id with =, term_id with =, cohort_key with =, slot with &&)
    where (status <> 'returned' and cohort_key is not null)
);

create index schedule_entries_section_idx on public.schedule_entries (section_id);
create index schedule_entries_lookup_idx  on public.schedule_entries (tenant_id, term_id, program_id, status);

create function public.schedule_entries_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  s record;
begin
  select sec.tenant_id, sec.term_id, sec.program_id, sec.instructor_id, sec.year_level, sec.cohort
    into s
    from public.sections sec
   where sec.id = new.section_id;
  if not found then
    raise exception 'section % does not exist', new.section_id;
  end if;

  new.tenant_id     := s.tenant_id;
  new.term_id       := s.term_id;
  new.program_id    := s.program_id;
  new.instructor_id := s.instructor_id;
  new.cohort_key    := case when s.cohort is null then null
                            else s.program_id::text || ':' || coalesce(s.year_level::text, '') || ':' || s.cohort end;
  return new;
end $$;

create trigger schedule_entries_sync
  before insert or update on public.schedule_entries
  for each row execute function public.schedule_entries_sync();

create trigger schedule_entries_updated_at
  before update on public.schedule_entries
  for each row execute function public.set_updated_at();

-- If a section's instructor or cohort changes, re-sync its entries (the exclusion
-- constraints then re-check them).
create function public.sections_resync_entries() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.schedule_entries set updated_at = now() where section_id = new.id;
  return new;
end $$;

create trigger sections_resync_entries
  after update of instructor_id, program_id, cohort, year_level on public.sections
  for each row execute function public.sections_resync_entries();

-- Every invocation of the optimization service.
create table public.solve_jobs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  term_id         uuid not null references public.terms(id) on delete cascade,
  program_id      uuid references public.programs(id) on delete set null,
  requested_by    uuid references public.profiles(id) on delete set null default auth.uid(),
  status          public.solve_status not null default 'queued',
  runtime_ms      integer,
  hard_violations integer,
  soft_penalty    numeric,
  message         text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

-- ---------------------------------------------------------------------
-- Operational group (written by the locker station / CV service via service_role)
-- ---------------------------------------------------------------------
create table public.lockers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  room_id        uuid not null unique references public.rooms(id) on delete cascade,
  station_label  text not null,
  compartment_no smallint not null check (compartment_no > 0),
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (tenant_id, station_label, compartment_no)
);

create table public.rfid_cards (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  card_uid      text not null,
  is_active     boolean not null default true,
  issued_at     timestamptz not null default now(),
  unique (tenant_id, card_uid)
);
-- an instructor holds at most one active card; replacing a card means deactivating the old one
create unique index rfid_cards_one_active_per_instructor
  on public.rfid_cards (instructor_id) where is_active;

create table public.access_logs (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  locker_id          uuid not null references public.lockers(id) on delete cascade,
  card_uid_presented text not null,
  instructor_id      uuid references public.instructors(id) on delete set null,
  schedule_entry_id  uuid references public.schedule_entries(id) on delete set null,
  decision           public.access_decision not null,
  reason             text not null,
  latency_ms         integer check (latency_ms >= 0),
  occurred_at        timestamptz not null default now()
);
create index access_logs_tenant_time_idx on public.access_logs (tenant_id, occurred_at desc);
create index access_logs_locker_time_idx on public.access_logs (locker_id, occurred_at desc);

create table public.key_return_events (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  locker_id     uuid not null references public.lockers(id) on delete cascade,
  access_log_id uuid references public.access_logs(id) on delete set null,
  key_detected  boolean not null,
  occurred_at   timestamptz not null default now()
);
create index key_return_events_log_idx on public.key_return_events (access_log_id);

create table public.occupancy_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  room_id     uuid not null references public.rooms(id) on delete cascade,
  is_occupied boolean not null,
  confidence  real check (confidence between 0 and 1),
  occurred_at timestamptz not null default now()
);
create index occupancy_events_room_time_idx on public.occupancy_events (room_id, occurred_at desc);

create table public.audit_logs (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  actor_id      uuid references public.profiles(id) on delete set null,
  action        text not null,
  table_name    text not null,
  record_id     text,
  old_data      jsonb,
  new_data      jsonb,
  justification text,
  created_at    timestamptz not null default now()
);
create index audit_logs_tenant_time_idx on public.audit_logs (tenant_id, created_at desc);

-- ---------------------------------------------------------------------
-- Key-transaction helper and status views
-- ---------------------------------------------------------------------
-- The open transaction of a locker is its latest granted access that has no
-- confirmed key return yet (i.e. the key is out).
create function private.locker_open_access_log(p_locker_id uuid) returns uuid
language sql stable as $$
  select al.id
    from public.access_logs al
   where al.locker_id = p_locker_id
     and al.decision = 'granted'
     and not exists (
       select 1 from public.key_return_events k
        where k.access_log_id = al.id and k.key_detected
     )
   order by al.occurred_at desc
   limit 1
$$;

-- Key status per locker: available / issued / outstanding (class ended + grace, key still out).
create view public.locker_status with (security_invoker = true) as
select
  l.id             as locker_id,
  l.tenant_id,
  l.room_id,
  r.code           as room_code,
  r.name           as room_name,
  l.compartment_no,
  l.station_label,
  tx.id            as access_log_id,
  tx.instructor_id,
  i.full_name      as holder_name,
  tx.occurred_at   as issued_at,
  case
    when tx.id is null then 'available'
    when (now() at time zone t.timezone) >
         ((tx.occurred_at at time zone t.timezone)::date + coalesce(se.end_time, time '23:59'))
           + make_interval(mins => t.grace_minutes)
      then 'outstanding'
    else 'issued'
  end              as key_status
from public.lockers l
join public.rooms   r on r.id = l.room_id
join public.tenants t on t.id = l.tenant_id
left join lateral (
  select al.*
    from public.access_logs al
   where al.locker_id = l.id
     and al.decision = 'granted'
     and not exists (
       select 1 from public.key_return_events k
        where k.access_log_id = al.id and k.key_detected
     )
   order by al.occurred_at desc
   limit 1
) tx on true
left join public.schedule_entries se on se.id = tx.schedule_entry_id
left join public.instructors      i  on i.id  = tx.instructor_id
where l.is_active;

-- What each room is doing right now: scheduled class, key status, camera occupancy, discrepancy.
create view public.room_status_now with (security_invoker = true) as
with ctx as (
  select t.id as tenant_id, (now() at time zone t.timezone) as local_now
    from public.tenants t
)
select
  r.id          as room_id,
  r.tenant_id,
  r.code        as room_code,
  r.name        as room_name,
  b.name        as building_name,
  r.floor,
  cur.id        as schedule_entry_id,
  cur.start_time,
  cur.end_time,
  i.full_name   as instructor_name,
  c.code        as course_code,
  s.code        as section_code,
  ls.key_status,
  occ.is_occupied,
  occ.occurred_at as occupancy_at,
  case
    when cur.id is not null and occ.is_occupied is false then 'scheduled_but_empty'
    when cur.id is null     and occ.is_occupied is true  then 'occupied_not_scheduled'
  end           as discrepancy
from public.rooms r
join public.buildings b on b.id = r.building_id
join ctx on ctx.tenant_id = r.tenant_id
left join lateral (
  select se.*
    from public.schedule_entries se
    join public.terms tm on tm.id = se.term_id
   where se.room_id = r.id
     and se.status = 'published'
     and se.day_of_week = extract(isodow from ctx.local_now)::int
     and ctx.local_now::date between tm.starts_on and tm.ends_on
     and ctx.local_now::time between se.start_time and se.end_time
   limit 1
) cur on true
left join public.sections    s on s.id = cur.section_id
left join public.courses     c on c.id = s.course_id
left join public.instructors i on i.id = cur.instructor_id
left join public.locker_status ls on ls.room_id = r.id
left join lateral (
  select o.is_occupied, o.occurred_at
    from public.occupancy_events o
   where o.room_id = r.id
     and o.occurred_at > now() - interval '10 minutes'
   order by o.occurred_at desc
   limit 1
) occ on true
where r.is_active;

-- ---------------------------------------------------------------------
-- Device-facing functions (callable by the locker station with the service_role key only)
-- ---------------------------------------------------------------------

-- Decide whether the card presented at a locker may take the key right now.
-- Records every attempt, granted or denied. Returns a small JSON document.
create function public.authorize_key_request(
  p_card_uid  text,
  p_locker_id uuid,
  p_at        timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_locker     public.lockers%rowtype;
  v_tenant     public.tenants%rowtype;
  v_card       public.rfid_cards%rowtype;
  v_entry      public.schedule_entries%rowtype;
  v_instructor public.instructors%rowtype;
  v_local      timestamp;
  v_dow        smallint;
  v_time       time;
  v_grace      interval;
  v_decision   public.access_decision := 'denied';
  v_reason     text;
  v_log        uuid;
begin
  select * into v_locker from public.lockers where id = p_locker_id and is_active;
  if not found then
    raise exception 'unknown or inactive locker %', p_locker_id using errcode = 'P0002';
  end if;

  select * into v_tenant from public.tenants where id = v_locker.tenant_id;
  v_local := p_at at time zone v_tenant.timezone;
  v_dow   := extract(isodow from v_local)::smallint;
  v_time  := v_local::time;
  v_grace := make_interval(mins => v_tenant.grace_minutes);

  select * into v_card
    from public.rfid_cards
   where tenant_id = v_locker.tenant_id and card_uid = p_card_uid;

  if not found then
    v_reason := 'unregistered_credential';
  elsif not v_card.is_active then
    v_reason := 'inactive_credential';
  else
    select * into v_instructor from public.instructors where id = v_card.instructor_id;

    -- the card holder is scheduled in THIS room right now (within the grace window)
    select se.* into v_entry
      from public.schedule_entries se
      join public.terms t on t.id = se.term_id
     where se.tenant_id     = v_locker.tenant_id
       and se.status        = 'published'
       and se.instructor_id = v_card.instructor_id
       and se.room_id       = v_locker.room_id
       and se.day_of_week   = v_dow
       and v_local::date between t.starts_on and t.ends_on
       and v_time between se.start_time - v_grace and se.end_time + v_grace
     limit 1;

    if found then
      if private.locker_open_access_log(v_locker.id) is not null then
        v_reason := 'key_already_issued';
      else
        v_decision := 'granted';
        v_reason   := 'scheduled_match';
      end if;
    elsif exists (
      select 1
        from public.schedule_entries se
        join public.terms t on t.id = se.term_id
       where se.tenant_id     = v_locker.tenant_id
         and se.status        = 'published'
         and se.instructor_id = v_card.instructor_id
         and se.day_of_week   = v_dow
         and v_local::date between t.starts_on and t.ends_on
         and v_time between se.start_time - v_grace and se.end_time + v_grace
    ) then
      v_reason := 'assigned_to_different_room';
    else
      v_reason := 'outside_scheduled_time';
    end if;
  end if;

  insert into public.access_logs
    (tenant_id, locker_id, card_uid_presented, instructor_id, schedule_entry_id, decision, reason, occurred_at)
  values
    (v_locker.tenant_id, v_locker.id, p_card_uid, v_card.instructor_id, v_entry.id, v_decision, v_reason, p_at)
  returning id into v_log;

  return jsonb_build_object(
    'decision',        v_decision,
    'reason',          v_reason,
    'access_log_id',   v_log,
    'room_id',         v_locker.room_id,
    'compartment_no',  v_locker.compartment_no,
    'instructor_name', v_instructor.full_name
  );
end $$;

-- Report what the key-return switch saw. A detected key closes the open transaction;
-- a closed compartment with no key leaves it open (the key shows as outstanding).
create function public.record_key_return(
  p_locker_id    uuid,
  p_key_detected boolean,
  p_at           timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_locker public.lockers%rowtype;
  v_open   uuid;
  v_event  uuid;
begin
  select * into v_locker from public.lockers where id = p_locker_id;
  if not found then
    raise exception 'unknown locker %', p_locker_id using errcode = 'P0002';
  end if;

  v_open := private.locker_open_access_log(p_locker_id);

  insert into public.key_return_events (tenant_id, locker_id, access_log_id, key_detected, occurred_at)
  values (v_locker.tenant_id, p_locker_id, v_open, p_key_detected, p_at)
  returning id into v_event;

  return jsonb_build_object(
    'event_id',           v_event,
    'closed_transaction', v_open is not null and p_key_detected,
    'outstanding',        v_open is not null and not p_key_detected
  );
end $$;

revoke all on function public.authorize_key_request(text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.record_key_return(uuid, boolean, timestamptz)  from public, anon, authenticated;
grant execute on function public.authorize_key_request(text, uuid, timestamptz) to service_role;
grant execute on function public.record_key_return(uuid, boolean, timestamptz)  to service_role;
