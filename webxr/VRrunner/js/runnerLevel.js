/**
 * VRrunner — static interior blockout: three stacked stories (room + hallway + hall-end),
 * same footprint; fridge only on the top story. Each hall-end glass pane is breakable.
 * Neighbor block is single. Collision OBBs match main.js / bots.js.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();

/** @type {THREE.Group | null} */
let levelGroup_ = null;
/** @type {Array<{cx:number,cy:number,cz:number,hx:number,hy:number,hz:number,m:THREE.Matrix3,mInv:THREE.Matrix3}>} */
const collisionBoxes_ = [];

/** Meshes from loaded GLB models used for raycast-based collision. */
const glbCollisionMeshes_ = [];

/**
 * Stream-sandbox sector GLBs (e.g. pizzaplex per cell): same BVH raycast path as map 0 rooftops.
 * Tagged so `disposeRunnerLevel` does not dispose shared template geometry.
 * @param {THREE.Mesh[]} meshes
 */
export function registerSandboxGlbCollisionMeshes(meshes) {
  for (let i = 0; i < meshes.length; i++) {
    const child = meshes[i];
    if (!child?.isMesh || !child.geometry) continue;
    child.updateMatrixWorld(true);
    const g = child.geometry;
    if (!g.boundsTree) {
      g.computeBoundsTree({
        maxLeafTris: 8,
        maxDepth: 30,
        strategy: 0,
      });
      g.computeBoundingSphere();
    }
    child.userData.sandboxGlbAux = true;
    if (glbCollisionMeshes_.indexOf(child) < 0) glbCollisionMeshes_.push(child);
  }
}

/** Remove sandbox meshes from the global GLB collision list (no geometry dispose). */
export function unregisterSandboxGlbCollisionMeshes(meshes) {
  if (!meshes?.length) return;
  const toRemove = new Set(meshes);
  const arr = glbCollisionMeshes_;
  for (let i = arr.length - 1; i >= 0; i--) {
    const child = arr[i];
    if (toRemove.has(child)) {
      arr.splice(i, 1);
      delete child.userData.sandboxGlbAux;
    }
  }
}
/** One white material shared by all GLB collision meshes; disposed in `disposeRunnerLevel`. */
let glbSharedWhiteMat_ = null;

function disposeMeshMaterialsDeep_(mesh) {
  const m = mesh.material;
  if (!m) return;
  if (Array.isArray(m)) {
    for (let i = 0; i < m.length; i++) m[i]?.dispose?.();
  } else {
    m.dispose?.();
  }
}
const _glbRaycaster = new THREE.Raycaster();
_glbRaycaster.firstHitOnly = true;
const _glbDirs = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(0.707, 0, 0.707),
  new THREE.Vector3(-0.707, 0, 0.707),
  new THREE.Vector3(0.707, 0, -0.707),
  new THREE.Vector3(-0.707, 0, -0.707),
];
/** Hull rays: XZ (thin geometry) + ±Y like BattleVR BVH capsule checks. */
const _glbHullDirs = [
  ..._glbDirs,
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
];
const _glbOrigin = new THREE.Vector3();
const _glbNormal = new THREE.Vector3();
const _glbNormalMatrix = new THREE.Matrix3();

/**
 * Push player out of GLB model meshes using BVH-accelerated rays (BattleVR-style:
 * separation along **face normals**, not cast-axis backsolve — stable on ramps).
 * Downward hits on **nearly flat** tops (ny>0.92) are skipped so OBB/flat snap
 * owns horizontal slabs; ramps still get downward hull seating like BattleVR.
 * @param {THREE.Vector3} rigPos — mutated in place
 * @param {number} radius — player collision radius
 * @param {THREE.Vector3 | null} [outVel] — if set, removes velocity into the surface per hit
 */
export function resolveGlbMeshCollisions(rigPos, radius, outVel = null) {
  if (glbCollisionMeshes_.length === 0) return;
  _glbRaycaster.firstHitOnly = true;
  _glbRaycaster.far = radius * 3;
  const sampleYs = [0.4, 0.9, 1.3, 1.65];
  /* One **closest** penetrating hit per sample height (BattleVR `checkBVHMeshCollision`),
   * not a sum over all rays — summing caused uphill stutter and killed long ramp climbs. */
  for (let sy = 0; sy < sampleYs.length; sy++) {
    _glbOrigin.set(rigPos.x, rigPos.y + sampleYs[sy], rigPos.z);
    let closestDist = Infinity;
    /** @type {{ hit: THREE.Intersection, rayDir: THREE.Vector3 } | null} */
    let best = null;
    for (let d = 0; d < _glbHullDirs.length; d++) {
      const rayDir = _glbHullDirs[d];
      _glbRaycaster.set(_glbOrigin, rayDir);
      const hits = _glbRaycaster.intersectObjects(glbCollisionMeshes_, false);
      if (hits.length > 0) {
        const t = hits[0].distance;
        if (t < radius && t < closestDist) {
          closestDist = t;
          best = { hit: hits[0], rayDir };
        }
      }
    }
    if (!best) continue;
    const hit = best.hit;
    const rayDir = best.rayDir;
    if (!hit.face) continue;
    _glbNormalMatrix.getNormalMatrix(hit.object.matrixWorld);
    _glbNormal.copy(hit.face.normal).applyMatrix3(_glbNormalMatrix).normalize();
    _glbPushOut.subVectors(_glbOrigin, hit.point);
    if (_glbNormal.dot(_glbPushOut) < 0) _glbNormal.negate();
    if (rayDir.y < -0.45 && _glbNormal.y > 0.92) continue;
    const push = radius - hit.distance + 0.008;
    if (push <= 0) continue;
    rigPos.addScaledVector(_glbNormal, push);
    if (outVel) {
      const vn = outVel.dot(_glbNormal);
      if (vn < -0.02) outVel.addScaledVector(_glbNormal, -vn);
    }
  }
}

/** World-space minimum face normal Y to count as walkable (steep ramps). */
const GLB_FLOOR_MIN_NY = 0.26;
/** Origin above feet for downward floor probe (m). */
const GLB_FLOOR_RAY_UP = 2.8;
/** Total cast length below that origin (m); must exceed worst-case fall per frame. */
const GLB_FLOOR_RAY_LEN = 26;
const _glbDownDir = new THREE.Vector3(0, -1, 0);
/** Footprint offsets (m) — thin decks often miss a single centre ray. */
const GLB_FLOOR_PROBE_RX = [0, 0.28, -0.28, 0.2, -0.2];
const GLB_FLOOR_PROBE_RZ = [0, 0, 0, 0.22, -0.22];

