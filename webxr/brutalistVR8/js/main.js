/**
 * brutalistVR8 — sector-streaming combat sandbox.
 *
 * History (since this is a long-running fork):
 *   v5/v6/v7 had a BVH path-traced lightmap baker for static lighting.
 *   v8 originally kept that and added wave-based combat. This revision
 *   removes the entire bake pipeline (bvhBake.js, lightmapStore.js,
 *   brutalistLayout.js, three-gpu-pathtracer) and replaces the single
 *   hand-tuned brutalist building with a 9×9 grid of fully procedural
 *   sectors, of which a 3×3 around the player is loaded at any time.
 *
 *   Lighting is now real-time: a single DirectionalLight at intensity
 *   ~4.0 with PCFSoft shadow maps, every slab is castShadow + receiveShadow.
 *
 *   Persisted: WebXR locomotion (Nock-style grab/throw + editor),
 *   wave system, drones (incl. shield/tank/engineer/jet/hover variants),
 *   grenades, music, FPS panel, sky + bloom + film + SMAA.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
/* Sky removed: replaced by a programmatic equirect gradient sky whose
 * horizon colour is bound to the fog colour (see setupSkyAndBloom and
 * `SKY_HORIZON_HEX` below). The procedural Sky shader does not respect
 * scene.fog, so geometry fading into fog visibly mismatched the bright
 * Sky horizon, making sector pop-in/out visible. */
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { FilmPass } from "three/addons/postprocessing/FilmPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import {
  initSectors,
  updateSectorStreaming,
  getActiveCollisionBoxes,
  getActiveSceneObjects,
  getCurrentSectorKey,
  getActiveSectorKeys,
  getAllSectorMetas,
  setOnSectorsChanged,
  SECTOR_SIZE,
  GRID_HALF,
} from "./sectors.js";
import {
  initBots,
  updateBots,
  setBotsEnabled,
  getBotsEnabled,
  getBotsDebug,
  killAllDrones,
  jumpToWave,
  spawnSpecificDrone,
} from "./bots.js";

const ENV_URL =
  "https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/aristea_wreck_puresky_2k.hdr";

