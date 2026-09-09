/**
 * Regression: camera apply sentinels are NaN.
 * `Math.abs(x - NaN) > eps` is always false → rig never written → start pose + zoom die.
 * `x !== NaN` is always true → first apply runs.
 */
function needsApplyAbsEps(cur, prev, eps = 1e-5) {
  return Math.abs(cur - prev) > eps;
}
function needsApplyNeq(cur, prev) {
  return cur !== prev;
}

const cases = [
  { name: 'first apply (prev NaN)', cur: 32, prev: NaN, mustApply: true },
  { name: 'zoom y change', cur: 40, prev: 32, mustApply: true },
  { name: 'unchanged', cur: 32, prev: 32, mustApply: false },
];

let failed = 0;
for (const c of cases) {
  const neq = needsApplyNeq(c.cur, c.prev);
  if (neq !== c.mustApply) {
    console.error(`!== failed: ${c.name} got ${neq}`);
    failed++;
  }
  if (c.prev !== c.prev) {
    const abs = needsApplyAbsEps(c.cur, c.prev);
    if (abs) {
      console.error(`unexpected: abs-eps applied on NaN for ${c.name}`);
      failed++;
    } else {
      console.log(`caught: abs-eps misses first apply (${c.name}) — do not use it`);
    }
  }
}

if (failed) {
  console.error(`test-camera-apply failed (${failed})`);
  process.exit(1);
}
console.log('✅ test-camera-apply passed');
