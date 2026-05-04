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
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
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
  setAntiRepetition,
  getAntiRepetition,
  setTextures,
  getTextures,
  getSectorTowerAnchors,
} from "./sectors.js";
import {
  initBots,
  updateBots,
  setBotsEnabled,
  getBotsEnabled,
  getBotsDebug,
  getAntiAirDebug,
  killAllDrones,
  jumpToWave,
  spawnSpecificDrone,
  ensureMusicStarted,
  setCompassMode,
  getCompassMode,
  setUIVisible,
  getUIVisible,
  setBowHand,
  getBowHand,
  toggleBowHand,
  notifySectorsChanged,
  setArrowType,
  getArrowType,
  toggleArrowType,
  restartRun,
  getTopScores,
} from "./bots.js";

/* Local overcast EXR — used both as scene.environment (IBL ambient
 * lighting source) AND as scene.background (visible sky dome). The
 * "overcast" pick is deliberate: a uniformly-grey dome means every
 * pixel of the sky deviates only ~5-10 % from the mean, so the
 * fog-colour matching trick (see below in `init()`) holds the
 * "no sector pop-in" guarantee that BattleVR's solid-grey sky was
 * giving us, while still letting the player see an actual sky. */
const ENV_URL = "textures/overcast_soil_puresky_1k.exr";

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

/**
 * Return the mean LINEAR-RGB colour of an equirect HDR/EXR texture as
 * a `{ r, g, b }` object (values in [0, +∞) — HDR pixels can exceed 1).
 *
 * The EXR pixel data is already in linear-RGB float32, so this is a
 * straight average of the channel values. We sample on a stride
 * (~4096 samples regardless of texture size) for cheap one-time
 * computation; for a 1k equirect (1024 × 512 = 524k pixels) that's a
 * 128× speedup vs full pixel walk and gives an answer indistinguishable
 * from the exact mean for the purpose of fog matching.
 *
 * Bright HDR pixels (a sun disc) would normally pull the mean far
 * brighter than the visual "sky grey". We CLAMP each channel sample
 * to 4× the per-pixel-channel mean before averaging — a stupid simple
 * outlier filter that gives us a robust "background sky" mean even on
 * EXRs that include direct-sun information. For an overcast EXR the
 * clamp is essentially a no-op (no pixels far brighter than the rest).
 */
function sampleEquirectAverageLinear(tex) {
  const img = tex.image;
  const data = img?.data;
  if (!data) return { r: 0.5, g: 0.5, b: 0.5 };
  const w = img.width;
  const h = img.height;
  const channels = data.length / (w * h);     // 3 (RGB) or 4 (RGBA)
  const targetSamples = 4096;
  const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / targetSamples)));
  /* First pass: compute coarse mean for outlier-clamp threshold. */
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const i = (y * w + x) * channels;
      sumR += data[i];
      sumG += data[i + 1];
      sumB += data[i + 2];
      count++;
    }
  }
  const meanR0 = sumR / count;
  const meanG0 = sumG / count;
  const meanB0 = sumB / count;
  const capR = meanR0 * 4;
  const capG = meanG0 * 4;
  const capB = meanB0 * 4;
  /* Second pass: same stride, but each sample clamped to ≤ 4× the
   * coarse mean. Keeps a sun disc from dominating the average. */
  sumR = 0; sumG = 0; sumB = 0; count = 0;
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const i = (y * w + x) * channels;
      sumR += Math.min(data[i],     capR);
      sumG += Math.min(data[i + 1], capG);
      sumB += Math.min(data[i + 2], capB);
      count++;
    }
  }
  return { r: sumR / count, g: sumG / count, b: sumB / count };
}

/** Sun light intensity (overdriven so concrete actually triggers bloom and shadows
 *  read with real contrast). */
const SUN_INTENSITY = readFloatParam("sun", 4.0);
/** Default ON: the overcast EXR doubles as both `scene.environment`
 *  (IBL) and `scene.background` (visible sky), with the fog colour
 *  set to the EXR's mean linear RGB at load time so streaming pops
 *  remain invisible against the dome. `?hdr=0` opts out for users
 *  who'd rather have the old solid-grey sky. */
const USE_HDR = readIntParam("hdr", 1) === 1;

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
const rotateSpeed = 120;
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

