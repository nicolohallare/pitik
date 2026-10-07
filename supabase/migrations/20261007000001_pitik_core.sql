-- Pitik core schema
-- Matching is by time and place: a pitikero checks in (pins an exact spot) and uploads shots
-- carrying the camera's capture time. A rider's ride (Strava, GPX, or "I passed around") gives
-- the moments they passed each spot. Riders only ever see shots from around those moments.
--
-- Security model in one paragraph: browsers talk to the database directly with the rider's or
-- pitikero's login, so every table has row-level security and explicit column grants. Anything
-- that moves money or reveals photos goes through SECURITY DEFINER functions that check who is
-- calling. Execute rights on functions are revoked by default and granted one by one at the end.

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
  ('window_minutes', '3'),             -- default view around a pass; riders can pick 1/3/10
  ('max_window_minutes', '10'),
  ('manual_window_minutes', '6'),      -- "I passed around…" (no GPS): fixed, a little wider
  ('track_keep_hours', '72'),
  ('notify_cutoff_hour', '20'),        -- Manila time: send the digest by 8pm even if a pitikero has not finished
  ('rider_trial_credit', '100'),
  ('app_url', 'https://pitik.vercel.app'),
  ('strava_subscription_id', '')
on conflict (key) do nothing;
alter table public.app_config enable row level security;
create policy app_config_read on public.app_config for select
  using (key in ('pitik_fee_per_photo','pitik_fee_cap','min_price','window_minutes','fee_qrph','fee_card','gateway_live','rider_trial_credit'));

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

create table public.pitikeros (
  id uuid primary key references public.profiles(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  handle text unique not null check (handle ~ '^[a-z0-9_.]{2,30}$'),
  price int not null default 50,
  gcash_number text check (gcash_number ~ '^09\d{9}$'),
  gcash_name text check (char_length(gcash_name) <= 80),
  fb_page text check (char_length(fb_page) <= 120),
  -- New pitikeros can check in and upload right away; riders see their shots once the Pitik team activates them.
  status text not null default 'pending' check (status in ('pending','active','paused')),
  founding boolean not null default false,
  referred_by uuid references public.pitikeros(id),
  created_at timestamptz not null default now()
);
alter table public.pitikeros enable row level security;
create policy pitikeros_public_read on public.pitikeros for select using (true);
create policy pitikeros_insert_self on public.pitikeros for insert to authenticated with check (id = auth.uid());
create policy pitikeros_update_self on public.pitikeros for update to authenticated using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

create or replace function public.check_price() returns trigger language plpgsql security definer set search_path = public as $$
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
  clock_offset_ms bigint not null default 0 check (abs(clock_offset_ms) <= 43200000),  -- added to camera time to get true time
  clock_checked boolean not null default false,
  first_shot_at timestamptz,          -- server-maintained
  last_shot_at timestamptz,           -- server-maintained
  photo_count int not null default 0, -- server-maintained
  done_at timestamptz,                -- "Tapos na ako": all shots uploaded (set through shoot_uploaded)
  created_at timestamptz not null default now()
);
create index shoots_time on public.shoots (first_shot_at, last_shot_at);
create index shoots_pk on public.shoots (pitikero_id, checked_in_at desc);
alter table public.shoots enable row level security;
-- Spots and times are what riders match against; they are not secret (a pitikero stands on a public road).
create policy shoots_read on public.shoots for select using (true);
create policy shoots_insert_self on public.shoots for insert to authenticated with check (pitikero_id = auth.uid());
create policy shoots_update_self on public.shoots for update to authenticated using (pitikero_id = auth.uid() or public.is_admin()) with check (pitikero_id = auth.uid() or public.is_admin());

create table public.photos (
  id uuid primary key default gen_random_uuid(),
  shoot_id uuid not null references public.shoots(id) on delete cascade,
  pitikero_id uuid not null references public.pitikeros(id) on delete cascade,
  camera_time timestamptz not null,                 -- as written by the camera (EXIF)
  taken_at timestamptz not null,                    -- camera_time + shoot.clock_offset_ms (server-set)
  camera text check (char_length(camera) <= 80),
  width int, height int,
  -- Storage paths are always derived by the server from the ids (never trusted from the browser):
  original_path text not null unique,               -- originals/<pitikero>/<shoot>/<id>.jpg (private)
  preview_path text not null,                       -- previews/<pitikero>/<shoot>/<id>-p.jpg (public, watermarked)
  thumb_path text not null,                         -- previews/<pitikero>/<shoot>/<id>-t.jpg (public, watermarked)
  source_key text not null check (char_length(source_key) <= 200),   -- file name + size, to skip re-uploads
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  unique (shoot_id, source_key)
);
create index photos_shoot_time on public.photos (shoot_id, taken_at);
create index photos_pk_time on public.photos (pitikero_id, taken_at);
alter table public.photos enable row level security;
-- No blanket read: riders reach photos only through photos_for_pass() or their purchases.
create policy photos_owner_read on public.photos for select to authenticated using (pitikero_id = auth.uid() or public.is_admin());
create policy photos_owner_insert on public.photos for insert to authenticated with check (
  pitikero_id = auth.uid() and exists (select 1 from shoots s where s.id = shoot_id and s.pitikero_id = auth.uid()));
create policy photos_owner_update on public.photos for update to authenticated using (pitikero_id = auth.uid() or public.is_admin());

