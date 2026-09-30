// ========================================
// RTSVR4 — Resource System
// Resource fields, harvesters, income
// ========================================

import {
  HARVEST_AMOUNT, HARVEST_TIME, DEPOSIT_TIME,
  clampWorldToPlayableDisk,
  OBSTACLE_BUFFER,
} from './config.js';
import * as State from './state.js';
import * as Pathfinding from './pathfinding.js';
import * as Fog from './fog.js';

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

  const pushed = Pathfinding.snapOutOfObstacle(fx, fz);
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
    const intended = Math.hypot(nx - unit.x, nz - unit.z);
    const gained = Math.hypot(res.x - unit.x, res.z - unit.z);
    if (intended > 0.04 && gained < Math.max(0.02, intended * 0.2)) {
      const step = Pathfinding.bestEscapeStep(unit.x, unit.z, fx, fz);
      if (step) {
        const moved = Pathfinding.resolveNavMotion(unit.x, unit.z, step.x, step.z);
        if (!moved.blocked) {
          unit.x = moved.x;
          unit.z = moved.z;
        }
      }
      return canStartHarvestingAtField(unit, field)
        || fieldCenterDistance(unit, field) < HARVESTER_WORK_RADIUS;
    }
    unit.x = res.x;
    unit.z = res.z;
    if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
      unit.rotation = Math.atan2(dx, dz);
    }
  } else {
    const step = Pathfinding.bestEscapeStep(unit.x, unit.z, fx, fz);
    if (step) {
      const moved = Pathfinding.resolveNavMotion(unit.x, unit.z, step.x, step.z);
      if (!moved.blocked) {
        unit.x = moved.x;
        unit.z = moved.z;
      }
    } else if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
      const safe = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
      unit.x = safe.x;
      unit.z = safe.z;
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

    unstickHarvesterIfFrozen(unit, dt);

    switch (unit.state) {
      case 'idle': {
        const player = State.players[unit.ownerId];
        // Bot HVs must never sit with a stuck "player" order flag — that blocks auto-assign forever.
        if (player?.isBot && unit.playerCommanded) {
          unit.playerCommanded = false;
        }
        assignHarvesterTask(unit);
        // Still idle = no known ore (or no refinery). Bots go look; humans wait for orders.
        if (unit.state === 'idle' && player?.isBot) {
          sendBotHarvesterToSeekOre(unit);
        }
        break;
      }

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
        // Relocate orders (scout/explore attack-move). updateUnits skips harvesters, so
        // this must drive motion here — otherwise they freeze forever and stop mining.
        moveHarvesterRelocate(unit, dt);
        break;

      default:
        // attacking / unknown — harvesters must never sit outside the harvest FSM.
        unit.playerCommanded = false;
        unit.state = 'idle';
        unit.targetUnitId = null;
        unit.targetBuildingId = null;
        break;
    }
  });
}

