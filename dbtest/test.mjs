// Runs the Pitik migrations on an in-process Postgres with small Supabase stand-ins, then walks
// through the main flows and the attacks found in review: check-in, upload, matching, orders,
// payment settlement, credits, payouts, RLS, storage access.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated;
create schema auth; grant usage on schema auth to anon, authenticated;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
create schema storage; grant usage on schema storage to anon, authenticated;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
grant execute on function storage.foldername(text) to anon, authenticated;
create schema vault;
create table vault.secrets (name text primary key, secret text);
create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
insert into vault.secrets values ('pitik_cron_secret', 'a-long-enough-cron-secret-value');
`);
for (const f of ['20261007000001_pitik_core.sql', '20261007000002_storage.sql']) {
  try { await db.exec(readFileSync('../supabase/migrations/' + f, 'utf8').replace('create extension if not exists pgcrypto;', '')); console.log('applied', f); }
  catch (e) { console.error('FAILED', f, e.message); process.exit(1); }
}

let fails = 0, passes = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; else passes++; };
const as = async (uid, fn) => {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await fn(); } finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
const expectErr = async (p, msg) => { try { await p; ok(false, msg + ' (no error)'); } catch (e) { ok(true, msg + ' → ' + e.message.split('\n')[0]); } };
const uuid = () => crypto.randomUUID();

const P = '11111111-1111-1111-1111-111111111111', R = '22222222-2222-2222-2222-222222222222', A = '33333333-3333-3333-3333-333333333333',
  R2 = '44444444-4444-4444-4444-444444444444', X = '55555555-5555-5555-5555-555555555555';
await q(`insert into auth.users values ($1,'jun@example.com'),($2,'rider@example.com'),($3,'nicolohallare@gmail.com'),($4,'other@example.com'),($5,'attacker@example.com')`, [P, R, A, R2, X]);
console.log('users');
ok((await q(`select is_admin from profiles where id=$1`, [A]))[0].is_admin === true, 'admin email becomes admin');
ok((await q(`select sum(amount)::int s from credits where user_id=$1`, [R]))[0].s === 100, 'new rider gets ₱100 founding credit');
await expectErr(as(R, () => q(`update profiles set is_admin = true where id=$1`, [R])), 'a rider cannot make themselves admin');
await expectErr(as(null, () => q(`select cfg('admin_emails')`)), 'public cannot read private config');
await expectErr(as(R, () => q(`select purge_tracks()`)), 'riders cannot call server-only functions');

console.log('pitikero onboarding');
await as(P, () => q(`insert into pitikeros (id,name,handle,price,gcash_number,gcash_name) values ($1,'Jun','jun.shots',50,'09171234567','Jun D.')`, [P]));
ok((await q(`select status from pitikeros where id=$1`, [P]))[0].status === 'pending', 'new pitikero starts pending');
await expectErr(as(P, () => q(`update pitikeros set status='active' where id=$1`, [P])), 'a pitikero cannot activate themselves');
await as(A, () => q(`select admin_set_pitikero($1,'active',true)`, [P]));
await expectErr(as(P, () => q(`update pitikeros set price=20 where id=$1`, [P])), 'price below ₱50 refused');
await expectErr(as(R, () => q(`select gcash_number from pitikeros`)), 'riders cannot read GCash numbers');
ok((await as(R, () => q(`select name from pitikeros`))).length === 1, 'riders can see pitikero names');

console.log('check-in and upload');
const day = '2026-10-04';
const [shoot] = await as(P, () => q(`insert into shoots (pitikero_id,lat,lon,accuracy_m,checked_in_at,place_label) values ($1,14.59472,121.16750,6,$2,'Taktak bend') returning id`, [P, day + 'T06:55:00+08:00']));
await expectErr(as(P, () => q(`insert into shoots (pitikero_id,lat,lon,photo_count,done_at) values ($1,14.5,121.1,999,now())`, [P])), 'pitikero cannot fake photo counts or "done" on a new shoot');
const photoIds = [];
for (let i = 0; i < 12; i++) {
  const t = new Date(Date.parse(day + 'T07:00:00+08:00') + i * 120000).toISOString();
  const id = uuid(); photoIds.push(id);
  await as(P, () => q(`insert into photos (id,shoot_id,pitikero_id,camera_time,original_path,preview_path,thumb_path,source_key) values ($1,$2,$3,$4,'x','y','z',$5)`,
    [id, shoot.id, P, t, 'IMG_' + i + '.JPG:1000']));
}
const ph0 = (await q(`select original_path, preview_path from photos where id=$1`, [photoIds[0]]))[0];
ok(ph0.original_path === `${P}/${shoot.id}/${photoIds[0]}.jpg` && ph0.preview_path.endsWith('-p.jpg'), 'server sets the storage paths, ignoring the browser');
await as(P, () => q(`select shoot_uploaded($1)`, [shoot.id]));
let s = (await q(`select photo_count from shoots where id=$1`, [shoot.id]))[0];
ok(s.photo_count === 12, '12 photos counted on the shoot');
await expectErr(as(R, () => q(`insert into photos (shoot_id,pitikero_id,camera_time,original_path,preview_path,thumb_path,source_key) values ($1,$2,now(),'x','y','z','k')`, [shoot.id, P])), 'a rider cannot add photos to someone else\'s shoot');
ok((await as(R, () => q(`select id from photos`))).length === 0, 'riders cannot list photos directly');

console.log('Strava ride matching');
const track = [];
const t0 = Date.parse(day + 'T07:05:00+08:00');
for (let k = 0; k <= 18 * 60; k += 2) {           // 7:05 → 7:23, passing the spot at 7:14
  const frac = (k - 9 * 60) / (9 * 60);
  track.push({ t: new Date(t0 + k * 1000).toISOString(), lat: 14.59472 + frac * 0.01, lon: 121.16750 + frac * 0.004 });
}
const ing = (await q(`select ingest_ride($1,'strava',123456,'Sunday morning ride',$2,$3,$4::jsonb) r`, [R, track[0].t, track[track.length - 1].t, JSON.stringify(track)]))[0].r;
ok(ing.passes === 1, 'one pass found for the ride (' + ing.passes + ')');
let rides = (await as(R, () => q(`select my_rides() r`)))[0].r;
let pass = rides[0].passes[0];
ok(new Date(pass.passed_at).toISOString() === new Date(day + 'T07:14:00+08:00').toISOString(), 'pass time is 7:14');
ok(pass.count === 3, 'three shots in the ±3 min window (' + pass.count + ')');
ok((await as(R2, () => q(`select * from photos_for_pass($1)`, [pass.id]))).length === 0, 'another rider sees nothing for that pass');
ok((await as(R, () => q(`select * from photos_for_pass($1, 99)`, [pass.id]))).length <= 11, 'window is capped at ±10 min');
ok((await as(R, () => q(`select track from rides`)).catch(() => 'denied')) === 'denied', 'rider cannot read the stored track column');

console.log('rider who stops at the spot');
const stopTrack = [];
for (let k = 0; k <= 20 * 60; k += 5) {   // 7:05→7:25: rides in, stops 7:10–7:20 right at the spot, rides out
  const m = k / 60;
  const off = m < 5 ? (5 - m) * 0.0012 : m > 15 ? (m - 15) * 0.0012 : 0.00001 * (m % 2);
  stopTrack.push({ t: new Date(t0 + k * 1000).toISOString(), lat: 14.59472 + off, lon: 121.16750 });
}
const ingS = (await q(`select ingest_ride($1,'strava',777,'Coffee stop',$2,$3,$4::jsonb) r`, [R2, stopTrack[0].t, stopTrack.at(-1).t, JSON.stringify(stopTrack)]))[0].r;
const r2p = (await as(R2, () => q(`select my_rides() r`)))[0].r[0].passes[0];
ok(ingS.passes === 1 && r2p.count >= 8, 'a rider who stops sees the whole stop plus ±3 min (' + r2p.count + ' shots)');

console.log('far ride, clock correction, late uploads');
const far = track.map(p => ({ ...p, lat: p.lat - 0.2 }));
ok((await q(`select ingest_ride($1,'strava',999,'Marikina spin',$2,$3,$4::jsonb) r`, [R, far[0].t, far.at(-1).t, JSON.stringify(far)]))[0].r.passes === 0, 'no pass when the ride never came near');
await as(P, () => q(`update shoots set clock_offset_ms = 120000, clock_checked = true where id=$1`, [shoot.id]));
s = (await q(`select first_shot_at from shoots where id=$1`, [shoot.id]))[0];
ok(new Date(s.first_shot_at).toISOString() === new Date(day + 'T07:02:00+08:00').toISOString(), 'all shots shift by +2 min');
rides = (await as(R, () => q(`select my_rides() r`)))[0].r;
const strav = rides.find(r => r.strava_activity_id == 123456);
ok(strav.passes.length === 1, 'ride re-matched after the clock change');
const pass2 = strav.passes[0];
await q(`update rides set track_expires_at = now() - interval '1 minute'`); await q(`select purge_tracks()`);
await as(P, () => q(`select shoot_uploaded($1, true)`, [shoot.id]));
ok((await as(R, () => q(`select count(*)::int n from passes`)))[0].n === 1, 'passes survive after the ride track is deleted');
await q(`update shoots set done_at = null`);

console.log('manual pass (no Strava)');
await as(R2, () => q(`select add_manual_pass($1, $2) r`, [shoot.id, day + 'T07:20:00+08:00']));
const r2rides = (await as(R2, () => q(`select my_rides() r`)))[0].r;
const mp = r2rides.find(r => r.source === 'manual').passes[0];
const mshots = (await as(R2, () => q(`select * from photos_for_pass($1)`, [mp.id]))).length;
ok(mshots >= 5 && mshots <= 7, 'manual pass shows about ±6 min (' + mshots + ')');
await as(R2, () => q(`select add_manual_pass($1, $2)`, [shoot.id, day + 'T07:05:00+08:00']));
await expectErr(as(R2, () => q(`select add_manual_pass($1, $2)`, [shoot.id, day + 'T07:12:00+08:00'])), 'third manual look at the same shoot is refused');
await expectErr(as(R, () => q(`select add_manual_pass($1, $2)`, [shoot.id, day + 'T13:00:00+08:00'])), 'manual time far from the shoot is refused');

console.log('order and payment');
const pick = (await as(R, () => q(`select * from photos_for_pass($1)`, [pass2.id]))).slice(0, 2).map(r => r.id);
const earliest = (await q(`select id from photos where pitikero_id=$1 order by taken_at limit 1`, [P]))[0].id;
await expectErr(as(R, () => q(`select create_order($1::uuid[], '{}'::jsonb)`, [[earliest]])), 'cannot buy a photo outside your passes');
await expectErr(as(R, () => q(`select create_order($1::uuid[], $2::jsonb)`, [pick, JSON.stringify({ [P]: -50 })])), 'negative tips refused');
const order = (await as(R, () => q(`select create_order($1::uuid[], $2::jsonb) r`, [pick, JSON.stringify({ [P]: 100 })])))[0].r;
ok(order.photos_amount == 100 && order.tips_amount == 100 && order.fee_amount == 20 && order.credit_amount == 100 && order.total == 120,
  `totals: photos ${order.photos_amount} + tip ${order.tips_amount} + fee ${order.fee_amount} − credit ${order.credit_amount} = ${order.total}`);
ok((await q(`select count(*)::int n from credits where user_id=$1 and used_order_id is null`, [R]))[0].n === 0, 'credit is reserved at checkout');
await expectErr(as(R, () => q(`select start_order_payment($1,$2)`, [R, order.id])), 'riders cannot start a payment directly');
await expectErr(q(`select start_order_payment($1,$2)`, [R, order.id]), 'gateway in admins-only mode refuses riders');
await q(`update app_config set value='true' where key='gateway_live'`);
const att1 = (await q(`select start_order_payment($1,$2) r`, [R, order.id]))[0].r.reference;
const att2 = (await q(`select start_order_payment($1,$2) r`, [R, order.id]))[0].r.reference;
ok(att1 !== att2 && att1.startsWith('PTK'), 'each payment page gets its own server-made reference');
let res = (await q(`select settle_gateway_payment($1, 120, 'completed', 2.1, '{}'::jsonb) r`, [att1]))[0].r;
ok(res.ok && res.fulfilled == 120, 'paying on the FIRST link still settles the order');
res = (await q(`select settle_gateway_payment($1, 120, 'completed', 2.1, '{}'::jsonb) r`, [att1]))[0].r;
ok(res.already === true, 'repeat webhook does nothing (idempotent)');
res = (await q(`select settle_gateway_payment($1, 120, 'completed', 2.1, '{}'::jsonb) r`, [att2]))[0].r;
ok(res.ok === false && /another link/.test(res.reason), 'a second payment on the other link is flagged for refund');
const led = await q(`select kind, sum(amount)::int a, count(*)::int n from ledger where pitikero_id=$1 group by kind order by kind`, [P]);
ok(JSON.stringify(led) === JSON.stringify([{ kind: 'sale', a: 100, n: 2 }, { kind: 'tip', a: 100, n: 1 }]), 'pitikero ledger: ₱100 sales + ₱100 tip, once');
ok((await as(R, () => q(`select my_purchases() r`)))[0].r.length === 2, 'rider library has the 2 photos');
await q(`insert into storage.objects (bucket_id, name) select 'originals', original_path from photos`);
ok((await as(R, () => q(`select name from storage.objects where bucket_id='originals'`))).length === 2, 'rider can open only the 2 originals they paid for');
ok((await as(R2, () => q(`select name from storage.objects where bucket_id='originals'`))).length === 0, 'other riders open none');
ok((await as(P, () => q(`select name from storage.objects where bucket_id='originals'`))).length === 12, 'pitikero opens all their own');
await as(P, () => q(`delete from storage.objects where bucket_id='originals'`));
ok((await q(`select count(*)::int n from storage.objects where bucket_id='originals'`))[0].n === 12, 'pitikero cannot delete originals (buyers keep access)');
await expectErr(as(R, () => q(`select create_order($1::uuid[], '{}'::jsonb)`, [pick])), 'cannot buy the same photos twice');

console.log('attack: point a photo row at someone else\'s original');
await as(X, () => q(`insert into pitikeros (id,name,handle,gcash_number,gcash_name) values ($1,'X','xx','09170000000','X')`, [X]));
await as(A, () => q(`select admin_set_pitikero($1,'active',false)`, [X]));
const [xs] = await as(X, () => q(`insert into shoots (pitikero_id,lat,lon,checked_in_at) values ($1,14.59472,121.16750,$2) returning id`, [X, day + 'T06:55:00+08:00']));
const victimPath = `${P}/${shoot.id}/${photoIds[5]}.jpg`;
const xid = uuid();
await as(X, () => q(`insert into photos (id,shoot_id,pitikero_id,camera_time,original_path,preview_path,thumb_path,source_key) values ($1,$2,$3,$4,$5,$5,$5,'k')`,
  [xid, xs.id, X, day + 'T07:10:00+08:00', victimPath]));
ok((await q(`select original_path from photos where id=$1`, [xid]))[0].original_path.startsWith(X), 'spoofed path is replaced with the attacker\'s own folder');
await as(X, () => q(`select shoot_uploaded($1)`, [xs.id]));
await as(X, () => q(`select add_manual_pass($1, $2)`, [xs.id, day + 'T07:10:00+08:00']));
await expectErr(as(X, () => q(`select create_order($1::uuid[], '{}'::jsonb)`, [[xid]])), 'a pitikero cannot buy their own shots with credit');
ok((await as(X, () => q(`select name from storage.objects where bucket_id='originals' and name=$1`, [victimPath]))).length === 0, 'victim\'s original stays private');

console.log('attack: spend the same credit twice');
const r2pass = (await as(R2, () => q(`select my_rides() r`)))[0].r.flatMap(r => r.passes);
const r2photos = [];
for (const p of r2pass) for (const ph of await as(R2, () => q(`select * from photos_for_pass($1)`, [p.id]))) if (!r2photos.includes(ph.id)) r2photos.push(ph.id);
const oA = (await as(R2, () => q(`select create_order($1::uuid[], '{}'::jsonb) r`, [r2photos.slice(0, 2)])))[0].r;
await q(`select start_order_payment($1,$2)`, [R2, oA.id]);     // reached the payment page, so it keeps its credit
const oB = (await as(R2, () => q(`select create_order($1::uuid[], '{}'::jsonb) r`, [r2photos.slice(2, 3)])))[0].r;
ok(Number(oA.credit_amount) + Number(oB.credit_amount) <= 100, `credit used across both orders ≤ ₱100 (${oA.credit_amount} + ${oB.credit_amount})`);
ok((await q(`select coalesce(sum(amount),0)::int s from credits where user_id=$1`, [R2]))[0].s === 100, 'credit is split, not lost or duplicated (total still ₱100)');

console.log('amount mismatch is held');
const pick2 = (await as(R, () => q(`select * from photos_for_pass($1)`, [pass2.id]))).slice(2, 3).map(r => r.id);
const order2 = (await as(R, () => q(`select create_order($1::uuid[], '{}'::jsonb) r`, [pick2])))[0].r;
ok(order2.total == 60, 'second order ₱50 + ₱10 fee = ₱60 (no credit left)');
const att3 = (await q(`select start_order_payment($1,$2) r`, [R, order2.id]))[0].r.reference;
res = (await q(`select settle_gateway_payment($1, 1, 'completed', 0, '{}'::jsonb) r`, [att3]))[0].r;
ok(res.ok === false && (await q(`select status from orders where id=$1`, [order2.id]))[0].status === 'review', 'wrong amount → held for review, not fulfilled');

console.log('cancelled payment gives credit back');
const credBefore = (await q(`select coalesce(sum(amount),0)::int s from credits where user_id=$1 and used_order_id is null`, [R2]))[0].s;
const r2o = (await as(R2, () => q(`select create_order($1::uuid[], '{}'::jsonb) r`, [r2photos.slice(3, 4)])))[0].r;
const attC = (await q(`select start_order_payment($1,$2) r`, [R2, r2o.id]))[0].r.reference;
await q(`select settle_gateway_payment($1, 0, 'expired', null, '{}'::jsonb)`, [attC]);
ok((await q(`select status from orders where id=$1`, [r2o.id]))[0].status === 'cancelled', 'expired payment cancels the order');
ok((await q(`select coalesce(sum(amount),0)::int s from credits where user_id=$1 and used_order_id is null`, [R2]))[0].s === credBefore, 'its credit is available again');

console.log('kita and payouts');
const kita = (await as(P, () => q(`select my_kita() r`)))[0].r;
ok(kita.unpaid == 200, 'pitikero sees ₱200 unpaid');
await expectErr(as(R, () => q(`select admin_balances()`)), 'riders cannot see admin balances');
const bal = (await as(A, () => q(`select admin_balances() r`)))[0].r;
ok(bal.find(b => b.id === P).unpaid == 200 && bal.find(b => b.id === P).gcash_number === '09171234567', 'admin sees balance and GCash');
await as(A, () => q(`select admin_add_extra($1,'allowance',300,'Trial Sunday Oct 4')`, [P]));
await expectErr(as(A, () => q(`select admin_record_payout($1,200,'REF1','','')`, [P])), 'payout refused when balance changed');
ok((await q(`select count(*)::int n from payouts`))[0].n === 0, 'refused payout leaves nothing behind');
await as(A, () => q(`select admin_record_payout($1,500,'GC123456','${P}/r.jpg','Week 1')`, [P]));
const kita2 = (await as(P, () => q(`select my_kita() r`)))[0].r;
ok(kita2.unpaid == 0 && kita2.payouts.length === 1 && kita2.payouts[0].gcash_ref === 'GC123456', 'pitikero sees payout with GCash ref');

console.log('notifications');
await q(`update rides set started_at = now() - interval '2 hours', ended_at = now() - interval '1 hour'`);
await q(`update shoots set done_at = null`);
let todo = (await q(`select rides_to_notify() r`))[0].r;
const before = todo.filter(x => x.user_id === R).length;
await q(`update shoots set done_at = now()`);
todo = (await q(`select rides_to_notify() r`))[0].r;
const mine = todo.filter(x => x.user_id === R);
ok(before === 0 && mine.length >= 1 && mine[0].passes.length >= 1, 'ride is ready to notify only once the pitikero is done');
await q(`select mark_notified($1, 'line', false)`, [mine[0].ride_id]);
ok((await q(`select rides_to_notify() r`))[0].r.some(x => x.ride_id === mine[0].ride_id), 'a failed send is retried');
await q(`select mark_notified($1, 'line', true)`, [mine[0].ride_id]);
ok(!(await q(`select rides_to_notify() r`))[0].r.some(x => x.ride_id === mine[0].ride_id), 'not notified twice');

console.log('feedback');
await as(null, () => q(`insert into feedback (name, role, liked) values ('Jun','pitikero','ok')`));
ok((await as(null, () => q(`select * from feedback`)).catch(() => 'denied')) === 'denied', 'public cannot read feedback');
ok((await as(A, () => q(`select * from feedback`))).length === 1, 'admin reads feedback');

console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\nall ${passes} passed`);
process.exit(fails ? 1 : 0);
