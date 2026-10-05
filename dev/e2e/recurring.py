"""Recurring items end to end: add items in the manager, projected rows on the
phone and in the desktop grid, confirm / skip / change one month, show more,
un-confirm by deleting, gov.uk bank-holiday fetch. The clock is fixed at
Mon 5 Oct 2026 so dates are predictable.
Run: python3 dev/e2e/recurring.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8767)
errors = []
checks = []
govuk_calls = []

def norm(text):
    return (text or '').replace(',', '')  # Chromium writes "Wed, 28 Oct 2026"

def check(label, ok, detail=''):
    checks.append((label, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))

def watch(page, label):
    page.on('console', lambda m: m.type == 'error' and 'ERR_TUNNEL' not in m.text and errors.append(f'{label} console: {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    page.on('dialog', lambda d: d.accept())

GOVUK = {'england-and-wales': {'division': 'england-and-wales', 'events': [
    {'title': t, 'date': d} for t, d in [
        ('New Year’s Day', '2026-01-01'), ('Good Friday', '2026-04-03'), ('Easter Monday', '2026-04-06'),
        ('Early May bank holiday', '2026-05-04'), ('Spring bank holiday', '2026-05-25'), ('Summer bank holiday', '2026-08-31'),
        ('Christmas Day', '2026-12-25'), ('Boxing Day', '2026-12-28'), ('New Year’s Day', '2027-01-01')]]}}

def govuk(route, request):
    govuk_calls.append(request.url)
    route.fulfill(status=200, body=json.dumps(GOVUK), content_type='application/json',
                  headers={'access-control-allow-origin': '*'})

def add_item(pg, desc, kind, amount, day, start, shift='none', freq='1', to=None):
    pg.click('#recurringDialog .btn-primary')  # + Add recurring item
    pg.wait_for_selector('#recurringEditDialog[open]')
    d = '#recurringEditDialog'
    pg.fill(f'{d} input[placeholder="e.g. Netflix"]', desc)
    pg.click(f'{d} .seg-btn[data-value="{kind}"]')
    if to:
        pg.select_option(f'{d} .field-pair select >> nth=1', label=to)
    pg.fill(f'{d} input[placeholder="0.00"]', amount)
    pg.select_option(f'{d} .field-pair >> nth=1 >> select', value=freq)
    pg.fill(f'{d} input[placeholder="1–31"]', str(day))
    pg.fill(f'{d} input[type=date] >> nth=0', start)
    pg.select_option(f'{d} select >> nth=-1', value=shift)
    preview = norm(pg.text_content(f'{d} .rec-preview'))
    pg.click(f'{d} button[type=submit]')
    pg.wait_for_selector(f'{d}[open]', state='detached')
    saved(pg, 'Recurring item added')
    return preview

def saved(page, text):
    """commit() closes the dialog first, then saves and redraws — wait for its toast."""
    page.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=5000)

def feed_rows(pg):
    return pg.evaluate('''() => [...document.querySelectorAll('.feed .entry')].map(e => ({
        cls: e.className.replace(/\\s+/g, ' ').trim(), text: e.innerText.replace(/\\s+/g, ' ').trim() }))''')

def open_projected(pg, text):
    pg.click(f'.feed .entry.projected:has-text("{text}") >> nth=0')  # feed is oldest-first (v0.6): first = earliest
    pg.wait_for_selector('#txDialog[open]')

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True,
                            user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36')
        ctx.route('https://www.gov.uk/bank-holidays.json', govuk)
        pg = ctx.new_page(); watch(pg, 'phone')
        pg.clock.install(time=datetime.datetime(2026, 10, 5, 12, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']):
            el.fill(v)
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]')
        pg.wait_for_selector('.feed')
        check('gov.uk bank holidays fetched once', len(govuk_calls) == 1, govuk_calls)

        # ---- manager
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")')
        pg.wait_for_selector('#recurringDialog[open]')
        check('manager says gov.uk list in use', 'gov.uk list' in pg.text_content('#recurringDialog'))
        pg.screenshot(path=f'{OUT}/r1-manager-empty.png')

        # take a look at the editor before filling in
        pg.click('#recurringDialog .btn-primary'); pg.wait_for_selector('#recurringEditDialog[open]')
        pg.fill('#recurringEditDialog input[placeholder="e.g. Netflix"]', 'Salary')
        pg.click('#recurringEditDialog .seg-btn[data-value="in"]')
        pg.fill('#recurringEditDialog input[placeholder="0.00"]', '4000')
        pg.fill('#recurringEditDialog input[placeholder="1–31"]', '28')
        pg.select_option('#recurringEditDialog select >> nth=-1', value='before')
        pg.screenshot(path=f'{OUT}/r2-editor-salary.png')
        preview = norm(pg.text_content('#recurringEditDialog .rec-preview'))
        check('salary preview: 28 Oct, 27 Nov, 24 Dec', 'Wed 28 Oct 2026' in preview and 'Fri 27 Nov 2026' in preview and 'Thu 24 Dec 2026' in preview, preview)
        pg.fill('#recurringEditDialog input[type=date] >> nth=0', '2026-10-01')
        pg.click('#recurringEditDialog button[type=submit]')
        pg.wait_for_selector('#recurringEditDialog[open]', state='detached')
        saved(pg, 'Recurring item added')

        prev = add_item(pg, 'Netflix', 'out', '5.99', 4, '2026-10-01')
        check('netflix preview starts in November (4 Oct already past)', prev.startswith('Next: Wed 4 Nov 2026'), prev)
        prev = add_item(pg, 'Barclaycard direct debit', 'transfer', '500', 15, '2026-10-01', shift='after', to='Barclaycard')
        check('direct debit preview: Thu 15 Oct, Mon 16 Nov', 'Thu 15 Oct 2026' in prev and 'Mon 16 Nov 2026' in prev, prev)
        add_item(pg, 'TV subscription', 'out', '80', 25, '2027-02-01', freq='n')  # every 6 months (default N)
        rows = pg.query_selector_all('#recurringDialog .rec-row')
        check('manager lists 4 items', len(rows) == 4, len(rows))
        manager_text = norm(pg.text_content('#recurringDialog'))
        check('TV subscription every 6 months, next 25 Feb 2027', 'Every 6 months on the 25th' in manager_text and 'Thu 25 Feb 2027' in manager_text, manager_text)
        pg.screenshot(path=f'{OUT}/r3-manager.png')
        pg.click('#recurringDialog .icon-btn'); pg.click('#settingsDialog .icon-btn')

        # ---- phone feed
        rows = feed_rows(pg)
        proj = [r for r in rows if 'projected' in r['cls']]
        overdue = [r for r in rows if 'overdue' in r['cls']]
        check('projected rows to end of Jan (4 salary, 4 netflix incl. overdue Oct, 4 card payments)', len(proj) == 12, len(proj))
        check('October Netflix is amber (not confirmed yet)', len(overdue) == 1 and 'Netflix' in overdue[0]['text'], overdue)
        banner = pg.text_content('.banner')
        check('today balance excludes projections', '£3,600.00' in banner, banner)
        check('end of Oct includes projections (3600+4000−5.99−500)', '£7,094.01 at end of Oct 2026' in banner, banner)
        check('show more control visible', pg.is_visible('.horizon-list button'))
        pg.screenshot(path=f'{OUT}/r4-phone-feed.png', full_page=True)

        # ---- confirm the overdue Netflix with a different amount
        open_projected(pg, 'Netflix')
        check('occurrence dialog says not confirmed yet', 'not confirmed yet' in pg.text_content('#txDialog'))
        pg.screenshot(path=f'{OUT}/r5-confirm-dialog.png')
        pg.fill('#txDialog .amount-input', '6.49')
        pg.click('#txDialog button:has-text("Confirm")')
        pg.wait_for_selector('#txDialog[open]', state='detached')
        saved(pg, 'Confirmed')
        banner = pg.text_content('.banner')
        check('confirmed: today balance now 3593.51', '£3,593.51' in banner, banner)
        rows = feed_rows(pg)
        check('no amber rows left', not [r for r in rows if 'overdue' in r['cls']])

        # ---- skip November salary
        pg.click('.feed .entry.projected:has-text("Salary") >> nth=0')  # oldest-first: Oct
        pg.wait_for_selector('#txDialog[open]')
        oct_text = pg.text_content('#txDialog')
        pg.click('#txDialog .icon-btn')
        check('earliest salary is 28 Oct', '28 Oct' in oct_text, oct_text[:120])
        pg.click('.feed .entry.projected:has-text("Salary") >> nth=1')  # November
        pg.wait_for_selector('#txDialog[open]')
        pg.click('#txDialog button:has-text("Skip this month")')
        pg.wait_for_selector('#txDialog[open]', state='detached')
        saved(pg, 'Skipped')
        skipped = [r for r in feed_rows(pg) if 'skipped' in r['cls']]
        check('November salary shown as skipped', len(skipped) == 1 and 'Salary' in skipped[0]['text'] and 'skipped' in skipped[0]['text'], skipped)

        # ---- change December salary date for this month only
        pg.click('.feed .entry.projected:has-text("Salary") >> nth=2')  # December
        pg.wait_for_selector('#txDialog[open]')
        check('December salary projected for Thu 24 Dec', 'Thu 24 Dec 2026' in norm(pg.text_content('#txDialog')))
        pg.fill('#txDialog input[type=date]', '2026-12-18')
        pg.click('#txDialog button:has-text("Save for this month only")')
        pg.wait_for_selector('#txDialog[open]', state='detached')
        saved(pg, 'only')
        dec_day = pg.evaluate('''() => [...document.querySelectorAll('.feed .day')].map(d => d.textContent)''')
        check('a Fri 18 Dec day appears', any('Fri 18 Dec 2026' in norm(d) for d in dec_day))
        pg.click('.feed .entry.projected:has-text("Salary") >> nth=2')
        pg.wait_for_selector('#txDialog[open]')
        check('dialog notes the change from the series', 'Changed for this month' in pg.text_content('#txDialog'))
        pg.click('#txDialog .icon-btn')

        # ---- show more
        pg.click('.horizon-list button')
        check('horizon extended to 30 Apr 2027', 'Fri 30 Apr 2027' in norm(pg.text_content('.horizon-list')))
        for _ in range(3):
            if pg.is_visible('.horizon-list button'):
                pg.click('.horizon-list button')
        check('capped at 12 months (31 Oct 2027), no more button', 'Sun 31 Oct 2027' in norm(pg.text_content('.horizon-list')) and not pg.is_visible('.horizon-list button'))

        # ---- Barclaycard tab shows the payment arriving
        pg.click('.tab:has-text("Barclaycard")')
        rows = feed_rows(pg)
        check('Barclaycard tab: projected payments from Current Account', any('Current Account' in r['text'] and 'projected' in r['cls'] for r in rows))
        pg.screenshot(path=f'{OUT}/r6-phone-barclaycard.png')
        pg.click('.tab:has-text("Current Account")')

        # ---- the confirmed Netflix shows where it came from; deleting it brings the projection back
        pg.click('.feed .entry:not(.projected):has-text("Netflix")')
        pg.wait_for_selector('#txDialog[open]')
        check('confirmed entry says it came from the recurring item', 'Confirmed entry of “Netflix”' in pg.text_content('#txDialog'))
        pg.click('#txDialog .btn-danger')
        pg.wait_for_selector('#txDialog[open]', state='detached')
        saved(pg, 'Deleted')
        check('deleted → October Netflix amber again', any('overdue' in r['cls'] and 'Netflix' in r['text'] for r in feed_rows(pg)))

        # ---- desktop grid (same browser profile, so same data)
        desk = ctx.new_page(); watch(desk, 'desktop')
        desk.clock.install(time=datetime.datetime(2026, 10, 5, 12, 0, 0))
        desk.set_viewport_size({'width': 1440, 'height': 900})
        desk.goto(URL)
        if not desk.query_selector('.grid'):
            desk.click('#viewBtn')
        desk.wait_for_selector('.grid')
        g = desk.evaluate('''() => ({
            projected: document.querySelectorAll('.grid tr.projected').length,
            overdue: document.querySelectorAll('.grid tr.projected.overdue').length,
            skipped: document.querySelectorAll('.grid tr.projected.skipped').length,
            more: Boolean(document.querySelector('.row-more button')),
            moreText: document.querySelector('.row-more')?.textContent,
            scrollTop: document.querySelector('.grid-wrap').scrollTop,
            scrollMax: document.querySelector('.grid-wrap').scrollHeight - document.querySelector('.grid-wrap').clientHeight,
        })''')
        check('grid shows projected rows (3 months again on a fresh open)', g['projected'] > 0 and 'Sun 31 Jan 2027' in norm(g['moreText']), g)
        check('grid: one amber, one skipped', g['overdue'] == 1 and g['skipped'] == 1, g)
        desk.screenshot(path=f'{OUT}/r7-desktop-grid.png')
        desk.click('.grid tr.projected:has-text("Barclaycard direct debit") >> nth=0 >> td.c-desc')
        desk.wait_for_selector('#txDialog[open]')
        check('grid: clicking a projected row opens the confirm dialog', 'Confirm' in desk.text_content('#txDialog'))
        desk.screenshot(path=f'{OUT}/r8-desktop-confirm.png')
        desk.fill('#txDialog input[type=date]', '2026-10-05')  # say it went early, today
        desk.click('#txDialog button:has-text("Confirm")')
        desk.wait_for_selector('#txDialog[open]', state='detached')
        saved(desk, 'Confirmed')
        heads = desk.eval_on_selector_all('.acc-total', 'els => els.map(e => e.textContent)')
        check('confirmed card payment today: current 3100, Barclaycard owed 500', heads[0] == '£3,100.00' and heads[2] == 'Owed £500.00', heads)
        dd = desk.evaluate('''() => [...document.querySelectorAll('.grid tbody tr')].filter(r => r.textContent.includes('Barclaycard direct debit')).map(r => r.className.includes('projected'))''')
        check('one real card payment row, three still projected', dd.count(False) == 1 and dd.count(True) == 3, dd)

        # ---- edit the series (amount) from the grid: unconfirmed months follow
        desk.click('.grid tr.projected:has-text("Netflix") >> nth=-1 >> td.c-desc')
        desk.wait_for_selector('#txDialog[open]')
        desk.click('#txDialog button:has-text("Edit series")')
        desk.wait_for_selector('#recurringEditDialog[open]')
        desk.fill('#recurringEditDialog input[placeholder="0.00"]', '6.99')
        desk.click('#recurringEditDialog button[type=submit]')
        desk.wait_for_selector('#recurringEditDialog[open]', state='detached')
        saved(desk, 'Recurring item updated')
        amounts = desk.evaluate('''() => [...document.querySelectorAll('.grid tr.projected')].filter(r => r.textContent.includes('Netflix')).map(r => [...r.querySelectorAll('td.cell')].map(c => c.textContent).filter(Boolean).join())''')
        check('all Netflix projections now 6.99', amounts and all(a == '6.99' for a in amounts), amounts)

        # ---- reload: everything persisted
        desk.reload(); desk.wait_for_selector('.grid')
        n = desk.evaluate("() => document.querySelectorAll('.grid tr.projected').length")
        check('after reload projected rows still there', n > 0, n)
        b.close()
finally:
    server.terminate()

print('\nerrors:', errors)
failed = [c for c in checks if not c[1]]
print(f'{len(checks) - len(failed)}/{len(checks)} checks passed')
sys.exit(1 if failed or errors else 0)
