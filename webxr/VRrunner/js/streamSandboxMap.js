/**
 * VRrunner — optional 3D sector streaming sandbox (?map=1 default).
 * 100×100×100 m cells, active 3×3×3 around the player, wireframe bounds +
 * 10 m cube at each cell centre (OBB collision).
 *
 * **Pizzaplex** (`the_pizzaplex_entrance_no_texture.glb`, ~105k tris): **on by default** —
 * one **clone per active sector** in the 3³ ring, cell-fitted, merged + Lambert where
 * possible (distant cells). **Your current sector** uses an **unmerged** clone with
 * original materials so the full GLB shows. GLB strip/attach is **queued** and spread across
 * frames (`MAX_SECTOR_GLB_JOBS_PER_FRAME`) so the stream ring does not hitch.
 * Sector **shell** unload/load is also queued (`MAX_STREAM_SHELL_JOBS_PER_FRAME` per pass).
 * Merged distant shells share one baked `BufferGeometry` + BVH (built once) across sectors.
 * `?pizzaplex=0` disables. `?sectormerge=0` or `?roofmerge=0` skips merge on non-player sectors.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  registerSandboxGlbCollisionMeshes,
  unregisterSandboxGlbCollisionMeshes,
} from "./runnerLevel.js";

export const SANDBOX_SECTOR = 100;
/** Active window half-extent in cells → (2*1+1)³ = 27 sectors. */
const ACTIVE_HALF = 1;
const CUBE_HALF = 5;
/** Strip/attach pizzaplex jobs processed per `processSectorGlbJobs_` call. */
const MAX_SECTOR_GLB_JOBS_PER_FRAME = 2;
/** Sector shell unload / load jobs per `processStreamShellJobs_` call (heavy part of a boundary cross). */
const MAX_STREAM_SHELL_JOBS_PER_FRAME = 1;

const PIZZAPLEX_URL = new URL(
  "../3d/the_pizzaplex_entrance_no_texture.glb",
  import.meta.url,
).href;

const _origin = new THREE.Vector3();
const _floorLp = new THREE.Vector3();
const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();
const _invRoot = new THREE.Matrix4();
const _relMat = new THREE.Matrix4();
/** Last rig position passed to streaming (for GLB load callback). */
const lastStreamPos_ = new THREE.Vector3(50, 55, 50);

/** @type {{ type: 'strip' | 'attach', key: string }[]} */
const sectorGlbJobs_ = [];
/** @type {{ type: 'unload' | 'loadShell', key: string }[]} */
const streamShellJobs_ = [];

/** @type {THREE.Scene | null} */
let scene_ = null;
/** Root group in scene. */
let rootGroup_ = null;
/** When false, no per-sector pizzaplex load (`?pizzaplex=0`). */
let sectorGlbEnabled_ = true;
let shadows_ = true;

/** Pizzaplex template (never added to scene); per-sector clones share its geometries. */
let sectorGlbTemplateRoot_ = /** @type {THREE.Object3D | null} */ (null);
let sectorGlbLoadStarted_ = false;
/** Shared Lambert material for per-sector pizzaplex clones. */
let sandboxSectorGlbMat_ = /** @type {THREE.MeshLambertMaterial | null} */ (null);
/** One merged pizzaplex hull in sector-local space (identical for every cell after fit). */
let cachedMergedSectorGeom_ = /** @type {THREE.BufferGeometry | null} */ (null);
let cachedMergedGeomRefCount_ = 0;

/** @type {Map<string, { group: THREE.Group, collision: object[], outline: THREE.LineSegments, cube: THREE.Mesh, sectorGlbRoot: THREE.Object3D | null, sectorGlbMeshes: THREE.Mesh[] | null, sectorGlbOwnsMergedGeometry?: boolean, sectorGlbMergedCacheRef?: boolean, sectorGlbFullDetail?: boolean }>} */
const loaded_ = new Map();
/** Flattened OBB list (same shape as runnerLevel collision boxes). */
const activeCollision_ = [];
let lastKey_ = /** @type {string | null} */ (null);
/** Bumped on each `initStreamSandbox` so late GLB callbacks cannot attach to a new session. */
let streamSandboxGen_ = 0;
/** Last cell key used for full-detail pizzaplex swap (see `reconcileSectorGlbDetailForPlayer_`). */
let lastSectorGlbPlayerKey_ = /** @type {string | null} */ (null);

