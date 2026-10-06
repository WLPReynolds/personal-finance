// v0.11 — ticket tracker figures: file checks, projections, reading from Drive.
// Run with: node src/lib/__tests__/tracker-tests.mjs
import assert from 'node:assert/strict';
import { BUILT_IN_BANK_HOLIDAYS } from '../workdays.js';
import {
  addRecurring, updateRecurring, setOccurrence, confirmOccurrence, projections, withProjections, recurringItems,
} from '../schedule.js';
import { emptyLedger, addAccount, balanceAsOf } from '../ops.js';
import { buildExport, parseImport } from '../transfer-file.js';
import { prepareMerge } from '../sync-core.js';
import {
  parseTrackerEstimates, trackerPeriodFor, usesTracker, refreshTrackerEstimates, TRACKER_SOURCE, TRACKER_FILE_NAME,
} from '../tracker-estimates.js';
import { createSyncEngine } from '../sync-engine.js';
import { createFakeDrive, createFakeAuth, createFakeStore } from './fake-drive.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.stack.split('\n').slice(0, 3).join('\n    ')}`);
  }
}

const HOL = new Set(BUILT_IN_BANK_HOLIDAYS);

// The spec's example: Sep period locked at £422.22, then projections.
function period(start, end, status, tickets, parkingDays, ticketPence = 15360, dayPence = 639) {
  const tp = tickets * ticketPence;
  const pp = parkingDays * dayPence;
  return { paydayMonth: start.slice(0, 7), start, end, status, ticketCount: tickets, ticketPence: tp, parkingDays, parkingPence: pp, totalPence: tp + pp };
}
function sampleFile(extra = {}) {
  return {
    format: 'transport-estimates',
    version: 1,
    generatedAt: '2026-10-06T19:20:00.000Z',
    source: { app: 'ticket-tracker', appVersion: 'v2026-10-06.19:20' },
    assumptions: { ticketPricePence: 15360, parkingDayPence: 639 },
    periods: [
      period('2026-09-28', '2026-10-27', 'locked', 2, 18),
      period('2026-10-28', '2026-11-26', 'projected', 2, 21),
      period('2026-11-27', '2026-12-23', 'projected', 1, 17),
      period('2026-12-24', '2027-01-27', 'projected', 2, 16),
    ],
    ...extra,
  };
}
const parsed = (obj) => parseTrackerEstimates(JSON.stringify(obj));

function setup() {
  let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 500000, openingDate: '2026-10-01' });
  const current = r.account;
  r = addAccount(r.ledger, { name: 'Monzo pot', type: 'savings', institution: 'monzo', openingBalance: 0, openingDate: '2026-10-01' });
  const pot = r.account;
  const added = addRecurring(r.ledger, {
    description: 'Train fare/Parking', kind: 'transfer', accountId: current.id, toAccountId: pot.id,
    amount: 46200, everyMonths: 1, everyDays: null, day: 28, startDate: '2026-10-01', endDate: null, shift: 'before',
    finalAmount: null, firstNumber: 1, payStatement: false, amountFrom: TRACKER_SOURCE,
  });
  return { ledger: added.ledger, item: added.item, current, pot };
}
const tracker = parsed(sampleFile()).estimates;

console.log('tracker-tests');

// ---------------------------------------------------------------- the file

await test('the spec’s example file is accepted; totals are tickets + parking in pence', () => {
  const r = parsed(sampleFile());
  assert.equal(r.ok, true);
  assert.equal(r.estimates.periods.length, 4);
  assert.equal(r.estimates.periods[0].totalPence, 42222); // £307.20 + £115.02
  assert.equal(r.estimates.appVersion, 'v2026-10-06.19:20');
  assert.equal(trackerPeriodFor(r.estimates, '2026-09').status, 'locked');
  assert.equal(trackerPeriodFor(r.estimates, '2027-05'), null);
});

await test('bad files are refused with a readable reason', () => {
  const cases = [
    ['not json', '{', /valid JSON/],
    ['wrong format', JSON.stringify({ ...sampleFile(), format: 'something-else' }), /doesn’t look like/],
    ['newer version', JSON.stringify(sampleFile({ version: 2 })), /format version 2.*Update Personal Finance/],
    ['no version', JSON.stringify(sampleFile({ version: '1' })), /format version/],
    ['bad time', JSON.stringify(sampleFile({ generatedAt: 'yesterday' })), /generatedAt/],
    ['no periods', JSON.stringify(sampleFile({ periods: [] })), /no periods/],
  ];
  for (const [label, text, re] of cases) {
    const r = parseTrackerEstimates(text);
    assert.equal(r.ok, false, label);
    assert.match(r.error, re, label);
  }
  const broken = (fn) => { const f = sampleFile(); fn(f.periods); return parsed(f); };
  assert.match(broken((p) => { p[1].totalPence += 1; }).error, /period 2 \(2026-10\) has a total that isn’t tickets \+ parking/);
  assert.match(broken((p) => { p[0].parkingPence = 115.02; p[0].totalPence = 30835.02; }).error, /whole pence/);
  assert.match(broken((p) => { p[0].paydayMonth = '2026-10'; }).error, /isn’t its start date’s month/);
  assert.match(broken((p) => { p[2].start = '2026-11-28'; p[2].paydayMonth = '2026-11'; }).error, /doesn’t start the day after/);
  assert.match(broken((p) => { p[1].status = 'guess'; }).error, /status/);
  assert.match(broken((p) => { p[0].start = '2026-02-30'; }).error, /invalid start or end date/);
  assert.match(broken((p) => { p[0].ticketCount = -1; }).error, /whole number/);
});

