// strava — connecting a rider's Strava and receiving their rides.
//   POST ?action=auth_url        (rider JWT)  → { url } to send the rider to Strava's consent screen
//   GET  ?action=callback        (from Strava) → saves tokens, imports the last week, redirects to the app
//   GET  ?action=webhook         (from Strava) → subscription check (hub.challenge)
//   POST ?action=webhook         (from Strava) → new/updated/deleted activity, or rider revoked access
//   POST ?action=sync            (rider JWT)  → re-import the last 7 days now
//   POST ?action=disconnect      (rider JWT)  → revoke at Strava and forget the tokens
//   POST ?action=subscribe       (admin JWT)  → create the Strava webhook subscription (one time)
// Deploy with verify_jwt = false: Strava calls the callback and webhook without a Supabase token.
import { admin, appUrl, CORS, currentUser, env, hmacHex, json, same } from '../_shared/util.ts';
import { processActivity, StravaAccount, stravaGet } from '../_shared/strava.ts';

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

async function importRecent(acc: StravaAccount, days = 7) {
  const after = Math.floor((Date.now() - days * 86_400_000) / 1000);
  const list = (await stravaGet(acc, `/athlete/activities?after=${after}&per_page=30`)) ?? [];
  const out: unknown[] = [];
  for (const a of list) {
    try { out.push({ id: a.id, result: await processActivity(acc, a.id) }); }
    catch (e) { out.push({ id: a.id, error: (e as Error).message }); }
  }
  return out;
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
    const app = await appUrl();
    const back = (q: string) => Response.redirect(`${app}/rider?${q}`, 302);
    if (url.searchParams.get('error')) return back('strava=denied');
    const uid = await readState(url.searchParams.get('state') ?? '');
    if (!uid) return back('strava=expired');
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env('STRAVA_CLIENT_ID'), client_secret: env('STRAVA_CLIENT_SECRET'),
        code: url.searchParams.get('code'), grant_type: 'authorization_code' }),
    });
    const j = await r.json();
    if (!j.access_token || !j.athlete?.id) return back('strava=failed');
    const scope = url.searchParams.get('scope') ?? '';
    // If this Strava account was linked to another Pitik login before, move it here.
    await admin().from('strava_accounts').delete().eq('athlete_id', j.athlete.id).neq('user_id', uid);
    const row = {
      user_id: uid, athlete_id: j.athlete.id,
      athlete_name: [j.athlete.firstname, j.athlete.lastname].filter(Boolean).join(' ').slice(0, 80),
      access_token: j.access_token, refresh_token: j.refresh_token,
      expires_at: new Date(j.expires_at * 1000).toISOString(), scope,
      write_ok: scope.includes('activity:write'),
    };
    const { error } = await admin().from('strava_accounts').upsert(row, { onConflict: 'user_id' });
    if (error) return back('strava=failed');
    later(importRecent(row as StravaAccount));
    return back('strava=connected');
  }

  if (action === 'webhook' && req.method === 'GET') {
    // Subscription validation
    if (url.searchParams.get('hub.verify_token') !== env('STRAVA_VERIFY_TOKEN') || !env('STRAVA_VERIFY_TOKEN')) {
      return json({ error: 'bad verify token' }, 403);
    }
    return json({ 'hub.challenge': url.searchParams.get('hub.challenge') });
  }

  if (action === 'webhook' && req.method === 'POST') {
    // Strava wants a 200 within 2 seconds, so answer first and work in the background.
    let ev: Record<string, unknown> = {};
    try { ev = await req.json(); } catch { return json({ ok: true }); }
    if (env('STRAVA_SUBSCRIPTION_ID') && String(ev.subscription_id) !== env('STRAVA_SUBSCRIPTION_ID')) return json({ ok: true });
    later((async () => {
      const acc = await accountFor({ athlete_id: Number(ev.owner_id) });
      if (!acc) return;
      if (ev.object_type === 'athlete' && (ev.updates as Record<string, string>)?.authorized === 'false') {
        await admin().from('strava_accounts').delete().eq('user_id', acc.user_id);
        return;
      }
      if (ev.object_type !== 'activity') return;
      if (ev.aspect_type === 'delete') {
        await admin().from('rides').delete().eq('strava_activity_id', Number(ev.object_id));
        return;
      }
      // create, or an update that could change the route/time (ignore title-only edits we made ourselves)
      const upd = (ev.updates ?? {}) as Record<string, string>;
      if (ev.aspect_type === 'update' && Object.keys(upd).every((k) => ['title', 'description'].includes(k))) {
        if (upd.title) await admin().from('rides').update({ name: upd.title.slice(0, 120) }).eq('strava_activity_id', Number(ev.object_id));
        return;
      }
      await processActivity(acc, Number(ev.object_id));
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
        body: new URLSearchParams({ access_token: acc.access_token }),
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
    return json({ status: r.status, body: await r.json().catch(() => null) }, r.ok ? 200 : 400);
  }

  return json({ error: 'unknown action' }, 400);
});