-- Paths and taken_at are set here, whatever the browser sent.
create or replace function public.photo_before_insert() returns trigger language plpgsql security definer set search_path = public as $$
declare off bigint; owner uuid;
begin
  select clock_offset_ms, pitikero_id into off, owner from shoots s where s.id = new.shoot_id;
  if owner is distinct from new.pitikero_id then raise exception 'That shoot belongs to someone else'; end if;
  new.taken_at := new.camera_time + make_interval(secs => coalesce(off, 0) / 1000.0);
  new.original_path := new.pitikero_id || '/' || new.shoot_id || '/' || new.id || '.jpg';
  new.preview_path := new.pitikero_id || '/' || new.shoot_id || '/' || new.id || '-p.jpg';
  new.thumb_path := new.pitikero_id || '/' || new.shoot_id || '/' || new.id || '-t.jpg';
  return new;
end $$;
create trigger photos_before_insert before insert on public.photos for each row execute function public.photo_before_insert();

create or replace function public.shoot_refresh_stats(p_shoot uuid) returns void language sql security definer set search_path = public as $$
  update shoots s set first_shot_at = x.f, last_shot_at = x.l, photo_count = x.n
  from (select min(taken_at) f, max(taken_at) l, count(*)::int n from photos where shoot_id = p_shoot and not hidden) x
  where s.id = p_shoot;
$$;
create or replace function public.photos_after_change() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform shoot_refresh_stats(coalesce(new.shoot_id, old.shoot_id));
  return null;
end $$;
create trigger photos_stats after insert or delete or update of hidden on public.photos for each row execute function public.photos_after_change();

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
alter table public.strava_accounts enable row level security;   -- server only: no policies, no grants

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
  notify_attempts int not null default 0,
  strava_line text,
  created_at timestamptz not null default now()
);
create index rides_user on public.rides (user_id, started_at desc);
alter table public.rides enable row level security;
create policy rides_own on public.rides for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy rides_own_delete on public.rides for delete to authenticated using (user_id = auth.uid());

create table public.passes (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  shoot_id uuid not null references public.shoots(id) on delete cascade,
  passed_at timestamptz not null,      -- closest moment to the spot
  zone_start timestamptz,              -- first moment within range (riders who stop at the spot stay "in range" longer)
  zone_end timestamptz,                -- last moment within range
  distance_m real,
  manual boolean not null default false,
  created_at timestamptz not null default now(),
  unique (ride_id, shoot_id, passed_at)
);
create index passes_user on public.passes (user_id, passed_at desc);
create index passes_shoot on public.passes (shoot_id);
alter table public.passes enable row level security;
create policy passes_own on public.passes for select to authenticated using (user_id = auth.uid() or public.is_admin());

-- The time span of shots a pass may show, in minutes either side
create or replace function public.pass_span(p public.passes, p_minutes int default null) returns tstzrange
language sql stable security definer set search_path = public as $$
  select case when p.manual then
    tstzrange(p.passed_at - make_interval(mins => cfg_num('manual_window_minutes', 6)::int),
              p.passed_at + make_interval(mins => cfg_num('manual_window_minutes', 6)::int), '[]')
  else
    tstzrange(coalesce(p.zone_start, p.passed_at) - make_interval(mins => least(greatest(coalesce(p_minutes, cfg_num('window_minutes', 3)::int), 1), cfg_num('max_window_minutes', 10)::int)),
              coalesce(p.zone_end, p.passed_at) + make_interval(mins => least(greatest(coalesce(p_minutes, cfg_num('window_minutes', 3)::int), 1), cfg_num('max_window_minutes', 10)::int)), '[]')
  end
$$;

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
  -- time spent right at the spot (within 60 m): long for a rider who stops, a moment for one riding past
  span as (select shoot_id, g, min(t) filter (where d <= 60) zs, max(t) filter (where d <= 60) ze from seg group by shoot_id, g),
  best as (
    select distinct on (seg.shoot_id, seg.g) seg.shoot_id, seg.t, seg.d, span.zs, span.ze
    from seg join span using (shoot_id, g) order by seg.shoot_id, seg.g, seg.d, seg.t
  ),
  ins as (
    insert into passes (ride_id, user_id, shoot_id, passed_at, zone_start, zone_end, distance_m)
    select r.id, r.user_id, shoot_id, t, zs, ze, d from best
    on conflict (ride_id, shoot_id, passed_at) do nothing
    returning 1
  )
  select count(*) into n from ins;
  return n;
end $$;

-- When a shoot's photos arrive (or its clock changes) after rides were recorded, match those rides again.
-- Only rides whose track is still kept are re-matched, and only their passes are replaced.
create or replace function public.rematch_shoot(p_shoot uuid) returns int language plpgsql security definer set search_path = public as $$
declare s record; rr record; n int := 0;
begin
  select * into s from shoots where id = p_shoot;
  if s.id is null then return 0; end if;
  for rr in select id from rides
            where track is not null
              and started_at between s.checked_in_at - interval '12 hours' and s.checked_in_at + interval '12 hours'
  loop
    delete from passes where shoot_id = p_shoot and ride_id = rr.id and not manual;
    n := n + match_ride(rr.id, p_shoot);
  end loop;
  return n;
end $$;

-- Clock correction applied after shots are uploaded: shift every photo of the shoot and re-match
create or replace function public.shoot_clock_changed() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.clock_offset_ms is distinct from old.clock_offset_ms then
    update photos set taken_at = camera_time + make_interval(secs => new.clock_offset_ms / 1000.0) where shoot_id = new.id;
    perform shoot_refresh_stats(new.id);
    perform rematch_shoot(new.id);
  end if;
  return new;
end $$;
create trigger shoots_clock after update of clock_offset_ms on public.shoots for each row execute function public.shoot_clock_changed();

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

