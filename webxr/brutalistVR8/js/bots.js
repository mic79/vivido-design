/**
 * brutalistVR8 — Arc-Raiders-style flying drones with FSM AI, perception
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

/* Default living-drones target. In wave mode we override this from the
 * wave comp count; in endless we apply the difficulty add. Made `let`
 * so the wave manager / difficulty can mutate it at init time. */
let SPAWN_TARGET = 3;                    // drones alive simultaneously
let MAX_DRONES = 8;                      // safety cap
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
/* Kamikaze recharge cycle: when a kamikaze loses its warhead (so it
 * can no longer detonate), it doesn't just become a harmless taxi —
 * it retreats, "rebuilds" the warhead over `KAMIKAZE_RECHARGE_S`
 * seconds, then chases the player again from the last known position.
 * This makes shooting off the warhead a temporary tactical win, not a
 * permanent kill. */
const KAMIKAZE_RECHARGE_S = 7.0;
const KAMIKAZE_RECHARGE_FLEE_DIST = 16;  // metres to flee back during recharge

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

/* ── Drone variants ────────────────────────────────────────────────────
 * Seven type kinds spawn from a weighted random pool. Each has a unique
 * silhouette so the player can identify the threat at a glance, plus
 * 1-2 specialisation components that are individually destructible:
 *
 *   STANDARD — generic skirmisher, fires fast hitscan-ish red ball.
 *   SNIPER   — long body + telescopic barrel + scope. Slow heavy-damage
 *              hitscan. Breaking the BARREL stops it firing entirely;
 *              breaking the SCOPE wrecks its accuracy.
 *   MISSILE  — wide chassis with two side missile pods. Fires a slow
 *              homing missile that turns toward the player. Breaking a
 *              POD disables that side; breaking both grounds its weapon.
 *   KAMIKAZE — small fast body crowned with a glowing red warhead.
 *              No primary weapon — rushes to detonate within 2.5 m
 *              dealing burst damage. Breaking the WARHEAD makes it
 *              completely harmless (still flies, can't blow up).
 *   SHIELD   — slow tank-walker that emits a translucent dome around
 *              itself + nearby allies. While the dome is up, allied
 *              drones inside take no damage — the player has to focus
 *              the shielder first. Breaking the EMITTER drops the dome
 *              instantly. Doesn't fire, just hovers as a buff source.
 *   TANK     — heavy bruiser with a turret-mounted spinning gatling
 *              barrel. Fires fast bursts of low-damage rounds. Tougher
 *              chassis; slower; punishes you if you stand still in its
 *              fire arc. Breaking the BARREL stops it firing.
 *   ENGINEER — non-combatant. Locks onto the most damaged ally and
 *              fires a continuous repair BEAM that restores broken
 *              chips/rotors over time. Avoids combat — flees if no
 *              friend nearby. Kill it before its targets recover.
 *
 * All variants share: 4 shielded rotors, body armour chips, power core,
 * status LED, vision cone. */
const DRONE_TYPE_STANDARD = "standard";
const DRONE_TYPE_SNIPER = "sniper";
const DRONE_TYPE_MISSILE = "missile";
const DRONE_TYPE_KAMIKAZE = "kamikaze";
const DRONE_TYPE_SHIELD = "shield";
const DRONE_TYPE_TANK = "tank";
const DRONE_TYPE_ENGINEER = "engineer";
/* Thruster-based variants — same FSM/AI as the rotor drones, but
 * propelled by ducted nozzles instead of spinning blades. The
 * "rotor" component kind is reused so liftFactor / breakage logic
 * still applies; only the visual + count differ. */
const DRONE_TYPE_JET = "jet";       // sleek, single rear nozzle, fast flanker
const DRONE_TYPE_HOVER = "hover";   // squat, twin side ducts, slow tank-let

/* Default spawn weights for endless / sandbox — used only when no wave
 * comp overrides them. Wave comps take precedence in wave mode.
 * Numbers are relative; not normalised. */
const DRONE_TYPE_WEIGHTS = {
  [DRONE_TYPE_STANDARD]: 3,
  [DRONE_TYPE_SNIPER]:   1,
  [DRONE_TYPE_MISSILE]:  1,
  [DRONE_TYPE_KAMIKAZE]: 1.2,
  [DRONE_TYPE_SHIELD]:   0.5,
  [DRONE_TYPE_TANK]:     0.7,
  [DRONE_TYPE_ENGINEER]: 0.4,
  [DRONE_TYPE_JET]:      0.9,    // mid-frequency flanker
  [DRONE_TYPE_HOVER]:    0.8,    // mid-frequency mid-range threat
};

/* Per-type tuning. `bodyHp` is what's left after the chips are stripped
 * (chips absorb 14 HP each, so total drone-body HP ≈ chips×14 + bodyHp).
 * `tintHex` is mixed into the chassis so the variant reads at a glance
 * even before it does anything. */
const DRONE_TYPE_STATS = {
  [DRONE_TYPE_STANDARD]: {
    bodyHp: 28,
    tintHex: 0x2a2a32,         // neutral gunmetal
    fireInterval: 1.6,
    fireRangeMul: 1.0,
    aimTimeMul: 1.0,
    speedMul: 1.0,
    turretSlewRate: 7,         // rad-per-second-ish slerp constant
  },
  [DRONE_TYPE_SNIPER]: {
    bodyHp: 36,
    tintHex: 0x1d2a44,         // deep navy
    fireInterval: 3.4,         // slow charge-up
    fireRangeMul: 1.6,         // engage at very long range
    aimTimeMul: 1.7,           // deliberate aim — visible long focus ramp
    speedMul: 0.8,             // slower platform — punishing if you let it set up
    sniperDamage: 38,          // big single-shot hit
    sniperProjectileSpeed: 70, // ~near-hitscan
    turretSlewRate: 2.5,       // SLOW — long barrel visibly tracks you
  },
  [DRONE_TYPE_MISSILE]: {
    bodyHp: 42,
    tintHex: 0x3d3210,         // amber/yellow
    fireInterval: 3.0,         // slow but per-pod alternates
    fireRangeMul: 1.2,
    aimTimeMul: 0.9,           // less precise — missile homes anyway
    speedMul: 0.85,            // bulky
    missileDamage: 18,
    missileSpeed: 9,
    missileTurnRate: 1.6,      // rad/s — how aggressively it tracks
    missileTtl: 6.0,
    turretSlewRate: 5,
  },
  [DRONE_TYPE_KAMIKAZE]: {
    bodyHp: 18,                // frail — a few shots and it pops
    tintHex: 0x4a1818,         // angry red
    fireInterval: 0,           // does not fire
    fireRangeMul: 0,
    aimTimeMul: 0.5,           // doesn't really aim, just lunges
    speedMul: 1.6,             // FAST
    detonateRange: 2.5,        // metres from player to boom
    detonateDamage: 55,
    /* No turret — body still uses faceTarget. */
  },
  [DRONE_TYPE_SHIELD]: {
    bodyHp: 50,                // burlier — meant to soak focused fire
    tintHex: 0x182438,         // deep cobalt
    fireInterval: 0,           // doesn't fire
    fireRangeMul: 0,
    aimTimeMul: 1.0,
    speedMul: 0.7,             // slow, deliberate
    turretSlewRate: 4,
    /* Dome radius (m): protected zone around the shielder. Anything
     * inside takes no damage while the EMITTER is intact. */
    domeRadius: 6.5,
    /* Buff target: how many simultaneous allies the dome protects (the
     * dome is a sphere; this just informs the colour-pulse intensity). */
    domeMaxAllies: 4,
  },
  [DRONE_TYPE_TANK]: {
    bodyHp: 60,                // very tanky chassis
    tintHex: 0x3a2814,         // rusty bronze
    fireInterval: 0.95,        // ≈ 1 burst/s — gatling RoF
    fireRangeMul: 0.9,         // shorter than standard — needs to close
    aimTimeMul: 0.7,           // quicker to lock — bullets aren't precise anyway
    speedMul: 0.65,            // SLOW — a lumbering threat
    turretSlewRate: 5,
    /* Burst-fire pattern. After aim-focus locks, fire `burstShots`
     * rounds at `burstRate` interval, then cool down for fireInterval. */
    burstShots: 5,
    burstRate: 0.10,           // 100 ms between rounds in a burst → 10 rps
    burstDamage: 7,            // per round (low — hose, not snipe)
    burstSpread: 4.0,          // degrees — wide cone
  },
  [DRONE_TYPE_ENGINEER]: {
    bodyHp: 28,                // squishy
    tintHex: 0x2a3a18,         // medic green
    fireInterval: 0,           // doesn't fight
    fireRangeMul: 0,
    aimTimeMul: 1.0,
    speedMul: 0.95,            // mobile but evasive
    turretSlewRate: 8,
    /* Repair beam — turret-mounted. */
    repairRange: 14,           // beam reach (m)
    repairRate: 9,             // hp/sec restored to chips/rotors/shields
    repairChipRevive: true,    // can re-attach a broken chip after 100% repair
  },
  [DRONE_TYPE_JET]: {
    /* Single thruster — one point of failure, but FAST. Lighter
     * chassis (less HP than standard) so it doesn't tank fire while
     * dodging in long arcs. */
    bodyHp: 24,
    tintHex: 0x2c1d3a,         // deep purple
    fireInterval: 1.4,
    fireRangeMul: 1.2,
    aimTimeMul: 0.9,
    speedMul: 1.5,             // FAST flanker
    turretSlewRate: 7,
  },
  [DRONE_TYPE_HOVER]: {
    /* Twin ducts → 2 rotor components (lose 1 = wobble at 50% lift,
     * lose 2 = falls). Slow but tougher than standard. */
    bodyHp: 38,
    tintHex: 0x103338,         // teal-cyan
    fireInterval: 1.4,
    fireRangeMul: 1.0,
    aimTimeMul: 1.0,
    speedMul: 0.75,
    turretSlewRate: 6,
  },
};

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

/* ── Difficulty profiles ────────────────────────────────────────────────
 * URL: ?diff=easy|normal|hard|insane (default normal).
 *
 * Each profile rescales a small set of multipliers that the rest of the
 * code reads (NOT mutating the constants — those stay as base values).
 * `applyDifficulty()` is called once during init from the URL param.
 *
 * Multipliers
 *   bodyHpMul     — drone body / chip / shield / component HP.
 *   fireRateMul   — multiplies fire interval (smaller = faster).
 *   damageMul     — damage dealt to the player.
 *   perceptionMul — sight + hearing range.
 *   spawnTargetAdd — extra simultaneous drones.
 *   typeWeightOverrides — replaces specific weights (insane → more snipers/kamikazes). */
const DIFFICULTY_PRESETS = {
  easy:    { bodyHpMul: 0.7, fireRateMul: 1.4,  damageMul: 0.7, perceptionMul: 0.85, spawnTargetAdd: -1, typeWeightOverrides: { [DRONE_TYPE_KAMIKAZE]: 0.5 } },
  normal:  { bodyHpMul: 1.0, fireRateMul: 1.0,  damageMul: 1.0, perceptionMul: 1.0,  spawnTargetAdd:  0, typeWeightOverrides: null },
  hard:    { bodyHpMul: 1.25, fireRateMul: 0.85, damageMul: 1.2, perceptionMul: 1.1,  spawnTargetAdd:  1, typeWeightOverrides: { [DRONE_TYPE_SNIPER]: 1.5, [DRONE_TYPE_TANK]: 1.0 } },
  insane:  { bodyHpMul: 1.5, fireRateMul: 0.7,  damageMul: 1.5, perceptionMul: 1.25, spawnTargetAdd:  2, typeWeightOverrides: { [DRONE_TYPE_SNIPER]: 2.0, [DRONE_TYPE_KAMIKAZE]: 2.5, [DRONE_TYPE_TANK]: 1.5 } },
};
let difficulty_ = "normal";
let diffProfile_ = DIFFICULTY_PRESETS.normal;

/* ── Run mode / seeded RNG ──────────────────────────────────────────────
 * URL:
 *   ?mode=wave (default) | endless
 *   ?seed=<int> | daily   (optional — daily uses YYYYMMDD)
 *
 * `rand()` is the single source of randomness for spawn picks, wave
 * comps, and weighted drone selection. When seeded, runs are reproducible
 * (great for daily-challenge / leaderboards). When unseeded, falls back
 * to Math.random().
 *
 * The seed implementation is mulberry32 — fast, decent distribution,
 * no library dependency. Spawning still pulls from rand() everywhere so
 * the same seed produces an identical drone parade. */
let runMode_ = "wave";        // "wave" | "endless"
let seedValue_ = null;        // number or null (= unseeded)
let _rngState = 0;
function _mulberry32() {
  let t = (_rngState += 0x6D2B79F5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function rand() {
  return seedValue_ === null ? Math.random() : _mulberry32();
}
function randRange(a, b) {
  return a + (b - a) * rand();
}
function randInt(a, b) {
  return Math.floor(a + (b - a + 1) * rand());
}

function _readQueryConfig() {
  if (typeof window === "undefined") return;
  const q = new URLSearchParams(window.location.search);
  const d = (q.get("diff") || "").toLowerCase();
  if (DIFFICULTY_PRESETS[d]) {
    difficulty_ = d;
    diffProfile_ = DIFFICULTY_PRESETS[d];
  }
  const m = (q.get("mode") || "").toLowerCase();
  if (m === "endless") runMode_ = "endless";
  else if (m === "wave") runMode_ = "wave";
  const s = q.get("seed");
  if (s) {
    if (s === "daily") {
      const dt = new Date();
      seedValue_ = dt.getUTCFullYear() * 10000
                 + (dt.getUTCMonth() + 1) * 100
                 + dt.getUTCDate();
    } else {
      const n = parseInt(s, 10);
      if (Number.isFinite(n)) seedValue_ = n >>> 0;
    }
    if (seedValue_ !== null) _rngState = seedValue_ || 1;
  }
}

/* ── Wave manager ───────────────────────────────────────────────────────
 * Wave mode (default):
 *   - Wave N has a hand-tuned composition until N=10, then procedural.
 *   - `INTERMISSION_S` between waves: drones tear down, music fades to
 *     calm, HUD shows "WAVE N — get ready".
 *   - Wave finishes when all spawned drones are dead AND no more pending
 *     spawns are queued for that wave.
 *   - Wave 5 / 10 / 15 → mini-boss: doubled bodyHp on a single TANK,
 *     plus its retinue.
 *
 * Endless mode:
 *   - Continuous waves with mild scaling per wave (HP +6 % / count +1
 *     every 3 waves, capped at 8 simultaneous drones).
 *
 * Each wave's "comp" is an array of either type strings or
 *   { type, hpMul, count } objects.
 */
const INTERMISSION_S = 8.0;

/* Hand-tuned compositions for the first 10 waves of WAVE mode. Beyond
 * wave 10 we generate procedurally (`_proceduralWaveComp`). The names
 * exactly match DRONE_TYPE_* constants. */
const WAVE_COMPS = [
  /* wave 1 */ [DRONE_TYPE_STANDARD, DRONE_TYPE_STANDARD, DRONE_TYPE_STANDARD],
  /* wave 2 */ [DRONE_TYPE_STANDARD, DRONE_TYPE_STANDARD, DRONE_TYPE_STANDARD, DRONE_TYPE_STANDARD],
  /* wave 3 */ [DRONE_TYPE_STANDARD, DRONE_TYPE_SNIPER, DRONE_TYPE_KAMIKAZE, DRONE_TYPE_STANDARD],
  /* wave 4 */ [DRONE_TYPE_STANDARD, DRONE_TYPE_TANK, DRONE_TYPE_STANDARD, DRONE_TYPE_KAMIKAZE],
  /* wave 5 — boss */ [{ type: DRONE_TYPE_TANK, hpMul: 2.2 }, DRONE_TYPE_STANDARD, DRONE_TYPE_STANDARD, DRONE_TYPE_KAMIKAZE],
  /* wave 6 */ [DRONE_TYPE_STANDARD, DRONE_TYPE_SHIELD, DRONE_TYPE_HOVER, DRONE_TYPE_SNIPER, DRONE_TYPE_STANDARD],
  /* wave 7 */ [DRONE_TYPE_MISSILE, DRONE_TYPE_TANK, DRONE_TYPE_JET, DRONE_TYPE_KAMIKAZE, DRONE_TYPE_KAMIKAZE],
  /* wave 8 */ [DRONE_TYPE_SHIELD, DRONE_TYPE_ENGINEER, DRONE_TYPE_HOVER, DRONE_TYPE_STANDARD, DRONE_TYPE_SNIPER],
  /* wave 9 */ [DRONE_TYPE_TANK, DRONE_TYPE_JET, DRONE_TYPE_MISSILE, DRONE_TYPE_KAMIKAZE, DRONE_TYPE_HOVER],
  /* wave 10 — boss */ [{ type: DRONE_TYPE_TANK, hpMul: 3.0 }, DRONE_TYPE_SHIELD, DRONE_TYPE_ENGINEER, DRONE_TYPE_SNIPER, DRONE_TYPE_KAMIKAZE, DRONE_TYPE_KAMIKAZE],
];

/* Procedural comp for waves > 10. Slowly raises HP scaling and total
 * count, mixes in more elite types as the wave number climbs. */
function _proceduralWaveComp(wave) {
  const total = Math.min(8, 4 + Math.floor((wave - 10) / 2));
  const out = [];
  /* Always one shielder to make armour-priority decisions matter. */
  out.push(DRONE_TYPE_SHIELD);
  /* One engineer every 3 waves so kills don't permanently stick. */
  if (wave % 3 === 0) out.push(DRONE_TYPE_ENGINEER);
  /* Boss every 5 waves (15, 20, 25, …). */
  if (wave % 5 === 0) {
    const hpMul = 2.5 + (wave - 10) * 0.15;
    out.push({ type: DRONE_TYPE_TANK, hpMul });
  }
  /* Fill the rest from a pool weighted by wave number. */
  const pool = [
    [DRONE_TYPE_STANDARD, 4],
    [DRONE_TYPE_SNIPER, 1.5 + wave * 0.08],
    [DRONE_TYPE_MISSILE, 1.0 + wave * 0.05],
    [DRONE_TYPE_KAMIKAZE, 1.2 + wave * 0.10],
    [DRONE_TYPE_TANK, 0.8 + wave * 0.05],
    [DRONE_TYPE_JET, 1.0 + wave * 0.07],
    [DRONE_TYPE_HOVER, 1.0 + wave * 0.05],
  ];
  while (out.length < total) {
    let totalW = 0;
    for (const [, w] of pool) totalW += w;
    let r = rand() * totalW;
    for (const [t, w] of pool) {
      r -= w;
      if (r <= 0) { out.push(t); break; }
    }
  }
  return out;
}

/* Wave-runtime state. `pendingSpawns` is the queue of drone-type entries
 * left to spawn this wave (drip-fed so the player isn't dumped on with
 * 8 enemies at once). `aliveSpawned` counts drones spawned-and-dead so
 * we know when the wave is "done" (== composition.length). */
let waveNumber_ = 1;
let waveActive_ = false;       // true while drones from current wave are spawning/alive
let waveIntermission_ = 0;     // seconds left in the breather (0 → start next wave)
let pendingSpawns_ = [];       // remaining spawn entries this wave
let nextSpawnTimer_ = 0;       // drip-feed delay between successive spawns
let waveSpawnedTotal_ = 0;     // how many we've spawned this wave
let waveExpectedKills_ = 0;    // == comp.length (when reached, wave is over)
let waveStartedAt_ = 0;        // performance.now() of wave start

/* ── Persistent records (best wave / kills) ─────────────────────────────
 * Stored in IndexedDB keyed by the difficulty + mode combo so a hard-
 * mode best doesn't compete with an easy-mode best. */
const RECORDS_DB = "brutalistVR8_records";
const RECORDS_STORE = "records";
let bestWave_ = 0;
let bestKills_ = 0;

/* ── Grenade tunables ──────────────────────────────────────────────────
 * Player carries up to MAX_GRENADES per life. Throwing uses the hand's
 * recent velocity (or, on desktop, a fixed forward toss). Grenades arc
 * under gravity, detonate on contact or after FUSE_S, and apply AOE
 * damage to drones within BLAST_RADIUS — falloff to 0 at the edge. */
const MAX_GRENADES = 3;
const GRENADE_FUSE_S = 2.4;
const GRENADE_BLAST_RADIUS = 4.5;
const GRENADE_BLAST_DAMAGE = 80;       // direct-impact peak damage
const GRENADE_THROW_SPEED_DEFAULT = 8; // legacy/no-aim fallback (unused by aim system)
const GRENADE_GRAVITY = 9.8;
const GRENADE_BOUNCE_DAMP = 0.35;
/* Hold-to-aim throw mechanic. Press left trigger → enter aim mode and
 * see a trajectory arc; hold → charge ramps from MIN→MAX speed; release
 * → grenade is thrown along the previewed path. */
const GRENADE_CHARGE_TIME = 1.2;       // seconds to fully charge
const GRENADE_MIN_SPEED = 6.0;         // tap-and-release throw speed
const GRENADE_MAX_SPEED = 16.0;        // fully charged throw speed
const GRENADE_TRAJ_SAMPLES = 28;       // arc preview dot count
const GRENADE_TRAJ_DT = 0.06;          // simulation step per dot (s)
let grenadeStock_ = MAX_GRENADES;
/* Aim-mode state. */
let grenadeAiming_ = false;
let grenadeChargeT_ = 0;
let grenadeAimDots_ = null;            // InstancedMesh of arc dots
let grenadeAimImpact_ = null;          // ring/torus at predicted detonation
const _grenadeAimPos = new THREE.Vector3();
const _grenadeAimDir = new THREE.Vector3();
const _grenadeAimQuat = new THREE.Quaternion();
const _grenadeAimVel = new THREE.Vector3();
const _grenadeAimSimPos = new THREE.Vector3();
const _grenadeAimSimVel = new THREE.Vector3();
const _grenadeAimDotMat = new THREE.Matrix4();
const grenades_ = [];   // active grenade objects
let prevTriggerL_ = false;

/* ── Module state ─────────────────────────────────────────────────────── */

let scene_;
let camera_;          // perspective camera (head pose target in WebXR)
let cameraRig_;       // cameraRig parent in main.js
let renderer_;
let getCollisionBoxes_;  // () => OBB[]
let getPlayerVelocity_;  // () => THREE.Vector3 | null  (rigVelocity, for hearing)
let getPlayerSpawn_;     // () => THREE.Vector3        (where to put the rig on respawn)
let getPlayerPosition_;  // () => THREE.Vector3        (cameraRig.position — drone spawns anchor here)
let getSectorInfo_;      // () => {current:string, active:string[], all:[{key,sx,sz,archetype}], sectorSize, gridHalf}
let respawnPlayer_;      // () => void                 (main.js's preferred respawn impl)

let enabled_ = false;
let initDone_ = false;

const drones_ = [];       // active Drone instances
const projectiles_ = [];  // drone-fired projectiles in flight
const tracers_ = [];      // player tracer line segments
const debris_ = [];       // post-death tumbling fragments
/* `respawnQueue_` was used by the old continuous-spawn model. The wave
 * manager replaces it (drones now spawn from `pendingSpawns_` and the
 * old `tickRespawnQueue` no longer runs). Kept declared so clearing it
 * in setBotsEnabled OFF stays a no-op safe place to reset legacy state. */
const respawnQueue_ = [];

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

/* Music — DodgeVR-style calm-vs-battle crossfading background tracks.
 * Uses HTML5 <audio> elements piped through Web Audio for streaming
 * playback (MP3s are ~11 MB calm + ~3-4 MB battle, so we don't want to
 * fully decode/keep them in RAM the way THREE.AudioLoader would). The
 * element is set as the MediaElementSource on a THREE.Audio so volume
 * runs through the same listener gain graph as the rest of the SFX. */
const MUSIC_FILES = {
  calm: "audio/alexgrohl-the-futuristic-ambience-everything-is-one-179395.mp3",
  /* Two battle tracks — pick one randomly per session for variety. */
  battle: [
    "audio/amaksi-clanabogan-beast-phonk-148615.mp3",
    "audio/amaksi-unleashed-fury-173854.mp3",
  ],
};
const MUSIC_CALM_VOLUME = 0.22;
const MUSIC_BATTLE_VOLUME = 0.38;
const MUSIC_CROSSFADE_S = 2.0;        // calm ↔ battle
const MUSIC_DUCK_S = 0.6;             // music toggle off / on
let musicEnabled_ = true;             // user toggle
let musicInited_ = false;             // set once after first user gesture
let musicBtn_ = null;
let musicCalmEl_ = null;              // HTMLAudioElement
let musicBattleEl_ = null;
let musicCalmAudio_ = null;           // THREE.Audio wrapping the element
let musicBattleAudio_ = null;
let musicTarget_ = "calm";            // "calm" | "battle"

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
/* Sector minimap — small head-locked plane in the upper-left of FOV
 * showing the 9×9 world grid, with the current sector highlighted, the
 * 8 loaded neighbours tinted, and live drone dots in red. */
let sectorMinimapMesh_ = null;
let sectorMinimapCanvas_ = null;
let sectorMinimapCtx_ = null;
let sectorMinimapTexture_ = null;
let sectorMinimapLastKey_ = "";
let sectorMinimapLastDroneCount_ = -1;
let sectorMinimapLastDirtyMs_ = 0;
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
  /* The "perception forward" is whichever feature is *looking* at the
   * world: turret if the drone has one (everyone except kamikaze),
   * else the body. Without this, body banking along velocity would
   * point the FOV cone away from the player and the drone would lose
   * detection mid-flight even with the turret cam still on you. */
  const turret = drone.group.userData.turret;
  if (turret) {
    turret.updateMatrixWorld(true);
    _fovFwd.set(0, 0, 1).applyQuaternion(turret.getWorldQuaternion(_q0));
  } else {
    _fovFwd.set(0, 0, 1).applyQuaternion(drone.group.quaternion);
  }
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

/* ── Shared materials per type ─────────────────────────────────────────
 * Each drone instance still gets its own material clones (so the hit-
 * flash logic doesn't bleed across instances), but the *base* tint is
 * derived from the type stats so all variants of a given kind read as
 * "the same enemy class" at a glance. */
function makeBodyMat(tintHex) {
  return new THREE.MeshStandardMaterial({
    color: tintHex, roughness: 0.55, metalness: 0.45,
  });
}
function makeRotorMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x111114, roughness: 0.75, metalness: 0.18,
  });
}
function makeAccentMat(hex = 0xff4422, emiHex = 0xff2a14, intensity = 1.4) {
  return new THREE.MeshStandardMaterial({
    color: hex, emissive: emiHex, emissiveIntensity: intensity,
    roughness: 0.4, metalness: 0.4,
  });
}
function makeTargetingMat() {
  return new THREE.MeshStandardMaterial({
    color: 0xffd24a, emissive: 0xffaa11, emissiveIntensity: 1.0,
    roughness: 0.4, metalness: 0.5,
  });
}
/* Shield material: dark armor plate, slightly metallic. Per-rotor clone
 * so each shield can flash / break independently. */
