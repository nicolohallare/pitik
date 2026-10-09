import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { peso } from '../lib/format';

export type AllowanceDay = {
  day: string; amount: number; deadline: string; active: boolean; checked_in: boolean; at_taktak: boolean;
  clock_checked: boolean; photos: number; min_photos: number; qualifies: boolean; awarded: boolean; awarded_amount: number | null;
};

const dayLabel = (d: string) => new Date(d + 'T12:00:00+08:00').toLocaleDateString('en-PH', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
const deadlineLabel = (iso: string) => new Date(iso).toLocaleString('en-PH', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });

export function Checklist({ a }: { a: AllowanceDay }) {
  const items: [boolean, string][] = [
    [a.active, 'Account activated by the Pitik team'],
    [a.checked_in && a.at_taktak, '"Nandito ako" with your phone\'s GPS at Taktak, 4–11am'],
    [a.clock_checked, 'Clock check done'],
    [a.photos >= a.min_photos, `${Math.min(a.photos, a.min_photos)} of ${a.min_photos} shots from that morning uploaded`],
  ];
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map(([ok, t]) => (
        <li key={t} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 15 }}>
          <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 11, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700,
            background: ok ? 'var(--green, #44604F)' : 'transparent', color: ok ? '#fff' : 'var(--muted)', border: ok ? 'none' : '2px solid var(--line)' }}>{ok ? '✓' : ''}</span>
          <span style={{ color: ok ? 'inherit' : 'var(--ink2)' }}>{t}<span className="sr-only">{ok ? ' (done)' : ' (not yet)'}</span></span>
        </li>
      ))}
    </ul>
  );
}

/** Pitikero's trial allowance card: shows what is left to earn it, and when it is earned. */
export function AllowanceCard() {
  const [days, setDays] = useState<AllowanceDay[] | null>(null);
  const load = useCallback(async () => {
    const { data } = await supabase.rpc('my_allowance');
    setDays((data ?? []) as AllowanceDay[]);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [load]);
  if (!days?.length) return null;

  const now = Date.now();
  // Show the trial day that is happening or most recent (until its deadline), else the next one
  const current = days.find((d) => !d.awarded && now <= Date.parse(d.deadline) && now >= Date.parse(d.day + 'T00:00:00+08:00'))
    ?? days.find((d) => now < Date.parse(d.day + 'T00:00:00+08:00'));
  const earned = days.filter((d) => d.awarded);

  return (
    <section className="card" style={{ borderColor: 'var(--sun)' }}>
      <div className="between"><h3>Trial allowance</h3>{earned.length > 0 && <span className="badge live">{peso(earned.reduce((a, d) => a + Number(d.awarded_amount ?? 0), 0))} earned</span>}</div>
      {current ? (
        <>
          <p style={{ margin: 0 }}>Earn <b>{peso(current.amount)}</b> on <b>{dayLabel(current.day)}</b> by using Pitik that morning. It goes into your next GCash payout automatically.</p>
          <Checklist a={current} />
          <p className="note">{current.qualifies ? 'All done! It will show in Kita within the hour.' : `Upload by ${deadlineLabel(current.deadline)}. Only real camera shots from that morning count.`}</p>
        </>
      ) : <p className="note" style={{ margin: 0 }}>No trial Sunday coming up right now. We'll post the next one in the group.</p>}
      {earned.map((d) => <p key={d.day} className="msg ok" style={{ margin: 0 }}>✓ {dayLabel(d.day)}: {peso(Number(d.awarded_amount))} added to your payout. Salamat!</p>)}
    </section>
  );
}
