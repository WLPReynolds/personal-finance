/**
 * v0.15.4: ⚙ → Export to Excel… — a date range, the accounts to include and
 * whether to include projected entries; the .xlsx is built on this device
 * (nothing is uploaded) and downloaded or shared. Logic: lib/excel-export.js
 * (rows and layout) and lib/xlsx-write.js (the file).
 */
import { windowFrame } from './archive-ui.js';
import { exportColumns, earliestDate, hasDataIn, buildExport, exportWorkbook, exportFileName } from './lib/excel-export.js';
import { writeWorkbook } from './lib/xlsx-write.js';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * ctx: { h, $, toast, openDialog, today(), maxDate(), getArchive(): Promise<archive|null>,
 *        liveAccounts(): [{ id, name, colour, openingDate, opening, active, lastDate, envelopes }],
 *        liveRows({ to, projected }): export rows (lib/excel-export.js liveExportRows),
 *        canShare(): bool, deliver(file, name, share): Promise<message|null> }
 */
export function createExportUI(ctx) {
  const { h, $, openDialog } = ctx;
  let archive = null;
  let columns = [];
  // remembered while the app is open, so a second export starts where the first left off
  const state = { from: null, to: null, projected: true, off: new Set(), busy: false };

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const longDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  async function open() {
    archive = await ctx.getArchive();
    columns = exportColumns(ctx.liveAccounts(), archive);
    const first = earliestDate(columns) ?? ctx.today();
    if (!state.from || state.from < first) state.from = first;
    if (!state.to || state.to > ctx.maxDate()) state.to = ctx.today();
    render();
    openDialog($('exportDialog'));
  }

  function render() {
    const dlg = $('exportDialog');
    const today = ctx.today();
    const first = earliestDate(columns) ?? today;
    const max = ctx.maxDate();
    const from = h('input', { type: 'date', value: state.from, min: first, max, required: true, 'aria-label': 'From',
      onchange: () => { state.from = from.value; draw(); } });
    const to = h('input', { type: 'date', value: state.to, min: first, max, required: true, 'aria-label': 'To',
      onchange: () => { state.to = to.value; draw(); } });
    const proj = h('input', { type: 'checkbox', checked: state.projected, onchange: () => { state.projected = proj.checked; draw(); } });
    const quick = (label, fn) => h('button', { type: 'button', class: 'btn-secondary btn-small', onclick: () => { fn(); render(); } }, label);
    const chips = h('div', { class: 'arch-chips', role: 'group', 'aria-label': 'Accounts' },
      columns.map((c) => h('button', {
        type: 'button', class: 'arch-chip', 'aria-pressed': String(!state.off.has(c.id)), style: { '--acc': c.colour }, dataset: { col: c.id },
        title: c.start ? `${c.name}: data from ${longDate(c.start)}${c.end < '9999' ? ` to ${longDate(c.end)}` : ''}` : `${c.name}: no data`,
        onclick: (e) => {
          if (state.off.has(c.id)) state.off.delete(c.id); else state.off.add(c.id);
          e.currentTarget.setAttribute('aria-pressed', String(!state.off.has(c.id)));
          draw();
        },
      }, h('span', { class: 'arch-dot' }), c.name, c.live ? null : h('span', { class: 'muted small' }, ' · history'))));
    const share = ctx.canShare();
    dlg.replaceChildren(...windowFrame(h, dlg, 'Export to Excel', null, 'exp-body',
      h('p', { class: 'muted small' }, 'A spreadsheet laid out like Budget.xlsx: a sheet per year, a Credit / Debit / Balance block per account, figures only. Grey where an account has no data. Made on this device — nothing is uploaded.'),
      h('div', { class: 'exp-dates' },
        h('label', { class: 'field' }, h('span', {}, 'From'), from),
        h('label', { class: 'field' }, h('span', {}, 'To'), to)),
      h('div', { class: 'btn-row' },
        quick('From the start', () => { state.from = first; }),
        quick('To today', () => { state.to = today; }),
        quick('+12 months', () => { state.to = max; })),
      h('label', { class: 'check exp-proj' }, proj, ' Include projected entries (recurring items not confirmed yet)'),
      h('div', { class: 'btn-row' },
        h('h4', { class: 'exp-sub' }, 'Accounts'),
        quick('All', () => { for (const c of columns) if (shown(c)) state.off.delete(c.id); }),
        quick('None', () => { for (const c of columns) if (shown(c)) state.off.add(c.id); })),
      chips,
      h('p', { class: 'small exp-summary' }),
      h('div', { class: 'btn-row' },
        share ? h('button', { type: 'button', class: 'btn-primary exp-go', onclick: () => run(true) }, 'Export & share…') : null,
        h('button', { type: 'button', class: `${share ? 'btn-secondary' : 'btn-primary'} exp-go`, onclick: () => run(false) }, 'Download .xlsx'))));
    draw();
  }

  function problem() {
    if (!state.from || !state.to) return 'Choose both dates';
    if (state.from > state.to) return 'The From date is after the To date';
    if (state.to > ctx.maxDate()) return `The To date can be up to ${longDate(ctx.maxDate())}`;
    if (!columns.some(shown)) return 'None of your accounts has any data in these dates';
    if (!chosen().length) return 'Choose at least one account';
    return null;
  }
  /** v0.15.5: only accounts with data in the chosen dates get a pill (all of them while the dates are unfinished). */
  const datesOk = () => Boolean(state.from && state.to && state.from <= state.to);
  const shown = (c) => !datesOk() || hasDataIn(c, state.from, state.to);
  const chosen = () => columns.filter((c) => shown(c) && !state.off.has(c.id)).map((c) => c.id);

  function draw() {
    const dlg = $('exportDialog');
    const summary = dlg.querySelector('.exp-summary');
    if (!summary) return;
    for (const chip of dlg.querySelectorAll('.arch-chip')) chip.hidden = !shown(columns.find((c) => c.id === chip.dataset.col));
    const p = problem();
    const years = p ? 0 : Number(state.to.slice(0, 4)) - Number(state.from.slice(0, 4)) + 1;
    summary.className = `small exp-summary ${p ? 'warn' : ''}`;
    summary.textContent = p ?? `${longDate(state.from)} to ${longDate(state.to)} · ${plural(years, 'sheet')} · ${plural(chosen().length, 'account')}`
      + (state.to > ctx.today() ? (state.projected ? ' · with projected entries' : ' · confirmed entries only') : '');
    dlg.querySelector('.exp-proj').hidden = state.to <= ctx.today();
    for (const b of dlg.querySelectorAll('.exp-go')) b.disabled = Boolean(p) || state.busy;
  }

  async function run(share) {
    if (problem() || state.busy) return;
    state.busy = true;
    draw();
    try {
      const liveRows = ctx.liveRows({ to: state.to, projected: state.projected && state.to > ctx.today() });
      const model = buildExport({ archive, columns, selected: chosen(), liveRows, from: state.from, to: state.to });
      const bytes = await writeWorkbook(exportWorkbook(model));
      const name = exportFileName(state.from, state.to);
      const message = await ctx.deliver(new File([bytes], name, { type: XLSX_TYPE }), name, share);
      if (message) ctx.toast(message);
    } catch (err) {
      console.error(err);
      ctx.toast(`Couldn’t make the spreadsheet: ${err?.message ?? err}`, 'error');
    } finally {
      state.busy = false;
      draw();
    }
  }

  function settingsSection() {
    return h('section', { class: 'settings-section' },
      h('h3', {}, 'Export to Excel'),
      h('p', { class: 'muted small' }, 'Any dates and accounts — imported history included — as an .xlsx laid out like your Budget spreadsheet. Figures only, no formulas.'),
      h('button', { type: 'button', class: 'btn-secondary', onclick: open }, 'Export to Excel…'));
  }

  return { open, settingsSection };
}
