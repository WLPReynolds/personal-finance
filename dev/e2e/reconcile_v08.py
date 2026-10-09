"""v0.8 — reconciling. Barclaycard statement on the phone (tick to balance,
hide ticked, next statement, edit warning), a current account by closing
date, ✓ markers, the grid header (alignment + ✓ button) and the recurring
manager's top Add button. Clock fixed at Sun 25 Oct 2026 (the 19 Oct
statement has been produced). Run: python3 dev/e2e/reconcile_v08.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8772)
errors, checks, dialogs = [], [], []
R = '#reconcileDialog'

def norm(t): return (t or '').replace(',', '')
def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def saved(pg, text):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=5000)
def watch(page, label):
    page.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and errors.append(f'{label} console: {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    def on_dialog(d):
        dialogs.append(d.message); d.accept()
    page.on('dialog', on_dialog)
def add_spend(pg, amount, desc, date, which=None):
    pg.click('#fab'); pg.wait_for_selector('#txDialog[open]')
    pg.fill('#txDialog .amount-input', amount)
    pg.fill('#txDialog input[placeholder="e.g. Lottery"]', desc)
    pg.fill('#txDialog input[type=date]', date)
    if which: pg.click(f'#txDialog .stmt-choice .seg-btn:has-text("{which}")')
    pg.click('#txDialog button[type=submit]')
    pg.wait_for_selector('#txDialog[open]', state='detached')
    pg.wait_for_function('d => [...document.querySelectorAll(".feed .entry")].some(e => e.textContent.trim().startsWith(d))', arg=desc, timeout=5000)
def summary(pg): return norm(pg.text_content(f'{R} .recon-summary'))
def rows(pg): return pg.eval_on_selector_all(f'{R} .recon-row', 'els => els.map(e => e.querySelector(".recon-desc").textContent + "|" + e.querySelector("input").checked)')
def tick(pg, desc):
    before = pg.text_content(f'{R} .recon-count')
    pg.click(f'{R} .recon-row:has-text("{desc}") input')
    pg.wait_for_function('b => document.querySelector("#reconcileDialog .recon-count")?.textContent !== b', arg=before, timeout=5000)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
        pg = ctx.new_page(); watch(pg, 'phone')
        pg.clock.install(time=datetime.datetime(2026, 10, 25, 12, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')

        # ---- recurring manager: Add at the top, no duplicate at the bottom while empty
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector('#recurringDialog[open]')
        check('recurring: + Add in the header', pg.is_visible('#recurringDialog .sheet-head .rec-add-top'))
        check('recurring: only one Add button while empty', pg.locator('#recurringDialog .btn-primary').count() == 1)
        pg.click('#recurringDialog .rec-add-top'); pg.wait_for_selector('#recurringEditDialog[open]')
        check('top Add opens the editor', 'New recurring item' in pg.text_content('#recurringEditDialog'))
        pg.click('#recurringEditDialog .icon-btn'); pg.click('#recurringDialog .sheet-head .icon-btn'); pg.click('#settingsDialog .icon-btn')

        # ---- Barclaycard: statements on, entries
        pg.click('.tab:has-text("Barclaycard")'); pg.wait_for_timeout(200)
        pg.click('.banner-edit >> nth=0'); pg.wait_for_selector('#accountDialog[open]')
        pg.fill('#accountDialog input[placeholder="e.g. 13"]', '13')
        pg.click('#accountDialog button[type=submit]'); saved(pg, 'Account updated')
        add_spend(pg, '50', 'Groceries', '2026-10-10')
        add_spend(pg, '20', 'Fuel', '2026-10-19')
        add_spend(pg, '10', 'Amazon', '2026-10-19', which='Next')

        # ---- reconcile the 19 Oct statement
        check('banner has Reconcile…', pg.is_visible('.banner-rec'))
        pg.click('.banner-rec'); pg.wait_for_selector(f'{R}[open]')
        sel = pg.eval_on_selector(f'{R} select.recon-period', 'e => e.options[e.selectedIndex].text')
        check('opens on the 19 Oct statement', norm(sel) == '19 Oct 2026', sel)
        check('lists Groceries and Fuel (Amazon is on the next one)', rows(pg) == ['Groceries|false', 'Fuel|false'], rows(pg))
        s = summary(pg)
        check('app works out £1070.00 owed, ticked £1000.00', '£1070.00 owed' in s and 'Ticked so far£1000.00 owed' in s, s)
        check('asks for the statement figure', 'Type in the amount owed' in s, s)
        pg.fill(f'{R} .recon-bank', '1,070.00')
        s = summary(pg)
        check('difference +£70.00 before ticking', 'Difference +£70.00' in s, s)
        pg.screenshot(path=f'{OUT}/rc1-statement-unticked.png')
        tick(pg, 'Groceries')
        check('typed figure kept after a tick', pg.input_value(f'{R} .recon-bank') == '1,070.00')
        check('difference +£20.00 after Groceries', 'Difference +£20.00' in summary(pg), summary(pg))
        tick(pg, 'Fuel')
        check('balanced after both', '✓ Balanced' in summary(pg), summary(pg))
        check('2 of 2 ticked', '2 of 2' in pg.text_content(f'{R} .recon-count'))
        pg.screenshot(path=f'{OUT}/rc2-statement-balanced.png')
        pg.fill(f'{R} .recon-bank', '1072')
        s = summary(pg)
        check('wrong figure: difference and a missing-entry hint', 'Difference +£2.00' in s and 'differ by £2.00' in s, s)
        pg.fill(f'{R} .recon-bank', 'abc')
        check('bad figure explained', 'Enter the figure like' in summary(pg))
        pg.check(f'{R} .recon-count input')
        check('hide ticked: nothing left', 'Everything here is ticked' in pg.text_content(R))
        pg.uncheck(f'{R} .recon-count input')
        # next statement: Amazon
        pg.select_option(f'{R} select.recon-period', value='2026-11')
        check('Nov statement lists Amazon', rows(pg) == ['Amazon|false'], rows(pg))
        check('Nov statement not produced yet: (so far)', '18 Nov 2026 (so far)' in norm(pg.eval_on_selector(f'{R} select.recon-period', 'e => e.options[e.selectedIndex].text')))
        pg.click(f'{R} .sheet-head .icon-btn')

        # ---- ✓ marks in the phone list
        marked = pg.eval_on_selector_all('.feed .entry', 'els => els.filter(e => e.querySelector(".rec-tick")).map(e => e.querySelector(".desc-text").textContent)')
        check('phone list: ✓ on Groceries and Fuel only', sorted(marked) == ['Fuel', 'Groceries'], marked)
        pg.screenshot(path=f'{OUT}/rc3-phone-feed.png', full_page=True)

        # ---- editing a reconciled entry: warn, then untick
        pg.click('.feed .entry:has-text("Fuel")'); pg.wait_for_selector('#txDialog[open]')
        check('edit dialog says reconciled', 'Reconciled — matched against the bank' in pg.text_content('#txDialog'))
        pg.fill('#txDialog input[placeholder="e.g. Lottery"]', 'Fuel (Tesco)')
        n = len(dialogs)
        pg.click('#txDialog button[type=submit]'); pg.wait_for_selector('#txDialog[open]', state='detached'); saved(pg, 'Updated')
        check('description change: no warning, still ticked', len(dialogs) == n and pg.locator('.feed .entry:has-text("Fuel (Tesco)") .rec-tick').count() == 1)
        pg.click('.feed .entry:has-text("Fuel (Tesco)")'); pg.wait_for_selector('#txDialog[open]')
        pg.fill('#txDialog .amount-input', '21')
        pg.click('#txDialog button[type=submit]'); pg.wait_for_selector('#txDialog[open]', state='detached'); saved(pg, 'Updated')
        check('amount change: warned first', len(dialogs) == n + 1 and 'has been reconciled' in dialogs[-1], dialogs[-1:])
        try:  # the previous "Updated" toast may still be up — wait for the redraw itself
            pg.wait_for_function('() => [...document.querySelectorAll(".feed .entry")].some(e => e.textContent.includes("Fuel (Tesco)") && e.textContent.includes("21.00") && !e.querySelector(".rec-tick"))', timeout=5000)
            ok = True
        except Exception:
            ok = False
        check('…and unticked', ok)

        # ---- statement dialog links to reconcile
        pg.click('.feed .entry-stmt >> nth=0'); pg.wait_for_selector('#txDialog[open]')
        pg.click('#txDialog button:has-text("Reconcile this statement")'); pg.wait_for_selector(f'{R}[open]')
        check('statement dialog → reconcile, Fuel back to unticked', rows(pg) == ['Groceries|true', 'Fuel (Tesco)|false'], rows(pg))
        pg.click(f'{R} .sheet-head .icon-btn')

        # ---- current account by closing date
        pg.click('.tab:has-text("Current Account")'); pg.wait_for_timeout(200)
        add_spend(pg, '12.50', 'Lunch', '2026-10-20')
        pg.click('.banner-rec'); pg.wait_for_selector(f'{R}[open]')
        check('current account: closing date defaults to today', pg.input_value(f'{R} input.recon-period') == '2026-10-25')
        check('current: Lunch listed', rows(pg) == ['Lunch|false'], rows(pg))
        pg.fill(f'{R} .recon-bank', '3587.50')
        tick(pg, 'Lunch')
        check('current: balanced', '✓ Balanced' in summary(pg), summary(pg))
        pg.fill(f'{R} input.recon-period', '2026-10-15'); pg.dispatch_event(f'{R} input.recon-period', 'change')
        pg.wait_for_function('() => document.querySelector("#reconcileDialog .recon-count").textContent.includes("0 of 0")')
        check('current: earlier closing date has nothing', 'No entries in this period' in pg.text_content(R))
        pg.fill(f'{R} .recon-bank', '-5')
        check('negative figure accepted', 'Difference −£3605.00' in summary(pg), summary(pg))
        pg.click(f'{R} .sheet-head .icon-btn')

        # ---- desktop grid
        desk = ctx.new_page(); watch(desk, 'desktop')
        desk.clock.install(time=datetime.datetime(2026, 10, 25, 12, 0, 0))
        desk.set_viewport_size({'width': 1440, 'height': 900})
        desk.goto(URL); desk.wait_for_selector('.grid'); desk.wait_for_timeout(300)
        geo = desk.evaluate('''() => [...document.querySelectorAll('.acc-head')].map(th => ({
            bar: th.querySelector('.acc-bar').getBoundingClientRect().top,
            name: th.querySelector('.acc-name').getBoundingClientRect().top,
            total: th.querySelector('.acc-total').getBoundingClientRect().top,
            bottom: th.getBoundingClientRect().bottom }))''')
        check('header: accent bars level', len({round(g['bar']) for g in geo}) == 1, geo)
        check('header: names level', len({round(g['name']) for g in geo}) == 1, [g['name'] for g in geo])
        check('header: balances level', len({round(g['total']) for g in geo}) == 1, [g['total'] for g in geo])
        sub_top = desk.evaluate('() => document.querySelector(".grid thead tr:nth-child(2) th").getBoundingClientRect().top')
        check('Credit/Debit row sits right under the headers', abs(sub_top - max(g['bottom'] for g in geo)) <= 1, (sub_top, geo))
        # still right after scrolling (sticky offset)
        desk.evaluate('() => { const w = document.querySelector(".grid-wrap"); w.scrollTop = w.scrollHeight; }'); desk.wait_for_timeout(200)
        head_bottom = desk.evaluate('() => document.querySelector(".acc-head").getBoundingClientRect().bottom')
        sub_top2 = desk.evaluate('() => document.querySelector(".grid thead tr:nth-child(2) th").getBoundingClientRect().top')
        check('…and while scrolled (no overlap)', abs(sub_top2 - head_bottom) <= 1, (sub_top2, head_bottom))
        desk.evaluate('() => { document.querySelector(".grid-wrap").scrollTop = 0; }')
        check('grid header: ✓ reconcile button per account', desk.locator('.acc-rec').count() == 3)
        rec_cells = desk.eval_on_selector_all('.grid td.cell.is-rec', 'els => els.map(e => e.closest("tr").querySelector(".c-desc").textContent)')
        check('grid: ✓ on Groceries and Lunch', sorted(rec_cells) == ['Groceries', 'Lunch'], rec_cells)
        desk.screenshot(path=f'{OUT}/rc4-grid-header.png', clip={'x': 0, 'y': 0, 'width': 1440, 'height': 260})
        desk.click('.acc-rec >> nth=2'); desk.wait_for_selector(f'{R}[open]')
        check('grid ✓ opens Barclaycard reconcile', 'Reconcile · Barclaycard' in desk.text_content(R))
        desk.screenshot(path=f'{OUT}/rc5-desktop-dialog.png')
        desk.click(f'{R} .recon-row:has-text("Fuel") input')
        desk.wait_for_timeout(300)
        desk.emulate_media(color_scheme='dark'); desk.wait_for_timeout(200)
        desk.screenshot(path=f'{OUT}/rc6-dark-dialog.png')
        desk.click(f'{R} .sheet-head .icon-btn'); desk.wait_for_timeout(200)
        desk.screenshot(path=f'{OUT}/rc7-dark-grid.png', clip={'x': 0, 'y': 0, 'width': 1440, 'height': 420})
        b.close()
finally:
    server.terminate()

print(f'\n{sum(ok for _, ok in checks)}/{len(checks)} checks passed; {len(errors)} errors')
for e in errors: print('  ERR', e)
sys.exit(0 if all(ok for _, ok in checks) and not errors else 1)
