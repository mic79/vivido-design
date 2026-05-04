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
/** Rim samples for vision-cone wall truncation (axis + this many
 *  directions on the mantle). Higher = fewer “ears” through walls,
 *  more raycasts. */
const VISION_CONE_TRUNC_RING_SEGS = 6;

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
  /* Compass / minimap orientation. `?compass=heading` rotates the
   * minimap so player-forward is up; default is north-up. */
  const cm = (q.get("compass") || "").toLowerCase();
  if (cm === "heading" || cm === "rotating") compassMode_ = "heading";
  else if (cm === "north" || cm === "static") compassMode_ = "north";
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

/* ── Persistent records (top scores) ────────────────────────────────────
 * Stored in IndexedDB keyed by the difficulty + mode combo so a hard-
 * mode best doesn't compete with an easy-mode best. The user wanted a
 * top-3 list on the intro screen; we keep up to TOP_SCORES_KEEP entries
 * internally and just slice(0, 3) for the UI so future changes can show
 * more without a migration. Each entry shape:
 *   { score, kills, hqKills, wave, durationS, dateISO } */
const RECORDS_DB = "brutalistVR8_records";
const RECORDS_STORE = "records";
const TOP_SCORES_KEEP = 10;
let topScores_ = [];        // sorted descending by score

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
let getSectorTowerAnchors_; // (key) => Array<{x,y,z,yaw,w,d,sx,sz,key}>
let respawnPlayer_;      // () => void                 (main.js's preferred respawn impl)

let enabled_ = false;
let initDone_ = false;

const drones_ = [];       // active Drone instances
const projectiles_ = [];  // drone-fired projectiles in flight
const tracers_ = [];      // player tracer line segments
const debris_ = [];       // post-death tumbling fragments

/* ── Surface-damage state ─────────────────────────────────────────────
 * Tier-1 destructibility: every bullet that strikes the static world
 * spawns a small concrete-chip burst (reusing debris_) and either
 * places a new persistent decal on the surface or upgrades a nearby
 * existing one to a deeper damage tier. No geometry is removed from
 * the world — we just sell the *feeling* of damage with a cracked-
 * polygon texture and chip particles, which is enough to make every
 * shot feel substantial without adding a real destruction simulation
 * (no Ammo, no rigid-body chunks, no per-cell tessellation).
 *
 * Tunables:
 *   MAX_DECALS         — global cap; oldest are recycled when exceeded
 *   DECAL_MERGE_RADIUS — repeated hits within this many metres of an
 *                        existing decal upgrade it instead of spawning
 *                        a new one (so the player can "dig out" a
 *                        bigger crater by shooting the same spot)
 *   DECAL_BASE_SIZE    — radius of a fresh hit's decal in metres
 *   CHIPS_PER_HIT      — concrete fragments spawned per bullet impact
 */
const decals_ = [];
/* Tight cap — only the 10 most recent impacts persist on the world.
 * Anything older is recycled (oldest-first), so the player always sees
 * fresh damage where they're currently fighting and old marks fade out
 * cleanly as new shots land. Keeps GPU state minimal too. */
const MAX_DECALS = 10;
/* Per-decal alpha multiplier. At 60% the cracked pattern still reads
 * clearly against the wall but doesn't dominate the brutalist palette
 * the way fully-opaque decals did. Note: this is applied on top of the
 * per-pixel alpha baked into the procedural texture, so the soft edges
 * of the polygon stay soft. */
const DECAL_OPACITY = 0.6;
const DECAL_MERGE_RADIUS = 0.30;
const DECAL_MERGE_RADIUS_SQ = DECAL_MERGE_RADIUS * DECAL_MERGE_RADIUS;
const DECAL_BASE_SIZE = 0.18;       // metres (radius of the fresh-hit quad)
/* 2 cm in front of the wall. The previous 5 mm value caused two bugs:
 *   1. At close range the decal plane ended up *inside* the WebXR
 *      near-clip distance (≈5 cm on Quest), so the small quad got
 *      culled while the surrounding wall (which extends far beyond
 *      the near plane) kept rendering — the player saw the decal
 *      "vanish" as they leaned in.
 *   2. At mid-range the offset was too small to reliably win the
 *      depth test against the wall, producing strobing z-fighting.
 *  2 cm is still imperceptible against an 18 cm decal, but well
 *  clear of typical near planes and immune to depth oscillation. */
const DECAL_NORMAL_OFFSET = 0.02;
const DECAL_MAX_HITS = 6;
const CHIPS_PER_HIT = 5;
const CHIP_SIZE = 0.025;            // 2.5 cm cubes
const CHIP_TTL_MIN = 0.8;
const CHIP_TTL_MAX = 1.5;

/* Shared resources for chip debris — one geometry + one material across
 * every bullet impact, avoiding per-shot allocation. */
let _chipGeometry = null;
let _chipMaterial = null;
function getChipGeometry() {
  if (!_chipGeometry) _chipGeometry = new THREE.BoxGeometry(CHIP_SIZE, CHIP_SIZE, CHIP_SIZE);
  return _chipGeometry;
}
function getChipMaterial() {
  if (!_chipMaterial) {
    _chipMaterial = new THREE.MeshStandardMaterial({
      /* Slightly darker than the ground concrete (0x807a72) so chips
       * read as "exposed interior" against the wall surface. */
      color: 0x6a655e,
      roughness: 0.95,
      metalness: 0.02,
    });
  }
  return _chipMaterial;
}

/* Cached cracked-impact texture per damage tier (1..DECAL_MAX_HITS).
 * Generated lazily; ~6 KB per tier. Each texture is a 64×64 RGBA
 * with a transparent background and an irregular dark polygon plus
 * radial cracks. */
const _decalTextureByTier = new Array(DECAL_MAX_HITS + 1).fill(null);
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
/* HQ kills tracked separately so they can weight the score. Set in
 * AntiAirTurret.die(). Reset on game-reset (Play Again). */
let hqKills_ = 0;
/* Wall-clock at the start of the current life. Used for "time alive"
 * stat in the game-over summary. */
let runStartedAt_ = (typeof performance !== "undefined") ? performance.now() : Date.now();
/* Single-life rule: once the player's HP hits 0 the run is over —
 * no respawn. The game-over UI is shown until the player chooses
 * Play Again. While `gameOver_` is true, drone fire / AOE skip the
 * player entirely so the corpse isn't repeatedly battered, and the
 * player input loop ignores draw / fire / movement-locomotion (the
 * head can still look around). */
let gameOver_ = false;
/* Latched score / stats snapshot from the moment of death. We keep
 * it module-scope so the 3D in-VR panel and the DOM intro overlay
 * can both read the same numbers without recomputing (counters get
 * reset when the player presses Play Again, which would zero out a
 * still-displayed summary). */
let lastRunSnapshot_ = null;
/* Game-over 3D panel — a head-locked CanvasTexture-backed mesh that
 * appears in front of the camera in VR. Populated lazily so we
 * don't allocate the 2D context until the player actually dies. */
let gameOverMesh_ = null;
let gameOverCanvas_ = null;
let gameOverCtx_ = null;
let gameOverTex_ = null;

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
 * showing a player-centred 9×9 window of the (infinite) world, with the
 * current sector highlighted, the 24 loaded neighbours tinted, and live
 * drone dots in red. */
let sectorMinimapMesh_ = null;
let sectorMinimapCanvas_ = null;
let sectorMinimapCtx_ = null;
let sectorMinimapTexture_ = null;
let sectorMinimapLastKey_ = "";
let sectorMinimapLastDroneCount_ = -1;
let sectorMinimapLastDirtyMs_ = 0;
let sectorMinimapLastHeadingDeg_ = -999;

/* Compass orientation HUD. A head-locked horizontal ribbon at the top
 * of the player's FOV that shows N/E/S/W tick marks and the current
 * heading in degrees. Combined with a heading triangle on the minimap,
 * this gives the player both an absolute "which way am I facing?" read
 * and a stable spatial map. The ribbon is the natural VR fit — head
 * rotation IS the input, so glancing up answers the question
 * directly. */
let compassRibbonMesh_ = null;
let compassRibbonCanvas_ = null;
let compassRibbonCtx_ = null;
let compassRibbonTexture_ = null;
let compassRibbonLastDeg_ = -999;

/* Minimap orientation mode. Default "north" keeps the world stable
 * (north is always at the top of the minimap, the player is drawn as a
 * heading triangle). "heading" rotates the entire map so the player's
 * forward direction is at the top — opt-in via `?compass=heading`,
 * because in VR the constant head movement makes a rotating map spin in
 * peripheral vision and is generally more disorienting than helpful. */
let compassMode_ = "north"; // "north" | "heading"

/* Master UI-visibility gate. When false, the per-frame end-of-update
 * sweep force-hides every HUD element bots.js owns (minimap, compass
 * ribbon, combat HUD, crosshair). Damage flashes are NOT gated — they
 * are critical feedback and must remain visible even with UI off. The
 * Y-button (left) toggles this from main.js via setUIVisible(); the
 * console API exposes `brutalistVR8.toggleUI()`. */
let uiVisible_ = true;
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

/** Player horizontal heading in radians, where 0 = north (−Z) and the
 *  angle increases clockwise (compass convention: 0 N, π/2 E, π S,
 *  3π/2 W). Reads the camera's forward vector in world space — works
 *  identically whether or not we're in an XR session because the
 *  perspective camera tracks the head pose every frame. */
