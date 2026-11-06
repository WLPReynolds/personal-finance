// Builds the starting ledger for tickets_v013.py: Current Account, Barclaycard
// (13th working day, pays the statement), Monzo pots with envelopes, Safe keeping.
// Train fare/Parking takes its amount from the ticket tracker: since v0.14 the Ticket tracker
// settings (where Ticket purchases are switched on) only appear when an item uses the tracker.
// Run: node dev/e2e/make_ticket_ledger.mjs > out.json
import { emptyLedger, addAccount } from '../../src/lib/ops.js';
import { addRecurring } from '../../src/lib/schedule.js';
import { buildExport } from '../../src/lib/transfer-file.js';

let r = addAccount(emptyLedger(), { name: 'Current Account', type: 'current', institution: 'other', openingBalance: 200000, openingDate: '2026-10-01' });
const current = r.account;
r = addAccount(r.ledger, { name: 'Barclaycard', type: 'credit', institution: 'barclaycard', openingBalance: 0, openingDate: '2026-10-01', creditCard: { statementWorkingDay: 13 } });
const card = r.account;
r = addAccount(r.ledger, {
  name: 'Monzo pots', type: 'savings', institution: 'monzo', openingBalance: 100000, openingDate: '2026-10-01',
  envelopes: { enabled: true, list: [{ id: 'env-m', name: 'Maintenance', openingBalance: 20000 }, { id: 'env-t', name: 'Transport', openingBalance: 80000 }] },
});
r = addAccount(r.ledger, { name: 'Safe keeping', type: 'savings', institution: 'monzo', openingBalance: 0, openingDate: '2026-10-01' });
const withCard = addRecurring(r.ledger, {
  description: 'Barclaycard', kind: 'transfer', accountId: current.id, toAccountId: card.id, amount: 0, payStatement: true,
  everyMonths: 1, day: 1, startDate: '2026-10-07', endDate: null, shift: 'after',
}).ledger;
const ledger = addRecurring(withCard, {
  description: 'Train fare/Parking', kind: 'out', accountId: current.id, toAccountId: null, amount: 46200, amountFrom: 'ticket-tracker',
  everyMonths: 1, day: 28, startDate: '2026-10-01', endDate: null, shift: 'before',
}).ledger;
process.stdout.write(JSON.stringify(buildExport(ledger, 'e2e')));
