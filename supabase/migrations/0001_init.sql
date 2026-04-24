create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$
begin
  create role rider nologin;
exception
  when duplicate_object then null;
end
$$;

grant usage on schema public to anon, authenticated, rider, service_role;

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  username text not null unique,
  phone text,
  bike_plate text not null,
  bike_model text,
  mileage numeric(5,2),
  pin_hash text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists employees_username_active on public.employees(username) where active;

create table if not exists public.readings (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  date date not null,
  km integer not null check (km >= 0),
  photo_path text,
  submitted_at timestamptz not null default now(),
  submitted_by uuid default auth.uid()
);

create index if not exists readings_emp_date on public.readings(employee_id, date desc, submitted_at desc);
create index if not exists readings_date on public.readings(date desc, submitted_at desc);

create table if not exists public.config (
  id smallint primary key default 1 check (id = 1),
  fuel_price numeric(8,2) not null default 280,
  default_mileage numeric(5,2) not null default 40,
  currency text not null default 'PKR',
  admin_whatsapp text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.config (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.audit_log (
  id bigserial primary key,
  actor_id uuid not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_created on public.audit_log(created_at desc);

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

create or replace function public.hash_rider_pin(pin_input text)
returns text
language sql
security definer
set search_path = public, extensions
as $$
  select extensions.crypt(pin_input, extensions.gen_salt('bf'));
$$;

create or replace function public.verify_rider_pin(username_input text, pin_input text)
returns table (
  id uuid,
  name text,
  username text,
  phone text,
  bike_plate text,
  bike_model text,
  mileage numeric,
  active boolean
)
language sql
security definer
set search_path = public, extensions
as $$
  select
    e.id,
    e.name,
    e.username,
    e.phone,
    e.bike_plate,
    e.bike_model,
    e.mileage,
    e.active
  from public.employees e
  where
    e.active
    and e.username = username_input
    and extensions.crypt(pin_input, e.pin_hash) = e.pin_hash
  limit 1;
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

create or replace function public.log_employee_audit()
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
      when 'INSERT' then 'employee.create'
      when 'UPDATE' then 'employee.update'
      when 'DELETE' then 'employee.delete'
    end,
    'employee',
    coalesce(new.id, old.id)::text,
    case when tg_op = 'INSERT' then null else to_jsonb(old) - 'pin_hash' end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) - 'pin_hash' end
  );

  return coalesce(new, old);
end;
$$;

create or replace function public.log_config_audit()
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
      when 'INSERT' then 'config.create'
      when 'UPDATE' then 'config.update'
      when 'DELETE' then 'config.delete'
    end,
    'config',
    coalesce(new.id, old.id)::text,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists employees_touch_updated_at on public.employees;
create trigger employees_touch_updated_at
before update on public.employees
for each row
execute function public.touch_updated_at();

drop trigger if exists config_touch_updated_at on public.config;
create trigger config_touch_updated_at
before update on public.config
for each row
execute function public.touch_updated_at();

drop trigger if exists employees_audit_trigger on public.employees;
create trigger employees_audit_trigger
after insert or update or delete on public.employees
for each row
execute function public.log_employee_audit();

drop trigger if exists config_audit_trigger on public.config;
create trigger config_audit_trigger
after insert or update or delete on public.config
for each row
execute function public.log_config_audit();

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
grant select, insert, update, delete on public.employees to authenticated;
grant select (id, name, username, bike_plate, bike_model) on public.employees to anon;
grant select (id, name, username, phone, bike_plate, bike_model, mileage, active, created_at, updated_at) on public.employees to rider;
grant select, insert, update, delete on public.readings to authenticated;
grant select, insert on public.readings to rider;
grant select on public.config to authenticated, rider;
grant insert, update, delete on public.config to authenticated;
grant select, insert, update, delete on public.admins to authenticated;
grant select on public.audit_log to authenticated;
grant execute on function public.is_admin() to anon, authenticated, rider, service_role;
grant execute on function public.current_rider_id() to anon, authenticated, rider, service_role;
grant execute on function public.current_actor_id() to anon, authenticated, rider, service_role;
grant execute on function public.hash_rider_pin(text) to authenticated, service_role;
grant execute on function public.verify_rider_pin(text, text) to service_role;
grant usage, select on sequence public.audit_log_id_seq to authenticated, service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

alter table public.admins enable row level security;
alter table public.employees enable row level security;
alter table public.readings enable row level security;
alter table public.config enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists emp_admin_all on public.employees;
create policy emp_admin_all
on public.employees
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists emp_rider_read on public.employees;
create policy emp_rider_read
on public.employees
for select
using (active and id = public.current_rider_id());

drop policy if exists emp_login_list on public.employees;
create policy emp_login_list
on public.employees
for select
to anon, authenticated
using (active);

drop policy if exists readings_admin_all on public.readings;
create policy readings_admin_all
on public.readings
for all
using (public.is_admin())
with check (public.is_admin());

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
    and photo_path is not null
  );

drop policy if exists cfg_read on public.config;
create policy cfg_read
on public.config
for select
using (auth.role() in ('authenticated', 'rider'));

drop policy if exists cfg_write on public.config;
create policy cfg_write
on public.config
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists admins_all on public.admins;
create policy admins_all
on public.admins
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists audit_read on public.audit_log;
create policy audit_read
on public.audit_log
for select
using (public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'odometer-photos',
  'odometer-photos',
  false,
  2097152,
  array['image/jpeg', 'image/jpg']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists odo_admin on storage.objects;
create policy odo_admin
on storage.objects
for all
using (bucket_id = 'odometer-photos' and public.is_admin())
with check (bucket_id = 'odometer-photos' and public.is_admin());

drop policy if exists odo_rider_upload on storage.objects;
create policy odo_rider_upload
on storage.objects
for insert
with check (
    bucket_id = 'odometer-photos'
    and (storage.foldername(name))[2] = public.current_rider_id()::text
  );

drop policy if exists odo_rider_read on storage.objects;
create policy odo_rider_read
on storage.objects
for select
using (
    bucket_id = 'odometer-photos'
    and (storage.foldername(name))[2] = public.current_rider_id()::text
  );

do $$
begin
  begin
    alter publication supabase_realtime add table public.employees;
  exception
    when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.readings;
  exception
    when duplicate_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.config;
  exception
    when duplicate_object then null;
  end;
end
$$;

do $$
declare
  v_cleanup_url text := current_setting('app.cleanup_url', true);
  v_cleanup_token text := current_setting('app.cleanup_token', true);
begin
  if coalesce(v_cleanup_url, '') = '' or coalesce(v_cleanup_token, '') = '' then
    raise notice 'Skipping purge-old-photos cron schedule because app.cleanup_url or app.cleanup_token is not set.';
    return;
  end if;

  begin
    perform cron.unschedule(jobid)
    from cron.job
    where jobname = 'purge-old-photos';
  exception
    when others then null;
  end;

  perform cron.schedule(
    'purge-old-photos',
    '0 3 * * *',
    format(
      $fmt$
        select net.http_post(
          url := %L,
          headers := jsonb_build_object('Authorization', 'Bearer ' || %L)
        );
      $fmt$,
      v_cleanup_url,
      v_cleanup_token
    )
  );
end
$$;
