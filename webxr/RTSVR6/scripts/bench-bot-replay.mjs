/**
 * Replay a recorded human 1v1 as player 0. Player 1 is the live siege bot.
 * Win = player 0 defeated, player 1 still alive.
 *
 *   node scripts/bench-bot-replay.mjs [trace.json]
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 9053;
const TRACE = process.argv[2] || 'C:/Users/michi/Downloads/rtsvr6-trace-762s.json';
const MIRROR = process.env.MIRROR === '1';
const EXTRA = process.env.EXTRA != null ? Number(process.env.EXTRA) : (MIRROR ? 0 : 900);
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm',
};

const trace = JSON.parse(fs.readFileSync(TRACE, 'utf8'));
const humanEvents = trace.events.filter((e) => e.who === 'human' && e.pid === 0);
const humanSnaps = (trace.snaps || []).map((s) => {
  const seat = (s.seats || []).find((x) => x.id === 0);
  return { t: s.t, credits: seat ? seat.credits : null };
}).filter((s) => s.credits != null);

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
page.setDefaultTimeout(180000);
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
page.on('console', (msg) => {
  const t = msg.text();
  if (t.startsWith('REPLAY') || t.startsWith('PAGEERROR')) console.log(t);
});

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
  const p0 = S.players[0];
  const p1 = S.players[1];
  return {
    p0bot: !!p0.isBot,
    p1bot: !!p1.isBot,
    p0human: !!p0.isHuman,
    strat: p1.botStrategy || p1.botMemory?.strategyId || null,
  };
});
console.log('SETUP', JSON.stringify(setup));

const LIMIT = Math.ceil(Math.max(trace.elapsed || 0, 700) + EXTRA);
const STEP = 30;
let elapsed = 0;
let gameOver = false;
let last = null;
const fails = [];

while (elapsed < LIMIT && !gameOver) {
  const until = Math.min(LIMIT, elapsed + STEP);
  const due = humanEvents.filter((e) => e.t > elapsed && e.t <= until);
  const snaps = humanSnaps.filter((s) => s.t > elapsed && s.t <= until);
  last = await page.evaluate(async ({ due, snaps, until, mirror }) => {
    const S = await import('./js/state.js');
    const U = await import('./js/units.js');
    const B = await import('./js/buildings.js');
    const Loop = await import('./js/loop.js');
    const Fog = await import('./js/fog.js');
    const { BUILDING_TYPES, UNIT_TYPES } = await import('./js/config.js');

    if (mirror) S.players[1].isBot = false;
    const orderedAt = window.__replayOrderedAt || (window.__replayOrderedAt = new Map());
    const failLog = [];

    function dist2(ax, az, bx, bz) {
      const dx = ax - bx;
      const dz = az - bz;
      return dx * dx + dz * dz;
    }

    function living(pid) {
      const out = [];
      S.units.forEach((u) => {
        if (u.ownerId === pid && u.hp > 0) out.push(u);
      });
      return out;
    }

    function pickUnits(pid, types, x, z, now) {
      const ids = [];
      const pool = living(pid);
      for (const [type, count] of Object.entries(types || {})) {
        const c = Math.max(0, count | 0);
        const cand = pool.filter((u) => u.type === type && !ids.includes(u.id));
        cand.sort((a, b) => {
          const ra = now - (orderedAt.get(a.id) || -999);
          const rb = now - (orderedAt.get(b.id) || -999);
          const aFresh = ra > 0.4 ? 0 : 1;
          const bFresh = rb > 0.4 ? 0 : 1;
          if (aFresh !== bFresh) return aFresh - bFresh;
          return dist2(b.x, b.z, x, z) - dist2(a.x, a.z, x, z);
        });
        for (let i = 0; i < c && i < cand.length; i++) {
          ids.push(cand[i].id);
          orderedAt.set(cand[i].id, now);
        }
      }
      return ids;
    }

    function nearestProducer(pid, unitType, x, z) {
      let best = null;
      let bestD = Infinity;
      S.buildings.forEach((b) => {
        if (b.ownerId !== pid || b.hp <= 0 || !b.isBuilt) return;
        const produces = BUILDING_TYPES[b.type]?.producesUnits || [];
        if (!produces.includes(unitType)) return;
        const d = dist2(b.x, b.z, x, z);
        if (d < bestD) { best = b; bestD = d; }
      });
      return best;
    }

    function buildingNear(type, x, z, ownerId) {
      let best = null;
      let bestD = 18 * 18;
      S.buildings.forEach((b) => {
        if (b.hp <= 0) return;
        if (type && b.type !== type) return;
        if (ownerId != null && b.ownerId !== ownerId) return;
        const d = dist2(b.x, b.z, x, z);
        if (d < bestD) { best = b; bestD = d; }
      });
      return best;
    }

    function ensureCredits(pid, cost) {
      const p = S.players[pid];
      if (p.credits < cost) p.credits = cost;
    }

    function apply(e, pid) {
      const now = S.gameSession.elapsedTime;
      const tag = pid === 0 ? '' : 'm ';
      if (e.kind === 'build') {
        const cost = BUILDING_TYPES[e.type]?.cost || 0;
        ensureCredits(pid, cost);
        const code = B.getPlaceBuildingFailureCode(e.type, pid, e.x, e.z);
        if (code) {
          failLog.push(`${now.toFixed(0)} ${tag}build ${e.type} ${code}`);
          return;
        }
        B.placeBuilding(e.type, pid, e.x, e.z);
        return;
      }
      if (e.kind === 'train') {
        const prod = nearestProducer(pid, e.type, e.x, e.z);
        if (!prod) {
          failLog.push(`${now.toFixed(0)} ${tag}train ${e.type} no-producer`);
          return;
        }
        ensureCredits(pid, UNIT_TYPES[e.type]?.cost || 0);
        const code = B.getQueueUnitFailureCode(prod.id, e.type);
        if (code) {
          failLog.push(`${now.toFixed(0)} ${tag}train ${e.type} ${code}`);
          return;
        }
        B.queueUnit(prod.id, e.type);
        return;
      }
      if (e.kind === 'deploy') {
        let mhq = null;
        let bestD = Infinity;
        for (const u of living(pid)) {
          if (u.type !== 'mobileHq') continue;
          const d = dist2(u.x, u.z, e.x, e.z);
          if (d < bestD) { mhq = u; bestD = d; }
        }
        if (!mhq) {
          failLog.push(`${now.toFixed(0)} ${tag}deploy no-mhq`);
          return;
        }
        if (bestD > 12 * 12) {
          mhq.x = e.x;
          mhq.z = e.z;
        }
        if (!B.tryDeployMobileHq(mhq)) failLog.push(`${now.toFixed(0)} ${tag}deploy fail`);
        return;
      }
      if (e.kind === 'move' || e.kind === 'attackMove') {
        const ids = pickUnits(pid, e.types, e.x, e.z, now);
        if (!ids.length) return;
        if (e.kind === 'attackMove') U.commandAttackMove(ids, e.x, e.z);
        else U.commandMove(ids, e.x, e.z, { playerCommanded: true });
        return;
      }
      if (e.kind === 'attackBuilding' || e.kind === 'attackUnit') {
        if (mirror) return;
        const n = e.n || 8;
        const ids = pickUnits(pid, { artillery: n }, e.x, e.z, now);
        if (!ids.length) return;
        const enemy = pid === 0 ? 1 : 0;
        let bld = e.kind === 'attackBuilding'
          ? buildingNear(e.type, e.x, e.z, enemy) || buildingNear(null, e.x, e.z, enemy)
          : null;
        if (!bld) {
          let bestD = Infinity;
          S.buildings.forEach((b) => {
            if (b.ownerId !== enemy || b.hp <= 0 || b.type !== 'hq') return;
            const d = dist2(b.x, b.z, e.x, e.z);
            if (d < bestD) { bld = b; bestD = d; }
          });
        }
        if (bld) U.commandAttackBuilding(ids, bld.id);
        else U.commandAttackMove(ids, e.x, e.z);
      }
    }

    function mirrorEvent(e) {
      return { ...e, z: -(e.z || 0) };
    }

    let ei = 0;
    let si = 0;
    const start = S.gameSession.elapsedTime;
    while (S.gameSession.elapsedTime < until - 0.02 && !S.gameSession.gameOver) {
      const now = S.gameSession.elapsedTime;
      let nextT = until;
      if (ei < due.length) nextT = Math.min(nextT, due[ei].t);
      if (si < snaps.length) nextT = Math.min(nextT, snaps[si].t);
      const slice = Math.max(0.05, nextT - now);
      const ff = Loop.fastForwardSim(slice);
      const tNow = S.gameSession.elapsedTime;
      while (si < snaps.length && snaps[si].t <= tNow + 0.05) {
        const p = S.players[0];
        if (p && !p.isDefeated && p.credits < snaps[si].credits) p.credits = snaps[si].credits;
        si++;
      }
      while (ei < due.length && due[ei].t <= tNow + 0.05) {
        apply(due[ei], 0);
        if (mirror) apply(mirrorEvent(due[ei]), 1);
        ei++;
      }
      if (ff.gameOver || ff.steps === 0) break;
      if (tNow <= start && slice > 0 && ff.steps === 0) break;
      const mark = Math.floor(tNow / 120);
      if (mark !== window.__replayMark) {
        window.__replayMark = mark;
        let n = 0; let sx = 0; let sz = 0; let hq = 0;
        S.units.forEach((u) => {
          if (u.ownerId === 1 && u.type === 'artillery' && u.hp > 0) { n++; sx += u.x; sz += u.z; }
        });
        S.buildings.forEach((b) => { if (b.ownerId === 0 && b.type === 'hq' && b.hp > 0) hq += b.hp; });
        console.log(`REPLAY t=${tNow.toFixed(0)} guns=${n}@${n ? Math.round(sx / n) : 0},${n ? Math.round(sz / n) : 0} hq=${Math.round(hq)}`);
      }
    }

    if (mirror) {
      pressPack(0, 147, -117);
      pressPack(1, 147, 117);
    }

    function pressPack(pid, gx, gz) {
      const guns = living(pid).filter((u) => u.type === 'artillery');
      if (guns.length < 4) return;
      let lead = guns[0];
      for (const g of guns) {
        if (pid === 1 ? g.z > lead.z : g.z < lead.z) lead = g;
      }
      const enemy = pid === 0 ? 1 : 0;
      let hq = null;
      let best = Infinity;
      S.buildings.forEach((b) => {
        if (b.ownerId !== enemy || b.hp <= 0 || b.type !== 'hq') return;
        const d = dist2(b.x, b.z, gx, gz);
        if (d < best) { hq = b; best = d; }
      });
      const pack = guns.filter((g) => dist2(g.x, g.z, lead.x, lead.z) < 45 * 45);
      const ids = pack.map((g) => g.id);
      const now = S.gameSession.elapsedTime;
      const key = '__press' + pid;
      const toHq = hq ? Math.hypot(lead.x - hq.x, lead.z - hq.z) : 999;
      if (hq && toHq < 78) {
        if (now - (window[key] || 0) > 20) {
          window[key] = now;
          U.commandAttackBuilding(ids, hq.id);
        }
        return;
      }
      const toGoal = Math.hypot(lead.x - gx, lead.z - gz);
      const tp = lead.targetPos;
      const toTarget = tp ? Math.hypot(lead.x - tp.x, lead.z - tp.z) : 999;
      const stuckOrder = lead.state === 'moving' && toTarget > 30;
      const moving = lead.state === 'moving' && toTarget > 8 && !stuckOrder;
      if (!moving && toGoal > 18 && now - (window[key] || 0) > 12) {
        window[key] = now;
        const dx = gx - lead.x;
        const dz = gz - lead.z;
        const len = Math.hypot(dx, dz) || 1;
        const step = Math.min(40, len);
        U.commandMove(ids, lead.x + (dx / len) * step, lead.z + (dz / len) * step, { playerCommanded: true });
      }
    }

    function census(pid) {
      const units = {};
      const blds = {};
      let hq = 0;
      S.units.forEach((u) => {
        if (u.ownerId === pid && u.hp > 0) units[u.type] = (units[u.type] || 0) + 1;
      });
      S.buildings.forEach((b) => {
        if (b.ownerId !== pid || b.hp <= 0) return;
        blds[b.type] = (blds[b.type] || 0) + 1;
        if (b.type === 'hq') hq += b.hp;
      });
      const p = S.players[pid];
      const st = p?.stats || {};
      return {
        credits: Math.round(p?.credits || 0),
        harvested: Math.round(st.creditsHarvested || 0),
        earned: Math.round(st.creditsEarned || 0),
        kills: st.kills || 0,
        lost: st.unitsLost || 0,
        produced: st.unitsProduced || 0,
        defeated: !!p?.isDefeated,
        hq: Math.round(hq),
        units,
        blds,
      };
    }

    const mem = S.players[1]?.botMemory;
    let mhq = null;
    S.units.forEach((u) => {
      if (u.ownerId === 1 && u.type === 'mobileHq' && u.hp > 0) {
        mhq = {
          x: Math.round(u.x), z: Math.round(u.z),
          tx: u.targetPos ? Math.round(u.targetPos.x) : null,
          tz: u.targetPos ? Math.round(u.targetPos.z) : null,
          state: u.state,
          cmd: !!u.playerCommanded,
          deploy: B.getMobileHqDeployFailureCode(1, u.x, u.z),
          flee: u._botFleeUntil ? Math.round(u._botFleeUntil - S.gameSession.elapsedTime) : 0,
        };
      }
    });
    let hArty = null;
    let nArty = 0;
    let ax = 0;
    let az = 0;
    S.units.forEach((u) => {
      if (u.ownerId === 0 && u.type === 'artillery' && u.hp > 0) {
        nArty++;
        ax += u.x;
        az += u.z;
      }
    });
    if (nArty) hArty = { n: nArty, x: Math.round(ax / nArty), z: Math.round(az / nArty) };
    let bArty = null;
    let bn = 0;
    let bx = 0;
    let bz = 0;
    S.units.forEach((u) => {
      if (u.ownerId === 1 && u.type === 'artillery' && u.hp > 0) {
        bn++;
        bx += u.x;
        bz += u.z;
      }
    });
    if (bn) bArty = { n: bn, x: Math.round(bx / bn), z: Math.round(bz / bn) };
    const siege = (mem?.currentMissions || []).find((m) => m.type === 'SIEGE');

    function scout(pid) {
      const team = S.players[pid].team;
      const enemy = pid === 0 ? 1 : 0;
      const fields = [];
      S.resourceFields.forEach((f) => {
        fields.push({
          id: f.id,
          x: Math.round(f.x),
          z: Math.round(f.z),
          seen: Fog.wasExploredByTeam(team, f.x, f.z),
        });
      });
      const bases = [];
      S.buildings.forEach((b) => {
        if (b.ownerId !== enemy || b.hp <= 0 || b.type !== 'hq') return;
        bases.push({
          x: Math.round(b.x),
          z: Math.round(b.z),
          seen: Fog.wasExploredByTeam(team, b.x, b.z),
          live: Fog.isVisibleToTeam(team, b.x, b.z),
        });
      });
      return {
        seen: fields.filter((f) => f.seen).map((f) => f.id),
        missed: fields.filter((f) => !f.seen).map((f) => `${f.id}@${f.x},${f.z}`),
        bases,
      };
    }

    return {
      elapsed: Math.round(S.gameSession.elapsedTime),
      gameOver: !!S.gameSession.gameOver,
      winner: S.gameSession.winner,
      human: census(0),
      bot: census(1),
      fails: failLog.slice(0, 12),
      failN: failLog.length,
      mhq,
      commit: mem?.expandCommitFieldId || null,
      discovered: (mem?.discoveredResources || []).length,
      avoid: Object.keys(mem?.expandAvoidUntil || {}),
      hArty,
      bArty,
      scout: scout(1),
      siege: siege ? { x: Math.round(siege.targetPos?.x || 0), z: Math.round(siege.targetPos?.z || 0), n: siege.unitIds.length } : null,
    };
  }, { due, snaps, until, mirror: MIRROR });

  elapsed = last.elapsed;
  gameOver = last.gameOver;
  if (last.fails?.length) fails.push(...last.fails);
  const h = last.human;
  const b = last.bot;
  console.log(
    `t=${last.elapsed} over=${last.gameOver} win=${last.winner} ` +
    `H hq=${h.hq} k=${h.kills} lost=${h.lost} hv=${h.harvested} cr=${h.credits} ${JSON.stringify(h.units)} | ` +
    `B hq=${b.hq} k=${b.kills} lost=${b.lost} hv=${b.harvested} cr=${b.credits} ${JSON.stringify(b.units)} ` +
    `bArty=${JSON.stringify(last.bArty)} scout=${JSON.stringify(last.scout)} fails=${last.failN}`,
  );
  if (last.fails?.length) console.log('  ', last.fails.join(' | '));
}

const botWon = !!(last && last.gameOver && last.human.defeated && !last.bot.defeated);
console.log('VERDICT', JSON.stringify({
  trace: path.basename(TRACE),
  mode: MIRROR ? 'mirror' : 'siege',
  botWon,
  elapsed: last?.elapsed,
  winner: last?.winner,
  human: last?.human,
  bot: last?.bot,
  failN: fails.length,
}));

await browser.close();
server.close();
process.exit(botWon ? 0 : 2);
