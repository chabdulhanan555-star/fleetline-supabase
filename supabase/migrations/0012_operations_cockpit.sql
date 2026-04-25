create table if not exists public.fuel_price_history (
  date date primary key,
  fuel_price numeric(8,2) not null check (fuel_price > 0),
  currency text not null default 'PKR',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default public.current_actor_id()
);

create table if not exists public.daily_reviews (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  date date not null,
  status text not null default 'pending_review',
  notes text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint daily_reviews_employee_date_unique unique (employee_id, date),
  constraint daily_reviews_status_check check (status in ('pending_review', 'approved', 'problem', 'paid'))
);

create index if not exists daily_reviews_emp_date
on public.daily_reviews(employee_id, date desc);

create index if not exists daily_reviews_status_date
on public.daily_reviews(status, date desc);

create or replace function public.touch_daily_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();

  if new.status in ('approved', 'problem', 'paid') then
    new.reviewed_at = coalesce(new.reviewed_at, now());
    new.reviewed_by = coalesce(new.reviewed_by, auth.uid());
  end if;

  return new;
end;
$$;

drop trigger if exists daily_reviews_touch_trigger on public.daily_reviews;
create trigger daily_reviews_touch_trigger
before insert or update on public.daily_reviews
for each row
execute function public.touch_daily_review();

drop trigger if exists fuel_price_history_touch_updated_at on public.fuel_price_history;
create trigger fuel_price_history_touch_updated_at
before update on public.fuel_price_history
for each row
execute function public.touch_updated_at();

create or replace function public.upsert_today_fuel_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.fuel_price_history (date, fuel_price, currency, updated_by)
  values ((now() at time zone 'Asia/Karachi')::date, new.fuel_price, new.currency, public.current_actor_id())
  on conflict (date) do update
  set
    fuel_price = excluded.fuel_price,
    currency = excluded.currency,
    updated_at = now(),
    updated_by = excluded.updated_by;

  return new;
end;
$$;

drop trigger if exists config_fuel_price_history_trigger on public.config;
create trigger config_fuel_price_history_trigger
after insert or update of fuel_price, currency on public.config
for each row
execute function public.upsert_today_fuel_price();

create or replace function public.log_daily_review_audit()
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
    case tg_op
      when 'INSERT' then 'daily_review.create'
      when 'UPDATE' then 'daily_review.update'
      when 'DELETE' then 'daily_review.delete'
    end,
    'daily_review',
    coalesce(new.employee_id, old.employee_id)::text || ':' || coalesce(new.date, old.date)::text,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists daily_reviews_audit_trigger on public.daily_reviews;
create trigger daily_reviews_audit_trigger
after insert or update or delete on public.daily_reviews
for each row
execute function public.log_daily_review_audit();

insert into public.fuel_price_history (date, fuel_price, currency, updated_by)
select (now() at time zone 'Asia/Karachi')::date, fuel_price, currency, updated_by
from public.config
where id = 1
on conflict (date) do update
set
  fuel_price = excluded.fuel_price,
  currency = excluded.currency,
  updated_at = now(),
  updated_by = excluded.updated_by;

alter table public.fuel_price_history enable row level security;
alter table public.daily_reviews enable row level security;

drop policy if exists fuel_price_history_read on public.fuel_price_history;
create policy fuel_price_history_read
on public.fuel_price_history
for select
using (auth.role() in ('authenticated', 'rider'));

drop policy if exists fuel_price_history_admin_all on public.fuel_price_history;
create policy fuel_price_history_admin_all
on public.fuel_price_history
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists daily_reviews_admin_all on public.daily_reviews;
create policy daily_reviews_admin_all
on public.daily_reviews
for all
using (public.is_admin())
with check (public.is_admin());

revoke all on public.fuel_price_history from anon, authenticated, rider;
revoke all on public.daily_reviews from anon, authenticated, rider;

grant select on public.fuel_price_history to authenticated, rider;
grant select, insert, update, delete on public.fuel_price_history to authenticated;
grant select, insert, update, delete on public.daily_reviews to authenticated;
grant all on public.fuel_price_history to service_role;
grant all on public.daily_reviews to service_role;

do $$
begin
  begin
    alter publication supabase_realtime add table public.fuel_price_history;
  exception
    when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.daily_reviews;
  exception
    when duplicate_object then null;
  end;
end
$$;
