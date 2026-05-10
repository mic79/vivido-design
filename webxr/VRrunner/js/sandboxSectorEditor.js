/**
 * Quest / WebXR sector editor (map=1 + editor locomotion).
 * Library: L/R thumbstick click (2/3) cycle piece · Grips: grab/move prop (release = drop).
 * **Right laser** + **A** = add at hit (flush-stacks on sector shell / props; **city GLB excluded** from laser raycasts) · **Right laser** + **Y** = delete hit prop (Y alone, not while squeezing).
 * **Left squeeze + Y** = undo · **Left squeeze + X** = redo (300 ms debounce, BattleVR-style).
 * Both grips + carry: scale. **Placement:** 25 cm world grid on AABB bottom + footprint center, 15° euler snap (pitch/yaw/roll) by default.
 * Hold **index trigger** (pressed, or pulled past ~92% for analog) on the **carrying** hand on release to disable snap.
 * Save: Menu or Y+B hold → IndexedDB (browser). Export JSON: `downloadSectorAssetDocument` / console API.
 */
import * as THREE from "three";
import {
  addInstanceAtWorld,
  cycleLibrarySelection,
  downloadSectorAssetDocument,
  getCurrentLibraryId,
  getSectorAssetDocumentJson,
  getLibraryIds,
  persistSectorAssetsToIndexedDB,
  refreshUserSectorIfLoaded,
  registerSectorAssetHistoryHooks,
  removeInstanceByUuid,
  resyncInstanceWorld,
  sectorKeyFromWorldPos,
  setSectorAssetDocumentFromJson,
  snapWorldPositionToAxisGridUsingLibraryBounds,
  computeSurfaceStackCenterOffsetAlongNormal,
  libraryUsesBoxReferenceFaceAlign_,
  quaternionFromReferenceBoxFace,
  projectWorldPointOntoPlane,
  snapWorldPositionTangentPlaneGrid,
} from "./sandboxSectorAssets.js";
import {
  getSandboxGlbCollisionMeshes,
  registerSandboxGlbCollisionMeshes,
  unregisterSandboxGlbCollisionMeshes,
} from "./runnerLevel.js";
import { getActiveSandboxSectorKeys } from "./streamSandboxMap.js";

const _ray = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _mat = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _hit = new THREE.Vector3();
/** @type {THREE.Mesh[]} */
const _rayMeshScratch = [];

let prevLSqueeze_ = false;
let prevRSqueeze_ = false;
let prevMenuL_ = false;
let prevMenuR_ = false;
let ybChordStartMs_ = 0;
let ybChordFiredThisHold_ = false;
let prevLStick_ = false;
let prevRStick_ = false;
let prevPrimarySq_ = false;
let prevARight_ = false;
let prevXLeft_ = false;
let prevYLeft_ = false;
let lastSectorUndoMs_ = 0;
let lastSectorRedoMs_ = 0;
const SECTOR_UNDO_MAX = 40;
const SECTOR_UNDO_REDO_DEBOUNCE_MS = 300;
/** World-space step for AABB bottom Y and footprint center X/Z (see `snapWorldPositionUsingObjectWorldAabb_`). */
const SNAP_GRID_M = 0.25;
const SNAP_ROT_RAD = THREE.MathUtils.degToRad(15);
const SNAP_SCALE_STEP = 0.05;
/** @type {string[]} */
const sectorUndoStack_ = [];
/** @type {string[]} */
const sectorRedoStack_ = [];

const _cPos = new THREE.Vector3();
const _cQuat = new THREE.Quaternion();
const _cScale = new THREE.Vector3();
const _cLw = new THREE.Vector3();
const _cRw = new THREE.Vector3();
const _snapCommitBox = new THREE.Box3();
const _snapWorldMat = new THREE.Matrix4();
const _snapParentInv = new THREE.Matrix4();
const _surfOutN = new THREE.Vector3();
const _surfTanU = new THREE.Vector3();
const _surfTanV = new THREE.Vector3();
const _surfRefCenter = new THREE.Vector3();
const _surfPlaneAnchor = new THREE.Vector3();
/** Scratch for matching placed instance scale to a struck reference prop (`sectorLibraryId` === current library). */
const _refMatchScale = new THREE.Vector3(1, 1, 1);

/** Writes `obj` local TRS so world matrix matches `worldPos` / `worldQuat` / `worldScale` under `obj.parent`. */
function applyWorldPoseToObject_(obj, worldPos, worldQuat, worldScale) {
  _snapWorldMat.compose(worldPos, worldQuat, worldScale);
  const p = obj.parent;
  if (p) {
    p.updateMatrixWorld(true);
    _snapParentInv.copy(p.matrixWorld).invert();
    _snapParentInv.multiply(_snapWorldMat);
    _snapParentInv.decompose(obj.position, obj.quaternion, obj.scale);
  } else {
    obj.position.copy(worldPos);
    obj.quaternion.copy(worldQuat);
    obj.scale.copy(worldScale);
  }
}

/** @type {"idle"|"carryNew"|"carryEdit"} */
let editManipMode_ = "idle";
/** @type {THREE.Object3D | null} */
let carryVisual_ = null;
let carryUuid_ = "";
let carryLibId_ = "";
/** @type {THREE.Object3D | null} */
let carryPrimaryGrip_ = null;
let carryKeyAtGrab_ = "";
let scaleAnchorD0_ = 0;
let scaleAnchorS0_ = 1;
/** True if both grips changed uniform scale during this carry (skip scale snap on commit). */
let carryDidDualScaleThisCarry_ = false;

function stickCombinedPressed(gp) {
  return !!(gp?.buttons?.[2]?.pressed || gp?.buttons?.[3]?.pressed);
}

