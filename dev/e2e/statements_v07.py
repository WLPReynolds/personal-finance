"""v0.7 end to end: Barclaycard statement dates, statement rows, moving an
entry between statements, the statement-balance payment and paying less one
month. Clock fixed at Tue 6 Oct 2026.
Run: python3 dev/e2e/statements_v07.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8769)
errors = []
checks = []

def norm(text):
    return ' '.join((text or '').replace(',', '').split())

def check(label, ok, detail=''):
    checks.append((label, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))

def watch(page, label):
    page.on('console', lambda m: m.type == 'error' and 'ERR_TUNNEL' not in m.text and 'ERR_FAILED' not in m.text and errors.append(f'{label} console: {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    page.on('dialog', lambda d: d.accept())

def saved(page, text):
    page.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=5000)

def add_spend(pg, amount, desc, date, which=None):
    pg.click('#fab'); pg.wait_for_selector('#txDialog[open]')
    pg.fill('#txDialog .amount-input', amount)
    pg.fill('#txDialog input[placeholder="e.g. Lottery"]', desc)
    pg.fill('#txDialog input[type=date]', date)
    if which:
        pg.click(f'#txDialog .stmt-choice .seg-btn:has-text("{which}")')
    pg.click('#txDialog button[type=submit]')
    pg.wait_for_selector('#txDialog[open]', state='detached'); saved(pg, 'Added')

def feed_rows(pg):
    return pg.eval_on_selector_all('.feed .entry', 'els => els.map(e => e.textContent.replace(/\\s+/g, " ").replace(/,/g, "").trim())')

D = '#recurringEditDialog'
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
        pg = ctx.new_page(); watch(pg, 'phone')
        pg.clock.install(time=datetime.datetime(2026, 10, 6, 12, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']):
            el.fill(v)
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]')
        pg.wait_for_selector('.feed')

        # ---- card settings
        pg.click('.tab:nth-child(3)'); pg.wait_for_timeout(200)
        pg.click('.banner-edit'); pg.wait_for_selector('#accountDialog[open]')
        check('statement settings shown for a credit card', pg.is_visible('#accountDialog .stmt-settings'))
        pg.fill('#accountDialog input[placeholder="e.g. 13"]', '13')
        prev = norm(pg.text_content('#accountDialog .stmt-settings'))
        check('preview: next statement Mon 19 Oct, payment due Fri 13 Nov', 'Next statement Mon 19 Oct 2026 · payment due Fri 13 Nov 2026' in prev, prev[:160])
        pg.screenshot(path=f'{OUT}/v7-1-card-settings.png')
        pg.click('#accountDialog button[type=submit]'); saved(pg, 'Account updated')

        # ---- entries, one on the statement day carried to the next statement
        add_spend(pg, '50', 'Groceries', '2026-10-10')
        pg.click('#fab'); pg.wait_for_selector('#txDialog[open]')
        pg.fill('#txDialog input[type=date]', '2026-10-05')
        check('no statement choice away from a statement date', not pg.is_visible('#txDialog .stmt-choice'))
        pg.fill('#txDialog input[type=date]', '2026-10-19')
        check('statement choice offered on the statement date', pg.is_visible('#txDialog .stmt-choice') and 'Statement day' in pg.text_content('#txDialog .stmt-choice'))
        btns = pg.eval_on_selector_all('#txDialog .stmt-choice .seg-btn', 'els => els.map(e => e.textContent + "|" + e.getAttribute("aria-checked"))')
        check('options: This · 19 Oct (default) / Next · 18 Nov', btns == ['This · 19 Oct|true', 'Next · 18 Nov|false'], btns)
        pg.screenshot(path=f'{OUT}/v7-2-entry-choice.png')
        pg.click('#txDialog .icon-btn')
        add_spend(pg, '10', 'Amazon', '2026-10-19', which='Next')
        add_spend(pg, '20', 'Fuel', '2026-10-19')

        rows = feed_rows(pg)
        i_fuel = next(i for i, r in enumerate(rows) if r.startswith('Fuel'))
        i_stmt = next(i for i, r in enumerate(rows) if r.startswith('Statement'))
        i_amz = next(i for i, r in enumerate(rows) if r.startswith('Amazon'))
        check('order on 19 Oct: Fuel, statement row, then Amazon (carried)', i_fuel < i_stmt < i_amz, rows[i_fuel:i_amz + 1])
        check('statement row: £1070.00 owed, payment due Fri 13 Nov', '£1070.00' in rows[i_stmt] and 'Fri 13 Nov 2026' in rows[i_stmt], rows[i_stmt])
        check('carried entry tagged "on the 18 Nov statement"', 'on the 18 Nov statement' in rows[i_amz], rows[i_amz])

        # ---- statement payment as a recurring item
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog .btn-primary'); pg.wait_for_selector(f'{D}[open]')
        pg.fill(f'{D} input[placeholder="e.g. Netflix"]', 'Barclaycard direct debit')
        pg.click(f'{D} .seg-btn[data-value="transfer"]')
        sel = pg.query_selector_all(f'{D} select')
        sel[0].select_option(label='Current Account'); sel[1].select_option(label='Barclaycard')
        check('pay-statement tick offered for a card with statements', pg.is_visible(f'{D} input[type=checkbox]') and pg.is_enabled(f'{D} input[type=checkbox]'))
        pg.check(f'{D} input[type=checkbox]')
        check('day/repeat and weekend fields hidden; amount becomes an estimate',
              not pg.is_visible(f'{D} input[placeholder="1–31"]') and 'Estimate (£)' in pg.text_content(D))
        pg.fill(f'{D} input[placeholder="0.00"]', '600')
        pg.fill(f'{D} input[type=date] >> nth=0', '2026-10-01')
        prev = norm(pg.text_content(f'{D} .rec-preview'))
        check('preview: 12 Oct · 13 Nov · 14 Dec', prev == 'Next: Mon 12 Oct 2026 · Fri 13 Nov 2026 · Mon 14 Dec 2026', prev)
        pg.screenshot(path=f'{OUT}/v7-3-recurring-editor.png')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item added')
        mgr = norm(pg.text_content('#recurringDialog'))
        check('manager shows "statement" and the rule', 'Statement balance · 25 days after the statement' in mgr and 'statement' in mgr, mgr[:200])
        pg.click('#recurringDialog .icon-btn'); pg.click('#settingsDialog .icon-btn')

        rows = feed_rows(pg)
        dd = [r for r in rows if 'Barclaycard direct debit' in r]
        check('12 Oct payment: £600 estimate; 13 Nov: £470 (1000 − 600 + 50 + 20)', '+£600.00' in dd[0] and '+£470.00' in dd[1], dd[:2])
        banner = norm(pg.text_content('.banner-stmt'))
        check('banner: next payment £600 on 12 Oct, statement 19 Oct £470 so far', 'Next payment £600.00 on Mon 12 Oct' in banner and 'Statement Mon 19 Oct: £470.00 so far' in banner, banner)
        pg.screenshot(path=f'{OUT}/v7-4-phone-feed.png')

        # ---- statement dialog: move Amazon back onto this statement
        pg.click('.feed .entry-stmt >> nth=0'); pg.wait_for_selector('#txDialog[open]')
        t = norm(pg.text_content('#txDialog'))
        check('statement dialog: £470 owed, payment £470 on 13 Nov', '£470.00' in t and '£470.00 on Fri 13 Nov 2026' in t, t[:200])
        rows_near = pg.eval_on_selector_all('#txDialog .stmt-row', 'els => els.map(e => e.innerText.replace(/\\s+/g, " "))')
        check('both 19 Oct entries listed with This/Next', len(rows_near) == 2, rows_near)
        pg.screenshot(path=f'{OUT}/v7-5-statement-dialog.png')
        pg.click('#txDialog .stmt-row:has-text("Amazon") .seg-btn:has-text("This")'); saved(pg, 'Moved to the 19 Oct statement')
        t = norm(pg.text_content('#txDialog'))
        check('after moving: £480 owed and payment £480', '£480.00 on Fri 13 Nov 2026' in t, t[:200])

        # ---- pay less this month
        pg.click('#txDialog button:has-text("Change or confirm the payment")')
        pg.wait_for_selector('#txDialog .stmt-info')
        info = norm(pg.text_content('#txDialog .stmt-info'))
        check('payment dialog says which statement it pays', 'Pays the Mon 19 Oct 2026 statement: £480.00 owed' in info, info)
        pg.fill('#txDialog .amount-input', '300')
        pg.click('#txDialog button:has-text("Save for this month only")')
        pg.wait_for_selector('#txDialog[open]', state='detached'); saved(pg, 'Changed for Nov 2026 only')
        rows = feed_rows(pg)
        dd = [r for r in rows if 'Barclaycard direct debit' in r]
        check('Nov payment £300; Dec pays the £180 left', '+£300.00' in dd[1] and '+£180.00' in dd[2], dd[:3])

        # ---- the October payment pays a statement from before the records
        pg.click('.feed .entry.projected:has-text("Barclaycard direct debit") >> nth=0'); pg.wait_for_selector('#txDialog .stmt-info')
        check('Oct payment: statement from before the records → estimate', 'before your records start' in pg.text_content('#txDialog .stmt-info'))
        pg.click('#txDialog .icon-btn')

        # ---- edit the moved entry: choice remembered
        pg.click('.feed .entry:has-text("Amazon")'); pg.wait_for_selector('#txDialog[open]')
        btns = pg.eval_on_selector_all('#txDialog .stmt-choice .seg-btn', 'els => els.map(e => e.getAttribute("aria-checked"))')
        check('edit dialog shows the current choice (This)', btns == ['true', 'false'], btns)
        pg.click('#txDialog .stmt-choice .seg-btn:has-text("Next")')
        pg.click('#txDialog button[type=submit]'); pg.wait_for_selector('#txDialog[open]', state='detached'); saved(pg, 'Updated')
        check('moved back to next via the edit dialog', 'on the 18 Nov statement' in ' '.join(r for r in feed_rows(pg) if r.startswith('Amazon')))

        # ---- desktop grid
        desk = ctx.new_page(); watch(desk, 'desktop')
        desk.clock.install(time=datetime.datetime(2026, 10, 6, 12, 0, 0))
        desk.set_viewport_size({'width': 1440, 'height': 900})
        desk.goto(URL); desk.wait_for_selector('.grid')
        stmt_rows = desk.eval_on_selector_all('.grid tr.row-stmt', 'els => els.map(e => e.textContent.replace(/\\s+/g, " ").replace(/,/g, ""))')
        check('grid has statement rows (19 Oct £470 owed)', any('Barclaycard statement' in r and '470.00 owed' in r for r in stmt_rows), stmt_rows[:2])
        check('grid statement text shown in upper case', desk.eval_on_selector('.grid tr.row-stmt td.c-desc', 'e => getComputedStyle(e).textTransform') == 'uppercase')
        bg = desk.eval_on_selector('.grid tr.row-stmt td.c-desc', 'e => getComputedStyle(e).backgroundColor')
        plain = desk.eval_on_selector('.grid tbody tr:not(.row-stmt):not(.is-today) td.c-desc', 'e => getComputedStyle(e).backgroundColor')
        check('statement row tinted (not the plain row colour)', bg != plain, (bg, plain))
        starts = desk.eval_on_selector_all('.grid tr.month-start', 'els => els.map(e => e.dataset.date)')
        check('month lines at the first row of Nov, Dec, Jan', [d[:7] for d in starts] == ['2026-11', '2026-12', '2027-01'] and all(d.endswith(('-13', '-14', '-20')) for d in starts), starts)
        head = norm(desk.text_content('.acc-stmt'))
        check('grid header: next payment line', head.startswith('Pay £600.00'), head)
        cols = desk.evaluate('() => [...document.querySelectorAll(".grid tbody tr")].map(tr => [...tr.children].reduce((n, td) => n + (td.colSpan || 1), 0))')
        check('every grid row spans the same number of columns', len(set(cols)) == 1, set(cols))
        desk.locator('.grid tr.row-stmt >> nth=0').scroll_into_view_if_needed()
        desk.screenshot(path=f'{OUT}/v7-6-grid.png')
        desk.click('.grid tr.row-stmt >> nth=0 >> td.c-desc'); desk.wait_for_selector('#txDialog[open] .stmt-owed')
        check('clicking a grid statement row opens the statement', 'Barclaycard statement' in desk.text_content('#txDialog h2'))
        b.close()
finally:
    server.terminate()

print('\nerrors:', errors)
failed = [c for c in checks if not c[1]]
print(f'{len(checks) - len(failed)}/{len(checks)} checks passed')
sys.exit(1 if failed or errors else 0)
