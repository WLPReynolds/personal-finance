# Finance Tracker

Personal finance PWA — replaces the Budget/Monzo Pots/Holiday Spends spreadsheets.
Same pattern as the ticket tracker: static PWA on GitHub Pages, deployed
manually via the GitHub web UI, zero npm dependencies.

## Status: v0.7.0 — Credit card statements and statement payments

Everything from v0.4, plus **recurring items** (salary, direct debits,
subscriptions, card payments) that appear ahead of time as projected entries,
and (v0.7) **card statements**.

**New in v0.7.0 — card statements**
- **Card settings** (card → *Account…*): *Statement on working day no.* and
  *Payment due, days after*. Barclaycard is **13** and **25**: the statement is
  produced on the 13th working day (weekends and bank holidays skipped) and the
  payment is due 25 days later, moved to the next working day. This matches
  the real statements (17 Jun → 13 Jul, 17 Jul → 11 Aug, 19 Aug → 14 Sep,
  17 Sep → 12 Oct). Leave the first box blank for no statements (Nationwide for
  now).
- **Statement rows** appear in the card's column on each statement date,
  showing what's owed on that statement and when the payment is due.
  Future ones say "estimate". Tap one (phone) or click it (grid) to open the
  statement.
- **What's owed is worked out from your entries**, never typed in. It is the
  amount owed at the opening date, plus every entry on that statement or an
  earlier one, less payments and refunds. If the real statement differs, an
  entry is missing or on the wrong statement.
- **Which statement an entry is on:** by default, the first statement on or
  after its date, so a spend made on the statement day is on that statement.
  When the bank puts it on the next one, there are two ways to move it:
  - In the **statement** view, each entry within 3 days of the statement date
    has a *This / Next* switch.
  - In the **entry form**, the same choice appears whenever the date is within
    3 days of a statement date. On the statement day itself it is flagged as
    such.

  Moved entries are tagged "⤵ on the 18 Nov statement". On the statement day,
  the row order is: entries on the statement, then the statement row, then
  entries carried to the next one.
- **Paying the statement:** in a recurring *Transfer* to a card that has
  statements, tick *Pay the statement balance on its due date*. The date then
  comes from the statement and the amount is the statement balance. Repeat
  rules, day and weekend rule don't apply. The payment in month M pays the
  statement from month M−1. Each later statement counts the payments projected
  before it.
- **Paying less one month:** open that month's payment, change the amount,
  then tap *Save for this month only*. Whatever isn't paid stays on the card
  and shows up on the next statement and the next payment. *Confirm* records
  the amount actually taken.
- **The payment before your records start** (12 Oct pays the 17 Sep
  statement) can't be worked out, so it uses the item's *Estimate*. Put the
  real figure in as a one-off for that month.
- **Card header (phone banner / grid header):** the next payment, and the
  next statement's balance so far. Tap it to open that statement.
- Turning *Pay the statement balance* on for an existing card-payment item
  keeps its confirmed months, because months are keyed by the month the
  payment is made.

**New in v0.6.0**
- **Phone list runs oldest → newest**, like the grid: Brought forward at the
  top, future entries at the bottom, *Show 3 more months* at the very end. It
  opens (and opens each account tab) at today's first entry — or, if nothing
  is dated today, the latest day before it. Saves and syncs leave the scroll
  where it is.
- **Different last payment:** an item with an end date can have a *Last
  payment* amount. It applies to the final payment actually due (if that
  month is skipped, it moves to the one before). A one-off change to that
  month still wins.
- **"(x of y)" numbering** on every item with an end date (any frequency), on
  projected and confirmed entries, phone and grid. *First payment no.* sets
  where counting starts — e.g. 2 when payment 1 was made before the series
  was set up, so 12 more payments show as 2 of 13 … 13 of 13. A skipped month
  takes no number and the rest close up, so the total drops (skip one of 12 →
  the last is "11 of 11"); move the end date out if the lender extends the
  term. Numbers are worked out live, never stored — fix the numbering later
  and confirmed entries follow; delete the series and they lose the number.

### Recurring items

- **Set up:** ⚙ → *Manage recurring items* → *+ Add*. Description; money out /
  money in / transfer (a card payment is a transfer from the current account
  to the card); account(s); amount; monthly / every N months / yearly; day of
  the month (29–31 use the last day of shorter months); from date; optional
  to date (inclusive — last entry on or before it; blank = no end); and what
  happens on a weekend or bank holiday: leave it / working day before
  (salary) / next working day (direct debits). The editor previews the next
  three dates. Every-N-months and yearly items repeat counting from the from
  date's month.
- **Projected entries** show in the phone list and the grid, faded with ↻.
  One whose date has arrived without being confirmed turns **amber**.
- **Tap one** to: *Confirm* (adjust amount/date first — it becomes a real
  entry), *Skip this month* (stays visible, struck through, counts for
  nothing; tap again to un-skip), *Save for this month only* (e.g. December
  salary paid early), or *Edit series…* (changes every month not yet
  confirmed). Deleting a confirmed entry puts the projection back.
- **Balances:** the bold figure (today) counts confirmed entries only; the
  "at end of month" figure includes projected ones, overdue included.
- **How far ahead:** 3 months each time the app opens; *Show 3 more months*
  goes up to 12, per device, not saved.
- **Bank holidays:** England & Wales list from gov.uk, refreshed weekly and
  kept on the device; a built-in list (2025–2027) covers first run/offline.
- **Stored:** only the rules, skips/one-offs (in `scheduledItems`) and
  confirmed entries. Projections are derived on display, so devices can't
  duplicate them. A confirmed entry's id is built from item + month, so two
  devices confirming the same month merge into one (or one clash if they
  differ).

