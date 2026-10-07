-- Pitik core schema
-- Matching is by time and place: a pitikero checks in (pins an exact spot) and uploads shots
-- carrying the camera's capture time. A rider's ride (Strava, GPX, or "I passed around") gives
-- the moments they passed each spot. Riders only ever see shots from around those moments.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- config
create table public.app_config (key text primary key, value text not null);
insert into public.app_config(key, value) values
  ('admin_emails', 'nicolohallare@gmail.com'),
  ('gateway_live', 'admins'),          -- 'false' | 'admins' | 'true'
  ('fee_qrph', '0.0175'),
  ('fee_card', '0.03'),
  ('pitik_fee_per_photo', '10'),
  ('pitik_fee_cap', '30'),
  ('min_price', '50'),
  ('pass_radius_m', '250'),
  ('window_minutes', '3'),
  ('track_keep_hours', '72'),
  ('notify_cutoff_hour', '20'),        -- Manila time: send the digest by 8pm even if a pitikero has not finished
  ('rider_trial_credit', '100'),
  ('app_url', 'https://pitik.vercel.app')
on conflict (key) do nothing;
alter table public.app_config enable row level security;
create policy app_config_read on public.app_config for select using (key in ('pitik_fee_per_photo','pitik_fee_cap','min_price','window_minutes','fee_qrph','fee_card','gateway_live','rider_trial_credit'));

create or replace function public.cfg(k text) returns text language sql stable security definer set search_path = public as
$$ select value from app_config where key = k $$;
create or replace function public.cfg_num(k text, d numeric) returns numeric language sql stable security definer set search_path = public as
$$ select coalesce((select nullif(value,'')::numeric from app_config where key = k), d) $$;

-- ---------------------------------------------------------------- people
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text check (char_length(display_name) <= 60),
  is_admin boolean not null default false,
  email_notify boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select is_admin from profiles where id = auth.uid()), false) $$;

create policy profiles_self_read on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_self_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- is_admin can only be changed by the service role / SQL
revoke update on public.profiles from authenticated;
grant update (display_name, email_notify) on public.profiles to authenticated;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, is_admin)
  values (new.id, new.email,
          coalesce(lower(new.email) = any (string_to_array(lower(coalesce(cfg('admin_emails'), '')), ',')), false))
  on conflict (id) do nothing;
  if coalesce(cfg_num('rider_trial_credit', 0), 0) > 0 then
    insert into credits (user_id, amount, reason) values (new.id, cfg_num('rider_trial_credit', 0), 'Founding rider credit');
  end if;
  return new;
end $$;

create table public.pitikeros (
  id uuid primary key references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  handle text unique not null check (handle ~ '^[a-z0-9_.]{2,30}$'),
  price int not null default 50,
  gcash_number text check (gcash_number ~ '^09\d{9}$'),
  gcash_name text check (char_length(gcash_name) <= 80),
  fb_page text check (char_length(fb_page) <= 120),
  status text not null default 'active' check (status in ('pending','active','paused')),
  founding boolean not null default false,
  referred_by uuid references public.pitikeros(id),
  created_at timestamptz not null default now()
);
alter table public.pitikeros enable row level security;
create policy pitikeros_public_read on public.pitikeros for select using (true);
create policy pitikeros_insert_self on public.pitikeros for insert to authenticated with check (id = auth.uid());
create policy pitikeros_update_self on public.pitikeros for update to authenticated using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());
-- GCash details are private: hide them from the public view
revoke select on public.pitikeros from anon, authenticated;
grant select (id, name, handle, price, fb_page, status, founding, created_at) on public.pitikeros to anon, authenticated;
grant insert (id, name, handle, price, gcash_number, gcash_name, fb_page, referred_by) on public.pitikeros to authenticated;
grant update (name, price, gcash_number, gcash_name, fb_page) on public.pitikeros to authenticated;

create or replace function public.check_price() returns trigger language plpgsql as $$
begin
  if new.price < cfg_num('min_price', 50) or new.price > 1000 then
    raise exception 'Price must be between ₱% and ₱1,000', cfg_num('min_price', 50);
  end if;
  return new;
end $$;
create trigger pitikeros_price before insert or update of price on public.pitikeros for each row execute function public.check_price();

-- The pitikero's own private details (GCash) through a function, not the table
create or replace function public.my_pitikero() returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(p) from pitikeros p where p.id = auth.uid()
$$;