/** Default ON; `?pizzaplex=0` / `false` / `no` skips per-sector pizzaplex. */
function readSectorGlbUrlFlag() {
  try {
    const p = new URLSearchParams(window.location.search).get("pizzaplex");
    if (p === "0" || p === "false" || p === "no") return false;
    return true;
  } catch (_) {
    return true;
  }
}

/** When false, per-sector GLB stays multi-mesh (`?sectormerge=0` or `?roofmerge=0`). */
function readSectorGlbMergeFlag() {
  try {
    const q = new URLSearchParams(window.location.search);
    const v = q.get("sectormerge") ?? q.get("roofmerge");
    return v !== "0" && v !== "false";
  } catch (_) {
    return true;
  }
}

function key3(sx, sy, sz) {
  return `${sx},${sy},${sz}`;
}

function playerSectorKeyFromPos_(/** @type {THREE.Vector3} */ pos) {
  const sx = Math.floor(pos.x / SANDBOX_SECTOR);
  const sy = Math.floor(pos.y / SANDBOX_SECTOR);
  const sz = Math.floor(pos.z / SANDBOX_SECTOR);
  return key3(sx, sy, sz);
}

/** Squared distance from `pos` to the centre of the cell for `key` (sx,sy,sz). */
function distSqPosToCellKey_(/** @type {THREE.Vector3} */ pos, /** @type {string} */ key) {
  const parts = key.split(",").map(Number);
  const ix = parts[0];
  const iy = parts[1];
  const iz = parts[2];
  const cx = ix * SANDBOX_SECTOR + SANDBOX_SECTOR * 0.5;
  const cy = iy * SANDBOX_SECTOR + SANDBOX_SECTOR * 0.5;
  const cz = iz * SANDBOX_SECTOR + SANDBOX_SECTOR * 0.5;
  const dx = pos.x - cx;
  const dy = pos.y - cy;
  const dz = pos.z - cz;
  return dx * dx + dy * dy + dz * dz;
}

function removePendingSectorGlbJobsForKey_(/** @type {string} */ key) {
  for (let i = sectorGlbJobs_.length - 1; i >= 0; i--) {
    if (sectorGlbJobs_[i].key === key) sectorGlbJobs_.splice(i, 1);
  }
}

function sectorGlbHasPendingAttach_(/** @type {string} */ key) {
  for (let i = 0; i < sectorGlbJobs_.length; i++) {
    if (sectorGlbJobs_[i].key === key && sectorGlbJobs_[i].type === "attach") return true;
  }
  return false;
}

/**
 * Queue attach jobs; player cell first. Drops stale pending jobs for the same keys.
 * @param {string[]} keys
 * @param {string} playerKey — sector key the player is in (for sort priority).
 * @param {boolean} [toFront] — if true, prepend batch so it runs before the rest of the queue.
 */
function enqueueSectorGlbAttaches_(keys, playerKey, toFront = false) {
  if (!sectorGlbEnabled_) return;
  const uniq = [...new Set(keys)].filter((k) => loaded_.has(k));
  uniq.sort((a, b) => {
    if (a === playerKey) return -1;
    if (b === playerKey) return 1;
    return 0;
  });
  const batch = [];
  for (let i = 0; i < uniq.length; i++) {
    const k = uniq[i];
    const rec = loaded_.get(k);
    if (rec.sectorGlbRoot) continue;
    removePendingSectorGlbJobsForKey_(k);
    batch.push({ type: "attach", key: k });
  }
  if (batch.length === 0) return;
  if (toFront) {
    for (let i = batch.length - 1; i >= 0; i--) sectorGlbJobs_.unshift(batch[i]);
  } else {
    for (let i = 0; i < batch.length; i++) sectorGlbJobs_.push(batch[i]);
  }
}

/** Prepend strip/attach pairs (last in `jobs` runs first after unshifting). */
function prependSectorGlbJobs_(/** @type {{ type: 'strip' | 'attach', key: string }[]} */ jobs) {
  for (let i = jobs.length - 1; i >= 0; i--) {
    sectorGlbJobs_.unshift(jobs[i]);
  }
}

