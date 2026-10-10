/**
 * BattleVR2 — cockpit stick + throttle (ChaseVR cyclic-style grab).
 * Grab = grip near control; input = hand delta from grab-start neutral; release = zero.
 * Lever toward canopy = +thrust. Stick right = turn right.
 * While gripping the thrust lever, that hand's thumbstick X = strafe.
 */
import * as Vehicle from './vehicle.js';

const COCKPIT_URL = 'assets/vehicles/spacefighter_cockpit_wasp_interdictor.glb';
const TARGET_HEIGHT_M = 1.85;
/**
 * Mesh-only bias: Sketchfab cockpit faces the opposite way from A-Frame −Z look.
 * Look + thrust use bare pose.yaw. Do NOT put this on the camera rig.
 */
export const COCKPIT_YAW_BIAS = Math.PI;
/** ChaseVR-scale grab / hand travel (meters, cockpit-local). */
const GRAB_RADIUS = 0.22;
const HAND_YAW_RANGE = 0.11;
/** Cockpit-local Z travel on the virtual stick → gun aim pitch (−1…1). */
const HAND_AIM_RANGE = 0.1;
const HAND_THRUST_RANGE = 0.14;
const HAND_DEADZONE = 0.01;
/**
 * Grip must stay released this long before the grab ends. Quest grip value flicker
 * was clearing joyGrab for a frame and springing gun aim back to center.
 */
const GRAB_RELEASE_HOLD_MS = 160;
const VISUAL_EPS = 0.015;
const STICK_ROLL_ANGLE = 0.55;
/** Virtual stick tip fwd/back (matches gun aim). */
const STICK_AIM_TILT_ANGLE = 0.225;
const LEVER_PITCH_ANGLE = 0.65;
/** Gun elevation (rad) at full virtual-stick fwd/back. Halved from 0.95 — less twitchy VR aim. */
const STICK_AIM_PITCH_RAD = 0.475;
/** Flatscreen / visual mesh: spring toward command (1/s). Return slightly softer. */
const VISUAL_SMOOTH_RATE = 12;
const VISUAL_RETURN_RATE = 8.5;

/** DriveVR6-style grab + motion haptics (Quest Touch pulse). */
const HAPTIC_GRAB_INTENSITY = 0.22;
const HAPTIC_GRAB_MS = 35;
/** |Δaxis|/s — axis is −1..1 stick/lever command. */
const HAPTIC_MOVE_MIN_RATE = 0.35;
const HAPTIC_MOVE_MAX_RATE = 6.0;
const HAPTIC_MOVE_MIN_I = 0.05;
const HAPTIC_MOVE_MAX_I = 0.5;

let cockpitRoot = null;
let cockpitScene = null;
let steerWrap = null;
let thrustWrap = null;
let steerRestQuat = null;
let thrustRestQuat = null;
let seatLocal = { x: 0, y: 1.05, z: 0.15 };
let active = false;
let cabinSize = { x: 0, y: 0, z: 0 };
/** @type {{ hand: string, nX: number, nY: number, nZ: number } | null} */
let joyGrab = null;
/** @type {{ hand: string, nX: number, nY: number, nZ: number } | null} */
let thrGrab = null;
let joyReleaseHoldMs = 0;
let thrReleaseHoldMs = 0;
let lastAxes = { yaw: 0, thrust: 0, fromGrip: false };
let prevYawCmd = 0;
let prevThrustCmd = 0;
let lastHapticFrameMs = 0;
/** Flatscreen stick tip target from mouse yaw (phys uses yawDelta; visual needs this). */
let desktopSteerTarget = 0;
/** Smoothed mesh axes (−1…1) — never snap stick/lever poses. */
let visualSteerSmoothed = 0;
let visualAimSmoothed = 0;
let visualThrustSmoothed = 0;
let lastVisualMs = 0;
/** Per-hand Mixamo attach while gripping stick/lever (world pose). */
let handAttach = { left: null, right: null };

function isXrPresenting() {
  try {
    const xr = document.querySelector('a-scene')?.renderer?.xr;
    return !!(xr && xr.isPresenting);
  } catch (_) {
    return false;
  }
}

const gripState = { left: null, right: null };

/**
 * VR gripcal (Quest, 0.1.82 dumps) — live Mixamo wrist vs control AABB center.
 * Stick sample t≈121785; lever from same press.
 */
const LEVER_GRIP_CURLS = {
  thumb: 0,
  index: 0.555,
  middle: 1.0,
  ring: 1.0,
  pinky: 1.0,
};

/** Right stick: thumb on hat; index near trigger; others wrap shaft. */
const STICK_GRIP_CURLS_IDLE = {
  thumb: 0.791,
  index: 0.365,
  middle: 0.882,
  ring: 0.922,
  pinky: 0.962,
};
const STICK_GRIP_CURLS_FIRE = {
  thumb: 0.79,
  index: 0.95,
  middle: 0.9,
  ring: 0.92,
  pinky: 0.96,
};

