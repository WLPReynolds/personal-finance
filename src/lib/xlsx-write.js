/**
 * v0.15.4: a small .xlsx WRITER for the Excel export — no library, the
 * mirror of lib/xlsx-read.js.
 *
 * An .xlsx file is a zip of XML files. This writes just what a plain data
 * dump needs: worksheets of numbers and text (no formulas), cell styles
 * (number formats, bold/italic, font colour, fill, borders), merged cells,
 * column widths and frozen panes. The zip is compressed with the browser's
 * own CompressionStream ('deflate-raw') where there is one, else stored.
 *
 * Kept free of third-party code on purpose, like the reader: the file being
 * written is the whole financial history.
 *
 * Input:
 *   { sheets: [{ name, cols: [width…], rows: [[cell|null…]…], merges: ['A1:C1'], freeze: { rows, cols } }] }
 *   cell = { v: number|string|null, s: style|null }
 *   style = { numFmt: 'date'|'money'|null, bold, italic, color: 'RRGGBB', fill: 'RRGGBB',
 *             left/right/top/bottom: 'thin'|'medium', align: 'center'|'right'|'left' }
 */

// ---------------------------------------------------------------- zip

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null; // e.g. a browser with CompressionStream but no 'deflate-raw': store instead
  }
}

/** [{ name, data: Uint8Array }] → zip bytes. `compress: false` stores every entry. */
export async function zip(files, { compress = true } = {}) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  // a fixed timestamp (1 Jan 2026 00:00): the file's contents, not the zip's clock, are what matter
  const dosTime = 0;
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const packed = compress ? await deflateRaw(f.data) : null;
    const method = packed && packed.length < f.data.length ? 8 : 0;
    const body = method === 8 ? packed : f.data;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, method, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const cen = new Uint8Array(46 + name.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cen.set(name, 46);
    parts.push(local, body);
    central.push(cen);
    offset += local.length + body.length;
  }
  const cenSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of all) { out.set(part, p); p += part.length; }
  return out;
}

