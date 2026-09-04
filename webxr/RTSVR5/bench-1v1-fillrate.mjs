#!/usr/bin/env node
/**
 * Prove why 1v1 can feel slower than Story despite fewer draws:
 * camera height + sky/HDR fill vs dense kit occlusion.
 *
 *   node RTSVR5/bench-1v1-fillrate.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8778);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 1800);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
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

async function sample(page, label) {
  await page.evaluate(() => {
    window.__rtsForceRender = true;
    const sc = document.querySelector('a-scene');
    if (sc) sc.__rtsSkipRender = false;
    if (window.__rtsPerf) {
      window.__rtsPerf.setPerfEnabled(true);
      window.__rtsPerf.resetSamples();
    }
  });
  await sleep(SAMPLE_MS);
  return page.evaluate(() => {
    const sc = document.querySelector('a-scene');
    const r = sc && sc.renderer;
    const cam = sc && sc.camera;
    const scene = sc && sc.object3D;
    if (r && scene && cam) {
      r.info.reset();
      r.render(scene, cam);
    }
    const Input = window.__benchCam;
    const perf = window.__rtsPerf ? window.__rtsPerf.snapshot() : null;
    const gpu = (perf && perf.gpu) || {};
    let bg = null;
    let env = false;
    if (scene) {
      bg = scene.background
        ? scene.background.isColor
          ? 'color'
          : scene.background.isTexture
            ? 'texture'
            : typeof scene.background
        : null;
      env = !!scene.environment;
    }
    return {
      camY: Input ? Input.y : null,
      calls: r && r.info.render ? r.info.render.calls : 0,
      tris: r && r.info.render ? r.info.render.triangles : 0,
      tex: r && r.info.memory ? r.info.memory.textures : 0,
      fps: perf && (perf.fpsAvg ?? perf.fps),
      callsAvg: gpu.callsAvg,
      fogCpu: perf && perf.avgMs ? perf.avgMs['render.fogOverlay'] : null,
      bg,
      env,
      kind: (() => {
        const g = document.getElementById('ground');
        const m = g && g.getObject3D && g.getObject3D('mesh');
        return m && m.userData && m.userData.rtsKitKind;
      })(),
    };
  });
}

async function startMode(page, mode) {
  await page.evaluate(async (m) => {
    if (typeof window._setDynamicShadowsEnabled === 'function') window._setDynamicShadowsEnabled(false);
    if (typeof window._setMsaa4xEnabled === 'function') window._setMsaa4xEnabled(false);
    window._startGame(m);
  }, mode);
  await page.waitForFunction(() => {
    const overlay = document.getElementById('match-prepare-overlay');
    return !(overlay && !overlay.hidden);
  }, null, { timeout: 300000 });
  await sleep(600);
  await page.evaluate(async () => {
    const Input = await import('./js/input.js');
    window.__benchCam = Input.getCameraState();
    Input.positionCameraForPlayer(0);
  });
  await sleep(200);
}

async function setCam(page, y, lookOut) {
  await page.evaluate(
    async ({ y, lookOut }) => {
      const Input = await import('./js/input.js');
      const cam = Input.getCameraState();
      Input.positionCameraForPlayer(0);
      cam.y = y;
      if (lookOut) {
        // yaw away from center (add π)
        cam.rotY += Math.PI;
      }
      // poke apply
      cam.x += 0.001;
      cam.x -= 0.001;
      if (typeof Input.applyCameraRigIfChanged === 'function') Input.applyCameraRigIfChanged();
      else {
        // force via tiny move API if exported
        const el = document.getElementById('cameraRig');
        if (el) {
          el.object3D.position.set(cam.x, cam.y, cam.z);
          el.object3D.rotation.y = cam.rotY;
        }
      }
      window.__benchCam = cam;
    },
    { y, lookOut }
  );
  await sleep(100);
}

async function main() {
  const server = await startStaticServer();
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
  });
  const rows = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('console', (msg) => {
      const t = msg.text();
      if (/kit ready|overview kit file|cam/i.test(t)) console.log('  [page]', t);
    });
    await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    });

    await startMode(page, '1v1');
    const defaultCam = await page.evaluate(() => {
      const c = window.__benchCam;
      return c ? { x: c.x, y: c.y, z: c.z, rotY: c.rotY } : null;
    });
    console.log('1v1 default cam', defaultCam);

    let s = await sample(page, '1v1-default');
    rows.push({ label: '1v1-default', ...s });

    await setCam(page, 42, false);
    s = await sample(page, '1v1-y42');
    rows.push({ label: '1v1-y42', ...s });

    await setCam(page, 68, true);
    s = await sample(page, '1v1-y68-out');
    rows.push({ label: '1v1-y68-out', ...s });

    // Kill HDR background — solid color (fillrate ablation)
    await page.evaluate(() => {
      const sc = document.querySelector('a-scene');
      const THREE = window.THREE;
      if (sc && sc.object3D && THREE) {
        window.__rtsSavedBg = sc.object3D.background;
        sc.object3D.background = new THREE.Color(0x05070c);
      }
    });
    await setCam(page, 68, true);
    s = await sample(page, '1v1-y68-out-nobg');
    rows.push({ label: '1v1-y68-out-nobg', ...s });

    await page.evaluate(() => {
      const sc = document.querySelector('a-scene');
      if (sc && sc.object3D && window.__rtsSavedBg) sc.object3D.background = window.__rtsSavedBg;
    });

    await startMode(page, 'story');
    const storyCam = await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
      const c = Input.getCameraState();
      return { x: c.x, y: c.y, z: c.z, rotY: c.rotY };
    });
    console.log('story default cam', storyCam);
    s = await sample(page, 'story-default');
    rows.push({ label: 'story-default', ...s });
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n=== fillrate / camera probes ===');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(22)} kind=${String(r.kind).padEnd(8)} camY=${r.camY} ` +
        `calls=${r.calls} trisK=${((r.tris || 0) / 1000).toFixed(0)} fps=${r.fps != null ? Number(r.fps).toFixed(0) : '-'} ` +
        `bg=${r.bg} env=${r.env} fogCpu=${r.fogCpu != null ? Number(r.fogCpu).toFixed(2) : '-'}`
    );
  }
  fs.writeFileSync(path.join(ROOT, 'bench-1v1-fillrate.json'), JSON.stringify({ rows }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
