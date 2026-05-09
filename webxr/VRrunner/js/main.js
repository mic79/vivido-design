/**
 * VRrunner — fork of brutalistVR8: static runner interior + same WebXR
 * locomotion (grab/throw, stick move). Procedural brutalist sectors are
 * disabled here; collision comes from `runnerLevel.js` unless `?map=1`
 * (default), which uses `streamSandboxMap.js` (100 m 3D cells, 3³ active).
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { EXRLoader } from "three/addons/loaders/EXRLoader.js";
import { XRControllerModelFactory } from "three/addons/webxr/XRControllerModelFactory.js";
/* Solid black backdrop; **radial distance fog** (same RGB as sky) so fogged pixels match
 * the sky without swimming when the headset rotates (unlike stock `THREE.Fog` depth fog).
 * Default **2500 m** fog `far` and **2500 m** camera far clip (`?fogfar=` / `?camerafar=`).
 * EXR is `scene.environment` (IBL) only. `?skyhorizon=` tints fog+backdrop hex. */
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { FilmPass } from "three/addons/postprocessing/FilmPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import {
  getCurrentSectorKey,
  getActiveSectorKeys,
  getAllSectorMetas,
  SECTOR_SIZE,
  GRID_HALF,
  setAntiRepetition,
  getAntiRepetition,
  setTextures,
  getTextures,
  getSectorTowerAnchors,
} from "./sectors.js";
import {
  initRunnerLevel,
  disposeRunnerLevel,
  getRunnerCollisionBoxes,
  getRunnerThrowAssist,
  triggerRunnerDuck,
  applyRunnerCameraDuck,
  getRigSampleHeightMul,
  getRunnerRadiusMul,
  RUNNER_STANDING_EYE_Y,
  tryShatterRunnerGlassArrow,
  tryShatterRunnerGlassPlayer,
  updateRunnerGlassShards,
  getRunnerFloorY,
  RUNNER_PIT_RESET_Y,
  RUNNER_TOP_FLOOR_SURFACE_Y,
  resolveGlbMeshCollisions,
  getGlbFloorSupport,
  getGlbFloorY,
} from "./runnerLevel.js";
import {
  initStreamSandbox,
  disposeStreamSandbox,
  updateStreamSandbox,
  whenSandboxCityReady,
  getSandboxCollisionBoxes,
  getSandboxFloorY,
  getSandboxDefaultSpawn,
  getCurrentSandboxSectorKey,
  getActiveSandboxSectorKeys,
  SANDBOX_SECTOR,
} from "./streamSandboxMap.js";
import {
  setRadialFogParams,
  setRadialFogColorHex,
  patchRadialFogOntoObjectTree,
} from "./radialFogMaterials.js";
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
  resetRunWithoutStartingCombat,
  getTopScores,
  setBattleOnBEnabled,
  clearRunnerArcheryVolleys,
  applyGrappleWinchStep,
  isGrappleHookActive,
  isArcheryDrawActive,
} from "./bots.js";
import {
  preloadGlideAudio,
  resumeGlideAudio,
  tickGlideAudio,
  muteGlideAudio,
} from "./glideAudio.js";

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

/** `?map=0` — furnished runner interior. `?map=1` or omit — streaming sandbox. */
function readMapIndex() {
  try {
    const m = new URLSearchParams(window.location.search).get("map");
    if (m == null || m === "") return 1;
    const n = parseInt(m, 10);
    return n === 0 ? 0 : 1;
  } catch (_) {
    return 1;
  }
}

const RUNNER_MAP_ID = readMapIndex();

/** Sun light intensity (overdriven so concrete actually triggers bloom and shadows
 *  read with real contrast). */
const SUN_INTENSITY = readFloatParam("sun", 4.0);
/** Overcast EXR is loaded as `scene.environment` (IBL); visible sky is solid BattleVR `<a-sky>`. */

/** `false` = no sun shadow maps (saves GPU / avoids shadow-map cost). Set `true` to restore PCFSoft shadows. */
const DYNAMIC_SHADOWS = true;

/** Perspective far clip (m) — default matches fog so the GPU culls past the fog wall. */
const CAMERA_FAR = readFloatParam("camerafar", 2500);

/** Radial fog end distance (m); `fognear` must be less than `fogfar`. */
const FOG_LINEAR_FAR_M = readFloatParam("fogfar", 2500);
const FOG_LINEAR_NEAR_M = Math.min(
  Math.max(1, readFloatParam("fognear", 1250)),
  FOG_LINEAR_FAR_M - 1,
);

