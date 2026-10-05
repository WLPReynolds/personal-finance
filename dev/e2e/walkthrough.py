"""Basic phone + desktop walkthrough without sync: setup, entries, transfer,
note, autocomplete prefill, export on phone, import on desktop, grid edits.
Run: python3 dev/e2e/walkthrough.py"""
from common import *
from playwright.sync_api import sync_playwright

server, URL = start_server(8765)
errors = []

def watch(page, label):
    page.on('console', lambda m: m.type == 'error' and errors.append(f'{label} console: {m.text}'))
    page.on('pageerror', lambda e: errors.append(f'{label} pageerror: {e}'))
    page.on('dialog', lambda d: d.accept())

def add(page, amount, desc, date, kind=None, other=None):
    page.click('#fab')
    page.wait_for_selector('#txDialog[open]')
    if kind:
        page.click(f'#txDialog .seg-btn[data-value="{kind}"]')
    if kind != 'note':
        page.fill('#txDialog .amount-input', amount)
    page.fill('#txDialog input[list]', desc)
    page.fill('#txDialog input[type=date]', date)
    if other:
        page.select_option('#txDialog select', label=other)
    page.click('#txDialog button[type=submit]')
    try:
        page.wait_for_selector('#txDialog[open]', state='detached', timeout=5000)
    except Exception:
        page.screenshot(path=f'{OUT}/stuck.png')
        print('STUCK on', desc, page.evaluate('''() => ({
          amount: document.querySelector('#txDialog .amount-input')?.value,
          desc: document.querySelector('#txDialog input[list]')?.value,
          date: document.querySelector('#txDialog input[type=date]')?.value,
          seg: [...document.querySelectorAll('#txDialog .seg-btn')].map(b => b.dataset.value + ':' + b.getAttribute('aria-checked')).join(' '),
          toast: document.getElementById('toast')?.hidden ? null : document.getElementById('toast')?.textContent,
          active: document.activeElement?.outerHTML?.slice(0, 120),
        })'''))
        raise

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        # ---------------- phone
        phone = b.new_context(viewport={'width': 412, 'height': 915}, device_scale_factor=2, is_mobile=True, has_touch=True,
                              user_agent='Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36', accept_downloads=True)
        pg = phone.new_page(); watch(pg, 'phone')
        pg.goto(URL); pg.wait_for_selector('.setup-form')
        pg.screenshot(path=f'{OUT}/1-phone-setup.png')
        inputs = pg.query_selector_all('.setup-form .amount-input')
        for el, v in zip(inputs, ['3600', '6', '1000']):
            el.fill(v)
        pg.fill('.setup-form input[type=date]', '2026-10-01')
        pg.click('.setup-form button[type=submit]')
        pg.wait_for_selector('.feed')
        add(pg, '15', 'Lottery', '2026-10-01')
        add(pg, '611.96', 'Barclaycard direct debit', '2026-10-02', kind='debit', other='Barclaycard')
        add(pg, '4000', 'Salary', '2026-10-03', kind='credit')
        add(pg, '5.99', 'Netflix', '2026-10-04')
        # backfill an older one after newer ones
        add(pg, '57.99', 'Gym', '2026-10-02')
        pg.screenshot(path=f'{OUT}/2-phone-current.png')
        # switch to Barclaycard tab, add spend + note
        pg.click('.tab:has-text("Barclaycard")')
        add(pg, '27.49', 'Loveholidays', '2026-10-03')
        add(pg, '', 'BARCLAYCARD STATEMENT', '2026-10-04', kind='note')
        pg.screenshot(path=f'{OUT}/3-phone-barclaycard.png')
        # open the fab form with autocomplete prefill
        pg.click('#fab'); pg.wait_for_selector('#txDialog[open]')
        pg.fill('#txDialog input[list]', 'Loveholidays'); pg.dispatch_event('#txDialog input[list]', 'change')
        pg.screenshot(path=f'{OUT}/4-phone-entry-sheet.png')
        prefill = pg.input_value('#txDialog .amount-input')
        pg.click('#txDialog .icon-btn')
        bal_text = pg.inner_text('.banner-amount')
        # export
        pg.click('#settingsBtn'); pg.wait_for_selector('#settingsDialog[open]')
        pg.screenshot(path=f'{OUT}/5-phone-settings.png')
        with pg.expect_download() as dl:
            pg.click('#settingsDialog button:has-text("Download export")')
        export_path = f'{OUT}/export.json'
        dl.value.save_as(export_path)
        print('phone barclaycard owed:', bal_text, '| prefill amount:', prefill)

        # ---------------- desktop (fresh storage), import
        desk = b.new_context(viewport={'width': 1440, 'height': 900})
        dp = desk.new_page(); watch(dp, 'desktop')
        dp.goto(URL); dp.wait_for_selector('.setup-form')
        dp.set_input_files('#importInput', export_path)
        dp.wait_for_selector('table.grid')
        dp.screenshot(path=f'{OUT}/6-desktop-grid.png')
        # click an empty Nationwide credit cell on the salary row to add there
        row = dp.locator('table.grid tbody tr', has_text='Salary')
        row.locator('td.cell').nth(2).click()  # Nationwide credit
        dp.wait_for_selector('#txDialog[open]')
        dp.screenshot(path=f'{OUT}/7-desktop-add-dialog.png')
        dp.fill('#txDialog .amount-input', '6')
        dp.fill('#txDialog input[list]', 'Nationwide direct debit')
        dp.click('#txDialog button[type=submit]')
        # edit the transfer from desktop: change amount on the barclaycard leg
        dp.locator('table.grid tbody tr', has_text='Barclaycard direct debit').locator('td.c-desc').click()
        dp.wait_for_selector('#txDialog[open]')
        dp.fill('#txDialog .amount-input', '600')
        dp.click('#txDialog button[type=submit]')
        dp.wait_for_timeout(300)
        dp.screenshot(path=f'{OUT}/8-desktop-after-edits.png')
        totals = dp.eval_on_selector_all('.acc-total', 'els => els.map(e => e.textContent)')
        print('desktop totals:', totals)
        has_dot = dp.is_visible('#unexportedDot')
        print('unexported dot after edits:', has_dot)
        b.close()
finally:
    server.terminate()

print('errors:', errors or 'none')