/** If a HV hasn't moved for seconds while "busy", force a repath / reassignment. */
function unstickHarvesterIfFrozen(unit, dt) {
  if (unit.state === 'idle' || unit.state === 'harvesting' || unit.state === 'depositing') {
    unit._stuckTime = 0;
    unit._stuckX = unit.x;
    unit._stuckZ = unit.z;
    return;
  }
  const moved = Math.hypot(unit.x - (unit._stuckX ?? unit.x), unit.z - (unit._stuckZ ?? unit.z));
  if (moved > 0.5) {
    unit._stuckX = unit.x;
    unit._stuckZ = unit.z;
    unit._stuckTime = 0;
    return;
  }
  unit._stuckTime = (unit._stuckTime || 0) + dt;
  if (unit._stuckTime < 3.5) return;

  unit._stuckTime = 0;
  unit._stuckX = unit.x;
  unit._stuckZ = unit.z;
  unit.path = null;
  unit.pathIndex = 0;
  unit._pathRetryAt = 0;
  unit._preferGridPath = true;
  // A player move order stays until they arrive. Only a frozen auto-haul is dropped.
  if (unit.playerCommanded && unit.state === 'moving' && unit.targetPos) return;
  unit.playerCommanded = false;

  if ((unit.cargo || 0) > 0) {
    const ref = findNearestRefinery(unit);
    if (ref) {
      const dist = Pathfinding.getDistance(unit.x, unit.z, ref.x, ref.z);
      // Already in unload range but FSM never transitioned — dump now.
      if (dist < HARVESTER_WORK_RADIUS + 4) {
        unit.assignedRefinery = ref.id;
        unit.state = 'depositing';
        unit.targetPos = null;
        unit._depositTimer = 0;
        return;
      }
      // Try a fresh approach from a rotated side of the refinery.
      unit.assignedRefinery = ref.id;
      unit.state = 'movingToRefinery';
      const ang = (unit._unstickSpin = ((unit._unstickSpin || 0) + 1.1));
      const h = (ref.size || 4) * 0.5;
      const standoff = h + OBSTACLE_BUFFER + 4;
      const ax = ref.x + Math.cos(ang) * standoff;
      const az = ref.z + Math.sin(ang) * standoff;
      const snap = Pathfinding.snapWorldXZToWalkable(ax, az);
      unit.targetPos = { x: snap.x, z: snap.z };
      // Nudge out of whatever cell we're wedged in.
      if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
        const s = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
        unit.x = s.x;
        unit.z = s.z;
      }
      return;
    }
  }
  // Explore / field trip frozen — drop to idle so assign / seek can recover.
  unit.state = 'idle';
  unit.targetPos = null;
  unit.assignedField = null;
}

/** Finish a move order or a bot scout wander, then resume the normal harvest loop. */
function moveHarvesterRelocate(unit, dt) {
  const ordered = !!unit.playerCommanded;
  // Bot explore only. A player move keeps its destination until arrival.
  if (!ordered && (unit.cargo || 0) === 0 && findNearestResourceField(unit)) {
    unit.state = 'idle';
    unit.playerCommanded = false;
    unit.targetPos = null;
    unit.path = null;
    unit.pathIndex = 0;
    unit._relocateAge = 0;
    assignHarvesterTask(unit);
    return;
  }
  if (!ordered && (unit.cargo || 0) > 0) {
    const refinery = findNearestRefinery(unit);
    if (refinery) {
      sendHarvesterToRefinery(unit, refinery);
      return;
    }
  }
  // Stuck / aborted relocate → drop back into auto-harvest immediately.
  if (!unit.targetPos) {
    unit.state = 'idle';
    unit.playerCommanded = false;
    unit.path = null;
    unit.pathIndex = 0;
    unit._relocateAge = 0;
    assignHarvesterTask(unit);
    if (unit.state === 'idle' && State.players[unit.ownerId]?.isBot) {
      sendBotHarvesterToSeekOre(unit);
    }
    return;
  }
  const dist = Pathfinding.getDistance(unit.x, unit.z, unit.targetPos.x, unit.targetPos.z);
  if (dist < HARVESTER_ARRIVE_RADIUS) {
    unit.state = 'idle';
    unit.playerCommanded = false;
    unit.targetPos = null;
    unit.path = null;
    unit.pathIndex = 0;
    unit._relocateAge = 0;
    assignHarvesterTask(unit);
    if (unit.state === 'idle' && State.players[unit.ownerId]?.isBot) {
      sendBotHarvesterToSeekOre(unit);
    }
    return;
  }
  // Unordered wander that never gets a path drops back into auto-harvest.
  // A player move keeps trying until the destination.
  unit._relocateAge = (unit._relocateAge || 0) + dt;
  if (!ordered && (unit._relocateAge > 35 || (!unit.path && unit._relocateAge > 12))) {
    unit.state = 'idle';
    unit.playerCommanded = false;
    unit.targetPos = null;
    unit.path = null;
    unit.pathIndex = 0;
    unit._relocateAge = 0;
    assignHarvesterTask(unit);
    if (unit.state === 'idle' && State.players[unit.ownerId]?.isBot) {
      sendBotHarvesterToSeekOre(unit);
    }
    return;
  }
  moveAlongPathSimple(unit, dt);
  if (
    unit.targetPos &&
    Pathfinding.getDistance(unit.x, unit.z, unit.targetPos.x, unit.targetPos.z) < HARVESTER_ARRIVE_RADIUS
  ) {
    unit.state = 'idle';
    unit.playerCommanded = false;
    unit.targetPos = null;
    unit.path = null;
    unit.pathIndex = 0;
    unit._relocateAge = 0;
    assignHarvesterTask(unit);
    if (unit.state === 'idle' && State.players[unit.ownerId]?.isBot) {
      sendBotHarvesterToSeekOre(unit);
    }
  }
}

