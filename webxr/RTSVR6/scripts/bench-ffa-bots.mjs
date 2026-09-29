#!/usr/bin/env node
/**
 * FFA all-bot progression bench — 4 bots, N runs, fast-forwarded sim.
 *
 *   node RTSVR6/scripts/bench-ffa-bots.mjs
 *
 * Env:
 *   RUNS=10          number of FFA matches
 *   MATCH_SEC=480    sim seconds per match (default 8 min)
 *   SAMPLE_SEC=15    telemetry sample interval (sim time)
 *   PORT=8988
 *   HEADED=0
 *
 * Writes: RTSVR6/bench-ffa-bots/ffa-bots-<stamp>.json
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'bench-ffa-bots');
const PORT = Number(process.env.PORT || 8988);
const RUNS = Math.max(1, Math.min(30, Number(process.env.RUNS || 10)));
const MATCH_SEC = Math.max(60, Number(process.env.MATCH_SEC || 480));
const SAMPLE_SEC = Math.max(5, Number(process.env.SAMPLE_SEC || 15));
const HEADED = process.env.HEADED === '1' || process.env.HEADED === 'true';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function runOneMatch(page, runIndex) {
  const q =
    'perf=1&leanrocks=1&norender=1&noeffects=1&noui=1&noinput=1&nofogoverlay=1';
  await page.goto(`http://127.0.0.1:${PORT}/index.html?${q}`, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  });
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 300000 });
  await page.evaluate(() => {
    if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    window._startGame('ffa');
  });
  await page.waitForFunction(
    () => {
      const o = document.getElementById('match-prepare-overlay');
      return !(o && !o.hidden);
    },
    null,
    { timeout: 300000 }
  );
  await page.waitForFunction(
    async () => {
      const S = await import('./js/state.js');
      return !!S.gameSession.gameStarted;
    },
    null,
    { timeout: 120000 }
  );

  // Convert all seats to bots and assign one named strategy each (rotated by run for fairness).
  await page.evaluate(async (runIndex) => {
    const S = await import('./js/state.js');
    const Bot = await import('./js/bot.js');
    const { BOT_STRATEGY_ORDER } = await import('./js/config.js');
    const order = BOT_STRATEGY_ORDER.slice();
    const rot = ((runIndex % order.length) + order.length) % order.length;
    for (let r = 0; r < rot; r++) order.push(order.shift());
    let i = 0;
    for (const p of S.players) {
      if (!p.isActive || p.isDefeated) continue;
      p.isHuman = false;
      p.isBot = true;
      const sid = order[i % order.length];
      Bot.applyBotStrategy(p, sid);
      i++;
    }
  }, runIndex);

  const samples = [];
  let t = 0;
  while (t < MATCH_SEC) {
    const chunk = Math.min(SAMPLE_SEC, MATCH_SEC - t);
    const ff = await page.evaluate(async (secs) => {
      if (typeof window.__rtsFastForward !== 'function') {
        const Loop = await import('./js/loop.js');
        window.__rtsFastForward = Loop.fastForwardSim;
      }
      return window.__rtsFastForward(secs);
    }, chunk);
    t = ff.elapsed;

    const snap = await page.evaluate(async () => {
      const S = await import('./js/state.js');
      const B = await import('./js/buildings.js');
      const { BUILDING_TYPES, UNIT_TYPES } = await import('./js/config.js');

      const fieldCount = S.resourceFields.size;
      const players = S.players
        .filter((p) => p.isActive && !p.isDefeated)
        .map((p) => {
          const units = [];
          S.units.forEach((u) => {
            if (u.ownerId === p.id && u.hp > 0) units.push(u);
          });
          const buildings = [];
          S.buildings.forEach((b) => {
            if (b.ownerId === p.id && b.hp > 0) buildings.push(b);
          });
          const byTypeU = {};
          const byTypeB = {};
          let harvesters = 0;
          let combat = 0;
          let cargo = 0;
          const hvStates = {
            idle: 0,
            moving: 0,
            movingToField: 0,
            harvesting: 0,
            movingToRefinery: 0,
            depositing: 0,
            other: 0,
          };
          for (const u of units) {
            byTypeU[u.type] = (byTypeU[u.type] || 0) + 1;
            if (u.type === 'harvester') {
              harvesters++;
              cargo += u.cargo || 0;
              if (hvStates[u.state] != null) hvStates[u.state]++;
              else hvStates.other++;
            } else if (u.type !== 'engineer') {
              combat++;
            }
          }
          for (const b of buildings) {
            byTypeB[b.type] = (byTypeB[b.type] || 0) + 1;
          }
          const pow = B.getPlayerPower(p.id);
          const disc = (p.botMemory && p.botMemory.discoveredResources) || [];
          const targets = (p.botMemory && p.botMemory.targets) || [];
          let enemyHqKnown = 0;
          let enemyHqAlive = 0;
          const knownEnemyHqIds = [];
          for (const t of targets) {
            if (t.type !== 'building') continue;
            const b = S.buildings.get(t.id);
            if (!b || b.hp <= 0 || b.type !== 'hq') continue;
            const owner = S.players[b.ownerId];
            if (!owner || owner.team === p.team) continue;
            enemyHqKnown++;
            knownEnemyHqIds.push(b.id);
          }
          S.buildings.forEach((b) => {
            if (b.type !== 'hq' || b.hp <= 0) return;
            const owner = S.players[b.ownerId];
            if (!owner || owner.isDefeated || owner.team === p.team) return;
            enemyHqAlive++;
          });
          const queues = buildings.reduce((n, b) => n + (b.productionQueue?.length || 0), 0);
          const buildingAsset =
            buildings.reduce((n, b) => n + (BUILDING_TYPES[b.type]?.cost || 0), 0);
          const unitAsset = units.reduce((n, u) => n + (UNIT_TYPES[u.type]?.cost || 0), 0);

          const myRefs = buildings.filter((b) => b.type === 'refinery');
          let fieldsClaimed = 0;
          let fieldsAlive = 0;
          let claimedRemaining = 0;
          const claimR2 = 32 * 32;
          S.resourceFields.forEach((f) => {
            if (f.depleted) return;
            fieldsAlive++;
            if (
              myRefs.some(
                (r) => (r.x - f.x) * (r.x - f.x) + (r.z - f.z) * (r.z - f.z) < claimR2
              )
            ) {
              fieldsClaimed++;
              claimedRemaining += f.remaining || 0;
            }
          });

          return {
            id: p.id,
            name: p.name,
            team: p.team,
            strategyId: p.botMemory?.strategyId || null,
            strategyLabel: p.botMemory?.strategyLabel || null,
            personality: p.botMemory?.personality
              ? { ...p.botMemory.personality }
              : null,
            credits: Math.round(p.credits),
            creditsEarned: Math.round(p.stats?.creditsEarned || 0),
            creditsHarvested: Math.round(p.stats?.creditsHarvested || 0),
            income: +Number(p.income || 0).toFixed(2),
            unitCount: units.length,
            harvesters,
            hvStates,
            claimedRemaining: Math.round(claimedRemaining),
            combat,
            engineers: byTypeU.engineer || 0,
            cargo,
            queues,
            buildings: byTypeB,
            units: byTypeU,
            discovered: disc.length,
            discoveredIds: [...disc],
            fieldsClaimed,
            fieldsAlive,
            enemyHqKnown,
            enemyHqAlive,
            knownEnemyHqIds,
            scoutBikes: byTypeU.scoutBike || 0,
            power: { produce: pow.produce, consume: pow.consume, surplus: pow.surplus },
            buildingAsset,
            unitAsset,
            stats: {
              unitsProduced: p.stats?.unitsProduced || 0,
              unitsLost: p.stats?.unitsLost || 0,
              kills: p.stats?.kills || 0,
              buildingsBuilt: p.stats?.buildingsBuilt || 0,
              buildingsLost: p.stats?.buildingsLost || 0,
            },
          };
        });

      return {
        t: +S.gameSession.elapsedTime.toFixed(2),
        gameOver: !!S.gameSession.gameOver,
        winner: S.gameSession.winner,
        fieldCount,
        players,
      };
    });

    samples.push(snap);
    process.stdout.write(
      `\r  run ${runIndex + 1}/${RUNS}  t=${Math.floor(snap.t)}s / ${MATCH_SEC}s   `
    );
    if (snap.gameOver) break;
  }
  process.stdout.write('\n');

  // Derive per-player milestones + spend series from samples
  const milestones = {};
  const series = {};
  for (const p of samples[0]?.players || []) {
    milestones[p.id] = {
      tDiscover1: null,
      tDiscover2: null,
      tDiscover3: null,
      tSolar: null,
      tRefinery: null,
      tBarracks: null,
      tFactory: null,
      tSecondRefinery: null,
      tEnemyHq1: null,
      tEnemyHq2: null,
      tEnemyHqAll: null,
      tFieldsClaimed2: null,
      tFieldsClaimed3: null,
      tFirstCombat5: null,
      tCredits1k: null,
      tCredits2k: null,
      tHarvest1k: null,
      tHarvest2k: null,
      tHarvest4k: null,
    };
    series[p.id] = [];
  }

  let prevById = {};
  for (const snap of samples) {
    for (const p of snap.players) {
      const m = milestones[p.id];
      if (!m) continue;
      if (m.tDiscover1 == null && p.discovered >= 1) m.tDiscover1 = snap.t;
      if (m.tDiscover2 == null && p.discovered >= 2) m.tDiscover2 = snap.t;
      if (m.tDiscover3 == null && p.discovered >= 3) m.tDiscover3 = snap.t;
      if (m.tSolar == null && (p.buildings.solarPanel || 0) >= 1) m.tSolar = snap.t;
      if (m.tRefinery == null && (p.buildings.refinery || 0) >= 1) m.tRefinery = snap.t;
      if (m.tBarracks == null && (p.buildings.barracks || 0) >= 1) m.tBarracks = snap.t;
      if (m.tFactory == null && (p.buildings.warFactory || 0) >= 1) m.tFactory = snap.t;
      if (m.tSecondRefinery == null && (p.buildings.refinery || 0) >= 2) m.tSecondRefinery = snap.t;
      if (m.tEnemyHq1 == null && (p.enemyHqKnown || 0) >= 1) m.tEnemyHq1 = snap.t;
      if (m.tEnemyHq2 == null && (p.enemyHqKnown || 0) >= 2) m.tEnemyHq2 = snap.t;
      if (
        m.tEnemyHqAll == null
        && (p.enemyHqAlive || 0) > 0
        && (p.enemyHqKnown || 0) >= (p.enemyHqAlive || 0)
      ) {
        m.tEnemyHqAll = snap.t;
      }
      if (m.tFieldsClaimed2 == null && (p.fieldsClaimed || 0) >= 2) m.tFieldsClaimed2 = snap.t;
      if (m.tFieldsClaimed3 == null && (p.fieldsClaimed || 0) >= 3) m.tFieldsClaimed3 = snap.t;
      if (m.tFirstCombat5 == null && p.combat >= 5) m.tFirstCombat5 = snap.t;
      if (m.tCredits1k == null && p.creditsEarned >= 1000) m.tCredits1k = snap.t;
      if (m.tCredits2k == null && p.creditsEarned >= 2000) m.tCredits2k = snap.t;
      if (m.tHarvest1k == null && (p.creditsHarvested || 0) >= 1000) m.tHarvest1k = snap.t;
      if (m.tHarvest2k == null && (p.creditsHarvested || 0) >= 2000) m.tHarvest2k = snap.t;
      if (m.tHarvest4k == null && (p.creditsHarvested || 0) >= 4000) m.tHarvest4k = snap.t;

      const prev = prevById[p.id];
      let spentDelta = 0;
      let earnedDelta = 0;
      if (prev) {
        earnedDelta = Math.max(0, p.creditsEarned - prev.creditsEarned);
        spentDelta = Math.max(0, prev.credits + earnedDelta - p.credits);
      }
      series[p.id].push({
        t: snap.t,
        credits: p.credits,
        creditsEarned: p.creditsEarned,
        creditsHarvested: p.creditsHarvested || 0,
        earnedDelta: Math.round(earnedDelta),
        spentDelta: Math.round(spentDelta),
        harvesters: p.harvesters,
        combat: p.combat,
        unitCount: p.unitCount,
        discovered: p.discovered,
        fieldsClaimed: p.fieldsClaimed || 0,
        fieldsAlive: p.fieldsAlive || 0,
        enemyHqKnown: p.enemyHqKnown || 0,
        enemyHqAlive: p.enemyHqAlive || 0,
        scoutBikes: p.scoutBikes || 0,
        kills: p.stats?.kills || 0,
        strategyId: p.strategyId || null,
        queues: p.queues,
        surplus: p.power.surplus,
        solar: p.buildings.solarPanel || 0,
        refinery: p.buildings.refinery || 0,
        barracks: p.buildings.barracks || 0,
        factory: p.buildings.warFactory || 0,
        buildingAsset: p.buildingAsset,
        unitAsset: p.unitAsset,
      });
      prevById[p.id] = p;
    }
  }

  // Bottleneck flags per player (end-of-match heuristics)
  const bottlenecks = {};
  for (const pid of Object.keys(milestones)) {
    const id = Number(pid);
    const m = milestones[id];
    const last = series[id]?.[series[id].length - 1];
    const flags = [];
    if (m.tSolar == null) flags.push('never_solar');
    if (m.tRefinery == null) flags.push('never_refinery');
    if (m.tBarracks == null) flags.push('never_barracks');
    if (m.tFactory == null) flags.push('never_factory');
    if (m.tDiscover2 == null) flags.push('no_2nd_field');
    if (m.tDiscover3 == null) flags.push('no_3rd_field');
    if (m.tSecondRefinery == null) flags.push('no_expand_refinery');
    if (m.tEnemyHq1 == null) flags.push('no_enemy_hq');
    if (m.tEnemyHqAll == null) flags.push('incomplete_enemy_hq');
    if (last && (last.fieldsClaimed || 0) < 2) flags.push('low_field_claim');
    if (last && last.harvesters <= 1 && last.creditsEarned < 1500) flags.push('starved_harvesters');
    if (last && last.surplus < 0) flags.push('low_power_end');
    if (last && last.credits < 250 && last.queues === 0 && last.combat >= 8) {
      flags.push('broke_army_heavy');
    }
    // Long idle cash: many samples with high credits and zero spend
    let idleRich = 0;
    for (const row of series[id] || []) {
      if (row.credits >= 600 && row.spentDelta === 0 && row.queues === 0) idleRich++;
    }
    if (idleRich >= 8) flags.push('idle_rich_streak');
    bottlenecks[id] = flags;
  }

  return {
    run: runIndex,
    matchSec: MATCH_SEC,
    endedAt: samples[samples.length - 1]?.t ?? 0,
    gameOver: !!samples[samples.length - 1]?.gameOver,
    winner: samples[samples.length - 1]?.winner ?? null,
    winnerStrategy: (() => {
      const last = samples[samples.length - 1];
      if (!last) return null;
      const w = last.winner;
      if (w != null && w >= 0) {
        const p = (last.players || []).find((x) => x.team === w);
        if (p?.strategyId) return p.strategyId;
      }
      // Time expired without elimination — scoreboard: economy + army + claims + kills.
      const ranked = [...(last.players || [])].sort((a, b) => {
        const score = (p) =>
          (p.stats?.kills || 0) * 800
          + (p.fieldsClaimed || 0) * 600
          + (p.creditsEarned || 0)
          + (p.combat || 0) * 40
          + (p.buildingAsset || 0) * 0.25;
        return score(b) - score(a);
      });
      return ranked[0]?.strategyId || null;
    })(),
    scoreboard: (() => {
      const last = samples[samples.length - 1];
      if (!last?.players) return [];
      return [...last.players]
        .map((p) => ({
          id: p.id,
          strategyId: p.strategyId,
          strategyLabel: p.strategyLabel,
          score:
            (p.stats?.kills || 0) * 800
            + (p.fieldsClaimed || 0) * 600
            + (p.creditsEarned || 0)
            + (p.combat || 0) * 40
            + (p.buildingAsset || 0) * 0.25,
          earned: p.creditsEarned,
          claimed: p.fieldsClaimed,
          combat: p.combat,
          kills: p.stats?.kills || 0,
        }))
        .sort((a, b) => b.score - a.score);
    })(),
    fieldCount: samples[0]?.fieldCount ?? 0,
    milestones,
    bottlenecks,
    series,
    final: samples[samples.length - 1]?.players ?? [],
    sampleCount: samples.length,
  };
}

function median(arr) {
  const a = arr.filter((x) => x != null && Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function summarize(runs) {
  const keys = [
    'tDiscover1',
    'tDiscover2',
    'tDiscover3',
    'tSolar',
    'tRefinery',
    'tBarracks',
    'tFactory',
    'tSecondRefinery',
    'tEnemyHq1',
    'tEnemyHq2',
    'tEnemyHqAll',
    'tFieldsClaimed2',
    'tFieldsClaimed3',
    'tFirstCombat5',
    'tCredits1k',
    'tCredits2k',
    'tHarvest1k',
    'tHarvest2k',
    'tHarvest4k',
  ];
  const byKey = {};
  for (const k of keys) {
    const vals = [];
    let hit = 0;
    let total = 0;
    for (const run of runs) {
      for (const pid of Object.keys(run.milestones)) {
        total++;
        const v = run.milestones[pid][k];
        if (v != null) {
          hit++;
          vals.push(v);
        }
      }
    }
    byKey[k] = {
      n: hit,
      rate: total ? hit / total : 0,
      medianSec: median(vals),
      meanSec: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      minSec: vals.length ? Math.min(...vals) : null,
      maxSec: vals.length ? Math.max(...vals) : null,
    };
  }

  const flagCounts = {};
  for (const run of runs) {
    for (const pid of Object.keys(run.bottlenecks)) {
      for (const f of run.bottlenecks[pid]) {
        flagCounts[f] = (flagCounts[f] || 0) + 1;
      }
    }
  }

  // Aggregate mean series across all bot-seats (align by sample index / t bucket)
  const earnedByT = new Map();
  const harvestByT = new Map();
  const spentByT = new Map();
  const discByT = new Map();
  const hvByT = new Map();
  const claimedByT = new Map();
  const combatByT = new Map();
  for (const run of runs) {
    for (const pid of Object.keys(run.series)) {
      for (const row of run.series[pid]) {
        const t = Math.round(row.t / 15) * 15;
        const push = (map, v) => {
          if (!map.has(t)) map.set(t, []);
          map.get(t).push(v);
        };
        push(earnedByT, row.creditsEarned);
        push(harvestByT, row.creditsHarvested || 0);
        push(spentByT, row.buildingAsset + row.unitAsset);
        push(discByT, row.discovered);
        push(hvByT, row.harvesters);
        push(claimedByT, row.fieldsClaimed || 0);
        push(combatByT, row.combat || 0);
      }
    }
  }
  const avg = (map, t) => {
    const a = map.get(t) || [];
    return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  };
  const meanSeries = [...earnedByT.keys()]
    .sort((a, b) => a - b)
    .map((t) => ({
      t,
      meanCreditsEarned: +avg(earnedByT, t).toFixed(1),
      meanCreditsHarvested: +avg(harvestByT, t).toFixed(1),
      meanAssetValue: +avg(spentByT, t).toFixed(1),
      meanDiscovered: +avg(discByT, t).toFixed(2),
      meanHarvesters: +avg(hvByT, t).toFixed(2),
      meanFieldsClaimed: +avg(claimedByT, t).toFixed(2),
      meanCombat: +avg(combatByT, t).toFixed(2),
    }));

  // Per-strategy end stats + progression (15s buckets)
  const byStrategy = {};
  const strategySeriesMaps = {};
  for (const run of runs) {
    for (const p of run.final || []) {
      const sid = p.strategyId || 'unknown';
      if (!byStrategy[sid]) {
        byStrategy[sid] = {
          label: p.strategyLabel || sid,
          seats: 0,
          wins: 0,
          sumEarned: 0,
          sumHarvested: 0,
          sumKills: 0,
          sumClaimed: 0,
          sumCombat: 0,
          sumHv: 0,
        };
      }
      const s = byStrategy[sid];
      s.seats++;
      s.sumEarned += p.creditsEarned || 0;
      s.sumHarvested += p.creditsHarvested || 0;
      s.sumKills += p.stats?.kills || 0;
      s.sumClaimed += p.fieldsClaimed || 0;
      s.sumCombat += p.combat || 0;
      s.sumHv += p.harvesters || 0;
    }
    if (run.winnerStrategy && byStrategy[run.winnerStrategy]) {
      byStrategy[run.winnerStrategy].wins++;
    }
    for (const pid of Object.keys(run.series)) {
      const rows = run.series[pid];
      const sid = rows[0]?.strategyId || run.final?.find((x) => String(x.id) === String(pid))?.strategyId || 'unknown';
      if (!strategySeriesMaps[sid]) {
        strategySeriesMaps[sid] = {
          earned: new Map(),
          harvested: new Map(),
          claimed: new Map(),
          combat: new Map(),
          hv: new Map(),
        };
      }
      const maps = strategySeriesMaps[sid];
      for (const row of rows) {
        const t = Math.round(row.t / 15) * 15;
        const push = (map, v) => {
          if (!map.has(t)) map.set(t, []);
          map.get(t).push(v);
        };
        push(maps.earned, row.creditsEarned);
        push(maps.harvested, row.creditsHarvested || 0);
        push(maps.claimed, row.fieldsClaimed || 0);
        push(maps.combat, row.combat || 0);
        push(maps.hv, row.harvesters || 0);
      }
    }
  }

  const strategyStats = Object.entries(byStrategy).map(([id, s]) => ({
    id,
    label: s.label,
    seats: s.seats,
    wins: s.wins,
    winRate: s.seats ? s.wins / Math.max(1, runs.length) : 0,
    meanEarned: s.seats ? +(s.sumEarned / s.seats).toFixed(0) : 0,
    meanHarvested: s.seats ? +(s.sumHarvested / s.seats).toFixed(0) : 0,
    meanKills: s.seats ? +(s.sumKills / s.seats).toFixed(2) : 0,
    meanFieldsClaimed: s.seats ? +(s.sumClaimed / s.seats).toFixed(2) : 0,
    meanCombatEnd: s.seats ? +(s.sumCombat / s.seats).toFixed(1) : 0,
    meanHarvestersEnd: s.seats ? +(s.sumHv / s.seats).toFixed(1) : 0,
  }));
  strategyStats.sort((a, b) => b.wins - a.wins || b.meanHarvested - a.meanHarvested);

  const strategySeries = {};
  for (const [sid, maps] of Object.entries(strategySeriesMaps)) {
    const times = new Set([
      ...maps.earned.keys(),
      ...(maps.harvested?.keys?.() || []),
      ...maps.claimed.keys(),
      ...maps.combat.keys(),
      ...maps.hv.keys(),
    ]);
    strategySeries[sid] = [...times]
      .sort((a, b) => a - b)
      .map((t) => ({
        t,
        earned: +avg(maps.earned, t).toFixed(0),
        harvested: +avg(maps.harvested, t).toFixed(0),
        claimed: +avg(maps.claimed, t).toFixed(2),
        combat: +avg(maps.combat, t).toFixed(2),
        hv: +avg(maps.hv, t).toFixed(2),
      }));
  }

  return {
    milestones: byKey,
    bottleneckFlags: flagCounts,
    meanSeries,
    strategyStats,
    strategySeries,
  };
}

fs.mkdirSync(OUT, { recursive: true });
const server = await startServer();
console.log(`FFA bot bench  RUNS=${RUNS} MATCH_SEC=${MATCH_SEC} SAMPLE_SEC=${SAMPLE_SEC}`);
console.log(`http://127.0.0.1:${PORT}/  → ${OUT}`);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !HEADED,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--mute-audio'],
});

const runs = [];
const t0 = Date.now();
try {
  for (let i = 0; i < RUNS; i++) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.warn('  pageerror', e.message));
    try {
      const result = await runOneMatch(page, i);
      runs.push(result);
      const flags = Object.values(result.bottlenecks).flat();
      console.log(
        `  done run ${i + 1}: ended@${Math.floor(result.endedAt)}s  flags=${[...new Set(flags)].join(',') || 'none'}`
      );
    } catch (err) {
      console.error(`  RUN ${i + 1} FAILED`, err?.message || err);
      runs.push({ run: i, error: String(err?.message || err) });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

const okRuns = runs.filter((r) => !r.error);
const summary = summarize(okRuns);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const pack = {
  when: new Date().toISOString(),
  harness: 'RTSVR6/scripts/bench-ffa-bots.mjs',
  wallSec: +((Date.now() - t0) / 1000).toFixed(1),
  config: { RUNS, MATCH_SEC, SAMPLE_SEC, PORT },
  summary,
  runs,
};
const outPath = path.join(OUT, `ffa-bots-${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify(pack, null, 2));
fs.writeFileSync(path.join(OUT, 'ffa-bots-latest.json'), JSON.stringify(pack, null, 2));

console.log('\n========== FFA BOT SUMMARY ==========');
console.log(`runs ok ${okRuns.length}/${RUNS}  wall ${pack.wallSec}s  wrote ${outPath}`);
for (const [k, v] of Object.entries(summary.milestones)) {
  const med = v.medianSec != null ? `${v.medianSec.toFixed(0)}s` : '—';
  console.log(
    `  ${k.padEnd(18)} rate=${(v.rate * 100).toFixed(0).padStart(3)}%  median=${med.padStart(5)}  n=${v.n}`
  );
}
console.log('bottleneck flags (bot-seats across runs):');
const flagsSorted = Object.entries(summary.bottleneckFlags).sort((a, b) => b[1] - a[1]);
for (const [f, n] of flagsSorted) {
  console.log(`  ${f}: ${n}`);
}
console.log('strategy leaderboard:');
for (const s of summary.strategyStats || []) {
  console.log(
    `  ${s.label.padEnd(14)} wins=${s.wins}  harvest=$${s.meanHarvested}  earned=$${s.meanEarned}  claimed=${s.meanFieldsClaimed}  combatEnd=${s.meanCombatEnd}`
  );
}
console.log('=====================================');