function clamp01(t) {
  return Math.max(0, Math.min(1, t));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Meta Quest Touch — GamepadHapticActuator pulse (same path as DriveVR6 / RTS). */
function pulseControllerHaptic(handedness, intensity, durationMs) {
  if (typeof globalThis.__rtsVrTryControllerPulse === 'function') {
    globalThis.__rtsVrTryControllerPulse(handedness, intensity, durationMs);
    return;
  }
  try {
    const scene = document.querySelector('a-scene');
    const xr = scene?.renderer?.xr;
    if (!xr?.isPresenting) return;
    const session = xr.getSession?.();
    if (!session?.inputSources) return;
    const want = handedness === 'left' ? 'left' : 'right';
    const mag = clamp01(intensity || 0);
    const dur = durationMs > 0 ? durationMs : 20;
    for (let i = 0; i < session.inputSources.length; i++) {
      const src = session.inputSources[i];
      if (!src || src.handedness !== want) continue;
      const actuators = src.gamepad?.hapticActuators;
      if (!actuators?.length) continue;
      try {
        actuators[0].pulse(mag, dur);
      } catch (_) {
        /* unsupported */
      }
      return;
    }
  } catch (_) {
    /* no XR */
  }
}

function hapticGrabStart(hand) {
  if (!hand) return;
  pulseControllerHaptic(hand, HAPTIC_GRAB_INTENSITY, HAPTIC_GRAB_MS);
}

/** Buzz while the grabbed control is being moved (DriveVR wheel-rotation analogue). */
function hapticControlMotion(hand, axisRate) {
  if (!hand || !(axisRate >= HAPTIC_MOVE_MIN_RATE)) return;
  const t = clamp01(
    (axisRate - HAPTIC_MOVE_MIN_RATE) / (HAPTIC_MOVE_MAX_RATE - HAPTIC_MOVE_MIN_RATE)
  );
  const intensity = lerp(HAPTIC_MOVE_MIN_I, HAPTIC_MOVE_MAX_I, t);
  const duration = Math.round(lerp(12, 28, intensity));
  pulseControllerHaptic(hand, intensity, duration);
}

export function isCockpitActive() {
  return active;
}

export function getCabinSize() {
  return { ...cabinSize };
}

export function getSeatLocal() {
  return { ...seatLocal };
}

export function getCockpitControlDebug() {
  return {
    ...lastAxes,
    grabJoy: joyGrab?.hand || null,
    grabThrust: thrGrab?.hand || null,
    hasSteering: !!steerWrap,
    hasThrottle: !!thrustWrap,
  };
}

/** Hand currently gripping the thrust lever (`'left'|'right'`), or null. */
export function getThrustGrabHand() {
  return thrGrab?.hand || null;
}

/**
 * World pose for securing the Mixamo hand to a held control.
 * @returns {{ x,y,z, qx,qy,qz,qw, kind: string, curls: object } | null}
 */
export function getHandAttachPose(hand) {
  return handAttach[hand] || null;
}

function clearHandAttach() {
  handAttach.left = null;
  handAttach.right = null;
  window.__BATTLEVR2_COCKPIT_HAND_ATTACH__ = { left: null, right: null };
}

/** World-space AABB center of a control wrap (follows deflection). */
function controlGripCenter(wrap) {
  const THREE = window.THREE;
  wrap.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(wrap);
  if (box.isEmpty()) {
    const p = new THREE.Vector3();
    wrap.getWorldPosition(p);
    return p;
  }
  return box.getCenter(new THREE.Vector3());
}

function pilotBasis(yawRad) {
  const THREE = window.THREE;
  const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawRad || 0);
  return {
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(yawQ),
    up: new THREE.Vector3(0, 1, 0),
    fwd: new THREE.Vector3(0, 0, -1).applyQuaternion(yawQ),
    yawQ,
  };
}

/**
 * Mixamo T-pose hands are palm-down at identity. Build pilot-relative grip quats
 * from that convention (NOT wrap.quaternion — Sketchfab rest axes lie).
 * Euler order YXZ: yaw (pilot), then pitch (fingers up/down), then roll (palm).
 */
function mixamoGripQuat(yawRad, pitch, roll) {
  const THREE = window.THREE;
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(pitch, yawRad, roll, 'YXZ')
  );
}

function stickFirePressed() {
  if (window.__BATTLEVR2_FIGHTER_FIRE__) return true;
  try {
    if (!isXrPresenting() && window.__BATTLEVR2_MOUSE_FIRE__) return true;
  } catch (_) { /* */ }
  if (isXrPresenting()) {
    const joy = window.__BATTLEVR2_COCKPIT_JOY_HAND__;
    const sample = window.__BATTLEVR2_VR_SAMPLE__;
    if (joy && sample) {
      if (joy === 'right' && sample.rightTrigger) return true;
      if (joy === 'left' && sample.leftTrigger) return true;
    }
  }
  return false;
}

/**
 * Snap Mixamo wrist onto the control, rigid to the wrap as it tips.
 *
 * Gripcal authored rest pose in pilot space (offsets from AABB center + local
 * euler). Each frame we:
 *   1) Recover the rest AABB center from the live wrap (pivot fixed; only quat tips)
 *   2) Build rest grip pos/quat in pilot space
 *   3) Express that grip relative to rest-wrap, then apply live wrap world quat
 * so the hand rolls with the stick and pitches with the lever — not pilot-yaw only.
 */
