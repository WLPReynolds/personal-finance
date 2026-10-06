# Personal Finance

Personal finance PWA — replaces the Budget/Monzo Pots/Holiday Spends spreadsheets.
Same pattern as the ticket tracker: static PWA on GitHub Pages, deployed
manually via the GitHub web UI, zero npm dependencies.

## Status: v0.11.0 — Amounts from the ticket tracker

Everything from v0.4, plus **recurring items** (salary, direct debits,
subscriptions, card payments) that appear ahead of time as projected entries,
and (v0.7) **card statements**.

**New in v0.11.0 — amounts from the ticket tracker**
- The ticket tracker publishes its "Set aside on payday" figure for the
  current pay period and the next 12 as one file in Drive,
  `transport-estimates.json` (contract: `claude/transport-estimates-spec.md`
  in the Project — the tracker side is built in the tracker's own Project).
- A recurring item's editor has **Take the amount from the ticket tracker**
  (Train fare/Parking). Each projected month then uses the tracker's total for
  the pay period starting that month — matched by month, so December's early
  pay or a bank-holiday difference doesn't matter. The amount typed in is
  used only for a month the tracker has no figure for.
- Projected rows say **projected · ticket tracker** or **projected · estimate
  (no tracker figure)**. Tapping one shows the breakdown (tickets + parking
  days) and whether it's locked in on payday or still a projection.
  Confirming is still your tap; a confirmed entry never changes afterwards.
  "Save for this month only", Skip and Undo work as before.
- The file is read after a sync (at most every 5 minutes; **⚙ → Ticket
  tracker → Check now** any time). It needs Drive sync on. Only a device whose
  ledger has an item using it ever looks for the file.
- The figures are kept on this device only (encrypted with the lock on) —
  never in the ledger or the Drive file — so offline still works. A missing or
  bad file keeps the last good figures and says why in ⚙. A newer format
  version than this app reads is refused rather than guessed at.

**New in v0.10.0 — passphrase lock (for computers others can use)**
- **Off unless you turn it on, and only for the device you turn it on in.**
  Phones carry on as before (the phone's own fingerprint lock is the guard
  there). It never syncs and Drive is not encrypted.
- **⚙ → Passphrase lock → Turn on…**: choose a passphrase (8+ characters; a
  few unrelated words work well) and how long without use before it locks
  itself (5 / 15 / 30 / 60 minutes, default 15).
- With it on, everything the app keeps in this browser is **encrypted** — the
  ledger, the last-synced copy, sync details, the bank-holiday list, and the
  Google sign-in token (moved out of localStorage). The browser's built-in
  Web Crypto does it: PBKDF2-SHA256 with 600,000 rounds turns the passphrase
  into a key that unlocks a random AES-256-GCM data key. Without the
  passphrase the stored data can't be read, developer tools included.
- The app opens on a **lock screen**. It locks again after the chosen time
  without use, from the padlock in the top bar (desktop widths) or **⚙ → Lock
  now**. Locking finishes any saves, syncs if signed in, then reloads the page
  so nothing is left in memory. Closing the browser locks it too.
- **Change passphrase…** and **Turn off…** ask for the current passphrase.
  Turning off saves the data unencrypted again.
- **Forgot your passphrase?** on the lock screen deletes this device's data
  (it can't be opened without the passphrase) and removes the lock. Drive and
  its backups aren't touched: reconnect Drive to load everything back. Only
  changes made here that hadn't synced are lost.
- Not covered: what's on screen while it's unlocked (hence the auto-lock),
  exports you download (plain JSON — delete them from Downloads), and anything
  watching the screen or keyboard on a managed work laptop.

**New in v0.9.0 — automatic backups**
- With Drive sync on, once a day — just before that day's first save to Drive —
  Drive copies `personal.json` into `My Drive/Finance/backups/` as
  `personal-YYYY-MM-DD.json`. So each backup is the data as it stood BEFORE that
  day's changes. Whichever device saves first that day makes it; Drive does the
  copy itself (nothing downloaded). Days with no changes get no backup.
- Kept: the **30 most recent** daily backups, plus the **first backup of each
  month for 12 months**. Older ones are deleted when the next backup is made.
- **⚙ → Automatic backups → Backups…** lists them (newest first, the monthly
  ones tagged). Pick one to compare it with now — each account's balance today
  and the number of entries, differences in bold — then **Restore this backup**.
- Restoring first syncs, then saves a copy of the current data as
  `personal-YYYY-MM-DD-before-restore-HHMM.json` (kept 30 days, listed at the
  top, so a restore can itself be undone), then replaces the data here and on
  Drive. The other device follows on its next sync; anything it hadn't synced
  yet is merged back on top. If the safety copy can't be made, nothing is restored.
- A backup problem never stops a sync: ⚙ shows it, and it's retried with the
  next change. Manual export/import is still there.

**Also new in v0.9.0**
- Header reads **Personal Finance**, with the running version underneath. The
  TEST badge is gone; ⚙'s "Test data" section is now **This device** (entry count
  and *Erase all data on this device*).
- **Recurring items:** an item with an end date moves to an **Expired** section
  at the bottom once its last payment is confirmed (or skipped). An item whose
  end date has passed but whose last payment isn't confirmed stays in the main
  list, marked "last payment not confirmed yet".

**New in v0.8.0 — reconciling**
- **Reconcile** any account: the **✓** button in a grid column header, or
  **Reconcile…** on the phone's account banner (also from a card's statement
  dialog). Tick each line you can see on the bank's statement.
