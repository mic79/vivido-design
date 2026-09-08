#!/usr/bin/env node
/**
 * Pad terrain-skirmish-1v1.glb Prop_* count to ~1153×DENSITY by cloning nodes.
 * Y comes from a nearest-neighbor lookup of existing seated props (already on crater).
 *
 *   DENSITY=10 node RTSVR5/scripts/pad-1v1-rock-density.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');
const DENSITY = Math.max(1, Number(process.env.DENSITY || 10));
const ORIG_BASE = 1153;
const CLEAR = 42;
const HALF = 92;

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

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function nearestY(samples, x, z) {
  let best = samples[0].y;
  let bestD = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const d = (s.x - x) * (s.x - x) + (s.z - z) * (s.z - z);
    if (d < bestD) {
      bestD = d;
      best = s.y;
      if (d < 1) break;
    }
  }
  return best;
}

const buf = fs.readFileSync(GLB);
const { json, bin } = parseGlb(buf);
const nodes = json.nodes || [];
const propIdx = [];
for (let i = 0; i < nodes.length; i++) {
  const n = nodes[i];
  if (/^Prop_/i.test(n.name || '') && n.mesh != null) propIdx.push(i);
}
const base = propIdx.length;
const want = Math.round(ORIG_BASE * DENSITY);
const rand = mulberry32(20260908);
const samples = propIdx.map((i) => {
  const t = nodes[i].translation || [0, 0, 0];
  return { x: t[0], y: t[1], z: t[2] };
});

console.log(`pad-1v1: props=${base} want=${want}`);
if (base >= want) {
  console.log('pad-1v1: already at/above target');
  process.exit(0);
}

const added = [];
let guard = 0;
while (base + added.length < want && guard < want * 20) {
  guard++;
  const src = nodes[propIdx[Math.floor(rand() * propIdx.length)]];
  const t = src.translation ? src.translation.slice() : [0, 0, 0];
  let x;
  let z;
  if (rand() < 0.55) {
    const ang = rand() * Math.PI * 2;
    const rad = 1.5 + rand() * 12;
    x = t[0] + Math.cos(ang) * rad;
    z = t[2] + Math.sin(ang) * rad;
  } else {
    const rr = CLEAR + rand() * (HALF - CLEAR);
    const aa = rand() * Math.PI * 2;
    x = Math.cos(aa) * rr;
    z = Math.sin(aa) * rr;
  }
  const r = Math.hypot(x, z);
  if (r < CLEAR || r > HALF) continue;
  const y = nearestY(samples, x, z) - 0.12;
  const sc = src.scale ? src.scale.slice() : [1, 1, 1];
  const sm = 0.7 + rand() * 0.55;
  const node = {
    name: `Prop_pad_${added.length}`,
    mesh: src.mesh,
    translation: [x, y, z],
    scale: [sc[0] * sm, sc[1] * sm, sc[2] * sm],
  };
  if (src.rotation) node.rotation = src.rotation.slice();
  added.push(node);
}

const start = nodes.length;
for (const n of added) nodes.push(n);
json.nodes = nodes;
const scene = json.scenes?.[json.scene || 0];
if (scene) {
  scene.nodes = scene.nodes || [];
  for (let i = start; i < nodes.length; i++) scene.nodes.push(i);
}

const out = writeGlb(json, bin);
fs.writeFileSync(GLB, out);
console.log(
  `pad-1v1: wrote ${added.length} extras → total props=${base + added.length} bytes=${out.length}`
);