function makeShieldMat() {
  return new THREE.MeshStandardMaterial({
    color: 0x55585f, roughness: 0.4, metalness: 0.7,
  });
}

/* ── Building helpers (shared across variants) ─────────────────────────
 * Each helper appends its components to `drone.userData.components` so
 * the death/raycast logic finds them, AND to `drone.userData.rotors`
 * for the rotor-specific bookkeeping (lift factor, spin animation).
 *
 * Coordinate convention: drone's local +Z is FORWARD (matches the
 * vision cone direction and faceTarget yaw math). Y is up. */

/* Place a single shielded rotor at `offset`. Shield is a parented child
 * of the arm so it inherits any tilt / falling-off animation; raycasts
 * recurse and naturally hit the shield first since it's geometrically
 * above/around the arm. */
function buildShieldedRotor(drone, offset, name, matBody, matRotor) {
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 8), matBody);
  arm.position.fromArray(offset);
  arm.userData = { kind: "rotor", name, hp: 14, maxHp: 14, broken: false, spinning: true };
  drone.add(arm);

  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.022, 0.07), matRotor);
  blade.position.set(0, 0.045, 0);
  arm.add(blade);
  arm.userData.blade = blade;

  /* Shield: a wide armoured "housing" co-centred with the rotor mast
   * (radius 0.30 vs arm radius 0.05). Geometrically it's the first
   * thing a player shot intersects from almost any angle (above,
   * below, or sideways) — only the blade tips at radius 0.42 stick
   * out beyond the shield. Once the shield breaks, we hide it and the
   * next shot to the same rotor reaches the bare arm underneath. */
  const shieldMat = makeShieldMat();
  const shieldGeo = new THREE.CylinderGeometry(0.28, 0.30, 0.08, 16);
  const shield = new THREE.Mesh(shieldGeo, shieldMat);
  shield.position.set(0, 0, 0);
  shield.userData = {
    kind: "shield",
    rotorName: name,
    hp: 14,
    maxHp: 14,
    broken: false,
  };
  arm.add(shield);
  arm.userData.shield = shield;

  drone.userData.rotors.push(arm);
  drone.userData.components.push(shield, arm);
  return arm;
}

/* Place a thruster nozzle (no spinning blades) at `offset` with the
 * given local rotation. The thruster acts as a "rotor" for damage and
 * lift accounting — broken thrusters reduce liftFactor exactly like
 * broken rotors. The exhaust glow pulses each frame in update().
 *
 * `axisLocal` is the local-space direction the exhaust fires (e.g.
 * (0,0,-1) = exhaust points backward, drone is propelled forward).
 *
 *   - nozzle  : matte cylinder, the visible "engine" mesh
 *   - exhaust : emissive cone hanging off the nozzle's exit, pulses
 *               between dim and bright while the thruster is alive
 *               and hard-cut to 0 emissive when it breaks. */
function buildThrusterRotor(drone, offset, axisLocal, name, matBody, opts = {}) {
  const radius = opts.radius ?? 0.10;
  const length = opts.length ?? 0.18;
  const exhaustLen = opts.exhaustLen ?? 0.22;
  const tint = opts.exhaustHex ?? 0x66ccff;
  const tintEmi = opts.exhaustEmiHex ?? 0x33aaff;

  /* Nozzle: a stubby cylinder, oriented so its axis matches `axisLocal`. */
  const nozzleGeo = new THREE.CylinderGeometry(radius * 0.9, radius, length, 14);
  const nozzle = new THREE.Mesh(nozzleGeo, matBody);
  nozzle.position.fromArray(offset);
  /* CylinderGeometry's axis is +Y by default; rotate so its axis
   * aligns with `axisLocal`. */
  const ax = new THREE.Vector3(axisLocal[0], axisLocal[1], axisLocal[2]).normalize();
  nozzle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ax);
  nozzle.userData = {
    kind: "rotor",            // re-uses rotor break / lift logic
    name,
    hp: 14, maxHp: 14,
    broken: false,
    spinning: false,           // no blade to spin
    isThruster: true,
  };
  drone.add(nozzle);

  /* Exhaust cone: emissive flame-like geometry hanging off the open
   * end of the nozzle. Parented to the nozzle (not the drone group)
   * so when the nozzle breaks off as debris the exhaust travels with
   * it — though the per-frame pulse code hides the exhaust on break,
   * so visually the broken nozzle just goes dark as it tumbles.
   *
   * In the nozzle's LOCAL frame the cylinder axis is +Y (default), so
   * the exit face is at +Y and the cone's local position is along +Y
   * by `length/2 + exhaustLen/2`. ConeGeometry's tip is at +Y, base
   * at -Y; we want the base flush with the nozzle exit and the tip
   * extending further in +Y (i.e. exhaust shooting outward). The
   * default cone orientation already does that. */
  const exhaustMat = new THREE.MeshStandardMaterial({
    color: tint,
    emissive: tintEmi,
    emissiveIntensity: 2.4,
    roughness: 0.35,
    metalness: 0.05,
  });
  const exhaustGeo = new THREE.ConeGeometry(radius * 0.95, exhaustLen, 14, 1, true);
  const exhaust = new THREE.Mesh(exhaustGeo, exhaustMat);
  exhaust.position.set(0, length / 2 + exhaustLen / 2, 0);
  /* Don't cast shadow — emissive flames in the shadow map look like
   * solid blocks. */
  exhaust.castShadow = false;
  nozzle.add(exhaust);
  nozzle.userData.exhaust = exhaust;

  drone.userData.rotors.push(nozzle);
  drone.userData.components.push(nozzle);
  return nozzle;
}

/* Place 6 cosmetic-but-real armour chips around a body box. Each chip
 * is sized to fully cover one face plus a small overhang (×1.1) so
 * adjacent chips overlap at edges — there's no gap between plates a
 * shot can squeeze through. Each chip has its own HP — once destroyed
 * it hides and exposes the body face behind. Visual progression: the
 * player can literally watch the chassis get stripped one face at a
 * time. */
function buildBodyChips(drone, body, halfSize, matBody) {
  const chipMat = makeBodyMat(matBody.color.getHex());
  chipMat.color.multiplyScalar(1.25);   // slightly lighter armour layer
  chipMat.roughness = 0.5;
  const t = 0.04;                       // plate thickness
  const overhang = 1.1;                 // 10 % extra to overlap at edges
  const fX = halfSize.x * 2 * overhang;
  const fY = halfSize.y * 2 * overhang;
  const fZ = halfSize.z * 2 * overhang;
  const faces = [
    [ "x",  1, [t, fY, fZ] ],
    [ "x", -1, [t, fY, fZ] ],
    [ "z",  1, [fX, fY, t] ],
    [ "z", -1, [fX, fY, t] ],
    [ "y",  1, [fX, t, fZ] ],
    [ "y", -1, [fX, t, fZ] ],
  ];
  drone.userData.bodyChips = [];
  for (const [axis, sign, dims] of faces) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...dims), chipMat.clone());
    /* Sit just outside the body face so raycasts hit the chip before
     * tunnelling into the body geometry behind it. */
    const pos = body.position.clone();
    if (axis === "x") pos.x += sign * (halfSize.x + t * 0.5);
    if (axis === "y") pos.y += sign * (halfSize.y + t * 0.5);
    if (axis === "z") pos.z += sign * (halfSize.z + t * 0.5);
    m.position.copy(pos);
    m.userData = { kind: "chip", hp: 14, maxHp: 14, broken: false };
    drone.add(m);
    drone.userData.bodyChips.push(m);
    drone.userData.components.push(m);
  }
}

/* Status LED + vision cone — common to every variant, parented to the
 * drone group so they inherit yaw/pitch. */
function buildStatusLed(drone, ledHexInit) {
  const ledMat = new THREE.MeshStandardMaterial({
    color: ledHexInit,
    emissive: ledHexInit,
    emissiveIntensity: 1.4,
    roughness: 0.4,
    metalness: 0.1,
  });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), ledMat);
  led.position.set(0, 0.17, 0);
  drone.add(led);
  drone.userData.statusLed = led;
}

function buildVisionCone(drone, parent, initialColor = 0x4488ff) {
  const coneMat = new THREE.MeshBasicMaterial({
    color: initialColor,
    transparent: true,
    opacity: 0.10,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const cone = new THREE.Mesh(getVisionConeGeo(), coneMat);
  cone.raycast = () => null;
  parent.add(cone);
  drone.userData.visionCone = cone;
}

/* ── Turret ─────────────────────────────────────────────────────────────
 * A small gimbal that hangs below the body. The turret's local rotation
 * is computed in world space each frame (via lookAt-style basis math)
 * and slerped — this lets the turret keep its barrel/cam fixed on the
 * player while the body banks and yaws independently along its flight
 * path.
 *
 * Variants attach their weapon + optics directly to the turret group:
 *   STANDARD → small targeting cam (front)
 *   SNIPER   → long barrel + scope assembly
 *   MISSILE  → small targeting cam (front); missile pods stay on body
 *
 * KAMIKAZE has no turret — its whole purpose is to ram the player so
 * the body itself stays aimed at them. */
function buildTurret(drone, type) {
  const turret = new THREE.Group();
  turret.name = "turret";
  /* Hang slightly below the body so it can swivel without colliding. */
  turret.position.set(0, -0.10, 0);
  drone.add(turret);
  drone.userData.turret = turret;

  /* Visible "ball" gimbal mount on the underside of the body — lives on
   * the body (not the turret) so it stays put while the turret swivels. */
  const matRotor = makeRotorMat();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), matRotor);
  ball.position.set(0, -0.07, 0);
  drone.add(ball);

  return turret;
}

/* ── Variant builders ─────────────────────────────────────────────────── */

/* All variants build a base group, populate it with shielded rotors +
 * body chips + status LED + cone, and then add their type-specific
 * armaments. */

function startDroneGroup(type) {
  const drone = new THREE.Group();
  drone.name = `drone:${type}`;
  drone.userData.type = type;
  drone.userData.rotors = [];
  drone.userData.components = [];
  drone.userData.findKind = (kind) =>
    drone.userData.components.find((c) => c.userData?.kind === kind);
  return drone;
}

function buildStandardDroneMesh() {
  const stats = DRONE_TYPE_STATS[DRONE_TYPE_STANDARD];
  const matBody = makeBodyMat(stats.tintHex);
  const matRotor = makeRotorMat();
  const matAccent = makeAccentMat();
  const matTargeting = makeTargetingMat();

  const drone = startDroneGroup(DRONE_TYPE_STANDARD);

  /* Body — small chassis. Most HP lives in the chip layer. */
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.12, 0.36), matBody);
  body.userData = { kind: "body", hp: stats.bodyHp, maxHp: stats.bodyHp, broken: false, crit: 1.5 };
  drone.add(body);
  drone.userData.components.push(body);

  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 0.28), matBody);
  belly.position.y = -0.06;
  drone.add(belly);

  const core = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.12), matAccent);
  core.position.y = 0.09;
  core.userData = { kind: "power", hp: 28, maxHp: 28, broken: false, crit: 2.0 };
  drone.add(core);
  drone.userData.components.push(core);

  /* Turret-mounted targeting cam — tracks the player independently of
   * the body's flight orientation. */
  const turret = buildTurret(drone, DRONE_TYPE_STANDARD);
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), matTargeting);
  cam.position.set(0, 0, 0.07);
  cam.userData = { kind: "targeting", hp: 18, maxHp: 18, broken: false };
  turret.add(cam);
  drone.userData.components.push(cam);

  /* 4 shielded rotors at the corners. */
  const rotorOffsets = [
    [ 0.48, 0.03,  0.48], [-0.48, 0.03,  0.48],
    [ 0.48, 0.03, -0.48], [-0.48, 0.03, -0.48],
  ];
  const rotorNames = ["FR", "FL", "BR", "BL"];
  for (let i = 0; i < 4; i++) {
    buildShieldedRotor(drone, rotorOffsets[i], rotorNames[i], matBody, matRotor);
  }

  /* Body chips. */
  buildBodyChips(drone, body, new THREE.Vector3(0.18, 0.06, 0.18), matBody);

  buildStatusLed(drone, 0x66bbff);
  buildVisionCone(drone, turret);
  return drone;
}

function buildSniperDroneMesh() {
  const stats = DRONE_TYPE_STATS[DRONE_TYPE_SNIPER];
  const matBody = makeBodyMat(stats.tintHex);
  const matRotor = makeRotorMat();
  const matAccent = makeAccentMat(0xffaa44, 0xff7711, 1.4);
  const matTargeting = makeTargetingMat();
  /* Scope ring uses a saturated cyan so the player can spot a sniper
   * before it acquires lock. */
  const matScope = new THREE.MeshStandardMaterial({
    color: 0x66ddff, emissive: 0x33aaff, emissiveIntensity: 1.6,
    roughness: 0.3, metalness: 0.4,
  });

  const drone = startDroneGroup(DRONE_TYPE_SNIPER);

  /* Slimmer + longer body — visually elongated forward (along +Z). */
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.10, 0.50), matBody);
  body.userData = { kind: "body", hp: stats.bodyHp, maxHp: stats.bodyHp, broken: false, crit: 1.5 };
  drone.add(body);
  drone.userData.components.push(body);

  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.40), matBody);
  belly.position.y = -0.05;
  drone.add(belly);

  const core = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.12), matAccent);
  core.position.set(0, 0.08, -0.10);
  core.userData = { kind: "power", hp: 28, maxHp: 28, broken: false, crit: 2.0 };
  drone.add(core);
  drone.userData.components.push(core);

  /* Turret carries the entire weapon assembly — barrel, muzzle, scope.
   * The body is free to bank along its flight path while the turret
   * keeps the long barrel locked on the player; visually striking and
   * lets the player anticipate exactly where the next shot will go. */
  const turret = buildTurret(drone, DRONE_TYPE_SNIPER);

  /* Long telescopic BARREL forward — the sniper's primary weapon.
   * Breaking it stops the drone firing entirely. Cylinder oriented
   * along the turret's +Z axis (its forward). */
  const barrelGeo = new THREE.CylinderGeometry(0.045, 0.055, 0.55, 16);
  barrelGeo.rotateX(Math.PI / 2); // axis +Y → +Z
  const barrel = new THREE.Mesh(barrelGeo, matBody);
  barrel.position.set(0, 0, 0.30);
  barrel.userData = { kind: "weapon", hp: 18, maxHp: 18, broken: false };
  turret.add(barrel);
  drone.userData.components.push(barrel);

  /* Muzzle ring (visual only) — at the very tip of the barrel. */
  const muzzleRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.06, 0.012, 6, 18),
    matBody,
  );
  muzzleRing.position.set(0, 0, 0.575);
  muzzleRing.rotation.x = Math.PI / 2;
  turret.add(muzzleRing);

  /* Scope assembly on top of the barrel — destructible (kind=targeting). */
  const scope = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 0.18, 12),
    matScope,
  );
  scope.rotation.x = Math.PI / 2;
  scope.position.set(0, 0.06, 0.10);
  scope.userData = { kind: "targeting", hp: 18, maxHp: 18, broken: false };
  turret.add(scope);
  drone.userData.components.push(scope);

  const scopeEye = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 10, 8),
    matTargeting,
  );
  scopeEye.position.set(0, 0.06, 0.06);
  scope.add(scopeEye);

  /* 4 shielded rotors — same offsets as standard. */
  const rotorOffsets = [
    [ 0.48, 0.03,  0.42], [-0.48, 0.03,  0.42],
    [ 0.48, 0.03, -0.42], [-0.48, 0.03, -0.42],
  ];
  const rotorNames = ["FR", "FL", "BR", "BL"];
  for (let i = 0; i < 4; i++) {
    buildShieldedRotor(drone, rotorOffsets[i], rotorNames[i], matBody, matRotor);
  }

  buildBodyChips(drone, body, new THREE.Vector3(0.16, 0.05, 0.25), matBody);
  buildStatusLed(drone, 0x66ddff);
  buildVisionCone(drone, turret, 0x66ccff);
  return drone;
}

function buildMissileDroneMesh() {
  const stats = DRONE_TYPE_STATS[DRONE_TYPE_MISSILE];
  const matBody = makeBodyMat(stats.tintHex);
  const matRotor = makeRotorMat();
  const matAccent = makeAccentMat(0xffaa22, 0xff7711, 1.5);
  const matTargeting = makeTargetingMat();
  const matPod = new THREE.MeshStandardMaterial({
    color: 0x6e5a18, roughness: 0.5, metalness: 0.5,
  });
  const matMissile = new THREE.MeshStandardMaterial({
    color: 0xff8822, emissive: 0xff5500, emissiveIntensity: 1.4,
    roughness: 0.4, metalness: 0.4,
  });

  const drone = startDroneGroup(DRONE_TYPE_MISSILE);

  /* Wider stockier body. */
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.42), matBody);
  body.userData = { kind: "body", hp: stats.bodyHp, maxHp: stats.bodyHp, broken: false, crit: 1.5 };
  drone.add(body);
  drone.userData.components.push(body);

  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.34), matBody);
  belly.position.y = -0.08;
  drone.add(belly);

  const core = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.10, 0.14), matAccent);
  core.position.set(0, 0.13, 0);
  core.userData = { kind: "power", hp: 28, maxHp: 28, broken: false, crit: 2.0 };
  drone.add(core);
  drone.userData.components.push(core);

  /* Turret-mounted targeting cam. Missile pods stay on the body — the
   * missiles home anyway so initial launch direction isn't critical. */
  const turret = buildTurret(drone, DRONE_TYPE_MISSILE);
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), matTargeting);
  cam.position.set(0, 0, 0.10);
  cam.userData = { kind: "targeting", hp: 18, maxHp: 18, broken: false };
  turret.add(cam);
  drone.userData.components.push(cam);

  /* Two missile pods on the sides. Each pod is destructible — when
   * broken, that side stops spawning missiles. Both broken = no fire. */
  const podGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.32, 12);
  podGeo.rotateX(Math.PI / 2);
  for (const sign of [-1, 1]) {
    const pod = new THREE.Mesh(podGeo, matPod);
    pod.position.set(sign * 0.27, 0.04, 0.05);
    pod.userData = {
      kind: "pod",
      side: sign < 0 ? "L" : "R",
      hp: 20,
      maxHp: 20,
      broken: false,
    };
    drone.add(pod);
    drone.userData.components.push(pod);

    /* Visible missile nose poking out the front of each pod. */
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.10, 12), matMissile);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0, 0.20);
    pod.add(nose);
  }

  /* 4 shielded rotors — slightly wider mounting for stability look. */
  const rotorOffsets = [
    [ 0.55, 0.05,  0.50], [-0.55, 0.05,  0.50],
    [ 0.55, 0.05, -0.50], [-0.55, 0.05, -0.50],
  ];
  const rotorNames = ["FR", "FL", "BR", "BL"];
  for (let i = 0; i < 4; i++) {
    buildShieldedRotor(drone, rotorOffsets[i], rotorNames[i], matBody, matRotor);
  }

  buildBodyChips(drone, body, new THREE.Vector3(0.21, 0.08, 0.21), matBody);
  buildStatusLed(drone, 0xffcc44);
  buildVisionCone(drone, drone.userData.turret, 0xffaa44);
  return drone;
}

