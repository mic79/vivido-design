#!/usr/bin/env node
/**
 * Why does the half-triangle GLB render the same triangle count as the source? Reports exact
 * (unrounded) triangle totals off the live scene graph, split by object, for both files on the
 * SAME map seed so rock placement cannot differ between the two.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8974;
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

for (const [label, q] of [
  ['baseline', '&leanrocks=1'],
  ['noterr  ', '&leanrocks=1&noterrain=1'],
]) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&seed=4242${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
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
    const rows = [];
    let total = 0;
    let hidden = 0;
    const geos = new Set();
    if (m) {
      m.traverse((o) => {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        const idx = o.geometry && o.geometry.index;
        const pos = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
        const t = (idx ? idx.count : pos ? pos.count : 0) / 3;
        const inst = o.isInstancedMesh ? o.count : 1;
        // An ancestor being hidden is what actually stops the draw, so walk up rather than
        // trusting the mesh's own flag.
        let drawn = true;
        for (let p = o; p; p = p.parent) {
          if (!p.visible) {
            drawn = false;
            break;
          }
        }
        if (!drawn) {
          hidden += t * inst;
          return;
        }
        geos.add(o.geometry);
        total += t * inst;
        rows.push({ name: o.name || '(unnamed)', tris: t, inst, isInstanced: !!o.isInstancedMesh });
      });
    }
    const info = document.querySelector('a-scene')?.renderer?.info;
    return { rows, total, hidden, uniqueGeos: geos.size, calls: info?.render?.calls ?? -1 };
  });
  const fileLog = (logs.find((l) => l.includes('rocks kit file')) || '').replace(/.*url: /, '').replace(/,.*/, '');
  console.log(`\n${label}  ${fileLog}`);
  const instances = st.rows.reduce((s, r) => s + (r.isInstanced ? r.inst : 0), 0);
  console.log(
    `  visible triangles = ${st.total.toLocaleString()}   hidden = ${st.hidden.toLocaleString()}   ` +
      `instances = ${instances}   draw calls = ${st.calls}`
  );
  await page.evaluate(() => {
    const cam = document.querySelector('a-scene').camera;
    if (cam) {
      cam.parent.position.set(0, 0, 0);
      cam.position.set(0, 90, 90);
      cam.rotation.set(-0.72, 0, 0);
      cam.updateMatrixWorld(true);
    }
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(ROOT, `proof-tris-${label.trim()}.png`) });
  await page.close();
}

await browser.close();
server.close();
process.exit(0);
