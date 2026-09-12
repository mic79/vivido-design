#!/usr/bin/env node
/**
 * Headless Story pose matrix: RTSVR4 vs RTSVR5 (same machine, same seed, same poses).
 *
 *   node RTSVR5/scripts/bench-story-v4-v5.mjs
 *
 * Env: SAMPLE_MS=2500 WARMUP_MS=800 STORY_SEED=42 PORT4=8774 PORT5=8775
 *
 * Headless FPS is not Quest — use relative deltas + calls/tris.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBXR = path.resolve(__dirname, '..', '..');
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 2500);
const WARMUP_MS = Number(process.env.WARMUP_MS || 800);
const STORY_SEED = Number(process.env.STORY_SEED || 42) >>> 0;
const PORT4 = Number(process.env.PORT4 || 8774);
const PORT5 = Number(process.env.PORT5 || 8775);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function startStaticServer(root, port) {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const filePath = path.normalize(path.join(root, rel));
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmt(n, d = 2) {
  return (Number(n) || 0).toFixed(d);
}

function row(name, snap) {
  const gpu = snap.gpu || {};
  return {
    name,
    fps: snap.fpsAvg ?? snap.fps ?? 0,
    fpsMin: snap.fpsMin ?? 0,
    frameMs: snap.avgMs?.frame || 0,
    fogCpu: snap.avgMs?.['render.fogOverlay'] || 0,
    unitsCpu: snap.avgMs?.['render.units'] || 0,
    calls: gpu.callsAvg || 0,
    tris: gpu.trisAvg || 0,
    skipPct: gpu.skipPct || 0,
  };
}

async function samplePerf(page) {
  await page.evaluate(() => {
    window.__rtsPerf.setPerfEnabled(true);
    window.__rtsPerf.resetSamples();
  });
  await sleep(SAMPLE_MS);
  return page.evaluate(() => window.__rtsPerf.snapshot());
}

async function collectTerrainFacts(page) {
  return page.evaluate(async () => {
    const Config = await import('./js/config.js');
    const groundEl = document.getElementById('ground');
    const mesh = groundEl && groundEl.getObject3D && groundEl.getObject3D('mesh');
    let plateTris = 0;
    let skirtTris = 0;
    let meshes = 0;
    let materials = new Set();
    let matKinds = {};
    let hasTriplanar = 0;
    let hasProps = false;
    if (mesh) {
      mesh.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        meshes++;
        const idx = o.geometry.index;
        const pos = o.geometry.attributes?.position;
        const t = idx ? idx.count / 3 : pos ? pos.count / 3 : 0;
        const n = (o.name || '') + (o.parent && o.parent.name ? o.parent.name : '');
        if (/skirt/i.test(n) || /skirt/i.test(o.parent?.name || '')) skirtTris += t;
        else plateTris += t;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          const k = m.type || m.constructor?.name || '?';
          materials.add(k);
          matKinds[k] = (matKinds[k] || 0) + 1;
          if (m.userData?.rtsTriplanar || /triplanar/i.test(m.userData?.shaderId || '')) hasTriplanar++;
          if (m.userData?.cheapMoonLook) matKinds.cheapMoon = (matKinds.cheapMoon || 0) + 1;
        }
      });
    }
    const props = groundEl && groundEl.getObject3D && groundEl.getObject3D('overviewProps');
    hasProps = !!props;
    let unitCount = 0;
    let buildingCount = 0;
    try {
      const State = await import('./js/state.js');
      unitCount = (State.units || []).length;
      buildingCount = (State.buildings || []).length;
    } catch (_) {}
    return {
      mapProfile: Config.MAP_PROFILE,
      mapSize: Config.MAP_SIZE,
      terrainStyle: Config.MAP_TERRAIN_STYLE,
      fogGrid: Config.FOG_GRID_SIZE,
      navScale: Config.MAP_NAV_AREA_SCALE,
      storySeed: (await import('./js/state.js')).gameSession?.storySeed ?? null,
      plateTris: Math.round(plateTris),
      skirtTris: Math.round(skirtTris),
      terrainMeshes: meshes,
      matKinds,
      hasTriplanar,
      hasProps,
      unitCount,
      buildingCount,
      bake: !!(mesh && mesh.userData && mesh.userData.rtsSkirmishBake),
      kit: !!(mesh && mesh.userData && mesh.userData.rtsStoryKit),
    };
  });
}

async function benchProject(label, root, port, browser) {
  const server = await startStaticServer(root, port);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const result = { label, root, port, rows: [], terrain: null, error: null };
  try {
    const url = `http://127.0.0.1:${port}/index.html?perf=1&storySeed=${STORY_SEED}`;
    console.log(`\n=== ${label} ${url} ===`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 180000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    });
    await sleep(WARMUP_MS);

    const menuSnap = await samplePerf(page);
    result.rows.push(row('menu', menuSnap));
    console.log(
      `${label} menu fps=${fmt(result.rows.at(-1).fps, 1)} frame=${fmt(result.rows.at(-1).frameMs, 3)} calls=${fmt(result.rows.at(-1).calls, 0)}`
    );

    await page.evaluate(async () => {
      if (typeof window._startGame !== 'function') throw new Error('no _startGame');
      window._startGame('story');
    });
    await page.waitForFunction(() => {
      const overlay = document.getElementById('match-prepare-overlay');
      return !(overlay && !overlay.hidden);
    }, null, { timeout: 300000 });
    await sleep(1500);

    result.terrain = await collectTerrainFacts(page);
    console.log(`${label} terrain`, JSON.stringify(result.terrain));

    await page.evaluate(async () => {
      const State = await import('./js/state.js');
      const Input = await import('./js/input.js');
      const UI = await import('./js/ui.js');
      if (!State.gameSession.gameStarted) throw new Error('story did not start');
      if (typeof UI.setMinimapVisible === 'function') UI.setMinimapVisible(true);
      Input.positionCameraForPlayer(State.gameSession.myPlayerId);
    });
    await sleep(WARMUP_MS);

    const center = await samplePerf(page);
    result.rows.push(row('match-look-center', center));
    console.log(
      `${label} look-center fps=${fmt(result.rows.at(-1).fps, 1)} frame=${fmt(result.rows.at(-1).frameMs, 3)} calls=${fmt(result.rows.at(-1).calls, 0)} trisK=${fmt(result.rows.at(-1).tris / 1000, 1)}`
    );

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
      const cam = Input.getCameraState();
      cam.rotY += Math.PI;
    });
    await sleep(400);

    const out = await samplePerf(page);
    result.rows.push(row('match-look-out', out));
    console.log(
      `${label} look-out fps=${fmt(result.rows.at(-1).fps, 1)} frame=${fmt(result.rows.at(-1).frameMs, 3)} calls=${fmt(result.rows.at(-1).calls, 0)} trisK=${fmt(result.rows.at(-1).tris / 1000, 1)}`
    );

    await page.evaluate(() => {
      window.__rtsPerf.setAblation({ fogOverlay: false });
    });
    await sleep(200);
    const outNoFog = await samplePerf(page);
    result.rows.push(row('match-look-out-nofog', outNoFog));
    console.log(
      `${label} look-out-nofog fps=${fmt(result.rows.at(-1).fps, 1)} frame=${fmt(result.rows.at(-1).frameMs, 3)} calls=${fmt(result.rows.at(-1).calls, 0)}`
    );

    await page.evaluate(() => {
      window.__rtsPerf.setAblation({ fogOverlay: true });
    });
  } catch (err) {
    result.error = String(err && err.stack ? err.stack : err);
    console.error(label, 'FAIL', result.error);
  } finally {
    await page.close();
    server.close();
  }
  return result;
}

function printCompare(a, b) {
  console.log('\n========== STORY COMPARE (headless, relative) ==========');
  console.log(`seed=${STORY_SEED} sampleMs=${SAMPLE_MS}`);
  const poses = ['menu', 'match-look-center', 'match-look-out', 'match-look-out-nofog'];
  console.log(
    `${'pose'.padEnd(24)} ${'v4fps'.padStart(7)} ${'v5fps'.padStart(7)} ${'v4ms'.padStart(7)} ${'v5ms'.padStart(7)} ${'v4calls'.padStart(8)} ${'v5calls'.padStart(8)} ${'v4trisK'.padStart(8)} ${'v5trisK'.padStart(8)}`
  );
  for (const p of poses) {
    const r4 = a.rows.find((r) => r.name === p) || {};
    const r5 = b.rows.find((r) => r.name === p) || {};
    console.log(
      `${p.padEnd(24)} ${fmt(r4.fps, 1).padStart(7)} ${fmt(r5.fps, 1).padStart(7)} ${fmt(r4.frameMs, 2).padStart(7)} ${fmt(r5.frameMs, 2).padStart(7)} ${fmt(r4.calls, 0).padStart(8)} ${fmt(r5.calls, 0).padStart(8)} ${fmt((r4.tris || 0) / 1000, 1).padStart(8)} ${fmt((r5.tris || 0) / 1000, 1).padStart(8)}`
    );
  }
  console.log('\n--- terrain facts ---');
  console.log('RTSVR4', JSON.stringify(a.terrain, null, 2));
  console.log('RTSVR5', JSON.stringify(b.terrain, null, 2));
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--ignore-gpu-blocklist',
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
    ],
  });
  const v4 = await benchProject('RTSVR4', path.join(WEBXR, 'RTSVR4'), PORT4, browser);
  const v5 = await benchProject('RTSVR5', path.join(WEBXR, 'RTSVR5'), PORT5, browser);
  await browser.close();

  printCompare(v4, v5);
  const outPath = path.join(WEBXR, 'RTSVR5', 'bench-story-v4-v5.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        when: new Date().toISOString(),
        sampleMs: SAMPLE_MS,
        storySeed: STORY_SEED,
        note: 'Headless Chromium FPS is not Quest; use relative deltas + calls/tris.',
        RTSVR4: v4,
        RTSVR5: v5,
      },
      null,
      2
    )
  );
  console.log(`\nWrote ${outPath}`);
  if (v4.error || v5.error) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
