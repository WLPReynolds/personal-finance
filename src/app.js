/**
 * Finance Tracker — local-only test build UI.
 * Mobile: tabbed single-account feed + FAB/bottom sheet.
 * Desktop: spreadsheet-style grid (Date/Description frozen, Credit/Debit/Balance per account).
 * Data: IndexedDB on this device; export/import a JSON file to move it between devices.
 */
import {
  loadLedger, saveLedger, loadMeta, saveMeta, loadSyncState, saveSyncState, loadBankHolidays, saveBankHolidays, requestPersistence,
  loadVaultHeader, saveVaultHeader, setVaultKey, rekeyAll, wipeDevice, flushWrites, loadAuthCache, saveAuthCache,
  loadTrackerEstimates, saveTrackerEstimates,
  loadJointLedger, saveJointLedger, loadJointSyncState, saveJointSyncState, loadJointSettings, saveJointSettings, removeJointData,
} from './store.js';
import {
  createVault, unlockVault, changePassphrase, passphraseProblem, isVaultHeader, AUTO_LOCK_CHOICES, DEFAULT_AUTO_LOCK, MIN_PASSPHRASE_LENGTH,
} from './lib/vault.js';
import { googleAuth } from './google-auth.js';
import { googleDrive } from './drive.js';
import { createSyncEngine } from './lib/sync-engine.js';
import { shareTokenRequests } from './lib/shared-auth.js';
import {
  JOINT_FOLDER_NAME, JOINT_FILE_NAME, emptyJointLedger, isJointLedger, addJointAccount, combineLedgers, splitLedger,
} from './lib/joint.js';
import {
  emptyLedger, addAccount, updateAccount, deleteAccount, moveAccount,
  addTransaction, updateTransaction, deleteTransaction, setStatementMonth,
  accountRunning, balanceAsOf, counterpartOf, setEnvelopeSplits, addEnvelopeMove, updateEnvelopeMove, displayOpening,
} from './lib/ops.js';
import { isLoan, showsOwed, balanceLevel, balanceProblems, newLimitProblems, LEVELS } from './lib/limits.js';
import {
  UNALLOCATED, envelopeConfig, envelopeList, envelopeName, newEnvelope, envelopesInUse, splitEvenly,
  envelopeBalances, envelopeHistory, allocationOf, unallocatedEntries, isEnvelopeMove,
} from './lib/envelopes.js';
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
  upcomingDates, describeRule, MIN_EVERY_DAYS, MAX_EVERY_DAYS, itemNumbering, seriesAmount, numberLabel, statementCardFor, seriesFinished,
  envelopeLegAccountId,
} from './lib/schedule.js';
import {
  DEFAULT_PAYMENT_DAYS, statementConfig, statementDate, paymentDueDate, statementFor, statementMonthByDate,
  boundaryChoice, withStatements, addMonths, monthOf, statementMonths,
} from './lib/statements.js';
import {
  isReconciled, setReconciled, reconcileScope, reconcileDifference, defaultPeriod, reconcilesByStatement,
} from './lib/reconcile.js';
import {
  TRACKER_SOURCE, TRACKER_CHECK_MS, refreshTrackerEstimates, usesTracker, trackerPeriodFor,
} from './lib/tracker-estimates.js';
import {
  ticketSettings, ticketSettingsRecord, ticketSettingsProblem, setTicketSettings, confirmTicket, confirmReturn,
  isRingFenced, addRingFence, removeRingFence, syncRingFence, ticketsMissingFromTracker, TICKET_DESCRIPTION,
} from './lib/tickets.js';

export const APP_VERSION = '0.14.0';

const state = {
  // v0.14: `ledger` is what every screen draws from. With the joint account
  // on it is personal + joint COMBINED (lib/joint.js) and never saved as such;
  // `personal` and `joint` are the two real ledgers, each saved and synced on
  // its own. With it off, `joint` is null and `ledger` is simply `personal`.
  ledger: null,
  personal: null,
  joint: null,
  jointSettings: { enabled: false }, // this device's switch (never synced)
  meta: {},
  activeAccountId: null,
  viewMode: readPref('viewMode', 'auto'), // 'auto' | 'list' | 'grid'
  // v0.14: on the phone the app opens on the Summary (every account's header card), unless ⚙ says "First account"
  phoneLanding: readPref('phoneLanding', 'summary'), // 'summary' | 'account'
  summary: readPref('phoneLanding', 'summary') === 'summary',
  gridScroll: null,
  listScrollToToday: true, // phone list: jump to today on open / account switch, not on every redraw
  installPrompt: null,
  // Recurring items: how far ahead projected entries are shown. Every
  // device starts at 3 months each time the app opens; "show more" adds 3.
  horizonMonths: 3,
  holidays: new Set(BUILT_IN_BANK_HOLIDAYS),
  holidayInfo: { source: 'built-in', fetchedAt: null, lastYear: lastKnownYear(BUILT_IN_BANK_HOLIDAYS) },
  vault: null, // v0.10: the passphrase lock's header while it's on (this device only)
  tracker: null, // v0.11: the ticket tracker's figures as last read from Drive (this device only)
  envView: null, // v0.12: { accountId, envelopeId } shown in the envelopes dialog (undefined id = all envelopes)
};

const $ = (id) => document.getElementById(id);
/** v0.13.2: true if that dialog exists and is open. Null-safe, so a page that's
 *  a version behind (missing a dialog) can't break a save or a refresh. */
const isOpen = (id) => $(id)?.open === true;
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
  if (!dlg.open) dlg.showModal(); // already open = new content in the same dialog (e.g. statement -> payment)
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
/** v0.14: rebuild the display ledger after either real ledger changes. */
function recombine() {
  state.ledger = state.joint ? combineLedgers(state.personal, state.joint) : state.personal;
}
function jointIds() {
  return new Set(state.joint?.accounts.map((a) => a.id) ?? []);
}
const isJointAccount = (a) => Boolean(a && state.joint?.accounts.some((j) => j.id === a.id));
/** Accounts an entry on `accountId` may be linked with: v0.14 keeps the two files apart. */
function sameFileAccounts(accountId) {
  const ids = jointIds();
  return state.ledger.accounts.filter((a) => ids.has(a.id) === ids.has(accountId));
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
  const el = h('span', { class: `swatch ${extra} ${s.icon ? 'swatch-icon' : ''}`, style: { background: s.colour, color: s.ink ?? '#fff' } },
    s.accent ? h('span', { class: 'swatch-accent', style: { background: s.accent } }) : null);
  if (s.icon === 'people') el.innerHTML = PEOPLE_SVG(10); // v0.14 joint account
  return el;
}
function directionWords(account) {
  if (isLoan(account)) return { debit: 'Charge / interest', credit: 'Repayment' }; // v0.14
  return account.type === 'credit'
    ? { debit: 'Spend', credit: 'Payment / refund' }
    : { debit: 'Money out', credit: 'Money in' };
}

// ------------------------------------------------------------------ v0.14 limits: overdraft, credit limit

/** CSS class for a balance past one of the account's lines: amber = into the overdraft, red = the rest. */
function limitClass(account, display) {
  const level = balanceLevel(account, display);
  return !level ? '' : level === 'overdraft' ? 'lim-warn' : 'lim-alert';
}
function dayText(iso) {
  return iso === todayIso() ? 'today' : new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function limitLine(p) {
  const n = p.account.name;
  const when = dayText(p.date);
  if (p.level === 'overdrawn') return `${n} goes overdrawn ${when === 'today' ? 'today' : `on ${when}`}: ${formatPence(p.balance)}.`;
  if (p.level === 'overdraft') return `${n} goes into its overdraft ${when === 'today' ? 'today' : `on ${when}`}: ${formatPence(p.balance)} (limit ${formatPence(p.limit)}).`;
  if (p.level === 'past-overdraft') return `${n} goes PAST its ${formatPence(p.limit)} overdraft limit ${when === 'today' ? 'today' : `on ${when}`}: ${formatPence(p.balance)}.`;
  return `${n} goes OVER its ${formatPence(p.limit)} credit limit ${when === 'today' ? 'today' : `on ${when}`}: ${formatPence(p.balance)} owed.`;
}
/**
 * Before saving `next`: if it takes an account past a line (from today up to
 * the furthest date the screen shows), ask first. A warning, never a block.
 * @returns {boolean} true = go ahead
 */
function limitsOK(next) {
  try {
    const to = projectionEnd();
    const before = withProjections(state.ledger, to, state.holidays, sources());
    const after = withProjections(next, to, state.holidays, sources());
    const problems = newLimitProblems(before, after, todayIso(), to);
    if (!problems.length) return true;
    return confirm(`⚠ ${problems.map(limitLine).join('\n⚠ ')}\n\n(Checked to ${longDate(to)} — as far ahead as the screen shows.)\n\nSave anyway?`);
  } catch (err) {
    console.error(err); // a problem working out the warning must never stop a save
    return true;
  }
}
/** Header line: when an account first crosses each line it reaches (today → the end of what's shown). */
function limitHeaderText(account, view) {
  const pr = balanceProblems(view, account, todayIso(), projectionEnd());
  if (!pr) return null;
  const words = { overdraft: 'Into overdraft', overdrawn: 'Overdrawn', 'past-overdraft': 'Past overdraft limit', 'over-credit-limit': 'Over credit limit' };
  const parts = Object.entries(pr.first).sort((a, b) => a[1].date.localeCompare(b[1].date))
    .map(([lvl, p]) => `${words[lvl]} ${p.date === todayIso() ? 'today' : `from ${dayText(p.date)}`}`);
  return { text: `⚠ ${parts.join(' · ')}`, cls: pr.worst === 'overdraft' ? 'lim-warn' : 'lim-alert' };
}
function hasUnexported() {
  if (!state.personal) return false;
  const marker = [state.meta.lastExportAt, state.meta.lastImportAt].filter(Boolean).sort().pop();
  return state.personal.transactions.length > 0 && (!marker || state.personal.lastModified > marker);
}

// ------------------------------------------------------------------ recurring items: projections & bank holidays

function projectionEnd() {
  return horizonEnd(todayIso(), state.horizonMonths);
}
/** The ledger plus projected entries from recurring items — for display only, never saved. */
function viewLedger() {
  const end = projectionEnd();
  return markTicketAlerts(withStatements(withProjections(state.ledger, end, state.holidays, sources()), end, state.holidays));
}
/** v0.11: extra inputs for projections — the ticket tracker's published figures, if read. v0.13: today (tickets). */
function sources() {
  return { tracker: state.tracker?.estimates ?? null, today: todayIso() };
}
/**
 * v0.13: confirmed tickets that have gone from the tracker's file (and their
 * ring-fence legs) get `ticketAlert` on the view copy — drawn as a red row.
 */
function markTicketAlerts(view) {
  if (!ticketSettings(state.ledger)) return view;
  const missing = ticketsMissingFromTracker(state.ledger, state.tracker?.estimates, todayIso());
  if (!missing.size) return view;
  return { ...view, transactions: view.transactions.map((t) => (missing.has(t.id) || missing.has(t.ringFenceOf) ? { ...t, ticketAlert: true } : t)) };
}
/** Tap on a projected row: a recurring month, a ticket (v0.13), or the money moved back before a card payment. */
function openProjection(p) {
  if (p.kind === 'ticket') return openTicketDialog(p.ticket.id);
  if (p.kind === 'ticketReturn') return openReturnDialog(p.statementMonth);
  return openOccurrenceDialog(p.itemId, p.period);
}
const ALERT_MISSING = 'No longer in the ticket tracker — tap';
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
    if (isOpen('recurringDialog')) renderRecurringManager();
  } catch {
    /* offline or gov.uk unreachable — keep the list we have */
  }
}
/** Class + short label for a projected entry: skipped / due (amber) / projected. */
function projectionTags(p, today) {
  if (p.kind === 'ticket') {
    if (p.bought) return { cls: 'overdue', label: 'Bought — tap to confirm' };
    if (p.overdue) return { cls: 'alert', label: `Overdue — due ${new Date(p.seriesDate + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, not bought yet` };
    return { cls: '', label: 'projected · ticket tracker' };
  }
  if (p.kind === 'ticketReturn') {
    if (p.date <= today) return { cls: 'overdue', label: p.date === today ? 'due today · tap to confirm' : 'not confirmed yet' };
    return { cls: '', label: 'projected · ring-fenced money back' };
  }
  if (p.skipped) return { cls: 'skipped', label: 'skipped' };
  if (p.date <= today) return { cls: 'overdue', label: p.date === today ? 'due today · tap to confirm' : 'not confirmed yet' };
  const from = p.amountSource === 'tracker' && p.amount === p.seriesAmount ? ' · ticket tracker'
    : p.amountSource === 'fallback' && p.amount === p.seriesAmount ? ' · estimate (no tracker figure)' : '';
  return { cls: '', label: (p.changed ? 'projected · changed for this month' : 'projected') + from };
}

// ------------------------------------------------------------------ card statements

function stmtLabel(month, account) {
  const d = statementDate(account, month, state.holidays);
  return d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : periodLabel(month);
}
/** "on the 18 Nov statement" tag for an entry whose statement isn't the one its date says. */
function stmtTagText(tag, month, account) {
  return `${tag === 'next' ? '⤵' : '⤴'} on the ${stmtLabel(month, account)} statement`;
}
/** The statement-payment recurring item for a card, if any. */
function statementItemFor(card) {
  return recurringItems(state.ledger).find((i) => statementCardFor(i, state.ledger.accounts)?.id === card.id) ?? null;
}
/** The next statement (on or after today) and the next payment not yet confirmed, for a card's header. */
function cardOutlook(card, view, today) {
  if (!statementConfig(card)) return null;
  let m = monthOf(today);
  if (statementDate(card, m, state.holidays) < today) m = addMonths(m, 1);
  const st = statementFor(view, card, m, state.holidays);
  const pay = view.transactions.find((t) => t.isProjected && t.accountId === card.id && t.projection?.statement && !t.skipped);
  return { st, pay };
}
function outlookText(card, o, short = false) {
  if (!o) return '';
  const parts = [];
  const day = (iso) => (short ? shortDate(iso) : new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));
  if (o.pay) parts.push(`${short ? 'Pay' : 'Next payment'} ${formatPence(o.pay.amount)} ${o.pay.date < todayIso() ? 'was due' : 'on'} ${day(o.pay.date)}`);
  if (o.st?.owed != null) parts.push(`${short ? 'Stmt' : 'Statement'} ${day(o.st.date)}: ${formatPence(o.st.owed)} so far`);
  return parts.join(' · ');
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
// v0.14: both engines share one sign-in request (lib/shared-auth.js)
const auth = shareTokenRequests(testHooks?.auth ?? googleAuth);
const syncDrive = testHooks?.drive ?? googleDrive;
const sync = createSyncEngine({
  auth,
  drive: syncDrive,
  store: {
    getLocal: () => state.personal,
    setLocal(ledger) {
      // a sync brought in changes from the other device
      state.personal = ledger;
      recombine();
      saveLedger(ledger).catch((err) => toast(`Couldn't save synced data: ${err.message}`, 'error'));
      render();
    },
    loadSyncState,
    saveSyncState,
  },
  afterSync: (token) => checkTracker(token),
});

// ---- v0.14 joint account: its own engine on its own file. Created only
// while the switch is on; with it off, none of this runs.
let jointSync = null;
function makeJointEngine() {
  const engine = createSyncEngine({
    auth,
    drive: syncDrive,
    folderName: JOINT_FOLDER_NAME,
    fileName: JOINT_FILE_NAME,
    store: {
      getLocal: () => state.joint,
      setLocal(ledger) {
        if (!state.jointSettings.enabled) return; // switched off mid-sync: leave the screen alone
        state.joint = ledger;
        recombine();
        saveJointLedger(ledger).catch((err) => toast(`Couldn't save the joint account’s synced data: ${err.message}`, 'error'));
        render();
        if (isOpen('settingsDialog')) renderSettings();
      },
      loadSyncState: loadJointSyncState,
      saveSyncState: saveJointSyncState,
    },
  });
  engine.onChange(renderSyncChip);
  return engine;
}
const jointActive = () => Boolean(state.jointSettings.enabled && jointSync);
/** A joint sync never throws into the personal one, and never blocks it. */
function runJointSync(opts) {
  if (!jointActive()) return Promise.resolve(null);
  return jointSync.sync(opts).catch((err) => { console.error(err); return { status: 'error' }; });
}

// ------------------------------------------------------------------ v0.11 ticket tracker figures

/**
 * Read the ticket tracker's published figures from Drive — only when an item
 * uses them, and at most every few minutes during ordinary syncs. A failure
 * keeps the last good figures; it's shown in ⚙ and in the editor.
 */
async function checkTracker(token, { force = false } = {}) {
  if (!usesTracker(state.ledger)) return;
  const last = state.tracker?.checkedAt ? Date.parse(state.tracker.checkedAt) : 0;
  if (!force && Date.now() - last < TRACKER_CHECK_MS) return;
  const before = JSON.stringify([state.tracker?.estimates ?? null, state.tracker?.error ?? null]);
  const rec = await refreshTrackerEstimates({ drive: syncDrive, token, cached: state.tracker });
  state.tracker = rec;
  try { await saveTrackerEstimates(rec); } catch { /* keeps working from memory this session */ }
  if (JSON.stringify([rec.estimates, rec.error]) !== before) {
    render();
    if (isOpen('recurringDialog')) renderRecurringManager();
  }
  if (isOpen('settingsDialog')) renderSettings();
}
/** "Check now" (a tap — may open Google's window). */
function checkTrackerFromTap() {
  sync.withSyncToken((token) => checkTracker(token, { force: true }), { interactive: true })
    .then(() => toast(state.tracker?.error ? state.tracker.error : 'Ticket tracker figures checked', state.tracker?.error ? 'error' : undefined))
    .catch((err) => toast(err.message, 'error'));
}
/** "Figures for Sep 2026 – Sep 2027 · shared by the tracker 6 Oct, 19:20" — or why there are none. */
function trackerStatusText() {
  const t = state.tracker;
  if (!sync.isEnabled()) return 'Needs Google Drive sync on — the figures are read from your Drive.';
  if (!t) return 'Not checked yet — it’s read on the next sync.';
  const parts = [];
  const e = t.estimates;
  if (e) parts.push(`Pay periods ${periodLabel(e.periods[0].paydayMonth)} – ${periodLabel(e.periods[e.periods.length - 1].paydayMonth)}, figures from ${when(e.generatedAt)} (the tracker only rewrites the file when they change).`);
  if (t.error) parts.push(e ? `Latest check: ${t.error} Still using the figures above.` : t.error);
  parts.push(`Checked ${when(t.checkedAt)}.`);
  return parts.join(' ');
}

let syncTimer = null;
/** Sync shortly after an edit, if signed in (never opens Google's window). */
function scheduleSync(delay = 4000) {
  if (!sync.isEnabled() && !jointActive()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncBoth, delay);
}
/** Background sync of both files (never opens Google's window). Joint runs on its own; its problems stay on its own status. */
function syncBoth() {
  const personal = sync.sync().then(afterSync);
  runJointSync().then((r) => afterJointSync(r));
  return personal;
}

/** Tap-driven sync: the only path that may open Google's sign-in window. */
function syncFromTap() {
  const st = sync.getState();
  if (st.status === 'conflicts') { openConflictDialog(sync); return; }
  if (jointActive() && jointSync.getState().status === 'conflicts') { openConflictDialog(jointSync); return; }
  // Both start right here in the tap; they share one sign-in request.
  const personal = sync.sync({ interactive: true });
  if (!jointActive()) { personal.then((r) => afterSync(r, true)); return; }
  const joint = runJointSync({ interactive: true });
  Promise.all([personal, joint]).then(([p, j]) => afterBothFromTap(p, j));
}

/** v0.14: what one file's sync came to, in a few words. */
function syncResultText(result, engine) {
  switch (result?.status) {
    case 'pushed': case 'merged': case 'unchanged': case 'pulled': return 'synced';
    case 'off': return 'sync is off';
    case 'needs-tap': return auth.lastAuthError?.() ?? 'sign-in didn’t complete';
    case 'conflicts': return 'a clash to sort out';
    case 'error': return engine.getState().lastError ?? 'failed';
    default: return result?.status ?? 'not synced';
  }
}
function afterBothFromTap(p, j) {
  if (p?.status === 'conflicts') { openConflictDialog(sync); return; }
  if (j?.status === 'conflicts') { openConflictDialog(jointSync); return; }
  const bad = (r) => r && ['needs-tap', 'error'].includes(r.status);
  const text = `Personal: ${syncResultText(p, sync)} · Joint: ${syncResultText(j, jointSync)}`;
  toast(text, bad(p) || bad(j) ? 'error' : 'ok');
}
function afterJointSync(result, fromTap = false) {
  if (result?.status === 'conflicts' && (fromTap || !document.querySelector('dialog[open]'))) openConflictDialog(jointSync);
}

