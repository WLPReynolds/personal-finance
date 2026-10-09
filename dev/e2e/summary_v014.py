"""v0.14 — phone landing page (Wayne, 9 Oct): "some summary cards instead of
landing immediately on the first account … simply the header card I see at
the top of each account in list view".
Opens on Summary (first tab): one header card per visible account (name,
balance today, end of month, statement line, limit warning, envelope chips);
tap a card → that account; Summary tab / swipe back; no + button there; the
⚙ "open on" setting; desktop grid unchanged.
Clock Fri 9 Oct 2026. Run: python3 dev/e2e/summary_v014.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8784)
errors, checks = [], []

def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def device(b, w, h, mobile, scheme='light'):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, is_mobile=mobile, has_touch=mobile, color_scheme=scheme, landing_summary=True)
    ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
    ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
    pg = ctx.new_page()
    pg.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and errors.append(f'{w}px console: {m.text}'))
    pg.on('pageerror', lambda e: errors.append(f'{w}px pageerror: {e}'))
    pg.on('dialog', lambda d: d.accept())
    pg.clock.install(time=datetime.datetime(2026, 10, 9, 18, 0, 0))
    pg.goto(URL)
    return pg, ctx
def cards(pg): return pg.eval_on_selector_all('.banner-summary .banner-name', 'els => els.map(e => e.textContent)')
def swipe(pg, dx):
    pg.evaluate("""(dx) => { const el = document.querySelector('.list-view'); const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 400 });
      el.dispatchEvent(new TouchEvent('touchstart', { touches: [t(200)], changedTouches: [t(200)], bubbles: true }));
      el.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t(200 + dx)], bubbles: true })); }""", dx)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ph, ctx = device(b, 390, 844, True)
        ph.wait_for_selector('.setup-form')
        for el, v in zip(ph.query_selector_all('.setup-form .amount-input'), ['1500', '120', '2500']): el.fill(v)
        ph.fill('.setup-form input[type=date]', '2026-10-01')
        ph.click('.setup-form button[type=submit]')
        ph.wait_for_selector('.summary', timeout=8000)
        check('after setup the phone shows the Summary', ph.locator('.summary').count() == 1)
        tabs = ph.eval_on_selector_all('.tab-name', 'els => els.map(e => e.textContent)')
        check('Summary is the first tab, and active', tabs[0] == 'Summary' and 'tab-active' in ph.get_attribute('.tab >> nth=0', 'class'), tabs)
        check('one card per account, in account order', cards(ph) == ['Current Account', 'Nationwide', 'Barclaycard'], cards(ph))
        c0 = ph.text_content('.banner-summary >> nth=0')
        check('card = the header card: balance today + end of month', 'Balance today' in c0 and '£1,500.00' in c0 and 'at end of Oct 2026' in c0, c0)
        c2 = ph.text_content('.banner-summary >> nth=2')
        check('card shows Owed for a credit card', 'Owed today' in c2 and '£2,500.00' in c2, c2)
        check('no Account… / Reconcile… buttons on the Summary cards', ph.locator('.summary .banner-edit').count() == 0)
        check('no + button on the Summary', not ph.is_visible('#fab'))
        bar_h = ph.evaluate('document.querySelector(".topbar").getBoundingClientRect().height')
        check('top bar still 57px', abs(bar_h - 57) < 0.6, bar_h)
        ph.screenshot(path=f'{OUT}/v014-summary-1.png')

        # tap a card → that account
        ph.click('.banner-summary >> nth=1')
        ph.wait_for_selector('.feed')
        check('tap a card → that account’s list', 'tab-active' in ph.get_attribute('.tab >> nth=2', 'class') and ph.locator('.banner-edit').count() == 2)
        check('the + button is back on an account', ph.is_visible('#fab'))
        # tabs and swipes
        ph.click('.tab >> nth=0'); ph.wait_for_selector('.summary')
        check('Summary tab goes back', ph.locator('.summary').count() == 1)
        swipe(ph, -120); ph.wait_for_selector('.feed')
        check('swipe left from Summary → the first account', 'tab-active' in ph.get_attribute('.tab >> nth=1', 'class'))
        swipe(ph, 120); ph.wait_for_selector('.summary')
        check('swipe right from the first account → Summary', ph.locator('.summary').count() == 1)

        # a card that crosses a line shows the warning; hidden accounts aren't shown
        ph.click('.banner-summary >> nth=0'); ph.wait_for_selector('.feed')
        ph.click('#fab'); ph.wait_for_selector('#txDialog[open]')
        ph.fill('#txDialog .amount-input', '1600.00'); ph.fill('#txDialog input[placeholder="e.g. Lottery"]', 'Holiday'); ph.fill('#txDialog input[type=date]', '2026-10-12')
        ph.click('#txDialog button[type=submit]'); ph.wait_for_selector('#txDialog[open]', state='detached')
        ph.click('.tab >> nth=0'); ph.wait_for_selector('.summary')
        lim = ph.text_content('.banner-summary >> nth=0 >> .banner-lim') if ph.locator('.banner-summary >> nth=0 >> .banner-lim').count() else ''
        check('Summary card carries the limit warning', 'Overdrawn from' in lim and '12 Oct' in lim, lim)
        ph.click('.banner-summary >> nth=1'); ph.wait_for_selector('.feed')
        ph.click('.banner-edit >> nth=0'); ph.wait_for_selector('#accountDialog[open]')
        ph.check('#accountDialog label.check:has-text("Hide this account") input')
        ph.click('#accountDialog button[type=submit]'); ph.wait_for_selector('#accountDialog[open]', state='detached')
        ph.click('.tab >> nth=0'); ph.wait_for_selector('.summary')
        check('a hidden account has no card', cards(ph) == ['Current Account', 'Barclaycard'], cards(ph))
        ph.screenshot(path=f'{OUT}/v014-summary-2-warning.png')

        # reopening the app lands on Summary again
        ph.click('.banner-summary >> nth=1'); ph.wait_for_selector('.feed')
        ph.reload(); ph.wait_for_selector('.summary')
        check('reopening the app lands on the Summary', ph.locator('.summary').count() == 1)

        # ⚙ setting: open on the first account instead
        ph.click('#settingsBtn'); ph.wait_for_selector('#settingsDialog[open]')
        st = ph.text_content('#settingsDialog')
        check('⚙ Layout: "In the list (phone), open on: Summary / First account"', 'open on:' in st and 'First account' in st)
        ph.click('#settingsDialog .seg-btn:has-text("First account")')
        ph.reload(); ph.wait_for_selector('.feed')
        check('setting "First account" → opens on the first account (Summary still a tab)', ph.locator('.summary').count() == 0 and ph.eval_on_selector_all('.tab-name', 'els => els[0].textContent') == 'Summary')
        ph.click('#settingsBtn'); ph.wait_for_selector('#settingsDialog[open]')
        ph.click('#settingsDialog .seg-btn:has-text("Summary")')
        ph.reload(); ph.wait_for_selector('.summary')
        check('and back to Summary', ph.locator('.summary').count() == 1)

        # dark + narrow
        dk, _ = device(b, 360, 780, True, 'dark')
        dk.wait_for_selector('.setup-form')
        for el, v in zip(dk.query_selector_all('.setup-form .amount-input'), ['1500', '120', '2500']): el.fill(v)
        dk.click('.setup-form button[type=submit]'); dk.wait_for_selector('.summary')
        sw = dk.evaluate('document.documentElement.scrollWidth')
        check('360px dark: no sideways scroll', sw <= 360, sw)
        dk.screenshot(path=f'{OUT}/v014-summary-3-dark.png')

        # desktop: grid as before
        desk, _ = device(b, 1440, 900, False)
        desk.wait_for_selector('.setup-form')
        desk.click('.setup-form button[type=submit]')
        desk.wait_for_selector('table.grid')
        check('desktop opens on the grid as before (no Summary)', desk.locator('.summary').count() == 0)
        b.close()
finally:
    server.terminate()

print()
print('errors:', errors if errors else 'none')
bad = [c for c in checks if not c[1]]
print(f'{len(checks) - len(bad)}/{len(checks)} checks passed')
sys.exit(1 if bad or errors else 0)