/** Solid backdrop (must match fog colour for clean hiding). Default `#000`; `?skyhorizon=11` → `#000011`. */
const SKY_HORIZON_HEX = (() => {
  try {
    const v = new URLSearchParams(window.location.search).get("skyhorizon");
    if (v) return parseInt(v, 16);
  } catch (_) { /* noop */ }
  return 0x000000;
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
/** Between rig and camera: negative Y while ducking (XR-safe crouch). */
let crouchViewGroup;
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
let fpsStackElement;
let speedometerElement;
let speedometerLastText_ = "";
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
  /** Invalidation token for canvas redraw (FPS + air readout). */
  lastSig: "",
};
const orbitTarget = new THREE.Vector3(0, 4, 0);
/** Where the bots module teleports the player on respawn (set at init + optional LS restore only). */
const playerSpawnPos = new THREE.Vector3(0, 0, 0);

/** Last rig position for reload / `respawnPlayer` (same map id only). */
const LS_LAST_RIG_KEY = "VRrunner:lastRigPos:v1";
const LS_SAVE_INTERVAL_MS = 2000;
let lastLsSaveRtMs_ = 0;

function saveLastRigPositionToLs_() {
  if (!cameraRig) return;
  if (getWorldCollisionBoxes().length === 0) return;
  try {
    const p = cameraRig.position;
    const payload = { map: RUNNER_MAP_ID, x: p.x, y: p.y, z: p.z, t: Date.now() };
    localStorage.setItem(LS_LAST_RIG_KEY, JSON.stringify(payload));
    /* Do not copy into `playerSpawnPos` — that made respawn / Play Again jump back into
     * the same stuck interior the autosave had recorded. */
  } catch (_) {
    /* private mode / quota */
  }
}

/** @returns {boolean} true if `playerSpawnPos` was restored from storage */
function tryRestoreLastRigPositionFromLs_() {
  try {
    const raw = localStorage.getItem(LS_LAST_RIG_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (!o || typeof o.map !== "number" || o.map !== RUNNER_MAP_ID) return false;
    const { x, y, z } = o;
    if (![x, y, z].every((v) => typeof v === "number" && Number.isFinite(v))) return false;
    playerSpawnPos.set(x, y, z);
    return true;
  } catch (_) {
    return false;
  }
}

/** Drop bad saved coords, set spawn to map default, optionally move rig (unstuck from GLB interior). */
function resetPlayerSpawnToDefault_() {
  try {
    localStorage.removeItem(LS_LAST_RIG_KEY);
  } catch (_) {
    /* ignore */
  }
  if (RUNNER_MAP_ID === 0) {
    playerSpawnPos.set(0, RUNNER_TOP_FLOOR_SURFACE_Y, -4);
  } else {
    getSandboxDefaultSpawn(playerSpawnPos);
  }
}

function teleportRigToSpawnAnchor_() {
  if (!cameraRig) return;
  cameraRig.position.copy(playerSpawnPos);
  rigVelocity.set(0, 0, 0);
  jumpsRemaining = MAX_JUMPS;
  parkourJumpGlideBlockSec_ = 0;
  grabState.left.active = false;
  grabState.right.active = false;
  grabState.left.history.length = 0;
  grabState.right.history.length = 0;
}

let controller1;
let controller2;
let controllerGrip1;
let controllerGrip2;
const vrInput = { leftStick: { x: 0, y: 0 }, rightStick: { x: 0, y: 0 } };
/** Stick locomotion scale (m/s at full deflection). Parkour runs are often ~6–9 m/s bursts; we cap lower. */
const moveSpeed = 3.5;
/** Maps stick m/s into glide wind “airspeed” so light walk vs full sprint read clearly in volume/pitch. */
const LOCOMOTION_AUDIO_UPSCALE = 1.9;
const rotateSpeed = 120;
const verticalSpeed = 2;
const deadzone = 0.15;

/* ── Locomotion modes ─────────────────────────────────────────────────── */
let locomotionMode = "physics";
/** Earth-like vertical acceleration (m/s²). The old brutalistVR8 “moon”
 *  value (~1.6) was for floaty combat; this project is grounded runner. */
const PLAYER_GRAVITY = 9.81;
const AIR_DAMPING = 0.4;
/** Wingsuit: head-relative lateral sum + grip spread + 3D hand distance; latch/exit + pitch use all three. */
const GLIDE_LAT_ENTER = 0.44;
const GLIDE_SEP_ENTER = 0.36;
const GLIDE_HAND_ENTER = 0.52;
/** Exit as soon as any “arms in” metric fails (shoulder tuck / nock pose). */
const GLIDE_LAT_EXIT = 0.34;
const GLIDE_SEP_EXIT = 0.28;
const GLIDE_HAND_EXIT = 0.4;
/** Aerodynamic “pitch” from controller spacing (not head forward/back). */
const GLIDE_PITCH_SEP_MIN = 0.18;
const GLIDE_PITCH_SEP_MAX = 0.72;
const GLIDE_PITCH_DIST_MIN = 0.28;
const GLIDE_PITCH_DIST_MAX = 0.95;
/** Below this lateral sum, wing strength → 0 (arms in / narrow). */
const GLIDE_WING0 = 0.42;
/** Lateral sum (m) mapped to wing = 1 — set above real max T so span can grow past “shoulder” without saturating. */
const GLIDE_LAT_FULL = 1.02;
/** Narrow pose: extra downward accel (fraction of g), strongest when wing→0. */
const GLIDE_NARROW_FALL_G = 0.62;
/** Wide pose: extra horizontal parasite drag scale (was too strong — killed |v| after pull-out). */
const GLIDE_WIDE_PARASITE = 0.006;
/** Gravity multiplier at full wing (arms wide). */
const GLIDE_GRAV_MUL = 0.64;
/** Extra downward acceleration when arms are narrow (tuck), as a fraction of g. */
const GLIDE_TUCK_EXTRA_G_FRAC = 0.32;
/** Reference airspeed (m/s) for lift / forward scaling; uses horizontal + fall component. */
const GLIDE_DYN_REF_SPEED = 6.8;
/** Lift scales ~ wing × dyn² × this (m/s²), before cap. */
const GLIDE_LIFT_K = 19;
const GLIDE_LIFT_MAX = 19;
const GLIDE_SPEED_TO_LIFT = 1.18;
/** Ref for linear speed→lift (was 52): uncapped high‑40s |v| fought cruise and parked ~46 m/s. */
const GLIDE_SPEED_TO_LIFT_REF_MAX = 30;
/** Pitch (hands vs head): flare adds lift, dive adds sink + forward. */
const GLIDE_PITCH_LIFT = 2.85;
const GLIDE_PITCH_DIVE_G = 3.6;
/** Direct upward accel from flare pitch (pull hands back / up), m/s² at full wing+dyn. */
const GLIDE_PITCH_FLARE_VERT = 7.2;
const GLIDE_FORWARD_BASE = 2.85;
const GLIDE_FORWARD_DYN = 10.5;
const GLIDE_FORWARD_DIVE = 7.2;
/** Multiplier on glide forward accel along look (base+dyn+dive+plunge in `forwardRaw`). */
const GLIDE_FORWARD_MOMENTUM_MUL = 2;
/** Minimum dyn (0..1) from airspeed so a fresh spread still has bite. */
const GLIDE_DYN_FLOOR = 0.24;
/** “Airspeed” for stall + speed→lift: hypot(hSpeed, |vy| * STALL_VY_WEIGHT). Uses |vy| so grapple
 *  winch (often mostly vertical) and fast falls still open the lift trade, not only running XZ speed. */
/** Upward motion also builds dynamic pressure for glide dyn (winch / flare), not only downward fall. */
const GLIDE_UPWIND_FOR_DYN = 0.48;
/** Wide + lift diverts some forward push into the climb (slightly less pure forward). */
const GLIDE_WIDE_FORWARD_DIVERT = 0.16;
/** Fast fall + spread: extra accel along **look**; scales with airspeed for dive entry. */
const GLIDE_PLUNGE_FORWARD_ACCEL = 18;
const GLIDE_PLUNGE_FORWARD_V0 = 4.5;
const GLIDE_PLUNGE_FORWARD_V1 = 13;
/** While `|vy|` is in plunge band, scale down forward divert so lift does not eat the new forward shove. */
const GLIDE_PLUNGE_DIVERT_RELAX = 0.78;
/** Fast fall used to fake a strong dive and kill pull-out; keep small so opening the suit uses vertical speed, not extra sink. */
const GLIDE_PLUNGE_PITCH_BIAS = 0.22;
/** At full plunge + wing, effective gravity multiplier scales by (1 - this * plungeTurn * easeWing). */
const GLIDE_PLUNGE_GRAV_REDUCTION = 0.16;
/** After ANY successful air jump — no glide latch while this runs (clears on land). Unconditional. */
const GLIDE_AFTER_PARKOUR_JUMP_BLOCK_S = 3.55;
/** Must be falling at least this fast (m/s, downward) to start a glide — avoids apex/micro latch. */
const GLIDE_LATCH_MIN_DOWNWARD_SPEED = 2.1;
/** Pull-out while descending (vy < 0 gate in code). */
const GLIDE_FALL_SPEED_LIFT = 9;
/** e-folding time (s) for redirecting vertical speed into horizontal along look while gliding. ~0.32s → fast pull-out from terminal fall. */
const GLIDE_FALL_LEVEL_TAU = 0.32;
/** While latched, fall→forward uses at least this wing blend so narrow poses don’t kill redirect. */
const GLIDE_REDIRECT_EASE_MIN = 0.68;
/** Above this |v| (m/s): add 20%×|v|×dt to `vy` (uses frame-start |v|). Same edge for stall blend hi.
 * Hard “no faster than frame-start×e^(−5%×dt)” cap applies **only** when frame-start |v| ≥ this — otherwise gravity cannot accelerate a slow step-off. */
const GLIDE_CRUISE_SPEED_MIN = 20;
const GLIDE_CRUISE_VEL_FRAC_PER_S = 0.05;
const GLIDE_CRUISE_UP_FRAC_PER_S = 0.2;
/** Stall uses `hypot(hSpeed, |downward|)` so **falling** builds “air energy” and recovers lift (wingsuit-like); total |v| alone stayed ~2 m/s off a roof and never woke the wing. */
const GLIDE_STALL_AIR_LO = 3.5;
const GLIDE_STALL_LIFT_KILL = 0.88;
const GLIDE_STALL_FWD_FLOOR = 0.1;
/** Extra downward accel (×g) when stalled — net fall increases as airspeed drops under ~20 m/s. */
const GLIDE_STALL_EXTRA_G = 0.62;
/** Hard ceiling for glide-only upward speed (above jump cap; climb drag still kills sustained float). */
const GLIDE_MAX_VY_UP_ABS = 9.15;
const GLIDE_MAX_VY_UP_BASE = 2.55;
const GLIDE_MAX_VY_UP_DYN = 6.35;
/** Light fade at extreme climb only (jetpack-like baseline; drain does the real limit). */
const GLIDE_LIFT_CLIMB_SOFT = 2.2;
const GLIDE_LIFT_CLIMB_HARD = 9;
const GLIDE_SPEED_LIFT_CLIMB_SOFT = 2.8;
const GLIDE_SPEED_LIFT_CLIMB_HARD = 9.5;
/** Wingsuit lift scales with **total** speed |v| (m/s): straight fall builds |v| toward MAX_FALL_SPEED fastest; below LO lift fades (sink / stall); above HI full pitch authority. */
const GLIDE_LIFT_SPEED_LO = 1.25;
const GLIDE_LIFT_SPEED_HI = 14;
/** Yaw rate scale (deg/s at full arm-height asymmetry, scaled by horizontal speed). */
const GLIDE_YAW_DEG_S = 92;
/** Near-1: glide must not bleed horizontal energy to a fake “cruise” band (~17 m/s). */
const GLIDE_AIR_DAMPING = 0.993;
/** Safety ceiling only — must stay above plausible |v| after terminal pull-out. */
const GLIDE_MAX_HORIZ = 72;
/** Forward glide thrust fades toward `FWD_THRUST_FAST_MUL` as |v| crosses this band (still scaled by wing span). */
const GLIDE_FWD_THRUST_FAST_LO = 20;
const GLIDE_FWD_THRUST_FAST_HI = 34;
const GLIDE_FWD_THRUST_FAST_MUL = 0.2;
/** Lift needs forward airflow (XZ); stops level jet-lift at modest run speed. */
const GLIDE_LIFT_HS_LO = 2.8;
const GLIDE_LIFT_HS_HI = 11;
/** Same lift gate from downward airspeed (m/s) so steep fall isn’t “no lift until hSpeed builds”). */
const GLIDE_LIFT_PLUNGE_LO = 2.5;
const GLIDE_LIFT_PLUNGE_HI = 15;
/** Per-second horizontal retention on flat ground (`v *= pow(this, dt)`). Lower = faster stop. */
const GROUND_FRICTION = 0.68;
/** Gentler damping on GLB ramps so uphill stick input isn’t eaten every frame. */
const SLOPE_GROUND_FRICTION = 0.92;
/** Grounded + stick in dead zone: world XZ speed below this (m/s) snaps to 0 to kill residual drift. */
const RIG_DRIFT_VEL_EPS = 0.085;
/** In air, same snap for tiny horizontal carry (throws / mesh nudges) when not grabbing. */
const RIG_AIR_DRIFT_VEL_EPS = 0.06;
/** Grab-release impulse scale — kept moderate so throws feel like body
 *  English, not rocket hops. */
const THROW_BOOST = 2.2;
const VEL_HISTORY_FRAMES = 4;
/** ~27 km/h cap — near elite sprint; sustained parkour is often lower. */
const MAX_HORIZONTAL_SPEED = 7.5;
/** Upward cap (m/s) — jumps / grapple. */
const MAX_VERTICAL_SPEED = 6.3;
/** Downward cap (m/s) in air without glide. ~2× prior cap so terminal speed converts visibly in wingsuit. */
const MAX_FALL_SPEED = 56;
/** After grapple winch ends, upward speed may briefly exceed jump cap (rope built real speed). */
const GRAPPLE_POST_WINCH_UP_CAP = 20;
const GRAPPLE_POST_WINCH_CARRY_S = 0.95;
/** Single air jump — refilled only when truly landed (see updatePhysicsMovement). */
const MAX_JUMPS = 1;
const JUMP_THRESHOLD = 0.62;
const handToCtrl = { left: null, right: null };
/** True while wingsuit glide hysteresis is active (spread arms while falling). */
let glideLatch_ = false;
/** |v| at start of this frame’s glide wing block — hard ceiling after collision = this × exp(−cruise×dt). */
let glideFrameS0_ = -1;
/** >0: parkour jump / wall jump — do not allow new glide latch (run+jump+arms wide). */
let parkourJumpGlideBlockSec_ = 0;
let prevGrappleHookActive_ = false;
let grapplePostWinchCarrySec_ = 0;
const rigVelocity = new THREE.Vector3();
/** Merged OBB slab + GLB mesh support for snapping, grounding, and slope locomotion. */
const groundMerged = {
  valid: false,
  y: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  /** True when support comes from GLB mesh (not OBB slab) — BattleVR-style hull owns contact. */
  fromGlb: false,
};
const _ghTmp = { y: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };
const _deltaHoriz = new THREE.Vector3();
const _deltaProj = new THREE.Vector3();
const _vTan = new THREE.Vector3();
/** Ground normal nearly vertical → flat floors (OBB + subtle slopes use old friction path). */
const SLOPE_FLAT_NY = 0.988;
/** EMA on GLB ramp plane — kills tiny per-frame normal/point jumps from mesh sampling (uphill stutter). */
const GLB_RAMP_PLANE_SMOOTH = 0.3;
let _gRampPlaneSmActive = false;
const _gRampSmN = new THREE.Vector3(0, 1, 0);
const _gRampSmP = new THREE.Vector3();

/**
 * After raw `getMergedGroundSupport`, low-pass **normal** and **support point** on GLB
 * slopes only so stick projection / soft snap / friction do not jitter triangle-to-triangle.
 */
function stabilizeGlbRampGroundPlane_() {
  if (!groundMerged.valid || !groundMerged.fromGlb || groundMerged.normal.y >= SLOPE_FLAT_NY) {
    _gRampPlaneSmActive = false;
    return;
  }
  const a = GLB_RAMP_PLANE_SMOOTH;
  const rx = groundMerged.normal.x;
  const ry = groundMerged.normal.y;
  const rz = groundMerged.normal.z;
  const px = groundMerged.point.x;
  const py = groundMerged.point.y;
  const pz = groundMerged.point.z;
  if (!_gRampPlaneSmActive) {
    _gRampSmN.set(rx, ry, rz);
    _gRampSmP.set(px, py, pz);
    _gRampPlaneSmActive = true;
  } else {
    _gRampSmN.x += (rx - _gRampSmN.x) * a;
    _gRampSmN.y += (ry - _gRampSmN.y) * a;
    _gRampSmN.z += (rz - _gRampSmN.z) * a;
    if (_gRampSmN.lengthSq() > 1e-10) _gRampSmN.normalize();
    _gRampSmP.x += (px - _gRampSmP.x) * a;
    _gRampSmP.y += (py - _gRampSmP.y) * a;
    _gRampSmP.z += (pz - _gRampSmP.z) * a;
  }
  groundMerged.normal.copy(_gRampSmN);
  groundMerged.point.copy(_gRampSmP);
  groundMerged.y = _gRampSmP.y;
}
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
const _glLw = new THREE.Vector3();
const _glRw = new THREE.Vector3();
const _glMid = new THREE.Vector3();
const _glHead = new THREE.Vector3();
const _glFwd = new THREE.Vector3();
const _glRight = new THREE.Vector3();
const _glRigFwd = new THREE.Vector3();
const _glRigRight = new THREE.Vector3();
const _glDiveDir = new THREE.Vector3();
const _glQuatW = new THREE.Quaternion();
const _glEul = new THREE.Euler();
const _worldUp = new THREE.Vector3(0, 1, 0);
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
 * Iterates only the OBBs returned by getWorldCollisionBoxes() — i.e.
 * boxes from the loaded 3×3 sector window. Total is typically 30–80
 * boxes; the 6-sample × 3-iteration scan is comfortably under 500
 * OBB tests/frame.
 */
function resolveAllCollisions(rigPos) {
  _wallSepHorizBest = 0;

  const xrCam = renderer.xr.getCamera();
  cameraRig.updateMatrixWorld(true);
  _headW.copy(xrCam.position).applyMatrix4(cameraRig.matrixWorld);

  const yMul = getRigSampleHeightMul();
  const rMul = getRunnerRadiusMul();
  for (let i = 0; i < RIG_SAMPLE_YS.length; i++) {
    _samples[i].x = rigPos.x;
    _samples[i].y = rigPos.y + RIG_SAMPLE_YS[i] * yMul;
    _samples[i].z = rigPos.z;
    _samples[i].m = PLAYER_RADIUS * rMul;
  }
  const head = _samples[_samples.length - 1];
  head.m = HEAD_MARGIN * Math.max(0.55, rMul);
  head.x = _headW.x;
  head.y = _headW.y;
  head.z = _headW.z;

  const boxes = getWorldCollisionBoxes();
  for (let iter = 0; iter < 3; iter++) {
    let pushedAny = false;
    for (const b of boxes) {
      /* Floor slabs are handled by `getRunnerFloorY()` (vertical snap) — skip
       * here so the sphere-radius sample doesn't push the player up off the
       * slab surface. Walls/ceilings are still full OBB push. */
      if (b.floorSlab) continue;
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

          /* Dominant horizontal separation ⇒ vertical wall contact (for wall jump). */
          _wallPushHoriz.set(_localPush.x, 0, _localPush.z);
          const hMag = _wallPushHoriz.length();
          const vMag = Math.abs(_localPush.y);
          if (hMag > 0.028 && vMag < 0.58 * (hMag + 1e-5) && hMag > _wallSepHorizBest) {
            _wallSepHorizBest = hMag;
            _wallSepDirXZ.copy(_wallPushHoriz).multiplyScalar(1 / hMag);
          }

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

  const geoHit = refreshWallProximityFromGeometry(rigPos);
  if (!geoHit && _wallSepHorizBest > 0.028) {
    wallJumpOutNormal.copy(_wallSepDirXZ);
    wallJumpSurfaceValidUntilMs = performance.now() + 220;
  }
}

/**
 * Capsule torso samples vs OBBs: detects “on a wall” even when there is no
 * penetration push this frame (sliding contact). Complements separation pushes.
 */
function refreshWallProximityFromGeometry(rigPos) {
  const boxes = getWorldCollisionBoxes();
  if (!boxes.length) return false;

  const yMul = getRigSampleHeightMul();
  const rMul = getRunnerRadiusMul();
  const sm = PLAYER_RADIUS * rMul;
  const pad = WALL_PROXIMITY_PAD;
  let bestGap = Infinity;
  let bestNx = 0;
  let bestNz = 0;

  for (let i = 0; i < RIG_SAMPLE_YS.length; i++) {
    const sx = rigPos.x;
    const sy = rigPos.y + RIG_SAMPLE_YS[i] * yMul;
    const sz = rigPos.z;

    for (const b of boxes) {
      _localPt.set(sx - b.cx, sy - b.cy, sz - b.cz).applyMatrix3(b.mInv);
      const hx = b.hx;
      const hy = b.hy;
      const hz = b.hz;
      const lx = _localPt.x;
      const ly = _localPt.y;
      const lz = _localPt.z;

      const inside = Math.abs(lx) <= hx && Math.abs(ly) <= hy && Math.abs(lz) <= hz;
      let dist;
      let gap;

      if (inside) {
        const ax = hx - Math.abs(lx);
        const ay = hy - Math.abs(ly);
        const az = hz - Math.abs(lz);
        const minA = Math.min(ax, ay, az);
        if (minA === ax) _wallNLoc.set(Math.sign(lx) || 1, 0, 0);
        else if (minA === ay) _wallNLoc.set(0, Math.sign(ly) || 1, 0);
        else _wallNLoc.set(0, 0, Math.sign(lz) || 1);
        dist = 0;
        gap = -minA;
      } else {
        const clx = Math.max(-hx, Math.min(hx, lx));
        const cly = Math.max(-hy, Math.min(hy, ly));
        const clz = Math.max(-hz, Math.min(hz, lz));
        const dx = lx - clx;
        const dy = ly - cly;
        const dz = lz - clz;
        dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 1e-7) continue;
        _wallNLoc.set(dx / dist, dy / dist, dz / dist);
        gap = dist - sm;
      }

      _wallNW.copy(_wallNLoc).applyMatrix3(b.m);
      const horiz = Math.hypot(_wallNW.x, _wallNW.z);
      if (horiz < 0.18) continue;
      if (Math.abs(_wallNW.y) > 0.86) continue;

      if (gap > pad) continue;

      if (gap < bestGap) {
        bestGap = gap;
        bestNx = _wallNW.x;
        bestNz = _wallNW.z;
      }
    }
  }

  if (bestGap < Infinity) {
    const h = Math.hypot(bestNx, bestNz);
    if (h > 1e-5) {
      wallJumpOutNormal.set(bestNx / h, 0, bestNz / h);
      wallJumpSurfaceValidUntilMs = performance.now() + 240;
      return true;
    }
  }
  return false;
}

/** Same wall proximity window as `tryApplyWallJump` (geometry + separation). */
function isWallContactValidForAirThrow() {
  if (performance.now() > wallJumpSurfaceValidUntilMs) return false;
  const wnx = wallJumpOutNormal.x;
  const wnz = wallJumpOutNormal.z;
  return wnx * wnx + wnz * wnz >= 0.028;
}

/**
 * Airborne grab-release: if we had wall contact, were moving into the wall,
 * and the throw pushes noticeably away from it, add a parkour kick.
 */
function tryApplyWallJump(impX, impY, impZ) {
  if (performance.now() > wallJumpSurfaceValidUntilMs) return;
  if (isGrounded()) return;
  if (impY > JUMP_THRESHOLD * 0.92) return;

  const wnx = wallJumpOutNormal.x;
  const wnz = wallJumpOutNormal.z;
  if (wnx * wnx + wnz * wnz < 0.028) return;

  const vx = _throwAssistVel.x;
  const vz = _throwAssistVel.z;
  const into = -(vx * wnx + vz * wnz);
  if (into < WALL_JUMP_INTO_SPEED) return;

  const hImp = Math.hypot(impX, impZ);
  if (hImp < WALL_JUMP_THROW_HORIZ_MIN) return;
  const tix = impX / hImp;
  const tiz = impZ / hImp;
  const away = tix * wnx + tiz * wnz;
  if (away < WALL_JUMP_THROW_AWAY_DOT) return;

  const scale = Math.min(1.45, into / 2.2) * (0.55 + 0.45 * away);
  rigVelocity.x += wnx * WALL_JUMP_KICK_HORIZ * scale;
  rigVelocity.z += wnz * WALL_JUMP_KICK_HORIZ * scale;
  rigVelocity.y += WALL_JUMP_KICK_UP * scale;
  parkourJumpGlideBlockSec_ = GLIDE_AFTER_PARKOUR_JUMP_BLOCK_S;
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
}

function ensureVrFpsPanel(parentCamera) {
  if (vrFps.mesh || !parentCamera) return;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 132;
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

function drawVrFpsPanel(fps, speedMps) {
  if (!vrFps.ctx) return;
  const sig = `${fps}|${speedMps.toFixed(2)}`;
  if (sig === vrFps.lastSig) return;
  vrFps.lastSig = sig;
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
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#9fd6ff";
  ctx.font = "500 30px system-ui, sans-serif";
  ctx.fillText(`${speedMps.toFixed(1)} m/s`, w - 20, 44);
  ctx.fillStyle = "#4fc3f7";
  ctx.font = "600 52px system-ui, sans-serif";
  ctx.fillText(`${fps}`, w - 70, 106);
  ctx.fillStyle = "#9fd6ff";
  ctx.font = "500 26px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("FPS", w - 58, 102);
  if (vrFps.texture) vrFps.texture.needsUpdate = true;
}

/** Call after physics + collision so speed matches integrated |v| (any direction). */
function syncFpsStackHud() {
  if (!SHOW_FPS || !getUIVisible()) return;
  const speedMps = rigVelocity.length();
  if (speedometerElement) {
    const t = `${speedMps.toFixed(1)} m/s`;
    if (t !== speedometerLastText_) {
      speedometerElement.textContent = t;
      speedometerLastText_ = t;
    }
  }
  drawVrFpsPanel(fpsState.display, speedMps);
}

/* ── VR controllers ───────────────────────────────────────────────────── */

/**
 * Build a floating label on the grip (e.g. "B Toggle Battle") — mirrors VRKnockout’s
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
  /* Same parent as the headset camera so crouchViewGroup Y offset moves
   * hands + view together (controllers were on cameraRig before). */
  const xrHandsParent = crouchViewGroup;
  controller1 = renderer.xr.getController(0);
  xrHandsParent.add(controller1);
  controllerGrip1 = renderer.xr.getControllerGrip(0);
  controllerGrip1.add(factory.createControllerModel(controllerGrip1));
  xrHandsParent.add(controllerGrip1);
  controller2 = renderer.xr.getController(1);
  xrHandsParent.add(controller2);
  controllerGrip2 = renderer.xr.getControllerGrip(1);
  controllerGrip2.add(factory.createControllerModel(controllerGrip2));
  xrHandsParent.add(controllerGrip2);

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
   * button (cycles arrow: normal → explosive → grapple). VRKnockout's
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
    const xHint = makeButtonHint("X", "Cycle arrows");
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
  parkourJumpGlideBlockSec_ = 0;
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
  if (fpsStackElement) fpsStackElement.style.display = next && SHOW_FPS ? "flex" : "none";
  console.log(`[ui] visibility → ${next ? "on" : "off"}`);
}

const _localDelta = new THREE.Vector3();
const _throwAssistVel = new THREE.Vector3();
const _worldHandVel = new THREE.Vector3();
const _handVel = new THREE.Vector3();
/** World-space horizontal “out” from last wall separation (XZ), refreshed in resolve. */
const wallJumpOutNormal = new THREE.Vector3(0, 0, 0);
let wallJumpSurfaceValidUntilMs = 0;
let _wallSepHorizBest = 0;
const _wallSepDirXZ = new THREE.Vector3(0, 0, 0);
const _wallPushHoriz = new THREE.Vector3(0, 0, 0);
const _wallNLoc = new THREE.Vector3();
const _wallNW = new THREE.Vector3();
/** Extra clearance beyond capsule sample radius to count as “on” a wall. */
const WALL_PROXIMITY_PAD = 0.2;
/** Min horizontal speed into the wall (pre-throw) for a wall jump. */
const WALL_JUMP_INTO_SPEED = 0.5;
/** Min horizontal throw impulse magnitude (after THROW_BOOST). */
const WALL_JUMP_THROW_HORIZ_MIN = 0.36;
/** Throw direction vs wall-out (lower = more forgiving). */
const WALL_JUMP_THROW_AWAY_DOT = 0.22;
const WALL_JUMP_KICK_HORIZ = 3.4;
const WALL_JUMP_KICK_UP = 2.0;

function getWorldCollisionBoxes() {
  if (RUNNER_MAP_ID === 1) return getSandboxCollisionBoxes();
  return getRunnerCollisionBoxes();
}

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
        /* Same as brutalistVR8: full `cameraRig.quaternion` on world hand Δ so
         * X/Z throw stays tied to where the rig is facing (snap-turn safe).
         * Runner slide assist uses a separate world-Y probe (XR Y can be inverted). */
        _worldHandVel.set(vx / k, vy / k, vz / k);
        _handVel.copy(_worldHandVel).applyQuaternion(cameraRig.quaternion);
        let impX = -_handVel.x * THROW_BOOST;
        let impY = -_handVel.y * THROW_BOOST;
        let impZ = -_handVel.z * THROW_BOOST;
        let slideProbeY = -_worldHandVel.y * THROW_BOOST;

        _throwAssistVel.copy(rigVelocity);

        /* No “magic” mid-air boosts: throws only count on the ground or when
         * hugging a wall (wall jump / push-off window from collision resolve). */
        if (!isGrounded() && !isWallContactValidForAirThrow()) {
          impX = 0;
          impY = 0;
          impZ = 0;
          slideProbeY = 0;
        }

        if (impY > JUMP_THRESHOLD) {
          if (jumpsRemaining > 0) {
            jumpsRemaining--;
            impY *= Math.SQRT2;
            /* Any successful air jump blocks glide latch — clears on land.
             * Conditional checks (stick / rigVel) missed real VR cases where neither carried run speed. */
            parkourJumpGlideBlockSec_ = GLIDE_AFTER_PARKOUR_JUMP_BLOCK_S;
          } else impY = 0;
        }

        rigVelocity.x += impX;
        rigVelocity.y += impY;
        rigVelocity.z += impZ;

        tryApplyWallJump(impX, impY, impZ);

        const assist = getRunnerThrowAssist(
          cameraRig.position, _throwAssistVel, impX, impY, impZ, slideProbeY,
        );
        if (assist?.extraForwardZ) rigVelocity.z += assist.extraForwardZ;
        /* Never add free vertical here — that felt like a double jump. */
        if (assist?.duckMs) triggerRunnerDuck(assist.duckMs);

        const horizSpeed = Math.hypot(rigVelocity.x, rigVelocity.z);
        if (horizSpeed > MAX_HORIZONTAL_SPEED) {
          const s = MAX_HORIZONTAL_SPEED / horizSpeed;
          rigVelocity.x *= s;
          rigVelocity.z *= s;
        }
        if (rigVelocity.y > MAX_VERTICAL_SPEED) rigVelocity.y = MAX_VERTICAL_SPEED;
        if (rigVelocity.y < -MAX_FALL_SPEED) rigVelocity.y = -MAX_FALL_SPEED;
      }
      state.history.length = 0;
    }
  }
}