/**
 * Topmost walkable hit along one downward column (skips beams / sides by normal).
 * @param {{ y:number, point:THREE.Vector3, normal:THREE.Vector3 }} out
 * @returns {boolean}
 */
function probeGlbFloorColumn_(sampleX, sampleZ, feetY, out) {
  _glbOrigin.set(sampleX, feetY + GLB_FLOOR_RAY_UP, sampleZ);
  _glbRaycaster.set(_glbOrigin, _glbDownDir);
  _glbRaycaster.far = GLB_FLOOR_RAY_LEN;
  _glbRaycaster.firstHitOnly = false;
  const hits = _glbRaycaster.intersectObjects(glbCollisionMeshes_, false);
  _glbRaycaster.firstHitOnly = true;
  const maxAboveFeet = feetY + 1.1;
  const maxBelowFeet = feetY - 8;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const hy = h.point.y;
    if (hy > maxAboveFeet) continue;
    if (hy < maxBelowFeet) continue;
    if (!h.face) continue;
    _glbNormalMatrix.getNormalMatrix(h.object.matrixWorld);
    _glbNormal.copy(h.face.normal).applyMatrix3(_glbNormalMatrix).normalize();
    if (_glbNormal.y < GLB_FLOOR_MIN_NY) continue;
    out.y = hy;
    out.point.copy(h.point);
    out.normal.copy(_glbNormal);
    return true;
  }
  return false;
}

const _glbColHit = {
  y: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
};
const _glbBestBuf = {
  y: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
};

/**
 * Highest walkable GLB hit among footprint probes. **Centre column wins** whenever it
 * is within 8 cm of the best side probe — stops the support plane/normals swapping
 * every frame when walking diagonally uphill (main cause of visible stutter).
 */
function pickBestGlbFloor_(x, z, feetY, out) {
  if (glbCollisionMeshes_.length === 0) return false;
  let bestY = -Infinity;
  let found = false;
  for (let p = 0; p < GLB_FLOOR_PROBE_RX.length; p++) {
    const sx = x + GLB_FLOOR_PROBE_RX[p];
    const sz = z + GLB_FLOOR_PROBE_RZ[p];
    if (!probeGlbFloorColumn_(sx, sz, feetY, _glbColHit)) continue;
    if (_glbColHit.y > bestY) {
      bestY = _glbColHit.y;
      _glbBestBuf.y = _glbColHit.y;
      _glbBestBuf.point.copy(_glbColHit.point);
      _glbBestBuf.normal.copy(_glbColHit.normal);
      found = true;
    }
  }
  if (!found) return false;
  const centreOk = probeGlbFloorColumn_(x, z, feetY, _glbColHit);
  if (centreOk && _glbColHit.y >= bestY - 0.08) {
    out.y = _glbColHit.y;
    out.point.copy(_glbColHit.point);
    out.normal.copy(_glbColHit.normal);
    return true;
  }
  if (centreOk && Math.abs(_glbColHit.y - bestY) < 0.22) {
    out.y = _glbColHit.y;
    out.point.copy(_glbColHit.point);
    out.normal.copy(_glbColHit.normal);
  } else {
    out.y = _glbBestBuf.y;
    out.point.copy(_glbBestBuf.point);
    out.normal.copy(_glbBestBuf.normal);
  }
  return true;
}

/**
 * Highest walkable GLB surface under the rig among several footprint samples.
 * Returns the Y of the hit point or null.
 */
export function getGlbFloorY(x, z, currentY) {
  if (!pickBestGlbFloor_(x, z, currentY, _glbColHit)) return null;
  return _glbColHit.y;
}

/**
 * Same as {@link getGlbFloorY} but fills hit point + **outward** face normal (world).
 * @param {{ y:number, point:THREE.Vector3, normal:THREE.Vector3 }} out
 */
export function getGlbFloorSupport(x, z, feetY, out) {
  return pickBestGlbFloor_(x, z, feetY, out);
}

const _glbInvWorld = new THREE.Matrix4();
const _glbSphere = new THREE.Sphere();
const _glbWorldSurf = new THREE.Vector3();
const _glbPushOut = new THREE.Vector3();
const _glbCpLocal = new THREE.Vector3();
const _glbCpTarget = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };

/**
 * Earliest ray hit vs loaded GLB collision meshes (BVH-accelerated).
 * `dir` must be **normalized** (same contract as `rayHitWorld` in bots.js).
 * @param {THREE.Vector3} origin
 * @param {THREE.Vector3} dir unit direction
 * @param {number} maxDist
 * @param {{ t:number, point:THREE.Vector3, normal:THREE.Vector3 } | null} outHit optional; `outHit.box` is not set (use null for OBB-only callers)
 * @returns {number} distance along ray, or Infinity
 */
export function rayCastRunnerGlbMeshes(origin, dir, maxDist, outHit = null) {
  if (glbCollisionMeshes_.length === 0) return Infinity;
  _glbRaycaster.firstHitOnly = true;
  _glbRaycaster.set(origin, dir);
  _glbRaycaster.far = maxDist;
  const hits = _glbRaycaster.intersectObjects(glbCollisionMeshes_, false);
  if (!hits.length) return Infinity;
  const h = hits[0];
  const t = h.distance;
  if (outHit) {
    outHit.t = t;
    outHit.point.copy(h.point);
    if (h.face) {
      _glbNormalMatrix.getNormalMatrix(h.object.matrixWorld);
      outHit.normal.copy(h.face.normal).applyMatrix3(_glbNormalMatrix).normalize();
    } else {
      outHit.normal.copy(dir).negate();
    }
  }
  return t;
}

/**
 * True if a world-space sphere overlaps any triangle of the GLB collision set.
 * Used alongside OBB `pointInsideAnyOBB` for drones / grenades / projectiles.
 */
