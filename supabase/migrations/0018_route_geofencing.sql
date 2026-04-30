create table if not exists public.route_deviation_events (
  id uuid primary key default gen_random_uuid(),
  route_session_id uuid references public.route_sessions(id) on delete set null,
  template_id uuid references public.route_templates(id) on delete set null,
  employee_id uuid not null references public.employees(id) on delete cascade,
  event_type text not null check (event_type in ('outside_route', 'inside_route')),
  lat numeric(10,7) not null check (lat between -90 and 90),
  lng numeric(10,7) not null check (lng between -180 and 180),
  distance_m integer not null default 0 check (distance_m >= 0),
  radius_m integer not null default 0 check (radius_m >= 0),
  message text not null default '',
  recorded_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists route_deviation_events_employee_time
on public.route_deviation_events(employee_id, recorded_at desc);

create index if not exists route_deviation_events_session_time
on public.route_deviation_events(route_session_id, recorded_at desc);

create index if not exists route_deviation_events_type_time
on public.route_deviation_events(event_type, recorded_at desc);

alter table public.route_deviation_events enable row level security;

drop policy if exists route_deviation_events_admin_all on public.route_deviation_events;
create policy route_deviation_events_admin_all
on public.route_deviation_events
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists route_deviation_events_rider_select on public.route_deviation_events;
create policy route_deviation_events_rider_select
on public.route_deviation_events
for select
using (employee_id = public.current_rider_id());

drop policy if exists route_deviation_events_rider_insert on public.route_deviation_events;
create policy route_deviation_events_rider_insert
on public.route_deviation_events
for insert
with check (
  employee_id = public.current_rider_id()
  and (
    route_session_id is null
    or exists (
      select 1
      from public.route_sessions rs
      where
        rs.id = route_session_id
        and rs.employee_id = public.current_rider_id()
    )
  )
  and (
    template_id is null
    or exists (
      select 1
      from public.route_templates rt
      where
        rt.id = template_id
        and rt.employee_id = public.current_rider_id()
        and rt.status = 'approved'
    )
  )
);

revoke all on public.route_deviation_events from anon, authenticated, rider;
grant select, insert on public.route_deviation_events to authenticated, rider;
grant all on public.route_deviation_events to service_role;

do $$
begin
  begin
    alter publication supabase_realtime add table public.route_deviation_events;
  exception
    when duplicate_object then null;
  end;
end
$$;