function afterSync(result, fromTap = false) {
  if (!result) return;
  if (result.status === 'conflicts') { if (fromTap || !document.querySelector('dialog[open]')) openConflictDialog(sync); return; }
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

/** v0.14: the joint file's state as a coloured people-icon dot on the chip. */
function jointDotModel(st) {
  if (st.status === 'conflicts') return { kind: 'red', text: 'a clash to sort out' };
  if (st.status === 'error') return { kind: 'red', text: st.lastError ?? 'sync failed' };
  if (st.status === 'syncing') return { kind: 'busy', text: 'syncing' };
  if (!st.enabled) return { kind: 'amber', text: 'not connected' };
  if (!st.hasToken || st.status === 'needs-tap') return { kind: 'amber', text: st.dirty ? 'changes waiting — tap to sync' : 'tap to sync' };
  if (st.dirty) return { kind: 'amber', text: 'syncing soon' };
  return { kind: 'green', text: `synced ${syncTime(st.lastSyncAt)}` };
}

function renderSyncChip() {
  const chip = $('syncChip');
  const jst = jointActive() ? jointSync.getState() : null;
  let model = syncChipModel(sync.getState());
  if (!model && jst) model = syncChipModel({ ...jst, enabled: true }); // personal sync off, joint on
  if (jst?.status === 'conflicts') model = { label: 'Check clash', kind: 'warn' };
  $('unexportedDot').hidden = sync.isEnabled() || !hasUnexported();
  chip.hidden = !model;
  if (!model) return;
  chip.className = `sync-chip sync-${model.kind}${jst ? ' has-joint' : ''}`;
  // static icon markup (no user data), so innerHTML is safe here
  chip.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96Z"/></svg>';
  // v0.14: "Synced" is a separate word so the narrowest phones can drop it when the joint dot shows
  const synced = /^Synced /.test(model.label);
  chip.append(h('span', { class: 'sync-label' }, synced ? [h('span', { class: 'sync-word' }, 'Synced '), model.label.slice(7)] : model.label));
  if (model.dot) chip.append(h('span', { class: 'sync-dot', 'aria-hidden': 'true' }));
  let aria = `Google Drive sync: ${model.label}`;
  if (jst) {
    const d = jointDotModel(jst);
    const dot = h('span', { class: `sync-joint sync-joint-${d.kind}`, title: `Joint account: ${d.text}` });
    dot.innerHTML = PEOPLE_SVG(12);
    chip.append(dot);
    aria += `. Joint account: ${d.text}`;
  }
  chip.setAttribute('aria-label', aria);
  const line = $('driveStatusLine');
  if (line) line.textContent = driveStatusText();
  const jline = $('jointStatusLine');
  if (jline) jline.textContent = jointStatusText();
}

/** v0.14: people icon (static markup) for the joint account. */
function PEOPLE_SVG(size = 14) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true"><path fill="currentColor" d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3Zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3Zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13Zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5Z"/></svg>`;
}
function peopleIcon(size = 14, cls = 'people-icon') {
  const el = h('span', { class: cls, 'aria-hidden': 'true' });
  el.innerHTML = PEOPLE_SVG(size);
  return el;
}

function jointStatusText() {
  if (!jointActive()) return '';
  const st = jointSync.getState();
  const parts = [st.lastSyncAt ? `Last synced ${when(st.lastSyncAt)}` : 'Not synced yet'];
  if (st.status === 'error' && st.lastError) parts.push(st.lastError);
  else if (st.status === 'conflicts') parts.push('a clash to sort out — tap the cloud button');
  else if (st.dirty) parts.push('changes on this device waiting to sync');
  if (!st.hasToken) parts.push('sign-in expired — tap the cloud button to continue');
  return parts.join(' · ');
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
    return `${r.name} · ${showsOwed(r) ? 'owed' : 'opening'} ${formatPence(displayOpening(r))} from ${shortDate(r.openingDate)}${r.active ? '' : ' (hidden)'}`;
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

function openConflictDialog(engine = sync) {
  const st = engine.getState();
  const isJoint = engine === jointSync && engine !== null;
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
      h('h2', {}, isJoint ? peopleIcon(18) : null, `${isJoint ? 'Joint account: ' : ''}${groups.length === 1 ? 'one change clashes' : `${groups.length} changes clash`}`.replace(/^./, (c) => c.toUpperCase())),
      h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    h('p', { class: 'muted small' }, 'These were changed differently on this device and on another device since they last synced. Everything else has already been combined. Choose which version to keep:'),
    cards,
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn-secondary', onclick: () => dlg.close() }, 'Decide later'),
      h('button', {
        type: 'button', class: 'btn-primary',
        onclick: async () => {
          dlg.close();
          const r = await engine.resolveConflicts(choices);
          toast(r?.status === 'needs-tap' ? 'Saved here — tap the sync button to send to Drive' : 'Clash resolved');
        },
      }, 'Keep these'))));
  openDialog(dlg);
}

// ------------------------------------------------------------------ commit

/**
 * Save a change made to the display ledger. v0.14: with the joint account on,
 * it is split back into the personal and joint ledgers (lib/joint.js) and
 * only a ledger that really changed is saved. A change that would link the two
 * files is refused before anything is stored.
 */
async function commit(nextLedger, message) {
  let parts;
  try {
    parts = state.joint
      ? splitLedger(nextLedger, { personal: state.personal, joint: state.joint })
      : { personal: nextLedger, joint: null, personalChanged: true, jointChanged: false };
  } catch (err) {
    toast(`Couldn't save: ${err.message}`, 'error');
    return;
  }
  return commitParts({ personal: parts.personalChanged ? parts.personal : null, joint: parts.jointChanged ? parts.joint : null }, message);
}
function restoreParts(p) {
  state.personal = p.personal;
  state.joint = p.joint;
  recombine();
}
/** Save whichever real ledgers are given (null = unchanged), then redraw and sync. */
async function commitParts({ personal = null, joint = null }, message) {
  const previous = { personal: state.personal, joint: state.joint };
  if (personal) state.personal = personal;
  if (joint) state.joint = joint;
  recombine();
  let personalSaved = false;
  try {
    if (personal) { await saveLedger(personal); personalSaved = true; }
    if (joint) await saveJointLedger(joint);
  } catch (err) {
    // Only a failure to STORE the data is "couldn't save" — and only then is
    // the change taken back off the screen. (A personal save that worked
    // before a joint one failed is kept: it is on the device.)
    restoreParts({ personal: personalSaved ? personal : previous.personal, joint: previous.joint });
    try { render(); } catch (e) { console.error(e); }
    toast(`Couldn't save: ${err.message}`, 'error');
    return;
  }
  // ---- stored.
  // v0.13.2: saved. From here on a problem only affects the screen — the change
  // stays (on screen and on the device) and still goes to Drive.
  let screenError = null;
  for (const step of [
    () => render(),
    () => { if (isOpen('envelopeDialog')) renderEnvelopeDialog(); },
    () => renderSyncChip(),
  ]) {
    try { step(); } catch (err) { screenError ??= err; console.error(err); }
  }
  scheduleSync();
  if (screenError) toast(`Saved — but the screen didn’t refresh properly (${screenError.message}). Reload the app.`, 'error');
  else if (message) toast(message);
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

  if (!state.personal.accounts.length) {
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
  // coming back to the phone list from the grid: open it at today again
  if (!isGrid() && state.lastRenderWasGrid) state.listScrollToToday = true;
  state.lastRenderWasGrid = isGrid();
  if (isGrid()) {
    $('fab').hidden = true;
    renderGrid(accounts);
  } else if (state.summary) {
    $('fab').hidden = true; // Summary doesn't know which account to add to
    renderSummary(accounts);
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
      commitParts({ personal: ledger }, 'Accounts created'); // first run: always your own file
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

/** Phone tab row: v0.14 Summary first, then each account. */
function accountTabs(accounts) {
  const summaryTab = h('button', {
    type: 'button', role: 'tab', class: `tab tab-summary ${state.summary ? 'tab-active' : ''}`, 'aria-selected': String(state.summary),
    onclick: () => { state.summary = true; state.listScrollToToday = true; render(); },
  }, (() => { const i = h('span', { class: 'summary-icon', 'aria-hidden': 'true' }); i.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/></svg>'; return i; })(),
  h('span', { class: 'tab-name' }, 'Summary'));
  return h('nav', { class: 'tabs', role: 'tablist' },
    summaryTab,
    accounts.map((a) => {
      const on = !state.summary && a.id === state.activeAccountId;
      return h('button', {
        type: 'button', role: 'tab', class: `tab ${on ? 'tab-active' : ''}`,
        'aria-selected': String(on),
        style: { '--acc': institutionStyle(a.institution).colour },
        onclick: () => openAccountTab(a.id),
      }, swatch(a), h('span', { class: 'tab-name' }, a.name));
    }));
}
function openAccountTab(id) {
  state.summary = false;
  state.activeAccountId = id;
  state.listScrollToToday = true;
  render();
}

/**
 * The coloured header card for an account: today's balance, end of month,
 * limit warnings, the card's statement line and envelope chips. On the
 * account's own page it has the Account… / Reconcile… buttons; on the v0.14
 * Summary it shows the account's name instead and tapping it opens the account.
 */
function bannerCard(active, view, today, { summary = false } = {}) {
  const style = institutionStyle(active.institution);
  // Same split as the grid header: today's balance (confirmed entries only),
  // plus where it will be at the end of the current calendar month (projected
  // recurring entries too, including any overdue, unconfirmed ones).
  const bal = balanceAsOf(state.ledger, active, today);
  const eomIso = endOfMonthIso(today);
  const eomBal = balanceAsOf(view, active, eomIso);
  const open = () => openAccountTab(active.id);
  return h('section', {
    class: `banner ${summary ? 'banner-summary' : ''}`, style: { '--acc': style.colour, '--ink': style.ink },
    ...(summary ? {
      role: 'button', tabindex: '0', 'aria-label': `Open ${active.name}`, dataset: { summaryFor: active.id },
      // the statement line and envelope chips keep their own taps
      onclick: (e) => { if (!e.target.closest('button')) open(); },
      onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); open(); } },
    } : {}),
  },
    style.accent ? h('div', { class: 'banner-accent', style: { background: style.accent } }) : null,
    summary ? h('div', { class: 'banner-name' }, style.icon === 'people' ? peopleIcon(15) : null, active.name) : null,
    h('div', { class: 'banner-label' }, !summary && style.icon === 'people' ? peopleIcon(14) : null, showsOwed(active) ? 'Owed today' : 'Balance today'),
    h('div', { class: `banner-amount ${bal < 0 ? 'neg' : ''}` }, formatPence(bal)),
    h('div', { class: 'banner-eom' }, `${showsOwed(active) ? 'Owed ' : ''}${formatPence(eomBal)} at end of ${monthYearLabel(eomIso)}`),
    (() => { const w = limitHeaderText(active, view); return w ? h('div', { class: `banner-lim ${w.cls}` }, w.text) : null; })(),
    (() => {
      const o = cardOutlook(active, view, today);
      if (!o) return null;
      return h('button', { type: 'button', class: 'banner-stmt', onclick: () => openStatementDialog(active.id, o.st.month) }, outlookText(active, o), ' ›');
    })(),
    summary
      ? h('div', { class: 'banner-open', 'aria-hidden': 'true' }, '›')
      : h('div', { class: 'banner-btns' },
          h('button', { type: 'button', class: 'banner-edit', onclick: () => openAccountDialog(active.id) }, 'Account…'),
          h('button', { type: 'button', class: 'banner-edit banner-rec', onclick: () => openReconcileDialog(active.id) }, 'Reconcile…')),
    envBannerBlock(active, today));
}

/** v0.14 phone landing page: every visible account's header card. */
function renderSummary(accounts) {
  const view = viewLedger();
  const today = todayIso();
  const wrap = h('div', { class: 'list-view summary-view' },
    accountTabs(accounts),
    h('div', { class: 'summary' }, accounts.map((a) => bannerCard(a, view, today, { summary: true }))));
  addSwipe(wrap, accounts);
  app.replaceChildren(wrap);
  wrap.querySelector('.tab-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (state.listScrollToToday) {
    state.listScrollToToday = false;
    requestAnimationFrame(() => window.scrollTo(0, 0));
  }
}

function renderList(accounts) {
  const active = accountById(state.activeAccountId);
  const tabs = accountTabs(accounts);
  const view = viewLedger();
  const banner = bannerCard(active, view, todayIso());

  // Oldest first, same order as the grid: future entries at the bottom.
  const running = accountRunning(view, active);
  const today = todayIso();
  const feed = h('ul', { class: 'feed' });
  feed.append(h('li', { class: 'day', dataset: { date: active.openingDate } }, longDate(active.openingDate)),
    h('li', {}, h('div', { class: 'entry entry-note' },
      h('span', { class: 'entry-main' }, h('span', { class: 'entry-desc' }, 'Brought forward')),
      h('span', { class: 'entry-amts' }, h('span', { class: 'entry-bal' }, formatPence(displayOpening(active)))))));
  let lastDate = active.openingDate;
  for (const { transaction: t, runningBalance } of running) {
    if (t.date !== lastDate) {
      lastDate = t.date;
      feed.append(h('li', { class: `day ${t.date > today ? 'future' : ''}`, dataset: { date: t.date } }, longDate(t.date), t.date > today ? ' · upcoming' : ''));
    }
    if (t.isStatement) {
      const st = t.statement;
      feed.append(h('li', {}, h('button', {
        type: 'button', class: `entry entry-stmt ${st.date > today ? 'future' : ''}`,
        onclick: () => openStatementDialog(active.id, st.month),
      },
        h('span', { class: 'entry-main' },
          h('span', { class: 'entry-desc' }, h('span', { class: 'desc-text' }, st.date > today ? 'Statement (estimate)' : 'Statement')),
          h('span', { class: 'entry-link' }, `Payment due ${longDate(st.dueDate)}`)),
        h('span', { class: 'entry-amts' },
          h('span', { class: 'entry-amt' }, formatPence(st.owed)),
          h('span', { class: 'entry-bal muted' }, 'owed')))));
      continue;
    }
    const other = counterpartOf(view, t);
    const otherAcc = other ? accountById(other.accountId) : null;
    const p = t.isProjected ? t.projection : null;
    const tags = p ? projectionTags(p, today) : t.ticketAlert ? { cls: 'alert', label: ALERT_MISSING } : null;
    const env = envTag(t, active);
    const move = isEnvelopeMove(t);
    feed.append(h('li', {},
      h('button', {
        type: 'button',
        class: `entry ${t.kind === 'note' ? 'entry-note' : ''} ${t.date > today ? 'future' : ''} ${p ? 'projected' : ''} ${tags?.cls ?? ''} ${!p?.skipped && t.kind !== 'note' && limitClass(active, runningBalance) ? 'lim-row' : ''}`,
        onclick: () => (p ? openProjection(p) : openTxDialog({ txId: t.id })),
      },
        h('span', { class: 'entry-main' },
          h('span', { class: 'entry-desc' }, p ? h('span', { class: 'rec-icon', 'aria-label': p.itemId ? 'Recurring' : 'Ticket purchases' }, p.itemId ? '↻ ' : p.kind === 'ticketReturn' ? '🔒 ' : '🎟 ') : null,
            h('span', { class: 'desc-text' }, t.description || '(no description)'),
            t.seriesNo ? h('span', { class: 'series-no' }, numberLabel(t.seriesNo)) : null),
          otherAcc || tags || t.stmtTag || env ? h('span', { class: 'entry-link' },
            otherAcc ? `${t.direction === 'debit' ? '→' : '←'} ${otherAcc.name}` : '',
            otherAcc && tags ? ' · ' : '',
            tags ? h('span', { class: 'rec-tag' }, tags.label) : null,
            t.stmtTag ? h('span', { class: 'stmt-tag' }, (otherAcc || tags ? ' · ' : '') + stmtTagText(t.stmtTag, t.stmtMonth, active)) : null,
            env ? h('span', { class: `env-tag ${env.cls}` }, (otherAcc || tags || t.stmtTag ? ' · ' : '') + env.text) : null) : null),
        move
          ? h('span', { class: 'entry-amt muted' }, 'move')
          : t.kind === 'note'
          ? h('span', { class: 'entry-amt muted' }, 'note')
          : h('span', { class: 'entry-amts' },
              h('span', { class: `entry-amt ${t.direction}` }, isReconciled(t) ? h('span', { class: 'rec-tick', title: 'Reconciled' }, '✓ ') : null, `${t.direction === 'credit' ? '+' : '−'}${formatPence(t.amount)}`),
              h('span', { class: `entry-bal ${runningBalance < 0 && !showsOwed(active) ? 'neg' : ''} ${p?.skipped ? '' : limitClass(active, runningBalance)}` }, p?.skipped ? 'skipped' : formatPence(runningBalance))))));
  }
  const more = horizonControl('horizon-list');
  if (more) feed.append(h('li', { class: 'horizon-li' }, more));

  const wrap = h('div', { class: 'list-view' }, tabs, banner, feed);
  addSwipe(wrap, accounts);
  app.replaceChildren(wrap);
  tabs.querySelector('.tab-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  // On opening (and switching account), jump to today's first entry — or,
  // if nothing is dated today, the most recent day before it. Ordinary
  // redraws (after a save, a sync) leave the scroll where it is.
  if (state.listScrollToToday) {
    state.listScrollToToday = false;
    const target = [...feed.querySelectorAll('li.day[data-date]')].filter((li) => li.dataset.date <= today).pop();
    requestAnimationFrame(() => {
      if (target) target.scrollIntoView({ block: 'start' });
      else window.scrollTo(0, 0);
    });
  }
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
    // v0.14: Summary sits before the first account
    const i = state.summary ? -1 : accounts.findIndex((a) => a.id === state.activeAccountId);
    const j = i + (dx < 0 ? 1 : -1);
    if (j === -1) { state.summary = true; state.listScrollToToday = true; render(); }
    else if (j >= 0 && j < accounts.length) openAccountTab(accounts[j].id);
  });
}

// ---- desktop grid

let gridHeadObserver = null;
function renderGrid(accounts) {
  const prevWrap = app.querySelector('.grid-wrap');
  const keepScroll = prevWrap ? { top: prevWrap.scrollTop, left: prevWrap.scrollLeft } : null;

  const view = viewLedger();
  const rows = buildGridRows(view, accounts);
  const today = todayIso();
  const reconciledIds = new Set(state.ledger.transactions.filter(isReconciled).map((t) => t.id));
  const alertIds = new Set(view.transactions.filter((t) => t.ticketAlert).map((t) => t.id));
  const envAccounts = accounts.filter((a) => envelopeConfig(a));
  const txById = envAccounts.length ? new Map(view.transactions.map((t) => [t.id, t])) : null;
  /** envelope tag for a grid row: from its leg on the envelope account */
  const rowEnvTag = (row) => {
    for (const a of envAccounts) {
      const tx = row.cells[a.id] && txById.get(row.cells[a.id].txId);
      if (tx) return envTag(tx, a);
    }
    return null;
  };

  const head1 = h('tr', {},
    h('th', { class: 'sticky-l c-date', rowspan: '2' }, 'Date'),
    h('th', { class: 'sticky-l2 c-desc', rowspan: '2' }, 'Description'),
    accounts.map((a) => {
      const s = institutionStyle(a.institution);
      const todayBal = balanceAsOf(state.ledger, a, today);
      return h('th', { colspan: '3', class: 'acc-head', dataset: { accHead: a.id }, style: { '--acc': s.colour, '--ink': s.ink } },
        h('div', { class: 'acc-bar', style: { background: s.colour } }, s.accent ? h('span', { class: 'acc-bar-accent', style: { background: s.accent } }) : null),
        h('div', { class: 'acc-title' },
          h('button', { type: 'button', class: 'btn-link acc-name', title: 'Edit account', onclick: () => openAccountDialog(a.id) }, s.icon === 'people' ? peopleIcon(14) : null, a.name),
          h('span', { class: 'acc-btns' },
            h('button', { type: 'button', class: 'acc-rec', title: `Reconcile ${a.name}`, 'aria-label': `Reconcile ${a.name}`, onclick: () => openReconcileDialog(a.id) }, '✓'),
            h('button', { type: 'button', class: 'acc-add', title: `Add entry to ${a.name}`, onclick: () => openTxDialog({ accountId: a.id }) }, '+'))),
        h('div', { class: `acc-total ${todayBal < 0 ? 'neg' : ''}` }, `${showsOwed(a) ? 'Owed ' : ''}${formatPence(todayBal)}`),
        h('div', { class: 'acc-eom', dataset: { eomFor: a.id } }),
        (() => { const w = limitHeaderText(a, view); return w ? h('div', { class: `acc-lim ${w.cls}`, title: 'From today to the end of what’s shown' }, w.text) : null; })(),
        envHeaderBlock(a, today),
        (() => {
          const o = cardOutlook(a, view, today);
          return o ? h('button', { type: 'button', class: 'btn-link acc-stmt', title: outlookText(a, o), onclick: () => openStatementDialog(a.id, o.st.month) }, outlookText(a, o, true)) : null;
        })());
    }));
  const head2 = h('tr', {}, accounts.map(() => [h('th', { class: 'num sub' }, 'Credit'), h('th', { class: 'num sub' }, 'Debit'), h('th', { class: 'num sub bal-col' }, 'Balance')]));

  const body = h('tbody', {});
  const openingDate = accounts.map((a) => a.openingDate).sort()[0];
  body.append(h('tr', { class: 'row-bf', dataset: { date: openingDate } },
    h('td', { class: 'sticky-l c-date' }, shortDate(openingDate)),
    h('td', { class: 'sticky-l2 c-desc' }, 'Brought forward'),
    accounts.map((a) => [h('td', {}), h('td', {}), h('td', { class: 'num bal-col' }, formatPence(displayOpening(a)))])));

  // a line across the grid where a new calendar month starts
  let prevMonth = openingDate.slice(0, 7);
  for (const row of rows) {
    const future = row.date > today;
    const monthStart = row.date.slice(0, 7) !== prevMonth ? 'month-start' : '';
    prevMonth = row.date.slice(0, 7);
    if (row.statement) {
      const st = row.statement;
      const cardId = Object.keys(row.cells)[0];
      const card = accountById(cardId);
      const openStmt = () => openStatementDialog(cardId, st.month);
      // the whole row tinted with a dimmed shade of the card's colour
      const tr = h('tr', {
        class: `row-stmt ${monthStart} ${future ? 'future' : ''} ${row.date === today ? 'is-today' : ''}`,
        dataset: { date: row.date }, style: { '--stmt': institutionStyle(card.institution).colour },
      },
        h('td', { class: 'sticky-l c-date clickable', onclick: openStmt }, shortDate(row.date)),
        h('td', { class: 'sticky-l2 c-desc clickable', onclick: openStmt, title: `${card.name} statement — payment due ${longDate(st.dueDate)}` },
          `▤ ${card.name} statement${future ? ' (estimate)' : ''}`));
      for (const a of accounts) {
        const bal = row.balances[a.id];
        if (a.id === cardId) tr.append(h('td', { class: 'num clickable stmt-cell', colspan: '2', onclick: openStmt }, `${formatPence(st.owed, { symbol: false })} owed`));
        else tr.append(h('td', {}), h('td', {}));
        tr.append(h('td', { class: `num bal-col bal-carried ${bal < 0 ? 'neg' : ''}` }, formatPence(bal, { symbol: false })));
      }
      body.append(tr);
      continue;
    }
    const p = row.projection;
    const alert = !p && row.txIds.some((id) => alertIds.has(id));
    const tags = p ? projectionTags(p, today) : alert ? { cls: 'alert', label: ALERT_MISSING } : null;
    const openRow = () => (p ? openProjection(p) : openTxDialog({ txId: row.txIds[0] }));
    const env = rowEnvTag(row);
    const tr = h('tr', {
      class: `${monthStart} ${row.kind === 'note' ? 'row-note' : ''} ${future ? 'future' : ''} ${row.date === today ? 'is-today' : ''} ${p ? 'projected' : ''} ${tags?.cls ?? ''}`,
      dataset: { date: row.date },
    },
      h('td', { class: 'sticky-l c-date clickable', onclick: openRow }, shortDate(row.date)),
      h('td', { class: 'sticky-l2 c-desc clickable', title: `${row.description}${row.seriesNo ? ` ${numberLabel(row.seriesNo)}` : ''}${p ? ` — ${tags.label}` : ''}`, onclick: openRow },
        p ? h('span', { class: 'rec-icon', title: `${p.itemId ? 'Recurring' : 'Ticket purchases'} — ${tags.label}` }, p.itemId ? '↻ ' : p.kind === 'ticketReturn' ? '🔒 ' : '🎟 ') : null,
        row.isTransfer ? h('span', { class: 'link-icon', title: 'Linked transfer' }, '⇄ ') : null, row.description,
        row.seriesNo ? h('span', { class: 'series-no' }, ` ${numberLabel(row.seriesNo)}`) : null,
        row.stmtTag ? h('span', { class: 'stmt-tag' }, ` ${stmtTagText(row.stmtTag.tag, row.stmtTag.month, accountById(Object.keys(row.cells).find((id) => statementConfig(accountById(id)))) ?? accounts[0])}`) : null,
        env ? h('span', { class: `env-tag ${env.cls}` }, ` · ${env.text}`) : null,
        tags && (p ? !p.itemId && tags.cls : true) ? h('span', { class: tags.cls === 'alert' ? 'alert-tag' : 'rec-tag' }, ` · ${tags.label}`) : null));
    for (const a of accounts) {
      const cell = row.cells[a.id];
      const rec = cell?.txId && reconciledIds.has(cell.txId) ? ' is-rec' : '';
      const open = (direction) => () =>
        p ? openRow() : cell ? openTxDialog({ txId: cell.txId }) : openTxDialog({ accountId: a.id, date: row.date, direction });
      const bal = row.balances[a.id];
      tr.append(
        h('td', { class: `num clickable cell${cell?.credit != null ? rec : ''}`, onclick: open('credit'), title: cell?.credit != null && rec ? 'Reconciled' : null }, cell?.credit != null ? formatPence(cell.credit, { symbol: false }) : cell?.note ? '·' : ''),
        h('td', { class: `num clickable cell${cell?.debit != null ? rec : ''}`, onclick: open('debit'), title: cell?.debit != null && rec ? 'Reconciled' : null }, cell?.debit != null ? formatPence(cell.debit, { symbol: false }) : ''),
        h('td', { class: `num bal-col ${cell ? 'bal-changed' : 'bal-carried'} ${bal < 0 ? 'neg' : ''} ${cell ? limitClass(a, bal) : limitClass(a, bal).replace('lim-', 'lim-text-')}`, title: balanceLevel(a, bal) ? `${a.name}: ${LEVELS[balanceLevel(a, bal)].label}` : null }, formatPence(bal, { symbol: false })));
    }
    body.append(tr);
  }

  const more = horizonControl('horizon-grid');
  if (more) body.append(h('tr', { class: 'row-more' }, h('td', { class: 'sticky-l', colspan: String(2 + accounts.length * 3) }, more)));

  const table = h('table', { class: 'grid' }, h('thead', {}, head1, head2), body);
  const wrap = h('div', { class: 'grid-wrap' }, table);
  app.replaceChildren(
    h('div', { class: 'grid-view' },
      h('p', { class: 'grid-hint muted small' }, 'Click an empty Credit/Debit cell to add to that account on that date · click a value or description to edit · ⇄ = linked transfer · ↻ = recurring, click to confirm · ▤ = card statement, click to check it · ✓ = reconciled (✓ button in a header to reconcile)', envAccounts.length ? ' · envelope balances under a header: click for each envelope' : ''),
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
      el.textContent = `${showsOwed(a) ? 'Owed ' : ''}${formatPence(eomBal)} at end of ${label}`;
      el.classList.toggle('neg', eomBal < 0);
    }
    setHead1(); // the text just changed — the header row may now be a different height
  }

  // The Credit/Debit/Balance row sticks just under the account headers, whose
  // height depends on their content. v0.14: measured AFTER the "…at end of"
  // lines are filled in (measuring before them left that row a line too high
  // once scrolled, when a card statement or envelope line made the header
  // taller than its 92px minimum), and again whenever the header resizes.
  let head1Px = 0;
  function setHead1() {
    const px = Math.ceil(head1.getBoundingClientRect().height);
    if (px && px !== head1Px) { head1Px = px; table.style.setProperty('--head1', `${px}px`); }
  }
  gridHeadObserver?.disconnect(); // the previous redraw's header is gone
  gridHeadObserver = 'ResizeObserver' in window ? new ResizeObserver(setHead1) : null;
  gridHeadObserver?.observe(head1);

  let scrollQueued = false;
  wrap.addEventListener('scroll', () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; updateMonthInView(); });
  });

  requestAnimationFrame(() => {
    updateMonthInView(); // fills the "…at end of" lines, then measures the header (setHead1)
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
  if (isEnvelopeMove(existing)) return openMoveDialog({ txId: existing.id });
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

  const others = sameFileAccounts(account.id).filter((a) => a.id !== account.id && a.active); // v0.14: never across the two files
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

  // Which card statement it's on — offered only near a statement date (statements.js)
  const hasStatements = Boolean(statementConfig(account));
  let stmtChoice = existing?.statementMonth ?? null; // null = whichever its date says
  let stmtShown = null; // the boundaryChoice currently offered
  const stmtSeg = h('div', { class: 'seg', role: 'radiogroup' });
  const stmtHint = h('div', { class: 'muted small' });
  const stmtField = h('div', { class: 'field stmt-choice', hidden: true }, h('span', {}, 'Which statement is it on?'), stmtSeg, stmtHint);
  function syncStatement() {
    stmtShown = hasStatements && kind !== 'note' ? boundaryChoice(account, date.value, state.holidays) : null;
    stmtField.hidden = !stmtShown;
    if (!stmtShown) return;
    const chosen = stmtShown.options.includes(stmtChoice) ? stmtChoice : stmtShown.byDate;
    stmtSeg.replaceChildren(...stmtShown.options.map((m, i) => h('button', {
      type: 'button', role: 'radio', class: 'seg-btn', 'aria-checked': String(m === chosen),
      onclick: () => { stmtChoice = m; syncStatement(); },
    }, `${i === 0 ? 'This' : 'Next'} · ${stmtLabel(m, account)}`)));
    const onDay = date.value === statementDate(account, stmtShown.near, state.holidays);
    stmtHint.textContent = onDay
      ? 'Statement day — something bought today sometimes only shows on the next statement. Change it later if the real statement disagrees.'
      : `Close to the ${stmtLabel(stmtShown.near, account)} statement — check which one it really appears on.`;
  }
  /** statementMonth to save: null = by date. Kept as is if the date didn't change and no choice is offered. */
  function statementMonthToSave() {
    if (!stmtShown) return existing && date.value === existing.date ? existing.statementMonth ?? null : null;
    const chosen = stmtShown.options.includes(stmtChoice) ? stmtChoice : stmtShown.byDate;
    return chosen === statementMonthByDate(account, date.value, state.holidays) ? null : chosen;
  }

  // v0.12 envelopes: for this entry, or for the other leg of a transfer into/out of the envelope account
  const envTarget = () => {
    if (kind === 'note') return null;
    if (envelopeConfig(account)) return account;
    const other = accountById(existing ? counterpart?.accountId : counterpartSelect.value);
    return envelopeConfig(other) ? other : null;
  };
  const picker = envelopePicker({ getAmount: () => parseAmount(amount.value) });
  function syncEnvelope() {
    const target = envTarget();
    picker.el.hidden = !target;
    if (!target) return;
    if (target.id !== picker.accountId) {
      const initial = !existing ? null : target.id === account.id ? existing.envelopeSplits : counterpart?.envelopeSplits;
      picker.setAccount(target, initial ?? null);
    }
    picker.refresh();
  }
  amount.addEventListener('input', () => picker.refresh());
  counterpartSelect.addEventListener('change', syncEnvelope);
  counterpartSelect.addEventListener('change', () => syncKind());

  /** v0.14: a transfer can't take money out of a loan account — those choices are greyed out. */
  function syncLoanChoices() {
    for (const o of counterpartSelect.options) {
      if (!o.value) continue;
      const other = accountById(o.value);
      o.disabled = (isLoan(account) && kind === 'debit') || (isLoan(other) && kind === 'credit');
    }
    if (counterpartSelect.selectedOptions[0]?.disabled) counterpartSelect.value = '';
  }
  function syncKind() {
    for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.value === kind));
    syncLoanChoices();
    if (rfField) rfField.hidden = kind !== 'debit' || (!existing && Boolean(counterpartSelect.value));
    amountField.hidden = kind === 'note';
    if (counterpartField && !existing) counterpartField.hidden = kind === 'note';
    updateCounterpartHint();
    syncStatement();
    syncEnvelope();
  }
  function updateCounterpartHint() {
    const other = accountById(counterpartSelect.value);
    if (!other) {
      counterpartHint.textContent = isLoan(account) && kind === 'debit'
        ? 'Money can’t be transferred out of a loan account — a charge or interest is fine as it is.'
        : 'e.g. a card payment from this account, or money moved between accounts.';
      return;
    }
    const oppositeDir = kind === 'credit' ? 'debit' : 'credit';
    counterpartHint.textContent = `Adds a matching ${oppositeDir} of the same amount to ${other.name} — one row in the grid.`;
  }
  function checkDate() {
    dateWarn.hidden = !(date.value && date.value < account.openingDate);
    dateWarn.textContent = `Before this account's opening date (${longDate(account.openingDate)}) — it will still count towards the balance.`;
  }
  counterpartSelect.addEventListener('change', updateCounterpartHint);
  date.addEventListener('input', checkDate);
  date.addEventListener('input', syncStatement);
  date.addEventListener('change', syncStatement);

  // Pick a previous description -> prefill amount/direction/transfer if still blank (new entries only)
  desc.addEventListener('change', () => {
    if (existing) return;
    const prev = recentDescriptions(account.id).find((d) => d.description.toLowerCase() === desc.value.trim().toLowerCase());
    if (!prev) return;
    kind = prev.kind === 'note' ? 'note' : prev.direction;
    if (!amount.value && prev.kind !== 'note') amount.value = penceToInput(prev.amount);
    if (prev.counterpartAccountId && others.some((a) => a.id === prev.counterpartAccountId)) counterpartSelect.value = prev.counterpartAccountId;
    syncKind();
    if (prev.envelopeId && !picker.el.hidden) picker.setSingle(prev.envelopeId);
  });

  const amountField = h('label', { class: 'field' }, h('span', {}, 'Amount (£)'), amount);
  const s = institutionStyle(account.institution);

  // v0.13 ticket purchases: ring-fence a card spend (Transport envelope → Safe keeping), and notes on linked entries
  const tset = ticketSettings(state.ledger);
  const rfPossible = Boolean(tset && account.id === tset.cardAccountId && !(existing && existing.transferId));
  const rfBox = h('input', { type: 'checkbox', checked: existing ? isRingFenced(state.ledger, existing.id) : false });
  const rfField = rfPossible ? (() => {
    const envAcc = accountById(tset.envelopeAccountId);
    const envName = envelopeList(envAcc, { includeHidden: true }).find((e) => e.id === tset.envelopeId)?.name ?? 'envelope';
    return h('div', { class: 'field' },
      h('label', { class: 'check' }, rfBox, h('span', {}, 'Ring-fence it')),
      h('div', { class: 'muted small' }, `Moves the same amount from ${envName} (${envAcc.name}) to ${accountById(tset.safeAccountId).name} on the same day; it goes back before the card is paid.`));
  })() : null;
  const rfShown = () => Boolean(rfField) && !rfField.hidden;
  const rfCard = existing?.ringFenceOf ? state.ledger.transactions.find((t) => t.id === existing.ringFenceOf) : null;
  const ticketNote = existing?.ticketId
    ? h('div', { class: 'linked' }, `🎟 Ticket from the ticket tracker (${existing.ticketId.replace(/^p-/, 'valid from ')}). Deleting it puts the “Bought — confirm” row back.`)
    : existing?.ringFenceOf
      ? h('div', { class: 'linked' }, '🔒 Ring-fence for ', rfCard ? `the ${accountById(rfCard.accountId)?.name ?? 'card'} spend “${rfCard.description}” on ${longDate(rfCard.date)}` : 'a card spend that no longer exists', '. Editing that spend updates this too.')
      : existing?.ticketReturn
        ? h('div', { class: 'linked' }, `🔒 Ring-fenced money moved back for the ${periodLabel(existing.ticketReturn)} statement. Deleting it puts the projected entry back.`)
        : null;

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
      if (hasStatements) fields.statementMonth = kind === 'note' ? null : statementMonthToSave();
      if (kind !== 'note' && fields.amount === null) return toast('Enter an amount like 12.34', 'error');
      const env = picker.el.hidden ? null : picker.value();
      if (env?.error) return toast(env.error, 'error');
      const envOwn = env && picker.accountId === account.id;
      if (envOwn) fields.envelopeSplits = env.splits;
      let next;
      if (existing) {
        next = attempt(() => {
          const n = updateTransaction(state.ledger, existing.id, fields);
          return env && !envOwn ? setEnvelopeSplits(n, counterpart.id, env.splits) : n;
        });
      } else {
        next = attempt(() => addTransaction(state.ledger, {
          ...fields, counterpartAccountId: counterpartSelect.value || null, counterpartEnvelopeSplits: env && !envOwn ? env.splits : null,
        }));
      }
      if (!next) return;
      // v0.13 ring-fence follows the spend: added, updated, or removed
      {
        const id = existing ? existing.id : next.transactions.at(-1).id;
        const wanted = rfShown() && rfBox.checked;
        const fenced = isRingFenced(next, id);
        next = attempt(() => (fenced
          ? (rfShown() && !rfBox.checked ? removeRingFence(next, id) : syncRingFence(next, id))
          : wanted ? addRingFence(next, tset, id) : next));
        if (!next) return;
      }
      if (existing) {
        // a reconciled entry (or its other leg) whose amount/date/etc changes gets unticked — ask first
        const unticked = state.ledger.transactions.filter((t) => isReconciled(t) && next.transactions.some((n) => n.id === t.id && !isReconciled(n)));
        if (unticked.length && !confirm(`This entry has been reconciled${unticked.length > 1 ? ' (on both accounts)' : ''}.\n\nChanging it will untick it so you can check it again. Save anyway?`)) return;
      }
      if (!limitsOK(next)) return; // v0.14: warn if it takes an account past a line
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
  stmtField,
  counterpartField,
  picker.el,
  rfField,
  recurringNote,
  ticketNote,
  existing && isReconciled(existing) ? h('div', { class: 'linked' }, '✓ Reconciled — matched against the bank. Changing the amount or date will untick it.') : null,
  h('div', { class: 'sheet-actions' },
    existing ? h('button', {
      type: 'button', class: 'btn-danger',
      onclick: () => {
        const recNote = isReconciled(existing) || isReconciled(counterpart) ? '\n\nIt has been reconciled — the bank shows it.' : '';
        const fenced = isRingFenced(state.ledger, existing.id);
        if (!confirm((counterpart ? 'Delete this entry and its linked entry in the other account?' : fenced ? 'Delete this entry and its ring-fence transfer?' : 'Delete this entry?') + recNote)) return;
        const next = fenced ? removeRingFence(deleteTransaction(state.ledger, existing.id), existing.id) : deleteTransaction(state.ledger, existing.id);
        if (!limitsOK(next)) return;
        dlg.close();
        commit(next, 'Deleted');
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
      // v0.12: the envelope it went in last time (single envelope only), to prefill
      const envLeg = envelopeConfig(accountById(t.accountId)) ? t : other && envelopeConfig(accountById(other.accountId)) ? other : null;
      const envelopeId = envLeg?.envelopeSplits?.length === 1 ? envLeg.envelopeSplits[0].envelopeId : null;
      seen.set(key, { description: t.description, amount: t.amount, direction: t.direction, kind: t.kind, counterpartAccountId: other?.accountId ?? null, envelopeId });
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
function itemStatementCard(item) {
  return statementCardFor(item, state.ledger.accounts);
}
function itemAmountText(item) {
  if (itemStatementCard(item)) return 'statement balance';
  if (item.amountFrom === TRACKER_SOURCE) return `from the ticket tracker (else ${signedAmount(item.kind, item.amount)})`;
  return signedAmount(item.kind, item.amount);
}
function itemAccountsText(item) {
  const name = (id) => accountById(id)?.name ?? 'missing account';
  const text = item.kind === 'transfer' ? `${name(item.accountId)} → ${name(item.toAccountId)}` : name(item.accountId);
  const envAcc = item.envelopeSplits ? accountById(envelopeLegAccountId(item, state.ledger.accounts)) : null;
  return envAcc ? `${text} · ${splitsNames(item.envelopeSplits, envAcc)}` : text;
}

/** Tap on a projected entry: confirm it, change/skip just this month, or edit the series. */
function openOccurrenceDialog(itemId, period) {
  const dlg = $('txDialog');
  const item = recurringItems(state.ledger).find((i) => i.id === itemId);
  if (!item) return;
  const view = withProjections(state.ledger, horizonEnd(todayIso(), MAX_HORIZON_MONTHS + 1), state.holidays, sources());
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
    if (!limitsOK(next)) return;
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
        amount: f.amount === p.seriesAmount ? null : f.amount,
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
  const st = p.statement ?? null;
  const card = st ? accountById(item.toAccountId) : null;
  const stmtLine = st
    ? h('p', { class: 'stmt-info' },
        st.beforeRecords
          ? `Pays the ${longDate(st.date)} statement, which is from before your records start — so this is your estimate. Put in the real figure from the statement and tap “Save for this month only”.`
          : [`Pays the ${longDate(st.date)} statement: ${formatPence(st.owed)} owed${st.date > today ? ' so far (it isn’t produced yet)' : ''}. To pay a different amount this month, change it and tap “Save for this month only”. `,
              h('button', { type: 'button', class: 'btn-link', onclick: () => openStatementDialog(card.id, st.month) }, 'View statement…')])
    : null;
  const tp = p.tracker ?? null;
  const trackerLine = p.amountSource === 'tracker'
    ? h('p', { class: 'stmt-info' },
        `From the ticket tracker: ${formatPence(tp.totalPence)} for ${longDate(tp.start)} – ${longDate(tp.end)} — ${tp.ticketCount} ticket${tp.ticketCount === 1 ? '' : 's'} (${formatPence(tp.ticketPence)}) + ${tp.parkingDays} parking day${tp.parkingDays === 1 ? '' : 's'} (${formatPence(tp.parkingPence)}). `,
        tp.status === 'locked' ? 'Locked in on payday.' : `A projection (figures from ${when(tp.generatedAt)}) — it can still change.`)
    : p.amountSource === 'fallback'
      ? h('p', { class: 'stmt-info' }, `The ticket tracker has no figure for ${periodLabel(period)}, so this is the item’s own amount. ${trackerStatusText()}`)
      : null;
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
          p.number ? ` Payment ${p.number.n} of ${p.number.of}${p.number.n === p.number.of ? ' — the last one' : ''}.` : null,
          p.changed ? h('span', { class: 'muted' }, ` Changed for this month (series: ${longDate(p.seriesDate)}, ${formatPence(p.seriesAmount)}).`) : null),
        stmtLine,
        trackerLine,
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
    h('p', { class: 'muted small rec-summary' }, `${itemAccountsText(item)} · ${itemAmountText(item)}${item.finalAmount != null && item.endDate ? ` (last ${formatPence(item.finalAmount)})` : ''} · ${describeRule(item, itemStatementCard(item))}`),
    body));
  openDialog(dlg);
}

// ------------------------------------------------------------------ v0.13 tickets bought on the card

/** The projections (tickets and money back) as of now, out to the furthest horizon. */
function ticketViewProjections() {
  const view = withProjections(state.ledger, horizonEnd(todayIso(), MAX_HORIZON_MONTHS + 1), state.holidays, sources());
  return view.transactions.filter((t) => t.isProjected && (t.projection?.kind === 'ticket' || t.projection?.kind === 'ticketReturn')).map((t) => t.projection);
}
function dayLabel(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** Tap on a ticket row: bought → confirm it; not bought yet → what the tracker expects. */
function openTicketDialog(ticketId) {
  const dlg = $('txDialog');
  const tset = ticketSettings(state.ledger);
  const p = tset ? ticketViewProjections().find((x) => x.kind === 'ticket' && x.ticket.id === ticketId) : null;
  if (!p) return; // confirmed meanwhile, or the tracker's plan changed
  const t = p.ticket;
  const card = accountById(tset.cardAccountId);
  const envAcc = accountById(tset.envelopeAccountId);
  const envName = envelopeList(envAcc, { includeHidden: true }).find((e) => e.id === tset.envelopeId)?.name ?? 'envelope';
  const safe = accountById(tset.safeAccountId);
  const close = () => dlg.close();
  const today = todayIso();

  const head = h('header', { class: 'sheet-head', style: { '--acc': institutionStyle(card.institution).colour } },
    swatch(card),
    h('h2', {}, `🎟 ${TICKET_DESCRIPTION}`),
    h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: close }, '✕'));
  const valid = h('p', { class: 'muted small rec-summary' }, `Season ticket ${longDate(t.validFrom)} – ${longDate(t.validTo)} · ${formatPence(t.pricePence)} · from the ticket tracker`);

  if (!p.bought) {
    const line = p.overdue
      ? h('p', { class: 'rec-status warn' }, `Overdue: the tracker expected you to buy it on ${dayLabel(t.purchaseDate)}, and it hasn’t been recorded as bought. It’s shown on today’s date until it is.`)
      : h('p', { class: 'rec-status' }, `Forecast: buy on ${dayLabel(t.purchaseDate)} — the day before it starts.`);
    dlg.replaceChildren(h('div', { class: 'sheet-body' }, head, valid, line,
      h('p', { class: 'stmt-info' }, `When you’ve bought it, record the purchase in the ticket tracker. It then shows here as “Bought — confirm”, with the real date and price. (Confirming a forecast isn’t possible: its id changes once the tracker records the purchase.)`),
      h('p', { class: 'muted small' }, `In the forecast: ${card.name} spend ${formatPence(p.amount)}, and ${formatPence(p.amount)} from ${envName} (${envAcc.name}) to ${safe.name} the same day.`),
      h('div', { class: 'sheet-actions' },
        h('span'),
        sync.isEnabled() ? h('button', { type: 'button', class: 'btn-secondary', onclick: () => { close(); checkTrackerFromTap(); } }, 'Check the tracker now') : h('span'))));
    openDialog(dlg);
    return;
  }

  const amount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'amount-input big', value: penceToInput(t.pricePence) });
  const date = h('input', { type: 'date', required: true, value: t.purchaseDate });
  // which statement — only offered near a statement date, as in the entry form
  let stmtChoice = null;
  let stmtShown = null;
  const stmtSeg = h('div', { class: 'seg', role: 'radiogroup' });
  const stmtField = h('div', { class: 'field stmt-choice', hidden: true }, h('span', {}, 'Which statement is it on?'), stmtSeg);
  function syncStatement() {
    stmtShown = boundaryChoice(card, date.value, state.holidays);
    stmtField.hidden = !stmtShown;
    if (!stmtShown) return;
    const chosen = stmtShown.options.includes(stmtChoice) ? stmtChoice : stmtShown.byDate;
    stmtSeg.replaceChildren(...stmtShown.options.map((m, i) => h('button', {
      type: 'button', role: 'radio', class: 'seg-btn', 'aria-checked': String(m === chosen),
      onclick: () => { stmtChoice = m; syncStatement(); },
    }, `${i === 0 ? 'This' : 'Next'} · ${stmtLabel(m, card)}`)));
  }
  date.addEventListener('input', syncStatement);
  date.addEventListener('change', syncStatement);

  const confirmBtn = h('button', {
    type: 'submit', class: 'btn-primary',
    onclick: (e) => {
      e.preventDefault();
      const pence = parseAmount(amount.value);
      if (pence === null) return toast('Enter an amount like 12.34', 'error');
      if (!date.value) return toast('A valid date is required', 'error');
      let statementMonth = null;
      if (stmtShown) {
        const chosen = stmtShown.options.includes(stmtChoice) ? stmtChoice : stmtShown.byDate;
        statementMonth = chosen === statementMonthByDate(card, date.value, state.holidays) ? null : chosen;
      }
      const next = attempt(() => confirmTicket(state.ledger, tset, t, { date: date.value, amount: pence, statementMonth }));
      if (!next) return;
      if (!limitsOK(next)) return;
      close();
      commit(next, 'Ticket confirmed');
    },
  }, 'Confirm');

  dlg.replaceChildren(h('form', { method: 'dialog', class: 'sheet-body', onsubmit: (e) => { e.preventDefault(); confirmBtn.click(); } },
    head, valid,
    h('p', { class: 'rec-status rec-due' }, `Bought on ${dayLabel(t.purchaseDate)}, says the ticket tracker.`),
    h('p', { class: 'stmt-info' }, `Confirming adds: a ${card.name} spend, and the same amount moved from ${envName} (${envAcc.name}) to ${safe.name}. It goes back to ${accountById(tset.returnAccountId).name} the day before the card is paid.`),
    h('label', { class: 'field' }, h('span', {}, 'Amount (£)'), amount),
    h('label', { class: 'field' }, h('span', {}, 'Date bought'), date),
    stmtField,
    t.purchaseDate > today ? h('p', { class: 'warn small' }, 'That date is in the future.') : null,
    h('div', { class: 'sheet-actions' }, h('span'), confirmBtn)));
  syncStatement();
  openDialog(dlg);
}

