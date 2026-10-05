/**
 * Google Drive REST adapter for the sync engine (Drive API v3, plain fetch).
 * With the drive.file scope the app only sees files and folders it created,
 * so searches below never touch anything else in your Drive.
 */
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function call(token, url, { method = 'GET', headers = {}, body } = {}) {
  let resp;
  try {
    resp = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body });
  } catch {
    throw new Error("Couldn't reach Google Drive — check your connection");
  }
  if (resp.status === 401) {
    const err = new Error('Google sign-in expired');
    err.auth = true;
    throw err;
  }
  return resp;
}

async function failed(resp, what) {
  let detail = '';
  try { detail = (await resp.json())?.error?.message ?? ''; } catch { /* no body */ }
  return new Error(`Drive ${what} failed (${resp.status}${detail ? `: ${detail}` : ''})`);
}

const q = (s) => encodeURIComponent(s);
const lit = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export const googleDrive = {
  async folderExists(token, id) {
    const resp = await call(token, `${API}/files/${id}?fields=id,trashed,mimeType`);
    if (resp.status === 404) return false;
    if (!resp.ok) throw await failed(resp, 'folder check');
    const f = await resp.json();
    return !f.trashed && f.mimeType === FOLDER_MIME;
  },

  async findOrCreateFolder(token, name) {
    const query = `mimeType=${lit(FOLDER_MIME)} and name=${lit(name)} and trashed=false and 'root' in parents`;
    const found = await call(token, `${API}/files?q=${q(query)}&fields=files(id)&spaces=drive`);
    if (!found.ok) throw await failed(found, 'folder search');
    const files = (await found.json()).files ?? [];
    if (files.length) return files[0].id;
    const created = await call(token, `${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    });
    if (!created.ok) throw await failed(created, 'folder create');
    return (await created.json()).id;
  },

  /** { id, version } or null if the file is gone / in the bin. */
  async getMeta(token, id) {
    const resp = await call(token, `${API}/files/${id}?fields=id,version,trashed`);
    if (resp.status === 404) return null;
    if (!resp.ok) throw await failed(resp, 'file check');
    const f = await resp.json();
    return f.trashed ? null : { id: f.id, version: String(f.version) };
  },

  async findFile(token, folderId, name) {
    const query = `${lit(folderId)} in parents and name=${lit(name)} and trashed=false`;
    const resp = await call(token, `${API}/files?q=${q(query)}&fields=files(id,version)&orderBy=createdTime&spaces=drive`);
    if (!resp.ok) throw await failed(resp, 'file search');
    const f = ((await resp.json()).files ?? [])[0];
    return f ? { id: f.id, version: String(f.version) } : null;
  },

  async download(token, id) {
    const resp = await call(token, `${API}/files/${id}?alt=media`);
    if (!resp.ok) throw await failed(resp, 'download');
    return resp.text();
  },

  async createFile(token, folderId, name, text) {
    const boundary = `finance-${Math.random().toString(36).slice(2)}`;
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name, parents: [folderId], mimeType: 'application/json' }) +
      `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
    const resp = await call(token, `${UPLOAD}/files?uploadType=multipart&fields=id,version`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!resp.ok) throw await failed(resp, 'upload');
    const f = await resp.json();
    return { id: f.id, version: String(f.version) };
  },

  async updateFile(token, id, text) {
    const resp = await call(token, `${UPLOAD}/files/${id}?uploadType=media&fields=id,version`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: text,
    });
    if (!resp.ok) throw await failed(resp, 'save');
    const f = await resp.json();
    return { id: f.id, version: String(f.version) };
  },

  /** Signed-in account's email (used only to skip the account picker next time). */
  async whoAmI(token) {
    const resp = await call(token, `${API}/about?fields=user(emailAddress)`);
    if (!resp.ok) return null;
    return (await resp.json())?.user?.emailAddress ?? null;
  },
};
