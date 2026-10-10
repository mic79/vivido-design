/**
 * BattleVR2 — CapVR zero-G hover body on foot + cockpit grip drive.
 *
 * ON FOOT (CapVR locomotion — NOT walking):
 *   Y / B (hold)     — hand thrusters (controller −Y)
 *   Left stick click — look-direction boost
 *   Right stick X    — yaw
 *   Left stick       — small surge/strafe assist
 *   Right stick click — board / exit
 *
 * ON FOOT (flatscreen PC — click canvas for pointer lock):
 *   WASD / arrows     — surge / strafe
 *   Mouse             — look (yaw + pitch)
 *   Space / Q / E     — thrusters
 *   Shift             — look-boost
 *   F                 — board / exit fighter
 *
 * IN COCKPIT (Battlezone hover fighter):
 *   Grip flight stick  — yaw
 *   Grip thrust lever  — forward/back (lever forward = go forward)
 *   Stick hand + trigger — fire guns (look aim)
 *   Left stick click   — boost/jump
 *   Body/arms stay VISIBLE so you can see hands on the controls
 *
 * IN COCKPIT (flatscreen PC):
 *   W/S               — thrust
 *   A/D               — strafe
 *   Mouse             — turn ship (X) + look pitch (Y)
 *   LMB               — fire
 *   Space             — boost
 *   F                 — exit
 *
 * RTS laser (right trigger etc.) — RTSVR6 path unchanged (except stick-hand fire).
 */
import * as State from './rts/state.js';
import * as Units from './rts/units.js';
import * as Renderer from './rts/renderer.js';
import * as Network from './rts/network.js';
import * as Box3D from './box3d-world.js';
import * as Vehicle from './vehicle.js';
import * as Cockpit from './cockpit.js';
import * as Zerog from './zerog-loco.js';
import * as FighterCombat from './vehicle-combat.js';
import { FIXED_EYE_HEIGHT_M } from './battle-phys.js';
import { getVrControllerSample, getIsVR } from './rts/input.js';
import { sampleGroundY } from './rts-bridge.js';

const keys = new Set();
let yaw = 0;
/** Desktop look pitch (camera-local X), clamped. */
let lookPitch = 0;
/** Accumulated pointer-lock mouse deltas since last frame. */
let pendingLookDx = 0;
let pendingLookDy = 0;
/** LMB held while pointer-locked (fighter fire on desktop). */
let mouseFireHeld = false;
const MOUSE_YAW_SENS = 0.0025;
const MOUSE_PITCH_SENS = 0.0020;
const LOOK_PITCH_MIN = -1.15;
const LOOK_PITCH_MAX = 1.05;
let sceneEl = null;
let rigEl = null;
let cameraEl = null;
let selectLatch = false;
let orderLatch = false;
let prevPadRightClick = false;
let prevPadLeftClick = false;
/** One-shot: game-over must release stick grab + restore laser even if grip is still held. */
let clearedCockpitForGameOver = false;

function clampLookPitch(p) {
  return Math.max(LOOK_PITCH_MIN, Math.min(LOOK_PITCH_MAX, p));
}

function consumeMouseLook() {
  const dx = pendingLookDx;
  const dy = pendingLookDy;
  pendingLookDx = 0;
  pendingLookDy = 0;
  return { dx, dy };
}

function applyDesktopCameraPitch() {
  if (!cameraEl?.object3D || isXrPresenting()) return;
  cameraEl.object3D.rotation.x = lookPitch;
  cameraEl.object3D.rotation.y = 0;
  cameraEl.object3D.rotation.z = 0;
}

function stickAxis(v, deadzone = 0.15) {
  const a = Math.abs(v || 0);
  if (a <= deadzone) return 0;
  const sign = v < 0 ? -1 : 1;
  return sign * (a - deadzone) / (1 - deadzone);
}

function isXrPresenting() {
  try {
    const xr = sceneEl?.renderer?.xr;
    if (xr && xr.isPresenting) return true;
  } catch (_) { /* ignore */ }
  return !!getIsVR?.();
}

