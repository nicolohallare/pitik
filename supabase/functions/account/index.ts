// account — mobile number + 6-digit PIN sign-up, and PIN reset by an admin. No email, no SMS.
//   POST ?action=signup     { phone, pin }          → creates the login; the app then signs in with the PIN
//   POST ?action=reset_pin  { phone, pin }  (admin) → sets a new PIN for that number
import { admin, asUser, CORS, json } from '../_shared/util.ts';

export const DOMAIN = 'm.pitik.invalid';
const normPhone = (s: unknown) => {
  const d = String(s ?? '').replace(/\D/g, '');
  return /^(63|0)?9\d{9}$/.test(d) ? '0' + d.slice(-10) : null;
};
const WEAK = new Set(['000000', '111111', '222222', '333333', '444444', '555555', '666666', '777777', '888888', '999999', '123456', '654321', '121212', '123123']);
const pinOk = (p: unknown) => typeof p === 'string' && /^\d{6}$/.test(p) && !WEAK.has(p);
// Must match web/src/lib/phone.ts
const secret = (pin: string) => `pitik-${pin}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const action = new URL(req.url).searchParams.get('action');
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }

  const phone = normPhone(body.phone);
  if (!phone) return json({ error: 'Enter your 11-digit mobile number, like 0917 123 4567.' }, 400);
  if (!pinOk(body.pin)) return json({ error: 'Choose a 6-digit PIN that is not too easy to guess (not 123456 or the same number six times).' }, 400);
  const pin = body.pin as string;
  const email = `${phone}@${DOMAIN}`;

  if (action === 'signup') {
    const { error } = await admin().auth.admin.createUser({ email, password: secret(pin), email_confirm: true, user_metadata: { phone } });
    if (error) {
      if (/already|registered|exists/i.test(error.message)) return json({ error: 'That number already has a Pitik account. Sign in with your PIN instead.' }, 409);
      return json({ error: 'Could not create the account. Try again in a minute.', detail: error.message }, 500);
    }
    return json({ ok: true });
  }

  if (action === 'reset_pin') {
    const { data: isAdmin } = await asUser(req).rpc('is_admin');
    if (!isAdmin) return json({ error: 'Admins only' }, 403);
    const { data: prof } = await admin().from('profiles').select('id').eq('phone', phone).maybeSingle();
    if (!prof) return json({ error: 'No Pitik account with that number.' }, 404);
    const { error } = await admin().auth.admin.updateUserById(prof.id as string, { password: secret(pin) });
    if (error) return json({ error: 'Could not change the PIN. Try again.' }, 500);
    return json({ ok: true });
  }

  return json({ error: 'Unknown action' }, 400);
});
