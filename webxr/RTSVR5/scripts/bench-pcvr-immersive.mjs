#!/usr/bin/env node
/**
 * REAL PCVR bench — same process as the old bench-openxr-vd-decay.mjs:
 *   - headed Chrome via Playwright persistent profile
 *   - FIXED port 9100 (VR permission is per-origin; rotating ports re-prompts)
 *   - match prepared on desktop, then a-scene.enterVR()
 *   - sample only while xr.isPresenting
 *
 *   node RTSVR5/scripts/bench-pcvr-immersive.mjs
 *
 * Prereq: headset on, Meta Link / OpenXR (or VD) connected.
 * Env: MODE=1v1|story SAMPLE_MS=4000 STORY_SEED=42 PROJECT=all|RTSVR5|...
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBXR = path.resolve(__dirname, '..', '..');
const ROOT5 = path.join(WEBXR, 'RTSVR5');
const OUT = path.join(ROOT5, 'bench-pcvr-immersive');
/** Same profile the OpenXR/VD benches used — keeps WebXR grants. */
const CHROME_PROFILE = path.join(ROOT5, '.chrome-openxr-vd-poses');
/** Fixed origin — do not rotate ports or the VR grant is lost. */
const PORT = Number(process.env.PORT || 9100);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 4000);
const MODE = (process.env.MODE || '1v1').toLowerCase();
const STORY_SEED = Number(process.env.STORY_SEED || 42) >>> 0;
const WHICH = (process.env.PROJECT || 'all').toLowerCase();
const XR_WAIT_S = Number(process.env.XR_WAIT_S || 60);

const ALL = [
  { id: 'RTSVR4', root: path.join(WEBXR, 'RTSVR4') },
  { id: 'RTSVR5', root: path.join(WEBXR, 'RTSVR5') },
  { id: 'RTSVR5Forest', root: path.join(WEBXR, 'RTSVR5Forest') },
];
const PROJECTS =
  WHICH === 'all' ? ALL : ALL.filter((p) => p.id.toLowerCase() === WHICH || p.id.toLowerCase().includes(WHICH));

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
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pre-allow WebXR for the fixed bench origin so we do not re-prompt. */
function seedVrPermission(profileDir, origin) {
  const def = path.join(profileDir, 'Default');
  fs.mkdirSync(def, { recursive: true });
  const prefsPath = path.join(def, 'Preferences');
  let prefs = {};
  try {
    if (fs.existsSync(prefsPath)) prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  } catch (_) {
    prefs = {};
  }
  prefs.profile = prefs.profile || {};
  prefs.profile.content_settings = prefs.profile.content_settings || {};
  prefs.profile.content_settings.exceptions = prefs.profile.content_settings.exceptions || {};
  prefs.profile.content_settings.exceptions.vr = prefs.profile.content_settings.exceptions.vr || {};
  prefs.profile.content_settings.exceptions.vr[`${origin},*`] = {
    last_modified: String(Date.now() * 1000),
    setting: 1,
  };
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
}

function startStaticServer(root) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(root, rel));
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
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

async function enterImmersiveVr(page) {
  const enterT0 = Date.now();
  await page.evaluate(() => {
    const sc = document.querySelector('a-scene');
    if (!sc || typeof sc.enterVR !== 'function') throw new Error('no a-scene.enterVR');
    const p = sc.enterVR();
    if (p && p.catch) p.catch(() => {});
  });
  for (let i = 0; i < XR_WAIT_S; i++) {
    const on = await page.evaluate(() => {
      const sc = document.querySelector('a-scene');
      const r = sc && sc.renderer;
      return !!(r && r.xr && r.xr.isPresenting) || !!(sc && sc.is && sc.is('vr-mode'));
    });
    if (on) {
      return { entered: true, waitS: (Date.now() - enterT0) / 1000 };
    }
    if (i === 3) console.log('  … waiting for XR (should not need a headset prompt if profile grant is set)');
    if (i > 0 && i % 10 === 0) console.log(`  … still waiting for XR present (${i}s)`);
    await sleep(1000);
  }
  return { entered: false, waitS: (Date.now() - enterT0) / 1000 };
}

