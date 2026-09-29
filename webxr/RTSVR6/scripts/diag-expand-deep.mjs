/**
 * Deep expand diag: after each FF step, for seat 0 check pad legality,
 * credits, power, and why place would fail.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9025;
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
page.on('console', (m) => {
  const t = m.text();
  if (/Mobile HQ|deployed|expand|🤖|🏕️|place/.test(t)) console.log('LOG', t);
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

for (let step = 0; step < 10; step++) {
  await page.evaluate(async (secs) => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(secs);
  }, 45);
  const snap = await page.evaluate(async () => {
    const S = await import('./js/state.js');
    const Bot = await import('./js/bot.js');
    const B = await import('./js/buildings.js');
    const { BOT_FIELD_CLAIM_RADIUS, BOT_ECON_EXPAND_CREDITS, BUILD_RADIUS_FROM_HQ } =
      await import('./js/config.js');
    const claimR2 = BOT_FIELD_CLAIM_RADIUS * BOT_FIELD_CLAIM_RADIUS;
    const seats = [];
    for (const p of S.players) {
      if (!p.isActive || p.isDefeated) continue;
      const buildings = [];
      const units = [];
      S.buildings.forEach((b) => { if (b.ownerId === p.id && b.hp > 0) buildings.push(b); });
      S.units.forEach((u) => { if (u.ownerId === p.id && u.hp > 0) units.push(u); });
      const refs = buildings.filter((b) => b.type === 'refinery');
      const hqs = buildings.filter((b) => b.type === 'hq');
      const mhq = units.filter((u) => u.type === 'mobileHq');
      const disc = p.botMemory?.discoveredResources || [];
      const commit = p.botMemory?.expandCommitFieldId;
      const fieldChecks = [];
      for (const id of disc) {
        const f = S.resourceFields.get(id);
        if (!f || f.depleted) continue;
        const claimed = refs.some((r) => (r.x - f.x) ** 2 + (r.z - f.z) ** 2 < claimR2);
        if (claimed) continue;
        // Probe pad via exported helpers if any — fall back to canPlace rings
        let pad = null;
        let nearestHq = null;
        let nearestHqD = Infinity;
        for (const hq of hqs) {
          const d = (hq.x - f.x) ** 2 + (hq.z - f.z) ** 2;
          if (d < nearestHqD) { nearestHqD = d; nearestHq = hq; }
        }
        // Sample pads near field
        let legalPads = 0;
        let inBuildR = 0;
        let inClaimR = 0;
        for (let ring = 8; ring <= 36; ring += 4) {
          for (let i = 0; i < 8; i++) {
            const ang = (i / 8) * Math.PI * 2;
            const x = f.x + Math.cos(ang) * ring;
            const z = f.z + Math.sin(ang) * ring;
            const fail = B.getPlaceBuildingFailureCode
              ? B.getPlaceBuildingFailureCode('refinery', p.id, x, z)
              : (B.canPlaceBuilding('refinery', p.id, x, z) ? null : 'fail');
            const dField = (x - f.x) ** 2 + (z - f.z) ** 2;
            const dHq = nearestHq
              ? (x - nearestHq.x) ** 2 + (z - nearestHq.z) ** 2
              : Infinity;
            if (dField <= claimR2) inClaimR++;
            if (dHq <= BUILD_RADIUS_FROM_HQ * BUILD_RADIUS_FROM_HQ) inBuildR++;
            if (fail === null) {
              legalPads++;
              if (!pad && dField <= claimR2) pad = { x: +x.toFixed(1), z: +z.toFixed(1), fail, dHq: Math.sqrt(dHq).toFixed(1) };
            }
          }
        }
        fieldChecks.push({
          id,
          claimed,
          hqDist: nearestHq ? Math.sqrt(nearestHqD).toFixed(1) : null,
          legalPads,
          pad,
          commit: commit === id,
        });
      }
      const pow = B.getPlayerPower(p.id);
      seats.push({
        id: p.id,
        strat: p.botMemory?.strategyId,
        credits: Math.round(p.credits),
        refs: refs.length,
        hqs: hqs.length,
        mhq: mhq.length,
        mhqPos: mhq.map((u) => ({ x: +u.x.toFixed(1), z: +u.z.toFixed(1), st: u.state })),
        surplus: pow.surplus,
        produce: pow.produce,
        consume: pow.consume,
        harvested: Math.round(p.stats?.creditsHarvested || 0),
        commit,
        factoryQ: buildings.filter((b) => b.type === 'warFactory').flatMap((b) => b.productionQueue.map((q) => q.unitType)),
        fields: fieldChecks,
        expandThresh: BOT_ECON_EXPAND_CREDITS,
      });
    }
    return { t: Math.round(S.gameSession.elapsedTime), seats };
  });
  console.log(JSON.stringify(snap, null, 0));
}

await browser.close();
server.close();
