/**
 * brutalistVR7 — Arc-Raiders-style flying drones with FSM AI, perception
 * (sight + hearing + last-known-position), per-component damage, and a
 * controller-aimed weapon for the player.
 *
 * Self-contained module. main.js calls:
 *   - initBots(opts)         once, after sceneObjects/collisionBoxes exist
 *   - updateBots(dt)         every frame inside animate()
 *   - setBotsEnabled(on)     to start/stop combat mode (default off)
 *   - getBotsEnabled()       query state
 *
 * No imports back into main.js — `opts` carries everything we need.
 *
 * Design notes
 * ------------
 * • Drones are flyers, so we sidestep ground nav-mesh problems entirely. They
 *   prefer to be above the building (where there's no occlusion) and only
 *   descend to track / attack a visible player.
 * • Sight-of-line uses ray-vs-OBB against the same `collisionBoxes` array
 *   the player's locomotion uses for collision — the wall that stops your
 *   head from clipping is the same wall that hides you from the bot.
 * • Hearing is a distance gate that grows when the player's horizontal speed
 *   is above a "running" threshold (`HEARING_RUN_RADIUS` vs `HEARING_RADIUS`).
 * • Component damage: every interesting child of a drone Group has
 *   `userData = { kind, hp, maxHp, broken }`. Player raycast → first hit
 *   walks up the parent chain to find the nearest tagged component. Broken
 *   components feed multipliers (workingRotors → liftFactor; targeting
 *   broken → wider aim cone; power broken → drone disabled immediately).
 * • Per-frame budget for 5 drones ≈ 5 LOS rays + 5×3 avoidance probes +
 *   5 separation checks + a handful of projectile updates. Trivial vs the
 *   GPU budget; well under 1 ms CPU on Quest 3.
 */

import * as THREE from "three";

/* ── Tunables ─────────────────────────────────────────────────────────── */

const PLAYER_MAX_HP = 100;
const PLAYER_INVULN_AFTER_RESPAWN = 2.0;
const PLAYER_HIT_RADIUS = 0.45;          // capsule radius for projectile→player hit

const SPAWN_TARGET = 3;                  // drones alive simultaneously
const MAX_DRONES = 5;                    // safety cap
const DRONE_RESPAWN_DELAY = 4.0;
const DRONE_PERCEPTION_RANGE = 45;       // visibility cap (m), idle states
const DRONE_AGGRO_PERCEPTION_MULT = 2.0; // aggressive states see/track 2× as far
const DRONE_FIRE_RANGE = 52;             // 2× the old engagement range — drones can pepper you from much further
const DRONE_STANDOFF = 9;                // hover distance from player
const DRONE_FLEE_NEAR = 5;               // back off if closer than this
const DRONE_LOSE_INTEREST = 4.0;         // seconds without LOS → INVESTIGATE
const DRONE_INVESTIGATE_DURATION = 7.0;  // then back to SURVEY
const DRONE_ALERT_DURATION = 0.45;
const DRONE_EVADE_DURATION = 1.6;

/* Aim / focus procedure (Arc-Raiders-style):
 *   Aggressive drones don't insta-fire. They have an `aimFocus` (0..1)
 *   that grows over DRONE_AIM_TIME while they have LOS to the player; the
 *   visible cone narrows as focus increases (visual "they're locking on").
 *   Once aimFocus ≥ FIRE_THRESHOLD AND LOS, they fire ONE shot, drop
 *   focus to AIM_POST_FIRE, and start the next aim cycle. Losing LOS
 *   bleeds focus back down over DRONE_AIM_DECAY_TIME.
 *
 *   Getting hit forces focus → 0 and starts a wobble + reposition cycle
 *   (handled by EVADE state). So shooting an attacker that's about to
 *   fire genuinely interrupts them and buys you time to relocate. */
const DRONE_AIM_TIME = 1.4;
const DRONE_AIM_DECAY_TIME = 0.6;
const DRONE_AIM_FIRE_THRESHOLD = 0.92;
const DRONE_AIM_POST_FIRE = 0.35;
const DRONE_WOBBLE_DURATION = 0.5;       // visual roll-oscillation after a hit

const DRONE_FIRE_INTERVAL_BASE = 1.6;    // seconds between shots, scaled by power
const DRONE_FIRE_LEAD = 0.45;            // seconds of player motion to lead
const DRONE_PROJECTILE_SPEED = 18;
const DRONE_PROJECTILE_DAMAGE = 12;
const DRONE_PROJECTILE_RADIUS = 0.12;
const DRONE_PROJECTILE_TTL = 4.0;

const HEARING_RADIUS = 14;
const HEARING_RUN_RADIUS = 32;
const PLAYER_RUN_SPEED = 4.0;            // |XZ velocity| above this counts as "running" (loud)

const PLAYER_FIRE_INTERVAL = 0.16;       // hitscan rate
const PLAYER_DAMAGE = 14;
const TRACER_TTL = 0.06;
const TRACER_LENGTH = 60;

const STEERING_MAX_SPEED = 7;
const STEERING_MAX_ATTACK_SPEED = 9;
const STEERING_MAX_FORCE = 24;           // m/s² acceleration ceiling
const SEPARATION_RADIUS = 4.0;
const AVOID_PROBE_DIST = 4.0;

const SPAWN_HEIGHT_RANGE = [22, 38];
const SPAWN_RADIUS_RANGE = [25, 70];
const TRACK_HEIGHT_OFFSET = 1.0;         // hover this much above the player's head

/* Vision cone — both a visual cue and a real perception gate. The drone
 * can only SEE through this cone (hearing is still 360°), so a player
 * out of the cone slips by visually until the drone happens to face
 * them. Half-angle 35° → 70° total FOV, generous enough that drones
 * notice things in their general field but narrow enough that flanking
 * around to their back side actually works. */
const VISION_HALF_ANGLE_DEG = 35;
const VISION_DOT_THRESHOLD = Math.cos((VISION_HALF_ANGLE_DEG * Math.PI) / 180);
const VISION_CONE_LENGTH = 18;
const VISION_CONE_BASE_RADIUS =
  VISION_CONE_LENGTH * Math.tan((VISION_HALF_ANGLE_DEG * Math.PI) / 180);
const VISION_AGGRO_LENGTH_MULT = 2.0;    // visible cone stretches 2× when aggressive
const VISION_NARROW_RATIO = 0.10;        // cone width at full focus (≈ 4° half-angle)

/* ── Module state ─────────────────────────────────────────────────────── */

let scene_;
let camera_;          // perspective camera (head pose target in WebXR)
let cameraRig_;       // cameraRig parent in main.js
let renderer_;
let getCollisionBoxes_;  // () => OBB[]
let getPlayerVelocity_;  // () => THREE.Vector3 | null  (rigVelocity, for hearing)
let getPlayerSpawn_;     // () => THREE.Vector3        (where to put the rig on respawn)
let respawnPlayer_;      // () => void                 (main.js's preferred respawn impl)

let enabled_ = false;
let initDone_ = false;

const drones_ = [];       // active Drone instances
const projectiles_ = [];  // drone-fired projectiles in flight
const tracers_ = [];      // player tracer line segments
const debris_ = [];       // post-death tumbling fragments
const respawnQueue_ = []; // { time: secondsRemaining }

let playerHp_ = PLAYER_MAX_HP;
let playerInvuln_ = 0;
let playerFireCooldown_ = 0;
let prevTriggerR_ = false;
let prevButtonX_ = false;
let kills_ = 0;
let deaths_ = 0;

/* Audio (procedural — no external samples).
 * One AudioListener attached to the perspective camera; one shared
 * AudioBuffer per sound type, generated once at init from synthesized
 * sine + envelope + noise. Drones own a PositionalAudio for their hum
 * (looped, refDistance = 4 m); one-shots are spawned via short-lived
 * Object3D holders so the audio survives the source dying. */
let audioListener_ = null;
const audioBuffers_ = {};
let audioReady_ = false;

/* HUD elements */
let combatBtn_ = null;
let combatStatusEl_ = null;
let damageOverlay_ = null;
let respawnOverlay_ = null;
let crosshairMesh_ = null;
let desktopCrosshair_ = null;
let combatHudMesh_ = null;
let combatHudCanvas_ = null;
let combatHudCtx_ = null;
let combatHudTexture_ = null;
let combatHudLastDrawnHp_ = -1;
let combatHudLastDrawnDrones_ = -1;
let damageOverlayTimer_ = 0;
/* VR damage flash: a head-locked red vignette plane (DOM overlays are
 * invisible inside an XR session, so we need a 3D version too). */
let vrDamageMesh_ = null;
let vrDamageMat_ = null;

/* Scratch vectors — never allocate per-frame.
 *
 * Discipline:
 *   _v0, _v1   : top-level (updateBots) — hold playerHead/playerBody during
 *                a single `updateBots(dt)` call. NEVER touched inside Drone
 *                methods or ray helpers; corrupting them would silently
 *                misaim every drone for the rest of the frame.
 *   _d0..._d4  : Drone steering / FSM scratch.
 *   _rayDir, _rayPt : ray-helper scratch (hasLineOfSight).
 *   _localOrigin/_localDir/_localPt : ray-vs-OBB transformation.
 */
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _d0 = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _d3 = new THREE.Vector3();
const _d4 = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _rayDir = new THREE.Vector3();
const _rayPt = new THREE.Vector3();
const _localOrigin = new THREE.Vector3();
const _localDir = new THREE.Vector3();
const _localPt = new THREE.Vector3();

/* ── Player position helpers ──────────────────────────────────────────── */

/** Player head position in world space (XR camera through rig matrix, or perspective camera world). */
function getPlayerHeadWorld(out) {
  if (renderer_.xr.isPresenting) {
    const xrCam = renderer_.xr.getCamera();
    cameraRig_.updateMatrixWorld(true);
    out.copy(xrCam.position).applyMatrix4(cameraRig_.matrixWorld);
  } else {
    camera_.getWorldPosition(out);
  }
  return out;
}

/** "Body centre" — head minus 0.7m (approx neck). Gives drones a slightly better target than the eyes. */
function getPlayerBodyWorld(out) {
  getPlayerHeadWorld(out);
  out.y = Math.max(out.y - 0.7, 0.5);
  return out;
}

function getPlayerSpeed() {
  if (!getPlayerVelocity_) return 0;
  const v = getPlayerVelocity_();
  if (!v) return 0;
  return Math.hypot(v.x, v.z);
}

/* ── OBB ray / point helpers ──────────────────────────────────────────── */

/**
 * True if any collision box contains `point` (treated as a tiny sphere of
 * radius `pad`). Uses the same OBB structure main.js builds for player
 * collision.
 */
