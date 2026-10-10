/**
 * Fighter visuals + boarding — IDENTICAL battle-phys integrator as on-foot.
 * Only inputs: lever surge + stick yaw (+ boost). Faster max speed / surge force.
 */
import * as Box3D from './box3d-world.js';
import * as Phys from './battle-phys.js';
import { sampleGroundY } from './rts-bridge.js';

const FIGHTER_URL = 'assets/vehicles/space_fighter.glb';
const TARGET_LENGTH_M = 10;
/** Peak yaw rate at full stick (rad/s). */
const TURN_RATE = (55 * Math.PI) / 180;
/** How quickly yaw rate tracks the stick / coasts to zero (1/s). */
const YAW_RATE_RESPONSIVENESS = 2.4;
const BOOST_COOLDOWN_S = 2.2;

let sceneEl = null;
let vehicleRoot = null;
let exterior = null;
/** Empty Object3D on the GLB `gun barrel` tip — world pos = true muzzle. */
let muzzleAnchor = null;
let boarded = false;
let pose = { x: 0, y: Phys.FLOOR_BAND_VEHICLE, z: 0, yaw: 0 };
/** Velocity while empty — shared battle-phys is the player when not boarded. */
let parkedVel = { x: 0, y: 0, z: 0 };
/** Angular velocity (rad/s) — coasts after stick release. */
let yawRate = 0;
let controls = { yaw: 0, pitch: 0, thrust: 0, strafe: 0, yawDelta: 0, boost: false };
let fitScale = 1;
let boostCooldown = 0;
let slamPitch = 0;
let slamSink = 0;

/** Nudge past the mesh tip so tracers don't spawn inside the barrel. */
const MUZZLE_NUDGE_M = 0.22;

export function isBoarded() {
  return boarded;
}

export function getVehiclePose() {
  return { ...pose };
}

export function getFitScale() {
  return fitScale;
}

export function getVelocity() {
  return Phys.getPhysVelocity();
}

export function setVehicleControls(next) {
  controls = { ...controls, ...next };
}

function fitModelToLength(root, targetLen) {
  const THREE = window.THREE;
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const longest = Math.max(size.x, size.y, size.z) || 1;
  const s = targetLen / longest;
  root.scale.multiplyScalar(s);
  fitScale = (fitScale || 1) * s;
  root.updateWorldMatrix(true, true);
  console.log('[BattleVR2] fighter auto-scale', { longestBefore: longest, scale: s, targetLen });
  const box2 = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  box2.getCenter(center);
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y -= box2.min.y;
}

/**
 * Locate Sketchfab node `gun barrel` and pin an anchor at its forward tip
 * (furthest bbox corner along vehicle forward). Survives exterior pitch tilt.
 */
function setupMuzzleAnchor() {
  const THREE = window.THREE;
  muzzleAnchor = null;
  if (!exterior || !vehicleRoot || !THREE) return;

  const barrel =
    exterior.getObjectByName('gun barrel') ||
    exterior.getObjectByName('gun_barrel') ||
    exterior.getObjectByName('Gun Barrel');
  if (!barrel) {
    console.warn('[BattleVR2] fighter GLB has no "gun barrel" node — using pose fallback muzzle');
    return;
  }

  exterior.updateWorldMatrix(true, true);
  vehicleRoot.object3D.updateWorldMatrix(true, true);

  const box = new THREE.Box3().setFromObject(barrel);
  if (box.isEmpty()) {
    console.warn('[BattleVR2] gun barrel bbox empty');
    return;
  }

  // Vehicle forward in world (yaw-only root; matches combat aim XZ).
  const forward = new THREE.Vector3(0, 0, -1).transformDirection(vehicleRoot.object3D.matrixWorld);
  const center = box.getCenter(new THREE.Vector3());
  const tipWorld = new THREE.Vector3();
  let bestDot = -Infinity;
  const { min, max } = box;
  for (const x of [min.x, max.x]) {
    for (const y of [min.y, max.y]) {
      for (const z of [min.z, max.z]) {
        const p = new THREE.Vector3(x, y, z);
        const dot = p.clone().sub(center).dot(forward);
        if (dot > bestDot) {
          bestDot = dot;
          tipWorld.copy(p);
        }
      }
    }
  }
  tipWorld.addScaledVector(forward, MUZZLE_NUDGE_M);

  const anchor = new THREE.Object3D();
  anchor.name = 'muzzle_anchor';
  barrel.add(anchor);
  barrel.updateWorldMatrix(true, true);
  const tipLocal = tipWorld.clone();
  barrel.worldToLocal(tipLocal);
  anchor.position.copy(tipLocal);
  muzzleAnchor = anchor;

  const localFromRoot = tipWorld.clone();
  vehicleRoot.object3D.worldToLocal(localFromRoot);
  console.log('[BattleVR2] muzzle from gun barrel', {
    tipLocalToRoot: {
      x: +localFromRoot.x.toFixed(3),
      y: +localFromRoot.y.toFixed(3),
      z: +localFromRoot.z.toFixed(3),
    },
  });
}