// ---------------------------------------------------------------- XML

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // characters XML 1.0 can't hold at all
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** 0 → "A", 27 → "AB". */
export function columnName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** "YYYY-MM-DD" → Excel date serial (1900 system). */
export function dateSerial(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

const NUM_FMTS = { date: 164, money: 165 };
const NUM_FMT_XML = '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00;[Red]\\-#,##0.00"/></numFmts>';

/** Styles → xf index, with fonts / fills / borders shared between them. */
function styleBook() {
  const fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const index = new Map([['{}', 0]]);
  const find = (list, xml) => { let i = list.indexOf(xml); if (i < 0) { i = list.length; list.push(xml); } return i; };
  const side = (tag, v) => (v ? `<${tag} style="${v}"><color rgb="FF000000"/></${tag}>` : `<${tag}/>`);
  return {
    id(s) {
      if (!s) return 0;
      const key = JSON.stringify(s, Object.keys(s).sort());
      if (index.has(key)) return index.get(key);
      const font = (s.bold || s.italic || s.color)
        ? find(fonts, `<font>${s.bold ? '<b/>' : ''}${s.italic ? '<i/>' : ''}<sz val="11"/>${s.color ? `<color rgb="FF${s.color}"/>` : ''}<name val="Calibri"/><family val="2"/></font>`)
        : 0;
      const fill = s.fill ? find(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${s.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
      const border = (s.left || s.right || s.top || s.bottom)
        ? find(borders, `<border>${side('left', s.left)}${side('right', s.right)}${side('top', s.top)}${side('bottom', s.bottom)}<diagonal/></border>`)
        : 0;
      const fmt = NUM_FMTS[s.numFmt] ?? 0;
      const align = s.align ? `<alignment horizontal="${s.align}"/>` : '';
      const xf = `<xf numFmtId="${fmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0"`
        + `${fmt ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}${fill ? ' applyFill="1"' : ''}${border ? ' applyBorder="1"' : ''}`
        + (align ? ` applyAlignment="1">${align}</xf>` : '/>');
      const i = xfs.length;
      xfs.push(xf);
      index.set(key, i);
      return i;
    },
    xml() {
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + NUM_FMT_XML
        + `<fonts count="${fonts.length}">${fonts.join('')}</fonts>`
        + `<fills count="${fills.length}">${fills.join('')}</fills>`
        + `<borders count="${borders.length}">${borders.join('')}</borders>`
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        + '</styleSheet>';
    },
  };
}

function sheetXml(sheet, styles, strings) {
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'];
  const fr = sheet.freeze?.rows ?? 0;
  const fc = sheet.freeze?.cols ?? 0;
  if (fr || fc) {
    const cell = `${columnName(fc)}${fr + 1}`;
    const pane = fr && fc ? 'bottomRight' : fr ? 'bottomLeft' : 'topRight';
    out.push(`<sheetViews><sheetView workbookViewId="0"><pane${fc ? ` xSplit="${fc}"` : ''}${fr ? ` ySplit="${fr}"` : ''} topLeftCell="${cell}" activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${cell}" sqref="${cell}"/></sheetView></sheetViews>`);
  }
  out.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (sheet.cols?.length) {
    out.push('<cols>');
    sheet.cols.forEach((w, i) => { if (w) out.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`); });
    out.push('</cols>');
  }
  out.push('<sheetData>');
  sheet.rows.forEach((row, r) => {
    const cells = [];
    (row ?? []).forEach((c, i) => {
      if (!c) return;
      const ref = `${columnName(i)}${r + 1}`;
      const s = styles.id(c.s);
      const sa = s ? ` s="${s}"` : '';
      if (c.v === null || c.v === undefined || c.v === '') { if (s) cells.push(`<c r="${ref}"${sa}/>`); return; }
      if (typeof c.v === 'number') { cells.push(`<c r="${ref}"${sa}><v>${Number.isFinite(c.v) ? c.v : 0}</v></c>`); return; }
      cells.push(`<c r="${ref}"${sa} t="s"><v>${strings.id(String(c.v))}</v></c>`);
    });
    if (cells.length) out.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  out.push('</sheetData>');
  if (sheet.merges?.length) out.push(`<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`);
  out.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>');
  return out.join('');
}

function stringTable() {
  const list = [];
  const index = new Map();
  return {
    id(s) { if (!index.has(s)) { index.set(s, list.length); list.push(s); } return index.get(s); },
    xml() {
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${list.length}" uniqueCount="${list.length}">`
        + list.map((s) => `<si><t${/^\s|\s$/.test(s) ? ' xml:space="preserve"' : ''}>${escapeXml(s)}</t></si>`).join('')
        + '</sst>';
    },
  };
}

/** Excel's rules for a sheet name: ≤31 characters, none of []:*?/\ , unique. */
export function safeSheetNames(names) {
  const used = new Set();
  return names.map((n) => {
    let base = String(n ?? '').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} (${i})`;
    used.add(name.toLowerCase());
    return name;
  });
}

/** The workbook → .xlsx bytes. */
export async function writeWorkbook({ sheets }, { compress = true } = {}) {
  if (!sheets?.length) throw new Error('Nothing to export');
  const enc = new TextEncoder();
  const styles = styleBook();
  const strings = stringTable();
  const names = safeSheetNames(sheets.map((s) => s.name));
  const sheetFiles = sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(s, styles, strings)) }));
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
      + '</Types>') },
    { name: '_rels/.rels', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${ns}"><bookViews><workbookView activeTab="${sheets.length - 1}"/></bookViews><sheets>`
      + names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="${ns}/styles" Target="styles.xml"/>`
      + `<Relationship Id="rId${sheets.length + 2}" Type="${ns}/sharedStrings" Target="sharedStrings.xml"/>`
      + '</Relationships>') },
    ...sheetFiles,
  ];
  // styles and strings are complete only once every sheet is written
  files.push({ name: 'xl/styles.xml', data: enc.encode(styles.xml()) });
  files.push({ name: 'xl/sharedStrings.xml', data: enc.encode(strings.xml()) });
  return zip(files, { compress });
}