function pollGamepadSticks() {
  const out = { leftX: 0, leftY: 0, rightX: 0, rightY: 0, leftClick: false, rightClick: false };
  try {
    const pads = navigator.getGamepads?.() || [];
    for (const gp of pads) {
      if (!gp || !gp.axes || gp.axes.length < 2) continue;
      const axes = gp.axes;
      if (axes.length >= 4) {
        out.leftX = axes[0] || 0;
        out.leftY = axes[1] || 0;
        out.rightX = axes[2] || 0;
        out.rightY = axes[3] || 0;
      } else {
        out.leftX = axes[0] || 0;
        out.leftY = axes[1] || 0;
      }
      const btns = gp.buttons || [];
      if (btns[3]?.pressed) out.leftClick = true;
      if (btns[12]?.pressed) out.leftClick = true;
      if (btns[11]?.pressed) out.rightClick = true;
      break;
    }
  } catch (_) { /* ignore */ }
  return out;
}

export function initInputFp(scene) {
  sceneEl = scene;
  rigEl = document.getElementById('cameraRig');
  cameraEl = document.getElementById('camera');

  // CapVR zero-G body mode (floating legs / no walk IK)
  try {
    window.BodyRiggedGravity?.setMode?.('zerog', { force: true });
    window.BodyRiggedGravity.allowSwitch = false;
  } catch (_) { /* ignore */ }

  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'KeyF') tryToggleBoard();
    // Prevent page scroll while flying / boosting.
    if (
      (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'ArrowDown') &&
      State.gameSession.gameStarted &&
      !State.gameSession.menuOpen
    ) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  window.addEventListener('mousemove', (e) => {
    if (!document.pointerLockElement || isXrPresenting()) return;
    pendingLookDx += e.movementX || 0;
    pendingLookDy += e.movementY || 0;
  });

  window.addEventListener('mousedown', (e) => {
    if (e.button === 0 && document.pointerLockElement && !isXrPresenting()) {
      mouseFireHeld = true;
      return;
    }
    if (e.button !== 0 || document.pointerLockElement) return;
    if (State.gameSession.awaitingAppStart) return;
    const t = e.target;
    if (t && (t.closest?.('.a-enter-vr') || t.closest?.('.a-enter-ar') || t.closest?.('#btn-app-start'))) {
      return;
    }
    const canvas = sceneEl?.canvas;
    if (!canvas || (t !== canvas && !canvas.contains?.(t))) return;
    if (isXrPresenting()) return;
    canvas.requestPointerLock?.();
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) mouseFireHeld = false;
  });
  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement) mouseFireHeld = false;
  });

  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target;
      if (!t || !document.pointerLockElement) return;
      if (t.closest?.('.a-enter-vr') || t.closest?.('.a-enter-vr-button')) {
        document.exitPointerLock?.();
      }
    },
    true
  );

  wireZerogThrusterButtons();
  wireStickClicks();
  syncBoardWristButton();

  window.__BATTLEVR2_FP_INPUT__ = (dt) => {
    updateFp(dt);
    if (window.__BATTLEVR2_FORCE_VEHICLE_STEP__ && !Vehicle.isBoarded()) {
      Cockpit.updateCockpitControls();
      Vehicle.stepVehicle(dt);
    }
  };
  window.__BATTLEVR2_TRY_BOARD__ = tryToggleBoard;
  window.__BATTLEVR2_FORCE_BOARD__ = () => tryToggleBoard(true);
  window._battleVr2Board = () => tryToggleBoard(false);

  console.log(
    '[BattleVR2] CapVR zero-G + cockpit grips; PC: click canvas → WASD + mouse (F board, LMB fire in fighter)'
  );
}

function onFootOk() {
  return (
    State.gameSession.gameStarted &&
    !State.gameSession.menuOpen &&
    !State.gameSession.gameOver &&
    !Vehicle.isBoarded()
  );
}