/** Tap on the projected "money back" before a card payment: what's in it, then confirm. */
function openReturnDialog(month) {
  const dlg = $('txDialog');
  const tset = ticketSettings(state.ledger);
  const p = tset ? ticketViewProjections().find((x) => x.kind === 'ticketReturn' && x.statementMonth === month) : null;
  if (!p) return;
  const card = accountById(tset.cardAccountId);
  const safe = accountById(tset.safeAccountId);
  const back = accountById(tset.returnAccountId);
  const close = () => dlg.close();
  const amount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'amount-input big', value: penceToInput(p.amount) });
  const date = h('input', { type: 'date', required: true, value: p.date });
  const confirmBtn = h('button', {
    type: 'submit', class: 'btn-primary',
    onclick: (e) => {
      e.preventDefault();
      const pence = parseAmount(amount.value);
      if (pence === null) return toast('Enter an amount like 12.34', 'error');
      if (!date.value) return toast('A valid date is required', 'error');
      const next = attempt(() => confirmReturn(state.ledger, tset, month, { date: date.value, amount: pence, description: p.description }));
      if (!next) return;
      if (!limitsOK(next)) return;
      close();
      commit(next, 'Confirmed');
    },
  }, 'Confirm');
  const stDate = statementDate(card, month, state.holidays);
  dlg.replaceChildren(h('form', { method: 'dialog', class: 'sheet-body', onsubmit: (e) => { e.preventDefault(); confirmBtn.click(); } },
    h('header', { class: 'sheet-head', style: { '--acc': institutionStyle(safe.institution).colour } },
      swatch(safe),
      h('h2', {}, '🔒 Ring-fenced money back'),
      h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: close }, '✕')),
    h('p', { class: 'muted small rec-summary' }, `${safe.name} → ${back.name} · the day before the ${card.name} payment on ${dayLabel(p.dueDate)}`),
    h('p', { class: `rec-status ${p.date <= todayIso() ? 'rec-due' : ''}` }, `For the ${longDate(stDate)} statement — everything ring-fenced on it:`),
    h('ul', { class: 'ticket-spends' }, p.spends.map((t) => h('li', {},
      h('span', {}, `${shortDate(t.date)} · ${t.description}${t.isProjected ? ' (projected)' : ''}`),
      h('span', {}, formatPence(t.amount))))),
    h('label', { class: 'field' }, h('span', {}, 'Amount (£)'), amount),
    h('label', { class: 'field' }, h('span', {}, 'Date'), date),
    h('p', { class: 'muted small' }, 'Confirm once you’ve moved it — change the amount first if you moved a different figure (e.g. something ring-fenced by hand before you switched this on).'),
    h('div', { class: 'sheet-actions' }, h('span'), confirmBtn)));
  openDialog(dlg);
}

