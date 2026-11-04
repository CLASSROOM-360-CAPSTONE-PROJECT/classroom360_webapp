-- =====================================================================
-- Classroom360 — step 9: notifications, and automatic capture of evaluation trials
--
--   1. notifications: a person's own inbox. The web app and the phone app show it (a bell with a number), and
--      both are told the moment a row arrives (Realtime). Rows are written only by the database itself:
--        - a new room request                          -> every administrator and dean
--        - a room request decided                      -> the instructor who asked
--        - a timetable submitted for approval          -> every administrator and dean
--        - a timetable rejected, published or reopened -> the program chairs of that department
--        - a timetable published                       -> the instructors who teach in it
--        - an alert (key not returned, locker station silent, key with someone else, repeated denied taps)
--                                                      -> every administrator and dean
--      The same event is never told twice to the same person (unique per person and subject).
--   2. sweep_my_alerts() / private.sweep_all_alerts(): turn the alerts of ops_alerts() into notifications.
--      An alert has no event of its own (a key simply stays out), so something has to look. The web app and the
--      phone app ask once a minute while they are open; and when the pg_cron extension is on, the database asks
--      by itself every minute, so a silent locker is noticed even when nobody has the app open.
--   3. ops_alerts() now delegates to private.ops_alerts_for(tenant, hours), so the sweep can look at every
--      school. Same columns, same answer.
--   4. trial_candidates() / capture_trial() / dismiss_trial_candidates(): the Evaluation page lists what the
--      system just did (a card tap, a door closed, a camera report), and the administrator only says what REALLY
--      happened. The system's own answer is copied from its log, not typed, and the ground truth is never guessed.
--
-- Safe on top of files 1 to 11. It changes no existing data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The inbox
-- ---------------------------------------------------------------------
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind ~ '^[a-z_]{1,40}$'),
  severity   text not null default 'info' check (severity in ('high', 'medium', 'info')),
  title      text not null check (length(title) between 1 and 160),
  body       text not null default '' check (length(body) <= 500),
  -- a page of the web app ("/requests"); the phone app maps it to its own page
  link       text check (link is null or link ~ '^/[A-Za-z0-9/_?=&.-]*$'),
  -- what it is about, so the same thing is told once to the same person
  ref        text not null check (length(ref) between 1 and 200),
  created_at timestamptz not null default now(),
  read_at    timestamptz,
  unique (user_id, ref)
);
create index notifications_user_time_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;
create index notifications_ref_idx on public.notifications (ref);

alter table public.notifications enable row level security;
-- a person reads only their own; nobody writes directly (the functions below do)
create policy notifications_select on public.notifications for select to authenticated
  using (user_id = (select auth.uid()) and tenant_id = (select private.my_tenant()));

grant select on public.notifications to authenticated;
grant all on public.notifications to service_role;

-- when the sweeps last ran for a school (keeps a crowd of open screens from sweeping again and again)
create table public.notification_sweeps (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  last_run  timestamptz not null default now()
);
alter table public.notification_sweeps enable row level security;
grant all on public.notification_sweeps to service_role;

-- one recipient
create function private.notify_user(
  p_tenant uuid, p_user uuid, p_kind text, p_severity text, p_title text, p_body text, p_link text, p_ref text
) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if p_user is null then return 0; end if;
  insert into public.notifications (tenant_id, user_id, kind, severity, title, body, link, ref)
  select pr.tenant_id, pr.id, p_kind, p_severity, left(p_title, 160), left(coalesce(p_body, ''), 500), p_link, p_ref
    from public.profiles pr
   where pr.id = p_user and pr.tenant_id = p_tenant
  on conflict (user_id, ref) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- everyone of some roles in a school (optionally of one department), except the person who did it
