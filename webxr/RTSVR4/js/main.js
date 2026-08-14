// ========================================
// RTSVR4 — Main Entry Point
// Initialization and game setup
// ========================================

import * as State from './state.js';
import * as Pathfinding from './pathfinding.js';
import * as Renderer from './renderer.js';
import * as NavDebug from './nav-debug-overlay.js';
import * as Effects from './effects.js';
import * as Fog from './fog.js';
import * as Input from './input.js';
import * as UI from './ui.js';
import * as Audio from './audio.js';
import * as Network from './network.js';
import * as Units from './units.js';
import * as Buildings from './buildings.js';
import * as Loop from './loop.js';
import {
  clampWorldToPlayableDisk,
  BARRACKS_UNITS,
  FACTORY_UNITS,
  getMatchStartSpawnForPlayer,
  applyMapProfile,
  MAP_PROFILE,
  MAP_UNIT_NAV_RADIUS,
} from './config.js';
import { applyMoonBattlefieldVisuals, rebuildMoonBattlefield, clearStoryBlockingHills } from './moon-environment.js';
import {
  generateStoryLayout,
  applyStoryLayoutToWorld,
  spawnStoryMatch,
} from './story-mode.js';
import { resolveStorySeed } from './story-history.js';
import { applyHdrSkyEnvironment } from './sky-hdr-environment.js';
import { primeSceneRevealBlack, runSceneRevealFromBlack } from './scene-reveal.js';
import * as Perf from './perf-profiler.js';

/** Units players can actually produce (barracks + war factory + refinery harvester). Excludes e.g. APC. */
const LOBBY_SHOWCASE_UNIT_TYPES = ['harvester', ...BARRACKS_UNITS, ...FACTORY_UNITS];

/**
 * Pre-match lobby: every non-HQ building type and every **buildable** unit type around the HQ
 * (lunar settlement preview). Cleared when `State.resetState()` runs at match start.
 */