function readIntParam(name, fallback) {
  try {
    const v = new URLSearchParams(window.location.search).get(name);
    if (v == null || v === "") return fallback;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch (_) {
    return fallback;
  }
}

function readFloatParam(name, fallback) {
  try {
    const v = new URLSearchParams(window.location.search).get(name);
    if (v == null || v === "") return fallback;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  } catch (_) {
    return fallback;
  }
}

/** Sun light intensity (overdriven so concrete actually triggers bloom and shadows
 *  read with real contrast). */
const SUN_INTENSITY = readFloatParam("sun", 4.0);
/** `?hdr=1` → use the photographic HDR equirect as scene.background. WARNING
 *  this disables the no-pop fog matching (background colour stops matching
 *  fog colour, so streaming pops become visible again). Opt-in only. */
const USE_HDR = readIntParam("hdr", 0) === 1;

/** SKY / FOG: ONE colour, used as both `scene.background` AND `scene.fog`.
 *
 *   Per the three.js fog manual, fog only "hides" geometry if the fog
 *   colour matches the colour visible behind that geometry. The cheapest
 *   and most bulletproof way to satisfy this is a solid-colour
 *   background equal to the fog colour everywhere on the dome (this is
 *   what BattleVR does: black fog + black a-sky). Anything fancier
 *   (procedural Sky, gradient sky, HDR equirect) introduces a mismatch
 *   somewhere on the dome and re-introduces visible pops.
 *
 *   Tunable via `?skyhorizon=` (six-digit hex without `#`).
 */
const SKY_HORIZON_HEX = (() => {
  try {
    const v = new URLSearchParams(window.location.search).get("skyhorizon");
    if (v) return parseInt(v, 16);
  } catch (_) { /* noop */ }
  return 0xc4ccd4;
})();
const SHOW_FPS = (() => {
  try {
    const v = new URLSearchParams(window.location.search).get("fps");
    return v == null ? true : v !== "0" && v !== "false";
  } catch (_) {
    return true;
  }
})();

let scene;
let camera;
let cameraRig;
let renderer;
let controls;
/** EffectComposer chain for desktop bloom + grain + SMAA + output (VR uses direct render). */
let composer = null;
let bloomPass = null;
let filmPass = null;
let smaaPass = null;
/** Real-time directional light. Cast direction is the HDR sun. */
let sunLight = null;
const sunVec = new THREE.Vector3();
const SUN_LIGHT_DIST = 80;
let sunShadowFrame = 0;
let lastTime = 0;
let statusElement;
let fpsElement;
const fpsState = {
  frameCount: 0,
  windowStart: 0,
  history: [],
  display: 0,
  lastShown: -1,
  windowMs: 500,
};
/** Head-locked VR FPS panel. */
const vrFps = {
  /** @type {THREE.Mesh | null} */ mesh: null,
  /** @type {HTMLCanvasElement | null} */ canvas: null,
  /** @type {CanvasRenderingContext2D | null} */ ctx: null,
  /** @type {THREE.CanvasTexture | null} */ texture: null,
  lastDrawn: -1,
};
const orbitTarget = new THREE.Vector3(0, 4, 0);
/** Where the bots module teleports the player on respawn. Updates as the
 *  player roams (current sector centre). */
const playerSpawnPos = new THREE.Vector3(0, 0, 0);

let controller1;
let controller2;
let controllerGrip1;
let controllerGrip2;
const vrInput = { leftStick: { x: 0, y: 0 }, rightStick: { x: 0, y: 0 } };
const moveSpeed = 6;
const rotateSpeed = 60;
const verticalSpeed = 2;
const deadzone = 0.15;

/* ── Locomotion modes ─────────────────────────────────────────────────── */
let locomotionMode = "physics";
const MOON_GRAVITY = 1.62;
const AIR_DAMPING = 0.4;
const GROUND_FRICTION = 0.85;
const THROW_BOOST = 4.0;
const VEL_HISTORY_FRAMES = 4;
const MAX_HORIZONTAL_SPEED = 24;
const MAX_VERTICAL_SPEED = 6;
const MAX_JUMPS = 2;
const JUMP_THRESHOLD = 1.0;
const handToCtrl = { left: null, right: null };
const rigVelocity = new THREE.Vector3();
let yButtonWasPressed = false;
let jumpsRemaining = MAX_JUMPS;
const grabState = {
  left:  { active: false, prevLocal: new THREE.Vector3(), history: [] },
  right: { active: false, prevLocal: new THREE.Vector3(), history: [] },
};

/* ── OBB collision ────────────────────────────────────────────────────── */
const PLAYER_RADIUS = 0.3;
const HEAD_MARGIN = 0.15;
const RIG_SAMPLE_YS = [0.2, 0.6, 1.0, 1.4, 1.75];
const _headW = new THREE.Vector3();
const _localPt = new THREE.Vector3();
const _localPush = new THREE.Vector3();
const _samples = [
  { x: 0, y: 0, z: 0, m: PLAYER_RADIUS },
  { x: 0, y: 0, z: 0, m: PLAYER_RADIUS },
  { x: 0, y: 0, z: 0, m: PLAYER_RADIUS },
  { x: 0, y: 0, z: 0, m: PLAYER_RADIUS },
  { x: 0, y: 0, z: 0, m: PLAYER_RADIUS },
  { x: 0, y: 0, z: 0, m: HEAD_MARGIN },
];

/**
 * Push the rig out of any active-sector OBB it overlaps. Sliding emerges
 * naturally from the per-axis push along the slab's local normal.
 *
 * Iterates only the OBBs returned by getActiveCollisionBoxes() — i.e.
 * boxes from the loaded 3×3 sector window. Total is typically 30–80
 * boxes; the 6-sample × 3-iteration scan is comfortably under 500
 * OBB tests/frame.
 */
function resolveAllCollisions(rigPos) {
  const xrCam = renderer.xr.getCamera();
  cameraRig.updateMatrixWorld(true);
  _headW.copy(xrCam.position).applyMatrix4(cameraRig.matrixWorld);

  for (let i = 0; i < RIG_SAMPLE_YS.length; i++) {
    _samples[i].x = rigPos.x;
    _samples[i].y = rigPos.y + RIG_SAMPLE_YS[i];
    _samples[i].z = rigPos.z;
  }
  const head = _samples[_samples.length - 1];
  head.x = _headW.x;
  head.y = _headW.y;
  head.z = _headW.z;

  const boxes = getActiveCollisionBoxes();
  for (let iter = 0; iter < 3; iter++) {
    let pushedAny = false;
    for (const b of boxes) {
      for (const s of _samples) {
        _localPt.set(s.x - b.cx, s.y - b.cy, s.z - b.cz).applyMatrix3(b.mInv);
        const exX = b.hx + s.m;
        const exY = b.hy + s.m;
        const exZ = b.hz + s.m;
        if (_localPt.x <= -exX || _localPt.x >= exX) continue;
        if (_localPt.y <= -exY || _localPt.y >= exY) continue;
        if (_localPt.z <= -exZ || _localPt.z >= exZ) continue;

        const pens = [
          _localPt.x + exX, exX - _localPt.x,
          _localPt.y + exY, exY - _localPt.y,
          _localPt.z + exZ, exZ - _localPt.z,
        ];
        const order = [0, 1, 2, 3, 4, 5];
        order.sort((a, b2) => pens[a] - pens[b2]);

        for (const mi of order) {
          const push = pens[mi];
          _localPush.set(0, 0, 0);
          if (mi === 0) _localPush.x = -push;
          else if (mi === 1) _localPush.x = push;
          else if (mi === 2) _localPush.y = -push;
          else if (mi === 3) _localPush.y = push;
          else if (mi === 4) _localPush.z = -push;
          else _localPush.z = push;

          _localPush.applyMatrix3(b.m);

          if (rigPos.y + _localPush.y < 0) continue;

          rigPos.x += _localPush.x;
          rigPos.y += _localPush.y;
          rigPos.z += _localPush.z;
          for (const sa of _samples) {
            sa.x += _localPush.x;
            sa.y += _localPush.y;
            sa.z += _localPush.z;
          }
          pushedAny = true;
          break;
        }
      }
    }
    if (!pushedAny) break;
  }
}

function setStatus(t) {
  if (statusElement) statusElement.textContent = t;
}

function tickFps(nowMs) {
  fpsState.frameCount += 1;
  const elapsed = nowMs - fpsState.windowStart;
  if (elapsed < fpsState.windowMs) return;
  const fps = elapsed > 0 ? Math.round((fpsState.frameCount * 1000) / elapsed) : 0;
  fpsState.history.push(fps);
  if (fpsState.history.length > 5) fpsState.history.shift();
  fpsState.display = Math.round(
    fpsState.history.reduce((a, b) => a + b, 0) / fpsState.history.length,
  );
  fpsState.frameCount = 0;
  fpsState.windowStart = nowMs;
  if (fpsElement && fpsState.display !== fpsState.lastShown) {
    fpsElement.textContent = `${fpsState.display} FPS`;
    fpsState.lastShown = fpsState.display;
  }
  drawVrFpsPanel(fpsState.display);
}

function ensureVrFpsPanel(parentCamera) {
  if (vrFps.mesh || !parentCamera) return;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 96;
  const ctx = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const aspect = c.width / c.height;
  const planeH = 0.05;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(planeH * aspect, planeH),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    }),
  );
  mesh.position.set(0.18, -0.13, -0.6);
  mesh.renderOrder = 9999;
  mesh.frustumCulled = false;
  mesh.visible = false;
  parentCamera.add(mesh);
  vrFps.canvas = c;
  vrFps.ctx = ctx;
  vrFps.texture = tex;
  vrFps.mesh = mesh;
}