function pointInsideAnyOBB(point, pad = 0) {
  const boxes = getCollisionBoxes_();
  for (const b of boxes) {
    _localPt.set(point.x - b.cx, point.y - b.cy, point.z - b.cz).applyMatrix3(b.mInv);
    if (Math.abs(_localPt.x) >= b.hx + pad) continue;
    if (Math.abs(_localPt.y) >= b.hy + pad) continue;
    if (Math.abs(_localPt.z) >= b.hz + pad) continue;
    return true;
  }
  return false;
}

/* Scratch for pushDroneOutOfWalls. */
const _pushLocal = new THREE.Vector3();
const _pushWorld = new THREE.Vector3();

/**
 * Same try-out-along-closest-face strategy as main.js's
 * `resolveAllCollisions`, but for one drone-radius point. When a drone gets
 * forced into a slab (player-impulse knockback, edge cases in steering),
 * pop it out along the box face with smallest penetration. Treats the
 * drone as a sphere of radius PAD ≈ 0.32 m (drone hull half-extent).
 */
function pushDroneOutOfWalls(drone) {
  const PAD = 0.32;
  const boxes = getCollisionBoxes_();
  const p = drone.group.position;
  for (let iter = 0; iter < 2; iter++) {
    let pushed = false;
    for (const b of boxes) {
      _pushLocal.set(p.x - b.cx, p.y - b.cy, p.z - b.cz).applyMatrix3(b.mInv);
      const exX = b.hx + PAD;
      const exY = b.hy + PAD;
      const exZ = b.hz + PAD;
      if (Math.abs(_pushLocal.x) >= exX) continue;
      if (Math.abs(_pushLocal.y) >= exY) continue;
      if (Math.abs(_pushLocal.z) >= exZ) continue;
      const px = exX - Math.abs(_pushLocal.x);
      const py = exY - Math.abs(_pushLocal.y);
      const pz = exZ - Math.abs(_pushLocal.z);
      if (px < py && px < pz) {
        _pushWorld.set(_pushLocal.x > 0 ? px : -px, 0, 0);
      } else if (py < pz) {
        _pushWorld.set(0, _pushLocal.y > 0 ? py : -py, 0);
      } else {
        _pushWorld.set(0, 0, _pushLocal.z > 0 ? pz : -pz);
      }
      _pushWorld.applyMatrix3(b.m);
      p.add(_pushWorld);
      /* Kill the velocity component into the wall so the drone stops
       * trying to push further in (Newton-style projection). */
      const vDot = drone.velocity.dot(_pushWorld);
      if (vDot < 0) {
        const n = _pushWorld.lengthSq();
        if (n > 1e-8) drone.velocity.addScaledVector(_pushWorld, -vDot / n);
      }
      pushed = true;
    }
    if (!pushed) break;
  }
}

/**
 * Ray-vs-OBB by transforming the ray to box local space and slab-testing
 * against an axis-aligned box (±hx, ±hy, ±hz). Returns the smallest
 * non-negative `t` along `dir` (length-respecting), or Infinity if no hit
 * in [0, maxDist].
 */
function rayHitOBB(origin, dir, b, maxDist) {
  _localOrigin.set(origin.x - b.cx, origin.y - b.cy, origin.z - b.cz).applyMatrix3(b.mInv);
  _localDir.copy(dir).applyMatrix3(b.mInv);

  let tmin = -Infinity;
  let tmax = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? _localOrigin.x : axis === 1 ? _localOrigin.y : _localOrigin.z;
    const d = axis === 0 ? _localDir.x    : axis === 1 ? _localDir.y    : _localDir.z;
    const h = axis === 0 ? b.hx           : axis === 1 ? b.hy           : b.hz;
    if (Math.abs(d) < 1e-8) {
      if (o < -h || o > h) return Infinity;
    } else {
      const inv = 1 / d;
      let t1 = (-h - o) * inv;
      let t2 = ( h - o) * inv;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmax < tmin) return Infinity;
    }
  }
  if (tmax < 0) return Infinity;
  const t = tmin >= 0 ? tmin : tmax;
  if (t > maxDist) return Infinity;
  return t;
}

/** Earliest world-space hit-distance of a ray vs all collision boxes. Infinity if none. */
function rayHitWorld(origin, dir, maxDist = 200) {
  const boxes = getCollisionBoxes_();
  let best = Infinity;
  for (const b of boxes) {
    const t = rayHitOBB(origin, dir, b, maxDist);
    if (t < best) best = t;
  }
  return best;
}

/** Sight check: drone → player head, blocked by collision boxes?
 *  `maxRange` defaults to DRONE_PERCEPTION_RANGE; aggressive drones pass
 *  a larger value (2× by default) so they can track through space at
 *  longer distances during ATTACK / EVADE / INVESTIGATE. */
function hasLineOfSight(droneWorldPos, playerHeadWorld, maxRange) {
  if (maxRange === undefined) maxRange = DRONE_PERCEPTION_RANGE;
  _rayDir.copy(playerHeadWorld).sub(droneWorldPos);
  const dist = _rayDir.length();
  if (dist > maxRange) return false;
  if (dist < 0.001) return true;
  _rayDir.divideScalar(dist);
  /* Step the origin a hair forward so a drone *inside* a box (shouldn't
   * happen, but defensive) doesn't self-occlude. */
  _rayPt.copy(droneWorldPos).addScaledVector(_rayDir, 0.05);
  const t = rayHitWorld(_rayPt, _rayDir, dist - 0.1);
  return t >= dist - 0.1;
}

/* Scratch reserved for FOV / cone facing math (separate from _rayDir/_rayPt
 * so the LOS check inside perceives() doesn't trample these values). */
const _fovFwd = new THREE.Vector3();
const _fovTo  = new THREE.Vector3();

/** True if `playerHead` lies inside this drone's vision cone.
 *
 *  IMPORTANT: the cone geometry (built apex-at-origin, base translated
 *  to +Z) and `faceTarget` (yaw = atan2(dx, dz) which puts the *target*
 *  on local +Z when applied) both use +Z as the drone's forward axis.
 *  Earlier this passed -Z here, which silently failed every dot check
 *  → the visual cone pointed at you while the drone was internally
 *  "looking" out of its back. Hearing carried the gameplay so the bug
 *  wasn't obvious, but visual ↔ perception now agree. */
function isInDroneFOV(drone, playerHead) {
  _fovFwd.set(0, 0, 1).applyQuaternion(drone.group.quaternion);
  _fovTo.subVectors(playerHead, drone.group.position);
  const len = _fovTo.length();
  if (len < 0.001) return true;
  _fovTo.divideScalar(len);
  return _fovFwd.dot(_fovTo) > VISION_DOT_THRESHOLD;
}

/* ── Drone construction ───────────────────────────────────────────────── */

/* Vision-cone geometry — built once and shared across drones. ConeGeometry's
 * default axis is +Y with apex up; we translate so the apex sits at the
 * origin, then rotate so the base extends in -Z (the drone's local forward).
 * Open-ended (no apex/base discs) gives a cleaner "flashlight beam" look. */
let visionConeGeo_ = null;
function getVisionConeGeo() {
  if (visionConeGeo_) return visionConeGeo_;
  const geo = new THREE.ConeGeometry(
    VISION_CONE_BASE_RADIUS,
    VISION_CONE_LENGTH,
    24, 1, true,
  );
  geo.translate(0, -VISION_CONE_LENGTH / 2, 0);
  geo.rotateX(-Math.PI / 2);
  visionConeGeo_ = geo;
  return visionConeGeo_;
}

