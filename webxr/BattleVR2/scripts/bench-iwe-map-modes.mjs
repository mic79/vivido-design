#!/usr/bin/env node
/**
 * BattleVR2 VR bench via Immersive Web Emulator (Chrome extension).
 * Headed Chrome + extension → match on desktop → a-scene.enterVR() →
 * sample ONLY while renderer.xr.isPresenting (HUD must show XR, not 2D).
 *
 *   node BattleVR2/scripts/bench-iwe-map-modes.mjs
 *   SAMPLE_MS=5000 MODE=1v1,2v2 MAP=hera,canyon node BattleVR2/scripts/bench-iwe-map-modes.mjs
 *
 * Fixed port 9100 (VR permission / extension origin). Do not rotate ports.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'bench-out', 'iwe-map-modes');
const CHROME_PROFILE = path.join(ROOT, '.chrome-iwe-bench');
const PORT = Number(process.env.PORT || 9100);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 5000);
const XR_WAIT_S = Number(process.env.XR_WAIT_S || 45);
const MAPS = (process.env.MAP || 'hera,canyon')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MODES = (process.env.MODE || '1v1,2v2')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const IWE_ID = 'cgffilbpcibhmcfbgggfhfolhkfbhmik';
function findIweExtensionPath() {
  if (process.env.IWE_EXT_PATH && fs.existsSync(process.env.IWE_EXT_PATH)) {
    return process.env.IWE_EXT_PATH;
  }
  const base = path.join(
    process.env.LOCALAPPDATA || '',
    'Google',
    'Chrome',
    'User Data',
    'Default',
    'Extensions',
    IWE_ID
  );
  if (!fs.existsSync(base)) return null;
  const vers = fs
    .readdirSync(base)
    .map((n) => path.join(base, n))
    .filter((p) => fs.existsSync(path.join(p, 'manifest.json')));
  vers.sort();
  return vers.length ? vers[vers.length - 1] : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
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
    if (p && p.catch) p.catch((e) => console.warn('[IWE bench] enterVR', e));
  });
  for (let i = 0; i < XR_WAIT_S; i++) {
    const on = await page.evaluate(() => {
      const sc = document.querySelector('a-scene');
      const r = sc && sc.renderer;
      return !!(r && r.xr && r.xr.isPresenting) || !!(sc && sc.is && sc.is('vr-mode'));
    });
    if (on) return { entered: true, waitS: (Date.now() - enterT0) / 1000 };
    if (i === 2) console.log('  … waiting for IWE XR present');
    if (i > 0 && i % 10 === 0) console.log(`  … still waiting (${i}s)`);
    await sleep(1000);
  }
  return { entered: false, waitS: (Date.now() - enterT0) / 1000 };
}

async function sampleXr(page, shotPath) {
  const t0 = Date.now();
  const rows = [];
  while (Date.now() - t0 < SAMPLE_MS) {
    rows.push(
      await page.evaluate(() => {
        const sc = document.querySelector('a-scene');
        const r = sc && sc.renderer;
        const info = r && r.info && r.info.render;
        const mem = r && r.info && r.info.memory;
        const hud = document.getElementById('hud-version-fps');
        const hudText = hud ? hud.textContent || '' : '';
        const m = /([0-9]+)\s*FPS/.exec(hudText || '');
        const presenting = !!(r && r.xr && r.xr.isPresenting);
        const xrTag = /\bXR\b/.test(hudText);
        const tag2d = /\b2D\b/.test(hudText);
        const perf = window.__rtsPerf?.snapshot?.() || null;
        const dbg = window.__BATTLEVR2_DEBUG__?.() || null;
        return {
          fpsHud: m ? Number(m[1]) : null,
          hudText,
          calls: info ? info.calls | 0 : -1,
          tris: info ? info.triangles | 0 : -1,
          textures: mem ? mem.textures | 0 : -1,
          presenting,
          xrTag,
          tag2d,
          fpsPerf: perf?.fps ?? null,
          cpuFrame: perf?.avgMs?.frame ?? null,
          buildings: dbg?.buildings ?? null,
          units: dbg?.units ?? null,
        };
      })
    );
    await sleep(200);
  }
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  await page.screenshot({ path: shotPath, fullPage: false });
  const xrRows = rows.filter((x) => x.presenting);
  if (!xrRows.length) {
    throw new Error('sample window had zero XR-presenting frames — IWE not presenting');
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
    fpsPerf: last.fpsPerf,
    cpuFrame: last.cpuFrame,
    callsLast: last.calls,
    trisK: last.tris >= 0 ? Math.round(last.tris / 1000) : null,
    textures: last.textures,
    hudText: last.hudText,
    xrPresenting: true,
    hudShowsXr: !!last.xrTag && !last.tag2d,
  };
}

async function waitBoot(page, timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    // Require __rtsReady so lobby boot finished (avoids Canyon race: match spawn
    // before lobby showcase → extra base in the sample).
    const ok = await page.evaluate(
      () =>
        !!(
          window.__SCENE_READY__ &&
          window.__rtsReady &&
          (window.__BATTLEVR2_BOOT__ || true)
        )
    );
    if (ok) return true;
    await sleep(400);
  }
  return false;
}

async function waitMatch(page, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const snap = await page.evaluate(() => {
      const m = window.__BATTLEVR2_MATCH__;
      const d = window.__BATTLEVR2_DEBUG__?.();
      return { match: !!m, units: d?.units ?? m?.units ?? 0 };
    });
    if (snap.match && snap.units > 0) return snap;
    await sleep(500);
  }
  return null;
}

async function applyPose(page, poseId) {
  if (poseId === 'spawn') return;
  if (poseId === 'midfield') {
    await page.evaluate(() => {
      const rig = document.getElementById('cameraRig');
      // Match headless bench-map-modes (Canyon floor ~y=100 — eye high).
      if (rig?.object3D) rig.object3D.position.set(0, 40, 0);
    });
    return;
  }
  if (poseId === 'look-army') {
    await page.evaluate(() => {
      const dbg = window.__BATTLEVR2_DEBUG__?.();
      const rig = document.getElementById('cameraRig');
      if (!rig?.object3D) return;
      const x = dbg?.vehicle?.x ?? 40;
      const z = dbg?.vehicle?.z ?? 40;
      rig.object3D.position.set(x, 55, z + 35);
      rig.object3D.rotation.set(-0.45, 0.2, 0);
    });
  }
}

async function benchOne(page, map, mode) {
  const label = `${map}_${mode}`;
  const q = `?perf=1&map=${encodeURIComponent(map)}`;
  const url = `http://127.0.0.1:${PORT}/${q}`;
  console.log(`\n=== IWE VR ${label} ${url} ===`);
  const result = {
    map,
    mode,
    url,
    enter: null,
    poses: [],
    ok: false,
    error: null,
  };

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  if (!(await waitBoot(page, map === 'canyon' ? 240000 : 120000))) {
    throw new Error('boot timeout');
  }
  await page.evaluate(() => {
    window._dismissAppStartGate?.();
  });
  await sleep(800);

  await page.evaluate(async (m) => {
    if (typeof window._startGame === 'function') await window._startGame(m);
  }, mode);
  const match = await waitMatch(page, map === 'canyon' ? 300000 : 180000);
  if (!match) throw new Error('match did not start');
  // Short settle — long waits used to overlap the old lobby-showcase race on Canyon.
  await sleep(1500);
  const ent = await page.evaluate(() => window.__BATTLEVR2_DEBUG__?.() || null);
  if (!ent || ent.buildings > 4 || ent.units > 16) {
    throw new Error(
      `match content not clean (need ~2 bldg / ~11 units): b=${ent?.buildings} u=${ent?.units}`
    );
  }

  result.enter = await enterImmersiveVr(page);
  console.log(`  enterVR`, JSON.stringify(result.enter));
  if (!result.enter.entered) {
    throw new Error(`IWE XR not presenting after ${result.enter.waitS}s — is Immersive Web Emulator loaded?`);
  }
  await sleep(1200);

  for (const poseId of ['spawn', 'midfield', 'look-army']) {
    await applyPose(page, poseId);
    await sleep(500);
    const shot = path.join(OUT, 'screenshots', `${label}_${poseId}.png`);
    const sample = await sampleXr(page, shot);
    result.poses.push({ pose: poseId, ...sample });
    console.log(
      `  ${poseId}: ${sample.fpsHudAvg?.toFixed(0) ?? '?'} FPS XR  d=${sample.callsLast} tK=${sample.trisK} hud=${sample.hudShowsXr ? 'XR' : '?'} | ${sample.hudText}`
    );
  }

  await page.evaluate(async () => {
    const sc = document.querySelector('a-scene');
    if (sc && typeof sc.exitVR === 'function') {
      try {
        await sc.exitVR();
      } catch (_) {}
    }
  });
  await sleep(800);
  result.ok = result.poses.every((p) => p.xrPresenting && p.fpsHudAvg != null);
  return result;
}

async function main() {
  const extPath = findIweExtensionPath();
  if (!extPath) {
    console.error(
      'Immersive Web Emulator not found.\n' +
        `Expected under Chrome Extensions/${IWE_ID}\n` +
        'Install from Chrome Web Store, or set IWE_EXT_PATH.'
    );
    process.exit(2);
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(CHROME_PROFILE, { recursive: true });
  const origin = `http://127.0.0.1:${PORT}`;
  seedVrPermission(CHROME_PROFILE, origin);

  console.log('BattleVR2 IWE VR bench');
  console.log(`extension: ${extPath}`);
  console.log(`profile:   ${CHROME_PROFILE}`);
  console.log(`origin:    ${origin} (fixed)`);
  console.log(`maps=${MAPS.join(',')} modes=${MODES.join(',')} sampleMs=${SAMPLE_MS}`);

  let server;
  try {
    server = await startStaticServer(ROOT);
  } catch (err) {
    if (String(err.message || err).includes('EADDRINUSE')) {
      console.error(`Port ${PORT} in use — free it or set PORT= (keep fixed per profile).`);
    }
    throw err;
  }

  const context = await chromium.launchPersistentContext(CHROME_PROFILE, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1600, height: 900 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--use-gl=angle',
      '--ignore-gpu-blocklist',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
    ],
  });

  const page = context.pages()[0] || (await context.newPage());
  const results = [];

  try {
    for (const map of MAPS) {
      for (const mode of MODES) {
        try {
          results.push(await benchOne(page, map, mode));
        } catch (err) {
          const msg = String(err?.stack || err);
          console.error(`FAIL ${map}_${mode}`, msg);
          results.push({ map, mode, ok: false, error: msg, poses: [] });
          try {
            await page.screenshot({ path: path.join(OUT, 'screenshots', `${map}_${mode}_FAIL.png`) });
          } catch (_) {
            /* */
          }
          // Try exit VR so next case can recover.
          try {
            await page.evaluate(async () => {
              const sc = document.querySelector('a-scene');
              if (sc?.exitVR) await sc.exitVR();
            });
          } catch (_) {
            /* */
          }
        }
      }
    }
  } finally {
    await context.close();
    server.close();
  }

  const summary = results.map((r) => {
    const spawn = r.poses?.find((p) => p.pose === 'spawn');
    const mid = r.poses?.find((p) => p.pose === 'midfield');
    const army = r.poses?.find((p) => p.pose === 'look-army');
    const fmt = (p) =>
      p
        ? `${p.fpsHudAvg != null ? p.fpsHudAvg.toFixed(0) : '?'} FPS · d=${p.callsLast} · tK=${p.trisK}`
        : '—';
    return {
      map: r.map,
      mode: r.mode,
      ok: r.ok,
      enterS: r.enter?.waitS ?? null,
      spawn: fmt(spawn),
      midfield: fmt(mid),
      lookArmy: fmt(army),
      spawnFps: spawn?.fpsHudAvg ?? null,
      spawnDraws: spawn?.callsLast ?? null,
      spawnTrisK: spawn?.trisK ?? null,
      hudXr: spawn?.hudShowsXr ?? null,
      error: r.error || null,
    };
  });

  const pack = {
    when: new Date().toISOString(),
    method: {
      harness: 'BattleVR2/scripts/bench-iwe-map-modes.mjs',
      requires: 'Immersive Web Emulator Chrome extension + headed Chrome',
      extensionId: IWE_ID,
      extensionPath: extPath,
      chromeProfile: CHROME_PROFILE,
      fixedPort: PORT,
      rejects2d: true,
      sampleMs: SAMPLE_MS,
      host: os.hostname(),
    },
    summary,
    results,
    ok: results.every((r) => r.ok),
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(pack, null, 2));

  const md = [
    '# BattleVR2 IWE VR bench (Immersive Web Emulator)',
    '',
    `${pack.when} · sample ${SAMPLE_MS}ms · HUD FPS while \`xr.isPresenting\``,
    '',
    '| Map | Mode | Spawn | Midfield | Look-army | Enter s |',
    '| --- | --- | --- | --- | --- | ---: |',
  ];
  for (const s of summary) {
    md.push(
      `| ${s.map} | ${s.mode} | ${s.spawn} | ${s.midfield} | ${s.lookArmy} | ${
        s.enterS != null ? s.enterS.toFixed(1) : '—'
      } |`
    );
  }
  fs.writeFileSync(path.join(OUT, 'SUMMARY.md'), md.join('\n') + '\n');
  console.log('\n' + md.join('\n'));
  console.log('\nWrote', path.join(OUT, 'report.json'));
  process.exit(pack.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
