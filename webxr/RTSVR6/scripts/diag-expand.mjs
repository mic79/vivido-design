import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9015;
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/') u = '/index.html';
  const fp = path.join(ROOT, u.replace(/^\//, ''));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (/Mobile HQ|deployed|expand|🏕️|🤖 P\d+ deployed/.test(t)) console.log('LOG', t);
});

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

for (let step = 0; step < 8; step++) {
  await page.evaluate(async (secs) => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(secs);
  }, 60);
  const snap = await page.evaluate(async () => {
    const S = await import('./js/state.js');
    const { BOT_FIELD_CLAIM_RADIUS } = await import('./js/config.js');
    const claimR2 = BOT_FIELD_CLAIM_RADIUS * BOT_FIELD_CLAIM_RADIUS;
    return {
      t: Math.round(S.gameSession.elapsedTime),
      seats: S.players.filter((p) => p.isActive && !p.isDefeated).map((p) => {
        const units = [];
        const buildings = [];
        S.units.forEach((u) => {
          if (u.ownerId === p.id && u.hp > 0) units.push(u);
        });
        S.buildings.forEach((b) => {
          if (b.ownerId === p.id && b.hp > 0) buildings.push(b);
        });
        const refs = buildings.filter((b) => b.type === 'refinery');
        const hqs = buildings.filter((b) => b.type === 'hq');
        const mhq = units.filter((u) => u.type === 'mobileHq');
        const disc = p.botMemory?.discoveredResources || [];
        let unclaimed = 0;
        for (const id of disc) {
          const f = S.resourceFields.get(id);
          if (!f || f.depleted) continue;
          if (!refs.some((r) => (r.x - f.x) ** 2 + (r.z - f.z) ** 2 < claimR2)) unclaimed++;
        }
        return {
          id: p.id,
          credits: Math.round(p.credits),
          refs: refs.length,
          hqs: hqs.length,
          mhq: mhq.length,
          mhqState: mhq.map((u) => u.state),
          unclaimed,
          tanks: units.filter((u) => /Tank|artillery/.test(u.type)).length,
          harvested: Math.round(p.stats?.creditsHarvested || 0),
          factoryQ: buildings
            .filter((b) => b.type === 'warFactory')
            .flatMap((b) => b.productionQueue.map((q) => q.unitType)),
        };
      }),
    };
  });
  console.log(JSON.stringify(snap));
}

await browser.close();
server.close();
