"""v0.15.21 — "weekday of the month" rule for recurring items.
People's Postcode Lottery: first Friday on or after the 4th; plus "last Friday of the month".
Editor choices and defaults, preview, manager line, feed dates, a one-off date (7 Dec 2026),
confirm, and switching back to a fixed day. Clock fixed at Fri 6 Nov 2026.
Run: python3 dev/e2e/weekday_rule_v01521.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8790)
errors, checks = [], []
D = '#recurringEditDialog'
FREQ = f'{D} .field-pair >> nth=1 >> select'
MODE = f'{D} .field-pair >> nth=1 >> select >> nth=1'
SHIFT = f'{D} label.field:has-text("weekend or bank holiday") select'

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
        pg.clock.install(time=datetime.datetime(2026, 11, 6, 7, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        fill_setup(pg, ['3600', '6', '1000'])
        pg.fill('.setup-form input[type=date]', '2026-11-01')
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')

        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog .settings-item[data-page=recurring]'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog .btn-primary'); pg.wait_for_selector(f'{D}[open]')
        check('new item: "On" defaults to a day of the month', pg.input_value(MODE) == 'date')
        check('day of month box shown, weekday hidden', pg.is_visible(f'{D} input[placeholder="1–31"]') and not pg.is_visible(f'{D} input[placeholder="1–28"]'))
        pg.fill(f'{D} input[placeholder="e.g. Netflix"]', 'Postcode Lottery')
        pg.fill(f'{D} input[placeholder="0.00"]', '12.50')
        check('shift starts as "on that day"', pg.input_value(SHIFT) == 'none')
        pg.select_option(MODE, value='first')
        check('weekday mode: day box hidden, weekday and on-or-after shown',
              not pg.is_visible(f'{D} input[placeholder="1–31"]') and pg.is_visible(f'{D} input[placeholder="1–28"]'))
        check('choosing a weekday sets the next working day', pg.input_value(SHIFT) == 'after')
        pg.select_option(f'{D} label.field:has(> span:text-is("Weekday")) select', value='5')
        pg.fill(f'{D} input[placeholder="1–28"]', '4')
        pg.fill(f'{D} input[type=date] >> nth=0', '2026-11-01')
        prev = norm(pg.text_content(f'{D} .rec-preview'))
        check('preview: 6 Nov, 4 Dec, 8 Jan', 'Fri 6 Nov 2026' in prev and 'Fri 4 Dec 2026' in prev and 'Fri 8 Jan 2027' in prev, prev)
        pg.fill(f'{D} input[placeholder="1–28"]', '30')
        prev = norm(pg.text_content(f'{D} .rec-preview'))
        check('preview explains a bad on-or-after day', 'must be 1 to 28' in prev, prev)
        pg.click(f'{D} button[type=submit]'); pg.wait_for_timeout(400)
        check('bad day not saved', pg.is_visible(f'{D}[open]'))
        pg.fill(f'{D} input[placeholder="1–28"]', '4')
        pg.screenshot(path=f'{OUT}/wr1-editor-ppl.png')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item added')
        mt = norm(pg.text_content('#recurringDialog'))
        check('manager: Monthly · first Friday on or after the 4th · next working day',
              'Monthly · first Friday on or after the 4th · next working day' in mt, mt)

        pg.click('#recurringDialog .rec-row:has-text("Postcode Lottery")'); pg.wait_for_selector(f'{D}[open]')
        check('reopens as first-on-or-after, Friday, 4',
              pg.input_value(MODE) == 'first' and pg.input_value(f'{D} label.field:has(> span:text-is("Weekday")) select') == '5'
              and pg.input_value(f'{D} input[placeholder="1–28"]') == '4')
        pg.click(f'{D} .icon-btn')

        # last Friday of the month
        pg.click('#recurringDialog .btn-primary'); pg.wait_for_selector(f'{D}[open]')
        pg.fill(f'{D} input[placeholder="e.g. Netflix"]', 'Gym')
        pg.fill(f'{D} input[placeholder="0.00"]', '20')
        pg.select_option(MODE, value='last')
        check('last: no on-or-after box', not pg.is_visible(f'{D} input[placeholder="1–28"]') and pg.is_visible(f'{D} label.field:has(> span:text-is("Weekday")) select'))
        pg.select_option(f'{D} label.field:has(> span:text-is("Weekday")) select', value='5')
        pg.select_option(SHIFT, value='none')
        pg.fill(f'{D} input[type=date] >> nth=0', '2026-11-01')
        prev = norm(pg.text_content(f'{D} .rec-preview'))
        check('preview: 27 Nov, 25 Dec, 29 Jan', 'Fri 27 Nov 2026' in prev and 'Fri 25 Dec 2026' in prev and 'Fri 29 Jan 2027' in prev, prev)
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item added')
        mt = norm(pg.text_content('#recurringDialog'))
        check('manager: Monthly · last Friday of the month', 'Monthly · last Friday of the month' in mt, mt)
        pg.screenshot(path=f'{OUT}/wr2-manager.png')
        pg.click('#recurringDialog .icon-btn'); close_settings(pg)

        def feed(name):
            # day headers (li.day) are siblings: walk back from each entry to its header
            return pg.evaluate('''n => [...document.querySelectorAll(".feed .entry.projected")].filter(e => e.innerText.includes(n) && !e.innerText.includes("skipped")).map(e => {
                let li = e.closest("li"); while (li && !li.matches("li.day")) li = li.previousElementSibling; return li?.dataset.date; })''', name)
        f = feed('Postcode Lottery')
        check('feed: PPL on 6 Nov, 4 Dec, 8 Jan, 5 Feb', f[:4] == ['2026-11-06', '2026-12-04', '2027-01-08', '2027-02-05'], f)

        # December 2026: move to Mon 7 Dec (PPL's published date)
        pg.click('.feed .entry.projected:has-text("Postcode Lottery") >> nth=1'); pg.wait_for_selector('#txDialog[open]')
        pg.fill('#txDialog input[type=date]', '2026-12-07')
        pg.click('#txDialog button:has-text("this month only")'); saved(pg, '')
        pg.wait_for_timeout(300)
        f = feed('Postcode Lottery')
        check('one-off: Dec 2026 now on 7 Dec, Jan still 8 Jan', f[:3] == ['2026-11-06', '2026-12-07', '2027-01-08'], f)

        # confirm November
        pg.click('.feed .entry.projected:has-text("Postcode Lottery") >> nth=0'); pg.wait_for_selector('#txDialog[open]')
        pg.click('#txDialog button:has-text("Confirm")'); saved(pg, 'Confirmed')
        f = feed('Postcode Lottery')
        check('after confirming Nov: Dec 7 is next', f[0] == '2026-12-07', f)

        # with a confirmed month, switching back to a fixed day is allowed (both keyed by month)
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog .settings-item[data-page=recurring]'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog .rec-row:has-text("Postcode Lottery")'); pg.wait_for_selector(f'{D}[open]')
        pg.select_option(MODE, value='date')
        pg.fill(f'{D} input[placeholder="1–31"]', '6')
        prev = pg.text_content(f'{D} .rec-preview') or ''
        check('no lock message', 'already has confirmed entries' not in prev, prev)
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item updated')
        mt = norm(pg.text_content('#recurringDialog'))
        check('manager: Monthly on the 6th', 'Monthly on the 6th' in mt, mt)
        b.close()
finally:
    server.terminate()

print(f'\n{sum(ok for _, ok in checks)}/{len(checks)} checks passed; {len(errors)} errors')
for e in errors: print('  ERR', e)
sys.exit(0 if all(ok for _, ok in checks) and not errors else 1)