// ------------------------------------------------------------------ card statement dialog

/**
 * One statement: what's owed, the payment, and the entries near the
 * statement date with a This / Next statement switch for each.
 */
function openStatementDialog(cardId, month) {
  const dlg = $('txDialog');
  const card = accountById(cardId);
  if (!card || !statementConfig(card)) return;
  const s = institutionStyle(card.institution);

  const move = async (txId, chosen, byDate) => {
    const next = attempt(() => setStatementMonth(state.ledger, txId, chosen === byDate ? null : chosen));
    if (!next) return;
    await commit(next);
    draw();
    toast(`Moved to the ${stmtLabel(chosen, card)} statement`);
  };

  function paymentBlock(view, st) {
    const item = statementItemFor(card);
    const period = addMonths(month, 1);
    if (!item) {
      return h('p', { class: 'muted small' }, `Payment due ${longDate(st.dueDate)}. To have it filled in for you, set up a recurring transfer to ${card.name} and tick “Pay the statement balance” (⚙ → Manage recurring items).`);
    }
    const paid = state.ledger.transactions.find((t) => t.scheduledItemId === item.id && t.scheduledPeriod === period && t.accountId === card.id);
    if (paid) return h('p', { class: 'stmt-pay' }, `✓ Paid ${formatPence(paid.amount)} on ${longDate(paid.date)}${paid.amount < st.owed ? ` — ${formatPence(st.owed - paid.amount)} carried to the next statement` : ''}.`);
    const proj = view.transactions.find((t) => t.isProjected && t.scheduledItemId === item.id && t.scheduledPeriod === period && t.accountId === card.id)?.projection;
    if (proj) {
      return h('div', { class: 'stmt-pay' },
        h('p', {}, `↻ ${proj.skipped ? 'Skipped' : `${formatPence(proj.amount)} on ${longDate(proj.date)}`} from ${accountById(item.accountId)?.name ?? 'account'}`,
          proj.changed ? h('span', { class: 'muted' }, ` (changed for this month — statement says ${formatPence(proj.seriesAmount)})`) : null),
        h('button', { type: 'button', class: 'btn-secondary btn-small', onclick: () => openOccurrenceDialog(item.id, period) }, 'Change or confirm the payment…'));
    }
    if (st.dueDate > projectionEnd()) return h('p', { class: 'muted small' }, `Payment due ${longDate(st.dueDate)} — beyond the months shown.`);
    return h('p', { class: 'muted small' }, `Nothing to pay (due ${longDate(st.dueDate)}).`);
  }

  function draw() {
    const view = viewLedger();
    const st = statementFor(view, card, month, state.holidays);
    if (!st || st.beforeRecords) { dlg.close(); return; }
    const today = todayIso();
    const lo = new Date(Date.parse(st.date) - 3 * 86400000).toISOString().slice(0, 10);
    const hi = new Date(Date.parse(st.date) + 3 * 86400000).toISOString().slice(0, 10);
    const next = addMonths(month, 1);
    const near = state.ledger.transactions
      .filter((t) => t.accountId === card.id && t.kind !== 'note' && ((t.date >= lo && t.date <= hi) || t.statementMonth === month || (t.statementMonth === next && t.date <= st.date)))
      .sort((a, b) => a.date.localeCompare(b.date));
    const rows = near.map((t) => {
      const byDate = statementMonthByDate(card, t.date, state.holidays);
      const eff = t.statementMonth || byDate;
      const btn = (m, label) => h('button', {
        type: 'button', role: 'radio', class: 'seg-btn', 'aria-checked': String(eff === m),
        onclick: () => (eff === m ? null : move(t.id, m, byDate)),
      }, label);
      return h('li', { class: 'stmt-row' },
        h('span', { class: 'stmt-row-main' },
          h('span', { class: 'stmt-row-desc' }, t.description || '(no description)'),
          h('span', { class: 'muted small' }, `${longDate(t.date)} · ${t.direction === 'credit' ? '+' : ''}${formatPence(t.amount)}${eff !== byDate ? ' · moved' : ''}`)),
        h('div', { class: 'seg seg-small', role: 'radiogroup' }, btn(month, 'This'), btn(next, 'Next')));
    });

    dlg.replaceChildren(h('div', { class: 'sheet-body' },
      h('header', { class: 'sheet-head', style: { '--acc': s.colour } },
        swatch(card),
        h('h2', {}, `${card.name} statement · ${longDate(st.date)}`),
        h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
      h('div', { class: 'stmt-owed' },
        h('span', { class: 'muted small' }, st.date > today ? 'Owed so far (not produced yet)' : 'Owed on this statement'),
        h('strong', {}, formatPence(st.owed))),
      paymentBlock(view, st),
      h('button', { type: 'button', class: 'btn-secondary btn-small', onclick: () => { dlg.close(); openReconcileDialog(card.id, { month }); } },
        st.date > today ? 'Tick off entries so far…' : 'Reconcile this statement…'),
      h('h3', { class: 'stmt-h' }, 'Entries near the statement date'),
      h('p', { class: 'muted small' }, 'Something bought on (or just before) the statement date sometimes only appears on the next statement. If the real statement differs, move the entry — the amount owed and the payment follow.'),
      rows.length ? h('ul', { class: 'stmt-rows' }, rows) : h('p', { class: 'muted small' }, `Nothing on ${card.name} within 3 days of ${longDate(st.date)}.`),
      h('p', { class: 'muted small' }, 'If the total still doesn’t match the real statement, an entry is probably missing (interest, cashback, a refund) — add it and it’s counted here.')));
  }
  draw();
  if (!dlg.open) openDialog(dlg);
}

// ------------------------------------------------------------------ recurring: manager + editor

function renderRecurringManager() {
  const dlg = $('recurringDialog');
  const today = todayIso();
  const all = recurringItems(state.ledger).map((item) => ({
    item,
    next: upcomingDates(item, today, 1, state.holidays, itemStatementCard(item))[0] ?? null,
    finished: seriesFinished(state.ledger, item, state.holidays, sources()),
  }));
  const active = all.filter((x) => !x.finished)
    .sort((a, b) => (a.next ?? '9999').localeCompare(b.next ?? '9999') || a.item.description.localeCompare(b.item.description));
  // v0.9: a series with an end date whose last payment is confirmed (or skipped) moves to "Expired", latest end first
  const expired = all.filter((x) => x.finished)
    .sort((a, b) => b.item.endDate.localeCompare(a.item.endDate) || a.item.description.localeCompare(b.item.description));

  const lastPaid = (item) => state.ledger.transactions
    .filter((t) => t.scheduledItemId === item.id)
    .reduce((max, t) => (t.date > max ? t.date : max), '');
  const row = ({ item, next, finished }) => {
    const acc = accountById(item.accountId);
    const paid = finished ? lastPaid(item) : '';
    // v0.11: an item on the tracker shows the tracker's figure for its next payment, if it has one
    const trk = item.amountFrom === TRACKER_SOURCE && !itemStatementCard(item);
    const nextAmount = (trk && next && trackerPeriodFor(state.tracker?.estimates, next.slice(0, 7))?.totalPence) ?? item.amount;
    const status = finished
      ? (paid ? `Finished · last payment ${longDate(paid)}` : `Finished · ended ${longDate(item.endDate)}`)
      : next ? `Next: ${longDate(next)}${nextNumberText(item)}`
        : `Ended${item.endDate ? ` ${longDate(item.endDate)}` : ''} · last payment not confirmed yet`;
    return h('li', {}, h('button', { type: 'button', class: `rec-row ${finished ? 'rec-ended' : ''}`, onclick: () => openRecurringEditor(item.id) },
      acc ? swatch(acc) : null,
      h('span', { class: 'rec-main' },
        h('span', { class: 'rec-name' }, item.description),
        h('span', { class: 'muted small' }, `${describeRule(item, itemStatementCard(item))}${trk ? ' · amount from the ticket tracker' : ''} · ${itemAccountsText(item)}`),
        h('span', { class: 'small' }, status)),
      h('span', { class: `rec-amt ${item.kind === 'in' ? 'credit' : ''}` }, itemStatementCard(item) ? 'statement' : signedAmount(item.kind, nextAmount))));
  };

  const list = all.length
    ? h('div', {},
        active.length ? h('ul', { class: 'rec-list rec-active' }, active.map(row)) : h('p', { class: 'muted small' }, 'Nothing still running.'),
        expired.length ? h('h3', { class: 'rec-section-head' }, `Expired (${expired.length})`) : null,
        expired.length ? h('ul', { class: 'rec-list rec-expired' }, expired.map(row)) : null)
    : h('p', { class: 'muted' }, 'None yet. Add salary, direct debits, subscriptions and card payments here — they then appear ahead of time in your accounts, ready to confirm.');

  dlg.replaceChildren(h('div', { class: 'sheet-body' },
    h('header', { class: 'sheet-head' },
      h('h2', {}, 'Recurring items'),
      h('div', { class: 'head-actions' },
        h('button', { type: 'button', class: 'btn-primary btn-small rec-add-top', onclick: () => openRecurringEditor(null) }, '+ Add'),
        h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕'))),
    list,
    all.length ? h('button', { type: 'button', class: 'btn-primary', onclick: () => openRecurringEditor(null) }, '+ Add recurring item') : null,
    h('p', { class: 'muted small' }, holidayStatusText())));
}

// ------------------------------------------------------------------ reconcile (v0.8)

/** "1,234.56", "-12.30", "−5" -> pence (negative allowed: an overdrawn account, a card in credit). */
function parseSignedAmount(text) {
  const t = String(text ?? '').trim();
  const neg = /^[-−]/.test(t);
  const p = parseAmount(neg ? t.replace(/^[-−]\s*/, '') : t);
  return p === null ? null : neg ? -p : p;
}
// The closing figure typed in from the bank is kept for this session only (not saved)
const reconTyped = new Map(); // `${accountId}|${month or date}` -> text
let reconHideTicked = false;

function openReconcileDialog(accountId, period = null) {
  const dlg = $('reconcileDialog');
  const account = accountById(accountId);
  if (!account) return;
  const style = institutionStyle(account.institution);
  const byStatement = reconcilesByStatement(account);
  const credit = account.type === 'credit';
  let current = period ?? defaultPeriod(account, todayIso(), state.holidays);
  const keyOf = () => `${account.id}|${current.month ?? current.toDate}`;

  const toggle = async (txId, on) => {
    const next = attempt(() => setReconciled(state.ledger, txId, on));
    if (!next) return;
    await commit(next);
    draw();
  };

  function periodPicker() {
    if (byStatement) {
      const today = todayIso();
      const upTo = statementDate(account, addMonths(monthOf(today), 1), state.holidays);
      const months = statementMonths(account, upTo, state.holidays).reverse();
      if (current.month && !months.includes(current.month)) months.unshift(current.month);
      const sel = h('select', { class: 'recon-period', onchange: () => { current = { month: sel.value }; draw(); } },
        months.map((m) => {
          const d = statementDate(account, m, state.holidays);
          const label = new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
          return h('option', { value: m, selected: m === current.month }, `${label}${d > today ? ' (so far)' : ''}`);
        }));
      return h('label', { class: 'field' }, h('span', {}, 'Statement'), sel);
    }
    const inp = h('input', { type: 'date', class: 'recon-period', value: current.toDate, required: true,
      onchange: () => { if (inp.value) { current = { toDate: inp.value }; draw(); } } });
    return h('label', { class: 'field' }, h('span', {}, 'Closing date (from the bank)'), inp);
  }

  function draw() {
    const scope = attempt(() => reconcileScope(state.ledger, account, current, state.holidays));
    if (!scope) return;
    const keepScroll = dlg.scrollTop; // ticking a row redraws; don't jump back to the top
    requestAnimationFrame(() => { dlg.scrollTop = keepScroll; });
    const amountText = (pence) => (credit ? `${formatPence(pence)} owed` : formatPence(pence));

    const bank = h('input', {
      type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'amount-input recon-bank',
      placeholder: credit ? 'e.g. 70.00' : 'e.g. 1,234.56', value: reconTyped.get(keyOf()) ?? '',
    });
    const summary = h('div', { class: 'recon-summary', 'aria-live': 'polite' });
    const drawSummary = () => {
      reconTyped.set(keyOf(), bank.value);
      const typed = bank.value.trim() === '' ? null : parseSignedAmount(bank.value);
      const line = (label, value, cls = '') => h('div', { class: `recon-line ${cls}` }, h('span', {}, label), h('strong', {}, value));
      const parts = [
        line(credit ? 'App works out' : 'App’s balance', amountText(scope.appBalance)),
        line('Ticked so far', amountText(scope.tickedBalance)),
      ];
      if (bank.value.trim() !== '' && typed === null) {
        parts.push(h('div', { class: 'recon-result warn' }, 'Enter the figure like 1,234.56 (minus sign if negative)'));
      } else if (typed === null) {
        parts.push(h('div', { class: 'recon-result muted' }, `Type in the ${credit ? 'amount owed on the statement' : 'closing balance from the bank'} to compare.`));
      } else {
        const diff = reconcileDifference(scope, typed);
        parts.push(diff === 0
          ? h('div', { class: 'recon-result ok' }, '✓ Balanced')
          : h('div', { class: 'recon-result off' }, `Difference ${diff > 0 ? '+' : '−'}${formatPence(Math.abs(diff))}`,
            h('span', { class: 'small' }, ' — tick the lines that are on the bank’s statement')));
        if (typed !== scope.appBalance) {
          parts.push(h('p', { class: 'muted small' }, `The bank’s figure and the app’s differ by ${formatPence(Math.abs(typed - scope.appBalance))} — once everything on the statement is ticked, any difference left is a missing or wrong entry (interest, a refund, a typo).`));
        }
      }
      summary.replaceChildren(...parts);
    };
    bank.addEventListener('input', drawSummary);
    drawSummary();

    const hide = h('input', { type: 'checkbox', checked: reconHideTicked, onchange: () => { reconHideTicked = hide.checked; draw(); } });
    const shown = scope.entries.filter((e) => !(reconHideTicked && e.reconciled));
    const periodText = scope.kind === 'statement'
      ? `Entries on the ${longDate(scope.closingDate)} statement`
      : `${longDate(scope.fromDate)} to ${longDate(scope.closingDate)}`;

    const rows = shown.map(({ tx: t, inPeriod, reconciled }) => {
      const other = counterpartOf(state.ledger, t);
      const otherAcc = other ? accountById(other.accountId) : null;
      const box = h('input', { type: 'checkbox', checked: reconciled, 'aria-label': `Ticked: ${t.description}`, onchange: () => toggle(t.id, box.checked) });
      return h('li', {}, h('label', { class: `recon-row ${reconciled ? 'is-rec' : ''} ${inPeriod ? '' : 'earlier'}` },
        box,
        h('span', { class: 'recon-main' },
          h('span', { class: 'recon-desc' }, t.description || '(no description)'),
          h('span', { class: 'muted small' }, shortDate(t.date),
            otherAcc ? ` · ${t.direction === 'debit' ? '→' : '←'} ${otherAcc.name}` : '',
            inPeriod ? '' : h('span', { class: 'recon-earlier' }, ' · earlier, not ticked yet'))),
        h('span', { class: `recon-amt ${t.direction}` }, `${t.direction === 'credit' ? '+' : '−'}${formatPence(t.amount)}`)));
    });

    dlg.replaceChildren(h('div', { class: 'sheet-body' },
      h('header', { class: 'sheet-head', style: { '--acc': style.colour } },
        swatch(account),
        h('h2', {}, `Reconcile · ${account.name}`),
        h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
      h('div', { class: 'field-pair' },
        periodPicker(),
        h('label', { class: 'field' }, h('span', {}, credit ? 'Owed on the statement (£)' : 'Bank’s closing balance (£)'), bank)),
      summary,
      h('div', { class: 'recon-count' },
        h('span', {}, h('strong', {}, `${scope.tickedCount} of ${scope.totalCount}`), ' ticked · ', periodText,
          scope.earlierUnticked ? ` · plus ${scope.earlierUnticked} earlier` : ''),
        h('label', { class: 'check small' }, hide, 'Hide ticked')),
      rows.length
        ? h('ul', { class: 'recon-rows' }, rows)
        : h('p', { class: 'muted small' }, scope.totalCount ? 'Everything here is ticked.' : 'No entries in this period.'),
      h('p', { class: 'muted small' }, 'Tick each line you can see on the bank’s statement. Ticks sync to your other devices. Changing a ticked entry’s amount or date later asks first and then unticks it.')));
  }
  draw();
  openDialog(dlg);
}

/** " · payment 3 of 12" for the next payment not yet confirmed or skipped, or ''. */
function nextNumberText(item) {
  if (!item.endDate) return '';
  const view = withProjections(state.ledger, item.endDate, state.holidays, sources());
  const p = view.transactions.find((t) => t.isProjected && t.scheduledItemId === item.id && !t.skipped && t.date >= todayIso())?.projection;
  return p?.number ? ` · payment ${p.number.n} of ${p.number.of}` : '';
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
  const accountOptions = (selected, list = accounts) => list.map((a) => h('option', { value: a.id, selected: a.id === selected }, a.name));
  const account = h('select', {}, accountOptions(defaultAccount));
  // v0.14: a transfer stays within one file (your accounts, or the joint account)
  const toChoices = (fromId) => { const ok = new Set(sameFileAccounts(fromId).map((a) => a.id)); return accounts.filter((a) => ok.has(a.id)); };
  const defaultTo = (fromId) => { const list = toChoices(fromId); return list.find((a) => a.id !== fromId && a.type === 'credit')?.id ?? list.find((a) => a.id !== fromId)?.id; };
  const toAccount = h('select', {}, accountOptions(existing?.toAccountId ?? defaultTo(defaultAccount), toChoices(defaultAccount)));
  account.addEventListener('change', () => {
    const keep = toChoices(account.value).some((a) => a.id === toAccount.value) ? toAccount.value : defaultTo(account.value);
    toAccount.replaceChildren(...accountOptions(keep, toChoices(account.value)));
  });
  const accountLabel = h('span', {}, 'Account');
  const toField = h('label', { class: 'field' }, h('span', {}, 'To (e.g. the credit card)'), toAccount);
  const amount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'amount-input', placeholder: '0.00', value: existing ? penceToInput(existing.amount) : '' });
  const amountLabel = h('span', {}, 'Amount (£)');
  const amountHint = h('div', { class: 'muted small', hidden: true }, 'Only used for a statement from before your records start (e.g. the one this month’s payment pays). Can be left blank.');
  const payStmt = h('input', { type: 'checkbox', checked: Boolean(existing?.payStatement) });
  const payStmtText = h('span', {});
  const payStmtField = h('div', { class: 'field' }, h('label', { class: 'check' }, payStmt, payStmtText));
  const payStmtHint = h('div', { class: 'muted small' });
  payStmtField.append(payStmtHint);
  // v0.11: amount from the ticket tracker's published figures
  const fromTracker = h('input', { type: 'checkbox', checked: existing?.amountFrom === TRACKER_SOURCE });
  const trackerHint = h('div', { class: 'muted small' });
  const trackerField = h('div', { class: 'field' },
    h('label', { class: 'check' }, fromTracker, h('span', {}, 'Take the amount from the ticket tracker (“Set aside on payday”)')),
    trackerHint);
  const statementCardSelected = () => (kind === 'transfer' ? accountById(toAccount.value) : null);
  const payingStatement = () => payStmt.checked && Boolean(statementConfig(statementCardSelected()));
  // v0.12: which envelope(s) the money goes in / comes out of
  const envPicker = envelopePicker({ getAmount: () => (amount.value.trim() === '' ? null : parseAmount(amount.value)) });
  let envSingleOnly = null;
  function syncEnvelope() {
    const legId = envelopeLegAccountId({ kind, accountId: account.value, toAccountId: kind === 'transfer' ? toAccount.value : null }, state.ledger.accounts);
    const envAcc = accountById(legId);
    envPicker.el.hidden = !envAcc;
    if (!envAcc) return;
    const singleOnly = payingStatement() || fromTracker.checked; // amount changes every month: one envelope only
    if (envAcc.id !== envPicker.accountId || singleOnly !== envSingleOnly) {
      const initial = envPicker.accountId === null ? (existing && envelopeLegAccountId(existing, state.ledger.accounts) === envAcc.id ? existing.envelopeSplits : null)
        : envPicker.accountId === envAcc.id ? envPicker.value().splits : null;
      envPicker.setAccount(envAcc, initial ?? null, { allowSplit: !singleOnly });
      envSingleOnly = singleOnly;
    }
    envPicker.refresh();
  }

  const every = existing?.everyMonths ?? 1;
  const freqNow = existing?.everyDays ? 'd' : every === 1 ? '1' : every === 12 ? '12' : 'n';
  const freq = h('select', {},
    [['1', 'Monthly'], ['n', 'Every few months'], ['12', 'Yearly'], ['d', 'Every so many days']].map(([v, l]) =>
      h('option', { value: v, selected: v === freqNow }, l)));
  const nMonths = h('input', { type: 'text', inputmode: 'numeric', class: 'amount-input', value: freqNow === 'n' ? String(every) : '6' });
  const nField = h('label', { class: 'field' }, h('span', {}, 'Every how many months?'), nMonths);
  const nDays = h('input', { type: 'number', inputmode: 'numeric', class: 'amount-input', min: String(MIN_EVERY_DAYS), max: String(MAX_EVERY_DAYS), step: '1', value: existing?.everyDays ? String(existing.everyDays) : '90' });
  const nDaysField = h('label', { class: 'field' }, h('span', {}, `Every how many days? (${MIN_EVERY_DAYS}–${MAX_EVERY_DAYS})`), nDays);
  const day = h('input', { type: 'text', inputmode: 'numeric', class: 'amount-input', placeholder: '1–31', value: existing ? String(existing.day) : '' });
  const dayField = h('label', { class: 'field' }, h('span', {}, 'Day of the month'), day);
  const start = h('input', { type: 'date', required: true, value: existing?.startDate ?? todayIso() });
  const end = h('input', { type: 'date', value: existing?.endDate ?? '' });
  const finalAmt = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'amount-input', placeholder: 'same', value: existing?.finalAmount != null ? penceToInput(existing.finalAmount) : '' });
  const firstNo = h('input', { type: 'text', inputmode: 'numeric', class: 'amount-input', value: String(existing?.firstNumber ?? 1) });
  const endFields = h('div', {},
    h('div', { class: 'field-pair' },
      h('label', { class: 'field' }, h('span', {}, 'Last payment (£)'), finalAmt),
      h('label', { class: 'field' }, h('span', {}, 'First payment no.'), firstNo)),
    h('div', { class: 'muted small end-hint' }, 'Leave the last payment blank if it’s the same. Entries show “(x of y)” — if you’ve already paid some before this series starts, set its first payment number, e.g. 2 if payment 1 is done.'));
  const shift = h('select', {},
    [['none', 'Leave it on that day'], ['before', 'Move to the working day before (e.g. salary)'], ['after', 'Move to the next working day (e.g. direct debit)']].map(([v, l]) =>
      h('option', { value: v, selected: (existing?.shift ?? 'none') === v }, l)));
  const startHint = h('div', { class: 'muted small' });
  const preview = h('div', { class: 'rec-preview' });
  const freqDayPair = h('div', { class: 'field-pair' },
    h('label', { class: 'field' }, h('span', {}, 'Repeats'), freq),
    dayField);
  const shiftField = h('label', { class: 'field' }, h('span', {}, 'If it lands on a weekend or bank holiday'), shift);

  function draft() {
    if (payingStatement()) {
      return {
        description: desc.value, kind, accountId: account.value, toAccountId: toAccount.value,
        amount: amount.value.trim() === '' ? 0 : parseAmount(amount.value), everyMonths: 1, everyDays: null,
        day: Number.parseInt(day.value, 10) || existing?.day || 1,
        startDate: start.value, endDate: end.value || null, shift: 'after', finalAmount: null,
        firstNumber: existing?.firstNumber ?? 1, payStatement: true, amountFrom: null,
        envelopeSplits: envPicker.el.hidden ? null : envPicker.value().splits ?? null,
      };
    }
    const byDays = freq.value === 'd';
    const everyMonths = byDays ? 1 : freq.value === 'n' ? Number.parseInt(nMonths.value, 10) : Number(freq.value);
    // every N days: whole numbers only ("90.5" or "90abc" is not 90)
    const everyDays = byDays ? (/^\s*\d+\s*$/.test(nDays.value) ? Number(nDays.value) : NaN) : null;
    return {
      payStatement: false,
      amountFrom: fromTracker.checked ? TRACKER_SOURCE : null,
      description: desc.value, kind, accountId: account.value, toAccountId: kind === 'transfer' ? toAccount.value : null,
      amount: parseAmount(amount.value), everyMonths, everyDays,
      day: byDays ? Number(start.value.slice(8, 10)) || 1 : Number.parseInt(day.value, 10),
      startDate: start.value, endDate: end.value || null, shift: shift.value,
      finalAmount: end.value && finalAmt.value.trim() ? parseAmount(finalAmt.value) : null,
      firstNumber: end.value ? Number.parseInt(firstNo.value, 10) : (existing?.firstNumber ?? 1),
      envelopeSplits: envPicker.el.hidden ? null : envPicker.value().splits ?? null,
    };
  }
  function sync() {
    for (const b of seg.children) b.setAttribute('aria-checked', String(b.dataset.value === kind));
    toField.hidden = kind !== 'transfer';
    accountLabel.textContent = kind === 'transfer' ? 'From' : 'Account';
    // statement payment: only for a transfer to a credit card
    const card = statementCardSelected();
    const cardCfg = statementConfig(card);
    payStmtField.hidden = card?.type !== 'credit';
    payStmt.disabled = !cardCfg;
    payStmtText.textContent = cardCfg
      ? `Pay the statement balance on its due date (${cardCfg.paymentDays} days after the statement)`
      : 'Pay the statement balance on its due date';
    payStmtHint.textContent = cardCfg
      ? 'The amount and date fill themselves in from the card’s statement. To pay less one month, change that month’s entry.'
      : card?.type === 'credit' ? `Set ${card.name}’s statement date first (its Account… button).` : '';
    const stmtOn = payingStatement();
    for (const el of [freqDayPair, shiftField]) el.hidden = stmtOn;
    const trackerOn = !stmtOn && fromTracker.checked;
    trackerField.hidden = stmtOn;
    trackerHint.textContent = trackerOn
      ? `Each month uses the tracker’s figure for the pay period starting that month; the amount below is used for any month it has no figure for. ${trackerStatusText()}`
      : 'For Train fare/Parking: the figure the ticket tracker works out for each pay period.';
    amountLabel.textContent = stmtOn ? 'Estimate (£)' : trackerOn ? 'Amount if the tracker has no figure (£)' : 'Amount (£)';
    amountHint.hidden = !stmtOn;
    nField.hidden = stmtOn || freq.value !== 'n';
    nDaysField.hidden = stmtOn || freq.value !== 'd';
    nDays.disabled = nDaysField.hidden; // a hidden, half-typed number mustn't block saving
    dayField.hidden = freq.value === 'd';
    endFields.hidden = stmtOn || !end.value;
    startHint.textContent = freq.value === 'd' && !stmtOn ? 'The date of the first payment — it repeats every so many days from here.'
      : freq.value === '1' || stmtOn ? 'Nothing before this date.' : 'Nothing before this date — and it repeats counting from this month.';
    syncEnvelope();
    const d = draft();
    let text = '';
    if (stmtOn && d.startDate) {
      const next = upcomingDates(d, todayIso(), 3, state.holidays, card);
      text = next.length ? `Next: ${next.map(longDate).join(' · ')}` : 'No dates from today (ended).';
    } else if (d.everyDays != null && !(d.everyDays >= MIN_EVERY_DAYS && d.everyDays <= MAX_EVERY_DAYS)) {
      text = `Repeat every ${MIN_EVERY_DAYS} to ${MAX_EVERY_DAYS} days.`;
    } else if (d.day >= 1 && d.day <= 31 && d.everyMonths >= 1 && d.everyMonths <= 12 && d.startDate) {
      const next = upcomingDates(d, todayIso(), 3, state.holidays);
      text = next.length ? `Next: ${next.map(longDate).join(' · ')}` : 'No dates from today (ended).';
      if (d.amountFrom === TRACKER_SOURCE && next.length) {
        const figs = next.map((iso) => {
          const tp = trackerPeriodFor(state.tracker?.estimates, iso.slice(0, 7));
          return `${periodLabel(iso.slice(0, 7))} ${tp ? formatPence(tp.totalPence) : Number.isInteger(d.amount) ? `${formatPence(d.amount)} (no tracker figure)` : 'no tracker figure'}`;
        });
        text += `\nAmounts: ${figs.join(' · ')}`;
      }
      if (d.endDate && d.endDate >= d.startDate && d.firstNumber >= 1) {
        const numbering = itemNumbering(state.ledger, { ...d, id: existing?.id ?? '' });
        const periods = [...numbering.keys()];
        if (periods.length) {
          const first = numbering.get(periods[0]);
          const lastP = periods[periods.length - 1];
          const lastAmt = seriesAmount({ ...d, finalAmount: d.finalAmount ?? null }, lastP, numbering);
          text += `\n${periods.length} payment${periods.length === 1 ? '' : 's'}, numbered ${first.n}–${first.of} of ${first.of}`;
          if (Number.isInteger(lastAmt)) text += ` · last one ${formatPence(lastAmt)} in ${periodLabel(lastP)}`;
        }
      }
    }
    preview.textContent = text;
    preview.style.whiteSpace = 'pre-line';
    preview.hidden = !text;
  }
  for (const el of [freq, nMonths, nDays, day, start, end, shift, finalAmt, firstNo, amount]) el.addEventListener('input', sync);
  for (const el of [freq, shift, account, toAccount, payStmt, fromTracker]) el.addEventListener('change', sync);

  const form = h('form', {
    method: 'dialog', class: 'sheet-body',
    onsubmit: (e) => {
      e.preventDefault();
      const env = envPicker.el.hidden ? null : envPicker.value();
      if (env?.error) return toast(env.error, 'error');
      const d = draft();
      if (d.amount === null) return toast('Enter an amount like 12.34', 'error');
      if (!d.payStatement && Number.isNaN(d.day)) return toast('Day of the month must be 1 to 31', 'error');
      if (Number.isNaN(d.everyMonths)) return toast('Repeat every 1 to 12 months', 'error');
      if (d.everyDays != null && !(d.everyDays >= MIN_EVERY_DAYS && d.everyDays <= MAX_EVERY_DAYS)) return toast(`Repeat every ${MIN_EVERY_DAYS} to ${MAX_EVERY_DAYS} days`, 'error');
      if (end.value && finalAmt.value.trim() && d.finalAmount === null) return toast('Enter the last payment like 12.34, or leave it blank', 'error');
      if (Number.isNaN(d.firstNumber)) return toast('First payment number must be 1 to 999', 'error');
      const next = existing
        ? attempt(() => updateRecurring(state.ledger, existing.id, d))
        : attempt(() => addRecurring(state.ledger, d)?.ledger);
      if (!next) return;
      if (!limitsOK(next)) return;
      dlg.close();
      commit(next, existing ? 'Recurring item updated' : 'Recurring item added');
      if (isOpen('recurringDialog')) renderRecurringManager();
      if (isOpen('settingsDialog')) renderSettings();
    },
  },
  h('header', { class: 'sheet-head' },
    h('h2', {}, existing ? 'Edit recurring item' : 'New recurring item'),
    h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
  existing ? h('p', { class: 'muted small' }, 'Changes apply to every month not yet confirmed. Confirmed entries stay as they are.') : null,
  h('label', { class: 'field' }, h('span', {}, 'Description'), desc),
  seg,
  h('div', { class: 'field-pair' }, h('label', { class: 'field' }, accountLabel, account), toField),
  payStmtField,
  trackerField,
  h('label', { class: 'field' }, amountLabel, amount, amountHint),
  envPicker.el,
  freqDayPair,
  nField,
  nDaysField,
  h('div', { class: 'field-pair' },
    h('label', { class: 'field' }, h('span', {}, 'From'), start),
    h('label', { class: 'field' }, h('span', {}, 'To (blank = no end)'), end)),
  startHint,
  endFields,
  shiftField,
  preview,
  h('div', { class: 'sheet-actions' },
    existing ? h('button', {
      type: 'button', class: 'btn-danger',
      onclick: () => {
        if (!confirm(`Delete “${existing.description}”?\n\nIts projected entries disappear. Entries you’ve already confirmed stay as they are.`)) return;
        const next = deleteRecurring(state.ledger, existing.id);
        if (!limitsOK(next)) return; // e.g. deleting an income item
        dlg.close();
        commit(next, 'Recurring item deleted');
        if (isOpen('recurringDialog')) renderRecurringManager();
        if (isOpen('settingsDialog')) renderSettings();
      },
    }, 'Delete') : h('span'),
    h('button', { type: 'submit', class: 'btn-primary' }, existing ? 'Save' : 'Add')));

  dlg.replaceChildren(form);
  sync();
  openDialog(dlg);
}

// ------------------------------------------------------------------ envelopes (v0.12)

/** Tag for an entry on an envelope account: { text, cls } or null. */
function envTag(t, account) {
  const al = allocationOf(t, account);
  if (!al) return null;
  if (al.type === 'single') return { text: envelopeName(account, al.envelopeId), cls: '' };
  if (al.type === 'split') {
    const visible = envelopeList(account).map((e) => e.id);
    const all = visible.length > 2 && visible.every((id) => t.envelopeSplits.some((s) => s.envelopeId === id));
    return { text: all ? 'All envelopes' : t.envelopeSplits.map((s) => envelopeName(account, s.envelopeId)).join(' + '), cls: 'env-split-tag' };
  }
  if (al.type === 'move') return { text: `${envelopeName(account, al.from)} → ${envelopeName(account, al.to)} ${formatPence(al.amount)}`, cls: 'env-move-tag' };
  return { text: 'Unallocated', cls: 'env-unalloc' };
}

/** "Transport" / "Maintenance + Health" for a recurring item's envelopes. */
function splitsNames(splits, account) {
  return (splits ?? []).map((s) => envelopeName(account, s.envelopeId)).join(' + ');
}

/**
 * The envelope field used by the entry form and the recurring editor:
 * a drop-down of envelopes (+ Unallocated, + Split…), and when splitting an
 * amount box per envelope with what's left to assign and "Split evenly".
 */
function envelopePicker({ getAmount }) {
  let acct = null;
  let allowSplit = true;
  let inputs = new Map();
  const select = h('select', { class: 'env-select' });
  const label = h('span', {});
  const rows = h('div', { class: 'env-split-rows' });
  const left = h('div', { class: 'env-left small' });
  const evenBtn = h('button', { type: 'button', class: 'btn-secondary btn-small', onclick: () => fillEvenly() }, 'Split evenly (interest)');
  const panel = h('div', { class: 'env-split', hidden: true }, rows, h('div', { class: 'env-split-foot' }, left, evenBtn));
  const el = h('div', { class: 'env-field' }, h('label', { class: 'field' }, label, select), panel);

  function build(initial) {
    const ids = (initial ?? []).map((s) => s.envelopeId);
    const shown = envelopeList(acct, { includeHidden: true }).filter((e) => !e.hidden || ids.includes(e.id));
    label.textContent = `Envelope · ${acct.name}`;
    select.replaceChildren(
      ...shown.map((e) => h('option', { value: e.id }, e.hidden ? `${e.name} (hidden)` : e.name)),
      h('option', { value: '' }, 'Unallocated — choose later'),
      allowSplit ? h('option', { value: '*split' }, 'Split between envelopes…') : null);
    inputs = new Map();
    rows.replaceChildren(...shown.map((e) => {
      const inp = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'amount-input', placeholder: '0.00', dataset: { env: e.id } });
      inp.addEventListener('input', updateLeft);
      inputs.set(e.id, inp);
      return h('label', { class: 'env-split-row' }, h('span', {}, e.name), inp);
    }));
    if (!initial?.length) select.value = '';
    else if (initial.length === 1 || !allowSplit) select.value = initial[0].envelopeId;
    else {
      select.value = '*split';
      for (const s of initial) { const inp = inputs.get(s.envelopeId); if (inp) inp.value = penceToInput(s.amount); }
    }
    sync();
  }
  function sync() {
    panel.hidden = select.value !== '*split';
    updateLeft();
  }
  function typedTotal() {
    let total = 0;
    for (const inp of inputs.values()) {
      if (!inp.value.trim()) continue;
      const p = parseAmount(inp.value);
      if (p === null) return null;
      total += p;
    }
    return total;
  }
  function updateLeft() {
    if (panel.hidden) return;
    const amt = getAmount();
    const typed = typedTotal();
    left.classList.remove('ok', 'off');
    if (!amt) { left.textContent = 'Enter the amount first.'; return; }
    if (typed === null) { left.textContent = 'Amounts should look like 12.34'; left.classList.add('off'); return; }
    const diff = amt - typed;
    if (diff === 0) { left.textContent = `✓ Adds up to ${formatPence(amt)}`; left.classList.add('ok'); }
    else if (diff > 0) { left.textContent = `${formatPence(diff)} still to put in an envelope`; left.classList.add('off'); }
    else { left.textContent = `${formatPence(-diff)} too much`; left.classList.add('off'); }
  }
  function fillEvenly() {
    const amt = getAmount();
    if (!amt) return toast('Enter the amount first', 'error');
    const visible = envelopeList(acct).map((e) => e.id);
    const even = new Map(splitEvenly(amt, visible).map((s) => [s.envelopeId, s.amount]));
    for (const [id, inp] of inputs) inp.value = even.has(id) ? penceToInput(even.get(id)) : '';
    updateLeft();
  }
  select.addEventListener('change', () => {
    // switching to Split with a single envelope chosen before: start from that
    if (select.value === '*split' && typedTotal() === 0 && select.dataset.last && inputs.has(select.dataset.last) && getAmount()) {
      inputs.get(select.dataset.last).value = penceToInput(getAmount());
    }
    if (select.value !== '*split') select.dataset.last = select.value;
    sync();
  });

  return {
    el,
    get accountId() { return acct?.id ?? null; },
    setAccount(account, initial = null, opts = {}) {
      acct = account;
      allowSplit = opts.allowSplit ?? true;
      build(initial);
      select.dataset.last = select.value === '*split' ? '' : select.value;
    },
    /** { splits } (null = Unallocated) or { error } */
    value() {
      const v = select.value;
      if (v === '') return { splits: null };
      if (v !== '*split') return { splits: [{ envelopeId: v, amount: getAmount() ?? 0 }] };
      const out = [];
      for (const [id, inp] of inputs) {
        if (!inp.value.trim()) continue;
        const p = parseAmount(inp.value);
        if (p === null) return { error: 'Envelope amounts should look like 12.34' };
        if (p > 0) out.push({ envelopeId: id, amount: p });
      }
      return { splits: out };
    },
    setSingle(id) {
      if (![...select.options].some((o) => o.value === id)) return;
      select.value = id;
      select.dataset.last = id;
      sync();
    },
    refresh: updateLeft,
  };
}

