// ========================================
// RTSVR2 — Building System
// Placement, construction, production queues
// ========================================

import {
  BUILDING_TYPES, UNIT_TYPES, BUILD_RADIUS_FROM_HQ, BUILDING_SHAPES,
} from './config.js';
import * as State from './state.js';
import * as Pathfinding from './pathfinding.js';
import * as Units from './units.js';
import * as Audio from './audio.js';

// --- Building creation ---
// options.id: authoritative id (snapshots); skipNavRebuild: batch apply (rebuild once after)
export function createBuilding(type, ownerId, x, z, options = {}) {
  const stats = BUILDING_TYPES[type];
  if (!stats) {
    console.error(`Unknown building type: ${type}`);
    return null;
  }

  const player = State.players[ownerId];
  if (!player) return null;

  const id = options.id != null ? options.id : State.generateId('bldg');
  const building = {
    id,
    type,
    ownerId,
    team: player.team,
    x, z,
    rotation: 0,
    hp: stats.hp,
    maxHp: stats.hp,
    size: stats.size || 4,
    visionRange: stats.visionRange || 12,
    constructionProgress: type === 'hq' ? 1 : 0, // HQ starts built
    constructionTime: stats.buildTime,
    isBuilt: type === 'hq',

    // Production queue
    productionQueue: [],  // Array of { unitType, remainingTime, totalTime }
    rallyPoint: { x: x, z: z + stats.size + 2 }, // Default rally behind building

    // Capture (engineer) — 0..1 progress, does not change hp
    captureProgress: 0,

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
/** @returns {string|null} failure code, or null if placement is allowed */
export function getPlaceBuildingFailureCode(type, ownerId, x, z) {
  const stats = BUILDING_TYPES[type];
  if (!stats) return 'unknown_building';

  const player = State.players[ownerId];
  if (!player) return 'no_player';

  if (player.credits < stats.cost) return 'no_credits';

  const hq = State.getPlayerHQ(ownerId);
  if (!hq) return 'no_hq';

  const distToHQ = Pathfinding.getDistance(x, z, hq.x, hq.z);
  if (distToHQ > BUILD_RADIUS_FROM_HQ) return 'too_far_from_hq';

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

  const mapLimit = 95;
  if (Math.abs(x) > mapLimit || Math.abs(z) > mapLimit) return 'out_of_bounds';

  return null;
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

    building.constructionProgress += dt / building.constructionTime;

    const player = State.players[building.ownerId];
    if (building.constructionProgress >= 1) {
      building.constructionProgress = 1;
      building.isBuilt = true;
      if (player && player.stats) player.stats.buildingsBuilt++;
      Audio.playBuildCompleteSound();
      console.log(`✅ Building ${building.type} complete for P${building.ownerId}`);

      // Spawn free unit if applicable (e.g., Refinery comes with free Harvester)
      const stats = BUILDING_TYPES[building.type];
      if (stats.freeUnit) {
        const spawnPos = getSpawnPosition(building);
        Units.createUnit(stats.freeUnit, building.ownerId, spawnPos.x, spawnPos.z);
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
    current.remainingTime -= dt;

    if (current.remainingTime <= 0) {
      // Unit complete - spawn at rally point
      building.productionQueue.shift();
      const spawnPos = getSpawnPosition(building);
      const unit = Units.createUnit(current.unitType, building.ownerId, spawnPos.x, spawnPos.z);

      if (unit) {
        // Move to rally point
        const rally = building.rallyPoint;
        if (rally && (Math.abs(rally.x - spawnPos.x) > 2 || Math.abs(rally.z - spawnPos.z) > 2)) {
          Units.commandMove([unit.id], rally.x, rally.z);
        }
        Audio.playUnitReadySound();
      }
    }
  });
}

function getSpawnPosition(building) {
  const shape = BUILDING_SHAPES[building.type];
  const offset = (shape?.depth || 4) / 2 + 2;
  return {
    x: building.x + (Math.random() - 0.5) * 4,
    z: building.z + offset,
  };
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