function squeezeOnGrip(grip, leftGrip, rightGrip, gpL, gpR) {
  if (!grip) return false;
  if (grip === leftGrip) return xrGripSqueezed(gpL?.buttons?.[1]);
  if (grip === rightGrip) return xrGripSqueezed(gpR?.buttons?.[1]);
  return false;
}

/**
 * Nudge world **origin** `worldPos` so the object's current world AABB has bottom + footprint
 * center on the grid (same rule as `snapWorldPositionToAxisGridUsingLibraryBounds`).
 * @param {THREE.Object3D} obj
 * @param {THREE.Vector3} worldPos
 */
function snapWorldPositionUsingObjectWorldAabb_(obj, worldPos, gridM) {
  obj.updateMatrixWorld(true);
  _snapCommitBox.setFromObject(obj);
  const g = gridM;
  const mn = _snapCommitBox.min;
  const mx = _snapCommitBox.max;
  const dy = Math.round(mn.y / g) * g - mn.y;
  const cx = (mn.x + mx.x) * 0.5;
  const cz = (mn.z + mx.z) * 0.5;
  const dx = Math.round(cx / g) * g - cx;
  const dz = Math.round(cz / g) * g - cz;
  worldPos.x += dx;
  worldPos.y += dy;
  worldPos.z += dz;
}

/**
 * Snap world-space rotation (YXZ euler) so pitch, yaw, and roll each land on `SNAP_ROT_RAD` steps.
 * Preserves tilt from the controller; only quantizes angles.
 */
function snapWorldEulerOnQuaternion_(q) {
  _euler.setFromQuaternion(q, "YXZ");
  _euler.order = "YXZ";
  _euler.x = Math.round(_euler.x / SNAP_ROT_RAD) * SNAP_ROT_RAD;
  _euler.y = Math.round(_euler.y / SNAP_ROT_RAD) * SNAP_ROT_RAD;
  _euler.z = Math.round(_euler.z / SNAP_ROT_RAD) * SNAP_ROT_RAD;
  q.setFromEuler(_euler);
}

function snapUniformScaleOnCommit_(s, skipDueDualGrip) {
  if (skipDueDualGrip) return;
  if (Math.abs(s.x - s.y) > 0.03 || Math.abs(s.y - s.z) > 0.03) return;
  const u = (s.x + s.y + s.z) / 3;
  const snapped = Math.max(0.05, Math.round(u / SNAP_SCALE_STEP) * SNAP_SCALE_STEP);
  s.setScalar(snapped);
}

/** Resting finger often reports ~0.2–0.5 analog — only deliberate pull disables snap. */
function xrIndexTriggerSnapOverride_(btn) {
  if (!btn) return false;
  if (btn.pressed) return true;
  const v = typeof btn.value === "number" ? btn.value : 0;
  return v > 0.92;
}

function disposeCarryVisual(root) {
  if (!root) return;
  root.traverse((o) => {
    if (o.isMesh) {
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (let i = 0; i < mats.length; i++) mats[i]?.dispose?.();
    }
  });
}

function refreshSectorKeys_(oldKey, newKey, getLoadedSectorRec) {
  const seen = new Set();
  for (const k of [oldKey, newKey]) {
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const rec = getLoadedSectorRec(k);
    if (rec?.group) refreshUserSectorIfLoaded(k, rec);
  }
}

