#!/usr/bin/env node
/**
 * Build forest props kit for RTSVR5Forest — moon dressing via InstancedMesh (rocks path).
 *
 * Uses the Sketchfab pack's **world matrices** for native orientation + proportions
 * (tall trees stay tall; grass/bushes stay small; rocks sit upright).
 * Scatters across the full skirmish disk (past nav, into rim/skirt), feet at Y=0;
 * runtime seats each instance onto the moon heightfield.
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
const OUT = path.join(ROOT, 'assets/terrain/forest-trees-kit.glb');

/** Clear fight bowl (m). */
const CLEAR_R = Number(process.env.CLEAR_R || 28);
/** Scatter out to rim / inner skirt (m) — past MAP_UNIT_NAV_RADIUS (~170). */
const SCATTER_R = Number(process.env.SCATTER_R || 280);
const MIN_SPACING = Number(process.env.MIN_SPACING || 3.5);
const MAX_PLANTS = Math.max(200, Number(process.env.MAX_TREES || 1200));
const SINK_M = Number(process.env.SINK || 0.08);
const CROSS_BILLBOARD = process.env.CROSS !== '0';
const SCALE_JITTER = Number(process.env.SCALE_JITTER || 0.15);

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

function mulMat(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
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
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Column-major mat4 → unit quaternion (rotation only; scale stripped). */
function quatFromMat4(m) {
  let sx = Math.hypot(m[0], m[1], m[2]) || 1;
  let sy = Math.hypot(m[4], m[5], m[6]) || 1;
  let sz = Math.hypot(m[8], m[9], m[10]) || 1;
  const r00 = m[0] / sx;
  const r01 = m[4] / sy;
  const r02 = m[8] / sz;
  const r10 = m[1] / sx;
  const r11 = m[5] / sy;
  const r12 = m[9] / sz;
  const r20 = m[2] / sx;
  const r21 = m[6] / sy;
  const r22 = m[10] / sz;
  const tr = r00 + r11 + r22;
  let qw;
  let qx;
  let qy;
  let qz;
  if (tr > 0) {
    const S = Math.sqrt(tr + 1) * 2;
    qw = 0.25 * S;
    qx = (r21 - r12) / S;
    qy = (r02 - r20) / S;
    qz = (r10 - r01) / S;
  } else if (r00 > r11 && r00 > r22) {
    const S = Math.sqrt(1 + r00 - r11 - r22) * 2;
    qw = (r21 - r12) / S;
    qx = 0.25 * S;
    qy = (r01 + r10) / S;
    qz = (r02 + r20) / S;
  } else if (r11 > r22) {
    const S = Math.sqrt(1 + r11 - r00 - r22) * 2;
    qw = (r02 - r20) / S;
    qx = (r01 + r10) / S;
    qy = 0.25 * S;
    qz = (r12 + r21) / S;
  } else {
    const S = Math.sqrt(1 + r22 - r00 - r11) * 2;
    qw = (r10 - r01) / S;
    qx = (r02 + r20) / S;
    qy = (r12 + r21) / S;
    qz = 0.25 * S;
  }
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  return { x: qx / n, y: qy / n, z: qz / n, w: qw / n };
}

function rotateVec(q, v) {
  const ux = q.x;
  const uy = q.y;
  const uz = q.z;
  const uw = q.w;
  const ix = uw * v[0] + uy * v[2] - uz * v[1];
  const iy = uw * v[1] + uz * v[0] - ux * v[2];
  const iz = uw * v[2] + ux * v[1] - uy * v[0];
  const iw = -ux * v[0] - uy * v[1] - uz * v[2];
  return [
    ix * uw + iw * -ux + iy * -uz - iz * -uy,
    iy * uw + iw * -uy + iz * -ux - ix * -uz,
    iz * uw + iw * -uz + ix * -uy - iy * -ux,
  ];
}

function aabbAfterQuat(aabb, q) {
  const corners = [];
  for (const x of [aabb.min[0], aabb.max[0]]) {
    for (const y of [aabb.min[1], aabb.max[1]]) {
      for (const z of [aabb.min[2], aabb.max[2]]) {
        corners.push(rotateVec(q, [x, y, z]));
      }
    }
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const c of corners) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], c[k]);
      max[k] = Math.max(max[k], c[k]);
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
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
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const world = new Array(trees.json.nodes.length);

function walkNode(i, parent) {
  const n = trees.json.nodes[i];
  const local = n.matrix ? n.matrix.slice() : I;
  world[i] = mulMat(parent, local);
  for (const c of n.children || []) walkNode(c, world[i]);
}
for (const r of trees.json.scenes[trees.json.scene || 0].nodes || []) walkNode(r, I);

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

/** @type {{ mesh: number, name: string, q: object, height: number, footY: number, kind: string }[]} */
const protos = [];
for (let i = 0; i < (trees.json.nodes || []).length; i++) {
  const n = trees.json.nodes[i];
  if (n.mesh == null) continue;
  const meshName = trees.json.meshes[n.mesh].name || n.name || '';
  if (!/background_tree|atlas|^rocks/i.test(meshName)) continue;
  if (/water/i.test(meshName)) continue;

  const aabb = meshAabb(trees.json, n.mesh);
  const q = quatFromMat4(world[i]);
  const local = aabbAfterQuat(aabb, q);
  const height = Math.max(local.size[1], 0.05);
  const footY = local.min[1];

  let kind = 'bush';
  if (/^rocks/i.test(meshName)) kind = 'rock';
  else if (height >= 12) kind = 'tree';
  else if (height >= 4) kind = 'sapling';
  else kind = 'bush';

  // Skip dust-speck rocks
  if (kind === 'rock' && height < 0.25) continue;

  protos.push({ mesh: n.mesh, name: meshName, q, height, footY, kind });
}
if (!protos.length) throw new Error('no prototypes');

