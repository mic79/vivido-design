#!/usr/bin/env node
/**
 * Side-by-side spawn HUD sample: DriveVR5 dirt road vs RTSVR5Forest 1v1.
 * Headed Chrome, flatscreen first (fast facts). Set XR=1 for immersive (needs headset).
 *
 *   node RTSVR5/scripts/bench-drive-vs-forest.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBXR = path.resolve(__dirname, '..', '..');
const OUT = path.join(WEBXR, 'RTSVR5', 'bench-drive-vs-forest');
const PORT = Number(process.env.PORT || 9120);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 5000);
const WANT_XR = process.env.XR === '1';
const PROFILE = path.join(WEBXR, 'RTSVR5', '.chrome-openxr-vd-poses');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.exr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(root) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(root, rel));
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('nf');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function samplePage(page) {
  const t0 = Date.now();
  const rows = [];
  while (Date.now() - t0 < SAMPLE_MS) {
    rows.push(
      await page.evaluate(() => {
        const sc = document.querySelector('a-scene');
        let renderer =
          (sc && sc.renderer) ||
          window.__driveRenderer ||
          window.renderer ||
          window.__THREE_RENDERER ||
          null;
        const info = renderer && renderer.info && renderer.info.render;
        const mem = renderer && renderer.info && renderer.info.memory;
        const presenting = !!(renderer && renderer.xr && renderer.xr.isPresenting);
        let fps = null;
        const fpsEl = document.getElementById('fpsText');
        const hud =
          document.getElementById('hud-version-fps') ||
          fpsEl ||
          document.getElementById('fps') ||
          document.getElementById('fpsCounter');
        let txt = (hud && (hud.textContent || hud.innerText)) || '';
        if (fpsEl && fpsEl.textContent) txt = fpsEl.textContent;
        const m = /([0-9]+(?:\.[0-9]+)?)\s*FPS/i.exec(txt) || /FPS[:\s]+([0-9]+)/i.exec(txt);
        if (m) fps = Number(m[1]);
        // DriveVR5 keeps renderer in a closure — expose via canvas WebGL if needed
        if ((!renderer || !info) && document.querySelector('canvas')) {
          /* leave calls/tris unknown unless window.renderer exists */
        }
        return {
          fps,
          hud: txt.slice(0, 200),
          calls: info ? info.calls | 0 : -1,
          tris: info ? info.triangles | 0 : -1,
          textures: mem ? mem.textures | 0 : -1,
          geometries: mem ? mem.geometries | 0 : -1,
          presenting,
          title: document.title,
          driveReady: document.body.classList.contains('drivevr-game-started'),
          rtsReady: !!window.__rtsReady,
        };
      })
    );
    await sleep(200);
  }
  const last = rows[rows.length - 1] || {};
  const fpsVals = rows.map((x) => x.fps).filter((x) => x != null && x > 0);
  return {
    samples: rows.length,
    fpsAvg: fpsVals.length ? fpsVals.reduce((a, b) => a + b, 0) / fpsVals.length : null,
    fpsMin: fpsVals.length ? Math.min(...fpsVals) : null,
    fpsLast: last.fps,
    callsLast: last.calls,
    trisK: last.tris >= 0 ? Math.round(last.tris / 1000) : null,
    textures: last.textures,
    geometries: last.geometries,
    presenting: last.presenting,
    hud: last.hud,
    driveReady: last.driveReady,
    rtsReady: last.rtsReady,
  };
}

async function benchDrive(context) {
  const root = path.join(WEBXR, 'DriveVR5');
  const server = await startServer(root);
  const page = context.pages()[0] || (await context.newPage());
  const url = `http://127.0.0.1:${PORT}/index.html`;
  console.log('\n=== DriveVR5', url, '===');
  const tLoad = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  // Splash must become ready (env GLB + BVH/physics), then Start.
  await page.waitForFunction(
    () => window.__driveVrSplash && typeof window.__driveVrSplash.isReady === 'function' && window.__driveVrSplash.isReady(),
    null,
    { timeout: 600000 }
  );
  console.log('DriveVR5 splash ready in', Date.now() - tLoad, 'ms');
  await page.evaluate(() => {
    if (window.__driveVrSplash && window.__driveVrSplash.beginGameIfReady) {
      window.__driveVrSplash.beginGameIfReady();
    }
  });
  await page.waitForFunction(() => document.body.classList.contains('drivevr-game-started'), null, {
    timeout: 60000,
  });
  // Wait until FPS HUD is live and renderer is drawing the forest.
  await page.waitForFunction(
    () => {
      const fpsEl = document.getElementById('fpsText');
      const fpsOk = fpsEl && /[1-9][0-9]*\s*FPS/.test(fpsEl.textContent || '');
      return !!fpsOk;
    },
    null,
    { timeout: 180000 }
  );
  await sleep(4000);
  const loadMs = Date.now() - tLoad;
  if (WANT_XR) {
    await page.waitForFunction(
      () => {
        const b = document.getElementById('vrButton');
        return b && b.style.display !== 'none' && !b.disabled;
      },
      null,
      { timeout: 60000 }
    );
    await page.locator('#vrButton').click({ force: true });
    for (let i = 0; i < 60; i++) {
      const on = await page.evaluate(() => {
        const r = window.__driveRenderer || window.renderer;
        return !!(r && r.xr && r.xr.isPresenting);
      });
      if (on) {
        console.log(`  DriveVR5 XR presenting in ${i}s`);
        break;
      }
      if (i === 3) console.log('  … waiting DriveVR5 XR present');
      await sleep(1000);
    }
  }
  const shot = path.join(OUT, 'drivevr5-spawn.png');
  await page.screenshot({ path: shot, fullPage: false });
  const sample = await samplePage(page);
  const probe = await page.evaluate(() => {
    const r = window.__driveRenderer || window.renderer;
    const scene = window.__driveScene || window.scene;
    const info = r && r.info && r.info.render;
    const mem = r && r.info && r.info.memory;
    let meshCount = 0;
    let bvhMeshCount = 0;
    let geoTris = 0;
    try {
      if (scene) {
        scene.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          meshCount++;
          if (o.geometry.boundsTree) bvhMeshCount++;
          const g = o.geometry;
          const idx = g.index;
          const pos = g.attributes && g.attributes.position;
          if (idx) geoTris += idx.count / 3;
          else if (pos) geoTris += pos.count / 3;
        });
      }
    } catch (_) {}
    const fpsText = (document.getElementById('fpsText') || {}).textContent || '';
    return {
      hasAmmo: typeof window.Ammo !== 'undefined',
      fpsText,
      meshCount,
      bvhMeshCount,
      sceneTrisK: Math.round(geoTris / 1000),
      calls: info ? info.calls : null,
      tris: info ? info.triangles : null,
      textures: mem ? mem.textures : null,
      geometries: mem ? mem.geometries : null,
      presenting: !!(r && r.xr && r.xr.isPresenting),
      gameStarted: document.body.classList.contains('drivevr-game-started'),
    };
  });
  server.close();
  await sleep(400);
  return { id: 'DriveVR5', loadMs, sample, probe, screenshot: shot };
}

