// ========================================
// RTSVR2 — Game Configuration
// All constants, stats, and tuning values
// ========================================

// --- Map ---
export const MAP_SIZE = 200;
export const MAP_HALF = MAP_SIZE / 2;
/**
 * Gameplay / walkable region is a disk centered on the map with this radius (m).
 * `MAP_HALF * √2` is the circumradius of the MAP_SIZE×MAP_SIZE world square (so the disk fully contains every point that was inside the original square, including corners).
 */
export const MAP_PLAYABLE_RADIUS = MAP_HALF * Math.SQRT2;
/**
 * Units, buildings (placement), pathfinding, camera clamp, and orders use this **smaller** disk so
 * armies stay off the outer **crater rim** band (see `MAP_PLAYABLE_RADIUS` for terrain / UV rim).
 */
export const MAP_UNIT_PLAYABLE_INSET = 15;
export const MAP_UNIT_PLAYABLE_RADIUS = MAP_PLAYABLE_RADIUS - MAP_UNIT_PLAYABLE_INSET;
export const GROUND_Y = 0;

/** Clamp world XZ to the closed disk of radius `MAP_UNIT_PLAYABLE_RADIUS - margin`. */
export function clampWorldToPlayableDisk(x, z, margin = 0) {
  const R = MAP_UNIT_PLAYABLE_RADIUS - margin;
  if (R <= 0) return { x, z };
  const d2 = x * x + z * z;
  if (d2 <= R * R) return { x, z };
  const d = Math.sqrt(d2);
  const s = R / d;
  return { x: x * s, z: z * s };
}

/** True if (x,z) lies inside the unit-playable disk (optional inset `margin` from the rim). */
export function isWorldInsidePlayableDisk(x, z, margin = 0) {
  const R = MAP_UNIT_PLAYABLE_RADIUS - margin;
  if (R <= 0) return false;
  return x * x + z * z <= R * R;
}

// --- Players ---
export const MAX_PLAYERS = 4;
export const UNIT_CAP_PER_PLAYER = 30;
export const STARTING_CREDITS = 1000;
export const PASSIVE_INCOME_PER_SEC = 2;

export const PLAYER_COLORS = [
  0xff3333, // P1 Red
  0xff8800, // P2 Orange
  0x3366ff, // P3 Blue
  0x00cccc, // P4 Cyan
];

export const PLAYER_COLOR_HEX = ['#ff3333', '#ff8800', '#3366ff', '#00cccc'];

// Spawn positions (corners, facing center). **180° vs earlier builds:** P0 starts NE (+,+), opposite SW (−,−).
export const SPAWN_POSITIONS = [
  { x: 70, z: 70, rotation: -Math.PI * 0.75 }, // P1 — NE (default human / slot 0)
  { x: -70, z: 70, rotation: -Math.PI * 0.25 }, // P2 — NW
  { x: 70, z: -70, rotation: Math.PI * 0.75 }, // P3 — SE
  { x: -70, z: -70, rotation: Math.PI * 0.25 }, // P4 — SW
];

// Teams: P1+P2 = team 0,  P3+P4 = team 1
export const PLAYER_TEAMS = [0, 0, 1, 1];

// --- Resource Fields ---
export const RESOURCE_FIELD_CAPACITY = 5000;
export const HARVEST_AMOUNT = 50;       // Credits per harvester trip
export const HARVEST_TIME = 3.0;        // Seconds to fill harvester at field
export const DEPOSIT_TIME = 1.5;        // Seconds to unload at refinery

export const RESOURCE_FIELD_POSITIONS = [
  // Inner ring (closer to bases, safer) — mirrored with spawn flip
  { x: 45, z: 45 }, // Near P1 (NE)
  { x: -45, z: 45 }, // Near P2 (NW)
  { x: 45, z: -45 }, // Near P3 (SE)
  { x: -45, z: -45 }, // Near P4 (SW)
  // Outer contested ring (center of map, risky)
  { x: 0, z: 30 }, // North center
  { x: 0, z: -30 }, // South center
  { x: 30, z: 0 }, // East center
  { x: -30, z: 0 }, // West center
];

