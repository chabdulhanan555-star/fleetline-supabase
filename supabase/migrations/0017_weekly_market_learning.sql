create table if not exists public.route_templates (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  name text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  source_start_date date,
  source_end_date date,
  source_pin_count integer not null default 0 check (source_pin_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists route_templates_one_approved_per_day
on public.route_templates(employee_id, weekday)
where status = 'approved';

create index if not exists route_templates_employee_weekday
on public.route_templates(employee_id, weekday, status);

create table if not exists public.route_template_stops (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.route_templates(id) on delete cascade,
  stop_order integer not null check (stop_order >= 1),
  name text not null,
  lat numeric(10,7) not null check (lat between -90 and 90),
  lng numeric(10,7) not null check (lng between -180 and 180),
  radius_m integer not null default 100 check (radius_m between 25 and 1000),
  visit_count integer not null default 1 check (visit_count >= 1),
  source_pin_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (template_id, stop_order)
);

create or replace function public.touch_route_template_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if new.status = 'approved' and old.status is distinct from new.status then
    new.approved_at = coalesce(new.approved_at, now());
    new.approved_by = coalesce(new.approved_by, public.current_actor_id());
  end if;
  return new;
end;
$$;

drop trigger if exists route_templates_touch_updated_at on public.route_templates;
create trigger route_templates_touch_updated_at
before update on public.route_templates
for each row
execute function public.touch_route_template_updated_at();

alter table public.route_templates enable row level security;
alter table public.route_template_stops enable row level security;

drop policy if exists route_templates_admin_all on public.route_templates;
create policy route_templates_admin_all
on public.route_templates
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists route_templates_rider_select on public.route_templates;
create policy route_templates_rider_select
on public.route_templates
for select
using (
  employee_id = public.current_rider_id()
  and status = 'approved'
);

drop policy if exists route_template_stops_admin_all on public.route_template_stops;
create policy route_template_stops_admin_all
on public.route_template_stops
for all
using (
  exists (
    select 1
    from public.route_templates rt
    where rt.id = template_id and public.is_admin()
  )
)
with check (
  exists (
    select 1
    from public.route_templates rt
    where rt.id = template_id and public.is_admin()
  )
);

drop policy if exists route_template_stops_rider_select on public.route_template_stops;
create policy route_template_stops_rider_select
on public.route_template_stops
for select
using (
  exists (
    select 1
    from public.route_templates rt
    where
      rt.id = template_id
      and rt.employee_id = public.current_rider_id()
      and rt.status = 'approved'
  )
);

grant select, insert, update, delete on public.route_templates to authenticated;
grant select on public.route_templates to rider;
grant select, insert, update, delete on public.route_template_stops to authenticated;
grant select on public.route_template_stops to rider;
grant all on public.route_templates to service_role;
grant all on public.route_template_stops to service_role;

do $$
begin
  begin
    alter publication supabase_realtime add table public.route_templates;
  exception
    when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.route_template_stops;
  exception
    when duplicate_object then null;
  end;
end
$$;
