"""Two browser 'devices' (phone + desktop) using the app's REAL Drive adapter,
with googleapis.com served by the emulator in common.py. Only Google's sign-in
window is faked. Covers: connect, join, auto-sync after edit, pull on return,
clash dialog, sign-in expiry ("Tap to sync"), convergence.
Run: python3 dev/e2e/sync_two_devices.py"""
from common import *
from playwright.sync_api import sync_playwright

server, URL = start_server(8772)
errors = []

def new_device(browser, w, h):
    ctx = browser.new_context(viewport={'width': w, 'height': h})
    ctx.add_init_script(FAKE_AUTH)
    ctx.route('https://www.googleapis.com/**', handle)
    ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(f'{w}px pageerror: {e}'))
    pg.on('console', lambda m: m.type == 'error' and 'accounts.google.com' not in m.text and 'ERR_FAILED' not in m.text and errors.append(f'{w}px console: {m.text}'))
    pg.on('dialog', lambda d: d.accept())
    pg.goto(URL)
    return pg

def chip(pg):
    return pg.inner_text('#syncChip') if pg.is_visible('#syncChip') else '(hidden)'

def wait_chip(pg, pattern, timeout=8000):
    pg.wait_for_function("p => new RegExp(p).test(document.getElementById('syncChip').textContent)", arg=pattern, timeout=timeout)

