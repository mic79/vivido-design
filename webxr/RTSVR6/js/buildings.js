// ========================================
// RTSVR4 — Building System
// Placement, construction, production queues
// ========================================

import {
  BUILDING_TYPES, UNIT_TYPES, BUILD_RADIUS_FROM_HQ, BUILDING_SHAPES,
  BUILDING_UNLOCK_REQUIRES, HQ_BUILD_MENU_TYPES, LOW_POWER_RATE,
  DEFENSE_TURN_RATE, DEFENSE_AIM_FIRE_TOL, getSolarPanelYaw,
  isWorldInsidePlayableDisk,
} from './config.js';
import * as State from './state.js';
import * as Pathfinding from './pathfinding.js';
import * as Units from './units.js';
import * as Resources from './resources.js';
import * as Audio from './audio.js';
import * as Fog from './fog.js';
import { unitGrid } from './spatial.js';

export { HQ_BUILD_MENU_TYPES };

/** True if owner has at least one completed, living building of `type`. */
export function playerHasBuiltType(ownerId, type) {
  return State.getPlayerBuildings(ownerId).some(
    b => b.type === type && b.isBuilt && b.hp > 0
  );
}

/** Tech-tree gate for HQ construction menu / placement. */
export function isBuildingTypeUnlocked(type, ownerId) {
  if (type === 'hq') return true;
  if (!(type in BUILDING_UNLOCK_REQUIRES)) return true;
  const req = BUILDING_UNLOCK_REQUIRES[type];
  if (req == null) return true;
  return playerHasBuiltType(ownerId, req);
}

/**
 * Power produced / consumed by completed buildings.
 * @returns {{ produce: number, consume: number, surplus: number }}
 */
export function getPlayerPower(ownerId) {
  let produce = 0;
  let consume = 0;
  State.getPlayerBuildings(ownerId).forEach(b => {
    if (!b.isBuilt || b.hp <= 0) return;
    const s = BUILDING_TYPES[b.type];
    if (!s) return;
    produce += s.powerProduce || 0;
    consume += s.powerConsume || 0;
  });
  return { produce, consume, surplus: produce - consume };
}

/** 1 when powered, `LOW_POWER_RATE` when surplus &lt; 0. */
export function getPowerRateFactor(ownerId) {
  return getPlayerPower(ownerId).surplus < 0 ? LOW_POWER_RATE : 1;
}

export function getBuildingUnlockFailureCode(type, ownerId) {
  if (!isBuildingTypeUnlocked(type, ownerId)) return 'tech_locked';
  return null;
}

// --- Building creation ---
// options.id: authoritative id (snapshots); skipNavRebuild: batch apply (rebuild once after)
// options.team: authoritative team (multiplayer client; host player.team may be lobby-default)
// options.spawnComplete: lobby / showcase — start fully built (no construction tick, no free-unit onComplete).
export function createBuilding(type, ownerId, x, z, options = {}) {
  const stats = BUILDING_TYPES[type];
  if (!stats) {
    console.error(`Unknown building type: ${type}`);
    return null;
  }

  const player = State.players[ownerId];
  if (!player) return null;

  const id = options.id != null ? options.id : State.generateId('bldg');
  let initialRotation = 0;
  if (typeof options.rotation === 'number' && Number.isFinite(options.rotation)) {
    initialRotation = options.rotation;
  } else if (type === 'solarPanel') {
    initialRotation = getSolarPanelYaw();
  }
  const building = {
    id,
    type,
    ownerId,
    team: options.team != null ? options.team : player.team,
    x, z,
    rotation: initialRotation,
    hp: stats.hp,
    maxHp: stats.hp,
    size: stats.size || 4,
    visionRange: stats.visionRange || 12,
    constructionProgress: type === 'hq' || options.spawnComplete ? 1 : 0,
    constructionTime: stats.buildTime,
    isBuilt: type === 'hq' || !!options.spawnComplete,

    // Production queue
    productionQueue: [],  // Array of { unitType, remainingTime, totalTime }
    rallyPoint: { x: x, z: z + stats.size + 2 }, // Default rally behind building

    // Capture (engineer) — 0..1 progress, does not change hp
    captureProgress: 0,

    // Defense turrets (copied from BUILDING_TYPES when armed)
    damage: stats.damage || 0,
    range: stats.range || 0,
    cooldown: stats.cooldown || 1,
    aoe: stats.aoe || 0,
    dmgVsInfantry: stats.dmgVsInfantry ?? 1,
    dmgVsVehicle: stats.dmgVsVehicle ?? 1,
    dmgVsBuilding: stats.dmgVsBuilding ?? 1,
    lastFireTime: 0,

    // Rendering
    _renderIndex: -1,
    _renderVisible: false,
  };

  State.addBuilding(building);

  if (type !== 'hq' && !options.skipNavRebuild) {
    Pathfinding.rebuildNavMesh();
  }

  return building;
}

