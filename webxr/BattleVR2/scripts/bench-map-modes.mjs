#!/usr/bin/env node
/**
 * Perf matrix: map (Hera / Canyon) × mode (1v1 / 2v2).
 * Headless Playwright — record draws/tris + __rtsPerf CPU sections (not Quest FPS).
 *
 *   node BattleVR2/scripts/bench-map-modes.mjs
 *   PORT=9130 SAMPLE_MS=4000 node BattleVR2/scripts/bench-map-modes.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9130);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 4000);
const OUT = path.join(ROOT, 'bench-out', 'map-modes');
fs.mkdirSync(OUT, { recursive: true });

const MAPS = [
  { id: 'hera', query: 'map=hera' },
  { id: 'canyon', query: 'map=canyon' },
];
const MODES = ['1v1', '2v2'];

const POSES = [
  {
    id: 'spawn',
    apply: async () => {},
  },
  {
    id: 'midfield',
    apply: async (page) => {
      await page.evaluate(() => {
        const rig = document.getElementById('cameraRig');
        if (rig?.object3D) rig.object3D.position.set(0, 40, 0);
      });
    },
  },
  {
    id: 'look-army',
    apply: async (page) => {
      await page.evaluate(() => {
        const dbg = window.__BATTLEVR2_DEBUG__?.();
        const rig = document.getElementById('cameraRig');
        if (!rig?.object3D) return;
        const x = dbg?.vehicle?.x ?? 40;
        const z = dbg?.vehicle?.z ?? 40;
        // Canyon floor sits ~y=100; Hera near 0 — use debug elapsed + a high eye.
        rig.object3D.position.set(x, 55, z + 35);
        rig.object3D.rotation.set(-0.45, 0.2, 0);
      });
    },
  },
];

async function waitReady(page, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await page.evaluate(
      () => !!(window.__SCENE_READY__ && window.__BATTLEVR2_BOOT__ && window.__rtsReady)
    );
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

async function waitMatch(page, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const snap = await page.evaluate(() => {
      const m = window.__BATTLEVR2_MATCH__;
      const gs = window.__BATTLEVR2_DEBUG__?.();
      return {
        match: !!m,
        units: gs?.units ?? m?.units ?? 0,
        draws: gs?.draws ?? null,
        mapBtn: document.getElementById('btn-skirmish-map')?.textContent || '',
      };
    });
    if (snap.match && snap.units > 0) return snap;
    await sleep(750);
  }
  return null;
}

async function samplePose(page, poseId) {
  // Warm a few frames then sample GPU + reset perf window.
  await page.evaluate(() => {
    const sc = document.querySelector('a-scene');
    const r = sc?.renderer;
    if (r?.info) {
      r.info.reset();
      r.render(sc.object3D, sc.camera);
    }
    window.__rtsPerf?.resetSamples?.();
  });
  await sleep(SAMPLE_MS);
  return page.evaluate((id) => {
    const sc = document.querySelector('a-scene');
    const r = sc?.renderer;
    const info = r?.info?.render;
    const dbg = window.__BATTLEVR2_DEBUG__?.() || null;
    const perf = window.__rtsPerf?.snapshot?.() || null;
    const ground = document.getElementById('ground')?.getObject3D?.('mesh');
    let canyon = !!(ground && ground.userData && ground.userData.rtsCanyonMap);
    let mesa = !!(ground && ground.userData && ground.userData.rtsMesaHeightfield);
    let herablend = 0;
    if (ground) {
      ground.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m?.userData?._canyonHerablend) herablend++;
        }
      });
    }
    return {
      pose: id,
      draws: info?.calls ?? dbg?.draws ?? null,
      tris: info?.triangles ?? dbg?.tris ?? null,
      units: dbg?.units ?? null,
      buildings: dbg?.buildings ?? null,
      bots: dbg?.bots ?? null,
      moving: dbg?.moving ?? null,
      elapsed: dbg?.elapsed ?? null,
      canyon,
      mesa,
      herablend,
      fps: perf?.fps ?? null,
      fpsMin: perf?.fpsMin ?? null,
      gpuCallsAvg: perf?.gpu?.callsAvg ?? null,
      gpuTrisAvg: perf?.gpu?.trisAvg ?? null,
      cpu: perf
        ? {
            frame: +(perf.avgMs?.frame || 0).toFixed(2),
            sim: +(perf.avgMs?.sim || 0).toFixed(2),
            bot: +(perf.avgMs?.bot || 0).toFixed(2),
            path: +(perf.avgMs?.path || 0).toFixed(2),
            render: +(perf.avgMs?.render || 0).toFixed(2),
          }
        : null,
    };
  }, poseId);
}

const server = await startStaticServer(ROOT, PORT);
// Prefer system Chrome when sandbox Playwright browser cache is empty.
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL || 'chrome',
});
const results = [];
const errors = [];

for (const map of MAPS) {
  for (const mode of MODES) {
    const label = `${map.id}_${mode}`;
    console.log(`\n=== ${label} ===`);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (e) => errors.push({ label, err: String(e.message || e) }));
    const url = `http://127.0.0.1:${PORT}/?perf=1&${map.query}`;
    const row = {
      map: map.id,
      mode,
      url,
      bootMs: null,
      matchMs: null,
      poses: [],
      ok: false,
      error: null,
    };
    const tBoot = Date.now();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
      const ready = await waitReady(page, map.id === 'canyon' ? 240000 : 120000);
      if (!ready) throw new Error('scene not ready');
      row.bootMs = Date.now() - tBoot;

      const tMatch = Date.now();
      await page.evaluate(async (m) => {
        window._dismissAppStartGate?.();
        if (typeof window._startGame === 'function') await window._startGame(m);
      }, mode);
      const matchSnap = await waitMatch(page, map.id === 'canyon' ? 300000 : 180000);
      if (!matchSnap) throw new Error('match did not start');
      row.matchMs = Date.now() - tMatch;
      // Let herablend / fog settle.
      await sleep(map.id === 'canyon' ? 5000 : 2000);

      for (const pose of POSES) {
        await pose.apply(page);
        await sleep(600);
        const sample = await samplePose(page, pose.id);
        row.poses.push(sample);
        console.log(
          `  ${pose.id}: d=${sample.draws} t=${sample.tris} fps=${
            sample.fps != null ? sample.fps.toFixed(1) : '?'
          } cpu.frame=${sample.cpu?.frame ?? '?'}`
        );
        await page.screenshot({
          path: path.join(OUT, `${label}_${pose.id}.png`),
          type: 'png',
        });
      }
      row.ok = row.poses.every((p) => p.draws != null && p.draws > 0);
    } catch (err) {
      row.error = String(err?.message || err);
      row.ok = false;
      console.error(`  FAIL ${label}:`, row.error);
      try {
        await page.screenshot({ path: path.join(OUT, `${label}_FAIL.png`) });
      } catch (_) {
        /* */
      }
    }
    results.push(row);
    await page.close();
  }
}

