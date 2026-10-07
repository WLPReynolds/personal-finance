/**
 * Core data model for the finance tracker.
 *
 * These are plain JS object shapes (JSDoc typedefs, not classes) because
 * everything here gets serialized straight to/from JSON (IndexedDB now,
 * Google Drive later). Keep every field JSON-safe: no Date objects (use ISO
 * date strings), no undefined (use null), no functions.
 *
 * MONEY: every amount/balance field is an INTEGER NUMBER OF PENCE.
 * £12.34 is stored as 1234. Convert only at the UI edge (src/lib/money.js).
 * This avoids the binary-float drift visible in the spreadsheets.
 *
 * Schema version 2 (this file): pence everywhere; Account.balance removed
 * (balances are always derived from transactions, so they can never
 * disagree); Account.openingBalance/openingDate added; Transaction.kind
 * gains 'note'.
 */

/**
 * @typedef {Object} Account
 * @property {string} id                 - uuid
 * @property {string} name                - e.g. "Current Account", "Barclaycard"
 * @property {'current'|'savings'|'credit'} type
 * @property {string} institution         - e.g. "barclaycard", "nationwide", "mbna", "monzo", "monzoflex", "chase", "klarna", "very", "other" — used to look up colour/branding
 * @property {number} openingBalance      - pence, as the user reads it: for 'credit' accounts this is the amount OWED (positive = you owe the card)
 * @property {string} openingDate         - ISO date the opening balance applies from ("brought forward" date)
 * @property {boolean} active             - false = hidden/closed but data retained
 * @property {'personal'|'shared'} storageLocation
 * @property {string|null} sharedFileId   - Drive file id, only set when storageLocation === 'shared'
 * @property {CreditCardDetails|null} creditCard - only set when type === 'credit'
 * @property {EnvelopeConfig|null} envelopes      - only set when this account uses envelope/pot splitting
 * @property {string} createdAt           - ISO datetime
 */

/**
 * @typedef {Object} CreditCardDetails
 * @property {number|null} statementWorkingDay   - e.g. 13 means "13th working day of the month"
 * @property {string|null} nextStatementDateOverride - ISO date; manual correction once the real statement lands
 * @property {number} statementBalance      - pence, balance as of the last confirmed statement (unused — statements are derived, see statements.js)
 * @property {number|null} [paymentDaysAfter] - v0.7: payment due this many days after the statement (next working day); null = 25
 */

/**
 * v0.12 (see src/lib/envelopes.js). Envelopes are referred to by id, so a
 * rename never orphans entries. Not allowed on credit cards.
 * @typedef {Object} EnvelopeConfig
 * @property {boolean} enabled
 * @property {Envelope[]} list              - display order; spare interest pennies go to the first ones
 */

/**
 * @typedef {Object} Envelope
 * @property {string} id
 * @property {string} name                  - e.g. "Maintenance", "Health", "Transport", "Home Insurance"
 * @property {number} openingBalance        - pence, its share of the account's opening balance (rest = Unallocated)
 * @property {boolean} hidden               - retired: kept for its history, not offered for new entries
 */

/**
 * A single ledger entry. Transfers are represented as two linked Transactions
 * (see Transfer below) rather than a special-cased type, which keeps balance
 * calculation logic in one place.
 *
 * Direction is always from the ACCOUNT's point of view, exactly like the
 * spreadsheet's Credit/Debit columns: a spend on Barclaycard is a 'debit'
 * on the Barclaycard account (amount owed goes up); the direct debit that
 * pays it is a 'credit' on Barclaycard and a 'debit' on the current account.
 *
 * @typedef {Object} Transaction
 * @property {string} id
 * @property {string} accountId
 * @property {string} date                - ISO date (no time component; same-day ordering is a display concern, not stored)
 * @property {number} amount               - pence, always >= 0; direction carries the sign (0 for notes)
 * @property {'credit'|'debit'} direction
 * @property {string} description
 * @property {string|null} category
 * @property {'transaction'|'passthrough'|'note'} kind - 'note' = annotation row with no money ("BARCLAYCARD STATEMENT", "In Greece")
 * @property {string|null} transferId      - set on both legs of a transfer, links them
 * @property {EnvelopeSplit[]|null} envelopeSplits - v0.12, envelope accounts only: positive amounts adding up to `amount`;
 *                                            null = whole amount Unallocated. On a note (amount 0) two SIGNED splits adding up
 *                                            to 0 = a move between envelopes (envelopeId null = Unallocated)
 * @property {string|null} scheduledItemId - set when this is a confirmed entry of a recurring item
 * @property {string} [scheduledPeriod]    - YYYY-MM of the recurring item's month it confirms (only with scheduledItemId)
 * @property {boolean} isProjected         - always false when stored; true only on derived projected rows (never saved)
 * @property {string|null} [statementMonth] - v0.7, card entries only: YYYY-MM of the statement it's really on, when that
 *                                            differs from its date (see statements.js). null/absent = by date
 * @property {boolean} [reconciled]         - v0.8: ticked off against the bank / card statement (reconcile.js). absent = false
 */

/**
 * @typedef {Object} EnvelopeSplit
 * @property {string|null} envelopeId     - v0.12 (was envelopeName, never used); null only in a move = Unallocated
 * @property {number} amount               - pence
 */

/**
 * A transfer is just a convenience wrapper: it creates one debit Transaction
 * on the source account and one credit Transaction on the destination
 * account, both tagged with the same transferId.
 *
 * @typedef {Object} Transfer
 * @property {string} id
 * @property {string} fromAccountId
 * @property {string} toAccountId
 * @property {number} amount               - pence
 * @property {string} date
 * @property {string} note
 */

/**
 * Recurring items and their per-month exceptions live in
 * Ledger.scheduledItems, told apart by `recordType`:
 *   'recurring'  — the rule (see RecurringItem in src/lib/schedule.js)
 *   'occurrence' — a skip or one-off change to one month (OccurrenceException)
 * Projected entries are NOT stored; they're derived from these on display.
 * Records without a recordType (none exist) are ignored.
 *
 * @typedef {import('../lib/schedule.js').RecurringItem | import('../lib/schedule.js').OccurrenceException} ScheduledItem
 */

/**
 * A named collection of accounts + transactions + transfers + scheduled
 * items — the unit that gets saved as one blob (IndexedDB now, one Drive
 * JSON file later). Personal data is one Ledger; each shared/joint account
 * group will be its own separate Ledger file.
 *
 * Array order of `accounts` is the display order (tabs / grid columns).
 * Array order of `transactions` is insertion order, used as the stable
 * tie-breaker for same-day entries.
 *
 * @typedef {Object} Ledger
 * @property {string} id
 * @property {string} name                 - e.g. "Personal", "Joint account"
 * @property {Account[]} accounts
 * @property {Transaction[]} transactions
 * @property {Transfer[]} transfers
 * @property {ScheduledItem[]} scheduledItems
 * @property {string} schemaVersion        - bump whenever the shape changes, so migrations are possible
 * @property {string} lastModified         - ISO datetime, used for the "someone else edited this" conflict check on shared ledgers
 */

export {};
