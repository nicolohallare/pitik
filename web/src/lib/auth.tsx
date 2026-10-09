import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type Profile = { id: string; email: string | null; phone: string | null; display_name: string | null; is_admin: boolean; email_notify: boolean };
export type Pitikero = { id: string; name: string; handle: string; price: number; gcash_number: string | null; gcash_name: string | null; fb_page: string | null; status: string; founding: boolean };

type Ctx = {
  ready: boolean; session: Session | null; profile: Profile | null; pitikero: Pitikero | null;
  refresh: () => Promise<void>; signOut: () => Promise<void>;
};
const AuthCtx = createContext<Ctx>({ ready: false, session: null, profile: null, pitikero: null, refresh: async () => {}, signOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [pitikero, setPitikero] = useState<Pitikero | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async (s: Session | null) => {
    if (!s) { setProfile(null); setPitikero(null); return; }
    const [{ data: p }, { data: pk }] = await Promise.all([
      supabase.from('profiles').select('id,email,phone,display_name,is_admin,email_notify').eq('id', s.user.id).maybeSingle(),
      supabase.rpc('my_pitikero'),
    ]);
    setProfile((p as Profile) ?? null);
    setPitikero((pk as Pitikero) ?? null);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => { setSession(data.session); await load(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); load(s); });
    return () => sub.subscription.unsubscribe();
  }, [load]);

  const value: Ctx = {
    ready, session, profile, pitikero,
    refresh: () => load(session),
    signOut: async () => { await supabase.auth.signOut(); setSession(null); setProfile(null); setPitikero(null); },
  };
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