const _heading = new THREE.Vector3();
function getPlayerHeadingRad() {
  camera_.getWorldDirection(_heading);
  return Math.atan2(_heading.x, -_heading.z);
}
function getPlayerHeadingDeg() {
  const r = getPlayerHeadingRad();
  return ((r * 180 / Math.PI) + 360) % 360;
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

/* ── Rich ray hit (for surface decals / chip debris) ──────────────────
 * Variant of rayHitWorld that also writes the entry-face axis + sign
 * for the winning OBB, so we can compute a world-space surface normal
 * at the impact point. Reuses scratch state so it doesn't allocate. */
const _rayHitScratchA = new THREE.Vector3();
const _rayHitScratchB = new THREE.Vector3();
const _rayHitNormalLocal = new THREE.Vector3();

/** Like rayHitOBB, but also returns which axis (0/1/2) and which sign
 *  (+1/-1) the ray entered through. Returns Infinity if no hit. */
function rayHitOBBRich(origin, dir, b, maxDist, outInfo) {
  _rayHitScratchA.set(origin.x - b.cx, origin.y - b.cy, origin.z - b.cz).applyMatrix3(b.mInv);
  _rayHitScratchB.copy(dir).applyMatrix3(b.mInv);

  let tmin = -Infinity;
  let tmax = Infinity;
  let entryAxis = 0;
  let entrySign = 1;
  for (let axis = 0; axis < 3; axis++) {
    const o = axis === 0 ? _rayHitScratchA.x : axis === 1 ? _rayHitScratchA.y : _rayHitScratchA.z;
    const d = axis === 0 ? _rayHitScratchB.x : axis === 1 ? _rayHitScratchB.y : _rayHitScratchB.z;
    const h = axis === 0 ? b.hx : axis === 1 ? b.hy : b.hz;
    if (Math.abs(d) < 1e-8) {
      if (o < -h || o > h) return Infinity;
    } else {
      const inv = 1 / d;
      let t1 = (-h - o) * inv;
      let t2 = ( h - o) * inv;
      /* The "entry" plane corresponds to whichever of -h/+h was hit
       * first along the ray. After ordering t1 <= t2, the sign of
       * that face on this axis is -sign(d). */
      let signThisAxis = d > 0 ? -1 : 1;
      if (t1 > t2) {
        const tmp = t1; t1 = t2; t2 = tmp;
        signThisAxis = -signThisAxis;
      }
      if (t1 > tmin) {
        tmin = t1;
        entryAxis = axis;
        entrySign = signThisAxis;
      }
      if (t2 < tmax) tmax = t2;
      if (tmax < tmin) return Infinity;
    }
  }
  if (tmax < 0) return Infinity;
  const t = tmin >= 0 ? tmin : tmax;
  if (t > maxDist) return Infinity;
  outInfo.axis = entryAxis;
  outInfo.sign = entrySign;
  return t;
}

/** Earliest hit info: writes { t, box, normal: Vector3, point: Vector3 }
 *  to outHit and returns true on hit, false otherwise. The normal
 *  points outward from the surface (away from the box interior). */
const _rhwInfo = { axis: 0, sign: 1 };
const _rhwBestInfo = { axis: 0, sign: 1 };
function rayHitWorldRich(origin, dir, maxDist, outHit) {
  const boxes = getCollisionBoxes_();
  let best = Infinity;
  let bestBox = null;
  for (const b of boxes) {
    const t = rayHitOBBRich(origin, dir, b, maxDist, _rhwInfo);
    if (t < best) {
      best = t;
      bestBox = b;
      _rhwBestInfo.axis = _rhwInfo.axis;
      _rhwBestInfo.sign = _rhwInfo.sign;
    }
  }
  if (!Number.isFinite(best) || !bestBox) return false;
  /* Local normal: unit vector along the entry axis, scaled by entry
   * sign (so it points outward from the box). Transform into world by
   * applying box.m (the box's local→world rotation matrix). */
  _rayHitNormalLocal.set(
    _rhwBestInfo.axis === 0 ? _rhwBestInfo.sign : 0,
    _rhwBestInfo.axis === 1 ? _rhwBestInfo.sign : 0,
    _rhwBestInfo.axis === 2 ? _rhwBestInfo.sign : 0,
  );
  outHit.normal.copy(_rayHitNormalLocal).applyMatrix3(bestBox.m).normalize();
  outHit.point.copy(origin).addScaledVector(dir, best);
  outHit.t = best;
  outHit.box = bestBox;
  return true;
}

/** Find the OBB containing `point` (with optional `pad` outward
 *  inflation) and return both the box and the closest-face outward
 *  normal in world space. Used by drone-projectile impact resolution
 *  where the hit was detected by pointInsideAnyOBB rather than a
 *  ray cast — we walk back to the nearest face to drop a decal there. */
const _obbFindLocal = new THREE.Vector3();
function obbContainingPoint(point, pad, outHit) {
  const boxes = getCollisionBoxes_();
  for (const b of boxes) {
    _obbFindLocal.set(point.x - b.cx, point.y - b.cy, point.z - b.cz).applyMatrix3(b.mInv);
    if (Math.abs(_obbFindLocal.x) > b.hx + pad) continue;
    if (Math.abs(_obbFindLocal.y) > b.hy + pad) continue;
    if (Math.abs(_obbFindLocal.z) > b.hz + pad) continue;
    /* Inside (or within `pad` of any face). Pick the closest face by
     * the smallest (h - |local|) on each axis. */
    const dx = b.hx - Math.abs(_obbFindLocal.x);
    const dy = b.hy - Math.abs(_obbFindLocal.y);
    const dz = b.hz - Math.abs(_obbFindLocal.z);
    let axis;
    let sign;
    if (dx <= dy && dx <= dz) {
      axis = 0; sign = _obbFindLocal.x >= 0 ? 1 : -1;
    } else if (dy <= dz) {
      axis = 1; sign = _obbFindLocal.y >= 0 ? 1 : -1;
    } else {
      axis = 2; sign = _obbFindLocal.z >= 0 ? 1 : -1;
    }
    _rayHitNormalLocal.set(
      axis === 0 ? sign : 0,
      axis === 1 ? sign : 0,
      axis === 2 ? sign : 0,
    );
    outHit.normal.copy(_rayHitNormalLocal).applyMatrix3(b.m).normalize();
    /* Snap the impact point to the nearest face (move outward along
     * the local axis until the local coord equals ±h, then transform
     * back to world). This avoids the decal sinking into the wall. */
    if (axis === 0) _obbFindLocal.x = sign * b.hx;
    else if (axis === 1) _obbFindLocal.y = sign * b.hy;
    else _obbFindLocal.z = sign * b.hz;
    outHit.point.copy(_obbFindLocal).applyMatrix3(b.m);
    outHit.point.x += b.cx; outHit.point.y += b.cy; outHit.point.z += b.cz;
    outHit.box = b;
    return true;
  }
  return false;
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

/* ── Vision-cone wall-truncation ────────────────────────────────────────
 *
 * Vision cones are a readable “where is this thing looking?” cue.
 * Gameplay LOS already uses `hasLineOfSight`; the mesh must not lie
 * about coverage through solid geometry.
 *
 * A single ray down the bore only shortens the cone on-axis — the
 * wide mantle still slices through nearby walls. We therefore cast
 * the bore plus several directions on the cone mantle (same opening
 * half-angle as the rendered cone) and scale length by the tightest
 * limit: the cone never extends past the first hit on any of those
 * rays (conservative, cheap, no custom shaders).
 *
 * Snitch: the cone mesh is rotated so its length follows local +Y;
 * we take that axis from the cone’s world matrix, not the body +Z. */
const _coneTruncOrigin = new THREE.Vector3();
const _coneTruncDir = new THREE.Vector3();
const _coneApexZero = new THREE.Vector3(0, 0, 0);
/* Snitch cone is offset slightly forward + above the body (see
 * `_buildSnitchVisuals` for the matching `cone.position`). Reused
 * each frame as the apex sample point for wall-truncation. */
const _coneApexSnitch = new THREE.Vector3(0, 0.07, 0.07);
const _vconeApexW = new THREE.Vector3();
const _vconeFwdW = new THREE.Vector3();
const _vconeR = new THREE.Vector3();
const _vconeU = new THREE.Vector3();
const _vconeD = new THREE.Vector3();
const _vconeRayO = new THREE.Vector3();

/** Visible axis length (m) after OBB truncation.
 *  @param apexWorld   cone apex in world space
 *  @param unitForward unit bore direction in world space
 *  @param axisMaxLen  nominal cone height along the bore (m)
 *  @param surfaceHalfAngleRad  half-angle from bore to mantle (atan R/L)
 *  @param ringSegments 0 or omit → single bore ray only; else bore + rim rays */
function _coneOccludedLengthWorld(
  apexWorld,
  unitForward,
  axisMaxLen,
  surfaceHalfAngleRad,
  ringSegments,
) {
  const L = axisMaxLen;
  if (L < 0.02) return L;
  _vconeFwdW.copy(unitForward).normalize();
  const eps = 0.10;
  let sMin = 1;

  if (
    surfaceHalfAngleRad == null || !Number.isFinite(surfaceHalfAngleRad)
    || ringSegments == null || ringSegments <= 0
  ) {
    _vconeRayO.copy(apexWorld).addScaledVector(_vconeFwdW, eps);
    const t = rayHitWorld(_vconeRayO, _vconeFwdW, L + 12);
    if (!Number.isFinite(t)) return L;
    return Math.min(L, t + eps);
  }

  const beta = Math.min(
    Math.max(0.004, surfaceHalfAngleRad),
    1.52,
  );
  const cosB = Math.cos(beta);
  const sinB = Math.sin(beta);
  const slant = cosB > 1e-4 ? L / cosB : L;

  /* Bore ray. */
  _vconeRayO.copy(apexWorld).addScaledVector(_vconeFwdW, eps);
  let t = rayHitWorld(_vconeRayO, _vconeFwdW, L + 12);
  if (Number.isFinite(t) && t < L + 8) {
    sMin = Math.min(sMin, Math.max(0, t) / L);
  }

  /* Orthonormal plane for mantle directions. */
  _vconeU.set(0, 1, 0);
  _vconeR.crossVectors(_vconeU, _vconeFwdW);
  if (_vconeR.lengthSq() < 1e-8) {
    _vconeR.set(1, 0, 0);
    _vconeR.cross(_vconeFwdW);
  }
  _vconeR.normalize();
  _vconeU.crossVectors(_vconeFwdW, _vconeR).normalize();

  const n = Math.max(3, ringSegments | 0);
  for (let k = 0; k < n; k++) {
    const phi = (Math.PI * 2 * (k + 0.5)) / n;
    _vconeD.copy(_vconeFwdW).multiplyScalar(cosB)
      .addScaledVector(_vconeR, sinB * Math.cos(phi))
      .addScaledVector(_vconeU, sinB * Math.sin(phi))
      .normalize();
    _vconeRayO.copy(apexWorld).addScaledVector(_vconeD, eps);
    t = rayHitWorld(_vconeRayO, _vconeD, slant + 12);
    if (Number.isFinite(t) && t < slant + 8) {
      sMin = Math.min(sMin, Math.max(0, t) / slant);
    }
  }

  return L * sMin;
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
    case DRONE_TYPE_SNITCH:   return buildSnitchDroneMesh();
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
    /* `componentRef` is a back-pointer used by decorative meshes that
     * geometrically belong to a damageable component but live in the
     * pivot tree as siblings (e.g. an HQ pod's hemispherical front
     * cap, which players naturally aim at when shooting "at the
     * launcher"). Without this hop, findComponent would walk past
     * the cap up to the pivot/group, find no `kind`, and the AA hit
     * handler would fall back to `aa.body` — meaning shots at a pod
     * cap damaged the top cap instead of the pod. */
    if (n.userData && n.userData.componentRef) return n.userData.componentRef;
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
    /* Snitch: HQ dispatches nearest scout to this world point (arrow origin). */
    this._hqInvestigatePos = null;
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
      /* Kamikaze self-destruct — also a drone being destroyed, so it
       * uses the same crash sample as the regular death. die() below
       * fires its own death SFX too, giving the kamikaze a layered
       * "warhead pop + structural crash" feel that's intentional. */
      playOneShotAt(
        audioBuffers_.droneDeath || audioBuffers_.explosion,
        this.group.position,
        { volume: 1.0, refDistance: 10 },
      );
      /* Force-die: an extra-spectacular explosion via die(). */
      this.die();
      return true;
    }
    return false;
  }

  /* ── damage ────────────────────────────────────────────────────────── */

  takeDamage(component, dmg, hitDir, attackerWorld) {
    if (this.dead) return null;

    /* Ally-shield protection: if this drone is inside any LIVING shielder's
     * dome AND that shielder's emitter is intact, the dome eats the hit.
     * The shielder itself is never protected by its own dome (must be
     * killable). */
    if (this.type !== DRONE_TYPE_SHIELD && _underAnyShieldDome(this)) {
      /* Visual feedback: pulse the dome the player tried to shoot
       * through, but no actual damage. */
      _pulseShieldDome(this.group.position);
      flashComponentHit(component);  // brief white flash so the player gets some feedback
      return null;
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
    /* Spatial metal-thunk one-shot from the drone's position. Three MP3
     * variants are loaded asynchronously; we pick one at random per hit
     * so a sustained burst doesn't sound like a single sound on repeat.
     * Falls back to the procedural `hit` buffer if no sample has loaded
     * yet. */
    playMetalHitAt(this.group.position, { volume: 0.85, refDistance: 4 });

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

    let arrowFollow = null;
    if (component.userData.hp <= 0 && !component.userData.broken) {
      arrowFollow = this.breakComponent(component);
    }
    return arrowFollow;
  }

  /** Apply damage to a SPECIFIC component, bypassing the chip /
   *  shield armour-redirect that `takeDamage()` performs for normal
   *  arrow shots. AOE blasts (explosive arrows, AA missile shrapnel)
   *  use this instead — a 4 m radius explosion logically washes over
   *  the whole drone, so it'd be wrong for a single intact chip to
   *  absorb the entire blast and leave the body untouched. The shield
   *  dome (dome-emitter ally protection) is still respected at the
   *  caller level — this method assumes you already decided this drone
   *  is in the blast and not under a friendly dome.
   *
   *  Mirrors the bookkeeping `takeDamage` does (crit multiplier,
   *  flash, break check) but skips the redirect chain and the
   *  per-shot side effects (state-disrupt, knock-back, aim-snap) —
   *  the AOE caller applies those once for the whole drone, not once
   *  per component. */
  applyAOEDamage(component, dmg) {
    if (this.dead || component.userData.broken) return;
    const crit = component.userData.crit || 1.0;
    component.userData.hp -= dmg * crit;
    flashComponentHit(component);
    if (component.userData.hp <= 0 && !component.userData.broken) {
      this.breakComponent(component);
    }
  }

  breakComponent(c) {
    if (c.userData.broken) return null;
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
      c.raycast = function () {};
      return this._spawnComponentDebris(c);
    }

    /* Body chip: same idea — pop off and become debris, exposing the
     * body face behind. */
    if (kind === "chip") {
      c.visible = false;
      c.raycast = function () {};
      return this._spawnComponentDebris(c);
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
      return c;
    }

    /* Emitter (shielder): hide the pillar AND the dome. The dome was
     * a child of the drone, so we walk userData.dome and toggle. */
    if (kind === "emitter") {
      c.visible = false;
      const dome = this.group.userData.dome;
      if (dome) dome.visible = false;
      return this._spawnComponentDebris(c);
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
      return c;
    }

    /* Power core or main body broken — death. */
    if (kind === "power" || kind === "body") {
      this.die();
    }
    return null;
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
    return frag;
  }

  /** Snitch only: an HQ that took fire orders this drone to scout `worldPos`. */
  requestHqInvestigate(worldPos) {
    if (this.type !== DRONE_TYPE_SNITCH || this.dead || !worldPos) return;
    if (!Number.isFinite(worldPos.x + worldPos.y + worldPos.z)) return;
    if (!this._hqInvestigatePos) this._hqInvestigatePos = new THREE.Vector3();
    this._hqInvestigatePos.copy(worldPos);
    this._hqInvestigatePos.y = Math.max(0.6, worldPos.y);
    this.state = "SCOUT";
    this.stateTime = 0;
    this.surveyChangeIn = 999;
  }

  /* ── Snitch FSM (low-altitude scout) ────────────────────────────────
   *
   * Snitches don't fight — they're spotters. Per-frame:
   *   1. Tick rotors + LED + alertness audio (shared with regular
   *      drones so the visual loop matches).
   *   2. State machine:
   *        PATROL       → drifts at SNITCH_DEFAULT_ALT, no LOS to
   *                       player. Picks new wander targets every
   *                       few seconds.
   *        SCOUT        → an HQ was shot; fly to the shot origin at
   *                       patrol altitude, then resume PATROL with
   *                       LKP seeded so wander bias pulls around that
   *                       area — encourages snitch to spot the shooter
   *                       and relay for artillery.
   *        SPOTTED      → has LOS to player. Climbs to relay
   *                       altitude; vision cone aims at the artillery
   *                       ground strike point while broadcasting
   *                       lastSpottedT to AAs in range.
   *        FLEE         → was hit. Backs off from the player and
   *                       drops back to PATROL after a beat.
   *   3. Same applySteering call as regular drones, so collision
   *      avoidance + separation + lift-from-rotors all work.
   */
  _tickSnitch(dt, playerHead, playerSpeed) {
    /* Same rotor + alertness + audio housekeeping as regular drones,
     * stripped of the engineer/kamikaze-specific blocks. */
    this.stateTime += dt;
    this.rotorPhase += dt * 40;
    for (const r of this.group.userData.rotors) {
      if (r.userData.spinning && r.userData.blade) {
        r.userData.blade.rotation.y = this.rotorPhase;
      }
    }
    this.updateAlertnessAudio();

    /* Clear last frame's relay target — the SPOTTED branch will
     * re-acquire if conditions still hold. Without this, a snitch
     * that transitions SPOTTED → PATROL keeps the beam pointing at
     * a stale AA. */
    this._relayedAA = null;

    /* Perception — short range, gated to within the visible cone.
     * The snitch faces its velocity (via faceVelocity below); we
     * compute "is the player in front of me?" using the snitch's
     * world forward (+Z applied to the body's world quaternion).
     * We use yaw-only forward (Y component zeroed) so the snitch's
     * banking pitch doesn't pull the cone off-axis. */
    const dronePos = this.group.position;
    const distXZ = Math.hypot(playerHead.x - dronePos.x, playerHead.z - dronePos.z);
    let sees = false;
    if (distXZ < SNITCH_VIEW_RANGE) {
      this.group.updateMatrixWorld(true);
      _aaTmp.set(0, 0, 1).applyQuaternion(this.group.getWorldQuaternion(_aaQuat));
      _aaTmp.y = 0;
      if (_aaTmp.lengthSq() > 1e-6) _aaTmp.normalize();
      _aaTmp2.copy(playerHead).sub(dronePos);
      _aaTmp2.y = 0;
      const dXZ = _aaTmp2.length();
      if (dXZ > 1e-3) {
        _aaTmp2.divideScalar(dXZ);
        const cosHalf = Math.cos(SNITCH_VIEW_HALF_ANGLE_DEG * Math.PI / 180);
        if (_aaTmp.dot(_aaTmp2) >= cosHalf
            && hasLineOfSight(dronePos, playerHead, SNITCH_VIEW_RANGE)) {
          sees = true;
        }
      }
    }
    if (sees) {
      this.lkp.copy(playerHead);
      this.haveLkp = true;
      this.timeSinceLOS = 0;
    } else {
      this.timeSinceLOS += dt;
    }

    let movementMaxSpeed = STEERING_MAX_SPEED * 0.7;
    let turretTarget = null;
    if (this.state === "SCOUT") {
      if (!this._hqInvestigatePos) {
        this.state = "PATROL";
        this.stateTime = 0;
        this.surveyChangeIn = 0;
      } else {
        this.targetPos.set(
          this._hqInvestigatePos.x,
          SNITCH_DEFAULT_ALT,
          this._hqInvestigatePos.z,
        );
        this.applySteering(dt, STEERING_MAX_SPEED * 0.95);
        if (sees) {
          this.state = "SPOTTED";
          this.stateTime = 0;
          this._hqInvestigatePos = null;
        } else {
          const dXZ = Math.hypot(
            dronePos.x - this._hqInvestigatePos.x,
            dronePos.z - this._hqInvestigatePos.z,
          );
          if (dXZ < 5.5 || this.stateTime > 28) {
            this.lkp.copy(this._hqInvestigatePos);
            this.haveLkp = true;
            this._hqInvestigatePos = null;
            this.state = "PATROL";
            this.stateTime = 0;
            this.surveyChangeIn = 0;
          }
        }
      }
    } else if (this.state === "SURVEY" || !this.state || this.state === "PATROL") {
      this.state = "PATROL";
      /* Wander pick — fresh target near the player's last-seen XZ
       * (so we tend to drift toward where action is) at default low
       * altitude. We re-pick when arrived OR every few seconds. */
      this.surveyChangeIn -= dt;
      if (this.surveyChangeIn <= 0
          || dronePos.distanceTo(this.targetPos) < 2.0) {
        const anchor = this.haveLkp ? this.lkp : playerHead;
        const ang = Math.random() * Math.PI * 2;
        const r = 12 + Math.random() * 30;
        this.targetPos.set(
          anchor.x + Math.cos(ang) * r,
          SNITCH_DEFAULT_ALT,
          anchor.z + Math.sin(ang) * r,
        );
        this.surveyChangeIn = 2.5 + Math.random() * 2.5;
      }
      if (sees) {
        this.state = "SPOTTED";
        this.stateTime = 0;
      }
      this.applySteering(dt, movementMaxSpeed);
    } else if (this.state === "SPOTTED") {
      /* Climb to relay altitude — pick a target above the player
       * by a margin so we get LOS to the launchers above the
       * skyline. */
      const targetY = Math.max(SNITCH_RELAY_ALT_MIN, _missileCruiseAlt - 6);
      this.targetPos.set(playerHead.x, targetY, playerHead.z);
      this.applySteering(dt, STEERING_MAX_SPEED * 1.0);
      turretTarget = playerHead;

      /* If we have altitude AND LOS to the player, broadcast to every
       * AA in relay range that has LOS to us. The relay only
       * succeeds when snitch ↔ player AND snitch ↔ AA are both
       * unobstructed. We additionally remember the NEAREST relayed
       * AA so the visible beam can render between snitch and AA. */
      this._relayedAA = null;
      if (sees && dronePos.y > SNITCH_RELAY_ALT_MIN - 4) {
        let nearest = null;
        let nearestDist = Infinity;
        for (const aa of antiair_) {
          if (aa.dead) continue;
          aa.pivot.getWorldPosition(_aaTmp);
          const dToAA = dronePos.distanceTo(_aaTmp);
          if (dToAA > SNITCH_RELAY_RANGE) continue;
          if (!hasLineOfSight(dronePos, _aaTmp, SNITCH_RELAY_RANGE)) continue;
          aa.lastSpottedT = performance.now() / 1000;
          aa.lkp.copy(playerHead);
          if (dToAA < nearestDist) {
            nearestDist = dToAA;
            nearest = aa;
          }
        }
        this._relayedAA = nearest;
        /* One ballistic volley from the nearest relayed HQ — avoids every
         * tower in range firing at once. */
        if (nearest) nearest.trySnitchArtilleryStrike(playerHead);
      }

      /* Lost LOS for a while → drop back to patrol. */
      if (this.timeSinceLOS > 4) {
        this.state = "PATROL";
        this.stateTime = 0;
        this.surveyChangeIn = 0;     // re-pick a target next frame
      }
    } else if (this.state === "FLEE" || this.state === "EVADE") {
      /* Backed off from the player after a hit. */
      this.applySteering(dt, STEERING_MAX_SPEED * 1.2);
      if (this.stateTime > 1.5) {
        this.state = "PATROL";
        this.stateTime = 0;
        this.surveyChangeIn = 0;
      }
    }

    /* Body always faces flight direction — no turret of its own. */
    this.faceVelocity(dt);
    /* Apply final body rotation. */
    this.group.rotation.set(this.aimPitch, this.aimYaw, this.aimRoll, "YXZ");
    this._turretTargetThisFrame = turretTarget;

    /* ── Vision-cone + strike ring (artillery aim point) ─────────── */
    let aimBomb = false;
    if (this.state === "SPOTTED") {
      _snitchArtHintW.copy(playerHead);
      _snitchArtHintW.y = Math.max(0.45, _snitchArtHintW.y - 1.15);
      _resolveArtilleryGroundImpact(_snitchBombGroundW, _snitchArtHintW);
      aimBomb = true;
    }
    const cone = this.group.userData.snitchCone;
    if (cone) {
      let coneHex;
      let coneOpac;
      if (aimBomb) {
        coneHex = 0xff2020;
        coneOpac = 0.48;
      } else if (this._relayedAA) {
        coneHex = 0xff4444;
        coneOpac = 0.2;
      } else if (sees) {
        coneHex = 0xffaa44;
        coneOpac = 0.18;
      } else {
        coneHex = 0x55ff77;
        coneOpac = 0.1;
      }
      cone.material.color.setHex(coneHex);
      cone.material.opacity = coneOpac;
      this.group.updateMatrixWorld(true);
      _vconeApexW.copy(_coneApexSnitch).applyMatrix4(this.group.matrixWorld);
      if (aimBomb) {
        _vconeFwdW.subVectors(_snitchBombGroundW, _vconeApexW);
        if (_vconeFwdW.lengthSq() > 0.0025) {
          _vconeFwdW.normalize();
          this.group.getWorldQuaternion(_aaQuat);
          _aaQuatTarget.copy(_aaQuat).invert();
          _snitchBombDirParent.copy(_vconeFwdW).applyQuaternion(_aaQuatTarget);
          if (_snitchBombDirParent.lengthSq() > 1e-8) {
            cone.quaternion.setFromUnitVectors(
              _snitchConeFromLocalZ,
              _snitchBombDirParent.normalize(),
            );
          } else {
            cone.quaternion.identity();
          }
        } else {
          cone.quaternion.identity();
        }
      } else {
        cone.quaternion.identity();
      }
      cone.updateMatrixWorld(true);
      const halfRad = (SNITCH_VIEW_HALF_ANGLE_DEG * Math.PI) / 180;
      let occLen;
      if (aimBomb) {
        /* Reach the strike column from altitude; skip OBB truncation so
         * façades don’t clip the “laser paint” short of the aim point. */
        const d = _vconeApexW.distanceTo(_snitchBombGroundW);
        occLen = Math.min(SNITCH_ART_CONE_LEN_MAX, d + 0.75);
      } else {
        _vconeFwdW.set(0, 0, 1).transformDirection(cone.matrixWorld);
        occLen = _coneOccludedLengthWorld(
          _vconeApexW, _vconeFwdW, SNITCH_VIEW_RANGE, halfRad, VISION_CONE_TRUNC_RING_SEGS,
        );
      }
      const zScale = occLen / SNITCH_VIEW_RANGE;
      if (aimBomb) {
        const narrow = 0.5;
        cone.scale.set(narrow, narrow, zScale);
      } else {
        cone.scale.set(1, 1, zScale);
      }
    }
    const strikeRing = this.group.userData.snitchStrikeRing;
    if (strikeRing) {
      if (this.state === "SPOTTED") {
        strikeRing.position.copy(_snitchBombGroundW);
        strikeRing.position.y = Math.max(0.08, strikeRing.position.y + 0.14);
        strikeRing.rotation.x = -Math.PI / 2;
        strikeRing.visible = true;
        const pulse = 0.9 + 0.1 * Math.sin(performance.now() * 0.007);
        strikeRing.scale.setScalar(pulse);
        if (strikeRing.material) {
          strikeRing.material.opacity = Math.min(0.88, 0.52 + 0.28 * pulse);
        }
      } else {
        strikeRing.visible = false;
      }
    }
    /* Beam: visible only while we have a successful relay this
     * frame. The line's first vertex is fixed at the eye (drone-
     * local 0,0.07,0); we update the second vertex to point at the
     * relayed AA's pivot in DRONE-LOCAL space so the line follows
     * the snitch through transforms. */
    const beam = this.group.userData.snitchBeam;
    if (beam) {
      if (this._relayedAA) {
        this._relayedAA.pivot.getWorldPosition(_aaTmp);
        /* World → drone-local. */
        this.group.updateMatrixWorld(true);
        this.group.worldToLocal(_aaTmp);
        const arr = beam.geometry.attributes.position.array;
        arr[3] = _aaTmp.x;
        arr[4] = _aaTmp.y;
        arr[5] = _aaTmp.z;
        beam.geometry.attributes.position.needsUpdate = true;
        beam.visible = true;
      } else {
        beam.visible = false;
      }
    }

    /* Reset wobble timer if it lingered. */
    if (this.wobbleTimer > 0) this.wobbleTimer -= dt;

    /* Snitch death cue — same component → break pipeline applies via
     * takeDamage, called from the player projectile path. We don't
     * need to do anything per-frame here. */
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
    const strikeRing = this.group.userData.snitchStrikeRing;
    if (strikeRing) {
      scene_.remove(strikeRing);
      strikeRing.geometry?.dispose?.();
      strikeRing.material?.dispose?.();
      this.group.userData.snitchStrikeRing = null;
    }
    /* Drone death SFX — sampled crash impact when available, falling
     * back to the procedural explosion until the MP3 loads. Spatial,
     * so the player can locate which drone went down. */
    playOneShotAt(
      audioBuffers_.droneDeath || audioBuffers_.explosion,
      this.group.position,
      { volume: 1.0, refDistance: 6 },
    );
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
    /* Snitches are passive recon and shouldn't bloat the kill score —
     * the player gets them as collateral while neutralising AAs. */
    if (this.type !== DRONE_TYPE_SNITCH) kills_++;
  }

  /* ── per-frame update ──────────────────────────────────────────────── */

  update(dt, playerHead, playerBody, playerSpeed) {
    if (this.dead) return;

    /* Snitch drones run a completely different FSM (low-altitude
     * patrol → climb to relay → spot for nearest anti-air). We don't
     * use the wave/standoff/attack ATTACK loop because snitches are
     * never the firing party. The body still ticks rotors + alertness
     * audio, so we run those first via _tickSnitch and return. */
    if (this.type === DRONE_TYPE_SNITCH) {
      this._tickSnitch(dt, playerHead, playerSpeed);
      return;
    }

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
     * tightens onto you in ATTACK → a long wide red lash in EVADE.
     *
     * Length is clamped per-frame with bore + mantle raycasts vs world
     * OBBs so the cone cannot read as seeing through solid geometry. */
    const cone = this.group.userData.visionCone;
    if (cone) {
      const aggressive = this.isAggressive();
      const lengthMul = aggressive ? VISION_AGGRO_LENGTH_MULT : 1;
      const widthMul = THREE.MathUtils.lerp(1, VISION_NARROW_RATIO, this.aimFocus);
      const desiredLen = VISION_CONE_LENGTH * lengthMul;
      const parent = cone.parent;
      parent.updateMatrixWorld(true);
      _vconeApexW.copy(_coneApexZero).applyMatrix4(parent.matrixWorld);
      _vconeFwdW.set(0, 0, 1).transformDirection(parent.matrixWorld);
      const halfAng = Math.atan2(
        VISION_CONE_BASE_RADIUS * widthMul,
        VISION_CONE_LENGTH * lengthMul,
      );
      const occLen = _coneOccludedLengthWorld(
        _vconeApexW, _vconeFwdW, desiredLen, halfAng, VISION_CONE_TRUNC_RING_SEGS,
      );
      cone.scale.set(widthMul, widthMul, occLen / VISION_CONE_LENGTH);
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

/* Reusable rich-hit record for projectile→world impacts. Tracks
 * whether the hit was on the world (vs the player) so we only drop
 * decals/chips on world contacts. */
const _projWallHit = {
  t: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  box: null,
};
function updateProjectiles(dt, playerHead) {
  for (let i = projectiles_.length - 1; i >= 0; i--) {
    const p = projectiles_[i];
    /* `onPlayerDeath()` clears this array while we may still be mid-loop
     * (projectile hits player → HP 0 → synchronous wipe). Skip holes. */
    if (!p) continue;
    p.ttl -= dt;
    let hit = false;
    let hitWorld = false;

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
        if (pointInsideAnyOBB(p.mesh.position, 0.07)) {
          hit = true;
          hitWorld = true;
        }
        if (!hit) {
          const d2 = p.mesh.position.distanceToSquared(playerHead);
          if (d2 < (PLAYER_HIT_RADIUS + 0.18) ** 2) {
            damagePlayer(p.damage);
            hit = true;
          }
        }
      }
      if (hit) {
        playExplosionImpactAt(p.mesh.position, { volume: 0.7, refDistance: 6 });
      }
    } else if (p.kind === "aamissile") {
      /* Two-stage anti-air missile.
       *   CLIMB  → low turn rate, velocity biased upward to clear the
       *            launcher tower silhouette.
       *   HOMING → full turn rate, accelerates toward the player. */
      const v = p.velocity;
      let speedNow = v.length() || p.speed;
      if (p.phase === "CLIMB") {
        if (p.mesh.position.y >= p.cruiseAlt) {
          /* Switch to homing — bump turn rate, give a fresh kick along
           * the flight axis so the missile doesn't pause at apex. */
          p.phase = "HOMING";
          p.turnRate = AAMISSILE_TURN_RATE;
          /* Slightly accelerate to cruise speed in case lift drag
           * shaved a few m/s during ascent. */
          speedNow = Math.max(speedNow, p.speed);
        } else {
          /* Bias velocity toward straight up at the climb turn rate. */
          _missileSteer.set(0, 1, 0);
          if (speedNow > 0.001) {
            v.divideScalar(speedNow);
            const angle = v.angleTo(_missileSteer);
            const maxStep = p.turnRate * dt;
            const t = Math.min(1, angle > 0 ? maxStep / angle : 1);
            v.lerp(_missileSteer, t).normalize().multiplyScalar(speedNow);
          }
        }
      }
      if (p.phase === "HOMING") {
        /* Standard pure-pursuit homing on the player. */
        _missileSteer.copy(playerHead).sub(p.mesh.position);
        const dToTarget = _missileSteer.length();
        if (dToTarget > 0.001) _missileSteer.divideScalar(dToTarget);
        if (speedNow > 0.001) {
          v.divideScalar(speedNow);
          const angle = v.angleTo(_missileSteer);
          const maxStep = p.turnRate * dt;
          const t = Math.min(1, angle > 0 ? maxStep / angle : 1);
          v.lerp(_missileSteer, t).normalize().multiplyScalar(speedNow);
        }
      }
      /* Orient mesh along velocity. */
      if (speedNow > 0.001) {
        _missileNorm.copy(v).divideScalar(speedNow);
        _tracerQuat.setFromUnitVectors(_tracerUp, _missileNorm);
        p.mesh.quaternion.copy(_tracerQuat);
      }
      /* Step + collision (player + drones for friendly fire + walls). */
      const stepCount = 3;
      let hitDrone = null;
      for (let s = 0; s < stepCount && !hit; s++) {
        p.mesh.position.addScaledVector(v, dt / stepCount);
        if (pointInsideAnyOBB(p.mesh.position, 0.10)) {
          hit = true;
          hitWorld = true;
          break;
        }
        const d2 = p.mesh.position.distanceToSquared(playerHead);
        if (d2 < (PLAYER_HIT_RADIUS + 0.30) ** 2) {
          hit = true;
          break;
        }
        /* Drone friendly-fire: did we hit a drone hull this sub-step? */
        for (const dr of drones_) {
          if (dr.dead) continue;
          const dd2 = p.mesh.position.distanceToSquared(dr.group.position);
          if (dd2 < 0.55 * 0.55) {
            hit = true;
            hitDrone = dr;
            break;
          }
        }
      }
      if (hit) {
        /* Always detonate AOE so a near-miss on the player still
         * radiates damage to nearby drones (and vice-versa). The
         * blast does NOT damage the launching turret — owner check
         * inside _detonateAOE is implicit (anti-air missiles pass
         * `antiair: 0` so no AA damage). */
        _detonateAOE(p.mesh.position, AAMISSILE_BLAST_RADIUS, {
          drone: AAMISSILE_BLAST_DAMAGE,
          antiair: 0,
          player: AAMISSILE_DAMAGE,
        }, 6);
        /* Direct hit on a specific drone gets a small bonus damage
         * application (the AOE already accounts for it via radius
         * falloff, so this just guarantees the drone we punched
         * through doesn't survive on a 0% radius technicality). */
        if (hitDrone) {
          const body = hitDrone.group.userData.findKind("body");
          if (body && !body.userData.broken) {
            const dir = new THREE.Vector3()
              .subVectors(hitDrone.group.position, p.mesh.position)
              .normalize();
            hitDrone.takeDamage(body, AAMISSILE_BLAST_DAMAGE * 0.3, dir, p.mesh.position);
          }
        }
      }
    } else if (p.kind === "aaartillery") {
      const v = p.velocity;
      const ix = p.impact.x;
      const iy = p.impact.y;
      const iz = p.impact.z;
      const apex = p.apex;
      /* Legacy in-flight rockets (no apex): fall back to pure drop. */
      if (!apex) {
        p.phase = "DROP";
        v.set(0, -HQ_ARTILLERY_DROP_SPEED, 0);
      } else if (p.phase === "LOFT") {
        _missileNorm.subVectors(apex, p.mesh.position);
        const dA = _missileNorm.length();
        if (dA < 2.2 || p.mesh.position.y >= apex.y - 0.35) {
          p.phase = "DROP";
          v.set(0, -HQ_ARTILLERY_DROP_SPEED, 0);
          _tracerQuat.setFromUnitVectors(_tracerUp, _artGroundRayDirDown);
          p.mesh.quaternion.copy(_tracerQuat);
        } else {
          _missileNorm.multiplyScalar(1 / dA).multiplyScalar(HQ_ARTILLERY_LOFT_SPEED);
          v.copy(_missileNorm);
          const vLen = v.length();
          if (vLen > 0.08) {
            _missileNorm.copy(v).divideScalar(vLen);
            _tracerQuat.setFromUnitVectors(_tracerUp, _missileNorm);
            p.mesh.quaternion.copy(_tracerQuat);
          }
        }
      } else {
        v.set(0, -HQ_ARTILLERY_DROP_SPEED, 0);
        _tracerQuat.setFromUnitVectors(_tracerUp, _artGroundRayDirDown);
        p.mesh.quaternion.copy(_tracerQuat);
      }
      p.directPlayerArtilleryHit = false;
      const stepCount = 6;
      for (let s = 0; s < stepCount && !hit; s++) {
        p.mesh.position.addScaledVector(v, dt / stepCount);
        const h = Math.hypot(p.mesh.position.x - ix, p.mesh.position.z - iz);
        /* Ground fuse only on the terminal drop. */
        if (p.phase === "DROP" && h < HQ_ARTILLERY_FUSE_HORIZ_M
            && p.mesh.position.y <= iy + 0.55 && v.y < -0.2) {
          hit = true;
          break;
        }
        /* Building hits count only inside the narrow strike column so
         * shells don't air-burst against unrelated facades. */
        if (pointInsideAnyOBB(p.mesh.position, 0.14)) {
          const hcol = Math.hypot(p.mesh.position.x - ix, p.mesh.position.z - iz);
          if (hcol < HQ_ARTILLERY_COLUMN_R) {
            hit = true;
            hitWorld = true;
            break;
          }
        }
        const d2p = p.mesh.position.distanceToSquared(playerHead);
        if (d2p < (PLAYER_HIT_RADIUS + 0.32) ** 2) {
          hit = true;
          p.directPlayerArtilleryHit = true;
          break;
        }
        for (const dr of drones_) {
          if (dr.dead) continue;
          const dd2 = p.mesh.position.distanceToSquared(dr.group.position);
          if (dd2 < 0.62 * 0.62) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        if (p.directPlayerArtilleryHit && playerInvuln_ <= 0) {
          damagePlayer(HQ_ARTILLERY_DIRECT_DAMAGE);
        }
        _detonateAOE(p.mesh.position, HQ_ARTILLERY_BLAST_RADIUS, {
          drone: HQ_ARTILLERY_BLAST_DAMAGE,
          antiair: 0,
          player: p.directPlayerArtilleryHit
            ? 0
            : HQ_ARTILLERY_DIRECT_DAMAGE * 0.62,
        }, 7, p.directPlayerArtilleryHit ? undefined : {
          artilleryGateCenter: p.impact,
          artilleryGateRadius: HQ_ARTILLERY_PLAYER_NEAR_M,
        });
      }
    } else if (p.kind === "aamg") {
      const v = p.velocity;
      const spd = v.length();
      const stepCount = 8;
      for (let s = 0; s < stepCount && !hit; s++) {
        p.mesh.position.addScaledVector(v, dt / stepCount);
        if (pointInsideAnyOBB(p.mesh.position, 0.028)) {
          hit = true;
          hitWorld = true;
          spawnMetalImpactSparks(p.mesh.position, v);
          break;
        }
        const d2p = p.mesh.position.distanceToSquared(playerHead);
        if (d2p < (PLAYER_HIT_RADIUS + 0.11) ** 2) {
          if (playerInvuln_ <= 0) damagePlayer(p.damage);
          hit = true;
          spawnMetalImpactSparks(p.mesh.position, v);
          break;
        }
        for (const dr of drones_) {
          if (dr.dead) continue;
          const dd2 = p.mesh.position.distanceToSquared(dr.group.position);
          if (dd2 < 0.38 * 0.38) {
            const body = dr.group.userData.findKind("body");
            if (body && !body.userData.broken) {
              const dir = _missileSteer.subVectors(dr.group.position, p.mesh.position);
              if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
              else dir.normalize();
              dr.takeDamage(body, p.damage * 0.85, dir, p.mesh.position);
            }
            hit = true;
            spawnMetalImpactSparks(p.mesh.position, v);
            break;
          }
        }
      }
      if (spd > 0.05) {
        _missileNorm.copy(v).divideScalar(spd);
        _tracerQuat.setFromUnitVectors(_tracerUp, _missileNorm);
        p.mesh.quaternion.copy(_tracerQuat);
      }
    } else if (p.kind === "sniper") {
      /* Sniper shot: long fast travel with many substeps for hit
       * precision. Visual cylinder slides along the path. */
      const stepCount = 8;
      for (let s = 0; s < stepCount && !hit; s++) {
        p.mesh.position.addScaledVector(p.velocity, dt / stepCount);
        if (pointInsideAnyOBB(p.mesh.position, 0.05)) {
          hit = true;
          hitWorld = true;
        }
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
        if (pointInsideAnyOBB(p.mesh.position, 0.05)) {
          hit = true;
          hitWorld = true;
        }
        if (!hit) {
          const d2 = p.mesh.position.distanceToSquared(playerHead);
          if (d2 < (PLAYER_HIT_RADIUS + DRONE_PROJECTILE_RADIUS) ** 2) {
            damagePlayer(p.damage);
            hit = true;
          }
        }
      }
    }

    /* Drone projectile struck a wall — drop a chip burst + decal at
     * the nearest face. obbContainingPoint snaps the impact point to
     * the surface (the projectile is up to ~7 cm inside the OBB at
     * this point) and gives us the outward normal. We use a slightly
     * larger pad than the per-projectile collision pad so the search
     * reliably succeeds. */
    if (hitWorld && obbContainingPoint(p.mesh.position, 0.10, _projWallHit)) {
      spawnSurfaceImpact(_projWallHit.point, _projWallHit.normal);
    }

    if (hit || p.ttl <= 0) {
      scene_.remove(p.mesh);
      if ((p.kind === "sniper" || p.kind === "aamg") && p.mesh.material) {
        p.mesh.material.dispose();
      }
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
  /* Spawn an explosion visual + spatialised impact sound. */
  playExplosionImpactAt(pos, { volume: 1.0, refDistance: 8 });
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

/** World point for explosive-arrow VFX + `_detonateAOE` (damage still
 *  uses this offset centre). `surfaceNormal` may be null (air burst). */
function _finalizeExplosiveArrowFxWorldPos(out, anchor, surfaceNormal, segDirUnit) {
  out.copy(anchor);
  if (surfaceNormal && surfaceNormal.lengthSq() > 1e-12) {
    _expFxN.copy(surfaceNormal).normalize();
    /* Outward normal should oppose flight into the solid. */
    if (_expFxN.dot(segDirUnit) > 0.06) _expFxN.negate();
    out.addScaledVector(_expFxN, EXPLOSIVE_ARROW_FX_SURFACE_BIAS);
    if (Math.abs(_expFxN.y) > 0.5) {
      out.y = Math.max(out.y, anchor.y + EXPLOSIVE_ARROW_FX_FLOOR_LIFT);
    }
  }
  out.addScaledVector(segDirUnit, -EXPLOSIVE_ARROW_FX_RAY_PULL);
  if (!surfaceNormal || surfaceNormal.lengthSq() < 1e-12) {
    out.y = Math.max(out.y, anchor.y + 0.38);
  }
  return out;
}

let _expArrowBlastGeo = null;
let _expRubbleGeo = null;
let _expRubbleMatBase = null;
function spawnExplosiveArrowBlastFx(worldPos, surfaceNormal) {
  playExplosionImpactAt(worldPos, { volume: 1.05, refDistance: 11 });
  if (!_expArrowBlastGeo) {
    _expArrowBlastGeo = new THREE.SphereGeometry(0.72, 20, 16);
  }
  if (!_expRubbleGeo) {
    _expRubbleGeo = new THREE.BoxGeometry(0.11, 0.09, 0.13);
  }
  const matBig = new THREE.MeshBasicMaterial({
    color: 0xff6618, transparent: true, opacity: 0.92,
    depthWrite: false, depthTest: false, toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const mBig = new THREE.Mesh(_expArrowBlastGeo, matBig);
  mBig.position.copy(worldPos);
  mBig.renderOrder = 30;
  scene_.add(mBig);
  debris_.push({
    mesh: mBig,
    velocity: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    ttl: 0.68,
    isExpArrowBlast: true,
  });
  const matCore = new THREE.MeshBasicMaterial({
    color: 0xffeecc, transparent: true, opacity: 0.75,
    depthWrite: false, depthTest: false, toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const mCore = new THREE.Mesh(_expArrowBlastGeo, matCore);
  mCore.position.copy(worldPos);
  mCore.scale.setScalar(0.55);
  mCore.renderOrder = 31;
  scene_.add(mCore);
  debris_.push({
    mesh: mCore,
    velocity: new THREE.Vector3(),
    spin: new THREE.Vector3(),
    ttl: 0.28,
    isExpArrowCore: true,
  });
  _ensureHitSparkResources();
  _rayPt.copy(_worldUp);
  if (surfaceNormal && surfaceNormal.lengthSq() > 1e-10) {
    _rayPt.copy(surfaceNormal).normalize();
  }
  for (let s = 0; s < 32; s++) {
    _missileSteer.copy(_rayPt);
    _missileSteer.x += (Math.random() - 0.5) * 2.4;
    _missileSteer.y += (Math.random() - 0.5) * 2.4;
    _missileSteer.z += (Math.random() - 0.5) * 2.4;
    if (_missileSteer.lengthSq() < 1e-8) _missileSteer.set(0, 1, 0);
    _missileSteer.normalize().multiplyScalar(3.5 + Math.random() * 9.5);
    const sm2 = new THREE.Mesh(_hitSparkGeo, _hitSparkMatBase.clone());
    sm2.position.copy(worldPos);
    scene_.add(sm2);
    debris_.push({
      mesh: sm2,
      velocity: _missileSteer.clone(),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 28,
        (Math.random() - 0.5) * 28,
        (Math.random() - 0.5) * 28,
      ),
      ttl: 0.35 + Math.random() * 0.45,
      isSpark: true,
    });
  }
  if (!_expRubbleMatBase) {
    _expRubbleMatBase = new THREE.MeshStandardMaterial({
      color: 0x353330, emissive: 0x1a1510, emissiveIntensity: 0.35,
      roughness: 0.92, metalness: 0.25,
    });
  }
  for (let r = 0; r < 20; r++) {
    const chunk = new THREE.Mesh(_expRubbleGeo, _expRubbleMatBase.clone());
    chunk.position.copy(worldPos);
    chunk.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    );
    scene_.add(chunk);
    _missileNorm.set(
      (Math.random() - 0.5) * 2.2,
      0.55 + Math.random() * 4.5,
      (Math.random() - 0.5) * 2.2,
    );
    debris_.push({
      mesh: chunk,
      velocity: _missileNorm.clone(),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
      ),
      ttl: 0.85 + Math.random() * 0.75,
      isExpRubble: true,
    });
  }
}

let _hitSparkGeo = null;
let _hitSparkMatBase = null;
function _ensureHitSparkResources() {
  if (_hitSparkGeo) return;
  _hitSparkGeo = new THREE.SphereGeometry(0.022, 5, 4);
  _hitSparkMatBase = new THREE.MeshBasicMaterial({
    color: 0xffddaa, transparent: true, opacity: 0.95,
    depthWrite: false, depthTest: false, toneMapped: false, blending: THREE.AdditiveBlending,
  });
}

/** Cheap additive sparks at arrow impact / metal hits (few meshes, short ttl). */
function spawnMetalImpactSparks(worldPos, outDir) {
  _ensureHitSparkResources();
  _rayPt.copy(_worldUp);
  if (outDir && outDir.lengthSq() > 1e-8) _rayPt.copy(outDir).normalize();
  for (let i = 0; i < 9; i++) {
    _missileSteer.copy(_rayPt);
    _missileSteer.x += (Math.random() - 0.5) * 1.6;
    _missileSteer.y += (Math.random() - 0.5) * 1.6;
    _missileSteer.z += (Math.random() - 0.5) * 1.6;
    if (_missileSteer.lengthSq() < 1e-8) _missileSteer.set(0, 1, 0);
    _missileSteer.normalize().multiplyScalar(2.2 + Math.random() * 4.5);
    const sm = new THREE.Mesh(_hitSparkGeo, _hitSparkMatBase.clone());
    sm.position.copy(worldPos);
    scene_.add(sm);
    debris_.push({
      mesh: sm,
      velocity: _missileSteer.clone(),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 24,
        (Math.random() - 0.5) * 24,
        (Math.random() - 0.5) * 24,
      ),
      ttl: 0.12 + Math.random() * 0.1,
      isSpark: true,
    });
  }
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

/* ── Archery (replaces the hitscan gun) ───────────────────────────────────
 *
 * Two-controller bow:
 *   • Bow visual is parented to the bow controller (default left hand).
 *     The A button on the right controller toggles which hand holds it.
 *   • Pulling the trigger on the OTHER hand auto-nocks an arrow on
 *     that controller and begins the draw — the user does NOT have to
 *     bring their hand to the string; trigger == "string grabbed".
 *   • Releasing the trigger fires an arrow with speed proportional to
 *     hand-to-hand distance, capped at ARROW_MAX_DRAW (~0.7 m).
 *   • Below ARROW_MIN_DRAW_TO_FIRE the release is a soft dry-fire —
 *     the nocked arrow disappears with no projectile, preventing
 *     accidental zero-power "phantom" shots that look broken.
 *
 * Arrows are PROJECTILE-physics'd, not hitscan: they have gravity,
 * finite speed, and a TTL. Each frame we raycast prev→cur against
 * drones (Three Raycaster) and the world OBB set (the same
 * collision_boxes the player uses for locomotion) and stick the arrow
 * at the earliest hit. Drone hits feed straight into the existing
 * `drone.takeDamage` pipeline — same component damage, same metal-hit
 * one-shot SFX, same snap-to-attacker behaviour as the gun. The only
 * differences from the hitscan gun are travel time, gravity, and the
 * visible arrow mesh.
 *
 * The bow-hand trigger is repurposed for grenades (so the draw and
 * grenade triggers never collide, regardless of which hand holds the
 * bow). VR-only — there is no desktop archery path. */

const ARCHERY_ENABLED = true;
const ARROW_MAX_DRAW = 0.70;            // metres of pull at which arrow reaches max speed
const ARROW_MIN_SPEED = 18;             // m/s at the minimum-draw release
const ARROW_MAX_SPEED = 70;             // m/s at full draw
const ARROW_MIN_DRAW_TO_FIRE = 0.10;    // shorter pulls = no shot (dry-fire safety)
const ARROW_GRAVITY = 9.8 * 0.4;        // 40% of real g — feels weighty without arching too soon at game ranges
const ARROW_TTL = 4.0;
const ARROW_LENGTH = 0.72;
const ARROW_RADIUS = 0.0055;
const ARROW_MAX_STUCK = 10;             // FIFO cap for stuck-arrow LRU
const ARCHERY_FIRE_INTERVAL = 0.15;     // floor between releases (draw time naturally throttles further)
/* Forward offset of the *aim point* from the bow controller — i.e.
 * where arrows spawn / fly from / are targeted toward. Distinct from
 * where the bow visual sits, so we can pull the bow body closer to
 * the player's hand without changing where the arrow appears. The
 * aim point always sits along the bow controller's local -Z (forward)
 * axis at this distance. */
const BOW_AIM_FORWARD = 0.10;

let bowHandedness_ = "left";
let bowGroup_ = null;
let bowAttachedTo_ = null;              // controller currently parenting the bow
let bowStringPositions_ = null;         // BufferAttribute for the 3-vertex string line
let nockedArrow_ = null;                // arrow shown on the draw hand while drawing
let drawing_ = false;
let drawT_ = 0;                         // seconds the trigger has been held this draw
let prevDrawTrigger_ = false;
let prevAButton_ = false;
let archeryFireCooldown_ = 0;
const arrows_ = [];                     // in-flight: { mesh, vel, ttl, prev }
const stuckArrows_ = [];                // FIFO of stuck arrows (in scene or under drone groups)

/* Bow-local positions (the bow's coordinate frame, *not* world).
 * Anchors must match the actual rendered TIP positions in the limb
 * curve (y = ±0.40, z = -0.04). The previous values (y = ±0.36,
 * z = +0.02) put the string visually at the back of the riser
 * instead of running tip-to-tip — that's why "the string is at the
 * center of the bow grip". The rest-position middle vertex sits on
 * the same line so the string is straight when not drawn. */
const _bowAnchorTop = new THREE.Vector3(0, 0.40, -0.04);
const _bowAnchorBot = new THREE.Vector3(0, -0.40, -0.04);
const _bowStringRest = new THREE.Vector3(0, 0, -0.04);

/* Scratch — reused per-frame to avoid Vec3/Quat allocations. */
const _bowWorld = new THREE.Vector3();
const _drawWorld = new THREE.Vector3();
const _arrowDir = new THREE.Vector3();
const _arrowTmp1 = new THREE.Vector3();
const _arrowTmp2 = new THREE.Vector3();
const _arrowFromZ = new THREE.Vector3(0, 0, 1);
const _drawLocal = new THREE.Vector3();
const _stringNockLocal = new THREE.Vector3();

function _drawHandedness() {
  return bowHandedness_ === "left" ? "right" : "left";
}

function _getControllerByHand(hand) {
  if (!renderer_?.xr) return null;
  for (let i = 0; i < 4; i++) {
    const c = renderer_.xr.getController(i);
    if (c?.userData?.handedness === hand) return c;
  }
  return null;
}

/** World-space "aim point" of the bow — the position arrows spawn
 *  from, are aimed toward during a draw, and the crosshair projects
 *  from. It's the bow controller's world position pushed forward by
 *  BOW_AIM_FORWARD along the controller's local -Z axis.
 *
 *  Critically this is INDEPENDENT of the bow's visual position. The
 *  bow group can be moved arbitrarily inside the controller (closer
 *  to the hand, further forward, etc.) without dragging the arrow's
 *  apparent position with it. Used everywhere we need an "aim from"
 *  point so draw / release / crosshair / nock all stay consistent.
 *
 *  Returns false only when the bow controller's handedness has not
 *  been reported yet (the first frames of an XR session before the
 *  connected event fires). */
function _getBowAimPos(out) {
  const ctrl = _getControllerByHand(bowHandedness_);
  if (!ctrl) return false;
  ctrl.updateMatrixWorld(true);
  ctrl.getWorldPosition(out);
  _fwdLocal.set(0, 0, -1);
  _fwdLocal.applyQuaternion(ctrl.getWorldQuaternion(_q0)).normalize();
  out.addScaledVector(_fwdLocal, BOW_AIM_FORWARD);
  return true;
}

/* ── Shared bow / arrow GPU resources ─────────────────────────────────── */

let _bowResources = null;
function _ensureBowResources() {
  if (_bowResources) return _bowResources;
  /* Recurve-shape limb path. Five control points → smooth-ish recurve.
   * Catmull tension 0.4 keeps the curve from dipping inward at the
   * tips. We extrude a small tube along it. Geometry stays at the
   * "nominal" 1× scale; the per-attachment 2× scale is applied on
   * the bow group so adjusting it later is a single-number knob. */
  const limbCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.40, -0.04),
    new THREE.Vector3(0, -0.20,  0.00),
    new THREE.Vector3(0,  0.00,  0.02),
    new THREE.Vector3(0,  0.20,  0.00),
    new THREE.Vector3(0,  0.40, -0.04),
  ], false, "catmullrom", 0.4);
  const limbGeo = new THREE.TubeGeometry(limbCurve, 32, 0.012, 8, false);
  /* Tactical matte-black bow body. Low metalness keeps it from
   * mirror-shining off the sun light; the slight roughness <1.0
   * leaves enough specular highlight that the curve of the limbs
   * still reads in low light, instead of dissolving into a flat
   * silhouette. */
  const limbMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0a, roughness: 0.5, metalness: 0.05,
  });
  const gripGeo = new THREE.BoxGeometry(0.024, 0.13, 0.04);
  const gripMat = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 0.4, metalness: 0.05,
  });
  /* String stays light on purpose. Against the now-black bow body a
   * black string would be invisible, killing the draw-deformation
   * feedback the player relies on while aiming. Real recurve strings
   * are usually pale anyway (Dacron / FastFlight) so this also
   * happens to be the realistic choice. */
  const stringMat = new THREE.LineBasicMaterial({
    color: 0xeeeeee, transparent: true, opacity: 0.9, fog: false,
  });
  _bowResources = { limbGeo, limbMat, gripGeo, gripMat, stringMat };
  return _bowResources;
}

let _arrowResources = null;
function _ensureArrowResources() {
  if (_arrowResources) return _arrowResources;
  const shaftLen = ARROW_LENGTH - 0.06;
  const shaftGeo = new THREE.CylinderGeometry(ARROW_RADIUS, ARROW_RADIUS, shaftLen, 6);
  /* All-black arrow per spec. The shaft is matte-black carbon; the
   * head gets higher metalness + lower roughness so it reads as a
   * polished gunmetal point against the matte shaft, giving the
   * arrow a focal point even when otherwise uniformly dark. */
  const shaftMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0a, roughness: 0.6, metalness: 0.05,
  });
  const headGeo = new THREE.ConeGeometry(ARROW_RADIUS * 2.4, 0.06, 8);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 0.3, metalness: 0.8,
  });
  /* Single-triangle fletch — three of these get rotated 120° apart
   * around the shaft. Triangle vertices are in the arrow-local frame:
   * the back edge (z=0) is at the nock; the long edge runs along +Z. */
  const fletchH = 0.025;
  const fletchLen = 0.075;
  const fletchGeo = new THREE.BufferGeometry();
  fletchGeo.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0,           0, 0, fletchLen,    0, fletchH, fletchLen * 0.3,
  ], 3));
  fletchGeo.computeVertexNormals();
  const fletchMat = new THREE.MeshStandardMaterial({
    color: 0x0a0a0a, roughness: 0.7, metalness: 0.05,
    side: THREE.DoubleSide,
  });
  _arrowResources = {
    shaftGeo, shaftMat, headGeo, headMat, fletchGeo, fletchMat, shaftLen,
  };
  return _arrowResources;
}

/* ── Build helpers ────────────────────────────────────────────────────── */

function _buildBowVisual() {
  const { limbGeo, limbMat, gripGeo, gripMat, stringMat } = _ensureBowResources();
  const root = new THREE.Group();
  root.userData.kind = "bowVisual";
  root.userData.sharedRes = true;

  const limbs = new THREE.Mesh(limbGeo, limbMat);
  root.add(limbs);

  const grip = new THREE.Mesh(gripGeo, gripMat);
  grip.position.set(0, 0, 0.005);
  root.add(grip);

  /* Three-vertex line we deform during draw. The middle vertex is the
   * nock point — it sits at rest at the bow's centre, and during draw
   * we move it (in bow-local space) toward the draw hand. */
  const stringGeo = new THREE.BufferGeometry();
  bowStringPositions_ = new THREE.Float32BufferAttribute(new Float32Array(9), 3);
  bowStringPositions_.setUsage(THREE.DynamicDrawUsage);
  bowStringPositions_.setXYZ(0, _bowAnchorTop.x, _bowAnchorTop.y, _bowAnchorTop.z);
  bowStringPositions_.setXYZ(1, _bowStringRest.x, _bowStringRest.y, _bowStringRest.z);
  bowStringPositions_.setXYZ(2, _bowAnchorBot.x, _bowAnchorBot.y, _bowAnchorBot.z);
  stringGeo.setAttribute("position", bowStringPositions_);
  const stringLine = new THREE.Line(stringGeo, stringMat);
  stringLine.frustumCulled = false;
  root.add(stringLine);

  /* The bow body sits AT the controller (origin). The arrow's spawn /
   * fire / target point is computed independently in _getBowAimPos
   * (controller world + BOW_AIM_FORWARD along its local -Z), so the
   * arrow appears 10 cm forward of the hand regardless of where the
   * visible bow body is. Pulling the bow body back to (0,0,0) gets
   * the riser closer to the player's hand grip without changing
   * where any arrow is or fires from. */
  root.position.set(0, 0, 0);
  /* Rotation is set per-attachment in _attachBowToHand. */
  return root;
}

