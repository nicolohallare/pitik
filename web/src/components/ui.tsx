import { NavLink, Link, Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { configured } from '../lib/supabase';

export function Logo() {
  return (
    <Link to="/" className="logo" aria-label="Pitik home">
      pitik
      <svg width="11" height="11" viewBox="0 0 40 40" fill="none" style={{ stroke: 'var(--sun)' }} strokeWidth="5" strokeLinecap="round" aria-hidden="true">
        <path d="M8 18 L4 8" /><path d="M16 14 L18 3" /><path d="M22 20 L32 14" />
      </svg>
    </Link>
  );
}

export function Layout({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const { session, pitikero, profile } = useAuth();
  return (
    <div className={'wrap' + (wide ? ' wide' : '')}>
      <header className="top">
        <Logo />
        <nav className="nav" aria-label="Main">
          {session ? (
            <>
              <NavLink to="/rider">Rides</NavLink>
              <NavLink to="/pitikero">{pitikero ? 'Pitikero' : 'Pitikero ako'}</NavLink>
              {profile?.is_admin && <NavLink to="/admin">Admin</NavLink>}
              <NavLink to="/account">Account</NavLink>
            </>
          ) : (
            <NavLink to="/login">Sign in</NavLink>
          )}
        </nav>
      </header>
      {!configured && <p className="msg err">This copy of Pitik is not connected to its database yet (VITE_SUPABASE_URL is missing).</p>}
      {children}
      <footer className="foot">
        <Link to="/privacy">Privacy</Link>
        <Link to="/feedback">Feedback</Link>
        <span>Pitik · Taktak, Antipolo</span>
      </footer>
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, session } = useAuth();
  const loc = useLocation();
  if (!ready) return <Layout><p className="note">Loading…</p></Layout>;
  if (!session) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

export function Msg({ text, kind }: { text?: string | null; kind?: 'ok' | 'err' }) {
  if (!text) return null;
  return <p className={'msg' + (kind ? ' ' + kind : '')} role={kind === 'err' ? 'alert' : 'status'}>{text}</p>;
}

export function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

export function Seg<T extends string | number>({ value, options, onChange, label }: {
  value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} type="button" className="chip" aria-pressed={o.v === value} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}