function getMergedGroundSupport(feetY, slack, out) {
  const px = cameraRig.position.x;
  const pz = cameraRig.position.z;
  const obbY = RUNNER_MAP_ID === 1
    ? getSandboxFloorY(px, pz, feetY, slack)
    : getRunnerFloorY(px, pz, feetY, slack);
  const hasGlb = getGlbFloorSupport(px, pz, feetY, _ghTmp);
  if (obbY === null && !hasGlb) return false;
  /* Prefer the **higher** support. When heights tie within a few cm, keep the
   * OBB slab — GLB ray hits can sit slightly below the authored slab and would
   * otherwise steal grounding and break plane distance checks in the hall. */
  const glbY = hasGlb ? _ghTmp.y : -Infinity;
  const useObb = obbY !== null && (!hasGlb || obbY >= glbY - 0.03);
  if (useObb) {
    out.fromGlb = false;
    out.y = obbY;
    out.normal.set(0, 1, 0);
    out.point.set(px, obbY, pz);
    return true;
  }
  out.fromGlb = true;
  out.y = _ghTmp.y;
  out.point.copy(_ghTmp.point);
  out.normal.copy(_ghTmp.normal);
  return true;
}

function refreshGroundSupport() {
  const p = cameraRig.position;
  groundMerged.valid = getMergedGroundSupport(p.y, 0.35, groundMerged);
  if (!groundMerged.valid) {
    _gRampPlaneSmActive = false;
    return;
  }
  stabilizeGlbRampGroundPlane_();
}

