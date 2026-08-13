// ========================================
// RTSVR4 — Game Loop
// Central fixed-timestep update
// ========================================
// Runs on the A-Frame scene tick so logic keeps advancing during immersive WebXR
// (standalone rAF is often not driven the same way as the XR display loop).

import * as State from './state.js';
import * as Units from './units.js';
import * as Buildings from './buildings.js';
import * as Resources from './resources.js';
import * as Renderer from './renderer.js';
import * as Effects from './effects.js';
import * as Bot from './bot.js';
import * as Fog from './fog.js';
import * as Input from './input.js';
import * as UI from './ui.js';
import * as Network from './network.js';
import * as Pathfinding from './pathfinding.js';
import * as Audio from './audio.js';
import { unitGrid, buildingGrid } from './spatial.js';
import * as Perf from './perf-profiler.js';

export const FIXED_DT = 1 / 60;  // 60Hz logic timestep
const MAX_DT = 0.1;        // Cap to prevent spiral of death
let accumulator = 0;
let lastTime = 0;
let running = false;
/** Wall clock for host background catch-up (tab hidden / rAF throttled). */
let lastHostBgBurstWallMs = 0;

const COMPONENT_NAME = 'rts-engine-loop';

function registerEngineLoopComponentOnce() {
  if (typeof AFRAME === 'undefined' || AFRAME.components[COMPONENT_NAME]) return;

  AFRAME.registerComponent(COMPONENT_NAME, {
    init() {
      lastTime = performance.now();
    },
    tick(_t, dtMs) {
      if (!running) return;
      const timestamp = performance.now();
      let rawDt = typeof dtMs === 'number' && dtMs > 0 ? dtMs / 1000 : (timestamp - lastTime) / 1000;
      lastTime = timestamp;
      if (rawDt > 1.0) rawDt = 1.0;
      if (rawDt > MAX_DT) rawDt = MAX_DT;
      if (rawDt <= 0) rawDt = FIXED_DT;

      engineStep(timestamp, rawDt);
    },
    tock() {
      if (!running) return;
      const sceneEl = this.el && this.el.sceneEl;
      Perf.noteGpuFromRenderer(sceneEl && sceneEl.renderer);
    },
  });
}

function engineStep(timestamp, rawDt) {
  const frameT0 = performance.now();
  const abl = Perf.getAblation();

  if (abl.input) {
    Perf.time('input', () => Input.updateInput(rawDt));
  }

  if (!State.gameSession.gameStarted || State.gameSession.gameOver) {
    // Host must keep sending snapshots after gameOver; otherwise the early return
    // skips updateNetwork and clients never receive winner / gameOver.
    if (
      State.gameSession.isMultiplayer &&
      State.gameSession.isHost &&
      State.gameSession.gameStarted
    ) {
      if (abl.network) Perf.time('network', () => Network.updateNetwork(timestamp));
    }
    Effects.freezeEffects();
    if (abl.render) Renderer.updateRendering();
    if (abl.ui) UI.updateUI();
    Perf.endFrame(performance.now() - frameT0);
    return;
  }

  const mpHostHidden =
    State.gameSession.isMultiplayer &&
    State.gameSession.isHost &&
    typeof document !== 'undefined' &&
    document.hidden &&
    State.gameSession.gameStarted &&
    !State.gameSession.gameOver;

  if (mpHostHidden) {
    // Background tab: dedicated timer in network.js runs sim bursts; avoid stacking rAF dt here.
    accumulator = 0;
  } else {
    accumulator += rawDt;
    while (accumulator >= FIXED_DT) {
      gameUpdate(FIXED_DT, timestamp);
      accumulator -= FIXED_DT;
    }
  }

  if (abl.network) {
    Perf.time('network', () => Network.updateNetwork(timestamp));
  }

  if (
    State.gameSession.isMultiplayer &&
    !State.gameSession.isHost &&
    State.gameSession.gameStarted &&
    !State.gameSession.gameOver
  ) {
    Network.smoothNetClientUnitPositions(rawDt);
  }

  // FoW already baked in gameUpdate (sim). Clients that skip sim still need a paint:
  if (
    State.gameSession.isMultiplayer &&
    !State.gameSession.isHost &&
    State.gameSession.gameStarted &&
    !State.gameSession.gameOver &&
    abl.fog
  ) {
    Perf.time('fog', () => Fog.updateFog());
  }

  if (abl.render) {
    Renderer.updateRendering();
  }
  Audio.updateListenerFromCamera();
  if (abl.effects) {
    Perf.time('effects', () => Effects.updateEffects(rawDt));
  }
  if (abl.ui) {
    UI.updateUI();
  }

  Perf.endFrame(performance.now() - frameT0);
}

/** @param {HTMLElement | null} sceneEl a-scene */
export function startLoop(sceneEl) {
  running = true;
  lastTime = performance.now();
  accumulator = 0;

  registerEngineLoopComponentOnce();

  const scene = sceneEl || document.querySelector('a-scene');
  if (scene && scene.setAttribute && typeof AFRAME !== 'undefined' && AFRAME.components[COMPONENT_NAME]) {
    scene.setAttribute(COMPONENT_NAME, '');
    return;
  }

  // Fallback if A-Frame is unavailable (tests / odd embeds)
  requestAnimationFrame(legacyRafTick);
}