-- ---------------------------------------------------------------- shoots and photos
-- One shoot = one morning at one exact spot. "Nandito ako" creates it.
create table public.shoots (
  id uuid primary key default gen_random_uuid(),
  pitikero_id uuid not null references public.pitikeros(id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  accuracy_m real,
  pin_source text not null default 'phone' check (pin_source in ('phone','map','photos')),
  place_label text check (char_length(place_label) <= 80),
  checked_in_at timestamptz not null default now(),
  clock_offset_ms bigint not null default 0,       -- added to camera time to get true time
  clock_checked boolean not null default false,
  first_shot_at timestamptz,
  last_shot_at timestamptz,
  photo_count int not null default 0,
  done_at timestamptz,                              -- "Tapos na ako" — all shots uploaded
  created_at timestamptz not null default now()
);
create index shoots_time on public.shoots (first_shot_at, last_shot_at);
create index shoots_pk on public.shoots (pitikero_id, checked_in_at desc);
alter table public.shoots enable row level security;
-- Spots and times are what riders match against; they are not secret (a pitikero stands on a public road).
create policy shoots_read on public.shoots for select using (true);
create policy shoots_insert_self on public.shoots for insert to authenticated with check (pitikero_id = auth.uid());
create policy shoots_update_self on public.shoots for update to authenticated using (pitikero_id = auth.uid() or public.is_admin()) with check (pitikero_id = auth.uid() or public.is_admin());
revoke update on public.shoots from authenticated;
grant update (lat, lon, accuracy_m, pin_source, place_label, clock_offset_ms, clock_checked, done_at) on public.shoots to authenticated;

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  shoot_id uuid not null references public.shoots(id) on delete cascade,
  pitikero_id uuid not null references public.pitikeros(id) on delete cascade,
  camera_time timestamptz not null,                 -- as written by the camera (EXIF)
  taken_at timestamptz not null,                    -- camera_time + shoot.clock_offset_ms
  camera text check (char_length(camera) <= 80),
  width int, height int,
  original_path text not null,                      -- private bucket "originals"
  preview_path text not null,                       -- public bucket "previews" (watermarked)
  thumb_path text not null,                         -- public bucket "previews" (watermarked, small)
  source_key text not null check (char_length(source_key) <= 200),   -- file name + size, to skip re-uploads
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  unique (shoot_id, source_key)
);
create index photos_shoot_time on public.photos (shoot_id, taken_at);
create index photos_pk_time on public.photos (pitikero_id, taken_at);
alter table public.photos enable row level security;
-- No blanket read: riders reach photos only through photos_for_pass()/photos_near() or their orders.
create policy photos_owner_read on public.photos for select to authenticated using (pitikero_id = auth.uid() or public.is_admin());
create policy photos_owner_insert on public.photos for insert to authenticated with check (
  pitikero_id = auth.uid() and exists (select 1 from shoots s where s.id = shoot_id and s.pitikero_id = auth.uid()));
create policy photos_owner_update on public.photos for update to authenticated using (pitikero_id = auth.uid() or public.is_admin());
create policy photos_owner_delete on public.photos for delete to authenticated using (pitikero_id = auth.uid() or public.is_admin());
revoke update on public.photos from authenticated;
grant update (hidden) on public.photos to authenticated;

-- taken_at always follows the shoot's clock correction
create or replace function public.photo_set_time() returns trigger language plpgsql security definer set search_path = public as $$
begin
  select new.camera_time + make_interval(secs => s.clock_offset_ms / 1000.0) into new.taken_at from shoots s where s.id = new.shoot_id;
  return new;
end $$;
create trigger photos_time before insert on public.photos for each row execute function public.photo_set_time();

create or replace function public.shoot_refresh_stats(p_shoot uuid) returns void language sql security definer set search_path = public as $$
  update shoots s set
    first_shot_at = x.f, last_shot_at = x.l, photo_count = x.n
  from (select min(taken_at) f, max(taken_at) l, count(*)::int n from photos where shoot_id = p_shoot and not hidden) x
  where s.id = p_shoot;
$$;
create or replace function public.photos_after_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform shoot_refresh_stats(coalesce(new.shoot_id, old.shoot_id));
  return null;
end $$;
create trigger photos_stats after insert or delete or update of hidden on public.photos for each row execute function public.photos_after_change();

-- Clock correction applied after shots are uploaded: shift every photo of the shoot
create or replace function public.shoot_clock_changed() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.clock_offset_ms is distinct from old.clock_offset_ms then
    update photos set taken_at = camera_time + make_interval(secs => new.clock_offset_ms / 1000.0) where shoot_id = new.id;
    perform shoot_refresh_stats(new.id);
    perform rematch_shoot(new.id);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- rides and passes
create table public.strava_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  athlete_id bigint unique not null,
  athlete_name text,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text,
  write_ok boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.strava_accounts enable row level security;   -- server only: no policies

create or replace function public.my_strava() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('athlete_name', athlete_name, 'write_ok', write_ok, 'connected_at', created_at)
  from strava_accounts where user_id = auth.uid()
$$;

create table public.rides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source text not null check (source in ('strava','gpx','manual')),
  strava_activity_id bigint unique,
  name text check (char_length(name) <= 120),
  started_at timestamptz,
  ended_at timestamptz,
  track jsonb,                     -- thinned [{t,lat,lon}], kept briefly to match late uploads, then wiped
  track_expires_at timestamptz,
  notified_at timestamptz,
  followup_at timestamptz,
  strava_line text,
  created_at timestamptz not null default now()
);
create index rides_user on public.rides (user_id, started_at desc);
alter table public.rides enable row level security;
create policy rides_own on public.rides for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy rides_own_delete on public.rides for delete to authenticated using (user_id = auth.uid());
revoke select on public.rides from authenticated;
grant select (id, user_id, source, strava_activity_id, name, started_at, ended_at, notified_at, created_at) on public.rides to authenticated;
grant delete on public.rides to authenticated;

create table public.passes (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  shoot_id uuid not null references public.shoots(id) on delete cascade,
  passed_at timestamptz not null,
  distance_m real,
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  unique (ride_id, shoot_id, passed_at)
);
create index passes_user on public.passes (user_id, passed_at desc);
create index passes_shoot on public.passes (shoot_id);
alter table public.passes enable row level security;
create policy passes_own on public.passes for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- Haversine distance in metres
create or replace function public.dist_m(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision)
returns double precision language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lon2 - lon1) / 2), 2)))
$$;

