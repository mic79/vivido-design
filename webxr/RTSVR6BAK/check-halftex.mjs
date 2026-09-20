#!/usr/bin/env node
/**
 * Headless proof that scifi-rts-rocks-t10.glb loads with half the textures resident and the
 * same geometry, before any VR time is spent on it. Reports live mesh/material/texture counts
 * off the actual three.js scene graph and shoots the same overhead vantage for both files.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8973;
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
let failed = false;

const CASES = [
  ['baseline    ', '&leanrocks=1', 'proof-halftex-20.png'],
  ['half texture', '&leanrocks=1&rocksfile=scifi-rts-rocks-t10', 'proof-halftex-10.png'],
  ['half tris   ', '&leanrocks=1&rocksfile=scifi-rts-rocks-h50', 'proof-halftris-50.png'],
];

for (const [label, q, shot] of CASES) {
  const page = await browser.newPage();
  const logs = [];
  const errors = [];
  page.on('console', (m) => {
    logs.push(m.text());
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
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
    let visTris = 0;
    const mats = new Set();
    const texes = new Set();
    const images = new Set();
    if (m) {
      m.traverse((o) => {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        all++;
        if (!o.visible) return;
        vis++;
        const idx = o.geometry && o.geometry.index;
        const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
        visTris += (idx ? idx.count : pos ? pos.count : 0) / 3;
        for (const mm of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!mm) continue;
          mats.add(mm);
          for (const k of Object.keys(mm)) {
            const v = mm[k];
            if (v && v.isTexture) {
              texes.add(v);
              if (v.image) images.add(v.image);
            }
          }
        }
      });
    }
    const info = document.querySelector('a-scene')?.renderer?.info;
    return {
      all,
      vis,
      visTris: Math.round(visTris),
      mats: mats.size,
      texes: texes.size,
      images: images.size,
      rendererTextures: info?.memory?.textures ?? -1,
      rendererGeometries: info?.memory?.geometries ?? -1,
    };
  });
  const fileLog = (logs.find((l) => l.includes('rocks kit file')) || '').replace(/.*url: /, '').replace(/,.*/, '');
  console.log(
    `${label}  ${fileLog.padEnd(38)} meshes=${st.all} (vis ${st.vis})  tris=${(st.visTris / 1e6).toFixed(2)}M  ` +
      `mats=${st.mats}  kitTex=${st.texes}  kitImages=${st.images}  rendererTextures=${st.rendererTextures}`
  );
  if (errors.length) {
    failed = true;
    console.log(`   PAGE ERRORS (${errors.length}): ${errors.slice(0, 3).join(' | ').slice(0, 300)}`);
  }

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
process.exit(failed ? 1 : 0);
