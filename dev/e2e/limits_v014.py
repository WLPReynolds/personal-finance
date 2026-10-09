"""v0.14 — limits (Wayne, 8 Oct): overdraft limit + credit limit fields, a
warning (never a block) before saving something that takes an account past a
line within the dates shown, prominent flags on screen, and loan / credit
accounts (shown as owed; transfers out greyed out and refused).
Clock Thu 8 Oct 2026. Run: python3 dev/e2e/limits_v014.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8783)
errors, checks, dialogs = [], [], []
answer = {'accept': True}

def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def toast_has(pg, text, timeout=8000):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=timeout)
def watch(page, label):
    page.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and errors.append(f'{label} console: {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    def on_dialog(d):
        dialogs.append(d.message)
        d.accept() if answer['accept'] else d.dismiss()
    page.on('dialog', on_dialog)
def device(b, w, h, mobile, scheme='light'):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, is_mobile=mobile, has_touch=mobile, color_scheme=scheme)
    ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
    ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
    pg = ctx.new_page(); watch(pg, f'{w}px')
    pg.clock.install(time=datetime.datetime(2026, 10, 8, 19, 0, 0))
    pg.goto(URL)
    return pg
def head(pg, i): return pg.locator('.acc-head').nth(i)
def open_account(pg, i):
    head(pg, i).locator('.acc-name').click(); pg.wait_for_selector('#accountDialog[open]')
def save_account(pg):
    pg.click('#accountDialog button[type=submit]'); pg.wait_for_selector('#accountDialog[open]', state='detached')
def entry(pg, col, amount, desc, date, direction='debit', counterpart=None):
    head(pg, col).locator('.acc-add').click(); pg.wait_for_selector('#txDialog[open]')
    pg.click(f'#txDialog .seg-btn[data-value={direction}]')
    pg.fill('#txDialog .amount-input', amount)
    pg.fill('#txDialog input[placeholder="e.g. Lottery"]', desc)
    pg.fill('#txDialog input[type=date]', date)
    if counterpart: pg.select_option('#txDialog select', label=counterpart)
    pg.click('#txDialog button[type=submit]')
def grid_text(pg): return pg.text_content('table.grid')
def ledger(pg):
    return pg.evaluate("""() => new Promise((res) => { const r = indexedDB.open('finance-tracker', 1);
      r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').get('ledger'); q.onsuccess = () => res(q.result); }; })""")

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = device(b, 1440, 900, False)
        pg.wait_for_selector('.setup-form')
        for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['100', '0', '2500']): el.fill(v)
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('table.grid')

        # ---- account dialog: the new fields
        open_account(pg, 0)
        check('current account: overdraft limit field', pg.is_visible('#accountDialog .field:has-text("Arranged overdraft limit")'))
        check('current account: no credit limit field', not pg.is_visible('#accountDialog .field:has-text("Credit limit")'))
        types = pg.eval_on_selector_all('#accountDialog select >> nth=0 >> option', 'els => els.map(e => e.textContent)')
        check('account types include Loan / credit account', 'Loan / credit account' in types, types)
        pg.keyboard.press('Escape')
        open_account(pg, 2)
        check('card: credit limit field, no overdraft field', pg.is_visible('#accountDialog .field:has-text("Credit limit")') and not pg.is_visible('#accountDialog .field:has-text("Arranged overdraft")'))
        pg.fill('#accountDialog .field:has-text("Credit limit") input', '2600.00')
        save_account(pg)
        check('credit limit saved', [a for a in ledger(pg)['accounts'] if a['name'] == 'Barclaycard'][0].get('creditLimit') == 260000)

        # ---- recurring bill on the 20th
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog button:has-text("+ Add")'); pg.wait_for_selector('#recurringEditDialog[open]')
        ed = '#recurringEditDialog'
        pg.fill(f'{ed} input[placeholder="e.g. Netflix"]', 'Council tax')
        pg.fill(f'{ed} .amount-input >> nth=0', '50.00')
        pg.locator(f'{ed} input[type=date]').first.fill('2026-10-01')
        pg.locator(f'{ed} input[inputmode=numeric]').first.fill('20')
        pg.click(f'{ed} button[type=submit]'); pg.wait_for_selector(f'{ed}[open]', state='detached')
        pg.evaluate('() => document.querySelectorAll("dialog[open]").forEach(d => d.close())')

        # ---- Wayne's example: an entry for tomorrow that makes the account negative on 20 Oct
        dialogs.clear(); answer['accept'] = False
        entry(pg, 0, '60.00', 'Shopping', '2026-10-09')
        pg.wait_for_timeout(300)
        msg = dialogs[-1] if dialogs else ''
        check('warned before saving', 'Current Account goes overdrawn on Tue, 20 Oct' in msg or 'Current Account goes overdrawn on Tue 20 Oct' in msg, msg)
        check('warning says how far ahead it checked', 'Checked to' in msg and 'as far ahead as the screen shows' in msg)
        check('"Cancel" = not saved, the form stays open with what was typed', pg.is_visible('#txDialog[open]') and pg.input_value('#txDialog .amount-input') == '60.00' and 'Shopping' not in grid_text(pg))
        answer['accept'] = True
        pg.click('#txDialog button[type=submit]'); pg.wait_for_selector('#txDialog[open]', state='detached')
        toast_has(pg, 'Added')
        check('"Save anyway" saves it', 'Shopping' in grid_text(pg))
        lim = pg.text_content('.acc-head >> nth=0 >> .acc-lim') if pg.locator('.acc-head >> nth=0 >> .acc-lim').count() else ''
        check('header warns: Overdrawn from Tue 20 Oct (red)', 'Overdrawn from' in lim and '20 Oct' in lim and 'lim-alert' in pg.get_attribute('.acc-head >> nth=0 >> .acc-lim', 'class'), lim)
        red = pg.eval_on_selector_all('td.lim-alert', 'els => els.map(e => e.textContent)')
        check('the overdrawn balances are flagged red in the grid', '-10.00' in red or '−10.00' in red, red)

        # an unrelated save doesn't nag again
        dialogs.clear()
        entry(pg, 2, '5.00', 'Coffee', '2026-10-10')
        pg.wait_for_selector('#txDialog[open]', state='detached')
        check('an unrelated save isn’t warned about the existing problem', not any('overdrawn' in d for d in dialogs), dialogs)

        # ---- arranged overdraft: amber "into", red "past"
        open_account(pg, 0)
        pg.fill('#accountDialog .field:has-text("Arranged overdraft limit") input', '20.00')
        save_account(pg)
        toast_has(pg, 'Account updated')
        pg.wait_for_function('() => /Into overdraft/.test(document.querySelector(".acc-head .acc-lim")?.textContent ?? "")', timeout=5000)
        txt = pg.text_content('.acc-head >> nth=0 >> .acc-lim')
        # Council tax repeats, so by 20 Nov it really is past the £20 limit: both shown, the header red for the worse one
        check('with a £20 overdraft: header says into overdraft from 20 Oct, past the limit from 20 Nov', 'Into overdraft from Tue, 20 Oct' in txt and 'Past overdraft limit from Fri, 20 Nov' in txt, txt)
        amber = pg.eval_on_selector_all('td.lim-warn', 'els => els.map(e => e.textContent)')
        check('-£10 (inside the overdraft) is amber in the grid; -£60 (past it) red', '-10.00' in amber and '-60.00' in pg.eval_on_selector_all('td.lim-alert', 'els => els.map(e => e.textContent)'), amber)
        dialogs.clear()
        entry(pg, 0, '15.00', 'Taxi', '2026-10-22')
        pg.wait_for_selector('#txDialog[open]', state='detached')
        check('going past it warns (stronger wording)', any('PAST its £20.00 overdraft limit on Thu, 22 Oct' in d or 'PAST its £20.00 overdraft limit on Thu 22 Oct' in d for d in dialogs), dialogs)
        txt = pg.text_content('.acc-head >> nth=0 >> .acc-lim')
        check('header: into overdraft, then past the limit, in date order (red)', txt.index('Into overdraft') < txt.index('Past overdraft limit') and 'lim-alert' in pg.get_attribute('.acc-head >> nth=0 >> .acc-lim', 'class'), txt)

        # ---- card over its credit limit
        dialogs.clear()
        entry(pg, 2, '200.00', 'TV', '2026-10-12')
        pg.wait_for_selector('#txDialog[open]', state='detached')
        check('card over its credit limit: warned', any('OVER its £2,600.00 credit limit' in d for d in dialogs), dialogs)
        check('card header flags it', 'Over credit limit' in (pg.text_content('.acc-head >> nth=2 >> .acc-lim') or ''))
        pg.screenshot(path=f'{OUT}/v014-limits-1-grid.png')

        # ---- v0.14.1 (Wayne, 9 Oct): a big card spend also warned about the current account, without saying why.
        # The card is paid from Current Account by a "pay the statement balance" item: name that as the knock-on cause.
        open_account(pg, 2)
        pg.fill('#accountDialog input[placeholder="e.g. 13"]', '13')
        save_account(pg)
        pg.evaluate('() => document.querySelectorAll("dialog[open]").forEach(d => d.close())')
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog button:has-text("+ Add")'); pg.wait_for_selector('#recurringEditDialog[open]')
        pg.fill(f'{ed} input[placeholder="e.g. Netflix"]', 'Barclaycard payment')
        pg.click(f'{ed} .seg-btn:has-text("Transfer")')
        pg.locator(f'{ed} select').nth(0).select_option(label='Current Account')
        pg.locator(f'{ed} select').nth(1).select_option(label='Barclaycard')
        pg.check(f'{ed} label.check:has-text("Pay the statement balance") input')
        pg.locator(f'{ed} input[type=date]').first.fill('2026-10-01')
        dialogs.clear()
        pg.click(f'{ed} button[type=submit]'); pg.wait_for_selector(f'{ed}[open]', state='detached')
        pg.evaluate('() => document.querySelectorAll("dialog[open]").forEach(d => d.close())')
        dialogs.clear(); answer['accept'] = False  # Cancel: a test spend, not to be saved
        entry(pg, 2, '9999.99', 'Test spend', '2026-10-09')
        pg.wait_for_timeout(300)
        answer['accept'] = True
        m = dialogs[-1] if dialogs else ''
        check('big card spend: the card itself first', m.startswith('⚠ Barclaycard goes OVER its £2,600.00 credit limit'), m)
        check('…then the current account as a knock-on, naming the card payment', 'this also affects another account' in m and 'Current Account goes' in m and 'from “Barclaycard payment” (projected)' in m, m)
        check('Cancel: not saved, the form still open', pg.is_visible('#txDialog[open]') and 'Test spend' not in grid_text(pg))
        pg.evaluate('() => document.querySelectorAll("dialog[open]").forEach(d => d.close())')

        # ---- loan / credit account
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("+ Add account")'); pg.wait_for_selector('#accountDialog[open]')
        pg.fill('#accountDialog input[placeholder="e.g. Monzo"]', 'Car loan')
        pg.select_option('#accountDialog select >> nth=0', 'loan')
        check('loan: amount owed label, no limits, note shown', pg.is_visible('#accountDialog span:text-is("Amount owed at opening date (£)")') and not pg.is_visible('#accountDialog .field:has-text("overdraft")') and pg.is_visible('#accountDialog p:has-text("money can’t be transferred out")'))
        pg.fill('#accountDialog .field-pair:has-text("Amount owed") .amount-input', '4800.00')
        pg.fill('#accountDialog input[type=date]', '2026-10-01')
        save_account(pg)
        pg.evaluate('() => document.querySelectorAll("dialog[open]").forEach(d => d.close())')
        loan_acc = [a for a in ledger(pg)['accounts'] if a['name'] == 'Car loan'][0]
        check('loan stored as a negative balance (older versions read it right)', loan_acc['type'] == 'loan' and loan_acc['openingBalance'] == -480000, loan_acc['openingBalance'])
        li = [i for i, n in enumerate(pg.eval_on_selector_all('.acc-head .acc-name', 'els => els.map(e => e.textContent)')) if n == 'Car loan'][0]
        check('loan header: "Owed £4,800.00"', 'Owed £4,800.00' in pg.text_content(f'.acc-head >> nth={li} >> .acc-total'), pg.text_content(f'.acc-head >> nth={li} >> .acc-total'))
        # money out of the loan: transfer choices greyed out
        head(pg, li).locator('.acc-add').click(); pg.wait_for_selector('#txDialog[open]')
        seg = pg.eval_on_selector_all('#txDialog .seg-btn', 'els => els.map(e => e.textContent)')
        check('loan entry words: Charge / interest, Repayment', any('Charge / interest' in x for x in seg) and any('Repayment' in x for x in seg), seg)
        pg.click('#txDialog .seg-btn[data-value=debit]')
        dis = pg.eval_on_selector_all('#txDialog select option', 'els => els.filter(e => e.value).map(e => e.disabled)')
        check('charge on a loan: every transfer choice greyed out', dis and all(dis), dis)
        check('…and it says why', 'can’t be transferred out of a loan' in pg.text_content('#txDialog'))
        pg.fill('#txDialog .amount-input', '12.50'); pg.fill('#txDialog input[placeholder="e.g. Lottery"]', 'Interest'); pg.fill('#txDialog input[type=date]', '2026-10-31')
        pg.click('#txDialog button[type=submit]'); pg.wait_for_selector('#txDialog[open]', state='detached')
        toast_has(pg, 'Added')
        pg.wait_for_function('() => document.querySelector("table.grid").textContent.includes("Interest")')
        irow = pg.eval_on_selector_all('table.grid tbody tr', 'trs => trs.filter(t => t.textContent.includes("Interest")).map(t => t.textContent)')
        check('interest added as an entry; owed goes up to £4,812.50', irow and '4,812.50' in irow[0], irow)
        # a repayment from the current account is fine
        head(pg, 0).locator('.acc-add').click(); pg.wait_for_selector('#txDialog[open]')
        pg.click('#txDialog .seg-btn[data-value=credit]')
        loan_opt = pg.eval_on_selector('#txDialog select', 'el => [...el.options].find(o => o.textContent === "Car loan").disabled')
        check('money IN to current FROM the loan: greyed out', loan_opt is True)
        pg.click('#txDialog .seg-btn[data-value=debit]')
        loan_opt = pg.eval_on_selector('#txDialog select', 'el => [...el.options].find(o => o.textContent === "Car loan").disabled')
        check('money OUT of current INTO the loan (a repayment): allowed', loan_opt is False)
        pg.keyboard.press('Escape')

        # ---- converting an existing negative account into a loan: the figure flips, no amounts change
        pg.evaluate('() => document.querySelectorAll("dialog[open]").forEach(d => d.close())')
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("+ Add account")'); pg.wait_for_selector('#accountDialog[open]')
        pg.fill('#accountDialog input[placeholder="e.g. Monzo"]', 'Very')
        pg.fill('#accountDialog .field-pair:has-text("Opening balance") .amount-input', '-600.00')
        pg.fill('#accountDialog input[type=date]', '2026-10-01')
        save_account(pg)
        pg.evaluate('() => document.querySelectorAll("dialog[open]").forEach(d => d.close())')
        vi = [i for i, n in enumerate(pg.eval_on_selector_all('.acc-head .acc-name', 'els => els.map(e => e.textContent)')) if n == 'Very'][0]
        open_account(pg, vi)
        pg.select_option('#accountDialog select >> nth=0', 'loan')
        check('switching to Loan flips the figure to the amount owed', pg.input_value('#accountDialog .field-pair:has-text("Amount owed") .amount-input') == '600.00')
        dialogs.clear()
        save_account(pg)
        v = [a for a in ledger(pg)['accounts'] if a['name'] == 'Very'][0]
        check('converted: stored amount unchanged (-600.00), shown "Owed £600.00"', v['type'] == 'loan' and v['openingBalance'] == -60000 and 'Owed £600.00' in pg.text_content(f'.acc-head >> nth={vi} >> .acc-total'))
        check('a loan never raises an overdraft warning', not any('Very' in d for d in dialogs), dialogs)

        # ---- v0.14.1: a loan with envelopes (Wayne's Klarna / Monzo Flex: several reasons to borrow on one account)
        pg.evaluate('() => document.querySelectorAll("dialog[open]").forEach(d => d.close())')
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("+ Add account")'); pg.wait_for_selector('#accountDialog[open]')
        A = '#accountDialog'
        pg.fill(f'{A} input[placeholder="e.g. Monzo"]', 'Klarna')
        pg.fill(f'{A} .field-pair:has-text("Opening balance") .amount-input', '-300.00')
        pg.fill(f'{A} input[type=date]', '2026-10-01')
        pg.check(f'{A} .env-settings input[type=checkbox]')
        pg.fill(f'{A} .env-set-row >> nth=0 >> .env-set-name', 'Sofa'); pg.fill(f'{A} .env-set-row >> nth=0 >> .env-set-open', '-200.00')
        pg.click(f'{A} button:has-text("+ Add envelope")')
        pg.fill(f'{A} .env-set-row >> nth=1 >> .env-set-name', 'Laptop'); pg.fill(f'{A} .env-set-row >> nth=1 >> .env-set-open', '-100.00')
        pg.click(f'{A} button[type=submit]'); pg.wait_for_timeout(600)
        pg.wait_for_selector(f'{A}[open]', state='detached')
        pg.evaluate('() => document.querySelectorAll("dialog[open]").forEach(d => d.close())')
        pg.wait_for_function('() => [...document.querySelectorAll(".acc-head .acc-name")].some(e => e.textContent === "Klarna")', timeout=5000)
        ki = [i for i, n in enumerate(pg.eval_on_selector_all('.acc-head .acc-name', 'els => els.map(e => e.textContent)')) if n == 'Klarna'][0]
        open_account(pg, ki)
        check('loan: envelope settings offered', pg.is_visible(f'{A} .env-settings'))
        pg.select_option(f'{A} select >> nth=0', 'loan')
        flipped = pg.eval_on_selector_all(f'{A} .env-set-open', 'els => els.map(e => e.value)')
        check('switching to Loan flips the envelopes to amounts owed too', flipped == ['200.00', '100.00'] and pg.input_value(f'{A} .field-pair:has-text("Amount owed") .amount-input') == '300.00', flipped)
        summ = pg.text_content(f'{A} .env-set-summary')
        check('envelope summary adds up in owed terms (nothing unallocated)', 'Unallocated £0.00' in summ, summ)
        save_account(pg)
        k = [a for a in ledger(pg)['accounts'] if a['name'] == 'Klarna'][0]
        check('converted: account and envelope figures stored unchanged', k['type'] == 'loan' and k['openingBalance'] == -30000 and [e['openingBalance'] for e in k['envelopes']['list']] == [-20000, -10000], [e['openingBalance'] for e in k['envelopes']['list']])
        pg.wait_for_function('(i) => /Owed £300.00/.test(document.querySelectorAll(".acc-head")[i].textContent)', arg=ki, timeout=5000)
        hd = pg.text_content(f'.acc-head >> nth={ki}')
        check('grid header: Owed £300.00, Sofa £200.00, Laptop £100.00 (as owed, not minus)', 'Owed £300.00' in hd and 'Sofa£200.00' in hd.replace(' ', '') and 'Laptop£100.00' in hd.replace(' ', ''), hd)
        # a repayment into one envelope brings it down
        head(pg, 0).locator('.acc-add').click(); pg.wait_for_selector('#txDialog[open]')
        pg.fill('#txDialog .amount-input', '50.00'); pg.fill('#txDialog input[placeholder="e.g. Lottery"]', 'Klarna repayment'); pg.fill('#txDialog input[type=date]', '2026-10-08')
        pg.select_option('#txDialog .field select >> nth=0', label='Klarna')
        pg.select_option('#txDialog .env-select', label='Sofa')
        pg.click('#txDialog button[type=submit]'); pg.wait_for_selector('#txDialog[open]', state='detached')
        pg.wait_for_function('(i) => /Owed £250.00/.test(document.querySelectorAll(".acc-head")[i].textContent)', arg=ki, timeout=5000)
        hd = pg.text_content(f'.acc-head >> nth={ki}').replace(' ', '')
        check('repayment into Sofa: owed £250, Sofa £150', 'Owed£250.00' in hd and 'Sofa£150.00' in hd, hd)

        # ---- phone: banner line + flagged balances
        ph = device(b, 390, 844, True)
        # same browser storage? no — separate context; import by export instead
        with pg.expect_download() as dl:
            pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
            pg.click('#settingsDialog button:has-text("Download export")')
        ph.wait_for_selector('.setup-form')
        ph.set_input_files('#importInput', dl.value.path())
        ph.wait_for_selector('.feed', timeout=8000)
        ph.click('.tab:has-text("Current Account")')
        bl = ph.text_content('.banner-lim') if ph.locator('.banner-lim').count() else ''
        check('phone banner warns: into overdraft / past limit', 'Into overdraft' in bl and 'Past overdraft limit' in bl, bl)
        flagged = ph.eval_on_selector_all('.feed .entry-bal.lim-alert, .feed .entry-bal.lim-warn', 'els => els.length')
        check('phone: flagged balances in the list', flagged >= 2, flagged)
        ph.evaluate('window.scrollTo(0, 0)')
        ph.screenshot(path=f'{OUT}/v014-limits-2-phone.png')
        dark = device(b, 1440, 900, False, 'dark')
        dark.wait_for_selector('.setup-form'); dark.set_input_files('#importInput', dl.value.path()); dark.wait_for_selector('table.grid', timeout=8000)
        dark.screenshot(path=f'{OUT}/v014-limits-3-dark.png')
        b.close()
finally:
    server.terminate()

print()
print('errors:', errors if errors else 'none')
bad = [c for c in checks if not c[1]]
print(f'{len(checks) - len(bad)}/{len(checks)} checks passed')
sys.exit(1 if bad or errors else 0)
