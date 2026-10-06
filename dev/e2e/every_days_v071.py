"""v0.7.1 — "Every so many days" frequency (e.g. a 90-day subscription).
Editor fields, the 31-day minimum, preview, manager line, editing back, phone feed.
Clock fixed at Tue 6 Oct 2026. Run: python3 dev/e2e/every_days_v071.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8771)
errors, checks = [], []
D = '#recurringEditDialog'

def norm(t): return (t or '').replace(',', '')
def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def saved(pg, text):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=5000)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
        pg = ctx.new_page()
        pg.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and 'gov.uk' not in m.text and errors.append(m.text))
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
        pg.clock.install(time=datetime.datetime(2026, 10, 6, 12, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')

        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog .btn-primary'); pg.wait_for_selector(f'{D}[open]')
        pg.fill(f'{D} input[placeholder="e.g. Netflix"]', 'Subscription')
        pg.fill(f'{D} input[placeholder="0.00"]', '12.99')
        days = f'{D} input[type=number]'
        check('days field hidden for monthly', not pg.is_visible(days))
        pg.select_option(f'{D} .field-pair >> nth=1 >> select', value='d')
        check('days field shown, default 90', pg.is_visible(days) and pg.input_value(days) == '90')
        check('day-of-month field hidden', not pg.is_visible(f'{D} input[placeholder="1–31"]'))
        check('min/max on the field', pg.get_attribute(days, 'min') == '31' and pg.get_attribute(days, 'max') == '366')
        check('start hint explains first payment', 'first payment' in pg.text_content(D))
        pg.fill(f'{D} input[type=date] >> nth=0', '2026-10-15')

        pg.fill(days, '30')
        check('30 days: preview says 31 to 366', '31 to 366' in pg.text_content(f'{D} .rec-preview'))
        pg.click(f'{D} button[type=submit]'); pg.wait_for_timeout(400)
        check('30 days: not saved (dialog still open)', pg.is_visible(f'{D}[open]'))
        check('nothing added', pg.evaluate('() => document.querySelectorAll("#recurringDialog .rec-row").length') == 0)

        pg.fill(days, '90')
        prev = norm(pg.text_content(f'{D} .rec-preview'))
        check('preview: 15 Oct, 13 Jan, 13 Apr', 'Thu 15 Oct 2026' in prev and 'Wed 13 Jan 2027' in prev and 'Tue 13 Apr 2027' in prev, prev)
        pg.screenshot(path=f'{OUT}/d1-editor-90-days.png')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item added')
        mt = norm(pg.text_content('#recurringDialog'))
        check('manager: Every 90 days from 15 Oct 2026', 'Every 90 days from 15 Oct 2026' in mt, mt)
        pg.screenshot(path=f'{OUT}/d2-manager.png')

        # reopen: comes back as every-so-many-days, 90
        pg.click('#recurringDialog .rec-row >> nth=0'); pg.wait_for_selector(f'{D}[open]')
        check('reopens as every N days = 90', pg.input_value(f'{D} .field-pair >> nth=1 >> select') == 'd' and pg.input_value(days) == '90')
        # a half-typed hidden value mustn't block switching back to monthly
        pg.fill(days, '5')
        pg.select_option(f'{D} .field-pair >> nth=1 >> select', value='1')
        pg.fill(f'{D} input[placeholder="1–31"]', '15')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item updated')
        mt = norm(pg.text_content('#recurringDialog'))
        check('switched to monthly on the 15th', 'Monthly on the 15th' in mt, mt)
        # and back to 90 days
        pg.click('#recurringDialog .rec-row >> nth=0'); pg.wait_for_selector(f'{D}[open]')
        pg.select_option(f'{D} .field-pair >> nth=1 >> select', value='d')
        pg.fill(days, '90')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item updated')
        pg.click('#recurringDialog .icon-btn'); pg.click('#settingsDialog .icon-btn')

        feed = pg.evaluate('() => [...document.querySelectorAll(".feed .entry.projected")].map(e => e.innerText.replace(/\\s+/g," "))')
        days_in_feed = pg.evaluate('() => [...document.querySelectorAll(".feed .day")].map(e => e.textContent)')
        check('phone feed: 2 projected (15 Oct, 13 Jan) within 3 months', len(feed) == 2, feed)
        check('13 Jan 2027 is a day heading', any('13 Jan 2027' in norm(d) for d in days_in_feed), days_in_feed)
        pg.screenshot(path=f'{OUT}/d3-feed.png', full_page=True)
        b.close()
finally:
    server.terminate()

print(f'\n{sum(ok for _, ok in checks)}/{len(checks)} checks passed; {len(errors)} errors')
for e in errors: print('  ERR', e)
sys.exit(0 if all(ok for _, ok in checks) and not errors else 1)
