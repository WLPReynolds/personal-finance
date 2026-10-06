"""v0.12 — envelopes on the Monzo pots account.
An existing account with an entry made before envelopes → turn envelopes on
(opening shares, Unallocated remainder) → assign the old entry → interest
split evenly (spare pennies to the first) → a transfer from the current
account into two envelopes → a move between envelopes → one envelope's
history → a recurring transfer into Transport (projection tagged, end of
month counts it) → rename keeps entries; an envelope with entries can only
be hidden → desktop grid header + row tags, light and dark screenshots.
Clock fixed at Tue 6 Oct 2026. Run: python3 dev/e2e/envelopes_v012.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8774)
errors, checks = [], []
A, T, E, R = '#accountDialog', '#txDialog', '#envelopeDialog', '#recurringEditDialog'

def norm(t): return ' '.join((t or '').replace(',', '').split())
def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def toast_has(pg, text):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=6000)
def hide_toast(pg): pg.evaluate('() => { const e = document.getElementById("toast"); if (e) e.hidden = true; }')
def chips(pg): return norm(pg.inner_text('.banner-env') or '')
def tab(pg, name):
    pg.click(f'.tab:has-text("{name}")'); pg.wait_for_timeout(150)
def save(pg, dlg, text):
    hide_toast(pg); pg.click(f'{dlg} button[type=submit]'); toast_has(pg, text)
def env_rows(pg):
    return pg.evaluate('() => [...document.querySelectorAll("#envelopeDialog .env-table tbody tr")].map(r => r.innerText.replace(/\\s+/g," ").replace(/,/g,""))')

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
        ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
        pg = ctx.new_page()
        pg.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and 'gov.uk' not in m.text and errors.append(m.text))
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
        pg.clock.install(time=datetime.datetime(2026, 10, 6, 12, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')

        # ---- the Monzo account exists already, lumped, with an October entry
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("+ Add account")'); pg.wait_for_selector(f'{A}[open]')
        pg.fill(f'{A} input[placeholder="e.g. Monzo"]', 'Monzo pots')
        pg.select_option(f'{A} select >> nth=0', 'savings')
        pg.fill(f'{A} .field-pair .amount-input', '1000')
        pg.fill(f'{A} input[type=date]', '2026-10-01')
        check('envelopes are off for a new account', not pg.is_checked(f'{A} .env-settings input[type=checkbox]'))
        save(pg, A, 'Account added')
        pg.click('#settingsDialog .sheet-head .icon-btn')
        tab(pg, 'Monzo pots')
        pg.click('#fab'); pg.wait_for_selector(f'{T}[open]')
        check('no envelope field before envelopes are on', pg.is_hidden(f'{T} .env-field'))
        pg.fill(f'{T} .amount-input', '7'); pg.fill(f'{T} input[list=descList]', 'Parking'); pg.fill(f'{T} input[type=date]', '2026-10-03')
        save(pg, T, 'Added')

        # ---- turn envelopes on
        pg.click('.banner-edit:has-text("Account…")'); pg.wait_for_selector(f'{A}[open]')
        pg.check(f'{A} .env-settings input[type=checkbox]')
        rows = [('Maintenance', '200'), ('Health', '200'), ('Transport', '500'), ('Home Insurance', '')]
        for i, (n, v) in enumerate(rows):
            if i > 0: pg.click(f'{A} button:has-text("+ Add envelope")')
            pg.fill(f'{A} .env-set-row >> nth={i} >> .env-set-name', n)
            if v: pg.fill(f'{A} .env-set-row >> nth={i} >> .env-set-open', v)
        summ = norm(pg.text_content(f'{A} .env-set-summary'))
        check('summary: opening, in envelopes, Unallocated £100', 'Opening balance £1000.00 · in envelopes £900.00 · Unallocated £100.00' in summ, summ)
        pg.screenshot(path=f'{OUT}/v012_account_envelopes.png')
        save(pg, A, 'Account updated')
        c = chips(pg)
        check('banner chips: envelope balances', all(x in c for x in ['Maintenance £200.00', 'Health £200.00', 'Transport £500.00', 'Home Insurance £0.00']), c)
        check('banner: Unallocated with 1 entry to assign (£93 = £100 − £7)', 'Unallocated · 1 to assign £93.00' in c, c)
        tag = norm(pg.text_content('.feed .entry:has-text("Parking") .entry-link'))
        check('the old entry is tagged Unallocated', 'Unallocated' in tag, tag)
        pg.screenshot(path=f'{OUT}/v012_phone_unallocated.png')

        # ---- assign it from the Unallocated chip
        pg.click('.env-chip-unalloc'); pg.wait_for_selector(f'{E}[open]')
        check('Unallocated view says what to do', '1 entry is not in an envelope yet' in pg.text_content(E))
        pg.click(f'{E} .env-hist-row:has-text("Parking")'); pg.wait_for_selector(f'{T}[open]')
        check('entry form: envelope field, Unallocated selected', pg.eval_on_selector(f'{T} .env-select', 'e => e.value') == '')
        pg.select_option(f'{T} .env-select', label='Transport')
        save(pg, T, 'Updated')
        check('envelopes view redraws: nothing left to assign', 'Nothing in this envelope yet' in pg.text_content(E), norm(pg.text_content(E))[:200])
        pg.click(f'{E} .sheet-head .icon-btn')
        c = chips(pg)
        check('Transport £493.00, Unallocated £100.00 (no longer "to assign")', 'Transport £493.00' in c and 'Unallocated £100.00' in c and 'to assign' not in c, c)

        # ---- interest, split evenly
        pg.click('#fab'); pg.wait_for_selector(f'{T}[open]')
        pg.click(f'{T} .seg-btn[data-value=credit]')
        pg.fill(f'{T} .amount-input.big', '1.95'); pg.fill(f'{T} input[list=descList]', 'Interest')
        pg.select_option(f'{T} .env-select', '*split')
        pg.click(f'{T} button:has-text("Split evenly")')
        vals = pg.eval_on_selector_all(f'{T} .env-split-row input', 'es => es.map(e => e.value)')
        check('£1.95 split evenly → 0.49 0.49 0.49 0.48', vals == ['0.49', '0.49', '0.49', '0.48'], vals)
        check('"adds up" shown', 'Adds up to £1.95' in pg.text_content(f'{T} .env-left'))
        pg.fill(f'{T} .env-split-row >> nth=3 >> input', '0.40')
        check('a wrong split shows what is left', '£0.08 still to put in an envelope' in pg.text_content(f'{T} .env-left'))
        hide_toast(pg); pg.click(f'{T} button[type=submit]'); toast_has(pg, 'add up')
        check('…and is refused', pg.is_visible(f'{T}[open]'))
        pg.fill(f'{T} .env-split-row >> nth=3 >> input', '0.48')
        pg.screenshot(path=f'{OUT}/v012_split_interest.png')
        save(pg, T, 'Added')
        c = chips(pg)
        check('interest landed: M/H 200.49, T 493.49, HI 0.48', all(x in c for x in ['Maintenance £200.49', 'Health £200.49', 'Transport £493.49', 'Home Insurance £0.48']), c)

        # ---- a transfer from the current account into two envelopes
        tab(pg, 'Current Account')
        pg.click('#fab'); pg.wait_for_selector(f'{T}[open]')
        pg.fill(f'{T} .amount-input.big', '25.82'); pg.fill(f'{T} input[list=descList]', 'To pots')
        check('no envelope field on the current account by itself', pg.is_hidden(f'{T} .env-field'))
        pg.select_option(f'{T} .field select', label='Monzo pots')
        check('envelope field appears for the Monzo side', pg.is_visible(f'{T} .env-field') and 'Envelope · Monzo pots' in pg.text_content(f'{T} .env-field'))
        pg.select_option(f'{T} .env-select', label='Maintenance')
        pg.select_option(f'{T} .env-select', '*split')
        vals = pg.eval_on_selector_all(f'{T} .env-split-row input', 'es => es.map(e => e.value)')
        check('switching to Split starts from the envelope chosen', vals[0] == '25.82', vals)
        pg.fill(f'{T} .env-split-row >> nth=0 >> input', '14.16'); pg.fill(f'{T} .env-split-row >> nth=1 >> input', '11.66')
        save(pg, T, 'Added')
        tag = norm(pg.text_content('.feed .entry:has-text("To pots") .entry-link'))
        check('current account side has no envelope tag', 'Maintenance' not in tag, tag)
        tab(pg, 'Monzo pots')
        tag = norm(pg.text_content('.feed .entry:has-text("To pots") .entry-link'))
        check('Monzo side tagged Maintenance + Health', 'Maintenance + Health' in tag, tag)
        c = chips(pg)
        check('M £214.65, H £212.15', 'Maintenance £214.65' in c and 'Health £212.15' in c, c)
        # editing it from the current account keeps / shows the split
        tab(pg, 'Current Account')
        pg.click('.feed .entry:has-text("To pots")'); pg.wait_for_selector(f'{T}[open]')
        check('editing from the other side shows the split', pg.eval_on_selector(f'{T} .env-select', 'e => e.value') == '*split')
        pg.click(f'{T} .sheet-head .icon-btn')
        tab(pg, 'Monzo pots')

        # ---- move between envelopes
        pg.click('.env-chip-more'); pg.wait_for_selector(f'{E}[open]')
        r = env_rows(pg)
        check('envelopes table: today and end of month', any(x.startswith('Transport £493.49') for x in r), r)
        foot = norm(pg.inner_text(f'{E} tfoot'))
        check('total = account balance £1020.77', 'Monzo pots £1020.77' in foot, foot)
        pg.screenshot(path=f'{OUT}/v012_envelopes_dialog.png')
        pg.click(f'{E} button:has-text("Move between envelopes")'); pg.wait_for_selector(f'{T}[open]')
        pg.select_option(f'{T} select >> nth=0', label='Transport · £493.49')
        pg.select_option(f'{T} select >> nth=1', label='Health · £212.15')
        pg.fill(f'{T} .amount-input', '171.50'); pg.fill(f'{T} input[placeholder^="e.g. Glasses"]', 'Glasses')
        save(pg, T, 'Moved')
        r = env_rows(pg)
        check('move: Transport £321.99, Health £383.65', any(x.startswith('Transport £321.99') for x in r) and any(x.startswith('Health £383.65') for x in r), r)
        check('account total unchanged', 'Monzo pots £1020.77' in norm(pg.inner_text(f'{E} tfoot')))
        # one envelope's history
        pg.click(f'{E} .env-table tr:has-text("Transport")')
        hist = pg.evaluate('() => [...document.querySelectorAll("#envelopeDialog .env-hist-row")].map(r => r.innerText.replace(/\\s+/g," ").replace(/,/g,""))')
        check('Transport history: b/f 500, parking, interest, move', len(hist) == 4 and '£500.00' in hist[0] and '−£7.00 £493.00' in hist[1] and '+£0.49 £493.49' in hist[2] and '−£171.50 £321.99' in hist[3], hist)
        pg.screenshot(path=f'{OUT}/v012_envelope_history.png')
        pg.click(f'{E} .env-hist-row:has-text("Glasses")'); pg.wait_for_selector(f'{T}[open]')
        check('clicking a move opens the move dialog', 'Edit move' in pg.text_content(f'{T} h2'))
        pg.click(f'{T} .sheet-head .icon-btn')
        pg.click(f'{E} .sheet-head .icon-btn >> nth=-1')
        tag = norm(pg.text_content('.feed .entry:has-text("Glasses")'))
        check('phone list: the move shows from → to and "move"', 'Transport → Health £171.50' in tag and 'move' in tag, tag)

        # ---- recurring transfer into Transport
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog .btn-primary'); pg.wait_for_selector(f'{R}[open]')
        pg.fill(f'{R} input[placeholder="e.g. Netflix"]', 'Train fare/Parking')
        pg.click(f'{R} .seg-btn[data-value=transfer]')
        pg.select_option(f'{R} .field-pair select >> nth=0', label='Current Account')
        pg.select_option(f'{R} .field-pair select >> nth=1', label='Monzo pots')
        pg.fill(f'{R} input[placeholder="0.00"] >> nth=0', '462')
        check('recurring editor: envelope field for the Monzo side', pg.is_visible(f'{R} .env-field'))
        pg.select_option(f'{R} .env-select', label='Transport')
        pg.fill(f'{R} .field-pair input[inputmode=numeric] >> nth=0', '28')
        pg.fill(f'{R} input[type=date] >> nth=0', '2026-10-06')
        save(pg, R, 'Recurring item added')
        mline = norm(pg.text_content('#recurringDialog'))
        check('manager line names the envelope', 'Current Account → Monzo pots · Transport' in mline, mline[:300])
        pg.click('#recurringDialog .sheet-head .icon-btn'); pg.click('#settingsDialog .sheet-head .icon-btn')
        tag = norm(pg.text_content('.feed .entry.projected:has-text("Train fare") .entry-link'))
        check('projected entry tagged Transport', 'Transport' in tag, tag)
        pg.click('.env-chip-more'); pg.wait_for_selector(f'{E}[open]')
        r = env_rows(pg)
        check('end of month counts the projection (321.99 + 462 = 783.99)', any(x == 'Transport £321.99 £783.99' for x in r), r)
        pg.click(f'{E} .sheet-head .icon-btn')
        # tracker-style: single envelope only when the amount comes from the tracker
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog .rec-row:has-text("Train fare"), #recurringDialog button:has-text("Train fare")'); pg.wait_for_selector(f'{R}[open]')
        check('editor reopens with Transport', pg.eval_on_selector(f'{R} .env-select', 'e => e.options[e.selectedIndex].text') == 'Transport')
        pg.check(f'{R} input[type=checkbox] >> nth=1')
        opts = pg.eval_on_selector(f'{R} .env-select', 'e => [...e.options].map(o => o.value)')
        check('amount from the tracker: no Split option, envelope kept', '*split' not in opts and pg.eval_on_selector(f'{R} .env-select', 'e => e.options[e.selectedIndex].text') == 'Transport', opts)
        pg.click(f'{R} .sheet-head .icon-btn'); pg.click('#recurringDialog .sheet-head .icon-btn'); pg.click('#settingsDialog .sheet-head .icon-btn')

        # ---- rename and hide
        pg.click('.banner-edit:has-text("Account…")'); pg.wait_for_selector(f'{A}[open]')
        n = pg.eval_on_selector_all(f'{A} .env-set-row', 'rs => rs.map(r => [r.querySelector(".env-set-name").value, !!r.querySelector(".env-set-hide"), !!r.querySelector("button[title=Remove]")])')
        check('in-use envelopes offer Hide, unused offer remove', n == [['Maintenance', True, False], ['Health', True, False], ['Transport', True, False], ['Home Insurance', True, False]], n)
        pg.fill(f'{A} .env-set-row >> nth=2 >> .env-set-name', 'Train & parking')
        save(pg, A, 'Account updated')
        c = chips(pg)
        check('rename: balance kept under the new name', 'Train & parking £321.99' in c, c)
        tag = norm(pg.text_content('.feed .entry:has-text("Parking") .entry-link'))
        check('rename: entries follow', 'Train & parking' in tag, tag)
        pg.screenshot(path=f'{OUT}/v012_phone_list.png')

        # ---- desktop grid
        pg.set_viewport_size({'width': 1500, 'height': 900})
        pg.wait_for_selector('.grid')
        head = norm(pg.inner_text('th.acc-head:has-text("Monzo pots") .acc-env'))
        check('grid header: envelope balances', 'Maintenance £214.65' in head and 'Train & parking £321.99' in head and 'Unallocated £100.00' in head, head)
        tags = pg.eval_on_selector_all('.grid .env-tag', 'es => es.map(e => e.textContent.trim())')
        check('grid rows tagged (even interest split = All envelopes)', '· All envelopes' in tags and '· Train & parking' in tags and '· Maintenance + Health' in tags and any('→ Health £171.50' in t for t in tags), tags)
        # header stays aligned: sub-header sits right under the taller header
        al = pg.evaluate('() => { const h1 = document.querySelector(".grid thead tr:first-child th.acc-head").getBoundingClientRect(); const h2 = document.querySelector(".grid thead tr:nth-child(2) th").getBoundingClientRect(); return Math.abs(h1.bottom - h2.top); }')
        check('grid header rows line up with the taller header', al < 2, al)
        pg.screenshot(path=f'{OUT}/v012_grid_light.png')
        pg.click('th.acc-head .acc-env'); pg.wait_for_selector(f'{E}[open]')
        pg.screenshot(path=f'{OUT}/v012_grid_dialog.png')
        pg.click(f'{E} .sheet-head .icon-btn')
        pg.emulate_media(color_scheme='dark'); pg.wait_for_timeout(200)
        pg.screenshot(path=f'{OUT}/v012_grid_dark.png')
        pg.set_viewport_size({'width': 412, 'height': 915}); pg.wait_for_selector('.feed')
        pg.screenshot(path=f'{OUT}/v012_phone_dark.png')

        # ---- survives a reload
        pg.reload(); pg.wait_for_selector('.feed'); tab(pg, 'Monzo pots')
        c = chips(pg)
        check('after reload: same envelope balances', 'Train & parking £321.99' in c and 'Health £383.65' in c, c)
        b.close()
finally:
    server.terminate()

check('no console errors', not errors, errors)
bad = [c for c in checks if not c[1]]
print(f'\n{len(checks) - len(bad)}/{len(checks)} checks passed')
sys.exit(1 if bad else 0)
