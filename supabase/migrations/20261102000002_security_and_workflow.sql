-- =====================================================================
-- Classroom360 — security, approval workflow, audit trail
-- =====================================================================

-- ---------------------------------------------------------------------
-- Session helpers (security definer so they can read profiles without
-- tripping the profiles RLS policies). Kept in the private schema, which
-- PostgREST does not expose.
-- ---------------------------------------------------------------------
create function private.my_tenant() returns uuid
language sql stable security definer set search_path = '' as $$
  select tenant_id from public.profiles where id = auth.uid()
$$;

create function private.my_role() returns public.user_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = auth.uid()
$$;

create function private.my_department() returns uuid
language sql stable security definer set search_path = '' as $$
  select department_id from public.profiles where id = auth.uid()
$$;

create function private.my_instructor() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.instructors where profile_id = auth.uid()
$$;

create function private.program_in_my_department(p_program_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.programs p
     where p.id = p_program_id
       and p.department_id is not null
       and p.department_id = private.my_department()
  )
$$;

-- ---------------------------------------------------------------------
-- New auth users get a profile. The tenant comes from app_meta_data (only
-- settable server-side) or, in a single-school deployment, the only tenant.
-- Role is always 'instructor'; an administrator promotes users afterwards.
-- ---------------------------------------------------------------------
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant uuid;
  v_count  integer;
begin
  begin
    v_tenant := nullif(new.raw_app_meta_data ->> 'tenant_id', '')::uuid;
  exception when others then
    v_tenant := null;
  end;

  if v_tenant is null then
    select count(*) into v_count from public.tenants;
    if v_count = 1 then
      select id into v_tenant from public.tenants;
    end if;
  end if;

  if v_tenant is null then
    return new;      -- no tenant to attach to: the app shows "account not set up"
  end if;

  insert into public.profiles (id, tenant_id, email, full_name)
  values (
    new.id,
    v_tenant,
    new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1))
  );

  -- link to a pre-registered instructor with the same email
  update public.instructors
     set profile_id = new.id
   where tenant_id = v_tenant
     and profile_id is null
     and lower(email) = lower(new.email);

  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- Users may edit their own name, but never their own tenant, role or department.
create function private.profiles_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    if new.tenant_id is distinct from old.tenant_id then
      raise exception 'a profile cannot be moved to another institution' using errcode = '42501';
    end if;
    if (new.role is distinct from old.role or new.department_id is distinct from old.department_id)
       and private.my_role() is distinct from 'admin' then
      raise exception 'only an administrator can change a role or department' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger profiles_guard
  before update on public.profiles
  for each row execute function private.profiles_guard();

-- ---------------------------------------------------------------------
-- Audit trail (append-only; written by triggers and the workflow function)
-- ---------------------------------------------------------------------
create function private.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
begin
  insert into public.audit_logs (tenant_id, actor_id, action, table_name, record_id, old_data, new_data)
  values (
    (v_row ->> 'tenant_id')::uuid,
    auth.uid(),
    tg_op,
    tg_table_name,
    v_row ->> 'id',
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
  );
  return null;
end $$;

create trigger audit_rooms        after insert or update or delete on public.rooms
  for each row execute function private.audit_row_change();
create trigger audit_lockers      after insert or update or delete on public.lockers
  for each row execute function private.audit_row_change();
create trigger audit_rfid_cards   after insert or update or delete on public.rfid_cards
  for each row execute function private.audit_row_change();
create trigger audit_instructors  after insert or update or delete on public.instructors
  for each row execute function private.audit_row_change();
create trigger audit_profiles     after insert or update or delete on public.profiles
  for each row execute function private.audit_row_change();

-- Schedule entries: audit moves and deletions (status changes are summarised by
-- set_schedule_status; bulk solver inserts are summarised by solve_jobs).
create trigger audit_schedule_entries_moved
  after update on public.schedule_entries
  for each row
  when (old.room_id is distinct from new.room_id
     or old.day_of_week is distinct from new.day_of_week
     or old.start_time  is distinct from new.start_time
     or old.end_time    is distinct from new.end_time)
  execute function private.audit_row_change();
