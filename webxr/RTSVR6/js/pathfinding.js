// ========================================
// RTSVR4 — Pathfinding
// 1. `grid` walkability mask (debug overlay, slope, buildings) — source of truth.
// 2. Runtime: 8-connected grid A* + LOS string-pull (not three-pathfinding zone).
//    4-connected Manhattan A* forced staircase detours; diagonals + pull fix that.
//    Scale-up later (hundreds+ movers): flow fields / HPA* over this same grid — not a blind swap.
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
  isMesaHeightfieldActive,
} from './moon-environment.js';
import * as State from './state.js';

// --- Grid config (resized when map profile changes) ---
const CELL = 2;
let NAV_GRID_HALF = MAP_UNIT_NAV_RADIUS;
let COLS = Math.ceil((2 * NAV_GRID_HALF) / CELL);
let ROWS = COLS;

let grid = new Uint8Array(COLS * ROWS);
let navPlateHeightCache = new Float32Array(COLS * ROWS);
/** Terrain/resources/border/dilation only — copied then building rects applied (fast rebuild). */
let staticTerrainMask = null;

let GRID_CELLS = COLS * ROWS;
let astarG = null;
let astarFrom = null;
let astarClosed = null;
let astarStamp = null;
let astarGen = 1;
const astarVisited = [];

function reallocateNavGridBuffers() {
  NAV_GRID_HALF = MAP_UNIT_NAV_RADIUS;
  COLS = Math.ceil((2 * NAV_GRID_HALF) / CELL);
  ROWS = COLS;
  GRID_CELLS = COLS * ROWS;
  grid = new Uint8Array(GRID_CELLS);
  navPlateHeightCache = new Float32Array(GRID_CELLS);
  staticTerrainMask = null;
  astarG = null;
  astarFrom = null;
  astarClosed = null;
  astarStamp = null;
  astarGen = 1;
  astarVisited.length = 0;
}

function ensureAstarBuffers() {
  if (!astarG || astarG.length !== GRID_CELLS) {
    astarG = new Float32Array(GRID_CELLS);
    astarFrom = new Int32Array(GRID_CELLS);
    astarClosed = new Uint32Array(GRID_CELLS);
    astarStamp = new Uint32Array(GRID_CELLS);
  }
}