function commitCarryDrop_(scene, getLoadedSectorRec, setStatus, snapOverride = false) {
  if (!carryVisual_ || !carryPrimaryGrip_ || !scene) {
    editManipMode_ = "idle";
    carryVisual_ = null;
    carryPrimaryGrip_ = null;
    return;
  }
  carryVisual_.updateMatrixWorld(true);
  carryVisual_.matrixWorld.decompose(_cPos, _cQuat, _cScale);
  sanitizeInstanceScale_(_cScale);
  _cQuat.normalize();
  const oldK = carryKeyAtGrab_;
  if (editManipMode_ === "carryNew") {
    if (!snapOverride) {
      snapUniformScaleOnCommit_(_cScale, carryDidDualScaleThisCarry_);
      syncUserSectorRootsWorldMatrix_(getLoadedSectorRec);
      const hit =
        carryPrimaryGrip_ && carryLibId_ ? raycastClosestCollisionHit_(carryPrimaryGrip_, 220) : null;
      /** @type {{ surfaceStack: boolean, refFaceSnap: boolean }} */
      let applied = { surfaceStack: false, refFaceSnap: false };
      if (hit && carryPrimaryGrip_ && getGripWorldRay(carryPrimaryGrip_, _origin, _dir)) {
        applied = applySurfaceFaceStackFromHit_(hit, _dir, carryPrimaryGrip_, carryLibId_, _cScale, false, _cPos, _cQuat);
      } else {
        snapWorldEulerOnQuaternion_(_cQuat);
      }
      if (!applied.surfaceStack || (applied.surfaceStack && !applied.refFaceSnap)) {
        snapWorldPositionToAxisGridUsingLibraryBounds(_cPos, _cQuat, _cScale, carryLibId_, SNAP_GRID_M);
      }
    }
    addInstanceAtWorld(_cPos, _cQuat, carryLibId_, _cScale);
    if (carryVisual_.parent) carryVisual_.parent.remove(carryVisual_);
    disposeCarryVisual(carryVisual_);
    const nk = sectorKeyFromWorldPos(_cPos);
    refreshSectorKeys_(nk, nk, getLoadedSectorRec);
    setStatus?.(`Placed ${carryLibId_}`);
  } else if (editManipMode_ === "carryEdit" && carryUuid_) {
    scene.attach(carryVisual_);
    carryVisual_.updateMatrixWorld(true);
    carryVisual_.matrixWorld.decompose(_cPos, _cQuat, _cScale);
    sanitizeInstanceScale_(_cScale);
    _cQuat.normalize();
    if (!snapOverride) {
      const lib = /** @type {string} */ (carryVisual_.userData?.sectorLibraryId || "");
      snapUniformScaleOnCommit_(_cScale, carryDidDualScaleThisCarry_);
      syncUserSectorRootsWorldMatrix_(getLoadedSectorRec);
      const hit = carryPrimaryGrip_ && lib ? raycastClosestCollisionHit_(carryPrimaryGrip_, 220) : null;
      /** @type {{ surfaceStack: boolean, refFaceSnap: boolean }} */
      let applied = { surfaceStack: false, refFaceSnap: false };
      if (hit && carryPrimaryGrip_ && getGripWorldRay(carryPrimaryGrip_, _origin, _dir)) {
        applied = applySurfaceFaceStackFromHit_(hit, _dir, carryPrimaryGrip_, lib, _cScale, false, _cPos, _cQuat);
      } else {
        snapWorldEulerOnQuaternion_(_cQuat);
      }
      if (!applied.surfaceStack || (applied.surfaceStack && !applied.refFaceSnap)) {
        snapWorldPositionToAxisGridUsingLibraryBounds(_cPos, _cQuat, _cScale, lib, SNAP_GRID_M);
      }
      applyWorldPoseToObject_(carryVisual_, _cPos, _cQuat, _cScale);
      carryVisual_.updateMatrixWorld(true);
      if (!applied.surfaceStack || (applied.surfaceStack && !applied.refFaceSnap)) {
        snapWorldPositionUsingObjectWorldAabb_(carryVisual_, _cPos, SNAP_GRID_M);
      }
    }
    const nk = resyncInstanceWorld(carryUuid_, _cPos, _cQuat, _cScale);
    /* Do not dispose here — `refreshUserSectorIfLoaded` → `detachUserSectorAssets` drops the
     * old mesh (still listed on `rec.userSectorMeshes`) and rebuilds from JSON. */
    refreshSectorKeys_(oldK, nk || oldK, getLoadedSectorRec);
    setStatus?.("Updated prop");
  }
  ensureUserSectorMeshesInRunnerGlbCollision(getLoadedSectorRec);
  editManipMode_ = "idle";
  carryVisual_ = null;
  carryUuid_ = "";
  carryLibId_ = "";
  carryPrimaryGrip_ = null;
  carryKeyAtGrab_ = "";
  scaleAnchorD0_ = 0;
  carryDidDualScaleThisCarry_ = false;
}

function cancelCarryNewOnly_() {
  if (editManipMode_ !== "carryNew" || !carryVisual_ || !carryPrimaryGrip_) return;
  carryPrimaryGrip_.remove(carryVisual_);
  disposeCarryVisual(carryVisual_);
  editManipMode_ = "idle";
  carryVisual_ = null;
  carryPrimaryGrip_ = null;
  carryLibId_ = "";
  scaleAnchorD0_ = 0;
  carryDidDualScaleThisCarry_ = false;
}

function tryBeginCarryExisting_(mesh, primaryGrip, getLoadedSectorRec) {
  if (!mesh?.userData?.instanceUuid || !primaryGrip) return;
  const uuid = mesh.userData.instanceUuid;
  mesh.updateMatrixWorld(true);
  _cPos.setFromMatrixPosition(mesh.matrixWorld);
  carryKeyAtGrab_ = sectorKeyFromWorldPos(_cPos);
  const rec = getLoadedSectorRec(carryKeyAtGrab_);
  if (!rec?.userSectorRoot) return;
  /* Remove from global BVH list while parented to the controller, otherwise the carried
   * mesh keeps winning raycasts in front of everything else in the cell. */
  unregisterSandboxGlbCollisionMeshes([mesh]);
  primaryGrip.attach(mesh);
  editManipMode_ = "carryEdit";
  carryVisual_ = mesh;
  carryUuid_ = uuid;
  carryLibId_ = "";
  carryPrimaryGrip_ = primaryGrip;
  scaleAnchorD0_ = 0;
  carryDidDualScaleThisCarry_ = false;
}

export function isSandboxEditorManipulating() {
  return editManipMode_ !== "idle";
}

/**
 * @param {THREE.Scene | null} scene
 * @param {(key: string) => { group?: THREE.Group, userSectorRoot?: THREE.Group | null } | null | undefined} getLoadedSectorRec
 * @param {{ commit: boolean }} opts — commit false drops an in-flight new piece without writing JSON
 */
export function forceEditorManipulatorEnd(scene, getLoadedSectorRec, opts) {
  if (editManipMode_ === "idle") return;
  if (editManipMode_ === "carryNew" && !opts.commit) {
    cancelCarryNewOnly_();
    return;
  }
  if (scene && carryVisual_ && carryPrimaryGrip_) {
    commitCarryDrop_(scene, getLoadedSectorRec, () => {}, false);
  } else {
    cancelCarryNewOnly_();
  }
}

function getGripWorldRay(grip, outOrigin, outDir) {
  if (!grip) return false;
  grip.updateMatrixWorld(true);
  _mat.copy(grip.matrixWorld);
  outOrigin.setFromMatrixPosition(_mat);
  outDir.set(0, 0, -1).transformDirection(_mat).normalize();
  return true;
}

/** Quest Touch grip is analog: `value` rises before `pressed` in some runtimes. */
function xrGripSqueezed(btn) {
  if (!btn) return false;
  if (btn.pressed) return true;
  const v = typeof btn.value === "number" ? btn.value : 0;
  return v > 0.55;
}

