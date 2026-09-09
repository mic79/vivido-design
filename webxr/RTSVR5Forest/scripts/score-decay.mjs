#!/usr/bin/env node
/**
 * Re-score a saved decay matrix without re-running the headset.
 *
 * The first pass scored "percent of seconds >=80 Hz", which is a pass/fail line and hides
 * how bad the bad seconds are — 89 Hz and 85 Hz are both fine in practice, and what
 * actually matters is time spent down around 70 Hz or below. This reports median and mean
 * Hz plus the share of time in the bad state, aggregated across repeats of each variant.
 *
 *   node RTSVR5/scripts/score-decay.mjs [proof-decay.json] [startSec]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.argv[2] || path.join(ROOT, 'proof-decay.json');
const START = Number(process.argv[3] || 20);

const runs = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const stat = (v) => {
  if (!v.length) return null;
  const a = [...v].sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
  return {
    n: a.length,
    median: q(0.5),
    mean: a.reduce((s, x) => s + x, 0) / a.length,
    p10: q(0.1),
    badPct: (100 * a.filter((h) => h < 75).length) / a.length,
    goodPct: (100 * a.filter((h) => h >= 85).length) / a.length,
  };
};

// Group repeats: "88tex r2" -> "88tex".
const groups = new Map();
for (const r of runs) {
  const key = (r.label || '').replace(/\s*r\d+\s*$/, '').trim() || r.label;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

console.log(`scoring from second ${START} onward, ${runs.length} runs\n`);
console.log('variant          runs |  median |  mean  |  p10  | % <75Hz | % >=85Hz | per-run medians');
for (const [key, rs] of groups) {
  const all = [];
  const perRun = [];
  for (const r of rs) {
    const hz = (r.hz || []).slice(START);
    all.push(...hz);
    const s = stat(hz);
    perRun.push(s ? s.median.toFixed(1) : '-');
  }
  const s = stat(all);
  if (!s) continue;
  console.log(
    `${key.padEnd(16)} ${String(rs.length).padStart(4)} | ${s.median.toFixed(1).padStart(7)} | ${s.mean.toFixed(1).padStart(6)} | ` +
      `${s.p10.toFixed(1).padStart(5)} | ${s.badPct.toFixed(0).padStart(6)}% | ${s.goodPct.toFixed(0).padStart(7)}% | ${perRun.join(', ')}`
  );
}

// Is the spread within a variant bigger than the spread between variants? If so, no
// per-variant conclusion is supportable from this data.
const medians = [];
const within = [];
for (const [, rs] of groups) {
  const per = rs.map((r) => stat((r.hz || []).slice(START))).filter(Boolean).map((s) => s.median);
  if (per.length > 1) within.push(Math.max(...per) - Math.min(...per));
  const s = stat(rs.flatMap((r) => (r.hz || []).slice(START)));
  if (s) medians.push(s.median);
}
if (medians.length > 1 && within.length) {
  const between = Math.max(...medians) - Math.min(...medians);
  const worstWithin = Math.max(...within);
  console.log(`\nspread between variants: ${between.toFixed(1)} Hz`);
  console.log(`worst spread within one variant's own repeats: ${worstWithin.toFixed(1)} Hz`);
  console.log(
    worstWithin >= between
      ? 'Repeats of the SAME setting differ as much as different settings — no variant conclusion is supportable.'
      : 'Between-variant spread exceeds within-variant noise — the variant does matter.'
  );
}
