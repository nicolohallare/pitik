import { useState } from 'react';
import { Layout, Msg, Seg } from '../components/ui';
import { useAuth } from '../lib/auth';
import { errText, supabase } from '../lib/supabase';

export default function Feedback() {
  const { session } = useAuth();
  const [f, setF] = useState({ name: '', liked: '', confusing: '', missing: '', contact: '' });
  const [role, setRole] = useState<string>('');
  const [use, setUse] = useState<string>('');
  const [easy, setEasy] = useState<number>(0);
  const [price, setPrice] = useState<string>('');
  const [msg, setMsg] = useState<{ t: string; k?: 'ok' | 'err' } | null>(null);
  const [sent, setSent] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!f.liked && !f.confusing && !f.missing && !use) return setMsg({ t: 'Sagutin mo kahit isa lang muna.', k: 'err' });
    const { error } = await supabase.from('feedback').insert({
      user_id: session?.user.id ?? null, name: f.name || null, role: role || null, would_use: use || null,
      checkin_easy: easy || null, price_ok: price || null, liked: f.liked || null, confusing: f.confusing || null,
      missing: f.missing || null, contact: f.contact || null, page: 'app',
    });
    if (error) return setMsg({ t: errText(error), k: 'err' });
    setSent(true); setMsg({ t: 'Salamat! Natanggap namin.', k: 'ok' });
  }
  return (
    <Layout>
      <div><span className="who">ikaw naman</span><h1>Ano sa tingin mo?</h1></div>
      <form className="card" onSubmit={send}>
        <div className="field"><label htmlFor="fn">Pangalan o FB page</label><input id="fn" maxLength={80} value={f.name} onChange={set('name')} /></div>
        <span className="note">Ikaw ay…</span>
        <Seg label="Role" value={role} onChange={setRole} options={[{ v: 'pitikero', label: 'Pitikero' }, { v: 'rider', label: 'Rider' }, { v: 'other', label: 'Iba pa' }]} />
        <span className="note">Gagamitin mo ba ang Pitik?</span>
        <Seg label="Would you use Pitik" value={use} onChange={setUse} options={[{ v: 'oo', label: 'Oo' }, { v: 'siguro', label: 'Siguro' }, { v: 'hindi', label: 'Hindi' }]} />
        <span className="note">Madali ba ang "Nandito ako" at pag-upload?</span>
        <Seg label="Was it easy" value={easy} onChange={setEasy} options={[{ v: 5, label: 'Madali' }, { v: 3, label: 'Medyo' }, { v: 1, label: 'Mahirap' }]} />
        <span className="note">Ok ba ang presyo?</span>
        <Seg label="Pricing" value={price} onChange={setPrice} options={[{ v: 'oo', label: 'Ok' }, { v: 'siguro', label: 'Pwede' }, { v: 'hindi', label: 'Hindi' }]} />
        <div className="field"><label htmlFor="fl">Ano ang nagustuhan mo?</label><textarea id="fl" maxLength={2000} value={f.liked} onChange={set('liked')} /></div>
        <div className="field"><label htmlFor="fc">Ano ang nakakalito o mahirap?</label><textarea id="fc" maxLength={2000} value={f.confusing} onChange={set('confusing')} /></div>
        <div className="field"><label htmlFor="fm">Ano pa ang kulang?</label><textarea id="fm" maxLength={2000} value={f.missing} onChange={set('missing')} /></div>
        <div className="field"><label htmlFor="fx">Number o Messenger (optional)</label><input id="fx" maxLength={80} value={f.contact} onChange={set('contact')} /></div>
        <button className="btn sun" disabled={sent}>{sent ? 'Sent ✓' : 'I-send'}</button>
        {msg && <Msg text={msg.t} kind={msg.k} />}
      </form>
    </Layout>
  );
}