/**
 * Build the "B  Toggle Battle" floating label that mirrors VRKnockout's
 * grip-mounted hints. Structure:
 *
 *   group
 *     └── pulseGroup    (animates 1.0 → 1.2 — pulse only the ring + letter,
 *           ├── ring     just like VRKnockout's <a-entity animation> wrapper
 *           └── letter   that sits outside the static label)
 *     └── label         (static, sits OUTSIDE the pulse so it doesn't grow)
 *
 * All three meshes are unlit BasicMaterial / RingGeometry, transparent,
 * `depthTest:false` (so the controller mesh never occludes them) and
 * `fog:false` (so atmospheric fog leaves them alone).
 */
function makeButtonHint(letter, label) {
  const group = new THREE.Group();
  group.name = `hint_${letter}`;

  /* Ring dimensions match VRKnockout: inner 8.6 mm, outer 9.9 mm. */
  const RING_INNER = 0.0086;
  const RING_OUTER = 0.0099;

  /* ── Pulse subgroup (ring + letter) ──────────────────────────────── */
  const pulseGroup = new THREE.Group();
  group.add(pulseGroup);

  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.96,
    side: THREE.DoubleSide, fog: false, toneMapped: false, depthTest: false,
  });
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(RING_INNER, RING_OUTER, 40), ringMat,
  );
  ring.renderOrder = 9990;
  pulseGroup.add(ring);

  /* Letter centred in the ring. Square canvas + square plane so the glyph
   * actually fills its share of the ring's inner area (the previous
   * 256×64-canvas-on-rectangular-plane combo rendered the glyph at ~2 mm
   * tall, which was indistinguishable from blank). Plane size is set to
   * fit comfortably inside the ring's inner diameter (17.2 mm). */
  const letterCanvasN = 96;
  const letterCanvas = document.createElement("canvas");
  letterCanvas.width = letterCanvasN;
  letterCanvas.height = letterCanvasN;
  {
    const ctx = letterCanvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${Math.floor(letterCanvasN * 0.78)}px system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    /* +1 px nudge for visual centring — most fonts have more headroom
     * above the baseline than below the cap line. */
    ctx.fillText(letter, letterCanvasN / 2, letterCanvasN / 2 + 1);
  }
  const letterTex = new THREE.CanvasTexture(letterCanvas);
  letterTex.colorSpace = THREE.SRGBColorSpace;
  letterTex.minFilter = THREE.LinearFilter;
  letterTex.magFilter = THREE.LinearFilter;
  letterTex.generateMipmaps = false;
  const letterSize = 0.013; /* 13 mm — fits inside the 17.2 mm ring inner diameter. */
  const letterMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(letterSize, letterSize),
    new THREE.MeshBasicMaterial({
      map: letterTex, transparent: true, side: THREE.DoubleSide,
      fog: false, toneMapped: false, depthTest: false,
    }),
  );
  /* +0.0002 m forward of the ring on the local Z so it always wins the
   * sort even at identical renderOrder collisions. */
  letterMesh.position.set(0, 0, 0.0002);
  letterMesh.renderOrder = 9991;
  pulseGroup.add(letterMesh);

  /* ── Static label to the right of the ring ───────────────────────── */
  const labelCanvasW = 384;
  const labelCanvasH = 64;
  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = labelCanvasW;
  labelCanvas.height = labelCanvasH;
  {
    const ctx = labelCanvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.font = "600 40px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(label, 4, labelCanvasH / 2);
  }
  const labelTex = new THREE.CanvasTexture(labelCanvas);
  labelTex.colorSpace = THREE.SRGBColorSpace;
  labelTex.minFilter = THREE.LinearFilter;
  labelTex.magFilter = THREE.LinearFilter;
  labelTex.generateMipmaps = false;
  const LABEL_W = 0.045; /* 45 mm wide label — readable at controller distance. */
  const LABEL_H = LABEL_W * (labelCanvasH / labelCanvasW);
  const labelMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(LABEL_W, LABEL_H),
    new THREE.MeshBasicMaterial({
      map: labelTex, transparent: true, side: THREE.DoubleSide,
      fog: false, toneMapped: false, depthTest: false,
    }),
  );
  /* Plane is centred on its position. We want the plane's LEFT EDGE to
   * sit just outside the ring's outer radius with a small gap (3 mm),
   * so:  centre.x = RING_OUTER + gap + LABEL_W/2. This is what was
   * wrong before — the previous setup put the centre at 0.0125 m which
   * left the plane's left edge inside the ring. */
  const LABEL_GAP = 0.003;
  labelMesh.position.set(RING_OUTER + LABEL_GAP + LABEL_W / 2, 0, 0.0002);
  labelMesh.renderOrder = 9991;
  group.add(labelMesh);

  /* Pulse only the ring + letter, never the label. 1.0 → 1.2 over ~800 ms,
   * sin-eased — the same numbers VRKnockout uses (`from: 1 1 1; to: 1.2 1.2
   * 1.2; dur: 800; dir: alternate; easing: easeInOutSine`). */
  group.userData.pulseStart = performance.now();
  group.userData.pulseTick = (now) => {
    const t = (now - group.userData.pulseStart) / 1000;
    const s = 1.0 + 0.1 * (0.5 + 0.5 * Math.sin(t * Math.PI * 1.25));
    pulseGroup.scale.set(s, s, s);
  };

  return group;
}

