/**
 * Finance Tracker — local-only test build UI.
 * Mobile: tabbed single-account feed + FAB/bottom sheet.
 * Desktop: spreadsheet-style grid (Date/Description frozen, Credit/Debit/Balance per account).
 * Data: IndexedDB on this device; export/import a JSON file to move it between devices.
 */
import { loadLedger, saveLedger, loadMeta, saveMeta, loadSyncState, saveSyncState, loadBankHolidays, saveBankHolidays, requestPersistence } from './store.js';
import { googleAuth } from './google-auth.js';
import { googleDrive } from './drive.js';
import { createSyncEngine } from './lib/sync-engine.js';
import {
  emptyLedger, addAccount, updateAccount, deleteAccount, moveAccount,
  addTransaction, updateTransaction, deleteTransaction,
  accountRunning, balanceAsOf, counterpartOf,
} from './lib/ops.js';
import { buildGridRows } from './lib/grid.js';
import { parseAmount, formatPence, penceToInput } from './lib/money.js';
import { INSTITUTIONS, institutionStyle } from './lib/institutions.js';
import { buildExport, exportFileName, parseImport } from './lib/transfer-file.js';
import {
  BUILT_IN_BANK_HOLIDAYS, BANK_HOLIDAYS_URL, parseGovUkBankHolidays, combineHolidayLists, lastKnownYear,
} from './lib/workdays.js';
import {
  MAX_HORIZON_MONTHS, horizonEnd, withProjections, recurringItems,
  addRecurring, updateRecurring, deleteRecurring, setOccurrence, confirmOccurrence,
  upcomingDates, describeRule,
} from './lib/schedule.js';

export const APP_VERSION = '0.5.0';

const state = {
  ledger: null,
  meta: {},
  activeAccountId: null,
  viewMode: readPref('viewMode', 'auto'), // 'auto' | 'list' | 'grid'
  gridScroll: null,
  installPrompt: null,
  // Recurring items: how far ahead projected entries are shown. Every
  // device starts at 3 months each time the app opens; "show more" adds 3.
  horizonMonths: 3,
  holidays: new Set(BUILT_IN_BANK_HOLIDAYS),
  holidayInfo: { source: 'built-in', fetchedAt: null, lastYear: lastKnownYear(BUILT_IN_BANK_HOLIDAYS) },
};

const $ = (id) => document.getElementById(id);
const app = $('app');
const desktopQuery = matchMedia('(min-width: 900px)');

// ------------------------------------------------------------------ helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val); // custom properties need setProperty
        else el.style[prop] = val;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function readPref(key, fallback) {
  try { return localStorage.getItem(`ft.${key}`) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(`ft.${key}`, value); } catch { /* ignore */ }
}

function todayIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function firstOfMonthIso() {
  return todayIso().slice(0, 8) + '01';
}
function longDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function shortDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function endOfMonthIso(dateIso) {
  const [y, m] = dateIso.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this one
  return d.toISOString().slice(0, 10);
}
function monthYearLabel(dateIso) {
  return new Date(dateIso + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}
function when(isoDateTime) {
  if (!isoDateTime) return 'never';
  return new Date(isoDateTime).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function deviceLabel() {
  return /Android/i.test(navigator.userAgent) ? 'Android phone' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iPhone' : 'Desktop browser';
}

// A <dialog> shown with showModal() is promoted into the browser's "top
// layer", which always paints above ordinary DOM content — a position:fixed
// toast living in <body> can never appear over it, z-index notwithstanding.
// So the toast has to be reparented into whichever dialog is currently on
// top; this stack tracks that (native <dialog> has no "which is topmost"
// query, so we track show/close ourselves).
const dialogStack = [];
function openDialog(dlg) {
  const i = dialogStack.indexOf(dlg);
  if (i !== -1) dialogStack.splice(i, 1); // re-showing the same dialog shouldn't duplicate it
  dialogStack.push(dlg);
  dlg.showModal();
}
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('close', () => {
    const i = dialogStack.indexOf(d);
    if (i !== -1) dialogStack.splice(i, 1);
  });
}

// Cached once, as a stable JS reference — not re-looked-up by id, because a
// dialog redraw (replaceChildren) detaches whatever was reparented into it
// from the document entirely, and a later getElementById('toast') would
// then come back null.
const toastEl = $('toast');

function toast(message, kind = 'ok') {
  const t = toastEl;
  const container = dialogStack[dialogStack.length - 1] ?? document.body;
  container.append(t); // moves the existing node (even a detached one); harmless if it's already there
  t.textContent = message;
  t.className = `toast toast-${kind}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), kind === 'error' ? 5000 : 2200);
}

function accountById(id) {
  return state.ledger.accounts.find((a) => a.id === id);
}
function visibleAccounts() {
  return state.ledger.accounts.filter((a) => a.active);
}
function isGrid() {
  if (state.viewMode === 'grid') return true;
  if (state.viewMode === 'list') return false;
  return desktopQuery.matches;
}
function swatch(account, extra = '') {
  const s = institutionStyle(account.institution);
  return h('span', { class: `swatch ${extra}`, style: { background: s.colour } },
    s.accent ? h('span', { class: 'swatch-accent', style: { background: s.accent } }) : null);
}
function directionWords(account) {
  return account.type === 'credit'
    ? { debit: 'Spend', credit: 'Payment / refund' }
    : { debit: 'Money out', credit: 'Money in' };
}
function hasUnexported() {
  if (!state.ledger) return false;
  const marker = [state.meta.lastExportAt, state.meta.lastImportAt].filter(Boolean).sort().pop();
  return state.ledger.transactions.length > 0 && (!marker || state.ledger.lastModified > marker);
}

// ------------------------------------------------------------------ recurring items: projections & bank holidays

function projectionEnd() {
  return horizonEnd(todayIso(), state.horizonMonths);
}
/** The ledger plus projected entries from recurring items — for display only, never saved. */
function viewLedger() {
  return withProjections(state.ledger, projectionEnd(), state.holidays);
}
function hasRecurring() {
  return recurringItems(state.ledger).length > 0;
}
function showMore() {
  state.horizonMonths = Math.min(MAX_HORIZON_MONTHS, state.horizonMonths + 3);
  render();
}
/** "Projected to 31 Jan 2027 · Show 3 more months" — or null when there's nothing recurring. */
function horizonControl(cls) {
  if (!hasRecurring()) return null;
  const canMore = state.horizonMonths < MAX_HORIZON_MONTHS;
  return h('div', { class: `horizon ${cls}` },
    h('span', { class: 'muted small' }, `↻ Recurring entries shown to ${longDate(projectionEnd())}`),
    canMore ? h('button', { type: 'button', class: 'btn-secondary btn-small', onclick: showMore }, 'Show 3 more months') : h('span', { class: 'muted small' }, '(12 months — the most)'));
}

const HOLIDAY_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
function applyHolidays(dates, fetchedAt) {
  const list = combineHolidayLists(dates);
  const changed = list.length !== state.holidays.size || list.some((d) => !state.holidays.has(d));
  state.holidays = new Set(list);
  state.holidayInfo = { source: 'gov.uk', fetchedAt, lastYear: lastKnownYear(list) };
  return changed;
}
/** Use the saved gov.uk list; refresh it weekly. Any failure keeps what we have (built-in list at worst). */
async function loadHolidays() {
  try {
    const saved = await loadBankHolidays();
    if (saved?.dates?.length && applyHolidays(saved.dates, saved.fetchedAt) && state.ledger) render();
    if (saved?.fetchedAt && Date.now() - Date.parse(saved.fetchedAt) < HOLIDAY_REFRESH_MS) return;
    if (navigator.onLine === false) return;
    const res = await fetch(BANK_HOLIDAYS_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const dates = parseGovUkBankHolidays(await res.json());
    const fetchedAt = new Date().toISOString();
    await saveBankHolidays({ dates, fetchedAt });
    const changed = applyHolidays(dates, fetchedAt);
    if (changed && state.ledger) render();
    if ($('recurringDialog').open) renderRecurringManager();
  } catch {
    /* offline or gov.uk unreachable — keep the list we have */
  }
}
/** Class + short label for a projected entry: skipped / due (amber) / projected. */
function projectionTags(p, today) {
  if (p.skipped) return { cls: 'skipped', label: 'skipped' };
  if (p.date <= today) return { cls: 'overdue', label: p.date === today ? 'due today · tap to confirm' : 'not confirmed yet' };
  return { cls: '', label: p.changed ? 'projected · changed for this month' : 'projected' };
}

function holidayStatusText() {
  const i = state.holidayInfo;
  return i.source === 'gov.uk'
    ? `Bank holidays: gov.uk list (England & Wales), checked ${when(i.fetchedAt)}, known to the end of ${i.lastYear}.`
    : `Bank holidays: built-in list to the end of ${i.lastYear} — couldn’t reach gov.uk yet.`;
}

// ------------------------------------------------------------------ Drive sync

// Test builds can inject a fake Google/Drive (see the browser tests); the
// real app always uses Google's.
const testHooks = window.__FT_TEST__ ?? null;
const auth = testHooks?.auth ?? googleAuth;
const sync = createSyncEngine({
  auth,
  drive: testHooks?.drive ?? googleDrive,
  store: {
    getLocal: () => state.ledger,
    setLocal(ledger) {
      // a sync brought in changes from the other device
      state.ledger = ledger;
      saveLedger(ledger).catch((err) => toast(`Couldn't save synced data: ${err.message}`, 'error'));
      render();
    },
    loadSyncState,
    saveSyncState,
  },
});