/** Move money between envelopes (or edit/delete a move). Reuses the entry sheet. */
function openMoveDialog({ accountId, txId = null, fromId, toId }) {
  const dlg = $('txDialog');
  const existing = txId ? state.ledger.transactions.find((t) => t.id === txId) : null;
  const account = accountById(existing?.accountId ?? accountId);
  if (!envelopeConfig(account)) return;
  const al = existing ? allocationOf(existing, account) : null;
  const bal = envelopeBalances(state.ledger, account, todayIso());
  const balOf = (id) => (id === UNALLOCATED ? bal.unallocated : bal.byId[id] ?? 0);
  const ids = [...envelopeList(account).map((e) => e.id), ''];
  const option = (id, selected) => h('option', { value: id, selected: id === selected }, `${envelopeName(account, id || null)} · ${formatPence(balOf(id || null))}`);
  const from = h('select', {}, ids.map((id) => option(id, existing ? al.from ?? '' : fromId ?? ids[0])));
  const to = h('select', {}, ids.map((id) => option(id, existing ? al.to ?? '' : toId ?? ids[1] ?? '')));
  const amount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'amount-input big', placeholder: '0.00', value: existing ? penceToInput(al.amount) : '' });
  const desc = h('input', { type: 'text', autocomplete: 'off', placeholder: 'e.g. Glasses — not enough in Health', value: existing?.description ?? '' });
  const date = h('input', { type: 'date', required: true, value: existing?.date ?? todayIso() });
  const s = institutionStyle(account.institution);
  const form = h('form', {
    method: 'dialog', class: 'sheet-body',
    onsubmit: (e) => {
      e.preventDefault();
      const pence = parseAmount(amount.value);
      if (pence === null) return toast('Enter an amount like 12.34', 'error');
      const fields = { accountId: account.id, date: date.value, amount: pence, fromEnvelopeId: from.value || null, toEnvelopeId: to.value || null, description: desc.value };
      const next = attempt(() => (existing ? updateEnvelopeMove(state.ledger, existing.id, fields) : addEnvelopeMove(state.ledger, fields)));
      if (!next) return;
      dlg.close();
      commit(next, existing ? 'Move updated' : 'Moved');
    },
  },
  h('header', { class: 'sheet-head', style: { '--acc': s.colour } },
    swatch(account),
    h('h2', {}, `${existing ? 'Edit move' : 'Move between envelopes'} · ${account.name}`),
    h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
  h('p', { class: 'muted small' }, 'Moves money from one envelope to another inside this account — the account’s balance doesn’t change.'),
  h('div', { class: 'field-pair' },
    h('label', { class: 'field' }, h('span', {}, 'From'), from),
    h('label', { class: 'field' }, h('span', {}, 'To'), to)),
  h('label', { class: 'field' }, h('span', {}, 'Amount (£)'), amount),
  h('label', { class: 'field' }, h('span', {}, 'Description'), desc),
  h('label', { class: 'field' }, h('span', {}, 'Date'), date),
  h('div', { class: 'sheet-actions' },
    existing ? h('button', {
      type: 'button', class: 'btn-danger',
      onclick: () => {
        if (!confirm('Delete this move?')) return;
        dlg.close();
        commit(deleteTransaction(state.ledger, existing.id), 'Deleted');
      },
    }, 'Delete') : h('span'),
    h('button', { type: 'submit', class: 'btn-primary' }, existing ? 'Save' : 'Move')));
  dlg.replaceChildren(form);
  openDialog(dlg);
  if (!existing) setTimeout(() => amount.focus(), 50);
}

