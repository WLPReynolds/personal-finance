"""v0.14.6 — money back after confirming (top-up) and brought-forward ring-fence. Based on tickets_v013.py.
v0.13 — ticket purchases on the card (spec: claude/ticket-purchases-spec.md).
Settings section (defaults, start date = the day it's switched on), tickets read
from the tracker's file, Bought — confirm (amber), forecasts, confirming (card
spend + ring-fence), the money back before the payment, ring-fencing a parking
spend by hand, an overdue ticket in red on today, a confirmed ticket that's gone
from the tracker in red, the grid. Drive emulator + fake sign-in.
Clock: Tue 6 Oct 2026, later Thu 22 Oct. Run: python3 dev/e2e/tickets_v013.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8776)
errors, checks = [], []

def norm(t): return ' '.join((t or '').replace(',', '').split())
def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def toast_has(pg, text):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=8000)
def hide_toast(pg): pg.evaluate('() => { const e = document.getElementById("toast"); if (e) e.hidden = true; }')

PRICE = 15360
def tk(status, vf, vt, pd): return dict(id=('p-' if status == 'bought' else 'f-') + vf, validFrom=vf, validTo=vt, purchaseDate=pd, pricePence=PRICE, status=status)
TICKETS = [tk('bought', '2026-09-23', '2026-10-06', '2026-09-22'), tk('bought', '2026-10-07', '2026-10-20', '2026-10-06'),
           tk('projected', '2026-10-21', '2026-11-03', '2026-10-20'), tk('projected', '2026-11-04', '2026-11-17', '2026-11-03'),
           tk('projected', '2026-11-18', '2026-12-01', '2026-11-17'), tk('projected', '2026-12-02', '2026-12-15', '2026-12-01')]
def period(start, end):
    return dict(paydayMonth=start[:7], start=start, end=end, status='projected', ticketCount=2, ticketPence=30720, parkingDays=18, parkingPence=11502, totalPence=42222)
def tracker_file(tickets):
    return json.dumps(dict(format='transport-estimates', version=1, generatedAt='2026-10-06T21:07:27.610Z',
        source=dict(app='ticket-tracker', appVersion='v2026-10-06.21:57'), assumptions=dict(ticketPricePence=PRICE, parkingDayPence=639),
        periods=[period('2026-09-28', '2026-10-27'), period('2026-10-28', '2026-11-26'), period('2026-11-27', '2026-12-23')], tickets=tickets))
def put_tracker(text):
    for f in drive.values():
        if f['name'] == 'transport-estimates.json':
            f['text'] = text; f['version'] += 1; return
    drive['trk-folder'] = dict(name='Ticket Tracker Backups', parent='root', folder=True, text=None, version=1, trashed=False, mime='application/vnd.google-apps.folder')
    drive['trk-file'] = dict(name='transport-estimates.json', parent='trk-folder', folder=False, text=text, version=1, trashed=False, mime='application/json')

def tab(pg, name):
    pg.click(f'.tabs .tab:has-text("{name}")'); pg.wait_for_selector(f'.tabs .tab-active:has-text("{name}")')
def entries(pg):
    return pg.evaluate('() => [...document.querySelectorAll(".feed .entry")].map(e => ({ cls: e.className, text: e.innerText.replace(/\\s+/g," ").replace(/,/g,"") }))')
def banner(pg): return norm(pg.text_content('.banner .banner-amount'))
def open_settings(pg):
    pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
def close_settings(pg): pg.click('#settingsDialog .sheet-head .icon-btn')
def bg(pg, sel):
    return pg.evaluate('s => getComputedStyle(document.querySelector(s)).backgroundColor', sel)
def is_reddish(c):
    m = re.findall(r'[\d.]+', c or '')
    if len(m) < 3: return False
    r, g, b_ = map(float, m[:3])
    if max(r, g, b_) <= 1: r, g, b_ = r * 255, g * 255, b_ * 255
    return r > g + 15 and r > b_ + 15

ledger_file = os.path.join(OUT, 'ticket-start.json')
with open(ledger_file, 'w') as fh:
    fh.write(subprocess.check_output(['node', 'dev/e2e/make_ticket_ledger.mjs'], cwd=ROOT, text=True))

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.add_init_script(FAKE_AUTH)
        ctx.route('https://www.googleapis.com/**', handle)
        ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
        ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
        pg = ctx.new_page()
        pg.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and 'gov.uk' not in m.text and errors.append(m.text))
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('dialog', lambda d: d.accept())
        pg.clock.install(time=datetime.datetime(2026, 10, 6, 21, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        pg.set_input_files('#importInput', ledger_file); pg.wait_for_selector('.feed')

        put_tracker(tracker_file(TICKETS))
        open_settings(pg)
        pg.click('#settingsDialog button:has-text("Connect Google Drive")')
        pg.wait_for_function('() => /Synced/.test(document.getElementById("syncChip").textContent)', timeout=8000)

        # ---- settings
        sec = '#ticketSection'
        pg.check(f'{sec} label.check input')
        opts = pg.evaluate(f'() => [...document.querySelectorAll("{sec} select")[4].options].map(o => o.text + "|" + o.selected)')
        check('statement choices: Sep and Oct, Oct preselected', len(opts) == 2 and '17 Sep' in opts[0].replace(',', '') and 'Mon 19 Oct 2026' in opts[1].replace(',', '') and opts[1].endswith('|true'), opts)
        pg.fill(f'{sec} input[inputmode=decimal]', '153.60')
        pg.locator(sec).screenshot(path=f'{OUT}/m1-settings.png')
        hide_toast(pg); pg.click('#ticketSave')
        pg.wait_for_function('() => /Ticket purchases come from it too/.test(document.getElementById("settingsDialog").textContent)', timeout=8000)
        close_settings(pg)
        open_settings(pg)
        check('brought-forward amount kept after save', pg.input_value(f'{sec} input[inputmode=decimal]') == '153.60')
        close_settings(pg)

        tab(pg, 'Safe keeping')
        es = entries(pg)
        ret = [e['text'] for e in es if 'Ring-fenced money back' in e['text']]
        check('12 Nov money back = 22 Sep (by hand) + 6 Oct ticket = £307.20', any('307.20' in t for t in ret), ret)
        pg.click('.feed .entry:has-text("Ring-fenced money back") >> nth=0'); pg.wait_for_selector('#txDialog[open]')
        dt = norm(pg.text_content('#txDialog'))
        check('dialog lists the by-hand amount', 'Ring-fenced by hand before you started' in dt and pg.input_value('#txDialog .amount-input') == '307.20', dt[:400])
        hide_toast(pg); pg.click('#txDialog button[type=submit]'); toast_has(pg, 'Confirmed')
        es = entries(pg)
        check('confirmed: no projected money back for Oct left', not any('Ring-fenced money back' in e['text'] and 'projected' in e['text'] and '12 Nov' in e['text'] for e in es))

        # parking ring-fenced after confirming → a top-up
        tab(pg, 'Barclaycard')
        hide_toast(pg)
        pg.click('#fab') if pg.is_visible('#fab') else pg.click('.fab')
        pg.wait_for_selector('#txDialog[open]')
        pg.fill('#txDialog .amount-input', '8.09')
        pg.fill('#txDialog input[list=descList]', 'Parking')
        pg.check('#txDialog label.check:has-text("Ring-fence") input')
        pg.click('#txDialog button[type=submit]'); toast_has(pg, 'Added')
        tab(pg, 'Safe keeping')
        es = entries(pg)
        top = [e['text'] for e in es if 'Ring-fenced money back' in e['text'] and 'projected' in e['text']]
        check('top-up of £8.09 projected for the Oct statement', any('8.09' in t for t in top), top)
        pg.click('.feed .entry.projected:has-text("Ring-fenced money back") >> nth=0'); pg.wait_for_selector('#txDialog[open]')
        dt = norm(pg.text_content('#txDialog'))
        check('top-up dialog shows what was already moved back', 'Already moved back (confirmed)−£307.20' in dt and pg.input_value('#txDialog .amount-input') == '8.09', dt[:500])
        pg.locator('#txDialog').screenshot(path=f'{OUT}/m2-topup.png')
        hide_toast(pg); pg.click('#txDialog button[type=submit]'); toast_has(pg, 'Confirmed')
        es = entries(pg)
        real = [e['text'] for e in es if 'Ring-fenced money back' in e['text'] and 'projected' not in e['cls']]
        check('two confirmed money-back entries (£307.20 and £8.09)', len(real) == 2, real)
        b.close()
finally:
    server.terminate()

print()
print(f'{sum(ok for _, ok in checks)}/{len(checks)} checks passed')
if errors: print('Page errors:', errors[:5])
sys.exit(0 if all(ok for _, ok in checks) and not errors else 1)
