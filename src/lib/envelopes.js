/**
 * v0.12 — envelopes (Monzo pots: Maintenance / Health / Transport / Home
 * Insurance). Pure functions, no DOM.
 *
 * WHAT IS STORED
 *   account.envelopes = { enabled: true, list: [{ id, name, openingBalance, hidden }] }
 *     - envelopes are referred to by ID everywhere, so renaming one never
 *       orphans entries. List order = display order, and the order spare
 *       pennies go in when interest is split evenly.
 *     - openingBalance = the envelope's share of the account's opening
 *       balance on the account's opening date. Whatever isn't given to an
 *       envelope is "Unallocated".
 *   transaction.envelopeSplits = [{ envelopeId, amount }] on an entry in an
 *     envelope account. Amounts are positive pence and add up to the entry's
 *     amount; the entry's direction says whether they go in or out.
 *     null/absent = the whole entry is Unallocated (every entry made before
 *     v0.12, so nothing old needs changing).
 *   A MOVE between envelopes is a note (kind 'note', amount 0 — so it moves
 *     nothing in the account's own balance, and older devices just show a
 *     note) with two SIGNED splits that add up to 0, e.g.
 *     [{ envelopeId: transport, amount: -17150 }, { envelopeId: health, amount: 17150 }].
 *     envelopeId null in a move = Unallocated.
 *
 * WHAT IS DERIVED
 *   Envelope balances — never stored, like account balances. Unallocated =
 *   account balance − everything in the envelopes, so the envelopes can
 *   never disagree with the account.
 */
import { randomUUID } from './id.js';
import { sortForBalance } from './balances.js';

export const UNALLOCATED = null;

/** The account's envelope settings if it uses envelopes, else null. */
export function envelopeConfig(account) {
  const e = account?.envelopes;
  if (!e?.enabled || !Array.isArray(e.list) || e.list.length === 0) return null;
  return e;
}

/** Envelopes in display order; hidden ones only when asked. */
export function envelopeList(account, { includeHidden = false } = {}) {
  const cfg = envelopeConfig(account);
  if (!cfg) return [];
  return includeHidden ? cfg.list : cfg.list.filter((e) => !e.hidden);
}

export function envelopeName(account, id) {
  if (id === UNALLOCATED) return 'Unallocated';
  return account?.envelopes?.list?.find((e) => e.id === id)?.name ?? 'Unknown envelope';
}

export function newEnvelope(name, openingBalance = 0) {
  return { id: randomUUID(), name: String(name ?? '').trim(), openingBalance, hidden: false };
}

/**
 * Check and tidy an account's envelope settings. `inUse` = ids that entries
 * or recurring items point at (they can be hidden, never removed).
 * @returns the cleaned config, or null when there are no envelopes
 */
export function cleanEnvelopeConfig(cfg, previous = null, inUse = new Set()) {
  if (!cfg) return null;
  const list = (cfg.list ?? []).map((e) => ({
    id: e.id || randomUUID(),
    name: String(e.name ?? '').trim(),
    openingBalance: e.openingBalance ?? 0,
    hidden: Boolean(e.hidden),
  }));
  const names = new Set();
  for (const e of list) {
    if (!e.name) throw new Error('Every envelope needs a name');
    const key = e.name.toLowerCase();
    if (key === 'unallocated') throw new Error('“Unallocated” is kept for money not in an envelope — pick another name');
    if (names.has(key)) throw new Error(`Two envelopes are called “${e.name}”`);
    names.add(key);
    if (!Number.isInteger(e.openingBalance)) throw new Error(`Opening amount for ${e.name} must be whole pence`);
  }
  const ids = new Set(list.map((e) => e.id));
  for (const old of previous?.list ?? []) {
    if (!ids.has(old.id) && inUse.has(old.id)) throw new Error(`${old.name} has entries — hide it instead of removing it`);
  }
  if (list.length === 0 && ![...inUse].length) return null;
  return { enabled: cfg.enabled !== false, list };
}

