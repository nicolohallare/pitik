// Everything the pitikero's browser does to a shot before it leaves the phone/laptop:
// read the camera time (EXIF), check the file is a real camera original, make the
// watermarked preview + thumbnail, and a full-size JPEG for buyers.
import exifr from 'exifr';

export type ShotCheck =
  | { ok: true; file: File; cameraTime: number; camera: string | null; gps: { lat: number; lon: number } | null; key: string }
  | { ok: false; file: File; reason: 'raw' | 'no-time' | 'not-image' | 'unreadable' };

const RAW = /\.(cr2|cr3|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|dng|3fr|iiq)$/i;

/** EXIF times have no zone; cameras in the PH are on Manila time unless the file says otherwise. */
function exifToMs(s: unknown, sub?: unknown, offset?: unknown): number | null {
  if (s instanceof Date) return isNaN(+s) ? null : +s;
  const m = String(s ?? '').match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const off = typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : '+08:00';
  const ms = sub != null && /^\d+$/.test(String(sub)) ? Number(('0.' + String(sub)).slice(0, 5)) * 1000 : 0;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`);
  return isNaN(t) ? null : t + Math.round(ms);
}

export async function checkShot(file: File): Promise<ShotCheck> {
  if (RAW.test(file.name)) return { ok: false, file, reason: 'raw' };
  if (file.type && !/^image\/(jpeg|jpg|heic|heif)$/i.test(file.type) && !/\.(jpe?g|heic)$/i.test(file.name)) return { ok: false, file, reason: 'not-image' };
  try {
    const ex = await exifr.parse(file, { reviveValues: false, gps: true, pick: ['DateTimeOriginal', 'CreateDate', 'SubSecTimeOriginal', 'OffsetTimeOriginal', 'Make', 'Model', 'GPSLatitude', 'GPSLongitude', 'GPSLatitudeRef', 'GPSLongitudeRef'] });
    const t = exifToMs(ex?.DateTimeOriginal ?? ex?.CreateDate, ex?.SubSecTimeOriginal, ex?.OffsetTimeOriginal);
    if (!t) return { ok: false, file, reason: 'no-time' };
    const gpsData = await exifr.gps(file).catch(() => null);
    const camera = [ex?.Make, ex?.Model].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() || null;
    return {
      ok: true, file, cameraTime: t, camera,
      gps: gpsData && isFinite(gpsData.latitude) ? { lat: gpsData.latitude, lon: gpsData.longitude } : null,
      key: `${file.name}:${file.size}`.slice(0, 200),
    };
  } catch {
    return { ok: false, file, reason: 'unreadable' };
  }
}

async function bitmap(file: File): Promise<ImageBitmap> {
  // Browsers apply the EXIF orientation here.
  return createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
}

function draw(src: ImageBitmap, maxSide: number) {
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return { c, g };
}

function watermark(c: HTMLCanvasElement, g: CanvasRenderingContext2D, label: string) {
  const w = c.width, h = c.height, fs = Math.max(16, Math.round(w / 24));
  g.save(); g.translate(w / 2, h / 2); g.rotate(-Math.PI / 7);
  g.font = `600 ${fs}px "Instrument Sans", system-ui, sans-serif`;
  g.fillStyle = 'rgba(255,255,255,0.34)'; g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = Math.max(1, fs / 18);
  g.textAlign = 'center';
  const text = `pitik · ${label}`, step = g.measureText(text).width + fs * 2;
  let row = 0;
  for (let y = -h; y < h; y += fs * 3.2, row++) for (let x = -w; x < w; x += step) {
    const xx = x + (row % 2 ? step / 2 : 0); g.strokeText(text, xx, y); g.fillText(text, xx, y);
  }
  g.restore();
}

const toBlob = (c: HTMLCanvasElement, q: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not prepare the photo'))), 'image/jpeg', q));

export const FULL_SIDE = 3000;   // what a buyer downloads; plenty for Strava, IG and prints up to 8×10

export async function prepareShot(file: File, label: string) {
  const bmp = await bitmap(file);
  try {
    const full = draw(bmp, FULL_SIDE);
    const original = await toBlob(full.c, 0.9);
    const prev = draw(bmp, 1400); watermark(prev.c, prev.g, label);
    const preview = await toBlob(prev.c, 0.8);
    const th = draw(bmp, 480); watermark(th.c, th.g, label);
    const thumb = await toBlob(th.c, 0.72);
    return { original, preview, thumb, width: full.c.width, height: full.c.height };
  } finally { bmp.close(); }
}

export const reasonText: Record<string, string> = {
  'no-time': 'walang oras ng camera, hindi isinama. Kadalasan galing ito sa Messenger, FB, Viber o screenshot. Kunin ang original sa SD card o sa camera app.',
  raw: 'RAW file, hindi isinama. JPEG ang i-upload.',
  'not-image': 'hindi litrato (JPEG lang).',
  unreadable: 'hindi mabasa ang file.',
};