-- Thin a track to one point every ~5 s
create or replace function public.thin_track(p jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(e order by t), '[]'::jsonb) from (
    select distinct on (floor(extract(epoch from (e->>'t')::timestamptz) / 5)) e, (e->>'t')::timestamptz t
    from jsonb_array_elements(p) e
    where (e->>'lat') is not null and (e->>'lon') is not null and (e->>'t') is not null
    order by floor(extract(epoch from (e->>'t')::timestamptz) / 5), (e->>'t')::timestamptz
  ) x
$$;

-- Append-only record of manual looks and ride-file uploads, for limits (riders can't delete these)
create table public.rider_lookups (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in ('manual','gpx')),
  shoot_id uuid,
  created_at timestamptz not null default now()
);
create index rider_lookups_user on public.rider_lookups (user_id, kind, created_at desc);
alter table public.rider_lookups enable row level security;   -- server only

-- Server (Strava) ingest: creates or replaces a ride and matches it
create or replace function public.ingest_ride(p_user uuid, p_source text, p_activity bigint, p_name text,
  p_start timestamptz, p_end timestamptz, p_track jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rid uuid; n int; tr jsonb := thin_track(p_track); keep interval := make_interval(hours => cfg_num('track_keep_hours', 72)::int);
begin
  if p_activity is not null then
    select id into rid from rides where strava_activity_id = p_activity;
  end if;
  if rid is null then
    insert into rides (user_id, source, strava_activity_id, name, started_at, ended_at, track, track_expires_at)
    values (p_user, p_source, p_activity, left(p_name, 120), p_start, p_end, tr, least(now(), coalesce(p_end, now())) + keep)
    returning id into rid;
  else
    -- an edited activity keeps its original deletion time
    update rides set name = left(p_name, 120), started_at = p_start, ended_at = p_end,
      track = case when coalesce(track_expires_at, now() + keep) > now() then tr else null end
    where id = rid;
    delete from passes where ride_id = rid and not manual;
  end if;
  n := match_ride(rid);
  return jsonb_build_object('ride_id', rid, 'passes', n);
end $$;

-- Rider uploads a GPX (parsed in the browser into [{t,lat,lon}])
create or replace function public.add_gpx_ride(p_name text, p_track jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s timestamptz; e timestamptz;
begin
  if me is null then raise exception 'Please sign in again'; end if;
  if (select count(*) from rider_lookups where user_id = me and kind = 'gpx' and created_at > now() - interval '1 day') >= 10 then
    raise exception 'That is a lot of ride files today. Try again tomorrow.';
  end if;
  insert into rider_lookups (user_id, kind) values (me, 'gpx');
  if jsonb_typeof(p_track) <> 'array' or jsonb_array_length(p_track) < 10 then raise exception 'That ride file has too few points'; end if;
  if jsonb_array_length(p_track) > 40000 then raise exception 'That ride file is too long'; end if;
  select min((x->>'t')::timestamptz), max((x->>'t')::timestamptz) into s, e from jsonb_array_elements(p_track) x;
  return ingest_ride(me, 'gpx', null, coalesce(nullif(p_name, ''), 'Ride'), s, e, p_track);
end $$;

-- No Strava, no GPX: "I passed this pitikero around 6:40". Limited so nobody can page through a whole shoot.
create or replace function public.add_manual_pass(p_shoot uuid, p_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); rid uuid; s record; d date := (p_at at time zone 'Asia/Manila')::date;
begin
  if me is null then raise exception 'Please sign in again'; end if;
  select * into s from shoots where id = p_shoot;
  if s.id is null then raise exception 'That pitikero session no longer exists'; end if;
  if p_at < coalesce(s.first_shot_at, s.checked_in_at) - interval '30 minutes' or p_at > coalesce(s.last_shot_at, s.checked_in_at) + interval '30 minutes' then
    raise exception 'That time is outside when this pitikero was shooting';
  end if;
  if (select count(*) from rider_lookups where user_id = me and kind = 'manual' and shoot_id = p_shoot) >= 2 then
    raise exception 'You already looked twice at this pitikero''s shots. For more, connect Strava or upload your ride file.';
  end if;
  if (select count(*) from rider_lookups where user_id = me and kind = 'manual' and created_at > now() - interval '1 day') >= 6 then
    raise exception 'That is the limit for today. Connect Strava or upload your ride file to see more.';
  end if;
  insert into rider_lookups (user_id, kind, shoot_id) values (me, 'manual', p_shoot);
  select id into rid from rides where user_id = me and source = 'manual' and (started_at at time zone 'Asia/Manila')::date = d limit 1;
  if rid is null then
    insert into rides (user_id, source, name, started_at, ended_at) values (me, 'manual', 'Ride', p_at, p_at) returning id into rid;
  end if;
  insert into passes (ride_id, user_id, shoot_id, passed_at, manual) values (rid, me, p_shoot, p_at, true)
  on conflict do nothing;
  return jsonb_build_object('ride_id', rid);
end $$;

-- Photos a rider may see for one of their passes: only the minutes around the pass, only from active pitikeros.
create or replace function public.photos_for_pass(p_pass uuid, p_minutes int default null)
returns table (id uuid, pitikero_id uuid, taken_at timestamptz, preview_path text, thumb_path text, price int, bought boolean)
language plpgsql stable security definer set search_path = public as $$
declare ps passes; span tstzrange;
begin
  select * into ps from passes where passes.id = p_pass and (passes.user_id = auth.uid() or is_admin());
  if ps.id is null then return; end if;
  span := pass_span(ps, p_minutes);
  return query
    select ph.id, ph.pitikero_id, ph.taken_at, ph.preview_path, ph.thumb_path, pk.price,
      exists (select 1 from order_items oi join orders o on o.id = oi.order_id
              where oi.photo_id = ph.id and o.user_id = auth.uid() and o.status = 'paid')
    from photos ph join pitikeros pk on pk.id = ph.pitikero_id
    where ph.shoot_id = ps.shoot_id and not ph.hidden and pk.status = 'active' and ph.taken_at <@ span
    order by ph.taken_at
    limit 200;
end $$;

-- How many shots a pass shows at the default window (for lists and messages)
create or replace function public.pass_count(p_pass uuid) returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from passes ps join photos ph on ph.shoot_id = ps.shoot_id join pitikeros pk on pk.id = ph.pitikero_id
  where ps.id = p_pass and not ph.hidden and pk.status = 'active' and ph.taken_at <@ pass_span(ps, null)
$$;

-- Everything the rider's rides page needs in one call
create or replace function public.my_rides(p_limit int default 20) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(r order by r.started_at desc nulls last), '[]'::jsonb) from (
    select rd.id, rd.source, rd.name, rd.started_at, rd.strava_activity_id,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id', p.id, 'passed_at', p.passed_at, 'manual', p.manual, 'distance_m', p.distance_m,
          'shoot_id', s.id, 'place_label', s.place_label, 'pitikero', jsonb_build_object('id', pk.id, 'name', pk.name, 'handle', pk.handle, 'price', pk.price),
          'shoot_done', s.done_at is not null, 'count', pass_count(p.id))
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
  where (s.checked_in_at at time zone 'Asia/Manila')::date = p_day and s.photo_count > 0 and pk.status = 'active'
$$;

-- ---------------------------------------------------------------- money
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  status text not null default 'pending' check (status in ('pending','paid','cancelled','review')),
  photos_amount numeric(10,2) not null,
  tips_amount numeric(10,2) not null default 0,
  fee_amount numeric(10,2) not null default 0,
  credit_amount numeric(10,2) not null default 0,
  total numeric(10,2) not null,                    -- what the rider pays through TechPay (before the gateway fee)
  gateway_ref text unique,                         -- the reference of the attempt that paid
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

create table public.credits (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  reason text,
  used_order_id uuid references public.orders(id) on delete set null,   -- reserved by / spent on this order
  created_at timestamptz not null default now()
);
create index credits_user on public.credits (user_id) where used_order_id is null;
alter table public.credits enable row level security;
create policy credits_own on public.credits for select to authenticated using (user_id = auth.uid() or public.is_admin());

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, is_admin)
  values (new.id, new.email,
          coalesce(lower(new.email) = any (string_to_array(replace(lower(coalesce(cfg('admin_emails'), '')), ' ', ''), ',')), false))
  on conflict (id) do nothing;
  if coalesce(cfg_num('rider_trial_credit', 0), 0) > 0 then
    insert into credits (user_id, amount, reason) values (new.id, cfg_num('rider_trial_credit', 0), 'Founding rider credit');
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

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