function wireZerogThrusterButtons() {
  const left = document.getElementById('leftHand');
  const right = document.getElementById('rightHand');
  // CapVR: Y = left thruster, B = right thruster
  if (left) {
    left.addEventListener('ybuttondown', () => {
      if (onFootOk()) Zerog.setThruster('left', true);
    });
    left.addEventListener('ybuttonup', () => Zerog.setThruster('left', false));
    left.addEventListener('buttondown', (e) => {
      if (!onFootOk()) return;
      const id = e.detail?.id;
      if (id === 'ybutton' || id === 5 || id === 'yb') Zerog.setThruster('left', true);
    });
    left.addEventListener('buttonup', (e) => {
      const id = e.detail?.id;
      if (id === 'ybutton' || id === 5 || id === 'yb') Zerog.setThruster('left', false);
    });
  }
  if (right) {
    right.addEventListener('bbuttondown', () => {
      if (onFootOk()) Zerog.setThruster('right', true);
    });
    right.addEventListener('bbuttonup', () => Zerog.setThruster('right', false));
    right.addEventListener('buttondown', (e) => {
      if (!onFootOk()) return;
      const id = e.detail?.id;
      if (id === 'bbutton' || id === 5 || id === 'bb') Zerog.setThruster('right', true);
    });
    right.addEventListener('buttonup', (e) => {
      const id = e.detail?.id;
      if (id === 'bbutton' || id === 5 || id === 'bb') Zerog.setThruster('right', false);
    });
  }
}

function wireStickClicks() {
  const left = document.getElementById('leftHand');
  const right = document.getElementById('rightHand');
  if (left) {
    left.addEventListener('thumbstickdown', () => {
      if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;
      if (Vehicle.isBoarded()) {
        window.__BATTLEVR2_VEHICLE_BOOST__ = true;
        Vehicle.requestBoost();
        return;
      }
      Zerog.requestLookBoost(cameraEl);
    });
  }
  if (right) {
    right.addEventListener('thumbstickdown', () => {
      if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;
      tryToggleBoard();
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && Vehicle.isBoarded()) {
      e.preventDefault();
      window.__BATTLEVR2_VEHICLE_BOOST__ = true;
      Vehicle.requestBoost();
    }
    if (e.code === 'ShiftLeft' && onFootOk()) {
      Zerog.requestLookBoost(cameraEl);
    }
  });
}

function syncBoardWristButton() {
  const el = document.getElementById('vr-btn-board');
  const label = document.getElementById('vr-btn-board-label');
  if (!el) return;
  const show = !!(State.gameSession.gameStarted && !State.gameSession.menuOpen);
  el.setAttribute('visible', show ? 'true' : 'false');
  if (label) {
    label.setAttribute('value', Vehicle.isBoarded() ? 'Exit fighter' : 'Board fighter');
  }
}

function ensureBodyVisible() {
  const body = document.getElementById('local-body');
  if (body) body.setAttribute('visible', 'true');
}

function tryToggleBoard(force = false) {
  if (!State.gameSession.gameStarted && !force) return;
  if (Vehicle.isBoarded()) {
    Cockpit.showCockpit(false);
    Cockpit.hideCockpitHard();
    // Beside hull + inherited velocity — do not resetZerogAt (that zeros momentum).
    const p = Vehicle.exitVehicle();
    yaw = p.yaw ?? yaw;
    Zerog.setZerogYaw(yaw);
    Zerog.setThruster('left', false);
    Zerog.setThruster('right', false);
    syncRigToPos(p.x, p.y, p.z, yaw);
    ensureBodyVisible();
  } else {
    let p = Box3D.getPlayerPosition();
    if (rigEl?.object3D) {
      const rp = rigEl.object3D.position;
      if (Math.hypot(p.x, p.z) < 0.5 && Math.hypot(rp.x, rp.z) > 1) {
        p = { x: rp.x, y: rp.y, z: rp.z };
        Box3D.spawnPlayerAt(p.x, p.y, p.z);
      }
    }
    const v = Vehicle.getVehiclePose();
    const dist = Math.hypot(p.x - v.x, p.z - v.z);
    if (!force && dist > 14) {
      console.log('[BattleVR2] too far to board', dist.toFixed(1));
      return;
    }
    if (force || dist > 5) {
      Box3D.spawnPlayerAt(v.x + 2, Math.max(v.y, sampleGroundY(v.x, v.z, v.y) + 1.8), v.z + 2);
    }
    Vehicle.enterVehicle();
    Cockpit.showCockpit(true);
    ensureBodyVisible(); // MUST see arms/hands to grip stick + throttle
  }
  syncBoardWristButton();
}

