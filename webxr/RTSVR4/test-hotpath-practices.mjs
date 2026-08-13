#!/usr/bin/env node
/**
 * Regression tests for FoW O(1) visibility, combat acquire budget, bot APM math.
 * Run: node RTSVR4/test-hotpath-practices.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Config from './js/config.js';
import * as State from './js/state.js';
import * as Fog from './js/fog.js';
import {
  BOT_TARGET_APM,
  BOT_TICK_RATE,
  COMBAT_ACQUIRE_PER_FRAME,
  MINIMAP_REDRAW_HZ,
  FOG_OVERLAY_REDRAW_HZ,
  PATHFIND_SIM_PER_TICK,
  PATHFIND_PLAYER_PER_TICK,
  UNIT_CLEARANCE_MIN,
} from './js/config.js';
import * as Pathfinding from './js/pathfinding.js';

function section(name) {
  console.log(`\n--- ${name} ---`);
}

section('config budgets');
assert.ok(BOT_TARGET_APM === 150, 'BOT_TARGET_APM should be 150');
assert.ok(BOT_TICK_RATE > 0);
assert.ok(COMBAT_ACQUIRE_PER_FRAME >= 8 && COMBAT_ACQUIRE_PER_FRAME <= 64);
assert.ok(MINIMAP_REDRAW_HZ >= 4 && MINIMAP_REDRAW_HZ <= 30);
assert.ok(FOG_OVERLAY_REDRAW_HZ >= 4 && FOG_OVERLAY_REDRAW_HZ <= 30);
assert.ok(PATHFIND_SIM_PER_TICK >= 4 && PATHFIND_SIM_PER_TICK <= 32);
assert.ok(PATHFIND_PLAYER_PER_TICK >= PATHFIND_SIM_PER_TICK);
assert.ok(UNIT_CLEARANCE_MIN > 1);
const ordersPerTick = BOT_TARGET_APM / 60 / BOT_TICK_RATE;
assert.ok(ordersPerTick > 0 && ordersPerTick <= 2, `orders/tick=${ordersPerTick}`);
console.log(`APM ${BOT_TARGET_APM} → ~${ordersPerTick.toFixed(3)} orders/bot-tick`);

section('fog O(1) visibility');
Config.applyMapProfile('standard');
State.initPlayers([0], [1]);
State.units.clear();
State.buildings.clear();
Fog.initFog();

const team0 = State.players[0].team;
const ally = {
  id: 'u_ally',
  team: team0,
  ownerId: 0,
  hp: 100,
  x: 0,
  z: 0,
  visionRange: 20,
  range: 12,
};
State.units.set(ally.id, ally);

Fog.updateFog();
assert.equal(Fog.isVisibleToTeam(team0, 0, 0), true, 'ally cell visible');
assert.equal(Fog.isVisibleToTeam(team0, 5, 0), true, 'near ally visible');
assert.equal(Fog.isVisibleToTeam(team0, 80, 80), false, 'far cell not visible');

// Previously-seen stays explored but not live-visible after fog rolls
ally.x = 100;
ally.z = 100;
Fog.updateFog();
assert.equal(Fog.isVisibleToTeam(team0, 0, 0), false, 'old cell no longer live-visible');
assert.equal(Fog.wasExploredByTeam(team0, 0, 0), true, 'old cell still explored');

section('isVisibleToTeam throughput');
Fog.updateFog();
ally.x = 0;
ally.z = 0;
Fog.updateFog();
const N = 200000;
const t0 = performance.now();
let hits = 0;
for (let i = 0; i < N; i++) {
  if (Fog.isVisibleToTeam(team0, (i % 40) - 20, ((i * 3) % 40) - 20)) hits++;
}
const ms = performance.now() - t0;
const perCallUs = (ms * 1000) / N;
console.log(`${N} lookups in ${ms.toFixed(1)}ms (${perCallUs.toFixed(3)} µs/call, hits=${hits})`);
assert.ok(perCallUs < 2, `O(1) fog lookup too slow: ${perCallUs} µs`);

section('nextPaint cannot hang on window rAF in XR');
{
  const uiSrc = fs.readFileSync(new URL('./js/ui.js', import.meta.url), 'utf8');
  assert.match(uiSrc, /function xrPresentingSession/, 'nextPaint must detect the active XR session');
  assert.match(uiSrc, /session\.requestAnimationFrame/, 'nextPaint must use XRSession rAF while presenting');
  assert.match(uiSrc, /setTimeout\(done, 64\)/, 'nextPaint must fail-open if rAF is silent');
  assert.match(uiSrc, /vr-match-prepare/, 'VR rematch must have a headset prepare panel');
}

section('game-over keeps world fog overlay');
State.gameSession.gameStarted = true;
State.gameSession.gameOver = true;
assert.equal(
  Fog.shouldDrawWorldFogOverlay(),
  true,
  'game-over must keep shroud (Quest GPU: do not reveal the whole PBR moon)'
);
State.gameSession.gameOver = false;
assert.equal(Fog.shouldDrawWorldFogOverlay(), true, 'live match still draws overlay');
State.gameSession.gameStarted = false;
assert.equal(Fog.shouldDrawWorldFogOverlay(), false, 'menu has no overlay');

section('bot APM accumulator');
let budget = 0;
const perTick = BOT_TARGET_APM / 60 / BOT_TICK_RATE;
const cap = BOT_TARGET_APM / 60;
let spent = 0;
for (let tick = 0; tick < BOT_TICK_RATE * 60; tick++) {
  budget = Math.min(cap, budget + perTick);
  // Spend at most 1 order/tick when available (human-like)
  if (budget >= 1) {
    budget -= 1;
    spent++;
  }
}
console.log(`Simulated 60s @ ${BOT_TICK_RATE} Hz → ${spent} orders (target ~${BOT_TARGET_APM})`);
assert.ok(spent >= BOT_TARGET_APM - 5 && spent <= BOT_TARGET_APM + 5, `APM drift: ${spent}`);

section('pathfind slot budget');
Pathfinding.resetPathfindBudgetForTick();
let simTaken = 0;
while (Pathfinding.canTakePathfindSlot(false)) {
  Pathfinding.notePathfindSlot(false);
  simTaken++;
  if (simTaken > 100) break;
}
assert.equal(simTaken, PATHFIND_SIM_PER_TICK, `sim slots=${simTaken}`);
assert.equal(Pathfinding.canTakePathfindSlot(false), false);
assert.equal(Pathfinding.canTakePathfindSlot(true), true);

section('baked moon wiring (skirmish Lightmass path)');
const moonSrc = fs.readFileSync(new URL('./js/moon-environment.js', import.meta.url), 'utf8');
const bakedSrc = fs.readFileSync(new URL('./js/baked-moon.js', import.meta.url), 'utf8');
const idxHtml = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const bakedGlb = new URL('./assets/terrain/terrain-skirmish-ue-lm.glb', import.meta.url);
assert.match(moonSrc, /tryLoadBakedSkirmishMoon/);
assert.match(bakedSrc, /MeshLambertMaterial/);
assert.match(bakedSrc, /cheapMoonLook/);
assert.match(bakedSrc, /livepbr/);
assert.match(bakedSrc, /receiveShadow = false/);
assert.match(bakedSrc, /rotation\.x = Math\.PI \/ 2/);
assert.match(bakedSrc, /rewriteAlbedoUvsFromWorldXz/);
assert.doesNotMatch(bakedSrc, /applyEpicLightmaps/);
assert.match(bakedSrc, /assets\/terrain\/terrain-skirmish-ue-lm\.glb/);
assert.match(idxHtml, /three\/addons\//);
assert.ok(fs.existsSync(bakedGlb), 'baked skirmish GLB missing');
assert.ok(fs.statSync(bakedGlb).size > 800000, 'baked GLB too small (junk/template export)');

console.log('\n✅ test-hotpath-practices passed');
