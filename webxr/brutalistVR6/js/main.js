/**
 * brutalistVR6 — fork of brutalistVR5 with **multi-bounce path-traced lightmap
 * bake** (real GI in the indirect term, not v5's constant skyFill). All v5
 * primitives are preserved (Sky, bloom pipeline, IndexedDB store, FPS panel,
 * UV2-checker, multi-view PT bake, BVH bake, console API). Only `bvhBake.js`
 * `computeLightingBVH` was replaced — see the function header there for the
 * algorithm and trade-offs. New rebake knob: `?bvhMaxBounces=N` (default 3,
 * 0 = direct only ≈ v5).
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
import { WebGLPathTracer, GradientEquirectTexture } from "three-gpu-pathtracer";
/* Sky + bloom pipeline copy-pasted from brutalistVR/js/main.js (`max` quality
 * mode). Same imports, same uniform values, same pass chain — see the
 * `setupSkyAndBloom` helper for the actual setup. */
import { Sky } from "three/addons/objects/Sky.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { FilmPass } from "three/addons/postprocessing/FilmPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { buildBrutalistLayout } from "./brutalistLayout.js";
import {
  prepareBoxesForBake,
  buildSceneBVH,
  createHdrBvhLighting,
  bakeObjectBVH,
  barycentric,
  dilatePixels,
  denoiseTexture,
  configureLightmapCanvasTexture,
} from "./bvhBake.js";
import {
  idbPut,
  idbGet,
  idbKeys,
  idbClear,
  idbEstimateMB,
} from "./lightmapStore.js";

const params = {
  multipleImportanceSampling: true,
  acesToneMapping: true,
  bounces: 5,
  filterGlossyFactor: 0.5,
  tiles: 2,
  environmentIntensity: 1.0,
  bgGradientTop: "#111111",
  bgGradientBottom: "#000000",
};

const ENV_URL =
  "https://raw.githubusercontent.com/gkjohnson/3d-demo-data/master/hdri/aristea_wreck_puresky_2k.hdr";

/* v6 is the multi-bounce path-tracing fork of v5. Its bakes encode a
 * fundamentally different lighting model (real GI in the indirect term, not
 * a constant skyFill), so they must NOT share storage with v5 — even loading
 * a v5 bake into v6 would visually mismatch the live IBL/Sky. Hence the v6
 * suffix on the storage key and IDB DB name (see `lightmapStore.js`). */
const STORAGE_KEY = "bvhBakedTextures_brutalistVR6_v1_pt";
/** No legacy localStorage keys for v6 — it's a fresh project, IDB-only. */
const LEGACY_BAKE_STORAGE_KEYS = [];

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

const LIGHTMAP_SIZE = readIntParam("lm", 1024);
const SAMPLES_PER_VIEW = readIntParam("pt", 300);
/** v6 lowered from v5's 384 because each "sample" is now an entire path (NEE
 * sun + up to `BVH_MAX_BOUNCES` cosine-bounce rays + NEE per hit), which
 * costs ~`BVH_MAX_BOUNCES * 2` rays vs v5's ~1 ray per sample. 96 paths × 4
 * bounces × 2 rays ≈ 768 rays/texel — same overall ray budget as v5's 384,
 * but spent on real GI instead of constant fill. Override with `?samples=N`. */
const BVH_SHADOW_SAMPLES = readIntParam("samples", 96);
const DENOISE_ITERATIONS = readIntParam("denoise", 1);
/** >1 stretches values away from midpoint so occluded texels read darker vs lit (denoise softens this). */
const LIGHTMAP_PUNCH = readFloatParam("lmpunch", 1.38);
/** v6: kept for back-compat with v5 lighting param shape, but ignored when
 * `BVH_MAX_BOUNCES > 0` (every path does NEE sun + cosine bounce — there is
 * no separate sun/sky budget split). Only used when bounces=0. */
const BVH_SUN_FRACTION = THREE.MathUtils.clamp(readFloatParam("sunfrac", 0.62), 0.38, 0.82);
/** v6: number of cosine-weighted bounce rays cast per path. 0 = direct only
 * (≈ v5 with sun NEE only, no skyFill terminator). 1 = "1 bounce, sky or
 * fill terminator" (≈ v5 with bounce). 3 = real GI for open-architecture
 * scenes (default). 5 = enclosed-room scenarios (light propagates further).
 * Each extra bounce costs ~2 extra rays per path (1 NEE + 1 hemisphere). */
const BVH_MAX_BOUNCES = THREE.MathUtils.clamp(readIntParam("bvhMaxBounces", 3), 0, 8);
/** v6: kept for compatibility with v5 console API & meta line — when bounces
 * > 0, the bounce loop is always active; this flag only gates whether the
 * skyFill *terminator* is used at max depth (off → terminator returns 0 →
 * deep enclosed corners stay near-black, more honest but more bias-prone). */
const BVH_BOUNCE_ENABLED = readIntParam("bounce", 1) >= 1;
/** Reflectance constant multiplied into throughput at every bounce. ~0.6
 * matches light concrete; 0.5 darker; 0.85 white plaster. */
const BVH_BOUNCE_ALBEDO = THREE.MathUtils.clamp(readFloatParam("bouncealbedo", 0.6), 0, 1);
/**
 * Penumbra width — half-angle of the jitter cone around the sun direction
 * (which itself is the brightness-weighted centroid of the HDR's bright region,
 * matching what the path tracer effectively integrates over).
 *   0.05 ≈ ±1.5° (sharp shadows)
 *   0.18 ≈ ±5°   (default — wide enough to merge close shadows)
 *   0.30 ≈ ±9°   (very soft)
 */
const BVH_SUN_JITTER = THREE.MathUtils.clamp(readFloatParam("sunjitter", 0.18), 0, 0.5);
/** Sun-region threshold for centroid + average colour (fraction of HDR peak). */
const BVH_SUN_THRESHOLD = THREE.MathUtils.clamp(readFloatParam("sunthr", 0.06), 0.005, 1);
/**
 * Shader-side lightmap remap (no rebake). Pipeline per texel:
 *   linear lm → pow(lm, gamma) → (lm − mid) * contrast + mid → * scale → += irradiance
 * `gamma > 1` deepens dark texels (occlusion); `contrast > 1` widens the gap around `mid`.
 * Defaults are intentionally aggressive so the difference vs. a flat additive is obvious.
 */
const LM_GAMMA = THREE.MathUtils.clamp(readFloatParam("lmgamma", 2.0), 0.5, 4);
const LM_CONTRAST = THREE.MathUtils.clamp(readFloatParam("lmcontrast", 1.4), 0.5, 3);
const LM_MID = THREE.MathUtils.clamp(readFloatParam("lmmid", 0.42), 0.05, 0.95);
const LM_SCALE = THREE.MathUtils.clamp(readFloatParam("lmscale", 10.2), 0.1, 32);
/**
 * `?hdr=1` → gradient sky background (outdoor look).
 * `?hdr=0` (default) → flat dark background.
 *
 * `scene.environment` is ALWAYS set to the loaded HDR regardless of this flag, because
 * `three-gpu-pathtracer` reads its IBL straight from `scene.environment` (a null env
 * = pitch-black preview). The baked-view materials suppress the live IBL via
 * per-material `envMapIntensity = 0` in `applyLightmapForBakedView`, so the bake
 * still wins on visible meshes. This flag only changes the *background* colour.
 */
const USE_HDR = readIntParam("hdr", 0) === 1;
const SHOW_FPS = (() => {
  try {
    const v = new URLSearchParams(window.location.search).get("fps");
    return v == null ? true : v !== "0" && v !== "false";
  } catch (_) {
    return true;
  }
})();


/** Unit-sphere view presets from BuildVR index5; world scale is filled in after the scene bbox exists. */
const BAKE_VIEW_UNIT = [
  { name: "corner1", pos: [4, 3, 4], target: [0, 0.5, 0] },
  { name: "corner2", pos: [-4, 3, 4], target: [0, 0.5, 0] },
  { name: "corner3", pos: [4, 3, -2], target: [0, 0.5, 0] },
  { name: "corner4", pos: [-4, 3, -2], target: [0, 0.5, 0] },
  { name: "top", pos: [0, 6, 0], target: [0, 0, 0] },
  { name: "low1", pos: [3, 1.5, 3], target: [0, 0.5, 0] },
  { name: "low2", pos: [-3, 1.5, 3], target: [0, 0.5, 0] },
  { name: "back", pos: [0, 2, -5], target: [0, 0.5, 0] },
];

/** @type {Array<{name:string,pos:number[],target:number[]}>} */
let BAKE_VIEWS = [];
/** Camera rig / bake view distance scale derived from scene size (meters-ish). */
let sceneBakeViewScale = 14;

function rebuildBakeViews(viewScale, targetLiftY) {
  sceneBakeViewScale = viewScale;
  BAKE_VIEWS = BAKE_VIEW_UNIT.map((v) => ({
    name: v.name,
    pos: v.pos.map((p) => p * viewScale),
    target: v.target.map((p, i) => (i === 1 ? p * viewScale + targetLiftY : p * viewScale)),
  }));
}

const FACE_COLORS = {
  0: { r: 255, g: 0, b: 0 },
  1: { r: 128, g: 0, b: 0 },
  2: { r: 0, g: 255, b: 0 },
  3: { r: 0, g: 128, b: 0 },
  4: { r: 0, g: 0, b: 255 },
  5: { r: 0, g: 0, b: 128 },
};

let scene;
let camera;
let cameraRig;
let renderer;
let controls;
let pathTracer;
let gradientMap;
/** Procedural atmospheric Sky (three/addons), see `setupSkyAndBloom`. */
let sky = null;
/** EffectComposer chain for non-VR baked-view bloom + grain + SMAA + output. */
let composer = null;
let bloomPass = null;
let filmPass = null;
let smaaPass = null;
let sceneObjects = [];
let sceneBVH = null;
let envData = null;
let lightingApi = null;
let isBaked = false;
let isPreviewMode = false;
/* Path tracer is opt-in for the 2D desktop view. Default OFF so the page
 * loads cheap on Quest 3 standalone browser (before entering VR) without
 * burning GPU on a Monte Carlo pass that nobody asked for. Click the
 * "Path tracer" button to enable it for live preview / sample
 * accumulation. Bakes drive the path tracer directly and ignore this flag. */
let pathTracerActive = false;
let isDebugMode = false;
/** Raster preview: StandardMaterial lightMap samples `uv2` (checker reveals layout per face). */
let isUv2CheckerActive = false;
let isMultiViewBaking = false;
/** After path-traced views are captured, UV projection runs async so the main thread can paint progress. */
let multiViewUvBusy = false;
let multiViewIndex = 0;
/** @type {Array<{name:string,camPos:THREE.Vector3,camMatrix:THREE.Matrix4,projMatrix:THREE.Matrix4,srcData:ImageData,width:number,height:number}>} */
let multiViewCaptures = [];
let lastTime = 0;
let samplesElement;
let statusElement;
let fpsElement;
/** Same wall-clock averaging window as RTSVR2/brutalistVR (`vr-wrist-settings.js`). */
const fpsState = {
  frameCount: 0,
  windowStart: 0,
  history: [],
  display: 0,
  lastShown: -1,
  windowMs: 500,
};
/**
 * Head-locked VR FPS panel: small `CanvasTexture` plane attached to the perspective
 * camera (head-pose target in WebXR), pinned slightly down-right so it stays in view
 * but out of the way. Drawn as `MeshBasicMaterial` with `depthTest=false` so it's
 * always on top.
 */
