import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Layout } from '../components/ui';
import { supabase } from '../lib/supabase';
import { peso } from '../lib/format';
import { PhotoDownloads } from './Library';

type Order = { id: string; status: string; total: number; photos_amount: number; tips_amount: number; fee_amount: number; credit_amount: number; paid_at: string | null };

export default function OrderPage() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const [o, setO] = useState<Order | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let stop = false;
    async function tick(n: number) {
      const { data } = await supabase.from('orders').select('id,status,total,photos_amount,tips_amount,fee_amount,credit_amount,paid_at').eq('id', id!).maybeSingle();
      if (stop) return;
      setO(data as Order); setTries(n);
      // Wait for TechPay's confirmation (never trust the redirect alone): poll ~2 minutes
      if (data && (data as Order).status === 'pending' && sp.get('pay') !== 'failed' && n < 40) setTimeout(() => tick(n + 1), 3000);
    }
    tick(0);
    return () => { stop = true; };
  }, [id, sp]);

  if (!o) return <Layout><p className="note">Loading…</p></Layout>;
  return (
    <Layout>
      {o.status === 'paid' ? (
        <>
          <section className="card dark">
            <span className="hand" style={{ fontSize: 34, color: '#F6E3C4' }}>salamat!</span>
            <p style={{ margin: 0 }}>{peso(Number(o.photos_amount) + Number(o.tips_amount))} goes to the pitikeros on Monday. Here are your photos.</p>
          </section>
          <PhotoDownloads orderId={o.id} />
        </>
      ) : o.status === 'pending' ? (
        <section className="card">
          <h1>{sp.get('pay') === 'failed' ? 'Payment not finished' : 'Confirming your payment…'}</h1>
          <p className="lead">{sp.get('pay') === 'failed'
            ? 'Nothing was charged. Your photos are still picked on your ride page.'
            : tries < 40 ? 'This usually takes a few seconds.' : 'It can take a few minutes. We will email you once it is confirmed.'}</p>
          <Link className="btn alt small" to="/rider">Back to your rides</Link>
        </section>
      ) : (
        <section className="card">
          <h1>{o.status === 'review' ? 'We are checking this payment' : 'Payment cancelled'}</h1>
          <p className="lead">{o.status === 'review' ? 'The amount did not match. The Pitik team will sort it out and email you.' : 'Nothing was charged.'}</p>
          <Link className="btn alt small" to="/rider">Back to your rides</Link>
        </section>
      )}
    </Layout>
  );
}
