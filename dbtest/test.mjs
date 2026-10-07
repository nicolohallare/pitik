// Runs the Pitik migrations on an in-process Postgres with small Supabase stand-ins, then walks
// through the main flows: check-in, upload, ride matching, order, payment settlement, payouts, RLS.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const stub = `
create role anon; create role authenticated; create role service_role;
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
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
create schema vault;
create table vault.secrets (name text primary key, secret text);
create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets;
insert into vault.secrets values ('pitik_cron_secret', 'shh');
`;
await db.exec(stub);
for (const f of ['20261007000001_pitik_core.sql', '20261007000002_storage.sql']) {
  try { await db.exec(readFileSync('../supabase/migrations/' + f, 'utf8').replace('create extension if not exists pgcrypto;', '')); console.log('applied', f); }
  catch (e) { console.error('FAILED', f, e.message); process.exit(1); }
}

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };
const as = async (uid, fn) => {
  await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await fn(); } finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
const expectErr = async (p, msg) => { try { await p; ok(false, msg + ' (no error)'); } catch (e) { ok(true, msg + ' → ' + e.message.split('\n')[0]); } };

const P = '11111111-1111-1111-1111-111111111111', R = '22222222-2222-2222-2222-222222222222', A = '33333333-3333-3333-3333-333333333333', R2 = '44444444-4444-4444-4444-444444444444';
await q(`insert into auth.users values ($1,'jun@example.com'),($2,'rider@example.com'),($3,'nicolohallare@gmail.com'),($4,'other@example.com')`, [P, R, A, R2]);
console.log('users');
ok((await q(`select is_admin from profiles where id=$1`, [A]))[0].is_admin === true, 'admin email becomes admin');
ok((await q(`select sum(amount)::int s from credits where user_id=$1`, [R]))[0].s === 100, 'new rider gets ₱100 founding credit');

console.log('pitikero onboarding');
await as(P, () => q(`insert into pitikeros (id,name,handle,price,gcash_number,gcash_name) values ($1,'Jun','jun.shots',50,'09171234567','Jun D.')`, [P]));
await expectErr(as(P, () => q(`update pitikeros set price=20 where id=$1`, [P])), 'price below ₱50 refused');
await expectErr(as(R, () => q(`select gcash_number from pitikeros`)), 'riders cannot read GCash numbers');
ok((await as(R, () => q(`select name from pitikeros`))).length === 1, 'riders can see pitikero names');

console.log('check-in and upload');
const day = '2026-10-04';
const [shoot] = await as(P, () => q(`insert into shoots (pitikero_id,lat,lon,accuracy_m,checked_in_at,place_label) values ($1,14.59472,121.16750,6,$2,'Taktak bend') returning id`, [P, day + 'T06:55:00+08:00']));
for (let i = 0; i < 12; i++) {
  const t = new Date(Date.parse(day + 'T07:00:00+08:00') + i * 120000).toISOString();
  await as(P, () => q(`insert into photos (shoot_id,pitikero_id,camera_time,original_path,preview_path,thumb_path,source_key) values ($1,$2,$3,$4,$5,$6,$7)`,
    [shoot.id, P, t, `${P}/${shoot.id}/o${i}.jpg`, `${P}/${shoot.id}/p${i}.jpg`, `${P}/${shoot.id}/t${i}.jpg`, 'IMG_' + i + '.JPG:1000']));
}
await as(P, () => q(`select shoot_uploaded($1)`, [shoot.id]));
let s = (await q(`select photo_count, first_shot_at, last_shot_at from shoots where id=$1`, [shoot.id]))[0];
ok(s.photo_count === 12, '12 photos counted on the shoot');
await expectErr(as(R, () => q(`insert into photos (shoot_id,pitikero_id,camera_time,original_path,preview_path,thumb_path,source_key) values ($1,$2,now(),'x','y','z','k')`, [shoot.id, P])), 'a rider cannot add photos to someone else\'s shoot');
ok((await as(R, () => q(`select id from photos`))).length === 0, 'riders cannot list photos directly');

console.log('Strava ride matching');
// Ride passes the spot at 7:14 (going up) and again at 7:40 (coming down, outside photos +15 min? last shot 7:22 → window to 7:37)
const track = [];
const t0 = Date.parse(day + 'T07:05:00+08:00');
for (let k = 0; k <= 18 * 60; k += 2) {           // 7:05 → 7:23, passing the spot at 7:14
  const frac = (k - 9 * 60) / (9 * 60);
  track.push({ t: new Date(t0 + k * 1000).toISOString(), lat: 14.59472 + frac * 0.01, lon: 121.16750 + frac * 0.004 });
}
const ing = (await q(`select ingest_ride($1,'strava',123456,'Sunday morning ride',$2,$3,$4::jsonb) r`, [R, track[0].t, track[track.length - 1].t, JSON.stringify(track)]))[0].r;
ok(ing.passes === 1, 'one pass found for the ride (' + ing.passes + ')');
const rides = (await as(R, () => q(`select my_rides() r`)))[0].r;
const pass = rides[0].passes[0];
ok(new Date(pass.passed_at).toISOString() === new Date(day + 'T07:14:00+08:00').toISOString(), 'pass time is 7:14');
ok(pass.count === 3, 'three shots in the ±3 min window (' + pass.count + ')');
const shots = await as(R, () => q(`select * from photos_for_pass($1)`, [pass.id]));
ok(shots.length === 3, 'rider sees exactly those three shots');
ok((await as(R2, () => q(`select * from photos_for_pass($1)`, [pass.id]))).length === 0, 'another rider sees nothing for that pass');
const wide = await as(R, () => q(`select * from photos_for_pass($1, 10)`, [pass.id]));
ok(wide.length === 10, '±10 min shows more (' + wide.length + ')');
ok((await as(R, () => q(`select track from rides`)).catch(() => 'denied')) === 'denied', 'rider cannot read the stored track column');

console.log('ride far away does not match');
const far = track.map(p => ({ ...p, lat: p.lat - 0.2 }));
const ing2 = (await q(`select ingest_ride($1,'strava',999,'Marikina spin',$2,$3,$4::jsonb) r`, [R, far[0].t, far[far.length - 1].t, JSON.stringify(far)]))[0].r;
ok(ing2.passes === 0, 'no pass when the ride never came near');

console.log('clock correction');
await as(P, () => q(`update shoots set clock_offset_ms = 120000, clock_checked = true where id=$1`, [shoot.id]));
s = (await q(`select first_shot_at from shoots where id=$1`, [shoot.id]))[0];
ok(new Date(s.first_shot_at).toISOString() === new Date(day + 'T07:02:00+08:00').toISOString(), 'all shots shift by +2 min');
const rides2 = (await as(R, () => q(`select my_rides() r`)))[0].r;
const strav = rides2.find(r => r.strava_activity_id == 123456);
ok(strav.passes.length === 1, 'ride re-matched after the clock change');
const pass2 = strav.passes[0];

console.log('manual pass (no Strava)');
const man = (await as(R2, () => q(`select add_manual_pass($1, $2) r`, [shoot.id, day + 'T07:20:00+08:00'])))[0].r;
const r2rides = (await as(R2, () => q(`select my_rides() r`)))[0].r;
ok(r2rides[0].passes.length === 1, 'manual pass recorded');
const manShots = await as(R2, () => q(`select * from photos_for_pass($1)`, [r2rides[0].passes[0].id]));
ok(manShots.length >= 8, 'manual pass shows a wider ±10 min (' + manShots.length + ')');
await expectErr(as(R2, () => q(`select add_manual_pass($1, $2)`, [shoot.id, day + 'T13:00:00+08:00'])), 'manual time far from the shoot is refused');

console.log('order and payment');
const pick = (await as(R, () => q(`select * from photos_for_pass($1)`, [pass2.id]))).slice(0, 2).map(r => r.id);
const earliest = (await q(`select id from photos order by taken_at limit 1`))[0].id;
await expectErr(as(R2, () => q(`select create_order($1::uuid[], '{}'::jsonb)`, [[earliest]])), 'cannot buy a photo outside your passes');
const order = (await as(R, () => q(`select create_order($1::uuid[], $2::jsonb) r`, [pick, JSON.stringify({ [P]: 100 })])))[0].r;
ok(order.photos_amount == 100 && order.tips_amount == 100 && order.fee_amount == 20 && order.credit_amount == 100 && order.total == 120,
  `totals: photos ${order.photos_amount} + tip ${order.tips_amount} + fee ${order.fee_amount} − credit ${order.credit_amount} = ${order.total}`);
await expectErr(as(R, () => q(`select start_order_payment($1,'PTKTEST1')`, [order.id])), 'gateway in admins-only mode refuses riders');
await q(`update app_config set value='true' where key='gateway_live'`);
await as(R, () => q(`select start_order_payment($1,'PTKTEST1')`, [order.id]));
let res = (await q(`select settle_gateway_payment('PTKTEST1', 120, 'completed', 2.1, '{}'::jsonb) r`))[0].r;
ok(res.ok && res.fulfilled == 120, 'verified payment settles the order');
res = (await q(`select settle_gateway_payment('PTKTEST1', 120, 'completed', 2.1, '{}'::jsonb) r`))[0].r;
ok(res.already === true, 'repeat webhook does nothing (idempotent)');
const led = await q(`select kind, sum(amount)::int a, count(*)::int n from ledger where pitikero_id=$1 group by kind order by kind`, [P]);
ok(JSON.stringify(led) === JSON.stringify([{ kind: 'sale', a: 100, n: 2 }, { kind: 'tip', a: 100, n: 1 }]), 'pitikero ledger: ₱100 sales + ₱100 tip, once');
ok((await q(`select count(*)::int n from credits where user_id=$1 and used_order_id is null`, [R]))[0].n === 0, 'founding credit used');
const lib = (await as(R, () => q(`select my_purchases() r`)))[0].r;
ok(lib.length === 2, 'rider library has the 2 photos');
await q(`insert into storage.objects (bucket_id, name) select 'originals', original_path from photos`);
ok((await as(R, () => q(`select name from storage.objects where bucket_id='originals'`))).length === 2, 'rider can open only the 2 originals they paid for');
ok((await as(R2, () => q(`select name from storage.objects where bucket_id='originals'`))).length === 0, 'other riders open none');
ok((await as(P, () => q(`select name from storage.objects where bucket_id='originals'`))).length === 12, 'pitikero opens all their own');
await expectErr(as(R, () => q(`select create_order($1::uuid[], '{}'::jsonb)`, [pick])), 'cannot buy the same photos twice');

console.log('amount mismatch is held');
const pick2 = (await as(R, () => q(`select * from photos_for_pass($1)`, [pass2.id]))).slice(2, 3).map(r => r.id);
const order2 = (await as(R, () => q(`select create_order($1::uuid[], '{}'::jsonb) r`, [pick2])))[0].r;
ok(order2.total == 60, 'second order ₱50 + ₱10 fee = ₱60 (no credit left)');
await as(R, () => q(`select start_order_payment($1,'PTKTEST2')`, [order2.id]));
res = (await q(`select settle_gateway_payment('PTKTEST2', 1, 'completed', 0, '{}'::jsonb) r`))[0].r;
ok(res.ok === false && (await q(`select status from orders where id=$1`, [order2.id]))[0].status === 'review', 'wrong amount → held for review, not fulfilled');

console.log('kita and payouts');
const kita = (await as(P, () => q(`select my_kita() r`)))[0].r;
ok(kita.unpaid == 200, 'pitikero sees ₱200 unpaid');
await expectErr(as(R, () => q(`select admin_balances()`)), 'riders cannot see admin balances');
const bal = (await as(A, () => q(`select admin_balances() r`)))[0].r;
ok(bal[0].unpaid == 200 && bal[0].gcash_number === '09171234567', 'admin sees balance and GCash');
await as(A, () => q(`select admin_add_extra($1,'allowance',300,'Trial Sunday Oct 4')`, [P]));
await expectErr(as(A, () => q(`select admin_record_payout($1,200,'REF1','','')`, [P])), 'payout refused when balance changed');
await as(A, () => q(`select admin_record_payout($1,500,'GC123456','${P}/r.jpg','Week 1')`, [P]));
const kita2 = (await as(P, () => q(`select my_kita() r`)))[0].r;
ok(kita2.unpaid == 0 && kita2.payouts.length === 1 && kita2.payouts[0].gcash_ref === 'GC123456', 'pitikero sees payout with GCash ref');

console.log('notifications');
let todo = (await q(`select rides_to_notify() r`))[0].r;
// ride date is in the past (Oct 4) so cutoff passed; but rides_to_notify only looks back 3 days from now()
await q(`update rides set started_at = now() - interval '2 hours', ended_at = now() - interval '1 hour'`);
await q(`update shoots set done_at = null`);
todo = (await q(`select rides_to_notify() r`))[0].r;
const before = todo.filter(x => x.user_id === R).length;
await q(`update shoots set done_at = now()`);
todo = (await q(`select rides_to_notify() r`))[0].r;
const mine = todo.filter(x => x.user_id === R);
ok(mine.length >= 1 && mine[0].passes.length >= 1, 'ride is ready to notify once the pitikero is done (before done: ' + before + ')');
await q(`select mark_notified($1, 'line')`, [mine[0].ride_id]);
todo = (await q(`select rides_to_notify() r`))[0].r;
ok(!todo.some(x => x.ride_id === mine[0].ride_id), 'not notified twice');

console.log('feedback');
await as(null, () => q(`insert into feedback (name, role, liked) values ('Jun','pitikero','ok')`));
ok((await as(null, () => q(`select * from feedback`)).catch(() => 'denied')) === 'denied', 'public cannot read feedback');
ok((await as(A, () => q(`select * from feedback`))).length === 1, 'admin reads feedback');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