function forceReleaseCockpitForUi() {
  Cockpit.releaseControlGrabs();
  if (Vehicle.isBoarded()) {
    Vehicle.forceExit();
    Cockpit.hideCockpitHard();
  }
  FighterCombat.setFighterCrosshairVisible(false);
}

function updateFp(dt) {
  syncBoardWristButton();
  ensureBodyVisible();

  if (!State.gameSession.gameStarted) {
    clearedCockpitForGameOver = false;
    return;
  }
  if (State.gameSession.gameOver) {
    if (!clearedCockpitForGameOver) {
      clearedCockpitForGameOver = true;
      forceReleaseCockpitForUi();
    }
    return;
  }
  clearedCockpitForGameOver = false;

  if (State.gameSession.menuOpen) {
    Zerog.setThruster('left', false);
    Zerog.setThruster('right', false);
    Cockpit.releaseControlGrabs();
    return;
  }

  const sample = getVrControllerSample();
  const pad = isXrPresenting()
    ? pollGamepadSticks()
    : { leftX: 0, leftY: 0, rightX: 0, rightY: 0, leftClick: false, rightClick: false };

  let leftX = sample.leftX;
  let leftY = sample.leftY;
  let rightX = sample.rightX;
  if (isXrPresenting()) {
    const afMag = Math.abs(leftX) + Math.abs(leftY) + Math.abs(rightX);
    const padMag = Math.abs(pad.leftX) + Math.abs(pad.leftY) + Math.abs(pad.rightX);
    if (afMag < 0.05 && padMag > 0.05) {
      leftX = pad.leftX;
      leftY = pad.leftY;
      rightX = pad.rightX;
    }
    if (pad.rightClick && !prevPadRightClick) tryToggleBoard();
    if (pad.leftClick && !prevPadLeftClick) {
      if (Vehicle.isBoarded()) {
        window.__BATTLEVR2_VEHICLE_BOOST__ = true;
        Vehicle.requestBoost();
      } else {
        Zerog.requestLookBoost(cameraEl);
      }
    }
    prevPadRightClick = !!pad.rightClick;
    prevPadLeftClick = !!pad.leftClick;
  } else {
    prevPadRightClick = false;
    prevPadLeftClick = false;
  }

  if (Vehicle.isBoarded()) {
    Zerog.setThruster('left', false);
    Zerog.setThruster('right', false);

    // Keep body+rig locked to seat BEFORE sampling hands so grab deltas are cockpit-local
    // and do not fight vehicle motion (world-space grabs shook the cockpit).
    Cockpit.syncCockpitToVehicle();
    {
      const seat0 = Cockpit.getSeatWorldPosition();
      syncRigToSeat(seat0.x, seat0.y, seat0.z, seat0.yaw);
    }
    updateHandsFromControllers(sample);

    const look = consumeMouseLook();
    if (!isXrPresenting()) {
      lookPitch = clampLookPitch(lookPitch - look.dy * MOUSE_PITCH_SENS);
    } else {
      lookPitch = 0;
      pendingLookDx = 0;
      pendingLookDy = 0;
    }

    if (!window.__BATTLEVR2_FORCE_VEHICLE_STEP__) {
      let vYaw = 0;
      let thrust = 0;
      let strafe = 0;
      // PC: W/S thrust. With pointer-lock, mouse turns + A/D strafe; else A/D yaw.
      if (!isXrPresenting()) {
        if (keys.has('KeyW') || keys.has('ArrowUp')) thrust += 1;
        if (keys.has('KeyS') || keys.has('ArrowDown')) thrust -= 1;
        if (document.pointerLockElement) {
          if (keys.has('KeyA') || keys.has('ArrowLeft')) strafe -= 1;
          if (keys.has('KeyD') || keys.has('ArrowRight')) strafe += 1;
        } else {
          if (keys.has('KeyA') || keys.has('ArrowLeft')) vYaw += 1;
          if (keys.has('KeyD') || keys.has('ArrowRight')) vYaw -= 1;
        }
      }
      // XR: physical stick/lever only — thumbsticks caused phantom yaw after releasing grab.
      window.__BATTLEVR2_DESKTOP_VEHICLE__ = {
        yaw: Math.max(-1, Math.min(1, vYaw)),
        thrust: Math.max(-1, Math.min(1, thrust)),
        strafe: Math.max(-1, Math.min(1, strafe)),
        yawDelta: !isXrPresenting() ? -look.dx * MOUSE_YAW_SENS : 0,
        boost: false,
      };
    }
    Cockpit.updateCockpitControls();
    Vehicle.stepVehicle(dt);
    Cockpit.syncCockpitToVehicle();
    const seat = Cockpit.getSeatWorldPosition();
    syncRigToSeat(seat.x, seat.y, seat.z, seat.yaw);
    yaw = seat.yaw;
    Zerog.setZerogYaw(yaw);
    ensureBodyVisible();
    const joyHand = window.__BATTLEVR2_COCKPIT_JOY_HAND__ || null;
    const xr = isXrPresenting();
    // Guns only while the stick is gripped — free hand keeps RTS laser / select.
    // Desktop: hold LMB (or hold Ctrl) to fire.
    const fireWanted = xr
      ? (!!joyHand &&
          ((joyHand === 'left' && !!sample.leftTrigger) ||
            (joyHand === 'right' && !!sample.rightTrigger) ||
            !!window.__BATTLEVR2_FIGHTER_FIRE__))
      : mouseFireHeld ||
        keys.has('ControlLeft') ||
        keys.has('ControlRight') ||
        !!window.__BATTLEVR2_FIGHTER_FIRE__;
    FighterCombat.stepFighterCombat(dt, {
      fireWanted,
      joyHand: joyHand || (!xr ? 'desktop' : null),
      requireStick: xr,
    });
  } else {
    FighterCombat.setFighterCrosshairVisible(false);
    updateHandsFromControllers(sample);
    window.__BATTLEVR2_DESKTOP_VEHICLE__ = null;
    if (Cockpit.isCockpitActive()) Cockpit.hideCockpitHard();

    const look = consumeMouseLook();
    if (!isXrPresenting() && document.pointerLockElement) {
      yaw -= look.dx * MOUSE_YAW_SENS;
      lookPitch = clampLookPitch(lookPitch - look.dy * MOUSE_PITCH_SENS);
      Zerog.setZerogYaw(yaw);
    } else if (isXrPresenting()) {
      lookPitch = 0;
    }

    // Desktop thruster holds
    if (!isXrPresenting()) {
      Zerog.setThruster('left', keys.has('KeyQ') || keys.has('Space'));
      Zerog.setThruster('right', keys.has('KeyE') || keys.has('Space'));
    }

    let surge = -stickAxis(leftY);
    let strafe = stickAxis(leftX);
    if (!isXrPresenting()) {
      if (keys.has('KeyW') || keys.has('ArrowUp')) surge += 1;
      if (keys.has('KeyS') || keys.has('ArrowDown')) surge -= 1;
      if (keys.has('KeyA') || keys.has('ArrowLeft')) strafe -= 1;
      if (keys.has('KeyD') || keys.has('ArrowRight')) strafe += 1;
      surge = Math.max(-1, Math.min(1, surge));
      strafe = Math.max(-1, Math.min(1, strafe));
    }

    const pose = Zerog.stepZerog(dt, {
      yawStick: stickAxis(rightX),
      surge,
      strafe,
      desktop: !isXrPresenting(),
      keys,
    });
    yaw = pose.yaw;
    syncRigToPos(pose.x, pose.y, pose.z, pose.yaw);
    // Empty fighter keeps momentum (shared phys is the player while on foot).
    Vehicle.stepVehicle(dt);
  }

  if (!isXrPresenting()) handleDesktopRtsCommands();
}

