-- Trial allowance, earned by actually using Pitik on a trial Sunday.
-- A pitikero earns it for a trial day when ALL of these are true:
--   1. Their account is active (the Pitik team activated them)
--   2. They tapped "Nandito ako" with their phone's GPS that morning (4–11am), within allowance_radius_km of Taktak
--   3. They did the clock check on that shoot
--   4. At least allowance_min_photos real camera shots from that morning (4am–12nn) are uploaded
--   5. Uploaded by the deadline: noon the next day
-- Checked hourly; the allowance lands in their next payout automatically. Admins can still reverse it with an adjustment.

insert into public.app_config(key, value) values
  ('trial_days', ''),                      -- e.g. '2026-10-11,2026-10-18'
  ('allowance_amount', '300'),
  ('allowance_min_photos', '40'),
  ('allowance_center', '14.5947,121.1675'),-- Hinulugang Taktak
  ('allowance_radius_km', '5')
on conflict (key) do nothing;

update public.app_config set value = '100' where key = 'rider_trial_credit';

alter table public.ledger add column if not exists trial_day date;
create unique index if not exists ledger_allowance_once on public.ledger (pitikero_id, trial_day) where kind = 'allowance' and trial_day is not null;

create or replace function public.trial_days() returns date[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(d::date order by d::date), '{}')
  from unnest(string_to_array(replace(coalesce(cfg('trial_days'), ''), ' ', ''), ',')) d where d ~ '^\d{4}-\d{2}-\d{2}$'
$$;

create or replace function public.allowance_check(p_pk uuid, p_day date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  t0 timestamptz := (p_day::timestamp + interval '4 hours') at time zone 'Asia/Manila';
  t_ci timestamptz := (p_day::timestamp + interval '11 hours') at time zone 'Asia/Manila';
  t_ph timestamptz := (p_day::timestamp + interval '12 hours') at time zone 'Asia/Manila';
  deadline timestamptz := (p_day::timestamp + interval '36 hours') at time zone 'Asia/Manila';
  c text[] := string_to_array(coalesce(cfg('allowance_center'), '14.5947,121.1675'), ',');
  clat float8 := c[1]::float8; clon float8 := c[2]::float8;
  rad float8 := cfg_num('allowance_radius_km', 5);
  need int := cfg_num('allowance_min_photos', 40)::int;
  st text; checked bool; near bool; clock bool; n int; awarded numeric;
begin
  select status into st from pitikeros where id = p_pk;
  with s as (
    select id, clock_checked,
           111.2 * sqrt(power(lat - clat, 2) + power((lon - clon) * cos(radians(clat)), 2)) <= rad as ok_spot
    from shoots where pitikero_id = p_pk and pin_source = 'phone' and checked_in_at between t0 and t_ci)
  select count(*) > 0, coalesce(bool_or(ok_spot), false), coalesce(bool_or(ok_spot and clock_checked), false),
         (select count(*) from photos ph where ph.shoot_id in (select id from s where ok_spot) and not ph.hidden
            and ph.taken_at between t0 and t_ph and ph.created_at <= deadline)
    into checked, near, clock, n from s;
  select amount into awarded from ledger where pitikero_id = p_pk and kind = 'allowance' and trial_day = p_day;
  return jsonb_build_object(
    'day', p_day, 'amount', cfg_num('allowance_amount', 300), 'deadline', deadline,
    'active', st = 'active', 'checked_in', checked, 'at_taktak', near, 'clock_checked', clock,
    'photos', n, 'min_photos', need,
    'qualifies', st = 'active' and near and clock and n >= need,
    'awarded', awarded is not null, 'awarded_amount', awarded);
end $$;

-- For the signed-in pitikero: every trial day and how they are doing
create or replace function public.my_allowance() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(allowance_check(auth.uid(), d) order by d), '[]'::jsonb)
  from unnest(trial_days()) d
  where auth.uid() is not null and exists (select 1 from pitikeros where id = auth.uid())
$$;

-- Hourly (and from the admin page): pay out every allowance that is earned and not yet given
create or replace function public.award_allowances() returns int
language plpgsql security definer set search_path = public as $$
declare d date; pk record; r jsonb; n int := 0;
begin
  if auth.uid() is not null and not is_admin() then raise exception 'Admins only'; end if;
  foreach d in array trial_days() loop
    continue when now() < (d::timestamp + interval '4 hours') at time zone 'Asia/Manila';
    continue when now() > (d::timestamp + interval '14 days') at time zone 'Asia/Manila';
    for pk in select id from pitikeros where status = 'active' loop
      r := allowance_check(pk.id, d);
      if (r->>'qualifies')::bool and not (r->>'awarded')::bool then
        insert into ledger (pitikero_id, kind, amount, note, trial_day)
        values (pk.id, 'allowance', (r->>'amount')::numeric, 'Trial Sunday ' || to_char(d, 'Mon DD') || ' (earned in the app)', d)
        on conflict do nothing;
        n := n + 1;
      end if;
    end loop;
  end loop;
  return n;
end $$;

-- Admin: trial days, and everyone's progress for one of them (default: the latest that has started, else the next)
create or replace function public.admin_allowances(p_day date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d date := p_day; today date := (now() at time zone 'Asia/Manila')::date;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if d is null then
    select coalesce(max(x) filter (where x <= today), min(x)) into d from unnest(trial_days()) x;
  end if;
  return jsonb_build_object('days', coalesce(cfg('trial_days'), ''), 'day', d,
    'rows', case when d is null then '[]'::jsonb else
      (select coalesce(jsonb_agg(allowance_check(id, d) || jsonb_build_object('name', name) order by name), '[]'::jsonb) from pitikeros) end);
end $$;

create or replace function public.admin_set_trial_days(p_days text) returns text
language plpgsql security definer set search_path = public as $$
declare clean text;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select string_agg(d, ',' order by d) into clean
  from unnest(string_to_array(replace(coalesce(p_days, ''), ' ', ''), ',')) d where d ~ '^\d{4}-\d{2}-\d{2}$';
  update app_config set value = coalesce(clean, '') where key = 'trial_days';
  return coalesce(clean, '');
end $$;

revoke execute on function public.trial_days(), public.allowance_check(uuid, date), public.my_allowance(), public.award_allowances(),
  public.admin_allowances(date), public.admin_set_trial_days(text) from public, anon, authenticated;
grant execute on function public.my_allowance(), public.award_allowances(), public.admin_allowances(date), public.admin_set_trial_days(text) to authenticated;
grant execute on function public.trial_days(), public.allowance_check(uuid, date), public.my_allowance(), public.award_allowances(),
  public.admin_allowances(date), public.admin_set_trial_days(text) to service_role;

select cron.schedule('pitik-allowance', '43 * * * *', $job$ select public.award_allowances(); $job$);
