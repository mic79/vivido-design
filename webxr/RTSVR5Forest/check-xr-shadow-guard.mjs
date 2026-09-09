#!/usr/bin/env node
/**
 * Dynamic shadows must stay ON for desktop and OFF while XR presents.
 *
 * The bug this locks down: applyDynamicShadowGpuState() disabled the shadow map on
 * enter-vr, but syncShadowMapFromCasters() ran every frame and re-enabled it from
 * _dynamicShadowsOn alone — so VR paid a PCF soft shadow pass it was written not to run
 * (measured 5.44 -> 4.54 ms GPU, decay at sec 25 -> sec 102 on Virtual Desktop).
 *
 * No headset needed: renderer.xr.isPresenting is stubbed, then the real per-frame
 * updateRendering() path is driven and the shadow map state read back.
 *
 *   node RTSVR5/check-xr-shadow-guard.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9137);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  const s = http.createServer((req, res) => {
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
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  });
}

/** Drive several real frames, then report whether any shadow work is still armed. */
async function readShadowState(page, presenting) {
  return page.evaluate(async (xrOn) => {
    const sceneEl = document.querySelector('a-scene');
    const renderer = sceneEl.renderer;
    if (!renderer.xr.__origIsPresenting) {
      renderer.xr.__origIsPresenting = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(renderer.xr),
        'isPresenting'
      );
    }
    Object.defineProperty(renderer.xr, 'isPresenting', { value: xrOn, configurable: true });
    const mod = await import('./js/renderer.js');
    // Several frames: the bug only showed one frame after the guard was applied.
    for (let i = 0; i < 8; i++) {
      mod.updateRendering();
      await new Promise((r) => requestAnimationFrame(r));
    }
    let lightCasts = false;
    sceneEl.object3D.traverse((o) => {
      if (o.isDirectionalLight && o.castShadow) lightCasts = true;
    });
    return { mapEnabled: !!renderer.shadowMap.enabled, autoUpdate: !!renderer.shadowMap.autoUpdate, lightCasts };
  }, presenting);
}

async function main() {
  const server = await serve();
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage();
  const fails = [];
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
      window._setDynamicShadowsEnabled(true);
    });
    await page.evaluate(() => window._startGame('1v1'));
    await sleep(3000);

    const desktop = await readShadowState(page, false);
    console.log('desktop (pref on) :', JSON.stringify(desktop));
    if (!desktop.mapEnabled) fails.push('desktop lost its shadow map — the XR guard is too broad');
    if (!desktop.lightCasts) fails.push('desktop directional light stopped casting');

    const xr = await readShadowState(page, true);
    console.log('xr presenting     :', JSON.stringify(xr));
    if (xr.mapEnabled) fails.push('shadow map re-enabled while XR presents (the original bug)');

    const back = await readShadowState(page, false);
    console.log('desktop after exit:', JSON.stringify(back));
    if (!back.mapEnabled) fails.push('shadows did not come back after leaving XR');
  } finally {
    await browser.close();
    server.close();
  }
  if (fails.length) {
    for (const f of fails) console.error('FAIL:', f);
    process.exit(1);
  }
  console.log('\nPASS — shadows on for desktop, off while XR presents, restored on exit.');
  process.exit(0);
}

main();
