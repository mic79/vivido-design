/**
 * Detect combat units frozen in place while they still have a move goal (targetPos).
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9035;
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
  { waitUntil: 'domcontentloaded', timeout: 180000 },
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

async function snap() {
  return page.evaluate(async () => {
    const S = await import('./js/state.js');
    const PF = await import('./js/pathfinding.js');
    const out = [];
    S.units.forEach((u) => {
      if (u.hp <= 0 || u.type === 'harvester') return;
      if (!u.targetPos) return;
      if (u.state !== 'moving' && u.state !== 'attacking') return;
      out.push({
        id: u.id,
        type: u.type,
        owner: u.ownerId,
        state: u.state,
        x: +u.x.toFixed(2),
        z: +u.z.toFixed(2),
        hasPath: !!(u.path && u.path.length),
        retryAt: u._pathRetryAt || 0,
        stuckT: +(u._stuckTime || 0).toFixed(2),
        walkable: PF.isPositionWalkable(u.x, u.z),
        goalWalk: PF.isPositionWalkable(u.targetPos.x, u.targetPos.z),
        tp: { x: +u.targetPos.x.toFixed(1), z: +u.targetPos.z.toFixed(1) },
        distGoal: +Math.hypot(u.x - u.targetPos.x, u.z - u.targetPos.z).toFixed(1),
      });
    });
    return { t: S.gameSession.elapsedTime, simMs: S.gameSession.elapsedTime * 1000, units: out };
  });
}

for (const block of [60, 60, 90, 90, 120]) {
  await page.evaluate(async (s) => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(s);
  }, block);
  const a = await snap();
  await page.evaluate(async () => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(5);
  });
  const b = await snap();
  const byId = new Map(b.units.map((u) => [u.id, u]));
  const stuck = [];
  for (const u of a.units) {
    const n = byId.get(u.id);
    if (!n) continue;
    const d = Math.hypot(n.x - u.x, n.z - u.z);
    if (d < 0.4) {
      stuck.push({
        id: u.id,
        type: u.type,
        owner: u.owner,
        state: `${u.state}->${n.state}`,
        d: +d.toFixed(2),
        hasPath: n.hasPath,
        retryWait: n.retryAt > b.simMs,
        walkable: n.walkable,
        goalWalk: n.goalWalk,
        stuckT: n.stuckT,
        distGoal: n.distGoal,
        pos: { x: n.x, z: n.z },
        tp: n.tp,
      });
    }
  }
  console.log(JSON.stringify({
    t: Math.round(b.t),
    movers: b.units.length,
    stuckN: stuck.length,
    byType: stuck.reduce((m, s) => {
      m[s.type] = (m[s.type] || 0) + 1;
      return m;
    }, {}),
    sample: stuck.slice(0, 8),
  }));
}

await browser.close();
server.close();
