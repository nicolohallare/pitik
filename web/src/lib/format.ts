export const peso = (n: number | string | null | undefined) => '₱' + Math.round(Number(n ?? 0)).toLocaleString('en-PH');

const TZ = 'Asia/Manila';
export const time = (iso: string | number | Date) =>
  new Date(iso).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
export const hms = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ, hour12: false });
export const day = (iso: string | number | Date) =>
  new Date(iso).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ });
export const dateInput = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const isTodayManila = (iso: string) => dateInput(new Date(iso)) === dateInput();
export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const fmtOffset = (ms: number) => {
  const a = Math.round(Math.abs(ms) / 1000), m = Math.floor(a / 60), s = a % 60;
  return m ? `${m} min${s ? ` ${s} s` : ''}` : `${s} s`;
};
/** "06:41" in Manila on a given YYYY-MM-DD → ISO */
export const manilaIso = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm.length === 5 ? hhmm + ':00' : hhmm}+08:00`).toISOString();
