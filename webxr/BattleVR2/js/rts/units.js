// ========================================
// RTSVR4 — Unit System
// Creation, movement, combat, death
// ========================================

import {
  UNIT_TYPES, BUILDING_TYPES, UNIT_SHAPES, FORMATION_SPACING,
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
  COMBAT_ACQUIRE_PER_FRAME,
} from './config.js';
import * as State from './state.js';
import * as Pathfinding from './pathfinding.js';
import * as Renderer from './renderer.js';
import * as Audio from './audio.js';
import * as Fog from './fog.js';
import * as Effects from './effects.js';
import * as Resources from './resources.js';
import * as Trace from './match-trace.js';
import { sampleGameplayEntityY } from './moon-environment.js';
import { unitGrid, buildingGrid } from './spatial.js';

/** Round-robin cursor for idle/moving auto-acquire. */
let acquireCursor = 0;

/** Min ms between A* requests for the same unit (stuck / crowded movers). */
const PATH_REQUERY_MS = 400;
/** Long bot hauls (explore / rally) back off longer so path queues don't saturate. */
const PATH_REQUERY_LONG_MS = 650;
/** Blocked steps on the same waypoint before discarding path and waiting PATH_REQUERY_MS. */
const PATH_BLOCKED_STREAK_REPATH = 4;

function combatFxY(x, z, lift = 0.55) {
  try {
    return sampleGameplayEntityY(x, z) + lift;
  } catch (_) {
    return lift;
  }
}

function pathRetryNotBefore(unit) {
  return unit._pathRetryAt || 0;
}

/** Sim-clock ms — must track gameUpdate time, not wall clock (fast-forward / tab hide). */
function simNowMs() {
  return (State.gameSession.elapsedTime || 0) * 1000;
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
  unit._pathRetryAt = simNowMs() + pathRetryDelayMs(unit, ms);
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
  // Bot attack-moves are NOT playerCommanded — still must keep the goal on path failure
  // or they idle against façades forever.
  if (unit.targetPos == null) return false;
  return unit.state === 'moving' || unit.state === 'attacking' || unitHasAttackOrder(unit)
    || unitHasPlayerMoveGoal(unit);
}

function unitHasPlayerPathPriority(unit) {
  return unit.playerCommanded && (unit.targetPos != null || unitHasAttackOrder(unit));
}

/** Clear A* backoff without claiming the unit "made progress" (stuck timer stays honest). */
function clearPathBackoff(unit) {
  unit._pathRetryAt = 0;
  unit._reachRetryAt = 0;
}

/** Player/bot attack or move orders should path immediately, not wait on crowd-retry backoff. */
function resetUnitPathThrottle(unit) {
  clearPathBackoff(unit);
  unit._searchHoldUntil = 0;
  unit._pathBlockedStreak = 0;
  unit._slideStreak = 0;
  resetStuckAnchor(unit);
}

function failedSearchHoldMs(unit) {
  let n = 0;
  const id = String(unit.id || '');
  for (let i = 0; i < id.length; i++) n = (n + id.charCodeAt(i) * (i + 1)) % 2000;
  return 3500 + n;
}

function holdFailedPathSearch(unit) {
  unit._searchHoldUntil = simNowMs() + failedSearchHoldMs(unit);
}

