// Strava brand assets. Files come unmodified from Strava's official download kits
// (developers.strava.com/guidelines) and live in /public/strava/. Until they are added, plain-text fallbacks show.
import { useState } from 'react';
export const STRAVA_ORANGE = '#FC5200';

/** Official "Connect with Strava" button (48px tall). It leads to strava.com/oauth/authorize. */
export function ConnectWithStrava({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <button className="btn sun" disabled={disabled} onClick={onClick}>Connect with Strava</button>;
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label="Connect with Strava"
      style={{ background: 'none', border: 0, padding: 0, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1, alignSelf: 'flex-start', minHeight: 48 }}>
      <img src="/strava/btn_strava_connect_with_orange.svg" alt="Connect with Strava" height={48} onError={() => setMissing(true)} style={{ height: 48, width: 'auto', display: 'block' }} />
    </button>
  );
}

/** Official "Powered by Strava" logo, shown wherever Strava data appears. */
export function PoweredByStrava() {
  const [missing, setMissing] = useState(false);
  if (missing) return <span className="note">Powered by Strava</span>;
  return <img src="/strava/api_logo_pwrdBy_strava_horiz_orange.svg" alt="Powered by Strava" onError={() => setMissing(true)} style={{ height: 22, width: 'auto', display: 'block', marginTop: 4 }} />;
}

/** "View on Strava" link to the original activity. */
export function ViewOnStrava({ activityId }: { activityId: number }) {
  return (
    <a href={`https://www.strava.com/activities/${activityId}`} target="_blank" rel="noreferrer"
      style={{ color: STRAVA_ORANGE, fontWeight: 700, textDecoration: 'underline' }}>View on Strava</a>
  );
}
