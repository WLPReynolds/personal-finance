"""v0.15.4 — Export to Excel: ⚙ → Export to Excel…, a date range from the
earliest history to 12 months ahead, accounts ticked on and off, projected
entries optional; the .xlsx downloaded and checked with openpyxl (a sheet per
year, names over the blocks, vertical borders between accounts, grey where an
account has no data, figures in pounds, statement rows in upper case).
The history workbook is made up here (openpyxl); no real figures.
Clock: Sun 18 Oct 2026. Run: python3 dev/e2e/export_v0154.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime
from openpyxl import Workbook, load_workbook

server, URL = start_server(8783)
errors, checks = [], []
XLSX = os.path.join(OUT, 'export-e2e-history.xlsx')
OUTX = os.path.join(OUT, 'export-e2e-out.xlsx')

def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def watch(page, label):
    page.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and 'accounts.google.com' not in m.text and errors.append(f'{label} console: {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    page.on('dialog', lambda d: d.accept())
def device(b, w, h, mobile):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1 if not mobile else 2, is_mobile=mobile, has_touch=mobile, landing_summary=mobile, accept_downloads=True)
    ctx.add_init_script(FAKE_AUTH)
    ctx.route('https://www.googleapis.com/**', handle)
    ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
    ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
    pg = ctx.new_page(); watch(pg, f'{w}px')
    pg.clock.install(time=datetime.datetime(2026, 10, 18, 9, 0, 0))
    pg.goto(URL)
    return pg
def setup(pg):
    pg.wait_for_selector('.setup-form')
    for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
    pg.fill('.setup-form input[type=date]', '2026-10-01')
    pg.click('.setup-form button[type=submit]')
    pg.wait_for_selector('.feed, .grid, .summary')
def open_settings(pg):
    if pg.locator('#settingsDialog[open]').count() == 0: pg.click('#settingsBtn')
    pg.wait_for_selector('#settingsDialog[open]')
def add_spend(pg, col, amount, desc, date):
    pg.click(f'.acc-add >> nth={col}')
    pg.wait_for_selector('#txDialog[open]')
    pg.fill('#txDialog .amount-input', amount)
    pg.fill('#txDialog input[placeholder="e.g. Lottery"]', desc)
    pg.fill('#txDialog input[type=date]', date)
    pg.click('#txDialog button[type=submit]')
    pg.wait_for_selector('#txDialog[open]', state='detached')

def serial(y, m, d): return (datetime.date(y, m, d) - datetime.date(1899, 12, 30)).days
wb = Workbook()
ws = wb.active; ws.title = '2019'
ws.append(['', '', 'HALIFAX', '', '', 'NATIONWIDE'])
ws.append(['Date', 'Description'] + ['Credit', 'Debit', 'Balance'] * 2)
ws.append([serial(2019, 1, 1), 'Brought forward', None, None, 500, None, None, 0])
ws.append([serial(2019, 2, 3), 'Wages', 1000, None, 1500, None, None, 0])
ws.append([serial(2019, 4, 5), 'Car parking', None, None, 1500, None, 5, 5])
ws2 = wb.create_sheet('2020')
ws2.append(['', '', 'NATIONWIDE'])
ws2.append(['Date', 'Description', 'Credit', 'Debit', 'Balance'])
ws2.append([serial(2020, 1, 1), 'Brought forward', None, None, 5])
ws2.append([serial(2020, 6, 1), 'Shopping', None, 20, 25])
wb.save(XLSX)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        desk = device(b, 1400, 900, False)
        setup(desk)
        add_spend(desk, 0, '12', 'Groceries', '2026-10-02')
        add_spend(desk, 1, '8', 'Fuel', '2026-10-03')

        open_settings(desk)
        desk.click('#settingsDialog button:has-text("Import from Excel…")')
        desk.set_input_files('#archiveImportDialog input[type=file]', XLSX)
        desk.wait_for_selector('#archiveImportDialog .arch-sheet')
        desk.click('#archiveImportDialog button:has-text("Next: check")')
        desk.wait_for_selector('#archiveImportDialog .arch-links')
        desk.click('#archiveImportDialog button:has-text("Import 2 years")')
        desk.wait_for_selector('#archiveDialog[open]')
        desk.click('#archiveDialog .win-close')

        check('⚙ has an Export to Excel section', desk.locator('#settingsDialog h3:text-is("Export to Excel")').count() == 1)
        desk.click('#settingsDialog button:has-text("Export to Excel…")')
        desk.wait_for_selector('#exportDialog[open]')
        check('opens as a window with the ✕', desk.locator('#exportDialog .win-close').count() == 1)
        check('From defaults to the earliest history', desk.input_value('#exportDialog input[aria-label=From]') == '2019-01-01')
        check('To defaults to today', desk.input_value('#exportDialog input[aria-label=To]') == '2026-10-18')
        check('To can go 12 months ahead', desk.get_attribute('#exportDialog input[aria-label=To]', 'max') == '2027-10-31')
        chips = desk.eval_on_selector_all('#exportDialog .arch-chip', 'els => els.map(e => e.textContent)')
        check('accounts: live first, then history with its own name', chips == ['Current Account', 'Nationwide', 'Barclaycard', 'Halifax · history'], chips)
        check('projected option hidden while To is today', desk.is_hidden('#exportDialog .exp-proj'))
        desk.click('#exportDialog button:has-text("+12 months")')
        check('+12 months sets To', desk.input_value('#exportDialog input[aria-label=To]') == '2027-10-31')
        check('projected option shows once To is ahead', desk.is_visible('#exportDialog .exp-proj'))
        desk.click('#exportDialog .arch-chip:has-text("Barclaycard")')
        summ = desk.text_content('#exportDialog .exp-summary')
        check('summary: sheets and accounts', '9 sheets' in summ and '3 accounts' in summ, summ)
        desk.screenshot(path=f'{OUT}/v0154-1-export-desktop.png')
        with desk.expect_download() as dl:
            desk.click('#exportDialog button:has-text("Download .xlsx")')
        d = dl.value
        check('file name says the range', d.suggested_filename == 'Personal Finance 2019-01-01 to 2027-10-31.xlsx', d.suggested_filename)
        d.save_as(OUTX)

        x = load_workbook(OUTX)
        check('a sheet per year', x.sheetnames == [str(y) for y in range(2019, 2028)], x.sheetnames)
        s19 = x['2019']
        check('names over the blocks (Barclaycard left out)', [s19.cell(1, c).value for c in (3, 7, 11)] == ['Current Account', 'Nationwide', 'Halifax'], [s19.cell(1, c).value for c in (3, 7, 11)])
        check('headers', [s19.cell(2, c).value for c in range(1, 14)] == ['Date', 'Description', 'Credit', 'Debit', 'Balance', '✓', 'Credit', 'Debit', 'Balance', '✓', 'Credit', 'Debit', 'Balance'] and s19.cell(2, 14).value == 'Status')
        check('Brought forward first', s19.cell(3, 2).value == 'Brought forward' and s19.cell(3, 13).value == 500)
        wages = [r for r in s19.iter_rows(min_row=3) if r[1].value == 'Wages'][0]
        check('Halifax wages in pounds', wages[10].value == 1000 and wages[12].value == 1500)
        check('date is a real date', isinstance(wages[0].value, datetime.datetime) and wages[0].value.date() == datetime.date(2019, 2, 3))
        grey = wages[2].fill.fgColor.rgb
        check('Current Account grey in 2019 (no data yet)', grey.endswith('D9D9D9'), grey)
        check('Nationwide history in the live Nationwide column', [r for r in s19.iter_rows(min_row=3) if r[1].value == 'Car parking'][0][7].value == 5)
        check('vertical border at the end of each account', all(wages[i].border.right.style == 'medium' for i in (1, 5, 9, 12)))
        s26 = x['2026']
        rows26 = [[c.value for c in r] for r in s26.iter_rows(min_row=3)]
        g = [r for r in rows26 if r[1] == 'Groceries'][0]
        check('2026: live entries with balances', g[3] == 12 and g[4] == 3588, g[:5])
        halifax26 = [r for r in s26.iter_rows(min_row=3) if r[1].value == 'Groceries'][0][10].fill.fgColor.rgb
        check('Halifax grey after its data ends', halifax26.endswith('D9D9D9'), halifax26)
        check('frozen at C3', s26.freeze_panes == 'C3', s26.freeze_panes)
        stm = [r for r in rows26 if r[1] and 'STATEMENT' in str(r[1])]
        check('Nationwide statement rows in upper case', not stm or all(str(r[1]).isupper() for r in stm), stm[:1])

        # history import accepts the export (the 2019 sheet)
        open_settings(desk)
        check('no errors', not errors, errors)

        phone = device(b, 412, 915, True)
        setup(phone)
        open_settings(phone)
        phone.click('#settingsDialog button:has-text("Export to Excel…")')
        phone.wait_for_selector('#exportDialog[open]')
        phone.screenshot(path=f'{OUT}/v0154-2-export-phone.png')
        w = phone.evaluate('() => document.documentElement.scrollWidth')
        check('phone: no sideways scroll', w <= 412, w)
        check('no errors on phone', not errors, errors)
finally:
    server.terminate()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
