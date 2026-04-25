create table if not exists public.daily_reports (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references public.employees(id) on delete cascade,
  date            date not null,
  market_area     text not null,
  shops_visited   integer not null default 0 check (shops_visited >= 0),
  sales_amount    numeric(12,2) not null default 0 check (sales_amount >= 0),
  cash_collected  numeric(12,2) not null default 0 check (cash_collected >= 0),
  notes           text,
  submitted_at    timestamptz not null default now(),
  submitted_by    uuid,
  updated_at      timestamptz not null default now(),
  unique (employee_id, date)
);

create index if not exists daily_reports_employee_date
on public.daily_reports(employee_id, date desc);

alter table public.daily_reports enable row level security;

revoke all on public.daily_reports from public, anon;
grant select, insert, update, delete on public.daily_reports to authenticated;
grant select, insert, update on public.daily_reports to rider;
grant all on public.daily_reports to service_role;

drop trigger if exists daily_reports_touch_updated_at on public.daily_reports;
create trigger daily_reports_touch_updated_at
before update on public.daily_reports
for each row execute function public.touch_updated_at();

drop policy if exists reports_admin_all on public.daily_reports;
create policy reports_admin_all
on public.daily_reports
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists reports_rider_select on public.daily_reports;
create policy reports_rider_select
on public.daily_reports
for select
using (employee_id = public.current_rider_id());

drop policy if exists reports_rider_insert on public.daily_reports;
create policy reports_rider_insert
on public.daily_reports
for insert
with check (
  employee_id = public.current_rider_id()
  and exists (
    select 1
    from public.readings r
    where r.employee_id = public.current_rider_id()
      and r.date = daily_reports.date
      and r.reading_type = 'evening'
  )
);

drop policy if exists reports_rider_update on public.daily_reports;
create policy reports_rider_update
on public.daily_reports
for update
using (employee_id = public.current_rider_id())
with check (
  employee_id = public.current_rider_id()
  and exists (
    select 1
    from public.readings r
    where r.employee_id = public.current_rider_id()
      and r.date = daily_reports.date
      and r.reading_type = 'evening'
  )
);

do $$
begin
  alter publication supabase_realtime add table public.daily_reports;
exception
  when duplicate_object then null;
end $$;