function drawVrFpsPanel(fps) {
  if (!vrFps.ctx || fps === vrFps.lastDrawn) return;
  const ctx = vrFps.ctx;
  const w = vrFps.canvas.width;
  const h = vrFps.canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.78)";
  const r = 14;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#4fc3f7";
  ctx.font = "600 56px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`${fps}`, w - 70, 70);
  ctx.fillStyle = "#9fd6ff";
  ctx.font = "500 28px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("FPS", w - 60, 66);
  if (vrFps.texture) vrFps.texture.needsUpdate = true;
  vrFps.lastDrawn = fps;
}

/* ── VR controllers ───────────────────────────────────────────────────── */

function setupVRControllers() {
  const factory = new XRControllerModelFactory();
  controller1 = renderer.xr.getController(0);
  cameraRig.add(controller1);
  controllerGrip1 = renderer.xr.getControllerGrip(0);
  controllerGrip1.add(factory.createControllerModel(controllerGrip1));
  cameraRig.add(controllerGrip1);
  controller2 = renderer.xr.getController(1);
  cameraRig.add(controller2);
  controllerGrip2 = renderer.xr.getControllerGrip(1);
  controllerGrip2.add(factory.createControllerModel(controllerGrip2));
  cameraRig.add(controllerGrip2);

  controller1.addEventListener("connected", (e) => {
    if (e.data?.handedness) handToCtrl[e.data.handedness] = controllerGrip1;
  });
  controller2.addEventListener("connected", (e) => {
    if (e.data?.handedness) handToCtrl[e.data.handedness] = controllerGrip2;
  });
}

function toggleLocomotionMode() {
  locomotionMode = locomotionMode === "editor" ? "physics" : "editor";
  rigVelocity.set(0, 0, 0);
  jumpsRemaining = MAX_JUMPS;
  grabState.left.active = false;
  grabState.left.history.length = 0;
  grabState.right.active = false;
  grabState.right.history.length = 0;
  console.log(`[locomotion] mode → ${locomotionMode}`);
  setStatus(`Locomotion: ${locomotionMode}`);
}

