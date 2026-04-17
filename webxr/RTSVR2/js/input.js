// ========================================
// RTSVR2 — Input System
// VR controllers + keyboard/mouse fallback
// ========================================

import {
  UNIT_TYPES, BUILDING_TYPES, clampWorldToPlayableDisk, isWorldInsidePlayableDisk,
  SPAWN_POSITIONS,
} from './config.js';
import * as State from './state.js';
import * as Buildings from './buildings.js';
import * as Renderer from './renderer.js';
import * as UI from './ui.js';
import * as Network from './network.js';
import * as Audio from './audio.js';
import { toggleTerrainGrid, sampleMoonTerrainWorldY } from './moon-environment.js';

// --- State ---
let isVR = false;
/** Set in initInput; used to sync isVR from WebXR session + A-Frame VR mode. */
let sceneElForVrSync = null;
/** A-Frame enter-vr / exit-vr (reliable on Quest); combined per-frame with isPresentingWebXR for desktop. */
let aframeVrHint = false;
let webxrSessionListenersBound = false;
const mouse = { x: 0, y: 0, down: false, rightDown: false };
const keys = {};
/** Default rig height (m); keep in sync with `#cameraRig` Y in index.html. */
const CAMERA_RIG_DEFAULT_Y = 32;

/** Y matches `#cameraRig` in index.html so the sim never overwrites scene zoom before first tick. */
const cameraRig = { x: 0, y: CAMERA_RIG_DEFAULT_Y, z: 0, rotY: 0 };

/**
 * First-open lobby: orbit the rig ~30° around HQ in XZ while yawing the same amount (negative = “E” / right-thumbstick sense),
 * and ease rig height from a more zoomed-out view down to the normal overview.
 * Cleared when the ease completes.
 */
let lobbyIntroOrbit = null;

/** Total yaw (rad) for lobby orbit arc (~30°). */
const LOBBY_INTRO_DELTA_YAW = -Math.PI / 6;
/** Start rig this many metres higher than the settle height (more zoomed out), clamped to CAMERA_Y_MAX. */
const LOBBY_INTRO_ZOOM_OFFSET_M = 22;

function smoothstepEase01(t) {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

/** Read `#cameraRig` position from A-Frame (authoritative vs object3D after any stale JS writes). */
function syncCameraRigFromCameraRigEntity() {
  const rig = document.getElementById('cameraRig');
  if (!rig || typeof rig.getAttribute !== 'function') return;
  const p = rig.getAttribute('position');
  if (p && typeof p === 'object') {
    if (typeof p.x === 'number') cameraRig.x = p.x;
    if (typeof p.y === 'number') cameraRig.y = p.y;
    if (typeof p.z === 'number') cameraRig.z = p.z;
  } else if (typeof p === 'string') {
    const m = p.trim().split(/\s+/);
    if (m.length >= 3) {
      const px = parseFloat(m[0]);
      const py = parseFloat(m[1]);
      const pz = parseFloat(m[2]);
      if (Number.isFinite(px)) cameraRig.x = px;
      if (Number.isFinite(py)) cameraRig.y = py;
      if (Number.isFinite(pz)) cameraRig.z = pz;
    }
  }
  if (rig.object3D && Number.isFinite(rig.object3D.rotation?.y)) {
    cameraRig.rotY = rig.object3D.rotation.y;
  }
}

/** Call once after lobby HQ is placed; start pose from `#cameraRig` attributes + yaw from object3D. */
export function beginLobbyIntroOrbitAroundHq(pivotX, pivotZ) {
  syncCameraRigFromCameraRigEntity();
  const ox = cameraRig.x - pivotX;
  const oz = cameraRig.z - pivotZ;
  if (Math.hypot(ox, oz) < 0.5) return;
  const yEnd = cameraRig.y;
  const yStart = Math.min(CAMERA_Y_MAX, yEnd + LOBBY_INTRO_ZOOM_OFFSET_M);
  lobbyIntroOrbit = {
    pivotX,
    pivotZ,
    ox,
    oz,
    rotY0: cameraRig.rotY,
    y0: yEnd,
    yStart,
    startMs: performance.now(),
    durationMs: 7000,
    deltaYaw: LOBBY_INTRO_DELTA_YAW,
  };
  cameraRig.y = yStart;
  const rig = document.getElementById('cameraRig');
  if (rig) {
    rig.object3D.position.set(cameraRig.x, cameraRig.y, cameraRig.z);
    rig.object3D.rotation.y = cameraRig.rotY;
  }
  syncFlatScreenCameraPitch();
}

/** Rig height (m): lower = zoomed in (closer to map). Used for flat-screen camera pitch blend. */
const CAMERA_Y_MIN = 10;
const CAMERA_Y_MAX = 80;
/** `#camera` local X pitch (deg) when zoomed out (`cameraRig.y` high). Shallower than −75° for reference framing. */
const FLAT_CAM_PITCH_ZOOMED_OUT = -62;
/** At full zoom-in, pitch rotates this many degrees toward the horizon (less downward look). */
const FLAT_CAM_PITCH_ZOOM_IN_EXTRA = 38;

// VR controller state (grip pan matches original RTSVR rts-controller: rig-local deltas + rotY)
const vrLeft = {
  grip: false, trigger: false, thumbX: 0, thumbY: 0,
  gripPanInited: false,
  _gripRef: null,
};
const vrRight = {
  grip: false, trigger: false, thumbX: 0, thumbY: 0,
  gripPanInited: false,
  _gripRef: null,
};
/** Both grips: pinch height like RTSVR (world hand distance delta). */
const vrPinch = { active: false, lastDist: 0 };
let lastTriggerTime = 0;
/** While exactly one controller trigger is held, hide the other hand's aim line so only the active laser is visible. */
let vrLeftTriggerHeld = false;
let vrRightTriggerHeld = false;

function setVrAimRayShowLine(rayEl, on) {
  if (!rayEl || !rayEl.components || !rayEl.components.raycaster) return;
  rayEl.setAttribute('raycaster', 'showLine', on ? 'true' : 'false');
}

/** Only the right-hand child draws a raycaster line; left is tracked-controls only (no laser). */
function refreshVrHandAimLineVisibility() {
  if (!getIsVR()) return;
  const rightRay = document.querySelector('#rightHand [data-vr-aim-ray]');
  setVrAimRayShowLine(rightRay, true);
}

/** Touch: single-finger long-press / tap (non-VR). */
let touchLongPressTimer = null;
let touchOneFinger = null; // { x, y, id, t0, moved }
let touchLongPressConsumed = false;
let touchTwin = null; // two-finger camera gesture state
let touchTapSuppressed = false;
/** After touch interaction, ignore synthetic mouse clicks (mobile browsers). */
let suppressDesktopMouseFromTouchMs = 0;

const controlGroups = {};
let lastSquadPressTime = 0;
let lastSquadNum = null;

// Raycasting
const _raycaster = new THREE.Raycaster();
const _mouseNDC = new THREE.Vector2();
const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();
const _tempQuat = new THREE.Quaternion();
const _tempVec = new THREE.Vector3();
const _pinchL = new THREE.Vector3();
const _pinchR = new THREE.Vector3();
const _localDelta = new THREE.Vector3();
const _worldDelta = new THREE.Vector3();
const _handLocal = new THREE.Vector3();
/** Child [data-vr-aim-ray] uses RTSVR-style -90° X so local -Z is forward from the grip. */
function setVrAimRayFromController(controllerEl, origin, direction) {
  const child = controllerEl.querySelector('[data-vr-aim-ray]');
  if (child && child.object3D) {
    child.object3D.getWorldPosition(origin);
    direction.set(0, 0, -1);
    child.object3D.getWorldQuaternion(_tempQuat);
    direction.applyQuaternion(_tempQuat);
    return;
  }
  controllerEl.object3D.getWorldPosition(origin);
  direction.set(0, 0, -1);
  controllerEl.object3D.getWorldQuaternion(_tempQuat);
  direction.applyQuaternion(_tempQuat);
}

/**
 * Same world ray A-Frame's `raycaster` uses for the line and `checkIntersections` (origin/direction
 * schema + `localToWorld`). Pure `object3D` + local −Z can diverge on Quest (model ray origin).
 * Falls back to {@link setVrAimRayFromController} when the aim entity has no raycaster.
 */
function copyWorldRayFromHandAimRaycaster(controllerElRaw, origin, direction) {
  const hand = vrHandElForUiPick(controllerElRaw) || controllerElRaw;
  if (!hand || !hand.object3D) {
    origin.set(0, 0, 0);
    direction.set(0, -1, 0);
    return;
  }
  const aim = hand.querySelector('[data-vr-aim-ray]');
  const rcComp = aim && aim.components && aim.components.raycaster;
  const data = rcComp && rcComp.data;
  if (aim && aim.object3D && data && !data.useWorldCoordinates) {
    try {
      if (typeof aim.object3D.updateWorldMatrix === 'function') {
        aim.object3D.updateWorldMatrix(true, true);
      } else {
        aim.object3D.updateMatrixWorld(true);
      }
      origin.setFromMatrixPosition(aim.object3D.matrixWorld);
      const ox = data.origin ? data.origin.x : 0;
      const oy = data.origin ? data.origin.y : 0;
      const oz = data.origin ? data.origin.z : 0;
      if (ox !== 0 || oy !== 0 || oz !== 0) {
        _tempVec.set(ox, oy, oz);
        aim.object3D.localToWorld(_tempVec);
        origin.copy(_tempVec);
      }
      const dx = data.direction ? data.direction.x : 0;
      const dy = data.direction ? data.direction.y : 0;
      const dz = data.direction ? data.direction.z : -1;
      _tempVec.set(dx, dy, dz);
      _tempVec.transformDirection(aim.object3D.matrixWorld).normalize();
      direction.copy(_tempVec);
      return;
    } catch (_) {
      /* fall through */
    }
  }
  setVrAimRayFromController(hand, origin, direction);
}

/** Nearest `.clickable` on this entity or DOM ancestors (child mesh `.el` may be inner UI). */
function domClickableAncestor(el) {
  let n = el;
  while (n) {
    if (n.classList && n.classList.contains('clickable')) return n;
    n = n.parentElement;
  }
  return null;
}

function entityOrAncestorHasNoRaycast(el) {
  let n = el;
  while (n) {
    if (n.classList && n.classList.contains('no-raycast')) return true;
    n = n.parentElement;
  }
  return false;
}

function isAframeEntityVisibleInHierarchy(el) {
  if (!el) return false;
  let n = el;
  while (n) {
    if (n.isEntity) {
      const v = n.getAttribute('visible');
      if (v === false || v === 'false') return false;
    }
    n = n.parentElement;
  }
  return true;
}

/**
 * WebXR / laser-controls sometimes emit from the child aim entity (`#rightHandRay`) instead of
 * `#rightHand`. UI pick + raycaster refresh must always use the hand root that owns `[data-vr-aim-ray]`.
 */
function vrHandElForUiPick(raw) {
  if (!raw) return null;
  if (raw.id === 'rightHand' || raw.id === 'leftHand') return raw;
  if (raw.id === 'rightHandRay' || raw.id === 'leftHandRay') {
    return raw.parentElement || null;
  }
  try {
    if (typeof raw.closest === 'function') {
      return raw.closest('#rightHand') || raw.closest('#leftHand');
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

/**
 * Meta Quest Touch left `buttondown` indices match A-Frame’s mapping: 4 = X, 5 = Y (3 = thumbstick).
 * Older builds wrongly used 3/4, which swapped X/Y vs thumbstick. Override:
 * `localStorage RTS_VR_LEFT_XY_MAP = '{"x":4,"y":5}'`.
 */
function readLeftAuxFaceButtonIndices() {
  let xIdx = 4;
  let yIdx = 5;
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem('RTS_VR_LEFT_XY_MAP');
    if (raw) {
      const o = JSON.parse(raw);
      if (typeof o.x === 'number') xIdx = o.x;
      if (typeof o.y === 'number') yIdx = o.y;
    }
  } catch (_) {
    /* ignore */
  }
  return { xIdx, yIdx };
}

/**
 * `tracked-controls` only emits `axismove` ({ axis: number[], changed: boolean[] }); `thumbstickmoved`
 * comes from `meta-touch-controls` / `laser-controls`, which the left hand does not load.
 * Meta Touch maps the stick to gamepad axes 2–3 (see A-Frame `INPUT_MAPPING`). Override:
 * `localStorage RTS_VR_THUMB_AXES = '{"x":0,"y":1}'`.
 */
function readThumbstickXYFromAxisMoveDetail(detail) {
  const axis = detail && detail.axis;
  if (!Array.isArray(axis) || axis.length < 2) return null;
  let xIdx = 0;
  let yIdx = 1;
  if (axis.length >= 4) {
    xIdx = 2;
    yIdx = 3;
  }
  try {
    const raw = globalThis.localStorage && globalThis.localStorage.getItem('RTS_VR_THUMB_AXES');
    if (raw) {
      const o = JSON.parse(raw);
      if (typeof o.x === 'number') xIdx = o.x;
      if (typeof o.y === 'number') yIdx = o.y;
    }
  } catch (_) {
    /* ignore */
  }
  const x = Number(axis[xIdx]);
  const y = Number(axis[yIdx]);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

function refreshVrAimRaycasterObjects(handEl) {
  const aim = handEl && handEl.querySelector && handEl.querySelector('[data-vr-aim-ray]');
  const rc = aim && aim.components && aim.components.raycaster;
  if (rc && typeof rc.refreshObjects === 'function') {
    try {
      rc.refreshObjects();
    } catch (_) {
      /* ignore */
    }
  }
}

/** Wrist UI lives under `#leftHand`; matrices must be current before a raw THREE raycast in XR. */
function ensureVrWristUiWorldMatrices() {
  const sceneEl = document.querySelector('a-scene');
  if (sceneEl && sceneEl.object3D) {
    try {
      sceneEl.object3D.updateMatrixWorld(true);
    } catch (_) {
      /* ignore */
    }
  }
  ['cameraRig', 'leftHand', 'rightHand', 'vr-wrist-panel'].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.object3D) {
      try {
        el.object3D.updateMatrixWorld(true);
      } catch (_) {
        /* ignore */
      }
    }
  });
}

function resolveClickableEntityFromHitObject(hitObj, clickableEntities) {
  for (let i = 0; i < clickableEntities.length; i++) {
    const el = clickableEntities[i];
    const root = el && el.object3D;
    if (!root) continue;
    let o = hitObj;
    while (o) {
      if (o === root) return el;
      o = o.parent;
    }
  }
  return null;
}

/**
 * Prefer the child raycaster's `intersections` (same as the visible laser). Fall back to a
 * manual THREE ray over `.clickable` roots if the list is empty.
 */
function pickFromChildRaycasterIntersections(controllerEl) {
  const child = controllerEl && controllerEl.querySelector && controllerEl.querySelector('[data-vr-aim-ray]');
  const rc = child && child.components && child.components.raycaster;
  if (!rc || !rc.intersections || !rc.intersections.length) return null;
  const sorted = rc.intersections.slice().sort((a, b) => a.distance - b.distance);
  for (let i = 0; i < sorted.length; i++) {
    const hit = sorted[i];
    let o = hit.object;
    while (o && !o.el) o = o.parent;
    const ael = o && o.el;
    if (!ael || ael.id === 'ground') continue;
    const target = domClickableAncestor(ael);
    if (!target || !target.classList || !target.classList.contains('clickable')) continue;
    if (entityOrAncestorHasNoRaycast(target)) continue;
    return { target, intersection: hit };
  }
  return null;
}

function pickFromManualClickableRay(controllerEl) {
  copyWorldRayFromHandAimRaycaster(controllerEl, _origin, _direction);
  _tempVec.copy(_direction);
  if (_tempVec.lengthSq() < 1e-12) return null;
  _tempVec.normalize();

  _raycaster.set(_origin, _tempVec);
  _raycaster.near = 0;
  _raycaster.far = 200;

  ensureVrWristUiWorldMatrices();

  const clickableEntities = [];
  const roots = [];
  document.querySelectorAll('.clickable').forEach((el) => {
    if (!el.object3D || !el.isEntity) return;
    if (!isAframeEntityVisibleInHierarchy(el)) return;
    clickableEntities.push(el);
    roots.push(el.object3D);
  });
  if (roots.length === 0) return null;
  let hits = [];
  try {
    hits = _raycaster.intersectObjects(roots, true);
  } catch (_) {
    return null;
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.distance - b.distance);
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    let target = resolveClickableEntityFromHitObject(hit.object, clickableEntities);
    if (!target) {
      let o = hit.object;
      let ael = null;
      while (o) {
        if (o.el) {
          ael = o.el;
          break;
        }
        o = o.parent;
      }
      if (!ael || ael.id === 'ground') continue;
      target = domClickableAncestor(ael);
    }
    if (!target || target.id === 'ground') continue;
    if (entityOrAncestorHasNoRaycast(target)) continue;
    if (!target.classList || !target.classList.contains('clickable')) continue;
    return { target, intersection: hit };
  }
  return null;
}

