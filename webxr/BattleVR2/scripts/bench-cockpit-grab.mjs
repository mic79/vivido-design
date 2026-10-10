#!/usr/bin/env node
/**
 * Grab: cockpit-local deltas, proportional thrust, hover coasts after release.
 *   node BattleVR2/scripts/bench-cockpit-grab.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9137);
const OUT = path.join(ROOT, 'bench-out', 'cockpit-grab');
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
  window.__BATTLEVR2_FORCE_VEHICLE_STEP__ = true;
  await new Promise((r) => setTimeout(r, 400));
  window.__BATTLEVR2_DESKTOP_VEHICLE__ = { yaw: 0, thrust: 0, boost: false };

  const cock = await import('./js/cockpit.js');
  const vmod = await import('./js/vehicle.js');
  const THREE = window.THREE;
  const scene = window.__BATTLEVR2_COCKPIT__.scene;
  let steer = null;
  let thr = null;
  scene.traverse((o) => {
    if (o.name === 'steer-wrap') steer = o;
    if (o.name === 'thrust-wrap') thr = o;
  });
  const wp = (o) => {
    const v = new THREE.Vector3();
    o.getWorldPosition(v);
    return { x: v.x, y: v.y, z: v.z };
  };

  const poseYaw = () => window.__BATTLEVR2_VEHICLE__.getPose().yaw;
  const axes = () => {
    const yaw = poseYaw();
    return {
      fwdX: -Math.sin(yaw),
      fwdZ: -Math.cos(yaw),
      rightX: Math.cos(yaw),
      rightZ: -Math.sin(yaw),
    };
  };

  // --- proportional thrust ---
  cock.syncCockpitToVehicle();
  let tp = wp(thr);
  let sp = wp(steer);
  let { fwdX, fwdZ, rightX, rightZ } = axes();

  cock.setHandWorldPos('left', tp.x, tp.y, tp.z, true);
  cock.setHandWorldPos('right', sp.x + 2, sp.y, sp.z, false);
  cock.updateCockpitControls();
  cock.setHandWorldPos('left', tp.x + fwdX * 0.07, tp.y, tp.z + fwdZ * 0.07, true);
  let a = cock.updateCockpitControls();
  const thrustHalf = a.thrust;

  cock.setHandWorldPos('left', tp.x + fwdX * 0.14, tp.y, tp.z + fwdZ * 0.14, true);
  a = cock.updateCockpitControls();
  const thrustFull = a.thrust;

  // Hold lever while vehicle moves: hand tracks control (body locked to seat)
  for (let i = 0; i < 45; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: a.thrust, boost: false });
    vmod.stepVehicle(1 / 60);
    cock.syncCockpitToVehicle();
    ({ fwdX, fwdZ } = axes());
    tp = wp(thr);
    cock.setHandWorldPos('left', tp.x + fwdX * 0.14, tp.y, tp.z + fwdZ * 0.14, true);
    cock.setHandWorldPos('right', sp.x + 2, sp.y, sp.z, false);
    a = cock.updateCockpitControls();
  }
  const thrustWhileMoving = a.thrust;

  // Release lever → axis 0, but coast
  const pFast = vmod.getVehiclePose();
  cock.setHandWorldPos('left', tp.x, tp.y, tp.z, false);
  a = cock.updateCockpitControls();
  const thrustAfterRelease = a.thrust;

  for (let i = 0; i < 60; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: 0, boost: false });
    vmod.stepVehicle(1 / 60);
  }
  const pCoast = vmod.getVehiclePose();
  const coastDist = Math.hypot(pCoast.x - pFast.x, pCoast.z - pFast.z);

  // --- yaw right (fresh control positions) ---
  cock.syncCockpitToVehicle();
  sp = wp(steer);
  tp = wp(thr);
  ({ rightX, rightZ } = axes());
  cock.setHandWorldPos('right', sp.x, sp.y, sp.z, true);
  cock.setHandWorldPos('left', tp.x + 2, tp.y, tp.z, false);
  cock.updateCockpitControls();
  cock.setHandWorldPos('right', sp.x + rightX * 0.11, sp.y, sp.z + rightZ * 0.11, true);
  a = cock.updateCockpitControls();
  const yawRight = a.yaw;
  cock.setHandWorldPos('right', sp.x + rightX * 0.4, sp.y, sp.z + rightZ * 0.4, false);
  a = cock.updateCockpitControls();
  const yawAfterRelease = a.yaw;

  return {
    thrustHalf,
    thrustFull,
    thrustWhileMoving,
    thrustAfterRelease,
    coastDist,
    yawRight,
    yawAfterRelease,
    hasSteering: !!steer,
    hasThrottle: !!thr,
  };
});

const ok = !!(
  probe.hasSteering &&
  probe.hasThrottle &&
  probe.thrustHalf > 0.25 &&
  probe.thrustHalf < 0.85 &&
  probe.thrustFull > 0.85 &&
  probe.thrustWhileMoving > 0.5 &&
  Math.abs(probe.thrustAfterRelease) < 0.05 &&
  probe.coastDist > 0.5 &&
  probe.yawRight < -0.5 &&
  Math.abs(probe.yawAfterRelease) < 0.05
);

const report = { ok, probe, errors: errors.slice(0, 25) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
