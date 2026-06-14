// ========================================
// RTSVR2 — Unit System
// Creation, movement, combat, death
// ========================================

import {
  UNIT_TYPES, FORMATION_SPACING, UNIT_SEPARATION_RADIUS, UNIT_SEPARATION_ACCEL,
  clampWorldToPlayableDisk,
  PLAYER_COLORS,
  CAPTURE_DURATION_MIN_SEC, CAPTURE_DURATION_MAX_SEC,
  CAPTURE_HP_REF_FOR_DURATION,
  ENGINEER_CAPTURE_EDGE_REACH,
  ENGINEER_REPAIR_RANGE,
  OBSTACLE_BUFFER,
  VEHICLE_SELL_WAR_FACTORY_RANGE,
  GUARD_CHASE_LEASH_MULT,
  GUARD_CHASE_LEASH_PAD_M,
} from './config.js';
import * as State from './state.js';
import * as Pathfinding from './pathfinding.js';
import * as Renderer from './renderer.js';
import * as Audio from './audio.js';
import * as Fog from './fog.js';
import * as Effects from './effects.js';
import { unitGrid } from './spatial.js';

/** Min ms between A* requests for the same unit (stuck / crowded movers). */
const PATH_REQUERY_MS = 400;
/** Long bot hauls (explore / rally) back off longer so path queues don't saturate. */
const PATH_REQUERY_LONG_MS = 650;
/** Blocked steps on the same waypoint before discarding path and waiting PATH_REQUERY_MS. */
const PATH_BLOCKED_STREAK_REPATH = 12;

function pathRetryNotBefore(unit) {
  return unit._pathRetryAt || 0;
}

function pathRetryDelayMs(unit, overrideMs) {
  if (overrideMs != null) return overrideMs;
  if (unitHasPlayerPathPriority(unit)) return PATH_REQUERY_MS;
  if (unit.targetPos) {
    const d = Pathfinding.getDistance(unit.x, unit.z, unit.targetPos.x, unit.targetPos.z);
    if (d > 55) return PATH_REQUERY_LONG_MS;
  }
  return PATH_REQUERY_MS;
}

function schedulePathRetry(unit, ms) {
  unit._pathRetryAt = performance.now() + pathRetryDelayMs(unit, ms);
}

function notePathStepBlocked(unit) {
  unit._pathBlockedStreak = (unit._pathBlockedStreak || 0) + 1;
  if (unit._pathBlockedStreak >= PATH_BLOCKED_STREAK_REPATH) {
    unit.path = null;
    unit.pathIndex = 0;
    unit._pathBlockedStreak = 0;
    schedulePathRetry(unit);
  }
}

function clearPathBlockStreak(unit) {
  unit._pathBlockedStreak = 0;
}

function unitHasAttackOrder(unit) {
  return unit.state === 'attacking' && (unit.targetUnitId != null || unit.targetBuildingId != null);
}

function unitHasPlayerMoveGoal(unit) {
  return unit.state === 'moving' && unit.playerCommanded && unit.targetPos != null;
}

function unitShouldKeepMoveGoal(unit) {
  return unitHasAttackOrder(unit) || unitHasPlayerMoveGoal(unit);
}

function unitHasPlayerPathPriority(unit) {
  return unit.playerCommanded && (unit.targetPos != null || unitHasAttackOrder(unit));
}

/** Player/bot attack or move orders should path immediately, not wait on crowd-retry backoff. */
function resetUnitPathThrottle(unit) {
  unit._pathRetryAt = 0;
  unit._reachRetryAt = 0;
  unit._pathBlockedStreak = 0;
}

function canRunPathfindNow(unit) {
  if (unitHasPlayerPathPriority(unit)) return true;
  return performance.now() >= pathRetryNotBefore(unit);
}

function canTakePathfindSlot(unit) {
  return Pathfinding.canTakePathfindSlot(unitHasPlayerPathPriority(unit));
}

function notePathfindSlotUsed(unit) {
  Pathfinding.notePathfindSlot(unitHasPlayerPathPriority(unit));
}

/** Max distance from guardPos for auto-acquire / chase (not explicit player attack orders). */
function getGuardEngageLeash(unit) {
  const visionR = unit.visionRange != null ? unit.visionRange : unit.range;
  const weaponR = unit.range > 0 ? unit.range : 1.5;
  const reach = Math.max(visionR, Math.min(weaponR, visionR + 10));
  return reach * GUARD_CHASE_LEASH_MULT + GUARD_CHASE_LEASH_PAD_M;
}

function isAutoDefendHold(unit) {
  return !unit.playerCommanded && unit.guardPos != null;
}

function distFromGuard(unit, wx, wz) {
  return Pathfinding.getDistance(unit.guardPos.x, unit.guardPos.z, wx, wz);
}

function exceedsGuardLeash(unit, wx, wz) {
  if (!isAutoDefendHold(unit)) return false;
  return distFromGuard(unit, wx, wz) > getGuardEngageLeash(unit);
}

function disengageToGuard(unit) {
  unit.targetUnitId = null;
  unit.targetBuildingId = null;
  if (resumeFollowAfterEscort(unit)) return;
  startMoveToGuardPos(unit);
}
function distancePointToBuildingHull(ux, uz, building) {
  const h = (building.size || 4) * 0.5;
  const bx = building.x;
  const bz = building.z;
  const qx = Math.min(Math.max(ux, bx - h), bx + h);
  const qz = Math.min(Math.max(uz, bz - h), bz + h);
  return Math.hypot(ux - qx, uz - qz);
}

/**
 * Walkable goal just outside the nav obstacle ring, toward the unit — avoids pathing into a
 * blocked building center and fixes diagonal range vs `centerDist - radius` error.
 */
function approachPointOutsideBuilding(fromX, fromZ, building) {
  const bx = building.x;
  const bz = building.z;
  const h = (building.size || 4) * 0.5;
  const standoff = h + OBSTACLE_BUFFER + 1.25;
  const dx = fromX - bx;
  const dz = fromZ - bz;
  const len = Math.hypot(dx, dz);
  let ax;
  let az;
  if (len < 0.05) {
    ax = bx + standoff;
    az = bz;
  } else {
    const nx = dx / len;
    const nz = dz / len;
    ax = bx + nx * standoff;
    az = bz + nz * standoff;
  }
  const snap = Pathfinding.snapWorldXZToWalkable(ax, az);
  if (Pathfinding.isPositionWalkable(snap.x, snap.z)) {
    return { x: snap.x, z: snap.z };
  }
  const reach = Pathfinding.findNearestReachable(fromX, fromZ, ax, az, 40);
  return reach || { x: ax, z: az };
}

// --- Unit creation ---
// options.id: authoritative id (multiplayer snapshots)
// options.skipCapCheck / skipProducedStat: used when mirroring host state
export function createUnit(type, ownerId, x, z, options = {}) {
  const stats = UNIT_TYPES[type];
  if (!stats) {
    console.error(`Unknown unit type: ${type}`);
    return null;
  }

  const player = State.players[ownerId];
  if (!player) return null;

  if (!options.skipCapCheck && player.unitCount >= player.unitCap) {
    console.log(`Player ${ownerId} at unit cap`);
    return null;
  }

  const id = options.id != null ? options.id : State.generateId('unit');
  const unit = {
    id,
    type,
    category: stats.category,
    ownerId,
    team: options.team != null ? options.team : player.team,
    x, z,
    rotation: player.spawn?.rotation || 0,
    hp: stats.hp,
    maxHp: stats.hp,
    damage: stats.damage,
    fireRate: stats.fireRate,
    range: stats.range,
    speed: stats.speed,
    visionRange: stats.visionRange,
    dmgVsInfantry: stats.dmgVsInfantry,
    dmgVsVehicle: stats.dmgVsVehicle,
    dmgVsBuilding: stats.dmgVsBuilding,
    aoe: stats.aoe || 0,

    // State
    state: 'idle',       // idle | moving | attacking | following | harvesting | returning | dead
    targetPos: null,     // { x, z }
    targetUnitId: null,
    targetBuildingId: null,
    followLeadId: null,  // ally escorted while following / defending; survives while attacking threats
    path: null,          // Array of { x, z } waypoints
    pathIndex: 0,
    lastFireTime: 0,
    playerCommanded: false, // Player explicitly ordered this action
    guardPos: null,      // Return point for auto-engagements

    // Harvester-specific
    cargo: 0,
    assignedRefinery: null,
    assignedField: null,

    /** World-space offset from squad leader while mirroring orders (`followLeadId`). */
    squadOffsetX: 0,
    squadOffsetZ: 0,
    _squadSyncSig: null,

    // Rendering (set by renderer)
    _renderIndex: -1,
    _renderVisible: false,
  };

  State.addUnit(unit);
  if (player.stats && !options.skipProducedStat) player.stats.unitsProduced++;
  return unit;
}