// --- Unit Types ---
export const UNIT_TYPES = {
  rifleman: {
    name: 'Rifleman',
    category: 'infantry',
    cost: 100,
    buildTime: 4,
    hp: 60,
    damage: 8,
    fireRate: 0.8,
    range: 12,
    speed: 3.0,
    visionRange: 18,
    dmgVsInfantry: 1.0,
    dmgVsVehicle: 0.3,
    dmgVsBuilding: 0.5,
    aoe: 0,
    description: 'General purpose infantry',
  },
  rocketSoldier: {
    name: 'Rocket Soldier',
    category: 'infantry',
    cost: 175,
    buildTime: 6,
    hp: 50,
    damage: 25,
    fireRate: 1.5,
    range: 14,
    speed: 2.5,
    visionRange: 16,
    dmgVsInfantry: 0.4,
    dmgVsVehicle: 2.0,
    dmgVsBuilding: 1.5,
    aoe: 0,
    description: 'Anti-vehicle specialist',
  },
  sniper: {
    name: 'Sniper',
    category: 'infantry',
    cost: 300,
    buildTime: 8,
    hp: 35,
    damage: 80,
    fireRate: 3.0,
    range: 28,
    speed: 2.0,
    visionRange: 35,
    dmgVsInfantry: 3.0,
    dmgVsVehicle: 0.15,
    dmgVsBuilding: 0.2,
    aoe: 0,
    description: 'Long-range infantry killer',
  },
  engineer: {
    name: 'Engineer',
    category: 'infantry',
    cost: 150,
    buildTime: 5,
    hp: 40,
    damage: 0,
    fireRate: 0,
    range: 0,
    speed: 2.5,
    visionRange: 24,
    dmgVsInfantry: 0,
    dmgVsVehicle: 0,
    dmgVsBuilding: 0,
    aoe: 0,
    canCapture: true,
    canRepair: true,
    repairRate: 15, // HP/sec (repair not implemented yet)
    description: 'Captures enemy buildings (time-based); repair planned',
  },
  scoutBike: {
    name: 'Scout Bike',
    category: 'vehicle',
    cost: 125,
    buildTime: 4,
    hp: 70,
    damage: 6,
    fireRate: 0.5,
    range: 10,
    speed: 6.0,
    visionRange: 25,
    dmgVsInfantry: 0.8,
    dmgVsVehicle: 0.3,
    dmgVsBuilding: 0.3,
    aoe: 0,
    description: 'Fast recon unit',
  },
  apc: {
    name: 'APC',
    category: 'vehicle',
    cost: 250,
    buildTime: 7,
    hp: 150,
    damage: 10,
    fireRate: 1.0,
    range: 10,
    speed: 4.5,
    visionRange: 16,
    dmgVsInfantry: 1.2,
    dmgVsVehicle: 0.4,
    dmgVsBuilding: 0.5,
    aoe: 0,
    description: 'Armored transport',
  },
  lightTank: {
    name: 'Light Tank',
    category: 'vehicle',
    cost: 350,
    buildTime: 8,
    hp: 200,
    damage: 18,
    fireRate: 1.2,
    range: 14,
    speed: 3.5,
    visionRange: 16,
    dmgVsInfantry: 1.0,
    dmgVsVehicle: 1.0,
    dmgVsBuilding: 1.0,
    aoe: 0,
    description: 'Versatile combat vehicle',
  },
  heavyTank: {
    name: 'Heavy Tank',
    category: 'vehicle',
    cost: 550,
    buildTime: 12,
    hp: 400,
    damage: 30,
    fireRate: 2.0,
    range: 14,
    speed: 2.0,
    visionRange: 25,
    dmgVsInfantry: 0.8,
    dmgVsVehicle: 1.5,
    dmgVsBuilding: 1.5,
    aoe: 0,
    description: 'Heavy assault vehicle',
  },
  artillery: {
    name: 'Artillery',
    category: 'vehicle',
    cost: 500,
    buildTime: 14,
    hp: 100,
    damage: 40,
    fireRate: 3.5,
    range: 35,
    speed: 1.5,
    visionRange: 22,
    dmgVsInfantry: 1.5,
    dmgVsVehicle: 1.0,
    dmgVsBuilding: 2.5,
    aoe: 5, // 5 unit AoE radius
    description: 'Long-range siege unit',
  },
  harvester: {
    name: 'Harvester',
    category: 'vehicle',
    cost: 200,
    buildTime: 6,
    hp: 250,
    damage: 0,
    fireRate: 0,
    range: 0,
    speed: 2.0,
    visionRange: 18,
    dmgVsInfantry: 0,
    dmgVsVehicle: 0,
    dmgVsBuilding: 0,
    aoe: 0,
    carryCapacity: HARVEST_AMOUNT,
    description: 'Collects resources',
  },
  mobileHq: {
    name: 'Mobile HQ',
    category: 'vehicle',
    cost: 750,
    buildTime: 18,
    hp: 450,
    damage: 0,
    fireRate: 0,
    range: 0,
    speed: 1.4,
    visionRange: 20,
    dmgVsInfantry: 0,
    dmgVsVehicle: 0,
    dmgVsBuilding: 0,
    aoe: 0,
    description: 'Deploys into a permanent HQ at its location (new build radius)',
  },
};

