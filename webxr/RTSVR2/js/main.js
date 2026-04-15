// ========================================
// RTSVR2 — Main Entry Point
// Initialization and game setup
// ========================================

import * as State from './state.js';
import * as Pathfinding from './pathfinding.js';
import * as Renderer from './renderer.js';
import * as Effects from './effects.js';
import * as Fog from './fog.js';
import * as Input from './input.js';
import * as UI from './ui.js';
import * as Audio from './audio.js';
import * as Network from './network.js';
import * as Units from './units.js';
import * as Buildings from './buildings.js';
import * as Loop from './loop.js';
import { SPAWN_POSITIONS } from './config.js';

// --- Wait for A-Frame scene to load ---
document.addEventListener('DOMContentLoaded', () => {
  const scene = document.querySelector('a-scene');
  if (!scene) {
    console.error('No a-scene found');
    return;
  }

  if (scene.hasLoaded) {
    initializeGame(scene);
  } else {
    scene.addEventListener('loaded', () => initializeGame(scene));
  }
});

function initializeGame(sceneEl) {
  console.log('🎮 RTSVR2 Initializing...');

  Audio.initAudio();
  UI.initUI();
  State.initPlayers([0], [1, 2, 3]);
  State.initResourceFields();
  Fog.initFog();

  setTimeout(() => {
    Renderer.initRenderer(sceneEl);
    Effects.initEffects(sceneEl);
    Pathfinding.initPathfinding();
    Input.initInput(sceneEl);
    Network.initNetwork();

    UI.setCallbacks(onStartGame, onHostGame, onJoinGame);
    Loop.startLoop(sceneEl);

    console.log('✅ RTSVR2 Ready');
  }, 500);
}

// --- Start game with selected mode ---
function onStartGame(mode) {
  console.log(`🎮 Starting game in ${mode} mode`);

  State.resetState();
  State.initResourceFields();

  // Determine which players are active in this mode
  let humanIds, botIds, activeIds, teamAssign;
  const mpHost = State.gameSession.isMultiplayer && State.gameSession.isHost;
  const remoteHumans = mpHost ? Network.getConnectedRemotePlayerIds() : [];

  switch (mode) {
    case '1v1':
      humanIds = [0];
      botIds = [1];
      activeIds = [0, 1];
      teamAssign = { 0: 0, 1: 1 };
      // Online human vs human (BattleVR-style): second seat is human, not AI.
      if (mpHost && remoteHumans.includes(1)) {
        humanIds = [0, 1];
        botIds = [];
      }
      break;

    case '2v2':
      // Co-op vs bots: team 0 = P0+P1 (two humans when client is in slot 1), team 1 = bot P2+P3.
      humanIds = [0];
      botIds = [1, 2, 3];
      activeIds = [0, 1, 2, 3];
      teamAssign = { 0: 0, 1: 0, 2: 1, 3: 1 };
      if (mpHost && remoteHumans.includes(1)) {
        humanIds = [0, 1];
        botIds = [2, 3];
      }
      break;

    case 'ffa':
      humanIds = [0];
      botIds = [1, 2, 3];
      activeIds = [0, 1, 2, 3];
      teamAssign = { 0: 0, 1: 1, 2: 2, 3: 3 };
      if (mpHost && remoteHumans.length > 0) {
        humanIds = [0, ...remoteHumans];
        botIds = [0, 1, 2, 3].filter(id => !humanIds.includes(id));
      }
      break;

    default:
      humanIds = [0];
      botIds = [1, 2, 3];
      activeIds = [0, 1, 2, 3];
      teamAssign = { 0: 0, 1: 0, 2: 1, 3: 1 };
  }

  State.initPlayers(humanIds, botIds);

  // Override teams
  State.players.forEach(p => {
    if (teamAssign[p.id] !== undefined) {
      p.team = teamAssign[p.id];
    }
  });

  // For 1v1: give the bot the opposite corner spawn
  if (mode === '1v1') {
    State.players[0].spawn = SPAWN_POSITIONS[0]; // Top-left
    State.players[1].spawn = SPAWN_POSITIONS[2]; // Bottom-right
  }

  // Mark inactive players as defeated
  State.players.forEach(p => {
    if (!activeIds.includes(p.id)) {
      p.isDefeated = true;
      p.isBot = false;
      p.isHuman = false;
      p.isActive = false;
    }
  });

  Fog.initFog();
  Pathfinding.initPathfinding();

  // Place HQs and starting units for active players
  State.players.forEach(player => {
    if (player.isDefeated || !player.isActive) return;
    const hq = Buildings.placeHQ(player.id);

    if (hq) {
      // Spawn units toward center of map (away from corner)
      const dirX = -Math.sign(player.spawn.x);
      const dirZ = -Math.sign(player.spawn.z);

      // 3 Riflemen in formation
      for (let i = 0; i < 3; i++) {
        const lateral = (i - 1) * 3;
        const ux = hq.x + dirX * 8 + dirZ * lateral;
        const uz = hq.z + dirZ * 8 - dirX * lateral;
        Units.createUnit('rifleman', player.id, ux, uz);
      }

      // 1 Engineer nearby
      Units.createUnit('engineer', player.id, hq.x + dirX * 5, hq.z + dirZ * 5);

      // 1 Harvester
      Units.createUnit('harvester', player.id, hq.x + dirX * 3, hq.z + dirZ * 3);
    }
  });

  Pathfinding.rebuildNavMesh();

  // Start
  State.gameSession.gameStarted = true;
  State.gameSession.menuOpen = false;
  State.gameSession.gameOver = false;
  State.gameSession.elapsedTime = 0;
  State.gameSession.myPlayerId = 0;
  State.gameSession.buildMode = null;

  UI.updateMenuVisibility();
  const startHint =
    Input.getIsVR()
      ? 'Game started! Point laser at your HQ and use the trigger to open the build menu.'
      : Input.getInputPlatform() === 'touch'
        ? 'Game started! Tap your HQ to build. Two-finger drag pans the map; pinch zooms.'
        : 'Game started! Click your HQ to open the build menu. (VR: left trigger)';
  UI.showStatus(startHint);

  Input.positionCameraForPlayer(State.gameSession.myPlayerId);

  if (State.gameSession.isMultiplayer && State.gameSession.isHost) {
    Network.broadcastData({ type: 'game-start' });
  }

  console.log(`✅ Game started (${mode}): ${State.units.size} units, ${State.buildings.size} buildings, ${State.resourceFields.size} resource fields`);
}

function onHostGame() {
  Network.startHosting();
}

function onJoinGame() {
  Network.joinGame();
}