create trigger audit_schedule_entries_deleted
  after delete on public.schedule_entries
  for each row execute function private.audit_row_change();

-- ---------------------------------------------------------------------
-- Approval workflow
--   draft | returned  --submit-->   submitted     (chair of that department, dean, admin)
--   submitted         --approve-->  approved      (dean, admin)
--   submitted         --return-->   returned      (dean, admin; note required)
--   approved          --publish-->  published     (dean, admin)
-- Only published entries are honoured by the locker station.
-- ---------------------------------------------------------------------
create function public.set_schedule_status(
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
-- Row-level security
-- ---------------------------------------------------------------------
alter table public.tenants                   enable row level security;
alter table public.campuses                  enable row level security;
alter table public.buildings                 enable row level security;
alter table public.rooms                     enable row level security;
alter table public.departments               enable row level security;
alter table public.programs                  enable row level security;
alter table public.profiles                  enable row level security;
alter table public.instructors               enable row level security;
alter table public.instructor_unavailability enable row level security;
alter table public.terms                     enable row level security;
alter table public.courses                   enable row level security;
alter table public.sections                  enable row level security;
alter table public.schedule_entries          enable row level security;
alter table public.solve_jobs                enable row level security;
alter table public.lockers                   enable row level security;
alter table public.rfid_cards                enable row level security;
alter table public.access_logs               enable row level security;
alter table public.key_return_events         enable row level security;
alter table public.occupancy_events          enable row level security;
alter table public.audit_logs                enable row level security;

-- tenants
create policy tenants_select on public.tenants for select to authenticated
  using (id = (select private.my_tenant()));
create policy tenants_update on public.tenants for update to authenticated
  using (id = (select private.my_tenant()) and (select private.my_role()) = 'admin')
  with check (id = (select private.my_tenant()));

-- institutional structure: everyone in the tenant reads, administrators write
do $$
declare t text;
begin
  foreach t in array array['campuses', 'buildings', 'rooms', 'departments', 'programs', 'terms'] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (tenant_id = (select private.my_tenant()))',
      t || '_select', t);
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (tenant_id = (select private.my_tenant()) and (select private.my_role()) = ''admin'')
         with check (tenant_id = (select private.my_tenant()) and (select private.my_role()) = ''admin'')',
      t || '_admin_write', t);
  end loop;
end $$;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or (tenant_id = (select private.my_tenant())
        and (select private.my_role()) in ('admin', 'dean', 'program_chair'))
  );
create policy profiles_update on public.profiles for update to authenticated
  using (
    id = (select auth.uid())
    or (tenant_id = (select private.my_tenant()) and (select private.my_role()) = 'admin')
  )
  with check (tenant_id = (select private.my_tenant()));

-- instructors
create policy instructors_select on public.instructors for select to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean', 'program_chair')
      or id = (select private.my_instructor())
    )
  );
create policy instructors_write on public.instructors for all to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) in ('admin', 'dean'))
  with check (tenant_id = (select private.my_tenant()) and (select private.my_role()) in ('admin', 'dean'));

create policy unavailability_select on public.instructor_unavailability for select to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean', 'program_chair')
      or instructor_id = (select private.my_instructor())
    )
  );
create policy unavailability_write on public.instructor_unavailability for all to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean', 'program_chair')
      or instructor_id = (select private.my_instructor())
    )
  )
  with check (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean', 'program_chair')
      or instructor_id = (select private.my_instructor())
    )
  );

-- courses
create policy courses_select on public.courses for select to authenticated
  using (tenant_id = (select private.my_tenant()));
create policy courses_write on public.courses for all to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or ((select private.my_role()) = 'program_chair' and department_id = (select private.my_department()))
    )
  )
  with check (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or ((select private.my_role()) = 'program_chair' and department_id = (select private.my_department()))
    )
  );