-- Find every moment a ride's track came within pass_radius_m of a shoot's spot while it was shooting.
-- A rider going up and down Taktak twice gets two passes. Returns the number of passes recorded.
create or replace function public.match_ride(p_ride uuid, p_shoot uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; radius double precision := cfg_num('pass_radius_m', 250);
begin
  select * into r from rides where id = p_ride;
  if r.id is null or r.track is null then return 0; end if;
  with pts as (
    select (e->>'t')::timestamptz t, (e->>'lat')::double precision lat, (e->>'lon')::double precision lon
    from jsonb_array_elements(r.track) e
  ),
  cand as (
    select s.id shoot_id, p.t, dist_m(p.lat, p.lon, s.lat, s.lon) d
    from shoots s join pts p
      on p.t between coalesce(s.first_shot_at, s.checked_in_at) - interval '15 minutes'
                 and coalesce(s.last_shot_at, s.checked_in_at + interval '4 hours') + interval '15 minutes'
    where (p_shoot is null or s.id = p_shoot)
      and s.checked_in_at between r.started_at - interval '12 hours' and coalesce(r.ended_at, r.started_at) + interval '12 hours'
      and dist_m(p.lat, p.lon, s.lat, s.lon) <= radius
  ),
  seg as (
    select *, sum(case when prev is null or t - prev > interval '2 minutes' then 1 else 0 end)
               over (partition by shoot_id order by t) g
    from (select *, lag(t) over (partition by shoot_id order by t) prev from cand) x
  ),
  best as (
    select distinct on (shoot_id, g) shoot_id, t, d from seg order by shoot_id, g, d, t
  ),
  ins as (
    insert into passes (ride_id, user_id, shoot_id, passed_at, distance_m)
    select r.id, r.user_id, shoot_id, t, d from best
    on conflict (ride_id, shoot_id, passed_at) do nothing
    returning 1
  )
  select count(*) into n from ins;
  return n;
end $$;
revoke all on function public.match_ride(uuid, uuid) from public, anon, authenticated;

-- When a shoot's photos arrive (or its clock changes) after rides were recorded, match those rides again.
create or replace function public.rematch_shoot(p_shoot uuid) returns int language plpgsql security definer set search_path = public as $$
declare s record; rr record; n int := 0;
begin
  select * into s from shoots where id = p_shoot;
  if s.id is null then return 0; end if;
  delete from passes where shoot_id = p_shoot and not manual;
  for rr in select id from rides
            where track is not null
              and started_at between s.checked_in_at - interval '12 hours' and s.checked_in_at + interval '12 hours'
  loop
    n := n + match_ride(rr.id, p_shoot);
  end loop;
  return n;
end $$;
revoke all on function public.rematch_shoot(uuid) from public, anon, authenticated;

-- Pitikero finished a batch (or the whole morning): refresh counts and match rides again
create or replace function public.shoot_uploaded(p_shoot uuid, p_done boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not exists (select 1 from shoots where id = p_shoot and pitikero_id = auth.uid()) then raise exception 'Not your shoot'; end if;
  perform shoot_refresh_stats(p_shoot);
  if p_done then update shoots set done_at = coalesce(done_at, now()) where id = p_shoot; end if;
  n := rematch_shoot(p_shoot);
  return jsonb_build_object('passes', n, 'photos', (select photo_count from shoots where id = p_shoot));
end $$;
revoke all on function public.shoot_uploaded(uuid, boolean) from anon;

create trigger shoots_clock after update of clock_offset_ms on public.shoots for each row execute function public.shoot_clock_changed();

-- Thin a track to one point every ~5 s and store it with an expiry
create or replace function public.thin_track(p jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(e order by t), '[]'::jsonb) from (
    select distinct on (floor(extract(epoch from (e->>'t')::timestamptz) / 5)) e, (e->>'t')::timestamptz t
    from jsonb_array_elements(p) e
    where (e->>'lat') is not null and (e->>'lon') is not null and (e->>'t') is not null
    order by floor(extract(epoch from (e->>'t')::timestamptz) / 5), (e->>'t')::timestamptz
  ) x
$$;

-- Server (Strava) ingest: creates or replaces a ride and matches it
create or replace function public.ingest_ride(p_user uuid, p_source text, p_activity bigint, p_name text,
  p_start timestamptz, p_end timestamptz, p_track jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rid uuid; n int; tr jsonb := thin_track(p_track);
begin
  if p_activity is not null then
    select id into rid from rides where strava_activity_id = p_activity;
  end if;
  if rid is null then
    insert into rides (user_id, source, strava_activity_id, name, started_at, ended_at, track, track_expires_at)
    values (p_user, p_source, p_activity, left(p_name, 120), p_start, p_end, tr,
            now() + make_interval(hours => cfg_num('track_keep_hours', 72)::int))
    returning id into rid;
  else
    update rides set name = left(p_name, 120), started_at = p_start, ended_at = p_end, track = tr,
      track_expires_at = now() + make_interval(hours => cfg_num('track_keep_hours', 72)::int) where id = rid;
    delete from passes where ride_id = rid and not manual;
  end if;
  n := match_ride(rid);
  return jsonb_build_object('ride_id', rid, 'passes', n);
end $$;
revoke all on function public.ingest_ride(uuid, text, bigint, text, timestamptz, timestamptz, jsonb) from public, anon, authenticated;

-- Rider uploads a GPX (parsed in the browser into [{t,lat,lon}])
create or replace function public.add_gpx_ride(p_name text, p_track jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s timestamptz; e timestamptz;
begin
  if me is null then raise exception 'Please sign in again'; end if;
  if jsonb_typeof(p_track) <> 'array' or jsonb_array_length(p_track) < 10 then raise exception 'That ride file has too few points'; end if;
  if jsonb_array_length(p_track) > 40000 then raise exception 'That ride file is too long'; end if;
  select min((x->>'t')::timestamptz), max((x->>'t')::timestamptz) into s, e from jsonb_array_elements(p_track) x;
  return ingest_ride(me, 'gpx', null, coalesce(nullif(p_name, ''), 'Ride'), s, e, p_track);
end $$;
revoke all on function public.add_gpx_ride(text, jsonb) from anon;

-- No Strava, no GPX: "I passed this pitikero around 6:40"
create or replace function public.add_manual_pass(p_shoot uuid, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); rid uuid; s record;
begin
  if me is null then raise exception 'Please sign in again'; end if;
  select * into s from shoots where id = p_shoot;
  if s.id is null then raise exception 'That pitikero session no longer exists'; end if;
  if p_at < s.checked_in_at - interval '2 hours' or p_at > coalesce(s.last_shot_at, s.checked_in_at) + interval '2 hours' then
    raise exception 'That time is outside when this pitikero was shooting';
  end if;
  select id into rid from rides where user_id = me and source = 'manual' and started_at::date = p_at::date limit 1;
  if rid is null then
    insert into rides (user_id, source, name, started_at, ended_at) values (me, 'manual', 'Ride', p_at, p_at) returning id into rid;
  end if;
  insert into passes (ride_id, user_id, shoot_id, passed_at, manual) values (rid, me, p_shoot, p_at, true)
  on conflict do nothing;
  return jsonb_build_object('ride_id', rid);
end $$;
revoke all on function public.add_manual_pass(uuid, timestamptz) from anon;

-- Photos a rider may see for one of their passes: only the minutes around the pass.
create or replace function public.photos_for_pass(p_pass uuid, p_minutes int default null)
returns table (id uuid, pitikero_id uuid, taken_at timestamptz, preview_path text, thumb_path text, price int, bought boolean)
language plpgsql stable security definer set search_path = public as $$
declare ps record; w int;
begin
  select * into ps from passes where passes.id = p_pass and (passes.user_id = auth.uid() or is_admin());
  if ps.id is null then return; end if;
  if ps.manual then
    w := least(greatest(coalesce(p_minutes, 10), 5), 15);
  else
    w := least(greatest(coalesce(p_minutes, cfg_num('window_minutes', 3)::int), 1), 10);
  end if;
  return query
    select ph.id, ph.pitikero_id, ph.taken_at, ph.preview_path, ph.thumb_path, pk.price,
      exists (select 1 from order_items oi join orders o on o.id = oi.order_id
              where oi.photo_id = ph.id and o.user_id = auth.uid() and o.status = 'paid')
    from photos ph join pitikeros pk on pk.id = ph.pitikero_id
    where ph.shoot_id = ps.shoot_id and not ph.hidden
      and ph.taken_at between ps.passed_at - make_interval(mins => w) and ps.passed_at + make_interval(mins => w)
    order by ph.taken_at
    limit 200;
end $$;
revoke all on function public.photos_for_pass(uuid, int) from anon;

-- Everything the rider's ride page needs in one call
create or replace function public.my_rides(p_limit int default 20) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(r order by r.started_at desc nulls last), '[]'::jsonb) from (
    select rd.id, rd.source, rd.name, rd.started_at, rd.strava_activity_id,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id, 'passed_at', p.passed_at, 'manual', p.manual, 'distance_m', p.distance_m,
          'shoot_id', s.id, 'place_label', s.place_label, 'pitikero', jsonb_build_object('id', pk.id, 'name', pk.name, 'handle', pk.handle, 'price', pk.price),
          'shoot_done', s.done_at is not null,
          'count', (select count(*) from photos ph where ph.shoot_id = s.id and not ph.hidden
                     and ph.taken_at between p.passed_at - make_interval(mins => cfg_num('window_minutes',3)::int) and p.passed_at + make_interval(mins => cfg_num('window_minutes',3)::int)))
        order by p.passed_at), '[]'::jsonb)
        from passes p join shoots s on s.id = p.shoot_id join pitikeros pk on pk.id = s.pitikero_id
        where p.ride_id = rd.id) passes
    from rides rd where rd.user_id = auth.uid()
    order by rd.started_at desc nulls last
    limit least(p_limit, 50)
  ) r