function pruneStreamShellQueue_(/** @type {Set<string>} */ want) {
  for (let i = streamShellJobs_.length - 1; i >= 0; i--) {
    const j = streamShellJobs_[i];
    if (j.type === "unload") {
      if (want.has(j.key)) streamShellJobs_.splice(i, 1);
    } else if (loaded_.has(j.key) || !want.has(j.key)) {
      streamShellJobs_.splice(i, 1);
    }
  }
}

/**
 * @param {number} [maxJobs]
 * @returns {boolean} true if any job ran (caller may rebuild collision once).
 */
function processStreamShellJobs_(maxJobs = MAX_STREAM_SHELL_JOBS_PER_FRAME) {
  let ran = false;
  let n = 0;
  while (n < maxJobs && streamShellJobs_.length > 0) {
    const j = streamShellJobs_.shift();
    if (!j) break;
    if (j.type === "unload") {
      if (!loaded_.has(j.key)) continue;
      unloadSector_(j.key);
    } else {
      if (loaded_.has(j.key)) continue;
      const parts = j.key.split(",").map(Number);
      const ix = parts[0];
      const iy = parts[1];
      const iz = parts[2];
      loadSector_(ix, iy, iz);
      if (sectorGlbEnabled_) {
        enqueueSectorGlbAttaches_([j.key], playerSectorKeyFromPos_(lastStreamPos_), false);
      }
    }
    ran = true;
    n++;
  }
  return ran;
}

function processSectorGlbJobs_() {
  let n = 0;
  while (n < MAX_SECTOR_GLB_JOBS_PER_FRAME && sectorGlbJobs_.length > 0) {
    const job = sectorGlbJobs_.shift();
    if (!job) break;
    const rec = loaded_.get(job.key);
    if (!rec) continue;
    if (job.type === "strip") {
      stripSectorGlbFromRecord_(rec);
      n++;
      continue;
    }
    if (rec.sectorGlbRoot) continue;
    if (!sectorGlbTemplateRoot_) {
      sectorGlbJobs_.unshift(job);
      break;
    }
    attachSectorGlbForKey_(job.key);
    n++;
  }
}

function makeAxisOBB(cx, cy, cz, hx, hy, hz, floorSlab) {
  const m = new THREE.Matrix3();
  m.identity();
  const mInv = new THREE.Matrix3();
  mInv.identity();
  /** @type {{ cx:number,cy:number,cz:number,hx:number,hy:number,hz:number,m:THREE.Matrix3,mInv:THREE.Matrix3, floorSlab?: boolean }} */
  const b = { cx, cy, cz, hx, hy, hz, m, mInv };
  if (floorSlab) b.floorSlab = true;
  return b;
}

function rebuildCollisionFlat_() {
  activeCollision_.length = 0;
  for (const { collision } of loaded_.values()) {
    for (let i = 0; i < collision.length; i++) activeCollision_.push(collision[i]);
  }
}

/** Scale and position `root` in sector-local space so its AABB fits in the cell. */
function fitObjectInSectorCellLocal_(root, fillFrac = 0.88) {
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);
  _box.setFromObject(root);
  _box.getSize(_size);
  const maxDim = Math.max(_size.x, _size.y, _size.z, 1e-4);
  const s = (SANDBOX_SECTOR * fillFrac) / maxDim;
  root.scale.setScalar(s);
  root.updateMatrixWorld(true);
  _box.setFromObject(root);
  _box.getCenter(_center);
  const half = SANDBOX_SECTOR * 0.5;
  root.position.set(half - _center.x, half - _center.y, half - _center.z);
  root.updateMatrixWorld(true);
}

