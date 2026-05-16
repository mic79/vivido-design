/**
 * Player collision — resolve before body IK so the avatar stays aligned with the headset.
 * Wall: head + controller grips (XZ). NPC: tight torso/head only when player is nearby.
 */
import * as THREE from 'three';

/** @typedef {{ x: number, y: number, z: number, r: number }} CollisionSphere */

const _headWorld = new THREE.Vector3();
const _handWorld = new THREE.Vector3();
const _best = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _closest = new THREE.Vector3();

const MAX_CORRECTION_PER_ITER = 0.12;
const MAX_ITERS = 3;
const MIN_PUSH_DEPTH = 0.006;

/**
 * @param {CollisionSphere} s
 * @param {{ minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number }} box
 * @param {boolean} xzOnly
 * @returns {{ x: number, y: number, z: number } | null}
 */
function penetrationSphereAabb(s, box, xzOnly = false) {
  const cx = Math.max(box.minX, Math.min(s.x, box.maxX));
  const cy = Math.max(box.minY, Math.min(s.y, box.maxY));
  const cz = Math.max(box.minZ, Math.min(s.z, box.maxZ));
  let dx = s.x - cx;
  let dy = s.y - cy;
  let dz = s.z - cz;
  const d2 = dx * dx + dy * dy + dz * dz;
  const r2 = s.r * s.r;

  if (d2 >= r2) return null;

  if (d2 < 1e-10) {
    const px = Math.min(s.x - box.minX, box.maxX - s.x);
    const py = Math.min(s.y - box.minY, box.maxY - s.y);
    const pz = Math.min(s.z - box.minZ, box.maxZ - s.z);
    if (px <= py && px <= pz) {
      dx = s.x < (box.minX + box.maxX) * 0.5 ? -1 : 1;
      const depth = s.r + px;
      if (depth < MIN_PUSH_DEPTH) return null;
      return { x: dx * depth, y: 0, z: 0 };
    }
    if (py <= pz && !xzOnly) {
      const depth = s.r + py;
      if (depth < MIN_PUSH_DEPTH) return null;
      return { x: 0, y: (s.y < (box.minY + box.maxY) * 0.5 ? -1 : 1) * depth, z: 0 };
    }
    const depth = s.r + pz;
    if (depth < MIN_PUSH_DEPTH) return null;
    return { x: 0, y: 0, z: (s.z < (box.minZ + box.maxZ) * 0.5 ? -1 : 1) * depth };
  }

  const d = Math.sqrt(d2);
  const depth = s.r - d;
  if (depth < MIN_PUSH_DEPTH) return null;
  if (xzOnly) {
    return { x: (dx / d) * depth, y: 0, z: (dz / d) * depth };
  }
  return { x: (dx / d) * depth, y: (dy / d) * depth, z: (dz / d) * depth };
}

/**
 * @param {CollisionSphere} s
 * @param {{ x: number, y: number, z: number }} a
 * @param {{ x: number, y: number, z: number }} b
 * @param {number} segRadius — bar/pipe thickness radius
 */
function penetrationSphereSegment(s, a, b, segRadius) {
  _seg.set(b.x - a.x, b.y - a.y, b.z - a.z);
  const lenSq = _seg.lengthSq();
  if (lenSq < 1e-10) return null;
  _pt.set(s.x - a.x, s.y - a.y, s.z - a.z);
  const t = Math.max(0, Math.min(1, _seg.dot(_pt) / lenSq));
  _closest.set(a.x + _seg.x * t, a.y + _seg.y * t, a.z + _seg.z * t);
  const dx = s.x - _closest.x;
  const dy = s.y - _closest.y;
  const dz = s.z - _closest.z;
  const dist = Math.hypot(dx, dy, dz);
  const minDist = s.r + segRadius;
  if (dist >= minDist) return null;
  const depth = minDist - dist;
  if (depth < MIN_PUSH_DEPTH) return null;
  if (dist > 1e-6) {
    return { x: (dx / dist) * depth, y: (dy / dist) * depth, z: (dz / dist) * depth };
  }
  return { x: depth, y: 0, z: 0 };
}

/**
 * @param {CollisionSphere} a
 * @param {CollisionSphere} b
 * @returns {{ x: number, y: number, z: number } | null}
 */
function penetrationSphereSphere(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  const dist = Math.hypot(dx, dy, dz);
  const minDist = a.r + b.r;
  if (dist >= minDist) return null;
  const depth = minDist - dist;
  if (depth < MIN_PUSH_DEPTH) return null;
  if (dist > 1e-6) {
    return { x: (dx / dist) * depth, y: (dy / dist) * depth, z: (dz / dist) * depth };
  }
  return { x: depth, y: 0, z: 0 };
}