/**
 * On-foot: lock virtual eye to feet+FIXED_EYE (IRL sit/stand does not change view height).
 * headsetWorld = rigPos + R(yaw)*headLocal ⇒ rigPos = eye − R(yaw)*headLocal.
 */
function syncRigToFixedEye(eyeX, eyeY, eyeZ, yawRad) {
  if (!rigEl) return;
  let x = eyeX;
  let y = eyeY;
  let z = eyeZ;
  if (isXrPresenting() && cameraEl?.object3D) {
    const head = cameraEl.object3D.position;
    const c = Math.cos(yawRad);
    const s = Math.sin(yawRad);
    const hx = head.x;
    const hy = head.y;
    const hz = head.z;
    x -= hx * c + hz * s;
    y -= hy;
    z -= -hx * s + hz * c;
  } else if (cameraEl?.object3D) {
    cameraEl.object3D.position.set(0, 0, 0);
    cameraEl.object3D.rotation.set(0, 0, 0);
  }
  rigEl.object3D.position.set(x, y, z);
  rigEl.object3D.rotation.set(0, yawRad, 0);
}

function syncRigToPos(x, y, z, yawRad) {
  const eyeY = y + FIXED_EYE_HEIGHT_M;
  if (isXrPresenting()) {
    syncRigToFixedEye(x, eyeY, z, yawRad);
    return;
  }
  if (!rigEl) return;
  rigEl.object3D.position.set(x, y, z);
  rigEl.object3D.rotation.set(0, yawRad, 0);
  if (cameraEl && !Vehicle.isBoarded()) {
    cameraEl.object3D.position.set(0, FIXED_EYE_HEIGHT_M, 0);
    applyDesktopCameraPitch();
  }
}

