// ========================================
// RTSVR2 — Unit System
// Creation, movement, combat, death
// ========================================

import {
  UNIT_TYPES, FORMATION_SPACING, UNIT_SEPARATION_RADIUS,
  clampWorldToPlayableDisk,
  PLAYER_COLORS,
  CAPTURE_DURATION_MIN_SEC, CAPTURE_DURATION_MAX_SEC,
  CAPTURE_HP_REF_FOR_DURATION,
  ENGINEER_CAPTURE_EDGE_REACH,
  ENGINEER_REPAIR_RANGE,
} from './config.js';
import * as State from './state.js';
import * as Pathfinding from './pathfinding.js';
import * as Renderer from './renderer.js';
import * as Audio from './audio.js';
import * as Fog from './fog.js';
import * as Effects from './effects.js';
import { unitGrid } from './spatial.js';

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
export function updateMovement(dt) {
  State.units.forEach(unit => {
    if (unit.hp <= 0) return;

    if (unit.state === 'moving' || (unit.state === 'attacking' && unit.targetPos)) {
      moveAlongPath(unit, dt);
    }

    // Skip separation while holding fire at range — avoids slow "creep" toward the enemy pack.
    const stationaryAttacking =
      unit.state === 'attacking' && !unit.targetPos && (!unit.path || unit.path.length === 0);
    if (!stationaryAttacking) {
      applySeparation(unit);
    }

    // After separation, ensure unit isn't inside an obstacle
    if (!Pathfinding.isPositionWalkable(unit.x, unit.z)) {
      const safe = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
      unit.x = safe.x;
      unit.z = safe.z;
    }
  });
}

function moveAlongPath(unit, dt) {
  // Need a new path?
  if (!unit.path || unit.path.length === 0 || unit.pathIndex >= unit.path.length) {
    if (!unit.targetPos) {
      if (unit.state === 'moving') {
        unit.state = 'idle';
        unit.playerCommanded = false;
      }
      return;
    }

    // Calculate path (A* always returns a path — snaps blocked endpoints)
    const path = Pathfinding.findPath(unit.x, unit.z, unit.targetPos.x, unit.targetPos.z);
    if (path && path.length > 0) {
      unit.path = path;
      unit.pathIndex = 0;
    } else {
      // Extremely rare fallback: move directly (straight line)
      unit.path = [{ x: unit.targetPos.x, z: unit.targetPos.z }];
      unit.pathIndex = 0;
    }
  }

  // Follow waypoints
  const wp = unit.path[unit.pathIndex];
  const dx = wp.x - unit.x;
  const dz = wp.z - unit.z;
  const dist = Math.sqrt(dx * dx + dz * dz);

  // Reached this waypoint?
  if (dist < 1.5) {
    unit.pathIndex++;
    if (unit.pathIndex >= unit.path.length) {
      // Path complete
      unit.targetPos = null;
      unit.path = null;
      if (unit.state === 'moving') {
        unit.state = 'idle';
        unit.playerCommanded = false;
      }
    }
    return;
  }

  // Move toward waypoint
  const moveSpeed = unit.speed * dt;
  const ratio = Math.min(1, moveSpeed / dist);
  const newX = unit.x + dx * ratio;
  const newZ = unit.z + dz * ratio;

  // Only move if the new position is walkable (or we're already blocked)
  if (Pathfinding.isPositionWalkable(newX, newZ)) {
    unit.x = newX;
    unit.z = newZ;
  } else {
    // Try sliding along each axis individually
    if (Pathfinding.isPositionWalkable(newX, unit.z)) {
      unit.x = newX;
    } else if (Pathfinding.isPositionWalkable(unit.x, newZ)) {
      unit.z = newZ;
    } else {
      // Completely stuck — recalculate path from pushed-out position
      const safe = Pathfinding.pushOutOfObstacle(unit.x, unit.z);
      unit.x = safe.x;
      unit.z = safe.z;
      unit.path = null; // Force recalculation next frame
    }
  }

  const clamped = clampWorldToPlayableDisk(unit.x, unit.z, 0);
  unit.x = clamped.x;
  unit.z = clamped.z;

  // Face movement direction
  if (Math.abs(dx) > 0.01 || Math.abs(dz) > 0.01) {
    unit.rotation = Math.atan2(dx, dz);
  }
}