function buildKamikazeDroneMesh() {
  const stats = DRONE_TYPE_STATS[DRONE_TYPE_KAMIKAZE];
  const matBody = makeBodyMat(stats.tintHex);
  const matRotor = makeRotorMat();
  const matAccent = makeAccentMat(0xff3322, 0xff1100, 2.2);
  /* Warhead: a hot pulsing orb that looks unmistakably explosive. */
  const matWarhead = new THREE.MeshStandardMaterial({
    color: 0xff4422, emissive: 0xff2200, emissiveIntensity: 3.0,
    roughness: 0.3, metalness: 0.0,
  });
  const matSpike = new THREE.MeshStandardMaterial({
    color: 0x3a2018, roughness: 0.7, metalness: 0.3,
  });

  const drone = startDroneGroup(DRONE_TYPE_KAMIKAZE);

  /* Compact body, smaller than standard. */
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.10, 0.30), matBody);
  body.userData = { kind: "body", hp: stats.bodyHp, maxHp: stats.bodyHp, broken: false, crit: 1.5 };
  drone.add(body);
  drone.userData.components.push(body);

  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.24), matBody);
  belly.position.y = -0.05;
  drone.add(belly);

  const core = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.06, 0.10), matAccent);
  core.position.set(0, -0.02, -0.05);
  core.userData = { kind: "power", hp: 28, maxHp: 28, broken: false, crit: 2.0 };
  drone.add(core);
  drone.userData.components.push(core);

  /* Big glowing WARHEAD on top — kind="warhead". When broken the drone
   * goes inert (still flies, can no longer detonate). */
  const warhead = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 14, 10),
    matWarhead,
  );
  warhead.position.set(0, 0.16, 0);
  warhead.userData = { kind: "warhead", hp: 20, maxHp: 20, broken: false, crit: 2.0 };
  drone.add(warhead);
  drone.userData.components.push(warhead);

  /* Forward-pointing spikes — purely cosmetic, sells the rammer read. */
  for (const dx of [-0.08, 0, 0.08]) {
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.10, 8), matSpike);
    sp.rotation.x = Math.PI / 2;
    sp.position.set(dx, 0, 0.18);
    drone.add(sp);
  }

  /* 4 shielded rotors — tighter spacing for the smaller chassis. */
  const rotorOffsets = [
    [ 0.42, 0.03,  0.42], [-0.42, 0.03,  0.42],
    [ 0.42, 0.03, -0.42], [-0.42, 0.03, -0.42],
  ];
  const rotorNames = ["FR", "FL", "BR", "BL"];
  for (let i = 0; i < 4; i++) {
    buildShieldedRotor(drone, rotorOffsets[i], rotorNames[i], matBody, matRotor);
  }

  buildBodyChips(drone, body, new THREE.Vector3(0.15, 0.05, 0.15), matBody);
  buildStatusLed(drone, 0xff6644);
  /* Kamikaze has no turret — its whole strategy is "ram the player",
   * so the body itself stays aimed via faceTarget. Cone parents to the
   * drone group directly. */
  buildVisionCone(drone, drone, 0xff5544);
  return drone;
}

/* ── Shield drone ─────────────────────────────────────────────────────
 * A slow blocky chassis with a tall central "emitter" pillar. The
 * emitter is a destructible component (kind="emitter"); breaking it
 * drops the dome instantly. The dome itself is a translucent SphereGeo
 * around the drone, scaled to `domeRadius`. While the emitter is
 * intact, ANY ally drone whose body centre lies within the dome takes
 * 0 damage (handled in takeDamage by checking `_underAnyShieldDome`).
 * The dome doesn't block player movement / projectiles — it's a
 * gameplay shield, not a physical one — but visually it reads as
 * "these drones are protected, kill the shielder first."
 */
function buildShieldDroneMesh() {
  const stats = DRONE_TYPE_STATS[DRONE_TYPE_SHIELD];
  const matBody = makeBodyMat(stats.tintHex);
  const matRotor = makeRotorMat();
  const matAccent = makeAccentMat(0x55aaff, 0x2266cc, 1.6);
  const matEmitter = new THREE.MeshStandardMaterial({
    color: 0x88ddff, emissive: 0x44aaff, emissiveIntensity: 1.8,
    roughness: 0.35, metalness: 0.45,
  });
  const matDome = new THREE.MeshBasicMaterial({
    color: 0x66bbff, transparent: true, opacity: 0.10,
    side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending,
  });

  const drone = startDroneGroup(DRONE_TYPE_SHIELD);

  /* Heavier wider body. */
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.20, 0.46), matBody);
  body.userData = { kind: "body", hp: stats.bodyHp, maxHp: stats.bodyHp, broken: false, crit: 1.5 };
  drone.add(body);
  drone.userData.components.push(body);

  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.36), matBody);
  belly.position.y = -0.10;
  drone.add(belly);

  const core = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.10, 0.14), matAccent);
  core.position.set(0, 0.13, 0);
  core.userData = { kind: "power", hp: 28, maxHp: 28, broken: false, crit: 2.0 };
  drone.add(core);
  drone.userData.components.push(core);

  /* Emitter pillar — tall glowing column on top. Destructible. When
   * broken, hide it AND the dome. */
  const emitter = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.10, 0.30, 14),
    matEmitter,
  );
  emitter.position.set(0, 0.27, 0);
  emitter.userData = { kind: "emitter", hp: 26, maxHp: 26, broken: false };
  drone.add(emitter);
  drone.userData.components.push(emitter);

  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.10, 14, 10),
    matEmitter,
  );
  cap.position.set(0, 0.44, 0);
  emitter.userData.cap = cap;
  drone.add(cap);
  emitter.add(cap);  /* cap as child so it disappears with emitter */

  /* The dome — sphere of `domeRadius`. Stays alive while emitter intact.
   * Pulses opacity gently so the player notices when it's active. */
  const domeGeo = new THREE.SphereGeometry(stats.domeRadius || 6, 24, 14);
  const dome = new THREE.Mesh(domeGeo, matDome);
  dome.raycast = () => null;        // never blocks shots / mouse picks
  dome.frustumCulled = false;
  drone.add(dome);
  drone.userData.dome = dome;
  drone.userData.domeRadius = stats.domeRadius || 6;

  /* Turret-mounted scanner (cosmetic targeting). */
  const turret = buildTurret(drone, DRONE_TYPE_SHIELD);
  const cam = new THREE.Mesh(
    new THREE.SphereGeometry(0.07, 10, 8),
    makeTargetingMat(),
  );
  cam.position.set(0, 0, 0.10);
  cam.userData = { kind: "targeting", hp: 18, maxHp: 18, broken: false };
  turret.add(cam);
  drone.userData.components.push(cam);

  /* 4 shielded rotors, slightly offset for the larger body. */
  const rotorOffsets = [
    [ 0.55, 0.05,  0.55], [-0.55, 0.05,  0.55],
    [ 0.55, 0.05, -0.55], [-0.55, 0.05, -0.55],
  ];
  const rotorNames = ["FR", "FL", "BR", "BL"];
  for (let i = 0; i < 4; i++) {
    buildShieldedRotor(drone, rotorOffsets[i], rotorNames[i], matBody, matRotor);
  }

  buildBodyChips(drone, body, new THREE.Vector3(0.23, 0.10, 0.23), matBody);
  buildStatusLed(drone, 0x66bbff);
  buildVisionCone(drone, turret, 0x66bbff);
  return drone;
}

/* ── Tank drone ───────────────────────────────────────────────────────
 * Wide, heavily armoured chassis. Turret carries a chunky multi-barrel
 * gatling. The gatling MUZZLE is a separate spinning sub-mesh so the
 * player can tell a tank is firing from the visual spin alone.
 */
function buildTankDroneMesh() {
  const stats = DRONE_TYPE_STATS[DRONE_TYPE_TANK];
  const matBody = makeBodyMat(stats.tintHex);
  const matRotor = makeRotorMat();
  const matAccent = makeAccentMat(0xff8822, 0xff5510, 1.8);
  const matGatling = new THREE.MeshStandardMaterial({
    color: 0x222226, roughness: 0.5, metalness: 0.7,
  });
  const matMuzzle = new THREE.MeshStandardMaterial({
    color: 0x553322, roughness: 0.6, metalness: 0.5,
  });

  const drone = startDroneGroup(DRONE_TYPE_TANK);

  /* Big chassis. */
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.20, 0.48), matBody);
  body.userData = { kind: "body", hp: stats.bodyHp, maxHp: stats.bodyHp, broken: false, crit: 1.5 };
  drone.add(body);
  drone.userData.components.push(body);

  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.06, 0.40), matBody);
  belly.position.y = -0.10;
  drone.add(belly);

  const core = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.10, 0.16), matAccent);
  core.position.set(0, 0.13, 0);
  core.userData = { kind: "power", hp: 32, maxHp: 32, broken: false, crit: 2.0 };
  drone.add(core);
  drone.userData.components.push(core);

  /* Turret. */
  const turret = buildTurret(drone, DRONE_TYPE_TANK);

  /* Gatling barrel cluster — 6 short barrels arranged in a circle around
   * a hub that spins while firing. The whole assembly is the WEAPON
   * component — break it and the tank can't fire. */
  const gatling = new THREE.Group();
  gatling.position.set(0, 0, 0.10);
  gatling.userData = { kind: "weapon", hp: 28, maxHp: 28, broken: false };
  turret.add(gatling);
  drone.userData.components.push(gatling);

  /* Hub (spins during fire). */
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 0.32, 18),
    matGatling,
  );
  hub.rotation.x = Math.PI / 2;
  hub.position.set(0, 0, 0.16);
  gatling.add(hub);
  gatling.userData.hub = hub;

  /* 6 barrels around the hub. */
  const barrelCount = 6;
  const barrelR = 0.05;
  for (let i = 0; i < barrelCount; i++) {
    const a = (i / barrelCount) * Math.PI * 2;
    const b = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.28, 8),
      matGatling,
    );
    b.rotation.x = Math.PI / 2;
    b.position.set(Math.cos(a) * barrelR, Math.sin(a) * barrelR, 0.18);
    hub.add(b);
  }

  /* Muzzle ring at the tip. */
  const muzzle = new THREE.Mesh(
    new THREE.TorusGeometry(0.08, 0.014, 8, 22),
    matMuzzle,
  );
  muzzle.rotation.y = Math.PI / 2;
  muzzle.position.set(0, 0, 0.34);
  turret.add(muzzle);

  /* Cosmetic targeting cam beside the gatling. */
  const cam = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 10, 8),
    makeTargetingMat(),
  );
  cam.position.set(0.10, 0.05, 0.04);
  cam.userData = { kind: "targeting", hp: 18, maxHp: 18, broken: false };
  turret.add(cam);
  drone.userData.components.push(cam);

  /* 4 shielded rotors — beefy spread. */
  const rotorOffsets = [
    [ 0.58, 0.05,  0.55], [-0.58, 0.05,  0.55],
    [ 0.58, 0.05, -0.55], [-0.58, 0.05, -0.55],
  ];
  const rotorNames = ["FR", "FL", "BR", "BL"];
  for (let i = 0; i < 4; i++) {
    buildShieldedRotor(drone, rotorOffsets[i], rotorNames[i], matBody, matRotor);
  }

  buildBodyChips(drone, body, new THREE.Vector3(0.24, 0.10, 0.24), matBody);
  buildStatusLed(drone, 0xff8844);
  buildVisionCone(drone, turret, 0xffaa44);
  return drone;
}

/* ── Engineer drone ───────────────────────────────────────────────────
 * Narrow, vertically tall body with a glowing green emitter dish. The
 * dish is the targeting component (so breaking it stops repair). Also
 * carries a `repairDish` reference + a beam mesh that activates while
 * repairing. */
function buildEngineerDroneMesh() {
  const stats = DRONE_TYPE_STATS[DRONE_TYPE_ENGINEER];
  const matBody = makeBodyMat(stats.tintHex);
  const matRotor = makeRotorMat();
  const matAccent = makeAccentMat(0x66ff88, 0x33cc55, 1.6);
  const matDish = new THREE.MeshStandardMaterial({
    color: 0x88ffaa, emissive: 0x33ee66, emissiveIntensity: 2.2,
    roughness: 0.3, metalness: 0.4,
  });
  const matBeam = new THREE.MeshBasicMaterial({
    color: 0x66ff88, transparent: true, opacity: 0,
    depthTest: false, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending,
  });

  const drone = startDroneGroup(DRONE_TYPE_ENGINEER);

  /* Slim body. */
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.16, 0.30), matBody);
  body.userData = { kind: "body", hp: stats.bodyHp, maxHp: stats.bodyHp, broken: false, crit: 1.5 };
  drone.add(body);
  drone.userData.components.push(body);

  const belly = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.04, 0.24), matBody);
  belly.position.y = -0.08;
  drone.add(belly);

  const core = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.08, 0.10), matAccent);
  core.position.set(0, 0.12, 0);
  core.userData = { kind: "power", hp: 24, maxHp: 24, broken: false, crit: 2.0 };
  drone.add(core);
  drone.userData.components.push(core);

  /* Turret with a bowl-shaped dish — the repair emitter. Breaking the
   * dish (kind="targeting") cripples the engineer's purpose. */
  const turret = buildTurret(drone, DRONE_TYPE_ENGINEER);
  const dish = new THREE.Mesh(
    new THREE.CylinderGeometry(0.10, 0.04, 0.05, 16, 1, true),
    matDish,
  );
  dish.rotation.x = Math.PI / 2;
  dish.position.set(0, 0, 0.10);
  dish.userData = { kind: "targeting", hp: 20, maxHp: 20, broken: false };
  turret.add(dish);
  drone.userData.components.push(dish);
  drone.userData.repairDish = dish;

  /* Beam mesh: thin cylinder centred at z=0.5 (we re-position per frame
   * while repairing, hide otherwise). */
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.025, 1.0, 10),
    matBeam,
  );
  beam.rotation.x = Math.PI / 2;
  beam.visible = false;
  beam.frustumCulled = false;
  beam.raycast = () => null;
  scene_.add(beam);
  drone.userData.repairBeam = beam;

  /* 4 shielded rotors. */
  const rotorOffsets = [
    [ 0.45, 0.04,  0.45], [-0.45, 0.04,  0.45],
    [ 0.45, 0.04, -0.45], [-0.45, 0.04, -0.45],
  ];
  const rotorNames = ["FR", "FL", "BR", "BL"];
  for (let i = 0; i < 4; i++) {
    buildShieldedRotor(drone, rotorOffsets[i], rotorNames[i], matBody, matRotor);
  }

  buildBodyChips(drone, body, new THREE.Vector3(0.15, 0.08, 0.15), matBody);
  buildStatusLed(drone, 0x66ff88);
  buildVisionCone(drone, turret, 0x66ff88);
  return drone;
}

/* Jet Skimmer: aerodynamic body with a single rear nozzle. ONE
 * thruster → loses lift entirely the moment its single rotor
 * component breaks (compare standard's gradual sag at 3/4 → 2/4 → …).
 * Compensates with high speed and long-range flanking aim.
 *
 * Profile: skinny + elongated along +Z (forward), so the silhouette
 * reads as "fast" from any angle. Subtle violet tint distinguishes it
 * from the gunmetal Standard at a glance. */
function buildJetDroneMesh() {
  const stats = DRONE_TYPE_STATS[DRONE_TYPE_JET];
  const matBody = makeBodyMat(stats.tintHex);
  const matAccent = makeAccentMat(0xc44aff, 0x6611cc, 1.6);
  const matTargeting = makeTargetingMat();

  const drone = startDroneGroup(DRONE_TYPE_JET);
  /* Tell liftFactor how many propulsion units this variant has so it
   * uses the right "broken→lift" curve. */
  drone.userData.totalRotors = 1;

  /* Body — slim & long, like a small fighter fuselage. */
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.10, 0.55), matBody);
  body.userData = { kind: "body", hp: stats.bodyHp, maxHp: stats.bodyHp, broken: false, crit: 1.5 };
  drone.add(body);
  drone.userData.components.push(body);

  /* Power core — sits high on the spine. */
  const core = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.07, 0.16), matAccent);
  core.position.y = 0.09;
  core.userData = { kind: "power", hp: 26, maxHp: 26, broken: false, crit: 2.0 };
  drone.add(core);
  drone.userData.components.push(core);

  /* Turret + targeting cam — same scheme as standard. */
  const turret = buildTurret(drone, DRONE_TYPE_JET);
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), matTargeting);
  cam.position.set(0, 0, 0.07);
  cam.userData = { kind: "targeting", hp: 18, maxHp: 18, broken: false };
  turret.add(cam);
  drone.userData.components.push(cam);

  /* Single REAR thruster — exhaust fires into -Z (out the back),
   * propelling the drone in +Z (forward). The local axis we pass is
   * +Z because that's the orientation of the nozzle's long axis; the
   * helper places the exhaust cone on the +axis side of the nozzle. */
  buildThrusterRotor(
    drone,
    [0, 0, -0.30],            // mounted at the back of the body
    [0, 0, -1],                // nozzle axis pointing -Z (exhaust direction)
    "REAR",
    matBody,
    {
      radius: 0.13,            // chunky — singular engine
      length: 0.22,
      exhaustLen: 0.30,
      exhaustHex: 0xc44aff,
      exhaustEmiHex: 0x6611cc,
    },
  );

  /* Body chips — fewer / smaller than standard since the body is
   * skinnier. */
  buildBodyChips(drone, body, new THREE.Vector3(0.15, 0.05, 0.275), matBody);

  buildStatusLed(drone, 0xc44aff);
  buildVisionCone(drone, turret, 0xc44aff);
  return drone;
}

/* Twin-Duct Hover: short, wide chassis with two ducted-fan thrusters
 * mounted on the sides. Each duct is its own rotor component. With
 * 2 thrusters, lift behaves: 2/2=1.0, 1/2=0.40, 0/2=0 (falls). The
 * tougher chassis (higher bodyHp + standard chip layer) makes it
 * good at soaking sustained fire while it picks at you with regular
 * shots. Slow speed makes flanking + grenades effective vs it.
 *
 * Visually: stubby + symmetric, with two glowing rings facing
 * downward (lift) — reads as "hovercraft" instantly. */
function buildHoverDroneMesh() {
  const stats = DRONE_TYPE_STATS[DRONE_TYPE_HOVER];
  const matBody = makeBodyMat(stats.tintHex);
  const matAccent = makeAccentMat(0x33ddff, 0x11aacc, 1.4);
  const matTargeting = makeTargetingMat();

  const drone = startDroneGroup(DRONE_TYPE_HOVER);
  drone.userData.totalRotors = 2;

  /* Body — wider + flatter than standard. */
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.10, 0.34), matBody);
  body.userData = { kind: "body", hp: stats.bodyHp, maxHp: stats.bodyHp, broken: false, crit: 1.5 };
  drone.add(body);
  drone.userData.components.push(body);

  /* Power core. */
  const core = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.14), matAccent);
  core.position.y = 0.08;
  core.userData = { kind: "power", hp: 30, maxHp: 30, broken: false, crit: 2.0 };
  drone.add(core);
  drone.userData.components.push(core);

  /* Turret + targeting cam. */
  const turret = buildTurret(drone, DRONE_TYPE_HOVER);
  const cam = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), matTargeting);
  cam.position.set(0, 0, 0.07);
  cam.userData = { kind: "targeting", hp: 18, maxHp: 18, broken: false };
  turret.add(cam);
  drone.userData.components.push(cam);

  /* Twin DOWNWARD thrusters — exhaust fires -Y, propelling the drone
   * upward against gravity (= hovering). One per side at ±X. */
  buildThrusterRotor(
    drone,
    [-0.35, -0.04, 0],         // left duct
    [0, -1, 0],                 // exhaust points down
    "L",
    matBody,
    {
      radius: 0.13,
      length: 0.18,
      exhaustLen: 0.16,
      exhaustHex: 0x33ddff,
      exhaustEmiHex: 0x11aacc,
    },
  );
  buildThrusterRotor(
    drone,
    [ 0.35, -0.04, 0],         // right duct
    [0, -1, 0],
    "R",
    matBody,
    {
      radius: 0.13,
      length: 0.18,
      exhaustLen: 0.16,
      exhaustHex: 0x33ddff,
      exhaustEmiHex: 0x11aacc,
    },
  );

  /* Body chips wrap the wide hull. */
  buildBodyChips(drone, body, new THREE.Vector3(0.23, 0.05, 0.17), matBody);

  buildStatusLed(drone, 0x33ddff);
  buildVisionCone(drone, turret, 0x33ddff);
  return drone;
}

/* Dispatcher used by Drone constructor. */
function buildDroneMesh(type = DRONE_TYPE_STANDARD) {
  switch (type) {
    case DRONE_TYPE_SNIPER:   return buildSniperDroneMesh();
    case DRONE_TYPE_MISSILE:  return buildMissileDroneMesh();
    case DRONE_TYPE_KAMIKAZE: return buildKamikazeDroneMesh();
    case DRONE_TYPE_SHIELD:   return buildShieldDroneMesh();
    case DRONE_TYPE_TANK:     return buildTankDroneMesh();
    case DRONE_TYPE_ENGINEER: return buildEngineerDroneMesh();
    case DRONE_TYPE_JET:      return buildJetDroneMesh();
    case DRONE_TYPE_HOVER:    return buildHoverDroneMesh();
    default:                  return buildStandardDroneMesh();
  }
}

/* ── Shield-dome helpers ──────────────────────────────────────────────
 * `_underAnyShieldDome(drone)` — true iff `drone` is inside any LIVING
 *   shielder's dome whose emitter is intact AND the shielder isn't dead.
 * `_pulseShieldDome(worldPos)` — find the dome covering `worldPos` and
 *   give it a brief opacity bump (visible ripple when a shot is absorbed).
 *
 * Cheap O(N drones) per call. We keep the logic separate from Drone so
 * non-drone systems (grenades, future tools) can also test dome
 * protection without going through the class. */
