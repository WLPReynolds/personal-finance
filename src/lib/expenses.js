/**
 * v0.15.8: expense claims (design: claude/expense-claims-design.md).
 *
 * An account can be ticked "Can have expense claims" (`expenseClaims: true`;
 * absent or false = off). On such an account an entry can be marked as a
 * business expense:
 *
 *   entry.expense = { amount, details, status, submittedAt, paidAt }
 *     amount      pence, 1 … the entry's own amount (a part-business payment claims less)
 *     details     free text — the longer description her employer's system needs
 *     status      'toClaim' → 'submitted' → 'paid' (Paid is optional)
 *     submittedAt / paidAt  ISO datetimes, or null
 *
 * Both fields are ordinary record fields, so they merge, sync and survive
 * older app versions like any other (compat-tests). Receipt photos are NOT
 * here — they stay on the device (lib/photos.js) and never reach a synced file.
 *
 * Unticking an account hides its claims; nothing is deleted, and they come
 * back if it's ticked again. Pure functions: no DOM, testable in Node.
 */

export const STATUSES = ['toClaim', 'submitted', 'paid'];
export const STATUS_LABELS = { toClaim: 'To claim', submitted: 'Submitted', paid: 'Paid' };
/** How far back "Add from recent entries" looks. */
export const RECENT_DAYS = 60;
export const MAX_DETAILS = 2000;

/** True if entries on this account may be marked as business expenses. */
export function claimsOn(account) {
  return Boolean(account && account.expenseClaims === true);
}

/** True if the entry is marked as an expense (whatever its account's tick says). */
export function isExpense(tx) {
  return Boolean(tx && tx.expense && typeof tx.expense === 'object');
}

/** An entry that can carry a claim: a stored, non-note, money-out entry. */
export function canBeExpense(tx) {
  return Boolean(tx && !tx.isProjected && tx.kind !== 'note' && tx.direction === 'debit' && tx.amount > 0);
}

function touch(ledger) {
  return { ...ledger, lastModified: new Date().toISOString() };
}

/**
 * Check and tidy an expense against its entry. Throws with a message fit to
 * show. `previous` keeps the timestamps when the status doesn't change.
 */
export function cleanExpense(tx, fields, previous = null) {
  if (!canBeExpense(tx)) throw new Error('Only money going out can be an expense claim');
  const amount = fields.amount ?? previous?.amount ?? tx.amount;
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('The claim amount must be more than £0.00');
  if (amount > tx.amount) throw new Error('The claim amount can’t be more than the entry itself');
  const details = String(fields.details ?? previous?.details ?? '').trim();
  if (details.length > MAX_DETAILS) throw new Error(`Details can be up to ${MAX_DETAILS} characters`);
  const status = fields.status ?? previous?.status ?? 'toClaim';
  if (!STATUSES.includes(status)) throw new Error('Not a claim status');
  return {
    amount,
    details,
    status,
    submittedAt: status === 'toClaim' ? null : (fields.submittedAt ?? previous?.submittedAt ?? null),
    paidAt: status === 'paid' ? (fields.paidAt ?? previous?.paidAt ?? null) : null,
  };
}

/**
 * Mark an entry as an expense (or change its claim), or pass null to unmark it.
 * Only the one entry changes — never the other leg of a transfer.
 */
export function setExpense(ledger, txId, fields) {
  const tx = ledger.transactions.find((t) => t.id === txId);
  if (!tx) throw new Error('Entry not found');
  if (fields === null) {
    if (!isExpense(tx)) return ledger;
    const { expense, ...rest } = tx; // eslint-disable-line no-unused-vars
    return touch({ ...ledger, transactions: ledger.transactions.map((t) => (t.id === txId ? rest : t)) });
  }
  const account = ledger.accounts.find((a) => a.id === tx.accountId);
  if (!claimsOn(account) && !isExpense(tx)) throw new Error('This account isn’t set up for expense claims');
  const expense = cleanExpense(tx, fields, tx.expense ?? null);
  return touch({ ...ledger, transactions: ledger.transactions.map((t) => (t.id === txId ? { ...t, expense } : t)) });
}

/**
 * Move claims to a status. Moving on stamps the time; moving back clears the
 * later stamp (Paid → Submitted keeps when it was submitted).
 */
export function setClaimStatus(ledger, txIds, status, nowIso = new Date().toISOString()) {
  if (!STATUSES.includes(status)) throw new Error('Not a claim status');
  const ids = new Set(txIds);
  let changed = false;
  const transactions = ledger.transactions.map((t) => {
    if (!ids.has(t.id) || !isExpense(t) || t.expense.status === status) return t;
    changed = true;
    const e = { ...t.expense, status };
    if (status === 'toClaim') { e.submittedAt = null; e.paidAt = null; }
    if (status === 'submitted') { e.submittedAt = t.expense.submittedAt ?? nowIso; e.paidAt = null; }
    if (status === 'paid') { e.submittedAt = t.expense.submittedAt ?? nowIso; e.paidAt = nowIso; }
    return { ...t, expense: e };
  });
  return changed ? touch({ ...ledger, transactions }) : ledger;
}

