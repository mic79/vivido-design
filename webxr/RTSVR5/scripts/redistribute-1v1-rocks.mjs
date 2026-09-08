#!/usr/bin/env node
/**
 * Rebuild Prop_* in terrain-skirmish-1v1.glb:
 *   - sizes [MIN_M, MAX_M] (default 1 .. previous 1v1 max 58.2), kit-like mix
 *   - EVEN coverage over the FULL visual terrain (plate + skirts to ~±1000 m)
 *
 *   node RTSVR5/scripts/redistribute-1v1-rocks.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');
const ROCKS_SRC = path.join(ROOT, 'assets/terrain/scifi-rts-rocks.glb');
const OUT_JSON = path.join(ROOT, 'export/skirmish-1v1-placements.json');

const PREV_MAX_M = 58.2;
const MIN_M = Math.max(0.1, Number(process.env.MIN_M || 1));
const MAX_M = Math.max(MIN_M, Number(process.env.MAX_M || PREV_MAX_M));
const COUNT = Math.max(100, Number(process.env.COUNT || 25000));
/** 0 = cover entire surface including crater bowl. */
const CLEAR = Math.max(0, Number(process.env.CLEAR || 0));
/** Skirt outer half-extent (Moon_1 is ±1020 m). Cover nearly the full visual terrain. */
const HALF = Number(process.env.HALF || 1000);
const HEIGHT_CELL = Number(process.env.HEIGHT_CELL || 10);
const SINK = 0.12;
const SEED = Number(process.env.SEED || 20260908);

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(Buffer.from(buf.subarray(20, 20 + jsonLen)).toString('utf8'));
  const binStart = 20 + jsonLen;
  const binLen = dv.getUint32(binStart, true);
  const bin = buf.subarray(binStart + 8, binStart + 8 + binLen);
  return { json, bin };
}

function writeGlb(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunkLen = jsonBuf.length + jsonPad;
  const binChunkLen = bin.length + binPad;
  const out = Buffer.alloc(12 + 8 + jsonChunkLen + 8 + binChunkLen);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonChunkLen, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBuf.copy(out, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBuf.length + i] = 0x20;
  const binOff = 20 + jsonChunkLen;
  out.writeUInt32LE(binChunkLen, binOff);
  out.writeUInt32LE(0x004e4942, binOff + 4);
  bin.copy(out, binOff + 8);
  return out;
}

function readPositions(json, bin, accIdx) {
  const acc = json.accessors[accIdx];
  const bv = json.bufferViews[acc.bufferView];
  const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const stride = bv.byteStride || 12;
  const out = new Float32Array(acc.count * 3);
  for (let i = 0; i < acc.count; i++) {
    const o = off + i * stride;
    out[i * 3] = bin.readFloatLE(o);
    out[i * 3 + 1] = bin.readFloatLE(o + 4);
    out[i * 3 + 2] = bin.readFloatLE(o + 8);
  }
  return out;
}

function readIndices(json, bin, accIdx) {
  if (accIdx == null) return null;
  const acc = json.accessors[accIdx];
  const bv = json.bufferViews[acc.bufferView];
  const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const comps = acc.count;
  const out = new Uint32Array(comps);
  if (acc.componentType === 5123) {
    for (let i = 0; i < comps; i++) out[i] = bin.readUInt16LE(off + i * 2);
  } else {
    for (let i = 0; i < comps; i++) out[i] = bin.readUInt32LE(off + i * 4);
  }
  return out;
}

function quatRotate(q, v) {
  // q = [x,y,z,w]
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const ix = qw * vx + qy * vz - qz * vy;
  const iy = qw * vy + qz * vx - qx * vz;
  const iz = qw * vz + qx * vy - qy * vx;
  const iw = -qx * vx - qy * vy - qz * vz;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

function nodeWorldMatrix(node) {
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return { t, r, s };
}

function transformPoint(xf, p) {
  let [x, y, z] = p;
  x *= xf.s[0];
  y *= xf.s[1];
  z *= xf.s[2];
  [x, y, z] = quatRotate(xf.r, [x, y, z]);
  return [x + xf.t[0], y + xf.t[1], z + xf.t[2]];
}

function meshLocalChar(json, meshIdx) {
  const mesh = json.meshes[meshIdx];
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const prim of mesh.primitives || []) {
    const acc = json.accessors[prim.attributes.POSITION];
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], acc.min[i]);
      max[i] = Math.max(max[i], acc.max[i]);
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { name: mesh.name || `m${meshIdx}`, size, char: Math.max(...size) };
}