async function sampleXrHud(page, shotPath) {
  const t0 = Date.now();
  const rows = [];
  while (Date.now() - t0 < SAMPLE_MS) {
    rows.push(
      await page.evaluate(() => {
        const sc = document.querySelector('a-scene');
        const r = sc && sc.renderer;
        const info = r && r.info && r.info.render;
        const mem = r && r.info && r.info.memory;
        const hud =
          document.getElementById('hud-version-fps') ||
          document.getElementById('rts-version-fps-label');
        let hudText = hud ? hud.textContent || '' : '';
        if (!hudText) {
          try {
            const wrist = document.getElementById('wrist-fps');
            hudText = (wrist && wrist.getAttribute && wrist.getAttribute('value')) || '';
          } catch (_) {}
        }
        const m = /([0-9]+)\s*FPS/.exec(hudText || '');
        const presenting = !!(r && r.xr && r.xr.isPresenting);
        return {
          fpsHud: m ? Number(m[1]) : null,
          hudText,
          calls: info ? info.calls | 0 : -1,
          tris: info ? info.triangles | 0 : -1,
          textures: mem ? mem.textures | 0 : -1,
          presenting,
          version: document.querySelector('meta[name="rts-version"]')?.getAttribute('content') || '?',
        };
      })
    );
    await sleep(200);
  }
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  await page.screenshot({ path: shotPath, fullPage: false });
  const xrRows = rows.filter((x) => x.presenting);
  if (!xrRows.length) {
    throw new Error('sample window had zero XR-presenting frames — not a PCVR measurement');
  }
  const fpsVals = xrRows.map((x) => x.fpsHud).filter((x) => x != null && x > 0);
  const last = xrRows[xrRows.length - 1];
  return {
    samples: xrRows.length,
    dropped2dSamples: rows.length - xrRows.length,
    fpsHudAvg: fpsVals.length ? fpsVals.reduce((a, b) => a + b, 0) / fpsVals.length : null,
    fpsHudMin: fpsVals.length ? Math.min(...fpsVals) : null,
    fpsHudMax: fpsVals.length ? Math.max(...fpsVals) : null,
    fpsHudLast: last.fpsHud,
    callsLast: last.calls,
    trisK: last.tris >= 0 ? Math.round(last.tris / 1000) : null,
    textures: last.textures,
    hudText: last.hudText,
    version: last.version,
    xrPresenting: true,
    screenshot: path.relative(WEBXR, shotPath).split(path.sep).join('/'),
  };
}

async function startMatch(page) {
  if (MODE === 'story') {
    await page.evaluate(() => {
      window._startGame('story');
    });
  } else {
    await page.evaluate(() => {
      window._startGame('1v1');
    });
  }
  await page.waitForFunction(() => {
    const overlay = document.getElementById('match-prepare-overlay');
    return !(overlay && !overlay.hidden);
  }, null, { timeout: 300000 });
  await sleep(2000);
  await page.evaluate(async (mode) => {
    const State = await import('./js/state.js');
    const Input = await import('./js/input.js');
    const UI = await import('./js/ui.js');
    if (!State.gameSession.gameStarted) throw new Error('match did not start');
    if (typeof UI.setMinimapVisible === 'function') UI.setMinimapVisible(true);
    if (mode === '1v1') {
      const Units = await import('./js/units.js');
      const myId = State.gameSession.myPlayerId;
      const spawn = State.players[myId]?.spawn || { x: 40, z: 40 };
      const types = ['rifleman', 'lightTank', 'heavyTank', 'artillery', 'engineer', 'harvester'];
      for (let i = 0; i < 24; i++) {
        const ang = (i / 24) * Math.PI * 2;
        Units.createUnit(types[i % types.length], myId, spawn.x + Math.cos(ang) * 16, spawn.z + Math.sin(ang) * 16, {
          skipCapCheck: true,
          skipProducedStat: true,
        });
      }
    }
    Input.positionCameraForPlayer(State.gameSession.myPlayerId);
  }, MODE);
  await sleep(800);
}

