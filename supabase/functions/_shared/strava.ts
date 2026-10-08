import { admin, env } from './util.ts';

const API = 'https://www.strava.com/api/v3';

export type StravaAccount = {
  user_id: string; athlete_id: number; access_token: string; refresh_token: string; expires_at: string; write_ok: boolean;
};

/** Returns a valid access token, refreshing and saving it when it is about to expire. */
export async function accessToken(acc: StravaAccount): Promise<string> {
  if (new Date(acc.expires_at).getTime() - Date.now() > 120_000) return acc.access_token;
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env('STRAVA_CLIENT_ID'), client_secret: env('STRAVA_CLIENT_SECRET'),
      grant_type: 'refresh_token', refresh_token: acc.refresh_token,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Strava refresh failed: ' + (j.message ?? r.status));
  await admin().from('strava_accounts').update({
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: new Date(j.expires_at * 1000).toISOString(),
  }).eq('user_id', acc.user_id);
  acc.access_token = j.access_token; acc.refresh_token = j.refresh_token; acc.expires_at = new Date(j.expires_at * 1000).toISOString();
  return j.access_token;
}

export async function stravaGet(acc: StravaAccount, path: string) {
  const t = await accessToken(acc);
  const r = await fetch(API + path, { headers: { Authorization: `Bearer ${t}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Strava ${path} → ${r.status}`);
  return r.json();
}

export async function stravaPut(acc: StravaAccount, path: string, body: unknown) {
  const t = await accessToken(acc);
  const r = await fetch(API + path, {
    method: 'PUT', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Strava PUT ${path} → ${r.status}`);
  return r.json();
}

export const OUTDOOR = /ride|cycl|bike|gravel|mountain|handcycle|velomobile/i;

/** Pull one activity's route and record the moments it passed a pitikero. Keeps only a thinned track, briefly. */
export async function processActivity(acc: StravaAccount, activityId: number, summary?: Record<string, any>) {
  const a = summary ?? await stravaGet(acc, `/activities/${activityId}`);
  if (!a) return { skipped: 'not found' };
  const type = String(a.sport_type ?? a.type ?? '');
  if (a.trainer || /virtual/i.test(type) || !OUTDOOR.test(type)) return { skipped: 'not an outdoor ride' };
  const streams = await stravaGet(acc, `/activities/${activityId}/streams?keys=latlng,time&key_by_type=true`);
  const ll: [number, number][] = streams?.latlng?.data ?? [];
  const tt: number[] = streams?.time?.data ?? [];
  if (!ll.length || ll.length !== tt.length) return { skipped: 'no GPS' };
  const start = Date.parse(a.start_date);
  const track = ll.map(([lat, lon], i) => ({ t: new Date(start + tt[i] * 1000).toISOString(), lat, lon }));
  const end = new Date(start + (tt[tt.length - 1] ?? 0) * 1000).toISOString();
  const { data, error } = await admin().rpc('ingest_ride', {
    p_user: acc.user_id, p_source: 'strava', p_activity: activityId, p_name: a.name ?? 'Ride',
    p_start: new Date(start).toISOString(), p_end: end, p_track: track,
  });
  if (error) throw new Error(error.message);
  return data;
}

export const LINE_MARK = '📸 Pitik:';

/** Add or replace our one line in the activity description, leaving the rider's own text alone. */
export function mergeDescription(current: string | null | undefined, line: string): string {
  const lines = String(current ?? '').split('\n').filter((l) => !l.trim().startsWith(LINE_MARK));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return (lines.length ? lines.join('\n') + '\n\n' : '') + line;
}
