// ========================================
// RTSVR4 — Story mode procedural layout
// Larger map, random blocking hills, scattered ore, multi-base opponent
// ========================================

import {
  MAP_UNIT_NAV_RADIUS,
  MATCH_HQ_SPAWN_MARGIN,
  STORY_UNIT_CAP_PER_PLAYER,
  clampWorldToPlayableDisk,
  setStoryResourcePositions,
} from './config.js';
import * as State from './state.js';
import * as Buildings from './buildings.js';
import * as Units from './units.js';
import * as Pathfinding from './pathfinding.js';
import { setStoryBlockingHills, sampleMoonTerrainWorldY, storyBlockingHillsLift, rebuildStoryMacroBake } from './moon-environment.js';

/** Spawn pads / ore / buildings must stay on flat ground (stricter than raw nav walk). */
const STORY_SPAWN_MAX_HILL_LIFT = 0.4;
const STORY_SPAWN_MAX_SLOPE_DEG = 14;
const STORY_BUILDING_FOOTPRINT_R = 6.5;
const STORY_UNIT_FOOTPRINT_R = 2.2;

/** @typedef {{
 *   x: number, z: number, rx: number, rz: number, rotation: number, height: number,
 *   kind: 'dome'|'ridge'|'mesa'|'crater'|'crescent'|'saddle',
 *   warp?: number, bowl?: number, arcHalf?: number, lobe?: number, seed?: number
 * }} StoryHill */
/** @typedef {{ x: number, z: number, rotation: number }} StorySpawn */

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randRange(rand, a, b) {
  return a + (b - a) * rand();
}

function randInt(rand, a, bInclusive) {
  return Math.floor(randRange(rand, a, bInclusive + 1));
}

function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function tooClose(x, z, points, minDist) {
  const md2 = minDist * minDist;
  for (let i = 0; i < points.length; i++) {
    if (dist2(x, z, points[i].x, points[i].z) < md2) return true;
  }
  return false;
}

/**
 * @param {() => number} rand
 * @param {number} rMin
 * @param {number} rMax
 * @param {number} ang0
 * @param {number} ang1
 */
function sampleAnnulus(rand, rMin, rMax, ang0, ang1) {
  const ang = randRange(rand, ang0, ang1);
  const r = Math.sqrt(randRange(rand, rMin * rMin, rMax * rMax));
  return { x: Math.cos(ang) * r, z: Math.sin(ang) * r };
}

function estimateTerrainSlopeDeg(x, z, span = 2.5) {
  const yL = sampleMoonTerrainWorldY(x - span, z);
  const yR = sampleMoonTerrainWorldY(x + span, z);
  const yU = sampleMoonTerrainWorldY(x, z - span);
  const yD = sampleMoonTerrainWorldY(x, z + span);
  const gx = (yR - yL) / (2 * span);
  const gz = (yD - yU) / (2 * span);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
}

/**
 * True when a point (and optional footprint ring) is flat + not on a Story massif.
 * Never treat steep hillside as OK.
 */
function isReachableFlatPad(x, z, opts = {}) {
  const maxLift = opts.maxLift ?? STORY_SPAWN_MAX_HILL_LIFT;
  const maxSlope = opts.maxSlope ?? STORY_SPAWN_MAX_SLOPE_DEG;
  const footprintR = opts.footprintR ?? 0;
  const maxFootDy = opts.maxFootDy ?? 1.1;

  const check = (px, pz) => {
    if (storyBlockingHillsLift(px, pz) > maxLift) return false;
    if (estimateTerrainSlopeDeg(px, pz) > maxSlope) return false;
    if (opts.requireNav && !Pathfinding.isPositionWalkable(px, pz)) return false;
    return true;
  };

  if (!check(x, z)) return false;
  if (!(footprintR > 0)) return true;

  const y0 = sampleMoonTerrainWorldY(x, z);
  const ring = 8;
  for (let i = 0; i < ring; i++) {
    const ang = (i / ring) * Math.PI * 2;
    const px = x + Math.cos(ang) * footprintR;
    const pz = z + Math.sin(ang) * footprintR;
    const p = clampWorldToPlayableDisk(px, pz, 4);
    if (!check(p.x, p.z)) return false;
    if (Math.abs(sampleMoonTerrainWorldY(p.x, p.z) - y0) > maxFootDy) return false;
  }
  // Mid-ring samples catch crater lips between center and edge
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + 0.4;
    const px = x + Math.cos(ang) * footprintR * 0.55;
    const pz = z + Math.sin(ang) * footprintR * 0.55;
    const p = clampWorldToPlayableDisk(px, pz, 4);
    if (!check(p.x, p.z)) return false;
  }
  return true;
}

/**
 * Spiral search for a flat reachable pad near a hint.
 * @returns {{x:number,z:number}|null}
 */