const NAV_ZONE = 'RTSVR4_battlefield';
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
      navPlateSlopeDegFromCache(cc, rr, idx, 3),
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
    // Extra pad: textured GLBs (HQ lander, factory, refinery) overhang the gameplay size.
    // Keep this ≥ visual shell or units path into the mesh and scrape forever.
    const visualPad =
      building.type === 'hq' ? 3.0
      : building.type === 'warFactory' ? 2.5
      : building.type === 'barracks' ? 2.0
      : building.type === 'refinery' ? 2.25
      : building.type === 'artilleryTurret' ? 1.5
      : building.type === 'turret' ? 1.25
      : building.type === 'solarPanel' ? 1.0
      : 1.25;
    const half = (building.size || 4) / 2 + OBSTACLE_BUFFER + visualPad;
    markRect(building.x, building.z, half, half);
  });
  // Parked Mobile HQ reads as a structure. Skip while relocating so the HQ can path
  // through its own footprint; rebuild when it stops (see units.js).
  State.units.forEach((u) => {
    if (!u || u.hp <= 0 || u.type !== 'mobileHq') return;
    if (u.state === 'moving' || (u.path && u.path.length > 0)) return;
    markRect(u.x, u.z, 3.6, 3.6);
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

  // Hera cliffs: slightly stricter than crater bowls (smoothed crater verts needed 45°).
  const mesa = typeof isMesaHeightfieldActive === 'function' && isMesaHeightfieldActive();
  const slopeLimit = (mesa ? 34 : NAV_MAX_TRAVERSABLE_SLOPE_DEG) - 0.35;
  const rimSlopeLimit = slopeLimit - 8;
  const rimLiftBlock = 2.25;
  let slopeBlocked = 0;
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
      if (deg > limit) {
        grid[idx] = 1;
        slopeBlocked++;
      }
    }
  }

  dilateBlockedCells(mesa ? 3 : 2);

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
  let walkable = 0;
  for (let i = 0; i < grid.length; i++) if (grid[i] === 0) walkable++;
  console.log('[RTSVR6] nav terrain mask', {
    mesa,
    slopeLimit: +slopeLimit.toFixed(1),
    slopeBlocked,
    walkable,
    cells: grid.length,
  });
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
  reallocateNavGridBuffers();
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
    [-1, 0, 1],
    [1, 0, 1],
    [0, -1, 1],
    [0, 1, 1],
    [-1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [1, 1, Math.SQRT2],
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
      // No corner-cutting through blocked diagonals.
      if (dc !== 0 && dr !== 0) {
        if (!isWalkable(cc + dc, cr) || !isWalkable(cc, cr + dr)) continue;
      }

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
 * 8-connected A* + LOS string-pull (classic staircase Manhattan paths were the detour source).
 */
export function findPath(startX, startZ, endX, endZ, smooth = true) {
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

  if (!smooth) return path;

  const smoothed = smoothPathLos(path);
  if (!smoothed || smoothed.length === 0) return null;
  if (!isPathValidOnGrid(smoothed)) return path;
  return smoothed;
}

/** Octile distance — admissible for 8-connected grid with √2 diagonals. */
function heuristic(c1, r1, c2, r2) {
  const dc = Math.abs(c2 - c1);
  const dr = Math.abs(r2 - r1);
  const m = dc < dr ? dc : dr;
  return dc + dr + (Math.SQRT2 - 2) * m;
}

/**
 * Greedy string-pull: from each waypoint jump as far ahead as a clear grid LOS allows.
 * Keeps paths near the geometric short chord without a risky full replan.
 */
function smoothPathLos(path) {
  if (!path || path.length < 3) return path;
  const out = [{ x: path[0].x, z: path[0].z }];
  let i = 0;
  while (i < path.length - 1) {
    let best = i + 1;
    for (let j = path.length - 1; j > i + 1; j--) {
      if (isWorldMovementSegmentWalkable(path[i].x, path[i].z, path[j].x, path[j].z)) {
        best = j;
        break;
      }
    }
    out.push({ x: path[best].x, z: path[best].z });
    i = best;
  }
  return out;
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

/**
 * Can the unit step from (x0,z0) → (x1,z1) on the nav grid?
 * Same rules as movement (diagonal corner block, Bresenham for longer legs).
 */
function canTraverseWorldStep(x0, z0, x1, z1) {
  if (!Number.isFinite(x0) || !Number.isFinite(z0) || !Number.isFinite(x1) || !Number.isFinite(z1)) {
    return false;
  }
  const c0 = worldToCol(x0);
  const r0 = worldToRow(z0);
  const c1 = worldToCol(x1);
  const r1 = worldToRow(z1);

  if (!isWalkable(c0, r0)) {
    // Already inside obstacle: only allow egress into a free cell.
    return isWalkable(c1, r1);
  }
  if (c0 === c1 && r0 === r1) return true;
  if (!isWalkable(c1, r1)) return false;

  if (Math.abs(c1 - c0) <= 1 && Math.abs(r1 - r0) <= 1) {
    if (c0 !== c1 && r0 !== r1) {
      if (!isWalkable(c1, r0) || !isWalkable(c0, r1)) return false;
    }
    return true;
  }
  return isGridSegmentWalkable(c0, r0, c1, r1);
}

/**
 * Resolve continuous motion against the nav grid.
 * On hit: **axis slide** (X then Z / Z then X) — never fractional binary-search into a wall.
 * That old partial-t move was the “stuck scraping the building edge forever” bug.
 */
export function resolveNavMotion(x0, z0, x1, z1) {
  if (!Number.isFinite(x0) || !Number.isFinite(z0) || !Number.isFinite(x1) || !Number.isFinite(z1)) {
    return { x: x0, z: z0, blocked: true };
  }

  const c0 = worldToCol(x0);
  const r0 = worldToRow(z0);

  // Wedged inside a blocked cell → ease toward free ground (never snap a full cell).
  if (!isWalkable(c0, r0)) {
    const c1 = worldToCol(x1);
    const r1 = worldToRow(z1);
    if (isWalkable(c1, r1)) {
      return { x: x1, z: z1, blocked: false };
    }
    const nearest = findNearestWalkable(c0, r0, 24);
    if (nearest) {
      const tx = colToWorld(nearest.c);
      const tz = rowToWorld(nearest.r);
      const dx = tx - x0;
      const dz = tz - z0;
      const dist = Math.hypot(dx, dz);
      if (dist < 1e-6) return { x: x0, z: z0, blocked: true };
      const intended = Math.hypot(x1 - x0, z1 - z0);
      // Cap eject to the attempted step (or a small crawl) so we never jump a whole cell.
      const step = Math.max(0.15, Math.min(dist, Math.max(intended, 0.35)));
      const t = step / dist;
      return { x: x0 + dx * t, z: z0 + dz * t, blocked: false };
    }
    return { x: x0, z: z0, blocked: true };
  }

  if (canTraverseWorldStep(x0, z0, x1, z1)) {
    return { x: x1, z: z1, blocked: false };
  }

  const dx = x1 - x0;
  const dz = z1 - z0;
  const tryX = Math.abs(dx) > 1e-8;
  const tryZ = Math.abs(dz) > 1e-8;

  // Prefer the longer axis first so grazes along long façades release along the wall.
  const xFirst = Math.abs(dx) >= Math.abs(dz);

  const slide = (axFirst) => {
    if (axFirst) {
      if (tryX && canTraverseWorldStep(x0, z0, x1, z0)) {
        if (tryZ && canTraverseWorldStep(x1, z0, x1, z1)) {
          return { x: x1, z: z1, blocked: false };
        }
        return { x: x1, z: z0, blocked: false };
      }
      if (tryZ && canTraverseWorldStep(x0, z0, x0, z1)) {
        if (tryX && canTraverseWorldStep(x0, z1, x1, z1)) {
          return { x: x1, z: z1, blocked: false };
        }
        return { x: x0, z: z1, blocked: false };
      }
    } else {
      if (tryZ && canTraverseWorldStep(x0, z0, x0, z1)) {
        if (tryX && canTraverseWorldStep(x0, z1, x1, z1)) {
          return { x: x1, z: z1, blocked: false };
        }
        return { x: x0, z: z1, blocked: false };
      }
      if (tryX && canTraverseWorldStep(x0, z0, x1, z0)) {
        if (tryZ && canTraverseWorldStep(x1, z0, x1, z1)) {
          return { x: x1, z: z1, blocked: false };
        }
        return { x: x1, z: z0, blocked: false };
      }
    }
    return null;
  };

  const slid = slide(xFirst) || slide(!xFirst);
  if (slid) return slid;

  return { x: x0, z: z0, blocked: true };
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
      // Classic overlay: bright blue walkable, fully clear blocked.
      if (walk) {
        d[o] = 48;
        d[o + 1] = 148;
        d[o + 2] = 255;
        d[o + 3] = 210;
      } else {
        d[o] = 0;
        d[o + 1] = 0;
        d[o + 2] = 0;
        d[o + 3] = 0;
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
    const tx = colToWorld(nearest.c);
    const tz = rowToWorld(nearest.r);
    const dx = tx - wx;
    const dz = tz - wz;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-6) return { x: tx, z: tz };
    // Soft eject toward free cell — callers that need a full snap can loop / call repeatedly.
    const step = Math.min(dist, Math.max(CELL * 0.35, dist * 0.35));
    return { x: wx + (dx / dist) * step, z: wz + (dz / dist) * step };
  }
  return { x: wx, z: wz };
}

/** Full snap to nearest walkable cell center (spawn / placement only — not per-frame movement). */
export function snapOutOfObstacle(wx, wz) {
  const c = worldToCol(wx);
  const r = worldToRow(wz);
  if (isWalkable(c, r)) return { x: wx, z: wz };
  const nearest = findNearestWalkable(c, r);
  if (nearest) {
    return { x: colToWorld(nearest.c), z: rowToWorld(nearest.r) };
  }
  return { x: wx, z: wz };
}

const ESCAPE_DIRS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** Walkable neighbor that gets closer to the goal, or any open neighbor if boxed in.
 * Prefers orthogonal slides when the closest cell is diagonally corner-blocked.
 */
export function bestEscapeStep(x, z, gx, gz) {
  const c = worldToCol(x);
  const r = worldToRow(z);
  const here = Math.hypot(gx - x, gz - z);
  let closer = null;
  let closerD = here - 0.05;
  let any = null;
  let anyD = Infinity;
  let lateral = null;
  let lateralScore = -Infinity;
  const goalDx = gx - x;
  const goalDz = gz - z;
  const goalLen = Math.hypot(goalDx, goalDz) || 1;
  const gnx = goalDx / goalLen;
  const gnz = goalDz / goalLen;

  for (let i = 0; i < ESCAPE_DIRS.length; i++) {
    const dc = ESCAPE_DIRS[i][0];
    const dr = ESCAPE_DIRS[i][1];
    const nc = c + dc;
    const nr = r + dr;
    if (!isWalkable(nc, nr)) continue;
    if (dc !== 0 && dr !== 0) {
      if (!isWalkable(c + dc, r) || !isWalkable(c, r + dr)) continue;
    }
    const wx = colToWorld(nc);
    const wz = rowToWorld(nr);
    if (!canTraverseWorldStep(x, z, wx, wz)) continue;
    const d = Math.hypot(gx - wx, gz - wz);
    if (d < anyD) {
      anyD = d;
      any = { x: wx, z: wz };
    }
    if (d < closerD) {
      closerD = d;
      closer = { x: wx, z: wz };
    }
    // Lateral: motion mostly perpendicular to goal, still some progress sideways.
    const mx = wx - x;
    const mz = wz - z;
    const along = mx * gnx + mz * gnz;
    const side = Math.abs(mx * -gnz + mz * gnx);
    const score = side * 2 - Math.max(0, -along);
    if (side > 0.4 && score > lateralScore) {
      lateralScore = score;
      lateral = { x: wx, z: wz };
    }
  }
  // Prefer closer; if that failed to move progress, wall-slide laterally around the block.
  return closer || lateral || any;
}

/** Spiral search for a reachable goal near an unwalkable click.
 * Charges the shared pathfind budget (industry: no unbound A* storms on orders).
 * @param {boolean} [playerPriority=false]
 * @returns {{x:number,z:number}|null}
 */
export function findNearestReachable(fromX, fromZ, targetX, targetZ, maxRadius = 36, playerPriority = false) {
  // Cheap accept: already walkable + budgeted path exists
  if (isPositionWalkable(targetX, targetZ)) {
    if (!canTakePathfindSlot(playerPriority)) {
      return { x: targetX, z: targetZ }; // defer A* to movement; goal is walkable
    }
    notePathfindSlot(playerPriority);
    if (findPath(fromX, fromZ, targetX, targetZ)) {
      return { x: targetX, z: targetZ };
    }
  }

  // Prefer local walkable snap without A* (formation slots, near-goal clicks)
  const snapped = snapOutOfObstacle(targetX, targetZ);
  if (isPositionWalkable(snapped.x, snapped.z)) {
    if (!canTakePathfindSlot(playerPriority)) return snapped;
    notePathfindSlot(playerPriority);
    if (findPath(fromX, fromZ, snapped.x, snapped.z)) return snapped;
  }

  const step = CELL * 0.5;
  let attempts = 0;
  for (let radius = step; radius <= maxRadius; radius += step) {
    const n = Math.max(16, Math.ceil(radius * 2));
    for (let i = 0; i < n; i++) {
      if (++attempts > PATHFIND_SPIRAL_MAX_ATTEMPTS) return snapped;
      if (!canTakePathfindSlot(playerPriority)) return snapped;
      const angle = (i / n) * Math.PI * 2;
      const tx = targetX + Math.cos(angle) * radius;
      const tz = targetZ + Math.sin(angle) * radius;
      if (!isPositionWalkable(tx, tz)) continue;
      notePathfindSlot(playerPriority);
      if (findPath(fromX, fromZ, tx, tz)) {
        return { x: tx, z: tz };
      }
    }
  }
  return isPositionWalkable(snapped.x, snapped.z) ? snapped : null;
}
