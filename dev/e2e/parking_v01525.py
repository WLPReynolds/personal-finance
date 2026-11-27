"""v0.15.25 — parking shared with the ticket tracker (parking-transactions.json).
Off by default and no Parking tick; turning it on with no file refuses and never
creates one; with the tracker's file it turns on; the tick on a card spend fills
the file after the automatic sync; an edit keeps the id; credits, notes and
transfers get no tick; untick / delete empty the list; off hides the tick and
keeps the flags. Drive emulator + fake sign-in. Clock fixed at Fri 27 Nov 2026.
Run: python3 dev/e2e/parking_v01525.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8781)
errors, checks = [], []
D = '#recurringEditDialog'
T = '#txDialog'
PK = '#txDialog #parkingField'

def norm(t): return ' '.join((t or '').replace(',', '').split())
def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def toast_has(pg, text):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=6000)
def hide_toast(pg): pg.evaluate('() => { const e = document.getElementById("toast"); if (e) e.hidden = true; }')

def tracker_estimates():
    return json.dumps(dict(format='transport-estimates', version=1, generatedAt='2026-11-27T08:00:00.000Z',
        source=dict(app='ticket-tracker', appVersion='v2026-11-27.08:00'), assumptions=dict(ticketPricePence=15360, parkingDayPence=639),
        periods=[dict(paydayMonth='2026-11', start='2026-11-27', end='2026-12-23', status='projected', ticketCount=1, ticketPence=15360, parkingDays=17, parkingPence=10863, totalPence=26223)]))
def put_tracker_file(name, text, key):
    if 'trk-folder' not in drive:
        drive['trk-folder'] = dict(name='Ticket Tracker Backups', parent='root', folder=True, text=None, version=1, trashed=False, mime='application/vnd.google-apps.folder')
    drive[key] = dict(name=name, parent='trk-folder', folder=False, text=text, version=1, trashed=False, mime='application/json', created=key)
def parking_file():
    f = [f for f in drive.values() if f['name'] == 'parking-transactions.json']
    return (len(f), json.loads(f[0]['text']) if f else None)
def wait_file(pg, pred, what):
    """Let the background sync run (its 4 s timer), then wait for the file."""
    for _ in range(40):
        pg.clock.run_for(1000)
        pg.wait_for_timeout(100)
        n, data = parking_file()
        if data is not None and pred(data['transactions']): return data
    raise AssertionError(f'parking file never got: {what}; it has {parking_file()[1]}')

def open_card_tab(pg):
    pg.click('.tab:has-text("Barclaycard")'); pg.wait_for_timeout(150)
def new_entry(pg):
    pg.click('#fab'); pg.wait_for_selector(f'{T}[open]')
def fill(pg, amount, desc, date):
    pg.fill(f'{T} .amount-input', amount); pg.fill(f'{T} input[list=descList]', desc); pg.fill(f'{T} input[type=date]', date)
def submit(pg, toast):
    hide_toast(pg); pg.click(f'{T} button[type=submit]'); pg.wait_for_selector(f'{T}[open]', state='detached'); toast_has(pg, toast)
def open_entry(pg, desc):
    pg.click(f'.feed .entry:has-text("{desc}") >> nth=0'); pg.wait_for_selector(f'{T}[open]')

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
        pg.clock.install(time=datetime.datetime(2026, 11, 27, 12, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        fill_setup(pg, ['3600', '0', '0'])
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')

        put_tracker_file('transport-estimates.json', tracker_estimates(), 'trk-est')
        open_settings(pg)
        settings_click(pg, '#settingsDialog button:has-text("Connect Google Drive")')
        pg.wait_for_function('() => /Synced/.test(document.getElementById("syncChip").textContent)', timeout=8000)

        # Wayne's ledger uses the tracker (Train fare/Parking), so the Ticket tracker page is listed
        open_settings(pg, '')
        pg.click('#settingsDialog .settings-item[data-page=recurring]'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog .btn-primary'); pg.wait_for_selector(f'{D}[open]')
        pg.fill(f'{D} input[placeholder="e.g. Netflix"]', 'Train fare/Parking')
        pg.fill(f'{D} input[placeholder="0.00"]', '462')
        pg.fill(f'{D} input[placeholder="1–31"]', '28')
        pg.check(f'{D} label.check:has-text("ticket tracker") input')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); toast_has(pg, 'Recurring item added')
        pg.click('#recurringDialog .sheet-head .icon-btn'); close_settings(pg)

        # ---- off: no tick on the entry form
        open_card_tab(pg); new_entry(pg)
        check('off by default: no Parking tick on a card spend', pg.locator(PK).count() == 0)
        pg.click(f'{T} .sheet-head .icon-btn')

        # ---- turning on with no file: refused, nothing created
        open_settings(pg, 'tracker')
        st = norm(pg.text_content('#parkingSection'))
        check('settings: Parking section on the Ticket tracker page', 'Share parking with the ticket tracker' in st, st)
        check('switch off', not pg.is_checked('#parkingShareOn'))
        pg.check('#parkingShareOn')
        pg.wait_for_function('() => /Turn on parking sharing in Ticket Tracker first/.test(document.getElementById("parkingSection").textContent)', timeout=6000)
        check('no file: switch goes back off', not pg.is_checked('#parkingShareOn'))
        check('no file: this app never creates one', parking_file()[0] == 0)
        pg.screenshot(path=f'{OUT}/pk1-no-file.png')
        close_settings(pg)
        new_entry(pg)
        check('still no Parking tick', pg.locator(PK).count() == 0)
        pg.click(f'{T} .sheet-head .icon-btn')

        # ---- the tracker makes its empty file; now it turns on
        put_tracker_file('parking-transactions.json', json.dumps(dict(format='parking-transactions', version=1, generatedAt='2026-11-27T12:00:00Z',
            source=dict(app='ticket-tracker', appVersion='v2026-11-27.12:00'), transactions=[])), 'trk-park')
        open_settings(pg, 'tracker')
        hide_toast(pg); pg.check('#parkingShareOn')
        pg.wait_for_function('() => /Sharing 0 parking payments/.test(document.getElementById("parkingSection")?.textContent ?? "")', timeout=6000)
        check('on: switch ticked, status line', pg.is_checked('#parkingShareOn'), norm(pg.text_content('#parkingSection')))
        check('on: Share now button', pg.is_visible('#parkingSection button:has-text("Share now")'))
        pg.screenshot(path=f'{OUT}/pk2-settings-on.png')
        close_settings(pg)

        # ---- the tick: a card spend
        open_card_tab(pg); new_entry(pg)
        check('on: Parking tick on a card spend, unticked', pg.is_visible(PK) and not pg.is_checked(f'{PK} input'))
        pg.click(f'{T} .seg-btn[data-value=credit]')
        check('credit: no tick', not pg.is_visible(PK))
        pg.click(f'{T} .seg-btn[data-value=note]')
        check('note: no tick', not pg.is_visible(PK))
        pg.click(f'{T} .seg-btn[data-value=debit]')
        check('back to a debit: tick again', pg.is_visible(PK))
        counter = f'{T} select:has(option:has-text("Current Account"))'
        if pg.locator(counter).count():
            pg.select_option(counter, label='Current Account')
            check('also recorded in another account (a transfer): no tick', not pg.is_visible(PK))
            pg.select_option(counter, index=0)
        fill(pg, '6.39', 'Parking', '2026-11-26')
        pg.check(f'{PK} input')
        pg.screenshot(path=f'{OUT}/pk3-entry-form.png')
        submit(pg, 'Added')
        data = wait_file(pg, lambda t: len(t) == 1, 'one entry')
        e = data['transactions'][0]
        check('file: the spend, in pence, on its date, with the card', (e['date'], e['amountPence'], e.get('account')) == ('2026-11-26', 639, 'Barclaycard'), e)
        check('file: written by this app, same format', data['format'] == 'parking-transactions' and data['version'] == 1 and data['source']['app'] == 'personal-finance', data['source'])
        check('file: still one file, in the tracker’s folder', parking_file()[0] == 1 and drive['trk-park']['parent'] == 'trk-folder')
        first_id = e['id']

        # ---- edit the amount: same id, new amount
        open_entry(pg, 'Parking')
        check('reopens with the tick on', pg.is_checked(f'{PK} input'))
        pg.fill(f'{T} .amount-input', '7.00'); submit(pg, 'Updated')
        data = wait_file(pg, lambda t: len(t) == 1 and t[0]['amountPence'] == 700, 'amount 700')
        check('edit: same id, new amount', data['transactions'][0]['id'] == first_id)

        # ---- a second unflagged spend stays out; then untick the first
        new_entry(pg); fill(pg, '3.20', 'Coffee', '2026-11-26'); submit(pg, 'Added')
        open_entry(pg, 'Parking'); pg.uncheck(f'{PK} input'); submit(pg, 'Updated')
        data = wait_file(pg, lambda t: len(t) == 0, 'empty after untick')
        check('untick: gone from the file; the coffee never in it', data['transactions'] == [])
        open_entry(pg, 'Parking'); pg.check(f'{PK} input'); submit(pg, 'Updated')
        wait_file(pg, lambda t: len(t) == 1, 'back after re-tick')

        # ---- Drive's personal.json carries the flag; the tracker’s list isn't in it
        pdata = json.loads([f for f in drive.values() if f['name'] == 'personal.json'][0]['text'])['ledger']
        t = [x for x in pdata['transactions'] if x['id'] == first_id][0]
        check('synced ledger: parking: true on the entry', t.get('parking') is True)
        check('synced ledger: the setting record', any(r.get('recordType') == 'parkingSharing' and r.get('enabled') for r in pdata['scheduledItems']))

        # ---- delete → empty
        open_entry(pg, 'Parking')
        hide_toast(pg); pg.click(f'{T} .btn-danger')
        toast_has(pg, 'Deleted')
        wait_file(pg, lambda t: len(t) == 0, 'empty after delete')
        check('delete: gone from the file', True)

        # ---- off: tick hidden, flags kept
        new_entry(pg); fill(pg, '5.00', 'Parking again', '2026-11-27'); pg.check(f'{PK} input'); submit(pg, 'Added')
        wait_file(pg, lambda t: len(t) == 1, 'one again')
        open_settings(pg, 'tracker')
        pg.uncheck('#parkingShareOn')
        pg.wait_for_function('() => /Off\\. Parking ticks/.test(document.getElementById("parkingSection")?.textContent ?? "")', timeout=6000)
        close_settings(pg)
        open_entry(pg, 'Parking again')
        check('off: no tick on the form', pg.locator(PK).count() == 0)
        pg.fill(f'{T} .amount-input', '5.50'); submit(pg, 'Updated')
        pg.clock.run_for(6000); pg.wait_for_timeout(500)
        check('off: the file is left alone', parking_file()[1]['transactions'][0]['amountPence'] == 500)
        pdata = json.loads([f for f in drive.values() if f['name'] == 'personal.json'][0]['text'])['ledger']
        check('off: the flag on the entry is kept', any(x.get('parking') is True and x['amount'] == 550 for x in pdata['transactions']))
        b.close()
finally:
    server.terminate()

print(f'\n{sum(ok for _, ok in checks)}/{len(checks)} checks passed; {len(errors)} errors')
for e in errors: print('  ERR', e)
sys.exit(0 if all(ok for _, ok in checks) and not errors else 1)
