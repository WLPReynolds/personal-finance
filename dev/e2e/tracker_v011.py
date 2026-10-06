"""v0.11 — amounts from the ticket tracker's transport-estimates.json.
Nothing read until an item uses it; the editor option and preview; projected
amounts + labels on the phone feed; the entry dialog's breakdown; fallback
months; settings status + Check now; a changed file; a bad file keeps the last
good figures; turning the option off. Drive emulator + fake sign-in.
Clock fixed at Tue 6 Oct 2026. Run: python3 dev/e2e/tracker_v011.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8773)
errors, checks, tracker_reqs = [], [], []
D = '#recurringEditDialog'

def norm(t): return ' '.join((t or '').replace(',', '').split())
def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def toast_has(pg, text):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=6000)
def hide_toast(pg): pg.evaluate('() => { const e = document.getElementById("toast"); if (e) e.hidden = true; }')

def period(start, end, status, tickets, days):
    tp, pp = tickets * 15360, days * 639
    return dict(paydayMonth=start[:7], start=start, end=end, status=status, ticketCount=tickets, ticketPence=tp, parkingDays=days, parkingPence=pp, totalPence=tp + pp)
def tracker_file(version=1, oct_days=21, generated='2026-10-06T08:00:00.000Z'):
    return json.dumps(dict(format='transport-estimates', version=version, generatedAt=generated,
        source=dict(app='ticket-tracker', appVersion='v2026-10-06.08:00'),
        assumptions=dict(ticketPricePence=15360, parkingDayPence=639),
        periods=[period('2026-09-28', '2026-10-27', 'locked', 2, 18),
                 period('2026-10-28', '2026-11-26', 'projected', 2, oct_days),
                 period('2026-11-27', '2026-12-23', 'projected', 1, 17),
                 period('2026-12-24', '2027-01-27', 'projected', 2, 16)]))
def put_tracker(text):
    """The ticket tracker writes/overwrites its file in its own folder."""
    for f in drive.values():
        if f['name'] == 'transport-estimates.json':
            f['text'] = text; f['version'] += 1; return
    drive['trk-folder'] = dict(name='Ticket Tracker Backups', parent='root', folder=True, text=None, version=1, trashed=False, mime='application/vnd.google-apps.folder')
    drive['trk-file'] = dict(name='transport-estimates.json', parent='trk-folder', folder=False, text=text, version=1, trashed=False, mime='application/json')

def projected(pg):
    return pg.evaluate('() => [...document.querySelectorAll(".feed .entry.projected")].map(e => e.innerText.replace(/\\s+/g," ").replace(/,/g,""))')
def open_settings(pg):
    pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
def close_settings(pg): pg.click('#settingsDialog .sheet-head .icon-btn')
def tap_sync(pg):
    hide_toast(pg); pg.click('#syncChip'); toast_has(pg, 'Synced')

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
        pg.on('request', lambda r: 'transport-estimates' in urllib.parse.unquote(r.url) and tracker_reqs.append(r.url))
        pg.clock.install(time=datetime.datetime(2026, 10, 6, 12, 0, 0))
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        for el, v in zip(pg.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]'); pg.wait_for_selector('.feed')

        put_tracker(tracker_file())
        open_settings(pg)
        pg.click('#settingsDialog button:has-text("Connect Google Drive")')
        pg.wait_for_function('() => /Synced/.test(document.getElementById("syncChip").textContent)', timeout=8000)
        st = pg.text_content('#settingsDialog')
        check('no Ticket tracker section while no item uses it', 'Ticket tracker' not in st)
        check('nothing asked of Drive about the tracker yet', not tracker_reqs, tracker_reqs)

        # ---- the editor
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog .btn-primary'); pg.wait_for_selector(f'{D}[open]')
        pg.fill(f'{D} input[placeholder="e.g. Netflix"]', 'Train fare/Parking')
        pg.fill(f'{D} input[placeholder="0.00"]', '462')
        pg.fill(f'{D} input[placeholder="1–31"]', '28')
        pg.select_option(f'{D} select:has(option[value=before])', value='before')
        box = f'{D} label.check:has-text("ticket tracker") input'
        check('option shown, off by default', pg.is_visible(box) and not pg.is_checked(box))
        pg.check(box)
        et = norm(pg.text_content(D))
        check('amount relabelled as the fallback', 'Amount if the tracker has no figure' in et)
        check('editor says it is read on the next sync', 'read on the next sync' in et, et[et.find('Each month'):][:260])
        check('preview: no figures yet → item amount', 'Oct 2026 £462.00 (no tracker figure)' in et, et[et.find('Amounts'):][:200])
        pg.screenshot(path=f'{OUT}/t1-editor.png')
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); toast_has(pg, 'Recurring item added')
        mt = norm(pg.text_content('#recurringDialog'))
        check('manager line names the tracker', 'amount from the ticket tracker' in mt, mt[:300])
        pg.click('#recurringDialog .sheet-head .icon-btn'); close_settings(pg)

        # ---- the automatic sync after the edit reads the file
        pg.clock.run_for(5000)
        pg.wait_for_function('() => [...document.querySelectorAll(".feed .entry.projected")].some(e => e.innerText.includes("441.39"))', timeout=8000)
        check('Drive was asked for the file by name', any("name='transport-estimates.json'" in urllib.parse.unquote(u) for u in tracker_reqs))
        pr = projected(pg)
        check('28 Oct: £441.39 from the tracker', any('441.39' in e and 'ticket tracker' in e for e in pr), pr)
        check('27 Nov (Sat 28th → Fri): £262.23', any('262.23' in e for e in pr), pr)
        check('24 Dec (28th is a bank holiday): £409.44', any('409.44' in e for e in pr), pr)
        check('Jan: no tracker figure → £462.00 estimate', any('462.00' in e and 'no tracker figure' in e for e in pr), pr)
        pg.screenshot(path=f'{OUT}/t2-feed.png', full_page=True)

        # ---- the entry dialog
        pg.click('.feed .entry.projected:has-text("441.39")'); pg.wait_for_selector('#txDialog[open]')
        dt = norm(pg.text_content('#txDialog'))
        check('dialog: amount filled with the tracker figure', pg.input_value('#txDialog .amount-input') == '441.39')
        check('dialog: breakdown', '2 tickets (£307.20) + 21 parking days (£134.19)' in dt, dt[dt.find('From the'):][:200])
        check('dialog: projection, figures from 6 Oct, can change', 'figures from 6 Oct 09:00' in dt and 'can still change' in dt, dt)
        pg.screenshot(path=f'{OUT}/t3-entry.png')
        pg.click('#txDialog .sheet-head .icon-btn')
        pg.click('.feed .entry.projected:has-text("462.00")'); pg.wait_for_selector('#txDialog[open]')
        check('fallback month explains itself', 'has no figure for Jan 2027' in norm(pg.text_content('#txDialog')))
        pg.click('#txDialog .sheet-head .icon-btn')

        # ---- settings status, Check now with a changed file
        open_settings(pg)
        st = norm(pg.text_content('#trackerSection'))
        check('settings: section with the item and the figures range', 'Train fare/Parking takes its amount' in st and 'Pay periods Sept 2026 – Dec 2026 figures from 6 Oct 09:00' in st, st)
        put_tracker(tracker_file(oct_days=19, generated='2026-10-06T11:00:00.000Z'))
        hide_toast(pg)
        pg.click('#trackerSection button:has-text("Check now")'); toast_has(pg, 'Ticket tracker figures checked')
        close_settings(pg)
        pr = projected(pg)
        check('changed file: 28 Oct now £428.61', any('428.61' in e for e in pr) and not any('441.39' in e for e in pr), pr)

        # ---- a bad file keeps the last good figures
        put_tracker(tracker_file(version=2))
        open_settings(pg); hide_toast(pg)
        pg.click('#trackerSection button:has-text("Check now")'); toast_has(pg, 'format version 2')
        st = norm(pg.text_content('#trackerSection'))
        check('settings: why, and still using the last figures', 'format version 2' in st and 'Still using the figures above' in st, st)
        pg.screenshot(path=f'{OUT}/t4-settings-bad-file.png')
        close_settings(pg)
        check('figures kept after a bad file', any('428.61' in e for e in projected(pg)))

        # ---- a reload keeps the figures offline (from this device's copy)
        put_tracker(tracker_file(oct_days=19))
        pg.reload(); pg.wait_for_selector('.feed')
        check('after reload: figures from this device’s copy', any('428.61' in e for e in projected(pg)))

        # ---- confirming keeps the amount; turning the option off
        pg.click('.feed .entry.projected:has-text("428.61")'); pg.wait_for_selector('#txDialog[open]')
        pg.click('#txDialog button[type=submit]'); toast_has(pg, 'Confirmed')
        check('confirmed at £428.61', '428.61' in norm(pg.text_content('.feed')) and not any('428.61' in e for e in projected(pg)))
        open_settings(pg)
        pg.click('#settingsDialog button:has-text("Manage recurring items")'); pg.wait_for_selector('#recurringDialog[open]')
        pg.click('#recurringDialog .rec-row >> nth=0'); pg.wait_for_selector(f'{D}[open]')
        check('reopens with the option ticked', pg.is_checked(box))
        pg.uncheck(box)
        pg.click(f'{D} button[type=submit]'); pg.wait_for_selector(f'{D}[open]', state='detached'); toast_has(pg, 'Recurring item updated')
        pg.click('#recurringDialog .sheet-head .icon-btn')
        check('Ticket tracker section gone when no item uses it', pg.locator('#trackerSection').count() == 0)
        close_settings(pg)
        pr = projected(pg)
        check('option off: back to £462.00, no tracker labels', pr and all('462.00' in e and 'tracker' not in e for e in pr), pr)
        check('the confirmed October entry is unchanged', '428.61' in norm(pg.text_content('.feed')))
        tap_sync(pg)
        data = json.loads(drive_files()[0]['text'])['ledger']
        item = [r for r in data['scheduledItems'] if r.get('recordType') == 'recurring'][0]
        check('Drive copy: amountFrom cleared', item.get('amountFrom') is None, item.get('amountFrom'))
        check('Drive copy: tracker figures never in the ledger', 'transport-estimates' not in drive_files()[0]['text'] and 'totalPence' not in drive_files()[0]['text'])
        b.close()
finally:
    server.terminate()

print(f'\n{sum(ok for _, ok in checks)}/{len(checks)} checks passed; {len(errors)} errors')
for e in errors: print('  ERR', e)
sys.exit(0 if all(ok for _, ok in checks) and not errors else 1)
