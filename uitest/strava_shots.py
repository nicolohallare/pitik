# Screen test: serves the built app, fakes the Supabase backend with sample data, screenshots key pages.
import asyncio, json, time, pathlib, subprocess, sys
from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).parent
UID = '11111111-1111-1111-1111-111111111111'
now = time.time()
SESSION = {"access_token": "x.y.z", "refresh_token": "r", "expires_in": 3600, "expires_at": int(now) + 3600, "token_type": "bearer",
           "user": {"id": UID, "email": "nicolohallare@gmail.com", "aud": "authenticated", "role": "authenticated", "app_metadata": {}, "user_metadata": {}, "created_at": "2026-10-01T00:00:00Z"}}
PK = {"id": UID, "name": "Taktak Shots", "handle": "taktakshots", "price": 50, "gcash_number": "09171234567", "gcash_name": "Jun D.", "fb_page": None, "status": "active", "founding": True}
imgs = ['gold.jpg', 'pan.jpg', 'rapha.jpg', 'duo.jpg', 'pink.jpg', 'group.jpg']
photos = [{"id": f"p{i}", "pitikero_id": UID, "taken_at": f"2026-10-04T22:{40+i:02d}:00Z", "preview_path": imgs[i % 6], "thumb_path": imgs[i % 6], "price": 50, "bought": i == 4} for i in range(5)]
RIDES = [{"id": "ride1", "source": "strava", "name": "Sunday Morning Ride", "started_at": "2026-10-04T22:10:00Z", "strava_activity_id": 1,
          "passes": [{"id": "pass1", "passed_at": "2026-10-04T22:42:00Z", "manual": False, "distance_m": 12, "shoot_id": "s1", "place_label": "Taktak bend",
                      "pitikero": {"id": UID, "name": "Taktak Shots", "handle": "taktakshots", "price": 50}, "shoot_done": True, "count": 5},
                     {"id": "pass2", "passed_at": "2026-10-04T22:47:00Z", "manual": False, "distance_m": 30, "shoot_id": "s2", "place_label": None,
                      "pitikero": {"id": "k", "name": "Ridge Lens", "handle": "ridgelens", "price": 60}, "shoot_done": False, "count": 0}]},
         {"id": "ride2", "source": "strava", "name": "Tuesday Recovery Ride", "started_at": "2026-10-06T22:10:00Z", "strava_activity_id": 2, "passes": []}]
SHOOT = {"id": "s1", "lat": 14.59472, "lon": 121.1675, "accuracy_m": 6, "pin_source": "phone", "place_label": "Taktak, downhill before the bend",
         "checked_in_at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now - 3600)), "clock_offset_ms": 120000, "clock_checked": True,
         "first_shot_at": "2026-10-04T22:02:00Z", "last_shot_at": "2026-10-04T23:40:00Z", "photo_count": 742, "done_at": None}
KITA = {"unpaid": 1850, "week_sales": 2400, "week_tips": 1450, "week_photos": 48, "week_tippers": 14,
        "lines": [{"kind": "tip", "amount": 100, "note": "Tip", "at": "2026-10-05T01:00:00Z", "paid": False},
                  {"kind": "sale", "amount": 50, "note": None, "at": "2026-10-05T01:00:00Z", "paid": False},
                  {"kind": "allowance", "amount": 300, "note": "Trial Sunday Oct 4", "at": "2026-10-05T01:00:00Z", "paid": False}],
        "payouts": [{"id": "po1", "amount": 4950, "gcash_ref": "9012345678901", "receipt_path": None, "paid_at": "2026-09-28T02:00:00Z", "note": "Week of Sep 21"}]}
BAL = [{"id": UID, "name": "Taktak Shots", "handle": "taktakshots", "gcash_number": "09171234567", "gcash_name": "Jun D.", "founding": True, "status": "active",
        "unpaid": 1850, "unpaid_sales": 1200, "unpaid_tips": 350, "unpaid_extras": 300, "last_paid_at": "2026-09-28T02:00:00Z"},
       {"id": "k", "name": "Ridge Lens", "handle": "ridgelens", "gcash_number": "09981234567", "gcash_name": "R. Cruz", "founding": True, "status": "active",
        "unpaid": 640, "unpaid_sales": 480, "unpaid_tips": 160, "unpaid_extras": 0, "last_paid_at": None}]

