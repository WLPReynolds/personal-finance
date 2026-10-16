/**
 * v0.14.8: a small .xlsx reader for the history import — no library.
 *
 * An .xlsx file is a zip of XML files. This unzips it with the browser's own
 * DecompressionStream ('deflate-raw'; Chrome/Android 103+, Firefox 113+,
 * Safari 16.4+) and reads the CACHED VALUES Excel saves with every cell, so
 * formulas are never evaluated: a balance cell gives the number Excel last
 * showed. Only what the import needs is read: sheet names in workbook order,
 * each sheet's cell values (numbers, text, booleans), and whether the
 * workbook uses the 1904 date system. Styles, formulas and charts are ignored.
 *
 * Kept free of third-party code on purpose: the file being read is the whole
 * financial history, and nothing outside this app ever sees it.
 */

// ---------------------------------------------------------------- zip

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Zip directory → Map(name → { method, compressedSize, offset }). */
function zipEntries(bytes) {
  // End of central directory: the last 0x06054b50, within the final 64 KB + 22
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This isn’t an Excel .xlsx file (or it’s damaged)');
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const out = new Map();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (u32(bytes, p) !== 0x02014b50) throw new Error('The .xlsx file looks damaged (zip directory)');
    const method = u16(bytes, p + 10);
    const compressedSize = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const offset = u32(bytes, p + 42);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    out.set(name, { method, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser can’t open .xlsx files — update it, or try another browser');
  }
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntry(bytes, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  if (u32(bytes, e.offset) !== 0x04034b50) throw new Error('The .xlsx file looks damaged (zip entry)');
  const start = e.offset + 30 + u16(bytes, e.offset + 26) + u16(bytes, e.offset + 28);
  const data = bytes.subarray(start, start + e.compressedSize);
  let raw;
  if (e.method === 0) raw = data;
  else if (e.method === 8) raw = await inflateRaw(data);
  else throw new Error('The .xlsx file uses a compression this app can’t read');
  return new TextDecoder().decode(raw);
}

// ---------------------------------------------------------------- XML (just enough)

export function decodeXml(s) {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    })
    // Excel's own escape for control characters in text, e.g. _x000D_
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeXml(m[3] ?? m[4] ?? '');
  return out;
}

/** All the text in one <si> or <is>: plain <t>, or rich-text runs; phonetic hints (<rPh>) left out. */
function textOf(xml) {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) s += decodeXml(m[1] ?? '');
  return s;
}

function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => textOf(m[1] ?? ''));
}

/** "AB12" → column index 27 (0-based). */
export function columnIndex(ref) {
  const letters = /^([A-Z]+)/i.exec(ref)?.[1]?.toUpperCase() ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** One worksheet's XML → rows (array of arrays; empty cells null). */
export function sheetRows(xml, strings) {
  const rows = [];
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? '';
  let nextRow = 1;
  for (const rm of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const ra = attrs(rm[1]);
    const r = ra.r ? Number(ra.r) : nextRow;
    nextRow = r + 1;
    const cells = [];
    let nextCol = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ca = attrs(cm[1]);
      const col = ca.r ? columnIndex(ca.r) : nextCol;
      nextCol = col + 1;
      const body = cm[2] ?? '';
      const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = null;
      switch (ca.t) {
        case 's': value = v === undefined ? null : (strings[Number(v)] ?? null); break;
        case 'inlineStr': value = textOf(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? ''); break;
        case 'str': value = v === undefined ? null : decodeXml(v); break;
        case 'b': value = v === undefined ? null : v.trim() === '1'; break;
        case 'e': value = null; break; // #REF!, #VALUE! … — no value
        default: {
          if (v === undefined || v.trim() === '') value = null;
          else {
            const n = Number(v);
            value = Number.isFinite(n) ? n : decodeXml(v);
          }
        }
      }
      if (value === '') value = null;
      cells[col] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = null;
    rows[r - 1] = cells;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

function resolveTarget(target) {
  if (target.startsWith('/')) return target.slice(1);
  // relative to xl/
  const parts = ['xl', ...target.split('/')];
  const out = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

/**
 * ArrayBuffer of an .xlsx → { date1904, sheets: [{ name, rows }] } in the
 * workbook's own tab order. Hidden sheets are included (marked `hidden`).
 */
export async function readWorkbook(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const entries = zipEntries(bytes);
  const workbook = await readEntry(bytes, entries, 'xl/workbook.xml');
  if (!workbook) throw new Error('This isn’t an Excel .xlsx workbook');
  const rels = (await readEntry(bytes, entries, 'xl/_rels/workbook.xml.rels')) ?? '';
  const relTargets = new Map();
  for (const m of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    if (a.Id && a.Target) relTargets.set(a.Id, resolveTarget(a.Target));
  }
  const strings = sharedStrings(await readEntry(bytes, entries, 'xl/sharedStrings.xml'));
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](1|true)["']/i.test(workbook);
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const a = attrs(m[1]);
    const rid = a['r:id'] ?? Object.entries(a).find(([k]) => /(^|:)id$/.test(k) && k !== 'sheetId')?.[1];
    const path = relTargets.get(rid);
    if (!path) continue;
    const xml = await readEntry(bytes, entries, path);
    if (!xml) continue;
    sheets.push({ name: a.name ?? path, hidden: a.state === 'hidden' || a.state === 'veryHidden', rows: sheetRows(xml, strings) });
  }
  if (!sheets.length) throw new Error('No worksheets found in that file');
  return { date1904, sheets };
}
