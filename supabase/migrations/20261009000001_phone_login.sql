-- Sign in with a mobile number and a 6-digit PIN. No email, no SMS.
-- The account function creates the login with a stand-in address <number>@m.pitik.invalid
-- (never emailed) and the number goes into profiles.phone.

alter table public.profiles add column if not exists phone text unique check (phone ~ '^09\d{9}$');
grant select on public.profiles to authenticated;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare ph text; em text := new.email;
begin
  if em like '%@m.pitik.invalid' then
    ph := split_part(em, '@', 1);
    em := null;
  end if;
  insert into profiles (id, email, phone, is_admin)
  values (new.id, em, ph,
          coalesce(lower(em) = any (string_to_array(replace(lower(coalesce(cfg('admin_emails'), '')), ' ', ''), ',')), false))
  on conflict (id) do nothing;
  if coalesce(cfg_num('rider_trial_credit', 0), 0) > 0 then
    insert into credits (user_id, amount, reason) values (new.id, cfg_num('rider_trial_credit', 0), 'Founding rider credit');
  end if;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Admin tools accept an email or a mobile number
create or replace function public.admin_give_credit(p_email text, p_amount numeric, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid; k text := lower(trim(p_email));
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_amount <= 0 or p_amount > 5000 then raise exception 'Check the amount'; end if;
  k := case when k ~ '^(\+?63|0)?9\d{9}$' then '0' || right(k, 10) else k end;
  select id into uid from profiles where lower(email) = k or phone = k;
  if uid is null then raise exception 'No rider with that email or number yet'; end if;
  insert into credits (user_id, amount, reason) values (uid, p_amount, p_reason);
end $$;

create or replace function public.admin_find_user(p_phone text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare k text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if k !~ '^(63|0)?9\d{9}$' then raise exception 'Enter an 11-digit mobile number'; end if;
  return (select id from profiles where phone = '0' || right(k, 10));
end $$;

create or replace function public.admin_overview() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return jsonb_build_object(
    'pitikeros', (select count(*) from pitikeros),
    'riders', (select count(*) from profiles),
    'strava', (select count(*) from strava_accounts),
    'photos', (select count(*) from photos),
    'orders_paid', (select count(*) from orders where status = 'paid' and not is_test),
    'gmv', coalesce((select sum(photos_amount + tips_amount) from orders where status = 'paid' and not is_test), 0),
    'pitik_fees', coalesce((select sum(fee_amount) from orders where status = 'paid' and not is_test), 0),
    'credits_used', coalesce((select sum(credit_amount) from orders where status = 'paid' and not is_test), 0),
    'review', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'ref', gateway_ref, 'total', total, 'note', admin_note)), '[]'::jsonb)
               from orders where status = 'review' or admin_note like '%refund%'),
    'recent_orders', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select o.id, o.status, o.total, o.photos_amount, o.tips_amount, o.fee_amount, o.credit_amount, o.gateway_ref, o.created_at, o.paid_at,
               coalesce(p.email, p.phone) as email
        from orders o left join profiles p on p.id = o.user_id order by o.created_at desc limit 30) x),
    'webhooks', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select received_at, reference, status, signature_ok, outcome from gateway_webhook_log order by received_at desc limit 20) x)
  );
end $$;

revoke execute on function public.admin_give_credit(text, numeric, text), public.admin_find_user(text), public.admin_overview() from public, anon;
grant execute on function public.admin_give_credit(text, numeric, text), public.admin_find_user(text), public.admin_overview() to authenticated, service_role;
