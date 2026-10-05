"""The REAL src/google-auth.js + src/drive.js, with Google's sign-in script
replaced by a stub (GIS_STUB) and googleapis.com emulated. Covers: closed
window, success, drive.file scope, token cache across reload, no sign-in
attempts without a tap after expiry, login hint reuse.
Run: python3 dev/e2e/google_signin.py"""
from common import *
from playwright.sync_api import sync_playwright

server, URL = start_server(8773)
google_hits = []
errors = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915})
        ctx.add_init_script(GIS_STUB)
        ctx.route('https://www.googleapis.com/**', handle)
        ctx.route('https://accounts.google.com/**', lambda r, q: (google_hits.append(q.url), r.abort()))
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        # failure path first: window closed
        pg.evaluate("window.__gis.mode = 'closed'")
        pg.click('#settingsDialog button:has-text("Connect Google Drive")')
        pg.wait_for_timeout(600)
        pg.screenshot(path=f'{OUT}/signin-after-closed.png')
        print('dialog open?', pg.evaluate("document.getElementById('settingsDialog').open"), '| gis requests', pg.evaluate('window.__gis.requests'), '| toast', pg.inner_text('#toast'), '| errors', errors)
        print('closed window → toast:', pg.inner_text('#toast'), '| still not connected:', pg.is_visible('#settingsDialog button:has-text("Connect Google Drive")'))
        pg.evaluate("window.__gis.mode = 'ok'")
        pg.wait_for_timeout(300)
        pg.click('#settingsDialog button:has-text("Connect Google Drive")')
        pg.wait_for_function("() => /Synced/.test(document.getElementById('syncChip').textContent)", timeout=8000)
        print('ok → chip:', pg.inner_text('#syncChip'), '| drive files:', len([f for f in drive.values() if not f['folder']]))
        print('scope requested:', pg.evaluate('window.__gis.inits[0].scope'))
        print('token cached in localStorage:', pg.evaluate("Boolean(JSON.parse(localStorage.getItem('ft.googleToken')||'null')?.token)"))
        print('login hint saved:', pg.evaluate("localStorage.getItem('ft.googleLoginHint')"))
        # reload: cached token means no new sign-in request
        reqs = pg.evaluate('window.__gis.requests')
        pg.reload(); pg.wait_for_selector('.feed')
        pg.wait_for_function("() => /Synced/.test(document.getElementById('syncChip').textContent)", timeout=8000)
        print('after reload: chip', pg.inner_text('#syncChip'), '| new sign-in requests:', pg.evaluate('window.__gis.requests') - 0, '(page counter resets; was', reqs, 'before reload)')
        # expire token -> chip, tap uses hint
        pg.evaluate("localStorage.setItem('ft.googleToken', JSON.stringify({token:'x', expiry: Date.now()-1}))")
        pg.reload(); pg.wait_for_selector('.feed'); pg.wait_for_timeout(500)
        print('expired token after reload → chip:', pg.inner_text('#syncChip'), '| sign-in requests without a tap:', pg.evaluate('window.__gis.requests'))
        pg.click('#syncChip')
        pg.wait_for_function("() => /Synced/.test(document.getElementById('syncChip').textContent)", timeout=8000)
        print('after tap → chip:', pg.inner_text('#syncChip'), '| client created with login_hint:', pg.evaluate('window.__gis.inits.at(-1).hint'))
        b.close()
finally:
    server.terminate()
print('requests to accounts.google.com (stubbed, should be none):', google_hits or 'none')
print('errors:', errors or 'none')
