"""v0.9 — header (Personal Finance + version, no TEST), settings (This device,
Automatic backups), daily Drive backups through the REAL drive.js against the
emulator, the Backups list / preview / restore with a second device following,
and the recurring manager's Expired section.
Clock starts Tue 6 Oct 2026. Run: python3 dev/e2e/backups_v09.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8773)
errors, checks, dialogs = [], [], []

def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def toast_has(pg, text, timeout=8000):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=timeout)
def watch(page, label):
    page.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and 'accounts.google.com' not in m.text and errors.append(f'{label} console: {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    def on_dialog(d):
        dialogs.append(d.message); d.accept()
    page.on('dialog', on_dialog)
def device(b, w, h, mobile):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, is_mobile=mobile, has_touch=mobile)
    ctx.add_init_script(FAKE_AUTH)
    ctx.route('https://www.googleapis.com/**', handle)
    ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
    ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
    pg = ctx.new_page(); watch(pg, f'{w}px')
    pg.clock.install(time=datetime.datetime(2026, 10, 6, 9, 0, 0))
    pg.goto(URL)
    return pg
def add_spend(pg, amount, desc, date):
    if pg.is_visible('#fab'): pg.click('#fab')
    else: pg.click('.acc-add >> nth=0')
    pg.wait_for_selector('#txDialog[open]')
    pg.fill('#txDialog .amount-input', amount)
    pg.fill('#txDialog input[placeholder="e.g. Lottery"]', desc)
    pg.fill('#txDialog input[type=date]', date)
    pg.click('#txDialog button[type=submit]')
    pg.wait_for_selector('#txDialog[open]', state='detached')
def tap_sync(pg):
    # an earlier "Synced" toast may still be showing — hide it so we wait for this sync's own
    pg.evaluate('document.getElementById("toast").hidden = true')
    pg.click('#syncChip'); toast_has(pg, 'Synced with Google Drive')
def feed_text(pg): return pg.text_content('.feed') or ''
def data_descs():
    f = drive_files()[0]
    return sorted(t['description'] for t in json.loads(f['text'])['ledger']['transactions'])
def close_settings(pg): pg.click('#settingsDialog .sheet-head .icon-btn')

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        phone = device(b, 412, 915, True)
        phone.wait_for_selector('.setup-form')
        for el, v in zip(phone.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
        phone.fill('.setup-form input[type=date]', '2026-10-01')
        phone.click('.setup-form button[type=submit]'); phone.wait_for_selector('.feed')

        # ---- header
        check('header says Personal Finance', phone.text_content('.brand').strip() == 'Personal Finance', phone.text_content('.brand'))
        check('version under the header', phone.text_content('#brandVersion') == 'v0.9.0', phone.text_content('#brandVersion'))
        check('no TEST badge', phone.locator('.badge-test').count() == 0 and 'test' not in phone.text_content('.topbar').lower())
        bar_h = phone.evaluate('document.querySelector(".topbar").getBoundingClientRect().height')
        check('top bar height unchanged (57px, phone day headings rely on it)', abs(bar_h - 57) < 0.6, bar_h)
        check('page title', phone.title() == 'Personal Finance')
        phone.screenshot(path=f'{OUT}/v09-1-phone-header.png', clip={'x': 0, 'y': 0, 'width': 412, 'height': 140})

        # ---- settings before Drive
        phone.click('#settingsBtn'); phone.wait_for_selector('#settingsDialog[open]')
        st = phone.text_content('#settingsDialog')
        check('settings: Test data section gone', 'Test data' not in st)
        check('settings: This device section with erase', 'This device' in st and 'Erase all data on this device' in st)
        check('settings: backups need Drive sync', 'Automatic backups' in st and 'Need Google Drive sync' in st)
        check('settings footer name', 'Personal Finance v0.9.0' in st)
        phone.click('#settingsDialog button:has-text("Connect Google Drive")')
        phone.wait_for_function('() => /Synced/.test(document.getElementById("syncChip").textContent)', timeout=8000)
        phone.wait_for_timeout(200)
        st = phone.text_content('#settingsDialog')
        check('settings: backups section once connected', 'Backups…' in st and 'Last backup: never' in st, st[st.find('Automatic'):st.find('Automatic') + 220])
        check('no backup when the file is first created', backup_names() == [], backup_names())
        bar_h = phone.evaluate('document.querySelector(".topbar").getBoundingClientRect().height')
        check('top bar still one line (57px) with the sync chip showing', abs(bar_h - 57) < 0.6, bar_h)
        close_settings(phone)

        # ---- 6 Oct: first change of the day -> backup of what was there before
        add_spend(phone, '3.20', 'Coffee', '2026-10-06')
        tap_sync(phone)
        check('6 Oct backup made on first save', backup_names() == ['personal-2026-10-06.json'], backup_names())
        bk = [f for f in drive.values() if f['name'] == 'personal-2026-10-06.json'][0]
        check('backup holds the state BEFORE Coffee', 'Coffee' not in bk['text'])
        add_spend(phone, '9.99', 'Lunch', '2026-10-06')
        tap_sync(phone)
        check('second save the same day: still one backup', backup_names() == ['personal-2026-10-06.json'])

        # ---- 7 Oct: a mistake
        phone.clock.set_system_time(datetime.datetime(2026, 10, 7, 9, 0, 0))
        add_spend(phone, '999', 'Mistake', '2026-10-07')
        tap_sync(phone)
        check('7 Oct backup made', backup_names() == ['personal-2026-10-06.json', 'personal-2026-10-07.json'], backup_names())
        check('Drive data has the mistake', 'Mistake' in data_descs())

        # ---- desktop joins and has it too
        desk = device(b, 1440, 900, False)
        desk.clock.set_system_time(datetime.datetime(2026, 10, 7, 9, 5, 0))
        desk.wait_for_selector('.setup-form')
        desk.click('#settingsBtn'); desk.wait_for_selector('#settingsDialog[open]')
        desk.click('#settingsDialog button:has-text("Connect Google Drive")')
        desk.wait_for_selector('table.grid', timeout=8000)
        if desk.is_visible('#settingsDialog[open]'): close_settings(desk)
        check('desktop shows the mistake', 'Mistake' in desk.text_content('table.grid'))
        check('desktop header + version', desk.text_content('.brand') == 'Personal Finance' and desk.text_content('#brandVersion') == 'v0.9.0')
        desk.screenshot(path=f'{OUT}/v09-2-desk-header.png', clip={'x': 0, 'y': 0, 'width': 1440, 'height': 160})

        # ---- phone: Backups list
        phone.clock.set_system_time(datetime.datetime(2026, 10, 7, 15, 12, 0))
        phone.click('#settingsBtn'); phone.wait_for_selector('#settingsDialog[open]')
        st = phone.text_content('#settingsDialog')
        check('settings shows last backup time', 'Last backup: 7 Oct' in st, st[st.find('Last backup'):st.find('Last backup') + 40])
        phone.screenshot(path=f'{OUT}/v09-3-settings.png', full_page=False)
        phone.click('#settingsDialog button:has-text("Backups…")')
        phone.wait_for_selector('#backupsDialog[open] .backup-list')
        names = phone.eval_on_selector_all('#backupsDialog .backup-list .rec-name', 'els => els.map(e => e.textContent)')
        check('list newest first, first of the month tagged monthly', names == ['Wed, 7 Oct 2026', 'Tue, 6 Oct 2026monthly'] or names == ['Wed 7 Oct 2026', 'Tue 6 Oct 2026monthly'], names)
        phone.screenshot(path=f'{OUT}/v09-4-backups-list.png')

        # ---- preview 7 Oct (before the mistake) and restore it
        phone.click('#backupsDialog .backup-list .rec-row >> nth=0')
        phone.wait_for_selector('#backupsDialog .backup-compare')
        prev = phone.text_content('#backupsDialog .backup-compare').replace(',', '')
        check('preview: entries in backup vs now', 'Entries23' in prev.replace(' ', ''), prev)
        check('preview: current account then vs now', '3586.81' in prev and '2587.81' in prev, prev)
        check('preview: differing rows are bold', phone.locator('#backupsDialog .backup-compare tr.differs').count() == 2)
        phone.screenshot(path=f'{OUT}/v09-5-backup-preview.png')
        phone.click('#backupsDialog button:has-text("Restore this backup")')
        toast_has(phone, 'Restored the backup from')
        check('restore asked first', any('Restore the backup from' in d for d in dialogs))
        check('phone: mistake gone, coffee + lunch kept', 'Mistake' not in feed_text(phone) and 'Coffee' in feed_text(phone) and 'Lunch' in feed_text(phone))
        check('Drive: mistake gone', data_descs() == ['Coffee', 'Lunch'], data_descs())
        check('before-restore copy saved', 'personal-2026-10-07-before-restore-1512.json' in backup_names(), backup_names())
        phone.wait_for_timeout(300)
        phone.screenshot(path=f'{OUT}/v09-6-after-restore.png')

        # ---- desktop follows
        tap_sync(desk)
        desk_rows = desk.eval_on_selector_all('table.grid tbody tr td.c-desc', 'els => els.map(e => e.textContent)')
        check('desktop: mistake gone after its sync', 'Mistake' not in ' '.join(desk_rows), desk_rows)

        # ---- the before-restore copy is listed and could undo it
        phone.click('#settingsDialog button:has-text("Backups…")')
        phone.wait_for_selector('#backupsDialog[open] .backup-list')
        top = phone.text_content('#backupsDialog .backup-list .rec-row >> nth=0')
        check('before-restore copy listed first, with time', '15:12' in top and 'before a restore' in top, top)
        phone.click('#backupsDialog .sheet-head .icon-btn')
        close_settings(phone)

        # ---- recurring: Expired section
        phone.click('#settingsBtn'); phone.wait_for_selector('#settingsDialog[open]')
        phone.click('#settingsDialog button:has-text("Manage recurring items")'); phone.wait_for_selector('#recurringDialog[open]')
        def add_item(desc, amount, day, start, end=None):
            phone.click('#recurringDialog .rec-add-top'); phone.wait_for_selector('#recurringEditDialog[open]')
            d = '#recurringEditDialog'
            phone.fill(f'{d} input[placeholder="e.g. Netflix"]', desc)
            phone.fill(f'{d} input[placeholder="0.00"]', amount)
            phone.fill(f'{d} input[placeholder="1–31"]', str(day))
            phone.fill(f'{d} input[type=date] >> nth=0', start)
            if end: phone.fill(f'{d} input[type=date] >> nth=1', end)
            phone.click(f'{d} button[type=submit]'); phone.wait_for_selector(f'{d}[open]', state='detached')
            toast_has(phone, 'Recurring item added')
        add_item('Old loan', '50', 2, '2026-10-01', '2026-10-31')
        add_item('Gym', '30', 20, '2026-10-01', '2026-12-31')
        add_item('Netflix', '5.99', 15, '2026-10-01')
        rows = phone.eval_on_selector_all('#recurringDialog .rec-active .rec-name', 'els => els.map(e => e.textContent)')
        check('before confirming: all three active, nothing expired', sorted(rows) == ['Gym', 'Netflix', 'Old loan'] and phone.locator('#recurringDialog .rec-expired').count() == 0, rows)
        loan = phone.text_content('#recurringDialog .rec-row:has-text("Old loan")')
        check('ended but unpaid says so', 'last payment not confirmed yet' in loan, loan)
        phone.click('#recurringDialog .sheet-head .icon-btn'); close_settings(phone)
        phone.click('.feed .entry.projected:has-text("Old loan") >> nth=0'); phone.wait_for_selector('#txDialog[open]')
        phone.click('#txDialog button:has-text("Confirm")'); phone.wait_for_selector('#txDialog[open]', state='detached')
        toast_has(phone, 'Confirmed')
        phone.click('#settingsBtn'); phone.wait_for_selector('#settingsDialog[open]')
        phone.click('#settingsDialog button:has-text("Manage recurring items")'); phone.wait_for_selector('#recurringDialog[open]')
        active = phone.eval_on_selector_all('#recurringDialog .rec-active .rec-name', 'els => els.map(e => e.textContent)')
        expired = phone.eval_on_selector_all('#recurringDialog .rec-expired .rec-name', 'els => els.map(e => e.textContent)')
        check('after the last payment: Old loan under Expired, at the bottom', expired == ['Old loan'] and 'Old loan' not in active, f'{active} / {expired}')
        check('Expired heading', 'Expired (1)' in phone.text_content('#recurringDialog'))
        check('expired row says finished with last payment date', 'Finished · last payment' in phone.text_content('#recurringDialog .rec-expired'), phone.text_content('#recurringDialog .rec-expired'))
        heads = phone.evaluate('''() => { const a = document.querySelector('#recurringDialog .rec-active').getBoundingClientRect().bottom;
            const e = document.querySelector('#recurringDialog .rec-expired').getBoundingClientRect().top; return e > a; }''')
        check('Expired section is below the active list', heads)
        phone.screenshot(path=f'{OUT}/v09-7-recurring-expired.png')
        phone.click('#recurringDialog .rec-expired .rec-row'); phone.wait_for_selector('#recurringEditDialog[open]')
        check('expired item still opens for editing', 'Old loan' in phone.input_value('#recurringEditDialog input[placeholder="e.g. Netflix"]'))
        phone.click('#recurringEditDialog .sheet-head .icon-btn')

        # ---- dark mode look of the backups list
        phone.emulate_media(color_scheme='dark')
        phone.click('#recurringDialog .sheet-head .icon-btn')
        phone.click('#settingsDialog button:has-text("Backups…")')
        phone.wait_for_selector('#backupsDialog[open] .backup-list')
        phone.screenshot(path=f'{OUT}/v09-8-backups-dark.png')
        b.close()
finally:
    server.terminate()

print('\nerrors:', errors or 'none')
bad = [c for c in checks if not c[1]]
print(f'{len(checks) - len(bad)} of {len(checks)} checks passed')
sys.exit(1 if bad or errors else 0)