function placeLobbyLunarSettlementShowcase(hqPos) {
  const ownerId = 0;
  const inwardD = Math.hypot(hqPos.x, hqPos.z) || 1;
  const ix = -hqPos.x / inwardD;
  const iz = -hqPos.z / inwardD;
  const rx = -iz;
  const rz = ix;

  const at = (forward, right) =>
    clampWorldToPlayableDisk(hqPos.x + ix * forward + rx * right, hqPos.z + iz * forward + rz * right, 10);

  const buildingPlan = [
    { type: 'barracks', forward: 6, right: 15 },
    { type: 'refinery', forward: 14, right: 0 },
    { type: 'warFactory', forward: 6, right: -15 },
  ];
  for (const b of buildingPlan) {
    const p = at(b.forward, b.right);
    Buildings.createBuilding(b.type, ownerId, p.x, p.z, { skipNavRebuild: true, spawnComplete: true });
  }

  const unitTypes = LOBBY_SHOWCASE_UNIT_TYPES;
  const n = unitTypes.length;
  const ringR = 26;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + 0.45;
    const ux = hqPos.x + Math.cos(ang) * ringR;
    const uz = hqPos.z + Math.sin(ang) * ringR;
    const c = clampWorldToPlayableDisk(ux, uz, 8);
    const u = Units.createUnit(unitTypes[i], ownerId, c.x, c.z, { skipCapCheck: true, skipProducedStat: true });
    if (u) {
      const dx = -c.x;
      const dz = -c.z;
      u.rotation = Math.atan2(dx, dz);
    }
  }
}

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
  console.log('🎮 RTSVR4 Initializing...');
  Perf.initPerfFromUrl();

  Input.applyImmersiveVrEntryToScene(sceneEl);

  Audio.initAudio();
  UI.initUI();
  window._toggleDynamicShadows = () => Renderer.toggleDynamicShadows();
  window._setDynamicShadowsEnabled = (on) => Renderer.setDynamicShadowsEnabled(on);
  window._getDynamicShadowsEnabled = () => Renderer.getDynamicShadowsEnabled();
  UI.syncDynamicShadowToggleUi();
  State.initPlayers([0], [1, 2, 3]);
  State.initResourceFields();
  Fog.initFog();

  setTimeout(async () => {
    State.gameSession.sceneContentReady = false;
    UI.setBootLoadingMessage('Loading sky & lighting…');
    primeSceneRevealBlack(sceneEl);
    if (Perf.shouldLoadCubemap()) {
      await applyHdrSkyEnvironment(sceneEl);
    } else {
      console.log('[perf] nocubemap: skipping HDR sky / env map');
    }
    UI.setBootLoadingMessage('Building terrain…');
    await applyMoonBattlefieldVisuals(sceneEl);
    primeSceneRevealBlack(sceneEl);

    UI.setBootLoadingMessage('Initializing renderer…');
    await Renderer.initRenderer(sceneEl);
    Effects.initEffects(sceneEl);
    Pathfinding.initPathfinding();

    if (typeof window !== 'undefined') {
      if (window.RTS_NAV_DEBUG === true) State.gameSession.navDebug = true;
      else {
        try {
          const sp = new URLSearchParams(window.location.search || '');
          if (sp.get('navDebug') === '1' || sp.get('navDebug') === 'true') State.gameSession.navDebug = true;
          if (sp.get('pathDebug') === '1' || sp.get('pathDebug') === 'true') window.RTS_PATH_DEBUG = true;
        } catch (_) {}
      }
      if (State.gameSession.navDebug) window.RTS_PATH_DEBUG = true;
    }
    NavDebug.initNavDebugOverlay(sceneEl);
    NavDebug.syncNavDebugOverlayFromState();

    Input.initInput(sceneEl);
    // Lobby / pre-match: one HQ ~50 m ahead of default camera yaw (VR rig forward = −sin(rotY), −cos(rotY) on XZ).
    const rig = Input.getCameraState();
    const lobbyAheadM = 50;
    const hx = -Math.sin(rig.rotY) * lobbyAheadM;
    const hz = -Math.cos(rig.rotY) * lobbyAheadM;
    const hqPos = clampWorldToPlayableDisk(hx, hz, 14);
    Buildings.createBuilding('hq', 0, hqPos.x, hqPos.z, {});
    placeLobbyLunarSettlementShowcase(hqPos);
    Input.beginLobbyIntroOrbitAroundHq(hqPos.x, hqPos.z);
    Pathfinding.rebuildNavMesh();
    Network.initNetwork();

    UI.setCallbacks(onStartGame, onHostGame, onJoinGame);
    Loop.startLoop(sceneEl);

    Renderer.warmRendererPrograms(sceneEl);
    UI.setBootLoadingMessage('Warming up GPU…');
    // GPU + scene graph settle (terrain maps, HQ GLB, first instancing tick) before lifting the black hold.
    await new Promise((r) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => requestAnimationFrame(r))
      )
    );

    UI.setBootLoadingMessage('Opening view…');
    await runSceneRevealFromBlack(sceneEl);

    State.gameSession.sceneContentReady = true;
    UI.updateMenuVisibility();
    UI.hideBootLoadingScreen();

    if (typeof window !== 'undefined') {
      window.__rtsReady = true;
    }
    console.log('✅ RTSVR4 Ready');
  }, 500);
}

async function prepareMapForMode(mode, sceneEl, prevProfile) {
  const wantStory = mode === 'story';
  const nextProfile = wantStory ? 'story' : 'standard';

  if (prevProfile !== nextProfile || wantStory) {
    UI.showStatus(wantStory ? 'Generating Story battlefield…' : 'Restoring skirmish map…');
    await rebuildMoonBattlefield(sceneEl);
    Renderer.configureBattlefieldShadows(sceneEl);
    Renderer.resizeWorldFogOverlay();
    Renderer.refreshPlayableBorderRing();
  } else {
    // Terrain unchanged but border Y may still need a refresh after cold start
    Renderer.refreshPlayableBorderRing();
  }

  const plane = document.getElementById('vr-minimap-plane');
  if (plane) {
    plane.setAttribute('rts-vr-minimap', `mapSize: ${Math.round(MAP_UNIT_NAV_RADIUS * 2)}`);
  }
}

