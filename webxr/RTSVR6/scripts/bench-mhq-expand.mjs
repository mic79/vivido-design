/**
 * Track Mobile HQ / expand timing vs home-field ore remaining and harvest flow.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9041;
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
  // Snapshot nearest field remaining per seat at t0
  window.__expandBench = { seats: {} };
  for (const p of S.players) {
    if (!p.isActive || p.isDefeated) continue;
    const hq = S.getPlayerHQ(p.id);
    let nearest = null;
    let bestD = Infinity;
    S.resourceFields.forEach((f) => {
      if (!hq || f.depleted) return;
      const d = (f.x - hq.x) ** 2 + (f.z - hq.z) ** 2;
      if (d < bestD) {
        bestD = d;
        nearest = f;
      }
    });
    window.__expandBench.seats[p.id] = {
      homeFieldId: nearest?.id ?? null,
      homeStartRem: nearest ? Math.round(nearest.remaining || 0) : 0,
      mhqQueuedAt: null,
      mhqBornAt: null,
      mhqDeployedAt: null,
      factoryAt: null,
      ref2At: null,
      homeRemAtFactory: null,
      homeRemAtMhqQ: null,
      homeRemAtRef2: null,
    };
  }
});

async function tickSnap() {
  return page.evaluate(async () => {
    const S = await import('./js/state.js');
    const t = S.gameSession.elapsedTime;
    const B = window.__expandBench;
    const rows = [];
    for (const p of S.players) {
      if (!p.isActive || p.isDefeated) continue;
      const st = B.seats[p.id];
      const home = st.homeFieldId ? S.resourceFields.get(st.homeFieldId) : null;
      const homeRem = home && !home.depleted ? Math.round(home.remaining || 0) : 0;

      let mhqQueued = false;
      let mhqUnit = null;
      let refs = 0;
      let hqs = 0;
      let factoryBuilt = false;
      S.buildings.forEach((b) => {
        if (b.ownerId !== p.id || b.hp <= 0) return;
        if (b.type === 'refinery') refs++;
        if (b.type === 'hq') hqs++;
        if (b.type === 'warFactory') {
          if (b.isBuilt) factoryBuilt = true;
          if (b.productionQueue?.some((q) => q.unitType === 'mobileHq')) mhqQueued = true;
        }
      });
      S.units.forEach((u) => {
        if (u.ownerId === p.id && u.type === 'mobileHq' && u.hp > 0) mhqUnit = u;
      });

      if (factoryBuilt && st.factoryAt == null) {
        st.factoryAt = Math.round(t);
        st.homeRemAtFactory = homeRem;
      }
      if (mhqQueued && st.mhqQueuedAt == null) {
        st.mhqQueuedAt = Math.round(t);
        st.homeRemAtMhqQ = homeRem;
      }
      if (mhqUnit && st.mhqBornAt == null) {
        st.mhqBornAt = Math.round(t);
        if (st.homeRemAtMhqQ == null) st.homeRemAtMhqQ = homeRem;
      }
      if (hqs >= 2 && st.mhqDeployedAt == null) {
        st.mhqDeployedAt = Math.round(t);
      }
      if (refs >= 2 && st.ref2At == null) {
        st.ref2At = Math.round(t);
        st.homeRemAtRef2 = homeRem;
      }

      let hv = 0;
      let working = 0;
      S.units.forEach((u) => {
        if (u.ownerId !== p.id || u.hp <= 0 || u.type !== 'harvester') return;
        hv++;
        if (/movingToField|harvesting|movingToRefinery|depositing/.test(u.state)) working++;
      });

      rows.push({
        id: p.id,
        credits: Math.round(p.credits),
        harvested: Math.round(p.stats?.creditsHarvested || 0),
        hv,
        working,
        refs,
        hqs,
        mhqQ: !!mhqQueued || !!mhqUnit,
        mhqUnit: !!mhqUnit,
        homeRem,
        homePct: st.homeStartRem
          ? Math.round((100 * homeRem) / st.homeStartRem)
          : null,
        mhqQueuedAt: st.mhqQueuedAt,
        mhqBornAt: st.mhqBornAt,
        mhqDeployedAt: st.mhqDeployedAt,
        factoryAt: st.factoryAt,
        ref2At: st.ref2At,
        homeRemAtFactory: st.homeRemAtFactory,
        homeRemAtMhqQ: st.homeRemAtMhqQ,
        homeRemAtRef2: st.homeRemAtRef2,
        discovered: (p.botMemory?.discoveredResources || []).length,
      });
    }
    const meanHarvest = Math.round(rows.reduce((a, r) => a + r.harvested, 0) / rows.length);
    const meanHomePct = Math.round(
      rows.filter((r) => r.homePct != null).reduce((a, r) => a + r.homePct, 0)
      / Math.max(1, rows.filter((r) => r.homePct != null).length),
    );
    const mhqQCount = rows.filter((r) => r.mhqQ).length;
    const ref2Count = rows.filter((r) => r.refs >= 2).length;
    return {
      t: Math.round(t),
      meanHarvest,
      meanHomePct,
      mhqQCount,
      ref2Count,
      seats: rows,
    };
  });
}

const summaries = [];
for (const block of [
  ...Array(30).fill(5),  // 0–150s @ 5s
  ...Array(7).fill(30),  // 150–360s
]) {
  await page.evaluate(async (s) => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(s);
  }, block);
  const snap = await tickSnap();
  const brief = {
    t: snap.t,
    meanHarvest: snap.meanHarvest,
    meanHomePct: snap.meanHomePct,
    mhqQ: snap.mhqQCount,
    ref2: snap.ref2Count,
    seats: snap.seats.map((r) => ({
      id: r.id,
      hv: r.hv,
      cr: r.credits,
      homePct: r.homePct,
      disc: r.discovered,
      fac: r.factoryAt,
      mhqQ: r.mhqQueuedAt,
      remQ: r.homeRemAtMhqQ,
      born: r.mhqBornAt,
      dep: r.mhqDeployedAt,
      ref2: r.ref2At,
    })),
  };
  // Log on 30s marks + whenever factory/MHQ/ref2 timestamps appear.
  if (
    block >= 30
    || snap.t % 30 < 6
    || snap.seats.some((r) =>
      [r.factoryAt, r.mhqQueuedAt, r.mhqBornAt, r.mhqDeployedAt, r.ref2At].some(
        (v) => v != null && v > snap.t - block - 1,
      ))
  ) {
    console.log(JSON.stringify(brief));
  }
  summaries.push(brief);
}
const final = summaries[summaries.length - 1];
console.log('FINAL', JSON.stringify({
  meanHarvest: final.meanHarvest,
  mhqQTimes: final.seats.map((s) => s.mhqQ),
  homeRemAtMhqQ: final.seats.map((s) => s.remQ),
  factoryTimes: final.seats.map((s) => s.fac),
  deployTimes: final.seats.map((s) => s.dep),
  ref2Times: final.seats.map((s) => s.ref2),
  ref2Count: final.ref2,
}));

await browser.close();
server.close();
