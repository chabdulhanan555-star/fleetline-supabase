alter table public.shop_pins
add column if not exists photo_path text;

comment on column public.shop_pins.photo_path is 'Optional storage path for rider shop visit proof photo.';

drop policy if exists shop_pins_rider_insert on public.shop_pins;
create policy shop_pins_rider_insert
on public.shop_pins
for insert
with check (
  employee_id = public.current_rider_id()
  and exists (
    select 1
    from public.route_sessions rs
    where
      rs.id = route_session_id
      and rs.employee_id = public.current_rider_id()
  )
  and (
    photo_path is null
    or photo_path ~ ('^readings/' || public.current_rider_id()::text || '/[0-9a-fA-F-]{36}\.jpe?g$')
  )
);
