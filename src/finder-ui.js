/**
 * v0.15.0: the Finder window — one search over the imported history and the
 * live accounts (projections to the grid's horizon, joint when it's on).
 * Design: Project doc claude/finder-design.md. Logic in lib/finder.js.
 *
 * Desktop: Date · Description · one column per bank/card (no balances).
 * Phone: a list. Totals per year and a grand total, out and in apart.
 * Click a row: live → the grid/list at that row; history → the History
 * window at that row (on top, so closing it comes back here).
 */
import { windowFrame } from './archive-ui.js';
import { liveFinderRows, archiveFinderRows, findRows, finderColumns } from './lib/finder.js';
import { formatPence } from './lib/money.js';

const MIN_SEARCH = 3;
const HISTORY_SVG = 'M13 3a9 9 0 0 0-9 9H1l3.9 3.9.1.1L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3Zm-1 5v5l4.25 2.52.77-1.28-3.52-2.09V8H12Z';

/**
 * ctx: { h, $, toast, openDialog, isOpen, isWide(),
 *        liveFrom(): the day your records start, as text (e.g. '1 Oct 2026'), or null,
 *        liveGridRows(): grid rows over the view ledger (all accounts incl. joint),
 *        liveColumns(): [{ id, name, colour }] in the app's order,
 *        getArchive(): Promise<archive|null>, links(): { key: accountId },
 *        goLive(row), goHistory(year, n) }
 */
