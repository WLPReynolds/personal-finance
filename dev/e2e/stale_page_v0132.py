"""v0.13.2 — a page a version behind the code (half-arrived deploy).
1. Current page: adding a credit card saves ("Account added"), no update banner.
2. Old page (index.html without the envelope dialog or the version stamp, as
   served for a few minutes after a deploy): the "Finishing an update" banner
   shows, adding the same card still says "Account added" (v0.13.1 said
   "Couldn't save: Cannot read properties of null (reading 'open')"), and the
   account is still there after a reload.
Run: python3 dev/e2e/stale_page_v0132.py"""
from common import *
from playwright.sync_api import sync_playwright

server, URL = start_server(8781)
checks = []
A = '#accountDialog'

def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def toast_text(pg):
    pg.wait_for_function('() => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent; }', timeout=6000)
    return pg.text_content('#toast')

def old_page(route):
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    html = re.sub(r'.*envelopeDialog.*\n', '', html)
    html = re.sub(r'.*app-version.*\n', '', html)
    route.fulfill(status=200, body=html, content_type='text/html')

def add_card(pg, name):
    pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
    pg.click('#settingsDialog button:has-text("+ Add account")'); pg.wait_for_selector(f'{A}[open]')
    pg.fill(f'{A} input[type=text] >> nth=0', name)
    sels = pg.query_selector_all(f'{A} select'); sels[0].select_option('credit'); sels[1].select_option(label='Monzo Flex')
    pg.fill(f'{A} input.amount-input >> nth=0', '10')
    pg.fill(f'{A} input[placeholder="e.g. 13"]', '1')
    pg.fill(f'{A} input[placeholder="25"]', '8')  # payment days (by placeholder: v0.14 added limit boxes before it)
    pg.click(f'{A} button[type=submit]')
    return toast_text(pg)

def account_names(pg):
    return pg.evaluate('''() => new Promise((res) => {
      const r = indexedDB.open('finance-tracker');
      r.onsuccess = () => { try {
        const db = r.result, names = [...db.objectStoreNames];
        const tx = db.transaction(names, 'readonly'); const out = [];
        names.forEach((n) => { const g = tx.objectStore(n).getAll(); g.onsuccess = () => out.push(...g.result); });
        tx.oncomplete = () => res(JSON.stringify(out));
      } catch (e) { res(String(e)); } };
      r.onerror = () => res('');
    })''')

with sync_playwright() as p:
    b = p.chromium.launch()
    # 1. current page
    ctx = b.new_context(viewport={'width': 1400, 'height': 900}, service_workers='block')
    pg = ctx.new_page(); pg.goto(URL); pg.wait_for_timeout(800)
    check('current page: no update banner', pg.query_selector('#updateBanner') is None)
    msg = add_card(pg, 'Flex A')
    check('current page: card saves', msg == 'Account added', msg)
    ctx.close()

    # 2. old page
    ctx = b.new_context(viewport={'width': 1400, 'height': 900}, service_workers='block')
    ctx.route(re.compile(r'.*/(index\.html)?$'), old_page)
    pg = ctx.new_page(); pg.goto(URL); pg.wait_for_timeout(800)
    banner = pg.query_selector('#updateBanner')
    check('old page: "Finishing an update" banner shows', banner is not None and 'Finishing an update' in banner.inner_text())
    check('old page: banner has a reload button', pg.is_visible('#updateBanner button:has-text("Tap to reload")'))
    pg.screenshot(path=os.path.join(OUT, 'v0132-stale-banner.png'))
    msg = add_card(pg, 'Flex B')
    check('old page: card still saves, no false "Couldn\'t save"', msg == 'Account added', msg)
    check('old page: card on screen', pg.locator('text=Flex B').count() > 0)
    pg.reload(); pg.wait_for_timeout(800)
    check('old page: card still there after reload', 'Flex B' in account_names(pg))
    ctx.close()
    b.close()

server.terminate()
bad = [l for l, ok in checks if not ok]
print(f'\n{len(checks) - len(bad)}/{len(checks)} passed')
sys.exit(1 if bad else 0)