const _handVel = new THREE.Vector3();
const _localDelta = new THREE.Vector3();

function updateGrabLocomotion(dt) {
  const session = renderer.xr.getSession();
  if (!session) return;

  const grip = { left: false, right: false };
  for (const src of session.inputSources) {
    if (src?.handedness && src.gamepad?.buttons?.[1]) {
      grip[src.handedness] = src.gamepad.buttons[1].pressed;
    }
  }

  for (const hand of ["left", "right"]) {
    const state = grabState[hand];
    const ctrl = handToCtrl[hand];
    if (!ctrl) continue;

    if (grip[hand] && !state.active) {
      state.active = true;
      state.prevLocal.copy(ctrl.position);
      state.history.length = 0;
      continue;
    }

    if (grip[hand] && state.active) {
      _localDelta.copy(ctrl.position).sub(state.prevLocal);
      state.prevLocal.copy(ctrl.position);
      state.history.push([_localDelta.x / dt, _localDelta.y / dt, _localDelta.z / dt]);
      if (state.history.length > VEL_HISTORY_FRAMES) state.history.shift();
    }

    if (!grip[hand] && state.active) {
      state.active = false;
      if (state.history.length > 0) {
        let vx = 0, vy = 0, vz = 0;
        for (const h of state.history) { vx += h[0]; vy += h[1]; vz += h[2]; }
        const k = state.history.length;
        _handVel.set(vx / k, vy / k, vz / k).applyQuaternion(cameraRig.quaternion);
        let impX = -_handVel.x * THROW_BOOST;
        let impY = -_handVel.y * THROW_BOOST;
        let impZ = -_handVel.z * THROW_BOOST;

        if (impY > JUMP_THRESHOLD) {
          if (jumpsRemaining > 0) jumpsRemaining--;
          else impY = 0;
        }

        rigVelocity.x += impX;
        rigVelocity.y += impY;
        rigVelocity.z += impZ;

        const horizSpeed = Math.hypot(rigVelocity.x, rigVelocity.z);
        if (horizSpeed > MAX_HORIZONTAL_SPEED) {
          const s = MAX_HORIZONTAL_SPEED / horizSpeed;
          rigVelocity.x *= s;
          rigVelocity.z *= s;
        }
        if (rigVelocity.y > MAX_VERTICAL_SPEED) rigVelocity.y = MAX_VERTICAL_SPEED;
        if (rigVelocity.y < -MAX_VERTICAL_SPEED) rigVelocity.y = -MAX_VERTICAL_SPEED;
      }
      state.history.length = 0;
    }
  }
}

function isGrounded() {
  if (cameraRig.position.y <= 0.01) return true;
  const px = cameraRig.position.x;
  const pz = cameraRig.position.z;
  const py = cameraRig.position.y - 0.1;
  const r = PLAYER_RADIUS;
  const boxes = getActiveCollisionBoxes();
  for (const b of boxes) {
    _localPt.set(px - b.cx, py - b.cy, pz - b.cz).applyMatrix3(b.mInv);
    if (_localPt.y < b.hy - 0.2 || _localPt.y > b.hy + 0.2) continue;
    if (Math.abs(_localPt.x) > b.hx + r) continue;
    if (Math.abs(_localPt.z) > b.hz + r) continue;
    return true;
  }
  return false;
}

function updateEditorMovement(dt, xrCamera) {
  const localDir = new THREE.Vector3(0, 0, -1);
  localDir.applyQuaternion(xrCamera.quaternion);
  localDir.applyQuaternion(cameraRig.quaternion);
  const direction = new THREE.Vector3(localDir.x, 0, localDir.z);
  const dirLength = direction.length();
  if (dirLength > 0.01) direction.divideScalar(dirLength);
  else {
    direction.set(0, 0, -1).applyQuaternion(cameraRig.quaternion);
    direction.y = 0;
    direction.normalize();
  }
  const strafe = new THREE.Vector3(-direction.z, 0, direction.x);
  const moveX = Math.abs(vrInput.leftStick.x) > deadzone ? -vrInput.leftStick.x : 0;
  const moveY = Math.abs(vrInput.leftStick.y) > deadzone ? -vrInput.leftStick.y : 0;
  if (moveX !== 0 || moveY !== 0) {
    cameraRig.position.x += (direction.x * moveY - strafe.x * moveX) * moveSpeed * dt;
    cameraRig.position.z += (direction.z * moveY - strafe.z * moveX) * moveSpeed * dt;
  }
  const rotateX = Math.abs(vrInput.rightStick.x) > deadzone ? vrInput.rightStick.x : 0;
  if (rotateX !== 0) {
    cameraRig.rotation.y -= rotateX * rotateSpeed * dt * (Math.PI / 180);
  }
  const moveVertical = Math.abs(vrInput.rightStick.y) > deadzone ? vrInput.rightStick.y : 0;
  if (moveVertical !== 0) {
    cameraRig.position.y -= moveVertical * verticalSpeed * dt;
  }
}

