// ========================================
// RTSVR2 — Game Loop
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
import { unitGrid, buildingGrid } from './spatial.js';

const FIXED_DT = 1 / 60;  // 60Hz logic timestep
const MAX_DT = 0.1;        // Cap to prevent spiral of death
let accumulator = 0;
let lastTime = 0;
let running = false;

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
      if (rawDt <= 0) rawDt = FIXED_DT;

      engineStep(timestamp, rawDt);
    },
  });
}

function engineStep(timestamp, rawDt) {
  Input.updateInput(rawDt);

  if (!State.gameSession.gameStarted || State.gameSession.gameOver) {
    Renderer.updateRendering();
    UI.updateUI();
    return;
  }

  accumulator += rawDt;

  while (accumulator >= FIXED_DT) {
    gameUpdate(FIXED_DT, timestamp);
    accumulator -= FIXED_DT;
  }

  Network.updateNetwork(timestamp);

  if (State.gameSession.gameStarted && !State.gameSession.gameOver) {
    Fog.updateFog();
  }

  Renderer.updateRendering();
  Effects.updateEffects(rawDt);
  UI.updateUI();
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

  engineStep(timestamp, rawDt);
}

export function stopLoop() {
  running = false;
  const scene = document.querySelector('a-scene');
  if (scene && scene.hasAttribute && scene.hasAttribute(COMPONENT_NAME)) {
    scene.removeAttribute(COMPONENT_NAME);
  }
}

function gameUpdate(dt, time) {
  // Non-host clients mirror state via snapshots only (host runs simulation)
  if (State.gameSession.isMultiplayer && !State.gameSession.isHost) {
    return;
  }

  // 1. Update elapsed time
  State.gameSession.elapsedTime += dt;

  // 2. Rebuild spatial grids
  unitGrid.clear();
  buildingGrid.clear();
  State.units.forEach(u => {
    if (u.hp > 0) unitGrid.insert(u);
  });
  State.buildings.forEach(b => {
    if (b.hp > 0) buildingGrid.insert(b);
  });

  // 3. Bot AI (throttled internally)
  Bot.updateBotAI(time, dt);

  // 4. Building construction
  Buildings.updateConstruction(dt);

  // 5. Production queues
  Buildings.updateProduction(dt);

  // 6. Passive income
  Buildings.updateIncome(dt);

  // 7. Harvester logic
  Resources.updateHarvesters(dt);

  // 8. Unit movement
  Units.updateMovement(dt);

  // 9. Combat
  Units.updateCombat(time, dt);

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
