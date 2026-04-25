drop policy if exists readings_rider_insert on public.readings;

alter table public.readings
drop constraint if exists readings_reading_type_check;

drop index if exists public.readings_emp_date_type;

alter table public.readings
drop column if exists reading_type;

create policy readings_rider_insert
on public.readings
for insert
with check (
  employee_id = public.current_rider_id()
  and photo_path is not null
  and photo_path ~ ('^readings/' || public.current_rider_id()::text || '/[0-9a-fA-F-]{36}\.jpe?g$')
);
