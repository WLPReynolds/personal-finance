/**
 * v0.15.8: expense claims — the screens (design: claude/expense-claims-design.md).
 * Logic: lib/expenses.js (fields, list, share text, clean-up) and
 * lib/photos.js (receipt photos, this device only).
 *
 *  - entryFields(): the "Business expense" part of the entry dialog
 *  - open(): the claim list (To claim / Submitted / Paid), with
 *    "Add from recent entries" and Share
 *  - settingsSection(): ⚙ Expense claims, with "Delete photos of paid claims"
 *  - headerButton(): "Claims…" on a ticked account's header
 *
 * Nothing here appears unless an account is ticked "Can have expense claims".
 */
import { windowFrame } from './archive-ui.js';
import {
  claimsOn, isExpense, canBeExpense, setExpense, setClaimStatus, nextStatus, previousStatus, claimSections,
  recentCandidates, shareSummary, receiptFileName, cleanupMessage, sizeText, unpaidSummary, STATUS_LABELS, RECENT_DAYS,
} from './lib/expenses.js';
import { fitWithin, JPEG_QUALITY, isPdf, pdfProblem, PDF_TYPE } from './lib/photos.js';

// v0.15.9: line icons in the ticket tracker's style — 24×24, the text colour, 2px rounded strokes.
// The receipt is the tracker's own (its Delay Repay icon).
const ICON_PATHS = {
  receipt: '<path d="M6 2h12a1 1 0 0 1 1 1v18l-2.5-1.5L14 21l-2.5-1.5L9 21l-2.5-1.5L4 21V3a1 1 0 0 1 1-1z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="12" y2="15"/>',
  paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
};
/** An inline line icon (decorative: the element it sits in carries the words). */
export function lineIcon(h, name, size = 16, cls = '') {
  const el = h('span', { class: `line-icon ${cls}`, 'aria-hidden': 'true' });
  el.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
  return el;
}

/**
 * ctx: { h, $, toast, openDialog, isOpen, photos (lib/photos.js library),
 *        ledger(), accountById(id), commit(next, message) → Promise, openTxDialog(opts),
 *        formatPence(p), parseAmount(text), penceToInput(p), shortDate(iso), longDate(iso), today(),
 *        swatch(account), downloadBlob(blob, name) }
 */