function updatePhysicsMovement(dt, xrCamera) {
  updateGrabLocomotion(dt);

  const grounded = isGrounded();
  const grabbing = grabState.left.active || grabState.right.active;

  rigVelocity.y -= MOON_GRAVITY * dt;
  if (rigVelocity.y < -MAX_VERTICAL_SPEED) rigVelocity.y = -MAX_VERTICAL_SPEED;

  cameraRig.position.x += rigVelocity.x * dt;
  cameraRig.position.y += rigVelocity.y * dt;
  cameraRig.position.z += rigVelocity.z * dt;

  if (!grabbing) {
    if (grounded) {
      rigVelocity.x *= Math.pow(GROUND_FRICTION, dt);
      rigVelocity.z *= Math.pow(GROUND_FRICTION, dt);
      if (rigVelocity.y < 0) rigVelocity.y = 0;
    } else {
      rigVelocity.x *= Math.pow(AIR_DAMPING, dt);
      rigVelocity.z *= Math.pow(AIR_DAMPING, dt);
    }
  }

  if (grounded) jumpsRemaining = MAX_JUMPS;

  if (grounded) {
    const localDir = new THREE.Vector3(0, 0, -1);
    localDir.applyQuaternion(xrCamera.quaternion);
    localDir.applyQuaternion(cameraRig.quaternion);
    const direction = new THREE.Vector3(localDir.x, 0, localDir.z);
    const dirLength = direction.length();
    if (dirLength > 0.01) direction.divideScalar(dirLength);
    else {
      direction.set(0, 0, -1).applyQuaternion(cameraRig.quaternion);
      direction.y = 0;
      direction.normalize();
    }
    const strafe = new THREE.Vector3(-direction.z, 0, direction.x);
    const moveX = Math.abs(vrInput.leftStick.x) > deadzone ? -vrInput.leftStick.x : 0;
    const moveY = Math.abs(vrInput.leftStick.y) > deadzone ? -vrInput.leftStick.y : 0;
    if (moveX !== 0 || moveY !== 0) {
      cameraRig.position.x += (direction.x * moveY - strafe.x * moveX) * moveSpeed * dt;
      cameraRig.position.z += (direction.z * moveY - strafe.z * moveX) * moveSpeed * dt;
    }
  }

  const rotateX = Math.abs(vrInput.rightStick.x) > deadzone ? vrInput.rightStick.x : 0;
  if (rotateX !== 0) {
    cameraRig.rotation.y -= rotateX * rotateSpeed * dt * (Math.PI / 180);
  }
}

function updateVRMovement(delta) {
  const session = renderer.xr.getSession();
  if (!session?.inputSources) return;
  vrInput.leftStick.x = 0;
  vrInput.leftStick.y = 0;
  vrInput.rightStick.x = 0;
  vrInput.rightStick.y = 0;
  let yPressed = false;
  for (let i = 0; i < session.inputSources.length; i++) {
    const source = session.inputSources[i];
    if (!source?.gamepad) continue;
    const axes = source.gamepad.axes;
    if (axes && axes.length >= 2) {
      let stickX, stickY;
      if (axes.length >= 4) { stickX = axes[2]; stickY = axes[3]; }
      else { stickX = axes[0] || 0; stickY = axes[1] || 0; }
      if (source.handedness === "left") {
        vrInput.leftStick.x = stickX;
        vrInput.leftStick.y = stickY;
      } else if (source.handedness === "right") {
        vrInput.rightStick.x = stickX;
        vrInput.rightStick.y = stickY;
      }
    }
    if (source.handedness === "left" && source.gamepad.buttons?.[5]?.pressed) {
      yPressed = true;
    }
  }
  if (yPressed && !yButtonWasPressed) toggleLocomotionMode();
  yButtonWasPressed = yPressed;

  const dt = delta / 1000;
  if (!dt || dt <= 0 || dt > 1) return;

  const xrCamera = renderer.xr.getCamera();

  if (locomotionMode === "physics") {
    updatePhysicsMovement(dt, xrCamera);
  } else {
    updateEditorMovement(dt, xrCamera);
  }

  cameraRig.position.y = Math.max(0, cameraRig.position.y);
  if (getActiveCollisionBoxes().length > 0) {
    resolveAllCollisions(cameraRig.position);
    cameraRig.position.y = Math.max(0, cameraRig.position.y);
  }
}

