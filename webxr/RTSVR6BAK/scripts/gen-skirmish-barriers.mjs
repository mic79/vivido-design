#!/usr/bin/env node
/**
 * Author a REAL Cross/X canyon: continuous double-row cliff ridges with
 * open mid + cardinal flanks. 180° rotational symmetry.
 *
 *   node RTSVR6/scripts/gen-skirmish-barriers.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'export', 'skirmish-1v1-barriers.json');

const MAP_SIZE = 200;
const MAP_HALF = MAP_SIZE / 2;
const MAP_PLAYABLE = MAP_HALF * Math.SQRT2;
const MAP_UNIT_PLAYABLE = MAP_PLAYABLE - 15;
const NAV = MAP_UNIT_PLAYABLE * 2;
const HQ_R = NAV - 38;
const NEAR_CRYSTAL_R = HQ_R - 18;
const S = 1 / Math.SQRT2;

const HQ_PADS = [
  [S * HQ_R, S * HQ_R],
  [-S * HQ_R, S * HQ_R],
  [S * HQ_R, -S * HQ_R],
  [-S * HQ_R, -S * HQ_R],
];
const NEAR_CRYSTALS = HQ_PADS.map(([x, z]) => [
  (x / HQ_R) * NEAR_CRYSTAL_R,
  (z / HQ_R) * NEAR_CRYSTAL_R,
]);
const CONTESTED = [
  [0, 30],
  [0, -30],
  [30, 0],
  [-30, 0],
];

/** Keep mid open, flanks open, pads clear — ridges fill the diagonals hard. */
const CLEAR = {
  midR: 36,
  hqR: 30,
  nearCrystalR: 18,
  contestedR: 18,
  flankHalfW: 16,
  flankMinAbs: 30,
};

const CLIFF_MESHES = ['SM_Cliff_2', 'SM_Cliff_3', 'SM_Cliff_1'];
const SCREE_MESHES = ['SM_Rock_4', 'SM_Rock_5', 'SM_Rock_3', 'SM_Rock_6'];

function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function tooClosePads(x, z) {
  const r2 = x * x + z * z;
  if (r2 < CLEAR.midR * CLEAR.midR) return 'mid';
  for (const [px, pz] of HQ_PADS) {
    if (dist2(x, z, px, pz) < CLEAR.hqR * CLEAR.hqR) return 'hq';
  }
  for (const [px, pz] of NEAR_CRYSTALS) {
    if (dist2(x, z, px, pz) < CLEAR.nearCrystalR * CLEAR.nearCrystalR) return 'nearCrystal';
  }
  for (const [px, pz] of CONTESTED) {
    if (dist2(x, z, px, pz) < CLEAR.contestedR * CLEAR.contestedR) return 'contested';
  }
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax < CLEAR.flankHalfW && az > CLEAR.flankMinAbs) return 'flankNS';
  if (az < CLEAR.flankHalfW && ax > CLEAR.flankMinAbs) return 'flankEW';
  return null;
}

/**
 * Seed half of the map (NE + NW arms). Full set = seed ∪ 180° rotate.
 * Dense double-row ridges along both diagonals.
 */
