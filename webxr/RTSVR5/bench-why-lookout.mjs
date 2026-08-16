#!/usr/bin/env node
/**
 * Proof dump only — does not change the game.
 * Samples __rtsSkipRender + Three draw/tri for still poses.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8767);
const SAMPLE_MS = 2000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'application/json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sample(page, name) {
  const t0 = Date.now();
  const rows = [];
  while (Date.now() - t0 < SAMPLE_MS) {
    rows.push(
      await page.evaluate(() => {
        const sc = document.querySelector('a-scene');
        const r = sc && sc.renderer;
        const info = r && r.info && r.info.render;
        const fogU = sc && sc.object3D && sc.object3D.getObjectByName('rts-world-fog-unexplored');
        const fogV = sc && sc.object3D && sc.object3D.getObjectByName('rts-world-fog-overlay');
        const ground = sc && sc.object3D && sc.object3D.getObjectByName('rts-ground-mesh');
        const skirt = sc && sc.object3D && sc.object3D.getObjectByName('rts-horizon-skirt');
        let skirtVis = 0;
        if (skirt) {
          skirt.traverse((o) => {
            if (o.isMesh && o.visible) skirtVis++;
          });
        }
        return {
          skip: !!(sc && sc.__rtsSkipRender),
          calls: info ? info.calls | 0 : -1,
          tris: info ? info.triangles | 0 : -1,
          fogUnex: !!(fogU && fogU.visible),
          fogVeil: !!(fogV && fogV.visible),
          groundVis: !!(ground && ground.visible),
          groundRecvShadow: !!(ground && ground.receiveShadow),
          skirtMeshes: skirtVis,
          camKey: window.__rtsCamSkipKey || '',
        };
      })
    );
    await sleep(50);
  }
  const n = rows.length || 1;
  const skipN = rows.filter((x) => x.skip).length;
  const last = rows[rows.length - 1] || {};
  const callsAvg = rows.reduce((a, x) => a + Math.max(0, x.calls), 0) / n;
  const trisAvg = rows.reduce((a, x) => a + Math.max(0, x.tris), 0) / n;
  const uniqueKeys = new Set(rows.map((x) => x.camKey)).size;
  const shot = path.join(ROOT, 'bench-poses', `why-${name}.png`);
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot });
  return {
    name,
    samples: n,
    skipPct: (skipN / n) * 100,
    uniqueCamKeys: uniqueKeys,
    callsAvg,
    trisAvg,
    fogUnex: last.fogUnex,
    fogVeil: last.fogVeil,
    groundRecvShadow: last.groundRecvShadow,
    skirtMeshes: last.skirtMeshes,
    shot,
  };
}

async function main() {
  const server = await startStaticServer();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
  });
  const page = await browser.newPage();
  const out = [];
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 180000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    });
    await sleep(800);

    await page.evaluate(async () => {
      window._startGame('1v1');
    });
    await page.waitForFunction(() => {
      const overlay = document.getElementById('match-prepare-overlay');
      return !(overlay && !overlay.hidden);
    }, { timeout: 180000 });
    await sleep(1200);

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
    });
    await sleep(400);
    out.push(await sample(page, 'look-spawn'));

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      const cam = Input.getCameraState();
      cam.rotY += Math.PI;
    });
    await sleep(500);
    out.push(await sample(page, 'look-out-180'));

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      const cam = Input.getCameraState();
      cam.y = 18;
    });
    await sleep(400);
    out.push(await sample(page, 'look-out-low'));

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
      const cam = Input.getCameraState();
      cam.y = 36;
    });
    await sleep(400);
    out.push(await sample(page, 'look-army-again'));
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n=== still-pose skip/GPU proof (headless; skip% and draws are the evidence) ===');
  console.log(
    `${'pose'.padEnd(18)} ${'skip%'.padStart(7)} ${'camKeys'.padStart(8)} ${'calls'.padStart(7)} ${'trisK'.padStart(8)} ${'fogU'.padStart(5)} ${'veil'.padStart(5)}`
  );
  for (const r of out) {
    console.log(
      `${r.name.padEnd(18)} ${r.skipPct.toFixed(0).padStart(7)} ${String(r.uniqueCamKeys).padStart(8)} ${r.callsAvg.toFixed(0).padStart(7)} ${(r.trisAvg / 1000).toFixed(1).padStart(8)} ${String(r.fogUnex).padStart(5)} ${String(r.fogVeil).padStart(5)}`
    );
  }
  const jsonPath = path.join(ROOT, 'bench-why-lookout.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ when: new Date().toISOString(), out }, null, 2));
  console.log(`\nWrote ${jsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