// Types producible at each building (Harvester: Refinery only; APC removed from War Factory list)
export const BARRACKS_UNITS = ['rifleman', 'rocketSoldier', 'sniper', 'engineer'];
export const FACTORY_UNITS = ['scoutBike', 'lightTank', 'heavyTank', 'artillery', 'mobileHq'];

// --- Engineer building capture (time-based; does not damage structure HP) ---
export const CAPTURE_DURATION_MIN_SEC = 5;
export const CAPTURE_DURATION_MAX_SEC = 10;
/** HQ (2000) = longest capture; lowest building HP maps near min duration */
export const CAPTURE_HP_REF_FOR_DURATION = 2000;
/**
 * Min distance from building rim (see units handleAttackState: dist = centerDist − size/2)
 * at which capture still progresses. Nav-only edge distance was too tight in practice.
 */
export const ENGINEER_CAPTURE_EDGE_REACH = 10;
/** Friendly vehicles within this range get HP from idle/moving engineers; same band when following a vehicle. */
export const ENGINEER_REPAIR_RANGE = 5.5;

// --- Building Types ---
export const BUILDING_TYPES = {
  hq: {
    name: 'HQ',
    cost: 0,
    buildTime: 0,
    hp: 2000,
    visionRange: 20,
    size: 6,       // 6x6 footprint
    producesUnits: [], // Removed engineer (moved to Barracks)
    isHQ: true,
  },
  barracks: {
    name: 'Barracks',
    cost: 300,
    buildTime: 8,
    hp: 600,
    visionRange: 12,
    size: 4,
    producesUnits: BARRACKS_UNITS,
  },
  warFactory: {
    name: 'War Factory',
    cost: 600,
    buildTime: 12,
    hp: 1000,
    visionRange: 12,
    size: 5,
    producesUnits: FACTORY_UNITS,
  },
  refinery: {
    name: 'Refinery',
    cost: 500,
    buildTime: 8,
    hp: 800,
    visionRange: 12,
    size: 4,
    producesUnits: ['harvester'],
    freeUnit: 'harvester', // Comes with 1 free harvester
  },
};

// Building placement radius from HQ
export const BUILD_RADIUS_FROM_HQ = 35;

// --- Pathfinding ---
export const NAV_MESH_RESOLUTION = 40; // Subdivisions for nav mesh plane
export const OBSTACLE_BUFFER = 2;      // Buffer around obstacles for nav mesh

// --- Fog of War ---
export const FOG_GRID_SIZE = 20; // 20x20 grid over 200x200 map = 10 units per cell
export const FOG_CELL_SIZE = MAP_SIZE / FOG_GRID_SIZE;

// --- Spatial Grid ---
export const SPATIAL_CELL_SIZE = 15;