async function benchProject(proj, context) {
  const shotDir = path.join(OUT, 'screenshots', proj.id);
  fs.mkdirSync(shotDir, { recursive: true });
  const server = await startStaticServer(proj.root);
  const page = context.pages()[0] || (await context.newPage());
  const result = { id: proj.id, version: null, poses: [], error: null, enter: null };
  try {
    const q = MODE === 'story' ? `?perf=1&storySeed=${STORY_SEED}` : '?perf=1';
    const url = `http://127.0.0.1:${PORT}/index.html${q}`;
    console.log(`\n=== PCVR immersive ${proj.id} ${MODE} ${url} ===`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 180000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    });
    await sleep(1000);

    await startMatch(page);

    result.enter = await enterImmersiveVr(page);
    console.log(`${proj.id} enterVR`, JSON.stringify(result.enter));
    if (!result.enter.entered) {
      throw new Error(`failed to enter immersive VR after ${result.enter.waitS}s — headset on / Link connected?`);
    }

    await sleep(1500);
    const center = await sampleXrHud(page, path.join(shotDir, `01-${MODE}-look-center-xr.png`));
    result.version = center.version;
    result.poses.push({ pose: `${MODE}-look-center-xr`, ...center });
    console.log(
      `${proj.id} XR look-center HUD ${center.fpsHudAvg?.toFixed(0)} fps d=${center.callsLast} tK=${center.trisK} | ${center.hudText}`
    );

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
      const cam = Input.getCameraState();
      cam.rotY += Math.PI;
    });
    await sleep(800);
    const out = await sampleXrHud(page, path.join(shotDir, `02-${MODE}-look-out-xr.png`));
    result.poses.push({ pose: `${MODE}-look-out-xr`, ...out });
    console.log(
      `${proj.id} XR look-out HUD ${out.fpsHudAvg?.toFixed(0)} fps d=${out.callsLast} tK=${out.trisK}`
    );

    await page.evaluate(async () => {
      const sc = document.querySelector('a-scene');
      if (sc && typeof sc.exitVR === 'function') {
        try {
          await sc.exitVR();
        } catch (_) {}
      }
    });
    await sleep(1500);
  } catch (err) {
    result.error = String(err && err.stack ? err.stack : err);
    console.error(proj.id, 'FAIL', result.error);
  } finally {
    server.close();
    await sleep(500);
  }
  return result;
}

async function main() {
  if (!PROJECTS.length) {
    console.error('No projects matched PROJECT=', WHICH);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  const origin = `http://127.0.0.1:${PORT}`;
  seedVrPermission(CHROME_PROFILE, origin);

  console.log('PCVR immersive bench — persistent profile + enterVR (fixed port)');
  console.log(`profile: ${CHROME_PROFILE}`);
  console.log(`origin:  ${origin}  (do not rotate ports)`);
  console.log(`MODE=${MODE} projects=${PROJECTS.map((p) => p.id).join(',')}`);

  const context = await chromium.launchPersistentContext(CHROME_PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1600, height: 900 },
    args: [
      '--use-gl=angle',
      '--ignore-gpu-blocklist',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      // Playwright also injects --no-sandbox (needed for fast Meta Link enterVR on this PC).
    ],
  });

  const results = [];
  for (const proj of PROJECTS) {
    results.push(await benchProject(proj, context));
  }
  await context.close();

  const pack = {
    when: new Date().toISOString(),
    method: {
      harness: 'RTSVR5/scripts/bench-pcvr-immersive.mjs',
      requires: 'immersive-vr WebXR (Meta Link / OpenXR / VD)',
      chromeProfile: CHROME_PROFILE,
      fixedPort: PORT,
      fixedOrigin: origin,
      rejects2d: true,
      noEphemeralProfile: true,
      mode: MODE,
      sampleMs: SAMPLE_MS,
    },
    projects: results,
  };
  const jsonPath = path.join(OUT, `bench-pcvr-immersive-${MODE}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(pack, null, 2));
  fs.writeFileSync(path.join(OUT, 'bench-pcvr-immersive.json'), JSON.stringify(pack, null, 2));

  console.log('\n=== PCVR immersive HUD (XR presenting only) ===');
  for (const p of results) {
    if (p.error) {
      console.log(`${p.id}: FAIL — ${p.error.split('\n')[0]}`);
      continue;
    }
    for (const row of p.poses) {
      console.log(
        `${p.id} ${row.pose}: ${row.fpsHudAvg?.toFixed(0)} fps (min ${row.fpsHudMin}) d=${row.callsLast} tK=${row.trisK}`
      );
    }
  }
  console.log(`\nWrote ${jsonPath}`);
  if (results.some((r) => r.error) || !results.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
