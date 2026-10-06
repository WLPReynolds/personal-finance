"""v0.10 passphrase lock, with the REAL google-auth.js (Google's script stubbed)
and googleapis.com emulated. Covers: off by default, turning on (rules,
everything in IndexedDB encrypted, token moved out of localStorage), lock
screen on reload (wrong / right passphrase, token restored — no new sign-in),
entries saved while on stay encrypted, Lock now, auto-lock after the chosen
time (fake clock), auto-lock time change, change passphrase, turn off (data
plain again, token back in localStorage), forgot passphrase (device wiped,
Drive untouched, reconnect brings data back). Screenshots light + dark.
Run: python3 dev/e2e/lock_v010.py"""
import datetime
from common import *
from playwright.sync_api import sync_playwright

server, URL = start_server(8781)
errors = []

RAW_DUMP = """async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('finance-tracker', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = await new Promise((res) => { const out = {}; const tx = db.transaction('kv'); const os = tx.objectStore('kv');
    os.openCursor().onsuccess = (e) => { const c = e.target.result; if (c) { out[c.key] = c.value; c.continue(); } else res(out); }; });
  db.close();
  return all;
}"""

def raw(pg):
    return pg.evaluate(RAW_DUMP)

def watch(pg, label):
    pg.on('pageerror', lambda e: errors.append(f'{label}: {e}'))
    pg.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and errors.append(f'{label} console: {m.text}'))
    pg.on('dialog', lambda d: d.accept())

def add_spend(pg, amount, desc):
    pg.click('#fab'); pg.wait_for_selector('#txDialog[open]')
    pg.fill('#txDialog .amount-input', amount)
    pg.fill('#txDialog input[list]', desc)
    pg.click('#txDialog button[type=submit]')
    pg.wait_for_selector(f'.desc-text:text-is("{desc}")')

def open_settings(pg):
    if not pg.evaluate("document.getElementById('settingsDialog').open"):
        pg.click('#settingsBtn')
    pg.wait_for_selector('#settingsDialog[open]')

def unlock(pg, passphrase):
    pg.wait_for_selector('.lock-screen')
    pg.fill('#unlockPass', passphrase)
    pg.click('.lock-screen button[type=submit]')