function buildHandAttach(hand, wrap, kind) {
  if (!hand || !wrap || !window.THREE) return null;
  const THREE = window.THREE;
  const restLocalQ = kind === 'stick' ? steerRestQuat : thrustRestQuat;
  if (!restLocalQ) return null;

  const yaw = Vehicle.getVehiclePose()?.yaw || 0;
  const { right, up, fwd, yawQ } = pilotBasis(yaw);

  let alongRight;
  let alongUp;
  let alongFwd;
  let gripLocalQ;
  let curls;
  if (kind === 'lever') {
    alongRight = -0.017;
    alongUp = 0.069;
    alongFwd = -0.106;
    gripLocalQ = mixamoGripQuat(0.253, 1.552, -2.755);
    curls = { ...LEVER_GRIP_CURLS };
  } else {
    alongRight = 0.033;
    alongUp = 0.049;
    alongFwd = -0.119;
    gripLocalQ = mixamoGripQuat(-1.488, -0.072, 1.651);
    curls = stickFirePressed() ? { ...STICK_GRIP_CURLS_FIRE } : { ...STICK_GRIP_CURLS_IDLE };
  }

  wrap.updateWorldMatrix(true, true);
  const wrapPos = new THREE.Vector3();
  const wrapQuat = new THREE.Quaternion();
  wrap.getWorldPosition(wrapPos);
  wrap.getWorldQuaternion(wrapQuat);

  const parent = wrap.parent;
  if (parent) parent.updateWorldMatrix(true, false);
  const parentQ = new THREE.Quaternion();
  if (parent) parent.getWorldQuaternion(parentQ);
  else parentQ.identity();
  const restWrapQ = parentQ.clone().multiply(restLocalQ);

  // Live AABB center → wrap-local → rest world center (pivot shares wrapPos).
  const liveCenter = controlGripCenter(wrap);
  const centerLocal = liveCenter.clone().sub(wrapPos).applyQuaternion(wrapQuat.clone().invert());
  const restCenter = wrapPos.clone().add(centerLocal.clone().applyQuaternion(restWrapQ));

  const restGripPos = restCenter
    .clone()
    .addScaledVector(right, alongRight)
    .addScaledVector(up, alongUp)
    .addScaledVector(fwd, alongFwd);
  const restGripQ = yawQ.clone().multiply(gripLocalQ);

  // Rigid body: same offset/orient relative to wrap as at rest.
  const offLocal = restGripPos.clone().sub(wrapPos).applyQuaternion(restWrapQ.clone().invert());
  const pos = wrapPos.clone().add(offLocal.clone().applyQuaternion(wrapQuat));
  const relQ = restWrapQ.clone().invert().multiply(restGripQ);
  const quat = wrapQuat.clone().multiply(relQ);

  return {
    x: pos.x,
    y: pos.y,
    z: pos.z,
    qx: quat.x,
    qy: quat.y,
    qz: quat.z,
    qw: quat.w,
    kind,
    curls,
    /** mixamo-body: final bone world + hard-snap after finger curls. */
    mixamoWorld: true,
  };
}

/** Move #leftHand/#rightHand to grip points so Mixamo IK + debug share one pose. */
function syncDesktopHandEntities(leftPose, rightPose) {
  if (isXrPresenting() || !window.THREE) return;
  const THREE = window.THREE;
  const place = (id, pose) => {
    if (!pose || !Number.isFinite(pose.x)) return;
    const el = document.getElementById(id);
    if (!el?.object3D || !el.object3D.parent) return;
    const parent = el.object3D.parent;
    parent.updateWorldMatrix(true, false);
    const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
    const world = new THREE.Vector3(pose.x, pose.y, pose.z);
    const local = world.applyMatrix4(inv);
    el.object3D.position.copy(local);
    if (Number.isFinite(pose.qw)) {
      const wq = new THREE.Quaternion(pose.qx, pose.qy, pose.qz, pose.qw);
      const pq = new THREE.Quaternion();
      parent.getWorldQuaternion(pq);
      el.object3D.quaternion.copy(pq.clone().invert().multiply(wq));
    }
    el.object3D.updateMatrixWorld(true);
  };
  place('leftHand', leftPose);
  place('rightHand', rightPose);
}

/**
 * Rebuild Mixamo wrist attach from live control wraps.
 * MUST run after the final syncCockpitToVehicle of the frame (post stepVehicle) —
 * publishing before the step leaves world attach one frame behind the cabin (CapVR
 * grab-tether lesson: rigid same-frame weld, no spring/lag).
 */
export function refreshHandAttachPoses() {
  handAttach.left = null;
  handAttach.right = null;
  if (!active) {
    clearHandAttach();
    return;
  }
  // #gripcal: never snap — free VR hands for authoring dumps.
  if (isGripCalEnabled() && isXrPresenting()) {
    window.__BATTLEVR2_COCKPIT_HAND_ATTACH__ = { left: null, right: null };
    return;
  }
  // Desktop boarded: pin Mixamo wrists to stick/lever (no tracked controllers).
  // VR boarded: ONLY pin while gripping — right→stick, left→lever only.
  if (window.__BATTLEVR2_BOARDED__ && !isXrPresenting()) {
    handAttach.right = buildHandAttach('right', steerWrap, 'stick');
    handAttach.left = buildHandAttach('left', thrustWrap, 'lever');
    syncDesktopHandEntities(handAttach.left, handAttach.right);
  } else {
    // Hard affinity: never put left on stick or right on lever.
    if (joyGrab?.hand === 'right') {
      handAttach.right = buildHandAttach('right', steerWrap, 'stick');
    }
    if (thrGrab?.hand === 'left') {
      handAttach.left = buildHandAttach('left', thrustWrap, 'lever');
    }
  }
  window.__BATTLEVR2_COCKPIT_HAND_ATTACH__ = {
    left: handAttach.left,
    right: handAttach.right,
  };
}