let syncTimer = null;
/** Sync shortly after an edit, if signed in (never opens Google's window). */
function scheduleSync(delay = 4000) {
  if (!sync.isEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => sync.sync().then(afterSync), delay);
}

/** Tap-driven sync: the only path that may open Google's sign-in window. */
function syncFromTap() {
  const st = sync.getState();
  if (st.status === 'conflicts') { openConflictDialog(); return; }
  sync.sync({ interactive: true }).then((r) => afterSync(r, true));
}

function afterSync(result, fromTap = false) {
  if (!result) return;
  if (result.status === 'conflicts') { if (fromTap || !document.querySelector('dialog[open]')) openConflictDialog(); return; }
  if (!fromTap) return;
  if (result.status === 'needs-tap') toast(auth.lastAuthError?.() ?? "Google sign-in didn't complete", 'error');
  else if (result.status === 'error') toast(sync.getState().lastError ?? 'Sync failed', 'error');
  else if (result.status === 'pushed' || result.status === 'merged' || result.status === 'unchanged') toast('Synced with Google Drive');
}

function syncTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** Label + style for the top-bar chip, from the engine's state. */
function syncChipModel(st) {
  if (!st.enabled) return null;
  switch (st.status) {
    case 'syncing': return { label: 'Syncing…', kind: 'busy' };
    case 'conflicts': return { label: 'Check clash', kind: 'warn' };
    case 'error': return { label: 'Sync failed', kind: 'warn' };
    default:
      if (!st.hasToken || st.status === 'needs-tap') return { label: 'Tap to sync', kind: st.dirty ? 'attention' : 'idle', dot: st.dirty };
      return { label: st.dirty ? 'Syncing soon' : `Synced ${syncTime(st.lastSyncAt)}`, kind: 'ok' };
  }
}

function renderSyncChip() {
  const chip = $('syncChip');
  const model = syncChipModel(sync.getState());
  $('unexportedDot').hidden = sync.isEnabled() || !hasUnexported();
  chip.hidden = !model;
  if (!model) return;
  chip.className = `sync-chip sync-${model.kind}`;
  // static icon markup (no user data), so innerHTML is safe here
  chip.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96Z"/></svg>';
  chip.append(h('span', { class: 'sync-label' }, model.label));
  if (model.dot) chip.append(h('span', { class: 'sync-dot', 'aria-hidden': 'true' }));
  chip.setAttribute('aria-label', `Google Drive sync: ${model.label}`);
  const line = $('driveStatusLine');
  if (line) line.textContent = driveStatusText();
}

function driveStatusText() {
  const st = sync.getState();
  if (!st.enabled) return '';
  const parts = [st.lastSyncAt ? `Last synced ${when(st.lastSyncAt)}` : 'Not synced yet'];
  if (st.status === 'error' && st.lastError) parts.push(st.lastError);
  else if (st.dirty) parts.push('changes on this device waiting to sync');
  if (!st.hasToken) parts.push('sign-in expired — tap the sync button to continue');
  return parts.join(' · ');
}

// ---- clash dialog

function describeRecord(group, side) {
  const records = group.conflicts.map((c) => c[side]);
  if (records.every((r) => r === null)) return 'Deleted';
  const r = records.find((x) => x?.direction === 'debit') ?? records.find(Boolean);
  if (group.entityType === 'account') {
    return `${r.name} · ${r.type === 'credit' ? 'owed' : 'opening'} ${formatPence(r.openingBalance)} from ${shortDate(r.openingDate)}${r.active ? '' : ' (hidden)'}`;
  }
  if (group.entityType === 'transaction') {
    const name = (id) => accountById(id)?.name ?? 'account';
    const where = r.transferId
      ? `${name(records.find((x) => x?.direction === 'debit')?.accountId ?? r.accountId)} → ${name(records.find((x) => x?.direction === 'credit')?.accountId ?? r.accountId)}`
      : name(r.accountId);
    const money = r.kind === 'note' ? 'note' : `${r.direction === 'credit' ? '+' : '−'}${formatPence(r.amount)}`;
    return `${shortDate(r.date)} · ${r.description || '(no description)'} · ${money} · ${where}`;
  }
  if (r.recordType === 'recurring') return `${r.description} · ${signedAmount(r.kind, r.amount)} · ${describeRule(r)}`;
  if (r.recordType === 'occurrence') {
    const item = recurringItems(state.ledger).find((i) => i.id === r.itemId);
    const what = r.skipped ? 'skipped' : [r.date && shortDate(r.date), r.amount !== null && formatPence(r.amount), r.description].filter(Boolean).join(' · ') || 'as the series';
    return `${item?.description ?? 'Recurring item'}, ${periodLabel(r.period)}: ${what}`;
  }
  return r.name ?? 'Recurring item';
}

function openConflictDialog() {
  const st = sync.getState();
  const groups = st.conflicts;
  if (!groups?.length) return;
  const dlg = $('conflictDialog');
  const choices = {};
  const cards = groups.map((g, i) => {
    choices[g.key] = 'local';
    const option = (side, label) => h('label', { class: 'clash-option' },
      h('input', { type: 'radio', name: `clash-${i}`, value: side, checked: side === 'local', onchange: () => { choices[g.key] = side; } }),
      h('span', {}, h('strong', {}, label), h('span', { class: 'clash-detail' }, describeRecord(g, side))));
    return h('fieldset', { class: 'clash' },
      h('legend', {}, g.entityType === 'account' ? 'Account' : g.entityType === 'scheduledItem' ? 'Recurring item' : g.conflicts.length > 1 ? 'Linked entry' : 'Entry'),
      option('local', 'This device'),
      option('remote', 'The other device (Drive)'));
  });
  dlg.replaceChildren(h('div', { class: 'sheet-body' },
    h('header', { class: 'sheet-head' },
      h('h2', {}, groups.length === 1 ? 'One change clashes' : `${groups.length} changes clash`),
      h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('p', { class: 'muted small' }, 'These were changed differently on this device and on another device since they last synced. Everything else has already been combined. Choose which version to keep:'),
    cards,
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn-secondary', onclick: () => dlg.close() }, 'Decide later'),
      h('button', {
        type: 'button', class: 'btn-primary',
        onclick: async () => {
          dlg.close();
          const r = await sync.resolveConflicts(choices);
          toast(r?.status === 'needs-tap' ? 'Saved here — tap the sync button to send to Drive' : 'Clash resolved');
        },
      }, 'Keep these'))));
  openDialog(dlg);
}

// ------------------------------------------------------------------ commit

async function commit(nextLedger, message) {
  const previous = state.ledger;
  state.ledger = nextLedger;
  try {
    await saveLedger(nextLedger);
    render();
    if (message) toast(message);
    renderSyncChip();
    scheduleSync();
  } catch (err) {
    state.ledger = previous;
    render();
    toast(`Couldn't save: ${err.message}`, 'error');
  }
}

