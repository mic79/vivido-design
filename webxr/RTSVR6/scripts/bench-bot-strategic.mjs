/**
 * Strategic bot bench (1v1): expand targeting, cluster refs, artillery + static defenses.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9044;
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
  window._startGame('1v1');
});
await page.waitForFunction(() => {
  const o = document.getElementById('match-prepare-overlay');
  return !(o && !o.hidden);
}, null, { timeout: 300000 });
await page.waitForFunction(async () => {
  const S = await import('./js/state.js');
  return !!S.gameSession.gameStarted;
}, null, { timeout: 120000 });

const setup = await page.evaluate(async () => {
  const S = await import('./js/state.js');
  const Bot = await import('./js/bot.js');
  const U = await import('./js/units.js');
  const Fog = await import('./js/fog.js');
  const {
    BOT_STRATEGY_1V1,
    RESOURCE_FIELD_CAPACITY,
    FOG_GRID_SIZE,
    FOG_CELL_SIZE,
    MAP_NAV_PLANE_HALF_M,
  } = await import('./js/config.js');

  for (const p of S.players) {
    if (!p.isActive || p.isDefeated) continue;
    p.isHuman = false;
    p.isBot = true;
  }
  Bot.applyBotStrategy(S.players[0], 'aggro_rush');
  Bot.applyBotStrategy(S.players[1], BOT_STRATEGY_1V1);

  const hq0 = S.getPlayerHQ(0);
  const hq1 = S.getPlayerHQ(1);
  if (hq0) {
    for (let i = 0; i < 3; i++) {
      U.createUnit('artillery', 0, hq0.x + 6 + i * 2, hq0.z + 4, { skipProducedStat: true });
    }
  }

  // Real contested-ring crystals (already on map).
  const centerIds = ['resource_4', 'resource_5', 'resource_6', 'resource_7'];
  const p1 = S.players[1];
  const mem = p1.botMemory;
  mem.expandCommitFieldId = null;
  mem._seenEnemyArtillery = true; // siege contact already happened
  mem.discoveredResources = [...new Set([
    ...(mem.discoveredResources || []),
    ...centerIds,
    ...[...S.resourceFields.keys()],
  ])];

  // Starve ONLY enemy-home ore (don't MHQ to scraps under P0). Keep P1 income alive.
  S.resourceFields.forEach((f) => {
    if (!f || centerIds.includes(f.id)) return;
    if (!hq0) return;
    if ((f.x - hq0.x) ** 2 + (f.z - hq0.z) ** 2 < 55 * 55) {
      f.remaining = Math.floor((f.capacity || RESOURCE_FIELD_CAPACITY) * 0.08);
    }
  });

  // Stamp P1 fog so enemy arty at P0 HQ is visible this tick and stays explored.
  const grid = Fog.getTeamGrid(p1.team);
  if (grid && hq0) {
    const r = 48;
    const r2 = r * r;
    for (let dx = -r; dx <= r; dx += FOG_CELL_SIZE) {
      for (let dz = -r; dz <= r; dz += FOG_CELL_SIZE) {
        if (dx * dx + dz * dz > r2) continue;
        const wx = hq0.x + dx;
        const wz = hq0.z + dz;
        const gx = Math.floor((wx + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
        const gz = Math.floor((wz + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
        if (gx < 0 || gz < 0 || gx >= FOG_GRID_SIZE || gz >= FOG_GRID_SIZE) continue;
        grid[gz * FOG_GRID_SIZE + gx] = 2;
      }
    }
  }

  return {
    centerIds,
    hq0: hq0 ? { x: hq0.x, z: hq0.z } : null,
    hq1: hq1 ? { x: hq1.x, z: hq1.z } : null,
  };
});
console.log('setup', JSON.stringify(setup));

async function snap() {
  return page.evaluate(async (centerIds) => {
    const S = await import('./js/state.js');
    const t = Math.round(S.gameSession.elapsedTime);
    const rows = [];
    for (const p of S.players) {
      if (!p.isActive || p.isDefeated) continue;
      let refs = 0;
      let turrets = 0;
      let artyT = 0;
      let centerRefs = 0;
      const coveredCenters = new Set();
      let mhqNearEnemy = 0;
      let mhqNearScrapEnemy = 0;
      S.buildings.forEach((b) => {
        if (b.ownerId !== p.id || b.hp <= 0) return;
        if (b.type === 'refinery') {
          refs++;
          for (const id of centerIds) {
            const f = S.resourceFields.get(id);
            if (!f) continue;
            if ((b.x - f.x) ** 2 + (b.z - f.z) ** 2 < 32 * 32) {
              centerRefs++;
              coveredCenters.add(id);
            }
          }
        }
        if (b.type === 'turret') turrets++;
        if (b.type === 'artilleryTurret') artyT++;
      });
      let arty = 0;
      let mhq = 0;
      let hqs = 0;
      S.buildings.forEach((b) => {
        if (b.ownerId === p.id && b.hp > 0 && b.type === 'hq') hqs++;
      });
      S.units.forEach((u) => {
        if (u.ownerId !== p.id || u.hp <= 0) return;
        if (u.type === 'artillery') arty++;
        if (u.type === 'mobileHq') {
          mhq++;
          S.buildings.forEach((b) => {
            if (b.type !== 'hq' || b.hp <= 0 || b.team === p.team) return;
            if ((u.x - b.x) ** 2 + (u.z - b.z) ** 2 < 55 * 55) mhqNearEnemy++;
          });
          S.resourceFields.forEach((f) => {
            if (!f || f.remaining / (f.capacity || 1) > 0.15) return;
            S.buildings.forEach((b) => {
              if (b.type !== 'hq' || b.hp <= 0 || b.team === p.team) return;
              if ((f.x - b.x) ** 2 + (f.z - b.z) ** 2 > 55 * 55) return;
              if ((u.x - f.x) ** 2 + (u.z - f.z) ** 2 < 40 * 40) mhqNearScrapEnemy++;
            });
          });
        }
      });
      rows.push({
        id: p.id,
        strat: p.botMemory?.strategyId || null,
        refs,
        centerRefs,
        coveredCenters: [...coveredCenters],
        turrets,
        artyT,
        arty,
        mhq,
        hqs,
        mhqNearEnemy,
        mhqNearScrapEnemy,
        credits: Math.round(p.credits),
        seenArty: !!p.botMemory?._seenEnemyArtillery,
        commit: p.botMemory?.expandCommitFieldId || null,
      });
    }
    return { t, seats: rows };
  }, setup.centerIds);
}

const history = [];
for (const block of [40, 40, 40, 40, 40, 40, 40, 40, 40]) {
  await page.evaluate(async (s) => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(s);
  }, block);
  // Keep enemy arty visible for P1 each block (fog downgrades live cells).
  await page.evaluate(async () => {
    const S = await import('./js/state.js');
    const Fog = await import('./js/fog.js');
    const { FOG_GRID_SIZE, FOG_CELL_SIZE, MAP_NAV_PLANE_HALF_M } = await import('./js/config.js');
    const hq0 = S.getPlayerHQ(0);
    const p1 = S.players[1];
    if (!hq0 || !p1) return;
    const grid = Fog.getTeamGrid(p1.team);
    if (!grid) return;
    const r = 48;
    const r2 = r * r;
    for (let dx = -r; dx <= r; dx += FOG_CELL_SIZE) {
      for (let dz = -r; dz <= r; dz += FOG_CELL_SIZE) {
        if (dx * dx + dz * dz > r2) continue;
        const wx = hq0.x + dx;
        const wz = hq0.z + dz;
        const gx = Math.floor((wx + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
        const gz = Math.floor((wz + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
        if (gx < 0 || gz < 0 || gx >= FOG_GRID_SIZE || gz >= FOG_GRID_SIZE) continue;
        grid[gz * FOG_GRID_SIZE + gx] = 2;
      }
    }
  });
  const s = await snap();
  history.push(s);
  console.log(JSON.stringify(s));
}

const p1 = history.map((h) => h.seats.find((s) => s.id === 1)).filter(Boolean);
const last = p1[p1.length - 1];
const maxCenterRefs = Math.max(...p1.map((s) => s.centerRefs));
const everArtyT = p1.some((s) => s.artyT > 0);
const everArty = p1.some((s) => s.arty > 0);
const everTurret = p1.some((s) => s.turrets > 0);
const everMhqOrExpandHq = p1.some((s) => s.mhq > 0 || s.hqs >= 2);
const scrapMarch = p1.some((s) => s.mhqNearScrapEnemy > 0 || s.mhqNearEnemy > 0);

const verdict = {
  ok:
    everArtyT
    && everArty
    && everTurret
    && everMhqOrExpandHq
    && maxCenterRefs <= 2 // opposite ring pairs may need 2; never 3+ for one pad cluster
    && !scrapMarch
    && last.seenArty,
  everArtyT,
  everArty,
  everTurret,
  everMhqOrExpandHq,
  maxCenterRefs,
  scrapMarch,
  last,
};
console.log('VERDICT', JSON.stringify(verdict));

await browser.close();
server.close();
process.exit(verdict.ok ? 0 : 1);
