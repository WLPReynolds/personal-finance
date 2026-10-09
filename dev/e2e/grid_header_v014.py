"""v0.14 — grid header stays aligned when scrolled (Wayne, 7 Oct: "when I'm in grid
view and scroll down, the alignment goes a bit off"). A card with statements
makes the account header taller than its 92px minimum; the Credit/Debit row
must stick exactly under it, level with the bottom of the Date/Description
block. Before the fix --head1 was measured before the "…at end of" lines were
filled in, so it came out a line short. Run: python3 dev/e2e/grid_header_v014.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime
server, URL = start_server(8795)
checks = []
def check(label, ok, detail=''):
    checks.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
M = '''() => { const t = document.querySelector("table.grid"); const r1 = t.querySelector("thead tr:nth-child(1)"); const sub = t.querySelector("thead tr:nth-child(2) th");
  const left = t.querySelector("thead th.sticky-l"); const eom = t.querySelector(".acc-eom");
  return { head1Var: getComputedStyle(t).getPropertyValue("--head1"), row1H: Math.round(r1.getBoundingClientRect().height),
    subTop: Math.round(sub.getBoundingClientRect().top), subBottom: Math.round(sub.getBoundingClientRect().bottom), leftBottom: Math.round(left.getBoundingClientRect().bottom), eom: eom.textContent }; }'''
try:
  with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 700}, color_scheme='dark')
    pg = ctx.new_page(); pg.clock.install(time=datetime.datetime(2026,10,7,9,0,0)); pg.goto(URL)
    pg.wait_for_selector('.setup-form')
    for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600','6','1000']): el.fill(v)
    pg.fill('.setup-form input[type=date]', '2026-10-01')
    pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('table.grid')
    for i in range(30):
        pg.click('.acc-add >> nth=0'); pg.wait_for_selector('#txDialog[open]')
        pg.fill('#txDialog .amount-input', '1.00'); pg.fill('#txDialog input[placeholder="e.g. Lottery"]', f'Item {i}')
        pg.fill('#txDialog input[type=date]', f'2026-10-{1 + i % 28:02d}')
        pg.click('#txDialog button[type=submit]'); pg.wait_for_selector('#txDialog[open]', state='detached')
    # Barclaycard gets statements -> an extra header line, so the header row grows past 92px
    pg.click('.acc-head >> nth=2 >> .acc-name'); pg.wait_for_selector('#accountDialog[open]')
    pg.fill('#accountDialog input[placeholder="e.g. 13"]', '13'); pg.click('#accountDialog button[type=submit]')
    pg.wait_for_selector('#accountDialog[open]', state='detached')
    pg.reload(); pg.wait_for_selector('table.grid'); pg.wait_for_timeout(400)
    pg.evaluate('document.querySelector(".grid-wrap").scrollTop = 0'); pg.wait_for_timeout(300)
    a = pg.evaluate(M)
    check('header taller than the 92px minimum (statement line)', a['row1H'] > 92, a['row1H'])
    check('sticky offset = real header height', a['head1Var'] == f"{a['row1H']}px", a)
    pg.evaluate('document.querySelector(".grid-wrap").scrollTop = 400'); pg.wait_for_timeout(300)
    s2 = pg.evaluate(M)
    check('scrolled: Credit/Debit row level with the Date/Description block', s2['subBottom'] == s2['leftBottom'], s2)
    check('scrolled: Credit/Debit row sits right under the account headers', s2['subTop'] == a['subTop'], (a['subTop'], s2['subTop']))
    pg.screenshot(path=f'{OUT}/v014-grid-header-scrolled.png', clip={'x':0,'y':60,'width':900,'height':260})
finally:
    server.terminate()
print(f'{sum(checks)}/{len(checks)} checks passed')
sys.exit(0 if all(checks) else 1)
