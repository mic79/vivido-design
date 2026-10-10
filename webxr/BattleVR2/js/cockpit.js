/**
 * BattleVR2 — cockpit stick + throttle (ChaseVR cyclic-style grab).
 * Grab = grip near control; input = hand delta from grab-start neutral; release = zero.
 * Lever toward canopy = +thrust. Stick right = turn right.
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
const HAND_THRUST_RANGE = 0.14;
const HAND_DEADZONE = 0.01;
const VISUAL_EPS = 0.03;
const STICK_ROLL_ANGLE = 0.55;
const LEVER_PITCH_ANGLE = 0.65;

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
let lastAxes = { yaw: 0, thrust: 0, fromGrip: false };

const gripState = { left: null, right: null };

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
  lastAxes = { yaw: 0, thrust: 0, fromGrip: false };
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
  if (steerWrap && steerRestQuat) {
    steerWrap.quaternion.copy(steerRestQuat);
  }
  if (thrustWrap && thrustRestQuat) {
    thrustWrap.quaternion.copy(thrustRestQuat);
  }
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
 * ChaseVR-style grab: grip+near to start; hold while squeeze; grip-up → null.
 * Neutral is cockpit-local so travel while hovering does not invert/spike axes.
 */
function resolveGrab(prev, target) {
  if (!target) return null;
  if (prev) {
    const h = gripState[prev.hand];
    if (h?.gripping) return prev;
    return null;
  }
  let best = null;
  let bestD = GRAB_RADIUS;
  for (const hand of ['left', 'right']) {
    const h = gripState[hand];
    if (!h?.gripping) continue;
    const d = dist(h, worldPos(target));
    if (d <= bestD) {
      const loc = handInCockpit(h);
      if (!loc) continue;
      bestD = d;
      best = { hand, nX: loc.x, nY: loc.y, nZ: loc.z };
    }
  }
  return best;
}

function applySteerVisual(yawCmd) {
  if (!steerWrap || !steerRestQuat) return;
  const THREE = window.THREE;
  if (Math.abs(yawCmd) < VISUAL_EPS) {
    steerWrap.quaternion.copy(steerRestQuat);
    return;
  }
  // Rest is −90° X (Sketchfab). Local Y after that rolls the upright stick L/R in pilot view
  // (local Z looked like yaw). yawCmd < 0 = turn right → tip stick right.
  const delta = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(0, yawCmd * STICK_ROLL_ANGLE, 0, 'XYZ')
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
    window.__BATTLEVR2_COCKPIT_JOY_HAND__ = null;
    return lastAxes;
  }
  syncCockpitToVehicle();

  joyGrab = resolveGrab(joyGrab, steerWrap);
  thrGrab = resolveGrab(thrGrab, thrustWrap);

  if (joyGrab && thrGrab && joyGrab.hand === thrGrab.hand) {
    const h = gripState[joyGrab.hand];
    const dJoy = dist(h, worldPos(steerWrap));
    const dThr = dist(h, worldPos(thrustWrap));
    if (dJoy <= dThr) thrGrab = null;
    else joyGrab = null;
  }

  let yaw = 0;
  let thrust = 0;
  let fromGrip = false;

  if (joyGrab && gripState[joyGrab.hand]?.gripping) {
    const loc = handInCockpit(gripState[joyGrab.hand]);
    if (loc) {
      fromGrip = true;
      // Pilot right = −X local; hand to the right → turn right → negative yaw cmd
      const latPilot = -(loc.x - joyGrab.nX);
      yaw = -handAxis(latPilot, HAND_YAW_RANGE);
    }
  } else {
    joyGrab = null;
  }

  if (thrGrab && gripState[thrGrab.hand]?.gripping) {
    const loc = handInCockpit(gripState[thrGrab.hand]);
    if (loc) {
      fromGrip = true;
      // Canopy = +Z local — lever angle maps proportionally to thrust
      const along = loc.z - thrGrab.nZ;
      thrust = handAxis(along, HAND_THRUST_RANGE);
    }
  } else {
    thrGrab = null;
  }

  const d = window.__BATTLEVR2_DESKTOP_VEHICLE__;
  let strafe = 0;
  let yawDelta = 0;
  if (d) {
    if (!joyGrab && d.yaw != null) yaw = d.yaw;
    if (!thrGrab && d.thrust != null) thrust = d.thrust;
    if (d.strafe != null) strafe = d.strafe;
    if (d.yawDelta != null) yawDelta = d.yawDelta;
  }

  applySteerVisual(yaw);
  applyThrustVisual(thrust);

  const boost = !!(d && d.boost) || !!(window.__BATTLEVR2_VEHICLE_BOOST__);
  if (window.__BATTLEVR2_VEHICLE_BOOST__) window.__BATTLEVR2_VEHICLE_BOOST__ = false;

  Vehicle.setVehicleControls({ yaw, thrust, pitch: 0, strafe, yawDelta, boost });
  lastAxes = {
    yaw,
    thrust,
    fromGrip,
    boost,
    grabJoy: joyGrab?.hand || null,
    grabThrust: thrGrab?.hand || null,
  };
  window.__BATTLEVR2_COCKPIT_JOY_HAND__ = joyGrab?.hand || null;
  return lastAxes;
}