const vrFps = {
  /** @type {THREE.Mesh | null} */
  mesh: null,
  /** @type {HTMLCanvasElement | null} */
  canvas: null,
  /** @type {CanvasRenderingContext2D | null} */
  ctx: null,
  /** @type {THREE.CanvasTexture | null} */
  texture: null,
  lastDrawn: -1,
};
/** Orbit + post-bake camera look target (scene center once layout is known). */
const orbitTarget = new THREE.Vector3(0, 14, -10);

let controller1;
let controller2;
let controllerGrip1;
let controllerGrip2;
const vrInput = { leftStick: { x: 0, y: 0 }, rightStick: { x: 0, y: 0 } };
const moveSpeed = 6;
const rotateSpeed = 60;
const verticalSpeed = 2;
const deadzone = 0.15;

/* ── Locomotion modes ─────────────────────────────────────────────────────
 * "physics" : moon gravity + Nock-style grab/throw locomotion (default)
 * "editor"  : free flight, no gravity — useful for inspecting bakes
 * Toggled at runtime with the Y button on the left controller.
 */
let locomotionMode = "physics";
const MOON_GRAVITY = 1.62;
const MAX_FALL_SPEED = 30;
const AIR_DAMPING = 0.4;          // per-second multiplier for horizontal air drag
const GROUND_FRICTION = 0.85;     // per-second multiplier for ground friction
const THROW_BOOST = 4.0;          // multiplier on release velocity (1 = 1:1)
const VEL_HISTORY_FRAMES = 4;     // smoothing window for throw velocity
const MAX_HORIZONTAL_SPEED = 24;  // hard cap on |XZ velocity| (m/s)
const MAX_VERTICAL_SPEED = 6;     // hard cap on |Y velocity| (m/s)
const MAX_JUMPS = 2;              // total upward throws before needing to land (Nock-like)
const JUMP_THRESHOLD = 1.0;       // upward impulse Y component (m/s) that counts as a jump
const handToCtrl = { left: null, right: null };
const rigVelocity = new THREE.Vector3();
let yButtonWasPressed = false;
let jumpsRemaining = MAX_JUMPS;
const grabState = {
  left:  { active: false, prevLocal: new THREE.Vector3(), history: [] },
  right: { active: false, prevLocal: new THREE.Vector3(), history: [] },
};

/* ── AABB collision for VR locomotion ─────────────────────────────────── */

const PLAYER_RADIUS = 0.3;
const HEAD_MARGIN = 0.15;

/* Sample points along the rig's vertical capsule (offsets from rig.y) used
 * to push out of slabs. 5 samples cover feet → head. Each sample is treated
 * as a sphere of radius PLAYER_RADIUS. */
const RIG_SAMPLE_YS = [0.2, 0.6, 1.0, 1.4, 1.75];

/**
 * Oriented bounding boxes with full 3D rotation. Each box stores its
 * center, raw half-extents (no margin), and a 3x3 rotation matrix `m`
 * (local → world) plus its inverse `mInv` (world → local; transpose since
 * rotation matrices are orthonormal). Non-rotated slabs use the identity
 * matrix and behave like plain AABBs.
 * @type {Array<{cx:number, cy:number, cz:number, hx:number, hy:number, hz:number, m:THREE.Matrix3, mInv:THREE.Matrix3}>}
 */
const collisionBoxes = [];

function buildCollisionAABBs() {
  collisionBoxes.length = 0;
  const slabs = [
    { p: [0, 18, -50],   s: [120, 36, 8],  rot: [0, 0,    0] }, // north
    { p: [-8, 14, 52],   s: [100, 28, 10], rot: [0, 0,    0] }, // south
    { p: [58, 22, 0],    s: [10, 44, 70],  rot: [0, 0,    0] }, // east
    { p: [-58, 16, 4],   s: [12, 32, 65],  rot: [0, 0,    0] }, // west
    { p: [12, 26, -8],   s: [28, 52, 28],  rot: [0, 0,    0] }, // core
    { p: [-18, 22, -12], s: [48, 4, 14],   rot: [0, 0,    0] }, // bridge
    { p: [-28, 7, 28],   s: [22, 14, 22],  rot: [0, 0,    0] }, // pilotis
    { p: [22, 30, 22],   s: [36, 3, 18],   rot: [0.35, 0.12, -0.25] }, // cantilever
    { p: [-30, 3, -22],  s: [70, 6, 40],   rot: [0, 0,    0] }, // podium
  ];
  for (let i = 0; i < 5; i++) {
    slabs.push({ p: [-20 + i * 5, 12, -35], s: [1.2, 24, 6], rot: [0, 0, 0] });
  }
  const _euler = new THREE.Euler();
  const _quat = new THREE.Quaternion();
  const _m4 = new THREE.Matrix4();
  for (const { p, s, rot } of slabs) {
    _euler.set(rot[0], rot[1], rot[2], "XYZ");
    _quat.setFromEuler(_euler);
    _m4.makeRotationFromQuaternion(_quat);
    const m = new THREE.Matrix3().setFromMatrix4(_m4);
    const mInv = m.clone().transpose();
    collisionBoxes.push({
      cx: p[0], cy: p[1], cz: p[2],
      hx: s[0] / 2,
      hy: s[1] / 2,
      hz: s[2] / 2,
      m, mInv,
    });
  }
}

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
 * Push the rig out of any slabs it overlaps. Sliding emerges naturally:
 * when the joystick motion has a component along a slab's surface normal,
 * the push undoes that component, leaving the tangential component
 * intact. Works for any orientation (vertical walls, ceilings, ramps,
 * tilted overhangs).
 *
 * Sample points: 5 along the rig's vertical capsule (each treated as a
 * sphere of radius PLAYER_RADIUS) plus the actual head world position
 * (treated as a sphere of radius HEAD_MARGIN). The XR camera's `position`
 * is the head pose in tracking (rig-local) space — we transform it
 * through the rig's world matrix manually because `getWorldPosition`
 * would clobber the matrixWorld set by the XR manager and return
 * tracking-space coords as if they were world coords.
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

  for (let iter = 0; iter < 3; iter++) {
    let pushedAny = false;
    for (const b of collisionBoxes) {
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
        order.sort((a, b) => pens[a] - pens[b]);

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

/** Wall-clock 500 ms averaging (5-sample rolling), matches brutalistVR/RTSVR2 — not summed dt. */
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

/**
 * Build a small head-locked FPS panel and parent it to the user's PerspectiveCamera.
 * Three's `WebXRManager.updateUserCamera` overwrites `camera.matrix` with head pose
 * each frame and calls `updateMatrixWorld(true)`, so children follow head movement
 * (verified against three r169 `WebXRManager.js`). Drawn as `MeshBasicMaterial` with
 * `depthTest=false` + high `renderOrder` so it's always on top.
 */
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
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  /* Camera-local: −Z forward; tucked in lower-right at ~0.6 m so it reads but never
   * occludes the centre. `renderOrder` huge = drawn last → over everything. */
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

/** Repaint the VR FPS canvas only when the displayed value changes (cheap, but not free). */
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


function yieldToPaint() {
  return new Promise((r) => requestAnimationFrame(r));
}

function setBakeBarActive(active) {
  const wrap = document.getElementById("bake-progress-wrap");
  if (wrap) wrap.classList.toggle("active", active);
}

let _bakeStartMs = 0;

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

/** Updates bar + detail (and optional status). Use `updateStatus: false` when called every frame. */
function setBakeProgress(overallPct, detail, phaseLabel = "Baking", updateStatus = true) {
  setBakeBarActive(true);
  const bar = document.getElementById("bake-progress");
  const det = document.getElementById("bake-detail");
  const ph = document.getElementById("bake-phase-label");
  const timeEl = document.getElementById("bake-time");
  if (bar) bar.value = Math.max(0, Math.min(100, overallPct));
  if (ph) ph.textContent = phaseLabel;

  let timeLine = "";
  if (_bakeStartMs > 0) {
    const elapsed = performance.now() - _bakeStartMs;
    timeLine = `⏱ ${formatDuration(elapsed)}`;
    if (overallPct > 1) {
      const estTotal = elapsed / (overallPct / 100);
      const remaining = estTotal - elapsed;
      timeLine += ` · ~${formatDuration(remaining)} left`;
    }
  }
  if (timeEl) timeEl.textContent = timeLine;

  const fullDetail = timeLine ? `${detail}  ${timeLine}` : detail;
  if (det) det.textContent = fullDetail;
  if (updateStatus && statusElement) {
    statusElement.textContent = `${phaseLabel} · ${detail} — ${overallPct.toFixed(0)}%`;
  }
}

function hideBakeProgress() {
  _bakeStartMs = 0;
  setBakeBarActive(false);
  const bar = document.getElementById("bake-progress");
  const det = document.getElementById("bake-detail");
  const timeEl = document.getElementById("bake-time");
  if (bar) bar.value = 0;
  if (det) det.textContent = "";
  if (timeEl) timeEl.textContent = "";
}

function getLightmapUVs(geometry) {
  return geometry.attributes.uv2 || geometry.attributes.uv;
}

/**
 * Baked radiance is in `lightMap` (uv2). In Three r169, `lights_fragment_maps` adds the lightmap
 * to diffuse irradiance, but environment IBL diffuse/specular is accumulated in
 * `RE_IndirectSpecular_Physical` without being modulated by that lightmap — so any env map still
 * reads as a flat wash and hides shadow contrast. For baked view, disable IBL and coatings.
 *
 * `onBeforeCompile` injects a gamma + contrast remap on the lightmap sample so we can deepen
 * shadows on an already-baked texture without re-running BVH (controlled by `?lmgamma`,
 * `?lmcontrast`, `?lmmid`, `?lmscale`, defaults set above).
 */
function applyLightmapForBakedView(material, lightMapTex) {
  configureLightmapCanvasTexture(lightMapTex);
  material.lightMap = lightMapTex;
  material.lightMapIntensity = LM_SCALE;
  material.envMapIntensity = 0;
  if (material.metalness !== undefined) material.metalness = 0;
  if (material.roughness !== undefined) material.roughness = 1;
  if (material.clearcoat !== undefined) material.clearcoat = 0;
  if (material.sheen !== undefined) material.sheen = 0;
  if (material.specularIntensity !== undefined) material.specularIntensity = 0;

  /* Inject AFTER the original chunk so we don't have to rebuild it ourselves; we just
   * re-derive lightMapIrradiance from the same texel and OVERWRITE the contribution
   * the original chunk added (subtract the flat add, add the remapped one).
   * This is robust against three rev changes — only depends on chunk variable names
   * `irradiance`, `lightMap`, `vLightMapUv`, `lightMapIntensity` which are stable.
   */
  material.userData.lmRemap = { gamma: LM_GAMMA, contrast: LM_CONTRAST, mid: LM_MID };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLmGamma = { value: LM_GAMMA };
    shader.uniforms.uLmContrast = { value: LM_CONTRAST };
    shader.uniforms.uLmMid = { value: LM_MID };

    shader.fragmentShader =
      `uniform float uLmGamma;\nuniform float uLmContrast;\nuniform float uLmMid;\n` +
      shader.fragmentShader.replace(
        "#include <lights_fragment_maps>",
        `
        #include <lights_fragment_maps>
        #ifdef USE_LIGHTMAP
          {
            vec4 _lmTex = texture2D( lightMap, vLightMapUv );
            vec3 _flat = _lmTex.rgb * lightMapIntensity;
            vec3 _lm = max(_lmTex.rgb, vec3(0.0));
            _lm = pow(_lm, vec3(uLmGamma));
            _lm = (_lm - vec3(uLmMid)) * uLmContrast + vec3(uLmMid);
            _lm = max(_lm, vec3(0.0));
            vec3 _remapped = _lm * lightMapIntensity;
            irradiance += (_remapped - _flat);
          }
        #endif
        `,
      );
    material.userData.shader = shader;
    if (!applyLightmapForBakedView._loggedShader) {
      applyLightmapForBakedView._loggedShader = true;
      console.info(
        `[brutalistVR6] Lightmap remap shader injected (gamma=${LM_GAMMA}, contrast=${LM_CONTRAST}, mid=${LM_MID}, scale=${LM_SCALE}). Tune via ?lmgamma=… &lmcontrast=… &lmmid=… &lmscale=…`,
      );
    }
  };

  material.needsUpdate = true;
}

function createDebugTexture(mesh, size) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "black";
  ctx.fillRect(0, 0, size, size);
  const geometry = mesh.geometry;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uvs = getLightmapUVs(geometry);
  const index = geometry.index;
  if (!uvs || !normals) {
    const emptyTex = new THREE.CanvasTexture(canvas);
    emptyTex.flipY = true;
    emptyTex.colorSpace = THREE.SRGBColorSpace;
    configureLightmapCanvasTexture(emptyTex);
    return emptyTex;
  }
  mesh.updateMatrixWorld(true);
  const triangleCount = index ? index.count / 3 : positions.count / 3;
  for (let t = 0; t < triangleCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const nx = normals.getX(i0);
    const ny = normals.getY(i0);
    const nz = normals.getZ(i0);
    let faceIdx = 0;
    if (nx > 0.5) faceIdx = 0;
    else if (nx < -0.5) faceIdx = 1;
    else if (ny > 0.5) faceIdx = 2;
    else if (ny < -0.5) faceIdx = 3;
    else if (nz > 0.5) faceIdx = 4;
    else if (nz < -0.5) faceIdx = 5;
    const color = FACE_COLORS[faceIdx];
    const uv0 = { x: uvs.getX(i0), y: uvs.getY(i0) };
    const uv1 = { x: uvs.getX(i1), y: uvs.getY(i1) };
    const uv2 = { x: uvs.getX(i2), y: uvs.getY(i2) };
    ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
    ctx.beginPath();
    ctx.moveTo(uv0.x * size, (1 - uv0.y) * size);
    ctx.lineTo(uv1.x * size, (1 - uv1.y) * size);
    ctx.lineTo(uv2.x * size, (1 - uv2.y) * size);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.strokeStyle = "yellow";
  ctx.lineWidth = 2;
  for (let col = 0; col <= 3; col++) {
    ctx.beginPath();
    ctx.moveTo((col * size) / 3, 0);
    ctx.lineTo((col * size) / 3, size);
    ctx.stroke();
  }
  for (let row = 0; row <= 2; row++) {
    ctx.beginPath();
    ctx.moveTo(0, (row * size) / 2);
    ctx.lineTo(size, (row * size) / 2);
    ctx.stroke();
  }
  ctx.fillStyle = "white";
  ctx.font = "20px Arial";
  ctx.textAlign = "center";
  const labels = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"];
  for (let i = 0; i < 6; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    ctx.fillText(labels[i], (col + 0.5) * (size / 3), (row + 0.5) * (size / 2));
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  configureLightmapCanvasTexture(texture);
  return texture;
}

function applyDebugTextures() {
  isUv2CheckerActive = false;
  const uvb = document.getElementById("uv2CheckerBtn");
  if (uvb) uvb.textContent = "Test UV2 (checker)";
  for (const obj of sceneObjects) {
    if (obj.userData.skipBake) continue;
    const debugTex = createDebugTexture(obj, LIGHTMAP_SIZE);
    obj.userData.debugTexture = debugTex;
    /* lightMap uses uv2 — same channel the bake rasterizes; BasicMaterial.map would use uv and look broken. */
    obj.userData.debugMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0,
      roughness: 1,
      envMapIntensity: 1,
      lightMap: debugTex,
      lightMapIntensity: 1,
    });
    obj.material = obj.userData.debugMaterial;
  }
  isDebugMode = true;
  setStatus("DEBUG: Colored UV faces (lightmap UVs)");
  const db = document.getElementById("debugBtn");
  if (db) db.textContent = "Debug Mode ON";
  pathTracer.reset();
}

