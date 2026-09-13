/**
 * FoW paint: darken-only (no hue), soft clear vision disk.
 * Run: node verify-fog-paint.mjs
 */
function paint(live, explored) {
  if (live > 0.72) return { a: 0, r: 0, g: 0, b: 0 };
  const t = 1 - live / 0.72;
  const base = explored < 0.35 ? 168 : 115;
  let a = 28 + t * t * base;
  if (live > 0.05 && live < 0.72) {
    const u = (live - 0.05) / 0.67;
    a += Math.sin(u * Math.PI) * 52;
  }
  return { a: Math.min(185, a), r: 0, g: 0, b: 0 };
}

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

const clear = paint(1, 1);
const mid = paint(0.4, 1);
const exploredOut = paint(0, 1);
const unexploredOut = paint(0, 0);

assert(clear.a === 0, `clear a=0 got ${clear.a}`);
assert(clear.r === 0 && clear.g === 0 && clear.b === 0, 'no hue on clear');
assert(unexploredOut.r === 0 && unexploredOut.g === 0 && unexploredOut.b === 0, 'no hue on shroud');
assert(mid.a > 40 && mid.a < exploredOut.a, `soft rim ${mid.a}`);
assert(unexploredOut.a >= 140 && unexploredOut.a <= 185, `unexplored ${unexploredOut.a}`);
assert(exploredOut.a < unexploredOut.a, 'explored lighter than unexplored');

console.log('PASS verify-fog-paint', { clear, mid, exploredOut, unexploredOut });