/**
 * Pair Touch-style XR gamepads to logical left/right. Some runtimes leave
 * `handedness` empty — then the old loop never assigned squeeze/trigger.
 * @param {XRSession | null | undefined} session
 * @returns {{ L: XRInputSource | null, R: XRInputSource | null }}
 */
export function pairTouchGamepads(session) {
  /** @type {XRInputSource[]} */
  const list = [];
  const srcs = session?.inputSources;
  if (!srcs) return { L: null, R: null };
  for (let i = 0; i < srcs.length; i++) {
    const s = srcs[i];
    if (s?.gamepad?.buttons?.length) list.push(s);
  }
  let L = null;
  let R = null;
  /** @type {XRInputSource[]} */
  const amb = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const h = s.handedness;
    if (h === "left") L = s;
    else if (h === "right") R = s;
    else amb.push(s);
  }
  for (let i = 0; i < amb.length; i++) {
    const s = amb[i];
    if (!L) L = s;
    else if (!R) R = s;
    else break;
  }
  return { L, R };
}

/**
 * @param {XRInputSource | null} src
 * @param {THREE.Object3D | null | undefined} gripA
 * @param {THREE.Object3D | null | undefined} gripB
 */
function gripForInputSource(src, gripA, gripB) {
  if (!src) return null;
  if (gripA?.userData?.xrInputSource === src) return gripA;
  if (gripB?.userData?.xrInputSource === src) return gripB;
  return null;
}

/**
 * Logical squeeze + grip objects for editor / map=1 chord (handles missing handedness).
 * @param {XRSession | null | undefined} session
 * @param {THREE.Object3D | null | undefined} gripA  e.g. getControllerGrip(0)
 * @param {THREE.Object3D | null | undefined} gripB  e.g. getControllerGrip(1)
 */
export function getPairedXRControllerGrips(session, gripA, gripB) {
  const { L, R } = pairTouchGamepads(session);
  let leftGrip = gripForInputSource(L, gripA, gripB);
  let rightGrip = gripForInputSource(R, gripA, gripB);
  /* Fallback if grips were never matched to sources (older sessions). */
  if (!leftGrip && !rightGrip && (gripA || gripB)) {
    leftGrip = gripA || null;
    rightGrip = gripB && gripB !== leftGrip ? gripB : null;
  } else {
    if (!leftGrip && rightGrip && gripA && gripA !== rightGrip) leftGrip = gripA;
    if (!rightGrip && leftGrip && gripB && gripB !== leftGrip) rightGrip = gripB;
  }
  const squeezeLeft = L?.gamepad ? xrGripSqueezed(L.gamepad.buttons[1]) : false;
  const squeezeRight = R?.gamepad ? xrGripSqueezed(R.gamepad.buttons[1]) : false;
  return { L, R, leftGrip, rightGrip, squeezeLeft, squeezeRight };
}

function pickUserMeshesFromGlbCollision_() {
  const all = getSandboxGlbCollisionMeshes();
  return all.filter((m) => m?.isMesh && m.userData?.sectorUserAsset);
}

/**
 * Laser placement / aim / carry-drop snap: sector shell + user props, **not** the background city GLTF
 * (`userData.sandboxCityGlb` from `streamSandboxMap` city load).
 */
function fillEditorPlacementRaycastMeshes_() {
  _rayMeshScratch.length = 0;
  const all = getSandboxGlbCollisionMeshes();
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (m?.isMesh && m.geometry && !m.userData?.sandboxCityGlb) {
      _rayMeshScratch.push(m);
    }
  }
}

/**
 * Authoritative pick set: meshes listed on loaded sector records (includes props
 * parented to controllers during carry). The global `glbCollisionMeshes_` list can
 * miss or retain stale refs when unregister/register races with detach/dispose.
 * @param {(key: string) => { userSectorMeshes?: THREE.Mesh[] | null } | null | undefined} getRec
 */
function collectUserSectorPickMeshes(getRec) {
  /** @type {THREE.Mesh[]} */
  const out = [];
  const keys = getActiveSandboxSectorKeys();
  for (let i = 0; i < keys.length; i++) {
    const rec = getRec(keys[i]);
    const list = rec?.userSectorMeshes;
    if (!list?.length) continue;
    for (let j = 0; j < list.length; j++) {
      const m = list[j];
      if (m?.isMesh && m.geometry && m.userData?.sectorUserAsset) out.push(m);
    }
  }
  return out;
}

function syncUserSectorRootsWorldMatrix_(getRec) {
  const keys = getActiveSandboxSectorKeys();
  for (let i = 0; i < keys.length; i++) {
    const root = getRec(keys[i])?.userSectorRoot;
    if (root) root.updateMatrixWorld(true);
  }
}

/** Clamp JSON `s` so raycasts and transforms never go degenerate after carry decompose. */
function sanitizeInstanceScale_(v) {
  const lo = 0.02;
  const hi = 80;
  v.x = THREE.MathUtils.clamp(Math.abs(v.x) > 1e-6 ? Math.abs(v.x) : 1, lo, hi);
  v.y = THREE.MathUtils.clamp(Math.abs(v.y) > 1e-6 ? Math.abs(v.y) : 1, lo, hi);
  v.z = THREE.MathUtils.clamp(Math.abs(v.z) > 1e-6 ? Math.abs(v.z) : 1, lo, hi);
}

/**
 * Closest user-prop hit along grip ray (not just first mesh in array order).
 * @param {THREE.Object3D | null} grip
 * @param {number} maxDist
 * @returns {THREE.Mesh | null}
 */
