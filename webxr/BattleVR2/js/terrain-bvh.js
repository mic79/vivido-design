/**
 * Full-map terrain contact via three-mesh-bvh.
 * Raycasts only traverse nearby BVH nodes — not the whole plate every query.
 */
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
} from 'three-mesh-bvh';

let patched = false;
/** @type {import('three').Mesh[]} */
let collideMeshes = [];
let ready = false;
let gen = 0;

const _origin = { x: 0, y: 0, z: 0 };
const _dir = { x: 0, y: -1, z: 0 };
/** @type {import('three').Raycaster | null} */
let _raycaster = null;
/** @type {import('three').Vector3 | null} */
let _vOrigin = null;
/** @type {import('three').Vector3 | null} */
let _vDir = null;
/** @type {import('three').Vector3 | null} */
let _nWorld = null;

function ensurePatched(THREE) {
  if (patched || !THREE) return;
  // Geometry helpers only — do NOT replace Mesh.prototype.raycast globally
  // (A-Frame UI / hand rays hit meshes with null geometry and crash).
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
  patched = true;
}

function isTerrainCollideMesh(mesh) {
  if (!mesh?.isMesh || !mesh.geometry) return false;
  if (mesh.userData?.rtsTerrainCollide === false) return false;
  if (mesh.userData?.rtsTerrainCollide === true) return true;
  if (mesh.userData?.rtsLobbyPlate) return true;
  const n = mesh.name || '';
  if (/^Prop_/i.test(n)) return false;
  if (mesh.userData?.rtsOverviewProps || mesh.userData?.rtsSeatedOnCrater) return false;
  if (/moon|terrain|ground|skirt|Hera|Moon_|plate|mesa/i.test(n)) return true;
  let p = mesh.parent;
  while (p) {
    if (p.name === 'rts-horizon-skirt') return true;
    if (p.userData?.rtsTerrainCollide) return true;
    if (p.userData?.rtsOverviewProps) return false;
    p = p.parent;
  }
  // Root ground mesh under #ground often unnamed after bake — include leaf meshes
  // that are direct/near children of the ground object3D mesh root.
  return false;
}

function bakeMesh(mesh) {
  const geo = mesh.geometry;
  if (!geo || !geo.attributes?.position) return;
  try {
    if (geo.boundsTree) {
      if (typeof geo.boundsTree.refit === 'function') geo.boundsTree.refit();
    } else if (typeof geo.computeBoundsTree === 'function') {
      geo.computeBoundsTree({ maxLeafTris: 16 });
    }
    // Per-mesh accelerated raycast only (keeps global Mesh.raycast intact).
    mesh.raycast = acceleratedRaycast;
    mesh.userData.rtsTerrainCollide = true;
  } catch (err) {
    console.warn('[BattleVR2] terrain BVH bake failed', mesh.name, err);
  }
}

/**
 * Rebuild collide list from `#ground` (central plate + horizon skirts).
 * Call after moon visuals / skirt attach / terrain rebuild.
 */