function isGrounded() {
  refreshGroundSupport();
  if (!groundMerged.valid) return false;
  const feetY = cameraRig.position.y;
  const ny = groundMerged.normal.y;
  /* Nearly flat: height vs slab top (robust when contact point XZ ≠ feet XZ). */
  if (ny >= 0.985) {
    return feetY <= groundMerged.y + 0.12 && feetY >= groundMerged.y - 0.14;
  }
  const d = groundMerged.normal.dot(cameraRig.position) - groundMerged.normal.dot(groundMerged.point);
  /* GLB mesh slopes: hull + soft snap sit slightly off the analytic plane — tight ±0.22
   * dropped grounding mid‑ramp so stick stopped and long climbs failed. */
  if (groundMerged.fromGlb) {
    return d <= 0.4 && d >= -0.52;
  }
  return d <= 0.22 && d >= -0.22;
}

/**
 * Snap rig onto merged floor plane (horizontal slabs or GLB mesh slope).
 * @param {number} [dtSec] — frame delta for **interpolated** GLB ramp corrections; omit on flat/OBB.
 */
function snapRigToFloor(dtSec) {
  refreshGroundSupport();
  if (!groundMerged.valid) return;
  const n = groundMerged.normal;
  const dist = n.dot(cameraRig.position) - n.dot(groundMerged.point);
  /* Only correct velocity into the surface when we are actually in contact.
   * `groundMerged.valid` stays true over a large XZ footprint while falling
   * (a floor exists below); stripping vn every frame would cancel gravity. */
  const flatSnap = n.y >= SLOPE_FLAT_NY;
  const snapHi = flatSnap ? 0.02 : 0.14;
  const snapLo = flatSnap ? -0.14 : -0.38;
  const glbSlope = groundMerged.fromGlb && !flatSnap;
  /* Frame-rate stable “move this fraction of remaining error toward the plane” —
   * BattleVR never had this problem because terrain was **only** BVH push-out
   * (no second analytic plane + down-ray merge + gap pulls fighting each frame). */
  const dt = Math.max(1 / 240, Math.min(typeof dtSec === "number" && dtSec > 0 ? dtSec : 1 / 60, 0.12));
  const rampSegT = 1 - Math.exp(-18 * dt);
  if (rigVelocity.y <= 0 && dist < snapHi && dist > snapLo) {
    if (!glbSlope) {
      cameraRig.position.addScaledVector(n, -dist);
    } else {
      cameraRig.position.addScaledVector(n, -dist * 0.38 * rampSegT);
    }
    const vn = rigVelocity.dot(n);
    if (vn < -0.015) rigVelocity.addScaledVector(n, -vn);
  }
  const px = cameraRig.position.x;
  const pz = cameraRig.position.z;
  if (glbSlope) {
    const fyR = getGlbFloorY(px, pz, cameraRig.position.y + 1.5);
    if (fyR !== null) {
      const gap = fyR - cameraRig.position.y;
      if (gap > 0.085 && gap < 3.2) {
        const step = Math.min(gap * 0.5, 0.58) * rampSegT;
        cameraRig.position.addScaledVector(n, step);
        if (rigVelocity.y < -0.35) rigVelocity.y *= 0.62;
      }
    }
  }
  /* Fast moves / triangle gaps: if feet dropped slightly below merged GLB height,
   * pull back up using multi-probe max Y (separate from plane snap). */
  /* Y-only clamp fights tilted plane snap on ramps → uphill stutter; keep for
   * flat-ish contact or when merged support is missing (fall-through recovery).
   * Skip `getGlbFloorY` on ramps to avoid extra BVH work and conflicting height. */
  const needsYClamp =
    !groundMerged.valid || groundMerged.normal.y >= SLOPE_FLAT_NY;
  if (needsYClamp) {
    const fy = getGlbFloorY(px, pz, cameraRig.position.y + 1.5);
    if (fy !== null) {
      const feet = cameraRig.position.y;
      if (feet < fy - 0.055 && feet > fy - 2.4) {
        cameraRig.position.y = fy;
        if (rigVelocity.y < -0.4) rigVelocity.y *= 0.45;
      }
    }
  }
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

/**
 * Horizontal “where I look” for glide thrust / redirect.
 * In WebXR, `renderer.xr.updateCamera(camera)` writes **this** `camera`’s world pose from the headset
 * (ArrayCamera children are not the same — using them broke steering).
 */
function setGlideHorizontalForward_(xrCamera) {
  cameraRig.updateMatrixWorld(true);
  const src = (renderer?.xr?.isPresenting && camera) ? camera : (xrCamera || camera);
  if (!src) return;
  src.updateMatrixWorld(true);
  src.getWorldDirection(_glFwd);
  _glFwd.y = 0;
  if (_glFwd.lengthSq() > 1e-5) {
    _glFwd.normalize();
    return;
  }
  src.getWorldQuaternion(_glQuatW);
  _glEul.setFromQuaternion(_glQuatW, "YXZ");
  const y = _glEul.y;
  _glFwd.set(-Math.sin(y), 0, -Math.cos(y));
  if (_glFwd.lengthSq() < 1e-10) _glFwd.set(0, 0, -1);
  _glFwd.normalize();
}

/** Body-only XZ axes (rig yaw). Latch / wing width use this so **head turn** does not fake “arms in” and drop glide. */
function setGlideRigHorizontalAxes_() {
  _glRigFwd.set(0, 0, -1).applyQuaternion(cameraRig.quaternion);
  _glRigFwd.y = 0;
  if (_glRigFwd.lengthSq() < 1e-8) _glRigFwd.set(0, 0, -1);
  _glRigFwd.normalize();
  _glRigRight.set(-_glRigFwd.z, 0, _glRigFwd.x);
  if (_glRigRight.lengthSq() < 1e-8) _glRigRight.set(1, 0, 0);
  _glRigRight.normalize();
}

function updatePhysicsMovement(dt, xrCamera) {
  glideFrameS0_ = -1;
  updateGrabLocomotion(dt);
  /* Grapple winch must run **before** gravity + `position += v*dt` so the same
   * frame’s integration matches the original `updateBots` → physics order. */
  applyGrappleWinchStep(dt);

  if (parkourJumpGlideBlockSec_ > 0) {
    parkourJumpGlideBlockSec_ = Math.max(0, parkourJumpGlideBlockSec_ - dt);
  }

  const grappleHookActive = isGrappleHookActive();
  if (prevGrappleHookActive_ && !grappleHookActive) {
    grapplePostWinchCarrySec_ = GRAPPLE_POST_WINCH_CARRY_S;
  }

  const grabbing = grabState.left.active || grabState.right.active;
  const groundedStart = isGrounded();
  if (groundedStart) {
    glideLatch_ = false;
    grapplePostWinchCarrySec_ = 0;
    parkourJumpGlideBlockSec_ = 0;
  }
  if (grappleHookActive) glideLatch_ = false;
  if (isArcheryDrawActive()) glideLatch_ = false;

  let wingsuit = null;
  if (
    !grappleHookActive
    && !isArcheryDrawActive()
    && !groundedStart
    && handToCtrl.left
    && handToCtrl.right
    && xrCamera
  ) {
    handToCtrl.left.getWorldPosition(_glLw);
    handToCtrl.right.getWorldPosition(_glRw);
    if (renderer?.xr?.isPresenting && camera) {
      camera.getWorldPosition(_glHead);
    } else {
      (xrCamera || camera).getWorldPosition(_glHead);
    }

    setGlideRigHorizontalAxes_();
    _glRight.copy(_glRigRight);

    _localPt.copy(_glLw).sub(_glHead);
    const latL = Math.abs(_localPt.dot(_glRigRight));
    _localPt.copy(_glRw).sub(_glHead);
    const latR = Math.abs(_localPt.dot(_glRigRight));
    const lateralSpan = latL + latR;
    _localPt.subVectors(_glRw, _glLw);
    const lateralGripSep = Math.abs(_localPt.dot(_glRigRight));
    const handDist = _glLw.distanceTo(_glRw);

    if (!glideLatch_) {
      if (
        !isArcheryDrawActive()
        && parkourJumpGlideBlockSec_ <= 0
        && -rigVelocity.y >= GLIDE_LATCH_MIN_DOWNWARD_SPEED
        && lateralSpan > GLIDE_LAT_ENTER
        && lateralGripSep > GLIDE_SEP_ENTER
        && handDist > GLIDE_HAND_ENTER
      ) {
        glideLatch_ = true;
      }
    } else if (
      lateralSpan < GLIDE_LAT_EXIT
      || lateralGripSep < GLIDE_SEP_EXIT
      || handDist < GLIDE_HAND_EXIT
      || isArcheryDrawActive()
    ) {
      glideLatch_ = false;
    }
    if (glideLatch_) {
      glideFrameS0_ = Math.hypot(rigVelocity.x, rigVelocity.y, rigVelocity.z);
      /* Thrust / pull-out follow **look**; latch geometry above uses **body** so head steering does not drop glide. */
      setGlideHorizontalForward_(xrCamera);
      /* Linear wing for tuck/narrow; eased curve so “past shoulder → full T” is strongly felt. */
      const wing = THREE.MathUtils.clamp(
        (lateralSpan - GLIDE_WING0) / (GLIDE_LAT_FULL - GLIDE_WING0 + 1e-5),
        0,
        1,
      );
      const easeWing = 1 - Math.pow(Math.max(0, 1 - wing), 2.1);
      const tuck = 1 - wing;
      const narrowFall = Math.pow(Math.max(0, 1 - wing), 2.05) * PLAYER_GRAVITY * GLIDE_NARROW_FALL_G;
      const wideDrag = easeWing * easeWing * GLIDE_WIDE_PARASITE * 1.35;
      /* Lift scales up with span; mid band gets a small extra (cruise) without punishing full T. */
      const liftSpreadMul = 0.42 + 0.95 * easeWing + 0.22 * Math.sin(Math.PI * easeWing) * (1 - easeWing);
      const hSpeed = Math.hypot(rigVelocity.x, rigVelocity.z);
      const plungeEarly = Math.max(0, -rigVelocity.y);
      const stallAir = Math.hypot(hSpeed, plungeEarly);
      const speed3d = Math.hypot(rigVelocity.x, rigVelocity.y, rigVelocity.z);
      const stallBlend =
        1 - THREE.MathUtils.smoothstep(GLIDE_STALL_AIR_LO, GLIDE_CRUISE_SPEED_MIN, stallAir);
      const liftSpeedMul = THREE.MathUtils.smoothstep(
        GLIDE_LIFT_SPEED_LO,
        GLIDE_LIFT_SPEED_HI,
        speed3d,
      );
      const hNorm = THREE.MathUtils.clamp(hSpeed / 6.5, 0, 1);
      const fallWind = Math.max(0, -rigVelocity.y) * 0.55;
      const upWind = Math.max(0, rigVelocity.y) * GLIDE_UPWIND_FOR_DYN;
      const airProxy = Math.hypot(hSpeed, fallWind, upWind);
      const dyn = Math.min(
        1,
        (airProxy / Math.max(0.4, GLIDE_DYN_REF_SPEED))
        * (airProxy / Math.max(0.4, GLIDE_DYN_REF_SPEED)),
      );
      const dynEff = Math.max(
        dyn,
        GLIDE_DYN_FLOOR * (1 - 0.65 * easeWing) + 0.55 * easeWing * Math.min(1, airProxy / 4.8),
      );

      _glMid.copy(_glLw).add(_glRw).multiplyScalar(0.5);
      /* “Pitch” = mostly lateral grip spacing + 3D hand distance (narrows when nocking / arms in). */
      const sepN = THREE.MathUtils.clamp(
        (lateralGripSep - GLIDE_PITCH_SEP_MIN)
          / (GLIDE_PITCH_SEP_MAX - GLIDE_PITCH_SEP_MIN + 1e-5) * 2
          - 1,
        -1,
        1,
      );
      const distN = THREE.MathUtils.clamp(
        (handDist - GLIDE_PITCH_DIST_MIN)
          / (GLIDE_PITCH_DIST_MAX - GLIDE_PITCH_DIST_MIN + 1e-5) * 2
          - 1,
        -1,
        1,
      );
      const glidePitch = THREE.MathUtils.clamp(0.52 * sepN + 0.48 * distN, -1, 1);
      const plungeSpeed = Math.max(0, -rigVelocity.y);
      const plungeTurn = THREE.MathUtils.smoothstep(
        GLIDE_PLUNGE_FORWARD_V0,
        GLIDE_PLUNGE_FORWARD_V1,
        plungeSpeed,
      );
      const glidePitchEff = THREE.MathUtils.clamp(
        glidePitch - plungeTurn * GLIDE_PLUNGE_PITCH_BIAS,
        -1,
        1,
      );

      const rollRaw = (_glLw.y - _glRw.y) * 2.4;
      const rollN = THREE.MathUtils.clamp(rollRaw, -1, 1);
      const yawRate =
        -rollN * (GLIDE_YAW_DEG_S * (Math.PI / 180)) * (0.22 + 0.78 * hNorm);

      let gravMul = THREE.MathUtils.lerp(1, GLIDE_GRAV_MUL, easeWing);
      gravMul *= 1 - GLIDE_PLUNGE_GRAV_REDUCTION * plungeTurn * easeWing;
      const tuckFall = tuck * PLAYER_GRAVITY * GLIDE_TUCK_EXTRA_G_FRAC;

      const pitchAmp = 0.55 + 0.62 * easeWing;
      const pitchLiftBoost = 1 + GLIDE_PITCH_LIFT * Math.max(0, -glidePitchEff) * pitchAmp;
      const pitchDiveMul = 1 + 0.65 * Math.max(0, glidePitchEff) * pitchAmp;
      const vyClimb = Math.max(0, rigVelocity.y);
      const climbFade = 1 - THREE.MathUtils.smoothstep(GLIDE_LIFT_CLIMB_SOFT, GLIDE_LIFT_CLIMB_HARD, vyClimb);
      const speedLiftFade = 1 - THREE.MathUtils.smoothstep(GLIDE_SPEED_LIFT_CLIMB_SOFT, GLIDE_SPEED_LIFT_CLIMB_HARD, vyClimb);
      let liftMag = easeWing * dynEff * GLIDE_LIFT_K * (pitchLiftBoost / pitchDiveMul);
      liftMag *= climbFade;
      liftMag += easeWing * dynEff * GLIDE_SPEED_TO_LIFT
        * Math.min(speed3d, GLIDE_SPEED_TO_LIFT_REF_MAX) * speedLiftFade;
      liftMag += easeWing * dynEff * GLIDE_PITCH_FLARE_VERT * Math.max(0, -glidePitchEff) * climbFade;
      if (rigVelocity.y < -0.35) {
        liftMag += easeWing * dynEff * GLIDE_FALL_SPEED_LIFT * THREE.MathUtils.smoothstep(3.5, 18, plungeSpeed);
      }
      /* High-|v| lift bump: was smoothstep(24→52) + unbounded speed→lift — both peaked mid‑40s |v|. */
      {
        const hiLift = THREE.MathUtils.smoothstep(22, 36, speed3d)
          * (1 - THREE.MathUtils.smoothstep(28, 40, speed3d));
        liftMag += easeWing * dynEff * 6.2 * hiLift;
      }
      liftMag *= liftSpreadMul;
      liftMag *= liftSpeedMul;
      {
        const liftFromFwd = THREE.MathUtils.smoothstep(GLIDE_LIFT_HS_LO, GLIDE_LIFT_HS_HI, hSpeed);
        const liftFromPlunge = THREE.MathUtils.smoothstep(
          GLIDE_LIFT_PLUNGE_LO,
          GLIDE_LIFT_PLUNGE_HI,
          plungeSpeed,
        );
        liftMag *= Math.max(liftFromFwd, liftFromPlunge);
      }
      liftMag = Math.min(liftMag, GLIDE_LIFT_MAX);
      liftMag *= 1 - GLIDE_STALL_LIFT_KILL * stallBlend;

      let diveSink = easeWing * Math.max(0, glidePitchEff) * GLIDE_PITCH_DIVE_G * pitchAmp;
      diveSink *= 1 - 0.88 * THREE.MathUtils.smoothstep(10, 42, speed3d);
      diveSink += stallBlend * easeWing * PLAYER_GRAVITY * GLIDE_STALL_EXTRA_G;

      /* Wingsuit always pushes where you **look** (head yaw on XZ) — intentional steer, not stray rig drift. */
      _glDiveDir.copy(_glFwd);

      /* Narrow: little forward + fast sink; mid: cruise; wide: strong forward + parasite drag. */
      const forwardSpread = 0.1 + 0.92 * easeWing * easeWing;
      const airSpeedForPlunge = Math.hypot(hSpeed, plungeSpeed);
      const plungeFromSpeed = 0.32 + 0.68 * THREE.MathUtils.smoothstep(2.2, 20, airSpeedForPlunge);
      const forwardPlunge = plungeTurn * easeWing * dynEff * GLIDE_PLUNGE_FORWARD_ACCEL * plungeFromSpeed;
      const forwardRaw =
        forwardSpread
        * (
          GLIDE_FORWARD_BASE
          + GLIDE_FORWARD_DYN * dynEff * (0.55 + 0.45 * easeWing)
          + GLIDE_FORWARD_DIVE * Math.max(0, glidePitchEff) * pitchAmp
          + forwardPlunge
        );
      const liftFrac = liftMag / Math.max(0.35, GLIDE_LIFT_MAX);
      const plungeDivertRelax =
        1 - GLIDE_PLUNGE_DIVERT_RELAX * THREE.MathUtils.smoothstep(
          GLIDE_PLUNGE_FORWARD_V0,
          GLIDE_PLUNGE_FORWARD_V1 + 2.5,
          plungeSpeed,
        );
      const forwardAccelRaw =
        forwardRaw
        * (
          1
          - GLIDE_WIDE_FORWARD_DIVERT * easeWing * (0.35 + 0.65 * liftFrac) * plungeDivertRelax
        );
      const fwdSpan = Math.max(0.26, 0.2 + 0.8 * easeWing * easeWing);
      /* Ramps up with span; rolls off as |v| rises so forward + lift do not pin airspeed in the 40s. */
      const fwdFastFade =
        THREE.MathUtils.lerp(
          1,
          GLIDE_FWD_THRUST_FAST_MUL,
          THREE.MathUtils.smoothstep(GLIDE_FWD_THRUST_FAST_LO, GLIDE_FWD_THRUST_FAST_HI, speed3d),
        );
      const fwdThrottle = fwdSpan * fwdFastFade;
      const stallFwd = THREE.MathUtils.lerp(GLIDE_STALL_FWD_FLOOR, 1, 1 - stallBlend);
      const forwardAccel = forwardAccelRaw * fwdThrottle * stallFwd * GLIDE_FORWARD_MOMENTUM_MUL;

      wingsuit = {
        gravMul,
        tuckFall,
        narrowFall,
        lift: liftMag,
        diveSink,
        yawRate,
        forwardAccel,
        diveDirX: _glDiveDir.x,
        diveDirZ: _glDiveDir.z,
        dyn: dynEff,
        wideDrag,
        easeWing,
        stallBlend,
      };
    }
  }

  if (wingsuit) {
    const speed3dNow = Math.hypot(rigVelocity.x, rigVelocity.y, rigVelocity.z);
    let yAccel =
      -PLAYER_GRAVITY * wingsuit.gravMul
      - wingsuit.tuckFall
      - wingsuit.narrowFall
      + wingsuit.lift
      - wingsuit.diveSink;
    const vrBoost = THREE.MathUtils.smoothstep(38, 56, speed3dNow)
      * (1 - 0.85 * THREE.MathUtils.smoothstep(28, 40, speed3dNow));
    const stallB = wingsuit.stallBlend ?? 0;
    yAccel += wingsuit.easeWing * PLAYER_GRAVITY * (0.55 + 2.05 * vrBoost) * (1 - 0.88 * stallB);
    rigVelocity.y += yAccel * dt;
    /* Must refresh hierarchy so synced `camera` world dir matches headset after any rig change. */
    cameraRig.updateMatrixWorld(true);
    setGlideHorizontalForward_(xrCamera);
    const gdfx = _glFwd.x;
    const gdfz = _glFwd.z;

    rigVelocity.x += gdfx * wingsuit.forwardAccel * dt;
    rigVelocity.z += gdfz * wingsuit.forwardAccel * dt;
    const downSp = Math.max(0, -rigVelocity.y);
    if (downSp > 0.04) {
      const redStr = Math.max(wingsuit.easeWing, GLIDE_REDIRECT_EASE_MIN);
      let take = downSp * (1 - Math.exp(-dt / GLIDE_FALL_LEVEL_TAU)) * redStr;
      take *= 1 - 0.72 * (wingsuit.stallBlend ?? 0);
      const maxStep = downSp * 0.55;
      if (take > maxStep) take = maxStep;
      rigVelocity.y += take;
      rigVelocity.x += gdfx * take;
      rigVelocity.z += gdfz * take;
    }
    /* VR: same yaw delta on **world XZ velocity** and **rig** (controllers follow rig; head stays tracked). */
    if (renderer?.xr?.isPresenting) {
      let dAirYaw = wingsuit.yawRate * dt;
      const sx = Math.abs(vrInput.rightStick.x) > deadzone ? vrInput.rightStick.x : 0;
      if (sx !== 0) {
        /* Same deg/s as non-glide: `cameraRig.rotation.y -= sx * rotateSpeed * dt * (π/180)` */
        dAirYaw -= sx * rotateSpeed * dt * (Math.PI / 180);
      }
      if (dAirYaw !== 0) {
        _vTan.set(rigVelocity.x, 0, rigVelocity.z);
        _vTan.applyAxisAngle(_worldUp, dAirYaw);
        rigVelocity.x = _vTan.x;
        rigVelocity.z = _vTan.z;
        cameraRig.rotation.y += dAirYaw;
      }
    } else {
      cameraRig.rotation.y += wingsuit.yawRate * dt;
    }
  } else {
    rigVelocity.y -= PLAYER_GRAVITY * dt;
  }
  if (rigVelocity.y < -MAX_FALL_SPEED) rigVelocity.y = -MAX_FALL_SPEED;
  const grapplePostWinchCarry = grapplePostWinchCarrySec_ > 0;
  let upCap = grapplePostWinchCarry ? GRAPPLE_POST_WINCH_UP_CAP : MAX_VERTICAL_SPEED;
  if (wingsuit && !grapplePostWinchCarry) {
    upCap = Math.min(
      GLIDE_MAX_VY_UP_ABS,
      GLIDE_MAX_VY_UP_BASE + wingsuit.dyn * GLIDE_MAX_VY_UP_DYN,
    );
  }
  if (!grappleHookActive && rigVelocity.y > upCap) {
    rigVelocity.y = upCap;
  }

  cameraRig.position.x += rigVelocity.x * dt;
  cameraRig.position.y += rigVelocity.y * dt;
  cameraRig.position.z += rigVelocity.z * dt;

  const grounded = isGrounded();
  const groundFlat =
    grounded && groundMerged.valid && groundMerged.normal.y >= SLOPE_FLAT_NY;

  /* Squeeze-held grab skips damping unless wingsuit is active (spread arms glide
   * must still shed horizontal speed / feel controlled). */
  if (!grabbing || wingsuit) {
    if (grounded) {
      if (groundFlat) {
        rigVelocity.x *= Math.pow(GROUND_FRICTION, dt);
        rigVelocity.z *= Math.pow(GROUND_FRICTION, dt);
        if (rigVelocity.y < 0) rigVelocity.y = 0;
      } else {
        _vTan.copy(rigVelocity).addScaledVector(groundMerged.normal, -rigVelocity.dot(groundMerged.normal));
        _vTan.multiplyScalar(Math.pow(SLOPE_GROUND_FRICTION, dt));
        const vn = rigVelocity.dot(groundMerged.normal);
        rigVelocity.copy(groundMerged.normal).multiplyScalar(vn).add(_vTan);
      }
    } else {
      const airDamp = wingsuit ? GLIDE_AIR_DAMPING : AIR_DAMPING;
      rigVelocity.x *= Math.pow(airDamp, dt);
      rigVelocity.z *= Math.pow(airDamp, dt);
      if (wingsuit?.wideDrag > 0) {
        const hm = Math.hypot(rigVelocity.x, rigVelocity.z);
        const parasite = Math.exp(-wingsuit.wideDrag * hm * dt);
        rigVelocity.x *= parasite;
        rigVelocity.z *= parasite;
      }
    }
    /* Kill sub-threshold horizontal drift when the player is not actively steering
     * (stick centered). Residual velocity otherwise decays slowly from friction alone. */
    const stickLocomotionIdle =
      Math.abs(vrInput.leftStick.x) <= deadzone && Math.abs(vrInput.leftStick.y) <= deadzone;
    if (grounded && stickLocomotionIdle) {
      if (groundFlat) {
        if (Math.hypot(rigVelocity.x, rigVelocity.z) < RIG_DRIFT_VEL_EPS) {
          rigVelocity.x = 0;
          rigVelocity.z = 0;
        }
      } else if (groundMerged.valid) {
        const nn = groundMerged.normal;
        _vTan.copy(rigVelocity).addScaledVector(nn, -rigVelocity.dot(nn));
        if (_vTan.lengthSq() < RIG_DRIFT_VEL_EPS * RIG_DRIFT_VEL_EPS) {
          const vn = rigVelocity.dot(nn);
          rigVelocity.copy(nn).multiplyScalar(vn);
        }
      }
    } else if (!grounded && !wingsuit) {
      if (Math.hypot(rigVelocity.x, rigVelocity.z) < RIG_AIR_DRIFT_VEL_EPS) {
        rigVelocity.x = 0;
        rigVelocity.z = 0;
      }
    }
    if (wingsuit) {
      const hm = Math.hypot(rigVelocity.x, rigVelocity.z);
      if (hm > GLIDE_MAX_HORIZ) {
        const s = GLIDE_MAX_HORIZ / hm;
        rigVelocity.x *= s;
        rigVelocity.z *= s;
      }
    }
  }

  /* Refill jump only when landed with downward / neutral vertical velocity,
   * so brief hull contacts or ceiling nudges don’t restore a mid-air jump. */
  if (grounded && rigVelocity.y <= 0.08) jumpsRemaining = MAX_JUMPS;

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
      _deltaHoriz.set(
        direction.x * moveY - strafe.x * moveX,
        0,
        direction.z * moveY - strafe.z * moveX,
      ).multiplyScalar(moveSpeed * dt);
      if (groundFlat) {
        cameraRig.position.add(_deltaHoriz);
      } else if (groundMerged.valid) {
        const nn = groundMerged.normal;
        _deltaProj.copy(_deltaHoriz).addScaledVector(nn, -nn.dot(_deltaHoriz));
        /* GLB ramps: steeper = shorter projection in world XZ — extra scale helps long climbs. */
        let rampBoost = 1.12;
        if (groundMerged.fromGlb) {
          rampBoost = 1.12 + Math.min(0.48, (SLOPE_FLAT_NY - nn.y) * 6.5);
        }
        _deltaProj.multiplyScalar(rampBoost);
        cameraRig.position.add(_deltaProj);
      }
    }
  }

  /* Snap after stick so locomotion isn’t immediately re-projected off the ramp plane. */
  snapRigToFloor(dt);

  const rotateX = Math.abs(vrInput.rightStick.x) > deadzone ? vrInput.rightStick.x : 0;
  /* VR wingsuit: right-stick yaw already rotates world XZ `rigVelocity` — rig-only yaw would not steer flight and would double inputs. */
  if (rotateX !== 0 && !(renderer?.xr?.isPresenting && wingsuit)) {
    cameraRig.rotation.y -= rotateX * rotateSpeed * dt * (Math.PI / 180);
  }

  /* Glide wind is VR-only: desktop orbit + intro still run physics, which would
   * otherwise drive `falling` and ramp the fall loop on the flat page. */
  if (renderer?.xr?.isPresenting) {
    const stLen = Math.hypot(vrInput.leftStick.x, vrInput.leftStick.y);
    let locomotionSpeed = 0;
    if (stLen > deadzone) {
      locomotionSpeed = stLen * moveSpeed;
      if (grounded && !groundFlat && groundMerged.valid) {
        let rampBoost = 1.12;
        if (groundMerged.fromGlb) {
          const nn = groundMerged.normal;
          rampBoost = 1.12 + Math.min(0.48, (SLOPE_FLAT_NY - nn.y) * 6.5);
        }
        locomotionSpeed *= rampBoost;
      }
      locomotionSpeed *= LOCOMOTION_AUDIO_UPSCALE;
    }
    tickGlideAudio({
      dt,
      falling: !grounded && rigVelocity.y < -0.38,
      gliding: wingsuit != null,
      horizSpeed: Math.hypot(rigVelocity.x, rigVelocity.z),
      totalSpeed: Math.hypot(rigVelocity.x, rigVelocity.y, rigVelocity.z),
      locomotionSpeed,
    });
  }

  if (grapplePostWinchCarrySec_ > 0) {
    grapplePostWinchCarrySec_ = Math.max(0, grapplePostWinchCarrySec_ - dt);
  }
  prevGrappleHookActive_ = grappleHookActive;
}

