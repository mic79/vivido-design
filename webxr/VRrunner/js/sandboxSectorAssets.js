/**
 * User-authored sector props for the stream sandbox (map=1).
 * Layout is saved as JSON: a shared `library` of named primitives + per-sector `instances`.
 * Must stay in sync with `SANDBOX_SECTOR` in streamSandboxMap.js (100 m cells).
 */
import * as THREE from "three";
import {
  registerSandboxGlbCollisionMeshes,
  unregisterSandboxGlbCollisionMeshes,
  registerSandboxBreakableGlassPane,
  unregisterSandboxBreakableGlassForMeshes,
} from "./runnerLevel.js";

export const SANDBOX_SECTOR_USER = 100;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _previewFitBox = new THREE.Box3();
const _previewFitSize = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _ugPos = new THREE.Vector3();
const _ugQuat = new THREE.Quaternion();
const _ugScl = new THREE.Vector3();
const _ugRotM4 = new THREE.Matrix4();
const _ugM3 = new THREE.Matrix3();
const _ugM3Inv = new THREE.Matrix3();

/** Set by `streamSandboxMap.initStreamSandbox` so breakable-glass OBBs merge into `activeCollision_`. */
/** @type {(() => void) | null} */
let rebuildSandboxCollisionFlat_ = null;

/**
 * Wire the sandbox sector-shell collision flatten pass (avoids `sandboxSectorAssets` importing `streamSandboxMap`).
 * @param {(() => void) | null | undefined} fn
 */
export function setSandboxSectorCollisionRebuild(fn) {
  rebuildSandboxCollisionFlat_ = typeof fn === "function" ? fn : null;
}

/**
 * World OBB for a user `BoxGeometry` mesh (oriented with `matrixWorld`).
 * @param {THREE.Mesh} mesh
 */
function userGlassWorldObbFromMesh_(mesh) {
  mesh.updateMatrixWorld(true);
  mesh.matrixWorld.decompose(_ugPos, _ugQuat, _ugScl);
  const g = mesh.geometry;
  const p = g?.parameters;
  const pw = Number(p?.width) || 1;
  const ph = Number(p?.height) || 1;
  const pd = Number(p?.depth) || 1;
  const hx = (Math.abs(pw) * 0.5) * Math.abs(_ugScl.x);
  const hy = (Math.abs(ph) * 0.5) * Math.abs(_ugScl.y);
  const hz = (Math.abs(pd) * 0.5) * Math.abs(_ugScl.z);
  _ugRotM4.makeRotationFromQuaternion(_ugQuat);
  _ugM3.setFromMatrix4(_ugRotM4);
  _ugM3Inv.copy(_ugM3).transpose();
  return {
    cx: _ugPos.x,
    cy: _ugPos.y,
    cz: _ugPos.z,
    hx,
    hy,
    hz,
    m: _ugM3.clone(),
    mInv: _ugM3Inv.clone(),
  };
}

/**
 * Push breakable-glass OBBs into `rec.collision` and register `runnerGlassPanes_` entries.
 * Runs from every `attachUserSectorAssets` so reload / editor refresh always registers panes.
 * @param {{ collision: object[], userSectorMeshes?: THREE.Mesh[] | null }} rec
 */
function syncUserSectorBreakableGlass_(rec) {
  const collision = rec.collision;
  if (!collision || !Array.isArray(collision)) return;
  const meshes = rec.userSectorMeshes;
  if (!meshes?.length) return;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    if (!mesh.userData?.sandboxBreakableGlass) continue;
    const obb = userGlassWorldObbFromMesh_(mesh);
    collision.push(obb);
    registerSandboxBreakableGlassPane({
      obb,
      mesh,
      bidirectionalShatter: true,
      removeObbFromWorld(o) {
        const j = collision.indexOf(o);
        if (j >= 0) collision.splice(j, 1);
        rebuildSandboxCollisionFlat_?.();
      },
    });
  }
  rebuildSandboxCollisionFlat_?.();
}

/** @type {{ version: number, library: Record<string, unknown>, sectors: Record<string, { instances: object[] }> }} */
let doc_ = {
  version: 1,
  library: {},
  sectors: {},
};

/** @type {(() => void) | null} */
let beforeSectorAssetMutation_ = null;
/** @type {(() => void) | null} */
let afterSectorDocumentReplaced_ = null;

/**
 * Sector editor undo: snapshot before each doc mutation; full replace clears stacks.
 * @param {(() => void) | null} beforeMutation
 * @param {(() => void) | null} afterDocumentReplaced
 */
export function registerSectorAssetHistoryHooks(beforeMutation, afterDocumentReplaced) {
  beforeSectorAssetMutation_ = beforeMutation;
  afterSectorDocumentReplaced_ = afterDocumentReplaced;
}

function notifyBeforeSectorAssetMutation_() {
  try {
    beforeSectorAssetMutation_?.();
  } catch (err) {
    console.warn("[sandboxSectorAssets] beforeMutation hook:", err);
  }
}

function notifyAfterSectorDocumentReplaced_() {
  try {
    afterSectorDocumentReplaced_?.();
  } catch (err) {
    console.warn("[sandboxSectorAssets] documentReplaced hook:", err);
  }
}

