/**
 * v0.14 joint account: a second ledger in its own Drive file
 * (My Drive/Finance Joint/joint.json), kept completely apart from the
 * personal one: its own local copy, sync engine, backups and clashes.
 *
 * For drawing, the app COMBINES the two into one display ledger (joint
 * accounts first) so every existing screen works unchanged. Every change made
 * to that combined copy is SPLIT back here: each record goes to the ledger that
 * owns its account, and only a ledger that really changed is saved.
 *
 * Rules the split enforces (see JOINT-STAGE1-DESIGN.md):
 *  - Nothing may link the two files in v0.14. A transfer, recurring item or
 *    setting that points at an account in the OTHER file is refused —
 *    otherwise the next merge would quietly turn a cross-file transfer into
 *    two loose entries. Linked transfers come in v0.15 with their own field.
 *  - A change can never remove the joint account itself.
 * Pure functions, no I/O.
 */
import { emptyLedger, addAccount } from './ops.js';
import { fingerprint } from './sync-core.js';

export const JOINT_FOLDER_NAME = 'Finance Joint';
export const JOINT_FILE_NAME = 'joint.json';
export const JOINT_LEDGER_NAME = 'Joint';
export const JOINT_INSTITUTION = 'joint';
export const JOINT_ACCOUNT_NAME = 'Joint account';

export class CrossLedgerError extends Error {
  constructor(message) { super(message); this.name = 'CrossLedgerError'; }
}

export function emptyJointLedger() {
  return { ...emptyLedger(), name: JOINT_LEDGER_NAME };
}

/** A ledger file is the joint one by its name (exports and backups carry it). */
export const isJointLedger = (ledger) => ledger?.name === JOINT_LEDGER_NAME;

export function addJointAccount(ledger, { openingBalance, openingDate, name = JOINT_ACCOUNT_NAME }) {
  if (ledger.accounts.length) throw new Error('The joint file already has its account');
  return addAccount(ledger, { name, type: 'current', institution: JOINT_INSTITUTION, openingBalance, openingDate }).ledger;
}

/** The ledger the screens draw from: joint accounts first, then personal. Never saved. */
export function combineLedgers(personal, joint) {
  if (!joint) return personal;
  return {
    ...personal,
    accounts: [...joint.accounts, ...personal.accounts],
    transactions: [...personal.transactions, ...joint.transactions],
    transfers: [...personal.transfers, ...joint.transfers],
    scheduledItems: [...personal.scheduledItems, ...joint.scheduledItems],
  };
}

/** Every `…AccountId` field on a record except `accountId` (which decides the owner). */
function otherAccountRefs(rec) {
  return Object.entries(rec).filter(([k, v]) => k !== 'accountId' && /AccountId$/.test(k) && typeof v === 'string').map(([, v]) => v);
}

/**
 * Split a changed combined ledger back into its two files.
 * @returns {{ personal: object, joint: object, personalChanged: boolean, jointChanged: boolean }}
 * @throws {CrossLedgerError} when the change would link the two files
 */
export function splitLedger(combined, { personal, joint }) {
  const jointIds = new Set(joint.accounts.map((a) => a.id));
  const personalIds = new Set(combined.accounts.map((a) => a.id).filter((id) => !jointIds.has(id)));
  const isJointAcc = (id) => jointIds.has(id);

  const recurringOwner = new Map();
  for (const r of combined.scheduledItems) if (r.recordType === 'recurring') recurringOwner.set(r.id, isJointAcc(r.accountId));
  const wasJoint = new Set(joint.scheduledItems.map((r) => r.id));
  const scheduledIsJoint = (r) => {
    if (r.recordType === 'recurring') return isJointAcc(r.accountId);
    if (r.recordType === 'occurrence') return recurringOwner.get(r.itemId) ?? wasJoint.has(r.id);
    return false; // settings records (ticket purchases) are personal
  };

  const out = { personal: { accounts: [], transactions: [], transfers: [], scheduledItems: [] }, joint: { accounts: [], transactions: [], transfers: [], scheduledItems: [] } };
  const place = (key, rec, inJoint, what) => {
    const others = inJoint ? personalIds : jointIds;
    if (otherAccountRefs(rec).some((id) => others.has(id))) {
      throw new CrossLedgerError(`${what} can’t link your own accounts and the Joint account yet — that comes in the next version. Enter it as money out of one and money into the other.`);
    }
    out[inJoint ? 'joint' : 'personal'][key].push(rec);
  };

  for (const a of combined.accounts) (isJointAcc(a.id) ? out.joint : out.personal).accounts.push(a);
  for (const t of combined.transactions) place('transactions', t, isJointAcc(t.accountId), 'An entry');
  for (const tr of combined.transfers) place('transfers', tr, isJointAcc(tr.fromAccountId), 'A transfer');
  for (const r of combined.scheduledItems) place('scheduledItems', r, scheduledIsJoint(r), r.recordType === 'recurring' ? 'A recurring item' : 'A setting');

  // both legs of a transfer must land in the same file
  const legOwner = new Map();
  for (const t of combined.transactions) {
    if (!t.transferId) continue;
    const j = isJointAcc(t.accountId);
    if (legOwner.has(t.transferId) && legOwner.get(t.transferId) !== j) {
      throw new CrossLedgerError('A transfer can’t link your own accounts and the Joint account yet — that comes in the next version. Enter it as money out of one and money into the other.');
    }
    legOwner.set(t.transferId, j);
  }

  if (joint.accounts.length && !out.joint.accounts.length) {
    throw new CrossLedgerError('The Joint account can’t be removed here. Turn the joint account off in ⚙ instead.');
  }

  const nextPersonal = { ...personal, ...out.personal };
  const nextJoint = { ...joint, ...out.joint };
  const personalChanged = fingerprint(nextPersonal) !== fingerprint(personal);
  const jointChanged = fingerprint(nextJoint) !== fingerprint(joint);
  return {
    personal: personalChanged ? { ...nextPersonal, lastModified: combined.lastModified } : personal,
    joint: jointChanged ? { ...nextJoint, lastModified: combined.lastModified } : joint,
    personalChanged,
    jointChanged,
  };
}

/** Accounts an entry on `accountId` may transfer to (v0.14: same file only). */
export function sameLedgerAccounts(accounts, accountId, jointIds) {
  const j = jointIds.has(accountId);
  return accounts.filter((a) => jointIds.has(a.id) === j);
}
