import { useEffect, useState } from 'react';
import { checkShot } from '../lib/photos';
import { errText, supabase } from '../lib/supabase';
import { fmtOffset, hms } from '../lib/format';
import { Msg } from './ui';

export type Shoot = {
  id: string; lat: number; lon: number; accuracy_m: number | null; pin_source: string; place_label: string | null;
  checked_in_at: string; clock_offset_ms: number; clock_checked: boolean; first_shot_at: string | null; last_shot_at: string | null;
  photo_count: number; done_at: string | null;
};

function LiveClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 200); return () => clearInterval(t); }, []);
  return <div className="bigclock" aria-label="Current time">{hms(now)}</div>;
}

/** Clock check: photograph this phone's clock with the camera; the difference fixes every shot's time. */
export function ClockCheck({ shoot, onChange }: { shoot: Shoot; onChange: () => void }) {
  const [step, setStep] = useState<'idle' | 'show' | 'ask'>('idle');
  const [camTime, setCamTime] = useState<number | null>(null);
  const [img, setImg] = useState('');
  const [shown, setShown] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(f?: File) {
    if (!f) return;
    setErr('');
    const c = await checkShot(f);
    if (!c.ok) { setErr('Walang oras ng camera ang litratong iyan. Kunan ulit gamit ang camera at i-load ang original file.'); return; }
    setCamTime(c.cameraTime); setImg(URL.createObjectURL(f)); setShown(hms(c.cameraTime)); setStep('ask');
  }
  async function save() {
    if (camTime == null) return;
    const [h, m, s] = shown.split(':').map(Number);
    if (![h, m].every(Number.isFinite)) return;
    // The clock in the photo shows Manila time on the same day as the camera's time
    const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(camTime));
    const truth = Date.parse(`${ymd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s || 0).padStart(2, '0')}+08:00`);
    let off = truth - Math.floor(camTime / 1000) * 1000;
    if (off > 12 * 3600e3) off -= 86400e3; if (off < -12 * 3600e3) off += 86400e3;
    setBusy(true);
    const { error } = await supabase.from('shoots').update({ clock_offset_ms: off, clock_checked: true }).eq('id', shoot.id);
    setBusy(false);
    if (error) { setErr(errText(error)); return; }
    try { localStorage.setItem('pitik.clock', JSON.stringify({ off, at: Date.now() })); } catch { /* ok */ }
    setStep('idle'); onChange();
  }

  if (step === 'show') return (
    <div className="card flat">
      <span className="badge">Clock check · 1 of 2</span>
      <LiveClock />
      <p className="note" style={{ color: 'var(--ink2)', fontSize: 14 }}>Kunan ng litrato ang orasang ito gamit ang camera na gagamitin mo sa pag-shoot. Tapos i-load dito ang litrato.</p>
      <div className="pick"><div className="btn green small" aria-hidden="true">Load the clock photo</div>
        <input type="file" accept="image/*" aria-label="Load the photo of the clock" onChange={(e) => { load(e.target.files?.[0]); e.target.value = ''; }} /></div>
      <button className="btn alt small" onClick={() => setStep('idle')}>Mamaya na</button>
      <Msg text={err} kind="err" />
    </div>
  );
  if (step === 'ask') return (
    <div className="card flat">
      <span className="badge">Clock check · 2 of 2</span>
      <img src={img} alt="Your photo of the clock" style={{ borderRadius: 12, maxHeight: 220, objectFit: 'cover' }} />
      <div className="field"><label htmlFor="ckt">Anong oras ang nakikita sa litrato?</label>
        <input id="ckt" type="time" step={1} value={shown} onChange={(e) => setShown(e.target.value)} /></div>
      <p className="note">Sabi ng camera: {camTime ? hms(camTime) : ''}. Palitan kung iba ang nasa litrato.</p>
      <button className="btn green small" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Ayos'}</button>
      <Msg text={err} kind="err" />
    </div>
  );
  const off = shoot.clock_offset_ms;
  return (
    <div className="stack">
      {shoot.clock_checked
        ? <p className="msg ok">{Math.abs(off) < 30000 ? '✓ Tama ang oras ng camera mo.' : `✓ Ang camera mo ay ${fmtOffset(off)} ${off > 0 ? 'late' : 'advanced'}. Inayos na namin ang oras ng lahat ng shots mo.`}</p>
        : off ? <p className="msg">Using your last clock check ({fmtOffset(off)} {off > 0 ? 'late' : 'advanced'}). Ulitin kung inayos mo ang camera.</p>
        : <p className="note">Clock check: so riders find the right minute even if your camera clock is off.</p>}
      <button className="btn alt small" onClick={() => setStep('show')}>{shoot.clock_checked ? 'Ulitin ang clock check' : 'Clock check · 10 segundo'}</button>
    </div>
  );
}
