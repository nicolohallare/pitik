-- The ₱100 founding rider credit goes only to the first N riders (admins don't count).
insert into public.app_config (key, value) values ('rider_credit_max', '10') on conflict (key) do nothing;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare ph text; em text := new.email; adm boolean; given int;
begin
  if em like '%@m.pitik.invalid' then
    ph := split_part(em, '@', 1);
    em := null;
  end if;
  adm := coalesce(lower(em) = any (string_to_array(replace(lower(coalesce(cfg('admin_emails'), '')), ' ', ''), ',')), false);
  insert into profiles (id, email, phone, is_admin) values (new.id, em, ph, adm) on conflict (id) do nothing;
  if coalesce(cfg_num('rider_trial_credit', 0), 0) > 0 and not adm then
    perform pg_advisory_xact_lock(hashtext('pitik_founding_credit'));
    select count(*) into given from credits c join profiles p on p.id = c.user_id
      where c.reason = 'Founding rider credit' and not p.is_admin;
    if given < coalesce(cfg_num('rider_credit_max', 10), 10) then
      insert into credits (user_id, amount, reason) values (new.id, cfg_num('rider_trial_credit', 0), 'Founding rider credit');
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