function raycastClosestUserMesh(grip, maxDist = 24, getRec) {
  if (!getGripWorldRay(grip, _origin, _dir)) return null;
  let pick = getRec ? collectUserSectorPickMeshes(getRec) : pickUserMeshesFromGlbCollision_();
  if (!pick.length) pick = pickUserMeshesFromGlbCollision_();
  if (!pick.length) return null;
  for (let i = 0; i < pick.length; i++) pick[i].updateMatrixWorld(true);
  _ray.set(_origin, _dir);
  _ray.far = maxDist;
  _ray.firstHitOnly = false;
  const hits = _ray.intersectObjects(pick, false);
  if (!hits.length) return null;
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const d = h.distance;
    const m = h.object?.isMesh ? /** @type {THREE.Mesh} */ (h.object) : null;
    if (!m?.userData?.sectorUserAsset || !(d < bestD)) continue;
    bestD = d;
    best = m;
  }
  return best;
}

/**
 * @param {THREE.XRTargetRaySpace | THREE.Object3D | null} grip
 * @param {number} maxDist
 * @returns {THREE.Mesh | null}
 */
function raycastFirstUserMesh(grip, maxDist = 80, getRec) {
  return raycastClosestUserMesh(grip, maxDist, getRec);
}

/**
 * @param {THREE.XRTargetRaySpace | THREE.Object3D | null} grip
 * @param {number} maxDist
 * @returns {THREE.Vector3 | null} hit point world
 */
function raycastWorldHit(grip, maxDist = 220) {
  if (!getGripWorldRay(grip, _origin, _dir)) return null;
  const all = getSandboxGlbCollisionMeshes().filter(
    (m) => m?.isMesh && m.geometry && !m.userData?.sectorUserAsset && !m.userData?.sandboxCityGlb,
  );
  if (!all.length) return null;
  _ray.set(_origin, _dir);
  _ray.far = maxDist;
  _ray.firstHitOnly = true;
  const hits = _ray.intersectObjects(all, false);
  if (!hits.length) return null;
  _hit.copy(hits[0].point);
  return _hit;
}

/**
 * Closest ray hit for **editor** placement: sector shell + user props (city GLB excluded).
 * @param {THREE.Object3D | null} grip
 * @param {number} maxDist
 * @returns {import("three").Intersection | null}
 */
function raycastClosestCollisionHit_(grip, maxDist = 220) {
  if (!getGripWorldRay(grip, _origin, _dir)) return null;
  fillEditorPlacementRaycastMeshes_();
  if (!_rayMeshScratch.length) return null;
  for (let i = 0; i < _rayMeshScratch.length; i++) _rayMeshScratch[i].updateMatrixWorld(true);
  _ray.set(_origin, _dir);
  _ray.far = maxDist;
  _ray.firstHitOnly = false;
  const hits = _ray.intersectObjects(_rayMeshScratch, false);
  if (!hits.length) return null;
  hits.sort((a, b) => a.distance - b.distance);
  return hits[0];
}

/** Full controller orientation for placement (then optional euler snap). */
function placementQuatFromGrip_(grip, outQ) {
  if (!grip) {
    outQ.identity();
    return;
  }
  grip.updateMatrixWorld(true);
  _mat.copy(grip.matrixWorld);
  outQ.setFromRotationMatrix(_mat);
  outQ.normalize();
}

/**
 * Shared laser / carry-drop: face outward normal, optional reference-box orientation, flush stack offset,
 * and tangent snap. When `refFaceSnap`, tangential origin follows the **reference mesh center** projected
 * onto the hit face (not the click point), so height/edge alignment matches the struck prop.
 * @param {import("three").Intersection} hit
 * @param {THREE.Vector3} rayDirWorld unit (for glancing test)
 * @param {THREE.Object3D | null} fallbackGrip
 * @param {string} libId
 * @param {THREE.Vector3 | null} scaleVec
 * @param {boolean} snapOff
 * @param {THREE.Vector3} outPos
 * @param {THREE.Quaternion} outQuat
 * @returns {{ surfaceStack: boolean, refFaceSnap: boolean }}
 */
function applySurfaceFaceStackFromHit_(hit, rayDirWorld, fallbackGrip, libId, scaleVec, snapOff, outPos, outQuat) {
  const obj = hit.object;
  let glancing = true;
  if (obj?.isMesh && hit.face?.normal) {
    obj.updateMatrixWorld(true);
    _surfOutN.copy(hit.face.normal).transformDirection(obj.matrixWorld).normalize();
    if (_surfOutN.dot(rayDirWorld) > 0.001) _surfOutN.negate();
    glancing = Math.abs(_surfOutN.dot(rayDirWorld)) < 0.06;
  }
  const refFaceSnap =
    !snapOff &&
    !glancing &&
    obj?.isMesh &&
    hit.face?.normal &&
    libraryUsesBoxReferenceFaceAlign_(libId) &&
    quaternionFromReferenceBoxFace(obj, hit.face.normal, _surfOutN, libId, outQuat, _surfTanU, _surfTanV);
  if (!refFaceSnap) {
    placementQuatFromGrip_(fallbackGrip, outQuat);
    if (!snapOff) {
      snapWorldEulerOnQuaternion_(outQuat);
    }
  }
  let surfaceStack = false;
  if (obj?.isMesh && hit.face?.normal && !glancing) {
    const d = computeSurfaceStackCenterOffsetAlongNormal(libId, outQuat, _surfOutN, scaleVec);
    if (d > 1e-4) {
      if (refFaceSnap) {
        obj.getWorldPosition(_surfRefCenter);
        projectWorldPointOntoPlane(_surfRefCenter, hit.point, _surfOutN, _surfPlaneAnchor);
        outPos.copy(_surfPlaneAnchor).addScaledVector(_surfOutN, d);
      } else {
        outPos.copy(hit.point).addScaledVector(_surfOutN, d);
      }
      surfaceStack = true;
    }
  }
  if (refFaceSnap && surfaceStack) {
    snapWorldPositionTangentPlaneGrid(_surfPlaneAnchor, outPos, _surfOutN, SNAP_GRID_M, _surfTanU, _surfTanV);
  }
  return { surfaceStack, refFaceSnap };
}

