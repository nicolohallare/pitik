// strava — connecting a rider's Strava and receiving their rides.
//   POST ?action=auth_url    (rider JWT)   → { url } for Strava's consent screen
//   GET  ?action=callback    (from Strava) → hands code+state back to the app (no linking here)
//   POST ?action=link        (rider JWT)   { code, state, scope } → links Strava to THIS signed-in rider
//   GET  ?action=webhook     (from Strava) → subscription check (hub.challenge)
//   POST ?action=webhook     (from Strava) → new/updated/deleted activity, or rider revoked access
//   POST ?action=sync        (rider JWT)   → re-import the last 7 days now
//   POST ?action=disconnect  (rider JWT)   → revoke at Strava and forget the tokens
//   POST ?action=status      (rider JWT)
//   POST ?action=subscribe   (admin JWT)   → create the Strava webhook subscription (one time) and remember its id
// Deploy with verify_jwt = false: Strava calls the callback and webhook without a Supabase token.
//
// Why linking happens in "link" and not in "callback": the state proves which Pitik user STARTED the
// connection, and "link" also requires that same user to be the one signed in when it finishes. A link
// crafted by someone else cannot attach a victim's Strava to the attacker's account.
import { admin, appUrl, CORS, currentUser, env, hmacHex, json, same } from '../_shared/util.ts';
import { accessToken, processActivity, StravaAccount, stravaGet } from '../_shared/strava.ts';

const FN_URL = `${env('SUPABASE_URL')}/functions/v1/strava`;
const stateKey = () => env('STRAVA_STATE_SECRET') || env('SUPABASE_SERVICE_ROLE_KEY');

async function makeState(userId: string) {
  const payload = `${userId}.${Date.now()}`;
  return `${btoa(payload).replace(/=+$/, '')}.${(await hmacHex(stateKey(), payload)).slice(0, 32)}`;
}
async function readState(state: string): Promise<string | null> {
  const [b, sig] = state.split('.');
  if (!b || !sig) return null;
  let payload = '';
  try { payload = atob(b + '='.repeat((4 - (b.length % 4)) % 4)); } catch { return null; }
  if (!same((await hmacHex(stateKey(), payload)).slice(0, 32), sig)) return null;
  const [uid, ts] = payload.split('.');
  if (Date.now() - Number(ts) > 30 * 60_000) return null;   // 30 minutes to finish connecting
  return uid;
}

async function accountFor(filter: { user_id?: string; athlete_id?: number }) {
  let q = admin().from('strava_accounts').select('*');
  if (filter.user_id) q = q.eq('user_id', filter.user_id);
  if (filter.athlete_id) q = q.eq('athlete_id', filter.athlete_id);
  const { data } = await q.maybeSingle();
  return (data as StravaAccount | null) ?? null;
}

const OUTDOOR = /ride|cycl|bike|gravel|mountain|handcycle|velomobile/i;

/** Import recent outdoor rides, skipping ones already imported (keeps us well inside Strava's rate limits). */
async function importRecent(acc: StravaAccount, days = 7) {
  const after = Math.floor((Date.now() - days * 86_400_000) / 1000);
  const list: Record<string, any>[] = (await stravaGet(acc, `/athlete/activities?after=${after}&per_page=15`)) ?? [];
  const rides = list.filter((a) => !a.trainer && !/virtual/i.test(String(a.sport_type ?? a.type)) && OUTDOOR.test(String(a.sport_type ?? a.type)) && a.start_latlng?.length);
  const { data: have } = await admin().from('rides').select('strava_activity_id').in('strava_activity_id', rides.map((a) => a.id));
  const seen = new Set((have ?? []).map((r: { strava_activity_id: number }) => Number(r.strava_activity_id)));
  const out: unknown[] = [];
  for (const a of rides.filter((a) => !seen.has(Number(a.id))).slice(0, 10)) {
    try { out.push({ id: a.id, result: await processActivity(acc, a.id, a) }); }
    catch (e) { out.push({ id: a.id, error: (e as Error).message }); }
  }
  return out;
}