$$;

-- Pitikeros shooting on a given day, for the "no Strava" path
create or replace function public.shoots_on(p_day date) returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'place_label', s.place_label, 'first_shot_at', s.first_shot_at,
    'last_shot_at', s.last_shot_at, 'photo_count', s.photo_count, 'pitikero', jsonb_build_object('name', pk.name, 'handle', pk.handle))
    order by s.first_shot_at), '[]'::jsonb)
  from shoots s join pitikeros pk on pk.id = s.pitikero_id
  where (s.checked_in_at at time zone 'Asia/Manila')::date = p_day and s.photo_count > 0
$$;

-- ---------------------------------------------------------------- money
create table public.credits (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  reason text,
  used_order_id uuid,
  created_at timestamptz not null default now()
);
alter table public.credits enable row level security;
create policy credits_own on public.credits for select to authenticated using (user_id = auth.uid() or public.is_admin());

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  status text not null default 'pending' check (status in ('pending','paid','cancelled','review')),
  photos_amount numeric(10,2) not null,
  tips_amount numeric(10,2) not null default 0,
  fee_amount numeric(10,2) not null default 0,
  credit_amount numeric(10,2) not null default 0,
  total numeric(10,2) not null,                    -- what the rider pays through TechPay (before gateway fee)
  gateway_ref text unique,
  gateway_status text,
  gateway_fee numeric(10,2),
  gateway_payload jsonb,
  admin_note text,
  is_test boolean not null default false,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index orders_user on public.orders (user_id, created_at desc);
