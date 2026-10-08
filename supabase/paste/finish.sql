-- Pitik: the last 3 database functions. Paste ALL of this into Supabase → SQL Editor → New query → Run.
-- (Everything else is already set up. These three contain DELETE steps, which Supabase only lets the
-- project owner apply.)

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

grant execute on function public.create_order(uuid[], jsonb) to authenticated;
grant execute on function public.rematch_shoot(uuid), public.ingest_ride(uuid, text, bigint, text, timestamptz, timestamptz, jsonb), public.create_order(uuid[], jsonb) to service_role;
select 'Pitik database ready' as status;
