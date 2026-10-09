import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Layout, Msg } from '../components/ui';
import { callFn, errText, supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { normPhone, phoneEmail, pinSecret } from '../lib/phone';

type Mode = 'signin' | 'create' | 'email';

export default function Login() {
  const [sp] = useSearchParams();
  const next = sp.get('next') || '/rider';
  const nav = useNavigate();
  const { session } = useAuth();
  const [mode, setMode] = useState<Mode>('signin');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { if (session) nav(next, { replace: true }); }, [session, next, nav]);
  useEffect(() => { setErr(''); setPin(''); setPin2(''); }, [mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    const ph = normPhone(phone);
    if (!ph) return setErr('Enter your 11-digit mobile number, like 0917 123 4567.');
    if (!/^\d{6}$/.test(pin)) return setErr('Your PIN is 6 digits.');
    if (mode === 'create' && pin !== pin2) return setErr('The two PINs do not match.');
    setBusy(true);
    try {
      if (mode === 'create') await callFn('account', 'signup', { phone: ph, pin });
      const { error } = await supabase.auth.signInWithPassword({ email: phoneEmail(ph), password: pinSecret(pin) });
      if (error) throw new Error(/invalid/i.test(error.message)
        ? 'Wrong number or PIN. New to Pitik? Tap "Create an account" below.'
        : errText(error));
    } catch (x) { setErr(errText(x)); }
    setBusy(false);
  }

  const pinInput = (id: string, label: string, v: string, set: (s: string) => void, auto: string) => (
    <div className="field"><label htmlFor={id}>{label}</label>
      <input id={id} type="password" inputMode="numeric" autoComplete={auto} maxLength={6} required value={v}
        onChange={(e) => set(e.target.value.replace(/\D/g, '').slice(0, 6))} style={{ letterSpacing: '0.3em' }} />
    </div>
  );

  return (
    <Layout>
      <h1>{mode === 'create' ? 'Create your account' : 'Sign in'}</h1>
      {mode === 'email' ? <EmailLogin next={next} back={() => setMode('signin')} /> : (
        <form className="card" onSubmit={submit}>
          <p className="note" style={{ margin: 0 }}>{mode === 'create'
            ? 'Just your mobile number and a 6-digit PIN you choose. No email, no text messages.'
            : 'Your mobile number and your 6-digit Pitik PIN.'}</p>
          <div className="field"><label htmlFor="ph">Mobile number</label>
            <input id="ph" type="tel" inputMode="tel" autoComplete="tel" placeholder="0917 123 4567" required value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          {pinInput('pn', mode === 'create' ? 'Choose a 6-digit PIN' : 'PIN', pin, setPin, mode === 'create' ? 'new-password' : 'current-password')}
          {mode === 'create' && pinInput('pn2', 'Type the PIN again', pin2, setPin2, 'new-password')}
          <button className="btn sun" disabled={busy}>{busy ? 'One moment…' : mode === 'create' ? 'Create account' : 'Sign in'}</button>
          <Msg text={err} kind="err" />
          {mode === 'create'
            ? <button type="button" className="link" onClick={() => setMode('signin')}>I already have an account</button>
            : <button type="button" className="btn alt" onClick={() => setMode('create')}>New to Pitik? Create an account</button>}
          <p className="note">Forgot your PIN? Message the Pitik team and we'll set a new one. · <button type="button" className="link" style={{ display: 'inline', minHeight: 0, padding: 0 }} onClick={() => setMode('email')}>Use email instead</button></p>
        </form>
      )}
    </Layout>
  );
}

function EmailLogin({ next, back }: { next: string; back: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

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

  return !sent ? (
    <form className="card" onSubmit={send}>
      <div className="field"><label htmlFor="em">Email</label>
        <input id="em" type="email" inputMode="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <button className="btn sun" disabled={busy || !email}>{busy ? 'Sending…' : 'Email me a code'}</button>
      <Msg text={err} kind="err" />
      <button type="button" className="link" onClick={back}>Use my mobile number instead</button>
    </form>
  ) : (
    <form className="card" onSubmit={verify}>
      <p style={{ margin: 0 }}>We sent a code to <b>{email}</b>. It can take a minute. Check Promotions or Spam too.</p>
      <div className="field"><label htmlFor="cd">6-digit code</label>
        <input id="cd" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6,8}" maxLength={8} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
      </div>
      <button className="btn sun" disabled={busy || code.length < 6}>{busy ? 'Checking…' : 'Sign in'}</button>
      <button type="button" className="link" onClick={() => { setSent(false); setCode(''); }}>Use a different email</button>
      <Msg text={err} kind="err" />
    </form>
  );
}