export function runnerGlbMeshesIntersectsSphere(worldCenter, radius) {
  if (glbCollisionMeshes_.length === 0 || radius < 0) return false;
  const r = radius > 0 ? radius : 1e-4;
  for (let i = 0; i < glbCollisionMeshes_.length; i++) {
    const mesh = glbCollisionMeshes_[i];
    const tree = mesh.geometry?.boundsTree;
    if (!tree) continue;
    mesh.updateMatrixWorld(true);
    _glbInvWorld.copy(mesh.matrixWorld).invert();
    _glbSphere.set(worldCenter, r);
    _glbSphere.applyMatrix4(_glbInvWorld);
    if (tree.intersectsSphere(_glbSphere)) return true;
  }
  return false;
}

/**
 * If `worldPos` lies within `pad` metres of any GLB surface, push it outward along
 * the world-space separation vector (one pass per mesh; call from a small loop).
 * @param {THREE.Vector3 | null} accumulatePush optional; if set, each displacement is added (for velocity projection)
 * @returns {boolean} whether the position was modified
 */
export function pushWorldPointOutOfRunnerGlbMeshes(worldPos, pad, accumulatePush = null) {
  if (glbCollisionMeshes_.length === 0) return false;
  let moved = false;
  for (let i = 0; i < glbCollisionMeshes_.length; i++) {
    const mesh = glbCollisionMeshes_[i];
    const tree = mesh.geometry?.boundsTree;
    if (!tree) continue;
    mesh.updateMatrixWorld(true);
    _glbInvWorld.copy(mesh.matrixWorld).invert();
    _glbCpLocal.copy(worldPos).applyMatrix4(_glbInvWorld);
    const res = tree.closestPointToPoint(_glbCpLocal, _glbCpTarget, 0, pad + 4);
    if (!res) continue;
    _glbWorldSurf.copy(_glbCpTarget.point).applyMatrix4(mesh.matrixWorld);
    const worldDist = worldPos.distanceTo(_glbWorldSurf);
    if (worldDist >= pad - 1e-4) continue;
    _glbPushOut.subVectors(worldPos, _glbWorldSurf);
    const len = _glbPushOut.length();
    if (len < 1e-6) continue;
    _glbPushOut.multiplyScalar((pad - worldDist) / len);
    worldPos.add(_glbPushOut);
    if (accumulatePush) accumulatePush.add(_glbPushOut);
    moved = true;
  }
  return moved;
}

/** Breakable hall-end windows (arrow or player burst) — one entry per story glass. */
const _runnerGlassLp = new THREE.Vector3();
/** @type {{ obb: object | null, mesh: THREE.Mesh | null, broken: boolean }[]} */
let runnerGlassPanes_ = [];
/** Template material cloned per pane; never assigned to a mesh — dispose on level teardown. */
let runnerGlassTemplateMat_ = null;

/** Scene ref for shard FX (not parented under levelGroup). */
/** @type {THREE.Scene | null} */
let runnerSceneRef_ = null;
/** @type {{ mesh: THREE.Mesh, vel: THREE.Vector3, angVel: THREE.Vector3, t: number }[]} */
const glassShardParts_ = [];

const GLASS_BREAK_AUDIO_URL = new URL(
  "../audio/dragon-studio-glass-breaking-504033.mp3",
  import.meta.url,
).href;

function playGlassBreakSound() {
  try {
    const el = new Audio(GLASS_BREAK_AUDIO_URL);
    el.volume = 0.92;
    el.play().catch(() => {});
  } catch (_) { /* ignore */ }
}

function clearAllGlassShards_() {
  if (!runnerSceneRef_) {
    glassShardParts_.length = 0;
    return;
  }
  for (const s of glassShardParts_) {
    runnerSceneRef_.remove(s.mesh);
    s.mesh.geometry?.dispose?.();
    s.mesh.material?.dispose?.();
  }
  glassShardParts_.length = 0;
}

function spawnGlassShatterFromObb(obb) {
  if (!runnerSceneRef_) return;
  const cx = obb.cx;
  const cy = obb.cy;
  const cz = obb.cz;
  const hx = obb.hx;
  const hy = obb.hy;
  const hz = obb.hz;
  const n = 52;
  for (let i = 0; i < n; i++) {
    const jx = (Math.random() - 0.5) * 2;
    const jy = (Math.random() - 0.5) * 2;
    const jz = (Math.random() - 0.5) * 2;
    const sx = 0.055 + Math.random() * 0.2;
    const sy = 0.045 + Math.random() * 0.2;
    const sz = 0.012 + Math.random() * 0.038;
    const geom = new THREE.BoxGeometry(sx, sy, sz);
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL(
        0.52 + Math.random() * 0.07,
        0.25 + Math.random() * 0.2,
        0.5 + Math.random() * 0.18,
      ),
      metalness: 0.18 + Math.random() * 0.12,
      roughness: 0.38 + Math.random() * 0.25,
      transparent: true,
      opacity: 0.94,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(
      cx + jx * hx * 0.94,
      cy + jy * hy * 0.94,
      cz + jz * hz * 0.94,
    );
    mesh.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    runnerSceneRef_.add(mesh);
    const vel = new THREE.Vector3(
      (Math.random() - 0.5) * 5,
      Math.random() * 6 + 2.4,
      3.2 + Math.random() * 7,
    );
    const angVel = new THREE.Vector3(
      (Math.random() - 0.5) * 16,
      (Math.random() - 0.5) * 16,
      (Math.random() - 0.5) * 16,
    );
    glassShardParts_.push({
      mesh,
      vel,
      angVel,
      t: 2.35 + Math.random() * 0.75,
    });
  }
}

/** Call from `animate` every frame (seconds). */
export function updateRunnerGlassShards(dtSec) {
  const g = 11.8;
  const dt = Math.min(0.08, Math.max(0, dtSec));
  if (!glassShardParts_.length || !runnerSceneRef_) return;
  for (let i = glassShardParts_.length - 1; i >= 0; i--) {
    const s = glassShardParts_[i];
    s.t -= dt;
    s.vel.y -= g * dt;
    s.mesh.position.addScaledVector(s.vel, dt);
    s.mesh.rotation.x += s.angVel.x * dt;
    s.mesh.rotation.y += s.angVel.y * dt;
    s.mesh.rotation.z += s.angVel.z * dt;
    const fade = THREE.MathUtils.clamp(s.t / 2.0, 0, 1);
    s.mesh.material.opacity = fade * 0.92;
    if (s.t <= 0 || s.mesh.position.y < -2.8) {
      runnerSceneRef_.remove(s.mesh);
      s.mesh.geometry.dispose();
      s.mesh.material.dispose();
      glassShardParts_.splice(i, 1);
    }
  }
}

