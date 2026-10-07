import { useRef, useState } from 'react';
import { checkShot, prepareShot, reasonText, type ShotCheck } from '../lib/photos';
import { errText, supabase } from '../lib/supabase';
import { day, plural, time } from '../lib/format';
import type { Shoot } from './ClockCheck';
import { Msg } from './ui';

type Report = { ok: number; skipped: number; bad: Record<string, number>; cams: string[]; days: string[]; failed: File[]; done: number; total: number };

export function Upload({ shoot, uid, label, onUploaded }: { shoot: Shoot; uid: string; label: string; onUploaded: () => void }) {
  const [phase, setPhase] = useState<'idle' | 'checking' | 'uploading' | 'done'>('idle');
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  const stop = useRef(false);

  async function run(files: File[]) {
    if (!files.length) return;
    setErr(''); stop.current = false;
    setPhase('checking');
    const r: Report = { ok: 0, skipped: 0, bad: {}, cams: [], days: [], failed: [], done: 0, total: 0 };
    setRep({ ...r });

    // Which files are already in this shoot (re-picking the same card is safe)
    const { data: have } = await supabase.from('photos').select('source_key').eq('shoot_id', shoot.id);
    const seen = new Set((have ?? []).map((x: { source_key: string }) => x.source_key));

    const good: Extract<ShotCheck, { ok: true }>[] = [];
    const cams = new Set<string>(), days = new Set<string>();
    for (const f of files) {
      const c = await checkShot(f);
      if (!c.ok) { r.bad[c.reason] = (r.bad[c.reason] ?? 0) + 1; continue; }
      if (seen.has(c.key)) { r.skipped++; continue; }
      seen.add(c.key); good.push(c);
      if (c.camera) cams.add(c.camera);
      days.add(day(c.cameraTime));
    }
    r.cams = [...cams].slice(0, 2); r.days = [...days]; r.total = good.length;
    setRep({ ...r });
    if (!good.length) { setPhase('done'); return; }

    setPhase('uploading');
    let i = 0;
    const worker = async () => {
      while (i < good.length && !stop.current) {
        const c = good[i++];
        try {
          const p = await prepareShot(c.file, label);
          const id = crypto.randomUUID();
          const base = `${uid}/${shoot.id}/${id}`;
          const up = async (bucket: string, path: string, blob: Blob) => {
            const { error } = await supabase.storage.from(bucket).upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' });
            if (error) throw error;
          };
          await up('originals', `${base}.jpg`, p.original);
          await up('previews', `${base}-p.jpg`, p.preview);
          await up('previews', `${base}-t.jpg`, p.thumb);
          const { error } = await supabase.from('photos').insert({
            id, shoot_id: shoot.id, pitikero_id: uid, camera_time: new Date(c.cameraTime).toISOString(),
            camera: c.camera, width: p.width, height: p.height, source_key: c.key,
            original_path: `${base}.jpg`, preview_path: `${base}-p.jpg`, thumb_path: `${base}-t.jpg`,
          });
          if (error && !/duplicate/i.test(error.message)) throw error;
          r.ok++;
        } catch (e) {
          r.failed.push(c.file);
          if (!err) setErr(errText(e));
        }
        r.done++;
        setRep({ ...r });
      }
    };
    await Promise.all([worker(), worker()]);
    await supabase.rpc('shoot_uploaded', { p_shoot: shoot.id, p_done: false });
    setPhase('done');
    onUploaded();
  }

  const pct = rep && rep.total ? Math.round((rep.done / rep.total) * 100) : 0;
  const badTotal = rep ? Object.values(rep.bad).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="stack">
      <div className="pick">
        <div className="btn" aria-hidden="true">{shoot.photo_count ? 'Add more shots' : "Load this morning's shots"}</div>
        <input type="file" accept="image/jpeg,.jpg,.jpeg" multiple disabled={phase === 'checking' || phase === 'uploading'}
          aria-label="Choose shots to upload" onChange={(e) => { const fs = Array.from(e.target.files ?? []); e.target.value = ''; run(fs); }} />
      </div>
      <p className="note">Original files lang, mula sa SD card o sa camera app. Mas mabilis sa WiFi. Pwede mong isara at ituloy mamaya, hindi madodoble.</p>

      {phase === 'checking' && <p className="msg">Checking the camera time on each shot…</p>}
      {rep && (
        <div className="stack" aria-live="polite">
          {rep.total > 0 && (
            <p className="msg ok">✓ {plural(rep.total, 'shot')} na may oras ng camera{rep.cams.length ? ` · ${rep.cams.join(', ')}` : ''}</p>
          )}
          {rep.skipped > 0 && <p className="msg">{plural(rep.skipped, 'shot')} already uploaded, skipped.</p>}
          {Object.entries(rep.bad).map(([k, n]) => <p key={k} className="msg err">{n} {reasonText[k]}</p>)}
          {rep.days.length > 1 && <p className="msg">Ang shots ay galing sa {rep.days.length} araw ({rep.days.join(', ')}). Isang umaga lang dapat bawat shoot.</p>}
          {rep.total > 0 && !rep.cams.length && <p className="msg">Walang camera info ang mga shots. Baka na-edit o na-export ulit. Ok lang, basta tama ang oras.</p>}
          {phase === 'uploading' && (
            <>
              <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: pct + '%' }} /></div>
              <div className="between"><span className="note">Uploading {rep.done} of {rep.total}…</span>
                <button className="link" onClick={() => { stop.current = true; }}>Pause</button></div>
            </>
          )}
          {phase === 'done' && rep.total > 0 && <p className="msg ok">Uploaded {rep.ok} of {rep.total}.{rep.failed.length ? ` ${rep.failed.length} failed.` : ''}</p>}
          {phase === 'done' && rep.failed.length > 0 && <button className="btn alt small" onClick={() => run(rep.failed)}>Retry {plural(rep.failed.length, 'failed shot')}</button>}
          {phase === 'done' && badTotal > 0 && rep.total === 0 && <p className="note">Nothing was uploaded. Use the original files from the camera.</p>}
        </div>
      )}
      <Msg text={err} kind="err" />
      {shoot.photo_count > 0 && shoot.first_shot_at && (
        <p className="note"><b className="num">{shoot.photo_count}</b> shots in this shoot, {time(shoot.first_shot_at)} to {time(shoot.last_shot_at!)}{shoot.clock_checked && Math.abs(shoot.clock_offset_ms) >= 30000 ? ' (clock-corrected)' : ''}.</p>
      )}
    </div>
  );
}