/**
 * Bot HV with nothing to harvest: walk into fog toward nearest unexplored cell / map sector.
 * Sets `moving` directly (updateUnits skips harvesters; moveHarvesterRelocate drives motion).
 */
function sendBotHarvesterToSeekOre(unit) {
  const player = State.players[unit.ownerId];
  if (!player?.isBot) return;
  if (unit.playerCommanded) return;
  if ((unit.cargo || 0) > 0) return;
  // If any live explored ore exists, mine it — do not wander.
  if (findNearestResourceField(unit)) return;
  // Throttle so we don't repath every frame.
  const now = State.gameSession.elapsedTime;
  if (now - (unit._botSeekOreAt || 0) < 2.5) return;
  unit._botSeekOreAt = now;

  const hq = State.getPlayerHQ(unit.ownerId);
  const anchorX = hq?.x ?? unit.x;
  const anchorZ = hq?.z ?? unit.z;

  let goal = Fog.findNearestUnexploredCell(player.team, unit.x, unit.z);
  if (!goal) {
    const seed = (unit.id || '').length + Math.floor(now);
    const ang = seed * 0.9 + now * 0.03;
    goal = clampWorldToPlayableDisk(
      anchorX + Math.cos(ang) * (45 + (seed % 40)),
      anchorZ + Math.sin(ang) * (45 + (seed % 40)),
      8
    );
  }
  if (!goal) return;

  const snapped = Pathfinding.snapOutOfObstacle(goal.x, goal.z);
  const t = clampWorldToPlayableDisk(snapped.x, snapped.z, 0);
  unit._relocateAge = 0;
  unit.state = 'moving';
  unit.targetPos = { x: t.x, z: t.z };
  unit.playerCommanded = false;
  unit.targetUnitId = null;
  unit.targetBuildingId = null;
  unit.assignedField = null;
  unit.path = null;
  unit.pathIndex = 0;
}

function assignHarvesterTask(unit) {
  // If player commanded move, don't auto-assign
  if (unit.playerCommanded) return;

  const player = State.players[unit.ownerId];
  if (!player) return;

  // Nearest refinery (including one still building — was excluded by constructionProgress filter before).
  const refinery = findNearestRefinery(unit);
  if (!refinery) return; // No refinery - stay idle (bot seek runs after)

  // Carrying ore: always deposit first (e.g. after the assigned refinery was sold).
  if ((unit.cargo || 0) > 0) {
    sendHarvesterToRefinery(unit, refinery);
    return;
  }

  let field = null;
  // Bots: always retarget nearest live explored ore (sticky lastHarvested left trucks
  // parked after home emptied / unreachable stick targets).
  if (!player.isBot && unit.lastHarvestedField) {
    const prevField = State.resourceFields.get(unit.lastHarvestedField);
    if (prevField && !prevField.depleted && prevField.remaining > 0) {
      field = prevField;
    } else {
      unit.lastHarvestedField = null;
    }
  }

  if (!field) {
    field = findNearestResourceField(unit);
  }

  // No known crystal in fog yet — cannot start a harvest loop (refinery alone does not send them "to" it first).
  if (!field) return;

  unit.assignedRefinery = refinery.id;
  unit.assignedField = field.id;
  unit.state = 'movingToField';
  clearFieldApproachCache(unit);
  setFieldHarvestTarget(unit, field);
  unit.path = null;
  unit.pathIndex = 0;
  unit._pathRetryAt = 0;
  unit._relocateAge = 0;
}

