-- =====================================================================
-- Classroom360 — step 7: the locker station asks "which door for this card?"
--
-- The locker cabinet has ONE card reader and four doors (one key per room). authorize_key_request()
-- decides for a given door, so the station would have to try the doors one by one and leave a
-- "denied" line in the log for every door that is not the instructor's. This function does the
-- picking on the server instead and then calls authorize_key_request() for the one door, so there
-- is a single log line per tap and the grant or denial still comes from that one function.
--
--   authorize_card_at_station(card, station, at)
--     1. finds the doors of that station;
--     2. picks the door whose room the card holder is scheduled in now (a published class or an
--        approved room request, within the grace period). If several match, a door whose key is
--        still in the locker comes first, then the class that is actually in session, then the
--        lowest door number;
--     3. asks authorize_key_request() about that door. If no door matches, it asks about the
--        station's first door, which records the denial and its reason (card not registered, card
--        switched off, assigned to a different room, outside scheduled time).
--     4. RETURN TAP. When the card holder is holding a key of this station (a door with an open
--        issue in their name) and there is no door with a key in it to hand out to them, the tap
--        is a return: the answer is decision 'return' with that door, so the station can release
--        the door to put the key back. It writes no access-log line (the key counts as returned
--        only when the key switch sees it, which record_key_return() records). The compartment
--        is empty at that moment, so this opens nothing that holds a key.
--
-- Only service_role (the locker station) can call it. Safe on top of files 1 to 9; changes no data.
-- =====================================================================
create function public.authorize_card_at_station(
  p_card_uid      text,
  p_station_label text,
  p_at            timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant   uuid;
  v_tenants  int;
  v_tz       text;
  v_grace    interval;
  v_card     public.rfid_cards%rowtype;
  v_local    timestamp;
  v_dow      smallint;
  v_time     time;
  v_locker   uuid;
  v_first    uuid;
  v_result   jsonb;
  v_ret      uuid;
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

  select t.timezone, make_interval(mins => t.grace_minutes) into v_tz, v_grace
    from public.tenants t where t.id = v_tenant;
  v_local := p_at at time zone v_tz;
  v_dow   := extract(isodow from v_local)::smallint;
  v_time  := v_local::time;

  select l.id into v_first
    from public.lockers l
   where l.tenant_id = v_tenant and l.station_label = p_station_label and l.is_active
   order by l.compartment_no limit 1;

  select * into v_card
    from public.rfid_cards c
   where c.tenant_id = v_tenant and c.card_uid = p_card_uid and c.is_active;

  if v_card.id is not null then
    select cand.locker_id into v_locker
      from (
        select l.id as locker_id, l.compartment_no,
               private.locker_open_access_log(l.id) is not null as key_out,
               exists (
                 select 1 from public.schedule_entries se
                   join public.terms t on t.id = se.term_id
                  where se.tenant_id = v_tenant and se.status = 'published' and se.instructor_id = v_card.instructor_id
                    and se.room_id = l.room_id and se.day_of_week = v_dow
                    and v_local::date between t.starts_on and t.ends_on
                    and v_time between se.start_time and se.end_time
               ) or exists (
                 select 1 from public.room_requests rr
                  where rr.tenant_id = v_tenant and rr.status = 'approved' and rr.instructor_id = v_card.instructor_id
                    and rr.room_id = l.room_id and rr.requested_for = v_local::date
                    and v_time between rr.start_time and rr.end_time
               ) as in_session
          from public.lockers l
         where l.tenant_id = v_tenant and l.station_label = p_station_label and l.is_active
           and (
             exists (
               select 1 from public.schedule_entries se
                 join public.terms t on t.id = se.term_id
                where se.tenant_id = v_tenant and se.status = 'published' and se.instructor_id = v_card.instructor_id
                  and se.room_id = l.room_id and se.day_of_week = v_dow
                  and v_local::date between t.starts_on and t.ends_on
                  and v_time between se.start_time - v_grace and se.end_time + v_grace
             ) or exists (
               select 1 from public.room_requests rr
                where rr.tenant_id = v_tenant and rr.status = 'approved' and rr.instructor_id = v_card.instructor_id
                  and rr.room_id = l.room_id and rr.requested_for = v_local::date
                  and v_time between rr.start_time - v_grace and rr.end_time + v_grace
             )
           )
      ) cand
     order by cand.key_out, not cand.in_session, cand.compartment_no
     limit 1;
  end if;

  -- return tap: nothing to hand out, and the holder has a key of this station out
  if v_card.id is not null
     and (v_locker is null or private.locker_open_access_log(v_locker) is not null) then
    select l.id into v_ret
      from public.lockers l
     where l.tenant_id = v_tenant and l.station_label = p_station_label and l.is_active
       and (select al.instructor_id from public.access_logs al where al.id = private.locker_open_access_log(l.id)) = v_card.instructor_id
     order by l.compartment_no
     limit 1;
    if v_ret is not null then
      return jsonb_build_object(
        'decision',        'return',
        'reason',          'key_return',
        'access_log_id',   null,
        'room_id',         (select l.room_id from public.lockers l where l.id = v_ret),
        'compartment_no',  (select l.compartment_no from public.lockers l where l.id = v_ret),
        'instructor_name', (select i.full_name from public.instructors i where i.id = v_card.instructor_id),
        'locker_id',       v_ret,
        'station_label',   p_station_label,
        'room_code',       (select r.code from public.rooms r join public.lockers l on l.room_id = r.id where l.id = v_ret)
      );
    end if;
  end if;

  v_locker := coalesce(v_locker, v_first);
  v_result := public.authorize_key_request(p_card_uid, v_locker, p_at);
  return v_result || jsonb_build_object(
    'locker_id',     v_locker,
    'station_label', p_station_label,
    'room_code',     (select r.code from public.rooms r where r.id = (v_result ->> 'room_id')::uuid)
  );
end $$;

revoke all on function public.authorize_card_at_station(text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.authorize_card_at_station(text, text, timestamptz) to service_role;
