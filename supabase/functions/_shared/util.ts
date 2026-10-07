import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export const env = (k: string, d = '') => Deno.env.get(k) ?? d;

export const admin = (): SupabaseClient =>
  createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

/** Client acting as the caller (their JWT), so RLS and auth.uid() apply. */
export const asUser = (req: Request): SupabaseClient =>
  createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    auth: { persistSession: false },
  });

export async function currentUser(req: Request) {
  const { data } = await asUser(req).auth.getUser();
  return data.user ?? null;
}

export async function appUrl(): Promise<string> {
  const fromEnv = env('APP_URL');
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  try {
    const { data } = await admin().from('app_config').select('value').eq('key', 'app_url').single();
    return String(data?.value ?? '').replace(/\/$/, '');
  } catch { return ''; }
}

export async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const peso = (n: number) => '₱' + Math.round(n).toLocaleString('en-PH');
export const manilaTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
