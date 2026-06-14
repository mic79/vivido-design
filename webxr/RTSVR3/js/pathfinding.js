// ========================================
// RTSVR3 — Pathfinding
// 1. `grid` walkability mask (debug overlay, slope, buildings) — source of truth.
// 2. `findPath` uses grid A* only (`findPathNavMesh` / three-pathfinding zone is not used at runtime).
// 3. Terrain slope + rim blocking is baked once into `staticTerrainMask`; building place/destroy only reapplies footprints.
// ========================================

import {
  MAP_UNIT_NAV_RADIUS,
  MAP_SIZE,
  NAV_MAX_TRAVERSABLE_SLOPE_DEG,
  OBSTACLE_BUFFER,
  PATHFIND_SIM_PER_TICK,
  PATHFIND_PLAYER_PER_TICK,
  PATHFIND_SPIRAL_MAX_ATTEMPTS,
} from './config.js';
import {
  getCraterRimNavLift,
  sampleNavPlateMeshY,
  sampleMoonTerrainWorldY,
} from './moon-environment.js';
import * as State from './state.js';

// --- Grid config ---
const CELL = 2;
const NAV_GRID_HALF = MAP_UNIT_NAV_RADIUS;
const COLS = Math.ceil((2 * NAV_GRID_HALF) / CELL);
const ROWS = COLS;

const grid = new Uint8Array(COLS * ROWS);
const navPlateHeightCache = new Float32Array(COLS * ROWS);
/** Terrain/resources/border/dilation only — copied then building rects applied (fast rebuild). */
let staticTerrainMask = null;

const GRID_CELLS = COLS * ROWS;
let astarG = null;
let astarFrom = null;
let astarClosed = null;
let astarStamp = null;
let astarGen = 1;
const astarVisited = [];

function ensureAstarBuffers() {
  if (!astarG || astarG.length !== GRID_CELLS) {
    astarG = new Float32Array(GRID_CELLS);
    astarFrom = new Int32Array(GRID_CELLS);
    astarClosed = new Uint32Array(GRID_CELLS);
    astarStamp = new Uint32Array(GRID_CELLS);
  }
}

const NAV_ZONE = 'RTSVR3_battlefield';
/** @type {InstanceType<typeof import('three-pathfinding').Pathfinding> | null} */
let pathfindingEngine = null;
let navMeshReady = false;

let navRebuildPending = false;

/** Per simulation tick — shared by combat units, harvesters, and reachability spirals. */
let simPathfindUsed = 0;
let playerPathfindUsed = 0;

export function resetPathfindBudgetForTick() {
  simPathfindUsed = 0;
  playerPathfindUsed = 0;
}

export function canTakePathfindSlot(playerPriority = false) {
  if (playerPriority) return playerPathfindUsed < PATHFIND_PLAYER_PER_TICK;
  return simPathfindUsed < PATHFIND_SIM_PER_TICK;
}

export function notePathfindSlot(playerPriority = false) {
  if (playerPriority) playerPathfindUsed++;
  else simPathfindUsed++;
}

function worldToCol(wx) { return Math.floor((wx + NAV_GRID_HALF) / CELL); }
function worldToRow(wz) { return Math.floor((wz + NAV_GRID_HALF) / CELL); }
function colToWorld(c) { return c * CELL - NAV_GRID_HALF + CELL * 0.5; }
function rowToWorld(r) { return r * CELL - NAV_GRID_HALF + CELL * 0.5; }

function clampCol(c) { return Math.max(0, Math.min(COLS - 1, c)); }
function clampRow(r) { return Math.max(0, Math.min(ROWS - 1, r)); }

function fillNavPlateHeightCache() {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      const wx = colToWorld(c);
      const wz = rowToWorld(r);
      let h = sampleNavPlateMeshY(wx, wz);
      if (h == null) h = sampleMoonTerrainWorldY(wx, wz);
      navPlateHeightCache[idx] = Number.isFinite(h) ? h : Number.NaN;
    }
  }
}

