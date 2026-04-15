// ========================================
// RTSVR2 — Resource System
// Resource fields, harvesters, income
// ========================================

import {
  HARVEST_AMOUNT, HARVEST_TIME, DEPOSIT_TIME,
  BOT_FIELD_ENEMY_CHECK_RADIUS, BOT_FIELD_THREAT_SCORE_SQ, BOT_HARVESTER_FLEE_ENEMY_RADIUS,
} from './config.js';
import * as State from './state.js';
import * as Pathfinding from './pathfinding.js';
import * as Fog from './fog.js';
import { unitGrid } from './spatial.js';

// --- Harvester state machine ---
// States: idle -> movingToField -> harvesting -> movingToRefinery -> depositing -> (repeat)

export function updateHarvesters(dt) {
  State.units.forEach(unit => {
    if (unit.hp <= 0 || unit.type !== 'harvester') return;

    switch (unit.state) {
      case 'idle':
        assignHarvesterTask(unit);
        break;

      case 'movingToField':
        moveToField(unit, dt);
        break;

      case 'harvesting':
        harvest(unit, dt);
        break;

      case 'movingToRefinery':
        moveToRefinery(unit, dt);
        break;

      case 'depositing':
        deposit(unit, dt);
        break;

      case 'moving':
        // Player commanded move — don't override
        break;

      default:
        if (!unit.playerCommanded) {
          unit.state = 'idle';
        }
        break;
    }
  });
}

function fieldHasVisibleCombatThreat(field, team) {
  return unitGrid.queryRadiusFiltered(field.x, field.z, BOT_FIELD_ENEMY_CHECK_RADIUS, e =>
    e.team !== team && e.hp > 0 && e.damage > 0 && Fog.isVisibleToTeam(team, e.x, e.z)
  ).length > 0;
}

function botHarvesterSeesCombatEnemy(unit) {
  const p = State.players[unit.ownerId];
  if (!p?.isBot || unit.playerCommanded) return false;
  return unitGrid.queryRadiusFiltered(unit.x, unit.z, BOT_HARVESTER_FLEE_ENEMY_RADIUS, e =>
    e.team !== p.team && e.hp > 0 && e.damage > 0 && Fog.isVisibleToTeam(p.team, e.x, e.z)
  ).length > 0;
}

function isFieldTempBlockedForBotHarvester(unit, fieldId) {
  const t = unit._botFieldBlockUntil?.[fieldId];
  return t != null && State.gameSession.elapsedTime < t;
}

/** Pick known field with best (distance² + threat penalty); visible enemies only. */
function findBestResourceFieldForBot(unit) {
  const player = State.players[unit.ownerId];
  if (!player) return null;
  const team = player.team;
  let best = null;
  let bestScore = Infinity;
  const R = BOT_FIELD_ENEMY_CHECK_RADIUS;

  State.resourceFields.forEach(field => {
    if (field.depleted) return;
    if (isFieldTempBlockedForBotHarvester(unit, field.id)) return;
    if (!Fog.wasExploredByTeam(team, field.x, field.z)) return;
    const distSq = Pathfinding.getDistanceSq(unit.x, unit.z, field.x, field.z);
    let threat = 0;
    unitGrid.queryRadiusFiltered(field.x, field.z, R, e =>
      e.team !== team && e.hp > 0 && e.damage > 0 && Fog.isVisibleToTeam(team, e.x, e.z)
    ).forEach(() => {
      threat += BOT_FIELD_THREAT_SCORE_SQ;
    });
    const score = distSq + threat;
    if (score < bestScore) {
      bestScore = score;
      best = field;
    }
  });

  return best || findNearestResourceField(unit);
}