function disposeSectorGlbTemplate_() {
  if (sandboxSectorGlbMat_) {
    sandboxSectorGlbMat_.dispose();
    sandboxSectorGlbMat_ = null;
  }
  if (sectorGlbTemplateRoot_) {
    sectorGlbTemplateRoot_.traverse((o) => {
      if (o.isMesh) {
        const g = o.geometry;
        if (g?.disposeBoundsTree) g.disposeBoundsTree();
        g?.dispose?.();
        const mat = o.material;
        if (Array.isArray(mat)) {
          for (let i = 0; i < mat.length; i++) mat[i]?.dispose?.();
        } else {
          mat?.dispose?.();
        }
      }
    });
    sectorGlbTemplateRoot_ = null;
  }
  sectorGlbLoadStarted_ = false;
  if (cachedMergedSectorGeom_) {
    const g = cachedMergedSectorGeom_;
    if (g?.disposeBoundsTree) g.disposeBoundsTree();
    g?.dispose?.();
    cachedMergedSectorGeom_ = null;
  }
  cachedMergedGeomRefCount_ = 0;
}

/**
 * Bake fitted GLB hierarchy into one BufferGeometry in **sector-group local** space.
 * `work` must already be a child of `sectorGroup` with `updateMatrixWorld` run.
 */
function tryMergeSectorGlbParts_(sectorGroup, work) {
  sectorGroup.updateMatrixWorld(true);
  work.updateMatrixWorld(true);
  _invRoot.copy(sectorGroup.matrixWorld).invert();

  /** @type {THREE.BufferGeometry[]} */
  const partGeoms = [];
  work.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const g = o.geometry.clone();
      g.deleteAttribute("tangent");
      g.deleteAttribute("uv2");
      _relMat.multiplyMatrices(_invRoot, o.matrixWorld);
      g.applyMatrix4(_relMat);
      partGeoms.push(g);
    }
  });

  if (partGeoms.length === 0) return null;

  let anyColor = false;
  let allColor = true;
  for (let i = 0; i < partGeoms.length; i++) {
    if (partGeoms[i].getAttribute("color")) anyColor = true;
    else allColor = false;
  }
  if (anyColor && !allColor) {
    for (let i = 0; i < partGeoms.length; i++) {
      partGeoms[i].deleteAttribute("color");
    }
  }

  let merged = mergeGeometries(partGeoms, false);
  if (!merged) {
    for (let i = 0; i < partGeoms.length; i++) {
      partGeoms[i].deleteAttribute("uv");
    }
    merged = mergeGeometries(partGeoms, false);
  }

  for (let i = 0; i < partGeoms.length; i++) {
    partGeoms[i].dispose();
  }
  return merged;
}

function disposeCloneHierarchyMaterials_(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    const old = o.material;
    if (Array.isArray(old)) {
      for (let i = 0; i < old.length; i++) old[i]?.dispose?.();
    } else {
      old?.dispose?.();
    }
    o.material = null;
  });
}

function stripSectorGlbFromRecord_(rec) {
  if (rec.sectorGlbMeshes?.length) {
    unregisterSandboxGlbCollisionMeshes(rec.sectorGlbMeshes);
    if (rec.sectorGlbMergedCacheRef) {
      rec.sectorGlbMergedCacheRef = false;
      cachedMergedGeomRefCount_--;
      if (
        cachedMergedGeomRefCount_ <= 0 &&
        cachedMergedSectorGeom_
      ) {
        const g = cachedMergedSectorGeom_;
        if (g?.disposeBoundsTree) g.disposeBoundsTree();
        g?.dispose?.();
        cachedMergedSectorGeom_ = null;
      }
    } else if (rec.sectorGlbOwnsMergedGeometry) {
      for (let i = 0; i < rec.sectorGlbMeshes.length; i++) {
        const m = rec.sectorGlbMeshes[i];
        const g = m.geometry;
        if (g?.disposeBoundsTree) g.disposeBoundsTree();
        g?.dispose?.();
      }
    }
    /* Full-detail clones share materials/geometries with the GLB template — never dispose here. */
    rec.sectorGlbMeshes = null;
  }
  rec.sectorGlbOwnsMergedGeometry = false;
  rec.sectorGlbMergedCacheRef = false;
  rec.sectorGlbFullDetail = false;
  if (rec.sectorGlbRoot) {
    rec.sectorGlbRoot.removeFromParent();
    rec.sectorGlbRoot = null;
  }
}

