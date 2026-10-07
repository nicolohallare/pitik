import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Check, Layout, Seg } from '../components/ui';
import { publicUrl, supabase } from '../lib/supabase';
import { day, peso, plural, time } from '../lib/format';
import { useCart } from '../lib/cart';
import { useRides, type PassRow } from './Rider';

type Photo = { id: string; pitikero_id: string; taken_at: string; preview_path: string; thumb_path: string; price: number; bought: boolean };

export default function RidePage() {
  const { id } = useParams();
  const { rides } = useRides();
  const cart = useCart();
  const [win, setWin] = useState(3);
  const [zoom, setZoom] = useState<Photo | null>(null);
  const ride = rides?.find((r) => r.id === id);
  const n = Object.keys(cart.items).length;
  const sum = Object.values(cart.items).reduce((a, i) => a + i.price, 0);

  if (!rides) return <Layout><p className="note">Loading…</p></Layout>;
  if (!ride) return <Layout><h1>Ride not found</h1><p className="note">It may belong to another account. <Link to="/rider">Back to your rides</Link></p></Layout>;
  const caught = ride.passes.filter((p) => p.count > 0 || p.manual);
  const names = [...new Set(caught.map((p) => p.pitikero.name))];

  return (
    <Layout>
      <div>
        <span className="note">{ride.started_at ? day(ride.started_at) : ''}{ride.source === 'strava' ? ' · from Strava' : ride.source === 'gpx' ? ' · from your ride file' : ''}</span>
        <h1>There you are.</h1>
        <p className="lead">{names.length ? `Nakita ka ng ${plural(names.length, 'pitikero')}. Tap the ones that are you.` : 'No shots of you yet. Pitikeros may still be uploading.'}</p>
      </div>
      {!ride.passes.some((p) => p.manual) && (
        <div className="stack"><span className="note">How much time around each pass?</span>
          <Seg label="Time around each pass" value={win} onChange={setWin} options={[{ v: 1, label: '1 min' }, { v: 3, label: '3 min' }, { v: 10, label: '10 min' }]} /></div>
      )}
      {ride.passes.map((p) => <PassBlock key={p.id + win} p={p} win={win} onZoom={setZoom} />)}

      {zoom && (
        <div role="dialog" aria-modal="true" aria-label="Photo preview" onClick={() => setZoom(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.85)', zIndex: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <img src={publicUrl(zoom.preview_path)} alt="Watermarked preview" style={{ maxHeight: '90vh', borderRadius: 12 }} />
        </div>
      )}

      {n > 0 && (
        <div className="sticky"><div className="between">
          <span><b>{plural(n, 'photo')}</b> · {peso(sum)}</span>
          <Link className="btn sun inline" to="/checkout">Continue</Link>
        </div></div>
      )}
    </Layout>
  );
}

function PassBlock({ p, win, onZoom }: { p: PassRow; win: number; onZoom: (x: Photo) => void }) {
  const cart = useCart();
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  useEffect(() => {
    supabase.rpc('photos_for_pass', { p_pass: p.id, p_minutes: p.manual ? 10 : win }).then(({ data }) => setPhotos((data ?? []) as Photo[]));
  }, [p.id, p.manual, win]);

  return (
    <section className="card">
      <div className="between">
        <span className="who" style={{ fontSize: 26 }}>{p.pitikero.name}</span>
        <span className="note">{p.place_label ? p.place_label + ' · ' : ''}{p.manual ? 'around ' : 'you passed at '}{time(p.passed_at)}</span>
      </div>
      {photos === null ? <p className="note">Loading shots…</p> : photos.length === 0 ? (
        <p className="note">{p.shoot_done ? 'No shots from that moment. Try a wider time.' : `${p.pitikero.name} is still uploading. We'll message you when they're done.`}</p>
      ) : (
        <>
          <p className="note"><b className="num">{photos.length}</b> shots from that moment · {peso(p.pitikero.price)} each, all to {p.pitikero.name}</p>
          <div className="grid big">
            {photos.map((x) => {
              const on = cart.has(x.id);
              return (
                <div key={x.id} style={{ position: 'relative' }}>
                  <button type="button" className={'ph' + (on ? ' on' : '')} aria-pressed={on} aria-label={`Photo at ${time(x.taken_at)}${x.bought ? ', already yours' : ''}`}
                    disabled={x.bought}
                    onClick={() => cart.toggle({ id: x.id, pitikero_id: x.pitikero_id, pitikero: p.pitikero.name, price: x.price, thumb: x.thumb_path, taken_at: x.taken_at })}>
                    <img src={publicUrl(x.thumb_path)} alt="" loading="lazy" />
                    <span className="tag">{time(x.taken_at)}</span>
                    {x.bought ? <span className="own badge live">Yours</span> : <span className="chk"><Check /></span>}
                  </button>
                  <button type="button" className="link" style={{ fontSize: 13 }} onClick={() => onZoom(x)}>Bigger</button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
