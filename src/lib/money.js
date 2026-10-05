/**
 * Money helpers. Everything inside the app is integer pence; these are the
 * only places pounds-and-pence strings are parsed or produced.
 */

/**
 * Parse user input into integer pence.
 * Accepts "12", "12.3", "12.34", "£1,234.56", " 0.5 ". Rejects negatives
 * (direction carries the sign), more than 2 decimal places, and junk.
 *
 * @param {string|number} input
 * @returns {number|null} pence, or null if invalid/empty
 */
export function parseAmount(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().replace(/^£/, '').replace(/,/g, '').trim();
  if (s === '') return null;
  // "12", "12.", "12.3", "12.34", ".5"
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[1] === '' && !m[2])) return null;
  const pounds = Number(m[1] || '0');
  const pence = Number((m[2] ?? '').padEnd(2, '0'));
  const total = pounds * 100 + pence;
  return Number.isSafeInteger(total) ? total : null;
}

/**
 * Format integer pence as £1,234.56 (or -£12.00).
 *
 * @param {number} pence
 * @param {{ symbol?: boolean }} [opts]
 * @returns {string}
 */
export function formatPence(pence, { symbol = true } = {}) {
  const negative = pence < 0;
  const abs = Math.abs(pence);
  const pounds = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  const withCommas = String(pounds).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol ? '£' : ''}${withCommas}.${rem}`;
}

/** Pence to a plain "12.34" string for pre-filling inputs. */
export function penceToInput(pence) {
  return formatPence(pence, { symbol: false }).replace(/,/g, '');
}