/* Primitive extents are multiples of 0.25 m so they tile the editor’s 25 cm snap grid (glass thickness stays thin). */
const DEFAULT_LIBRARY = {
  crate_m: {
    type: "box",
    w: 2,
    h: 2,
    d: 2,
  },
  pillar_s: {
    type: "cylinder",
    radiusTop: 0.375,
    radiusBottom: 0.375,
    height: 5,
  },
  marker: {
    type: "sphere",
    radius: 0.5,
  },
  /** XZ floor/wall panel; identity quaternion = horizontal (normal +world Y). */
  plane_m: {
    type: "plane",
    w: 5,
    h: 5,
  },
  demo_plinth: {
    type: "box",
    w: 4,
    h: 0.25,
    d: 4,
  },
  /** Thin box; shatters from either side when hit fast enough (see `runnerLevel.tryShatterRunnerGlassPlayer`). */
  glass_break: {
    type: "glass_break",
    w: 5,
    h: 2.5,
    d: 0.05,
  },
  /** Same look as breakable glass but never registers as a breakable pane. */
  glass_solid: {
    type: "glass_solid",
    w: 5,
    h: 2.5,
    d: 0.05,
  },
};

/**
 * Merge bundled defaults with the saved document. For each id in `DEFAULT_LIBRARY`, if the
 * document has the same `type`, **default geometry wins** (`{ ...user, ...def }`) so old
 * IndexedDB / JSON `w`/`h`/… overrides cannot stick after we ship new sizes; user-only keys
 * like `color` are kept from the document. Unknown library ids are left unchanged.
 */
function mergeDefaultLibrary() {
  const user = doc_.library && typeof doc_.library === "object" ? { ...doc_.library } : {};
  for (const k of Object.keys(DEFAULT_LIBRARY)) {
    const def = DEFAULT_LIBRARY[k];
    const u = user[k];
    if (u && typeof u === "object" && u.type === def.type) {
      user[k] = { ...u, ...def };
    } else if (!u || typeof u !== "object") {
      user[k] = def;
    }
  }
  doc_.library = user;
}

/** Neutral white for library primitives (box / sphere / cylinder / plane); glass uses `makeSectorGlassMaterial`. */
function makePrimitiveLibraryMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xf5f5f5,
    roughness: 0.55,
    metalness: 0.06,
    fog: true,
  });
}

/** One material per mesh so disposing a shattered pane does not affect others. */
function makeSectorGlassMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xb8e8ff,
    roughness: 0.06,
    metalness: 0.28,
    transparent: true,
    opacity: 0.4,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: true,
  });
}

/**
 * Uniform scale so the largest world AABB edge equals `targetMaxDim` (preserves cube / aspect).
 * Resets local TRS first so sizing matches library geometry, not inherited transforms.
 * @param {THREE.Object3D} rootMesh  mesh (or single-mesh subtree) not yet parented to the controller
 * @param {number} targetMaxDim
 */
function shrinkLibraryPreviewMeshUniform_(rootMesh, targetMaxDim) {
  rootMesh.position.set(0, 0, 0);
  rootMesh.scale.set(1, 1, 1);
  rootMesh.updateMatrixWorld(true);
  _previewFitBox.setFromObject(rootMesh);
  _previewFitBox.getSize(_previewFitSize);
  const maxS = Math.max(_previewFitSize.x, _previewFitSize.y, _previewFitSize.z, 0.001);
  rootMesh.scale.setScalar(targetMaxDim / maxS);
}

/**
 * Small ghost mesh parented to the right controller in the sector editor so
 * the active library entry is visible in 3D (the text list alone is easy to miss).
 * @param {string} libraryId
 * @returns {THREE.Group | null}
 */
export function buildEditorLibraryPreviewRoot(libraryId) {
  mergeDefaultLibrary();
  const mesh = meshFromLibraryId(libraryId);
  if (!mesh) return null;
  const root = new THREE.Group();
  root.name = "editorLibraryPreview";
  const m = mesh.clone(true);
  m.traverse((o) => {
    if (o.isMesh && o.material) {
      const mat = /** @type {THREE.MeshStandardMaterial} */ (o.material.clone());
      mat.transparent = true;
      mat.opacity = 0.52;
      mat.depthWrite = false;
      o.material = mat;
    }
  });
  shrinkLibraryPreviewMeshUniform_(m, 0.2);
  root.add(m);
  return root;
}

/**
 * Opaque clone for editor “carry from library” before commit (not in JSON yet).
 * @param {string} libraryId
 * @returns {THREE.Group | null}
 */
export function buildEditorLibraryCarryRoot(libraryId) {
  mergeDefaultLibrary();
  const mesh = meshFromLibraryId(libraryId);
  if (!mesh) return null;
  const root = new THREE.Group();
  root.name = "editorLibraryCarry";
  const m = mesh.clone(true);
  m.traverse((o) => {
    if (o.isMesh && o.material) {
      const mat = /** @type {THREE.MeshStandardMaterial} */ (o.material.clone());
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
      o.material = mat;
    }
  });
  shrinkLibraryPreviewMeshUniform_(m, 0.22);
  root.add(m);
  root.userData.editorCarryClone = true;
  return root;
}