function assignHarvesterTask(unit) {
  // If player commanded move, don't auto-assign
  if (unit.playerCommanded) return;

  const player = State.players[unit.ownerId];
  if (!player) return;

  // Find nearest refinery owned by same player
  const refinery = findNearestRefinery(unit);
  if (!refinery) return; // No refinery - stay idle

  let field = null;
  if (unit.lastHarvestedField) {
    const prevField = State.resourceFields.get(unit.lastHarvestedField);
    if (prevField && !prevField.depleted) {
      const blocked = player.isBot && isFieldTempBlockedForBotHarvester(unit, prevField.id);
      const hot = player.isBot && fieldHasVisibleCombatThreat(prevField, player.team);
      if (!blocked && !hot) {
        field = prevField;
      } else {
        unit.lastHarvestedField = null;
      }
    }
  }

  // If no previous field or it's depleted, find nearest resource field with resources
  if (!field) {
    field = player.isBot ? findBestResourceFieldForBot(unit) : findNearestResourceField(unit);
  }
  
  if (!field) return; // No resources - stay idle

  unit.assignedRefinery = refinery.id;
  unit.assignedField = field.id;
  unit.state = 'movingToField';
  unit.targetPos = { x: field.x, z: field.z };
  unit.path = null;
}

function moveToField(unit, dt) {
  const field = State.resourceFields.get(unit.assignedField);
  if (!field || field.depleted) {
    // Find new field
    unit.assignedField = null;
    unit.state = 'idle';
    return;
  }

  if (botHarvesterSeesCombatEnemy(unit)) {
    if (unit.assignedField) {
      if (!unit._botFieldBlockUntil) unit._botFieldBlockUntil = {};
      unit._botFieldBlockUntil[unit.assignedField] = State.gameSession.elapsedTime + 12;
    }
    unit.assignedField = null;
    unit.lastHarvestedField = null;
    unit.state = 'idle';
    unit.targetPos = null;
    unit.path = null;
    return;
  }

  // Check if arrived at field (increased radius to allow multi-harvester grouping)
  const dist = Pathfinding.getDistance(unit.x, unit.z, field.x, field.z);
  if (dist < 12) {
    unit.state = 'harvesting';
    unit.targetPos = null;
    unit.path = null;
    unit._harvestTimer = 0;
    return;
  }

  // Continue moving (movement handled by main movement system)
  if (!unit.targetPos) {
    unit.targetPos = { x: field.x, z: field.z };
    unit.path = null;
  }

  // Use main movement system
  moveAlongPathSimple(unit, dt);
}

function harvest(unit, dt) {
  const field = State.resourceFields.get(unit.assignedField);
  if (!field || field.depleted) {
    unit.state = 'idle';
    unit.assignedField = null;
    return;
  }

  if (botHarvesterSeesCombatEnemy(unit)) {
    if (unit.assignedField) {
      if (!unit._botFieldBlockUntil) unit._botFieldBlockUntil = {};
      unit._botFieldBlockUntil[unit.assignedField] = State.gameSession.elapsedTime + 12;
    }
    unit.assignedField = null;
    unit.lastHarvestedField = null;
    unit.state = 'idle';
    unit.targetPos = null;
    unit.path = null;
    unit._harvestTimer = 0;
    return;
  }

  unit._harvestTimer = (unit._harvestTimer || 0) + dt;

  if (unit._harvestTimer >= HARVEST_TIME) {
    // Collect resources
    const amount = Math.min(HARVEST_AMOUNT, field.remaining);
    field.remaining -= amount;
    unit.cargo = amount;
    unit.lastHarvestedField = field.id;

    if (field.remaining <= 0) {
      field.depleted = true;
      field.remaining = 0;
      console.log(`⛏️ Resource field ${field.id} depleted`);
    }

    // Head back to refinery
    unit.state = 'movingToRefinery';
    const refinery = State.buildings.get(unit.assignedRefinery);
    if (refinery && refinery.hp > 0) {
      unit.targetPos = { x: refinery.x, z: refinery.z };
    } else {
      // Find new refinery
      const newRef = findNearestRefinery(unit);
      if (newRef) {
        unit.assignedRefinery = newRef.id;
        unit.targetPos = { x: newRef.x, z: newRef.z };
      } else {
        unit.state = 'idle';
      }
    }
    unit.path = null;
    unit._harvestTimer = 0;
  }
}