function legacyRafTick(timestamp) {
  if (!running) return;
  requestAnimationFrame(legacyRafTick);

  let rawDt = (timestamp - lastTime) / 1000;
  lastTime = timestamp;
  if (rawDt > 1.0) rawDt = 1.0;
  if (rawDt > MAX_DT) rawDt = MAX_DT;

  engineStep(timestamp, rawDt);
}

export function stopLoop() {
  running = false;
  const scene = document.querySelector('a-scene');
  if (scene && scene.hasAttribute && scene.hasAttribute(COMPONENT_NAME)) {
    scene.removeAttribute(COMPONENT_NAME);
  }
}

/** Host only: advance sim by wall-clock gap when the tab is hidden (rAF throttled). Called from network timer. */
export function runHostedSimBackgroundBurst() {
  if (!State.gameSession.isMultiplayer || !State.gameSession.isHost) return;
  if (typeof document === 'undefined' || !document.hidden) return;
  if (!State.gameSession.gameStarted || State.gameSession.gameOver) return;
  const now = performance.now();
  if (!lastHostBgBurstWallMs) lastHostBgBurstWallMs = now;
  const wallDt = Math.min(1.35, (now - lastHostBgBurstWallMs) / 1000);
  lastHostBgBurstWallMs = now;
  const steps = Math.min(120, Math.max(1, Math.floor(wallDt / FIXED_DT)));
  for (let i = 0; i < steps; i++) {
    gameUpdate(FIXED_DT, now);
  }
  Network.updateNetwork(now);
}

export function resetHostBackgroundBurstClock() {
  lastHostBgBurstWallMs = 0;
}

function gameUpdate(dt, time) {
  // Non-host clients mirror state via snapshots only (host runs simulation)
  if (State.gameSession.isMultiplayer && !State.gameSession.isHost) {
    return;
  }

  if (State.gameSession.isMultiplayer && State.gameSession.isHost && State.gameSession.mpSessionPaused) {
    return;
  }

  const abl = Perf.getAblation();

  // 1. Update elapsed time
  State.gameSession.elapsedTime += dt;

  // 2. Rebuild spatial grids, then bake FoW so O(1) visibility matches this tick
  if (abl.spatial) {
    Perf.time('spatial', () => {
      unitGrid.clear();
      buildingGrid.clear();
      State.units.forEach(u => {
        if (u.hp > 0) unitGrid.insert(u);
      });
      State.buildings.forEach(b => {
        if (b.hp > 0) buildingGrid.insert(b);
      });
    });
  }

  if (abl.fog) {
    Perf.time('fog', () => Fog.updateFog());
  }

  // 3. Bot AI (throttled internally)
  if (abl.bot) {
    Perf.time('bot', () => Bot.updateBotAI(time, dt));
  }

  // 4–6. Buildings
  if (abl.buildings) {
    Perf.time('buildings', () => {
      Buildings.updateConstruction(dt);
      Buildings.updateProduction(dt);
      Buildings.updateIncome(dt);
    });
  }

  // 7–8. Pathfinding budget: combat movers first, then harvesters (shared A* cap per tick).
  Units.syncSquadFollowersFromLeaders();
  Units.syncEngineerRepairApproach();
  Pathfinding.resetPathfindBudgetForTick();
  if (abl.movement) {
    Perf.time('movement', () => Units.updateMovement(dt));
  }
  if (abl.harvesters) {
    Perf.time('harvesters', () => Resources.updateHarvesters(dt));
  }

  // 9. Combat
  if (abl.combat) {
    Perf.time('combat', () => Units.updateCombat(time, dt));
  }

  // 9b. Engineer vehicle repair (host-authoritative; runs after movement + combat)
  Units.updateEngineerRepair(dt);

  // 10. Fog of war (per-frame update runs in tick() so clients see fog after snapshots)

  // 11. Check game time limit
  if (State.gameSession.elapsedTime >= State.gameSession.maxGameTime) {
    handleTimeLimit();
  }
}

function handleTimeLimit() {
  if (State.gameSession.gameOver) return;

  // Find team with most surviving HP
  const teamHP = {};
  State.units.forEach(u => {
    if (u.hp > 0) {
      teamHP[u.team] = (teamHP[u.team] || 0) + u.hp;
    }
  });
  State.buildings.forEach(b => {
    if (b.hp > 0) {
      const player = State.players[b.ownerId];
      if (player) {
        teamHP[player.team] = (teamHP[player.team] || 0) + b.hp;
      }
    }
  });

  let winnerTeam = -1;
  let maxHP = 0;
  for (const [team, hp] of Object.entries(teamHP)) {
    if (hp > maxHP) {
      maxHP = hp;
      winnerTeam = parseInt(team);
    }
  }

  State.gameSession.gameOver = true;
  State.gameSession.winner = winnerTeam;
  console.log(`⏰ Time limit! Winner: Team ${winnerTeam}`);
}