/**
 * @param {string} id
 * @returns {THREE.Mesh | null}
 */
function meshFromLibraryId(id) {
  const def = doc_.library[id];
  if (!def || typeof def !== "object") return null;
  const t = def.type;
  if (t === "box") {
    const w = Number(def.w) || 1;
    const h = Number(def.h) || 1;
    const d = Number(def.d) || 1;
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), makePrimitiveLibraryMaterial());
  }
  if (t === "sphere") {
    const r = Number(def.radius) || 0.5;
    return new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), makePrimitiveLibraryMaterial());
  }
  if (t === "cylinder") {
    const rt = Number(def.radiusTop ?? def.radius) || 0.4;
    const rb = Number(def.radiusBottom ?? def.radius) || rt;
    const h = Number(def.height) || 2;
    return new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 18, 1), makePrimitiveLibraryMaterial());
  }
  if (t === "plane") {
    const sw = Number(def.w) || 5;
    const sh = Number(def.h) || 5;
    const sx = Math.min(48, Math.max(1, Math.floor(Math.max(sw, sh) * 2)));
    const sy = Math.min(48, Math.max(1, Math.floor(Math.max(sw, sh) * 2)));
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh, sx, sy), makePrimitiveLibraryMaterial());
    mesh.rotation.x = -Math.PI * 0.5;
    return mesh;
  }
  if (t === "glass_break" || t === "glass_solid") {
    const w = Number(def.w) || 5;
    const h = Number(def.h) || 2.5;
    const d = Number(def.d) || 0.05;
    const gMat = makeSectorGlassMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), gMat);
    if (t === "glass_break") mesh.userData.sandboxBreakableGlass = true;
    return mesh;
  }
  return null;
}

const _snapBoundsBox = new THREE.Box3();
const _snapBoundsOne = new THREE.Vector3(1, 1, 1);
const _stackOutN = new THREE.Vector3();
const _stackCornerL = new THREE.Vector3();
const _tanN = new THREE.Vector3();
const _tanU = new THREE.Vector3();
const _tanV = new THREE.Vector3();
const _tanRel = new THREE.Vector3();
const _refNmw = new THREE.Matrix3();
const _refNg = new THREE.Vector3();
const _refQw = new THREE.Quaternion();
const _refEx = new THREE.Vector3();
const _refEy = new THREE.Vector3();
const _refEz = new THREE.Vector3();
const _refC0 = new THREE.Vector3();
const _refC1 = new THREE.Vector3();
const _refC2 = new THREE.Vector3();
const _refCross = new THREE.Vector3();
const _refMat4 = new THREE.Matrix4();
const _refWs = new THREE.Vector3();

function disposeLibraryTempMesh_(mesh) {
  if (!mesh) return;
  mesh.geometry?.dispose?.();
  const mat = mesh.material;
  if (mat && !Array.isArray(mat)) mat.dispose?.();
}

/**
 * Distance along `outwardIntoAirN` (unit world) from the surface hit point to the new instance **center**
 * so the mesh sits flush on that side (oriented corners from library geometry × scale, rotated by `worldQuat`).
 * @param {THREE.Quaternion} worldQuat
 * @param {THREE.Vector3} outwardIntoAirN  from struck solid toward free space (toward the laser origin)
 * @param {THREE.Vector3 | null} scaleVec  null → 1,1,1
 * @returns {number} offset distance (includes small epsilon); 0 if unusable
 */
export function computeSurfaceStackCenterOffsetAlongNormal(libraryId, worldQuat, outwardIntoAirN, scaleVec = null) {
  mergeDefaultLibrary();
  const mesh = meshFromLibraryId(libraryId);
  if (!mesh || !outwardIntoAirN) return 0;
  _stackOutN.copy(outwardIntoAirN).normalize();
  if (_stackOutN.lengthSq() < 1e-10) {
    disposeLibraryTempMesh_(mesh);
    return 0;
  }
  const s = scaleVec ?? _snapBoundsOne;
  /** Parent carries instance pose so library mesh keeps factory `rotation` (e.g. horizontal plane). */
  const root = new THREE.Group();
  root.add(mesh);
  root.position.set(0, 0, 0);
  root.quaternion.copy(worldQuat);
  root.scale.copy(s);
  root.updateMatrixWorld(true);
  const g = mesh.geometry;
  if (g && !g.boundingBox) g.computeBoundingBox();
  const bb = g?.boundingBox;
  if (!bb) {
    root.remove(mesh);
    disposeLibraryTempMesh_(mesh);
    return 0;
  }
  let sMin = Infinity;
  const mn = bb.min;
  const mx = bb.max;
  const corners = [
    [mn.x, mn.y, mn.z],
    [mx.x, mn.y, mn.z],
    [mn.x, mx.y, mn.z],
    [mx.x, mx.y, mn.z],
    [mn.x, mn.y, mx.z],
    [mx.x, mn.y, mx.z],
    [mn.x, mx.y, mx.z],
    [mx.x, mx.y, mx.z],
  ];
  for (let i = 0; i < 8; i++) {
    const c = corners[i];
    _stackCornerL.set(c[0], c[1], c[2]);
    mesh.localToWorld(_stackCornerL);
    sMin = Math.min(sMin, _stackCornerL.dot(_stackOutN));
  }
  root.remove(mesh);
  disposeLibraryTempMesh_(mesh);
  const d = -sMin;
  if (!(d > 1e-4)) return 0;
  return d + 0.002;
}

