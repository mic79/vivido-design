/**
 * BattleVR2 — entry: RTSVR6 sim + FP Box3D + vehicle/cockpit + PeerJS.
 */
window.__BATTLEVR2__ = true;

import {
  initializeGame,
  onStartGame as rtsStartGame,
  onHostGame,
  onJoinGame,
} from './rts/main.js';
import * as State from './rts/state.js';
import * as Units from './rts/units.js';
import * as Loop from './rts/loop.js';
import * as UI from './rts/ui.js';
import { sampleMoonTerrainWorldY } from './rts/moon-environment.js';
import { ensureThreeGltfLoaders } from './rts/three-gltf-umd.js';
import * as Box3D from './box3d-world.js';
import * as Vehicle from './vehicle.js';
import * as Cockpit from './cockpit.js';
import * as InputFp from './input-fp.js';
import * as Bridge from './rts-bridge.js';
import * as BotBody from './bot-body-box3d.js';
import * as Zerog from './zerog-loco.js';
import { FLOOR_BAND_PLAYER, FLOOR_BAND_VEHICLE } from './battle-phys.js';

const VERSION = '0.1.91';

async function afterMatchStart() {
  Bridge.setTerrainSampler((x, z) => sampleMoonTerrainWorldY(x, z));

  // Never start boarded / inside cockpit — that was the Quest black-hull trap.
  Vehicle.forceExit();
  Cockpit.hideCockpitHard();

  const spawn = Bridge.placePlayerNearSpawn();
  // Feet on terrain — XR eye height comes from local-floor, not another +1.7 m.
  const feetY = (Number.isFinite(spawn.y) ? spawn.y : 0) + FLOOR_BAND_PLAYER;
  Zerog.resetZerogAt(spawn.x, feetY, spawn.z, 0);
  const body = document.getElementById('local-body');
  if (body) body.setAttribute('visible', 'true');

  // Park fighter well clear of the FP spawn (was +8m → inside oversized hull).
  const parkX = spawn.x + 36;
  const parkZ = spawn.z + 8;
  const gy = sampleMoonTerrainWorldY(parkX, parkZ);
  const vSpawn = {
    x: parkX,
    y: (Number.isFinite(gy) ? gy : spawn.y - 1.6) + FLOOR_BAND_VEHICLE,
    z: parkZ,
    yaw: 0,
  };
  if (!Number.isFinite(vSpawn.y) || vSpawn.y < 0.2) {
    vSpawn.y = Math.max(FLOOR_BAND_VEHICLE, spawn.y - 1.2);
  }
  if (!window.__BATTLEVR2_VEHICLE__) {
    await Vehicle.initVehicle(document.querySelector('a-scene'), vSpawn);
  } else {
    Vehicle.teleportVehicle(vSpawn.x, vSpawn.y, vSpawn.z, 0);
  }
  Vehicle.setExteriorVisible(true);
  Cockpit.hideCockpitHard();

  // Fog-presence proxy only (mesh hidden). ScoutBike GLB was drawing inside the fighter.
  Bridge.clearHeroUnit();
  const me = State.gameSession.myPlayerId ?? 0;
  const hero = Units.createUnit('scoutBike', me, vSpawn.x, vSpawn.z, {
    skipCapCheck: true,
    skipProducedStat: true,
    fpHero: true,
  });
  if (hero) Bridge.bindHeroUnit(hero.id);

  BotBody.clearBotBodies(document.querySelector('a-scene'));
  BotBody.spawnOpponentBodyNearEnemy(document.querySelector('a-scene'));

  const rig = document.getElementById('cameraRig');
  if (rig) {
    rig.object3D.position.set(spawn.x, spawn.y, spawn.z);
    rig.object3D.rotation.set(0, 0, 0);
    const cam = document.getElementById('camera');
    if (cam) {
      cam.object3D.position.set(0, 0, 0);
      // WebXR owns HMD pose — do not force camera rotation while presenting.
      const xr = document.querySelector('a-scene')?.renderer?.xr;
      if (!(xr && xr.isPresenting)) {
        cam.object3D.rotation.set(0, 0, 0);
        cam.setAttribute('rotation', '0 0 0');
      }
    }
  }
  if (typeof window.__rtsCameraRigPose === 'function') {
    window.__rtsCameraRigPose({ x: spawn.x, y: spawn.y, z: spawn.z, rotY: 0 });
  }

  // Ensure sim loop is attached after match bootstrap (A-Frame component flush).
  try {
    Loop.stopLoop();
    Loop.startLoop(document.querySelector('a-scene'));
  } catch (err) {
    console.warn('[BattleVR2] loop restart', err);
  }

  window.__SCENE_READY__ = true;
  window.__BATTLEVR2_MATCH__ = {
    mode: State.gameSession.matchMode,
    units: State.units.size,
    boarded: false,
  };
  window.__BATTLEVR2_DEBUG__ = () => {
    let bots = 0;
    let moving = 0;
    let botOrders = 0;
    State.players.forEach((p) => {
      if (p.isBot && p.isActive && !p.isDefeated) bots++;
    });
    State.units.forEach((u) => {
      if (u.hp > 0 && (u.state === 'moving' || u.state === 'attacking' || u.path)) moving++;
      const owner = State.players[u.ownerId];
      if (owner?.isBot && u.hp > 0 && u.state !== 'idle') botOrders++;
    });
    const sc = document.querySelector('a-scene');
    const info = sc?.renderer?.info?.render;
    return {
      units: State.units.size,
      buildings: State.buildings.size,
      bots,
      moving,
      botOrders,
      elapsed: State.gameSession.elapsedTime,
      boarded: !!window.__BATTLEVR2_BOARDED__,
      vehicle: Vehicle.getVehiclePose(),
      draws: info?.calls ?? null,
      tris: info?.triangles ?? null,
      mp: !!(State.gameSession.isMultiplayer),
      host: !!(State.gameSession.isHost),
    };
  };
  console.log('[BattleVR2] match FP ready', window.__BATTLEVR2_MATCH__);
}

