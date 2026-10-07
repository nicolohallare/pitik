import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Layout, Msg } from '../components/ui';
import { errText, supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';

export default function Login() {
  const [sp] = useSearchParams();
  const next = sp.get('next') || '/rider';
  const nav = useNavigate();
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { if (session) nav(next, { replace: true }); }, [session, next, nav]);

  async function send(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true, emailRedirectTo: `${location.origin}${next}` },
    });
    setBusy(false);
    if (error) setErr(errText(error)); else setSent(true);
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault(); setErr(''); setBusy(true);
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
    setBusy(false);
    if (error) setErr('That code did not work. Check the latest email, or send a new one.');
  }

  return (
    <Layout>
      <h1>Sign in</h1>
      <p className="lead">No password. We email you a 6-digit code.</p>
      {!sent ? (
        <form className="card" onSubmit={send}>
          <div className="field"><label htmlFor="em">Email</label>
            <input id="em" type="email" inputMode="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <button className="btn sun" disabled={busy || !email}>{busy ? 'Sending…' : 'Email me a code'}</button>
          <Msg text={err} kind="err" />
        </form>
      ) : (
        <form className="card" onSubmit={verify}>
          <p style={{ margin: 0 }}>We sent a code to <b>{email}</b>. It can take a minute. Check Promotions or Spam too.</p>
          <div className="field"><label htmlFor="cd">6-digit code</label>
            <input id="cd" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6,8}" maxLength={8} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </div>
          <button className="btn sun" disabled={busy || code.length < 6}>{busy ? 'Checking…' : 'Sign in'}</button>
          <p className="note">You can also tap the link in the email on this phone.</p>
          <button type="button" className="link" onClick={() => { setSent(false); setCode(''); }}>Use a different email</button>
          <Msg text={err} kind="err" />
        </form>
      )}
    </Layout>
  );
}