function buildDroneMesh() {
  const matBody     = new THREE.MeshStandardMaterial({ color: 0x2a2a32, roughness: 0.55, metalness: 0.45 });
  const matRotor    = new THREE.MeshStandardMaterial({ color: 0x111114, roughness: 0.75, metalness: 0.18 });
  const matAccent   = new THREE.MeshStandardMaterial({ color: 0xff4422, emissive: 0xff2a14, emissiveIntensity: 1.4, roughness: 0.4, metalness: 0.4 });
  const matTargeting= new THREE.MeshStandardMaterial({ color: 0xffd24a, emissive: 0xffaa11, emissiveIntensity: 1.0, roughness: 0.4, metalness: 0.5 });

  const drone = new THREE.Group();
  drone.name = "drone";

  /* Body: about a third smaller than the original 0.55 cube, but with
   * DOUBLED HP (140) so the central hull is a serious sponge — players
   * are expected to chip through it via component damage rather than
   * tank-shooting it directly. */
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.36), matBody);
  body.userData = { kind: "body", hp: 140, maxHp: 140, broken: false };
  drone.add(body);

  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 0.28), matBody);
  belly.position.y = -0.06;
  drone.add(belly);

  const core = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.12), matAccent);
  core.position.y = 0.09;
  core.userData = { kind: "power", hp: 28, maxHp: 28, broken: false };
  drone.add(core);

  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), matTargeting);
  cam.position.set(0, -0.035, 0.18);
  cam.userData = { kind: "targeting", hp: 18, maxHp: 18, broken: false };
  drone.add(cam);

  /* Rotors: blades are doubled in length (0.42 → 0.84). Offsets pushed
   * outward from 0.32 to 0.48 so adjacent props don't visually overlap.
   * Per-rotor HP raised slightly to 28 so a rotor takes EXACTLY 2 hits
   * (PLAYER_DAMAGE = 14 → 14 + 14 = 28 → broken on the 2nd shot). */
  const rotorOffsets = [
    [ 0.48, 0.03,  0.48], [-0.48, 0.03,  0.48],
    [ 0.48, 0.03, -0.48], [-0.48, 0.03, -0.48],
  ];
  const rotorNames = ["FR", "FL", "BR", "BL"];
  drone.userData.rotors = [];
  drone.userData.components = [body, core, cam];
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 8), matBody);
    arm.position.fromArray(rotorOffsets[i]);
    arm.userData = { kind: "rotor", name: rotorNames[i], hp: 28, maxHp: 28, broken: false, spinning: true };
    drone.add(arm);

    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.022, 0.07), matRotor);
    blade.position.set(0, 0.045, 0);
    arm.add(blade);
    arm.userData.blade = blade;

    drone.userData.rotors.push(arm);
    drone.userData.components.push(arm);
  }

  /* Status LED on top — independent of damageable components, so it can
   * pulse alertness colour without fighting the hit-flash code. Cool blue
   * when SURVEYing, amber blink in ALERT/INVESTIGATE, rapid red blink in
   * ATTACK/EVADE. Each drone gets its own material instance so the per-
   * drone state doesn't bleed across instances. */
  const ledMat = new THREE.MeshStandardMaterial({
    color: 0x66bbff,
    emissive: 0x4488ff,
    emissiveIntensity: 1.4,
    roughness: 0.4,
    metalness: 0.1,
  });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), ledMat);
  led.position.set(0, 0.17, 0);
  drone.add(led);
  drone.userData.statusLed = led;

  /* Vision cone — semi-transparent, additive-blended, parented to the
   * drone group so it inherits the body's facing rotation. Per-drone
   * material so we can tint each drone's cone independently by state. */
  const coneMat = new THREE.MeshBasicMaterial({
    color: 0x4488ff,
    transparent: true,
    opacity: 0.10,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const cone = new THREE.Mesh(getVisionConeGeo(), coneMat);
  /* Don't let the cone block click/raycasts on the drone itself. */
  cone.raycast = () => null;
  drone.add(cone);
  drone.userData.visionCone = cone;

  /* Cache name → quick lookup for component effects. */
  drone.userData.findKind = (kind) =>
    drone.userData.components.find((c) => c.userData?.kind === kind);

  return drone;
}

/** Walk up parent chain to find the first node with userData.kind. */
function findComponent(hitObj) {
  let n = hitObj;
  while (n) {
    if (n.userData && n.userData.kind) return n;
    n = n.parent;
  }
  return null;
}

/** Walk up parent chain to find a Drone instance (set on group via droneRef). */
function findDroneFromHit(hitObj) {
  let n = hitObj;
  while (n) {
    if (n.userData && n.userData.droneRef) return n.userData.droneRef;
    n = n.parent;
  }
  return null;
}

/* ── Drone class ──────────────────────────────────────────────────────── */

class Drone {
  constructor(spawnPos) {
    this.group = buildDroneMesh();
    this.group.position.copy(spawnPos);
    this.group.userData.droneRef = this;
    scene_.add(this.group);

    this.velocity = new THREE.Vector3();
    this.targetPos = new THREE.Vector3().copy(spawnPos);
    this.lkp = new THREE.Vector3();
    this.haveLkp = false;
    this.state = "SURVEY";
    this.stateTime = 0;
    this.timeSinceLOS = 999;
    this.fireCooldown = THREE.MathUtils.randFloat(0.8, 1.6);
    this.surveyChangeIn = THREE.MathUtils.randFloat(0.5, 2.5);
    this.dead = false;
    this.removedAt = 0;
    this.rotorPhase = Math.random() * Math.PI * 2;
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this.aimYaw = 0;
    this.aimPitch = 0;
    /* Aim focus 0..1 — grows in ATTACK with LOS, decays otherwise, snaps
     * to 0 on takeDamage. The visible cone width is driven from this. */
    this.aimFocus = 0;
    /* Brief visual roll-oscillation after a hit. Decremented in update(). */
    this.wobbleTimer = 0;
    this.isAlert = false;          // current hum buffer state
    this.audio = null;             // PositionalAudio for the looped hum

    /* Looped hum starts on the idle buffer; switched to alert buffer on
     * the first FSM transition out of SURVEY. setMediaElement-style
     * loop=true on PositionalAudio gives a clean continuous source. */
    if (audioReady_ && audioListener_ && audioBuffers_.droneHumIdle) {
      this.audio = new THREE.PositionalAudio(audioListener_);
      this.audio.setBuffer(audioBuffers_.droneHumIdle);
      this.audio.setRefDistance(4);
      this.audio.setMaxDistance(80);
      this.audio.setRolloffFactor(1.2);
      this.audio.setLoop(true);
      this.audio.setVolume(0.55);
      this.group.add(this.audio);
      try { this.audio.play(); } catch (_) { /* may fail if context still suspended */ }
    }

    this.pickSurveyTarget();
  }

  /** Returns true if the FSM is in any non-idle state. */
  isAggressive() {
    return this.state === "ALERT" || this.state === "ATTACK"
        || this.state === "INVESTIGATE" || this.state === "EVADE";
  }

  /* Update the LED tint + emissive pulse and (if needed) swap the
   * looped hum buffer between idle and alert. Cheap — one material
   * touch per frame per drone. */
  updateAlertnessAudio() {
    const aggressive = this.isAggressive();
    if (aggressive !== this.isAlert) {
      this.isAlert = aggressive;
      if (this.audio && audioReady_) {
        const buf = aggressive ? audioBuffers_.droneHumAlert : audioBuffers_.droneHumIdle;
        if (buf) {
          try { this.audio.stop(); } catch (_) { /* ignore */ }
          this.audio.setBuffer(buf);
          this.audio.setVolume(aggressive ? 0.75 : 0.55);
          try { this.audio.play(); } catch (_) { /* ignore */ }
        }
      }
    }

    /* LED + vision cone visual: state → colour + blink rate. Both share
     * the same hex so the LED and cone agree about alertness at a glance. */
    let hex, intensity, blinkHz, coneOpacity;
    switch (this.state) {
      case "SURVEY":      hex = 0x4488ff; intensity = 1.4;  blinkHz = 0;  coneOpacity = 0.08; break;
      case "ALERT":
      case "INVESTIGATE": hex = 0xffaa22; intensity = 2.6;  blinkHz = 4;  coneOpacity = 0.16; break;
      case "ATTACK":
      case "EVADE":       hex = 0xff3322; intensity = 4.0;  blinkHz = 10; coneOpacity = 0.22; break;
      default:            hex = 0x4488ff; intensity = 1.4;  blinkHz = 0;  coneOpacity = 0.08;
    }
    const blinkMul = blinkHz > 0
      ? 0.4 + 0.6 * Math.abs(Math.sin(this.stateTime * blinkHz))
      : 1;
    const led = this.group.userData.statusLed;
    if (led) {
      led.material.color.setHex(hex);
      led.material.emissive.setHex(hex);
      led.material.emissiveIntensity = intensity * blinkMul;
    }
    const cone = this.group.userData.visionCone;
    if (cone) {
      cone.material.color.setHex(hex);
      /* Pulse the cone opacity slightly with the same blink rhythm so
       * it visibly "flickers" when alarmed. */
      cone.material.opacity = coneOpacity * (0.7 + 0.3 * blinkMul);
    }
  }

  /* ── component-derived multipliers ─────────────────────────────────── */

  workingRotors() {
    let n = 0;
    for (const r of this.group.userData.rotors) if (!r.userData.broken) n++;
    return n;
  }
  liftFactor() {
    /* 4/4=1.0, 3/4=0.75, 2/4=0.45, 1/4=0.18, 0/4=0 (falls). */
    const w = this.workingRotors();
    return [0, 0.18, 0.45, 0.75, 1.0][w] || 0;
  }
  targetingFactor() {
    const cam = this.group.userData.findKind("targeting");
    return cam?.userData.broken ? 0.25 : 1.0;
  }
  powerFactor() {
    const core = this.group.userData.findKind("power");
    return core?.userData.broken ? 0 : 1.0;
  }

  /* ── perception ────────────────────────────────────────────────────── */

  perceives(playerHead, playerSpeed, dt) {
    /* Power dead → blind. */
    if (this.powerFactor() === 0) return false;

    const dronePos = this.group.position;
    const dist = dronePos.distanceTo(playerHead);

    /* Hearing — louder when player is sprinting / in air with momentum. */
    const hearingR = playerSpeed > PLAYER_RUN_SPEED ? HEARING_RUN_RADIUS : HEARING_RADIUS;
    let heard = dist < hearingR;
    /* But hearing through walls is weaker — halved range when occluded. */
    if (heard && !hasLineOfSight(dronePos, playerHead)) {
      heard = dist < hearingR * 0.5;
    }

    /* Sight range expands 2× while aggressive, so once a drone is alert
     * to you it can chase / re-acquire LOS from much further out — you
     * have to actually break line of sight (cover, corners) to lose
     * them, not just outrun perception. The visual cone also stretches
     * 2× in the same states (handled in update()) so the player sees
     * the longer reach. */
    const sightRange = this.isAggressive()
      ? DRONE_PERCEPTION_RANGE * DRONE_AGGRO_PERCEPTION_MULT
      : DRONE_PERCEPTION_RANGE;
    const seen = isInDroneFOV(this, playerHead)
      && hasLineOfSight(dronePos, playerHead, sightRange);

    if (seen || heard) {
      this.lkp.copy(playerHead);
      this.haveLkp = true;
      this.timeSinceLOS = seen ? 0 : this.timeSinceLOS + dt;
      return true;
    }
    this.timeSinceLOS += dt;
    return false;
  }

  /* ── waypoints ─────────────────────────────────────────────────────── */

  pickSurveyTarget() {
    const r = THREE.MathUtils.randFloat(SPAWN_RADIUS_RANGE[0], SPAWN_RADIUS_RANGE[1]);
    const a = Math.random() * Math.PI * 2;
    const y = THREE.MathUtils.randFloat(SPAWN_HEIGHT_RANGE[0], SPAWN_HEIGHT_RANGE[1]);
    this.targetPos.set(Math.cos(a) * r, y, Math.sin(a) * r);
    this.surveyChangeIn = THREE.MathUtils.randFloat(4, 8);
  }

  pickEvadeTarget(playerHead) {
    /* Strafe perpendicular + jump altitude. */
    this._tmp.subVectors(this.group.position, playerHead);
    this._tmp.y = 0;
    if (this._tmp.lengthSq() < 0.01) this._tmp.set(1, 0, 0);
    this._tmp.normalize();
    /* Rotate 90° around Y. */
    const px = this._tmp.x, pz = this._tmp.z;
    this._tmp.x = -pz * (Math.random() < 0.5 ? -1 : 1);
    this._tmp.z =  px * (Math.random() < 0.5 ? -1 : 1);
    this.targetPos.copy(this.group.position)
      .addScaledVector(this._tmp, 6 + Math.random() * 4);
    this.targetPos.y += THREE.MathUtils.randFloat(2, 5);
  }

  /* ── attack target: hover at standoff distance from player ─────────── */

  pickAttackTarget(playerBody) {
    /* Stay STANDOFF metres away from player on the line drone→player. */
    this._tmp.subVectors(this.group.position, playerBody);
    const d = this._tmp.length();
    if (d < 0.001) this._tmp.set(0, 0, 1);
    else this._tmp.divideScalar(d);
    /* Aim toward STANDOFF; if too close, push out further (FLEE). */
    const want = d < DRONE_FLEE_NEAR ? DRONE_STANDOFF * 1.3 : DRONE_STANDOFF;
    this.targetPos.copy(playerBody).addScaledVector(this._tmp, want);
    this.targetPos.y = playerBody.y + TRACK_HEIGHT_OFFSET;
  }

  /* ── steering ──────────────────────────────────────────────────────── */

  applySteering(dt, maxSpeed) {
    /* Seek target. */
    const desired = _d0.subVectors(this.targetPos, this.group.position);
    const dist = desired.length();
    if (dist > 0.01) desired.divideScalar(dist).multiplyScalar(maxSpeed);
    else desired.set(0, 0, 0);

    /* Separation from other drones. */
    const sep = _d1.set(0, 0, 0);
    let near = 0;
    for (const o of drones_) {
      if (o === this || o.dead) continue;
      _d2.subVectors(this.group.position, o.group.position);
      const d2 = _d2.lengthSq();
      if (d2 > 0.001 && d2 < SEPARATION_RADIUS * SEPARATION_RADIUS) {
        _d2.divideScalar(Math.sqrt(d2));
        sep.add(_d2);
        near++;
      }
    }
    if (near > 0) sep.multiplyScalar(maxSpeed * 0.6);

    /* Obstacle avoidance — short-range probe forward + 2 lateral. */
    this.computeAvoidance(maxSpeed, _d3);

    /* Combine + clamp acceleration. */
    const accel = _d4.set(0, 0, 0);
    accel.add(desired.sub(this.velocity));
    accel.add(sep);
    accel.add(_d3);
    if (accel.length() > STEERING_MAX_FORCE) {
      accel.setLength(STEERING_MAX_FORCE);
    }
    this.velocity.addScaledVector(accel, dt);

    /* Clamp velocity. */
    const speed = this.velocity.length();
    if (speed > maxSpeed) this.velocity.multiplyScalar(maxSpeed / speed);

    /* Apply velocity scaled by lift factor (broken rotors → less mobility). */
    const lift = this.liftFactor() * this.powerFactor();
    this._tmp.copy(this.velocity).multiplyScalar(lift);
    this.group.position.addScaledVector(this._tmp, dt);

    /* If lift < 1 the drone also gradually falls — but only when it's
     * actually airborne, otherwise it vibrates at the floor clamp. */
    if (lift < 0.95 && this.group.position.y > 0.42) {
      this.group.position.y -= (1 - lift) * 5 * dt;
    }
    /* Don't fall through the floor. */
    if (this.group.position.y < 0.4) {
      this.group.position.y = 0.4;
      this.velocity.y = Math.max(0, this.velocity.y);
    }

    /* Safety net: if avoidance failed and the drone ended up inside a
     * collision OBB (forced into a wall by a player-induced impulse, etc.),
     * push it out along the closest face. Rare but prevents drones from
     * becoming permanently stuck inside geometry. */
    pushDroneOutOfWalls(this);
  }

  /** Writes the obstacle-avoidance steering force into `out`. */
  computeAvoidance(maxSpeed, out) {
    out.set(0, 0, 0);
    /* Forward direction = current motion (or facing if stationary). */
    this._tmp2.copy(this.velocity);
    if (this._tmp2.lengthSq() < 0.01) this._tmp2.set(0, 0, -1);
    this._tmp2.normalize();
    const probe = AVOID_PROBE_DIST;
    const t = rayHitWorld(this.group.position, this._tmp2, probe);
    if (t < probe) {
      out.copy(this._tmp2).multiplyScalar(-1);
      out.y += 0.5;
      out.multiplyScalar(maxSpeed * (1 - t / probe) * 1.6);
    }
    return out;
  }

  /* ── facing: smoothly rotate the drone body so cam (and the vision
   *    cone) points at the target. Pitch follows the target's height
   *    relative to the drone, so a drone hovering above the player tilts
   *    its cam DOWN, and a drone below the cantilever looking up at the
   *    player on top tilts UP. Rotation order "YXZ" = yaw then pitch,
   *    standard FPS-style head/turret aim. */

  faceTarget(target, dt) {
    this._tmp.subVectors(target, this.group.position);
    const horizDist = Math.hypot(this._tmp.x, this._tmp.z);
    const yaw = Math.atan2(this._tmp.x, this._tmp.z);

    let diff = yaw - this.aimYaw;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    this.aimYaw += diff * Math.min(1, 6 * dt);

    /* Pitch toward target's height. Clamped to ±~57° so the drone
     * doesn't end up belly-up or belly-down even at steep angles. The
     * Math.max on horizDist prevents a divide-by-zero arctan blow-up
     * when the player is almost directly below.
     *
     * Sign note: with +Z as forward and Euler order "YXZ", a positive
     * X rotation tilts forward toward -Y (downward). To make the drone
     * tilt UP at a target above it (dy > 0) we negate atan2. Verified
     * by composing Ry(yaw) * Rx(pitch) and solving for the forward
     * vector matching the unit direction to the target. */
    const desiredPitch = THREE.MathUtils.clamp(
      -Math.atan2(this._tmp.y, Math.max(0.5, horizDist)),
      -1.0, 1.0,
    );
    this.aimPitch += (desiredPitch - this.aimPitch) * Math.min(1, 5 * dt);
    this.group.rotation.set(this.aimPitch, this.aimYaw, 0, "YXZ");
  }

  /* ── shooting ──────────────────────────────────────────────────────── */

  tryShoot(playerBody, dt) {
    const power = this.powerFactor();
    if (power === 0) return;
    const interval = DRONE_FIRE_INTERVAL_BASE / Math.max(0.5, power);
    this.fireCooldown -= dt;
    if (this.fireCooldown > 0) return;
    /* Aim gate: only fire when the cone has narrowed onto the player.
     * This is what makes the player fear them — they see the cone
     * tightening on them and can choose to break LOS or eat the shot. */
    if (this.aimFocus < DRONE_AIM_FIRE_THRESHOLD) return;
    /* Need targeting to be at least partially functional. */
    const aim = this.targetingFactor();
    /* Spread cone: full target → ~2°; broken → ~14°. */
    const spreadDeg = 2 + (1 - aim) * 12;

    /* Lead the player. */
    const lead = DRONE_FIRE_LEAD;
    const playerVel = getPlayerVelocity_?.();
    const aimAt = this._tmp.copy(playerBody);
    if (playerVel) aimAt.addScaledVector(playerVel, lead);

    /* Fire from the targeting camera, slightly forward of body. */
    const muzzle = this._tmp2.copy(this.group.position);
    muzzle.y -= 0.05;
    const dir = new THREE.Vector3().subVectors(aimAt, muzzle).normalize();

    /* Apply spread. */
    const spread = (spreadDeg * Math.PI) / 180;
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();

    spawnProjectile(muzzle, dir);
    playOneShotAt(audioBuffers_.botShot, muzzle, { volume: 0.7, refDistance: 6 });
    this.fireCooldown = interval * (0.85 + Math.random() * 0.3);
    /* Drop focus a bit so the next shot needs a brief re-aim — the cone
     * visibly widens then narrows again between shots. */
    this.aimFocus = DRONE_AIM_POST_FIRE;
  }

  /* ── damage ────────────────────────────────────────────────────────── */

  takeDamage(component, dmg, hitDir, attackerWorld) {
    if (this.dead) return;
    component.userData.hp -= dmg;
    flashComponentHit(component);
    playOneShotAt(audioBuffers_.hit, this.group.position, { volume: 0.85, refDistance: 4 });

    /* Knock-back impulse along incoming ray direction. */
    this.velocity.addScaledVector(hitDir, dmg * 0.06);

    /* Hit-direction awareness: even drones that were looking the wrong
     * way "feel" where the hit came from. We update LKP to the attacker's
     * position and snap (no smooth lerp) the drone's yaw + pitch to face
     * them, so the next frame's faceTarget continues from the correct
     * orientation. This matches Arc-Raiders-style "drone whirls around
     * to look at you when you snipe it from behind" feedback. */
    if (attackerWorld) {
      this.lkp.copy(attackerWorld);
      this.haveLkp = true;
      this._tmp.subVectors(attackerWorld, this.group.position);
      const horizDist = Math.hypot(this._tmp.x, this._tmp.z);
      if (horizDist > 0.001 || Math.abs(this._tmp.y) > 0.001) {
        this.aimYaw = Math.atan2(this._tmp.x, this._tmp.z);
        /* Negate atan2 — see faceTarget() for the sign convention. */
        this.aimPitch = THREE.MathUtils.clamp(
          -Math.atan2(this._tmp.y, Math.max(0.5, horizDist)),
          -1.0, 1.0,
        );
        this.group.rotation.set(this.aimPitch, this.aimYaw, 0, "YXZ");
      }
    }

    /* Hit cancels any aim-up: cone widens, drone has to re-acquire and
     * re-narrow before it can fire again. Even if the drone was already
     * in EVADE we restart `stateTime` and trigger a fresh wobble — so
     * sustained fire keeps interrupting the attack/aim cycle and the
     * player can pin a drone down by keeping pressure on it. */
    this.aimFocus = 0;
    this.wobbleTimer = DRONE_WOBBLE_DURATION;
    this.state = "EVADE";
    this.stateTime = 0;

    if (component.userData.hp <= 0 && !component.userData.broken) {
      this.breakComponent(component);
    }
  }

  breakComponent(c) {
    c.userData.broken = true;
    c.userData.hp = 0;
    /* Visual: kill emissive on broken accent / targeting; tilt rotor. */
    if (c.material && c.material.emissive) {
      c.material = c.material.clone();
      c.material.emissive.setHex(0x000000);
      c.material.color.multiplyScalar(0.5);
      c.material.needsUpdate = true;
    }
    if (c.userData.kind === "rotor") {
      c.userData.spinning = false;
      if (c.userData.blade) {
        c.userData.blade.rotation.y = THREE.MathUtils.randFloat(0, Math.PI * 2);
        c.userData.blade.scale.set(1, 1, 1);
      }
      /* Visual cant on broken rotor. */
      c.rotation.x = THREE.MathUtils.randFloat(-0.4, 0.4);
      c.rotation.z = THREE.MathUtils.randFloat(-0.4, 0.4);
    }
    if (c.userData.kind === "power" || c.userData.kind === "body") {
      this.die();
    }
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.removedAt = 0;
    /* Stop the looped hum + fire a positional explosion at last position. */
    if (this.audio) {
      try { this.audio.stop(); } catch (_) { /* ignore */ }
      this.group.remove(this.audio);
      this.audio = null;
    }
    playOneShotAt(audioBuffers_.explosion, this.group.position, { volume: 1.0, refDistance: 6 });
    /* Spawn debris from each component. */
    for (const c of this.group.userData.components) {
      const frag = new THREE.Mesh(
        c.geometry.clone(),
        new THREE.MeshStandardMaterial({
          color: 0x222226,
          emissive: 0x442211,
          emissiveIntensity: 0.5,
          roughness: 0.7,
          metalness: 0.3,
        }),
      );
      c.getWorldPosition(_v0);
      frag.position.copy(_v0);
      frag.rotation.copy(this.group.rotation);
      scene_.add(frag);
      debris_.push({
        mesh: frag,
        velocity: new THREE.Vector3(
          (Math.random() - 0.5) * 6,
          Math.random() * 4 + 1,
          (Math.random() - 0.5) * 6,
        ),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 8,
        ),
        ttl: 1.6,
      });
    }
    /* Remove drone group from scene. */
    scene_.remove(this.group);
    /* Schedule respawn. */
    respawnQueue_.push({ time: DRONE_RESPAWN_DELAY });
    kills_++;
  }

  /* ── per-frame update ──────────────────────────────────────────────── */

  update(dt, playerHead, playerBody, playerSpeed) {
    if (this.dead) return;

    this.stateTime += dt;
    /* Spin rotors. */
    this.rotorPhase += dt * 40;
    for (const r of this.group.userData.rotors) {
      if (r.userData.spinning && r.userData.blade) {
        r.userData.blade.rotation.y = this.rotorPhase + (r.userData.name === "FL" || r.userData.name === "BR" ? Math.PI / 2 : 0);
      }
    }

    /* Visual + audible alertness cue (LED + hum-buffer swap). */
    this.updateAlertnessAudio();

    const sees = this.perceives(playerHead, playerSpeed, dt);

    /* ── FSM ─────────────────────────────────────────────────────── */
    switch (this.state) {
      case "SURVEY": {
        if (sees) {
          this.state = "ALERT";
          this.stateTime = 0;
          break;
        }
        this.surveyChangeIn -= dt;
        if (this.surveyChangeIn <= 0 ||
            this.group.position.distanceTo(this.targetPos) < 2.0) {
          this.pickSurveyTarget();
        }
        this.applySteering(dt, STEERING_MAX_SPEED * 0.6);
        this.faceTarget(this.targetPos, dt);
        break;
      }

      case "ALERT": {
        /* Pause + face the player while the targeting camera "locks on". */
        this.applySteering(dt, STEERING_MAX_SPEED * 0.3);
        this.faceTarget(playerHead, dt);
        if (this.stateTime > DRONE_ALERT_DURATION) {
          this.state = sees ? "ATTACK" : "INVESTIGATE";
          this.stateTime = 0;
        }
        break;
      }

      case "ATTACK": {
        const dist = this.group.position.distanceTo(playerBody);
        this.pickAttackTarget(playerBody);
        const maxS = STEERING_MAX_ATTACK_SPEED * this.powerFactor();
        this.applySteering(dt, maxS);
        this.faceTarget(playerHead, dt);
        /* Engage out to DRONE_FIRE_RANGE (≈ 52 m) — twice the previous
         * range. The aim-gate inside tryShoot enforces the focus-narrow
         * procedure so we still don't insta-snap-fire the moment we
         * acquire LOS. */
        if (sees && dist < DRONE_FIRE_RANGE) {
          this.tryShoot(playerHead, dt);
        }
        if (!sees && this.timeSinceLOS > DRONE_LOSE_INTEREST) {
          this.state = "INVESTIGATE";
          this.stateTime = 0;
        }
        break;
      }

      case "INVESTIGATE": {
        if (sees) {
          this.state = "ATTACK";
          this.stateTime = 0;
          break;
        }
        if (this.haveLkp) {
          this.targetPos.copy(this.lkp);
          this.targetPos.y = Math.max(this.lkp.y + 4, 6);
        }
        this.applySteering(dt, STEERING_MAX_SPEED * 0.7);
        this.faceTarget(this.haveLkp ? this.lkp : this.targetPos, dt);
        if (this.stateTime > DRONE_INVESTIGATE_DURATION) {
          this.state = "SURVEY";
          this.stateTime = 0;
          this.haveLkp = false;
          this.pickSurveyTarget();
        }
        break;
      }

      case "EVADE": {
        if (this.stateTime < 0.05) this.pickEvadeTarget(playerHead);
        this.applySteering(dt, STEERING_MAX_ATTACK_SPEED * 1.1);
        this.faceTarget(playerHead, dt);
        if (this.stateTime > DRONE_EVADE_DURATION) {
          this.state = sees ? "ATTACK" : "INVESTIGATE";
          this.stateTime = 0;
        }
        break;
      }
    }

    /* ── Aim focus + visible cone scaling ─────────────────────────────
     * Focus only grows in steady ATTACK with LOS and no active wobble.
     * Wobble (post-hit recoil) holds focus at 0 — so the player can
     * keep a drone "stunned" by landing repeated hits, exactly the
     * Arc-Raiders feel where harassing fire stops them firing back. */
    const focusing =
      this.state === "ATTACK" && sees && this.wobbleTimer <= 0 && !this.dead;
    if (focusing) {
      this.aimFocus = Math.min(
        1,
        this.aimFocus + (dt / DRONE_AIM_TIME) * this.targetingFactor(),
      );
    } else {
      this.aimFocus = Math.max(0, this.aimFocus - dt / DRONE_AIM_DECAY_TIME);
    }

    /* Cone visual: length doubles in aggressive states (matching the 2×
     * perception range), width narrows as aim focus grows. The shared
     * ConeGeometry was built apex-at-origin with base extending +Z, so
     * scale.z stretches the length and scale.x/.y narrow the cross
     * section. Result: a wide blue scanning beam in SURVEY → a long
     * amber search beam in INVESTIGATE → a long red beam that visibly
     * tightens onto you in ATTACK → a long wide red lash in EVADE. */
    const cone = this.group.userData.visionCone;
    if (cone) {
      const aggressive = this.isAggressive();
      const lengthMul = aggressive ? VISION_AGGRO_LENGTH_MULT : 1;
      const widthMul = THREE.MathUtils.lerp(1, VISION_NARROW_RATIO, this.aimFocus);
      cone.scale.set(widthMul, widthMul, lengthMul);
    }

    /* Wobble: a quick roll-oscillation overlaid on top of the YXZ
     * yaw+pitch set by faceTarget. Pure visual — no position offset, so
     * collision and steering are unaffected. The "knocked off balance"
     * read sells the impulse without making the drone leave its
     * collision/steering frame. */
    if (this.wobbleTimer > 0) {
      this.wobbleTimer -= dt;
      const env = Math.max(0, this.wobbleTimer / DRONE_WOBBLE_DURATION);
      const phase = (DRONE_WOBBLE_DURATION - this.wobbleTimer) * 22;
      this.group.rotation.z = Math.sin(phase) * 0.45 * env;
    } else if (this.group.rotation.z !== 0) {
      this.group.rotation.z = 0;
    }
  }
}