/**
 * Glide cruise above ~20 m/s: 20%×|v|×dt to `vy`, then cap |v| ≤ frame-start×e^(−5%×dt) so speed cannot plateau.
 * Below that speed at frame start: **no cap** — gravity and dive can raise |v| toward flying speed (real wingsuit).
 */
function applyGlideCruiseAfterCollision_(dt) {
  if (!glideLatch_) return;
  if (isGrounded()) return;
  if (isGrappleHookActive() || isArcheryDrawActive()) return;
  if (!(glideFrameS0_ > 1e-5)) return;
  if (glideFrameS0_ < GLIDE_CRUISE_SPEED_MIN) {
    return;
  }
  const sMax = glideFrameS0_ * Math.exp(-GLIDE_CRUISE_VEL_FRAC_PER_S * dt);
  rigVelocity.y += GLIDE_CRUISE_UP_FRAC_PER_S * glideFrameS0_ * dt;
  const sPost = Math.hypot(rigVelocity.x, rigVelocity.y, rigVelocity.z);
  if (sPost > sMax + 1e-5) {
    rigVelocity.multiplyScalar(sMax / sPost);
  }
}

/**
 * Floor clamp, OBB separation, glass burst, pit reset — shared by VR tick and
 * desktop physics so non‑XR sessions still collide with the runner level.
 * @param {THREE.Camera} headSourceCamera — XR rig camera or desktop `camera` for head world pos.
 */