let uv2CheckerTexture = null;

function getUv2CheckerTexture() {
  if (uv2CheckerTexture) return uv2CheckerTexture;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d");
  const cells = 16;
  const s = 256 / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 ? "#d8d8d8" : "#383838";
      ctx.fillRect(x * s, y * s, s, s);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(12, 12);
  t.colorSpace = THREE.SRGBColorSpace;
  configureLightmapCanvasTexture(t);
  uv2CheckerTexture = t;
  return uv2CheckerTexture;
}

function toggleUv2Checker() {
  isUv2CheckerActive = !isUv2CheckerActive;
  const btn = document.getElementById("uv2CheckerBtn");
  const db = document.getElementById("debugBtn");
  if (isUv2CheckerActive) {
    isDebugMode = false;
    if (db) db.textContent = "Debug UV Colors";
    const chk = getUv2CheckerTexture();
    for (const obj of sceneObjects) {
      if (obj.userData.skipBake || !obj.geometry?.attributes.uv2) continue;
      obj.material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0,
        roughness: 0.95,
        envMapIntensity: 1.05,
        lightMap: chk,
        lightMapIntensity: 1.35,
      });
    }
    if (btn) btn.textContent = "UV2 checker ON (click to off)";
    setStatus(
      "UV2 test: lightMap uses uv2. Each box face should show a steady checker in its atlas cell; only triangle split is the quad diagonal.",
    );
  } else {
    for (const obj of sceneObjects) {
      if (obj.userData.originalMaterial) obj.material = obj.userData.originalMaterial;
    }
    if (btn) btn.textContent = "Test UV2 (checker)";
    setStatus("UV2 checker off.");
  }
  pathTracer.reset();
}

const MULTIVIEW_RASTER_YIELD_STRIDE = 1800;

async function rasterizeTriangleMultiViewAsync(
  meshName,
  triIndex,
  triTotal,
  uv0,
  uv1,
  uv2,
  p0,
  p1,
  p2,
  normal,
  lmData,
  visMap,
  size,
  report,
) {
  const minU = Math.max(0, Math.floor(Math.min(uv0.x, uv1.x, uv2.x) * size) - 1);
  const maxU = Math.min(size - 1, Math.ceil(Math.max(uv0.x, uv1.x, uv2.x) * size) + 1);
  const minV = Math.max(0, Math.floor(Math.min(uv0.y, uv1.y, uv2.y) * size) - 1);
  const maxV = Math.min(size - 1, Math.ceil(Math.max(uv0.y, uv1.y, uv2.y) * size) + 1);
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  let examined = 0;
  const rowSpan = Math.max(1, maxV - minV + 1);
  for (let py = minV; py <= maxV; py++) {
    for (let px = minU; px <= maxU; px++) {
      examined++;
      const u = (px + 0.5) / size;
      const v = (py + 0.5) / size;
      const bary = barycentric(u, v, uv0, uv1, uv2);
      if (bary.x < -0.01 || bary.y < -0.01 || bary.z < -0.01) {
        if (examined % MULTIVIEW_RASTER_YIELD_STRIDE === 0) {
          const local = (py - minV + (px - minU + 1) / Math.max(1, maxU - minU + 1)) / rowSpan;
          const sub = ((triIndex + Math.max(0, Math.min(1, local))) / triTotal) * 100;
          if (report) report(sub, `${meshName} · tri ${triIndex + 1}/${triTotal} (UV raster)`);
          await yieldToPaint();
        }
        continue;
      }
      const worldPos = tmp
        .copy(p0)
        .multiplyScalar(bary.x)
        .addScaledVector(p1, bary.y)
        .addScaledVector(p2, bary.z);
      let bestVisibility = 0;
      let bestColor = null;
      for (const capture of multiViewCaptures) {
        const toCamera = tmp2.subVectors(capture.camPos, worldPos).normalize();
        const visibility = Math.max(0, normal.dot(toCamera));
        if (visibility <= 0.34) continue;
        if (sceneBVH) {
          const distToCamera = worldPos.distanceTo(capture.camPos);
          const rayDir = toCamera.clone().negate();
          const rayOrigin = capture.camPos.clone();
          const hit = sceneBVH.raycastFirst(new THREE.Ray(rayOrigin, rayDir));
          if (hit) {
            const occlusionMargin = Math.max(0.1, distToCamera * 0.01);
            if (hit.distance < distToCamera - occlusionMargin) continue;
          }
        }
        const viewPos = worldPos.clone();
        viewPos.applyMatrix4(capture.camMatrix);
        viewPos.applyMatrix4(capture.projMatrix);
        if (viewPos.z > 1 || viewPos.z < -1) continue;
        const srcX = Math.floor((viewPos.x * 0.5 + 0.5) * capture.width);
        const srcY = Math.floor((1 - (viewPos.y * 0.5 + 0.5)) * capture.height);
        if (srcX < 0 || srcX >= capture.width || srcY < 0 || srcY >= capture.height) continue;
        const centerWeight = 1 - Math.max(Math.abs(viewPos.x), Math.abs(viewPos.y)) * 0.3;
        const weightedVis = visibility * centerWeight;
        if (weightedVis > bestVisibility) {
          bestVisibility = weightedVis;
          const srcIdx = (srcY * capture.width + srcX) * 4;
          bestColor = {
            r: capture.srcData.data[srcIdx],
            g: capture.srcData.data[srcIdx + 1],
            b: capture.srcData.data[srcIdx + 2],
          };
        }
      }
      if (bestColor && bestVisibility > 0) {
        const flippedPy = size - 1 - py;
        const lmIdx = (flippedPy * size + px) * 4;
        const visIdx = flippedPy * size + px;
        if (bestVisibility > visMap[visIdx]) {
          lmData.data[lmIdx] = bestColor.r;
          lmData.data[lmIdx + 1] = bestColor.g;
          lmData.data[lmIdx + 2] = bestColor.b;
          lmData.data[lmIdx + 3] = 255;
          visMap[visIdx] = bestVisibility;
        }
      }
      if (examined % MULTIVIEW_RASTER_YIELD_STRIDE === 0) {
        const local = (py - minV + (px - minU + 1) / Math.max(1, maxU - minU + 1)) / rowSpan;
        const sub = ((triIndex + Math.max(0, Math.min(1, local))) / triTotal) * 100;
        if (report) report(sub, `${meshName} · tri ${triIndex + 1}/${triTotal} (UV raster)`);
        await yieldToPaint();
      }
    }
  }
}

/**
 * @param {(subPct: number, line: string) => void} [report] subPct 0–100 within this mesh
 */
