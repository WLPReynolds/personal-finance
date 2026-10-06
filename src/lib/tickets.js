/**
 * v0.13 — ticket purchases on the credit card, and ring-fencing.
 * Spec: Project doc claude/ticket-purchases-spec.md (+ the tracker's addendum).
 *
 * Wayne buys his season tickets on Barclaycard. On the day he moves the same
 * amount out of the Transport envelope (Monzo pots) into Safe keeping; the day
 * before the card's payment date he moves everything ring-fenced on that
 * statement back to the current account, and the direct debit takes it.
 *
 * - Settings: one record in `ledger.scheduledItems` with recordType
 *   'ticketPurchases' (a new collection would be dropped by v0.4's merge).
 *   Synced, so both devices agree. Older versions ignore it.
 * - Tickets come from the ticket tracker's published file (`estimates.tickets`,
 *   tracker-estimates.js). Projected ticket entries are DERIVED, never stored —
 *   a change in the tracker's plan simply moves them.
 * - Confirming a bought ticket stores: the card spend `tk:<ticketId>` (field
 *   `ticketId`) and its ring-fence transfer.
 * - Ring-fence = transfer envelope account → safe account, both legs tagged
 *   `ringFenceOf: <card spend id>`, ids `rf:<card spend id>` (+ :out / :in).
 *   Deterministic, so two devices doing the same thing merge to one record.
 * - Return = transfer safe → return account, the day before the card's payment
 *   date, amount = ring-fenced spends on that statement. Projected per
 *   statement; confirmed legs carry `ticketReturn: 'YYYY-MM'` (statement month).
 *
 * Pure functions; no DOM.
 */
import { statementConfig, paymentDueDate, effectiveStatementMonth } from './statements.js';
import { envelopeConfig } from './envelopes.js';
import { updateTransaction, deleteTransaction } from './ops.js';

export const TICKET_SETTINGS_ID = 'ticket-purchases';
export const TICKET_RECORD_TYPE = 'ticketPurchases';
export const TICKET_DESCRIPTION = 'Train ticket';
/** A confirmed ticket missing from the tracker's file is only flagged inside this window (the file's bought-ticket window). */
export const MISSING_WINDOW_DAYS = 90;

const isIso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function touch(ledger) {
  return { ...ledger, lastModified: new Date().toISOString() };
}

// ------------------------------------------------------------------ settings

/** The stored settings record (on or off), or null. */
export function ticketSettingsRecord(ledger) {
  return (ledger?.scheduledItems ?? []).find((r) => r?.recordType === TICKET_RECORD_TYPE) ?? null;
}

/** Why switched-on settings can't be used (an account or envelope gone), or null when they're fine. */
export function ticketSettingsProblem(ledger, rec = ticketSettingsRecord(ledger)) {
  if (!rec) return 'Not set up.';
  const acc = (id) => ledger.accounts.find((a) => a.id === id) ?? null;
  const card = acc(rec.cardAccountId);
  if (!card) return 'The card account no longer exists.';
  if (!statementConfig(card)) return `${card.name} has no statement date set (Account…).`;
  const envAcc = acc(rec.envelopeAccountId);
  if (!envAcc) return 'The envelope account no longer exists.';
  if (!envelopeConfig(envAcc)?.list?.some((e) => e.id === rec.envelopeId)) return `The envelope on ${envAcc.name} no longer exists.`;
  if (!acc(rec.safeAccountId)) return 'The ring-fence account no longer exists.';
  if (!acc(rec.returnAccountId)) return 'The account the money goes back to no longer exists.';
  if (!isIso(rec.startDate)) return 'No valid start date.';
  return null;
}

/** Settings in use: switched on and still valid — else null (nothing ticket-related is shown). */
export function ticketSettings(ledger) {
  const rec = ticketSettingsRecord(ledger);
  if (!rec?.enabled || ticketSettingsProblem(ledger, rec)) return null;
  return rec;
}

/**
 * Save the settings. fields: { enabled, cardAccountId, envelopeAccountId,
 * envelopeId, safeAccountId, returnAccountId, startDate }. Switching off keeps
 * the choices for next time; nothing already entered is changed either way.
 */
