-- =====================================================================
-- Classroom360 — step 8: the evaluation log, alerts, locker-station health and tap latency
--
--   1. test_trials: the System Testing and Observation Log of the proposal (Appendix C, Table 2.2).
--      One row per controlled trial of the card checker, the key-return switch or the camera, with
--      the ground truth (what should have happened) next to what the system did. The cell of the
--      confusion matrix (TP, FP, TN, FN) is worked out by the database, never typed in.
--      Only an administrator writes; an administrator or dean reads.
--   2. solve_jobs.kind: a row for EVERY run of the scheduling engine ('run'), not only for the ones
--      that were saved ('saved'), so the solver statistics (runtime, feasible share) are complete.
--      record_solve_run() is how the Generate dialog logs a run.
--   3. record_tap_latency(): the locker station reports how long a tap took (card read until the
--      station acted on the answer), for the 500 ms target of the proposal.
--   4. station_heartbeats + station_heartbeat() + station_status: the locker station says "I am
--      alive" every minute, so an offline locker is noticed.
--   5. ops_alerts(): what an administrator or dean should look at now: keys not returned, rooms that
--      need a look, repeated denied card taps and a silent locker station.
--
-- Safe on top of files 1 to 10. It changes no existing data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The trial log
-- ---------------------------------------------------------------------
create type public.trial_subsystem as enum ('rfid', 'key_return', 'cctv');

create table public.test_trials (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  subsystem         public.trial_subsystem not null,
  -- 1, 2, 3 ... within the school and subsystem; shown as RFID-001, KEY-001, CCTV-001
  seq               integer not null check (seq > 0),
  -- the test conditions of Table 2.2 (see the check below)
  condition         text not null,
  input_presented   text not null default '' check (length(input_presented) <= 200),
  -- ground truth: should the system have said "yes" (grant / key returned / class in session)?
  expected_positive boolean not null,
  -- what the system actually said
  actual_positive   boolean not null,
  -- the confusion-matrix cell, worked out here so it cannot be mistyped
  result            text generated always as (
                      case
                        when expected_positive and actual_positive         then 'TP'
                        when not expected_positive and actual_positive     then 'FP'
                        when not expected_positive and not actual_positive then 'TN'
                        else 'FN'
                      end
                    ) stored,
  latency_ms        integer check (latency_ms between 0 and 60000),
  -- optional link to the real locker log line the trial was read from
  access_log_id     uuid references public.access_logs(id) on delete set null,
  observer          text not null default '' check (length(observer) <= 100),
  notes             text not null default '' check (length(notes) <= 500),
  occurred_at       timestamptz not null default now(),
  recorded_by       uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  unique (tenant_id, subsystem, seq),
  constraint test_trials_condition_ok check (
    (subsystem = 'rfid'       and condition in ('authorized_in_time', 'authorized_outside_time', 'different_room', 'invalid_credential'))
    or (subsystem = 'key_return' and condition in ('key_returned', 'closed_without_key'))
    or (subsystem = 'cctv'       and condition in ('class_in_session', 'room_vacant'))
  ),
  -- the ground truth follows from the condition: only these three are "should say yes"
  constraint test_trials_expected_ok check (
    expected_positive = (condition in ('authorized_in_time', 'key_returned', 'class_in_session'))
  )
);
create unique index test_trials_access_log_uq on public.test_trials (access_log_id) where access_log_id is not null;
create index test_trials_time_idx on public.test_trials (tenant_id, subsystem, occurred_at desc);

alter table public.test_trials enable row level security;
create policy test_trials_select on public.test_trials for select to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) in ('admin', 'dean'));
-- no insert, update or delete policy: the log is written only through the functions below

grant select on public.test_trials to authenticated;
grant all on public.test_trials to service_role;