function _underAnyShieldDome(targetDrone) {
  for (const o of drones_) {
    if (o.dead) continue;
    if (o.type !== DRONE_TYPE_SHIELD) continue;
    const emitter = o.group.userData.findKind("emitter");
    if (!emitter || emitter.userData.broken) continue;
    const r = o.group.userData.domeRadius || 6;
    const d2 = o.group.position.distanceToSquared(targetDrone.group.position);
    if (d2 < r * r) return true;
  }
  return false;
}
function _pulseShieldDome(worldPos) {
  for (const o of drones_) {
    if (o.dead) continue;
    if (o.type !== DRONE_TYPE_SHIELD) continue;
    const emitter = o.group.userData.findKind("emitter");
    if (!emitter || emitter.userData.broken) continue;
    const r = o.group.userData.domeRadius || 6;
    if (o.group.position.distanceToSquared(worldPos) < r * r) {
      /* Boost the dome material briefly — `domePulseTimer` is read in
       * Drone.update() to drive the opacity envelope. */
      o.domePulseTimer = 0.35;
    }
  }
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
  constructor(spawnPos, type = DRONE_TYPE_STANDARD, opts = {}) {
    this.type = type;
    this.stats = DRONE_TYPE_STATS[type] || DRONE_TYPE_STATS[DRONE_TYPE_STANDARD];
    this.group = buildDroneMesh(type);
    this.group.position.copy(spawnPos);
    this.group.userData.droneRef = this;
    /* Mark every SOLID mesh in the drone as a shadow caster so the
     * dynamic-shadow rig in main.js renders the drone's silhouette
     * onto the floor / podium / bridge overlays. We skip transparent
     * meshes (vision cones, shield domes, status LEDs that use
     * additive blending, etc.) since they're visual-only effects —
     * casting their silhouette would put a fake "cone shape" shadow on
     * the floor every frame. The static building is already
     * lightmapped (castShadow=false there), so the depth pass only
     * contains drone hulls + grenades + projectiles — cheap. */
    this.group.traverse((m) => {
      if (!m.isMesh) return;
      const mat = m.material;
      /* `mat.transparent` catches cones / domes / repair beams /
       * any additive-blended FX. `mat.opacity < 0.99` catches any
       * non-opaque mesh that didn't opt into `transparent` flag. */
      if (mat?.transparent || (mat?.opacity ?? 1) < 0.99) return;
      m.castShadow = true;
    });
    /* Belt-and-braces: explicitly clear `castShadow` on the known
     * visual-only refs in case a future material change accidentally
     * leaves `transparent=false` on them. */
    const ud = this.group.userData;
    if (ud.visionCone) ud.visionCone.castShadow = false;
    if (ud.statusLed) ud.statusLed.castShadow = false;
    if (ud.dome) ud.dome.castShadow = false;
    scene_.add(this.group);

    /* Apply HP multiplier (boss waves + difficulty scaling).
     * `opts.hpMul` comes from the wave comp entry (e.g. boss tank).
     * `diffProfile_.bodyHpMul` from URL difficulty preset. */
    const hpMul = (opts.hpMul ?? 1) * (diffProfile_.bodyHpMul ?? 1);
    if (hpMul !== 1) {
      for (const c of this.group.userData.components) {
        if (c.userData?.maxHp) {
          c.userData.maxHp = Math.round(c.userData.maxHp * hpMul);
          c.userData.hp = c.userData.maxHp;
        }
      }
    }

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
    /* Body roll (banking) — set by faceVelocity when the drone is
     * turning, slowly levels out when hovering. Wobble adds onto this
     * for hit-feedback so the bank isn't lost during a stagger. */
    this.aimRoll = 0;
    /* Orbital flanking around the player during ATTACK — each drone
     * picks its own initial angle and direction so multiple drones
     * end up coming at you from different sides. Direction flips
     * occasionally to keep movement unpredictable. */
    this.orbitAngle = Math.random() * Math.PI * 2;
    this.orbitDir = Math.random() < 0.5 ? -1 : 1;
    this.orbitTimer = THREE.MathUtils.randFloat(2, 5);
    /* Altitude bob — independent sine phase per drone so they drift
     * up and down at different times, breaking the "all hovering
     * lockstep" look. */
    this.altPhase = Math.random() * Math.PI * 2;
    /* Aim focus 0..1 — grows in ATTACK with LOS, decays otherwise, snaps
     * to 0 on takeDamage. The visible cone width is driven from this. */
    this.aimFocus = 0;
    /* Brief visual roll-oscillation after a hit. Decremented in update(). */
    this.wobbleTimer = 0;
    this.isAlert = false;          // current hum buffer state
    this.audio = null;             // PositionalAudio for the looped hum

    /* Type-specific state. */
    /* Tank: gatling burst counter + hub spin angle. */
    this.burstShotsLeft = 0;        // > 0 → still in a burst
    this.burstShotTimer = 0;        // delay till next round in the burst
    this.gatlingSpin = 0;           // accumulator for hub rotation
    /* Engineer: current repair target (Drone) and beam fade. */
    this.repairTarget = null;
    this.repairBeamFade = 0;
    /* Shield: dome opacity pulse phase. */
    this.domePulse = Math.random() * Math.PI * 2;

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

  /** Returns true if the FSM is in any non-idle state.
   * RECHARGE counts as aggressive for HUD/audio purposes — the player
   * should still feel pressured even when a kamikaze is temporarily
   * defanged, since it's coming back. */
  isAggressive() {
    return this.state === "ALERT" || this.state === "ATTACK"
        || this.state === "INVESTIGATE" || this.state === "EVADE"
        || this.state === "RECHARGE";
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
     * the same hex so the LED and cone agree about alertness at a glance.
     * RECHARGE has its own amber-pulse colour so the player can read
     * "this kamikaze is regrowing its warhead" at a glance — and the
     * pulse rate ramps up as the timer nears zero, signalling the
     * imminent return of the threat. */
    let hex, intensity, blinkHz, coneOpacity;
    switch (this.state) {
      case "SURVEY":      hex = 0x4488ff; intensity = 1.4;  blinkHz = 0;  coneOpacity = 0.08; break;
      case "ALERT":
      case "INVESTIGATE": hex = 0xffaa22; intensity = 2.6;  blinkHz = 4;  coneOpacity = 0.16; break;
      case "ATTACK":
      case "EVADE":       hex = 0xff3322; intensity = 4.0;  blinkHz = 10; coneOpacity = 0.22; break;
      case "RECHARGE": {
        const k = 1 - Math.max(0, this.rechargeTimer / KAMIKAZE_RECHARGE_S);
        hex = 0xff8800;
        intensity = 1.5 + 2.5 * k;
        blinkHz = 1.5 + 6 * k;          // slow pulse → urgent throb as it nears recharge
        coneOpacity = 0.10 + 0.10 * k;
        break;
      }
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
    /* Lift curve depends on how many propulsion units the variant
     * was built with. Default 4 (all rotor drones). Thruster
     * drones override `totalRotors` in their builder so the lookup
     * picks the right curve.
     *
     *   4-rotor: 4/4=1.0, 3/4=0.75, 2/4=0.45, 1/4=0.18, 0/4=0
     *   2-thrust: 2/2=1.0, 1/2=0.40, 0/2=0  (twin-duct hover)
     *   1-thrust: 1/1=1.0, 0/1=0           (jet skimmer — instant fall)
     */
    const w = this.workingRotors();
    const total = this.group.userData.totalRotors || 4;
    if (total === 4) return [0, 0.18, 0.45, 0.75, 1.0][w] || 0;
    if (total === 2) return [0, 0.40, 1.0][w] || 0;
    if (total === 1) return [0, 1.0][w] || 0;
    /* Generic linear fallback for any future N-thruster variant. */
    return Math.min(1, w / Math.max(1, total));
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
     * the longer reach. Difficulty's `perceptionMul` rescales the
     * baseline range so harder profiles see (and shoot) further. */
    const perceptMul = diffProfile_.perceptionMul ?? 1;
    const sightRange = (this.isAggressive()
      ? DRONE_PERCEPTION_RANGE * DRONE_AGGRO_PERCEPTION_MULT
      : DRONE_PERCEPTION_RANGE) * perceptMul;
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
    /* Survey waypoints orbit the PLAYER, not the world origin — so as
     * the player roams across the 9×9 sector grid, drones don't all
     * try to fly back to (0,0,0). */
    const player = getPlayerPosition_ ? getPlayerPosition_() : null;
    const px = player ? player.x : 0;
    const pz = player ? player.z : 0;
    const r = THREE.MathUtils.randFloat(SPAWN_RADIUS_RANGE[0], SPAWN_RADIUS_RANGE[1]);
    const a = Math.random() * Math.PI * 2;
    const y = THREE.MathUtils.randFloat(SPAWN_HEIGHT_RANGE[0], SPAWN_HEIGHT_RANGE[1]);
    this.targetPos.set(px + Math.cos(a) * r, y, pz + Math.sin(a) * r);
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

  /* ── attack target: orbital flanking around the player ────────────── */

  pickAttackTarget(playerBody, dt) {
    /* Each drone holds its own orbit angle (around the player on the
     * horizontal plane) and direction. The angle drifts continuously
     * so the drone strafes around at standoff distance instead of just
     * hovering on the player's line of sight; combined with the
     * velocity-driven body banking, this produces lateral movement
     * the player has to track and gives every drone a distinct
     * approach angle. The direction flips occasionally and at random,
     * so the player can't rely on "they're always orbiting clockwise."
     *
     * Vertical movement: a per-drone sine bob on top of the standard
     * track-height offset, so the cluster of drones isn't all sitting
     * at exactly the same Y the whole fight. */
    const dx = this.group.position.x - playerBody.x;
    const dz = this.group.position.z - playerBody.z;
    const horizDist = Math.hypot(dx, dz);
    /* Continuously drift the orbit angle. We seed it from the drone's
     * actual current angle around the player so it transitions
     * smoothly when entering ATTACK from an arbitrary previous state. */
    if (horizDist > 0.5) {
      this.orbitAngle = Math.atan2(dx, dz);
    }
    this.orbitTimer -= dt;
    if (this.orbitTimer <= 0) {
      /* 30 % chance to flip orbit direction on each timer tick. */
      if (Math.random() < 0.3) this.orbitDir = -this.orbitDir;
      this.orbitTimer = THREE.MathUtils.randFloat(2.5, 5.5);
    }
    /* ~0.55 rad/s ≈ 31 °/s strafe — fast enough to read as motion,
     * slow enough that the player can still focus shots. */
    const newAngle = this.orbitAngle + this.orbitDir * 0.55 * dt;
    /* Standoff distance — push out if too close (flee zone). */
    const want = horizDist < DRONE_FLEE_NEAR
      ? DRONE_STANDOFF * 1.3
      : DRONE_STANDOFF;
    /* Per-drone altitude bob. */
    this.altPhase += dt * 0.6;
    const altWobble = Math.sin(this.altPhase) * 1.3;
    this.targetPos.set(
      playerBody.x + Math.sin(newAngle) * want,
      playerBody.y + TRACK_HEIGHT_OFFSET + altWobble,
      playerBody.z + Math.cos(newAngle) * want,
    );
  }

  /* ── shield drone targeting ────────────────────────────────────────
   * Tries to position itself near the centre of the densest cluster of
   * living allies (so the dome covers as many of them as possible).
   * Falls back to orbiting the player at long range if alone. */
  pickShieldAttackTarget(playerBody, dt) {
    /* Find centroid of living non-shield allies. */
    let cx = 0, cy = 0, cz = 0, n = 0;
    for (const o of drones_) {
      if (o === this || o.dead) continue;
      if (o.type === DRONE_TYPE_SHIELD) continue;
      cx += o.group.position.x;
      cy += o.group.position.y;
      cz += o.group.position.z;
      n++;
    }
    if (n > 0) {
      /* Hover slightly above the centroid so the dome covers the group. */
      this.targetPos.set(cx / n, cy / n + 1.5, cz / n);
    } else {
      /* No allies → orbit player at extra-long range. */
      this.pickAttackTarget(playerBody, dt);
      this.targetPos.y += 1.5;
    }
  }

  /* ── engineer drone targeting ──────────────────────────────────────
   * Locates the most damaged ally; locks repair beam onto them while
   * within range. If none are damaged or in range, dodges the player.
   *
   * Repair behaviour:
   *   - Beam visible while target is within `repairRange`.
   *   - Heals broken/intact components: shields → chips → rotors → body.
   *   - Resurrected components un-hide (`visible=true`) but don't
   *     re-attach if they fell off as debris (rotor blades, weapons).
   */
  tickEngineer(dt, playerBody) {
    const stats = this.stats;
    /* Pick the most damaged ally each frame (cheap — drones array is small). */
    let best = null;
    let bestDmg = 0;
    for (const o of drones_) {
      if (o === this || o.dead) continue;
      /* Sum hp deficit across all components. */
      let deficit = 0;
      for (const c of o.group.userData.components) {
        if (!c.userData?.maxHp) continue;
        const missing = c.userData.maxHp - c.userData.hp;
        if (missing > 0) deficit += missing;
        if (c.userData.broken) deficit += c.userData.maxHp;
      }
      if (deficit > bestDmg) {
        bestDmg = deficit;
        best = o;
      }
    }
    this.repairTarget = best;

    const beam = this.group.userData.repairBeam;
    let beaming = false;
    if (best) {
      const d = this.group.position.distanceTo(best.group.position);
      const repairRange = stats.repairRange || 14;
      /* Park near the target — keep just within range. */
      const want = Math.min(d, repairRange * 0.7);
      this._tmp.subVectors(this.group.position, best.group.position);
      if (this._tmp.lengthSq() > 0.001) this._tmp.normalize();
      else this._tmp.set(0, 0.3, 1);
      this.targetPos.copy(best.group.position).addScaledVector(this._tmp, want);
      this.targetPos.y = Math.max(this.targetPos.y, 4);
      const maxS = STEERING_MAX_SPEED * (stats.speedMul || 0.95) * this.powerFactor();
      this.applySteering(dt, maxS);

      if (d <= repairRange) {
        /* Apply repair this frame. */
        const heal = (stats.repairRate || 9) * dt;
        this._applyRepair(best, heal);
        beaming = true;
      }
    } else {
      /* No friend — back away from the player. */
      this._tmp.subVectors(this.group.position, playerBody);
      if (this._tmp.lengthSq() < 0.001) this._tmp.set(1, 0, 0);
      else this._tmp.normalize();
      this.targetPos.copy(this.group.position).addScaledVector(this._tmp, 12);
      this.targetPos.y = Math.max(this.group.position.y + 2, 12);
      this.applySteering(dt, STEERING_MAX_SPEED * (stats.speedMul || 0.95) * this.powerFactor());
    }

    /* Drive the beam visual. */
    if (beam) {
      this.repairBeamFade += beaming ? dt * 8 : -dt * 8;
      this.repairBeamFade = THREE.MathUtils.clamp(this.repairBeamFade, 0, 1);
      if (this.repairBeamFade > 0.01 && best) {
        beam.visible = true;
        beam.material.opacity = this.repairBeamFade * 0.85;
        const dish = this.group.userData.repairDish;
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        if (dish) dish.getWorldPosition(a);
        else this.group.getWorldPosition(a);
        best.group.getWorldPosition(b);
        const mid = a.clone().add(b).multiplyScalar(0.5);
        beam.position.copy(mid);
        const dir = b.clone().sub(a);
        const len = dir.length();
        if (len > 0.001) {
          dir.divideScalar(len);
          _tracerQuat.setFromUnitVectors(_tracerUp, dir);
          beam.quaternion.copy(_tracerQuat);
        }
        beam.scale.set(1, len, 1);
      } else {
        beam.visible = false;
      }
    }
  }

  _applyRepair(other, hp) {
    /* Priority order: emitter (shielders) > weapon > targeting > rotor
     * shield > rotor > body chip > body. We focus on the most-broken
     * component first, then bleed extra healing into the next priority
     * layer. */
    const order = ["emitter", "weapon", "targeting", "shield", "rotor", "chip", "body", "power"];
    let remaining = hp;
    for (const kind of order) {
      if (remaining <= 0) return;
      const comps = other.group.userData.components.filter((c) => c.userData?.kind === kind);
      for (const c of comps) {
        if (remaining <= 0) break;
        if (!c.userData.maxHp) continue;
        if (c.userData.broken) {
          /* Special case: rotor / weapon / pod / warhead / targeting that
           * detached as debris won't be re-attached visually. We still
           * mark them un-broken for HP tracking, but the player won't
           * see the rotor blade reappear (avoids ugly re-parenting). */
          if (kind === "rotor" || kind === "weapon" || kind === "pod"
              || kind === "warhead" || kind === "targeting") {
            continue;
          }
          /* Shields & chips re-appear (they were hidden, not detached). */
          c.visible = true;
          c.userData.broken = false;
          c.userData.hp = 1;
        }
        const missing = c.userData.maxHp - c.userData.hp;
        if (missing > 0) {
          const give = Math.min(missing, remaining);
          c.userData.hp += give;
          remaining -= give;
        }
      }
    }
  }

  /* ── tank: gatling burst fire ──────────────────────────────────────
   * Differs from `tryShoot` in three ways:
   *   - Burst pattern: fires `burstShots` rounds at `burstRate` interval
   *     per cooldown.
   *   - Per-shot weapon check: a broken gatling component stops fire
   *     mid-burst (find by kind="weapon" — the gatling assembly).
   *   - Each round spawns a standard ballistic projectile but with
   *     reduced damage (set on the projectile via spawnProjectileWith).
   *   - Spins the gatling hub while a burst is active (or coming up).
   */
  tryTankBurst(playerHead, dt) {
    const stats = this.stats;
    if (this.powerFactor() === 0) return;
    /* Spin the visible hub whenever we're aiming or firing. */
    const wpn = this.group.userData.findKind("weapon");
    const hub = wpn?.userData?.hub;
    /* Gatling barrel destroyed → can't fire, no spin. */
    if (wpn?.userData.broken) return;

    /* Aim gate, like tryShoot. */
    if (this.aimFocus < DRONE_AIM_FIRE_THRESHOLD * 0.7) {
      /* Spin the hub at low rate while charging up to a burst. */
      if (hub) hub.rotation.z = (hub.rotation.z || 0) + 6 * dt;
      return;
    }

    /* If not currently in a burst, see if we can start one. */
    if (this.burstShotsLeft <= 0) {
      this.fireCooldown -= dt;
      if (this.fireCooldown > 0) {
        if (hub) hub.rotation.z = (hub.rotation.z || 0) + 12 * dt;
        return;
      }
      /* Begin burst. */
      this.burstShotsLeft = stats.burstShots || 5;
      this.burstShotTimer = 0;
      this.fireCooldown = (stats.fireInterval || 1.0)
        * (0.85 + Math.random() * 0.3);
      this.aimFocus = DRONE_AIM_POST_FIRE;
    }

    /* Fast hub spin while bursting. */
    if (hub) hub.rotation.z = (hub.rotation.z || 0) + 30 * dt;

    /* Time-step burst: fire a round whenever the per-shot timer expires. */
    this.burstShotTimer -= dt;
    while (this.burstShotsLeft > 0 && this.burstShotTimer <= 0) {
      const turret = this.group.userData.turret;
      if (!turret) break;
      this._fwdLocal2 ||= new THREE.Vector3();
      this._fwdLocal2.set(0, 0, 0.40);
      turret.updateMatrixWorld(true);
      this._fwdLocal2.applyMatrix4(turret.matrixWorld);
      const muzzle = this._tmp2.copy(this._fwdLocal2);

      const dir = new THREE.Vector3().subVectors(playerHead, muzzle).normalize();
      const spreadDeg = (stats.burstSpread || 4.0)
        + (1 - this.targetingFactor()) * 8;
      const spread = (spreadDeg * Math.PI) / 180;
      dir.x += (Math.random() - 0.5) * spread;
      dir.y += (Math.random() - 0.5) * spread;
      dir.z += (Math.random() - 0.5) * spread;
      dir.normalize();

      spawnProjectileWith(muzzle, dir, stats.burstDamage || 6);
      playOneShotAt(audioBuffers_.botShot, muzzle, { volume: 0.55, refDistance: 5 });
      this.burstShotsLeft--;
      this.burstShotTimer += stats.burstRate || 0.10;
    }
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
    /* faceTarget is used by kamikaze (no turret, body must face player
     * for ramming + cone) — clear roll, body locked on. */
    this.aimRoll = 0;
  }

  /* ── faceVelocity: aircraft-style body orientation ─────────────────
   * Yaw aligns with horizontal velocity direction, pitch with vertical
   * climb/dive, roll banks proportionally to the rate of yaw change
   * (banking into turns). When velocity is below a threshold the drone
   * holds its current yaw and slowly levels out the roll, giving a
   * convincing "hovering, settling" look. Used by all variants except
   * kamikaze. The result is angles only — final rotation is composed
   * with the wobble overlay in update(). */
  faceVelocity(dt) {
    const v = this.velocity;
    const horizSpeed = Math.hypot(v.x, v.z);

    if (horizSpeed > 0.4) {
      const targetYaw = Math.atan2(v.x, v.z);
      let diff = targetYaw - this.aimYaw;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      const yawStep = diff * Math.min(1, 2.2 * dt);
      this.aimYaw += yawStep;

      /* Bank ∝ instantaneous yaw rate; YXZ Euler with a positive Z
       * rotation rolls the +Y axis toward +X (right wing down) — i.e.
       * banking right while turning right, the natural aircraft feel. */
      const yawRate = yawStep / Math.max(dt, 0.001);
      const bankTarget = THREE.MathUtils.clamp(yawRate * 0.28, -0.55, 0.55);
      this.aimRoll += (bankTarget - this.aimRoll) * Math.min(1, 4 * dt);
    } else {
      /* Hovering — roll levels out gradually. */
      this.aimRoll *= 1 - Math.min(1, 2 * dt);
    }

    /* Pitch follows climb/dive angle, clamped flatter than faceTarget
     * since "racing along velocity" shouldn't tilt the drone wildly. */
    const targetPitch = THREE.MathUtils.clamp(
      -Math.atan2(v.y, Math.max(0.5, horizSpeed)),
      -0.4, 0.4,
    );
    this.aimPitch += (targetPitch - this.aimPitch) * Math.min(1, 3 * dt);
  }

  /* ── aimTurret: lookAt-style world-space turret tracking ───────────
   * The turret group hangs as a child of the drone group, so its local
   * rotation lives in the drone's body frame. We compute the desired
   * WORLD orientation that points the turret's +Z at `target`, then
   * inverse-transform by the drone group's world quaternion to get the
   * required local quaternion. Slerping toward this each frame lets
   * the turret keep its weapon/cam fixed on the player while the body
   * banks and orbits independently.
   *
   * Slew rate is per-type so a sniper's long barrel visibly takes a
   * second or two to settle on you, while a standard drone snaps fast. */
  aimTurret(target, dt) {
    const turret = this.group.userData.turret;
    if (!turret) return;
    /* Turret world position. */
    this._turretWorld ||= new THREE.Vector3();
    turret.getWorldPosition(this._turretWorld);
    /* Forward direction (turret → target) in world space. */
    _aimFwd.subVectors(target, this._turretWorld);
    if (_aimFwd.lengthSq() < 1e-4) return;
    _aimFwd.normalize();
    /* Build orthonormal basis with world-up; if aiming nearly straight
     * up/down, fall back to drone's body-right to avoid the cross-
     * product collapsing to zero. */
    if (Math.abs(_aimFwd.y) > 0.985) {
      _aimRight.set(1, 0, 0);
    } else {
      _aimRight.crossVectors(_worldUp, _aimFwd).normalize();
    }
    _aimUp.crossVectors(_aimFwd, _aimRight);
    _aimMat.makeBasis(_aimRight, _aimUp, _aimFwd);
    _aimQuat.setFromRotationMatrix(_aimMat);
    /* Convert world-space rotation to local (relative to drone group). */
    this.group.getWorldQuaternion(_parentQuat).invert();
    _aimQuat.premultiply(_parentQuat);
    /* Slerp existing local rotation toward the desired one. */
    const slewRate = this.stats.turretSlewRate || 6;
    turret.quaternion.slerp(_aimQuat, Math.min(1, slewRate * dt));
  }

  /* When there's no specific aim target (SURVEY), let the turret return
   * to its neutral "look forward along body" identity rotation. */
  aimTurretNeutral(dt) {
    const turret = this.group.userData.turret;
    if (!turret) return;
    turret.quaternion.slerp(_IDENTITY_QUAT, Math.min(1, 1.5 * dt));
  }

  /* ── shooting ──────────────────────────────────────────────────────── */

  /* Type-aware shooting dispatcher. Kamikaze never fires; the other
   * three variants share the aim-gate / cone-narrow / cooldown logic
   * but spawn different projectiles via type-specific helpers below. */
  tryShoot(playerBody, dt) {
    if (this.type === DRONE_TYPE_KAMIKAZE) return;
    const power = this.powerFactor();
    if (power === 0) return;
    /* Per-type fire interval (sniper slow / missile slow / std fast).
     * Difficulty's `fireRateMul` rescales — easy is slower, insane faster. */
    const baseInterval = this.stats.fireInterval || DRONE_FIRE_INTERVAL_BASE;
    const interval = (baseInterval * (diffProfile_.fireRateMul ?? 1))
      / Math.max(0.5, power);
    this.fireCooldown -= dt;
    if (this.fireCooldown > 0) return;
    /* Aim gate: only fire when the cone has narrowed onto the player. */
    if (this.aimFocus < DRONE_AIM_FIRE_THRESHOLD) return;

    /* Sniper barrel disabled? Can't fire at all. */
    if (this.type === DRONE_TYPE_SNIPER) {
      const barrel = this.group.userData.findKind("weapon");
      if (barrel?.userData.broken) return;
    }
    /* Missile drone: at least one pod must remain. We pick whichever
     * pod is intact (alternating if both intact for a left/right rhythm). */
    let chosenPod = null;
    if (this.type === DRONE_TYPE_MISSILE) {
      const pods = this.group.userData.components.filter(
        (c) => c.userData?.kind === "pod" && !c.userData.broken,
      );
      if (pods.length === 0) return;
      this._missilePodToggle = !this._missilePodToggle;
      chosenPod = pods[this._missilePodToggle ? 0 : pods.length - 1];
    }

    const aim = this.targetingFactor();
    /* Sniper has very tight spread when scope intact (the whole point
     * of being a sniper); standard spread for everyone else. */
    const baseSpreadDeg = this.type === DRONE_TYPE_SNIPER ? 0.5 : 2.0;
    const spreadDeg = baseSpreadDeg + (1 - aim) * 12;

    /* Lead the player. Missile homes anyway, so it doesn't need lead. */
    const lead = this.type === DRONE_TYPE_MISSILE ? 0 : DRONE_FIRE_LEAD;
    const playerVel = getPlayerVelocity_?.();
    const aimAt = this._tmp.copy(playerBody);
    if (playerVel && lead > 0) aimAt.addScaledVector(playerVel, lead);

    /* Muzzle position depends on the variant. Sniper / standard fire
     * from the TURRET (which is what's actually aimed at the player —
     * the body is busy banking through its flight path). Missile pods
     * stay on the body, so missile launch position uses the chosen
     * pod's world transform. */
    const muzzle = this._tmp2;
    const turret = this.group.userData.turret;
    if (this.type === DRONE_TYPE_SNIPER && turret) {
      /* Tip of the barrel: turret-local (0, 0, 0.575). */
      this._fwdLocal2 ||= new THREE.Vector3();
      this._fwdLocal2.set(0, 0, 0.575);
      turret.updateMatrixWorld(true);
      this._fwdLocal2.applyMatrix4(turret.matrixWorld);
      muzzle.copy(this._fwdLocal2);
    } else if (this.type === DRONE_TYPE_MISSILE && chosenPod) {
      chosenPod.getWorldPosition(muzzle);
      /* Push slightly forward along the body forward (pod's local +Z)
       * so the missile spawns outside the pod tube. */
      this._fwdLocal2 ||= new THREE.Vector3();
      this._fwdLocal2.set(0, 0, 0.22).applyQuaternion(this.group.quaternion);
      muzzle.add(this._fwdLocal2);
    } else if (turret) {
      /* Standard / fallback — fire from the turret's world position. */
      turret.getWorldPosition(muzzle);
    } else {
      muzzle.copy(this.group.position);
      muzzle.y -= 0.05;
    }

    const dir = new THREE.Vector3().subVectors(aimAt, muzzle).normalize();
    /* Apply spread. */
    const spread = (spreadDeg * Math.PI) / 180;
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();

    /* Variant-specific projectile spawn. */
    if (this.type === DRONE_TYPE_SNIPER) {
      spawnSniperShot(muzzle, dir, this.stats);
      playOneShotAt(audioBuffers_.botShot, muzzle, { volume: 0.95, refDistance: 8 });
    } else if (this.type === DRONE_TYPE_MISSILE) {
      spawnMissile(muzzle, dir, this.stats);
      playOneShotAt(audioBuffers_.botShot, muzzle, { volume: 0.85, refDistance: 7 });
    } else {
      spawnProjectile(muzzle, dir);
      playOneShotAt(audioBuffers_.botShot, muzzle, { volume: 0.7, refDistance: 6 });
    }
    this.fireCooldown = interval * (0.85 + Math.random() * 0.3);
    /* Drop focus a bit so the next shot needs a brief re-aim — the cone
     * visibly widens then narrows again between shots. */
    this.aimFocus = DRONE_AIM_POST_FIRE;
  }

  /* Kamikaze: try to detonate when within the warhead's trigger range.
   * Returns true if it detonated this frame (caller short-circuits). */
  tryDetonate(playerBody) {
    if (this.type !== DRONE_TYPE_KAMIKAZE || this.dead) return false;
    const warhead = this.group.userData.findKind("warhead");
    if (!warhead || warhead.userData.broken) return false;
    const d2 = this.group.position.distanceToSquared(playerBody);
    const r = this.stats.detonateRange || 2.5;
    if (d2 < r * r) {
      damagePlayer(this.stats.detonateDamage || 50);
      playOneShotAt(audioBuffers_.explosion, this.group.position, {
        volume: 1.0, refDistance: 10,
      });
      /* Force-die: an extra-spectacular explosion via die(). */
      this.die();
      return true;
    }
    return false;
  }

  /* ── damage ────────────────────────────────────────────────────────── */

  takeDamage(component, dmg, hitDir, attackerWorld) {
    if (this.dead) return;

    /* Ally-shield protection: if this drone is inside any LIVING shielder's
     * dome AND that shielder's emitter is intact, the dome eats the hit.
     * The shielder itself is never protected by its own dome (must be
     * killable). */
    if (this.type !== DRONE_TYPE_SHIELD && _underAnyShieldDome(this)) {
      /* Visual feedback: pulse the dome the player tried to shoot
       * through, but no actual damage. */
      _pulseShieldDome(this.group.position);
      flashComponentHit(component);  // brief white flash so the player gets some feedback
      return;
    }

    /* Armour-redirect: a shot whose ray happens to thread through a
     * gap (e.g. clipped between adjacent chips at a corner, or the
     * blade tip outside the rotor shield's radius) should still be
     * absorbed by the intact armour layer — otherwise observant
     * players could exploit gaps to skip the shield→rotor / chip→body
     * progression. We re-route the hit to the relevant unbroken cover
     * piece if one is still standing. */
    if (component.userData.kind === "rotor"
        && component.userData.shield
        && !component.userData.shield.userData.broken) {
      component = component.userData.shield;
    } else if (component.userData.kind === "body") {
      const chips = this.group.userData.bodyChips;
      if (chips) {
        const intact = chips.find((ch) => !ch.userData.broken);
        if (intact) component = intact;
      }
    }

    /* Crit-zone multiplier: components with `userData.crit > 1` (the
     * power core, exposed body once chips fall off, the warhead) take
     * extra damage. This rewards the player for stripping armour and
     * then aiming for the now-exposed weak point. Also applied to the
     * difficulty's damage scaling — easy mode does less, insane more. */
    const crit = component.userData.crit || 1.0;
    const playerDmgMul = 1.0;          // (drones-vs-drones don't apply diff)
    const finalDmg = dmg * crit * playerDmgMul;
    component.userData.hp -= finalDmg;
    flashComponentHit(component);
    playOneShotAt(audioBuffers_.hit, this.group.position, { volume: 0.85, refDistance: 4 });

    /* Knock-back impulse along incoming ray direction. */
    this.velocity.addScaledVector(hitDir, dmg * 0.06);

    /* Hit-direction awareness: even drones that were looking the wrong
     * way "feel" where the hit came from. We update LKP to the attacker
     * position and snap (no smooth lerp) the relevant aim toward them.
     *
     *  - Non-kamikaze drones snap their TURRET (which carries the
     *    weapon/cam) so the player gets the "drone gimbals around to
     *    glare at you" feedback without the body locking flat.
     *  - Kamikaze has no turret — we snap the body itself, since the
     *    body is what aims the ram + cone. */
    if (attackerWorld) {
      this.lkp.copy(attackerWorld);
      this.haveLkp = true;
      if (this.type === DRONE_TYPE_KAMIKAZE) {
        this._tmp.subVectors(attackerWorld, this.group.position);
        const horizDist = Math.hypot(this._tmp.x, this._tmp.z);
        if (horizDist > 0.001 || Math.abs(this._tmp.y) > 0.001) {
          this.aimYaw = Math.atan2(this._tmp.x, this._tmp.z);
          this.aimPitch = THREE.MathUtils.clamp(
            -Math.atan2(this._tmp.y, Math.max(0.5, horizDist)),
            -1.0, 1.0,
          );
        }
      } else {
        /* dt=1 forces the slerp inside aimTurret to fully snap (since
         * Math.min(1, slewRate * 1) clamps to 1). */
        this.aimTurret(attackerWorld, 1.0);
      }
    }

    /* Hit cancels any aim-up: cone widens, drone has to re-acquire and
     * re-narrow before it can fire again. Even if the drone was already
     * in EVADE we restart `stateTime` and trigger a fresh wobble — so
     * sustained fire keeps interrupting the attack/aim cycle and the
     * player can pin a drone down by keeping pressure on it.
     *
     * KAMIKAZE EXCEPTION: a kamikaze evading on every hit is the worst
     * possible behaviour for the variant — they're meant to be
     * relentless rammers, and with the chip/shield armour layer they'd
     * absorb 8+ shots on the way in, each one bouncing them into a
     * perpendicular evade cycle that never lets them close. We let them
     * wobble (visual stagger) but keep them in ATTACK so they keep
     * pushing toward the player. Kinetic knock-back from `velocity`
     * still applies above, so a hit visibly shoves them off-line. */
    this.aimFocus = 0;
    this.wobbleTimer = DRONE_WOBBLE_DURATION;
    if (this.type !== DRONE_TYPE_KAMIKAZE) {
      this.state = "EVADE";
      this.stateTime = 0;
    }

    if (component.userData.hp <= 0 && !component.userData.broken) {
      this.breakComponent(component);
    }
  }

  breakComponent(c) {
    if (c.userData.broken) return;
    c.userData.broken = true;
    c.userData.hp = 0;
    /* Visual: kill emissive on broken accent / targeting / warhead. */
    if (c.material && c.material.emissive) {
      c.material = c.material.clone();
      c.material.emissive.setHex(0x000000);
      c.material.color.multiplyScalar(0.5);
      c.material.needsUpdate = true;
    }

    const kind = c.userData.kind;

    /* Shield: just hide it — next shot to that rotor goes through to
     * the rotor mast underneath. Spawn a debris piece so the player
     * sees the armour spall off. */
    if (kind === "shield") {
      c.visible = false;
      this._spawnComponentDebris(c);
      return;
    }

    /* Body chip: same idea — pop off and become debris, exposing the
     * body face behind. */
    if (kind === "chip") {
      c.visible = false;
      this._spawnComponentDebris(c);
      return;
    }

    /* Rotor: stop spinning, detach mesh from drone (so it's no longer
     * carried along), and convert it to falling debris with realistic
     * downward velocity. The drone now flies on 3 rotors (fewer rotors
     * = lower liftFactor — drone starts to sag). */
    if (kind === "rotor") {
      c.userData.spinning = false;
      if (c.userData.blade) {
        c.userData.blade.rotation.y = THREE.MathUtils.randFloat(0, Math.PI * 2);
      }
      /* Detach: copy world transform onto the mesh, reparent to scene,
       * then convert to debris (gravity + tumble). */
      this._detachAsDebris(c);
      return;
    }

    /* Emitter (shielder): hide the pillar AND the dome. The dome was
     * a child of the drone, so we walk userData.dome and toggle. */
    if (kind === "emitter") {
      c.visible = false;
      const dome = this.group.userData.dome;
      if (dome) dome.visible = false;
      this._spawnComponentDebris(c);
      return;
    }

    /* External mountable components — barrel, missile pod, warhead, the
     * targeting cam/scope, the tank gatling. All drop off as visible
     * falling debris so the player sees a chunk of the chassis literally
     * come away. The tank gatling is a Group, but `_detachAsDebris`
     * handles that fine — it just reparents whatever it gets. */
    if (kind === "weapon" || kind === "pod" || kind === "warhead" || kind === "targeting") {
      this._detachAsDebris(c);
      /* Kamikaze warhead loss → enter the RECHARGE cycle instead of
       * staying neutered. We also remove the broken warhead from the
       * components array so the next `findKind("warhead")` will return
       * the regrown replacement (added in `_regrowWarhead`). The
       * regrowth itself happens at the end of RECHARGE in update(). */
      if (kind === "warhead" && this.type === DRONE_TYPE_KAMIKAZE) {
        const idx = this.group.userData.components.indexOf(c);
        if (idx >= 0) this.group.userData.components.splice(idx, 1);
        this.state = "RECHARGE";
        this.stateTime = 0;
        this.rechargeTimer = KAMIKAZE_RECHARGE_S;
        /* Hit-direction-aware retreat: snapshot a flee anchor so we
         * commit to one direction rather than micro-corrected by every
         * subsequent shot. Rebuilt at end of recharge. */
        this._rechargeAnchor = null;
      }
      return;
    }

    /* Power core or main body broken — death. */
    if (kind === "power" || kind === "body") {
      this.die();
    }
  }

  /* Convert a still-attached component into a free-flying debris fragment
   * by re-parenting it from the drone group up to the scene, preserving
   * its world transform. Also pushes it into the debris_ list so the
   * existing physics tick (gravity + tumble + ttl) handles it. */
  _detachAsDebris(c) {
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const worldScl = new THREE.Vector3();
    c.matrixWorld.decompose(worldPos, worldQuat, worldScl);
    /* Cache parent relationship to remove cleanly. */
    if (c.parent) c.parent.remove(c);
    c.position.copy(worldPos);
    c.quaternion.copy(worldQuat);
    c.scale.copy(worldScl);
    scene_.add(c);
    debris_.push({
      mesh: c,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 2.0,
        Math.random() * 1.5 + 0.5,
        (Math.random() - 0.5) * 2.0,
      ),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
      ),
      ttl: 1.6,
    });
  }

  /* Regrow the kamikaze's warhead at the end of a RECHARGE cycle.
   * The original warhead detached as debris and was decoupled from
   * the components array, so we build a fresh one and snap it into
   * place. A brief hit-flash + scaling animation sells the moment
   * the bomb comes back online so the player feels the threat
   * returning. */
  _regrowWarhead() {
    const matWarhead = new THREE.MeshStandardMaterial({
      color: 0xff4422, emissive: 0xff2200, emissiveIntensity: 3.0,
      roughness: 0.3, metalness: 0.0,
    });
    const warhead = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 14, 10),
      matWarhead,
    );
    warhead.position.set(0, 0.16, 0);
    warhead.userData = {
      kind: "warhead", hp: 20, maxHp: 20, broken: false, crit: 2.0,
      /* Mark with a "regrowing" timer so update() can scale it in. */
      regrowTimer: 0.4,
    };
    /* Start tiny + scale up over `regrowTimer` so the player sees the
     * warhead visibly snap into place. */
    warhead.scale.setScalar(0.05);
    warhead.castShadow = true;
    this.group.add(warhead);
    this.group.userData.components.push(warhead);
    /* Brief white emissive flash on the new orb. */
    flashComponentHit(warhead);
    /* Audio cue — re-using the existing hit thunk works as a "click
     * online" sound; a future improvement could be a dedicated charge
     * buffer. */
    playOneShotAt(audioBuffers_.hit, this.group.position, {
      volume: 0.7, refDistance: 5,
    });
  }

  /* Spawn a clone of a component as debris (for shields / chips /
   * warhead / barrel — things we want to *visibly* break off but the
   * original mesh might be useful to keep zero-sized in place). */
  _spawnComponentDebris(c) {
    const frag = new THREE.Mesh(
      c.geometry,
      c.material.clone ? c.material.clone() : c.material,
    );
    c.getWorldPosition(_v0);
    frag.position.copy(_v0);
    c.getWorldQuaternion(_q0);
    frag.quaternion.copy(_q0);
    scene_.add(frag);
    debris_.push({
      mesh: frag,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 4,
        Math.random() * 2 + 0.5,
        (Math.random() - 0.5) * 4,
      ),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
      ),
      ttl: 1.4,
    });
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
    /* Engineer's repair beam lives in scene_ (not group_) so it isn't
     * removed by removing the drone group. Tear it down explicitly. */
    const beam = this.group.userData.repairBeam;
    if (beam) {
      scene_.remove(beam);
      beam.geometry?.dispose?.();
      beam.material?.dispose?.();
      this.group.userData.repairBeam = null;
    }
    playOneShotAt(audioBuffers_.explosion, this.group.position, { volume: 1.0, refDistance: 6 });
    /* Spawn debris from each component.
     *
     * NOTE: tank's gatling is a `THREE.Group` (with children) so it has
     * no `geometry` of its own. We can't clone() a Group geometry, but
     * we CAN reparent the actual node into the scene and let it tumble
     * as a unit. For Mesh components we still spawn a fresh
     * darkened-clone fragment so the original mesh can be cleanly
     * removed with the drone group below (avoids double-removal weirdness
     * when bodyChips were already detached / hidden). */
    for (const c of this.group.userData.components) {
      if (!c.geometry) {
        /* Group-typed component (e.g. tank gatling): reparent into scene
         * preserving world transform, then push as debris. */
        const wPos = new THREE.Vector3();
        const wQuat = new THREE.Quaternion();
        const wScl = new THREE.Vector3();
        c.matrixWorld.decompose(wPos, wQuat, wScl);
        if (c.parent) c.parent.remove(c);
        c.position.copy(wPos);
        c.quaternion.copy(wQuat);
        c.scale.copy(wScl);
        scene_.add(c);
        debris_.push({
          mesh: c,
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
        continue;
      }
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
    kills_++;
    if (kills_ > bestKills_) {
      bestKills_ = kills_;
      saveRecords();
    }
  }

  /* ── per-frame update ──────────────────────────────────────────────── */

  update(dt, playerHead, playerBody, playerSpeed) {
    if (this.dead) return;

    this.stateTime += dt;
    /* Spin rotors / pulse thrusters. The same `rotors` array holds
     * both — rotor-style props animate via blade-spin, thruster-style
     * props animate by modulating their exhaust emissive intensity.
     *
     * `rotorPhase` doubles as a shared time accumulator; thrusters
     * also bias their pulse rate by FSM state — louder/brighter when
     * aggressive, dim when surveying. Broken thrusters hard-cut to 0
     * emissive so they read as "burned out". */
    this.rotorPhase += dt * 40;
    const aggro = this.isAggressive();
    for (const r of this.group.userData.rotors) {
      if (r.userData.spinning && r.userData.blade) {
        r.userData.blade.rotation.y = this.rotorPhase + (r.userData.name === "FL" || r.userData.name === "BR" ? Math.PI / 2 : 0);
      }
      if (r.userData.isThruster && r.userData.exhaust) {
        const ex = r.userData.exhaust;
        if (r.userData.broken) {
          ex.material.emissiveIntensity = 0;
          ex.visible = false;
        } else {
          /* Sinusoidal flicker — base + amplitude scaled by aggression. */
          const base = aggro ? 3.0 : 1.6;
          const amp  = aggro ? 1.4 : 0.4;
          const hz   = aggro ? 12  : 5;
          ex.material.emissiveIntensity = base
            + Math.sin(this.rotorPhase * hz * 0.025) * amp;
          ex.visible = true;
        }
      }
    }

    /* Engineer: hide repair beam unless we're actively beaming. */
    if (this.type === DRONE_TYPE_ENGINEER && this.state !== "ATTACK") {
      const beam = this.group.userData.repairBeam;
      if (beam) beam.visible = false;
      this.repairBeamFade = 0;
    }

    /* Kamikaze warhead regrow animation. Each freshly regrown warhead
     * carries a `regrowTimer` in its userData; we scale it from ~0 → 1
     * over that span so the bomb visibly snaps into place rather than
     * popping in. */
    if (this.type === DRONE_TYPE_KAMIKAZE) {
      const wh = this.group.userData.findKind("warhead");
      if (wh && wh.userData.regrowTimer > 0) {
        wh.userData.regrowTimer -= dt;
        const k = 1 - Math.max(0, wh.userData.regrowTimer / 0.4);
        const s = THREE.MathUtils.lerp(0.05, 1.0, k);
        wh.scale.setScalar(s);
        if (wh.userData.regrowTimer <= 0) {
          wh.scale.setScalar(1);
          wh.userData.regrowTimer = 0;
        }
      }
    }

    /* Shielder: pulse the dome opacity each frame; pulse harder when a
     * shot was just absorbed (`domePulseTimer`). The dome visibility
     * mirrors the emitter component (broken → invisible). */
    if (this.type === DRONE_TYPE_SHIELD) {
      const dome = this.group.userData.dome;
      const emitter = this.group.userData.findKind("emitter");
      if (dome) {
        const live = emitter && !emitter.userData.broken;
        dome.visible = live;
        if (live) {
          this.domePulse += dt * 1.6;
          let opacity = 0.08 + 0.05 * Math.sin(this.domePulse);
          if (this.domePulseTimer > 0) {
            this.domePulseTimer -= dt;
            opacity += 0.25 * Math.max(0, this.domePulseTimer / 0.35);
          }
          dome.material.opacity = opacity;
        }
      }
    }

    /* Visual + audible alertness cue (LED + hum-buffer swap). */
    this.updateAlertnessAudio();

    const sees = this.perceives(playerHead, playerSpeed, dt);

    /* The FSM picks movement targets and decides whether to fire, but
     * doesn't set body rotation — that's now done after the switch by
     * faceVelocity (banking flight) or, for kamikaze, faceTarget. We
     * also pick the turret aim target here so the gimbal can keep the
     * weapon/cam fixed on the player while the body flies its own
     * dynamic flight path. */
    let turretTarget = null;
    const isKamikaze = this.type === DRONE_TYPE_KAMIKAZE;

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
        /* turretTarget stays null → turret returns to neutral. */
        break;
      }

      case "ALERT": {
        /* Pause + lock turret onto the player while the targeting
         * camera "acquires" — body holds its current orientation. */
        this.applySteering(dt, STEERING_MAX_SPEED * 0.3);
        turretTarget = playerHead;
        if (this.stateTime > DRONE_ALERT_DURATION) {
          this.state = sees ? "ATTACK" : "INVESTIGATE";
          this.stateTime = 0;
        }
        break;
      }

      case "ATTACK": {
        const dist = this.group.position.distanceTo(playerBody);
        const isShield = this.type === DRONE_TYPE_SHIELD;
        const isEngineer = this.type === DRONE_TYPE_ENGINEER;

        if (isKamikaze) {
          /* Rush directly at the player rather than holding standoff.
           * Movement target == player head, no firing. Every frame we
           * also test the detonation range; on a successful detonate
           * tryDetonate() calls die() so we short-circuit here. */
          this.targetPos.copy(playerHead);
          const maxK = STEERING_MAX_ATTACK_SPEED
            * (this.stats.speedMul || 1.0) * this.powerFactor();
          this.applySteering(dt, maxK);
          if (this.tryDetonate(playerBody)) break;
          turretTarget = playerHead;
        } else if (isShield) {
          /* Shielders don't engage. They orbit the densest cluster of
           * allies (or the player at long range if alone) and keep the
           * dome up. Slow, deliberate, hard to dislodge. */
          this.pickShieldAttackTarget(playerBody, dt);
          const maxS = STEERING_MAX_SPEED
            * (this.stats.speedMul || 0.7) * this.powerFactor();
          this.applySteering(dt, maxS);
          turretTarget = playerHead;
        } else if (isEngineer) {
          /* Engineer searches for the most damaged ally and parks in
           * repair range. If no damaged ally exists, flees from the
           * player (still avoids combat). */
          this.tickEngineer(dt, playerBody);
          turretTarget = this.repairTarget?.group.position || playerHead;
        } else {
          /* Orbital flanking around the player — see pickAttackTarget. */
          this.pickAttackTarget(playerBody, dt);
          const maxS = STEERING_MAX_ATTACK_SPEED
            * (this.stats.speedMul || 1.0) * this.powerFactor();
          this.applySteering(dt, maxS);
          /* Engage out to DRONE_FIRE_RANGE (≈ 52 m), scaled per-type. */
          const fireRange = DRONE_FIRE_RANGE * (this.stats.fireRangeMul ?? 1);
          if (sees && dist < fireRange) {
            if (this.type === DRONE_TYPE_TANK) this.tryTankBurst(playerHead, dt);
            else this.tryShoot(playerHead, dt);
          }
          turretTarget = playerHead;
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
        turretTarget = this.haveLkp ? this.lkp : null;
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
        turretTarget = playerHead;
        if (this.stateTime > DRONE_EVADE_DURATION) {
          this.state = sees ? "ATTACK" : "INVESTIGATE";
          this.stateTime = 0;
        }
        break;
      }

      case "RECHARGE": {
        /* Kamikaze's warhead regrows over KAMIKAZE_RECHARGE_S. While
         * recharging the drone flees the player at high altitude and
         * doesn't try to ram or fire. Once recharged we hand control
         * back to INVESTIGATE (chases LKP) — or SURVEY if no LKP.
         *
         * `_rechargeAnchor` is committed once and reused so the drone
         * doesn't dither between several flee headings. */
        this.rechargeTimer -= dt;
        if (!this._rechargeAnchor) {
          /* Pick a flee point: away from the player, up high, jittered
           * a bit so multiple kamikazes don't stack at the same spot. */
          this._tmp.subVectors(this.group.position, playerHead);
          this._tmp.y = 0;
          if (this._tmp.lengthSq() < 0.001) this._tmp.set(1, 0, 0);
          this._tmp.normalize();
          this._rechargeAnchor = new THREE.Vector3()
            .copy(playerHead)
            .addScaledVector(this._tmp, KAMIKAZE_RECHARGE_FLEE_DIST)
            .add(new THREE.Vector3(
              (Math.random() - 0.5) * 6,
              0,
              (Math.random() - 0.5) * 6,
            ));
          this._rechargeAnchor.y = Math.max(playerHead.y + 8, 14);
        }
        this.targetPos.copy(this._rechargeAnchor);
        const maxR = STEERING_MAX_SPEED
          * (this.stats.speedMul || 1.6) * this.powerFactor();
        this.applySteering(dt, maxR);
        /* Body still tracks the player vaguely so it looks watchful
         * rather than panicked, but no turret aim (kamikaze has no
         * turret anyway). */
        turretTarget = null;
        if (this.rechargeTimer <= 0) {
          this._regrowWarhead();
          this._rechargeAnchor = null;
          /* Resume hostilities. If we have a fresh LKP, hunt to it;
           * else look around. */
          this.state = this.haveLkp ? "INVESTIGATE" : "SURVEY";
          this.stateTime = 0;
          if (this.state === "SURVEY") this.pickSurveyTarget();
        }
        break;
      }
    }

    /* ── Body aim ────────────────────────────────────────────────────
     * Compute body angles (aimYaw / aimPitch / aimRoll). Kamikaze
     * locks body to the player (no turret, has to ram). Everyone
     * else flies along their velocity, banking into turns — giving
     * the player a much more dynamic silhouette / angle of attack to
     * read. The actual rotation is APPLIED below, after the cone /
     * focus block, in the wobble-composition step. We do this in two
     * stages so the turret aim (which depends on the body's final
     * world rotation including wobble) sees fresh values. */
    if (isKamikaze) {
      this.faceTarget(turretTarget || playerHead, dt);
    } else {
      this.faceVelocity(dt);
    }
    /* Turret aim is deferred to the very end of update(), after the
     * body rotation (yaw + pitch + roll + wobble) has been written
     * onto group.rotation — see below. */
    this._turretTargetThisFrame = turretTarget;

    /* ── Aim focus + visible cone scaling ─────────────────────────────
     * Focus only grows in steady ATTACK with LOS and no active wobble.
     * Wobble (post-hit recoil) holds focus at 0 — so the player can
     * keep a drone "stunned" by landing repeated hits.
     *
     * Per-type aim time multiplier: snipers ramp slowly (visible long
     * lock-on), kamikazes ramp quickly (they don't really "aim" but
     * the cone still narrows toward you while approaching). */
    const focusing =
      this.state === "ATTACK" && sees && this.wobbleTimer <= 0 && !this.dead;
    const aimTime = DRONE_AIM_TIME * (this.stats.aimTimeMul || 1);
    if (focusing) {
      this.aimFocus = Math.min(
        1,
        this.aimFocus + (dt / Math.max(0.1, aimTime)) * this.targetingFactor(),
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

    /* ── Compose final body rotation ─────────────────────────────────
     * We deliberately compose yaw + pitch + roll in one go (rather
     * than letting the FSM and wobble overwrite each other's rotation
     * slot). Wobble adds a brief knock-off-balance roll oscillation on
     * top of whatever bank faceVelocity already produced — so a hit
     * during a banked turn rocks visibly, then settles back into the
     * banked pose rather than snapping flat. */
    let roll = this.aimRoll;
    if (this.wobbleTimer > 0) {
      this.wobbleTimer -= dt;
      const env = Math.max(0, this.wobbleTimer / DRONE_WOBBLE_DURATION);
      const phase = (DRONE_WOBBLE_DURATION - this.wobbleTimer) * 22;
      roll += Math.sin(phase) * 0.45 * env;
    }
    this.group.rotation.set(this.aimPitch, this.aimYaw, roll, "YXZ");

    /* ── Turret aim (after body rotation is final) ──────────────────
     * Done LAST so the parent quaternion read inside aimTurret reflects
     * this frame's body rotation (including wobble). That way the
     * turret correctly compensates for body bank + wobble and the
     * player perceives the turret as smoothly tracking them while the
     * body careens around it. Kamikaze has no turret. */
    if (!isKamikaze) {
      if (this._turretTargetThisFrame) this.aimTurret(this._turretTargetThisFrame, dt);
      else this.aimTurretNeutral(dt);
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
    kind: "ballistic",
    mesh: m,
    velocity: dir.clone().multiplyScalar(DRONE_PROJECTILE_SPEED),
    damage: DRONE_PROJECTILE_DAMAGE,
    ttl: DRONE_PROJECTILE_TTL,
  });
}

/** Variant: explicit damage value (used by tank gatling for low-DPS rounds). */
function spawnProjectileWith(origin, dir, damage) {
  const m = new THREE.Mesh(getProjectileGeo(), getProjectileMat());
  m.position.copy(origin);
  scene_.add(m);
  projectiles_.push({
    kind: "ballistic",
    mesh: m,
    velocity: dir.clone().multiplyScalar(DRONE_PROJECTILE_SPEED),
    damage: damage ?? DRONE_PROJECTILE_DAMAGE,
    ttl: DRONE_PROJECTILE_TTL,
  });
}

/* Sniper "shot" — visually a thin glowing red cylinder tracer that
 * exists for one frame at full length, so the player perceives it as a
 * near-instant beam. For collision we step it in fine substeps along
 * the same path so it can't tunnel through the player or walls. */
let sniperMat_ = null;
function getSniperMat() {
  if (!sniperMat_) sniperMat_ = new THREE.MeshBasicMaterial({
    color: 0xff5544,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  return sniperMat_;
}
function spawnSniperShot(origin, dir, stats) {
  const speed = stats?.sniperProjectileSpeed || 70;
  const damage = stats?.sniperDamage || 36;
  /* Use a thin cylinder that we'll position/scale per frame to look
   * like a continuous beam — the projectile entry tracks position
   * via mesh.position (start of the beam), and we update the visual
   * each tick from the velocity. */
  const length = 1.6;
  const geom = new THREE.CylinderGeometry(0.04, 0.04, length, 10, 1);
  const mesh = new THREE.Mesh(geom, getSniperMat().clone());
  mesh.renderOrder = 9000;
  /* Orient the cylinder along `dir`. */
  _tracerQuat.setFromUnitVectors(_tracerUp, dir);
  mesh.quaternion.copy(_tracerQuat);
  mesh.position.copy(origin).addScaledVector(dir, length / 2);
  scene_.add(mesh);
  projectiles_.push({
    kind: "sniper",
    mesh,
    velocity: dir.clone().multiplyScalar(speed),
    damage,
    ttl: 1.0,            // total flight time cap (covers ~70 m at 70 m/s)
    visualLength: length,
    /* Tracer-style fade so a stale beam doesn't linger if it misses. */
    fadeFrom: 0.95,
  });
}

/* Homing missile — slow projectile that turns toward the player. */
let missileGeo_ = null;
let missileMat_ = null;
function getMissileGeo() {
  if (!missileGeo_) {
    /* Cylinder default axis is +Y, which we treat as the missile's
     * forward axis everywhere (matches `_tracerUp`). No pre-rotation
     * — the per-instance quaternion handles steering. */
    missileGeo_ = new THREE.CylinderGeometry(0.07, 0.07, 0.30, 12);
  }
  return missileGeo_;
}
function getMissileMat() {
  if (!missileMat_) missileMat_ = new THREE.MeshStandardMaterial({
    color: 0xff7722, emissive: 0xff5500, emissiveIntensity: 2.6,
    roughness: 0.4, metalness: 0.3, toneMapped: true,
  });
  return missileMat_;
}
function spawnMissile(origin, dir, stats) {
  const speed = stats?.missileSpeed || 9;
  const turnRate = stats?.missileTurnRate || 1.6;
  const damage = stats?.missileDamage || 18;
  const ttl = stats?.missileTtl || 6;
  const m = new THREE.Mesh(getMissileGeo(), getMissileMat());
  m.position.copy(origin);
  /* Mesh +Y = forward, aligned to launch dir. */
  _tracerQuat.setFromUnitVectors(_tracerUp, dir);
  m.quaternion.copy(_tracerQuat);
  scene_.add(m);
  projectiles_.push({
    kind: "missile",
    mesh: m,
    velocity: dir.clone().multiplyScalar(speed),
    damage,
    speed,
    turnRate,
    ttl,
  });
}

const _missileSteer = new THREE.Vector3();
const _missileNorm  = new THREE.Vector3();

/* Scratch vectors for aimTurret / faceVelocity work — these are touched
 * once per drone per frame inside the update loop, not from any nested
 * function, so reuse is safe. */
const _aimFwd      = new THREE.Vector3();
const _aimRight    = new THREE.Vector3();
const _aimUp       = new THREE.Vector3();
const _aimMat      = new THREE.Matrix4();
const _aimQuat     = new THREE.Quaternion();
const _parentQuat  = new THREE.Quaternion();
const _worldUp     = new THREE.Vector3(0, 1, 0);
const _IDENTITY_QUAT = new THREE.Quaternion();

function updateProjectiles(dt, playerHead) {
  for (let i = projectiles_.length - 1; i >= 0; i--) {
    const p = projectiles_[i];
    p.ttl -= dt;
    let hit = false;

    if (p.kind === "missile") {
      /* Steer velocity toward the player at up to `turnRate` rad/s.
       * We do this by rotating velocity vector toward (player - pos)
       * each frame — simple proportional navigation that feels right
       * without needing a full PID. */
      _missileSteer.copy(playerHead).sub(p.mesh.position);
      const dToTarget = _missileSteer.length();
      if (dToTarget > 0.001) _missileSteer.divideScalar(dToTarget);
      /* Lerp the velocity direction toward steer by turnRate*dt. */
      const v = p.velocity;
      const speedNow = v.length() || p.speed;
      if (speedNow > 0.001) {
        v.divideScalar(speedNow);
        const angle = v.angleTo(_missileSteer);
        const maxStep = p.turnRate * dt;
        const t = Math.min(1, angle > 0 ? maxStep / angle : 1);
        v.lerp(_missileSteer, t).normalize().multiplyScalar(speedNow);
      }
      /* Orient mesh along the (post-lerp) velocity so the visible body
       * always points where the missile is actually flying. */
      const vLen = v.length();
      if (vLen > 0.001) {
        _missileNorm.copy(v).divideScalar(vLen);
        _tracerQuat.setFromUnitVectors(_tracerUp, _missileNorm);
        p.mesh.quaternion.copy(_tracerQuat);
      }
      /* Step + collision. */
      const stepCount = 3;
      for (let s = 0; s < stepCount && !hit; s++) {
        p.mesh.position.addScaledVector(v, dt / stepCount);
        if (pointInsideAnyOBB(p.mesh.position, 0.07)) hit = true;
        if (!hit) {
          const d2 = p.mesh.position.distanceToSquared(playerHead);
          if (d2 < (PLAYER_HIT_RADIUS + 0.18) ** 2) {
            damagePlayer(p.damage);
            hit = true;
          }
        }
      }
      if (hit) {
        playOneShotAt(audioBuffers_.explosion, p.mesh.position, {
          volume: 0.7, refDistance: 6,
        });
      }
    } else if (p.kind === "sniper") {
      /* Sniper shot: long fast travel with many substeps for hit
       * precision. Visual cylinder slides along the path. */
      const stepCount = 8;
      for (let s = 0; s < stepCount && !hit; s++) {
        p.mesh.position.addScaledVector(p.velocity, dt / stepCount);
        if (pointInsideAnyOBB(p.mesh.position, 0.05)) hit = true;
        if (!hit) {
          const d2 = p.mesh.position.distanceToSquared(playerHead);
          if (d2 < (PLAYER_HIT_RADIUS + 0.18) ** 2) {
            damagePlayer(p.damage);
            hit = true;
          }
        }
      }
      /* Fade the visual a little each frame — once ttl < 0 or a hit
       * occurs we remove it. */
      if (p.mesh.material) {
        p.mesh.material.opacity = Math.max(0, p.ttl) * 0.95;
      }
    } else {
      /* Standard ballistic. */
      const stepCount = 2;
      for (let s = 0; s < stepCount && !hit; s++) {
        p.mesh.position.addScaledVector(p.velocity, dt / stepCount);
        if (pointInsideAnyOBB(p.mesh.position, 0.05)) hit = true;
        if (!hit) {
          const d2 = p.mesh.position.distanceToSquared(playerHead);
          if (d2 < (PLAYER_HIT_RADIUS + DRONE_PROJECTILE_RADIUS) ** 2) {
            damagePlayer(p.damage);
            hit = true;
          }
        }
      }
    }

    if (hit || p.ttl <= 0) {
      scene_.remove(p.mesh);
      if (p.kind === "sniper" && p.mesh.material) p.mesh.material.dispose();
      projectiles_.splice(i, 1);
    }
  }
}

/* ── Grenades ─────────────────────────────────────────────────────────
 * Player throws grenades from the left hand (left trigger in VR, 'G' on
 * desktop). Throw velocity comes from the recent hand motion (averaged
 * over a short history, like the locomotion grab) when in VR; on
 * desktop we fall back to camera-forward at a fixed speed.
 *
 * Grenades arc under gravity, bounce off OBB walls (with damping), and
 * detonate on direct contact with a drone or after a fuse timer. AOE
 * damage falls off linearly with distance from the blast centre, capped
 * at GRENADE_BLAST_DAMAGE at the centre and 0 at GRENADE_BLAST_RADIUS.
 *
 * Each grenade is its own scene mesh — a small dark-grey sphere with a
 * red emissive band (the fuse). On detonation we splash a brief
 * scaling sphere as visual feedback.
 */
let grenadeGeo_ = null;
let grenadeMat_ = null;
function getGrenadeGeo() {
  if (!grenadeGeo_) grenadeGeo_ = new THREE.SphereGeometry(0.10, 14, 10);
  return grenadeGeo_;
}
function getGrenadeMat() {
  if (!grenadeMat_) grenadeMat_ = new THREE.MeshStandardMaterial({
    color: 0x222226, emissive: 0xff3322, emissiveIntensity: 1.5,
    roughness: 0.5, metalness: 0.6,
  });
  return grenadeMat_;
}

/* Track left-hand position history so we can derive throw velocity.
 * Updated every frame in updateGrenades(). */
const _leftHandHistory = [];
const _leftHandTmpPos = new THREE.Vector3();
const _leftHandPrevPos = new THREE.Vector3();
let _leftHandHistoryReady = false;

function _getLeftControllerWorldPos(out) {
  if (!renderer_.xr.isPresenting) return false;
  const session = renderer_.xr.getSession();
  if (!session) return false;
  /* Try tagged controllers first. */
  for (let i = 0; i < 4; i++) {
    const ctrl = renderer_.xr.getController(i);
    if (ctrl?.userData?.handedness !== "left") continue;
    ctrl.updateMatrixWorld(true);
    ctrl.getWorldPosition(out);
    return true;
  }
  /* Fallback by inputSources order. */
  let idx = 0;
  for (const src of session.inputSources) {
    if (src?.handedness === "left") {
      const ctrl = renderer_.xr.getController(idx);
      if (ctrl) {
        ctrl.updateMatrixWorld(true);
        ctrl.getWorldPosition(out);
        return true;
      }
    }
    idx++;
  }
  return false;
}

function _averageLeftHandVelocity(out) {
  if (_leftHandHistory.length < 2) {
    out.set(0, 0, 0);
    return out;
  }
  /* Use last ~120 ms of motion. The history stores {pos, t}. */
  const newest = _leftHandHistory[_leftHandHistory.length - 1];
  let oldest = newest;
  for (let i = _leftHandHistory.length - 1; i >= 0; i--) {
    if (newest.t - _leftHandHistory[i].t > 0.12) {
      oldest = _leftHandHistory[i];
      break;
    }
    oldest = _leftHandHistory[i];
  }
  const dt = newest.t - oldest.t;
  if (dt < 0.001) {
    out.set(0, 0, 0);
    return out;
  }
  out.subVectors(newest.pos, oldest.pos).divideScalar(dt);
  return out;
}

/** Read the left controller's world origin + forward direction (-Z).
 *  Returns false if not in XR or no left controller is connected. */
function _getLeftControllerAim(outPos, outDir) {
  if (!renderer_.xr.isPresenting) return false;
  const session = renderer_.xr.getSession();
  if (!session) return false;
  /* Tagged controllers first. */
  for (let i = 0; i < 4; i++) {
    const ctrl = renderer_.xr.getController(i);
    if (ctrl?.userData?.handedness !== "left") continue;
    ctrl.updateMatrixWorld(true);
    ctrl.getWorldPosition(outPos);
    ctrl.getWorldQuaternion(_grenadeAimQuat);
    outDir.set(0, 0, -1).applyQuaternion(_grenadeAimQuat);
    return true;
  }
  /* Fallback by inputSources order. */
  let idx = 0;
  for (const src of session.inputSources) {
    if (src?.handedness === "left") {
      const ctrl = renderer_.xr.getController(idx);
      if (ctrl) {
        ctrl.updateMatrixWorld(true);
        ctrl.getWorldPosition(outPos);
        ctrl.getWorldQuaternion(_grenadeAimQuat);
        outDir.set(0, 0, -1).applyQuaternion(_grenadeAimQuat);
        return true;
      }
    }
    idx++;
  }
  return false;
}

/** Lazily build the trajectory preview meshes (dots + impact ring). */
function _ensureGrenadeAimVisuals() {
  if (grenadeAimDots_) return;
  const dotGeo = new THREE.SphereGeometry(0.045, 8, 6);
  const dotMat = new THREE.MeshBasicMaterial({
    color: 0x66ccff, transparent: true, opacity: 0.95,
    depthTest: false, depthWrite: false,
  });
  grenadeAimDots_ = new THREE.InstancedMesh(dotGeo, dotMat, GRENADE_TRAJ_SAMPLES);
  grenadeAimDots_.frustumCulled = false;
  grenadeAimDots_.renderOrder = 999;
  grenadeAimDots_.visible = false;
  /* Initialise all instances to a hidden zero-scale matrix. */
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < GRENADE_TRAJ_SAMPLES; i++) {
    grenadeAimDots_.setMatrixAt(i, zero);
  }
  scene_.add(grenadeAimDots_);

  const ringGeo = new THREE.TorusGeometry(0.35, 0.04, 6, 24);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xffaa33, transparent: true, opacity: 0.85,
    depthTest: false, depthWrite: false,
  });
  grenadeAimImpact_ = new THREE.Mesh(ringGeo, ringMat);
  grenadeAimImpact_.frustumCulled = false;
  grenadeAimImpact_.renderOrder = 999;
  grenadeAimImpact_.visible = false;
  scene_.add(grenadeAimImpact_);
}

/** Get the current (or just-released) throw speed based on charge. */
function _grenadeChargeSpeed() {
  const k = Math.min(1, grenadeChargeT_ / GRENADE_CHARGE_TIME);
  return GRENADE_MIN_SPEED + (GRENADE_MAX_SPEED - GRENADE_MIN_SPEED) * k;
}

/** Build the throw origin + initial velocity for the current frame.
 *  VR uses left-controller orientation; desktop uses camera. The same
 *  function is used for both the preview arc AND the actual throw, so
 *  what you see is exactly what you get. Returns false if no aim
 *  source is available. */
function _computeGrenadeAim(outPos, outVel) {
  if (renderer_.xr.isPresenting && _getLeftControllerAim(outPos, _grenadeAimDir)) {
    /* Already-normalised controller forward. */
  } else if (!renderer_.xr.isPresenting) {
    camera_.getWorldPosition(outPos);
    camera_.getWorldDirection(_grenadeAimDir);
  } else {
    return false;
  }
  /* No artificial upward tilt: the live preview shows exactly where
   * the grenade will land, so the player aims with their controller
   * pose. Tilt the wrist up to lob over cover, point flat to skip a
   * roller along the floor — what you see is what you throw. */
  _grenadeAimDir.normalize();
  outVel.copy(_grenadeAimDir).multiplyScalar(_grenadeChargeSpeed());
  return true;
}

/** Simulate the grenade arc forward and update preview dots + impact
 *  ring. Stops early on collision-box intersection. */
function _updateGrenadeAimPreview() {
  _ensureGrenadeAimVisuals();
  if (!_computeGrenadeAim(_grenadeAimPos, _grenadeAimVel)) {
    grenadeAimDots_.visible = false;
    grenadeAimImpact_.visible = false;
    return;
  }
  grenadeAimDots_.visible = true;

  /* Charge factor → colour ramp: cyan → yellow → red. */
  const k = Math.min(1, grenadeChargeT_ / GRENADE_CHARGE_TIME);
  const r = THREE.MathUtils.lerp(0.4, 1.0, k);
  const g = THREE.MathUtils.lerp(0.8, 0.4, k);
  const b = THREE.MathUtils.lerp(1.0, 0.2, k);
  grenadeAimDots_.material.color.setRGB(r, g, b);
  grenadeAimImpact_.material.color.setRGB(r, g, b);

  _grenadeAimSimPos.copy(_grenadeAimPos);
  _grenadeAimSimVel.copy(_grenadeAimVel);
  let impactPos = null;
  /* Forward Euler with gravity, plus a coarse "did I hit a wall yet?"
   * check using existing collision boxes. We only stop on the FIRST
   * intersection — bounces aren't previewed (and never will be exactly
   * predictable thanks to BOUNCE_DAMP, so previewing them would lie). */
  const hideMat = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < GRENADE_TRAJ_SAMPLES; i++) {
    if (impactPos) {
      grenadeAimDots_.setMatrixAt(i, hideMat);
      continue;
    }
    /* Place a dot at the current sample position. Scale grows with
     * charge so high-power throws look more "loaded". */
    const dotScale = 1 + 0.5 * k;
    _grenadeAimDotMat.makeTranslation(
      _grenadeAimSimPos.x, _grenadeAimSimPos.y, _grenadeAimSimPos.z,
    );
    if (dotScale !== 1) {
      _grenadeAimDotMat.elements[0] *= dotScale;
      _grenadeAimDotMat.elements[5] *= dotScale;
      _grenadeAimDotMat.elements[10] *= dotScale;
    }
    grenadeAimDots_.setMatrixAt(i, _grenadeAimDotMat);

    /* Step forward. */
    const prevX = _grenadeAimSimPos.x;
    const prevY = _grenadeAimSimPos.y;
    const prevZ = _grenadeAimSimPos.z;
    _grenadeAimSimVel.y -= GRENADE_GRAVITY * GRENADE_TRAJ_DT;
    _grenadeAimSimPos.addScaledVector(_grenadeAimSimVel, GRENADE_TRAJ_DT);

    /* Ground hit. */
    if (_grenadeAimSimPos.y <= 0.05 && prevY > 0.05) {
      const t = (prevY - 0.05) / (prevY - _grenadeAimSimPos.y);
      impactPos = new THREE.Vector3(
        prevX + (_grenadeAimSimPos.x - prevX) * t,
        0.05,
        prevZ + (_grenadeAimSimPos.z - prevZ) * t,
      );
    } else {
      /* OBB containment check against world collision boxes. Same
       * shape / transform the player's locomotion uses — so what the
       * arc says it'll hit is what the actual grenade will collide
       * with. */
      const boxes = getCollisionBoxes_();
      for (const b of boxes) {
        if (_pointInsideOBB(b, _grenadeAimSimPos)) {
          impactPos = new THREE.Vector3(prevX, prevY, prevZ);
          break;
        }
      }
    }
  }
  grenadeAimDots_.instanceMatrix.needsUpdate = true;

  if (impactPos) {
    grenadeAimImpact_.visible = true;
    grenadeAimImpact_.position.copy(impactPos);
    /* Lay flat on (approximately) the ground / surface. */
    grenadeAimImpact_.rotation.set(-Math.PI / 2, 0, 0);
    /* Pulse with charge. */
    const s = 0.7 + 0.5 * k;
    grenadeAimImpact_.scale.setScalar(s);
  } else {
    grenadeAimImpact_.visible = false;
  }
}

