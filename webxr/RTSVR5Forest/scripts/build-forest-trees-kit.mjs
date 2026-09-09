#!/usr/bin/env node
/**
 * Build a natural-looking forest props kit for RTSVR5Forest.
 *
 * Source pack trees are FBX Z-up billboard cards (tallest axis = Z). We:
 *   - rotate Z-up → Y-up so trunks stand on the crater
 *   - plant on SM_Rock / DirtPile sites only (skip cliffs)
 *   - clear a fight bowl, enforce min spacing, vary scale/yaw
 *   - sink feet slightly so they don't float
 *
 *   node RTSVR5Forest/scripts/build-forest-trees-kit.mjs
 *
 * Out: assets/terrain/forest-trees-kit.glb
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TREE_SRC = path.join(ROOT, 'assets/low_poly_forest_tree_pack.glb');
const ROCKS_SRC = path.join(ROOT, 'assets/terrain/scifi-rts-rocks.glb');
const OUT = path.join(ROOT, 'assets/terrain/forest-trees-kit.glb');

const TARGET_H_MIN = Number(process.env.TREE_H_MIN || 6);
const TARGET_H_MAX = Number(process.env.TREE_H_MAX || 14);
const CLEAR_R = Number(process.env.CLEAR_R || 42);
const MIN_SPACING = Number(process.env.MIN_SPACING || 4.5);
const MAX_TREES = Math.max(80, Number(process.env.MAX_TREES || 520));
const SINK_M = Number(process.env.SINK || 0.2);
const CROSS_BILLBOARD = process.env.CROSS !== '0'; // second card @ 90° for atlas trees

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = dv.getUint32(12, true);
  let text = new TextDecoder().decode(buf.subarray(20, 20 + jsonLen));
  text = text.replace(/:\s*-?inf\b/gi, ':null').replace(/:\s*nan\b/gi, ':null');
  const json = JSON.parse(text);
  const binOff = 20 + jsonLen;
  const binLen = dv.getUint32(binOff, true);
  const bin = Buffer.from(buf.subarray(binOff + 8, binOff + 8 + binLen));
  return { json, bin };
}

function pad4(n) {
  return (4 - (n % 4)) % 4;
}

function writeGlb(json, bin) {
  json.buffers = [{ byteLength: bin.length }];
  const jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonPad = pad4(jsonBuf.length);
  const binPad = pad4(bin.length);
  const jsonChunk = jsonBuf.length + jsonPad;
  const binChunk = bin.length + binPad;
  const out = Buffer.alloc(12 + 8 + jsonChunk + 8 + binChunk);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonChunk, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBuf.copy(out, 20);
  out.fill(0x20, 20 + jsonBuf.length, 20 + jsonChunk);
  const binHdr = 20 + jsonChunk;
  out.writeUInt32LE(binChunk, binHdr);
  out.writeUInt32LE(0x004e4942, binHdr + 4);
  bin.copy(out, binHdr + 8);
  return out;
}

function meshAabb(json, meshIndex) {
  const mesh = json.meshes[meshIndex];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const prim of mesh.primitives || []) {
    const acc = json.accessors?.[prim.attributes?.POSITION];
    if (!acc?.min || !acc?.max) continue;
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], acc.min[k]);
      max[k] = Math.max(max[k], acc.max[k]);
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return { min, max, size };
}

/** Pack is Z-up for atlas cards (tallest = Z). Rocks are roughly Y-up. */
function orientForWorldUp(name, aabb) {
  const [sx, sy, sz] = aabb.size;
  const isAtlas = /background_tree|atlas/i.test(name);
  const isRock = /^rocks/i.test(name);
  if (isAtlas || (!isRock && sz >= sy * 1.25 && sz >= sx * 1.25)) {
    // Rotate X −90°: (x,y,z) → (x, z, −y). Z becomes up.
    const q = { x: -Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 };
    // After rot: worldY = oldZ. Feet ≈ old minZ.
    const height = sz;
    const footY = aabb.min[2];
    return { q, height, footY, kind: 'atlas' };
  }
  // Already Y-up (pack rocks)
  return {
    q: { x: 0, y: 0, z: 0, w: 1 },
    height: Math.max(sy, 0.01),
    footY: aabb.min[1],
    kind: 'rock',
  };
}