let duckUntilMs_ = 0;
/** Eye height above rig (feet) — local Y on camera when using crouch parent. */
export const RUNNER_STANDING_EYE_Y = 2;
const BASE_CAMERA_Y = RUNNER_STANDING_EYE_Y;
/** Slide / crouch: target eye height above rig (m). */
const SLIDE_CAMERA_Y = 0.42;
/** Clamp parent offset (must allow full −(BASE−SLIDE) ≈ −1.58 on desktop). */
const CROUCH_PARENT_Y_MIN = -1.72;
const CROUCH_PARENT_Y_MAX = 0.28;
/** If tracked local Y is tiny (bad / odd XR frame), assume ~standing eye (m). */
const CROUCH_FALLBACK_STANDING_Y = 1.62;
const CROUCH_HEAD_Y_TRUST_MIN = 0.55;
/** Smooth crouch in/out (~seconds to settle). */
const CROUCH_SMOOTH_TAU_SEC = 0.14;

function makeOBB(cx, cy, cz, hx, hy, hz, yaw = 0) {
  return makeOBBEuler(cx, cy, cz, hx, hy, hz, 0, yaw, 0);
}

function makeOBBEuler(cx, cy, cz, hx, hy, hz, rx, ry, rz) {
  const m = new THREE.Matrix3();
  const mInv = new THREE.Matrix3();
  _euler.set(rx, ry, rz, "XYZ");
  _quat.setFromEuler(_euler);
  _m4.makeRotationFromQuaternion(_quat);
  m.setFromMatrix4(_m4);
  mInv.copy(m).transpose();
  const b = { cx, cy, cz, hx, hy, hz, m, mInv };
  collisionBoxes_.push(b);
  return b;
}

function addWallMesh(group, x, y, z, w, h, d, mat) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Hall half-width (m); interior width = 2× this. */
let hallHalfW_ = 0.92;

/** Past this rig +Z the main floor slab has ended — allow negative Y (pit fall). */
let hallFloorClampZ1_ = 31.5;

/** Rig world Y at or below this triggers pit reset (under the lowest floor). */
export const RUNNER_PIT_RESET_Y = -14;

/** World Y of the upper story floor slab **top** (must match `floorTopY` in `initRunnerLevel`). */
export const RUNNER_TOP_FLOOR_SURFACE_Y = 0.5;

/**
 * Highest floor-slab top at world (x, z) that is **at or below** `currentY + slack`.
 * Returns `null` only if no floor footprint covers (x, z).
 *
 * `slack` lets the rig snap *up* to a slab top it has just penetrated from above
 * by sub-millimeter amounts (numerical drift from the gravity integration).
 *
 * Floors above the rig (`topY > currentY + slack`) are ignored so the rig never
 * gets yanked **upward** to a higher story while jumping or falling between
 * floors.
 *
 * @param {number} x
 * @param {number} z
 * @param {number} currentY
 * @param {number} [slack=0.35]
 */
const _floorLp = new THREE.Vector3();
export function getRunnerFloorY(x, z, currentY, slack = 0.35) {
  let bestTop = -Infinity;
  let coveredXZ = false;
  for (let i = 0; i < collisionBoxes_.length; i++) {
    const b = collisionBoxes_[i];
    if (!b.floorSlab) continue;
    _floorLp.set(x - b.cx, 0, z - b.cz).applyMatrix3(b.mInv);
    if (Math.abs(_floorLp.x) > b.hx) continue;
    if (Math.abs(_floorLp.z) > b.hz) continue;
    coveredXZ = true;
    const topY = b.cy + b.hy;
    if (topY <= currentY + slack && topY > bestTop) bestTop = topY;
  }
  if (bestTop > -Infinity) return bestTop;
  /*
   * Rig is *below every floor* but still over a footprint (e.g. tunnelled
   * through after a huge dt). Return the **lowest** floor top — the one
   * closest to the rig — so snap teleports them back up onto it instead of
   * letting them fall to the pit reset.
   */
  if (!coveredXZ) return null;
  let lowestAbove = Infinity;
  for (let i = 0; i < collisionBoxes_.length; i++) {
    const b = collisionBoxes_[i];
    if (!b.floorSlab) continue;
    _floorLp.set(x - b.cx, 0, z - b.cz).applyMatrix3(b.mInv);
    if (Math.abs(_floorLp.x) > b.hx) continue;
    if (Math.abs(_floorLp.z) > b.hz) continue;
    const topY = b.cy + b.hy;
    if (topY < lowestAbove) lowestAbove = topY;
  }
  return lowestAbove < Infinity ? lowestAbove : null;
}

/** Slide-assist bounds grow with the level (deck / roof / alley). Updated in `initRunnerLevel`. */
let assistZ1_ = 28;
let assistXHalf_ = 0.92;
/** XZ rectangle (world) where slide works on the loaded GLB; null until model loads. */
let glbSlideXZ_ = null;
const _slideUnionBox = new THREE.Box3();
const _slideMeshBox = new THREE.Box3();

function recomputeGlbSlideFootprintXZ_() {
  glbSlideXZ_ = null;
  if (glbCollisionMeshes_.length === 0) return;
  _slideUnionBox.makeEmpty();
  for (let i = 0; i < glbCollisionMeshes_.length; i++) {
    const mesh = glbCollisionMeshes_[i];
    mesh.updateMatrixWorld(true);
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    _slideMeshBox.copy(geo.boundingBox).applyMatrix4(mesh.matrixWorld);
    _slideUnionBox.union(_slideMeshBox);
  }
  const pad = 4;
  glbSlideXZ_ = {
    minX: _slideUnionBox.min.x - pad,
    maxX: _slideUnionBox.max.x + pad,
    minZ: _slideUnionBox.min.z - pad,
    maxZ: _slideUnionBox.max.z + pad,
  };
}

/** Hallway strip (+Z) where down-throw can trigger slide assist (lower bound). */
const ASSIST_Z0 = 0.25;
/**
 * Symmetric to jump: same release + `THROW_BOOST` path, comparable impulse
 * bar (`SLIDE_DOWN_IMPULSE` ≈ jump magnitude). No forward-velocity requirement
 * (jump doesn’t need it either).
 */
/** Same ballpark as `JUMP_THRESHOLD` in main (0.62) on the shared impulse scale. */
const SLIDE_DOWN_IMPULSE = 0.55;

