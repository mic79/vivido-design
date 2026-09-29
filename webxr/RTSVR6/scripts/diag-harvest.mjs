import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9020;
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

// Instrument deposit events
await page.evaluate(async () => {
  const R = await import('./js/resources.js');
  const S = await import('./js/state.js');
  window.__hvDiag = { deposits: [], samples: [] };
  // Monkey-patch via periodic sampling of cargo transitions
  window.__hvPrev = new Map();
});

for (let step = 0; step < 16; step++) {
  await page.evaluate(async (secs) => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(secs);
  }, 30);

  const snap = await page.evaluate(async () => {
    const S = await import('./js/state.js');
    const { BOT_FIELD_CLAIM_RADIUS, RESOURCE_FIELD_CAPACITY } = await import('./js/config.js');
    const claimR2 = BOT_FIELD_CLAIM_RADIUS * BOT_FIELD_CLAIM_RADIUS;
    const t = S.gameSession.elapsedTime;

    const fields = [];
    S.resourceFields.forEach((f) => {
      fields.push({
        id: f.id,
        rem: Math.round(f.remaining || 0),
        depleted: !!f.depleted,
        x: +f.x.toFixed(0),
        z: +f.z.toFixed(0),
      });
    });

    const seats = S.players.filter((p) => p.isActive && !p.isDefeated).map((p) => {
      const hvs = [];
      S.units.forEach((u) => {
        if (u.ownerId !== p.id || u.hp <= 0 || u.type !== 'harvester') return;
        const ref = u.assignedRefinery ? S.buildings.get(u.assignedRefinery) : null;
        const field = u.assignedField ? S.resourceFields.get(u.assignedField) : null;
        let distRef = null;
        let distField = null;
        if (ref) distRef = +Math.hypot(u.x - ref.x, u.z - ref.z).toFixed(1);
        if (field) distField = +Math.hypot(u.x - field.x, u.z - field.z).toFixed(1);
        hvs.push({
          id: u.id,
          state: u.state,
          cargo: u.cargo || 0,
          last: u.lastHarvestedField || null,
          assigned: u.assignedField || null,
          distRef,
          distField,
          blocked: u._botFieldBlockUntil ? Object.keys(u._botFieldBlockUntil).length : 0,
        });
      });

      const refs = [];
      S.buildings.forEach((b) => {
        if (b.ownerId === p.id && b.hp > 0 && b.type === 'refinery') refs.push(b);
      });

      let claimedRem = 0;
      let claimedN = 0;
      S.resourceFields.forEach((f) => {
        if (f.depleted) return;
        if (refs.some((r) => (r.x - f.x) ** 2 + (r.z - f.z) ** 2 < claimR2)) {
          claimedN++;
          claimedRem += f.remaining || 0;
        }
      });

      const byState = {};
      for (const h of hvs) byState[h.state] = (byState[h.state] || 0) + 1;

      // Detect deposits since last sample via harvested delta
      return {
        id: p.id,
        harvested: Math.round(p.stats?.creditsHarvested || 0),
        credits: Math.round(p.credits),
        hv: hvs.length,
        byState,
        claimedN,
        claimedRem: Math.round(claimedRem),
        // Far-field assignments (not near any owned ref)
        farAssign: hvs.filter((h) => {
          if (!h.assigned) return false;
          const f = S.resourceFields.get(h.assigned);
          if (!f) return false;
          return !refs.some((r) => (r.x - f.x) ** 2 + (r.z - f.z) ** 2 < claimR2);
        }).length,
        stuckMovingRef: hvs.filter((h) => h.state === 'movingToRefinery' && h.distRef != null && h.distRef > 20).length,
        stuckMovingField: hvs.filter((h) => h.state === 'movingToField' && h.distField != null && h.distField > 30).length,
        idleWithCargo: hvs.filter((h) => h.state === 'idle' && h.cargo > 0).length,
        sampleHvs: hvs.slice(0, 3),
      };
    });

    const totalRem = fields.reduce((a, f) => a + (f.depleted ? 0 : f.rem), 0);
    const depletedN = fields.filter((f) => f.depleted).length;

    return {
      t: Math.round(t),
      totalRem,
      depletedN,
      fieldCap: RESOURCE_FIELD_CAPACITY,
      seats,
    };
  });

  const meanH = snap.seats.reduce((a, s) => a + s.harvested, 0) / snap.seats.length;
  const states = {};
  let far = 0;
  let stuckR = 0;
  let stuckF = 0;
  for (const s of snap.seats) {
    far += s.farAssign;
    stuckR += s.stuckMovingRef;
    stuckF += s.stuckMovingField;
    for (const [k, v] of Object.entries(s.byState)) states[k] = (states[k] || 0) + v;
  }
  console.log(
    JSON.stringify({
      t: snap.t,
      meanHarvest: Math.round(meanH),
      totalRem: snap.totalRem,
      depletedN: snap.depletedN,
      states,
      farAssign: far,
      stuckRef: stuckR,
      stuckField: stuckF,
      seats: snap.seats.map((s) => ({
        id: s.id,
        h: s.harvested,
        hv: s.hv,
        claim: s.claimedN,
        rem: s.claimedRem,
        far: s.farAssign,
        st: s.byState,
      })),
    })
  );
}

await browser.close();
server.close();