/* ── Player projectiles (drone-fired) ─────────────────────────────────── */

let projectileGeo_ = null;
let projectileMat_ = null;

function getProjectileGeo() {
  if (!projectileGeo_) projectileGeo_ = new THREE.SphereGeometry(DRONE_PROJECTILE_RADIUS, 10, 8);
  return projectileGeo_;
}
function getProjectileMat() {
  /* Bot projectiles: clearly red, hot emissive so they're unambiguous
   * against the brutalist concrete + the player's blue tracers. */
  if (!projectileMat_) projectileMat_ = new THREE.MeshStandardMaterial({
    color: 0xff2222,
    emissive: 0xff1010,
    emissiveIntensity: 3.4,
    roughness: 0.4,
    metalness: 0.0,
    toneMapped: true,
  });
  return projectileMat_;
}

function spawnProjectile(origin, dir) {
  const m = new THREE.Mesh(getProjectileGeo(), getProjectileMat());
  m.position.copy(origin);
  scene_.add(m);
  projectiles_.push({
    mesh: m,
    velocity: dir.clone().multiplyScalar(DRONE_PROJECTILE_SPEED),
    ttl: DRONE_PROJECTILE_TTL,
  });
}

function updateProjectiles(dt, playerHead) {
  for (let i = projectiles_.length - 1; i >= 0; i--) {
    const p = projectiles_[i];
    p.ttl -= dt;
    /* Step using small substeps to avoid tunnelling fast projectiles. */
    const stepCount = 2;
    let hit = false;
    for (let s = 0; s < stepCount && !hit; s++) {
      p.mesh.position.addScaledVector(p.velocity, dt / stepCount);
      /* Wall hit. */
      if (pointInsideAnyOBB(p.mesh.position, 0.05)) hit = true;
      /* Player hit. */
      if (!hit) {
        const d2 = p.mesh.position.distanceToSquared(playerHead);
        if (d2 < (PLAYER_HIT_RADIUS + DRONE_PROJECTILE_RADIUS) ** 2) {
          damagePlayer(DRONE_PROJECTILE_DAMAGE);
          hit = true;
        }
      }
    }
    if (hit || p.ttl <= 0) {
      scene_.remove(p.mesh);
      projectiles_.splice(i, 1);
    }
  }
}