function navPlateSlopeDegFromCache(c, r, idx, spanCells) {
  const h0 = navPlateHeightCache[idx];
  if (!Number.isFinite(h0)) return 0;
  const inv = 1 / (2 * spanCells * CELL);
  let gx = 0;
  let gz = 0;
  let hasGx = false;
  let hasGz = false;

  const cL = c - spanCells;
  const cR = c + spanCells;
  if (cL >= 0 && cR < COLS) {
    const hL = navPlateHeightCache[idx - spanCells];
    const hR = navPlateHeightCache[idx + spanCells];
    if (Number.isFinite(hL) && Number.isFinite(hR)) {
      gx = (hR - hL) * inv;
      hasGx = true;
    }
  }
  if (!hasGx) {
    if (cR < COLS) {
      const hR = navPlateHeightCache[idx + spanCells];
      if (Number.isFinite(hR)) {
        gx = (hR - h0) / (spanCells * CELL);
        hasGx = true;
      }
    }
    if (!hasGx && cL >= 0) {
      const hL = navPlateHeightCache[idx - spanCells];
      if (Number.isFinite(hL)) {
        gx = (h0 - hL) / (spanCells * CELL);
        hasGx = true;
      }
    }
  }

  const rU = r - spanCells;
  const rD = r + spanCells;
  const rowStride = spanCells * COLS;
  if (rU >= 0 && rD < ROWS) {
    const hU = navPlateHeightCache[idx - rowStride];
    const hD = navPlateHeightCache[idx + rowStride];
    if (Number.isFinite(hU) && Number.isFinite(hD)) {
      gz = (hD - hU) * inv;
      hasGz = true;
    }
  }
  if (!hasGz) {
    if (rD < ROWS) {
      const hD = navPlateHeightCache[idx + rowStride];
      if (Number.isFinite(hD)) {
        gz = (hD - h0) / (spanCells * CELL);
        hasGz = true;
      }
    }
    if (!hasGz && rU >= 0) {
      const hU = navPlateHeightCache[idx - rowStride];
      if (Number.isFinite(hU)) {
        gz = (h0 - hU) / (spanCells * CELL);
        hasGz = true;
      }
    }
  }

  if (!hasGx && !hasGz) return 0;
  const mag = Math.hypot(hasGx ? gx : 0, hasGz ? gz : 0);
  return Math.atan(mag) * (180 / Math.PI);
}

/** Max slope (°) at cell center and corners — catches steep rim faces missed by center-only sampling. */
function maxCellSlopeDeg(c, r) {
  const wx = colToWorld(c);
  const wz = rowToWorld(r);
  const cornerOff = CELL * 0.42;
  const samples = [
    [0, 0],
    [-cornerOff, -cornerOff],
    [cornerOff, -cornerOff],
    [cornerOff, cornerOff],
    [-cornerOff, cornerOff],
  ];
  let maxDeg = 0;
  for (const [ox, oz] of samples) {
    const cc = clampCol(worldToCol(wx + ox));
    const rr = clampRow(worldToRow(wz + oz));
    const idx = rr * COLS + cc;
    if (!Number.isFinite(navPlateHeightCache[idx])) continue;
    maxDeg = Math.max(
      maxDeg,
      navPlateSlopeDegFromCache(cc, rr, idx, 1),
      navPlateSlopeDegFromCache(cc, rr, idx, 2),
    );
  }
  return maxDeg;
}

/** Expand blocked cells outward so paths cannot squeeze through 1-cell gaps on steep terrain. */
function dilateBlockedCells(layers = 2) {
  for (let layer = 0; layer < layers; layer++) {
    const snap = grid.slice();
    for (let r = 1; r < ROWS - 1; r++) {
      for (let c = 1; c < COLS - 1; c++) {
        if (grid[r * COLS + c] !== 1) continue;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            snap[(r + dr) * COLS + (c + dc)] = 1;
          }
        }
      }
    }
    grid.set(snap);
  }
}

/** Call if terrain mesh is regenerated mid-session (rare); next rebuild recomputes slope mask. */
export function invalidateStaticTerrainMask() {
  staticTerrainMask = null;
}

function applyBuildingObstaclesToGrid() {
  State.buildings.forEach(building => {
    if (building.hp <= 0) return;
    const half = (building.size || 4) / 2 + OBSTACLE_BUFFER;
    markRect(building.x, building.z, half, half);
  });
}