export function setTicketSettings(ledger, fields) {
  const prev = ticketSettingsRecord(ledger);
  const rec = {
    id: TICKET_SETTINGS_ID,
    recordType: TICKET_RECORD_TYPE,
    description: 'Ticket purchases settings', // shown if it ever clashes in a sync
    enabled: Boolean(fields.enabled),
    cardAccountId: fields.cardAccountId ?? null,
    envelopeAccountId: fields.envelopeAccountId ?? null,
    envelopeId: fields.envelopeId ?? null,
    safeAccountId: fields.safeAccountId ?? null,
    returnAccountId: fields.returnAccountId ?? null,
    startDate: fields.startDate ?? prev?.startDate ?? null,
    createdAt: prev?.createdAt ?? new Date().toISOString(),
  };
  if (rec.enabled) {
    const acc = (id) => ledger.accounts.find((a) => a.id === id) ?? null;
    const card = acc(rec.cardAccountId);
    if (!card || card.type !== 'credit') throw new Error('Pick the credit card the tickets go on');
    if (!statementConfig(card)) throw new Error(`Set ${card.name}’s statement date first (Account…)`);
    const envAcc = acc(rec.envelopeAccountId);
    if (!envelopeConfig(envAcc)) throw new Error('Pick the account with the Transport envelope');
    if (!envAcc.envelopes.list.some((e) => e.id === rec.envelopeId && !e.hidden)) throw new Error('Pick the envelope the money comes from');
    const safe = acc(rec.safeAccountId);
    if (!safe || safe.type === 'credit') throw new Error('Pick the ring-fence (Safe keeping) account');
    if (safe.id === envAcc.id) throw new Error('The ring-fence account must be a different account from the envelope account');
    const back = acc(rec.returnAccountId);
    if (!back || back.type === 'credit') throw new Error('Pick the account the money goes back to');
    if (back.id === safe.id) throw new Error('The money must go back to a different account from Safe keeping');
    if (!isIso(rec.startDate)) throw new Error('Give a start date');
  }
  const others = (ledger.scheduledItems ?? []).filter((r) => r.recordType !== TICKET_RECORD_TYPE);
  return touch({ ...ledger, scheduledItems: [...others, rec] });
}

// ------------------------------------------------------------------ ring-fence

export const ringFenceId = (cardTxId) => `rf:${cardTxId}`;

/** The ring-fence transfer legs for a card spend ([] when none). */
export function ringFenceLegs(ledger, cardTxId) {
  return ledger.transactions.filter((t) => t.ringFenceOf === cardTxId);
}
export const isRingFenced = (ledger, cardTxId) => ringFenceLegs(ledger, cardTxId).length > 0;

/** Can this entry be ring-fenced? A spend (debit, not a transfer) on the settings' card. */
export function canRingFence(settings, t) {
  return Boolean(settings && t && t.accountId === settings.cardAccountId && t.kind !== 'note' && t.direction === 'debit' && !t.transferId);
}

function ringFenceRecords(settings, cardTx) {
  const id = ringFenceId(cardTx.id);
  const common = {
    date: cardTx.date, amount: cardTx.amount, description: `Ring-fence: ${cardTx.description || TICKET_DESCRIPTION}`,
    category: 'Transfer', kind: 'transaction', scheduledItemId: null, isProjected: false, statementMonth: null,
    transferId: id, ringFenceOf: cardTx.id,
  };
  const legs = [
    { ...common, id: `${id}:out`, accountId: settings.envelopeAccountId, direction: 'debit',
      envelopeSplits: [{ envelopeId: settings.envelopeId, amount: cardTx.amount }] },
    { ...common, id: `${id}:in`, accountId: settings.safeAccountId, direction: 'credit', envelopeSplits: null },
  ];
  const transfer = { id, fromAccountId: settings.envelopeAccountId, toAccountId: settings.safeAccountId, amount: cardTx.amount, date: cardTx.date, note: common.description };
  return { legs, transfer };
}

/** Ring-fence a card spend: same date and amount, Transport envelope → Safe keeping. */
export function addRingFence(ledger, settings, cardTxId) {
  if (!settings) throw new Error('Ticket purchases aren’t set up (⚙)');
  const cardTx = ledger.transactions.find((t) => t.id === cardTxId);
  if (!canRingFence(settings, cardTx)) throw new Error('Only a spend on the card can be ring-fenced');
  if (isRingFenced(ledger, cardTxId)) return ledger;
  const { legs, transfer } = ringFenceRecords(settings, cardTx);
  return touch({
    ...ledger,
    transactions: [...ledger.transactions, ...legs],
    transfers: [...ledger.transfers.filter((t) => t.id !== transfer.id), transfer],
  });
}

/** Remove a card spend's ring-fence transfer (both legs). */
export function removeRingFence(ledger, cardTxId) {
  const leg = ringFenceLegs(ledger, cardTxId)[0];
  return leg ? deleteTransaction(ledger, leg.id) : ledger;
}

/**
 * After a card spend was edited or deleted: its ring-fence follows. Deleted
 * spend → transfer removed; new date or amount → the transfer gets them.
 */
export function syncRingFence(ledger, cardTxId) {
  const legs = ringFenceLegs(ledger, cardTxId);
  if (!legs.length) return ledger;
  const cardTx = ledger.transactions.find((t) => t.id === cardTxId);
  if (!cardTx || cardTx.kind === 'note' || cardTx.direction !== 'debit') return deleteTransaction(ledger, legs[0].id);
  const out = legs.find((t) => t.direction === 'debit') ?? legs[0];
  if (out.date === cardTx.date && out.amount === cardTx.amount) return ledger;
  return updateTransaction(ledger, out.id, { date: cardTx.date, amount: cardTx.amount });
}