/**
 * @param {number} [slideProbeY] — `-worldHandVy * THROW_BOOST` from main; combined
 *  with rig-local `impY` so either “punch down” in rig or grip-local Y triggers slide.
 */
export function getRunnerThrowAssist(rigPos, rigVelBefore, impX, impY, impZ, slideProbeY) {
  if (!levelGroup_) return null;
  const inHallAssist =
    rigPos.z >= ASSIST_Z0
    && rigPos.z <= assistZ1_
    && Math.abs(rigPos.x) <= assistXHalf_;
  const onGlbFootprint =
    glbSlideXZ_ != null
    && rigPos.x >= glbSlideXZ_.minX
    && rigPos.x <= glbSlideXZ_.maxX
    && rigPos.z >= glbSlideXZ_.minZ
    && rigPos.z <= glbSlideXZ_.maxZ;
  if (!inHallAssist && !onGlbFootprint) return null;

  if (impY > 0.52) return null;
  const probe = slideProbeY != null ? slideProbeY : 0;
  const downHint = Math.min(probe, impY);
  if (downHint < -SLIDE_DOWN_IMPULSE) {
    return {
      extraForwardZ: 0.85,
      duckMs: 1200,
    };
  }
  return null;
}

export function triggerRunnerDuck(durationMs) {
  duckUntilMs_ = Math.max(duckUntilMs_, performance.now() + durationMs);
}

/** Torso/leg sample heights squash toward the floor while sliding. */
export function getRigSampleHeightMul() {
  return performance.now() < duckUntilMs_ ? 0.22 : 1;
}

/** Horizontal capsule radius multiplier while sliding (narrower body). */
export function getRunnerRadiusMul() {
  return performance.now() < duckUntilMs_ ? 0.38 : 1;
}

/**
 * Call each frame from main. In WebXR the runtime drives `camera.position.y`
 * from tracking (typically ~1.5–1.7 m, not the editor’s 2 m), so a **fixed**
 * parent offset of −(2−0.42) double-counts and shoves the view through the
 * floor. We set `crouchParent.y` so `crouchParent.y + camera.y ≈ SLIDE_CAMERA_Y`
 * (clamped), and ease it so crouch isn’t a one-frame snap.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {THREE.Group} crouchParent — rig child between rig and camera; Y only.
 * @param {{ deltaMs?: number }} [opts] — frame delta for smoothing (ms).
 */
export function applyRunnerCameraDuck(camera, crouchParent, opts = {}) {
  const now = performance.now();
  const ducking = now < duckUntilMs_;
  if (!crouchParent) {
    camera.position.y = ducking ? SLIDE_CAMERA_Y : BASE_CAMERA_Y;
    return;
  }

  const dtSec = Math.min(0.12, Math.max(0, (opts.deltaMs ?? 16.67) * 0.001));
  const alpha = 1 - Math.exp(-dtSec / CROUCH_SMOOTH_TAU_SEC);

  let targetParentY = 0;
  if (ducking) {
    const ey = camera.position.y;
    const headY = ey < CROUCH_HEAD_Y_TRUST_MIN ? CROUCH_FALLBACK_STANDING_Y : ey;
    /* Effective eye height above rig ≈ parent.y + headY (same XZ). */
    const raw = SLIDE_CAMERA_Y - headY;
    targetParentY = THREE.MathUtils.clamp(raw, CROUCH_PARENT_Y_MIN, CROUCH_PARENT_Y_MAX);
  }

  crouchParent.position.y += (targetParentY - crouchParent.position.y) * alpha;
}

export function getRunnerCollisionBoxes() {
  return collisionBoxes_;
}

function _removeRunnerGlassFromCollision(obb) {
  const idx = collisionBoxes_.indexOf(obb);
  if (idx >= 0) collisionBoxes_.splice(idx, 1);
}

function shatterRunnerGlassPane_(pane) {
  if (!pane || pane.broken) return;
  const obb = pane.obb;
  const mesh = pane.mesh;
  pane.broken = true;
  if (obb) {
    playGlassBreakSound();
    spawnGlassShatterFromObb(obb);
  }
  if (mesh) {
    mesh.removeFromParent();
    mesh.geometry?.dispose?.();
    const mat = mesh.material;
    if (mat && !Array.isArray(mat)) mat.dispose?.();
  }
  if (obb) _removeRunnerGlassFromCollision(obb);
  pane.obb = null;
  pane.mesh = null;
}

/**
 * @param {object} box — OBB from `rayHitWorldRich` / collision list
 * @returns {boolean} true if this was the runner glass and it shattered
 */
export function tryShatterRunnerGlassArrow(box) {
  if (!box) return false;
  for (let i = 0; i < runnerGlassPanes_.length; i++) {
    const pane = runnerGlassPanes_[i];
    if (!pane.broken && pane.obb && box === pane.obb) {
      shatterRunnerGlassPane_(pane);
      return true;
    }
  }
  return false;
}

/**
 * @param {THREE.Vector3} rigPos
 * @param {THREE.Vector3} rigVel
 * @param {number} headWx
 * @param {number} headWy
 * @param {number} headWz
 */
export function tryShatterRunnerGlassPlayer(rigPos, rigVel, headWx, headWy, headWz) {
  const fwd = rigVel.z;
  const horiz = Math.hypot(rigVel.x, rigVel.z);
  if (fwd < 1.65 && horiz < 2.1) return false;

  const pad = 0.14;
  const yMul = getRigSampleHeightMul();
  const rMul = getRunnerRadiusMul();
  const rm = 0.3 * rMul;

  for (let p = 0; p < runnerGlassPanes_.length; p++) {
    const pane = runnerGlassPanes_[p];
    if (pane.broken || !pane.obb) continue;
    const b = pane.obb;
    const test = (x, y, z, r) => {
      _runnerGlassLp.set(x - b.cx, y - b.cy, z - b.cz).applyMatrix3(b.mInv);
      return Math.abs(_runnerGlassLp.x) < b.hx + r + pad
        && Math.abs(_runnerGlassLp.y) < b.hy + r + pad
        && Math.abs(_runnerGlassLp.z) < b.hz + r + pad;
    };
    let hit = test(headWx, headWy, headWz, 0.12);
    if (!hit) {
      const torsoYs = [0.22, 0.75, 1.2, 1.65, 2.05, 2.5];
      for (let i = 0; i < torsoYs.length; i++) {
        const ys = torsoYs[i] * yMul;
        if (test(rigPos.x, rigPos.y + ys, rigPos.z, rm)) { hit = true; break; }
      }
    }
    if (hit) {
      shatterRunnerGlassPane_(pane);
      return true;
    }
  }
  return false;
}

