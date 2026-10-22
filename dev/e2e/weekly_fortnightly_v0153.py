"""v0.15.3 — Weekly and Fortnightly repeats (stored as every 7 / 14 days, keyed by date).
Editor choices, preview, manager line, several entries in one month on the phone feed,
confirming / skipping one date only. Clock fixed at Tue 6 Oct 2026.
Run: python3 dev/e2e/weekly_fortnightly_v0153.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8773)
errors, checks = [], []
D = '#recurringEditDialog'
FREQ = f'{D} .field-pair >> nth=1 >> select'

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
        fill_setup(pg, ['3600', '6', '1000'])
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')

        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog .btn-primary'); pg.wait_for_selector(f'{D}[open]')
        opts = pg.eval_on_selector(FREQ, 'e => [...e.options].map(o => o.textContent)')
        check('choices: Weekly, Fortnightly first, then the rest', opts == ['Weekly', 'Fortnightly', 'Monthly', 'Every few months', 'Yearly', 'Every so many days'], opts)
        pg.fill(f'{D} input[placeholder="e.g. Netflix"]', 'Bin cleaning')
        pg.fill(f'{D} input[placeholder="0.00"]', '8')
        pg.select_option(FREQ, value='f')
        check('fortnightly: no day-of-month, no days box', not pg.is_visible(f'{D} input[placeholder="1–31"]') and not pg.is_visible(f'{D} input[type=number]'))
        check('fortnightly: start hint mentions every two weeks', 'every two weeks' in pg.text_content(D))
        pg.fill(f'{D} input[type=date] >> nth=0', '2026-10-23')
        prev = norm(pg.text_content(f'{D} .rec-preview'))
        check('preview: 23 Oct, 6 Nov, 20 Nov', 'Fri 23 Oct 2026' in prev and 'Fri 6 Nov 2026' in prev and 'Fri 20 Nov 2026' in prev, prev)
        pg.screenshot(path=f'{OUT}/wf1-editor-fortnightly.png')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item added')
        mt = norm(pg.text_content('#recurringDialog'))
        check('manager: Fortnightly on Fridays from 23 Oct 2026', 'Fortnightly on Fridays from 23 Oct 2026' in mt, mt)

        pg.click('#recurringDialog .rec-row >> nth=0'); pg.wait_for_selector(f'{D}[open]')
        check('reopens as Fortnightly', pg.input_value(FREQ) == 'f')
        pg.click(f'{D} .icon-btn')

        # a weekly one too
        pg.click('#recurringDialog .btn-primary'); pg.wait_for_selector(f'{D}[open]')
        pg.fill(f'{D} input[placeholder="e.g. Netflix"]', 'Window cleaner')
        pg.fill(f'{D} input[placeholder="0.00"]', '5')
        pg.select_option(FREQ, value='w')
        pg.fill(f'{D} input[type=date] >> nth=0', '2026-10-10')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item added')
        mt = norm(pg.text_content('#recurringDialog'))
        check('manager: Weekly on Saturdays from 10 Oct 2026', 'Weekly on Saturdays from 10 Oct 2026' in mt, mt)
        pg.screenshot(path=f'{OUT}/wf2-manager.png')
        pg.click('#recurringDialog .icon-btn'); pg.click('#settingsDialog .icon-btn')

        def feed():
            return pg.evaluate('() => [...document.querySelectorAll(".feed .entry.projected")].map(e => e.innerText.replace(/\\s+/g," "))')
        f = feed()
        bins = [x for x in f if 'Bin cleaning' in x]
        win = [x for x in f if 'Window cleaner' in x]
        # 3-month horizon from 6 Oct → end of Jan 2027
        check('feed: 8 fortnightly entries to end of Jan', len(bins) == 8, len(bins))
        check('feed: 17 weekly entries to end of Jan', len(win) == 17, len(win))
        pg.screenshot(path=f'{OUT}/wf3-feed.png', full_page=True)

        # skip the 6 Nov bin cleaning only
        pg.click('.feed .entry.projected:has-text("Bin cleaning") >> nth=1'); pg.wait_for_selector('#txDialog[open]')
        txt = pg.text_content('#txDialog')
        check('dialog: "Skip this one" (not "this month")', 'Skip this one' in txt and 'Skip this month' not in txt, txt[:200])
        pg.screenshot(path=f'{OUT}/wf4-occurrence.png')
        pg.click('#txDialog button:has-text("Skip this one")'); saved(pg, 'Skipped for')
        f = feed()
        bins = [x for x in f if 'Bin cleaning' in x]
        check('6 Nov skipped, 20 Nov still projected', len(bins) == 8 and 'skipped' in bins[1] and 'skipped' not in bins[2], bins[:3])

        # confirm the 23 Oct one
        pg.click('.feed .entry.projected:has-text("Bin cleaning") >> nth=0'); pg.wait_for_selector('#txDialog[open]')
        pg.click('#txDialog button:has-text("Confirm")'); saved(pg, 'Confirmed')
        bins = [x for x in feed() if 'Bin cleaning' in x]
        check('after confirming 23 Oct: 7 projected left', len(bins) == 7, len(bins))

        # with a confirmed entry, switching to Monthly is refused with an explanation
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog .rec-row:has-text("Bin cleaning")'); pg.wait_for_selector(f'{D}[open]')
        pg.select_option(FREQ, value='1')
        pg.fill(f'{D} input[placeholder="1–31"]', '23')
        prev = pg.text_content(f'{D} .rec-preview') or ''
        check('editor explains: already has confirmed entries', 'already has confirmed entries' in prev, prev)
        pg.screenshot(path=f'{OUT}/wf5-locked.png')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_timeout(500)
        check('not saved (dialog still open)', pg.is_visible(f'{D}[open]'))
        pg.click(f'{D} .icon-btn')
        mt = norm(pg.text_content('#recurringDialog'))
        check('still Fortnightly', 'Fortnightly on Fridays from 23 Oct 2026' in mt, mt)
        # other edits still save
        pg.click('#recurringDialog .rec-row:has-text("Bin cleaning")'); pg.wait_for_selector(f'{D}[open]')
        pg.fill(f'{D} input[placeholder="0.00"]', '9')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item updated')
        check('amount change saved', '£9.00' in pg.text_content('#recurringDialog'))
        b.close()
finally:
    server.terminate()

print(f'\n{sum(ok for _, ok in checks)}/{len(checks)} checks passed; {len(errors)} errors')
for e in errors: print('  ERR', e)
sys.exit(0 if all(ok for _, ok in checks) and not errors else 1)