function moveToField(unit, dt) {
  const field = State.resourceFields.get(unit.assignedField);
  if (!field || field.depleted) {
    // Find new field
    unit.assignedField = null;
    unit.state = 'idle';
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
    const dropRef = findNearestRefinery(unit);
    if (dropRef) {
      sendHarvesterToRefinery(unit, dropRef);
    } else {
      unit.state = 'idle';
      unit.targetPos = null;
      unit.path = null;
      unit.pathIndex = 0;
    }
    unit._harvestTimer = 0;
  }
}

/** Walkable stand point outside a refinery nav footprint (center is blocked). */
function refineryApproachPos(fromX, fromZ, refinery) {
  const bx = refinery.x;
  const bz = refinery.z;
  const h = (refinery.size || 4) * 0.5;
  // Match expanded nav pad on refineries so approach stands outside the blocked cells.
  const standoff = h + OBSTACLE_BUFFER + 2.25 + 1.5;
  const dx = fromX - bx;
  const dz = fromZ - bz;
  const len = Math.hypot(dx, dz);
  let ax;
  let az;
  if (len < 0.05) {
    ax = bx + standoff;
    az = bz;
  } else {
    ax = bx + (dx / len) * standoff;
    az = bz + (dz / len) * standoff;
  }
  const snap = Pathfinding.snapWorldXZToWalkable(ax, az);
  if (Pathfinding.isPositionWalkable(snap.x, snap.z)) {
    return { x: snap.x, z: snap.z };
  }
  const reach = Pathfinding.findNearestReachable(fromX, fromZ, ax, az, 40);
  return reach || { x: ax, z: az };
}

/**
 * Assign / retarget a harvester onto a living refinery and clear stale path state so they actually move.
 * @param {*} unit
 * @param {*} refinery
 */
function sendHarvesterToRefinery(unit, refinery) {
  if (!unit || !refinery) return;
  unit.assignedRefinery = refinery.id;
  unit.state = 'movingToRefinery';
  const goal = refineryApproachPos(unit.x, unit.z, refinery);
  unit.targetPos = { x: goal.x, z: goal.z };
  unit.path = null;
  unit.pathIndex = 0;
  unit._pathRetryAt = 0;
  unit._pathBlockedStreak = 0;
  unit._depositTimer = 0;
  unit.playerCommanded = false;
}

/**
 * After a refinery is sold/destroyed: harvesters bound to it retarget and start moving.
 * @param {string} lostBuildingId
 * @param {number} [ownerId]
 */
export function reassignHarvestersAfterRefineryLost(lostBuildingId, ownerId) {
  State.units.forEach(unit => {
    if (unit.hp <= 0 || unit.type !== 'harvester') return;
    if (ownerId != null && unit.ownerId !== ownerId) return;
    if (unit.assignedRefinery !== lostBuildingId) return;

    const next = findNearestRefinery(unit);
    if (!next) {
      if (unit.state === 'movingToRefinery' || unit.state === 'depositing') {
        unit.state = 'idle';
        unit.assignedRefinery = null;
        unit.targetPos = null;
        unit.path = null;
        unit.pathIndex = 0;
      } else {
        unit.assignedRefinery = null;
      }
      return;
    }

    if ((unit.cargo || 0) > 0 || unit.state === 'movingToRefinery' || unit.state === 'depositing') {
      sendHarvesterToRefinery(unit, next);
    } else {
      unit.assignedRefinery = next.id;
    }
  });
}