/** Open the envelopes view for an account: all envelopes, or one envelope's history (null = Unallocated). */
function openEnvelopeDialog(accountId, envelopeId) {
  state.envView = { accountId, envelopeId };
  renderEnvelopeDialog();
  openDialog($('envelopeDialog'));
}

function renderEnvelopeDialog() {
  const dlg = $('envelopeDialog');
  const { accountId, envelopeId } = state.envView ?? {};
  const account = accountById(accountId);
  if (!envelopeConfig(account)) { if (dlg.open) dlg.close(); return; }
  const today = todayIso();
  const view = viewLedger();
  const eomIso = endOfMonthIso(today);
  const now = envelopeBalances(state.ledger, account, today);
  const end = envelopeBalances(view, account, eomIso);
  const waiting = unallocatedEntries(state.ledger, account);
  const s = institutionStyle(account.institution);
  const close = h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕');

  if (envelopeId === undefined) {
    const shown = envelopeList(account, { includeHidden: true }).filter((e) => !e.hidden || now.byId[e.id] || end.byId[e.id]);
    const line = (id, name, a, b, extra = null, cls = '') => h('tr', { class: `clickable ${cls}`, onclick: () => { state.envView = { accountId, envelopeId: id }; renderEnvelopeDialog(); } },
      h('td', {}, name, extra),
      h('td', { class: `num ${a < 0 ? 'neg' : ''}` }, formatPence(a)),
      h('td', { class: `num muted ${b < 0 ? 'neg' : ''}` }, formatPence(b)));
    const table = h('table', { class: 'env-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Envelope'), h('th', { class: 'num' }, 'Today'), h('th', { class: 'num' }, `End of ${monthYearLabel(eomIso)}`))),
      h('tbody', {},
        shown.map((e) => line(e.id, e.hidden ? `${e.name} (hidden)` : e.name, now.byId[e.id], end.byId[e.id])),
        line(UNALLOCATED, 'Unallocated', now.unallocated, end.unallocated,
          waiting.length ? h('span', { class: 'env-waiting' }, ` · ${waiting.length} ${waiting.length === 1 ? 'entry' : 'entries'} to assign`) : null,
          waiting.length || now.unallocated ? 'env-unalloc-row' : 'muted')),
      h('tfoot', {}, h('tr', {}, h('td', {}, account.name), h('td', { class: 'num' }, formatPence(now.total)), h('td', { class: 'num muted' }, formatPence(end.total)))));
    dlg.replaceChildren(h('div', { class: 'sheet-body' },
      h('header', { class: 'sheet-head', style: { '--acc': s.colour } }, swatch(account), h('h2', {}, `Envelopes · ${account.name}`), close),
      table,
      h('p', { class: 'muted small' }, 'Click an envelope to see its entries with a running balance. Unallocated is money in the account not in any envelope — entries made before envelopes were set up start there.'),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn-secondary', onclick: () => openAccountDialog(account.id) }, 'Envelope settings…'),
        h('button', { type: 'button', class: 'btn-primary', onclick: () => openMoveDialog({ accountId: account.id }) }, 'Move between envelopes…'))));
    return;
  }

  // one envelope's own history, oldest first, like a column of the pots spreadsheet
  const name = envelopeName(account, envelopeId);
  const hist = envelopeHistory(view, account, envelopeId);
  const list = h('ul', { class: 'env-hist' },
    h('li', { class: 'env-hist-row muted' },
      h('span', { class: 'env-hist-date' }, shortDate(account.openingDate)),
      h('span', { class: 'env-hist-desc' }, 'Brought forward'),
      h('span', { class: 'env-hist-amt' }, ''),
      h('span', { class: 'env-hist-bal' }, formatPence(hist.opening))));
  for (const { transaction: t, change, balance } of hist.rows) {
    const p = t.isProjected ? t.projection : null;
    const move = isEnvelopeMove(t);
    const open = () => (p ? openProjection(p) : move ? openMoveDialog({ txId: t.id }) : openTxDialog({ txId: t.id }));
    const split = !move && t.envelopeSplits?.length > 1 ? ` (part of ${formatPence(t.amount)})` : '';
    list.append(h('li', {}, h('button', {
      type: 'button', class: `env-hist-row ${t.date > today ? 'future' : ''} ${p ? 'projected' : ''} ${p?.skipped ? 'skipped' : ''}`,
      dataset: { date: t.date }, onclick: open,
    },
      h('span', { class: 'env-hist-date' }, shortDate(t.date)),
      h('span', { class: 'env-hist-desc' }, p ? '↻ ' : '', move ? '⇄ ' : '', t.description || '(no description)', h('span', { class: 'muted' }, split)),
      h('span', { class: `env-hist-amt ${change > 0 ? 'credit' : ''}` }, `${change > 0 ? '+' : '−'}${formatPence(Math.abs(change))}`),
      h('span', { class: `env-hist-bal ${balance < 0 ? 'neg' : ''}` }, p?.skipped ? 'skipped' : formatPence(balance)))));
  }
  const isUnalloc = envelopeId === UNALLOCATED;
  dlg.replaceChildren(h('div', { class: 'sheet-body' },
    h('header', { class: 'sheet-head', style: { '--acc': s.colour } },
      h('button', { type: 'button', class: 'btn-ghost env-back', onclick: () => { state.envView = { accountId, envelopeId: undefined }; renderEnvelopeDialog(); } }, '‹ All'),
      h('h2', {}, name), close),
    h('div', { class: 'recon-summary' },
      h('div', { class: 'recon-line' }, h('span', {}, 'Today'), h('strong', { class: (isUnalloc ? now.unallocated : now.byId[envelopeId]) < 0 ? 'neg' : '' }, formatPence(isUnalloc ? now.unallocated : now.byId[envelopeId]))),
      h('div', { class: 'recon-line muted' }, h('span', {}, `End of ${monthYearLabel(eomIso)}`), h('span', {}, formatPence(isUnalloc ? end.unallocated : end.byId[envelopeId])))),
    isUnalloc && waiting.length ? h('p', { class: 'warn small' }, `${waiting.length} ${waiting.length === 1 ? 'entry is' : 'entries are'} not in an envelope yet — click one to choose its envelope.`) : null,
    hist.rows.length ? list : h('p', { class: 'muted' }, 'Nothing in this envelope yet.'),
    h('div', { class: 'sheet-actions' },
      h('span'),
      h('button', { type: 'button', class: 'btn-secondary', onclick: () => openMoveDialog({ accountId: account.id, fromId: isUnalloc ? '' : envelopeId }) }, 'Move from here…'))));
  // land at today
  requestAnimationFrame(() => {
    const rowsUpToToday = [...list.querySelectorAll('.env-hist-row[data-date]')].filter((r) => r.dataset.date <= today);
    rowsUpToToday.pop()?.scrollIntoView({ block: 'center' });
  });
}

/** Envelope balances under an account header (grid) — click for the breakdown. */
function envHeaderBlock(account, today) {
  if (!envelopeConfig(account)) return null;
  const b = envelopeBalances(state.ledger, account, today);
  const waiting = unallocatedEntries(state.ledger, account).length;
  return h('button', { type: 'button', class: 'acc-env', title: 'Envelopes — click for each one’s entries', onclick: () => openEnvelopeDialog(account.id) },
    envelopeList(account).map((e) => h('span', { class: 'acc-env-line' },
      h('span', { class: 'acc-env-name' }, e.name), h('span', { class: `acc-env-amt ${b.byId[e.id] < 0 ? 'neg' : ''}` }, formatPence(b.byId[e.id])))),
    b.unallocated || waiting ? h('span', { class: 'acc-env-line env-unalloc' },
      h('span', { class: 'acc-env-name' }, waiting ? `Unallocated (${waiting} to assign)` : 'Unallocated'),
      h('span', { class: 'acc-env-amt' }, formatPence(b.unallocated))) : null);
}

/** Envelope chips in the phone banner — tap for the breakdown. */
function envBannerBlock(account, today) {
  if (!envelopeConfig(account)) return null;
  const b = envelopeBalances(state.ledger, account, today);
  const waiting = unallocatedEntries(state.ledger, account).length;
  return h('div', { class: 'banner-env' },
    envelopeList(account).map((e) => h('button', { type: 'button', class: 'env-chip', onclick: () => openEnvelopeDialog(account.id, e.id) },
      h('span', {}, e.name), h('strong', {}, formatPence(b.byId[e.id])))),
    b.unallocated || waiting ? h('button', { type: 'button', class: 'env-chip env-chip-unalloc', onclick: () => openEnvelopeDialog(account.id, UNALLOCATED) },
      h('span', {}, waiting ? `Unallocated · ${waiting} to assign` : 'Unallocated'), h('strong', {}, formatPence(b.unallocated))) : null,
    h('button', { type: 'button', class: 'env-chip env-chip-more', onclick: () => openEnvelopeDialog(account.id) }, 'Envelopes ›'));
}

/** The envelopes part of the account dialog. */
function envelopeSettings(existing) {
  const inUse = existing ? envelopesInUse(state.ledger, existing.id) : new Set();
  let rows = (existing?.envelopes?.list ?? []).map((e) => ({ ...e }));
  const on = h('input', { type: 'checkbox', checked: Boolean(envelopeConfig(existing)) });
  const list = h('div', { class: 'env-set-rows' });
  const summary = h('div', { class: 'muted small env-set-summary' });
  let openingInput = null; // the account's opening balance box, for the summary
  const readSigned = (raw) => {
    const t = raw.trim();
    if (t === '') return 0;
    const neg = t.startsWith('-');
    const p = parseAmount(neg ? t.slice(1) : t);
    return p === null ? null : neg ? -p : p;
  };
  function readRows() {
    for (const row of list.querySelectorAll('.env-set-row')) {
      const r = rows.find((x) => x.id === row.dataset.id);
      if (!r) continue;
      r.name = row.querySelector('.env-set-name').value;
      r.openingText = row.querySelector('.env-set-open').value;
      r.hidden = row.querySelector('.env-set-hide')?.checked ?? false;
    }
  }
  function draw() {
    list.replaceChildren(...rows.map((r, i) => {
      const used = inUse.has(r.id);
      const name = h('input', { type: 'text', class: 'env-set-name', value: r.name ?? '', placeholder: 'e.g. Transport', 'aria-label': 'Envelope name' });
      const open = h('input', { type: 'text', inputmode: 'decimal', class: 'amount-input env-set-open', 'aria-label': `Opening amount for ${r.name || 'this envelope'}`, placeholder: '0.00', value: r.openingText ?? (r.openingBalance ? penceToInput(r.openingBalance) : '') });
      open.addEventListener('input', updateSummary);
      return h('div', { class: 'env-set-row', dataset: { id: r.id } },
        name, open,
        h('button', { type: 'button', class: 'btn-ghost icon-btn', title: 'Move up', disabled: i === 0, onclick: () => { readRows(); [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; draw(); } }, '↑'),
        used
          ? h('label', { class: 'check env-set-hidecheck', title: 'Has entries — hide it instead of removing it' }, h('input', { type: 'checkbox', class: 'env-set-hide', checked: Boolean(r.hidden) }), h('span', {}, 'Hide'))
          : h('button', { type: 'button', class: 'btn-ghost icon-btn', title: 'Remove', 'aria-label': `Remove ${r.name || 'envelope'}`, onclick: () => { readRows(); rows.splice(i, 1); draw(); } }, '✕'));
    }));
    updateSummary();
  }
  function updateSummary() {
    readRows();
    const opening = openingInput ? readSigned(openingInput.value) : existing?.openingBalance ?? 0;
    const inEnv = rows.reduce((s, r) => s + (readSigned(r.openingText ?? (r.openingBalance ? penceToInput(r.openingBalance) : '')) ?? 0), 0);
    summary.textContent = opening === null ? '' : `Opening balance ${formatPence(opening)} · in envelopes ${formatPence(inEnv)} · Unallocated ${formatPence(opening - inEnv)}`;
  }
  const body = h('div', { class: 'env-set-body' },
    h('div', { class: 'env-set-head muted small' }, h('span', {}, 'Name'), h('span', {}, 'At opening date (£)')),
    list,
    h('button', { type: 'button', class: 'btn-secondary btn-small', onclick: () => { readRows(); rows.push({ id: newEnvelope('').id, name: '', openingBalance: 0, hidden: false }); draw(); list.querySelector('.env-set-row:last-child .env-set-name')?.focus(); } }, '+ Add envelope'),
    summary,
    h('div', { class: 'muted small' }, 'Each envelope’s share of the account on its opening date; anything not in an envelope is Unallocated. Entries already in the account start as Unallocated — choose their envelope from the Envelopes view. The first envelopes get the spare penny when interest is split evenly.'));
  const syncOn = () => { body.hidden = !on.checked; if (on.checked && !rows.length) { rows.push({ id: newEnvelope('').id, name: '', openingBalance: 0, hidden: false }); draw(); } };
  on.addEventListener('change', syncOn);
  const el = h('fieldset', { class: 'stmt-settings env-settings' },
    h('legend', {}, 'Envelopes'),
    h('label', { class: 'check' }, on, h('span', {}, 'Split this account into envelopes (pots)')),
    body);
  draw();
  syncOn();
  return {
    el,
    watchOpening(input) { openingInput = input; input.addEventListener('input', updateSummary); updateSummary(); },
    /** { envelopes } for updateAccount/addAccount, or { error } */
    value() {
      readRows();
      const list2 = [];
      for (const r of rows) {
        const opening = readSigned(r.openingText ?? (r.openingBalance ? penceToInput(r.openingBalance) : ''));
        if (opening === null) return { error: `Opening amount for ${r.name || 'an envelope'} should look like 123.45` };
        if (!r.name.trim() && !opening && !inUse.has(r.id)) continue; // an empty row left over
        list2.push({ id: r.id, name: r.name, openingBalance: opening, hidden: Boolean(r.hidden) });
      }
      if (!on.checked) return { envelopes: existing?.envelopes ? { enabled: false, list: list2 } : null };
      return { envelopes: list2.length ? { enabled: true, list: list2 } : null };
    },
  };
}

// ------------------------------------------------------------------ account dialog

function openAccountDialog(accountId) {
  const dlg = $('accountDialog');
  const existing = accountId ? accountById(accountId) : null;
  const txCount = existing ? state.ledger.transactions.filter((t) => t.accountId === existing.id).length : 0;

  const name = h('input', { type: 'text', required: true, value: existing?.name ?? '', placeholder: 'e.g. Monzo' });
  const type = h('select', {},
    [['current', 'Current account'], ['savings', 'Savings'], ['credit', 'Credit card'], ['loan', 'Loan / credit account']].map(([v, l]) => h('option', { value: v, selected: (existing?.type ?? 'current') === v }, l)));
  const isJoint = isJointAccount(existing); // v0.14
  const inst = h('select', {}, Object.entries(INSTITUTIONS).filter(([k]) => k !== 'joint' || isJoint).map(([k, v]) => h('option', { value: k, selected: (existing?.institution ?? 'other') === k }, v.label)));
  // v0.14: a loan is stored as a negative balance but typed (and shown) as the amount owed
  const openingShown = existing ? (isLoan(existing) ? -existing.openingBalance : existing.openingBalance) : null;
  const opening = h('input', { type: 'text', inputmode: 'decimal', class: 'amount-input', value: openingShown === null ? '' : `${openingShown < 0 ? '-' : ''}${penceToInput(Math.abs(openingShown))}`, placeholder: '0.00' });
  // v0.14 limits
  const limitInput = (v) => h('input', { type: 'text', inputmode: 'decimal', class: 'amount-input', placeholder: 'none', value: Number.isInteger(v) && v > 0 ? penceToInput(v) : '' });
  const overdraft = limitInput(existing?.overdraftLimit);
  const creditLimit = limitInput(existing?.creditLimit);
  const overdraftField = h('label', { class: 'field' }, h('span', {}, 'Arranged overdraft limit (£)'), overdraft,
    h('span', { class: 'muted small' }, 'Leave blank for none. You’re warned before anything takes the account into it, and more strongly past it.'));
  const creditLimitField = h('label', { class: 'field' }, h('span', {}, 'Credit limit (£)'), creditLimit,
    h('span', { class: 'muted small' }, 'Leave blank for none. You’re warned before anything takes the card over it.'));
  const loanNote = h('p', { class: 'muted small' }, 'Shown as the amount owed. Repayments go in; money can’t be transferred out. Interest isn’t worked out — add any charge or interest as an entry on the day.');
  const readLimit = (input, what) => {
    const t = input.value.trim();
    if (t === '') return { value: null };
    const pence = parseAmount(t);
    return pence === null ? { error: `${what} should look like 500.00, or be blank` } : { value: pence };
  };
  const openingLabel = h('span', {});
  const openingDate = h('input', { type: 'date', required: true, value: existing?.openingDate ?? firstOfMonthIso() });
  const hidden = h('input', { type: 'checkbox', checked: existing ? !existing.active : false });
  const envSettings = envelopeSettings(existing); // v0.12
  envSettings.watchOpening(opening);

  // Card statements (v0.7)
  const cc = existing?.creditCard ?? null;
  const stmtDay = h('input', { type: 'text', inputmode: 'numeric', class: 'amount-input', placeholder: 'e.g. 13', value: cc?.statementWorkingDay ?? '' });
  const payDays = h('input', { type: 'text', inputmode: 'numeric', class: 'amount-input', placeholder: String(DEFAULT_PAYMENT_DAYS), value: cc?.paymentDaysAfter ?? '' });
  const stmtPreview = h('div', { class: 'muted small' });
  const readInt = (input) => (input.value.trim() === '' ? null : Number(input.value.trim()));
  const stmtSection = h('fieldset', { class: 'stmt-settings' },
    h('legend', {}, 'Statements'),
    h('div', { class: 'field-pair' },
      h('label', { class: 'field' }, h('span', {}, 'Statement on working day no.'), stmtDay),
      h('label', { class: 'field' }, h('span', {}, 'Payment due, days after'), payDays)),
    stmtPreview,
    h('div', { class: 'muted small' }, 'Working days skip weekends and bank holidays; a due date on one moves to the next working day. Barclaycard: 13 and 25. Leave the first box blank if you don’t want statements for this card.'));
  function syncStatementPreview() {
    const wd = readInt(stmtDay);
    const days = readInt(payDays) ?? DEFAULT_PAYMENT_DAYS;
    if (wd === null) { stmtPreview.textContent = 'No statements for this card.'; return; }
    if (!Number.isInteger(wd) || wd < 1 || wd > 20 || !Number.isInteger(days) || days < 1 || days > 60) { stmtPreview.textContent = 'Working day 1–20, days 1–60.'; return; }
    const probe = { type: 'credit', creditCard: { statementWorkingDay: wd, paymentDaysAfter: days } };
    const today = todayIso();
    let m = monthOf(today);
    if (statementDate(probe, m, state.holidays) < today) m = addMonths(m, 1);
    stmtPreview.textContent = `Next statement ${longDate(statementDate(probe, m, state.holidays))} · payment due ${longDate(paymentDueDate(probe, m, state.holidays))}`;
  }
  for (const el of [stmtDay, payDays]) el.addEventListener('input', syncStatementPreview);
  syncStatementPreview();

  let shownType = type.value;
  const syncType = () => {
    // v0.14: switching to or from a loan flips the figure, so it keeps meaning the same money
    if ((shownType === 'loan') !== (type.value === 'loan') && opening.value.trim()) {
      const raw = opening.value.trim();
      opening.value = raw.startsWith('-') ? raw.slice(1) : `-${raw}`;
    }
    shownType = type.value;
    openingLabel.textContent = type.value === 'credit' || type.value === 'loan' ? 'Amount owed at opening date (£)' : 'Opening balance (£)';
    stmtSection.hidden = type.value !== 'credit';
    envSettings.el.hidden = type.value === 'credit' || type.value === 'loan' || isJoint;
    overdraftField.hidden = type.value === 'credit' || type.value === 'loan';
    creditLimitField.hidden = type.value !== 'credit';
    loanNote.hidden = type.value !== 'loan';
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
      const typed = negative ? -pence : pence;
      const fields = { name: name.value, type: type.value, institution: inst.value, openingBalance: type.value === 'loan' ? -typed : typed, openingDate: openingDate.value };
      if (type.value === 'credit') {
        const cl = readLimit(creditLimit, 'Credit limit');
        if (cl.error) return toast(cl.error, 'error');
        fields.creditLimit = cl.value;
      } else if (type.value !== 'loan') {
        const od = readLimit(overdraft, 'Overdraft limit');
        if (od.error) return toast(od.error, 'error');
        fields.overdraftLimit = od.value;
      }
      if (type.value === 'credit') {
        const wd = readInt(stmtDay);
        const days = readInt(payDays);
        if (wd !== null && Number.isNaN(wd)) return toast('Statement working day should be a number 1–20', 'error');
        if (days !== null && Number.isNaN(days)) return toast('Payment days should be a number 1–60', 'error');
        fields.creditCard = {
          ...(cc ?? { nextStatementDateOverride: null, statementBalance: 0 }),
          statementWorkingDay: wd,
          paymentDaysAfter: wd === null ? cc?.paymentDaysAfter ?? null : days,
        };
      } else if (!isJoint && type.value !== 'loan') {
        const env = envSettings.value();
        if (env.error) return toast(env.error, 'error');
        fields.envelopes = env.envelopes;
      }
      let next;
      if (existing) next = attempt(() => updateAccount(state.ledger, existing.id, { ...fields, name: fields.name.trim(), active: !hidden.checked }));
      else {
        const r = attempt(() => addAccount(state.ledger, fields));
        next = r?.ledger;
        if (r) state.activeAccountId = r.account.id;
      }
      if (!next) return;
      if (!limitsOK(next)) return; // a new opening balance or limit
      dlg.close();
      commit(next, existing ? 'Account updated' : 'Account added');
      if (isOpen('settingsDialog')) renderSettings();
    },
  },
  h('header', { class: 'sheet-head' },
    isJoint ? peopleIcon(18) : null,
    h('h2', {}, existing ? 'Edit account' : 'New account'),
    h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
  h('label', { class: 'field' }, h('span', {}, 'Name'), name),
  isJoint
    ? h('p', { class: 'muted small' }, `Your joint account with Alison. Kept in its own Drive file (My Drive/${JOINT_FOLDER_NAME}/${JOINT_FILE_NAME}), apart from your own accounts.`)
    : h('div', { class: 'field-pair' },
        h('label', { class: 'field' }, h('span', {}, 'Type'), type),
        h('label', { class: 'field' }, h('span', {}, 'Colour (bank)'), inst)),
  h('div', { class: 'field-pair' },
    h('label', { class: 'field' }, openingLabel, opening),
    h('label', { class: 'field' }, h('span', {}, 'Opening date'), openingDate)),
  loanNote,
  overdraftField,
  creditLimitField,
  stmtSection,
  envSettings.el,
  existing ? h('label', { class: 'check' }, hidden, h('span', {}, 'Hide this account (keeps its history)')) : null,
  h('div', { class: 'sheet-actions' },
    existing && !isJoint ? h('button', {
      type: 'button', class: 'btn-danger', disabled: txCount > 0, title: txCount ? `Has ${txCount} entries — hide it instead` : '',
      onclick: () => {
        if (!confirm(`Delete ${existing.name}?`)) return;
        const next = attempt(() => deleteAccount(state.ledger, existing.id));
        if (!next) return;
        dlg.close();
        commit(next, 'Account deleted');
        if (isOpen('settingsDialog')) renderSettings();
      },
    }, txCount ? `Delete (has ${txCount} entries)` : 'Delete') : h('span'),
    h('button', { type: 'submit', class: 'btn-primary' }, existing ? 'Save' : 'Add account')));

  dlg.replaceChildren(form);
  openDialog(dlg);
}

