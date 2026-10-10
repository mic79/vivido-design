#!/usr/bin/env node
/**
 * Right-stick board must ENTER the seat — not teleport beside then instantly exit
 * (Quest double-fires thumbstickdown + gamepad click).
 *
 *   node BattleVR2/scripts/bench-board-debounce.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9151);
const OUT = path.join(ROOT, 'bench-out', 'board-debounce');
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL || 'chrome',
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
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

const report = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const Vehicle = await import('./js/vehicle.js');
  const Cockpit = await import('./js/cockpit.js');

  // Start on foot near fighter
  const v0 = Vehicle.getVehiclePose();
  // Place player ~6m away so the "pull near" path runs
  const Box3D = await import('./js/box3d-world.js');
  Box3D.spawnPlayerAt?.(v0.x + 6, v0.y + 2, v0.z + 6);
  await sleep(30);
  window.__BATTLEVR2_FP_INPUT__?.(1 / 60);

  const before = {
    boarded: !!window.__BATTLEVR2_BOARDED__,
    cockpit: !!Cockpit.isCockpitActive?.(),
  };

  // Simulate Quest double-fire: three board requests in one burst
  window.__BATTLEVR2_TRY_BOARD__?.();
  window.__BATTLEVR2_TRY_BOARD__?.();
  window.__BATTLEVR2_TRY_BOARD__?.();
  await sleep(20);
  window.__BATTLEVR2_FP_INPUT__?.(1 / 60);

  const seat = Cockpit.getSeatWorldPosition?.();
  const rig = document.getElementById('cameraRig')?.object3D?.position;
  const seatDist = seat && rig
    ? Math.hypot(rig.x - seat.x, rig.z - seat.z)
    : 999;

  const afterBurst = {
    boarded: !!window.__BATTLEVR2_BOARDED__,
    cockpit: !!Cockpit.isCockpitActive?.(),
    seatDist,
    seat,
    rig: rig ? { x: rig.x, y: rig.y, z: rig.z } : null,
  };

  // After cooldown, one more toggle should EXIT beside
  await sleep(500);
  window.__BATTLEVR2_TRY_BOARD__?.();
  window.__BATTLEVR2_FP_INPUT__?.(1 / 60);
  const afterExit = {
    boarded: !!window.__BATTLEVR2_BOARDED__,
    cockpit: !!Cockpit.isCockpitActive?.(),
  };

  // Re-board with force and confirm seat
  await sleep(500);
  window.__BATTLEVR2_FORCE_BOARD__?.();
  window.__BATTLEVR2_FP_INPUT__?.(1 / 60);
  const seat2 = Cockpit.getSeatWorldPosition?.();
  const rig2 = document.getElementById('cameraRig')?.object3D?.position;
  const seatDist2 = seat2 && rig2
    ? Math.hypot(rig2.x - seat2.x, (rig2.y || 0) - (seat2.y || 0), rig2.z - seat2.z)
    : 999;

  const boardedOk =
    !before.boarded &&
    afterBurst.boarded &&
    afterBurst.cockpit &&
    afterBurst.seatDist < 0.35 &&
    !afterExit.boarded &&
    !!window.__BATTLEVR2_BOARDED__ &&
    seatDist2 < 0.5;

  // On-foot body same-frame weld: thrust, measure hips vs feet/rig
  window.__BATTLEVR2_TRY_BOARD__?.(); // exit if boarded
  await sleep(500);
  if (window.__BATTLEVR2_BOARDED__) {
    window.__BATTLEVR2_TRY_BOARD__?.();
    await sleep(20);
  }
  const mb = document.getElementById('local-body')?.components?.['mixamo-body'];
  const hipsLocalSpan = { dx: 0, dy: 0, dz: 0 };
  const samples = [];
  for (let i = 0; i < 45; i++) {
    window.__BATTLEVR2_DESKTOP_VEHICLE__ = null;
    // Fake WASD via keys is hard — call step through FP with surge by temporarily setting sticks
    window.__BATTLEVR2_FP_INPUT__?.(1 / 60);
    // Nudge phys by board-exit pose + manual sync already happened; use FORCE via evaluate of Zerog
    const body = document.getElementById('local-body')?.object3D;
    if (body) samples.push({ x: body.position.x, y: body.position.y, z: body.position.z });
  }
  if (samples.length > 1) {
    for (const k of ['x', 'y', 'z']) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const s of samples) {
        lo = Math.min(lo, s[k]);
        hi = Math.max(hi, s[k]);
      }
      hipsLocalSpan[`d${k}`] = hi - lo;
    }
  }

  return {
    ok: boardedOk,
    before,
    afterBurst,
    afterExit,
    reboardSeatDist: seatDist2,
    boardedFinal: !!window.__BATTLEVR2_BOARDED__,
    hipsLocalSpan,
  };
});

const out = { ...report, errors: errors.slice(0, 20) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
process.exit(out.ok && errors.length === 0 ? 0 : 1);
