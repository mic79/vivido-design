#!/usr/bin/env node
/**
 * Boarded fly: Mixamo body local pose must stay welded to the seat (like cockpit).
 *   node BattleVR2/scripts/bench-body-seat-lock.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9137);
const OUT = path.join(ROOT, 'bench-out', 'body-seat-lock');
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

const report = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__BATTLEVR2_ENTER_VEHICLE__?.();
  await sleep(100);
  window.__BATTLEVR2_FP_INPUT__?.(1 / 60);

  const bodyEl = document.querySelector('[mixamo-body]:not([data-mirror])')
    || document.getElementById('local-body')
    || document.querySelector('[mixamo-body]');
  const body = bodyEl?.object3D;
  const bodyComp = bodyEl?.components?.['mixamo-body'];
  const cock = document.getElementById('player-cockpit')?.object3D;
  if (!body || !cock) {
    return { ok: false, reason: 'missing body/cockpit', boarded: !!window.__BATTLEVR2_BOARDED__ };
  }

  const samples = [];
  // Fly: thrust + yaw for ~1.5s while sampling body LOCAL pose (seat frame).
  for (let i = 0; i < 90; i++) {
    window.__BATTLEVR2_FORCE_VEHICLE_STEP__ = true;
    window.__BATTLEVR2_DESKTOP_VEHICLE__ = {
      yaw: i % 30 < 15 ? 1 : -1,
      thrust: 1,
      strafe: 0,
      yawDelta: 0.04,
      boost: false,
    };
    window.__BATTLEVR2_FP_INPUT__?.(1 / 60);
    body.updateMatrixWorld(true);
    samples.push({
      lx: body.position.x,
      ly: body.position.y,
      lz: body.position.z,
      qx: body.quaternion.x,
      qy: body.quaternion.y,
      qz: body.quaternion.z,
      qw: body.quaternion.w,
      headFacingLen: bodyComp?._headFacingQuat
        ? Math.hypot(
          bodyComp._headFacingQuat.x,
          bodyComp._headFacingQuat.y,
          bodyComp._headFacingQuat.z
        )
        : null,
      zeroGBlend: bodyComp?._zeroGLegModeBlend ?? null,
    });
    await sleep(16);
  }
  window.__BATTLEVR2_FORCE_VEHICLE_STEP__ = false;

  const span = (key) => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of samples) {
      min = Math.min(min, s[key]);
      max = Math.max(max, s[key]);
    }
    return max - min;
  };

  const maxQuatImag = Math.max(
    ...samples.map((s) => Math.hypot(s.qx, s.qy, s.qz))
  );
  const maxHeadFacing = Math.max(
    ...samples.map((s) => s.headFacingLen ?? 0)
  );
  const maxZeroG = Math.max(...samples.map((s) => s.zeroGBlend ?? 0));

  const dx = span('lx');
  const dy = span('ly');
  const dz = span('lz');

  // Local pose must stay welded: tiny numeric noise only.
  const ok = !!(
    window.__BATTLEVR2_BOARDED__ &&
    dx < 0.002 &&
    dy < 0.002 &&
    dz < 0.002 &&
    maxQuatImag < 0.002 &&
    maxHeadFacing < 0.002 &&
    maxZeroG < 0.05
  );

  return {
    ok,
    boarded: !!window.__BATTLEVR2_BOARDED__,
    version: window.__BATTLEVR2_VERSION__ || null,
    spans: { dx, dy, dz },
    maxQuatImag,
    maxHeadFacing,
    maxZeroG,
    sample0: samples[0],
    sampleN: samples[samples.length - 1],
    n: samples.length,
  };
});

await page.screenshot({ path: path.join(OUT, 'fly-seat.png'), fullPage: false });
const out = { ...report, errors: errors.slice(0, 20) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
process.exit(out.ok ? 0 : 1);