function attempt(fn) {
  try {
    return fn();
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

// ------------------------------------------------------------------ render

function render() {
  const accounts = visibleAccounts();
  if (!state.activeAccountId || !accounts.some((a) => a.id === state.activeAccountId)) {
    state.activeAccountId = accounts[0]?.id ?? null;
  }
  // With Drive sync on, the sync chip shows unsynced changes instead
  $('unexportedDot').hidden = sync.isEnabled() || !hasUnexported();
  $('installBtn').hidden = !state.installPrompt;

  if (!state.ledger.accounts.length) {
    $('fab').hidden = true;
    $('viewBtn').hidden = true;
    renderSetup();
    return;
  }
  $('viewBtn').hidden = false;
  $('viewBtn').textContent = isGrid() ? 'List' : 'Grid';
  document.body.classList.toggle('mode-grid', isGrid());

  if (!accounts.length) {
    $('fab').hidden = true;
    app.replaceChildren(h('div', { class: 'empty' }, 'All accounts are hidden. Open settings to show one.'));
    return;
  }
  if (isGrid()) {
    $('fab').hidden = true;
    renderGrid(accounts);
  } else {
    $('fab').hidden = false;
    renderList(accounts);
  }
}

// ---- setup (first run)

function renderSetup() {
  const date = h('input', { type: 'date', value: firstOfMonthIso(), required: true });
  const rows = [
    { name: 'Current Account', type: 'current', institution: 'other', label: 'Balance' },
    { name: 'Nationwide', type: 'credit', institution: 'nationwide', label: 'Amount owed' },
    { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', label: 'Amount owed' },
  ].map((r) => ({ ...r, input: h('input', { type: 'text', inputmode: 'decimal', placeholder: '0.00', class: 'amount-input' }) }));

  const form = h('form', {
    class: 'card setup-form',
    onsubmit: (e) => {
      e.preventDefault();
      let ledger = emptyLedger();
      for (const r of rows) {
        const pence = r.input.value.trim() === '' ? 0 : parseAmount(r.input.value);
        if (pence === null) return toast(`Check the amount for ${r.name}`, 'error');
        ledger = addAccount(ledger, { name: r.name, type: r.type, institution: r.institution, openingBalance: pence, openingDate: date.value }).ledger;
      }
      commit(ledger, 'Accounts created');
    },
  },
  h('h2', {}, 'Quick start'),
  h('p', { class: 'muted' }, 'The three columns from your Budget sheet. Enter the balances as they stood at the start of the opening date, then backfill entries from there. Names, colours and types can be changed later in settings.'),
  h('label', { class: 'field' }, h('span', {}, 'Opening date (“brought forward”)'), date),
  ...rows.map((r) => h('label', { class: 'field field-row' }, h('span', {}, `${r.name} — ${r.label}`), r.input)),
  h('button', { type: 'submit', class: 'btn-primary' }, 'Create accounts'));

  app.replaceChildren(
    h('div', { class: 'setup' },
      form,
      h('div', { class: 'card' },
        h('h2', {}, 'Already set up on another device?'),
        h('p', { class: 'muted' }, 'Import the export file you made there.'),
        h('button', { type: 'button', class: 'btn-secondary', onclick: () => $('importInput').click() }, 'Import export file…')),
      h('p', { class: 'muted small center' }, h('button', { type: 'button', class: 'btn-link', onclick: () => openAccountDialog(null) }, 'Or set up accounts one at a time'))));
}

// ---- mobile list

function renderList(accounts) {
  const active = accountById(state.activeAccountId);
  const style = institutionStyle(active.institution);

  const tabs = h('nav', { class: 'tabs', role: 'tablist' },
    accounts.map((a) => h('button', {
      type: 'button', role: 'tab', class: `tab ${a.id === active.id ? 'tab-active' : ''}`,
      'aria-selected': String(a.id === active.id),
      style: { '--acc': institutionStyle(a.institution).colour },
      onclick: () => { state.activeAccountId = a.id; render(); },
    }, swatch(a), h('span', { class: 'tab-name' }, a.name))));

  // Same split as the grid header: today's balance, plus where it will be at
  // the end of the current calendar month (the phone feed runs newest-first,
  // so there's no single "top row" month to track like the grid has).
  // Today's figure counts confirmed entries only; end of month also counts
  // projected recurring entries (including any overdue, unconfirmed ones).
  const todayIsoStr = todayIso();
  const view = viewLedger();
  const bal = balanceAsOf(state.ledger, active, todayIsoStr);
  const eomIso = endOfMonthIso(todayIsoStr);
  const eomBal = balanceAsOf(view, active, eomIso);
  const banner = h('section', { class: 'banner', style: { '--acc': style.colour } },
    style.accent ? h('div', { class: 'banner-accent', style: { background: style.accent } }) : null,
    h('div', { class: 'banner-label' }, active.type === 'credit' ? 'Owed today' : 'Balance today'),
    h('div', { class: `banner-amount ${bal < 0 ? 'neg' : ''}` }, formatPence(bal)),
    h('div', { class: 'banner-eom' }, `${active.type === 'credit' ? 'Owed ' : ''}${formatPence(eomBal)} at end of ${monthYearLabel(eomIso)}`),
    h('button', { type: 'button', class: 'banner-edit', onclick: () => openAccountDialog(active.id) }, 'Account…'));

  const running = accountRunning(view, active).reverse(); // newest first
  const today = todayIso();
  const feed = h('ul', { class: 'feed' });
  const more = horizonControl('horizon-list');
  if (more) feed.append(h('li', {}, more));
  let lastDate = null;
  for (const { transaction: t, runningBalance } of running) {
    if (t.date !== lastDate) {
      lastDate = t.date;
      feed.append(h('li', { class: `day ${t.date > today ? 'future' : ''}` }, longDate(t.date), t.date > today ? ' · upcoming' : ''));
    }
    const other = counterpartOf(view, t);
    const otherAcc = other ? accountById(other.accountId) : null;
    const p = t.isProjected ? t.projection : null;
    const tags = p ? projectionTags(p, today) : null;
    feed.append(h('li', {},
      h('button', {
        type: 'button',
        class: `entry ${t.kind === 'note' ? 'entry-note' : ''} ${t.date > today ? 'future' : ''} ${p ? 'projected' : ''} ${tags?.cls ?? ''}`,
        onclick: () => (p ? openOccurrenceDialog(p.itemId, p.period) : openTxDialog({ txId: t.id })),
      },
        h('span', { class: 'entry-main' },
          h('span', { class: 'entry-desc' }, p ? h('span', { class: 'rec-icon', 'aria-label': 'Recurring' }, '↻ ') : null, t.description || '(no description)'),
          otherAcc || tags ? h('span', { class: 'entry-link' },
            otherAcc ? `${t.direction === 'debit' ? '→' : '←'} ${otherAcc.name}` : '',
            otherAcc && tags ? ' · ' : '',
            tags ? h('span', { class: 'rec-tag' }, tags.label) : null) : null),
        t.kind === 'note'
          ? h('span', { class: 'entry-amt muted' }, 'note')
          : h('span', { class: 'entry-amts' },
              h('span', { class: `entry-amt ${t.direction}` }, `${t.direction === 'credit' ? '+' : '−'}${formatPence(t.amount)}`),
              h('span', { class: `entry-bal ${runningBalance < 0 ? 'neg' : ''}` }, p?.skipped ? 'skipped' : formatPence(runningBalance))))));
  }
  feed.append(lastDate === active.openingDate ? '' : h('li', { class: 'day' }, longDate(active.openingDate)),
    h('li', {},h('div', { class: 'entry entry-note' },
      h('span', { class: 'entry-main' }, h('span', { class: 'entry-desc' }, 'Brought forward')),
      h('span', { class: 'entry-amts' }, h('span', { class: 'entry-bal' }, formatPence(active.openingBalance))))));

  const wrap = h('div', { class: 'list-view' }, tabs, banner, feed);
  addSwipe(wrap, accounts);
  app.replaceChildren(wrap);
  tabs.querySelector('.tab-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function addSwipe(el, accounts) {
  let x0 = null, y0 = null;
  el.addEventListener('touchstart', (e) => {
    if (e.target.closest('.tabs')) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 70 || Math.abs(dy) > 50) return;
    const i = accounts.findIndex((a) => a.id === state.activeAccountId);
    const j = i + (dx < 0 ? 1 : -1);
    if (j >= 0 && j < accounts.length) { state.activeAccountId = accounts[j].id; render(); }
  });
}

// ---- desktop grid

function renderGrid(accounts) {
  const prevWrap = app.querySelector('.grid-wrap');
  const keepScroll = prevWrap ? { top: prevWrap.scrollTop, left: prevWrap.scrollLeft } : null;

  const view = viewLedger();
  const rows = buildGridRows(view, accounts);
  const today = todayIso();

  const head1 = h('tr', {},
    h('th', { class: 'sticky-l c-date', rowspan: '2' }, 'Date'),
    h('th', { class: 'sticky-l2 c-desc', rowspan: '2' }, 'Description'),
    accounts.map((a) => {
      const s = institutionStyle(a.institution);
      const todayBal = balanceAsOf(state.ledger, a, today);
      return h('th', { colspan: '3', class: 'acc-head', style: { '--acc': s.colour } },
        h('div', { class: 'acc-bar', style: { background: s.colour } }, s.accent ? h('span', { class: 'acc-bar-accent', style: { background: s.accent } }) : null),
        h('div', { class: 'acc-title' },
          h('button', { type: 'button', class: 'btn-link acc-name', title: 'Edit account', onclick: () => openAccountDialog(a.id) }, a.name),
          h('button', { type: 'button', class: 'acc-add', title: `Add entry to ${a.name}`, onclick: () => openTxDialog({ accountId: a.id }) }, '+')),
        h('div', { class: `acc-total ${todayBal < 0 ? 'neg' : ''}` }, `${a.type === 'credit' ? 'Owed ' : ''}${formatPence(todayBal)}`),
        h('div', { class: 'acc-eom', dataset: { eomFor: a.id } }));
    }));
  const head2 = h('tr', {}, accounts.map(() => [h('th', { class: 'num sub' }, 'Credit'), h('th', { class: 'num sub' }, 'Debit'), h('th', { class: 'num sub bal-col' }, 'Balance')]));

  const body = h('tbody', {});
  const openingDate = accounts.map((a) => a.openingDate).sort()[0];
  body.append(h('tr', { class: 'row-bf', dataset: { date: openingDate } },
    h('td', { class: 'sticky-l c-date' }, shortDate(openingDate)),
    h('td', { class: 'sticky-l2 c-desc' }, 'Brought forward'),
    accounts.map((a) => [h('td', {}), h('td', {}), h('td', { class: 'num bal-col' }, formatPence(a.openingBalance))])));

  for (const row of rows) {
    const future = row.date > today;
    const p = row.projection;
    const tags = p ? projectionTags(p, today) : null;
    const openRow = () => (p ? openOccurrenceDialog(p.itemId, p.period) : openTxDialog({ txId: row.txIds[0] }));
    const tr = h('tr', {
      class: `${row.kind === 'note' ? 'row-note' : ''} ${future ? 'future' : ''} ${row.date === today ? 'is-today' : ''} ${p ? 'projected' : ''} ${tags?.cls ?? ''}`,
      dataset: { date: row.date },
    },
      h('td', { class: 'sticky-l c-date clickable', onclick: openRow }, shortDate(row.date)),
      h('td', { class: 'sticky-l2 c-desc clickable', title: p ? `${row.description} — ${tags.label}` : row.description, onclick: openRow },
        p ? h('span', { class: 'rec-icon', title: `Recurring — ${tags.label}` }, '↻ ') : null,
        row.isTransfer ? h('span', { class: 'link-icon', title: 'Linked transfer' }, '⇄ ') : null, row.description));
    for (const a of accounts) {
      const cell = row.cells[a.id];
      const open = (direction) => () =>
        p ? openRow() : cell ? openTxDialog({ txId: cell.txId }) : openTxDialog({ accountId: a.id, date: row.date, direction });
      const bal = row.balances[a.id];
      tr.append(
        h('td', { class: 'num clickable cell', onclick: open('credit') }, cell?.credit != null ? formatPence(cell.credit, { symbol: false }) : cell?.note ? '·' : ''),
        h('td', { class: 'num clickable cell', onclick: open('debit') }, cell?.debit != null ? formatPence(cell.debit, { symbol: false }) : ''),
        h('td', { class: `num bal-col ${cell ? 'bal-changed' : 'bal-carried'} ${bal < 0 ? 'neg' : ''}` }, formatPence(bal, { symbol: false })));
    }
    body.append(tr);
  }

  const more = horizonControl('horizon-grid');
  if (more) body.append(h('tr', { class: 'row-more' }, h('td', { class: 'sticky-l', colspan: String(2 + accounts.length * 3) }, more)));

  const table = h('table', { class: 'grid' }, h('thead', {}, head1, head2), body);
  const wrap = h('div', { class: 'grid-wrap' }, table);
  app.replaceChildren(
    h('div', { class: 'grid-view' },
      h('p', { class: 'grid-hint muted small' }, 'Click an empty Credit/Debit cell to add to that account on that date · click a value or description to edit · ⇄ = linked transfer · ↻ = recurring, click to confirm'),
      wrap));

  // The "month in view" line tracks whichever row sits just below the
  // frozen header — found by probing that point rather than doing math on
  // row heights, since note rows etc. aren't a uniform height.
  function updateMonthInView() {
    // <thead> itself isn't sticky (only its individual <th> cells are via
    // CSS), so once it scrolls far enough its own bounding rect goes
    // off-screen — probe against an actual sticky cell (the sub-header
    // row) instead, which always reflects where the header really sits.
    const subHeadRect = table.querySelector('thead tr:nth-child(2) th').getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const probeX = wrapRect.left + 24;
    const probeY = subHeadRect.bottom + 2;
    const hit = (document.elementsFromPoint(probeX, probeY) ?? []).find((el) => el.closest('tbody tr'));
    const dateIso = hit?.closest('tr')?.dataset.date ?? rows[rows.length - 1]?.date ?? openingDate;
    const eomIso = endOfMonthIso(dateIso);
    const label = monthYearLabel(eomIso);
    for (const a of accounts) {
      const eomBal = balanceAsOf(view, a, eomIso);
      const el = table.querySelector(`[data-eom-for="${a.id}"]`);
      if (!el) continue;
      el.textContent = `${a.type === 'credit' ? 'Owed ' : ''}${formatPence(eomBal)} at end of ${label}`;
      el.classList.toggle('neg', eomBal < 0);
    }
  }

  let scrollQueued = false;
  wrap.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; updateMonthInView(); });
  });

  requestAnimationFrame(() => {
    if (keepScroll) { wrap.scrollTop = keepScroll.top; wrap.scrollLeft = keepScroll.left; }
    else {
      // open at today: the last row dated today or earlier sits near the
      // bottom of the view, with projected entries below it to scroll to
      const upToToday = [...body.querySelectorAll('tr[data-date]')].filter((tr) => tr.dataset.date <= today).pop();
      wrap.scrollTop = upToToday
        ? upToToday.offsetTop + upToToday.offsetHeight - wrap.clientHeight + upToToday.offsetHeight * 3
        : wrap.scrollHeight;
    }
    updateMonthInView();
  });
}