-- sections: admin/dean all; chair = own department's programs; instructor = own sections
create policy sections_select on public.sections for select to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or ((select private.my_role()) = 'program_chair' and private.program_in_my_department(program_id))
      or ((select private.my_role()) = 'instructor' and instructor_id = (select private.my_instructor()))
    )
  );
create policy sections_write on public.sections for all to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or ((select private.my_role()) = 'program_chair' and private.program_in_my_department(program_id))
    )
  )
  with check (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or ((select private.my_role()) = 'program_chair' and private.program_in_my_department(program_id))
    )
  );

-- schedule entries
create policy schedule_entries_select on public.schedule_entries for select to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or ((select private.my_role()) = 'program_chair' and private.program_in_my_department(program_id))
      or ((select private.my_role()) = 'instructor'
          and status = 'published'
          and instructor_id = (select private.my_instructor()))
    )
  );
create policy schedule_entries_insert on public.schedule_entries for insert to authenticated
  with check (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or ((select private.my_role()) = 'program_chair'
          and private.program_in_my_department(program_id)
          and status in ('draft', 'returned'))
    )
  );
create policy schedule_entries_update on public.schedule_entries for update to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or ((select private.my_role()) = 'program_chair'
          and private.program_in_my_department(program_id)
          and status in ('draft', 'returned'))
    )
  )
  with check (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or ((select private.my_role()) = 'program_chair'
          and private.program_in_my_department(program_id)
          and status in ('draft', 'returned'))
    )
  );
create policy schedule_entries_delete on public.schedule_entries for delete to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or ((select private.my_role()) = 'program_chair'
          and private.program_in_my_department(program_id)
          and status in ('draft', 'returned'))
    )
  );

-- solver jobs
create policy solve_jobs_select on public.solve_jobs for select to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and ((select private.my_role()) in ('admin', 'dean') or requested_by = (select auth.uid()))
  );
create policy solve_jobs_insert on public.solve_jobs for insert to authenticated
  with check (
    tenant_id = (select private.my_tenant())
    and requested_by = (select auth.uid())
    and (select private.my_role()) in ('admin', 'dean', 'program_chair')
  );

-- lockers, cards, logs
create policy lockers_select on public.lockers for select to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) in ('admin', 'dean'));
create policy lockers_write on public.lockers for all to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) = 'admin')
  with check (tenant_id = (select private.my_tenant()) and (select private.my_role()) = 'admin');

create policy rfid_cards_select on public.rfid_cards for select to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) in ('admin', 'dean'));
create policy rfid_cards_write on public.rfid_cards for all to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) = 'admin')
  with check (tenant_id = (select private.my_tenant()) and (select private.my_role()) = 'admin');

create policy access_logs_select on public.access_logs for select to authenticated
  using (
    tenant_id = (select private.my_tenant())
    and (
      (select private.my_role()) in ('admin', 'dean')
      or instructor_id = (select private.my_instructor())
    )
  );

create policy key_return_events_select on public.key_return_events for select to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) in ('admin', 'dean'));

create policy occupancy_events_select on public.occupancy_events for select to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) in ('admin', 'dean'));

create policy audit_logs_select on public.audit_logs for select to authenticated
  using (tenant_id = (select private.my_tenant()) and (select private.my_role()) in ('admin', 'dean'));

-- ---------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------
grant usage on schema public  to anon, authenticated, service_role;
grant usage on schema private to authenticated, service_role;

revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

-- device-written and append-only tables are read-only for signed-in users
revoke insert, update, delete on
  public.access_logs, public.key_return_events, public.occupancy_events, public.audit_logs
  from authenticated;
revoke insert, update, delete on public.locker_status, public.room_status_now from authenticated;

grant execute on all functions in schema private to authenticated, service_role;
revoke all on function public.set_schedule_status(uuid, uuid, public.schedule_status, text) from public, anon;
grant execute on function public.set_schedule_status(uuid, uuid, public.schedule_status, text)
  to authenticated, service_role;

-- ---------------------------------------------------------------------
-- Realtime (both apps listen for live changes; RLS still applies)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.access_logs, public.key_return_events, public.occupancy_events, public.schedule_entries;
  end if;
end $$;