function prepareVrAimRaycasterForPick(controllerEl) {
  refreshVrAimRaycasterObjects(controllerEl);
  ensureVrWristUiWorldMatrices();
  const aim = controllerEl.querySelector('[data-vr-aim-ray]');
  const rcComp = aim && aim.components && aim.components.raycaster;
  if (rcComp && typeof rcComp.checkIntersections === 'function') {
    try {
      rcComp.checkIntersections();
    } catch (_) {
      /* ignore */
    }
  }
}

function pickFirstClickableAlongControllerRay(controllerElRaw) {
  const controllerEl = vrHandElForUiPick(controllerElRaw) || controllerElRaw;
  if (!controllerEl) return null;

  prepareVrAimRaycasterForPick(controllerEl);

  const fromRc = pickFromChildRaycasterIntersections(controllerEl);
  if (fromRc) return fromRc;
  return pickFromManualClickableRay(controllerEl);
}

/**
 * Hover must follow the **visible** laser only. The manual `.clickable` fallback can disagree
 * with the A-Frame raycaster for one frame (wrist UI / stacked rows), which toggles
 * `vr-button-hover` every tick → blinking build buttons.
 */
function pickVrUiHoverTargetFromControllerRay(controllerElRaw) {
  const controllerEl = vrHandElForUiPick(controllerElRaw) || controllerElRaw;
  if (!controllerEl) return null;
  prepareVrAimRaycasterForPick(controllerEl);
  const fromRc = pickFromChildRaycasterIntersections(controllerEl);
  return fromRc ? fromRc.target : null;
}

function tryVrUiClickFromChildRay(controllerElRaw) {
  const picked = pickFirstClickableAlongControllerRay(controllerElRaw);
  if (!picked) return false;

  const t = picked.target;
  const fakeEvt = { type: 'click', detail: { intersection: picked.intersection } };

  try {
    const menu = t.components && t.components['rts-vr-menu-btn'];
    if (menu && typeof menu.onClick === 'function') {
      menu.onClick(fakeEvt);
      tryVrControllerPulse('right', 0.44, 34);
      return true;
    }
    const mini = t.components && t.components['rts-vr-minimap'];
    if (mini && typeof mini.onClick === 'function') {
      mini.onClick(fakeEvt);
      tryVrControllerPulse('right', 0.44, 34);
      return true;
    }
    const build = t.components && t.components['rts-vr-build-btn'];
    if (build && typeof build.onClick === 'function') {
      build.onClick(fakeEvt);
      tryVrControllerPulse('right', 0.44, 34);
      return true;
    }
  } catch (err) {
    console.warn('[RTSVR2] VR UI click handler failed', err);
  }

  if (t.id === 'vr-btn-app-start' && typeof window._dismissAppStartGate === 'function') {
    window._dismissAppStartGate();
    tryVrControllerPulse('right', 0.44, 34);
    return true;
  }

  try {
    t.emit('click', fakeEvt.detail, true);
  } catch (err2) {
    console.warn('[RTSVR2] VR UI click emit failed', err2);
    return false;
  }
  tryVrControllerPulse('right', 0.44, 34);
  return true;
}

globalThis.__rtsPickVrUiHoverTarget = function (controllerElRaw) {
  return pickVrUiHoverTargetFromControllerRay(controllerElRaw);
};

/**
 * True when an immersive XR session is active. Prefer this over enter-vr/exit-vr alone on standalone headsets.
 */
function isPresentingWebXR(scene) {
  if (!scene) return false;
  try {
    if (typeof scene.is === 'function' && scene.is('vr-mode')) return true;
  } catch (_) { /* ignore */ }
  try {
    const xr = scene.renderer && scene.renderer.xr;
    if (xr && typeof xr.getSession === 'function' && xr.getSession()) return true;
  } catch (_) { /* ignore */ }
  return false;
}

/**
 * WebXR gamepad haptics (`pulse` on Quest / Meta). No-op outside an active XR session.
 * @param {'left'|'right'} handedness
 * @param {number} intensity 0–1
 * @param {number} durationMs
 */
function tryVrControllerPulse(handedness, intensity = 0.35, durationMs = 30) {
  const scene = sceneElForVrSync || document.querySelector('a-scene');
  if (!scene || !isPresentingWebXR(scene)) return;
  const xr = scene.renderer && scene.renderer.xr;
  const session = xr && xr.getSession && xr.getSession();
  if (!session || !session.inputSources) return;
  const want = handedness === 'left' ? 'left' : 'right';
  const mag = Math.max(0, Math.min(1, intensity));
  const dur = Math.max(1, Math.min(400, durationMs));
  const sources = session.inputSources;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (!src || src.handedness !== want) continue;
    const gp = src.gamepad;
    const list = (gp && gp.hapticActuators) || src.hapticActuators;
    if (!list || !list.length) continue;
    const act = list[0];
    if (act && typeof act.pulse === 'function') {
      try {
        act.pulse(mag, dur);
      } catch (_) {
        /* ignore */
      }
      return;
    }
  }
}