export function rebuildFromGroundEl(groundEl = null) {
  const THREE = window.THREE;
  if (!THREE) return false;
  ensurePatched(THREE);

  const el = groundEl || document.getElementById('ground');
  const root = el?.getObject3D?.('mesh') || el?.object3D;
  if (!root) {
    collideMeshes = [];
    ready = false;
    return false;
  }

  root.updateWorldMatrix(true, true);
  const next = [];
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    // Always include the primary plate mesh + anything under horizon skirt.
    const underSkirt = (() => {
      let p = obj.parent;
      while (p) {
        if (p.name === 'rts-horizon-skirt') return true;
        p = p.parent;
      }
      return false;
    })();
    const isRootPlate = obj === root || obj.name === 'rts-ground-mesh' || obj.name === 'rts-lobby-ground';
    if (underSkirt || isRootPlate || isTerrainCollideMesh(obj)) {
      // Skip tiny detail / rock props under bake
      if (/^Prop_/i.test(obj.name || '')) return;
      if (obj.userData?.rtsOverviewProps) return;
      bakeMesh(obj);
      if (obj.geometry.boundsTree) next.push(obj);
    }
  });

  // Baked moon: many Moon_* / Terrain_* cells — include any mesh with a boundsTree we baked,
  // or large ground-like meshes without Prop_ prefix.
  if (next.length < 2) {
    root.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      if (/^Prop_/i.test(obj.name || '')) return;
      if (obj.userData?.rtsOverviewProps || obj.userData?.rtsSeatedClone) return;
      const pos = obj.geometry.getAttribute?.('position');
      if (!pos || pos.count < 12) return;
      bakeMesh(obj);
      if (obj.geometry.boundsTree && !next.includes(obj)) next.push(obj);
    });
  }

  collideMeshes = next;
  ready = collideMeshes.length > 0;
  gen++;
  window.__BATTLEVR2_TERRAIN_BVH__ = {
    ready,
    gen,
    meshCount: collideMeshes.length,
    sampleY: (x, z, hintY) => sampleTerrainBvhY(x, z, hintY),
    sampleHit: (x, z, hintY) => sampleTerrainBvhHit(x, z, hintY),
    rebuild: rebuildFromGroundEl,
  };
  console.log('[BattleVR2] terrain BVH ready', {
    meshes: collideMeshes.length,
    gen,
    names: collideMeshes.slice(0, 8).map((m) => m.name || m.parent?.name || '?'),
  });
  return ready;
}

export function isTerrainBvhReady() {
  return ready && collideMeshes.length > 0;
}

export function getTerrainBvhGen() {
  return gen;
}

function ensureRayTools(THREE) {
  if (!_raycaster) {
    _raycaster = new THREE.Raycaster();
    _raycaster.firstHitOnly = true;
    _vOrigin = new THREE.Vector3();
    _vDir = new THREE.Vector3(0, -1, 0);
    _nWorld = new THREE.Vector3();
  }
}

/**
 * Nearby-only downward BVH ray. Uses a short band around hintY so the tree
 * only visits local nodes (full-map sky rays are avoided).
 * @returns {{ y: number, nx: number, ny: number, nz: number, dist: number } | null}
 */
export function sampleTerrainBvhHit(x, z, hintY = null) {
  if (!ready || !collideMeshes.length) return null;
  const THREE = window.THREE;
  if (!THREE) return null;
  ensureRayTools(THREE);

  // Moon bowls sit well below y=0 — short bands that stop near 0 miss the real surface
  // and leave contact on stale/high samples (player looks “floating” over canyons).
  const bandTop = Number.isFinite(hintY) ? Math.max(hintY + 16, 40) : 120;
  const maxDist = Number.isFinite(hintY) ? Math.max(80, bandTop + 80) : 220;

  _vOrigin.set(x, bandTop, z);
  _vDir.set(0, -1, 0);
  _raycaster.set(_vOrigin, _vDir);
  _raycaster.far = maxDist;
  _raycaster.near = 0;

  // Prefer firstHitOnly per-mesh; take highest surface under the probe.
  let best = null;
  for (let i = 0; i < collideMeshes.length; i++) {
    const mesh = collideMeshes[i];
    if (!mesh.visible || !mesh.geometry?.boundsTree) continue;
    let hits;
    try {
      hits = _raycaster.intersectObject(mesh, false);
    } catch (_) {
      continue;
    }
    if (!hits.length) continue;
    const h = hits[0];
    if (!best || h.point.y > best.point.y) best = h;
  }
  if (!best) return null;

  let nx = 0;
  let ny = 1;
  let nz = 0;
  if (best.face && best.object) {
    _nWorld.copy(best.face.normal).transformDirection(best.object.matrixWorld).normalize();
    nx = _nWorld.x;
    ny = _nWorld.y;
    nz = _nWorld.z;
    // Flip if facing down
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
  } else if (best.normal) {
    nx = best.normal.x;
    ny = best.normal.y;
    nz = best.normal.z;
  }

  return {
    y: best.point.y,
    nx,
    ny,
    nz,
    dist: best.distance,
  };
}

/** Height only — falls back null when BVH miss. */
export function sampleTerrainBvhY(x, z, hintY = null) {
  const hit = sampleTerrainBvhHit(x, z, hintY);
  return hit ? hit.y : null;
}

// Scratch unused but kept for future shapecast vehicle hull
void _origin;
void _dir;