-- One row per TechPay checkout link. A rider may open the payment page more than once; every
-- reference stays tied to its order so a late payment on an older link is never lost.
create table public.payment_attempts (
  reference text primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  amount numeric(10,2) not null,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);
alter table public.payment_attempts enable row level security;   -- server only

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
create unique index ledger_sale_once on public.ledger (order_id, photo_id) where kind = 'sale';
create unique index ledger_tip_once on public.ledger (order_id, pitikero_id) where kind = 'tip';
alter table public.ledger enable row level security;
create policy ledger_read on public.ledger for select to authenticated using (pitikero_id = auth.uid() or public.is_admin());

-- Give back credits held by an order that will not be paid
create or replace function public.release_credits(p_order uuid) returns void language sql security definer set search_path = public as $$
  update credits set used_order_id = null where used_order_id = p_order
$$;

-- Cancel pending orders that can no longer be paid, and give their credit back:
--   • never reached the payment page and older than 2 minutes (another tab may be mid-checkout)
--   • every payment link failed, was cancelled or expired
--   • the newest payment link is older than 2 hours (TechPay links expire well before that)
-- A payment that still completes later is held for review if its credit was released.
create or replace function public.expire_stale_orders(p_user uuid default null) returns int
language plpgsql security definer set search_path = public as $$
declare c record; n int := 0;
begin
  for c in select o.id from orders o
           where o.status = 'pending' and (p_user is null or o.user_id = p_user)
             and o.created_at < now() - interval '2 minutes'
             and (
               not exists (select 1 from payment_attempts a where a.order_id = o.id)
               or not exists (select 1 from payment_attempts a where a.order_id = o.id and a.status = 'pending')
               or (select max(a.created_at) from payment_attempts a where a.order_id = o.id) < now() - interval '2 hours')
           for update of o skip locked
  loop
    update orders set status = 'cancelled', admin_note = coalesce(admin_note || ' | ', '') || 'Checkout expired' where id = c.id;
    update payment_attempts set status = 'expired' where order_id = c.id and status = 'pending';
    perform release_credits(c.id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- The payment page could not be opened: cancel and give the credit back (called by the techpay function)
create or replace function public.payment_link_failed(p_reference text) returns void
language plpgsql security definer set search_path = public as $$
declare oid uuid;
begin
  update payment_attempts set status = 'failed' where reference = p_reference returning order_id into oid;
  if oid is not null and not exists (select 1 from payment_attempts where order_id = oid and status = 'pending') then
    update orders set status = 'cancelled', admin_note = coalesce(admin_note || ' | ', '') || 'Payment page did not open'
    where id = oid and status = 'pending';
    perform release_credits(oid);
  end if;
end $$;

-- Order creation: the server works out prices, fee and credit, and reserves the credit.
-- The browser only says which photos and how much to tip.
create or replace function public.create_order(p_photo_ids uuid[], p_tips jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); oid uuid; n int; photos_amt numeric := 0; tips_amt numeric := 0; fee numeric;
  need numeric; got numeric := 0; c record; k text; v numeric; wanted int;
begin
  if me is null then raise exception 'Please sign in again'; end if;
  if p_photo_ids is null or array_length(p_photo_ids, 1) is null then raise exception 'Pick at least one photo'; end if;
  wanted := (select count(distinct x) from unnest(p_photo_ids) x);
  if wanted > 100 then raise exception 'That is a lot of photos. Pick up to 100 at a time.'; end if;

  -- Only photos the rider may see: active pitikero, not their own, inside the span of one of their passes
  if (select count(*) from photos ph join pitikeros pk on pk.id = ph.pitikero_id
      where ph.id = any(p_photo_ids) and not ph.hidden and pk.status = 'active' and ph.pitikero_id <> me
        and exists (select 1 from passes ps where ps.user_id = me and ps.shoot_id = ph.shoot_id
                    and ph.taken_at <@ pass_span(ps, cfg_num('max_window_minutes', 10)::int))) <> wanted then
    raise exception 'Some of those photos are not from your ride';
  end if;

  -- Older checkouts that can no longer be paid give their credit back
  perform expire_stale_orders(me);

  insert into orders (user_id, photos_amount, total) values (me, 0, 0) returning id into oid;
  insert into order_items (order_id, photo_id, pitikero_id, price)
    select oid, ph.id, ph.pitikero_id, pk.price from photos ph join pitikeros pk on pk.id = ph.pitikero_id
    where ph.id = any(p_photo_ids)
      and not exists (select 1 from order_items oi join orders o on o.id = oi.order_id where oi.photo_id = ph.id and o.user_id = me and o.status = 'paid');
  get diagnostics n = row_count;
  if n = 0 then delete from orders where id = oid; raise exception 'You already own these photos'; end if;
  select coalesce(sum(price), 0) into photos_amt from order_items where order_id = oid;

  for k, v in select key, value::numeric from jsonb_each_text(coalesce(p_tips, '{}'::jsonb)) loop
    if v < 0 then raise exception 'Tips cannot be negative'; end if;
    if v > 5000 then raise exception 'Tips are capped at ₱5,000 per pitikero'; end if;
    if v > 0 and exists (select 1 from order_items where order_id = oid and pitikero_id = k::uuid) then
      insert into order_tips (order_id, pitikero_id, amount) values (oid, k::uuid, round(v, 2));
      tips_amt := tips_amt + round(v, 2);
    end if;
  end loop;

  fee := least(n * cfg_num('pitik_fee_per_photo', 10), cfg_num('pitik_fee_cap', 30));

  -- Credit covers photos and the Pitik fee (not tips). Reserve it now so it cannot be spent twice.
  need := photos_amt + fee;
  for c in select id, amount from credits where user_id = me and used_order_id is null order by created_at, id for update loop
    exit when got >= need;
    if got + c.amount <= need then
      update credits set used_order_id = oid where id = c.id;
      got := got + c.amount;
    else
      -- split: reserve only what is needed, keep the rest available
      update credits set amount = need - got, used_order_id = oid where id = c.id;
      insert into credits (user_id, amount, reason) values (me, c.amount - (need - got), 'Remaining credit');
      got := need;
    end if;
  end loop;

  update orders set photos_amount = photos_amt, tips_amount = tips_amt, fee_amount = fee, credit_amount = got,
    total = photos_amt + tips_amt + fee - got where id = oid;
  return jsonb_build_object('id', oid, 'photos', n, 'photos_amount', photos_amt, 'tips_amount', tips_amt,
    'fee_amount', fee, 'credit_amount', got, 'total', photos_amt + tips_amt + fee - got);
end $$;

-- Pay the pitikeros (ledger) exactly once
create or replace function public.fulfil_order(p_order uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into ledger (pitikero_id, kind, amount, order_id, photo_id)
    select pitikero_id, 'sale', price, order_id, photo_id from order_items where order_id = p_order
    on conflict do nothing;
  insert into ledger (pitikero_id, kind, amount, order_id, note)
    select pitikero_id, 'tip', amount, order_id, 'Tip' from order_tips where order_id = p_order and amount > 0
    on conflict do nothing;
end $$;

create or replace function public.credit_ok(p_order uuid) returns boolean language sql stable security definer set search_path = public as $$
  select abs(coalesce((select sum(amount) from credits where used_order_id = p_order), 0)
             - (select credit_amount from orders where id = p_order)) < 0.005
$$;

-- Orders fully covered by credit settle without the gateway
create or replace function public.settle_free_order(p_order uuid) returns jsonb language plpgsql security definer set search_path = public as $$
declare o record;
begin
  select * into o from orders where id = p_order and user_id = auth.uid() for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status = 'paid' then return jsonb_build_object('ok', true, 'already', true); end if;
  if o.status <> 'pending' then raise exception 'This order is %', o.status; end if;
  if o.total > 0 then raise exception 'This order needs payment'; end if;
  if not credit_ok(o.id) then raise exception 'Your credit changed. Please check out again.'; end if;
  update orders set status = 'paid', paid_at = now(), gateway_ref = 'PTKCREDIT' || replace(o.id::text, '-', '') where id = o.id;
  perform fulfil_order(o.id);
  return jsonb_build_object('ok', true);
end $$;

-- TechPay (pattern from the techpay-gateway skill). Called by the techpay function with the service role.
create table public.gateway_webhook_log (
  id bigserial primary key,
  received_at timestamptz not null default now(),
  source_ip text, reference text, amount numeric, status text,
  signature_received text, signature_expected text, signature_ok boolean,
  outcome text, payload jsonb
);
alter table public.gateway_webhook_log enable row level security;
create policy webhook_log_admin on public.gateway_webhook_log for select to authenticated using (public.is_admin());

create or replace function public.start_order_payment(p_user uuid, p_order uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare live text; o record; ref text; admin boolean;
begin
  select coalesce(is_admin, false) into admin from profiles where id = p_user;
  live := coalesce(cfg('gateway_live'), 'false');
  if live = 'false' then raise exception 'Online payment is not available yet'; end if;
  if live = 'admins' and not coalesce(admin, false) then raise exception 'Online payment is being trialled by the Pitik team first'; end if;
  select * into o from orders where id = p_order and user_id = p_user for update;
  if o.id is null then raise exception 'Order not found'; end if;
  if o.status <> 'pending' then raise exception 'This order is already %', o.status; end if;
  if o.total < 1 then raise exception 'Nothing to pay'; end if;
  if (select count(*) from payment_attempts where order_id = o.id) >= 5 then raise exception 'Too many tries. Please start a new checkout.'; end if;
  ref := 'PTK' || upper(to_hex((extract(epoch from now()) * 1000)::bigint)) || upper(substr(md5(gen_random_uuid()::text), 1, 5));
  insert into payment_attempts (reference, order_id, amount) values (ref, o.id, o.total);
  return jsonb_build_object('ok', true, 'id', o.id, 'amount', o.total, 'reference', ref);
end $$;

create or replace function public.settle_gateway_payment(p_reference text, p_amount numeric, p_status text,
  p_fee numeric default null, p_payload jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a record; t record;
begin
  select * into a from payment_attempts where reference = p_reference for update;
  if a.reference is null then return jsonb_build_object('ok', false, 'reason', 'unknown reference'); end if;
  select * into t from orders where id = a.order_id for update;

  if p_status = 'completed' then
    if a.status = 'completed' then return jsonb_build_object('ok', true, 'already', true); end if;
    update payment_attempts set status = 'completed' where reference = p_reference;
    if t.status = 'paid' then
      -- paid twice through two different links: keep the money visible for a refund
      update orders set admin_note = coalesce(admin_note || ' | ', '') || 'Second payment ' || p_reference || ' ₱' || p_amount || ': refund' where id = t.id;
      return jsonb_build_object('ok', false, 'reason', 'already paid by another link');
    end if;
    if abs(coalesce(p_amount, 0) - a.amount) > 0.005 or abs(a.amount - t.total) > 0.005 or not credit_ok(t.id) then
      update orders set status = 'review', gateway_ref = p_reference, gateway_status = p_status, gateway_payload = p_payload,
        admin_note = coalesce(admin_note || ' | ', '') || 'Gateway reported ₱' || p_amount || ' against ₱' || t.total || ', held for review'
      where id = t.id;
      return jsonb_build_object('ok', false, 'reason', 'amount or credit mismatch');
    end if;
    update orders set status = 'paid', gateway_ref = p_reference, gateway_status = p_status, gateway_fee = p_fee,
      gateway_payload = p_payload, paid_at = now()
    where id = t.id;
    perform fulfil_order(t.id);
    return jsonb_build_object('ok', true, 'fulfilled', t.total);
  elsif p_status in ('cancelled', 'canceled', 'expired', 'failed', 'voided') then
    update payment_attempts set status = p_status where reference = p_reference and status = 'pending';
    -- cancel the order only when no other link for it could still be paid
    if t.status = 'pending' and not exists (select 1 from payment_attempts where order_id = t.id and status = 'pending') then
      update orders set status = 'cancelled', gateway_status = p_status, gateway_payload = p_payload,
        admin_note = coalesce(admin_note || ' | ', '') || 'Cancelled or expired at the gateway'
      where id = t.id;
      perform release_credits(t.id);
    end if;
    return jsonb_build_object('ok', true, 'cancelled', true);
  end if;
  update orders set gateway_status = p_status where id = t.id and status = 'pending';
  return jsonb_build_object('ok', true, 'pending', true);
end $$;

create or replace function public.log_gateway_webhook(p_ip text, p_reference text, p_amount numeric, p_status text,
  p_sig_recv text, p_sig_exp text, p_ok boolean, p_outcome text, p_payload jsonb) returns void
language sql security definer set search_path = public as $$
  insert into gateway_webhook_log (source_ip, reference, amount, status, signature_received, signature_expected, signature_ok, outcome, payload)
  values (p_ip, p_reference, p_amount, p_status, p_sig_recv, p_sig_exp, p_ok, p_outcome, p_payload);
$$;

-- Purchased photos: the rider's library
create or replace function public.my_purchases() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('photo_id', ph.id, 'taken_at', ph.taken_at, 'original_path', ph.original_path,
    'preview_path', ph.preview_path, 'pitikero', pk.name, 'paid_at', o.paid_at) order by ph.taken_at desc), '[]'::jsonb)
  from orders o join order_items oi on oi.order_id = o.id join photos ph on ph.id = oi.photo_id join pitikeros pk on pk.id = ph.pitikero_id
  where o.user_id = auth.uid() and o.status = 'paid'
$$;

-- Pitikero earnings: balance and recent lines (week = Monday 00:00 Manila)
create or replace function public.my_kita() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); wk timestamptz := (date_trunc('week', now() at time zone 'Asia/Manila')) at time zone 'Asia/Manila';
begin
  return jsonb_build_object(
    'unpaid', coalesce((select sum(amount) from ledger where pitikero_id = me and payout_id is null), 0),
    'week_sales', coalesce((select sum(amount) from ledger where pitikero_id = me and kind = 'sale' and created_at >= wk), 0),
    'week_tips', coalesce((select sum(amount) from ledger where pitikero_id = me and kind = 'tip' and created_at >= wk), 0),
    'week_photos', (select count(*) from ledger where pitikero_id = me and kind = 'sale' and created_at >= wk),
    'week_tippers', (select count(distinct order_id) from ledger where pitikero_id = me and kind = 'tip' and created_at >= wk),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'amount', amount, 'note', note, 'at', created_at, 'paid', payout_id is not null) order by created_at desc)
              from (select * from ledger where pitikero_id = me order by created_at desc limit 60) l), '[]'::jsonb),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'amount', amount, 'gcash_ref', gcash_ref, 'receipt_path', receipt_path, 'paid_at', paid_at, 'note', note) order by paid_at desc)
              from payouts where pitikero_id = me), '[]'::jsonb)
  );
