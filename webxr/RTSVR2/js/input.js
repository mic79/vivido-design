// ========================================
// RTSVR2 — Input System
// VR controllers + keyboard/mouse fallback
// ========================================

import {
  UNIT_TYPES, BUILDING_TYPES, MAP_HALF, SPAWN_POSITIONS,
} from './config.js';
import * as State from './state.js';
import * as Buildings from './buildings.js';
import * as Renderer from './renderer.js';
import * as UI from './ui.js';
import * as Network from './network.js';

// --- State ---
let isVR = false;
/** Set in initInput; used to sync isVR from WebXR session + A-Frame VR mode. */
let sceneElForVrSync = null;
/** A-Frame enter-vr / exit-vr (reliable on Quest); combined per-frame with isPresentingWebXR for desktop. */
let aframeVrHint = false;
let webxrSessionListenersBound = false;
const mouse = { x: 0, y: 0, down: false, rightDown: false };
const keys = {};
const cameraRig = { x: 0, y: 30, z: 0, rotY: 0 };

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

function tryVrUiClickFromChildRay(controllerEl) {
  const child = controllerEl.querySelector('[data-vr-aim-ray]');
  const rc = child && child.components && child.components.raycaster;
  if (!rc || !rc.intersections || rc.intersections.length === 0) return false;
  const inter = rc.intersections[0];
  let o = inter.object;
  while (o && !o.el) o = o.parent;
  const ael = o && o.el;
  if (!ael || ael.id === 'ground') return false;
  if (ael.classList && ael.classList.contains('clickable')) {
    ael.emit('click', { intersection: inter });
    return true;
  }
  return false;
}

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
    rightHand.addEventListener('triggerdown', onVRTriggerRight);
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
      vrRight.thumbX = e.detail.x || 0;
      vrRight.thumbY = e.detail.y || 0;
    });
    // A and B buttons are on the right controller
    rightHand.addEventListener('abuttondown', () => selectAllOfType());
    rightHand.addEventListener('bbuttondown', () => {
      State.deselectAll();
      UI.hideBuildingPanel();
      UI.showStatus('Deselected all');
    });
  }

  if (leftHand) {
    leftHand.addEventListener('triggerdown', onVRTriggerLeft);
    leftHand.addEventListener('gripdown', () => {
      vrLeft.grip = true;
      vrLeft.gripPanInited = false;
    });
    leftHand.addEventListener('gripup', () => {
      vrLeft.grip = false;
      vrLeft.gripPanInited = false;
      vrPinch.active = false;
    });
    leftHand.addEventListener('thumbstickmoved', e => {
      vrLeft.thumbX = e.detail.x || 0;
      vrLeft.thumbY = e.detail.y || 0;
    });
    // X and Y buttons are on the left controller
    leftHand.addEventListener('xbuttondown', () => toggleMenu());
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
        State.gameSession.buildMode = null;
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
    cameraRig.y += e.deltaY * 0.05;
    cameraRig.y = Math.max(10, Math.min(80, cameraRig.y));
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
}

export function jumpCameraTo(x, z) {
  cameraRig.x = Math.max(-MAP_HALF, Math.min(MAP_HALF, x));
  cameraRig.z = Math.max(-MAP_HALF, Math.min(MAP_HALF, z));
}

/** RTS camera above a player's base corner, yaw toward map center (matches W forward = −sin(rotY), −cos(rotY)). */
export function positionCameraForPlayer(playerId) {
  const p = State.players[playerId];
  const spawn = (p && p.spawn) || SPAWN_POSITIONS[playerId];
  if (!spawn) return;
  cameraRig.x = spawn.x * 0.8;
  cameraRig.z = spawn.z * 0.8;
  cameraRig.y = 45;
  if (Math.hypot(cameraRig.x, cameraRig.z) > 0.01) {
    cameraRig.rotY = Math.atan2(cameraRig.x, cameraRig.z);
  } else {
    cameraRig.rotY = 0;
  }
  const rig = document.getElementById('cameraRig');
  if (rig) {
    rig.object3D.position.set(cameraRig.x, cameraRig.y, cameraRig.z);
    rig.object3D.rotation.y = cameraRig.rotY;
  }
}

// --- Per-frame input processing ---
export function updateInput(dt) {
  syncIsVRFromScene();

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

  // Clamp camera
  cameraRig.x = Math.max(-MAP_HALF, Math.min(MAP_HALF, cameraRig.x));
  cameraRig.z = Math.max(-MAP_HALF, Math.min(MAP_HALF, cameraRig.z));

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
          cameraRig.y = Math.max(10, Math.min(80, cameraRig.y - deltaDistance * 30));
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
          const heightMul = cameraRig.y / 40;
          _worldDelta.multiplyScalar(100 * heightMul);
          cameraRig.x = Math.max(-MAP_HALF, Math.min(MAP_HALF, cameraRig.x + _worldDelta.x));
          cameraRig.z = Math.max(-MAP_HALF, Math.min(MAP_HALF, cameraRig.z + _worldDelta.z));
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
      cameraRig.y = Math.max(10, Math.min(80, cameraRig.y));
    }
  }

  // Apply camera position
  const rig = document.getElementById('cameraRig');
  if (rig) {
    rig.object3D.position.set(cameraRig.x, cameraRig.y, cameraRig.z);
    rig.object3D.rotation.y = cameraRig.rotY;
  }
}