/** One-time ~64k-cell terrain bake (height samples + slope + dilation). Buildings applied separately. */
function buildStaticTerrainMask() {
  grid.fill(0);

  State.resourceFields.forEach(field => {
    markRect(field.x, field.z, 3, 3);
  });

  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      if (c < 1 || c >= COLS - 1 || r < 1 || r >= ROWS - 1) {
        grid[r * COLS + c] = 1;
      }
    }
  }

  const R = MAP_UNIT_NAV_RADIUS;
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

  fillNavPlateHeightCache();

  const slopeLimit = NAV_MAX_TRAVERSABLE_SLOPE_DEG - 0.35;
  const rimSlopeLimit = NAV_MAX_TRAVERSABLE_SLOPE_DEG - 8;
  const rimLiftBlock = 2.25;
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const idx = r * COLS + c;
      if (grid[idx] !== 0) continue;
      const wx = colToWorld(c);
      const wz = rowToWorld(r);
      const rimLift = getCraterRimNavLift(wx, wz);
      if (rimLift > rimLiftBlock) {
        grid[idx] = 1;
        continue;
      }
      if (!Number.isFinite(navPlateHeightCache[idx])) continue;
      const deg = maxCellSlopeDeg(c, r);
      const limit = rimLift > 0.75 ? rimSlopeLimit : slopeLimit;
      if (deg > limit) grid[idx] = 1;
    }
  }

  dilateBlockedCells(2);

  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const idx = r * COLS + c;
      if (grid[idx] !== 0) continue;
      if (Number.isFinite(navPlateHeightCache[idx])) continue;
      const wx = colToWorld(c);
      const wz = rowToWorld(r);
      const plateHalf = MAP_SIZE * 0.5;
      if (Math.abs(wx) > plateHalf || Math.abs(wz) > plateHalf) {
        grid[idx] = 1;
      }
    }
  }

  staticTerrainMask = grid.slice();
}

function finishNavRebuild() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('rts-nav-rebuilt'));
  }
}

function rebuildNavMeshNow() {
  navRebuildPending = false;
  if (!staticTerrainMask) {
    buildStaticTerrainMask();
  } else {
    grid.set(staticTerrainMask);
  }
  applyBuildingObstaclesToGrid();
  finishNavRebuild();
}

export function initPathfinding() {
  invalidateStaticTerrainMask();
  rebuildNavMesh();
}

/**
 * Refresh walkability after building place/destroy. Terrain mask is cached; no Three.js nav zone rebuild.
 * Coalesces multiple calls in the same frame (bots often place several structures per tick).
 */
export function rebuildNavMesh() {
  if (navRebuildPending) return;
  navRebuildPending = true;
  const schedule =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : cb => setTimeout(cb, 0);
  schedule(() => {
    if (!navRebuildPending) return;
    rebuildNavMeshNow();
  });
}

/** Immediate rebuild (match start, game-start snapshot) — skip rAF coalescing. */
export function rebuildNavMeshImmediate() {
  navRebuildPending = false;
  rebuildNavMeshNow();
}

/**
 * Build a three-pathfinding zone from walkable `grid` cells.
 * One quad (2 triangles) per walkable cell — BufferGeometry in world XZ, Y=0 (+Y up).
 */
function rebuildPathfindingZone() {
  navMeshReady = false;
  const THREE = typeof window !== 'undefined' ? window.THREE : null;
  const lib = typeof window !== 'undefined' ? window.threePathfinding : null;
  if (!THREE || !lib?.Pathfinding) return;

  const half = CELL * 0.5;
  const positions = [];
  const indices = [];
  let vi = 0;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (!isWalkable(c, r)) continue;
      const cx = colToWorld(c);
      const cz = rowToWorld(r);
      const base = vi;
      positions.push(
        cx - half, 0, cz - half,
        cx + half, 0, cz - half,
        cx + half, 0, cz + half,
        cx - half, 0, cz + half,
      );
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      vi += 4;
    }
  }

  if (indices.length < 3) return;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);

  if (!pathfindingEngine) {
    pathfindingEngine = new lib.Pathfinding();
  }
  pathfindingEngine.setZoneData(NAV_ZONE, lib.Pathfinding.createZone(geometry));
  geometry.dispose();
  navMeshReady = true;
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

function isWalkable(c, r) {
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return false;
  return grid[r * COLS + c] === 0;
}

/** True when each waypoint is walkable and each consecutive leg stays on `grid`. */
export function isPathValidOnGrid(path) {
  if (!path || path.length === 0) return false;
  for (let i = 0; i < path.length; i++) {
    const wp = path[i];
    if (!isPositionWalkable(wp.x, wp.z)) return false;
  }
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (!isWorldMovementSegmentWalkable(a.x, a.z, b.x, b.z)) return false;
  }
  return true;
}

/** Drop waypoints the unit has already passed (keeps pathIndex near 0). */
export function trimPathFromUnit(path, ux, uz, reach = 1.05) {
  if (!path || path.length === 0) return path;
  let i = 0;
  while (i < path.length - 1 && Math.hypot(path[i].x - ux, path[i].z - uz) < reach) {
    i++;
  }
  return i > 0 ? path.slice(i) : path;
}

