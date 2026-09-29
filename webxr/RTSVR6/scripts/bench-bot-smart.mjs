/**
 * Bot "smart economy" bench: harvest flow, HV count, defense coverage, early strikes.
 * Prints snapshots at fixed sim times for before/after comparison.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9040;
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
    const seats = [];
    let earlyStrikes = 0;
    for (const p of S.players) {
      if (!p.isActive || p.isDefeated) continue;
      const units = [];
      const hvs = [];
      const combat = [];
      S.units.forEach((u) => {
        if (u.ownerId !== p.id || u.hp <= 0) return;
        units.push(u);
        if (u.type === 'harvester') hvs.push(u);
        else if (u.type !== 'engineer' && u.type !== 'mobileHq') combat.push(u);
      });
      const refs = [];
      const hqs = [];
      S.buildings.forEach((b) => {
        if (b.ownerId !== p.id || b.hp <= 0) return;
        if (b.type === 'refinery') refs.push(b);
        if (b.type === 'hq') hqs.push(b);
      });
      const working = hvs.filter((h) =>
        /movingToField|harvesting|movingToRefinery|depositing/.test(h.state)
      ).length;
      const idleHv = hvs.filter((h) => h.state === 'idle').length;
      const missions = (p.botMemory?.currentMissions || []).map((m) => m.type);
      const strikeN = missions.filter((t) => t === 'STRIKE' || t === 'PUSH' || t === 'HARASS').length;
      earlyStrikes += strikeN;

      // Defense coverage: combat within 35 of each HQ/refinery
      const sites = [...hqs, ...refs];
      let covered = 0;
      for (const s of sites) {
        const near = combat.filter((u) => Math.hypot(u.x - s.x, u.z - s.z) <= 35).length;
        if (near >= 1) covered++;
      }

      seats.push({
        id: p.id,
        strat: p.botMemory?.strategyId || '?',
        credits: Math.round(p.credits),
        harvested: Math.round(p.stats?.creditsHarvested || 0),
        hv: hvs.length,
        working,
        idleHv,
        refs: refs.length,
        combat: combat.length,
        missions,
        sites: sites.length,
        sitesCovered: covered,
        ecoStable: !!p.botMemory?.economyStable,
      });
    }
    const meanHarvest = seats.length
      ? Math.round(seats.reduce((a, s) => a + s.harvested, 0) / seats.length)
      : 0;
    const meanHv = seats.length
      ? +(seats.reduce((a, s) => a + s.hv, 0) / seats.length).toFixed(1)
      : 0;
    const meanWorking = seats.length
      ? +(seats.reduce((a, s) => a + s.working, 0) / seats.length).toFixed(1)
      : 0;
    const meanCover = seats.length
      ? +(seats.reduce((a, s) => a + (s.sites ? s.sitesCovered / s.sites : 0), 0) / seats.length).toFixed(2)
      : 0;
    return {
      t: Math.round(S.gameSession.elapsedTime),
      meanHarvest,
      meanHv,
      meanWorking,
      meanCover,
      offenseMissions: earlyStrikes,
      seats,
    };
  });
}

for (const block of [60, 60, 60, 60, 60, 60]) {
  await page.evaluate(async (s) => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(s);
  }, block);
  console.log(JSON.stringify(await snap()));
}

await browser.close();
server.close();