/** @param {string[]} unitIds */
function extendUnitIdsWithSquadFollowers(unitIds) {
  const seen = new Set(unitIds);
  const out = [...unitIds];
  unitIds.forEach(leaderId => {
    State.units.forEach(u => {
      if (u.hp <= 0 || u.followLeadId !== leaderId || seen.has(u.id)) return;
      seen.add(u.id);
      out.push(u.id);
    });
  });
  return out;
}

export function countSquadFollowers(leaderId) {
  let n = 0;
  State.units.forEach(u => {
    if (u.hp > 0 && u.followLeadId === leaderId) n++;
  });
  return n;
}

function clearSquadFollowerLink(unit) {
  unit.followLeadId = null;
  unit.squadOffsetX = 0;
  unit.squadOffsetZ = 0;
  unit._squadSyncSig = null;
}

/**
 * Each frame before movement: followers mirror the leader's orders (move/attack/idle),
 * using a fixed world offset captured at follow time — no per-frame chase toward the leader.
 */
export function syncSquadFollowersFromLeaders() {
  State.units.forEach(f => {
    if (!f.followLeadId || f.hp <= 0) return;
    const L = State.units.get(f.followLeadId);
    if (!L || L.hp <= 0) {
      clearSquadFollowerLink(f);
      f.state = 'idle';
      f.targetPos = null;
      f.path = null;
      f.targetUnitId = null;
      f.targetBuildingId = null;
      return;
    }

    const ox = f.squadOffsetX ?? 0;
    const oz = f.squadOffsetZ ?? 0;

    const sig = [
      L.state,
      L.targetUnitId ?? '',
      L.targetBuildingId ?? '',
      L.targetPos ? `${L.targetPos.x},${L.targetPos.z}` : '',
      L.playerCommanded ? 1 : 0,
    ].join('|');

    if (f._squadSyncSig === sig) return;
    f._squadSyncSig = sig;

    f.playerCommanded = L.playerCommanded;

    if (L.state === 'attacking') {
      f.state = 'attacking';
      f.targetUnitId = L.targetUnitId;
      f.targetBuildingId = L.targetBuildingId;
      if (L.targetPos) {
        const c = clampWorldToPlayableDisk(L.targetPos.x + ox, L.targetPos.z + oz, 0);
        f.targetPos = { x: c.x, z: c.z };
      } else {
        f.targetPos = null;
      }
      f.path = null;
      f.pathIndex = 0;
      return;
    }

    if (L.state === 'moving') {
      f.state = 'moving';
      if (L.targetPos) {
        const c = clampWorldToPlayableDisk(L.targetPos.x + ox, L.targetPos.z + oz, 0);
        f.targetPos = { x: c.x, z: c.z };
      } else {
        f.targetPos = null;
      }
      f.targetUnitId = null;
      f.targetBuildingId = null;
      f.path = null;
      f.pathIndex = 0;
      return;
    }

    f.state = 'idle';
    f.targetUnitId = null;
    f.targetBuildingId = null;
    f.targetPos = null;
    f.path = null;
    f.pathIndex = 0;
  });
}

/**
 * Squad mirroring keeps a fixed XZ offset while the leader is idle, so an engineer ordered to
 * follow a damaged vehicle can sit outside {@link ENGINEER_REPAIR_RANGE} forever. Chase the
 * lead's **current** position until close enough to repair (overrides mirrored idle for this case).
 */
export function syncEngineerRepairApproach() {
  State.units.forEach(f => {
    if (f.type !== 'engineer' || f.hp <= 0 || !f.followLeadId) return;
    if (f.state === 'attacking' && (f.targetBuildingId || f.targetUnitId)) return;
    const lead = State.units.get(f.followLeadId);
    if (!lead || lead.hp <= 0 || lead.team !== f.team) return;
    if (lead.category !== 'vehicle' || !isVehicleNeedingRepair(lead)) return;

    const d = Pathfinding.getDistance(f.x, f.z, lead.x, lead.z);
    if (d <= ENGINEER_REPAIR_RANGE - 0.45) return;

    f.playerCommanded = true;
    f.state = 'moving';
    const c = clampWorldToPlayableDisk(lead.x, lead.z, 0);
    const gx = c.x;
    const gz = c.z;
    const repath =
      !f.targetPos ||
      Math.hypot(f.targetPos.x - gx, f.targetPos.z - gz) > 1.25 ||
      !f.path ||
      f.path.length === 0;
    f.targetPos = { x: gx, z: gz };
    f.targetUnitId = null;
    f.targetBuildingId = null;
    if (repath) {
      f.path = null;
      f.pathIndex = 0;
    }
  });
}

// --- Movement ---
function rebuildUnitSpatialIndex() {
  unitGrid.clear();
  State.units.forEach(u => {
    if (u.hp > 0) unitGrid.insert(u);
  });
}

/** Ranged units holding still at max range — skip crowd pushes so they don’t creep into fire. */
function unitSkipsCrowdSeparation(unit) {
  // Harvesters must stay on the crystal / refinery while working — separation was sliding them away
  // and `harvest()` still drained fields from a distance.
  if (
    unit.type === 'harvester' &&
    (unit.state === 'harvesting' || unit.state === 'depositing')
  ) {
    return true;
  }
  return (
    unit.state === 'attacking' &&
    !unit.targetPos &&
    (!unit.path || unit.path.length === 0)
  );
}

export function updateMovement(dt) {
  const movers = [];
  State.units.forEach(unit => {
    if (unit.hp <= 0) return;
    if (unit.state === 'moving' || (unit.state === 'attacking' && unit.targetPos)) {
      movers.push(unit);
    }
  });
  // Player-ordered units path first so factory spawns respond on the first click.
  movers.sort((a, b) => {
    const ap = unitHasPlayerPathPriority(a) ? 0 : 1;
    const bp = unitHasPlayerPathPriority(b) ? 0 : 1;
    return ap - bp;
  });
  for (const unit of movers) {
    moveAlongPath(unit, dt);
  }

  // Rebuild after moves so separation queries current positions (enemy-only; allies don’t shove).
  rebuildUnitSpatialIndex();

  State.units.forEach(unit => {
    if (unit.hp <= 0) return;

    if (!unitSkipsCrowdSeparation(unit)) {
      applySeparation(unit, dt);
    }
  });

  rebuildUnitSpatialIndex();

  State.units.forEach(unit => {
    if (unit.hp <= 0) return;

    if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
      const safe = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
      unit.x = safe.x;
      unit.z = safe.z;
    }
  });
}