// ------------------------------------------------------------------ settings / backup

/**
 * v0.13 ⚙ Ticket purchases: which card, envelope, ring-fence account and
 * return account; and the day to start from (the day it's switched on, unless changed).
 */
function ticketSection() {
  const l = state.ledger;
  const rec = ticketSettingsRecord(l);
  const own = l.accounts.filter((a) => !isJointAccount(a)); // v0.14: ticket purchases are personal only
  const cards = own.filter((a) => a.type === 'credit' && statementConfig(a));
  const envOptions = own.filter((a) => envelopeConfig(a)).flatMap((a) => envelopeList(a).map((e) => ({ value: `${a.id}|${e.id}`, label: `${e.name} · ${a.name}`, name: e.name })));
  const plain = own.filter((a) => a.type !== 'credit' && !isLoan(a) && a.active);
  const intro = h('p', { class: 'muted small' }, 'Puts each ticket the ticket tracker says you’ve bought — or will buy — on the card on its purchase day, with the same amount ring-fenced from your envelope, and moved back the day before the card is paid.');
  if (!cards.length || !envOptions.length || plain.length < 2) {
    return h('section', { class: 'settings-section', id: 'ticketSection' }, h('h3', {}, 'Ticket purchases'), intro,
      h('p', { class: 'muted small' }, 'Needs a credit card with its statement date set, an account with envelopes, and two other accounts (Safe keeping and your current account).'));
  }
  const pick = (list, re) => list.find((a) => re.test(a.name))?.id ?? list[0]?.id ?? '';
  const select = (list, value) => h('select', {}, list.map((a) => h('option', { value: a.id, selected: a.id === value }, a.name)));
  const on = h('input', { type: 'checkbox', checked: Boolean(rec?.enabled) });
  const card = select(cards, rec?.cardAccountId ?? pick(cards, /barclay/i));
  const envValue = rec ? `${rec.envelopeAccountId}|${rec.envelopeId}` : envOptions.find((o) => /transport/i.test(o.name))?.value ?? envOptions[0].value;
  const env = h('select', {}, envOptions.map((o) => h('option', { value: o.value, selected: o.value === envValue }, o.label)));
  const safe = select(plain, rec?.safeAccountId ?? pick(plain, /safe/i));
  const back = select(plain, rec?.returnAccountId ?? (plain.find((a) => a.type === 'current')?.id ?? plain[0].id));
  const start = h('input', { type: 'date', value: rec?.startDate ?? todayIso() });
  const fields = h('div', { hidden: !on.checked },
    h('label', { class: 'field' }, h('span', {}, 'Card the tickets go on'), card),
    h('label', { class: 'field' }, h('span', {}, 'Ring-fenced from (envelope)'), env),
    h('label', { class: 'field' }, h('span', {}, 'Ring-fence account'), safe),
    h('label', { class: 'field' }, h('span', {}, 'Money goes back to'), back),
    h('label', { class: 'field' }, h('span', {}, 'Start from'), start,
      h('div', { class: 'muted small' }, 'Tickets bought before this day are left out — enter those by hand. It’s the day you switch this on unless you change it.')));
  on.addEventListener('change', () => { fields.hidden = !on.checked; if (on.checked && !rec?.startDate) start.value = todayIso(); });
  const problem = rec?.enabled ? ticketSettingsProblem(l, rec) : null;
  const save = () => {
    const [envelopeAccountId, envelopeId] = env.value.split('|');
    const next = attempt(() => setTicketSettings(state.ledger, {
      enabled: on.checked, cardAccountId: card.value, envelopeAccountId, envelopeId, safeAccountId: safe.value, returnAccountId: back.value, startDate: start.value,
    }));
    if (!next) return;
    const turnedOn = on.checked && !rec?.enabled;
    const saved = commit(next, on.checked ? 'Ticket purchases saved' : 'Ticket purchases off'); // sets state.ledger straight away
    // read the tracker's file now — started synchronously from the tap, so Google's sign-in window is allowed (Android rule)
    if (turnedOn && sync.isEnabled()) checkTrackerFromTap();
    saved.then(() => { if (isOpen('settingsDialog')) renderSettings(); });
  };
  return h('section', { class: 'settings-section', id: 'ticketSection' },
    h('h3', {}, 'Ticket purchases'), intro,
    h('label', { class: 'check' }, on, h('span', {}, 'Show ticket purchases from the ticket tracker')),
    problem ? h('p', { class: 'small warn' }, `Not working: ${problem}`) : null,
    fields,
    !sync.isEnabled() && on.checked ? h('p', { class: 'small warn' }, 'Needs Google Drive sync on — the tickets are read from your Drive.') : null,
    h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn-primary', id: 'ticketSave', onclick: save }, 'Save')));
}

function renderSettings() {
  const dlg = $('settingsDialog');
  const l = state.ledger;
  const canShare = (() => {
    try { return Boolean(navigator.canShare?.({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] })); } catch { return false; }
  })();

  // v0.14: the joint account is pinned first; the arrows move your own accounts among themselves
  const firstOwn = l.accounts.findIndex((a) => !isJointAccount(a));
  const accountsList = h('ul', { class: 'acc-list' },
    l.accounts.map((a, i) => h('li', { class: a.active ? '' : 'inactive' },
      swatch(a),
      h('span', { class: 'acc-list-name' }, a.name, a.active ? '' : ' (hidden)', isJointAccount(a) ? h('span', { class: 'muted small' }, ' · pinned first') : ''),
      isJointAccount(a) ? [h('span', { class: 'icon-btn' }), h('span', { class: 'icon-btn' })] : [
        h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Move up', disabled: i === firstOwn, onclick: () => { commit(moveAccount(state.ledger, a.id, -1)).then(renderSettings); } }, '▲'),
        h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Move down', disabled: i === l.accounts.length - 1, onclick: () => { commit(moveAccount(state.ledger, a.id, 1)).then(renderSettings); } }, '▼')],
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
              if (isOpen('settingsDialog')) renderSettings();
              afterSync(r, true);
            });
          },
        }, 'Connect Google Drive'));

  dlg.replaceChildren(h('div', { class: 'sheet-body' },
    h('header', { class: 'sheet-head' },
      h('h2', {}, 'Settings & backup'),
      h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),

    driveSection,

    jointSection(),

    backupsSection(st),

    usesTracker(l) ? h('section', { class: 'settings-section', id: 'trackerSection' },
      h('h3', {}, 'Ticket tracker'),
      h('p', { class: 'small' }, (() => {
        const items = recurringItems(l).filter((i) => i.amountFrom === TRACKER_SOURCE).map((i) => i.description);
        const amounts = items.length ? `${items.join(', ')} take${items.length === 1 ? 's' : ''} ${items.length === 1 ? 'its' : 'their'} amount from the ticket tracker.` : '';
        return [amounts, ticketSettingsRecord(l)?.enabled ? 'Ticket purchases come from it too.' : ''].filter(Boolean).join(' ');
      })()),
      h('p', { class: `small ${state.tracker?.error ? 'warn' : 'muted'}`, id: 'trackerStatusLine' }, trackerStatusText()),
      state.tracker?.estimates?.ticketsError ? h('p', { class: 'small warn' }, state.tracker.estimates.ticketsError) : null,
      st.enabled ? h('button', { type: 'button', class: 'btn-secondary', onclick: checkTrackerFromTap }, 'Check now') : null) : null,

    ticketSection(),

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
      viewChoice,
      h('p', { class: 'muted small' }, 'In the list (phone), open on:'),
      h('div', { class: 'seg' },
        [['summary', 'Summary'], ['account', 'First account']].map(([v, label]) => h('button', {
          type: 'button', class: 'seg-btn', 'aria-checked': String(state.phoneLanding === v),
          onclick: () => { state.phoneLanding = v; writePref('phoneLanding', v); renderSettings(); },
        }, label)))),

    lockSection(),

    h('section', { class: 'settings-section' },
      h('h3', {}, 'This device'),
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
          // v0.14: the joint account goes off and its local copy goes too (its Drive file is untouched)
          if (jointSync) await jointSync.disconnect();
          jointSync = null;
          state.jointSettings = { enabled: false };
          await saveJointSettings(state.jointSettings);
          await removeJointData();
          state.joint = null;
          state.meta = {};
          await saveMeta(state.meta);
          dlg.close();
          commitParts({ personal: emptyLedger() }, 'All data erased');
        },
      }, 'Erase all data on this device')),

    h('p', { class: 'muted small center' }, `Personal Finance v${APP_VERSION} · ${state.meta.persisted ? 'storage protected' : 'storage may be cleared by the browser — keep exports'}`)));
}

// ------------------------------------------------------------------ v0.14 joint account switch

/**
 * ⚙ Joint account: off by default on every device. Turning it on signs in
 * (from the tap), finds My Drive/Finance Joint/joint.json or makes it, and —
 * the first time ever — asks for the account's opening balance.
 */
function jointSection() {
  const where = `My Drive/${JOINT_FOLDER_NAME}/${JOINT_FILE_NAME}`;
  if (!state.jointSettings.enabled) {
    const remove = h('div', { hidden: true },
      h('button', {
        type: 'button', class: 'btn-ghost btn-small',
        onclick: async () => {
          if (!confirm('Remove the joint account’s data from this device?\n\nOnly this device’s copy goes. The Drive file is not touched — turn the joint account on again to bring it back.')) return;
          await removeJointData();
          renderSettings();
          toast('Joint data removed from this device');
        },
      }, 'Remove joint data from this device'));
    loadJointLedger().then((l) => { remove.hidden = !l; }).catch(() => {});
    return h('section', { class: 'settings-section joint-section' },
      h('h3', {}, peopleIcon(16), ' Joint account'),
      h('p', { class: 'muted small' }, `Your joint account with Alison, in its own Drive file (${where}), kept apart from your own data. Off on this device.`),
      h('button', { type: 'button', class: 'btn-secondary', onclick: turnJointOn }, 'Turn on'),
      remove);
  }
  const st = jointSync?.getState();
  const account = state.joint?.accounts[0] ?? null;
  const head = h('h3', {}, peopleIcon(16), ' Joint account');
  if (!account) {
    if (!st?.lastSyncAt) {
      return h('section', { class: 'settings-section joint-section' }, head,
        h('p', { class: 'small warn' }, 'On, but Drive hasn’t been reached yet, so it isn’t known whether the joint file already exists. Tap the cloud button at the top (or Sync now) to try again.'),
        h('p', { class: 'muted small', id: 'jointStatusLine' }, jointStatusText()),
        h('button', { type: 'button', class: 'btn-ghost btn-small', onclick: turnJointOff }, 'Turn off'));
    }
    return h('section', { class: 'settings-section joint-section' }, head, jointSetupForm(),
      h('button', { type: 'button', class: 'btn-ghost btn-small', onclick: turnJointOff }, 'Turn off'));
  }
  return h('section', { class: 'settings-section joint-section' }, head,
    h('p', { class: 'small' }, `On · file: ${where}`),
    h('p', { class: 'muted small', id: 'jointStatusLine' }, jointStatusText()),
    st?.backupError
      ? h('p', { class: 'warn small' }, `Last joint backup didn’t work: ${st.backupError}. It tries again with the next change.`)
      : h('p', { class: 'muted small' }, `Its own backups in My Drive/${JOINT_FOLDER_NAME}/backups (same rules as yours). Last: ${when(st?.lastBackupAt)}${st?.lastBackupAt ? '' : ' — the first is made with the next change'}.`),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn-secondary', onclick: () => openBackupsDialog(jointSync) }, 'Joint backups…'),
      h('button', { type: 'button', class: 'btn-secondary', onclick: () => doExport(false, 'joint') }, 'Download joint export'),
      h('button', { type: 'button', class: 'btn-ghost', onclick: turnJointOff }, 'Turn off on this device')));
}

/** First time only: the joint file is empty — give the account its opening balance. */
function jointSetupForm() {
  const earliest = state.personal.accounts.map((a) => a.openingDate).sort()[0] ?? firstOfMonthIso();
  const date = h('input', { type: 'date', required: true, value: earliest });
  const amount = h('input', { type: 'text', inputmode: 'decimal', class: 'amount-input', placeholder: '0.00' });
  return h('form', {
    class: 'joint-setup',
    onsubmit: (e) => {
      e.preventDefault();
      const raw = amount.value.trim();
      const negative = raw.startsWith('-');
      const pence = raw === '' ? 0 : parseAmount(negative ? raw.slice(1) : raw);
      if (pence === null) return toast('Opening balance should look like 1234.56', 'error');
      const next = attempt(() => addJointAccount(state.joint, { openingBalance: negative ? -pence : pence, openingDate: date.value }));
      if (!next) return;
      state.activeAccountId = next.accounts[0].id;
      // redraw ⚙ BEFORE toasting (a redraw would wipe the toast — see doExport)
      commitParts({ joint: next }).then(() => { if (isOpen('settingsDialog')) renderSettings(); toast('Joint account added'); });
    },
  },
  h('p', { class: 'small' }, 'Connected. The joint file is new, so give the joint account its balance as it stood at the start of the opening date.'),
  h('div', { class: 'field-pair' },
    h('label', { class: 'field' }, h('span', {}, 'Opening balance (£)'), amount),
    h('label', { class: 'field' }, h('span', {}, 'Opening date'), date)),
  h('button', { type: 'submit', class: 'btn-primary' }, 'Add the joint account'));
}

/** Must be called straight from a tap: the sign-in starts before anything else. */
function turnJointOn() {
  const tokenPromise = auth.getToken({ interactive: true });
  (async () => {
    const token = await tokenPromise;
    if (!token) { toast(auth.lastAuthError?.() ?? 'Google sign-in didn’t complete', 'error'); return; }
    try {
      const [saved, savedSync] = await Promise.all([loadJointLedger(), loadJointSyncState()]);
      state.jointSettings = { enabled: true };
      await saveJointSettings(state.jointSettings);
      state.joint = saved ?? emptyJointLedger();
      recombine();
      jointSync = makeJointEngine();
      await jointSync.init();
      render();
      if (isOpen('settingsDialog')) renderSettings();
      // turned on before: carry on from the last sync; first time here: find or make the file
      const r = savedSync?.enabled ? await jointSync.sync() : await jointSync.connect();
      if (isOpen('settingsDialog')) renderSettings();
      renderSyncChip();
      if (r?.status === 'conflicts') openConflictDialog(jointSync);
      else if (r?.status === 'error' || r?.status === 'needs-tap') toast(`Joint account: ${syncResultText(r, jointSync)}`, 'error');
      else toast(state.joint.accounts.length ? 'Joint account on' : 'Connected — now give the joint account its opening balance');
    } catch (err) {
      toast(`Joint account: ${err.message}`, 'error');
    }
  })();
}

async function turnJointOff() {
  const dirty = jointSync?.getState().dirty;
  if (!confirm('Turn the joint account off on this device?\n\nIt disappears from this device and stops syncing here. Your own accounts aren’t affected. The Drive file stays as it is, and this device keeps its copy so turning it back on is quick.'
    + (dirty ? '\n\nThis device has joint changes that haven’t reached Drive yet — they’ll go when you turn it back on.' : ''))) return;
  state.jointSettings = { enabled: false };
  await saveJointSettings(state.jointSettings);
  jointSync = null;
  state.joint = null;
  recombine();
  render();
  renderSyncChip();
  if (isOpen('settingsDialog')) renderSettings();
  toast('Joint account off on this device');
}

// ------------------------------------------------------------------ automatic backups (v0.9)

function backupsSection(st) {
  if (!st.enabled) {
    return h('section', { class: 'settings-section' },
      h('h3', {}, 'Automatic backups'),
      h('p', { class: 'muted small' }, 'Need Google Drive sync turned on (above). Until then, use Download export below to keep a copy.'));
  }
  return h('section', { class: 'settings-section backups-section' },
    h('h3', {}, 'Automatic backups'),
    h('p', { class: 'muted small' }, `Once a day, just before the first change is saved, Drive keeps a copy in My Drive/${st.location.split('/')[0]}/backups. Kept: the last 30, plus the first of each month for a year.`),
    st.backupError
      ? h('p', { class: 'warn small' }, `Last backup didn’t work: ${st.backupError}. It tries again with the next change.`)
      : h('p', { class: 'muted small' }, `Last backup: ${when(st.lastBackupAt)}${st.lastBackupAt ? '' : ' — the first is made with your next change'}`),
    h('button', { type: 'button', class: 'btn-secondary', onclick: () => openBackupsDialog(sync) }, 'Backups…'));
}

function backupDayLabel(b) {
  const d = longDate(b.info.day);
  return b.info.kind === 'before-restore' ? `${d}, ${b.info.time}` : d;
}

