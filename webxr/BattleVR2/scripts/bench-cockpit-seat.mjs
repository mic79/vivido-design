#!/usr/bin/env node
/**
 * After board: cabin size sane, seat eye inside bbox (not floating above).
 *   node BattleVR2/scripts/bench-cockpit-seat.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9130);
const OUT = path.join(ROOT, 'bench-out', 'cockpit-seat');
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

const probe = await page.evaluate(() => {
  const THREE = window.THREE;
  window.__BATTLEVR2_ENTER_VEHICLE__?.();
  // Let FP/cockpit sync one tick
  window.__BATTLEVR2_FP_INPUT__?.(1 / 60);

  const cock = window.__BATTLEVR2_COCKPIT__;
  const cabin = cock?.getCabinSize?.() || null;
  const seatLocal = cock?.getSeatLocal?.() || null;
  const seat = cock?.getSeatWorldPosition?.() || null;
  const root = document.getElementById('player-cockpit');
  let box = null;
  let seatInside = false;
  let eyeAboveRoof = false;
  if (root?.object3D && seat) {
    root.object3D.updateWorldMatrix(true, true);
    const b = new THREE.Box3().setFromObject(root.object3D);
    const size = new THREE.Vector3();
    b.getSize(size);
    box = {
      min: { x: b.min.x, y: b.min.y, z: b.min.z },
      max: { x: b.max.x, y: b.max.y, z: b.max.z },
      size: { x: size.x, y: size.y, z: size.z },
    };
    const eye = new THREE.Vector3(seat.x, seat.y, seat.z);
    const padded = b.clone().expandByScalar(0.05);
    seatInside = padded.containsPoint(eye);
    eyeAboveRoof = seat.y > b.max.y + 0.05;
  }
  const rig = document.getElementById('cameraRig')?.object3D?.position;
  return {
    boarded: !!window.__BATTLEVR2_BOARDED__,
    cabin,
    seatLocal,
    seat,
    box,
    seatInside,
    eyeAboveRoof,
    rig: rig ? { x: rig.x, y: rig.y, z: rig.z } : null,
  };
});

await page.screenshot({ path: path.join(OUT, 'seated.png') });

const ok = !!(
  probe.boarded &&
  probe.cabin &&
  probe.cabin.y >= 1.5 &&
  probe.cabin.y <= 2.4 &&
  Math.max(probe.cabin.x, probe.cabin.z) >= 2.2 &&
  probe.seatInside &&
  !probe.eyeAboveRoof &&
  probe.seatLocal &&
  probe.seatLocal.y < probe.cabin.y * 0.75
);

const report = { ok, probe, errors: errors.slice(0, 20) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