/* ── Player weapon (hitscan) ──────────────────────────────────────────── */

const _muzzle = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _fwdLocal = new THREE.Vector3();

function getRightControllerAim(out, outOrigin) {
  if (renderer_.xr.isPresenting) {
    const session = renderer_.xr.getSession();
    if (!session) return false;
    /* Primary path: a controller already tagged with handedness="right" by
     * our connected-event hook. */
    for (let i = 0; i < 4; i++) {
      const ctrl = renderer_.xr.getController(i);
      if (ctrl?.userData?.handedness !== "right") continue;
      ctrl.updateMatrixWorld(true);
      ctrl.getWorldPosition(outOrigin);
      _fwdLocal.set(0, 0, -1);
      out.copy(_fwdLocal).applyQuaternion(ctrl.getWorldQuaternion(_q0)).normalize();
      return true;
    }
    /* Fallback (event hasn't fired yet): find the input source whose
     * handedness === "right" and pair it positionally with a controller
     * index. WebXRManager assigns inputs to controller slots in inputs-
     * change order, which on Meta browsers ≈ inputSources iteration order. */
    let idx = 0;
    for (const src of session.inputSources) {
      if (src?.handedness === "right") {
        const ctrl = renderer_.xr.getController(idx);
        if (ctrl) {
          ctrl.updateMatrixWorld(true);
          ctrl.getWorldPosition(outOrigin);
          _fwdLocal.set(0, 0, -1);
          out.copy(_fwdLocal).applyQuaternion(ctrl.getWorldQuaternion(_q0)).normalize();
          return true;
        }
      }
      idx++;
    }
    return false;
  }
  /* Desktop fallback: from camera centre. */
  camera_.getWorldPosition(outOrigin);
  camera_.getWorldDirection(out);
  return true;
}

