/**
 * Detect truly stuck HVs: same position for several seconds while "busy".
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9033;
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

// Snapshot positions, FF 5s, compare
async function snap() {
  return page.evaluate(async () => {
    const S = await import('./js/state.js');
    const out = [];
    S.units.forEach((u) => {
      if (u.type !== 'harvester' || u.hp <= 0) return;
      const p = S.players[u.ownerId];
      if (!p?.isBot) return;
      out.push({
        id: u.id,
        owner: u.ownerId,
        state: u.state,
        x: +u.x.toFixed(2),
        z: +u.z.toFixed(2),
        cargo: u.cargo || 0,
        pc: !!u.playerCommanded,
        hasPath: !!(u.path && u.path.length),
        retryAt: u._pathRetryAt || 0,
        field: u.assignedField || null,
        tp: u.targetPos ? { x: +u.targetPos.x.toFixed(1), z: +u.targetPos.z.toFixed(1) } : null,
      });
    });
    return { t: S.gameSession.elapsedTime, now: performance.now(), hvs: out };
  });
}

for (const block of [45, 45, 60, 60, 90]) {
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
  const byId = new Map(b.hvs.map((h) => [h.id, h]));
  const stuck = [];
  for (const h of a.hvs) {
    const n = byId.get(h.id);
    if (!n) continue;
    const d = Math.hypot(n.x - h.x, n.z - h.z);
    const busy = !['idle', 'harvesting', 'depositing'].includes(h.state);
    // idle with cargo or idle with no progress when should work
    if (d < 0.35 && (busy || h.state === 'idle' || h.state === 'moving')) {
      stuck.push({
        id: h.id,
        owner: h.owner,
        state: `${h.state}->${n.state}`,
        d: +d.toFixed(2),
        cargo: n.cargo,
        hasPath: n.hasPath,
        retryWait: n.retryAt > b.now,
        field: n.field,
        tp: n.tp,
        pc: n.pc,
      });
    }
  }
  console.log(JSON.stringify({
    t: Math.round(b.t),
    hv: b.hvs.length,
    stuckN: stuck.length,
    byState: stuck.reduce((m, s) => {
      const k = s.state;
      m[k] = (m[k] || 0) + 1;
      return m;
    }, {}),
    sample: stuck.slice(0, 8),
  }));
}

await browser.close();
server.close();
