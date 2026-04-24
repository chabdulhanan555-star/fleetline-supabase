create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

create table if not exists public.rider_login_attempts (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  ip_hash text not null,
  success boolean not null default false,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists rider_login_attempts_lookup
  on public.rider_login_attempts(username, ip_hash, created_at desc);

alter table public.rider_login_attempts enable row level security;

drop policy if exists rider_login_attempts_admin_read on public.rider_login_attempts;
create policy rider_login_attempts_admin_read
on public.rider_login_attempts
for select
using (public.is_admin());

drop view if exists public.employee_login_directory;

drop policy if exists emp_login_list on public.employees;
drop policy if exists emp_admin_all on public.employees;
drop policy if exists emp_rider_read on public.employees;

create policy emp_admin_read
on public.employees
for select
using (public.is_admin());

create policy emp_rider_read
on public.employees
for select
using (active and id = public.current_rider_id());

drop policy if exists readings_admin_all on public.readings;
drop policy if exists readings_rider_select on public.readings;
drop policy if exists readings_rider_insert on public.readings;

create policy readings_admin_all
on public.readings
for all
using (public.is_admin())
with check (public.is_admin());

create policy readings_rider_select
on public.readings
for select
using (employee_id = public.current_rider_id());

create policy readings_rider_insert
on public.readings
for insert
with check (
  employee_id = public.current_rider_id()
  and photo_path is not null
  and photo_path ~ ('^readings/' || public.current_rider_id()::text || '/[0-9a-fA-F-]{36}\.jpe?g$')
);

drop policy if exists cfg_read on public.config;
drop policy if exists cfg_write on public.config;

create policy cfg_read
on public.config
for select
using (auth.role() in ('authenticated', 'rider'));

create policy cfg_write
on public.config
for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists admins_all on public.admins;
drop policy if exists admins_read on public.admins;

create policy admins_read
on public.admins
for select
using (public.is_admin());

drop policy if exists audit_read on public.audit_log;
create policy audit_read
on public.audit_log
for select
using (public.is_admin());

revoke all on public.employees from anon, authenticated, rider;
revoke all on public.readings from anon, authenticated, rider;
revoke all on public.config from anon, authenticated, rider;
revoke all on public.admins from anon, authenticated, rider;
revoke all on public.audit_log from anon, authenticated, rider;
revoke all on public.rider_login_attempts from anon, authenticated, rider;
revoke all on sequence public.audit_log_id_seq from anon, authenticated, rider;

grant select (id, name, username, phone, bike_plate, bike_model, mileage, active, created_at, updated_at)
  on public.employees to authenticated;
grant select (id, name, username, phone, bike_plate, bike_model, mileage, active, created_at, updated_at)
  on public.employees to rider;

grant select, insert, update, delete on public.readings to authenticated;
grant select, insert on public.readings to rider;

grant select, update on public.config to authenticated;
grant select on public.config to rider;

grant select on public.admins to authenticated;
grant select on public.audit_log to authenticated;
grant select on public.rider_login_attempts to authenticated;

revoke all on function public.hash_rider_pin(text) from public, anon, authenticated, rider;
revoke all on function public.verify_rider_pin(text, text) from public, anon, authenticated, rider;
grant execute on function public.hash_rider_pin(text) to service_role;
grant execute on function public.verify_rider_pin(text, text) to service_role;

grant all on public.employees to service_role;
grant all on public.readings to service_role;
grant all on public.config to service_role;
grant all on public.admins to service_role;
grant all on public.audit_log to service_role;
grant all on public.rider_login_attempts to service_role;
grant usage, select on sequence public.audit_log_id_seq to service_role;

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
  and (storage.foldername(name))[1] = 'readings'
  and (storage.foldername(name))[2] = public.current_rider_id()::text
  and storage.filename(name) ~* '^[0-9a-f-]{36}\.jpe?g$'
);

drop policy if exists odo_rider_read on storage.objects;
create policy odo_rider_read
on storage.objects
for select
using (
  bucket_id = 'odometer-photos'
  and (storage.foldername(name))[1] = 'readings'
  and (storage.foldername(name))[2] = public.current_rider_id()::text
);

create or replace function public.schedule_photo_cleanup(cleanup_url text, cleanup_token text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if coalesce(cleanup_url, '') = '' or coalesce(cleanup_token, '') = '' then
    raise exception 'cleanup_url and cleanup_token are required';
  end if;

  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'purge-old-photos';

  perform cron.schedule(
    'purge-old-photos',
    '0 3 * * *',
    format(
      $cmd$
        select net.http_post(
          url := %L,
          headers := jsonb_build_object('Authorization', 'Bearer ' || %L)
        );
      $cmd$,
      cleanup_url,
      cleanup_token
    )
  );
end;
$$;

revoke all on function public.schedule_photo_cleanup(text, text) from public, anon, authenticated, rider;
grant execute on function public.schedule_photo_cleanup(text, text) to service_role;