function moveAlongPath(unit, dt) {
  if (!unit.path || unit.path.length === 0 || unit.pathIndex >= unit.path.length) {
    if (!unit.targetPos) {
      if (unit.state === 'moving') {
        unit.state = 'idle';
        unit.playerCommanded = false;
      }
      return;
    }

    if (!canRunPathfindNow(unit)) return;
    if (!canTakePathfindSlot(unit)) {
      schedulePathRetry(unit, unitHasPlayerPathPriority(unit) ? 16 : 50);
      return;
    }

    notePathfindSlotUsed(unit);
    let path = Pathfinding.findPath(unit.x, unit.z, unit.targetPos.x, unit.targetPos.z);
    if (!path || path.length === 0) {
      const reachAt = unit._reachRetryAt || 0;
      if (performance.now() < reachAt) {
        schedulePathRetry(unit, Math.max(unitHasPlayerPathPriority(unit) ? 16 : 50, reachAt - performance.now()));
        return;
      }
      unit._reachRetryAt = performance.now() + (unitHasPlayerPathPriority(unit) ? 280 : 900);
      if (canTakePathfindSlot(unit)) {
        notePathfindSlotUsed(unit);
        const reachable = Pathfinding.findNearestReachable(
          unit.x, unit.z, unit.targetPos.x, unit.targetPos.z,
          unitHasPlayerPathPriority(unit) ? 44 : 36,
        );
        if (reachable) {
          unit.targetPos = { x: reachable.x, z: reachable.z };
          if (canTakePathfindSlot(unit)) {
            notePathfindSlotUsed(unit);
            path = Pathfinding.findPath(unit.x, unit.z, reachable.x, reachable.z);
          }
        }
      } else {
        schedulePathRetry(unit, unitHasPlayerPathPriority(unit) ? 16 : 80);
        return;
      }
    }
    if (!path || path.length === 0) {
      if (unitShouldKeepMoveGoal(unit)) {
        schedulePathRetry(unit, unitHasPlayerPathPriority(unit) ? 60 : 120);
        return;
      }
      unit.targetPos = null;
      unit.path = null;
      unit.pathIndex = 0;
      if (unit.state === 'moving') {
        unit.state = 'idle';
        unit.playerCommanded = false;
      }
      return;
    }

    if (!Pathfinding.isPathValidOnGrid(path)) {
      if (typeof window !== 'undefined' && window.RTS_PATH_DEBUG) {
        console.warn('[path] rejected path for unit', unit.id, 'len', path?.length);
      }
      unit.path = null;
      unit.pathIndex = 0;
      schedulePathRetry(unit, unitHasPlayerPathPriority(unit) ? 40 : PATH_REQUERY_MS);
      return;
    }

    unit.path = Pathfinding.trimPathFromUnit(path, unit.x, unit.z);
    unit.pathIndex = 0;
    clearPathBlockStreak(unit);

    if (typeof window !== 'undefined' && window.RTS_PATH_DEBUG) {
      console.log(
        `[path] unit ${unit.id}: ${unit.path.length} wps ` +
        `(${unit.x.toFixed(0)},${unit.z.toFixed(0)})→(${unit.targetPos.x.toFixed(0)},${unit.targetPos.z.toFixed(0)})`,
      );
    }
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
    if (unit.pathIndex >= unit.path.length) {
      unit.path = null;
      unit.pathIndex = 0;
      if (unit.state === 'moving') {
        unit.targetPos = null;
        unit.state = 'idle';
        unit.playerCommanded = false;
      }
      // attacking: keep targetPos — enemy may still be out of range; chase continues in combat
    }
    return;
  }

  const moveSpeed = unit.speed * dt;
  const ratio = Math.min(1, moveSpeed / dist);
  const nx = unit.x + dx * ratio;
  const nz = unit.z + dz * ratio;
  const res = Pathfinding.resolveNavMotion(unit.x, unit.z, nx, nz);
  if (res.blocked) {
    notePathStepBlocked(unit);
    return;
  }
  unit.x = res.x;
  unit.z = res.z;
  clearPathBlockStreak(unit);

  const ox = unit.x;
  const oz = unit.z;
  const clamped = clampWorldToPlayableDisk(unit.x, unit.z, 0);
  const clampRes = Pathfinding.resolveNavMotion(ox, oz, clamped.x, clamped.z);
  unit.x = clampRes.x;
  unit.z = clampRes.z;
  if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
    const safe = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
    unit.x = safe.x;
    unit.z = safe.z;
  }

  if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
    unit.rotation = Math.atan2(dx, dz);
  }
}

function applySeparation(unit, dt) {
  const R = UNIT_SEPARATION_RADIUS;
  const r2 = R * R;
  const nearby = unitGrid.queryRadius(unit.x, unit.z, R);
  let ax = 0;
  let az = 0;
  for (const other of nearby) {
    if (other.id === unit.id || other.hp <= 0) continue;
    // Allies: no mutual soft-body — pathing already fights terrain; separation was cancelling forward motion.
    if (other.team === unit.team) continue;
    const dx = unit.x - other.x;
    const dz = unit.z - other.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < 1e-5) {
      // Deterministic “unstack” spin — avoids rng fighting and spreads co-spawned units.
      const spin =
        ((unit.x * 12.9898 + unit.z * 78.233 + unit.id.length * 31.37 + (other.id?.length || 0) * 17.1) %
          (Math.PI * 2)) +
        State.gameSession.elapsedTime * 0.65;
      ax += Math.cos(spin) * 0.42;
      az += Math.sin(spin) * 0.42;
    } else if (distSq < r2) {
      const dist = Math.sqrt(distSq);
      const overlap = R - dist;
      const push = (overlap / R) * UNIT_SEPARATION_ACCEL * dt;
      ax += (dx / dist) * push;
      az += (dz / dist) * push;
    }
  }
  if (Math.abs(ax) < 1e-8 && Math.abs(az) < 1e-8) return;

  const maxStep = Math.max(unit.speed * dt * 1.15, 0.1);
  const mag = Math.hypot(ax, az);
  if (mag > maxStep) {
    ax = (ax / mag) * maxStep;
    az = (az / mag) * maxStep;
  }

  const trySlide = (px, pz) =>
    Pathfinding.resolveNavMotion(unit.x, unit.z, unit.x + px, unit.z + pz);

  let res = trySlide(ax, az);
  const moved2 = (res.x - unit.x) ** 2 + (res.z - unit.z) ** 2;
  // If head-on push is blocked (units or terrain), try a tangential slip to “orbit” past.
  if (moved2 < 1e-6) {
    const m = Math.hypot(ax, az);
    let px;
    let pz;
    if (m > 1e-6) {
      px = (-az / m) * maxStep * 0.92;
      pz = (ax / m) * maxStep * 0.92;
    } else {
      const spin =
        ((unit.x * 9.17 + unit.z * 55.3 + (unit.id.charCodeAt(0) || 0)) % (Math.PI * 2)) +
        State.gameSession.elapsedTime * 0.5;
      px = Math.cos(spin) * maxStep * 0.75;
      pz = Math.sin(spin) * maxStep * 0.75;
    }
    res = trySlide(px, pz);
  }

  unit.x = res.x;
  unit.z = res.z;
  if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
    const safe = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
    unit.x = safe.x;
    unit.z = safe.z;
  }
}

function getCaptureDurationSeconds(maxHp) {
  const ref = Math.max(1, CAPTURE_HP_REF_FOR_DURATION);
  const raw = CAPTURE_DURATION_MIN_SEC
    + (maxHp / ref) * (CAPTURE_DURATION_MAX_SEC - CAPTURE_DURATION_MIN_SEC);
  return Math.min(CAPTURE_DURATION_MAX_SEC, Math.max(CAPTURE_DURATION_MIN_SEC, raw));
}

/** After auto-defend / chase, walk back to last move-assigned rally (guardPos) if still away and safe. */
function startMoveToGuardPos(unit) {
  if (!unit.guardPos) {
    unit.state = 'idle';
    unit.targetPos = null;
    unit.path = null;
    return;
  }
  const d = Pathfinding.getDistance(unit.x, unit.z, unit.guardPos.x, unit.guardPos.z);
  if (d < 3.2) {
    unit.state = 'idle';
    unit.targetPos = null;
    unit.path = null;
    unit.playerCommanded = false;
    return;
  }
  unit.state = 'moving';
  unit.targetPos = { x: unit.guardPos.x, z: unit.guardPos.z };
  unit.path = null;
  unit.pathIndex = 0;
  unit.playerCommanded = false;
}