async function startGame(mode) {
  await rtsStartGame(mode || '1v1');
  if (State.gameSession.gameStarted) {
    await afterMatchStart();
  }
}

function wireDesktopMenu() {
  const bind = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', (e) => {
      e.preventDefault();
      fn();
    });
  };
  bind('btn-start-1v1', () => startGame('1v1'));
  bind('btn-host', () => onHostGame());
  bind('btn-join', () => onJoinGame());
  bind('btn-start-mp', () => startGame('1v1'));

  window._startGame = startGame;
  window._hostGame = onHostGame;
  window._joinGame = onJoinGame;
  window._battleVr2Version = VERSION;
}

async function boot() {
  console.log(`[BattleVR2] ${VERSION} booting…`);
  const scene = document.querySelector('a-scene');
  if (!scene) throw new Error('no a-scene');

  const run = async () => {
    await ensureThreeGltfLoaders();
    await initializeGame(scene);
    // Override UI callbacks so start goes through FP after-hook.
    UI.setCallbacks(startGame, onHostGame, onJoinGame);
    wireDesktopMenu();

    await Box3D.initBox3DWorld();
    InputFp.initInputFp(scene);
    await Cockpit.initCockpit(scene);
    Cockpit.hideCockpitHard();
    Vehicle.forceExit();

    // Preload fighter far from origin (repositioned on match start).
    try {
      await Vehicle.initVehicle(scene, { x: 80, y: FLOOR_BAND_VEHICLE, z: 80, yaw: 0 });
    } catch (err) {
      console.warn('[BattleVR2] vehicle preload failed', err);
    }

    // Hook sim tick for bot bodies + hero sync
    const prev = window.__BATTLEVR2_FP_INPUT__;
    window.__BATTLEVR2_FP_INPUT__ = (dt) => {
      if (typeof prev === 'function') prev(dt);
      if (State.gameSession.gameStarted) {
        Bridge.syncHeroFromVehicle();
        BotBody.stepBotBodies(dt);
      }
    };

    window.__SCENE_READY__ = true;
    window.__BATTLEVR2_BOOT__ = {
      version: VERSION,
      box3d: !!Box3D.isBox3DReady(),
      fighter: !!window.__BATTLEVR2_VEHICLE__,
      cockpit: !!window.__BATTLEVR2_COCKPIT__,
    };
    // Bench/debug: vehicle integrate + tick counter (rAF + 60Hz interval for headless).
    let lastAux = performance.now();
    const auxStep = () => {
      const now = performance.now();
      const dt = Math.min(0.05, (now - lastAux) / 1000);
      lastAux = now;
      window.__BATTLEVR2_TICK__ = (window.__BATTLEVR2_TICK__ || 0) + 1;
      // Boarded / coast integrate via FP tick — aux only for headless FORCE benches
      // (avoids double-stepping the chassis every frame).
      if (window.__BATTLEVR2_FORCE_VEHICLE_STEP__) {
        if (window.__BATTLEVR2_DESKTOP_VEHICLE__) {
          Vehicle.setVehicleControls(window.__BATTLEVR2_DESKTOP_VEHICLE__);
        }
        Vehicle.stepVehicle(dt > 0 ? dt : 1 / 60);
      }
    };
    requestAnimationFrame(function rafAux(now) {
      lastAux = now;
      auxStep();
      requestAnimationFrame(rafAux);
    });
    setInterval(auxStep, 16);

    window.__BATTLEVR2_ENTER_VEHICLE__ = () => {
      Vehicle.enterVehicle();
      Cockpit.showCockpit(true);
      const body = document.getElementById('local-body');
      if (body) body.setAttribute('visible', 'true');
      return !!window.__BATTLEVR2_BOARDED__;
    };
    window.__BATTLEVR2_DUMP_GRIPCAL__ = () => Cockpit.dumpGripCalibration('both');
    if (Cockpit.isGripCalEnabled()) {
      console.log(
        '[BattleVR2] #gripcal ON — cockpit hand snaps disabled; press A in VR to dump offsets'
      );
    }
    window.__BATTLEVR2_EXIT_VEHICLE__ = () => {
      Cockpit.showCockpit(false);
      Vehicle.exitVehicle();
      const body = document.getElementById('local-body');
      if (body) body.setAttribute('visible', 'true');
      return !window.__BATTLEVR2_BOARDED__;
    };

    const loading = document.getElementById('loading-screen');
    if (loading) loading.style.display = 'none';
    console.log('[BattleVR2] boot complete', window.__BATTLEVR2_BOOT__);
  };

  if (scene.hasLoaded) await run();
  else await new Promise((resolve) => {
    scene.addEventListener('loaded', () => run().then(resolve).catch(resolve));
  });
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch((err) => {
    console.error('[BattleVR2] boot failed', err);
    window.__BATTLEVR2_BOOT_ERROR__ = String(err && err.message || err);
  });
});