function canRunPathfindNow(unit) {
  if ((unit._searchHoldUntil || 0) > simNowMs()) return false;
  if (unitHasPlayerPathPriority(unit)) return true;
  return simNowMs() >= pathRetryNotBefore(unit);
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
  const visualPad =
    building.type === 'hq' ? 3.0
    : building.type === 'warFactory' ? 2.5
    : building.type === 'barracks' ? 2.0
    : building.type === 'refinery' ? 2.25
    : building.type === 'artilleryTurret' ? 1.5
    : building.type === 'turret' ? 1.25
    : building.type === 'solarPanel' ? 1.0
    : 1.25;
  // Sit just outside the nav block — old +1.35 put engineers outside ENGINEER_REPAIR_RANGE on HQ
  // (hullDist ≈ 6.35 vs repair 5.5 → walk up, idle, never heal).
  const standoff = h + OBSTACLE_BUFFER + visualPad + 0.35;
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
    /** Friendly building id this engineer was ordered to repair (mirrors followLeadId for vehicles). */
    repairBuildingId: null,
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

    /** Fog/orders proxy glued to the FP fighter — do not draw or select. */
    fpHero: !!options.fpHero,
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
 *
 * Exception: engineers / zero-damage units never inherit attack targets (they cannot fight).
 * While the lead fights they escort the lead's body, not the enemy.
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
    const nonCombatFollower = f.type === 'engineer' || !(f.damage > 0);

    const sig = [
      L.state,
      nonCombatFollower ? '' : (L.targetUnitId ?? ''),
      nonCombatFollower ? '' : (L.targetBuildingId ?? ''),
      L.targetPos ? `${L.targetPos.x},${L.targetPos.z}` : '',
      // Non-combat escorts also re-sync on lead motion while fighting.
      nonCombatFollower && L.state === 'attacking' ? `${L.x.toFixed(1)},${L.z.toFixed(1)}` : '',
      L.playerCommanded ? 1 : 0,
      nonCombatFollower ? 'nc' : 'c',
    ].join('|');

    if (f._squadSyncSig === sig) return;
    f._squadSyncSig = sig;

    f.playerCommanded = L.playerCommanded;

    if (L.state === 'attacking') {
      if (nonCombatFollower) {
        // Stay with the lead — never chase the enemy the lead is shooting.
        f.state = 'moving';
        f.targetUnitId = null;
        f.targetBuildingId = null;
        const c = clampWorldToPlayableDisk(L.x + ox, L.z + oz, 0);
        f.targetPos = { x: c.x, z: c.z };
        f.path = null;
        f.pathIndex = 0;
        return;
      }
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

function isVehicleNeedingRepair(u) {
  return u && u.hp > 0 && u.category === 'vehicle' && u.hp + 1e-4 < u.maxHp;
}

function isBuildingNeedingRepair(b) {
  return b && b.hp > 0 && b.hp + 1e-4 < b.maxHp;
}

function buildingRepairDist(ux, uz, building) {
  return distancePointToBuildingHull(ux, uz, building);
}

/**
 * Squad mirroring keeps a fixed XZ offset while the leader is idle, so an engineer ordered to
 * follow a damaged vehicle can sit outside {@link ENGINEER_REPAIR_RANGE} forever. Chase the
 * lead's **current** position until close enough to repair (overrides mirrored idle for this case).
 * Same for an explicit repair-building order.
 */
export function syncEngineerRepairApproach() {
  State.units.forEach(f => {
    if (f.type !== 'engineer' || f.hp <= 0) return;
    // Capture order — don't divert to repair approach.
    if (f.state === 'attacking' && f.targetBuildingId && !f.targetUnitId && !f.repairBuildingId) return;

    let gx = null;
    let gz = null;

    if (f.repairBuildingId) {
      const b = State.buildings.get(f.repairBuildingId);
      if (!b || b.hp <= 0 || b.team !== f.team) {
        f.repairBuildingId = null;
      } else if (buildingRepairDist(f.x, f.z, b) > ENGINEER_REPAIR_RANGE - 0.45) {
        const ap = approachPointOutsideBuilding(f.x, f.z, b);
        gx = ap.x;
        gz = ap.z;
      }
    }

    if (gx == null && f.followLeadId) {
      const lead = State.units.get(f.followLeadId);
      if (lead && lead.hp > 0 && lead.team === f.team
        && lead.category === 'vehicle' && isVehicleNeedingRepair(lead)) {
        const d = Pathfinding.getDistance(f.x, f.z, lead.x, lead.z);
        if (d > ENGINEER_REPAIR_RANGE - 0.45) {
          const c = clampWorldToPlayableDisk(lead.x, lead.z, 0);
          gx = c.x;
          gz = c.z;
        }
      }
    }

    if (gx == null) return;

    f.playerCommanded = true;
    f.state = 'moving';
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

export function updateMovement(dt) {
  const movers = [];
  State.units.forEach(unit => {
    if (unit.hp <= 0) return;
    if (unit.state === 'moving' || (unit.state === 'attacking' && unit.targetPos)) {
      movers.push(unit);
    }
  });
  movers.sort((a, b) => {
    const ap = unitHasPlayerPathPriority(a) ? 0 : 1;
    const bp = unitHasPlayerPathPriority(b) ? 0 : 1;
    return ap - bp;
  });
  for (const unit of movers) {
    unstickMoverIfFrozen(unit, dt);
    moveAlongPath(unit, dt);
  }

  // Spatial index for combat / AoE queries only — no unit↔unit soft-body push.
  rebuildUnitSpatialIndex();

  let hqNavDirty = false;
  State.units.forEach(unit => {
    if (unit.hp <= 0) return;
    if (unit.type === 'mobileHq') {
      const relocating = unit.state === 'moving' || !!(unit.path && unit.path.length > 0);
      if (!!unit._hqNavRelocating !== relocating) hqNavDirty = true;
      unit._hqNavRelocating = relocating;
    }
    if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
      const safe = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
      unit.x = safe.x;
      unit.z = safe.z;
      if (unit.path && unit.path.length) {
        unit.path = null;
        unit.pathIndex = 0;
        schedulePathRetry(unit, 32);
      }
    }
  });
  if (hqNavDirty) Pathfinding.rebuildNavMesh();
}

function escapeAndRepath(unit, gx, gz) {
  // One legal nav step only — never snap/teleport to cell centers.
  const beforeX = unit.x;
  const beforeZ = unit.z;
  const step = Pathfinding.bestEscapeStep(unit.x, unit.z, gx, gz);
  if (step) {
    const moved = Pathfinding.resolveNavMotion(unit.x, unit.z, step.x, step.z);
    if (!moved.blocked) {
      unit.x = moved.x;
      unit.z = moved.z;
    }
  }
  // Eject only when already inside a blocked cell (true wedge).
  if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
    const safe = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
    unit.x = safe.x;
    unit.z = safe.z;
  }
  unit.path = null;
  unit.pathIndex = 0;
  unit._preferGridPath = true;
  unit._pathBlockedStreak = (unit._pathBlockedStreak || 0) + 1;
  unit._slideStreak = 0;
  clearPathBackoff(unit);
  // CRITICAL: do NOT reset stuck timers on failed scrapes — that was why tanks
  // ground on façades forever (every blocked frame looked like "progress").
  const gained = Math.hypot(unit.x - beforeX, unit.z - beforeZ);
  if (gained > 0.35) resetStuckAnchor(unit);
}

/** Reset position-stuck detector (call when order changes or real progress happens). */
function resetStuckAnchor(unit) {
  unit._stuckAnchorX = unit.x;
  unit._stuckAnchorZ = unit.z;
  unit._stuckAnchorAt = simNowMs();
  unit._freezeX = unit.x;
  unit._freezeZ = unit.z;
  unit._stuckTime = 0;
}

/**
 * If world position has not moved for a while with an active goal, drop the path so A*
 * can try again. Does **not** teleport — that was causing visible jumps.
 */
function notePositionProgress(unit) {
  const now = simNowMs();
  if (unit._stuckAnchorX == null) {
    resetStuckAnchor(unit);
    return false;
  }
  const moved = Math.hypot(unit.x - unit._stuckAnchorX, unit.z - unit._stuckAnchorZ);
  if (moved > 0.4) {
    resetStuckAnchor(unit);
    return false;
  }
  if (now - (unit._stuckAnchorAt || now) > 1800) {
    unit.path = null;
    unit.pathIndex = 0;
    unit._preferGridPath = true;
    unit._slideStreak = 0;
    // Keep stuck clock — notePositionProgress alone is a soft recover; full unstick
    // still fires if we remain frozen after another repath cycle.
    unit._stuckAnchorAt = now;
    clearPathBackoff(unit);
    return true;
  }
  return false;
}

/** Creep one nav-legal step toward the goal while waiting on A* / slots. */
function creepTowardGoal(unit, dt) {
  const goal = unit.targetPos;
  if (!goal) return false;
  const dx = goal.x - unit.x;
  const dz = goal.z - unit.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.6) return false;
  const step = Math.min((unit.speed || 4) * dt, dist);
  const nx = unit.x + (dx / dist) * step;
  const nz = unit.z + (dz / dist) * step;
  const res = Pathfinding.resolveNavMotion(unit.x, unit.z, nx, nz);
  const gained = Math.hypot(res.x - unit.x, res.z - unit.z);
  if (res.blocked || gained < 0.02) {
    return forceUnwedgeStep(unit, goal.x, goal.z);
  }
  unit.x = res.x;
  unit.z = res.z;
  if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
    unit.rotation = Math.atan2(dx, dz);
  }
  return true;
}

/** Any legal escape step — prefer toward goal, else any open neighbor. */
function forceUnwedgeStep(unit, gx, gz) {
  const esc = Pathfinding.bestEscapeStep(unit.x, unit.z, gx, gz);
  if (esc) {
    const moved = Pathfinding.resolveNavMotion(unit.x, unit.z, esc.x, esc.z);
    if (!moved.blocked && Math.hypot(moved.x - unit.x, moved.z - unit.z) > 0.04) {
      unit.x = moved.x;
      unit.z = moved.z;
      return true;
    }
  }
  if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
    const s = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
    if (Math.hypot(s.x - unit.x, s.z - unit.z) > 0.04) {
      unit.x = s.x;
      unit.z = s.z;
      return true;
    }
  }
  return false;
}

/**
 * Hard recover for ANY mover frozen in place — tanks, infantry, engineers, not just HVs.
 * Rotates the approach around the goal so the next A* doesn't re-hit the same façade.
 */