drive_file = drive_files

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        # ---------- phone: set up, add entries, connect
        phone = new_device(b, 412, 915)
        phone.wait_for_selector('.setup-form')
        for el, v in zip(phone.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
        phone.fill('.setup-form input[type=date]', '2026-10-01')
        phone.click('.setup-form button[type=submit]')
        phone.wait_for_selector('.feed')
        def add(pg, amount, desc, date):
            if pg.is_visible('#fab'): pg.click('#fab')
            else: pg.click('.acc-add')
            pg.wait_for_selector('#txDialog[open]')
            pg.fill('#txDialog .amount-input', amount); pg.fill('#txDialog input[list]', desc); pg.fill('#txDialog input[type=date]', date)
            pg.click('#txDialog button[type=submit]'); pg.wait_for_selector('#txDialog[open]', state='detached')
        add(phone, '15', 'Lottery', '2026-10-01')
        add(phone, '57.99', 'Gym', '2026-10-02')
        print('1. chip before connecting:', chip(phone))
        phone.click('#settingsBtn'); phone.wait_for_selector('#settingsDialog[open]')
        phone.screenshot(path=f'{OUT}/d1-settings-connect.png')
        phone.click('#settingsDialog button:has-text("Connect Google Drive")')
        wait_chip(phone, 'Synced')
        phone.wait_for_timeout(200)
        phone.screenshot(path=f'{OUT}/d2-settings-connected.png')
        print('   cog dot hidden after connect:', phone.is_hidden('#unexportedDot'))
        print('   after connect chip:', chip(phone), '| drive files:', len(drive_file()), '| folder names:', [f['name'] for f in drive.values() if f['folder']])
        print('   settings status line:', phone.inner_text('#driveStatusLine'))
        print('   stats:', phone.evaluate('window.__FT_TEST__.auth.stats()'))
        phone.click('#settingsDialog .icon-btn[aria-label=Close]')

        # ---------- desktop: fresh, connect from the setup screen's settings
        desk = new_device(b, 1440, 900)
        desk.wait_for_selector('.setup-form')
        desk.click('#settingsBtn'); desk.wait_for_selector('#settingsDialog[open]')
        desk.click('#settingsDialog button:has-text("Connect Google Drive")')
        desk.wait_for_selector('table.grid', timeout=8000)
        desk.click('#settingsDialog .icon-btn[aria-label=Close]') if desk.is_visible('#settingsDialog[open]') else None
        rows = desk.eval_on_selector_all('table.grid tbody tr td.c-desc', 'els => els.map(e => e.textContent)')
        print('2. desktop joined; grid rows:', rows, '| chip:', chip(desk))

        # ---------- desktop edit → auto-sync after a few seconds
        before = drive_file()[0]['version']
        add(desk, '5.99', 'Netflix', '2026-10-04')
        wait_chip(desk, 'Syncing soon')
        t0 = time.time()
        while drive_file()[0]['version'] == before and time.time() - t0 < 10: desk.wait_for_timeout(200)
        print('   auto-sync took ~%.1fs after the edit' % (time.time() - t0))
        wait_chip(desk, 'Synced')
        print('3. desktop added Netflix; Drive version', before, '->', drive_file()[0]['version'])
        print('   desk chip now:', chip(desk), '| request log tail:', log[-8:])
        print('   desk engine state:', desk.evaluate("() => document.getElementById('syncChip').className"))

        # ---------- phone: return to app (visibility) picks it up
        phone.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }""")
        phone.wait_for_function("() => [...document.querySelectorAll('.entry-desc')].some(e => e.textContent === 'Netflix')", timeout=8000)
        print('4. phone picked up Netflix on returning to the app')

        # ---------- clash: both edit Gym amount
        def edit_amount(pg, desc, amount):
            if pg.is_visible('.feed'):
                pg.click(f'.entry:has(.desc-text:text-is("{desc}"))')
            else:
                pg.locator('table.grid tbody tr', has_text=desc).locator('td.c-desc').click()
            pg.wait_for_selector('#txDialog[open]')
            pg.fill('#txDialog .amount-input', amount)
            pg.click('#txDialog button[type=submit]'); pg.wait_for_selector('#txDialog[open]', state='detached')
        edit_amount(phone, 'Gym', '60')
        edit_amount(desk, 'Gym', '65')
        desk.click('#syncChip'); wait_chip(desk, 'Synced')
        phone.click('#syncChip')
        phone.wait_for_selector('#conflictDialog[open]', timeout=8000)
        phone.screenshot(path=f'{OUT}/d3-clash.png')
        print('5. clash dialog:', phone.inner_text('#conflictDialog .sheet-body').replace('\n', ' | ')[:300])
        phone.click('#conflictDialog input[value=remote]')
        phone.click('#conflictDialog button:has-text("Keep these")')
        wait_chip(phone, 'Synced')
        gym = phone.evaluate("() => [...document.querySelectorAll('.entry')].find(e => e.textContent.includes('Gym'))?.textContent")
        print('   phone Gym after choosing the other device:', gym)

        # ---------- sign-in expiry: chip asks for a tap, tap syncs
        phone.evaluate('window.__FT_TEST__.auth.expire()')
        add(phone, '2.50', 'Parking', '2026-10-04')
        phone.wait_for_timeout(5000)  # past the auto-sync delay: must NOT have synced or asked Google
        print('6. after expiry + edit, chip:', chip(phone), '| interactive sign-ins so far:', phone.evaluate('window.__FT_TEST__.auth.stats().interactive'))
        phone.screenshot(path=f'{OUT}/d4-tap-to-sync.png')
        phone.click('#syncChip'); wait_chip(phone, 'Synced')
        print('   after tap:', chip(phone), '| interactive sign-ins:', phone.evaluate('window.__FT_TEST__.auth.stats().interactive'))
        desk.click('#syncChip'); wait_chip(desk, 'Synced')
        drows = desk.eval_on_selector_all('table.grid tbody tr td.c-desc', 'els => els.map(e => e.textContent)')
        prow = phone.eval_on_selector_all('.entry-desc', 'els => els.map(e => e.textContent)')
        print('7. final desk rows:', sorted(drows), '\n   final phone rows:', sorted(prow))
        desk.screenshot(path=f'{OUT}/d5-desk-chip.png')
        text = drive_file()[0]['text']
        print('8. Drive file is an importable export:', json.loads(text)['format'], '| history length', len(json.loads(text)['sync']['history']))
        b.close()
finally:
    server.terminate()
print('errors:', errors or 'none')