/** Throttled world-under-laser hover id for VR haptics (`u:id` | `b:id` | `r:id`). */
let vrBfHoverKey = null;
let vrBfHoverAccum = 0;

function tickVrBattlefieldHoverPulse() {
  if (!isVR || !State.gameSession.gameStarted || State.gameSession.menuOpen) return;
  const rh = document.getElementById('rightHand');
  if (!rh) return;
  copyWorldRayFromHandAimRaycaster(rh, _origin, _direction);
  const sceneEl = sceneElForVrSync || document.querySelector('a-scene');
  const ndc = computeVrLaserPickNdc(sceneEl, _origin, _direction);
  const boost = getScreenPickRadiusBoost();
  let hitUnit = Renderer.raycastUnits(_origin, _direction, 200, boost, ndc);
  let hitBuilding = Renderer.raycastBuildings(_origin, _direction, 200, boost, ndc);
  let hitResource = Renderer.raycastResourceFields(_origin, _direction, 200, ndc);
  ({ u: hitUnit, b: hitBuilding, r: hitResource } = resolveOverlapPicks(
    hitUnit,
    hitBuilding,
    hitResource,
    ndc,
    _origin,
    _direction,
    boost
  ));
  const key = hitUnit ? `u:${hitUnit.id}` : hitBuilding ? `b:${hitBuilding.id}` : hitResource ? `r:${hitResource.id}` : null;
  if (key != null && key !== vrBfHoverKey) {
    tryVrControllerPulse('right', 0.11, 14);
  }
  vrBfHoverKey = key;
}

function recomputeIsVR() {
  const scene = sceneElForVrSync;
  if (!scene) return;
  const xrActive = isPresentingWebXR(scene);
  const next = aframeVrHint || xrActive;
  if (next !== isVR) {
    isVR = next;
    UI.updateMenuVisibility();
  }
}

function syncIsVRFromScene() {
  recomputeIsVR();
}

function attachWebXrSessionHints(scene) {
  const tryBind = () => {
    const xr = scene.renderer && scene.renderer.xr;
    if (!xr || webxrSessionListenersBound) return;
    webxrSessionListenersBound = true;
    xr.addEventListener('sessionstart', recomputeIsVR);
    xr.addEventListener('sessionend', recomputeIsVR);
  };
  if (scene.hasLoaded) tryBind();
  else scene.addEventListener('loaded', tryBind);
}

export function initInput(sceneEl) {
  const scene = sceneEl;
  sceneElForVrSync = sceneEl;
  globalThis.__rtsVrTryControllerPulse = tryVrControllerPulse;

  scene.addEventListener('enter-vr', () => {
    aframeVrHint = true;
    recomputeIsVR();
  });
  scene.addEventListener('exit-vr', () => {
    aframeVrHint = false;
    recomputeIsVR();
  });
  attachWebXrSessionHints(scene);

  // --- VR Controller Events ---
  // A-Frame dispatches button events FROM the controller entities, not the scene.
  const leftHand = document.getElementById('leftHand');
  const rightHand = document.getElementById('rightHand');

  if (rightHand) {
    rightHand.addEventListener('triggerdown', (e) => {
      vrRightTriggerHeld = true;
      refreshVrHandAimLineVisibility();
      onVRTriggerRight(e);
    });
    rightHand.addEventListener('triggerup', () => {
      vrRightTriggerHeld = false;
      refreshVrHandAimLineVisibility();
    });
    rightHand.addEventListener('gripdown', () => {
      vrRight.grip = true;
      vrRight.gripPanInited = false;
    });
    rightHand.addEventListener('gripup', () => {
      vrRight.grip = false;
      vrRight.gripPanInited = false;
      vrPinch.active = false;
    });
    rightHand.addEventListener('thumbstickmoved', e => {
      const d = e && e.detail;
      if (!d) return;
      if (typeof d.x === 'number' || typeof d.y === 'number') {
        vrRight.thumbX = d.x || 0;
        vrRight.thumbY = d.y || 0;
        return;
      }
      const ax = readThumbstickXYFromAxisMoveDetail(d);
      if (ax) {
        vrRight.thumbX = ax.x;
        vrRight.thumbY = ax.y;
      }
    });
    // A and B buttons are on the right controller
    rightHand.addEventListener('abuttondown', () => selectAllOfType());
    rightHand.addEventListener('bbuttondown', () => {
      const hadBuild = !!State.gameSession.buildMode;
      if (hadBuild) {
        State.clearBuildPlacementFlags();
        clearBuildBanner();
      }
      State.deselectAll();
      UI.hideBuildingPanel();
      UI.showStatus(hadBuild ? 'Build cancelled · deselected' : 'Deselected all');
    });
  }

  if (leftHand) {
    leftHand.addEventListener('triggerdown', (e) => {
      vrLeftTriggerHeld = true;
      refreshVrHandAimLineVisibility();
      onVRTriggerLeft(e);
    });
    leftHand.addEventListener('triggerup', () => {
      vrLeftTriggerHeld = false;
      refreshVrHandAimLineVisibility();
    });
    leftHand.addEventListener('gripdown', () => {
      vrLeft.grip = true;
      vrLeft.gripPanInited = false;
    });
    leftHand.addEventListener('gripup', () => {
      vrLeft.grip = false;
      vrLeft.gripPanInited = false;
      vrPinch.active = false;
    });
    /** `tracked-controls` emits squeeze as `buttondown`/`buttonup` (index 1 on Meta Touch), not `gripdown`. */
    function syncLeftGripFromTrackedButton(e, pressed) {
      const d = e && e.detail;
      if (!d || d.id === undefined || d.id === null) return;
      const id = d.id;
      let isSqueeze = false;
      if (typeof id === 'string') {
        const s = String(id).toLowerCase();
        isSqueeze = s.includes('squeeze') || s.includes('grip');
      } else {
        const n = Number(id);
        if (Number.isFinite(n) && n === 1) isSqueeze = true;
      }
      if (!isSqueeze) return;
      vrLeft.grip = pressed;
      if (pressed) vrLeft.gripPanInited = false;
      else vrPinch.active = false;
    }
    leftHand.addEventListener('buttondown', e => syncLeftGripFromTrackedButton(e, true));
    leftHand.addEventListener('buttonup', e => syncLeftGripFromTrackedButton(e, false));
    leftHand.addEventListener('thumbstickmoved', e => {
      const d = e && e.detail;
      if (!d) return;
      if (typeof d.x === 'number' || typeof d.y === 'number') {
        vrLeft.thumbX = d.x || 0;
        vrLeft.thumbY = d.y || 0;
        return;
      }
      const ax = readThumbstickXYFromAxisMoveDetail(d);
      if (ax) {
        vrLeft.thumbX = ax.x;
        vrLeft.thumbY = ax.y;
      }
    });
    leftHand.addEventListener('axismove', e => {
      const ax = readThumbstickXYFromAxisMoveDetail(e.detail);
      if (!ax) return;
      const ch = e.detail && e.detail.changed;
      if (Array.isArray(ch) && ch.length > 3 && !(ch[2] || ch[3])) return;
      vrLeft.thumbX = ax.x;
      vrLeft.thumbY = ax.y;
    });
    const leftVrXButtonAction = () => {
      if (State.gameSession.buildMode) {
        State.clearBuildPlacementFlags();
        clearBuildBanner();
        UI.showStatus('Build cancelled');
        return;
      }
      toggleMenu();
    };
    const leftFaceFromTracked = (e) => {
      const d = e && e.detail;
      if (!d || d.id === undefined || d.id === null) return;
      const id = d.id;
      if (typeof id === 'string') {
        const s = String(id).toLowerCase();
        if (s.includes('primary') || s === 'xbutton' || s === 'x') {
          leftVrXButtonAction();
          return;
        }
        if (s.includes('secondary') || s === 'ybutton' || s === 'y') {
          UI.toggleMinimap();
          return;
        }
        return;
      }
      const n = Number(id);
      if (!Number.isFinite(n)) return;
      if (n <= 2) return;
      const { xIdx, yIdx } = readLeftAuxFaceButtonIndices();
      if (n === xIdx) leftVrXButtonAction();
      else if (n === yIdx) UI.toggleMinimap();
    };
    leftHand.addEventListener('buttondown', leftFaceFromTracked);
    leftHand.addEventListener('xbuttondown', leftVrXButtonAction);
    leftHand.addEventListener('ybuttondown', () => UI.toggleMinimap());
  }

  // --- Keyboard Events ---
  window.addEventListener('keydown', e => {
    keys[e.key.toLowerCase()] = true;

    if (e.key === 'Escape') toggleMenu();
    if (e.key === 'Tab') { e.preventDefault(); UI.toggleMinimap(); }

    // X key: cancel build mode
    if (e.key === 'x' || e.key === 'X') {
      if (State.gameSession.buildMode) {
        State.clearBuildPlacementFlags();
        clearBuildBanner();
        UI.showStatus('Build cancelled');
      }
    }

    // Deselect
    if (e.key === 'Delete' || e.key === 'Backspace' || e.key === ' ') {
      State.deselectAll();
      UI.hideBuildingPanel();
    }

    // K key: toggle debug fog (Spy Mode)
    if (e.key.toLowerCase() === 'k' && State.gameSession.gameStarted) {
      State.gameSession.debugFog = !State.gameSession.debugFog;
      UI.showStatus(State.gameSession.debugFog ? 'Spy Mode: FOG DISABLED' : 'Spy Mode: FOG ENABLED');
    }

    // G key: terrain grid (not used elsewhere)
    if ((e.key === 'g' || e.key === 'G') && State.gameSession.gameStarted && !State.gameSession.menuOpen) {
      e.preventDefault();
      const on = toggleTerrainGrid();
      UI.showStatus(on ? 'Terrain grid on' : 'Terrain grid off');
    }

    // Squad Control Groups (Number keys)
    if (e.code && (e.code.startsWith('Digit') || e.code.startsWith('Numpad'))) {
      const squadNum = e.code.replace('Digit', '').replace('Numpad', '');
      
      // Ensure we only process actual 0-9 digits and not secondary keys
      if (['0','1','2','3','4','5','6','7','8','9'].includes(squadNum)) {
        e.preventDefault(); // Strongly prevent browser tab switching natively

      if (e.ctrlKey || e.altKey) {
        // Save current selection to squad
        const activeUnits = Array.from(State.selectedUnits).filter(id => {
          const u = State.units.get(id);
          return u && u.hp > 0;
        });
        controlGroups[squadNum] = new Set(activeUnits);
        UI.showStatus(`Squad ${squadNum} Assigned (${activeUnits.length} units)`);
      } else {
        // Load squad selection
        if (!e.shiftKey) {
          State.deselectAll();
          UI.hideBuildingPanel();
        }
        
        let loadedCount = 0;
        let isToggleOff = false;

        // Toggling Logic
        if (e.shiftKey && controlGroups[squadNum] && controlGroups[squadNum].size > 0) {
          isToggleOff = true;
          // Verify if EVERY valid unit in the squad is already selected
          controlGroups[squadNum].forEach(id => {
            const u = State.units.get(id);
            if (u && u.hp > 0 && !State.selectedUnits.has(id)) {
              isToggleOff = false; // At least one isn't selected, so Add mode
            }
          });
        }

        if (controlGroups[squadNum]) {
          // Purge dead units from the group (Set doesn't have .filter, so convert to Array)
          const purgedList = Array.from(controlGroups[squadNum]).filter(id => {
            const u = State.units.get(id);
            return u && u.hp > 0;
          });
          controlGroups[squadNum] = new Set(purgedList);

          let count = 0;
          let sumX = 0;
          let sumZ = 0;

          controlGroups[squadNum].forEach(id => {
            const u = State.units.get(id);
            if (isToggleOff) {
              State.deselectUnit(id);
            } else {
              State.selectUnit(id);
              loadedCount++;
              sumX += u.x;
              sumZ += u.z;
              count++;
            }
          });

          // Centering logic (Double-tap)
          const now = Date.now();
          if (now - lastSquadPressTime < 400 && lastSquadNum === squadNum && count > 0) {
            jumpCameraTo(sumX / count, sumZ / count);
          }
          lastSquadPressTime = now;
          lastSquadNum = squadNum;
        }
        
        let msg = `Squad ${squadNum} Selected`;
        if (loadedCount === 0 && (!controlGroups[squadNum] || controlGroups[squadNum].size === 0)) {
          msg = `Squad ${squadNum} Empty`;
        } else if (e.shiftKey) {
          msg = isToggleOff ? `Squad ${squadNum} Subtracted` : `Squad ${squadNum} Added`;
        }
        UI.showStatus(msg);
        }
      }
    }

    // S key: stop selected units
    if (e.key === 's' && e.ctrlKey) {
      e.preventDefault();
      Network.sendCommand({ action: 'stop', unitIds: Array.from(State.selectedUnits) });
    }
  });

  window.addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
  });

  // --- Mouse Events ---
  window.addEventListener('mousemove', e => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  window.addEventListener('mousedown', e => {
    if (e.button === 0) mouse.down = true;
    if (e.button === 2) mouse.rightDown = true;
  });

  window.addEventListener('mouseup', e => {
    if (e.button === 0) {
      mouse.down = false;
      onMouseClick(e);
    }
    if (e.button === 2) {
      mouse.rightDown = false;
      onRightClick(e);
    }
  });

  window.addEventListener('contextmenu', e => e.preventDefault());

  window.addEventListener('wheel', e => {
    if (lobbyIntroOrbit) return;
    cameraRig.y += e.deltaY * 0.05;
    cameraRig.y = Math.max(CAMERA_Y_MIN, Math.min(CAMERA_Y_MAX, cameraRig.y));
  });

  window.__rtsIsVrGripHeld = function () {
    return !!(vrLeft.grip || vrRight.grip);
  };

  const touchOpts = { passive: false };
  window.addEventListener('touchstart', onTouchStart, touchOpts);
  window.addEventListener('touchmove', onTouchMove, touchOpts);
  window.addEventListener('touchend', onTouchEnd, touchOpts);
  window.addEventListener('touchcancel', onTouchEnd, touchOpts);

  const applyCanvasTouchAction = () => {
    try {
      if (scene.canvas) scene.canvas.style.touchAction = 'none';
    } catch (_) { /* ignore */ }
  };
  if (scene.hasLoaded) applyCanvasTouchAction();
  else scene.addEventListener('loaded', applyCanvasTouchAction);

  recomputeIsVR();
  syncFlatScreenCameraPitch();

  applyImmersiveVrEntryToScene(scene);
  installImmersiveVrEntryResizeHandling(scene);
}

