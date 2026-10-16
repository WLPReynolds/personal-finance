"""v0.14.8 — history imported from Excel: ⚙ section, import (names per column
group, generic labels asked per sheet, the check page), the viewer on desktop
(spreadsheet grid, out-of-order flag, month lines, carried balances) and phone
(list), search across years with yearly totals and a grand total, account
filter, date order, Drive files in Finance/Archive, a second device getting
them, delete (local + Drive bin), and erase.
The workbook is made up here (openpyxl); no real figures.
Clock: Fri 16 Oct 2026. Run: python3 dev/e2e/archive_v0148.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime
from openpyxl import Workbook

server, URL = start_server(8781)
errors, checks, dialogs = [], [], []
XLSX = os.path.join(OUT, 'history-e2e.xlsx')

def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def toast_has(pg, text, timeout=8000):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=timeout)
def watch(page, label):
    page.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and 'accounts.google.com' not in m.text and errors.append(f'{label} console: {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    def on_dialog(d):
        dialogs.append(d.message); d.accept()
    page.on('dialog', on_dialog)
def device(b, w, h, mobile):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1 if not mobile else 2, is_mobile=mobile, has_touch=mobile)
    ctx.add_init_script(FAKE_AUTH)
    ctx.route('https://www.googleapis.com/**', handle)
    ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
    ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
    pg = ctx.new_page(); watch(pg, f'{w}px')
    pg.clock.install(time=datetime.datetime(2026, 10, 16, 19, 0, 0))
    pg.goto(URL)
    return pg
def setup(pg):
    pg.wait_for_selector('.setup-form')
    for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
    pg.fill('.setup-form input[type=date]', '2026-10-01')
    pg.click('.setup-form button[type=submit]')
    pg.wait_for_selector('.feed, .grid')
def open_settings(pg):
    if pg.locator('#settingsDialog[open]').count() == 0: pg.click('#settingsBtn')
    pg.wait_for_selector('#settingsDialog[open]')
def connect(pg):
    open_settings(pg)
    pg.click('#settingsDialog button:has-text("Connect Google Drive")')
    pg.wait_for_function('() => /Synced/.test(document.getElementById("syncChip").textContent)', timeout=8000)
def archive_files(include_trashed=False):
    return sorted(f['name'] for f in drive.values() if not f['folder'] and f['name'].startswith('archive-') and (include_trashed or not f['trashed']))

# ---------------------------------------------------------------- the workbook (made-up figures)
def serial(y, m, d): return (datetime.date(y, m, d) - datetime.date(1899, 12, 30)).days
wb = Workbook()
ws = wb.active; ws.title = '2024'
ws.append(['', '', 'Current Account', '', '', 'Credit Card'])
ws.append(['', '', 'CHASE', '', '', 'NATIONWIDE'])
ws.append(['Date', 'Description', 'Credit', 'Debit', 'Balance', 'Credit', 'Debit', 'Balance'])
ws.append([serial(2024, 1, 1), 'Brought forward', None, None, 1000, None, None, 20])
ws.append([serial(2024, 1, 5), 'Car parking', None, 4.5, 995.5, None, None, 20])
ws.append([serial(2024, 2, 9), 'Petrol (on Nationwide)', None, None, 995.5, None, 30, 50])
ws.append([serial(2024, 3, 1), 'Salary', 2000, None, 2995.5, None, None, 50])
ws.append([serial(2024, 12, 31), 'Hospital car parking', None, 3.5, 2992, None, None, 50])
ws = wb.create_sheet('2025')
ws.append(['', '', 'Current Account', '', '', 'Credit Card'])
ws.append(['', '', '', '', '', 'NATIONWIDE'])
ws.append(['Date', 'Description', 'Credit', 'Debit', 'Balance', 'Credit', 'Debit', 'Balance'])
ws.append([serial(2025, 1, 1), 'Brought forward', None, None, 2992, None, None, 50])
ws.append([serial(2025, 1, 3), 'Car parking (station)', None, 6.25, 2985.75, None, None, 50])
ws.append([serial(2025, 4, 2), 'In Greece', None, None, None, None, None, None])
ws.append([serial(2025, 4, 3), 'Airport parking (on Nationwide)', None, None, 2985.75, None, 60, 110])
ws.append([serial(2025, 4, 9), 'Back from Greece', None, None, None, None, None, None])
ws = wb.create_sheet('2026')
ws.append(['', '', 'Current Account', '', '', 'Credit Card', '', '', 'Credit Card'])
ws.append(['', '', '', '', '', 'NATIONWIDE', '', '', 'BARCLAYCARD'])
ws.append(['Date', 'Description', 'Credit', 'Debit', 'Balance', 'Credit', 'Debit', 'Balance', 'Credit', 'Debit', 'Balance'])
ws.append([serial(2026, 1, 1), 'Brought forward', None, None, 2985.75, None, None, 110, None, None, 500])
ws.append([serial(2026, 1, 2), 'Loveholidays (on Barclaycard)', None, None, 2985.75, None, None, 110, None, 274.95, 774.95])
ws.append([serial(2026, 1, 13), 'BARCLAYCARD STATEMENT', None, None, 2985.75, None, None, 110, None, None, 774.95])
ws.append([serial(2026, 1, 28), 'Salary', 4000, None, 6985.75, None, None, 110, None, None, 774.95])
ws.append([serial(2026, 2, 3), 'Car parking (on Barclaycard)', None, None, 6985.75, None, None, 110, None, 6.39, 781.34])
ws.append([serial(2026, 2, 5), 'Lottery', None, 15, 6970.75, None, None, 110, None, None, 781.34])
ws.append([serial(2026, 1, 20), 'Hospital car parking (on Barclaycard)', None, None, 6970.75, None, None, None, None, 3.5, 784.84])
ws.append([serial(2026, 2, 10), 'Barclaycard direct debit', None, 774.95, 6195.800000000001, None, None, 110, 774.95, None, 10.89])  # 784.84 - 774.95 = 9.89
ws.append([serial(2026, 3, 1), 'Lunch', None, 7.9, 6187.9, None, None, 110, None, None, 10.89])
ws.append([serial(2026, 10, 2), 'Already in the app', None, 5, 6182.1, None, None, 110, None, None, 10.89])
ws.append([serial(2026, 12, 28), 'Salary (forecast)', 4000, None, 10182.1, None, None, 110, None, None, 10.89])
wb.save(XLSX)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()

        # ================================================================ desktop: import
        desk = device(b, 1400, 900, False)
        setup(desk)
        connect(desk)
        st = desk.text_content('#settingsDialog')
        check('⚙ has the history section before anything is imported', 'History from Excel' in st and 'Import from Excel…' in st)
        check('⚙ offers Get from Drive while syncing', desk.locator('#settingsDialog button:has-text("Get from Drive")').count() == 1)
        desk.click('#settingsDialog button:has-text("Import from Excel…")')
        desk.wait_for_selector('#archiveImportDialog[open]')
        check('import page says when rows are left out', '1 Oct 2026' in desk.text_content('#archiveImportDialog'))
        desk.set_input_files('#archiveImportDialog input[type=file]', XLSX)
        desk.wait_for_selector('#archiveImportDialog .arch-sheet')
        sheets = desk.locator('#archiveImportDialog .arch-sheet')
        check('one block per sheet', sheets.count() == 3, sheets.count())
        names = desk.eval_on_selector_all('#archiveImportDialog .arch-group input', 'els => els.map(e => e.value)')
        check('names suggested from the header labels', names == ['Chase', 'Nationwide', 'Current Account', 'Nationwide', 'Current Account', 'Nationwide', 'Barclaycard'], names)
        warns = desk.locator('#archiveImportDialog .arch-group .warn-text').count()
        check('generic "Current Account" flagged on each sheet it appears on', warns == 2, warns)
        desk.screenshot(path=f'{OUT}/v0148-1-names.png')
        # 2025 and 2026 current accounts were Chase too
        groups = desk.locator('#archiveImportDialog .arch-group input')
        groups.nth(2).fill('Chase'); groups.nth(4).fill('Chase')
        desk.click('#archiveImportDialog button:has-text("Next: check")')
        desk.wait_for_selector('#archiveImportDialog .arch-check')
        ct = desk.text_content('#archiveImportDialog')
        check('check page: 3 years ready', '3 years ready: 2024–2026' in ct, ct[:200])
        check('check page: rows from 1 Oct 2026 left out', '2 rows from 16 Oct 2026' not in ct and '2 rows from 1 Oct 2026 on left out' in ct, re.search(r'\d+ rows? from[^.]*', ct))
        check('check page: the out-of-order row, with the dates around it', 'Row 10' in ct and '20 Jan “Hospital car parking (on Barclaycard)” sits between 5 Feb and 10 Feb' in ct)
        check('check page: the wrong balance, with what the figures make it', 'Barclaycard: “Barclaycard direct debit” shows £10.89, the figures make it £9.89' in ct)
        check('check page: Nationwide blank balance cell is not a problem', 'Nationwide: “Hospital' not in ct)
        check('check page: 2025 chained to 2024 cleanly; 2024 has none', ct.count('No problems found') >= 2, ct.count('No problems found'))
        check('check page: imported as-is wording', 'imported exactly as it is' in ct)
        desk.screenshot(path=f'{OUT}/v0148-2-check.png', full_page=True)
        desk.click('#archiveImportDialog button:has-text("Import 3 years")')
        desk.wait_for_selector('#archiveDialog[open]')
        toast_has(desk, 'History imported: 2024–2026 and saved to Drive')
        check('Drive: one file per year in Finance/Archive', archive_files() == ['archive-2024.json', 'archive-2025.json', 'archive-2026.json'], archive_files())
        folder = [f for f in drive.values() if f['folder'] and f['name'] == 'Archive']
        finance = [k for k, f in drive.items() if f['folder'] and f['name'] == 'Finance']
        check('Drive: Archive folder sits inside Finance', len(folder) == 1 and folder[0]['parent'] in finance)
        pj = json.loads(drive_files()[0]['text'])
        check('personal.json untouched by the import', 'Loveholidays' not in drive_files()[0]['text'] and 'archive' not in pj)

        # ================================================================ desktop: browse
        dv = desk.locator('#archiveDialog')
        check('viewer opens on the newest year', desk.eval_on_selector('#archiveDialog .arch-year', 'e => e.value') == '2026')
        heads = desk.eval_on_selector_all('#archiveDialog .arch-acc-name', 'els => els.map(e => e.textContent)')
        check('grid: one column group per account that year', heads == ['Chase', 'Nationwide', 'Barclaycard'], heads)
        rows = desk.locator('#archiveDialog tbody tr')
        check('grid: 2026 rows up to 30 Sep only', rows.count() == 9 and 'Already in the app' not in dv.text_content(), rows.count())
        ooo = desk.locator('#archiveDialog tbody tr.arch-ooo')
        check('grid: the stray row is flagged (and only it)', ooo.count() == 1 and 'Hospital car park' in ooo.text_content())
        title = ooo.locator('td.c-date').get_attribute('title') or ''
        check('grid: hovering the flag explains it', 'Dated 20 Jan 2026, but sits between 5 Feb and 10 Feb' in title and 'row 10' in title, title)
        starts = desk.eval_on_selector_all('#archiveDialog tbody tr.month-start td.c-desc', 'els => els.map(e => e.textContent)')
        check('grid: month lines at Feb and Mar only (the stray Jan row adds none)', starts == ['Car parking (on Barclaycard)', 'Lunch'], starts)
        hosp = desk.locator('#archiveDialog tbody tr', has_text='Hospital car park')
        cells = hosp.locator('td').all_text_contents()
        check('grid: blank balance cell shows the balance above it, faded', cells[7] == '110.00' and 'bal-carried' in (hosp.locator('td').nth(7).get_attribute('class') or ''), cells)
        dd = desk.locator('#archiveDialog tbody tr', has_text='Barclaycard direct debit').locator('td').all_text_contents()
        check('grid: stored values as the sheet has them (float noise gone)', dd[3] == '774.95' and dd[4] == '6,195.80' and dd[8] == '774.95' and dd[10] == '10.89', dd)
        check('grid: Brought forward row', 'row-bf' in (rows.nth(0).get_attribute('class') or ''))
        desk.screenshot(path=f'{OUT}/v0148-3-desktop-2026.png')
        desk.select_option('#archiveDialog .arch-year', '2024')
        heads = desk.eval_on_selector_all('#archiveDialog .arch-acc-name', 'els => els.map(e => e.textContent)')
        check('another year shows its own accounts', heads == ['Chase', 'Nationwide'], heads)

        # ================================================================ desktop: search
        desk.fill('#archiveDialog .arch-search', 'parking')
        desk.wait_for_function('() => /matches/.test(document.querySelector("#archiveDialog .arch-summary").textContent)')
        summ = desk.text_content('#archiveDialog .arch-summary')
        check('search: matches across all years', summ.startswith('6 matches in 3 years'), summ)
        check('search: the year picker is hidden while searching', desk.is_hidden('#archiveDialog .arch-year'))
        totals = desk.eval_on_selector_all('#archiveDialog tr.arch-total td.c-desc', 'els => els.map(e => e.textContent)')
        check('search: a total row per year and a grand total', totals == ['Total 2024', 'Total 2025', 'Total 2026', 'Grand total'], totals)
        yr = desk.eval_on_selector_all('#archiveDialog tr.arch-year-row td', 'els => els.slice(0, 2).map(e => e.textContent)')
        check('search: each year starts with its heading', yr == ['2024', '2 matches'], yr)
        grand = desk.locator('#archiveDialog tr.arch-grand td').all_text_contents()
        heads = desk.eval_on_selector_all('#archiveDialog .arch-acc-name', 'els => els.map(e => e.textContent)')
        check('search: columns for every account with a match', heads == ['Chase', 'Nationwide', 'Barclaycard'], heads)
        # Chase debit 4.50 + 3.50 + 6.25 = 14.25; Nationwide 60; Barclaycard 6.39 + 3.50 = 9.89
        check('search: grand totals per account', grand[3] == '14.25' and grand[6] == '60.00' and grand[9] == '9.89', grand)
        check('search: a Brought forward row never matches', 'Brought forward' not in desk.text_content('#archiveDialog tbody'))
        desk.screenshot(path=f'{OUT}/v0148-4-desktop-search.png')
        desk.emulate_media(color_scheme='dark')
        desk.screenshot(path=f'{OUT}/v0148-4b-desktop-search-dark.png')
        desk.emulate_media(color_scheme='light')
        desk.click('#archiveDialog .arch-chip:has-text("Chase")')
        desk.wait_for_function('() => document.querySelector("#archiveDialog .arch-summary").textContent.startsWith("3 matches")')
        heads = desk.eval_on_selector_all('#archiveDialog .arch-acc-name', 'els => els.map(e => e.textContent)')
        check('filter to one account: only its rows and columns', heads == ['Chase'], heads)
        desk.click('#archiveDialog .arch-chip:has-text("Chase")')
        desk.click('#archiveDialog .arch-order button:has-text("Date order")')
        desk.wait_for_function('() => /balances hidden/.test(document.querySelector("#archiveDialog .arch-summary").textContent)')
        check('date order: balance columns hidden', desk.locator('#archiveDialog thead th:has-text("Balance")').count() == 0)
        dates26 = desk.eval_on_selector_all('#archiveDialog tbody tr:not(.arch-year-row):not(.arch-total) td.c-date', 'els => els.map(e => e.textContent.replace("⚠ ", ""))')
        check('date order: 2026 rows sorted by date', dates26[-2:] == ['20/01/26', '03/02/26'], dates26)
        desk.click('#archiveDialog .arch-order button:has-text("Sheet order")')
        desk.fill('#archiveDialog .arch-search', 'zzz nothing')
        desk.wait_for_function('() => document.querySelector("#archiveDialog .arch-summary").textContent === "No matches"')
        check('no matches says so', True)
        desk.click('#archiveDialog .sheet-head .icon-btn')
        check('no errors on desktop so far', not errors, errors)

        # ================================================================ phone: get from Drive
        phone = device(b, 412, 915, True)
        setup(phone)
        connect(phone)
        phone.click('#settingsDialog button:has-text("Get from Drive")')
        toast_has(phone, 'History: 2024–2026 on this device')
        phone.wait_for_selector('#settingsDialog button:has-text("Open history")')
        check('phone: ⚙ now shows the years', '2024–2026' in phone.text_content('#settingsDialog'))
        phone.click('#settingsDialog button:has-text("Open history")')
        phone.wait_for_selector('#archiveDialog[open] .arch-list')
        check('phone: a list, not the wide grid', phone.locator('#archiveDialog table').count() == 0)
        days = phone.eval_on_selector_all('#archiveDialog .arch-list > .day', 'els => els.map(e => e.textContent)')
        check('phone: month headings (none for the stray row)', days == ['January 2026', 'February 2026', 'March 2026'], days)
        bf = phone.locator('#archiveDialog .arch-item.arch-bf')
        check('phone: Brought forward shows each balance', bf.count() == 1 and 'bal 2,985.75' in bf.text_content())
        lov = phone.locator('#archiveDialog .arch-item', has_text='Loveholidays').text_content()
        check('phone: an entry shows the account, amount and balance', 'Barclaycard' in lov and '−274.95' in lov and 'bal 774.95' in lov, lov)
        phone.click('#archiveDialog .arch-ooo-date')
        toast_has(phone, 'Dated 20 Jan 2026, but sits between 5 Feb and 10 Feb')
        width = phone.evaluate('document.querySelector("#archiveDialog").scrollWidth - document.querySelector("#archiveDialog").clientWidth')
        check('phone: no sideways scroll in the viewer', width <= 0, width)
        phone.screenshot(path=f'{OUT}/v0148-5-phone-2026.png')
        phone.fill('#archiveDialog .arch-search', 'parking')
        phone.wait_for_function('() => /^6 matches/.test(document.querySelector("#archiveDialog .arch-summary").textContent)')
        tl = phone.eval_on_selector_all('#archiveDialog .arch-total .arch-item-top', 'els => els.map(e => e.textContent)')
        check('phone search: yearly totals and a grand total', tl == ['Total 2024', 'Total 2025', 'Total 2026', 'Grand total'], tl)
        grand = phone.text_content('#archiveDialog .arch-grand')
        check('phone search: grand total per account', '−14.25' in grand and '−60.00' in grand and '−9.89' in grand, grand)
        phone.screenshot(path=f'{OUT}/v0148-6-phone-search.png', full_page=True)
        phone.click('#archiveDialog .sheet-head .icon-btn')

        # ================================================================ import again replaces a year
        open_settings(desk)
        desk.click('#settingsDialog button:has-text("Import again…")')
        desk.set_input_files('#archiveImportDialog input[type=file]', XLSX)
        desk.wait_for_selector('#archiveImportDialog .arch-sheet')
        names = desk.eval_on_selector_all('#archiveImportDialog .arch-group input', 'els => els.map(e => e.value)')
        check('import again: the names chosen last time are remembered (per sheet for generic ones)', names == ['Chase', 'Nationwide', 'Chase', 'Nationwide', 'Chase', 'Nationwide', 'Barclaycard'], names)
        # just 2026 this time
        boxes = desk.locator('#archiveImportDialog .arch-sheet-head input[type=checkbox]')
        boxes.nth(0).uncheck(); boxes.nth(1).uncheck()
        desk.click('#archiveImportDialog button:has-text("Next: check")')
        ct = desk.text_content('#archiveImportDialog')
        check('import again: says the year is replaced', 'Already imported: 2026. Importing replaces it.' in ct)
        check('import again: 2026 still chained to the 2024–25 already on the device (no false chain warning)', 'Brought forward differs' not in ct)
        before = {k: f['version'] for k, f in drive.items() if f['name'] == 'archive-2026.json'}
        desk.click('#archiveImportDialog button:has-text("Import 1 year")')
        toast_has(desk, 'History imported: 2026 and saved to Drive')
        after = {k: f['version'] for k, f in drive.items() if f['name'] == 'archive-2026.json' and not f['trashed']}
        check('import again: the Drive file for that year is overwritten, not duplicated', list(after) == list(before) and list(after.values())[0] > list(before.values())[0], (before, after))
        desk.click('#archiveDialog .sheet-head .icon-btn')

        # ================================================================ delete
        dialogs.clear()
        open_settings(desk)
        desk.click('#settingsDialog button:has-text("Delete imported history…")')
        toast_has(desk, 'Imported history deleted')
        check('delete: asked first, mentioning Drive’s bin and that accounts are untouched', dialogs and 'bin' in dialogs[-1] and 'not touched' in dialogs[-1], dialogs[-1:] )
        check('delete: Drive files moved to the bin', archive_files() == [] and len(archive_files(include_trashed=True)) == 3, archive_files(True))
        desk.wait_for_selector('#settingsDialog button:has-text("Import from Excel…")')
        check('delete: ⚙ back to "Import from Excel…"', desk.locator('#settingsDialog button:has-text("Open history")').count() == 0)
        check('delete: personal data still there', len(drive_files()) == 1 and desk.locator('.grid').count() == 1)
        n = desk.evaluate("""() => new Promise((res) => { const r = indexedDB.open('finance-tracker'); r.onsuccess = () => {
            const g = r.result.transaction('kv').objectStore('kv').get('archive'); g.onsuccess = () => res(g.result === undefined ? 'gone' : 'there'); }; })""")
        check('delete: local record gone', n == 'gone', n)

        # ================================================================ erase removes it on the phone
        dialogs.clear()
        open_settings(phone)
        phone.click('#settingsDialog button:has-text("Erase all data on this device")')
        phone.wait_for_selector('.setup-form')
        n = phone.evaluate("""() => new Promise((res) => { const r = indexedDB.open('finance-tracker'); r.onsuccess = () => {
            const g = r.result.transaction('kv').objectStore('kv').get('archive'); g.onsuccess = () => res(g.result === undefined ? 'gone' : 'there'); }; })""")
        check('erase: the history goes too', n == 'gone', n)

        check('no console errors', not errors, errors)
        b.close()
finally:
    server.terminate()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)}/{len(checks)} checks passed')
sys.exit(1 if bad else 0)