// --- Place HQ at spawn ---
export function placeHQ(ownerId) {
  const player = State.players[ownerId];
  if (!player) return null;

  const hq = createBuilding('hq', ownerId, player.spawn.x, player.spawn.z);
  if (hq) {
    // Set rally point in front of HQ (toward center of map)
    const dirX = -Math.sign(player.spawn.x) || 1;
    const dirZ = -Math.sign(player.spawn.z) || 1;
    hq.rallyPoint = { x: player.spawn.x + dirX * 10, z: player.spawn.z + dirZ * 10 };
  }
  return hq;
}

// --- Building placement validation ---
/**
 * @param {{ skipCredits?: boolean, skipHqRangeCheck?: boolean, skipTechCheck?: boolean, skipPowerCheck?: boolean }} [opts]
 * @returns {string|null}
 */
function getPlaceBuildingFailureCodeInternal(type, ownerId, x, z, opts = {}) {
  const stats = BUILDING_TYPES[type];
  if (!stats) return 'unknown_building';

  const player = State.players[ownerId];
  if (!player) return 'no_player';

  if (!opts.skipCredits && player.credits < stats.cost) return 'no_credits';

  if (!opts.skipTechCheck) {
    const techFail = getBuildingUnlockFailureCode(type, ownerId);
    if (techFail) return techFail;
  }

  if (!opts.skipPowerCheck) {
    const need = stats.powerConsume || 0;
    if (need > 0) {
      const pow = getPlayerPower(ownerId);
      if (pow.produce < pow.consume + need) return 'no_power';
    }
  }

  if (!opts.skipHqRangeCheck) {
    const hqs = State.getPlayerBuildings(ownerId).filter(b => b.type === 'hq' && b.hp > 0);
    if (hqs.length === 0) return 'no_hq';
    let minDist = Infinity;
    for (let i = 0; i < hqs.length; i++) {
      const d = Pathfinding.getDistance(x, z, hqs[i].x, hqs[i].z);
      if (d < minDist) minDist = d;
    }
    if (minDist > BUILD_RADIUS_FROM_HQ) return 'too_far_from_hq';
  }

  const halfSize = (stats.size || 4) / 2 + 1;
  let blocksBuilding = false;
  State.buildings.forEach(b => {
    if (b.hp <= 0) return;
    const bHalf = (b.size || 4) / 2 + 1;
    if (Math.abs(x - b.x) < halfSize + bHalf && Math.abs(z - b.z) < halfSize + bHalf) {
      blocksBuilding = true;
    }
  });
  if (blocksBuilding) return 'overlap_building';

  let onResource = false;
  State.resourceFields.forEach(field => {
    if (Math.abs(x - field.x) < halfSize + 3 && Math.abs(z - field.z) < halfSize + 3) {
      onResource = true;
    }
  });
  if (onResource) return 'on_resource';

  if (!isWorldInsidePlayableDisk(x, z, 8)) return 'out_of_bounds';

  return null;
}

/** @returns {string|null} failure code, or null if placement is allowed */
export function getPlaceBuildingFailureCode(type, ownerId, x, z) {
  return getPlaceBuildingFailureCodeInternal(type, ownerId, x, z, {});
}

/** Mobile HQ deploy: footprint only (no credit check, no distance-from-HQ rule). */
export function getMobileHqDeployFailureCode(ownerId, x, z) {
  return getPlaceBuildingFailureCodeInternal('hq', ownerId, x, z, {
    skipCredits: true,
    skipHqRangeCheck: true,
    skipTechCheck: true,
    skipPowerCheck: true,
  });
}

/**
 * Converts a Mobile HQ unit into a built HQ at its position (host-authoritative).
 * @returns {boolean}
 */