function findReachableFlatNear(cx, cz, maxR = 48, avoidPoints = null, minSep = 4.5, preferY = null, opts = {}) {
  // When preferY is omitted (base/ore snap off a hillside), do NOT keep pads at the
  // hillside elevation — that trapped HQs on slopes. PreferY set = stay near that stand.
  const hasPreferY = Number.isFinite(preferY);
  const baseY = hasPreferY ? preferY : sampleMoonTerrainWorldY(cx, cz);
  const minSep2 = minSep * minSep;
  const maxDy = opts.maxDy ?? (hasPreferY ? 8 : 120);
  const blocked = (x, z) => {
    if (!avoidPoints || avoidPoints.length === 0) return false;
    for (let i = 0; i < avoidPoints.length; i++) {
      const a = avoidPoints[i];
      const dx = a.x - x;
      const dz = a.z - z;
      if (dx * dx + dz * dz < minSep2) return true;
    }
    return false;
  };
  for (let r = 0; r <= maxR; r += r === 0 ? 1.5 : 1.25) {
    const steps = r === 0 ? 1 : Math.max(16, Math.floor(r * 3.5));
    const phase = r * 1.7 + (avoidPoints ? avoidPoints.length * 0.61 : 0);
    for (let i = 0; i < steps; i++) {
      const ang = (i / steps) * Math.PI * 2 + phase;
      const p =
        r === 0
          ? clampWorldToPlayableDisk(cx, cz, 8)
          : clampWorldToPlayableDisk(cx + Math.cos(ang) * r, cz + Math.sin(ang) * r, 8);
      if (blocked(p.x, p.z)) continue;
      if (!isReachableFlatPad(p.x, p.z, opts)) continue;
      if (Math.abs(sampleMoonTerrainWorldY(p.x, p.z) - baseY) > maxDy) continue;
      return { x: p.x, z: p.z };
    }
  }
  return null;
}

/**
 * Flat stand near a hint. Expands search; NEVER returns a steep/hill pad.
 * @returns {{x:number,z:number}|null}
 */
function findFlatWalkableNear(cx, cz, preferY, maxR = 48, avoidPoints = null, minSep = 4.5, opts = {}) {
  const radii = [maxR, maxR * 1.5, maxR * 2.2, 120];
  for (const r of radii) {
    const withNav = findReachableFlatNear(cx, cz, r, avoidPoints, minSep, preferY, {
      ...opts,
      requireNav: true,
    });
    if (withNav) return withNav;
    const soft = findReachableFlatNear(cx, cz, r, avoidPoints, minSep, preferY, {
      ...opts,
      requireNav: false,
    });
    if (soft) return soft;
  }
  // Last resort: spiral from map-ish open flat near origin toward hint
  const mid = findReachableFlatNear(
    cx * 0.35,
    cz * 0.35,
    Math.max(140, maxR * 2.5),
    avoidPoints,
    minSep,
    null,
    { ...opts, requireNav: false, maxDy: 120 }
  );
  return mid;
}

/** Snap a spawn/base onto flat ground after hills exist. Mutates and returns spawn. */
function snapToFlatSpawn(spawn, avoidPoints, maxR = 140) {
  const padOpts = {
    footprintR: STORY_BUILDING_FOOTPRINT_R,
    maxSlope: STORY_SPAWN_MAX_SLOPE_DEG,
    maxFootDy: 1.0,
    maxDy: 120,
  };
  let pad = findFlatWalkableNear(spawn.x, spawn.z, null, maxR, avoidPoints, 18, padOpts);
  // If the hint sat on a massif with no nearby basin, pull toward map center
  if (!pad || !isReachableFlatPad(pad.x, pad.z, padOpts)) {
    pad = findFlatWalkableNear(spawn.x * 0.45, spawn.z * 0.45, null, 160, avoidPoints, 18, padOpts);
  }
  if (!pad || !isReachableFlatPad(pad.x, pad.z, padOpts)) {
    pad = findFlatWalkableNear(0, 0, null, 180, avoidPoints, 18, padOpts);
  }
  if (pad && isReachableFlatPad(pad.x, pad.z, padOpts)) {
    spawn.x = pad.x;
    spawn.z = pad.z;
  } else {
    console.warn(
      `[Story] no flat spawn pad near (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) — left unsnapped`
    );
  }
  return spawn;
}

function spawnEnemyUnit(type, botId, x, z, opts = {}) {
  const u = Units.createUnit(type, botId, x, z, {
    skipCapCheck: true,
    skipProducedStat: true,
  });
  if (!u) return null;
  if (opts.homeBasePos) {
    u.homeBasePos = { x: opts.homeBasePos.x, z: opts.homeBasePos.z };
  }
  if (opts.guardPos) {
    u.guardPos = { x: opts.guardPos.x, z: opts.guardPos.z };
    u.homeGuardPos = { x: opts.guardPos.x, z: opts.guardPos.z };
    u.botRole = 'garrison';
    u.state = 'idle';
    u.playerCommanded = false;
  } else {
    u.botRole = 'mobile';
  }
  u._tY = null;
  u._tGx = undefined;
  u._tGz = undefined;
  return u;
}