function moveToRefinery(unit, dt) {
  let refinery = State.buildings.get(unit.assignedRefinery);
  if (!refinery || refinery.hp <= 0) {
    const newRef = findNearestRefinery(unit);
    if (newRef) {
      sendHarvesterToRefinery(unit, newRef);
      refinery = newRef;
    } else {
      unit.state = 'idle';
      unit.assignedRefinery = null;
      unit.targetPos = null;
      unit.path = null;
      unit.pathIndex = 0;
      return;
    }
  }

  const dist = Pathfinding.getDistance(unit.x, unit.z, refinery.x, refinery.z);
  const distGoal = unit.targetPos
    ? Pathfinding.getDistance(unit.x, unit.z, unit.targetPos.x, unit.targetPos.z)
    : Infinity;
  // Approach pads sit outside the nav-blocked footprint (~15–20m from center). Old checks
  // (arriveR=12 / workR=17 / distGoal<2.5) left trucks frozen ON the pad with full cargo.
  const atPad = !!unit.targetPos && distGoal <= 3.5;
  const inUnloadRange = dist <= Math.max(HARVESTER_WORK_RADIUS + 4, 22);
  if (dist < HARVESTER_ARRIVE_RADIUS || atPad || inUnloadRange) {
    unit.state = 'depositing';
    unit.targetPos = null;
    unit.path = null;
    unit.pathIndex = 0;
    unit._depositTimer = 0;
    return;
  }

  // Keep a stable approach goal — recomputing from the moving unit each tick thrashes A*.
  if (!unit.targetPos) {
    const goal = refineryApproachPos(unit.x, unit.z, refinery);
    unit.targetPos = { x: goal.x, z: goal.z };
    unit.path = null;
    unit.pathIndex = 0;
  }

  moveAlongPathSimple(unit, dt);

  // After move: if creep got us onto the pad / unload range, deposit now.
  const dist2 = Pathfinding.getDistance(unit.x, unit.z, refinery.x, refinery.z);
  const distGoal2 = unit.targetPos
    ? Pathfinding.getDistance(unit.x, unit.z, unit.targetPos.x, unit.targetPos.z)
    : Infinity;
  if (dist2 <= Math.max(HARVESTER_WORK_RADIUS + 4, 22) || distGoal2 <= 3.5) {
    unit.state = 'depositing';
    unit.targetPos = null;
    unit.path = null;
    unit.pathIndex = 0;
    unit._depositTimer = 0;
  }
}

function deposit(unit, dt) {
  const ref = State.buildings.get(unit.assignedRefinery);
  if (!ref || ref.hp <= 0) {
    const newRef = findNearestRefinery(unit);
    if (newRef) {
      sendHarvesterToRefinery(unit, newRef);
    } else {
      unit.state = 'idle';
      unit.assignedRefinery = null;
      unit.targetPos = null;
      unit.path = null;
      unit.pathIndex = 0;
      unit._depositTimer = 0;
    }
    return;
  }
  if (Pathfinding.getDistance(unit.x, unit.z, ref.x, ref.z) > Math.max(HARVESTER_WORK_RADIUS + 4, 22)) {
    sendHarvesterToRefinery(unit, ref);
    return;
  }

  unit._depositTimer = (unit._depositTimer || 0) + dt;

  if (unit._depositTimer >= DEPOSIT_TIME) {
    // Deposit cargo
    const player = State.players[unit.ownerId];
    if (player && unit.cargo > 0) {
      player.credits += unit.cargo;
      if (player.stats) {
        player.stats.creditsEarned += unit.cargo;
        player.stats.creditsHarvested = (player.stats.creditsHarvested || 0) + unit.cargo;
      }
      unit.cargo = 0;
    }

    // Go back for more
    unit._depositTimer = 0;
    unit.state = 'idle'; // Will auto-assign in next tick
  }
}

// --- Simple movement for harvesters ---
/** Direct step toward a point when A* is unavailable or failed — never stand still with cargo. */
function harvesterCreepTowardPos(unit, tx, tz, dt) {
  const dx = tx - unit.x;
  const dz = tz - unit.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.08) return true;
  const moveSpeed = unit.speed * dt;
  const ratio = Math.min(1, moveSpeed / dist);
  const nx = unit.x + dx * ratio;
  const nz = unit.z + dz * ratio;
  const res = Pathfinding.resolveNavMotion(unit.x, unit.z, nx, nz);
  if (res.blocked) {
    const step = Pathfinding.bestEscapeStep(unit.x, unit.z, tx, tz);
    if (step) {
      const moved = Pathfinding.resolveNavMotion(unit.x, unit.z, step.x, step.z);
      if (!moved.blocked) {
        unit.x = moved.x;
        unit.z = moved.z;
      }
    } else if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
      const s = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
      unit.x = s.x;
      unit.z = s.z;
    }
  } else {
    unit.x = res.x;
    unit.z = res.z;
  }
  if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
    unit.rotation = Math.atan2(dx, dz);
  }
  return Math.hypot(tx - unit.x, tz - unit.z) < 0.6;
}

