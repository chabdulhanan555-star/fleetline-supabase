do $$
begin
  grant rider to authenticator;
exception
  when duplicate_object then null;
  when undefined_object then
    raise notice 'Skipping grant rider to authenticator because one of the roles does not exist.';
end
$$;

grant usage on schema public to anon, authenticated, rider, service_role;
grant usage on schema storage to authenticated, rider, service_role;

grant select, insert on storage.objects to rider;
grant select, insert, update, delete on storage.objects to authenticated;
grant all on storage.objects to service_role;
