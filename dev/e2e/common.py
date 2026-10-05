"""Shared helpers for the browser end-to-end tests (Python + Playwright).
Run any test from the repo root, e.g.  python3 dev/e2e/walkthrough.py
Needs: pip install playwright (Chromium is used headless). Screenshots go to dev/e2e/shots/.
"""
import os, sys, json, re, time, itertools, subprocess, urllib.parse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(OUT, exist_ok=True)

def start_server(port):
    """Serve the app folder on localhost. Returns (process, url)."""
    proc = subprocess.Popen([sys.executable, '-m', 'http.server', str(port)], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    return proc, f'http://localhost:{port}/'

ids = itertools.count(1)

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
    if path == '/drive/v3/files' and request.method == 'GET':
        q = qs['q'][0]
        res = []
        for fid, f in drive.items():
            if f['trashed']: continue
            if "mimeType='application/vnd.google-apps.folder'" in q:
                if f['folder'] and f"name='{f['name']}'" in q: res.append({'id': fid})
            else:
                if not f['folder'] and f"'{f['parent']}' in parents" in q and f"name='{f['name']}'" in q:
                    res.append({'id': fid, 'version': str(f['version'])})
        return js({'files': res})
    if path == '/drive/v3/files' and request.method == 'POST':
        meta = json.loads(request.post_data)
        fid = f'f{next(ids)}'
        drive[fid] = dict(name=meta['name'], parent=None, folder=True, text=None, version=1, trashed=False, mime=meta['mimeType'])
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
    return [f for f in drive.values() if not f['folder'] and not f['trashed']]

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