/** @param {string} key */
function attachSectorGlbForKey_(key) {
  const rec = loaded_.get(key);
  if (!rec || !sectorGlbTemplateRoot_ || rec.sectorGlbRoot) return;

  const fullDetail = key === playerSectorKeyFromPos_(lastStreamPos_);

  if (fullDetail) {
    rec.sectorGlbFullDetail = true;
    rec.sectorGlbOwnsMergedGeometry = false;
    const work = sectorGlbTemplateRoot_.clone(true);
    work.name = `sandbox_pizzaplex_full_${key}`;
    fitObjectInSectorCellLocal_(work, 0.88);
    rec.group.add(work);
    work.updateMatrixWorld(true);
    /** @type {THREE.Mesh[]} */
    const meshes = [];
    work.traverse((o) => {
      if (o.isMesh && o.geometry) {
        o.castShadow = shadows_;
        o.receiveShadow = shadows_;
        o.frustumCulled = true;
        meshes.push(o);
      }
    });
    registerSandboxGlbCollisionMeshes(meshes);
    rec.sectorGlbRoot = work;
    rec.sectorGlbMeshes = meshes;
    return;
  }

  rec.sectorGlbFullDetail = false;

  if (!sandboxSectorGlbMat_) {
    sandboxSectorGlbMat_ = new THREE.MeshLambertMaterial({
      color: 0xdedede,
      emissive: 0x202028,
      emissiveIntensity: 0.28,
    });
  }

  const work = sectorGlbTemplateRoot_.clone(true);
  work.name = `sandbox_pizzaplex_work_${key}`;
  fitObjectInSectorCellLocal_(work, 0.88);
  rec.group.add(work);
  work.updateMatrixWorld(true);

  const useMerge = readSectorGlbMergeFlag();
  if (useMerge && cachedMergedSectorGeom_) {
    disposeCloneHierarchyMaterials_(work);
    rec.group.remove(work);
    const root = new THREE.Group();
    root.name = `sandbox_pizzaplex_${key}`;
    const mesh = new THREE.Mesh(cachedMergedSectorGeom_, sandboxSectorGlbMat_);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    root.add(mesh);
    rec.group.add(root);
    root.updateMatrixWorld(true);
    registerSandboxGlbCollisionMeshes([mesh]);
    rec.sectorGlbRoot = root;
    rec.sectorGlbMeshes = [mesh];
    rec.sectorGlbOwnsMergedGeometry = false;
    rec.sectorGlbMergedCacheRef = true;
    cachedMergedGeomRefCount_++;
    return;
  }

  const mergedGeom = useMerge ? tryMergeSectorGlbParts_(rec.group, work) : null;

  if (mergedGeom) {
    disposeCloneHierarchyMaterials_(work);
    rec.group.remove(work);
    mergedGeom.computeBoundingSphere();
    if (!cachedMergedSectorGeom_) {
      cachedMergedSectorGeom_ = mergedGeom;
    }
    const geomForMesh = cachedMergedSectorGeom_;
    const root = new THREE.Group();
    root.name = `sandbox_pizzaplex_${key}`;
    const mesh = new THREE.Mesh(geomForMesh, sandboxSectorGlbMat_);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = true;
    root.add(mesh);
    rec.group.add(root);
    root.updateMatrixWorld(true);
    registerSandboxGlbCollisionMeshes([mesh]);
    rec.sectorGlbRoot = root;
    rec.sectorGlbMeshes = [mesh];
    rec.sectorGlbOwnsMergedGeometry = false;
    rec.sectorGlbMergedCacheRef = true;
    cachedMergedGeomRefCount_++;
    return;
  }

  rec.sectorGlbOwnsMergedGeometry = false;
  work.name = `sandbox_pizzaplex_${key}`;
  /** @type {THREE.Mesh[]} */
  const meshes = [];
  work.traverse((o) => {
    if (o.isMesh && o.geometry) {
      const old = o.material;
      if (Array.isArray(old)) {
        for (let i = 0; i < old.length; i++) old[i]?.dispose?.();
      } else {
        old?.dispose?.();
      }
      o.material = sandboxSectorGlbMat_;
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = true;
      meshes.push(o);
    }
  });

  work.updateMatrixWorld(true);
  registerSandboxGlbCollisionMeshes(meshes);
  rec.sectorGlbRoot = work;
  rec.sectorGlbMeshes = meshes;
}