export function tryDeployMobileHq(unit) {
  if (!unit || unit.type !== 'mobileHq' || unit.hp <= 0) return false;
  if (getMobileHqDeployFailureCode(unit.ownerId, unit.x, unit.z) !== null) return false;

  const ownerId = unit.ownerId;
  const x = unit.x;
  const z = unit.z;

  State.selectedUnits.delete(unit.id);
  State.removeUnit(unit.id);

  const building = createBuilding('hq', ownerId, x, z);
  if (!building) return false;

  const player = State.players[ownerId];
  if (player && player.stats) player.stats.buildingsBuilt++;

  Pathfinding.rebuildNavMesh();
  Audio.playBuildCompleteSound(x, z);
  State.pushHostFx({ kind: 'build_complete', x, z });
  console.log(`🏕️ P${ownerId} deployed Mobile HQ → HQ at (${x.toFixed(0)}, ${z.toFixed(0)})`);
  return true;
}

export function canPlaceBuilding(type, ownerId, x, z) {
  return getPlaceBuildingFailureCode(type, ownerId, x, z) === null;
}

// --- Place building (deduct cost) ---
export function placeBuilding(type, ownerId, x, z) {
  if (getPlaceBuildingFailureCode(type, ownerId, x, z) !== null) return null;

  const stats = BUILDING_TYPES[type];
  const player = State.players[ownerId];

  player.credits -= stats.cost;
  const building = createBuilding(type, ownerId, x, z);

  if (building) {
    console.log(`🏗️ P${ownerId} placed ${stats.name} at (${x.toFixed(0)}, ${z.toFixed(0)})`);
  }

  return building;
}

// --- Construction progress ---
export function updateConstruction(dt) {
  State.buildings.forEach(building => {
    if (building.hp <= 0) return;
    if (building.isBuilt || building.constructionProgress >= 1) return;

    const rate = getPowerRateFactor(building.ownerId);
    building.constructionProgress += (dt * rate) / building.constructionTime;

    const player = State.players[building.ownerId];
    if (building.constructionProgress >= 1) {
      building.constructionProgress = 1;
      building.isBuilt = true;
      if (player && player.stats) player.stats.buildingsBuilt++;
      Audio.playBuildCompleteSound(building.x, building.z);
      State.pushHostFx({ kind: 'build_complete', x: building.x, z: building.z });
      console.log(`✅ Building ${building.type} complete for P${building.ownerId}`);

      // Spawn free unit if applicable (e.g., Refinery comes with free Harvester)
      const stats = BUILDING_TYPES[building.type];
      if (stats.freeUnit) {
        const spawnPos = getSpawnPosition(building);
        const free = Units.createUnit(stats.freeUnit, building.ownerId, spawnPos.x, spawnPos.z);
        stampUnitHomeBase(free, building);
      }
    }
  });
}

// --- Production queue ---
/** @returns {string|null} failure code, or null if queuing is allowed (no side effects) */
export function getQueueUnitFailureCode(buildingId, unitType) {
  const building = State.buildings.get(buildingId);
  if (!building || building.hp <= 0) return 'invalid_building';
  if (!building.isBuilt) return 'not_constructed';

  const bStats = BUILDING_TYPES[building.type];
  if (!bStats || !bStats.producesUnits.includes(unitType)) return 'cant_produce_here';

  const uStats = UNIT_TYPES[unitType];
  if (!uStats) return 'invalid_unit_type';

  const player = State.players[building.ownerId];
  if (!player) return 'invalid_building';

  if (player.credits < uStats.cost) return 'no_credits';
  if (player.unitCount >= player.unitCap) return 'unit_cap';

  return null;
}

export function queueUnit(buildingId, unitType) {
  if (getQueueUnitFailureCode(buildingId, unitType) !== null) return false;

  const building = State.buildings.get(buildingId);
  const uStats = UNIT_TYPES[unitType];
  const player = State.players[building.ownerId];

  player.credits -= uStats.cost;

  building.productionQueue.push({
    unitType,
    remainingTime: uStats.buildTime,
    totalTime: uStats.buildTime,
    /** Host sim time when this row was queued — MP clients can derive progress from `elapsedTime`. */
    startedAtElapsed: State.gameSession.elapsedTime,
  });

  return true;
}

