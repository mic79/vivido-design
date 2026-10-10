/**
 * On-foot locomotion — thin wrapper over shared BattleVR battle-phys.
 */
import * as Phys from './battle-phys.js';

let thruster = { left: false, right: false };
let boostReadyAt = 0;

export function getZerogYaw() {
  return Phys.getPhysYaw();
}

export function setZerogYaw(y) {
  Phys.setPhysYaw(y);
}

export function setThruster(hand, on) {
  thruster[hand] = !!on;
}

export function isThrusterOn(hand) {
  return !!thruster[hand];
}

export function resetZerogAt(x, y, z, yawRad = 0) {
  thruster.left = thruster.right = false;
  Phys.setPhysMover('player');
  Phys.resetPhysAt(x, y, z, yawRad);
}

export function requestLookBoost(cameraEl) {
  const now = performance.now();
  if (now < boostReadyAt) return false;
  const THREE = window.THREE;
  const dir = new THREE.Vector3(0, 0, -1);
  if (cameraEl?.object3D) {
    const q = new THREE.Quaternion();
    cameraEl.object3D.getWorldQuaternion(q);
    dir.applyQuaternion(q);
  } else {
    const yaw = Phys.getPhysYaw();
    dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  }
  dir.normalize().multiplyScalar(Phys.SPEED_BOOST_FORCE);
  Phys.addPhysImpulse(dir.x, dir.y, dir.z);
  boostReadyAt = now + 5000;
  return true;
}

function applyHandThrusters(dt) {
  const THREE = window.THREE;
  const leftEl = document.getElementById('leftHand');
  const rightEl = document.getElementById('rightHand');
  const add = (el, on) => {
    if (!on || !el?.object3D) return;
    const dir = new THREE.Vector3(0, -1, 0);
    const q = new THREE.Quaternion();
    el.object3D.getWorldQuaternion(q);
    dir.applyQuaternion(q);
    Phys.addPhysForce(
      dir.x * Phys.THRUSTER_FORCE,
      dir.y * Phys.THRUSTER_FORCE,
      dir.z * Phys.THRUSTER_FORCE,
      dt
    );
  };
  add(leftEl, thruster.left);
  add(rightEl, thruster.right);
}

export function stepZerog(dt, opts = {}) {
  Phys.setPhysMover('player');

  if (opts.yawStick) {
    Phys.addPhysYaw(-opts.yawStick * 2.2, dt);
  }

  if (opts.desktop) {
    if (opts.keys?.has('Space')) {
      thruster.left = thruster.right = true;
    }
    if (opts.keys?.has('KeyQ')) thruster.left = true;
    if (opts.keys?.has('KeyE')) thruster.right = true;
  }

  applyHandThrusters(dt);

  if (opts.surge || opts.strafe) {
    const surge = opts.surge || 0;
    const strafe = opts.strafe || 0;
    const yaw = Phys.getPhysYaw();
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const f = Phys.SURGE_FORCE_PLAYER;
    Phys.addPhysForce(
      (surge * -sin + strafe * cos) * f,
      0,
      (surge * -cos - strafe * sin) * f,
      dt
    );
  }

  return Phys.stepPhys(dt);
}

export function getVelocity() {
  return Phys.getPhysVelocity();
}
