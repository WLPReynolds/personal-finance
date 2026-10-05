/**
 * Drive sync engine. Orchestrates: get a token → find the Drive file → decide
 * push / pull / merge → write back. All I/O is injected so the whole flow is
 * testable in Node with an in-memory fake Drive:
 *
 *   auth:  { getToken({interactive}) -> Promise<string|null>, hasValidToken(), clearToken(), setLoginHint(email) }
 *   drive: { folderExists, findOrCreateFolder, getMeta, findFile, download, createFile, updateFile, whoAmI }
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
    getState: snapshot,
    isEnabled: () => Boolean(ss.enabled),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    notifyLocalChange: emit, // lets the UI refresh the "changes waiting" state
  };
}
