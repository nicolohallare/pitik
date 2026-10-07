import { useCallback, useEffect, useState } from 'react';
import { Layout, Msg, Seg } from '../components/ui';
import { ClockCheck, type Shoot } from '../components/ClockCheck';
import { Upload } from '../components/Upload';
import { useAuth, type Pitikero as PK } from '../lib/auth';
import { errText, publicUrl, supabase } from '../lib/supabase';
import { day, isTodayManila, peso, plural, time } from '../lib/format';

export default function Pitikero() {
  const { pitikero, ready } = useAuth();
  const [tab, setTab] = useState<'today' | 'kita' | 'bayad' | 'profile'>('today');
  if (!ready) return <Layout><p className="note">Loading…</p></Layout>;
  if (!pitikero) return <Layout><Onboard /></Layout>;
  return (
    <Layout>
      <div className="between">
        <div><span className="who">ang pitikero</span><h1>{pitikero.name}</h1></div>
        {pitikero.founding && <span className="badge sun">Founding pitikero</span>}
      </div>
      <Seg label="Section" value={tab} onChange={setTab} options={[
        { v: 'today', label: 'Ngayon' }, { v: 'kita', label: 'Kita' }, { v: 'bayad', label: 'Bayad' }, { v: 'profile', label: 'Profile' }]} />
      {tab === 'today' && <Today pk={pitikero} />}
      {tab === 'kita' && <Kita />}
      {tab === 'bayad' && <Bayad />}
      {tab === 'profile' && <ProfileForm pk={pitikero} />}
    </Layout>
  );
}

// ------------------------------------------------------------------ onboarding
function Onboard() {
  const { session, refresh } = useAuth();
  const [f, setF] = useState({ name: '', handle: '', price: '50', gcash_number: '', gcash_name: '', fb_page: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    const handle = (f.handle || f.name).toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 30);
    const gnum = f.gcash_number.replace(/\D/g, '').replace(/^63/, '0');
    if (handle.length < 2) return setErr('Pick a handle with at least 2 letters or numbers.');
    if (!/^09\d{9}$/.test(gnum)) return setErr('GCash number should look like 09171234567.');
    setBusy(true);
    const { error } = await supabase.from('pitikeros').insert({
      id: session!.user.id, name: f.name.trim(), handle, price: Number(f.price) || 50,
      gcash_number: gnum, gcash_name: f.gcash_name.trim(), fb_page: f.fb_page.trim() || null,
    });
    setBusy(false);
    if (error) return setErr(/duplicate|unique/i.test(error.message) ? 'That handle is taken. Try another.' : errText(error));
    await refresh();
  }
  return (
    <form className="card" onSubmit={save}>
      <span className="who">pitikero ka?</span>
      <h1>Sumali sa Pitik</h1>
      <p className="lead">Sa'yo ang buong presyo mo at lahat ng tips. Bayad sa GCash tuwing Lunes.</p>
      <div className="field"><label htmlFor="n">Pangalan na makikita ng riders</label><input id="n" required maxLength={40} value={f.name} onChange={set('name')} placeholder="Jun Shots" /></div>
      <div className="field"><label htmlFor="h">Handle (for your Pitik link)</label><input id="h" maxLength={30} value={f.handle} onChange={set('handle')} placeholder="junshots" autoCapitalize="none" /></div>
      <div className="row">
        <div className="field"><label htmlFor="p">Presyo bawat photo (₱50 pataas)</label><input id="p" type="number" inputMode="numeric" min={50} max={1000} value={f.price} onChange={set('price')} /></div>
      </div>
      <div className="row">
        <div className="field"><label htmlFor="g">GCash number</label><input id="g" inputMode="tel" required value={f.gcash_number} onChange={set('gcash_number')} placeholder="09171234567" /></div>
        <div className="field"><label htmlFor="gn">Pangalan sa GCash</label><input id="gn" required maxLength={80} value={f.gcash_name} onChange={set('gcash_name')} /></div>
      </div>
      <div className="field"><label htmlFor="fb">FB page (optional)</label><input id="fb" maxLength={120} value={f.fb_page} onChange={set('fb_page')} /></div>
      <p className="note">Your GCash details are only seen by you and the Pitik team, for your weekly payout.</p>
      <button className="btn sun" disabled={busy}>{busy ? 'Saving…' : 'Sumali'}</button>
      <Msg text={err} kind="err" />
    </form>
  );
}