let lastClickTime = 0;
let lastClickTargetId = null;

/** Same as mouse left-click on the world: select units (any owner), buildings, resources, clear on empty ground. */
function performWorldSelectionRay(origin, direction, shiftHeld) {
  const hitUnit = Renderer.raycastUnits(origin, direction);
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

  const hitBuilding = Renderer.raycastBuildings(origin, direction);
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

  const hitResource = Renderer.raycastResourceFields(origin, direction);
  if (hitResource) {
    State.deselectAll();
    UI.hideBuildingPanel();
    UI.showResourceFieldPanel(hitResource);
    const capacityStr = `${Math.floor(hitResource.remaining)} / ${hitResource.maxCapacity}`;
    UI.showStatus(`Resource Crystal - Remaining: ${capacityStr}`);
    return;
  }

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
function performWorldCommandRay(origin, direction) {
  const myUnits = Array.from(State.selectedUnits).filter(id => {
    const u = State.units.get(id);
    return u && u.ownerId === State.gameSession.myPlayerId;
  });
  if (myUnits.length === 0) return;

  const hitUnit = Renderer.raycastUnits(origin, direction);
  if (hitUnit) {
    const myTeam = State.players[State.gameSession.myPlayerId]?.team;
    if (hitUnit.ownerId === State.gameSession.myPlayerId) {
      Network.sendCommand({ action: 'follow', unitIds: myUnits, targetId: hitUnit.id });
      UI.showStatus('Following...');
      return;
    } else if (hitUnit.team !== myTeam) {
      Network.sendCommand({ action: 'attack', unitIds: myUnits, targetId: hitUnit.id });
      UI.showStatus('Attacking!');
      return;
    }
  }

  const hitBuilding = Renderer.raycastBuildings(origin, direction);
  if (hitBuilding) {
    const myTeam = State.players[State.gameSession.myPlayerId]?.team;
    const bTeam = State.players[hitBuilding.ownerId]?.team;
    if (bTeam !== myTeam) {
      Network.sendCommand({ action: 'attackBuilding', unitIds: myUnits, targetId: hitBuilding.id });
      UI.showStatus('Attacking building!');
      return;
    }
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
          State.gameSession.buildMode = null;
          clearBuildBanner();
        } else {
          UI.showStatus(Network.commandFailureMessage(code));
        }
      });
    }
    return;
  }

  const shiftHeld = e.shiftKey || keys['shift'];
  performWorldSelectionRay(origin, direction, shiftHeld);
}

