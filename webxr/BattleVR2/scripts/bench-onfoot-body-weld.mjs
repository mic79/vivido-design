#!/usr/bin/env node
/**
 * On-foot: after FP zerog step, Mixamo body local pose must stay welded to the
 * rig (no one-frame locomotion lag / stutter).
 *
 *   node BattleVR2/scripts/bench-onfoot-body-weld.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9152);
const OUT = path.join(ROOT, 'bench-out', 'onfoot-body-weld');
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL || 'chrome',
});
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

const report = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const Phys = await import('./js/battle-phys.js');
  const THREE = window.THREE;

  // Ensure on foot
  if (window.__BATTLEVR2_BOARDED__) {
    window.__BATTLEVR2_TRY_BOARD__?.();
    await sleep(500);
  }

  const body = document.getElementById('local-body')?.object3D;
  const rig = document.getElementById('cameraRig')?.object3D;
  const hips = document.getElementById('local-body')?.components?.['mixamo-body']?.bones?.hips;
  if (!body || !rig) return { ok: false, reason: 'missing body/rig' };

  const samples = [];
  let maxRigStep = 0;
  let prevRig = null;

  for (let i = 0; i < 60; i++) {
    // Inject surge via phys so FP locomotion moves the rig
    const yaw = Phys.getPhysYaw?.() || 0;
    Phys.addPhysForce?.(
      -Math.sin(yaw) * 40,
      0,
      -Math.cos(yaw) * 40,
      1 / 60
    );
    window.__BATTLEVR2_FP_INPUT__?.(1 / 60);

    const rigP = rig.position.clone();
    if (prevRig) maxRigStep = Math.max(maxRigStep, rigP.distanceTo(prevRig));
    prevRig = rigP.clone();

    // Body is child of rig — local pose must not thrash while translating.
    samples.push({
      lx: body.position.x,
      ly: body.position.y,
      lz: body.position.z,
      qx: body.quaternion.x,
      qy: body.quaternion.y,
      qz: body.quaternion.z,
      qw: body.quaternion.w,
    });

    // Hips world relative to rig should also be stable
    if (hips) {
      const inv = new THREE.Matrix4().copy(rig.matrixWorld).invert();
      const hp = new THREE.Vector3();
      hips.updateWorldMatrix(true, false);
      hips.getWorldPosition(hp);
      hp.applyMatrix4(inv);
      samples[samples.length - 1].hx = hp.x;
      samples[samples.length - 1].hy = hp.y;
      samples[samples.length - 1].hz = hp.z;
    }
    await sleep(4);
  }

  const span = (k) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of samples) {
      if (!Number.isFinite(s[k])) continue;
      lo = Math.min(lo, s[k]);
      hi = Math.max(hi, s[k]);
    }
    return Number.isFinite(lo) ? hi - lo : 999;
  };

  const bodyLocalSpan = Math.max(span('lx'), span('ly'), span('lz'));
  const hipsLocalSpan = Math.max(span('hx'), span('hy'), span('hz'));
  // Local body may follow headset XZ slightly; allow a few cm, not locomotion-sized jumps.
  const ok =
    !window.__BATTLEVR2_BOARDED__ &&
    maxRigStep > 0.02 &&
    bodyLocalSpan < 0.08 &&
    hipsLocalSpan < 0.12;

  return {
    ok,
    boarded: !!window.__BATTLEVR2_BOARDED__,
    maxRigStep,
    bodyLocalSpan,
    hipsLocalSpan,
    n: samples.length,
  };
});

const out = { ...report, errors: errors.slice(0, 20) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
process.exit(out.ok && errors.length === 0 ? 0 : 1);