/** Attach a button hint to a grip so it floats just above the face
 * buttons, label readable when the player glances at their hand.
 *
 * Coordinates match VRKnockout's `<a-entity position="0.002 0.012 -0.062">`
 * + rotation chain, translated into three.js controllerGrip space:
 *   - WebXR grip frame: +Y is "up" out of the back of the hand, -Z is
 *     forward along the controller toward the index trigger.
 *   - Face buttons live a couple of cm forward of the grip and on the
 *     top face (+Y). So the hint sits at ~(0, 0.025, -0.06) and is
 *     rotated -π/2 around X so its plane lies flat on top of the
 *     controller, then tilted forward ~15° so the text faces the visor. */
function attachHintToGrip(grip, hint) {
  const outer = new THREE.Group();
  outer.position.set(0.002, 0.025, -0.062);
  outer.rotation.set(-Math.PI / 2 + 0.25, 0, 0);
  outer.add(hint);
  grip.add(outer);
  return outer;
}

const _hintMeshes = [];

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

  /* Once we know which grip is which hand, hang the matching button
   * hints off each: "B Toggle Battle" on the right (button[5] = B on
   * Quest Touch), "Y Toggle UI" on the left (button[5] = Y on the
   * left controller — the upper face button on each hand). We
   * delay-bind because handedness only becomes known on the
   * controller's `connected` event. */
  function bindRightHint(grip) {
    if (grip.userData._hasBattleHint) return;
    grip.userData._hasBattleHint = true;
    const hint = makeButtonHint("B", "Toggle Battle");
    attachHintToGrip(grip, hint);
    _hintMeshes.push(hint);
  }
  /* Left controller carries TWO hints stacked vertically: Y on the
   * upper face button (toggles HUD visibility) and X on the lower face
   * button (toggles arrow type — normal ↔ explosive). VRKnockout's
   * single-hint position for Y is `(0.002, 0.025, -0.062)`; X sits
   * ~16 mm "below" Y along the controller's local +Z (toward the
   * trigger) so it floats roughly over the X button on the front
   * face plate. The two hints are independent groups so each pulses
   * its own ring without dragging the other. */
  function bindLeftHint(grip) {
    if (grip.userData._hasLeftHints) return;
    grip.userData._hasLeftHints = true;
    /* Y — upper face button (matches existing position used for
     * the right grip's B hint). */
    const yHint = makeButtonHint("Y", "Toggle UI");
    attachHintToGrip(grip, yHint);
    _hintMeshes.push(yHint);
    /* X — lower face button. Same yaw / pitch as Y, just shifted
     * forward along the controller (toward the trigger) by 16 mm so
     * the two ringed labels stack neatly without overlapping. */
    const xHint = makeButtonHint("X", "Switch arrow");
    const xOuter = new THREE.Group();
    xOuter.position.set(0.002, 0.025, -0.062 + 0.016);
    xOuter.rotation.set(-Math.PI / 2 + 0.25, 0, 0);
    xOuter.add(xHint);
    grip.add(xOuter);
    _hintMeshes.push(xHint);
  }

  controller1.addEventListener("connected", (e) => {
    if (e.data?.handedness) handToCtrl[e.data.handedness] = controllerGrip1;
    if (e.data?.handedness === "right") bindRightHint(controllerGrip1);
    if (e.data?.handedness === "left") bindLeftHint(controllerGrip1);
  });
  controller2.addEventListener("connected", (e) => {
    if (e.data?.handedness) handToCtrl[e.data.handedness] = controllerGrip2;
    if (e.data?.handedness === "right") bindRightHint(controllerGrip2);
    if (e.data?.handedness === "left") bindLeftHint(controllerGrip2);
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

/** Master UI-visibility toggle. Hides the FPS panel + the bots.js
 *  HUD layer (minimap, compass ribbon, combat HUD). The crosshair,
 *  damage flashes, and controller button hints stay visible — they
 *  are either critical aiming/feedback or live on the controller in
 *  physical space (so hiding them would just leave the player staring
 *  at unlabelled buttons). Bound to the left controller's Y button
 *  and exposed as `brutalistVR8.toggleUI()`. */
function toggleUIVisibility() {
  const next = !getUIVisible();
  setUIVisible(next);
  if (vrFps.mesh) vrFps.mesh.visible = next && SHOW_FPS;
  console.log(`[ui] visibility → ${next ? "on" : "off"}`);
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
    /* Y button (left, button[5]) → master UI-visibility toggle. The
     * matching "Y Toggle UI" hint sits on the left controller. Editor
     * mode (the previous Y binding) is no longer wired to a button —
     * it stays accessible via `brutalistVR8.toggleEditor()` in the
     * console and via `?editor=1`, but the live binding is gone so
     * accidental presses during combat just hide/show the HUD instead
     * of switching locomotion mid-fight. */
    if (source.handedness === "left"
        && source.gamepad.buttons?.[5]?.pressed) {
      yPressed = true;
    }
  }
  if (yPressed && !yButtonWasPressed) toggleUIVisibility();
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

  /* Tick the controller-hint pulse animation (small, no-op when no
   * hints are bound). */
  if (_hintMeshes.length > 0) {
    const now = performance.now();
    for (const h of _hintMeshes) {
      if (h.userData?.pulseTick) h.userData.pulseTick(now);
    }
  }

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
  /* Pre-load placeholder: solid grey background + matching fog. The
   * EXR sky takes over once it loads (a few hundred ms later); until
   * then we want a calm flat-grey rather than black so the first
   * frames don't flash dark. The fog density and `?skyhorizon=`
   * override are unchanged from the previous design.
   *
   * Density 0.025 + 5×5 active window + ±90 m sun-shadow frustum:
   *     d=60 m  (shadow cutoff edge): 89 % fogged
   *     d=80 m:                       98 % fogged
   *     d=90 m  (shadow frustum edge): 99.4 % fogged
   *     d=160 m (load/unload boundary): ~100 %
   *
   * Tunable: `?fogdensity=` (1/1000s, default 25 → 0.025).
   *          `?skyhorizon=` (hex w/o #) — fallback sky/fog colour
   *                          when the EXR fails to load. */
  scene.background = new THREE.Color(SKY_HORIZON_HEX);
  const fogDensity = readIntParam("fogdensity", 25) / 1000;
  scene.fog = new THREE.FogExp2(SKY_HORIZON_HEX, fogDensity);
  scene.add(cameraRig);

  /* Sky + IBL.
   *
   * The local overcast EXR fills both roles:
   *   1. `scene.environment` — drives PBR ambient lighting (the
   *      reflection of the sky on metalness ≥ 0 surfaces, the soft
   *      sky-blue tint on the floor, etc).
   *   2. `scene.background` — drawn as the actual sky dome the
   *      player sees.
   *
   * To preserve the "no sector pop-in" guarantee we previously got
   * from a solid-grey sky, we ALSO retune the fog colour to match
   * the EXR's mean LINEAR RGB. The sky is overcast by design (≈
   * uniform grey), so per-pixel deviation from the mean is small
   * and the slab-fade-into-fog/sky transition stays nearly
   * invisible across the dome.
   *
   * `?hdr=0` opts back into the old solid-grey-only behaviour. The
   * EXR is still used as `scene.environment` in that mode (it
   * doesn't cost anything extra and the IBL contribution is
   * desirable regardless). */
  setStatus("Loading sky…");
  try {
    /* Force Float32 pixel data so the CPU-side mean computation in
     * `sampleEquirectAverageLinear` doesn't have to deal with raw
     * half-float bits. The default would deliver a Uint16Array for
     * a half-float EXR, which my plain-arithmetic averaging
     * interprets as integers (= silent garbage values). */
    const exrLoader = new EXRLoader();
    exrLoader.setDataType(THREE.FloatType);
    const envTexture = await exrLoader.loadAsync(ENV_URL);
    envTexture.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = envTexture;
    scene.environmentIntensity = 0.45;
    if (USE_HDR) {
      scene.background = envTexture;
      /* Retune fog to the EXR's mean colour. Linear-space match —
       * three.js fog mixes in linear before tone-mapping, so we
       * want the linear avg, not the post-tonemap one. */
      const avg = sampleEquirectAverageLinear(envTexture);
      scene.fog.color.setRGB(avg.r, avg.g, avg.b, THREE.LinearSRGBColorSpace);
      console.info(
        `[brutalistVR8] sky: fog colour matched to EXR avg = `
        + `linear(${avg.r.toFixed(3)}, ${avg.g.toFixed(3)}, ${avg.b.toFixed(3)})`,
      );
    }
  } catch (e) {
    console.warn("EXR load failed — falling back to solid-grey sky.", e);
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
    /* Hide the desktop intro overlay the moment the headset takes over —
     * it would block the swap to immersive mode visually anyway, but
     * dropping display:none also stops the layout engine from re-running
     * the gradient/animation work behind the scene. */
    const intro = document.getElementById("intro-overlay");
    if (intro) intro.style.display = "none";
    /* Kick streaming music into life. The "Enter VR" click is the user
     * gesture that lets the AudioContext resume; we're still inside that
     * gesture's grace window when sessionstart fires. */
    try {
      ensureMusicStarted();
    } catch (e) {
      console.warn("[brutalistVR8] music start failed:", e);
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

  /* Boot the sector streamer. Initial 3×3 around (0,0) loads here.
   * Pass the renderer so the streamer can read max anisotropy for its
   * PBR concrete textures (2K, would otherwise alias at grazing angles). */
  initSectors(scene, { initialKey: "0,0", renderer });
  setOnSectorsChanged(({ currentKey, activeKeys }) => {
    /* Forward to bots so its anti-air manager can spawn / despawn
     * tower-mounted batteries (and their snitch escorts) along with
     * the procedural sectors that house them. The call is idempotent
     * — bots.js diffs against its own loaded set, so calling on every
     * stream tick is fine. */
    notifySectorsChanged(activeKeys);
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
  /* Clear the intro overlay's `Loading…` line — by the time we get here
   * the world is built and the only thing left is for the player to hit
   * the ENTER VR button. No technical readout in the user-facing intro. */
  setStatus("");

  /* Console API. Most v8 bake/preview commands removed. */
  window.brutalistVR8 = {
    /** Print streaming + scene state. */
    status() {
      const out = {
        currentSector: getCurrentSectorKey(),
        activeSectors: getActiveSectorKeys(),
        activeMeshes: getActiveSceneObjects().length,
        activeCollisionBoxes: getActiveCollisionBoxes().length,
        world: "infinite (procedurally streamed)",
        minimapWindow: `${GRID_HALF * 2 + 1}×${GRID_HALF * 2 + 1}`,
        sectorSize: SECTOR_SIZE,
        sunIntensity: sunLight?.intensity,
        playerXZ: [Math.round(cameraRig.position.x), Math.round(cameraRig.position.z)],
      };
      console.info("brutalistVR8.status:", out);
      return out;
    },
    /** Dump the archetype map for the (2*radius+1)² window centred on
     *  the player's current sector. The world is infinite, so this is
     *  always a sliding window — pass an explicit center/radius to
     *  inspect somewhere else. */
    sectorMap(radius = GRID_HALF, centerKey) {
      const metas = getAllSectorMetas(centerKey || getCurrentSectorKey(), radius);
      const cx = metas[0].sx + radius;
      const cz = metas[0].sz + radius;
      const rows = [];
      for (let dz = -radius; dz <= radius; dz++) {
        const cells = [];
        for (let dx = -radius; dx <= radius; dx++) {
          const m = metas.find((mm) => mm.sx === cx - radius + dx && mm.sz === cz - radius + dz);
          cells.push(m ? m.archetype.padEnd(15) : "—".padEnd(15));
        }
        rows.push(cells.join(" "));
      }
      console.info(
        `brutalistVR8.sectorMap (centred on ${centerKey || getCurrentSectorKey()}, ` +
          `radius ${radius}; top row = north, left col = west):\n` + rows.join("\n"),
      );
      return metas;
    },
    /** Set sun intensity at runtime. */
    setSun(v) {
      if (sunLight) sunLight.intensity = v;
      console.info("brutalistVR8.setSun:", v);
    },
    /** Manually toggle editor (free-fly) ↔ physics locomotion. The Y-button
     * shortcut is no longer wired (Y now toggles UI); this console call
     * is the only way to switch locomotion modes at runtime. */
    toggleEditor() {
      toggleLocomotionMode();
      return locomotionMode;
    },
    /** Toggle the HUD layer (FPS, minimap, compass ribbon, combat HUD)
     *  on/off. Mirror of the left-controller Y button. Crosshair,
     *  damage flashes, and controller hints stay visible. */
    toggleUI() {
      toggleUIVisibility();
      return getUIVisible();
    },
    /** Set UI visibility to a specific state (true/false). */
    setUI(v) {
      const want = !!v;
      if (want !== getUIVisible()) toggleUIVisibility();
      return getUIVisible();
    },
    /** Switch the minimap orientation mode at runtime. Pass "north" for
     *  a static (north-up) map with a heading triangle (default,
     *  recommended for VR), or "heading" / "rotating" for a player-
     *  forward-up map that spins as you turn. The compass ribbon at
     *  the top of the FOV is unaffected — it always shows absolute
     *  bearing. Equivalent to the URL param `?compass=`. */
    setCompass(mode) {
      const m = (mode || "").toLowerCase();
      if (m !== "north" && m !== "heading" && m !== "rotating" && m !== "static") {
        console.warn('brutalistVR8.setCompass: pass "north" or "heading"');
        return getCompassMode();
      }
      const norm = (m === "rotating") ? "heading" : (m === "static") ? "north" : m;
      setCompassMode(norm);
      console.info("brutalistVR8.setCompass:", norm);
      return norm;
    },
    /** Toggle the stochastic-sampling anti-repetition shader at runtime.
     *  When OFF, slabs and ground revert to a single-tap PBR sample —
     *  texture pattern repeats become visible again, but the GPU skips
     *  ~3-4× of the fragment-shader texture-fetch work, restoring
     *  performance on lower-end devices. The macro tint, per-slab UV
     *  jitter, and per-slab tint jitter all stay on (they're free).
     *  Equivalent boot flag: `?antirep=0`.
     *  Examples:
     *    brutalistVR8.setAntiRep(false)   // disable for perf testing
     *    brutalistVR8.setAntiRep(true)    // re-enable
     *    brutalistVR8.toggleAntiRep()     // flip current state
     */
    setAntiRep(v) {
      setAntiRepetition(!!v);
      console.info("brutalistVR8.setAntiRep:", getAntiRepetition());
      return getAntiRepetition();
    },
    toggleAntiRep() {
      setAntiRepetition(!getAntiRepetition());
      console.info("brutalistVR8.toggleAntiRep:", getAntiRepetition());
      return getAntiRepetition();
    },
    /** Master textures on/off switch. When OFF, every slab + ground
     *  material has its map / normalMap / aoMap / roughnessMap /
     *  metalnessMap nulled, and the shader recompiles to use ZERO
     *  texture samples. The per-slab tint multipliers and the macro
     *  brightness wave keep working — surfaces become flat-tinted
     *  concrete shades with subtle world-space variation.
     *
     *  Use cases:
     *    - Diagnose how much of the frame budget is the texture
     *      pipeline (stochastic + sampling + decompression).
     *    - Ship a "fast mode" for low-end hardware.
     *    - Quick sanity check that geometry / lighting / fog all
     *      look right independent of texture content.
     *
     *  Equivalent boot flag: `?textures=0`.
     *  Examples:
     *    brutalistVR8.setTextures(false)  // disable
     *    brutalistVR8.setTextures(true)   // re-enable
     *    brutalistVR8.toggleTextures()    // flip
     */
    setTextures(v) {
      setTextures(!!v);
      console.info("brutalistVR8.setTextures:", getTextures());
      return getTextures();
    },
    toggleTextures() {
      setTextures(!getTextures());
      console.info("brutalistVR8.toggleTextures:", getTextures());
      return getTextures();
    },
    /** Pick which hand holds the bow. Defaults to "left" (right hand
     *  draws). Equivalent in-VR control: A button on the right
     *  controller toggles handedness on the fly.
     *  Examples:
     *    brutalistVR8.setBowHand("right")
     *    brutalistVR8.toggleBowHand()
     *    brutalistVR8.getBowHand()  // → "left" | "right"
     */
    setBowHand(hand) {
      const h = setBowHand(hand);
      console.info("brutalistVR8.setBowHand:", h);
      return h;
    },
    toggleBowHand() {
      const h = toggleBowHand();
      console.info("brutalistVR8.toggleBowHand:", h);
      return h;
    },
    getBowHand() { return getBowHand(); },
    /** Switch which arrow type the bow nocks next.
     *  Values: "normal" (white-tip practice arrow, baseline damage)
     *          "explosive" (sphere-tip, 4 m blast on impact / mid-flight
     *           detonate via bow-hand trigger, 10 s recharge after use).
     *  In-VR equivalent: X button on the left controller toggles.
     *  Examples:
     *    brutalistVR8.setArrowType("explosive")
     *    brutalistVR8.toggleArrowType()
     *    brutalistVR8.getArrowType()
     */
    setArrowType(t) {
      const v = setArrowType(t);
      console.info("brutalistVR8.setArrowType:", v);
      return v;
    },
    toggleArrowType() {
      const v = toggleArrowType();
      console.info("brutalistVR8.toggleArrowType:", v);
      return v;
    },
    getArrowType() { return getArrowType(); },

    /* ── Run control ─────────────────────────────────────────────────
     *  brutalistVR8.restartRun() — wipe run state and start a fresh
     *  wave-1 immediately (used by the in-VR Play Again trigger).
     *  brutalistVR8.topScores()  — readout of persisted leaderboard.
     */
    restartRun() {
      restartRun();
      console.info("brutalistVR8.restartRun: new run started");
    },
    topScores() {
      const s = getTopScores();
      console.info("brutalistVR8.topScores:", s);
      return s;
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
    /** And this for the HUD minimap. The world is infinite, so the
     *  metadata window is recomputed each call centred on the player's
     *  current sector — the minimap shows a 9×9 view that slides with
     *  the player rather than a fixed world grid. */
    getSectorInfo: () => {
      const current = getCurrentSectorKey();
      return {
        current,
        active: getActiveSectorKeys(),
        all: getAllSectorMetas(current, GRID_HALF),
        sectorSize: SECTOR_SIZE,
        gridHalf: GRID_HALF,
      };
    },
    /** Look up the tallest-tower anchor for a sector key. Returns
     *  [{x, y, z, yaw, w, d, ...}] (length 0 or 1). bots.js calls
     *  this when a sector loads to decide where to plant an
     *  AntiAirTurret. */
    getSectorTowerAnchors,
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
    /** Per-AA snapshot: position, FSM state, aim-focus, sees-player,
     *  trackable (in passive-track range), and live component HP.
     *  Use to verify HQs are spawning and engaging.
     *  Examples:
     *    brutalistVR8.bots.aaDebug()
     *    console.table(brutalistVR8.bots.aaDebug())
     */
    aaDebug: () => {
      const out = getAntiAirDebug();
      console.info(`[brutalistVR8] anti-air emplacements (${out.length}):`);
      console.table(out.map((e) => ({
        sector: e.sector,
        state: e.state,
        dead: e.dead,
        sees: e.sees,
        relay: e.underRelay,
        trackable: e.trackable,
        distM: e.distToPlayer,
        focus: e.aimFocus,
        coreShielded: e.coreShielded,
        pos: e.pos.join(","),
      })));
      return out;
    },
    killAll: killAllDrones,
    jumpToWave,
    spawn: spawnSpecificDrone,
  };
  /* The initial sector batch was loaded by initSectors() *before*
   * setOnSectorsChanged() registered our callback, so the streamer
   * never told bots about those sectors. Push the current active
   * set in now so anti-air emplacements get planted on the
   * already-loaded towers. After this, every subsequent stream tick
   * goes through setOnSectorsChanged → notifySectorsChanged. */
  notifySectorsChanged(getActiveSectorKeys());
  console.info("[brutalistVR8] console API ready — try brutalistVR8.status() or brutalistVR8.sectorMap()");
}

init().catch((e) => {
  console.error(e);
  setStatus(String(e));
});
