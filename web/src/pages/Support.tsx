import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Layout, Msg, Seg } from '../components/ui';
import { useAuth } from '../lib/auth';
import { errText, supabase } from '../lib/supabase';

const FAQ: { q: string; a: React.ReactNode }[] = [
  { q: "My photos aren't showing", a: <>Pitikeros upload by noon, and your ride needs to pass their spot while they were shooting. On <Link to="/rider">Rides</Link>, tap "Check my rides" to pull in your last 7 days. No Strava? Use "Other ways to find your photos" to upload a GPX file or enter when you passed.</> },
  { q: 'I forgot my PIN', a: 'Send us a message below with your mobile number. We will set a new PIN and tell you through the contact you leave.' },
  { q: 'Disconnect Strava', a: <>Go to <Link to="/account">Account</Link> and tap Disconnect Strava. We delete your Strava tokens right away. You can also revoke Pitik in your Strava settings under My Apps.</> },
  { q: 'Delete my account and data', a: 'Send us a message below. We delete your account, rides and Strava link within 7 days.' },
  { q: 'A payment or purchase went wrong', a: 'Send us a message with the date and the photos you bought. We will check it and refund or fix it.' },
  { q: "Pitikeros: payout didn't arrive", a: <>Payouts go to your GCash every Monday. Check the Payouts tab on <Link to="/pitikero">Pitikero</Link> for the reference number, then message us if it is missing.</> },
];

export default function Support() {
  const { session } = useAuth();
  const [role, setRole] = useState('');
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [msg, setMsg] = useState<{ t: string; k?: 'ok' | 'err' } | null>(null);
  const [sent, setSent] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return setMsg({ t: 'Tell us what happened first.', k: 'err' });
    if (!contact.trim()) return setMsg({ t: 'Leave a mobile number or Messenger name so we can reply.', k: 'err' });
    const { error } = await supabase.from('feedback').insert({
      user_id: session?.user.id ?? null, role: role || null, confusing: text.trim(), contact: contact.trim(), page: 'support',
    });
    if (error) return setMsg({ t: errText(error), k: 'err' });
    setSent(true); setMsg({ t: 'Sent. We usually reply within a day.', k: 'ok' });
  }

  return (
    <Layout>
      <div>
        <h1>Support</h1>
        <p className="lead">Quick answers first. If they don't help, message us and a person from the Pitik team replies, usually within a day.</p>
      </div>

      <section className="stack">
        {FAQ.map((f) => (
          <details key={f.q} className="card flat">
            <summary style={{ cursor: 'pointer', minHeight: 48, display: 'flex', alignItems: 'center', fontWeight: 600 }}>{f.q}</summary>
            <p style={{ margin: 0, color: 'var(--ink2)', fontSize: 15 }}>{f.a}</p>
          </details>
        ))}
      </section>

      <form className="card" onSubmit={send} aria-labelledby="msg-h">
        <h2 id="msg-h">Message the Pitik team</h2>
        <span className="note">I am a…</span>
        <Seg label="Role" value={role} onChange={setRole} options={[{ v: 'rider', label: 'Rider' }, { v: 'pitikero', label: 'Pitikero' }, { v: 'other', label: 'Other' }]} />
        <div className="field"><label htmlFor="st">What happened?</label><textarea id="st" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} /></div>
        <div className="field"><label htmlFor="sc">Your mobile number or Messenger name</label><input id="sc" maxLength={120} value={contact} onChange={(e) => setContact(e.target.value)} /></div>
        <button className="btn sun" disabled={sent}>{sent ? 'Sent' : 'Send message'}</button>
        <Msg text={msg?.t} kind={msg?.k} />
      </form>

      <p className="note">Want to share ideas instead? <Link to="/feedback">Tell us what you think</Link>. How we handle your data: <Link to="/privacy">Privacy</Link>.</p>
    </Layout>
  );
}
