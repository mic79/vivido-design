// ========================================
// RTSVR4 — Fog of War
// Grid-based per-team visibility + soft radial falloff for the world overlay
// ========================================

import {
  FOG_GRID_SIZE,
  FOG_CELL_SIZE,
  MAP_NAV_PLANE_HALF_M,
} from './config.js';
import * as State from './state.js';

// Per-team visibility grids
// 0 = never seen, 1 = previously seen (grey), 2 = currently visible
// Live visibility is O(1) grid lookup — `updateFog` + `revealArea` (disk∩cell) bake Euclidean vision.
const teamGrids = new Map();
/** Soft live-vision weight 0..1 (feathered disk). Display-only; gameplay stays on Uint8 grid. */
const teamSoftLive = new Map();

/** Feather ~45% of vision radius — soft readable vision circle with a clear core. */
const FOG_SOFT_FEATHER_FRAC = 0.45;

export function initFog() {
  teamGrids.clear();
  teamSoftLive.clear();
  const teams = new Set(State.players.map((p) => p.team));
  teams.forEach((team) => {
    teamGrids.set(team, new Uint8Array(FOG_GRID_SIZE * FOG_GRID_SIZE));
    teamSoftLive.set(team, new Float32Array(FOG_GRID_SIZE * FOG_GRID_SIZE));
  });
}

function worldToGrid(wx, wz) {
  const gx = Math.floor((wx + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
  const gz = Math.floor((wz + MAP_NAV_PLANE_HALF_M) / FOG_CELL_SIZE);
  return {
    x: Math.max(0, Math.min(FOG_GRID_SIZE - 1, gx)),
    z: Math.max(0, Math.min(FOG_GRID_SIZE - 1, gz)),
  };
}

function gridIndex(gx, gz) {
  return gz * FOG_GRID_SIZE + gx;
}

/** Minimum squared distance from (px,pz) to the closed axis-aligned rectangle [x0,x1]×[z0,z1]. */
function minDistSqPointToRect(px, pz, x0, z0, x1, z1) {
  const qx = Math.min(Math.max(px, x0), x1);
  const qz = Math.min(Math.max(pz, z0), z1);
  const dx = px - qx;
  const dz = pz - qz;
  return dx * dx + dz * dz;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Local human sees the whole map (minimap + world): match ended, or eliminated
 * with no living ally on the same team (FFA / solo team — avoids ghosting in 2v2).
 */
function localClientHasFullFogVision() {
  const gs = State.gameSession;
  if (!gs.gameStarted) return false;
  if (gs.gameOver) return true;
  const me = State.players[gs.myPlayerId];
  if (!me?.isDefeated) return false;
  const allyAlive = State.players.some(
    (p) => p.id !== me.id && p.team === me.team && !p.isDefeated
  );
  return !allyAlive;
}

/** World fog tint plane: off in spy mode or when the local human already sees the whole map. */
export function shouldDrawWorldFogOverlay() {
  const gs = State.gameSession;
  if (!gs.gameStarted) return false;
  if (gs.debugFog) return false;
  // Keep the last shroud after victory. Hiding it dumps the whole PBR moon
  // (and PCF receivers) into the XR stereo pass — Quest stays at ~half-rate
  // even with units frozen / sold.
  if (gs.gameOver) return true;
  return !localClientHasFullFogVision();
}

export function updateFog() {
  // Downgrade currently visible to previously seen
  teamGrids.forEach((grid) => {
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] === 2) grid[i] = 1;
    }
  });
  teamSoftLive.forEach((soft) => {
    soft.fill(0);
  });

  // Mark cells visible based on unit + building vision ranges
  State.units.forEach((unit) => {
    if (unit.hp <= 0) return;
    const team = unit.team;
    const grid = teamGrids.get(team);
    const soft = teamSoftLive.get(team);
    if (!grid) return;
    const r =
      unit.visionRange != null && Number.isFinite(unit.visionRange)
        ? unit.visionRange
        : unit.range != null && Number.isFinite(unit.range)
          ? unit.range
          : 18;
    revealArea(grid, soft, unit.x, unit.z, r);
  });

  State.buildings.forEach((building) => {
    if (building.hp <= 0) return;
    const player = State.players[building.ownerId];
    if (!player) return;
    const grid = teamGrids.get(player.team);
    const soft = teamSoftLive.get(player.team);
    if (!grid) return;
    const r =
      building.visionRange != null && Number.isFinite(building.visionRange)
        ? building.visionRange
        : 12;
    revealArea(grid, soft, building.x, building.z, r);
  });
}

