#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8793;
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--use-gl=angle'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const glbs = [];
page.on('request', (r) => {
  if (/\.glb(\?|$)/i.test(r.url())) glbs.push(r.url().split('/').pop());
});
page.on('console', (m) => {
  const t = m.text();
  if (/moon|terrain|ground|bake|Battle|plate|crater/i.test(t)) console.log(t);
});
await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, {
  waitUntil: 'domcontentloaded',
  timeout: 180000,
});
await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
await page.evaluate(() => window._dismissAppStartGate && window._dismissAppStartGate());
await page.evaluate(() => {
  window._setDynamicShadowsEnabled?.(false);
  window._startGame('1v1');
});
await page.waitForFunction(() => {
  const o = document.getElementById('match-prepare-overlay');
  return !(o && !o.hidden);
}, null, { timeout: 300000 });
await page.evaluate(async () => {
  const I = await import('./js/input.js');
  I.positionCameraForPlayer(0);
});
const info = await page.evaluate(() => {
  const THREE = window.THREE;
  const g = document.getElementById('ground');
  const mesh = g.getObject3D('mesh');
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const mats = [];
  mesh.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    mats.push({
      name: o.name,
      type: m && m.type,
      map: !!(m && m.map),
      color: m && m.color && m.color.getHexString(),
      verts: o.geometry?.attributes?.position?.count,
    });
  });
  return {
    name: mesh.name,
    ud: mesh.userData,
    size: box.getSize(new THREE.Vector3()).toArray().map((n) => +n.toFixed(1)),
    mats,
  };
});
console.log(JSON.stringify(info, null, 2));
console.log('glbs', [...new Set(glbs)]);
await page.screenshot({ path: path.join(ROOT, 'bench-poses', '1v1-spawn-fresh.png') });
await browser.close();
server.close();