function applySeparation(unit) {
  const nearby = unitGrid.queryRadius(unit.x, unit.z, UNIT_SEPARATION_RADIUS);
  for (const other of nearby) {
    if (other.id === unit.id || other.hp <= 0) continue;
    const dx = unit.x - other.x;
    const dz = unit.z - other.z;
    const distSq = dx * dx + dz * dz;
    if (distSq < 0.01) {
      // Overlapping exactly — push randomly
      unit.x += (Math.random() - 0.5) * 0.3;
      unit.z += (Math.random() - 0.5) * 0.3;
    } else if (distSq < UNIT_SEPARATION_RADIUS * UNIT_SEPARATION_RADIUS) {
      const dist = Math.sqrt(distSq);
      const force = (UNIT_SEPARATION_RADIUS - dist) / UNIT_SEPARATION_RADIUS * 0.12;
      unit.x += (dx / dist) * force;
      unit.z += (dz / dist) * force;
    }
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

/** Idle units drift from separation or post-fight; march home when no threat in acquisition range. */
function tryReturnToGuardPosition(unit) {
  if (unit.type === 'engineer') return false;
  if (unit.state !== 'idle' || !unit.guardPos || unit.playerCommanded || unit.followLeadId) {
    return false;
  }
  const gh = unit.guardPos;
  const d = Pathfinding.getDistance(unit.x, unit.z, gh.x, gh.z);
  if (d < 3.6) return false;

  const scanRange = Math.max(unit.range, unit.visionRange || unit.range) * 1.05;
  const threat = unitGrid.findNearest(unit.x, unit.z, scanRange, e =>
    e.team !== unit.team && e.hp > 0
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
      const r2 = r * r;
      let bestD2 = r2 + 1;
      State.units.forEach(other => {
        if (other.id === unit.id || other.team !== unit.team || !isVehicleNeedingRepair(other)) return;
        const dx = other.x - unit.x;
        const dz = other.z - unit.z;
        const d2 = dx * dx + dz * dz;
        if (d2 <= r2 && d2 < bestD2) {
          bestD2 = d2;
          patient = other;
        }
      });
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

  // Offset building size from center distance
  let targetRadius = 0;
  if (!target.category && target.size) { // It's a building
    targetRadius = target.size / 2; // Approximate collision bound
  }

  const dist = Math.max(0, centerDist - targetRadius);
  let effectiveRange = unit.range > 0 ? unit.range : 1.5;
  if (unit.type === 'engineer' && !target.category) {
    effectiveRange = Math.max(
      Pathfinding.getEngineerMinEdgeDistanceToBuilding(target),
      ENGINEER_CAPTURE_EDGE_REACH
    );
  } else if (unit.type === 'engineer') {
    effectiveRange = 4.0;
  }

  // Check if target is visible (fog of war)
  const canSee = centerDist <= unit.visionRange || Fog.isVisibleToTeam(unit.team, target.x, target.z);

  if (canSee) {
    unit._losLastSeen = time;
  }

  // 1. LOS Chase Expiry: If we can't see the target for 2.5s, give up.
  if (!canSee && (time - (unit._losLastSeen || 0) > 2500)) {
    unit.targetUnitId = null;
    unit.targetBuildingId = null;
    if (resumeFollowAfterEscort(unit)) return;
    startMoveToGuardPos(unit);
    return;
  }

  // 2. Defensive Tethering: Don't stray too far from home base if not player-commanded
  if (!unit.playerCommanded && unit.guardPos) {
    const distFromHome = Pathfinding.getDistance(unit.x, unit.z, unit.guardPos.x, unit.guardPos.z);
    if (distFromHome > 50) { // Hard tether of 50 units
      unit.targetUnitId = null;
      unit.targetBuildingId = null;
      unit.targetPos = { x: unit.guardPos.x, z: unit.guardPos.z };
      unit.state = 'moving';
      unit.path = null;
      return;
    }
  }

  if (dist > effectiveRange) {
    // Only recalculate path every 500ms when chasing to prevent stutter
    if (time - (unit._lastPathTime || 0) > 500 || !unit.path) {
      unit.targetPos = { x: target.x, z: target.z };
      unit.path = null; 
      unit._lastPathTime = time;
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
      unit.x -= (dx / centerDist) * kiteSpeed;
      unit.z -= (dz / centerDist) * kiteSpeed;
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
    // Can't see target — move to last known position
    unit.targetPos = { x: target.x, z: target.z };
    unit.path = null;
  }
}

function fireAtTarget(unit, target, time) {
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
      State.pushHostFx({ kind: 'aoe_impact', x: target.x, z: target.z, count: cnt });
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
    Audio.playShotSound(unit.type);
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
    } else if (target.damage > 0 && target.state === 'idle') {
      // Idle combat units should turn and fight back
      target.state = 'attacking';
      target.targetUnitId = attacker.id;
      target.playerCommanded = false;
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
function clearUnitsTargetingBuilding(buildingId) {
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
    Audio.playUnitReadySound();
    State.pushHostFx({ kind: 'capture_complete' });
    console.log(`Engineer captured building ${building.type}!`);
    destroyUnit(engineer);
    checkWinCondition();
    return;
  }

  if (timeSince(engineer, '_capSoundTime', 0.45, dt)) {
    Audio.playCaptureTickSound();
    State.pushHostFx({ kind: 'capture_tick' });
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

/** Remove unit from play (e.g. bot economy sacrifices). Optional attacker for stats/fog. */
export function destroyUnit(unit, attacker = null) {
  unit.hp = 0;
  unit.state = 'dead';
  
  // LOG DANGER ZONE for bots
  const player = State.players[unit.ownerId];
  if (player && player.isBot && player.botMemory) {
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

  // Stats: Track losses and kills
  if (player && player.stats) player.stats.unitsLost++;
  
  const atkPlayer = attacker ? State.players[attacker.ownerId] : null;
  if (atkPlayer && atkPlayer.stats && attacker.ownerId !== unit.ownerId) {
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
  Audio.playExplosionSound(0.3);
  Effects.spawnExplosion(dx, 0.5, dz, 8);
  State.pushHostFx({ kind: 'unit_death', x: dx, z: dz, volume: 0.3, particles: 8 });

  checkWinCondition();
}

function destroyBuilding(building) {
  building.hp = 0;

  const bx = building.x;
  const bz = building.z;

  const player = State.players[building.ownerId];
  if (player && player.stats) player.stats.buildingsLost++;

  State.removeBuilding(building.id);
  Audio.playExplosionSound(0.5);
  Effects.spawnExplosion(bx, 0.5, bz, 12);
  State.pushHostFx({ kind: 'building_death', x: bx, z: bz, volume: 0.5 });

  // Rebuild nav mesh since building is gone
  Pathfinding.rebuildNavMesh();

  checkWinCondition();
}

function autoAcquireTarget(unit) {
  // Find nearest enemy unit within VISION range (not weapon range)
  // This makes units react to approaching enemies before they're on top of them
  const scanRange = Math.max(unit.range, unit.visionRange || unit.range);

  // Engineers deal no weapon damage — only capture buildings; never chase enemy units here.
  if (unit.type === 'engineer' && unit.damage <= 0) {
    let nearestBldgDist = scanRange;
    let nearestBldg = null;
    State.buildings.forEach(b => {
      if (b.hp <= 0 || !b.isBuilt) return;
      if (b.team === unit.team) return;
      const dist = Pathfinding.getDistance(unit.x, unit.z, b.x, b.z);
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
        if (Pathfinding.getDistance(unit.x, unit.z, highestPriorityTarget.x, highestPriorityTarget.z) <= scanRange) {
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
    return e.team !== unit.team && e.hp > 0;
  });

  if (enemy) {
    unit.state = 'attacking';
    unit.targetUnitId = enemy.id;
    unit.playerCommanded = false;
    return;
  }

  // Check for enemy buildings in vision range
  let nearestBldgDist = scanRange;
  let nearestBldg = null;
  State.buildings.forEach(b => {
    if (b.hp <= 0) return;
    if (b.team === unit.team) return;
    const dist = Pathfinding.getDistance(unit.x, unit.z, b.x, b.z);
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

function checkWinCondition() {
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
export function commandMove(unitIds, targetX, targetZ) {
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
    unit.playerCommanded = true;
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
    unit.playerCommanded = true;
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
    unit.targetPos = { x: target.x, z: target.z };
    unit.path = null;
    unit.playerCommanded = true;
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
