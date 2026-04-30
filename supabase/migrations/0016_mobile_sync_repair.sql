create extension if not exists pgcrypto with schema extensions;

do $$
begin
  create role rider nologin;
exception
  when duplicate_object then null;
end
$$;

grant usage on schema public to anon, authenticated, rider, service_role;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admins
    where user_id = auth.uid()
  );
$$;

create or replace function public.current_rider_id()
returns uuid
language sql
stable
as $$
  select coalesce(
    nullif(auth.jwt() ->> 'employee_id', '')::uuid,
    case
      when auth.role() = 'rider' then auth.uid()
      else null
    end
  );
$$;

create or replace function public.current_actor_id()
returns uuid
language sql
stable
as $$
  select coalesce(
    auth.uid(),
    nullif(auth.jwt() ->> 'employee_id', '')::uuid
  );
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace view public.employee_login_directory
with (security_invoker = true)
as
select
  id,
  name,
  username,
  bike_plate,
  bike_model
from public.employees
where active;

grant select on public.employee_login_directory to anon, authenticated, rider;

alter table public.readings
add column if not exists reading_type text not null default 'evening';

alter table public.readings
drop constraint if exists readings_reading_type_check;

alter table public.readings
add constraint readings_reading_type_check
check (reading_type in ('morning', 'evening'));

create index if not exists readings_emp_date_type
on public.readings(employee_id, date desc, reading_type);

drop policy if exists readings_rider_select on public.readings;
create policy readings_rider_select
on public.readings
for select
using (employee_id = public.current_rider_id());

drop policy if exists readings_rider_insert on public.readings;
create policy readings_rider_insert
on public.readings
for insert
with check (
  employee_id = public.current_rider_id()
  and km >= 0
  and reading_type in ('morning', 'evening')
  and (
    photo_path is null
    or photo_path ~ ('^readings/' || public.current_rider_id()::text || '/[0-9a-fA-F-]{36}\.jpe?g$')
  )
);

grant select, insert on public.readings to rider;
grant select, insert, update, delete on public.readings to authenticated;

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

alter table public.route_sessions enable row level security;
alter table public.route_points enable row level security;

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

drop policy if exists route_points_rider_select on public.route_points;
create policy route_points_rider_select
on public.route_points
for select
using (employee_id = public.current_rider_id());

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

grant select, insert, update on public.route_sessions to authenticated, rider;
grant select, insert on public.route_points to authenticated, rider;

create table if not exists public.shop_pins (
  id uuid primary key default gen_random_uuid(),
  route_session_id uuid not null references public.route_sessions(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete cascade,
  name text not null,
  lat numeric(10,7) not null check (lat between -90 and 90),
  lng numeric(10,7) not null check (lng between -180 and 180),
  accuracy_m numeric(8,2) check (accuracy_m is null or accuracy_m >= 0),
  pinned_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists shop_pins_route_time
on public.shop_pins(route_session_id, pinned_at);

create or replace function public.validate_shop_pin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_id uuid;
begin
  select employee_id
  into v_employee_id
  from public.route_sessions
  where id = new.route_session_id;

  if v_employee_id is null then
    raise exception 'Route session not found.';
  end if;

  if new.employee_id <> v_employee_id then
    raise exception 'Shop pin employee does not match route session employee.';
  end if;

  return new;
end;
$$;

drop trigger if exists shop_pins_validate_trigger on public.shop_pins;
create trigger shop_pins_validate_trigger
before insert on public.shop_pins
for each row
execute function public.validate_shop_pin();

alter table public.shop_pins enable row level security;

drop policy if exists shop_pins_rider_select on public.shop_pins;
create policy shop_pins_rider_select
on public.shop_pins
for select
using (employee_id = public.current_rider_id());

drop policy if exists shop_pins_rider_insert on public.shop_pins;
create policy shop_pins_rider_insert
on public.shop_pins
for insert
with check (
  employee_id = public.current_rider_id()
  and exists (
    select 1
    from public.route_sessions rs
    where
      rs.id = route_session_id
      and rs.employee_id = public.current_rider_id()
  )
);

grant select, insert on public.shop_pins to authenticated, rider;

grant execute on function public.is_admin() to anon, authenticated, rider, service_role;
grant execute on function public.current_rider_id() to anon, authenticated, rider, service_role;
grant execute on function public.current_actor_id() to anon, authenticated, rider, service_role;