function beginEngagingUnit(unit, enemy) {
  if (!enemy || enemy.hp <= 0) return false;
  unit.state = 'attacking';
  unit.targetUnitId = enemy.id;
  unit.targetBuildingId = null;
  unit.targetPos = { x: enemy.x, z: enemy.z };
  unit.path = null;
  unit.pathIndex = 0;
  unit._lastPathTime = 0;
  unit._losLastSeen = performance.now();
  resetUnitPathThrottle(unit);
  return true;
}

/** Harvesters / unarmed units / passive building targets — yield to combat threats. */
function isLowPriorityUnitTarget(target) {
  if (!target || target.hp <= 0) return true;
  if (target.damage <= 0) return true;
  return target.type === 'harvester' || target.type === 'mobileHq' || target.type === 'engineer';
}

function isEnemyCombatUnit(enemy) {
  return enemy && enemy.hp > 0 && enemy.damage > 0 && enemy.category;
}

function enemyIsAttackingUnit(enemy, victim) {
  return enemy.state === 'attacking' && enemy.targetUnitId === victim.id;
}

function shouldPrioritizeAttackerOverCurrentTarget(unit, attacker) {
  if (!isEnemyCombatUnit(attacker) || attacker.team === unit.team) return false;

  if (unit.targetBuildingId) return true;

  const cur = unit.targetUnitId ? State.units.get(unit.targetUnitId) : null;
  if (!cur || isLowPriorityUnitTarget(cur)) return true;

  if (enemyIsAttackingUnit(cur, unit)) return false;

  return enemyIsAttackingUnit(attacker, unit);
}

/** While chewing on a soft target, scan for visible combat units that are shooting us. */
function tryRetargetForImmediateThreat(unit) {
  if (unit.state !== 'attacking' || (unit.damage <= 0 && unit.type !== 'engineer')) return false;

  const cur = unit.targetUnitId ? State.units.get(unit.targetUnitId) : null;
  const softTarget = unit.targetBuildingId != null || isLowPriorityUnitTarget(cur);
  if (!softTarget) return false;

  const visionR = (unit.visionRange != null ? unit.visionRange : unit.range) * 1.05;
  let best = null;
  let bestScore = -Infinity;

  const nearby = unitGrid.queryRadiusFiltered(unit.x, unit.z, visionR, e => {
    if (!isEnemyCombatUnit(e) || e.team === unit.team) return false;
    if (!Fog.isVisibleToTeam(unit.team, e.x, e.z)) return false;
    return Pathfinding.getDistance(unit.x, unit.z, e.x, e.z) <= visionR;
  });

  for (const e of nearby) {
    const d = Pathfinding.getDistance(unit.x, unit.z, e.x, e.z);
    let score = e.damage;
    if (enemyIsAttackingUnit(e, unit)) score += 500;
    const weaponR = e.range > 0 ? e.range : 0;
    if (d <= weaponR * 1.05) score += 120;
    score -= d * 0.4;

    if (score > bestScore) {
      bestScore = score;
      best = e;
    }
  }

  if (!best || best.id === unit.targetUnitId) return false;
  if (!enemyIsAttackingUnit(best, unit) && bestScore < 80) return false;

  return beginEngagingUnit(unit, best);
}

/**
 * Move orders skip broad auto-acquire, but units must fight back when blocked or in weapon range.
 */
function tryEngageWhileOnMoveOrder(unit) {
  if (!unit.playerCommanded || unit.state !== 'moving') return false;
  if (unit.damage <= 0 && unit.type !== 'engineer') return false;

  const weaponR = unit.range > 0 ? unit.range : 1.5;
  const visionR = unit.visionRange != null ? unit.visionRange : unit.range;
  const scanR = Math.min(Math.max(weaponR, 2.5) * 1.08, visionR * 1.05);

  const enemy = unitGrid.findNearest(unit.x, unit.z, scanR, e => {
    if (e.team === unit.team || e.hp <= 0 || e.damage <= 0) return false;
    if (!Fog.isVisibleToTeam(unit.team, e.x, e.z)) return false;
    return Pathfinding.getDistance(unit.x, unit.z, e.x, e.z) <= scanR;
  });
  if (!enemy) return false;

  const dist = Pathfinding.getDistance(unit.x, unit.z, enemy.x, enemy.z);
  const inWeaponRange = dist <= weaponR * 1.05;
  const pathBlocked = (unit._pathBlockedStreak || 0) >= 3;
  if (!inWeaponRange && !pathBlocked) return false;

  return beginEngagingUnit(unit, enemy);
}

/** Idle units drift from separation or post-fight; march home when no threat in acquisition range. */
function tryReturnToGuardPosition(unit) {
  if (unit.type === 'engineer') return false;
  if (unit.state !== 'idle' || !unit.guardPos || unit.playerCommanded || unit.followLeadId) {
    return false;
  }
  const gh = unit.guardPos;
  const d = Pathfinding.getDistance(unit.x, unit.z, gh.x, gh.z);
  if (d < 3.6) return false;

  const visionR = (unit.visionRange != null ? unit.visionRange : unit.range) * 1.05;
  const threat = unitGrid.findNearest(unit.x, unit.z, visionR, e =>
    e.team !== unit.team &&
    e.hp > 0 &&
    Fog.isVisibleToTeam(unit.team, e.x, e.z) &&
    Pathfinding.getDistance(unit.x, unit.z, e.x, e.z) <= visionR
  );
  if (threat) return false;

  startMoveToGuardPos(unit);
  return unit.state === 'moving';
}

// --- Combat ---
export function updateCombat(time, dt) {
  State.buildings.forEach(b => {
    if ((b.captureProgress || 0) > 0) b._captureTick = false;
  });

  State.units.forEach(unit => {
    if (unit.hp <= 0 || unit.type === 'harvester') return;

    if (unit.damage <= 0 && unit.type !== 'engineer') return;

    if (unit.state === 'attacking') {
      handleAttackState(unit, time, dt);
    } else if (unit.state === 'idle') {
      if (!tryReturnToGuardPosition(unit)) {
        autoAcquireTarget(unit);
      }
    } else if (unit.state === 'moving' && unit.playerCommanded) {
      tryEngageWhileOnMoveOrder(unit);
    } else if (unit.state === 'moving' && !unit.playerCommanded) {
      autoAcquireTarget(unit);
    }
  });

  State.buildings.forEach(b => {
    if ((b.captureProgress || 0) > 0 && !b._captureTick) {
      b.captureProgress = 0;
    }
    delete b._captureTick;
  });
}

function isVehicleNeedingRepair(u) {
  return u && u.hp > 0 && u.category === 'vehicle' && u.hp + 1e-4 < u.maxHp;
}

/** Engineers restore friendly vehicle HP when in range, or when following a damaged friendly vehicle. */
export function updateEngineerRepair(dt) {
  const engStats = UNIT_TYPES.engineer;
  const repairPerSec = engStats.repairRate ?? 15;
  const heal = repairPerSec * dt;
  if (heal <= 0) return;

  State.units.forEach(unit => {
    if (unit.type !== 'engineer' || unit.hp <= 0) return;
    if (unit.state === 'attacking' && (unit.targetBuildingId || unit.targetUnitId)) return;

    let patient = null;

    if (unit.followLeadId) {
      const lead = State.units.get(unit.followLeadId);
      if (lead && lead.team === unit.team && isVehicleNeedingRepair(lead)) {
        const d = Pathfinding.getDistance(unit.x, unit.z, lead.x, lead.z);
        if (d <= ENGINEER_REPAIR_RANGE) patient = lead;
      }
    }

    if (!patient && (unit.state === 'idle' || (unit.state === 'moving' && !unit.playerCommanded))) {
      const r = ENGINEER_REPAIR_RANGE;
      patient = unitGrid.findNearest(unit.x, unit.z, r, other =>
        other.id !== unit.id &&
        other.team === unit.team &&
        isVehicleNeedingRepair(other)
      );
    }

    if (!patient) return;

    const add = Math.min(patient.maxHp - patient.hp, heal);
    if (add <= 0) return;
    patient.hp += add;
    const dx = patient.x - unit.x;
    const dz = patient.z - unit.z;
    if (dx * dx + dz * dz > 0.01) {
      unit.rotation = Math.atan2(dx, dz);
    }
  });
}

