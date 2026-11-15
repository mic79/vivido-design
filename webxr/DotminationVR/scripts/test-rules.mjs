// Headless rules/AI test: node scripts/test-rules.mjs  (no browser needed)
import fs from 'fs'; import vm from 'vm'; import { fileURLToPath } from 'url';
const dir = fileURLToPath(new URL('..', import.meta.url));
globalThis.window = globalThis;
for (const f of ['dot-rules.js', 'dot-bot.js']) vm.runInThisContext(fs.readFileSync(dir + f, 'utf8'));
const { DotRules: R, DotBot: B } = globalThis;
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } };
const L = R.layoutFor();
assert(L.count === 40, 'original field has 40 dots');
const deg = L.neighbors.map(n => n.length);
assert(Math.max(...deg) === 6 && Math.min(...deg) >= 2, 'hex neighbours');
for (let i = 0; i < L.count; i++) assert(L.neighbors[i].every(n => L.neighbors[n].includes(i)), 'symmetric');
// Level 1 reproduces the phone game's map deterministically
const a = new R.State().populateLevel(1, 'red', 'blue').serialize(), b = new R.State().populateLevel(1, 'red', 'blue').serialize();
assert(a.o === b.o && a.s === b.s, 'level deterministic');
// burst empties the dot and feeds neighbours
const s = new R.State(); s.owner[20] = 1; s.stage[20] = 5;
const r = s.apply('blue', 20);
assert(r.bursts === 1 && s.owner[20] === 0 && L.neighbors[20].every(n => s.owner[n] === 1 && s.stage[n] === 1), 'burst');
function play(start, diff1, diff2, cap = 600) {
  const st = new R.State(); start(st);
  let turn = 'blue', moves = 0, recent = { blue: [], red: [] };
  while (moves < cap) {
    const opp = turn === 'blue' ? 'red' : 'blue';
    const mv = B.chooseMove(st, turn, opp, turn === 'blue' ? diff1 : diff2, { recent: recent[turn] });
    if (mv < 0) return { w: opp, moves };
    const res = st.apply(turn, mv); assert(res && !res.truncated, 'chain terminated');
    moves++;
    if (moves >= 2 && (!st.count('blue') || !st.count('red'))) return { w: st.count('blue') ? 'blue' : 'red', moves };
    turn = opp;
  }
  return { w: 'none', moves };
}
const t0 = Date.now();
for (const [name, start] of [['level', (st, g) => st.populateLevel(1 + Math.floor(Math.random() * 200), 'red', 'blue')],
                             ['random', st => st.populateRandom(R.newSeed(), 'red', 'blue')],
                             ['half', st => st.populateHalf('red', 'blue')]]) {
  const out = { blue: 0, red: 0, none: 0 }, len = [];
  for (let g = 0; g < 40; g++) { const res = play(start, 'smart', 'random'); out[res.w]++; len.push(res.moves); }
  len.sort((x, y) => x - y);
  console.log(name.padEnd(7), 'smart(blue) vs normal(red):', JSON.stringify(out), 'median moves', len[20], 'max', len[39]);
}
console.log('ALL OK', Date.now() - t0, 'ms');