async function bakeObjectMultiViewAsync(mesh, size, report) {
  const lmCanvas = document.createElement("canvas");
  lmCanvas.width = size;
  lmCanvas.height = size;
  const lmCtx = lmCanvas.getContext("2d");
  const lmImageData = lmCtx.createImageData(size, size);
  const visibilityMap = new Float32Array(size * size);
  for (let i = 0; i < lmImageData.data.length; i += 4) {
    lmImageData.data[i] = 0;
    lmImageData.data[i + 1] = 0;
    lmImageData.data[i + 2] = 0;
    lmImageData.data[i + 3] = 0;
  }
  mesh.updateMatrixWorld(true);
  const geometry = mesh.geometry;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uvs = getLightmapUVs(geometry);
  const index = geometry.index;
  if (!uvs || !normals) {
    lmCtx.putImageData(lmImageData, 0, 0);
    const tex = new THREE.CanvasTexture(lmCanvas);
    tex.flipY = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    configureLightmapCanvasTexture(tex);
    return tex;
  }
  const triangleCount = index ? index.count / 3 : positions.count / 3;
  const uv0 = new THREE.Vector2();
  const uv1 = new THREE.Vector2();
  const uv2 = new THREE.Vector2();
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let t = 0; t < triangleCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    uv0.set(uvs.getX(i0), uvs.getY(i0));
    uv1.set(uvs.getX(i1), uvs.getY(i1));
    uv2.set(uvs.getX(i2), uvs.getY(i2));
    p0.set(positions.getX(i0), positions.getY(i0), positions.getZ(i0)).applyMatrix4(mesh.matrixWorld);
    p1.set(positions.getX(i1), positions.getY(i1), positions.getZ(i1)).applyMatrix4(mesh.matrixWorld);
    p2.set(positions.getX(i2), positions.getY(i2), positions.getZ(i2)).applyMatrix4(mesh.matrixWorld);
    n.set(normals.getX(i0), normals.getY(i0), normals.getZ(i0));
    n.applyMatrix4(new THREE.Matrix4().extractRotation(mesh.matrixWorld)).normalize();
    await rasterizeTriangleMultiViewAsync(
      mesh.name,
      t,
      triangleCount,
      uv0,
      uv1,
      uv2,
      p0,
      p1,
      p2,
      n,
      lmImageData,
      visibilityMap,
      size,
      report,
    );
  }
  if (report) report(92, `${mesh.name} · dilate`);
  await yieldToPaint();
  dilatePixels(lmImageData, size, 10);
  if (report) report(98, `${mesh.name} · finalize`);
  await yieldToPaint();
  lmCtx.putImageData(lmImageData, 0, 0);
  const texture = new THREE.CanvasTexture(lmCanvas);
  texture.flipY = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  configureLightmapCanvasTexture(texture);
  return texture;
}

/**
 * Build an unlit `MeshBasicMaterial` clone of the original colour. Used in baked view
 * for meshes that don't yet have a lightmap (e.g. ground from older saves baked before
 * `PlaneGeometry` support landed). With `?hdr=0`, a regular PBR material would render
 * black — the unlit fallback at least shows the diffuse colour at full brightness.
 */
function makeUnlitFallbackMaterial(orig) {
  const color = orig.color ? orig.color.clone() : new THREE.Color(0xcccccc);
  return new THREE.MeshBasicMaterial({
    color,
    map: orig.map ?? null,
    toneMapped: true,
  });
}

function applyBakedMaterials() {
  const stats = { lightmap: [], unlit: [], skipped: [] };
  for (const obj of sceneObjects) {
    const tex = obj.userData.lightmapTexture;
    const orig = obj.userData.originalMaterial;
    if (!orig) {
      stats.skipped.push(obj.name);
      continue;
    }
    if (tex) {
      const m = orig.clone();
      applyLightmapForBakedView(m, tex);
      obj.material = m;
      stats.lightmap.push(obj.name);
    } else {
      obj.material = makeUnlitFallbackMaterial(orig);
      stats.unlit.push(obj.name);
    }
  }
  console.info(
    `[brutalistVR6] applyBakedMaterials: lightmap=${JSON.stringify(stats.lightmap)} unlit=${JSON.stringify(stats.unlit)} skipped=${JSON.stringify(stats.skipped)}`,
  );
  isPreviewMode = true;
  setStatus("Showing baked (lightMap · IBL off so bake shadows are visible)");
}

function togglePreview() {
  isPreviewMode = !isPreviewMode;
  if (isPreviewMode) {
    isUv2CheckerActive = false;
    const uvb = document.getElementById("uv2CheckerBtn");
    if (uvb) uvb.textContent = "Test UV2 (checker)";
  }
  for (const obj of sceneObjects) {
    const orig = obj.userData.originalMaterial;
    if (!orig) continue;
    if (isPreviewMode) {
      if (obj.userData.lightmapTexture) {
        const m = orig.clone();
        applyLightmapForBakedView(m, obj.userData.lightmapTexture);
        obj.material = m;
      } else {
        obj.material = makeUnlitFallbackMaterial(orig);
      }
    } else {
      obj.material = orig;
    }
  }
  setStatus(isPreviewMode ? "Showing baked" : "Path tracing (three-gpu-pathtracer)");
  if (!isPreviewMode) pathTracer.reset();
}

/* Export every baked lightmap as a PNG download. Verbose on purpose: meshes that
 * have no lightmap (never baked, partial bake, IDB save failed, …) get reported
 * separately so it's obvious why N PNGs downloaded instead of M. */
async function exportTextures() {
  const exported = [];
  const skipped = [];
  for (const obj of sceneObjects) {
    const tex = obj.userData.lightmapTexture;
    if (!tex) {
      skipped.push({ mesh: obj.name, reason: "no lightmap (not baked / not imported)" });
      continue;
    }
    if (!tex.image?.toDataURL) {
      skipped.push({ mesh: obj.name, reason: "lightmap image has no toDataURL (unexpected texture source)" });
      continue;
    }
    try {
      const link = document.createElement("a");
      link.download = `lightmap_${obj.name}.png`;
      link.href = tex.image.toDataURL("image/png");
      document.body.appendChild(link);
      link.click();
      link.remove();
      exported.push(obj.name);
      /* small gap between downloads — Chrome bundles multiple downloads, but
       * Firefox/Safari can drop trailing ones if click()s arrive in one tick. */
      await new Promise((r) => setTimeout(r, 60));
    } catch (e) {
      skipped.push({ mesh: obj.name, reason: `toDataURL/click failed: ${e?.message || e}` });
    }
  }
  console.info(
    `[brutalistVR6] exportTextures: downloaded ${exported.length}/${sceneObjects.length} PNG(s): ${JSON.stringify(exported)}`,
  );
  if (skipped.length) {
    console.warn(
      `[brutalistVR6] exportTextures: skipped ${skipped.length} mesh(es) — bake them, or import a PNG, then re-export:`,
    );
    console.table(skipped);
    setStatus(
      `Exported ${exported.length}/${sceneObjects.length} lightmap PNG(s). Missing: ${skipped.map((s) => s.mesh).join(", ")}`,
    );
  } else {
    setStatus(`Exported ${exported.length}/${sceneObjects.length} lightmap PNG(s).`);
  }
}

/**
 * Lowercase token list, splitting on:
 *   - camelCase boundaries (`wallNorth` → `wall north`),
 *   - non-alphanumerics (`fin-0`, `fin_0`, `fin 0` all → `fin 0`),
 *   - letter↔digit boundaries (`fin0` → `fin 0`, `slab12` → `slab 12`).
 * Words like `lightmap`, `bake`, `tex`, `texture`, `uv`, `uv2`, `map` are dropped
 * as filler so they don't dilute the score.
 */
const FILLER_TOKENS = new Set([
  "lightmap",
  "lightmaps",
  "bake",
  "baked",
  "tex",
  "texture",
  "textures",
  "map",
  "maps",
  "uv",
  "uv2",
  "img",
  "image",
]);
function tokenize(s) {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}
function nonFillerTokens(tokens) {
  return tokens.filter((t) => !FILLER_TOKENS.has(t));
}

/** Score in [0, 1.5]: 1.0 = every mesh-name token is found in the file tokens; bonus for shorter, more-specific mesh names. */
function scoreFileToMesh(fileTokens, meshTokens) {
  if (meshTokens.length === 0 || fileTokens.length === 0) return 0;
  let matched = 0;
  let partial = 0;
  for (const mt of meshTokens) {
    if (fileTokens.includes(mt)) matched++;
    else if (fileTokens.some((ft) => ft.length >= 3 && (ft.startsWith(mt) || mt.startsWith(ft))))
      partial++;
  }
  const completeness = (matched + 0.5 * partial) / meshTokens.length;
  /* Specificity bonus: if "fin" appears in many mesh names, a file with token "fin"
   * shouldn't auto-pick the first one — the bonus prefers meshes whose tokens are
   * ALL present in the file (rewards "fin_0" over generic "fin"). */
  const specificity = matched === meshTokens.length ? 0.2 : 0;
  return completeness + specificity;
}

const AUTO_MATCH_THRESHOLD = 0.6;

/**
 * Bulk auto-matcher: scores every (file, mesh) pair, then greedily assigns each
 * file to its highest-scoring unique mesh above the threshold. Dedup ensures two
 * files won't auto-match to the same mesh — the loser falls back to "(skip)" in
 * the dialog so the user resolves the conflict.
 *
 * @param {Array<{name: string}>} files
 * @returns {Array<{candidate: string, match: string|null, score: number}>}
 */