function revealArea(grid, soft, wx, wz, radius) {
  const feather = Math.max(FOG_CELL_SIZE * 1.25, radius * FOG_SOFT_FEATHER_FRAC);
  const outer = radius + feather * 0.15;
  const cellRadius = Math.ceil(outer / FOG_CELL_SIZE);
  const center = worldToGrid(wx, wz);
  const r2 = radius * radius;

  for (let dx = -cellRadius; dx <= cellRadius; dx++) {
    for (let dz = -cellRadius; dz <= cellRadius; dz++) {
      const gx = center.x + dx;
      const gz = center.z + dz;
      if (gx < 0 || gx >= FOG_GRID_SIZE || gz < 0 || gz >= FOG_GRID_SIZE) continue;

      const x0 = gx * FOG_CELL_SIZE - MAP_NAV_PLANE_HALF_M;
      const z0 = gz * FOG_CELL_SIZE - MAP_NAV_PLANE_HALF_M;
      const x1 = x0 + FOG_CELL_SIZE;
      const z1 = z0 + FOG_CELL_SIZE;
      const idx = gridIndex(gx, gz);

      // Gameplay: any overlap with hard vision disk.
      if (minDistSqPointToRect(wx, wz, x0, z0, x1, z1) <= r2) {
        grid[idx] = 2;
      }

      if (!soft) continue;
      // Soft display weight from cell center (smooth circular falloff).
      const cx = (x0 + x1) * 0.5;
      const cz = (z0 + z1) * 0.5;
      const dist = Math.hypot(cx - wx, cz - wz);
      const w = 1 - smoothstep(radius - feather, radius, dist);
      if (w > soft[idx]) soft[idx] = w;
    }
  }
}

export function isVisibleToTeam(team, wx, wz) {
  // Spy Mode: allow seeing everything if it's the player's team
  if (State.gameSession.debugFog && team === State.players[State.gameSession.myPlayerId]?.team) {
    return true;
  }
  const myTeam = State.players[State.gameSession.myPlayerId]?.team;
  if (localClientHasFullFogVision() && team === myTeam) return true;

  if (!Number.isFinite(wx) || !Number.isFinite(wz)) return false;

  // O(1): baked by updateFog → revealArea (vision disk ∩ fog cell rect).
  const grid = teamGrids.get(team);
  if (!grid) return true;
  const g = worldToGrid(wx, wz);
  return grid[gridIndex(g.x, g.z)] === 2;
}

export function wasExploredByTeam(team, wx, wz) {
  if (State.gameSession.debugFog && team === State.players[State.gameSession.myPlayerId]?.team) {
    return true;
  }
  const grid = teamGrids.get(team);
  if (!grid) return true;
  const g = worldToGrid(wx, wz);
  return grid[gridIndex(g.x, g.z)] > 0;
}

export function getTeamGrid(team) {
  return teamGrids.get(team);
}

/** Soft live-vision weights (0..1) for world/minimap feather. */
export function getTeamSoftLive(team) {
  return teamSoftLive.get(team);
}

export function isUnitVisibleToPlayer(unitOrBuilding, playerId) {
  if (State.gameSession.debugFog) return true;
  const player = State.players[playerId];
  if (!player) return true;
  if (playerId === State.gameSession.myPlayerId && localClientHasFullFogVision()) return true;

  // Allies: use the owner's roster team (authoritative), not only unit.team — that field can lag
  // snapshots / production for a frame and would wrongly treat your harvesters as "enemy" fog targets.
  const owner = unitOrBuilding.ownerId != null ? State.players[unitOrBuilding.ownerId] : null;
  if (owner && owner.team === player.team) return true;

  const entityTeam = unitOrBuilding.team !== undefined ? unitOrBuilding.team : owner?.team;
  if (entityTeam === player.team) return true;

  return isVisibleToTeam(player.team, unitOrBuilding.x, unitOrBuilding.z);
}

/**
 * Finds the nearest world coordinate that is currently unexplored by the given team.
 * Used for "Blind Scouting" by AI bots.
 */
export function findNearestUnexploredCell(team, startX, startZ) {
  const grid = teamGrids.get(team);
  if (!grid) return null;

  let nearestPos = null;
  let minDistSq = Infinity;

  for (let gz = 0; gz < FOG_GRID_SIZE; gz++) {
    for (let gx = 0; gx < FOG_GRID_SIZE; gx++) {
      const idx = gz * FOG_GRID_SIZE + gx;
      if (grid[idx] === 0) {
        // Never seen
        const wx = (gx + 0.5) * FOG_CELL_SIZE - MAP_NAV_PLANE_HALF_M;
        const wz = (gz + 0.5) * FOG_CELL_SIZE - MAP_NAV_PLANE_HALF_M;

        const distSq = (wx - startX) * (wx - startX) + (wz - startZ) * (wz - startZ);
        if (distSq < minDistSq) {
          minDistSq = distSq;
          nearestPos = { x: wx, z: wz };
        }
      }
    }
  }

  return nearestPos;
}

/** World centers of fog cells never seen by this team (for fair exploration). */
export function getUnexploredCellCenters(team) {
  const grid = teamGrids.get(team);
  if (!grid) return [];
  const out = [];
  for (let gz = 0; gz < FOG_GRID_SIZE; gz++) {
    for (let gx = 0; gx < FOG_GRID_SIZE; gx++) {
      const idx = gz * FOG_GRID_SIZE + gx;
      if (grid[idx] !== 0) continue;
      out.push({
        x: (gx + 0.5) * FOG_CELL_SIZE - MAP_NAV_PLANE_HALF_M,
        z: (gz + 0.5) * FOG_CELL_SIZE - MAP_NAV_PLANE_HALF_M,
      });
    }
  }
  return out;
}