function resumeFollowAfterEscort(unit) {
  const leadId = unit.followLeadId;
  if (!leadId) return false;
  const lead = State.units.get(leadId);
  if (!lead || lead.hp <= 0) {
    unit.followLeadId = null;
    return false;
  }
  unit.state = 'idle';
  unit.targetUnitId = null;
  unit.targetBuildingId = null;
  unit.targetPos = null;
  unit.path = null;
  unit._squadSyncSig = null;
  return true;
}

function handleAttackState(unit, time, dt) {
  if (tryRetargetForImmediateThreat(unit)) return;

  let target = null;

  // Get the target
  if (unit.targetUnitId) {
    target = State.units.get(unit.targetUnitId);
    if (!target || target.hp <= 0) {
      unit.targetUnitId = null;
      unit.targetPos = null;
      if (resumeFollowAfterEscort(unit)) return;
      startMoveToGuardPos(unit);
      return;
    }
  } else if (unit.targetBuildingId) {
    target = State.buildings.get(unit.targetBuildingId);
    if (!target || target.hp <= 0) {
      unit.targetBuildingId = null;
      unit.targetPos = null;
      if (resumeFollowAfterEscort(unit)) return;
      startMoveToGuardPos(unit);
      return;
    }
  } else {
    startMoveToGuardPos(unit);
    return;
  }

  if (target.team === unit.team) {
    unit.targetUnitId = null;
    unit.targetBuildingId = null;
    unit.targetPos = null;
    if (resumeFollowAfterEscort(unit)) return;
    startMoveToGuardPos(unit);
    return;
  }

  const dx = target.x - unit.x;
  const dz = target.z - unit.z;
  const centerDist = Math.sqrt(dx * dx + dz * dz);

  /** For buildings use hull distance (square footprint); circle `center - size/2` mis-ranges diagonals. */
  const dist =
    !target.category && target.type
      ? distancePointToBuildingHull(unit.x, unit.z, target)
      : centerDist;
  let effectiveRange = unit.range > 0 ? unit.range : 1.5;
  if (unit.type === 'engineer' && !target.category) {
    effectiveRange = Math.max(
      Pathfinding.getEngineerMinEdgeDistanceToBuilding(target),
      ENGINEER_CAPTURE_EDGE_REACH
    );
  } else if (unit.type === 'engineer') {
    effectiveRange = 4.0;
  }

  const visionR = unit.visionRange != null ? unit.visionRange : unit.range;
  /** Weapon reach is capped by personal vision; must also lie in current team vision (fog value 2). */
  let maxEngageRange = effectiveRange;
  if (unit.type !== 'engineer') {
    maxEngageRange = Math.min(effectiveRange, visionR);
  }

  const teamSeesCell = Fog.isVisibleToTeam(unit.team, target.x, target.z);
  const inPersonalVisionDisc = centerDist <= visionR;
  const canSee = inPersonalVisionDisc && teamSeesCell;

  if (canSee) {
    unit._losLastSeen = time;
  }

  // 1. LOS chase expiry — only after we have actually seen the target once.
  // (Undefined _losLastSeen used to compare against performance.now() → instant cancel for far units.)
  const playerExplicitAttack =
    unit.playerCommanded && (unit.targetUnitId != null || unit.targetBuildingId != null);
  if (
    !playerExplicitAttack &&
    !canSee &&
    unit._losLastSeen != null &&
    time - unit._losLastSeen > 2500
  ) {
    unit.targetUnitId = null;
    unit.targetBuildingId = null;
    if (resumeFollowAfterEscort(unit)) return;
    startMoveToGuardPos(unit);
    return;
  }

  // 2. Defensive leash: auto-defenders stay near guardPos; don't hunt fleeing enemies across the map.
  if (isAutoDefendHold(unit)) {
    const targetWx = target.x;
    const targetWz = target.z;
    if (exceedsGuardLeash(unit, unit.x, unit.z) || exceedsGuardLeash(unit, targetWx, targetWz)) {
      disengageToGuard(unit);
      return;
    }
  }

  if (dist > maxEngageRange) {
    const staleChase =
      !unit.targetPos ||
      !unit.path ||
      time - (unit._lastPathTime || 0) > 500;
    if (staleChase) {
      if (unit.targetBuildingId && !target.category) {
        unit.targetPos = approachPointOutsideBuilding(unit.x, unit.z, target);
      } else {
        unit.targetPos = { x: target.x, z: target.z };
      }
      unit.path = null;
      unit._lastPathTime = time;
      if (unit.playerCommanded) resetUnitPathThrottle(unit);
    }
  } else if (canSee) {
    // In range and can see — stop and fire (or capture)
    unit.targetPos = null;
    unit.path = null;

    // Face target
    unit.rotation = Math.atan2(dx, dz);

    // DEEP BLUE KITING: Long-range tactical retreat (moonwalking) while firing
    const isBot = State.players[unit.ownerId]?.isBot;
    if (isBot && unit.range >= 25 && target.category && centerDist > 0 && centerDist < unit.range * 0.5) {
      const kiteSpeed = unit.speed * 0.6 * dt;
      const nx = unit.x - (dx / centerDist) * kiteSpeed;
      const nz = unit.z - (dz / centerDist) * kiteSpeed;
      if (Pathfinding.isWorldMovementSegmentWalkable(unit.x, unit.z, nx, nz)) {
        unit.x = nx;
        unit.z = nz;
      }
    }

    if (unit.type === 'engineer' && !target.category) {
      advanceEngineerCapture(target, unit, dt);
    } else {
      // Fire check
      const fireDelay = unit.fireRate > 0 ? unit.fireRate * 1000 : 1000;
      if (time - unit.lastFireTime >= fireDelay && unit.damage > 0) {
        fireAtTarget(unit, target, time);
      }
    }
  } else {
    // In weapon range but not currently visible — keep chasing last known position.
    const staleChase =
      !unit.targetPos ||
      !unit.path ||
      time - (unit._lastPathTime || 0) > 500;
    if (staleChase) {
      if (unit.targetBuildingId && !target.category) {
        unit.targetPos = approachPointOutsideBuilding(unit.x, unit.z, target);
      } else {
        unit.targetPos = { x: target.x, z: target.z };
      }
      unit.path = null;
      unit._lastPathTime = time;
      if (unit.playerCommanded) resetUnitPathThrottle(unit);
    }
  }
}