/**
 * World-space cannon muzzle. Falls back to a nose offset if the GLB node is missing.
 * @returns {{ x: number, y: number, z: number }}
 */
export function getMuzzleWorldPos() {
  if (muzzleAnchor) {
    const THREE = window.THREE;
    const v = new THREE.Vector3();
    muzzleAnchor.updateWorldMatrix(true, false);
    muzzleAnchor.getWorldPosition(v);
    return { x: v.x, y: v.y, z: v.z };
  }
  const fwdX = -Math.sin(pose.yaw);
  const fwdZ = -Math.cos(pose.yaw);
  return {
    x: pose.x + fwdX * 3.2,
    y: pose.y + 0.85,
    z: pose.z + fwdZ * 3.2,
  };
}

function syncPoseFromPhys() {
  const p = Phys.getPhysPose();
  pose.x = p.x;
  pose.y = p.y;
  pose.z = p.z;
  pose.yaw = p.yaw;
}

function syncVisual() {
  if (!vehicleRoot) return;
  const impact = Phys.getLastImpact();
  if (impact > 2.2) {
    slamPitch = Math.min(0.45, impact * 0.06);
    slamSink = Math.min(0.32, impact * 0.045);
  }
  slamPitch *= 0.9;
  slamSink *= 0.88;
  vehicleRoot.object3D.position.set(pose.x, pose.y - slamSink, pose.z);
  vehicleRoot.object3D.rotation.set(0, pose.yaw, 0);
  if (exterior) {
    const v = Phys.getPhysVelocity();
    const thrusting = controls.thrust || 0;
    const air = Phys.isAirborne() ? Math.max(-0.2, Math.min(0.35, -v.y * 0.04)) : 0;
    exterior.rotation.x = Math.max(
      -0.45,
      Math.min(0.45, -thrusting * 0.04 + v.y * 0.01 + air + slamPitch)
    );
  }
}

export async function initVehicle(scene, spawn) {
  sceneEl = scene;
  const { ensureThreeGltfLoaders } = await import('./rts/three-gltf-umd.js');
  await ensureThreeGltfLoaders();

  pose.x = spawn?.x ?? 0;
  pose.z = spawn?.z ?? 0;
  pose.yaw = spawn?.yaw ?? 0;
  {
    const gy = sampleGroundY(pose.x, pose.z, NaN);
    pose.y = Number.isFinite(gy)
      ? gy + Phys.FLOOR_BAND_VEHICLE
      : spawn?.y ?? Phys.FLOOR_BAND_VEHICLE;
  }
  Box3D.teleportVehicleCollider(pose.x, pose.y, pose.z);

  if (!vehicleRoot) {
    vehicleRoot = document.createElement('a-entity');
    vehicleRoot.id = 'player-fighter';
    sceneEl.appendChild(vehicleRoot);
  }
  vehicleRoot.object3D.position.set(pose.x, pose.y, pose.z);

  if (exterior) {
    teleportVehicle(pose.x, pose.y, pose.z, pose.yaw);
    return vehicleRoot;
  }

  return new Promise((resolve, reject) => {
    const loader = new window.THREE.GLTFLoader();
    loader.load(
      FIGHTER_URL,
      (gltf) => {
        exterior = gltf.scene;
        exterior.name = 'space_fighter_exterior';
        exterior.rotation.y = Math.PI;
        fitModelToLength(exterior, TARGET_LENGTH_M);
        vehicleRoot.object3D.add(exterior);
        syncVisual();
        setupMuzzleAnchor();
        window.__BATTLEVR2_VEHICLE__ = {
          root: vehicleRoot,
          exterior,
          getPose: getVehiclePose,
          getFitScale: () => fitScale,
          getMuzzleWorldPos,
          requestBoost,
        };
        console.log('[BattleVR2] fighter exterior loaded (physics=battle-phys)');
        resolve(vehicleRoot);
      },
      undefined,
      reject
    );
  });
}

