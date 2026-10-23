/**
 * v0.15.11: the small balance line on each summary card — the shape of the
 * current calendar month, day by day. Solid up to today, dashed after it
 * (projected), with a dot on today. Pure: takes the daily balances and
 * returns SVG markup, so it can be tested without a browser.
 */

export const SPARK_W = 100;
export const SPARK_H = 28;
const PAD = 3; // keep the stroke and the today dot inside the box

/** Every ISO day from the 1st of dateIso's month to its last day. */
export function monthDays(dateIso) {
  const [y, m] = dateIso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return Array.from({ length: last }, (_, i) => `${y}-${mm}-${String(i + 1).padStart(2, '0')}`);
}

/** x/y points for the values, scaled into the box (a flat month sits in the middle). */
export function sparkPoints(values) {
  const n = values.length;
  if (!n) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  return values.map((v, i) => ({
    x: n === 1 ? SPARK_W / 2 : (i / (n - 1)) * SPARK_W,
    y: span === 0 ? SPARK_H / 2 : PAD + (1 - (v - lo) / span) * (SPARK_H - PAD * 2),
  }));
}

const f = (n) => Math.round(n * 100) / 100;
const pathOf = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`).join(' ');

/**
 * SVG markup for the line. todayIndex is today's position in values
 * (-1 or past the end when today isn't in this month: all solid).
 */
export function sparklineSvg(values, todayIndex) {
  const pts = sparkPoints(values);
  if (pts.length < 2) return '';
  const t = todayIndex >= 0 && todayIndex < pts.length ? todayIndex : pts.length - 1;
  const past = pathOf(pts.slice(0, t + 1));
  const ahead = t < pts.length - 1 ? pathOf(pts.slice(t)) : '';
  const dot = pts[t];
  return `<svg class="spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">`
    + (t > 0 ? `<path class="spark-past" d="${past}" />` : '')
    + (ahead ? `<path class="spark-ahead" d="${ahead}" />` : '')
    + `</svg><span class="spark-dot" style="left:${f(dot.x)}%;top:${f((dot.y / SPARK_H) * 100)}%"></span>`;
}