function unstickMoverIfFrozen(unit, dt) {
  if (!unit.targetPos) {
    unit._stuckTime = 0;
    return;
  }
  if (unit.state !== 'moving' && unit.state !== 'attacking') {
    unit._stuckTime = 0;
    return;
  }

  const moved = Math.hypot(unit.x - (unit._freezeX ?? unit.x), unit.z - (unit._freezeZ ?? unit.z));
  if (moved > 0.5) {
    unit._freezeX = unit.x;
    unit._freezeZ = unit.z;
    unit._stuckTime = 0;
    return;
  }
  unit._stuckTime = (unit._stuckTime || 0) + dt;
  if (unit._stuckTime < 2.8) return;

  unit._stuckTime = 0;
  unit._freezeX = unit.x;
  unit._freezeZ = unit.z;
  // A failed search already has a hold. Clearing it here re-ran a full search
  // every 2.8s for every bot order marked playerCommanded.
  if ((unit._searchHoldUntil || 0) > simNowMs()) return;

  unit.path = null;
  unit.pathIndex = 0;
  unit._preferGridPath = true;
  unit._slideStreak = 0;
  clearPathBackoff(unit);

  // Slide off the lip, but keep the original destination. Replacing it with a
  // nearby reachable cell parked units on the near side of a canyon.
  forceUnwedgeStep(unit, unit.targetPos.x, unit.targetPos.z);
  unit._approachHoldUntil = simNowMs() + 400;
  resetStuckAnchor(unit);
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

    // Never keep an unwalkable goal — corner fog / building centers freeze movers.
    if (!Pathfinding.isPositionWalkable(unit.targetPos.x, unit.targetPos.z)) {
      const snapped = Pathfinding.snapWorldXZToWalkable(unit.targetPos.x, unit.targetPos.z);
      const snapOk = Pathfinding.isPositionWalkable(snapped.x, snapped.z);
      const nearSnap = snapOk && Math.hypot(snapped.x - unit.x, snapped.z - unit.z) < 2.8;
      const nearRaw = Math.hypot(unit.targetPos.x - unit.x, unit.targetPos.z - unit.z) < 6;
      if (!snapOk || nearSnap || nearRaw) {
        // As close as nav allows — finish the move order instead of grinding the obstacle.
        if (unit.state === 'moving') {
          unit.targetPos = null;
          unit.path = null;
          unit.pathIndex = 0;
          unit.state = 'idle';
          unit.playerCommanded = false;
        } else if (snapOk) {
          unit.targetPos = { x: snapped.x, z: snapped.z };
        }
        return;
      }
      unit.targetPos = { x: snapped.x, z: snapped.z };
    }

    if (!canRunPathfindNow(unit)) {
      creepTowardGoal(unit, dt);
      return;
    }
    if (!canTakePathfindSlot(unit)) {
      schedulePathRetry(unit, unitHasPlayerPathPriority(unit) ? 16 : 50);
      creepTowardGoal(unit, dt);
      return;
    }

    notePathfindSlotUsed(unit);
    // NEVER LOS-smooth around bases: string-pull chords skim building corners and glue units
    // to façades. Grid staircases are uglier but they complete.
    const smooth = false;
    unit._preferGridPath = false;
    let path = Pathfinding.findPath(unit.x, unit.z, unit.targetPos.x, unit.targetPos.z, smooth);
    if (!path || path.length === 0) {
      const goalWalkable = Pathfinding.isPositionWalkable(unit.targetPos.x, unit.targetPos.z);
      if (goalWalkable) {
        // Same goal just failed. findNearestReachable would search it again.
        holdFailedPathSearch(unit);
        creepTowardGoal(unit, dt);
        return;
      }
      const reachAt = unit._reachRetryAt || 0;
      if (simNowMs() < reachAt) {
        schedulePathRetry(unit, Math.max(unitHasPlayerPathPriority(unit) ? 16 : 50, reachAt - simNowMs()));
        creepTowardGoal(unit, dt);
        return;
      }
      unit._reachRetryAt = simNowMs() + (unitHasPlayerPathPriority(unit) ? 280 : 900);
      if (canTakePathfindSlot(unit)) {
        notePathfindSlotUsed(unit);
        const reachable = Pathfinding.findNearestReachable(
          unit.x, unit.z, unit.targetPos.x, unit.targetPos.z,
          unitHasPlayerPathPriority(unit) ? 44 : 36,
          unitHasPlayerPathPriority(unit),
        );
        if (reachable) {
          const goalD = Math.hypot(unit.targetPos.x - unit.x, unit.targetPos.z - unit.z);
          const viaD = Math.hypot(unit.targetPos.x - reachable.x, unit.targetPos.z - reachable.z);
          const moved = Math.hypot(reachable.x - unit.x, reachable.z - unit.z);
          const goalWalkable = Pathfinding.isPositionWalkable(unit.targetPos.x, unit.targetPos.z);
          // A lip on this side of a canyon is "reachable" but not a way around.
          // Only shorten the order when the real goal is blocked, or the via
          // actually advances toward it.
          if (!goalWalkable || (viaD + 8 < goalD && moved > 6)) {
            unit.targetPos = { x: reachable.x, z: reachable.z };
            if (canTakePathfindSlot(unit)) {
              notePathfindSlotUsed(unit);
              path = Pathfinding.findPath(unit.x, unit.z, reachable.x, reachable.z, false);
            }
          }
        }
      } else {
        schedulePathRetry(unit, unitHasPlayerPathPriority(unit) ? 16 : 80);
        return;
      }
    }
    if (!path || path.length === 0) {
      if (unitShouldKeepMoveGoal(unit)) {
        holdFailedPathSearch(unit);
        creepTowardGoal(unit, dt);
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
    unit._slideStreak = 0;

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
    unit._slideStreak = 0;
    if (unit.pathIndex >= unit.path.length) {
      unit.path = null;
      unit.pathIndex = 0;
      const goal = unit.targetPos;
      const remain = goal ? Math.hypot(goal.x - unit.x, goal.z - unit.z) : 0;
      // Partial path ended on the near side of an obstacle — keep the order and go around.
      if (remain > 3 && (unit.state === 'moving' || unit.state === 'attacking')) {
        unit._preferGridPath = true;
        resetUnitPathThrottle(unit);
        return;
      }
      if (unit.state === 'moving') {
        unit.targetPos = null;
        unit.state = 'idle';
        unit.playerCommanded = false;
      }
    }
    return;
  }

  // IMPORTANT: do NOT cancel paths when goal-distance stalls — going *around* a building
  // increases goal distance for seconds. That watchdog was the main “stuck on bases” bug.
  if (notePositionProgress(unit)) return;

  const moveSpeed = unit.speed * dt;
  const ratio = Math.min(1, moveSpeed / dist);
  const sep = formationSeparation(unit);
  let nx = unit.x + dx * ratio + sep.x * moveSpeed * 0.55;
  let nz = unit.z + dz * ratio + sep.z * moveSpeed * 0.55;
  if ((sep.x || sep.z) && !Pathfinding.isPositionWalkable(nx, nz)) {
    nx = unit.x + dx * ratio;
    nz = unit.z + dz * ratio;
  }
  const startBlocked = !Pathfinding.isPositionWalkable(unit.x, unit.z);
  const res = Pathfinding.resolveNavMotion(unit.x, unit.z, nx, nz);
  const intended = Math.hypot(nx - unit.x, nz - unit.z);
  const gained = Math.hypot(res.x - unit.x, res.z - unit.z);
  const slidOffIntent =
    Math.abs((res.x - unit.x) - (nx - unit.x)) > 0.04
    || Math.abs((res.z - unit.z) - (nz - unit.z)) > 0.04;
  const stuckOnEdge = !res.blocked && intended > 0.04 && gained < Math.max(0.02, intended * 0.25);
  if (res.blocked || stuckOnEdge) {
    const goal = unit.targetPos || wp;
    escapeAndRepath(unit, goal.x, goal.z);
    return;
  }
  unit.x = res.x;
  unit.z = res.z;
  clearPathBlockStreak(unit);
  if (startBlocked) {
    unit.path = null;
    unit.pathIndex = 0;
    unit._preferGridPath = true;
    return;
  }

  if (slidOffIntent) {
    unit._slideStreak = (unit._slideStreak || 0) + 1;
    // Sliding along a façade toward an unreachable chord — drop the bad waypoint.
    if (unit._slideStreak >= 10 && unit.pathIndex < unit.path.length - 1) {
      unit.pathIndex++;
      unit._slideStreak = 0;
      unit._preferGridPath = true;
    } else if (unit._slideStreak >= 18) {
      const goal = unit.targetPos || wp;
      escapeAndRepath(unit, goal.x, goal.z);
      return;
    }
  } else {
    unit._slideStreak = 0;
  }

  // Slide moved us but we are no longer aiming at the waypoint (wall-followed past it) —
  // drop this waypoint so we don't oscillate.
  const newDist = Math.hypot(wp.x - unit.x, wp.z - unit.z);
  if (newDist < 1.0) {
    unit.pathIndex++;
    unit._slideStreak = 0;
  } else if (
    gained > 0.05
    && newDist > dist + 0.5
    && unit.pathIndex < unit.path.length - 1
  ) {
    unit.pathIndex++;
    unit._slideStreak = 0;
  }

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

  const faceDx = unit.path && unit.pathIndex < unit.path.length
    ? unit.path[unit.pathIndex].x - unit.x
    : dx;
  const faceDz = unit.path && unit.pathIndex < unit.path.length
    ? unit.path[unit.pathIndex].z - unit.z
    : dz;
  if (Math.abs(faceDx) > 0.01 || Math.abs(faceDz) > 0.01) {
    unit.rotation = Math.atan2(faceDx, faceDz);
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

function beginEngagingUnit(unit, enemy, opts = {}) {
  if (!enemy || enemy.hp <= 0) return false;
  unit.state = 'attacking';
  unit.targetUnitId = enemy.id;
  unit.targetBuildingId = null;
  unit.targetPos = { x: enemy.x, z: enemy.z };
  unit.path = null;
  unit.pathIndex = 0;
  unit._lastPathTime = 0;
  unit._losLastSeen = performance.now();
  if (opts.retaliate) {
    // Survive long enough to return fire even if yanked slightly off the guard pad.
    unit._retaliateUntil = performance.now() + 10000;
  }
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
  return enemy && enemy.hp > 0 && !enemy.fpHero && enemy.damage > 0 && enemy.category;
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
 * Player move orders must be obeyed past idle/passive enemies.
 * Only break formation to retaliate against someone who is already attacking us.
 * (Taking damage also engages via applyDamage → beginEngagingUnit.)
 */
function tryEngageWhileOnMoveOrder(unit) {
  if (!unit.playerCommanded || unit.state !== 'moving') return false;
  if (unit.damage <= 0 && unit.type !== 'engineer') return false;

  const weaponR = unit.range > 0 ? unit.range : 1.5;
  const visionR = unit.visionRange != null ? unit.visionRange : unit.range;
  const scanR = Math.min(Math.max(weaponR, 2.5) * 1.15, visionR * 1.05);

  const attacker = unitGrid.findNearest(unit.x, unit.z, scanR, e => {
    if (e.team === unit.team || e.hp <= 0 || e.damage <= 0) return false;
    if (!Fog.isVisibleToTeam(unit.team, e.x, e.z)) return false;
    if (!enemyIsAttackingUnit(e, unit)) return false;
    return Pathfinding.getDistance(unit.x, unit.z, e.x, e.z) <= scanR;
  });
  if (!attacker) return false;

  return beginEngagingUnit(unit, attacker);
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

  const armed = [];
  State.units.forEach(unit => {
    if (unit.hp <= 0 || unit.type === 'harvester') return;
    if (unit.damage <= 0 && unit.type !== 'engineer') return;
    armed.push(unit);
  });

  for (let i = 0; i < armed.length; i++) {
    const unit = armed[i];
    if (unit.state === 'attacking') handleAttackState(unit, time, dt);
  }

  // Idle / moving auto-acquire: round-robin budget (not every unit every frame).
  const acquireBudget = Math.max(1, COMBAT_ACQUIRE_PER_FRAME | 0);
  const n = armed.length;
  if (n > 0) {
    let acquired = 0;
    let scanned = 0;
    let idx = acquireCursor % n;
    while (scanned < n && acquired < acquireBudget) {
      const unit = armed[idx];
      idx = (idx + 1) % n;
      scanned++;
      if (unit.state === 'attacking') continue;
      if (unit.state === 'idle') {
        if (!tryReturnToGuardPosition(unit)) autoAcquireTarget(unit);
        acquired++;
      } else if (unit.state === 'moving' && unit.playerCommanded) {
        tryEngageWhileOnMoveOrder(unit);
        acquired++;
      } else if (unit.state === 'moving' && !unit.playerCommanded) {
        autoAcquireTarget(unit);
        acquired++;
      }
    }
    acquireCursor = idx;
  }

  State.buildings.forEach(b => {
    if ((b.captureProgress || 0) > 0 && !b._captureTick) {
      b.captureProgress = 0;
    }
    delete b._captureTick;
  });
}

/** Engineers restore friendly vehicle/building HP when in range, or when ordered onto a patient. */
export function updateEngineerRepair(dt) {
  const engStats = UNIT_TYPES.engineer;
  const repairPerSec = engStats.repairRate ?? 15;
  const heal = repairPerSec * dt;
  if (heal <= 0) return;

  State.units.forEach(unit => {
    if (unit.type !== 'engineer' || unit.hp <= 0) return;
    // Capture-building orders only — don't heal while capturing.
    if (unit.state === 'attacking' && unit.targetBuildingId && !unit.targetUnitId && !unit.repairBuildingId) {
      return;
    }

    let patient = null; // unit or building

    if (unit.repairBuildingId) {
      const b = State.buildings.get(unit.repairBuildingId);
      if (!b || b.hp <= 0 || b.team !== unit.team) {
        unit.repairBuildingId = null;
      } else if (
        isBuildingNeedingRepair(b)
        && buildingRepairDist(unit.x, unit.z, b) <= ENGINEER_REPAIR_RANGE
      ) {
        patient = b;
      }
    }

    if (!patient && unit.followLeadId) {
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
      if (!patient) {
        const nearbyB = buildingGrid.queryRadiusFiltered(unit.x, unit.z, r + 6, b =>
          b.team === unit.team &&
          isBuildingNeedingRepair(b) &&
          buildingRepairDist(unit.x, unit.z, b) <= r
        );
        let best = null;
        let bestD = Infinity;
        for (let i = 0; i < nearbyB.length; i++) {
          const b = nearbyB[i];
          const d = buildingRepairDist(unit.x, unit.z, b);
          if (d < bestD) {
            bestD = d;
            best = b;
          }
        }
        patient = best;
      }
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
  // While retaliating from damage, skip leash so return-fire isn't cancelled mid-fight.
  // Only the *target* beyond leash ends a hold — being slightly outside yourself must not cancel.
  const retaliating =
    unit._retaliateUntil != null && time < unit._retaliateUntil;
  if (isAutoDefendHold(unit) && !retaliating && !playerExplicitAttack) {
    if (exceedsGuardLeash(unit, target.x, target.z)) {
      disengageToGuard(unit);
      return;
    }
  }

  if (dist > maxEngageRange) {
    const holdApproach =
      unit._approachHoldUntil != null && simNowMs() < unit._approachHoldUntil;
    const staleChase =
      !holdApproach && (
        !unit.targetPos ||
        !unit.path ||
        time - (unit._lastPathTime || 0) > 500
      );
    if (staleChase) {
      if (unit.targetBuildingId && !target.category) {
        const ap = approachPointOutsideBuilding(unit.x, unit.z, target);
        unit.targetPos = standWithFormSlot(unit, ap.x, ap.z);
      } else {
        unit.targetPos = standWithFormSlot(unit, target.x, target.z);
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
    const holdApproach =
      unit._approachHoldUntil != null && simNowMs() < unit._approachHoldUntil;
    const staleChase =
      !holdApproach && (
        !unit.targetPos ||
        !unit.path ||
        time - (unit._lastPathTime || 0) > 500
      );
    if (staleChase) {
      if (unit.targetBuildingId && !target.category) {
        const ap = approachPointOutsideBuilding(unit.x, unit.z, target);
        unit.targetPos = standWithFormSlot(unit, ap.x, ap.z);
      } else {
        unit.targetPos = standWithFormSlot(unit, target.x, target.z);
      }
      unit.path = null;
      unit._lastPathTime = time;
      if (unit.playerCommanded) resetUnitPathThrottle(unit);
    }
  }
}

export function fireAtTarget(unit, target, time) {
  if (!unit || !target || target.hp <= 0) return;
  // Hard friendly-fire guard (defense buildings + units): never damage same team/owner.
  if (target.team === unit.team || target.ownerId === unit.ownerId) return;

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
    if (
      currentTarget &&
      currentTarget.hp > 0 &&
      currentTarget.team !== unit.team &&
      currentTarget.ownerId !== unit.ownerId
    ) {
      applyDamage(currentTarget, finalDmg, unit);
    }

    // AoE damage applied at impact point
    if (unit.aoe > 0) {
      // Impact coordinates (where the target was or current pos)
      const hitX = currentTarget ? currentTarget.x : target.x;
      const hitZ = currentTarget ? currentTarget.z : target.z;

      const nearby = unitGrid.queryRadius(hitX, hitZ, unit.aoe);
      nearby.forEach(u => {
        if (
          u.hp > 0 &&
          u.id !== target.id &&
          u.team !== unit.team &&
          u.ownerId !== unit.ownerId
        ) {
          let aoeDmg = Math.round(finalDmg * 0.5); // 50% AoE splash
          applyDamage(u, aoeDmg, unit);
        }
      });
    }
    
    // Impact sparks come from the projectile tracer (renderer). AoE adds a heavier burst + SFX.
    if (unit.aoe > 0) {
      const hitX = currentTarget ? currentTarget.x : target.x;
      const hitZ = currentTarget ? currentTarget.z : target.z;
      const hitY = combatFxY(hitX, hitZ, target.category ? 0.7 : 1.1);
      const cnt = Math.max(10, Math.round(unit.aoe * 1.5));
      Effects.spawnExplosion(hitX, hitY, hitZ, cnt, 'burst');
      Audio.playExplosionSound(0.22, hitX, hitZ);
      State.pushHostFx({ kind: 'aoe_impact', x: hitX, y: hitY, z: hitZ, count: cnt, volume: 0.22 });
    }
  };

  // Spawn projectile visual with the callback
  const fromY = combatFxY(unit.x, unit.z, unit.category ? 1.15 : 2.0);
  const targetY = combatFxY(
    target.x,
    target.z,
    target.category ? 0.85 : (target.type ? 1.6 : 0.85)
  );
  const distance = Pathfinding.getDistance(unit.x, unit.z, target.x, target.z);
  const heavy = !!(
    unit.aoe > 0
    || unit.type === 'lightTank'
    || unit.type === 'artillery'
    || unit.type === 'heavyTank'
    || unit.type === 'artilleryTurret'
  );
  // Readable flight in VR — beams need time on-screen.
  const duration = Math.min(heavy ? 1200 : 950, Math.max(heavy ? 380 : 320, distance * (heavy ? 55 : 48)));

  const isMpClient = State.gameSession.isMultiplayer && !State.gameSession.isHost;

  if (!isMpClient) {
    Renderer.spawnProjectile(
      unit.x, fromY, unit.z,
      target.x, targetY, target.z,
      PLAYER_COLORS[unit.ownerId],
      duration,
      onHit,
      heavy
    );
    Audio.playShotSound(unit.type, unit.x, unit.z);
  }

  State.pushHostFx({
    kind: 'shot',
    unitType: unit.type,
    x: unit.x,
    y: fromY,
    z: unit.z,
    tx: target.x,
    ty: targetY,
    tz: target.z,
    color: PLAYER_COLORS[unit.ownerId] ?? 0xffffff,
    duration,
    heavy: heavy ? 1 : 0,
  });
}

export function applyDamage(target, damage, attacker = null) {
  // FP hero is a fog/vision proxy — never kill it or cockpit guns die permanently.
  if (!target || target.fpHero) return;

  target.hp = Math.max(0, target.hp - damage);

  if (target.hp <= 0) {
    if (target.category) {
      destroyUnit(target, attacker);
    } else {
      destroyBuilding(target);
    }
  } else if (attacker && target.category) {
    const attackerIsUnit = !!(attacker.category && State.units.has(attacker.id));
    const attackerIsDefenseBuilding =
      !attacker.category
      && (attacker.type === 'turret' || attacker.type === 'artilleryTurret');

    // Stamp for bot AI — HP-drop reactions run on the bot tick.
    target._botDamagedAt = State.gameSession.elapsedTime;
    if (attacker.id != null) target._botLastAttackerId = attacker.id;
    if (attackerIsDefenseBuilding || attacker.type === 'artillery' || attacker.type === 'sniper') {
      target._botLastAttackerLongRange = true;
    }
    // Remember a gun that has actually hit us. Fog drops the building, but its
    // range still covers the center crystals — don't march the next MHQ back in.
    if (attackerIsDefenseBuilding || attacker.type === 'artillery') {
      const owner = State.players[target.ownerId];
      const mem = owner?.botMemory;
      if (mem) {
        if (!mem.knownGuns) mem.knownGuns = [];
        const range = (attacker.range
          || BUILDING_TYPES[attacker.type]?.range
          || 70) + 8;
        let prev = null;
        for (let gi = 0; gi < mem.knownGuns.length; gi++) {
          if (mem.knownGuns[gi].id === attacker.id) prev = mem.knownGuns[gi];
        }
        if (prev) {
          prev.x = attacker.x;
          prev.z = attacker.z;
          prev.range = range;
          prev.time = State.gameSession.elapsedTime;
        } else {
          mem.knownGuns.push({
            id: attacker.id,
            x: attacker.x,
            z: attacker.z,
            range,
            time: State.gameSession.elapsedTime,
          });
          if (mem.knownGuns.length > 8) mem.knownGuns.shift();
        }
      }
    }

    if (target.type === 'mobileHq') {
      // Step just outside the gun. Never path to the home HQ — that target sits inside
      // the HQ nav ring, so the MHQ orbits the base forever instead of taking another crystal.
      const dx = target.x - attacker.x;
      const dz = target.z - attacker.z;
      const len = Math.hypot(dx, dz) || 1;
      const gunRange = (attacker.range || BUILDING_TYPES[attacker.type]?.range || 40) + 16;
      const c = clampWorldToPlayableDisk(
        attacker.x + (dx / len) * gunRange,
        attacker.z + (dz / len) * gunRange,
        6,
      );
      target.targetPos = { x: c.x, z: c.z };
      target.guardPos = { x: c.x, z: c.z };
      target.path = null;
      target.state = 'moving';
      target._botFleeUntil = State.gameSession.elapsedTime + 1.6;
      target._mhqAbortExpand = true;
      target.playerCommanded = true;
    } else if (target.type === 'harvester' || target.type === 'scoutBike') {
      const hq = State.getPlayerHQ(target.ownerId);
      if (hq) {
        const dx = target.x - attacker.x;
        const dz = target.z - attacker.z;
        const len = Math.hypot(dx, dz) || 1;
        let fx = target.x + (dx / len) * 28;
        let fz = target.z + (dz / len) * 28;
        const dAtk = (fx - attacker.x) ** 2 + (fz - attacker.z) ** 2;
        const dHq = (hq.x - attacker.x) ** 2 + (hq.z - attacker.z) ** 2;
        if (dHq > dAtk) {
          fx = hq.x;
          fz = hq.z;
        }
        target.targetPos = { x: fx, z: fz };
        target.guardPos = { x: fx, z: fz };
        target.path = null;
        target.state = 'moving';
        target._botFleeUntil = State.gameSession.elapsedTime + 3.5;
        target.playerCommanded = true;
      }
    } else if (target.damage > 0 && attackerIsUnit) {
      if (target.state === 'idle' || target.state === 'moving') {
        beginEngagingUnit(target, attacker, { retaliate: true });
      } else if (target.state === 'attacking' && shouldPrioritizeAttackerOverCurrentTarget(target, attacker)) {
        beginEngagingUnit(target, attacker, { retaliate: true });
      }
    } else if (target.damage > 0 && attackerIsDefenseBuilding) {
      // Vehicles/infantry: attack the gun that just hit them instead of standing still.
      if (target.state === 'idle' || target.state === 'moving') {
        target.targetBuildingId = attacker.id;
        target.targetUnitId = null;
        target.targetPos = { x: attacker.x, z: attacker.z };
        target.state = 'attacking';
        target.path = null;
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
      killerType === 'artilleryTurret' ||
      (killerType && (UNIT_TYPES[killerType]?.range ?? 0) >= 23) ||
      (killerType && (BUILDING_TYPES[killerType]?.range ?? 0) >= 23);

    // Building attackers (static guns) aren't in the unit scan — count them explicitly.
    if (attacker && !attacker.category) {
      threats.types[attacker.type] = (threats.types[attacker.type] || 0) + 1;
      threats.vehicle += 1; // treat as hard threat for retaliation sizing
    }

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
    const dy = combatFxY(dx, dz, 0.7);
    Effects.spawnExplosion(dx, dy, dz, 16, 'death');
    State.pushHostFx({ kind: 'unit_death', x: dx, y: dy, z: dz, volume: 0.3, particles: 16 });
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
  const by = combatFxY(bx, bz, 1.2);
  Effects.spawnExplosion(bx, by, bz, 22, 'death');
  State.pushHostFx({ kind: 'building_death', x: bx, y: by, z: bz, volume: 0.5, particles: 22 });

  // Rebuild nav mesh since building is gone
  Pathfinding.rebuildNavMeshImmediate();
  if (building.type === 'refinery') {
    Resources.reassignHarvestersAfterRefineryLost(building.id, building.ownerId);
  }

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
    if (e.team === unit.team || e.hp <= 0 || e.fpHero) return false;
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

  // Enemy buildings: spatial query in vision (not full map forEach)
  const bScan = visionR * 1.05;
  let nearestBldgDist = bScan;
  let nearestBldg = null;
  const nearbyB = buildingGrid.queryRadius(unit.x, unit.z, bScan);
  for (let i = 0; i < nearbyB.length; i++) {
    const b = nearbyB[i];
    if (b.hp <= 0) continue;
    if (b.team === unit.team) continue;
    const dist = Pathfinding.getDistance(unit.x, unit.z, b.x, b.z);
    if (dist > bScan) continue;
    if (!withinGuardLeash(b.x, b.z)) continue;
    if (!Fog.isVisibleToTeam(unit.team, b.x, b.z)) continue;
    if (dist < nearestBldgDist) {
      nearestBldgDist = dist;
      nearestBldg = b;
    }
  }

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
    State.sampleStatsTimeline(true);
    console.log(`🏆 Game over! Winner: Team ${State.gameSession.winner}`);
  }
}

/**
 * Snap a click to a point the group can actually path to.
 * Always path-tests (do not trust walkable alone — Story slopes can be “walkable”
 * yet unreachable, which left the order ring on the hill while the unit stopped short).
 */
function resolveMoveOrderGoal(fromX, fromZ, targetX, targetZ) {
  const goal = clampWorldToPlayableDisk(targetX, targetZ, 0);
  const reach = Pathfinding.findNearestReachable(fromX, fromZ, goal.x, goal.z, 72, true);
  if (reach) return { x: reach.x, z: reach.z };

  const pushed = Pathfinding.snapOutOfObstacle(goal.x, goal.z);
  const pushedGoal = clampWorldToPlayableDisk(pushed.x, pushed.z, 0);
  if (Pathfinding.isPositionWalkable(pushedGoal.x, pushedGoal.z)) {
    if (Pathfinding.canTakePathfindSlot(true)) {
      Pathfinding.notePathfindSlot(true);
      if (Pathfinding.findPath(fromX, fromZ, pushedGoal.x, pushedGoal.z)) {
        return pushedGoal;
      }
    } else {
      return pushedGoal;
    }
  }

  const home = Pathfinding.snapOutOfObstacle(fromX, fromZ);
  return clampWorldToPlayableDisk(home.x, home.z, 0);
}

/**
 * Honeycomb slot around a group order. Index 0 is the center; later indexes
 * walk rings so neighbors stay FORMATION_SPACING apart. No collision — units
 * may still cross while moving.
 * @param {number} index
 * @param {number} spacing
 */
function formationHexOffset(index, spacing) {
  if (index <= 0) return { x: 0, z: 0 };
  const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  let ring = 1;
  let cursor = 1;
  while (cursor + 6 * ring <= index) {
    cursor += 6 * ring;
    ring += 1;
  }
  let q = dirs[4][0] * ring;
  let r = dirs[4][1] * ring;
  let left = index - cursor;
  for (let side = 0; side < 6 && left > 0; side++) {
    const steps = Math.min(ring, left);
    for (let j = 0; j < steps; j++) {
      q += dirs[side][0];
      r += dirs[side][1];
    }
    left -= steps;
  }
  return {
    x: spacing * (q + r * 0.5),
    z: spacing * (r * 0.8660254037844386),
  };
}

const UNIT_VISUAL_SCALE = {
  artillery: 3,
  heavyTank: 2,
  lightTank: 2,
  harvester: 2,
  mobileHq: 4,
  scoutBike: 4,
};

function groupFormationSpacing(units) {
  let span = FORMATION_SPACING;
  for (let i = 0; i < units.length; i++) {
    const shape = UNIT_SHAPES[units[i].type];
    if (!shape) continue;
    const base = Math.max(shape.width || 0, shape.depth || 0, (shape.radiusBottom || 0) * 2, (shape.radiusTop || 0) * 2);
    const mul = UNIT_VISUAL_SCALE[units[i].type] || 1;
    span = Math.max(span, base * mul + 1.5);
  }
  return span;
}

/** First open honeycomb cell around a preferred point. Snap must not pile the group on one cell. */
function claimFormationPoint(preferX, preferZ, spacing, claimed) {
  const minD = spacing * 0.82;
  for (let ring = 0; ring < 10; ring++) {
    const steps = ring === 0 ? 1 : ring * 6;
    for (let i = 0; i < steps; i++) {
      const ang = ring === 0 ? 0 : (i / steps) * Math.PI * 2;
      const rad = ring * spacing;
      let x = preferX + Math.cos(ang) * rad;
      let z = preferZ + Math.sin(ang) * rad;
      let t = clampWorldToPlayableDisk(x, z, 0);
      const pushed = Pathfinding.snapOutOfObstacle(t.x, t.z);
      t = clampWorldToPlayableDisk(pushed.x, pushed.z, 0);
      if (!Pathfinding.isPositionWalkable(t.x, t.z)) {
        const again = Pathfinding.snapWorldXZToWalkable(t.x, t.z);
        t = { x: again.x, z: again.z };
      }
      let clear = Pathfinding.isPositionWalkable(t.x, t.z);
      for (let c = 0; clear && c < claimed.length; c++) {
        if (Math.hypot(claimed[c].x - t.x, claimed[c].z - t.z) < minD) clear = false;
      }
      if (!clear) continue;
      claimed.push(t);
      return t;
    }
  }
  const fallback = { x: preferX, z: preferZ };
  claimed.push(fallback);
  return fallback;
}

/** Soft push so a marching group does not share one point. Not a block — crossings still pass. */
function formationSeparation(unit) {
  const minD = unit._formSpacing || FORMATION_SPACING;
  if (!(minD > 0) || !unit._formGrouped) return { x: 0, z: 0 };
  const near = unitGrid.queryRadius(unit.x, unit.z, minD);
  let px = 0;
  let pz = 0;
  for (let i = 0; i < near.length; i++) {
    const o = near[i];
    if (!o || o.id === unit.id || o.hp <= 0 || o.ownerId !== unit.ownerId) continue;
    const dx = unit.x - o.x;
    const dz = unit.z - o.z;
    const d = Math.hypot(dx, dz);
    if (!(d < minD)) continue;
    const push = (minD - d) / minD;
    const inv = d > 0.05 ? 1 / d : 0;
    px += dx * inv * push;
    pz += dz * inv * push;
  }
  return { x: px, z: pz };
}

function standWithFormSlot(unit, x, z) {
  const ox = unit.formOffsetX || 0;
  const oz = unit.formOffsetZ || 0;
  if (!ox && !oz) return { x, z };
  return clampWorldToPlayableDisk(x + ox, z + oz, 0);
}

const ordersByOwner = new Map();

function bumpOrder(ownerId, key, n = 1) {
  const id = ownerId | 0;
  let row = ordersByOwner.get(id);
  if (!row) {
    row = { move: 0, attackMove: 0, attackUnit: 0, attackBuilding: 0, units: 0, build: 0, train: 0, hvOrders: 0, hvUnits: 0 };
    ordersByOwner.set(id, row);
  }
  row[key] += n;
}

export function noteStructureOrder(ownerId, key) {
  bumpOrder(ownerId, key);
}

const orderedByType = new Map();

function noteOrderedTypes(units) {
  for (let i = 0; i < units.length; i++) {
    const t = units[i].type;
    if (!t) continue;
    orderedByType.set(t, (orderedByType.get(t) || 0) + 1);
  }
}

export function copyOrderedTypes() {
  const out = {};
  orderedByType.forEach((n, t) => {
    out[t] = n;
  });
  return out;
}

export function copyOrderStats() {
  const out = {};
  ordersByOwner.forEach((row, id) => {
    out[id] = { ...row };
  });
  return out;
}

// --- Player commands ---
export function commandMove(unitIds, targetX, targetZ, options = {}) {
  const playerCommanded = options.playerCommanded !== false;
  const original = new Set(unitIds);
  const allIds = extendUnitIdsWithSquadFollowers(unitIds);
  const unitsArray = allIds.map(id => State.units.get(id)).filter(u => u && u.hp > 0);
  const numUnits = unitsArray.length;
  if (numUnits === 0) return;

  let fromX = 0;
  let fromZ = 0;
  for (let i = 0; i < numUnits; i++) {
    fromX += unitsArray[i].x;
    fromZ += unitsArray[i].z;
  }
  fromX /= numUnits;
  fromZ /= numUnits;

  // Formation center = actual reachable destination (not raw click on hills / blocked cells).
  const goal = resolveMoveOrderGoal(fromX, fromZ, targetX, targetZ);

  if (playerCommanded) {
    Renderer.showOrderConfirm(goal.x, goal.z, 'move');
  }

  const ownerId = unitsArray[0].ownerId;
  if (options.traceKind === 'attackMove') bumpOrder(ownerId, 'attackMove');
  else bumpOrder(ownerId, 'move');
  bumpOrder(ownerId, 'units', numUnits);
  let hv = 0;
  for (let i = 0; i < numUnits; i++) if (unitsArray[i].type === 'harvester') hv++;
  if (hv > 0) {
    bumpOrder(ownerId, 'hvOrders');
    bumpOrder(ownerId, 'hvUnits', hv);
  }
  noteOrderedTypes(unitsArray);
  const typeCounts = {};
  let mhqFrom = null;
  for (let i = 0; i < numUnits; i++) {
    const ut = unitsArray[i].type;
    typeCounts[ut] = (typeCounts[ut] || 0) + 1;
    if (ut === 'mobileHq' && !mhqFrom) mhqFrom = { x: unitsArray[i].x, z: unitsArray[i].z };
  }
  let why = options.traceWhy || null;
  if (mhqFrom) {
    const home = State.getPlayerHQ(ownerId);
    if (home) {
      const fromD = Math.hypot(mhqFrom.x - home.x, mhqFrom.z - home.z);
      const toD = Math.hypot(goal.x - home.x, goal.z - home.z);
      if (fromD > 70 && toD + 30 < fromD) why = why ? `${why}|turnback` : 'turnback';
    }
  }
  Trace.traceOrder(options.traceKind || 'move', ownerId, {
    n: numUnits,
    types: typeCounts,
    x: Math.round(goal.x),
    z: Math.round(goal.z),
    why,
    mhqFrom: mhqFrom ? { x: Math.round(mhqFrom.x), z: Math.round(mhqFrom.z) } : undefined,
    keep: !!options.traceWhy,
  });

  const spacing = groupFormationSpacing(unitsArray);
  const claimed = [];
  unitsArray.forEach((unit, index) => {
    const slot = formationHexOffset(index, spacing);
    unit.formOffsetX = slot.x;
    unit.formOffsetZ = slot.z;
    unit._formSpacing = spacing;
    unit._formGrouped = numUnits > 1;
    const prefer = clampWorldToPlayableDisk(goal.x + slot.x, goal.z + slot.z, 0);
    const t = claimFormationPoint(prefer.x, prefer.z, spacing, claimed);

    unit.state = 'moving';
    unit.targetPos = { x: t.x, z: t.z };
    // Story base garrisons keep their home guard point so AI defense/scouting doesn't exile them.
    if (unit.botRole === 'garrison' && unit.homeGuardPos) {
      unit.guardPos = { x: unit.homeGuardPos.x, z: unit.homeGuardPos.z };
    } else {
      unit.guardPos = { x: t.x, z: t.z };
    }
    unit.targetUnitId = null;
    unit.targetBuildingId = null;
    if (original.has(unit.id)) {
      unit.followLeadId = null;
      unit.repairBuildingId = null;
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
  commandMove(unitIds, targetX, targetZ, { playerCommanded: false, traceKind: 'attackMove' });

  // Keep playerCommanded false so units auto-acquire targets while moving
  // (avoids “walk blindly into sniper fire” for AI).
  unitIds.forEach(id => {
    const unit = State.units.get(id);
    if (unit) {
      unit.playerCommanded = false;
      unit.repairBuildingId = null;
    }
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
  const attackOwner = State.units.get(allIds[0]);
  if (attackOwner) {
    bumpOrder(attackOwner.ownerId, 'attackUnit');
    bumpOrder(attackOwner.ownerId, 'units', allIds.length);
  }
  noteOrderedTypes(allIds.map(id => State.units.get(id)).filter(u => u && u.hp > 0));

  Renderer.showOrderConfirm(target.x, target.z, 'attack');
  if (allIds[0] != null) {
    const owner = State.units.get(allIds[0]);
    if (owner) {
      Trace.traceOrder('attackUnit', owner.ownerId, {
        keep: true,
        n: allIds.length,
        targetId: targetUnitId,
        type: target.type,
        x: Math.round(target.x),
        z: Math.round(target.z),
      });
    }
  }

  const fighters = [];
  for (let i = 0; i < allIds.length; i++) {
    const u = State.units.get(allIds[i]);
    if (!u || u.hp <= 0) continue;
    if (!original.has(u.id) && (u.type === 'engineer' || !(u.damage > 0))) continue;
    fighters.push(u);
  }
  fighters.forEach((unit, index) => {
    const slot = formationHexOffset(index, FORMATION_SPACING);
    unit.formOffsetX = slot.x;
    unit.formOffsetZ = slot.z;
    unit.state = 'attacking';
    unit.targetUnitId = targetUnitId;
    unit.targetBuildingId = null;
    if (original.has(unit.id)) {
      unit.followLeadId = null;
      unit.repairBuildingId = null;
      unit.squadOffsetX = 0;
      unit.squadOffsetZ = 0;
      unit._squadSyncSig = null;
    }
    const stand = clampWorldToPlayableDisk(target.x + slot.x, target.z + slot.z, 0);
    unit.targetPos = { x: stand.x, z: stand.z };
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
  const attackOwner = State.units.get(allIds[0]);
  if (attackOwner) {
    bumpOrder(attackOwner.ownerId, 'attackBuilding');
    bumpOrder(attackOwner.ownerId, 'units', allIds.length);
  }
  noteOrderedTypes(allIds.map(id => State.units.get(id)).filter(u => u && u.hp > 0));

  Renderer.showOrderConfirm(target.x, target.z, 'attack');
  if (allIds[0] != null) {
    const owner = State.units.get(allIds[0]);
    if (owner) {
      Trace.traceOrder('attackBuilding', owner.ownerId, {
        keep: true,
        n: allIds.length,
        targetId: targetBuildingId,
        type: target.type,
        x: Math.round(target.x),
        z: Math.round(target.z),
      });
    }
  }

  const attackers = [];
  for (let i = 0; i < allIds.length; i++) {
    const u = State.units.get(allIds[i]);
    if (!u || u.hp <= 0) continue;
    attackers.push(u);
  }
  attackers.forEach((unit, index) => {
    const slot = formationHexOffset(index, FORMATION_SPACING);
    unit.formOffsetX = slot.x;
    unit.formOffsetZ = slot.z;
    unit.state = 'attacking';
    unit.targetUnitId = null;
    unit.targetBuildingId = targetBuildingId;
    if (original.has(unit.id)) {
      unit.followLeadId = null;
      unit.repairBuildingId = null;
      unit.squadOffsetX = 0;
      unit.squadOffsetZ = 0;
      unit._squadSyncSig = null;
    }
    const ap = approachPointOutsideBuilding(unit.x, unit.z, target);
    const stand = clampWorldToPlayableDisk(ap.x + slot.x, ap.z + slot.z, 0);
    unit.targetPos = { x: stand.x, z: stand.z };
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
    unit.repairBuildingId = null;
    unit.squadOffsetX = 0;
    unit.squadOffsetZ = 0;
    unit.formOffsetX = 0;
    unit.formOffsetZ = 0;
    unit._formGrouped = false;
    unit._squadSyncSig = null;
    unit.path = null;
    unit.playerCommanded = false;
  });
}

export function commandFollow(unitIds, targetUnitId) {
  const target = State.units.get(targetUnitId);
  if (!target || target.hp <= 0 || target.fpHero) return;

  Renderer.showOrderConfirm(target.x, target.z, 'follow');

  unitIds.forEach(id => {
    const unit = State.units.get(id);
    if (!unit || unit.hp <= 0 || unit.id === targetUnitId) return;
    unit.followLeadId = targetUnitId;
    unit.repairBuildingId = null;
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

/**
 * Order engineers to approach and repair a friendly building (same role as follow→repair for vehicles).
 * Non-engineers in the selection move to the building approach point.
 */
export function commandRepairBuilding(unitIds, buildingId) {
  const target = State.buildings.get(buildingId);
  if (!target || target.hp <= 0) return;

  Renderer.showOrderConfirm(target.x, target.z, 'follow');

  unitIds.forEach(id => {
    const unit = State.units.get(id);
    if (!unit || unit.hp <= 0) return;
    unit.followLeadId = null;
    unit.squadOffsetX = 0;
    unit.squadOffsetZ = 0;
    unit._squadSyncSig = null;
    unit.targetUnitId = null;
    unit.targetBuildingId = null;
    unit.path = null;
    unit.pathIndex = 0;
    unit.playerCommanded = true;

    if (unit.type === 'engineer') {
      unit.repairBuildingId = buildingId;
      unit.state = 'idle';
      unit.targetPos = null;
      // Kick approach immediately if out of range.
      if (buildingRepairDist(unit.x, unit.z, target) > ENGINEER_REPAIR_RANGE - 0.45) {
        const ap = approachPointOutsideBuilding(unit.x, unit.z, target);
        unit.state = 'moving';
        unit.targetPos = { x: ap.x, z: ap.z };
        resetUnitPathThrottle(unit);
      }
    } else {
      unit.repairBuildingId = null;
      const ap = approachPointOutsideBuilding(unit.x, unit.z, target);
      unit.state = 'moving';
      unit.targetPos = { x: ap.x, z: ap.z };
      unit.guardPos = { x: ap.x, z: ap.z };
      resetUnitPathThrottle(unit);
    }
  });
}