/**
 * Add one library instance at the **right-hand** laser hit (closest collision: world + user props).
 * When the hit has a face normal, offset the center so the new piece sits flush on that side (stacking).
 * @param {Gamepad | null | undefined} gpRight — index trigger held = placement snap off for this add.
 */
function tryInstantAddFromRightLaser_(rightGrip, gpRight, getLoadedSectorRec, setStatus) {
  syncUserSectorRootsWorldMatrix_(getLoadedSectorRec);
  const hit = raycastClosestCollisionHit_(rightGrip, 220);
  if (!hit) {
    setStatus?.("Add: aim right laser at a surface");
    return;
  }
  const lib = getCurrentLibraryId();
  if (!lib) {
    setStatus?.("Add: pick a library entry first");
    return;
  }
  const snapOff = xrIndexTriggerSnapOverride_(gpRight?.buttons?.[0]);
  if (!getGripWorldRay(rightGrip, _origin, _dir)) {
    setStatus?.("Add: aim right laser at a surface");
    return;
  }
  const refMesh = /** @type {THREE.Mesh} */ (hit.object);
  const refLibId = refMesh?.userData?.sectorLibraryId;
  const matchRefScale = !snapOff && !!refLibId && refLibId === lib && !!refMesh?.isMesh;
  let stackScaleVec = null;
  if (matchRefScale) {
    refMesh.getWorldScale(_refMatchScale);
    sanitizeInstanceScale_(_refMatchScale);
    stackScaleVec = _refMatchScale;
  }
  const { surfaceStack, refFaceSnap } = applySurfaceFaceStackFromHit_(hit, _dir, rightGrip, lib, stackScaleVec, snapOff, _cPos, _quat);
  if (!surfaceStack) {
    _cPos.copy(hit.point);
  }
  const addScale = matchRefScale && surfaceStack ? _refMatchScale : null;
  if (!snapOff && (!surfaceStack || (surfaceStack && !refFaceSnap))) {
    snapWorldPositionToAxisGridUsingLibraryBounds(_cPos, _quat, addScale, lib, SNAP_GRID_M);
  }
  addInstanceAtWorld(_cPos, _quat, lib, addScale);
  const nk = sectorKeyFromWorldPos(_cPos);
  refreshSectorKeys_(nk, nk, getLoadedSectorRec);
  ensureUserSectorMeshesInRunnerGlbCollision(getLoadedSectorRec);
  setStatus?.(
    surfaceStack ? (addScale ? `Placed ${lib} (surface · matched scale)` : `Placed ${lib} (surface)`) : `Placed ${lib}`,
  );
}

/**
 * World-space aim lasers for the sector editor (one segment per grip).
 * Each segment runs from the grip origin to the first hit (user props + sector shell; city GLB excluded), or `maxDist` if none.
 * @param {THREE.Object3D | null} leftGrip
 * @param {THREE.Object3D | null} rightGrip
 * @param {THREE.BufferGeometry} geomLeft  two vertices (line)
 * @param {THREE.BufferGeometry} geomRight
 * @param {number} [maxDist]
 */
export function updateEditorAimLasers(leftGrip, rightGrip, geomLeft, geomRight, maxDist = 220) {
  const fill = (grip, geom) => {
    const pos = geom.getAttribute("position");
    const ar = /** @type {Float32Array} */ (pos.array);
    if (!getGripWorldRay(grip, _origin, _dir)) {
      ar[0] = 0;
      ar[1] = 0;
      ar[2] = 0;
      ar[3] = 0;
      ar[4] = 0;
      ar[5] = 0;
      return;
    }
    ar[0] = _origin.x;
    ar[1] = _origin.y;
    ar[2] = _origin.z;
    fillEditorPlacementRaycastMeshes_();
    let tEnd = maxDist;
    if (_rayMeshScratch.length) {
      _ray.set(_origin, _dir);
      _ray.far = maxDist;
      _ray.firstHitOnly = true;
      const hits = _ray.intersectObjects(_rayMeshScratch, false);
      if (hits.length) tEnd = hits[0].distance;
    }
    _hit.copy(_origin).addScaledVector(_dir, tEnd);
    ar[3] = _hit.x;
    ar[4] = _hit.y;
    ar[5] = _hit.z;
    pos.needsUpdate = true;
  };
  fill(leftGrip, geomLeft);
  fill(rightGrip, geomRight);
  geomLeft.computeBoundingSphere();
  geomRight.computeBoundingSphere();
}

function pushSandboxSectorUndoSnapshot_() {
  sectorRedoStack_.length = 0;
  sectorUndoStack_.push(getSectorAssetDocumentJson());
  if (sectorUndoStack_.length > SECTOR_UNDO_MAX) sectorUndoStack_.shift();
}

function clearSandboxSectorUndoStacks_() {
  sectorUndoStack_.length = 0;
  sectorRedoStack_.length = 0;
}

/** Wire snapshot + clear hooks (call once from map=1 init). */
export function installSectorEditorUndoHooks() {
  registerSectorAssetHistoryHooks(
    pushSandboxSectorUndoSnapshot_,
    clearSandboxSectorUndoStacks_,
  );
}

/**
 * @param {(key: string) => { group?: THREE.Group } | null | undefined} getRec
 * @returns {boolean} whether an undo step ran
 */
