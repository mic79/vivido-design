#!/usr/bin/env node
/**
 * Desktop feature-cost bench for RTSVR4.
 *
 * Serves the RTSVR4 folder, boots Chromium via Playwright, starts a 1v1 match,
 * stresses movement, then samples `window.__rtsPerf` with each major system ablated.
 *
 * Usage (from repo root or RTSVR4):
 *   node RTSVR4/bench-desktop-features.mjs
 *
 * Env:
 *   SAMPLE_MS=4000   sampling window per config
 *   WARMUP_MS=1500
 *   PORT=8765
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8765);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 4000);
const WARMUP_MS = Number(process.env.WARMUP_MS || 1500);
const STRESS_UNITS = Number(process.env.STRESS_UNITS || 250);
/** Extra enemy units as a fraction of STRESS_UNITS (default 0.8 → ~450 total at 250). */
const ENEMY_FRAC = Number(process.env.ENEMY_FRAC || 0.8);

async function sleep(ms) {
  await new Promise(r => setTimeout(r, ms));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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

function startStaticServer() {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const filePath = path.normalize(path.join(ROOT, rel));
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  return new Promise(resolve => {
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

const HEADED = process.env.HEADED === '1' || process.env.HEADED === 'true';
const ONLY = (process.env.ONLY || '').trim();

/** @type {{ name: string, query: string }[]} */
const ALL_CONFIGS = [
  { name: 'baseline', query: 'perf=1' },
  { name: 'nocubemap', query: 'perf=1&nocubemap=1' },
  { name: 'simplegeo', query: 'perf=1&simplegeo=1' },
  { name: 'simple+nocube', query: 'perf=1&simplegeo=1&nocubemap=1' },
];
const CONFIGS = ONLY ? ALL_CONFIGS.filter((c) => c.name === ONLY) : ALL_CONFIGS;

async function waitReady(page, timeoutMs = 120000) {
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: timeoutMs });
}

async function startMatchAndStress(page) {
  await page.evaluate(async (stressN) => {
    if (typeof window._dismissAppStartGate === 'function') {
      window._dismissAppStartGate();
    }
    await new Promise(r => setTimeout(r, 200));
    if (typeof window._startGame !== 'function') throw new Error('no _startGame');
    window._startGame('1v1');
  }, STRESS_UNITS);

  await page.waitForFunction(
    () => window.__rtsPerf && document.querySelector('meta[name="rts-version"]'),
    null,
    { timeout: 120000 }
  );
  await page.waitForFunction(
    () => {
      // gameSession is not global; wait until start hint / preparing clears and units exist
      const overlay = document.getElementById('match-prepare-overlay');
      const preparing = overlay && !overlay.hidden;
      return !preparing;
    },
    null,
    { timeout: 180000 }
  );
  // Give match a moment after prepare overlay hides
  await sleep(800);

  await page.evaluate(
    async ({ stressN, enemyFrac }) => {
      const State = await import('./js/state.js');
      const Units = await import('./js/units.js');
      const UI = await import('./js/ui.js');
      if (!State.gameSession.gameStarted) {
        throw new Error('game did not start');
      }
      // Realistic mid-match UI cost: minimap on (default match path).
      if (typeof UI.setMinimapVisible === 'function') UI.setMinimapVisible(true);

      const myId = State.gameSession.myPlayerId;
      const spawn = State.players[myId]?.spawn || { x: 40, z: 40 };
      // Spread across types so InstancedMesh caps (200/type) aren't the bottleneck.
      const types = [
        'rifleman',
        'rocketSoldier',
        'lightTank',
        'scoutBike',
        'heavyTank',
        'sniper',
        'artillery',
        'engineer',
      ];
      let made = 0;
      for (let i = 0; i < stressN; i++) {
        const t = types[i % types.length];
        const ang = (i / stressN) * Math.PI * 2;
        const ring = Math.floor(i / 24);
        const r = 14 + ring * 3 + (i % 5);
        const x = spawn.x + Math.cos(ang) * r;
        const z = spawn.z + Math.sin(ang) * r;
        const u = Units.createUnit(t, myId, x, z, { skipCapCheck: true, skipProducedStat: true });
        if (u) made++;
      }
      const botId = State.players.find(p => p.isBot)?.id ?? 1;
      const bSpawn = State.players[botId]?.spawn || { x: -40, z: -40 };
      const enemyN = Math.floor(stressN * enemyFrac);
      for (let i = 0; i < enemyN; i++) {
        const t = types[i % types.length];
        const ang = (i / Math.max(1, enemyN)) * Math.PI * 2;
        const ring = Math.floor(i / 24);
        const r = 12 + ring * 3 + (i % 5);
        Units.createUnit(t, botId, bSpawn.x + Math.cos(ang) * r, bSpawn.z + Math.sin(ang) * r, {
          skipCapCheck: true,
          skipProducedStat: true,
        });
      }

      const ids = [];
      State.units.forEach(u => {
        if (u.ownerId === myId && u.hp > 0) ids.push(u.id);
      });
      Units.commandMove(ids, 0, 0, { playerCommanded: true });
      const half = ids.slice(0, Math.floor(ids.length / 2));
      if (half.length) Units.commandAttackMove(half, bSpawn.x * 0.55, bSpawn.z * 0.55);

      // Look at the march/fight so live-skip does not hide render.units / combat.
      const Input = await import('./js/input.js');
      const cam = Input.getCameraState();
      cam.x = 18;
      cam.z = 18;
      cam.y = 28;
      cam.rotY = Math.atan2(18, 18) + Math.PI;

      return { made, enemyN, total: State.units.size, buildings: State.buildings.size };
    },
    { stressN: STRESS_UNITS, enemyFrac: ENEMY_FRAC }
  );
}

async function samplePerf(page) {
  await page.evaluate(() => {
    window.__rtsPerf.setPerfEnabled(true);
    window.__rtsPerf.resetSamples();
  });
  const hud = [];
  const t0 = Date.now();
  while (Date.now() - t0 < SAMPLE_MS) {
    hud.push(
      await page.evaluate(() => {
        const el = document.getElementById('hud-version-fps');
        const m = /([0-9]+)\s*FPS/.exec(el ? el.textContent : '');
        return m ? Number(m[1]) : null;
      })
    );
    await sleep(200);
  }
  const snap = await page.evaluate(() => window.__rtsPerf.snapshot());
  const fpsVals = hud.filter((n) => n != null && n > 0);
  snap.hudFps = fpsVals.length
    ? {
        last: fpsVals[fpsVals.length - 1],
        avg: fpsVals.reduce((a, b) => a + b, 0) / fpsVals.length,
        min: Math.min(...fpsVals),
        max: Math.max(...fpsVals),
        n: fpsVals.length,
      }
    : null;
  return snap;
}

function fmtMs(n) {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

function fpsLine(snap) {
  const hud = snap.hudFps;
  if (hud) {
    return `HUD min=${hud.min}  avg=${hud.avg.toFixed(0)}  max=${hud.max}`;
  }
  const min = snap.fpsMin ?? 0;
  const max = snap.fpsMax ?? 0;
  const avg = snap.fpsAvg ?? snap.fps ?? 0;
  return `cpu min=${min.toFixed(1)}  avg=${avg.toFixed(1)}  max=${max.toFixed(1)}`;
}

function printReport(results) {
  const baseline = results.find(r => r.name === 'baseline');
  console.log('\n=== RTSVR4 desktop feature bench (measured) ===');
  console.log(
    `sample=${SAMPLE_MS}ms warmup=${WARMUP_MS}ms playerUnits≈${STRESS_UNITS} enemyFrac=${ENEMY_FRAC} headed=${HEADED}`
  );
  console.log(
    HEADED
      ? '\n--- HUD FPS min / avg / max (headed Chrome, vsync on) ---'
      : '\n--- FPS min / avg / max (instantaneous min/max; avg = frames/wall; HEADLESS) ---'
  );
  for (const r of results) {
    if (!r.snap) continue;
    console.log(
      `  ${r.name.padEnd(14)} ${fpsLine(r.snap)}   frameAvg=${fmtMs(r.snap.avgMs.frame)}ms  units=${r.counts?.units}`
    );
  }
  if (baseline?.snap) {
    console.log(
      `\nbaseline FPS=${baseline.snap.fps.toFixed(1)}  frameAvg=${fmtMs(baseline.snap.avgMs.frame)}ms  frames=${baseline.snap.frames}  units=${baseline.counts?.units}  gpuSkip=${baseline.snap.gpu?.skipPct != null ? baseline.snap.gpu.skipPct.toFixed(0) : '?'}%`
    );

    console.log('\n--- UI / Render breakdown (what “more than half” actually was) ---');
    const detailKeys = [
      'ui',
      'ui.hud',
      'ui.minimap',
      'ui.panels',
      'ui.vr',
      'render',
      'render.units',
      'render.buildings',
      'render.health',
      'render.rings',
      'render.orders',
      'render.resources',
      'render.projectiles',
      'render.fogOverlay',
      'render.misc',
    ];
    for (const k of detailKeys) {
      const v = baseline.snap.avgMs[k] || 0;
      const pct = baseline.snap.pctOfFrame[k] || 0;
      const indent = k.includes('.') ? '    ' : '  ';
      console.log(`${indent}${k.padEnd(20)} ${fmtMs(v)} ms   ${pct.toFixed(1)}% of frame`);
    }

    console.log('\n--- Main features (avg ms/frame, same buckets as the ~460u table) ---');
    const mainKeys = [
      'combat',
      'render.units',
      'ui.minimap',
      'movement',
      'bot',
      'fog',
      'ui.hud',
      'spatial',
      'harvesters',
      'input',
    ];
    let named = 0;
    for (const k of mainKeys) {
      const v = baseline.snap.avgMs[k] || 0;
      const pct = baseline.snap.pctOfFrame[k] || 0;
      named += v;
      console.log(`  ${k.padEnd(16)} ${fmtMs(v)} ms   ${pct.toFixed(1)}% of frame`);
    }
    const frame = baseline.snap.avgMs.frame || 0;
    const rest = Math.max(0, frame - named);
    console.log(
      `  ${'everything else'.padEnd(16)} ${fmtMs(rest)} ms   ${frame > 0 ? ((rest / frame) * 100).toFixed(1) : '0.0'}% of frame`
    );

    console.log('\n--- All systems (avg ms/frame) ---');
    const rows = Object.entries(baseline.snap.avgMs)
      .filter(([k]) => k !== 'frame' && !k.includes('.'))
      .sort((a, b) => b[1] - a[1]);
    for (const [k, v] of rows) {
      const pct = baseline.snap.pctOfFrame[k] || 0;
      console.log(`  ${k.padEnd(12)} ${fmtMs(v)} ms   ${pct.toFixed(1)}% of frame`);
    }
  }

  console.log('\nAblation vs baseline (FPS↑ when disabled ≈ that feature’s cost):');
  console.log(
    `${'config'.padEnd(14)} ${'min'.padStart(7)} ${'avg'.padStart(7)} ${'max'.padStart(7)} ${'Δavg'.padStart(8)} ${'frameMs'.padStart(9)}`
  );
  const baseFps = baseline?.snap?.fps || 0;
  for (const r of results) {
    const fps = r.snap?.fps || 0;
    const frame = r.snap?.avgMs?.frame || 0;
    const dFps = fps - baseFps;
    const min = r.snap?.fpsMin ?? 0;
    const max = r.snap?.fpsMax ?? 0;
    console.log(
      `${r.name.padEnd(14)} ${min.toFixed(1).padStart(7)} ${fps.toFixed(1).padStart(7)} ${max.toFixed(1).padStart(7)} ${dFps.toFixed(1).padStart(8)} ${fmtMs(frame).padStart(9)}`
    );
  }
  console.log('\nDesktop Chromium only (not Quest). frameMs is the trustworthy signal when FPS is uncapped.');
}

async function runConfig(browser, cfg) {
  const page = await browser.newPage(
    HEADED ? { viewport: { width: 1600, height: 900 } } : undefined
  );
  const url = `http://127.0.0.1:${PORT}/index.html?${cfg.query}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await waitReady(page);
  await startMatchAndStress(page);
  await sleep(WARMUP_MS);
  const snap = await samplePerf(page);
  const meta = await page.evaluate(() => ({
    version: document.querySelector('meta[name="rts-version"]')?.content || '?',
    units: window.__rtsBenchMeta?.units,
  }));
  // stash unit count if evaluate set it
  const counts = await page.evaluate(async () => {
    const State = await import('./js/state.js');
    return { units: State.units.size, buildings: State.buildings.size };
  });
  await page.close();
  return { name: cfg.name, query: cfg.query, snap, counts, version: meta.version };
}

async function main() {
  const server = await startStaticServer();
  console.log(`Serving ${ROOT} at http://127.0.0.1:${PORT}/`);
  const browser = await chromium.launch(
    HEADED
      ? {
          headless: false,
          channel: 'chrome',
          args: ['--new-window', '--start-maximized'],
        }
      : {
          headless: true,
          args: [
            '--use-gl=angle',
            '--ignore-gpu-blocklist',
            '--disable-frame-rate-limit',
            '--disable-gpu-vsync',
          ],
        }
  );

  const results = [];
  try {
    for (const cfg of CONFIGS) {
      process.stdout.write(`Running ${cfg.name}… `);
      const r = await runConfig(browser, cfg);
      results.push(r);
      console.log(
        `${fpsLine(r.snap)} frame=${fmtMs(r.snap.avgMs.frame)}ms units=${r.counts.units}`
      );
    }
  } finally {
    await browser.close();
    server.close();
  }

  printReport(results);

  const outPath = path.join(ROOT, 'bench-desktop-features.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        when: new Date().toISOString(),
        sampleMs: SAMPLE_MS,
        warmupMs: WARMUP_MS,
        stressUnits: STRESS_UNITS,
        results,
      },
      null,
      2
    )
  );
  console.log(`\nWrote ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
