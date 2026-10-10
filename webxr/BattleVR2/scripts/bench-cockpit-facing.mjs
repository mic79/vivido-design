#!/usr/bin/env node
/**
 * Regression: boarded look faces canopy (pose.yaw), not seat (pose.yaw+π).
 * Thrust must move along look; control wraps must pivot at stick/lever (not cabin origin).
 *   node BattleVR2/scripts/bench-cockpit-facing.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9136);
const OUT = path.join(ROOT, 'bench-out', 'cockpit-facing');
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
  await new Promise((r) => setTimeout(r, 400));
  const cock = window.__BATTLEVR2_COCKPIT__;
  const pose0 = window.__BATTLEVR2_VEHICLE__.getPose();
  const seat = cock.getSeatWorldPosition();
  const cockpitYaw = cock.root.object3D.rotation.y;
  const rig = document.getElementById('cameraRig')?.object3D;
  if (rig) {
    rig.position.set(seat.x, seat.y, seat.z);
    rig.rotation.set(0, seat.yaw, 0);
  }

  const vmod = await import('./js/vehicle.js');
  const before = vmod.getVehiclePose();
  for (let i = 0; i < 60; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: 1, boost: false });
    vmod.stepVehicle(1 / 60);
  }
  const after = vmod.getVehiclePose();
  const look = seat.yaw;
  const dx = after.x - before.x;
  const dz = after.z - before.z;
  const alongLook = dx * -Math.sin(look) + dz * -Math.cos(look);

  const wraps = [];
  cock.scene.traverse((o) => {
    if (o.name === 'steer-wrap' || o.name === 'thrust-wrap') {
      wraps.push({
        name: o.name,
        atOrigin: Math.hypot(o.position.x, o.position.y, o.position.z) < 0.01,
      });
    }
  });

  const lookMatchesPose = Math.abs(seat.yaw - pose0.yaw) < 1e-6;
  const meshIsBiased = Math.abs(Math.abs(cockpitYaw - pose0.yaw) - Math.PI) < 0.02;
  const notFacingSeat = Math.abs(seat.yaw - cockpitYaw) > 1; // ~π apart
  return {
    poseYaw: pose0.yaw,
    seatYaw: seat.yaw,
    rigYaw: rig?.rotation.y ?? null,
    cockpitYaw,
    lookMatchesPose,
    meshIsBiased,
    notFacingSeat,
    alongLook,
    wrapsOk: wraps.length === 2 && wraps.every((w) => !w.atOrigin),
    wraps,
  };
});

const ok = !!(
  probe.lookMatchesPose &&
  probe.meshIsBiased &&
  probe.notFacingSeat &&
  probe.alongLook > 0.6 &&
  probe.wrapsOk
);

const report = { ok, probe, errors: errors.slice(0, 25) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
