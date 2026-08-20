#!/usr/bin/env node
/** Headless smoke: preview7 loads LandscapePreview2 + Epic lightmaps, spawn inside station. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8777);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/preview7.html';
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

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (msg) => {
  const t = msg.text();
  if (msg.type() === 'error' && !/favicon|404 \(Not Found\)/i.test(t)) errors.push(t);
});
await page.goto(`http://127.0.0.1:${PORT}/preview7.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.__SCENE_READY__ === true, { timeout: 180000 });
await new Promise((r) => setTimeout(r, 800));
await page.evaluate(() => {
  window.__setView?.('C');
  window.__PVS_UPDATE__?.();
  window.__RENDERER__?.render(window.__SCENE__, window.__CAMERA__);
});
const info = await page.evaluate(() => {
  const cam = window.__CAMERA__;
  const merge = window.__MERGE__ || {};
  const r = window.__RENDERER__;
  r?.render(window.__SCENE__, cam);
  return {
    applied: window.__APPLIED__,
    spawn: merge.spawn,
    cam: cam ? { x: cam.position.x, y: cam.position.y, z: cam.position.z } : null,
    draws: r?.info?.render?.calls,
    tris: r?.info?.render?.triangles,
    status: document.getElementById('status')?.textContent,
    occ: window.__OCC__,
    pvs: window.__PVS__,
  };
});
const shot = path.join(ROOT, 'landscape2', 'preview7-spawn.png');
await page.screenshot({ path: shot });
const wall = await page.evaluate(() => {
  const cam = window.__CAMERA__;
  const s = window.__MERGE__?.spawn;
  if (!cam || !s) return null;
  const y = cam.position.y;
  const dx = (s.x - s.lookX) || 1;
  const dz = (s.z - s.lookZ) || 0;
  const len = Math.hypot(dx, dz) || 1;
  cam.position.set(s.x, y, s.z);
  cam.lookAt(s.x + (dx / len) * 3, y, s.z + (dz / len) * 3);
  cam.updateMatrixWorld();
  window.__PVS_UPDATE__?.();
  const r = window.__RENDERER__;
  r?.render(window.__SCENE__, cam);
  return {
    draws: r?.info?.render?.calls,
    tris: r?.info?.render?.triangles,
    pvs: window.__PVS__,
  };
});
const wallShot = path.join(ROOT, 'landscape2', 'preview7-wall.png');
await page.screenshot({ path: wallShot });
const lookOut = await page.evaluate(() => {
  const cam = window.__CAMERA__;
  const s = window.__MERGE__?.spawn;
  if (!cam || !s) return null;
  const y = cam.position.y;
  const ax = s.airlock?.[0] ?? s.x;
  const az = s.airlock?.[2] ?? s.z;
  cam.position.set(ax, y, az);
  cam.lookAt(ax - 8, y - 2, az + 10);
  cam.updateMatrixWorld();
  window.__PVS_UPDATE__?.();
  const r = window.__RENDERER__;
  r?.render(window.__SCENE__, cam);
  return {
    draws: r?.info?.render?.calls,
    tris: r?.info?.render?.triangles,
    pvs: window.__PVS__,
  };
});
const lookOutShot = path.join(ROOT, 'landscape2', 'preview7-lookout.png');
await page.screenshot({ path: lookOutShot });
await page.evaluate(() => {
  window.__setView?.('D');
  window.__PVS_UPDATE__?.();
  window.__RENDERER__?.render(window.__SCENE__, window.__CAMERA__);
});
await new Promise((r) => setTimeout(r, 200));
const extShot = path.join(ROOT, 'landscape2', 'preview7-exterior.png');
await page.screenshot({ path: extShot });
await browser.close();
server.close();
console.log(JSON.stringify({ ok: true, errors, info, wall, lookOut, shot, wallShot, lookOutShot, extShot }, null, 2));
if (errors.length) process.exit(2);
if (!info.applied) process.exit(3);