function autoMatchFiles(files) {
  const meshIndex = sceneObjects.map((o) => ({
    name: o.name,
    tokens: nonFillerTokens(tokenize(o.name)),
  }));
  const fileTokens = files.map((f) => {
    const stem = f.name.replace(/\.(png|jpe?g|webp)$/i, "");
    return { stem, tokens: nonFillerTokens(tokenize(stem)) };
  });
  const candidates = [];
  fileTokens.forEach((ft, fileIdx) => {
    meshIndex.forEach((m) => {
      const score = scoreFileToMesh(ft.tokens, m.tokens);
      if (score > 0) candidates.push({ fileIdx, meshName: m.name, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score);
  const fileMatch = files.map(() => ({ match: null, score: 0 }));
  const usedMeshes = new Set();
  for (const { fileIdx, meshName, score } of candidates) {
    if (fileMatch[fileIdx].match) continue;
    if (usedMeshes.has(meshName)) continue;
    if (score < AUTO_MATCH_THRESHOLD) continue;
    fileMatch[fileIdx] = { match: meshName, score };
    usedMeshes.add(meshName);
  }
  return files.map((_, i) => ({
    candidate: fileTokens[i].tokens.join(" ") || fileTokens[i].stem,
    match: fileMatch[i].match,
    score: fileMatch[i].score,
  }));
}

/** Decode an image File into an HTMLCanvasElement (full-resolution copy). */
function decodeImageToCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

/**
 * Show a modal listing every imported file with a dropdown of mesh names.
 * Auto-match is pre-selected; the user can pin or change anything before applying.
 * Resolves with `[{ canvas, meshName }]` for accepted rows (the `(skip)` entries
 * are filtered out), or `null` if the user cancels.
 *
 * @param {Array<{file: File, canvas: HTMLCanvasElement, candidate: string, match: string|null}>} entries
 */
function showLightmapImportDialog(entries) {
  return new Promise((resolve) => {
    const dlg = document.getElementById("importDlg");
    const rowsEl = document.getElementById("importDlgRows");
    const applyBtn = document.getElementById("importDlgApply");
    const cancelBtn = document.getElementById("importDlgCancel");
    if (!dlg || !rowsEl || !applyBtn || !cancelBtn) {
      resolve(null);
      return;
    }
    rowsEl.innerHTML = "";
    const meshNames = sceneObjects.map((o) => o.name);
    const meshesMissingTexture = sceneObjects
      .filter((o) => !o.userData.lightmapTexture)
      .map((o) => o.name);
    /* Update the dialog hint to surface what the user still needs to provide.
     * Without this the only clue is the "— has texture" suffix buried in each
     * dropdown, so it's not obvious which meshes still need a PNG. */
    const hintEl = document.getElementById("importDlgHint");
    if (hintEl) {
      const base =
        "Auto-matched rows are pre-selected; pin the rest manually. Choose <em>(skip)</em> to ignore a file.";
      if (meshesMissingTexture.length === 0) {
        hintEl.innerHTML = `${base}<br><span style="color:#7ec97e">All ${meshNames.length} meshes already have a lightmap.</span>`;
      } else {
        hintEl.innerHTML = `${base}<br><span style="color:#ffb347">Still missing a lightmap (${meshesMissingTexture.length}/${meshNames.length}):</span> <code style="color:#ffb347">${meshesMissingTexture.join(", ")}</code>`;
      }
    }
    const optsHtml =
      `<option value="">(skip)</option>` +
      meshNames
        .map((n) => {
          const has = sceneObjects.find((o) => o.name === n)?.userData.lightmapTexture
            ? " — has texture"
            : " — MISSING";
          return `<option value="${n}">${n}${has}</option>`;
        })
        .join("");
    const rowEls = entries.map((entry, i) => {
      const row = document.createElement("div");
      row.className = "row" + (entry.match ? "" : " unmatched");
      const thumb = document.createElement("img");
      thumb.src = entry.canvas.toDataURL("image/png");
      const info = document.createElement("div");
      info.innerHTML = `<div class="fname">${entry.file.name}</div><div class="fmeta">parsed: <code>${entry.candidate}</code> · ${entry.canvas.width}×${entry.canvas.height}</div>`;
      const select = document.createElement("select");
      select.innerHTML = optsHtml;
      select.value = entry.match || "";
      select.dataset.idx = String(i);
      row.append(thumb, info, select);
      rowsEl.append(row);
      return select;
    });
    const cleanup = (out) => {
      dlg.classList.remove("active");
      applyBtn.removeEventListener("click", onApply);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(out);
    };
    const onApply = () => {
      const out = [];
      rowEls.forEach((sel, i) => {
        if (sel.value) out.push({ canvas: entries[i].canvas, meshName: sel.value, file: entries[i].file });
      });
      cleanup(out);
    };
    const onCancel = () => cleanup(null);
    applyBtn.addEventListener("click", onApply);
    cancelBtn.addEventListener("click", onCancel);
    dlg.classList.add("active");
  });
}

/** Wrap a decoded canvas into a lightmap-ready CanvasTexture and assign it. */
function assignCanvasAsLightmap(canvas, meshName) {
  const obj = sceneObjects.find((o) => o.name === meshName);
  if (!obj) return false;
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  configureLightmapCanvasTexture(tex);
  obj.userData.lightmapTexture = tex;
  return true;
}

/**
 * Top-level import: decode every chosen file once, show the mapping dialog so the
 * user can confirm/override every assignment (auto-match is pre-selected), then
 * apply the chosen mappings, refresh baked materials, and persist to IndexedDB.
 */
async function importLightmapFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return [];
  setStatus(`Decoding ${files.length} file(s)…`);
  const matches = autoMatchFiles(files);
  const entries = [];
  const decodeFails = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const canvas = await decodeImageToCanvas(file);
      entries.push({
        file,
        canvas,
        candidate: matches[i].candidate,
        match: matches[i].match,
        score: matches[i].score,
      });
    } catch (e) {
      decodeFails.push({ file: file.name, reason: "decode failed" });
    }
  }
  console.table(
    entries.map((e) => ({
      file: e.file.name,
      parsed: e.candidate,
      auto_match: e.match || "(unmatched)",
      score: e.score.toFixed(2),
      size: `${e.canvas.width}×${e.canvas.height}`,
    })),
  );
  if (decodeFails.length) console.warn("[brutalistVR6] decode failures:", decodeFails);
  if (entries.length === 0) {
    setStatus("No files could be decoded.");
    return [];
  }
  setStatus(`Map ${entries.length} file(s) to meshes…`);
  const mappings = await showLightmapImportDialog(entries);
  if (!mappings || mappings.length === 0) {
    setStatus("Import cancelled.");
    return [];
  }
  const applied = [];
  for (const { canvas, meshName, file } of mappings) {
    if (assignCanvasAsLightmap(canvas, meshName)) applied.push({ file: file.name, mesh: meshName });
  }
  console.info("[brutalistVR6] importLightmapFiles applied:");
  console.table(applied);
  if (applied.length > 0) {
    isBaked = true;
    applyBakedMaterials();
    const p = document.getElementById("previewBtn");
    const e = document.getElementById("exportBtn");
    if (p) p.style.display = "block";
    if (e) e.style.display = "block";
    await saveBakedTextures();
  }
  /* Post-import accounting: explicitly tell the user which scene meshes still
   * have no lightmap, so it's obvious what to upload next instead of having to
   * read every dropdown in the import dialog. */
  const stillMissing = sceneObjects.filter((o) => !o.userData.lightmapTexture).map((o) => o.name);
  if (stillMissing.length === 0) {
    console.info(`[brutalistVR6] importLightmapFiles: all ${sceneObjects.length} meshes now have a lightmap.`);
    setStatus(`Imported ${applied.length}/${files.length} lightmap(s). All meshes covered.`);
  } else {
    console.warn(
      `[brutalistVR6] importLightmapFiles: ${stillMissing.length}/${sceneObjects.length} mesh(es) still without a lightmap — upload PNGs for: ${JSON.stringify(stillMissing)}`,
    );
    setStatus(
      `Imported ${applied.length}/${files.length} lightmap(s). Still missing: ${stillMissing.join(", ")}`,
    );
  }
  return applied;
}

/** Promise wrapper around `canvas.toBlob` — needed because IDB stores `Blob`s, not dataURLs. */
function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (!canvas?.toBlob) {
      reject(new Error("canvas.toBlob is not available on this image"));
      return;
    }
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob returned null"))), "image/png");
  });
}

/** Decode a `Blob` into a fresh `<canvas>` we can wrap in a `CanvasTexture`. */
async function blobToLightmapCanvas(blob) {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close?.();
      return c;
    } catch (_) {
      /* fall through to <img> path */
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      c.getContext("2d").drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = (e) => {
      URL.revokeObjectURL(url);
      reject(e);
    };
    img.src = url;
  });
}

/**
 * Persist every mesh's baked lightmap to IndexedDB as a PNG `Blob`, keyed by
 * `obj.name`. We moved off `localStorage` because (1) its ~5 MB per-origin cap
 * doesn't fit 14–15 lightmaps once 1-bounce indirect adds detail and (2) base64
 * inflation costs another 33 %. IDB stores raw bytes and the quota is hundreds
 * of MB to GB depending on free disk. Per-key `put`s mean a single failure no
 * longer rolls back the whole save.
 */
async function saveBakedTextures() {
  const breakdown = [];
  let total = 0;
  let savedCount = 0;
  let firstError = null;
  for (const obj of sceneObjects) {
    const tex = obj.userData.lightmapTexture;
    if (!tex?.image?.toBlob) {
      breakdown.push(`${obj.name}: NO TEXTURE`);
      continue;
    }
    try {
      const blob = await canvasToPngBlob(tex.image);
      await idbPut(obj.name, blob);
      breakdown.push(`${obj.name}: ${(blob.size / 1024).toFixed(1)} KB`);
      total += blob.size;
      savedCount++;
    } catch (e) {
      breakdown.push(`${obj.name}: SAVE FAILED (${e?.message || e})`);
      console.warn(`[brutalistVR6] saveBakedTextures: "${obj.name}" failed:`, e);
      if (!firstError) firstError = e;
    }
  }
  const est = await idbEstimateMB();
  const quotaLine = est
    ? ` · IDB usage ${est.usageMB.toFixed(1)}/${est.quotaMB.toFixed(0)} MB`
    : "";
  console.info(
    `[brutalistVR6] Saved ${savedCount} lightmap(s) to IndexedDB (${(total / 1024 / 1024).toFixed(2)} MB${quotaLine}):\n  - ${breakdown.join("\n  - ")}`,
  );
  if (firstError) {
    setStatus(`Bake save partial: ${firstError?.message || firstError}`);
    return false;
  }
  return savedCount > 0;
}

/**
 * Load lightmaps from IndexedDB and attach them to matching scene meshes.
 * @param {{ quiet?: boolean }} [opts] if quiet, skip status text (caller sets message)
 */
async function loadBakedTexturesFromIDB(opts = {}) {
  const quiet = opts.quiet === true;
  let savedNames;
  try {
    savedNames = await idbKeys();
  } catch (e) {
    console.warn("[brutalistVR6] loadBakedTexturesFromIDB: IDB unavailable:", e);
    return false;
  }
  if (savedNames.length === 0) {
    if (!quiet) console.info("[brutalistVR6] loadBakedTexturesFromIDB: store empty");
    return false;
  }
  const sceneNames = sceneObjects.map((o) => o.name || "<unnamed>");
  console.info(
    `[brutalistVR6] loadBakedTexturesFromIDB:\n  saved (${savedNames.length}): ${JSON.stringify(savedNames)}\n  scene (${sceneNames.length}): ${JSON.stringify(sceneNames)}`,
  );
  const matched = savedNames.filter((n) => sceneObjects.some((o) => o.name === n));
  const orphanedSaves = savedNames.filter((n) => !sceneObjects.some((o) => o.name === n));
  const unmatchedScene = sceneNames.filter((n) => !savedNames.includes(n));
  if (orphanedSaves.length)
    console.warn(`[brutalistVR6] saved textures with no matching mesh: ${JSON.stringify(orphanedSaves)}`);
  if (unmatchedScene.length)
    console.warn(`[brutalistVR6] meshes with no saved texture: ${JSON.stringify(unmatchedScene)}`);
  if (matched.length === 0) return false;
  const loaded = [];
  const failed = [];
  for (const obj of sceneObjects) {
    if (!savedNames.includes(obj.name)) continue;
    try {
      const blob = await idbGet(obj.name);
      if (!blob) {
        failed.push(obj.name);
        continue;
      }
      const canvas = await blobToLightmapCanvas(blob);
      const texture = new THREE.CanvasTexture(canvas);
      texture.flipY = true;
      texture.colorSpace = THREE.SRGBColorSpace;
      configureLightmapCanvasTexture(texture);
      obj.userData.lightmapTexture = texture;
      loaded.push(obj.name);
    } catch (e) {
      console.error(`[brutalistVR6] image decode failed for "${obj.name}":`, e);
      failed.push(obj.name);
    }
  }
  console.info(
    `[brutalistVR6] loadBakedTexturesFromIDB done — applied: ${JSON.stringify(loaded)}; failed: ${JSON.stringify(failed)}`,
  );
  if (loaded.length === 0) return false;
  isBaked = true;
  applyBakedMaterials();
  const appliedNames = sceneObjects.filter((o) => o.userData.lightmapTexture).map((o) => o.name);
  console.info(
    `[brutalistVR6] applyBakedMaterials: ${appliedNames.length} of ${sceneObjects.length} meshes have a lightmap texture: ${JSON.stringify(appliedNames)}`,
  );
  const p = document.getElementById("previewBtn");
  const e = document.getElementById("exportBtn");
  if (p) p.style.display = "block";
  if (e) e.style.display = "block";
  if (!quiet) setStatus(`Loaded ${loaded.length}/${matched.length} baked textures`);
  return true;
}