/* Walk drones, find earliest raycast hit on any of their components. */
const _droneRaycaster = new THREE.Raycaster();
function fireHitscan() {
  if (playerFireCooldown_ > 0 || playerDead()) return;
  if (!getRightControllerAim(_aimDir, _muzzle)) return;
  playerFireCooldown_ = PLAYER_FIRE_INTERVAL;

  /* World-OBB earliest hit (we never want to shoot through walls). */
  const wallT = rayHitWorld(_muzzle, _aimDir, TRACER_LENGTH);

  /* Drone hit: standard three raycaster against drone groups. */
  _droneRaycaster.set(_muzzle, _aimDir);
  _droneRaycaster.far = Math.min(TRACER_LENGTH, wallT);
  let bestDist = Infinity;
  let bestHit = null;
  for (const d of drones_) {
    if (d.dead) continue;
    const hits = _droneRaycaster.intersectObject(d.group, true);
    if (hits.length > 0 && hits[0].distance < bestDist) {
      bestDist = hits[0].distance;
      bestHit = hits[0];
    }
  }

  let endT = Math.min(wallT, bestDist);
  if (!Number.isFinite(endT)) endT = TRACER_LENGTH;

  if (bestHit && bestDist <= wallT) {
    const comp = findComponent(bestHit.object);
    const drone = findDroneFromHit(bestHit.object);
    if (comp && drone && !comp.userData.broken) {
      /* Pass the muzzle (== player hand / camera) world position as the
       * attacker location so the drone can snap-rotate to face the
       * shooter. _muzzle is read-only in takeDamage so no aliasing. */
      drone.takeDamage(comp, PLAYER_DAMAGE, _aimDir, _muzzle);
    }
  }
  spawnTracer(_muzzle, _aimDir, endT);
  /* Player shot SFX — head-locked (loud and sharp, no spatial cue needed
   * since you fired it). Spatialised hit/explosion from the drone itself. */
  playHeadOneShot(audioBuffers_.playerShot, 0.6);
}

/* ── Tracer (player shot) ─────────────────────────────────────────────── */

/* `THREE.Line` with `LineBasicMaterial` always renders at 1 device pixel
 * regardless of `linewidth` (WebGL spec, no workaround on Quest). For a
 * tracer that's actually visible at distance we use a thin cylinder mesh
 * instead, with a per-tracer opacity so we can fade it out without the
 * material being shared. */
const TRACER_RADIUS = 0.025;
function makeTracerMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0x66ccff,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}
const _tracerUp = new THREE.Vector3(0, 1, 0);
const _tracerQuat = new THREE.Quaternion();
function spawnTracer(origin, dir, length) {
  if (length <= 0.05) return;
  const geom = new THREE.CylinderGeometry(TRACER_RADIUS, TRACER_RADIUS, length, 8, 1);
  const mesh = new THREE.Mesh(geom, makeTracerMaterial());
  /* Position at midpoint, oriented along `dir` (CylinderGeometry's axis
   * is +Y, so rotate (+Y) → dir). */
  mesh.position.copy(origin).addScaledVector(dir, length / 2);
  _tracerQuat.setFromUnitVectors(_tracerUp, dir);
  mesh.quaternion.copy(_tracerQuat);
  mesh.renderOrder = 9000;
  mesh.frustumCulled = false;
  scene_.add(mesh);
  tracers_.push({ mesh, ttl: TRACER_TTL });
}
function updateTracers(dt) {
  for (let i = tracers_.length - 1; i >= 0; i--) {
    const t = tracers_[i];
    t.ttl -= dt;
    if (t.mesh.material) {
      t.mesh.material.opacity = Math.max(0, t.ttl / TRACER_TTL) * 0.95;
    }
    if (t.ttl <= 0) {
      scene_.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
      tracers_.splice(i, 1);
    }
  }
}

/* ── Hit flashes (component) ──────────────────────────────────────────── */

const componentFlashes_ = [];
function flashComponentHit(component) {
  const mat = component.material;
  if (!mat || !mat.emissive) return;
  /* Clone material so multiple drones don't share a flashing material. */
  if (!component.userData.uniqueMat) {
    component.material = mat.clone();
    component.userData.uniqueMat = true;
  }
  const m = component.material;
  /* If a flash is already in progress for this material, just refresh its
   * timer — keep the original "restore" snapshot so we don't latch the
   * white-flash colour as the new baseline. */
  const existing = componentFlashes_.find((f) => f.mat === m);
  if (existing) {
    existing.time = 0.18;
  } else {
    componentFlashes_.push({
      mat: m,
      restoreEmissive: m.emissive.getHex(),
      restoreIntensity: m.emissiveIntensity,
      time: 0.18,
    });
  }
  m.emissive.setHex(0xffffff);
  m.emissiveIntensity = 3.0;
}
function updateComponentFlashes(dt) {
  for (let i = componentFlashes_.length - 1; i >= 0; i--) {
    const f = componentFlashes_[i];
    f.time -= dt;
    if (f.time <= 0) {
      /* Restore the pre-flash glow (so accents/cores keep their emissive). */
      f.mat.emissive.setHex(f.restoreEmissive);
      f.mat.emissiveIntensity = f.restoreIntensity;
      componentFlashes_.splice(i, 1);
    }
  }
}

/* ── Debris ──────────────────────────────────────────────────────────── */

function updateDebris(dt) {
  for (let i = debris_.length - 1; i >= 0; i--) {
    const d = debris_[i];
    d.ttl -= dt;
    d.velocity.y -= 9.8 * dt;
    d.mesh.position.addScaledVector(d.velocity, dt);
    d.mesh.rotation.x += d.spin.x * dt;
    d.mesh.rotation.y += d.spin.y * dt;
    d.mesh.rotation.z += d.spin.z * dt;
    if (d.mesh.position.y < 0.05) d.ttl = Math.min(d.ttl, 0);
    if (d.ttl <= 0) {
      scene_.remove(d.mesh);
      d.mesh.geometry.dispose();
      d.mesh.material.dispose();
      debris_.splice(i, 1);
    }
  }
}

/* ── Player damage / respawn ──────────────────────────────────────────── */

function playerDead() {
  return playerHp_ <= 0;
}

function damagePlayer(dmg) {
  if (playerInvuln_ > 0 || playerDead()) return;
  playerHp_ = Math.max(0, playerHp_ - dmg);
  flashDamageOverlay(0.55);
  playHeadOneShot(audioBuffers_.damage, 0.85);
  if (playerHp_ <= 0) onPlayerDeath();
}

function onPlayerDeath() {
  deaths_++;
  if (respawnOverlay_) {
    respawnOverlay_.style.opacity = "1";
    respawnOverlay_.textContent = "Knocked down — respawning…";
  }
  /* Brief delay then respawn. */
  setTimeout(() => {
    if (respawnPlayer_) respawnPlayer_();
    else {
      const sp = getPlayerSpawn_?.() || _v0.set(0, 0, 0);
      cameraRig_.position.copy(sp);
    }
    playerHp_ = PLAYER_MAX_HP;
    playerInvuln_ = PLAYER_INVULN_AFTER_RESPAWN;
    if (respawnOverlay_) respawnOverlay_.style.opacity = "0";
    /* Clear any in-flight projectiles so the player isn't immediately shot again. */
    for (const p of projectiles_) scene_.remove(p.mesh);
    projectiles_.length = 0;
  }, 1200);
}

function flashDamageOverlay(strength) {
  if (damageOverlay_) damageOverlay_.style.opacity = String(strength);
  if (vrDamageMat_) vrDamageMat_.opacity = strength;
  damageOverlayTimer_ = 0.4;
}

function updateOverlay(dt) {
  if (damageOverlayTimer_ > 0) {
    damageOverlayTimer_ -= dt;
    const k = Math.max(0, damageOverlayTimer_ / 0.4);
    const o = k * 0.55;
    if (damageOverlay_) damageOverlay_.style.opacity = String(o);
    if (vrDamageMat_) vrDamageMat_.opacity = o;
  } else if (damageOverlayTimer_ < 0) {
    damageOverlayTimer_ = 0;
    if (vrDamageMat_) vrDamageMat_.opacity = 0;
  }
}

function ensureVrDamageMesh() {
  if (vrDamageMesh_) return;
  /* A camera-attached double-sided plane just inside the near clip plane,
   * sized to comfortably cover both eyes' viewports. The radial-gradient
   * canvas mimics the DOM vignette so VR + desktop look the same. */
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  const grd = ctx.createRadialGradient(128, 128, 30, 128, 128, 140);
  grd.addColorStop(0, "rgba(255,0,0,0)");
  grd.addColorStop(1, "rgba(255,0,0,1)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  vrDamageMat_ = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  /* Plane covers a generous FOV at z = -0.3 m. */
  const planeSize = 0.7;
  vrDamageMesh_ = new THREE.Mesh(new THREE.PlaneGeometry(planeSize, planeSize), vrDamageMat_);
  vrDamageMesh_.position.set(0, 0, -0.3);
  vrDamageMesh_.renderOrder = 9998;
  vrDamageMesh_.frustumCulled = false;
  camera_.add(vrDamageMesh_);
}

/* ── Combat HUD ───────────────────────────────────────────────────────── */

function ensureCombatHud() {
  if (combatHudMesh_) return;
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 96;
  const ctx = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const aspect = c.width / c.height;
  const planeH = 0.06;
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
  /* Lower-left of FOV (mirrors the FPS panel on the right). */
  mesh.position.set(-0.18, -0.13, -0.6);
  mesh.renderOrder = 9999;
  mesh.frustumCulled = false;
  mesh.visible = false;
  camera_.add(mesh);
  combatHudCanvas_ = c;
  combatHudCtx_ = ctx;
  combatHudTexture_ = tex;
  combatHudMesh_ = mesh;
}

function drawCombatHud() {
  if (!combatHudCtx_) return;
  const livingDrones = drones_.filter((d) => !d.dead).length;
  const hp = Math.max(0, Math.round(playerHp_));
  if (combatHudLastDrawnHp_ === hp && combatHudLastDrawnDrones_ === livingDrones) return;
  const ctx = combatHudCtx_;
  const w = combatHudCanvas_.width;
  const h = combatHudCanvas_.height;
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

  /* HP label */
  ctx.fillStyle = "#9fd6ff";
  ctx.font = "500 22px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("HP", 16, 30);
  /* HP bar */
  const barX = 50;
  const barY = 14;
  const barW = w - barX - 18;
  const barH = 22;
  ctx.fillStyle = "#222";
  ctx.fillRect(barX, barY, barW, barH);
  const k = hp / PLAYER_MAX_HP;
  const col = hp > 60 ? "#5fff7a" : hp > 30 ? "#ffd24a" : "#ff4422";
  ctx.fillStyle = col;
  ctx.fillRect(barX, barY, barW * k, barH);
  ctx.fillStyle = "#fff";
  ctx.font = "600 18px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(String(hp), barX + barW - 6, barY + 17);

  /* Drones */
  ctx.fillStyle = "#ffaa66";
  ctx.font = "600 22px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("DRONES", 16, 78);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "right";
  ctx.fillText(`${livingDrones}`, w - 16, 78);

  combatHudTexture_.needsUpdate = true;
  combatHudLastDrawnHp_ = hp;
  combatHudLastDrawnDrones_ = livingDrones;
}

/* ── Crosshair (right controller) ─────────────────────────────────────── */

function ensureCrosshair() {
  if (crosshairMesh_) return;

  /* VR crosshair: a Group projected to the aim point. Composed of an
   * outer ring + center dot for clearer reading at distance. We scale
   * the whole group by distance so the apparent size on the headset
   * stays roughly constant regardless of how far the aim point is. */
  const grp = new THREE.Group();
  grp.frustumCulled = false;
  grp.renderOrder = 9999;
  grp.visible = false;

  const mat = new THREE.MeshBasicMaterial({
    color: 0x66ccff,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.024, 24), mat);
  ring.renderOrder = 9999;
  grp.add(ring);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.005, 12), mat);
  dot.renderOrder = 9999;
  grp.add(dot);

  scene_.add(grp);
  crosshairMesh_ = grp;

  /* Desktop crosshair: simple 4-tick + center-dot DOM reticle, fixed
   * to screen centre. Visible whenever combat is on AND we're not in
   * an active XR session (DOM elements don't render inside WebXR). */
  if (typeof document !== "undefined" && !desktopCrosshair_) {
    const c = document.createElement("div");
    Object.assign(c.style, {
      position: "fixed",
      top: "50%",
      left: "50%",
      width: "26px",
      height: "26px",
      transform: "translate(-50%, -50%)",
      pointerEvents: "none",
      zIndex: "120",
      display: "none",
    });
    /* Inline SVG: cleanest cross-browser way to render a sharp reticle
     * that scales independently of font / DPR settings. */
    c.innerHTML = `
      <svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">
        <g stroke="#66ccff" stroke-width="1.6" fill="none" opacity="0.95">
          <line x1="13" y1="2"  x2="13" y2="8" />
          <line x1="13" y1="18" x2="13" y2="24"/>
          <line x1="2"  y1="13" x2="8"  y2="13"/>
          <line x1="18" y1="13" x2="24" y2="13"/>
        </g>
        <circle cx="13" cy="13" r="1.6" fill="#66ccff" opacity="0.95"/>
      </svg>`;
    document.body.appendChild(c);
    desktopCrosshair_ = c;
  }
}