/** Height grid from ALL Moon_* meshes (plate + far skirts out to HALF). */
function buildHeightGrid(json, bin, moonNodeList) {
  const list = Array.isArray(moonNodeList) ? moonNodeList : [moonNodeList];
  const cell = HEIGHT_CELL;
  const n = Math.ceil((2 * HALF) / cell) + 1;
  const grid = new Float32Array(n * n);
  const w = new Float32Array(n * n);
  const add = (x, y, z) => {
    if (Math.abs(x) > HALF + cell || Math.abs(z) > HALF + cell) return;
    const ix = Math.round((x + HALF) / cell);
    const iz = Math.round((z + HALF) / cell);
    if (ix < 0 || iz < 0 || ix >= n || iz >= n) return;
    const i = iz * n + ix;
    grid[i] += y;
    w[i] += 1;
  };
  for (const moonNode of list) {
    if (!moonNode || moonNode.mesh == null) continue;
    const xf = nodeWorldMatrix(moonNode);
    const mesh = json.meshes[moonNode.mesh];
    for (const prim of mesh.primitives || []) {
      const pos = readPositions(json, bin, prim.attributes.POSITION);
      const idx = readIndices(json, bin, prim.indices);
      const triCount = idx ? idx.length / 3 : pos.length / 9;
      const step = Math.max(1, Math.floor(triCount / 120000));
      for (let t = 0; t < triCount; t += step) {
        let i0;
        let i1;
        let i2;
        if (idx) {
          i0 = idx[t * 3];
          i1 = idx[t * 3 + 1];
          i2 = idx[t * 3 + 2];
        } else {
          i0 = t * 3;
          i1 = t * 3 + 1;
          i2 = t * 3 + 2;
        }
        for (const ii of [i0, i1, i2]) {
          const p = transformPoint(xf, [pos[ii * 3], pos[ii * 3 + 1], pos[ii * 3 + 2]]);
          add(p[0], p[1], p[2]);
        }
      }
    }
  }
  for (let i = 0; i < grid.length; i++) {
    if (w[i] > 0) grid[i] /= w[i];
    else grid[i] = NaN;
  }
  for (let pass = 0; pass < 8; pass++) {
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        if (Number.isFinite(grid[i])) continue;
        let s = 0;
        let c = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const jx = ix + dx;
            const jz = iz + dz;
            if (jx < 0 || jz < 0 || jx >= n || jz >= n) continue;
            const v = grid[jz * n + jx];
            if (Number.isFinite(v)) {
              s += v;
              c++;
            }
          }
        }
        if (c) grid[i] = s / c;
      }
    }
  }
  return {
    sample(x, z) {
      const fx = (x + HALF) / cell;
      const fz = (z + HALF) / cell;
      const ix = Math.floor(fx);
      const iz = Math.floor(fz);
      if (ix < 0 || iz < 0 || ix >= n - 1 || iz >= n - 1) return 0;
      const tx = fx - ix;
      const tz = fz - iz;
      const i00 = grid[iz * n + ix];
      const i10 = grid[iz * n + ix + 1];
      const i01 = grid[(iz + 1) * n + ix];
      const i11 = grid[(iz + 1) * n + ix + 1];
      if (![i00, i10, i01, i11].every(Number.isFinite)) return Number.isFinite(i00) ? i00 : 0;
      const a = i00 * (1 - tx) + i10 * tx;
      const b = i01 * (1 - tx) + i11 * tx;
      return a * (1 - tz) + b * tz;
    },
  };
}

