#!/usr/bin/env node
/**
 * Pose/state FPS matrix — the checks that should run BEFORE claiming a perf fix.
 *
 * Same page, same match: menu → look-center → look-out → no overlay → game-over.
 * Headless FPS is not Quest; use relative deltas + GPU calls/tris + CPU buckets.
 *
 *   node RTSVR4/bench-pose-states.mjs
 *
 * Env: SAMPLE_MS=2500 WARMUP_MS=800 PORT=8766
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8766);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 2500);
const WARMUP_MS = Number(process.env.WARMUP_MS || 800);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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

function startStaticServer() {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const filePath = path.normalize(path.join(ROOT, rel));
      if (!filePath.startsWith(ROOT)) {
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
  return new Promise(resolve => {
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SHOT_DIR = path.join(ROOT, 'bench-poses');

async function samplePerf(page, shotName) {
  await page.evaluate(() => {
    window.__rtsPerf.setPerfEnabled(true);
    window.__rtsPerf.resetSamples();
  });
  await sleep(SAMPLE_MS);
  if (shotName) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOT_DIR, `${shotName}.png`), fullPage: false });
  }
  return page.evaluate(() => window.__rtsPerf.snapshot());
}

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

function print(rows) {
  console.log('\n=== RTSVR4 pose/state matrix (headless relative) ===');
  console.log(
    `${'pose'.padEnd(22)} ${'fps'.padStart(7)} ${'min'.padStart(7)} ${'frameMs'.padStart(8)} ${'calls'.padStart(7)} ${'trisK'.padStart(8)} ${'skip%'.padStart(7)} ${'fogCPU'.padStart(7)} ${'unitCPU'.padStart(8)}`
  );
  for (const r of rows) {
    console.log(
      `${r.name.padEnd(22)} ${fmt(r.fps, 1).padStart(7)} ${fmt(r.fpsMin, 1).padStart(7)} ${fmt(r.frameMs, 3).padStart(8)} ${fmt(r.calls, 0).padStart(7)} ${fmt(r.tris / 1000, 1).padStart(8)} ${fmt(r.skipPct, 0).padStart(7)} ${fmt(r.fogCpu, 3).padStart(7)} ${fmt(r.unitsCpu, 3).padStart(8)}`
    );
  }
  const center = rows.find(r => r.name === 'match-look-center');
  const out = rows.find(r => r.name === 'match-look-out');
  const outNoFog = rows.find(r => r.name === 'match-look-out-nofog');
  const menu = rows.find(r => r.name === 'menu');
  const over = rows.find(r => r.name === 'gameover-idle');
  if (center && out) {
    const ratio = out.frameMs / Math.max(0.001, center.frameMs);
    const callRatio = out.calls / Math.max(0.001, center.calls);
    console.log(`\nlook-out / look-center  frameMs×${fmt(ratio, 2)}  draws×${fmt(callRatio, 2)}`);
    if (ratio > 1.25) {
      console.log('⚠ LOOK-OUT is materially slower than LOOK-CENTER — treat as a fail until explained.');
    } else {
      console.log('look-out within 25% of look-center (CPU/GPU proxy).');
    }
  }
  if (out && outNoFog) {
    console.log(
      `look-out fog overlay cost ≈ ${fmt(out.frameMs - outNoFog.frameMs, 3)} ms  draws ${fmt(out.calls - outNoFog.calls, 0)}`
    );
  }
  if (menu && over) {
    console.log(
      `gameover-idle vs menu  frameMs ${fmt(over.frameMs, 3)} vs ${fmt(menu.frameMs, 3)}  draws ${fmt(over.calls, 0)} vs ${fmt(menu.calls, 0)}`
    );
  }
}

async function main() {
  const server = await startStaticServer();
  console.log(`Serving ${ROOT} at http://127.0.0.1:${PORT}/`);
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle',
      '--ignore-gpu-blocklist',
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
    ],
  });
  const page = await browser.newPage();
  const rows = [];
  const snaps = {};

  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 180000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    });
    await sleep(WARMUP_MS);

    snaps.menu = await samplePerf(page, '01-menu');
    rows.push(row('menu', snaps.menu));
    console.log(`menu          fps=${fmt(rows[0].fps, 1)} frame=${fmt(rows[0].frameMs, 3)}ms calls=${fmt(rows[0].calls, 0)}`);

    await page.evaluate(async () => {
      if (typeof window._startGame !== 'function') throw new Error('no _startGame');
      window._startGame('1v1');
    });
    await page.waitForFunction(() => {
      const overlay = document.getElementById('match-prepare-overlay');
      return !(overlay && !overlay.hidden);
    }, null, { timeout: 180000 });
    await sleep(1000);

    await page.evaluate(async () => {
      const State = await import('./js/state.js');
      const Units = await import('./js/units.js');
      const Input = await import('./js/input.js');
      const UI = await import('./js/ui.js');
      if (!State.gameSession.gameStarted) throw new Error('game did not start');
      if (typeof UI.setMinimapVisible === 'function') UI.setMinimapVisible(true);
      const myId = State.gameSession.myPlayerId;
      const spawn = State.players[myId]?.spawn || { x: 40, z: 40 };
      const types = ['rifleman', 'lightTank', 'heavyTank', 'artillery', 'engineer', 'harvester'];
      for (let i = 0; i < 24; i++) {
        const ang = (i / 24) * Math.PI * 2;
        Units.createUnit(types[i % types.length], myId, spawn.x + Math.cos(ang) * 16, spawn.z + Math.sin(ang) * 16, {
          skipCapCheck: true,
          skipProducedStat: true,
        });
      }
      Input.positionCameraForPlayer(myId);
      window.__rtsPoseCam = Input.getCameraState();
    });
    await sleep(WARMUP_MS);

    snaps.center = await samplePerf(page, '02-look-center');
    rows.push(row('match-look-center', snaps.center));
    console.log(`look-center   fps=${fmt(rows.at(-1).fps, 1)} frame=${fmt(rows.at(-1).frameMs, 3)}ms calls=${fmt(rows.at(-1).calls, 0)} trisK=${fmt(rows.at(-1).tris / 1000, 1)}`);

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
      const cam = Input.getCameraState();
      // Face the near map edge / horizon skirts — the empty-view fill case.
      cam.rotY += Math.PI;
    });
    await sleep(400);

    snaps.out = await samplePerf(page, '03-look-out');
    rows.push(row('match-look-out', snaps.out));
    console.log(`look-out      fps=${fmt(rows.at(-1).fps, 1)} frame=${fmt(rows.at(-1).frameMs, 3)}ms calls=${fmt(rows.at(-1).calls, 0)} trisK=${fmt(rows.at(-1).tris / 1000, 1)}`);

    await page.evaluate(() => {
      window.__rtsPerf.setAblation({ fogOverlay: false });
    });
    await sleep(200);

    snaps.outNoFog = await samplePerf(page, '04-look-out-nofog');
    rows.push(row('match-look-out-nofog', snaps.outNoFog));
    console.log(`look-out-nofog fps=${fmt(rows.at(-1).fps, 1)} frame=${fmt(rows.at(-1).frameMs, 3)}ms calls=${fmt(rows.at(-1).calls, 0)}`);

    await page.evaluate(() => {
      window.__rtsPerf.setAblation({ fogOverlay: true });
    });
    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
    });
    await sleep(200);

    snaps.center2 = await samplePerf(page, '05-look-center-2');
    rows.push(row('match-look-center-2', snaps.center2));

    await page.evaluate(async () => {
      const State = await import('./js/state.js');
      State.gameSession.gameOver = true;
      State.gameSession.winner = 0;
    });
    await sleep(400);

    snaps.overIdle = await samplePerf(page, '06-gameover-idle');
    rows.push(row('gameover-idle', snaps.overIdle));
    console.log(`gameover-idle fps=${fmt(rows.at(-1).fps, 1)} frame=${fmt(rows.at(-1).frameMs, 3)}ms calls=${fmt(rows.at(-1).calls, 0)}`);

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      const cam = Input.getCameraState();
      const t0 = performance.now();
      window.__rtsOrbit = setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        cam.rotY += 0.35 * (1 / 60);
        cam.y = 28 + Math.sin(t * 0.7) * 10;
      }, 16);
    });
    snaps.overMove = await samplePerf(page, '07-gameover-orbit');
    rows.push(row('gameover-orbit', snaps.overMove));
    console.log(`gameover-orbit fps=${fmt(rows.at(-1).fps, 1)} frame=${fmt(rows.at(-1).frameMs, 3)}ms calls=${fmt(rows.at(-1).calls, 0)}`);
    await page.evaluate(() => {
      if (window.__rtsOrbit) clearInterval(window.__rtsOrbit);
    });
  } finally {
    await browser.close();
    server.close();
  }

  print(rows);
  const outPath = path.join(ROOT, 'bench-pose-states.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify({ when: new Date().toISOString(), sampleMs: SAMPLE_MS, rows, snaps }, null, 2)
  );
  console.log(`\nWrote ${outPath}`);

  const center = rows.find(r => r.name === 'match-look-center');
  const out = rows.find(r => r.name === 'match-look-out');
  if (center && out && out.frameMs > center.frameMs * 1.35) {
    process.exitCode = 2;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