def check(cond, what):
    print(('ok   ' if cond else 'FAIL ') + what)
    if not cond: errors.append('check failed: ' + what)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2)
        ctx.add_init_script(GIS_STUB)
        ctx.route('https://www.googleapis.com/**', handle)
        ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
        pg = ctx.new_page(); watch(pg, 'page')
        pg.clock.install(time=datetime.datetime(2026, 10, 6, 9, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')
        add_spend(pg, '12.34', 'Coffee beans')

        # Drive on, then the lock
        open_settings(pg)
        check(pg.is_visible('#settingsDialog button:has-text("Turn on passphrase lock")'), 'lock is off by default, offered in settings')
        check(not pg.is_visible('#lockBtn'), 'no lock button in the top bar while off')
        pg.click('#settingsDialog button:has-text("Connect Google Drive")')
        pg.wait_for_function("() => /Synced/.test(document.getElementById('syncChip').textContent)", timeout=8000)
        check(pg.evaluate("Boolean(localStorage.getItem('ft.googleToken'))"), 'without the lock the token is in localStorage (as before)')
        check(raw(pg)['ledger']['accounts'][0]['name'] != '', 'without the lock the ledger is stored plain')

        open_settings(pg)
        pg.click('#settingsDialog button:has-text("Turn on passphrase lock")'); pg.wait_for_selector('#lockDialog[open]')
        pg.screenshot(path=f'{OUT}/lock-1-turn-on.png')
        pg.fill('#lockNew', 'short'); pg.fill('#lockAgain', 'short'); pg.click('#lockDialog button[type=submit]')
        check('at least 8' in pg.inner_text('#lockDialog [role=alert]'), 'short passphrase refused')
        pg.fill('#lockNew', 'blue kettle river'); pg.fill('#lockAgain', 'blue kettle rivers'); pg.click('#lockDialog button[type=submit]')
        check('don’t match' in pg.inner_text('#lockDialog [role=alert]'), 'mismatch refused')
        pg.fill('#lockAgain', 'blue kettle river'); pg.select_option('#lockMinutes', '5')
        pg.click('#lockDialog button[type=submit]')
        pg.wait_for_selector('#lockDialog[open]', state='detached', timeout=15000)
        pg.wait_for_selector('#settingsDialog button:has-text("Lock now")')
        pg.screenshot(path=f'{OUT}/lock-2-settings-on.png')
        r = raw(pg)
        check(all(k in r for k in ['ledger', 'sync', 'auth']) and all(v.get('__ftEnc') == 1 for k, v in r.items() if k != 'vault'), f'every stored record encrypted (keys: {sorted(r)})')
        dump = json.dumps({k: v for k, v in r.items() if k != 'vault'})
        check('Coffee beans' not in dump and 'wayne@example.com' not in dump and 'test-token' not in dump, 'nothing readable in the stored records')
        check(r['vault']['autoLockMinutes'] == 5 and r['vault']['kdf']['iterations'] == 600000, 'header: 5 minutes, 600k rounds')
        check(not pg.evaluate("localStorage.getItem('ft.googleToken')"), 'token removed from localStorage')
        check(pg.evaluate("!document.getElementById('lockBtn').hidden"), 'lock button switched on (hidden by CSS on a phone-width screen)')
        pg.click('#settingsDialog button[aria-label=Close]')

        # a save while on stays encrypted
        add_spend(pg, '3.50', 'Parking')
        pg.wait_for_timeout(300)
        check('Parking' not in json.dumps(raw(pg)['ledger']), 'new entry saved encrypted')

        # reload → lock screen
        pg.reload(); pg.wait_for_selector('.lock-screen')
        check(pg.query_selector('.feed') is None and not pg.is_visible('#settingsBtn') and not pg.is_visible('#fab'), 'lock screen: no data, no settings, no + button')
        pg.screenshot(path=f'{OUT}/lock-3-screen-phone.png')
        unlock(pg, 'wrong passphrase')
        pg.wait_for_selector('.lock-screen [role=alert]:has-text("isn’t right")')
        check(True, 'wrong passphrase refused')
        unlock(pg, 'blue kettle river')
        pg.wait_for_selector('.feed')
        check(pg.is_visible('.desc-text:text-is("Parking")') or pg.query_selector('.desc-text:text-is("Parking")') is not None, 'unlocked: entries back')
        pg.wait_for_function("() => /Synced/.test(document.getElementById('syncChip').textContent)", timeout=8000)
        check(pg.evaluate('window.__gis.requests') == 0, 'token restored from encrypted store — no new Google sign-in')
        check(not pg.evaluate("localStorage.getItem('ft.googleToken')"), 'token still not in localStorage after unlock')
        parking_on_drive = 'Parking' in drive_files()[0]['text']
        check(parking_on_drive, 'Drive copy (plain, by choice) has the entry')

        # Lock now (top bar)
        open_settings(pg); pg.click('#settingsDialog button:has-text("Lock now")'); pg.wait_for_selector('.lock-screen')
        check(True, 'Lock now (settings) → lock screen')
        unlock(pg, 'blue kettle river'); pg.wait_for_selector('.feed')

        # auto-lock after 5 minutes idle (fake clock)
        pg.clock.run_for('04:00')
        check(pg.query_selector('.feed') is not None, 'still open after 4 minutes')
        pg.mouse.move(50, 300); pg.mouse.move(60, 310)  # activity resets the timer
        pg.clock.run_for('04:00')
        check(pg.query_selector('.feed') is not None, 'activity resets the idle timer')
        pg.clock.run_for('01:30')
        pg.wait_for_selector('.lock-screen', timeout=10000)
        check('5 minutes' in pg.inner_text('.lock-screen'), 'auto-locked, says why')
        pg.screenshot(path=f'{OUT}/lock-4-autolocked.png')
        unlock(pg, 'blue kettle river'); pg.wait_for_selector('.feed')

        # change auto-lock time and passphrase
        open_settings(pg)
        pg.select_option('#settingsDialog select[aria-label="Lock after"]', '30')
        pg.wait_for_timeout(300)
        check(raw(pg)['vault']['autoLockMinutes'] == 30, 'auto-lock time saved')
        pg.click('#settingsDialog button:has-text("Change passphrase")'); pg.wait_for_selector('#lockDialog[open]')
        pg.fill('#lockCurrent', 'not it at all'); pg.fill('#lockNew', 'green teapot hill'); pg.fill('#lockAgain', 'green teapot hill')
        pg.click('#lockDialog button[type=submit]')
        pg.wait_for_selector('#lockDialog [role=alert]:has-text("isn’t right")')
        pg.fill('#lockCurrent', 'blue kettle river'); pg.click('#lockDialog button[type=submit]')
        pg.wait_for_selector('#lockDialog[open]', state='detached', timeout=15000)
        pg.reload(); unlock(pg, 'blue kettle river')
        pg.wait_for_selector('.lock-screen [role=alert]:has-text("isn’t right")')
        unlock(pg, 'green teapot hill'); pg.wait_for_selector('.feed')
        check(True, 'old passphrase stops working, new one opens')
        check(raw(pg)['vault']['autoLockMinutes'] == 30, 'auto-lock time kept through passphrase change')

        # turn off
        open_settings(pg)
        pg.click('#settingsDialog button:has-text("Turn off")'); pg.wait_for_selector('#lockDialog[open]')
        pg.fill('#lockCurrent', 'blue kettle river'); pg.click('#lockDialog button[type=submit]')
        pg.wait_for_selector('#lockDialog [role=alert]:has-text("isn’t right")')
        pg.fill('#lockCurrent', 'green teapot hill'); pg.click('#lockDialog button[type=submit]')
        pg.wait_for_selector('#lockDialog[open]', state='detached', timeout=15000)
        r = raw(pg)
        check('vault' not in r and 'Parking' in json.dumps(r['ledger']), 'off: header gone, data plain again')
        check(pg.evaluate("Boolean(localStorage.getItem('ft.googleToken'))"), 'off: token back in localStorage')
        check(pg.evaluate("document.getElementById('lockBtn').hidden"), 'off: lock button hidden')
        pg.reload(); pg.wait_for_selector('.feed')
        check(pg.query_selector('.lock-screen') is None, 'off: opens without asking')

        # forgot passphrase
        open_settings(pg)
        pg.click('#settingsDialog button:has-text("Turn on passphrase lock")'); pg.wait_for_selector('#lockDialog[open]')
        pg.fill('#lockNew', 'forget me later'); pg.fill('#lockAgain', 'forget me later'); pg.click('#lockDialog button[type=submit]')
        pg.wait_for_selector('#lockDialog[open]', state='detached', timeout=15000)
        pg.reload(); pg.wait_for_selector('.lock-screen')
        before = len(drive_files())
        pg.click('.lock-screen button:has-text("Forgot")')
        pg.wait_for_selector('.setup-form .amount-input', timeout=10000)
        check(raw(pg) == {} or 'vault' not in raw(pg), 'forgot: this device wiped, lock gone')
        check(len(drive_files()) == before and 'Parking' in drive_files()[0]['text'], 'forgot: Drive file untouched')
        check(not pg.evaluate("localStorage.getItem('ft.googleToken')"), 'forgot: no token left behind')
        open_settings(pg)
        pg.click('#settingsDialog button:has-text("Connect Google Drive")')
        pg.wait_for_selector('.desc-text:text-is("Parking")', state='attached', timeout=10000)
        check(True, 'forgot: reconnecting Drive brings everything back')
        b.close()

        # design screenshots: lock screen on desktop, light and dark
        b = p.chromium.launch()
        for scheme in ['light', 'dark']:
            c = b.new_context(viewport={'width': 1280, 'height': 800}, color_scheme=scheme)
            c.add_init_script(GIS_STUB)
            q = c.new_page(); watch(q, scheme)
            q.goto(URL); q.wait_for_selector('.setup-form')
            for el, v in zip(q.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
            q.click('.setup-form button[type=submit]'); q.wait_for_selector('.grid, .feed')
            open_settings(q)
            q.click('#settingsDialog button:has-text("Turn on passphrase lock")'); q.wait_for_selector('#lockDialog[open]')
            q.fill('#lockNew', 'blue kettle river'); q.fill('#lockAgain', 'blue kettle river'); q.click('#lockDialog button[type=submit]')
            q.wait_for_selector('#lockDialog[open]', state='detached', timeout=15000)
            q.click('#settingsDialog button[aria-label=Close]')
            q.screenshot(path=f'{OUT}/lock-5-desktop-open-{scheme}.png')
            check(q.is_visible('#lockBtn'), f'{scheme}: desktop top bar shows the lock button')
            q.click('#lockBtn'); q.wait_for_selector('.lock-screen')
            check(True, f'{scheme}: top-bar lock button locks')
            q.fill('#unlockPass', 'nope nope nope'); q.click('.lock-screen button[type=submit]')
            q.wait_for_selector('.lock-screen [role=alert]:has-text("isn’t right")')
            q.screenshot(path=f'{OUT}/lock-6-desktop-screen-{scheme}.png')
            c.close()
        b.close()
finally:
    server.terminate()
print('errors:', errors or 'none')