function findPathGridAStar(startX, startZ, endX, endZ) {
  let sc = worldToCol(startX);
  let sr = worldToRow(startZ);
  let ec = worldToCol(endX);
  let er = worldToRow(endZ);

  if (!isWalkable(sc, sr)) {
    const snapped = findNearestWalkable(sc, sr);
    if (!snapped) return null;
    sc = snapped.c;
    sr = snapped.r;
  }
  if (!isWalkable(ec, er)) {
    const snapped = findNearestWalkable(ec, er);
    if (!snapped) return null;
    ec = snapped.c;
    er = snapped.r;
  }

  if (sc === ec && sr === er) {
    return [{ x: colToWorld(ec), z: rowToWorld(er) }];
  }

  ensureAstarBuffers();
  if (++astarGen === 0xffffffff) {
    astarStamp.fill(0);
    astarGen = 1;
  }
  const stamp = astarGen;
  astarVisited.length = 0;

  const startKey = sr * COLS + sc;
  const endKey = er * COLS + ec;

  astarG[startKey] = 0;
  astarFrom[startKey] = -1;
  astarStamp[startKey] = stamp;
  astarVisited.push(startKey);

  const open = [[heuristic(sc, sr, ec, er), startKey]];

  const dirs = [
    [-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1],
  ];

  let iterations = 0;
  const cellDist = Math.abs(sc - ec) + Math.abs(sr - er);
  const MAX_ITER = Math.min(
    GRID_CELLS,
    Math.max(1200, Math.min(16000, 600 + cellDist * 90)),
  );

  while (open.length > 0) {
    if (++iterations > MAX_ITER) break;

    const [, currentKey] = heapPop(open);
    if (astarClosed[currentKey] === stamp) continue;

    if (currentKey === endKey) {
      return reconstructPathArray(endKey);
    }

    astarClosed[currentKey] = stamp;

    const cr = Math.floor(currentKey / COLS);
    const cc = currentKey % COLS;
    const currentG = astarG[currentKey];

    for (const [dc, dr, cost] of dirs) {
      const nc = cc + dc;
      const nr = cr + dr;

      if (!isWalkable(nc, nr)) continue;

      const nKey = nr * COLS + nc;
      if (astarClosed[nKey] === stamp) continue;

      const tentativeG = currentG + cost;
      const prevG = astarStamp[nKey] === stamp ? astarG[nKey] : Infinity;

      if (tentativeG < prevG) {
        astarG[nKey] = tentativeG;
        astarFrom[nKey] = currentKey;
        astarStamp[nKey] = stamp;
        astarVisited.push(nKey);
        const f = tentativeG + heuristic(nc, nr, ec, er);
        heapPush(open, [f, nKey]);
      }
    }
  }

  return findPartialPathArray(ec, er);
}

/** three-pathfinding: getGroup + findPath on the nav mesh zone (see library README). */
function findPathNavMesh(startX, startZ, endX, endZ) {
  if (!pathfindingEngine || !navMeshReady) return null;
  const THREE = window.THREE;
  if (!THREE?.Vector3) return null;

  const startPos = new THREE.Vector3(startX, 0, startZ);
  const endPos = new THREE.Vector3(endX, 0, endZ);

  try {
    let groupID = pathfindingEngine.getGroup(NAV_ZONE, startPos);
    if (groupID === undefined) {
      const snap = snapWorldXZToWalkable(startX, startZ);
      startPos.set(snap.x, 0, snap.z);
      groupID = pathfindingEngine.getGroup(NAV_ZONE, startPos);
    }
    if (groupID === undefined) return null;

    const raw = pathfindingEngine.findPath(startPos, endPos, NAV_ZONE, groupID);
    if (!raw || raw.length === 0) return null;
    return raw.map(p => ({ x: p.x, z: p.z }));
  } catch (_) {
    return null;
  }
}

/**
 * Find a path from (startX,startZ) to (endX,endZ) on the nav `grid` (same cells as debug overlay).
 */
export function findPath(startX, startZ, endX, endZ) {
  const path = findPathGridAStar(startX, startZ, endX, endZ);
  if (!path || path.length === 0) return null;
  if (!isPathValidOnGrid(path)) return null;

  const chord = Math.hypot(endX - startX, endZ - startZ);
  if (
    path.length <= 2 &&
    chord > CELL * 4 &&
    !isWorldMovementSegmentWalkable(startX, startZ, endX, endZ)
  ) {
    return null;
  }

  return path;
}

