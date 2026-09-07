#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8798;
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
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--use-gl=angle'] });
const page = await browser.newPage();

async function probe(mode) {
  await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  });
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
  await page.evaluate(() => window._dismissAppStartGate && window._dismissAppStartGate());
  await page.evaluate((m) => {
    window._setDynamicShadowsEnabled?.(false);
    window._setMsaa4xEnabled?.(false);
    window._startGame(m);
  }, mode);
  await page.waitForFunction(() => {
    const o = document.getElementById('match-prepare-overlay');
    return !(o && !o.hidden);
  }, null, { timeout: 300000 });
  await page.evaluate(async () => {
    const I = await import('./js/input.js');
    I.positionCameraForPlayer(0);
  });
  return page.evaluate((label) => {
    const THREE = window.THREE;
    const g = document.getElementById('ground');
    const mesh = g.getObject3D('mesh');
    const meshes = [];
    let tris = 0;
    mesh.traverse((o) => {
      if (!o.isMesh || !o.visible || o.name === 'rts-kit-ground') return;
      const pos = o.geometry?.attributes?.position;
      const idx = o.geometry?.index;
      const t = idx ? Math.floor(idx.count / 3) : pos ? Math.floor(pos.count / 3) : 0;
      const box = new THREE.Box3().setFromObject(o);
      const size = box.getSize(new THREE.Vector3());
      const mul = o.isInstancedMesh ? o.count || 1 : 1;
      meshes.push({
        name: o.name,
        tris: t,
        spanXZ: Math.max(size.x, size.z),
        spanY: size.y,
        inst: !!o.isInstancedMesh,
        count: mul,
      });
      tris += t * mul;
    });
    meshes.sort((a, b) => b.tris * b.count - a.tris * a.count);
    const sc = document.querySelector('a-scene');
    return {
      label,
      kind: mesh.userData.rtsKitKind,
      drawMeshes: meshes.length,
      trisEst: tris,
      top: meshes.slice(0, 6),
      bgTex: !!(sc.object3D && sc.object3D.background && sc.object3D.background.isTexture),
    };
  }, mode);
}

const a = await probe('1v1');
console.log(JSON.stringify(a, null, 2));
const s = await probe('story');
console.log(JSON.stringify(s, null, 2));
await browser.close();
server.close();