/** Ids of envelopes that entries or recurring items in this account point at. */
export function envelopesInUse(ledger, accountId) {
  const used = new Set();
  for (const t of ledger.transactions) {
    if (t.accountId !== accountId || !Array.isArray(t.envelopeSplits)) continue;
    for (const s of t.envelopeSplits) if (s.envelopeId) used.add(s.envelopeId);
  }
  for (const r of ledger.scheduledItems ?? []) {
    if (r.recordType !== 'recurring' || !Array.isArray(r.envelopeSplits)) continue;
    if (r.accountId !== accountId && r.toAccountId !== accountId) continue;
    for (const s of r.envelopeSplits) if (s.envelopeId) used.add(s.envelopeId);
  }
  return used;
}

/** Account opening balance not given to any envelope (pence, may be negative). */
export function openingUnallocated(account) {
  const list = account?.envelopes?.list ?? [];
  return account.openingBalance - list.reduce((s, e) => s + (e.openingBalance ?? 0), 0);
}

// ------------------------------------------------------------------ splits

const sum = (splits) => splits.reduce((s, x) => s + x.amount, 0);

/**
 * Check splits for an ordinary entry of `amount` pence. Empty → null
 * (Unallocated). Throws a readable error otherwise.
 */
export function validateSplits(account, amount, splits) {
  if (splits == null || splits.length === 0) return null;
  const known = new Set((account?.envelopes?.list ?? []).map((e) => e.id));
  if (!known.size) throw new Error(`${account?.name ?? 'This account'} doesn’t use envelopes`);
  const seen = new Set();
  const out = [];
  for (const s of splits) {
    if (!known.has(s.envelopeId)) throw new Error('Pick an envelope');
    if (seen.has(s.envelopeId)) throw new Error('The same envelope is in the split twice');
    seen.add(s.envelopeId);
    if (!Number.isInteger(s.amount) || s.amount < 0) throw new Error('Envelope amounts must be £0.00 or more');
    if (s.amount > 0) out.push({ envelopeId: s.envelopeId, amount: s.amount });
  }
  if (sum(out) !== amount) throw new Error('The envelope amounts must add up to the entry’s amount');
  return out.length ? out : null;
}

/**
 * Splits for an entry whose amount has changed (a transfer's other leg was
 * edited, a recurring month has a different amount). One envelope simply
 * follows the new amount; a split that no longer adds up becomes
 * Unallocated rather than guessing.
 */
export function fitSplits(splits, amount) {
  if (!Array.isArray(splits) || splits.length === 0 || !(amount > 0)) return null;
  if (splits.length === 1) return [{ envelopeId: splits[0].envelopeId, amount }];
  return sum(splits) === amount ? splits.map((s) => ({ ...s })) : null;
}

/**
 * Split evenly (interest): whole pence each, the spare pennies going one
 * each to the first envelopes. £1.95 over 4 → 49, 49, 49, 48.
 */
export function splitEvenly(amount, envelopeIds) {
  const n = envelopeIds.length;
  if (!n) return [];
  const base = Math.floor(amount / n);
  const spare = amount - base * n;
  return envelopeIds.map((envelopeId, i) => ({ envelopeId, amount: base + (i < spare ? 1 : 0) }));
}

export function isEnvelopeMove(t) {
  return t?.kind === 'note' && Array.isArray(t.envelopeSplits) && t.envelopeSplits.length > 0;
}

/**
 * How an entry is allocated, for the row tag:
 *   { type: 'single', envelopeId } | { type: 'split', count } | { type: 'move', from, to, amount }
 *   | { type: 'unallocated' } | null (not an envelope entry: a plain note)
 */