function seedHalf() {
  /** @type {Array<{mesh:string,x:number,y:number,z:number,yaw:number,scale:number,role:string}>} */
  const out = [];

  // Along-diagonal spacing (m) and wall thickness offset (perpendicular).
  // Start outside open mid so overhead reads as an X, not a central pile.
  const step = 10;
  const t0 = 42;
  const t1 = 86;
  const rowOff = 6.5;
  const cliffScale = [10.5, 11.8, 11.2, 12.5, 10.8, 12.0];

  // Diagonal A: NE arm along x=z. Face yaw ≈ ridge + 90°.
  const yawA = Math.PI * 0.25 + Math.PI * 0.5;
  // Perpendicular to NE diagonal is NW-SE (unit: (-S, S)).
  const perpAx = -S;
  const perpAz = S;

  let i = 0;
  for (let t = t0; t <= t1 + 0.01; t += step) {
    const cx = S * t;
    const cz = S * t;
    for (const side of [-1, 1]) {
      const x = cx + perpAx * rowOff * side;
      const z = cz + perpAz * rowOff * side;
      const mesh = CLIFF_MESHES[i % CLIFF_MESHES.length];
      const scale = cliffScale[i % cliffScale.length] * (side < 0 ? 1 : 0.96);
      const yaw = yawA + side * 0.08 + (i % 3) * 0.05;
      out.push({ mesh, x, y: 0, z, yaw, scale, role: 'cliff' });
      i++;
    }
  }

  // Diagonal B: NW arm along x=-z.
  const yawB = -Math.PI * 0.25 + Math.PI * 0.5;
  const perpBx = S;
  const perpBz = S;

  for (let t = t0; t <= t1 + 0.01; t += step) {
    const cx = -S * t;
    const cz = S * t;
    for (const side of [-1, 1]) {
      const x = cx + perpBx * rowOff * side;
      const z = cz + perpBz * rowOff * side;
      const mesh = CLIFF_MESHES[i % CLIFF_MESHES.length];
      const scale = cliffScale[i % cliffScale.length] * (side < 0 ? 0.98 : 1.02);
      const yaw = yawB - side * 0.07 + (i % 3) * 0.04;
      out.push({ mesh, x, y: 0, z, yaw, scale, role: 'cliff' });
      i++;
    }
  }

  // Inner choke tips — just outside mid disk, single mesh per arm (not a pile).
  const knobs = [
    { t: 38, diag: 'A', scale: 9.5 },
    { t: 38, diag: 'B', scale: 9.2 },
  ];
  for (const k of knobs) {
    if (k.diag === 'A') {
      out.push({
        mesh: 'SM_Cliff_2',
        x: S * k.t,
        y: 0,
        z: S * k.t,
        yaw: yawA,
        scale: k.scale,
        role: 'cliff',
      });
    } else {
      out.push({
        mesh: 'SM_Cliff_3',
        x: -S * k.t,
        y: 0,
        z: S * k.t,
        yaw: yawB,
        scale: k.scale,
        role: 'cliff',
      });
    }
  }

  // Sparse scree only at outer ridge feet (not competing with wall read).
  const screeTs = [50, 65, 80];
  let si = 0;
  for (const t of screeTs) {
    for (const diag of ['A', 'B']) {
      const cx = diag === 'A' ? S * t : -S * t;
      const cz = S * t;
      const px = diag === 'A' ? perpAx : perpBx;
      const pz = diag === 'A' ? perpAz : perpBz;
      out.push({
        mesh: SCREE_MESHES[si % SCREE_MESHES.length],
        x: cx + px * (rowOff + 5),
        y: 0,
        z: cz + pz * (rowOff + 5),
        yaw: si * 0.7,
        scale: 3.2 + (si % 3) * 0.4,
        role: 'scree',
      });
      si++;
    }
  }

  return out.filter((p) => {
    const why = tooClosePads(p.x, p.z);
    if (why) {
      console.warn('drop seed', p.mesh, p.x.toFixed(1), p.z.toFixed(1), why);
      return false;
    }
    return true;
  });
}

function rotate180(p) {
  return {
    mesh: p.mesh,
    x: -p.x,
    y: p.y,
    z: -p.z,
    yaw: p.yaw + Math.PI,
    scale: p.scale,
    role: p.role,
  };
}

function toPlacement(p, i) {
  const half = p.yaw * 0.5;
  return {
    name: `Prop_${p.mesh}_Barrier_${i}`,
    meshHint: p.mesh,
    role: p.role,
    translation: [p.x, p.y, p.z],
    rotation: [0, Math.sin(half), 0, Math.cos(half)],
    scale: [p.scale, p.scale, p.scale],
    yaw: p.yaw,
  };
}

/** Distance from point to nearest diagonal ridge line (m). */
export function distToXRidge(x, z) {
  // Diagonals: x-z=0 and x+z=0. Dist = |x±z|/√2
  const d1 = Math.abs(x - z) * S;
  const d2 = Math.abs(x + z) * S;
  return Math.min(d1, d2);
}

const seed = seedHalf();
const full = [];
const seen = new Set();
for (const p of seed) {
  for (const q of [p, rotate180(p)]) {
    const key = `${q.mesh}@${q.x.toFixed(1)},${q.z.toFixed(1)}`;
    if (seen.has(key)) continue;
    const why = tooClosePads(q.x, q.z);
    if (why) {
      console.warn('drop rot', q.mesh, q.x.toFixed(1), q.z.toFixed(1), why);
      continue;
    }
    seen.add(key);
    full.push(q);
  }
}

const placements = full.map(toPlacement);
const doc = {
  layout: 'cross-x-canyon-dense',
  symmetry: '180-rotational',
  note:
    'Dense double-row cliff ridges (soft walls). Clear competing props in ridge corridor on merge. No fake nav stamps.',
  clearance: CLEAR,
  ridgeCorridor: {
    /** Non-barrier Prop_* inside this band (and outside mid/flanks) are dropped on merge. */
    maxDistToDiagonal: 12,
    rMin: 36,
    rMax: 92,
  },
  pads: {
    hq: HQ_PADS.map(([x, z]) => ({ x, z })),
    nearCrystals: NEAR_CRYSTALS.map(([x, z]) => ({ x, z })),
    contested: CONTESTED.map(([x, z]) => ({ x, z })),
  },
  count: placements.length,
  placements,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log('wrote', OUT, 'count=', placements.length);
console.log(
  'roles',
  Object.fromEntries(
    ['cliff', 'scree'].map((r) => [r, placements.filter((p) => p.role === r).length])
  )
);
const cs = placements.filter((p) => p.role === 'cliff').map((p) => p.scale[0]);
console.log(
  'cliff scale',
  Math.min(...cs).toFixed(1),
  '…',
  Math.max(...cs).toFixed(1),
  'median',
  cs.sort((a, b) => a - b)[Math.floor(cs.length / 2)].toFixed(1)
);
