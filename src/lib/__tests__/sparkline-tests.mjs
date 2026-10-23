// Run with: node src/lib/__tests__/sparkline-tests.mjs
// v0.15.11: balance sparkline on the summary cards.
import assert from 'node:assert/strict';
import { monthDays, sparkPoints, sparklineSvg, SPARK_W, SPARK_H } from '../sparkline.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok - ${name}`); } catch (err) { failed++; console.log(`  FAIL - ${name}`); console.log(`    ${err.message}`); }
}

console.log('sparkline');

test('month days: October has 31, February 2028 has 29', () => {
  const oct = monthDays('2026-10-23');
  assert.equal(oct.length, 31);
  assert.equal(oct[0], '2026-10-01');
  assert.equal(oct[30], '2026-10-31');
  assert.equal(monthDays('2028-02-10').length, 29);
});

test('points span the full width; highest balance at the top', () => {
  const pts = sparkPoints([100, 500, 300]);
  assert.equal(pts[0].x, 0);
  assert.equal(pts[2].x, SPARK_W);
  assert.ok(pts[1].y < pts[2].y && pts[2].y < pts[0].y);
});

test('a flat month sits in the middle (no divide by zero)', () => {
  for (const p of sparkPoints([42, 42, 42])) assert.equal(p.y, SPARK_H / 2);
});

test('solid to today, dashed after, dot on today', () => {
  const svg = sparklineSvg([1, 2, 3, 4, 5], 2);
  assert.match(svg, /class="spark-past"/);
  assert.match(svg, /class="spark-ahead"/);
  assert.match(svg, /spark-dot" style="left:50%/);
});

test('today on the last day (or not this month): all solid', () => {
  assert.doesNotMatch(sparklineSvg([1, 2, 3], 2), /spark-ahead/);
  assert.doesNotMatch(sparklineSvg([1, 2, 3], -1), /spark-ahead/);
});

test('today on the 1st: only the projected line', () => {
  const svg = sparklineSvg([1, 2, 3], 0);
  assert.doesNotMatch(svg, /spark-past/);
  assert.match(svg, /spark-ahead/);
});

test('fewer than two points draws nothing', () => {
  assert.equal(sparklineSvg([5], 0), '');
  assert.equal(sparklineSvg([], 0), '');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