/**
 * Cockpit (ChaseVR pattern): seat point is the designed eye reference.
 * - Pin rig XZ to the seat (no live head-XZ cancel — that slid the whole cabin).
 * - Cancel only headset Y so eyes sit at seat height whether standing or seated IRL.
 * - XR camera XZ/rotation still move naturally inside the cabin.
 */
function syncRigToSeat(seatX, seatY, seatZ, yawRad) {
  if (!rigEl) return;
  let y = seatY;
  if (isXrPresenting() && cameraEl?.object3D) {
    y = seatY - cameraEl.object3D.position.y;
  } else if (cameraEl?.object3D) {
    cameraEl.object3D.position.set(0, 0, 0);
    applyDesktopCameraPitch();
  }
  rigEl.object3D.position.set(seatX, y, seatZ);
  rigEl.object3D.rotation.set(0, yawRad, 0);
}

function pollGamepadGrips() {
  const out = { left: false, right: false };
  try {
    const pads = navigator.getGamepads?.() || [];
    // Never mirror unknown pads onto both hands — that kept grab "stuck" after release.
    for (const gp of pads) {
      if (!gp?.buttons) continue;
      const squeezed = !!(gp.buttons[1]?.pressed || (gp.buttons[1]?.value || 0) > 0.75);
      const id = String(gp.id || '').toLowerCase();
      if (id.includes('left')) out.left = out.left || squeezed;
      else if (id.includes('right')) out.right = out.right || squeezed;
      else if (gp.index === 0) out.left = out.left || squeezed;
      else if (gp.index === 1) out.right = out.right || squeezed;
    }
  } catch (_) { /* ignore */ }
  return out;
}

