// ========================================
// RTSVR2 — Pathfinding
// Grid-based A* on a flat plane
// Replaces three-pathfinding nav mesh which
// permanently broke when units were near obstacles
// ========================================

import { MAP_UNIT_PLAYABLE_RADIUS, OBSTACLE_BUFFER } from './config.js';
import * as State from './state.js';

// --- Grid config ---
const CELL = 2; // 2 world-units per cell
/** Axis-aligned bounds for the **unit** walk disk (`MAP_UNIT_PLAYABLE_RADIUS`). */
const NAV_GRID_HALF = MAP_UNIT_PLAYABLE_RADIUS;
const COLS = Math.ceil((2 * NAV_GRID_HALF) / CELL);
const ROWS = COLS;

// 0 = walkable, 1 = blocked
const grid = new Uint8Array(COLS * ROWS);

// A* open-set implemented as a binary min-heap for speed
const SQRT2 = Math.SQRT2;

// --- Public API (signatures unchanged so nothing else breaks) ---

export function initPathfinding() {
  rebuildNavMesh();
}

/**
 * Rebuild the walkability grid.
 * Called on init and whenever a building is placed or destroyed.
 */
export function rebuildNavMesh() {
  grid.fill(0);

  // Mark resource field cells blocked
  State.resourceFields.forEach(field => {
    markRect(field.x, field.z, 3, 3);
  });

  // Mark building cells blocked (with buffer)
  State.buildings.forEach(building => {
    if (building.hp <= 0) return;
    const half = (building.size || 4) / 2 + OBSTACLE_BUFFER;
    markRect(building.x, building.z, half, half);
  });

  // Mark map-edge cells blocked (2-cell border)
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (c < 1 || c >= COLS - 1 || r < 1 || r >= ROWS - 1) {
        grid[r * COLS + c] = 1;
      }
    }
  }

  const R = MAP_UNIT_PLAYABLE_RADIUS;
  const R2 = R * R + 1e-2;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const wx = colToWorld(c);
      const wz = rowToWorld(r);
      if (wx * wx + wz * wz > R2) {
        grid[r * COLS + c] = 1;
      }
    }
  }

  console.log('✅ Pathfinding grid rebuilt');
}

function markRect(wx, wz, halfW, halfD) {
  const minC = worldToCol(wx - halfW);
  const maxC = worldToCol(wx + halfW);
  const minR = worldToRow(wz - halfD);
  const maxR = worldToRow(wz + halfD);
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (c >= 0 && c < COLS && r >= 0 && r < ROWS) {
        grid[r * COLS + c] = 1;
      }
    }
  }
}

// --- Coordinate conversion ---
function worldToCol(wx) { return Math.floor((wx + NAV_GRID_HALF) / CELL); }
function worldToRow(wz) { return Math.floor((wz + NAV_GRID_HALF) / CELL); }
function colToWorld(c)  { return c * CELL - NAV_GRID_HALF + CELL * 0.5; }
function rowToWorld(r)  { return r * CELL - NAV_GRID_HALF + CELL * 0.5; }

function clampCol(c) { return Math.max(0, Math.min(COLS - 1, c)); }
function clampRow(r) { return Math.max(0, Math.min(ROWS - 1, r)); }

function isWalkable(c, r) {
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return false;
  return grid[r * COLS + c] === 0;
}

// --- A* ---

/**
 * Find a path from (startX,startZ) to (endX,endZ).
 * Returns array of {x,z} waypoints, or null if no path.
 * Always succeeds if start/end are walkable (or snapped to nearest walkable).
 */