/**
 * One-shot migrator: pull a legacy `localStorage` payload (current or older key)
 * into IndexedDB so existing users don't lose their previous bakes when they
 * pick up this build. Each entry is decoded back into a `Blob` via `fetch` on
 * the dataURL — that's the cleanest dataURL→Blob path that doesn't reach for
 * `atob` and manual `Uint8Array` plumbing. Returns the number of entries
 * written. The original `localStorage` key is removed on success so we don't
 * trip the quota again next time someone calls `saveBakedTextures`.
 */
async function migrateLegacyToIDB(storageKey) {
  let raw;
  try {
    raw = localStorage.getItem(storageKey);
  } catch (e) {
    console.warn(`[brutalistVR6] migrateLegacyToIDB: localStorage read failed for "${storageKey}":`, e);
    return 0;
  }
  if (!raw) return 0;
  let textureData;
  try {
    textureData = JSON.parse(raw);
  } catch (e) {
    console.warn(`[brutalistVR6] migrateLegacyToIDB: bad JSON at "${storageKey}":`, e);
    return 0;
  }
  const names = Object.keys(textureData);
  if (names.length === 0) return 0;
  let existing;
  try {
    existing = new Set(await idbKeys());
  } catch (_) {
    existing = new Set();
  }
  let written = 0;
  for (const name of names) {
    if (existing.has(name)) continue;
    try {
      const res = await fetch(textureData[name]);
      const blob = await res.blob();
      await idbPut(name, blob);
      written++;
    } catch (e) {
      console.warn(`[brutalistVR6] migrateLegacyToIDB: "${name}" from "${storageKey}":`, e);
    }
  }
  if (written > 0) {
    console.info(`[brutalistVR6] migrated ${written} lightmap(s) from "${storageKey}" → IndexedDB`);
    try {
      localStorage.removeItem(storageKey);
    } catch (_) {
      /* ignore — best-effort cleanup */
    }
  }
  return written;
}

/**
 * Try to load prebaked lightmaps that ship with the deployment from
 * `./lightmaps/lightmap_<meshName>.png`. Each fetch is independent — a
 * 404 just leaves that mesh unbaked, so partial bundles are fine.
 * Returns true if at least one file loaded (and applies baked materials).
 */
async function loadPrebakedTextures() {
  const baseUrl = "./lightmaps/";
  const loaded = [];
  const missing = [];
  await Promise.all(
    sceneObjects.map(async (obj) => {
      const url = `${baseUrl}lightmap_${obj.name}.png`;
      try {
        const resp = await fetch(url);
        if (!resp.ok) { missing.push(obj.name); return; }
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
        const tex = new THREE.CanvasTexture(canvas);
        tex.flipY = true;
        tex.colorSpace = THREE.SRGBColorSpace;
        configureLightmapCanvasTexture(tex);
        obj.userData.lightmapTexture = tex;
        loaded.push(obj.name);
      } catch (_) {
        missing.push(obj.name);
      }
    }),
  );
  if (loaded.length === 0) {
    console.info("[brutalistVR6] loadPrebakedTextures: no PNGs in ./lightmaps/");
    return false;
  }
  console.info(
    `[brutalistVR6] loadPrebakedTextures: ${loaded.length}/${sceneObjects.length} loaded · missing: ${JSON.stringify(missing)}`,
  );
  applyBakedMaterials();
  return true;
}

/**
 * Restore baked lightmaps on page load. Order:
 *   1. Static prebake bundle (if any).
 *   2. Migrate any leftover `localStorage` payloads (current + legacy keys) into
 *      IndexedDB. This is a one-time hop for users coming from the old code path
 *      — the entries are unpacked and the localStorage key is removed.
 *   3. Load from IndexedDB.
 */
async function restoreBakedTexturesIfSaved() {
  if (await loadPrebakedTextures()) return { ok: true, migrated: false, key: "prebaked" };
  let totalMigrated = 0;
  for (const key of [STORAGE_KEY, ...LEGACY_BAKE_STORAGE_KEYS]) {
    try {
      totalMigrated += await migrateLegacyToIDB(key);
    } catch (e) {
      console.warn(`[brutalistVR6] restore: migrate from "${key}" failed:`, e);
    }
  }
  const ok = await loadBakedTexturesFromIDB({ quiet: true });
  if (ok) return { ok: true, migrated: totalMigrated > 0, key: "indexedDB" };
  return { ok: false, migrated: false, key: null };
}

function setupBakeView(viewIndex) {
  const view = BAKE_VIEWS[viewIndex];
  cameraRig.position.set(0, 0, 0);
  camera.position.set(view.pos[0], view.pos[1], view.pos[2]);
  camera.lookAt(view.target[0], view.target[1], view.target[2]);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  setPathTracerScene();
  pathTracer.updateMaterials();
  pathTracer.reset();
  setStatus(`View ${viewIndex + 1}/${BAKE_VIEWS.length}: ${view.name}`);
}

function captureCurrentView() {
  const view = BAKE_VIEWS[multiViewIndex];
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const srcCanvas = renderer.domElement;
  const copyCanvas = document.createElement("canvas");
  copyCanvas.width = srcCanvas.width;
  copyCanvas.height = srcCanvas.height;
  const ctx = copyCanvas.getContext("2d");
  ctx.drawImage(srcCanvas, 0, 0);
  const srcData = ctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const camPos = camera.getWorldPosition(new THREE.Vector3());
  const camMatrix = camera.matrixWorldInverse.clone();
  const projMatrix = camera.projectionMatrix.clone();
  multiViewCaptures.push({
    name: view.name,
    camPos,
    camMatrix,
    projMatrix,
    srcData,
    width: srcCanvas.width,
    height: srcCanvas.height,
  });
}

async function finishMultiViewUvBakeAsync() {
  const meshes = sceneObjects.filter((o) => !o.userData.skipBake);
  setBakeProgress(45, `Projecting ${meshes.length} meshes into UV space…`, "Multi-view bake", true);
  for (let i = 0; i < meshes.length; i++) {
    const obj = meshes[i];
    const texture = await bakeObjectMultiViewAsync(obj, LIGHTMAP_SIZE, (subPct, line) => {
      const overall = 45 + ((i + subPct / 100) / meshes.length) * 50;
      setBakeProgress(overall, line, "Multi-view bake", false);
    });
    obj.userData.lightmapTexture = texture;
  }
  for (const obj of sceneObjects) {
    if (obj.userData.originalRoughness !== undefined && obj.material) {
      obj.material.roughness = obj.userData.originalRoughness;
      obj.material.metalness = obj.userData.originalMetalness ?? obj.material.metalness;
      obj.material.needsUpdate = true;
    }
  }
  cameraRig.position.set(4 * sceneBakeViewScale, 0, 4 * sceneBakeViewScale);
  camera.position.set(0, 2, 0);
  camera.lookAt(orbitTarget);
  camera.updateMatrixWorld(true);
  controls.target.copy(orbitTarget);
  controls.enabled = true;
  controls.update();
  setPathTracerScene();
  pathTracer.updateMaterials();
  pathTracer.reset();
  isBaked = true;
  {
    const bb = document.getElementById("bakeBtn");
    const bv = document.getElementById("bakeBVHBtn");
    if (bb) bb.textContent = "Baked ✓";
    if (bv) bv.textContent = "Bake BVH (recommended)";
  }
  {
    const p = document.getElementById("previewBtn");
    const e = document.getElementById("exportBtn");
    if (p) p.style.display = "block";
    if (e) e.style.display = "block";
  }
  {
    const bb = document.getElementById("bakeBtn");
    const bv = document.getElementById("bakeBVHBtn");
    if (bb) bb.disabled = false;
    if (bv) bv.disabled = false;
  }
  const mvTotalTime = _bakeStartMs > 0 ? formatDuration(performance.now() - _bakeStartMs) : "";
  hideBakeProgress();
  multiViewUvBusy = false;
  isMultiViewBaking = false;
  const mvDoneMsg = mvTotalTime ? `Multi-view baking complete! (${mvTotalTime})` : "Multi-view baking complete!";
  setStatus(mvDoneMsg);
  applyBakedMaterials();
  if (await saveBakedTextures()) setStatus(`${mvDoneMsg} (Saved)`);
}

function startMultiViewBake() {
  if (isMultiViewBaking) return;
  isMultiViewBaking = true;
  multiViewIndex = 0;
  multiViewCaptures = [];
  for (const obj of sceneObjects) {
    if (obj.material && obj.material.roughness !== undefined) {
      obj.userData.originalRoughness = obj.material.roughness;
      obj.userData.originalMetalness = obj.material.metalness;
      obj.material.roughness = 1.0;
      obj.material.metalness = 0.0;
      obj.material.needsUpdate = true;
    }
  }
  controls.enabled = false;
  const b1 = document.getElementById("bakeBtn");
  const b2 = document.getElementById("bakeBVHBtn");
  if (b1) b1.disabled = true;
  if (b2) b2.disabled = true;
  multiViewUvBusy = false;
  _bakeStartMs = performance.now();
  setBakeProgress(
    0,
    `${BAKE_VIEWS.length} views × ${SAMPLES_PER_VIEW} samples — watch bar and Samples`,
    "Multi-view bake",
    true,
  );
  setupBakeView(0);
}

/**
 * @param {{ onlyMissing?: boolean, names?: string[] }} [opts]
 *   `onlyMissing` skips meshes that already have a `lightmapTexture` (handy for the
 *   "ground was added later" case — bakes just the new mesh in seconds instead of
 *   re-running all 14). `names` further restricts to specific `obj.name`s.
 */
