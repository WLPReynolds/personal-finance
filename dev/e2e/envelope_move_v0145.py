"""v0.14.5 — a recurring "Move between envelopes" (e.g. Chase: Bills -> Savings on payday).
Editor offers it only for accounts with envelopes -> projected each month with the From -> To tag, the
account balance unchanged -> the tap dialog explains it -> confirm makes a real move (envelopes change, balance
does not) -> skipped months count nothing -> manager row -> desktop grid -> the other kinds are unaffected.
Clock fixed at Tue 6 Oct 2026. Run: python3 dev/e2e/envelope_move_v0145.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8774)
errors, checks = [], []
A, T, R, M = '#accountDialog', '#txDialog', '#recurringEditDialog', '#recurringDialog'

def norm(t): return ' '.join((t or '').replace(',', '').split())
def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def toast_has(pg, text):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=6000)
def hide_toast(pg): pg.evaluate('() => { const e = document.getElementById("toast"); if (e) e.hidden = true; }')
def save(pg, dlg, text):
    hide_toast(pg); pg.click(f'{dlg} button[type=submit]'); toast_has(pg, text)
def tab(pg, name):
    pg.click(f'.tab:has-text("{name}")'); pg.wait_for_timeout(150)
def close_all(pg): pg.evaluate('() => document.querySelectorAll("dialog[open]").forEach((d) => d.close())'); pg.wait_for_timeout(150)
def chips(pg): return norm(pg.inner_text('.banner-env') or '')
def opts(pg, sel): return pg.locator(sel).first.evaluate('el => [...el.options].map(o => o.textContent)')

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
        fill_setup(pg, ['3600', '6', '1000'])
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')

        # ---- an account with two envelopes: Bills £600, Savings £400
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("+ Add account")'); pg.wait_for_selector(f'{A}[open]')
        pg.fill(f'{A} input[placeholder="e.g. Monzo"]', 'Chase')
        pg.select_option(f'{A} select >> nth=0', 'savings')
        pg.fill(f'{A} .field-pair .amount-input', '1000')
        pg.fill(f'{A} input[type=date]', '2026-10-01')
        pg.check(f'{A} .env-settings input[type=checkbox]')
        for i, (n, v) in enumerate([('Bills', '600'), ('Savings', '400')]):
            if i > 0: pg.click(f'{A} button:has-text("+ Add envelope")')
            pg.fill(f'{A} .env-set-row >> nth={i} >> .env-set-name', n)
            pg.fill(f'{A} .env-set-row >> nth={i} >> .env-set-open', v)
        save(pg, A, 'Account added')
        pg.click('#settingsDialog .sheet-head .icon-btn')

        # ---- editor: Move between envelopes
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector(f'{M}[open]')
        pg.click(f'{M} .btn-primary >> nth=0'); pg.wait_for_selector(f'{R}[open]')
        check('editor has a "Move between envelopes" choice', pg.is_visible(f'{R} .seg-btn[data-value="move"]'))
        check('envelope pickers are hidden until Move is chosen', pg.is_hidden(f'{R} .env-move-from'))
        pg.click(f'{R} .seg-btn[data-value="move"]')
        acct_opts = opts(pg, f'{R} .field-pair select')
        check('account list is only accounts that use envelopes', acct_opts == ['Chase'], acct_opts)
        check('From/To list that account\'s envelopes + Unallocated', opts(pg, f'{R} .env-move-from') == ['Bills', 'Savings', 'Unallocated'], opts(pg, f'{R} .env-move-from'))
        check('defaults: first envelope -> second', pg.input_value(f'{R} .env-move-from') != pg.input_value(f'{R} .env-move-to'))
        check('no ticket-tracker / statement option for a move', pg.is_hidden(f'{R} >> text=Take the amount from the ticket tracker'))
        check('payday wording offered', 'Move it on the working day before (e.g. payday)' in opts(pg, f'{R} select >> nth=-1'))
        pg.fill(f'{R} input[placeholder="e.g. Netflix"]', 'Bills to Savings')
        pg.fill(f'{R} input[placeholder="0.00"]', '50')
        pg.fill(f'{R} input[placeholder="1–31"]', '28')
        pg.fill(f'{R} input[type=date] >> nth=0', '2026-10-01')
        pg.select_option(f'{R} select >> nth=-1', value='before')
        prev = norm(pg.text_content(f'{R} .rec-preview'))
        check('preview shows 28 Oct first', '28 Oct 2026' in prev or 'Wed 28 Oct' in prev or '28 October' in prev, prev)
        pg.screenshot(path=f'{OUT}/v0145_editor_move.png')
        hide_toast(pg); pg.click(f'{R} button[type=submit]'); pg.wait_for_selector(f'{R}[open]', state='detached'); toast_has(pg, 'Recurring item added')

        row = norm(pg.text_content(f'{M} .rec-row:has-text("Bills to Savings")'))
        check('manager row names the account and both envelopes', 'Chase · Bills → Savings' in row, row)
        check('manager row shows the amount', '£50.00' in row, row)
        close_all(pg)

        # ---- phone list on the Chase tab
        tab(pg, 'Chase')
        pg.wait_for_selector('.entry.projected')
        rows = pg.eval_on_selector_all('.entry.projected', 'els => els.map(e => e.innerText.replace(/\\s+/g," ").replace(/,/g,""))')
        check('three months ahead shown as projected rows', len(rows) >= 3, rows)
        check('row tagged Bills → Savings £50.00 and "move"', 'Bills → Savings £50.00' in rows[0] and 'move' in rows[0], rows[0])
        banner = norm(pg.inner_text('.banner'))
        check('account balance is still £1000.00', '1000.00' in banner, banner)
        check('envelope chips unchanged before anything is confirmed', 'Bills' in chips(pg) and '600.00' in chips(pg) and '400.00' in chips(pg), chips(pg))
        pg.screenshot(path=f'{OUT}/v0145_phone_projected.png')

        # ---- tap the first projection
        pg.click('.entry.projected >> nth=0'); pg.wait_for_selector(f'{T}[open]')
        info = norm(pg.text_content(T))
        check('dialog says what it does and that the balance is unchanged', 'Moves money from Bills to Savings inside Chase' in info and 'balance doesn’t change' in info, info[:300])
        check('dialog has Confirm and Skip', pg.is_visible(f'{T} button:has-text("Confirm")') and pg.is_visible(f'{T} button:has-text("Skip this month")'))
        # confirm it dated today so "today's" envelope figures move
        pg.fill(f'{T} input[type=date]', '2026-10-06')
        hide_toast(pg); pg.click(f'{T} button:has-text("Confirm")'); toast_has(pg, 'Confirmed')
        pg.wait_for_timeout(250)
        c = chips(pg)
        check('after confirming: Bills 550.00 and Savings 450.00', '550.00' in c and '450.00' in c, c)
        check('account balance still £1000.00 after confirming', '1000.00' in norm(pg.inner_text('.banner')))
        projected = pg.eval_on_selector_all('.entry.projected', 'els => els.map(e => e.innerText.replace(/\\s+/g," ").replace(/,/g,""))')
        check('the confirmed month is no longer projected (November is next)', projected and 'Bills → Savings' in projected[0], projected)
        notes = pg.eval_on_selector_all('.entry-note:not(.projected)', 'els => els.map(e => e.innerText.replace(/\\s+/g," ").replace(/,/g,""))')
        check('a real move row exists', any('Bills to Savings' in n and 'Bills → Savings £50.00' in n for n in notes), notes)

        # ---- the confirmed row opens the ordinary move dialog (edit / delete)
        pg.click('.entry-note:not(.projected):has-text("Bills to Savings")'); pg.wait_for_selector(f'{T}[open]')
        check('confirmed move opens the normal Move dialog', 'Edit move' in norm(pg.text_content(T)))
        pg.click(f'{T} .icon-btn')

        # ---- skip the next month
        pg.click('.entry.projected >> nth=0'); pg.wait_for_selector(f'{T}[open]')
        hide_toast(pg); pg.click(f'{T} button:has-text("Skip this month")'); toast_has(pg, 'Skipped')
        skipped = pg.eval_on_selector_all('.entry.projected.skipped', 'els => els.length')
        check('a skipped month is shown as skipped', skipped == 1, skipped)

        # ---- envelopes dialog end of month includes the projected move (28 Oct is later this month)
        # (confirmed 6 Oct move only; next projected is November, skipped) -> end of Oct stays 550/450
        pg.click('.banner-env')  # opens the envelope overview
        pg.wait_for_selector('#envelopeDialog[open]')
        env_txt = norm(pg.text_content('#envelopeDialog'))
        check('envelope overview: Bills 550.00, Savings 450.00', '550.00' in env_txt and '450.00' in env_txt, env_txt[:200])
        pg.click('#envelopeDialog .icon-btn')

        # ---- editing the series keeps working, and other kinds are not affected
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector(f'{M}[open]')
        pg.click(f'{M} .rec-row:has-text("Bills to Savings")'); pg.wait_for_selector(f'{R}[open]')
        check('editing an existing move: kind, account and envelopes are remembered',
              pg.get_attribute(f'{R} .seg-btn[data-value="move"]', 'aria-checked') == 'true'
              and pg.input_value(f'{R} select >> nth=0') != '' and opts(pg, f'{R} .env-move-from') == ['Bills', 'Savings', 'Unallocated'])
        pg.click(f'{R} .seg-btn[data-value="out"]')
        check('switching to money out brings back all accounts', len(opts(pg, f'{R} .field-pair select')) >= 2, opts(pg, f'{R} .field-pair select'))
        check('...and hides the envelope From/To pair', pg.is_hidden(f'{R} >> text=From envelope'))
        pg.click(f'{R} .icon-btn')
        close_all(pg)

        # ---- desktop grid shows the same tag
        pg.set_viewport_size({'width': 1280, 'height': 900}); pg.wait_for_timeout(500)
        grid = norm(pg.inner_text('table') if pg.query_selector('table') else pg.inner_text('body'))
        check('desktop grid shows the move with both envelopes', 'Bills to Savings' in grid and 'Bills → Savings' in grid, grid[:300])
        pg.screenshot(path=f'{OUT}/v0145_grid.png')

    check('no console errors', not errors, errors)
finally:
    server.terminate()

bad = [l for l, ok in checks if not ok]
print(f'\n{len(checks) - len(bad)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