function fitCockpit(root) {
  const THREE = window.THREE;
  root.updateWorldMatrix(true, true);
  let box = new THREE.Box3().setFromObject(root);
  const size0 = new THREE.Vector3();
  box.getSize(size0);

  const h = Math.max(size0.y, 0.01);
  const len = Math.max(size0.z, size0.x, 0.01);
  let s = TARGET_HEIGHT_M / h;
  const lenAfter = len * s;
  if (lenAfter < 2.4) s *= 2.4 / lenAfter;
  else if (lenAfter > 4.5) s *= 4.5 / lenAfter;

  root.scale.multiplyScalar(s);
  root.updateWorldMatrix(true, true);

  box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  cabinSize = { x: size.x, y: size.y, z: size.z };

  root.position.x -= center.x;
  root.position.y -= box.min.y;
  root.position.z -= center.z;
  root.updateWorldMatrix(true, true);

  box = new THREE.Box3().setFromObject(root);
  box.getSize(size);
  seatLocal = {
    x: 0,
    y: Math.max(0.9, Math.min(1.25, size.y * 0.55)),
    z: size.z * 0.06,
  };
}

function findNamed(root, re) {
  let found = null;
  root.traverse((o) => {
    if (found || !o.name) return;
    if (re.test(o.name)) found = o;
  });
  return found;
}

/**
 * Pivot AT the control (not cabin origin). Authored TRS moves onto the wrap;
 * mesh sits at local identity so deflections rotate around the stick/lever base.
 */
function wrapPivot(obj, name) {
  const THREE = window.THREE;
  if (!obj?.parent) return null;
  obj.updateMatrix();
  obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
  obj.matrixAutoUpdate = true;

  const wrap = new THREE.Group();
  wrap.name = name;
  wrap.matrixAutoUpdate = true;
  wrap.position.copy(obj.position);
  wrap.quaternion.copy(obj.quaternion);
  wrap.scale.copy(obj.scale);

  const parent = obj.parent;
  parent.add(wrap);
  wrap.add(obj);
  obj.position.set(0, 0, 0);
  obj.quaternion.identity();
  obj.scale.set(1, 1, 1);
  return wrap;
}

function bindControlMeshes(root) {
  const THREE = window.THREE;
  const steerSrc = findNamed(root, /^steering$/i) || findNamed(root, /steering|joystick|stick/i);
  const thrSrc = findNamed(root, /^throttle$/i) || findNamed(root, /throttle|thrust|lever/i);

  if (steerSrc) {
    steerWrap = wrapPivot(steerSrc, 'steer-wrap');
  } else {
    steerWrap = makeProxy(THREE, 'cockpit-joystick', 0.2, seatLocal.y - 0.3, seatLocal.z - 0.5, 0x88ffaa);
    cockpitRoot.object3D.add(steerWrap);
  }
  if (thrSrc) {
    thrustWrap = wrapPivot(thrSrc, 'thrust-wrap');
  } else {
    thrustWrap = makeProxy(THREE, 'cockpit-thrust', -0.28, seatLocal.y - 0.3, seatLocal.z - 0.45, 0xffaa66);
    cockpitRoot.object3D.add(thrustWrap);
  }

  // Rest = whatever attach left on the wrap (usually identity; mesh holds authored pose)
  steerRestQuat = steerWrap.quaternion.clone();
  thrustRestQuat = thrustWrap.quaternion.clone();

  console.log('[BattleVR2] cockpit controls bound at authored rest', {
    steer: steerWrap.name,
    thrust: thrustWrap.name,
  });
}

function setTreeVisible(obj, on) {
  if (!obj) return;
  obj.visible = !!on;
  obj.traverse((c) => {
    c.visible = !!on;
  });
}

export async function initCockpit(sceneEl) {
  const { ensureThreeGltfLoaders } = await import('./rts/three-gltf-umd.js');
  await ensureThreeGltfLoaders();

  cockpitRoot = document.createElement('a-entity');
  cockpitRoot.id = 'player-cockpit';
  cockpitRoot.setAttribute('visible', 'false');
  sceneEl.appendChild(cockpitRoot);

  return new Promise((resolve, reject) => {
    const loader = new window.THREE.GLTFLoader();
    loader.load(
      COCKPIT_URL,
      (gltf) => {
        cockpitScene = gltf.scene;
        cockpitScene.name = 'wasp_cockpit';
        fitCockpit(cockpitScene);
        cockpitRoot.object3D.add(cockpitScene);
        bindControlMeshes(cockpitScene);
        setTreeVisible(cockpitRoot.object3D, false);
        active = false;
        window.__BATTLEVR2_COCKPIT__ = {
          root: cockpitRoot,
          scene: cockpitScene,
          getSeatLocal,
          getCabinSize,
          getSeatWorldPosition,
          getCockpitControlDebug,
          getHandAttachPose,
          getThrustGrabHand,
        };
        resolve(cockpitRoot);
      },
      undefined,
      reject
    );
  });
}

function makeProxy(THREE, name, x, y, z, color) {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(x, y, z);
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.045, 0.28, 10),
    new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3 })
  );
  mesh.position.y = 0.14;
  g.add(mesh);
  return g;
}

/** Drop stick/throttle grabs so RTS laser + triggers work again (game-over / exit). */
export function releaseControlGrabs() {
  joyGrab = null;
  thrGrab = null;
  joyReleaseHoldMs = 0;
  thrReleaseHoldMs = 0;
  lastAxes = { yaw: 0, thrust: 0, fromGrip: false };
  prevYawCmd = 0;
  prevThrustCmd = 0;
  clearHandAttach();
  for (const hand of ['left', 'right']) {
    if (gripState[hand]) gripState[hand].gripping = false;
  }
  window.__BATTLEVR2_COCKPIT_JOY_HAND__ = null;
  Vehicle.setVehicleControls({ yaw: 0, thrust: 0, pitch: 0, boost: false });
  resetVisuals();
}

