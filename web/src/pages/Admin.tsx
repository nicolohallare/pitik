import { useCallback, useEffect, useState } from 'react';
import { Layout, Msg, Seg } from '../components/ui';
import { useAuth } from '../lib/auth';
import { callFn, errText, supabase } from '../lib/supabase';
import { day, peso, time } from '../lib/format';
import type { AllowanceDay } from '../components/Allowance';

type Bal = { id: string; name: string; handle: string; gcash_number: string | null; gcash_name: string | null; founding: boolean; status: string; photos: number;
  unpaid: number; unpaid_sales: number; unpaid_tips: number; unpaid_extras: number; last_paid_at: string | null };

export default function Admin() {
  const { profile } = useAuth();
  const [tab, setTab] = useState<'payouts' | 'extras' | 'orders' | 'feedback'>('payouts');
  if (!profile?.is_admin) return <Layout><h1>Admins only</h1></Layout>;
  return (
    <Layout wide>
      <h1>Admin</h1>
      <Seg label="Section" value={tab} onChange={setTab} options={[
        { v: 'payouts', label: 'Payouts' }, { v: 'extras', label: 'Extras & credits' }, { v: 'orders', label: 'Orders' }, { v: 'feedback', label: 'Feedback' }]} />
      {tab === 'payouts' && <Payouts />}
      {tab === 'extras' && <Extras />}
      {tab === 'orders' && <Orders />}
      {tab === 'feedback' && <FeedbackList />}
      {tab === 'orders' && <Setup />}
    </Layout>
  );
}

function useBalances() {
  const [rows, setRows] = useState<Bal[] | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('admin_balances');
    if (error) setErr(errText(error)); else setRows(data as Bal[]);
  }, []);
  useEffect(() => { load(); }, [load]);
  return { rows, err, load };
}

function Payouts() {
  const { rows, err, load } = useBalances();
  const [open, setOpen] = useState<string | null>(null);
  async function setStatus(id: string, status: string | null, founding: boolean | null) {
    await supabase.rpc('admin_set_pitikero', { p_pitikero: id, p_status: status, p_founding: founding });
    load();
  }
  if (!rows) return <><p className="note">Loading…</p><Msg text={err} kind="err" /></>;
  const due = rows.filter((r) => Number(r.unpaid) >= 200);
  return (
    <>
      <section className="card flat">
        <div className="between"><h3>Due this Monday</h3><b className="num">{peso(due.reduce((a, r) => a + Number(r.unpaid), 0))}</b></div>
        <p className="note">Everyone with ₱200 or more unpaid. Send by GCash, then record the ref and screenshot here. The pitikero sees it on their Bayad page.</p>
      </section>
      <div className="scroll-x">
        <table className="t">
          <thead><tr><th>Pitikero</th><th>GCash</th><th>Sales</th><th>Tips</th><th>Extras</th><th>Unpaid</th><th>Last paid</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><b>{r.name}</b>{r.founding ? ' ★' : ''}<div className="note">@{r.handle} · {r.photos} shots</div>
                  <div className="row" style={{ gap: 4, marginTop: 4 }}>
                    {r.status !== 'active'
                      ? <button className="btn green small inline" onClick={() => setStatus(r.id, 'active', null)}>{r.status === 'pending' ? 'Activate' : 'Resume'}</button>
                      : <button className="link" onClick={() => setStatus(r.id, 'paused', null)}>Pause</button>}
                    <button className="link" onClick={() => setStatus(r.id, null, !r.founding)}>{r.founding ? 'Unmark founding' : 'Mark founding'}</button>
                  </div></td>
                <td className="num">{r.gcash_number}<div className="note">{r.gcash_name}</div></td>
                <td className="num">{peso(r.unpaid_sales)}</td>
                <td className="num">{peso(r.unpaid_tips)}</td>
                <td className="num">{peso(r.unpaid_extras)}</td>
                <td className="num"><b>{peso(r.unpaid)}</b></td>
                <td>{r.last_paid_at ? day(r.last_paid_at) : '—'}</td>
                <td>{Number(r.unpaid) > 0 && <button className="btn small inline" onClick={() => setOpen(r.id)}>Mark paid</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <PayForm bal={rows.find((r) => r.id === open)!} onClose={() => { setOpen(null); load(); }} />}
    </>
  );
}