export function allocationOf(t, account) {
  if (!envelopeConfig(account)) return null;
  if (isEnvelopeMove(t)) {
    const from = t.envelopeSplits.find((s) => s.amount < 0);
    const to = t.envelopeSplits.find((s) => s.amount > 0);
    return { type: 'move', from: from?.envelopeId ?? null, to: to?.envelopeId ?? null, amount: to?.amount ?? 0 };
  }
  if (t.kind === 'note') return null;
  const ok = Array.isArray(t.envelopeSplits) && t.envelopeSplits.length && sum(t.envelopeSplits) === t.amount;
  if (!ok) return { type: 'unallocated' };
  if (t.envelopeSplits.length === 1) return { type: 'single', envelopeId: t.envelopeSplits[0].envelopeId };
  return { type: 'split', count: t.envelopeSplits.length };
}

// ------------------------------------------------------------------ balances

/**
 * Each envelope's change from one entry: [[envelopeId|null, signedPence], ...].
 * Splits pointing at an envelope that no longer exists, or that don't add
 * up, fall to Unallocated so the total always equals the account.
 */
export function envelopeChanges(t, known) {
  if (t.skipped) return [];
  if (isEnvelopeMove(t)) {
    if (sum(t.envelopeSplits) !== 0) return []; // a damaged move moves nothing
    return t.envelopeSplits.map((s) => [s.envelopeId && known.has(s.envelopeId) ? s.envelopeId : null, s.amount]);
  }
  if (t.kind === 'note') return [];
  const sign = t.direction === 'credit' ? 1 : -1;
  const splits = Array.isArray(t.envelopeSplits) ? t.envelopeSplits : [];
  if (!splits.length || sum(splits) !== t.amount) return [[null, sign * t.amount]];
  return splits.map((s) => [known.has(s.envelopeId) ? s.envelopeId : null, sign * s.amount]);
}

/**
 * Envelope balances for an envelope account, counting entries dated on or
 * before `asOfIso` (null = everything). Feed it the projection view ledger
 * for end-of-month figures.
 * @returns {{ byId: Object.<string, number>, unallocated: number, total: number }}
 */
export function envelopeBalances(ledger, account, asOfIso = null) {
  const list = account?.envelopes?.list ?? [];
  const known = new Set(list.map((e) => e.id));
  const byId = Object.fromEntries(list.map((e) => [e.id, e.openingBalance ?? 0]));
  let unallocated = openingUnallocated(account);
  for (const t of ledger.transactions) {
    if (t.accountId !== account.id) continue;
    if (asOfIso && t.date > asOfIso) continue;
    for (const [id, change] of envelopeChanges(t, known)) {
      if (id === null) unallocated += change;
      else byId[id] += change;
    }
  }
  const total = unallocated + Object.values(byId).reduce((s, v) => s + v, 0);
  return { byId, unallocated, total };
}

/**
 * One envelope's own history, like a column of the pots spreadsheet:
 * every entry that touches it, oldest first, with its running balance.
 * envelopeId null = Unallocated.
 * @returns {{ opening: number, rows: { transaction: object, change: number, balance: number }[] }}
 */
export function envelopeHistory(ledger, account, envelopeId) {
  const list = account?.envelopes?.list ?? [];
  const known = new Set(list.map((e) => e.id));
  const opening = envelopeId === null ? openingUnallocated(account) : list.find((e) => e.id === envelopeId)?.openingBalance ?? 0;
  let balance = opening;
  const rows = [];
  const mine = ledger.transactions.filter((t) => t.accountId === account.id);
  for (const t of sortForBalance(mine)) {
    const change = envelopeChanges(t, known).filter(([id]) => id === envelopeId).reduce((s, [, c]) => s + c, 0);
    const touches = envelopeChanges(t, known).some(([id]) => id === envelopeId);
    if (!touches) continue;
    balance += change;
    rows.push({ transaction: t, change, balance });
  }
  return { opening, rows };
}

/** Real (not projected) entries in this account still waiting for an envelope. */
export function unallocatedEntries(ledger, account) {
  if (!envelopeConfig(account)) return [];
  return ledger.transactions.filter((t) => t.accountId === account.id && !t.isProjected && allocationOf(t, account)?.type === 'unallocated');
}
