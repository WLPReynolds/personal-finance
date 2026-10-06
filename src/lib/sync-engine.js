/**
 * Drive sync engine. Orchestrates: get a token → find the Drive file → decide
 * push / pull / merge → write back. All I/O is injected so the whole flow is
 * testable in Node with an in-memory fake Drive:
 *
 *   auth:  { getToken({interactive}) -> Promise<string|null>, hasValidToken(), clearToken(), setLoginHint(email) }
 *   drive: { folderExists, findOrCreateFolder, getMeta, findFile, download, createFile, updateFile, whoAmI,
 *            listFiles, copyFile, deleteFile }   (the last three: v0.9 backups)
 *          (any method may throw an error with .auth === true for an expired/invalid token)
 *   store: { getLocal() -> ledger (synchronous, the app's live copy),
 *            setLocal(ledger) (synchronous: replaces the live copy, persists in the background),
 *            loadSyncState() -> Promise<object|null>, saveSyncState(state) -> Promise }
 *
 * Model: each device keeps its own local copy as the working copy. "base" is
 * the ledger as it stood at this device's last successful sync, with Drive's
 * file version at that moment. Comparing local vs base tells us what this
 * device changed; comparing Drive's version vs baseVersion tells us whether
 * another device changed the file. Both changed → three-way merge.
 *
 * IMPORTANT for Android: getToken({interactive:true}) must be the very first
 * thing that happens inside a tap handler (no await before it), or the
 * browser treats Google's window as an unrequested popup and closes it.
 * That's why sync()/connect() start the token request synchronously.
 */
import { fingerprint, isEmptyLedger, prepareMerge, applyResolutions, EMPTY_BASE } from './sync-core.js';
import { buildExport, parseImport } from './transfer-file.js';
import { randomUUID } from './id.js';
import { BACKUP_FOLDER_NAME, localDay, dailyBackupName, restoreBackupName, backupsToDelete, describeBackups, monthlyKeeperIds } from './backups.js';

export const DRIVE_FOLDER_NAME = 'Finance';
export const DRIVE_FILE_NAME = 'personal.json';
const MAX_ATTEMPTS = 3;
const HISTORY_LENGTH = 100;

/*
 * Lost-write protection. Drive has no atomic "save only if unchanged", so two
 * devices saving within the same second can overwrite each other. Every save
 * therefore stamps the file with a writeId plus the ids of the saves it
 * builds on (history). After saving, a device remembers its writeId and the
 * ledger its save was based on (pushedFrom). On its next pull, if its writeId
 * is missing from the file's history, its save was overwritten — so it merges
 * against pushedFrom instead of fast-forwarding, and its changes come back.
 */