export function findPath(startX, startZ, endX, endZ) {
  let sc = clampCol(worldToCol(startX));
  let sr = clampRow(worldToRow(startZ));
  let ec = clampCol(worldToCol(endX));
  let er = clampRow(worldToRow(endZ));

  // If start is blocked, snap to nearest walkable cell
  if (!isWalkable(sc, sr)) {
    const snapped = findNearestWalkable(sc, sr);
    if (!snapped) return null;
    sc = snapped.c; sr = snapped.r;
  }

  // If end is blocked, snap to nearest walkable cell
  if (!isWalkable(ec, er)) {
    const snapped = findNearestWalkable(ec, er);
    if (!snapped) return null;
    ec = snapped.c; er = snapped.r;
  }

  // Same cell
  if (sc === ec && sr === er) {
    return [{ x: colToWorld(ec), z: rowToWorld(er) }];
  }

  // A* with 8-directional movement
  const startKey = sr * COLS + sc;
  const endKey   = er * COLS + ec;

  const gScore = new Map();
  const cameFrom = new Map();
  gScore.set(startKey, 0);

  // Min-heap: [f, key]
  const open = [[heuristic(sc, sr, ec, er), startKey]];
  const inOpen = new Set([startKey]);
  const closed = new Set();

  // Directions: 4 cardinal + 4 diagonal
  const dirs = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
    [-1, -1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [1, 1, SQRT2],
  ];

  let iterations = 0;
  const MAX_ITER = 3000; // Safety cap

  while (open.length > 0) {
    if (++iterations > MAX_ITER) break; // Prevent infinite search on huge maps

    // Pop lowest-f node
    const [, currentKey] = heapPop(open);
    inOpen.delete(currentKey);

    if (currentKey === endKey) {
      return reconstructPath(cameFrom, endKey);
    }

    closed.add(currentKey);

    const cr = Math.floor(currentKey / COLS);
    const cc = currentKey % COLS;
    const currentG = gScore.get(currentKey);

    for (const [dc, dr, cost] of dirs) {
      const nc = cc + dc;
      const nr = cr + dr;

      if (!isWalkable(nc, nr)) continue;

      // Diagonal: check that both adjacent cardinals are walkable
      // (prevents cutting corners through obstacles)
      if (dc !== 0 && dr !== 0) {
        if (!isWalkable(cc + dc, cr) || !isWalkable(cc, cr + dr)) continue;
      }

      const nKey = nr * COLS + nc;
      if (closed.has(nKey)) continue;

      const tentativeG = currentG + cost;
      const prevG = gScore.get(nKey);

      if (prevG === undefined || tentativeG < prevG) {
        gScore.set(nKey, tentativeG);
        cameFrom.set(nKey, currentKey);
        const f = tentativeG + heuristic(nc, nr, ec, er);
        if (!inOpen.has(nKey)) {
          heapPush(open, [f, nKey]);
          inOpen.add(nKey);
        }
      }
    }
  }

  // No path found — try getting as close as possible
  return findPartialPath(cameFrom, gScore, ec, er);
}

function heuristic(c1, r1, c2, r2) {
  // Octile distance (consistent with 8-dir movement costs)
  const dc = Math.abs(c2 - c1);
  const dr = Math.abs(r2 - r1);
  return Math.max(dc, dr) + (SQRT2 - 1) * Math.min(dc, dr);
}

function reconstructPath(cameFrom, endKey) {
  const path = [];
  let key = endKey;
  while (key !== undefined) {
    const r = Math.floor(key / COLS);
    const c = key % COLS;
    path.push({ x: colToWorld(c), z: rowToWorld(r) });
    key = cameFrom.get(key);
  }
  path.reverse();

  // Smooth: remove redundant colinear waypoints
  if (path.length > 2) {
    const smoothed = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const prev = smoothed[smoothed.length - 1];
      const next = path[i + 1];
      const curr = path[i];
      // Keep if direction changes
      const dx1 = curr.x - prev.x;
      const dz1 = curr.z - prev.z;
      const dx2 = next.x - curr.x;
      const dz2 = next.z - curr.z;
      if (Math.abs(dx1 * dz2 - dz1 * dx2) > 0.001) {
        smoothed.push(curr);
      }
    }
    smoothed.push(path[path.length - 1]);
    return smoothed;
  }

  return path;
}

/**
 * When A* can't reach the target, return a path to the
 * closest explored cell (partial path).
 */