/** Even points over the full disk (CLEAR>0 only if an inner hole is requested). */
function evenDiskPoints(count, r0, r1, rand) {
  const pts = [];
  const area = Math.PI * (r1 * r1 - r0 * r0);
  const cellArea = area / count;
  const spacing = Math.sqrt(cellArea);
  const rings = Math.max(4, Math.round((r1 - r0) / Math.max(0.5, spacing)));
  for (let ri = 0; ri < rings; ri++) {
    const ra = r0 + ((ri + 0.5) / rings) * (r1 - r0);
    const circ = Math.max(1e-3, 2 * Math.PI * ra);
    const nOnRing = Math.max(1, Math.round(circ / spacing));
    const rot = rand() * Math.PI * 2;
    for (let k = 0; k < nOnRing; k++) {
      const ang = rot + ((k + rand() * 0.4) / nOnRing) * Math.PI * 2;
      const rr = Math.max(r0, Math.min(r1, ra + (rand() - 0.5) * spacing * 0.5));
      pts.push([Math.cos(ang) * rr, Math.sin(ang) * rr]);
    }
  }
  while (pts.length > count) pts.pop();
  while (pts.length < count) {
    const u = rand();
    const r = Math.sqrt(r0 * r0 + u * (r1 * r1 - r0 * r0));
    const a = rand() * Math.PI * 2;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}

/** Full-kit instance sizes → [MIN_M, MAX_M] preserving relative mix. */
function loadKitSizePalette(minM, maxM) {
  if (!fs.existsSync(ROCKS_SRC)) return null;
  const { json } = parseGlb(fs.readFileSync(ROCKS_SRC));
  const meshes = json.meshes || [];
  const chars = [];
  for (const n of json.nodes || []) {
    if (n.mesh == null) continue;
    const name = n.name || meshes[n.mesh]?.name || '';
    if (!/rock|cliff|dirt|mineral/i.test(name)) continue;
    const mesh = meshes[n.mesh];
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (const prim of mesh.primitives || []) {
      const acc = json.accessors[prim.attributes.POSITION];
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], acc.min[i]);
        max[i] = Math.max(max[i], acc.max[i]);
      }
    }
    const local = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const sc = n.scale || [1, 1, 1];
    chars.push(
      Math.max(local[0] * Math.abs(sc[0]), local[1] * Math.abs(sc[1]), local[2] * Math.abs(sc[2]))
    );
  }
  if (chars.length < 8) return null;
  chars.sort((a, b) => a - b);
  // Floor tiny kit pebbles to MIN_M; keep kit mid/large; clamp to MAX_M.
  return chars.map((c) => Math.max(minM, Math.min(maxM, c)));
}

const buf = fs.readFileSync(GLB);
const { json, bin } = parseGlb(buf);
const nodes = json.nodes || [];

const moonNodes = nodes.filter((n) => /^Moon_\d/i.test(n.name || '') && n.mesh != null);
const moon0 = moonNodes.find((n) => /^Moon_0/i.test(n.name)) || moonNodes[0];
if (!moon0) throw new Error('no Moon_0');
console.log(
  `[redistribute] moons=${moonNodes.map((n) => n.name).join(',')} HALF=${HALF} COUNT=${COUNT} sizes=[${MIN_M},${MAX_M}]`
);

const propMeshes = [];
for (let i = 0; i < (json.meshes || []).length; i++) {
  const info = meshLocalChar(json, i);
  if (/^(SM_)?(Rock|Cliff|Dirt|Mineral)/i.test(info.name)) {
    propMeshes.push({ mesh: i, ...info });
  }
}
if (!propMeshes.length) throw new Error('no rock meshes');

// Prefer smaller meshes for density; still include cliffs but rarer.
const weighted = [];
for (const m of propMeshes) {
  let w = 1;
  if (/Rock/i.test(m.name)) w = 4;
  else if (/Mineral/i.test(m.name)) w = 2;
  else if (/Dirt/i.test(m.name)) w = 1.5;
  else if (/Cliff/i.test(m.name)) w = 1.2;
  for (let i = 0; i < Math.max(1, Math.round(w * 10)); i++) weighted.push(m);
}