export function setExteriorVisible(v) {
  if (exterior) exterior.visible = !!v;
  if (vehicleRoot) vehicleRoot.object3D.visible = !!v || boarded;
}

export function enterVehicle() {
  boarded = true;
  setExteriorVisible(true);
  // Resume chassis with coast velocity (bailout mid-jump → re-board mid-air).
  Phys.setPhysMover('vehicle');
  Phys.adoptPhysPose(pose.x, pose.y, pose.z, pose.yaw, { keepVel: false });
  Phys.setPhysVelocity(parkedVel.x, parkedVel.y, parkedVel.z);
  Box3D.setPlayerColliderEnabled(false);
  window.__BATTLEVR2_BOARDED__ = true;
  const body = document.getElementById('local-body');
  if (body) body.setAttribute('visible', 'true');
}

export function exitVehicle() {
  // Capture chassis momentum BEFORE shared phys becomes the player.
  syncPoseFromPhys();
  parkedVel = Phys.getPhysVelocity();
  boarded = false;
  setExteriorVisible(true);
  controls = { yaw: 0, pitch: 0, thrust: 0, strafe: 0, yawDelta: 0, boost: false };
  const p = getVehiclePose();
  // Bail out beside the hull at the vehicle's current height (air or ground) —
  // never snap to terrain. Inherit chassis velocity so jumps keep going.
  const side = 3.2;
  const fwdX = -Math.sin(p.yaw);
  const fwdZ = -Math.cos(p.yaw);
  const rightX = -fwdZ;
  const rightZ = fwdX;
  const ex = p.x + rightX * side;
  const ey = p.y;
  const ez = p.z + rightZ * side;
  const inherit = 0.92;
  Phys.setPhysMover('player');
  Phys.adoptPhysPose(ex, ey, ez, p.yaw, { keepVel: false });
  Phys.setPhysVelocity(
    parkedVel.x * inherit,
    parkedVel.y * inherit,
    parkedVel.z * inherit
  );
  Box3D.setPlayerColliderEnabled(true);
  window.__BATTLEVR2_BOARDED__ = false;
  window.__BATTLEVR2_COCKPIT_JOY_HAND__ = null;
  const body = document.getElementById('local-body');
  if (body) body.setAttribute('visible', 'true');
  return { x: ex, y: ey, z: ez, yaw: p.yaw };
}

export function forceExit() {
  if (boarded) {
    syncPoseFromPhys();
    parkedVel = Phys.getPhysVelocity();
  }
  boarded = false;
  window.__BATTLEVR2_BOARDED__ = false;
  window.__BATTLEVR2_FORCE_VEHICLE_STEP__ = false;
  window.__BATTLEVR2_COCKPIT_JOY_HAND__ = null;
  controls = { yaw: 0, pitch: 0, thrust: 0, strafe: 0, yawDelta: 0, boost: false };
  Phys.setPhysMover('player');
  setExteriorVisible(true);
  Box3D.setPlayerColliderEnabled(true);
  const body = document.getElementById('local-body');
  if (body) body.setAttribute('visible', 'true');
}

