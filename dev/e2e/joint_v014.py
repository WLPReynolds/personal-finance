"""v0.14 — the joint account on its own Drive file, Wayne only (stage 1).
Desktop sets it up; the phone turns it on and gets it; entries go to the joint
file only; transfers can't cross the two files; the chip's joint dot; turn
off / on; joint export can't be imported into the personal data; erase.
Real drive.js against the emulator, fake sign-in. Clock 7 Oct 2026.
Run: python3 dev/e2e/joint_v014.py"""
from common import *
from playwright.sync_api import sync_playwright
import datetime

server, URL = start_server(8781)
errors, checks, dialogs = [], [], []

def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))
def toast_has(pg, text, timeout=8000):
    pg.wait_for_function('t => { const e = document.getElementById("toast"); return e && !e.hidden && e.textContent.includes(t); }', arg=text, timeout=timeout)
def hide_toast(pg): pg.evaluate('document.getElementById("toast").hidden = true')
def watch(page, label):
    page.on('console', lambda m: m.type == 'error' and 'ERR_' not in m.text and 'accounts.google.com' not in m.text and errors.append(f'{label} console: {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    def on_dialog(d):
        dialogs.append(d.message); d.accept()
    page.on('dialog', on_dialog)
def device(b, w, h, mobile, scheme='light'):
    ctx = b.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2, is_mobile=mobile, has_touch=mobile, color_scheme=scheme)
    ctx.add_init_script(FAKE_AUTH)
    ctx.route('https://www.googleapis.com/**', handle)
    ctx.route('https://accounts.google.com/**', lambda r, q: r.abort())
    ctx.route('https://www.gov.uk/bank-holidays.json', lambda r, q: r.abort())
    pg = ctx.new_page(); watch(pg, f'{w}px')
    pg.clock.install(time=datetime.datetime(2026, 10, 7, 9, 0, 0))
    pg.goto(URL)
    return pg
def named(name):
    return [f for f in drive.values() if not f['folder'] and not f['trashed'] and f['name'] == name]
def ledger_of(name): return json.loads(named(name)[0]['text'])['ledger']
def folder_name(f): return drive[f['parent']]['name'] if f['parent'] in drive else None
def idb_keys(pg):
    return pg.evaluate("""() => new Promise((res) => { const r = indexedDB.open('finance-tracker', 1);
      r.onsuccess = () => { const q = r.result.transaction('kv').objectStore('kv').getAllKeys(); q.onsuccess = () => res(q.result.sort()); }; })""")
def open_settings(pg):
    pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
def close_settings(pg):
    if pg.is_visible('#settingsDialog[open]'): pg.click('#settingsDialog .sheet-head .icon-btn')
def wait_synced(pg):
    pg.wait_for_function('() => !/Syncing/.test(document.getElementById("syncChip").textContent) && !document.querySelector(".sync-joint-busy")', timeout=8000)
def tap_sync_both(pg):
    hide_toast(pg); pg.click('#syncChip'); toast_has(pg, 'Joint: synced')
def joint_dot(pg):
    return pg.evaluate('() => document.querySelector("#syncChip .sync-joint")?.className ?? null')

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        desk = device(b, 1440, 900, False)
        desk.wait_for_selector('.setup-form')
        for el, v in zip(desk.query_selector_all('.setup-form .amount-input'), ['3600', '6', '1000']): el.fill(v)
        desk.fill('.setup-form input[type=date]', '2026-10-01')
        desk.click('.setup-form button[type=submit]'); desk.wait_for_selector('table.grid')
        open_settings(desk)
        desk.click('#settingsDialog button:has-text("Connect Google Drive")')
        desk.wait_for_function('() => /Synced/.test(document.getElementById("syncChip").textContent)', timeout=8000)
        personal_v = named('personal.json')[0]['version']

        # ---- off by default: nothing joint anywhere
        st = desk.text_content('#settingsDialog')
        check('off by default: ⚙ offers "Turn on"', 'Joint account' in st and desk.locator('#settingsDialog .joint-section button:has-text("Turn on")').count() == 1)
        check('off: no joint records on this device', not any(k.startswith('joint') for k in idb_keys(desk)), idb_keys(desk))
        check('off: no joint dot on the chip', joint_dot(desk) is None)
        check('off: no joint file on Drive', named('joint.json') == [])

        # ---- turn on (first device): file made, then the opening balance asked for
        desk.click('#settingsDialog .joint-section button:has-text("Turn on")')
        desk.wait_for_selector('#settingsDialog .joint-setup', timeout=8000)
        check('turn on → joint.json made in its own "Finance Joint" folder', len(named('joint.json')) == 1 and folder_name(named('joint.json')[0]) == 'Finance Joint', [folder_name(f) for f in named('joint.json')])
        check('setup form defaults the date to your opening date (1 Oct 2026)', desk.input_value('#settingsDialog .joint-setup input[type=date]') == '2026-10-01')
        desk.screenshot(path=f'{OUT}/v014-1-setup.png')
        desk.fill('#settingsDialog .joint-setup .amount-input', '1250.00')
        desk.click('#settingsDialog .joint-setup button[type=submit]')
        toast_has(desk, 'Joint account added')
        desk.wait_for_selector('#settingsDialog #jointStatusLine')
        close_settings(desk)
        heads = desk.eval_on_selector_all('.acc-head .acc-name', 'els => els.map(e => e.textContent)')
        check('grid: Joint account column first, then yours', heads == ['Joint account', 'Current Account', 'Nationwide', 'Barclaycard'], heads)
        check('grid: people icon on the joint column', desk.locator('.acc-head >> nth=0').locator('.people-icon').count() == 1)
        check('grid: joint balance', '1,250.00' in desk.text_content('.acc-head >> nth=0'))
        tap_sync_both(desk)
        j = ledger_of('joint.json'); pl = ledger_of('personal.json')
        check('joint.json holds the joint account only', [a['name'] for a in j['accounts']] == ['Joint account'] and j['name'] == 'Joint', [a['name'] for a in j['accounts']])
        check('personal.json has no joint account, and was not rewritten', all(a['institution'] != 'joint' for a in pl['accounts']) and named('personal.json')[0]['version'] == personal_v)
        check('joint dot green once synced', 'sync-joint-green' in (joint_dot(desk) or ''), joint_dot(desk))
        check('this device now keeps joint records apart', {'jointLedger', 'jointSettings', 'jointSync'} <= set(idb_keys(desk)), idb_keys(desk))

        # ---- an entry on the joint account
        desk.click('.acc-head >> nth=0 >> .acc-add')
        desk.wait_for_selector('#txDialog[open]')
        opts = desk.eval_on_selector_all('#txDialog select option', 'els => els.map(e => e.textContent)')
        check('joint entry: can’t be linked to your own accounts', opts == ['No — just this account'], opts)
        desk.fill('#txDialog .amount-input', '185.00')
        desk.fill('#txDialog input[placeholder="e.g. Lottery"]', 'Council tax')
        desk.fill('#txDialog input[type=date]', '2026-10-01')
        desk.click('#txDialog button[type=submit]')
        desk.wait_for_selector('#txDialog[open]', state='detached')
        tap_sync_both(desk)
        check('the entry is in joint.json', [t['description'] for t in ledger_of('joint.json')['transactions']] == ['Council tax'])
        check('…and personal.json is untouched', named('personal.json')[0]['version'] == personal_v)

        # ---- your own account's transfer choices don't include the joint account
        desk.click('.acc-head >> nth=1 >> .acc-add')
        desk.wait_for_selector('#txDialog[open]')
        opts = desk.eval_on_selector_all('#txDialog select option', 'els => els.map(e => e.textContent)')
        check('own entry: transfer choices are your accounts only', 'Joint account' not in opts and 'Barclaycard' in opts, opts)
        desk.keyboard.press('Escape')
        desk.wait_for_selector('#txDialog[open]', state='detached')

        # ---- recurring: "From Alison" on the joint account; the To list stays in the file
        desk.evaluate('() => document.querySelectorAll("dialog[open]").forEach(d => d.close())')
        open_settings(desk)
        desk.click('#settingsDialog button:has-text("Manage recurring items")')
        desk.wait_for_selector('#recurringDialog[open]')
        desk.click('#recurringDialog button:has-text("+ Add")')
        desk.wait_for_selector('#recurringEditDialog[open]')
        ed = '#recurringEditDialog'
        desk.fill(f'{ed} input[placeholder="e.g. Netflix"]', 'From Alison')
        desk.click(f'{ed} .seg-btn:has-text("Money in")')
        acc_select = desk.locator(f'{ed} select').first
        joint_id = desk.evaluate('() => document.querySelector(".acc-head").dataset.accHead')
        acc_select.select_option(joint_id)
        desk.click(f'{ed} .seg-btn:has-text("Transfer")')
        to_opts = desk.eval_on_selector_all(f'{ed} select >> nth=1 >> option', 'els => els.map(e => e.textContent)')
        check('recurring transfer from the joint account: To list is the joint file only', to_opts == ['Joint account'], to_opts)
        desk.click(f'{ed} .seg-btn:has-text("Money in")')
        desk.fill(f'{ed} .amount-input >> nth=0', '600.00')
        desk.locator(f'{ed} input[type=date]').first.fill('2026-10-01')
        day = desk.locator(f'{ed} input[inputmode=numeric]').first
        if day.count(): day.fill('28')
        desk.click(f'{ed} button[type=submit]')
        desk.wait_for_selector(f'{ed}[open]', state='detached')
        desk.evaluate('() => document.querySelectorAll("dialog[open]").forEach(d => d.close())')
        wait_synced(desk); tap_sync_both(desk)
        jl = ledger_of('joint.json')
        check('"From Alison" recurring item saved in joint.json', any(r.get('description') == 'From Alison' for r in jl['scheduledItems']), [r.get('description') for r in jl['scheduledItems']])
        check('personal.json still untouched', named('personal.json')[0]['version'] == personal_v)
        check('grid shows the projected "From Alison" in the joint column', 'From Alison' in desk.text_content('table.grid'))
        desk.screenshot(path=f'{OUT}/v014-2-desk-grid.png')

        # ---- phone: off until turned on there, then gets everything
        phone = device(b, 360, 780, True)
        phone.wait_for_selector('.setup-form')
        open_settings(phone)
        phone.click('#settingsDialog button:has-text("Connect Google Drive")')
        phone.wait_for_selector('.feed', timeout=8000)
        close_settings(phone)
        tabs = phone.eval_on_selector_all('.tab-name', 'els => els.map(e => e.textContent)')
        check('phone: joint off there → no joint tab', 'Joint account' not in tabs, tabs)
        open_settings(phone)
        phone.click('#settingsDialog .joint-section button:has-text("Turn on")')
        toast_has(phone, 'Joint account on')
        check('phone: turning on found the existing file (no second file, no setup form)', len(named('joint.json')) == 1 and phone.locator('#settingsDialog .joint-setup').count() == 0)
        close_settings(phone)
        tabs = phone.eval_on_selector_all('.tab-name', 'els => els.map(e => e.textContent)')
        check('phone: Joint is the first account tab (after Summary, v0.14)', tabs[:2] == ['Summary', 'Joint account'], tabs)
        phone.click('.tab:has-text("Joint account")')
        check('phone: joint feed has Council tax', 'Council tax' in phone.text_content('.feed'))
        bar_h = phone.evaluate('document.querySelector(".topbar").getBoundingClientRect().height')
        check('phone (360px): top bar still 57px with the chip and joint dot', abs(bar_h - 57) < 0.6, bar_h)
        check('phone: joint dot showing', 'sync-joint' in (joint_dot(phone) or ''))
        phone.screenshot(path=f'{OUT}/v014-3-phone-joint.png')

        # phone adds a joint entry; desktop gets it, personal file untouched
        phone.click('#fab'); phone.wait_for_selector('#txDialog[open]')
        phone.fill('#txDialog .amount-input', '32.10')
        phone.fill('#txDialog input[placeholder="e.g. Lottery"]', 'Water')
        phone.fill('#txDialog input[type=date]', '2026-10-07')
        phone.click('#txDialog button[type=submit]'); phone.wait_for_selector('#txDialog[open]', state='detached')
        tap_sync_both(phone)
        tap_sync_both(desk)
        check('desktop has the phone’s joint entry', 'Water' in desk.text_content('table.grid'))
        check('personal.json still untouched by joint work', named('personal.json')[0]['version'] == personal_v)

        # ---- a joint clash: its own dialog, titled Joint account
        wid = [t for t in ledger_of('joint.json')['transactions'] if t['description'] == 'Water'][0]['id']
        for pg, amt in ((desk, '33.00'), (phone, '34.00')):
            pg.evaluate('() => window.__noop = 1')
        desk.click('table.grid td.c-desc:has-text("Water")'); desk.wait_for_selector('#txDialog[open]')
        desk.fill('#txDialog .amount-input', '33.00'); desk.click('#txDialog button[type=submit]'); desk.wait_for_selector('#txDialog[open]', state='detached')
        tap_sync_both(desk)
        phone.click('.feed .desc-text:text-is("Water")'); phone.wait_for_selector('#txDialog[open]')
        phone.fill('#txDialog .amount-input', '34.00'); phone.click('#txDialog button[type=submit]'); phone.wait_for_selector('#txDialog[open]', state='detached')
        hide_toast(phone); phone.click('#syncChip')
        phone.wait_for_selector('#conflictDialog[open]', timeout=8000)
        check('joint clash: own dialog headed "Joint account"', 'Joint account' in phone.text_content('#conflictDialog h2'), phone.text_content('#conflictDialog h2'))
        phone.screenshot(path=f'{OUT}/v014-4-phone-clash.png')
        phone.click('#conflictDialog button:has-text("Keep these")')
        toast_has(phone, 'Clash resolved')
        wait_synced(phone)
        amt = [t for t in ledger_of('joint.json')['transactions'] if t['id'] == wid][0]['amount']
        check('clash kept this device’s version in joint.json', amt == 3400, amt)

        # ---- turn off on the desktop: gone from screen, Drive untouched; back on = no setup, same file
        open_settings(desk)
        jv = named('joint.json')[0]['version']
        desk.click('#settingsDialog .joint-section button:has-text("Turn off on this device")')
        toast_has(desk, 'Joint account off')
        close_settings(desk)
        heads = desk.eval_on_selector_all('.acc-head .acc-name', 'els => els.map(e => e.textContent)')
        check('off: joint column gone', 'Joint account' not in heads, heads)
        check('off: joint dot gone', joint_dot(desk) is None)
        check('off: Drive joint file untouched', named('joint.json')[0]['version'] == jv)
        check('off: this device keeps its copy (quick to turn back on)', 'jointLedger' in idb_keys(desk))
        hide_toast(desk); desk.click('#syncChip'); toast_has(desk, 'Synced with Google Drive')
        check('off: chip tap syncs personal only (old message)', True)
        open_settings(desk)
        desk.click('#settingsDialog .joint-section button:has-text("Turn on")')
        toast_has(desk, 'Joint account on')
        close_settings(desk)
        check('back on: joint column back with the phone’s change', 'Joint account' in desk.text_content('.acc-head >> nth=0') and '34.00' in desk.text_content('table.grid'))
        check('back on: still one joint file', len(named('joint.json')) == 1)

        # ---- exports: a joint export can't go into your own data
        open_settings(desk)
        with desk.expect_download() as dl:
            desk.click('#settingsDialog button:has-text("Download joint export")')
        path = dl.value.path(); jname = dl.value.suggested_filename
        check('joint export named finance-joint-…', jname.startswith('finance-joint-2026-10-07'), jname)
        exported = json.load(open(path))['ledger']
        check('joint export holds the joint file only', exported['name'] == 'Joint' and len(exported['accounts']) == 1)
        close_settings(desk)
        open_settings(phone)
        phone.click('#settingsDialog .joint-section button:has-text("Turn off on this device")')
        toast_has(phone, 'Joint account off')
        hide_toast(phone)
        phone.set_input_files('#importInput', path)
        toast_has(phone, 'That is a joint account export')
        check('joint export refused into personal data while joint is off', True)
        close_settings(phone)

        # ---- erase on the phone: joint goes too (local only)
        open_settings(phone)
        phone.click('#settingsDialog .joint-section button:has-text("Turn on")')
        toast_has(phone, 'Joint account on')
        phone.click('#settingsDialog button:has-text("Erase all data on this device")')
        phone.wait_for_selector('.setup-form', timeout=8000)
        keys = idb_keys(phone)
        check('erase: joint data gone from the device', 'jointLedger' not in keys and 'jointSync' not in keys, keys)
        check('erase: Drive joint file kept', len(named('joint.json')) == 1 and len(ledger_of('joint.json')['transactions']) == 2)

        # ---- desktop dark screenshot with the joint column
        dark = device(b, 1440, 900, False, 'dark')
        dark.wait_for_selector('.setup-form')
        open_settings(dark)
        dark.click('#settingsDialog button:has-text("Connect Google Drive")')
        dark.wait_for_selector('table.grid', timeout=8000)
        dark.click('#settingsDialog .joint-section button:has-text("Turn on")')
        toast_has(dark, 'Joint account on')
        close_settings(dark)
        dark.screenshot(path=f'{OUT}/v014-5-desk-dark.png')
        check('dark desktop: joint first', dark.text_content('.acc-head >> nth=0 >> .acc-name') == 'Joint account')

        # ---- passphrase lock on: the joint records are encrypted too, and come back after unlocking
        open_settings(dark)
        dark.click('#settingsDialog button:has-text("Turn on passphrase lock")'); dark.wait_for_selector('#lockDialog[open]')
        dark.fill('#lockNew', 'blue kettle river'); dark.fill('#lockAgain', 'blue kettle river')
        dark.click('#lockDialog button[type=submit]')
        dark.wait_for_selector('#lockDialog[open]', state='detached', timeout=15000)
        recs = dark.evaluate("""() => new Promise((res) => { const r = indexedDB.open('finance-tracker', 1);
          r.onsuccess = () => { const os = r.result.transaction('kv').objectStore('kv'); const out = {}; const q = os.openCursor();
            q.onsuccess = () => { const c = q.result; if (!c) return res(out); out[c.key] = c.value; c.continue(); }; }; })""")
        jk = [k for k in recs if k.startswith('joint')]
        check('lock on: joint records encrypted like the rest', set(jk) == {'jointLedger', 'jointSync', 'jointSettings'} and all(recs[k].get('__ftEnc') == 1 for k in jk), {k: list(recs[k])[:3] for k in jk})
        check('lock on: no joint text readable on the device', 'Council tax' not in json.dumps(recs) and 'Joint account' not in json.dumps(recs))
        dark.reload(); dark.wait_for_selector('#unlockPass')
        dark.fill('#unlockPass', 'blue kettle river'); dark.click('.lock-form button[type=submit]')
        dark.wait_for_selector('table.grid', timeout=15000)
        check('unlocked: joint column back', dark.text_content('.acc-head >> nth=0 >> .acc-name') == 'Joint account' and 'Council tax' in dark.text_content('table.grid'))
        b.close()
finally:
    server.terminate()

print()
print('errors:', errors if errors else 'none')
bad = [c for c in checks if not c[1]]
print(f'{len(checks) - len(bad)}/{len(checks)} checks passed')
sys.exit(1 if bad or errors else 0)