export function createFinderUI(ctx) {
  const { h, $, openDialog } = ctx;
  const state = { query: '', forced: null, columns: new Set() };
  let rows = null; // all finder rows, rebuilt each time the window opens
  let columns = [];

  const shortDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
  const money = (p) => formatPence(p, { symbol: false });
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const activeQuery = () => {
    const q = state.query.trim();
    return q.length >= MIN_SEARCH || (q && state.forced === q) ? q : '';
  };

  function historyIcon(title) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '13');
    svg.setAttribute('height', '13');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('fill', 'currentColor');
    p.setAttribute('d', HISTORY_SVG);
    svg.append(p);
    return h('span', { class: 'fd-hist', title, 'aria-label': 'From your imported history' }, svg);
  }

  async function open() {
    const archive = await ctx.getArchive();
    const links = ctx.links();
    rows = [...archiveFinderRows(archive, links), ...liveFinderRows(ctx.liveGridRows())];
    columns = finderColumns(ctx.liveColumns(), archive, links);
    const ids = new Set(columns.map((c) => c.id));
    state.columns = new Set([...state.columns].filter((c) => ids.has(c)));
    render();
    openDialog($('finderDialog'));
    requestAnimationFrame(() => $('finderDialog').querySelector('.fd-search')?.focus());
  }

  function render() {
    const dlg = $('finderDialog');
    const search = h('input', { type: 'search', class: 'arch-search fd-search', placeholder: 'Find in everything, e.g. car parking', value: state.query, 'aria-label': 'Find',
      oninput: () => {
        state.query = search.value;
        clear.hidden = !search.value;
        clearTimeout(render.t);
        render.t = setTimeout(draw, 150);
      },
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        state.forced = search.value.trim();
        clearTimeout(render.t);
        draw();
      } });
    const clear = h('button', { type: 'button', class: 'arch-clear', 'aria-label': 'Clear search', title: 'Clear search', hidden: !state.query,
      onclick: () => { state.query = ''; state.forced = null; search.value = ''; clear.hidden = true; draw(); search.focus(); } }, '✕');
    const chips = h('div', { class: 'arch-chips', role: 'group', 'aria-label': 'Accounts' },
      columns.map((c) => h('button', {
        type: 'button', class: 'arch-chip', 'aria-pressed': String(state.columns.has(c.id)), style: { '--acc': c.colour }, dataset: { col: c.id },
        title: c.history ? `${c.name} (history only — not linked to one of your accounts)` : c.name,
        onclick: (e) => {
          if (state.columns.has(c.id)) state.columns.delete(c.id); else state.columns.add(c.id);
          e.currentTarget.setAttribute('aria-pressed', String(state.columns.has(c.id)));
          draw();
        },
      }, h('span', { class: 'arch-dot' }), c.name, c.history ? historyIcon('History only') : null)));
    dlg.replaceChildren(...windowFrame(h, dlg, 'Find', null, 'arch-body fd-body',
      h('div', { class: 'arch-tools' }, h('div', { class: 'arch-searchbox' }, search, clear)),
      chips,
      h('p', { class: 'muted small arch-summary fd-summary' }),
      h('div', { class: 'arch-results fd-results' })));
    draw();
  }

  function draw() {
    const dlg = $('finderDialog');
    const results = dlg.querySelector('.fd-results');
    const summary = dlg.querySelector('.fd-summary');
    if (!results) return;
    const q = activeQuery();
    showChips(q);
    if (!q && !state.columns.size) {
      const typed = state.query.trim();
      summary.textContent = typed
        ? `Keep typing — the search starts at ${MIN_SEARCH} letters (or press Enter to search for “${typed}”)`
        : `Searches your imported history, your accounts${ctx.liveFrom?.() ? ` from ${ctx.liveFrom()}` : ''}, and what’s due in the months shown on the grid.`;
      results.replaceChildren();
      return;
    }
    const r = findRows(rows, { query: q, columns: state.columns });
    const used = new Set(r.years.flatMap((y) => Object.keys(y.totals)));
    const cols = columns.filter((c) => (state.columns.size ? state.columns.has(c.id) : used.has(c.id)));
    let out = 0;
    let inn = 0;
    for (const t of Object.values(r.totals)) { out += t.out; inn += t.in; }
    const internal = r.years.reduce((n, y) => n + y.rows.filter((x) => x.internal).length, 0);
    summary.textContent = r.count
      ? [`${plural(r.count, 'match', 'matches')} in ${plural(r.years.length, 'year')}`, out ? `${formatPence(out)} out` : '', inn ? `${formatPence(inn)} in` : '',
        internal ? `${plural(internal, 'internal move')} not counted` : ''].filter(Boolean).join(' · ')
      : 'No matches';
    if (!r.count) { results.replaceChildren(); return; }
    results.replaceChildren(ctx.isWide() ? table(cols, r) : list(cols, r));
  }

  /**
   * v0.15.2 (Wayne, 17 Oct): with a search typed, only the account pills that
   * have a match are shown (plus any already picked) — years of old accounts
   * made the row of pills cluttered. With no search, every pill shows.
   */
  function showChips(q) {
    const dlg = $('finderDialog');
    const hit = q ? new Set(Object.keys(findRows(rows, { query: q }).totals)) : null;
    for (const chip of dlg.querySelectorAll('.arch-chip')) {
      const id = chip.dataset.col;
      chip.hidden = Boolean(hit) && !hit.has(id) && !state.columns.has(id);
    }
  }

  const rowTitle = (x) => (x.source === 'archive'
    ? `From your imported history — sheet “${x.ref.sheet}”, row ${x.ref.n}. Click to see it there.`
    : `${x.projected ? 'Projected — ' : ''}click to see it in your accounts`);

  function go(x) {
    if (x.source === 'archive') ctx.goHistory(x.ref.year, x.ref.n);
    else {
      $('finderDialog').close();
      ctx.goLive(x);
    }
  }

  function cellText(entries) {
    const ins = entries.filter((e) => e.dir === 'in');
    const outs = entries.filter((e) => e.dir === 'out');
    return [
      ...ins.map((e) => h('span', { class: `fd-amt credit ${e.internal ? 'fd-int' : ''}` }, `+${money(e.amount)}`)),
      ...outs.map((e) => h('span', { class: `fd-amt ${e.internal ? 'fd-int' : ''}` }, `−${money(e.amount)}`)),
    ];
  }

  function tags(x) {
    return [
      x.projected ? h('span', { class: 'fd-tag' }, '↻ projected') : null,
      x.internal ? h('span', { class: 'fd-tag fd-tag-int', title: 'A same-day move between two history columns linked to the same account — not counted in the totals' }, 'internal move') : null,
    ];
  }

  function table(cols, r) {
    const head = h('tr', {},
      h('th', { class: 'sticky-l c-date' }, 'Date'),
      h('th', { class: 'sticky-l2 c-desc' }, 'Description'),
      cols.map((c) => h('th', { class: 'num fd-col' },
        h('div', { class: 'acc-bar', style: { background: c.colour } }),
        h('div', { class: 'fd-col-name' }, c.history ? historyIcon('History only — not linked to one of your accounts') : null, c.name))));
    const body = h('tbody', {});
    const multi = r.years.length > 1;
    for (const y of r.years) {
      body.append(h('tr', { class: 'arch-year-row' }, h('td', { class: 'sticky-l c-date' }, String(y.year)),
        h('td', { class: 'sticky-l2 c-desc' }, plural(y.rows.length, 'match', 'matches')), cols.map(() => h('td', {}))));
      for (const x of y.rows) {
        body.append(h('tr', { class: `fd-row ${x.projected ? 'projected' : ''} ${x.source === 'archive' ? 'fd-archive' : ''}`, title: rowTitle(x), onclick: () => go(x) },
          h('td', { class: 'sticky-l c-date' }, x.source === 'archive' ? historyIcon(rowTitle(x)) : null, shortDate(x.date)),
          h('td', { class: 'sticky-l2 c-desc' }, x.text || '(no description)', tags(x)),
          cols.map((c) => h('td', { class: 'num' }, x.cells[c.id] ? cellText(x.cells[c.id]) : ''))));
      }
      body.append(totalRow(cols, `Total ${y.year}`, y.totals));
    }
    if (multi) body.append(totalRow(cols, 'Grand total', r.totals, 'arch-grand'));
    return h('div', { class: 'grid-wrap arch-wrap' }, h('table', { class: 'grid arch-grid fd-grid' }, h('thead', {}, head), body));
  }

  function totalLines(t) {
    if (!t || (!t.in && !t.out)) return '';
    return [t.out ? h('span', { class: 'fd-amt' }, `−${money(t.out)}`) : null, t.in ? h('span', { class: 'fd-amt credit' }, `+${money(t.in)}`) : null];
  }
  function totalRow(cols, label, totals, extra = '') {
    return h('tr', { class: `arch-total ${extra}` },
      h('td', { class: 'sticky-l c-date' }),
      h('td', { class: 'sticky-l2 c-desc' }, label),
      cols.map((c) => h('td', { class: 'num' }, totalLines(totals[c.id]))));
  }

  function list(cols, r) {
    const byId = new Map(columns.map((c) => [c.id, c]));
    const ul = h('ul', { class: 'arch-list' });
    for (const y of r.years) {
      ul.append(h('li', { class: 'day arch-list-year' }, `${y.year} · ${plural(y.rows.length, 'match', 'matches')}`));
      for (const x of y.rows) {
        const lines = Object.entries(x.cells).filter(([id]) => !state.columns.size || state.columns.has(id)).map(([id, entries]) => {
          const c = byId.get(id);
          return h('div', { class: 'arch-line' },
            h('span', { class: 'arch-dot', style: { '--acc': c?.colour ?? '#999' } }),
            h('span', { class: 'arch-line-name' }, c?.name ?? '?'),
            h('span', { class: 'arch-line-amt' }, cellText(entries)));
        });
        ul.append(h('li', {},
          h('button', { type: 'button', class: `arch-item fd-item ${x.projected ? 'fd-projected' : ''}`, onclick: () => go(x), 'aria-label': `${x.text} — ${rowTitle(x)}` },
            h('div', { class: 'arch-item-top' },
              x.source === 'archive' ? historyIcon(rowTitle(x)) : null,
              h('span', { class: 'arch-date' }, shortDate(x.date)),
              h('span', { class: 'arch-desc' }, x.text || '(no description)')),
            tags(x).some(Boolean) ? h('div', { class: 'fd-tags' }, tags(x)) : null,
            lines)));
      }
      ul.append(listTotal(`Total ${y.year}`, y.totals, byId, cols));
    }
    if (r.years.length > 1) ul.append(listTotal('Grand total', r.totals, byId, cols, 'arch-grand'));
    return ul;
  }

  function listTotal(label, totals, byId, cols, extra = '') {
    return h('li', { class: `arch-item arch-total ${extra}` },
      h('div', { class: 'arch-item-top' }, h('strong', {}, label)),
      cols.map((c) => {
        const t = totals[c.id];
        if (!t || (!t.in && !t.out)) return null;
        return h('div', { class: 'arch-line' },
          h('span', { class: 'arch-dot', style: { '--acc': c.colour } }),
          h('span', { class: 'arch-line-name' }, c.name),
          h('span', { class: 'arch-line-amt' }, totalLines(t)));
      }));
  }

  return { open, redraw: () => { if (ctx.isOpen('finderDialog') && rows) draw(); } };
}
