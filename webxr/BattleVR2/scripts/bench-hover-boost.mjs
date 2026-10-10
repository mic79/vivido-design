#!/usr/bin/env node
/**
 * Board → thrust moves + boost lifts Y; body stays visible; zerog mode on.
 *   node BattleVR2/scripts/bench-hover-boost.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9131);
const OUT = path.join(ROOT, 'bench-out', 'hover-boost');
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
  window.__BATTLEVR2_ENTER_VEHICLE__?.();
  const before = window.__BATTLEVR2_VEHICLE__?.getPose?.();
  const mod = await import('./js/vehicle.js');
  const cock = window.__BATTLEVR2_COCKPIT__;
  for (let i = 0; i < 90; i++) {
    mod.setVehicleControls({ yaw: 0, thrust: 1, boost: false });
    mod.stepVehicle(1 / 60);
  }
  const afterThrust = mod.getVehiclePose();
  const y0 = afterThrust.y;
  let peakY = y0;
  mod.setVehicleControls({ yaw: 0, thrust: 1, boost: true });
  mod.stepVehicle(1 / 60);
  peakY = Math.max(peakY, mod.getVehiclePose().y);
  for (let i = 0; i < 25; i++) {
    mod.setVehicleControls({ yaw: 0, thrust: 1, boost: false });
    mod.stepVehicle(1 / 60);
    peakY = Math.max(peakY, mod.getVehiclePose().y);
  }
  const afterBoost = mod.getVehiclePose();
  const body = document.getElementById('local-body');
  return {
    boarded: !!window.__BATTLEVR2_BOARDED__,
    before,
    afterThrust,
    afterBoost,
    moveDist: Math.hypot(afterThrust.x - before.x, afterThrust.z - before.z),
    boostLift: afterBoost.y - y0,
    peakLift: peakY - y0,
    cockpitCtrl: cock?.getCockpitControlDebug?.() || null,
    hasBody: !!body,
    bodyVisible: body?.getAttribute('visible'),
    mixamo: !!(body && body.components && body.components['mixamo-body']),
    zerog: window.BodyRiggedGravity?.isZeroG?.() === true,
  };
});

const bodyOk =
  probe.bodyVisible === 'true' ||
  probe.bodyVisible === true ||
  probe.bodyVisible == null;

const ok = !!(
  probe.boarded &&
  probe.moveDist > 1.2 &&
  (probe.boostLift > 0.25 || probe.peakLift > 0.25) &&
  probe.cockpitCtrl?.hasSteering &&
  probe.cockpitCtrl?.hasThrottle &&
  probe.hasBody &&
  probe.mixamo &&
  bodyOk &&
  probe.zerog
);

const report = { ok, probe, errors: errors.slice(0, 25) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