export function showCockpit(on) {
  active = !!on;
  if (cockpitRoot) {
    cockpitRoot.setAttribute('visible', active ? 'true' : 'false');
    setTreeVisible(cockpitRoot.object3D, active);
  }
  if (active) {
    Vehicle.setExteriorVisible(false);
    syncCockpitToVehicle();
    resetVisuals();
  } else {
    Vehicle.setExteriorVisible(true);
    releaseControlGrabs();
  }
}

export function hideCockpitHard() {
  active = false;
  releaseControlGrabs();
  if (cockpitRoot) {
    cockpitRoot.setAttribute('visible', 'false');
    setTreeVisible(cockpitRoot.object3D, false);
    cockpitRoot.object3D.position.set(0, -500, 0);
  }
  Vehicle.setExteriorVisible(true);
}

function resetVisuals() {
  visualSteerSmoothed = 0;
  visualThrustSmoothed = 0;
  desktopSteerTarget = 0;
  lastVisualMs = 0;
  if (steerWrap && steerRestQuat) {
    steerWrap.quaternion.copy(steerRestQuat);
  }
  if (thrustWrap && thrustRestQuat) {
    thrustWrap.quaternion.copy(thrustRestQuat);
  }
}

/** Exp-smooth axis toward target; returns-to-center a bit softer for a spring feel. */
function smoothVisualAxis(current, target, dt) {
  const towardCenter = Math.abs(target) < Math.abs(current) - 0.02;
  const rate = towardCenter ? VISUAL_RETURN_RATE : VISUAL_SMOOTH_RATE;
  const k = 1 - Math.exp(-rate * Math.max(0, dt));
  let next = current + (target - current) * k;
  if (Math.abs(next) < VISUAL_EPS && Math.abs(target) < VISUAL_EPS) next = 0;
  return next;
}

export function syncCockpitToVehicle() {
  if (!cockpitRoot || !active) return;
  const p = Vehicle.getVehiclePose();
  cockpitRoot.object3D.position.set(p.x, p.y, p.z);
  cockpitRoot.object3D.rotation.set(0, p.yaw + COCKPIT_YAW_BIAS, 0);
}

export function getSeatWorldPosition() {
  const p = Vehicle.getVehiclePose();
  // Seat offset is in cockpit-mesh space (mesh yaw = pose + bias).
  // Returned yaw is LOOK direction (bare pose.yaw) — camera must face the canopy.
  const meshYaw = p.yaw + COCKPIT_YAW_BIAS;
  const cos = Math.cos(meshYaw);
  const sin = Math.sin(meshYaw);
  return {
    x: p.x + seatLocal.x * cos + seatLocal.z * sin,
    y: p.y + seatLocal.y,
    z: p.z + -seatLocal.x * sin + seatLocal.z * cos,
    yaw: p.yaw,
  };
}

export function setHandWorldPos(hand, x, y, z, gripping) {
  gripState[hand] = { x, y, z, gripping: !!gripping };
}

