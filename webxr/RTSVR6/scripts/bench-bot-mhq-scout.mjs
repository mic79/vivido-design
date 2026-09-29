/**
 * Bench: no twin MHQs, MHQ aborts hostile pads, scouts flee static arty, combat answers guns.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9046;
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
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));

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
  const B = await import('./js/buildings.js');
  const Fog = await import('./js/fog.js');
  const {
    BOT_STRATEGY_1V1,
    FOG_GRID_SIZE,
    FOG_CELL_SIZE,
    MAP_NAV_PLANE_HALF_M,
  } = await import('./js/config.js');

  for (const p of S.players) {
    if (!p.isActive || p.isDefeated) continue;
    p.isHuman = false;
    p.isBot = true;
  }
  Bot.applyBotStrategy(S.players[0], 'siege_answer');
  Bot.applyBotStrategy(S.players[1], BOT_STRATEGY_1V1);

  const hq0 = S.getPlayerHQ(0);
  const hq1 = S.getPlayerHQ(1);

  // Plant a static artillery near the center expand (force-create; skip tech/cash gates).
  const gun = B.createBuilding('artilleryTurret', 0, 28, 8, { spawnComplete: true });
  if (gun) {
    S.addBuilding?.(gun);
    // createBuilding already adds — ensure combat stats present.
    gun.isBuilt = true;
    gun.constructionProgress = 1;
  }

  // Give P1 a war factory + cash + discover center fields so MHQ path is active.
  const p1 = S.players[1];
  p1.credits = 4000;
  const mem = p1.botMemory;
  mem.discoveredResources = [...S.resourceFields.keys()];
  mem.expandCommitFieldId = null;
  mem._seenEnemyArtillery = true;

  // Seed a scout near the gun and point it at the death pad.
  let scoutId = null;
  if (hq1) {
    const scout = U.createUnit('scoutBike', 1, 18, 4, { skipProducedStat: true });
    scoutId = scout?.id || null;
    if (scout) {
      U.commandAttackMove([scout.id], 28, 8);
      p1.botMemory.currentMissions.push({
        type: 'SCOUT',
        unitIds: [scout.id],
        targetPos: { x: 28, z: 8 },
        startedAt: S.gameSession.elapsedTime,
        status: 'active',
        _hpWatch: scout.hp,
      });
      // Simulate first shell hit so flee/abort must fire even before the gun cycles.
      scout.hp = Math.max(1, scout.hp - 40);
      scout._botDamagedAt = S.gameSession.elapsedTime;
      scout._botLastAttackerId = gun?.id;
      scout._botLastAttackerLongRange = true;
    }
  }

  // Reveal gun to P1.
  const grid = Fog.getTeamGrid(p1.team);
  if (grid) {
    for (const [wx, wz] of [[28, 8], [0, 0], [30, 0]]) {
      const r = 40;
      for (let dx = -r; dx <= r; dx += FOG_CELL_SIZE) {
        for (let dz = -r; dz <= r; dz += FOG_CELL_SIZE) {
          if (dx * dx + dz * dz > r * r) continue;
          const gx = Math.floor((wx + dx + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
          const gz = Math.floor((wz + dz + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
          if (gx < 0 || gz < 0 || gx >= FOG_GRID_SIZE || gz >= FOG_GRID_SIZE) continue;
          grid[gz * FOG_GRID_SIZE + gx] = 2;
        }
      }
    }
  }

  return { scoutId, gunId: gun?.id || null, hq1: hq1 ? { x: hq1.x, z: hq1.z } : null };
});
console.log('setup', JSON.stringify(setup));

if (!setup.gunId) {
  console.error('FAILED to plant artilleryTurret');
  await browser.close();
  server.close();
  process.exit(3);
}

async function snap() {
  return page.evaluate(async (scoutId) => {
    const S = await import('./js/state.js');
    const t = Math.round(S.gameSession.elapsedTime);
    const p1 = S.players[1];
    let mhq = 0;
    let mhqNearGun = 0;
    let scoutAlive = false;
    let scoutFleeing = false;
    let scoutDistToGun = null;
    let combatAttackingGun = 0;
    const gun = [...S.buildings.values()].find(b => b.type === 'artilleryTurret' && b.ownerId === 0 && b.hp > 0);

    S.units.forEach((u) => {
      if (u.ownerId !== 1 || u.hp <= 0) return;
      if (u.type === 'mobileHq') {
        mhq++;
        if (gun && (u.x - gun.x) ** 2 + (u.z - gun.z) ** 2 < 55 * 55) mhqNearGun++;
      }
      if (u.id === scoutId) {
        scoutAlive = true;
        scoutFleeing = !!(u._botFleeUntil && S.gameSession.elapsedTime < u._botFleeUntil);
        if (gun) scoutDistToGun = Math.hypot(u.x - gun.x, u.z - gun.z);
      }
      if (gun && u.targetBuildingId === gun.id) combatAttackingGun++;
    });

    const scoutMission = (p1.botMemory?.currentMissions || []).some(
      (m) => m.type === 'SCOUT' && m.unitIds?.includes(scoutId) && m.status !== 'complete'
    );

    return {
      t,
      mhq,
      mhqNearGun,
      scoutAlive,
      scoutFleeing,
      scoutDistToGun: scoutDistToGun != null ? +scoutDistToGun.toFixed(1) : null,
      scoutMission,
      combatAttackingGun,
      avoid: p1.botMemory?.expandAvoidUntil || {},
      dangerN: (p1.botMemory?.dangerZones || []).length,
    };
  }, setup.scoutId);
}

const history = [];
let maxMhq = 0;
for (const block of [8, 8, 8, 12, 15, 20, 25, 30, 40]) {
  await page.evaluate(async (s) => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(s);
  }, block);
  // Keep fog live on the gun.
  await page.evaluate(async () => {
    const S = await import('./js/state.js');
    const Fog = await import('./js/fog.js');
    const { FOG_GRID_SIZE, FOG_CELL_SIZE, MAP_NAV_PLANE_HALF_M } = await import('./js/config.js');
    const grid = Fog.getTeamGrid(S.players[1].team);
    if (!grid) return;
    const wx = 28; const wz = 8; const r = 40;
    for (let dx = -r; dx <= r; dx += FOG_CELL_SIZE) {
      for (let dz = -r; dz <= r; dz += FOG_CELL_SIZE) {
        if (dx * dx + dz * dz > r * r) continue;
        const gx = Math.floor((wx + dx + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
        const gz = Math.floor((wz + dz + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
        if (gx < 0 || gz < 0 || gx >= FOG_GRID_SIZE || gz >= FOG_GRID_SIZE) continue;
        grid[gz * FOG_GRID_SIZE + gx] = 2;
      }
    }
  });
  const s = await snap();
  maxMhq = Math.max(maxMhq, s.mhq);
  history.push(s);
  console.log(JSON.stringify(s));
}

const scoutAborted = history.some((s) => s.scoutFleeing || (!s.scoutMission && s.scoutAlive));
const scoutDidNotSuicide =
  history.some((s) => s.scoutFleeing)
  || (history[history.length - 1].scoutAlive && history[history.length - 1].scoutDistToGun > 40);
const noTwinMhq = maxMhq <= 1;
const everAnsweredGun = history.some((s) => s.combatAttackingGun > 0);
const mhqAvoidedGun = !history.some((s) => s.mhqNearGun > 0);

const verdict = {
  ok: noTwinMhq && scoutAborted && scoutDidNotSuicide,
  noTwinMhq,
  maxMhq,
  scoutAborted,
  scoutDidNotSuicide,
  everAnsweredGun,
  mhqAvoidedGun,
  last: history[history.length - 1],
};
console.log('VERDICT', JSON.stringify(verdict));

await browser.close();
server.close();
process.exit(verdict.ok ? 0 : 2);