function heuristic(c1, r1, c2, r2) {
  const dc = Math.abs(c2 - c1);
  const dr = Math.abs(r2 - r1);
  return dc + dr;
}

/** Bresenham line on grid indices — visits every cell the segment crosses (no diagonal gaps). */
function forEachCellOnGridSegment(c0, r0, c1, r1, fn) {
  let c = c0;
  let r = r0;
  const dc = Math.abs(c1 - c0);
  const dr = Math.abs(r1 - r0);
  const sc = c0 < c1 ? 1 : c0 > c1 ? -1 : 0;
  const sr = r0 < r1 ? 1 : r0 > r1 ? -1 : 0;
  let err = dc - dr;

  while (true) {
    if (!fn(c, r)) return false;
    if (c === c1 && r === r1) break;
    const e2 = 2 * err;
    if (e2 > -dr) {
      err -= dr;
      c += sc;
    }
    if (e2 < dc) {
      err += dc;
      r += sr;
    }
  }
  return true;
}

function isGridSegmentWalkable(c0, r0, c1, r1) {
  return forEachCellOnGridSegment(c0, r0, c1, r1, (c, r) => isWalkable(c, r));
}

/**
 * World centers of every nav cell a world-space segment crosses (Bresenham), in order.
 * Used for path debug lines so chords do not visually cut through blocked cells.
 */
export function sampleWorldSegmentToGridCellCenters(x0, z0, x1, z1) {
  const c0 = worldToCol(x0);
  const r0 = worldToRow(z0);
  const c1 = worldToCol(x1);
  const r1 = worldToRow(z1);
  const out = [];
  forEachCellOnGridSegment(c0, r0, c1, r1, (c, r) => {
    out.push({ x: colToWorld(c), z: rowToWorld(r) });
    return true;
  });
  return out;
}

export function isWorldMovementSegmentWalkable(x0, z0, x1, z1) {
  const c0 = worldToCol(x0);
  const r0 = worldToRow(z0);
  const c1 = worldToCol(x1);
  const r1 = worldToRow(z1);
  if (c0 === c1 && r0 === r1) return isWalkable(c0, r0);
  return isGridSegmentWalkable(c0, r0, c1, r1);
}

export function resolveNavMotion(x0, z0, x1, z1) {
  if (!Number.isFinite(x0) || !Number.isFinite(z0) || !Number.isFinite(x1) || !Number.isFinite(z1)) {
    return { x: x0, z: z0, blocked: true };
  }
  const c0 = worldToCol(x0);
  const r0 = worldToRow(z0);
  const c1 = worldToCol(x1);
  const r1 = worldToRow(z1);

  if (c0 === c1 && r0 === r1) {
    if (isWalkable(c0, r0)) return { x: x1, z: z1, blocked: false };
    return { x: x0, z: z0, blocked: true };
  }

  if (Math.abs(c1 - c0) <= 1 && Math.abs(r1 - r0) <= 1) {
    if (isGridSegmentWalkable(c0, r0, c1, r1)) {
      return { x: x1, z: z1, blocked: false };
    }
    return { x: x0, z: z0, blocked: true };
  }

  if (isGridSegmentWalkable(c0, r0, c1, r1)) {
    return { x: x1, z: z1, blocked: false };
  }

  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 8; k++) {
    const m = (lo + hi) * 0.5;
    const xm = x0 + (x1 - x0) * m;
    const zm = z0 + (z1 - z0) * m;
    const cm = worldToCol(xm);
    const rm = worldToRow(zm);
    if (isGridSegmentWalkable(c0, r0, cm, rm)) lo = m;
    else hi = m;
  }
  const t = lo <= 1e-5 ? 0 : lo - 1e-5;
  return {
    x: x0 + (x1 - x0) * t,
    z: z0 + (z1 - z0) * t,
    blocked: t < 1e-4,
  };
}

export function snapWorldXZToWalkable(wx, wz) {
  const c = worldToCol(wx);
  const r = worldToRow(wz);
  if (isWalkable(c, r)) return { x: wx, z: wz };
  const n = findNearestWalkable(c, r);
  if (n) return { x: colToWorld(n.c), z: rowToWorld(n.r) };
  return { x: wx, z: wz };
}

function reconstructPathArray(endKey) {
  const path = [];
  let key = endKey;
  while (key >= 0) {
    const r = Math.floor(key / COLS);
    const c = key % COLS;
    path.push({ x: colToWorld(c), z: rowToWorld(r) });
    key = astarFrom[key];
  }
  path.reverse();
  return path;
}