const byKind = {
  tree: protos.filter((p) => p.kind === 'tree'),
  sapling: protos.filter((p) => p.kind === 'sapling'),
  bush: protos.filter((p) => p.kind === 'bush'),
  rock: protos.filter((p) => p.kind === 'rock'),
};
if (!byKind.tree.length) throw new Error('no tree prototypes from pack world matrices');

console.log(
  'protos',
  Object.fromEntries(
    Object.entries(byKind).map(([k, v]) => [
      k,
      v.map((p) => ({ n: p.name.slice(0, 28), h: +p.height.toFixed(2) })),
    ])
  )
);

/** Blue-noise-ish polar scatter covering CLEAR_R…SCATTER_R. */
const placed = [];
const minD2 = MIN_SPACING * MIN_SPACING;
let attempt = 0;
const attemptCap = MAX_PLANTS * 40;
while (placed.length < MAX_PLANTS && attempt < attemptCap) {
  attempt++;
  // Bias density toward outer ring (fill edges / skirt) while keeping mid-field cover.
  const u = hash01(attempt, 1);
  const r = CLEAR_R + Math.pow(u, 0.65) * (SCATTER_R - CLEAR_R);
  const ang = hash01(attempt, 2) * Math.PI * 2;
  const x = Math.cos(ang) * r;
  const z = Math.sin(ang) * r;
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

  // Outer ring: more bushes/rocks; mid: trees.
  const ring = (r - CLEAR_R) / Math.max(SCATTER_R - CLEAR_R, 1);
  const roll = hash01(attempt, 3);
  let pool;
  if (ring > 0.72) {
    pool = roll < 0.45 ? byKind.bush : roll < 0.7 ? byKind.sapling : roll < 0.88 ? byKind.tree : byKind.rock;
  } else if (ring > 0.35) {
    pool = roll < 0.55 ? byKind.tree : roll < 0.78 ? byKind.sapling : roll < 0.92 ? byKind.bush : byKind.rock;
  } else {
    pool = roll < 0.4 ? byKind.tree : roll < 0.65 ? byKind.sapling : roll < 0.88 ? byKind.bush : byKind.rock;
  }
  if (!pool.length) pool = byKind.tree;
  const proto = pool[Math.floor(hash01(attempt, 4) * pool.length) % pool.length];
  placed.push({ x, z, proto, seed: attempt });
}

const outNodes = [];
let counts = { tree: 0, sapling: 0, bush: 0, rock: 0, cross: 0 };

for (let i = 0; i < placed.length; i++) {
  const { x, z, proto, seed } = placed[i];
  const jitter = 1 + (hash01(seed, 5) * 2 - 1) * SCALE_JITTER;
  // Keep pack-native proportions — only mild jitter (do NOT normalize all to 6–14 m).
  const uni = Math.max(0.35, jitter);
  const yaw = hash01(seed, 6) * Math.PI * 2;
  const q = mulQuat(yawQuat(yaw), proto.q);
  const y = -proto.footY * uni - SINK_M;

  const baseName = `Forest_${proto.kind}_${i}`;
  outNodes.push({
    name: baseName,
    mesh: proto.mesh,
    translation: [x, y, z],
    rotation: [q.x, q.y, q.z, q.w],
    scale: [uni, uni, uni],
  });
  counts[proto.kind] = (counts[proto.kind] || 0) + 1;

  // Crossed card only for tall billboard trees (not tiny grass cards / rocks).
  if (CROSS_BILLBOARD && (proto.kind === 'tree' || proto.kind === 'sapling') && proto.height >= 5) {
    const q2 = mulQuat(yawQuat(yaw + Math.PI / 2), proto.q);
    outNodes.push({
      name: `${baseName}_cross`,
      mesh: proto.mesh,
      translation: [x, y, z],
      rotation: [q2.x, q2.y, q2.z, q2.w],
      scale: [uni, uni, uni],
    });
    counts.cross++;
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
      seatedFeetAtZero: true,
      scatterMeters: true,
      clearRadiusM: CLEAR_R,
      scatterRadiusM: SCATTER_R,
      minSpacingM: MIN_SPACING,
      plantSites: placed.length,
      counts,
      crossedBillboards: CROSS_BILLBOARD,
      scaleFromPackWorldMatrix: true,
    },
  },
};
if (trees.json.extensionsUsed) outJson.extensionsUsed = [...trees.json.extensionsUsed];
if (trees.json.extensionsRequired) outJson.extensionsRequired = trees.json.extensionsRequired;

const outBuf = writeGlb(outJson, trees.bin);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, outBuf);

console.log(
  JSON.stringify(
    {
      out: OUT,
      bytes: outBuf.length,
      mb: +(outBuf.length / 1048576).toFixed(2),
      nodes: outNodes.length,
      plantSites: placed.length,
      counts,
      clearRadiusM: CLEAR_R,
      scatterRadiusM: SCATTER_R,
      minSpacingM: MIN_SPACING,
      note: 'native pack scales/orient; feet y=0; seat on moon at runtime',
    },
    null,
    2
  )
);
console.log('PASS build-forest-trees-kit');