async function subscriptionId(): Promise<string> {
  if (env('STRAVA_SUBSCRIPTION_ID')) return env('STRAVA_SUBSCRIPTION_ID');
  const { data } = await admin().from('app_config').select('value').eq('key', 'strava_subscription_id').maybeSingle();
  return String(data?.value ?? '');
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;
const later = (p: Promise<unknown>) => {
  const safe = p.catch((e) => console.error('background job failed', e));
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(safe);
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const configured = !!(env('STRAVA_CLIENT_ID') && env('STRAVA_CLIENT_SECRET'));

  if (action === 'auth_url') {
    if (!configured) return json({ error: 'Strava is not set up yet. Try again soon.' }, 503);
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again' }, 401);
    const p = new URLSearchParams({
      client_id: env('STRAVA_CLIENT_ID'), response_type: 'code', approval_prompt: 'auto',
      scope: 'read,activity:read_all,activity:write',
      redirect_uri: `${FN_URL}?action=callback`, state: await makeState(user.id),
    });
    return json({ url: `https://www.strava.com/oauth/authorize?${p}` });
  }

  if (action === 'callback') {
    // Hand everything back to the app; the signed-in rider finishes with action=link.
    const app = await appUrl();
    const p = new URLSearchParams();
    if (url.searchParams.get('error')) p.set('strava', 'denied');
    else for (const k of ['code', 'state', 'scope']) p.set('strava_' + k, url.searchParams.get(k) ?? '');
    return Response.redirect(`${app}/rider?${p}`, 302);
  }

  if (action === 'link') {
    if (!configured) return json({ error: 'Strava is not set up yet.' }, 503);
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again' }, 401);
    const { code, state, scope } = await req.json().catch(() => ({}));
    const uid = await readState(String(state ?? ''));
    if (!uid) return json({ error: 'That took too long. Tap Connect Strava again.' }, 400);
    if (uid !== user.id) return json({ error: 'This Strava link was started from a different Pitik account. Tap Connect Strava again.' }, 403);
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env('STRAVA_CLIENT_ID'), client_secret: env('STRAVA_CLIENT_SECRET'), code, grant_type: 'authorization_code' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.access_token || !j.athlete?.id) return json({ error: 'Strava did not connect. Try again in a minute.' }, 502);
    const sc = String(scope ?? '');
    // The Strava account owner just approved this on Strava's own screen, so it moves to this login.
    await admin().from('strava_accounts').delete().eq('athlete_id', j.athlete.id).neq('user_id', user.id);
    const row = {
      user_id: user.id, athlete_id: j.athlete.id,
      athlete_name: [j.athlete.firstname, j.athlete.lastname].filter(Boolean).join(' ').slice(0, 80),
      access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: new Date(j.expires_at * 1000).toISOString(), scope: sc, write_ok: sc.includes('activity:write'),
    };
    const { error } = await admin().from('strava_accounts').upsert(row, { onConflict: 'user_id' });
    if (error) return json({ error: 'Could not save the connection. Try again.' }, 500);
    later(importRecent(row as StravaAccount));
    return json({ ok: true, athlete_name: row.athlete_name, write_ok: row.write_ok });
  }

  if (action === 'webhook' && req.method === 'GET') {
    if (!env('STRAVA_VERIFY_TOKEN') || url.searchParams.get('hub.verify_token') !== env('STRAVA_VERIFY_TOKEN')) {
      return json({ error: 'bad verify token' }, 403);
    }
    return json({ 'hub.challenge': url.searchParams.get('hub.challenge') });
  }

  if (action === 'webhook' && req.method === 'POST') {
    // Strava wants a 200 within 2 seconds, so answer first and work in the background.
    let ev: Record<string, unknown> = {};
    try { ev = await req.json(); } catch { return json({ ok: true }); }
    const sub = await subscriptionId();
    if (!sub || String(ev.subscription_id) !== sub) return json({ ok: true });   // not from our subscription
    later((async () => {
      const acc = await accountFor({ athlete_id: Number(ev.owner_id) });
      if (!acc) return;
      // Events are not signed, so anything destructive is confirmed with Strava first.
      if (ev.object_type === 'athlete' && (ev.updates as Record<string, string>)?.authorized === 'false') {
        // Only a clear "invalid grant" from Strava counts as revoked; outages and rate limits do not.
        const r = await fetch('https://www.strava.com/oauth/token', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: env('STRAVA_CLIENT_ID'), client_secret: env('STRAVA_CLIENT_SECRET'), grant_type: 'refresh_token', refresh_token: acc.refresh_token }),
        });
        if (r.status === 400 || r.status === 401) await admin().from('strava_accounts').delete().eq('user_id', acc.user_id);
        else if (r.ok) {
          const j = await r.json();
          await admin().from('strava_accounts').update({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: new Date(j.expires_at * 1000).toISOString() }).eq('user_id', acc.user_id);
        }
        return;
      }
      if (ev.object_type !== 'activity') return;
      const activityId = Number(ev.object_id);
      if (ev.aspect_type === 'delete') {
        const still = await stravaGet(acc, `/activities/${activityId}`).catch(() => 'error');
        if (still === null) await admin().from('rides').delete().eq('strava_activity_id', activityId).eq('user_id', acc.user_id);
        return;
      }
      const upd = (ev.updates ?? {}) as Record<string, string>;
      if (ev.aspect_type === 'update' && Object.keys(upd).every((k) => ['title', 'description', 'private', 'type'].includes(k))) {
        if (upd.title) await admin().from('rides').update({ name: upd.title.slice(0, 120) }).eq('strava_activity_id', activityId).eq('user_id', acc.user_id);
        return;
      }
      await processActivity(acc, activityId);
    })());
    return json({ ok: true });
  }

  if (action === 'sync' || action === 'disconnect' || action === 'status') {
    const user = await currentUser(req);
    if (!user) return json({ error: 'Please sign in again' }, 401);
    const acc = await accountFor({ user_id: user.id });
    if (action === 'status') return json({ connected: !!acc, configured });
    if (!acc) return json({ error: 'Strava is not connected' }, 400);
    if (action === 'sync') {
      try { return json({ ok: true, results: await importRecent(acc, 7) }); }
      catch (e) { return json({ error: (e as Error).message }, 502); }
    }
    try {
      await fetch('https://www.strava.com/oauth/deauthorize', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ access_token: await accessToken(acc) }),
      });
    } catch { /* forget locally regardless */ }
    await admin().from('strava_accounts').delete().eq('user_id', user.id);
    return json({ ok: true });
  }

  if (action === 'subscribe') {
    const user = await currentUser(req);
    const { data: prof } = user ? await admin().from('profiles').select('is_admin').eq('id', user.id).single() : { data: null };
    if (!prof?.is_admin) return json({ error: 'Admins only' }, 403);
    if (!configured || !env('STRAVA_VERIFY_TOKEN')) return json({ error: 'Set STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET and STRAVA_VERIFY_TOKEN first' }, 400);
    const r = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env('STRAVA_CLIENT_ID'), client_secret: env('STRAVA_CLIENT_SECRET'),
        callback_url: `${FN_URL}?action=webhook`, verify_token: env('STRAVA_VERIFY_TOKEN') }),
    });
    const body = await r.json().catch(() => null);
    if (r.ok && body?.id) await admin().from('app_config').upsert({ key: 'strava_subscription_id', value: String(body.id) });
    return json({ status: r.status, body }, r.ok ? 200 : 400);
  }

  return json({ error: 'unknown action' }, 400);
});
