/**
 * Why are HVs idle? Dump per-HV blockers + scout/explore flags.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9032;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/') u = '/index.html';
  const fp = path.join(ROOT, u.replace(/^\//, ''));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();

await page.goto(
  `http://127.0.0.1:${PORT}/index.html?perf=1&leanrocks=1&norender=1&noeffects=1&noui=1&noinput=1&nofogoverlay=1`,
  { waitUntil: 'domcontentloaded', timeout: 180000 }
);
await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 300000 });
await page.evaluate(() => {
  window._dismissAppStartGate?.();
  window._startGame('ffa');
});
await page.waitForFunction(() => {
  const o = document.getElementById('match-prepare-overlay');
  return !(o && !o.hidden);
}, null, { timeout: 300000 });
await page.waitForFunction(async () => {
  const S = await import('./js/state.js');
  return !!S.gameSession.gameStarted;
}, null, { timeout: 120000 });

await page.evaluate(async () => {
  const S = await import('./js/state.js');
  const Bot = await import('./js/bot.js');
  const { BOT_STRATEGY_ORDER } = await import('./js/config.js');
  let i = 0;
  for (const p of S.players) {
    if (!p.isActive || p.isDefeated) continue;
    p.isHuman = false;
    p.isBot = true;
    Bot.applyBotStrategy(p, BOT_STRATEGY_ORDER[i++ % 4]);
  }
});

for (const secs of [60, 60, 90, 90]) {
  await page.evaluate(async (s) => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(s);
  }, secs);
  const snap = await page.evaluate(async () => {
    const S = await import('./js/state.js');
    const Fog = await import('./js/fog.js');
    const seats = [];
    for (const p of S.players) {
      if (!p.isActive || p.isDefeated) continue;
      const refs = [];
      S.buildings.forEach((b) => {
        if (b.ownerId === p.id && b.type === 'refinery' && b.hp > 0) refs.push(b);
      });
      let knownLive = 0;
      let knownExplored = 0;
      const nearIdle = [];
      S.resourceFields.forEach((f) => {
        if (Fog.wasExploredByTeam(p.team, f.x, f.z)) {
          knownExplored++;
          if (!f.depleted && f.remaining > 0) knownLive++;
        }
      });
      const hvs = [];
      S.units.forEach((u) => {
        if (u.ownerId === p.id && u.type === 'harvester' && u.hp > 0) hvs.push(u);
      });
      for (const h of hvs) {
        if (h.state !== 'idle' && h.state !== 'moving') continue;
        // nearest field any
        let nearest = null;
        let nd = Infinity;
        let nearestExplored = null;
        let ned = Infinity;
        S.resourceFields.forEach((f) => {
          if (f.depleted || !(f.remaining > 0)) return;
          const d = (h.x - f.x) ** 2 + (h.z - f.z) ** 2;
          if (d < nd) { nd = d; nearest = f; }
          if (Fog.wasExploredByTeam(p.team, f.x, f.z) && d < ned) {
            ned = d; nearestExplored = f;
          }
        });
        nearIdle.push({
          id: h.id,
          state: h.state,
          pc: !!h.playerCommanded,
          cargo: h.cargo || 0,
          refs: refs.length,
          knownLive,
          nearDist: nearest ? Math.sqrt(nd).toFixed(1) : null,
          nearExplored: nearestExplored ? Math.sqrt(ned).toFixed(1) : null,
          nearRem: nearest?.remaining,
          disc: (p.botMemory?.discoveredResources || []).length,
          scouts: (p.botMemory?.currentMissions || []).filter((m) => m.type === 'SCOUT').length,
        });
      }
      seats.push({
        id: p.id,
        t: Math.round(S.gameSession.elapsedTime),
        hv: hvs.length,
        idleOrMoving: nearIdle.length,
        knownLive,
        knownExplored,
        refs: refs.length,
        bikes: [...S.units.values()].filter((u) => u.ownerId === p.id && u.type === 'scoutBike' && u.hp > 0).length,
        missions: (p.botMemory?.currentMissions || []).map((m) => m.type),
        samples: nearIdle.slice(0, 3),
      });
    }
    return seats;
  });
  console.log(JSON.stringify(snap));
}

await browser.close();
server.close();
