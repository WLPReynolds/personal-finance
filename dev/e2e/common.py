"""Shared helpers for the browser end-to-end tests (Python + Playwright).
Run any test from the repo root, e.g.  python3 dev/e2e/walkthrough.py
Needs: pip install playwright (Chromium is used headless). Screenshots go to dev/e2e/shots/.
"""
import os, sys, json, re, time, itertools, subprocess, urllib.parse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(OUT, exist_ok=True)

def start_server(port):
    """Serve the app folder on localhost. Returns (process, url).
    E2E_PORT overrides the suite's own port, so suites can run side by side (several share a port)."""
    port = int(os.environ.get('E2E_PORT', port))
    proc = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    return proc, f'http://localhost:{port}/'

ids = itertools.count(1)

# v0.14: the phone now opens on the Summary page. The older suites were written
# for "opens on the first account", so every browser context opens that way
# (the ⚙ setting "In the list, open on: First account") unless it's created
# with new_context(landing_summary=True) — as summary_v014.py does.
try:
    from playwright.sync_api._generated import Browser as _Browser
    _orig_new_context = _Browser.new_context
    def _new_context(self, *args, landing_summary=False, **kwargs):
        ctx = _orig_new_context(self, *args, **kwargs)
        if not landing_summary:
            ctx.add_init_script("try { localStorage.setItem('ft.phoneLanding', 'account'); } catch (e) {}")
        return ctx
    _Browser.new_context = _new_context
except ImportError:
    pass

# v0.15.24: the app's own message box (#msgDialog) replaced the browser's alert()/confirm().
# The suites were written against native dialogs — page.on('dialog', handler) with d.message /
# d.accept() / d.dismiss() — so Page.on('dialog') is bridged: when the message box opens, the
# handler gets a native-looking dialog object (message = the old alert/confirm text) and the
# matching button is clicked for it.
_MSGBOX_JS = """
(() => {
  if (window.__ftMsgBoxWatch) return; window.__ftMsgBoxWatch = true;
  const seen = new WeakSet();
  new MutationObserver(async () => {
    const dlg = document.getElementById('msgDialog');
    const body = dlg && dlg.open ? dlg.firstElementChild : null;
    if (!body || seen.has(body)) return;
    seen.add(body);
    const title = body.querySelector('.msg-title')?.textContent ?? '';
    const text = [...body.querySelectorAll('.msg-text p')].map((p) => p.textContent).join('\\n\\n');
    const btns = [...body.querySelectorAll('.msg-actions button')];
    const confirmLike = btns.length > 1;
    const action = await window.__ftMsgBox(title.endsWith('?') ? title + '\\n\\n' + text : text, confirmLike ? 'confirm' : 'alert');
    (action === 'dismiss' && confirmLike ? btns[0] : btns[btns.length - 1]).click();
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['open'] });
})();
"""
class _MsgBoxDialog:
    def __init__(self, message, kind): self.message, self.type, self.action = message, kind, 'accept'
    def accept(self, prompt_text=None): self.action = 'accept'
    def dismiss(self): self.action = 'dismiss'
try:
    from playwright.sync_api._generated import Page as _Page
    _orig_page_on = _Page.on
    def _page_on(self, event, handler):
        if event != 'dialog':
            return _orig_page_on(self, event, handler)
        def respond(message, kind):
            d = _MsgBoxDialog(message, kind); handler(d); return d.action
        self.expose_function('__ftMsgBox', respond)
        self.add_init_script(_MSGBOX_JS)
        try: self.evaluate(_MSGBOX_JS)   # a page that's already loaded
        except Exception: pass
    _Page.on = _page_on
except ImportError:
    pass

# ---------------------------------------------------------------- Drive emulator
# In-memory stand-in for the googleapis.com endpoints src/drive.js uses.
# Attach with: context.route('https://www.googleapis.com/**', handle)
# Requests must carry 'Bearer test-token' (what the fake sign-ins hand out).
drive = {}  # id -> dict(name, parent, folder, text, version, trashed, mime)
log = []