// ------------------------------------------------------------------ transaction dialog

/**
 * @param {{ txId?: string, accountId?: string, date?: string, direction?: 'credit'|'debit' }} opts
 */
function openTxDialog(opts) {
  const dlg = $('txDialog');
  const existing = opts.txId ? state.ledger.transactions.find((t) => t.id === opts.txId) : null;
  const account = accountById(existing ? existing.accountId : opts.accountId ?? state.activeAccountId);
  if (!account) return;
  const words = directionWords(account);
  const counterpart = existing ? counterpartOf(state.ledger, existing) : null;

  let kind = existing ? (existing.kind === 'note' ? 'note' : existing.direction) : opts.direction ?? 'debit';

  const seg = h('div', { class: 'seg', role: 'radiogroup' });
  const segBtn = (value, label) => h('button', {
    type: 'button', role: 'radio', class: 'seg-btn', dataset: { value },
    onclick: () => { kind = value; syncKind(); },
  }, label);
  seg.append(segBtn('debit', `Debit · ${words.debit}`), segBtn('credit', `Credit · ${words.credit}`), segBtn('note', 'Note'));

  const amount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', class: 'amount-input big', value: existing && existing.kind !== 'note' ? penceToInput(existing.amount) : '' });
  const listId = 'descList';
  const desc = h('input', { type: 'text', list: listId, autocomplete: 'off', placeholder: 'e.g. Lottery', value: existing?.description ?? '', enterkeyhint: 'done' });
  const datalist = h('datalist', { id: listId }, recentDescriptions(account.id).map((d) => h('option', { value: d.description })));
  const date = h('input', { type: 'date', required: true, value: existing?.date ?? opts.date ?? todayIso() });
  const dateWarn = h('div', { class: 'warn small', hidden: true });

  const others = state.ledger.accounts.filter((a) => a.id !== account.id && a.active);
  const counterpartSelect = h('select', {},
    h('option', { value: '' }, 'No — just this account'),
    others.map((a) => h('option', { value: a.id }, a.name)));
  const counterpartHint = h('div', { class: 'muted small' });
  const fromItem = existing?.scheduledItemId ? recurringItems(state.ledger).find((i) => i.id === existing.scheduledItemId) : null;
  const recurringNote = existing?.scheduledItemId
    ? h('div', { class: 'linked' }, `↻ Confirmed entry of “${fromItem?.description ?? 'a deleted recurring item'}” for ${periodLabel(existing.scheduledPeriod ?? existing.date.slice(0, 7))}.`,
        fromItem ? ' Deleting it puts the projected entry back.' : '')
    : null;
  const counterpartField = existing
    ? (counterpart ? h('div', { class: 'linked' }, '⇄ Linked: changes also update ', h('strong', {}, accountById(counterpart.accountId)?.name ?? 'other account'), ` (${counterpart.direction}). Delete removes both.`) : null)
    : h('label', { class: 'field' }, h('span', {}, 'Also record in another account?'), counterpartSelect, counterpartHint);

  function syncKind() {
    for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.value === kind));
    amountField.hidden = kind === 'note';
    if (counterpartField && !existing) counterpartField.hidden = kind === 'note';
    updateCounterpartHint();
  }
  function updateCounterpartHint() {
    const other = accountById(counterpartSelect.value);
    if (!other) { counterpartHint.textContent = 'e.g. a card payment from this account, or money moved between accounts.'; return; }
    const oppositeDir = kind === 'credit' ? 'debit' : 'credit';
    counterpartHint.textContent = `Adds a matching ${oppositeDir} of the same amount to ${other.name} — one row in the grid.`;
  }
  function checkDate() {
    dateWarn.hidden = !(date.value && date.value < account.openingDate);
    dateWarn.textContent = `Before this account's opening date (${longDate(account.openingDate)}) — it will still count towards the balance.`;
  }
  counterpartSelect.addEventListener('change', updateCounterpartHint);
  date.addEventListener('input', checkDate);

  // Pick a previous description -> prefill amount/direction/transfer if still blank (new entries only)
  desc.addEventListener('change', () => {
    if (existing) return;
    const prev = recentDescriptions(account.id).find((d) => d.description.toLowerCase() === desc.value.trim().toLowerCase());
    if (!prev) return;
    kind = prev.kind === 'note' ? 'note' : prev.direction;
    if (!amount.value && prev.kind !== 'note') amount.value = penceToInput(prev.amount);
    if (prev.counterpartAccountId && others.some((a) => a.id === prev.counterpartAccountId)) counterpartSelect.value = prev.counterpartAccountId;
    syncKind();
  });

  const amountField = h('label', { class: 'field' }, h('span', {}, 'Amount (£)'), amount);
  const s = institutionStyle(account.institution);

  const form = h('form', {
    method: 'dialog', class: 'sheet-body',
    onsubmit: (e) => {
      e.preventDefault();
      const fields = {
        accountId: account.id,
        date: date.value,
        description: desc.value,
        kind: kind === 'note' ? 'note' : 'transaction',
        direction: kind === 'note' ? (existing?.direction ?? 'debit') : kind,
        amount: kind === 'note' ? 0 : parseAmount(amount.value),
      };
      if (kind !== 'note' && fields.amount === null) return toast('Enter an amount like 12.34', 'error');
      let next;
      if (existing) {
        next = attempt(() => updateTransaction(state.ledger, existing.id, fields));
      } else {
        next = attempt(() => addTransaction(state.ledger, { ...fields, counterpartAccountId: counterpartSelect.value || null }));
      }
      if (!next) return;
      if (!existing) state.activeAccountId = account.id;
      dlg.close();
      commit(next, existing ? 'Updated' : 'Added');
    },
  },
  h('header', { class: 'sheet-head', style: { '--acc': s.colour } },
    swatch(account),
    h('h2', {}, `${existing ? 'Edit' : 'New'} entry · ${account.name}`),
    h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
  seg,
  amountField,
  h('label', { class: 'field' }, h('span', {}, 'Description'), desc, datalist),
  h('label', { class: 'field' }, h('span', {}, 'Date'), date, dateWarn),
  counterpartField,
  recurringNote,
  h('div', { class: 'sheet-actions' },
    existing ? h('button', {
      type: 'button', class: 'btn-danger',
      onclick: () => {
        if (!confirm(counterpart ? 'Delete this entry and its linked entry in the other account?' : 'Delete this entry?')) return;
        dlg.close();
        commit(deleteTransaction(state.ledger, existing.id), 'Deleted');
      },
    }, 'Delete') : h('span'),
    h('button', { type: 'submit', class: 'btn-primary' }, existing ? 'Save' : 'Add')));

  dlg.replaceChildren(form);
  syncKind();
  checkDate();
  openDialog(dlg);
  if (!existing && kind !== 'note') {
    setTimeout(() => {
      // only if the person hasn't already gone to another field — otherwise
      // their typing would suddenly continue in the amount box
      const a = document.activeElement;
      if (!a || a === document.body || a === dlg || !dlg.contains(a) || a.classList.contains('seg-btn')) amount.focus();
    }, 50);
  }
}

