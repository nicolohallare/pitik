-- Strava API Policy: don't keep Strava data (or data derived from it) longer than 7 days.
-- Rides from Strava, and the pass moments derived from them, are deleted 7 days after the ride.
-- Photos a rider already bought stay in their library (orders don't reference rides).
insert into public.app_config (key, value) values ('strava_keep_days', '7') on conflict (key) do nothing;

create or replace function public.purge_strava_rides() returns int language sql security definer set search_path = public as $$
  with d as (
    delete from rides
    where source = 'strava'
      and coalesce(ended_at, started_at, created_at) < now() - make_interval(days => cfg_num('strava_keep_days', 7)::int)
    returning 1)
  select count(*)::int from d
$$;
revoke execute on function public.purge_strava_rides() from public, anon, authenticated;

select cron.unschedule('pitik-purge-tracks');
select cron.schedule('pitik-purge-tracks', '17 * * * *', $job$ select public.purge_tracks(); select public.purge_strava_rides(); select public.expire_stale_orders(null); $job$);