function PayForm({ bal, onClose }: { bal: Bal; onClose: () => void }) {
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function save() {
    setErr(''); setBusy(true);
    try {
      let path = '';
      if (file) {
        path = `${bal.id}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '')}`;
        const { error } = await supabase.storage.from('receipts').upload(path, file, { contentType: file.type });
        if (error) throw error;
      }
      const { error } = await supabase.rpc('admin_record_payout', { p_pitikero: bal.id, p_amount: Number(bal.unpaid), p_ref: ref, p_receipt: path, p_note: note });
      if (error) throw error;
      onClose();
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }
  return (
    <section className="card">
      <h2>Pay {bal.name} {peso(bal.unpaid)}</h2>
      <p className="note">Send {peso(bal.unpaid)} to GCash {bal.gcash_number} ({bal.gcash_name}), then record it here.</p>
      <div className="row">
        <div className="field"><label htmlFor="ref">GCash reference no.</label><input id="ref" value={ref} onChange={(e) => setRef(e.target.value)} /></div>
        <div className="field"><label htmlFor="nt">Note (optional)</label><input id="nt" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Week of Oct 5" /></div>
      </div>
      <div className="pick"><div className="btn alt small" aria-hidden="true">{file ? file.name : 'Attach GCash receipt screenshot'}</div>
        <input type="file" accept="image/*,application/pdf" aria-label="Attach receipt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
      <div className="row">
        <button className="btn green" style={{ flex: 1 }} disabled={busy || !ref} onClick={save}>{busy ? 'Saving…' : 'Record payout'}</button>
        <button className="btn alt" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
      </div>
      <Msg text={err} kind="err" />
    </section>
  );
}

function Extras() {
  const { rows, load } = useBalances();
  const [pk, setPk] = useState('');
  const [kind, setKind] = useState<'allowance' | 'referral' | 'adjustment'>('allowance');
  const [amt, setAmt] = useState('300');
  const [note, setNote] = useState('');
  const [email, setEmail] = useState('');
  const [camt, setCamt] = useState('100');
  const [creason, setCreason] = useState('Trial rider credit');
  const [msg, setMsg] = useState<{ t: string; k?: 'ok' | 'err' } | null>(null);

  async function addExtra() {
    const { error } = await supabase.rpc('admin_add_extra', { p_pitikero: pk, p_kind: kind, p_amount: Number(amt), p_note: note });
    setMsg(error ? { t: errText(error), k: 'err' } : { t: 'Added. It is included in their next payout.', k: 'ok' });
    if (!error) { setNote(''); load(); }
  }
  async function addCredit() {
    const { error } = await supabase.rpc('admin_give_credit', { p_email: email, p_amount: Number(camt), p_reason: creason });
    setMsg(error ? { t: errText(error), k: 'err' } : { t: `Credit given to ${email}.`, k: 'ok' });
  }
  return (
    <>
      <section className="card">
        <h2>Add to a pitikero's payout</h2>
        <p className="note">Trial allowance (₱300 per trial Sunday), referral bonus (₱200 per new pitikero who uploads 4 weeks), or an adjustment.</p>
        <div className="row">
          <div className="field"><label htmlFor="xp">Pitikero</label>
            <select id="xp" value={pk} onChange={(e) => setPk(e.target.value)}><option value="">Choose…</option>{(rows ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
          <div className="field"><label htmlFor="xk">Kind</label>
            <select id="xk" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="allowance">Trial allowance</option><option value="referral">Referral bonus</option><option value="adjustment">Adjustment</option></select></div>
          <div className="field"><label htmlFor="xa">Amount</label><input id="xa" type="number" value={amt} onChange={(e) => setAmt(e.target.value)} /></div>
        </div>
        <div className="field"><label htmlFor="xn">Note</label><input id="xn" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Trial Sunday, Oct 12" /></div>
        <button className="btn" disabled={!pk || !Number(amt)} onClick={addExtra}>Add</button>
      </section>
      <section className="card">
        <h2>Give a rider credit</h2>
        <p className="note">Every new rider already gets the founding credit automatically. Use this for extras. The rider must have signed in once.</p>
        <div className="row">
          <div className="field"><label htmlFor="ce">Rider email or mobile number</label><input id="ce" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><label htmlFor="ca">Amount</label><input id="ca" type="number" value={camt} onChange={(e) => setCamt(e.target.value)} /></div>
        </div>
        <div className="field"><label htmlFor="cr">Reason</label><input id="cr" value={creason} onChange={(e) => setCreason(e.target.value)} /></div>
        <button className="btn" disabled={!email || !Number(camt)} onClick={addCredit}>Give credit</button>
      </section>
      <TrialDays />
      <ResetPin />
      {msg && <Msg text={msg.t} kind={msg.k} />}
    </>
  );
}

function TrialDays() {
  const [data, setData] = useState<{ days: string; day: string | null; rows: (AllowanceDay & { name: string })[] } | null>(null);
  const [days, setDays] = useState('');
  const [msg, setMsg] = useState<{ t: string; k?: 'ok' | 'err' } | null>(null);
  const load = useCallback(async (d?: string) => {
    const { data: r, error } = await supabase.rpc('admin_allowances', { p_day: d ?? null });
    if (error) return setMsg({ t: errText(error), k: 'err' });
    setData(r as typeof data); setDays((r as { days: string }).days.replaceAll(',', ', '));
  }, []);
  useEffect(() => { load(); }, [load]);
  async function save() {
    const { error } = await supabase.rpc('admin_set_trial_days', { p_days: days });
    setMsg(error ? { t: errText(error), k: 'err' } : { t: 'Saved. Pitikeros see the checklist on their Ngayon tab.', k: 'ok' });
    load();
  }
  async function award() {
    const { data: n, error } = await supabase.rpc('award_allowances');
    setMsg(error ? { t: errText(error), k: 'err' } : { t: n ? `${n} allowance(s) added to payouts.` : 'Nobody new qualified yet.', k: 'ok' });
    load(data?.day ?? undefined);
  }
  const list = (data?.days ?? '').split(',').filter(Boolean);
  return (
    <section className="card">
      <h2>Trial Sundays</h2>
      <p className="note">Pitikeros earn the allowance automatically when they check in at Taktak with GPS (4–11am) and upload enough morning shots by noon the next day. It is checked every hour and lands in their payout. Reverse one with a negative adjustment if something looks off.</p>
      <div className="field"><label htmlFor="td">Trial days (YYYY-MM-DD, comma between)</label><input id="td" value={days} onChange={(e) => setDays(e.target.value)} placeholder="2026-10-11, 2026-10-18" /></div>
      <button className="btn small" onClick={save}>Save trial days</button>
      {list.length > 0 && (
        <>
          <div className="row">{list.map((d) => <button key={d} className="btn alt small" style={{ flex: '0 0 auto' }} aria-pressed={d === data?.day} onClick={() => load(d)}>{d}</button>)}</div>
          <div className="stack">
            {(data?.rows ?? []).map((r) => (
              <div key={r.name} className="between" style={{ borderTop: '1px solid var(--line)', paddingTop: 8 }}>
                <span><b>{r.name}</b> <span className="note">{r.photos}/{r.min_photos} shots{r.checked_in ? (r.at_taktak ? ' · at Taktak' : ' · NOT at Taktak') : ' · no check-in'}{r.active ? '' : ' · not active'}</span></span>
                <span className={'badge' + (r.awarded ? ' live' : '')}>{r.awarded ? 'Paid' : r.qualifies ? 'Earned' : 'Not yet'}</span>
              </div>
            ))}
          </div>
          <button className="btn alt small" onClick={award}>Check now and add earned allowances</button>
        </>
      )}
      {msg && <Msg text={msg.t} kind={msg.k} />}
    </section>
  );
}

function ResetPin() {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<{ t: string; k?: 'ok' | 'err' } | null>(null);
  async function reset() {
    setMsg(null);
    try { await callFn('account', 'reset_pin', { phone, pin }); setMsg({ t: `New PIN set. Tell them to sign in with ${pin}.`, k: 'ok' }); setPin(''); }
    catch (e) { setMsg({ t: errText(e), k: 'err' }); }
  }
  return (
    <section className="card">
      <h2>Reset a PIN</h2>
      <p className="note">For someone who forgot their PIN. Check it's really them first (message them on Messenger or the GC), then send them the new PIN.</p>
      <div className="row">
        <div className="field"><label htmlFor="rp">Mobile number</label><input id="rp" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
        <div className="field"><label htmlFor="rn">New 6-digit PIN</label><input id="rn" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} /></div>
      </div>
      <button className="btn" disabled={!phone || pin.length !== 6} onClick={reset}>Set new PIN</button>
      {msg && <Msg text={msg.t} kind={msg.k} />}
    </section>
  );
}

type Overview = {
  pitikeros: number; riders: number; strava: number; photos: number; orders_paid: number; gmv: number; pitik_fees: number; credits_used: number;
  review: { id: string; ref: string; total: number; note: string }[];
  recent_orders: { id: string; status: string; total: number; photos_amount: number; tips_amount: number; fee_amount: number; credit_amount: number; gateway_ref: string | null; created_at: string; email: string }[];
  webhooks: { received_at: string; reference: string; status: string; signature_ok: boolean; outcome: string }[];
};
function Orders() {
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { supabase.rpc('admin_overview').then(({ data, error }) => error ? setErr(errText(error)) : setO(data as Overview)); }, []);
  if (!o) return <><p className="note">Loading…</p><Msg text={err} kind="err" /></>;
  const stat = (label: string, v: string | number) => <div className="card flat" style={{ flex: '1 1 140px' }}><span className="note">{label}</span><b className="num" style={{ fontSize: 22 }}>{v}</b></div>;
  return (
    <>
      <div className="row">
        {stat('Pitikeros', o.pitikeros)}{stat('Accounts', o.riders)}{stat('Strava linked', o.strava)}{stat('Photos', o.photos.toLocaleString())}
        {stat('Paid orders', o.orders_paid)}{stat('To pitikeros', peso(o.gmv))}{stat('Pitik fees', peso(o.pitik_fees))}{stat('Credits used', peso(o.credits_used))}
      </div>
      {o.review.length > 0 && <section className="card"><h3>Held for review</h3>{o.review.map((r) => <p key={r.id} className="msg err">{r.ref}: {peso(r.total)} · {r.note}</p>)}</section>}
      <section className="card"><h3>Recent orders</h3>
        <div className="scroll-x"><table className="t">
          <thead><tr><th>When</th><th>Rider</th><th>Status</th><th>Photos</th><th>Tips</th><th>Fee</th><th>Credit</th><th>Paid</th><th>Ref</th></tr></thead>
          <tbody>{o.recent_orders.map((r) => (
            <tr key={r.id}><td>{day(r.created_at)} {time(r.created_at)}</td><td>{r.email}</td><td>{r.status}</td>
              <td className="num">{peso(r.photos_amount)}</td><td className="num">{peso(r.tips_amount)}</td><td className="num">{peso(r.fee_amount)}</td>
              <td className="num">{peso(r.credit_amount)}</td><td className="num">{peso(r.total)}</td><td className="note">{r.gateway_ref}</td></tr>))}
          </tbody></table></div>
      </section>
      <section className="card"><h3>Payment webhooks</h3>
        <div className="scroll-x"><table className="t">
          <thead><tr><th>When</th><th>Ref</th><th>Status</th><th>Sig</th><th>Outcome</th></tr></thead>
          <tbody>{o.webhooks.map((w, i) => <tr key={i}><td>{day(w.received_at)} {time(w.received_at)}</td><td>{w.reference}</td><td>{w.status}</td><td>{w.signature_ok ? '✓' : '✗'}</td><td className="note">{w.outcome}</td></tr>)}</tbody>
        </table></div>
      </section>
    </>
  );
}

type Fb = { id: number; created_at: string; name: string | null; role: string | null; would_use: string | null; checkin_easy: number | null; price_ok: string | null; liked: string | null; confusing: string | null; missing: string | null; contact: string | null };
function FeedbackList() {
  const [rows, setRows] = useState<Fb[] | null>(null);
  useEffect(() => { supabase.from('feedback').select('*').order('created_at', { ascending: false }).limit(200).then(({ data }) => setRows((data ?? []) as Fb[])); }, []);
  if (!rows) return <p className="note">Loading…</p>;
  if (!rows.length) return <p className="note">No feedback yet.</p>;
  return (
    <div className="stack">
      {rows.map((f) => (
        <section key={f.id} className="card flat">
          <div className="between"><b>{f.name || 'Anonymous'}{f.role ? ` · ${f.role}` : ''}</b><span className="note">{day(f.created_at)}</span></div>
          <div className="row">{f.would_use && <span className="badge">Would use: {f.would_use}</span>}{f.checkin_easy && <span className="badge">Check-in: {f.checkin_easy}/5</span>}{f.price_ok && <span className="badge">Price: {f.price_ok}</span>}</div>
          {f.liked && <p style={{ margin: 0 }}><b>Liked:</b> {f.liked}</p>}
          {f.confusing && <p style={{ margin: 0 }}><b>Confusing:</b> {f.confusing}</p>}
          {f.missing && <p style={{ margin: 0 }}><b>Missing:</b> {f.missing}</p>}
          {f.contact && <p className="note">Contact: {f.contact}</p>}
        </section>
      ))}
    </div>
  );
}

function Setup() {
  const [out, setOut] = useState('');
  return (
    <section className="card flat">
      <h3>One-time setup</h3>
      <p className="note">After the Strava keys are saved as function secrets, press this once so Strava starts sending new rides to Pitik.</p>
      <button className="btn alt small inline" onClick={async () => {
        try { setOut(JSON.stringify(await callFn('strava', 'subscribe'))); } catch (e) { setOut(errText(e)); }
      }}>Turn on the Strava ride feed</button>
      {out && <pre className="note" style={{ whiteSpace: 'pre-wrap' }}>{out}</pre>}
    </section>
  );
}
