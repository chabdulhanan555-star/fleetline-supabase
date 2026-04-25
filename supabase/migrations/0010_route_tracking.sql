create extension if not exists postgis with schema extensions;

create table if not exists public.route_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  date date not null,
  start_reading_id uuid references public.readings(id) on delete set null,
  end_reading_id uuid references public.readings(id) on delete set null,
  status text not null default 'active',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  last_point_at timestamptz,
  point_count integer not null default 0 check (point_count >= 0),
  total_distance_m integer not null default 0 check (total_distance_m >= 0),
  created_by uuid default public.current_actor_id(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_sessions_status_check check (status in ('active', 'completed', 'abandoned')),
  constraint route_sessions_end_check check (
    (status = 'active' and ended_at is null)
    or (status in ('completed', 'abandoned') and ended_at is not null)
  )
);

create unique index if not exists route_sessions_employee_date_unique
on public.route_sessions(employee_id, date);

create index if not exists route_sessions_employee_date
on public.route_sessions(employee_id, date desc);

create index if not exists route_sessions_status
on public.route_sessions(status, started_at desc);

create table if not exists public.route_points (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.route_sessions(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  recorded_at timestamptz not null,
  lat numeric(10,7) not null check (lat between -90 and 90),
  lng numeric(10,7) not null check (lng between -180 and 180),
  accuracy_m numeric(8,2) check (accuracy_m is null or accuracy_m >= 0),
  speed_mps numeric(8,2),
  heading numeric(6,2),
  created_at timestamptz not null default now()
);

create index if not exists route_points_session_time
on public.route_points(session_id, recorded_at);

create index if not exists route_points_employee_time
on public.route_points(employee_id, recorded_at desc);

create or replace function public.validate_route_point()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_id uuid;
  v_status text;
begin
  select employee_id, status
  into v_employee_id, v_status
  from public.route_sessions
  where id = new.session_id;

  if v_employee_id is null then
    raise exception 'Route session not found.';
  end if;

  if new.employee_id <> v_employee_id then
    raise exception 'Route point employee does not match session employee.';
  end if;

  if v_status <> 'active' then
    raise exception 'Route session is not active.';
  end if;

  return new;
end;
$$;

drop trigger if exists route_points_validate_trigger on public.route_points;
create trigger route_points_validate_trigger
before insert on public.route_points
for each row
execute function public.validate_route_point();

create or replace function public.touch_route_session_from_point()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.route_sessions
  set
    last_point_at = greatest(coalesce(last_point_at, new.recorded_at), new.recorded_at),
    point_count = point_count + 1,
    updated_at = now()
  where id = new.session_id;

  return new;
end;
$$;

drop trigger if exists route_points_touch_session_trigger on public.route_points;
create trigger route_points_touch_session_trigger
after insert on public.route_points
for each row
execute function public.touch_route_session_from_point();

drop trigger if exists route_sessions_touch_updated_at on public.route_sessions;
create trigger route_sessions_touch_updated_at
before update on public.route_sessions
for each row
execute function public.touch_updated_at();

create or replace function public.log_route_session_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := public.current_actor_id();
begin
  if v_actor is null then
    return coalesce(new, old);
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_actor,
    case
      when tg_op = 'INSERT' then 'route.start'
      when tg_op = 'UPDATE' and old.status <> new.status and new.status = 'completed' then 'route.complete'
      when tg_op = 'UPDATE' and old.status <> new.status and new.status = 'abandoned' then 'route.abandon'
      else 'route.update'
    end,
    'route_session',
    coalesce(new.id, old.id)::text,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists route_sessions_audit_trigger on public.route_sessions;
create trigger route_sessions_audit_trigger
after insert or update or delete on public.route_sessions
for each row
execute function public.log_route_session_audit();

alter table public.route_sessions enable row level security;
alter table public.route_points enable row level security;

drop policy if exists route_sessions_admin_all on public.route_sessions;
create policy route_sessions_admin_all
on public.route_sessions
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists route_sessions_rider_select on public.route_sessions;
create policy route_sessions_rider_select
on public.route_sessions
for select
using (employee_id = public.current_rider_id());

drop policy if exists route_sessions_rider_insert on public.route_sessions;
create policy route_sessions_rider_insert
on public.route_sessions
for insert
with check (
  employee_id = public.current_rider_id()
  and status = 'active'
);

drop policy if exists route_sessions_rider_update on public.route_sessions;
create policy route_sessions_rider_update
on public.route_sessions
for update
using (employee_id = public.current_rider_id())
with check (
  employee_id = public.current_rider_id()
  and status in ('active', 'completed', 'abandoned')
);

drop policy if exists route_points_admin_select on public.route_points;
create policy route_points_admin_select
on public.route_points
for select
using (public.is_admin());

drop policy if exists route_points_rider_insert on public.route_points;
create policy route_points_rider_insert
on public.route_points
for insert
with check (
  employee_id = public.current_rider_id()
  and exists (
    select 1
    from public.route_sessions rs
    where
      rs.id = session_id
      and rs.employee_id = public.current_rider_id()
      and rs.status = 'active'
  )
);

revoke all on public.route_sessions from anon, authenticated, rider;
revoke all on public.route_points from anon, authenticated, rider;

grant select, insert, update on public.route_sessions to authenticated, rider;
grant select, insert on public.route_points to authenticated, rider;
grant all on public.route_sessions to service_role;
grant all on public.route_points to service_role;

do $$
begin
  begin
    alter publication supabase_realtime add table public.route_sessions;
  exception
    when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.route_points;
  exception
    when duplicate_object then null;
  end;
end
$$;

create or replace function public.purge_old_route_points(retention_days integer default 180)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.route_points
  where recorded_at < now() - make_interval(days => retention_days);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.purge_old_route_points(integer) from public, anon, authenticated, rider;
grant execute on function public.purge_old_route_points(integer) to service_role;

do $$
begin
  begin
    perform cron.unschedule(jobid)
    from cron.job
    where jobname = 'purge-old-route-points';
  exception
    when others then null;
  end;

  perform cron.schedule(
    'purge-old-route-points',
    '30 3 * * *',
    $cron$ select public.purge_old_route_points(180); $cron$
  );
end
$$;