/**
 * Library entries that use axis-aligned `BoxGeometry` (w,h,d along local X,Y,Z).
 * @param {string} libraryId
 */
export function libraryUsesBoxReferenceFaceAlign_(libraryId) {
  mergeDefaultLibrary();
  const t = doc_.library[libraryId]?.type;
  return t === "box" || t === "glass_break" || t === "glass_solid";
}

/**
 * World orientation for a new box/glass instance so it **inherits the struck face’s plane**
 * from the reference mesh: local axis `hitAxis` aligns with `outwardNWorld`, and the two
 * tangent axes match the reference’s in-plane long/short edges (same dimension indices as
 * the reference), so e.g. two 5 cm faces meet flush without using the controller pose.
 * @param {THREE.Mesh} refMesh
 * @param {THREE.Vector3} faceNormalGeometry unit normal of `hit.face` in geometry space
 * @param {THREE.Vector3} outwardNWorld unit, from struck solid toward free space (laser side)
 * @param {string} newLibraryId
 * @param {THREE.Quaternion} outQ
 * @param {THREE.Vector3 | null} [outTangentUWorld] optional: filled with unit in-plane “long edge” direction for tangent-grid snap
 * @param {THREE.Vector3 | null} [outTangentVWorld] optional: unit in-plane “short edge” direction
 * @returns {boolean} false if the reference mesh is not usable as a box-like source
 */
export function quaternionFromReferenceBoxFace(
  refMesh,
  faceNormalGeometry,
  outwardNWorld,
  newLibraryId,
  outQ,
  outTangentUWorld = null,
  outTangentVWorld = null,
) {
  mergeDefaultLibrary();
  if (!refMesh?.isMesh || !faceNormalGeometry || !outwardNWorld || !newLibraryId || !doc_.library[newLibraryId]) {
    return false;
  }
  if (!libraryUsesBoxReferenceFaceAlign_(newLibraryId)) return false;

  const defNew = doc_.library[newLibraryId];
  const dimsNew = [
    Math.abs(Number(defNew.w)) || 1,
    Math.abs(Number(defNew.h)) || 1,
    Math.abs(Number(defNew.d)) || 1,
  ];

  const geo = refMesh.geometry;
  const p = geo?.parameters;
  const hasBoxParams = !!(p && typeof p.width === "number");

  let dimsRef = [1, 1, 1];
  const refLibId = refMesh.userData?.sectorLibraryId;
  if (refLibId && doc_.library[refLibId]) {
    const dr = doc_.library[refLibId];
    const tr = dr.type;
    if (tr === "box" || tr === "glass_break" || tr === "glass_solid") {
      dimsRef = [Math.abs(Number(dr.w)) || 1, Math.abs(Number(dr.h)) || 1, Math.abs(Number(dr.d)) || 1];
    } else if (hasBoxParams) {
      dimsRef = [Math.abs(Number(p.width)) || 1, Math.abs(Number(p.height)) || 1, Math.abs(Number(p.depth)) || 1];
    } else {
      return false;
    }
  } else if (hasBoxParams) {
    dimsRef = [Math.abs(Number(p.width)) || 1, Math.abs(Number(p.height)) || 1, Math.abs(Number(p.depth)) || 1];
  } else {
    return false;
  }

  refMesh.updateMatrixWorld(true);
  refMesh.getWorldScale(_refWs);
  const sw = Math.abs(_refWs.x) || 1;
  const sh = Math.abs(_refWs.y) || 1;
  const sd = Math.abs(_refWs.z) || 1;
  dimsRef[0] *= sw;
  dimsRef[1] *= sh;
  dimsRef[2] *= sd;

  _refNmw.getNormalMatrix(refMesh.matrixWorld);
  _refNg.copy(faceNormalGeometry).normalize();
  _refNg.applyMatrix3(_refNmw).normalize();
  if (_refNg.lengthSq() < 1e-10) return false;

  refMesh.getWorldQuaternion(_refQw);
  _refEx.set(1, 0, 0).applyQuaternion(_refQw);
  _refEy.set(0, 1, 0).applyQuaternion(_refQw);
  _refEz.set(0, 0, 1).applyQuaternion(_refQw);
  const axes = [_refEx, _refEy, _refEz];

  const dots = [Math.abs(_refEx.dot(_refNg)), Math.abs(_refEy.dot(_refNg)), Math.abs(_refEz.dot(_refNg))];
  let hitAxis = 0;
  if (dots[1] > dots[hitAxis]) hitAxis = 1;
  if (dots[2] > dots[hitAxis]) hitAxis = 2;

  const oa = (hitAxis + 1) % 3;
  const ob = (hitAxis + 2) % 3;
  const refLongIdx = dimsRef[oa] >= dimsRef[ob] ? oa : ob;
  const refShortIdx = refLongIdx === ob ? oa : ob;
  const uRef = axes[refLongIdx];
  const vRef = axes[refShortIdx];

  const newLongIdx = dimsNew[oa] >= dimsNew[ob] ? oa : ob;
  const newShortIdx = newLongIdx === ob ? oa : ob;

  _refC0.set(0, 0, 0);
  _refC1.set(0, 0, 0);
  _refC2.set(0, 0, 0);
  const cols = [_refC0, _refC1, _refC2];
  cols[hitAxis].copy(outwardNWorld).normalize();
  cols[newLongIdx].copy(uRef);
  cols[newShortIdx].copy(vRef);

  _refCross.crossVectors(cols[1], cols[2]);
  if (cols[0].dot(_refCross) < 0) cols[2].negate();

  if (outTangentUWorld) outTangentUWorld.copy(cols[newLongIdx]);
  if (outTangentVWorld) outTangentVWorld.copy(cols[newShortIdx]);

  _refMat4.makeBasis(cols[0], cols[1], cols[2]);
  outQ.setFromRotationMatrix(_refMat4);
  return true;
}

