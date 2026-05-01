drop policy if exists readings_rider_update on public.readings;
create policy readings_rider_update
on public.readings
for update
using (employee_id = public.current_rider_id())
with check (
  employee_id = public.current_rider_id()
  and km >= 0
  and reading_type in ('morning', 'evening')
  and (
    photo_path is null
    or photo_path ~ ('^readings/' || public.current_rider_id()::text || '/[0-9a-fA-F-]{36}\.jpe?g$')
  )
);

grant update on public.readings to rider;
