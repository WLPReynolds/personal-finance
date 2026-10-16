/**
 * v0.14.8: screens for the history imported from Budget.xlsx — the ⚙
 * section, the import (pick file → name the columns → check → import) and
 * the viewer (browse a year like the spreadsheet; search every year with a
 * total per year and a grand total). Read-only: nothing here touches the
 * ledger. Logic lives in lib/archive.js; this file only draws.
 */
import { readWorkbook } from './lib/xlsx-read.js';
import {
  parseSheet, buildYear, checkYear, checkCount, suggestName, isGenericLabel, nameMemoryKey,
  emptyArchive, withYears, yearsOf, archiveAccounts, yearView, searchArchive,
} from './lib/archive.js';
import { uploadArchiveYears, downloadArchiveYears, trashArchiveYears } from './lib/archive-drive.js';
import { loadArchive, saveArchive, removeArchive } from './store.js';
import { formatPence } from './lib/money.js';

/**
 * ctx: { h, $, toast, openDialog, isOpen, sync, drive, firstLiveDate(), renderSettings(), isWide() }
 */
export function createArchiveUI(ctx) {
  const { h, $, toast, openDialog, isOpen, sync, drive } = ctx;
  let archive = null; // this device's copy, loaded on first use
  let loaded = false;

  async function ensureLoaded() {
    if (!loaded) {
      archive = (await loadArchive().catch(() => null)) ?? null;
      loaded = true;
    }
    return archive;
  }
  const hasArchive = () => Boolean(archive && yearsOf(archive).length);

  const longDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const dayMonth = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—');
  const shortDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const money = (p) => (p === null || p === undefined ? '' : formatPence(p, { symbol: false }));
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const yearsText = (ys) => {
    const list = ys.map((y) => y.year ?? y).sort((a, b) => a - b);
    if (!list.length) return '';
    const contiguous = list.every((y, i) => i === 0 || y === list[i - 1] + 1);
    return contiguous && list.length > 2 ? `${list[0]}–${list[list.length - 1]}` : list.join(', ');
  };

  // ---------------------------------------------------------------- ⚙ section

  function settingsSection() {
    if (!loaded) ensureLoaded().then(() => { if (isOpen('settingsDialog')) ctx.renderSettings(); });
    const ys = yearsOf(archive);
    const syncing = sync.isEnabled();
    const rows = ys.reduce((n, y) => n + y.rows.length, 0);
    return h('section', { class: 'settings-section' },
      h('h3', {}, 'History from Excel'),
      ys.length
        ? h('p', { class: 'small' }, `${yearsText(ys)} · ${plural(rows, 'row')} · read only`)
        : h('p', { class: 'muted small' }, 'Bring in your Budget spreadsheet’s earlier years to browse and search. It’s kept apart from your accounts and never changes them.'),
      h('div', { class: 'btn-row' },
        ys.length ? h('button', { type: 'button', class: 'btn-primary', onclick: openViewer }, 'Open history') : null,
        h('button', { type: 'button', class: ys.length ? 'btn-secondary' : 'btn-primary', onclick: openImport }, ys.length ? 'Import again…' : 'Import from Excel…'),
        syncing ? h('button', { type: 'button', class: 'btn-secondary', onclick: fetchFromDrive }, ys.length ? 'Update from Drive' : 'Get from Drive') : null),
      ys.length ? h('button', { type: 'button', class: 'btn-danger btn-small', onclick: deleteAll }, 'Delete imported history…') : null,
      syncing ? h('p', { class: 'muted small' }, 'Imports are saved to My Drive/Finance/Archive too, one file per year, so your other device can get them.') : null);
  }

  /** Called straight from a tap: Google's sign-in may be needed (the Android rule — no await first). */
  function fetchFromDrive() {
    const p = sync.withSyncToken((token) => downloadArchiveYears(drive, token), { interactive: true });
    toast('Getting your history from Drive…');
    p.then(async ({ years, skipped }) => {
      await ensureLoaded();
      if (!years.length) {
        toast(skipped.length ? `Couldn’t read ${skipped.join(', ')} on Drive` : 'No history on Drive yet — import it on the device that has the spreadsheet', 'error');
        return;
      }
      const onDrive = new Set(years.map((y) => y.year));
      const localOnly = yearsOf(archive).filter((y) => !onDrive.has(y.year)).map((y) => y.year);
      let keep = [];
      if (localOnly.length) {
        keep = confirm(`${localOnly.join(', ')} ${localOnly.length === 1 ? 'is' : 'are'} on this device but not on Drive.\n\nOK keeps ${localOnly.length === 1 ? 'it' : 'them'} here as well. Cancel uses only what’s on Drive.`)
          ? yearsOf(archive).filter((y) => localOnly.includes(y.year)) : [];
      }
      archive = withYears({ ...emptyArchive(), names: archive?.names ?? {} }, [...keep, ...years]);
      await saveArchive(archive);
      // redraw first: a redraw replaces the dialog's contents, toast included
      if (isOpen('settingsDialog')) ctx.renderSettings();
      toast(`History: ${yearsText(yearsOf(archive))} on this device${skipped.length ? ` (couldn’t read ${skipped.join(', ')})` : ''}`);
    }).catch((err) => toast(err?.message ?? String(err), 'error'));
  }

  function deleteAll() {
    const syncing = sync.isEnabled();
    const msg = `Delete the imported history (${yearsText(yearsOf(archive))}) from this device?` +
      (syncing ? '\n\nIts files on Drive (My Drive/Finance/Archive) go to Drive’s bin too, where they can be recovered for 30 days. Your other device keeps its own copy until you delete it there.' : '') +
      '\n\nYour accounts and entries are not touched. You can import the spreadsheet again any time.';
    if (!confirm(msg)) return;
    // the sign-in (if needed) must start from this tap, before anything is awaited
    const trash = syncing ? sync.withSyncToken((token) => trashArchiveYears(drive, token), { interactive: true }) : null;
    (async () => {
      await removeArchive();
      archive = null;
      if (isOpen('archiveDialog')) $('archiveDialog').close();
      let note = '';
      if (trash) {
        try { await trash; } catch (err) { note = ` — but the Drive files are still there (${err?.message ?? err})`; }
      }
      if (isOpen('settingsDialog')) ctx.renderSettings();
      toast(`Imported history deleted${note}`, note ? 'error' : 'ok');
    })();
  }

  // ---------------------------------------------------------------- import

  let imp = null; // { fileName, sheets: [{ parsed, include, names: [] }], step }

  function openImport() {
    ensureLoaded();
    imp = { step: 'file' };
    renderImport();
    openDialog($('archiveImportDialog'));
  }

  async function readFile(file) {
    imp = { step: 'reading', fileName: file.name };
    renderImport();
    try {
      await ensureLoaded();
      const wb = await readWorkbook(await file.arrayBuffer());
      const memory = archive?.names ?? {};
      const sheets = wb.sheets.map((s) => {
        const parsed = parseSheet(s, { date1904: wb.date1904 });
        const names = parsed.groups.map((g) => memory[nameMemoryKey(parsed.sheet, g.label)] ?? suggestName(g.label));
        return { parsed, include: !parsed.problem && parsed.year !== null && !s.hidden, names, hidden: s.hidden };
      });
      if (!sheets.some((s) => s.include)) throw new Error('No year sheets with a Date / Description / Credit / Debit / Balance header were found in that file');
      imp = { step: 'names', fileName: file.name, sheets };
    } catch (err) {
      imp = { step: 'file', error: err?.message ?? String(err) };
    }
    renderImport();
  }

  /** Build every included year and its checks (in year order, each chained to the year before). */
  function buildAll() {
    const out = [];
    const first = ctx.firstLiveDate();
    const included = imp.sheets.filter((s) => s.include).sort((a, b) => a.parsed.year - b.parsed.year);
    const byYear = new Map();
    for (const s of included) {
      try {
        if (byYear.has(s.parsed.year)) throw new Error(`Sheet “${byYear.get(s.parsed.year).sheet}” is also ${s.parsed.year} — leave one of them out`);
        const year = buildYear(s.parsed, s.names, { firstLiveDate: first, sourceFile: imp.fileName });
        byYear.set(year.year, year);
        out.push({ s, year });
      } catch (err) {
        out.push({ s, error: err?.message ?? String(err) });
      }
    }
    for (const o of out) {
      if (!o.year) continue;
      const prev = byYear.get(o.year.year - 1) ?? archive?.years?.[o.year.year - 1] ?? null;
      o.checks = checkYear(o.year, prev);
    }
    return out;
  }

  function renderImport() {
    const dlg = $('archiveImportDialog');
    const close = () => dlg.close();
    const head = (title) => h('header', { class: 'sheet-head' }, h('h2', {}, title),
      h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: close }, '✕'));

    if (imp.step === 'file' || imp.step === 'reading') {
      const input = h('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'arch-file',
        onchange: () => { if (input.files?.[0]) readFile(input.files[0]); } });
      dlg.replaceChildren(h('div', { class: 'sheet-body' },
        head('Import history from Excel'),
        h('p', { class: 'small' }, 'Choose your Budget spreadsheet (.xlsx). Every year sheet in it is read on this device — nothing is uploaded while it’s read.'),
        h('ul', { class: 'small arch-points' },
          h('li', {}, 'You’ll confirm the bank for each group of Credit / Debit / Balance columns.'),
          h('li', {}, 'Balances are kept exactly as the sheet shows them; the import only checks them.'),
          h('li', {}, `Rows from ${ctx.firstLiveDate() ? longDate(ctx.firstLiveDate()) : 'the day your app records start'} on are left out — the app has those already.`)),
        imp.error ? h('p', { class: 'warn small' }, imp.error) : null,
        imp.step === 'reading'
          ? h('p', { class: 'small' }, `Reading ${imp.fileName}…`)
          : h('label', { class: 'btn-primary arch-pick' }, 'Choose file…', input)));
      return;
    }

    if (imp.step === 'names') {
      const names = new Set([...archiveAccounts(archive).map((a) => a.name), ...imp.sheets.flatMap((s) => s.names)].filter(Boolean));
      const list = h('datalist', { id: 'archNameList' }, [...names].sort().map((n) => h('option', { value: n })));
      const sheetBlocks = imp.sheets.map((s) => {
        const p = s.parsed;
        const inc = h('input', { type: 'checkbox', checked: s.include, disabled: Boolean(p.problem) || p.year === null,
          onchange: () => { s.include = inc.checked; renderImport(); } });
        return h('section', { class: `arch-sheet ${s.include ? '' : 'excluded'}` },
          h('label', { class: 'check arch-sheet-head' }, inc,
            h('strong', {}, `Sheet “${p.sheet}”`),
            h('span', { class: 'muted small' }, p.problem ? ` · ${p.problem}` : ` · ${p.year ?? 'no year'} · ${plural(p.rows.length, 'row')}${s.hidden ? ' · hidden sheet' : ''}`)),
          s.include ? h('div', { class: 'arch-groups' }, p.groups.map((g, i) => {
            const field = h('input', { type: 'text', value: s.names[i] ?? '', list: 'archNameList', placeholder: 'Leave out', 'aria-label': `Name for ${g.label || 'columns'} on ${p.sheet}`,
              oninput: () => { s.names[i] = field.value; } });
            return h('label', { class: 'field arch-group' },
              h('span', {}, g.label || '(no label)', g.context.length ? h('span', { class: 'muted' }, ` · ${g.context.join(' · ')}`) : null),
              field,
              isGenericLabel(g.label) ? h('span', { class: 'small warn-text' }, 'This label doesn’t say which bank — check it’s right for this year.') : null);
          })) : null);
      });
      dlg.replaceChildren(h('div', { class: 'sheet-body' },
        head('Name the accounts'),
        h('p', { class: 'small' }, `${imp.fileName}: name each group of columns. The same name in different years is treated as one account, so searches follow it across years. Clear a name to leave those columns out.`),
        list,
        sheetBlocks,
        h('div', { class: 'sheet-actions' },
          h('button', { type: 'button', class: 'btn-secondary', onclick: () => { imp = { step: 'file' }; renderImport(); } }, 'Back'),
          h('button', { type: 'button', class: 'btn-primary', onclick: () => { imp.step = 'check'; renderImport(); } }, 'Next: check'))));
      return;
    }

    if (imp.step === 'check') {
      const built = buildAll();
      const good = built.filter((b) => b.year);
      const replacing = good.filter((b) => archive?.years?.[b.year.year]).map((b) => b.year.year);
      const first = ctx.firstLiveDate();
      const leftOut = good.reduce((n, b) => n + b.year.leftOut, 0);
      const blocks = built.map((b) => b.error
        ? h('section', { class: 'arch-check' }, h('h4', {}, `Sheet “${b.s.parsed.sheet}”`), h('p', { class: 'warn small' }, b.error))
        : checkBlock(b));
      const doImport = () => doImportYears(good.map((b) => b.year), imp.sheets);
      dlg.replaceChildren(h('div', { class: 'sheet-body' },
        head('Check before importing'),
        h('p', { class: 'small' }, good.length
          ? `${plural(good.length, 'year')} ready: ${yearsText(good.map((b) => b.year))}, ${plural(good.reduce((n, b) => n + b.year.rows.length, 0), 'row')}.`
          : 'Nothing can be imported yet — see below.'),
        first && leftOut ? h('p', { class: 'muted small' }, `${plural(leftOut, 'row')} from ${longDate(first)} on left out (your app records start then).`) : null,
        replacing.length ? h('p', { class: 'small warn' }, `Already imported: ${replacing.join(', ')}. Importing replaces ${replacing.length === 1 ? 'it' : 'them'}.`) : null,
        h('p', { class: 'muted small' }, 'Anything listed below is imported exactly as it is. To correct it, fix the spreadsheet and import again — that year is replaced.'),
        blocks,
        h('div', { class: 'sheet-actions' },
          h('button', { type: 'button', class: 'btn-secondary', onclick: () => { imp.step = 'names'; renderImport(); } }, 'Back'),
          h('button', { type: 'button', class: 'btn-primary', disabled: !good.length, onclick: doImport }, good.length ? `Import ${plural(good.length, 'year')}` : 'Import'))));
    }
  }

  function checkBlock({ s, year, checks }) {
    const n = checkCount(checks);
    const item = (row, text) => h('li', {}, h('span', { class: 'arch-rowref' }, `Row ${row}`), ' ', text);
    const lists = [];
    if (checks.outOfOrder.length) {
      lists.push(h('p', { class: 'small arch-kind' }, `Date out of order (${checks.outOfOrder.length})`),
        h('ul', { class: 'arch-issues small' }, checks.outOfOrder.map((x) => item(x.n,
          `${dayMonth(x.d)} “${x.t}” sits between ${dayMonth(x.between[0])} and ${dayMonth(x.between[1])}`))));
    }
    if (checks.balances.length) {
      lists.push(h('p', { class: 'small arch-kind' }, `Balance differs from the row above ± this row (${checks.balances.length})`),
        h('ul', { class: 'arch-issues small' }, checks.balances.map((x) => item(x.n,
          `${x.name}: “${x.t}” shows ${formatPence(x.stored)}, the figures make it ${formatPence(x.expected)}`))));
    }
    if (checks.chain.length) {
      lists.push(h('p', { class: 'small arch-kind' }, `Brought forward differs from ${year.year - 1}’s closing balance (${checks.chain.length})`),
        h('ul', { class: 'arch-issues small' }, checks.chain.map((x) => h('li', {},
          `${x.name}: ${formatPence(x.opening)} brought forward, ${year.year - 1} closed at ${formatPence(x.previousClosing)}`))));
    }
    if (checks.noDate.length) {
      lists.push(h('p', { class: 'small arch-kind' }, `No date (the date above was used) (${checks.noDate.length})`),
        h('ul', { class: 'arch-issues small' }, checks.noDate.map((x) => item(x.n, `“${x.t || '(no description)'}”`))));
    }
    const details = h('details', { class: 'arch-details', open: n > 0 && n <= 12 },
      h('summary', {}, n ? `${plural(n, 'thing')} to look at` : 'No problems found'), lists);
    return h('section', { class: 'arch-check' },
      h('h4', {}, `${year.year}`, h('span', { class: 'muted small' }, ` · sheet “${s.parsed.sheet}” · ${plural(year.rows.length, 'row')} · ${year.accounts.map((a) => a.name).join(', ')}`)),
      n ? details : h('p', { class: 'small ok-text' }, '✓ No problems found'));
  }

  function doImportYears(years, sheets) {
    // start Google's sign-in (if needed) from this tap, before anything is awaited
    const syncing = sync.isEnabled();
    const upload = syncing ? sync.withSyncToken((token) => uploadArchiveYears(drive, token, years), { interactive: true }) : null;
    upload?.catch(() => {}); // handled below
    (async () => {
      const remembered = {};
      for (const s of sheets) {
        if (!s.include) continue;
        s.parsed.groups.forEach((g, i) => { if (String(s.names[i] ?? '').trim()) remembered[nameMemoryKey(s.parsed.sheet, g.label)] = s.names[i].trim(); });
      }
      archive = withYears(archive ?? emptyArchive(), years, remembered);
      try {
        await saveArchive(archive);
      } catch (err) {
        toast(`Couldn’t save the history on this device: ${err?.message ?? err}`, 'error');
        return;
      }
      $('archiveImportDialog').close();
      let note = '';
      if (upload) {
        try { await upload; note = ' and saved to Drive'; } catch (err) { note = ` — not saved to Drive yet (${err?.message ?? err}); use “Import again…” later`; }
      }
      if (isOpen('settingsDialog')) ctx.renderSettings();
      await openViewer({ year: Math.max(...years.map((y) => y.year)) });
      toast(`History imported: ${yearsText(years)}${note}`, note.startsWith(' —') ? 'error' : 'ok');
    })();
  }

  // ---------------------------------------------------------------- viewer

  const view = { year: null, query: '', accountKeys: new Set(), order: 'sheet' };
  const oooInfo = new WeakMap(); // year object → Map(row n → between)

  function betweenFor(year) {
    if (!oooInfo.has(year)) {
      const m = new Map(checkYear(year).outOfOrder.map((x) => [x.n, x.between]));
      oooInfo.set(year, m);
    }
    return oooInfo.get(year);
  }

  async function openViewer(opts = {}) {
    await ensureLoaded();
    if (!hasArchive()) { toast('No history imported yet'); return; }
    const ys = yearsOf(archive);
    if (opts.year && archive.years[opts.year]) view.year = opts.year;
    if (!view.year || !archive.years[view.year]) view.year = ys[ys.length - 1].year;
    // a filter for an account that no longer exists is dropped
    const keys = new Set(archiveAccounts(archive).map((a) => a.key));
    view.accountKeys = new Set([...view.accountKeys].filter((k) => keys.has(k)));
    renderViewer();
    openDialog($('archiveDialog'));
  }

  const searching = () => Boolean(view.query.trim()) || view.accountKeys.size > 0;

  function renderViewer() {
    const dlg = $('archiveDialog');
    const accounts = archiveAccounts(archive);
    const search = h('input', { type: 'search', class: 'arch-search', placeholder: 'Search every year, e.g. car parking', value: view.query, 'aria-label': 'Search history',
      oninput: () => { view.query = search.value; clearTimeout(renderViewer.t); renderViewer.t = setTimeout(drawResults, 150); } });
    const yearSel = h('select', { class: 'arch-year', 'aria-label': 'Year', onchange: () => { view.year = Number(yearSel.value); drawResults(); } },
      yearsOf(archive).map((y) => h('option', { value: String(y.year), selected: y.year === view.year }, String(y.year))));
    const chips = h('div', { class: 'arch-chips', role: 'group', 'aria-label': 'Accounts' },
      accounts.map((a) => h('button', {
        type: 'button', class: 'arch-chip', 'aria-pressed': String(view.accountKeys.has(a.key)), style: { '--acc': a.colour },
        title: `${a.name} · ${a.firstYear === a.lastYear ? a.firstYear : `${a.firstYear}–${a.lastYear}`}`,
        onclick: (e) => {
          if (view.accountKeys.has(a.key)) view.accountKeys.delete(a.key); else view.accountKeys.add(a.key);
          e.currentTarget.setAttribute('aria-pressed', String(view.accountKeys.has(a.key)));
          drawResults();
        },
      }, h('span', { class: 'arch-dot' }), a.name)));
    const order = h('div', { class: 'seg seg-small arch-order' },
      [['sheet', 'Sheet order'], ['date', 'Date order']].map(([v, label]) => h('button', {
        type: 'button', class: 'seg-btn', 'aria-checked': String(view.order === v),
        onclick: () => { view.order = v; for (const b of order.children) b.setAttribute('aria-checked', String(b.textContent === label)); drawResults(); },
      }, label)));
    const results = h('div', { class: 'arch-results' });
    dlg.replaceChildren(h('div', { class: 'sheet-body arch-body' },
      h('header', { class: 'sheet-head' },
        h('h2', {}, 'History'),
        h('span', { class: 'muted small arch-ro' }, 'read only'),
        h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
      h('div', { class: 'arch-tools' }, search, yearSel, order),
      chips,
      h('p', { class: 'muted small arch-summary', id: 'archSummary' }),
      results));
    drawResults();
  }

  function drawResults() {
    const dlg = $('archiveDialog');
    const results = dlg.querySelector('.arch-results');
    const summary = dlg.querySelector('.arch-summary');
    if (!results) return;
    const on = searching();
    dlg.querySelector('.arch-year').hidden = on;
    dlg.querySelector('.arch-order').hidden = !on;
    const wide = ctx.isWide();
    if (!on) {
      const year = archive.years[view.year];
      const items = yearView(year);
      summary.textContent = `${year.year} · sheet “${year.sheet}” · ${plural(year.rows.length, 'row')} · imported ${longDate(year.importedAt.slice(0, 10))}`;
      results.replaceChildren(wide ? yearTable(year.accounts, [{ year: year.year, items, yearObj: year }], { totals: false, balances: true })
        : yearList(year.accounts, [{ year: year.year, items, yearObj: year }], { totals: false, balances: true }));
      return;
    }
    const r = searchArchive(archive, { query: view.query, accountKeys: view.accountKeys, order: view.order });
    const all = archiveAccounts(archive);
    const used = new Set(r.years.flatMap((y) => Object.keys(y.totals)));
    const accounts = all.filter((a) => (view.accountKeys.size ? view.accountKeys.has(a.key) : used.has(a.key)));
    const out = totalOutText(r.totals);
    summary.textContent = r.count
      ? `${plural(r.count, 'match', 'matches')} in ${plural(r.years.length, 'year')}${out ? ` · ${out}` : ''}${view.order === 'date' ? ' · balances hidden in date order' : ''}`
      : 'No matches';
    if (!r.count) { results.replaceChildren(); return; }
    const groups = r.years.map((y) => ({ ...y, yearObj: archive.years[y.year] }));
    const opts = { totals: true, balances: view.order === 'sheet', grand: r.totals, years: r.years.length };
    results.replaceChildren(wide ? yearTable(accounts, groups, opts) : yearList(accounts, groups, opts));
  }

  /** "£186.40 out · £12.00 in" over the shown accounts (a card payment counts on both sides, as in the sheet). */
  function totalOutText(totals) {
    let c = 0;
    let d = 0;
    for (const t of Object.values(totals)) { c += t.credit; d += t.debit; }
    return [d ? `${formatPence(d)} out` : '', c ? `${formatPence(c)} in` : ''].filter(Boolean).join(' · ');
  }

  function oooTitle(x, yearObj) {
    const b = betweenFor(yearObj).get(x.row.n) ?? [null, null];
    return `Dated ${longDate(x.row.d)}, but sits between ${dayMonth(b[0])} and ${dayMonth(b[1])} in the spreadsheet (row ${x.row.n} of sheet “${yearObj.sheet}”)`;
  }

  const isNote = (row) => !Object.values(row.v).some((v) => v[0] !== null || v[1] !== null);

  /** Desktop: the spreadsheet layout — Date, Description, Credit/Debit/Balance per account. */
  function yearTable(accounts, groups, { totals, balances, grand = null, years = 1 }) {
    const head1 = h('tr', {},
      h('th', { class: 'sticky-l c-date', rowspan: '2' }, 'Date'),
      h('th', { class: 'sticky-l2 c-desc', rowspan: '2' }, 'Description'),
      accounts.map((a) => h('th', { colspan: balances ? '3' : '2', class: 'arch-acc-head' },
        h('div', { class: 'acc-bar', style: { background: a.colour } }),
        h('div', { class: 'arch-acc-name' }, a.name))));
    const head2 = h('tr', {}, accounts.map(() => [
      h('th', { class: 'num sub' }, 'Credit'), h('th', { class: `num sub ${balances ? '' : 'bal-col'}` }, 'Debit'),
      balances ? h('th', { class: 'num sub bal-col' }, 'Balance') : null]));
    const body = h('tbody', {});
    const multi = totals && years > 0;
    for (const g of groups) {
      if (multi) body.append(h('tr', { class: 'arch-year-row' }, h('td', { class: 'sticky-l c-date' }, String(g.year)), h('td', { class: 'sticky-l2 c-desc' }, plural(g.items.length, 'match', 'matches')),
        accounts.map(() => [h('td', {}), h('td', { class: balances ? '' : 'bal-col' }), balances ? h('td', { class: 'bal-col' }) : null])));
      for (const x of g.items) {
        const cls = [x.row.bf ? 'row-bf' : '', isNote(x.row) && !x.row.bf ? 'row-note' : '', x.monthStart && !totals ? 'month-start' : '', x.outOfOrder ? 'arch-ooo' : ''].filter(Boolean).join(' ');
        body.append(h('tr', { class: cls },
          h('td', { class: 'sticky-l c-date', title: x.outOfOrder ? oooTitle(x, g.yearObj) : null }, x.outOfOrder ? '⚠ ' : '', shortDate(x.row.d)),
          h('td', { class: 'sticky-l2 c-desc', title: x.row.t }, x.row.t),
          accounts.map((a) => {
            const v = x.row.v[a.key];
            const b = x.bal[a.key];
            return [
              h('td', { class: 'num credit' }, money(v?.[0])),
              h('td', { class: `num ${balances ? '' : 'bal-col'}` }, money(v?.[1])),
              balances ? h('td', { class: `num bal-col ${b && !b.changed ? 'bal-carried' : 'bal-changed'} ${b?.value < 0 ? 'neg' : ''}` }, b ? money(b.value) : '') : null,
            ];
          })));
      }
      if (totals) body.append(totalRow(accounts, `Total ${g.year}`, g.totals, balances));
    }
    if (totals && grand && years > 1) body.append(totalRow(accounts, 'Grand total', grand, balances, 'arch-grand'));
    return h('div', { class: 'grid-wrap arch-wrap' }, h('table', { class: 'grid arch-grid' }, h('thead', {}, head1, head2), body));
  }

  function totalRow(accounts, label, totals, balances, extra = '') {
    return h('tr', { class: `arch-total ${extra}` },
      h('td', { class: 'sticky-l c-date' }),
      h('td', { class: 'sticky-l2 c-desc' }, label),
      accounts.map((a) => {
        const t = totals[a.key];
        return [
          h('td', { class: 'num credit' }, t?.credit ? money(t.credit) : ''),
          h('td', { class: `num ${balances ? '' : 'bal-col'}` }, t?.debit ? money(t.debit) : ''),
          balances ? h('td', { class: 'num bal-col' }) : null,
        ];
      }));
  }

  /** Phone: one card per row; each account with an amount on its own line. */
  function yearList(accounts, groups, { totals, balances, grand = null, years = 1 }) {
    const byKey = new Map(accounts.map((a) => [a.key, a]));
    const ul = h('ul', { class: 'arch-list' });
    let lastMonth = null;
    for (const g of groups) {
      if (totals) ul.append(h('li', { class: 'day arch-list-year' }, `${g.year} · ${plural(g.items.length, 'match', 'matches')}`));
      for (const x of g.items) {
        const m = x.row.d.slice(0, 7);
        if (!totals && !x.outOfOrder && m !== lastMonth) {
          ul.append(h('li', { class: 'day' }, new Date(x.row.d + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })));
          lastMonth = m;
        }
        const lines = [];
        for (const [k, v] of Object.entries(x.row.v)) {
          const a = byKey.get(k);
          if (!a) continue;
          const moved = v[0] !== null || v[1] !== null;
          if (!moved && !x.row.bf) continue;
          const amt = v[0] !== null && v[1] !== null ? `+${money(v[0])} −${money(v[1])}` : v[0] !== null ? `+${money(v[0])}` : v[1] !== null ? `−${money(v[1])}` : '';
          lines.push(h('div', { class: 'arch-line' },
            h('span', { class: 'arch-dot', style: { '--acc': a.colour } }),
            h('span', { class: 'arch-line-name' }, a.name),
            h('span', { class: `arch-line-amt ${v[0] !== null && v[1] === null ? 'credit' : ''}` }, amt),
            balances && x.bal[k]?.value !== null && x.bal[k]?.value !== undefined ? h('span', { class: 'arch-line-bal' }, `bal ${money(x.bal[k].value)}`) : null));
        }
        const dateBtn = x.outOfOrder
          ? h('button', { type: 'button', class: 'arch-ooo-date', onclick: () => toast(oooTitle(x, g.yearObj), 'warn') }, `⚠ ${shortDate(x.row.d)}`)
          : h('span', { class: 'arch-date' }, shortDate(x.row.d));
        ul.append(h('li', { class: `arch-item ${x.row.bf ? 'arch-bf' : ''} ${isNote(x.row) && !x.row.bf ? 'arch-note' : ''} ${x.outOfOrder ? 'arch-ooo' : ''}` },
          h('div', { class: 'arch-item-top' }, dateBtn, h('span', { class: 'arch-desc' }, x.row.t || '(no description)')),
          lines));
      }
      if (totals) ul.append(listTotal(`Total ${g.year}`, g.totals, byKey));
    }
    if (totals && grand && years > 1) ul.append(listTotal('Grand total', grand, byKey, 'arch-grand'));
    return ul;
  }

  function listTotal(label, totals, byKey, extra = '') {
    return h('li', { class: `arch-item arch-total ${extra}` },
      h('div', { class: 'arch-item-top' }, h('strong', {}, label)),
      Object.entries(totals).map(([k, t]) => {
        const a = byKey.get(k);
        if (!a || (!t.credit && !t.debit)) return null;
        return h('div', { class: 'arch-line' },
          h('span', { class: 'arch-dot', style: { '--acc': a.colour } }),
          h('span', { class: 'arch-line-name' }, a.name),
          h('span', { class: 'arch-line-amt' }, [t.credit ? `+${money(t.credit)}` : '', t.debit ? `−${money(t.debit)}` : ''].filter(Boolean).join(' ')));
      }));
  }

  /** "Erase all data on this device" removes the history too (Drive untouched). */
  async function eraseLocal() {
    await removeArchive();
    archive = null;
    loaded = true;
  }

  return { settingsSection, openViewer, openImport, eraseLocal, redraw: () => { if (isOpen('archiveDialog') && hasArchive()) drawResults(); } };
}
