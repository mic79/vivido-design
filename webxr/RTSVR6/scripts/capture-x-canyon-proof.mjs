#!/usr/bin/env node
/** Capture overhead + approach proof of dense X canyon via __rtsCameraRigPose. */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8837);
const VER = fs
  .readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/name="rts-version"\s+content="([^"]+)"/)?.[1];
const OUT_DIR = path.join(ROOT, 'bench-poses');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&focusCull=0&v=${VER}`, {
  waitUntil: 'domcontentloaded',
  timeout: 180000,
});
await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
await page.evaluate(() => window._dismissAppStartGate && window._dismissAppStartGate());
await page.evaluate(() => window._startGame('1v1'));
await page.waitForFunction(() => {
  const o = document.getElementById('match-prepare-overlay');
  return !(o && !o.hidden);
}, null, { timeout: 300000 });
await page.waitForTimeout(2500);

async function shot(name, pose) {
  await page.evaluate((pose) => {
    window.__rtsCancelLobbyIntro?.();
    window.__rtsCameraRigPose?.(pose);
  }, pose);
  await page.waitForTimeout(700);
  const p = path.join(OUT_DIR, name);
  await page.screenshot({ path: p, type: 'png' });
  const poseOut = await page.evaluate(() => window.__rtsCameraRigPose?.());
  console.log('shot', name, poseOut);
}

// Top-down of heightmap terrain.
await shot(`hm-overhead-${VER}.png`, { x: 0, y: 120, z: 0, rotY: 0 });
// Slight perspective matching the reference tile view.
await shot(`hm-perspective-${VER}.png`, { x: 70, y: 55, z: 70, rotY: (-Math.PI * 5) / 4 });
await shot(`hm-approach-${VER}.png`, { x: -20, y: 22, z: 50, rotY: Math.PI * 0.15 });
await shot(`mesa-hf-overhead-${VER}.png`, { x: 0, y: 120, z: 0, rotY: 0 });
await shot(`mesa-hf-approach-NE-${VER}.png`, { x: 55, y: 45, z: 85, rotY: (-Math.PI * 3) / 4 });
await shot(`x-canyon-overhead-${VER}.png`, { x: 0, y: 120, z: 0, rotY: 0 });
await shot(`x-canyon-approach-NE-${VER}.png`, { x: 55, y: 45, z: 85, rotY: (-Math.PI * 3) / 4 });
await shot(`x-canyon-flank-N-${VER}.png`, { x: 30, y: 18, z: 40, rotY: Math.PI * 0.3 });

await browser.close();
server.close();
console.log('DONE');
