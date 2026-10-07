/** Parse a GPX (or TCX) ride file in the browser into timed points. The file never leaves the device whole. */
export function parseTrack(xmlText: string): { t: string; lat: number; lon: number }[] {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  const out: { t: string; lat: number; lon: number }[] = [];
  for (const n of Array.from(xml.getElementsByTagName('trkpt'))) {
    const t = n.getElementsByTagName('time')[0]?.textContent;
    const lat = Number(n.getAttribute('lat')), lon = Number(n.getAttribute('lon'));
    if (t && isFinite(lat) && isFinite(lon)) out.push({ t: new Date(t).toISOString(), lat, lon });
  }
  if (!out.length) {
    for (const n of Array.from(xml.getElementsByTagName('Trackpoint'))) {
      const t = n.getElementsByTagName('Time')[0]?.textContent;
      const lat = Number(n.getElementsByTagName('LatitudeDegrees')[0]?.textContent);
      const lon = Number(n.getElementsByTagName('LongitudeDegrees')[0]?.textContent);
      if (t && isFinite(lat) && isFinite(lon) && lat && lon) out.push({ t: new Date(t).toISOString(), lat, lon });
    }
  }
  // thin to one point every 5 s to keep the upload small
  const thin: typeof out = [];
  let last = -Infinity;
  for (const p of out) { const ms = Date.parse(p.t); if (ms - last >= 5000) { thin.push(p); last = ms; } }
  return thin;
}