const sizePalette = loadKitSizePalette(MIN_M, MAX_M);
const height = buildHeightGrid(json, bin, moonNodes);
const rand = mulberry32(SEED);
const pts = evenDiskPoints(COUNT, CLEAR, HALF, rand);

const keepNodes = nodes.filter((n) => !/^Prop_/i.test(n.name || ''));
const newProps = [];
const placements = [];
let minOut = Infinity;
let maxOut = -Infinity;

for (let i = 0; i < pts.length; i++) {
  const [x, z] = pts[i];
  let mesh = weighted[Math.floor(rand() * weighted.length)];
  const target =
    sizePalette && sizePalette.length
      ? sizePalette[Math.floor(rand() * sizePalette.length)]
      : MIN_M * Math.pow(MAX_M / MIN_M, rand());
  if (target > 12) {
    const cliffs = propMeshes.filter((p) => /Cliff/i.test(p.name));
    if (cliffs.length) mesh = cliffs[Math.floor(rand() * cliffs.length)];
  } else if (target < 3) {
    const rocks = propMeshes.filter((p) => /Rock/i.test(p.name));
    if (rocks.length) mesh = rocks[Math.floor(rand() * rocks.length)];
  }
  const s = Math.max(MIN_M / mesh.char, Math.min(MAX_M / mesh.char, target / mesh.char));
  const char = mesh.char * s;
  minOut = Math.min(minOut, char);
  maxOut = Math.max(maxOut, char);
  const y = height.sample(x, z) - SINK;
  const yaw = rand() * Math.PI * 2;
  const hy = Math.sin(yaw / 2);
  const hw = Math.cos(yaw / 2);
  const node = {
    name: `Prop_${mesh.name}_${i}`,
    mesh: mesh.mesh,
    translation: [x, y, z],
    rotation: [0, hy, 0, hw],
    scale: [s, s, s],
  };
  newProps.push(node);
  placements.push({
    name: node.name,
    meshHint: mesh.name,
    translation: node.translation,
    scale: node.scale,
    char_m: +char.toFixed(3),
  });
}

json.nodes = [...keepNodes, ...newProps];
const scene = json.scenes?.[json.scene || 0];
if (scene) {
  // Rebuild root children: keep non-prop previous roots that still exist + all new props
  const keepSet = new Set(keepNodes);
  const oldNodes = nodes;
  const newChildren = [];
  for (let i = 0; i < keepNodes.length; i++) {
    // find if this keep node was a former root child
    newChildren.push(i);
  }
  // Only moon roots + lights etc. that were top-level — simpler: scene.nodes = all keep indices that were in old scene, remapped
  const oldIndex = new Map(oldNodes.map((n, i) => [n, i]));
  const keepIndex = new Map(keepNodes.map((n, i) => [n, i]));
  const remapped = [];
  for (const oi of scene.nodes || []) {
    const n = oldNodes[oi];
    if (!n || /^Prop_/i.test(n.name || '')) continue;
    const ni = keepIndex.get(n);
    if (ni != null) remapped.push(ni);
  }
  const propStart = keepNodes.length;
  for (let i = 0; i < newProps.length; i++) remapped.push(propStart + i);
  scene.nodes = remapped;
}

const out = writeGlb(json, bin);
fs.writeFileSync(GLB, out);
fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(
  OUT_JSON,
  JSON.stringify(
    {
      mapSize: 200,
      minM: MIN_M,
      maxM: MAX_M,
      count: newProps.length,
      clearRadiusM: CLEAR,
      halfSpanM: HALF,
      char_m: { min: +minOut.toFixed(3), max: +maxOut.toFixed(3) },
      placements,
      note: 'even annulus; min rock size MIN_M; Moon_* unchanged',
    },
    null,
    2
  )
);

console.log(
  JSON.stringify(
    {
      props: newProps.length,
      variants: propMeshes.length,
      char_m: { min: +minOut.toFixed(3), max: +maxOut.toFixed(3) },
      bytes: out.length,
      glb: GLB,
    },
    null,
    2
  )
);