function _buildArrowMesh(isExplosive = false) {
  const r = _ensureArrowResources();
  const root = new THREE.Group();
  root.userData.kind = "arrow";
  root.userData.sharedRes = true;
  root.userData.explosive = !!isExplosive;

  /* Shaft — CylinderGeometry's axis is +Y, but our arrow's forward is
   * +Z, so we rotate 90° around X. We anchor so the NOCK is at local
   * origin (z=0) and the head is at z=ARROW_LENGTH; this matches how
   * we'll attach the arrow to the draw controller (origin == hand). */
  const shaft = new THREE.Mesh(r.shaftGeo, r.shaftMat);
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = r.shaftLen / 2;
  root.add(shaft);

  /* Head — cone for normal arrows, glowing red sphere for explosive.
   * Both keep the same rotation/position contract (rotated 90° around
   * X to align local-Y with world-Z, anchored just past the shaft tip)
   * so _updateNockedArrow's draw-distance shaft scaling formula works
   * uniformly for both types. */
  let head;
  if (isExplosive) {
    head = _buildExplosiveArrowHead();
  } else {
    head = _buildNormalArrowHead();
  }
  head.position.z = r.shaftLen + 0.03;
  root.add(head);

  for (let i = 0; i < 3; i++) {
    const f = new THREE.Mesh(r.fletchGeo, r.fletchMat);
    f.rotation.z = (i / 3) * Math.PI * 2;
    f.position.z = 0.005;
    root.add(f);
  }
  /* Stash refs + nominal shaft length so _updateNockedArrow can
   * stretch the shaft to span (nock → bow) every frame during a draw.
   * The flight arrow re-uses _buildArrowMesh too but never gets its
   * scale touched, so it always renders at nominal length. */
  root.userData.shaft = shaft;
  root.userData.head = head;
  root.userData.shaftLen = r.shaftLen;
  return root;
}

/* ── Bow attachment + handedness toggle ───────────────────────────────── */

function _attachBowToHand(hand) {
  if (!ARCHERY_ENABLED) return;
  const ctrl = _getControllerByHand(hand);
  if (!ctrl) return; // handedness not known yet — caller should retry next frame
  if (!bowGroup_) bowGroup_ = _buildBowVisual();
  if (bowAttachedTo_ && bowAttachedTo_ !== ctrl) {
    bowAttachedTo_.remove(bowGroup_);
  }
  if (bowGroup_.parent !== ctrl) ctrl.add(bowGroup_);
  bowAttachedTo_ = ctrl;
  /* Both controllers use the same body-relative coordinate frame
   * (-Z forward, +Y up) — they are NOT mirrored across hands. So the
   * bow needs the same orientation regardless of hand. Math.PI on the
   * Y axis flips the bow geometry's local +Z (riser-belly side) to
   * align with the controller's -Z (forward), so the riser bulges
   * AWAY from the shooter as it should. */
  bowGroup_.rotation.set(0, Math.PI, 0);
  /* 2× overall scale — at nominal 1× the bow read as a toy (60 cm
   * tip-to-tip). At 2× it spans ~1.6 m, in line with a real adult
   * recurve. Affects geometry only — the targeting math reads the
   * group's world position, which doesn't change with scale, so the
   * draw-distance / fire-direction logic is unaffected by the scale
   * value itself. */
  bowGroup_.scale.setScalar(2.0);
}

function _toggleBowHand() {
  bowHandedness_ = bowHandedness_ === "left" ? "right" : "left";
  /* Cancel anything that depended on the old hand assignment. The
   * grenade aim could be charging; the draw could be in progress.
   * Both must be aborted cleanly so the trigger states don't end up
   * out of sync with the user's actual finger positions. */
  if (drawing_) _cancelDraw();
  if (grenadeAiming_) cancelGrenadeAim();
  _attachBowToHand(bowHandedness_);
  /* Edge-state hygiene after a hand swap: pretend every trigger was
   * already held last frame. This way a trigger that *is* currently
   * held during the toggle (e.g. the user was charging a grenade
   * with their left trigger when they pressed A) won't read as a
   * fresh rising edge on its NEW role (draw or grenade) — the
   * rising-edge gates require a low→high transition, which now
   * requires a real release+press. */
  prevDrawTrigger_ = true;
  prevTriggerL_ = true;
  prevTriggerR_ = true;
  console.info(`[brutalistVR8] bow hand → ${bowHandedness_}`);
}

function _ensureArcherySetup() {
  if (!ARCHERY_ENABLED) return;
  if (bowGroup_ && bowAttachedTo_) return;
  _attachBowToHand(bowHandedness_);
}

/* ── Draw / release flow ──────────────────────────────────────────────── */

function _startDraw() {
  if (drawing_) return;
  if (archeryFireCooldown_ > 0) return;
  if (playerDead()) return;
  const drawCtrl = _getControllerByHand(_drawHandedness());
  if (!drawCtrl) return;
  /* Choose the type of arrow to nock. Explosive only renders if both
   * the player has it selected AND the recharge timer has elapsed —
   * otherwise we silently nock a normal arrow so the bow always
   * produces SOMETHING when the trigger is pulled (less broken-feeling
   * than an empty bow). */
  const wantExplosive = arrowType_ === ARROW_TYPE_EXPLOSIVE && _explosiveReady();
  /* Always rebuild — type may have changed since the last shot. */
  if (nockedArrow_ && nockedArrow_.parent) {
    nockedArrow_.parent.remove(nockedArrow_);
  }
  nockedArrow_ = _buildArrowMesh(wantExplosive);
  if (nockedArrow_.parent !== drawCtrl) drawCtrl.add(nockedArrow_);
  /* Initial pose: at the controller origin, pointing forward in
   * controller space (-Z is forward in WebXR controller frame). The
   * per-frame _updateNockedArrow() will then re-aim it toward the bow. */
  nockedArrow_.position.set(0, 0, 0);
  nockedArrow_.rotation.set(0, 0, 0);
  drawing_ = true;
  drawT_ = 0;
  /* Single short pulse on draw start so the player feels the string
   * grab. Ramping during the draw was tried but the actuator API on
   * Quest doesn't gracefully handle rapid back-to-back pulses — they
   * stutter or get dropped. Keep it to a clean two-pulse pattern:
   * grab now, thump on release. */
  pulseHapticActuator(_drawHandedness(), 0.4, 30);
}

function _cancelDraw() {
  drawing_ = false;
  drawT_ = 0;
  if (nockedArrow_ && nockedArrow_.parent) {
    nockedArrow_.parent.remove(nockedArrow_);
  }
  if (bowStringPositions_) {
    bowStringPositions_.setXYZ(1, _bowStringRest.x, _bowStringRest.y, _bowStringRest.z);
    bowStringPositions_.needsUpdate = true;
  }
}

function _releaseDraw() {
  if (!drawing_) return;
  drawing_ = false;
  const drawCtrl = _getControllerByHand(_drawHandedness());
  if (!_getBowAimPos(_bowWorld) || !drawCtrl) {
    _cancelDraw();
    return;
  }
  drawCtrl.updateMatrixWorld(true);
  drawCtrl.getWorldPosition(_drawWorld);
  /* Draw length is hand-to-bow-shelf, not hand-to-bow-controller —
   * matches what the player visually sees (the string anchor moves
   * relative to the bow's center, not to their bow-hand wrist). */
  const drawLen = Math.min(ARROW_MAX_DRAW, _bowWorld.distanceTo(_drawWorld));

  /* Either way — fire or no-fire — strip the nocked arrow. A real
   * flight arrow gets spawned separately (in scene-space) below if we
   * decide to fire. */
  if (nockedArrow_ && nockedArrow_.parent) {
    nockedArrow_.parent.remove(nockedArrow_);
  }
  /* Snap string back to rest. */
  if (bowStringPositions_) {
    bowStringPositions_.setXYZ(1, _bowStringRest.x, _bowStringRest.y, _bowStringRest.z);
    bowStringPositions_.needsUpdate = true;
  }

  if (drawLen < ARROW_MIN_DRAW_TO_FIRE) {
    drawT_ = 0;
    return; // dry-fire — no shot, no SFX
  }

  /* Direction: from draw hand TOWARD bow hand. The arrow flies in
   * the same direction the player just stretched the string, which is
   * the direction the bow is "pointed" along its axis. */
  _arrowDir.copy(_bowWorld).sub(_drawWorld).normalize();
  const power = drawLen / ARROW_MAX_DRAW;
  const speed = ARROW_MIN_SPEED + (ARROW_MAX_SPEED - ARROW_MIN_SPEED) * power;
  /* Read the type that the *nocked* arrow had — not arrowType_, which
   * could have been toggled by a separate finger between nock and
   * release without _swapNockedArrowVisual catching it. The userData
   * tag on the arrow visual is the source of truth. */
  const isExplosive = nockedArrow_?.userData?.explosive === true;
  /* Spawn from the bow's world position so the arrow visually leaves
   * the bow front, not the draw hand. */
  _spawnFlightArrow(_bowWorld, _arrowDir, speed, isExplosive);
  /* Start the explosive recharge if we just used one. The clock runs
   * regardless of whether the arrow ever hits anything — it's a
   * loadout cooldown, not an "after-detonation" cooldown. */
  if (isExplosive) explosiveRechargeT_ = EXPLOSIVE_ARROW_RECHARGE_S;

  archeryFireCooldown_ = ARCHERY_FIRE_INTERVAL;
  drawT_ = 0;

  /* Release SFX: random pick from the swoosh variants (or the
   * procedural twang if neither has loaded yet). Head-locked because
   * the release happens at the player's hands — no spatialisation
   * gain over a head-anchored sound when you're holding the source. */
  playHeadOneShot(_pickBowSwoosh(), 0.7);
  /* Two-handed thump: bow hand gets a softer pulse (the kick of the
   * limbs snapping back), draw hand a sharper one (the string slap). */
  pulseHapticActuator(bowHandedness_, 0.6, 80);
  pulseHapticActuator(_drawHandedness(), 0.85, 90);
}

function _spawnFlightArrow(origin, dir, speed, isExplosive = false) {
  const mesh = _buildArrowMesh(isExplosive);
  mesh.position.copy(origin);
  /* Arrow's local +Z is its forward axis. Rotate so +Z aligns with
   * the firing direction. */
  mesh.quaternion.setFromUnitVectors(_arrowFromZ, dir);
  /* Stuck arrows rely on their world matrix being current the next
   * frame; force one update now in case the arrow lands on the very
   * next frame (would matter if we ever read mesh.matrixWorld before
   * Three's auto-update). */
  mesh.updateMatrixWorld(true);
  scene_.add(mesh);
  arrows_.push({
    mesh,
    vel: dir.clone().multiplyScalar(speed),
    ttl: ARROW_TTL,
    prev: origin.clone(),
    explosive: !!isExplosive,
  });
}

/* ── Per-frame visuals (string + nocked-arrow tracking) ───────────────── */

function _updateNockedArrow() {
  if (!nockedArrow_ || !bowGroup_ || !bowStringPositions_) return;
  const drawCtrl = _getControllerByHand(_drawHandedness());
  if (!drawCtrl) return;
  if (!_getBowAimPos(_bowWorld)) return;
  drawCtrl.updateMatrixWorld(true);
  drawCtrl.getWorldPosition(_drawWorld);

  /* Keep the visible arrow type in sync with the live state every
   * frame. Without this, a draw started while the explosive was
   * still on cooldown would stay visually "normal" even after the
   * recharge expired mid-draw — and a release would then fire the
   * normal arrow even though the player intuitively expects "the
   * explosive is back, my next arrow is explosive". The swap is a
   * cheap no-op when the head already matches; only when the type
   * changes does it actually rebuild the head mesh + sync the root
   * userData flag that `_releaseDraw` reads. */
  _swapNockedArrowVisual(drawCtrl);

  /* Re-orient the nocked arrow so its tip points toward the bow.
   * `nockedArrow_` is parented to drawCtrl, so the rotation is applied
   * in drawCtrl-local space — convert the bow position into that
   * frame to get the right local direction. */
  drawCtrl.worldToLocal(_arrowTmp1.copy(_bowWorld));
  const drawDist = _arrowTmp1.length();
  if (drawDist > 1e-3) {
    _arrowDir.copy(_arrowTmp1).divideScalar(drawDist);
    nockedArrow_.quaternion.setFromUnitVectors(_arrowFromZ, _arrowDir);
  }

  /* Adapt the shaft length so the arrowhead lands ~at the bow no
   * matter how far the player has drawn. Without this, the rigid
   * arrow just translates back with the draw hand and the head
   * detaches from the bow at long pulls — visually the arrow looks
   * "pulled back too much" past the bow. We scale ONLY the shaft's
   * length axis (the cylinder's native +Y, which is rotated to +Z
   * here) and reposition the head to sit just past the new shaft
   * tip. Fletching stays at the nock end and is unaffected. The
   * head's own size is unchanged — only its position moves —
   * so the arrowhead doesn't get bigger when over-drawn. */
  const shaft = nockedArrow_.userData.shaft;
  const head = nockedArrow_.userData.head;
  if (shaft && head) {
    const nominal = nockedArrow_.userData.shaftLen;
    /* Land the head ~5 cm short of the bow centre so the arrowhead
     * appears to rest on the riser shelf rather than poking through
     * it. Floor at 10 cm so a barely-drawn arrow still looks like
     * an arrow (not a single triangle). */
    const targetLen = Math.max(0.10, drawDist - 0.05);
    shaft.scale.y = targetLen / nominal;
    shaft.position.z = targetLen / 2;
    head.position.z = targetLen + 0.03;
  }

  /* Update the string's middle (nock) vertex to follow the draw hand.
   * The line geometry lives in bow-local space, so convert the draw
   * hand world pos into the bow's local frame. Cap the displacement
   * from the rest position at ARROW_MAX_DRAW (a *world* distance) so
   * the string can't stretch indefinitely. We divide by the bow's
   * uniform scale so the clamp triggers at the same world distance
   * regardless of bow scale — without this, scaling the bow up moves
   * the clamp threshold proportionally further out, decoupling the
   * visual fully-drawn pose from the gameplay max-draw state. */
  bowGroup_.updateMatrixWorld(true);
  bowGroup_.worldToLocal(_drawLocal.copy(_drawWorld));
  _stringNockLocal.copy(_drawLocal);
  const dx = _stringNockLocal.x - _bowStringRest.x;
  const dy = _stringNockLocal.y - _bowStringRest.y;
  const dz = _stringNockLocal.z - _bowStringRest.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  const bowScale = bowGroup_.scale.x || 1;
  const localMaxDraw = ARROW_MAX_DRAW / bowScale;
  if (distSq > localMaxDraw * localMaxDraw) {
    const k = localMaxDraw / Math.sqrt(distSq);
    _stringNockLocal.set(
      _bowStringRest.x + dx * k,
      _bowStringRest.y + dy * k,
      _bowStringRest.z + dz * k,
    );
  }
  bowStringPositions_.setXYZ(1, _stringNockLocal.x, _stringNockLocal.y, _stringNockLocal.z);
  bowStringPositions_.needsUpdate = true;
}

/* ── Arrow flight + collision ─────────────────────────────────────────── */

const _arrowRaycaster = new THREE.Raycaster();
const _arrowWallHit = {
  t: Infinity,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  box: null,
};
const _expFxN = new THREE.Vector3();

function updateArrows(dt) {
  if (archeryFireCooldown_ > 0) archeryFireCooldown_ -= dt;
  /* Tick the explosive-arrow recharge irrespective of draw state.
   * Switching to "normal" mid-recharge doesn't pause the timer —
   * it's a loadout cooldown, not a per-shot delay. */
  if (explosiveRechargeT_ > 0) {
    explosiveRechargeT_ = Math.max(0, explosiveRechargeT_ - dt);
  }
  if (drawing_) {
    drawT_ += dt;
    _updateNockedArrow();
  }

  for (let i = arrows_.length - 1; i >= 0; i--) {
    const a = arrows_[i];
    a.ttl -= dt;
    a.prev.copy(a.mesh.position);
    /* Gravity. We only damp Y; air drag is omitted because at game
     * scales and ARROW_MAX_SPEED ≤ 70 m/s the difference over a 4 s
     * TTL is invisible against the terrain occlusion / target sizes. */
    a.vel.y -= ARROW_GRAVITY * dt;
    a.mesh.position.addScaledVector(a.vel, dt);

    /* Orient mesh along velocity so the arrow visually pitches as
     * gravity bends the trajectory. */
    const speedNow = a.vel.length();
    if (speedNow > 0.01) {
      _arrowDir.copy(a.vel).divideScalar(speedNow);
      a.mesh.quaternion.setFromUnitVectors(_arrowFromZ, _arrowDir);
    }

    /* Continuous collision: ray from prev → cur. Without this, fast
     * arrows would tunnel straight through thin walls between frames. */
    _arrowTmp2.copy(a.mesh.position).sub(a.prev);
    const segLen = _arrowTmp2.length();
    if (segLen >= 1e-5) {
      _arrowTmp2.divideScalar(segLen);

      const hasWallHit = rayHitWorldRich(a.prev, _arrowTmp2, segLen, _arrowWallHit);
      const wallT = hasWallHit ? _arrowWallHit.t : Infinity;

      _arrowRaycaster.set(a.prev, _arrowTmp2);
      _arrowRaycaster.far = Math.min(segLen, wallT);
      let bestDist = Infinity;
      let bestHit = null;
      let bestKind = null;        // "drone" | "antiair"
      for (const d of drones_) {
        if (d.dead) continue;
        const hits = _arrowRaycaster.intersectObject(d.group, true);
        if (hits.length > 0 && hits[0].distance < bestDist) {
          bestDist = hits[0].distance;
          bestHit = hits[0];
          bestKind = "drone";
        }
      }
      /* Anti-air components — same intersectObject sweep but rooted
       * at each turret group so we see both the launcher pivot and
       * its children (pods, radar, core). */
      for (const aa of antiair_) {
        if (aa.dead) continue;
        const hits = _arrowRaycaster.intersectObject(aa.group, true);
        if (hits.length > 0 && hits[0].distance < bestDist) {
          bestDist = hits[0].distance;
          bestHit = hits[0];
          bestKind = "antiair";
        }
      }
      /* Anti-air missiles in flight — sphere-overlap test along the
       * segment (the projectile mesh is small + animated, so a true
       * raycast vs its cylinder geometry is overkill). For each
       * aamissile, find closest point on the arrow's segment to the
       * missile's centre, hit if within MISSILE_HIT_R. */
      const MISSILE_HIT_R = 0.35;
      let bestMissileIdx = -1;
      let bestMissileT = Infinity;
      for (let pi = 0; pi < projectiles_.length; pi++) {
        const p = projectiles_[pi];
        if (!p || (p.kind !== "aamissile" && p.kind !== "aaartillery" && p.kind !== "aamg")) continue;
        /* Project missile centre onto arrow segment a.prev → a.mesh.position. */
        _missileSteer.copy(p.mesh.position).sub(a.prev);
        const tAlong = THREE.MathUtils.clamp(
          _missileSteer.dot(_arrowTmp2), 0, segLen);
        if (tAlong > bestMissileT) continue;        // already found a closer one
        _missileNorm.copy(a.prev).addScaledVector(_arrowTmp2, tAlong);
        const dist2 = _missileNorm.distanceToSquared(p.mesh.position);
        if (dist2 < MISSILE_HIT_R * MISSILE_HIT_R) {
          bestMissileT = tAlong;
          bestMissileIdx = pi;
        }
      }

      /* Pick the closest of the three hit candidates. The missile
       * uses tAlong (segment-projected distance) which lives in the
       * same units as `bestDist`. */
      const hasDroneOrAA = bestHit && bestDist <= Math.min(wallT, bestMissileT);
      const hasMissile   = bestMissileIdx >= 0 && bestMissileT < Math.min(wallT, bestDist);
      const hasWallFinal = hasWallHit
        && wallT < Math.min(bestDist, bestMissileT);

      /* Explosive arrow detonates on FIRST contact (anything). */
      if (a.explosive && (hasDroneOrAA || hasMissile || hasWallFinal)) {
        let blastN = null;
        if (hasMissile) {
          _missileSteer.copy(a.prev).addScaledVector(_arrowTmp2, bestMissileT);
          _finalizeExplosiveArrowFxWorldPos(_arrowTmp1, _missileSteer, null, _arrowTmp2);
        } else if (hasDroneOrAA) {
          if (bestHit.face && bestHit.face.normal) {
            _missileNorm.copy(bestHit.face.normal)
              .transformDirection(bestHit.object.matrixWorld)
              .normalize();
            blastN = _missileNorm;
          }
          _finalizeExplosiveArrowFxWorldPos(
            _arrowTmp1, bestHit.point, blastN, _arrowTmp2,
          );
        } else {
          blastN = _arrowWallHit.normal;
          _finalizeExplosiveArrowFxWorldPos(
            _arrowTmp1, _arrowWallHit.point, _arrowWallHit.normal, _arrowTmp2,
          );
        }
        spawnExplosiveArrowBlastFx(_arrowTmp1, blastN);
        /* Damage model: a pure 4 m AOE wash. `_detonateAOE` walks
         * every unbroken AA component within radius and dispenses
         * `EXPLOSIVE_ARROW_BLAST_DAMAGE × falloff × HQ_AOE_FANOUT`
         * to each — but skips the core while ANY plate is intact
         * (`_isCoreShielded`). So:
         *   • Hit on a pod → blast destroys that pod plus nearby
         *     debris in radius; pods are spaced > radius apart so
         *     adjacent pods are spared. Core untouched (shielded).
         *   • Hit on a plate → that plate breaks, opening one face;
         *     core still shielded if the other plates are intact.
         *   • After all four plates are broken → next explosive's
         *     AOE reaches the core (dmg 70 × crit 2.0 = 140 → kills
         *     core at 80 HP).
         *
         * No more "penetrating shockwave" cheat — the player has to
         * earn the kill by knocking out the protection first. This
         * matches the original spec: 2-3 explosives or many normal
         * arrows to take an HQ down, and a hit on a single
         * launcher pod only destroys that pod. */
        _detonateAOE(_arrowTmp1, EXPLOSIVE_ARROW_BLAST_RADIUS, {
          drone: EXPLOSIVE_ARROW_BLAST_DAMAGE,
          antiair: EXPLOSIVE_ARROW_BLAST_DAMAGE,
          player: 0,                  // explosive arrow never hurts the player
        }, EXPLOSIVE_ARROW_PUSH, { skipBuiltInExplosionFx: true });
        scene_.remove(a.mesh);
        arrows_.splice(i, 1);
        continue;
      }

      /* Normal arrow: existing per-target-type handling. */
      if (hasMissile) {
        const p = projectiles_[bestMissileIdx];
        if (_damageHqFlyer(p, PLAYER_DAMAGE)) {
          /* Missile destroyed in flight — remove from list. */
          projectiles_.splice(bestMissileIdx, 1);
        }
        scene_.remove(a.mesh);
        arrows_.splice(i, 1);
        continue;
      }
      if (hasDroneOrAA) {
        if (bestKind === "drone") {
          const drone = findDroneFromHit(bestHit.object);
          let arrowFollow = null;
          if (drone) {
            let comp = findComponent(bestHit.object);
            if (!comp || comp.userData.broken) {
              comp = drone.group.userData.findKind("body");
            }
            if (comp && !comp.userData.broken) {
              arrowFollow = drone.takeDamage(comp, PLAYER_DAMAGE, _arrowTmp2, a.prev);
            }
          }
          _missileNorm.copy(_arrowTmp2).negate();
          spawnMetalImpactSparks(bestHit.point, _missileNorm);
          _stickArrowOnDrone(a, bestHit, arrowFollow);
          arrows_.splice(i, 1);
          continue;
        } else if (bestKind === "antiair") {
          /* Walk up the parent chain to find the AntiAirTurret + the
           * specific component. Components carry an `antiair` back-ref
           * we can use; if missing (we struck a non-component decor
           * mesh like the base or a pod cap), fall back to the body. */
          let comp = findComponent(bestHit.object);
          let aa = comp?.userData?.antiair;
          if (!aa) {
            /* Climb until we find an .antiair on userData (the base
             * mesh has it). */
            let n = bestHit.object;
            while (n && !aa) {
              if (n.userData?.antiair) aa = n.userData.antiair;
              n = n.parent;
            }
          }
          if (aa && !aa.dead) {
            if (!comp || !comp.userData.kind || comp.userData.broken) {
              comp = aa.body && !aa.body.userData.broken ? aa.body : null;
            }
            /* Decorative hull (shoulders, radar stalk, etc.) has `antiair`
             * but no `kind`. Old fallback always used `aa.body`; once the
             * roof cap is blown off, `body` is broken and every hit on
             * those meshes was silently dropped — the core looked exposed
             * but arrows never dealt damage. */
            if (!comp || comp.userData.broken) {
              if (!aa._isCoreShielded() && aa.core && !aa.core.userData.broken) {
                comp = aa.core;
              } else {
                for (const c of aa.components) {
                  if (!c.userData.broken && c.userData.kind) {
                    comp = c;
                    break;
                  }
                }
              }
            }
            if (comp && !comp.userData.broken) {
              aa.takeDamage(comp, PLAYER_DAMAGE, _arrowTmp2, a.prev);
            }
          }
          _missileNorm.copy(_arrowTmp2).negate();
          spawnMetalImpactSparks(bestHit.point, _missileNorm);
          /* Stick the arrow on the AA hit point (in world coords). */
          _stickArrowOnWorld(a, bestHit.point);
          arrows_.splice(i, 1);
          continue;
        }
      }
      if (hasWallFinal) {
        spawnSurfaceImpact(_arrowWallHit.point, _arrowWallHit.normal);
        spawnMetalImpactSparks(_arrowWallHit.point, _arrowWallHit.normal);
        _stickArrowOnWorld(a, _arrowWallHit.point);
        arrows_.splice(i, 1);
        continue;
      }
    }

    if (a.ttl <= 0) {
      /* Per spec: explosive arrows must ALWAYS detonate — wall, floor,
       * drone, manual trigger, OR end-of-flight all produce the
       * blast. A normal arrow that ran out of TTL without striking
       * anything (rare; usually they hit something) just gets
       * removed silently. */
      if (a.explosive) {
        const spd = a.vel.length();
        if (spd > 0.08) {
          _missileNorm.copy(a.vel).divideScalar(spd);
        } else {
          _missileNorm.set(0, -1, 0);
        }
        _finalizeExplosiveArrowFxWorldPos(
          _arrowTmp1, a.mesh.position, null, _missileNorm,
        );
        spawnExplosiveArrowBlastFx(_arrowTmp1, null);
        _detonateAOE(_arrowTmp1, EXPLOSIVE_ARROW_BLAST_RADIUS, {
          drone: EXPLOSIVE_ARROW_BLAST_DAMAGE,
          antiair: EXPLOSIVE_ARROW_BLAST_DAMAGE,
          player: 0,
        }, EXPLOSIVE_ARROW_PUSH, { skipBuiltInExplosionFx: true });
      }
      scene_.remove(a.mesh);
      /* Geometries / materials are shared (sharedRes) — don't dispose. */
      arrows_.splice(i, 1);
    }
  }
}

/** Detonate the FIRST live explosive arrow in flight. Called from
 *  pollVRInputs when the player presses the bow-hand trigger and at
 *  least one arrow is currently mid-flight. Blast happens at the
 *  arrow's current position. Walks the in-flight list because the
 *  player may have fired multiple normals before / after the
 *  explosive — the explosive isn't necessarily the most recent shot.
 *  Returns true if anything detonated. */
function detonateExplosiveArrowInFlight() {
  for (let i = 0; i < arrows_.length; i++) {
    const a = arrows_[i];
    if (!a.explosive) continue;
    const spd = a.vel.length();
    if (spd > 0.08) {
      _missileNorm.copy(a.vel).divideScalar(spd);
    } else {
      _missileNorm.set(0, -1, 0);
    }
    _finalizeExplosiveArrowFxWorldPos(
      _arrowTmp1, a.mesh.position, null, _missileNorm,
    );
    spawnExplosiveArrowBlastFx(_arrowTmp1, null);
    _detonateAOE(_arrowTmp1, EXPLOSIVE_ARROW_BLAST_RADIUS, {
      drone: EXPLOSIVE_ARROW_BLAST_DAMAGE,
      antiair: EXPLOSIVE_ARROW_BLAST_DAMAGE,
      player: 0,
    }, EXPLOSIVE_ARROW_PUSH, { skipBuiltInExplosionFx: true });
    scene_.remove(a.mesh);
    arrows_.splice(i, 1);
    return true;
  }
  return false;
}

/* True if any explosive arrow is currently in flight. Used by the
 * input polling to decide whether the bow-hand trigger should
 * detonate (yes, fire bypassing rising-edge) vs. do nothing. */
function _explosiveArrowInFlight() {
  for (const a of arrows_) if (a.explosive) return true;
  return false;
}

function _stickArrowOnDrone(arrow, hit, followMesh = null) {
  /* Position at the hit point, oriented along the arrow's flight
   * direction (already set this frame). Re-parent under the drone's
   * group root using attach() so the world transform is preserved
   * across the parent change — the arrow ends up in the drone's local
   * frame, tracking the drone as it moves and dying with it. */
  arrow.mesh.position.copy(hit.point);
  /* Push the head a few cm into the surface so it visually penetrates
   * rather than sitting flush against the hit face. */
  _arrowTmp1.set(0, 0, 1).applyQuaternion(arrow.mesh.quaternion);
  arrow.mesh.position.addScaledVector(_arrowTmp1, 0.04);
  const drone = findDroneFromHit(hit.object);
  if (followMesh && followMesh.parent) {
    followMesh.attach(arrow.mesh);
  } else if (drone) {
    drone.group.attach(arrow.mesh);
  }
  _enqueueStuckArrow(arrow.mesh);
}

function _stickArrowOnWorld(arrow, point) {
  /* Embed by pushing along the arrow's facing (its current quaternion
   * is already set to the velocity direction this frame). The arrow
   * is already a scene child — no re-parenting needed. */
  _arrowTmp1.set(0, 0, 1).applyQuaternion(arrow.mesh.quaternion);
  arrow.mesh.position.copy(point).addScaledVector(_arrowTmp1, 0.04);
  _enqueueStuckArrow(arrow.mesh);
}

function _enqueueStuckArrow(mesh) {
  stuckArrows_.push(mesh);
  while (stuckArrows_.length > ARROW_MAX_STUCK) {
    const oldest = stuckArrows_.shift();
    if (oldest.parent) oldest.parent.remove(oldest);
  }
}

/* Public archery controls (called from main.js's brutalistVR8 console API). */
export function setBowHand(hand) {
  if (hand !== "left" && hand !== "right") {
    console.warn('setBowHand: pass "left" or "right"');
    return bowHandedness_;
  }
  if (hand !== bowHandedness_) _toggleBowHand();
  return bowHandedness_;
}
export function getBowHand() { return bowHandedness_; }
export function toggleBowHand() {
  _toggleBowHand();
  return bowHandedness_;
}

/* ── Arrow types (normal / explosive) ──────────────────────────────────
 *
 * The bow nocks arrows of the *currently selected type*. Two types:
 *
 *   "normal"     — black-tip practice arrow; baseline PLAYER_DAMAGE; sticks
 *                  on hit. The original archery arrow.
 *   "explosive"  — sphere-tip warhead arrow. On impact (or when the
 *                  player taps the bow-hand trigger mid-flight) it
 *                  detonates a 4 m blast: damage falls off linearly
 *                  from EXPLOSIVE_ARROW_BLAST_DAMAGE at centre to 0 at
 *                  the edge, plus a radial knock-back impulse. Single-
 *                  shot weapon: after one explosive shot, a 10 s
 *                  recharge timer must elapse before another can be
 *                  fired. Switching back to "normal" mid-recharge is
 *                  always free; the recharge keeps ticking in the
 *                  background.
 *
 * Toggle: X button on the left controller (button[4] on Quest Touch).
 * Console: brutalistVR8.setArrowType / toggleArrowType / getArrowType.
 *
 * The current type is sticky — once the player selects "explosive" the
 * bow keeps nocking explosives until either (a) they switch back, or
 * (b) the recharge timer is non-zero AND they release a draw. In case
 * (b) the bow falls back to a normal arrow for that shot rather than
 * dry-firing or refusing to fire (which would feel broken in VR). */
const ARROW_TYPE_NORMAL = "normal";
const ARROW_TYPE_EXPLOSIVE = "explosive";
const EXPLOSIVE_ARROW_BLAST_RADIUS = 4.0;
const EXPLOSIVE_ARROW_BLAST_DAMAGE = 70;     // peak damage at centre
const EXPLOSIVE_ARROW_PUSH = 8.0;            // peak knock-back impulse magnitude (m/s)
/* World-OBB impact points sit exactly on the surface; the explosion
 * mesh is ~0.6 m radius with depthTest on, so a centred fireball is
 * almost entirely behind the depth buffer when striking floors or
 * walls — looks like “no explosion”. Bias the FX/damage origin
 * slightly along the outward face normal (gameplay unchanged). */
const EXPLOSIVE_ARROW_FX_SURFACE_BIAS = 0.55;
/* Pull blast FX back along flight (+ lift on decks) so the fireball
 * isn’t embedded in horizontal floors when OBB normals disagree. */
const EXPLOSIVE_ARROW_FX_RAY_PULL = 0.42;
const EXPLOSIVE_ARROW_FX_FLOOR_LIFT = 0.68;
const EXPLOSIVE_ARROW_RECHARGE_S = 10.0;
let arrowType_ = ARROW_TYPE_NORMAL;
let explosiveRechargeT_ = 0;                 // seconds until next explosive ready (0 = ready)
let prevXButton_ = false;                    // edge-detect X (left) for arrow-type toggle

export function setArrowType(t) {
  if (t !== ARROW_TYPE_NORMAL && t !== ARROW_TYPE_EXPLOSIVE) {
    console.warn('setArrowType: pass "normal" or "explosive"');
    return arrowType_;
  }
  if (t === arrowType_) return arrowType_;
  arrowType_ = t;
  /* If the player toggles type while currently drawing, swap the
   * nocked arrow's appearance immediately so they see the change
   * without having to release-and-redraw. */
  if (drawing_ && nockedArrow_) {
    const drawCtrl = _getControllerByHand(_drawHandedness());
    if (drawCtrl) {
      _swapNockedArrowVisual(drawCtrl);
    }
  }
  /* Brief click on the bow hand for tactile feedback. */
  pulseHapticActuator(bowHandedness_, 0.4, 35);
  return arrowType_;
}
export function getArrowType() { return arrowType_; }
export function toggleArrowType() {
  return setArrowType(arrowType_ === ARROW_TYPE_NORMAL ? ARROW_TYPE_EXPLOSIVE : ARROW_TYPE_NORMAL);
}