// --- Immersive VR entry: hide A-Frame goggles on phones/tablets used as flat RTS;
// keep on desktop + standalone VR browsers (Quest, Pico, …). ---
let handheldFlatCache;
const VR_BROWSER_UA_RE =
  /oculusbrowser|meta quest|quest([\s_]|browser|pro|3|2)|pico|wolvic|htc vive|openxr|vision ?os/i;

function computeHandheldFlatTouchDevice() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  if (VR_BROWSER_UA_RE.test(ua)) return false;

  try {
    const ud = navigator.userAgentData;
    if (ud && typeof ud.mobile === 'boolean' && ud.mobile) return true;
  } catch (_) { /* ignore */ }

  const coarse =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const noHover =
    typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
  const shortSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
  if (coarse && noHover && shortSide <= 1200) return true;

  return false;
}

/** True for typical phone/tablet 2D play (not Quest / Pico browser, etc.). */
export function isHandheldFlatTouchDevice() {
  if (handheldFlatCache === undefined) {
    handheldFlatCache = computeHandheldFlatTouchDevice();
  }
  return handheldFlatCache;
}

export function invalidateHandheldFlatDeviceCache() {
  handheldFlatCache = undefined;
}

export function shouldShowImmersiveVrEntry() {
  return !isHandheldFlatTouchDevice();
}

function decorateEnterVrButton() {
  const btn = document.querySelector('.a-enter-vr-button');
  if (!btn) return;
  btn.setAttribute('title', 'Enter immersive VR (headset or desktop)');
  btn.setAttribute('aria-label', 'Enter immersive VR');
  if (btn.querySelector('.rts-enter-vr-label')) return;
  const lab = document.createElement('span');
  lab.className = 'rts-enter-vr-label';
  lab.textContent = 'VR';
  lab.style.cssText =
    'margin-left:6px;font-size:11px;font-weight:600;letter-spacing:0.06em;vertical-align:middle;opacity:0.95;';
  btn.appendChild(lab);
}

let vrEntryResizeTimer;
let vrEntryResizeInstalled = false;

export function applyImmersiveVrEntryToScene(sceneEl) {
  if (!sceneEl || typeof sceneEl.setAttribute !== 'function') return;
  /** Flat phones/tablets hide goggles; desktop + VR browsers show from boot (lobby + match). */
  const show = shouldShowImmersiveVrEntry();
  try {
    sceneEl.setAttribute('vr-mode-ui', show ? 'enabled: true' : 'enabled: false');
  } catch (_) { /* ignore */ }
  document.body.classList.toggle('rts-hide-immersive-vr', !show);
  if (show) {
    requestAnimationFrame(() => {
      decorateEnterVrButton();
      setTimeout(decorateEnterVrButton, 500);
      setTimeout(decorateEnterVrButton, 2500);
    });
  }
}

export function installImmersiveVrEntryResizeHandling(sceneEl) {
  if (vrEntryResizeInstalled) return;
  vrEntryResizeInstalled = true;
  const refresh = () => {
    invalidateHandheldFlatDeviceCache();
    applyImmersiveVrEntryToScene(sceneEl);
  };
  window.addEventListener('orientationchange', refresh);
  window.addEventListener('resize', () => {
    clearTimeout(vrEntryResizeTimer);
    vrEntryResizeTimer = setTimeout(refresh, 200);
  });
}

export function jumpCameraTo(x, z) {
  const camClamp = clampWorldToPlayableDisk(x, z, 0);
  cameraRig.x = camClamp.x;
  cameraRig.z = camClamp.z;
}

/** RTS camera above a player's base corner, yaw toward map center (matches W forward = −sin(rotY), −cos(rotY)). */
export function positionCameraForPlayer(playerId) {
  const p = State.players[playerId];
  const spawn = (p && p.spawn) || SPAWN_POSITIONS[playerId];
  if (!spawn) return;
  const bx = spawn.x * 0.8;
  const bz = spawn.z * 0.8;
  cameraRig.y = 36;
  if (Math.hypot(bx, bz) > 0.01) {
    cameraRig.rotY = Math.atan2(bx, bz);
  } else {
    cameraRig.rotY = 0;
  }
  // ~50 m “back” along view (opposite flat forward (−sin, −cos)) for a wider opening frame at match start.
  const startCamBackM = 50;
  cameraRig.x = bx + Math.sin(cameraRig.rotY) * startCamBackM;
  cameraRig.z = bz + Math.cos(cameraRig.rotY) * startCamBackM;
  const c = clampWorldToPlayableDisk(cameraRig.x, cameraRig.z, 0);
  cameraRig.x = c.x;
  cameraRig.z = c.z;
  if (Math.hypot(cameraRig.x, cameraRig.z) > 0.01) {
    cameraRig.rotY = Math.atan2(cameraRig.x, cameraRig.z);
  }
  const rig = document.getElementById('cameraRig');
  if (rig) {
    rig.object3D.position.set(cameraRig.x, cameraRig.y, cameraRig.z);
    rig.object3D.rotation.y = cameraRig.rotY;
  }
  syncFlatScreenCameraPitch();
}

