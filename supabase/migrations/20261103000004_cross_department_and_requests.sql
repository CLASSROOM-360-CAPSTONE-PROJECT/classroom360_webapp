-- =====================================================================
-- Classroom360 — cross-department scheduling support and teacher room requests
--   1. Departments can be archived (never deleted) and changes to them are audited
--   2. schedule_busy():        what is already booked, across every department, without the details
--   3. schedule_review_note(): why a dean returned (rejected) a program's schedule
--   4. room_requests:          an instructor asks for a free room; the dean or an administrator decides
--   5. The locker honours an approved request, and the status views know about it
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Departments: archive instead of delete (a delete would cascade to every schedule below it)
-- ---------------------------------------------------------------------
alter table public.departments add column if not exists is_active boolean not null default true;

create trigger audit_departments after insert or update or delete on public.departments
  for each row execute function private.audit_row_change();
create trigger audit_programs after insert or update or delete on public.programs
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------
-- 2. Cross-department visibility
-- Row-level security hides other departments' schedules from a program chair, yet the database
-- refuses any clash with them. This function shows planners what is taken (room, instructor,
-- student block, time and owning department) so the editor can warn before a save fails.
-- It leaves out course names and instructor names.
-- ---------------------------------------------------------------------
create function public.schedule_busy(p_term_id uuid)
returns table (
  entry_id        uuid,
  room_id         uuid,
  instructor_id   uuid,
  cohort_key      text,
  department_id   uuid,
  department_code text,
  day_of_week     smallint,
  start_time      time,
  end_time        time,
  status          public.schedule_status
)
language sql stable security definer set search_path = '' as $$
  select se.id, se.room_id, se.instructor_id, se.cohort_key, d.id, d.code,
         se.day_of_week, se.start_time, se.end_time, se.status
    from public.schedule_entries se
    left join public.programs    p on p.id = se.program_id
    left join public.departments d on d.id = p.department_id
   where se.tenant_id = private.my_tenant()
     and se.term_id   = p_term_id
     and se.status   <> 'returned'
     and private.my_role() in ('admin', 'dean', 'program_chair')
$$;

-- ---------------------------------------------------------------------
-- 3. The dean's latest decision on a program's schedule and the note that came with it (read by the chair)
-- ---------------------------------------------------------------------
create function public.schedule_review_note(p_term_id uuid, p_program_id uuid)
returns table (action text, note text, actor_name text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select a.action, a.justification, coalesce(nullif(pr.full_name, ''), pr.email), a.created_at
    from public.audit_logs a
    left join public.profiles pr on pr.id = a.actor_id
   where a.tenant_id  = private.my_tenant()
     and a.table_name = 'schedule_entries'
     and a.action in ('SCHEDULE_RETURNED', 'SCHEDULE_APPROVED', 'SCHEDULE_PUBLISHED')
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
-- 4. Room requests
-- ---------------------------------------------------------------------
create type public.request_status as enum ('pending', 'approved', 'rejected', 'cancelled');

create table public.room_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  instructor_id uuid not null references public.instructors(id) on delete cascade,
  room_id       uuid not null references public.rooms(id) on delete cascade,
  requested_for date not null,
  start_time    time not null,
  end_time      time not null,
  reason        text not null check (btrim(reason) <> ''),
  status        public.request_status not null default 'pending',
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),
  check (end_time > start_time),

  -- two approved requests can never hold the same room, or the same instructor, at once
  constraint no_room_double_request
    exclude using gist (
      tenant_id with =, room_id with =,
      tsrange(requested_for + start_time, requested_for + end_time) with &&
    ) where (status = 'approved'),
  constraint no_instructor_double_request
    exclude using gist (
      tenant_id with =, instructor_id with =,
      tsrange(requested_for + start_time, requested_for + end_time) with &&
    ) where (status = 'approved')
);
create index room_requests_lookup_idx on public.room_requests (tenant_id, status, requested_for);

-- Is the room free on that date and time? Classes that are submitted, approved or published
-- count; so do approved requests. (Drafts are provisional and do not block a request.)
create function private.room_is_free(
  p_tenant uuid, p_room uuid, p_date date, p_start time, p_end time, p_ignore_request uuid default null
) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1
      from public.schedule_entries se
      join public.terms t on t.id = se.term_id
     where se.tenant_id   = p_tenant
       and se.room_id     = p_room
       and se.status      in ('submitted', 'approved', 'published')
       and se.day_of_week = extract(isodow from p_date)::int
       and p_date between t.starts_on and t.ends_on
       and se.start_time < p_end and se.end_time > p_start
  ) and not exists (
    select 1
      from public.room_requests rr
     where rr.tenant_id     = p_tenant
       and rr.room_id       = p_room
       and rr.status        = 'approved'
       and rr.requested_for = p_date
       and rr.start_time < p_end and rr.end_time > p_start
       and rr.id is distinct from p_ignore_request
  )