/** Returns true if the player can fire an explosive arrow right now
 *  (i.e. recharge fully elapsed). Used to decide whether a draw with
 *  arrowType_ === "explosive" actually delivers an explosive arrow
 *  or silently degrades to a normal one. */
function _explosiveReady() {
  return explosiveRechargeT_ <= 0;
}

/* Swap the nocked arrow's tip + colour to match the current arrow
 * type without re-creating the whole arrow group. We keep the same
 * shaft + fletch (cheap to leave alone) and only replace the tip mesh
 * referenced by userData.head. CRITICAL: this also updates
 * `nockedArrow_.userData.explosive` so the root group's "what type am
 * I" flag (read by `_releaseDraw`) stays in lockstep with the visible
 * head — without this, swapping the head left a stale flag on the
 * root and the player would see e.g. an explosive sphere tip but
 * release a normal arrow (or vice-versa). */
function _swapNockedArrowVisual(parentCtrl) {
  if (!nockedArrow_) return;
  const oldHead = nockedArrow_.userData.head;
  if (!oldHead) return;
  /* Decide which tip to use. Explosive only renders if the player's
   * recharge timer has fully elapsed — otherwise visually the arrow is
   * still a normal arrow (matches what release will actually fire). */
  const wantExplosive = arrowType_ === ARROW_TYPE_EXPLOSIVE && _explosiveReady();
  const currentlyExplosive = oldHead.userData?.explosive === true;
  if (wantExplosive === currentlyExplosive) {
    /* Even when the head is already correct, force the root flag
     * to agree — defends against any stale value (e.g. set by an
     * older _startDraw build call that built one type, then a no-op
     * swap call leaves the visual head correct but the root flag
     * could mismatch in edge cases). Cheap, idempotent. */
    nockedArrow_.userData.explosive = wantExplosive;
    return;
  }
  const oldZ = oldHead.position.z;
  nockedArrow_.remove(oldHead);
  /* Don't dispose: heads are *cloned* per-arrow so they own unique
   * material/geometry refs, but the fletch + shaft are shared. The
   * old head will be GC'd once dropped. */
  const newHead = wantExplosive ? _buildExplosiveArrowHead() : _buildNormalArrowHead();
  newHead.position.z = oldZ;
  nockedArrow_.add(newHead);
  nockedArrow_.userData.head = newHead;
  /* Source-of-truth for the release path. Without this the root
   * flag stays whatever _startDraw set it to, even though the head
   * mesh has been swapped — leading to "saw explosive, fired
   * normal" (and worse: "saw normal, fired explosive AND ate the
   * recharge"). Always equal to the visible head's type. */
  nockedArrow_.userData.explosive = wantExplosive;
  /* Touch the parent so the next render picks up the change. */
  if (parentCtrl) parentCtrl.updateMatrixWorld(true);
}

/* Build a normal cone arrowhead. Reused by every nocked-and-flying
 * normal arrow. */
function _buildNormalArrowHead() {
  const r = _ensureArrowResources();
  const head = new THREE.Mesh(r.headGeo, r.headMat);
  head.rotation.x = Math.PI / 2;
  head.userData.explosive = false;
  return head;
}

/* Build an explosive arrowhead — a slightly larger sphere with a hot
 * red emissive core. The sphere replaces the cone tip referenced in
 * the spec ("explosive arrows (with a spherical tip)"). */
let _explosiveArrowHeadGeo = null;
let _explosiveArrowHeadMat = null;
function _ensureExplosiveArrowHeadResources() {
  if (_explosiveArrowHeadGeo) return;
  /* Sphere ~3 cm across — visibly bigger than the practice arrowhead
   * (~1 cm cone) so the player can identify the loadout at a glance. */
  _explosiveArrowHeadGeo = new THREE.SphereGeometry(0.018, 12, 8);
  _explosiveArrowHeadMat = new THREE.MeshStandardMaterial({
    color: 0x331008,
    emissive: 0xff3308,
    emissiveIntensity: 1.6,
    roughness: 0.4,
    metalness: 0.4,
    toneMapped: true,
  });
}
function _buildExplosiveArrowHead() {
  _ensureExplosiveArrowHeadResources();
  const head = new THREE.Mesh(_explosiveArrowHeadGeo, _explosiveArrowHeadMat);
  head.userData.explosive = true;
  return head;
}

/* ── Anti-air emplacements + snitch spotters ──────────────────────────
 *
 * One static AntiAirTurret per sector that has a sufficiently tall
 * tower (height >= TOWER_MIN_HEIGHT in sectors.js). Sits on top of the
 * tower's roof; never moves. Components:
 *
 *   base       — the squat plinth bolted to the rooftop. Decorative;
 *                no destructible state.
 *   launcher   — the rotating box that aims pods + twin HMGs. Slews
 *                toward the last-known player position when active.
 *                Hosts the visible "vision" cone. Pitch is clamped to
 *                the upper hemisphere (cannot aim below local horizon).
 *   pods       — three heavy rocket tubes (visual + relay artillery).
 *                Breaking a pod removes one tube from snitch-called
 *                ballistic volleys (concentrated fire degrades threat).
 *   hmg        — two destroyable brow machine guns on the launcher.
 *   radar      — small dish on the back of the launcher. While
 *                intact: the AA can self-acquire the player at long
 *                range. Broken: the AA needs a snitch drone to feed
 *                it line-of-sight before it'll fire.
 *   power      — exposed core under the launcher box (crit zone).
 *                Breaking it kills the entire emplacement.
 *
 * FSM: SLEEP (no LOS, no relay) → AIM (gathering aim-focus 0..1 with
 * narrowing cone) → FIRE (twin HMG burst cadence) → COOLDOWN (5 s).
 * Hits during AIM dump aim-focus back to 0 — same "interrupt the
 * lock-on" mechanic used by drones.
 *
 * Pod rockets are **not** self-guided homers: a snitch relay triggers
 * ballistic `aaartillery` volleys that arc up and rain onto the
 * relayed last-known position. Legacy homing `aamissile` projectiles
 * remain for compatibility / tooling but are no longer spawned from
 * the HQ salvo. */
const ANTIAIR_VISION_LENGTH = 70;
const ANTIAIR_VISION_HALF_ANGLE_DEG = 28;
const ANTIAIR_VISION_DOT = Math.cos(ANTIAIR_VISION_HALF_ANGLE_DEG * Math.PI / 180);
/* Passive-track range as a multiple of the vision length. The AA
 * passively slews its launcher toward the player at all times within
 * this range, so the cone can naturally acquire a target it would
 * otherwise miss (player at ground level vs roof-mounted launcher,
 * 30-60° down-pitch is outside the 28° vision cone). Slightly
 * larger than vision so the AA visibly swings onto an approaching
 * player a beat before they're in firing range. */
const ANTIAIR_TRACK_RANGE_MUL = 1.4;
const ANTIAIR_VISION_NARROW_RATIO = 0.10;
const ANTIAIR_AIM_TIME = 2.5;            // 2-3 s of stable LOS to fire (user spec)
const ANTIAIR_COOLDOWN_S = 5.0;
const ANTIAIR_SLEW_RATE = 1.6;           // launcher yaw/pitch slerp speed (rad/s-ish)
const ANTIAIR_SALVO_COUNT = 3;
const ANTIAIR_SALVO_INTERVAL = 0.22;     // s between successive missiles in a salvo
/* aimFocus ramps / FIRE arms only when the launcher is this close to
 * its horizon-clamped aim vector (pivot local +Z), so the cone
 * narrowing matches the barrel actually bearing on target. */
const ANTIAIR_AIM_ALIGN_DOT = Math.cos(11 * Math.PI / 180);
const ANTIAIR_RELAY_GRACE_S = 4.5;       // how long a snitch's relay tip stays "fresh" after the snitch loses LOS
const AAMISSILE_DAMAGE = 28;             // damage to the player on direct hit
const AAMISSILE_BLAST_RADIUS = 3.0;
const AAMISSILE_BLAST_DAMAGE = 60;       // damage to drones in radius (for friendly-fire AOE)
const AAMISSILE_SPEED = 11;
const AAMISSILE_TURN_RATE_CLIMB = 0.6;   // limited steering during ascent
const AAMISSILE_TURN_RATE = 2.4;         // full homing once at cruise alt
const AAMISSILE_TTL = 8.0;
const AAMISSILE_HP = 8;                  // arrow direct hit kills it (PLAYER_DAMAGE=14)
/* HQ ballistic rockets — only spawned when a snitch successfully relays
 * to an AA. Fat visible warheads; ballistics + gravity, not homing. */
const HQ_ARTILLERY_INTERVAL_S = 9.0;   // min time between snitch-called volleys per AA
const HQ_ARTILLERY_HP = 36;             // in-flight rocket — a few arrow hits
const HQ_ARTILLERY_GRAVITY = 11.0;
const HQ_ARTILLERY_TTL = 14.0;
const HQ_ARTILLERY_BLAST_RADIUS = 5.5;
const HQ_ARTILLERY_BLAST_DAMAGE = 62;
const HQ_ARTILLERY_DIRECT_DAMAGE = 42;
/* Artillery player splash: max horizontal distance (m) from ground aim
 * to count as “in the strike column” — combined in `_detonateAOE`
 * with distance to the *actual* detonation so lofting rockets never
 * hurt the player until the blast is nearby. */
const HQ_ARTILLERY_PLAYER_NEAR_M = 4.0;
/* Horizontal radius (m) around the aim point where the fuse arms as the
 * rocket descends — must actually “arrive” before detonating. */
const HQ_ARTILLERY_FUSE_HORIZ_M = 2.15;
/* Snitch artillery: climb to apex above target XZ, then drop straight
 * down the strike column (no grazing nearby facades outside column). */
const HQ_ARTILLERY_LOFT_SPEED = 54;
const HQ_ARTILLERY_DROP_SPEED = 82;
const HQ_ARTILLERY_APEX_ABOVE_GROUND = 24;
const HQ_ARTILLERY_APEX_MIN_OVER_POD = 22;
const HQ_ARTILLERY_APEX_OVER_HINT = 14;
const HQ_ARTILLERY_COLUMN_R = 1.35;
const HQ_MG_HP = 55;
/** Visible MG tracer — damage only on actual hit (no magic HP drain). */
const HQ_MG_ROUND_SPEED = 108;
const HQ_MG_ROUND_TTL = 0.52;
const HQ_MG_ROUND_DAMAGE = 4.2;
/* Cruise altitude: above the tallest tower seen so far in the loaded
 * sectors. Recomputed each salvo so a tall fortress sector raises
 * everyone's launch ceiling. */
let _missileCruiseAlt = 50;

const antiair_ = [];                     // currently-active AntiAirTurret instances
/* Persistent per-sector AA cache. The world is divided into 80 m
 * sectors and only a 5×5 ring around the player is "active" at any
 * time — sectors outside that ring are unloaded to keep memory /
 * draw bounded. AA instances historically were thrown away on unload
 * and rebuilt on reload, which meant every visit to a sector reset
 * its HQ to full HP — looked like sectors were poaching each others'
 * damage state. We now cache the instance keyed by sector so a
 * damaged or destroyed HQ stays damaged/destroyed across unload/
 * reload cycles. The reset path (Play Again on game over) wipes this
 * cache. Keeps geometry/materials reused via shared `_antiairResources`
 * so the per-cached-instance memory cost is just the Group + the
 * userData on each component. */
const _aaBySectorKey = new Map();        // sectorKey → AntiAirTurret (alive OR dead, present in the world or unloaded)
/* Reusable scratch for the per-frame anti-air tick. Touched once
 * per turret per frame, never inside any helper. */
const _aaPlayer = new THREE.Vector3();
const _aaTmp = new THREE.Vector3();
const _aaTmp2 = new THREE.Vector3();
const _aaQuat = new THREE.Quaternion();
const _aaQuatTarget = new THREE.Quaternion();

/** Public entry point called by main.js whenever the sector streamer
 *  finishes a load/unload cycle. We diff `activeKeys` against our
 *  tracked spawn set:
 *    - new keys → spawn an anti-air on the tallest qualifying tower
 *      (if any). 30-50 % of sectors qualify.
 *    - removed keys → despawn any anti-air instance whose home key
 *      is now outside the active set. We also cancel its in-flight
 *      missiles (those would otherwise try to home on the player
 *      with their launcher-tower already unloaded → null world refs).
 *  Idempotent — safe to call every frame.
 */
export function notifySectorsChanged(activeKeys) {
  if (!getSectorTowerAnchors_) return;
  const want = new Set(activeKeys);
  /* Detach (but DON'T destroy) any anti-air whose sector is no longer
   * active. The instance stays in `_aaBySectorKey` with its full damage
   * state intact, so when the player wanders back into that sector
   * we can re-attach the same wounded/destroyed HQ instead of
   * rebuilding a healthy one. */
  for (let i = antiair_.length - 1; i >= 0; i--) {
    const aa = antiair_[i];
    if (!want.has(aa.sectorKey)) {
      _detachAntiAir(aa);
      antiair_.splice(i, 1);
    }
  }
  /* Detach health spheres from sectors that just unloaded. Their
   * "collected" status persists; only the visible mesh is removed. */
  for (const key of _healthSpheresBySectorKey.keys()) {
    if (!want.has(key)) _deactivateHealthSphere(key);
  }
  /* Activate the AA in each newly-active sector. Re-uses a cached
   * instance if we've ever spawned for this sector before. Same
   * load cycle: roll for / re-attach a health sphere per sector. */
  for (const key of activeKeys) {
    /* Health sphere first — independent of the AA system. Idempotent
     * when called for an already-active sector. */
    _activateHealthSphere(key);
    /* Already attached? Skip — we only want to (re)attach once per
     * load cycle. */
    if (antiair_.some((a) => a.sectorKey === key)) continue;
    const cached = _aaBySectorKey.get(key);
    if (cached) {
      _reattachAntiAir(cached);
      continue;
    }
    const anchors = getSectorTowerAnchors_(key);
    if (!anchors || anchors.length === 0) continue;
    /* Always one per sector (anchors[] is at most length 1 per the
     * sectors.js contract). */
    const a = anchors[0];
    _spawnAntiAir(a);
  }
  /* Update the cruise altitude for anti-air missiles. The launch
   * climb-phase needs to clear EVERYTHING in the loaded set. We add
   * a comfortable buffer so the missile doesn't graze rooftops. */
  let maxTowerY = 30;
  for (const aa of antiair_) {
    if (aa.anchor.y + 6 > maxTowerY) maxTowerY = aa.anchor.y + 6;
  }
  _missileCruiseAlt = Math.max(40, maxTowerY + 8);
}

function _spawnAntiAir(anchor) {
  const turret = new AntiAirTurret(anchor);
  antiair_.push(turret);
  if (turret.sectorKey) _aaBySectorKey.set(turret.sectorKey, turret);
}

/** Re-attach a previously-cached AA back into the live world: re-add
 *  the group to the scene and the instance to `antiair_`. Damage,
 *  broken-component state, FSM state, and any in-flight missile
 *  ownership are all preserved from before the unload. */
function _reattachAntiAir(aa) {
  if (aa.group && !aa.group.parent) scene_.add(aa.group);
  if (!antiair_.includes(aa)) antiair_.push(aa);
}

/** Detach an AA from the live world without destroying it: remove
 *  its group from the scene so it stops rendering / responding, but
 *  keep the instance + its damage/FSM state in the per-sector cache.
 *  Any in-flight missiles it launched stay in the air with their
 *  back-ref dropped, matching the original "missiles outlive their
 *  launcher" design. */
function _detachAntiAir(aa) {
  if (aa.group && aa.group.parent) aa.group.parent.remove(aa.group);
  for (const p of projectiles_) {
    if (p && (p.kind === "aamissile" || p.kind === "aaartillery" || p.kind === "aamg")
        && p.owner === aa) {
      p.owner = null;
    }
  }
}

/** Wipe the cached HQs entirely. Used by the game-over reset path
 *  so a fresh playthrough starts with intact HQs everywhere. The
 *  next sector activation will rebuild from scratch. */
function _clearAntiAirCache() {
  for (const aa of _aaBySectorKey.values()) {
    if (aa.group && aa.group.parent) aa.group.parent.remove(aa.group);
  }
  _aaBySectorKey.clear();
  antiair_.length = 0;
}

/* ── Health pickup spheres ──────────────────────────────────────────────
 *
 * Some sectors contain a glowing green pickup that, when the player
 * walks into it, restores their HP to full. The placement is
 * deterministic per sector key (so the same sector always either has
 * or doesn't have a sphere, and at the same position within it),
 * which gives the player a reason to memorise / explore the map.
 *
 * Per the spec: "maybe 3 out of 9 sectors could spawn a health
 * sphere" → ~33 % spawn rate. We hash the sector key into a
 * deterministic 0..1 value and gate on `< HEALTH_SPHERE_SPAWN_PROB`.
 *
 * Lifecycle:
 *   • Sector first loads → if (deterministic roll passes) AND not in
 *     `_collectedHealthSectors_`, build a sphere mesh, attach to
 *     scene, register in `_healthSpheresBySectorKey`.
 *   • Sector unloads → detach mesh from scene but keep its "alive"
 *     state in the cache. Collected status (in
 *     `_collectedHealthSectors_`) is the source of truth, so a
 *     sphere whose sector unloads while uncollected will reappear
 *     when the player returns.
 *   • Sphere collected (player within HEALTH_SPHERE_COLLECT_R) →
 *     restore HP to PLAYER_MAX_HP, despawn mesh, mark sector as
 *     collected so it doesn't respawn this run.
 *   • _resetGame() clears `_collectedHealthSectors_` so a new run
 *     gets a fresh set of pickups.
 */
const HEALTH_SPHERE_SPAWN_PROB = 1 / 3;       // ≈3 sectors out of 9
const HEALTH_SPHERE_COLLECT_R = 1.0;          // metres — generous for VR pickup
const HEALTH_SPHERE_HOVER_AMP = 0.18;         // sin-bob amplitude (m)
const HEALTH_SPHERE_HOVER_HZ = 0.6;           // bobs slowly so it's clearly NOT scenery
const HEALTH_SPHERE_SPIN_RATE = 0.9;          // rad/s yaw
const HEALTH_SPHERE_BASE_Y = 1.4;             // metres above ground (chest-height in VR)
/* Per-sector sphere instances currently in scene (or detached but
 * still alive). Keyed by sector "sx,sz". */
const _healthSpheresBySectorKey = new Map();
/* Sectors whose sphere has been collected this run — won't respawn
 * until `_resetGame` clears the set. */
const _collectedHealthSectors_ = new Set();
/* Shared geometry / materials so 50+ uncollected spheres across a
 * full traversal stay cheap. */
let _healthSphereGeo_ = null;
let _healthSphereCoreMat_ = null;
let _healthSphereGlowMat_ = null;
let _healthCrossGeoH_ = null;
let _healthCrossGeoV_ = null;
let _healthCrossMat_ = null;

function _ensureHealthSphereResources() {
  if (_healthSphereGeo_) return;
  /* The visible "ball" — bigger sphere with a glowing emissive green
   * tint. SphereGeometry default has its centre at origin so the
   * hover sin-bob is symmetric around `BASE_Y`. */
  _healthSphereGeo_ = new THREE.SphereGeometry(0.32, 24, 16);
  _healthSphereCoreMat_ = new THREE.MeshStandardMaterial({
    color: 0x22aa55,
    emissive: 0x33ff77,
    emissiveIntensity: 1.2,
    roughness: 0.3,
    metalness: 0.1,
    transparent: true,
    opacity: 0.85,
  });
  /* Outer glow shell — slightly larger, additive blending so it
   * fades the outline against bright fog backdrops without crunching
   * the silhouette into a flat disc. */
  _healthSphereGlowMat_ = new THREE.MeshBasicMaterial({
    color: 0x44ff88,
    transparent: true,
    opacity: 0.22,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
    toneMapped: false,
  });
  /* Plus-sign decoration so a colour-blind player can still tell
   * "this is the medkit" at a glance. Two thin slabs crossed at
   * the sphere's front. */
  _healthCrossGeoH_ = new THREE.BoxGeometry(0.32, 0.08, 0.04);
  _healthCrossGeoV_ = new THREE.BoxGeometry(0.08, 0.32, 0.04);
  _healthCrossMat_ = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.9,
    fog: true,
    toneMapped: false,
  });
}

/** xmur3-style 32-bit hash of a sector key. Returns a float in [0,1).
 *  Deterministic per key; combined with the run's seed (if any) so
 *  reseeding the run reshuffles which sectors have health spheres. */
function _sectorHash01(key) {
  let h = 1779033703 ^ ((seedValue_ ?? 0) | 0);
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  /* Two more rounds of avalanche so adjacent keys (e.g. "1,2" and
   * "1,3") don't share visibly correlated outputs. */
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296);
}

/** Build the visual mesh for a health sphere (sphere + glow shell +
 *  plus icon). Caller positions the returned group in world space. */
function _buildHealthSphereMesh() {
  _ensureHealthSphereResources();
  const grp = new THREE.Group();
  const core = new THREE.Mesh(_healthSphereGeo_, _healthSphereCoreMat_);
  grp.add(core);
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.42, 18, 12),
    _healthSphereGlowMat_,
  );
  grp.add(glow);
  /* Plus icon on the front face. Horizontal + vertical bars,
   * slightly forward in +Z so they don't z-fight with the core. */
  const crossH = new THREE.Mesh(_healthCrossGeoH_, _healthCrossMat_);
  crossH.position.set(0, 0, 0.30);
  grp.add(crossH);
  const crossV = new THREE.Mesh(_healthCrossGeoV_, _healthCrossMat_);
  crossV.position.set(0, 0, 0.30);
  grp.add(crossV);
  /* Track the start time so the per-frame tick can derive a hover
   * sine that's continuous across re-attachments (don't restart the
   * phase every time a sector reloads). */
  grp.userData.spawnedAt = (typeof performance !== "undefined") ? performance.now() : Date.now();
  return grp;
}

/** Create or re-attach the health sphere for sector `key`. Returns
 *  the active sphere record or null if this sector doesn't roll a
 *  sphere or it has already been collected this run. */
function _activateHealthSphere(key) {
  if (_collectedHealthSectors_.has(key)) return null;
  /* Deterministic spawn roll: 1/3 chance per sector, seed-dependent. */
  const roll = _sectorHash01(key);
  if (roll >= HEALTH_SPHERE_SPAWN_PROB) return null;

  let rec = _healthSpheresBySectorKey.get(key);
  if (!rec) {
    /* Position: pseudo-random offset inside the sector cell, derived
     * from a second hash so it doesn't repeat the spawn-roll bits.
     * We bound the offset to ±36 m (matches SLAB_SOFT_EXTENT) so the
     * pickup never lands on a sector seam. */
    const [sx, sz] = key.split(",").map(Number);
    const SECTOR_SIZE = 80;
    const SOFT_EXTENT = 30;
    const r1 = _sectorHash01(`${key}|x`);
    const r2 = _sectorHash01(`${key}|z`);
    const cx = sx * SECTOR_SIZE + (r1 * 2 - 1) * SOFT_EXTENT;
    const cz = sz * SECTOR_SIZE + (r2 * 2 - 1) * SOFT_EXTENT;
    const mesh = _buildHealthSphereMesh();
    mesh.position.set(cx, HEALTH_SPHERE_BASE_Y, cz);
    rec = { key, mesh, baseY: HEALTH_SPHERE_BASE_Y };
    _healthSpheresBySectorKey.set(key, rec);
  }
  if (rec.mesh && !rec.mesh.parent) scene_.add(rec.mesh);
  return rec;
}

/** Detach the sphere for `key` from the scene without consuming it.
 *  Re-shows next time the sector is active (unless collected). */
function _deactivateHealthSphere(key) {
  const rec = _healthSpheresBySectorKey.get(key);
  if (rec?.mesh && rec.mesh.parent) rec.mesh.parent.remove(rec.mesh);
}

/** Per-frame tick: animate the bob/spin on every active sphere and
 *  collect any that the player has stepped into. Cheap — at most a
 *  handful of spheres are active at once (sectors are 5×5 around
 *  the player and 1/3 of those carry a sphere = ≤9 spheres). */
const _hsTmp = new THREE.Vector3();
function _tickHealthSpheres() {
  if (_healthSpheresBySectorKey.size === 0) return;
  if (gameOver_) return;            // dead players don't pick anything up
  const now = (typeof performance !== "undefined") ? performance.now() : Date.now();
  const playerPos = getPlayerPosition_ ? getPlayerPosition_() : null;
  for (const [key, rec] of _healthSpheresBySectorKey) {
    const m = rec.mesh;
    if (!m || !m.parent) continue;  // detached (sector unloaded)
    /* Hover bob + slow yaw spin. */
    const t = (now - m.userData.spawnedAt) * 0.001;
    m.position.y = rec.baseY + Math.sin(t * Math.PI * 2 * HEALTH_SPHERE_HOVER_HZ) * HEALTH_SPHERE_HOVER_AMP;
    m.rotation.y = t * HEALTH_SPHERE_SPIN_RATE;
    /* Collect on proximity. Use squared distance to skip the sqrt
     * for the common reject case. */
    if (!playerPos) continue;
    _hsTmp.copy(m.position).sub(playerPos);
    /* Player position is at floor level; the sphere hovers ~1.4 m
     * up. Compare planar XZ distance + a generous Y window so the
     * pickup triggers when the player walks under it. */
    const dxz2 = _hsTmp.x * _hsTmp.x + _hsTmp.z * _hsTmp.z;
    const dyAbs = Math.abs(m.position.y - playerPos.y - 1.0);   // ~head height bias
    if (dxz2 < HEALTH_SPHERE_COLLECT_R * HEALTH_SPHERE_COLLECT_R && dyAbs < 1.6) {
      _collectHealthSphere(key, rec);
    }
  }
}

function _collectHealthSphere(key, rec) {
  /* Restore HP to full. */
  playerHp_ = PLAYER_MAX_HP;
  /* Spatialised pickup cue (MP3 `healthPickup` when loaded). */
  if (audioListener_) {
    const buf = audioBuffers_.healthPickup || audioBuffers_.explosion;
    if (buf) {
      playOneShotAt(buf, rec.mesh.position, {
        volume: audioBuffers_.healthPickup ? 0.72 : 0.4,
        refDistance: 5,
      });
    }
  }
  /* Brief green flash on the damage overlay (re-using the red flash
   * machinery would require new infra; a simple "+HP" text ping is
   * cheap and avoids hijacking the damage-flash channel). */
  if (respawnOverlay_) {
    respawnOverlay_.style.color = "#88ff99";
    respawnOverlay_.style.opacity = "1";
    respawnOverlay_.textContent = "+HP — Health restored";
    setTimeout(() => {
      if (respawnOverlay_) {
        respawnOverlay_.style.opacity = "0";
        respawnOverlay_.style.color = "#ff8866";
      }
    }, 900);
  }
  /* Remove the mesh + bookkeeping. The "collected" set persists for
   * the rest of this run so this sector won't respawn the sphere on
   * re-load. */
  if (rec.mesh && rec.mesh.parent) rec.mesh.parent.remove(rec.mesh);
  _healthSpheresBySectorKey.delete(key);
  _collectedHealthSectors_.add(key);
}

/** Game-reset hook: forget every collected sphere so a fresh run
 *  has the full set of pickups available again. Must run before
 *  the next `notifySectorsChanged` cycle so newly-active sectors
 *  see clean state. */
function _resetHealthSpheres() {
  for (const rec of _healthSpheresBySectorKey.values()) {
    if (rec.mesh && rec.mesh.parent) rec.mesh.parent.remove(rec.mesh);
  }
  _healthSpheresBySectorKey.clear();
  _collectedHealthSectors_.clear();
}

/* ── AntiAirTurret class ────────────────────────────────────────────── */

/* HQ scale factor — the unit was previously toy-sized. Everything
 * below that uses raw geometry sizes is in metres at HQ_SCALE = 1
 * for legibility, and the whole `group` gets scaled at construction
 * time. */
const HQ_SCALE = 3.0;

/* Component HP. Tuned so the HQ takes 2-3 explosive arrows OR ~12
 * well-placed normal arrows:
 *
 *   AOE fanout: each blast deals `EXPLOSIVE_ARROW_BLAST_DAMAGE *
 *   HQ_AOE_FANOUT` damage to every unbroken component in radius.
 *   With fanout = 1.0 and blast = 70:
 *     - Explosive #1: plates 100 → 30 each (still intact).
 *                     pods 60 → break.    radar 50 → break.
 *                     body 250 → 180.     core: shielded (skipped).
 *     - Explosive #2: plates 30 → break (all four).
 *                     body 180 → 110.     core: STILL skipped because
 *                     `_isCoreShielded()` snapshots at top of
 *                     _detonateAOE before any plate gets damaged
 *                     this frame.
 *     - Explosive #3: plates already broken, so core is now reached:
 *                     core 130 → broken (70 × 2.0 crit = 140 dmg).
 *                     AA dies.
 *
 *   Normal arrows (14 dmg, no fanout, ray-cast picks ONE component):
 *     - 7 hits to break one plate.
 *     - +5 hits on the now-exposed core (14 × 2.0 = 28 per shot,
 *       core 130 HP) to finish it. ≈ 12 well-placed arrows total.
 *
 *   Body, pods, and radar are decorative-but-destructible: breaking
 *   them visually scorches/disables (radar = no self-track,
 *   pods = fewer missiles per salvo) but doesn't kill the HQ —
 *   only the core does.
 */
/* Plate HP — sized so 3 normal arrows (3 × 14 = 42) break a plate
 * outright. Explosives get a penetrating-shockwave that kills the
 * core directly on any chassis hit, so plate HP no longer gates the
 * explosive path; this value purely controls how quickly the
 * normal-arrow player can open a gap to fire 3 more arrows at the
 * core (total ~6 normals to destroy an HQ). */
const HQ_PLATE_HP = 30;
/* Core (power) HP — sized so:
 *   - 1 explosive arrow direct on the core (140 dmg = 70 blast × crit
 *     2.0 via the direct-hit bonus path) kills it outright;
 *   - 3 normal arrow direct hits (28 dmg each = 14 × crit 2.0,
 *     totalling 84) kill it.
 * The shielded-by-plates rule only blocks AOE wash damage; a
 * physically connecting arrow ray (which means at least one plate or
 * the top cap is already broken — otherwise the ray wouldn't reach
 * the core) deals damage regardless. */
const HQ_CORE_HP = 80;
const HQ_BODY_HP = 250;
const HQ_RADAR_HP = 50;
/* Pod (missile launcher) HP — user spec: "1 explosive arrow OR 3
 * normal arrows shot at a missile launcher unit should destroy each".
 * Pods have no crit multiplier (default 1.0), so:
 *   - 3 normal arrows = 3 × 14 = 42 dmg, just over 40 HP → broken;
 *   - 1 explosive direct (70 + AOE k=1 = 140) is overkill → broken;
 *   - 2 normal arrows = 28 < 40 → survives (the spec says THREE). */
const HQ_POD_HP = 40;
const HQ_AOE_FANOUT = 1.0;

const _antiairResources = {
  baseGeo: null, baseLightMat: null, baseDarkMat: null,
  pillarGeo: null, pillarMat: null,
  housingGeo: null, housingMat: null,
  shoulderGeo: null, shoulderMat: null,
  podGeo: null, podMat: null,
  podCapGeo: null, podCapMat: null,
  radarStandGeo: null, radarDishGeo: null, radarMat: null,
  coreGeo: null, coreMat: null,
  plateXGeo: null, plateZGeo: null, plateMat: null,
  coneGeo: null, coneMat: null,
};
function _ensureAntiAirResources() {
  const r = _antiairResources;
  if (r.baseGeo) return r;
  /* Concrete plinth — broad octagonal pad anchoring the HQ to the
   * rooftop. 3 m radius, 0.6 m tall (HQ_SCALE-multiplied at the
   * group). Two-tone so it reads as a built structure, not a prop. */
  r.baseGeo = new THREE.CylinderGeometry(3.0, 3.4, 0.6, 8);
  r.baseLightMat = new THREE.MeshStandardMaterial({
    color: 0x4a4e56, roughness: 0.92, metalness: 0.05,
  });
  r.baseDarkMat = new THREE.MeshStandardMaterial({
    color: 0x2c2e34, roughness: 0.85, metalness: 0.18,
  });
  /* Vertical support pillar that elevates the launcher above the
   * plinth so it has clearance to look down at the player. */
  r.pillarGeo = new THREE.CylinderGeometry(0.55, 0.65, 1.2, 12);
  r.pillarMat = new THREE.MeshStandardMaterial({
    color: 0x3a3e46, roughness: 0.75, metalness: 0.45,
  });
  /* Top + bottom caps — flat deck plates that form the housing's
   * roof and floor. The four sides of the housing are formed by
   * the destructible armor plates themselves (no separate frame
   * cube — see PLATE_DEFS in `_build`), so when a plate is broken
   * that entire face of the housing opens up to expose the core.
   * 2.0 m wide × 0.22 m tall × 2.0 m deep at HQ_SCALE = 1 → 6 ×
   * 0.66 × 6 m at HQ_SCALE = 3.0. */
  r.housingGeo = new THREE.BoxGeometry(2.0, 0.22, 2.0);
  r.housingMat = new THREE.MeshStandardMaterial({
    color: 0x363a42, roughness: 0.65, metalness: 0.55,
  });
  /* Shoulder pylons — angled wedges either side of the launcher
   * mounting the missile pods. */
  r.shoulderGeo = new THREE.BoxGeometry(0.7, 0.9, 1.6);
  r.shoulderMat = new THREE.MeshStandardMaterial({
    color: 0x44424a, roughness: 0.7, metalness: 0.5,
  });
  /* Missile tube — thicker than the old 0.12 m radius. */
  r.podGeo = new THREE.CylinderGeometry(0.28, 0.28, 1.6, 14);
  r.podMat = new THREE.MeshStandardMaterial({
    color: 0x4a4850, roughness: 0.55, metalness: 0.55,
  });
  r.podCapGeo = new THREE.ConeGeometry(0.30, 0.36, 14);
  r.podCapMat = new THREE.MeshStandardMaterial({
    color: 0xffaa22, emissive: 0xff4400, emissiveIntensity: 1.4,
    roughness: 0.4, metalness: 0.3,
  });
  /* Radar — proper stalk + dish on top of the housing, a bigger,
   * scarier silhouette. */
  r.radarStandGeo = new THREE.CylinderGeometry(0.10, 0.10, 0.9, 10);
  r.radarDishGeo = new THREE.SphereGeometry(0.55, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2.2);
  r.radarMat = new THREE.MeshStandardMaterial({
    color: 0x8a96a8, emissive: 0x223044, emissiveIntensity: 1.0,
    roughness: 0.4, metalness: 0.75, side: THREE.DoubleSide,
  });
  /* Power core — large glowing sphere at the heart of the housing.
   * Initially hidden behind 4 armor plates (the "weak spot" the
   * player has to expose). When all plates on the relevant face are
   * broken, ray-casts can reach the core directly. */
  r.coreGeo = new THREE.SphereGeometry(0.55, 18, 14);
  r.coreMat = new THREE.MeshStandardMaterial({
    color: 0x1a3548, emissive: 0x44aaff, emissiveIntensity: 2.6,
    roughness: 0.35, metalness: 0.6, toneMapped: true,
  });
  /* Armor plates — 4 large plates wrapping the core (front, back,
   * left, right). Each plate IS one face of the housing cube: the
   * front/back are 2.0 × 1.8 × 0.18 (oriented with thin Z); the
   * left/right are 0.18 × 1.8 × 2.0 (thin X). They visually read
   * as "removable armor". Geometrically they ARE the things the
   * arrow ray hits before reaching the core, so destroying a plate
   * fully opens that face of the housing. For AOE damage we
   * additionally gate the core's per-component damage on "any plate
   * intact", so a single explosive can't one-shot through fully-
   * intact armor. */
  r.plateZGeo = new THREE.BoxGeometry(2.0, 1.8, 0.18);   // front + back
  r.plateXGeo = new THREE.BoxGeometry(0.18, 1.8, 2.0);   // left + right
  r.plateMat = new THREE.MeshStandardMaterial({
    color: 0x52555c, roughness: 0.5, metalness: 0.85,
    emissive: 0x202428, emissiveIntensity: 0.3,
  });
  /* Vision cone — semi-transparent, yaw/pitch matches launcher. We
   * scale it Y to narrow during AIM. Cone default points -Y, but our
   * launcher's "forward" is its local +Z, so we rotate the cone to
   * align: position so the apex is at the launcher origin, base
   * extends along +Z. */
  r.coneGeo = new THREE.ConeGeometry(
    ANTIAIR_VISION_LENGTH * Math.tan(ANTIAIR_VISION_HALF_ANGLE_DEG * Math.PI / 180),
    ANTIAIR_VISION_LENGTH, 24, 1, true,
  );
  r.coneMat = new THREE.MeshBasicMaterial({
    color: 0x66bbff, transparent: true, opacity: 0.10,
    depthWrite: false, side: THREE.DoubleSide, fog: true,
  });
  return r;
}

