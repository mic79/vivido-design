#!/usr/bin/env node
/**
 * After 1v1 start: assert on-foot, cockpit hidden/parked, fighter not swallowing camera.
 *   node BattleVR2/scripts/bench-fp-spawn-clear.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9128);
const OUT = path.join(ROOT, 'bench-out', 'fp-spawn-clear');
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (msg) => {
  const t = msg.type();
  if (t === 'error' || t === 'warning') errors.push(`[${t}] ${msg.text()}`);
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });

for (let i = 0; i < 90; i++) {
  if (await page.evaluate(() => !!window.__SCENE_READY__ && !!window.__BATTLEVR2_BOOT__)) break;
  await sleep(1000);
}

await page.evaluate(async () => {
  window._dismissAppStartGate?.();
  if (typeof window._startGame === 'function') await window._startGame('1v1');
});

for (let i = 0; i < 90; i++) {
  if (await page.evaluate(() => !!window.__BATTLEVR2_MATCH__)) break;
  await sleep(500);
}
await sleep(1500);

const probe = await page.evaluate(() => {
  const THREE = window.THREE;
  const rig = document.getElementById('cameraRig');
  const cam = document.getElementById('camera');
  const cock = document.getElementById('player-cockpit');
  const fight = document.getElementById('player-fighter');
  const rp = rig?.object3D?.position;
  const eye = new THREE.Vector3();
  (cam?.object3D || rig?.object3D)?.getWorldPosition(eye);

  let cockpitVisible = false;
  let cockpitY = null;
  if (cock?.object3D) {
    cockpitY = cock.object3D.position.y;
    cock.object3D.traverse((c) => {
      if (c.isMesh && c.visible) cockpitVisible = true;
    });
  }

  let fighterBox = null;
  let insideFighter = false;
  let fighterLongest = null;
  if (fight?.object3D && THREE) {
    fight.object3D.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(fight.object3D);
    const size = new THREE.Vector3();
    box.getSize(size);
    fighterLongest = Math.max(size.x, size.y, size.z);
    fighterBox = {
      min: { x: box.min.x, y: box.min.y, z: box.min.z },
      max: { x: box.max.x, y: box.max.y, z: box.max.z },
      size: { x: size.x, y: size.y, z: size.z },
    };
    // Expand slightly — eye inside hull volume is the bug.
    const padded = box.clone().expandByScalar(0.35);
    insideFighter = padded.containsPoint(eye);
  }

  const v = window.__BATTLEVR2_VEHICLE__?.getPose?.() || null;
  const fit = window.__BATTLEVR2_VEHICLE__?.getFitScale?.() ?? null;
  let distToFighter = null;
  if (v && rp) distToFighter = Math.hypot(rp.x - v.x, rp.z - v.z);

  return {
    boarded: !!window.__BATTLEVR2_BOARDED__,
    match: window.__BATTLEVR2_MATCH__,
    rig: rp ? { x: rp.x, y: rp.y, z: rp.z } : null,
    eye: { x: eye.x, y: eye.y, z: eye.z },
    cockpitVisible,
    cockpitY,
    fighterBox,
    fighterLongest,
    insideFighter,
    distToFighter,
    fitScale: fit,
    vehicle: v,
  };
});

await page.screenshot({ path: path.join(OUT, 'spawn.png'), fullPage: false });

const ok =
  !!probe.match &&
  !probe.boarded &&
  !probe.cockpitVisible &&
  (probe.cockpitY == null || probe.cockpitY < -100) &&
  !probe.insideFighter &&
  Number.isFinite(probe.fighterLongest) &&
  probe.fighterLongest < 16 &&
  Number.isFinite(probe.distToFighter) &&
  probe.distToFighter > 12;

const report = { ok, probe, errors: errors.slice(0, 40) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
server.close();
process.exit(ok ? 0 : 1);