/* ── Real-time sun + shadows ──────────────────────────────────────────── */

/**
 * Single DirectionalLight at intensity SUN_INTENSITY (default 4) with
 * PCFSoft shadow maps. The orthographic frustum covers ±60 m around the
 * player — generous enough to envelope the active 3×3 sectors mostly,
 * snug enough to keep shadow texel density usable (about 12 cm/texel
 * at 1024²). Quantised to 1 m grid for shimmer-free re-projection.
 */
function setupSunLight() {
  if (!renderer) return;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;

  /* Sun direction matches the HDR roughly so the procedural sky's sun
   * disc lines up with real-time shadows. Hardcoded fallback if no
   * HDR is loaded. */
  sunVec.set(0.52, 0.78, 0.34).normalize();

  sunLight = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
  sunLight.castShadow = true;
  sunLight.position.copy(sunVec).multiplyScalar(SUN_LIGHT_DIST);
  sunLight.target.position.set(0, 5, 0);
  scene.add(sunLight.target);
  scene.add(sunLight);

  /* Shadow frustum ±90 m: large enough that its hard cutoff lives well
   * inside the FogExp2 wall (≥99% fogged at d≥90 m), so shadows
   * appearing/disappearing as the player moves are invisible. 2048²
   * keeps texel density ≈ 8.8 cm — sharper than the old 1024²/±60 m
   * config (≈11.7 cm) despite the larger frustum. Tuneable via
   * `?shadowsize=` / `?shadowhalf=`. */
  const shadowSize = readIntParam("shadowsize", 2048);
  const shadowHalf = readIntParam("shadowhalf", 90);
  sunLight.shadow.mapSize.set(shadowSize, shadowSize);
  const cam = sunLight.shadow.camera;
  cam.left = -shadowHalf;
  cam.right = shadowHalf;
  cam.top = shadowHalf;
  cam.bottom = -shadowHalf;
  cam.near = 10;
  cam.far = SUN_LIGHT_DIST + 100 + shadowHalf;
  cam.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.025;
  sunLight.shadow.radius = 2.5;

  /* A weak ambient so deep shadow doesn't render pitch-black on Quest 3
   * (no GI to fall back to). */
  scene.add(new THREE.AmbientLight(0xb0c4e0, 0.18));

  console.info(
    `[brutalistVR8] sun light: intensity ${SUN_INTENSITY}, ${shadowSize}² PCFSoft, ±${shadowHalf} m frustum (~${((cam.right - cam.left) / shadowSize * 100).toFixed(1)} cm/texel), follows player`,
  );
}

/* ── Bloom (sky lives in `init` as a solid Color matching fog) ────────── */

function setupSkyAndBloom() {
  /* No sky shader, no gradient — the background is a solid Color set in
   * `init()`, equal to fog colour. See the comment in `init` for why. */
  composer = new EffectComposer(renderer);
  const pr0 = Math.min(window.devicePixelRatio || 1, 2);
  const wPx = Math.floor(window.innerWidth * pr0);
  const hPx = Math.floor(window.innerHeight * pr0);

  const renderPass = new RenderPass(scene, camera);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(wPx, hPx), 0.34, 0.58, 0.78);
  filmPass = new FilmPass(0.07, false);
  filmPass.clear = false;
  smaaPass = new SMAAPass(wPx, hPx);
  const outputPass = new OutputPass();

  composer.addPass(renderPass);
  composer.addPass(bloomPass);
  composer.addPass(filmPass);
  composer.addPass(smaaPass);
  composer.addPass(outputPass);
}

/* ── Resize / animate ─────────────────────────────────────────────────── */

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (!renderer.xr.isPresenting) {
    renderer.setSize(w, h);
    if (composer) {
      const pr = Math.min(window.devicePixelRatio || 1, 2);
      composer.setSize(w, h);
      bloomPass?.setSize(Math.floor(w * pr), Math.floor(h * pr));
      smaaPass?.setSize(Math.floor(w * pr), Math.floor(h * pr));
    }
  }
}