// --- Rendering ---
// Harvesters (4 players × refineries × queues) blow past small pools — overflow = invisible mesh but selection rings still draw.
export const MAX_INSTANCES_PER_TYPE = 200; // Per unit-type InstancedMesh (THREE hard limit is buffer size; keep reasonable for mobile/VR)
export const MAX_BUILDING_INSTANCES = 16; // Per building type
export const MAX_PROJECTILES = 60;
export const MAX_PARTICLES = 200;
export const HEALTH_BAR_WIDTH = 1.2;
export const HEALTH_BAR_HEIGHT = 0.15;
export const HEALTH_BAR_Y_OFFSET = 2.2;

// --- Combat ---
export const UNIT_SEPARATION_RADIUS = 2.0; 
export const FORMATION_SPACING = 4.5; // Spread out to avoid being sniped in lines

// --- Bot AI (fair: no fog/vision/economy cheats — scale these down for easier bots) ---
export const BOT_TICK_RATE = 4.0;              // Decision cadence (humans can click faster; tune down to soften)
export const BOT_SCOUT_DELAY = 12;
export const BOT_SCOUT_DELAY_ECON = 3;       // When no known ore, start scouting almost immediately
export const BOT_ATTACK_THRESHOLD = 5;         // Earlier main strikes when reserves allow
export const BOT_FULL_ATTACK_THRESHOLD = 16;   // Larger late-game pushes
export const BOT_STRIKE_RESERVE_MULT = 0.28;    // Portion of army held back; lower = more aggressive attack
export const BOT_MAX_PRODUCTION_QUEUE = 5;     // Deep queues (same as player could fill manually)
export const BOT_FOCUS_FIRE_INTERVAL = 0.28;   // Fair micro: retarget to same fragile visible enemy
export const BOT_SCOUT_CAP = 3;
export const BOT_SCOUT_CAP_ECON = 7;           // Parallel scouts when economy must find new fields
export const BOT_SCOUT_GAP_ECON = 0.45;        // Seconds between scout spawns in econ crisis
export const BOT_SCOUT_REPATH_SEC = 3.5;       // Re-issue move if scout goes idle off-route
export const BOT_SCOUT_ARRIVE_RADIUS = 11;     // World units: reached waypoint → pick next fog target
export const BOT_SCOUT_DANGER_WEIGHT = 520;    // Higher = avoid last-seen enemies & death zones more
export const BOT_SCOUT_DANGER_ZONE_TTL = 140;  // Seconds to treat a death location as hazardous
export const BOT_ECON_EXPAND_CREDITS = 1100;   // Expand sooner when fields are known
export const BOT_STOP_HARVESTER_AT_POP = 20;   // Reserve pop for military sooner
export const BOT_SECOND_WARFACTORY_CREDITS = 1150;
export const BOT_RETALIATION_ENEMY_MULT = 1.25; // Required locals vs logged enemy strength
export const BOT_DEFEND_RADIUS = 30;
export const BOT_DEFENSE_RELEASE_SCOUT_DIST = 44; // HQ→threat: farther than this, keep scouts on exploration
export const BOT_HARVESTER_EXPLORE_PER_TICK = 6;
export const BOT_HARVESTER_EXPLORE_THROTTLE_SEC = 2.2;
export const BOT_EXPLORE_MIN_SEP = 22;           // Min distance between parallel explore targets (world units)
export const BOT_EXPLORE_RESERVE_SEC = 32;       // Reserve a fog cell so other units pick elsewhere
export const BOT_EXPLORE_SECTORS = 10;            // Angular buckets from HQ for spreading directions
/** Bot harvesters: avoid fields / flee when this many world units show visible combat enemies */
export const BOT_FIELD_ENEMY_CHECK_RADIUS = 24;
/** Added to dist² when scoring fields — steers bots away from camped nodes (fair: visible only) */
export const BOT_FIELD_THREAT_SCORE_SQ = 95000;
export const BOT_HARVESTER_FLEE_ENEMY_RADIUS = 18;
export const BOT_HARVESTER_ESCORT_RADIUS = 28;
export const BOT_HARVESTER_ESCORT_MAX_UNITS = 12;
export const BOT_HARVESTER_ESCORT_COOLDOWN = 0.55;
export const BOT_BASE_VEHICLE_THREAT_RADIUS = 56;
export const BOT_HARVESTER_VEHICLE_THREAT_RADIUS = 42;
export const BOT_RETALIATION_FLANK_DIST = 28;
export const BOT_HARASS_COOLDOWN_SEC = 75;
export const BOT_SCOUT_MISSION_MAX_SEC = 95;
export const BOT_MIN_HARVESTERS_BEFORE_SACRIFICE = 2;
export const BOT_HARVESTER_PER_REFINERY_TARGET = 7;

