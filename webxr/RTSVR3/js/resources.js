// ========================================
// RTSVR3 — Resource System
// Resource fields, harvesters, income
// ========================================

import {
  HARVEST_AMOUNT, HARVEST_TIME, DEPOSIT_TIME,
  BOT_FIELD_ENEMY_CHECK_RADIUS, BOT_FIELD_THREAT_SCORE_SQ, BOT_HARVESTER_FLEE_ENEMY_RADIUS,
  clampWorldToPlayableDisk,
} from './config.js';
import * as State from './state.js';
import * as Pathfinding from './pathfinding.js';
import * as Fog from './fog.js';
import { unitGrid } from './spatial.js';

/** Must match `moveToField` / `moveToRefinery` arrival checks (world m). */
const HARVESTER_ARRIVE_RADIUS = 12;
/** Max distance from crystal / refinery while harvesting or depositing (arrival + drift slack). */
const HARVESTER_WORK_RADIUS = HARVESTER_ARRIVE_RADIUS + 5;
/** Crystal nav obstacle is markRect(3,3) — stand just outside it. */
const FIELD_OBSTACLE_STAND_MIN_M = 4.5;

const PATH_REQUERY_MS = 400;
const PATH_BLOCKED_STREAK_REPATH = 12;

function harvesterCanPathfind(unit) {
  return performance.now() >= (unit._pathRetryAt || 0);
}

function harvesterSchedulePathRetry(unit, ms = PATH_REQUERY_MS) {
  unit._pathRetryAt = performance.now() + ms;
}

function fieldCenterDistance(unit, field) {
  return Pathfinding.getDistance(unit.x, unit.z, field.x, field.z);
}

function canStartHarvestingAtField(unit, field) {
  return fieldCenterDistance(unit, field) < HARVESTER_ARRIVE_RADIUS;
}

/** Walkable stand point near crystal (nav grid blocks the field center). */
function findResourceFieldApproachPos(fromX, fromZ, field, rotate = 0) {
  const fx = field.x;
  const fz = field.z;
  const maxStandDist = HARVESTER_ARRIVE_RADIUS - 0.5;
  let best = null;
  let bestScore = Infinity;

  const radii = [5, 7, 9, 11];
  for (const radius of radii) {
    if (radius > maxStandDist) continue;
    const steps = 20;
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2 + rotate;
      const tx = fx + Math.cos(angle) * radius;
      const tz = fz + Math.sin(angle) * radius;
      if (!Pathfinding.isPositionWalkable(tx, tz)) continue;
      const centerDist = Pathfinding.getDistance(tx, tz, fx, fz);
      if (centerDist < FIELD_OBSTACLE_STAND_MIN_M || centerDist > maxStandDist) continue;

      const score =
        Pathfinding.getDistanceSq(fromX, fromZ, tx, tz) + centerDist * centerDist * 0.2;
      if (score < bestScore) {
        bestScore = score;
        best = { x: tx, z: tz };
      }
    }
  }

  if (best) return best;

  const reach = Pathfinding.findNearestReachable(fromX, fromZ, fx, fz, HARVESTER_ARRIVE_RADIUS + 4);
  if (reach && Pathfinding.getDistance(reach.x, reach.z, fx, fz) <= HARVESTER_WORK_RADIUS) {
    return reach;
  }

  const pushed = Pathfinding.pushOutOfObstacle(fx, fz);
  return { x: pushed.x, z: pushed.z };
}

function clearFieldApproachCache(unit) {
  unit._fieldApproachFieldId = null;
  unit._fieldApproachPos = null;
  unit._fieldApproachFails = 0;
}

function setFieldHarvestTarget(unit, field, rotateApproach = 0) {
  if (!field) return;
  if (rotateApproach !== 0 || unit._fieldApproachFieldId !== field.id || !unit._fieldApproachPos) {
    unit._fieldApproachFieldId = field.id;
    unit._fieldApproachPos = findResourceFieldApproachPos(
      unit.x,
      unit.z,
      field,
      rotateApproach
    );
    unit._fieldApproachFails = 0;
  }
  unit.targetPos = { x: unit._fieldApproachPos.x, z: unit._fieldApproachPos.z };
}

