#!/usr/bin/env node
/**
 * Seat lock under yaw: headset world must stay on the seat (cabin-local) while turning.
 *   node BattleVR2/scripts/bench-seat-yaw-lock.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9140);
const OUT = path.join(ROOT, 'bench-out', 'seat-yaw-lock');
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
  await new Promise((r) => setTimeout(r, 300));

  const cock = await import('./js/cockpit.js');
  const vmod = await import('./js/vehicle.js');
  const THREE = window.THREE;
  const rig = document.getElementById('cameraRig')?.object3D;
  const cam = document.getElementById('camera')?.object3D;
  if (!rig || !cam) return { ok: false, reason: 'no rig/cam' };

  // Simulate XR head offset in rig-local (player not centered on rig origin)
  cam.position.set(0.18, 1.62, 0.07);

  function syncLikeInput(yaw) {
    // Same math as syncRigToSeat (must stay in sync with input-fp.js)
    const seat = cock.getSeatWorldPosition();
    const y = yaw != null ? yaw : seat.yaw;
    const c = Math.cos(y);
    const s = Math.sin(y);
    const hx = cam.position.x;
    const hy = cam.position.y;
    const hz = cam.position.z;
    rig.position.set(
      seat.x - (hx * c + hz * s),
      seat.y - hy,
      seat.z - (-hx * s + hz * c)
    );
    rig.rotation.set(0, y, 0);
    rig.updateMatrixWorld(true);
    cam.updateMatrixWorld(true);
    const headW = new THREE.Vector3();
    cam.getWorldPosition(headW);
    return {
      seat: { x: seat.x, y: seat.y, z: seat.z, yaw: y },
      head: { x: headW.x, y: headW.y, z: headW.z },
      err: Math.hypot(headW.x - seat.x, headW.y - seat.y, headW.z - seat.z),
    };
  }

  // Old (buggy) world-axis subtract for comparison at 90°
  function buggyErr(yaw) {
    const seat = cock.getSeatWorldPosition();
    const hx = cam.position.x;
    const hy = cam.position.y;
    const hz = cam.position.z;
    rig.position.set(seat.x - hx, seat.y - hy, seat.z - hz);
    rig.rotation.set(0, yaw, 0);
    rig.updateMatrixWorld(true);
    cam.updateMatrixWorld(true);
    const headW = new THREE.Vector3();
    cam.getWorldPosition(headW);
    return Math.hypot(headW.x - seat.x, headW.y - seat.y, headW.z - seat.z);
  }

  const at0 = syncLikeInput(0);
  vmod.setVehicleControls({ yaw: 1, thrust: 0, boost: false });
  for (let i = 0; i < 40; i++) vmod.stepVehicle(1 / 60);
  cock.syncCockpitToVehicle();
  const pose = vmod.getVehiclePose();
  const atYaw = syncLikeInput(pose.yaw);
  const buggy = buggyErr(pose.yaw);

  // Cabin-local seat stay: head should track seat through yaw (err ~0)
  // and buggy method should be clearly worse when head xz ≠ 0
  return {
    yawDeg: (pose.yaw * 180) / Math.PI,
    err0: at0.err,
    errYaw: atYaw.err,
    buggyErr: buggy,
    atYaw,
  };
});

const ok = !!(
  probe &&
  probe.err0 < 0.01 &&
  probe.errYaw < 0.01 &&
  probe.buggyErr > 0.05 &&
  Math.abs(probe.yawDeg) > 20
);

const report = { ok, probe, errors: errors.slice(0, 25) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
