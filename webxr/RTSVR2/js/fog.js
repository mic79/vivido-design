// ========================================
// RTSVR2 — Fog of War
// Grid-based per-team visibility
// ========================================

import { FOG_GRID_SIZE, FOG_CELL_SIZE, MAP_HALF } from './config.js';
import * as State from './state.js';

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
  const gx = Math.floor((wx + MAP_HALF) / FOG_CELL_SIZE);
  const gz = Math.floor((wz + MAP_HALF) / FOG_CELL_SIZE);
  return {
    x: Math.max(0, Math.min(FOG_GRID_SIZE - 1, gx)),
    z: Math.max(0, Math.min(FOG_GRID_SIZE - 1, gz)),
  };
}

function gridIndex(gx, gz) {
  return gz * FOG_GRID_SIZE + gx;
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

      // Check actual distance in world units
      const cellCenterX = (gx + 0.5) * FOG_CELL_SIZE - MAP_HALF;
      const cellCenterZ = (gz + 0.5) * FOG_CELL_SIZE - MAP_HALF;
      const distSq = (cellCenterX - wx) * (cellCenterX - wx) + (cellCenterZ - wz) * (cellCenterZ - wz);

      if (distSq <= radius * radius) {
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
  const grid = teamGrids.get(team);
  if (!grid) return true; // No fog data → visible
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

export function isUnitVisibleToPlayer(unitOrBuilding, playerId) {
  if (State.gameSession.debugFog) return true;
  const player = State.players[playerId];
  if (!player) return true;

  // Own team always visible
  const entityTeam = unitOrBuilding.team !== undefined ? unitOrBuilding.team : State.players[unitOrBuilding.ownerId]?.team;
  if (entityTeam === player.team) return true;

  // Check fog grid
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
        const wx = (gx + 0.5) * FOG_CELL_SIZE - MAP_HALF;
        const wz = (gz + 0.5) * FOG_CELL_SIZE - MAP_HALF;

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
        x: (gx + 0.5) * FOG_CELL_SIZE - MAP_HALF,
        z: (gz + 0.5) * FOG_CELL_SIZE - MAP_HALF,
      });
    }
  }
  return out;
}