export function undoSandboxSectorEdit(getRec) {
  if (sectorUndoStack_.length === 0) return false;
  sectorRedoStack_.push(getSectorAssetDocumentJson());
  const prev = sectorUndoStack_.pop();
  setSectorAssetDocumentFromJson(prev, { skipDocumentReplacedHook: true });
  editorReloadAllLoadedSectors(getRec);
  ensureUserSectorMeshesInRunnerGlbCollision(getRec);
  return true;
}

/**
 * @param {(key: string) => { group?: THREE.Group } | null | undefined} getRec
 * @returns {boolean} whether a redo step ran
 */
export function redoSandboxSectorEdit(getRec) {
  if (sectorRedoStack_.length === 0) return false;
  sectorUndoStack_.push(getSectorAssetDocumentJson());
  const next = sectorRedoStack_.pop();
  setSectorAssetDocumentFromJson(next, { skipDocumentReplacedHook: true });
  editorReloadAllLoadedSectors(getRec);
  ensureUserSectorMeshesInRunnerGlbCollision(getRec);
  return true;
}

/** @param {{ session: XRSession | null, scene: THREE.Scene | null, gripA: THREE.Object3D | null, gripB: THREE.Object3D | null, getLoadedSectorRec: (key: string) => { group?: THREE.Group, userSectorRoot?: unknown } | null | undefined, setStatus?: (s: string) => void, showVrToast?: (msg: string, opts?: { error?: boolean }) => void }} ctx */
export function tickSandboxSectorEditor(ctx) {
  const { session, scene, gripA, gripB, getLoadedSectorRec, setStatus, showVrToast } = ctx;
  if (!session) return;

  syncUserSectorRootsWorldMatrix_(getLoadedSectorRec);

  const paired = getPairedXRControllerGrips(session, gripA, gripB);
  const { leftGrip, rightGrip, L, R } = paired;
  const gpL = L?.gamepad;
  const gpR = R?.gamepad;
  const lSq = xrGripSqueezed(gpL?.buttons?.[1]);
  const rSq = xrGripSqueezed(gpR?.buttons?.[1]);
  const menuL = !!(gpL?.buttons?.[6]?.pressed);
  const menuR = !!(gpR?.buttons?.[6]?.pressed);
  const yFaceLeft = !!(gpL?.buttons?.[5]?.pressed);
  const bFaceRight = !!(gpR?.buttons?.[5]?.pressed);
  /** Quest: left X=4, left Y=5, right A=4, right B=5 */
  const xLeft = !!(gpL?.buttons?.[4]?.pressed);
  const aRight = !!(gpR?.buttons?.[4]?.pressed);
  const dualGrip = paired.squeezeLeft && paired.squeezeRight;
  const nowMs = typeof performance !== "undefined" ? performance.now() : 0;

  const primarySq = squeezeOnGrip(carryPrimaryGrip_, leftGrip, rightGrip, gpL, gpR);

  let editorSnapOverride = false;
  if (editManipMode_ !== "idle" && carryPrimaryGrip_) {
    const gCarry = carryPrimaryGrip_ === leftGrip ? gpL : carryPrimaryGrip_ === rightGrip ? gpR : null;
    editorSnapOverride = xrIndexTriggerSnapOverride_(gCarry?.buttons?.[0]);
  }

  if ((editManipMode_ === "carryEdit" || editManipMode_ === "carryNew")
      && carryVisual_ && leftGrip && rightGrip && lSq && rSq) {
    leftGrip.getWorldPosition(_cLw);
    rightGrip.getWorldPosition(_cRw);
    const d = _cLw.distanceTo(_cRw);
    if (scaleAnchorD0_ <= 0) {
      scaleAnchorD0_ = Math.max(0.09, d);
      scaleAnchorS0_ = (carryVisual_.scale.x + carryVisual_.scale.y + carryVisual_.scale.z) / 3;
    }
    const ratio = THREE.MathUtils.clamp(d / scaleAnchorD0_, 0.03, 40);
    const s = scaleAnchorS0_ * ratio;
    carryVisual_.scale.setScalar(s);
    if (Math.abs(ratio - 1) > 0.05) carryDidDualScaleThisCarry_ = true;
  } else {
    scaleAnchorD0_ = 0;
  }

  if (editManipMode_ !== "idle") {
    if (prevPrimarySq_ && !primarySq && scene) {
      commitCarryDrop_(scene, getLoadedSectorRec, setStatus, editorSnapOverride);
    }
  } else {
    const ls = stickCombinedPressed(gpL);
    const rs = stickCombinedPressed(gpR);
    if (ls && !prevLStick_) {
      const id = cycleLibrarySelection(-1);
      setStatus?.(`Library: ${id}`);
    }
    if (rs && !prevRStick_) {
      const id = cycleLibrarySelection(1);
      setStatus?.(`Library: ${id}`);
    }

    /* Right A: add at right laser hit (sector shell / props; city excluded from raycast). */
    if (aRight && !prevARight_ && rightGrip) {
      tryInstantAddFromRightLaser_(rightGrip, gpR, getLoadedSectorRec, setStatus);
    }
    /* Left Y (not while left squeeze — that is undo): delete prop under **right** laser. */
    if (yFaceLeft && !prevYLeft_ && !lSq && !bFaceRight && rightGrip) {
      const m = raycastFirstUserMesh(rightGrip, 90, getLoadedSectorRec);
      if (m?.userData?.instanceUuid) {
        const uuid = m.userData.instanceUuid;
        const key = removeInstanceByUuid(uuid);
        if (key) {
          const rec = getLoadedSectorRec(key);
          if (rec?.group) refreshUserSectorIfLoaded(key, rec);
          ensureUserSectorMeshesInRunnerGlbCollision(getLoadedSectorRec);
          setStatus?.("Removed instance");
        }
      }
    }
    /* BattleVR-style: left squeeze + Y = undo, left squeeze + X = redo (before grab so squeeze+Y does not pick up a prop). */
    if (lSq && yFaceLeft && !prevYLeft_ && nowMs - lastSectorUndoMs_ >= SECTOR_UNDO_REDO_DEBOUNCE_MS) {
      if (undoSandboxSectorEdit(getLoadedSectorRec)) {
        lastSectorUndoMs_ = nowMs;
        setStatus?.("Undo");
      }
    }
    if (lSq && xLeft && !prevXLeft_ && nowMs - lastSectorRedoMs_ >= SECTOR_UNDO_REDO_DEBOUNCE_MS) {
      if (redoSandboxSectorEdit(getLoadedSectorRec)) {
        lastSectorRedoMs_ = nowMs;
        setStatus?.("Redo");
      }
    }

    if (!dualGrip) {
      const hitL = raycastFirstUserMesh(leftGrip, 18, getLoadedSectorRec);
      const hitR = raycastFirstUserMesh(rightGrip, 18, getLoadedSectorRec);
      if (lSq && !prevLSqueeze_ && hitL && !yFaceLeft && !xLeft) {
        tryBeginCarryExisting_(hitL, leftGrip, getLoadedSectorRec);
      } else if (rSq && !prevRSqueeze_ && hitR && !aRight) {
        tryBeginCarryExisting_(hitR, rightGrip, getLoadedSectorRec);
      }
    }
  }

  if ((menuL && !prevMenuL_) || (menuR && !prevMenuR_)) {
    persistSectorAssetsToIndexedDB()
      .then(() => {
        setStatus?.("Saved locally (browser)");
        showVrToast?.("Saved — browser storage");
      })
      .catch((err) => {
        console.warn("[sandboxEditor] IndexedDB save failed:", err);
        setStatus?.("Save failed — see console");
        showVrToast?.("Save failed (see console)", { error: true });
      });
  }

  if (yFaceLeft && bFaceRight) {
    if (ybChordStartMs_ <= 0) ybChordStartMs_ = typeof performance !== "undefined" ? performance.now() : 0;
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    if (!ybChordFiredThisHold_ && now - ybChordStartMs_ > 420) {
      ybChordFiredThisHold_ = true;
      persistSectorAssetsToIndexedDB()
        .then(() => {
          setStatus?.("Saved locally (Y+B)");
          showVrToast?.("Saved — browser storage");
        })
        .catch((err) => {
          console.warn("[sandboxEditor] IndexedDB save failed:", err);
          setStatus?.("Save failed — see console");
          showVrToast?.("Save failed (see console)", { error: true });
        });
    }
  } else {
    ybChordStartMs_ = 0;
    ybChordFiredThisHold_ = false;
  }

  prevLSqueeze_ = lSq;
  prevRSqueeze_ = rSq;
  prevMenuL_ = menuL;
  prevMenuR_ = menuR;
  prevPrimarySq_ = primarySq;
  prevLStick_ = stickCombinedPressed(gpL);
  prevRStick_ = stickCombinedPressed(gpR);
  prevARight_ = aRight;
  prevXLeft_ = xLeft;
  prevYLeft_ = yFaceLeft;
}