// --- Networking ---
export const NET_SNAPSHOT_RATE = 10;     // Snapshots per second (10Hz)
export const NET_INTERPOLATION_DELAY = 100; // ms delay for smooth interpolation
export const NET_CLIENT_CMD_TIMEOUT_MS = 8000; // Ack wait for multiplayer client commands

// --- Audio ---
// - burst-128424 = rockets / energy
// - ps-084 = artillery shell
// - impact-cinematic-boom = tank fire + explosions (deaths)
// - laser = sniper + capture progress (non-metal cues)
// - submarine sonar = building construction complete + unit production ready
// - metal-hit-* reserved for future real armor/ricochet hits only (not wired for capture/build)
export const AUDIO_BASE_PATH = './audio/';
export const SOUND_EFFECTS = {
  rifleShot:   'blaster-shot-229313.mp3',
  rocketShot:  'burst-128424-shorter.mp3',
  sniperShot:  'laser-45816.mp3',
  tankShot:    'impact-cinematic-boom-5-352465.mp3',
  artilleryShot: 'sound-design-elements-impact-sfx-ps-084-353199.mp3',
  explosion:   'impact-cinematic-boom-5-352465.mp3',
  buildComplete: 'submarine-sonar-38243-once.mp3',
  unitReady:   'submarine-sonar-38243-once.mp3',
  /** Engineer capture pulse (same file as sniper/laser; separate pool + throttle). */
  captureTick: 'laser-45816.mp3',
  /** Soft HUD / touch tick — not production sonar (unitReady). */
  uiTick:      'blaster-shot-229313.mp3',
};

// --- Unit Geometries (shape definitions for renderer) ---
export const UNIT_SHAPES = {
  rifleman:      { type: 'cylinder', radiusTop: 0.3, radiusBottom: 0.4, height: 1.6 },
  rocketSoldier: { type: 'cylinder', radiusTop: 0.35, radiusBottom: 0.4, height: 1.6 },
  sniper:        { type: 'cylinder', radiusTop: 0.2,  radiusBottom: 0.3, height: 1.8 },
  engineer:      { type: 'cylinder', radiusTop: 0.35, radiusBottom: 0.45, height: 1.4 },
  scoutBike:     { type: 'box', width: 0.8, height: 0.6, depth: 1.8 },
  apc:           { type: 'box', width: 1.4, height: 0.9, depth: 2.0 },
  lightTank:     { type: 'box', width: 1.4, height: 1.0, depth: 1.8 },
  heavyTank:     { type: 'box', width: 2.34, height: 1.56, depth: 2.86 },
  artillery:     { type: 'box', width: 1.56, height: 1.04, depth: 3.64 },
  harvester:     { type: 'box', width: 1.6, height: 1.0, depth: 2.0 },
  mobileHq:      { type: 'box', width: 1.8, height: 1.15, depth: 2.4 },
};

export const BUILDING_SHAPES = {
  hq:         { width: 6, height: 4, depth: 6 },
  barracks:   { width: 4, height: 2.5, depth: 4 },
  warFactory: { width: 5, height: 3, depth: 5 },
  refinery:   { width: 4, height: 3, depth: 4 },
};

// Colors for building types (darker tint + player color accent)
export const BUILDING_BASE_COLORS = {
  hq:         0x666666,
  barracks:   0x556644,
  warFactory: 0x555566,
  refinery:   0x665544,
};