end $$;

-- ---------------------------------------------------------------- admin
create or replace function public.admin_balances() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  return (select coalesce(jsonb_agg(x order by x.unpaid desc, x.name), '[]'::jsonb) from (
    select pk.id, pk.name, pk.handle, pk.gcash_number, pk.gcash_name, pk.founding, pk.status, pk.created_at,
      (select count(*) from photos ph where ph.pitikero_id = pk.id) photos,
      coalesce(sum(l.amount) filter (where l.payout_id is null), 0) unpaid,
      coalesce(sum(l.amount) filter (where l.payout_id is null and l.kind = 'sale'), 0) unpaid_sales,
      coalesce(sum(l.amount) filter (where l.payout_id is null and l.kind = 'tip'), 0) unpaid_tips,
      coalesce(sum(l.amount) filter (where l.payout_id is null and l.kind in ('allowance','referral','adjustment')), 0) unpaid_extras,
      (select max(paid_at) from payouts po where po.pitikero_id = pk.id) last_paid_at
    from pitikeros pk left join ledger l on l.pitikero_id = pk.id
    group by pk.id) x);
end $$;

create or replace function public.admin_set_pitikero(p_pitikero uuid, p_status text, p_founding boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  update pitikeros set status = coalesce(p_status, status), founding = coalesce(p_founding, founding) where id = p_pitikero;
end $$;

-- Pays exactly the rows it marks, so a sale landing mid-way is never swallowed.
create or replace function public.admin_record_payout(p_pitikero uuid, p_amount numeric, p_ref text, p_receipt text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pid uuid; marked numeric; gnum text;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_amount <= 0 then raise exception 'Nothing to pay'; end if;
  perform 1 from pitikeros where id = p_pitikero for update;
  select gcash_number into gnum from pitikeros where id = p_pitikero;
  insert into payouts (pitikero_id, amount, gcash_number, gcash_ref, receipt_path, note, paid_by)
  values (p_pitikero, p_amount, gnum, nullif(p_ref, ''), nullif(p_receipt, ''), nullif(p_note, ''), auth.uid()) returning id into pid;
  with m as (update ledger set payout_id = pid where pitikero_id = p_pitikero and payout_id is null returning amount)
  select coalesce(sum(amount), 0) into marked from m;
  if abs(marked - p_amount) > 0.005 then
    raise exception 'The balance changed to ₱%. Refresh and try again.', marked;   -- rolls everything back
  end if;
  return jsonb_build_object('ok', true, 'payout_id', pid);
end $$;

create or replace function public.admin_add_extra(p_pitikero uuid, p_kind text, p_amount numeric, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_kind not in ('allowance','referral','adjustment') then raise exception 'Unknown kind'; end if;
  if p_amount = 0 or abs(p_amount) > 20000 then raise exception 'Check the amount'; end if;
  insert into ledger (pitikero_id, kind, amount, note, created_by) values (p_pitikero, p_kind, p_amount, p_note, auth.uid());
end $$;

create or replace function public.admin_give_credit(p_email text, p_amount numeric, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  if not is_admin() then raise exception 'Admins only'; end if;
  if p_amount <= 0 or p_amount > 5000 then raise exception 'Check the amount'; end if;
  select id into uid from profiles where lower(email) = lower(trim(p_email));
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
    'review', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'ref', gateway_ref, 'total', total, 'note', admin_note)), '[]'::jsonb)
               from orders where status = 'review' or admin_note like '%refund%'),
    'recent_orders', (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select o.id, o.status, o.total, o.photos_amount, o.tips_amount, o.fee_amount, o.credit_amount, o.gateway_ref, o.created_at, o.paid_at, p.email
        from orders o left join profiles p on p.id = o.user_id order by o.created_at desc limit 30) x),
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

