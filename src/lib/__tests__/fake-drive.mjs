// In-memory stand-in for Google Drive, matching the adapter interface the
// sync engine expects. Versions increase on every write, like Drive's.
export function createFakeDrive() {
  let nextId = 1;
  const items = new Map(); // id -> { id, name, parent, folder, text, version, trashed }
  const hooks = { beforeUpdate: null, failNext: null };
  const authFail = { on: false };

  function check() {
    if (authFail.on) { const e = new Error('401'); e.auth = true; throw e; }
    if (hooks.failNext) { const err = hooks.failNext; hooks.failNext = null; throw err; }
  }

  return {
    items,
    hooks,
    authFail,
    calls: [],
    async folderExists(token, id) { check(); const f = items.get(id); return Boolean(f && f.folder && !f.trashed); },
    async findOrCreateFolder(token, name, parentId = 'root') {
      check();
      for (const f of items.values()) if (f.folder && f.name === name && (f.parent ?? 'root') === parentId && !f.trashed) return f.id;
      const id = `folder${nextId++}`;
      items.set(id, { id, name, parent: parentId, folder: true, trashed: false });
      return id;
    },
    async getMeta(token, id) {
      check();
      const f = items.get(id);
      return f && !f.folder && !f.trashed ? { id, version: String(f.version) } : null;
    },
    async findFile(token, folderId, name) {
      check();
      for (const f of items.values()) if (!f.folder && f.parent === folderId && f.name === name && !f.trashed) return { id: f.id, version: String(f.version) };
      return null;
    },
    async download(token, id) { check(); return items.get(id).text; },
    /** v0.11: by name anywhere (the ticket tracker's file), oldest first. */
    async findFilesByName(token, name) {
      check();
      return [...items.values()].filter((f) => !f.folder && !f.trashed && f.name === name).map((f) => ({ id: f.id, version: String(f.version) }));
    },
    /** Test helper: a file another app (the ticket tracker) put in Drive. */
    putForeignFile(name, text) {
      const id = `file${nextId++}`;
      items.set(id, { id, name, parent: 'tracker-folder', folder: false, text, version: 1, trashed: false });
      return id;
    },
    async createFile(token, folderId, name, text) {
      check();
      const id = `file${nextId++}`;
      items.set(id, { id, name, parent: folderId, folder: false, text, version: 1, trashed: false });
      this.calls.push('create');
      return { id, version: '1' };
    },
    async updateFile(token, id, text) {
      check();
      if (hooks.beforeUpdate) { const fn = hooks.beforeUpdate; hooks.beforeUpdate = null; await fn(); }
      const f = items.get(id);
      f.text = text;
      f.version += 1;
      this.calls.push('update');
      return { id, version: String(f.version) };
    },
    async listFiles(token, folderId) {
      check();
      return [...items.values()].filter((f) => !f.folder && !f.trashed && f.parent === folderId)
        .map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime ?? '' }));
    },
    async copyFile(token, id, folderId, name) {
      check();
      if (hooks.failCopy) throw new Error('copy refused');
      const src = items.get(id);
      const nid = `file${nextId++}`;
      items.set(nid, { id: nid, name, parent: folderId, folder: false, text: src.text, version: 1, trashed: false, createdTime: `t${String(nextId).padStart(6, '0')}` });
      this.calls.push('copy');
      return { id: nid };
    },
    async deleteFile(token, id) { check(); items.delete(id); this.calls.push('delete'); },
    async whoAmI() { check(); return 'wayne@example.com'; },
    // test helpers
    fileText() { for (const f of items.values()) if (!f.folder && !f.trashed && f.name === 'personal.json') return f.text; return null; },
    backups() { const bf = [...items.values()].find((f) => f.folder && f.name === 'backups'); return bf ? [...items.values()].filter((f) => !f.folder && f.parent === bf.id).map((f) => f.name).sort() : []; },
    backupText(name) { return [...items.values()].find((f) => !f.folder && f.name === name)?.text ?? null; },
    trashAll() { for (const f of items.values()) f.trashed = true; },
  };
}

export function createFakeAuth({ valid = true } = {}) {
  let token = valid ? 'tok' : null;
  return {
    interactiveCalls: 0,
    hint: null,
    async getToken({ interactive }) {
      if (token) return token;
      if (!interactive) return null;
      this.interactiveCalls++;
      token = 'tok';
      return token;
    },
    hasValidToken: () => Boolean(token),
    clearToken() { token = null; },
    expire() { token = null; },
    setLoginHint(email) { this.hint = email; },
  };
}

export function createFakeStore(initialLedger) {
  let local = initialLedger;
  let syncState = null;
  return {
    getLocal: () => local,
    setLocal(l) { local = l; },
    async loadSyncState() { return syncState ? structuredClone(syncState) : null; },
    async saveSyncState(s) { syncState = structuredClone(s); },
    // test helper: simulate the person editing via the app
    edit(fn) { local = fn(local); },
  };
}