class AntiAirTurret {
  constructor(anchor) {
    this.anchor = anchor;        // {x, y, z, yaw, w, d, sx, sz, key}
    this.sectorKey = anchor.key;
    this.dead = false;
    this.state = "SLEEP";
    this.stateTime = 0;
    this.aimFocus = 0;            // 0..1 — narrowing cone driver
    this.cooldownTimer = 0;       // s remaining in COOLDOWN
    this.salvoIndex = 0;          // 0..ANTIAIR_SALVO_COUNT (advanced during FIRE)
    this.salvoTimer = 0;          // s until next missile in salvo
    /* "Spotted" timestamp updated by snitch relay or self-acquisition.
     * Older than ANTIAIR_RELAY_GRACE_S → treated as not seen. */
    this.lastSpottedT = -1e9;
    this.lkp = new THREE.Vector3();
    /* Snitch-called ballistic rocket volleys (cooldown in seconds). */
    this._nextArtilleryAt = 0;
    /* Throttle HQ→snitch scout pings so sustained MG chip damage doesn't
     * re-queue the same scout every frame. */
    this._lastSnitchPingT = -1e9;
    /* Build mesh + components. */
    this._build();
    scene_.add(this.group);
  }

  _build() {
    const r = _ensureAntiAirResources();
    this.group = new THREE.Group();
    this.group.name = `antiair_${this.sectorKey}`;
    this.group.position.set(this.anchor.x, this.anchor.y, this.anchor.z);
    this.group.rotation.y = this.anchor.yaw || 0;
    this.group.scale.setScalar(HQ_SCALE);
    /* Components list mirrors the drone pattern so the existing damage
     * pipeline works (kind / hp / maxHp / broken in userData). */
    this.components = [];
    /* Plate refs — ordered FRONT, BACK, LEFT, RIGHT in pivot-local
     * space. Used by `_isCoreShielded()` to skip core damage while
     * any plate is intact, and by the arrow ray collision (plates are
     * in the same intersectObject sweep, so they naturally block
     * the ray to the core until they're broken/hidden). */
    this.plates = [];

    /* Concrete plinth — two-tone, deliberately "built" looking. Sits
     * flush on the rooftop. The base picks up shadows but doesn't
     * itself block missile fire (it's BELOW the launcher pivot). */
    const baseLight = new THREE.Mesh(r.baseGeo, r.baseLightMat);
    baseLight.position.y = 0.30;
    baseLight.castShadow = true;
    baseLight.receiveShadow = true;
    baseLight.userData.antiair = this;
    this.group.add(baseLight);
    /* Inner darker ring at slightly higher Y for visual depth. */
    const baseRing = new THREE.Mesh(
      new THREE.CylinderGeometry(2.4, 2.4, 0.20, 8), r.baseDarkMat,
    );
    baseRing.position.y = 0.71;
    baseRing.castShadow = false;
    baseRing.receiveShadow = true;
    baseRing.userData.antiair = this;
    this.group.add(baseRing);

    /* Vertical support pillar so the launcher pivots above the plinth
     * with clearance to look down at the player. */
    const pillar = new THREE.Mesh(r.pillarGeo, r.pillarMat);
    pillar.position.y = 0.60 + 0.20 + 0.60;     // base top + ring + pillar half-height
    pillar.castShadow = true;
    pillar.userData.antiair = this;
    this.group.add(pillar);

    /* Launcher pivot — child group that yaws/pitches to aim. The
     * cone, pods, radar, plates, and core all live on the pivot so
     * they track the aim solution together. The pivot height is
     * sized so the housing's bottom cap (at pivot-local y = -1.01)
     * sits just above the pillar top (pillar top at group-local
     * y = 0.60 base + 0.20 ring + 1.20 pillar = 2.00). pivot.y =
     * 3.05 puts cap bottom at 3.05 - 1.01 = 2.04 — a clean 0.04 m
     * (= 0.12 m world at HQ_SCALE 3) seam between pillar and
     * housing, no z-fighting. */
    const pivot = new THREE.Group();
    pivot.name = "launcherPivot";
    pivot.position.y = 3.05;
    this.group.add(pivot);
    this.pivot = pivot;

    /* Top + bottom caps form the housing's flat surfaces. The four
     * lateral sides are formed by the destructible armor plates
     * (built below). We tag the TOP CAP as the "body" component
     * for damage routing on hits that fall through to the body
     * fallback (e.g. striking the radar stalk passes the kind-=-
     * undefined check and falls back to body). Body kills don't
     * take down the HQ — only the core does — but breaking the
     * body visibly scorches it. */
    const topCap = new THREE.Mesh(r.housingGeo, r.housingMat);
    topCap.position.y = 0.90 + 0.11;        // plate top + half-cap thickness
    topCap.userData = { kind: "body", hp: HQ_BODY_HP, maxHp: HQ_BODY_HP, broken: false, crit: 1.0, antiair: this };
    topCap.castShadow = true;
    topCap.receiveShadow = true;
    pivot.add(topCap);
    this.components.push(topCap);
    this.body = topCap;

    const botCap = new THREE.Mesh(r.housingGeo, r.housingMat);
    botCap.position.y = -0.90 - 0.11;
    botCap.userData.antiair = this;
    botCap.castShadow = true;
    botCap.receiveShadow = true;
    pivot.add(botCap);

    /* Shoulder pylons left and right — mounting points for the
     * outer two missile pods. Sit OUTSIDE the housing footprint
     * so the silhouette spreads dramatically when seen from
     * front-on. */
    for (const sx of [-1, 1]) {
      const sh = new THREE.Mesh(r.shoulderGeo, r.shoulderMat);
      sh.position.set(sx * 1.55, 1.00, 0.20);
      sh.userData.antiair = this;
      sh.castShadow = true;
      pivot.add(sh);
    }

    /* Twin forward-heavy MGs (destroyable) — same visual order of
     * magnitude as the pod rockets (long barrel along +Z like the
     * tubes) so they read as primary armament, not tiny side blisters. */
    this.machineGuns = [];
    const mgBarrelMat = new THREE.MeshStandardMaterial({
      color: 0x1c1e22, roughness: 0.38, metalness: 0.88,
      emissive: 0x1a0804, emissiveIntensity: 0.12,
    });
    const mgDrumMat = new THREE.MeshStandardMaterial({
      color: 0x25272c, roughness: 0.48, metalness: 0.78,
      emissive: 0x000000, emissiveIntensity: 0,
    });
    for (const sx of [-1, 1]) {
      const barrelGeo = new THREE.CylinderGeometry(0.30, 0.34, 1.38, 14);
      barrelGeo.rotateX(Math.PI / 2);
      const mg = new THREE.Mesh(barrelGeo, mgBarrelMat.clone());
      /* Muzzle ~forward; slight yaw so the pair frames the housing. */
      mg.position.set(sx * 1.22, 0.36, 0.62);
      mg.rotation.y = sx * 0.11;
      const drum = new THREE.Mesh(
        new THREE.CylinderGeometry(0.36, 0.36, 0.26, 16),
        mgDrumMat.clone(),
      );
      drum.rotation.z = Math.PI / 2;
      drum.position.set(-sx * 0.34, 0, -0.52);
      drum.castShadow = true;
      mg.add(drum);
      mg.userData = {
        kind: "hmg", hp: HQ_MG_HP, maxHp: HQ_MG_HP, broken: false,
        antiair: this, side: sx, flashT: 0,
      };
      mg.castShadow = true;
      pivot.add(mg);
      this.components.push(mg);
      this.machineGuns.push(mg);
    }

    /* Three pods mounted on the shoulders + the housing roof.
     * Distinct LIVE cap meshes so we can hide the cap after the
     * missile is fired from that pod. Pod axis: cylinder default
     * +Y → rotate to align with +Z = launcher forward. The center
     * pod sits a touch higher than the shoulder pair so the
     * silhouette has a clear "tower of three" tiered layout. */
    this.pods = [];
    const POD_OFFS = [
      [-1.55, 1.20, 0.50],
      [ 0.00, 1.30, 0.50],
      [ 1.55, 1.20, 0.50],
    ];
    for (let i = 0; i < 3; i++) {
      const pod = new THREE.Mesh(r.podGeo, r.podMat);
      pod.position.set(POD_OFFS[i][0], POD_OFFS[i][1], POD_OFFS[i][2]);
      pod.rotation.x = Math.PI / 2;
      pod.userData = { kind: "pod", hp: HQ_POD_HP, maxHp: HQ_POD_HP, broken: false, antiair: this, podIndex: i };
      pod.castShadow = true;
      pivot.add(pod);
      this.components.push(pod);
      const cap = new THREE.Mesh(r.podCapGeo, r.podCapMat);
      cap.position.set(POD_OFFS[i][0], POD_OFFS[i][1], POD_OFFS[i][2] + 0.95);
      cap.rotation.x = Math.PI / 2;
      /* `componentRef` makes hits on the cap (the front hemisphere
       * a player naturally aims at when shooting "at the launcher")
       * route to the pod's HP pool — without it `findComponent`
       * would walk past the cap up to the pivot, return null, and
       * the AA hit handler would mistakenly damage the top cap. */
      cap.userData = { podCap: true, antiair: this, componentRef: pod };
      pivot.add(cap);
      this.pods.push({ pod, cap });
    }

    /* Radar — vertical stalk + dish on top of the back-edge of the
     * housing roof. Breaking the dish disables passive self-track
     * (the AA then needs a snitch relay to maintain lock). */
    const stand = new THREE.Mesh(r.radarStandGeo, r.radarMat);
    stand.position.set(0, 1.55, -0.90);
    stand.castShadow = true;
    stand.userData.antiair = this;
    pivot.add(stand);
    const dish = new THREE.Mesh(r.radarDishGeo, r.radarMat);
    dish.position.set(0, 2.10, -0.90);
    dish.rotation.x = -Math.PI / 6;
    dish.userData = { kind: "targeting", hp: HQ_RADAR_HP, maxHp: HQ_RADAR_HP, broken: false, antiair: this };
    dish.castShadow = true;
    pivot.add(dish);
    this.components.push(dish);
    this.radar = dish;

    /* Power core — large glowing sphere INSIDE the housing. Starts
     * shielded by the 4 plates below; arrow rays will hit the plates
     * first. Crit zone (2× damage) → 7 normal arrows or 2 explosives
     * once exposed. Breaking it kills the HQ. */
    const core = new THREE.Mesh(r.coreGeo, r.coreMat);
    core.position.set(0, 0.0, 0);
    core.userData = { kind: "power", hp: HQ_CORE_HP, maxHp: HQ_CORE_HP, broken: false, crit: 2.0, antiair: this };
    pivot.add(core);
    this.components.push(core);
    this.core = core;

    /* Armor plates — 4 large plates that ARE the lateral faces of
     * the housing cube. Each plate uses geometry sized to fully
     * match its face so there are no gaps between the plate and
     * the top/bottom caps for arrow rays to slip through. The
     * front/back plates use plateZGeo (thin in Z); the left/right
     * use plateXGeo (thin in X). Position offsets put the plate's
     * outer face flush with where the closed cube would be (cap
     * half-width 1.0 + plate half-thickness 0.09 = 1.09).
     *
     * Geometrically these ARE what the arrow ray hits before the
     * core, so destroying a plate fully opens that face. Gameplay-
     * wise the four plates are tracked uniformly: any one intact
     * → core is AOE-shielded; all broken → core is fully exposed. */
    const PLATE_DEFS = [
      { name: "front", geo: r.plateZGeo, pos: [0, 0,  1.09] },
      { name: "back",  geo: r.plateZGeo, pos: [0, 0, -1.09] },
      { name: "left",  geo: r.plateXGeo, pos: [-1.09, 0, 0] },
      { name: "right", geo: r.plateXGeo, pos: [ 1.09, 0, 0] },
    ];
    for (const def of PLATE_DEFS) {
      const plate = new THREE.Mesh(def.geo, r.plateMat.clone());
      plate.position.set(def.pos[0], def.pos[1], def.pos[2]);
      plate.userData = {
        kind: "plate", hp: HQ_PLATE_HP, maxHp: HQ_PLATE_HP, broken: false,
        antiair: this, face: def.name, crit: 1.0,
      };
      plate.castShadow = true;
      plate.receiveShadow = true;
      pivot.add(plate);
      this.components.push(plate);
      this.plates.push(plate);
    }

    /* Vision cone — apex at launcher origin, extends along +Z. The
     * group is scaled by HQ_SCALE; if we left the cone unscaled it
     * would project HQ_SCALE × ANTIAIR_VISION_LENGTH metres in
     * world space (way too long). Counter-scale it by 1/HQ_SCALE
     * so the cone geometry (built at full ANTIAIR_VISION_LENGTH)
     * ends up exactly ANTIAIR_VISION_LENGTH metres long after
     * parenting. The same factor is applied to the local Z offset
     * so the cone apex still sits at the launcher's world origin. */
    const cone = new THREE.Mesh(r.coneGeo, r.coneMat.clone());
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = (ANTIAIR_VISION_LENGTH / 2) / HQ_SCALE;
    cone.scale.setScalar(1 / HQ_SCALE);
    cone.castShadow = false;
    cone.userData.antiairCone = true;
    /* The cone is a visual indicator only; arrow ray-casts must
     * pass straight through it to reach the actual AA components
     * behind it. Three.js: making `raycast` a no-op excludes the
     * mesh from intersectObject() entirely. */
    cone.raycast = function () {};
    pivot.add(cone);
    this.cone = cone;
  }

  /** True if at least one armor plate is still intact. While shielded,
   *  the core is invulnerable to AOE damage in `_detonateAOE`. */
  _isCoreShielded() {
    for (const p of this.plates) {
      if (!p.userData.broken) return true;
    }
    return false;
  }

  isUnderRelay() {
    return (performance.now() / 1000) - this.lastSpottedT < ANTIAIR_RELAY_GRACE_S;
  }

  /** True when the launcher bore is aligned with the horizon-clamped
   *  direction toward `worldTarget` (same rule as `_aimAt`). */
  _launcherOnTarget(worldTarget) {
    this.pivot.getWorldPosition(_aaPos);
    _aaTmp.copy(worldTarget).sub(_aaPos);
    if (_aaTmp.lengthSq() < 1e-8) return true;
    _aaTmp.normalize();
    _aaQuat.copy(this.pivot.getWorldQuaternion(_aaQuatTarget));
    _aaQuat.invert();
    _aaTmp.applyQuaternion(_aaQuat);
    if (_aaTmp.y < 0) _aaTmp.y = 0;
    if (_aaTmp.lengthSq() < 1e-8) return false;
    _aaTmp.normalize();
    return _aaTmp.z >= ANTIAIR_AIM_ALIGN_DOT;
  }

  /* Slerp the launcher pivot's local-frame rotation toward the
   * direction "look at world `target`". Convert the world target
   * into the group's local frame, subtract the pivot's local
   * position to get a local-frame look-direction, then build a
   * quaternion that maps the pivot's local +Z onto that direction.
   * Slerp at ANTIAIR_SLEW_RATE so the launcher visibly tracks rather
   * than snapping. */
  _aimAt(target, dt) {
    this.group.updateMatrixWorld(true);
    this.pivot.getWorldPosition(_aaPos);
    _aaTmp.copy(target).sub(_aaPos);
    if (_aaTmp.lengthSq() < 1e-6) return;
    /* Pivot-local look direction — cannot pitch below the local
     * horizontal plane (launcher never aims "into the ground" past
     * level; low ground targets are engaged by HMG + snitch artillery). */
    _aaQuat.copy(this.pivot.getWorldQuaternion(_aaQuatTarget));
    _aaQuat.invert();
    _aaTmp.applyQuaternion(_aaQuat);
    if (_aaTmp.y < 0) _aaTmp.y = 0;
    if (_aaTmp.lengthSq() < 1e-8) _aaTmp.set(0, 0, 1);
    else _aaTmp.normalize();
    _aaTmp2.set(0, 0, 1);
    _aaQuatTarget.setFromUnitVectors(_aaTmp2, _aaTmp);
    const slerpT = Math.min(1, ANTIAIR_SLEW_RATE * dt);
    this.pivot.quaternion.slerp(_aaQuatTarget, slerpT);
  }

  /** Returns true if the player is in the launcher's vision cone with
   *  an unobstructed line-of-sight from the launcher's world position.
   *  This is used both for self-acquisition (radar working) and for
   *  the FIRE-eligibility check (must still see the player to release
   *  the salvo, even if a snitch fed us the relay). */
  _seesPlayer(playerHead) {
    /* Launcher world position. */
    this.pivot.getWorldPosition(_aaPos);
    /* Clamped pivot-local direction to target (same horizon rule as _aimAt). */
    _aaTmp.copy(playerHead).sub(_aaPos);
    const dist = _aaTmp.length();
    if (dist > ANTIAIR_VISION_LENGTH) return false;
    _aaTmp.multiplyScalar(1 / dist);
    _aaQuat.copy(this.pivot.getWorldQuaternion(_aaQuatTarget));
    _aaQuat.invert();
    _aaTmp.applyQuaternion(_aaQuat);
    if (_aaTmp.y < 0) _aaTmp.y = 0;
    if (_aaTmp.lengthSq() < 1e-8) _aaTmp.set(0, 0, 1);
    else _aaTmp.normalize();
    /* Cone test in pivot space: cos(angle) vs local +Z. */
    if (_aaTmp.z < ANTIAIR_VISION_DOT) return false;
    /* OBB-blocked? Same hasLineOfSight ray as drones use. */
    return hasLineOfSight(_aaPos, playerHead, ANTIAIR_VISION_LENGTH);
  }

  /** Apply damage to a specific component. Mirrors Drone.takeDamage
   *  but stripped down — no shield, no chips, no FSM disruption (the
   *  AA's whole purpose is to focus on you, getting shot doesn't
   *  break the lock-on the way it does for drones). The aim DOES
   *  reset though, same as drones. */
  takeDamage(component, dmg, hitDir, attackerWorld) {
    if (this.dead || component.userData.broken) return;
    const crit = component.userData.crit || 1.0;
    component.userData.hp -= dmg * crit;
    flashComponentHit(component);
    playMetalHitAt(this.pivot.getWorldPosition(_aaPos), { volume: 0.85, refDistance: 4 });
    /* Nearest snitch scouts the shooter's last position (arrow origin). */
    if (attackerWorld && Number.isFinite(attackerWorld.x + attackerWorld.y + attackerWorld.z)) {
      const nowS = performance.now() / 1000;
      if (nowS - this._lastSnitchPingT > 2.2) {
        this._lastSnitchPingT = nowS;
        dispatchNearestSnitchInvestigate(this, attackerWorld);
      }
    }
    /* Hit cancels aim — same "interrupt the lock-on" mechanic. */
    if (this.state === "AIM") {
      this.aimFocus = 0;
    }
    if (component.userData.hp <= 0) {
      this._breakComponent(component);
    }
  }

  _breakComponent(c) {
    if (c.userData.broken) return;
    c.userData.broken = true;
    if (c.material && c.material.emissive) {
      c.material = c.material.clone();
      c.material.emissive.setHex(0x000000);
      c.material.color.multiplyScalar(0.5);
    }
    const kind = c.userData.kind;
    if (kind === "hmg") {
      c.visible = false;
      c.raycast = function () {};
      this._spawnComponentDebris(c);
      return;
    }
    if (kind === "pod") {
      /* Hide the pod tube + remaining cap. The salvo logic skips
       * broken pods. Spawn a small debris fragment so the player
       * sees the kill register. */
      c.visible = false;
      const podRec = this.pods[c.userData.podIndex];
      if (podRec && podRec.cap) podRec.cap.visible = false;
      this._spawnComponentDebris(c);
      return;
    }
    if (kind === "targeting") {
      /* Radar dish blown — AA can no longer self-acquire, must rely
       * on snitch relay to fire. The dish stays visible (kinked, but
       * mounted). */
      this._spawnComponentDebris(c);
      return;
    }
    if (kind === "plate") {
      /* Armor plate destroyed — disappear entirely so the arrow ray
       * can reach the core and the player visibly sees a "weak spot
       * exposed". A loud break SFX + debris sells the moment. */
      c.visible = false;
      c.raycast = function () {};
      this._spawnComponentDebris(c);
      playExplosionImpactAt(c.getWorldPosition(_aaPos), {
        volume: 0.65, refDistance: 8,
      });
      return;
    }
    if (kind === "body") {
      /* Top cap blown off — hide it so the roof of the housing
       * opens up. Future arrow shots from above slip through to the
       * core directly. The HQ remains operational (the core does
       * the actual killing); the cap break just creates a new
       * vulnerability angle. */
      c.visible = false;
      c.raycast = function () {};
      this._spawnComponentDebris(c);
      playExplosionImpactAt(c.getWorldPosition(_aaPos), {
        volume: 0.55, refDistance: 8,
      });
      return;
    }
    if (kind === "power") {
      this.die();
    }
  }

  _spawnComponentDebris(c) {
    const wp = new THREE.Vector3();
    c.getWorldPosition(wp);
    debris_.push({
      mesh: new THREE.Mesh(c.geometry, c.material),
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 1.5,
        Math.random() * 1.0 + 0.5,
        (Math.random() - 0.5) * 1.5,
      ),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 5,
        (Math.random() - 0.5) * 5,
        (Math.random() - 0.5) * 5,
      ),
      ttl: 1.5,
    });
    debris_[debris_.length - 1].mesh.position.copy(wp);
    scene_.add(debris_[debris_.length - 1].mesh);
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    /* Score: HQs are weighted heavily in the run total, so this is
     * the moment to bump the counter. The reset path zeroes
     * hqKills_, so each life starts fresh. */
    hqKills_++;
    /* Big central explosion at the core. */
    this.core.getWorldPosition(_aaPos);
    playExplosionImpactAt(_aaPos, { volume: 1.4, refDistance: 14 });
    _spawnExplosionFx(_aaPos);
    /* Cinematic disintegration — every still-attached pivot child
     * (plates, pods, pod caps, top + bottom caps, shoulders, radar
     * stand + dish, the cone visualisation, even the core sphere)
     * detaches as falling debris. The pillar and base plinth stay
     * because the user's brief was: "only its stand" should remain
     * after the explosion. We do this BEFORE hiding the pivot so the
     * world-space transforms snapshotted by `_detachAsDebris` are
     * still up-to-date.
     *
     * `_detachAsDebris` reparents the mesh to the scene root and
     * pushes it onto the global debris_ list so the existing
     * gravity + tumble + ttl tick takes over.  A handful of small
     * secondary explosions on the pods + radar lend the moment the
     * "huge explosion" rumble the user asked for. */
    if (this.pivot) {
      const pivotChildren = this.pivot.children.slice();
      for (const child of pivotChildren) {
        if (!(child instanceof THREE.Mesh)) continue;
        if (!child.visible) continue;
        this._detachAsDebrisWithBlast(child);
      }
      /* Secondary explosion on each unbroken pod so the "modules
       * exploding outward" reads visually. */
      for (const podRec of this.pods) {
        if (!podRec.pod.userData.broken) {
          podRec.pod.getWorldPosition(_aaPos);
          playExplosionImpactAt(_aaPos, { volume: 0.7, refDistance: 10 });
          _spawnExplosionFx(_aaPos);
        }
      }
      /* Hide the now-empty pivot group. The pillar + base remain as
       * the "stand" left behind. */
      this.pivot.visible = false;
    }
    /* Mark every component broken so debug snapshots and any later
     * AOE walks treat them as gone. */
    for (const c of this.components) {
      c.userData.broken = true;
      c.userData.hp = 0;
    }
  }

  /** Reparent a mesh (a pivot child like a plate, pod, radar dish,
   *  pod cap, etc.) to the scene root and push it onto the global
   *  debris list with a small randomised launch impulse so it flies
   *  outward from the explosion centre. Used on AA death to make the
   *  modules visibly fall / fly off the launcher. */
  _detachAsDebrisWithBlast(mesh) {
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    const ws = new THREE.Vector3();
    mesh.matrixWorld.decompose(wp, wq, ws);
    if (mesh.parent) mesh.parent.remove(mesh);
    mesh.position.copy(wp);
    mesh.quaternion.copy(wq);
    mesh.scale.copy(ws);
    /* Outward radial impulse from the core (so plates fly outward,
     * pods drop and tumble, etc.). 4-7 m/s spread + lift. */
    this.core.getWorldPosition(_aaTmp);
    const dir = new THREE.Vector3().subVectors(wp, _aaTmp);
    if (dir.lengthSq() < 1e-4) {
      dir.set(
        (Math.random() - 0.5) * 1.5,
        1.0,
        (Math.random() - 0.5) * 1.5,
      );
    } else {
      dir.normalize();
    }
    const speed = 4 + Math.random() * 3;
    const velocity = new THREE.Vector3(
      dir.x * speed,
      Math.max(2, dir.y * speed) + 1,    // some upward kick regardless
      dir.z * speed,
    );
    debris_.push({
      mesh,
      velocity,
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 6,
      ),
      ttl: 5.0,
    });
    scene_.add(mesh);
  }

  /** Per-frame tick. `playerHead` and `playerInLOS` are computed once
   *  in updateBots and shared across all turrets so we don't redo
   *  the LOS work N times. */
  update(dt, playerHead) {
    if (this.dead) return;
    if (!this.machineGuns) this.machineGuns = [];
    this.stateTime += dt;
    /* HMG muzzle flash (runs even if AIM returns early). */
    const _mgFlashDur = 0.12;
    for (const mg of this.machineGuns) {
      if (mg.userData.broken) continue;
      let ft = mg.userData.flashT || 0;
      if (ft <= 0) continue;
      ft -= dt;
      mg.userData.flashT = ft;
      const m = mg.material;
      if (m) {
        const u = THREE.MathUtils.clamp(ft / _mgFlashDur, 0, 1);
        m.emissiveIntensity = 0.12 + u * 2.6;
        if (ft <= 0 && m.emissive) m.emissive.setHex(0x1a0804);
      }
    }
    const seenNow = this._seesPlayer(playerHead);
    /* If we have LOS, mark spotted ourselves (radar passive track). */
    if (seenNow && !this.radar.userData.broken) {
      this.lastSpottedT = performance.now() / 1000;
      this.lkp.copy(playerHead);
    }
    const underRelay = this.isUnderRelay();
    const aimAtSomething = seenNow || underRelay;
    /* World point the launcher should track: player head when we
     * self-see or radar is up; last relayed LKP when radar is dead
     * but a snitch is still feeding us. */
    _aaSlewScratch.copy(playerHead);
    if (!seenNow && this.radar.userData.broken && underRelay) {
      _aaSlewScratch.copy(this.lkp);
    }
    /* Slew: when engaging, always track the chosen aim point (no short
     * passive-range gate — that left the cone narrowing while the
     * barrel still pointed the wrong way). Idle patrol still uses the
     * shorter range so distant AAs don't all crank toward the player. */
    if (aimAtSomething) {
      this._aimAt(_aaSlewScratch, dt);
    } else {
      this.pivot.getWorldPosition(_aaPos);
      const trackDistSq = playerHead.distanceToSquared(_aaPos);
      const trackR = ANTIAIR_VISION_LENGTH * ANTIAIR_TRACK_RANGE_MUL;
      if (trackDistSq < trackR * trackR) {
        this._aimAt(playerHead, dt);
      }
    }
    const aimAligned = this._launcherOnTarget(_aaSlewScratch);
    /* Visible cone width: shrinks as aim-focus grows. The cone mesh
     * default radius is at full width; we scale x/z to shrink it.
     * All three axes carry the 1/HQ_SCALE counter-scale so the
     * cone keeps a constant world-space length regardless of which
     * axis we fiddle with for the narrowing animation. */
    const coneFocus = aimAligned ? this.aimFocus : this.aimFocus * 0.32;
    const widthK = THREE.MathUtils.lerp(1.0, ANTIAIR_VISION_NARROW_RATIO, coneFocus);
    if (this.cone) {
      const inv = 1 / HQ_SCALE;
      /* Wall-truncation: bore + mantle rays vs world OBBs (wide cones
       * otherwise slice through façades on a single-axis raycast). */
      this.pivot.updateMatrixWorld(true);
      _vconeApexW.copy(_coneApexZero).applyMatrix4(this.pivot.matrixWorld);
      _vconeFwdW.set(0, 0, 1).transformDirection(this.pivot.matrixWorld);
      const tanFull = Math.tan((ANTIAIR_VISION_HALF_ANGLE_DEG * Math.PI) / 180);
      const halfAng = Math.atan2(ANTIAIR_VISION_LENGTH * tanFull * widthK, ANTIAIR_VISION_LENGTH);
      const occLen = _coneOccludedLengthWorld(
        _vconeApexW, _vconeFwdW, ANTIAIR_VISION_LENGTH, halfAng, VISION_CONE_TRUNC_RING_SEGS,
      );
      const lenScale = occLen / ANTIAIR_VISION_LENGTH;
      this.cone.scale.set(widthK * inv, inv * lenScale, widthK * inv);
      this.cone.position.z = (occLen / 2) / HQ_SCALE;
      /* Cone colour: blue (sleeping) → orange (aiming) → red (firing/cooldown). */
      let hex;
      if (this.state === "FIRE" || this.state === "COOLDOWN") hex = 0xff3322;
      else if (this.state === "AIM" || aimAtSomething) hex = 0xffaa22;
      else hex = 0x4488ff;
      this.cone.material.color.setHex(hex);
      /* Pulse opacity in AIM — widens when not bore-aligned. */
      const baseOp = 0.10 + 0.18 * coneFocus;
      this.cone.material.opacity = baseOp;
    }

    /* FSM. */
    if (this.state === "SLEEP") {
      if (aimAtSomething) {
        this.state = "AIM";
        this.stateTime = 0;
        this.aimFocus = 0;
      }
    } else if (this.state === "AIM") {
      /* Need at least one HMG or missile pod — otherwise nothing to fire. */
      if (!this._hasOffensiveCapability()) {
        this.aimFocus = 0;
        return;
      }
      if (aimAtSomething) {
        /* Radar broken AND no relay → can't ramp aim. */
        const canTrack = !this.radar.userData.broken || underRelay;
        if (canTrack && aimAligned) {
          /* Faster ramp when radar AND relay both active. */
          const ramp = (this.radar.userData.broken ? 0.6 : 1.0) * (underRelay ? 1.2 : 1.0);
          this.aimFocus = Math.min(1, this.aimFocus + (dt / ANTIAIR_AIM_TIME) * ramp);
        } else if (canTrack) {
          /* Have a track solution but barrel not yet on target — bleed. */
          this.aimFocus = Math.max(0, this.aimFocus - dt * 0.55);
        } else {
          /* No track → bleed focus. */
          this.aimFocus = Math.max(0, this.aimFocus - dt / 0.8);
        }
        if (this.aimFocus >= 0.99 && (seenNow || underRelay) && aimAligned) {
          this.state = "FIRE";
          this.stateTime = 0;
          this.salvoIndex = 0;
          this.salvoTimer = 0;
        }
      } else {
        /* Lost everything → bleed focus, eventually drop back to SLEEP. */
        this.aimFocus = Math.max(0, this.aimFocus - dt / 0.8);
        if (this.aimFocus <= 0 && this.stateTime > 1.5) {
          this.state = "SLEEP";
          this.stateTime = 0;
        }
      }
    } else if (this.state === "FIRE") {
      /* Twin HMG burst cadence (pods keep their big rockets for snitch-
       * called ballistic strikes only). */
      this.salvoTimer -= dt;
      if (this.salvoTimer <= 0 && this.salvoIndex < ANTIAIR_SALVO_COUNT) {
        this._fireMgBurst(playerHead);
        this.salvoIndex++;
        this.salvoTimer = ANTIAIR_SALVO_INTERVAL;
      }
      if (this.salvoIndex >= ANTIAIR_SALVO_COUNT) {
        this.state = "COOLDOWN";
        this.stateTime = 0;
        this.cooldownTimer = ANTIAIR_COOLDOWN_S;
      }
    } else if (this.state === "COOLDOWN") {
      this.cooldownTimer -= dt;
      this.aimFocus = Math.max(0, this.aimFocus - dt * 1.5);
      if (this.cooldownTimer <= 0) {
        this.state = aimAtSomething ? "AIM" : "SLEEP";
        this.stateTime = 0;
        this.aimFocus = 0;
      }
    }
  }

  _livePodCount() {
    let n = 0;
    for (const rec of this.pods) if (!rec.pod.userData.broken) n++;
    return n;
  }

  _hasOffensiveCapability() {
    for (const mg of this.machineGuns) {
      if (!mg.userData.broken) return true;
    }
    for (const rec of this.pods) {
      if (!rec.pod.userData.broken) return true;
    }
    return false;
  }

  /** Burst the brow machine-guns — spawns visible tracers; damage only on hit. */
  _fireMgBurst(playerHead) {
    if (this.dead || playerDead() || gameOver_) return;
    _aaSlewScratch.copy(playerHead);
    if (!this._seesPlayer(playerHead) && this.radar.userData.broken && this.isUnderRelay()) {
      _aaSlewScratch.copy(this.lkp);
    }
    if (!this._launcherOnTarget(_aaSlewScratch)) return;
    let fired = false;
    for (const mg of this.machineGuns) {
      if (mg.userData.broken) continue;
      mg.updateMatrixWorld(true);
      mg.getWorldPosition(_aaTmp2);
      if (!hasLineOfSight(_aaTmp2, playerHead, ANTIAIR_VISION_LENGTH * 1.2)) continue;
      fired = true;
      mg.userData.flashT = 0.12;
      const m = mg.material;
      if (m?.emissive) m.emissive.setHex(0xffcc77);
      /* Tracers leave along the barrel axis (+Z in mesh space), not a
       * chord toward the head (which looked like random angles). */
      mg.getWorldQuaternion(_q0);
      _missileNorm.set(0, 0, 1).applyQuaternion(_q0).normalize();
      _aaTmp.copy(_missileNorm).multiplyScalar(0.69 * HQ_SCALE);
      _aaTmp2.add(_aaTmp);
      spawnHqMgRound(_aaTmp2.clone(), _missileNorm.clone(), this);
    }
    if (!fired) return;
    this.pivot.getWorldPosition(_aaPos);
    playOneShotAt(
      audioBuffers_.rifleFire || audioBuffers_.botShot, _aaPos,
      { volume: 0.38, refDistance: 14 },
    );
  }

  /** Snitch relay calls this — launches a volley of ballistic heavy rockets. */
  trySnitchArtilleryStrike(targetWorld) {
    if (this.dead) return;
    const now = performance.now() / 1000;
    if (now < this._nextArtilleryAt) return;
    this._nextArtilleryAt = now + HQ_ARTILLERY_INTERVAL_S;
    this._spawnSnitchArtilleryVolley(targetWorld);
  }

  _spawnSnitchArtilleryVolley(targetWorld) {
    const tw = targetWorld.clone();
    /* World-space impact near the spotted target — do NOT raise Y to
     * `this.anchor.y` (rooftop). That mis-clamp put every shell's aim
     * point at tower-top height (same column as relaying snitches) so
     * trajectories looked like they were fired at the drone, not the
     * player. Bias slightly below head toward ground for an artillery
     * “area” strike. */
    tw.y = Math.max(0.45, tw.y - 1.15);
    for (const rec of this.pods) {
      if (rec.pod.userData.broken) continue;
      const o = new THREE.Vector3();
      rec.pod.getWorldPosition(o);
      spawnHqArtilleryRocket(o, tw, this);
    }
  }

  _nextLivePod(salvoIdx) {
    /* Round-robin through pods, skipping broken ones. We don't need
     * to be smart about which pod fires which — the user just wants
     * 3 missiles per salvo. */
    const start = salvoIdx % this.pods.length;
    for (let i = 0; i < this.pods.length; i++) {
      const rec = this.pods[(start + i) % this.pods.length];
      if (!rec.pod.userData.broken) return rec;
    }
    return null;
  }
}

