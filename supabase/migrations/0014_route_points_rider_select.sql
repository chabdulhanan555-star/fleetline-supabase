drop policy if exists route_points_rider_select on public.route_points;

create policy route_points_rider_select
on public.route_points
for select
using (employee_id = public.current_rider_id());
