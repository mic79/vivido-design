#!/usr/bin/env node
/**
 * Overview kit: look-at-catalog vs look-at-stars vs close-up.
 * Proves instance frustum cull (stars must drop draws; a few modules must not cost the full catalog).
 *   node RTSVR5/bench-kit-poses.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8773);
const SHOT = path.join(ROOT, 'bench-kit-poses');
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 1200);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'application/json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
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
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dumpGpu() {
  const sc = document.querySelector('a-scene');
  const r = sc && sc.renderer;
  window.__rtsForceRender = true;
  if (sc) sc.__rtsSkipRender = false;
  let hookErr = null;
  try {
    if (typeof window.__rtsUpdateKitLod === 'function') window.__rtsUpdateKitLod();
    else hookErr = 'no-hook';
  } catch (e) {
    hookErr = String(e && e.message ? e.message : e);
  }
  if (r && sc && sc.object3D && sc.camera) {
    r.info.reset();
    r.render(sc.object3D, sc.camera);
  }
  const groundEl = document.getElementById('ground');
  const mesh = groundEl && groundEl.getObject3D && groundEl.getObject3D('mesh');
  const out = {
    calls: r && r.info && r.info.render ? r.info.render.calls : 0,
    tris: r && r.info && r.info.render ? r.info.render.triangles : 0,
    visInst: 0,
    visInstCount: 0,
    visMesh: 0,
    hookErr,
    cull: window.__rtsKitCullDebug || null,
  };
  if (!mesh) return out;
  mesh.traverse((o) => {
    if (o.isInstancedMesh) {
      if (o.visible && o.count > 0) {
        out.visInst++;
        out.visInstCount += o.count;
      }
      return;
    }
    if ((o.isMesh || o.isSkinnedMesh) && o.visible && o.name !== 'rts-kit-ground') out.visMesh++;
  });
  return out;
}

async function samplePose(page, label) {
  await page.evaluate(() => {
    window.__rtsForceRender = true;
    const sc = document.querySelector('a-scene');
    if (sc) sc.__rtsSkipRender = false;
  });
  await sleep(250);
  await page.evaluate(() => {
    if (window.__rtsPerf) {
      window.__rtsPerf.setPerfEnabled(true);
      window.__rtsPerf.resetSamples();
    }
  });
  await sleep(SAMPLE_MS);
  const gpu = await page.evaluate(dumpGpu);
  const perf = await page.evaluate(() => (window.__rtsPerf ? window.__rtsPerf.snapshot() : null));
  const g = (perf && perf.gpu) || {};
  const row = {
    label,
    ...gpu,
    fps: perf && (perf.fpsAvg ?? perf.fps),
    callsAvg: g.callsAvg,
    trisAvg: g.trisAvg,
  };
  await page.screenshot({ path: path.join(SHOT, `${label}.png`) });
  return row;
}

async function main() {
  fs.mkdirSync(SHOT, { recursive: true });
  const server = await startStaticServer();
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
  });
  const rows = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    });
    await sleep(400);
    await page.evaluate(() => window._startGame('1v1'));
    await page.waitForFunction(() => {
      const overlay = document.getElementById('match-prepare-overlay');
      return !(overlay && !overlay.hidden);
    }, null, { timeout: 300000 });
    await sleep(600);

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
      if (typeof window._setDynamicShadowsEnabled === 'function') window._setDynamicShadowsEnabled(false);
      if (typeof window._setMsaa4xEnabled === 'function') window._setMsaa4xEnabled(false);
    });
    rows.push(await samplePose(page, 'look-kit'));

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      const cam = Input.getCameraState();
      cam.x = 110;
      cam.z = 110;
      cam.y = 28;
      cam.rotY = Math.atan2(cam.x, cam.z) + Math.PI;
    });
    rows.push(await samplePose(page, 'look-stars'));

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      const THREE = window.THREE;
      const groundEl = document.getElementById('ground');
      const root = groundEl && groundEl.getObject3D && groundEl.getObject3D('mesh');
      const m = new THREE.Matrix4();
      let t = { x: 0, y: 2, z: 0 };
      if (root) {
        root.traverse((o) => {
          if (!o.isInstancedMesh || !o.count) return;
          o.updateMatrixWorld(true);
          o.getMatrixAt(0, m);
          m.premultiply(o.matrixWorld);
          const e = m.elements;
          t = { x: e[12], y: e[13], z: e[14] };
        });
      }
      const cam = Input.getCameraState();
      cam.x = t.x + 9;
      cam.y = Math.max((t.y || 0) + 5, 8);
      cam.z = t.z + 9;
      cam.rotY = Math.atan2(-9, -9);
    });
    rows.push(await samplePose(page, 'look-close'));

    // First-person: as close as the RTS rig allows, looking at origin (yaw 0 → −Z).
    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      const cam = Input.getCameraState();
      cam.x = 0;
      cam.y = 10;
      cam.z = 32;
      cam.rotY = 0;
      const camEl = document.getElementById('camera');
      const src = camEl && camEl.getObject3D && camEl.getObject3D('camera');
      if (src) {
        src.fov = 85;
        if (typeof src.updateProjectionMatrix === 'function') src.updateProjectionMatrix();
      }
      window.__rtsKitCullTestCameras = null;
      window.__rtsKitCullForceXr = false;
    });
    await sleep(200);
    rows.push(await samplePose(page, 'look-fp'));

    // Same pose, VR-style radius / eye-only frustum (never the ArrayCamera parent).
    await page.evaluate(() => {
      const camEl = document.getElementById('camera');
      const src = camEl && camEl.getObject3D && camEl.getObject3D('camera');
      if (!src) return;
      src.updateMatrixWorld(true);
      const THREE = window.THREE;
      const eye = src.clone();
      eye.fov = src.fov || 85;
      eye.aspect = src.aspect || 16 / 9;
      eye.near = src.near || 0.05;
      eye.far = src.far || 12000;
      eye.position.copy(src.getWorldPosition(new THREE.Vector3()));
      eye.quaternion.copy(src.getWorldQuaternion(new THREE.Quaternion()));
      eye.updateMatrixWorld(true);
      eye.updateProjectionMatrix();
      window.__rtsKitCullForceXr = true;
      window.__rtsKitCullTestCameras = [eye];
      if (typeof window.__rtsUpdateKitLod === 'function') window.__rtsUpdateKitLod();
    });
    rows.push(await samplePose(page, 'look-fp-xr'));

    // Headset-like 100° FOV (PCVR). A 50° default-fov frustum would hide in-view pieces.
    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      const THREE = window.THREE;
      const cam = Input.getCameraState();
      cam.x = 0;
      cam.y = 10;
      cam.z = 28;
      cam.rotY = 0;
      const camEl = document.getElementById('camera');
      const src = camEl && camEl.getObject3D && camEl.getObject3D('camera');
      if (src) {
        src.fov = 100;
        src.aspect = 16 / 9;
        if (typeof src.updateProjectionMatrix === 'function') src.updateProjectionMatrix();
        src.updateMatrixWorld(true);
      }
      if (src && THREE) {
        const eye = src.clone();
        eye.fov = 100;
        eye.aspect = 16 / 9;
        eye.near = 0.05;
        eye.far = 12000;
        eye.updateProjectionMatrix();
        eye.position.copy(src.getWorldPosition(new THREE.Vector3()));
        eye.quaternion.copy(src.getWorldQuaternion(new THREE.Quaternion()));
        eye.updateMatrixWorld(true);
        window.__rtsKitCullForceXr = true;
        window.__rtsKitCullTestCameras = [eye];
      }
    });
    rows.push(await samplePose(page, 'look-hmd-100'));
    await page.evaluate(() => {
      window.__rtsKitCullForceXr = false;
      window.__rtsKitCullTestCameras = null;
    });
    await page.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n=== kit poses ===');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(12)} calls=${r.calls} callsAvg=${r.callsAvg ?? '-'} trisK=${((r.tris || 0) / 1000).toFixed(0)} ` +
        `fps=${r.fps != null ? Number(r.fps).toFixed(0) : '-'} visInst=${r.visInst} instCount=${r.visInstCount} visMesh=${r.visMesh} hook=${r.hookErr} cull=${JSON.stringify(r.cull)}`
    );
  }
  fs.writeFileSync(path.join(ROOT, 'bench-kit-poses.json'), JSON.stringify({ rows }, null, 2));
  const kit = rows.find((r) => r.label === 'look-kit');
  const stars = rows.find((r) => r.label === 'look-stars');
  const close = rows.find((r) => r.label === 'look-close');
  const fp = rows.find((r) => r.label === 'look-fp');
  const fpXr = rows.find((r) => r.label === 'look-fp-xr');
  const hmd = rows.find((r) => r.label === 'look-hmd-100');
  let fail = 0;
  const kitCalls = kit && (kit.callsAvg || kit.calls);
  const starCalls = stars && (stars.callsAvg || stars.calls);
  const closeCalls = close && (close.callsAvg || close.calls);
  if (kit && stars && (stars.visInstCount > 80 || (starCalls && kitCalls && starCalls > kitCalls * 0.45))) {
    console.error('FAIL look-stars still drawing most of the catalog', {
      kitCalls,
      starCalls,
      kitN: kit.visInstCount,
      starN: stars.visInstCount,
    });
    fail = 1;
  }
  if (kit && close && close.visInstCount > kit.visInstCount * 0.75) {
    console.error('FAIL look-close still drawing most instances', {
      kitN: kit.visInstCount,
      closeN: close.visInstCount,
    });
    fail = 1;
  }
  for (const row of [fp, fpXr, hmd]) {
    if (!row) continue;
    const hidden = row.cull && row.cull.hiddenInFront;
    if (hidden > 12) {
      console.error(`FAIL ${row.label} hid meshes in the look cone`, row.cull);
      fail = 1;
    }
    if ((row.visInstCount || 0) + (row.visMesh || 0) < 8) {
      console.error(`FAIL ${row.label} drew almost nothing at eye height`, row);
      fail = 1;
    }
  }
  process.exit(fail);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