### Drive sync (v0.4)

### Drive sync

- **Turn on:** ⚙ → *Connect Google Drive* (once per device). The first device
  creates `My Drive/Finance/personal.json`; other devices join it. A device
  that already has data is **combined** with Drive's copy, not overwritten.
- **Working copy stays local.** Every edit saves on the device instantly and
  works offline; Drive is where devices meet.
- **When it syncs:** on opening the app, on returning to it, ~4 s after each
  edit, and on leaving it — *while Google's sign-in is valid* (~1 hour).
- **After the hour:** the cloud chip at the top says **Tap to sync**. One tap
  opens Google's window briefly (it closes itself) and syncs. The app never
  opens Google's window without a tap — on an installed Android app a no-tap
  attempt just flashes and fails (`popup_closed`), as seen in the ticket tracker.
- **Clashes:** if the same entry was changed differently on two devices
  between syncs, a dialog asks which to keep (both legs of a linked transfer
  are decided together). Everything else is combined automatically.
- **Lost-save protection:** Drive's API has no "save only if unchanged", so
  two devices saving in the same second could overwrite each other. Each save
  is stamped with a write id + history; a device whose save was overwritten
  notices on its next sync and merges its changes back in. Covered by a
  randomised two-device stress test.
- **Privacy:** scope is `drive.file` — the app can only see files it created,
  nothing else in your Drive. No server is involved; tokens stay on the device.
  Google's sign-in script is only loaded when sync is on (or settings is open).
- **Stop syncing here:** ⚙ → *Stop syncing here* — keeps local data, leaves the
  Drive file alone. *Erase all data* switches sync off first, so it can never
  wipe the Drive copy.
- **Recovery:** the Drive file is a normal export (importable by hand), and
  Drive keeps its own version history of it (File → Manage versions).
- **OAuth client:** reuses the ticket tracker's client ID (same
  `*.github.io` origin). Disconnecting never revokes it, as that would also
  revoke the ticket tracker's access.

### Still from earlier versions

- **Phone (list view):** account tabs, balance today + end of month, entries
  by day with running balance, **+** to add.
- **Desktop (grid view):** spreadsheet layout, balance today + end of the
  month in view; click a cell to add, a value to edit.
- **Entries:** Debit / Credit / Note; autocomplete; linked transfers.
- **Export/import** remains as a manual backup.

## Deploying (GitHub web UI)

Upload the whole folder contents to the repo root (keep the `src/` and
`icons/` folders), then enable Pages. When you change files, bump `VERSION`
in `sw.js` and `APP_VERSION` in `src/app.js` — the service worker is
network-first, so an online reload always gets new files; the version bump
just clears the old offline cache.

## Code layout

- `index.html`, `styles.css`, `manifest.webmanifest`, `sw.js`, `icons/`
- `src/app.js` — all UI (list view, grid view, dialogs, settings, export/import)
- `src/store.js` — IndexedDB load/save (ledger, meta, sync state)
- `src/google-auth.js` — Google sign-in (GIS token client; tap-only)
- `src/drive.js` — Drive REST adapter (find/create folder+file, download, save)
- `src/lib/sync-engine.js` — sync orchestration (push / pull / merge / clashes / lost-save recovery)
- `src/lib/sync-core.js` — pure merge prep, clash grouping, repair
- `src/models/schema.js` — data model (schema v2: integer pence, derived balances)
- `src/lib/ops.js` — pure ledger operations (accounts, transactions, transfers, balances)
- `src/lib/schedule.js` — recurring items: dates, projections, confirm/skip/one-off, series edits
- `src/lib/statements.js` — card statements: dates, due dates, which statement an entry is on, amount owed, statement rows (v0.7)
- `src/lib/workdays.js` — weekends, bank holidays (gov.uk + built-in), working-day shifts, nth working day
- `src/lib/grid.js` — builds the desktop grid rows
- `src/lib/money.js` — pence ⇄ "£1,234.56"
- `src/lib/transfer-file.js` — export/import file format + validation
- `src/lib/institutions.js` — bank colours + accent stripes
- `src/lib/balances.js`, `ledger.js`, `merge.js`, `id.js` — core modules from v0.1

## Key design decisions

- **Integer pence everywhere** (v0.2) — removes the float drift seen in the
  spreadsheets (`1366.0100000000002`). Conversion happens only in `money.js`.
- **Balances are derived, never stored** — an account has an opening balance
  and date; everything else is calculated, so a stored balance can't drift
  from its transactions.
- **Transfers are two linked Transactions** — one balance code path.
- **Same-day credits before debits** for running balances.
- **Direction is from the account's point of view**, matching the
  spreadsheet columns: a card spend is a Debit on the card.

## Not built yet

1. Excel import (SheetJS) — historical data; October 2026 onwards is being kept as entered
2. Envelopes UI (Monzo: Transport/Health/Maintenance)
3. Reconcile mode (tick-off against a statement); a statement date that doesn't follow the card's rule one month (no override yet); Nationwide's statement rule
4. Trip Mode, fuzzy search + archive, Export-to-Sheets
5. Joint/shared ledger with Alison (sync engine is ready; `drive.file` means she opens the shared file once via Google's file picker)
7. Draggable grid columns, iOS install hint

## Running tests

```
npm test
```

132 tests (incl. two-device sync + stress test, recurring items, card statements), plain Node `assert`, no install needed.
Browser tests: `python3 dev/e2e/recurring.py`, `recurring_v06.py`, `statements_v07.py` (and the others in `dev/e2e/`).
