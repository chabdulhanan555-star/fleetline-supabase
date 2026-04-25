alter table public.readings
add column if not exists reading_type text not null default 'evening';

alter table public.readings
drop constraint if exists readings_reading_type_check;

alter table public.readings
add constraint readings_reading_type_check
check (reading_type in ('morning', 'evening'));

create index if not exists readings_emp_date_type
on public.readings(employee_id, date desc, reading_type);

drop policy if exists readings_rider_insert on public.readings;

create policy readings_rider_insert
on public.readings
for insert
with check (
  employee_id = public.current_rider_id()
  and km >= 0
  and reading_type in ('morning', 'evening')
  and photo_path is not null
  and photo_path ~ ('^readings/' || public.current_rider_id()::text || '/[0-9a-fA-F-]{36}\.jpe?g$')
);