function onRightClick(e) {
  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;
  if (performance.now() < suppressDesktopMouseFromTouchMs) return;

  // Ignore right-clicks on UI elements
  if (e.target.closest('#minimap')) return;
  
  if (State.gameSession.buildMode) {
    State.gameSession.buildMode = null;
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

  performWorldCommandRay(origin, direction);
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
  if (el.closest('#hud-2d-toggle')) return true;
  if (el.closest('#build-placement-banner')) return true;
  if (el.closest('#loading-screen')) return true;
  return false;
}

/**
 * VR right trigger and mobile tap: select / inspect, command when units selected,
 * ground move/attack, build placement, resource panel.
 */
function performVrStyleBattlefieldRay(origin, direction) {
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
            State.gameSession.buildMode = null;
            clearBuildBanner();
            UI.showStatus(`Placed ${BUILDING_TYPES[buildingType]?.name || buildingType}`);
          } else {
            UI.showStatus(Network.commandFailureMessage(code));
          }
        }
      );
    }
    return;
  }

  const myUnits = Array.from(State.selectedUnits).filter(id => {
    const u = State.units.get(id);
    return u && u.ownerId === State.gameSession.myPlayerId;
  });
  const myTeam = State.players[State.gameSession.myPlayerId]?.team;

  const hitUnit = Renderer.raycastUnits(origin, direction);
  if (hitUnit) {
    if (hitUnit.ownerId === State.gameSession.myPlayerId) {
      State.selectUnit(hitUnit.id);
      UI.hideBuildingPanel();
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
    return;
  }

  const hitBuilding = Renderer.raycastBuildings(origin, direction);
  if (hitBuilding) {
    if (hitBuilding.ownerId === State.gameSession.myPlayerId) {
      State.deselectAll();
      UI.showBuildingPanel(hitBuilding);
      UI.showStatus(`Selected ${BUILDING_TYPES[hitBuilding.type]?.name || hitBuilding.type}`);
    } else if (myUnits.length > 0) {
      const bTeam = State.players[hitBuilding.ownerId]?.team;
      if (bTeam !== myTeam) {
        Network.sendCommand({ action: 'attackBuilding', unitIds: myUnits, targetId: hitBuilding.id });
        UI.showStatus('Attacking building!');
      } else {
        UI.showStatus('Allied building — cannot attack');
      }
    } else {
      State.deselectAll();
      UI.showBuildingPanel(hitBuilding);
      const bTeam = State.players[hitBuilding.ownerId]?.team;
      const label = bTeam === myTeam ? 'Allied' : 'Enemy';
      UI.showStatus(`${label} ${BUILDING_TYPES[hitBuilding.type]?.name || hitBuilding.type}`);
    }
    return;
  }

  const hitResource = Renderer.raycastResourceFields(origin, direction);
  if (hitResource) {
    State.deselectAll();
    UI.hideBuildingPanel();
    UI.showResourceFieldPanel(hitResource);
    const capacityStr = `${Math.floor(hitResource.remaining)} / ${hitResource.maxCapacity}`;
    UI.showStatus(`Resource Crystal - Remaining: ${capacityStr}`);
    return;
  }

  const groundHit = raycastGround(origin, direction);
  if (groundHit && myUnits.length > 0) {
    Network.sendCommand({ action: 'move', unitIds: myUnits, x: groundHit.x, z: groundHit.z });
    UI.showStatus('Moving...');
  }
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

  const hitUnit = Renderer.raycastUnits(origin, direction);
  if (hitUnit) {
    if (hitUnit.ownerId === State.gameSession.myPlayerId) {
      State.deselectAll();
      selectNearbyOfType(hitUnit);
      UI.hideBuildingPanel();
      touchLongPressConsumed = true;
    }
    return;
  }
  if (Renderer.raycastBuildings(origin, direction) || Renderer.raycastResourceFields(origin, direction)) {
    return;
  }
  const groundHit = raycastGround(origin, direction);
  if (groundHit) {
    State.deselectAll();
    UI.hideBuildingPanel();
    UI.showStatus('Deselected');
    touchLongPressConsumed = true;
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
    cameraRig.y = Math.max(10, Math.min(80, cameraRig.y - dDist * zoomSens));

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

    cameraRig.x = Math.max(-MAP_HALF, Math.min(MAP_HALF, cameraRig.x));
    cameraRig.z = Math.max(-MAP_HALF, Math.min(MAP_HALF, cameraRig.z));

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
        if (r) performVrStyleBattlefieldRay(r.origin, r.direction);
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

/** `'vr'` | `'touch'` | `'desktop'` — for HUD hints (not authoritative for XR). */
export function getInputPlatform() {
  if (isVR) return 'vr';
  const coarse =
    (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) ||
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  return coarse ? 'touch' : 'desktop';
}

// --- VR Trigger: RIGHT hand (select / command) ---
function onVRTriggerRight(e) {
  const controller = e.target;
  if (!controller) return;

  const now = Date.now();
  if (tryVrUiClickFromChildRay(controller)) {
    lastTriggerTime = now;
    return;
  }

  if (now - lastTriggerTime < 200) return;

  setVrAimRayFromController(controller, _origin, _direction);

  // VR main menu: clicks handled via child ray above; no battlefield input while menu / lobby
  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) {
    lastTriggerTime = now;
    return;
  }

  lastTriggerTime = now;

  performVrStyleBattlefieldRay(_origin, _direction);
}

// --- VR Trigger: LEFT hand (build / secondary) ---
function onVRTriggerLeft(e) {
  const controller = e.target;
  if (!controller) return;
  if (tryVrUiClickFromChildRay(controller)) return;

  if (!State.gameSession.gameStarted || State.gameSession.menuOpen) return;

  // Left trigger places building in build mode
  if (State.gameSession.buildMode) {
    setVrAimRayFromController(controller, _origin, _direction);

    const groundHit = raycastGround(_origin, _direction);
    if (groundHit) {
      const buildingType = State.gameSession.buildMode;
      Network.sendCommand({
        action: 'build',
        buildingType,
        x: groundHit.x,
        z: groundHit.z,
      }, (ok, code) => {
        if (ok) {
          State.gameSession.buildMode = null;
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

function raycastGround(origin, direction) {
  if (Math.abs(direction.y) < 0.001) return null;
  const t = -origin.y / direction.y;
  if (t < 0) return null;

  const x = origin.x + direction.x * t;
  const z = origin.z + direction.z * t;

  if (Math.abs(x) > MAP_HALF || Math.abs(z) > MAP_HALF) return null;
  return { x, z };
}

// --- Menu ---
function toggleMenu() {
  State.gameSession.menuOpen = !State.gameSession.menuOpen;
  UI.updateMenuVisibility();
}

export function toggleBuildMode(buildingType) {
  if (!buildingType) {
    State.gameSession.buildMode = null;
    clearBuildBanner();
    return;
  }
  if (State.gameSession.buildMode === buildingType) {
    State.gameSession.buildMode = null;
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
        ? 'Trigger on ground to place · X to cancel · left trigger: HQ menu'
        : 'Click ground within HQ build radius · <b>X</b> or right-click to cancel · VR: left trigger opens HQ menu';
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