await test('usesTracker: only when a recurring item has it switched on', () => {
  const { ledger, item } = setup();
  assert.equal(usesTracker(ledger), true);
  const off = updateRecurring(ledger, item.id, { amountFrom: null });
  assert.equal(usesTracker(off), false);
  assert.equal(usesTracker(emptyLedger()), false);
});

// ---------------------------------------------------------------- projections

await test('each projected month takes the tracker’s total for the period starting that month', () => {
  const { ledger, item } = setup();
  const ps = projections(ledger, '2026-12-31', HOL, { tracker }).filter((p) => p.itemId === item.id);
  assert.deepEqual(ps.map((p) => [p.period, p.date, p.amount, p.amountSource]), [
    ['2026-10', '2026-10-28', 44139, 'tracker'], // 2×£153.60 + 21×£6.39
    ['2026-11', '2026-11-27', 26223, 'tracker'], // 28 Nov is a Saturday → Friday 27th
    ['2026-12', '2026-12-24', 40944, 'tracker'], // 28 Dec 2026 is a bank holiday (Boxing Day substitute) → 24th
  ]);
  assert.equal(ps[0].tracker.status, 'projected');
  assert.equal(ps[0].tracker.generatedAt, '2026-10-06T19:20:00.000Z');
  assert.equal(ps[0].seriesAmount, 44139, 'the tracker figure is the series amount — a one-off is compared against it');
});

await test('no file, or no figure for a month → the item’s own amount, marked as a fallback', () => {
  const { ledger, item } = setup();
  const none = projections(ledger, '2026-11-30', HOL).filter((p) => p.itemId === item.id);
  assert.deepEqual(none.map((p) => [p.amount, p.amountSource]), [[46200, 'fallback'], [46200, 'fallback']]);
  const later = projections(ledger, '2027-03-31', HOL, { tracker }).filter((p) => p.itemId === item.id);
  assert.deepEqual(later.map((p) => [p.period, p.amount, p.amountSource]), [
    ['2026-10', 44139, 'tracker'], ['2026-11', 26223, 'tracker'], ['2026-12', 40944, 'tracker'],
    ['2027-01', 46200, 'fallback'], ['2027-02', 46200, 'fallback'], ['2027-03', 46200, 'fallback'],
  ]);
});

await test('an item without the option ignores the tracker completely', () => {
  const { ledger, item } = setup();
  const off = updateRecurring(ledger, item.id, { amountFrom: null });
  const ps = projections(off, '2026-11-30', HOL, { tracker }).filter((p) => p.itemId === item.id);
  assert.deepEqual(ps.map((p) => [p.amount, p.amountSource ?? null]), [[46200, null], [46200, null]]);
});

await test('a one-off amount still wins; skip still skips; confirmed months stay as confirmed', () => {
  const { ledger, item } = setup();
  let l = setOccurrence(ledger, item.id, '2026-10', { amount: 40000 });
  l = setOccurrence(l, item.id, '2026-11', { skipped: true });
  let ps = projections(l, '2026-12-31', HOL, { tracker }).filter((p) => p.itemId === item.id);
  assert.deepEqual(ps.map((p) => [p.period, p.amount, p.skipped, p.changed]), [
    ['2026-10', 40000, false, true], ['2026-11', 26223, true, false], ['2026-12', 40944, false, false],
  ]);
  l = confirmOccurrence(l, item.id, '2026-12', { date: '2026-12-24', amount: 40944, description: null });
  const changedTracker = parsed(sampleFile({ periods: sampleFile().periods.map((p) => (p.paydayMonth === '2026-12' ? period(p.start, p.end, 'projected', 3, 17) : p)) })).estimates;
  ps = projections(l, '2026-12-31', HOL, { tracker: changedTracker }).filter((p) => p.itemId === item.id);
  assert.equal(ps.some((p) => p.period === '2026-12'), false, 'confirmed — no projection');
  const tx = l.transactions.find((t) => t.id === `sched:${item.id}:2026-12:out`);
  assert.equal(tx.amount, 40944, 'the confirmed entry keeps what was confirmed');
});

