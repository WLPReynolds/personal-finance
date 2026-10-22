"""v0.15.8 — expense claims (claude/expense-claims-design.md), the neutral
first-run "Set up your accounts", and the iPhone install step mentioning ≡.
Phone: set up a current account + MBNA, tick MBNA "Can have expense claims",
add a claim with a receipt photo and a part amount, move it To claim →
Submitted → Paid, "Add from recent entries", Share (download fallback here),
⚙ "Delete photos of paid claims" with its messages. Photos stay out of the
ledger. Clock: Thu 22 Oct 2026. Run: python3 dev/e2e/expenses_v0158.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime
from PIL import Image

server, URL = start_server(8791)
errors, checks, dialogs = [], [], []
JPG = os.path.join(OUT, 'receipt-e2e.jpg')
Image.new('RGB', (3000, 4000), (230, 220, 200)).save(JPG, quality=90)

def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def watch(page, label):
    page.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and errors.append(f'{label} console: {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    def on_dialog(d):
        dialogs.append(d.message); d.accept()
    page.on('dialog', on_dialog)
def device(b, w, h, mobile, ua=None):
    kw = dict(viewport={'width': w, 'height': h}, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile, accept_downloads=True)
    if ua: kw['user_agent'] = ua
    ctx = b.new_context(**kw)
    ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
    ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
    pg = ctx.new_page(); watch(pg, f'{w}px')
    pg.clock.install(time=datetime.datetime(2026, 10, 22, 19, 0, 0))
    pg.goto(URL)
    return pg
def ledger_json(pg):
    return pg.evaluate("""() => new Promise((res) => { const r = indexedDB.open('finance-tracker'); r.onsuccess = () => {
      const g = r.result.transaction('kv').objectStore('kv').get('ledger'); g.onsuccess = () => res(JSON.stringify(g.result)); }; })""")
def photo_count(pg):
    return pg.evaluate("""() => new Promise((res) => { const r = indexedDB.open('finance-tracker-photos'); r.onsuccess = () => {
      const g = r.result.transaction('meta').objectStore('meta').count(); g.onsuccess = () => res(g.result); }; })""")
def add_entry(pg, amount, desc, date):
    pg.click('#fab'); pg.wait_for_selector('#txDialog[open]')
    pg.fill('#txDialog .amount-input.big', amount)
    pg.fill('#txDialog input[list=descList]', desc)
    pg.fill('#txDialog input[type=date]', date)
def save_entry(pg):
    pg.click('#txDialog button[type=submit]'); pg.wait_for_function("!document.getElementById('txDialog').open")
    pg.wait_for_timeout(300)

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = device(b, 390, 844, True)

        # ---- first run: neutral
        pg.wait_for_selector('.setup-form')
        txt = pg.text_content('.setup-form')
        check('first run says "Set up your accounts"', 'Set up your accounts' in txt, txt[:60])
        words = pg.text_content('.setup-form > p') + pg.text_content('.setup-form h2') + ''.join(pg.eval_on_selector_all('.setup-form input', 'els => els.map(e => e.value + e.placeholder)'))
        picked = pg.eval_on_selector_all('.setup-form select', 'els => els.map(e => e.selectedOptions[0].textContent)')
        check('no Budget sheet, Nationwide or Barclaycard in the wording or filled in', not any(w in words for w in ['Budget', 'Nationwide', 'Barclaycard']) and 'Nationwide' not in picked and 'Barclaycard' not in picked, picked)
        check('the first account starts blank, one account only', pg.input_value('.setup-account input[type=text]') == '' and pg.locator('.setup-account').count() == 1)
        pg.screenshot(path=f'{OUT}/v0158-1-setup.png')
        pg.click('.setup-form button[type=submit]')
        check('nothing named → a message, no accounts made', pg.locator('.setup-form').count() == 1)
        fill_setup(pg, ['1000', '0'], [('Current account', 'current', 'other'), ('MBNA', 'credit', 'mbna')])
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')
        tabs = pg.eval_on_selector_all('.tab-name', 'els => els.map(e => e.textContent)')
        check('the two accounts as named', tabs[-2:] == ['Current account', 'MBNA'], tabs)

        # ---- no claims anywhere until an account is ticked
        pg.click('.tab:has-text("MBNA")'); pg.wait_for_selector('.feed')
        check('no Claims… button before the tick', pg.locator('.banner-claims').count() == 0)
        add_entry(pg, '10', 'Coffee', '2026-10-20')
        check('no Business expense box before the tick', not pg.is_visible('#txDialog .exp-fields'))
        save_entry(pg)
        pg.click('.banner-edit:has-text("Account")'); pg.wait_for_selector('#accountDialog[open]')
        pg.check('#accountDialog label.check:has-text("Can have expense claims") input')
        pg.click('#accountDialog button[type=submit]'); pg.wait_for_function("!document.getElementById('accountDialog').open")
        pg.wait_for_selector('.banner-claims')
        check('ticked: an Expense claims line on the MBNA header', 'Expense claims: nothing to claim' in pg.text_content('.banner-claims'))

        # ---- a claim with a part amount and a photo
        add_entry(pg, '189', 'Premier Inn', '2026-10-12')
        check('Business expense box on a money-out entry', pg.is_visible('#txDialog .exp-fields'))
        pg.click('#txDialog .seg-btn[data-value=credit]')
        check('…not on money in', not pg.is_visible('#txDialog .exp-fields'))
        pg.click('#txDialog .seg-btn[data-value=debit]')
        pg.check('#txDialog .exp-fields label.check input')
        pg.fill('#txDialog .exp-details', 'Room only, not the bar')
        pg.fill('#txDialog .exp-fields .amount-input', '200')
        pg.set_input_files('#txDialog .exp-fields input[type=file]', JPG)
        pg.wait_for_selector('#txDialog .exp-thumb img[src^="blob:"]')
        pg.screenshot(path=f'{OUT}/v0158-2-entry.png', full_page=True)
        pg.click('#txDialog button[type=submit]')
        check('claim more than the entry is refused', pg.is_visible('#txDialog[open]') and 'can’t be more' in (pg.text_content('#toast') or ''), pg.text_content('#toast'))
        pg.fill('#txDialog .exp-fields .amount-input', '145')
        save_entry(pg)
        pg.wait_for_timeout(500)
        check('the photo is stored on the device', photo_count(pg) == 1)
        lj = ledger_json(pg)
        check('the claim is on the entry', '"details":"Room only, not the bar"' in lj and '"amount":14500' in lj)
        check('no photo data or ids in the ledger', 'photo' not in lj.lower() and 'image/' not in lj)
        pg.wait_for_timeout(200)
        check('a 🧾 mark on the entry in the list', pg.locator('.entry:has-text("Premier Inn") .exp-mark').count() == 1)
        sz = pg.evaluate("""() => new Promise((res) => { const r = indexedDB.open('finance-tracker-photos'); r.onsuccess = () => {
          const g = r.result.transaction('meta').objectStore('meta').getAll(); g.onsuccess = () => res(g.result[0].size); }; })""")
        check('the photo was shrunk (well under the original)', sz < os.path.getsize(JPG) and sz < 600_000, sz)

        add_entry(pg, '23.50', 'Fuel', '2026-10-13'); save_entry(pg)

        # ---- the claim list
        pg.click('.banner-claims'); pg.wait_for_selector('#claimsDialog[open]')
        heads = pg.eval_on_selector_all('#claimsDialog .exp-head', 'els => els.map(e => e.textContent)')
        check('sections with count and total', heads == ['To claim · 1£145.00', 'Submitted · 0£0.00', 'Paid · 0£0.00'], heads)
        row = pg.text_content('#claimsDialog .exp-toClaim .exp-row')
        check('row: date, description, amount, camera mark, details', all(x in row for x in ['12/10/26', 'Premier Inn', '£145.00', '📷', 'Room only', 'part of £189.00']), row)
        pg.screenshot(path=f'{OUT}/v0158-3-list.png')

        # ---- ⚙ clean-up before anything's paid
        pg.click('#claimsDialog .win-close')
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        check('⚙ Expense claims section', pg.locator('#settingsDialog h3:has-text("Expense claims")').count() == 1)
        pg.click('#settingsDialog button:has-text("Delete photos of paid claims")'); pg.wait_for_timeout(300)
        check('clean-up with none paid nudges to mark Paid', dialogs and dialogs[-1].startswith('No claims are marked as paid yet'), dialogs[-1:])
        pg.click('#settingsDialog button:has-text("Claim list")'); pg.wait_for_selector('#claimsDialog[open]')

        pg.click('#claimsDialog .exp-toClaim .exp-tick:has-text("Submitted")'); pg.wait_for_timeout(400)
        check('ticked → Submitted', pg.locator('#claimsDialog .exp-submitted .exp-row').count() == 1)
        pg.click('#claimsDialog .exp-submitted .exp-tick:has-text("Paid")'); pg.wait_for_timeout(400)
        check('ticked → Paid (collapsed, with its total)', 'Paid · 1£145.00' in pg.text_content('#claimsDialog .exp-paid .exp-head'))
        pg.click('#claimsDialog .exp-paid .exp-head .btn-link'); pg.wait_for_timeout(200)
        pg.click('#claimsDialog .exp-paid .exp-tick.on'); pg.wait_for_timeout(400)
        check('untick goes back one step (Paid → Submitted)', pg.locator('#claimsDialog .exp-submitted .exp-row').count() == 1)
        pg.click('#claimsDialog .exp-submitted .exp-tick:has-text("Paid")'); pg.wait_for_timeout(400)
        check('photo kept through the status changes', photo_count(pg) == 1)

        # ---- Add from recent entries
        pg.click('#claimsDialog button:has-text("Add from recent entries")')
        cands = pg.eval_on_selector_all('#claimsDialog .exp-desc', 'els => els.map(e => e.textContent)')
        check('recent money-out entries that aren’t claims, newest first', cands == ['Coffee', 'Fuel'], cands)
        pg.check('#claimsDialog .exp-row:has-text("Fuel") input'); pg.check('#claimsDialog .exp-row:has-text("Coffee") input')
        pg.click('#claimsDialog button:has-text("Fill in 2 claims")'); pg.wait_for_selector('#txDialog[open]')
        check('each opens with Business expense ticked, "Claim 1 of 2"', pg.is_checked('#txDialog .exp-fields label.check input') and 'Claim 1 of 2' in pg.text_content('#txDialog'))
        check('…oldest first (Fuel)', pg.input_value('#txDialog input[list=descList]') == 'Fuel')
        pg.fill('#txDialog .exp-details', 'Mileage — client visit'); save_entry(pg)
        pg.wait_for_selector('#txDialog[open]')
        check('then the next one (Coffee, 2 of 2)', pg.input_value('#txDialog input[list=descList]') == 'Coffee' and 'Claim 2 of 2' in pg.text_content('#txDialog'))
        save_entry(pg)
        heads = pg.eval_on_selector_all('#claimsDialog .exp-head', 'els => els.map(e => e.textContent)')
        check('both now To claim', heads[0] == 'To claim · 2£33.50', heads)

        # ---- Share (no Share sheet for files here → photos downloaded, text copied)
        pg.click('#claimsDialog button:has-text("Select to share")')
        pg.click('#claimsDialog .exp-paid .exp-head .btn-link') if pg.locator('#claimsDialog .exp-paid .exp-row').count() == 0 else None
        pg.check('#claimsDialog .exp-row:has-text("Premier Inn") .exp-pick')
        pg.evaluate("() => { navigator.share = undefined; }")
        with pg.expect_download() as dl:
            pg.click('#claimsDialog .exp-sharebar button:has-text("Share")')
        check('share fallback downloads the photo, named by date and description', dl.value.suggested_filename == '2026-10-12-Premier-Inn.jpg', dl.value.suggested_filename)
        pg.click('#claimsDialog .win-close')

        # ---- clean-up with a paid claim (⚙ is still open under the claim list)
        pg.wait_for_selector('#settingsDialog[open]')
        pg.click('#settingsDialog button:has-text("Delete photos of paid claims")'); pg.wait_for_timeout(500)
        check('clean-up asks with count and size', dialogs[-1].startswith('Delete 1 photo (') and 'of 1 paid claim' in dialogs[-1], dialogs[-1][:60])
        check('…and deletes it, claim kept', photo_count(pg) == 0 and '"status":"paid"' in ledger_json(pg))
        pg.click('#settingsDialog button:has-text("Delete photos of paid claims")'); pg.wait_for_timeout(300)
        check('again: nothing to delete', dialogs[-1].startswith('Nothing to delete'), dialogs[-1][:40])

        # ---- untick the account: hidden, not deleted
        pg.click('#settingsDialog .acc-list li:has-text("MBNA") button:has-text("Edit")'); pg.wait_for_selector('#accountDialog[open]')
        pg.uncheck('#accountDialog label.check:has-text("Can have expense claims") input')
        pg.click('#accountDialog button[type=submit]'); pg.wait_for_timeout(400)
        check('unticked: no Expense claims in ⚙, no Claims…', pg.locator('#settingsDialog h3:has-text("Expense claims")').count() == 0)
        check('…but the claims are still on the entries', ledger_json(pg).count('"expense"') == 3)

        # ---- grid header button when ticked again
        pg.click('#settingsDialog .acc-list li:has-text("MBNA") button:has-text("Edit")'); pg.wait_for_selector('#accountDialog[open]')
        pg.check('#accountDialog label.check:has-text("Can have expense claims") input')
        pg.click('#accountDialog button[type=submit]'); pg.wait_for_timeout(300)
        pg.click('#settingsDialog .seg-btn:has-text("Grid")'); pg.wait_for_timeout(300)
        pg.click('#settingsDialog .sheet-head button[aria-label=Close]')
        pg.wait_for_selector('table.grid')
        check('grid: 🧾 button on the ticked account only', pg.locator('.acc-claims').count() == 1)
        check('grid: 🧾 mark on claim rows', pg.locator('table.grid .exp-mark').count() == 3)
        sw = pg.evaluate('document.documentElement.scrollWidth')

        # ---- iPhone install steps
        ip = device(b, 390, 844, True, ua='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')
        ip.wait_for_selector('#installHint')
        ip.click('#installHint button:has-text("Show me how")'); ip.wait_for_selector('#installDialog[open]')
        s1 = ip.text_content('#installDialog .install-step >> nth=0')
        check('iPhone step 1 mentions Share and the three-lines (≡) button in the address bar', 'Share' in s1 and '≡' in s1 and 'address bar' in s1, s1)
        ip.screenshot(path=f'{OUT}/v0158-4-install.png')
        b.close()
finally:
    server.terminate()

print('\nerrors:', '; '.join(errors) or 'none')
print(f'{sum(ok for _, ok in checks)}/{len(checks)} checks passed')
sys.exit(0 if all(ok for _, ok in checks) and not errors else 1)