/**
 * Generate Story battlefield layout for one playthrough.
 * @param {number} [seed]
 */
export function generateStoryLayout(seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0) {
  const rand = mulberry32(seed >>> 0);
  const R = MAP_UNIT_NAV_RADIUS - MATCH_HQ_SPAWN_MARGIN;
  const rim = Math.max(40, R - 8);

  let playerSpawn = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    const ang = randRange(rand, Math.PI * 0.15, Math.PI * 0.85) + Math.PI;
    const r = rim * randRange(rand, 0.82, 0.98);
    const p = clampWorldToPlayableDisk(Math.cos(ang) * r, Math.sin(ang) * r, 6);
    playerSpawn = {
      x: p.x,
      z: p.z,
      rotation: Math.atan2(-p.x, -p.z),
    };
    break;
  }
  if (!playerSpawn) {
    playerSpawn = { x: -rim * 0.7, z: -rim * 0.7, rotation: Math.PI * 0.25 };
  }

  const baseCount = randInt(rand, 5, 7);
  /** @type {StorySpawn[]} */
  const enemyBases = [];
  const occupied = [{ x: playerSpawn.x, z: playerSpawn.z }];
  const playerAng = Math.atan2(playerSpawn.z, playerSpawn.x);
  // Spread bases around the full playable disk (not only the far arc), with strong separation.
  const minBaseSep = Math.max(95, rim * 0.28);
  const minPlayerSep = Math.max(130, rim * 0.38);
  for (let b = 0; b < baseCount; b++) {
    let placed = null;
    // Even angular slots + jitter so bases cover the whole map
    const slotAng = playerAng + Math.PI * 0.35 + (b / baseCount) * Math.PI * 2;
    for (let attempt = 0; attempt < 80; attempt++) {
      const ang = slotAng + randRange(rand, -0.55, 0.55) + (attempt * 0.17);
      // Mix mid-ring and outer-ring so some bases aren't all on the rim
      const ringPick = attempt % 3;
      const rMul =
        ringPick === 0
          ? randRange(rand, 0.38, 0.62)
          : ringPick === 1
            ? randRange(rand, 0.62, 0.82)
            : randRange(rand, 0.78, 0.97);
      const r = rim * rMul;
      const p = clampWorldToPlayableDisk(Math.cos(ang) * r, Math.sin(ang) * r, 8);
      if (tooClose(p.x, p.z, occupied, minBaseSep)) continue;
      if (dist2(p.x, p.z, playerSpawn.x, playerSpawn.z) < minPlayerSep * minPlayerSep) continue;
      placed = {
        x: p.x,
        z: p.z,
        rotation: Math.atan2(playerSpawn.x - p.x, playerSpawn.z - p.z),
      };
      break;
    }
    if (!placed) {
      // Fallback: forced slot on outer ring with relaxed spacing
      const ang = slotAng;
      const p = clampWorldToPlayableDisk(Math.cos(ang) * rim * 0.88, Math.sin(ang) * rim * 0.88, 8);
      if (!tooClose(p.x, p.z, occupied, minBaseSep * 0.65)) {
        placed = { x: p.x, z: p.z, rotation: Math.atan2(-p.x, -p.z) };
      } else {
        placed = { x: p.x, z: p.z, rotation: Math.atan2(-p.x, -p.z) };
      }
    }
    enemyBases.push(placed);
    occupied.push({ x: placed.x, z: placed.z });
  }

  // Large landforms (crater-rim scale), not small pimples — fewer, wider, taller massifs + ridges.
  // Placement spans INSIDE the nav disk, ACROSS the red border, and OUT onto the horizon skirt
  // so massifs read as continuous terrain (not a hill garden clipped to the playable circle).
  /** @type {StoryHill[]} */
  const hills = [];
  const hillFootprints = []; // {x,z,_r} for spacing

  const navR = MAP_UNIT_NAV_RADIUS;
  // Visual continuation past the traversable ring (skirt samples the same lift field).
  const exteriorMaxR = navR + 210;

  const pushHill = (hill) => {
    hills.push(hill);
    hillFootprints.push({
      x: hill.x,
      z: hill.z,
      _r: Math.max(hill.rx, hill.rz) * 0.72,
    });
  };

  /**
   * @param {'mesa'|'ridge'|'dome'|'crater'|'crescent'|'saddle'} kind
   * @param {number} attempts
   * @param {number} rMin
   * @param {number} rMax
   * @param {{ avoidBases?: boolean, scale?: number }} [opts]
   */
  const tryPlaceHill = (kind, attempts, rMin, rMax, opts = {}) => {
    const avoidBases = opts.avoidBases !== false;
    const scale = opts.scale ?? 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const sample = sampleAnnulus(rand, rMin, rMax, 0, Math.PI * 2);
      const hx = sample.x;
      const hz = sample.z;
      let rx;
      let rz;
      let height;
      let rotation = randRange(rand, 0, Math.PI);
      let warp = randRange(rand, 0.05, 0.12);
      let bowl = 0.32;
      let arcHalf = 1.45;
      let lobe = 0.34;
      if (kind === 'crater') {
        // Wide ring + bowl — skirmish crater language at Story scale.
        rx = randRange(rand, 85, 140) * scale;
        rz = randRange(rand, 80, 130) * scale;
        height = randRange(rand, 12, 18) * Math.min(1.1, scale);
        bowl = randRange(rand, 0.4, 0.65);
        warp = randRange(rand, 0.1, 0.2);
      } else if (kind === 'crescent') {
        // Curved crater-wall arc (the interesting silhouette), kept fat.
        rx = randRange(rand, 110, 180) * scale;
        rz = randRange(rand, 55, 85) * scale;
        height = randRange(rand, 12, 18) * Math.min(1.12, scale);
        arcHalf = randRange(rand, 1.0, 1.85);
        warp = randRange(rand, 0.12, 0.22);
        rotation = Math.atan2(-hz, -hx) + randRange(rand, -0.55, 0.55);
      } else if (kind === 'saddle') {
        rx = randRange(rand, 100, 155) * scale;
        rz = randRange(rand, 60, 95) * scale;
        height = randRange(rand, 11, 17) * Math.min(1.1, scale);
        lobe = randRange(rand, 0.32, 0.45);
        warp = randRange(rand, 0.08, 0.18);
      } else if (kind === 'ridge') {
        rx = randRange(rand, 115, 175) * scale;
        rz = randRange(rand, 55, 80) * scale;
        height = randRange(rand, 11, 17) * Math.min(1.1, scale);
        warp = randRange(rand, 0.08, 0.18);
        if (rMin >= navR * 0.7) {
          rotation = Math.atan2(hz, hx) + Math.PI * 0.5 + randRange(rand, -0.35, 0.35);
        }
      } else if (kind === 'mesa') {
        rx = randRange(rand, 75, 125) * scale;
        rz = randRange(rand, 65, 110) * scale;
        height = randRange(rand, 12, 18) * Math.min(1.1, scale);
        warp = randRange(rand, 0.1, 0.2);
      } else {
        rx = randRange(rand, 65, 110) * scale;
        rz = randRange(rand, 58, 100) * scale;
        height = randRange(rand, 11, 17) * Math.min(1.1, scale);
        warp = randRange(rand, 0.1, 0.2);
      }
      const maxAspect = kind === 'crescent' ? 2.0 : kind === 'ridge' ? 1.85 : kind === 'saddle' ? 1.7 : 1.5;
      if (rx > rz * maxAspect) rx = rz * maxAspect;
      if (rz > rx * maxAspect) rz = rx * maxAspect;
      if (kind === 'ridge' || kind === 'crescent') rz = Math.max(rz, 48);
      height = Math.min(height, Math.min(rx, rz) * 0.32);
      const tube = kind === 'crescent' ? Math.max(36, Math.min(rx, rz) * 0.42) : undefined;
      const sep = Math.max(rx, rz) * 0.85 + 18;
      if (avoidBases && tooClose(hx, hz, occupied, sep * 0.55)) continue;
      let clash = false;
      for (let i = 0; i < hillFootprints.length; i++) {
        const f = hillFootprints[i];
        const need = sep + (f._r || 40);
        if (dist2(hx, hz, f.x, f.z) < need * need) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      pushHill({
        x: hx,
        z: hz,
        rx,
        rz,
        rotation,
        height,
        kind,
        warp,
        bowl,
        arcHalf,
        lobe,
        tube,
        seed: (rand() * 0xffffffff) | 0,
      });
      return true;
    }
    return false;
  };

  // Prefer curved crater-language shapes over plain gumdrop domes.
  const mesaN = randInt(rand, 1, 2);
  const ridgeN = randInt(rand, 2, 3);
  const domeN = randInt(rand, 1, 2);
  const craterN = randInt(rand, 3, 4);
  const crescentN = randInt(rand, 3, 5);
  const saddleN = randInt(rand, 1, 2);
  for (let i = 0; i < mesaN; i++) tryPlaceHill('mesa', 55, 55, navR * 0.72);
  for (let i = 0; i < ridgeN; i++) tryPlaceHill('ridge', 55, 55, navR * 0.78);
  for (let i = 0; i < domeN; i++) tryPlaceHill('dome', 55, 55, navR * 0.8);
  for (let i = 0; i < craterN; i++) tryPlaceHill('crater', 55, 55, navR * 0.82);
  for (let i = 0; i < crescentN; i++) tryPlaceHill('crescent', 55, 60, navR * 0.85);
  for (let i = 0; i < saddleN; i++) tryPlaceHill('saddle', 55, 55, navR * 0.8);

  // Border-straddling massifs: centers near the red ring so footprints cross in and out
  const borderMesa = randInt(rand, 1, 2);
  const borderRidge = randInt(rand, 2, 3);
  const borderDome = randInt(rand, 0, 1);
  const borderCrater = randInt(rand, 2, 3);
  const borderCrescent = randInt(rand, 3, 4);
  const borderSaddle = randInt(rand, 1, 2);
  for (let i = 0; i < borderMesa; i++) {
    tryPlaceHill('mesa', 70, navR * 0.82, navR * 1.12, { scale: 1.15 });
  }
  for (let i = 0; i < borderRidge; i++) {
    tryPlaceHill('ridge', 70, navR * 0.78, navR * 1.18, { scale: 1.15 });
  }
  for (let i = 0; i < borderDome; i++) {
    tryPlaceHill('dome', 70, navR * 0.85, navR * 1.15, { scale: 1.1 });
  }
  for (let i = 0; i < borderCrater; i++) {
    tryPlaceHill('crater', 70, navR * 0.8, navR * 1.15, { scale: 1.12 });
  }
  for (let i = 0; i < borderCrescent; i++) {
    tryPlaceHill('crescent', 70, navR * 0.78, navR * 1.2, { scale: 1.2 });
  }
  for (let i = 0; i < borderSaddle; i++) {
    tryPlaceHill('saddle', 70, navR * 0.82, navR * 1.14, { scale: 1.1 });
  }

  // Exterior continuation past the traversable border (skirt-only centers — still sampled by terrain)
  const exteriorN = randInt(rand, 5, 8);
  const exteriorKinds = ['crescent', 'crater', 'ridge', 'saddle', 'mesa', 'crescent', 'crater'];
  for (let i = 0; i < exteriorN; i++) {
    const kind = exteriorKinds[i % exteriorKinds.length];
    tryPlaceHill(kind, 60, navR * 1.02, exteriorMaxR, {
      avoidBases: false,
      scale: randRange(rand, 1.05, 1.35),
    });
  }

  // Occasional foothill satellites hugging a major massif (still wide, not pimples)
  const majors = hills.filter(h => h.kind === 'mesa' || h.kind === 'dome' || h.kind === 'crater');
  for (const parent of majors) {
    if (rand() > 0.45) continue;
    const ang = randRange(rand, 0, Math.PI * 2);
    const dist = Math.max(parent.rx, parent.rz) * randRange(rand, 0.55, 0.95);
    const hx = parent.x + Math.cos(ang) * dist;
    const hz = parent.z + Math.sin(ang) * dist;
    const insidePlay = hx * hx + hz * hz < navR * navR;
    if (insidePlay && tooClose(hx, hz, occupied, 48)) continue;
    const rx = randRange(rand, 40, 64);
    const rz = randRange(rand, 36, 58);
    const sep = Math.max(rx, rz) + 12;
    let clash = false;
    for (const f of hillFootprints) {
      if (dist2(hx, hz, f.x, f.z) < (sep + (f._r || 30)) * (sep + (f._r || 30)) * 0.35) {
        clash = true;
        break;
      }
    }
    if (clash) continue;
    const satKind = rand() < 0.2 ? 'crescent' : rand() < 0.55 ? 'dome' : 'crater';
    pushHill({
      x: hx,
      z: hz,
      rx: Math.max(rx, 56),
      rz: Math.max(rz, satKind === 'crescent' ? 72 : 56),
      rotation: ang + Math.PI * 0.5,
      height: randRange(rand, 7, 11),
      kind: satKind,
      warp: randRange(rand, 0.04, 0.1),
      bowl: randRange(rand, 0.2, 0.38),
      arcHalf: randRange(rand, 1.2, 1.7),
      tube: Math.max(55, Math.min(rx, rz) * 0.55),
      seed: (rand() * 0xffffffff) | 0,
    });
  }

  // Hills must be active so lift/slope samples reject steep faces for ore + later unit pads.
  // Bake now so pad tests match the mesh that will be built in prepareMapForMode.
  setStoryBlockingHills(hills);
  rebuildStoryMacroBake();

  // Bases were placed before hills existed — snap every spawn onto flat ground.
  {
    /** @type {Array<{x:number,z:number}>} */
    const avoidSpawns = [];
    snapToFlatSpawn(playerSpawn, avoidSpawns, 180);
    avoidSpawns.push({ x: playerSpawn.x, z: playerSpawn.z });
    for (const base of enemyBases) {
      snapToFlatSpawn(base, avoidSpawns, 180);
      avoidSpawns.push({ x: base.x, z: base.z });
    }
    occupied.length = 0;
    occupied.push({ x: playerSpawn.x, z: playerSpawn.z });
    for (const base of enemyBases) occupied.push({ x: base.x, z: base.z });
  }

  const STORY_MIN_RESOURCE_FIELDS = 20;
  const fieldCount = randInt(rand, STORY_MIN_RESOURCE_FIELDS, 28);
  /** @type {Array<{x:number,z:number}>} */
  const resources = [];

  const tryAddResource = (hintX, hintZ, maxR = 72, minSep = 26) => {
    const pad = findReachableFlatNear(hintX, hintZ, maxR, resources, minSep, null, {
      // preferY omitted → allow large ΔY so ore can leave hillsides
      footprintR: 3,
      maxSlope: STORY_SPAWN_MAX_SLOPE_DEG,
    });
    if (!pad) return false;
    if (tooClose(pad.x, pad.z, occupied, 18)) return false;
    resources.push(pad);
    return true;
  };

  {
    const toward = Math.atan2(-playerSpawn.z, -playerSpawn.x);
    const nr = 22 + rand() * 14;
    tryAddResource(
      playerSpawn.x + Math.cos(toward) * nr,
      playerSpawn.z + Math.sin(toward) * nr,
      64
    );
  }
  for (const base of enemyBases) {
    const toward = Math.atan2(-base.z, -base.x);
    const nr = 18 + rand() * 16;
    tryAddResource(base.x + Math.cos(toward) * nr, base.z + Math.sin(toward) * nr, 64);
  }
  let guard = 0;
  while (resources.length < fieldCount && guard++ < fieldCount * 100) {
    const sample = sampleAnnulus(rand, 40, rim * 0.88, 0, Math.PI * 2);
    const p = clampWorldToPlayableDisk(sample.x, sample.z, 12);
    if (tooClose(p.x, p.z, occupied, 22)) continue;
    if (!isReachableFlatPad(p.x, p.z)) continue;
    if (tooClose(p.x, p.z, resources, 28)) continue;
    resources.push({ x: p.x, z: p.z });
  }
  // Guarantee ≥20 flat pads — loosen separation if the map is crowded with hills
  let sep = 26;
  while (resources.length < STORY_MIN_RESOURCE_FIELDS && guard++ < 900) {
    if (guard > 350) sep = 20;
    if (guard > 550) sep = 16;
    const sample = sampleAnnulus(rand, 35, rim * 0.92, 0, Math.PI * 2);
    tryAddResource(sample.x, sample.z, 90, sep);
  }
  // Last resort: accept any flat pad even if closer to bases (still not on hills)
  while (resources.length < STORY_MIN_RESOURCE_FIELDS && guard++ < 1200) {
    const sample = sampleAnnulus(rand, 30, rim * 0.95, 0, Math.PI * 2);
    const pad = findReachableFlatNear(sample.x, sample.z, 100, resources, 14, null, {
      footprintR: 3,
      maxSlope: STORY_SPAWN_MAX_SLOPE_DEG,
    });
    if (pad) resources.push(pad);
  }
  if (resources.length < STORY_MIN_RESOURCE_FIELDS) {
    console.warn(
      `[Story] only ${resources.length} ore fields (wanted ≥${STORY_MIN_RESOURCE_FIELDS}) seed=${seed >>> 0}`
    );
  }

  // Per-base garrison (stay home) + a small mobile pool (scout / later waves). Total still ~10–40.
  const garrisonPool = [
    'rifleman', 'rifleman', 'rifleman', 'rifleman',
    'rocketSoldier', 'rocketSoldier', 'lightTank', 'scoutBike', 'heavyTank', 'artillery',
  ];
  const mobilePool = ['scoutBike', 'rifleman', 'lightTank', 'rocketSoldier', 'sniper'];
  /** @type {string[][]} */
  const garrisonByBase = enemyBases.map(() => {
    const n = randInt(rand, 5, 8);
    /** @type {string[]} */
    const g = [];
    for (let i = 0; i < n; i++) g.push(garrisonPool[randInt(rand, 0, garrisonPool.length - 1)]);
    return g;
  });
  const garrisonCount = garrisonByBase.reduce((s, g) => s + g.length, 0);
  const mobileN = Math.max(2, Math.min(8, 40 - garrisonCount));
  /** @type {string[]} */
  const mobileTypes = [];
  for (let i = 0; i < mobileN; i++) {
    mobileTypes.push(mobilePool[randInt(rand, 0, mobilePool.length - 1)]);
  }

  return {
    seed: seed >>> 0,
    playerSpawn,
    enemyBases,
    hills,
    resources,
    garrisonByBase,
    mobileTypes,
  };
}