create function public.record_test_trial(
  p_subsystem       public.trial_subsystem,
  p_condition       text,
  p_actual_positive boolean     default null,
  p_input           text        default '',
  p_latency_ms      integer     default null,
  p_access_log_id   uuid        default null,
  p_observer        text        default '',
  p_notes           text        default '',
  p_at              timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant  uuid := (select private.my_tenant());
  v_actual  boolean := p_actual_positive;
  v_input   text := coalesce(btrim(p_input), '');
  v_latency integer := p_latency_ms;
  v_log     public.access_logs%rowtype;
  v_expect  boolean;
  v_seq     integer;
  v_id      uuid;
begin
  if (select private.my_role()) is distinct from 'admin' then
    raise exception 'only an administrator can record a trial' using errcode = '42501';
  end if;
  if p_condition is null
     or not (
       (p_subsystem = 'rfid'       and p_condition in ('authorized_in_time', 'authorized_outside_time', 'different_room', 'invalid_credential'))
       or (p_subsystem = 'key_return' and p_condition in ('key_returned', 'closed_without_key'))
       or (p_subsystem = 'cctv'       and p_condition in ('class_in_session', 'room_vacant'))
     ) then
    raise exception 'the test condition "%" does not belong to the % subsystem', coalesce(p_condition, ''), p_subsystem using errcode = '22023';
  end if;
  v_expect := p_condition in ('authorized_in_time', 'key_returned', 'class_in_session');

  if p_access_log_id is not null then
    if p_subsystem <> 'rfid' then
      raise exception 'only a card trial can be linked to a locker log line' using errcode = '22023';
    end if;
    select * into v_log from public.access_logs where id = p_access_log_id and tenant_id = v_tenant;
    if not found then
      raise exception 'that locker log line was not found' using errcode = 'P0002';
    end if;
    if exists (select 1 from public.test_trials where access_log_id = p_access_log_id) then
      raise exception 'that locker log line is already used by another trial' using errcode = '23505';
    end if;
    -- the log says what the system did; a typed answer that disagrees is a mistake, not a choice
    if v_actual is not null and v_actual is distinct from (v_log.decision = 'granted') then
      raise exception 'the answer you gave does not match the locker log line (it says %)', v_log.decision using errcode = '22023';
    end if;
    v_actual := (v_log.decision = 'granted');
    if v_input = '' then v_input := v_log.card_uid_presented; end if;
    v_latency := coalesce(v_latency, v_log.latency_ms);
  end if;

  if v_actual is null then
    raise exception 'say what the system did (yes or no)' using errcode = '22023';
  end if;
  if v_latency is not null and (v_latency < 0 or v_latency > 60000) then
    raise exception 'the response time must be between 0 and 60000 ms' using errcode = '22023';
  end if;
  if length(v_input) > 200 or length(coalesce(p_observer, '')) > 100 or length(coalesce(p_notes, '')) > 500 then
    raise exception 'the input, observer or note is too long' using errcode = '22023';
  end if;
  if p_at is not null and p_at > now() + interval '5 minutes' then
    raise exception 'a trial cannot happen in the future' using errcode = '22023';
  end if;

  -- one writer at a time per school and subsystem, so two people get different numbers
  perform pg_advisory_xact_lock(hashtextextended(v_tenant::text || ':' || p_subsystem::text, 0));
  select coalesce(max(t.seq), 0) + 1 into v_seq
    from public.test_trials t where t.tenant_id = v_tenant and t.subsystem = p_subsystem;

  insert into public.test_trials (tenant_id, subsystem, seq, condition, input_presented, expected_positive,
                                  actual_positive, latency_ms, access_log_id, observer, notes, occurred_at)
  values (v_tenant, p_subsystem, v_seq, p_condition, v_input, v_expect, v_actual, v_latency, p_access_log_id,
          btrim(coalesce(p_observer, '')), btrim(coalesce(p_notes, '')), coalesce(p_at, now()))
  returning id into v_id;

  return jsonb_build_object(
    'id', v_id, 'seq', v_seq,
    'code', (case p_subsystem when 'rfid' then 'RFID' when 'key_return' then 'KEY' else 'CCTV' end) || '-' || lpad(v_seq::text, 3, '0'),
    'result', (select t.result from public.test_trials t where t.id = v_id)
  );
end $$;

create function public.delete_test_trial(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := (select private.my_tenant());
  t public.test_trials%rowtype;
begin
  if (select private.my_role()) is distinct from 'admin' then
    raise exception 'only an administrator can delete a trial' using errcode = '42501';
  end if;
  select * into t from public.test_trials where id = p_id and tenant_id = v_tenant;
  if not found then
    raise exception 'that trial was not found' using errcode = 'P0002';
  end if;
  delete from public.test_trials where id = p_id;
  -- the numbers of the other trials stay as they are, so a printed log still matches
  insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, old_data)
  values (v_tenant, auth.uid(), 'TRIAL_DELETED', 'test_trials', p_id::text,
          jsonb_build_object('subsystem', t.subsystem, 'seq', t.seq, 'condition', t.condition,
                             'expected_positive', t.expected_positive, 'actual_positive', t.actual_positive,
                             'result', t.result, 'latency_ms', t.latency_ms, 'occurred_at', t.occurred_at));
end $$;

revoke all on function public.record_test_trial(public.trial_subsystem, text, boolean, text, integer, uuid, text, text, timestamptz) from public, anon;
revoke all on function public.delete_test_trial(uuid) from public, anon;
grant execute on function public.record_test_trial(public.trial_subsystem, text, boolean, text, integer, uuid, text, text, timestamptz) to authenticated, service_role;
grant execute on function public.delete_test_trial(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. Every run of the scheduling engine, saved or not
-- ---------------------------------------------------------------------
alter table public.solve_jobs
  add column if not exists kind text not null default 'saved' check (kind in ('saved', 'run'));
-- 'saved' = written when a generated plan is saved (what the earlier steps already did)
-- 'run'   = written by record_solve_run() each time the engine finishes, saved or not

create function public.record_solve_run(
  p_term_id         uuid,
  p_program_ids     uuid[],
  p_status          public.solve_status,
  p_runtime_ms      integer,
  p_hard_violations integer,
  p_soft_penalty    numeric default null,
  p_message         text    default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid := (select private.my_tenant());
  v_prog   uuid;
  v_id     uuid;
begin
  if (select private.my_role()) not in ('admin', 'dean', 'program_chair') then
    raise exception 'only planners can record a scheduling run' using errcode = '42501';
  end if;
  if not exists (select 1 from public.terms t where t.id = p_term_id and t.tenant_id = v_tenant) then
    raise exception 'that term was not found' using errcode = 'P0002';
  end if;
  if p_status not in ('feasible', 'infeasible', 'error') then
    raise exception 'a finished run is feasible, infeasible or error' using errcode = '22023';
  end if;
  if p_runtime_ms is null or p_runtime_ms < 0 or p_runtime_ms > 86400000 then
    raise exception 'the run time must be between 0 and 86400000 ms' using errcode = '22023';
  end if;
  if p_hard_violations is null or p_hard_violations < 0 or p_hard_violations > 100000 then
    raise exception 'the number of hard-rule violations must be 0 or more' using errcode = '22023';
  end if;
  -- the same program rule as saving: a chair can only plan their own department's programs
  if p_program_ids is not null then
    foreach v_prog in array p_program_ids loop
      if not exists (select 1 from public.programs p where p.id = v_prog and p.tenant_id = v_tenant) then
        raise exception 'unknown program' using errcode = 'P0002';
      end if;
      if (select private.my_role()) = 'program_chair' and not (select private.program_in_my_department(v_prog)) then
        raise exception 'a program chair can only plan programs of their own department' using errcode = '42501';
      end if;
    end loop;
  end if;

  insert into public.solve_jobs (tenant_id, term_id, program_id, requested_by, status, runtime_ms,
                                 hard_violations, soft_penalty, message, finished_at, kind)
  values (
    v_tenant, p_term_id,
    -- one program: that program; several planned together: no single program
    case when p_program_ids is not null and cardinality(p_program_ids) = 1 then p_program_ids[1] end,
    auth.uid(), p_status, p_runtime_ms, p_hard_violations, p_soft_penalty,
    left(nullif(btrim(coalesce(p_message, '')), ''), 500), now(), 'run'
  )
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.record_solve_run(uuid, uuid[], public.solve_status, integer, integer, numeric, text) from public, anon;
grant execute on function public.record_solve_run(uuid, uuid[], public.solve_status, integer, integer, numeric, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. How long a tap took
--    The station measures from the moment the card is read until it has acted on the answer
--    (door released or denial shown) and reports it for the log line that tap wrote.
-- ---------------------------------------------------------------------
create function public.record_tap_latency(p_access_log_id uuid, p_latency_ms integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_latency_ms is null or p_latency_ms < 0 or p_latency_ms > 60000 then
    raise exception 'the response time must be between 0 and 60000 ms' using errcode = '22023';
  end if;
  -- the first report wins; a second one for the same line is ignored
  update public.access_logs set latency_ms = p_latency_ms where id = p_access_log_id and latency_ms is null;
end $$;

revoke all on function public.record_tap_latency(uuid, integer) from public, anon, authenticated;
grant execute on function public.record_tap_latency(uuid, integer) to service_role;

-- ---------------------------------------------------------------------
-- 4. Locker-station health
-- ---------------------------------------------------------------------
create table public.station_heartbeats (
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  station_label text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  -- small facts from the station: program version, keys waiting to be sent, and so on
  info          jsonb not null default '{}' check (jsonb_typeof(info) = 'object' and length(info::text) <= 2000),
  primary key (tenant_id, station_label)
);

alter table public.station_heartbeats enable row level security;
create policy station_heartbeats_select on public.station_heartbeats for select to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) in ('admin', 'dean'));

grant select on public.station_heartbeats to authenticated;
grant all on public.station_heartbeats to service_role;

create function public.station_heartbeat(p_station_label text, p_info jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenants int;
  v_tenant  uuid;
begin
  select count(distinct l.tenant_id), (array_agg(distinct l.tenant_id))[1]
    into v_tenants, v_tenant
    from public.lockers l
   where l.station_label = p_station_label and l.is_active;
  if v_tenants = 0 then
    raise exception 'unknown or inactive locker station %', p_station_label using errcode = 'P0002';
  elsif v_tenants > 1 then
    raise exception 'the station label % is used by more than one school', p_station_label using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_info, '{}'::jsonb)) <> 'object' or length(coalesce(p_info, '{}'::jsonb)::text) > 2000 then
    raise exception 'the station information must be a small JSON object' using errcode = '22023';
  end if;

  insert into public.station_heartbeats (tenant_id, station_label, info)
  values (v_tenant, p_station_label, coalesce(p_info, '{}'::jsonb))
  on conflict (tenant_id, station_label)
  do update set last_seen_at = now(), info = excluded.info;

  return jsonb_build_object('ok', true, 'server_time', now());
end $$;

revoke all on function public.station_heartbeat(text, jsonb) from public, anon, authenticated;
grant execute on function public.station_heartbeat(text, jsonb) to service_role;

-- one row per station that has at least one active door. "online" = heard from in the last 3 minutes.
create view public.station_status with (security_invoker = true) as
select
  l.tenant_id,
  l.station_label,
  count(*)::int            as doors,
  h.first_seen_at,
  h.last_seen_at,
  h.info,
  coalesce(h.last_seen_at > now() - interval '3 minutes', false) as online
from public.lockers l
left join public.station_heartbeats h on h.tenant_id = l.tenant_id and h.station_label = l.station_label
where l.is_active
group by l.tenant_id, l.station_label, h.first_seen_at, h.last_seen_at, h.info;

grant select on public.station_status to authenticated;
grant all on public.station_status to service_role;

-- ---------------------------------------------------------------------
-- 5. What to look at now (administrators and deans)
--    Nothing is stored: an alert is there while its cause is, and goes when the cause does
--    (the key comes back, the station reports again, the denied tap is older than the window).
--    The wording is left to the apps; this returns codes and facts.
--
--    kind                 code                         what it is
--    key_not_returned     -                            the class ended (and the grace period) and the key is still out
--    room_attention       a room_status_now.presence   see the verdict table in the README
--    denied_attempts      the denial reason            the same card denied for the same reason (count in attempts)
--    station_offline      silent | never               no heartbeat for 3 minutes | not heard from at all yet
-- ---------------------------------------------------------------------
create function public.ops_alerts(p_hours integer default 24)
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
  v_tenant uuid := (select private.my_tenant());
  v_hours  integer := least(greatest(coalesce(p_hours, 24), 1), 168);
begin
  if (select private.my_role()) not in ('admin', 'dean') then
    return;
  end if;

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

revoke all on function public.ops_alerts(integer) from public, anon;
grant execute on function public.ops_alerts(integer) to authenticated, service_role;