// ------------------------------------------------------------------ tickets from the tracker

export const ticketTxId = (ticketId) => `tk:${ticketId}`;

/** Ids of tickets already confirmed (their card spend exists). */
export function confirmedTicketIds(ledger) {
  return new Set(ledger.transactions.filter((t) => t.ticketId && !t.transferId).map((t) => t.ticketId));
}

/**
 * Projected ticket entries (not stored): every ticket in the tracker's file
 * bought or due on/after the start date and not confirmed yet.
 * - bought → its real date and price, "Bought — confirm"
 * - projected, purchase date still ahead → that date
 * - projected, purchase date passed (overdue) → TODAY, so today's balances stay
 *   true and it can't land on a statement that's already been paid
 */
export function ticketProjections(ledger, settings, estimates, todayIso, toIso) {
  if (!settings || !Array.isArray(estimates?.tickets) || !todayIso) return [];
  const done = confirmedTicketIds(ledger);
  const out = [];
  for (const t of estimates.tickets) {
    if (t.purchaseDate < settings.startDate || done.has(t.id)) continue;
    const bought = t.status === 'bought';
    const overdue = !bought && t.purchaseDate < todayIso;
    const date = overdue ? todayIso : t.purchaseDate;
    if (date > toIso) continue;
    out.push({
      key: `ticket:${t.id}`, kind: 'ticket', itemId: null, period: null,
      ticket: t, bought, overdue, date, seriesDate: t.purchaseDate,
      amount: t.pricePence, seriesAmount: t.pricePence, description: TICKET_DESCRIPTION,
      accountId: settings.cardAccountId, toAccountId: null,
      skipped: false, changed: false, number: null, settings,
    });
  }
  return out;
}

/** A projected ticket as legs: the card spend plus its ring-fence transfer. */
export function ticketLegs(p) {
  const s = p.settings;
  const id = `tkproj:${p.ticket.id}`;
  const base = {
    category: null, kind: 'transaction', scheduledItemId: null, scheduledPeriod: null,
    isProjected: true, skipped: false, projection: p, seriesNo: null,
    date: p.date, amount: p.amount, statementMonth: null,
  };
  const cardId = `${id}:card`;
  return [
    { ...base, id: cardId, accountId: s.cardAccountId, direction: 'debit', transferId: null, envelopeSplits: null, description: TICKET_DESCRIPTION, ticketId: p.ticket.id },
    { ...base, id: `${id}:rf:out`, accountId: s.envelopeAccountId, direction: 'debit', transferId: `${id}:rf`, ringFenceOf: cardId,
      envelopeSplits: [{ envelopeId: s.envelopeId, amount: p.amount }], description: `Ring-fence: ${TICKET_DESCRIPTION}`, category: 'Transfer' },
    { ...base, id: `${id}:rf:in`, accountId: s.safeAccountId, direction: 'credit', transferId: `${id}:rf`, ringFenceOf: cardId,
      envelopeSplits: null, description: `Ring-fence: ${TICKET_DESCRIPTION}`, category: 'Transfer' },
  ];
}

/**
 * Confirm a bought ticket: the card spend (`tk:<ticketId>`) and its ring-fence.
 * Only bought tickets: a projected one's id would go stale once the tracker
 * records the purchase. statementMonth: null = by date.
 */
export function confirmTicket(ledger, settings, ticket, { date, amount, statementMonth = null }) {
  if (!settings) throw new Error('Ticket purchases aren’t set up (⚙)');
  if (ticket?.status !== 'bought') throw new Error('Record the purchase in the ticket tracker first');
  if (!isIso(date)) throw new Error('A valid date is required');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Amount must be more than £0.00');
  const id = ticketTxId(ticket.id);
  if (ledger.transactions.some((t) => t.id === id)) throw new Error('Already confirmed');
  const cardTx = {
    id, accountId: settings.cardAccountId, date, amount, direction: 'debit', description: TICKET_DESCRIPTION,
    category: null, kind: 'transaction', transferId: null, envelopeSplits: null, scheduledItemId: null,
    isProjected: false, statementMonth: statementMonth ?? null, ticketId: ticket.id,
  };
  return addRingFence({ ...ledger, transactions: [...ledger.transactions, cardTx] }, settings, id);
}

/**
 * Confirmed tickets whose id has gone from the tracker's file (a purchase
 * removed and re-added with another start date) — card spend ids. Only bought
 * ids (`p-`), only within the file's 90-day window, and only when the file
 * has a ticket list at all.
 */
