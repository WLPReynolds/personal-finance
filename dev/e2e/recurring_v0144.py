"""v0.14.4 — recurring items page grouped by account (soonest first in each group),
an "All by date" switch that is remembered, and the weekend/bank-holiday choices worded
for money out / in / transfer ("Leave it on that day" is gone).
Clock fixed at Mon 5 Oct 2026. Run: python3 dev/e2e/recurring_v0144.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8774)
errors, checks = [], []
D = '#recurringEditDialog'
M = '#recurringDialog'

def norm(t): return (t or '').replace(',', '')
def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def saved(pg, text):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=5000)

def add_item(pg, desc, kind, amount, day, start, account, shift='none'):
    pg.click(f'{M} .btn-primary >> nth=0'); pg.wait_for_selector(f'{D}[open]')
    pg.fill(f'{D} input[placeholder="e.g. Netflix"]', desc)
    pg.click(f'{D} .seg-btn[data-value="{kind}"]')
    pg.select_option(f'{D} .field-pair select >> nth=0', label=account)
    pg.fill(f'{D} input[placeholder="0.00"]', amount)
    pg.fill(f'{D} input[placeholder="1–31"]', str(day))
    pg.fill(f'{D} input[type=date] >> nth=0', start)
    pg.select_option(f'{D} select >> nth=-1', value=shift)
    pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item added')

def names(pg):
    return pg.eval_on_selector_all(f'{M} .rec-active .rec-name', 'els => els.map(e => e.textContent)')
def heads(pg):
    return pg.eval_on_selector_all(f'{M} .rec-acc-head', 'els => els.map(e => e.textContent.replace(/\\s+/g, " ").trim())')
def shift_opts(pg):
    return pg.eval_on_selector_all(f'{D} select >> nth=-1 >> option', 'els => els.map(e => e.textContent)') if False else \
        pg.evaluate('(d) => [...document.querySelectorAll(d + " select")].pop() && [...[...document.querySelectorAll(d + " select")].pop().options].map(o => o.textContent)', D)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
        pg = ctx.new_page()
        pg.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and 'gov.uk' not in m.text and errors.append(m.text))
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
        pg.clock.install(time=datetime.datetime(2026, 10, 5, 12, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')

        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        acc_names = pg.eval_on_selector_all('#settingsDialog .acc-list-name', 'els => els.map(e => e.childNodes[0].textContent.trim())')
        print('accounts:', acc_names)
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector(f'{M}[open]')
        first, last = acc_names[0], acc_names[-1]

        # ---- editor wording (before any item exists: new item, default = money out)
        pg.click(f'{M} .btn-primary >> nth=0'); pg.wait_for_selector(f'{D}[open]')
        out_opts = shift_opts(pg)
        check('money out: "Take it …" wording', out_opts == ['Take it on that day anyway', 'Take it on the working day before', 'Take it on the next working day (e.g. direct debit)'], out_opts)
        pg.click(f'{D} .seg-btn[data-value="in"]')
        in_opts = shift_opts(pg)
        check('money in: "Expect it …" wording, salary example on "before"', in_opts == ['Expect it on that day anyway', 'Expect it on the working day before (e.g. salary)', 'Expect it on the next working day'], in_opts)
        pg.select_option(f'{D} select >> nth=-1', value='before')
        pg.click(f'{D} .seg-btn[data-value="transfer"]')
        tr_opts = shift_opts(pg)
        check('transfer: "Move it …" wording', tr_opts == ['Move it on that day anyway', 'Move it on the working day before', 'Move it on the next working day'], tr_opts)
        check('switching kind keeps the chosen rule (before)', pg.input_value(f'{D} select >> nth=-1') == 'before')
        check('nothing in the editor says "Leave it"', 'Leave it' not in pg.text_content(D))
        pg.click(f'{D} .seg-btn[data-value="in"]')
        pg.screenshot(path=f'{OUT}/g1-editor-money-in.png')
        pg.click(f'{D} .icon-btn')  # close without saving
        pg.wait_for_selector(f'{D}[open]', state='detached')

        # ---- items on two accounts; dates (clock 5 Oct): Gym 12 Oct, Salary 28 Oct, Council tax 1 Nov, Netflix 4 Nov
        add_item(pg, 'Netflix', 'out', '5.99', 4, '2026-10-01', first)
        add_item(pg, 'Gym', 'out', '30', 12, '2026-10-01', last)
        add_item(pg, 'Salary', 'in', '4000', 28, '2026-10-01', first, shift='before')
        add_item(pg, 'Council tax', 'out', '150', 1, '2026-10-01', first)

        check('default view is by account', pg.get_attribute(f'{M} .rec-group-seg .seg-btn >> nth=0', 'aria-checked') == 'true')
        h = heads(pg)
        check('two account headings, in account order', len(h) == 2 and h[0].startswith(first) and h[1].startswith(last), h)
        check('headings show how many', h[0].endswith('(3)') and h[1].endswith('(1)'), h)
        n = names(pg)
        check('grouped: first account soonest-first, then the other account', n == ['Salary', 'Council tax', 'Netflix', 'Gym'], n)
        check('every row sits under its own heading', pg.evaluate('''(M) => {
            const out = []; let cur = null;
            for (const el of document.querySelectorAll(M + ' .rec-acc-head, ' + M + ' .rec-active .rec-row')) {
              if (el.classList.contains('rec-acc-head')) cur = el.textContent; else out.push([cur.trim(), el.querySelector('.rec-name').textContent]);
            } return JSON.stringify(out); }''', M).count(first) >= 3)
        pg.screenshot(path=f'{OUT}/g2-manager-grouped.png')

        # ---- all by date
        pg.click(f'{M} .rec-group-seg .seg-btn >> nth=1')
        check('"All by date": no headings', len(heads(pg)) == 0)
        n = names(pg)
        check('"All by date": one list, soonest first across accounts', n == ['Gym', 'Salary', 'Council tax', 'Netflix'], n)
        check('switch shows the new choice', pg.get_attribute(f'{M} .rec-group-seg .seg-btn >> nth=1', 'aria-checked') == 'true')
        pg.screenshot(path=f'{OUT}/g3-manager-by-date.png')

        # remembered on this device: close, reload, reopen
        pg.click(f'{M} .icon-btn'); pg.click('#settingsDialog .icon-btn')
        pg.reload(); pg.wait_for_selector('.feed')
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector(f'{M}[open]')
        check('the choice is remembered after a reload', len(heads(pg)) == 0 and names(pg)[0] == 'Gym', names(pg))
        pg.click(f'{M} .rec-group-seg .seg-btn >> nth=0')
        check('back to by account', len(heads(pg)) == 2 and names(pg)[0] == 'Salary')

        # an item still opens, and saving it keeps the grouped view
        pg.click(f'{M} .rec-row:has-text("Gym")'); pg.wait_for_selector(f'{D}[open]')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); saved(pg, 'Recurring item updated')
        check('after editing an item the grouped view is still there', len(heads(pg)) == 2)
        # editing a money-in item shows the "Expect" wording with its own saved rule selected
        pg.click(f'{M} .rec-row:has-text("Salary")'); pg.wait_for_selector(f'{D}[open]')
        check('existing salary: "Expect…" wording and "before" selected', 'Expect it on the working day before (e.g. salary)' in shift_opts(pg) and pg.input_value(f'{D} select >> nth=-1') == 'before')
        pg.click(f'{D} .icon-btn')

    check('no console errors', not errors, errors)
finally:
    server.terminate()

bad = [l for l, ok in checks if not ok]
print(f'\n{len(checks) - len(bad)} passed, {len(bad)} failed')
sys.exit(1 if bad else 0)