/** Direct micro-steps when A* stops short of an unwalkable crystal center. */
function harvesterCreepTowardField(unit, field, dt) {
  const fx = field.x;
  const fz = field.z;
  if (canStartHarvestingAtField(unit, field)) return true;

  const approach = unit._fieldApproachPos;
  let tx = fx;
  let tz = fz;

  if (approach) {
    const toApproach = Pathfinding.getDistance(unit.x, unit.z, approach.x, approach.z);
    if (toApproach > 0.6) {
      tx = approach.x;
      tz = approach.z;
    }
  }

  const dx = tx - unit.x;
  const dz = tz - unit.z;
  let dist = Math.hypot(dx, dz);
  if (dist < 0.05) {
    if (fieldCenterDistance(unit, field) < HARVESTER_WORK_RADIUS) return true;
    return false;
  }

  const moveSpeed = unit.speed * dt;
  const ratio = Math.min(1, moveSpeed / dist);
  let nx = unit.x + dx * ratio;
  let nz = unit.z + dz * ratio;

  if (!Pathfinding.isPositionWalkable(nx, nz)) {
    const towardCenterX = fx - unit.x;
    const towardCenterZ = fz - unit.z;
    const centerLen = Math.hypot(towardCenterX, towardCenterZ);
    if (centerLen > 0.01) {
      const step = Math.min(moveSpeed, centerLen);
      nx = unit.x + (towardCenterX / centerLen) * step;
      nz = unit.z + (towardCenterZ / centerLen) * step;
      if (!Pathfinding.isPositionWalkable(nx, nz)) {
        const perpX = -towardCenterZ / centerLen;
        const perpZ = towardCenterX / centerLen;
        const alt1x = unit.x + perpX * moveSpeed;
        const alt1z = unit.z + perpZ * moveSpeed;
        const alt2x = unit.x - perpX * moveSpeed;
        const alt2z = unit.z - perpZ * moveSpeed;
        if (Pathfinding.isPositionWalkable(alt1x, alt1z)) {
          nx = alt1x;
          nz = alt1z;
        } else if (Pathfinding.isPositionWalkable(alt2x, alt2z)) {
          nx = alt2x;
          nz = alt2z;
        } else {
          return fieldCenterDistance(unit, field) < HARVESTER_WORK_RADIUS;
        }
      }
    } else {
      return fieldCenterDistance(unit, field) < HARVESTER_WORK_RADIUS;
    }
  }

  const res = Pathfinding.resolveNavMotion(unit.x, unit.z, nx, nz);
  if (!res.blocked) {
    unit.x = res.x;
    unit.z = res.z;
    if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
      unit.rotation = Math.atan2(dx, dz);
    }
  }

  return canStartHarvestingAtField(unit, field)
    || fieldCenterDistance(unit, field) < HARVESTER_WORK_RADIUS;
}

function harvesterAtEndOfPath(unit) {
  return !unit.path || unit.path.length === 0 || unit.pathIndex >= unit.path.length - 1;
}

function harvesterNotePathBlocked(unit) {
  unit._pathBlockedStreak = (unit._pathBlockedStreak || 0) + 1;
  if (unit._pathBlockedStreak >= PATH_BLOCKED_STREAK_REPATH) {
    unit.path = null;
    unit.pathIndex = 0;
    unit._pathBlockedStreak = 0;
    harvesterSchedulePathRetry(unit);
  }
}

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

  // Nearest refinery (including one still building — was excluded by constructionProgress filter before).
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
  
  // No known crystal in fog yet — cannot start a harvest loop (refinery alone does not send them "to" it first).
  if (!field) return;

  unit.assignedRefinery = refinery.id;
  unit.assignedField = field.id;
  unit.state = 'movingToField';
  clearFieldApproachCache(unit);
  setFieldHarvestTarget(unit, field);
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
  if (canStartHarvestingAtField(unit, field)) {
    unit.state = 'harvesting';
    unit.targetPos = null;
    unit.path = null;
    clearFieldApproachCache(unit);
    unit._harvestTimer = 0;
    return;
  }

  setFieldHarvestTarget(unit, field);

  // Use main movement system
  moveAlongPathSimple(unit, dt);

  if (!canStartHarvestingAtField(unit, field) && harvesterAtEndOfPath(unit)) {
    if (harvesterCreepTowardField(unit, field, dt)) {
      unit.state = 'harvesting';
      unit.targetPos = null;
      unit.path = null;
      clearFieldApproachCache(unit);
      unit._harvestTimer = 0;
    }
  }
}