/**
 * @param {ReturnType<typeof generateStoryLayout>} layout
 */
export function applyStoryLayoutToWorld(layout) {
  setStoryBlockingHills(layout.hills);
  rebuildStoryMacroBake();
  setStoryResourcePositions(layout.resources);
}

/**
 * Spawn player starter force + established enemy bases/units for Story.
 * @param {ReturnType<typeof generateStoryLayout>} layout
 */
export function spawnStoryMatch(layout) {
  const humanId = 0;
  const botId = 1;

  // Terrain + bake are live — re-snap every base/HQ onto flat pads (no hillside bases).
  {
    /** @type {Array<{x:number,z:number}>} */
    const avoid = [];
    snapToFlatSpawn(layout.playerSpawn, avoid, 180);
    avoid.push({ x: layout.playerSpawn.x, z: layout.playerSpawn.z });
    for (const base of layout.enemyBases) {
      snapToFlatSpawn(base, avoid, 180);
      avoid.push({ x: base.x, z: base.z });
    }
  }

  State.players[humanId].spawn = { ...layout.playerSpawn };
  State.players[botId].spawn = {
    x: layout.enemyBases[0].x,
    z: layout.enemyBases[0].z,
    rotation: layout.enemyBases[0].rotation,
  };
  for (const p of State.players) {
    if (!p.isActive || p.isDefeated) continue;
    p.unitCap = STORY_UNIT_CAP_PER_PLAYER;
  }
  State.players[botId].credits = Math.max(State.players[botId].credits, 2500);
  if (State.players[botId].botMemory) {
    State.players[botId].botMemory.startDelayOffset = 0.5 + Math.random();
    State.players[botId].botState = 'EXPAND';
    const known = [];
    State.resourceFields.forEach(f => {
      for (const base of layout.enemyBases) {
        if (dist2(f.x, f.z, base.x, base.z) < 70 * 70) {
          known.push(f.id);
          break;
        }
      }
    });
    State.players[botId].botMemory.discoveredResources = [...new Set(known)];
  }

  const unitPadOpts = {
    footprintR: STORY_UNIT_FOOTPRINT_R,
    maxSlope: STORY_SPAWN_MAX_SLOPE_DEG + 2,
    maxFootDy: 0.85,
    maxDy: 14,
  };
  const bldgPadOpts = {
    footprintR: STORY_BUILDING_FOOTPRINT_R,
    maxSlope: STORY_SPAWN_MAX_SLOPE_DEG,
    maxFootDy: 1.0,
    // Allow dropping off a residual lip into a true flat pad near the HQ.
    maxDy: 28,
  };

  const hq = Buildings.placeHQ(humanId);
  if (hq) {
    const dirX = -Math.sign(hq.x) || 1;
    const dirZ = -Math.sign(hq.z) || 1;
    const hqY = sampleMoonTerrainWorldY(hq.x, hq.z);
    const used = [];
    for (let i = 0; i < 3; i++) {
      const lateral = (i - 1) * 3;
      const hintX = hq.x + dirX * 8 + dirZ * lateral;
      const hintZ = hq.z + dirZ * 8 - dirX * lateral;
      const pad = findFlatWalkableNear(hintX, hintZ, hqY, 40, used, 3.5, unitPadOpts);
      if (!pad) continue;
      used.push(pad);
      Units.createUnit('rifleman', humanId, pad.x, pad.z, { skipCapCheck: true });
    }
    {
      const pad = findFlatWalkableNear(hq.x + dirX * 5, hq.z + dirZ * 5, hqY, 36, used, 3.5, unitPadOpts);
      if (pad) {
        used.push(pad);
        Units.createUnit('engineer', humanId, pad.x, pad.z, { skipCapCheck: true });
      }
    }
    {
      const pad = findFlatWalkableNear(hq.x + dirX * 3, hq.z + dirZ * 3, hqY, 36, used, 3.5, unitPadOpts);
      if (pad) {
        used.push(pad);
        Units.createUnit('harvester', humanId, pad.x, pad.z, { skipCapCheck: true });
      }
    }
  }

  const buildingOpts = { spawnComplete: true, skipNavRebuild: true };
  /** @type {Array<{x:number,z:number}>} */
  const usedBuildPads = [];
  for (let bi = 0; bi < layout.enemyBases.length; bi++) {
    const base = layout.enemyBases[bi];
    const inward = Math.hypot(base.x, base.z) || 1;
    const ix = -base.x / inward;
    const iz = -base.z / inward;
    const rx = -iz;
    const rz = ix;
    const baseY = sampleMoonTerrainWorldY(base.x, base.z);

    const hqPad = findFlatWalkableNear(base.x, base.z, baseY, 80, usedBuildPads, 16, bldgPadOpts);
    if (!hqPad) {
      console.warn(`[Story] skipped enemy base ${bi} — no flat HQ pad`);
      continue;
    }
    usedBuildPads.push(hqPad);
    base.x = hqPad.x;
    base.z = hqPad.z;

    const ehq = Buildings.createBuilding('hq', botId, hqPad.x, hqPad.z, buildingOpts);
    if (ehq) {
      ehq.rallyPoint = { x: hqPad.x + ix * 12, z: hqPad.z + iz * 12 };
      ehq.homeBasePos = { x: hqPad.x, z: hqPad.z };
    }

    const placeNear = (type, forward, right) => {
      const hint = clampWorldToPlayableDisk(
        hqPad.x + ix * forward + rx * right,
        hqPad.z + iz * forward + rz * right,
        10
      );
      const pad = findFlatWalkableNear(
        hint.x,
        hint.z,
        sampleMoonTerrainWorldY(hqPad.x, hqPad.z),
        70,
        usedBuildPads,
        14,
        bldgPadOpts
      );
      if (!pad) {
        console.warn(`[Story] skipped ${type} at base ${bi} — no flat pad`);
        return;
      }
      usedBuildPads.push(pad);
      const b = Buildings.createBuilding(type, botId, pad.x, pad.z, buildingOpts);
      if (b) b.homeBasePos = { x: hqPad.x, z: hqPad.z };
    };

    placeNear('barracks', 10, 12);
    placeNear('refinery', 16, 0);
    placeNear('warFactory', 10, -12);
    if (bi === 0 || Math.random() > 0.35) {
      placeNear('barracks', 18, 8);
    }
  }

  // Nav must include buildings before we pick flat walkable pads for units
  Pathfinding.rebuildNavMeshImmediate();

  // Relocate any ore still sitting on steep / hill faces.
  {
    const used = [];
    State.resourceFields.forEach(field => {
      const ok = isReachableFlatPad(field.x, field.z, {
        footprintR: 3,
        requireNav: true,
      });
      if (ok) {
        used.push({ x: field.x, z: field.z });
        return;
      }
      const pad = findFlatWalkableNear(field.x, field.z, null, 100, used, 26, {
        footprintR: 3,
        maxSlope: STORY_SPAWN_MAX_SLOPE_DEG,
      });
      if (pad) {
        field.x = pad.x;
        field.z = pad.z;
        used.push(pad);
      }
    });
    setStoryResourcePositions(
      [...State.resourceFields.values()].map(f => ({ x: f.x, z: f.z }))
    );
    Pathfinding.rebuildNavMeshImmediate();
  }

  const bases = layout.enemyBases;
  let spawned = 0;

  for (let bi = 0; bi < bases.length; bi++) {
    const base = bases[bi];
    const baseY = sampleMoonTerrainWorldY(base.x, base.z);
    const types = layout.garrisonByBase?.[bi] || [];
    /** @type {Array<{x:number,z:number}>} */
    const usedPads = [];
    for (let i = 0; i < types.length; i++) {
      const ang = (i / Math.max(1, types.length)) * Math.PI * 2 + bi * 0.55 + i * 0.13;
      const rad = 10 + (i % 5) * 3.2 + (i >= 5 ? 4 : 0);
      const hintX = base.x + Math.cos(ang) * rad;
      const hintZ = base.z + Math.sin(ang) * rad;
      const pad = findFlatWalkableNear(hintX, hintZ, baseY, 55, usedPads, 5.5, unitPadOpts);
      if (!pad) continue;
      usedPads.push(pad);
      const guard = { x: pad.x, z: pad.z };
      if (
        spawnEnemyUnit(types[i], botId, pad.x, pad.z, {
          guardPos: guard,
          homeBasePos: { x: base.x, z: base.z },
        })
      ) {
        spawned++;
      }
    }
    const hPad = findFlatWalkableNear(base.x + 14, base.z, baseY, 40, usedPads, 6, unitPadOpts);
    if (hPad) {
      usedPads.push(hPad);
      spawnEnemyUnit('harvester', botId, hPad.x, hPad.z, {
        homeBasePos: { x: base.x, z: base.z },
      });
    }
  }

  const mobile = layout.mobileTypes || [];
  for (let i = 0; i < mobile.length; i++) {
    const base = bases[i % bases.length];
    const homeY = sampleMoonTerrainWorldY(base.x, base.z);
    const ang = (i / Math.max(1, mobile.length)) * Math.PI * 2 + 1.1 + i * 0.4;
    const rad = 16 + (i % 4) * 5;
    const pad = findFlatWalkableNear(
      base.x + Math.cos(ang) * rad,
      base.z + Math.sin(ang) * rad,
      homeY,
      60,
      null,
      5,
      unitPadOpts
    );
    if (
      pad &&
      spawnEnemyUnit(mobile[i], botId, pad.x, pad.z, {
        homeBasePos: { x: base.x, z: base.z },
      })
    ) {
      spawned++;
    }
  }

  Pathfinding.rebuildNavMeshImmediate();
  console.log(
    `[Story] spawned ${spawned} combat across ${bases.length} bases (mobile ${mobile.length})`
  );
}