export function getRunnerSceneObjects() {
  if (!levelGroup_) return [];
  const out = [];
  levelGroup_.traverse((o) => {
    if (o.isMesh) out.push(o);
  });
  return out;
}

/**
 * @param {THREE.Scene} scene
 * @param {object} [opts]
 * @param {boolean} [opts.shadows=true]
 */
export function initRunnerLevel(scene, opts = {}) {
  const shadows = opts.shadows !== false;
  collisionBoxes_.length = 0;
  if (levelGroup_) {
    scene.remove(levelGroup_);
    levelGroup_ = null;
  }
  runnerGlassPanes_.length = 0;
  runnerSceneRef_ = scene;
  clearAllGlassShards_();

  levelGroup_ = new THREE.Group();
  levelGroup_.name = "runner_level";

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xf2f2f2,
    roughness: 0.88,
    metalness: 0.05,
  });
  const doorMat = new THREE.MeshStandardMaterial({
    color: 0xd8d8d8,
    roughness: 0.75,
    metalness: 0.12,
  });
  const fridgeMat = new THREE.MeshStandardMaterial({
    color: 0xe8e4dc,
    roughness: 0.7,
    metalness: 0.08,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x8a8a8a,
    roughness: 0.82,
    metalness: 0.15,
  });

  /* ── Dimensions ───────────────────────────────────────────────────── */
  const wallH = 3.85;
  const wallY = wallH / 2;
  const hallHalfW = 0.92;
  hallHalfW_ = hallHalfW;
  const wallT = 0.24;
  /* 0.5 m total slab thickness — clearly reads as a real floor between stories. */
  const floorHalfThickness = 0.25;
  const floorCy = floorHalfThickness;
  const floorTopY = floorHalfThickness * 2;
  const ceilingSlabHalfY = 0.12;
  const storyShiftY = wallH + ceilingSlabHalfY * 2;
  /* Glass plane (+Z) — defined early so east wall/ceiling stop at the window, not past it. */
  const glassZ = 32.22;
  const glassHz = 0.065;
  const glassFrontZ = glassZ - glassHz;
  const eastWallZLen = glassFrontZ - 0.012;
  const eastWallZMid = eastWallZLen / 2;
  hallFloorClampZ1_ = glassFrontZ - 0.1;

  const upperStory = new THREE.Group();
  upperStory.name = "runner_upper_story";
  const lowerStory = new THREE.Group();
  lowerStory.name = "runner_lower_story";
  const lowestStory = new THREE.Group();
  lowestStory.name = "runner_lowest_story";
  levelGroup_.add(upperStory);
  levelGroup_.add(lowerStory);
  levelGroup_.add(lowestStory);

  const glassMatTemplate = new THREE.MeshStandardMaterial({
    color: 0xc8e8ff,
    metalness: 0.05,
    roughness: 0.05,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
  });
  /** One clone per story glass so disposing a shattered pane does not affect others. */
  const glassMatUpper = glassMatTemplate.clone();
  const glassMatMid = glassMatTemplate.clone();
  const glassMatLow = glassMatTemplate.clone();
  runnerGlassTemplateMat_ = glassMatTemplate;

  /**
   * @param {THREE.Group} storyGroup
   * @param {number} yBase world Y of this story’s floor slab bottom (= group.position.y)
   * @param {{ includeFridge: boolean, glassMat: THREE.MeshPhysicalMaterial }} storyOpts
   */
  function addRunnerMainStory(storyGroup, yBase, storyOpts) {
    const { includeFridge, glassMat } = storyOpts;
    storyGroup.position.set(0, yBase, 0);
    const wy = (/** @type {number} */ y) => y + yBase;

    /* One continuous floor (room + hall) — slab twice the old 0.08 m total thickness */
    const floorW = 10;
    const floorD = 42;
    addWallMesh(storyGroup, 0, floorCy, 11, floorW, floorTopY, floorD, wallMat);
    const floorObb = makeOBB(0, wy(floorCy), 11, floorW / 2, floorHalfThickness, floorD / 2, 0);
    floorObb.floorSlab = true;

    /* Starting room */
    const roomZMin = -7;
    const roomZMax = 0;
    const roomHalfX = 4;

    addWallMesh(storyGroup, 0, wallY, roomZMin - 0.2, roomHalfX * 2, wallH, 0.4, wallMat);
    makeOBB(0, wy(wallY), roomZMin - 0.2, roomHalfX, wallH / 2, 0.2, 0);
    addWallMesh(storyGroup, -roomHalfX - 0.2, wallY, (roomZMin + roomZMax) / 2, 0.4, wallH, -roomZMin + 0.2, wallMat);
    makeOBB(-roomHalfX - 0.2, wy(wallY), (roomZMin + roomZMax) / 2, 0.2, wallH / 2, (-roomZMin + 0.2) / 2, 0);
    addWallMesh(storyGroup, roomHalfX + 0.2, wallY, (roomZMin + roomZMax) / 2, 0.4, wallH, -roomZMin + 0.2, wallMat);
    makeOBB(roomHalfX + 0.2, wy(wallY), (roomZMin + roomZMax) / 2, 0.2, wallH / 2, (-roomZMin + 0.2) / 2, 0);
    const doorHalf = hallHalfW;
    const segW = (roomHalfX * 2 - doorHalf * 2) / 2;
    const segCxL = -roomHalfX + segW / 2;
    const segCxR = roomHalfX - segW / 2;
    addWallMesh(storyGroup, segCxL, wallY, roomZMax + 0.2, segW, wallH, 0.4, wallMat);
    makeOBB(segCxL, wy(wallY), roomZMax + 0.2, segW / 2, wallH / 2, 0.2, 0);
    addWallMesh(storyGroup, segCxR, wallY, roomZMax + 0.2, segW, wallH, 0.4, wallMat);
    makeOBB(segCxR, wy(wallY), roomZMax + 0.2, segW / 2, wallH / 2, 0.2, 0);

    const roomCeilCy = wallH + ceilingSlabHalfY;
    addWallMesh(storyGroup, 0, roomCeilCy, (roomZMin + roomZMax) / 2, roomHalfX * 2, ceilingSlabHalfY * 2, -roomZMin + 0.4, wallMat);
    makeOBB(0, wy(roomCeilCy), (roomZMin + roomZMax) / 2, roomHalfX, ceilingSlabHalfY, (-roomZMin + 0.4) / 2, 0);

    const westCx = -hallHalfW - wallT / 2;
    addWallMesh(storyGroup, westCx, wallY, eastWallZMid, wallT, wallH, eastWallZLen, wallMat);
    makeOBB(westCx, wy(wallY), eastWallZMid, wallT / 2, wallH / 2, eastWallZLen / 2, 0);

    const doorW = 1.18;
    const doorH = 2.68;
    const doorTh = 0.1;
    const doorFrameW = 1.32;
    const doorFrameH = 2.86;

    function addWestDoorAtZ(z) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(doorTh, doorH, doorW), doorMat);
      d.position.set(-hallHalfW + doorTh / 2 + 0.02, doorH / 2, z);
      if (shadows) d.castShadow = true;
      d.receiveShadow = true;
      storyGroup.add(d);
      const fr = new THREE.Mesh(new THREE.BoxGeometry(0.14, doorFrameH, doorFrameW), trimMat);
      fr.position.set(-hallHalfW + 0.02, doorFrameH / 2, z);
      fr.receiveShadow = true;
      storyGroup.add(fr);
    }
    const obstacleDoorZ = 13.65;
    for (const z of [6, obstacleDoorZ, 24]) addWestDoorAtZ(z);

    const eastCx = hallHalfW + wallT / 2;
    addWallMesh(storyGroup, eastCx, wallY, eastWallZMid, wallT, wallH, eastWallZLen, wallMat);
    makeOBB(eastCx, wy(wallY), eastWallZMid, wallT / 2, wallH / 2, eastWallZLen / 2, 0);

    const hallCeilCy = wallH + ceilingSlabHalfY;
    addWallMesh(storyGroup, 0, hallCeilCy, eastWallZMid, hallHalfW * 2, ceilingSlabHalfY * 2, eastWallZLen, wallMat);
    makeOBB(0, wy(hallCeilCy), eastWallZMid, hallHalfW, ceilingSlabHalfY, eastWallZLen / 2, 0);

    if (includeFridge) {
      const fridgeW = 0.66;
      const fridgeH = 1.84;
      const fridgeD = 0.9;
      const fridge = new THREE.Mesh(
        new THREE.BoxGeometry(fridgeW, fridgeH, fridgeD),
        fridgeMat,
      );
      fridge.position.set(0.22, fridgeH / 2 + 0.04, obstacleDoorZ);
      fridge.rotation.set(0, 0, Math.PI / 4, "XYZ");
      if (shadows) fridge.castShadow = true;
      fridge.receiveShadow = true;
      storyGroup.add(fridge);

      const fcx = fridge.position.x;
      const fcy = fridge.position.y;
      const fcz = fridge.position.z;
      const fhx = fridgeW / 2;
      const fhy = fridgeH / 2;
      const fhz = fridgeD / 2;
      makeOBBEuler(fcx, wy(fcy), fcz, fhx, fhy, fhz,
        fridge.rotation.x, fridge.rotation.y, fridge.rotation.z);
    }

    const glassHalfX = hallHalfW - 0.002;
    const ceilingBottomY = wallH - 0.01;
    const glassY0 = floorTopY + 0.008;
    const glassY1 = ceilingBottomY - 0.008;
    const glassCy = (glassY0 + glassY1) / 2;
    const glassHy = (glassY1 - glassY0) / 2;

    const glassMesh = new THREE.Mesh(
      new THREE.BoxGeometry(glassHalfX * 2, glassHy * 2, glassHz * 2),
      glassMat,
    );
    glassMesh.position.set(0, glassCy, glassZ);
    glassMesh.name = "runner_end_glass";
    if (shadows) glassMesh.castShadow = true;
    glassMesh.receiveShadow = true;
    storyGroup.add(glassMesh);

    const glassObb = makeOBB(0, wy(glassCy), glassZ, glassHalfX + 0.015, glassHy + 0.015, glassHz + 0.008, 0);
    glassObb.runnerGlass = true;
    runnerGlassPanes_.push({ obb: glassObb, mesh: glassMesh, broken: false });

    const endWingDepth = 0.44;
    const endWingHalfW = 5.0 / 2;
    const aWestOuterX = -hallHalfW - wallT;
    const aEastOuterX = hallHalfW + wallT;
    const wingLeftCx = aWestOuterX - endWingHalfW;
    const wingRightCx = aEastOuterX + endWingHalfW;
    addWallMesh(storyGroup, wingLeftCx, wallY, glassZ, 5.0, wallH, endWingDepth, wallMat);
    makeOBB(wingLeftCx, wy(wallY), glassZ, endWingHalfW, wallH / 2, endWingDepth / 2, 0);
    addWallMesh(storyGroup, wingRightCx, wallY, glassZ, 5.0, wallH, endWingDepth, wallMat);
    makeOBB(wingRightCx, wy(wallY), glassZ, endWingHalfW, wallH / 2, endWingDepth / 2, 0);

    return { aWestOuterX, aEastOuterX };
  }

  const { aWestOuterX, aEastOuterX } = addRunnerMainStory(upperStory, 0, {
    includeFridge: true,
    glassMat: glassMatUpper,
  });
  addRunnerMainStory(lowerStory, -storyShiftY, {
    includeFridge: false,
    glassMat: glassMatMid,
  });
  addRunnerMainStory(lowestStory, -2 * storyShiftY, {
    includeFridge: false,
    glassMat: glassMatLow,
  });

  /* 6 m open gap (+Z) past the glass, then neighbor: façades from base to roof underside; slab on top (all one block in Y). */
  const gapPastGlassZ = 6.0;
  const neighborRoofHalf = 5.0;
  const neighborDropY = 1.0;
  const neighborSinkY = 5.0;
  const glassRearZ = glassZ + glassHz;
  const roofZ0 = glassRearZ + gapPastGlassZ;
  const roofCz = roofZ0 + neighborRoofHalf;
  const roofTh = 0.2;
  const nbRoofTopY = wallH - neighborDropY - neighborSinkY;
  const roofCy = nbRoofTopY - roofTh / 2;
  const nbRoofBottomY = roofCy - roofTh / 2;
  const neighborBaseY = -neighborSinkY;
  const nbWallH = Math.max(0.15, nbRoofBottomY - neighborBaseY);
  const nbWallY = neighborBaseY + nbWallH / 2;
  const neighborRoofMat = new THREE.MeshStandardMaterial({
    color: 0x9a9894,
    roughness: 0.76,
    metalness: 0.1,
  });
  addWallMesh(
    levelGroup_, 0, roofCy, roofCz,
    neighborRoofHalf * 2, roofTh, neighborRoofHalf * 2,
    neighborRoofMat,
  );
  const neighborRoofObb = makeOBB(0, roofCy, roofCz, neighborRoofHalf, roofTh / 2, neighborRoofHalf, 0);
  neighborRoofObb.floorSlab = true;

  /* Façades: ground → roof underside (no masonry above the deck). */
  const nbFoot = neighborRoofHalf * 2 + wallT;
  const nbWestCx = -neighborRoofHalf - wallT / 2;
  const nbEastCx = neighborRoofHalf + wallT / 2;
  const nbNorthZ = roofCz - neighborRoofHalf - wallT / 2;
  const nbSouthZ = roofCz + neighborRoofHalf + wallT / 2;
  addWallMesh(levelGroup_, nbWestCx, nbWallY, roofCz, wallT, nbWallH, nbFoot, wallMat);
  makeOBB(nbWestCx, nbWallY, roofCz, wallT / 2, nbWallH / 2, nbFoot / 2, 0);
  addWallMesh(levelGroup_, nbEastCx, nbWallY, roofCz, wallT, nbWallH, nbFoot, wallMat);
  makeOBB(nbEastCx, nbWallY, roofCz, wallT / 2, nbWallH / 2, nbFoot / 2, 0);
  addWallMesh(levelGroup_, 0, nbWallY, nbNorthZ, nbFoot, nbWallH, wallT, wallMat);
  makeOBB(0, nbWallY, nbNorthZ, nbFoot / 2, nbWallH / 2, wallT / 2, 0);
  addWallMesh(levelGroup_, 0, nbWallY, nbSouthZ, nbFoot, nbWallH, wallT, wallMat);
  makeOBB(0, nbWallY, nbSouthZ, nbFoot / 2, nbWallH / 2, wallT / 2, 0);

  /* Slide assist past hall + roof (no far “cap” wall — fog/open sky beyond). */
  assistZ1_ = nbSouthZ + wallT / 2 + 10;
  const alleyWidth = 2.22;
  const bWestInnerX = aEastOuterX + alleyWidth;
  const bEastOuterX = bWestInnerX + wallT + 4.6;
  assistXHalf_ = Math.max(hallHalfW_, bEastOuterX) + 1.2;

  /* ── Load GLB model and place it on the neighbor roof ────────────────── */
  const nbRoofTopYFinal = roofCy + roofTh / 2;
  const gltfLoader = new GLTFLoader();
  gltfLoader.load(
    new URL("../3d/rooftops.glb", import.meta.url).href,
    (gltf) => {
      const model = gltf.scene;
      model.position.set(0, nbRoofTopYFinal - 12, roofCz);
      model.scale.setScalar(0.5);
      if (levelGroup_) {
        levelGroup_.add(model);
        model.updateMatrixWorld(true);
        if (!glbSharedWhiteMat_) {
          glbSharedWhiteMat_ = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.88,
            metalness: 0.05,
          });
        }
        model.traverse((child) => {
          if (child.isMesh && child.geometry) {
            disposeMeshMaterialsDeep_(child);
            child.material = glbSharedWhiteMat_;
            if (shadows) child.castShadow = true;
            child.receiveShadow = true;
            child.geometry.computeBoundsTree({
              maxLeafTris: 8,
              maxDepth: 30,
              strategy: 0,
            });
            child.geometry.computeBoundingSphere();
            glbCollisionMeshes_.push(child);
          }
        });
        recomputeGlbSlideFootprintXZ_();
        console.info(`[VRrunner] rooftops.glb loaded — ${glbCollisionMeshes_.length} BVH collision meshes`);
      }
    },
    undefined,
    (err) => console.warn("[VRrunner] failed to load rooftops.glb:", err),
  );

  scene.add(levelGroup_);
  console.info(
    `[VRrunner] level: hall ${(hallHalfW * 2).toFixed(2)} m wide · ceiling ${wallH} m · ` +
      `slide eye Y=${SLIDE_CAMERA_Y.toFixed(2)} m · ${collisionBoxes_.length} OBBs`,
  );
}