export function createSyncEngine({ auth, drive, store, folderName = DRIVE_FOLDER_NAME, fileName = DRIVE_FILE_NAME, now = () => new Date() }) {
  /** Persisted: { enabled, folderId, fileId, baseLedger, baseVersion, lastSyncAt, email } */
  let ss = { enabled: false };
  /** Transient UI state */
  let status = 'off'; // off | idle | syncing | needs-tap | error | conflicts
  let lastError = null;
  let pending = null; // { merged, groups, remote, remoteVersion, fileId, folderId, localFp }
  let inFlight = null;
  const listeners = new Set();

  const emit = () => { for (const fn of listeners) { try { fn(snapshot()); } catch { /* listener errors are not ours */ } } };
  const setStatus = (s, err = null) => { status = s; lastError = err; emit(); };
  const persist = async (patch) => { ss = { ...ss, ...patch }; await store.saveSyncState(ss); };

  function snapshot() {
    return {
      enabled: Boolean(ss.enabled),
      status,
      lastError,
      lastSyncAt: ss.lastSyncAt ?? null,
      email: ss.email ?? null,
      hasToken: auth.hasValidToken(),
      dirty: isDirty(),
      conflicts: pending ? pending.groups : null,
      location: `${folderName}/${fileName}`,
      lastBackupAt: ss.lastBackupAt ?? null,
      backupError: ss.backupError ?? null,
    };
  }

  function isDirty() {
    if (!ss.enabled) return false;
    return fingerprint(store.getLocal()) !== fingerprint(ss.baseLedger ?? null);
  }

  /** The Drive file is a normal export (importable by hand) plus sync bookkeeping. */
  const serialise = (ledger, writeId, history) =>
    JSON.stringify({ ...buildExport(ledger, 'Drive sync'), sync: { writeId, history } });
  function deserialise(text) {
    const ledger = parseImport(text).ledger;
    let history = [];
    try { history = JSON.parse(text).sync?.history ?? []; } catch { /* parseImport already validated */ }
    return { ledger, history: Array.isArray(history) ? history : [] };
  }
  const nextHistory = (basis, writeId) => [...(basis ?? []), writeId].slice(-HISTORY_LENGTH);

  async function init() {
    const saved = await store.loadSyncState();
    ss = saved ?? { enabled: false };
    if (ss.email) auth.setLoginHint(ss.email);
    status = ss.enabled ? (auth.hasValidToken() ? 'idle' : 'needs-tap') : 'off';
    emit();
    return snapshot();
  }

  /**
   * Start (or join) a sync. Safe to call often: overlapping calls share one
   * run. interactive=false never shows Google's window — with no valid token
   * it just reports 'needs-tap'.
   */
  function sync({ interactive = false } = {}) {
    if (!ss.enabled) return Promise.resolve({ status: 'off' });
    if (inFlight) return inFlight;
    // Token request starts synchronously — see the Android note above.
    const tokenPromise = auth.getToken({ interactive });
    inFlight = run(tokenPromise).finally(() => { inFlight = null; });
    return inFlight;
  }

  /** Turn sync on for this device (from a tap) and do the first sync. */
  function connect() {
    if (inFlight) return inFlight;
    const tokenPromise = auth.getToken({ interactive: true });
    inFlight = (async () => {
      const token = await tokenPromise;
      if (!token) { setStatus(ss.enabled ? 'needs-tap' : 'off', "Google sign-in didn't complete"); return { status: 'needs-tap' }; }
      await persist({ enabled: true, baseLedger: null, baseVersion: null, fileId: null });
      try {
        const email = await drive.whoAmI(token);
        if (email) { await persist({ email }); auth.setLoginHint(email); }
      } catch { /* only used to skip the account picker next time */ }
      return run(Promise.resolve(token));
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  /** Stop syncing on this device. Local data and the Drive file are both left alone. */
  async function disconnect() {
    pending = null;
    ss = { enabled: false, email: ss.email };
    await store.saveSyncState(ss);
    auth.clearToken();
    setStatus('off');
  }

  async function run(tokenPromise) {
    const token = await tokenPromise;
    if (!token) {
      setStatus('needs-tap');
      return { status: 'needs-tap' };
    }
    setStatus('syncing');
    try {
      const result = await syncOnce(token);
      return result;
    } catch (err) {
      if (err && err.auth) {
        auth.clearToken();
        setStatus('needs-tap');
        return { status: 'needs-tap' };
      }
      setStatus('error', err?.message ?? String(err));
      return { status: 'error', error: err };
    }
  }

  async function syncOnce(token) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // 1. Locate the folder and file (cached ids are verified, not trusted)
      let folderId = ss.folderId && (await drive.folderExists(token, ss.folderId)) ? ss.folderId : null;
      if (!folderId) folderId = await drive.findOrCreateFolder(token, folderName);
      let meta = ss.fileId ? await drive.getMeta(token, ss.fileId) : null;
      if (!meta) meta = await drive.findFile(token, folderId, fileName);

      const local = store.getLocal();
      const localFp = fingerprint(local);

      // 2. No file on Drive yet (first device, or the file was deleted): upload ours
      if (!meta) {
        const writeId = randomUUID();
        const history = nextHistory([], writeId);
        const created = await drive.createFile(token, folderId, fileName, serialise(local, writeId, history));
        await persist({
          folderId, fileId: created.id, baseLedger: local, baseVersion: created.version, baseHistory: history,
          lastWriteId: writeId, pushedFrom: EMPTY_BASE, lastSyncAt: now().toISOString(),
        });
        pending = null;
        setStatus('idle');
        return { status: 'pushed', created: true };
      }

      const sameFile = Boolean(ss.fileId === meta.id && ss.baseLedger);
      // 3. Drive unchanged since our last sync
      if (sameFile && meta.version === ss.baseVersion) {
        if (localFp === fingerprint(ss.baseLedger)) {
          await persist({ folderId, lastSyncAt: now().toISOString() });
          pending = null;
          setStatus('idle');
          return { status: 'unchanged' };
        }
        const pushed = await push(token, {
          fileId: meta.id, expectedVersion: meta.version, ledger: local,
          basisLedger: ss.baseLedger, basisHistory: ss.baseHistory, folderId,
        });
        if (pushed) return { status: 'pushed' };
        continue; // someone wrote in between — go round again and merge
      }

      // 4. Drive changed (or this device is joining): pull and merge
      const remote = deserialise(await drive.download(token, meta.id));
      // Was our own last save overwritten by another device saving at the same moment?
      const clobbered = Boolean(sameFile && ss.lastWriteId && !remote.history.includes(ss.lastWriteId));
      const base = !sameFile ? EMPTY_BASE : clobbered ? (ss.pushedFrom ?? EMPTY_BASE) : ss.baseLedger;

      let merged;
      let groups = [];
      if (!sameFile && isEmptyLedger(local)) {
        merged = remote.ledger; // fresh device joining: just take Drive's copy
      } else if (sameFile && !clobbered && localFp === fingerprint(base)) {
        merged = remote.ledger; // only Drive changed: fast-forward
      } else {
        ({ merged, groups } = prepareMerge({ base, local, remote: remote.ledger }));
      }

      if (groups.length) {
        pending = { merged, groups, remote, remoteVersion: meta.version, fileId: meta.id, folderId, localFp, local, base };
        setStatus('conflicts');
        return { status: 'conflicts', groups };
      }

      const applied = await applyMerged(token, { merged, remote, remoteVersion: meta.version, fileId: meta.id, folderId, localFp });
      if (applied) return { status: 'merged', recoveredOverwrite: clobbered };
      // local changed under us, or Drive changed again before we could write — retry
    }
    throw new Error('Drive kept changing during sync — please try again');
  }

  /**
   * Save `ledger` to Drive if the file is still at expectedVersion. Drive
   * can't make that check atomic; the writeId/history stamp (see top of
   * file) is what catches the rare case where another save slips in.
   * basisLedger/basisHistory = the Drive content this save builds on.
   */
  async function push(token, { fileId, expectedVersion, ledger, basisLedger, basisHistory, folderId }) {
    await dailyBackup(token, fileId, folderId);
    const fresh = await drive.getMeta(token, fileId);
    if (!fresh || fresh.version !== expectedVersion) return false;
    const writeId = randomUUID();
    const history = nextHistory(basisHistory, writeId);
    const updated = await drive.updateFile(token, fileId, serialise(ledger, writeId, history));
    await persist({
      folderId, fileId, baseLedger: ledger, baseVersion: updated.version, baseHistory: history,
      lastWriteId: writeId, pushedFrom: basisLedger ?? EMPTY_BASE, lastSyncAt: now().toISOString(),
    });
    pending = null;
    setStatus('idle');
    return true;
  }

  // ---------------------------------------------------------------- v0.9 backups

  async function backupFolder(token, folderId) {
    const parent = folderId ?? (ss.folderId && (await drive.folderExists(token, ss.folderId)) ? ss.folderId : await drive.findOrCreateFolder(token, folderName));
    return drive.findOrCreateFolder(token, BACKUP_FOLDER_NAME, parent);
  }

  /**
   * Once a day, just before this device's first save to Drive, Drive copies
   * the file as it stands (so the copy is always from BEFORE that day's
   * changes), then old backups are pruned (see backups.js). Whichever device
   * saves first that day makes it; the other finds it there and skips.
   * A backup problem never stops a sync — it's shown in ⚙ and retried on the
   * next save — except an expired sign-in, which the sync handles as usual.
   */
  async function dailyBackup(token, fileId, folderId) {
    const today = localDay(now());
    if (ss.lastBackupDay === today) return;
    try {
      const bf = await backupFolder(token, folderId);
      const files = await drive.listFiles(token, bf);
      const name = dailyBackupName(today);
      if (!files.some((f) => f.name === name)) {
        const copy = await drive.copyFile(token, fileId, bf, name);
        files.push({ id: copy.id, name, createdTime: now().toISOString() });
      }
      for (const id of backupsToDelete(files, today)) await drive.deleteFile(token, id);
      await persist({ lastBackupDay: today, lastBackupAt: now().toISOString(), backupError: null });
    } catch (err) {
      if (err?.auth) throw err;
      await persist({ backupError: err?.message ?? String(err) });
    }
  }

  function signInFailed() {
    const e = new Error("Google sign-in didn't complete — tap the cloud button, then try again");
    e.auth = true;
    return e;
  }
  async function withToken(tokenPromise, fn) {
    const token = await tokenPromise;
    if (!token) { setStatus('needs-tap'); throw signInFailed(); }
    try {
      return await fn(token);
    } catch (err) {
      if (err?.auth) { auth.clearToken(); setStatus('needs-tap'); throw signInFailed(); }
      throw err;
    }
  }

  /**
   * The backups on Drive, newest first: [{ id, name, createdTime, info: { kind, day, time }, monthly }].
   * Call straight from a tap — it may need Google's window (see the Android note).
   */
  function listBackups() {
    if (!ss.enabled) return Promise.reject(new Error('Turn on Drive sync first'));
    const tokenPromise = auth.getToken({ interactive: true });
    return withToken(tokenPromise, async (token) => {
      const files = await drive.listFiles(token, await backupFolder(token, null));
      const monthly = monthlyKeeperIds(files);
      return describeBackups(files).map((f) => ({ ...f, monthly: monthly.has(f.id) }));
    });
  }

  /** One backup's contents → { ledger, exportedAt } (never changes anything). */
  function readBackup(id) {
    return withToken(auth.getToken({ interactive: false }), async (token) => parseImport(await drive.download(token, id)));
  }

  /**
   * Put a backup's ledger back. First syncs (so nothing on this device is
   * lost), then has Drive copy the current file as a "before-restore" backup,
   * then replaces this device's data and saves it to Drive. The other device
   * takes it on its next sync; anything it hasn't synced yet is merged on top.
   * → { status: 'restored' | 'blocked' | 'error' | 'needs-tap', reason? }
   */
  async function restoreBackup(ledger) {
    if (!ss.enabled) return { status: 'blocked', reason: 'Drive sync is off' };
    if (inFlight) await inFlight.catch(() => null);
    const first = await sync({ interactive: false });
    if (first.status === 'conflicts') return { status: 'blocked', reason: 'Sort out the sync clash first, then restore.' };
    if (first.status === 'needs-tap') return { status: 'needs-tap' };
    if (!['unchanged', 'pushed', 'merged'].includes(first.status)) return { status: 'error', reason: lastError ?? 'Sync failed' };
    try {
      await withToken(auth.getToken({ interactive: false }), async (token) => {
        const bf = await backupFolder(token, ss.folderId);
        await drive.copyFile(token, ss.fileId, bf, restoreBackupName(now()));
      });
    } catch (err) {
      return { status: err?.auth ? 'needs-tap' : 'error', reason: `Couldn't save a copy of the current data first, so nothing was restored (${err?.message ?? err})` };
    }
    store.setLocal(ledger);
    const after = await sync({ interactive: false });
    if (after.status === 'conflicts') return { status: 'restored', conflicts: true };
    return after.status === 'pushed' || after.status === 'merged' || after.status === 'unchanged'
      ? { status: 'restored' }
      : { status: 'restored', pending: true }; // restored here; reaches Drive on the next sync
  }

  /** Record that this device now holds Drive's version `remote` as its common ancestor. */
  const adoptRemoteAsBase = ({ remote, remoteVersion, fileId, folderId }) =>
    persist({ folderId, fileId, baseLedger: remote.ledger, baseVersion: remoteVersion, baseHistory: remote.history, lastWriteId: null, pushedFrom: null });

  /**
   * Adopt a merged result locally, then push it if it differs from Drive.
   * Returns false if the caller should go round again.
   */
  async function applyMerged(token, { merged, remote, remoteVersion, fileId, folderId, localFp }) {
    // If the person edited something while we were downloading/merging,
    // don't overwrite it — go round again with their latest copy.
    if (fingerprint(store.getLocal()) !== localFp) return false;
    store.setLocal(merged);
    await adoptRemoteAsBase({ remote, remoteVersion, fileId, folderId });
    if (fingerprint(merged) === fingerprint(remote.ledger)) {
      await persist({ lastSyncAt: now().toISOString() });
      pending = null;
      setStatus('idle');
      return true;
    }
    return push(token, {
      fileId, expectedVersion: remoteVersion, ledger: merged,
      basisLedger: remote.ledger, basisHistory: remote.history, folderId,
    });
  }

  /**
   * The person's decisions on clashes. choices: { [groupKey]: 'local'|'remote' }.
   * Then finish the sync (pushes if a token is still valid).
   */
  async function resolveConflicts(choices) {
    if (!pending) return { status: 'none' };
    const p = pending;
    pending = null;
    if (fingerprint(store.getLocal()) !== p.localFp) {
      // edited meanwhile — the clash list may be stale; recompute
      return sync({ interactive: false });
    }
    const resolved = applyResolutions(p.merged, p.groups, choices, [p.local, p.remote.ledger, p.base]);
    store.setLocal(resolved);
    await adoptRemoteAsBase({ remote: p.remote, remoteVersion: p.remoteVersion, fileId: p.fileId, folderId: p.folderId });
    setStatus(auth.hasValidToken() ? 'idle' : 'needs-tap');
    return sync({ interactive: false });
  }

  return {
    init,
    sync,
    connect,
    disconnect,
    resolveConflicts,
    listBackups,
    readBackup,
    restoreBackup,
    getState: snapshot,
    isEnabled: () => Boolean(ss.enabled),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    notifyLocalChange: emit, // lets the UI refresh the "changes waiting" state
  };
}
