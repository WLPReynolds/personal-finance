"""v0.15.26 — "This month" card at the top of the phone Summary (Wayne, 27 Nov;
Project doc claude/summary-card-design.md): left until payday, payday countdown
from the item ticked "This is my pay", spent this month against last month to the
same day, the next 7 days' bills, and limit warnings. Phone only.
Clock Fri 20 Nov 2026. Run: python3 dev/e2e/month_card_v01526.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8796)
errors, checks = [], []
D = '#recurringEditDialog'
M = '#recurringDialog'

def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def device(b, w, h, mobile, scheme='light'):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, is_mobile=mobile, has_touch=mobile, color_scheme=scheme, landing_summary=True)
    ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
    ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
    pg = ctx.new_page()
    pg.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and 'gov.uk' not in m.text and errors.append(f'{w}px console: {m.text}'))
    pg.on('pageerror', lambda e: errors.append(f'{w}px pageerror: {e}'))
    pg.on('dialog', lambda d: d.accept())
    pg.clock.install(time=datetime.datetime(2026, 11, 20, 12, 0, 0))
    pg.goto(URL)
    return pg, ctx
def setup(pg, amounts=('1500', '0', '0')):
    fill_setup(pg, list(amounts))
    pg.fill('.setup-form input[type=date]', '2026-10-01')
    pg.click('.setup-form button[type=submit]')
def card(pg): return (pg.text_content('.month-card') or '').replace(' ', ' ')
def spend(pg, tab, amount, desc, date):
    pg.click(f'.tab:has-text("{tab}")'); pg.wait_for_selector('.feed')
    pg.click('#fab'); pg.wait_for_selector('#txDialog[open]')
    pg.fill('#txDialog .amount-input', amount); pg.fill('#txDialog input[placeholder="e.g. Lottery"]', desc); pg.fill('#txDialog input[type=date]', date)
    pg.click('#txDialog button[type=submit]'); pg.wait_for_selector('#txDialog[open]', state='detached')
def add_item(pg, desc, kind, amount, day, start, account, shift='none', pay=False):
    pg.click(f'{M} .btn-primary >> nth=0'); pg.wait_for_selector(f'{D}[open]')
    pg.fill(f'{D} input[placeholder="e.g. Netflix"]', desc)
    pg.click(f'{D} .seg-btn[data-value="{kind}"]')
    visible = pg.is_visible(f'{D} .is-pay')
    pg.select_option(f'{D} .field-pair select >> nth=0', label=account)
    pg.fill(f'{D} input[placeholder="0.00"]', amount)
    pg.fill(f'{D} input[placeholder="1–31"]', str(day))
    pg.fill(f'{D} input[type=date] >> nth=0', start)
    pg.select_option(f'{D} select >> nth=-1', value=shift)
    if pay: pg.check(f'{D} .is-pay')
    pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached')
    return visible
def summary(pg):
    pg.click('.tab >> nth=0'); pg.wait_for_selector('.month-card')

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ph, _ = device(b, 390, 844, True)
        setup(ph)
        ph.wait_for_selector('.month-card', timeout=8000)
        check('Summary opens with the This month card above the account cards',
              ph.evaluate('() => { const m = document.querySelector(".month-card"), s = document.querySelector(".summary"); return !!(m.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING); }'))
        c = card(ph)
        check('no pay ticked: hint instead of payday', 'This is my pay' in c and 'Payday' not in c, c)
        check('nothing spent yet', 'Spent this month£0.00' in c, c)
        check('no comparison in the first full month… (Oct is full, so Nov compares)', 'last month at this point' in c, c)

        spend(ph, 'Current Account', '25.00', 'Shop', '2026-10-05')
        spend(ph, 'Current Account', '99.00', 'Late Oct', '2026-10-25')
        spend(ph, 'Current Account', '40.00', 'Shop', '2026-11-03')
        spend(ph, 'Barclaycard', '12.50', 'Coffee', '2026-11-10')
        summary(ph)

        # hint link opens Recurring items; add pay + rent
        ph.click('.month-card .mc-hint .btn-link'); ph.wait_for_selector(f'{M}[open]')
        check('the hint opens Recurring items', ph.is_visible(f'{M}[open]'))
        out_has = add_item(ph, 'Rent', 'out', '1700.00', 25, '2026-11-01', 'Current Account')
        in_has = add_item(ph, 'Salary', 'in', '2500.00', 28, '2026-11-01', 'Current Account', shift='before', pay=True)
        check('“This is my pay” only offered for money in', in_has and not out_has, (in_has, out_has))
        rec = ph.text_content(M)
        check('manager row says “your pay”', 'your pay' in rec, rec)
        ph.click(f'{M} .sheet-head .icon-btn'); ph.wait_for_selector(f'{M}[open]', state='detached')
        ph.wait_for_timeout(200)

        c = card(ph)
        check('payday Fri 27 Nov (Sat 28th → working day before): in 7 days', 'Payday in 7 days' in c and 'Fri 27 Nov' in c, c)
        check('left until payday = balance at the end of Thu 26 Nov: 1500 − 25 − 99 − 40 − 1700', '−£364.00' in c or '-£364.00' in c, c)
        check('… shown in red', 'neg' in ph.get_attribute('.mc-amount', 'class'))
        check('spent this month 40 + 12.50 card (card payments/transfers aside)', 'Spent this month£52.50' in c, c)
        check('compared with last month to the 20th (£25): £27.50 over', '£27.50 over last month at this point' in c, c)
        check('no joint line while the joint account is off', ph.locator('.mc-joint').count() == 0)
        bills = ph.eval_on_selector_all('.mc-bill', 'els => els.map(e => e.textContent.replace(/\\u00a0/g, " "))')
        check('next 7 days: Rent on Wed 25 Nov (salary is money in: not listed)', len(bills) == 1 and 'Rent' in bills[0] and 'Wed 25 Nov' in bills[0] and '£1,700.00' in bills[0], bills)
        warns = ph.eval_on_selector_all('.mc-warn', 'els => els.map(e => e.textContent)')
        check('warning: Current Account overdrawn from 25 Nov', any('Current Account overdrawn from Wed 25 Nov' in w for w in warns), warns)
        ph.screenshot(path=f'{OUT}/v01526-month-card-light.png', full_page=True)

        ph.click('.mc-bill >> nth=0'); ph.wait_for_selector('dialog[open]')
        check('tap a bill → its month opens', 'Rent' in (ph.text_content('dialog[open]') or ''))
        ph.keyboard.press('Escape'); ph.wait_for_timeout(200)
        if ph.locator('dialog[open] .icon-btn').count(): ph.click('dialog[open] .icon-btn')
        ph.wait_for_selector('dialog[open]', state='detached')
        ph.click('.mc-warn >> nth=0'); ph.wait_for_selector('.feed')
        check('tap a warning → that account', 'Current Account' in ph.text_content('.tab-active'))
        summary(ph)

        # (pay today: Fri 27 Nov)
        ph.clock.set_fixed_time(datetime.datetime(2026, 11, 27, 12, 0, 0))
        ph.reload(); ph.wait_for_selector('.month-card')
        c = card(ph)
        check('on payday: “Payday today”, counting to the next (Thu 24 Dec, Christmas rules)', 'Payday today' in c and 'Next: Thu 24 Dec' in c, c)

        # dark + narrow, no sideways scroll
        dk, _ = device(b, 360, 780, True, 'dark')
        setup(dk); dk.wait_for_selector('.month-card')
        sw = dk.evaluate('document.documentElement.scrollWidth')
        check('360px dark: no sideways scroll', sw <= 360, sw)
        dk.screenshot(path=f'{OUT}/v01526-month-card-dark.png')

        desk, _ = device(b, 1440, 900, False)
        setup(desk, ('0', '0', '0')); desk.wait_for_selector('table.grid')
        check('desktop: no This month card (phone only for now)', desk.locator('.month-card').count() == 0)
        b.close()
finally:
    server.terminate()

print()
print('errors:', errors if errors else 'none')
bad = [c for c in checks if not c[1]]
print(f'{len(checks) - len(bad)}/{len(checks)} checks passed')
sys.exit(1 if bad or errors else 0)
