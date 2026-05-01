alter table public.route_sessions
add column if not exists latest_lat numeric(10,7) check (latest_lat is null or latest_lat between -90 and 90),
add column if not exists latest_lng numeric(10,7) check (latest_lng is null or latest_lng between -180 and 180),
add column if not exists latest_accuracy_m numeric(8,2) check (latest_accuracy_m is null or latest_accuracy_m >= 0),
add column if not exists latest_speed_mps numeric(8,2),
add column if not exists latest_heading numeric(6,2);

create or replace function public.touch_route_session_from_point()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.route_sessions
  set
    last_point_at = greatest(coalesce(last_point_at, new.recorded_at), new.recorded_at),
    latest_lat = case
      when last_point_at is null or new.recorded_at >= last_point_at then new.lat
      else latest_lat
    end,
    latest_lng = case
      when last_point_at is null or new.recorded_at >= last_point_at then new.lng
      else latest_lng
    end,
    latest_accuracy_m = case
      when last_point_at is null or new.recorded_at >= last_point_at then new.accuracy_m
      else latest_accuracy_m
    end,
    latest_speed_mps = case
      when last_point_at is null or new.recorded_at >= last_point_at then new.speed_mps
      else latest_speed_mps
    end,
    latest_heading = case
      when last_point_at is null or new.recorded_at >= last_point_at then new.heading
      else latest_heading
    end,
    point_count = point_count + 1,
    updated_at = now()
  where id = new.session_id;

  return new;
end;
$$;
