#!/usr/bin/env node
/**
 * Match BattleVR zerog-player: moon G, damping 0.996, slope-normal contact.
 *   node BattleVR2/scripts/bench-vehicle-surface.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9141);
const OUT = path.join(ROOT, 'bench-out', 'vehicle-surface');
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
  const vmod = await import('./js/vehicle.js');
  const p0 = vmod.getVehiclePose();

  for (let i = 0; i < 120; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: 0.5, boost: false });
    vmod.stepVehicle(1 / 60);
  }
  const halfDist = Math.hypot(vmod.getVehiclePose().x - p0.x, vmod.getVehiclePose().z - p0.z);

  vmod.teleportVehicle(p0.x, p0.y, p0.z, p0.yaw);
  for (let i = 0; i < 120; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: 1, boost: false });
    vmod.stepVehicle(1 / 60);
  }
  const fullPose = vmod.getVehiclePose();
  const fullDist = Math.hypot(fullPose.x - p0.x, fullPose.z - p0.z);
  const fullSpd = fullDist / 2;

  const phys = await import('./js/battle-phys.js');
  const { sampleGroundY } = await import('./js/rts-bridge.js');
  const band = phys.FLOOR_BAND_VEHICLE;

  // 2s freefall with BattleVR damping 0.996 → ~−2.57 m/s (not floaty −1.5)
  const gy0 = sampleGroundY(p0.x, p0.z, 0);
  const seatY = (Number.isFinite(gy0) ? gy0 : p0.y) + band;
  vmod.teleportVehicle(p0.x, seatY + 30, p0.z, p0.yaw, { absoluteY: true });
  const yAir = vmod.getVehiclePose().y;
  for (let i = 0; i < 120; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: 0, boost: false });
    vmod.stepVehicle(1 / 60);
  }
  const fell = yAir - vmod.getVehiclePose().y;
  const airborneVy = vmod.getVelocity().y;

  // Continue freefall — sample peak downward speed before heightfield contact
  let terminalVy = airborneVy;
  for (let i = 0; i < 480; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: 0, boost: false });
    vmod.stepVehicle(1 / 60);
    const vy = vmod.getVelocity().y;
    if (vy < terminalVy) terminalVy = vy;
    if (!phys.isAirborne()) break;
  }

  vmod.teleportVehicle(p0.x, seatY, p0.z, p0.yaw);
  for (let i = 0; i < 120; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: 1, boost: false });
    vmod.stepVehicle(1 / 60);
  }
  const pFast = vmod.getVehiclePose();
  for (let i = 0; i < 60; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: 0, boost: false });
    vmod.stepVehicle(1 / 60);
  }
  const coastDist = Math.hypot(
    vmod.getVehiclePose().x - pFast.x,
    vmod.getVehiclePose().z - pFast.z
  );

  // Low skim clearance (not the old ~2.2 m hover sled)
  vmod.teleportVehicle(p0.x, seatY, p0.z, p0.yaw);
  for (let i = 0; i < 30; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: 0, boost: false });
    vmod.stepVehicle(1 / 60);
  }
  const skimPose = vmod.getVehiclePose();
  const gy = sampleGroundY(skimPose.x, skimPose.z, 0);
  const clearance = skimPose.y - (Number.isFinite(gy) ? gy : skimPose.y);

  // Ramp jump: crest with upward vel → airborne ballistic
  vmod.teleportVehicle(p0.x, seatY, p0.z, p0.yaw);
  const yBeforeJump = vmod.getVehiclePose().y;
  phys.addPhysImpulse(0, 6.5, 8);
  let sawAir = false;
  let peakAirY = yBeforeJump;
  for (let i = 0; i < 180; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: 0.4, boost: false });
    vmod.stepVehicle(1 / 60);
    if (phys.isAirborne()) sawAir = true;
    peakAirY = Math.max(peakAirY, vmod.getVehiclePose().y);
  }
  const airLift = peakAirY - yBeforeJump;

  // Hard land: freefall → impact + bounce (hull slam)
  vmod.teleportVehicle(p0.x, seatY + 25, p0.z, p0.yaw, { absoluteY: true });
  let peakImpact = 0;
  let bouncedUp = false;
  let minY = 1e9;
  for (let i = 0; i < 480; i++) {
    vmod.setVehicleControls({ yaw: 0, thrust: 0, boost: false });
    vmod.stepVehicle(1 / 60);
    peakImpact = Math.max(peakImpact, phys.getLastImpact());
    const vy = vmod.getVelocity().y;
    const y = vmod.getVehiclePose().y;
    minY = Math.min(minY, y);
    if (peakImpact > 2 && vy > 0.3) bouncedUp = true;
  }
  const landGy = sampleGroundY(p0.x, p0.z, 0);
  const landClearance = minY - (Number.isFinite(landGy) ? landGy : minY);

  return {
    halfDist,
    fullDist,
    fullSpd,
    fell,
    airborneVy,
    terminalVy,
    coastDist,
    clearance,
    band,
    sawAir,
    airLift,
    peakImpact,
    bouncedUp,
    landClearance,
  };
});

const ok = !!(
  probe.halfDist > 1.5 &&
  probe.fullDist > probe.halfDist * 1.2 &&
  probe.fullSpd > 3 &&
  probe.fullSpd < 20 &&
  probe.fell > 2 &&
  probe.airborneVy < -2.2 &&
  probe.airborneVy > -3.2 &&
  probe.terminalVy < -5 &&
  probe.terminalVy > -8 &&
  probe.coastDist > 1 &&
  probe.clearance < 0.7 &&
  probe.clearance > 0.2 &&
  Math.abs(probe.clearance - probe.band) < 0.2 &&
  probe.sawAir &&
  probe.airLift > 1.5 &&
  probe.peakImpact > 2.2 &&
  probe.bouncedUp &&
  probe.landClearance < 0.55
);

const report = { ok, probe, errors: errors.slice(0, 25) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
