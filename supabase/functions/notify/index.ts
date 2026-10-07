// notify — runs every 15 minutes (pg_cron). For each ride that is ready, sends ONE message:
//   • a line in the Strava activity description (edited, never duplicated)
//   • one email listing every pitikero who caught the rider
// At most one follow-up per ride if more shots land later. No SMS.
// Called with header x-cron-secret (from Vault). Secrets: RESEND_API_KEY, EMAIL_FROM, APP_URL.
import { admin, appUrl, env, json, manilaTime } from '../_shared/util.ts';
import { LINE_MARK, mergeDescription, StravaAccount, stravaGet, stravaPut } from '../_shared/strava.ts';

type Pass = { pitikero: string; passed_at: string; count: number; thumb: string | null };
type Ride = {
  ride_id: string; user_id: string; email: string | null; email_notify: boolean; strava_activity_id: number | null;
  name: string | null; started_at: string; is_followup: boolean; passes: Pass[];
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const joinNames = (n: string[]) => n.length <= 1 ? (n[0] ?? '') : n.slice(0, -1).join(', ') + ' & ' + n[n.length - 1];

function summary(r: Ride) {
  const withShots = r.passes.filter((p) => p.count > 0);
  const names = [...new Set(withShots.map((p) => p.pitikero))];
  const total = withShots.reduce((a, p) => a + p.count, 0);
  return { withShots, names, total };
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!env('RESEND_API_KEY')) return 'skipped: no RESEND_API_KEY';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('EMAIL_FROM', 'Pitik <hello@pitik.ph>'), to: [to], subject, html }),
  });
  return r.ok ? 'sent' : `failed ${r.status}`;
}

function emailHtml(r: Ride, link: string) {
  const { withShots, names, total } = summary(r);
  const pub = `${env('SUPABASE_URL')}/storage/v1/object/public/previews/`;
  const rows = withShots.map((p) => `
    <tr><td style="padding:10px 0;border-top:1px solid #E2DACB">
      ${p.thumb ? `<img src="${pub}${esc(p.thumb)}" width="96" height="72" style="border-radius:8px;object-fit:cover;vertical-align:middle;margin-right:12px" alt="">` : ''}
      <span style="font:600 16px Georgia,serif">${esc(p.pitikero)}</span>
      <span style="color:#4A443B"> caught you at ${manilaTime(p.passed_at)} · ${p.count} photo${p.count > 1 ? 's' : ''}</span>
    </td></tr>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#F4EFE6;font-family:Helvetica,Arial,sans-serif;color:#1F1B16">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 16px">
  <table width="100%" style="max-width:520px;background:#FBF8F2;border-radius:18px;padding:24px" cellpadding="0" cellspacing="0">
    <tr><td style="font:italic 600 28px Georgia,serif">pitik</td></tr>
    <tr><td style="font:500 24px Georgia,serif;padding-top:12px">${r.is_followup ? 'May bagong pitik ka.' : 'Nakuhanan ka kaninang umaga.'}</td></tr>
    <tr><td style="color:#4A443B;padding:6px 0 10px">${total} photo${total > 1 ? 's' : ''} of you from ${esc(joinNames(names))}${r.name ? ` on “${esc(r.name)}”` : ''}. Only you can see them.</td></tr>
    ${rows}
    <tr><td style="padding-top:18px"><a href="${link}" style="display:inline-block;background:#B8441F;color:#fff;text-decoration:none;font-weight:600;padding:14px 22px;border-radius:14px">Tingnan lahat</a></td></tr>
    <tr><td style="color:#6E655A;font-size:12px;padding-top:18px">The pitikero keeps 100% of the photo price and every tip. You got this because your Strava is connected to Pitik. Turn emails off anytime in your Pitik settings.</td></tr>
  </table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  const secret = req.headers.get('x-cron-secret') ?? '';
  const { data: okSecret } = await admin().rpc('check_cron_secret', { p: secret });
  if (!okSecret) return json({ error: 'forbidden' }, 403);

  const app = await appUrl();
  const { data, error } = await admin().rpc('rides_to_notify');
  if (error) return json({ error: error.message }, 500);
  const rides = (data ?? []) as Ride[];
  const results: unknown[] = [];

  for (const r of rides) {
    const { names, total } = summary(r);
    if (!total) continue;
    const link = `${app}/ride/${r.ride_id}`;
    const line = `${LINE_MARK} ${total} photo${total > 1 ? 's' : ''} of you from ${joinNames(names)} → ${link}`;
    const out: Record<string, unknown> = { ride: r.ride_id };

    if (r.strava_activity_id) {
      try {
        const { data: acc } = await admin().from('strava_accounts').select('*').eq('user_id', r.user_id).maybeSingle();
        if (acc && (acc as StravaAccount).write_ok) {
          const a = await stravaGet(acc as StravaAccount, `/activities/${r.strava_activity_id}`);
          if (a) {
            await stravaPut(acc as StravaAccount, `/activities/${r.strava_activity_id}`, { description: mergeDescription(a.description, line) });
            out.strava = 'updated';
          }
        } else out.strava = 'no write permission';
      } catch (e) { out.strava = 'failed: ' + (e as Error).message; }
    }

    if (r.email && r.email_notify) {
      const subject = r.is_followup
        ? 'May bagong pitik ka 📸'
        : `Nakita ka ng ${names.length} pitikero${names.length > 1 ? 's' : ''} kaninang umaga 📸`;
      try { out.email = await sendEmail(r.email, subject, emailHtml(r, link)); }
      catch (e) { out.email = 'failed: ' + (e as Error).message; }
    }

    await admin().rpc('mark_notified', { p_ride: r.ride_id, p_line: line });
    results.push(out);
  }
  return json({ ok: true, count: results.length, results });
});