/** Recent descriptions for this account (then others), with the last-used amount/direction/linked account. */
function recentDescriptions(accountId) {
  const seen = new Map();
  const txs = state.ledger.transactions;
  const pass = (onlyThisAccount) => {
    for (let i = txs.length - 1; i >= 0 && seen.size < 200; i--) {
      const t = txs[i];
      if (onlyThisAccount !== (t.accountId === accountId)) continue;
      const key = t.description.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      const other = counterpartOf(state.ledger, t);
      seen.set(key, { description: t.description, amount: t.amount, direction: t.direction, kind: t.kind, counterpartAccountId: other?.accountId ?? null });
    }
  };
  pass(true);
  pass(false);
  return [...seen.values()];
}

// ------------------------------------------------------------------ recurring: one month's entry

function periodLabel(period) {
  return monthYearLabel(`${period}-01`);
}
function signedAmount(kind, amount) {
  return kind === 'in' ? `+${formatPence(amount)}` : kind === 'out' ? `−${formatPence(amount)}` : formatPence(amount);
}
function itemAccountsText(item) {
  const name = (id) => accountById(id)?.name ?? 'missing account';
  return item.kind === 'transfer' ? `${name(item.accountId)} → ${name(item.toAccountId)}` : name(item.accountId);
}

/** Tap on a projected entry: confirm it, change/skip just this month, or edit the series. */
function openOccurrenceDialog(itemId, period) {
  const dlg = $('txDialog');
  const item = recurringItems(state.ledger).find((i) => i.id === itemId);
  if (!item) return;
  const view = withProjections(state.ledger, horizonEnd(todayIso(), MAX_HORIZON_MONTHS + 1), state.holidays);
  const p = view.transactions.find((t) => t.isProjected && t.scheduledItemId === itemId && t.scheduledPeriod === period)?.projection;
  if (!p) return; // confirmed meanwhile (e.g. by a sync)
  const account = accountById(item.accountId);
  const s = institutionStyle(account?.institution ?? 'other');

  const amount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'amount-input big', value: penceToInput(p.amount) });
  const date = h('input', { type: 'date', required: true, value: p.date });
  const desc = h('input', { type: 'text', autocomplete: 'off', value: p.description });

  const close = () => dlg.close();
  const readFields = () => {
    const pence = parseAmount(amount.value);
    if (pence === null) { toast('Enter an amount like 12.34', 'error'); return null; }
    if (!date.value) { toast('A valid date is required', 'error'); return null; }
    return { amount: pence, date: date.value, description: desc.value.trim() || item.description };
  };
  const apply = (fn, message) => {
    const next = attempt(fn);
    if (!next) return;
    close();
    commit(next, message);
  };

  const confirmBtn = h('button', {
    type: 'submit', class: 'btn-primary',
    onclick: (e) => {
      e.preventDefault();
      const f = readFields();
      if (f) apply(() => confirmOccurrence(state.ledger, itemId, period, f), 'Confirmed');
    },
  }, 'Confirm');
  const skipBtn = h('button', {
    type: 'button', class: 'btn-secondary',
    onclick: () => apply(() => setOccurrence(state.ledger, itemId, period, { skipped: true }), `Skipped for ${periodLabel(period)}`),
  }, 'Skip this month');
  const thisMonthBtn = h('button', {
    type: 'button', class: 'btn-ghost',
    onclick: () => {
      const f = readFields();
      if (!f) return;
      // store only what differs from the series, so later series edits still flow through the rest
      apply(() => setOccurrence(state.ledger, itemId, period, {
        date: f.date === p.seriesDate ? null : f.date,
        amount: f.amount === item.amount ? null : f.amount,
        description: f.description === item.description ? null : f.description,
      }), `Changed for ${periodLabel(period)} only`);
    },
  }, 'Save for this month only');
  const resetBtn = p.changed ? h('button', {
    type: 'button', class: 'btn-ghost',
    onclick: () => apply(() => setOccurrence(state.ledger, itemId, period, { date: null, amount: null, description: null }), 'Back to the series'),
  }, 'Undo this month’s changes') : null;
  const seriesBtn = h('button', { type: 'button', class: 'btn-ghost', onclick: () => { close(); openRecurringEditor(itemId); } }, 'Edit series…');

  const today = todayIso();
  const status = p.skipped
    ? `Skipped for ${periodLabel(period)}.`
    : p.date < today ? `Due ${longDate(p.date)} — not confirmed yet.`
      : p.date === today ? 'Due today.'
        : `Projected for ${longDate(p.date)}.`;

  const body = p.skipped
    ? [
        h('p', { class: 'rec-status' }, status, ' It isn’t counted in any balance.'),
        h('div', { class: 'sheet-actions' },
          seriesBtn,
          h('button', { type: 'button', class: 'btn-primary', onclick: () => apply(() => setOccurrence(state.ledger, itemId, period, { skipped: false }), 'No longer skipped') }, 'Un-skip')),
      ]
    : [
        h('p', { class: `rec-status ${p.date <= today ? 'rec-due' : ''}` }, status,
          p.changed ? h('span', { class: 'muted' }, ` Changed for this month (series: ${longDate(p.seriesDate)}, ${formatPence(item.amount)}).`) : null),
        h('label', { class: 'field' }, h('span', {}, 'Amount (£)'), amount),
        h('div', { class: 'field-pair' },
          h('label', { class: 'field' }, h('span', {}, 'Date'), date),
          h('label', { class: 'field' }, h('span', {}, 'Description'), desc)),
        h('p', { class: 'muted small' }, 'Confirm once it has actually gone through — adjust the amount or date first if they differ.'),
        h('div', { class: 'sheet-actions' }, skipBtn, confirmBtn),
        h('div', { class: 'btn-row rec-more' }, thisMonthBtn, resetBtn, seriesBtn),
      ];

  dlg.replaceChildren(h('form', { method: 'dialog', class: 'sheet-body', onsubmit: (e) => { e.preventDefault(); confirmBtn.click(); } },
    h('header', { class: 'sheet-head', style: { '--acc': s.colour } },
      account ? swatch(account) : null,
      h('h2', {}, `↻ ${item.description}`),
      h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
    h('p', { class: 'muted small rec-summary' }, `${itemAccountsText(item)} · ${signedAmount(item.kind, item.amount)} · ${describeRule(item)}`),
    body));
  openDialog(dlg);
}

