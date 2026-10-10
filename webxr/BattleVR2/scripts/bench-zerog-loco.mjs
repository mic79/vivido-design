#!/usr/bin/env node
/**
 * Assert CapVR-style zero-G loco moves the hover body (not walk capsule).
 *   node BattleVR2/scripts/bench-zerog-loco.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9132);
const OUT = path.join(ROOT, 'bench-out', 'zerog-loco');
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 90; i++) {
  if (await page.evaluate(() => !!window.__SCENE_READY__ && !!window.__BATTLEVR2_BOOT__)) break;
  await sleep(1000);
}

await page.evaluate(async () => {
  window._dismissAppStartGate?.();
  await window._startGame?.('1v1');
});
for (let i = 0; i < 60; i++) {
  if (await page.evaluate(() => !!window.__BATTLEVR2_MATCH__)) break;
  await sleep(500);
}

const probe = await page.evaluate(async () => {
  const mod = await import('./js/zerog-loco.js');
  const before = mod.stepZerog(0, {});
  mod.setThruster('left', true);
  mod.setThruster('right', true);
  let last = before;
  for (let i = 0; i < 90; i++) {
    // Surge assist + thrusters (headless hands have no oriented thrusters)
    last = mod.stepZerog(1 / 60, { yawStick: 0, surge: 1, strafe: 0 });
  }
  mod.setThruster('left', false);
  mod.setThruster('right', false);
  const body = document.getElementById('local-body');
  return {
    zerog: window.BodyRiggedGravity?.isZeroG?.() === true,
    before,
    after: last,
    moved: Math.hypot(last.x - before.x, last.y - before.y, last.z - before.z),
    bodyVisible: body?.getAttribute('visible'),
    boarded: !!window.__BATTLEVR2_BOARDED__,
  };
});

const ok = !!(probe.zerog && !probe.boarded && probe.moved > 0.5);

const report = { ok, probe, errors: errors.slice(0, 20) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
