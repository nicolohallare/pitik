import { useEffect, useState } from 'react';
import { errText, supabase } from '../lib/supabase';
import { fmtOffset } from '../lib/format';
import { Msg } from './ui';

export type Shoot = {
  id: string; lat: number; lon: number; accuracy_m: number | null; pin_source: string; place_label: string | null;
  checked_in_at: string; clock_offset_ms: number; clock_checked: boolean; first_shot_at: string | null; last_shot_at: string | null;
  photo_count: number; done_at: string | null;
};

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Manila' });

/** Signs that the camera's clock is off: shots long before check-in, many hours after, or in the future. */
export function clockLooksOff(s: Shoot) {
  if (!s.first_shot_at || !s.last_shot_at) return false;
  const ci = Date.parse(s.checked_in_at), first = Date.parse(s.first_shot_at), last = Date.parse(s.last_shot_at);
  return first < ci - 30 * 60e3 || first > ci + 6 * 3600e3 || last > Date.now() + 5 * 60e3;
}

/**
 * Camera clock fix. Most cameras are right and nobody needs this; it only opens when the shots' times
 * don't fit the check-in, or when the pitikero taps it. They type the time their camera shows; the
 * difference from this phone's clock is added to every shot's time.
 */
export function ClockCheck({ shoot, onChange }: { shoot: Shoot; onChange: () => void }) {
  const suspicious = clockLooksOff(shoot);
  const [open, setOpen] = useState(false);
  const [cam, setCam] = useState(hhmm(Date.now()));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { if (!open) return; setCam(hhmm(Date.now())); const t = setInterval(() => tick((n) => n + 1), 5000); return () => clearInterval(t); }, [open]);

  async function save(offMs?: number) {
    let off = offMs;
    if (off == null) {
      const [h, m] = cam.split(':').map(Number);
      if (![h, m].every(Number.isFinite)) return setErr('Type the time your camera shows.');
      const now = Date.now();
      const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
      const camNow = Date.parse(`${ymd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
      off = Math.round((now - camNow) / 60e3) * 60e3;          // to the minute
      if (off > 12 * 3600e3) off -= 86400e3; if (off < -12 * 3600e3) off += 86400e3;
    }
    setBusy(true); setErr('');
    const { error } = await supabase.from('shoots').update({ clock_offset_ms: off, clock_checked: true }).eq('id', shoot.id);
    setBusy(false);
    if (error) return setErr(errText(error));
    try { localStorage.setItem('pitik.clock', JSON.stringify({ off, at: Date.now() })); } catch { /* ok */ }
    setOpen(false); onChange();
  }

  const off = shoot.clock_offset_ms;
  if (!open) {
    if (suspicious && !shoot.clock_checked) return (
      <div className="msg" role="status">
        <b>Mukhang mali ang oras ng camera mo.</b> Your shots' times don't match when you checked in, so riders might not find them.
        <button className="btn small" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>Ayusin ang oras (10 segundo)</button>
      </div>
    );
    if (shoot.clock_checked && Math.abs(off) >= 60e3) return (
      <p className="note">Camera clock fixed: {fmtOffset(off)} {off > 0 ? 'behind' : 'ahead'}. All shot times adjusted. <button className="link" style={{ display: 'inline', minHeight: 0, padding: 0 }} onClick={() => setOpen(true)}>Change</button></p>
    );
    return <button className="link" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>Mali ang oras ng camera ko</button>;
  }
  return (
    <div className="card flat">
      <h3>Camera clock</h3>
      <p className="note" style={{ color: 'var(--ink2)', fontSize: 15 }}>Tingnan ang oras sa camera mo ngayon, tapos i-type dito.</p>
      <div className="row">
        <div className="field"><label htmlFor="ckt">Oras sa camera</label>
          <input id="ckt" type="time" value={cam} onChange={(e) => setCam(e.target.value)} /></div>
        <div className="field"><label>Oras ngayon (phone)</label><input value={hhmm(Date.now())} readOnly tabIndex={-1} /></div>
      </div>
      <button className="btn green small" disabled={busy} onClick={() => save()}>{busy ? 'Saving…' : 'Save'}</button>
      <button className="btn alt small" disabled={busy} onClick={() => save(0)}>Tama naman ang oras ng camera ko</button>
      <button className="link" onClick={() => setOpen(false)}>Cancel</button>
      <Msg text={err} kind="err" />
    </div>
  );
}
