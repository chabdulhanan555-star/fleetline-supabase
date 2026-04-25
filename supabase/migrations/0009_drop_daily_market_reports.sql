do $$
begin
  alter publication supabase_realtime drop table public.daily_reports;
exception
  when undefined_object then null;
end $$;

drop table if exists public.daily_reports;
