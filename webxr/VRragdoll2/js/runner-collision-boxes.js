/**
 * OBB collision set for VRrunner archery raycasts (same layout as runnerLevel boxes).
 */
import * as THREE from 'three';

const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();

/** @type {object[]} */
let boxes = null;

function makeOBB(cx, cy, cz, hx, hy, hz, yaw = 0) {
  const m = new THREE.Matrix3();
  const mInv = new THREE.Matrix3();
  _euler.set(0, yaw, 0);
  _quat.setFromEuler(_euler);
  _m4.makeRotationFromQuaternion(_quat);
  m.setFromMatrix4(_m4);
  mInv.copy(m).transpose();
  return { cx, cy, cz, hx, hy, hz, m, mInv };
}

/**
 * @param {object} cfg
 */
export function buildRunnerCollisionBoxes(cfg) {
  const {
    platformWidth,
    platformDepth,
    platformHeight,
    platformCenterZ,
    wallWidth,
    wallHeight,
    wallZ,
    wallBaseY,
    wallThickness
  } = cfg;

  boxes = [
    makeOBB(0, -0.05, 0, 12, 0.05, 12),
    makeOBB(
      0,
      platformHeight * 0.5,
      platformCenterZ,
      platformWidth * 0.5,
      platformHeight * 0.5,
      platformDepth * 0.5
    ),
    makeOBB(
      0,
      wallBaseY + wallHeight * 0.5,
      wallZ,
      wallWidth * 0.5,
      wallHeight * 0.5,
      wallThickness * 0.5
    )
  ];
  return boxes;
}

export function getRunnerCollisionBoxes() {
  return boxes || [];
}
