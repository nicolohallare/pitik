# Pitik

Roadside photos from the pitikeros of Taktak, found by **time and place**.

- A **pitikero** taps **"Nandito ako"** at their spot (the phone pins it), does a 10-second **clock check**, shoots as usual, and uploads later. The browser reads each shot's camera time, rejects files without one (Messenger/FB/screenshots) and RAW files, then makes a watermarked preview and a 3000-px full-size copy before anything is uploaded.
- A **rider** connects **Strava** once (or uploads a GPX, or types roughly when they passed). Pitik finds every moment the ride came within 250 m of a pitikero's pin while they were shooting, and shows only the shots from those minutes.
- One message per ride: a line on the Strava activity (edited in place, never duplicated) and one email, after every pitikero the rider passed has finished uploading or by 8 pm. At most one follow-up. No SMS.
- The pitikero sets the price (₱50 minimum) and keeps 100% of it plus every tip. The rider pays a Pitik fee of ₱10 per photo, capped at ₱30 per order. New riders get a ₱100 founding credit.
- Payment goes through **TechPay** hosted checkout (QR Ph / GCash / Maya / cards). The webhook is verified by calling TechPay back, and settlement is idempotent.
- **Admin** pays pitikeros weekly by GCash and records the ref and receipt; the pitikero sees it on their **Bayad** page. Trial allowances, referral bonuses and rider credits are recorded in the same place.

```
web/                React app (Vite). Deploys to Vercel.
supabase/
  migrations/       Database: tables, security rules, matching, money, storage, schedules
  functions/        strava · techpay · notify   (Supabase Edge Functions, Deno)
dbtest/             Runs the migrations on an in-process Postgres and tests every money/matching rule
uitest/             Screen test with a fake backend
```

---

## Setup checklist (about an hour)

### 1. Supabase project `pitik` (Singapore)
If Claude already set it up, skip to step 2. Otherwise:
1. Create project **pitik**, region **Southeast Asia (Singapore)**.
2. SQL editor: run `supabase/migrations/20261007000001_pitik_core.sql`, then `…02_storage.sql`, then `…03_cron.sql` **after replacing `__PROJECT_REF__`** with the project ref (the part before `.supabase.co`).
3. **Authentication → Providers → Email**: enabled, "Confirm email" on.
4. **Authentication → Email templates**: in BOTH **Confirm signup** (first sign-in) and **Magic Link** (later sign-ins), add the code so people can type it. Typing the code works even when the email opens inside Gmail's own browser, where a tapped link can fail:
   `<p>Your Pitik code: <b>{{ .Token }}</b></p><p>Or tap: <a href="{{ .ConfirmationURL }}">Sign in</a></p>`
5. **Authentication → URL configuration**: Site URL = your app URL (e.g. `https://pitik.vercel.app`), and add `https://pitik.vercel.app/**` (plus your own domain later) to Redirect URLs.
6. **Authentication → SMTP**: use Resend (step 4). The built-in mailer sends only a handful of emails per hour.

### 2. Server functions
Deploy `strava`, `techpay` and `notify` with **JWT verification off** (`supabase/config.toml` already says so):
```
supabase functions deploy strava techpay notify --project-ref <ref>
```
**Edge Functions → Secrets** (never paste these into chat):

| Secret | Value |
|---|---|
| `APP_URL` | `https://pitik.vercel.app` (no trailing slash) |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | from step 3 |
| `STRAVA_VERIFY_TOKEN` | any long random string you make up |
| `TECHPAY_HOST` | `api-stg.techpay.com.ph` first, then `api.techpay.com.ph` |
| `TECHPAY_USER`, `TECHPAY_PASS`, `TECHPAY_SIGNATURE_KEY` | TechPay API user for that environment |
| `RESEND_API_KEY`, `EMAIL_FROM` | from step 4, e.g. `Pitik <hello@pitik.ph>` |

Also run: `update app_config set value = 'https://pitik.vercel.app' where key = 'app_url';`

### 3. Strava API app
1. You need a **Strava subscription** on the account that owns the app (required for new developers since June 2026).
2. strava.com/settings/api → create **Pitik**. Authorization Callback Domain: `<ref>.supabase.co`.
3. Copy the Client ID and Secret into the function secrets.
4. In Pitik, go to **Admin → Orders → "Turn on the Strava ride feed"** (one time). Pitik saves the subscription id and ignores ride events that don't carry it.
5. **Capacity:** a new Strava app connects only **1 athlete**. You can raise it to **10** yourself in the Strava developer settings, which is enough for the trial. Beyond 10 needs Strava's review (up to 9,999), with no guaranteed timeline. **Apply as soon as the trial starts.** Until then, other riders use the GPX upload or "I passed around…", which already work.
6. Strava rules Pitik follows: ride data is shown only to the rider it belongs to, routes are deleted within 3 days (Strava allows 7), and no AI use of Strava data.