function fireAtTarget(unit, target, time) {
  if (target.category && unit.damage > 0) {
    const visionR = unit.visionRange != null ? unit.visionRange : unit.range;
    if (Pathfinding.getDistance(unit.x, unit.z, target.x, target.z) > visionR + 0.5) return;
    if (!Fog.isVisibleToTeam(unit.team, target.x, target.z)) return;
  }

  unit.lastFireTime = time;

  // Calculate damage with multipliers at fire time (capture current state)
  let dmg = unit.damage;
  if (target.category === 'infantry') {
    dmg *= unit.dmgVsInfantry;
  } else if (target.category === 'vehicle') {
    dmg *= unit.dmgVsVehicle;
  } else if (target.type && !target.category) {
    // It's a building
    dmg *= unit.dmgVsBuilding;
  }
  const finalDmg = Math.round(dmg);

  // Prepare the impact callback
  const onHit = () => {
    // Verify target still exists in state
    const currentTarget = State.units.get(target.id) || State.buildings.get(target.id);
    if (currentTarget && currentTarget.hp > 0) {
      applyDamage(currentTarget, finalDmg, unit);
    }

    // AoE damage applied at impact point
    if (unit.aoe > 0) {
      // Impact coordinates (where the target was or current pos)
      const hitX = currentTarget ? currentTarget.x : target.x;
      const hitZ = currentTarget ? currentTarget.z : target.z;
      
      const nearby = unitGrid.queryRadius(hitX, hitZ, unit.aoe);
      nearby.forEach(u => {
        if (u.team !== unit.team && u.hp > 0 && u.id !== target.id) {
          let aoeDmg = Math.round(finalDmg * 0.5); // 50% AoE splash
          applyDamage(u, aoeDmg, unit);
        }
      });
    }
    
    // Impact visual/sound could go here too
    if (unit.aoe > 0) {
      const cnt = Math.max(4, Math.round(unit.aoe / 2));
      Effects.spawnExplosion(target.x, 0.5, target.z, cnt);
      Audio.playExplosionSound(0.22, target.x, target.z);
      State.pushHostFx({ kind: 'aoe_impact', x: target.x, z: target.z, count: cnt, volume: 0.22 });
    }
  };

  // Spawn projectile visual with the callback
  const targetY = target.category ? 0.8 : (target.type ? 2 : 0.8);
  const distance = Pathfinding.getDistance(unit.x, unit.z, target.x, target.z);
  const duration = Math.min(500, distance * 30);

  const isMpClient = State.gameSession.isMultiplayer && !State.gameSession.isHost;

  if (!isMpClient) {
    Renderer.spawnProjectile(
      unit.x, 1.2, unit.z,
      target.x, targetY, target.z,
      PLAYER_COLORS[unit.ownerId],
      duration,
      onHit // Passed as 9th argument
    );
    Audio.playShotSound(unit.type, unit.x, unit.z);
  }

  State.pushHostFx({
    kind: 'shot',
    unitType: unit.type,
    x: unit.x,
    z: unit.z,
    tx: target.x,
    ty: targetY,
    tz: target.z,
    color: PLAYER_COLORS[unit.ownerId] ?? 0xffffff,
    duration,
  });
}

function applyDamage(target, damage, attacker = null) {
  target.hp = Math.max(0, target.hp - damage);

  if (target.hp <= 0) {
    if (target.category) {
      destroyUnit(target, attacker);
    } else {
      destroyBuilding(target);
    }
  } else if (attacker && target.category) {
    // Damage reaction for units that survive the hit
    if (target.type === 'harvester' || target.type === 'mobileHq') {
      // Harvesters / Mobile HQ under attack should flee toward primary HQ
      const hq = State.getPlayerHQ(target.ownerId);
      if (hq && target.state !== 'moving') {
        target.targetPos = { x: hq.x, z: hq.z };
        target.path = null;
        target.state = 'moving';
      }
    } else if (target.damage > 0 && attacker && State.units.has(attacker.id)) {
      if (target.state === 'idle' || target.state === 'moving') {
        beginEngagingUnit(target, attacker);
      } else if (target.state === 'attacking' && shouldPrioritizeAttackerOverCurrentTarget(target, attacker)) {
        beginEngagingUnit(target, attacker);
      }
    }
  } else if (target.category && !attacker) {
    // Taking damage from unseen source (e.g. sniper in fog)
    // Fall back to guard position or HQ to avoid being "picked off"
    if (!target.playerCommanded || target.state === 'idle') {
      const hq = State.getPlayerHQ(target.ownerId);
      const retreatTo = target.guardPos || (hq ? { x: hq.x, z: hq.z } : null);
      if (retreatTo && Pathfinding.getDistance(target.x, target.z, retreatTo.x, retreatTo.z) > 10) {
        target.targetPos = { x: retreatTo.x, z: retreatTo.z };
        target.state = 'moving';
        target.path = null;
      }
    }
  }
}

/** Stop shooting / re-acquiring a structure that just flipped to a new owner (capture complete). */
export function clearUnitsTargetingBuilding(buildingId) {
  State.units.forEach(u => {
    if (u.hp <= 0 || u.targetBuildingId !== buildingId) return;
    u.targetBuildingId = null;
    u.targetPos = null;
    if (u.state === 'attacking') {
      startMoveToGuardPos(u);
    }
  });
}

function advanceEngineerCapture(building, engineer, dt) {
  if (!building.isBuilt) return;
  if (building.team === engineer.team) return;

  const durationSec = getCaptureDurationSeconds(building.maxHp || 1);
  building.captureProgress = Math.min(1, (building.captureProgress || 0) + dt / durationSec);
  building._captureTick = true;

  if (building.captureProgress >= 1 - 1e-6) {
    building.captureProgress = 0;
    const prevOwnerId = building.ownerId;
    building.ownerId = engineer.ownerId;
    building.team = engineer.team;
    State.moveBuildingBetweenPlayers(building.id, prevOwnerId, engineer.ownerId);
    clearUnitsTargetingBuilding(building.id);
    Audio.playUnitReadySound(engineer.x, engineer.z);
    State.pushHostFx({ kind: 'capture_complete', x: engineer.x, z: engineer.z });
    console.log(`Engineer captured building ${building.type}!`);
    destroyUnit(engineer);
    checkWinCondition();
    return;
  }

  if (timeSince(engineer, '_capSoundTime', 0.45, dt)) {
    Audio.playCaptureTickSound(engineer.x, engineer.z);
    State.pushHostFx({ kind: 'capture_tick', x: engineer.x, z: engineer.z });
  }
}

/** Lightweight periodic gate using engineer fields (seconds since last trigger). */
function timeSince(unit, key, intervalSec, dt) {
  unit[key] = (unit[key] || 0) + dt;
  if (unit[key] >= intervalSec) {
    unit[key] = 0;
    return true;
  }
  return false;
}

/** True if the unit is within range of any friendly built War Factory (for vehicle sell). */
export function unitNearFriendlyWarFactory(unit) {
  let best = Infinity;
  State.buildings.forEach(b => {
    if (b.type !== 'warFactory' || !b.isBuilt || b.hp <= 0) return;
    if (b.team !== unit.team) return;
    const d = Pathfinding.getDistance(unit.x, unit.z, b.x, b.z);
    if (d < best) best = d;
  });
  return best <= VEHICLE_SELL_WAR_FACTORY_RANGE;
}

/** @returns {string|null} failure code, or null if this unit may be sold (no side effects). */
export function getSellVehicleFailureCodeForUnit(u, actingPlayerId) {
  if (!u || u.hp <= 0) return 'invalid_target';
  if (u.ownerId !== actingPlayerId) return 'not_owner';
  const st = UNIT_TYPES[u.type];
  if (!st) return 'invalid_unit_type';
  if (st.category !== 'vehicle') return 'not_sellable_unit';
  // Mobile HQ is a deployable base — never sell as a normal vehicle. Harvesters are sellable like other vehicles.
  if (u.type === 'mobileHq') return 'not_sellable_unit';
  if (!unitNearFriendlyWarFactory(u)) return 'not_near_war_factory';
  return null;
}

/**
 * From current selection: **selected** vehicles the local player can sell (each must be in WF range)
 * and combined refund. Used by HUD / confirm UI only.
 */
export function computeVehicleSellFromSelection(actingPlayerId) {
  const unitIds = [];
  let totalRefund = 0;
  State.selectedUnits.forEach(id => {
    const u = State.units.get(id);
    if (getSellVehicleFailureCodeForUnit(u, actingPlayerId)) return;
    unitIds.push(id);
    totalRefund += UNIT_TYPES[u.type]?.cost ?? 0;
  });
  return { unitIds, totalRefund };
}

/**
 * Host: sell each eligible unit in `unitIds`; refunds build cost, no kill stats.
 * @returns {{ ok: true, sold: number } | { ok: false, code: string }}
 */