create function private.notify_roles(
  p_tenant uuid, p_roles public.user_role[], p_department uuid,
  p_kind text, p_severity text, p_title text, p_body text, p_link text, p_ref text,
  p_except uuid default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  insert into public.notifications (tenant_id, user_id, kind, severity, title, body, link, ref)
  select pr.tenant_id, pr.id, p_kind, p_severity, left(p_title, 160), left(coalesce(p_body, ''), 500), p_link, p_ref
    from public.profiles pr
   where pr.tenant_id = p_tenant
     and pr.role = any (p_roles)
     and (p_department is null or pr.department_id = p_department)
     and pr.id is distinct from p_except
  on conflict (user_id, ref) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- "8:30 AM"
create function private.clock_text(p_t time) returns text
language sql immutable set search_path = '' as $$ select to_char(p_t, 'FMHH12:MI AM') $$;

-- ---- a room request arrives, and is decided -------------------------
create function private.trg_request_created() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_inst text; v_room text;
begin
  select i.full_name into v_inst from public.instructors i where i.id = new.instructor_id;
  select r.code into v_room from public.rooms r where r.id = new.room_id;
  perform private.notify_roles(
    new.tenant_id, array['admin', 'dean']::public.user_role[], null,
    'request_new', 'medium',
    'New room request: ' || coalesce(v_room, 'a room'),
    coalesce(v_inst, 'An instructor') || ' asks for ' || coalesce(v_room, 'a room') || ' on '
      || to_char(new.requested_for, 'FMDay, Mon FMDD') || ', ' || private.clock_text(new.start_time) || ' to '
      || private.clock_text(new.end_time) || '. ' || left(new.reason, 160),
    '/requests', 'request:' || new.id || ':new');
  return new;
end $$;

create trigger room_requests_notify_created after insert on public.room_requests
  for each row execute function private.trg_request_created();

create function private.trg_request_decided() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_profile uuid; v_room text;
begin
  -- whatever happens to it, the "new request" lines of the deans are no longer waiting for anything
  update public.notifications set read_at = now()
   where ref = 'request:' || new.id || ':new' and read_at is null;

  if new.status in ('approved', 'rejected') then
    select i.profile_id into v_profile from public.instructors i where i.id = new.instructor_id;
    select r.code into v_room from public.rooms r where r.id = new.room_id;
    perform private.notify_user(
      new.tenant_id, v_profile, 'request_decided',
      case new.status when 'approved' then 'info' else 'medium' end,
      case new.status when 'approved' then 'Room request approved' else 'Room request rejected' end,
      coalesce(v_room, 'The room') || ', ' || to_char(new.requested_for, 'FMDay, Mon FMDD') || ', '
        || private.clock_text(new.start_time) || ' to ' || private.clock_text(new.end_time) || '.'
        || case when new.status = 'rejected' and new.decision_note is not null then ' Reason: ' || new.decision_note else '' end,
      '/requests', 'request:' || new.id || ':decided');
  end if;
  return new;
end $$;

create trigger room_requests_notify_decided after update of status on public.room_requests
  for each row when (old.status is distinct from new.status)
  execute function private.trg_request_decided();

-- ---- a timetable moves through approval -----------------------------
-- set_schedule_status() writes one audit line per change (SCHEDULE_SUBMITTED, _RETURNED, _PUBLISHED, _DRAFT),
-- so one line is one notification, however many meetings moved.
create function private.trg_schedule_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_prog  public.programs%rowtype;
  v_term  uuid;
  v_tname text;
  v_actor text;
  v_n     text := coalesce(new.new_data ->> 'entries', '');
begin
  if new.record_id is null or new.record_id !~ '^[0-9a-fA-F-]{36}$' then return new; end if;
  select * into v_prog from public.programs p where p.id = new.record_id::uuid and p.tenant_id = new.tenant_id;
  if not found then return new; end if;
  if (new.new_data ->> 'term_id') ~ '^[0-9a-fA-F-]{36}$' then
    v_term := (new.new_data ->> 'term_id')::uuid;
    select t.name into v_tname from public.terms t where t.id = v_term;
  end if;
  select coalesce(nullif(pr.full_name, ''), pr.email, 'Someone') into v_actor from public.profiles pr where pr.id = new.actor_id;
  v_actor := coalesce(v_actor, 'Someone');

  if new.action = 'SCHEDULE_SUBMITTED' then
    perform private.notify_roles(
      new.tenant_id, array['admin', 'dean']::public.user_role[], null,
      'schedule_submitted', 'medium', 'Timetable waiting for approval: ' || v_prog.code,
      v_actor || ' submitted ' || v_prog.code || case when v_n <> '' then ' (' || v_n || ' meetings)' else '' end
        || coalesce(' for ' || v_tname, '') || '.',
      '/schedules', 'sched:' || new.id, new.actor_id);

  elsif new.action = 'SCHEDULE_RETURNED' then
    perform private.notify_roles(
      new.tenant_id, array['program_chair']::public.user_role[], v_prog.department_id,
      'schedule_decided', 'medium', 'Timetable rejected: ' || v_prog.code,
      v_actor || ' sent ' || v_prog.code || ' back.' || coalesce(' Reason: ' || nullif(btrim(new.justification), ''), ''),
      '/schedules', 'sched:' || new.id, new.actor_id);

  elsif new.action = 'SCHEDULE_DRAFT' then
    perform private.notify_roles(
      new.tenant_id, array['program_chair']::public.user_role[], v_prog.department_id,
      'schedule_decided', 'medium', 'Timetable reopened for editing: ' || v_prog.code,
      v_actor || ' reopened ' || v_prog.code || '.' || coalesce(' Reason: ' || nullif(btrim(new.justification), ''), ''),
      '/schedules', 'sched:' || new.id, new.actor_id);

  elsif new.action = 'SCHEDULE_PUBLISHED' then
    perform private.notify_roles(
      new.tenant_id, array['program_chair']::public.user_role[], v_prog.department_id,
      'schedule_decided', 'info', 'Timetable published: ' || v_prog.code,
      v_prog.code || coalesce(' for ' || v_tname, '') || ' is published. The key locker now follows it.',
      '/schedules', 'sched:' || new.id, new.actor_id);
    -- the instructors who teach in it (the ones with a login)
    insert into public.notifications (tenant_id, user_id, kind, severity, title, body, link, ref)
    select new.tenant_id, i.profile_id, 'schedule_published', 'info', 'Your timetable is published',
           'Your classes' || coalesce(' for ' || v_tname, '') || ' are ready. You can print or save them from My timetable.',
           '/timetables', 'sched:' || new.id || ':teacher'
      from public.instructors i
     where i.profile_id is not null
       and i.tenant_id = new.tenant_id
       and exists (
         select 1 from public.schedule_entries se
          where se.instructor_id = i.id and se.program_id = v_prog.id
            and (v_term is null or se.term_id = v_term) and se.status = 'published')
    on conflict (user_id, ref) do nothing;
  end if;
  return new;
end $$;

create trigger audit_logs_notify_schedule after insert on public.audit_logs
  for each row when (new.table_name = 'schedule_entries'
                     and new.action in ('SCHEDULE_SUBMITTED', 'SCHEDULE_RETURNED', 'SCHEDULE_PUBLISHED', 'SCHEDULE_DRAFT'))
  execute function private.trg_schedule_event();

-- The helpers write other people's inboxes, so no signed-in person (or visitor) may call them. The triggers do not need
-- anyone to hold EXECUTE: a trigger function is only checked when the trigger is created.
revoke all on function private.notify_user(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function private.notify_roles(uuid, public.user_role[], uuid, text, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function private.clock_text(time) from public, anon, authenticated;
revoke all on function private.trg_request_created() from public, anon, authenticated;
revoke all on function private.trg_request_decided() from public, anon, authenticated;
revoke all on function private.trg_schedule_event() from public, anon, authenticated;
grant execute on function private.notify_user(uuid, uuid, text, text, text, text, text, text) to service_role;
grant execute on function private.notify_roles(uuid, public.user_role[], uuid, text, text, text, text, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------
-- 2. Alerts become notifications
--    ops_alerts() keeps its columns and its answer; the part that looks is now a function of the school, so the
--    sweep can use it without a signed-in person.
-- ---------------------------------------------------------------------
create function private.ops_alerts_for(p_tenant uuid, p_hours integer default 24)
returns table (
  kind        text,
  severity    text,
  code        text,
  room_code   text,
  subject     text,
  occurred_at timestamptz,
  attempts    integer,
  ref         text
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant uuid := p_tenant;
  v_hours  integer := least(greatest(coalesce(p_hours, 24), 1), 168);
begin
  return query
  select x.kind, x.severity, x.code, x.room_code, x.subject, x.occurred_at, x.attempts, x.ref
  from (
    -- keys not returned
    select 'key_not_returned'::text as kind, 'high'::text as severity, null::text as code,
           ls.room_code::text as room_code, ls.holder_name::text as subject, ls.issued_at as occurred_at,
           1 as attempts, ('key:' || ls.locker_id)::text as ref
      from public.locker_status ls
     where ls.tenant_id = v_tenant and ls.key_status = 'outstanding'

    union all
    -- rooms that need a look
    select 'room_attention', case rs.presence
             when 'key_with_other' then 'high'
             when 'teacher_absent' then 'medium'
             when 'occupied_unscheduled' then 'medium'
             when 'people_key_in_locker' then 'medium'
             else 'low' end,
           rs.presence, rs.room_code::text, rs.instructor_name::text, coalesce(rs.occupancy_at, now()),
           1, 'room:' || rs.room_id
      from public.room_status_now rs
     where rs.tenant_id = v_tenant
       and rs.presence in ('occupied_unscheduled', 'key_out_room_empty', 'key_with_other',
                           'people_key_in_locker', 'teacher_absent', 'camera_only_empty')

    union all
    -- denied card taps in the window, the same card and reason counted once
    select 'denied_attempts', case a.reason
             when 'unregistered_credential' then 'high'
             when 'inactive_credential' then 'medium'
             when 'assigned_to_different_room' then 'medium'
             else 'low' end,
           a.reason, null::text,
           coalesce(max(i.full_name), a.card_uid_presented), max(a.occurred_at), count(*)::int,
           'card:' || a.card_uid_presented || ':' || a.reason
      from public.access_logs a
      left join public.instructors i on i.id = a.instructor_id
     where a.tenant_id = v_tenant
       and a.decision = 'denied'
       and a.reason <> 'key_already_issued'      -- tapping twice is not a threat
       and a.occurred_at > now() - make_interval(hours => v_hours)
     group by a.card_uid_presented, a.reason

    union all
    -- a locker station that has gone quiet, or has never reported
    select 'station_offline', case when ss.last_seen_at is null then 'medium' else 'high' end,
           case when ss.last_seen_at is null then 'never' else 'silent' end,
           null::text, ss.station_label::text, ss.last_seen_at, 1, 'station:' || ss.station_label
      from public.station_status ss
     where ss.tenant_id = v_tenant and not ss.online
  ) x
  order by case x.severity when 'high' then 0 when 'medium' then 1 else 2 end, x.occurred_at desc nulls last;
end $$;

create or replace function public.ops_alerts(p_hours integer default 24)
returns table (
  kind        text,
  severity    text,
  code        text,
  room_code   text,
  subject     text,
  occurred_at timestamptz,
  attempts    integer,
  ref         text
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce((select private.my_role())::text, '') not in ('admin', 'dean') then
    return;
  end if;
  return query select * from private.ops_alerts_for((select private.my_tenant()), p_hours);
end $$;

revoke all on function private.ops_alerts_for(uuid, integer) from public, anon, authenticated;
grant execute on function private.ops_alerts_for(uuid, integer) to service_role;

-- Which alerts are worth a message, and what it says. A room that merely needs a look (teacher late, camera
-- sees people with the key in the locker) is left on the dashboard: those come and go within a class.
-- Worth a message: a key that was not returned, a silent locker station, a key held by someone other than the
-- scheduled instructor, and the same card refused three times or more for a reason that is not "key already out".
create function private.sweep_alerts(p_tenant uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_tz    text;
  v_local text;
  v_n     integer := 0;
  a       record;
  v_title text;
  v_body  text;
  v_ref   text;
  v_kind  text;
  v_link  text;
begin
  select t.timezone, to_char(now() at time zone t.timezone, 'YYYY-MM-DD') into v_tz, v_local from public.tenants t where t.id = p_tenant;
  if v_tz is null then return 0; end if;

  for a in select * from private.ops_alerts_for(p_tenant, 24) loop
    v_title := null;
    if a.kind = 'key_not_returned' then
      v_kind := 'alert_key'; v_link := '/lockers';
      v_title := 'Key not returned: ' || coalesce(a.room_code, 'a room');
      v_body := coalesce(a.subject, 'Someone') || ' took the key at ' || private.clock_text((a.occurred_at at time zone v_tz)::time)
                || ' and the class has ended.';
      v_ref := 'alert:' || a.ref || ':' || extract(epoch from a.occurred_at)::bigint;

    elsif a.kind = 'station_offline' then
      v_kind := 'alert_station'; v_link := '/lockers';
      v_title := 'Locker station not reporting';
      v_body := coalesce(a.subject, 'The locker station')
                || case when a.occurred_at is null then ' has not reported yet.'
                        else ' last reported at ' || private.clock_text((a.occurred_at at time zone v_tz)::time) || '.' end;
      v_ref := 'alert:' || a.ref || ':' || coalesce(extract(epoch from a.occurred_at)::bigint::text, 'never');

    elsif a.kind = 'room_attention' and a.code = 'key_with_other' then
      v_kind := 'alert_room'; v_link := '/';
      v_title := 'Key held by someone else: ' || coalesce(a.room_code, 'a room');
      v_body := 'The key to ' || coalesce(a.room_code, 'the room') || ' is with a person other than '
                || coalesce(a.subject, 'the scheduled instructor') || '.';
      v_ref := 'alert:' || a.ref || ':' || a.code || ':' || v_local;

    elsif a.kind = 'denied_attempts' and a.attempts >= 3 and a.code in ('unregistered_credential', 'inactive_credential', 'assigned_to_different_room') then
      v_kind := 'alert_denied'; v_link := '/lockers';
      v_title := 'Repeated denied card taps';
      v_body := a.attempts || ' taps by ' || coalesce(a.subject, 'a card') || ': '
                || case a.code when 'unregistered_credential' then 'card not registered'
                               when 'inactive_credential' then 'card deactivated'
                               else 'scheduled in a different room' end || '.';
      v_ref := 'alert:' || a.ref || ':' || v_local;
    end if;

    if v_title is not null then
      v_n := v_n + private.notify_roles(p_tenant, array['admin', 'dean']::public.user_role[], null,
                                        v_kind, a.severity, v_title, v_body, v_link, v_ref);
    end if;
  end loop;

  -- keep the inbox small: read lines after 30 days, anything after 90
  delete from public.notifications n
   where n.tenant_id = p_tenant
     and (n.created_at < now() - interval '90 days' or (n.read_at is not null and n.read_at < now() - interval '30 days'));
  return v_n;
end $$;

revoke all on function private.sweep_alerts(uuid) from public, anon, authenticated;
grant execute on function private.sweep_alerts(uuid) to service_role;

-- every school (what the minute timer runs)
create function private.sweep_all_alerts() returns integer
language plpgsql security definer set search_path = '' as $$
declare v_t uuid; v_n integer := 0;
begin
  for v_t in select t.id from public.tenants t loop
    v_n := v_n + private.sweep_alerts(v_t);
  end loop;
  return v_n;
end $$;
revoke all on function private.sweep_all_alerts() from public, anon, authenticated;
grant execute on function private.sweep_all_alerts() to service_role;

-- an open web or phone screen asks for a sweep; at most one in 20 seconds runs per school
create function public.sweep_my_alerts() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := (select private.my_tenant());
  v_go     integer;
begin
  if coalesce((select private.my_role())::text, '') not in ('admin', 'dean') or v_tenant is null then
    return 0;
  end if;
  insert into public.notification_sweeps as s (tenant_id, last_run) values (v_tenant, now())
  on conflict (tenant_id) do update set last_run = now() where s.last_run < now() - interval '20 seconds'
  returning 1 into v_go;
  if v_go is null then return 0; end if;
  return private.sweep_alerts(v_tenant);
end $$;

revoke all on function public.sweep_my_alerts() from public, anon;
grant execute on function public.sweep_my_alerts() to authenticated, service_role;

-- a person marks their own lines read (none given = all of them)
create function public.mark_notifications_read(p_ids uuid[] default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if (select auth.uid()) is null then return 0; end if;
  update public.notifications n set read_at = now()
   where n.user_id = (select auth.uid()) and n.read_at is null and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated, service_role;

-- both apps listen for new lines as they arrive; row-level security still applies, so each person is told only of their own
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- The minute timer. It needs the pg_cron extension (Supabase: Database > Extensions > pg_cron). Without it everything
-- still works while a web or phone screen is open; with it a silent locker is noticed even when nobody is looking.
-- If pg_cron is off when this file runs, turn it on and run:   select private.schedule_alert_sweep();
create function private.schedule_alert_sweep() returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
    exception when others then
      return 'pg_cron is not turned on (' || sqlerrm || '). Alerts become messages while a web or phone screen is open. '
             || 'To have the database check every minute, turn on pg_cron (Database > Extensions) and run: select private.schedule_alert_sweep();';
    end;
  end if;
  begin
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'classroom360-alert-sweep';
    perform cron.schedule('classroom360-alert-sweep', '* * * * *', 'select private.sweep_all_alerts()');
    return 'scheduled: the database checks the alerts every minute';
  exception when others then
    return 'could not schedule the alert check: ' || sqlerrm;
  end;
end $$;
revoke all on function private.schedule_alert_sweep() from public, anon, authenticated;
grant execute on function private.schedule_alert_sweep() to service_role;

do $$ begin raise notice '%', private.schedule_alert_sweep(); end $$;

-- ---------------------------------------------------------------------
-- 3. Evaluation trials, captured from what the system did
-- ---------------------------------------------------------------------
alter table public.test_trials
  add column if not exists key_return_event_id uuid references public.key_return_events(id) on delete set null,
  add column if not exists occupancy_event_id  uuid references public.occupancy_events(id) on delete set null;
create unique index test_trials_key_event_uq on public.test_trials (key_return_event_id) where key_return_event_id is not null;
create unique index test_trials_occ_event_uq on public.test_trials (occupancy_event_id) where occupancy_event_id is not null;

-- what an administrator chose to leave out of the list ("that was not a test")
create table public.trial_dismissals (
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  subsystem    public.trial_subsystem not null,
  source_id    uuid not null,
  dismissed_by uuid references public.profiles(id) on delete set null default auth.uid(),
  dismissed_at timestamptz not null default now(),
  primary key (tenant_id, subsystem, source_id)
);
alter table public.trial_dismissals enable row level security;
grant all on public.trial_dismissals to service_role;

-- What the system did lately and nobody has judged yet: card taps, door closings and camera reports of the last
-- hours, newest first, up to 30 of each. For the camera only the latest report of each room is offered (a monitor left
-- open reports every minute). The system's answer is shown, and the person says what really happened.
create function public.trial_candidates(p_hours integer default 6)
returns table (
  subsystem   text,
  source_id   uuid,
  occurred_at timestamptz,
  room_code   text,
  door        smallint,
  system_says boolean,
  subject     text,
  reason      text,
  people      integer,
  latency_ms  integer
)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tenant uuid := (select private.my_tenant());
  v_hours  integer := least(greatest(coalesce(p_hours, 6), 1), 72);
begin
  if coalesce((select private.my_role())::text, '') <> 'admin' then
    return;
  end if;

  return query
  select z.subsystem, z.source_id, z.occurred_at, z.room_code, z.door, z.system_says, z.subject, z.reason, z.people, z.latency_ms
  from (
    (select 'rfid'::text as subsystem, a.id as source_id, a.occurred_at as occurred_at,
            (case when a.decision = 'granted' then r.code end)::text as room_code,
            (case when a.decision = 'granted' then l.compartment_no end)::smallint as door,
            (a.decision = 'granted') as system_says,
            coalesce(i.full_name, a.card_uid_presented)::text as subject,
            a.reason::text as reason, null::integer as people, a.latency_ms as latency_ms
       from public.access_logs a
       join public.lockers l on l.id = a.locker_id
       join public.rooms r on r.id = l.room_id
       left join public.instructors i on i.id = a.instructor_id
      where a.tenant_id = v_tenant
        and a.occurred_at > now() - make_interval(hours => v_hours)
        and not exists (select 1 from public.test_trials tt where tt.access_log_id = a.id)
        and not exists (select 1 from public.trial_dismissals d where d.tenant_id = v_tenant and d.subsystem = 'rfid' and d.source_id = a.id)
      order by a.occurred_at desc
      limit 30)
    union all
    (select 'key_return'::text, k.id, k.occurred_at, r.code::text, l.compartment_no::smallint, k.key_detected,
            coalesce(i.full_name, '')::text, null::text, null::integer, null::integer
       from public.key_return_events k
       join public.lockers l on l.id = k.locker_id
       join public.rooms r on r.id = l.room_id
       left join public.access_logs a on a.id = k.access_log_id
       left join public.instructors i on i.id = a.instructor_id
      where k.tenant_id = v_tenant
        and k.occurred_at > now() - make_interval(hours => v_hours)
        and not exists (select 1 from public.test_trials tt where tt.key_return_event_id = k.id)
        and not exists (select 1 from public.trial_dismissals d where d.tenant_id = v_tenant and d.subsystem = 'key_return' and d.source_id = k.id)
      order by k.occurred_at desc
      limit 30)
    union all
    (select 'cctv'::text, o.id, o.occurred_at, r.code::text, null::smallint, o.is_occupied,
            ''::text, null::text, o.person_count::integer, null::integer
       from (select distinct on (e.room_id) e.*
               from public.occupancy_events e
              where e.tenant_id = v_tenant and e.occurred_at > now() - make_interval(hours => v_hours)
              order by e.room_id, e.occurred_at desc) o
       join public.rooms r on r.id = o.room_id
      where not exists (select 1 from public.test_trials tt where tt.occupancy_event_id = o.id)
        and not exists (select 1 from public.trial_dismissals d where d.tenant_id = v_tenant and d.subsystem = 'cctv' and d.source_id = o.id)
      order by o.occurred_at desc
      limit 30)
  ) z
  order by z.occurred_at desc;
end $$;

-- Turn one of those into a trial: the system's answer and its time come from the log; the person gives the condition
-- (what was really done) and, through it, the ground truth.
create function public.capture_trial(
  p_subsystem public.trial_subsystem,
  p_source_id uuid,
  p_condition text,
  p_observer  text default '',
  p_notes     text default ''
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := (select private.my_tenant());
  v_res    jsonb;
  k        record;
  o        record;
begin
  if (select private.my_role()) is distinct from 'admin' then
    raise exception 'only an administrator can record a trial' using errcode = '42501';
  end if;

  if p_subsystem = 'rfid' then
    -- the existing link: the answer is the log line's decision, the time its latency
    select a.occurred_at into o from public.access_logs a where a.id = p_source_id and a.tenant_id = v_tenant;
    if not found then
      raise exception 'that locker log line was not found' using errcode = 'P0002';
    end if;
    return public.record_test_trial('rfid', p_condition, null, '', null, p_source_id, p_observer, p_notes, o.occurred_at);

  elsif p_subsystem = 'key_return' then
    select e.id, e.key_detected, e.occurred_at, r.code as room_code, l.compartment_no as door
      into k
      from public.key_return_events e
      join public.lockers l on l.id = e.locker_id
      join public.rooms r on r.id = l.room_id
     where e.id = p_source_id and e.tenant_id = v_tenant;
    if not found then
      raise exception 'that door closing was not found' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.test_trials tt where tt.key_return_event_id = k.id) then
      raise exception 'that door closing is already used by another trial' using errcode = '23505';
    end if;
    v_res := public.record_test_trial('key_return', p_condition, k.key_detected,
                                      'Door ' || k.door || ', ' || k.room_code, null, null, p_observer, p_notes, k.occurred_at);
    update public.test_trials set key_return_event_id = k.id where id = (v_res ->> 'id')::uuid;
    return v_res;

  else
    select e.id, e.is_occupied, e.person_count, e.occurred_at, r.code as room_code
      into o
      from public.occupancy_events e
      join public.rooms r on r.id = e.room_id
     where e.id = p_source_id and e.tenant_id = v_tenant;
    if not found then
      raise exception 'that camera report was not found' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.test_trials tt where tt.occupancy_event_id = o.id) then
      raise exception 'that camera report is already used by another trial' using errcode = '23505';
    end if;
    v_res := public.record_test_trial('cctv', p_condition, o.is_occupied,
                                      o.room_code || case when o.person_count is not null then ', ' || o.person_count || ' counted' else '' end,
                                      null, null, p_observer, p_notes, o.occurred_at);
    update public.test_trials set occupancy_event_id = o.id where id = (v_res ->> 'id')::uuid;
    return v_res;
  end if;
end $$;

-- "that was not a test": take lines off the list
create function public.dismiss_trial_candidates(p_subsystem public.trial_subsystem, p_source_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := (select private.my_tenant());
  v_n      integer;
begin
  if (select private.my_role()) is distinct from 'admin' then
    raise exception 'only an administrator can do this' using errcode = '42501';
  end if;
  if p_source_ids is null or cardinality(p_source_ids) = 0 then return 0; end if;
  if cardinality(p_source_ids) > 200 then
    raise exception 'too many lines at once' using errcode = '22023';
  end if;
  insert into public.trial_dismissals (tenant_id, subsystem, source_id)
  select v_tenant, p_subsystem, x
    from unnest(p_source_ids) as x
   where case p_subsystem
           when 'rfid'       then exists (select 1 from public.access_logs a where a.id = x and a.tenant_id = v_tenant)
           when 'key_return' then exists (select 1 from public.key_return_events e where e.id = x and e.tenant_id = v_tenant)
           else                   exists (select 1 from public.occupancy_events e where e.id = x and e.tenant_id = v_tenant)
         end
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.trial_candidates(integer) from public, anon;
revoke all on function public.capture_trial(public.trial_subsystem, uuid, text, text, text) from public, anon;
revoke all on function public.dismiss_trial_candidates(public.trial_subsystem, uuid[]) from public, anon;
grant execute on function public.trial_candidates(integer) to authenticated, service_role;
grant execute on function public.capture_trial(public.trial_subsystem, uuid, text, text, text) to authenticated, service_role;
grant execute on function public.dismiss_trial_candidates(public.trial_subsystem, uuid[]) to authenticated, service_role;
