/**
 * VRrunner kinematic player locomotion — extracted from main.js for GTAVR embed.
 * Grab/throw jump, slide duck, wingsuit glide, stick move, BVH collision.
 */
import * as THREE from 'three';
import {
  getRunnerThrowAssist,
  triggerRunnerDuck,
  applyRunnerCameraDuck,
  getRigSampleHeightMul,
  getRunnerRadiusMul,
  resolveGlbMeshCollisions,
  clampRigMotionAgainstGlbMeshes,
  recoverRigFromGlbPenetration,
  getGlbFloorSupport,
  getGlbFloorY,
  getSandboxGlbCollisionMeshes,
  tryShatterRunnerGlassPlayer,
} from './runnerLevel.js';
import { getPairedXRControllerGrips } from './xrControllerPair.js';
import {
  applyGrappleWinchStep,
  isGrappleHookActive,
  isArcheryDrawActive,
} from './bots.js';
import { tickGlideAudio } from './glideAudio.js';

/** @param {object} deps */
export function createPlayerLocomotion(deps) {
  const renderer = deps.renderer;
  const camera = deps.camera;
  const cameraRig = deps.cameraRig;
  const crouchViewGroup = deps.crouchViewGroup;
  const getWorldCollisionBoxes = () => (deps.getCollisionBoxes ? deps.getCollisionBoxes() : []);
  const getFloorY = (x, z, currentY, slack = 0.35) => {
    if (deps.getFloorY) return deps.getFloorY(x, z, currentY, slack);
    return getGlbFloorY(x, z, currentY);
  };
  const RUNNER_MAP_ID = deps.mapId != null ? deps.mapId : 1;
  const controllerGrip1 = deps.controllerGrip1;
  const controllerGrip2 = deps.controllerGrip2;
  let locomotionMode = 'physics';

const vrInput = { leftStick: { x: 0, y: 0 }, rightStick: { x: 0, y: 0 } };
/** Stick locomotion scale (m/s at full deflection). Parkour runs are often ~6–9 m/s bursts; we cap lower. */
const moveSpeed = 3.5;
/** Maps stick m/s into glide wind “airspeed” so light walk vs full sprint read clearly in volume/pitch. */
const LOCOMOTION_AUDIO_UPSCALE = 1.9;
const rotateSpeed = 120;
const verticalSpeed = 2;
const deadzone = 0.15;

/* ── Locomotion modes ─────────────────────────────────────────────────── */
/** Map=1: both grip (squeeze) buttons held — enter/exit editor after this many ms. */
const EDITOR_BOTH_GRIP_HOLD_MS = 800;
let bothGripSqueezeStartMs_ = 0;
let bothGripChordArmed_ = true;
/** After a both-grip toggle, ignore until both squeezes release (prevents double flip). */
let bothGripChordCooldownUntilRelease_ = false;
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
const handToPose = { left: null, right: null };
/** True while wingsuit glide hysteresis is active (spread arms while falling). */
let glideLatch_ = false;
/** |v| at start of this frame’s glide wing block — hard ceiling after collision = this × exp(−cruise×dt). */
let glideFrameS0_ = -1;
/** >0: parkour jump / wall jump — do not allow new glide latch (run+jump+arms wide). */
let parkourJumpGlideBlockSec_ = 0;
let prevGrappleHookActive_ = false;
let grapplePostWinchCarrySec_ = 0;
const rigVelocity = new THREE.Vector3();
const PLAYER_RADIUS = 0.3;
/** Max rig travel per collision substep (m) — prevents BVH tunneling at glide speed. */
const COLLISION_MOTION_STEP = 0.16;
const _rigMovePrev = new THREE.Vector3();
const _rigMoveDelta = new THREE.Vector3();
const _rigMoveStep = new THREE.Vector3();
const _deltaHoriz = new THREE.Vector3();
const _deltaProj = new THREE.Vector3();
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
function runGlbCollisionPasses() {
  resolveGlbMeshCollisions(cameraRig.position, PLAYER_RADIUS, rigVelocity);
  resolveGlbMeshCollisions(cameraRig.position, PLAYER_RADIUS, rigVelocity);
  recoverRigFromGlbPenetration(cameraRig.position, PLAYER_RADIUS, rigVelocity);
}

/**
 * Integrate rig velocity in small steps with swept BVH checks so fast falls / glides
 * cannot skip through city wall geometry in a single frame.
 */
function integrateRigMotionWithCollision(dtSec) {
  _rigMoveDelta.set(rigVelocity.x * dtSec, rigVelocity.y * dtSec, rigVelocity.z * dtSec);
  const moveLen = _rigMoveDelta.length();
  if (moveLen < 1e-8) return;
  const steps = Math.max(1, Math.ceil(moveLen / COLLISION_MOTION_STEP));
  const inv = 1 / steps;
  _rigMoveStep.copy(_rigMoveDelta).multiplyScalar(inv);
  for (let s = 0; s < steps; s++) {
    _rigMovePrev.copy(cameraRig.position);
    cameraRig.position.add(_rigMoveStep);
    clampRigMotionAgainstGlbMeshes(_rigMovePrev, cameraRig.position, PLAYER_RADIUS, rigVelocity);
    resolveAllCollisions(cameraRig.position);
    runGlbCollisionPasses();
  }
}

function moveRigHorizWithCollision(delta) {
  const horizLen = delta.length();
  if (horizLen < 1e-8) return;
  const steps = Math.max(1, Math.ceil(horizLen / COLLISION_MOTION_STEP));
  const inv = 1 / steps;
  _rigMoveStep.copy(delta).multiplyScalar(inv);
  for (let s = 0; s < steps; s++) {
    _rigMovePrev.copy(cameraRig.position);
    cameraRig.position.add(_rigMoveStep);
    clampRigMotionAgainstGlbMeshes(_rigMovePrev, cameraRig.position, PLAYER_RADIUS, rigVelocity);
    resolveAllCollisions(cameraRig.position);
    runGlbCollisionPasses();
  }
}
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
      /* Floor slabs are handled by `getFloorY()` (vertical snap) — skip
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

const WALL_PROXIMITY_PAD = 0.09;
let _wallSepHorizBest = 0;
const _wallSepDirXZ = new THREE.Vector3();
const _wallPushHoriz = new THREE.Vector3();
const wallJumpOutNormal = new THREE.Vector3(0, 0, 0);
let wallJumpSurfaceValidUntilMs = 0;
const WALL_JUMP_INTO_SPEED = 0.55;
const WALL_JUMP_THROW_HORIZ_MIN = 0.35;
const WALL_JUMP_THROW_AWAY_DOT = 0.22;
const WALL_JUMP_KICK_HORIZ = 3.4;
const WALL_JUMP_KICK_UP = 2.0;
const _localDelta = new THREE.Vector3();
const _throwAssistVel = new THREE.Vector3();
const _worldHandVel = new THREE.Vector3();
const _handVel = new THREE.Vector3();

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
    ? getFloorY(px, pz, feetY, slack)
    : getFloorY(px, pz, feetY, slack);
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
    const fyR = getGlbFloorY(px, pz, cameraRig.position.y);
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
    const fy = getGlbFloorY(px, pz, cameraRig.position.y);
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
  /* Head‑relative XZ fly: use headset **world** yaw only. `xrCamera.quaternion` is
   * local to the rig — composing it again with `cameraRig.quaternion` double‑applied
   * body yaw and broke stick direction vs where you look. */
  xrCamera.getWorldQuaternion(_glQuatW);
  _glEul.setFromQuaternion(_glQuatW, "YXZ");
  _glEul.x = 0;
  _glEul.z = 0;
  _glQuatW.setFromEuler(_glEul);
  const direction = _glFwd;
  direction.set(0, 0, -1).applyQuaternion(_glQuatW);
  direction.y = 0;
  if (direction.lengthSq() < 1e-10) {
    direction.set(0, 0, -1).applyQuaternion(cameraRig.quaternion);
    direction.y = 0;
  }
  if (direction.lengthSq() < 1e-10) direction.set(0, 0, -1);
  direction.normalize();
  const strafe = _localPush;
  strafe.set(-direction.z, 0, direction.x);
  const moveX = Math.abs(vrInput.leftStick.x) > deadzone ? -vrInput.leftStick.x : 0;
  const moveY = Math.abs(vrInput.leftStick.y) > deadzone ? -vrInput.leftStick.y : 0;
  const flyMul = RUNNER_MAP_ID === 1 ? 2.85 : 1;
  if (moveX !== 0 || moveY !== 0) {
    cameraRig.position.x += (direction.x * moveY - strafe.x * moveX) * moveSpeed * flyMul * dt;
    cameraRig.position.z += (direction.z * moveY - strafe.z * moveX) * moveSpeed * flyMul * dt;
  }
  const rotateX = Math.abs(vrInput.rightStick.x) > deadzone ? vrInput.rightStick.x : 0;
  if (rotateX !== 0) {
    cameraRig.rotation.y -= rotateX * rotateSpeed * dt * (Math.PI / 180);
  }
  const moveVertical = Math.abs(vrInput.rightStick.y) > deadzone ? vrInput.rightStick.y : 0;
  const vertMul = RUNNER_MAP_ID === 1 ? 2.4 : 1;
  if (moveVertical !== 0) {
    cameraRig.position.y -= moveVertical * verticalSpeed * vertMul * dt;
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

  integrateRigMotionWithCollision(dt);

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
        moveRigHorizWithCollision(_deltaHoriz);
      } else if (groundMerged.valid) {
        const nn = groundMerged.normal;
        _deltaProj.copy(_deltaHoriz).addScaledVector(nn, -nn.dot(_deltaHoriz));
        /* GLB ramps: steeper = shorter projection in world XZ — extra scale helps long climbs. */
        let rampBoost = 1.12;
        if (groundMerged.fromGlb) {
          rampBoost = 1.12 + Math.min(0.48, (SLOPE_FLAT_NY - nn.y) * 6.5);
        }
        _deltaProj.multiplyScalar(rampBoost);
        moveRigHorizWithCollision(_deltaProj);
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
  /* Sandbox can briefly flatten to zero OBBs while streaming; user props / city
   * GLBs still live in `glbCollisionMeshes_` and must keep resolving in physics. */
  if (getWorldCollisionBoxes().length === 0 && getSandboxGlbCollisionMeshes().length === 0) {
    return;
  }
  /* Breakable glass **before** OBB resolve: thin user-glass OBBs live in the same list as
   * walls, so `resolveAllCollisions` would push the rig out of the pane first and
   * `tryShatterRunnerGlassPlayer` would almost never see an overlap. */
  cameraRig.updateMatrixWorld(true);
  _headW.copy(headSourceCamera.position).applyMatrix4(cameraRig.matrixWorld);
  tryShatterRunnerGlassPlayer(
    cameraRig.position, rigVelocity, _headW.x, _headW.y, _headW.z,
  );
  resolveAllCollisions(cameraRig.position);
  /* Final depenetrate pass after stick / snap moves in the same frame. */
  runGlbCollisionPasses();
  /* Floor snap *after* OBB push so wall pushes can't shove us off the slab. */
  snapRigToFloor(dtSec);
  tryRunnerPitFallReset();
}

let pitFallResetBusy = false;
function tryRunnerPitFallReset() { /* disabled in GTAVR embed */ }

/** @param {Gamepad | null | undefined} gp @param {boolean} toLeftHand */
function applyGamepadAxesToVRInput_(gp, toLeftHand) {
  if (!gp?.axes || gp.axes.length < 2) return;
  const axes = gp.axes;
  let stickX;
  let stickY;
  if (axes.length >= 4) {
    stickX = axes[2];
    stickY = axes[3];
  } else {
    stickX = axes[0] || 0;
    stickY = axes[1] || 0;
  }
  if (toLeftHand) {
    vrInput.leftStick.x = stickX;
    vrInput.leftStick.y = stickY;
  } else {
    vrInput.rightStick.x = stickX;
    vrInput.rightStick.y = stickY;
  }
}

function updateVRMovement(delta) {
  const session = renderer.xr.getSession();
  if (!session) return;
  if (renderer.xr?.isPresenting && camera && typeof renderer.xr.updateCamera === 'function') {
    renderer.xr.updateCamera(camera);
  }
  vrInput.leftStick.x = 0;
  vrInput.leftStick.y = 0;
  vrInput.rightStick.x = 0;
  vrInput.rightStick.y = 0;

  const xrPad = getPairedXRControllerGrips(session, controllerGrip1, controllerGrip2);
  applyGamepadAxesToVRInput_(xrPad.L?.gamepad, true);
  applyGamepadAxesToVRInput_(xrPad.R?.gamepad, false);

  const dt = Math.min(0.1, (delta || 0) / 1000);
  if (!(dt > 0)) return;

  const xrCamera = renderer.xr.getCamera();
  updatePhysicsMovement(dt, xrCamera);
  tickRunnerCollisionIntegration(xrCamera, dt);
  applyGlideCruiseAfterCollision_(dt);
}

  function registerHands(leftGrip, rightGrip) {
    handToCtrl.left = leftGrip || null;
    handToCtrl.right = rightGrip || null;
  }

  function syncHandSlotsFromGrips() {
    if (!deps.syncHandSlotsFromGrips) return;
    const slots = deps.syncHandSlotsFromGrips();
    if (slots) registerHands(slots.left, slots.right);
  }

  function resetRigAt(pos, yaw) {
    if (pos) cameraRig.position.copy(pos);
    if (typeof yaw === 'number') cameraRig.rotation.set(0, yaw + Math.PI, 0);
    rigVelocity.set(0, 0, 0);
    jumpsRemaining = MAX_JUMPS;
    parkourJumpGlideBlockSec_ = 0;
    glideLatch_ = false;
    grabState.left.active = false;
    grabState.right.active = false;
    grabState.left.history.length = 0;
    grabState.right.history.length = 0;
  }

  function updateFootFrame(deltaMs) {
    syncHandSlotsFromGrips();
    updateVRMovement(deltaMs);
    if (crouchViewGroup && camera) {
      applyRunnerCameraDuck(camera, crouchViewGroup, { deltaMs: deltaMs || 16.67 });
    }
  }

  function setStickInput(leftStick, rightStick) {
    if (leftStick) {
      vrInput.leftStick.x = leftStick.x || 0;
      vrInput.leftStick.y = leftStick.y || 0;
    }
    if (rightStick) {
      vrInput.rightStick.x = rightStick.x || 0;
      vrInput.rightStick.y = rightStick.y || 0;
    }
  }

  function updateFootDesktop(dtSec, viewCamera) {
    syncHandSlotsFromGrips();
    const cam = viewCamera || camera;
    updatePhysicsMovement(dtSec, cam);
    tickRunnerCollisionIntegration(cam, dtSec);
    applyGlideCruiseAfterCollision_(dtSec);
    if (crouchViewGroup && camera) {
      applyRunnerCameraDuck(camera, crouchViewGroup, { deltaMs: dtSec * 1000 });
    }
  }

  function setRigVelocity(v) {
    if (!v) {
      rigVelocity.set(0, 0, 0);
      return;
    }
    rigVelocity.copy(v);
  }

  return {
    updateFootFrame,
    updateFootDesktop,
    setStickInput,
    updateVRMovement,
    updatePhysicsMovement,
    tickRunnerCollisionIntegration,
    applyGlideCruiseAfterCollision_,
    getRigVelocity: () => rigVelocity,
    setRigVelocity,
    registerHands,
    resetRigAt,
    isGrounded,
  };
}