function mulQuat(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

function yawQuat(rad) {
  const h = rad * 0.5;
  return { x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) };
}

function hash01(i, salt) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const trees = parseGlb(fs.readFileSync(TREE_SRC));
const rocks = parseGlb(fs.readFileSync(ROCKS_SRC));

// Double-sided + MASK cutouts (BLEND is costly on Quest and sorts badly at density).
for (const mat of trees.json.materials || []) {
  const n = mat.name || '';
  if (/tree|atlas|branch|leaf|foliage|background/i.test(n)) {
    mat.doubleSided = true;
    if (mat.alphaMode === 'BLEND' || mat.alphaMode === 'MASK') {
      mat.alphaMode = 'MASK';
      mat.alphaCutoff = mat.alphaCutoff != null ? mat.alphaCutoff : 0.4;
    }
  }
}

const protos = [];
for (let i = 0; i < (trees.json.meshes || []).length; i++) {
  const name = trees.json.meshes[i].name || '';
  if (!/background_tree|atlas|^rocks/i.test(name)) continue;
  if (/water/i.test(name)) continue;
  const aabb = meshAabb(trees.json, i);
  if (!Number.isFinite(aabb.size[0])) continue;
  const orient = orientForWorldUp(name, aabb);
  // Skip tiny clutter rocks for canopy; keep a few larger pack rocks.
  if (orient.kind === 'rock' && orient.height < 0.8) continue;
  protos.push({ mesh: i, name, ...orient, aabb });
}
if (!protos.length) throw new Error('no prototypes');

const atlasProtos = protos.filter((p) => p.kind === 'atlas');
const rockProtos = protos.filter((p) => p.kind === 'rock');
if (!atlasProtos.length) throw new Error('no atlas tree prototypes');

// Planting sites: flat-ish rock / dirt only — cliffs look wrong as tree bases.
const sites = (rocks.json.nodes || [])
  .filter((n) => {
    if (n.mesh == null) return false;
    return /SM_Rock_|SM_DirtPile_/i.test(n.name || '');
  })
  .map((n) => ({
    x: n.translation?.[0] ?? 0,
    y: n.translation?.[1] ?? 0,
    z: n.translation?.[2] ?? 0,
    name: n.name || '',
  }))
  .filter((s) => s.x * s.x + s.z * s.z >= CLEAR_R * CLEAR_R);

sites.sort((a, b) => a.x * a.x + a.z * a.z - (b.x * b.x + b.z * b.z));

const placed = [];
const minD2 = MIN_SPACING * MIN_SPACING;
for (const s of sites) {
  if (placed.length >= MAX_TREES) break;
  let ok = true;
  for (const p of placed) {
    const dx = p.x - s.x;
    const dz = p.z - s.z;
    if (dx * dx + dz * dz < minD2) {
      ok = false;
      break;
    }
  }
  if (ok) placed.push(s);
}