- **Cards with statement dates** reconcile one **statement** at a time (the
  latest one produced is chosen first). **Other accounts** reconcile up to a
  **closing date** (today first), listing the month up to it.
- Type in the bank's figure (a card's amount owed, or the closing balance —
  minus sign if overdrawn). The screen shows the app's figure, the ticked
  total and the **difference**, which reaches **✓ Balanced** at £0.00.
  Nothing is ticked for you. The typed figure isn't saved.
- Entries left unticked from an earlier period are listed too ("earlier, not
  ticked yet"), so a line that turns up on a later statement isn't lost.
  *Hide ticked* tidies the list.
- Ticks sync like any edit. Ticked entries show **✓** in the grid and the
  phone list. Changing a ticked entry's amount, date, account or statement
  asks first and then unticks it (a new description doesn't); a transfer's
  other leg is unticked too when the change carries over to it.
- Also: grid column headers now line up (bars, names and balances level even
  when a card has an extra statement line), and the recurring items page has
  **+ Add** at the top.

**New in v0.7.1 — every N days**
- *Repeats* has a new choice, **Every so many days** (31 to 366), for things
  billed on a fixed number of days rather than a calendar date — e.g. a 90-day
  subscription. *From* is the date of the first payment; it counts on from
  there (15 Oct 2026 → 13 Jan → 13 Apr → 12 Jul 2027 …), so it drifts through
  the month as real 90-day billing does. The day-of-month box is hidden.
- The minimum is 31 because each payment is still filed under the month it
  falls in (so a month can't hold two). Weekly/fortnightly would need a
  different design — not built.
- The weekend/bank-holiday rule, an end date, "(x of y)" numbering and a
  different last payment all work as before.
- To switch an existing item (e.g. one set up as every 3 months), edit it and
  pick *Every so many days*; months already confirmed stay as they are.

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
  statement. In the grid the whole statement row is tinted with a dimmed
  shade of the card's colour and its text is in capitals, like the phone
  list. A line across the grid marks the start of each calendar month.
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
- `src/store.js` — IndexedDB load/save (ledger, meta, sync state); encrypts every record while the passphrase lock is on (v0.10)
- `src/lib/vault.js` — passphrase lock: key derivation, key wrapping, value encryption (v0.10)
- `src/lib/tracker-estimates.js` — the ticket tracker's published figures: file checks, lookup by month, reading from Drive (v0.11)
- `src/google-auth.js` — Google sign-in (GIS token client; tap-only)
- `src/drive.js` — Drive REST adapter (find/create folder+file, download, save)
- `src/lib/sync-engine.js` — sync orchestration (push / pull / merge / clashes / lost-save recovery)
- `src/lib/sync-core.js` — pure merge prep, clash grouping, repair
- `src/models/schema.js` — data model (schema v2: integer pence, derived balances)
- `src/lib/ops.js` — pure ledger operations (accounts, transactions, transfers, balances)
- `src/lib/schedule.js` — recurring items: dates, projections, confirm/skip/one-off, series edits
- `src/lib/statements.js` — card statements: dates, due dates, which statement an entry is on, amount owed, statement rows (v0.7)
- `src/lib/reconcile.js` — reconciling: ticks, the period's entries, ticked total and difference (v0.8)
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
3. A statement date that doesn't follow the card's rule one month (no override yet); Nationwide's statement rule
4. Trip Mode, fuzzy search + archive, Export-to-Sheets
5. Joint/shared ledger with Alison (sync engine is ready; `drive.file` means she opens the shared file once via Google's file picker)
7. Draggable grid columns, iOS install hint

## Running tests

```
npm test
```

191 tests (incl. two-device sync + stress test, recurring items, card statements, reconciling, backups, passphrase lock), plain Node `assert`, no install needed.
Browser tests: `python3 dev/e2e/recurring.py`, `recurring_v06.py`, `statements_v07.py`, `every_days_v071.py`, `reconcile_v08.py`, `backups_v09.py`, `lock_v010.py` (and the others in `dev/e2e/`).