function updateHandsFromControllers(sample) {
  const left = document.getElementById('leftHand');
  const right = document.getElementById('rightHand');
  const padGrip = pollGamepadGrips();
  for (const [name, el, gripFlag] of [
    ['left', left, sample.leftGrip || padGrip.left],
    ['right', right, sample.rightGrip || padGrip.right],
  ]) {
    if (!el || !el.object3D) continue;
    const p = new window.THREE.Vector3();
    el.object3D.getWorldPosition(p);
    const gripping = !!(gripFlag || window[`__grip_${name}`]);
    Cockpit.setHandWorldPos(name, p.x, p.y, p.z, gripping);
  }
}

function aimRay() {
  const cam = cameraEl?.object3D || rigEl?.object3D;
  if (!cam) return null;
  const origin = new window.THREE.Vector3();
  const direction = new window.THREE.Vector3(0, 0, -1);
  cam.getWorldPosition(origin);
  direction.applyQuaternion(cam.getWorldQuaternion(new window.THREE.Quaternion()));
  return { origin, direction };
}

function handleDesktopRtsCommands() {
  const wantSelect = window.__BATTLEVR2_CLICK__ === 'select';
  const wantOrder = window.__BATTLEVR2_CLICK__ === 'order';
  if (wantSelect || wantOrder) window.__BATTLEVR2_CLICK__ = null;

  if (wantSelect || (keys.has('KeyQ') && !selectLatch && !Zerog.isThrusterOn('left'))) {
    selectLatch = true;
    doSelect();
  }
  if (!keys.has('KeyQ')) selectLatch = false;

  if (wantOrder || (keys.has('KeyR') && !orderLatch)) {
    orderLatch = true;
    doMoveOrder();
  }
  if (!keys.has('KeyR')) orderLatch = false;
}

function doSelect() {
  const ray = aimRay();
  if (!ray) return;
  const hit = Renderer.raycastUnits(ray.origin, ray.direction, 250);
  if (hit && hit.ownerId === State.gameSession.myPlayerId) {
    State.selectedUnits.clear();
    State.selectedUnits.add(hit.id);
  } else {
    State.selectedUnits.clear();
  }
}

function doMoveOrder() {
  const ids = Array.from(State.selectedUnits).filter((id) => {
    const u = State.units.get(id);
    return u && u.hp > 0 && u.ownerId === State.gameSession.myPlayerId;
  });
  if (!ids.length) return;
  const ray = aimRay();
  if (!ray) return;
  let gx = ray.origin.x + ray.direction.x * 40;
  let gz = ray.origin.z + ray.direction.z * 40;
  for (let t = 5; t < 120; t += 2) {
    const x = ray.origin.x + ray.direction.x * t;
    const y = ray.origin.y + ray.direction.y * t;
    const z = ray.origin.z + ray.direction.z * t;
    const gy = sampleGroundY(x, z, y);
    if (Number.isFinite(gy) && y <= gy + 0.5) {
      gx = x;
      gz = z;
      break;
    }
  }
  if (State.gameSession.isMultiplayer && !State.gameSession.isHost) {
    Network.sendCommand({ action: 'move', unitIds: ids, x: gx, z: gz });
  } else {
    Units.commandMove(ids, gx, gz);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('mousedown', (e) => {
    if (!document.pointerLockElement) return;
    // In the fighter, LMB is the gun — don't steal it for RTS select.
    if (Vehicle.isBoarded()) return;
    if (e.button === 0) window.__BATTLEVR2_CLICK__ = 'select';
    if (e.button === 2) {
      e.preventDefault();
      window.__BATTLEVR2_CLICK__ = 'order';
    }
  });
  window.addEventListener('contextmenu', (e) => {
    if (document.pointerLockElement) e.preventDefault();
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyG') window.__grip_right = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyG') window.__grip_right = false;
  });
}
