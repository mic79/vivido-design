#!/usr/bin/env node
/**
 * Capture RTSVR5 1v1 after UE→GLB pipeline for visual proof.
 *   node RTSVR5/scripts/capture-ue-export-in-game.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8822);
const VER = fs
  .readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/name="rts-version"\s+content="([^"]+)"/)?.[1];
const OUT_DIR = path.join(ROOT, 'bench-poses');
const SHOT_MATCH = path.join(OUT_DIR, `ue-export-1v1-${VER}.png`);
const SHOT_CLOSE = path.join(OUT_DIR, `ue-export-1v1-cliffs-${VER}.png`);

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
  if (/pageerror|Shader Error|FAILED|GLB|terrain-skirmish|scenery props/i.test(t)) {
    console.log('console', t.slice(0, 240));
  }
});

await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&scenery=B0&v=${VER}`, {
  waitUntil: 'domcontentloaded',
  timeout: 180000,
});
await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
await page.waitForTimeout(2000);
await page.evaluate(() => window._dismissAppStartGate && window._dismissAppStartGate());
await page.waitForTimeout(800);
await page.evaluate(() => {
  window._setDynamicShadowsEnabled?.(true);
  window._startGame('1v1');
});
await page.waitForFunction(() => {
  const o = document.getElementById('match-prepare-overlay');
  return !(o && !o.hidden);
}, null, { timeout: 300000 });
await page.waitForFunction(
  async (ver) => {
    try {
      const S = await import(`./js/state.js?v=${ver}`);
      let found = false;
      S.buildings.forEach((b) => {
        if (b.type === 'hq' && b.playerId === 0) found = true;
      });
      return found;
    } catch {
      return false;
    }
  },
  VER,
  { timeout: 120000 }
).catch(() => {});
await page.waitForTimeout(2000);

const info = await page.evaluate(async (ver) => {
  const S = await import(`./js/state.js?v=${ver}`);
  let hq = null;
  S.buildings.forEach((b) => {
    if (!hq && b.type === 'hq' && b.playerId === 0) hq = b;
  });
  const scene = document.querySelector('a-scene')?.object3D;
  let props = 0;
  let moons = 0;
  let rockShadow = 0;
  let moonWorld = null;
  scene?.traverse((o) => {
    const n = o.name || '';
    if (/^Prop_/i.test(n)) props++;
    if (/^Moon_\d/i.test(n) && o.isMesh) {
      moons++;
      if (!moonWorld && /^Moon_0/i.test(n)) {
        o.updateMatrixWorld(true);
        const box = new window.THREE.Box3().setFromObject(o);
        moonWorld = {
          min: box.min.toArray(),
          max: box.max.toArray(),
          visible: o.visible,
        };
      }
    }
    if (o.material?.userData?.rockShadowMap) rockShadow++;
  });
  return {
    ver: document.querySelector('meta[name="rts-version"]')?.content,
    hq: hq ? { x: hq.x, y: hq.y, z: hq.z } : null,
    props,
    moons,
    rockShadow,
    moonWorld,
    fpsHud: document.getElementById('fps-counter')?.textContent || null,
  };
}, VER);

const look = info.hq || { x: 0, y: 0, z: 0 };

// Wide match view near HQ (or origin if HQ late)
await page.evaluate(({ look }) => {
  const rig = document.getElementById('cameraRig')?.object3D;
  const cam = document.getElementById('camera')?.object3D;
  if (!rig || !cam || !window.THREE) return;
  rig.position.set(look.x, (look.y || 0) + 42, look.z + 38);
  rig.rotation.set(0, 0, 0);
  cam.position.set(0, 0, 0);
  cam.rotation.set(window.THREE.MathUtils.degToRad(-55), 0, 0);
}, { look });
await page.waitForTimeout(1200);
fs.mkdirSync(OUT_DIR, { recursive: true });
await page.screenshot({ path: SHOT_MATCH, fullPage: false });

// Close look at newly added UE scenery (platform / pump cluster)
await page.evaluate(() => {
  const rig = document.getElementById('cameraRig')?.object3D;
  const cam = document.getElementById('camera')?.object3D;
  if (!rig || !cam || !window.THREE) return;
  let target = null;
  document.querySelector('a-scene')?.object3D?.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.name || '';
    if (/pump|platform|circular/i.test(n)) target = o;
  });
  if (target) {
    target.updateMatrixWorld(true);
    const p = new window.THREE.Vector3();
    target.getWorldPosition(p);
    rig.position.set(p.x + 10, p.y + 14, p.z + 16);
  } else {
    // Fallback: UE cm (331,-507,154)/(336,-502,382) → meters
    rig.position.set(3.3 + 10, 8, -5.0 + 16);
  }
  rig.rotation.set(0, 0, 0);
  cam.position.set(0, 0, 0);
  cam.rotation.set(window.THREE.MathUtils.degToRad(-42), window.THREE.MathUtils.degToRad(-25), 0);
});
await page.waitForTimeout(1000);
await page.screenshot({ path: SHOT_CLOSE, fullPage: false });

// Prove new UE-only nodes are in the live scene
info.newUe = await page.evaluate(() => {
  const found = [];
  document.querySelector('a-scene')?.object3D?.traverse((o) => {
    if (!o.isMesh) return;
    const n = o.name || '';
    if (/pump|platform|circular|Cliff_185|Cliff_131/i.test(n)) {
      found.push(n);
    }
  });
  return [...new Set(found)].slice(0, 20);
});

// Count bridge in scene for proof
info.bridge = await page.evaluate(() => {
  let n = 0;
  let name = null;
  document.querySelector('a-scene')?.object3D?.traverse((o) => {
    if (o.isMesh && /bridge/i.test(o.name || '')) {
      n++;
      name = o.name;
    }
  });
  return { meshes: n, name };
});

console.log(JSON.stringify({ info, SHOT_MATCH, SHOT_CLOSE, errors: errors.slice(0, 8) }, null, 2));
await browser.close();
server.close();
if (!info.moons || info.moons < 2) process.exit(2);
if (info.moonWorld && info.moonWorld.max[1] < 1) {
  console.error('Moon_0 world Y max too low — orientation still wrong', info.moonWorld);
  process.exit(4);
}
if (errors.length) process.exit(3);
console.log('PASS capture-ue-export-in-game');