export function createExpensesUI(ctx) {
  const { h, $, toast, openDialog } = ctx;
  const view = { accountId: null, mode: 'list', select: false, picked: new Set(), paidOpen: false, counts: new Map() };

  const tickedAccounts = () => ctx.ledger().accounts.filter(claimsOn);
  const anyTicked = () => tickedAccounts().length > 0;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // ---------------------------------------------------------------- photos
  /** Shrink a picked picture to about 1600 px on the long side, as a JPEG. */
  async function shrink(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('Couldn’t read that picture'));
        i.src = url;
      });
      const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, width, height);
      g.drawImage(img, 0, 0, width, height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
      if (!blob) throw new Error('Couldn’t shrink that picture');
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function refreshCounts() {
    try { view.counts = await ctx.photos.counts(); } catch { view.counts = new Map(); }
  }

  // ---------------------------------------------------------------- the entry dialog part
  /**
   * The "Business expense" fields for the entry dialog. Shown only on a
   * ticked account and only for money going out.
   * @param {{ account, existing, getAmount: () => number|null, start?: boolean }} o
   */
  function entryFields({ account, existing, getAmount, start = false }) {
    const on = claimsOn(account);
    const had = isExpense(existing) ? existing.expense : null;
    const box = h('input', { type: 'checkbox', checked: Boolean(had) || start });
    const details = h('textarea', { rows: '3', maxlength: '2000', placeholder: 'What it was for — the description your employer’s system needs', class: 'exp-details' }, had?.details ?? '');
    const amount = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'amount-input', value: had && had.amount !== existing.amount ? ctx.penceToInput(had.amount) : '' });
    const amountHint = h('span', { class: 'muted small' });
    const thumbs = h('div', { class: 'exp-thumbs' });
    // v0.15.9: photos or PDFs. On iPhone this offers Take Photo, Photo Library and Choose File (the Files app).
    const picker = h('input', { type: 'file', accept: 'image/*,application/pdf,.pdf', multiple: true, hidden: true });
    const pending = []; // { blob, url, pdf, name }
    const removed = new Set(); // saved receipt ids to delete on save
    let saved = []; // metas of this entry's saved receipts
    // v0.15.9: this dialog's own preview links, released only when it closes
    // (v0.15.8 released them on every redraw, which broke the photo previews)
    const mine = new Set();
    const urlFor = (blob) => { const u = URL.createObjectURL(blob); mine.add(u); return u; };
    $('txDialog')?.addEventListener('close', () => { for (const u of mine) URL.revokeObjectURL(u); mine.clear(); }, { once: true });
    const savedUrl = new Map(); // receipt id → its preview link, so a redraw reuses it

    const syncAmountHint = () => {
      const p = getAmount();
      amount.placeholder = p ? ctx.penceToInput(p) : '0.00';
      amountHint.textContent = 'Leave blank to claim the whole amount. Lower it for a part-business payment.';
    };

    function drawThumbs() {
      // a tile opens the receipt (a new tab / the phone's viewer); its ✕ takes it off
      const tile = ({ url, pdf, name, label, onRemove }) => {
        const link = h('a', { class: `exp-thumb-open ${pdf ? 'exp-thumb-pdf' : ''}`, href: url || '#', target: '_blank', rel: 'noopener', title: name || label, 'aria-label': `Open ${name || label}` },
          pdf ? [lineIcon(h, 'file', 26), h('span', { class: 'exp-thumb-name' }, name || 'PDF')] : h('img', { src: url || '', alt: '' }));
        return h('span', { class: 'exp-thumb' }, link,
          h('button', { type: 'button', class: 'exp-thumb-x', 'aria-label': `Remove ${name || label}`, onclick: onRemove }, '✕'));
      };
      const items = [];
      saved.filter((m) => !removed.has(m.id)).forEach((m, i) => {
        const t = tile({ url: savedUrl.get(m.id) ?? '', pdf: isPdf(m), name: m.name, label: `receipt ${i + 1}`, onRemove: () => { removed.add(m.id); drawThumbs(); } });
        if (!savedUrl.has(m.id)) {
          ctx.photos.get(m.id).then((b) => {
            if (!b) return;
            const u = urlFor(b);
            savedUrl.set(m.id, u);
            t.querySelector('a').href = u;
            t.querySelector('img')?.setAttribute('src', u);
          }).catch(() => {});
        }
        items.push(t);
      });
      pending.forEach((p, i) => items.push(tile({ url: p.url, pdf: p.pdf, name: p.name, label: `new receipt ${i + 1}`, onRemove: () => { pending.splice(i, 1); drawThumbs(); } })));
      thumbs.replaceChildren(...items,
        h('button', { type: 'button', class: 'btn-secondary btn-small exp-add-photo', onclick: () => picker.click() }, items.length ? '+ Receipt' : '+ Add receipt'));
    }
    picker.addEventListener('change', async () => {
      const files = [...picker.files];
      picker.value = '';
      for (const f of files) {
        try {
          if (isPdf(f)) {
            const problem = pdfProblem(f);
            if (problem) throw new Error(problem);
            const blob = f.type === PDF_TYPE ? f : new Blob([f], { type: PDF_TYPE });
            pending.push({ blob, url: urlFor(blob), pdf: true, name: f.name || 'receipt.pdf' });
          } else if (/^image\//.test(f.type) || !f.type) {
            const blob = await shrink(f);
            pending.push({ blob, url: urlFor(blob), pdf: false, name: null });
          } else {
            throw new Error(`${f.name || 'That file'} isn’t a photo or a PDF`);
          }
        } catch (err) { toast(err.message, 'error'); }
      }
      drawThumbs();
    });

    const shareBtn = had ? h('button', {
      type: 'button', class: 'btn-ghost btn-small', onclick: () => share([existing]),
    }, 'Share…') : null;
    const statusLine = had ? h('div', { class: 'muted small' },
      `${STATUS_LABELS[had.status] ?? 'To claim'}${had.status === 'submitted' && had.submittedAt ? ` on ${ctx.longDate(had.submittedAt.slice(0, 10))}` : ''}${had.status === 'paid' && had.paidAt ? ` on ${ctx.longDate(had.paidAt.slice(0, 10))}` : ''} — change it in the claim list.`) : null;

    const inner = h('div', { class: 'exp-inner' },
      h('label', { class: 'field' }, h('span', {}, 'Details'), details),
      h('label', { class: 'field' }, h('span', {}, 'Claim amount (£)'), amount, amountHint),
      h('div', { class: 'field' }, h('span', {}, 'Receipts — photos or PDFs, optional, kept on this device only'), thumbs, picker),
      statusLine || shareBtn ? h('div', { class: 'exp-foot' }, statusLine, shareBtn) : null);
    const el = h('fieldset', { class: 'exp-fields', hidden: true },
      h('label', { class: 'check' }, box, h('span', {}, 'Business expense')),
      inner);
    const syncBox = () => { inner.hidden = !box.checked; };
    box.addEventListener('change', syncBox);
    syncBox();
    syncAmountHint();

    if (existing) ctx.photos.forEntry(existing.id).then((m) => { saved = m; drawThumbs(); }).catch(() => drawThumbs());
    else drawThumbs();

    let kindNow = 'debit';
    return {
      el,
      /** the entry dialog's kind changed (debit / credit / note) or the amount did */
      sync(kind) {
        kindNow = kind ?? kindNow;
        el.hidden = !on || kindNow !== 'debit';
        syncAmountHint();
      },
      /**
       * Apply the claim to `ledger` for entry `txId`. → { ledger } or { error } or { cancelled }.
       * Not shown = left exactly as it was.
       */
      apply(ledger, txId) {
        if (el.hidden) return { ledger };
        const photosLeft = saved.filter((m) => !removed.has(m.id)).length + pending.length;
        if (!box.checked) {
          if (!had) return { ledger };
          if (photosLeft && !confirm(`Stop treating this as a business expense?\n\nIts ${plural(photosLeft, 'receipt')} on this device will be deleted too.`)) return { cancelled: true };
          return { ledger: setExpense(ledger, txId, null), unmark: true };
        }
        const raw = amount.value.trim();
        let claim;
        if (raw === '') claim = ledger.transactions.find((t) => t.id === txId)?.amount;
        else {
          claim = ctx.parseAmount(raw);
          if (claim === null) return { error: 'Claim amount should look like 12.34, or be blank for the whole amount' };
        }
        try {
          return { ledger: setExpense(ledger, txId, { amount: claim, details: details.value }) };
        } catch (err) {
          return { error: err.message };
        }
      },
      /** after the entry is saved: store new photos, delete removed ones (or all, if unmarked) */
      async afterSave(txId, { unmark = false } = {}) {
        try {
          if (unmark) { await ctx.photos.removeForEntry(txId); return; }
          if (removed.size) await ctx.photos.remove([...removed]);
          for (const p of pending) await ctx.photos.add(txId, p.blob, undefined, p.pdf ? p.name : null);
          if (pending.length || removed.size) { await refreshCounts(); if (ctx.isOpen('claimsDialog')) render(); }
        } catch (err) {
          toast(`Entry saved, but the receipt${pending.length === 1 ? '' : 's'} couldn’t be stored: ${err.message}`, 'error');
        }
      },
    };
  }

  /** The entry was deleted: its receipts go too. */
  async function entryDeleted(txId) {
    try { await ctx.photos.removeForEntry(txId); } catch { /* nothing to remove */ }
  }

  // ---------------------------------------------------------------- share
  async function share(txs) {
    if (!txs.length) return;
    const fresh = txs.map((t) => ctx.ledger().transactions.find((x) => x.id === t.id) ?? t).filter(isExpense);
    const text = shareSummary(fresh);
    const title = fresh.length === 1 ? `Expense claim — ${fresh[0].description}` : `Expense claims (${fresh.length})`;
    const files = [];
    try {
      for (const t of fresh) {
        const metas = await ctx.photos.forEntry(t.id);
        for (let i = 0; i < metas.length; i++) {
          const blob = await ctx.photos.get(metas[i].id);
          const pdf = isPdf(metas[i]) || isPdf(blob);
          if (blob) files.push(new File([blob], receiptFileName(t, i + 1, metas.length, pdf ? 'pdf' : 'jpg'), { type: pdf ? PDF_TYPE : blob.type || 'image/jpeg' }));
        }
      }
    } catch (err) {
      toast(`Couldn’t read the receipts: ${err.message}`, 'error');
      return;
    }
    const canFiles = (() => { try { return files.length > 0 && Boolean(navigator.canShare?.({ files })); } catch { return false; } })();
    try {
      if (canFiles) { await navigator.share({ files, text, title }); return; }
      if (!files.length && navigator.share) { await navigator.share({ text, title }); return; }
    } catch (err) {
      if (err?.name === 'AbortError') return; // closed the share sheet
      // fall through to downloading
    }
    // No Share sheet for files here (some desktop browsers): download the receipts and copy the text
    for (const f of files) ctx.downloadBlob(f, f.name);
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch { /* not allowed */ }
    toast([files.length ? `Downloaded ${plural(files.length, 'receipt')}` : '', copied ? 'details copied — paste them into your email' : ''].filter(Boolean).join('; ') || 'Couldn’t share or copy here', copied || files.length ? 'ok' : 'error');
  }

  // ---------------------------------------------------------------- claim list
  async function open({ accountId = null } = {}) {
    view.accountId = accountId && tickedAccounts().some((a) => a.id === accountId) ? accountId : null;
    view.mode = 'list';
    view.select = false;
    view.picked.clear();
    await refreshCounts();
    render();
    openDialog($('claimsDialog'));
  }

  /** Redraw if open — after any save (app.js commit) or a photo change. */
  function refresh() {
    if (!ctx.isOpen('claimsDialog')) return;
    refreshCounts().then(render);
  }

  function accountChips() {
    const ticked = tickedAccounts();
    if (ticked.length < 2) return null;
    const chip = (id, label, colourAcc) => h('button', {
      type: 'button', class: 'arch-chip', 'aria-pressed': String(view.accountId === id),
      style: colourAcc ? { '--acc': colourAcc } : null,
      onclick: () => { view.accountId = id; view.picked.clear(); render(); },
    }, label);
    return h('div', { class: 'arch-chips', role: 'group', 'aria-label': 'Account' },
      chip(null, 'All accounts'), ticked.map((a) => chip(a.id, a.name)));
  }

  function render() {
    const dlg = $('claimsDialog');
    if (view.mode === 'pick') return renderPick();
    const ledger = ctx.ledger();
    const many = !view.accountId && tickedAccounts().length > 1;
    const sections = claimSections(ledger, { accountId: view.accountId });
    const total = sections.reduce((n, s) => n + s.count, 0);
    const acc = view.accountId ? ctx.accountById(view.accountId) : null;

    const move = async (ids, status, msg) => {
      await ctx.commit(setClaimStatus(ctx.ledger(), ids, status), msg);
    };
    const row = (r) => {
      const t = r.tx;
      const e = t.expense;
      const n = view.counts.get(t.id) ?? 0;
      const next = nextStatus(r.status);
      const back = previousStatus(r.status);
      const tick = (label, checked, onclick) => h('button', {
        type: 'button', class: `exp-tick ${checked ? 'on' : ''}`, role: 'checkbox', 'aria-checked': String(checked), onclick,
      }, h('span', { class: 'exp-tick-box', 'aria-hidden': 'true' }, checked ? '✓' : ''), label);
      const ticks = [];
      if (r.status !== 'toClaim') ticks.push(tick(STATUS_LABELS[r.status], true, () => move([t.id], back, `Back to ${STATUS_LABELS[back]}`)));
      if (next) ticks.push(tick(STATUS_LABELS[next], false, () => move([t.id], next, `Moved to ${STATUS_LABELS[next]}`)));
      const pick = view.select ? h('input', {
        type: 'checkbox', class: 'exp-pick', 'aria-label': `Select ${t.description}`, checked: view.picked.has(t.id),
        onchange: (ev) => { if (ev.target.checked) view.picked.add(t.id); else view.picked.delete(t.id); drawShareBar(); },
      }) : null;
      return h('li', { class: 'exp-row', dataset: { txId: t.id } },
        pick,
        h('button', { type: 'button', class: 'exp-main', onclick: () => ctx.openTxDialog({ txId: t.id }) },
          h('span', { class: 'exp-line' },
            h('span', { class: 'exp-date' }, ctx.shortDate(t.date)),
            h('span', { class: 'exp-desc' }, t.description || '(no description)'),
            n ? h('span', { class: 'exp-cam', title: plural(n, 'receipt'), 'aria-label': plural(n, 'receipt') }, lineIcon(h, 'paperclip', 15), n > 1 ? h('span', { class: 'exp-cam-n' }, String(n)) : null) : null,
            h('span', { class: 'exp-amt' }, ctx.formatPence(e.amount))),
          e.details || many || e.amount < t.amount ? h('span', { class: 'exp-sub muted small' },
            [many ? r.account.name : null, e.amount < t.amount ? `part of ${ctx.formatPence(t.amount)}` : null, e.details || null].filter(Boolean).join(' · ')) : null),
        h('span', { class: 'exp-ticks' }, ticks));
    };
    const section = (s) => {
      const collapsible = s.status === 'paid' && s.count > 0;
      const openList = !collapsible || view.paidOpen;
      return h('section', { class: `exp-section exp-${s.status}` },
        h('h3', { class: 'exp-head' },
          collapsible
            ? h('button', { type: 'button', class: 'btn-link', 'aria-expanded': String(openList), onclick: () => { view.paidOpen = !view.paidOpen; render(); } }, `${openList ? '▾' : '▸'} ${s.label}`)
            : s.label,
          h('span', { class: 'exp-head-n muted' }, ` · ${s.count}`),
          h('span', { class: 'exp-head-total' }, ctx.formatPence(s.total))),
        openList
          ? (s.count ? h('ul', { class: 'exp-list' }, s.rows.map(row)) : h('p', { class: 'muted small exp-none' }, s.status === 'toClaim' ? 'Nothing to claim.' : s.status === 'submitted' ? 'Nothing submitted and waiting.' : 'Nothing marked paid.'))
          : null);
    };

    const shareBar = h('div', { class: 'exp-sharebar', hidden: !view.select });
    function drawShareBar() {
      const n = view.picked.size;
      shareBar.replaceChildren(
        h('span', { class: 'small' }, n ? `${plural(n, 'claim')} selected` : 'Tick the claims to share'),
        h('button', { type: 'button', class: 'btn-primary btn-small', disabled: !n, onclick: () => {
          const txs = ctx.ledger().transactions.filter((t) => view.picked.has(t.id));
          share(txs);
        } }, 'Share…'));
    }
    drawShareBar();

    dlg.replaceChildren(...windowFrame(h, dlg, acc ? `Expense claims · ${acc.name}` : 'Expense claims', null, 'exp-body',
      accountChips(),
      h('div', { class: 'btn-row exp-tools' },
        h('button', { type: 'button', class: 'btn-secondary btn-small', onclick: () => { view.mode = 'pick'; view.picked.clear(); render(); } }, '+ Add from recent entries'),
        total ? h('button', {
          type: 'button', class: `btn-ghost btn-small ${view.select ? 'on' : ''}`, 'aria-pressed': String(view.select),
          onclick: () => { view.select = !view.select; view.picked.clear(); render(); },
        }, view.select ? 'Done selecting' : 'Select to share') : null),
      total ? null : h('p', { class: 'muted small' }, 'No claims yet. Tick “Business expense” on an entry, or add several from recent entries.'),
      sections.map(section),
      h('p', { class: 'muted small' }, 'Tick to move a claim on, untick to move it back. Tap a claim to change its details or receipts. Receipts stay on this device.'),
      shareBar));
  }

  // ---- "Add from recent entries": pick several, then fill each in turn
  function renderPick() {
    const dlg = $('claimsDialog');
    const list = recentCandidates(ctx.ledger(), ctx.today(), { accountId: view.accountId });
    const many = !view.accountId && tickedAccounts().length > 1;
    const go = h('button', { type: 'button', class: 'btn-primary', disabled: !view.picked.size, onclick: () => runQueue() });
    const syncGo = () => { go.disabled = !view.picked.size; go.textContent = view.picked.size ? `Fill in ${plural(view.picked.size, 'claim')}` : 'Fill in claims'; };
    syncGo();
    dlg.replaceChildren(...windowFrame(h, dlg, 'Add from recent entries', null, 'exp-body',
      accountChips(),
      h('p', { class: 'muted small' }, `Money out in the last ${RECENT_DAYS} days that isn’t a claim yet. Pick the ones that are, then fill in each one’s details and receipts in turn.`),
      list.length
        ? h('ul', { class: 'exp-list' }, list.map((t) => h('li', { class: 'exp-row' },
            h('label', { class: 'exp-main exp-pickrow' },
              h('input', { type: 'checkbox', class: 'exp-pick', checked: view.picked.has(t.id), onchange: (ev) => { if (ev.target.checked) view.picked.add(t.id); else view.picked.delete(t.id); syncGo(); } }),
              h('span', { class: 'exp-line' },
                h('span', { class: 'exp-date' }, ctx.shortDate(t.date)),
                h('span', { class: 'exp-desc' }, t.description || '(no description)', many ? h('span', { class: 'muted small' }, ` · ${ctx.accountById(t.accountId)?.name ?? ''}`) : null),
                h('span', { class: 'exp-amt' }, ctx.formatPence(t.amount)))))))
        : h('p', { class: 'muted small' }, 'Nothing recent that isn’t already a claim.'),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn-secondary', onclick: () => { view.mode = 'list'; view.picked.clear(); render(); } }, 'Back'),
        go)));
  }

  function runQueue() {
    const ids = ctx.ledger().transactions.filter((t) => view.picked.has(t.id) && canBeExpense(t)).sort((a, b) => (a.date < b.date ? -1 : 1)).map((t) => t.id);
    view.mode = 'list';
    view.picked.clear();
    render();
    let i = 0;
    const step = () => {
      if (i >= ids.length) { toast(`${plural(ids.length, 'claim')} added`); return; }
      const id = ids[i++];
      ctx.openTxDialog({
        txId: id, expenseStart: true, note: ids.length > 1 ? `Claim ${i} of ${ids.length}` : null,
        onSaved: () => setTimeout(step, 0),
        onCancel: () => { if (i < ids.length) toast(`Stopped — ${plural(ids.length - i + 1, 'entry', 'entries')} not filled in`, 'error'); },
      });
    };
    step();
  }

  // ---------------------------------------------------------------- ⚙
  function settingsSection() {
    if (!anyTicked()) return null;
    const usage = h('p', { class: 'muted small' }, 'Receipts on this device: …');
    ctx.photos.list().then((m) => {
      const bytes = m.reduce((s, x) => s + (x.size ?? 0), 0);
      usage.textContent = m.length ? `Receipts on this device: ${m.length} (${sizeText(bytes)}).` : 'No receipts on this device.';
    }).catch(() => { usage.textContent = 'Receipts on this device: couldn’t check.'; });
    const n = claimSections(ctx.ledger())[0].count;
    return h('section', { class: 'settings-section' },
      h('h3', {}, 'Expense claims'),
      h('p', { class: 'muted small' }, `${n ? `${plural(n, 'claim')} to claim. ` : ''}On ${tickedAccounts().map((a) => a.name).join(', ')}. Receipts (photos and PDFs) are kept on this device only — never on Drive — until you delete them.`),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn-secondary', onclick: () => open() }, 'Claim list'),
        h('button', { type: 'button', class: 'btn-secondary', onclick: cleanUp }, 'Delete receipts of paid claims')),
      usage);
  }

  async function cleanUp() {
    let plan;
    try { plan = await ctx.photos.cleanupPlan(ctx.ledger()); } catch (err) { toast(`Couldn’t check the receipts: ${err.message}`, 'error'); return; }
    const msg = cleanupMessage(plan);
    if (plan.kind !== 'some') { alert(msg); return; }
    if (!confirm(msg)) return;
    try {
      await ctx.photos.remove(plan.photoIds);
      toast(`Deleted ${plural(plan.count, 'receipt')}`);
    } catch (err) {
      toast(`Couldn’t delete: ${err.message}`, 'error');
    }
    await refreshCounts();
    ctx.afterCleanup?.();
  }

  /** "Erase all data on this device": the receipts too. */
  async function eraseLocal() {
    try { await ctx.photos.remove((await ctx.photos.list()).map((m) => m.id)); } catch { /* none */ }
  }

  // ---------------------------------------------------------------- headers and rows
  function headerButton(account, cls) {
    if (!claimsOn(account)) return null;
    return h('button', { type: 'button', class: cls, title: `Expense claims — ${account.name}`, 'aria-label': `Expense claims — ${account.name}`, onclick: () => open({ accountId: account.id }) },
      lineIcon(h, 'receipt', 16));
  }
  /**
   * Phone header: a line under the balance, like the card statement line (no
   * room for a third button). v0.15.9: only while some claims aren't paid yet.
   */
  function bannerLine(account) {
    if (!claimsOn(account)) return null;
    const { toClaim, submitted, any } = unpaidSummary(ctx.ledger(), account.id);
    if (!any) return null;
    const bits = [
      toClaim.count ? `${toClaim.count} to claim (${ctx.formatPence(toClaim.total)})` : null,
      submitted.count ? `${submitted.count} submitted (${ctx.formatPence(submitted.total)})` : null,
    ].filter(Boolean);
    return h('button', { type: 'button', class: 'banner-stmt banner-claims', onclick: () => open({ accountId: account.id }) },
      lineIcon(h, 'receipt', 14), ` Expense claims: ${bits.join(', ')} ›`);
  }
  /** A small mark on an entry that's a claim, on a ticked account. */
  function rowMark(tx, account) {
    if (!isExpense(tx) || !claimsOn(account)) return null;
    return h('span', { class: 'exp-mark', title: `Expense claim — ${STATUS_LABELS[tx.expense.status] ?? ''}`, 'aria-label': 'Expense claim', role: 'img' }, lineIcon(h, 'receipt', 13));
  }

  return { entryFields, entryDeleted, open, refresh, share, settingsSection, cleanUp, eraseLocal, headerButton, bannerLine, rowMark, anyTicked };
}