export function ticketsMissingFromTracker(ledger, estimates, todayIso) {
  const out = new Set();
  if (!Array.isArray(estimates?.tickets) || !todayIso) return out;
  const known = new Set(estimates.tickets.map((t) => t.id));
  const since = addDays(todayIso, -MISSING_WINDOW_DAYS);
  for (const t of ledger.transactions) {
    if (t.ticketId && !t.transferId && !t.isProjected && t.ticketId.startsWith('p-') && t.date >= since && !known.has(t.ticketId)) out.add(t.id);
  }
  return out;
}

// ------------------------------------------------------------------ money back before the card is paid

export const returnTxId = (month) => `tkret:${month}`;

/** Ring-fenced spends on the card, grouped by statement month: Map month -> spends (pass a view to include projected ones). */
export function ringFencedByStatement(view, settings, holidays) {
  const card = view.accounts.find((a) => a.id === settings.cardAccountId);
  const fenced = new Set(view.transactions.filter((t) => t.ringFenceOf && !t.skipped).map((t) => t.ringFenceOf));
  const by = new Map();
  for (const t of view.transactions) {
    if (t.accountId !== card.id || t.kind === 'note' || t.direction !== 'debit' || t.skipped || !fenced.has(t.id)) continue;
    const m = effectiveStatementMonth(card, t, holidays);
    if (!by.has(m)) by.set(m, []);
    by.get(m).push(t);
  }
  return by;
}

/** Statement months whose money has already been moved back (confirmed). */
export function confirmedReturnMonths(ledger) {
  return new Set(ledger.transactions.filter((t) => t.ticketReturn).map((t) => t.ticketReturn));
}

/**
 * One projected transfer per statement with anything ring-fenced on it:
 * safe account → return account, the CALENDAR day before the payment date
 * (weekends are fine). `view` must include projected tickets.
 */
export function returnProjections(view, settings, holidays, toIso) {
  if (!settings) return [];
  const card = view.accounts.find((a) => a.id === settings.cardAccountId);
  const done = confirmedReturnMonths(view);
  const out = [];
  for (const [month, spends] of [...ringFencedByStatement(view, settings, holidays)].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (done.has(month)) continue;
    const due = paymentDueDate(card, month, holidays);
    if (!due) continue;
    const date = addDays(due, -1);
    if (date > toIso) continue;
    const amount = spends.reduce((s, t) => s + t.amount, 0);
    if (amount <= 0) continue;
    out.push({
      key: `ticketReturn:${month}`, kind: 'ticketReturn', itemId: null, period: null,
      statementMonth: month, dueDate: due, spends, date, seriesDate: date, amount, seriesAmount: amount,
      description: `Ring-fenced money back for ${card.name}`,
      accountId: settings.safeAccountId, toAccountId: settings.returnAccountId,
      skipped: false, changed: false, number: null, settings,
    });
  }
  return out;
}

export function returnLegs(p) {
  const id = `tkretproj:${p.statementMonth}`;
  const base = {
    category: 'Transfer', kind: 'transaction', scheduledItemId: null, scheduledPeriod: null, envelopeSplits: null,
    isProjected: true, skipped: false, projection: p, seriesNo: null, statementMonth: null,
    date: p.date, amount: p.amount, description: p.description, transferId: id,
  };
  return [
    { ...base, id: `${id}:out`, accountId: p.accountId, direction: 'debit' },
    { ...base, id: `${id}:in`, accountId: p.toAccountId, direction: 'credit' },
  ];
}

/** Confirm the money moved back for one statement (ids from the month, so two devices merge to one). */
export function confirmReturn(ledger, settings, month, { date, amount, description }) {
  if (!settings) throw new Error('Ticket purchases aren’t set up (⚙)');
  if (!/^\d{4}-\d{2}$/.test(month ?? '')) throw new Error('Not a valid statement month');
  if (!isIso(date)) throw new Error('A valid date is required');
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Amount must be more than £0.00');
  const id = returnTxId(month);
  if (ledger.transactions.some((t) => t.ticketReturn === month)) throw new Error('Already confirmed');
  const text = (description ?? '').trim() || 'Ring-fenced money back';
  const common = {
    date, amount, description: text, category: 'Transfer', kind: 'transaction', envelopeSplits: null,
    scheduledItemId: null, isProjected: false, statementMonth: null, transferId: id, ticketReturn: month,
  };
  const legs = [
    { ...common, id: `${id}:out`, accountId: settings.safeAccountId, direction: 'debit' },
    { ...common, id: `${id}:in`, accountId: settings.returnAccountId, direction: 'credit' },
  ];
  const transfer = { id, fromAccountId: settings.safeAccountId, toAccountId: settings.returnAccountId, amount, date, note: text };
  return touch({
    ...ledger,
    transactions: [...ledger.transactions, ...legs],
    transfers: [...ledger.transfers.filter((t) => t.id !== id), transfer],
  });
}