function reconcileSectorGlbDetailForPlayer_(/** @type {THREE.Vector3} */ pos) {
  if (!rootGroup_ || !sectorGlbTemplateRoot_ || !sectorGlbEnabled_) return;
  const pk = playerSectorKeyFromPos_(pos);
  if (pk === lastSectorGlbPlayerKey_) return;
  const oldPk = lastSectorGlbPlayerKey_;

  removePendingSectorGlbJobsForKey_(pk);
  if (oldPk) removePendingSectorGlbJobsForKey_(oldPk);

  /** @type {{ type: 'strip' | 'attach', key: string }[]} */
  const front = [];
  /* Prefer upgrading the new player cell (strip merged → attach full) before downgrading the old cell. */
  if (loaded_.has(pk)) {
    const recNew = loaded_.get(pk);
    if (!recNew.sectorGlbFullDetail && recNew.sectorGlbRoot) {
      front.push({ type: "strip", key: pk }, { type: "attach", key: pk });
    } else if (!recNew.sectorGlbRoot && !sectorGlbHasPendingAttach_(pk)) {
      front.push({ type: "attach", key: pk });
    }
  }
  if (oldPk && loaded_.has(oldPk)) {
    const recOld = loaded_.get(oldPk);
    if (recOld.sectorGlbFullDetail && recOld.sectorGlbRoot) {
      front.push({ type: "strip", key: oldPk }, { type: "attach", key: oldPk });
    }
  }
  if (front.length) prependSectorGlbJobs_(front);
  lastSectorGlbPlayerKey_ = pk;
}

function startSectorGlbLoad_() {
  if (!sectorGlbEnabled_ || sectorGlbLoadStarted_) return;
  sectorGlbLoadStarted_ = true;
  const gen = streamSandboxGen_;
  const loader = new GLTFLoader();
  loader.load(
    PIZZAPLEX_URL,
    (gltf) => {
      if (!rootGroup_ || gen !== streamSandboxGen_) {
        const orphan = gltf.scene;
        orphan.traverse((o) => {
          if (o.isMesh) {
            const g = o.geometry;
            if (g?.disposeBoundsTree) g.disposeBoundsTree();
            g?.dispose?.();
            const mat = o.material;
            if (Array.isArray(mat)) {
              for (let i = 0; i < mat.length; i++) mat[i]?.dispose?.();
            } else {
              mat?.dispose?.();
            }
          }
        });
        if (gen === streamSandboxGen_) sectorGlbLoadStarted_ = false;
        return;
      }
      sectorGlbTemplateRoot_ = gltf.scene;
      sectorGlbTemplateRoot_.name = "pizzaplex_sandbox_template";
      const pk0 = playerSectorKeyFromPos_(lastStreamPos_);
      enqueueSectorGlbAttaches_([...loaded_.keys()], pk0, false);
      lastSectorGlbPlayerKey_ = pk0;
      console.info(
        "[VRrunner] sandbox: pizzaplex per sector (~105k tris) — **full GLB in your cell**, merged+Lambert elsewhere; "
          + `shell unload/load ${MAX_STREAM_SHELL_JOBS_PER_FRAME}/pass, GLB ${MAX_SECTOR_GLB_JOBS_PER_FRAME}/pass (two passes/frame). `
          + `${loaded_.size} sector(s). ?sectormerge=0 / ?roofmerge=0 skips merge on distant cells.`,
      );
    },
    undefined,
    (err) => {
      console.warn("[VRrunner] sandbox: failed to load pizzaplex GLB:", PIZZAPLEX_URL, err);
      if (gen === streamSandboxGen_) sectorGlbLoadStarted_ = false;
    },
  );
}

function unloadSector_(key) {
  const rec = loaded_.get(key);
  if (!rec || !rootGroup_) return;

  removePendingSectorGlbJobsForKey_(key);
  stripSectorGlbFromRecord_(rec);

  rec.outline.geometry?.dispose?.();
  rec.outline.material?.dispose?.();
  rec.cube.geometry?.dispose?.();
  const cm = rec.cube.material;
  if (cm && !Array.isArray(cm)) cm.dispose?.();
  rootGroup_.remove(rec.group);
  loaded_.delete(key);
}

