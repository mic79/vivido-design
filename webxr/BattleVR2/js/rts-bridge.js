/**
 * BattleVR2 — bridge FP vehicle pose ↔ RTS match state / terrain height.
 */
import * as State from './rts/state.js';
import * as Vehicle from './vehicle.js';

let sampleYFn = null;

export function setTerrainSampler(fn) {
  sampleYFn = fn;
}

export function sampleGroundY(x, z, fallbackY = 0) {
  // Prefer full-map terrain BVH when ready (plate + skirts).
  try {
    const bvh = window.__BATTLEVR2_TERRAIN_BVH__;
    if (bvh?.ready) {
      const hy = bvh.sampleY?.(x, z);
      if (Number.isFinite(hy)) return hy;
    }
  } catch (_) {}
  if (typeof sampleYFn === 'function') {
    try {
      const y = sampleYFn(x, z);
      if (Number.isFinite(y)) return y;
    } catch (_) {}
  }
  return fallbackY;
}

/** Fog-presence proxy glued to the FP fighter (mesh hidden — was clipping into the cockpit). */
let heroUnitId = null;

export function getHeroUnitId() {
  return heroUnitId;
}

function disposeHeroProxy(id) {
  if (id == null) return;
  const prev = State.units.get(id);
  if (!prev) return;
  State.units.forEach((f) => {
    if (f.followLeadId === id) f.followLeadId = null;
  });
  State.selectedUnits.delete(id);
  State.removeUnit(id);
}

export function clearHeroUnit() {
  disposeHeroProxy(heroUnitId);
  heroUnitId = null;
}

export function bindHeroUnit(unitId) {
  if (heroUnitId != null && heroUnitId !== unitId) {
    disposeHeroProxy(heroUnitId);
  }
  heroUnitId = unitId;
  const u = State.units.get(unitId);
  if (u) {
    u.fpHero = true;
    // Fighter sensor ring — larger than scout bike (uncovers FoW while boarded / parked).
    u.visionRange = Math.max(u.visionRange || 0, 48);
    u.range = Math.max(u.range || 0, 48);
    u.damage = Math.max(u.damage || 0, 14);
    State.units.forEach((f) => {
      if (f.followLeadId === unitId) f.followLeadId = null;
    });
  }
}

export function syncHeroFromVehicle() {
  if (heroUnitId == null) return;
  const u = State.units.get(heroUnitId);
  if (!u || u.hp <= 0) {
    heroUnitId = null;
    return;
  }
  const p = Vehicle.getVehiclePose();
  u.x = p.x;
  u.z = p.z;
  u.y = p.y;
  u.rotation = p.yaw;
  u.facing = p.yaw;
  u.visionRange = Math.max(u.visionRange || 0, 48);
  u.state = 'idle';
  u.targetPos = null;
  u.path = null;
}

export function placePlayerNearSpawn() {
  const pid = State.gameSession.myPlayerId ?? 0;
  const p = State.players[pid];
  const sp = p?.spawn || { x: 0, z: 0 };
  // Return terrain Y at feet (not eye). Caller / XR adds standing height.
  const y = sampleGroundY(sp.x, sp.z, 0);
  return { x: sp.x + 6, y, z: sp.z + 6 };
}