alter table public.orders enable row level security;
create policy orders_own on public.orders for select to authenticated using (user_id = auth.uid() or public.is_admin());

create table public.order_items (
  order_id uuid not null references public.orders(id) on delete cascade,
  photo_id uuid not null references public.photos(id),
  pitikero_id uuid not null references public.pitikeros(id),
  price numeric(10,2) not null,
  primary key (order_id, photo_id)
);
alter table public.order_items enable row level security;
create policy order_items_own on public.order_items for select to authenticated using (
  exists (select 1 from orders o where o.id = order_id and (o.user_id = auth.uid() or public.is_admin())) or pitikero_id = auth.uid());

create table public.order_tips (
  order_id uuid not null references public.orders(id) on delete cascade,
  pitikero_id uuid not null references public.pitikeros(id),
  amount numeric(10,2) not null check (amount >= 0 and amount <= 5000),
  primary key (order_id, pitikero_id)
);
alter table public.order_tips enable row level security;
create policy order_tips_own on public.order_tips for select to authenticated using (
  exists (select 1 from orders o where o.id = order_id and (o.user_id = auth.uid() or public.is_admin())) or pitikero_id = auth.uid());

-- Everything Pitik owes a pitikero. Payouts settle ledger rows.
create table public.payouts (
  id uuid primary key default gen_random_uuid(),
  pitikero_id uuid not null references public.pitikeros(id),
  amount numeric(10,2) not null check (amount > 0),
  gcash_number text,
  gcash_ref text check (char_length(gcash_ref) <= 60),
  receipt_path text,
  note text,
  paid_at timestamptz not null default now(),
  paid_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.payouts enable row level security;
create policy payouts_read on public.payouts for select to authenticated using (pitikero_id = auth.uid() or public.is_admin());

create table public.ledger (
  id bigint generated always as identity primary key,
  pitikero_id uuid not null references public.pitikeros(id),
  kind text not null check (kind in ('sale','tip','allowance','referral','adjustment')),
  amount numeric(10,2) not null,
  order_id uuid references public.orders(id),
  photo_id uuid references public.photos(id),
  note text,
  payout_id uuid references public.payouts(id),
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id)
);
create index ledger_pk on public.ledger (pitikero_id, created_at desc);
create unique index ledger_once on public.ledger (order_id, photo_id, kind) where order_id is not null;
alter table public.ledger enable row level security;
create policy ledger_read on public.ledger for select to authenticated using (pitikero_id = auth.uid() or public.is_admin());

-- Order creation: the server works out prices, fee, credit. Client only says which photos and tips.
create or replace function public.create_order(p_photo_ids uuid[], p_tips jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); oid uuid; n int; photos_amt numeric := 0; tips_amt numeric := 0; fee numeric; credit numeric := 0;
  k text; v numeric; live text; allowed int;
begin
  if me is null then raise exception 'Please sign in again'; end if;
  if p_photo_ids is null or array_length(p_photo_ids, 1) is null then raise exception 'Pick at least one photo'; end if;
  if array_length(p_photo_ids, 1) > 100 then raise exception 'That is a lot of photos. Pick up to 100 at a time.'; end if;

  -- Only photos the rider is allowed to see: within the window of one of their passes
  select count(*) into allowed from photos ph
  where ph.id = any(p_photo_ids) and not ph.hidden and exists (
    select 1 from passes ps where ps.user_id = me and ps.shoot_id = ph.shoot_id
      and ph.taken_at between ps.passed_at - interval '15 minutes' and ps.passed_at + interval '15 minutes');
  if allowed <> (select count(distinct x) from unnest(p_photo_ids) x) then raise exception 'Some of those photos are not from your ride'; end if;

  insert into orders (user_id, photos_amount, total) values (me, 0, 0) returning id into oid;
  insert into order_items (order_id, photo_id, pitikero_id, price)
    select oid, ph.id, ph.pitikero_id, pk.price from photos ph join pitikeros pk on pk.id = ph.pitikero_id
    where ph.id = any(p_photo_ids)
      and not exists (select 1 from order_items oi join orders o on o.id = oi.order_id where oi.photo_id = ph.id and o.user_id = me and o.status = 'paid');
  get diagnostics n = row_count;
  if n = 0 then delete from orders where id = oid; raise exception 'You already own these photos'; end if;
  select coalesce(sum(price), 0) into photos_amt from order_items where order_id = oid;

  for k, v in select key, value::numeric from jsonb_each_text(coalesce(p_tips, '{}'::jsonb)) loop
    if v > 0 and exists (select 1 from order_items where order_id = oid and pitikero_id = k::uuid) then
      if v > 5000 then raise exception 'Tips are capped at ₱5,000 per pitikero'; end if;
      insert into order_tips (order_id, pitikero_id, amount) values (oid, k::uuid, round(v, 2));
      tips_amt := tips_amt + round(v, 2);
    end if;
  end loop;

  fee := least(n * cfg_num('pitik_fee_per_photo', 10), cfg_num('pitik_fee_cap', 30));
  select coalesce(sum(amount), 0) into credit from credits where user_id = me and used_order_id is null;
  credit := least(credit, photos_amt + tips_amt + fee);

  update orders set photos_amount = photos_amt, tips_amount = tips_amt, fee_amount = fee, credit_amount = credit,
    total = photos_amt + tips_amt + fee - credit where id = oid;
  return jsonb_build_object('id', oid, 'photos', n, 'photos_amount', photos_amt, 'tips_amount', tips_amt,
    'fee_amount', fee, 'credit_amount', credit, 'total', photos_amt + tips_amt + fee - credit);
