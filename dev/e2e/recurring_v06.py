"""v0.6 end to end: phone list oldest-first and opening at today (or the
latest day before it), a different last payment, and "(x of y)" numbering
with a first-payment offset and close-up after a skip. Clock fixed at
Mon 5 Oct 2026.
Run: python3 dev/e2e/recurring_v06.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8768)
errors = []
checks = []

def norm(text):
    return (text or '').replace(',', '')

def check(label, ok, detail=''):
    checks.append((label, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))

def watch(page, label):
    page.on('console', lambda m: m.type == 'error' and 'ERR_TUNNEL' not in m.text and 'ERR_FAILED' not in m.text and errors.append(f'{label} console: {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    page.on('dialog', lambda d: d.accept())

def saved(page, text):
    page.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=5000)

D = '#recurringEditDialog'

def start_item(pg, desc, amount, day, start, end=None, kind='out'):
    pg.click('#recurringDialog .btn-primary'); pg.wait_for_selector(f'{D}[open]')
    pg.fill(f'{D} input[placeholder="e.g. Netflix"]', desc)
    pg.click(f'{D} .seg-btn[data-value="{kind}"]')
    pg.fill(f'{D} input[placeholder="0.00"]', amount)
    pg.fill(f'{D} input[placeholder="1–31"]', str(day))
    pg.fill(f'{D} input[type=date] >> nth=0', start)
    if end:
        pg.fill(f'{D} input[type=date] >> nth=1', end)

def submit(pg, toast='Recurring item added'):
    pg.click(f'{D} button[type=submit]')
    pg.wait_for_selector(f'{D}[open]', state='detached')
    saved(pg, toast)

def open_manager(pg):
    pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
    pg.click('#settingsDialog button:has-text("Manage recurring items")')
    pg.wait_for_selector('#recurringDialog[open]')

def close_manager(pg):
    pg.click('#recurringDialog .icon-btn'); pg.click('#settingsDialog .icon-btn')

def descs(pg, sel='.feed .entry-desc'):
    return pg.eval_on_selector_all(sel, 'els => els.map(e => e.innerText.replace(/\\s+/g, " ").trim())')

def top_day(pg):
    """The day heading sitting just below the sticky tabs."""
    return pg.evaluate('''() => {
        const tabs = document.querySelector('.tabs').getBoundingClientRect().bottom;
        const days = [...document.querySelectorAll('.feed .day')];
        const d = days.find(d => d.getBoundingClientRect().top >= tabs - 2);
        return d ? { date: d.dataset.date, gap: Math.round(d.getBoundingClientRect().top - tabs), scrollY: window.scrollY } : null; }''')

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
        pg = ctx.new_page(); watch(pg, 'phone')
        pg.clock.install(time=datetime.datetime(2026, 10, 5, 12, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']):
            el.fill(v)
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]')
        pg.wait_for_selector('.feed')

        open_manager(pg)
        # ---- a loan: payment 1 already made, 12 more from Nov, last one smaller
        start_item(pg, 'Car loan', '250', 1, '2026-11-01', '2027-10-31')
        check('end date shows the last-payment / numbering fields', pg.is_visible(f'{D} input[placeholder="same"]'))
        pg.fill(f'{D} input[placeholder="same"]', '123.45')
        pg.fill(f'{D} .field-pair >> nth=3 >> input >> nth=1', '2')
        prev = norm(pg.text_content(f'{D} .rec-preview'))
        check('preview: 12 payments numbered 2–13, last £123.45 in Oct 2027', '12 payments numbered 2–13 of 13' in prev and 'last one £123.45 in Oct 2027' in prev, prev)
        pg.screenshot(path=f'{OUT}/v6-1-editor-loan.png')
        submit(pg)
        check('manager: next payment 2 of 13', 'payment 2 of 13' in pg.text_content('#recurringDialog'), norm(pg.text_content('#recurringDialog'))[:300])

        # without an end date the fields are hidden
        start_item(pg, 'Gym', '30', 3, '2026-10-01')
        check('no end date → last-payment fields hidden', not pg.is_visible(f'{D} input[placeholder="same"]'))
        submit(pg)
        close_manager(pg)

        # ---- phone list: oldest first, future at the bottom
        pg.click('.horizon-list button'); pg.click('.horizon-list button'); pg.click('.horizon-list button')
        dates = pg.eval_on_selector_all('.feed .day[data-date]', 'els => els.map(e => e.dataset.date)')
        check('phone list runs oldest → newest', dates == sorted(dates) and dates[0] == '2026-10-01', dates[:5])
        check('Brought forward is the first entry', descs(pg)[0] == 'Brought forward')
        check('show-more control is at the bottom', pg.evaluate("() => document.querySelector('.feed').lastElementChild.classList.contains('horizon-li')"))
        loan = [d for d in descs(pg) if 'Car loan' in d]
        check('loan rows numbered (2 of 13) … (13 of 13)', loan[0].endswith('Car loan (2 of 13)') and loan[-1].endswith('Car loan (13 of 13)') and len(loan) == 12, loan[:2] + loan[-1:])
        amts = pg.eval_on_selector_all('.feed .entry.projected:has-text("Car loan") .entry-amt', 'els => els.map(e => e.textContent)')
        check('last loan payment £123.45, others £250', amts[-1] == '−£123.45' and set(amts[:-1]) == {'−£250.00'}, amts[-2:])

        # ---- opens at the latest day on/before today: nothing on 5 Oct, Gym on 3 Oct
        pg.reload(); pg.wait_for_selector('.feed'); pg.wait_for_timeout(300)
        t = top_day(pg)
        check('opens with Sat 3 Oct (day before today with entries) at the top', t and t['date'] == '2026-10-03' and abs(t['gap']) <= 14 and t['scrollY'] > 0, t)
        pg.screenshot(path=f'{OUT}/v6-2-phone-open.png')

        # an ordinary redraw (show more, a skip) keeps the scroll where it is
        # (measure after Playwright has scrolled the target into view for the click)
        pg.locator('.horizon-list button').scroll_into_view_if_needed()
        y = pg.evaluate('() => window.scrollY')
        pg.click('.horizon-list button')
        check('show more keeps the scroll position', abs(pg.evaluate('() => window.scrollY') - y) < 5, (y, pg.evaluate('() => window.scrollY')))
        pg.click('.horizon-list button'); pg.click('.horizon-list button')
        pg.click('.feed .entry.projected:has-text("Car loan") >> nth=3'); pg.wait_for_selector('#txDialog[open]')
        y0 = pg.evaluate('() => window.scrollY')
        check('dialog: payment 5 of 13', 'Payment 5 of 13.' in pg.text_content('#txDialog'), pg.text_content('#txDialog .rec-status'))
        pg.click('#txDialog button:has-text("Skip this month")')
        pg.wait_for_selector('#txDialog[open]', state='detached'); saved(pg, 'Skipped')
        y1 = pg.evaluate('() => window.scrollY')
        check('skip redraw keeps the scroll position', abs(y1 - y0) < 5, (y0, y1))
        loan = [d for d in descs(pg) if 'Car loan' in d]
        check('after skipping Feb: skipped row unnumbered, rest close up to (12 of 12)',
              loan[3] == '↻ Car loan' and loan[4].endswith('(5 of 12)') and loan[-1].endswith('(12 of 12)'), loan[2:6] + loan[-1:])

        # last payment dialog
        pg.click('.feed .entry.projected:has-text("Car loan") >> nth=-1'); pg.wait_for_selector('#txDialog[open]')
        txt = pg.text_content('#txDialog')
        check('final dialog: 12 of 12 — the last one, amount 123.45', 'Payment 12 of 12 — the last one.' in txt and pg.input_value('#txDialog .amount-input') == '123.45', txt[:200])
        pg.click('#txDialog .icon-btn')

        # ---- an entry today → opens at today
        pg.click('.feed .entry.projected:has-text("Car loan") >> nth=0'); pg.wait_for_selector('#txDialog[open]')
        pg.fill('#txDialog input[type=date]', '2026-10-05')
        pg.click('#txDialog button:has-text("Confirm")')
        pg.wait_for_selector('#txDialog[open]', state='detached'); saved(pg, 'Confirmed')
        check('confirmed payment keeps its number', descs(pg, '.feed .entry:not(.projected) .entry-desc').count('Car loan (2 of 12)') == 1, descs(pg)[:5])
        pg.reload(); pg.wait_for_selector('.feed'); pg.wait_for_timeout(300)
        t = top_day(pg)
        at_bottom = pg.evaluate('() => Math.abs(window.scrollY + innerHeight - document.documentElement.scrollHeight) < 3')
        check('with an entry today, opens at Mon 5 Oct (at the top, or as far as the page scrolls)', t and t['date'] == '2026-10-05' and (abs(t['gap']) <= 14 or at_bottom), (t, at_bottom))

        # switching tab opens that account at today too (Nationwide only has its opening day → top)
        pg.click('.tab:nth-child(2)'); pg.wait_for_timeout(300)
        check('other account with nothing since opening → its Brought forward day', top_day(pg)['date'] == '2026-10-01')

        # ---- desktop grid shows the numbers too
        desk = ctx.new_page(); watch(desk, 'desktop')
        desk.clock.install(time=datetime.datetime(2026, 10, 5, 12, 0, 0))
        desk.set_viewport_size({'width': 1440, 'height': 900})
        desk.goto(URL); desk.wait_for_selector('.grid')
        g = descs(desk, '.grid tbody td.c-desc')
        check('grid: confirmed (2 of 12) and projected (3 of 12)', any(d.endswith('Car loan (2 of 12)') for d in g) and any(d.endswith('Car loan (3 of 12)') for d in g), [d for d in g if 'loan' in d][:3])
        desk.screenshot(path=f'{OUT}/v6-3-grid.png')
        b.close()
finally:
    server.terminate()

print('\nerrors:', errors)
failed = [c for c in checks if not c[1]]
print(f'{len(checks) - len(failed)}/{len(checks)} checks passed')
sys.exit(1 if failed or errors else 0)