def handle(route, request):
    url = urllib.parse.urlparse(request.url)
    qs = urllib.parse.parse_qs(url.query)
    path = url.path
    if request.headers.get('authorization') != 'Bearer test-token':
        return route.fulfill(status=401, body='{"error":{"message":"bad token"}}', content_type='application/json')
    def js(obj, status=200):
        return route.fulfill(status=status, body=json.dumps(obj), content_type='application/json')
    log.append(f'{request.method} {path}')
    if path == '/drive/v3/about':
        return js({'user': {'emailAddress': 'wayne@example.com'}})
    m = re.fullmatch(r'/drive/v3/files/([^/]+)', path)
    if m and request.method == 'GET':
        f = drive.get(m.group(1))
        if not f: return js({'error': {'message': 'not found'}}, 404)
        if qs.get('alt') == ['media']:
            return route.fulfill(status=200, body=f['text'], content_type='application/json')
        return js({'id': m.group(1), 'trashed': f['trashed'], 'mimeType': f['mime'], 'version': str(f['version'])})
    if m and request.method == 'DELETE':  # v0.9: pruning old backups
        if m.group(1) not in drive: return js({'error': {'message': 'not found'}}, 404)
        del drive[m.group(1)]
        return route.fulfill(status=204, body='')
    if m and request.method == 'PATCH':  # v0.14.8: move to the bin
        f = drive.get(m.group(1))
        if not f: return js({'error': {'message': 'not found'}}, 404)
        meta = json.loads(request.post_data or '{}')
        if 'trashed' in meta: f['trashed'] = bool(meta['trashed'])
        return js({'id': m.group(1)})
    m2 = re.fullmatch(r'/drive/v3/files/([^/]+)/copy', path)
    if m2 and request.method == 'POST':  # v0.9: daily backup = server-side copy
        src = drive[m2.group(1)]; meta = json.loads(request.post_data)
        fid = f'f{next(ids)}'
        drive[fid] = dict(name=meta['name'], parent=meta['parents'][0], folder=False, text=src['text'], version=1, trashed=False, mime=src['mime'], created=f'{next(ids):08d}')
        return js({'id': fid})
    if path == '/drive/v3/files' and request.method == 'GET':
        q = qs['q'][0]
        res = []
        for fid, f in drive.items():
            if f['trashed']: continue
            in_parent = f"'{f['parent'] or 'root'}' in parents" in q
            if "mimeType='application/vnd.google-apps.folder'" in q:
                if f['folder'] and f"name='{f['name']}'" in q and in_parent: res.append({'id': fid})
            elif "in parents" not in q:  # v0.11: by name anywhere (the ticket tracker's file)
                if not f['folder'] and f"name='{f['name']}'" in q:
                    res.append({'id': fid, 'version': str(f['version'])})
            elif "name=" not in q:  # v0.9: list a folder (backups)
                if not f['folder'] and in_parent:
                    res.append({'id': fid, 'name': f['name'], 'createdTime': f.get('created', '')})
            else:
                if not f['folder'] and in_parent and f"name='{f['name']}'" in q:
                    res.append({'id': fid, 'version': str(f['version'])})
        return js({'files': res})
    if path == '/drive/v3/files' and request.method == 'POST':
        meta = json.loads(request.post_data)
        fid = f'f{next(ids)}'
        drive[fid] = dict(name=meta['name'], parent=(meta.get('parents') or [None])[0], folder=True, text=None, version=1, trashed=False, mime=meta['mimeType'])
        return js({'id': fid})
    if path == '/upload/drive/v3/files' and request.method == 'POST':
        assert qs['uploadType'] == ['multipart']
        ctype = request.headers['content-type']
        boundary = ctype.split('boundary=')[1]
        parts = [p for p in request.post_data.split('--' + boundary) if p.strip() and p.strip() != '--']
        bodies = [p.split('\r\n\r\n', 1)[1].rstrip('\r\n') for p in parts]
        meta = json.loads(bodies[0]); text = bodies[1]
        json.loads(text)  # must be valid JSON
        fid = f'f{next(ids)}'
        drive[fid] = dict(name=meta['name'], parent=meta['parents'][0], folder=False, text=text, version=1, trashed=False, mime=meta['mimeType'])
        return js({'id': fid, 'version': '1'})
    m = re.fullmatch(r'/upload/drive/v3/files/([^/]+)', path)
    if m and request.method == 'PATCH':
        assert qs['uploadType'] == ['media']
        f = drive[m.group(1)]
        json.loads(request.post_data)
        f['text'] = request.post_data
        f['version'] += 1
        return js({'id': m.group(1), 'version': str(f['version'])})
    return js({'error': {'message': f'unhandled {request.method} {path}'}}, 500)

FAKE_AUTH = """
window.__FT_TEST__ = { auth: (() => {
  let token = null; let hint = null; let interactive = 0;
  return {
    async getToken({ interactive: i }) { if (token) return token; if (!i) return null; interactive++; token = 'test-token'; return token; },
    hasValidToken: () => Boolean(token),
    clearToken() { token = null; },
    setLoginHint(e) { hint = e; },
    lastAuthError: () => null,
    expire() { token = null; },
    stats: () => ({ interactive, hint }),
  };
})() };
"""


def drive_files():
    """The synced data file(s) — backups (v0.9) are left out."""
    return [f for f in drive.values() if not f['folder'] and not f['trashed'] and f['name'] == 'personal.json']

def backup_names():
    folder = [k for k, f in drive.items() if f['folder'] and f['name'] == 'backups']
    return sorted(f['name'] for f in drive.values() if not f['folder'] and f['parent'] in folder)