export function sellVehiclesForPlayer(unitIds, actingPlayerId) {
  if (!Array.isArray(unitIds) || unitIds.length === 0) {
    return { ok: false, code: 'no_units' };
  }
  let sold = 0;
  let sellX;
  let sellZ;
  for (let i = 0; i < unitIds.length; i++) {
    const u = State.units.get(unitIds[i]);
    if (getSellVehicleFailureCodeForUnit(u, actingPlayerId)) continue;
    if (sellX == null) {
      sellX = u.x;
      sellZ = u.z;
    }
    const cost = UNIT_TYPES[u.type]?.cost ?? 0;
    const owner = State.players[u.ownerId];
    if (owner) owner.credits += cost;
    destroyUnit(u, null, { sold: true });
    sold++;
  }
  if (sold === 0) return { ok: false, code: 'no_sellable_vehicles' };
  if (!State.gameSession.isMultiplayer || State.gameSession.isHost) {
    Audio.playUnitReadySound(sellX, sellZ);
  }
  State.pushHostFx({ kind: 'sell_complete', x: sellX, z: sellZ });
  return { ok: true, sold };
}

/** Remove unit from play (e.g. bot economy sacrifices). Optional attacker for stats/fog. */
export function destroyUnit(unit, attacker = null, opts = {}) {
  const sold = !!(opts && opts.sold);
  unit.hp = 0;
  unit.state = 'dead';
  
  // LOG DANGER ZONE for bots
  const player = State.players[unit.ownerId];
  if (!sold && player && player.isBot && player.botMemory) {
    // Death Snapshot: scan for nearby enemies we can see
    const threats = { infantry: 0, vehicle: 0, types: {} };
    const scanRadius = 25; 
    let addedAttacker = false;

    const nearbyEnemies = unitGrid.queryRadius(unit.x, unit.z, scanRadius).filter(u => 
      u.team !== unit.team && u.hp > 0 && Fog.isVisibleToTeam(unit.team, u.x, u.z)
    );

    nearbyEnemies.forEach(e => {
      if (e.category === 'infantry') threats.infantry++;
      else if (e.category === 'vehicle') threats.vehicle++;
      threats.types[e.type] = (threats.types[e.type] || 0) + 1;
      if (attacker && e.id === attacker.id) addedAttacker = true;
    });

    // If the attacker was a sniper/artillery unseen in the fog, log it anyway!
    if (attacker && !addedAttacker) {
      if (attacker.category === 'infantry') threats.infantry++;
      else if (attacker.category === 'vehicle') threats.vehicle++;
      threats.types[attacker.type] = (threats.types[attacker.type] || 0) + 1;
    }

    const killerType = attacker?.type ?? null;
    const longRangeKiller =
      killerType === 'sniper' ||
      killerType === 'artillery' ||
      (killerType && (UNIT_TYPES[killerType]?.range ?? 0) >= 23);

    player.botMemory.dangerZones.push({
      x: unit.x,
      z: unit.z,
      time: State.gameSession.elapsedTime,
      threats,
      killerType,
      longRangeKiller,
    });
    // Keep internal memory lean (last 10 deaths)
    if (player.botMemory.dangerZones.length > 10) {
      player.botMemory.dangerZones.shift();
    }
  }

  // Stats: Track losses and kills (skipped when sold back for credits)
  if (!sold && player && player.stats) player.stats.unitsLost++;
  
  const atkPlayer = attacker ? State.players[attacker.ownerId] : null;
  if (!sold && atkPlayer && atkPlayer.stats && attacker.ownerId !== unit.ownerId) {
    atkPlayer.stats.kills++;
  }

  const dx = unit.x;
  const dz = unit.z;

  const deadId = unit.id;
  State.units.forEach(u => {
    if (u.hp <= 0) return;
    if (u.followLeadId !== deadId) return;
    clearSquadFollowerLink(u);
    u.state = 'idle';
    u.targetUnitId = null;
    u.targetBuildingId = null;
    u.targetPos = null;
    u.path = null;
  });

  State.removeUnit(unit.id);
  State.selectedUnits.delete(unit.id);
  if (!sold) {
    Audio.playExplosionSound(0.3, dx, dz);
    Effects.spawnExplosion(dx, 0.5, dz, 8);
    State.pushHostFx({ kind: 'unit_death', x: dx, z: dz, volume: 0.3, particles: 8 });
  }

  checkWinCondition();
}

function destroyBuilding(building) {
  building.hp = 0;

  const bx = building.x;
  const bz = building.z;

  const player = State.players[building.ownerId];
  if (player && player.stats) player.stats.buildingsLost++;

  State.removeBuilding(building.id);
  Audio.playExplosionSound(0.5, bx, bz);
  Effects.spawnExplosion(bx, 0.5, bz, 12);
  State.pushHostFx({ kind: 'building_death', x: bx, z: bz, volume: 0.5 });

  // Rebuild nav mesh since building is gone
  Pathfinding.rebuildNavMesh();

  checkWinCondition();
}

function autoAcquireTarget(unit) {
  const visionR = unit.visionRange != null ? unit.visionRange : unit.range;
  /** Auto-pick targets only inside personal vision (same cap as weapon fire). */
  const scanRange = visionR * 1.05;
  const guardLeash = isAutoDefendHold(unit) ? getGuardEngageLeash(unit) : null;

  const withinGuardLeash = (wx, wz) => {
    if (guardLeash == null) return true;
    return distFromGuard(unit, wx, wz) <= guardLeash;
  };

  // Engineers deal no weapon damage — only capture buildings; never chase enemy units here.
  if (unit.type === 'engineer' && unit.damage <= 0) {
    const engScan = Math.max(scanRange, 36);
    let nearestBldgDist = engScan;
    let nearestBldg = null;
    State.buildings.forEach(b => {
      if (b.hp <= 0 || !b.isBuilt) return;
      if (b.team === unit.team) return;
      const dist = Pathfinding.getDistance(unit.x, unit.z, b.x, b.z);
      if (dist >= engScan) return;
      if (!withinGuardLeash(b.x, b.z)) return;
      if (!Fog.wasExploredByTeam(unit.team, b.x, b.z)) return;
      if (dist < nearestBldgDist) {
        nearestBldgDist = dist;
        nearestBldg = b;
      }
    });
    if (nearestBldg) {
      unit.state = 'attacking';
      unit.targetBuildingId = nearestBldg.id;
      unit.targetUnitId = null;
      unit.playerCommanded = false;
    }
    return;
  }

  const isBot = State.players[unit.ownerId]?.isBot;
  let targetToJoin = null;

  // DEEP BLUE FOCUS FIRE: Bots coordinate fire by sharing targets within local squads
  if (isBot) {
    const localSquad = unitGrid.queryRadius(unit.x, unit.z, 15).filter(u => 
      u.ownerId === unit.ownerId && u.state === 'attacking' && u.targetUnitId
    );
    if (localSquad.length > 0) {
      const highestPriorityTarget = State.units.get(localSquad[0].targetUnitId);
      if (highestPriorityTarget && highestPriorityTarget.hp > 0) {
        const dJoin = Pathfinding.getDistance(unit.x, unit.z, highestPriorityTarget.x, highestPriorityTarget.z);
        if (
          dJoin <= visionR * 1.05 &&
          Fog.isVisibleToTeam(unit.team, highestPriorityTarget.x, highestPriorityTarget.z) &&
          withinGuardLeash(highestPriorityTarget.x, highestPriorityTarget.z)
        ) {
          targetToJoin = highestPriorityTarget;
        }
      }
    }
  }

  if (targetToJoin) {
    unit.state = 'attacking';
    unit.targetUnitId = targetToJoin.id;
    unit.playerCommanded = false;
    return;
  }

  const enemy = unitGrid.findNearest(unit.x, unit.z, scanRange, e => {
    if (e.team === unit.team || e.hp <= 0) return false;
    if (!Fog.isVisibleToTeam(unit.team, e.x, e.z)) return false;
    if (!withinGuardLeash(e.x, e.z)) return false;
    return Pathfinding.getDistance(unit.x, unit.z, e.x, e.z) <= visionR * 1.05;
  });

  if (enemy) {
    unit.state = 'attacking';
    unit.targetUnitId = enemy.id;
    unit.playerCommanded = false;
    return;
  }

  // Enemy buildings: only if this unit is close enough to personally spot them and the cell is lit now
  let nearestBldgDist = visionR * 1.05;
  let nearestBldg = null;
  State.buildings.forEach(b => {
    if (b.hp <= 0) return;
    if (b.team === unit.team) return;
    const dist = Pathfinding.getDistance(unit.x, unit.z, b.x, b.z);
    if (dist > visionR * 1.05) return;
    if (!withinGuardLeash(b.x, b.z)) return;
    if (!Fog.isVisibleToTeam(unit.team, b.x, b.z)) return;
    if (dist < nearestBldgDist) {
      nearestBldgDist = dist;
      nearestBldg = b;
    }
  });

  if (nearestBldg) {
    unit.state = 'attacking';
    unit.targetBuildingId = nearestBldg.id;
    unit.playerCommanded = false;
  }
}