-- ---------------------------------------------------------------- notifications
-- Rides ready for the one consolidated message: every pitikero it passed has finished uploading,
-- or it is past the cutoff on the ride day. One follow-up at most if more shots arrive later.
create or replace function public.rides_to_notify() returns jsonb language plpgsql security definer set search_path = public as $$
declare cutoff int := cfg_num('notify_cutoff_hour', 20)::int;
begin
  return (select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select rd.id ride_id, rd.user_id, pr.email, pr.email_notify, rd.strava_activity_id, rd.name, rd.started_at,
      (rd.notified_at is not null) is_followup,
      (select jsonb_agg(jsonb_build_object('pitikero', pk.name, 'passed_at', ps.passed_at, 'count', pass_count(ps.id),
          'thumb', (select ph.thumb_path from photos ph where ph.shoot_id = ps.shoot_id and not ph.hidden and ph.taken_at <@ pass_span(ps, null)
                    order by abs(extract(epoch from ph.taken_at - ps.passed_at)) limit 1))
        order by ps.passed_at)
       from passes ps join shoots s on s.id = ps.shoot_id join pitikeros pk on pk.id = s.pitikero_id where ps.ride_id = rd.id) passes
    from rides rd join profiles pr on pr.id = rd.user_id
    where rd.started_at > now() - interval '3 days'
      and rd.followup_at is null
      and exists (select 1 from passes ps where ps.ride_id = rd.id and pass_count(ps.id) > 0)
      and (
        (rd.notified_at is null and (
           not exists (select 1 from passes ps join shoots s on s.id = ps.shoot_id where ps.ride_id = rd.id and s.done_at is null)
           or (now() at time zone 'Asia/Manila') >= ((rd.started_at at time zone 'Asia/Manila')::date + make_interval(hours => cutoff))))
        or
        (rd.notified_at is not null and exists (
           select 1 from passes ps join photos ph on ph.shoot_id = ps.shoot_id
           where ps.ride_id = rd.id and ph.created_at > rd.notified_at + interval '10 minutes' and ph.taken_at <@ pass_span(ps, null))
         and not exists (select 1 from passes ps join shoots s on s.id = ps.shoot_id where ps.ride_id = rd.id and s.done_at is null))
      )
    order by rd.started_at
    limit 50) x);