UPLOADS=[]; INSERTS=[]
STATE={'connected': True}
def rpc(name, body):
    return {"my_pitikero": PK, "my_strava": ({"athlete_name": "Nicolo H.", "write_ok": True} if STATE['connected'] else None), "my_rides": (RIDES if STATE['connected'] else []), "my_rides": RIDES,
            "photos_for_pass": photos if body.get("p_pass") == "pass1" else [], "shoots_on": [], "my_kita": KITA,
            "admin_balances": BAL, "my_purchases": []}.get(name, None)

async def handle(route):
    req = route.request
    u = req.url
    if '/storage/v1/object/public/previews/' in u:
        f = u.rsplit('/', 1)[-1]
        return await route.fulfill(path=str(HERE / f), content_type='image/jpeg')
    if '/storage/v1/object/' in u and req.method == 'POST':
        UPLOADS.append(u.split('/storage/v1/object/')[1])
        return await route.fulfill(json={"Key": u.split('/storage/v1/object/')[1]})
    if '/rest/v1/photos' in u and req.method == 'POST':
        INSERTS.append(json.loads(req.post_data))
        return await route.fulfill(status=201, body='')
    if '/functions/v1/strava' in u:
        return await route.fulfill(json={"connected": STATE['connected'], "configured": True})
    if '/rest/v1/rpc/' in u:
        name = u.split('/rest/v1/rpc/')[1].split('?')[0]
        body = json.loads(req.post_data or '{}')
        return await route.fulfill(json=rpc(name, body))
    if '/rest/v1/' in u:
        table = u.split('/rest/v1/')[1].split('?')[0]
        single = 'vnd.pgrst.object' in (req.headers.get('accept') or '')
        data = {"profiles": {"id": UID, "email": None, "phone": "09171234567", "display_name": None, "is_admin": True, "email_notify": True},
                "credits": [{"amount": 100}], "shoots": [SHOOT], "photos": [{"id": f"r{i}", "thumb_path": imgs[i], "taken_at": f"2026-10-04T23:3{i}:00Z"} for i in range(6)],
                "app_config": [{"key": "pitik_fee_per_photo", "value": "10"}, {"key": "pitik_fee_cap", "value": "30"}]}.get(table, [])
        if single and isinstance(data, list): data = data[0] if data else None
        return await route.fulfill(json=data)
    if '/auth/v1/' in u:
        return await route.fulfill(json=SESSION["user"])
    return await route.continue_()

async def main():
    srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8791', '-d', '/tmp/pitik-mock'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    await asyncio.sleep(1)
    OUT = pathlib.Path(sys.argv[1])
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch()
            ctx = await b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
            await ctx.add_init_script(f"localStorage.setItem('sb-mock-auth-token', {json.dumps(json.dumps(SESSION))});")
            await ctx.route('https://mock.supabase.co/**', handle)
            await ctx.route('https://fonts.googleapis.com/**', lambda r: r.abort())
            pg = await ctx.new_page()
            errs = []
            pg.on('pageerror', lambda e: errs.append(str(e)))
            async def go(path, shot, full=True):
                await pg.goto('http://localhost:8791/')
                await pg.evaluate(f"history.pushState(null,'','{path}'); dispatchEvent(new PopStateEvent('popstate'))")
                await pg.wait_for_timeout(1200)
                await pg.screenshot(path=str(OUT / shot), full_page=full)
            STATE['connected'] = False
            await go('/rider', '1-connect-with-strava.png', full=False)
            STATE['connected'] = True
            await go('/rider', '2-rides-from-strava.png')
            await go('/ride/ride1', '3-ride-page-view-on-strava.png', full=False)
            await go('/account', '4-account-disconnect-strava.png', full=False)
            print('errors:', errs)
            await b.close()
    finally:
        srv.terminate()

asyncio.run(main())