// --- Per-frame input processing ---
export function updateInput(dt) {
  syncIsVRFromScene();

  if (lobbyIntroOrbit) {
    const s = lobbyIntroOrbit;
    const elapsed = performance.now() - s.startMs;
    let u = s.durationMs > 0 ? elapsed / s.durationMs : 1;
    const done = u >= 1;
    if (done) u = 1;
    const ease = smoothstepEase01(u);
    const theta = s.deltaYaw * ease;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const rx = s.ox * cos + s.oz * sin;
    const rz = -s.ox * sin + s.oz * cos;
    cameraRig.x = s.pivotX + rx;
    cameraRig.z = s.pivotZ + rz;
    cameraRig.rotY = s.rotY0 + theta;
    cameraRig.y = s.yStart + (s.y0 - s.yStart) * ease;
    if (done) lobbyIntroOrbit = null;
  } else {
  // Always process camera, even when game hasn't started
  const camSpeed = 40 * dt * (cameraRig.y / 30);

  if (State.gameSession.gameStarted && !State.gameSession.menuOpen) {
    // Keyboard camera movement
    if (keys['w']) {
      cameraRig.x -= Math.sin(cameraRig.rotY) * camSpeed;
      cameraRig.z -= Math.cos(cameraRig.rotY) * camSpeed;
    }
    if (keys['s'] && !keys['control']) {
      cameraRig.x += Math.sin(cameraRig.rotY) * camSpeed;
      cameraRig.z += Math.cos(cameraRig.rotY) * camSpeed;
    }
    if (keys['a']) {
      cameraRig.x -= Math.cos(cameraRig.rotY) * camSpeed;
      cameraRig.z += Math.sin(cameraRig.rotY) * camSpeed;
    }
    if (keys['d']) {
      cameraRig.x += Math.cos(cameraRig.rotY) * camSpeed;
      cameraRig.z -= Math.sin(cameraRig.rotY) * camSpeed;
    }
    if (keys['q']) cameraRig.rotY += 1.5 * dt;
    if (keys['e']) cameraRig.rotY -= 1.5 * dt;
  }

  // VR camera controls (RTSVR rts-controller semantics: local hand motion under #cameraRig)
  if (isVR && State.gameSession.gameStarted) {
    const rigEl = document.getElementById('cameraRig');
    const lh = document.getElementById('leftHand');
    const rh = document.getElementById('rightHand');

    if (rigEl && lh && rh) {
      const leftControllerPan = vrLeft.grip && !vrRight.grip;
      const rightControllerPan = vrRight.grip && !vrLeft.grip;
      const bothGrips = vrLeft.grip && vrRight.grip;

      if (bothGrips) {
        vrLeft.gripPanInited = false;
        vrRight.gripPanInited = false;
        lh.object3D.getWorldPosition(_pinchL);
        rh.object3D.getWorldPosition(_pinchR);
        const dist = _pinchL.distanceTo(_pinchR);
        if (!vrPinch.active) {
          vrPinch.active = true;
          vrPinch.lastDist = dist;
        } else {
          const deltaDistance = dist - vrPinch.lastDist;
          cameraRig.y = Math.max(CAMERA_Y_MIN, Math.min(CAMERA_Y_MAX, cameraRig.y - deltaDistance * 30));
          vrPinch.lastDist = dist;
        }
      } else {
        vrPinch.active = false;

        const applyGripPan = (handEl, state) => {
          if (!handEl) return;
          _handLocal.copy(handEl.object3D.position);
          if (!state._gripRef) state._gripRef = new THREE.Vector3();
          if (!state.gripPanInited) {
            state._gripRef.copy(_handLocal);
            state.gripPanInited = true;
            return;
          }
          _localDelta.subVectors(state._gripRef, _handLocal);
          const rigRot = cameraRig.rotY;
          _worldDelta.set(
            _localDelta.x * Math.cos(rigRot) + _localDelta.z * Math.sin(rigRot),
            0,
            -_localDelta.x * Math.sin(rigRot) + _localDelta.z * Math.cos(rigRot)
          );
          const heightMul = cameraRig.y / CAMERA_RIG_DEFAULT_Y;
          _worldDelta.multiplyScalar(100 * heightMul);
          const cg = clampWorldToPlayableDisk(cameraRig.x + _worldDelta.x, cameraRig.z + _worldDelta.z, 0);
          cameraRig.x = cg.x;
          cameraRig.z = cg.z;
          state._gripRef.copy(_handLocal);
        };

        if (leftControllerPan) applyGripPan(lh, vrLeft);
        else vrLeft.gripPanInited = false;

        if (rightControllerPan) applyGripPan(rh, vrRight);
        else vrRight.gripPanInited = false;
      }
    }

    // Left thumbstick: ground pan — same pattern as BuildVR/index6.html (forward + strafe from rig yaw).
    // Raw stick axes are negated to match Quest/SteamVR conventions; then apply dir * moveY - strafe * moveX.
    const stickDead = 0.15;
    const moveX =
      Math.abs(vrLeft.thumbX) > stickDead ? -vrLeft.thumbX : 0;
    const moveY =
      Math.abs(vrLeft.thumbY) > stickDead ? -vrLeft.thumbY : 0;
    if (moveX !== 0 || moveY !== 0) {
      const θ = cameraRig.rotY;
      const dirX = -Math.sin(θ);
      const dirZ = -Math.cos(θ);
      const strafeX = -dirZ;
      const strafeZ = dirX;
      const scale = camSpeed * 0.5;
      cameraRig.x += (dirX * moveY - strafeX * moveX) * scale;
      cameraRig.z += (dirZ * moveY - strafeZ * moveX) * scale;
    }
    // Right thumbstick X: yaw (matches BuildVR: rotY -= thumbX * speed)
    if (Math.abs(vrRight.thumbX) > 0.15) {
      cameraRig.rotY -= vrRight.thumbX * 2 * dt;
    }
    if (Math.abs(vrRight.thumbY) > 0.15) {
      cameraRig.y -= vrRight.thumbY * 20 * dt;
      cameraRig.y = Math.max(CAMERA_Y_MIN, Math.min(CAMERA_Y_MAX, cameraRig.y));
    }

    if (!State.gameSession.menuOpen) {
      vrBfHoverAccum += dt;
      if (vrBfHoverAccum >= 0.1) {
        vrBfHoverAccum = 0;
        tickVrBattlefieldHoverPulse();
      }
    } else {
      vrBfHoverKey = null;
      vrBfHoverAccum = 0;
    }
  }

  } // end !lobbyIntroOrbit

  const camEnd = clampWorldToPlayableDisk(cameraRig.x, cameraRig.z, 0);
  cameraRig.x = camEnd.x;
  cameraRig.z = camEnd.z;

  // Apply camera position
  const rig = document.getElementById('cameraRig');
  if (rig) {
    rig.object3D.position.set(cameraRig.x, cameraRig.y, cameraRig.z);
    rig.object3D.rotation.y = cameraRig.rotY;
  }
  if (!isVR) syncFlatScreenCameraPitch();
}

let lastClickTime = 0;
let lastClickTargetId = null;

/** Extra sphere radius for unit/building picks when the camera is high (small on-screen silhouettes). */
function getScreenPickRadiusBoost() {
  return Math.max(0, Math.min(5.5, (cameraRig.y - 22) * 0.11));
}

/** NDC pick point — must match `Raycaster.setFromCamera` (see onMouseClick). */
function clientToPickNdc(clientX, clientY) {
  return {
    x: (clientX / window.innerWidth) * 2 - 1,
    y: -(clientY / window.innerHeight) * 2 + 1,
  };
}

/**
 * Right-click "follow" uses inflated unit spheres; if the player aimed at open ground,
 * prefer move. Also never follow a unit that is part of the current command selection.
 */
function commandRayPrefersGroundOverFriendlyFollow(origin, direction, hitUnit, pickNdc, commanderUnitIds) {
  if (!hitUnit) return true;
  if (commanderUnitIds.includes(hitUnit.id)) return true;
  const groundHit = raycastGround(origin, direction);
  if (!groundHit) return false;
  if (pickNdc) {
    const gPen = Renderer.pickScreenNdcErrorForGroundPoint(groundHit.x, groundHit.z, pickNdc);
    const uPen = Renderer.pickScreenNdcErrorForUnit(hitUnit, pickNdc);
    return gPen < uPen - 0.012;
  }
  const dx = hitUnit.x - groundHit.x;
  const dz = hitUnit.z - groundHit.z;
  return dx * dx + dz * dz > 36;
}

function resourceFieldStatusMessage(field) {
  if (!field) return '';
  if (field.depleted) {
    return `Resource crystal — depleted (0 / ${Math.floor(field.maxCapacity || 0)})`;
  }
  return `Resource crystal — Remaining: ${Math.floor(field.remaining)} / ${Math.floor(field.maxCapacity || 0)}`;
}

function resolveOverlapPicks(hitUnit, hitBuilding, hitResource, pickNdc, origin, direction, radiusBoost) {
  if (!pickNdc) {
    const nHits = (hitUnit ? 1 : 0) + (hitBuilding ? 1 : 0) + (hitResource ? 1 : 0);
    if (nHits <= 1 || !origin || !direction) {
      return { u: hitUnit, b: hitBuilding, r: hitResource };
    }
    const cands = [];
    if (hitUnit) {
      const t = Renderer.battlefieldPickEntryT(origin, direction, 'unit', hitUnit, 200, radiusBoost);
      if (t != null) cands.push({ t, k: 'u', u: hitUnit });
    }
    if (hitBuilding) {
      const t = Renderer.battlefieldPickEntryT(origin, direction, 'building', hitBuilding, 200, radiusBoost);
      if (t != null) cands.push({ t, k: 'b', b: hitBuilding });
    }
    if (hitResource) {
      const t = Renderer.battlefieldPickEntryT(origin, direction, 'resource', hitResource, 200, radiusBoost);
      if (t != null) cands.push({ t, k: 'r', r: hitResource });
    }
    if (cands.length === 0) {
      return { u: hitUnit, b: hitBuilding, r: hitResource };
    }
    cands.sort((a, b) => a.t - b.t);
    const w = cands[0];
    return {
      u: w.k === 'u' ? w.u : null,
      b: w.k === 'b' ? w.b : null,
      r: w.k === 'r' ? w.r : null,
    };
  }
  const cands = [];
  if (hitUnit) {
    cands.push({
      k: 'u',
      pen: Renderer.pickScreenNdcErrorForUnit(hitUnit, pickNdc),
      u: hitUnit,
    });
  }
  if (hitBuilding) {
    cands.push({
      k: 'b',
      pen: Renderer.pickScreenNdcErrorForBuilding(hitBuilding, pickNdc),
      b: hitBuilding,
    });
  }
  if (hitResource) {
    cands.push({
      k: 'r',
      pen: Renderer.pickScreenNdcErrorForResourceField(hitResource, pickNdc),
      r: hitResource,
    });
  }
  if (cands.length <= 1) {
    return { u: hitUnit, b: hitBuilding, r: hitResource };
  }
  cands.sort((a, b) => a.pen - b.pen);
  const w = cands[0];
  return {
    u: w.k === 'u' ? w.u : null,
    b: w.k === 'b' ? w.b : null,
    r: w.k === 'r' ? w.r : null,
  };
}

/** Same as mouse left-click on the world: select units (any owner), buildings, resources, clear on empty ground. */
function performWorldSelectionRay(origin, direction, shiftHeld, pickNdc) {
  const pickBoost = getScreenPickRadiusBoost();
  let hitUnit = Renderer.raycastUnits(origin, direction, 200, pickBoost, pickNdc);
  let hitBuilding = Renderer.raycastBuildings(origin, direction, 200, pickBoost, pickNdc);
  let hitResource = Renderer.raycastResourceFields(origin, direction, 200, pickNdc);
  ({ u: hitUnit, b: hitBuilding, r: hitResource } = resolveOverlapPicks(
    hitUnit,
    hitBuilding,
    hitResource,
    pickNdc,
    origin,
    direction,
    pickBoost
  ));

  if (hitUnit) {
    const now = Date.now();
    const isDoubleClick = (now - lastClickTime < 400) && (hitUnit.id === lastClickTargetId);
    lastClickTime = now;
    lastClickTargetId = hitUnit.id;

    if (isDoubleClick && hitUnit.ownerId === State.gameSession.myPlayerId) {
      selectNearbyOfType(hitUnit);
    } else {
      const isAlreadySelected = State.selectedUnits.has(hitUnit.id);

      if (shiftHeld) {
        if (isAlreadySelected) {
          State.deselectUnit(hitUnit.id);
          UI.showStatus(`Removed ${UNIT_TYPES[hitUnit.type]?.name || hitUnit.type} from selection`);
        } else {
          State.selectUnit(hitUnit.id);
          UI.showStatus(`Added ${UNIT_TYPES[hitUnit.type]?.name || hitUnit.type} to selection`);
        }
      } else {
        State.deselectAll();
        State.selectUnit(hitUnit.id);
        UI.showStatus(`Selected ${UNIT_TYPES[hitUnit.type]?.name || hitUnit.type}`);
      }

      UI.hideBuildingPanel();
      if (hitUnit.ownerId !== State.gameSession.myPlayerId) {
        UI.showStatus(`Enemy ${UNIT_TYPES[hitUnit.type]?.name || hitUnit.type}`);
      }
    }
    return;
  }

  lastClickTime = Date.now();
  lastClickTargetId = null;

  if (hitBuilding) {
    State.deselectAll();
    UI.showBuildingPanel(hitBuilding);
    if (hitBuilding.ownerId === State.gameSession.myPlayerId) {
      UI.showStatus(`Selected ${BUILDING_TYPES[hitBuilding.type]?.name || hitBuilding.type}`);
    } else {
      UI.showStatus(`Enemy ${BUILDING_TYPES[hitBuilding.type]?.name || hitBuilding.type}`);
    }
    return;
  }

  if (hitResource) {
    State.deselectAll();
    UI.hideBuildingPanel();
    UI.showResourceFieldPanel(hitResource);
    UI.showStatus(resourceFieldStatusMessage(hitResource));
    return;
  }

  // Open ground: do not issue move here (use right-click). Fall through to deselect below.

  if (
    !shiftHeld
    && (State.selectedUnits.size > 0 || UI.activeBuildingPanel || UI.activeResourceField)
  ) {
    State.deselectAll();
    UI.hideBuildingPanel();
    UI.showStatus('');
  }
}