function loadSector_(sx, sy, sz) {
  const key = key3(sx, sy, sz);
  if (loaded_.has(key)) return;

  const g = new THREE.Group();
  g.name = `sandbox_sector_${key}`;

  _origin.set(sx * SANDBOX_SECTOR, sy * SANDBOX_SECTOR, sz * SANDBOX_SECTOR);
  g.position.copy(_origin);

  const cx = SANDBOX_SECTOR * 0.5;
  const cy = SANDBOX_SECTOR * 0.5;
  const cz = SANDBOX_SECTOR * 0.5;

  const edgeGeo = new THREE.EdgesGeometry(
    new THREE.BoxGeometry(SANDBOX_SECTOR, SANDBOX_SECTOR, SANDBOX_SECTOR),
  );
  const edgeMat = new THREE.LineBasicMaterial({
    color: 0x55b4e8,
    transparent: true,
    opacity: 0.95,
    depthTest: true,
  });
  const outline = new THREE.LineSegments(edgeGeo, edgeMat);
  outline.position.set(cx, cy, cz);
  outline.frustumCulled = false;
  g.add(outline);

  const cubeMat = new THREE.MeshStandardMaterial({
    color: 0xeeeeee,
    roughness: 0.78,
    metalness: 0.06,
  });
  const cube = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), cubeMat);
  cube.position.set(cx, cy, cz);
  cube.castShadow = true;
  cube.receiveShadow = true;
  cube.name = `sandbox_cube_${key}`;
  g.add(cube);

  rootGroup_.add(g);

  const wx = _origin.x + cx;
  const wy = _origin.y + cy;
  const wz = _origin.z + cz;

  const collision = [
    makeAxisOBB(wx, wy, wz, CUBE_HALF, CUBE_HALF, CUBE_HALF, false),
    makeAxisOBB(wx, wy + CUBE_HALF - 0.04, wz, CUBE_HALF, 0.05, CUBE_HALF, true),
  ];

  loaded_.set(key, {
    group: g,
    collision,
    outline,
    cube,
    sectorGlbRoot: null,
    sectorGlbMeshes: null,
    sectorGlbOwnsMergedGeometry: false,
    sectorGlbMergedCacheRef: false,
    sectorGlbFullDetail: false,
  });
}

/**
 * @param {THREE.Scene} scene
 * @param {{ shadows?: boolean, pizzaplex?: boolean }} [opts] — `pizzaplex: false` skips per-sector GLB.
 */
export function initStreamSandbox(scene, opts = {}) {
  disposeStreamSandbox(scene);
  streamSandboxGen_++;
  scene_ = scene;
  shadows_ = opts.shadows !== false;
  if (typeof opts.pizzaplex === "boolean") {
    sectorGlbEnabled_ = opts.pizzaplex;
  } else {
    sectorGlbEnabled_ = readSectorGlbUrlFlag();
  }
  rootGroup_ = new THREE.Group();
  rootGroup_.name = "stream_sandbox_root";
  scene.add(rootGroup_);
  lastKey_ = null;
  lastSectorGlbPlayerKey_ = null;
  lastStreamPos_.set(50, 55, 50);
  if (sectorGlbEnabled_) {
    startSectorGlbLoad_();
  } else {
    console.info(
      "[VRrunner] sandbox: per-sector pizzaplex GLB disabled (?pizzaplex=0).",
    );
  }
}

/**
 * @param {THREE.Scene | null} scene
 */
export function disposeStreamSandbox(scene = null) {
  const sc = scene || scene_;
  sectorGlbJobs_.length = 0;
  streamShellJobs_.length = 0;
  lastSectorGlbPlayerKey_ = null;
  if (rootGroup_ && sc) {
    for (const k of [...loaded_.keys()]) unloadSector_(k);
    sc.remove(rootGroup_);
  }
  rootGroup_ = null;
  scene_ = null;
  lastKey_ = null;
  activeCollision_.length = 0;
  disposeSectorGlbTemplate_();
}

/**
 * @param {THREE.Vector3} pos
 * @returns {boolean} true if the active sector set changed (load/unload ran).
 */