export function disposeRunnerLevel(scene) {
  for (let i = 0; i < runnerGlassPanes_.length; i++) {
    const pane = runnerGlassPanes_[i];
    if (pane.mesh) {
      pane.mesh.removeFromParent();
      pane.mesh.geometry?.dispose?.();
      const mat = pane.mesh.material;
      if (mat && !Array.isArray(mat)) mat.dispose?.();
    }
  }
  runnerGlassPanes_.length = 0;
  runnerGlassTemplateMat_?.dispose();
  runnerGlassTemplateMat_ = null;
  clearAllGlassShards_();
  runnerSceneRef_ = null;
  assistZ1_ = 28;
  assistXHalf_ = hallHalfW_;
  glbSlideXZ_ = null;
  hallFloorClampZ1_ = 31.5;
  if (levelGroup_) {
    scene.remove(levelGroup_);
    levelGroup_ = null;
  }
  collisionBoxes_.length = 0;
  /* Sandbox clones share template geometries — never dispose their BVHs here. */
  for (let i = glbCollisionMeshes_.length - 1; i >= 0; i--) {
    if (glbCollisionMeshes_[i].userData?.sandboxGlbAux) glbCollisionMeshes_.splice(i, 1);
  }
  for (let i = 0; i < glbCollisionMeshes_.length; i++) {
    const mesh = glbCollisionMeshes_[i];
    const g = mesh.geometry;
    if (g && g.disposeBoundsTree) g.disposeBoundsTree();
    mesh.material = null;
  }
  glbCollisionMeshes_.length = 0;
  if (glbSharedWhiteMat_) {
    glbSharedWhiteMat_.dispose();
    glbSharedWhiteMat_ = null;
  }
}
