import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Layout, Msg } from '../components/ui';
import { callFn, errText, supabase } from '../lib/supabase';
import { dateInput, day, manilaIso, peso, plural, time } from '../lib/format';
import { parseTrack } from '../lib/gpx';

export type PassRow = {
  id: string; passed_at: string; manual: boolean; distance_m: number | null; shoot_id: string; place_label: string | null;
  pitikero: { id: string; name: string; handle: string; price: number }; shoot_done: boolean; count: number;
};
export type RideRow = { id: string; source: string; name: string | null; started_at: string | null; strava_activity_id: number | null; passes: PassRow[] };

export function useRides() {
  const [rides, setRides] = useState<RideRow[] | null>(null);
  const load = useCallback(async () => {
    const { data } = await supabase.rpc('my_rides', { p_limit: 30 });
    setRides((data ?? []) as RideRow[]);
  }, []);
  useEffect(() => { load(); }, [load]);
  return { rides, load };
}

export default function Rider() {
  const [sp, setSp] = useSearchParams();
  const { rides, load } = useRides();
  const [strava, setStrava] = useState<{ athlete_name: string; write_ok: boolean } | null | undefined>(undefined);
  const [credit, setCredit] = useState(0);
  const [msg, setMsg] = useState<{ t: string; k?: 'ok' | 'err' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stravaReady, setStravaReady] = useState<boolean | null>(null);

  useEffect(() => {
    callFn<{ configured: boolean }>('strava', 'status').then((r) => setStravaReady(!!r.configured)).catch(() => setStravaReady(false));
    supabase.rpc('my_strava').then(({ data }) => setStrava((data as typeof strava) ?? null));
    supabase.from('credits').select('amount').is('used_order_id', null).then(({ data }) =>
      setCredit((data ?? []).reduce((a: number, r: { amount: number }) => a + Number(r.amount), 0)));
  }, []);

  // Back from Strava: finish linking as the signed-in rider
  useEffect(() => {
    const code = sp.get('strava_code');
    if (!code) return;
    const body = { code, state: sp.get('strava_state'), scope: sp.get('strava_scope') };
    ['strava_code', 'strava_state', 'strava_scope'].forEach((k) => sp.delete(k));
    setSp(sp, { replace: true });
    setMsg({ t: 'Connecting Strava…' });
    callFn<{ athlete_name: string; write_ok: boolean }>('strava', 'link', body)
      .then((r) => {
        setStrava({ athlete_name: r.athlete_name, write_ok: r.write_ok });
        setMsg({ t: 'Strava connected. Bringing in your rides from the last 7 days…', k: 'ok' });
        setTimeout(load, 5000); setTimeout(load, 15000);
      })
      .catch((e) => setMsg({ t: errText(e), k: 'err' }));
  }, [sp, setSp, load]);

  useEffect(() => {
    const s = sp.get('strava');
    if (!s) return;
    const text: Record<string, { t: string; k?: 'ok' | 'err' }> = {
      connected: { t: 'Strava connected. Bringing in your rides from the last 7 days…', k: 'ok' },
      denied: { t: 'Strava was not connected. You can try again anytime.', k: 'err' },
      expired: { t: 'That took too long. Tap Connect Strava again.', k: 'err' },
      failed: { t: 'Strava did not connect. Try again in a minute.', k: 'err' },
    };
    setMsg(text[s] ?? null);
    sp.delete('strava'); setSp(sp, { replace: true });
    if (s === 'connected') {
      supabase.rpc('my_strava').then(({ data }) => setStrava((data as typeof strava) ?? null));
      const t1 = setTimeout(load, 4000), t2 = setTimeout(load, 12000);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
  }, [sp, setSp, load]);

  async function connect() {
    setBusy(true); setMsg(null);
    try { const { url } = await callFn<{ url: string }>('strava', 'auth_url'); location.href = url; }
    catch (e) { setMsg({ t: errText(e), k: 'err' }); setBusy(false); }
  }
  async function sync() {
    setBusy(true); setMsg(null);
    try { await callFn('strava', 'sync'); await load(); setMsg({ t: 'Checked your last 7 days of rides.', k: 'ok' }); }
    catch (e) { setMsg({ t: errText(e), k: 'err' }); }
    setBusy(false);
  }

  const withPhotos = (rides ?? []).filter((r) => r.passes.some((p) => p.count > 0));
  const others = (rides ?? []).filter((r) => !r.passes.some((p) => p.count > 0));

  return (
    <Layout>
      <div><span className="who">ang rider</span><h1>Your rides</h1></div>
      {credit > 0 && <p className="msg ok">You have {peso(credit)} Pitik credit for your first photos.</p>}

      <section className="card">
        {strava === undefined ? <p className="note">Loading…</p> : strava ? (
          <>
            <div className="between"><h3>Strava connected</h3><span className="badge live">{strava.athlete_name || 'Connected'}</span></div>
            <p className="note">New rides come in on their own. {strava.write_ok ? 'When a pitikero caught you, we add one line to that ride.' : 'You chose not to let Pitik add a line to your rides; you will still get an email.'}</p>
            <button className="btn alt small" disabled={busy} onClick={sync}>{busy ? 'Checking…' : 'Check my last 7 days now'}</button>
          </>
        ) : stravaReady === false ? (
          <>
            <div className="between"><h3>Strava</h3><span className="badge">Coming soon</span></div>
            <p className="note" style={{ color: 'var(--ink2)', fontSize: 14 }}>Soon you can connect Strava once and every ride comes in on its own. For now, upload your ride file or tell us when you passed, below.</p>
          </>
        ) : (
          <>
            <h3>Connect Strava once</h3>
            <p className="note" style={{ color: 'var(--ink2)', fontSize: 14 }}>Pitik reads when and where you rode to see if you passed a pitikero while they were shooting. We keep only those moments, never your full route.</p>
            <button className="btn sun" disabled={busy} onClick={connect}>{busy ? 'Opening Strava…' : 'Connect Strava'}</button>
          </>
        )}
        <Msg text={msg?.t} kind={msg?.k} />
      </section>

      {rides === null ? <p className="note">Loading rides…</p> : (
        <>
          {withPhotos.map((r) => <RideCard key={r.id} r={r} />)}
          {!withPhotos.length && <p className="note">No photos of you yet. When you ride past a pitikero who's using Pitik, it shows up here.</p>}
          {others.length > 0 && (
            <details className="card flat">
              <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>{plural(others.length, 'other ride')} with no photos yet</summary>
              <div className="stack" style={{ paddingTop: 8 }}>
                {others.map((r) => <div key={r.id} className="between"><span>{r.name || 'Ride'}</span><span className="note">{r.started_at ? day(r.started_at) : ''}{r.passes.length ? ` · passed ${plural(r.passes.length, 'pitikero')}, waiting for uploads` : ''}</span></div>)}
              </div>
            </details>
          )}
        </>
      )}

      <NoStrava onAdded={load} open={stravaReady === false && !strava} />
      <p className="note"><Link to="/photos">Your purchased photos →</Link></p>
    </Layout>
  );
}

function RideCard({ r }: { r: RideRow }) {
  const caught = r.passes.filter((p) => p.count > 0);
  const total = caught.reduce((a, p) => a + p.count, 0);
  const names = [...new Set(caught.map((p) => p.pitikero.name))];
  return (
    <Link to={`/ride/${r.id}`} className="card" style={{ textDecoration: 'none' }}>
      <div className="between"><h3>{r.name || 'Ride'}</h3><span className="note">{r.started_at ? day(r.started_at) : ''}</span></div>
      <p style={{ margin: 0 }}>Nakita ka ng {plural(names.length, 'pitikero')}: {plural(total, 'photo')}</p>
      <div className="row">{caught.map((p) => <span key={p.id} className="badge sun">{p.pitikero.name} · {time(p.passed_at)}</span>)}</div>
    </Link>
  );
}

function NoStrava({ onAdded, open }: { onAdded: () => void; open?: boolean }) {
  const nav = useNavigate();
  const [d, setD] = useState(dateInput());
  const [shoots, setShoots] = useState<{ id: string; place_label: string | null; first_shot_at: string; last_shot_at: string; photo_count: number; pitikero: { name: string } }[]>([]);
  const [pick, setPick] = useState('');
  const [t, setT] = useState('07:00');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.rpc('shoots_on', { p_day: d }).then(({ data }) => { const l = (data ?? []) as typeof shoots; setShoots(l); setPick(l[0]?.id ?? ''); });
  }, [d]);

  async function addManual() {
    setErr(''); setBusy(true);
    const { data, error } = await supabase.rpc('add_manual_pass', { p_shoot: pick, p_at: manilaIso(d, t) });
    setBusy(false);
    if (error) return setErr(errText(error));
    onAdded(); nav(`/ride/${(data as { ride_id: string }).ride_id}`);
  }
  async function gpx(f?: File) {
    if (!f) return;
    setErr(''); setBusy(true);
    try {
      const pts = parseTrack(await f.text());
      if (pts.length < 10) throw new Error('That file has no timed route. Export the ride as GPX and try again.');
      const { data, error } = await supabase.rpc('add_gpx_ride', { p_name: f.name.replace(/\.(gpx|tcx)$/i, ''), p_track: pts });
      if (error) throw error;
      onAdded();
      const res = data as { ride_id: string; passes: number };
      if (res.passes) nav(`/ride/${res.ride_id}`); else setErr("That ride didn't pass any pitikero while they were shooting.");
    } catch (e) { setErr(errText(e)); }
    setBusy(false);
  }

  return (
    <details className="card flat" open={open}>
      <summary style={{ cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', fontWeight: 600 }}>No Strava? Find your photos another way</summary>
      <div className="stack" style={{ paddingTop: 10 }}>
        <div className="pick"><div className="btn alt small" aria-hidden="true">{busy ? 'Reading…' : 'Upload a ride file (GPX from Garmin, Wahoo, Coros)'}</div>
          <input type="file" accept=".gpx,.tcx,application/gpx+xml,application/xml,text/xml" aria-label="Upload a GPX ride file" onChange={(e) => { gpx(e.target.files?.[0]); e.target.value = ''; }} /></div>
        <p className="note" style={{ textAlign: 'center' }}>or tell us when you passed</p>
        <div className="row">
          <div className="field"><label htmlFor="nd">Date</label><input id="nd" type="date" value={d} max={dateInput()} onChange={(e) => setD(e.target.value)} /></div>
          <div className="field"><label htmlFor="nt">I passed around</label><input id="nt" type="time" value={t} onChange={(e) => setT(e.target.value)} /></div>
        </div>
        {shoots.length ? (
          <div className="field"><label htmlFor="ns">Which pitikero?</label>
            <select id="ns" value={pick} onChange={(e) => setPick(e.target.value)}>
              {shoots.map((s) => <option key={s.id} value={s.id}>{s.pitikero.name}{s.place_label ? ` · ${s.place_label}` : ''} · {time(s.first_shot_at)}–{time(s.last_shot_at)}</option>)}
            </select></div>
        ) : <p className="note">No pitikeros uploaded shots on that day yet.</p>}
        <button className="btn small" disabled={!pick || busy} onClick={addManual}>Show shots around that time</button>
        <Msg text={err} kind="err" />
      </div>
    </details>
  );
}
