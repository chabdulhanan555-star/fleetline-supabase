create table if not exists public.live_rider_locations (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  route_session_id uuid references public.route_sessions(id) on delete set null,
  date date,
  status text not null default 'active',
  lat numeric(10,7) not null check (lat between -90 and 90),
  lng numeric(10,7) not null check (lng between -180 and 180),
  accuracy_m numeric(8,2) check (accuracy_m is null or accuracy_m >= 0),
  speed_mps numeric(8,2),
  heading numeric(8,2),
  recorded_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint live_rider_locations_status_check check (status in ('active', 'idle', 'completed', 'offline'))
);

create index if not exists live_rider_locations_status_updated
on public.live_rider_locations(status, updated_at desc);

create index if not exists live_rider_locations_session
on public.live_rider_locations(route_session_id);

alter table public.live_rider_locations replica identity full;
alter table public.live_rider_locations enable row level security;

drop policy if exists live_rider_locations_admin_all on public.live_rider_locations;
create policy live_rider_locations_admin_all
on public.live_rider_locations
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists live_rider_locations_rider_select on public.live_rider_locations;
create policy live_rider_locations_rider_select
on public.live_rider_locations
for select
using (employee_id = public.current_rider_id());

drop policy if exists live_rider_locations_rider_insert on public.live_rider_locations;
create policy live_rider_locations_rider_insert
on public.live_rider_locations
for insert
with check (employee_id = public.current_rider_id());

drop policy if exists live_rider_locations_rider_update on public.live_rider_locations;
create policy live_rider_locations_rider_update
on public.live_rider_locations
for update
using (employee_id = public.current_rider_id())
with check (employee_id = public.current_rider_id());

grant select, insert, update on public.live_rider_locations to authenticated, rider;
grant all on public.live_rider_locations to service_role;

do $$
begin
  begin
    alter publication supabase_realtime add table public.live_rider_locations;
  exception
    when duplicate_object then null;
  end;
end
$$;
