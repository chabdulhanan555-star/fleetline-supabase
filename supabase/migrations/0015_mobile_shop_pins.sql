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

create index if not exists shop_pins_employee_time
on public.shop_pins(employee_id, pinned_at desc);

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

drop policy if exists shop_pins_admin_all on public.shop_pins;
create policy shop_pins_admin_all
on public.shop_pins
for all
using (public.is_admin())
with check (public.is_admin());

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

revoke all on public.shop_pins from anon, authenticated, rider;
grant select, insert on public.shop_pins to authenticated, rider;
grant all on public.shop_pins to service_role;

do $$
begin
  begin
    alter publication supabase_realtime add table public.shop_pins;
  exception
    when duplicate_object then null;
  end;
end
$$;