end $$;
revoke all on function public.create_order(uuid[], jsonb) from anon;

-- Fulfil an order exactly once: pay the pitikeros (ledger), use the credit.
create or replace function public.fulfil_order(p_order uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into ledger (pitikero_id, kind, amount, order_id, photo_id)
    select pitikero_id, 'sale', price, order_id, photo_id from order_items where order_id = p_order
    on conflict do nothing;
  insert into ledger (pitikero_id, kind, amount, order_id, note)
    select pitikero_id, 'tip', amount, order_id, 'Tip' from order_tips where order_id = p_order and amount > 0
    and not exists (select 1 from ledger l where l.order_id = p_order and l.kind = 'tip' and l.pitikero_id = order_tips.pitikero_id);
  -- mark credits used, oldest first, up to the credit applied
  with o as (select user_id, credit_amount from orders where id = p_order),
  c as (select cr.id, sum(cr.amount) over (order by cr.created_at, cr.id) running, cr.amount
        from credits cr, o where cr.user_id = o.user_id and cr.used_order_id is null)
  update credits set used_order_id = p_order
  where id in (select c.id from c, o where c.running - c.amount < o.credit_amount);
  -- give back whatever part of the last credit was not needed
  insert into credits (user_id, amount, reason)
  select o.user_id, x.used - o.credit_amount, 'Remaining credit'
  from orders o, (select coalesce(sum(amount), 0) used from credits where used_order_id = p_order) x
  where o.id = p_order and x.used - o.credit_amount > 0.004
    and not exists (select 1 from credits where reason = 'Remaining credit' and user_id = o.user_id and created_at > now() - interval '1 second');
end $$;
revoke all on function public.fulfil_order(uuid) from public, anon, authenticated;

-- Orders fully covered by credit settle without the gateway
create or replace function public.settle_free_order(p_order uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from orders where id = p_order and user_id = auth.uid() for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status = 'paid' then return jsonb_build_object('ok', true, 'already', true); end if;
  if o.total > 0 then raise exception 'This order needs payment'; end if;
  update orders set status = 'paid', paid_at = now(), gateway_ref = 'PTKCREDIT' || replace(o.id::text, '-', '') where id = o.id;
  perform fulfil_order(o.id);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.settle_free_order(uuid) from anon;

-- TechPay (pattern from the techpay-gateway skill)
create table public.gateway_webhook_log (
  id bigserial primary key,
  received_at timestamptz not null default now(),
  source_ip text, reference text, amount numeric, status text,
  signature_received text, signature_expected text, signature_ok boolean,
  outcome text, payload jsonb
);
alter table public.gateway_webhook_log enable row level security;
create policy webhook_log_admin on public.gateway_webhook_log for select to authenticated using (public.is_admin());

create or replace function public.start_order_payment(p_order uuid, p_reference text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); live text; o record;
begin
  if me is null then raise exception 'Please sign in again'; end if;
  live := coalesce(cfg('gateway_live'), 'false');
  if live = 'false' then raise exception 'Online payment is not available yet'; end if;
  if live = 'admins' and not is_admin() then raise exception 'Online payment is being trialled by the Pitik team first'; end if;
  select * into o from orders where id = p_order and user_id = me for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status <> 'pending' then raise exception 'This order is already %', o.status; end if;
  if o.total < 1 then raise exception 'Nothing to pay'; end if;
  update orders set gateway_ref = p_reference, gateway_status = 'pending' where id = o.id;
  return jsonb_build_object('ok', true, 'id', o.id, 'amount', o.total, 'reference', p_reference);
end $$;
revoke all on function public.start_order_payment(uuid, text) from anon;

create or replace function public.settle_gateway_payment(p_reference text, p_amount numeric, p_status text,
  p_fee numeric default null, p_payload jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  select * into t from orders where gateway_ref = p_reference for update;
  if t.id is null then return jsonb_build_object('ok', false, 'reason', 'unknown reference'); end if;
  if t.status = 'paid' then return jsonb_build_object('ok', true, 'already', true); end if;
  if p_status = 'completed' then
    if abs(coalesce(p_amount, 0) - t.total) > 0.005 then
      update orders set status = 'review', gateway_status = p_status, gateway_payload = p_payload,
        admin_note = coalesce(admin_note || ' | ', '') || 'Gateway reported ₱' || p_amount || ' against ₱' || t.total || ', held for review'
      where id = t.id;
      return jsonb_build_object('ok', false, 'reason', 'amount mismatch');
    end if;
    update orders set status = 'paid', gateway_status = p_status, gateway_fee = p_fee, gateway_payload = p_payload, paid_at = now()
    where id = t.id;
    perform fulfil_order(t.id);
    return jsonb_build_object('ok', true, 'fulfilled', t.total);
  elsif p_status = 'cancelled' then
    update orders set status = 'cancelled', gateway_status = p_status, gateway_payload = p_payload,
      admin_note = coalesce(admin_note || ' | ', '') || 'Cancelled or expired at the gateway'
    where id = t.id and status <> 'paid';
    return jsonb_build_object('ok', true, 'cancelled', true);
  end if;
  update orders set gateway_status = p_status, gateway_payload = p_payload where id = t.id;
  return jsonb_build_object('ok', true, 'pending', true);
end $$;
revoke all on function public.settle_gateway_payment(text, numeric, text, numeric, jsonb) from public, anon, authenticated;

create or replace function public.log_gateway_webhook(p_ip text, p_reference text, p_amount numeric, p_status text,
  p_sig_recv text, p_sig_exp text, p_ok boolean, p_outcome text, p_payload jsonb) returns void
language sql security definer set search_path = public as $$
  insert into gateway_webhook_log (source_ip, reference, amount, status, signature_received, signature_expected, signature_ok, outcome, payload)
  values (p_ip, p_reference, p_amount, p_status, p_sig_recv, p_sig_exp, p_ok, p_outcome, p_payload);
$$;
revoke all on function public.log_gateway_webhook(text, text, numeric, text, text, text, boolean, text, jsonb) from public, anon, authenticated;

-- Purchased photos: the rider's library
create or replace function public.my_purchases() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('photo_id', ph.id, 'taken_at', ph.taken_at, 'original_path', ph.original_path,
    'preview_path', ph.preview_path, 'pitikero', pk.name, 'paid_at', o.paid_at) order by ph.taken_at desc), '[]'::jsonb)
  from orders o join order_items oi on oi.order_id = o.id join photos ph on ph.id = oi.photo_id join pitikeros pk on pk.id = ph.pitikero_id
  where o.user_id = auth.uid() and o.status = 'paid'
$$;

-- Pitikero earnings: balance and recent lines
create or replace function public.my_kita() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'unpaid', coalesce((select sum(amount) from ledger where pitikero_id = auth.uid() and payout_id is null), 0),
    'week_sales', coalesce((select sum(amount) from ledger where pitikero_id = auth.uid() and kind = 'sale' and created_at >= date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila'), 0),
    'week_tips', coalesce((select sum(amount) from ledger where pitikero_id = auth.uid() and kind = 'tip' and created_at >= date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila'), 0),
    'week_photos', (select count(*) from ledger where pitikero_id = auth.uid() and kind = 'sale' and created_at >= date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila'),
    'week_tippers', (select count(distinct order_id) from ledger where pitikero_id = auth.uid() and kind = 'tip' and created_at >= date_trunc('week', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila'),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'amount', amount, 'note', note, 'at', created_at, 'paid', payout_id is not null) order by created_at desc)
              from (select * from ledger where pitikero_id = auth.uid() order by created_at desc limit 60) l), '[]'::jsonb),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'gcash_ref', gcash_ref, 'receipt_path', receipt_path, 'paid_at', paid_at, 'note', note) order by paid_at desc)
              from payouts where pitikero_id = auth.uid()), '[]'::jsonb)
  )
$$;

-- ---------------------------------------------------------------- admin
create or replace function public.admin_balances() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return (select coalesce(jsonb_agg(x order by x.unpaid desc), '[]'::jsonb) from (
    select pk.id, pk.name, pk.handle, pk.gcash_number, pk.gcash_name, pk.founding, pk.status,
      coalesce(sum(l.amount) filter (where l.payout_id is null), 0) unpaid,
      coalesce(sum(l.amount) filter (where l.payout_id is null and l.kind = 'sale'), 0) unpaid_sales,
      coalesce(sum(l.amount) filter (where l.payout_id is null and l.kind = 'tip'), 0) unpaid_tips,
      coalesce(sum(l.amount) filter (where l.payout_id is null and l.kind in ('allowance','referral','adjustment')), 0) unpaid_extras,
      (select max(paid_at) from payouts po where po.pitikero_id = pk.id) last_paid_at
    from pitikeros pk left join ledger l on l.pitikero_id = pk.id
    group by pk.id) x);
end $$;

create or replace function public.admin_record_payout(p_pitikero uuid, p_amount numeric, p_ref text, p_receipt text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pid uuid; unpaid numeric; gnum text;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select coalesce(sum(amount), 0) into unpaid from ledger where pitikero_id = p_pitikero and payout_id is null;
  if abs(unpaid - p_amount) > 0.005 then raise exception 'The balance changed to ₱%. Refresh and try again.', unpaid; end if;
  if p_amount <= 0 then raise exception 'Nothing to pay'; end if;
  select gcash_number into gnum from pitikeros where id = p_pitikero;
  insert into payouts (pitikero_id, amount, gcash_number, gcash_ref, receipt_path, note, paid_by)
  values (p_pitikero, p_amount, gnum, nullif(p_ref, ''), nullif(p_receipt, ''), nullif(p_note, ''), auth.uid()) returning id into pid;
  update ledger set payout_id = pid where pitikero_id = p_pitikero and payout_id is null;
  return jsonb_build_object('ok', true, 'payout_id', pid);
end $$;

create or replace function public.admin_add_extra(p_pitikero uuid, p_kind text, p_amount numeric, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_kind not in ('allowance','referral','adjustment') then raise exception 'Unknown kind'; end if;
  insert into ledger (pitikero_id, kind, amount, note, created_by) values (p_pitikero, p_kind, p_amount, p_note, auth.uid());
end $$;

create or replace function public.admin_give_credit(p_email text, p_amount numeric, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  select id into uid from profiles where lower(email) = lower(p_email);
  if uid is null then raise exception 'No rider with that email yet'; end if;
  insert into credits (user_id, amount, reason) values (uid, p_amount, p_reason);
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
    'review', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'ref', gateway_ref, 'total', total, 'note', admin_note)), '[]'::jsonb) from orders where status = 'review'),
    'recent_orders', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select o.id, o.status, o.total, o.photos_amount, o.tips_amount, o.fee_amount, o.credit_amount, o.gateway_ref, o.created_at, o.paid_at, p.email
        from orders o join profiles p on p.id = o.user_id order by o.created_at desc limit 30) x),
    'webhooks', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select received_at, reference, status, signature_ok, outcome from gateway_webhook_log order by received_at desc limit 20) x)
  );