/** The status one tick on (or null at the end), and one untick back. */
export const nextStatus = (s) => STATUSES[STATUSES.indexOf(s) + 1] ?? null;
export const previousStatus = (s) => STATUSES[STATUSES.indexOf(s) - 1] ?? null;

/**
 * The claim amount never exceeds the entry: if the entry's amount is lowered
 * below it, the claim comes down with it. Used by ops.updateTransaction.
 */
export function fitExpense(tx) {
  if (!isExpense(tx) || tx.kind === 'note' || !Number.isInteger(tx.amount) || tx.amount <= 0) return tx;
  if (tx.expense.amount <= tx.amount) return tx;
  return { ...tx, expense: { ...tx.expense, amount: tx.amount } };
}

/**
 * The claim list: every expense on a ticked account, in three sections, each
 * with a count and a total of claim amounts. Oldest first within a section.
 * @param {{ accountId?: string|null }} [opts] one account only
 */
export function claimSections(ledger, { accountId = null } = {}) {
  const ticked = new Map(ledger.accounts.filter(claimsOn).map((a) => [a.id, a]));
  const rows = ledger.transactions
    .filter((t) => isExpense(t) && ticked.has(t.accountId) && (!accountId || t.accountId === accountId))
    .map((t) => ({ tx: t, account: ticked.get(t.accountId), status: STATUSES.includes(t.expense.status) ? t.expense.status : 'toClaim' }))
    .sort((a, b) => (a.tx.date < b.tx.date ? -1 : a.tx.date > b.tx.date ? 1 : 0));
  return STATUSES.map((status) => {
    const list = rows.filter((r) => r.status === status);
    return { status, label: STATUS_LABELS[status], rows: list, count: list.length, total: list.reduce((s, r) => s + r.tx.expense.amount, 0) };
  });
}

/**
 * "Add from recent entries": money-out entries on ticked accounts, not yet
 * expenses, dated in the last RECENT_DAYS days up to today. Newest first.
 */
export function recentCandidates(ledger, today, { accountId = null, days = RECENT_DAYS } = {}) {
  const ticked = new Set(ledger.accounts.filter(claimsOn).map((a) => a.id));
  const from = addDays(today, -days);
  return ledger.transactions
    .filter((t) => ticked.has(t.accountId) && (!accountId || t.accountId === accountId) && canBeExpense(t) && !isExpense(t) && t.date <= today && t.date >= from)
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const pounds = (p) => `£${(p / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const ukDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Text that goes with shared photos: one block per claim, and a total for several. */
export function shareSummary(txs) {
  const blocks = txs.map((t) => {
    const e = t.expense;
    const part = e.amount < t.amount ? ` (of ${pounds(t.amount)})` : '';
    return [`${ukDate(t.date)} · ${pounds(e.amount)}${part} · ${t.description || '(no description)'}`, e.details].filter(Boolean).join('\n');
  });
  if (txs.length > 1) blocks.push(`Total: ${pounds(txs.reduce((s, t) => s + t.expense.amount, 0))} (${txs.length} claims)`);
  return blocks.join('\n\n');
}

/** A file name for a shared photo: date, a short description, a number. */
export function photoFileName(tx, n, of) {
  const words = (tx.description || 'receipt').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'receipt';
  return `${tx.date}-${words}${of > 1 ? `-${n}` : ''}.jpg`;
}

/**
 * ⚙ "Delete photos of paid claims": what it would do, given this device's
 * photo list ([{ id, entryId, size }]). Paid claims only — even on an account
 * that's since been unticked — and nothing else.
 * @returns {{ kind: 'nonePaid'|'nothing'|'some', photoIds: string[], count: number, bytes: number, claims: number }}
 */
export function cleanupPlan(ledger, photos) {
  const paid = new Set(ledger.transactions.filter((t) => isExpense(t) && t.expense.status === 'paid').map((t) => t.id));
  if (!paid.size) return { kind: 'nonePaid', photoIds: [], count: 0, bytes: 0, claims: 0 };
  const doomed = photos.filter((p) => paid.has(p.entryId));
  if (!doomed.length) return { kind: 'nothing', photoIds: [], count: 0, bytes: 0, claims: paid.size };
  return {
    kind: 'some',
    photoIds: doomed.map((p) => p.id),
    count: doomed.length,
    bytes: doomed.reduce((s, p) => s + (p.size ?? 0), 0),
    claims: new Set(doomed.map((p) => p.entryId)).size,
  };
}

export function sizeText(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The message the clean-up shows (a confirm question for 'some'). */
export function cleanupMessage(plan) {
  if (plan.kind === 'nonePaid') return 'No claims are marked as paid yet — mark them Paid in the claim list first.';
  if (plan.kind === 'nothing') return 'Nothing to delete — none of the paid claims has a photo left on this device.';
  return `Delete ${plan.count} photo${plan.count === 1 ? '' : 's'} (${sizeText(plan.bytes)}) of ${plan.claims} paid claim${plan.claims === 1 ? '' : 's'} from this device?\n\nThe claims themselves stay. Copies in your Photos app aren’t touched.`;
}
