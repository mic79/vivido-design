#!/usr/bin/env node
/**
 * Where do the x2 rocks go? Loads ?leanrocks=1 and ?leanrocks=1&rocksx2=1 and reports
 * how many meshes survive assembly vs the LOD batcher, counting `_x2` names directly.
 * The GLB itself is verified good: 2430 mesh nodes / 1.01M tris / 40 textures.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8971;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream' };

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const f = path.normalize(path.join(ROOT, rel));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    res.end('nf');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--ignore-gpu-blocklist'] });

for (const [label, q, shot] of [
  ['1x  ', '&leanrocks=1', 'proof-rocks-1x.png'],
  ['x2  ', '&leanrocks=1&rocksx2=1', 'proof-rocks-x2.png'],
]) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
  await page.evaluate(() => {
    if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    window._startGame('1v1');
  });
  await page.waitForFunction(
    () => {
      const o = document.getElementById('match-prepare-overlay');
      return !(o && !o.hidden);
    },
    null,
    { timeout: 300000 }
  );
  await page.waitForTimeout(3000);

  const st = await page.evaluate(() => {
    const g = document.getElementById('ground');
    const m = g && g.getObject3D && g.getObject3D('mesh');
    let all = 0;
    let vis = 0;
    let x2all = 0;
    let x2vis = 0;
    let visTris = 0;
    const mats = new Set();
    const texes = new Set();
    if (m) {
      m.traverse((o) => {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        const isX2 = /_x2/i.test(o.name || '') || /_x2/i.test((o.material && o.material.name) || '');
        all++;
        if (isX2) x2all++;
        if (!o.visible) return;
        vis++;
        if (isX2) x2vis++;
        const idx = o.geometry && o.geometry.index;
        const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
        visTris += (idx ? idx.count : pos ? pos.count : 0) / 3;
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const mm of ms) {
          if (!mm) continue;
          mats.add(mm);
          for (const k of Object.keys(mm)) if (mm[k] && mm[k].isTexture) texes.add(mm[k]);
        }
      });
    }
    return { all, vis, x2all, x2vis, visTris: Math.round(visTris), mats: mats.size, texes: texes.size };
  });
  const fileLog = (logs.find((l) => l.includes('rocks kit file')) || '').replace(/.*url: /, '').replace(/,.*/, '');
  console.log(
    `${label} ${fileLog.padEnd(34)} meshes=${st.all} (visible ${st.vis})  _x2=${st.x2all} (visible ${st.x2vis})  ` +
      `mats=${st.mats} tex=${st.texes}`
  );
  for (const l of logs) {
    if (/kit distance LOD|skip kit|kit assembled|kit wrap/i.test(l)) console.log(`      ${l.slice(0, 200)}`);
  }
  // Same overhead vantage for both so the rock count is comparable by eye.
  await page.evaluate(() => {
    const rig = document.getElementById('camera-rig') || document.querySelector('[camera]');
    const cam = document.querySelector('a-scene').camera;
    if (cam) {
      cam.parent.position.set(0, 0, 0);
      cam.position.set(0, 90, 90);
      cam.rotation.set(-0.72, 0, 0);
      cam.updateMatrixWorld(true);
    }
    if (rig && rig.object3D) rig.object3D.updateMatrixWorld(true);
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(ROOT, shot) });
  await page.close();
}

await browser.close();
server.close();
process.exit(0);
