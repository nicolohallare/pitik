import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const configured = !!(url && key);
export const supabase = createClient(url || 'https://example.supabase.co', key || 'public-anon-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
});

export const publicUrl = (path: string) => `${url}/storage/v1/object/public/previews/${path}`;

/** Call an edge function with the signed-in user's token. */
export async function callFn<T = any>(name: string, action: string, body?: unknown): Promise<T> {
  const { data, error } = await supabase.functions.invoke(`${name}?action=${action}`, { body: body ?? {} });
  if (error) {
    let msg = error.message;
    try { const j = await (error as any).context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep msg */ }
    throw new Error(msg);
  }
  return data as T;
}

/** Turn a Postgres/Supabase error into a sentence for the person. */
export const errText = (e: unknown) => {
  const m = (e as { message?: string })?.message ?? String(e);
  if (/JWT|session|sign in/i.test(m)) return 'Please sign in again.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'No connection. Check your signal and try again.';
  return m;
};

/** Unused Pitik credit for the signed-in user only (admins can read everyone's rows, so always filter). */
export async function myCredit(): Promise<number> {
  const { data: s } = await supabase.auth.getSession();
  const uid = s.session?.user.id;
  if (!uid) return 0;
  const { data } = await supabase.from('credits').select('amount').eq('user_id', uid).is('used_order_id', null);
  return (data ?? []).reduce((a: number, r: { amount: number }) => a + Number(r.amount), 0);
}