export function requestBoost() {
  if (boostCooldown > 0) return false;
  controls.boost = true;
  return true;
}

function stepChassis(dt, { driven }) {
  boostCooldown = Math.max(0, boostCooldown - dt);
  Phys.setPhysMover('vehicle');

  // Stick sets a *target* yaw rate; release coasts instead of hard-stopping.
  const targetYawRate = driven ? (controls.yaw || 0) * TURN_RATE : 0;
  const blend = 1 - Math.exp(-YAW_RATE_RESPONSIVENESS * Math.max(0, dt));
  yawRate += (targetYawRate - yawRate) * blend;
  if (Math.abs(yawRate) < 1e-4) yawRate = 0;
  if (yawRate !== 0) Phys.addPhysYaw(yawRate, dt);

  if (driven) {
    // Direct mouse-look yaw (radians this frame) — snappy PC turn, separate from stick rate.
    if (controls.yawDelta) {
      Phys.addPhysYaw(controls.yawDelta, 1);
      controls.yawDelta = 0;
    }
    Phys.addPhysSurge(controls.thrust || 0, dt, Phys.SURGE_FORCE_VEHICLE);
    const strafe = controls.strafe || 0;
    if (Math.abs(strafe) > 0.02) {
      const y = Phys.getPhysYaw();
      const fwdX = -Math.sin(y);
      const fwdZ = -Math.cos(y);
      // right = cross(up, forward)
      const rightX = fwdZ;
      const rightZ = -fwdX;
      const f = Phys.SURGE_FORCE_VEHICLE * 0.85;
      Phys.addPhysForce(rightX * strafe * f, 0, rightZ * strafe * f, dt);
    }
    if (controls.boost && boostCooldown <= 0) {
      const y = Phys.getPhysYaw();
      const fwdX = -Math.sin(y);
      const fwdZ = -Math.cos(y);
      Phys.addPhysImpulse(
        fwdX * Phys.SPEED_BOOST_FORCE,
        Phys.SPEED_BOOST_FORCE * 0.85,
        fwdZ * Phys.SPEED_BOOST_FORCE
      );
      boostCooldown = BOOST_COOLDOWN_S;
      controls.boost = false;
    }
  }

  Phys.stepPhys(dt);
  syncPoseFromPhys();
  parkedVel = Phys.getPhysVelocity();
  syncVisual();
}

export function stepVehicle(dt) {
  if (boarded || window.__BATTLEVR2_FORCE_VEHICLE_STEP__) {
    stepChassis(dt, { driven: true });
    return pose;
  }

  // Empty fighter: keep integrating (gravity / damp / ground) so bailouts mid-jump
  // do not freeze the hull in the air. Shared phys is the player — swap briefly.
  const snap = Phys.snapshotPhys();
  Phys.setPhysMover('vehicle');
  Phys.adoptPhysPose(pose.x, pose.y, pose.z, pose.yaw, { keepVel: false });
  Phys.setPhysVelocity(parkedVel.x, parkedVel.y, parkedVel.z);
  stepChassis(dt, { driven: false });
  Phys.restorePhys(snap);
  return pose;
}

/**
 * @param {number} [y] world Y — ignored for seating unless opts.absoluteY (freefall / jumps).
 * @param {{ absoluteY?: boolean }} [opts]
 */
export function teleportVehicle(x, y, z, yaw, opts = {}) {
  pose.x = x;
  pose.z = z;
  if (yaw != null) pose.yaw = yaw;
  if (opts.absoluteY && Number.isFinite(y)) {
    pose.y = y;
  } else {
    const gy = sampleGroundY(x, z, NaN);
    pose.y = Number.isFinite(gy)
      ? gy + Phys.FLOOR_BAND_VEHICLE
      : Number.isFinite(y)
        ? y
        : pose.y;
  }
  slamPitch = 0;
  slamSink = 0;
  yawRate = 0;
  Phys.setPhysMover('vehicle');
  Phys.teleportPhys(pose.x, pose.y, pose.z, pose.yaw);
  syncVisual();
}
