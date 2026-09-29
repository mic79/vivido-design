/**
 * Quick FFA health check: HV idle share, scout spread, strike/push missions, bot tick cost.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9031;
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

for (const secs of [90, 90, 90, 90]) {
  const t0 = Date.now();
  await page.evaluate(async (s) => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(s);
  }, secs);
  const wall = Date.now() - t0;
  const snap = await page.evaluate(async () => {
    const S = await import('./js/state.js');
    const seats = [];
    for (const p of S.players) {
      if (!p.isActive || p.isDefeated) continue;
      const hvs = [];
      const bikes = [];
      S.units.forEach((u) => {
        if (u.ownerId !== p.id || u.hp <= 0) return;
        if (u.type === 'harvester') hvs.push(u);
        if (u.type === 'scoutBike') bikes.push(u);
      });
      const idleHv = hvs.filter((h) => h.state === 'idle').length;
      const working = hvs.filter((h) =>
        /movingToField|harvesting|movingToRefinery|depositing/.test(h.state)
      ).length;
      const missions = (p.botMemory?.currentMissions || []).map((m) => m.type);
      const scoutPos = (p.botMemory?.currentMissions || [])
        .filter((m) => m.type === 'SCOUT' && m.targetPos)
        .map((m) => ({ x: +m.targetPos.x.toFixed(0), z: +m.targetPos.z.toFixed(0) }));
      // pairwise scout goal separation
      let minScoutSep = Infinity;
      for (let i = 0; i < scoutPos.length; i++) {
        for (let j = i + 1; j < scoutPos.length; j++) {
          const d = Math.hypot(scoutPos[i].x - scoutPos[j].x, scoutPos[i].z - scoutPos[j].z);
          minScoutSep = Math.min(minScoutSep, d);
        }
      }
      seats.push({
        id: p.id,
        hv: hvs.length,
        idleHv,
        working,
        movingHv: hvs.filter((h) => h.state === 'moving').length,
        bikes: bikes.length,
        missions,
        scoutGoals: scoutPos.length,
        minScoutSep: Number.isFinite(minScoutSep) ? +minScoutSep.toFixed(0) : null,
        harvested: Math.round(p.stats?.creditsHarvested || 0),
      });
    }
    return { t: Math.round(S.gameSession.elapsedTime), seats };
  });
  console.log(JSON.stringify({ wallMs: wall, ...snap }));
}

await browser.close();
server.close();