/** Must be called straight from a tap: listing may need Google's sign-in window. */
function openBackupsDialog(engine = sync) {
  const dlg = $('backupsDialog');
  const listing = engine.listBackups(); // starts the sign-in synchronously (Android)
  const isJoint = engine === jointSync;
  const current = () => (isJoint ? state.joint : state.personal); // v0.14: compare with that file's own data
  const close = h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕');
  const head = (title, back) => h('header', { class: 'sheet-head' },
    back ? h('button', { type: 'button', class: 'btn-ghost', onclick: back }, '‹ Back') : null,
    h('h2', {}, title), close);
  const show = (...children) => dlg.replaceChildren(h('div', { class: 'sheet-body' }, ...children));

  let backups = [];
  const title = isJoint ? 'Joint account backups' : 'Backups';
  function drawList() {
    const intro = h('p', { class: 'muted small' }, 'Each backup is your data as it was just before that day’s first change. Pick one to see what’s in it before restoring.');
    if (!backups.length) {
      show(head(title), intro, h('p', { class: 'muted' }, 'No backups yet. The first is made the next time a change is saved to Drive.'));
      return;
    }
    show(head(title), intro,
      h('ul', { class: 'rec-list backup-list' }, backups.map((b) => h('li', {}, h('button', {
        type: 'button', class: 'rec-row', onclick: () => openBackup(b),
      }, h('span', { class: 'rec-main' },
        h('span', { class: 'rec-name' }, backupDayLabel(b),
          b.info.kind === 'before-restore' ? h('span', { class: 'backup-tag' }, 'before a restore') : null,
          b.monthly ? h('span', { class: 'backup-tag' }, 'monthly') : null)))))));
  }

  async function openBackup(b) {
    show(head(backupDayLabel(b), drawList), h('p', { class: 'muted' }, 'Opening…'));
    let parsed;
    try {
      parsed = await engine.readBackup(b.id);
    } catch (err) {
      show(head(backupDayLabel(b), drawList), h('p', { class: 'warn' }, err.message));
      return;
    }
    const backup = parsed.ledger;
    const today = todayIso();
    const live = current();
    const ids = [...new Set([...live.accounts, ...backup.accounts].map((a) => a.id))];
    const rows = ids.map((id) => {
      const nowAcc = live.accounts.find((a) => a.id === id);
      const oldAcc = backup.accounts.find((a) => a.id === id);
      const acc = nowAcc ?? oldAcc;
      const then = oldAcc ? balanceAsOf(backup, oldAcc, today) : null;
      const now = nowAcc ? balanceAsOf(live, nowAcc, today) : null;
      return h('tr', { class: then !== now ? 'differs' : '' },
        h('td', {}, acc.name),
        h('td', {}, then === null ? '—' : formatPence(then)),
        h('td', {}, now === null ? '—' : formatPence(now)));
    });
    const nThen = backup.transactions.length;
    const nNow = live.transactions.length;
    const what = b.info.kind === 'before-restore'
      ? 'Your data as it was just before a restore.'
      : 'Your data as it was just before this day’s first change.';
    show(head(backupDayLabel(b), drawList),
      h('p', { class: 'small' }, what),
      h('div', { class: 'recon-summary' },
        h('table', { class: 'backup-compare' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Balance today'), h('th', {}, 'In backup'), h('th', {}, 'Now'))),
          h('tbody', {}, rows,
            h('tr', { class: nThen !== nNow ? 'differs' : '' }, h('td', {}, 'Entries'), h('td', {}, String(nThen)), h('td', {}, String(nNow))))),
        h('p', { class: 'muted small' }, 'Bold rows differ. “Balance today” counts entries up to today in each copy.')),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn-secondary', onclick: drawList }, 'Back'),
        h('button', { type: 'button', class: 'btn-danger', onclick: () => restore(b, backup) }, 'Restore this backup')));
  }

  async function restore(b, backup) {
    const ok = confirm(
      `Restore the backup from ${backupDayLabel(b)}?\n\n` +
      'Everything goes back to how it was then, on this device and on Drive; your other device follows on its next sync. ' +
      'A copy of your data as it is now is saved first, so you can undo this from the same list.\n\n' +
      'If your other device has changes it hasn’t synced yet, those will be added back on top when it next syncs.');
    if (!ok) return;
    show(head('Restoring…'), h('p', { class: 'muted' }, 'Saving a copy of your current data, then restoring…'));
    const r = await engine.restoreBackup(backup);
    if (r.status === 'restored') {
      dlg.close();
      if (isOpen('settingsDialog')) renderSettings();
      toast(r.pending ? 'Restored here — it reaches Drive on the next sync' : `Restored the backup from ${backupDayLabel(b)}`);
      if (r.conflicts) openConflictDialog(engine);
      return;
    }
    const msg = r.status === 'needs-tap' ? 'Google sign-in has expired. Tap the cloud button at the top, then try again.' : (r.reason ?? 'Restore failed');
    show(head(backupDayLabel(b), drawList), h('p', { class: 'warn' }, `Nothing was restored. ${msg}`),
      h('button', { type: 'button', class: 'btn-secondary', onclick: drawList }, 'Back to the list'));
  }

  show(head(title), h('p', { class: 'muted' }, 'Looking on Google Drive…'));
  openDialog(dlg);
  listing.then((list) => { backups = list; drawList(); })
    .catch((err) => show(head(title), h('p', { class: 'warn' }, err.message)));
}

function downloadBlob(file, name) {
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function doExport(share, which = 'personal') {
  const joint = which === 'joint';
  const payload = JSON.stringify(buildExport(joint ? state.joint : state.personal, deviceLabel()), null, 1);
  const name = joint ? exportFileName().replace(/^finance-tracker-/, 'finance-joint-') : exportFileName();
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
  if (!joint) {
    state.meta = { ...state.meta, lastExportAt: new Date().toISOString() };
    await saveMeta(state.meta);
  }
  // Redraw the settings dialog BEFORE toasting: toast() parents the toast
  // element into the topmost open dialog, and renderSettings() wipes that
  // dialog's children via replaceChildren — doing it after would immediately
  // erase the toast we just showed.
  if (isOpen('settingsDialog')) renderSettings();
  toast(message);
  render();
}

async function doImport(file) {
  try {
    const parsed = parseImport(await file.text());
    // v0.14: a joint export only ever goes back into the joint account, and a personal one into yours
    if (isJointLedger(parsed.ledger)) {
      if (!jointActive()) throw new Error('That is a joint account export. Turn the joint account on (⚙) first, then import it.');
      const ok = confirm(
        `Replace the JOINT account’s data on this device with the export from ${when(parsed.exportedAt)}?\n\n` +
        `This device: ${state.joint.transactions.length} joint entries\nExport file: ${parsed.ledger.transactions.length} entries\n\n` +
        'The joint Drive file is replaced too on the next sync. Your own accounts aren’t touched.');
      if (!ok) return;
      await commitParts({ joint: parsed.ledger });
      if (isOpen('settingsDialog')) renderSettings();
      toast(`Imported ${parsed.ledger.transactions.length} joint entries`);
      return;
    }
    const current = state.personal.transactions.length;
    const incoming = parsed.ledger.transactions.length;
    const ok = confirm(
      `Replace this device's data with the export from ${when(parsed.exportedAt)}${parsed.exportedFrom ? ` (${parsed.exportedFrom})` : ''}?\n\n` +
      `This device: ${current} entries\nExport file: ${incoming} entries` +
      (sync.isEnabled() ? '\n\nDrive sync is on, so the Drive copy (and your other devices) will be replaced too on the next sync.' : '') +
      (jointActive() ? '\n\nThe joint account isn’t touched.' : ''));
    if (!ok) return;
    state.meta = { ...state.meta, lastImportAt: new Date().toISOString(), lastImportFrom: parsed.exportedFrom || file.name };
    await saveMeta(state.meta);
    // keep the ledger's own lastModified so "unexported changes" starts clean
    await commitParts({ personal: parsed.ledger }); // no message yet — see note in doExport about ordering
    if (isOpen('settingsDialog')) renderSettings();
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
  if (document.visibilityState === 'visible' && lockIfIdle()) return;
  if (!state.ledger || (!sync.isEnabled() && !jointActive())) return;
  if (document.visibilityState === 'hidden') { clearTimeout(syncTimer); sync.sync(); runJointSync(); }
  else { renderSyncChip(); syncBoth(); }
});
setInterval(() => (sync.isEnabled() || jointActive()) && renderSyncChip(), 60 * 1000); // sign-in expiry / "Synced hh:mm" freshness
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

// ------------------------------------------------------------------ v0.10 passphrase lock
// Desktop only in practice: it's off unless turned on in ⚙ on this device,
// and it never syncs. With it on, everything this device saves is
// encrypted (store.js + lib/vault.js), the app opens on the lock screen,
// and it locks itself after a spell without use. Locking reloads the page,
// which is the surest way to drop every trace of the data from memory.

const LOCK_REASON_KEY = 'ft.lockReason';
let lastActivity = Date.now();
let locking = false;
// not 'scroll': the app scrolls itself on redraws
for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
  addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true });
}
function autoLockMs() {
  return (state.vault?.autoLockMinutes ?? DEFAULT_AUTO_LOCK) * 60 * 1000;
}
/** Lock if the lock is on and nothing has happened for the auto-lock time. True if locking. */
function lockIfIdle() {
  if (!state.vault || locking) return locking;
  if (Date.now() - lastActivity < autoLockMs()) return false;
  lockNow(`Locked after ${state.vault.autoLockMinutes} minutes without use`);
  return true;
}
setInterval(lockIfIdle, 10 * 1000);

async function lockNow(reason = '') {
  if (locking) return;
  locking = true;
  // Hide everything at once; then let saves finish and (with a valid
  // sign-in) push to Drive — briefly, the next unlock syncs anyway.
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  app.replaceChildren(h('div', { class: 'empty' }, 'Locking…'));
  document.body.classList.add('locked');
  clearTimeout(syncTimer);
  try {
    await flushWrites();
    if ((sync.isEnabled() || jointActive()) && auth.hasValidToken()) await Promise.race([Promise.all([sync.sync(), runJointSync()]), new Promise((r) => setTimeout(r, 4000))]);
    await flushWrites();
  } catch { /* the data is saved locally either way */ }
  setVaultKey(null);
  try { if (reason) sessionStorage.setItem(LOCK_REASON_KEY, reason); } catch { /* ignore */ }
  location.reload();
}

function setTopbarLocked(locked) {
  document.body.classList.toggle('locked', locked);
  $('lockBtn').hidden = locked || !state.vault;
}

function showLockScreen(header) {
  setTopbarLocked(true);
  let reason = '';
  try { reason = sessionStorage.getItem(LOCK_REASON_KEY) ?? ''; sessionStorage.removeItem(LOCK_REASON_KEY); } catch { /* ignore */ }
  const pass = h('input', { type: 'password', id: 'unlockPass', autocomplete: 'current-password', required: true, 'aria-label': 'Passphrase' });
  const msg = h('p', { class: 'small', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'btn-primary' }, 'Unlock');
  const form = h('form', {
    class: 'lock-form',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!pass.value) return;
      btn.disabled = true;
      btn.textContent = 'Unlocking…';
      msg.textContent = '';
      msg.className = 'small';
      let key = null;
      try { key = await unlockVault(header, pass.value); } catch (err) { msg.textContent = err.message; }
      if (!key) {
        if (!msg.textContent) msg.textContent = 'That passphrase isn’t right.';
        msg.className = 'small neg';
        btn.disabled = false;
        btn.textContent = 'Unlock';
        pass.select();
        pass.focus();
        return;
      }
      pass.value = '';
      setVaultKey(key);
      state.vault = header;
      lastActivity = Date.now();
      setTopbarLocked(false);
      boot();
    },
  },
  h('label', { class: 'field' }, h('span', {}, 'Passphrase'), pass),
  msg,
  btn);
  app.replaceChildren(h('div', { class: 'setup lock-screen' },
    h('div', { class: 'card' },
      h('div', { class: 'lock-icon', 'aria-hidden': 'true' }, lockSvg(28)),
      h('h2', {}, 'Locked'),
      h('p', { class: 'muted small' }, reason || 'Your finance data on this device is encrypted. Enter your passphrase to open it.'),
      form),
    h('p', { class: 'muted small center' },
      h('button', { type: 'button', class: 'btn-link', onclick: forgotPassphrase }, 'Forgot your passphrase?'))));
  pass.focus();
}

function forgotPassphrase() {
  const ok = confirm('Reset this device?\n\nWithout the passphrase the data here can’t be opened, so it will be DELETED from this device and the lock removed.\n\nYour Google Drive copy and its backups are NOT touched — connect Drive again afterwards (⚙ → Connect Google Drive) to load everything back. Only changes made here that hadn’t synced yet are lost.');
  if (!ok) return;
  (async () => {
    auth.clearToken?.();
    auth.forgetLocalToken?.();
    await wipeDevice();
    location.reload();
  })().catch((err) => alert(`Couldn’t reset: ${err.message}`));
}

function lockSvg(size = 20) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('d', 'M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 5a3 3 0 1 1 6 0v3H9V7Zm3 7a2 2 0 0 1 1 3.73V19h-2v-1.27A2 2 0 0 1 12 14Z');
  svg.append(path);
  return svg;
}

/** Keep the Google token encrypted with the data (not in localStorage) while the lock is on. */
function tokenStoreFor(on) {
  auth.useTokenStore?.(on ? { save: (c) => saveAuthCache(c) } : null);
}

function lockSection() {
  const v = state.vault;
  if (!v) {
    return h('section', { class: 'settings-section' },
      h('h3', {}, 'Passphrase lock'),
      h('p', { class: 'muted small' }, 'Off. Turn it on for a computer others can use: the data this browser keeps is encrypted, the app asks for your passphrase when it opens, and it locks itself when left alone. Just for this device — your phone and Drive aren’t affected.'),
      h('button', { type: 'button', class: 'btn-secondary', onclick: () => openLockDialog('on') }, 'Turn on passphrase lock…'));
  }
  const minutes = h('select', {
    'aria-label': 'Lock after',
    onchange: async (e) => {
      const next = { ...state.vault, autoLockMinutes: Number(e.target.value) };
      try {
        await saveVaultHeader(next);
        state.vault = next;
        lastActivity = Date.now();
        toast(`Locks after ${next.autoLockMinutes} minutes without use`);
      } catch (err) { toast(`Couldn’t save: ${err.message}`, 'error'); }
    },
  }, AUTO_LOCK_CHOICES.map((m) => h('option', { value: String(m), selected: m === v.autoLockMinutes }, `${m} minutes`)));
  return h('section', { class: 'settings-section' },
    h('h3', {}, 'Passphrase lock'),
    h('p', { class: 'small' }, 'On · this device’s data is encrypted'),
    h('label', { class: 'field field-row' }, h('span', {}, 'Lock after this long without use'), minutes),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn-primary', onclick: () => lockNow() }, 'Lock now'),
      h('button', { type: 'button', class: 'btn-secondary', onclick: () => openLockDialog('change') }, 'Change passphrase…'),
      h('button', { type: 'button', class: 'btn-secondary', onclick: () => openLockDialog('off') }, 'Turn off…')),
    h('p', { class: 'muted small' }, 'Exports you download are NOT encrypted — delete them from Downloads when you’re done. Drive backups are as safe as your Google account.'));
}

/** mode: 'on' | 'change' | 'off' */
function openLockDialog(mode) {
  const dlg = $('lockDialog');
  const pw = (id, label, autocomplete) => {
    const input = h('input', { type: 'password', id, autocomplete, required: true });
    return { input, field: h('label', { class: 'field' }, h('span', {}, label), input) };
  };
  const current = mode === 'on' ? null : pw('lockCurrent', 'Current passphrase', 'current-password');
  const fresh = mode === 'off' ? null : pw('lockNew', mode === 'change' ? 'New passphrase' : 'Passphrase', 'new-password');
  const again = mode === 'off' ? null : pw('lockAgain', 'Type it again', 'new-password');
  const minutes = mode === 'on'
    ? h('select', { id: 'lockMinutes' }, AUTO_LOCK_CHOICES.map((m) => h('option', { value: String(m), selected: m === DEFAULT_AUTO_LOCK }, `${m} minutes`)))
    : null;
  const msg = h('p', { class: 'small neg', role: 'alert' });
  const submit = h('button', { type: 'submit', class: mode === 'off' ? 'btn-danger' : 'btn-primary' },
    { on: 'Turn on', change: 'Change passphrase', off: 'Turn off the lock' }[mode]);
  const fail = (text) => { msg.textContent = text; submit.disabled = false; submit.textContent = submit.dataset.label; };
  submit.dataset.label = submit.textContent;

  const form = h('form', {
    class: 'sheet-body',
    onsubmit: async (e) => {
      e.preventDefault();
      msg.textContent = '';
      if (fresh) {
        const problem = passphraseProblem(fresh.input.value, again.input.value);
        if (problem) return fail(problem);
      }
      submit.disabled = true;
      submit.textContent = 'Working…';
      try {
        if (mode === 'on') {
          const { header, key } = await createVault(fresh.input.value, { autoLockMinutes: Number(minutes.value) });
          await rekeyAll(header, key); // everything re-saved encrypted, in one go
          state.vault = header;
          tokenStoreFor(true);
          lastActivity = Date.now();
          $('lockBtn').hidden = false;
          dlg.close();
          renderSettings();
          toast('Passphrase lock is on');
        } else if (mode === 'change') {
          const next = await changePassphrase(state.vault, current.input.value, fresh.input.value);
          if (!next) return fail('The current passphrase isn’t right');
          await saveVaultHeader(next);
          state.vault = next;
          dlg.close();
          toast('Passphrase changed');
        } else {
          if (!(await unlockVault(state.vault, current.input.value))) return fail('That passphrase isn’t right');
          await rekeyAll(null, null); // everything re-saved as plain data
          state.vault = null;
          tokenStoreFor(false);
          $('lockBtn').hidden = true;
          dlg.close();
          renderSettings();
          toast('Passphrase lock is off');
        }
      } catch (err) {
        fail(`Couldn’t do that: ${err.message}`);
      }
    },
  },
  h('header', { class: 'sheet-head' },
    h('h2', {}, { on: 'Turn on passphrase lock', change: 'Change passphrase', off: 'Turn off passphrase lock' }[mode]),
    h('button', { type: 'button', class: 'btn-ghost icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
  mode === 'on' ? h('p', { class: 'muted small' }, `Pick something you’ll remember — at least ${MIN_PASSPHRASE_LENGTH} characters; a few unrelated words work well.`) : null,
  mode === 'on' ? h('p', { class: 'warn small' }, 'There’s no way to recover a forgotten passphrase. If that happens, “Forgot your passphrase?” on the lock screen clears this device and you reload everything from Google Drive — only changes that hadn’t synced yet would be lost.') : null,
  mode === 'off' ? h('p', { class: 'muted small' }, 'The data on this device will be saved unencrypted again, and the app will open without asking.') : null,
  current?.field, fresh?.field, again?.field,
  minutes ? h('label', { class: 'field field-row' }, h('span', {}, 'Lock after this long without use'), minutes) : null,
  msg,
  h('div', { class: 'sheet-actions' },
    h('button', { type: 'button', class: 'btn-secondary', onclick: () => dlg.close() }, 'Cancel'),
    submit));
  dlg.replaceChildren(form);
  openDialog(dlg);
  (current ?? fresh).input.focus();
}

$('lockBtn').addEventListener('click', () => lockNow());

/**
 * v0.13.2: after a deploy, GitHub Pages can serve the old index.html for a few
 * minutes while the new .js files already arrive. index.html carries its own
 * version; if it doesn't match the code, say so (with a reload button) rather
 * than fail in odd ways. Built entirely here, so it works on any old page.
 */
function checkPageVersion() {
  const pageVersion = document.querySelector('meta[name="app-version"]')?.content?.trim();
  if (pageVersion === APP_VERSION) return;
  if (document.getElementById('updateBanner')) return;
  const bar = h('div', { id: 'updateBanner', class: 'update-banner', role: 'alert' },
    h('span', {}, 'Finishing an update — this page is a version behind the app.'),
    h('button', { type: 'button', class: 'btn-primary btn-small', onclick: () => location.reload() }, 'Tap to reload'));
  document.body.prepend(bar);
}

async function start() {
  $('brandVersion').textContent = `v${APP_VERSION}`;
  try { checkPageVersion(); } catch (err) { console.error(err); }
  let header = null;
  try {
    header = await loadVaultHeader();
  } catch (err) {
    app.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Storage unavailable'), h('p', {}, `This browser blocked local storage (${err.message}). Private/incognito windows often do this.`)));
    return;
  }
  if (isVaultHeader(header)) {
    auth.clearToken?.(); // a token must never sit in localStorage while the lock is on
    showLockScreen(header);
    return;
  }
  boot();
}

async function boot() {
  try {
    if (state.vault) {
      auth.restoreToken?.(await loadAuthCache());
      tokenStoreFor(true);
      $('lockBtn').hidden = false;
    }
    state.personal = (await loadLedger()) ?? emptyLedger();
    recombine();
    state.meta = await loadMeta();
    state.tracker = (await loadTrackerEstimates().catch(() => null)) ?? null;
  } catch (err) {
    app.replaceChildren(h('div', { class: 'card' }, h('h2', {}, 'Storage unavailable'), h('p', {}, `This browser blocked local storage (${err.message}). Private/incognito windows often do this.`)));
    return;
  }
  // v0.14: the joint account only when switched on here — a problem with it never stops the app
  try {
    state.jointSettings = await loadJointSettings();
    if (state.jointSettings.enabled) {
      state.joint = (await loadJointLedger()) ?? emptyJointLedger();
      recombine();
      jointSync = makeJointEngine();
      await jointSync.init();
    }
  } catch (err) {
    jointSync = null;
    state.joint = null;
    recombine();
    toast(`Joint account unavailable: ${err.message}`, 'error');
  }
  render();
  loadHolidays();
  try {
    await sync.init();
    if (sync.isEnabled() || jointActive()) auth.preload?.(); // ready for a "Tap to sync"
    renderSyncChip();
    syncBoth();
  } catch (err) {
    toast(`Drive sync unavailable: ${err.message}`, 'error');
  }
  requestPersistence().then((persisted) => { state.meta.persisted = persisted; });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
}

start();