end $$;

-- ---------------------------------------------------------------- feedback
create table public.feedback (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid references public.profiles(id) on delete set null,
  name text check (char_length(name) <= 80),
  role text check (role in ('pitikero','rider','other')),
  would_use text check (char_length(would_use) <= 20),
  checkin_easy smallint check (checkin_easy between 1 and 5),
  price_ok text check (char_length(price_ok) <= 20),
  liked text check (char_length(liked) <= 2000),
  confusing text check (char_length(confusing) <= 2000),
  missing text check (char_length(missing) <= 2000),
  contact text check (char_length(contact) <= 80),
  page text check (char_length(page) <= 80)
);
alter table public.feedback enable row level security;
create policy feedback_insert on public.feedback for insert to anon, authenticated with check (user_id is null or user_id = auth.uid());
create policy feedback_admin on public.feedback for select to authenticated using (public.is_admin());
revoke all on public.feedback from anon, authenticated;
grant insert on public.feedback to anon, authenticated;
grant select on public.feedback to authenticated;

-- ---------------------------------------------------------------- notifications
-- Rides ready for the one consolidated message: every pitikero it passed has finished uploading,
-- or it is past the cutoff on the ride day. One follow-up at most if more shots arrive later.
create or replace function public.rides_to_notify() returns jsonb language plpgsql security definer set search_path = public as $$
declare cutoff int := cfg_num('notify_cutoff_hour', 20)::int;
begin
  return (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select rd.id ride_id, rd.user_id, pr.email, pr.email_notify, rd.strava_activity_id, rd.name, rd.started_at,
      rd.notified_at, rd.strava_line,
      (rd.notified_at is not null) is_followup,
      (select jsonb_agg(jsonb_build_object('pitikero', pk.name, 'passed_at', ps.passed_at,
          'count', (select count(*) from photos ph where ph.shoot_id = ps.shoot_id and not ph.hidden
                    and ph.taken_at between ps.passed_at - make_interval(mins => cfg_num('window_minutes',3)::int) and ps.passed_at + make_interval(mins => cfg_num('window_minutes',3)::int)),
          'thumb', (select ph.thumb_path from photos ph where ph.shoot_id = ps.shoot_id and not ph.hidden order by abs(extract(epoch from ph.taken_at - ps.passed_at)) limit 1))
        order by ps.passed_at)
       from passes ps join shoots s on s.id = ps.shoot_id join pitikeros pk on pk.id = s.pitikero_id where ps.ride_id = rd.id) passes
    from rides rd join profiles pr on pr.id = rd.user_id
    where rd.started_at > now() - interval '3 days'
      and rd.followup_at is null
      and exists (select 1 from passes ps join photos ph on ph.shoot_id = ps.shoot_id
                  where ps.ride_id = rd.id and not ph.hidden
                    and ph.taken_at between ps.passed_at - make_interval(mins => cfg_num('window_minutes',3)::int) and ps.passed_at + make_interval(mins => cfg_num('window_minutes',3)::int))
      and (
        -- first message: all passed shoots done, or past cutoff on ride day (Manila)
        (rd.notified_at is null and (
           not exists (select 1 from passes ps join shoots s on s.id = ps.shoot_id where ps.ride_id = rd.id and s.done_at is null)
           or (now() at time zone 'Asia/Manila') >= ((rd.started_at at time zone 'Asia/Manila')::date + make_interval(hours => cutoff))))
        or
        -- one follow-up: new photos landed after the first message, and the shoots are now done
        (rd.notified_at is not null and exists (
           select 1 from passes ps join photos ph on ph.shoot_id = ps.shoot_id
           where ps.ride_id = rd.id and ph.created_at > rd.notified_at + interval '10 minutes'
             and ph.taken_at between ps.passed_at - make_interval(mins => cfg_num('window_minutes',3)::int) and ps.passed_at + make_interval(mins => cfg_num('window_minutes',3)::int))
         and not exists (select 1 from passes ps join shoots s on s.id = ps.shoot_id where ps.ride_id = rd.id and s.done_at is null))
      )
    limit 50) x);
end $$;
revoke all on function public.rides_to_notify() from public, anon, authenticated;

create or replace function public.mark_notified(p_ride uuid, p_line text) returns void language sql security definer set search_path = public as $$
  update rides set
    followup_at = case when notified_at is not null then now() else followup_at end,
    notified_at = coalesce(notified_at, now()),
    strava_line = coalesce(p_line, strava_line)
  where id = p_ride;
$$;
revoke all on function public.mark_notified(uuid, text) from public, anon, authenticated;

-- Server functions read the cron secret to authenticate scheduled calls
create or replace function public.check_cron_secret(p text) returns boolean language sql stable security definer set search_path = public, vault as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'pitik_cron_secret' and decrypted_secret = p)
$$;
revoke all on function public.check_cron_secret(text) from public, anon, authenticated;

-- Wipe stored ride tracks once they are no longer needed for late uploads
create or replace function public.purge_tracks() returns int language sql security definer set search_path = public as $$
  with u as (update rides set track = null where track is not null and track_expires_at < now() returning 1) select count(*)::int from u
$$;

-- ---------------------------------------------------------------- new users (after credits exists)
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