const _grenadeAimLocalPt = new THREE.Vector3();
/** OBB containment for collisionBoxes shape: { cx, cy, cz, hx, hy, hz, m, mInv }. */
function _pointInsideOBB(b, p) {
  _grenadeAimLocalPt.set(p.x - b.cx, p.y - b.cy, p.z - b.cz).applyMatrix3(b.mInv);
  return Math.abs(_grenadeAimLocalPt.x) <= b.hx
      && Math.abs(_grenadeAimLocalPt.y) <= b.hy
      && Math.abs(_grenadeAimLocalPt.z) <= b.hz;
}

function _hideGrenadeAimVisuals() {
  if (grenadeAimDots_) grenadeAimDots_.visible = false;
  if (grenadeAimImpact_) grenadeAimImpact_.visible = false;
}

/** Trigger pressed — enter aim mode. */
function startGrenadeAim() {
  if (grenadeStock_ <= 0) return;
  if (playerDead()) return;
  if (!enabled_) return;
  grenadeAiming_ = true;
  grenadeChargeT_ = 0;
  /* Start preview so the player sees their initial aim line on the
   * very first frame. */
  _updateGrenadeAimPreview();
}

/** Trigger held — advance charge timer + redraw arc. */
function tickGrenadeAim(dt) {
  if (!grenadeAiming_) return;
  /* Cancel aim cleanly if combat got disabled or the player died. */
  if (!enabled_ || playerDead()) {
    cancelGrenadeAim();
    return;
  }
  grenadeChargeT_ = Math.min(GRENADE_CHARGE_TIME, grenadeChargeT_ + dt);
  _updateGrenadeAimPreview();
}

