import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layout, Msg } from '../components/ui';
import { errText, publicUrl, supabase } from '../lib/supabase';
import { time } from '../lib/format';

type Bought = { photo_id: string; taken_at: string; original_path: string; preview_path: string; pitikero: string; paid_at: string };

async function download(b: Bought) {
  const name = `pitik-${b.pitikero.replace(/\W+/g, '-').toLowerCase()}-${new Date(b.taken_at).toISOString().slice(0, 16).replace(/[:T]/g, '')}.jpg`;
  const { data, error } = await supabase.storage.from('originals').createSignedUrl(b.original_path, 300, { download: name });
  if (error || !data) throw error ?? new Error('Could not open the photo');
  location.href = data.signedUrl;
}

export function PhotoDownloads({ orderId }: { orderId?: string }) {
  const [list, setList] = useState<Bought[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    (async () => {
      const { data } = await supabase.rpc('my_purchases');
      let l = (data ?? []) as Bought[];
      if (orderId) {
        const { data: items } = await supabase.from('order_items').select('photo_id').eq('order_id', orderId);
        const ids = new Set((items ?? []).map((i: { photo_id: string }) => i.photo_id));
        l = l.filter((b) => ids.has(b.photo_id));
      }
      setList(l);
    })();
  }, [orderId]);
  if (!list) return <p className="note">Loading…</p>;
  if (!list.length) return <p className="note">No photos yet. <Link to="/rider">Find yours</Link></p>;
  return (
    <section className="stack">
      <div className="grid big">
        {list.map((b) => (
          <div key={b.photo_id} className="stack" style={{ gap: 4 }}>
            <div className="ph" style={{ cursor: 'default' }}><img src={publicUrl(b.preview_path)} alt="" loading="lazy" /><span className="tag">{b.pitikero} · {time(b.taken_at)}</span></div>
            <button className="btn green small" onClick={() => download(b).catch((e) => setErr(errText(e)))}>Download full size</button>
          </div>
        ))}
      </div>
      <p className="note">Downloads are clean, without the watermark. Tag the pitikero when you post!</p>
      <Msg text={err} kind="err" />
    </section>
  );
}

export default function Library() {
  return (
    <Layout>
      <h1>Your photos</h1>
      <PhotoDownloads />
    </Layout>
  );
}