function findPartialPath(cameFrom, gScore, targetC, targetR) {
  let bestKey = -1;
  let bestDist = Infinity;

  gScore.forEach((g, key) => {
    const r = Math.floor(key / COLS);
    const c = key % COLS;
    const dist = heuristic(c, r, targetC, targetR);
    if (dist < bestDist) {
      bestDist = dist;
      bestKey = key;
    }
  });

  if (bestKey >= 0) {
    return reconstructPath(cameFrom, bestKey);
  }
  return null;
}

/**
 * Find the nearest walkable cell to (c,r) via spiral search.
 */
function findNearestWalkable(c, r) {
  for (let radius = 1; radius <= 10; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue; // Only check perimeter
        const nc = c + dc;
        const nr = r + dr;
        if (isWalkable(nc, nr)) return { c: nc, r: nr };
      }
    }
  }
  return null;
}

// --- Binary min-heap for A* open set ---
function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent][0] <= heap[i][0]) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    const n = heap.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && heap[l][0] < heap[smallest][0]) smallest = l;
      if (r < n && heap[r][0] < heap[smallest][0]) smallest = r;
      if (smallest === i) break;
      [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
      i = smallest;
    }
  }
  return top;
}

// --- Utility (public, used by other modules) ---

export function getDistanceSq(x1, z1, x2, z2) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return dx * dx + dz * dz;
}

export function getDistance(x1, z1, x2, z2) {
  return Math.sqrt(getDistanceSq(x1, z1, x2, z2));
}

/**
 * Check if a world position is walkable.
 */
export function isPositionWalkable(wx, wz) {
  const c = clampCol(worldToCol(wx));
  const r = clampRow(worldToRow(wz));
  return isWalkable(c, r);
}

/**
 * Shortest distance from building footprint edge (size/2) to unit position along axes,
 * for the nearest walkable cell just outside the nav obstacle rect. Matches rebuildNavMesh
 * (half = size/2 + OBSTACLE_BUFFER) so capture range stays reachable.
 */
export function getEngineerMinEdgeDistanceToBuilding(building) {
  const bx = building.x;
  const bz = building.z;
  const S = building.size || 4;
  const halfNav = S / 2 + OBSTACLE_BUFFER;
  let minEdge = Infinity;

  const consider = (wx, wz) => {
    if (!isPositionWalkable(wx, wz)) return;
    const cd = Math.hypot(wx - bx, wz - bz);
    const edge = Math.max(0, cd - S / 2);
    if (edge < minEdge) minEdge = edge;
  };

  for (const sign of [-1, 1]) {
    const ec = clampCol(worldToCol(bx + sign * halfNav));
    const nc = sign > 0 ? ec + 1 : ec - 1;
    if (nc >= 0 && nc < COLS) consider(colToWorld(nc), bz);
  }
  for (const sign of [-1, 1]) {
    const er = clampRow(worldToRow(bz + sign * halfNav));
    const nr = sign > 0 ? er + 1 : er - 1;
    if (nr >= 0 && nr < ROWS) consider(bx, rowToWorld(nr));
  }

  if (!Number.isFinite(minEdge)) return 6;
  return minEdge + 0.35;
}

/**
 * Push a position out of any obstacle to the nearest walkable spot.
 * Returns { x, z } or the original position if already walkable.
 */
export function pushOutOfObstacle(wx, wz) {
  const c = clampCol(worldToCol(wx));
  const r = clampRow(worldToRow(wz));
  if (isWalkable(c, r)) return { x: wx, z: wz };

  const nearest = findNearestWalkable(c, r);
  if (nearest) {
    return { x: colToWorld(nearest.c), z: rowToWorld(nearest.r) };
  }
  return { x: wx, z: wz };
}

// Keep the old name so bot.js / buildings.js don't break
export function findNearestReachable(fromX, fromZ, targetX, targetZ, maxRadius = 20) {
  return { x: targetX, z: targetZ }; // A* handles blocked endpoints internally
}