/** Trigger released — actually throw the grenade along the previewed
 *  trajectory. Speed = current charge level. */
function releaseGrenadeAim() {
  if (!grenadeAiming_) return;
  grenadeAiming_ = false;
  _hideGrenadeAimVisuals();
  /* Re-compute aim at release time (final controller pose) so a
   * last-second flick still aims true. */
  if (grenadeStock_ <= 0 || playerDead()) {
    grenadeChargeT_ = 0;
    return;
  }
  if (!_computeGrenadeAim(_grenadeAimPos, _grenadeAimVel)) {
    grenadeChargeT_ = 0;
    return;
  }
  spawnGrenade(_grenadeAimPos, _grenadeAimVel);
  grenadeStock_--;
  playHeadOneShot(audioBuffers_.playerShot, 0.4);
  grenadeChargeT_ = 0;
}

/** Cancel without throwing (used when combat disabled mid-aim). */
function cancelGrenadeAim() {
  grenadeAiming_ = false;
  grenadeChargeT_ = 0;
  _hideGrenadeAimVisuals();
}

function spawnGrenade(origin, velocity) {
  const m = new THREE.Mesh(getGrenadeGeo(), getGrenadeMat().clone());
  m.position.copy(origin);
  /* Cast a shadow on the floor while arcing — it really sells weight. */
  m.castShadow = true;
  scene_.add(m);
  grenades_.push({
    mesh: m,
    velocity: velocity.clone(),
    fuse: GRENADE_FUSE_S,
    /* Pulsing fuse light grows brighter as it gets close to detonation. */
    age: 0,
  });
}