### 4. Email (Resend)
resend.com → add and verify your domain (`pitik.ph` or a subdomain) → API key → put it in `RESEND_API_KEY` and also in Supabase **Auth → SMTP** (host `smtp.resend.com`, port 465, user `resend`, password = the API key). The free tier covers 3,000 emails a month.

### 5. Web app on Vercel
1. Import the GitHub repo. **Root directory: `web`**. Framework: Vite.
2. Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (Supabase → Settings → API; the anon/publishable key is meant for browsers).
3. Deploy. Add your domain when ready, then update `APP_URL`, `app_url` and the Auth URLs.

### 6. Payments: staged rollout
- `app_config.gateway_live` starts as **`admins`**: only you can pay online. Test with TechPay **sandbox** (cards only; QR Ph doesn't complete in sandbox).
- Check **Admin → Orders → Payment webhooks** shows `verified: completed`, and that the photos unlock.
- Switch to production secrets, make one real ₱100 QR Ph payment, then `update app_config set value='true' where key='gateway_live';`
- Orders fully covered by credit settle without TechPay.

### 7. First pitikeros
- They sign in with email, tap **Pitikero ako**, and enter name, price and GCash. They can check in and upload right away.
- **Admin → Payouts → Activate** makes their shots visible to riders. **Mark founding** gives the founding badge. New sign-ups stay hidden until you activate them, so nobody can set up a fake pitikero to farm rider credits.
- Trial allowance (₱300 per Sunday) and referrals: **Admin → Extras & credits**.

---

## Security notes (from the independent review, all fixed and tested)
- Storage paths for photos are set by the database from the photo id, never by the browser, so a photo row can't point at someone else's original.
- Rider credit is reserved when checking out and released if the payment is cancelled or the checkout is abandoned. It can't be spent twice and it never pays for tips. A pitikero can't buy their own shots.
- Each TechPay checkout link gets its own reference, made by the database. A late payment on an older link still settles; a second payment for the same order is flagged for refund under Admin → Orders.
- Strava linking finishes inside the app as the signed-in rider, so a link someone else started can't attach your Strava to their account. Ride events are accepted only with Pitik's subscription id, and deletes are confirmed with Strava first.
- "I passed around…" is limited to 2 looks per pitikero session and 6 a day, ±6 minutes each, counted in a log riders can't delete, so nobody can page through a whole morning.
- Checkouts that fail to open the payment page, or sit unpaid for 2 hours, are cancelled and their credit returned (hourly job).
- Every table starts with no access; the app gets exactly the columns it needs. Server-only functions can't be called from the browser.
- Still to check in the TechPay sandbox: field names (`subtotal_amount`) and any status names besides `completed`, `cancelled`, `expired` and `failed`.

## How matching works
`match_ride()` in the core migration. For each pitikero shoot active that day, it takes the ride's points within the shooting window (first shot −15 min to last shot +15 min) and within `pass_radius_m` (250 m) of the pin. It groups consecutive points into passes (a gap of more than 2 minutes starts a new pass, so hill repeats count twice) and records the closest moment of each, plus how long the rider was right at the spot (within 60 m), so a rider who stops for a photo or a drink sees the whole stop. Riders see shots within ±3 minutes by default (1/3/10 to choose; ±10 for a typed-in time).

Late uploads: the ride's thinned track (one point every 5 s) is kept for `track_keep_hours` (72), so shots uploaded that night still match. A nightly job deletes it. A clock-check correction re-times every shot and re-matches automatically.

## Tests
```
cd dbtest && npm i && node test.mjs        # 71 checks, including the attacks found in review
cd web && npm i && npm run build
```

## Costs (monthly, launch)
Supabase Pro project ~US$10 (+ storage over 100 GB at ~$0.021/GB; 750 shots ≈ 1.6 GB per pitikero per morning) · Vercel Hobby free · Resend free tier · Strava subscription · TechPay 1.75% QR Ph / 3% card, paid by the rider.

Storage tip: after 60 days, delete originals that never sold (a scheduled job can do this; not switched on yet).