export function resetSandboxSectorEditorInputEdges() {
  prevLSqueeze_ = false;
  prevRSqueeze_ = false;
  prevMenuL_ = false;
  prevMenuR_ = false;
  ybChordStartMs_ = 0;
  ybChordFiredThisHold_ = false;
  prevLStick_ = false;
  prevRStick_ = false;
  prevPrimarySq_ = false;
  prevARight_ = false;
  prevXLeft_ = false;
  prevYLeft_ = false;
  lastSectorUndoMs_ = 0;
  lastSectorRedoMs_ = 0;
}

export function editorDownloadJson() {
  downloadSectorAssetDocument();
}

export function editorGetJson() {
  return getSectorAssetDocumentJson();
}

export function editorLoadJson(text) {
  setSectorAssetDocumentFromJson(text);
}

export function editorCycleLibrary(delta = 1) {
  return cycleLibrarySelection(delta);
}

export function editorGetLibraryId() {
  return getCurrentLibraryId();
}

export function editorListLibrary() {
  return getLibraryIds();
}

/** Runtime check: grid / euler rotation / scale snap used on commit and instant-add (meters / degrees). */
export function getSandboxEditorSnapSettings() {
  const rotDeg = THREE.MathUtils.radToDeg(SNAP_ROT_RAD);
  return {
    positionGridM: SNAP_GRID_M,
    /** Step for each of pitch, yaw, roll (YXZ euler, world space). */
    rotationSnapDeg: rotDeg,
    /** @deprecated Same as `rotationSnapDeg`; kept for older console snippets. */
    yawSnapDeg: rotDeg,
    uniformScaleStep: SNAP_SCALE_STEP,
  };
}

/** @param {(key: string) => { group?: THREE.Group } | null | undefined} getRec */
export function editorReloadAllLoadedSectors(getRec) {
  const keys = getActiveSandboxSectorKeys();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const rec = getRec(key);
    if (rec?.group) refreshUserSectorIfLoaded(key, rec);
  }
}

/**
 * Re-add all placed user props to the global GLB BVH list (e.g. after editor grab
 * temporarily unregistered them, or when returning to physics locomotion).
 * @param {(key: string) => { userSectorMeshes?: THREE.Mesh[] | null } | null | undefined} getRec
 */
export function ensureUserSectorMeshesInRunnerGlbCollision(getRec) {
  const keys = getActiveSandboxSectorKeys();
  for (let i = 0; i < keys.length; i++) {
    const rec = getRec(keys[i]);
    const list = rec?.userSectorMeshes;
    if (list?.length) registerSandboxGlbCollisionMeshes(list);
  }
}