/** Apply blast damage + impulse to all drones within radius. */
function detonateGrenade(g) {
  const pos = g.mesh.position;
  /* Spawn an explosion visual + sound. */
  playOneShotAt(audioBuffers_.explosion, pos, { volume: 1.0, refDistance: 8 });
  _spawnExplosionFx(pos);
  /* Apply blast damage to drones. */
  for (const d of drones_) {
    if (d.dead) continue;
    const dist = d.group.position.distanceTo(pos);
    if (dist > GRENADE_BLAST_RADIUS) continue;
    /* Linear falloff: full damage at centre, 0 at the edge. */
    const k = 1 - dist / GRENADE_BLAST_RADIUS;
    const dmg = GRENADE_BLAST_DAMAGE * k;
    /* Damage routes to the nearest body component (not chips/shields)
     * — explosions skip the armour redirect because they hit from
     * everywhere at once. We still respect dome protection. */
    if (_underAnyShieldDome(d) && d.type !== DRONE_TYPE_SHIELD) {
      _pulseShieldDome(d.group.position);
      continue;
    }
    /* Knock-back impulse along the radial direction. */
    const dir = new THREE.Vector3()
      .subVectors(d.group.position, pos)
      .normalize();
    d.velocity.addScaledVector(dir, k * 6);
    /* Damage the body directly at full magnitude (skipping the chip
     * redirect for AoE — explosions strip everything at once). */
    const body = d.group.userData.findKind("body");
    if (body && !body.userData.broken) {
      d.takeDamage(body, dmg, dir, pos);
    }
    /* Also chip away at one armour piece per blast for visible impact. */
    const chips = d.group.userData.bodyChips;
    if (chips) {
      const intact = chips.find((c) => !c.userData.broken);
      if (intact) intact.userData.hp -= dmg * 0.5;
      if (intact && intact.userData.hp <= 0 && !intact.userData.broken) {
        d.breakComponent(intact);
      }
    }
  }
}

let _explosionGeo = null;
function _spawnExplosionFx(worldPos) {
  if (!_explosionGeo) _explosionGeo = new THREE.SphereGeometry(0.6, 16, 12);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffaa44, transparent: true, opacity: 0.85,
    depthTest: true, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const m = new THREE.Mesh(_explosionGeo, mat);
  m.position.copy(worldPos);
  scene_.add(m);
  /* Single-purpose ttl: ~0.45s expanding + fading shell. */
  debris_.push({
    mesh: m,
    velocity: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    ttl: 0.45,
    /* Custom flag handled in updateDebris fall-through (we'll grow scale). */
    isExplosion: true,
  });
}

function updateGrenades(dt) {
  /* Update left-hand history in VR so we always have a recent velocity
   * when the player throws. Falls back gracefully outside VR. */
  if (renderer_.xr.isPresenting && _getLeftControllerWorldPos(_leftHandTmpPos)) {
    const t = (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;
    _leftHandHistory.push({ pos: _leftHandTmpPos.clone(), t });
    /* Keep last 0.4s. */
    while (_leftHandHistory.length > 1 && t - _leftHandHistory[0].t > 0.4) {
      _leftHandHistory.shift();
    }
    _leftHandHistoryReady = true;
  } else if (_leftHandHistoryReady) {
    _leftHandHistory.length = 0;
    _leftHandHistoryReady = false;
  }

  for (let i = grenades_.length - 1; i >= 0; i--) {
    const g = grenades_[i];
    g.age += dt;
    g.fuse -= dt;
    /* Gravity. */
    g.velocity.y -= GRENADE_GRAVITY * dt;
    /* Move + collide. */
    const next = g.mesh.position.clone().addScaledVector(g.velocity, dt);
    /* Bounce off any OBB the grenade now intersects (closest face). */
    if (pointInsideAnyOBB(next, 0.10)) {
      /* Find the wall normal we entered through and reflect the velocity. */
      const boxes = getCollisionBoxes_();
      let bestPen = Infinity;
      let bestNormal = null;
      for (const b of boxes) {
        _localPt.set(next.x - b.cx, next.y - b.cy, next.z - b.cz)
          .applyMatrix3(b.mInv);
        const exX = b.hx + 0.10, exY = b.hy + 0.10, exZ = b.hz + 0.10;
        if (Math.abs(_localPt.x) >= exX) continue;
        if (Math.abs(_localPt.y) >= exY) continue;
        if (Math.abs(_localPt.z) >= exZ) continue;
        const px = exX - Math.abs(_localPt.x);
        const py = exY - Math.abs(_localPt.y);
        const pz = exZ - Math.abs(_localPt.z);
        let p, n;
        if (px < py && px < pz) {
          p = px; n = new THREE.Vector3(_localPt.x > 0 ? 1 : -1, 0, 0);
        } else if (py < pz) {
          p = py; n = new THREE.Vector3(0, _localPt.y > 0 ? 1 : -1, 0);
        } else {
          p = pz; n = new THREE.Vector3(0, 0, _localPt.z > 0 ? 1 : -1);
        }
        if (p < bestPen) { bestPen = p; bestNormal = n.applyMatrix3(b.m).normalize(); }
      }
      if (bestNormal) {
        const vDot = g.velocity.dot(bestNormal);
        if (vDot < 0) {
          /* Reflect + dampen. */
          g.velocity.addScaledVector(bestNormal, -2 * vDot * GRENADE_BOUNCE_DAMP);
        }
        /* Don't move into the wall this frame. */
      }
    } else {
      g.mesh.position.copy(next);
    }
    /* Direct-contact detonation: any drone within 0.45 m fully triggers. */
    let contact = false;
    for (const d of drones_) {
      if (d.dead) continue;
      if (d.group.position.distanceToSquared(g.mesh.position) < 0.45 * 0.45) {
        contact = true; break;
      }
    }
    /* Fuse pulse on the material — sharper as it ages. */
    const pulse = 0.5 + 0.5 * Math.sin(g.age * 18 * (1 + (1 - Math.max(0, g.fuse / GRENADE_FUSE_S))));
    g.mesh.material.emissiveIntensity = 1.5 + pulse * 4 * (1 - Math.max(0, g.fuse / GRENADE_FUSE_S));

    if (contact || g.fuse <= 0) {
      detonateGrenade(g);
      scene_.remove(g.mesh);
      g.mesh.geometry?.dispose?.();
      g.mesh.material?.dispose?.();
      grenades_.splice(i, 1);
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
    const drone = findDroneFromHit(bestHit.object);
    if (drone) {
      let comp = findComponent(bestHit.object);
      /* Decorative-mesh fallback: hits on the belly, muzzle ring, the
       * kamikaze's forward spikes, and other decorative children with
       * no userData.kind would otherwise return `comp = null` and
       * silently miss. We re-route those to the body — the body→chip
       * redirect inside takeDamage then makes the hit absorb on the
       * intact armour layer if any chip is still standing. Without
       * this fallback, players shooting up at a drone from below get
       * lots of "ghost shots" since the entire underside (belly) is
       * keyless. */
      if (!comp || comp.userData.broken) {
        comp = drone.group.userData.findKind("body");
      }
      if (comp && !comp.userData.broken) {
        /* Pass the muzzle (== player hand / camera) world position as the
         * attacker location so the drone can snap-rotate to face the
         * shooter. _muzzle is read-only in takeDamage so no aliasing. */
        drone.takeDamage(comp, PLAYER_DAMAGE, _aimDir, _muzzle);
      }
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
    if (d.isExplosion) {
      /* Expanding fading shell — no gravity, no spin. */
      const t = 1 - Math.max(0, d.ttl) / 0.45;
      const scale = 1 + t * 5;
      d.mesh.scale.setScalar(scale);
      if (d.mesh.material) d.mesh.material.opacity = 0.85 * (1 - t);
      if (d.ttl <= 0) {
        scene_.remove(d.mesh);
        d.mesh.material?.dispose?.();
        debris_.splice(i, 1);
      }
      continue;
    }
    d.velocity.y -= 9.8 * dt;
    d.mesh.position.addScaledVector(d.velocity, dt);
    d.mesh.rotation.x += d.spin.x * dt;
    d.mesh.rotation.y += d.spin.y * dt;
    d.mesh.rotation.z += d.spin.z * dt;
    if (d.mesh.position.y < 0.05) d.ttl = Math.min(d.ttl, 0);
    if (d.ttl <= 0) {
      scene_.remove(d.mesh);
      /* `mesh` may be a THREE.Group (e.g. detached tank gatling) — only
       * Mesh has geometry/material on itself. Dispose what we can without
       * recursing into the children's GPU buffers (those would be needed
       * if any of them respawned via the engineer). */
      if (d.mesh.geometry) d.mesh.geometry.dispose?.();
      if (d.mesh.material) d.mesh.material.dispose?.();
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
  /* Difficulty scales incoming damage. */
  const scaled = dmg * (diffProfile_.damageMul ?? 1);
  playerHp_ = Math.max(0, playerHp_ - scaled);
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
    grenadeStock_ = MAX_GRENADES;
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
    fog: false,
  });
  /* Plane covers a generous FOV at z = -0.3 m. */
  const planeSize = 0.7;
  vrDamageMesh_ = new THREE.Mesh(new THREE.PlaneGeometry(planeSize, planeSize), vrDamageMat_);
  vrDamageMesh_.position.set(0, 0, -0.3);
  vrDamageMesh_.renderOrder = 9998;
  vrDamageMesh_.frustumCulled = false;
  camera_.add(vrDamageMesh_);
}

/* ── Sector minimap (9×9 grid, head-locked) ───────────────────────────── */

/**
 * Lower-right corner of FOV (above the FPS panel). 128² canvas → 9×9
 * cells of 12 px each + 4 px gutter. Each cell colour-coded:
 *   - bright yellow  : current sector
 *   - mid blue       : loaded neighbour (3×3 around player)
 *   - dim grey       : unloaded
 * Drones drawn as red dots. Player position drawn as a tiny white dot
 * inside the current cell.
 */
function ensureSectorMinimap() {
  if (sectorMinimapMesh_) return;
  const SIZE = 144;
  const c = document.createElement("canvas");
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const planeH = 0.07;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(planeH, planeH),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    }),
  );
  /* Above the FPS panel (lower-right). */
  mesh.position.set(0.18, -0.04, -0.6);
  mesh.renderOrder = 9999;
  mesh.frustumCulled = false;
  /* Visible by default — minimap is useful even outside combat. */
  mesh.visible = true;
  camera_.add(mesh);
  sectorMinimapCanvas_ = c;
  sectorMinimapCtx_ = ctx;
  sectorMinimapTexture_ = tex;
  sectorMinimapMesh_ = mesh;
}