function tickRunnerCollisionIntegration(headSourceCamera, dtSec) {
  if (getWorldCollisionBoxes().length === 0) return;
  resolveAllCollisions(cameraRig.position);
  /* Two passes: one closest-hit per height can miss stacked penetration after a
   * large dt or stick step — second pass matches common “solver iterations” cheaply. */
  resolveGlbMeshCollisions(cameraRig.position, 0.35, rigVelocity);
  resolveGlbMeshCollisions(cameraRig.position, 0.35, rigVelocity);
  /* Floor snap *after* OBB push so wall pushes can't shove us off the slab. */
  snapRigToFloor(dtSec);
  cameraRig.updateMatrixWorld(true);
  _headW.copy(headSourceCamera.position).applyMatrix4(cameraRig.matrixWorld);
  tryShatterRunnerGlassPlayer(
    cameraRig.position, rigVelocity, _headW.x, _headW.y, _headW.z,
  );
  tryRunnerPitFallReset();
}

let pitFallResetBusy = false;
function tryRunnerPitFallReset() {
  if (RUNNER_MAP_ID === 1) return;
  if (pitFallResetBusy || !scene || !cameraRig) return;
  if (!getWorldCollisionBoxes().length) return;
  if (cameraRig.position.y > RUNNER_PIT_RESET_Y) return;
  pitFallResetBusy = true;
  try {
    disposeRunnerLevel(scene);
    initRunnerLevel(scene, { shadows: DYNAMIC_SHADOWS });
    clearRunnerArcheryVolleys();
    /* `restartRun` ends with `setBotsEnabled(true)` — pit reset should not force combat on. */
    resetRunWithoutStartingCombat();
  } finally {
    pitFallResetBusy = false;
  }
}

