#!/usr/bin/env node
/**
 * Fixed poses: base / midfield / look-army / cockpit — draws + tris.
 *   node BattleVR2/scripts/bench-pose-views.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9124);
const OUT = path.join(ROOT, 'bench-out', 'pose-views');
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

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
  await sleep(1000);
}
await sleep(2000);

const poses = [
  { id: 'base', apply: () => {} },
  {
    id: 'midfield',
    apply: async () => {
      await page.evaluate(() => {
        const rig = document.getElementById('cameraRig');
        if (rig) rig.object3D.position.set(0, 8, 0);
      });
    },
  },
  {
    id: 'look-army',
    apply: async () => {
      await page.evaluate(() => {
        const dbg = window.__BATTLEVR2_DEBUG__?.();
        const rig = document.getElementById('cameraRig');
        if (rig) {
          rig.object3D.position.set(dbg?.vehicle?.x || 20, 12, dbg?.vehicle?.z || 20);
          rig.object3D.rotation.set(-0.6, 0.8, 0);
        }
      });
    },
  },
  {
    id: 'in-cockpit',
    apply: async () => {
      await page.evaluate(() => {
        window.__BATTLEVR2_TRY_BOARD__?.();
      });
      await sleep(500);
    },
  },
];

const rows = [];
for (const pose of poses) {
  await pose.apply();
  await sleep(800);
  const row = await page.evaluate((id) => {
    const sc = document.querySelector('a-scene');
    const r = sc?.renderer;
    const info = r?.info?.render;
    return {
      id,
      draws: info?.calls ?? null,
      tris: info?.triangles ?? null,
      dbg: window.__BATTLEVR2_DEBUG__?.() || null,
    };
  }, pose.id);
  await page.screenshot({ path: path.join(OUT, `${pose.id}.png`) });
  rows.push(row);
  console.log(pose.id, row.draws, row.tris);
}

const report = {
  ok: rows.every((r) => r.draws != null && r.draws > 0),
  rows,
  budgets: {
    note: 'PCVR soft budgets — revisit after LOD/Draco (Phase 2)',
    maxDrawsSpawn: 2000,
    maxTrisSpawn: 8_000_000,
  },
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
server.close();
process.exit(report.ok ? 0 : 1);
