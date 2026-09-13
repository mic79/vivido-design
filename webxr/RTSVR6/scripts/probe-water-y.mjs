#!/usr/bin/env node
/**
 * Probe Story kit water Y vs dirt mins (same loader path as runtime).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8795;
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
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
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--use-gl=angle'] });
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (/water|dirt|y0|kit ready|probe/i.test(t)) console.log(t);
});
await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__rtsReady === true && window.THREE, null, { timeout: 240000 });

const info = await page.evaluate(async () => {
  const { ensureThreeGltfLoaders } = await import('./js/three-gltf-umd.js');
  await ensureThreeGltfLoaders();
  const THREE = window.THREE;
  const url = 'assets/terrain/scifi-rts-kit-lod2.glb';
  const buf = await (await fetch(url)).arrayBuffer();
  const loader = new THREE.GLTFLoader();
  if (THREE.DRACOLoader) {
    const d = new THREE.DRACOLoader();
    d.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
    loader.setDRACOLoader(d);
  }
  const gltf = await new Promise((res, rej) => loader.parse(buf, '', res, rej));
  const scene = (gltf.scenes || []).find((s) => s.name === 'LOD2') || gltf.scene;
  scene.updateMatrixWorld(true);

  const waters = [];
  const dirtMins = [];
  const rockMins = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const n = `${o.name || ''} ${o.parent?.name || ''}`;
    const box = new THREE.Box3().setFromObject(o);
    if (/WaterPlane/i.test(n)) {
      waters.push({
        name: n.trim(),
        minY: +box.min.y.toFixed(3),
        maxY: +box.max.y.toFixed(3),
        midY: +((box.min.y + box.max.y) * 0.5).toFixed(3),
      });
    }
    if (/SM_Dirt/i.test(n)) dirtMins.push(+box.min.y.toFixed(3));
    if (/SM_Rock/i.test(n)) rockMins.push(+box.min.y.toFixed(3));
  });
  dirtMins.sort((a, b) => a - b);
  rockMins.sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length ? arr[Math.max(0, Math.floor(arr.length * p))] : null);
  return {
    waters,
    dirtCount: dirtMins.length,
    rockCount: rockMins.length,
    dirtP10: pct(dirtMins, 0.1),
    dirtP50: pct(dirtMins, 0.5),
    rockP10: pct(rockMins, 0.1),
    rockP50: pct(rockMins, 0.5),
    waterAvgMid: waters.length
      ? +(waters.reduce((s, w) => s + w.midY, 0) / waters.length).toFixed(3)
      : null,
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
server.close();