$$;

-- Rooms that are free on a date and time (what the request form offers an instructor).
create function public.free_rooms(p_date date, p_start time, p_end time)
returns table (room_id uuid, code text, name text, floor smallint, capacity integer)
language sql stable security definer set search_path = '' as $$
  select r.id, r.code, r.name, r.floor, r.capacity
    from public.rooms r
   where r.tenant_id = private.my_tenant()
     and r.is_active
     and p_start < p_end
     and private.room_is_free(r.tenant_id, r.id, p_date, p_start, p_end, null)
   order by r.code
$$;

create function public.create_room_request(
  p_room_id uuid, p_date date, p_start time, p_end time, p_reason text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := private.my_tenant();
  v_inst   uuid := private.my_instructor();
  v_t      public.tenants%rowtype;
  v_id     uuid;
begin
  if v_inst is null then
    raise exception 'only instructors can request a room' using errcode = '42501';
  end if;
  select * into v_t from public.tenants where id = v_tenant;

  if p_end <= p_start then
    raise exception 'the end time must be after the start time' using errcode = '22023';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then
    raise exception 'please give a reason for the request' using errcode = '22023';
  end if;
  if (p_date + p_end) <= (now() at time zone v_t.timezone) then
    raise exception 'that time has already passed' using errcode = '22023';
  end if;
  if p_start < v_t.operating_start or p_end > v_t.operating_end then
    raise exception 'requests must fall within operating hours (% to %)',
      to_char(v_t.operating_start, 'HH24:MI'), to_char(v_t.operating_end, 'HH24:MI') using errcode = '22023';
  end if;
  if not exists (select 1 from public.rooms where id = p_room_id and tenant_id = v_tenant and is_active) then
    raise exception 'room not found' using errcode = 'P0002';
  end if;
  if not private.room_is_free(v_tenant, p_room_id, p_date, p_start, p_end, null) then
    raise exception 'that room is not free at that time';
  end if;
  if exists (
    select 1
      from public.schedule_entries se
      join public.terms t on t.id = se.term_id
     where se.tenant_id = v_tenant and se.instructor_id = v_inst
       and se.status in ('submitted', 'approved', 'published')
       and se.day_of_week = extract(isodow from p_date)::int
       and p_date between t.starts_on and t.ends_on
       and se.start_time < p_end and se.end_time > p_start
  ) or exists (
    select 1
      from public.room_requests rr
     where rr.tenant_id = v_tenant and rr.instructor_id = v_inst
       and rr.status in ('pending', 'approved')
       and rr.requested_for = p_date
       and rr.start_time < p_end and rr.end_time > p_start
  ) then
    raise exception 'you already have a class or a request at that time';
  end if;

  insert into public.room_requests (tenant_id, instructor_id, room_id, requested_for, start_time, end_time, reason)
  values (v_tenant, v_inst, p_room_id, p_date, p_start, p_end, btrim(p_reason))
  returning id into v_id;
  return v_id;
end $$;

-- Dean or administrator accepts or rejects. Rejecting needs a note.
create function public.decide_room_request(p_request_id uuid, p_approve boolean, p_note text default null)
returns public.room_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := private.my_tenant();
  v_t      public.tenants%rowtype;
  r        public.room_requests%rowtype;
begin
  if private.my_role() is null or private.my_role() not in ('admin', 'dean') then
    raise exception 'only a dean or administrator can decide a request' using errcode = '42501';
  end if;

  select * into r from public.room_requests where id = p_request_id and tenant_id = v_tenant for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if r.status <> 'pending' then
    raise exception 'this request is already %', r.status using errcode = '22023';
  end if;
  if not p_approve and btrim(coalesce(p_note, '')) = '' then
    raise exception 'a note is required when rejecting a request' using errcode = '22023';
  end if;

  if p_approve then
    select * into v_t from public.tenants where id = v_tenant;
    if (r.requested_for + r.end_time) <= (now() at time zone v_t.timezone) then
      raise exception 'that time has already passed' using errcode = '22023';
    end if;
    if not private.room_is_free(r.tenant_id, r.room_id, r.requested_for, r.start_time, r.end_time, r.id) then
      raise exception 'the room is no longer free at that time';
    end if;
  end if;

  update public.room_requests
     set status        = case when p_approve then 'approved'::public.request_status else 'rejected'::public.request_status end,
         decided_by    = auth.uid(),
         decided_at    = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = r.id
   returning * into r;

  insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, new_data, justification)
  values (
    v_tenant, auth.uid(),
    case when p_approve then 'REQUEST_APPROVED' else 'REQUEST_REJECTED' end,
    'room_requests', r.id::text,
    jsonb_build_object('room_id', r.room_id, 'instructor_id', r.instructor_id, 'requested_for', r.requested_for,
                       'start_time', r.start_time, 'end_time', r.end_time),
    r.decision_note
  );
  return r;