const summary = results.map((r) => {
  const spawn = r.poses.find((p) => p.pose === 'spawn');
  const mid = r.poses.find((p) => p.pose === 'midfield');
  const army = r.poses.find((p) => p.pose === 'look-army');
  return {
    map: r.map,
    mode: r.mode,
    ok: r.ok,
    bootMs: r.bootMs,
    matchMs: r.matchMs,
    spawn: spawn
      ? { draws: spawn.draws, tris: spawn.tris, fps: spawn.fps, cpu: spawn.cpu }
      : null,
    midfield: mid
      ? { draws: mid.draws, tris: mid.tris, fps: mid.fps, cpu: mid.cpu }
      : null,
    lookArmy: army
      ? { draws: army.draws, tris: army.tris, fps: army.fps, cpu: army.cpu }
      : null,
    terrain: spawn
      ? { canyon: spawn.canyon, mesa: spawn.mesa, herablend: spawn.herablend }
      : null,
    error: r.error,
  };
});

const report = {
  when: new Date().toISOString(),
  sampleMs: SAMPLE_MS,
  note:
    'Headless Chromium — use draws/tris/CPU section deltas across maps; FPS is relative only (not Quest).',
  summary,
  results,
  errors: errors.slice(0, 40),
  ok: results.every((r) => r.ok),
};

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

// Compact markdown table for quick reading
const lines = [
  '# BattleVR2 map × mode bench',
  '',
  `Sample window ${SAMPLE_MS}ms · ${report.when}`,
  '',
  '| Map | Mode | Spawn d/t | Mid d/t | Army d/t | Spawn FPS | CPU frame ms | Boot/Match s |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
];
for (const s of summary) {
  const fmt = (p) =>
    p && p.draws != null
      ? `${p.draws}/${p.tris != null ? Math.round(p.tris / 1000) + 'k' : '?'}`
      : '—';
  lines.push(
    `| ${s.map} | ${s.mode} | ${fmt(s.spawn)} | ${fmt(s.midfield)} | ${fmt(s.lookArmy)} | ${
      s.spawn?.fps != null ? s.spawn.fps.toFixed(1) : '—'
    } | ${s.spawn?.cpu?.frame ?? '—'} | ${
      s.bootMs != null ? (s.bootMs / 1000).toFixed(1) : '?'
    }/${s.matchMs != null ? (s.matchMs / 1000).toFixed(1) : '?'} |`
  );
}
fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), lines.join('\n') + '\n');
console.log('\n' + lines.join('\n'));
console.log('\nWrote', path.join(OUT, 'report.json'));

await browser.close();
server.close();
process.exit(report.ok ? 0 : 1);