const _aaPos = new THREE.Vector3();
const _aaSlewScratch = new THREE.Vector3();

const _artilleryGroundRayHit = {
  t: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  box: null,
};
const _artGroundRayO = new THREE.Vector3();
const _artGroundRayDirDown = new THREE.Vector3(0, -1, 0);

/** Raycast down from high Y through collision boxes → rooftop / ground XZ. */
function _resolveArtilleryGroundImpact(out, hint) {
  const startY = Math.max(hint.y + 14, 220);
  _artGroundRayO.set(hint.x, startY, hint.z);
  if (rayHitWorldRich(_artGroundRayO, _artGroundRayDirDown, 300, _artilleryGroundRayHit)) {
    out.copy(_artilleryGroundRayHit.point);
    return;
  }
  out.set(hint.x, Math.max(0.35, hint.y - 1.15), hint.z);
}

let hqRocketGeo_ = null;
function getHqRocketGeo() {
  if (!hqRocketGeo_) {
    hqRocketGeo_ = new THREE.CylinderGeometry(0.28, 0.22, 1.45, 14, 1);
  }
  return hqRocketGeo_;
}

let _hqMgTracerGeo = null;
function getHqMgTracerGeo() {
  if (!_hqMgTracerGeo) {
    /* Longer / thicker than the old pin — VR + distance readability. */
    _hqMgTracerGeo = new THREE.CylinderGeometry(0.028, 0.042, 0.52, 6, 1);
    _hqMgTracerGeo.rotateX(Math.PI / 2);
  }
  return _hqMgTracerGeo;
}

/** Visible HMG tracer — only `damagePlayer` when this actually intersects. */
function spawnHqMgRound(muzzleWorld, dirUnit, turret) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffcc, transparent: true, opacity: 1.0,
    depthWrite: false, depthTest: true, toneMapped: false,
    blending: THREE.AdditiveBlending,
  });
  const m = new THREE.Mesh(getHqMgTracerGeo(), mat);
  m.renderOrder = 4;
  m.position.copy(muzzleWorld).addScaledVector(dirUnit, 0.35);
  scene_.add(m);
  projectiles_.push({
    kind: "aamg",
    mesh: m,
    velocity: dirUnit.clone().multiplyScalar(HQ_MG_ROUND_SPEED),
    ttl: HQ_MG_ROUND_TTL,
    owner: turret,
    damage: HQ_MG_ROUND_DAMAGE,
  });
}

/** Snitch-called rocket: loft to an apex above the strike XZ, then drop
 *  straight down the column (area denial on the spotted spot). */
function spawnHqArtilleryRocket(originWorld, impactHintWorld, turret) {
  const groundImpact = new THREE.Vector3();
  _resolveArtilleryGroundImpact(groundImpact, impactHintWorld);
  const ix = groundImpact.x;
  const iz = groundImpact.z;
  const apexY = Math.max(
    originWorld.y + HQ_ARTILLERY_APEX_MIN_OVER_POD,
    groundImpact.y + HQ_ARTILLERY_APEX_ABOVE_GROUND,
    impactHintWorld.y + HQ_ARTILLERY_APEX_OVER_HINT,
    Math.min(_missileCruiseAlt - 1, groundImpact.y + 58),
  );
  const apex = new THREE.Vector3(ix, apexY, iz);
  const m = new THREE.Mesh(getHqRocketGeo(), getMissileMat());
  m.position.copy(originWorld);
  _missileNorm.subVectors(apex, originWorld);
  const d0 = _missileNorm.length();
  let phase = "LOFT";
  let vx; let vy; let vz;
  if (d0 < 1.5 || originWorld.y >= apexY - 0.6) {
    phase = "DROP";
    vx = 0;
    vy = -HQ_ARTILLERY_DROP_SPEED;
    vz = 0;
    _tracerQuat.setFromUnitVectors(_tracerUp, _artGroundRayDirDown);
    m.quaternion.copy(_tracerQuat);
  } else {
    _missileNorm.multiplyScalar(1 / d0);
    _tracerQuat.setFromUnitVectors(_tracerUp, _missileNorm);
    m.quaternion.copy(_tracerQuat);
    vx = _missileNorm.x * HQ_ARTILLERY_LOFT_SPEED;
    vy = _missileNorm.y * HQ_ARTILLERY_LOFT_SPEED;
    vz = _missileNorm.z * HQ_ARTILLERY_LOFT_SPEED;
  }
  m.scale.setScalar(2.6);
  scene_.add(m);
  projectiles_.push({
    kind: "aaartillery",
    mesh: m,
    velocity: new THREE.Vector3(vx, vy, vz),
    gravity: 0,
    ttl: HQ_ARTILLERY_TTL,
    impact: groundImpact.clone(),
    apex,
    phase,
    owner: turret,
    hp: HQ_ARTILLERY_HP,
    damage: HQ_ARTILLERY_DIRECT_DAMAGE,
    directPlayerArtilleryHit: false,
  });
}

/** Spawn an anti-air missile that climbs to cruise altitude before
 *  homing. `originWorld` is the pod tip; `targetWorld` is the player
 *  head at launch (used for initial seeking direction). The missile
 *  lives in the same projectiles_ array as drone projectiles so it
 *  shares the explosion / decal / drone-friendly-fire pipeline.
 *
 *  Two-stage trajectory:
 *    Stage 1 (CLIMB): velocity is forced toward (vx, +AAMISSILE_SPEED, vz)
 *      where (vx,vz) is the *radial-out* 2D direction (away from
 *      the tower a little, then up). Stops once the missile passes
 *      _missileCruiseAlt.
 *    Stage 2 (HOMING): full turn rate, accelerates toward player. */
function spawnAntiAirMissile(originWorld, targetWorld, turret) {
  const m = new THREE.Mesh(getMissileGeo(), getMissileMat());
  m.position.copy(originWorld);
  /* Initial orientation: straight up. */
  _tracerQuat.setFromUnitVectors(_tracerUp, _worldUp);
  m.quaternion.copy(_tracerQuat);
  m.scale.setScalar(1.4); // slightly bigger than drone missile
  scene_.add(m);
  /* Velocity bias: a small radial-out push so the missile clears the
   * tower silhouette before climbing fully. Vector from tower base to
   * launch point projected to XZ. */
  const radial = new THREE.Vector3(originWorld.x - turret.anchor.x, 0, originWorld.z - turret.anchor.z);
  if (radial.lengthSq() < 0.01) {
    radial.set(0, 0, 1).applyAxisAngle(_worldUp, turret.anchor.yaw || 0);
  } else {
    radial.normalize();
  }
  const v = new THREE.Vector3(radial.x * 1.0, AAMISSILE_SPEED, radial.z * 1.0).normalize().multiplyScalar(AAMISSILE_SPEED);
  projectiles_.push({
    kind: "aamissile",
    mesh: m,
    velocity: v,
    damage: AAMISSILE_DAMAGE,
    speed: AAMISSILE_SPEED,
    turnRate: AAMISSILE_TURN_RATE_CLIMB,
    ttl: AAMISSILE_TTL,
    hp: AAMISSILE_HP,
    phase: "CLIMB",
    cruiseAlt: _missileCruiseAlt,
    owner: turret,                    // back-ref so we ignore friendly fire on owner debris
    initialTarget: targetWorld.clone(),
  });
}

/* Detonate an anti-air missile (or explosive arrow) at world `pos`.
 * Applies: AOE damage to drones (with linear falloff), anti-air
 * components (also linear falloff), and the player (if within radius).
 * `damageProfile`: { drone, antiair, player } — peak damage to each
 * target type. `pushImpulse`: peak m/s knock-back applied radially. */
/** Optional 5th arg for HQ artillery: player must be within blast
 * `radius` of `pos` *and* within `artilleryGateRadius` (XZ) of
 * `artilleryGateCenter` — keeps strikes in the intended column without
 * the old “ground ring only” behaviour that damaged players while the
 * shell was still high overhead (felt like invisible MG). */
function _detonateAOE(pos, radius, damageProfile, pushImpulse, opts) {
  opts = opts || {};
  if (!opts.skipBuiltInExplosionFx) {
    playExplosionImpactAt(pos, { volume: 1.0, refDistance: 8 });
    _spawnExplosionFx(pos);
  }
  /* Drones. */
  if (damageProfile.drone > 0) {
    for (const d of drones_) {
      if (d.dead) continue;
      const dist = d.group.position.distanceTo(pos);
      if (dist > radius) continue;
      const k = 1 - dist / radius;
      const dmg = damageProfile.drone * k;
      /* Push impulse radially. */
      const dir = new THREE.Vector3()
        .subVectors(d.group.position, pos)
        .normalize();
      d.velocity.addScaledVector(dir, k * pushImpulse);
      /* Same shield-dome respect as grenades. */
      if (_underAnyShieldDome(d) && d.type !== DRONE_TYPE_SHIELD) {
        _pulseShieldDome(d.group.position);
        continue;
      }
      /* Walk every unbroken component and apply blast damage directly,
       * bypassing the chip / shield armour-redirect chain in
       * `takeDamage` — a 4 m radius explosion isn't stopped by a
       * single 14 HP chip panel. This guarantees a direct explosive
       * arrow at point-blank actually destroys the drone (the body
       * crit-multiplier is 1.5, so a centre hit deals 70 * 1.5 = 105
       * to the body — enough for any drone variant). */
      const components = d.group.userData.components;
      if (components) {
        for (const c of components) {
          if (c.userData.broken) continue;
          d.applyAOEDamage(c, dmg);
          /* If the body / power core just broke, the drone is dead —
           * no point continuing to dispense damage to debris. */
          if (d.dead) break;
        }
      }
      /* One per-drone metal-thunk (else N components → N overlapping SFX). */
      if (!d.dead) {
        playMetalHitAt(d.group.position, { volume: 0.85, refDistance: 4 });
        /* Wobble + EVADE state disruption (kamikaze stays committed). */
        d.aimFocus = 0;
        d.wobbleTimer = DRONE_WOBBLE_DURATION;
        if (d.type !== DRONE_TYPE_KAMIKAZE) {
          d.state = "EVADE";
          d.stateTime = 0;
        }
        d.lkp.copy(pos);
        d.haveLkp = true;
      }
    }
  }
  /* Anti-air components. Anti-air missiles never damage their own
   * launcher (`damageProfile.antiair` = 0 in that case); explosive
   * arrows pass a positive value. */
  if (damageProfile.antiair > 0) {
    for (const aa of antiair_) {
      if (aa.dead) continue;
      /* Coarse cull — the HQ at HQ_SCALE = 3 spreads its components
       * up to ~7 m from the pivot (side pods, radar dish), so a
       * blast more than (radius + 7) m from the pivot can't reach
       * any of them. Cheap early-out to skip distant emplacements. */
      aa.pivot.getWorldPosition(_aaTmp);
      const cull = radius + 7;
      if (_aaTmp.distanceToSquared(pos) > cull * cull) continue;
      /* Per-component falloff — the previous version used distance
       * from the BLAST to the PIVOT, then applied that single k to
       * every component. That meant an explosive at e.g. a side pod
       * (~6 m from pivot) was OUTSIDE the strict pivot radius and
       * the entire AA was skipped — pods took zero damage even on
       * a perfect direct hit. The fix is to compute distance from
       * the blast to each COMPONENT's world position and use that
       * for falloff, matching what the player visually sees the
       * explosion engulf.
       *
       * Core-shield rule (skip the core while any plate is intact)
       * still applies for the AOE wash; arrow rays that physically
       * connect with the core get the direct-hit bonus dispatched
       * by the explosive-arrow handler before this AOE call. */
      const coreShielded = aa._isCoreShielded();
      for (const c of aa.components) {
        if (c.userData.broken) continue;
        if (c.userData.kind === "power" && coreShielded) continue;
        c.getWorldPosition(_aaPos);
        const cDist = _aaPos.distanceTo(pos);
        if (cDist > radius) continue;
        const k = 1 - cDist / radius;
        const dmg = damageProfile.antiair * k;
        const hitDir = _aaTmp.copy(_aaPos).sub(pos);
        if (hitDir.lengthSq() > 1e-6) hitDir.normalize();
        aa.takeDamage(c, dmg * HQ_AOE_FANOUT, hitDir, pos);
      }
    }
  }
  /* Player. */
  if (damageProfile.player > 0) {
    getPlayerHeadWorld(_aaTmp);
    const distBlast = _aaTmp.distanceTo(pos);
    if (distBlast > radius) {
      /* Outside the visible blast — no damage. */
    } else if (opts.artilleryGateCenter) {
      const gateR = opts.artilleryGateRadius ?? HQ_ARTILLERY_PLAYER_NEAR_M;
      const gc = opts.artilleryGateCenter;
      const distGXZ = Math.hypot(_aaTmp.x - gc.x, _aaTmp.z - gc.z);
      if (distGXZ <= gateR) {
        const kBlast = 1 - distBlast / radius;
        const kGate = 1 - distGXZ / gateR;
        damagePlayer(damageProfile.player * kBlast * Math.max(0.12, kGate));
      }
    } else {
      const k = 1 - distBlast / radius;
      damagePlayer(damageProfile.player * k);
    }
  }
}

/* ── Snitch drone variant ──────────────────────────────────────────────
 *
 * Small reconnaissance drone that flies at SNITCH_DEFAULT_ALT (~2 m)
 * and acts as a forward observer for anti-air emplacements. Behaviour:
 *
 *   PATROL  — drifts around at low altitude (default state).
 *   SPOTTED — has LOS to the player. Climbs to SNITCH_RELAY_ALT
 *             (above buildings) so it can simultaneously see the
 *             player AND the nearest active anti-air launcher.
 *   RELAY   — at altitude AND has LOS to both player and an AA.
 *             Pulses the AA's lastSpottedT each frame so the AA can
 *             aim/fire even without its own LOS.
 *
 * Uses the existing Drone class infrastructure but with a custom
 * update() override (we set `_snitch = true` on the Drone and the
 * standard Drone.update() defers to a snitch-specific tick).
 *
 * Spawning is independent of waves — when combat is enabled, we
 * maintain SNITCH_TARGET_COUNT snitches around the player at all
 * times (respawn after death). They contribute to kill counts but
 * not the wave-finish quota (we don't want them gating wave
 * progression — they're an ambient threat, not a numbered enemy). */
const DRONE_TYPE_SNITCH = "snitch";
const SNITCH_DEFAULT_ALT = 2.0;
const SNITCH_RELAY_ALT_MIN = 25;
const SNITCH_TARGET_COUNT = 2;
const SNITCH_PATROL_RADIUS = 60;
const SNITCH_VIEW_RANGE = 30;
const SNITCH_VIEW_HALF_ANGLE_DEG = 32;     // wider than AA — snitches scan, not aim
/* SPOTTED: cone must reach the ground strike point from relay altitude
 * (often >30 m); cap avoids absurd draw distance. */
const SNITCH_ART_CONE_LEN_MAX = 130;
const SNITCH_STRIKE_RING_INNER = 1.35;
const SNITCH_STRIKE_RING_OUTER = 4.6;
const SNITCH_RELAY_RANGE = 110;            // beam-relay max distance to AA
const SNITCH_RESPAWN_DELAY = 12.0;
let snitchRespawnTimer_ = 0;
const _snitchBombGroundW = new THREE.Vector3();
const _snitchArtHintW = new THREE.Vector3();
const _snitchBombDirParent = new THREE.Vector3();
const _snitchConeFromLocalZ = new THREE.Vector3(0, 0, 1);

/** When an HQ takes player fire, send the nearest snitch to the shot origin. */
function dispatchNearestSnitchInvestigate(hq, worldPos) {
  if (!hq || hq.dead || !worldPos) return;
  if (!Number.isFinite(worldPos.x + worldPos.y + worldPos.z)) return;
  hq.group.updateMatrixWorld(true);
  const hx = hq.group.position.x;
  const hz = hq.group.position.z;
  let best = null;
  let bestD = Infinity;
  for (const d of drones_) {
    if (d.dead || d.type !== DRONE_TYPE_SNITCH) continue;
    const dx = d.group.position.x - hx;
    const dz = d.group.position.z - hz;
    const distSq = dx * dx + dz * dz;
    if (distSq < bestD) {
      bestD = distSq;
      best = d;
    }
  }
  if (best) best.requestHqInvestigate(worldPos);
}

/* Add snitch stats to the existing DRONE_TYPE_STATS map. */
DRONE_TYPE_STATS[DRONE_TYPE_SNITCH] = {
  bodyHp: 8,                         // glass cannon — one solid arrow kills it
  tintHex: 0x33aa66,                 // sickly green so the player learns the silhouette
  fireInterval: 0,                   // doesn't fire
  fireRangeMul: 0,
  aimTimeMul: 0.7,
  speedMul: 1.4,                     // FAST — makes hunting them satisfying
  turretSlewRate: 8,
  /* No special weapon — snitches use perception + relay only. */
  detonateRange: 0,
  detonateDamage: 0,
};

/** Build a tiny snitch drone — a 0.25 m chassis, two side rotors, a
 *  prominent green eye on top, plus a translucent vision cone and a
 *  relay-beam stub. Cone length is local +Z (apex at the eye). In
 *  PATROL the cone inherits body yaw so it matches flight direction;
 *  in SPOTTED climb the cone is aimed in local space at the resolved
 *  artillery ground impact (same hint as HQ volleys). The relay beam
 *  is a thin Line that's hidden until the snitch is actively relaying
 *  to an AA. Uses the standard "rotor" component
 *  kind for both rotors so the existing liftFactor logic works (with
 *  totalRotors=2). */
function buildSnitchDroneMesh() {
  const stats = DRONE_TYPE_STATS[DRONE_TYPE_SNITCH];
  const matBody = makeBodyMat(stats.tintHex);
  const matRotor = makeRotorMat();
  const matAccent = makeAccentMat();
  const drone = startDroneGroup(DRONE_TYPE_SNITCH);
  drone.userData.totalRotors = 2;

  /* Compact body. */
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.08, 0.22), matBody);
  body.userData = { kind: "body", hp: stats.bodyHp, maxHp: stats.bodyHp, broken: false, crit: 1.4 };
  drone.add(body);
  drone.userData.components.push(body);

  /* Power core inside (small crit zone). */
  const core = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.06), matAccent);
  core.position.y = 0.05;
  core.userData = { kind: "power", hp: 6, maxHp: 6, broken: false, crit: 2.0 };
  drone.add(core);
  drone.userData.components.push(core);

  /* "Eye" — the spotter cam. Bright emissive green so the player can
   * see it from across the sector. */
  const matEye = new THREE.MeshStandardMaterial({
    color: 0x88ffaa, emissive: 0x55ff77, emissiveIntensity: 2.4,
    roughness: 0.4, metalness: 0.2, toneMapped: true,
  });
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), matEye);
  eye.position.set(0, 0.07, 0.07);
  eye.userData = { kind: "targeting", hp: 6, maxHp: 6, broken: false, crit: 1.5 };
  drone.add(eye);
  drone.userData.components.push(eye);

  /* Two small rotors on the sides. */
  const rotorOffsets = [
    [ 0.18, 0.02,  0.00],
    [-0.18, 0.02,  0.00],
  ];
  const rotorNames = ["RR", "RL"];
  for (let i = 0; i < 2; i++) {
    buildShieldedRotor(drone, rotorOffsets[i], rotorNames[i], matBody, matRotor);
  }

  /* Single chip in the middle of the body — small armour layer so a
   * misaligned shot doesn't insta-kill the snitch's body. */
  buildBodyChips(drone, body, new THREE.Vector3(0.10, 0.04, 0.10), matBody);

  buildStatusLed(drone, 0x55ff77);

  /* Vision cone — apex at eye, length along local +Z (same translate +
   * rotateX bake as drone vision geo). In SPOTTED climb the cone aims
   * at the resolved artillery ground impact so the player reads where
   * rockets will land. */
  const coneGeo = new THREE.ConeGeometry(
    SNITCH_VIEW_RANGE * Math.tan((SNITCH_VIEW_HALF_ANGLE_DEG) * Math.PI / 180),
    SNITCH_VIEW_RANGE, 18, 1, true,
  );
  coneGeo.translate(0, -SNITCH_VIEW_RANGE / 2, 0);
  coneGeo.rotateX(-Math.PI / 2);
  const coneMat = new THREE.MeshBasicMaterial({
    color: 0x55ff77, transparent: true, opacity: 0.10,
    depthWrite: false, side: THREE.DoubleSide, fog: true,
  });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.position.set(0, 0.07, 0.07);
  cone.quaternion.identity();
  cone.castShadow = false;
  cone.userData.snitchCone = true;
  /* Cone is an indicator — must not block arrow rays. Same trick
   * as the AA cone above. */
  cone.raycast = function () {};
  drone.add(cone);
  drone.userData.snitchCone = cone;

  /* Flat ring on the ground at the resolved artillery impact — reads
   * clearly from altitude when the translucent cone is easy to lose
   * against concrete. Parented to scene_, updated in `_tickSnitch`. */
  const strikeRingGeo = new THREE.RingGeometry(
    SNITCH_STRIKE_RING_INNER, SNITCH_STRIKE_RING_OUTER, 48, 1,
  );
  const strikeRingMat = new THREE.MeshBasicMaterial({
    color: 0xff3322, transparent: true, opacity: 0.62,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    blending: THREE.AdditiveBlending, fog: false,
  });
  const strikeRing = new THREE.Mesh(strikeRingGeo, strikeRingMat);
  strikeRing.visible = false;
  strikeRing.renderOrder = 8;
  strikeRing.raycast = function () {};
  scene_.add(strikeRing);
  drone.userData.snitchStrikeRing = strikeRing;

  /* Relay beam — a Line from the eye to a target world point. Hidden
   * by default; `_tickSnitch` sets `visible = true` and updates the
   * far-vertex when actively relaying. We set linewidth purely for
   * documentation; in-browser it usually renders at 1 px regardless,
   * which is exactly right for a discreet but legible beam. */
  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([0, 0.07, 0, 0, 0.07, 1]), 3),
  );
  const beamMat = new THREE.LineBasicMaterial({
    color: 0xff4444, transparent: true, opacity: 0.85,
    depthWrite: false, fog: true,
  });
  const beam = new THREE.Line(beamGeo, beamMat);
  beam.frustumCulled = false;       // endpoint may be outside the drone's bounds
  beam.visible = false;
  beam.userData.snitchBeam = true;
  /* Indicator — never a hit target for arrows / projectiles. */
  beam.raycast = function () {};
  drone.add(beam);
  drone.userData.snitchBeam = beam;

  return drone;
}

/* ── Anti-air missile + arrow-vs-missile helpers ──────────────────────── */

/* Damage an in-flight anti-air missile by `dmg`. Returns true if the
 * missile has been destroyed and removed from the projectile list. */
function _damageAntiAirMissile(p, dmg) {
  p.hp -= dmg;
  if (p.hp <= 0) {
    /* Detonate where it was hit — this is friendly fire on drones
     * specifically REQUESTED by the user ("missiles should also be
     * able to hit and destroy the other drones if they accidentally
     * get in its trajectory"). The detonation also damages the
     * player if they're close enough. */
    _detonateAOE(p.mesh.position, AAMISSILE_BLAST_RADIUS, {
      drone: AAMISSILE_BLAST_DAMAGE,
      antiair: 0,
      player: AAMISSILE_DAMAGE,
    }, 6);
    scene_.remove(p.mesh);
    return true;
  }
  return false;
}

function _damageHqFlyer(p, dmg) {
  if (p.kind === "aaartillery") {
    p.hp -= dmg;
    if (p.hp <= 0) {
      _detonateAOE(p.mesh.position, HQ_ARTILLERY_BLAST_RADIUS * 0.55, {
        drone: HQ_ARTILLERY_BLAST_DAMAGE * 0.45,
        antiair: 0,
        player: HQ_ARTILLERY_DIRECT_DAMAGE * 0.32,
      }, 4, {
        artilleryGateCenter: p.impact,
        artilleryGateRadius: HQ_ARTILLERY_PLAYER_NEAR_M,
      });
      scene_.remove(p.mesh);
      return true;
    }
    return false;
  }
  if (p.kind === "aamg") {
    scene_.remove(p.mesh);
    return true;
  }
  return _damageAntiAirMissile(p, dmg);
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
/* Reusable rich-hit record so fireHitscan doesn't allocate per shot. */
const _wallHit = {
  t: Infinity,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  box: null,
};
function fireHitscan() {
  if (playerFireCooldown_ > 0 || playerDead()) return;
  if (!getRightControllerAim(_aimDir, _muzzle)) return;
  playerFireCooldown_ = PLAYER_FIRE_INTERVAL;

  /* World-OBB earliest hit (we never want to shoot through walls).
   * Rich variant returns the surface point + outward normal so we can
   * place an impact decal and spawn chip debris if no drone is closer. */
  const hasWallHit = rayHitWorldRich(_muzzle, _aimDir, TRACER_LENGTH, _wallHit);
  const wallT = hasWallHit ? _wallHit.t : Infinity;

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
  } else if (hasWallHit) {
    /* Bullet hit the world before any drone — spawn a concrete chip
     * burst and place / upgrade a cracked-impact decal at the hit
     * point. The decal's outward face is `_wallHit.normal`, which
     * rayHitOBBRich derived from whichever slab face the ray entered. */
    spawnSurfaceImpact(_wallHit.point, _wallHit.normal);
  }
  spawnTracer(_muzzle, _aimDir, endT);
  /* Player shot SFX — head-locked (loud and sharp, no spatial cue needed
   * since you fired it). Spatialised hit/explosion from the drone itself.
   * Prefers the MP3-backed rifle sample; falls back to the procedural
   * zap until the sample finishes loading (≤ 50 ms typically). */
  playHeadOneShot(audioBuffers_.rifleFire || audioBuffers_.playerShot, 0.6);
  /* Light haptic kick on the right controller — 75% intensity for 60 ms
   * is sharp enough to "feel" each round without overwhelming the hand
   * during sustained fire. Silently no-ops on hardware without
   * actuators (desktop, controllers without rumble). */
  pulseRightController(0.75, 60);
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
    if (d.isSpark) {
      d.mesh.position.addScaledVector(d.velocity, dt);
      d.velocity.multiplyScalar(0.88);
      if (d.mesh.material) {
        d.mesh.material.opacity = Math.max(0, d.ttl / 0.22) * 0.95;
      }
      if (d.ttl <= 0) {
        scene_.remove(d.mesh);
        d.mesh.material?.dispose?.();
        debris_.splice(i, 1);
      }
      continue;
    }
    if (d.isExpArrowBlast) {
      const t = 1 - Math.max(0, d.ttl) / 0.68;
      const scale = 0.5 + t * 10.5;
      d.mesh.scale.setScalar(scale);
      if (d.mesh.material) d.mesh.material.opacity = 0.92 * (1 - t);
      if (d.ttl <= 0) {
        scene_.remove(d.mesh);
        d.mesh.material?.dispose?.();
        debris_.splice(i, 1);
      }
      continue;
    }
    if (d.isExpArrowCore) {
      const t = 1 - Math.max(0, d.ttl) / 0.28;
      const scale = 0.55 * (1 + t * 5.5);
      d.mesh.scale.setScalar(scale);
      if (d.mesh.material) d.mesh.material.opacity = 0.78 * (1 - t);
      if (d.ttl <= 0) {
        scene_.remove(d.mesh);
        d.mesh.material?.dispose?.();
        debris_.splice(i, 1);
      }
      continue;
    }
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
       * if any of them respawned via the engineer). Shared chip
       * resources (chips have d.sharedRes === true) skip the dispose
       * because the geometry/material is reused across all impacts. */
      if (d.isExpRubble) {
        d.mesh.material?.dispose?.();
      } else {
        if (d.mesh.geometry && !d.sharedRes) d.mesh.geometry.dispose?.();
        if (d.mesh.material && !d.sharedRes) d.mesh.material.dispose?.();
      }
      debris_.splice(i, 1);
    }
  }
}

/* ── Surface damage ───────────────────────────────────────────────────
 * Procedural decal texture + chip burst for bullet impacts on world
 * geometry. Called from fireHitscan (player) and updateProjectiles
 * (drones). All visuals reuse shared GL resources so a sustained
 * firefight doesn't cause GC churn. */

/** Build a 64×64 cracked-impact texture for damage tier `tier` (1..N).
 *  Tier 1 is a small, lightly cracked dark spot; each subsequent tier
 *  enlarges the polygon, darkens the centre, and adds more radial
 *  cracks — sells the visual story of "the player is digging out a
 *  hole" as they keep hitting the same spot. */
function buildDecalTexture(tier) {
  const N = 64;
  const c = document.createElement("canvas");
  c.width = N;
  c.height = N;
  const ctx = c.getContext("2d");
  /* Fully transparent background — only the cracked polygon writes
   * pixels, so the surrounding wall material shows through. */
  ctx.clearRect(0, 0, N, N);

  /* Tier-driven parameters. */
  const t = Math.max(1, Math.min(DECAL_MAX_HITS, tier));
  const tNorm = (t - 1) / (DECAL_MAX_HITS - 1); // 0..1
  const baseR  = 0.42 + 0.38 * tNorm;             // polygon radius (canvas units 0..1)
  const jitter = 0.10 + 0.06 * tNorm;             // edge irregularity
  const cracks = 3 + Math.round(tNorm * 5);       // radial crack count
  const innerLuma = Math.round(35 - 12 * tNorm);  // 23..35 (darker = deeper)
  const outerLuma = Math.round(80 - 18 * tNorm);  // 62..80
  const innerColor = `rgb(${innerLuma},${innerLuma - 4},${innerLuma - 8})`;
  const outerColor = `rgb(${outerLuma},${outerLuma - 4},${outerLuma - 8})`;

  /* Deterministic-ish per-tier seed so the same tier always looks the
   * same (avoids decals popping when they upgrade). */
  let seed = 0x12345 + t * 0x9e3779b1;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return ((seed >>> 0) / 0xffffffff);
  };

  ctx.translate(N / 2, N / 2);

  /* Outer cracked polygon, filled with a radial gradient that's darker
   * at the centre. */
  const sides = 10 + Math.round(tNorm * 6);
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const r = (baseR + (rand() - 0.5) * jitter * 2) * (N / 2);
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const grad = ctx.createRadialGradient(0, 0, N * 0.05, 0, 0, baseR * (N / 2));
  grad.addColorStop(0.0, innerColor);
  grad.addColorStop(0.7, outerColor);
  grad.addColorStop(1.0, "rgba(120,116,110,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fill();

  /* Inner darker spot — the "deepest part of the hit". */
  const innerR = (0.16 + 0.10 * tNorm) * (N / 2);
  const innerGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, innerR);
  innerGrad.addColorStop(0, "rgba(15,13,12,0.95)");
  innerGrad.addColorStop(1, "rgba(20,18,16,0)");
  ctx.fillStyle = innerGrad;
  ctx.beginPath();
  ctx.arc(0, 0, innerR, 0, Math.PI * 2);
  ctx.fill();

  /* Radial cracks. Stroke thin black-ish lines from near centre out
   * to past the polygon edge — random angles + lengths give the
   * shattered-concrete look without proper voronoi. */
  ctx.strokeStyle = "rgba(10,9,8,0.8)";
  ctx.lineCap = "round";
  for (let i = 0; i < cracks; i++) {
    const a = rand() * Math.PI * 2;
    const r1 = (0.05 + rand() * 0.05) * N;
    const r2 = ((baseR + 0.05) * (1 + rand() * 0.15)) * (N / 2);
    ctx.lineWidth = 0.6 + rand() * 1.0;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
    /* One bend partway out for a more organic look. */
    const aBend = a + (rand() - 0.5) * 0.6;
    const rBend = r1 + (r2 - r1) * (0.4 + rand() * 0.3);
    ctx.lineTo(Math.cos(aBend) * rBend, Math.sin(aBend) * rBend);
    ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

function getDecalTexture(tier) {
  const t = Math.max(1, Math.min(DECAL_MAX_HITS, tier));
  if (!_decalTextureByTier[t]) _decalTextureByTier[t] = buildDecalTexture(t);
  return _decalTextureByTier[t];
}

/* Scratch vectors for chip-spawn math. */
const _chipPos = new THREE.Vector3();
const _chipVel = new THREE.Vector3();
const _chipTangent1 = new THREE.Vector3();
const _chipTangent2 = new THREE.Vector3();
const _chipUp = new THREE.Vector3(0, 1, 0);

/** Spawn a small burst of concrete chips at `point`, bursting outward
 *  along `normal` (the surface's outward face direction). Each chip
 *  reuses the shared chip geometry + material — only a Mesh wrapper
 *  is allocated, which is dirt cheap. */
function spawnImpactChips(point, normal) {
  /* Build a tangent basis on the impact surface so chips spread in
   * a fan that hugs the wall a bit before falling away from it. */
  if (Math.abs(normal.dot(_chipUp)) > 0.9) {
    /* Surface is roughly horizontal (floor/ceiling) — pick X as the
     * first tangent to avoid a degenerate cross product. */
    _chipTangent1.set(1, 0, 0).cross(normal).normalize();
  } else {
    _chipTangent1.copy(_chipUp).cross(normal).normalize();
  }
  _chipTangent2.copy(normal).cross(_chipTangent1).normalize();

  const geom = getChipGeometry();
  const mat = getChipMaterial();
  for (let i = 0; i < CHIPS_PER_HIT; i++) {
    const mesh = new THREE.Mesh(geom, mat);
    /* Slight random offset along the surface so chips don't all
     * spawn in exactly the same point. */
    const offT1 = (Math.random() - 0.5) * 0.08;
    const offT2 = (Math.random() - 0.5) * 0.08;
    _chipPos.copy(point)
      .addScaledVector(normal, 0.005)
      .addScaledVector(_chipTangent1, offT1)
      .addScaledVector(_chipTangent2, offT2);
    mesh.position.copy(_chipPos);
    /* Random initial orientation — looks more like real shrapnel. */
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    /* Velocity: mostly outward along normal, plus tangential spread,
     * plus a small upward bias so chips arc visibly. */
    const outSpeed = 1.6 + Math.random() * 1.8;
    const tanSpeed = 0.6 + Math.random() * 1.4;
    const tanAngle = Math.random() * Math.PI * 2;
    _chipVel
      .copy(normal).multiplyScalar(outSpeed)
      .addScaledVector(_chipTangent1, Math.cos(tanAngle) * tanSpeed)
      .addScaledVector(_chipTangent2, Math.sin(tanAngle) * tanSpeed);
    _chipVel.y += 1.0 + Math.random() * 0.8;
    scene_.add(mesh);
    debris_.push({
      mesh,
      velocity: new THREE.Vector3(_chipVel.x, _chipVel.y, _chipVel.z),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
      ),
      ttl: CHIP_TTL_MIN + Math.random() * (CHIP_TTL_MAX - CHIP_TTL_MIN),
      sharedRes: true, // skip dispose; geometry+material are shared
    });
  }
}