/**
 * @param {THREE.Vector3} sum
 * @param {{ x: number, y: number, z: number }} v
 */
function addLargestCorrection(sum, v) {
  const lenSq = v.x * v.x + v.y * v.y + v.z * v.z;
  if (lenSq <= sum.lengthSq()) return;
  sum.set(v.x, v.y, v.z);
}

function clampCorrection(sum) {
  const len = sum.length();
  if (len > MAX_CORRECTION_PER_ITER && len > 1e-8) {
    sum.multiplyScalar(MAX_CORRECTION_PER_ITER / len);
  }
}

/**
 * @param {THREE.Camera} camera
 * @param {{ left: THREE.Object3D | null, right: THREE.Object3D | null }} handToCtrl
 * @param {CollisionSphere[]} out
 */
function collectProbeSpheres(camera, handToCtrl, out, headR, handR) {
  camera.getWorldPosition(_headWorld);
  out.push({ x: _headWorld.x, y: _headWorld.y, z: _headWorld.z, r: headR });

  if (handToCtrl.left) {
    handToCtrl.left.getWorldPosition(_handWorld);
    out.push({ x: _handWorld.x, y: _handWorld.y, z: _handWorld.z, r: handR });
  }
  if (handToCtrl.right) {
    handToCtrl.right.getWorldPosition(_handWorld);
    out.push({ x: _handWorld.x, y: _handWorld.y, z: _handWorld.z, r: handR });
  }
}

/**
 * @param {THREE.Object3D} cameraRig
 * @param {THREE.Camera} camera
 * @param {{ left: THREE.Object3D | null, right: THREE.Object3D | null }} handToCtrl
 * @param {{ collectPlayerBlockSpheres?: (out: CollisionSphere[], playerXZ: { x: number, z: number }) => void } | null} ragdoll
 * @param {{ width: number, height: number, thickness: number, z: number, baseY?: number, nearFaceZ?: number, mantleClearY?: number }} wall
 * @param {{ a: THREE.Vector3, b: THREE.Vector3, segRadius: number }[]} [propSegments]
 * @param {{ climbing?: boolean }} [opts]
 */
export function resolvePlayerBodyCollisions(
  cameraRig,
  camera,
  handToCtrl,
  ragdoll,
  wall,
  propSegments = null,
  opts = {}
) {
  const climbing = !!opts.climbing;
  const headR = climbing ? 0.1 : 0.12;
  const handR = climbing ? 0.055 : 0.065;

  const halfW = wall.width * 0.5;
  const halfT = wall.thickness * 0.5;
  const baseY = wall.baseY ?? 0;
  const nearFaceZ = wall.nearFaceZ ?? wall.z + halfT;
  const mantleClearY = wall.mantleClearY ?? baseY + wall.height + 0.2;
  const wallBox = {
    minX: -halfW,
    maxX: halfW,
    minY: baseY,
    maxY: baseY + wall.height,
    minZ: wall.z - halfT,
    maxZ: wall.z + halfT
  };
  const wallNearZ = nearFaceZ + (climbing ? -0.015 : 0.1);

  /** @type {CollisionSphere[]} */
  const probes = [];
  /** @type {CollisionSphere[]} */
  const npcSpheres = [];

  for (let iter = 0; iter < MAX_ITERS; iter++) {
    probes.length = 0;
    collectProbeSpheres(camera, handToCtrl, probes, headR, handR);

    npcSpheres.length = 0;
    ragdoll?.collectPlayerBlockSpheres?.(npcSpheres, cameraRig.position);

    _best.set(0, 0, 0);

    for (let i = 0; i < probes.length; i++) {
      const s = probes[i];
      if (s.y < mantleClearY) {
        const w = penetrationSphereAabb(s, wallBox, true);
        if (w) addLargestCorrection(_best, w);
      }

      if (propSegments && !climbing) {
        for (let p = 0; p < propSegments.length; p++) {
          const seg = propSegments[p];
          const hit = penetrationSphereSegment(s, seg.a, seg.b, seg.segRadius);
          if (hit) addLargestCorrection(_best, hit);
        }
      }

      for (let j = 0; j < npcSpheres.length; j++) {
        const n = penetrationSphereSphere(s, npcSpheres[j]);
        if (n) addLargestCorrection(_best, n);
      }
    }

    if (_best.lengthSq() < 1e-10) break;
    clampCorrection(_best);
    cameraRig.position.add(_best);
  }

  camera.getWorldPosition(_headWorld);
  if (
    _headWorld.y < mantleClearY
    && Math.abs(cameraRig.position.x) <= halfW + 0.2
    && cameraRig.position.z < wallNearZ
  ) {
    cameraRig.position.z = wallNearZ;
  }
}