function moveToRefinery(unit, dt) {
  const refinery = State.buildings.get(unit.assignedRefinery);
  if (!refinery || refinery.hp <= 0) {
    // Find new refinery
    const newRef = findNearestRefinery(unit);
    if (newRef) {
      unit.assignedRefinery = newRef.id;
      unit.targetPos = { x: newRef.x, z: newRef.z };
      unit.path = null;
    } else {
      unit.state = 'idle';
    }
    return;
  }

  const dist = Pathfinding.getDistance(unit.x, unit.z, refinery.x, refinery.z);
  if (dist < 12) {
    unit.state = 'depositing';
    unit.targetPos = null;
    unit.path = null;
    unit._depositTimer = 0;
    return;
  }

  if (!unit.targetPos) {
    unit.targetPos = { x: refinery.x, z: refinery.z };
    unit.path = null;
  }

  moveAlongPathSimple(unit, dt);
}

function deposit(unit, dt) {
  unit._depositTimer = (unit._depositTimer || 0) + dt;

  if (unit._depositTimer >= DEPOSIT_TIME) {
    // Deposit cargo
    const player = State.players[unit.ownerId];
    if (player && unit.cargo > 0) {
      player.credits += unit.cargo;
      if (player.stats) player.stats.creditsEarned += unit.cargo;
      unit.cargo = 0;
    }

    // Go back for more
    unit._depositTimer = 0;
    unit.state = 'idle'; // Will auto-assign in next tick
  }
}

// --- Simple movement for harvesters ---
function moveAlongPathSimple(unit, dt) {
  if (!unit.path || unit.path.length === 0 || unit.pathIndex >= unit.path.length) {
    if (!unit.targetPos) return;
    const path = Pathfinding.findPath(unit.x, unit.z, unit.targetPos.x, unit.targetPos.z);
    
    // If we've reached the closest point to destination but can't proceed,
    // explicitly try to transition to the required action state instead of just aborting to idle and losing our action sequence.
    if (!path || path.length === 0) {
      if (unit.state === 'movingToRefinery') {
        unit.state = 'depositing';
      } else if (unit.state === 'movingToField') {
        unit.state = 'harvesting';
      } else {
        unit.state = 'idle';
      }
      unit.targetPos = null;
      unit._harvestTimer = 0;
      unit._depositTimer = 0;
      return;
    }
    unit.path = path;
    unit.pathIndex = 0;
  }

  const wp = unit.path[unit.pathIndex];
  const dx = wp.x - unit.x;
  const dz = wp.z - unit.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist < 1.0) {
    unit.pathIndex++;
    return;
  }

  const moveSpeed = unit.speed * dt;
  const ratio = Math.min(1, moveSpeed / dist);
  unit.x += dx * ratio;
  unit.z += dz * ratio;

  if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
    unit.rotation = Math.atan2(dx, dz);
  }
}

// --- Helpers ---
function findNearestRefinery(unit) {
  const playerBuildings = State.getPlayerBuildingsOfType(unit.ownerId, 'refinery');
  if (playerBuildings.length === 0) return null;

  let nearest = null;
  let minDist = Infinity;

  playerBuildings.forEach(b => {
    if (b.hp <= 0) return;
    const dist = Pathfinding.getDistanceSq(unit.x, unit.z, b.x, b.z);
    if (dist < minDist) {
      minDist = dist;
      nearest = b;
    }
  });

  return nearest;
}

function findNearestResourceField(unit) {
  let nearest = null;
  let minDist = Infinity;
  const player = State.players[unit.ownerId];
  if (!player) return null;

  State.resourceFields.forEach(field => {
    if (field.depleted) return;

    // Fog of war check: Harvester only "knows" about fields seen by their team
    if (!Fog.wasExploredByTeam(player.team, field.x, field.z)) return;

    const dist = Pathfinding.getDistanceSq(unit.x, unit.z, field.x, field.z);
    if (dist < minDist) {
      minDist = dist;
      nearest = field;
    }
  });

  return nearest;
}