end $$;

-- p_ok = false: every channel failed; try again next run, give up after 4 tries.
create or replace function public.mark_notified(p_ride uuid, p_line text, p_ok boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not p_ok then
    update rides set notify_attempts = notify_attempts + 1 where id = p_ride;
    if (select notify_attempts from rides where id = p_ride) < 4 then return; end if;
  end if;
  update rides set
    followup_at = case when notified_at is not null then now() else followup_at end,
    notified_at = coalesce(notified_at, now()),
    notify_attempts = 0,
    strava_line = coalesce(p_line, strava_line)
  where id = p_ride;
end $$;

-- Server functions read the cron secret to authenticate scheduled calls
create or replace function public.check_cron_secret(p text) returns boolean language sql stable security definer set search_path = public, vault as $$
  select exists (select 1 from vault.decrypted_secrets where name = 'pitik_cron_secret' and decrypted_secret = p and length(p) > 20)
$$;

-- Wipe stored ride tracks once they are no longer needed for late uploads
create or replace function public.purge_tracks() returns int language sql security definer set search_path = public as $$
  with u as (update rides set track = null where track is not null and track_expires_at < now() returning 1) select count(*)::int from u
$$;

-- ---------------------------------------------------------------- privileges
-- Tables: start from nothing, then grant exactly what the app uses. RLS policies above decide which rows.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select (key, value) on public.app_config to anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, email_notify) on public.profiles to authenticated;
grant select (id, name, handle, price, fb_page, status, founding, created_at) on public.pitikeros to anon, authenticated;
grant insert (id, name, handle, price, gcash_number, gcash_name, fb_page, referred_by) on public.pitikeros to authenticated;
grant update (name, price, gcash_number, gcash_name, fb_page) on public.pitikeros to authenticated;
grant select on public.shoots to anon, authenticated;
grant insert (pitikero_id, lat, lon, accuracy_m, pin_source, place_label, clock_offset_ms, checked_in_at) on public.shoots to authenticated;
grant update (lat, lon, accuracy_m, pin_source, place_label, clock_offset_ms, clock_checked) on public.shoots to authenticated;
grant select on public.photos to authenticated;
grant insert (id, shoot_id, pitikero_id, camera_time, camera, width, height, source_key, original_path, preview_path, thumb_path) on public.photos to authenticated;
grant update (hidden) on public.photos to authenticated;
grant select (id, user_id, source, strava_activity_id, name, started_at, ended_at, notified_at, created_at) on public.rides to authenticated;
grant delete on public.rides to authenticated;
grant select on public.passes to authenticated;
grant select on public.credits to authenticated;
grant select on public.orders to authenticated;
grant select on public.order_items to authenticated;
grant select on public.order_tips to authenticated;
grant select on public.payouts to authenticated;
grant select on public.ledger to authenticated;
grant select on public.gateway_webhook_log to authenticated;
grant insert (user_id, name, role, would_use, checkin_easy, price_ok, liked, confusing, missing, contact, page) on public.feedback to anon, authenticated;
grant select on public.feedback to authenticated;

-- Functions: nobody by default; then the ones the app calls.
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;      -- used inside policies
grant execute on function
  public.my_pitikero(), public.my_strava(), public.shoot_uploaded(uuid, boolean),
  public.add_gpx_ride(text, jsonb), public.add_manual_pass(uuid, timestamptz),
  public.photos_for_pass(uuid, int), public.my_rides(int), public.shoots_on(date),
  public.create_order(uuid[], jsonb), public.settle_free_order(uuid),
  public.my_purchases(), public.my_kita(),
  public.admin_balances(), public.admin_set_pitikero(uuid, text, boolean), public.admin_record_payout(uuid, numeric, text, text, text),
  public.admin_add_extra(uuid, text, numeric, text), public.admin_give_credit(text, numeric, text), public.admin_overview()
to authenticated;
grant execute on function public.shoots_on(date) to anon;

-- The server functions (service role) call these
grant execute on all functions in schema public to service_role;