/** @returns {string|null} failure code, or null if cancel is allowed (no side effects) */
export function getCancelUnitFailureCode(buildingId, unitType) {
  const building = State.buildings.get(buildingId);
  if (!building || building.hp <= 0 || !building.isBuilt) return 'invalid_building';

  const player = State.players[building.ownerId];
  if (!player) return 'invalid_building';

  for (let i = building.productionQueue.length - 1; i >= 0; i--) {
    if (building.productionQueue[i].unitType === unitType) return null;
  }

  return 'not_in_queue';
}

export function cancelUnit(buildingId, unitType) {
  if (getCancelUnitFailureCode(buildingId, unitType) !== null) return false;

  const building = State.buildings.get(buildingId);
  const player = State.players[building.ownerId];

  for (let i = building.productionQueue.length - 1; i >= 0; i--) {
    if (building.productionQueue[i].unitType === unitType) {
      building.productionQueue.splice(i, 1);

      const uStats = UNIT_TYPES[unitType];
      if (uStats) player.credits += uStats.cost;
      return true;
    }
  }

  return false;
}

export function updateProduction(dt) {
  State.buildings.forEach(building => {
    if (building.hp <= 0 || !building.isBuilt) return;
    if (building.productionQueue.length === 0) return;

    const current = building.productionQueue[0];
    const rate = getPowerRateFactor(building.ownerId);
    current.remainingTime -= dt * rate;

    if (current.remainingTime <= 0) {
      // Unit complete - spawn at rally point
      building.productionQueue.shift();
      const spawnPos = getSpawnPosition(building);
      const unit = Units.createUnit(current.unitType, building.ownerId, spawnPos.x, spawnPos.z);

      if (unit) {
        stampUnitHomeBase(unit, building);
        // Move to rally point
        const rally = building.rallyPoint;
        if (rally && (Math.abs(rally.x - spawnPos.x) > 2 || Math.abs(rally.z - spawnPos.z) > 2)) {
          Units.commandMove([unit.id], rally.x, rally.z, { playerCommanded: false });
        }
        Audio.playUnitReadySound(spawnPos.x, spawnPos.z);
        State.pushHostFx({ kind: 'unit_ready', x: spawnPos.x, z: spawnPos.z });
      }
    }
  });
}

function getSpawnPosition(building) {
  const shape = BUILDING_SHAPES[building.type];
  const offset = (shape?.depth || 4) / 2 + 2;
  const rawX = building.x + (Math.random() - 0.5) * 4;
  const rawZ = building.z + offset;
  const safe = Pathfinding.snapOutOfObstacle(rawX, rawZ);
  return { x: safe.x, z: safe.z };
}