function updateCrosshair() {
  if (!crosshairMesh_) return;

  /* Toggle desktop reticle. */
  if (desktopCrosshair_) {
    const showDesktop = enabled_ && !renderer_.xr.isPresenting;
    desktopCrosshair_.style.display = showDesktop ? "block" : "none";
  }

  const visible = enabled_ && renderer_.xr.isPresenting;
  crosshairMesh_.visible = visible;
  if (!visible) return;
  if (!getRightControllerAim(_aimDir, _muzzle)) {
    crosshairMesh_.visible = false;
    return;
  }
  /* Project to the first surface (wall OR drone) the aim ray hits. */
  const wallT = rayHitWorld(_muzzle, _aimDir, 30);
  let bestDist = Math.min(wallT, 30);
  for (const d of drones_) {
    if (d.dead) continue;
    _droneRaycaster.set(_muzzle, _aimDir);
    _droneRaycaster.far = bestDist;
    const hits = _droneRaycaster.intersectObject(d.group, true);
    if (hits.length > 0 && hits[0].distance < bestDist) bestDist = hits[0].distance;
  }
  if (!Number.isFinite(bestDist)) bestDist = 4;
  crosshairMesh_.position.copy(_muzzle).addScaledVector(_aimDir, bestDist);
  crosshairMesh_.lookAt(camera_.getWorldPosition(_v0));
  /* Scale with distance so the crosshair stays at a constant ~5°
   * apparent size regardless of how far away the projected surface
   * is. Geometry is sized for ~1m projection, so scale = bestDist. */
  const s = Math.max(0.6, Math.min(8, bestDist));
  crosshairMesh_.scale.setScalar(s);
}

/* ── Spawn / respawn ──────────────────────────────────────────────────── */

function pickSpawnPoint(out) {
  /* Pick a spot far from the player and clear of geometry. */
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = THREE.MathUtils.randFloat(SPAWN_RADIUS_RANGE[0], SPAWN_RADIUS_RANGE[1]);
    const a = Math.random() * Math.PI * 2;
    const y = THREE.MathUtils.randFloat(SPAWN_HEIGHT_RANGE[0], SPAWN_HEIGHT_RANGE[1]);
    out.set(Math.cos(a) * r, y, Math.sin(a) * r);
    if (!pointInsideAnyOBB(out, 0.5)) return out;
  }
  /* Fallback: high above origin. */
  out.set(0, SPAWN_HEIGHT_RANGE[1], 0);
  return out;
}

function spawnDrone() {
  if (drones_.filter((d) => !d.dead).length >= MAX_DRONES) return;
  pickSpawnPoint(_v0);
  drones_.push(new Drone(_v0));
}

function tickRespawnQueue(dt) {
  /* Maintain SPAWN_TARGET living drones. */
  const living = drones_.filter((d) => !d.dead).length;
  for (let i = respawnQueue_.length - 1; i >= 0; i--) {
    respawnQueue_[i].time -= dt;
    if (respawnQueue_[i].time <= 0) {
      respawnQueue_.splice(i, 1);
      if (drones_.filter((d) => !d.dead).length < SPAWN_TARGET) spawnDrone();
    }
  }
  /* Auto-top-up if queue is empty and we're under target. */
  if (respawnQueue_.length === 0 && living < SPAWN_TARGET) {
    respawnQueue_.push({ time: DRONE_RESPAWN_DELAY * 0.5 });
  }
  /* Garbage-collect dead drones from the array (debris keeps own list). */
  for (let i = drones_.length - 1; i >= 0; i--) {
    if (drones_[i].dead) drones_.splice(i, 1);
  }
}

/* ── Public toggle ────────────────────────────────────────────────────── */

function setBotsEnabled(on) {
  if (on === enabled_) return;
  enabled_ = on;
  if (combatBtn_) {
    combatBtn_.textContent = `Combat: ${on ? "ON" : "OFF"}`;
    combatBtn_.style.background = on ? "#c44a2a" : "#333";
  }
  if (combatStatusEl_) combatStatusEl_.style.display = on ? "block" : "none";
  if (combatHudMesh_) combatHudMesh_.visible = on;
  if (on) {
    /* AudioContext starts suspended in modern browsers — only a user
     * gesture can resume it. Both the HUD-button click and the WebXR
     * "X" button press qualify as gestures, so this resume() succeeds
     * in either entry point. */
    if (audioListener_?.context?.state === "suspended") {
      audioListener_.context.resume().catch(() => {});
    }
    /* Reset world state. */
    playerHp_ = PLAYER_MAX_HP;
    playerInvuln_ = 1.5;
    kills_ = 0;
    deaths_ = 0;
    respawnQueue_.length = 0;
    /* Pre-fill with target drones. */
    while (drones_.filter((d) => !d.dead).length < SPAWN_TARGET) spawnDrone();
  } else {
    /* Tear down living drones, projectiles, tracers, debris. */
    for (const d of drones_) {
      if (d.audio) {
        try { d.audio.stop(); } catch (_) { /* ignore */ }
      }
      if (!d.dead) scene_.remove(d.group);
    }
    drones_.length = 0;
    for (const p of projectiles_) scene_.remove(p.mesh);
    projectiles_.length = 0;
    for (const t of tracers_) {
      scene_.remove(t.mesh);
      t.mesh.geometry.dispose();
    }
    tracers_.length = 0;
    for (const f of debris_) {
      scene_.remove(f.mesh);
      f.mesh.geometry.dispose();
      f.mesh.material.dispose();
    }
    debris_.length = 0;
    respawnQueue_.length = 0;
    componentFlashes_.length = 0;
  }
}

function getBotsEnabled() {
  return enabled_;
}

/* ── XR controller polling for trigger + button ───────────────────────── */

function pollVRInputs() {
  if (!renderer_.xr.isPresenting) return;
  const session = renderer_.xr.getSession();
  if (!session?.inputSources) return;

  let triggerR = false;
  let buttonX = false;
  for (const src of session.inputSources) {
    if (!src?.gamepad) continue;
    if (src.handedness === "right") {
      if (src.gamepad.buttons?.[0]?.pressed) triggerR = true;
    }
    if (src.handedness === "left") {
      /* Touch controllers: button[4] = X. */
      if (src.gamepad.buttons?.[4]?.pressed) buttonX = true;
    }
  }

  /* X (left) toggles combat mode on rising edge. */
  if (buttonX && !prevButtonX_) setBotsEnabled(!enabled_);
  prevButtonX_ = buttonX;

  /* Right trigger: fire ONE shot per press (rising-edge gated). Holding
   * the trigger no longer auto-fires — this matches single-action shooter
   * behaviour and prevents trigger-spam exploits. PLAYER_FIRE_INTERVAL is
   * still enforced inside fireHitscan as a per-shot cooldown floor. */
  if (enabled_ && triggerR && !prevTriggerR_) fireHitscan();
  prevTriggerR_ = triggerR;
}

/* Stash handedness on controllers as soon as XR connects them, so
 * `getRightControllerAim` can find the right hand. */
function attachHandednessTagging() {
  for (let i = 0; i < 4; i++) {
    const ctrl = renderer_.xr.getController(i);
    if (!ctrl || ctrl.userData.handednessHooked) continue;
    ctrl.userData.handednessHooked = true;
    ctrl.addEventListener("connected", (e) => {
      ctrl.userData.handedness = e?.data?.handedness || null;
    });
    ctrl.addEventListener("disconnected", () => {
      ctrl.userData.handedness = null;
    });
  }
}

/* Desktop fire (left mouse button) when combat is enabled. */
function attachDesktopFire() {
  renderer_.domElement.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (!enabled_) return;
    if (renderer_.xr.isPresenting) return;
    fireHitscan();
  });
  /* Also support 'F' key from desktop without fighting orbit-controls drag.
   * `e.repeat` is true for OS key-repeat (auto-fire while held) — we
   * reject those so each F press shoots exactly one bullet, matching
   * the single-action trigger behaviour. */
  window.addEventListener("keydown", (e) => {
    if (e.key !== "f" && e.key !== "F") return;
    if (e.repeat) return;
    if (!enabled_) return;
    if (renderer_.xr.isPresenting) return;
    fireHitscan();
  });
}

/* ── Procedural audio ─────────────────────────────────────────────────── */

/**
 * Generates a mono AudioBuffer of `durationSec` by calling
 * `genFn(t, sampleIdx, totalSamples)` for each sample. `genFn` returns a
 * float in [-1, 1]; values outside are clipped by the WebAudio renderer.
 *
 * For looped buffers, choose a duration that's an integer multiple of all
 * the sine periods used inside `genFn`, otherwise the loop joint will
 * produce a click. Example: at 0.5s, 80/110/4/8 Hz all complete whole
 * cycles (40, 55, 2, 4 — all integers).
 */
