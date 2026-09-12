#!/usr/bin/env node
/**
 * PCVR-path 1v1 bench = headed Google Chrome (vsync on).
 * Same method as bench-story-chrome-headed.mjs / RTSVR4/bench-chrome-headed.mjs.
 *
 *   node RTSVR5/scripts/bench-1v1-chrome-headed.mjs
 *
 * Env: SAMPLE_MS=4000
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBXR = path.resolve(__dirname, '..', '..');
const OUT = path.join(WEBXR, 'RTSVR5', 'bench-1v1-chrome-headed');
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 4000);

const PROJECTS = [
  { id: 'RTSVR4', root: path.join(WEBXR, 'RTSVR4'), port: 8804 },
  { id: 'RTSVR5', root: path.join(WEBXR, 'RTSVR5'), port: 8805 },
  { id: 'RTSVR5Forest', root: path.join(WEBXR, 'RTSVR5Forest'), port: 8806 },
];

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

function startStaticServer(root, port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
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
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sampleHud(page, shotPath) {
  await page.evaluate(() => {
    if (window.__rtsPerf && typeof window.__rtsPerf.resetSamples === 'function') {
      window.__rtsPerf.setPerfEnabled(true);
      window.__rtsPerf.resetSamples();
    }
  });
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
        const ground = document.getElementById('ground');
        const mesh = ground && ground.getObject3D && ground.getObject3D('mesh');
        const props = ground && ground.getObject3D && ground.getObject3D('overviewProps');
        let propMeshes = 0;
        if (props) {
          props.traverse((o) => {
            if (o.isMesh || o.isInstancedMesh) propMeshes++;
          });
        }
        return {
          fpsHud: m ? Number(m[1]) : null,
          hudText,
          calls: info ? info.calls | 0 : -1,
          tris: info ? info.triangles | 0 : -1,
          textures: mem ? mem.textures | 0 : -1,
          xr: !!(r && r.xr && r.xr.isPresenting),
          bake: !!(mesh && mesh.userData && mesh.userData.rtsSkirmishBake),
          hasProps: !!props,
          propMeshes,
          propUrl: (props && props.userData && props.userData.rtsKitUrl) || null,
          forest:
            !!(props && props.userData && (props.userData.rtsForestProps || props.userData.rtsForestScatterMeters)),
          version: document.querySelector('meta[name="rts-version"]')?.getAttribute('content') || '?',
        };
      })
    );
    await sleep(200);
  }
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  await page.screenshot({ path: shotPath, fullPage: false });
  const fpsVals = rows.map((x) => x.fpsHud).filter((x) => x != null && x > 0);
  const last = rows[rows.length - 1] || {};
  return {
    samples: rows.length,
    fpsHudAvg: fpsVals.length ? fpsVals.reduce((a, b) => a + b, 0) / fpsVals.length : null,
    fpsHudMin: fpsVals.length ? Math.min(...fpsVals) : null,
    fpsHudMax: fpsVals.length ? Math.max(...fpsVals) : null,
    fpsHudLast: last.fpsHud,
    callsLast: last.calls,
    trisLast: last.tris,
    trisK: last.tris >= 0 ? Math.round(last.tris / 1000) : null,
    textures: last.textures,
    xrPresenting: last.xr,
    bake: last.bake,
    hasProps: last.hasProps,
    propMeshes: last.propMeshes,
    propUrl: last.propUrl,
    forest: last.forest,
    version: last.version,
    hudText: last.hudText,
    screenshot: path.relative(WEBXR, shotPath).split(path.sep).join('/'),
  };
}

async function benchProject(proj, browser) {
  const shotDir = path.join(OUT, 'screenshots', proj.id);
  fs.mkdirSync(shotDir, { recursive: true });
  const server = await startStaticServer(proj.root, proj.port);
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const result = { id: proj.id, version: null, poses: [], error: null };
  try {
    const url = `http://127.0.0.1:${proj.port}/index.html?perf=1`;
    console.log(`\n=== ${proj.id} headed Chrome 1v1 ${url} ===`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 180000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    });
    await sleep(1000);

    result.poses.push({
      pose: 'menu',
      ...(await sampleHud(page, path.join(shotDir, '01-menu.png'))),
    });
    console.log(
      `${proj.id} menu HUD ${result.poses.at(-1).fpsHudAvg?.toFixed(0)} fps d=${result.poses.at(-1).callsLast} tK=${result.poses.at(-1).trisK}`
    );

    await page.evaluate(() => {
      if (typeof window._startGame !== 'function') throw new Error('no _startGame');
      window._startGame('1v1');
    });
    await page.waitForFunction(() => {
      const overlay = document.getElementById('match-prepare-overlay');
      return !(overlay && !overlay.hidden);
    }, null, { timeout: 300000 });
    await sleep(2500);

    await page.evaluate(async () => {
      const State = await import('./js/state.js');
      const Units = await import('./js/units.js');
      const Input = await import('./js/input.js');
      const UI = await import('./js/ui.js');
      if (!State.gameSession.gameStarted) throw new Error('1v1 did not start');
      if (typeof UI.setMinimapVisible === 'function') UI.setMinimapVisible(true);
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
      Input.positionCameraForPlayer(myId);
    });
    await sleep(1000);

    result.poses.push({
      pose: '1v1-look-center',
      ...(await sampleHud(page, path.join(shotDir, '02-1v1-look-center.png'))),
    });
    result.version = result.poses.at(-1).version;
    console.log(
      `${proj.id} look-center HUD ${result.poses.at(-1).fpsHudAvg?.toFixed(0)} fps d=${result.poses.at(-1).callsLast} tK=${result.poses.at(-1).trisK} props=${result.poses.at(-1).hasProps} forest=${result.poses.at(-1).forest}`
    );

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
      const cam = Input.getCameraState();
      cam.rotY += Math.PI;
    });
    await sleep(800);
    result.poses.push({
      pose: '1v1-look-out',
      ...(await sampleHud(page, path.join(shotDir, '03-1v1-look-out.png'))),
    });
    console.log(
      `${proj.id} look-out HUD ${result.poses.at(-1).fpsHudAvg?.toFixed(0)} fps d=${result.poses.at(-1).callsLast} tK=${result.poses.at(-1).trisK}`
    );
  } catch (err) {
    result.error = String(err && err.stack ? err.stack : err);
    console.error(proj.id, 'FAIL', result.error);
  } finally {
    await page.close();
    server.close();
  }
  return result;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('Launching headed Google Chrome (1v1, vsync on)…');
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--new-window', '--start-maximized'],
  });
  const results = [];
  for (const proj of PROJECTS) {
    results.push(await benchProject(proj, browser));
  }
  await browser.close();

  const pack = {
    when: new Date().toISOString(),
    method: {
      harness: 'RTSVR5/scripts/bench-1v1-chrome-headed.mjs',
      sameAs: 'RTSVR4/bench-chrome-headed.mjs + bench-story-chrome-headed.mjs',
      browser: 'Google Chrome channel=chrome headed=true',
      vsync: 'on',
      mode: '1v1',
      extraUnits: 24,
      sampleMs: SAMPLE_MS,
    },
    projects: results,
  };
  const jsonPath = path.join(OUT, 'bench-1v1-chrome-headed.json');
  fs.writeFileSync(jsonPath, JSON.stringify(pack, null, 2));

  console.log('\n=== headed Chrome 1v1 HUD FPS (this machine, vsync on) ===');
  console.log(
    `${'project'.padEnd(14)} ${'ver'.padEnd(8)} ${'pose'.padEnd(18)} ${'fpsAvg'.padStart(7)} ${'fpsMin'.padStart(7)} ${'d'.padStart(5)} ${'tK'.padStart(6)} ${'props'.padStart(6)} ${'forest'.padStart(7)}`
  );
  for (const p of results) {
    for (const row of p.poses) {
      console.log(
        `${p.id.padEnd(14)} ${String(row.version || '?').padEnd(8)} ${row.pose.padEnd(18)} ${String(row.fpsHudAvg != null ? row.fpsHudAvg.toFixed(0) : '-').padStart(7)} ${String(row.fpsHudMin != null ? row.fpsHudMin : '-').padStart(7)} ${String(row.callsLast).padStart(5)} ${String(row.trisK).padStart(6)} ${String(!!row.hasProps).padStart(6)} ${String(!!row.forest).padStart(7)}`
      );
    }
  }
  console.log(`\nWrote ${jsonPath}`);
  if (results.some((r) => r.error)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