// --- Start game with selected mode ---
async function onStartGame(mode) {
  /** Only the host may run a full local match bootstrap — clients mirror the host via `game-start` + snapshots. */
  if (State.gameSession.isMultiplayer && !State.gameSession.isHost) {
    console.warn('[RTSVR4] Ignoring startGame on multiplayer client (host starts the match).');
    UI.showStatus('Only the host can start a match from this device.');
    return;
  }

  // Story is a solo campaign scenario (not multiplayer lobby start).
  if (mode === 'story' && State.gameSession.isMultiplayer) {
    UI.showStatus('Story mode is solo — leave multiplayer lobby first.');
    return;
  }

  if (State.gameSession.matchPreparing) {
    UI.showStatus('Still preparing the battlefield — please wait…');
    return;
  }

  console.log(`🎮 Starting game in ${mode} mode`);

  const sceneEl = document.querySelector('a-scene');
  let storyLayout = null;
  const prevProfile = MAP_PROFILE;
  const wantStory = mode === 'story';
  const nextProfile = wantStory ? 'story' : 'standard';
  const needsRebuild = prevProfile !== nextProfile || wantStory;

  UI.setMatchPreparing(
    true,
    wantStory
      ? 'Generating Story map, hills, and bases… This can take a few seconds.'
      : needsRebuild
        ? 'Switching to skirmish map…'
        : 'Starting match…',
    wantStory ? 'Loading Story' : needsRebuild ? 'Switching map' : 'Starting match'
  );
  // Let the overlay paint before heavy sync work freezes the main thread.
  await UI.nextPaint();

  try {
    try {
      if (mode === 'story') {
        UI.setMatchPreparingMessage('Rolling Story layout (bases, hills, ore)…');
        await UI.nextPaint();
        applyMapProfile('story');
        const forcedSeed = resolveStorySeed();
        storyLayout =
          forcedSeed != null ? generateStoryLayout(forcedSeed) : generateStoryLayout();
        applyStoryLayoutToWorld(storyLayout);
        console.log(
          `[Story] seed=${storyLayout.seed} bases=${storyLayout.enemyBases.length} ` +
            `hills=${storyLayout.hills.length} ore=${storyLayout.resources.length} ` +
            `garrison=${(storyLayout.garrisonByBase || []).reduce((s, g) => s + g.length, 0)} ` +
            `mobile=${(storyLayout.mobileTypes || []).length}` +
            (forcedSeed != null ? ' (replay/forced)' : '')
        );
        UI.setMatchPreparingMessage(
          forcedSeed != null
            ? `Building terrain for seed ${storyLayout.seed}…`
            : 'Building terrain mesh…'
        );
        await UI.nextPaint();
      } else {
        clearStoryBlockingHills();
        applyMapProfile('standard');
        if (needsRebuild) {
        UI.setMatchPreparingMessage('Switching to skirmish map…');
          await UI.nextPaint();
        }
      }
      await prepareMapForMode(mode, sceneEl, prevProfile);
    } catch (err) {
      console.error('[RTSVR4] Map prepare failed', err);
      UI.showStatus('Failed to prepare battlefield.');
      applyMapProfile('standard');
      clearStoryBlockingHills();
      return;
    }

    UI.setMatchPreparingMessage('Spawning forces…');
    await UI.nextPaint();

  State.resetState();
  State.initResourceFields();
  Renderer.refreshResourceFieldMeshes();

  // Determine which players are active in this mode
  let humanIds, botIds, activeIds, teamAssign;
  const mpHost = State.gameSession.isMultiplayer && State.gameSession.isHost;
  const remoteHumans = mpHost ? Network.getConnectedRemotePlayerIds() : [];

  switch (mode) {
    case 'story':
      humanIds = [0];
      botIds = [1];
      activeIds = [0, 1];
      teamAssign = { 0: 0, 1: 1 };
      break;

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

  // Match start: HQs on the outer ring (outside the central crater bowl), same corner layout as legacy spawns.
  for (let i = 0; i < State.players.length; i++) {
    State.players[i].spawn = getMatchStartSpawnForPlayer(i);
  }

  // For 1v1: opposite corners across the hub (NE vs SE) — still `getMatchStartSpawnForPlayer` slots 0 and 2.
  if (mode === '1v1') {
    State.players[0].spawn = getMatchStartSpawnForPlayer(0);
    State.players[1].spawn = getMatchStartSpawnForPlayer(2);
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

  if (mode === 'story' && storyLayout) {
    spawnStoryMatch(storyLayout);
  } else {
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

    Pathfinding.rebuildNavMeshImmediate();
  }

  Fog.updateFog();
  Renderer.resetMatchViewState();
  UI.resetMatchHud();

  // Start
  State.gameSession.gameStarted = true;
  State.gameSession.menuOpen = false;
  State.gameSession.gameOver = false;
  State.gameSession.elapsedTime = 0;
  State.gameSession.matchMode = mode;
  State.gameSession.storyHistoryRecorded = false;
  if (mode === 'story' && storyLayout) {
    State.gameSession.storySeed = storyLayout.seed >>> 0;
    State.gameSession.storyMeta = {
      bases: storyLayout.enemyBases.length,
      hills: storyLayout.hills.length,
      ore: storyLayout.resources.length,
    };
  } else {
    State.gameSession.storySeed = null;
    State.gameSession.storyMeta = null;
  }
  // Solo / host seat 0 — never overwrite a multiplayer client's lobby assignment (P1–P3).
  if (!State.gameSession.isMultiplayer || State.gameSession.isHost) {
    State.gameSession.myPlayerId = 0;
  }
  State.clearBuildPlacementFlags();

  if (typeof window !== 'undefined') {
    window.__rtsMinimapWorldSpanM = Pathfinding.getNavGridSpec().planeSpanM;
    window.__rtsMapUnitNavRadius = MAP_UNIT_NAV_RADIUS;
  }

  UI.updateMenuVisibility();
  UI.refreshStoryHistoryPanel();
  if (!Input.getIsVR()) {
    UI.setMinimapVisible(true);
  }
  const startHint =
    mode === 'story'
      ? (Input.getIsVR()
        ? `Story seed ${State.gameSession.storySeed} — crush all enemy bases. Y map · X menu.`
        : `Story seed ${State.gameSession.storySeed}: explore the map and destroy all enemy HQs.`)
      : Input.getIsVR()
        ? 'Game started! Point laser at your HQ and use the trigger to open the build menu.'
        : Input.getInputPlatform() === 'touch'
          ? 'Game started! Tap your HQ to build. Army: tap friendlies to add; tap ground to move; long-press a friendly to follow (engineers repair nearby vehicles). Two-finger drag pans; pinch zooms.'
          : 'Game started! Click your HQ to open the build menu. (VR: left trigger)';
  UI.showStatus(startHint);

  Input.positionCameraForPlayer(State.gameSession.myPlayerId);

  if (State.gameSession.isMultiplayer && State.gameSession.isHost) {
    Network.broadcastData({ type: 'game-start' });
  }

  console.log(`✅ Game started (${mode}): ${State.units.size} units, ${State.buildings.size} buildings, ${State.resourceFields.size} resource fields`);
  } finally {
    UI.setMatchPreparing(false);
  }
}

function onHostGame() {
  Network.startHosting();
}

function onJoinGame() {
  Network.joinGame();
}