async function startBVHBake(opts = {}) {
  if (!sceneBVH) {
    alert("Scene BVH not built!");
    return;
  }
  if (!envData || !lightingApi) {
    alert("HDR environment not loaded!");
    return;
  }
  const b1 = document.getElementById("bakeBtn");
  const b2 = document.getElementById("bakeBVHBtn");
  if (b1) b1.disabled = true;
  if (b2) b2.disabled = true;
  let meshes = sceneObjects.filter((o) => !o.userData.skipBake);
  if (opts.onlyMissing) meshes = meshes.filter((o) => !o.userData.lightmapTexture);
  if (Array.isArray(opts.names) && opts.names.length)
    meshes = meshes.filter((o) => opts.names.includes(o.name));
  if (meshes.length === 0) {
    setStatus("BVH bake skipped — no meshes match the filter (all already baked?)");
    if (b1) b1.disabled = false;
    if (b2) b2.disabled = false;
    return;
  }
  const label = opts.onlyMissing ? "BVH bake (missing only)" : "BVH bake";
  _bakeStartMs = performance.now();
  setBakeProgress(0, `${label} · ${meshes.length} meshes · ${BVH_SHADOW_SAMPLES} rays/pixel`, label, true);
  let mi = 0;
  for (const obj of meshes) {
    const texture = await bakeObjectBVH(
      obj,
      LIGHTMAP_SIZE,
      BVH_SHADOW_SAMPLES,
      lightingApi,
      setStatus,
      (meshPct, detail) => {
        const overall = ((mi + meshPct / 100) / meshes.length) * 100;
        setBakeProgress(overall, detail, "BVH bake", false);
      },
      DENOISE_ITERATIONS,
      LIGHTMAP_PUNCH,
    );
    obj.userData.lightmapTexture = texture;
    mi++;
    await yieldToPaint();
  }
  isBaked = true;
  isDebugMode = false;
  if (b1) b1.textContent = "Baked ✓";
  if (b2) {
    b2.textContent = "Baked (BVH) ✓";
    b2.disabled = false;
  }
  if (b1) b1.disabled = false;
  {
    const p = document.getElementById("previewBtn");
    const e = document.getElementById("exportBtn");
    if (p) p.style.display = "block";
    if (e) e.style.display = "block";
  }
  const totalTime = _bakeStartMs > 0 ? formatDuration(performance.now() - _bakeStartMs) : "";
  hideBakeProgress();
  const doneMsg = totalTime ? `BVH baking complete! (${totalTime})` : "BVH baking complete!";
  setStatus(doneMsg);
  applyBakedMaterials();
  if (await saveBakedTextures()) setStatus(`${doneMsg} (Saved)`);
}

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

  /* Map handedness → Three.js controller object so the locomotion code
   * can grab the correct hand's grip controller for world position. */
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

/**
 * Charge-and-throw grab locomotion. Pressing the grip button starts
 * "charging" — hand motion is recorded but doesn't affect the rig.
 * Releasing the grip applies the averaged hand velocity (over the last
 * few frames) as an IMPULSE: rigVelocity += -handVel * THROW_BOOST.
 *
 * Result: grab alone changes nothing. Swing + release adds momentum in
 * the direction opposite the swing. Repeated throws stack. Swinging
 * opposite your current motion subtracts from it (you can brake).
 *
 * Hand motion is tracked in rig-local tracking space, then rotated by
 * the rig's quaternion at release — so it isn't polluted by gravity-
 * driven rig motion or rig rotation during the grab.
 */
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

        /* Jump-count logic (Nock-like): each upward throw consumes one
         * jump; jumps reset on landing. When out of jumps the upward
         * component is suppressed but horizontal motion still applies. */
        if (impY > JUMP_THRESHOLD) {
          if (jumpsRemaining > 0) jumpsRemaining--;
          else impY = 0;
        }

        rigVelocity.x += impX;
        rigVelocity.y += impY;
        rigVelocity.z += impZ;

        /* Hard caps so repeated throws in the same direction don't stack
         * to absurd values, and to keep vertical motion gentle (Nock-like). */
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

/**
 * True if the rig is on the world floor or standing on the TOP face of a
 * slab. Probe a small region just below the rig and require it to be near
 * each slab's local +Y face — otherwise tall walls would falsely count as
 * "ground" when the player simply touches them at any height, killing
 * gravity and pinning them mid-air.
 */