function worldPos(obj) {
  if (!obj) return { x: 0, y: 0, z: 0 };
  const v = new window.THREE.Vector3();
  obj.getWorldPosition(v);
  return { x: v.x, y: v.y, z: v.z };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function handAxis(v, range) {
  if (Math.abs(v) < HAND_DEADZONE) return 0;
  return Math.max(-1, Math.min(1, v / range));
}

/** Aim pitch: no hard deadzone — a zero band near grab-Z snapped gun pitch to center. */
function handAimAxis(v, range) {
  return Math.max(-1, Math.min(1, v / Math.max(range, 1e-6)));
}

function stickAxis01(v, deadzone = 0.18) {
  const a = Math.abs(v || 0);
  if (a <= deadzone) return 0;
  const sign = v < 0 ? -1 : 1;
  return sign * (a - deadzone) / (1 - deadzone);
}

/**
 * Hands in cockpit-local space (ChaseVR heli-local).
 * Cockpit mesh yaw = pose+π ⇒ pilot canopy = +Z local, pilot right = −X local.
 * World-space neutrals shook the seat: vehicle motion invalidated the grab delta every frame.
 */
function handInCockpit(h) {
  if (!h || !cockpitRoot?.object3D) return null;
  const THREE = window.THREE;
  const v = new THREE.Vector3(h.x, h.y, h.z);
  cockpitRoot.object3D.updateWorldMatrix(true, false);
  cockpitRoot.object3D.worldToLocal(v);
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * ChaseVR-style grab: grip+near to start; hold while squeeze; grip-up → null
 * after {@link GRAB_RELEASE_HOLD_MS} (hysteresis so flicker does not recenter aim).
 * Neutral is cockpit-local so travel while hovering does not invert/spike axes.
 * @param {'left'|'right'} allowedHand — stick = right only, lever = left only.
 * @param {{ ms: number }} releaseHold — per-control release timer (mutated).
 * @param {number} dtMs
 */
function resolveGrab(prev, target, allowedHand, releaseHold, dtMs) {
  if (!target || !allowedHand) return null;
  if (prev) {
    if (prev.hand !== allowedHand) {
      releaseHold.ms = 0;
      return null;
    }
    const h = gripState[prev.hand];
    if (h?.gripping) {
      releaseHold.ms = 0;
      return prev;
    }
    releaseHold.ms += Math.max(0, dtMs || 0);
    if (releaseHold.ms < GRAB_RELEASE_HOLD_MS) return prev;
    releaseHold.ms = 0;
    return null;
  }
  releaseHold.ms = 0;
  const h = gripState[allowedHand];
  if (!h?.gripping) return null;
  const d = dist(h, worldPos(target));
  if (d > GRAB_RADIUS) return null;
  const loc = handInCockpit(h);
  if (!loc) return null;
  return { hand: allowedHand, nX: loc.x, nY: loc.y, nZ: loc.z };
}

/** `#gripcal` or `window.__BATTLEVR2_GRIP_CAL__=true` — no snap; A dumps live offsets. */
export function isGripCalEnabled() {
  try {
    if (window.__BATTLEVR2_GRIP_CAL__) return true;
    const q = `${location.search || ''}${location.hash || ''}`;
    return /(?:[?#&]|^)gripcal(?:[=&#]|$)/i.test(q);
  } catch (_) {
    return !!window.__BATTLEVR2_GRIP_CAL__;
  }
}

/**
 * Dump live Mixamo wrist vs stick/lever for authoring buildHandAttach offsets.
 * Call from VR A-button while `#gripcal` (snapping off).
 */
export function dumpGripCalibration(which = 'both') {
  if (!window.THREE || !active) {
    console.warn('[BattleVR2 gripcal] cockpit inactive');
    return null;
  }
  const THREE = window.THREE;
  const yaw = Vehicle.getVehiclePose()?.yaw || 0;
  const { right, up, fwd, yawQ } = pilotBasis(yaw);
  const mb = document.getElementById('local-body')?.components?.['mixamo-body'];
  const bones = mb?.bones || {};

  const sampleHand = (hand, wrap, kind) => {
    if (!wrap) return { hand, kind, error: 'no-wrap' };
    const bone =
      hand === 'right'
        ? bones.rightHandBone || bones.rightHand
        : bones.leftHandBone || bones.leftHand;
    if (!bone) return { hand, kind, error: 'no-bone' };
    bone.updateWorldMatrix(true, false);
    const handW = new THREE.Vector3();
    const handQ = new THREE.Quaternion();
    bone.getWorldPosition(handW);
    bone.getWorldQuaternion(handQ);
    const center = controlGripCenter(wrap);
    const delta = handW.clone().sub(center);
    const alongRight = delta.dot(right);
    const alongUp = delta.dot(up);
    const alongFwd = delta.dot(fwd);
    // Pilot-local grip quat (same space as mixamoGripQuat / buildHandAttach).
    const localQ = yawQ.clone().invert().multiply(handQ);
    const e = new THREE.Euler().setFromQuaternion(localQ, 'YXZ');
    const curlsSrc = mb?.currentCurls?.[hand] || null;
    const curls = curlsSrc
      ? {
          thumb: +Number(curlsSrc.thumb || 0).toFixed(3),
          index: +Number(curlsSrc.index || 0).toFixed(3),
          middle: +Number(curlsSrc.middle || 0).toFixed(3),
          ring: +Number(curlsSrc.ring || 0).toFixed(3),
          pinky: +Number(curlsSrc.pinky || 0).toFixed(3),
        }
      : null;
    const snippet =
      kind === 'stick'
        ? [
            `// right stick from VR gripcal`,
            `pos.addScaledVector(right, ${alongRight.toFixed(3)});`,
            `pos.addScaledVector(up, ${alongUp.toFixed(3)});`,
            `pos.addScaledVector(fwd, ${alongFwd.toFixed(3)});`,
            `const localStick = mixamoGripQuat(${e.y.toFixed(3)}, ${e.x.toFixed(3)}, ${e.z.toFixed(3)});`,
            curls ? `curls = ${JSON.stringify(curls)};` : '',
          ]
            .filter(Boolean)
            .join('\n')
        : [
            `// left lever from VR gripcal`,
            `pos.addScaledVector(up, ${alongUp.toFixed(3)});`,
            `pos.addScaledVector(right, ${alongRight.toFixed(3)});`,
            `pos.addScaledVector(fwd, ${alongFwd.toFixed(3)});`,
            `// localEuler YXZ yaw=${e.y.toFixed(3)} pitch=${e.x.toFixed(3)} roll=${e.z.toFixed(3)}`,
            `// (lever still applies +90° Z * localStick in code — compare carefully)`,
            curls ? `curls = ${JSON.stringify(curls)};` : '',
          ]
            .filter(Boolean)
            .join('\n');
    return {
      hand,
      kind,
      alongRight: +alongRight.toFixed(4),
      alongUp: +alongUp.toFixed(4),
      alongFwd: +alongFwd.toFixed(4),
      localEulerYXZ: {
        yaw: +e.y.toFixed(4),
        pitch: +e.x.toFixed(4),
        roll: +e.z.toFixed(4),
      },
      localQuat: {
        x: +localQ.x.toFixed(5),
        y: +localQ.y.toFixed(5),
        z: +localQ.z.toFixed(5),
        w: +localQ.w.toFixed(5),
      },
      curls,
      snippet,
    };
  };

  const out = {
    t: performance.now(),
    gripcal: isGripCalEnabled(),
    rightStick: sampleHand('right', steerWrap, 'stick'),
    leftLever: sampleHand('left', thrustWrap, 'lever'),
  };
  if (which === 'right') delete out.leftLever;
  if (which === 'left') delete out.rightStick;
  window.__BATTLEVR2_LAST_GRIPCAL__ = out;
  console.log('[BattleVR2 gripcal] paste offsets into cockpit.js buildHandAttach:\n', out);
  if (out.rightStick?.snippet) console.log(out.rightStick.snippet);
  if (out.leftLever?.snippet) console.log(out.leftLever.snippet);
  return out;
}

function applySteerVisual(yawCmd, aimCmd = 0) {
  if (!steerWrap || !steerRestQuat) return;
  const THREE = window.THREE;
  if (Math.abs(yawCmd) < VISUAL_EPS && Math.abs(aimCmd) < VISUAL_EPS) {
    steerWrap.quaternion.copy(steerRestQuat);
    return;
  }
  // Rest is −90° X (Sketchfab). Local Y = roll L/R (yaw); local X = tip fwd/back (gun aim).
  // yawCmd < 0 = tip stick right. aimCmd < 0 = push toward canopy = tip forward = aim down.
  const delta = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-aimCmd * STICK_AIM_TILT_ANGLE, yawCmd * STICK_ROLL_ANGLE, 0, 'XYZ')
  );
  steerWrap.quaternion.copy(steerRestQuat).multiply(delta);
}

function applyThrustVisual(thrustAxis) {
  if (!thrustWrap || !thrustRestQuat) return;
  const THREE = window.THREE;
  if (Math.abs(thrustAxis) < VISUAL_EPS) {
    thrustWrap.quaternion.copy(thrustRestQuat);
    return;
  }
  const delta = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(thrustAxis * LEVER_PITCH_ANGLE, 0, 0, 'XYZ')
  );
  thrustWrap.quaternion.copy(thrustRestQuat).multiply(delta);
}

export function updateCockpitControls() {
  if (!active) {
    Vehicle.setVehicleControls({ yaw: 0, thrust: 0, pitch: 0, boost: false });
    lastAxes = { yaw: 0, thrust: 0, fromGrip: false };
    joyGrab = null;
    thrGrab = null;
    joyReleaseHoldMs = 0;
    thrReleaseHoldMs = 0;
    prevYawCmd = 0;
    prevThrustCmd = 0;
    desktopSteerTarget = 0;
    visualSteerSmoothed = 0;
    visualAimSmoothed = 0;
    visualThrustSmoothed = 0;
    lastVisualMs = 0;
    window.__BATTLEVR2_STICK_AIM_PITCH__ = 0;
    clearHandAttach();
    window.__BATTLEVR2_COCKPIT_JOY_HAND__ = null;
    return lastAxes;
  }
  syncCockpitToVehicle();

  const nowVis = performance.now();
  const visualDt =
    lastVisualMs > 0 ? Math.min(0.05, Math.max(0.001, (nowVis - lastVisualMs) / 1000)) : 1 / 60;
  lastVisualMs = nowVis;

  const hadJoy = !!joyGrab;
  const hadThr = !!thrGrab;
  const prevJoyHand = joyGrab?.hand || null;
  const prevThrHand = thrGrab?.hand || null;

  const joyRelease = { ms: joyReleaseHoldMs };
  const thrRelease = { ms: thrReleaseHoldMs };
  const dtMsVis = visualDt * 1000;
  if (isGripCalEnabled() && isXrPresenting()) {
    // Calibration: no grabs / no snaps — free tracked hands.
    joyGrab = null;
    thrGrab = null;
    joyRelease.ms = 0;
    thrRelease.ms = 0;
  } else {
    // Right hand ↔ stick only; left hand ↔ lever only.
    joyGrab = resolveGrab(joyGrab, steerWrap, 'right', joyRelease, dtMsVis);
    thrGrab = resolveGrab(thrGrab, thrustWrap, 'left', thrRelease, dtMsVis);
  }
  joyReleaseHoldMs = joyRelease.ms;
  thrReleaseHoldMs = thrRelease.ms;

  // Grab-start click (DriveVR steering wheel acquire).
  if (joyGrab && (!hadJoy || joyGrab.hand !== prevJoyHand)) {
    hapticGrabStart(joyGrab.hand);
  }
  if (thrGrab && (!hadThr || thrGrab.hand !== prevThrHand)) {
    hapticGrabStart(thrGrab.hand);
  }

  let yaw = 0;
  /** −1…1 virtual-stick fwd/back → gun aim (neg = toward canopy = aim down). */
  let aimAxis = 0;
  let thrust = 0;
  let fromGrip = false;
  let joyFromGrip = false;
  let thrFromGrip = false;
  /** True while squeeze is held (not release-grace). */
  let joySqueezing = false;
  let thrSqueezing = false;

  if (joyGrab && gripState[joyGrab.hand]?.gripping) {
    const loc = handInCockpit(gripState[joyGrab.hand]);
    if (loc) {
      fromGrip = true;
      joyFromGrip = true;
      joySqueezing = true;
      // Pilot right = −X local; hand to the right → turn right → negative yaw cmd
      const latPilot = -(loc.x - joyGrab.nX);
      yaw = -handAxis(latPilot, HAND_YAW_RANGE);
      // Canopy = +Z local — push stick toward canopy = aim down.
      // Continuous (no deadzone): a zero band near grab-Z snapped aim to center.
      const towardCanopy = loc.z - joyGrab.nZ;
      aimAxis = -handAimAxis(towardCanopy, HAND_AIM_RANGE);
    }
  } else if (joyGrab) {
    // Release grace: keep last aim (do not spring to center on grip flicker).
    fromGrip = true;
    joyFromGrip = true;
    aimAxis = visualAimSmoothed;
  }

  if (thrGrab && gripState[thrGrab.hand]?.gripping) {
    const loc = handInCockpit(gripState[thrGrab.hand]);
    if (loc) {
      fromGrip = true;
      thrFromGrip = true;
      thrSqueezing = true;
      // Canopy = +Z local — lever angle maps proportionally to thrust
      const along = loc.z - thrGrab.nZ;
      thrust = handAxis(along, HAND_THRUST_RANGE);
    }
  } else if (thrGrab) {
    fromGrip = true;
    thrFromGrip = true;
  }

  const now = performance.now();
  const dt = lastHapticFrameMs > 0 ? Math.max(0.001, (now - lastHapticFrameMs) / 1000) : 1 / 60;
  lastHapticFrameMs = now;

  // Motion buzz while deflecting stick / sliding lever (same feel as rotating DriveVR wheel).
  if (joySqueezing && joyGrab) {
    hapticControlMotion(joyGrab.hand, Math.abs(yaw - prevYawCmd) / dt);
  }
  if (thrSqueezing && thrGrab) {
    hapticControlMotion(thrGrab.hand, Math.abs(thrust - prevThrustCmd) / dt);
  }
  prevYawCmd = joySqueezing ? yaw : 0;
  prevThrustCmd = thrSqueezing ? thrust : 0;

  const d = window.__BATTLEVR2_DESKTOP_VEHICLE__;
  let strafe = 0;
  let yawDelta = 0;
  if (d) {
    if (!joyGrab && d.yaw != null) yaw = d.yaw;
    if (!thrGrab && d.thrust != null) thrust = d.thrust;
    if (d.strafe != null) strafe = d.strafe;
    if (d.yawDelta != null) yawDelta = d.yawDelta;
  }

  // VR: thumbstick X on the hand holding the thrust lever → strafe (overrides PC A/D while held).
  if (thrGrab?.hand) {
    const sticks = window.__BATTLEVR2_STICK__;
    if (sticks) {
      const sx = thrGrab.hand === 'left' ? sticks.leftX : sticks.rightX;
      const stickStrafe = stickAxis01(sx);
      if (Math.abs(stickStrafe) > 0.02) strafe = stickStrafe;
    }
  }

  // Stick mesh target: VR uses grip yaw. Flatscreen mouse turns via yawDelta (not yaw).
  // Sign MUST match applySteerVisual + phys: yawCmd < 0 = tip right = turn right.
  // input-fp: yawDelta = -look.dx * sens → mouse-right ⇒ yawDelta < 0 ⇒ tip < 0.
  let steerTarget = yaw;
  if (d && !joyFromGrip) {
    if (Math.abs(d.yaw || 0) > 0.02) {
      desktopSteerTarget = d.yaw;
    } else {
      // Mouse tip: hold deflection while turning, ease back when look stops.
      const tip = Math.max(-1, Math.min(1, (d.yawDelta || 0) / 0.035));
      if (Math.abs(tip) > 0.04) {
        desktopSteerTarget += (tip - desktopSteerTarget) * 0.55;
      } else {
        desktopSteerTarget *= 0.82;
      }
      if (Math.abs(desktopSteerTarget) < 0.02) desktopSteerTarget = 0;
    }
    steerTarget = desktopSteerTarget;
  } else if (!d) {
    desktopSteerTarget = 0;
  }

  // Physics/input stay snappy; only the visible stick/lever spring toward the command.
  visualSteerSmoothed = smoothVisualAxis(visualSteerSmoothed, steerTarget, visualDt);
  // Gun aim: while stick grabbed, track hand Z 1:1 (no deadzone / no center spring).
  // Recenter only after sustained grip release (see GRAB_RELEASE_HOLD_MS).
  if (joyFromGrip) {
    if (joySqueezing) {
      visualAimSmoothed = aimAxis;
    }
    // else release-grace: keep visualAimSmoothed
  } else {
    visualAimSmoothed = smoothVisualAxis(visualAimSmoothed, 0, visualDt);
  }
  visualThrustSmoothed = smoothVisualAxis(visualThrustSmoothed, thrust, visualDt);
  applySteerVisual(visualSteerSmoothed, visualAimSmoothed);
  applyThrustVisual(visualThrustSmoothed);

  const boost = !!(d && d.boost) || !!(window.__BATTLEVR2_VEHICLE_BOOST__);
  if (window.__BATTLEVR2_VEHICLE_BOOST__) window.__BATTLEVR2_VEHICLE_BOOST__ = false;

  // VR gun pitch from virtual stick fwd/back (rad). Desktop combat still uses mouse look.
  const stickAimPitch = visualAimSmoothed * STICK_AIM_PITCH_RAD;
  window.__BATTLEVR2_STICK_AIM_PITCH__ = stickAimPitch;

  Vehicle.setVehicleControls({ yaw, thrust, pitch: 0, strafe, yawDelta, boost });
  lastAxes = {
    yaw,
    thrust,
    aimAxis: visualAimSmoothed,
    stickAimPitch,
    fromGrip,
    boost,
    grabJoy: joyGrab?.hand || null,
    grabThrust: thrGrab?.hand || null,
    steerVis: visualSteerSmoothed,
    thrustVis: visualThrustSmoothed,
  };
  // Desktop: pretend right hand is on the stick so fire/HUD paths stay consistent.
  window.__BATTLEVR2_COCKPIT_JOY_HAND__ =
    joyGrab?.hand || (!isXrPresenting() ? 'right' : null);
  // After visuals move with yaw/thrust, pin Mixamo hands to the deflected grips.
  refreshHandAttachPoses();
  return lastAxes;
}