function makeProceduralBuffer(ctx, durationSec, genFn) {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(durationSec * sr));
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    let v = genFn(i / sr, i, len);
    if (v > 1) v = 1; else if (v < -1) v = -1;
    data[i] = v;
  }
  return buf;
}

function buildAudioBuffers() {
  if (audioReady_ || !audioListener_) return;
  const ctx = audioListener_.context;
  if (!ctx) return;

  /* Idle drone hum — low, calm, slow tremolo. Loop-clean at 0.5s. */
  audioBuffers_.droneHumIdle = makeProceduralBuffer(ctx, 0.5, (t) => {
    const a = Math.sin(2 * Math.PI * 80  * t);
    const b = Math.sin(2 * Math.PI * 110 * t) * 0.55;
    const trem = 0.7 + 0.3 * Math.sin(2 * Math.PI * 4 * t);
    return (a + b) * trem * 0.085;
  });

  /* Aggressive drone hum — higher, faster tremolo, ~25% louder. */
  audioBuffers_.droneHumAlert = makeProceduralBuffer(ctx, 0.5, (t) => {
    const a = Math.sin(2 * Math.PI * 140 * t);
    const b = Math.sin(2 * Math.PI * 200 * t) * 0.6;
    const c = Math.sin(2 * Math.PI * 280 * t) * 0.25;
    const trem = 0.6 + 0.4 * Math.sin(2 * Math.PI * 8 * t);
    return (a + b + c) * trem * 0.115;
  });

  /* Player shot — descending zap, sharp envelope. */
  audioBuffers_.playerShot = makeProceduralBuffer(ctx, 0.18, (t) => {
    const f = 1500 - 800 * (t / 0.18);
    const env = Math.exp(-t * 18);
    return Math.sin(2 * Math.PI * f * t) * env * 0.55;
  });

  /* Bot shot — heavy descending thump. */
  audioBuffers_.botShot = makeProceduralBuffer(ctx, 0.25, (t) => {
    const f = 220 - 100 * (t / 0.25);
    const env = Math.exp(-t * 10);
    const noise = (Math.random() - 0.5) * 0.35;
    return (Math.sin(2 * Math.PI * f * t) + noise) * env * 0.6;
  });

  /* Component hit — short metallic thunk. */
  audioBuffers_.hit = makeProceduralBuffer(ctx, 0.13, (t) => {
    const env = Math.exp(-t * 30);
    const a = Math.sin(2 * Math.PI * 1200 * t);
    const b = Math.sin(2 * Math.PI * 1800 * t) * 0.6;
    const noise = (Math.random() - 0.5) * 0.3;
    return (a + b + noise) * env * 0.55;
  });

  /* Drone explosion — boom + broadband noise burst. */
  audioBuffers_.explosion = makeProceduralBuffer(ctx, 0.65, (t) => {
    const f = 80 - 30 * Math.min(1, t / 0.3);
    const env = Math.exp(-t * 5);
    const noise = (Math.random() - 0.5);
    return (Math.sin(2 * Math.PI * f * t) * 0.7 + noise * 0.55) * env * 0.85;
  });

  /* Player damage — low thump + brief ring. */
  audioBuffers_.damage = makeProceduralBuffer(ctx, 0.4, (t) => {
    const env = Math.exp(-t * 6);
    const a = Math.sin(2 * Math.PI * 60 * t) * 0.85;
    const ring = Math.sin(2 * Math.PI * 320 * t) * Math.exp(-t * 12) * 0.4;
    return (a + ring) * env * 0.8;
  });

  audioReady_ = true;
}

/**
 * Spawn a one-shot positional audio at `worldPos`. Uses a temporary
 * Object3D holder so the sound finishes even if its triggering object
 * (a dying drone, a destroyed projectile) is removed from the scene.
 */
function playOneShotAt(buffer, worldPos, opts = {}) {
  if (!audioReady_ || !buffer || !audioListener_) return;
  const holder = new THREE.Object3D();
  holder.position.copy(worldPos);
  scene_.add(holder);
  const a = new THREE.PositionalAudio(audioListener_);
  a.setBuffer(buffer);
  a.setRefDistance(opts.refDistance ?? 5);
  a.setMaxDistance(opts.maxDistance ?? 80);
  a.setRolloffFactor(opts.rolloff ?? 1.4);
  a.setVolume(opts.volume ?? 1);
  holder.add(a);
  try { a.play(); } catch (_) { /* play() can throw if context still suspended */ }
  /* Auto-cleanup after the buffer plays out. +120 ms grace for the
   * panner tail. */
  setTimeout(() => {
    try { a.stop(); } catch (_) { /* ignore */ }
    holder.remove(a);
    scene_.remove(holder);
  }, buffer.duration * 1000 + 120);
}

/** Head-locked one-shot (no spatialization). */
function playHeadOneShot(buffer, volume = 1) {
  if (!audioReady_ || !buffer || !audioListener_) return;
  const a = new THREE.Audio(audioListener_);
  a.setBuffer(buffer);
  a.setVolume(volume);
  try { a.play(); } catch (_) { /* ignore */ }
  setTimeout(() => {
    try { a.stop(); } catch (_) { /* ignore */ }
  }, buffer.duration * 1000 + 120);
}

/* ── Public API ───────────────────────────────────────────────────────── */

/**
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {THREE.Object3D} opts.cameraRig
 * @param {THREE.WebGLRenderer} opts.renderer
 * @param {() => Array<{cx:number,cy:number,cz:number,hx:number,hy:number,hz:number,m:THREE.Matrix3,mInv:THREE.Matrix3}>} opts.getCollisionBoxes
 * @param {() => THREE.Vector3 | null} [opts.getPlayerVelocity]
 * @param {() => THREE.Vector3} [opts.getPlayerSpawn]
 * @param {() => void} [opts.respawnPlayer]
 */
export function initBots(opts) {
  if (initDone_) return;
  initDone_ = true;
  scene_ = opts.scene;
  camera_ = opts.camera;
  cameraRig_ = opts.cameraRig;
  renderer_ = opts.renderer;
  getCollisionBoxes_ = opts.getCollisionBoxes;
  getPlayerVelocity_ = opts.getPlayerVelocity || (() => null);
  getPlayerSpawn_ = opts.getPlayerSpawn || (() => new THREE.Vector3(0, 0, 0));
  respawnPlayer_ = opts.respawnPlayer || null;

  /* Build HUD elements: button + damage overlay + respawn message. */
  const hud = document.getElementById("hud");
  if (hud) {
    combatBtn_ = document.createElement("button");
    combatBtn_.type = "button";
    combatBtn_.id = "combatBtn";
    combatBtn_.textContent = "Combat: OFF";
    combatBtn_.style.background = "#333";
    combatBtn_.style.color = "#fff";
    combatBtn_.style.display = "block";
    combatBtn_.style.width = "100%";
    combatBtn_.style.marginTop = "8px";
    combatBtn_.style.padding = "10px 12px";
    combatBtn_.style.cursor = "pointer";
    combatBtn_.style.border = "none";
    combatBtn_.style.borderRadius = "4px";
    combatBtn_.style.fontSize = "13px";
    combatBtn_.addEventListener("click", () => setBotsEnabled(!enabled_));
    hud.appendChild(combatBtn_);

    combatStatusEl_ = document.createElement("div");
    combatStatusEl_.id = "combatStatus";
    combatStatusEl_.style.marginTop = "6px";
    combatStatusEl_.style.fontSize = "11px";
    combatStatusEl_.style.color = "#9fd6ff";
    combatStatusEl_.style.display = "none";
    combatStatusEl_.textContent =
      "VR: right trigger fires, left X toggles combat. Desktop: left-click or F to fire.";
    hud.appendChild(combatStatusEl_);
  }

  /* Damage overlay (red flash). No CSS transition — we drive the fade
   * from JS each frame; a CSS transition would lag the JS values and look
   * mushy on impact. */
  damageOverlay_ = document.createElement("div");
  damageOverlay_.id = "damageOverlay";
  Object.assign(damageOverlay_.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    background: "radial-gradient(ellipse at center, rgba(255,0,0,0) 30%, rgba(255,0,0,0.85) 100%)",
    opacity: "0",
    zIndex: "150",
  });
  document.body.appendChild(damageOverlay_);

  respawnOverlay_ = document.createElement("div");
  respawnOverlay_.id = "respawnOverlay";
  Object.assign(respawnOverlay_.style, {
    position: "fixed",
    top: "40%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    pointerEvents: "none",
    color: "#ff8866",
    font: "600 22px system-ui, sans-serif",
    background: "rgba(0,0,0,0.7)",
    padding: "16px 24px",
    borderRadius: "8px",
    opacity: "0",
    transition: "opacity 0.3s ease-out",
    zIndex: "151",
  });
  document.body.appendChild(respawnOverlay_);

  ensureCombatHud();
  ensureCrosshair();
  ensureVrDamageMesh();
  attachHandednessTagging();
  attachDesktopFire();

  /* Audio listener parented to the perspective camera. In WebXR the
   * camera's world matrix is updated to head pose every frame, so the
   * listener tracks head movement → spatial audio just works. Buffers
   * are generated once now (cheap: ~100 KB total). */
  audioListener_ = new THREE.AudioListener();
  camera_.add(audioListener_);
  buildAudioBuffers();

  /* Re-attempt handedness hook on session start in case controllers connect later. */
  renderer_.xr.addEventListener("sessionstart", attachHandednessTagging);
}

export function updateBots(dt) {
  if (!initDone_) return;
  if (playerInvuln_ > 0) playerInvuln_ -= dt;
  playerFireCooldown_ -= dt;

  pollVRInputs();
  updateCrosshair();
  updateOverlay(dt);
  updateTracers(dt);
  updateComponentFlashes(dt);
  updateDebris(dt);

  if (!enabled_) return;

  /* Player position for AI. */
  getPlayerHeadWorld(_v0);
  getPlayerBodyWorld(_v1);
  const playerSpeed = getPlayerSpeed();

  for (const d of drones_) d.update(dt, _v0, _v1, playerSpeed);
  updateProjectiles(dt, _v0);
  tickRespawnQueue(dt);
  drawCombatHud();
}

export { setBotsEnabled, getBotsEnabled };

/* Diagnostics for the console API. */
export function getBotsDebug() {
  return {
    enabled: enabled_,
    living: drones_.filter((d) => !d.dead).length,
    states: drones_.map((d) => d.state),
    projectilesInFlight: projectiles_.length,
    playerHp: playerHp_,
    kills: kills_,
    deaths: deaths_,
  };
}

/** Force-clear all combatants (handy for testing). */
export function killAllDrones() {
  for (const d of drones_) if (!d.dead) d.die();
}