// ------------------------------------------------------------------ today: check-in, clock, upload
function Today({ pk }: { pk: PK }) {
  const [shoots, setShoots] = useState<Shoot[]>([]);
  const [sel, setSel] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('shoots').select('*').eq('pitikero_id', pk.id).order('checked_in_at', { ascending: false }).limit(20);
    if (error) setErr(errText(error));
    const list = (data ?? []) as Shoot[];
    setShoots(list);
    setSel((s) => s && list.some((x) => x.id === s) ? s : (list.find((x) => isTodayManila(x.checked_in_at))?.id ?? ''));
    setLoading(false);
  }, [pk.id]);
  useEffect(() => { load(); }, [load]);

  const shoot = shoots.find((s) => s.id === sel) ?? null;
  if (loading) return <p className="note">Loading…</p>;

  return (
    <>
      {!shoot && <CheckIn pk={pk} onDone={(id) => { setSel(id); load(); }} lastOffset={shoots.find((s) => s.clock_checked)} />}
      {shoot && (
        <section className="card">
          <div className="between">
            <div>
              <span className="badge live">Nandito · {day(shoot.checked_in_at)}, {time(shoot.checked_in_at)}</span>
              <h2 style={{ marginTop: 8 }}>{shoot.place_label || 'Your spot'}</h2>
            </div>
            <a className="link" href={`https://maps.google.com/?q=${shoot.lat},${shoot.lon}`} target="_blank" rel="noreferrer">Map</a>
          </div>
          <p className="note">Pinned {shoot.pin_source === 'phone' ? 'from your phone' : shoot.pin_source === 'map' ? 'from a map pin' : "from your photos' GPS"}{shoot.accuracy_m ? `, within ${Math.round(shoot.accuracy_m)} m` : ''}.</p>
          <ClockCheck shoot={shoot} onChange={load} />
          <Upload shoot={shoot} uid={pk.id} label={pk.name} onUploaded={load} />
          <Recent shootId={shoot.id} count={shoot.photo_count} />
          <Done shoot={shoot} onDone={load} />
          <button className="link" onClick={() => setSel('')}>Bagong check-in (ibang spot o ibang araw)</button>
        </section>
      )}
      <Msg text={err} kind="err" />
      {shoots.length > 0 && (
        <section className="card flat">
          <h3>Your shoots</h3>
          <div className="stack">
            {shoots.map((s) => (
              <button key={s.id} className="btn alt small" style={{ justifyContent: 'space-between' }} aria-pressed={s.id === sel} onClick={() => setSel(s.id)}>
                <span>{day(s.checked_in_at)} · {s.place_label || 'Spot'}</span>
                <span className="note">{plural(s.photo_count, 'shot')}{s.done_at ? ' · tapos' : ''}</span>
              </button>
            ))}
          </div>
          <p className="note">Uploading at home tonight? Pick the shoot from this morning, then load the shots.</p>
        </section>
      )}
    </>
  );
}