// ------------------------------------------------------------------ recurring: manager + editor

function renderRecurringManager() {
  const dlg = $('recurringDialog');
  const today = todayIso();
  const items = recurringItems(state.ledger)
    .map((item) => ({ item, next: upcomingDates(item, today, 1, state.holidays)[0] ?? null }))
    .sort((a, b) => (a.next ?? '9999').localeCompare(b.next ?? '9999') || a.item.description.localeCompare(b.item.description));

  const list = items.length
    ? h('ul', { class: 'rec-list' }, items.map(({ item, next }) => {
        const acc = accountById(item.accountId);
        const ended = !next;
        return h('li', {}, h('button', { type: 'button', class: `rec-row ${ended ? 'rec-ended' : ''}`, onclick: () => openRecurringEditor(item.id) },
          acc ? swatch(acc) : null,
          h('span', { class: 'rec-main' },
            h('span', { class: 'rec-name' }, item.description),
            h('span', { class: 'muted small' }, `${describeRule(item)} · ${itemAccountsText(item)}`),
            h('span', { class: 'small' }, ended ? `Ended${item.endDate ? ` ${longDate(item.endDate)}` : ''}` : `Next: ${longDate(next)}`)),
          h('span', { class: `rec-amt ${item.kind === 'in' ? 'credit' : ''}` }, signedAmount(item.kind, item.amount))));
      }))
    : h('p', { class: 'muted' }, 'None yet. Add salary, direct debits, subscriptions and card payments here — they then appear ahead of time in your accounts, ready to confirm.');

  dlg.replaceChildren(h('div', { class: 'sheet-body' },
    h('header', { class: 'sheet-head' },
      h('h2', {}, 'Recurring items'),
      h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    list,
    h('button', { type: 'button', class: 'btn-primary', onclick: () => openRecurringEditor(null) }, '+ Add recurring item'),
    h('p', { class: 'muted small' }, holidayStatusText())));
}

function openRecurringManager() {
  renderRecurringManager();
  openDialog($('recurringDialog'));
}

function openRecurringEditor(itemId) {
  const dlg = $('recurringEditDialog');
  const existing = itemId ? recurringItems(state.ledger).find((i) => i.id === itemId) : null;
  const accounts = state.ledger.accounts.filter((a) => a.active || a.id === existing?.accountId || a.id === existing?.toAccountId);
  if (!accounts.length) return toast('Add an account first', 'error');
  const defaultAccount = existing?.accountId ?? (accountById(state.activeAccountId)?.id ?? accounts[0].id);

  let kind = existing?.kind ?? 'out';
  const desc = h('input', { type: 'text', autocomplete: 'off', placeholder: 'e.g. Netflix', value: existing?.description ?? '' });
  const seg = h('div', { class: 'seg', role: 'radiogroup' },
    [['out', 'Money out'], ['in', 'Money in'], ['transfer', 'Transfer / card payment']].map(([v, label]) =>
      h('button', { type: 'button', role: 'radio', class: 'seg-btn', dataset: { value: v }, onclick: () => { kind = v; sync(); } }, label)));
  const accountOptions = (selected) => accounts.map((a) => h('option', { value: a.id, selected: a.id === selected }, a.name));
  const account = h('select', {}, accountOptions(defaultAccount));
  const toAccount = h('select', {}, accountOptions(existing?.toAccountId ?? accounts.find((a) => a.id !== defaultAccount && a.type === 'credit')?.id ?? accounts.find((a) => a.id !== defaultAccount)?.id));
  const accountLabel = h('span', {}, 'Account');
  const toField = h('label', { class: 'field' }, h('span', {}, 'To (e.g. the credit card)'), toAccount);
  const amount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'amount-input', placeholder: '0.00', value: existing ? penceToInput(existing.amount) : '' });

  const every = existing?.everyMonths ?? 1;
  const freq = h('select', {},
    [['1', 'Monthly'], ['n', 'Every few months'], ['12', 'Yearly']].map(([v, l]) =>
      h('option', { value: v, selected: v === (every === 1 ? '1' : every === 12 ? '12' : 'n') }, l)));
  const nMonths = h('input', { type: 'text', inputmode: 'numeric', class: 'amount-input', value: every !== 1 && every !== 12 ? String(every) : '6' });
  const nField = h('label', { class: 'field' }, h('span', {}, 'Every how many months?'), nMonths);
  const day = h('input', { type: 'text', inputmode: 'numeric', class: 'amount-input', placeholder: '1–31', value: existing ? String(existing.day) : '' });
  const start = h('input', { type: 'date', required: true, value: existing?.startDate ?? todayIso() });
  const end = h('input', { type: 'date', value: existing?.endDate ?? '' });
  const shift = h('select', {},
    [['none', 'Leave it on that day'], ['before', 'Move to the working day before (e.g. salary)'], ['after', 'Move to the next working day (e.g. direct debit)']].map(([v, l]) =>
      h('option', { value: v, selected: (existing?.shift ?? 'none') === v }, l)));
  const startHint = h('div', { class: 'muted small' });
  const preview = h('div', { class: 'rec-preview' });

  function draft() {
    const everyMonths = freq.value === 'n' ? Number.parseInt(nMonths.value, 10) : Number(freq.value);
    return {
      description: desc.value, kind, accountId: account.value, toAccountId: kind === 'transfer' ? toAccount.value : null,
      amount: parseAmount(amount.value), everyMonths, day: Number.parseInt(day.value, 10),
      startDate: start.value, endDate: end.value || null, shift: shift.value,
    };
  }
  function sync() {
    for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.value === kind));
    toField.hidden = kind !== 'transfer';
    accountLabel.textContent = kind === 'transfer' ? 'From' : 'Account';
    nField.hidden = freq.value !== 'n';
    startHint.textContent = freq.value === '1' ? 'Nothing before this date.' : 'Nothing before this date — and it repeats counting from this month.';
    const d = draft();
    let text = '';
    if (d.day >= 1 && d.day <= 31 && d.everyMonths >= 1 && d.everyMonths <= 12 && d.startDate) {
      const next = upcomingDates(d, todayIso(), 3, state.holidays);
      text = next.length ? `Next: ${next.map(longDate).join(' · ')}` : 'No dates from today (ended).';
    }
    preview.textContent = text;
    preview.hidden = !text;
  }
  for (const el of [freq, nMonths, day, start, end, shift]) el.addEventListener('input', sync);
  for (const el of [freq, shift, account]) el.addEventListener('change', sync);

  const form = h('form', {
    method: 'dialog', class: 'sheet-body',
    onsubmit: (e) => {
      e.preventDefault();
      const d = draft();
      if (d.amount === null) return toast('Enter an amount like 12.34', 'error');
      if (Number.isNaN(d.day)) return toast('Day of the month must be 1 to 31', 'error');
      if (Number.isNaN(d.everyMonths)) return toast('Repeat every 1 to 12 months', 'error');
      const next = existing
        ? attempt(() => updateRecurring(state.ledger, existing.id, d))
        : attempt(() => addRecurring(state.ledger, d)?.ledger);
      if (!next) return;
      dlg.close();
      commit(next, existing ? 'Recurring item updated' : 'Recurring item added');
      if ($('recurringDialog').open) renderRecurringManager();
    },
  },
  h('header', { class: 'sheet-head' },
    h('h2', {}, existing ? 'Edit recurring item' : 'New recurring item'),
    h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
  existing ? h('p', { class: 'muted small' }, 'Changes apply to every month not yet confirmed. Confirmed entries stay as they are.') : null,
  h('label', { class: 'field' }, h('span', {}, 'Description'), desc),
  seg,
  h('div', { class: 'field-pair' }, h('label', { class: 'field' }, accountLabel, account), toField),
  h('label', { class: 'field' }, h('span', {}, 'Amount (£)'), amount),
  h('div', { class: 'field-pair' },
    h('label', { class: 'field' }, h('span', {}, 'Repeats'), freq),
    h('label', { class: 'field' }, h('span', {}, 'Day of the month'), day)),
  nField,
  h('div', { class: 'field-pair' },
    h('label', { class: 'field' }, h('span', {}, 'From'), start),
    h('label', { class: 'field' }, h('span', {}, 'To (blank = no end)'), end)),
  startHint,
  h('label', { class: 'field' }, h('span', {}, 'If it lands on a weekend or bank holiday'), shift),
  preview,
  h('div', { class: 'sheet-actions' },
    existing ? h('button', {
      type: 'button', class: 'btn-danger',
      onclick: () => {
        if (!confirm(`Delete “${existing.description}”?\n\nIts projected entries disappear. Entries you’ve already confirmed stay as they are.`)) return;
        dlg.close();
        commit(deleteRecurring(state.ledger, existing.id), 'Recurring item deleted');
        if ($('recurringDialog').open) renderRecurringManager();
      },
    }, 'Delete') : h('span'),
    h('button', { type: 'submit', class: 'btn-primary' }, existing ? 'Save' : 'Add')));

  dlg.replaceChildren(form);
  sync();
  openDialog(dlg);
}