/** Mouse right-click on the world: move / attack / follow (requires controllable units selected). */
function performWorldCommandRay(origin, direction, pickNdc) {
  const myUnits = Array.from(State.selectedUnits).filter(id => {
    const u = State.units.get(id);
    return u && u.ownerId === State.gameSession.myPlayerId;
  });
  if (myUnits.length === 0) return;

  const pickBoost = getScreenPickRadiusBoost();
  let hitUnit = Renderer.raycastUnits(origin, direction, 200, pickBoost, pickNdc);
  let hitBuilding = Renderer.raycastBuildings(origin, direction, 200, pickBoost, pickNdc);
  let hitResource = Renderer.raycastResourceFields(origin, direction, 200, pickNdc);
  ({ u: hitUnit, b: hitBuilding, r: hitResource } = resolveOverlapPicks(
    hitUnit,
    hitBuilding,
    hitResource,
    pickNdc,
    origin,
    direction,
    pickBoost
  ));

  if (hitUnit) {
    const myTeam = State.players[State.gameSession.myPlayerId]?.team;
    if (hitUnit.ownerId === State.gameSession.myPlayerId) {
      if (!commandRayPrefersGroundOverFriendlyFollow(origin, direction, hitUnit, pickNdc, myUnits)) {
        Network.sendCommand({ action: 'follow', unitIds: myUnits, targetId: hitUnit.id });
        UI.showStatus('Following...');
        return;
      }
      hitUnit = null;
    } else if (hitUnit.team !== myTeam) {
      Network.sendCommand({ action: 'attack', unitIds: myUnits, targetId: hitUnit.id });
      UI.showStatus('Attacking!');
      return;
    }
  }

  if (hitBuilding) {
    const myTeam = State.players[State.gameSession.myPlayerId]?.team;
    const bTeam = State.players[hitBuilding.ownerId]?.team;
    if (bTeam !== myTeam) {
      Network.sendCommand({ action: 'attackBuilding', unitIds: myUnits, targetId: hitBuilding.id });
      UI.showStatus('Attacking building!');
      return;
    }
  }

  const harvesterIds = myUnits.filter(id => State.units.get(id)?.type === 'harvester');
  if (hitResource && !hitResource.depleted && harvesterIds.length > 0) {
    Network.sendCommand(
      { action: 'harvestField', unitIds: harvesterIds, fieldId: hitResource.id },
      (ok, code) => {
        if (ok) UI.showStatus('Harvesters assigned to crystal');
        else UI.showStatus(Network.commandFailureMessage(code));
      }
    );
    return;
  }

  const groundHit = raycastGround(origin, direction);
  if (groundHit) {
    Network.sendCommand({ action: 'move', unitIds: myUnits, x: groundHit.x, z: groundHit.z });
    UI.showStatus('Moving...');
  }
}

// --- Mouse click handling ---
function onMouseClick(e) {
  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;
  if (performance.now() < suppressDesktopMouseFromTouchMs) return;

  // Ignore clicks on UI elements
  if (e.target.closest('#minimap') || e.target.tagName === 'BUTTON' || e.target.closest('.hud')) {
    return;
  }
  
  const sceneEl = document.querySelector('a-scene');
  if (!sceneEl || !sceneEl.camera) return;

  _mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  _mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;

  _raycaster.setFromCamera(_mouseNDC, sceneEl.camera);
  const origin = _raycaster.ray.origin;
  const direction = _raycaster.ray.direction;

  // Build mode — place building on ground
  if (State.gameSession.buildMode) {
    const groundHit = raycastGround(origin, direction);
    if (groundHit) {
      const buildingType = State.gameSession.buildMode;
      Network.sendCommand({
        action: 'build',
        buildingType,
        x: groundHit.x,
        z: groundHit.z,
      }, (ok, code) => {
        if (ok) {
          UI.showStatus(`Placed ${BUILDING_TYPES[buildingType]?.name || buildingType}`);
          State.clearBuildPlacementFlags();
          clearBuildBanner();
        } else {
          UI.showStatus(Network.commandFailureMessage(code));
        }
      });
    }
    return;
  }

  const shiftHeld = e.shiftKey || keys['shift'];
  performWorldSelectionRay(origin, direction, shiftHeld, { x: _mouseNDC.x, y: _mouseNDC.y });
}

function onRightClick(e) {
  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;
  if (performance.now() < suppressDesktopMouseFromTouchMs) return;

  // Ignore right-clicks on UI elements
  if (e.target.closest('#minimap')) return;
  
  if (State.gameSession.buildMode) {
    State.clearBuildPlacementFlags();
    clearBuildBanner();
    UI.showStatus('Build cancelled');
    return;
  }
  
  if (State.selectedUnits.size === 0) return;

  const myUnits = Array.from(State.selectedUnits).filter(id => {
    const u = State.units.get(id);
    return u && u.ownerId === State.gameSession.myPlayerId;
  });
  if (myUnits.length === 0) return;

  const sceneEl = document.querySelector('a-scene');
  if (!sceneEl || !sceneEl.camera) return;

  _mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
  _mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;

  _raycaster.setFromCamera(_mouseNDC, sceneEl.camera);
  const origin = _raycaster.ray.origin;
  const direction = _raycaster.ray.direction;

  performWorldCommandRay(origin, direction, { x: _mouseNDC.x, y: _mouseNDC.y });
}

function screenToWorldRay(clientX, clientY) {
  const sceneEl = document.querySelector('a-scene');
  if (!sceneEl || !sceneEl.camera) return null;
  _mouseNDC.x = (clientX / window.innerWidth) * 2 - 1;
  _mouseNDC.y = -(clientY / window.innerHeight) * 2 + 1;
  _raycaster.setFromCamera(_mouseNDC, sceneEl.camera);
  return { origin: _raycaster.ray.origin, direction: _raycaster.ray.direction };
}

/** True when point is over DOM we should not treat as battlefield (menus, minimap, panels). */
function isClientPointBlockedForWorldTouch(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return false;
  if (el.closest('#game-menu')) return true;
  if (el.closest('#build-menu')) return true;
  if (el.closest('#minimap-container')) return true;
  if (el.closest('#hud-build-panel')) return true;
  if (el.closest('#hud-flat-actions')) return true;
  if (el.closest('#hud-help-panel')) return true;
  if (el.closest('#build-placement-banner')) return true;
  if (el.closest('#loading-screen')) return true;
  if (el.closest('#app-start-overlay')) return true;
  return false;
}

/**
 * VR right trigger and mobile tap: select / inspect, command when units selected,
 * ground move/attack, build placement, resource panel.
 * @param {{ vrFollowChord?: boolean }} [opts] — VR: when true, same-hand grip+trigger issues follow on friendly units.
 */
function performVrStyleBattlefieldRay(origin, direction, pickNdc, opts = {}) {
  const vrFollowChord = !!opts.vrFollowChord;
  if (State.gameSession.buildMode) {
    const groundHit = raycastGround(origin, direction);
    if (groundHit) {
      const buildingType = State.gameSession.buildMode;
      Network.sendCommand(
        {
          action: 'build',
          buildingType,
          x: groundHit.x,
          z: groundHit.z,
        },
        (ok, code) => {
          if (ok) {
            State.clearBuildPlacementFlags();
            clearBuildBanner();
            UI.showStatus(`Placed ${BUILDING_TYPES[buildingType]?.name || buildingType}`);
          } else {
            UI.showStatus(Network.commandFailureMessage(code));
          }
        }
      );
      return true;
    }
    return false;
  }

  const myUnits = Array.from(State.selectedUnits).filter(id => {
    const u = State.units.get(id);
    return u && u.ownerId === State.gameSession.myPlayerId;
  });
  const myTeam = State.players[State.gameSession.myPlayerId]?.team;

  const pickBoost = getScreenPickRadiusBoost();
  let hitUnit = Renderer.raycastUnits(origin, direction, 200, pickBoost, pickNdc);
  let hitBuilding = Renderer.raycastBuildings(origin, direction, 200, pickBoost, pickNdc);
  let hitResource = Renderer.raycastResourceFields(origin, direction, 200, pickNdc);
  ({ u: hitUnit, b: hitBuilding, r: hitResource } = resolveOverlapPicks(
    hitUnit,
    hitBuilding,
    hitResource,
    pickNdc,
    origin,
    direction,
    pickBoost
  ));

  if (hitUnit) {
    if (hitUnit.ownerId === State.gameSession.myPlayerId) {
      if (myUnits.length > 0) {
        if (vrFollowChord) {
          if (!commandRayPrefersGroundOverFriendlyFollow(origin, direction, hitUnit, pickNdc, myUnits)) {
            Network.sendCommand({ action: 'follow', unitIds: myUnits, targetId: hitUnit.id });
            UI.showStatus('Following — engineers repair damaged vehicles when in range');
            return true;
          }
          const groundHitCmd = raycastGround(origin, direction);
          if (groundHitCmd) {
            Network.sendCommand({ action: 'move', unitIds: myUnits, x: groundHitCmd.x, z: groundHitCmd.z });
            UI.showStatus('Moving...');
            return true;
          }
          return true;
        }
        if (State.selectedUnits.has(hitUnit.id)) {
          State.deselectUnit(hitUnit.id);
          UI.hideBuildingPanel();
          UI.showStatus(
            State.selectedUnits.size === 0 ? 'Deselected' : 'Removed from selection'
          );
        } else {
          State.selectUnit(hitUnit.id);
          UI.hideBuildingPanel();
          UI.showStatus(`Added ${UNIT_TYPES[hitUnit.type]?.name || hitUnit.type} to selection`);
        }
        return true;
      }
      if (State.selectedUnits.has(hitUnit.id)) {
        State.deselectUnit(hitUnit.id);
        UI.hideBuildingPanel();
        UI.showStatus(
          State.selectedUnits.size === 0 ? 'Deselected' : 'Removed from selection'
        );
      } else {
        State.selectUnit(hitUnit.id);
        UI.hideBuildingPanel();
        UI.showStatus(`Selected ${UNIT_TYPES[hitUnit.type]?.name || hitUnit.type}`);
      }
    } else if (myUnits.length > 0 && hitUnit.team !== myTeam) {
      Network.sendCommand({ action: 'attack', unitIds: myUnits, targetId: hitUnit.id });
      UI.showStatus('Attacking!');
    } else if (myUnits.length > 0 && hitUnit.team === myTeam) {
      UI.showStatus('Allied unit — cannot attack');
    } else {
      State.deselectAll();
      State.selectUnit(hitUnit.id);
      UI.hideBuildingPanel();
      const label = hitUnit.team === myTeam ? 'Allied' : 'Enemy';
      UI.showStatus(`${label} ${UNIT_TYPES[hitUnit.type]?.name || hitUnit.type}`);
    }
    return true;
  }

  if (hitBuilding) {
    const ownBuilding = hitBuilding.ownerId === State.gameSession.myPlayerId;
    if (ownBuilding && myUnits.length > 0) {
      /* HQ / barracks pick spheres are huge; do not swallow move/attack — fall through to ground / other picks. */
    } else if (ownBuilding) {
      State.deselectAll();
      UI.showBuildingPanel(hitBuilding);
      UI.showStatus(`Selected ${BUILDING_TYPES[hitBuilding.type]?.name || hitBuilding.type}`);
      return true;
    } else if (myUnits.length > 0) {
      const bTeam = State.players[hitBuilding.ownerId]?.team;
      if (bTeam !== myTeam) {
        Network.sendCommand({ action: 'attackBuilding', unitIds: myUnits, targetId: hitBuilding.id });
        UI.showStatus('Attacking building!');
      } else {
        UI.showStatus('Allied building — cannot attack');
      }
      return true;
    } else {
      State.deselectAll();
      UI.showBuildingPanel(hitBuilding);
      const bTeam = State.players[hitBuilding.ownerId]?.team;
      const label = bTeam === myTeam ? 'Allied' : 'Enemy';
      UI.showStatus(`${label} ${BUILDING_TYPES[hitBuilding.type]?.name || hitBuilding.type}`);
      return true;
    }
  }

  if (hitResource) {
    const harvesterIds = myUnits.filter(id => State.units.get(id)?.type === 'harvester');
    if (harvesterIds.length > 0 && !hitResource.depleted) {
      Network.sendCommand(
        { action: 'harvestField', unitIds: harvesterIds, fieldId: hitResource.id },
        (ok, code) => {
          if (ok) UI.showStatus('Harvesters assigned to crystal');
          else UI.showStatus(Network.commandFailureMessage(code));
        }
      );
      return true;
    }
    State.deselectAll();
    UI.hideBuildingPanel();
    UI.showResourceFieldPanel(hitResource);
    UI.showStatus(resourceFieldStatusMessage(hitResource));
    return true;
  }

  const groundHit = raycastGround(origin, direction);
  if (groundHit && myUnits.length > 0) {
    Network.sendCommand({ action: 'move', unitIds: myUnits, x: groundHit.x, z: groundHit.z });
    UI.showStatus('Moving...');
    return true;
  }
  return false;
}