/** Compute the sector key of a world XZ position, using the streaming
 *  module's sectorSize. Returns null if no sector info is available
 *  (initBots options didn't include getSectorInfo). */
function _sectorKeyForWorldXZ(x, z) {
  if (!getSectorInfo_) return null;
  const info = getSectorInfo_();
  if (!info?.sectorSize) return null;
  const sx = Math.round(x / info.sectorSize);
  const sz = Math.round(z / info.sectorSize);
  return `${sx},${sz}`;
}

/* Scratch for decal-merge search and quaternion construction. */
const _decalQuat = new THREE.Quaternion();
const _decalUp = new THREE.Vector3(0, 0, 1);

/** Place or upgrade an impact decal at the surface point, plus spawn
 *  the associated chip burst. `normal` is the outward-facing surface
 *  normal in world space. */
function spawnSurfaceImpact(point, normal) {
  /* Always spawn the chip burst — even if a decal is merged, the
   * extra chips reinforce the "I just hit this spot" feedback. */
  spawnImpactChips(point, normal);

  /* Try to merge into an existing decal nearby (same surface area).
   * O(N) over the bounded decal pool — at MAX_DECALS = 200 this is
   * trivial even at full firing rate. */
  for (let i = decals_.length - 1; i >= 0; i--) {
    const d = decals_[i];
    const dx = d.mesh.position.x - point.x;
    const dy = d.mesh.position.y - point.y;
    const dz = d.mesh.position.z - point.z;
    if (dx * dx + dy * dy + dz * dz > DECAL_MERGE_RADIUS_SQ) continue;
    /* Same-region hit: upgrade the decal one tier, swap its texture,
     * and grow it slightly so the visual progresses. Cap at
     * DECAL_MAX_HITS — past that, hits still spawn chips but the
     * decal stops growing (avoids unbounded escalation). */
    if (d.tier < DECAL_MAX_HITS) {
      d.tier += 1;
      d.mesh.material.map = getDecalTexture(d.tier);
      d.mesh.material.needsUpdate = true;
      const sizeMul = 1 + 0.18 * (d.tier - 1);
      d.mesh.scale.setScalar(sizeMul);
    }
    /* Touch the LRU position so this decal survives longer than
     * decals the player has stopped attending to. */
    decals_.splice(i, 1);
    decals_.push(d);
    return;
  }

  /* No nearby decal — make a new one. */
  const size = DECAL_BASE_SIZE * 2;
  const geom = new THREE.PlaneGeometry(size, size);
  const mat = new THREE.MeshBasicMaterial({
    map: getDecalTexture(1),
    transparent: true,
    opacity: DECAL_OPACITY,
    depthWrite: false,
    /* Polygon offset pulls the decal toward the camera in depth so
     * it reliably wins over the wall behind it. Stronger negative
     * values (-4, -4) here vs. the prior (-1, -1) — at -1 we still
     * saw strobing z-fighting at certain ranges/angles in VR because
     * a single depth-buffer LSB of bias isn't enough margin against
     * the WebXR projection's reduced precision. The 2 cm
     * DECAL_NORMAL_OFFSET along the normal is the primary defence;
     * this is the depth-test backstop for oblique angles where the
     * normal offset projects to almost nothing along view-Z. */
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    /* Fog stays ENABLED — decals live on world geometry and must fade
     * with the streaming fog the same way the wall behind them does,
     * otherwise far-off decals stay sharply visible against a fogged
     * background and the seamless-streaming illusion breaks. */
    fog: true,
    toneMapped: true,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.copy(point).addScaledVector(normal, DECAL_NORMAL_OFFSET);
  /* Orient the plane so its +Z (default normal) aligns with the
   * surface's outward normal. */
  _decalQuat.setFromUnitVectors(_decalUp, normal);
  mesh.quaternion.copy(_decalQuat);
  /* Random in-plane rotation so repeated decals don't form an obvious
   * grid pattern. The plane's local Z is now the surface normal, so
   * rotating around it spins the texture. */
  mesh.rotateOnAxis(_decalUp, Math.random() * Math.PI * 2);
  mesh.renderOrder = 1; // after walls (0), before tracers (9000)
  /* Frustum culling off: a 36 cm plane has a tiny bounding sphere
   * that can fall outside the camera frustum at close range and
   * steep angles even when part of the plane is still on-screen,
   * making the decal pop out of view. With max 10 decals globally,
   * skipping the culling test costs nothing measurable. */
  mesh.frustumCulled = false;
  scene_.add(mesh);

  const sectorKey = _sectorKeyForWorldXZ(point.x, point.z);
  decals_.push({ mesh, tier: 1, sectorKey });

  /* Bound the pool. Removing the oldest is rare under normal play
   * (200 decals is a *lot* of bullets), but a stress test or a long
   * session in one area must not leak GPU memory. */
  while (decals_.length > MAX_DECALS) {
    const old = decals_.shift();
    scene_.remove(old.mesh);
    old.mesh.geometry.dispose?.();
    old.mesh.material.dispose?.();
  }
}

/** Drop decals whose sector is no longer streamed. Called periodically
 *  (not every frame — the active-set lookup is cheap but we don't need
 *  to re-walk the decal list 90 times a second). */
let _decalCleanupNextMs = 0;
function tickDecalCleanup(nowMs) {
  if (nowMs < _decalCleanupNextMs) return;
  _decalCleanupNextMs = nowMs + 500;
  if (!getSectorInfo_) return;
  const info = getSectorInfo_();
  if (!info?.active) return;
  const active = new Set(info.active);
  for (let i = decals_.length - 1; i >= 0; i--) {
    const d = decals_[i];
    if (d.sectorKey && !active.has(d.sectorKey)) {
      scene_.remove(d.mesh);
      d.mesh.geometry.dispose?.();
      d.mesh.material.dispose?.();
      decals_.splice(i, 1);
    }
  }
}

/* ── Player damage / respawn ──────────────────────────────────────────── */

function playerDead() {
  return playerHp_ <= 0;
}

function damagePlayer(dmg) {
  if (playerInvuln_ > 0 || playerDead() || gameOver_) return;
  /* Difficulty scales incoming damage. */
  const scaled = dmg * (diffProfile_.damageMul ?? 1);
  playerHp_ = Math.max(0, playerHp_ - scaled);
  flashDamageOverlay(0.55);
  playHeadOneShot(audioBuffers_.damage, 0.85);
  /* Strong dual-controller rumble on any HP loss (VR). */
  pulseBothControllersImpact(1.0, 118);
  if (playerHp_ <= 0) onPlayerDeath();
}

/** One life per run. When the player's HP hits 0 we end the run,
 *  snapshot stats, save the score, and surface the summary screen
 *  (3D panel for VR + DOM intro overlay for desktop / post-exit).
 *  No more auto-respawn. */
function onPlayerDeath() {
  if (gameOver_) return;
  gameOver_ = true;
  deaths_++;
  /* Snapshot the run for the summary UI before any reset can clear it. */
  const nowMs = (typeof performance !== "undefined") ? performance.now() : Date.now();
  const durationS = Math.max(0, (nowMs - runStartedAt_) / 1000);
  const score = _computeRunScore({
    kills: kills_, hqKills: hqKills_, wave: waveNumber_, durationS,
  });
  const entry = {
    score,
    kills: kills_,
    hqKills: hqKills_,
    wave: waveNumber_,
    durationS,
    dateISO: new Date().toISOString(),
  };
  const rank = _recordRunScore(entry);
  lastRunSnapshot_ = { ...entry, rank };
  /* Show the in-VR game-over panel (head-locked) AND populate the
   * DOM intro overlay's content with the same stats — when the
   * player exits VR (or if they were already on desktop) the
   * intro panel doubles as the game-over screen. */
  _showGameOverPanel(lastRunSnapshot_);
  _renderIntroAsGameOver(lastRunSnapshot_);
  /* Drop in-flight projectiles so a corpse-camera view doesn't get
   * battered for free; bots will keep firing but their hits are
   * gated by `gameOver_` in `damagePlayer`. */
  for (const p of projectiles_) {
    if (p && p.mesh) scene_.remove(p.mesh);
  }
  projectiles_.length = 0;
  /* Stop the battle music swell — the calm ambience suits a "dead
   * on the ground" pause better than the combat track. */
  if (musicInited_) setMusicTarget("calm");
}

/** Score formula. Tuned so HQs feel like the prestige objective
 *  (each is worth ten drone kills) but a wide-spread normal-arrow
 *  player still posts a competitive total via volume of drone kills
 *  + wave depth. Time alive is a small additive tiebreaker, capped
 *  at 600 s so the formula doesn't reward camping forever. */
function _computeRunScore({ kills = 0, hqKills = 0, wave = 1, durationS = 0 }) {
  return Math.round(
    kills * 100
    + hqKills * 1000
    + Math.max(0, wave - 1) * 500
    + Math.min(600, Math.max(0, durationS)) * 0.5
  );
}

/** Format seconds as e.g. "1m 23s" — keeps the run-summary panel
 *  legible without leaning on Intl.RelativeTimeFormat. */
function _formatDuration(s) {
  s = Math.max(0, Math.floor(s));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s - m * 60}s`;
}

/** Build the head-locked 3D game-over panel on first call, then
 *  re-paint its CanvasTexture with the supplied snapshot every time
 *  it's shown. Mesh is parented to the camera so the player can't
 *  miss it regardless of where they're looking. */
function _showGameOverPanel(snap) {
  if (!gameOverMesh_) {
    gameOverCanvas_ = document.createElement("canvas");
    gameOverCanvas_.width = 1024;
    gameOverCanvas_.height = 640;
    gameOverCtx_ = gameOverCanvas_.getContext("2d");
    gameOverTex_ = new THREE.CanvasTexture(gameOverCanvas_);
    gameOverTex_.colorSpace = THREE.SRGBColorSpace;
    gameOverTex_.anisotropy = 4;
    /* 1.6 m wide × 1 m tall, ~1.6 m in front of the player's eyes.
     * That's big enough to read comfortably without the text needing
     * to be re-rasterised every frame. */
    const geo = new THREE.PlaneGeometry(1.6, 1.0);
    const mat = new THREE.MeshBasicMaterial({
      map: gameOverTex_,
      transparent: true,
      depthTest: false,
      toneMapped: false,
      fog: false,
    });
    gameOverMesh_ = new THREE.Mesh(geo, mat);
    gameOverMesh_.position.set(0, 0, -1.6);
    gameOverMesh_.renderOrder = 9999;
    gameOverMesh_.frustumCulled = false;
    gameOverMesh_.visible = false;
    if (camera_) camera_.add(gameOverMesh_);
  }
  _paintGameOverCanvas(snap);
  gameOverMesh_.visible = true;
}

function _hideGameOverPanel() {
  if (gameOverMesh_) gameOverMesh_.visible = false;
}

function _paintGameOverCanvas(snap) {
  const ctx = gameOverCtx_;
  if (!ctx) return;
  const W = gameOverCanvas_.width;
  const H = gameOverCanvas_.height;
  ctx.clearRect(0, 0, W, H);
  /* Backdrop. */
  ctx.fillStyle = "rgba(8,10,16,0.92)";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#4fc3f7";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, W - 6, H - 6);
  /* Heading. */
  ctx.fillStyle = "#ff6644";
  ctx.font = "700 92px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("GAME OVER", W / 2, 96);
  /* Score. */
  const rankStr = snap?.rank > 0 && snap.rank <= 3
    ? `  ·  NEW #${snap.rank}!`
    : "";
  ctx.fillStyle = "#4fc3f7";
  ctx.font = "700 64px system-ui, sans-serif";
  ctx.fillText(`${snap?.score ?? 0} pts${rankStr}`, W / 2, 188);
  /* Stat grid (2 cols, 4 rows). */
  ctx.fillStyle = "#ffffff";
  ctx.font = "500 36px system-ui, sans-serif";
  ctx.textAlign = "left";
  const colL = 130;
  const colR = 560;
  const baseY = 280;
  const stat = (label, value, x, y) => {
    ctx.fillStyle = "#a4ff66";
    ctx.fillText(label, x, y);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(value, x + 250, y);
  };
  stat("Wave",   String(snap?.wave ?? 1),                    colL, baseY);
  stat("Drones", String(snap?.kills ?? 0),                   colR, baseY);
  stat("HQs",    String(snap?.hqKills ?? 0),                 colL, baseY + 60);
  stat("Time",   _formatDuration(snap?.durationS ?? 0),      colR, baseY + 60);
  /* Top scores. */
  ctx.textAlign = "center";
  ctx.fillStyle = "#4fc3f7";
  ctx.font = "600 32px system-ui, sans-serif";
  ctx.fillText("TOP 3", W / 2, baseY + 150);
  ctx.font = "500 28px system-ui, sans-serif";
  for (let i = 0; i < 3; i++) {
    const e = topScores_[i];
    const y = baseY + 200 + i * 38;
    if (!e) {
      ctx.fillStyle = "#666";
      ctx.fillText(`${i + 1}.  —`, W / 2, y);
    } else {
      const isThis = lastRunSnapshot_ && e === topScores_[lastRunSnapshot_.rank - 1];
      ctx.fillStyle = isThis ? "#ffd24a" : "#cccccc";
      ctx.fillText(
        `${i + 1}.  ${e.score} pts  ·  W${e.wave}  ·  ${e.kills} drones  ·  ${e.hqKills} HQ`,
        W / 2, y,
      );
    }
  }
  /* Footer. */
  ctx.fillStyle = "#82d6fa";
  ctx.font = "600 30px system-ui, sans-serif";
  ctx.fillText("Pull right trigger to PLAY AGAIN", W / 2, H - 40);
  if (gameOverTex_) gameOverTex_.needsUpdate = true;
}

/** Repopulate the DOM intro overlay with the current run's stats
 *  + top-3 list, and unhide it. The user sees this if they exit
 *  VR after dying (or if they were on desktop the whole time). */
function _renderIntroAsGameOver(snap) {
  if (typeof document === "undefined") return;
  const intro = document.getElementById("intro-overlay");
  if (!intro) return;
  const panel = intro.querySelector(".panel");
  if (!panel) return;
  /* Re-show the overlay even if main.js hid it on sessionstart. */
  intro.style.display = "flex";
  /* Replace the panel content with the run summary. The "ENTER VR"
   * button lives at #vr-button-host — we keep it intact and move it
   * to the bottom of the new layout so re-entering VR triggers a
   * fresh run via the gameover-watcher in pollVRInputs. */
  const vrHost = document.getElementById("vr-button-host");
  panel.innerHTML = `
    <h1 style="color:#ff6644">GAME OVER</h1>
    <p style="font-size:1.4em;color:#4fc3f7;margin:0 0 0.4em">
      ${snap?.score ?? 0} points${
        snap?.rank > 0 && snap.rank <= 3 ? ` &mdash; NEW #${snap.rank}!` : ""
      }
    </p>
    <p>Wave <b>${snap?.wave ?? 1}</b> &middot; ${snap?.kills ?? 0} drones &middot; ${snap?.hqKills ?? 0} HQs &middot; ${_formatDuration(snap?.durationS ?? 0)}</p>
    <div id="top-scores" style="margin:1em auto;text-align:left;max-width:22em;line-height:1.6"></div>
    <div id="vr-button-host"></div>
    <div class="status-line">Pull right trigger or press ENTER VR to play again.</div>
  `;
  /* Re-insert the original VR button host node so the existing
   * three.js VRButton click handler keeps working. */
  if (vrHost) {
    const newHost = panel.querySelector("#vr-button-host");
    if (newHost && newHost !== vrHost) newHost.replaceWith(vrHost);
  }
  _renderIntroTopScores();
}

/** Populate (or refresh) the top-3 list inside whichever DOM panel
 *  currently has a `#top-scores` host (the intro at app start, or
 *  the game-over rebuild). Highlights the just-finished run so the
 *  player can see exactly where they placed. */
function _renderIntroTopScores() {
  if (typeof document === "undefined") return;
  const host = document.getElementById("top-scores");
  if (!host) {
    /* No top-scores host yet; the intro DOM still has the original
     * "Survive drone swarms…" copy. Inject a small list above the
     * VR button so first-time users see existing records. */
    _ensureIntroTopScoresHost();
    return;
  }
  if (topScores_.length === 0) {
    host.innerHTML = "<div style='color:#888;text-align:center'>No runs yet. Be the first.</div>";
    return;
  }
  const lines = ["<div style='color:#4fc3f7;font-weight:600;text-align:center;margin-bottom:0.4em'>TOP 3</div>"];
  for (let i = 0; i < 3; i++) {
    const e = topScores_[i];
    if (!e) {
      lines.push(`<div style="color:#555">${i + 1}. &mdash;</div>`);
    } else {
      const isThis = lastRunSnapshot_
        && lastRunSnapshot_.rank === i + 1
        && lastRunSnapshot_.dateISO === e.dateISO;
      const colour = isThis ? "#ffd24a" : "#cccccc";
      lines.push(
        `<div style="color:${colour}">${i + 1}. <b>${e.score}</b> pts &middot; W${e.wave} &middot; ${e.kills}k &middot; ${e.hqKills}HQ</div>`,
      );
    }
  }
  host.innerHTML = lines.join("");
}

/** Inject a small top-scores readout into the original intro panel
 *  on first load, so first-time visitors see their existing records
 *  without needing to die first. Idempotent. */
function _ensureIntroTopScoresHost() {
  if (typeof document === "undefined") return;
  const intro = document.getElementById("intro-overlay");
  if (!intro) return;
  const panel = intro.querySelector(".panel");
  if (!panel) return;
  let host = panel.querySelector("#top-scores");
  if (host) {
    /* Already present (game-over rebuild or earlier call). Just refresh. */
    _renderIntroTopScores();
    return;
  }
  host = document.createElement("div");
  host.id = "top-scores";
  Object.assign(host.style, {
    margin: "1em auto",
    textAlign: "left",
    maxWidth: "22em",
    lineHeight: "1.6",
    fontSize: "0.92em",
  });
  /* Insert right before the VR button host so it sits between the
   * tagline and the CTA. */
  const vrHost = panel.querySelector("#vr-button-host");
  if (vrHost) panel.insertBefore(host, vrHost);
  else panel.appendChild(host);
  _renderIntroTopScores();
}

/** Wipe and re-seed every piece of run-scoped state: dynamic actors,
 *  in-flight ordnance, HUD damage indicators, persistent AA cache,
 *  per-life counters, and the player's position. After this returns,
 *  the world looks like a fresh launch (modulo top-score history). */