function harvest(unit, dt) {
  const field = State.resourceFields.get(unit.assignedField);
  if (!field || field.depleted) {
    unit.state = 'idle';
    unit.assignedField = null;
    return;
  }

  const distField = fieldCenterDistance(unit, field);
  if (distField > HARVESTER_WORK_RADIUS) {
    unit.state = 'movingToField';
    clearFieldApproachCache(unit);
    setFieldHarvestTarget(unit, field);
    unit.path = null;
    unit._harvestTimer = 0;
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

    // Head back to nearest refinery from *here* (assignedRefinery was chosen at trip start near old base;
    // after harvesting at a far field, a closer expansion refinery must win).
    unit.state = 'movingToRefinery';
    const dropRef = findNearestRefinery(unit);
    if (dropRef) {
      unit.assignedRefinery = dropRef.id;
      unit.targetPos = { x: dropRef.x, z: dropRef.z };
    } else {
      unit.state = 'idle';
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
  if (dist < HARVESTER_ARRIVE_RADIUS) {
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
  const ref = State.buildings.get(unit.assignedRefinery);
  if (!ref || ref.hp <= 0) {
    unit.state = 'idle';
    unit.targetPos = null;
    unit.path = null;
    unit._depositTimer = 0;
    return;
  }
  if (Pathfinding.getDistance(unit.x, unit.z, ref.x, ref.z) > HARVESTER_WORK_RADIUS) {
    unit.state = 'movingToRefinery';
    unit.targetPos = { x: ref.x, z: ref.z };
    unit.path = null;
    unit._depositTimer = 0;
    return;
  }

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
    if (!harvesterCanPathfind(unit)) return;
    if (!Pathfinding.canTakePathfindSlot(false)) {
      harvesterSchedulePathRetry(unit, 40);
      return;
    }

    Pathfinding.notePathfindSlot(false);
    const path = Pathfinding.findPath(unit.x, unit.z, unit.targetPos.x, unit.targetPos.z);
    
    // If we've reached the closest point to destination but can't proceed,
    // explicitly try to transition to the required action state instead of just aborting to idle and losing our action sequence.
    if (!path || path.length === 0) {
      // Never pretend we arrived: path failure used to force harvesting/depositing even when
      // still far from the crystal or refinery (e.g. stuck on nav) — UI showed "Harvesting" on empty nodes.
      if (unit.state === 'movingToRefinery') {
        const ref = State.buildings.get(unit.assignedRefinery);
        if (
          ref &&
          ref.hp > 0 &&
          Pathfinding.getDistance(unit.x, unit.z, ref.x, ref.z) < HARVESTER_ARRIVE_RADIUS
        ) {
          unit.state = 'depositing';
          unit.targetPos = null;
          unit.path = null;
          unit._depositTimer = 0;
        } else {
          unit.state = 'idle';
          unit.targetPos = null;
          unit.path = null;
        }
      } else if (unit.state === 'movingToField') {
        const field = State.resourceFields.get(unit.assignedField);
        if (field && !field.depleted) {
          const centerDist = fieldCenterDistance(unit, field);
          if (centerDist < HARVESTER_ARRIVE_RADIUS || centerDist < HARVESTER_WORK_RADIUS) {
            unit.state = 'harvesting';
            unit.targetPos = null;
            unit.path = null;
            clearFieldApproachCache(unit);
            unit._harvestTimer = 0;
          } else {
            unit._fieldApproachFails = (unit._fieldApproachFails || 0) + 1;
            if (unit._fieldApproachFails >= 2) {
              setFieldHarvestTarget(unit, field, unit._fieldApproachFails * 0.9);
            } else {
              setFieldHarvestTarget(unit, field);
            }
            unit.path = null;
            unit.pathIndex = 0;
            harvesterSchedulePathRetry(unit, 120);
          }
        } else {
          unit.assignedField = null;
          clearFieldApproachCache(unit);
          unit.state = 'idle';
          unit.targetPos = null;
          unit.path = null;
        }
      } else {
        unit.state = 'idle';
        unit.targetPos = null;
        unit.path = null;
      }
      unit._harvestTimer = 0;
      unit._depositTimer = 0;
      return;
    }
    if (!Pathfinding.isPathValidOnGrid(path)) {
      unit.path = null;
      unit.pathIndex = 0;
      harvesterSchedulePathRetry(unit);
      return;
    }
    unit.path = Pathfinding.trimPathFromUnit(path, unit.x, unit.z);
    unit.pathIndex = 0;
    unit._pathBlockedStreak = 0;
  }

  while (unit.pathIndex < unit.path.length - 1) {
    const ahead = unit.path[unit.pathIndex];
    if (Math.hypot(ahead.x - unit.x, ahead.z - unit.z) < 1.0) {
      unit.pathIndex++;
    } else {
      break;
    }
  }

  const wp = unit.path[unit.pathIndex];
  if (!wp) {
    unit.path = null;
    unit.pathIndex = 0;
    return;
  }

  const dx = wp.x - unit.x;
  const dz = wp.z - unit.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist < 1.0) {
    unit.pathIndex++;
    return;
  }

  const moveSpeed = unit.speed * dt;
  const ratio = Math.min(1, moveSpeed / dist);
  const nx = unit.x + dx * ratio;
  const nz = unit.z + dz * ratio;
  const res = Pathfinding.resolveNavMotion(unit.x, unit.z, nx, nz);
  if (res.blocked) {
    harvesterNotePathBlocked(unit);
    return;
  }
  unit.x = res.x;
  unit.z = res.z;
  unit._pathBlockedStreak = 0;
  const ox = unit.x;
  const oz = unit.z;
  const clamped = clampWorldToPlayableDisk(unit.x, unit.z, 0);
  const clampRes = Pathfinding.resolveNavMotion(ox, oz, clamped.x, clamped.z);
  unit.x = clampRes.x;
  unit.z = clampRes.z;
  if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
    const s = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
    unit.x = s.x;
    unit.z = s.z;
  }

  if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
    unit.rotation = Math.atan2(dx, dz);
  }
}

