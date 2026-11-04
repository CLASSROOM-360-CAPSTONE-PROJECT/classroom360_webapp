-- =====================================================================
-- Classroom360 — step 6: classroom cameras and the presence check
--
--   1. cameras: which camera watches which room, and where its live stream is served from
--      (the parent Raspberry Pi). Only the address is stored here, never a camera password.
--   2. occupancy_events.person_count: the camera AI runs on the device that is watching (a laptop
--      or phone) and reports how many people it counted, not who they are. No faces, no footage.
--   3. report_occupancy(): how that device reports the count (administrators and deans only).
--   4. room_status_now gains person_count and presence: the verdict that combines the timetable,
--      the key locker and the camera ("key first, camera second").
--
-- Safe on top of files 1 to 8. It changes no existing data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Cameras
-- ---------------------------------------------------------------------
create table public.cameras (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  room_id     uuid not null references public.rooms(id) on delete cascade,
  label       text not null default 'Camera' check (length(btrim(label)) between 1 and 60),
  -- the parent Raspberry Pi, for example http://192.168.1.50:8889 (no path, no password)
  gateway_url text not null check (gateway_url ~ '^https?://[^/\s?#@]+$'),
  -- the stream name on the gateway, for example lrc-301
  stream_path text not null check (
    stream_path ~ '^[A-Za-z0-9_.~-]+(/[A-Za-z0-9_.~-]+)*$'
    and stream_path !~ '(^|/)\.{1,2}(/|$)'          -- no "." or ".." segments
    and length(stream_path) <= 120
  ),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (room_id, label)
);
create index cameras_room_idx on public.cameras (room_id);

create trigger cameras_updated_at before update on public.cameras
  for each row execute function public.set_updated_at();
create trigger audit_cameras after insert or update or delete on public.cameras
  for each row execute function private.audit_row_change();

alter table public.cameras enable row level security;
create policy cameras_select on public.cameras for select to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) in ('admin', 'dean'));
create policy cameras_write on public.cameras for all to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) = 'admin')
  with check (
    tenant_id = (select private.my_tenant()) and (select private.my_role()) = 'admin'
    and exists (select 1 from public.rooms r where r.id = room_id and r.tenant_id = cameras.tenant_id)
  );

grant select, insert, update, delete on public.cameras to authenticated;   -- row-level security limits who
grant all on public.cameras to service_role;

-- ---------------------------------------------------------------------
-- 2. What the camera counted
-- ---------------------------------------------------------------------
alter table public.occupancy_events
  add column if not exists person_count smallint check (person_count between 0 and 200),
  add column if not exists reported_by uuid references public.profiles(id) on delete set null;

-- ---------------------------------------------------------------------
-- 3. report_occupancy: the viewing device reports a count
--    A change (empty <-> occupied) is recorded at once; an unchanged state is recorded at most
--    once a minute, so a monitor left open all day does not fill the table. The room status
--    looks back ten minutes, so a minute is fresh enough.
-- ---------------------------------------------------------------------
create function public.report_occupancy(
  p_room_id    uuid,
  p_people     integer,
  p_confidence real default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := (select private.my_tenant());
  v_occ    boolean;
  v_last   public.occupancy_events%rowtype;
begin
  if (select private.my_role()) not in ('admin', 'dean') then
    raise exception 'only an administrator or a dean can report what the camera sees' using errcode = '42501';
  end if;
  if p_people is null or p_people < 0 or p_people > 200 then
    raise exception 'the number of people must be between 0 and 200' using errcode = '22023';
  end if;
  if p_confidence is not null and (p_confidence < 0 or p_confidence > 1) then
    raise exception 'confidence must be between 0 and 1' using errcode = '22023';
  end if;
  if not exists (select 1 from public.rooms r where r.id = p_room_id and r.tenant_id = v_tenant and r.is_active) then
    raise exception 'unknown room' using errcode = 'P0002';
  end if;

  v_occ := p_people > 0;
  select * into v_last from public.occupancy_events where room_id = p_room_id order by occurred_at desc limit 1;

  if v_last.id is not null then
    if v_last.occurred_at > now() - interval '2 seconds' then
      return jsonb_build_object('recorded', false, 'is_occupied', v_occ, 'reason', 'too soon');
    end if;
    if v_last.is_occupied = v_occ and v_last.occurred_at > now() - interval '1 minute' then
      return jsonb_build_object('recorded', false, 'is_occupied', v_occ, 'reason', 'unchanged');
    end if;
  end if;

  insert into public.occupancy_events (tenant_id, room_id, is_occupied, confidence, person_count, reported_by)
  values (v_tenant, p_room_id, v_occ, case when v_occ then p_confidence end, p_people, auth.uid());
  return jsonb_build_object('recorded', true, 'is_occupied', v_occ);
end $$;

revoke all on function public.report_occupancy(uuid, integer, real) from public, anon;
grant execute on function public.report_occupancy(uuid, integer, real) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. room_status_now: person_count and presence appended (existing columns keep their order)
--
--    presence, from the timetable, the key and the camera:
--      no_class              nothing scheduled, nobody seen
--      occupied_unscheduled  nothing scheduled, people seen
--      teacher_present       class now, key taken by the scheduled instructor, people seen
--      key_out_room_empty    class now, key taken, camera sees nobody
--      key_out_unchecked     class now, key taken, no recent camera report
--      key_with_other        class now, the key is held by someone other than the scheduled instructor
--      people_key_in_locker  class now, people seen, the key is still in the locker
--      not_started           class now, key still in the locker, nobody seen, within the grace period
--      teacher_absent        class now, key still in the locker, nobody seen, grace period over
--      camera_only_present / camera_only_empty / unchecked
--                            class now in a room that has no locker door: camera only
-- ---------------------------------------------------------------------
create or replace view public.room_status_now with (security_invoker = true) as
with ctx as (
  select t.id as tenant_id, (now() at time zone t.timezone) as local_now, t.grace_minutes
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
  req.id        as room_request_id,
  occ.person_count,
  case
    when cur.id is null and req.id is null then
      case when occ.is_occupied is true then 'occupied_unscheduled' else 'no_class' end
    when ls.key_status is null then
      case occ.is_occupied when true then 'camera_only_present' when false then 'camera_only_empty' else 'unchecked' end
    when ls.key_status <> 'available' then
      case
        when coalesce(cur.instructor_id, req.instructor_id) is not null
         and ls.instructor_id is distinct from coalesce(cur.instructor_id, req.instructor_id) then 'key_with_other'
        when occ.is_occupied is true  then 'teacher_present'
        when occ.is_occupied is false then 'key_out_room_empty'
        else 'key_out_unchecked'
      end
    else
      case
        when occ.is_occupied is true then 'people_key_in_locker'
        when ctx.local_now::time > coalesce(cur.start_time, req.start_time) + make_interval(mins => ctx.grace_minutes) then 'teacher_absent'
        else 'not_started'
      end
  end           as presence
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
  select o.is_occupied, o.occurred_at, o.person_count
    from public.occupancy_events o
   where o.room_id = r.id
     and o.occurred_at > now() - interval '10 minutes'
   order by o.occurred_at desc
   limit 1
) occ on true
where r.is_active;
