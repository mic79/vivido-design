#!/usr/bin/env node
/**
 * Enter vehicle, apply thrust, assert chassis moves, exit restores FP.
 *   node BattleVR2/scripts/bench-vehicle-cockpit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9122);
const OUT = path.join(ROOT, 'bench-out', 'vehicle-cockpit');
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
  await sleep(1000);
}

const before = await page.evaluate(() => {
  const boarded = window.__BATTLEVR2_ENTER_VEHICLE__?.();
  const v = window.__BATTLEVR2_VEHICLE__?.getPose?.();
  return { boarded: !!boarded || !!window.__BATTLEVR2_BOARDED__, pose: v, tick: window.__BATTLEVR2_TICK__ };
});

await page.evaluate(() => {
  window.__BATTLEVR2_FORCE_VEHICLE_STEP__ = true;
  window.__BATTLEVR2_DESKTOP_VEHICLE__ = { yaw: 0.2, thrust: 1 };
  // Deterministic integrate (headless rAF can be heavily throttled).
  for (let i = 0; i < 120; i++) {
    if (window.__BATTLEVR2_DESKTOP_VEHICLE__) {
      // step via exposed enter path internals
    }
  }
});

await page.evaluate(async () => {
  const mod = await import('./js/vehicle.js');
  for (let i = 0; i < 120; i++) {
    mod.setVehicleControls({ yaw: 0.2, thrust: 1 });
    mod.stepVehicle(1 / 60);
  }
});

await sleep(500);

const mid = await page.evaluate(() => {
  const v = window.__BATTLEVR2_VEHICLE__?.getPose?.();
  return {
    boarded: !!window.__BATTLEVR2_BOARDED__,
    pose: v,
    tick: window.__BATTLEVR2_TICK__,
    dbg: window.__BATTLEVR2_DEBUG__?.(),
  };
});

await page.evaluate(() => {
  window.__BATTLEVR2_EXIT_VEHICLE__?.();
  window.__BATTLEVR2_FORCE_VEHICLE_STEP__ = false;
});

const after = await page.evaluate(() => ({
  boarded: !!window.__BATTLEVR2_BOARDED__,
  tick: window.__BATTLEVR2_TICK__,
  dbg: window.__BATTLEVR2_DEBUG__?.(),
}));

const dx = Math.abs((mid.pose?.x ?? 0) - (before.pose?.x ?? 0));
const dz = Math.abs((mid.pose?.z ?? 0) - (before.pose?.z ?? 0));
const moved = Math.hypot(dx, dz) > 0.5;

const report = {
  ok: !!(before.boarded && moved && !after.boarded),
  before,
  mid,
  after,
  moveDist: Math.hypot(dx, dz),
  errors: errors.slice(0, 30),
};
await page.screenshot({ path: path.join(OUT, 'cockpit.png') });
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));

await browser.close();
server.close();
process.exit(report.ok ? 0 : 1);