// --- Helpers ---
function findNearestRefinery(unit) {
  // Any living refinery (under construction counts — getPlayerBuildingsOfType omits progress < 1).
  const playerBuildings = State.getPlayerBuildings(unit.ownerId).filter(
    b => b.type === 'refinery' && b.hp > 0
  );
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

/**
 * Player (or host) orders a harvester to work a specific crystal until it is depleted.
 * If the unit is already carrying ore to a refinery, only `lastHarvestedField` is updated so the new field is used after deposit.
 * @returns {boolean} true if the order was stored (including deferred while carrying cargo).
 */
export function assignHarvesterToField(unit, fieldId) {
  if (!unit || unit.type !== 'harvester' || unit.hp <= 0) return false;
  const field = State.resourceFields.get(fieldId);
  if (!field || field.depleted) return false;
  const refinery = findNearestRefinery(unit);
  if (!refinery) return false;

  unit.lastHarvestedField = field.id;

  const carrying = (unit.cargo || 0) > 0;
  if (carrying && (unit.state === 'movingToRefinery' || unit.state === 'depositing')) {
    return true;
  }

  unit.playerCommanded = false;
  unit.assignedRefinery = refinery.id;
  unit.assignedField = field.id;
  unit.state = 'movingToField';
  clearFieldApproachCache(unit);
  setFieldHarvestTarget(unit, field);
  unit.targetUnitId = null;
  unit.targetBuildingId = null;
  unit.path = null;
  unit.pathIndex = 0;
  unit.guardPos = null;
  unit._harvestTimer = 0;
  return true;
}
