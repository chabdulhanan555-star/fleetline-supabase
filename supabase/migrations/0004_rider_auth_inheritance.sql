do $$
begin
  grant authenticated to rider;
exception
  when duplicate_object then null;
  when undefined_object then
    raise notice 'Skipping grant authenticated to rider because one of the roles does not exist.';
end
$$;

grant usage on schema auth to rider;

do $$
begin
  grant execute on function auth.uid() to rider;
  grant execute on function auth.jwt() to rider;
  grant execute on function auth.role() to rider;
exception
  when undefined_function then
    raise notice 'Skipping one or more auth helper grants because the helper function does not exist.';
end
$$;
