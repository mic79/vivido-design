#!/usr/bin/env node
/**
 * Proof gate: Shadows OFF + platform/pump close-up for hero RGB lightmaps.
 *   node RTSVR5/scripts/capture-hero-lm-proof.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8831);
const VER = fs
  .readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/name="rts-version"\s+content="([^"]+)"/)?.[1];
const OUT_DIR = path.join(ROOT, 'bench-poses');
const SHOT = path.join(OUT_DIR, `hero-lm-platform-${VER}.png`);
const GLB = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

const glbBytes = fs.statSync(GLB).size;
if (glbBytes >= 100 * 1024 * 1024) {
  console.error('FAIL: GLB >= 100MB', glbBytes);
  process.exit(2);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('missing');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  const t = m.text();
  if (/hero RGB|Shader Error|FAILED|pageerror/i.test(t)) console.log('console', t.slice(0, 240));
});

await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&scenery=B0&v=${VER}`, {
  waitUntil: 'domcontentloaded',
  timeout: 180000,
});
await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
await page.waitForTimeout(1500);
await page.evaluate(() => window._dismissAppStartGate && window._dismissAppStartGate());
await page.waitForTimeout(500);
// Shadows OFF — beauty must come from baked hero LM, not dynamic maps.
await page.evaluate(() => {
  window._setDynamicShadowsEnabled?.(false);
  window._startGame('1v1');
});
await page.waitForFunction(() => {
  const o = document.getElementById('match-prepare-overlay');
  return !(o && !o.hidden);
}, null, { timeout: 300000 });
await page.waitForTimeout(2500);

  const info = await page.evaluate(async (ver) => {
  const scene = document.querySelector('a-scene')?.object3D;
  let heroLm = 0;
  let plat = null;
  let pump = null;
  const stamps = [];
  scene?.traverse((o) => {
    if (!o.isMesh) return;
    if (o.userData?.rtsHeroLmApplied || o.material?.userData?.rtsHeroLm) heroLm++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m?.userData?.rtsHeroLm || m?.lightMap)) {
      if (/platform|circular/i.test(o.name || '')) plat = o.name;
      if (/pump/i.test(o.name || '')) pump = o.name;
    }
    if (o.userData?.rtsHeroLmStamp && /circularplatform|pump_merged/i.test(o.name || '')) {
      stamps.push({ name: o.name, ...o.userData.rtsHeroLmStamp, hasColor: !!o.geometry?.attributes?.color });
    }
  });
  const shadowsOn =
    typeof window._getDynamicShadowsEnabled === 'function'
      ? window._getDynamicShadowsEnabled()
      : null;
  return {
    ver: document.querySelector('meta[name="rts-version"]')?.content,
    heroLm,
    plat,
    pump,
    stamps: stamps.slice(0, 8),
    shadowsOn,
    sceneReady: !!window.__SCENE_READY__ || !!window.__rtsReady,
    fpsHud: document.getElementById('fps-counter')?.textContent || null,
  };
}, VER);

async function lockPose(page, pose, ms = 1500) {
  await page.evaluate(async ({ pose, ms }) => {
    const t0 = performance.now();
    const tick = () => {
      // Cancel lobby orbit that steals the rig after match start.
      try {
        const input = window.__rtsCancelLobbyIntro;
        if (typeof input === 'function') input();
      } catch (_) {}
      window.__rtsCameraRigPose?.(pose);
    };
    tick();
    await new Promise((resolve) => {
      const id = setInterval(() => {
        tick();
        if (performance.now() - t0 >= ms) {
          clearInterval(id);
          resolve();
        }
      }, 16);
    });
  }, { pose, ms });
}

await lockPose(page, { x: 8.3, y: 10, z: 0.9, rotY: -0.35 }, 1800);
fs.mkdirSync(OUT_DIR, { recursive: true });
await lockPose(page, { x: 8.3, y: 10, z: 0.9, rotY: -0.35 }, 200);
await page.screenshot({ path: SHOT, fullPage: false });

const SHOT2 = path.join(OUT_DIR, `hero-lm-pump-deck-${VER}.png`);
await lockPose(page, { x: 7.5, y: 9, z: -1.5, rotY: -0.55 }, 1200);
await page.screenshot({ path: SHOT2, fullPage: false });

const SHOT3 = path.join(OUT_DIR, `hero-lm-topdown-${VER}.png`);
await lockPose(page, { x: 3.35, y: 18, z: -5.08, rotY: 0 }, 1200);
await page.screenshot({ path: SHOT3, fullPage: false });

console.log(
  JSON.stringify(
    {
      info,
      SHOT,
      SHOT2,
      SHOT3,
      glbBytes,
      glbMB: +(glbBytes / (1024 * 1024)).toFixed(2),
      errors: errors.slice(0, 8),
    },
    null,
    2
  )
);

await browser.close();
server.close();

if (info.shadowsOn) {
  console.error('FAIL: Shadows still ON');
  process.exit(3);
}
if (!info.heroLm) {
  console.error('FAIL: no hero LM materials applied');
  process.exit(4);
}
if (errors.length) {
  console.error('FAIL: page errors', errors.slice(0, 3));
  process.exit(5);
}
console.log('PASS capture-hero-lm-proof');