/**
 * Orthonormal `u`,`v` spanning the plane perpendicular to unit `nWorld`.
 * @param {THREE.Vector3} nWorld
 * @param {THREE.Vector3} outU
 * @param {THREE.Vector3} outV
 */
function buildTangentAxesForNormal_(nWorld, outU, outV) {
  outV.set(0, 1, 0);
  if (Math.abs(nWorld.dot(outV)) > 0.995) outV.set(1, 0, 0);
  outU.crossVectors(outV, nWorld).normalize();
  outV.crossVectors(nWorld, outU).normalize();
}

/**
 * Snaps the tangential part of (pos − hit) to `gridM` steps in the plane ⊥ `outwardN`, preserving offset along `outwardN`.
 * @param {THREE.Vector3} hitPointWorld
 * @param {THREE.Vector3} posInOut
 * @param {THREE.Vector3} outwardNWorld unit
 * @param {number} gridM
 * @param {THREE.Vector3 | null} [tangentUWorld] optional orthonormal in-plane axis (matches reference face when provided)
 * @param {THREE.Vector3 | null} [tangentVWorld] optional second in-plane axis (right-handed with `outwardNWorld × tangentU`)
 */
export function snapWorldPositionTangentPlaneGrid(
  hitPointWorld,
  posInOut,
  outwardNWorld,
  gridM,
  tangentUWorld = null,
  tangentVWorld = null,
) {
  if (!(gridM > 0)) return;
  _tanN.copy(outwardNWorld).normalize();
  if (_tanN.lengthSq() < 1e-10) return;
  if (tangentUWorld && tangentVWorld && tangentUWorld.lengthSq() > 1e-12 && tangentVWorld.lengthSq() > 1e-12) {
    _tanU.copy(tangentUWorld).normalize();
    _tanV.crossVectors(_tanN, _tanU).normalize();
  } else {
    buildTangentAxesForNormal_(_tanN, _tanU, _tanV);
  }
  _tanRel.copy(posInOut).sub(hitPointWorld);
  const alongN = _tanN.dot(_tanRel);
  _tanRel.addScaledVector(_tanN, -alongN);
  const su = Math.round(_tanRel.dot(_tanU) / gridM) * gridM;
  const sv = Math.round(_tanRel.dot(_tanV) / gridM) * gridM;
  posInOut.copy(hitPointWorld).addScaledVector(_tanN, alongN).addScaledVector(_tanU, su).addScaledVector(_tanV, sv);
}

const _projPlTmp = new THREE.Vector3();

/**
 * Closest point on the plane (origin `planeOriginWorld`, unit normal `planeUnitNormalWorld`) to `pointWorld`.
 * @param {THREE.Vector3} pointWorld
 * @param {THREE.Vector3} planeOriginWorld
 * @param {THREE.Vector3} planeUnitNormalWorld
 * @param {THREE.Vector3} out
 */
export function projectWorldPointOntoPlane(pointWorld, planeOriginWorld, planeUnitNormalWorld, out) {
  _projPlTmp.subVectors(pointWorld, planeOriginWorld);
  out.copy(pointWorld).addScaledVector(planeUnitNormalWorld, -planeUnitNormalWorld.dot(_projPlTmp));
}

/**
 * Nudges world **origin** `pos` (in/out) so the instance's world AABB has:
 * - `min.y` on `gridM` steps (stacking / floor contact),
 * - horizontal footprint center `(min.x+max.x)/2`, `(min.z+max.z)/2` on `gridM` steps.
 * Uses a throwaway mesh from the library (disposed after). Snapping the mesh **origin** to the
 * grid alone misaligns boxes because the origin is the geometric center, not the bottom face.
 * @param {THREE.Vector3} pos
 * @param {THREE.Quaternion} quat
 * @param {THREE.Vector3 | null} scaleVec  null → 1,1,1
 * @param {string} libraryId
 * @param {number} gridM
 */