function _resetGame() {
  /* Tear down everything via the existing combat-off path: drones,
   * projectiles, debris, decals, grenades, tracers, music switch
   * to calm, etc. We toggle off → on rather than reproducing the
   * teardown inline so any new state the codebase adds in future is
   * automatically swept by the same code path. */
  if (enabled_) setBotsEnabled(false);
  /* Clear cross-life caches that survive the combat toggle. */
  _clearAntiAirCache();
  _resetHealthSpheres();
  _hideGameOverPanel();
  /* Reset per-life counters that combat-on doesn't already zero. */
  hqKills_ = 0;
  runStartedAt_ = (typeof performance !== "undefined") ? performance.now() : Date.now();
  lastRunSnapshot_ = null;
  gameOver_ = false;
  /* Snap the player back to spawn so the new run starts in a known
   * pose (otherwise they'd revive in whatever corner they died). */
  if (respawnPlayer_) {
    respawnPlayer_();
  } else if (cameraRig_ && getPlayerSpawn_) {
    const sp = getPlayerSpawn_();
    if (sp) cameraRig_.position.copy(sp);
  }
  /* Re-arm: combat on starts wave 1 fresh and resets player HP. */
  setBotsEnabled(true);
  /* Hide the DOM intro overlay if it was re-shown by the game-over
   * flow. Inside an active VR session this is a no-op (display
   * was already none); on desktop it gets us back into the play
   * area. */
  if (typeof document !== "undefined") {
    const intro = document.getElementById("intro-overlay");
    if (intro) intro.style.display = "none";
  }
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
  const headingDeg = Math.round(getPlayerHeadingDeg());

  /* Redraw gating. We redraw when:
   *   - sector changed (active set / current cell shifted)
   *   - drone count changed (new spawns / kills)
   *   - heading changed by ≥ 3° (keeps the triangle / rotated map smooth
   *     without paying every frame for sub-degree wobble)
   *   - 200 ms tick (so live drone positions don't lag noticeably)
   * Unwrap the heading delta through 0/360 so 359° → 1° counts as 2°. */
  const now = performance.now();
  let headingDelta = headingDeg - sectorMinimapLastHeadingDeg_;
  while (headingDelta > 180) headingDelta -= 360;
  while (headingDelta < -180) headingDelta += 360;
  const sectorChanged = info.current !== sectorMinimapLastKey_;
  const droneChanged = livingDrones !== sectorMinimapLastDroneCount_;
  const tickDue = now - sectorMinimapLastDirtyMs_ >= 200;
  const headingChanged = sectorMinimapLastHeadingDeg_ === -999
                       || Math.abs(headingDelta) >= 3;
  if (!sectorChanged && !droneChanged && !tickDue && !headingChanged) return;

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
  /* Float cellSize — the player is always anchored at the canvas centre
   * regardless of where they are within their current sector, so we
   * don't need pixel-aligned cell rects. */
  const cellSize = inner / gridSize;
  const cx = W / 2;
  const cy = H / 2;
  const mapRadius = (cellSize * gridSize) / 2;

  const [csx, csz] = info.current.split(",").map(Number);
  const activeSet = new Set(info.active);

  /* Player world position (defaults to current sector centre if no
   * provider — only happens in tests). */
  const p = getPlayerPosition_
    ? getPlayerPosition_()
    : { x: csx * info.sectorSize, z: csz * info.sectorSize };

  const headingRad = (headingDeg * Math.PI) / 180;
  /* World metres → canvas pixels. */
  const w2c = cellSize / info.sectorSize;

  /* In heading-up mode we rotate the entire grid+drones around the
   * canvas centre so the player's forward direction points UP. The
   * player triangle and cardinal labels are drawn in screen coords
   * after restore() so their text stays readable regardless of
   * orientation. */
  const isHeadingUp = compassMode_ === "heading";

  ctx.save();
  ctx.translate(cx, cy);
  if (isHeadingUp) ctx.rotate(-headingRad);

  /* Cells. Each meta's centre is placed by its world-relative offset
   * from the player. cellSize is sub-pixel, so cells slide smoothly as
   * the player walks within a sector — there's no snap at sector
   * boundaries. */
  for (const m of info.all) {
    const dxPx = (m.sx * info.sectorSize - p.x) * w2c;
    const dzPx = (m.sz * info.sectorSize - p.z) * w2c;
    /* Cull cells whose centre is well outside the visible window. */
    if (Math.abs(dxPx) > mapRadius + cellSize
        || Math.abs(dzPx) > mapRadius + cellSize) continue;
    let fill;
    if (m.sx === csx && m.sz === csz) {
      fill = "#ffd24a"; // current — bright yellow
    } else if (activeSet.has(m.key)) {
      fill = "#3a7fc7"; // loaded neighbour — mid blue
    } else {
      fill = "#2c2c2c"; // unloaded — dim grey
    }
    ctx.fillStyle = fill;
    ctx.fillRect(
      dxPx - cellSize / 2 + 1,
      dzPx - cellSize / 2 + 1,
      cellSize - 2,
      cellSize - 2,
    );
  }

  /* Drone dots — same world-relative placement, same rotation. */
  ctx.fillStyle = "#ff5577";
  for (const d of drones_) {
    if (d.dead) continue;
    const dxPx = (d.group.position.x - p.x) * w2c;
    const dzPx = (d.group.position.z - p.z) * w2c;
    if (Math.abs(dxPx) > mapRadius || Math.abs(dzPx) > mapRadius) continue;
    ctx.beginPath();
    ctx.arc(dxPx, dzPx, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();

  /* Player heading triangle, drawn in screen-space at canvas centre.
   *   - North-up: triangle rotates with heading (player can see at a
   *     glance which way they're facing on a stable map).
   *   - Heading-up: triangle always points up (the world rotates).
   * The triangle is a chevron (notched base) so the orientation is
   * still legible at the small scale of the minimap. */
  const triAngle = isHeadingUp ? 0 : headingRad;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(triAngle);
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -5.5);
  ctx.lineTo(3.8, 3.8);
  ctx.lineTo(0, 1.6);
  ctx.lineTo(-3.8, 3.8);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  /* Cardinal labels. North-up pins N/E/S/W to the four edges; heading-up
   * orbits a single "N" letter to wherever north actually is so the
   * player still has an absolute reference. */
  ctx.fillStyle = "#9fd6ff";
  ctx.font = "700 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (isHeadingUp) {
    /* In screen coords with canvas Y down: north (heading=0) is at the
     * top → offset (0, −labelR). For arbitrary heading, north's screen
     * offset is (−labelR·sin(h), −labelR·cos(h)). */
    const labelR = mapRadius - 6;
    const lx = cx - labelR * Math.sin(headingRad);
    const ly = cy - labelR * Math.cos(headingRad);
    /* Subtle backing disk so the letter stays readable over any cell. */
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.arc(lx, ly, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#9fd6ff";
    ctx.fillText("N", lx, ly + 0.5);
  } else {
    ctx.fillText("N", cx, 8);
    ctx.fillText("S", cx, H - 8);
    ctx.fillText("E", W - 8, cy);
    ctx.fillText("W", 8, cy);
  }

  sectorMinimapTexture_.needsUpdate = true;
  sectorMinimapLastKey_ = info.current;
  sectorMinimapLastDroneCount_ = livingDrones;
  sectorMinimapLastDirtyMs_ = now;
  sectorMinimapLastHeadingDeg_ = headingDeg;
}

/* ── Compass ribbon ───────────────────────────────────────────────────
 * Head-locked horizontal heading strip at the top of the player's FOV.
 * Shows a 90° window centred on the current heading with N/E/S/W +
 * intercardinal labels, ticks every 15°, and a yellow centre indicator
 * with the numeric heading. As the player turns their head, the
 * cardinals scroll past the centre — exactly mirroring how a real
 * gyrocompass behaves, and answers "which way am I facing right now?"
 * with no mental rotation. */

function ensureCompassRibbon() {
  if (compassRibbonMesh_) return;
  const c = document.createElement("canvas");
  /* Wide canvas → crisp tick marks at small angular sizes. */
  c.width = 384;
  c.height = 32;
  const ctx = c.getContext("2d");
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const aspect = c.width / c.height;
  const planeH = 0.022;
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
  /* Top-centre of FOV. Far enough off-axis not to occlude the action
   * but inside the comfortable head-locked sweet spot. */
  mesh.position.set(0, 0.16, -0.6);
  mesh.renderOrder = 9999;
  mesh.frustumCulled = false;
  mesh.visible = true;
  camera_.add(mesh);
  compassRibbonCanvas_ = c;
  compassRibbonCtx_ = ctx;
  compassRibbonTexture_ = tex;
  compassRibbonMesh_ = mesh;
}

const COMPASS_LABELS_ = {
  0: "N", 45: "NE", 90: "E", 135: "SE",
  180: "S", 225: "SW", 270: "W", 315: "NW",
};

function drawCompassRibbon() {
  if (!compassRibbonCtx_) return;
  const headingDeg = Math.round(getPlayerHeadingDeg());
  if (headingDeg === compassRibbonLastDeg_) return;
  compassRibbonLastDeg_ = headingDeg;

  const ctx = compassRibbonCtx_;
  const W = compassRibbonCanvas_.width;
  const H = compassRibbonCanvas_.height;
  ctx.clearRect(0, 0, W, H);

  /* Rounded background panel — 55% black for legibility without
   * blocking too much of what's behind the ribbon. */
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  const r = 6;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(W, 0, W, H, r);
  ctx.arcTo(W, H, 0, H, r);
  ctx.arcTo(0, H, 0, 0, r);
  ctx.arcTo(0, 0, W, 0, r);
  ctx.closePath();
  ctx.fill();

  /* 90° visible window centred on the current heading. PIX_PER_DEG
   * controls how "fast" the ribbon scrolls when the player turns —
   * narrower window = bigger sweep per degree (more dramatic), wider
   * window = more context. 90° feels right for a small HUD strip. */
  const VISIBLE_DEG = 90;
  const PIX_PER_DEG = W / VISIBLE_DEG;
  const start = headingDeg - VISIBLE_DEG / 2;

  ctx.strokeStyle = "#9fd6ff";
  ctx.fillStyle = "#9fd6ff";
  ctx.lineWidth = 1;
  ctx.textAlign = "center";

  /* Tick marks every 15°; cardinal/intercardinal ticks get labels and
   * a slightly taller mark. Iteration starts at the next 15° boundary
   * so ticks are aligned to absolute compass degrees, not screen
   * pixels (otherwise tick labels would slide as the player turned). */
  for (let d = Math.ceil(start / 15) * 15; d <= start + VISIBLE_DEG; d += 15) {
    const wrap = ((d % 360) + 360) % 360;
    const x = (d - start) * PIX_PER_DEG;
    const isCardinal = wrap % 45 === 0;
    const tickH = isCardinal ? 9 : 5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, tickH);
    ctx.stroke();
    if (isCardinal && COMPASS_LABELS_[wrap]) {
      ctx.font = "700 13px system-ui, sans-serif";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(COMPASS_LABELS_[wrap], x, H - 4);
    }
  }

  /* Centre indicator — yellow vertical line, one pixel either side, so
   * the player's "current heading" tick is unmistakable. */
  ctx.strokeStyle = "#ffd24a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(W / 2, 0);
  ctx.lineTo(W / 2, H);
  ctx.stroke();

  /* Numeric heading readout above the centre — small but precise. */
  ctx.fillStyle = "#ffd24a";
  ctx.font = "700 11px system-ui, sans-serif";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`${headingDeg}°`, W / 2, 11);

  compassRibbonTexture_.needsUpdate = true;
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

  /* Explosive-arrow recharge ring — sits just outside the main
   * crosshair ring as a partial arc that sweeps clockwise from 12
   * o'clock as the recharge timer ticks down. The fragment shader
   * derives an angular fraction from the local position and discards
   * fragments past `progress`, so we only ever rebuild a *uniform*
   * each frame (no geometry churn). Visible only when the player has
   * the explosive arrow type selected; transitions orange→green when
   * fully recharged. */
  const rechargeRingGeo = new THREE.RingGeometry(0.027, 0.034, 64);
  const rechargeRingMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uProgress: { value: 0 },
      uColor: { value: new THREE.Color(0xffaa22) },
      uAlpha: { value: 0.95 },
    },
    vertexShader: `
      varying vec2 vXY;
      void main() {
        vXY = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uProgress;
      uniform vec3 uColor;
      uniform float uAlpha;
      varying vec2 vXY;
      void main() {
        /* Angle from +Y, sweeping clockwise. atan(x, y) gives 0 at +Y
         * (12 o'clock), positive going to +X (3 o'clock). Map to 0..1. */
        float a = atan(vXY.x, vXY.y);
        float t = a / 6.28318530718;     // -0.5..0.5
        if (t < 0.0) t += 1.0;            // 0..1, clockwise from top
        if (t > uProgress) discard;
        gl_FragColor = vec4(uColor, uAlpha);
      }
    `,
  });
  const rechargeRing = new THREE.Mesh(rechargeRingGeo, rechargeRingMat);
  rechargeRing.renderOrder = 9999;
  rechargeRing.visible = false;
  grp.add(rechargeRing);
  grp.userData.rechargeRing = rechargeRing;

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
     * that scales independently of font / DPR settings.
     *
     * The `id="recharge"` circle is the explosive-arrow recharge arc.
     * Drawn with stroke-dasharray = circumference and a controllable
     * stroke-dashoffset so the visible portion can be animated as a
     * fraction (0 = empty / full charge consumed, 1 = ready). The
     * `transform="rotate(-90 13 13)"` rotates the start angle from
     * the SVG default (3 o'clock) to 12 o'clock so the arc sweeps
     * clockwise from the top, matching the VR ring shader. */
    const r = 11;
    const C = 2 * Math.PI * r;
    c.innerHTML = `
      <svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">
        <circle id="recharge" cx="13" cy="13" r="${r}" stroke="#ffaa22"
          stroke-width="1.8" fill="none" opacity="0"
          stroke-dasharray="${C.toFixed(3)} ${C.toFixed(3)}"
          stroke-dashoffset="${C.toFixed(3)}"
          transform="rotate(-90 13 13)"
          style="transition: stroke 0.2s, opacity 0.15s;"/>
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
    /* Cache the recharge circle + its circumference so updateCrosshair
     * can mutate stroke-dashoffset without re-querying the DOM each
     * frame. */
    desktopCrosshair_._rechargeCircle = c.querySelector("#recharge");
    desktopCrosshair_._rechargeC = C;
  }
}

/** Refresh the explosive-arrow recharge progress ring on both the VR
 *  crosshair and the desktop reticle. Called from `updateCrosshair`
 *  so it shares the same gating (xr-presenting, archery enabled, etc.)
 *  and runs once per frame regardless of which display is active. */
function _updateCrosshairRechargeRing() {
  /* Show recharge feedback only when the player has explosive arrows
   * selected — otherwise it's noise. Same rule applies to both the
   * VR ring and the desktop SVG arc. */
  const showAtAll = ARCHERY_ENABLED && arrowType_ === ARROW_TYPE_EXPLOSIVE;
  /* Progress 0..1: 0 = just fired (empty), 1 = fully recharged. */
  const ready = _explosiveReady();
  const progress = ready
    ? 1
    : 1 - explosiveRechargeT_ / EXPLOSIVE_ARROW_RECHARGE_S;
  /* Color flips orange → green as the ring completes, signalling
   * "explosive is back" without the player having to look at the arc
   * length. */
  const colorHex = ready ? 0x66ff77 : 0xffaa22;

  /* VR ring. */
  const vrRing = crosshairMesh_?.userData?.rechargeRing;
  if (vrRing) {
    /* Only show when the parent crosshair is visible AND the player
     * is on the explosive loadout. The parent visibility is set later
     * in updateCrosshair from the aim-projection logic; if the parent
     * is hidden, the child won't render anyway, but we explicitly
     * gate on `showAtAll` so a parent toggle doesn't leak the wrong
     * state (e.g. arrow-type set to normal mid-frame). */
    vrRing.visible = showAtAll && crosshairMesh_.visible;
    if (vrRing.visible) {
      vrRing.material.uniforms.uProgress.value = progress;
      vrRing.material.uniforms.uColor.value.setHex(colorHex);
    }
  }

  /* Desktop SVG arc. */
  const dt = desktopCrosshair_;
  const ring = dt?._rechargeCircle;
  if (ring) {
    /* Mirror the VR gate: only show on desktop while the desktop
     * reticle is itself shown (i.e. not in VR, combat enabled, etc.).
     * We don't have direct access to the same gating logic here, so
     * derive visibility from the parent element's display style. */
    const parentVisible = dt.style.display !== "none";
    if (showAtAll && parentVisible) {
      ring.setAttribute("opacity", "0.95");
      ring.setAttribute(
        "stroke",
        ready ? "#66ff77" : "#ffaa22",
      );
      const C = dt._rechargeC;
      /* offset = C * (1 - progress) keeps the visible arc anchored
       * at the rotation start (12 o'clock after the -90° rotate). */
      ring.setAttribute("stroke-dashoffset", (C * (1 - progress)).toFixed(3));
    } else {
      ring.setAttribute("opacity", "0");
    }
  }
}

function updateCrosshair() {
  if (!crosshairMesh_) return;

  /* The crosshair is critical aiming feedback (like the damage flash),
   * not informational HUD — so it deliberately ignores uiVisible_ and
   * is no longer gated on combat (`enabled_`) either. With the bow
   * always drawable regardless of combat mode, it would be confusing
   * for the reticle to disappear; you'd see arrows fly with no aim
   * preview. The Y-button UI toggle hides the minimap / compass /
   * combat HUD / FPS panel / controller hints, but never the reticle. */
  if (desktopCrosshair_) {
    /* Desktop reticle is for the legacy hitscan path only — archery
     * has no desktop mode, and showing a 2D reticle while VR is
     * presenting would be wrong. */
    const showDesktop =
      enabled_ && !renderer_.xr.isPresenting && !ARCHERY_ENABLED;
    desktopCrosshair_.style.display = showDesktop ? "block" : "none";
  }

  if (!renderer_.xr.isPresenting) {
    crosshairMesh_.visible = false;
    /* Still tick the recharge ring so the desktop SVG arc updates
     * (and the VR ring's hidden state stays correct, even though the
     * parent is invisible). Without this the SVG arc would freeze at
     * its last value whenever VR isn't presenting. */
    _updateCrosshairRechargeRing();
    return;
  }

  /* Pick the aim ray. In archery mode the reticle should track the
   * actual arrow trajectory:
   *   • while drawing → ray from bow hand toward (bow − draw), i.e.
   *     the firing direction the next release will use. This makes
   *     the reticle a live aim preview instead of a fixed pointer.
   *   • while not drawing → ray from bow hand along the bow
   *     controller's forward (-Z in its local frame), which is
   *     where the bow is "pointed" at rest. An arrow released right
   *     now (without a draw) would fly along this same axis.
   * In legacy gun mode (ARCHERY_ENABLED=false) we fall back to the
   * right-controller forward — the original behaviour. */
  let originOk = false;
  if (ARCHERY_ENABLED) {
    if (_getBowAimPos(_muzzle)) {
      if (drawing_) {
        const drawCtrl = _getControllerByHand(_drawHandedness());
        if (drawCtrl) {
          drawCtrl.updateMatrixWorld(true);
          drawCtrl.getWorldPosition(_v0);
          _aimDir.copy(_muzzle).sub(_v0);
          if (_aimDir.lengthSq() > 1e-6) {
            _aimDir.normalize();
            originOk = true;
          }
        }
      }
      if (!originOk) {
        /* Not drawing — fall back to the bow controller's local -Z
         * (its forward), in world space. The bow itself is rotated
         * relative to the controller, but for "where is the player
         * pointing this thing?" the controller forward is the right
         * answer; bow rotation is just cosmetic. */
        const bowCtrl = _getControllerByHand(bowHandedness_);
        if (bowCtrl) {
          _fwdLocal.set(0, 0, -1);
          _aimDir.copy(_fwdLocal).applyQuaternion(bowCtrl.getWorldQuaternion(_q0)).normalize();
          originOk = true;
        }
      }
    }
  } else if (getRightControllerAim(_aimDir, _muzzle)) {
    originOk = true;
  }

  if (!originOk) {
    crosshairMesh_.visible = false;
    _updateCrosshairRechargeRing();
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
  crosshairMesh_.visible = true;
  crosshairMesh_.position.copy(_muzzle).addScaledVector(_aimDir, bestDist);
  crosshairMesh_.lookAt(camera_.getWorldPosition(_v0));
  /* Scale with distance so the crosshair stays at a constant ~5°
   * apparent size regardless of how far away the projected surface
   * is. Geometry is sized for ~1m projection, so scale = bestDist. */
  const s = Math.max(0.6, Math.min(8, bestDist));
  crosshairMesh_.scale.setScalar(s);

  /* Update the explosive-recharge progress ring around the reticle.
   * Done after the parent visibility/scale is settled so the ring
   * inherits the right transform on this same frame. */
  _updateCrosshairRechargeRing();
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
 * just leave topScores_ at its default empty list. */
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
      /* New shape: { topScores: [...] }. Old shape: { wave, kills }. */
      if (Array.isArray(r.topScores)) {
        topScores_ = r.topScores.slice(0, TOP_SCORES_KEEP);
      } else if (typeof r.wave === "number" || typeof r.kills === "number") {
        /* Legacy migration: synthesise a single top-score entry from the
         * pre-existing best-wave / best-kills record so the player's
         * old progress isn't blanked when they first run the new build. */
        const score = (r.kills || 0) * 100 + (r.wave || 0) * 500;
        topScores_ = [{
          score,
          kills: r.kills || 0,
          hqKills: 0,
          wave: r.wave || 0,
          durationS: 0,
          dateISO: new Date().toISOString(),
        }];
      }
    }
    db.close();
  } catch (e) {
    /* No-op: top-scores list remains empty. */
  }
  /* Refresh the intro panel now that scores have arrived. */
  _renderIntroTopScores();
}
function saveRecords() {
  /* Fire-and-forget — never throws. Records aren't critical state. */
  _openRecordsDb().then((db) => {
    const tx = db.transaction(RECORDS_STORE, "readwrite");
    tx.objectStore(RECORDS_STORE).put(
      { topScores: topScores_.slice(0, TOP_SCORES_KEEP) },
      _recordsKey(),
    );
    tx.oncomplete = () => db.close();
  }).catch(() => { /* ignore */ });
}

/** Insert `entry` into the persistent top-scores list, keeping it
 *  sorted descending by score and capped at TOP_SCORES_KEEP. Saves
 *  asynchronously. Returns the rank (1-indexed) the entry occupies
 *  in the kept list, or -1 if it didn't make the cut. */
function _recordRunScore(entry) {
  topScores_.push(entry);
  topScores_.sort((a, b) => (b.score || 0) - (a.score || 0));
  topScores_.length = Math.min(topScores_.length, TOP_SCORES_KEEP);
  saveRecords();
  /* Refresh whatever might be displaying the list. */
  _renderIntroTopScores();
  const rank = topScores_.indexOf(entry) + 1;   // 0 → -1 falls through
  return rank > 0 ? rank : -1;
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

  /* Wave end condition: nothing left to spawn AND nothing alive.
   * Snitches are ambient (auto-spawned by anti-air emplacements,
   * not by the wave manager) and never count toward the wave's
   * kill quota — otherwise a wandering snitch would gate wave
   * progression indefinitely. */
  const alive = drones_.filter((d) => !d.dead && d.type !== DRONE_TYPE_SNITCH).length;
  if (pendingSpawns_.length === 0 && alive === 0) {
    /* Wave cleared — top-score updates happen on death (game-over)
     * now, not per-wave; the run-summary subsumes wave-best. */
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
  /* Same AND-with-uiVisible_ formula as the per-frame loop, so this
   * edge-triggered call lands a consistent value when combat is
   * toggled while the UI is hidden. */
  if (combatHudMesh_) combatHudMesh_.visible = on && uiVisible_;
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
    hqKills_ = 0;
    runStartedAt_ = (typeof performance !== "undefined") ? performance.now() : Date.now();
    gameOver_ = false;
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
      const strikeRing = d.group.userData.snitchStrikeRing;
      if (strikeRing) {
        scene_.remove(strikeRing);
        strikeRing.geometry?.dispose?.();
        strikeRing.material?.dispose?.();
        d.group.userData.snitchStrikeRing = null;
      }
      if (!d.dead) scene_.remove(d.group);
    }
    drones_.length = 0;
    for (const p of projectiles_) {
      if (p && p.mesh) scene_.remove(p.mesh);
    }
    projectiles_.length = 0;
    for (const t of tracers_) {
      scene_.remove(t.mesh);
      t.mesh.geometry.dispose();
    }
    tracers_.length = 0;
    for (const f of debris_) {
      scene_.remove(f.mesh);
      /* Shared chip resources (impact debris) must NOT be disposed —
       * the geometry + material are reused across every bullet impact
       * for the lifetime of the session. Disposing them here would
       * silently break every future chip spawn. */
      if (!f.sharedRes) {
        f.mesh.geometry?.dispose?.();
        f.mesh.material?.dispose?.();
      }
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
  let battleButton = false;
  let aButton = false;
  let xButton = false;
  for (const src of session.inputSources) {
    if (!src?.gamepad) continue;
    if (src.handedness === "right") {
      if (src.gamepad.buttons?.[0]?.pressed) triggerR = true;
      /* Touch controllers: right-hand button[4] = A, button[5] = B.
       * - B toggles combat mode (legacy mapping; "B Toggle Battle"
       *   hint mesh sits on the right grip).
       * - A toggles bow handedness in archery mode. */
      if (src.gamepad.buttons?.[4]?.pressed) aButton = true;
      if (src.gamepad.buttons?.[5]?.pressed) battleButton = true;
    }
    if (src.handedness === "left") {
      if (src.gamepad.buttons?.[0]?.pressed) triggerL = true;
      /* Left-hand button[4] = X (lower face). Toggles arrow type
       * between normal and explosive. */
      if (src.gamepad.buttons?.[4]?.pressed) xButton = true;
    }
  }

  /* Game-over short-circuit: a rising-edge right-trigger restarts
   * the run. We swallow this trigger pull so it doesn't also fire
   * the bow / weapon on the SAME frame the new run starts. The
   * `prev*` edge-state flags are reset inside `_resetGame` →
   * `setBotsEnabled(false)` doesn't reset them, so we manually
   * raise them here to mask the still-held trigger as already-down. */
  if (gameOver_) {
    if (triggerR && !prevTriggerR_) {
      _resetGame();
      prevTriggerR_ = true;
      prevDrawTrigger_ = true;
      prevTriggerL_ = true;
      return;
    }
    /* While dead, only the right-trigger restart input matters —
     * skip the rest of the input loop so we don't toggle combat
     * off, swap arrow types, fire the bow, etc. */
    prevTriggerR_ = triggerR;
    prevTriggerL_ = triggerL;
    prevButtonX_ = battleButton;
    prevAButton_ = aButton;
    prevXButton_ = xButton;
    prevDrawTrigger_ = false;
    return;
  }

  /* B (right) toggles combat mode on rising edge. */
  if (battleButton && !prevButtonX_) setBotsEnabled(!enabled_);
  prevButtonX_ = battleButton;

  /* X (left) toggles arrow type on rising edge. The "X Switch arrow"
   * hint above the X button (left grip) advertises this. */
  if (xButton && !prevXButton_) toggleArrowType();
  prevXButton_ = xButton;

  if (ARCHERY_ENABLED) {
    /* Lazily attach the bow as soon as a controller has reported its
     * handedness. Idempotent — no-op once attached. */
    _ensureArcherySetup();

    /* A (right) → toggle which hand holds the bow. */
    if (aButton && !prevAButton_) _toggleBowHand();
    prevAButton_ = aButton;

    /* Per-hand trigger demux based on which hand currently holds the
     * bow. The DRAW trigger lives on the OTHER hand from the bow; the
     * BOW-HAND trigger detonates an in-flight explosive arrow (was
     * a grenade throw before; the grenade UI is gone — replaced by
     * the X-button arrow-type toggle per spec). */
    const drawIsRight = bowHandedness_ === "left";
    const drawTrigger = drawIsRight ? triggerR : triggerL;
    const bowHandTrigger = drawIsRight ? triggerL : triggerR;
    /* Rising edge → start drawing, falling edge → release. The
     * `drawing_` guard on the falling edge prevents a stray release
     * from firing if the previous frame's draw trigger was true for
     * unrelated reasons (e.g. immediately after a hand-swap, see
     * _toggleBowHand's edge-state reset).
     *
     * NOT gated on `enabled_` (combat mode): with the bow physically
     * visible in the player's hand, gating drawing behind a combat
     * toggle makes the bow look broken — you grab the string and
     * nothing happens. The bow always works; combat mode (B) only
     * controls drone spawning and AI activity. Arrows that strike
     * dead drones / no drones simply embed in walls or fall. */
    if (drawTrigger && !prevDrawTrigger_) _startDraw();
    if (!drawTrigger && prevDrawTrigger_ && drawing_) _releaseDraw();
    prevDrawTrigger_ = drawTrigger;

    /* Bow-hand trigger → detonate the first explosive arrow in
     * flight. Only on the rising edge (single-shot). If no explosive
     * arrow is mid-flight, the press does nothing (silent). The
     * detonation is independent of the draw cycle — the player can
     * be drawing another arrow with the OTHER hand at the same time
     * and the detonation still fires. */
    const prevBowHandTrig = drawIsRight ? prevTriggerL_ : prevTriggerR_;
    if (bowHandTrigger && !prevBowHandTrig && _explosiveArrowInFlight()) {
      detonateExplosiveArrowInFlight();
    }

    /* Persist raw per-hand trigger state for the prev-edge lookup
     * above on the next frame. */
    prevTriggerL_ = triggerL;
    prevTriggerR_ = triggerR;
  } else {
    /* Legacy gun mode (kept for ARCHERY_ENABLED=false). */
    if (enabled_ && triggerR && !prevTriggerR_) fireHitscan();
    prevTriggerR_ = triggerR;
    /* Left trigger: legacy grenade aim flow (still here in case
     * ARCHERY_ENABLED is flipped off — it's the only ranged-explosive
     * for the gun loadout). */
    if (enabled_ && triggerL && !prevTriggerL_) startGrenadeAim();
    if (!triggerL && prevTriggerL_ && grenadeAiming_) releaseGrenadeAim();
    prevTriggerL_ = triggerL;
  }
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

/* Desktop fire (left mouse button) when combat is enabled.
 * Game is VR-only — the desktop path is just a code-survival fallback
 * for the legacy hitscan gun (kept reachable when ARCHERY_ENABLED is
 * flipped off). Archery has no desktop equivalent. */
function attachDesktopFire() {
  renderer_.domElement.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (!enabled_) return;
    if (renderer_.xr.isPresenting) return;
    if (!ARCHERY_ENABLED) fireHitscan();
  });
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (!enabled_) return;
    if (renderer_.xr.isPresenting) return;
    if (e.key === "f" || e.key === "F") {
      if (!ARCHERY_ENABLED) fireHitscan();
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

  /* Bow release — sharp thump (string slap) + decaying tonal twang.
   * Slot name is `bowReleaseProc` so it doesn't shadow the optional
   * sampled buffer (`audioBuffers_.bowFire`) the user may drop in
   * later via SAMPLED_SFX. The release fire site picks bowFire first
   * and falls back to bowReleaseProc, identical to the
   * rifleFire / playerShot fallback pattern. */
  audioBuffers_.bowReleaseProc = makeProceduralBuffer(ctx, 0.30, (t) => {
    const env = Math.exp(-t * 12);
    const noise = (Math.random() - 0.5) * 0.6;
    const tone = Math.sin(2 * Math.PI * 220 * t) * 0.5
               + Math.sin(2 * Math.PI * 110 * t) * 0.25;
    return (noise + tone) * env * 0.9;
  });

  audioReady_ = true;

  /* MP3-backed sample SFX. Loaded asynchronously after the procedural
   * fallbacks are in place — code that fires SFX always uses the
   * sample slot if it's been filled in, otherwise the procedural one
   * (so a shot during the first ~50 ms of a session still makes a
   * sound). Total payload is ~180 KB, decoded once into AudioBuffer
   * memory and reused for every play. */
  loadSampledSfx();
}

/** Fetch + decode an MP3 (or any supported codec) into an AudioBuffer.
 *  Returns null on failure rather than throwing — callers gracefully
 *  fall back to procedural buffers. */
async function loadAudioBufferFromUrl(url) {
  const ctx = audioListener_?.context;
  if (!ctx) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[brutalistVR8] audio fetch ${url} failed: ${res.status}`);
      return null;
    }
    const arr = await res.arrayBuffer();
    /* decodeAudioData has a callback-style fallback for older Safari but
     * Quest browser + every modern desktop browser supports the promise
     * form, so we use it directly. */
    return await ctx.decodeAudioData(arr);
  } catch (e) {
    console.warn(`[brutalistVR8] audio decode ${url} failed:`, e);
    return null;
  }
}

const SAMPLED_SFX = {
  rifleFire: "audio/freesound_community-sniper-rifle-5989.mp3",
  healthPickup: "audio/submarine-sonar-38243-once.mp3",
  explosionImpact: "audio/sound-design-elements-impact-sfx-ps-084-353199.mp3",
  metalHits: [
    "audio/metal-hit-92-200420.mp3",
    "audio/metal-hit-94-200422.mp3",
    "audio/metal-hit-95-200424.mp3",
  ],
  /* Drone destruction — heavy crash impact, sells the structural
   * collapse of the drone breaking apart. Played from the drone's
   * world position so the player can locate the kill. */
  droneDeath: "audio/dragon-studio-car-crash-sound-effect-376874.mp3",
  /* Arrow release / flight — two variants are picked from at random
   * so consecutive shots don't sound mechanically identical. Either
   * file failing to load is silently OK (loadAudioBufferFromUrl
   * returns null), and if the array ends up empty the release falls
   * back to the procedural twang `bowReleaseProc`. */
  bowSwooshes: [
    "audio/arrow-swoosh.mp3",
    "audio/arrow-swoosh2.mp3",
  ],
};

/** Kick off MP3 → AudioBuffer loads in parallel. Each buffer becomes
 *  available the moment its load resolves; until then the SFX call
 *  sites fall back to their procedural counterparts. */
function loadSampledSfx() {
  loadAudioBufferFromUrl(SAMPLED_SFX.rifleFire).then((buf) => {
    if (buf) audioBuffers_.rifleFire = buf;
  });
  loadAudioBufferFromUrl(SAMPLED_SFX.healthPickup).then((buf) => {
    if (buf) audioBuffers_.healthPickup = buf;
  });
  loadAudioBufferFromUrl(SAMPLED_SFX.explosionImpact).then((buf) => {
    if (buf) audioBuffers_.explosionImpact = buf;
  });
  loadAudioBufferFromUrl(SAMPLED_SFX.droneDeath).then((buf) => {
    if (buf) audioBuffers_.droneDeath = buf;
  });
  audioBuffers_.metalHits = [];
  for (const url of SAMPLED_SFX.metalHits) {
    loadAudioBufferFromUrl(url).then((buf) => {
      if (buf) audioBuffers_.metalHits.push(buf);
    });
  }
  /* Bow swoosh variants — populated as each load resolves. Until at
   * least one resolves, _pickBowSwoosh() falls back to the procedural
   * twang. Loads are independent, so a 404 on one file doesn't block
   * the other. */
  audioBuffers_.bowSwooshes = [];
  for (const url of SAMPLED_SFX.bowSwooshes) {
    loadAudioBufferFromUrl(url).then((buf) => {
      if (buf) audioBuffers_.bowSwooshes.push(buf);
    });
  }
}

/** Random swoosh variant for an arrow release. Falls back to the
 *  procedural bow-release twang if no MP3 has loaded yet (e.g. during
 *  the first ~50 ms of a fresh session). */
function _pickBowSwoosh() {
  const variants = audioBuffers_.bowSwooshes;
  if (variants && variants.length > 0) {
    return variants[Math.floor(Math.random() * variants.length)];
  }
  return audioBuffers_.bowReleaseProc;
}

/** Play a metallic-hit one-shot at `worldPos`, randomly choosing one of
 *  the three sampled variants (so repeated hits don't sound identical).
 *  Falls back to the procedural `hit` buffer if no samples are loaded
 *  yet — that way the first few hits in a fresh session still register. */
function playMetalHitAt(worldPos, opts) {
  const variants = audioBuffers_.metalHits;
  let buf;
  if (variants && variants.length > 0) {
    buf = variants[Math.floor(Math.random() * variants.length)];
  } else {
    buf = audioBuffers_.hit;
  }
  playOneShotAt(buf, worldPos, opts);
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

/** Spatial blast / impact — uses `explosionImpact` MP3 when loaded, else procedural `explosion`. */
function playExplosionImpactAt(worldPos, opts = {}) {
  const boom = audioBuffers_.explosionImpact || audioBuffers_.explosion;
  playOneShotAt(boom, worldPos, {
    volume: opts.volume ?? 1,
    refDistance: opts.refDistance ?? 8,
    maxDistance: opts.maxDistance,
    rolloff: opts.rolloff,
  });
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

/* ── Haptics ──────────────────────────────────────────────────────────
 * WebXR exposes haptic actuators on each input source's gamepad. The
 * Quest browser supports the Gamepad-style `pulse(intensity, ms)` form
 * directly; some builds also expose `playEffect("dual-rumble", …)` —
 * we try `pulse` first because it's the more widely deployed API on
 * Quest browsers. Silent no-op everywhere else (desktop, missing
 * actuator, suspended XR session). */
function pulseHapticActuator(handedness, intensity, durationMs) {
  if (!renderer_?.xr?.isPresenting) return;
  const session = renderer_.xr.getSession();
  if (!session?.inputSources) return;
  for (const src of session.inputSources) {
    if (src?.handedness !== handedness) continue;
    const ha = src.gamepad?.hapticActuators?.[0];
    if (!ha) return;
    const i = Math.max(0, Math.min(1, intensity));
    /* Some implementations only have one of the two methods; try the
     * preferred one and fall back. Both are best-effort. */
    try {
      if (typeof ha.pulse === "function") {
        ha.pulse(i, durationMs);
      } else if (typeof ha.playEffect === "function") {
        ha.playEffect("dual-rumble", {
          duration: durationMs,
          strongMagnitude: i,
          weakMagnitude: i,
        });
      }
    } catch (_) { /* ignore — haptics are best-effort */ }
    return;
  }
}

function pulseRightController(intensity = 0.75, durationMs = 60) {
  pulseHapticActuator("right", intensity, durationMs);
}

/** Both motion controllers — intense feedback when the player is hurt. */
function pulseBothControllersImpact(intensity = 1, durationMs = 110) {
  pulseHapticActuator("left", intensity, durationMs);
  pulseHapticActuator("right", intensity, durationMs);
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
  getSectorTowerAnchors_ = opts.getSectorTowerAnchors || null;
  respawnPlayer_ = opts.respawnPlayer || null;

  /* Read URL config for difficulty / mode / seed. */
  _readQueryConfig();
  /* Load top-score history (async; non-blocking). The callback path
   * inside loadRecords also re-renders the intro top-3 list when the
   * data arrives. */
  loadRecords().catch(() => { /* ignore errors — falls back to empty list */ });
  /* Inject the top-scores list area into the intro panel right away
   * (loadRecords will populate it once the IndexedDB read returns). */
  _ensureIntroTopScoresHost();

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
     * topScores_ from IndexedDB. */
    const refreshMeta = () => {
      const best = topScores_[0];
      const bestStr = best
        ? `best ${best.score} pts (W${best.wave}, ${best.kills}k, ${best.hqKills}HQ)`
        : "no runs yet";
      metaLine.textContent =
        `${runMode_.toUpperCase()} · ${difficulty_.toUpperCase()}${seedTag} — ${bestStr}`;
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
  ensureCompassRibbon();
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

  /* When the player re-enters VR after a Game Over, treat it as a
   * Play Again — wipe run state and start fresh. Without this, the
   * VR view would resume with `gameOver_` still latched and the 3D
   * panel still up, expecting them to pull the trigger. The DOM
   * intro flow that brought them back here ALREADY counts as the
   * Play Again confirmation. */
  renderer_.xr.addEventListener("sessionstart", () => {
    if (gameOver_) _resetGame();
  });
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
  /* Archery: integrates in-flight arrows (gravity + continuous-collision
   * raycast vs. drones and world OBBs), updates the live nocked-arrow
   * orientation + bow string deformation, and ticks the per-shot
   * cooldown. Outside of combat (enabled_ = false) the loop is still
   * cheap — there are no in-flight arrows to integrate, no drawing in
   * progress (gated by `enabled_` in pollVRInputs), and the cooldown
   * timer just decrements toward zero. */
  if (ARCHERY_ENABLED) updateArrows(dt);
  /* Surface-damage decals are cleaned up at most twice a second —
   * unloaded sectors leave their decals visually orphaned in the
   * scene without this. The check is cheap (Set lookup over the
   * bounded decal pool) but doesn't need to run every frame. */
  tickDecalCleanup(performance.now());
  /* Grenade aim preview ticks every frame whether or not we're in
   * combat — but startGrenadeAim() guards the entry, so it only
   * actually animates while the player is holding the trigger. */
  tickGrenadeAim(dt);

  /* Health pickup spheres: animate the bob/spin and check player
   * proximity for collection. Cheap (≤9 spheres active in the 5×5
   * sector ring) and runs regardless of combat mode so the player
   * can still heal up while exploring outside of waves. */
  _tickHealthSpheres();

  /* The sector minimap is a navigation tool, not a combat tool —
   * always visible, always refreshed (cheap; the draw itself is gated
   * to redraw at most ~5 Hz when nothing material has changed). The
   * compass ribbon is the head-locked orientation strip; it redraws
   * only on whole-degree heading changes so its cost is negligible. */
  drawSectorMinimap();
  drawCompassRibbon();

  /* UI-visibility — frame-driven, declarative. Each gated mesh's
   * visibility is the AND of "logically wanted" (e.g. combat HUD only
   * during combat) and "UI master gate is on". Computing this every
   * frame instead of edge-triggering it (e.g. only in setBotsEnabled)
   * means hide-then-show always recovers correctly: if combat is on
   * while UI is hidden and the player un-hides UI, the next frame
   * reasserts combatHudMesh_.visible = true. The crosshair is exempt
   * — it's aiming feedback, not informational HUD, so updateCrosshair()
   * deliberately ignores the gate. */
  if (sectorMinimapMesh_) sectorMinimapMesh_.visible = uiVisible_;
  if (compassRibbonMesh_) compassRibbonMesh_.visible = uiVisible_;
  if (combatHudMesh_) combatHudMesh_.visible = uiVisible_ && enabled_;

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
  /* Anti-air emplacements live independently of the wave manager —
   * they're tied to the procedural sectors loaded around the player.
   * Their FSM only does work when at least one is loaded; the early
   * return inside the loop keeps the cost negligible when the player
   * is in a low-tower zone. */
  for (const aa of antiair_) aa.update(dt, _v0);
  /* Maintain the snitch population — top up to SNITCH_TARGET_COUNT,
   * but only when there's an anti-air to spot for. Without an AA the
   * snitch has nothing to relay to. */
  _tickSnitchSpawning(dt);
  tickWaveManager(dt);
  drawCombatHud();
}

/* Top up snitch drones up to SNITCH_TARGET_COUNT around the player.
 * Called every frame from updateBots — the respawn-delay guard makes
 * this cheap (a few flag checks per frame).
 *
 * Snitches don't count toward the wave kill target — they're an
 * ambient threat that's always present in battle mode, independent
 * of the AA population (the user explicitly wants them around even
 * when the player has destroyed every nearby launcher). When there
 * are no AAs, the snitch's spotted-relay does nothing functionally,
 * but the visible cone + green-eye silhouette still acts as
 * persistent surveillance the player has to evade. */
function _tickSnitchSpawning(dt) {
  if (snitchRespawnTimer_ > 0) {
    snitchRespawnTimer_ -= dt;
    return;
  }
  let livingSnitches = 0;
  for (const d of drones_) {
    if (!d.dead && d.type === DRONE_TYPE_SNITCH) livingSnitches++;
  }
  if (livingSnitches >= SNITCH_TARGET_COUNT) return;
  /* Spawn one at a low altitude near the player. */
  const playerPos = getPlayerPosition_ ? getPlayerPosition_() : null;
  if (!playerPos) return;
  const ang = Math.random() * Math.PI * 2;
  const r = 18 + Math.random() * (SNITCH_PATROL_RADIUS - 18);
  const sp = new THREE.Vector3(
    playerPos.x + Math.cos(ang) * r,
    SNITCH_DEFAULT_ALT,
    playerPos.z + Math.sin(ang) * r,
  );
  const drone = new Drone(sp, DRONE_TYPE_SNITCH);
  /* The base Drone constructor calls pickSurveyTarget() which picks a
   * high-altitude wander target — wrong for snitches who patrol low.
   * Force an immediate _tickSnitch re-pick by zeroing the change timer
   * and seeding the target near the spawn so the first frame doesn't
   * see the snitch lurching upward. */
  drone.surveyChangeIn = 0;
  drone.targetPos.copy(sp);
  drones_.push(drone);
  snitchRespawnTimer_ = SNITCH_RESPAWN_DELAY;
}

export { setBotsEnabled, getBotsEnabled };

/** Public entry for "Play Again". Wipes run-scoped state, reseats
 *  the player at spawn, and starts a fresh wave-1. Safe to call
 *  whether or not the player is currently in game-over. */
export function restartRun() { _resetGame(); }

/** Returns the persisted top scores (most-recent-first slice of
 *  the IndexedDB-backed list) so console / DOM consumers can read
 *  them without going through `getBotsDebug()`. */
export function getTopScores() { return topScores_.slice(0, TOP_SCORES_KEEP); }

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
    hqKills: hqKills_,
    gameOver: gameOver_,
    topScores: topScores_.slice(0, 3),
  };
}

/** Snapshot of every active anti-air emplacement: position, FSM state,
 *  per-component HP, sees-player flag, current aim-focus ramp, and
 *  whether the player is in the AA's passive-track range. Use from
 *  the console:
 *
 *    brutalistVR8.bots.aaDebug()
 *
 *  to verify AAs are spawned + engaging. The "trackable" flag tells
 *  you whether the launcher is actively slewing toward you (range-
 *  gated); the "sees" flag tells you whether _seesPlayer succeeded
 *  this frame (cone + LOS + range); the FSM state should advance
 *  SLEEP → AIM → FIRE → COOLDOWN once the cone has fully acquired
 *  you. */
export function getAntiAirDebug() {
  const playerHead = new THREE.Vector3();
  getPlayerHeadWorld(playerHead);
  return antiair_.map((aa) => {
    const pivotPos = new THREE.Vector3();
    aa.pivot.getWorldPosition(pivotPos);
    const distToPlayer = pivotPos.distanceTo(playerHead);
    const trackR = ANTIAIR_VISION_LENGTH * ANTIAIR_TRACK_RANGE_MUL;
    const components = {};
    for (const c of aa.components) {
      const k = c.userData.kind || "unknown";
      const tag = (k === "pod" || k === "plate")
        ? `${k}${c.userData.podIndex ?? c.userData.face ?? ""}`
        : k;
      components[tag] = c.userData.broken
        ? "broken"
        : `${(c.userData.hp ?? 0).toFixed(0)}/${c.userData.maxHp ?? 0}`;
    }
    return {
      sector: aa.sectorKey,
      pos: [pivotPos.x.toFixed(1), pivotPos.y.toFixed(1), pivotPos.z.toFixed(1)],
      state: aa.state,
      dead: aa.dead,
      aimFocus: aa.aimFocus.toFixed(2),
      sees: aa._seesPlayer(playerHead),
      underRelay: aa.isUnderRelay(),
      trackable: distToPlayer < trackR,
      distToPlayer: distToPlayer.toFixed(1),
      coreShielded: aa._isCoreShielded(),
      components,
    };
  });
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

/** Start the streaming-music system. Idempotent; safe to call from
 * `sessionstart` to begin calm-ambience playback the moment the headset
 * takes over. The "Enter VR" click is the AudioContext-resuming user
 * gesture, so playback should succeed even though sessionstart fires
 * one frame later. */
export function ensureMusicStarted() {
  if (!initDone_) return;
  /* Make sure the user-facing toggle is ON; it is by default but a
   * previous combat session may have flipped it. */
  setMusicEnabled(true);
  ensureMusicInited();
}

/** Runtime switch for the minimap orientation. "north" = static map
 *  with a heading triangle (default, easier on VR motion-sickness),
 *  "heading" = map rotates so player-forward is up. Forces an
 *  immediate redraw so the user sees the change without waiting for
 *  the next gating tick. */
export function setCompassMode(mode) {
  if (mode !== "north" && mode !== "heading") return;
  compassMode_ = mode;
  /* Force the minimap to redraw on the next frame regardless of the
   * gating heuristics. */
  sectorMinimapLastHeadingDeg_ = -999;
  sectorMinimapLastDirtyMs_ = 0;
}

export function getCompassMode() {
  return compassMode_;
}

/** Master UI-visibility setter. Hides/shows the minimap, compass
 *  ribbon, combat HUD, and crosshair. Damage flashes / drones /
 *  tracers / projectiles / debris are NOT gated — only the
 *  informational HUD layer. The Y button (left) toggles this; main.js
 *  is also responsible for hiding its own FPS panel + controller hints
 *  in lockstep. */
export function setUIVisible(v) {
  uiVisible_ = !!v;
  /* Apply the same frame-driven formula immediately so the change is
   * snappy even if updateBots has already run for this animation
   * frame. updateBots will keep re-asserting these every frame anyway,
   * which is what fixes the "battle was on while UI was hidden →
   * combat HUD doesn't reappear when UI is shown" bug. */
  if (sectorMinimapMesh_) sectorMinimapMesh_.visible = uiVisible_;
  if (compassRibbonMesh_) compassRibbonMesh_.visible = uiVisible_;
  if (combatHudMesh_) combatHudMesh_.visible = uiVisible_ && enabled_;
  /* crosshair is intentionally NOT toggled — see updateCrosshair(). */
}

export function getUIVisible() {
  return uiVisible_;
}
