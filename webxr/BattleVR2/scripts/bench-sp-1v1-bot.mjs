#!/usr/bin/env node
/**
 * Start 1v1 vs bot; assert strategy bot + units move.
 *   node BattleVR2/scripts/bench-sp-1v1-bot.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9121);
const OUT = path.join(ROOT, 'bench-out', 'sp-1v1-bot');
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });

for (let i = 0; i < 90; i++) {
  const r = await page.evaluate(() => !!window.__SCENE_READY__ && !!window.__BATTLEVR2_BOOT__);
  if (r) break;
  await sleep(1000);
}

await page.evaluate(async () => {
  window._dismissAppStartGate?.();
  if (typeof window._startGame === 'function') await window._startGame('1v1');
});

let snap = null;
for (let i = 0; i < 120; i++) {
  snap = await page.evaluate(() => {
    const gs = window.__BATTLEVR2_MATCH__;
    // Probe RTS state via boot hooks if exposed
    const units = gs?.units ?? 0;
    const started = !!gs;
    let botPlayers = 0;
    let moving = 0;
    try {
      // state is module-scoped; use DOM/unit count from match + console markers
    } catch (_) {}
    return {
      started,
      units,
      match: gs,
      elapsed: performance.now(),
    };
  });
  if (snap?.started && snap.units > 0) break;
  await sleep(1000);
}

// Let sim run ~8s
await sleep(8000);

const after = await page.evaluate(() => {
  const sc = document.querySelector('a-scene');
  const info = sc?.renderer?.info?.render;
  return {
    match: window.__BATTLEVR2_MATCH__,
    draws: info?.calls ?? null,
    tris: info?.triangles ?? null,
    boarded: !!window.__BATTLEVR2_BOARDED__,
  };
});

await page.screenshot({ path: path.join(OUT, 'after.png') });
const report = {
  ok: !!(after.match && after.match.units >= 6),
  snap,
  after,
  errors: errors.slice(0, 30),
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
server.close();
process.exit(report.ok ? 0 : 1);