function drawSectorMinimap() {
  if (!sectorMinimapCtx_ || !getSectorInfo_) return;
  const info = getSectorInfo_();
  if (!info) return;
  const livingDrones = drones_.filter((d) => !d.dead).length;
  /* Redraw conditions: sector changed, drone count changed, or it's
   * been at least 200 ms since the last redraw (so drone dot positions
   * track motion but we don't pay every frame). */
  const now = performance.now();
  if (info.current === sectorMinimapLastKey_
      && livingDrones === sectorMinimapLastDroneCount_
      && now - sectorMinimapLastDirtyMs_ < 200) return;

  const ctx = sectorMinimapCtx_;
  const W = sectorMinimapCanvas_.width;
  const H = sectorMinimapCanvas_.height;
  ctx.clearRect(0, 0, W, H);
  /* Background panel */
  ctx.fillStyle = "rgba(0,0,0,0.78)";
  const r = 12;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(W, 0, W, H, r);
  ctx.arcTo(W, H, 0, H, r);
  ctx.arcTo(0, H, 0, 0, r);
  ctx.arcTo(0, 0, W, 0, r);
  ctx.closePath();
  ctx.fill();

  const gridSize = info.gridHalf * 2 + 1;
  const pad = 8;
  const inner = W - pad * 2;
  const cellSize = Math.floor(inner / gridSize);
  /* Re-centre after rounding. */
  const offset = (W - cellSize * gridSize) / 2;

  /* Current sector key as numeric (sx,sz). */
  const [csx, csz] = info.current.split(",").map(Number);
  const activeSet = new Set(info.active);

  /* Per-cell paint. */
  for (let sz = -info.gridHalf; sz <= info.gridHalf; sz++) {
    for (let sx = -info.gridHalf; sx <= info.gridHalf; sx++) {
      /* Convert grid coord (sx, sz) → canvas pixel coord. We draw the
       * grid with sz=−gridHalf at the TOP (north up). */
      const ix = sx + info.gridHalf;
      const iy = sz + info.gridHalf;
      const x = offset + ix * cellSize;
      const y = offset + iy * cellSize;
      const key = `${sx},${sz}`;
      let fill;
      if (sx === csx && sz === csz) {
        fill = "#ffd24a"; // current — bright yellow
      } else if (activeSet.has(key)) {
        fill = "#3a7fc7"; // loaded neighbour — mid blue
      } else {
        fill = "#2c2c2c"; // unloaded — dim grey
      }
      ctx.fillStyle = fill;
      ctx.fillRect(x + 1, y + 1, cellSize - 2, cellSize - 2);
    }
  }

  /* Player dot inside the current cell. The player's offset within the
   * cell is given by their world XZ relative to the sector centre. */
  if (getPlayerPosition_) {
    const p = getPlayerPosition_();
    const sectorPx = ((p.x - csx * info.sectorSize) / info.sectorSize) + 0.5; // 0..1
    const sectorPz = ((p.z - csz * info.sectorSize) / info.sectorSize) + 0.5;
    const cx = offset + (csx + info.gridHalf + sectorPx) * cellSize;
    const cz = offset + (csz + info.gridHalf + sectorPz) * cellSize;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(cx, cz, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /* Drone dots. World position → grid cell + intra-cell offset. Skip
   * dead drones and those outside the displayed grid. */
  ctx.fillStyle = "#ff5577";
  for (const d of drones_) {
    if (d.dead) continue;
    const dx = d.group.position.x;
    const dz = d.group.position.z;
    const sx = Math.round(dx / info.sectorSize);
    const sz = Math.round(dz / info.sectorSize);
    if (Math.abs(sx) > info.gridHalf || Math.abs(sz) > info.gridHalf) continue;
    const localPx = ((dx - sx * info.sectorSize) / info.sectorSize) + 0.5;
    const localPz = ((dz - sz * info.sectorSize) / info.sectorSize) + 0.5;
    const cx = offset + (sx + info.gridHalf + localPx) * cellSize;
    const cz = offset + (sz + info.gridHalf + localPz) * cellSize;
    ctx.beginPath();
    ctx.arc(cx, cz, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  /* "N" compass tick at the top centre. */
  ctx.fillStyle = "#9fd6ff";
  ctx.font = "600 9px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("N", W / 2, 7);

  sectorMinimapTexture_.needsUpdate = true;
  sectorMinimapLastKey_ = info.current;
  sectorMinimapLastDroneCount_ = livingDrones;
  sectorMinimapLastDirtyMs_ = now;
}

/* ── Combat HUD ───────────────────────────────────────────────────────── */

function ensureCombatHud() {
  if (combatHudMesh_) return;
  const c = document.createElement("canvas");
  /* Taller canvas — three info rows now (HP / DRONES / WAVE+grenades). */
  c.width = 320;
  c.height = 144;
  const ctx = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const aspect = c.width / c.height;
  const planeH = 0.09;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(planeH * aspect, planeH),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
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

/* Cached "last drawn" snapshot — redraw only when something changed. */
let combatHudLastWaveStr_ = "";
let combatHudLastGrenadeStr_ = "";
let combatHudLastChargeBucket_ = -1;
function drawCombatHud() {
  if (!combatHudCtx_) return;
  const livingDrones = drones_.filter((d) => !d.dead).length;
  const hp = Math.max(0, Math.round(playerHp_));
  let waveStr;
  if (waveActive_) {
    /* Show progress within the current wave. */
    const remaining = pendingSpawns_.length + livingDrones;
    waveStr = `${waveNumber_} · ${waveExpectedKills_ - remaining}/${waveExpectedKills_}`;
  } else {
    waveStr = `${waveNumber_} · in ${Math.max(0, Math.ceil(waveIntermission_))}s`;
  }
  const grenadeStr = `${grenadeStock_}/${MAX_GRENADES}`;
  /* Charge state for the HUD — bucket to ~5% so we don't redraw every
   * single frame while charging, but still see a smooth-enough bar. */
  const chargeFrac = grenadeAiming_
    ? Math.min(1, grenadeChargeT_ / GRENADE_CHARGE_TIME)
    : 0;
  const chargeBucket = Math.round(chargeFrac * 20);
  if (combatHudLastDrawnHp_ === hp
      && combatHudLastDrawnDrones_ === livingDrones
      && combatHudLastWaveStr_ === waveStr
      && combatHudLastGrenadeStr_ === grenadeStr
      && combatHudLastChargeBucket_ === chargeBucket) return;
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
  ctx.fillText("DRONES", 16, 70);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "right";
  ctx.fillText(`${livingDrones}`, w - 16, 70);

  /* Wave (or intermission countdown) */
  ctx.fillStyle = "#a4ff66";
  ctx.font = "600 20px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`WAVE`, 16, 104);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "right";
  ctx.fillText(waveStr, w - 16, 104);

  /* Grenades row: label on the left, count on the right, and an
   * inline charge bar between them when the player is aiming. The bar
   * gradient mirrors the trajectory dot colour ramp (cyan → red). */
  ctx.fillStyle = "#ffd24a";
  ctx.font = "600 18px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`GRENADES`, 16, 132);
  if (grenadeAiming_) {
    /* Bar between label and count text. */
    const bx = 120;
    const by = 120;
    const bw = w - bx - 64;
    const bh = 14;
    ctx.fillStyle = "#181818";
    ctx.fillRect(bx, by, bw, bh);
    /* Colour driven by charge fraction. */
    const cr = Math.round(THREE.MathUtils.lerp(102, 255, chargeFrac));
    const cg = Math.round(THREE.MathUtils.lerp(204, 102, chargeFrac));
    const cb = Math.round(THREE.MathUtils.lerp(255,  51, chargeFrac));
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fillRect(bx, by, Math.max(2, bw * chargeFrac), bh);
  }
  ctx.fillStyle = "#fff";
  ctx.textAlign = "right";
  ctx.fillText(grenadeStr, w - 16, 132);

  combatHudTexture_.needsUpdate = true;
  combatHudLastDrawnHp_ = hp;
  combatHudLastDrawnDrones_ = livingDrones;
  combatHudLastWaveStr_ = waveStr;
  combatHudLastGrenadeStr_ = grenadeStr;
  combatHudLastChargeBucket_ = chargeBucket;
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
    fog: false,
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
  /* Spawn anchored to the player so as the player roams across the
   * sector grid, drones materialise within audible/visible range
   * (rather than back at the world origin where they'd never be heard). */
  const player = getPlayerPosition_ ? getPlayerPosition_() : null;
  const px = player ? player.x : 0;
  const pz = player ? player.z : 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = THREE.MathUtils.randFloat(SPAWN_RADIUS_RANGE[0], SPAWN_RADIUS_RANGE[1]);
    const a = Math.random() * Math.PI * 2;
    const y = THREE.MathUtils.randFloat(SPAWN_HEIGHT_RANGE[0], SPAWN_HEIGHT_RANGE[1]);
    out.set(px + Math.cos(a) * r, y, pz + Math.sin(a) * r);
    if (!pointInsideAnyOBB(out, 0.5)) return out;
  }
  /* Fallback: high above the player. */
  out.set(px, SPAWN_HEIGHT_RANGE[1], pz);
  return out;
}

/* Pick a drone variant by weighted random. Pulled out so console
 * commands / tests can override it later if we want forced spawns.
 * Difficulty's `typeWeightOverrides` patch the base weights at lookup
 * time — multipliers per-type (e.g. insane → 2× snipers + 2.5× kamis).
 */
function pickDroneType() {
  const overrides = diffProfile_.typeWeightOverrides || {};
  let total = 0;
  const weights = {};
  for (const k of Object.keys(DRONE_TYPE_WEIGHTS)) {
    const w = DRONE_TYPE_WEIGHTS[k] * (overrides[k] ?? 1);
    weights[k] = w;
    total += w;
  }
  let r = rand() * total;
  for (const k of Object.keys(weights)) {
    r -= weights[k];
    if (r <= 0) return k;
  }
  return DRONE_TYPE_STANDARD;
}

/* Spawn a drone. `entry` may be a string (type name) or
 * { type, hpMul } for boss-flavoured spawns from the wave comp. */
function spawnDrone(entry) {
  if (drones_.filter((d) => !d.dead).length >= MAX_DRONES) return null;
  pickSpawnPoint(_v0);
  let type, hpMul;
  if (typeof entry === "string") {
    type = entry; hpMul = 1;
  } else if (entry && typeof entry === "object") {
    type = entry.type;
    hpMul = entry.hpMul ?? 1;
  } else {
    type = pickDroneType();
    hpMul = 1;
  }
  const drone = new Drone(_v0, type, { hpMul });
  drones_.push(drone);
  waveSpawnedTotal_++;
  return drone;
}

/* ── Records (best wave / kills) IndexedDB ────────────────────────────
 * Tiny standalone DB so we don't pollute the lightmap store. Stored
 * under a key combining mode + difficulty so a hard-mode best doesn't
 * inflate the easy-mode display. Async, fire-and-forget — failures
 * just leave bestWave_/bestKills_ at their default 0. */
function _recordsKey() {
  return `${runMode_}-${difficulty_}${seedValue_ === null ? "" : "-seed" + seedValue_}`;
}
function _openRecordsDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("indexedDB not available"));
      return;
    }
    const req = indexedDB.open(RECORDS_DB, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(RECORDS_STORE)) {
        db.createObjectStore(RECORDS_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function loadRecords() {
  try {
    const db = await _openRecordsDb();
    const tx = db.transaction(RECORDS_STORE, "readonly");
    const store = tx.objectStore(RECORDS_STORE);
    const r = await new Promise((res, rej) => {
      const q = store.get(_recordsKey());
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
    if (r && typeof r === "object") {
      bestWave_ = r.wave || 0;
      bestKills_ = r.kills || 0;
    }
    db.close();
  } catch (e) {
    /* No-op: records remain at 0/0. */
  }
}
function saveRecords() {
  /* Fire-and-forget — never throws. Records aren't critical state. */
  _openRecordsDb().then((db) => {
    const tx = db.transaction(RECORDS_STORE, "readwrite");
    tx.objectStore(RECORDS_STORE).put(
      { wave: bestWave_, kills: bestKills_ },
      _recordsKey(),
    );
    tx.oncomplete = () => db.close();
  }).catch(() => { /* ignore */ });
}

/* ── Wave manager ───────────────────────────────────────────────────── */

function _getWaveComp(wave) {
  /* Hand-tuned waves first; once exhausted, generate procedurally. */
  if (wave - 1 < WAVE_COMPS.length) return WAVE_COMPS[wave - 1];
  return _proceduralWaveComp(wave);
}

function startWave(wave) {
  waveNumber_ = wave;
  const comp = _getWaveComp(wave);
  pendingSpawns_ = comp.slice();   // clone — we drain it
  waveSpawnedTotal_ = 0;
  waveExpectedKills_ = comp.length;
  /* Drip-feed: first spawn happens at ~1.5 s, subsequent every 0.6-1.2 s
   * so the player isn't blitzed all at once. */
  nextSpawnTimer_ = 1.5;
  waveActive_ = true;
  waveStartedAt_ = (typeof performance !== "undefined") ? performance.now() : Date.now();
  /* Music kicks back to battle (in case it was on calm during the
   * intermission). */
  if (musicInited_) setMusicTarget("battle");
  /* Bump SPAWN_TARGET to comp size (clamped) so multiple drones can
   * coexist as the wave fills. */
  SPAWN_TARGET = Math.min(MAX_DRONES, comp.length);
  /* Apply difficulty add only in endless mode (in wave mode, the comp
   * already encodes density). */
  if (runMode_ === "endless") {
    SPAWN_TARGET = Math.max(1, SPAWN_TARGET + (diffProfile_.spawnTargetAdd ?? 0));
  }
  console.info(`[brutalistVR8] Wave ${wave} starting — ${comp.length} drones (${comp.map((c) => typeof c === "string" ? c : c.type).join(", ")})`);
}

function tickWaveManager(dt) {
  /* Garbage-collect dead drones from the live list. */
  for (let i = drones_.length - 1; i >= 0; i--) {
    if (drones_[i].dead) drones_.splice(i, 1);
  }

  if (!waveActive_) {
    /* Intermission countdown — start next wave when it expires. */
    waveIntermission_ -= dt;
    if (waveIntermission_ <= 0) {
      startWave(waveNumber_);
    }
    return;
  }

  /* Drip-feed spawns from `pendingSpawns_`. If `spawnDrone` declines
   * (we're at MAX_DRONES living), put the entry back on the front of
   * the queue and try again next tick — we never want a wave to "leak"
   * spawns and then never end. */
  if (pendingSpawns_.length > 0) {
    nextSpawnTimer_ -= dt;
    if (nextSpawnTimer_ <= 0) {
      const entry = pendingSpawns_.shift();
      const spawned = spawnDrone(entry);
      if (!spawned) {
        pendingSpawns_.unshift(entry);
        nextSpawnTimer_ = 0.5;
      } else {
        nextSpawnTimer_ = 0.6 + rand() * 0.6;
      }
    }
  }

  /* Wave end condition: nothing left to spawn AND nothing alive. */
  const alive = drones_.filter((d) => !d.dead).length;
  if (pendingSpawns_.length === 0 && alive === 0) {
    /* Update best record, then queue intermission. */
    if (waveNumber_ > bestWave_) {
      bestWave_ = waveNumber_;
      saveRecords();
    }
    waveActive_ = false;
    /* Endless: continue indefinitely. Wave mode: also continues but the
     * comp is hand-tuned for ~10 then proceduralised. (Same flow either
     * way; mode flag mostly affects HUD label and SPAWN_TARGET adds.) */
    waveNumber_++;
    waveIntermission_ = INTERMISSION_S;
    if (musicInited_) setMusicTarget("calm");
    console.info(`[brutalistVR8] Wave ${waveNumber_ - 1} cleared. Intermission ${INTERMISSION_S}s, then wave ${waveNumber_}.`);
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
    /* Lazy-init music on first combat-on (covers VR users who never
     * see the desktop HUD). Calm ambience starts at vol 0 and we
     * immediately set the target to battle so the crossfade ramps it
     * up. */
    if (!musicInited_) ensureMusicInited();
    setMusicTarget("battle");
    /* Reset world state. */
    playerHp_ = PLAYER_MAX_HP;
    playerInvuln_ = 1.5;
    kills_ = 0;
    deaths_ = 0;
    grenadeStock_ = MAX_GRENADES;
    respawnQueue_.length = 0;
    /* Reset RNG to the configured seed (so re-toggling combat doesn't
     * desync from the seed). */
    if (seedValue_ !== null) _rngState = seedValue_ || 1;
    /* Start at wave 1. The wave manager handles spawning from there. */
    startWave(1);
  } else {
    /* Crossfade back to calm ambience on combat-off. Skips silently if
     * the music system was never initialised (player toggled combat
     * on then off before any music started). */
    if (musicInited_) setMusicTarget("calm");
    /* If the player was mid-throw when they toggled combat off, drop
     * the aim cleanly so the trajectory dots don't linger in the scene. */
    if (grenadeAiming_) cancelGrenadeAim();
    /* Tear down living drones, projectiles, tracers, debris. */
    for (const d of drones_) {
      if (d.audio) {
        try { d.audio.stop(); } catch (_) { /* ignore */ }
      }
      /* Engineer repair beam lives in scene_ (not d.group) — must be
       * removed explicitly; otherwise it would dangle in the scene
       * after combat ends. */
      const beam = d.group.userData.repairBeam;
      if (beam) {
        scene_.remove(beam);
        beam.geometry?.dispose?.();
        beam.material?.dispose?.();
        d.group.userData.repairBeam = null;
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
    /* Wipe wave + grenade state so the next combat-on starts fresh. */
    pendingSpawns_.length = 0;
    waveActive_ = false;
    waveIntermission_ = 0;
    waveNumber_ = 1;
    for (const g of grenades_) {
      scene_.remove(g.mesh);
      g.mesh.geometry?.dispose?.();
      g.mesh.material?.dispose?.();
    }
    grenades_.length = 0;
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
  let triggerL = false;
  let buttonX = false;
  for (const src of session.inputSources) {
    if (!src?.gamepad) continue;
    if (src.handedness === "right") {
      if (src.gamepad.buttons?.[0]?.pressed) triggerR = true;
    }
    if (src.handedness === "left") {
      if (src.gamepad.buttons?.[0]?.pressed) triggerL = true;
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

  /* Left trigger: hold-to-aim grenade. Press starts the trajectory
   * preview + charge meter; release throws along that exact arc.
   * Tapping = minimum-power throw (still useful at close range). */
  if (enabled_ && triggerL && !prevTriggerL_) startGrenadeAim();
  if (!triggerL && prevTriggerL_ && grenadeAiming_) releaseGrenadeAim();
  prevTriggerL_ = triggerL;
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
   * the single-action trigger behaviour.
   *
   * 'G' is the desktop grenade key, mirroring the VR left-trigger:
   * keydown enters aim mode (with trajectory preview), keyup releases
   * the throw. */
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (!enabled_) return;
    if (renderer_.xr.isPresenting) return;
    if (e.key === "f" || e.key === "F") {
      fireHitscan();
    } else if (e.key === "g" || e.key === "G") {
      startGrenadeAim();
    }
  });
  /* No isPresenting gate on keyup — if the player started aiming on
   * desktop and then entered VR mid-charge, releasing G should still
   * cleanly cancel the aim instead of leaving it stuck. */
  window.addEventListener("keyup", (e) => {
    if (e.key === "g" || e.key === "G") {
      if (grenadeAiming_) {
        if (renderer_.xr.isPresenting) cancelGrenadeAim();
        else releaseGrenadeAim();
      }
    }
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

/* ── Music (calm ↔ battle crossfade) ──────────────────────────────────── */

/* Set up streaming audio elements + THREE.Audio wrappers. Idempotent —
 * only the first call does the work. Must run inside a user-gesture call
 * stack so the AudioContext can resume and `.play()` succeeds (browsers
 * block autoplay otherwise). */
function ensureMusicInited() {
  if (musicInited_ || !audioListener_) return;
  /* Safety: try to resume the audio context. If we're being called from
   * a non-gesture path it may stay suspended, but the actual <audio>
   * element will queue up and start when the context resumes. */
  if (audioListener_.context.state === "suspended") {
    audioListener_.context.resume().catch(() => {});
  }

  /* Calm ambience — streams from disk, looped. We deliberately don't
   * set crossOrigin since the MP3s are same-origin; setting it to
   * "anonymous" forces a CORS preflight that some static dev servers
   * don't satisfy and would silently mute the track. */
  musicCalmEl_ = document.createElement("audio");
  musicCalmEl_.src = MUSIC_FILES.calm;
  musicCalmEl_.loop = true;
  musicCalmEl_.preload = "auto";
  musicCalmAudio_ = new THREE.Audio(audioListener_);
  musicCalmAudio_.setMediaElementSource(musicCalmEl_);
  musicCalmAudio_.setVolume(0);

  /* Pick one of the battle tracks at random per session. */
  const battleUrl =
    MUSIC_FILES.battle[Math.floor(Math.random() * MUSIC_FILES.battle.length)];
  musicBattleEl_ = document.createElement("audio");
  musicBattleEl_.src = battleUrl;
  musicBattleEl_.loop = true;
  musicBattleEl_.preload = "auto";
  musicBattleAudio_ = new THREE.Audio(audioListener_);
  musicBattleAudio_.setMediaElementSource(musicBattleEl_);
  musicBattleAudio_.setVolume(0);

  /* Both elements start playing immediately at volume 0 — element-level
   * play() is the part that needs the user gesture, but once the source
   * is rolling we can crossfade through the gain nodes without further
   * gestures. */
  musicCalmEl_.play().catch(() => { /* will retry on next gesture */ });
  musicBattleEl_.play().catch(() => {});

  musicInited_ = true;
  /* Fade calm in so the player hears the ambience as soon as music
   * initialises, regardless of which path triggered it (combat-on first
   * vs. music-toggle first). If combat is already on we'll get
   * overridden by the next setMusicTarget call. */
  setMusicTarget(enabled_ ? "battle" : "calm", true);
}

/* Schedule a linear gain ramp from current value to `targetVol` over
 * `seconds`. Uses Web Audio's intrinsic ramping for sample-accurate
 * fades — no per-frame JS work. */
function rampMusicGain(audio, targetVol, seconds) {
  if (!audio || !audioListener_) return;
  const param = audio.gain.gain;
  const t = audioListener_.context.currentTime;
  /* Capture current ramp value before scheduling the new one — without
   * this, a fade started mid-fade would snap back to whatever value was
   * last written by setVolume() instead of continuing smoothly. */
  param.cancelScheduledValues(t);
  param.setValueAtTime(param.value, t);
  param.linearRampToValueAtTime(targetVol, t + Math.max(0.01, seconds));
}

/**
 * Crossfade to "calm" or "battle". `instant=true` skips the ramp (used
 * during init / explicit user toggles).
 */
function setMusicTarget(target, instant = false) {
  if (!musicInited_) return;
  musicTarget_ = target;
  const dur = instant ? 0.05 : MUSIC_CROSSFADE_S;
  const effective = musicEnabled_ ? 1 : 0;
  rampMusicGain(musicCalmAudio_, target === "calm" ? MUSIC_CALM_VOLUME * effective : 0, dur);
  rampMusicGain(musicBattleAudio_, target === "battle" ? MUSIC_BATTLE_VOLUME * effective : 0, dur);
}

function setMusicEnabled(on) {
  musicEnabled_ = on;
  /* First-time gesture path: clicking the music button initialises the
   * music system if combat hasn't already done so. */
  if (on && !musicInited_) ensureMusicInited();
  if (musicBtn_) {
    musicBtn_.textContent = `Music: ${on ? "ON" : "OFF"}`;
    musicBtn_.style.background = on ? "#3a6a8a" : "#333";
  }
  if (musicInited_) {
    /* Faster duck so the user gets immediate audible feedback on toggle. */
    const dur = MUSIC_DUCK_S;
    rampMusicGain(
      musicCalmAudio_,
      on && musicTarget_ === "calm" ? MUSIC_CALM_VOLUME : 0,
      dur,
    );
    rampMusicGain(
      musicBattleAudio_,
      on && musicTarget_ === "battle" ? MUSIC_BATTLE_VOLUME : 0,
      dur,
    );
  }
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
  getPlayerPosition_ = opts.getPlayerPosition || (() => cameraRig_?.position || new THREE.Vector3());
  getSectorInfo_ = opts.getSectorInfo || null;
  respawnPlayer_ = opts.respawnPlayer || null;

  /* Read URL config for difficulty / mode / seed. */
  _readQueryConfig();
  /* Load best-wave / best-kills records (async; don't block init). */
  loadRecords().catch(() => { /* ignore errors — falls back to 0/0 */ });

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

    /* Music toggle — DodgeVR-style calm vs. battle BGM with smooth
     * crossfades. First click also doubles as the user-gesture that
     * boots the music system if combat hasn't already done so. */
    musicBtn_ = document.createElement("button");
    musicBtn_.type = "button";
    musicBtn_.id = "musicBtn";
    musicBtn_.textContent = "Music: ON";
    musicBtn_.style.background = "#3a6a8a";
    musicBtn_.style.color = "#fff";
    musicBtn_.style.display = "block";
    musicBtn_.style.width = "100%";
    musicBtn_.style.marginTop = "6px";
    musicBtn_.style.padding = "8px 12px";
    musicBtn_.style.cursor = "pointer";
    musicBtn_.style.border = "none";
    musicBtn_.style.borderRadius = "4px";
    musicBtn_.style.fontSize = "12px";
    /* First click is the user-gesture that boots the music system —
     * we treat it as "start the music (preference is ON by default)"
     * rather than a toggle, so the button label always matches what
     * the player can audibly hear from this point on. Subsequent
     * clicks then toggle preference normally. */
    musicBtn_.addEventListener("click", () => {
      if (!musicInited_) {
        ensureMusicInited();
        return;
      }
      setMusicEnabled(!musicEnabled_);
    });
    hud.appendChild(musicBtn_);

    combatStatusEl_ = document.createElement("div");
    combatStatusEl_.id = "combatStatus";
    combatStatusEl_.style.marginTop = "6px";
    combatStatusEl_.style.fontSize = "11px";
    combatStatusEl_.style.color = "#9fd6ff";
    combatStatusEl_.style.display = "none";
    combatStatusEl_.textContent =
      "VR: right trigger fires, left trigger throws grenade, left X toggles combat. Desktop: left-click/F fires, G throws grenade.";
    hud.appendChild(combatStatusEl_);

    /* Meta line: difficulty + mode + best record. */
    const metaLine = document.createElement("div");
    metaLine.id = "combatMeta";
    metaLine.style.marginTop = "4px";
    metaLine.style.fontSize = "11px";
    metaLine.style.color = "#a4ff66";
    metaLine.style.opacity = "0.85";
    const seedTag = seedValue_ === null ? "" : ` · seed ${seedValue_}`;
    /* Defer to a later tick so loadRecords() has had a chance to fill
     * bestWave_/bestKills_ from IndexedDB. */
    const refreshMeta = () => {
      metaLine.textContent =
        `${runMode_.toUpperCase()} · ${difficulty_.toUpperCase()}${seedTag} — best: wave ${bestWave_}, ${bestKills_} kills`;
    };
    refreshMeta();
    setTimeout(refreshMeta, 250);
    setTimeout(refreshMeta, 1000);
    hud.appendChild(metaLine);
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
  ensureSectorMinimap();
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
  /* Grenade aim preview ticks every frame whether or not we're in
   * combat — but startGrenadeAim() guards the entry, so it only
   * actually animates while the player is holding the trigger. */
  tickGrenadeAim(dt);

  /* The sector minimap is a navigation tool, not a combat tool —
   * always visible, always refreshed (cheap; the draw itself is gated
   * to redraw at most ~5 Hz when nothing material has changed). */
  drawSectorMinimap();

  if (!enabled_) return;

  /* Player position for AI. */
  getPlayerHeadWorld(_v0);
  getPlayerBodyWorld(_v1);
  const playerSpeed = getPlayerSpeed();

  /* If a drone has been left far behind because the player roamed
   * across the 9×9 grid, teleport it to a fresh spawn point near the
   * player rather than killing it (which would let the player "win"
   * a wave by simply walking away — the wave manager treats `dead`
   * drones as cleared). HP and FSM state survive the teleport, so a
   * drone that was hunting the player keeps hunting after re-anchor.
   *
   * NOTE: this runs AFTER `getPlayerHeadWorld(_v0)` so we must NOT
   * use `_v0` as scratch — `pickSpawnPoint(out)` writes its result to
   * `out`, so we use `_d0` (the drone-step scratch) which doesn't
   * become live until the for-loop below. */
  const RESPAWN_FAR_SQ = 140 * 140;
  const playerPos = getPlayerPosition_ ? getPlayerPosition_() : null;
  if (playerPos) {
    for (const d of drones_) {
      if (d.dead) continue;
      const dx = d.group.position.x - playerPos.x;
      const dz = d.group.position.z - playerPos.z;
      if (dx * dx + dz * dz > RESPAWN_FAR_SQ) {
        pickSpawnPoint(_d0);
        d.group.position.copy(_d0);
        d.targetPos.copy(_d0);
      }
    }
  }

  for (const d of drones_) d.update(dt, _v0, _v1, playerSpeed);
  updateProjectiles(dt, _v0);
  updateGrenades(dt);
  tickWaveManager(dt);
  drawCombatHud();
}

export { setBotsEnabled, getBotsEnabled };

/* Diagnostics for the console API. */
export function getBotsDebug() {
  return {
    enabled: enabled_,
    mode: runMode_,
    difficulty: difficulty_,
    seed: seedValue_,
    wave: waveNumber_,
    waveActive: waveActive_,
    pendingSpawns: pendingSpawns_.length,
    living: drones_.filter((d) => !d.dead).length,
    states: drones_.map((d) => d.state),
    types: drones_.map((d) => d.type),
    projectilesInFlight: projectiles_.length,
    grenadesInFlight: grenades_.length,
    grenadeStock: grenadeStock_,
    playerHp: playerHp_,
    kills: kills_,
    deaths: deaths_,
    bestWave: bestWave_,
    bestKills: bestKills_,
  };
}

/** Force-clear all combatants (handy for testing). */
export function killAllDrones() {
  for (const d of drones_) if (!d.dead) d.die();
}

/** Skip ahead to wave N (testing aid). */
export function jumpToWave(n) {
  if (!enabled_) return false;
  killAllDrones();
  pendingSpawns_.length = 0;
  waveActive_ = false;
  waveIntermission_ = 0.05;
  waveNumber_ = Math.max(1, n | 0);
  return true;
}

/** Force-spawn a specific drone variant (any of DRONE_TYPE_*). */
export function spawnSpecificDrone(type) {
  if (!enabled_) return null;
  return spawnDrone(type);
}
