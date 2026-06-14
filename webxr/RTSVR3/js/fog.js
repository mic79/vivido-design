// ========================================
// RTSVR2 — Fog of War
// Grid-based per-team visibility
// ========================================

import {
  FOG_GRID_SIZE,
  FOG_CELL_SIZE,
  MAP_NAV_PLANE_HALF_M,
} from './config.js';
import * as State from './state.js';
import { unitGrid, buildingGrid } from './spatial.js';

/** Max unit/building vision (m) + margin for spatial queries in `isVisibleToTeam`. */
const VISION_QUERY_RADIUS = 40;

// Per-team visibility grids
// 0 = never seen, 1 = previously seen (grey), 2 = currently visible
const teamGrids = new Map();

export function initFog() {
  teamGrids.clear();
  // Create a grid for each team
  const teams = new Set(State.players.map(p => p.team));
  teams.forEach(team => {
    teamGrids.set(team, new Uint8Array(FOG_GRID_SIZE * FOG_GRID_SIZE));
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
    p => p.id !== me.id && p.team === me.team && !p.isDefeated
  );
  return !allyAlive;
}

/** World fog tint plane: off in spy mode or when the local human already sees the whole map. */
export function shouldDrawWorldFogOverlay() {
  const gs = State.gameSession;
  if (!gs.gameStarted || gs.gameOver) return false;
  if (gs.debugFog) return false;
  return !localClientHasFullFogVision();
}

export function updateFog() {
  // Downgrade currently visible to previously seen
  teamGrids.forEach(grid => {
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] === 2) grid[i] = 1;
    }
  });

  // Mark cells visible based on unit + building vision ranges
  State.units.forEach(unit => {
    if (unit.hp <= 0) return;
    const team = unit.team;
    const grid = teamGrids.get(team);
    if (!grid) return;
    revealArea(grid, unit.x, unit.z, unit.visionRange);
  });

  State.buildings.forEach(building => {
    if (building.hp <= 0) return;
    const player = State.players[building.ownerId];
    if (!player) return;
    const grid = teamGrids.get(player.team);
    if (!grid) return;
    revealArea(grid, building.x, building.z, building.visionRange || 12);
  });
}

function revealArea(grid, wx, wz, radius) {
  const cellRadius = Math.ceil(radius / FOG_CELL_SIZE);
  const center = worldToGrid(wx, wz);

  for (let dx = -cellRadius; dx <= cellRadius; dx++) {
    for (let dz = -cellRadius; dz <= cellRadius; dz++) {
      const gx = center.x + dx;
      const gz = center.z + dz;
      if (gx < 0 || gx >= FOG_GRID_SIZE || gz < 0 || gz >= FOG_GRID_SIZE) continue;

      // Any overlap between vision disk and this fog cell (not just cell center).
      const x0 = gx * FOG_CELL_SIZE - MAP_NAV_PLANE_HALF_M;
      const z0 = gz * FOG_CELL_SIZE - MAP_NAV_PLANE_HALF_M;
      const x1 = x0 + FOG_CELL_SIZE;
      const z1 = z0 + FOG_CELL_SIZE;
      const r2 = radius * radius;
      if (minDistSqPointToRect(wx, wz, x0, z0, x1, z1) <= r2) {
        grid[gridIndex(gx, gz)] = 2; // Currently visible
      }
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

  // Euclidean vision — do not use coarse fog cells here. Large FOG_CELL_SIZE + center-only
  // reveal caused enemies beside your army to vanish and far-corner cell false positives.
  if (!Number.isFinite(wx) || !Number.isFinite(wz)) return false;

  const allies = unitGrid.queryRadiusFiltered(wx, wz, VISION_QUERY_RADIUS, e => {
    if (e.team !== team || e.hp <= 0) return false;
    const r =
      e.visionRange != null && Number.isFinite(e.visionRange)
        ? e.visionRange
        : (e.range != null && Number.isFinite(e.range) ? e.range : 18);
    const dx = wx - e.x;
    const dz = wz - e.z;
    return dx * dx + dz * dz <= r * r;
  });
  if (allies.length > 0) return true;

  const structures = buildingGrid.queryRadiusFiltered(wx, wz, VISION_QUERY_RADIUS, b => {
    if (b.hp <= 0) return false;
    const owner = State.players[b.ownerId];
    if (!owner || owner.team !== team) return false;
    const r =
      b.visionRange != null && Number.isFinite(b.visionRange)
        ? b.visionRange
        : 12;
    const dx = wx - b.x;
    const dz = wz - b.z;
    return dx * dx + dz * dz <= r * r;
  });
  return structures.length > 0;
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
      if (grid[idx] === 0) { // Never seen
        // World coordinates for the center of this cell
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