function updateVRMovement(delta) {
  const session = renderer.xr.getSession();
  /* Do not require `inputSources` — some runtimes expose it late; physics/collision
   * must still tick every frame or the player falls through the floor. */
  if (!session) return;
  /* Match `WebGLRenderer.render`: refresh XR rig matrices **before** physics so thrust/yaw use current head pose. */
  if (renderer.xr?.isPresenting && camera && typeof renderer.xr.updateCamera === "function") {
    renderer.xr.updateCamera(camera);
  }
  const inputSources = session.inputSources ?? [];
  vrInput.leftStick.x = 0;
  vrInput.leftStick.y = 0;
  vrInput.rightStick.x = 0;
  vrInput.rightStick.y = 0;
  let yPressed = false;
  for (let i = 0; i < inputSources.length; i++) {
    const source = inputSources[i];
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

  /* Clamp dt — the first XR frame can be hundreds of ms after page load and
   * uncapped gravity would tunnel the rig past every floor before snap fires. */
  const dt = Math.min(0.1, (delta || 0) / 1000);
  if (!(dt > 0)) return;

  const xrCamera = renderer.xr.getCamera();

  if (locomotionMode === "physics") {
    updatePhysicsMovement(dt, xrCamera);
  } else {
    updateEditorMovement(dt, xrCamera);
  }

  tickRunnerCollisionIntegration(xrCamera, dt);
  applyGlideCruiseAfterCollision_(dt);
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
  renderer.shadowMap.enabled = DYNAMIC_SHADOWS;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = DYNAMIC_SHADOWS;

  /* Sun direction matches the HDR roughly so the procedural sky's sun
   * disc lines up with real-time shadows. Hardcoded fallback if no
   * HDR is loaded. */
  sunVec.set(0.52, 0.78, 0.34).normalize();

  sunLight = new THREE.DirectionalLight(0xffffff, SUN_INTENSITY);
  sunLight.castShadow = DYNAMIC_SHADOWS;
  sunLight.position.copy(sunVec).multiplyScalar(SUN_LIGHT_DIST);
  sunLight.target.position.set(0, 5, 0);
  scene.add(sunLight.target);
  scene.add(sunLight);

  /* Shadow frustum ±90 m: keep the shadow map’s hard edge far enough out
   * that it is usually softened by distance / BattleVR-style fog. 2048²
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
  /* Depth range along the light axis must cover the sun→scene span (tall scaled city).
   * Defaults were ~270 m — far too shallow for ~2 km vertical art; casters fell outside
   * the shadow volume so maps looked shadowless. Tune with `?shadownear=` / `?shadowfar=`. */
  cam.near = readFloatParam("shadownear", 0.5);
  cam.far = readIntParam("shadowfar", 8000);
  cam.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.025;
  sunLight.shadow.radius = 2.5;

  /* A weak ambient so deep shadow doesn't render pitch-black on Quest 3
   * (no GI to fall back to). */
  scene.add(new THREE.AmbientLight(0xb0c4e0, DYNAMIC_SHADOWS ? 0.18 : 0.28));

  console.info(
    DYNAMIC_SHADOWS
      ? `[brutalistVR8] sun light: intensity ${SUN_INTENSITY}, ${shadowSize}² PCFSoft, ±${shadowHalf} m frustum (~${((cam.right - cam.left) / shadowSize * 100).toFixed(1)} cm/texel), follows player`
      : `[brutalistVR8] sun light: intensity ${SUN_INTENSITY}, dynamic shadows OFF (set DYNAMIC_SHADOWS = true in main.js to restore)`,
  );
}

/* ── Bloom (sky lives in `init` as a solid Color matching fog) ────────── */

function setupSkyAndBloom() {
  /* No sky shader — solid near-black `scene.background` in `init()` (BattleVR `<a-sky>`). */
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

/** Catches async-loaded GLBs and lazy-created materials (WeakSet skips already-patched). */
let radialFogScanFrame_ = 0;

function animate(time) {
  const delta = time - lastTime;
  lastTime = time;
  if (scene && (radialFogScanFrame_++ & 31) === 0) patchRadialFogOntoObjectTree(scene);
  if (cameraRig && time - lastLsSaveRtMs_ > LS_SAVE_INTERVAL_MS) {
    lastLsSaveRtMs_ = time;
    saveLastRigPositionToLs_();
  }
  if (SHOW_FPS) tickFps(performance.now());
  updateRunnerGlassShards(Math.min(0.1, (delta || 0) * 0.001));

  /* Tick the controller-hint pulse animation (small, no-op when no
   * hints are bound). */
  if (_hintMeshes.length > 0) {
    const now = performance.now();
    for (const h of _hintMeshes) {
      if (h.userData?.pulseTick) h.userData.pulseTick(now);
    }
  }

  applyRunnerCameraDuck(camera, crouchViewGroup, { deltaMs: delta });

  if (RUNNER_MAP_ID === 1 && cameraRig) {
    if (updateStreamSandbox(cameraRig.position)) {
      notifySectorsChanged([]);
    }
  }

  /* Shadow camera follows the player on a 1 m grid (stable shadows). */
  if (sunLight) {
    sunShadowFrame++;
    /* Half-rate shadow updates: 60 Hz inside a 120 Hz render. Drone
     * motion is slow enough that the half-frame staleness is invisible. */
    if (DYNAMIC_SHADOWS) {
      renderer.shadowMap.autoUpdate = (sunShadowFrame & 1) === 0;
    }
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
    const dtSec = Math.max(0, Math.min(0.1, (delta || 0) * 0.001));
    if (locomotionMode === "physics" && getWorldCollisionBoxes().length > 0) {
      updatePhysicsMovement(dtSec, camera);
      tickRunnerCollisionIntegration(camera, dtSec);
      applyGlideCruiseAfterCollision_(dtSec);
    }
    if (composer && false) composer.render(delta * 0.001);
    else renderer.render(scene, camera);
  }

  syncFpsStackHud();
}

/**
 * glTF often sets `material.fog = false` (opt-out of atmosphere). Re-enable for world meshes
 * so radial fog (`radialFogMaterials.js`) applies; stock `scene.fog` is unused.
 * Skips ShaderMaterial, RawShaderMaterial, and screen-space HUD (MeshBasic + depthTest off).
 * @param {THREE.Object3D} root
 */
function enforceMaterialsUseSceneFog_(root) {
  root.traverse((o) => {
    const any = /** @type {any} */ (o);
    if (!any.isMesh && !any.isLine && !any.isLineSegments && !any.isPoints) return;
    const m = any.material;
    if (!m) return;
    const list = Array.isArray(m) ? m : [m];
    for (let i = 0; i < list.length; i++) {
      const mat = list[i];
      if (!mat || !("fog" in mat) || mat.fog !== false) continue;
      if (mat.isShaderMaterial || mat.isRawShaderMaterial) continue;
      if (mat.isMeshBasicMaterial && mat.depthTest === false) continue;
      mat.fog = true;
      mat.needsUpdate = true;
    }
  });
}

/* ── init ─────────────────────────────────────────────────────────────── */

async function init() {
  statusElement = document.getElementById("status");
  fpsStackElement = document.getElementById("fps-stack");
  fpsElement = document.getElementById("fps");
  speedometerElement = document.getElementById("speedometer");
  if (fpsStackElement) {
    fpsStackElement.style.display = SHOW_FPS && getUIVisible() ? "flex" : "none";
  }
  fpsState.windowStart = performance.now();
  drawVrFpsPanel(0, 0);

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.025, CAMERA_FAR);
  cameraRig = new THREE.Group();
  crouchViewGroup = new THREE.Group();
  crouchViewGroup.name = "crouch_view_offset";
  cameraRig.add(crouchViewGroup);
  crouchViewGroup.add(camera);
  camera.position.set(0, RUNNER_STANDING_EYE_Y, 0);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY_HORIZON_HEX);
  scene.fog = null;
  setRadialFogParams(FOG_LINEAR_NEAR_M, FOG_LINEAR_FAR_M, SKY_HORIZON_HEX);
  scene.add(cameraRig);

  /* Overcast EXR → `scene.environment` only (IBL). `scene.background` matches radial fog colour (same hex). */
  setStatus("Loading sky…");
  try {
    /* Float32 EXR pixels (half-float Uint16 would be wrong for CPU-side sampling). */
    const exrLoader = new EXRLoader();
    exrLoader.setDataType(THREE.FloatType);
    const envTexture = await exrLoader.loadAsync(ENV_URL);
    envTexture.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = envTexture;
    /* High IBL keeps “fogged” PBR surfaces brighter than pure fog colour (BattleVR is mostly standard + low IBL). */
    scene.environmentIntensity = readFloatParam("env", 0.06);
    scene.background = new THREE.Color(SKY_HORIZON_HEX);
    setRadialFogColorHex(SKY_HORIZON_HEX);
    console.info(
      `[brutalistVR8] sky: radial fog near=${FOG_LINEAR_NEAR_M} far=${FOG_LINEAR_FAR_M} m, cameraFar=${CAMERA_FAR} m, `
        + `backdrop+fog #${SKY_HORIZON_HEX.toString(16).padStart(6, "0")}; EXR = environment only. Tunables: ?fognear=, ?fogfar=, ?camerafar=, ?env=, ?skyhorizon=`,
    );
  } catch (e) {
    console.warn("EXR load failed — IBL unavailable; solid sky + fog unchanged.", e);
  }

  /* Runner start: map 0 = room interior. Map 1 spawn is set after city glTF loads. */
  if (RUNNER_MAP_ID === 0) {
    playerSpawnPos.set(0, RUNNER_TOP_FLOOR_SURFACE_Y, -4);
    tryRestoreLastRigPositionFromLs_();
    cameraRig.position.copy(playerSpawnPos);
    orbitTarget.set(playerSpawnPos.x, playerSpawnPos.y + 2, playerSpawnPos.z + 10);
  }

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    logarithmicDepthBuffer: CAMERA_FAR > 4000,
  });
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
    /* Lower GPU fill cost in headset (especially heavy maps like ?map=1).
     * Default 1 = unchanged. Try ?xrscale=0.85 or 0.8 if you see tearing / low headroom. */
    const xrScale = readFloatParam("xrscale", 1);
    if (
      xrScale > 0.4
      && xrScale <= 1.5
      && Math.abs(xrScale - 1) > 0.001
      && typeof renderer.xr.setFramebufferScaleFactor === "function"
    ) {
      try {
        renderer.xr.setFramebufferScaleFactor(xrScale);
        console.info(`[VRrunner] WebXR framebuffer scale = ${xrScale} (?xrscale=)`);
      } catch (e) {
        console.warn("[VRrunner] xrscale / setFramebufferScaleFactor:", e);
      }
    }
    const session = renderer.xr.getSession();
    /* After `local-floor` reference space is applied, keep XZ (saved or current roam);
     * only snap Y to GLB floor under the rig so we do not start under collision. */
    if (cameraRig && getWorldCollisionBoxes().length > 0) {
      const px = cameraRig.position.x;
      const pz = cameraRig.position.z;
      const fy = getGlbFloorY(px, pz, cameraRig.position.y + 800);
      if (fy !== null && Number.isFinite(fy)) {
        cameraRig.position.y = fy + 0.15;
      }
      rigVelocity.set(0, 0, 0);
    }
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
    try {
      resumeGlideAudio();
    } catch (_) { /* ignore */ }
  });
  renderer.xr.addEventListener("sessionend", () => {
    try {
      muteGlideAudio();
    } catch (_) { /* ignore */ }
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

  if (RUNNER_MAP_ID === 0) {
    initRunnerLevel(scene, { shadows: DYNAMIC_SHADOWS });
  } else {
    disposeRunnerLevel(scene);
    initStreamSandbox(scene, { shadows: DYNAMIC_SHADOWS, pizzaplex: false, city: true });
    await whenSandboxCityReady();
    getSandboxDefaultSpawn(playerSpawnPos);
    tryRestoreLastRigPositionFromLs_();
    cameraRig.position.copy(playerSpawnPos);
    orbitTarget.set(playerSpawnPos.x, playerSpawnPos.y + 3, playerSpawnPos.z + 25);
    updateStreamSandbox(cameraRig.position);
  }

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(orbitTarget);
  controls.update();

  preloadGlideAudio().catch(() => {});

  window.addEventListener("resize", onResize);
  window.addEventListener("pagehide", () => {
    saveLastRigPositionToLs_();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") saveLastRigPositionToLs_();
  });
  renderer.setAnimationLoop(animate);
  /* Clear the intro overlay status line — world is ready for ENTER VR. */
  setStatus("");

  /* Console API. Most v8 bake/preview commands removed. */
  window.VRrunner = window.brutalistVR8 = {
    /** Print streaming + scene state. */
    status() {
      const out = {
        map: RUNNER_MAP_ID,
        currentSector: RUNNER_MAP_ID === 1 ? getCurrentSandboxSectorKey() : getCurrentSectorKey(),
        activeSectors: RUNNER_MAP_ID === 1 ? getActiveSandboxSectorKeys() : getActiveSectorKeys(),
        activeMeshes: RUNNER_MAP_ID === 1 ? "stream_sandbox" : "(runner)",
        activeCollisionBoxes: getWorldCollisionBoxes().length,
        world: RUNNER_MAP_ID === 1 ? "VRrunner stream sandbox (100 m 3D cells)" : "VRrunner static level",
        minimapWindow: `${GRID_HALF * 2 + 1}×${GRID_HALF * 2 + 1}`,
        sectorSize: RUNNER_MAP_ID === 1 ? SANDBOX_SECTOR : SECTOR_SIZE,
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
     *  Values: "normal" | "explosive" | "grapple" (rope while active; hold
     *  **bow-hand** trigger after it sticks to add winch velocity; first release
     *  after a pull drops the rope and that hook cannot winch again).
     *  In-VR: X on the left controller cycles the three types.
     *  Examples:
     *    brutalistVR8.setArrowType("explosive")
     *    brutalistVR8.setArrowType("grapple")
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
    /**
     * Clear saved rig position, set respawn to this map’s default, teleport immediately.
     * Use when stuck inside geometry or a bad reload keeps spawning you in a wall.
     * Example: brutalistVR8.resetSpawnAndTeleport()
     */
    resetSpawnAndTeleport() {
      resetPlayerSpawnToDefault_();
      teleportRigToSpawnAnchor_();
      console.info("brutalistVR8.resetSpawnAndTeleport: default spawn, rig moved to", playerSpawnPos.toArray());
      return playerSpawnPos.toArray();
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
  const botInitOpts = {
    scene,
    camera,
    cameraRig,
    renderer,
    getCollisionBoxes: () => getWorldCollisionBoxes(),
    shatterRunnerGlassIfHit: tryShatterRunnerGlassArrow,
    getPlayerVelocity: () => rigVelocity,
    getPlayerSpawn: () => playerSpawnPos,
    /** Bots use this to know where drones should anchor their spawn /
     *  survey targets. */
    getPlayerPosition: () => cameraRig.position,
    /** Look up the tallest-tower anchor for a sector key. Returns
     *  [{x, y, z, yaw, w, d, ...}] (length 0 or 1). bots.js calls
     *  this when a sector loads to decide where to plant an
     *  AntiAirTurret. */
    getSectorTowerAnchors,
    respawnPlayer: () => {
      cameraRig.position.copy(playerSpawnPos);
      rigVelocity.set(0, 0, 0);
      jumpsRemaining = MAX_JUMPS;
      parkourJumpGlideBlockSec_ = 0;
      grabState.left.active = false;
      grabState.right.active = false;
      grabState.left.history.length = 0;
      grabState.right.history.length = 0;
    },
  };
  if (RUNNER_MAP_ID === 0) {
    botInitOpts.getSectorInfo = () => {
      const current = getCurrentSectorKey();
      return {
        current,
        active: getActiveSectorKeys(),
        all: getAllSectorMetas(current, GRID_HALF),
        sectorSize: SECTOR_SIZE,
        gridHalf: GRID_HALF,
      };
    };
  }
  initBots(botInitOpts);
  enforceMaterialsUseSceneFog_(scene);
  patchRadialFogOntoObjectTree(scene);
  setBattleOnBEnabled(true);
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
  if (RUNNER_MAP_ID === 1) {
    notifySectorsChanged([]);
    console.info(
      `[VRrunner] map=1 stream sandbox — ${SANDBOX_SECTOR} m cells, active 3³, `
      + `keys: ${getActiveSandboxSectorKeys().join("; ")}`,
    );
  } else {
    notifySectorsChanged(getActiveSectorKeys());
  }
  console.info("[VRrunner] console API ready — window.VRrunner === window.brutalistVR8");
}

init().catch((e) => {
  console.error(e);
  setStatus(String(e));
});
