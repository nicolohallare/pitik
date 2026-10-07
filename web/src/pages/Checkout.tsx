import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Layout, Msg, Seg } from '../components/ui';
import { useCart } from '../lib/cart';
import { callFn, errText, publicUrl, supabase } from '../lib/supabase';
import { peso, plural, time } from '../lib/format';

export default function Checkout() {
  const cart = useCart();
  const nav = useNavigate();
  const [cfg, setCfg] = useState({ per: 10, cap: 30 });
  const [credit, setCredit] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    supabase.from('app_config').select('key,value').in('key', ['pitik_fee_per_photo', 'pitik_fee_cap']).then(({ data }) => {
      const m = Object.fromEntries((data ?? []).map((r: { key: string; value: string }) => [r.key, Number(r.value)]));
      setCfg({ per: m.pitik_fee_per_photo ?? 10, cap: m.pitik_fee_cap ?? 30 });
    });
    supabase.from('credits').select('amount').is('used_order_id', null).then(({ data }) =>
      setCredit((data ?? []).reduce((a: number, r: { amount: number }) => a + Number(r.amount), 0)));
  }, []);

  const items = Object.values(cart.items);
  const byPk = new Map<string, { name: string; items: typeof items }>();
  items.forEach((i) => { if (!byPk.has(i.pitikero_id)) byPk.set(i.pitikero_id, { name: i.pitikero, items: [] }); byPk.get(i.pitikero_id)!.items.push(i); });
  const tipOf = (pk: string) => cart.tips[pk] ?? 100;
  const photos = items.reduce((a, i) => a + i.price, 0);
  const tips = [...byPk.keys()].reduce((a, k) => a + tipOf(k), 0);
  const fee = Math.min(items.length * cfg.per, cfg.cap);
  const used = Math.min(credit, photos + tips + fee);
  const total = photos + tips + fee - used;

  async function pay() {
    setErr(''); setBusy(true);
    try {
      const tipMap = Object.fromEntries([...byPk.keys()].map((k) => [k, tipOf(k)]));
      const { data, error } = await supabase.rpc('create_order', { p_photo_ids: items.map((i) => i.id), p_tips: tipMap });
      if (error) throw error;
      const o = data as { id: string; total: number };
      if (Number(o.total) <= 0) {
        const { error: e2 } = await supabase.rpc('settle_free_order', { p_order: o.id });
        if (e2) throw e2;
        cart.clear(); nav(`/order/${o.id}`); return;
      }
      const { pay_url } = await callFn<{ pay_url: string }>('techpay', 'start', { order_id: o.id });
      cart.clear();
      location.href = pay_url;
    } catch (e) { setErr(errText(e)); setBusy(false); }
  }

  if (!items.length) return <Layout><h1>Nothing picked yet</h1><p className="note"><Link to="/rider">Back to your rides</Link></p></Layout>;
  return (
    <Layout>
      <div><span className="who">bayad at salamat</span><h1>Pay, tip, download</h1></div>
      {[...byPk.entries()].map(([pk, g]) => (
        <section key={pk} className="card">
          <div className="between"><span className="who" style={{ fontSize: 24 }}>{g.name}</span><span className="note">{plural(g.items.length, 'photo')}</span></div>
          <div className="grid">{g.items.map((i) => (
            <button key={i.id} className="ph on" aria-label={`Remove photo at ${time(i.taken_at)}`} onClick={() => cart.toggle(i)}>
              <img src={publicUrl(i.thumb)} alt="" /><span className="tag">{time(i.taken_at)}</span>
            </button>))}
          </div>
          <span className="note">Tip for {g.name}, 100% goes to them</span>
          <Seg label={`Tip for ${g.name}`} value={tipOf(pk)} onChange={(v) => cart.setTip(pk, v)}
            options={[{ v: 0, label: 'Next time' }, { v: 50, label: '₱50' }, { v: 100, label: '₱100' }, { v: 200, label: '₱200' }]} />
        </section>
      ))}
      <section className="card">
        <div className="lines">
          <div><span>{plural(items.length, 'photo')}, all to the pitikeros</span><span className="num">{peso(photos)}</span></div>
          <div><span>Tips, all to them</span><span className="num">{peso(tips)}</span></div>
          <div><span>Pitik fee</span><span className="num">{peso(fee)}</span></div>
          {used > 0 && <div><span>Founding rider credit</span><span className="num">−{peso(used)}</span></div>}
          <div className="tot"><span>Total</span><span className="num">{peso(total)}</span></div>
        </div>
        {total > 0 && <p className="note">Pay with GCash, Maya or any bank app (QR Ph), or a card. A small payment fee (QR Ph 1.75%, card 3%) is shown on the next page after you choose.</p>}
        <button className="btn sun" disabled={busy} onClick={pay}>{busy ? 'Opening payment…' : total > 0 ? `Pay ${peso(total)}` : 'Get my photos'}</button>
        <Msg text={err} kind="err" />
      </section>
    </Layout>
  );
}