/** Shortest signed yaw delta in (−π, π]. */
function yawDelta(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Slew `building.rotation` toward `targetYaw` by at most `DEFENSE_TURN_RATE * dt`. */
function turnBuildingToward(building, targetYaw, dt) {
  const maxStep = DEFENSE_TURN_RATE * Math.max(0, dt);
  const d = yawDelta(building.rotation || 0, targetYaw);
  if (Math.abs(d) <= maxStep) {
    building.rotation = targetYaw;
    return 0;
  }
  building.rotation = (building.rotation || 0) + Math.sign(d) * maxStep;
  return yawDelta(building.rotation, targetYaw);
}

/**
 * Auto-aim + fire for Turret / Artillery buildings (host sim only).
 * Tracks targets every tick; fire is gated on power, cooldown, and aim cone.
 */
export function updateDefenseBuildings(time, dt = 0) {
  State.buildings.forEach(building => {
    if (!building.isBuilt || building.hp <= 0) return;
    if (!(building.damage > 0) || !(building.range > 0)) return;

    const range = building.range;
    const visionR = building.visionRange != null ? building.visionRange : range;
    let best = null;
    let bestDist = range;

    const nearby = unitGrid.queryRadius(building.x, building.z, range);
    for (let i = 0; i < nearby.length; i++) {
      const u = nearby[i];
      if (!u || u.hp <= 0) continue;
      if (u.team === building.team || u.ownerId === building.ownerId) continue;
      const d = Pathfinding.getDistance(building.x, building.z, u.x, u.z);
      if (d > range || d >= bestDist) continue;
      if (d > visionR + 0.5) continue;
      if (!Fog.isVisibleToTeam(building.team, u.x, u.z)) continue;
      bestDist = d;
      best = u;
    }

    if (!best) {
      State.buildings.forEach(b => {
        if (b.hp <= 0 || !b.isBuilt) return;
        if (b.id === building.id) return;
        if (b.team === building.team || b.ownerId === building.ownerId) return;
        const d = Pathfinding.getDistance(building.x, building.z, b.x, b.z);
        if (d > range || d >= bestDist) return;
        if (d > visionR + 0.5) return;
        if (!Fog.isVisibleToTeam(building.team, b.x, b.z)) return;
        bestDist = d;
        best = b;
      });
    }

    if (!best) return;

    const aimYaw = Math.atan2(best.x - building.x, best.z - building.z);
    const remaining = turnBuildingToward(building, aimYaw, dt);

    if (getPlayerPower(building.ownerId).surplus < 0) return;
    if (Math.abs(remaining) > DEFENSE_AIM_FIRE_TOL) return;

    // Cooldown is stored in seconds; `time` is performance.now() ms (same as unit fireRate*1000).
    const cdMs = (building.cooldown > 0 ? building.cooldown : 1) * 1000;
    if (time - (building.lastFireTime || 0) < cdMs) return;

    Units.fireAtTarget(building, best, time);
  });
}

/** Tag produced units to this structure's base so Story defense stays local. */
function stampUnitHomeBase(unit, building) {
  if (!unit || !building) return;
  if (building.homeBasePos) {
    unit.homeBasePos = { x: building.homeBasePos.x, z: building.homeBasePos.z };
    return;
  }
  // Use the producing building itself — never inherit the primary HQ across the map.
  unit.homeBasePos = { x: building.x, z: building.z };
}

// --- Income ---
export function updateIncome(dt) {
  State.players.forEach(player => {
    if (player.isDefeated) return;
    // Passive income
    const amt = player.income * dt;
    player.credits += amt;
    if (player.stats) player.stats.creditsEarned += amt;
  });
}

// --- Helper ---
export function getProductionOptions(buildingId) {
  const building = State.buildings.get(buildingId);
  if (!building || !building.isBuilt) return [];

  const bStats = BUILDING_TYPES[building.type];
  if (!bStats) return [];

  return bStats.producesUnits.map(unitType => ({
    type: unitType,
    ...UNIT_TYPES[unitType],
  }));
}

/** @returns {string|null} failure code, or null if selling is allowed (no side effects) */
export function getSellBuildingFailureCode(buildingId, actingPlayerId) {
  const building = State.buildings.get(buildingId);
  if (!building || building.hp <= 0) return 'invalid_building';
  if (building.ownerId !== actingPlayerId) return 'not_owner';
  if (building.type === 'hq') return 'cant_sell_hq';
  if (!building.isBuilt) return 'not_constructed';
  return null;
}

/**
 * Remove a player-owned structure and refund its build cost (queue entries refunded first).
 * Does not increment buildings-lost stats. Rebuilds nav mesh and runs win checks.
 * @returns {string|null} failure code, or null on success
 */
export function sellBuilding(buildingId, actingPlayerId) {
  const fail = getSellBuildingFailureCode(buildingId, actingPlayerId);
  if (fail) return fail;

  const building = State.buildings.get(buildingId);
  const player = State.players[actingPlayerId];
  const bStats = BUILDING_TYPES[building.type];
  const refund = bStats?.cost ?? 0;

  while (building.productionQueue && building.productionQueue.length > 0) {
    const last = building.productionQueue[building.productionQueue.length - 1];
    cancelUnit(buildingId, last.unitType);
  }

  Units.clearUnitsTargetingBuilding(buildingId);
  if (player) player.credits += refund;

  const bx = building.x;
  const bz = building.z;
  const wasRefinery = building.type === 'refinery';
  const ownerId = building.ownerId;
  State.removeBuilding(buildingId);
  // Immediate rebuild so harvesters can path off the old footprint / to a new refinery this frame.
  Pathfinding.rebuildNavMeshImmediate();
  if (wasRefinery) {
    Resources.reassignHarvestersAfterRefineryLost(buildingId, ownerId);
  }
  Audio.playUnitReadySound(bx, bz);
  State.pushHostFx({ kind: 'sell_complete', x: bx, z: bz });
  Units.checkWinCondition();
  return null;
}
