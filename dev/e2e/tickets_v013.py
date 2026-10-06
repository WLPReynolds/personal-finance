"""v0.13 — ticket purchases on the card (spec: claude/ticket-purchases-spec.md).
Settings section (defaults, start date = the day it's switched on), tickets read
from the tracker's file, Bought — confirm (amber), forecasts, confirming (card
spend + ring-fence), the money back before the payment, ring-fencing a parking
spend by hand, an overdue ticket in red on today, a confirmed ticket that's gone
from the tracker in red, the grid. Drive emulator + fake sign-in.
Clock: Tue 6 Oct 2026, later Thu 22 Oct. Run: python3 dev/e2e/tickets_v013.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8775)
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
        check('Ticket purchases section shown', pg.is_visible(sec))
        box = f'{sec} label.check input'
        check('off by default, fields hidden', not pg.is_checked(box) and not pg.is_visible(f'{sec} select'))
        pg.check(box)
        sel = lambda i: pg.evaluate(f'() => {{ const s = document.querySelectorAll("{sec} select")[{i}]; return s.options[s.selectedIndex].text; }}')
        check('defaults: Barclaycard / Transport · Monzo pots / Safe keeping / Current Account',
              [sel(0), sel(1), sel(2), sel(3)] == ['Barclaycard', 'Transport · Monzo pots', 'Safe keeping', 'Current Account'], [sel(0), sel(1), sel(2), sel(3)])
        check('start date defaults to today', pg.input_value(f'{sec} input[type=date]') == '2026-10-06')
        pg.screenshot(path=f'{OUT}/k1-settings.png', full_page=False)
        pg.locator(sec).screenshot(path=f'{OUT}/k1-settings-section.png')
        hide_toast(pg)
        pg.click('#ticketSave')
        pg.wait_for_function('() => /Ticket purchases come from it too/.test(document.getElementById("settingsDialog").textContent)', timeout=8000)
        check('tracker section mentions ticket purchases', True)
        close_settings(pg)

        # ---- Barclaycard: today's bought ticket (amber), forecasts
        tab(pg, 'Barclaycard')
        pg.wait_for_function('() => [...document.querySelectorAll(".feed .entry")].some(e => e.innerText.includes("Bought"))', timeout=8000)
        es = entries(pg)
        bought = [e for e in es if 'Bought' in e['text']]
        check('6 Oct ticket shows as Bought — tap to confirm', len(bought) == 1 and '153.60' in bought[0]['text'], es)
        check('…in amber (overdue class), not red', bought and 'overdue' in bought[0]['cls'] and 'alert' not in bought[0]['cls'])
        check('22 Sep ticket (before the start date) left out', not any('22 Sep' in e['text'] for e in es))
        fc = [e for e in es if 'Train ticket' in e['text'] and 'projected · ticket tracker' in e['text']]
        check('forecast tickets on the card', len(fc) >= 3, [e['text'] for e in fc])
        check('today’s Barclaycard balance unchanged until confirmed', banner(pg) == '£0.00', banner(pg))
        pg.screenshot(path=f'{OUT}/k2-card-feed.png', full_page=True)

        # ---- the money back appears on Safe keeping
        tab(pg, 'Safe keeping')
        es = entries(pg)
        ret = [e for e in es if 'Ring-fenced money back' in e['text']]
        check('projected money back on 12 Nov (Oct statement): £153.60', any('153.60' in e['text'] for e in ret), [e['text'] for e in ret])
        pg.click('.feed .entry:has-text("Ring-fenced money back") >> nth=0'); pg.wait_for_selector('#txDialog[open]')
        dt = norm(pg.text_content('#txDialog'))
        check('money-back dialog lists the ticket and the day before the payment', 'Train ticket (projected)' in dt and 'Fri 13 Nov 2026' in dt and pg.input_value('#txDialog input[type=date]') == '2026-11-12', dt[:400])
        pg.click('#txDialog .sheet-head .icon-btn')

        # ---- confirm the bought ticket
        tab(pg, 'Barclaycard')
        pg.click('.feed .entry:has-text("Bought")'); pg.wait_for_selector('#txDialog[open]')
        dt = norm(pg.text_content('#txDialog'))
        check('confirm dialog: date and price from the tracker', pg.input_value('#txDialog input[type=date]') == '2026-10-06' and pg.input_value('#txDialog .amount-input') == '153.60')
        check('confirm dialog says what it adds', 'Transport (Monzo pots) to Safe keeping' in dt, dt[:400])
        pg.screenshot(path=f'{OUT}/k3-confirm.png')
        hide_toast(pg)
        pg.click('#txDialog button[type=submit]'); toast_has(pg, 'Ticket confirmed')
        es = entries(pg)
        check('confirmed: no Bought row left', not any('Bought' in e['text'] for e in es))
        check('Barclaycard owes £153.60 today', banner(pg) == '£153.60', banner(pg))
        tab(pg, 'Safe keeping')
        check('Safe keeping £153.60 today', banner(pg) == '£153.60', banner(pg))
        tab(pg, 'Monzo pots')
        es = entries(pg)
        check('Monzo pots: ring-fence out of Transport', any('Ring-fence: Train ticket' in e['text'] and 'Transport' in e['text'] and '153.60' in e['text'] and 'projected' not in e['cls'] for e in es), [e['text'] for e in es])

        # ---- the confirmed spend's dialog
        tab(pg, 'Barclaycard')
        pg.click('.feed .entry:not(.projected):has-text("Train ticket")'); pg.wait_for_selector('#txDialog[open]')
        dt = norm(pg.text_content('#txDialog'))
        check('confirmed spend: ticket note and Ring-fence ticked', 'Ticket from the ticket tracker' in dt and pg.is_checked('#txDialog label.check:has-text("Ring-fence") input'), dt[:300])
        pg.click('#txDialog .sheet-head .icon-btn')

        # ---- parking by hand, ring-fenced
        hide_toast(pg)
        pg.click('#fab') if pg.is_visible('#fab') else pg.click('.fab')
        pg.wait_for_selector('#txDialog[open]')
        pg.fill('#txDialog .amount-input', '6.39')
        pg.fill('#txDialog input[list=descList]', 'Parking')
        rf = '#txDialog label.check:has-text("Ring-fence") input'
        check('Ring-fence offered on a new card spend, off by default', pg.is_visible(rf) and not pg.is_checked(rf))
        pg.check(rf)
        pg.click('#txDialog button[type=submit]'); toast_has(pg, 'Added')
        tab(pg, 'Safe keeping')
        check('Safe keeping now £159.99', banner(pg) == '£159.99', banner(pg))
        es = entries(pg)
        check('money back for the Oct statement = ticket + parking (£159.99)', any('Ring-fenced money back' in e['text'] and '159.99' in e['text'] for e in es), [e['text'] for e in es if 'back' in e['text']])
        pg.screenshot(path=f'{OUT}/k4-safe-keeping.png', full_page=True)

        # parking edited → the ring-fence follows; unticked → removed
        tab(pg, 'Barclaycard')
        pg.click('.feed .entry:has-text("Parking")'); pg.wait_for_selector('#txDialog[open]')
        pg.fill('#txDialog .amount-input', '12.78')
        pg.click('#txDialog button[type=submit]'); toast_has(pg, 'Updated')
        tab(pg, 'Safe keeping')
        check('ring-fence followed the new amount (£166.38)', banner(pg) == '£166.38', banner(pg))
        tab(pg, 'Barclaycard')
        pg.click('.feed .entry:has-text("Parking")'); pg.wait_for_selector('#txDialog[open]')
        pg.uncheck(rf); hide_toast(pg)
        pg.click('#txDialog button[type=submit]'); toast_has(pg, 'Updated')
        tab(pg, 'Safe keeping')
        check('unticked → ring-fence removed (£153.60)', banner(pg) == '£153.60', banner(pg))

        # ---- the card payment includes the projected tickets
        tab(pg, 'Current Account')
        es = entries(pg)
        pay = [e['text'] for e in es if 'Barclaycard' in e['text'] and 'projected' in e['cls']]
        check('13 Nov Barclaycard payment includes the 6 Oct ticket + parking', any('166.38' in t for t in pay), pay)

        # ---- overdue: Thu 22 Oct, the 20 Oct ticket not bought → red, on today
        pg2 = ctx.new_page()
        pg2.on('pageerror', lambda e: errors.append(str(e)))
        pg2.on('dialog', lambda d: d.accept())
        pg2.clock.install(time=datetime.datetime(2026, 10, 22, 9, 0, 0))
        pg.close()
        pg2.goto(URL); pg2.wait_for_selector('.feed')
        pg = pg2
        tab(pg, 'Barclaycard')
        pg.wait_for_function('() => [...document.querySelectorAll(".feed .entry")].some(e => e.innerText.includes("Overdue"))', timeout=8000)
        es = entries(pg)
        od = [e for e in es if 'Overdue' in e['text']]
        check('overdue ticket labelled and red (alert class)', len(od) == 1 and 'alert' in od[0]['cls'] and 'due Tue 20 Oct' in od[0]['text'], [e['text'] for e in od])
        day = pg.evaluate('() => { const e = [...document.querySelectorAll(".feed .entry")].find(x => x.innerText.includes("Overdue")); let li = e.closest("li").previousElementSibling; while (li && !li.classList.contains("day")) li = li.previousElementSibling; return li && li.dataset.date; }')
        check('…shown on today (22 Oct), not 20 Oct', day == '2026-10-22', day)
        check('…with a red background', is_reddish(bg(pg, '.feed .entry.alert')), bg(pg, '.feed .entry.alert'))
        pg.click('.feed .entry.alert'); pg.wait_for_selector('#txDialog[open]')
        dt = norm(pg.text_content('#txDialog'))
        check('overdue dialog explains; no Confirm button', 'Overdue' in dt and 'record the purchase in the ticket tracker' in dt and not pg.is_visible('#txDialog button:has-text("Confirm")'), dt[:300])
        pg.click('#txDialog .sheet-head .icon-btn')
        pg.screenshot(path=f'{OUT}/k5-overdue.png', full_page=True)

        # ---- the tracker re-dates the confirmed purchase → its id goes → red "No longer in the ticket tracker"
        changed = [t for t in TICKETS if t['id'] != 'p-2026-10-07'] + [tk('bought', '2026-10-08', '2026-10-21', '2026-10-06')]
        changed.sort(key=lambda t: t['purchaseDate'])
        put_tracker(tracker_file(changed))
        open_settings(pg)
        hide_toast(pg)
        pg.click('#trackerSection button:has-text("Check now")'); toast_has(pg, 'checked')
        close_settings(pg)
        es = entries(pg)
        gone = [e for e in es if 'No longer in the ticket tracker' in e['text']]
        check('confirmed ticket flagged red: No longer in the ticket tracker', len(gone) == 1 and 'alert' in gone[0]['cls'], [e['text'] for e in es])
        nb = [e for e in es if 'Bought' in e['text']]
        check('…and the re-dated purchase offered as Bought — confirm', len(nb) == 1, [e['text'] for e in nb])
        tab(pg, 'Monzo pots')
        check('its ring-fence row is red too', any('alert' in e['cls'] and 'Ring-fence' in e['text'] for e in entries(pg)))
        tab(pg, 'Barclaycard')
        pg.screenshot(path=f'{OUT}/k6-missing.png', full_page=True)

        # ---- the grid (desktop)
        pg.set_viewport_size({'width': 1440, 'height': 900})
        pg.wait_for_selector('.grid')
        rows = pg.evaluate('() => [...document.querySelectorAll(".grid tbody tr")].map(r => ({ cls: r.className, text: r.innerText.replace(/\\s+/g," ") }))')
        check('grid: red row for the missing ticket', any('alert' in r['cls'] and 'No longer in the ticket tracker' in r['text'] for r in rows))
        check('grid: red row for the overdue ticket', any('alert' in r['cls'] and 'Overdue' in r['text'] for r in rows))
        check('grid: amber Bought row', any('overdue' in r['cls'] and 'Bought' in r['text'] for r in rows))
        check('grid: red cells', is_reddish(bg(pg, '.grid tbody tr.alert td.c-desc')), bg(pg, '.grid tbody tr.alert td.c-desc'))
        pg.evaluate('() => { const r = [...document.querySelectorAll(".grid tbody tr")].find(r => r.className.includes("alert")); r.scrollIntoView({ block: "center" }); }')
        pg.screenshot(path=f'{OUT}/k7-grid.png')
        pg.emulate_media(color_scheme='dark')
        check('grid dark: red cells', is_reddish(bg(pg, '.grid tbody tr.alert td.c-desc')), bg(pg, '.grid tbody tr.alert td.c-desc'))
        pg.screenshot(path=f'{OUT}/k8-grid-dark.png')
        b.close()
finally:
    server.terminate()

print()
print(f'{sum(ok for _, ok in checks)}/{len(checks)} checks passed')
if errors: print('Page errors:', errors[:5])
sys.exit(0 if all(ok for _, ok in checks) and not errors else 1)
