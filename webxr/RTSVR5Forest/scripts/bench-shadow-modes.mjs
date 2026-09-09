#!/usr/bin/env node
/**
 * Fact gate: Shadows OFF must skip PCF + allow skip-render; Story ON must
 * receive blobs under HQ (pixel-diff vs OFF). Headless FPS is relative only.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8782);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 1800);
const SHOT = path.join(ROOT, 'bench-poses');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dumpShadowState() {
  return window.__dumpShadowState();
}

async function installDump(page) {
  await page.evaluate(() => {
    window.__dumpShadowState = () => {
      const scene = document.querySelector('a-scene');
      const sm = scene && scene.renderer && scene.renderer.shadowMap;
      const ground = document.getElementById('ground');
      const moon = ground && ground.getObject3D && ground.getObject3D('mesh');
      const THREE = window.THREE;
      let moonReceive = 0;
      let moonMeshes = 0;
      let casterN = 0;
      let light = null;
      if (moon) {
        moon.traverse((o) => {
          if (!o.isMesh) return;
          moonMeshes += 1;
          if (o.receiveShadow) moonReceive += 1;
        });
      }
      let hq = null;
      scene &&
        scene.object3D &&
        scene.object3D.traverse((o) => {
          if (o.castShadow && (o.isMesh || o.isInstancedMesh || o.isSkinnedMesh)) casterN += 1;
          if (o.isDirectionalLight) {
            const cam = o.shadow && o.shadow.camera;
            cam && cam.updateMatrixWorld && cam.updateMatrixWorld(true);
            cam && cam.updateProjectionMatrix && cam.updateProjectionMatrix();
            const frustum = new THREE.Frustum();
            const m = new THREE.Matrix4();
            if (cam) {
              m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
              frustum.setFromProjectionMatrix(m);
            }
            light = {
              pos: o.position.toArray(),
              world: (function () {
                const w = new THREE.Vector3();
                o.getWorldPosition(w);
                return w.toArray();
              })(),
              castShadow: !!o.castShadow,
              map: !!(o.shadow && o.shadow.map),
              mapSize: o.shadow ? [o.shadow.mapSize.x, o.shadow.mapSize.y] : null,
              left: cam ? cam.left : null,
              right: cam ? cam.right : null,
              top: cam ? cam.top : null,
              bottom: cam ? cam.bottom : null,
              near: cam ? cam.near : null,
              far: cam ? cam.far : null,
              containsHq: null,
            };
            window.__rtsShadowFrustum = frustum;
          }
        });
      const State = window.__rtsShadowState;
      if (State && light && window.__rtsShadowFrustum) {
        State.buildings.forEach((b) => {
          if (hq || b.type !== 'hq') return;
          hq = { x: b.x, y: b.y, z: b.z, type: b.type };
          const p = new THREE.Vector3(b.x, (b.y || 0) + 2, b.z);
          light.containsHq = window.__rtsShadowFrustum.containsPoint(p);
          light.hqDist = Math.hypot(b.x, b.z);
        });
      }
      return {
        pref: typeof window._getDynamicShadowsEnabled === 'function' ? window._getDynamicShadowsEnabled() : null,
        smEnabled: !!(sm && sm.enabled),
        smAuto: !!(sm && sm.autoUpdate),
        skip: !!(scene && scene.__rtsSkipRender),
        moonMeshes,
        moonReceive,
        casterN,
        light,
        hq,
        navR: window.__rtsMapUnitNavRadius || null,
        profile: window.__rtsMapProfile || null,
      };
    };
  });
}

async function bindState(page) {
  await page.evaluate(async () => {
    const State = await import('./js/state.js');
    const Config = await import('./js/config.js');
    window.__rtsShadowState = State;
    window.__rtsMapProfile = Config.MAP_PROFILE;
    window.__rtsMapUnitNavRadius = Config.MAP_UNIT_NAV_RADIUS;
  });
}

async function lookAtMyHq(page) {
  await page.evaluate(async () => {
    const State = await import('./js/state.js');
    const myId = State.gameSession.myPlayerId;
    let hx = 0;
    let hz = 0;
    let found = false;
    State.buildings.forEach((b) => {
      if (found) return;
      if (b.ownerId === myId && b.type === 'hq') {
        hx = b.x;
        hz = b.z;
        found = true;
      }
    });
    const rig = document.getElementById('cameraRig');
    const cam = document.getElementById('camera');
    if (rig) {
      rig.object3D.position.set(hx, 28, hz + 38);
      rig.object3D.rotation.set(0, 0, 0);
    }
    if (cam) cam.object3D.rotation.set(-0.55, 0, 0);
  });
  await sleep(500);
}

async function startMode(page, mode) {
  await page.evaluate((m) => {
    if (typeof window._startGame !== 'function') throw new Error('no _startGame');
    window._startGame(m);
  }, mode);
  await page.waitForFunction(() => {
    const overlay = document.getElementById('match-prepare-overlay');
    return !(overlay && !overlay.hidden);
  }, null, { timeout: 180000 });
  await sleep(900);
}

async function samplePerf(page) {
  await page.evaluate(() => {
    window.__rtsPerf.setPerfEnabled(true);
    window.__rtsPerf.resetSamples();
  });
  await sleep(SAMPLE_MS);
  return page.evaluate(() => {
    const snap = window.__rtsPerf.snapshot();
    const gpu = snap.gpu || {};
    return {
      fps: snap.fpsAvg ?? snap.fps ?? 0,
      frameMs: snap.avgMs?.frame || 0,
      calls: gpu.callsAvg || 0,
      tris: gpu.trisAvg || 0,
      skipPct: gpu.skipPct || 0,
    };
  });
}

async function pixelDarker(browser, onPath, offPath) {
  const onBuf = fs.readFileSync(onPath);
  const offBuf = fs.readFileSync(offPath);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(
    `<img id="a" src="data:image/png;base64,${onBuf.toString('base64')}">
     <img id="b" src="data:image/png;base64,${offBuf.toString('base64')}">`,
    { waitUntil: 'load' }
  );
  const r = await page.evaluate(() => {
    const ia = document.getElementById('a');
    const ib = document.getElementById('b');
    const ca = document.createElement('canvas');
    ca.width = ia.naturalWidth;
    ca.height = ia.naturalHeight;
    const cb = document.createElement('canvas');
    cb.width = ib.naturalWidth;
    cb.height = ib.naturalHeight;
    ca.getContext('2d').drawImage(ia, 0, 0);
    cb.getContext('2d').drawImage(ib, 0, 0);
    const x = Math.floor(ca.width * 0.35);
    const y = Math.floor(ca.height * 0.32);
    const w = Math.floor(ca.width * 0.3);
    const h = Math.floor(ca.height * 0.36);
    const da = ca.getContext('2d').getImageData(x, y, w, h).data;
    const db = cb.getContext('2d').getImageData(x, y, w, h).data;
    let mad = 0;
    let darker = 0;
    const n = da.length / 4;
    for (let i = 0; i < da.length; i += 4) {
      const la = 0.2126 * da[i] + 0.7152 * da[i + 1] + 0.0722 * da[i + 2];
      const lb = 0.2126 * db[i] + 0.7152 * db[i + 1] + 0.0722 * db[i + 2];
      mad += Math.abs(la - lb);
      if (la < lb - 8) darker++;
    }
    return { mad: mad / n, darkerFrac: darker / n, n, crop: { x, y, w, h } };
  });
  await page.close();
  return r;
}

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
fs.mkdirSync(SHOT, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const out = {};

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 180000 });
  await page.evaluate(() => {
    if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
  });
  await installDump(page);
  await sleep(400);

  await page.evaluate(() => window._setDynamicShadowsEnabled(false));
  await sleep(400);
  await startMode(page, '1v1');
  await lookAtMyHq(page);
  await bindState(page);
  out.skirmishOff = { flags: await page.evaluate(dumpShadowState), perf: await samplePerf(page) };
  await page.screenshot({ path: path.join(SHOT, 'diag-1v1-off.png'), type: 'png' });

  await page.evaluate(() => window._setDynamicShadowsEnabled(true));
  await sleep(700);
  await bindState(page);
  out.skirmishOn = { flags: await page.evaluate(dumpShadowState), perf: await samplePerf(page) };
  await page.screenshot({ path: path.join(SHOT, 'diag-1v1-on.png'), type: 'png' });
  out.skirmishBlob = await pixelDarker(browser, path.join(SHOT, 'diag-1v1-on.png'), path.join(SHOT, 'diag-1v1-off.png'));

  await page.evaluate(() => window._setDynamicShadowsEnabled(true));
  await startMode(page, 'story');
  await lookAtMyHq(page);
  await bindState(page);
  await sleep(700);
  out.storyOn = { flags: await page.evaluate(dumpShadowState), perf: await samplePerf(page) };
  await page.screenshot({ path: path.join(SHOT, 'diag-story-on.png'), type: 'png' });

  await page.evaluate(() => window._setDynamicShadowsEnabled(false));
  await sleep(700);
  await bindState(page);
  out.storyOff = { flags: await page.evaluate(dumpShadowState), perf: await samplePerf(page) };
  await page.screenshot({ path: path.join(SHOT, 'diag-story-off.png'), type: 'png' });
  out.storyBlob = await pixelDarker(browser, path.join(SHOT, 'diag-story-on.png'), path.join(SHOT, 'diag-story-off.png'));

  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
  server.close();
}