function isGrounded() {
  if (cameraRig.position.y <= 0.01) return true;
  const px = cameraRig.position.x;
  const pz = cameraRig.position.z;
  const py = cameraRig.position.y - 0.1;
  const r = PLAYER_RADIUS;
  for (const b of collisionBoxes) {
    _localPt.set(px - b.cx, py - b.cy, pz - b.cz).applyMatrix3(b.mInv);
    /* Probe must be near the slab's TOP (local +Y face), not just inside
     * its expanded box. Walls' top is way overhead, so they won't ground. */
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
  if (collisionBoxes.length > 0) {
    resolveAllCollisions(cameraRig.position);
    cameraRig.position.y = Math.max(0, cameraRig.position.y);
  }
}

/**
 * Sky + bloom pipeline copy-pasted from brutalistVR/js/main.js (the `max`
 * fidelity branch, since brutalistVR6 is a single-quality desktop+VR build).
 *
 * Verbatim transplants:
 *  - `Sky` instance, scale = 450000, identical uniform values
 *    (turbidity 9, rayleigh 1.2, mie 0.0035, mieDirectionalG 0.88).
 *  - Pass chain: RenderPass → UnrealBloomPass(0.34, 0.58, 0.78) → FilmPass(0.07)
 *    → SMAAPass → OutputPass. Same `clear = false` on FilmPass.
 *
 * Justified deviations from a literal paste (kept minimal):
 *  - Sun position is sourced from the HDR (`lightingApi.sunDirection`) so the
 *    visible sun aligns with the BVH-baked shadows. brutalistVR uses a
 *    hardcoded sunVec because it has no HDR-baked shadows to align with.
 *  - SSR/GTAO/CSM passes from brutalistVR are skipped: SSR/GTAO would fight
 *    the baked lightmaps (which already bake occlusion), and CSM would add a
 *    second runtime sun on top of the baked one — both contradict the
 *    "show the bake" goal of brutalistVR6's baked-view mode.
 */
function setupSkyAndBloom() {
  const sunVec = new THREE.Vector3();
  if (lightingApi?.sunDirection) {
    sunVec.copy(lightingApi.sunDirection).normalize();
  } else {
    /* Fallback matches brutalistVR's hardcoded sunVec when no HDR is loaded. */
    sunVec.set(0.52, 0.78, 0.34).normalize();
  }

  sky = new Sky();
  sky.scale.setScalar(450000);
  /* Mark so the BVH bake / path tracer setup can skip it. (BVH already takes
   * an explicit sceneObjects list so it's fine; path tracer setup uses
   * `setPathTracerScene` which detaches sky during setScene.) */
  sky.userData.isProceduralSky = true;
  const skyU = sky.material.uniforms;
  skyU.turbidity.value = 9;
  skyU.rayleigh.value = 1.2;
  skyU.mieCoefficient.value = 0.0035;
  skyU.mieDirectionalG.value = 0.88;
  skyU.sunPosition.value.copy(sunVec).multiplyScalar(400000);
  scene.add(sky);

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

/**
 * Wrapper around `pathTracer.setScene` that detaches the procedural Sky for
 * the duration of the call. The path tracer's BVH builder walks every visible
 * mesh in the scene; including a 450000-unit Sky cube would either degrade
 * the acceleration structure or produce a gigantic camera-occluding hit. The
 * path-traced preview already shows the HDR equirect as its background, so
 * the visible result is unchanged.
 */
function setPathTracerScene() {
  const skyParent = sky?.parent ?? null;
  if (skyParent) skyParent.remove(sky);
  pathTracer.setScene(scene, camera);
  if (skyParent) skyParent.add(sky);
}


function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  if (composer) {
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    composer.setSize(w, h);
    const wp = Math.floor(w * pr);
    const hp = Math.floor(h * pr);
    bloomPass?.setSize(wp, hp);
    smaaPass?.setSize(wp, hp);
  }
  setPathTracerScene();
}

function animate(time) {
  const delta = time - lastTime;
  lastTime = time;
  if (SHOW_FPS) tickFps(performance.now());

  if (isMultiViewBaking) {
    if (multiViewUvBusy) {
      if (samplesElement) samplesElement.textContent = "UV projection (see progress bar)";
      return;
    }
    const currentSamples = Math.floor(pathTracer.samples);
    if (currentSamples < SAMPLES_PER_VIEW) {
      pathTracer.renderSample();
    } else {
      captureCurrentView();
      multiViewIndex++;
      if (multiViewIndex < BAKE_VIEWS.length) {
        setupBakeView(multiViewIndex);
      } else {
        multiViewUvBusy = true;
        void finishMultiViewUvBakeAsync().catch((err) => {
          console.error(err);
          multiViewUvBusy = false;
          isMultiViewBaking = false;
          hideBakeProgress();
          setStatus(`Multi-view UV phase failed: ${err}`);
        });
      }
    }
    if (samplesElement) {
      const vNum = Math.min(multiViewIndex + 1, BAKE_VIEWS.length);
      samplesElement.textContent = `View ${vNum}/${BAKE_VIEWS.length}: ${Math.floor(pathTracer.samples)}/${SAMPLES_PER_VIEW}`;
    }
    if (!multiViewUvBusy) {
      const viewProg = (multiViewIndex + Math.min(1, currentSamples / SAMPLES_PER_VIEW)) / BAKE_VIEWS.length;
      setBakeProgress(
        viewProg * 40,
        `View ${multiViewIndex + 1}/${BAKE_VIEWS.length} · path-traced samples`,
        "Multi-view bake",
        false,
      );
    }
    return;
  }

  /* Path tracer is opt-in for desktop preview (off by default). In VR its
   * output is never displayed, so it's also skipped there regardless. */
  const ptRunning = pathTracerActive
    && !renderer.xr.isPresenting
    && !isPreviewMode
    && !isDebugMode
    && !isUv2CheckerActive;
  if (ptRunning) {
    pathTracer.renderSample();
    if (samplesElement) samplesElement.textContent = `Samples: ${Math.floor(pathTracer.samples)}`;
  }

  if (renderer.xr.isPresenting) {
    updateVRMovement(delta);
    /* VR uses direct renderer.render — composer/bloom is single-eye only. */
    renderer.render(scene, camera);
  } else {
    controls.update();
    if (isDebugMode || isUv2CheckerActive) {
      renderer.render(scene, camera);
    } else if (isPreviewMode) {
      /* Baked desktop view = composer chain (Sky + bloom + grain + SMAA). */
      if (composer) composer.render(delta * 0.001);
      else renderer.render(scene, camera);
    } else if (!ptRunning) {
      /* Default 2D view with path tracer paused: just render the live scene. */
      renderer.render(scene, camera);
    }
  }
}

async function init() {
  samplesElement = document.getElementById("samples");
  statusElement = document.getElementById("status");
  fpsElement = document.getElementById("fps");
  if (fpsElement) fpsElement.style.display = SHOW_FPS ? "block" : "none";
  fpsState.windowStart = performance.now();
  drawVrFpsPanel(0);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.025, 500);
  cameraRig = new THREE.Group();
  cameraRig.add(camera);
  camera.position.set(0, 2, 0);

  gradientMap = new GradientEquirectTexture();
  gradientMap.topColor.set(params.bgGradientTop);
  gradientMap.bottomColor.set(params.bgGradientBottom);
  gradientMap.update();

  scene = new THREE.Scene();
  /* Default `?hdr=0`: a single flat dark colour instead of the sky-blue gradient. The
   * gradient + HDR IBL combination read as "outdoor sky" to the user; turning it off
   * gives a clean studio backdrop while keeping the bake's lighting source intact. */
  scene.background = USE_HDR ? gradientMap : new THREE.Color(0x101010);
  scene.add(cameraRig);

  setStatus("Loading HDR…");
  try {
    const envTexture = await new RGBELoader().loadAsync(ENV_URL);
    envTexture.mapping = THREE.EquirectangularReflectionMapping;
    /* `scene.environment` is ALWAYS the HDR: `three-gpu-pathtracer` reads its IBL
     * straight from this slot, so leaving it null gives a pitch-black preview. The
     * baked-view materials suppress the live IBL contribution per-material via
     * `envMapIntensity = 0` in `applyLightmapForBakedView`, so the bake's shadow
     * detail still wins on the visible meshes. Only `scene.background` is gated. */
    scene.environment = envTexture;
    scene.environmentIntensity = params.environmentIntensity;
    const img = envTexture.image;
    envData = { data: img.data, width: img.width, height: img.height };
  } catch (e) {
    console.warn("HDR load failed", e);
  }

  const { sceneObjects: objs } = buildBrutalistLayout(THREE, scene, { fidelityMax: true });
  sceneObjects = objs;
  const sceneBox = new THREE.Box3();
  for (const o of sceneObjects) {
    o.updateMatrixWorld(true);
    sceneBox.expandByObject(o);
  }
  const sceneCenter = sceneBox.getCenter(new THREE.Vector3());
  const sceneSize = sceneBox.getSize(new THREE.Vector3());
  const diag = Math.max(sceneSize.x, sceneSize.y, sceneSize.z, 1);
  const viewScale = THREE.MathUtils.clamp(diag * 0.055, 16, 160);
  rebuildBakeViews(viewScale, sceneCenter.y + sceneSize.y * 0.08);
  cameraRig.position.set(4 * sceneBakeViewScale, 0, 4 * sceneBakeViewScale);
  orbitTarget.copy(sceneCenter);

  buildCollisionAABBs();
  prepareBoxesForBake(sceneObjects);
  const { sceneBVH: bvh } = buildSceneBVH(scene, sceneObjects);
  sceneBVH = bvh;
  lightingApi = envData
    ? createHdrBvhLighting(envData, sceneBVH, {
        ...params,
        bvhSunFraction: BVH_SUN_FRACTION,
        bvhBounce: BVH_BOUNCE_ENABLED ? 1 : 0,
        bvhBounceAlbedo: BVH_BOUNCE_ALBEDO,
        bvhSunJitter: BVH_SUN_JITTER,
        bvhSunThreshold: BVH_SUN_THRESHOLD,
        bvhMaxBounces: BVH_MAX_BOUNCES,
      })
    : null;
  lightingApi?.findSunInHDR();

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
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
    } catch (_) {
      /* ignore */
    }
  }

  /* Fixed Foveated Rendering + 120 Hz request on session start.
   * - Foveation 1: drop pixel cost in the periphery of each eye (Quest
   *   default for most apps; barely perceptible).
   * - WebXR sessions default to 90 Hz; Quest 3 supports 120 Hz but we
   *   have to ask for it explicitly via updateTargetFrameRate. */
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

  setupSkyAndBloom();

  pathTracer = new WebGLPathTracer(renderer);
  pathTracer.physicallyCorrectLights = true;
  pathTracer.tiles.set(params.tiles, params.tiles);
  pathTracer.multipleImportanceSampling = params.multipleImportanceSampling;
  pathTracer.transmissiveBounces = 10;
  pathTracer.bounces = params.bounces;
  pathTracer.filterGlossyFactor = params.filterGlossyFactor;
  setPathTracerScene();
  pathTracer.updateMaterials();
  pathTracer.updateEnvironment();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(orbitTarget);
  controls.update();
  controls.addEventListener("change", () => pathTracer.updateCamera());

  document.getElementById("bakeBtn")?.addEventListener("click", startMultiViewBake);
  document.getElementById("bakeBVHBtn")?.addEventListener("click", () => void startBVHBake());
  document.getElementById("debugBtn")?.addEventListener("click", applyDebugTextures);
  document.getElementById("uv2CheckerBtn")?.addEventListener("click", toggleUv2Checker);
  document.getElementById("previewBtn")?.addEventListener("click", togglePreview);
  document.getElementById("exportBtn")?.addEventListener("click", exportTextures);
  document.getElementById("pathTracerBtn")?.addEventListener("click", () => {
    pathTracerActive = !pathTracerActive;
    const btn = document.getElementById("pathTracerBtn");
    if (btn) btn.textContent = `Path Tracer: ${pathTracerActive ? "Running" : "Paused"}`;
    if (pathTracerActive) pathTracer.reset();
  });

  /* "Import Lightmap PNG(s)…" — proxy click to the hidden <input type=file>, then on
   * change pass the FileList to `importLightmapFiles` (which decodes, applies, saves). */
  const importBtn = document.getElementById("importBtn");
  const importFile = /** @type {HTMLInputElement|null} */ (document.getElementById("importFile"));
  if (importBtn && importFile) {
    importBtn.addEventListener("click", () => importFile.click());
    importFile.addEventListener("change", async () => {
      if (importFile.files && importFile.files.length) {
        await importLightmapFiles(importFile.files);
        importFile.value = "";
      }
    });
  }

  setStatus("Checking for saved lightmaps…");
  const restore = await restoreBakedTexturesIfSaved();
  if (restore.ok) {
    pathTracer.reset();
    pathTracer.updateMaterials();
    const bb = document.getElementById("bakeBtn");
    const bv = document.getElementById("bakeBVHBtn");
    if (bb) bb.textContent = "Baked ✓";
    if (bv) bv.textContent = "Baked (BVH) ✓";
    const hint = restore.migrated ? " (migrated from older save)" : "";
    setStatus(`Restored baked lightmaps${hint} — Toggle Preview for path tracing.`);
  }

  const meta = document.getElementById("meta");
  if (meta) {
    const mPerCell = diag / Math.max(1, LIGHTMAP_SIZE / 3);
    meta.textContent =
      `Court bbox ~${diag.toFixed(0)}u diag · bake view scale ${sceneBakeViewScale.toFixed(0)} · ` +
      `lm ${LIGHTMAP_SIZE}px (~${mPerCell.toFixed(2)} world-u per lightmap cell row) · PT ${SAMPLES_PER_VIEW}/view · ` +
      `BVH ${BVH_SHADOW_SAMPLES} paths · maxbounces ${BVH_MAX_BOUNCES} · sunjitter ${BVH_SUN_JITTER.toFixed(2)} · alb ${BVH_BOUNCE_ALBEDO.toFixed(2)} · terminator ${BVH_BOUNCE_ENABLED ? "skyFill" : "0"} · lmpunch ${LIGHTMAP_PUNCH.toFixed(2)} · denoise ${DENOISE_ITERATIONS}. ` +
      `Display remap (no rebake): lmgamma ${LM_GAMMA.toFixed(2)} · lmcontrast ${LM_CONTRAST.toFixed(2)} · lmmid ${LM_MID.toFixed(2)} · lmscale ${LM_SCALE.toFixed(2)} · sky bg ${USE_HDR ? "on" : "off"} (env always loaded for preview). ` +
      `Baked desktop view = procedural Sky (sun aligned with HDR) + UnrealBloom + Film grain + SMAA, copy-pasted from brutalistVR. VR uses direct render (no bloom). ` +
      `v6 BVH bake = real multi-bounce path tracing: each path = 1 NEE sun + up to ${BVH_MAX_BOUNCES} cosine-weighted bounces (NEE sun at every hit, throughput *= alb each bounce). Rebake knobs: ?bvhMaxBounces=N (3 = open scenes, 5–6 = enclosed rooms); ?samples=N (more = smoother indirect); ?bouncealbedo=0.85 = lighter walls; ?bounce=0 = strict 0 terminator (deep corners stay dark).`;
  }

  window.addEventListener("resize", onResize);
  renderer.setAnimationLoop(animate);
  if (!restore.ok) {
    setStatus("Path tracing — use Bake Multi-View or Bake BVH (same as BuildVR index5).");
  }

  /* DevTools console API. Lets you query/repair the bake without re-running all 14
   * meshes — e.g. `brutalistVR6.bakeMissing()` after `skipBake` was removed from a
   * mesh whose neighbours are already saved. Everything is on `window.brutalistVR6`. */
  window.brutalistVR6 = {
    /** Print storage + scene state. Returns `{ saved, scene, missing, orphaned, applied }`. */
    async status() {
      let saved = [];
      try {
        saved = await idbKeys();
      } catch (e) {
        console.error("brutalistVR6.status: IDB read failed:", e);
      }
      const scene = sceneObjects.map((o) => o.name);
      const applied = sceneObjects.filter((o) => o.userData.lightmapTexture).map((o) => o.name);
      const missing = scene.filter((n) => !saved.includes(n));
      const orphaned = saved.filter((n) => !scene.includes(n));
      const est = await idbEstimateMB();
      const summary = {
        store: "IndexedDB:brutalistVR6_lightmaps/lightmaps",
        saved,
        scene,
        missing,
        orphaned,
        applied,
        idbUsageMB: est?.usageMB,
        idbQuotaMB: est?.quotaMB,
      };
      console.table(
        scene.map((name) => ({
          name,
          saved: saved.includes(name) ? "yes" : "—",
          loaded: applied.includes(name) ? "yes" : "—",
        })),
      );
      console.info("brutalistVR6.status:", summary);
      return summary;
    },
    /** Bake just the meshes that don't yet have a lightmap (in-memory or restored). */
    async bakeMissing() {
      const missing = sceneObjects
        .filter((o) => !o.userData.skipBake && !o.userData.lightmapTexture)
        .map((o) => o.name);
      if (missing.length === 0) {
        console.info("brutalistVR6.bakeMissing: nothing to do — every mesh already has a lightmap.");
        return missing;
      }
      console.info("brutalistVR6.bakeMissing: baking", missing);
      await startBVHBake({ onlyMissing: true });
      return missing;
    },
    /** Bake an explicit list of mesh names (e.g. `brutalistVR6.bakeNames(["ground"])`). */
    async bakeNames(names) {
      if (!Array.isArray(names) || names.length === 0) {
        console.warn("brutalistVR6.bakeNames(names): pass an array of mesh names");
        return [];
      }
      await startBVHBake({ names });
      return names;
    },
    /** Open the file picker — same as the "Import Lightmap PNG(s)…" button. */
    importFiles() {
      const el = /** @type {HTMLInputElement|null} */ (document.getElementById("importFile"));
      if (el) el.click();
      else console.warn("brutalistVR6.importFiles: #importFile not found");
    },
    /** Import a `FileList` directly (e.g. from a script-side drag-and-drop hook). */
    async importFileList(fileList) {
      return importLightmapFiles(fileList);
    },
    /** Force-save the current in-memory bakes to IndexedDB (debugging). */
    async save() {
      return saveBakedTextures();
    },
    /** Wipe the IndexedDB lightmap store and any leftover localStorage payloads. Next reload starts cold. */
    async clearStorage() {
      try {
        await idbClear();
        console.info("brutalistVR6.clearStorage: cleared IndexedDB lightmap store");
      } catch (e) {
        console.error("brutalistVR6.clearStorage: IDB clear failed:", e);
      }
      for (const key of [STORAGE_KEY, ...LEGACY_BAKE_STORAGE_KEYS]) {
        try {
          if (localStorage.getItem(key)) {
            localStorage.removeItem(key);
            console.info(`brutalistVR6.clearStorage: removed legacy localStorage key "${key}"`);
          }
        } catch (_) {
          /* ignore — best-effort cleanup */
        }
      }
      return true;
    },
  };
  console.info(
    "[brutalistVR6] console API ready — try brutalistVR6.status() or brutalistVR6.bakeMissing()",
  );
}

init().catch((e) => {
  console.error(e);
  setStatus(String(e));
});