await test('a tracker total of £0 means no payment that month (unless a one-off amount is set)', () => {
  const { ledger, item } = setup();
  const zero = parsed(sampleFile({ periods: sampleFile().periods.map((p) => (p.paydayMonth === '2026-10' ? period(p.start, p.end, 'projected', 0, 0) : p)) })).estimates;
  let ps = projections(ledger, '2026-11-30', HOL, { tracker: zero }).filter((p) => p.itemId === item.id);
  assert.deepEqual(ps.map((p) => p.period), ['2026-11']);
  const l = setOccurrence(ledger, item.id, '2026-10', { amount: 1000 });
  ps = projections(l, '2026-11-30', HOL, { tracker: zero }).filter((p) => p.itemId === item.id);
  assert.deepEqual(ps.map((p) => [p.period, p.amount]), [['2026-10', 1000], ['2026-11', 26223]]);
});

await test('balances follow the tracker figures (end of December)', () => {
  const { ledger, current, pot } = setup();
  const view = withProjections(ledger, '2026-12-31', HOL, { tracker });
  assert.equal(balanceAsOf(view, pot, '2026-12-31'), 44139 + 26223 + 40944);
  assert.equal(balanceAsOf(view, current, '2026-12-31'), 500000 - (44139 + 26223 + 40944));
});

await test('statement payments can’t take the tracker’s figure (the option is cleared)', () => {
  const { ledger, current } = setup();
  let r = addAccount(ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 0, openingDate: '2026-10-01', creditCard: { statementWorkingDay: 13, paymentDaysAfter: 25 } });
  const added = addRecurring(r.ledger, {
    description: 'Barclaycard', kind: 'transfer', accountId: current.id, toAccountId: r.account.id,
    amount: 0, everyMonths: 1, everyDays: null, day: 1, startDate: '2026-10-01', endDate: null, shift: 'after',
    finalAmount: null, firstNumber: 1, payStatement: true, amountFrom: TRACKER_SOURCE,
  });
  assert.equal(added.item.amountFrom, null);
  // and an out/in item keeps it
  const out = addRecurring(r.ledger, {
    description: 'Parking', kind: 'out', accountId: current.id, toAccountId: null, amount: 500, everyMonths: 1, everyDays: null,
    day: 1, startDate: '2026-10-01', endDate: null, shift: 'none', finalAmount: null, firstNumber: 1, payStatement: false, amountFrom: TRACKER_SOURCE,
  });
  assert.equal(out.item.amountFrom, TRACKER_SOURCE);
});

await test('the option survives export/import and merges like any other edit; old items have none', () => {
  const { ledger, item } = setup();
  const back = parseImport(JSON.stringify(buildExport(ledger))).ledger;
  assert.equal(recurringItems(back)[0].amountFrom, TRACKER_SOURCE);
  const base = updateRecurring(ledger, item.id, { amountFrom: null });
  const local = updateRecurring(base, item.id, { amountFrom: TRACKER_SOURCE });
  const remote = updateRecurring(base, item.id, { description: 'Train fare/Parking (Monzo)' });
  const { merged, groups } = prepareMerge({ base, local, remote });
  assert.equal(groups.length, 1, 'same record edited on both devices → the usual clash choice');
  assert.ok(merged);
  // an item saved before v0.11 (no field) projects as before
  const old = { ...ledger, scheduledItems: ledger.scheduledItems.map((r) => { const { amountFrom, ...rest } = r; return rest; }) };
  const ps = projections(old, '2026-10-31', HOL, { tracker });
  assert.equal(ps[0].amount, 46200);
});

// ---------------------------------------------------------------- reading from Drive

function fakeDrive(files = []) {
  const calls = { find: 0, download: 0 };
  return {
    files,
    calls,
    async findFilesByName(token, name) {
      calls.find++;
      assert.equal(name, TRACKER_FILE_NAME);
      return files.filter((f) => f.name === name).map((f) => ({ id: f.id, version: f.version }));
    },
    async download(token, id) {
      calls.download++;
      const f = files.find((x) => x.id === id);
      if (f.fail) throw new Error('HTTP 500');
      return f.text;
    },
  };
}
const fixedNow = () => new Date('2026-10-06T19:30:00Z');

await test('refresh: no file yet → a clear message, nothing else changes', async () => {
  const drive = fakeDrive();
  const rec = await refreshTrackerEstimates({ drive, token: 't', cached: null, now: fixedNow });
  assert.equal(rec.estimates, null);
  assert.match(rec.error, /hasn’t shared its figures yet/);
  assert.equal(rec.checkedAt, '2026-10-06T19:30:00.000Z');
});