function animate(time) {
  const delta = time - lastTime;
  lastTime = time;
  if (SHOW_FPS) tickFps(performance.now());

  /* Stream sectors based on the player's current XZ. Cheap (returns
   * fast unless they crossed a cell boundary). */
  updateSectorStreaming(cameraRig.position);
  /* `playerSpawnPos` stays pinned at world origin (sector 0,0). That
   * sector is guaranteed `open_park` (no central obstructions) so
   * respawn always succeeds. Dying in a far sector means a long walk
   * back, but never spawning inside a building. */

  /* Shadow camera follows the player on a 1 m grid (stable shadows). */
  if (sunLight) {
    sunShadowFrame++;
    /* Half-rate shadow updates: 60 Hz inside a 120 Hz render. Drone
     * motion is slow enough that the half-frame staleness is invisible. */
    renderer.shadowMap.autoUpdate = (sunShadowFrame & 1) === 0;
    const px = Math.round(cameraRig.position.x);
    const pz = Math.round(cameraRig.position.z);
    sunLight.target.position.set(px, 5, pz);
    sunLight.position.set(
      px + sunVec.x * SUN_LIGHT_DIST,
      sunVec.y * SUN_LIGHT_DIST,
      pz + sunVec.z * SUN_LIGHT_DIST,
    );
  }

  const botDt = Math.max(0, Math.min(0.1, (delta || 0) * 0.001));
  updateBots(botDt);

  if (renderer.xr.isPresenting) {
    updateVRMovement(delta);
    /* VR uses direct render — composer/bloom is single-eye only. */
    renderer.render(scene, camera);
  } else {
    controls.update();
    if (composer) composer.render(delta * 0.001);
    else renderer.render(scene, camera);
  }
}

/* ── init ─────────────────────────────────────────────────────────────── */

