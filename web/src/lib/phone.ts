// Mobile number + PIN sign-in. The login uses a stand-in address that is never emailed.
// Must match supabase/functions/account/index.ts
export const PHONE_DOMAIN = 'm.pitik.invalid';
export const normPhone = (s: string) => {
  const d = s.replace(/\D/g, '');
  return /^(63|0)?9\d{9}$/.test(d) ? '0' + d.slice(-10) : null;
};
export const phoneEmail = (phone: string) => `${phone}@${PHONE_DOMAIN}`;
export const pinSecret = (pin: string) => `pitik-${pin}`;
export const prettyPhone = (p: string) => p.replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');