function moveAlongPathSimple(unit, dt) {
  if (!unit.path || unit.path.length === 0 || unit.pathIndex >= unit.path.length) {
    if (!unit.targetPos) return;

    // CRITICAL: when A* slots are exhausted (common with 4-bot FFA), HVs used to
    // `return` here and freeze forever mid-map with full cargo. Always creep while waiting.
    const canPath =
      harvesterCanPathfind(unit) && Pathfinding.canTakePathfindSlot(false);
    if (!canPath) {
      harvesterCreepTowardPos(unit, unit.targetPos.x, unit.targetPos.z, dt);
      if (!harvesterCanPathfind(unit)) return;
      if (!Pathfinding.canTakePathfindSlot(false)) {
        harvesterSchedulePathRetry(unit, 40);
        return;
      }
    }

    Pathfinding.notePathfindSlot(false);
    const smooth = !unit._preferGridPath;
    unit._preferGridPath = false;
    const path = Pathfinding.findPath(unit.x, unit.z, unit.targetPos.x, unit.targetPos.z, smooth, true);
    if (Pathfinding.lastPathfindDeferred()) {
      harvesterCreepTowardPos(unit, unit.targetPos.x, unit.targetPos.z, dt);
      harvesterSchedulePathRetry(unit, 40);
      return;
    }

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
          unit.pathIndex = 0;
          unit._depositTimer = 0;
        } else if (ref && ref.hp > 0) {
          // Goal may be inside the footprint — snap to approach and creep (don't drop cargo to idle).
          const goal = refineryApproachPos(unit.x, unit.z, ref);
          unit.targetPos = { x: goal.x, z: goal.z };
          unit.path = null;
          unit.pathIndex = 0;
          harvesterCreepTowardPos(unit, goal.x, goal.z, dt);
          harvesterSchedulePathRetry(unit, 80);
        } else {
          const next = findNearestRefinery(unit);
          if (next) {
            sendHarvesterToRefinery(unit, next);
          } else {
            unit.state = 'idle';
            unit.targetPos = null;
            unit.path = null;
            unit.pathIndex = 0;
          }
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
            if (unit.targetPos) {
              harvesterCreepTowardPos(unit, unit.targetPos.x, unit.targetPos.z, dt);
            }
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
        // Explore relocate with no path — creep toward goal instead of idling.
        if (unit.targetPos) {
          harvesterCreepTowardPos(unit, unit.targetPos.x, unit.targetPos.z, dt);
          harvesterSchedulePathRetry(unit, 100);
        } else {
          unit.state = 'idle';
          unit.targetPos = null;
          unit.path = null;
        }
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
  const intended = Math.hypot(nx - unit.x, nz - unit.z);
  const gained = Math.hypot(res.x - unit.x, res.z - unit.z);
  const stuckOnEdge = !res.blocked && intended > 0.04 && gained < Math.max(0.02, intended * 0.2);
  if (res.blocked || stuckOnEdge) {
    const goal = unit.targetPos || { x: wp.x, z: wp.z };
    const step = Pathfinding.bestEscapeStep(unit.x, unit.z, goal.x, goal.z);
    if (step) {
      const moved = Pathfinding.resolveNavMotion(unit.x, unit.z, step.x, step.z);
      if (!moved.blocked) {
        unit.x = moved.x;
        unit.z = moved.z;
      }
    } else if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
      const s = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
      unit.x = s.x;
      unit.z = s.z;
    }
    unit.path = null;
    unit.pathIndex = 0;
    unit._preferGridPath = true;
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
    if (field.depleted || !(field.remaining > 0)) return;

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