function CheckIn({ pk, onDone, lastOffset }: { pk: PK; onDone: (id: string) => void; lastOffset?: Shoot }) {
  const [label, setLabel] = useState('');
  const [pin, setPin] = useState('');
  const [status, setStatus] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [when, setWhen] = useState('');

  async function create(lat: number, lon: number, acc: number | null, source: 'phone' | 'map', at?: string) {
    // Reuse the last clock check (cameras drift slowly) unless it's old
    let off = 0;
    if (lastOffset && Date.now() - Date.parse(lastOffset.checked_in_at) < 30 * 86400e3) off = lastOffset.clock_offset_ms;
    const { data, error } = await supabase.from('shoots').insert({
      pitikero_id: pk.id, lat, lon, accuracy_m: acc, pin_source: source, place_label: label.trim() || null,
      clock_offset_ms: off, ...(at ? { checked_in_at: at } : {}),
    }).select('id').single();
    setBusy(false);
    if (error) { setErr(errText(error)); return; }
    onDone((data as { id: string }).id);
  }

  function gps() {
    setErr(''); setStatus('Getting your exact spot…'); setBusy(true);
    if (!navigator.geolocation) { setBusy(false); setStatus(''); setErr('This browser cannot read location. Paste a Google Maps pin below.'); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setStatus(''); create(p.coords.latitude, p.coords.longitude, p.coords.accuracy, 'phone'); },
      (e) => { setBusy(false); setStatus(''); setErr(e.code === 1 ? 'Location is blocked. Allow location for this site in your browser settings, or paste a Google Maps pin below.' : 'Could not get a GPS fix. Step out from under trees and try again, or paste a pin.'); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }
  function fromPin() {
    const m = pin.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
    if (!m) { setErr('Paste the numbers from Google Maps, like 14.59472, 121.16750'); return; }
    setBusy(true);
    create(Number(m[1]), Number(m[2]), null, 'map', forgot && when ? new Date(when).toISOString() : undefined);
  }

  return (
    <section className="card">
      <span className="who">pagdating sa spot</span>
      <h2>Nandito ako</h2>
      <p className="lead" style={{ marginTop: 0 }}>Tap this where you're standing. Your phone pins the exact spot, so riders who pass you get matched.</p>
      <div className="field"><label htmlFor="pl">Spot name (optional)</label><input id="pl" maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Taktak, pababa bago ang kanto" /></div>
      <button className="btn green" disabled={busy} onClick={gps}>{busy && status ? status : 'Nandito ako · pin my exact spot'}</button>
      <details>
        <summary className="note" style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>Walang GPS, o nakalimutang mag-check in?</summary>
        <div className="stack" style={{ paddingTop: 8 }}>
          <div className="field"><label htmlFor="pin">Google Maps pin (long-press your spot, copy the numbers)</label>
            <input id="pin" inputMode="decimal" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="14.59472, 121.16750" /></div>
          <label className="row" style={{ alignItems: 'center', gap: 8, minHeight: 44 }}>
            <input type="checkbox" checked={forgot} onChange={(e) => setForgot(e.target.checked)} /> I already shot earlier (forgot to check in)
          </label>
          {forgot && <div className="field"><label htmlFor="wh">When did you start shooting?</label><input id="wh" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></div>}
          <button className="btn alt small" disabled={busy} onClick={fromPin}>Use this pin</button>
        </div>
      </details>
      <Msg text={err} kind="err" />
    </section>
  );
}

function Recent({ shootId, count }: { shootId: string; count: number }) {
  const [rows, setRows] = useState<{ id: string; thumb_path: string; taken_at: string }[]>([]);
  useEffect(() => {
    supabase.from('photos').select('id,thumb_path,taken_at').eq('shoot_id', shootId).order('taken_at', { ascending: false }).limit(6)
      .then(({ data }) => setRows((data ?? []) as typeof rows));
  }, [shootId, count]);
  if (!rows.length) return null;
  return (
    <div className="grid">
      {rows.map((r) => (
        <div key={r.id} className="ph" style={{ cursor: 'default' }}><img src={publicUrl(r.thumb_path)} alt="" loading="lazy" /><span className="tag">{time(r.taken_at)}</span></div>
      ))}
    </div>
  );
}

function Done({ shoot, onDone }: { shoot: Shoot; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!shoot.photo_count) return null;
  if (shoot.done_at) return <p className="msg ok">✓ Tapos ka na. Riders who passed you are being told now.</p>;
  return (
    <div className="stack">
      <button className="btn sun" disabled={busy} onClick={async () => {
        setBusy(true); await supabase.rpc('shoot_uploaded', { p_shoot: shoot.id, p_done: true }); setBusy(false); onDone();
      }}>Tapos na ako · lahat na-upload</button>
      <p className="note">Riders get one message per ride, after everyone they passed is done (or by 8pm). Tap this when this shoot is complete.</p>
    </div>
  );
}

// ------------------------------------------------------------------ kita and bayad
type Kita = {
  unpaid: number; week_sales: number; week_tips: number; week_photos: number; week_tippers: number;
  lines: { kind: string; amount: number; note: string | null; at: string; paid: boolean }[];
  payouts: { id: string; amount: number; gcash_ref: string | null; receipt_path: string | null; paid_at: string; note: string | null }[];
};
function useKita() {
  const [k, setK] = useState<Kita | null>(null);
  useEffect(() => { supabase.rpc('my_kita').then(({ data }) => setK(data as Kita)); }, []);
  return k;
}
const kindLabel: Record<string, string> = { sale: 'Photo sold', tip: 'Tip', allowance: 'Trial allowance', referral: 'Referral bonus', adjustment: 'Adjustment' };

function Kita() {
  const k = useKita();
  if (!k) return <p className="note">Loading…</p>;
  const week = Number(k.week_sales) + Number(k.week_tips);
  return (
    <>
      <section className="card dark">
        <span className="note">Kita this week</span>
        <span className="big-num">{peso(week)}</span>
        {k.week_tippers > 0 && <span className="hand" style={{ fontSize: 22, color: '#F6E3C4' }}>{plural(k.week_tippers, 'rider')} tipped you!</span>}
        <div className="lines" style={{ color: 'var(--on-dark)' }}>
          <div><span>{plural(k.week_photos, 'photo')} sold</span><span className="num">{peso(k.week_sales)}</span></div>
          <div><span>Tips</span><span className="num">{peso(k.week_tips)}</span></div>
          <div><span>Kaltas ng Pitik</span><span>wala</span></div>
        </div>
      </section>
      <section className="card flat">
        <div className="between"><h3>Para sa susunod na Lunes</h3><span className="num" style={{ fontWeight: 600 }}>{peso(k.unpaid)}</span></div>
        <p className="note">Paid to your GCash every Monday when it's ₱200 or more.</p>
      </section>
      <section className="card">
        <h3>Latest</h3>
        {!k.lines.length && <p className="note">Wala pa. Once riders buy your shots, they show up here.</p>}
        <div className="lines">
          {k.lines.map((l, i) => (
            <div key={i}><span>{kindLabel[l.kind] ?? l.kind}{l.note && l.kind !== 'tip' ? ` · ${l.note}` : ''} <span className="note">{day(l.at)}{l.paid ? ' · paid' : ''}</span></span><span className="num">{peso(l.amount)}</span></div>
          ))}
        </div>
      </section>
    </>
  );
}

function Bayad() {
  const k = useKita();
  const [open, setOpen] = useState<Record<string, string>>({});
  if (!k) return <p className="note">Loading…</p>;
  async function receipt(path: string) {
    const { data } = await supabase.storage.from('receipts').createSignedUrl(path, 600);
    if (data?.signedUrl) setOpen((o) => ({ ...o, [path]: data.signedUrl }));
  }
  return (
    <section className="card">
      <h2>Bayad</h2>
      {!k.payouts.length && <p className="note">No payouts yet. Your first one comes the Monday after your first sale.</p>}
      {k.payouts.map((p) => (
        <div key={p.id} className="card flat">
          <div className="between"><b className="num">{peso(p.amount)}</b><span className="badge live">Paid {day(p.paid_at)}</span></div>
          {p.gcash_ref && <span className="note">GCash ref {p.gcash_ref}</span>}
          {p.note && <span className="note">{p.note}</span>}
          {p.receipt_path && (open[p.receipt_path]
            ? <img src={open[p.receipt_path]} alt="GCash receipt" style={{ borderRadius: 12 }} />
            : <button className="link" onClick={() => receipt(p.receipt_path!)}>View receipt</button>)}
        </div>
      ))}
    </section>
  );
}

function ProfileForm({ pk }: { pk: PK }) {
  const { refresh } = useAuth();
  const [f, setF] = useState({ name: pk.name, price: String(pk.price), gcash_number: pk.gcash_number ?? '', gcash_name: pk.gcash_name ?? '', fb_page: pk.fb_page ?? '' });
  const [msg, setMsg] = useState<{ t: string; k?: 'ok' | 'err' } | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const gnum = f.gcash_number.replace(/\D/g, '').replace(/^63/, '0');
    if (!/^09\d{9}$/.test(gnum)) return setMsg({ t: 'GCash number should look like 09171234567.', k: 'err' });
    const { error } = await supabase.from('pitikeros').update({ name: f.name.trim(), price: Number(f.price), gcash_number: gnum, gcash_name: f.gcash_name.trim(), fb_page: f.fb_page.trim() || null }).eq('id', pk.id);
    if (error) return setMsg({ t: errText(error), k: 'err' });
    setMsg({ t: 'Saved.', k: 'ok' }); refresh();
  }
  return (
    <form className="card" onSubmit={save}>
      <h2>Profile</h2>
      <p className="note">Your link: pitik.ph/@{pk.handle}</p>
      <div className="field"><label htmlFor="pn">Name</label><input id="pn" maxLength={40} value={f.name} onChange={set('name')} /></div>
      <div className="field"><label htmlFor="pp">Price per photo (₱50 and up)</label><input id="pp" type="number" min={50} max={1000} value={f.price} onChange={set('price')} /></div>
      <div className="row">
        <div className="field"><label htmlFor="pg">GCash number</label><input id="pg" inputMode="tel" value={f.gcash_number} onChange={set('gcash_number')} /></div>
        <div className="field"><label htmlFor="pgn">Name on GCash</label><input id="pgn" value={f.gcash_name} onChange={set('gcash_name')} /></div>
      </div>
      <div className="field"><label htmlFor="pf">FB page</label><input id="pf" value={f.fb_page} onChange={set('fb_page')} /></div>
      <button className="btn">Save</button>
      {msg && <Msg text={msg.t} kind={msg.k} />}
    </form>
  );
}
