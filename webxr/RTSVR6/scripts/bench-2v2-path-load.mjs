#!/usr/bin/env node
/**
 * 2v2, all 4 seats bots. Fast-forward MATCH_SEC of sim (default 3600 = 1 hour).
 * Counts path searches and bot orders. Does not change search decisions.
 *
 *   node scripts/bench-2v2-path-load.mjs
 *   MATCH_SEC=3600 SAMPLE_SEC=300 PORT=9072
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'bench-2v2-path');
const PORT = Number(process.env.PORT || 9072);
const MATCH_SEC = Math.max(60, Number(process.env.MATCH_SEC || 3600));
const SAMPLE_SEC = Math.max(30, Number(process.env.SAMPLE_SEC || 60));

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

const BUCKETS = ['bot', 'movement', 'harvesters', 'combat', 'fog', 'buildings', 'spatial'];

function startServer() {
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
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

function diffOrders(now, prev) {
  const ids = new Set([...Object.keys(now || {}), ...Object.keys(prev || {})]);
  const out = {};
  for (const id of ids) {
    const a = now[id] || {};
    const b = prev[id] || {};
    const row = {};
    for (const k of ['move', 'attackMove', 'attackUnit', 'attackBuilding', 'units', 'build', 'train', 'hvOrders', 'hvUnits']) {
      row[k] = (a[k] || 0) - (b[k] || 0);
    }
    out[id] = row;
  }
  return out;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--mute-audio'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.warn('pageerror', e.message));
  const t0 = Date.now();
  const samples = [];
  try {
    const q = 'perf=1&leanrocks=1&norender=1&noeffects=1&noui=1&noinput=1&nofogoverlay=1';
    await page.goto(`http://127.0.0.1:${PORT}/index.html?${q}`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 300000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
      window._startGame('2v2');
    });
    await page.waitForFunction(
      () => {
        const o = document.getElementById('match-prepare-overlay');
        return !(o && !o.hidden);
      },
      null,
      { timeout: 300000 },
    );
    await page.waitForFunction(
      async () => {
        const S = await import('./js/state.js');
        return S.gameSession.gameStarted && S.gameSession.matchMode === '2v2';
      },
      null,
      { timeout: 180000 },
    );
    const seats = await page.evaluate(async () => {
      const S = await import('./js/state.js');
      const Bot = await import('./js/bot.js');
      const Perf = await import('./js/perf-profiler.js');
      const { BOT_STRATEGY_ORDER } = await import('./js/config.js');
      let i = 0;
      const out = [];
      for (const p of S.players) {
        if (!p.isActive || p.isDefeated) continue;
        p.isHuman = false;
        p.isBot = true;
        const sid = BOT_STRATEGY_ORDER[i % BOT_STRATEGY_ORDER.length];
        Bot.applyBotStrategy(p, sid);
        out.push({ id: p.id, team: p.team, strat: sid });
        i++;
      }
      Perf.setPerfEnabled(true);
      Perf.resetSamples();
      return out;
    });
    console.log('seats', JSON.stringify(seats));

    let prevPath = await page.evaluate(async () => {
      const P = await import('./js/pathfinding.js');
      return P.copyPathStats();
    });
    let prevOrders = await page.evaluate(async () => {
      const U = await import('./js/units.js');
      return U.copyOrderStats();
    });
    let prevPerf = await page.evaluate(async () => {
      const Perf = await import('./js/perf-profiler.js');
      const s = Perf.snapshot();
      return { sumMs: s.sumMs, maxMs: s.maxMs };
    });

    let t = 0;
    let gameOver = false;
    while (t < MATCH_SEC && !gameOver) {
      const chunk = Math.min(SAMPLE_SEC, MATCH_SEC - t);
      const wall0 = Date.now();
      const ff = await page.evaluate(async (secs) => {
        const Loop = await import('./js/loop.js');
        return Loop.fastForwardSim(secs);
      }, chunk);
      const wallMs = Date.now() - wall0;
      t = ff.elapsed;
      gameOver = !!ff.gameOver;

      const snap = await page.evaluate(async () => {
        const P = await import('./js/pathfinding.js');
        const U = await import('./js/units.js');
        const S = await import('./js/state.js');
        const Perf = await import('./js/perf-profiler.js');
        const perf = Perf.snapshot();
        let units = 0;
        let harvesters = 0;
        let ordered = 0;
        S.units.forEach((u) => {
          if (u.hp <= 0) return;
          units++;
          if (u.type === 'harvester') harvesters++;
          if (u.playerCommanded && u.targetPos) ordered++;
        });
        return {
          path: P.copyPathStats(),
          orders: U.copyOrderStats(),
          sumMs: perf.sumMs,
          maxMs: perf.maxMs,
          units,
          harvesters,
          ordered,
          elapsed: S.gameSession.elapsedTime,
          gameOver: !!S.gameSession.gameOver,
        };
      });

      const orders = diffOrders(snap.orders, prevOrders);
      const minute = Math.max(1, Math.round(ff.elapsed / 60));
      const row = {
        minute,
        elapsed: +ff.elapsed.toFixed(1),
        gameOver: snap.gameOver,
        units: snap.units,
        orders,
      };
      samples.push(row);
      prevOrders = snap.orders;
      const bits = seats.map((s) => {
        const r = orders[s.id] || orders[String(s.id)] || {};
        return `P${s.id} ${s.strat} mv ${r.move || 0} am ${r.attackMove || 0} au ${r.attackUnit || 0} ab ${r.attackBuilding || 0} units ${r.units || 0} build ${r.build || 0} train ${r.train || 0}`;
      }).join(' || ');
      console.log(`min ${String(minute).padStart(2)}  ${bits}`);
    }

    const keys = ['move', 'attackMove', 'attackUnit', 'attackBuilding', 'units', 'build', 'train', 'hvOrders', 'hvUnits'];
    const totals = {};
    for (const s of seats) totals[s.id] = { strat: s.strat, team: s.team, move: 0, attackMove: 0, attackUnit: 0, attackBuilding: 0, units: 0, build: 0, train: 0, hvOrders: 0, hvUnits: 0 };
    for (const sample of samples) {
      for (const s of seats) {
        const r = sample.orders[s.id] || sample.orders[String(s.id)] || {};
        for (const k of keys) totals[s.id][k] += r[k] || 0;
      }
    }
    const byType = await page.evaluate(async () => {
      const U = await import('./js/units.js');
      return U.copyOrderedTypes();
    });
    const pack = {
      when: new Date().toISOString(),
      mode: '2v2',
      seats,
      matchSec: samples.length ? samples[samples.length - 1].elapsed : 0,
      requestedSec: MATCH_SEC,
      wallSec: +((Date.now() - t0) / 1000).toFixed(1),
      totals,
      orderedByType: byType,
      samples,
    };
    const outPath = path.join(OUT, 'latest.json');
    fs.writeFileSync(outPath, JSON.stringify(pack, null, 2));
    console.log('WROTE', outPath);
    console.log('TOTALS', JSON.stringify(totals));
    console.log('BY TYPE', JSON.stringify(byType));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