// Fill remaining budget with jittered copies of accepted sites (natural clumps).
let fill = 0;
while (placed.length < Math.min(MAX_TREES, sites.length) && fill < sites.length * 3) {
  fill++;
  const base = sites[fill % sites.length];
  const ang = hash01(fill, 1) * Math.PI * 2;
  const rad = 2.5 + hash01(fill, 2) * 6;
  const x = base.x + Math.cos(ang) * rad;
  const z = base.z + Math.sin(ang) * rad;
  if (x * x + z * z < CLEAR_R * CLEAR_R) continue;
  let ok = true;
  for (const p of placed) {
    const dx = p.x - x;
    const dz = p.z - z;
    if (dx * dx + dz * dz < minD2) {
      ok = false;
      break;
    }
  }
  if (!ok) continue;
  // Interpolate Y from nearest original site
  let best = base;
  let bestD = Infinity;
  for (const s of sites) {
    const dx = s.x - x;
    const dz = s.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  placed.push({ x, y: best.y, z, name: 'jitter' });
}

const outNodes = [];
let atlasCount = 0;
let rockCount = 0;

for (let i = 0; i < placed.length; i++) {
  const s = placed[i];
  // ~85% trees, ~15% pack rocks for ground clutter
  const useRock = rockProtos.length && hash01(i, 9) < 0.15;
  const proto = useRock
    ? rockProtos[Math.floor(hash01(i, 3) * rockProtos.length) % rockProtos.length]
    : atlasProtos[Math.floor(hash01(i, 4) * atlasProtos.length) % atlasProtos.length];

  const hTarget = TARGET_H_MIN + hash01(i, 5) * (TARGET_H_MAX - TARGET_H_MIN);
  const uni = hTarget / proto.height;
  const yaw = hash01(i, 6) * Math.PI * 2;
  const q = mulQuat(yawQuat(yaw), proto.q);
  // Feet on site Y, slight sink
  const y = s.y - proto.footY * uni - SINK_M;

  const baseName = `Forest_${proto.kind}_${i}`;
  outNodes.push({
    name: baseName,
    mesh: proto.mesh,
    translation: [s.x, y, s.z],
    rotation: [q.x, q.y, q.z, q.w],
    scale: [uni, uni, uni],
  });
  if (proto.kind === 'atlas') atlasCount++;
  else rockCount++;

  // Crossed billboard: second card for readable canopy from side angles
  if (CROSS_BILLBOARD && proto.kind === 'atlas') {
    const q2 = mulQuat(yawQuat(yaw + Math.PI / 2), proto.q);
    outNodes.push({
      name: `${baseName}_cross`,
      mesh: proto.mesh,
      translation: [s.x, y, s.z],
      rotation: [q2.x, q2.y, q2.z, q2.w],
      scale: [uni, uni, uni],
    });
  }
}

const outJson = {
  asset: { version: '2.0', generator: 'build-forest-trees-kit' },
  scenes: [{ name: 'ForestTreesKit', nodes: outNodes.map((_, i) => i) }],
  scene: 0,
  nodes: outNodes,
  meshes: trees.json.meshes,
  accessors: trees.json.accessors,
  bufferViews: trees.json.bufferViews,
  materials: trees.json.materials,
  textures: trees.json.textures,
  images: trees.json.images,
  samplers: trees.json.samplers,
  buffers: [{ byteLength: trees.bin.length }],
  extras: {
    rtsForestKit: {
      seated: true,
      clearRadiusM: CLEAR_R,
      minSpacingM: MIN_SPACING,
      treeSites: placed.length,
      atlasCount,
      rockCount,
      crossedBillboards: CROSS_BILLBOARD,
    },
  },
};
if (trees.json.extensionsUsed) outJson.extensionsUsed = [...trees.json.extensionsUsed];
if (trees.json.extensionsRequired) outJson.extensionsRequired = trees.json.extensionsRequired;

const outBuf = writeGlb(outJson, trees.bin);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, outBuf);

const imgBytes = (outJson.images || []).reduce(
  (s, im) => s + (im.bufferView != null ? outJson.bufferViews[im.bufferView].byteLength : 0),
  0
);

console.log(
  JSON.stringify(
    {
      out: OUT,
      bytes: outBuf.length,
      mb: +(outBuf.length / 1048576).toFixed(2),
      nodes: outNodes.length,
      treeSites: placed.length,
      atlasCount,
      rockCount,
      clearRadiusM: CLEAR_R,
      minSpacingM: MIN_SPACING,
      heightM: [TARGET_H_MIN, TARGET_H_MAX],
      texPayloadMB: +(imgBytes / 1048576).toFixed(2),
      materials: (outJson.materials || []).length,
      crossedBillboards: CROSS_BILLBOARD,
    },
    null,
    2
  )
);
console.log('PASS build-forest-trees-kit');
