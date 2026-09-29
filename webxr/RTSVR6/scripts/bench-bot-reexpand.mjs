/**
 * MHQ denied by static arty must take a different crystal — never orbit the home HQ.
 * After the second base is up, the bot must field an army and issue an attack.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9049;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm',
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
await page.evaluate(() => { window._dismissAppStartGate?.(); window._startGame('1v1'); });
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
    BOT_STRATEGY_1V1, FOG_GRID_SIZE, FOG_CELL_SIZE, MAP_NAV_PLANE_HALF_M,
  } = await import('./js/config.js');

  for (const p of S.players) {
    if (!p.isActive || p.isDefeated) continue;
    p.isHuman = false;
    p.isBot = true;
  }
  Bot.applyBotStrategy(S.players[0], 'aggro_rush');
  Bot.applyBotStrategy(S.players[1], BOT_STRATEGY_1V1);

  const hq1 = S.getPlayerHQ(1);
  const field = S.resourceFields.get('resource_5');
  // Power the gun so it actually shoots.
  B.createBuilding('solarPanel', 0, 140, 140, { spawnComplete: true });
  const gun = B.createBuilding('artilleryTurret', 0, field.x, field.z + 10, { spawnComplete: true });

  const p1 = S.players[1];
  p1.credits = 2500;
  p1.botMemory.discoveredResources = [...S.resourceFields.keys()];
  p1.botMemory.expandCommitFieldId = 'resource_5';
  p1.botMemory._seenEnemyArtillery = true;

  const mhq = U.createUnit('mobileHq', 1, field.x + 18, field.z + 18, { skipProducedStat: true });
  U.commandMove([mhq.id], field.x, field.z, { playerCommanded: false });
  mhq._mhqAbortExpand = true;
  mhq.hp = Math.max(80, mhq.hp - 50);
  mhq._botDamagedAt = S.gameSession.elapsedTime;
  mhq._botLastAttackerLongRange = true;

  const grid = Fog.getTeamGrid(p1.team);
  const stamp = (wx, wz) => {
    const r = 36;
    for (let dx = -r; dx <= r; dx += FOG_CELL_SIZE) {
      for (let dz = -r; dz <= r; dz += FOG_CELL_SIZE) {
        if (dx * dx + dz * dz > r * r) continue;
        const gx = Math.floor((wx + dx + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
        const gz = Math.floor((wz + dz + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
        if (gx < 0 || gz < 0 || gx >= FOG_GRID_SIZE || gz >= FOG_GRID_SIZE) continue;
        grid[gz * FOG_GRID_SIZE + gx] = 2;
      }
    }
  };
  stamp(field.x, field.z);
  stamp(0, 0);

  return {
    mhqId: mhq.id,
    gun: gun ? { x: gun.x, z: gun.z, id: gun.id } : null,
    home: { x: hq1.x, z: hq1.z },
    field: { x: field.x, z: field.z },
  };
});
console.log('setup', JSON.stringify(setup));

const samples = [];
for (let i = 0; i < 18; i++) {
  await page.evaluate(async () => {
    const L = await import('./js/loop.js');
    return L.fastForwardSim(15);
  });
  const s = await page.evaluate(async (home) => {
    const S = await import('./js/state.js');
    const p1 = S.players[1];
    let mhq = null;
    let combat = 0;
    let attacking = 0;
    S.units.forEach((u) => {
      if (u.ownerId !== 1 || u.hp <= 0) return;
      if (u.type === 'mobileHq') {
        mhq = { x: +u.x.toFixed(1), z: +u.z.toFixed(1), state: u.state };
      }
      if (u.type !== 'harvester' && u.type !== 'engineer' && u.type !== 'scoutBike' && u.type !== 'mobileHq') {
        combat++;
        if (u.state === 'attacking' || u.targetBuildingId || u.targetUnitId) attacking++;
      }
    });
    const hqs = [];
    let refs = 0;
    S.buildings.forEach((b) => {
      if (b.ownerId !== 1 || b.hp <= 0) return;
      if (b.type === 'hq') hqs.push({ x: +b.x.toFixed(1), z: +b.z.toFixed(1) });
      if (b.type === 'refinery') refs++;
    });
    const missions = (p1.botMemory.currentMissions || []).map((m) => m.type);
    const dHome = mhq ? Math.hypot(mhq.x - home.x, mhq.z - home.z) : null;
    return {
      t: Math.round(S.gameSession.elapsedTime),
      mhq, dHome: dHome != null ? +dHome.toFixed(1) : null,
      hqs: hqs.length, refs, combat, attacking,
      commit: p1.botMemory.expandCommitFieldId,
      missions,
      credits: Math.round(p1.credits),
    };
  }, setup.home);
  samples.push(s);
  console.log(JSON.stringify(s));
}

const after = samples.filter((s) => s.t >= 20);
const orbitSamples = after.filter((s) => s.dHome != null && s.dHome < 28);
const deployed = samples.some((s) => s.hqs >= 2);
const last = samples[samples.length - 1];
const farDeploy = samples.some((s) => {
  if (s.hqs < 2) return false;
  return true;
});
const attacked = samples.some((s) =>
  s.attacking > 0
  || s.missions.some((m) => m === 'STRIKE' || m === 'PUSH' || m === 'retaliation')
);

const earlySecondMhq = samples.some((s) => s.hqs >= 2 && s.refs < s.hqs && s.mhq);
const verdict = {
  ok: orbitSamples.length <= 1 && deployed && last.refs >= 2 && (last.combat >= 6 || attacked) && !earlySecondMhq,
  orbitSamples: orbitSamples.length,
  deployed,
  farDeploy,
  attacked,
  earlySecondMhq,
  last,
};
console.log('VERDICT', JSON.stringify(verdict));
await browser.close();
server.close();
process.exit(verdict.ok ? 0 : 2);