async function benchForest(context) {
  const root = path.join(WEBXR, 'RTSVR5Forest');
  const server = await startServer(root);
  const page = context.pages()[0] || (await context.newPage());
  const url = `http://127.0.0.1:${PORT}/index.html?perf=1`;
  console.log('\\n=== RTSVR5Forest', url, '===');
  const tLoad = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 180000 });
  await page.evaluate(() => {
    if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    window._startGame('1v1');
  });
  await page.waitForFunction(() => {
    const o = document.getElementById('match-prepare-overlay');
    return !(o && !o.hidden);
  }, null, { timeout: 300000 });
  await sleep(2000);
  const loadMs = Date.now() - tLoad;
  if (WANT_XR) {
    await page.evaluate(() => {
      const sc = document.querySelector('a-scene');
      if (sc && sc.enterVR) {
        const p = sc.enterVR();
        if (p && p.catch) p.catch(() => {});
      }
    });
    for (let i = 0; i < 30; i++) {
      const on = await page.evaluate(() => {
        const sc = document.querySelector('a-scene');
        return !!(sc && sc.renderer && sc.renderer.xr && sc.renderer.xr.isPresenting);
      });
      if (on) break;
      await sleep(1000);
    }
  }
  const shot = path.join(OUT, 'rtsvr5forest-1v1.png');
  await page.screenshot({ path: shot, fullPage: false });
  const sample = await samplePage(page);
  const probe = await page.evaluate(async () => {
    let nav = null;
    try {
      const C = await import('./js/config.js');
      nav = {
        MAP_SIZE: C.MAP_SIZE,
        MAP_NAV_PLANE_CELL: C.MAP_NAV_PLANE_CELL,
        MAP_NAV_PLANE_COLS: C.MAP_NAV_PLANE_COLS,
        MAP_UNIT_NAV_RADIUS: C.MAP_UNIT_NAV_RADIUS,
        NAV_MAX_TRAVERSABLE_SLOPE_DEG: C.NAV_MAX_TRAVERSABLE_SLOPE_DEG,
      };
    } catch (e) {
      nav = { err: String(e) };
    }
    const sc = document.querySelector('a-scene');
    const r = sc && sc.renderer;
    return {
      nav,
      hasAmmo: typeof window.Ammo !== 'undefined',
      tris: r && r.info ? r.info.render.triangles : null,
      calls: r && r.info ? r.info.render.calls : null,
      textures: r && r.info && r.info.memory ? r.info.memory.textures : null,
    };
  });
  server.close();
  await sleep(400);
  return { id: 'RTSVR5Forest', loadMs, sample, probe, screenshot: shot };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  console.log('DriveVR5 vs RTSVR5Forest bench XR=', WANT_XR);
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1600, height: 900 },
    args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--mute-audio'],
  });
  const only = (process.env.ONLY || 'both').toLowerCase();
  const results = [];
  if (only === 'drive' || only === 'both') results.push(await benchDrive(context));
  if (only === 'forest' || only === 'both') results.push(await benchForest(context));
  await context.close();
  const pack = { when: new Date().toISOString(), XR: WANT_XR, PORT, SAMPLE_MS, results };
  const outPath = path.join(OUT, 'bench-drive-vs-forest.json');
  fs.writeFileSync(outPath, JSON.stringify(pack, null, 2));
  console.log('\\n=== SUMMARY ===');
  for (const r of results) {
    console.log(
      r.id,
      'loadMs=',
      r.loadMs,
      'fps=',
      r.sample.fpsAvg?.toFixed?.(1) ?? r.sample.fpsAvg,
      'd=',
      r.sample.callsLast,
      'tK=',
      r.sample.trisK,
      'tex=',
      r.sample.textures,
      'XR=',
      r.sample.presenting,
      'probe=',
      JSON.stringify(r.probe)
    );
  }
  console.log('Wrote', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