function findPartialPathArray(targetC, targetR) {
  let bestKey = -1;
  let bestDist = Infinity;
  for (let i = 0; i < astarVisited.length; i++) {
    const key = astarVisited[i];
    const r = Math.floor(key / COLS);
    const c = key % COLS;
    const dist = heuristic(c, r, targetC, targetR);
    if (dist < bestDist) {
      bestDist = dist;
      bestKey = key;
    }
  }
  if (bestKey >= 0) return reconstructPathArray(bestKey);
  return null;
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
  return path;
}

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

function findNearestWalkable(c, r, maxRadius = 48) {
  if (isWalkable(c, r)) return { c, r };
  const seedC = clampCol(c);
  const seedR = clampRow(r);
  if (isWalkable(seedC, seedR)) return { c: seedC, r: seedR };

  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
        const nc = seedC + dc;
        const nr = seedR + dr;
        if (isWalkable(nc, nr)) return { c: nc, r: nr };
      }
    }
  }
  return null;
}

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

export function getNavGridSpec() {
  return {
    cols: COLS,
    rows: ROWS,
    cell: CELL,
    gridHalfM: NAV_GRID_HALF,
    planeSpanM: COLS * CELL,
  };
}

export function drawNavDebugToMinimapContext(ctx, w, h) {
  const spec = getNavGridSpec();
  const span = spec.planeSpanM;
  const scaleX = w / span;
  const scaleZ = h / span;
  const pw = spec.cell * scaleX + 0.8;
  const ph = spec.cell * scaleZ + 0.8;
  ctx.fillStyle = 'rgba(48, 148, 255, 0.44)';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r * COLS + c] !== 0) continue;
      const wx = colToWorld(c);
      const wz = rowToWorld(r);
      const mx = (wx + span * 0.5) * scaleX;
      const mz = (wz + span * 0.5) * scaleZ;
      ctx.fillRect(mx, mz, pw, ph);
    }
  }
}

export function fillNavWalkabilityToCanvas2D(canvas, ctx) {
  if (!canvas || !ctx) return;
  if (canvas.width !== COLS) canvas.width = COLS;
  if (canvas.height !== ROWS) canvas.height = ROWS;
  const img = ctx.createImageData(COLS, ROWS);
  const d = img.data;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const walk = grid[r * COLS + c] === 0;
      const o = (r * COLS + c) * 4;
      if (walk) {
        d[o] = 52;
        d[o + 1] = 148;
        d[o + 2] = 255;
        d[o + 3] = 210;
      } else {
        d[o] = 18;
        d[o + 1] = 16;
        d[o + 2] = 22;
        d[o + 3] = 120;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function getDistanceSq(x1, z1, x2, z2) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return dx * dx + dz * dz;
}

export function getDistance(x1, z1, x2, z2) {
  return Math.sqrt(getDistanceSq(x1, z1, x2, z2));
}

export function isPositionWalkable(wx, wz) {
  const c = worldToCol(wx);
  const r = worldToRow(wz);
  return isWalkable(c, r);
}

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

export function pushOutOfObstacle(wx, wz) {
  const c = worldToCol(wx);
  const r = worldToRow(wz);
  if (isWalkable(c, r)) return { x: wx, z: wz };

  const nearest = findNearestWalkable(c, r);
  if (nearest) {
    return { x: colToWorld(nearest.c), z: rowToWorld(nearest.r) };
  }
  return { x: wx, z: wz };
}

/** Spiral search for a reachable goal near an unwalkable click. */
export function findNearestReachable(fromX, fromZ, targetX, targetZ, maxRadius = 36) {
  if (findPath(fromX, fromZ, targetX, targetZ)) {
    return { x: targetX, z: targetZ };
  }

  const step = CELL * 0.5;
  let attempts = 0;
  for (let radius = step; radius <= maxRadius; radius += step) {
    const n = Math.max(16, Math.ceil(radius * 2));
    for (let i = 0; i < n; i++) {
      if (++attempts > PATHFIND_SPIRAL_MAX_ATTEMPTS) return null;
      const angle = (i / n) * Math.PI * 2;
      const tx = targetX + Math.cos(angle) * radius;
      const tz = targetZ + Math.sin(angle) * radius;
      if (!isPositionWalkable(tx, tz)) continue;
      if (findPath(fromX, fromZ, tx, tz)) {
        return { x: tx, z: tz };
      }
    }
  }
  return null;
}