await test('refresh: reads a new file, then doesn’t download again until its version changes', async () => {
  const f = { id: 'A', name: TRACKER_FILE_NAME, version: '5', text: JSON.stringify(sampleFile()) };
  const drive = fakeDrive([f]);
  let rec = await refreshTrackerEstimates({ drive, token: 't', cached: null, now: fixedNow });
  assert.equal(rec.error, null);
  assert.equal(rec.estimates.periods[0].totalPence, 42222);
  rec = await refreshTrackerEstimates({ drive, token: 't', cached: rec, now: fixedNow });
  assert.equal(drive.calls.download, 1, 'unchanged version — not downloaded again');
  f.version = '6';
  f.text = JSON.stringify(sampleFile({ generatedAt: '2026-10-07T08:00:00.000Z' }));
  rec = await refreshTrackerEstimates({ drive, token: 't', cached: rec, now: fixedNow });
  assert.equal(drive.calls.download, 2);
  assert.equal(rec.estimates.generatedAt, '2026-10-07T08:00:00.000Z');
});

await test('refresh: a bad new version keeps the last good figures and says why', async () => {
  const f = { id: 'A', name: TRACKER_FILE_NAME, version: '5', text: JSON.stringify(sampleFile()) };
  const drive = fakeDrive([f]);
  const good = await refreshTrackerEstimates({ drive, token: 't', cached: null, now: fixedNow });
  f.version = '6';
  f.text = JSON.stringify(sampleFile({ version: 2 }));
  const rec = await refreshTrackerEstimates({ drive, token: 't', cached: good, now: fixedNow });
  assert.deepEqual(rec.estimates, good.estimates);
  assert.match(rec.error, /format version 2/);
  // the same bad version isn't downloaded over and over
  await refreshTrackerEstimates({ drive, token: 't', cached: rec, now: fixedNow });
  assert.equal(drive.calls.download, 2);
});

await test('refresh: a failed download keeps the figures and tries again next time', async () => {
  const f = { id: 'A', name: TRACKER_FILE_NAME, version: '5', text: JSON.stringify(sampleFile()) };
  const drive = fakeDrive([f]);
  const good = await refreshTrackerEstimates({ drive, token: 't', cached: null, now: fixedNow });
  f.version = '6';
  f.fail = true;
  const rec = await refreshTrackerEstimates({ drive, token: 't', cached: good, now: fixedNow });
  assert.deepEqual(rec.estimates, good.estimates);
  assert.match(rec.error, /Couldn’t read/);
  f.fail = false;
  const again = await refreshTrackerEstimates({ drive, token: 't', cached: rec, now: fixedNow });
  assert.equal(again.error, null);
  assert.equal(drive.calls.download, 3);
});

await test('refresh: two files with the name → the oldest is used; an expired sign-in is passed up', async () => {
  const drive = fakeDrive([
    { id: 'OLD', name: TRACKER_FILE_NAME, version: '1', text: JSON.stringify(sampleFile()) },
    { id: 'NEW', name: TRACKER_FILE_NAME, version: '1', text: '{' },
  ]);
  const rec = await refreshTrackerEstimates({ drive, token: 't', cached: null, now: fixedNow });
  assert.equal(rec.fileId, 'OLD');
  assert.equal(rec.error, null);
  const expired = { async findFilesByName() { const e = new Error('Google sign-in expired'); e.auth = true; throw e; } };
  await assert.rejects(refreshTrackerEstimates({ drive: expired, token: 't', cached: rec }), /expired/);
});

// ---------------------------------------------------------------- with the sync engine

await test('sync engine: afterSync gets the token after each sync; its failures never fail the sync', async () => {
  const drive = createFakeDrive();
  const { ledger } = setup();
  drive.putForeignFile(TRACKER_FILE_NAME, JSON.stringify(sampleFile()));
  let seen = null;
  let blowUp = false;
  const engine = createSyncEngine({
    auth: createFakeAuth(), drive, store: createFakeStore(ledger),
    afterSync: async (token) => {
      if (blowUp) throw new Error('boom');
      seen = await refreshTrackerEstimates({ drive, token, cached: seen });
    },
  });
  await engine.init();
  const first = await engine.connect();
  assert.equal(first.status, 'pushed');
  assert.equal(seen.estimates.periods[0].totalPence, 42222);
  blowUp = true;
  const again = await engine.sync();
  assert.equal(again.status, 'unchanged');
  assert.equal(engine.getState().status, 'idle');
  // "Check now" path
  const n = await engine.withSyncToken(async (token) => (await drive.findFilesByName(token, TRACKER_FILE_NAME)).length);
  assert.equal(n, 1);
  await engine.disconnect();
  await assert.rejects(engine.withSyncToken(async () => 1), /Turn on Drive sync/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