export function snapWorldPositionToAxisGridUsingLibraryBounds(pos, quat, scaleVec, libraryId, gridM) {
  mergeDefaultLibrary();
  if (!libraryId || !(gridM > 0) || !doc_.library[libraryId]) return;
  const mesh = meshFromLibraryId(libraryId);
  if (!mesh) return;
  const s = scaleVec ?? _snapBoundsOne;
  mesh.position.copy(pos);
  mesh.quaternion.copy(quat);
  mesh.scale.copy(s);
  mesh.updateMatrixWorld(true);
  _snapBoundsBox.setFromObject(mesh);
  const g = gridM;
  const dy = Math.round(_snapBoundsBox.min.y / g) * g - _snapBoundsBox.min.y;
  const cx = (_snapBoundsBox.min.x + _snapBoundsBox.max.x) * 0.5;
  const cz = (_snapBoundsBox.min.z + _snapBoundsBox.max.z) * 0.5;
  const dx = Math.round(cx / g) * g - cx;
  const dz = Math.round(cz / g) * g - cz;
  pos.x += dx;
  pos.y += dy;
  pos.z += dz;
  mesh.geometry?.dispose?.();
  const mat = mesh.material;
  if (mat && !Array.isArray(mat)) mat.dispose?.();
}

export function sectorKeyFromWorldPos(pos) {
  const sx = Math.floor(pos.x / SANDBOX_SECTOR_USER);
  const sy = Math.floor(pos.y / SANDBOX_SECTOR_USER);
  const sz = Math.floor(pos.z / SANDBOX_SECTOR_USER);
  return `${sx},${sy},${sz}`;
}

function ensureSectorBucket(key) {
  if (!doc_.sectors[key]) doc_.sectors[key] = { instances: [] };
  return doc_.sectors[key];
}

/**
 * @param {string} jsonText
 * @param {{ skipDocumentReplacedHook?: boolean, skipIndexedDbSave?: boolean }} [opts] —
 *   `skipDocumentReplacedHook`: undo/redo snapshot replace without clearing stacks.
 *   `skipIndexedDbSave`: bootstrap loads (IndexedDB / bundled JSON) must not overwrite IDB.
 */
export function setSectorAssetDocumentFromJson(jsonText, opts = {}) {
  const o = JSON.parse(jsonText);
  if (!o || typeof o !== "object") throw new Error("Invalid JSON root");
  doc_.version = Number(o.version) || 1;
  doc_.library = o.library && typeof o.library === "object" ? { ...o.library } : {};
  doc_.sectors = o.sectors && typeof o.sectors === "object" ? { ...o.sectors } : {};
  for (const k of Object.keys(doc_.sectors)) {
    const s = doc_.sectors[k];
    if (!s.instances || !Array.isArray(s.instances)) s.instances = [];
  }
  mergeDefaultLibrary();
  if (!opts.skipDocumentReplacedHook) notifyAfterSectorDocumentReplaced_();
  if (!opts.skipIndexedDbSave) scheduleSectorAssetsIndexedDBSave();
}

export function getSectorAssetDocumentJson() {
  return JSON.stringify(doc_, null, 2);
}

export async function tryLoadSectorAssetDocumentFromUrl(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const t = await res.text();
    setSectorAssetDocumentFromJson(t, { skipIndexedDbSave: true });
    return true;
  } catch (_) {
    return false;
  }
}

/** @param {{ skipIndexedDbSave?: boolean }} [opts] */
export function resetSectorAssetDocumentToDefaults(opts = {}) {
  doc_ = {
    version: 1,
    library: { ...DEFAULT_LIBRARY },
    sectors: {},
  };
  notifyAfterSectorDocumentReplaced_();
  if (!opts.skipIndexedDbSave) scheduleSectorAssetsIndexedDBSave();
}

/**
 * Rebuild meshes under `rec.group` for this sector key.
 * @param {string} key "sx,sy,sz"
 * @param {{ group: THREE.Group, collision?: object[], userSectorRoot?: THREE.Group | null, userSectorMeshes?: THREE.Mesh[] | null }} rec
 */