function clearTouchLongPressTimerOnly() {
  if (touchLongPressTimer) {
    clearTimeout(touchLongPressTimer);
    touchLongPressTimer = null;
  }
}

function clearTouchLongPress() {
  clearTouchLongPressTimerOnly();
  touchOneFinger = null;
}

function fireTouchLongPress(clientX, clientY) {
  touchLongPressTimer = null;
  if (getIsVR()) return;
  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;
  if (isClientPointBlockedForWorldTouch(clientX, clientY)) return;

  const r = screenToWorldRay(clientX, clientY);
  if (!r) return;
  const { origin, direction } = r;

  if (State.gameSession.buildMode) {
    return;
  }

  const pickNdc = clientToPickNdc(clientX, clientY);
  const boost = getScreenPickRadiusBoost();
  let hitUnit = Renderer.raycastUnits(origin, direction, 200, boost, pickNdc);
  let hitBuilding = Renderer.raycastBuildings(origin, direction, 200, boost, pickNdc);
  let hitRes = Renderer.raycastResourceFields(origin, direction, 200, pickNdc);
  ({ u: hitUnit, b: hitBuilding, r: hitRes } = resolveOverlapPicks(
    hitUnit,
    hitBuilding,
    hitRes,
    pickNdc,
    origin,
    direction,
    boost
  ));

  if (hitUnit) {
    if (hitUnit.ownerId === State.gameSession.myPlayerId) {
      const myUnits = Array.from(State.selectedUnits).filter(id => {
        const u = State.units.get(id);
        return u && u.ownerId === State.gameSession.myPlayerId;
      });

      if (myUnits.length > 0) {
        if (!commandRayPrefersGroundOverFriendlyFollow(origin, direction, hitUnit, pickNdc, myUnits)) {
          Network.sendCommand({ action: 'follow', unitIds: myUnits, targetId: hitUnit.id });
          UI.showStatus('Following — engineers repair damaged vehicles when in range');
          UI.hideBuildingPanel();
          touchLongPressConsumed = true;
          notifyTouchInteraction('long');
          return;
        }
        const groundHitCmd = raycastGround(origin, direction);
        if (groundHitCmd) {
          Network.sendCommand({ action: 'move', unitIds: myUnits, x: groundHitCmd.x, z: groundHitCmd.z });
          UI.showStatus('Moving...');
          UI.hideBuildingPanel();
          touchLongPressConsumed = true;
          notifyTouchInteraction('long');
          return;
        }
        UI.hideBuildingPanel();
        touchLongPressConsumed = true;
        notifyTouchInteraction('long');
        return;
      }

      State.deselectAll();
      selectNearbyOfType(hitUnit);
      UI.hideBuildingPanel();
      touchLongPressConsumed = true;
      notifyTouchInteraction('long');
    }
    return;
  }
  if (hitBuilding || hitRes) {
    return;
  }
  const groundHit = raycastGround(origin, direction);
  if (groundHit) {
    State.deselectAll();
    UI.hideBuildingPanel();
    UI.showStatus('Deselected');
    touchLongPressConsumed = true;
    notifyTouchInteraction('long');
  }
}

function centroidAndSpan(t0, t1) {
  const cx = (t0.clientX + t1.clientX) * 0.5;
  const cy = (t0.clientY + t1.clientY) * 0.5;
  const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
  const angle = Math.atan2(t1.clientY - t0.clientY, t1.clientX - t0.clientX);
  return { cx, cy, dist, angle };
}

function onTouchStart(e) {
  if (getIsVR()) return;
  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;

  if (e.touches.length >= 2) {
    clearTouchLongPress();
    touchOneFinger = null;
    touchTapSuppressed = true;
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    const { cx, cy, dist, angle } = centroidAndSpan(t0, t1);
    if (isClientPointBlockedForWorldTouch(cx, cy)) return;
    touchTwin = {
      lastDist: dist,
      lastAngle: angle,
      lastCx: cx,
      lastCy: cy,
    };
    e.preventDefault();
    return;
  }

  if (e.touches.length === 1) {
    const t = e.touches[0];
    if (isClientPointBlockedForWorldTouch(t.clientX, t.clientY)) return;

    touchLongPressConsumed = false;
    touchTapSuppressed = false;
    clearTouchLongPressTimerOnly();
    touchOneFinger = {
      x: t.clientX,
      y: t.clientY,
      id: t.identifier,
      t0: performance.now(),
      moved: false,
    };
    touchLongPressTimer = setTimeout(() => {
      if (touchOneFinger && !touchOneFinger.moved) {
        fireTouchLongPress(touchOneFinger.x, touchOneFinger.y);
      }
    }, 520);
  }
}

function onTouchMove(e) {
  if (getIsVR()) return;
  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;

  if (e.touches.length >= 2 && touchTwin) {
    const t0 = e.touches[0];
    const t1 = e.touches[1];
    const { cx, cy, dist, angle } = centroidAndSpan(t0, t1);

    const dDist = dist - touchTwin.lastDist;
    touchTwin.lastDist = dist;
    const zoomSens = 0.085;
    cameraRig.y = Math.max(CAMERA_Y_MIN, Math.min(CAMERA_Y_MAX, cameraRig.y - dDist * zoomSens));

    const dcx = cx - touchTwin.lastCx;
    const dcy = cy - touchTwin.lastCy;
    touchTwin.lastCx = cx;
    touchTwin.lastCy = cy;
    const θ = cameraRig.rotY;
    const panSens = 0.055 * (cameraRig.y / 35);
    cameraRig.x -= (Math.cos(θ) * dcx - Math.sin(θ) * dcy) * panSens;
    cameraRig.z -= (Math.sin(θ) * dcx + Math.cos(θ) * dcy) * panSens;

    let dAng = angle - touchTwin.lastAngle;
    if (dAng > Math.PI) dAng -= Math.PI * 2;
    if (dAng < -Math.PI) dAng += Math.PI * 2;
    touchTwin.lastAngle = angle;
    cameraRig.rotY += dAng * 0.85;

    const c0 = clampWorldToPlayableDisk(cameraRig.x, cameraRig.z, 0);
    cameraRig.x = c0.x;
    cameraRig.z = c0.z;

    e.preventDefault();
    return;
  }

  if (touchOneFinger && e.touches.length === 1) {
    const t = e.touches[0];
    if (t.identifier !== touchOneFinger.id) return;
    const dx = t.clientX - touchOneFinger.x;
    const dy = t.clientY - touchOneFinger.y;
    if (dx * dx + dy * dy > 14 * 14) {
      touchOneFinger.moved = true;
      clearTouchLongPressTimerOnly();
    }
  }
}

function onTouchEnd(e) {
  if (getIsVR()) return;
  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) {
    clearTouchLongPress();
    touchTwin = null;
    return;
  }

  if (e.touches.length < 2) {
    touchTwin = null;
  }

  if (touchLongPressTimer && e.changedTouches.length) {
    const ch = e.changedTouches[0];
    if (touchOneFinger && ch.identifier === touchOneFinger.id && e.touches.length > 0) {
      clearTouchLongPress();
    }
  }

  if (e.touches.length === 0) {
    const ch = e.changedTouches[0];
    if (!ch) {
      clearTouchLongPress();
      return;
    }

    const fingerSnapshot = touchOneFinger;
    const suppressed = touchTapSuppressed;
    const longConsumed = touchLongPressConsumed;

    clearTouchLongPress();

    if (suppressed) {
      touchTapSuppressed = false;
      touchLongPressConsumed = false;
      return;
    }
    if (longConsumed) {
      touchLongPressConsumed = false;
      return;
    }

    if (fingerSnapshot && ch.identifier === fingerSnapshot.id && !fingerSnapshot.moved) {
      const dt = performance.now() - fingerSnapshot.t0;
      if (dt < 600 && isClientPointBlockedForWorldTouch(ch.clientX, ch.clientY)) {
        return;
      }
      if (dt < 600) {
        const r = screenToWorldRay(ch.clientX, ch.clientY);
        if (r) {
          const acted = performVrStyleBattlefieldRay(
            r.origin,
            r.direction,
            clientToPickNdc(ch.clientX, ch.clientY)
          );
          if (acted) notifyTouchInteraction('tap');
        }
        if (e.cancelable) e.preventDefault();
      }
    }
    if (!getIsVR() && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) {
      suppressDesktopMouseFromTouchMs = performance.now() + 700;
    }
  }
}