export function updateStreamSandbox(pos) {
  if (!rootGroup_) return false;
  lastStreamPos_.copy(pos);
  let ranShell = processStreamShellJobs_(MAX_STREAM_SHELL_JOBS_PER_FRAME);
  processSectorGlbJobs_();

  const sx = Math.floor(pos.x / SANDBOX_SECTOR);
  const sy = Math.floor(pos.y / SANDBOX_SECTOR);
  const sz = Math.floor(pos.z / SANDBOX_SECTOR);
  const key = key3(sx, sy, sz);

  let streamChanged = false;
  if (lastKey_ !== key) {
    lastKey_ = key;

    const want = new Set();
    for (let dz = -ACTIVE_HALF; dz <= ACTIVE_HALF; dz++) {
      for (let dy = -ACTIVE_HALF; dy <= ACTIVE_HALF; dy++) {
        for (let dx = -ACTIVE_HALF; dx <= ACTIVE_HALF; dx++) {
          want.add(key3(sx + dx, sy + dy, sz + dz));
        }
      }
    }

    pruneStreamShellQueue_(want);

    /** @type {string[]} */
    const unloadList = [];
    for (const k of [...loaded_.keys()]) {
      if (!want.has(k)) unloadList.push(k);
    }
    unloadList.sort(
      (a, b) => distSqPosToCellKey_(pos, b) - distSqPosToCellKey_(pos, a),
    );
    for (let i = 0; i < unloadList.length; i++) {
      streamShellJobs_.push({ type: "unload", key: unloadList[i] });
    }

    /** @type {string[]} */
    const loadList = [];
    for (const k of want) {
      if (loaded_.has(k)) continue;
      loadList.push(k);
    }
    loadList.sort(
      (a, b) => distSqPosToCellKey_(pos, a) - distSqPosToCellKey_(pos, b),
    );
    for (let i = 0; i < loadList.length; i++) {
      streamShellJobs_.push({ type: "loadShell", key: loadList[i] });
    }
    streamChanged = true;
  }

  if (processStreamShellJobs_(MAX_STREAM_SHELL_JOBS_PER_FRAME)) ranShell = true;
  reconcileSectorGlbDetailForPlayer_(pos);
  processSectorGlbJobs_();
  if (ranShell || streamShellJobs_.length > 0) rebuildCollisionFlat_();
  return streamChanged;
}

export function getSandboxCollisionBoxes() {
  return activeCollision_;
}

export function getCurrentSandboxSectorKey() {
  return lastKey_ || "0,0,0";
}

export function getActiveSandboxSectorKeys() {
  return [...loaded_.keys()];
}

export function getSandboxFloorY(x, z, currentY, slack = 0.35) {
  let bestTop = -Infinity;
  let coveredXZ = false;
  for (let i = 0; i < activeCollision_.length; i++) {
    const b = activeCollision_[i];
    if (!b.floorSlab) continue;
    _floorLp.set(x - b.cx, 0, z - b.cz).applyMatrix3(b.mInv);
    if (Math.abs(_floorLp.x) > b.hx) continue;
    if (Math.abs(_floorLp.z) > b.hz) continue;
    coveredXZ = true;
    const topY = b.cy + b.hy;
    if (topY <= currentY + slack && topY > bestTop) bestTop = topY;
  }
  if (bestTop > -Infinity) return bestTop;
  if (!coveredXZ) return null;
  let lowestAbove = Infinity;
  for (let i = 0; i < activeCollision_.length; i++) {
    const b = activeCollision_[i];
    if (!b.floorSlab) continue;
    _floorLp.set(x - b.cx, 0, z - b.cz).applyMatrix3(b.mInv);
    if (Math.abs(_floorLp.x) > b.hx) continue;
    if (Math.abs(_floorLp.z) > b.hz) continue;
    const topY = b.cy + b.hy;
    if (topY < lowestAbove) lowestAbove = topY;
  }
  return lowestAbove < Infinity ? lowestAbove : null;
}

export function getSandboxDefaultSpawn(out) {
  const half = SANDBOX_SECTOR * 0.5;
  const y = half + CUBE_HALF + 0.05;
  return out.set(half, y, half);
}