end $$;

-- An instructor withdraws their own request, up to its start time.
create function public.cancel_room_request(p_request_id uuid)
returns public.room_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := private.my_tenant();
  v_t      public.tenants%rowtype;
  r        public.room_requests%rowtype;
begin
  select * into r
    from public.room_requests
   where id = p_request_id and tenant_id = v_tenant and instructor_id = private.my_instructor()
   for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if r.status not in ('pending', 'approved') then
    raise exception 'this request is already %', r.status using errcode = '22023';
  end if;
  select * into v_t from public.tenants where id = v_tenant;
  if (r.requested_for + r.start_time) <= (now() at time zone v_t.timezone) then
    raise exception 'that request has already started' using errcode = '22023';
  end if;

  update public.room_requests set status = 'cancelled' where id = r.id returning * into r;
  insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, new_data)
  values (v_tenant, auth.uid(), 'REQUEST_CANCELLED', 'room_requests', r.id::text,
          jsonb_build_object('room_id', r.room_id, 'requested_for', r.requested_for));
  return r;
end $$;

alter table public.room_requests enable row level security;
create policy room_requests_select on public.room_requests for select to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or instructor_id = (select private.my_instructor())
    )
  );

-- Requests are created and decided only through the functions above.
revoke all on public.room_requests from public, anon, authenticated;
grant select on public.room_requests to authenticated;
grant all on public.room_requests to service_role;

revoke all on function private.room_is_free(uuid, uuid, date, time, time, uuid) from public, anon;
grant execute on function private.room_is_free(uuid, uuid, date, time, time, uuid) to authenticated, service_role;

do $$
declare f text;
begin
  foreach f in array array[
    'public.schedule_busy(uuid)',
    'public.schedule_review_note(uuid, uuid)',
    'public.free_rooms(date, time, time)',
    'public.create_room_request(uuid, date, time, time, text)',
    'public.decide_room_request(uuid, boolean, text)',
    'public.cancel_room_request(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.room_requests;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. The locker and the status views honour an approved request
-- ---------------------------------------------------------------------
alter table public.access_logs
  add column if not exists room_request_id uuid references public.room_requests(id) on delete set null;

create or replace view public.locker_status with (security_invoker = true) as
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
         ((tx.occurred_at at time zone t.timezone)::date + coalesce(se.end_time, rq.end_time, time '23:59'))
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
left join public.room_requests    rq on rq.id = tx.room_request_id
left join public.instructors      i  on i.id  = tx.instructor_id
where l.is_active;

create or replace view public.room_status_now with (security_invoker = true) as
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
  coalesce(cur.start_time, req.start_time) as start_time,
  coalesce(cur.end_time,   req.end_time)   as end_time,
  coalesce(i.full_name, ri.full_name)      as instructor_name,
  case when cur.id is null and req.id is not null then 'Room request' else c.code end as course_code,
  s.code        as section_code,
  ls.key_status,
  occ.is_occupied,
  occ.occurred_at as occupancy_at,
  case
    when (cur.id is not null or req.id is not null) and occ.is_occupied is false then 'scheduled_but_empty'
    when cur.id is null and req.id is null and occ.is_occupied is true          then 'occupied_not_scheduled'
  end           as discrepancy,
  req.id        as room_request_id
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
left join lateral (
  select rr.*
    from public.room_requests rr
   where rr.room_id = r.id
     and rr.status = 'approved'
     and rr.requested_for = ctx.local_now::date
     and ctx.local_now::time between rr.start_time and rr.end_time
   limit 1
) req on true
left join public.sections    s on s.id = cur.section_id
left join public.courses     c on c.id = s.course_id
left join public.instructors i  on i.id  = cur.instructor_id
left join public.instructors ri on ri.id = req.instructor_id
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

create or replace function public.authorize_key_request(
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
  v_req        public.room_requests%rowtype;
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
    else
      -- or the dean/administrator approved a one-off request for this room, now
      select rr.* into v_req
        from public.room_requests rr
       where rr.tenant_id     = v_locker.tenant_id
         and rr.status        = 'approved'
         and rr.instructor_id = v_card.instructor_id
         and rr.room_id       = v_locker.room_id
         and rr.requested_for = v_local::date
         and v_time between rr.start_time - v_grace and rr.end_time + v_grace
       limit 1;

      if found then
        if private.locker_open_access_log(v_locker.id) is not null then
          v_reason := 'key_already_issued';
        else
          v_decision := 'granted';
          v_reason   := 'approved_request';
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
  end if;

  insert into public.access_logs
    (tenant_id, locker_id, card_uid_presented, instructor_id, schedule_entry_id, room_request_id, decision, reason, occurred_at)
  values
    (v_locker.tenant_id, v_locker.id, p_card_uid, v_card.instructor_id, v_entry.id, v_req.id, v_decision, v_reason, p_at)
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