// ------------------------------------------------------------------ account dialog

function openAccountDialog(accountId) {
  const dlg = $('accountDialog');
  const existing = accountId ? accountById(accountId) : null;
  const txCount = existing ? state.ledger.transactions.filter((t) => t.accountId === existing.id).length : 0;

  const name = h('input', { type: 'text', required: true, value: existing?.name ?? '', placeholder: 'e.g. Monzo' });
  const type = h('select', {},
    [['current', 'Current account'], ['savings', 'Savings'], ['credit', 'Credit card']].map(([v, l]) => h('option', { value: v, selected: (existing?.type ?? 'current') === v }, l)));
  const inst = h('select', {}, Object.entries(INSTITUTIONS).map(([k, v]) => h('option', { value: k, selected: (existing?.institution ?? 'other') === k }, v.label)));
  const opening = h('input', { type: 'text', inputmode: 'decimal', class: 'amount-input', value: existing ? penceToInput(existing.openingBalance) : '', placeholder: '0.00' });
  const openingLabel = h('span', {});
  const openingDate = h('input', { type: 'date', required: true, value: existing?.openingDate ?? firstOfMonthIso() });
  const hidden = h('input', { type: 'checkbox', checked: existing ? !existing.active : false });
  const syncType = () => {
    openingLabel.textContent = type.value === 'credit' ? 'Amount owed at opening date (£)' : 'Opening balance (£)';
  };
  type.addEventListener('change', syncType);
  syncType();

  const form = h('form', {
    method: 'dialog', class: 'sheet-body',
    onsubmit: (e) => {
      e.preventDefault();
      // allow a leading minus for an overdrawn opening balance
      const raw = opening.value.trim();
      const negative = raw.startsWith('-');
      const pence = raw === '' ? 0 : parseAmount(negative ? raw.slice(1) : raw);
      if (pence === null) return toast('Opening balance should look like 1234.56', 'error');
      const fields = { name: name.value, type: type.value, institution: inst.value, openingBalance: negative ? -pence : pence, openingDate: openingDate.value };
      let next;
      if (existing) next = attempt(() => updateAccount(state.ledger, existing.id, { ...fields, name: fields.name.trim(), active: !hidden.checked }));
      else {
        const r = attempt(() => addAccount(state.ledger, fields));
        next = r?.ledger;
        if (r) state.activeAccountId = r.account.id;
      }
      if (!next) return;
      dlg.close();
      commit(next, existing ? 'Account updated' : 'Account added');
      if ($('settingsDialog').open) renderSettings();
    },
  },
  h('header', { class: 'sheet-head' },
    h('h2', {}, existing ? 'Edit account' : 'New account'),
    h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
  h('label', { class: 'field' }, h('span', {}, 'Name'), name),
  h('div', { class: 'field-pair' },
    h('label', { class: 'field' }, h('span', {}, 'Type'), type),
    h('label', { class: 'field' }, h('span', {}, 'Colour (bank)'), inst)),
  h('div', { class: 'field-pair' },
    h('label', { class: 'field' }, openingLabel, opening),
    h('label', { class: 'field' }, h('span', {}, 'Opening date'), openingDate)),
  existing ? h('label', { class: 'check' }, hidden, h('span', {}, 'Hide this account (keeps its history)')) : null,
  h('div', { class: 'sheet-actions' },
    existing ? h('button', {
      type: 'button', class: 'btn-danger', disabled: txCount > 0, title: txCount ? `Has ${txCount} entries — hide it instead` : '',
      onclick: () => {
        if (!confirm(`Delete ${existing.name}?`)) return;
        const next = attempt(() => deleteAccount(state.ledger, existing.id));
        if (!next) return;
        dlg.close();
        commit(next, 'Account deleted');
        if ($('settingsDialog').open) renderSettings();
      },
    }, txCount ? `Delete (has ${txCount} entries)` : 'Delete') : h('span'),
    h('button', { type: 'submit', class: 'btn-primary' }, existing ? 'Save' : 'Add account')));

  dlg.replaceChildren(form);
  openDialog(dlg);
}

// ------------------------------------------------------------------ settings / backup

function renderSettings() {
  const dlg = $('settingsDialog');
  const l = state.ledger;
  const canShare = (() => {
    try { return Boolean(navigator.canShare?.({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] })); } catch { return false; }
  })();

  const accountsList = h('ul', { class: 'acc-list' },
    l.accounts.map((a, i) => h('li', { class: a.active ? '' : 'inactive' },
      swatch(a),
      h('span', { class: 'acc-list-name' }, a.name, a.active ? '' : ' (hidden)'),
      h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Move up', disabled: i === 0, onclick: () => { commit(moveAccount(state.ledger, a.id, -1)).then(renderSettings); } }, '▲'),
      h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Move down', disabled: i === l.accounts.length - 1, onclick: () => { commit(moveAccount(state.ledger, a.id, 1)).then(renderSettings); } }, '▼'),
      h('button', { type: 'button', class: 'btn-ghost', onclick: () => openAccountDialog(a.id) }, 'Edit'))));

  const viewChoice = h('div', { class: 'seg' },
    [['auto', 'Auto'], ['list', 'List'], ['grid', 'Grid']].map(([v, label]) => h('button', {
      type: 'button', class: 'seg-btn', 'aria-checked': String(state.viewMode === v),
      onclick: () => { state.viewMode = v; writePref('viewMode', v); render(); renderSettings(); },
    }, label)));

  const st = sync.getState();
  const driveSection = st.enabled
    ? h('section', { class: 'settings-section' },
        h('h3', {}, 'Google Drive sync'),
        h('p', { class: 'small' }, `On${st.email ? ` · ${st.email}` : ''} · file: My Drive/${st.location}`),
        h('p', { class: 'muted small', id: 'driveStatusLine' }, driveStatusText()),
        h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn-primary', onclick: syncFromTap }, 'Sync now'),
          h('button', {
            type: 'button', class: 'btn-secondary',
            onclick: async () => {
              if (!confirm('Stop syncing on this device?\n\nThis device keeps its data, and the Drive file is left as it is. You can reconnect any time.')) return;
              await sync.disconnect();
              renderSettings();
              toast('Drive sync turned off on this device');
            },
          }, 'Stop syncing here')),
        h('p', { class: 'muted small' }, 'Google’s sign-in lasts about an hour. Within that, changes sync by themselves; after it, tap the cloud button at the top to carry on.'))
    : h('section', { class: 'settings-section' },
        h('h3', {}, 'Google Drive sync'),
        h('p', { class: 'muted small' }, `Keeps your devices in step through one file in your Google Drive (My Drive/${st.location}). The app can only see files it creates itself — nothing else in your Drive. If Drive already has data from another device, the two are combined.`),
        h('button', {
          type: 'button', class: 'btn-primary',
          onclick: () => {
            // connect() must start Google's sign-in straight from this tap
            sync.connect().then((r) => {
              if ($('settingsDialog').open) renderSettings();
              afterSync(r, true);
            });
          },
        }, 'Connect Google Drive'));

  dlg.replaceChildren(h('div', { class: 'sheet-body' },
    h('header', { class: 'sheet-head' },
      h('h2', {}, 'Settings & backup'),
      h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),

    driveSection,

    h('section', { class: 'settings-section' },
      h('h3', {}, st.enabled ? 'Backup file' : 'Move data between devices'),
      h('p', { class: 'muted small' }, st.enabled
        ? 'A copy you can keep anywhere. Importing replaces this device’s data — and, with sync on, the Drive copy too on the next sync.'
        : 'Each browser keeps its own copy. Export here, then import on the other device — importing replaces that device’s data completely, so always import the most recent export.'),
      !st.enabled && hasUnexported() ? h('p', { class: 'warn small' }, 'Changes on this device since the last export/import.') : null,
      h('div', { class: 'btn-row' },
        canShare ? h('button', { type: 'button', class: 'btn-primary', onclick: () => doExport(true) }, 'Export & share…') : null,
        h('button', { type: 'button', class: canShare ? 'btn-secondary' : 'btn-primary', onclick: () => doExport(false) }, 'Download export'),
        h('button', { type: 'button', class: 'btn-secondary', onclick: () => $('importInput').click() }, 'Import…')),
      h('p', { class: 'muted small' },
        `Last export: ${when(state.meta.lastExportAt)} · Last import: ${when(state.meta.lastImportAt)}${state.meta.lastImportFrom ? ` (from ${state.meta.lastImportFrom})` : ''}`)),

    h('section', { class: 'settings-section' },
      h('h3', {}, 'Recurring items'),
      h('p', { class: 'muted small' }, (() => {
        const n = recurringItems(l).length;
        return n ? `${n} recurring item${n === 1 ? '' : 's'} — salary, bills, subscriptions, card payments.` : 'Salary, direct debits, subscriptions, card payments — set up once, then confirm each month.';
      })()),
      h('button', { type: 'button', class: 'btn-secondary', onclick: openRecurringManager }, 'Manage recurring items')),

    h('section', { class: 'settings-section' },
      h('h3', {}, 'Accounts'),
      accountsList,
      h('button', { type: 'button', class: 'btn-secondary', onclick: () => openAccountDialog(null) }, '+ Add account')),

    h('section', { class: 'settings-section' },
      h('h3', {}, 'Layout'),
      h('p', { class: 'muted small' }, 'Auto = grid on wide screens, list on phones.'),
      viewChoice),

    h('section', { class: 'settings-section' },
      h('h3', {}, 'Test data'),
      h('p', { class: 'muted small' }, `${l.transactions.length} entries across ${l.accounts.length} accounts on this device.`),
      h('button', {
        type: 'button', class: 'btn-danger',
        onclick: async () => {
          const syncing = sync.isEnabled();
          const msg = syncing
            ? 'Erase ALL finance data on this device?\n\nDrive sync is switched off here first, so your Drive copy is NOT touched — reconnect afterwards to load it back.'
            : 'Erase ALL finance data on this device? Export first if you want to keep it.';
          if (!confirm(msg)) return;
          // Disconnect BEFORE emptying, or the next sync would read the empty
          // ledger as "everything deleted" and push that to Drive.
          if (syncing) await sync.disconnect();
          state.meta = {};
          await saveMeta(state.meta);
          dlg.close();
          commit(emptyLedger(), 'All data erased');
        },
      }, 'Erase all data on this device')),

    h('p', { class: 'muted small center' }, `Finance Tracker v${APP_VERSION} · ${state.meta.persisted ? 'storage protected' : 'storage may be cleared by the browser — keep exports'}`)));
}