async function init() {
  statusElement = document.getElementById("status");
  fpsElement = document.getElementById("fps");
  if (fpsElement) fpsElement.style.display = SHOW_FPS ? "block" : "none";
  fpsState.windowStart = performance.now();
  drawVrFpsPanel(0);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.025, 1500);
  cameraRig = new THREE.Group();
  cameraRig.add(camera);
  camera.position.set(0, 2, 0);

  scene = new THREE.Scene();
  /* SOLID-COLOUR background EXACTLY equal to fog colour. Copied from
   * BattleVR (`fog="type: exponential; color: #000; density: 0.015"`
   * + `<a-sky color="#000011">`), which works perfectly because the
   * fog colour and the entire backdrop are the same colour — every
   * pixel a slab fades into is the same pixel that's drawn behind
   * the slab. No gradient sky, no Sky shader, no mismatch anywhere
   * on the dome. This is the only configuration the three.js fog
   * manual guarantees works.
   *
   * `SKY_HORIZON_HEX` is now overloaded as "the one colour" — both fog
   * AND background AND any HUD that wants to match it. Keep it as ONE
   * hex value; the previous gradient-zenith hex is unused.
   *
   * Density 0.025 + 5×5 active window + ±90 m sun-shadow frustum:
   *     d=60 m  (shadow cutoff edge): 89 % fogged
   *     d=80 m:                       98 % fogged
   *     d=90 m  (shadow frustum edge): 99.4 % fogged
   *     d=160 m (load/unload boundary): ~100 %
   *
   * Tunable: `?fogdensity=` (1/1000s, default 25 → 0.025).
   *          `?skyhorizon=` (hex w/o #) — also recoloures fog. */
  scene.background = new THREE.Color(SKY_HORIZON_HEX);
  const fogDensity = readIntParam("fogdensity", 25) / 1000;
  scene.fog = new THREE.FogExp2(SKY_HORIZON_HEX, fogDensity);
  scene.add(cameraRig);

  setStatus("Loading HDR…");
  try {
    const envTexture = await new RGBELoader().loadAsync(ENV_URL);
    envTexture.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = envTexture;
    scene.environmentIntensity = 0.45;
    if (USE_HDR) scene.background = envTexture;
  } catch (e) {
    console.warn("HDR load failed", e);
  }

  /* Spawn the player at sector (0,0)'s centre, slightly offset so they
   * don't appear inside any benches. */
  playerSpawnPos.set(0, 0, 0);
  cameraRig.position.copy(playerSpawnPos);
  orbitTarget.set(0, 4, -10);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);
  const vrHost = document.getElementById("vr-button-host");
  if (vrHost) vrHost.appendChild(VRButton.createButton(renderer));
  else document.body.appendChild(VRButton.createButton(renderer));

  if (renderer.xr.setReferenceSpaceType) {
    try {
      renderer.xr.setReferenceSpaceType("local-floor");
    } catch (_) { /* ignore */ }
  }

  renderer.xr.addEventListener("sessionstart", () => {
    if (renderer.xr.setFoveation) renderer.xr.setFoveation(1);
    const session = renderer.xr.getSession();
    if (session?.updateTargetFrameRate && session.supportedFrameRates?.includes(120)) {
      session.updateTargetFrameRate(120).catch(() => {});
    }
  });

  if (SHOW_FPS) {
    ensureVrFpsPanel(camera);
    renderer.xr.addEventListener("sessionstart", () => {
      if (vrFps.mesh) vrFps.mesh.visible = true;
    });
    renderer.xr.addEventListener("sessionend", () => {
      if (vrFps.mesh) vrFps.mesh.visible = false;
    });
  }

  setupVRControllers();
  setupSunLight();
  setupSkyAndBloom();

  /* Boot the sector streamer. Initial 3×3 around (0,0) loads here. */
  initSectors(scene, { initialKey: "0,0" });
  setOnSectorsChanged(({ currentKey, activeKeys }) => {
    /* Keep status line informative when not in combat. */
    if (!getBotsEnabled()) {
      setStatus(`sector ${currentKey} — ${activeKeys.length} active · ${getActiveSceneObjects().length} meshes · ${getActiveCollisionBoxes().length} OBBs`);
    }
  });

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(orbitTarget);
  controls.update();

  window.addEventListener("resize", onResize);
  renderer.setAnimationLoop(animate);
  setStatus("Ready — 9×9 procedural sectors, 3×3 active around player");

  /* Console API. Most v8 bake/preview commands removed. */
  window.brutalistVR8 = {
    /** Print streaming + scene state. */
    status() {
      const out = {
        currentSector: getCurrentSectorKey(),
        activeSectors: getActiveSectorKeys(),
        activeMeshes: getActiveSceneObjects().length,
        activeCollisionBoxes: getActiveCollisionBoxes().length,
        worldGrid: `${GRID_HALF * 2 + 1}×${GRID_HALF * 2 + 1}`,
        sectorSize: SECTOR_SIZE,
        sunIntensity: sunLight?.intensity,
        playerXZ: [Math.round(cameraRig.position.x), Math.round(cameraRig.position.z)],
      };
      console.info("brutalistVR8.status:", out);
      return out;
    },
    /** Dump the archetype map for the full 9×9 grid. */
    sectorMap() {
      const metas = getAllSectorMetas();
      const rows = [];
      for (let sz = -GRID_HALF; sz <= GRID_HALF; sz++) {
        const cells = [];
        for (let sx = -GRID_HALF; sx <= GRID_HALF; sx++) {
          const m = metas.find((mm) => mm.sx === sx && mm.sz === sz);
          cells.push(m ? m.archetype.padEnd(15) : "—".padEnd(15));
        }
        rows.push(cells.join(" "));
      }
      console.info("brutalistVR8.sectorMap (sz=−4 top, sx=−4 left):\n" + rows.join("\n"));
      return metas;
    },
    /** Set sun intensity at runtime. */
    setSun(v) {
      if (sunLight) sunLight.intensity = v;
      console.info("brutalistVR8.setSun:", v);
    },
  };
  /* Bots module. Takes ownership of all combat — its only outward
   * dependency is a getter for the active OBBs (so its drone steering
   * + grenade trajectory + projectile collision queries match what
   * the player physically collides with). */
  initBots({
    scene,
    camera,
    cameraRig,
    renderer,
    getCollisionBoxes: () => getActiveCollisionBoxes(),
    getPlayerVelocity: () => rigVelocity,
    getPlayerSpawn: () => playerSpawnPos,
    /** Bots use this to know where drones should anchor their spawn /
     *  survey targets. */
    getPlayerPosition: () => cameraRig.position,
    /** And this for the HUD minimap. */
    getSectorInfo: () => ({
      current: getCurrentSectorKey(),
      active: getActiveSectorKeys(),
      all: getAllSectorMetas(),
      sectorSize: SECTOR_SIZE,
      gridHalf: GRID_HALF,
    }),
    respawnPlayer: () => {
      cameraRig.position.copy(playerSpawnPos);
      rigVelocity.set(0, 0, 0);
      jumpsRemaining = MAX_JUMPS;
      grabState.left.active = false;
      grabState.right.active = false;
      grabState.left.history.length = 0;
      grabState.right.history.length = 0;
    },
  });
  window.brutalistVR8.bots = {
    setEnabled: setBotsEnabled,
    isEnabled: getBotsEnabled,
    debug: getBotsDebug,
    killAll: killAllDrones,
    jumpToWave,
    spawn: spawnSpecificDrone,
  };
  console.info("[brutalistVR8] console API ready — try brutalistVR8.status() or brutalistVR8.sectorMap()");
}

init().catch((e) => {
  console.error(e);
  setStatus(String(e));
});
