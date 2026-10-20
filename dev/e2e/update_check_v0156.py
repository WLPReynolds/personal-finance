"""v0.15.6 — a tab left open notices a newer deploy.
1. Fresh load: no update bar.
2. Coming back to the tab while the server still has the same version: no bar.
3. The server now has a newer index.html: coming back to the tab shows
   "A newer version … is available" with a reload button; nothing reloads by itself.
4. An OLDER index.html from the server (a cached page) never shows the bar.
Run: python3 dev/e2e/update_check_v0156.py"""
from common import *
from playwright.sync_api import sync_playwright

server, URL = start_server(8786)
checks = []
APP_V = re.search(r"APP_VERSION = '([^']+)'", open(os.path.join(ROOT, 'src', 'app.js')).read()).group(1)
major, minor, patch = map(int, APP_V.split('.'))
served = {'version': APP_V}

def check(label, ok, detail=''):
    checks.append((label, bool(ok))); print(('PASS ' if ok else 'FAIL ') + label + (f'  [{detail}]' if detail else ''))

def page_route(route):
    html = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
    html = re.sub(r'(<meta name="app-version" content=")[^"]+', r'\g<1>' + served['version'], html)
    route.fulfill(status=200, body=html, content_type='text/html')

def come_back(pg):
    """Hide then show the tab, skipping the 10-minute gap between checks."""
    pg.evaluate("""() => {
      const set = (v) => { Object.defineProperty(document, 'visibilityState', { value: v, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
      set('hidden'); set('visible');
    }""")
    pg.wait_for_timeout(800)

def bar(pg):
    return pg.evaluate("() => document.getElementById('updateBanner')?.textContent ?? null")

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(service_workers='block')
        pg = ctx.new_page()
        pg.route(re.compile(r'.*/index\.html(\?.*)?$'), page_route)
        pg.goto(URL + 'index.html'); pg.wait_for_timeout(1200)
        check('fresh load: no update bar', bar(pg) is None, bar(pg))

        # first return to the tab is due (never checked); same version → nothing
        come_back(pg)
        check('same version on the server: no bar', bar(pg) is None, bar(pg))

        # an older page from the server must never prompt (a reload resets the 10-minute gap)
        pg.reload(); pg.wait_for_timeout(1200)
        served['version'] = f'{major}.{minor}.{max(patch - 1, 0)}'
        come_back(pg)
        check('older page on the server: no bar', bar(pg) is None, bar(pg))

        served['version'] = APP_V
        pg.reload(); pg.wait_for_timeout(1200)
        newer = f'{major}.{minor}.{patch + 1}'
        served['version'] = newer
        url_before = pg.url
        come_back(pg)
        text = bar(pg) or ''
        check('newer version on the server: bar shows', 'newer version' in text and newer in text, text)
        check('bar has a reload button', pg.query_selector('#updateBanner button') is not None)
        check('nothing reloaded by itself', pg.url == url_before and pg.evaluate("() => !!document.getElementById('updateBanner')"))
        pg.screenshot(path=os.path.join(OUT, 'v0156-update-bar.png'))
        b.close()
finally:
    server.terminate()

bad = [l for l, ok in checks if not ok]
print(f'\n{len(checks) - len(bad)}/{len(checks)} passed')
sys.exit(1 if bad else 0)