export function getIsVR() {
  return isVR;
}

function smoothstep01Cam(t) {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

/**
 * Flat / touch: blend `#camera` pitch with scroll–pinch zoom (`cameraRig.y`). Fully zoomed in →
 * Blends toward horizon when zoomed in. VR skips (headset owns the view).
 */
function syncFlatScreenCameraPitch() {
  if (isVR) return;
  const camEl = document.getElementById('camera');
  if (!camEl || typeof camEl.setAttribute !== 'function') return;
  const span = CAMERA_Y_MAX - CAMERA_Y_MIN;
  const tLin = span > 1e-6 ? (CAMERA_Y_MAX - cameraRig.y) / span : 0;
  const t = smoothstep01Cam(tLin);
  const pitchDeg = FLAT_CAM_PITCH_ZOOMED_OUT + FLAT_CAM_PITCH_ZOOM_IN_EXTRA * t;
  camEl.setAttribute('rotation', { x: pitchDeg, y: 0, z: 0 });
}

/** `'vr'` | `'touch'` | `'desktop'` — for HUD hints (not authoritative for XR). */
export function getInputPlatform() {
  if (isVR) return 'vr';
  const coarse =
    (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  return coarse ? 'touch' : 'desktop';
}

/**
 * Tactile + soft audio when a touch interaction did something (mirrors BattleVR-style immediate feedback).
 * No-op on desktop; respects browser/OS vibrate settings.
 */
export function notifyTouchInteraction(kind = 'tap') {
  if (getInputPlatform() !== 'touch') return;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate(kind === 'long' ? 40 : 18);
    } catch (_) { /* ignored */ }
  }
  Audio.playTouchUiSound();
}

// --- VR Trigger: RIGHT hand (select / command) ---
function onVRTriggerRight(e) {
  const controller = vrHandElForUiPick(e.target) || e.target;
  if (!controller) return;

  const now = Date.now();
  if (tryVrUiClickFromChildRay(controller)) {
    lastTriggerTime = now;
    return;
  }

  if (now - lastTriggerTime < 200) return;

  copyWorldRayFromHandAimRaycaster(controller, _origin, _direction);

  // VR main menu: clicks handled via child ray above; no battlefield input while menu / lobby
  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) {
    lastTriggerTime = now;
    return;
  }

  lastTriggerTime = now;

  const sceneEl = sceneElForVrSync || document.querySelector('a-scene');
  const vrPickNdc = computeVrLaserPickNdc(sceneEl, _origin, _direction);
  const acted = performVrStyleBattlefieldRay(_origin, _direction, vrPickNdc, { vrFollowChord: vrRight.grip });
  if (acted) tryVrControllerPulse('right', 0.52, 40);
}

// --- VR Trigger: LEFT hand (build / secondary) ---
function onVRTriggerLeft(e) {
  const controller = vrHandElForUiPick(e.target) || e.target;
  if (!controller) return;
  /** UI / Start use the right hand only; left aim is for build / world ray. */

  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;

  // Left trigger places building in build mode
  if (State.gameSession.buildMode) {
    copyWorldRayFromHandAimRaycaster(controller, _origin, _direction);

    const groundHit = raycastGround(_origin, _direction);
    if (groundHit) {
      tryVrControllerPulse('left', 0.48, 38);
      const buildingType = State.gameSession.buildMode;
      Network.sendCommand({
        action: 'build',
        buildingType,
        x: groundHit.x,
        z: groundHit.z,
      }, (ok, code) => {
        if (ok) {
          State.clearBuildPlacementFlags();
          clearBuildBanner();
          UI.showStatus(`Placed ${BUILDING_TYPES[buildingType]?.name || buildingType}`);
        } else {
          UI.showStatus(Network.commandFailureMessage(code));
        }
      });
    }
  } else {
    UI.showStatus('Select your HQ to choose buildings to place');
  }
}

/**
 * First hit where the ray crosses **downward** through the analytic moon surface
 * (`sampleMoonTerrainWorldY`). Matches visible hills; controller lasers no longer land on the
 * wrong XZ from intersecting only the y=0 plane.
 */
function raycastTerrainSurface(origin, direction, maxDist = 220) {
  const dx = direction.x;
  const dy = direction.y;
  const dz = direction.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return null;
  const rdx = dx / len;
  const rdy = dy / len;
  const rdz = dz / len;
  const ox = origin.x;
  const oy = origin.y;
  const oz = origin.z;

  const step = 1.25;
  let tPrev = 0;
  let fPrev = oy - sampleMoonTerrainWorldY(ox, oz);

  for (let t = step; t <= maxDist; t += step) {
    const px = ox + rdx * t;
    const pz = oz + rdz * t;
    const py = oy + rdy * t;
    const f = py - sampleMoonTerrainWorldY(px, pz);
    if (f <= 0 && fPrev > 0) {
      let lo = tPrev;
      let hi = t;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) * 0.5;
        const mx = ox + rdx * mid;
        const mz = oz + rdz * mid;
        const my = oy + rdy * mid;
        const fm = my - sampleMoonTerrainWorldY(mx, mz);
        if (fm > 0) lo = mid;
        else hi = mid;
      }
      const tt = hi;
      const hx = ox + rdx * tt;
      const hz = oz + rdz * tt;
      if (!isWorldInsidePlayableDisk(hx, hz, 0)) return null;
      return { x: hx, z: hz };
    }
    tPrev = t;
    fPrev = f;
  }
  return null;
}

/** Fallback: infinite y=0 plane (skimming / parallel-to-terrain misses). */
function raycastGroundPlaneY0(origin, direction) {
  if (Math.abs(direction.y) < 0.001) return null;
  const t = -origin.y / direction.y;
  if (t < 0) return null;
  const x = origin.x + direction.x * t;
  const z = origin.z + direction.z * t;
  if (!isWorldInsidePlayableDisk(x, z, 0)) return null;
  return { x, z };
}

function raycastGround(origin, direction) {
  const surf = raycastTerrainSurface(origin, direction);
  if (surf) return surf;
  return raycastGroundPlaneY0(origin, direction);
}

/**
 * Mouse / touch pass cursor NDC so picks prefer what you see on screen. VR was passing `null`,
 * so overlap used **only** along-ray sphere entry — the HQ's huge proxy sphere always won over
 * infantry beside it. Project the laser's ground aim through the XR camera so picks match intent.
 */
function computeVrLaserPickNdc(sceneEl, origin, direction) {
  if (!sceneEl || !sceneEl.camera) return null;
  const gh = raycastGround(origin, direction);
  if (!gh) return null;
  const gy = sampleMoonTerrainWorldY(gh.x, gh.z) + 0.5;
  _tempVec.set(gh.x, gy, gh.z);
  _tempVec.project(sceneEl.camera);
  return { x: _tempVec.x, y: _tempVec.y };
}

// --- Menu ---
function toggleMenu() {
  if (State.gameSession.awaitingAppStart) return;
  State.gameSession.menuOpen = !State.gameSession.menuOpen;
  UI.updateMenuVisibility();
}

export function toggleBuildMode(buildingType) {
  if (!buildingType) {
    State.clearBuildPlacementFlags();
    clearBuildBanner();
    return;
  }
  if (State.gameSession.buildMode === buildingType) {
    State.clearBuildPlacementFlags();
    clearBuildBanner();
  } else {
    State.gameSession.buildMode = buildingType;
    showBuildBanner(BUILDING_TYPES[buildingType]?.name || buildingType, BUILDING_TYPES[buildingType]?.cost || 0);
  }
}

function showBuildBanner(name, cost) {
  let banner = document.getElementById('build-placement-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'build-placement-banner';
    banner.style.cssText = `
      position: fixed; bottom: 70px; left: 50%; transform: translateX(-50%);
      background: rgba(0, 30, 0, 0.92); padding: 12px 28px;
      border: 2px solid #0f0; border-radius: 8px;
      z-index: 160; text-align: center;
      font-family: 'Consolas', monospace;
      animation: buildBlink 1s ease-in-out infinite;
      pointer-events: none;
    `;
    (document.getElementById('xr-dom-overlay') || document.body).appendChild(banner);

    // Add blink animation if not present
    if (!document.getElementById('build-banner-style')) {
      const style = document.createElement('style');
      style.id = 'build-banner-style';
      style.textContent = `
        @keyframes buildBlink {
          0%, 100% { border-color: #0f0; box-shadow: 0 0 8px rgba(0,255,0,0.3); }
          50% { border-color: #0a0; box-shadow: 0 0 20px rgba(0,255,0,0.6); }
        }
      `;
      document.head.appendChild(style);
    }
  }
  const placeHint =
    getInputPlatform() === 'touch'
      ? 'Tap ground within HQ radius to place · tap HQ again to cancel'
      : getInputPlatform() === 'vr'
        ? 'Right or left trigger on ground to place · <b>Left X</b> to cancel · <b>B</b> also cancels · left trigger (no build): HQ tip'
        : 'Click ground within HQ build radius · <b>X</b> or right-click to cancel · VR: left X cancels build';
  banner.innerHTML = `
    <div style="color: #0f0; font-size: 16px; font-weight: bold;">🏗️ PLACING: ${name} ($${cost})</div>
    <div style="color: #aaa; font-size: 12px; margin-top: 4px;">${placeHint}</div>
  `;
  banner.style.display = 'block';

  // Crosshair cursor
  document.body.style.cursor = 'crosshair';
}

function clearBuildBanner() {
  const banner = document.getElementById('build-placement-banner');
  if (banner) banner.style.display = 'none';
  document.body.style.cursor = '';
}

let selectedBuildingId = null;

function selectAllOfType() {
  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;
  const ids = Array.from(State.selectedUnits);
  if (ids.length === 0) {
    UI.showStatus('Select a unit first (A: all of that type)');
    return;
  }
  const first = State.units.get(ids[0]);
  if (!first || first.hp <= 0) return;
  const type = first.type;
  const pid = State.gameSession.myPlayerId;
  State.deselectAll();
  let count = 0;
  State.getPlayerUnits(pid).forEach(unit => {
    if (unit.type === type && unit.hp > 0) {
      State.selectUnit(unit.id);
      count++;
    }
  });
  UI.showStatus(`Selected all ${count} ${UNIT_TYPES[type]?.name || type}(s)`);
}

function selectNearbyOfType(sourceUnit) {
  const type = sourceUnit.type;
  const pid = State.gameSession.myPlayerId;
  const radius = 40;
  
  let count = 0;
  State.getPlayerUnits(pid).forEach(unit => {
    if (unit.type === type && unit.hp > 0) {
      const dist = Math.sqrt(Math.pow(unit.x - sourceUnit.x, 2) + Math.pow(unit.z - sourceUnit.z, 2));
      if (dist <= radius) {
        State.selectUnit(unit.id);
        count++;
      }
    }
  });

  UI.showStatus(`Selected ${count} ${UNIT_TYPES[type]?.name || type}s`);
}


export function getCameraState() {
  return cameraRig;
}