function downloadBlob(file, name) {
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function doExport(share) {
  const payload = JSON.stringify(buildExport(state.ledger, deviceLabel()), null, 1);
  const name = exportFileName();
  const file = new File([payload], name, { type: 'application/json' });
  let message = `Exported ${name}`;
  if (share) {
    try {
      await navigator.share({ files: [file], title: 'Finance Tracker export' });
    } catch (err) {
      if (err?.name === 'AbortError') return; // user closed the share sheet themselves — not an error
      // Some Android/PWA combinations refuse to share a file (seen as a
      // "Permission denied" NotAllowedError) even though sharing text works
      // fine. Rather than dead-ending, fall back to a plain download, which
      // doesn't need that permission at all.
      downloadBlob(file, name);
      message = `Couldn't open the share sheet, so downloaded ${name} instead`;
    }
  } else {
    downloadBlob(file, name);
  }
  state.meta = { ...state.meta, lastExportAt: new Date().toISOString() };
  await saveMeta(state.meta);
  // Redraw the settings dialog BEFORE toasting: toast() parents the toast
  // element into the topmost open dialog, and renderSettings() wipes that
  // dialog's children via replaceChildren — doing it after would immediately
  // erase the toast we just showed.
  if ($('settingsDialog').open) renderSettings();
  toast(message);
  render();
}

async function doImport(file) {
  try {
    const parsed = parseImport(await file.text());
    const current = state.ledger.transactions.length;
    const incoming = parsed.ledger.transactions.length;
    const ok = confirm(
      `Replace this device's data with the export from ${when(parsed.exportedAt)}${parsed.exportedFrom ? ` (${parsed.exportedFrom})` : ''}?\n\n` +
      `This device: ${current} entries\nExport file: ${incoming} entries` +
      (sync.isEnabled() ? '\n\nDrive sync is on, so the Drive copy (and your other devices) will be replaced too on the next sync.' : ''));
    if (!ok) return;
    state.meta = { ...state.meta, lastImportAt: new Date().toISOString(), lastImportFrom: parsed.exportedFrom || file.name };
    await saveMeta(state.meta);
    // keep the ledger's own lastModified so "unexported changes" starts clean
    await commit(parsed.ledger); // no message yet — see note in doExport about ordering
    if ($('settingsDialog').open) renderSettings();
    toast(`Imported ${incoming} entries`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ------------------------------------------------------------------ wiring

$('settingsBtn').addEventListener('click', () => {
  auth.preload?.(); // get Google's script ready in case "Connect" is tapped
  renderSettings();
  openDialog($('settingsDialog'));
});
$('syncChip').addEventListener('click', syncFromTap);
sync.onChange(renderSyncChip);
// Sync when returning to the app, and push when leaving it — both only with
// a still-valid sign-in (never opens Google's window by itself).
document.addEventListener('visibilitychange', () => {
  if (!state.ledger || !sync.isEnabled()) return;
  if (document.visibilityState === 'hidden') { clearTimeout(syncTimer); sync.sync(); }
  else { renderSyncChip(); sync.sync().then(afterSync); }
});
setInterval(() => sync.isEnabled() && renderSyncChip(), 60 * 1000); // sign-in expiry / "Synced hh:mm" freshness
$('viewBtn').addEventListener('click', () => {
  state.viewMode = isGrid() ? 'list' : 'grid';
  writePref('viewMode', state.viewMode);
  render();
});
$('fab').addEventListener('click', () => openTxDialog({ accountId: state.activeAccountId }));
$('importInput').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) doImport(f);
});
desktopQuery.addEventListener('change', () => state.viewMode === 'auto' && state.ledger && render());

// tap outside a dialog's content closes it
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.installPrompt = e;
  if (state.ledger) render();
});
$('installBtn').addEventListener('click', async () => {
  const p = state.installPrompt;
  if (!p) return;
  state.installPrompt = null;
  p.prompt();
  await p.userChoice.catch(() => null);
  render();
});

async function start() {
  try {
    state.ledger = (await loadLedger()) ?? emptyLedger();
    state.meta = await loadMeta();
  } catch (err) {
    app.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Storage unavailable'), h('p', {}, `This browser blocked local storage (${err.message}). Private/incognito windows often do this.`)));
    return;
  }
  render();
  loadHolidays();
  try {
    await sync.init();
    if (sync.isEnabled()) auth.preload?.(); // ready for a "Tap to sync"
    renderSyncChip();
    sync.sync().then(afterSync);
  } catch (err) {
    toast(`Drive sync unavailable: ${err.message}`, 'error');
  }
  requestPersistence().then((persisted) => { state.meta.persisted = persisted; });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
}

start();