export function checkWinCondition() {
  if (State.gameSession.gameOver) return;

  // Check each player has at least one living HQ (multiple HQs allowed after Mobile HQ deploy)
  const teamsAlive = new Set();
  State.players.forEach(player => {
    if (player.isDefeated) return;
    const hasLivingHq = State.getPlayerBuildings(player.id).some(
      b => b.type === 'hq' && b.hp > 0
    );
    if (!hasLivingHq) {
      player.isDefeated = true;
      console.log(`💀 Player ${player.id} (${player.name}) defeated!`);
    } else {
      teamsAlive.add(player.team);
    }
  });

  if (teamsAlive.size <= 1) {
    State.gameSession.gameOver = true;
    State.gameSession.winner = teamsAlive.size === 1 ? Array.from(teamsAlive)[0] : -1;
    console.log(`🏆 Game over! Winner: Team ${State.gameSession.winner}`);
  }
}

// --- Player commands ---
export function commandMove(unitIds, targetX, targetZ, options = {}) {
  const playerCommanded = options.playerCommanded !== false;
  const original = new Set(unitIds);
  const allIds = extendUnitIdsWithSquadFollowers(unitIds);
  const unitsArray = allIds.map(id => State.units.get(id)).filter(u => u && u.hp > 0);
  const numUnits = unitsArray.length;
  if (numUnits === 0) return;

  const cols = Math.ceil(Math.sqrt(numUnits));

  unitsArray.forEach((unit, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    const offsetX = (col - (cols - 1) / 2) * FORMATION_SPACING;
    const offsetZ = (row - (Math.ceil(numUnits / cols) - 1) / 2) * FORMATION_SPACING;

    // RUTHLESS ANTI-SNIPE: Add jitter to formation positions to break up straight lines
    const jitterAmount = 1.5;
    const rawX = targetX + offsetX + (Math.random() - 0.5) * jitterAmount;
    const rawZ = targetZ + offsetZ + (Math.random() - 0.5) * jitterAmount;
    const t = clampWorldToPlayableDisk(rawX, rawZ, 0);

    unit.state = 'moving';
    unit.targetPos = { x: t.x, z: t.z };
    unit.guardPos = { x: t.x, z: t.z };
    unit.targetUnitId = null;
    unit.targetBuildingId = null;
    if (original.has(unit.id)) {
      unit.followLeadId = null;
      unit.squadOffsetX = 0;
      unit.squadOffsetZ = 0;
      unit._squadSyncSig = null;
    }
    unit.path = null;
    unit.pathIndex = 0;
    unit.playerCommanded = playerCommanded;
    if (playerCommanded) resetUnitPathThrottle(unit);
  });
}

export function commandAttackMove(unitIds, targetX, targetZ) {
  commandMove(unitIds, targetX, targetZ);
  
  // IMMEDIATELY override playerCommanded to false so units auto-acquire targets while moving!
  // This prevents the "walk blindly into sniper fire" bug for AI.
  unitIds.forEach(id => {
    const unit = State.units.get(id);
    if (unit) unit.playerCommanded = false;
  });
}

export function commandAttackUnit(unitIds, targetUnitId) {
  const target = State.units.get(targetUnitId);
  if (!target || target.hp <= 0) return;
  const original = new Set(unitIds);
  const allIds = extendUnitIdsWithSquadFollowers(unitIds);
  for (let i = 0; i < allIds.length; i++) {
    const u = State.units.get(allIds[i]);
    if (u && u.team === target.team) return;
  }

  allIds.forEach(id => {
    const unit = State.units.get(id);
    if (!unit || unit.hp <= 0) return;
    unit.state = 'attacking';
    unit.targetUnitId = targetUnitId;
    unit.targetBuildingId = null;
    if (original.has(unit.id)) {
      unit.followLeadId = null;
      unit.squadOffsetX = 0;
      unit.squadOffsetZ = 0;
      unit._squadSyncSig = null;
    }
    unit.targetPos = { x: target.x, z: target.z };
    unit.path = null;
    unit.pathIndex = 0;
    unit._lastPathTime = 0;
    unit._losLastSeen = performance.now();
    unit.playerCommanded = true;
    resetUnitPathThrottle(unit);
  });
}

export function commandAttackBuilding(unitIds, targetBuildingId) {
  const target = State.buildings.get(targetBuildingId);
  if (!target || target.hp <= 0) return;
  const original = new Set(unitIds);
  const allIds = extendUnitIdsWithSquadFollowers(unitIds);
  for (let i = 0; i < allIds.length; i++) {
    const u = State.units.get(allIds[i]);
    if (u && u.team === target.team) return;
  }

  allIds.forEach(id => {
    const unit = State.units.get(id);
    if (!unit || unit.hp <= 0) return;
    unit.state = 'attacking';
    unit.targetUnitId = null;
    unit.targetBuildingId = targetBuildingId;
    if (original.has(unit.id)) {
      unit.followLeadId = null;
      unit.squadOffsetX = 0;
      unit.squadOffsetZ = 0;
      unit._squadSyncSig = null;
    }
    unit.targetPos = approachPointOutsideBuilding(unit.x, unit.z, target);
    unit.path = null;
    unit.pathIndex = 0;
    unit._lastPathTime = 0;
    unit._losLastSeen = performance.now();
    unit.playerCommanded = true;
    resetUnitPathThrottle(unit);
  });
}

export function commandStop(unitIds) {
  const allIds = extendUnitIdsWithSquadFollowers(unitIds);
  allIds.forEach(id => {
    const unit = State.units.get(id);
    if (!unit || unit.hp <= 0) return;
    unit.state = 'idle';
    unit.targetPos = null;
    unit.targetUnitId = null;
    unit.targetBuildingId = null;
    unit.followLeadId = null;
    unit.squadOffsetX = 0;
    unit.squadOffsetZ = 0;
    unit._squadSyncSig = null;
    unit.path = null;
    unit.playerCommanded = false;
  });
}

export function commandFollow(unitIds, targetUnitId) {
  const target = State.units.get(targetUnitId);
  if (!target || target.hp <= 0) return;

  unitIds.forEach(id => {
    const unit = State.units.get(id);
    if (!unit || unit.hp <= 0 || unit.id === targetUnitId) return;
    unit.followLeadId = targetUnitId;
    unit.squadOffsetX = unit.x - target.x;
    unit.squadOffsetZ = unit.z - target.z;
    unit._squadSyncSig = null;
    unit.targetBuildingId = null;
    unit.targetUnitId = null;
    unit.targetPos = null;
    unit.path = null;
    unit.pathIndex = 0;
    unit.state = 'idle';
    unit.playerCommanded = true;
  });
}
