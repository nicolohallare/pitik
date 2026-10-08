import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Layout, Msg } from '../components/ui';
import { useAuth } from '../lib/auth';
import { callFn, errText, supabase } from '../lib/supabase';

export default function Account() {
  const { profile, refresh, signOut } = useAuth();
  const nav = useNavigate();
  const [notify, setNotify] = useState(profile?.email_notify ?? true);
  const [strava, setStrava] = useState<{ athlete_name: string } | null>(null);
  const [msg, setMsg] = useState<{ t: string; k?: 'ok' | 'err' } | null>(null);
  useEffect(() => { supabase.rpc('my_strava').then(({ data }) => setStrava((data as { athlete_name: string }) ?? null)); }, []);
  useEffect(() => { if (profile) setNotify(profile.email_notify); }, [profile]);

  async function toggle(v: boolean) {
    setNotify(v);
    const { error } = await supabase.from('profiles').update({ email_notify: v }).eq('id', profile!.id);
    setMsg(error ? { t: errText(error), k: 'err' } : { t: v ? 'Emails on.' : 'Emails off. You will still see new photos on your rides page.', k: 'ok' });
    refresh();
  }
  async function disconnect() {
    try { await callFn('strava', 'disconnect'); setStrava(null); setMsg({ t: 'Strava disconnected. New rides will not come in.', k: 'ok' }); }
    catch (e) { setMsg({ t: errText(e), k: 'err' }); }
  }
  return (
    <Layout>
      <h1>Account</h1>
      <section className="card">
        <p style={{ margin: 0 }}>Signed in as <b>{profile?.email || 'Guest (test account on this phone)'}</b></p>
        <label className="row" style={{ alignItems: 'center', gap: 10, minHeight: 44 }}>
          <input type="checkbox" checked={notify} onChange={(e) => toggle(e.target.checked)} style={{ width: 22, height: 22 }} />
          Email me once per ride when a pitikero caught me
        </label>
        {strava && (
          <div className="stack">
            <p className="note">Strava: {strava.athlete_name || 'connected'}. Pitik keeps only the moments you passed a pitikero.</p>
            <button className="btn alt small" onClick={disconnect}>Disconnect Strava</button>
          </div>
        )}
        <button className="btn alt small" onClick={async () => { await signOut(); nav('/'); }}>Sign out</button>
        {msg && <Msg text={msg.t} kind={msg.k} />}
      </section>
    </Layout>
  );
}