export function attachUserSectorAssets(key, rec) {
  mergeDefaultLibrary();
  detachUserSectorAssets(rec);
  const bucket = doc_.sectors[key];
  if (!bucket?.instances?.length) return;

  const root = new THREE.Group();
  root.name = `sandbox_user_assets_${key}`;
  rec.group.add(root);

  /** @type {THREE.Mesh[]} */
  const meshes = [];
  for (let i = 0; i < bucket.instances.length; i++) {
    const inst = bucket.instances[i];
    const id = inst.libraryId;
    const mesh = meshFromLibraryId(id);
    if (!mesh) continue;
    mesh.name = `user_${id}_${i}`;
    mesh.userData.sectorUserAsset = true;
    mesh.userData.sectorLibraryId = id;
    mesh.userData.instanceUuid = inst.uuid || THREE.MathUtils.generateUUID();
    inst.uuid = mesh.userData.instanceUuid;
    if (Array.isArray(inst.p) && inst.p.length >= 3) {
      mesh.position.set(inst.p[0], inst.p[1], inst.p[2]);
    }
    if (Array.isArray(inst.q) && inst.q.length >= 4) {
      mesh.quaternion.set(inst.q[0], inst.q[1], inst.q[2], inst.q[3]);
    } else {
      mesh.quaternion.identity();
    }
    if (Array.isArray(inst.s) && inst.s.length >= 3) {
      mesh.scale.set(inst.s[0], inst.s[1], inst.s[2]);
    } else {
      mesh.scale.set(1, 1, 1);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    meshes.push(mesh);
  }
  rec.userSectorRoot = root;
  rec.userSectorMeshes = meshes;
  /* Sector shell world pose must be current before glass OBBs are derived from mesh.matrixWorld. */
  rec.group?.updateMatrixWorld(true);
  root.updateMatrixWorld(true);
  for (let i = 0; i < meshes.length; i++) meshes[i].updateMatrixWorld(true);
  if (meshes.length) registerSandboxGlbCollisionMeshes(meshes);
  syncUserSectorBreakableGlass_(rec);
}

/**
 * @param {{ group: THREE.Group, userSectorRoot?: THREE.Group | null, userSectorMeshes?: THREE.Mesh[] | null }} rec
 */
export function detachUserSectorAssets(rec) {
  if (rec.userSectorMeshes?.length) {
    unregisterSandboxBreakableGlassForMeshes(rec.userSectorMeshes);
    unregisterSandboxGlbCollisionMeshes(rec.userSectorMeshes);
    for (let i = 0; i < rec.userSectorMeshes.length; i++) {
      const m = rec.userSectorMeshes[i];
      /* Pull off sector root **or** controller before dispose — otherwise a mesh
       * parented to the XR rig during carry-edit stays in the scene as a zombie
       * with disposed geometry and breaks BVH / picking for later instances. */
      m.removeFromParent();
      const g = m.geometry;
      const mat = m.material;
      if (g?.disposeBoundsTree) g.disposeBoundsTree();
      if (g) g.dispose();
      if (mat && !Array.isArray(mat)) mat.dispose?.();
    }
  }
  rec.userSectorMeshes = null;
  if (rec.userSectorRoot) {
    rec.userSectorRoot.removeFromParent();
    rec.userSectorRoot = null;
  }
}

export function getLibraryIds() {
  mergeDefaultLibrary();
  return Object.keys(doc_.library);
}

export function getDocumentLibrary() {
  mergeDefaultLibrary();
  return doc_.library;
}

let libCursor_ = 0;

export function cycleLibrarySelection(delta) {
  const ids = getLibraryIds();
  if (!ids.length) return "";
  libCursor_ = (libCursor_ + delta + ids.length * 10) % ids.length;
  return ids[libCursor_];
}

export function getCurrentLibraryId() {
  const ids = getLibraryIds();
  if (!ids.length) return "";
  return ids[libCursor_ % ids.length];
}

export function addInstanceInSector(key, libraryId, localPos, localQuat, scale) {
  mergeDefaultLibrary();
  if (!doc_.library[libraryId]) return null;
  notifyBeforeSectorAssetMutation_();
  const bucket = ensureSectorBucket(key);
  const uuid = THREE.MathUtils.generateUUID();
  const inst = {
    uuid,
    libraryId,
    p: [localPos.x, localPos.y, localPos.z],
    q: [localQuat.x, localQuat.y, localQuat.z, localQuat.w],
    s: scale ? [scale.x, scale.y, scale.z] : [1, 1, 1],
  };
  bucket.instances.push(inst);
  scheduleSectorAssetsIndexedDBSave();
  return inst;
}

export function refreshUserSectorIfLoaded(key, rec) {
  attachUserSectorAssets(key, rec);
}

/**
 * @param {THREE.Vector3} worldPos
 * @param {THREE.Quaternion} worldQuat
 */
/**
 * @param {THREE.Vector3 | null} [worldScale] — if null, defaults to 1,1,1
 */
export function addInstanceAtWorld(worldPos, worldQuat, libraryId, worldScale = null) {
  const key = sectorKeyFromWorldPos(worldPos);
  const parts = key.split(",").map(Number);
  const ox = parts[0] * SANDBOX_SECTOR_USER;
  const oy = parts[1] * SANDBOX_SECTOR_USER;
  const oz = parts[2] * SANDBOX_SECTOR_USER;
  _v.copy(worldPos).sub(_v2.set(ox, oy, oz));
  _q.copy(worldQuat);
  return addInstanceInSector(key, libraryId, _v, _q, worldScale);
}

/**
 * Move an existing user instance to a new world pose (any sector cell).
 * @param {THREE.Vector3} worldScale
 * @returns {string | null} sector key the instance ended up in
 */
export function resyncInstanceWorld(uuid, worldPos, worldQuat, worldScale) {
  /** @type {string | null} */
  let foundKey = null;
  let foundJ = -1;
  let libraryId = "";
  for (const key of Object.keys(doc_.sectors)) {
    const arr = doc_.sectors[key].instances;
    const j = arr.findIndex((x) => x.uuid === uuid);
    if (j >= 0) {
      foundKey = key;
      foundJ = j;
      libraryId = arr[j].libraryId;
      break;
    }
  }
  if (!foundKey || !libraryId) return null;
  mergeDefaultLibrary();
  if (!doc_.library[libraryId]) return null;
  notifyBeforeSectorAssetMutation_();
  doc_.sectors[foundKey].instances.splice(foundJ, 1);
  const newKey = sectorKeyFromWorldPos(worldPos);
  const parts = newKey.split(",").map(Number);
  const ox = parts[0] * SANDBOX_SECTOR_USER;
  const oy = parts[1] * SANDBOX_SECTOR_USER;
  const oz = parts[2] * SANDBOX_SECTOR_USER;
  _v.copy(worldPos).sub(_v2.set(ox, oy, oz));
  _q.copy(worldQuat);
  const bucket = ensureSectorBucket(newKey);
  bucket.instances.push({
    uuid,
    libraryId,
    p: [_v.x, _v.y, _v.z],
    q: [_q.x, _q.y, _q.z, _q.w],
    s: [worldScale.x, worldScale.y, worldScale.z],
  });
  scheduleSectorAssetsIndexedDBSave();
  return newKey;
}

export function removeInstanceByUuid(uuid) {
  for (const key of Object.keys(doc_.sectors)) {
    const arr = doc_.sectors[key].instances;
    const j = arr.findIndex((x) => x.uuid === uuid);
    if (j >= 0) {
      notifyBeforeSectorAssetMutation_();
      arr.splice(j, 1);
      scheduleSectorAssetsIndexedDBSave();
      return key;
    }
  }
  return null;
}

export function downloadSectorAssetDocument(filename = "sectorAssets.json") {
  const blob = new Blob([getSectorAssetDocumentJson()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── IndexedDB persistence (map=1 sector document) ───────────────────── */

const SECTOR_ASSETS_IDB_NAME = "VRrunnerSectorAssets";
const SECTOR_ASSETS_IDB_VER = 1;
const SECTOR_ASSETS_IDB_STORE = "assets";
const SECTOR_ASSETS_IDB_KEY = "sectorAssetDocumentJson";

/** @type {ReturnType<typeof setTimeout> | null} */
let sectorAssetsIdbSaveTimer_ = null;
const SECTOR_ASSETS_IDB_DEBOUNCE_MS = 850;

function idbRequest_(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

function idbTransactionDone_(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

function openSectorAssetsIdb_() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(SECTOR_ASSETS_IDB_NAME, SECTOR_ASSETS_IDB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SECTOR_ASSETS_IDB_STORE)) {
        db.createObjectStore(SECTOR_ASSETS_IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

/** Debounced save after edits (add/move/delete/set document). */
export function scheduleSectorAssetsIndexedDBSave() {
  if (typeof indexedDB === "undefined") return;
  if (sectorAssetsIdbSaveTimer_) clearTimeout(sectorAssetsIdbSaveTimer_);
  sectorAssetsIdbSaveTimer_ = setTimeout(() => {
    sectorAssetsIdbSaveTimer_ = null;
    persistSectorAssetsToIndexedDB().catch((err) => {
      console.warn("[sandboxSectorAssets] IndexedDB save failed:", err);
    });
  }, SECTOR_ASSETS_IDB_DEBOUNCE_MS);
}

/** Write the current sector document JSON to IndexedDB (immediate). */
export async function persistSectorAssetsToIndexedDB() {
  if (typeof indexedDB === "undefined") throw new Error("indexedDB unavailable");
  const db = await openSectorAssetsIdb_();
  try {
    const tx = db.transaction(SECTOR_ASSETS_IDB_STORE, "readwrite");
    tx.objectStore(SECTOR_ASSETS_IDB_STORE).put(getSectorAssetDocumentJson(), SECTOR_ASSETS_IDB_KEY);
    await idbTransactionDone_(tx);
  } finally {
    db.close();
  }
}

/** @returns {Promise<string | null>} raw JSON or null if missing / unreadable */
export async function loadSectorAssetDocumentFromIndexedDB() {
  if (typeof indexedDB === "undefined") return null;
  let db;
  try {
    db = await openSectorAssetsIdb_();
  } catch (_) {
    return null;
  }
  try {
    const tx = db.transaction(SECTOR_ASSETS_IDB_STORE, "readonly");
    const json = await idbRequest_(tx.objectStore(SECTOR_ASSETS_IDB_STORE).get(SECTOR_ASSETS_IDB_KEY));
    await idbTransactionDone_(tx);
    if (typeof json !== "string" || json.length < 8) return null;
    return json;
  } catch (_) {
    return null;
  } finally {
    db.close();
  }
}

/** Remove the browser-stored copy (next launch falls back to bundled JSON / defaults). */
export async function clearSectorAssetsFromIndexedDB() {
  if (typeof indexedDB === "undefined") return;
  const db = await openSectorAssetsIdb_();
  try {
    const tx = db.transaction(SECTOR_ASSETS_IDB_STORE, "readwrite");
    tx.objectStore(SECTOR_ASSETS_IDB_STORE).delete(SECTOR_ASSETS_IDB_KEY);
    await idbTransactionDone_(tx);
  } finally {
    db.close();
  }
}
