"""v0.15.0 — Find: history + live accounts in one search. Linking history
accounts to live ones on the import's check page (exact-name suggestion) and in
⚙, columns by live account, the history icon, internal moves left out of the
totals, per-year totals and a grand total (out and in apart), clicking a live
row (grid row flashed; phone: that account's list) and a history row (History
window at that row, on top of Find), and the window rules.
The workbook is made up here (openpyxl); no real figures.
Clock: Sat 17 Oct 2026. Run: python3 dev/e2e/finder_v0150.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime
from openpyxl import Workbook

server, URL = start_server(8782)
errors, checks, dialogs = [], [], []
XLSX = os.path.join(OUT, 'finder-e2e.xlsx')

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
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1 if not mobile else 2, is_mobile=mobile, has_touch=mobile, landing_summary=mobile)
    ctx.add_init_script(FAKE_AUTH)
    ctx.route('https://www.googleapis.com/**', handle)
    ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
    ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
    pg = ctx.new_page(); watch(pg, f'{w}px')
    pg.clock.install(time=datetime.datetime(2026, 10, 17, 9, 0, 0))
    pg.goto(URL)
    return pg
def setup(pg):
    pg.wait_for_selector('.setup-form')
    fill_setup(pg, ['3600', '6', '1000'])
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
    pg.wait_for_selector(f'.grid td.c-desc:text-is("{desc}")')
def find(pg, text):
    pg.fill('#finderDialog .fd-search', text)
    pg.wait_for_timeout(350)  # the search waits 150ms after the last key
    pg.wait_for_function('() => /match|No matches/.test(document.querySelector("#finderDialog .fd-summary").textContent)')

def serial(y, m, d): return (datetime.date(y, m, d) - datetime.date(1899, 12, 30)).days
wb = Workbook()
ws = wb.active; ws.title = '2024'
ws.append(['', '', 'Current Account', '', '', 'Credit Card', '', '', 'Credit Card', '', '', 'Credit Card'])
ws.append(['', '', 'CHASE', '', '', 'NATIONWIDE', '', '', 'BARCLAYCARD', '', '', 'BARCLAYCARD BT'])
ws.append(['Date', 'Description'] + ['Credit', 'Debit', 'Balance'] * 4)
ws.append([serial(2024, 1, 1), 'Brought forward', None, None, 1000, None, None, 0, None, None, 0, None, None, 0])
ws.append([serial(2024, 3, 2), 'Car parking (on Nationwide)', None, None, 1000, None, 10, 10, None, None, 0, None, None, 0])
ws.append([serial(2024, 4, 1), 'Balance transfer from MBNA', None, None, 1000, None, None, 10, None, None, 0, None, 500, 500])
ws.append([serial(2024, 5, 1), 'Move BT to main', None, None, 1000, None, None, 10, None, 200, 200, 200, None, 300])
ws.append([serial(2024, 6, 9), 'Hospital car parking', None, 3.5, 996.5, None, None, 10, None, None, 200, None, None, 300])
wb.save(XLSX)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        desk = device(b, 1400, 900, False)
        setup(desk)
        add_spend(desk, 1, '15', 'Car parking (on Nationwide)', '2026-10-05')
        add_spend(desk, 0, '7.50', 'Car parking', '2026-11-03')

        check('grid has a Find button', desk.locator('.grid-tools .find-btn').count() == 1)

        # ---- import, linking on the check page
        open_settings(desk)
        desk.click('#settingsDialog button:has-text("Import from Excel…")')
        desk.set_input_files('#archiveImportDialog input[type=file]', XLSX)
        desk.wait_for_selector('#archiveImportDialog .arch-sheet')
        desk.click('#archiveImportDialog button:has-text("Next: check")')
        desk.wait_for_selector('#archiveImportDialog .arch-links')
        names = desk.eval_on_selector_all('#archiveImportDialog .arch-link-name', 'els => els.map(e => e.textContent)')
        check('check page lists each history account to link', [n.split(' · ')[0] for n in names] == ['Chase', 'Nationwide', 'Barclaycard', 'Barclaycard Bt'], names)
        sels = desk.locator('#archiveImportDialog .arch-link-sel')
        vals = [sels.nth(i).evaluate('e => e.options[e.selectedIndex].text') for i in range(4)]
        check('exact names suggested, the rest not linked', vals == ['Not linked — its own column', 'Same as: Nationwide', 'Same as: Barclaycard', 'Not linked — its own column'], vals)
        check('suggestions are marked', desk.locator('#archiveImportDialog .arch-suggest').count() == 2)
        sels.nth(3).select_option(label='Same as: Barclaycard')
        desk.click('#archiveImportDialog button:has-text("Import 1 year")')
        desk.wait_for_selector('#archiveDialog[open]')
        desk.click('#archiveDialog .win-close')
        pj = desk.evaluate("""() => new Promise((res) => { const r = indexedDB.open('finance-tracker'); r.onsuccess = () => {
            const g = r.result.transaction('kv').objectStore('kv').get('ledger'); g.onsuccess = () => res(g.result); }; })""")
        rec = [x for x in pj['scheduledItems'] if x.get('recordType') == 'archiveLinks']
        check('links saved as one record in your ledger (so they sync)', len(rec) == 1 and set(rec[0]['links']) == {'chase', 'nationwide', 'barclaycard', 'barclaycardbt'} and rec[0]['links']['chase'] is None, rec)

        # ---- Find on desktop
        if desk.locator('#settingsDialog[open]').count(): desk.click('#settingsDialog .sheet-head .icon-btn')
        desk.click('.grid-tools .find-btn')
        desk.wait_for_selector('#finderDialog[open]')
        check('Find opens as a window with the ✕', desk.locator('#finderDialog .win-close').count() == 1)
        check('before typing: says what it searches', 'imported history' in desk.text_content('#finderDialog .fd-summary'))
        check('before typing: every account pill is shown', desk.locator('#finderDialog .arch-chip:not([hidden])').count() == desk.locator('#finderDialog .arch-chip').count() == 4)
        find(desk, 'parking')
        summ = desk.text_content('#finderDialog .fd-summary')
        check('history and live together', summ.startswith('4 matches in 2 years'), summ)
        heads = desk.eval_on_selector_all('#finderDialog thead .fd-col-name', 'els => els.map(e => e.textContent)')
        check('columns are your accounts, plus unlinked history (Chase)', heads == ['Current Account', 'Nationwide', 'Chase'], heads)
        pills = desk.eval_on_selector_all('#finderDialog .arch-chip:not([hidden])', 'els => els.map(e => e.textContent)')
        check('only the account pills with a match are shown (v0.15.2)', pills == ['Current Account', 'Nationwide', 'Chase'], pills)
        rows = desk.locator('#finderDialog tbody tr.fd-row')
        first = rows.nth(0).locator('td').all_text_contents()
        check('a 2024 Nationwide spend sits in the live Nationwide column', first[1] == 'Car parking (on Nationwide)' and first[3] == '−10.00', first)
        check('history rows have the history icon; live rows don’t', rows.nth(0).locator('.fd-hist').count() == 1 and rows.nth(2).locator('.fd-hist').count() == 0)
        oct5 = rows.nth(2).locator('td').all_text_contents()
        check('5 Oct 2026 live spend in the same Nationwide column', oct5[0] == '05/10/26' and oct5[3] == '−15.00', oct5)
        totals = desk.eval_on_selector_all('#finderDialog tr.arch-total td.c-desc', 'els => els.map(e => e.textContent)')
        check('a total per year and a grand total', totals == ['Total 2024', 'Total 2026', 'Grand total'], totals)
        grand = desk.locator('#finderDialog tr.arch-grand td').all_text_contents()
        check('grand totals per column (out)', grand[2] == '−7.50' and grand[3] == '−25.00' and grand[4] == '−3.50', grand)
        check('a projected-month entry (3 Nov) is found too', '03/11/26' in desk.text_content('#finderDialog tbody'))
        desk.screenshot(path=f'{OUT}/v0150-1-find-desktop.png')

        find(desk, 'move')
        tx = desk.text_content('#finderDialog')
        check('internal move: listed and tagged', 'internal move' in tx and 'Move BT to main' in tx)
        check('internal move: not in the totals', '1 internal move not counted' in desk.text_content('#finderDialog .fd-summary') and all(t == '' for t in desk.locator('#finderDialog tr.arch-total td.num').all_text_contents()), desk.locator('#finderDialog tr.arch-total td.num').all_text_contents())
        find(desk, 'balance transfer')
        bt = desk.locator('#finderDialog tbody tr.fd-row').nth(0).locator('td').all_text_contents()
        heads = desk.eval_on_selector_all('#finderDialog thead .fd-col-name', 'els => els.map(e => e.textContent)')
        check('linked balance-transfer column lands under Barclaycard', heads == ['Barclaycard'] and bt[2] == '−500.00', (heads, bt))

        # ---- window rules
        desk.mouse.click(5, 5); desk.wait_for_timeout(150)
        check('a click outside does not close Find', desk.locator('#finderDialog[open]').count() == 1)

        # ---- click a history row → History at that row, on top
        find(desk, 'hospital')
        desk.click('#finderDialog tbody tr.fd-row >> nth=0')
        desk.wait_for_selector('#archiveDialog[open]')
        desk.wait_for_timeout(300)
        fl = desk.locator('#archiveDialog tr.flash')
        check('history row → History window, that row flashed', fl.count() == 1 and 'Hospital car parking' in fl.text_content())
        check('History shows the whole year (no search carried over)', desk.input_value('#archiveDialog .arch-search') == '' and desk.is_visible('#archiveDialog .arch-year'))
        desk.click('#archiveDialog .win-close')
        check('closing History comes back to Find', desk.locator('#finderDialog[open]').count() == 1 and desk.input_value('#finderDialog .fd-search') == 'hospital')

        # ---- click a live row → grid, flashed
        find(desk, 'parking')
        desk.click('#finderDialog tbody tr.fd-row:has-text("05/10/26")')
        desk.wait_for_selector('#finderDialog[open]', state='detached')
        desk.wait_for_timeout(300)
        fl = desk.locator('#app .grid tbody tr.flash')
        check('live row → Find closes, grid row flashed', fl.count() == 1 and 'Car parking (on Nationwide)' in fl.text_content())
        desk.click('.grid-tools .find-btn')
        desk.wait_for_selector('#finderDialog[open]')
        check('reopening Find keeps the search', desk.input_value('#finderDialog .fd-search') == 'parking' and desk.locator('#finderDialog tbody tr.fd-row').count() == 4)
        desk.click('#finderDialog .win-close')

        # ---- ⚙ Link to your accounts…
        open_settings(desk)
        desk.click('#settingsDialog button:has-text("Link to your accounts…")')
        desk.wait_for_selector('#archiveImportDialog[open] .arch-links')
        vals = desk.eval_on_selector_all('#archiveImportDialog .arch-link-sel', 'els => els.map(e => e.options[e.selectedIndex].text)')
        check('⚙ links show what was saved (no suggestion over a "not linked" choice)', vals == ['Not linked — its own column', 'Same as: Nationwide', 'Same as: Barclaycard', 'Same as: Barclaycard'], vals)
        desk.locator('#archiveImportDialog .arch-link-sel').nth(0).select_option(label='Same as: Current Account')
        desk.click('#archiveImportDialog button:has-text("Save links")')
        toast_has(desk, 'Links saved')
        desk.click('#settingsDialog .sheet-head .icon-btn')
        desk.click('.grid-tools .find-btn')
        desk.wait_for_selector('#finderDialog[open]')
        heads = desk.eval_on_selector_all('#finderDialog thead .fd-col-name', 'els => els.map(e => e.textContent)')
        check('after linking Chase → Current Account, it shares that column', heads == ['Current Account', 'Nationwide'], heads)
        desk.click('#finderDialog .win-close')
        check('no errors on desktop', not errors, errors)

        # ---- phone
        phone = device(b, 412, 915, True)
        setup(phone)
        phone.wait_for_selector('.summary-tools .find-btn')
        check('phone Summary has Find', phone.locator('.summary-tools .find-btn').count() == 1)
        # give the phone the same history (import on the phone too)
        open_settings(phone)
        phone.click('#settingsDialog button:has-text("Import from Excel…")')
        phone.set_input_files('#archiveImportDialog input[type=file]', XLSX)
        phone.wait_for_selector('#archiveImportDialog .arch-sheet')
        phone.click('#archiveImportDialog button:has-text("Next: check")')
        phone.click('#archiveImportDialog button:has-text("Import 1 year")')
        phone.wait_for_selector('#archiveDialog[open]')
        phone.click('#archiveDialog .win-close')
        phone.click('#settingsDialog .sheet-head .icon-btn')
        phone.click('.summary-tools .find-btn')
        phone.wait_for_selector('#finderDialog[open]')
        find(phone, 'parking')
        pills = phone.eval_on_selector_all('#finderDialog .arch-chip:not([hidden])', 'els => els.map(e => e.textContent)')
        check('phone: only the pills with a match', pills == ['Nationwide', 'Chase'], pills)
        check('phone: a list, not a table', phone.locator('#finderDialog table').count() == 0 and phone.locator('#finderDialog .fd-item').count() == 2)
        item = phone.locator('#finderDialog .fd-item').nth(0).text_content()
        check('phone: history row shows icon, account and amount', phone.locator('#finderDialog .fd-item').nth(0).locator('.fd-hist').count() == 1 and 'Nationwide' in item and '−10.00' in item, item)
        width = phone.evaluate('document.querySelector("#finderDialog").scrollWidth - document.querySelector("#finderDialog").clientWidth')
        check('phone: no sideways scroll', width <= 0, width)
        phone.screenshot(path=f'{OUT}/v0150-2-find-phone.png')
        phone.click('#finderDialog .win-close')
        # a live entry on the phone → its account's list, flashed
        phone.click('.tab:has-text("Nationwide")')
        phone.wait_for_selector('#fab:not([hidden])')
        phone.click('#fab'); phone.wait_for_selector('#txDialog[open]')
        phone.fill('#txDialog .amount-input', '4')
        phone.fill('#txDialog input[placeholder="e.g. Lottery"]', 'Station parking')
        phone.fill('#txDialog input[type=date]', '2026-10-12')
        phone.click('#txDialog button[type=submit]')
        phone.wait_for_selector('#txDialog[open]', state='detached')
        phone.click('.tab:has-text("Summary")')
        phone.click('.summary-tools .find-btn')
        phone.wait_for_selector('#finderDialog[open]')
        find(phone, 'station')
        phone.click('#finderDialog .fd-item >> nth=0')
        phone.wait_for_selector('#finderDialog[open]', state='detached')
        phone.wait_for_timeout(300)
        fl = phone.locator('.feed .entry.flash')
        check('phone: live row → that account’s list, entry flashed', fl.count() == 1 and 'Station parking' in fl.text_content() and 'tab-active' in (phone.locator('.tab:has-text("Nationwide")').get_attribute('class') or ''))

        check('no console errors', not errors, errors)
        b.close()
finally:
    server.terminate()

bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)}/{len(checks)} checks passed')
sys.exit(1 if bad else 0)
