// techpay — paying for an order through TechPay's hosted checkout (pattern from the techpay-gateway skill).
//   POST ?action=start    (rider JWT) { order_id } → { pay_url }
//   POST ?action=webhook  (from TechPay)           → verify by calling TechPay back, then settle once
// Deploy with verify_jwt = false. Secrets: TECHPAY_HOST, TECHPAY_USER, TECHPAY_PASS, TECHPAY_SIGNATURE_KEY, APP_URL.
import { admin, appUrl, CORS, currentUser, env, hmacHex, json } from '../_shared/util.ts';

const HOST = env('TECHPAY_HOST', 'api-stg.techpay.com.ph');
const FN_URL = `${env('SUPABASE_URL')}/functions/v1/techpay`;
const REF_PREFIX = 'PTK';

async function token(): Promise<string> {
  const r = await fetch(`https://${HOST}/v1/biller/token/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: env('TECHPAY_USER'), password: env('TECHPAY_PASS') }),
  });
  const j = await r.json().catch(() => ({}));
  const t = j?.data?.token;
  if (!t) throw new Error(`Payment gateway rejected our credentials: ${j?.message ?? r.status}`);
  return t;
}

async function lookUp(reference: string) {
  const t = await token();
  const r = await fetch(`https://${HOST}/v1/biller/transactions?reference_no=${encodeURIComponent(reference)}&per_page=5`,
    { headers: { Authorization: `Bearer ${t}` } });
  const j = await r.json().catch(() => ({}));
  const list = j?.data?.transactions;
  if (!Array.isArray(list)) return null;
  return list.find((x: Record<string, unknown>) => x.reference_no === reference) ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get('action');

  if (action === 'start') {
    try {
      if (!env('TECHPAY_USER')) return json({ error: 'Online payment is not set up yet.' }, 503);
      const user = await currentUser(req);
      if (!user) return json({ error: 'Please sign in again' }, 401);
      const { order_id } = await req.json();
      // The database makes the reference and records the attempt (the browser never chooses either)
      const { data: started, error } = await admin().rpc('start_order_payment', { p_user: user.id, p_order: order_id });
      if (error) return json({ error: error.message }, 400);
      const reference = String((started as { reference: string }).reference);
      const amount = Number((started as { amount: number }).amount);
      const app = await appUrl();
      const t = await token();
      const r = await fetch(`https://${HOST}/v1/biller/links/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
        body: JSON.stringify({   // no `items` field: TechPay requires 2+ items if present
          amount, reference_no: reference,
          success_redirect_url: `${app}/order/${order_id}?pay=done`,
          failure_redirect_url: `${app}/order/${order_id}?pay=failed`,
          callback_webhook_url: `${FN_URL}?action=webhook`,
        }),
      });
      const j = await r.json().catch(() => ({}));
      const payUrl = j?.data?.web_payment_url ?? j?.data?.link_url;
      if (!payUrl) {
        await admin().from('payment_attempts').update({ status: 'failed' }).eq('reference', reference);
        await admin().from('orders').update({ admin_note: `Gateway would not create payment ${reference}: ${JSON.stringify(j?.errors ?? j?.message ?? r.status).slice(0, 300)}` })
          .eq('id', order_id);
        return json({ error: j?.message || 'The payment page would not open. Please try again.' }, 502);
      }
      await admin().from('orders').update({ is_test: HOST.includes('stg') }).eq('id', order_id);
      return json({ ok: true, reference, pay_url: payUrl, expires_at: j?.data?.link_expires_at ?? null });
    } catch (e) { return json({ error: (e as Error).message }, 500); }
  }

  if (action === 'webhook') {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* handled below */ }
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim();
    const data = (body?.data ?? {}) as Record<string, unknown>;
    const reference = String(data.reference_no ?? '');
    const claimed = String(data.status ?? '');
    const received = String(data.signature ?? '').toLowerCase();
    const expected = reference && env('TECHPAY_SIGNATURE_KEY') ? await hmacHex(env('TECHPAY_SIGNATURE_KEY'), `${String(data.amount)}@${reference}`) : '';
    const note = async (outcome: string, ok: boolean) => {
      try {
        await admin().rpc('log_gateway_webhook', { p_ip: ip || null, p_reference: reference || null,
          p_amount: Number(data.amount) || null, p_status: claimed || null, p_sig_recv: received || null,
          p_sig_exp: expected || null, p_ok: ok, p_outcome: outcome, p_payload: body });
      } catch { /* logging must never break the response */ }
    };
    if (!reference) { await note('ignored: no reference', false); return json({ error: 'bad payload' }, 400); }
    if (!reference.startsWith(REF_PREFIX)) { await note('ignored: not a Pitik reference', false); return json({ ok: true }); }
    let real: Record<string, unknown> | null = null;
    try { real = await lookUp(reference); }
    catch (e) { await note(`could not verify: ${(e as Error).message}`, false); return json({ error: 'retry' }, 500); }
    if (!real) { await note('REJECTED: TechPay has no such transaction', false); return json({ error: 'unknown transaction' }, 404); }
    const trueStatus = String(real.status ?? '');
    const trueAmount = Number(real.subtotal_amount ?? real.total_amount ?? 0);
    const { data: result, error } = await admin().rpc('settle_gateway_payment', {
      p_reference: reference, p_amount: trueAmount, p_status: trueStatus,
      p_fee: Number(real.service_fee ?? 0) || null, p_payload: { webhook: body, verified: real } });
    if (error) { await note(`database error: ${error.message}`, true); return json({ error: 'retry' }, 500); }
    await note(`verified: ${trueStatus} ₱${trueAmount}: ${JSON.stringify(result)}` +
      (claimed && claimed !== trueStatus ? ` (webhook claimed '${claimed}')` : ''), received === expected);
    return json({ ok: true });
  }

  return json({ error: 'unknown action' }, 400);
});