# ---------------------------------------------------------------- fake sign-in
# FAKE_AUTH replaces the whole auth module via window.__FT_TEST__ (used by the
# two-device sync test). GIS_STUB instead fakes Google's own script, so the
# real src/google-auth.js runs (used by the sign-in test).
FAKE_AUTH = """
window.__FT_TEST__ = { auth: (() => {
  let token = null; let hint = null; let interactive = 0;
  return {
    async getToken({ interactive: i }) { if (token) return token; if (!i) return null; interactive++; token = 'test-token'; return token; },
    hasValidToken: () => Boolean(token),
    clearToken() { token = null; },
    setLoginHint(e) { hint = e; },
    lastAuthError: () => null,
    expire() { token = null; },
    stats: () => ({ interactive, hint }),
  };
})() };
"""

GIS_STUB = """
window.__gis = { mode: 'ok', inits: [], requests: 0 };
window.google = { accounts: { oauth2: { initTokenClient(cfg) {
  window.__gis.inits.push({ hint: cfg.login_hint ?? null, scope: cfg.scope });
  const client = { callback: cfg.callback, requestAccessToken(opts) {
    window.__gis.requests++;
    setTimeout(() => {
      if (window.__gis.mode === 'ok') client.callback({ access_token: 'test-token', expires_in: 3599 });
      else cfg.error_callback({ type: 'popup_closed' });
    }, 30);
  } };
  return client;
} } } };
"""

# ---------------------------------------------------------------- first-run setup
# v0.15.8: the Quick start no longer pre-fills Current Account / Nationwide /
# Barclaycard. The suites were written for those three, so this fills the new
# "Set up your accounts" form with the same three (amounts in the same order).
LEGACY_SETUP = [('Current Account', 'current', 'other'), ('Nationwide', 'credit', 'nationwide'), ('Barclaycard', 'credit', 'barclaycard')]

def fill_setup(pg, amounts, accounts=LEGACY_SETUP):
    pg.wait_for_selector('.setup-form')
    for i, ((name, typ, inst), amount) in enumerate(zip(accounts, amounts)):
        if i: pg.click('.setup-form button:has-text("Add another account")')
        card = pg.locator('.setup-account').nth(i)
        card.locator('input[type=text]').first.fill(name)
        card.locator('select').nth(0).select_option(typ)
        card.locator('select').nth(1).select_option(inst)
        card.locator('.amount-input').fill(amount)


# ---- v0.15.21: Settings is a menu of pages (since v0.15.17), not one long sheet.
# The older suites clicked '#settingsDialog button:has-text(...)' straight after opening ⚙.
# These helpers open ⚙, find the page a control lives on, and close Settings fully
# (on a page, ✕ only goes back to the menu).
SETTINGS_PAGES = ['accounts', 'expenses', 'joint', 'drive', 'backups', 'history', 'tracker', 'layout', 'lock', 'device']

def settings_page(pg):
    """The open Settings page id, '' for the menu, None when Settings is closed."""
    if not pg.is_visible('#settingsDialog[open]'):
        return None
    return pg.get_attribute('#settingsDialog', 'data-page') or ''

def open_settings(pg, page=None):
    """Open ⚙ Settings if it isn't open. page: None = leave it where it is (as the old helpers did),
    '' = go to the menu, or a page id (e.g. 'accounts') = go to that page."""
    cur = settings_page(pg)
    if cur is None:
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        cur = settings_page(pg)
    if page is None or cur == page:
        return
    if cur:
        pg.click('#settingsDialog .settings-back')
        pg.wait_for_function('() => !document.getElementById("settingsDialog").dataset.page')
    if page:
        pg.click(f'#settingsDialog .settings-item[data-page={page}]')
        pg.wait_for_function('p => document.getElementById("settingsDialog").dataset.page === p', arg=page)

def settings_find(pg, selector):
    """Open Settings at the page where `selector` is visible (current page first). Returns the page id."""
    if settings_page(pg) is None:
        open_settings(pg)
    cur = settings_page(pg)
    if cur and pg.locator(selector).first.is_visible():
        return cur
    for page in SETTINGS_PAGES:
        open_settings(pg, '')
        if not pg.locator(f'#settingsDialog .settings-item[data-page={page}]').count():
            continue  # e.g. Ticket tracker, only listed when something uses it
        open_settings(pg, page)
        if pg.locator(selector).first.is_visible():
            return page
    raise AssertionError(f'not on any Settings page: {selector}')

def settings_click(pg, selector):
    settings_find(pg, selector)
    pg.click(selector)

def close_settings(pg):
    """Close Settings completely, from the menu or from a page."""
    for _ in range(3):
        if not pg.is_visible('#settingsDialog[open]'):
            return
        pg.click('#settingsDialog .sheet-head .icon-btn')
        pg.wait_for_timeout(50)

def settings_text(pg, *pages):
    """The text of the given Settings pages (the menu for ''), as one string; ends on the last page."""
    out = []
    for page in pages:
        open_settings(pg, page)
        out.append(pg.text_content('#settingsDialog'))
    return '\n'.join(out)
