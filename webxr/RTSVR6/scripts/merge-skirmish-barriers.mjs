#!/usr/bin/env node
/**
 * Merge Cross/X barrier placements into the live skirmish GLB by cloning
 * existing Prop_* mesh buffers. Also clears competing non-barrier props in
 * the diagonal ridge corridor so the canyon reads as walls, not extra rocks.
 *
 * Prefers terrain-skirmish-1v1.glb.pre-barriers.bak as the clean base when present.
 *
 *   node RTSVR6/scripts/merge-skirmish-barriers.mjs
 *   WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1 node RTSVR6/scripts/merge-skirmish-barriers.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');
const BAK = LIVE + '.pre-barriers.bak';
const BARRIERS = path.join(ROOT, 'export/skirmish-1v1-barriers.json');
const WRITE_LIVE =
  process.env.WRITE_LIVE === '1' && process.env.CONFIRM_WRITE_LIVE === '1';
const OUT =
  process.env.OUT ||
  (WRITE_LIVE ? LIVE : path.join(ROOT, 'export/terrain-skirmish-1v1.barriers-merged.glb'));

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = dv.getUint32(12, true);
  let jsonText = Buffer.from(buf.subarray(20, 20 + jsonLen)).toString('utf8');
  jsonText = jsonText.replace(/:\s*-?inf\b/gi, ':null').replace(/:\s*nan\b/gi, ':null');
  const json = JSON.parse(jsonText);
  const binStart = 20 + jsonLen;
  const binLen = dv.getUint32(binStart, true);
  const bin = buf.subarray(binStart + 8, binStart + 8 + binLen);
  return { json, bin: Buffer.from(bin) };
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
  for (let i = 0; i < binPad; i++) out[binOff + 8 + bin.length + i] = 0;
  return out;
}

function meshHintFromName(name) {
  const m = String(name || '').match(/SM_(Cliff|Rock|Mineral|DirtPile)_\d+/i);
  return m ? m[0] : null;
}

function remapDrop(json, scene, dropIdx) {
  if (!dropIdx.size) return;
  const keep = [];
  const oldToNew = new Map();
  let ni = 0;
  for (let i = 0; i < json.nodes.length; i++) {
    if (dropIdx.has(i)) continue;
    oldToNew.set(i, ni++);
    keep.push(json.nodes[i]);
  }
  json.nodes = keep;
  scene.nodes = scene.nodes.map((i) => oldToNew.get(i)).filter((i) => i != null);
  for (const n of json.nodes) {
    if (Array.isArray(n.children)) {
      n.children = n.children.map((i) => oldToNew.get(i)).filter((i) => i != null);
    }
  }
}

const barriers = JSON.parse(fs.readFileSync(BARRIERS, 'utf8'));
const placements = barriers.placements || [];
const corridor = barriers.ridgeCorridor || {
  maxDistToDiagonal: 11,
  rMin: 26,
  rMax: 88,
};
const clear = barriers.clearance || { midR: 24, flankHalfW: 14, flankMinAbs: 26 };

const srcPath = fs.existsSync(BAK) ? BAK : LIVE;
console.log('base', srcPath, fs.statSync(srcPath).size);
const { json, bin } = parseGlb(fs.readFileSync(srcPath));
json.nodes = json.nodes || [];
json.scenes = json.scenes || [{ nodes: [] }];
const scene = json.scenes[json.scene ?? 0] || json.scenes[0];
scene.nodes = scene.nodes || [];

const S = 1 / Math.SQRT2;
function distToXRidge(x, z) {
  return Math.min(Math.abs(x - z) * S, Math.abs(x + z) * S);
}

const dropIdx = new Set();
let droppedBarriers = 0;
let droppedCorridor = 0;
for (let i = 0; i < json.nodes.length; i++) {
  const n = json.nodes[i];
  const name = n?.name || '';
  if (/_Barrier_/i.test(name) || /^Barrier_/i.test(name) || /^ValleyCliff_/i.test(name)) {
    dropIdx.add(i);
    droppedBarriers++;
    continue;
  }
  if (!/^Prop_/i.test(name)) continue;
  const t = n.translation || [0, 0, 0];
  const x = t[0];
  const z = t[2];
  const r = Math.hypot(x, z);
  if (r < corridor.rMin || r > corridor.rMax) continue;
  if (r < clear.midR) continue;
  const ax = Math.abs(x);
  const az = Math.abs(z);
  // Keep flank corridors open (don't strip props that aren't on the ridge).
  if (ax < clear.flankHalfW && az > clear.flankMinAbs) continue;
  if (az < clear.flankHalfW && ax > clear.flankMinAbs) continue;
  if (distToXRidge(x, z) <= corridor.maxDistToDiagonal) {
    dropIdx.add(i);
    droppedCorridor++;
  }
}
remapDrop(json, scene, dropIdx);
console.log('removed prior barriers', droppedBarriers, 'cleared ridge competitors', droppedCorridor);

const protoMesh = new Map();
for (const n of json.nodes) {
  if (typeof n.mesh !== 'number') continue;
  const hint = meshHintFromName(n.name);
  if (hint && !protoMesh.has(hint)) protoMesh.set(hint, n.mesh);
}

let added = 0;
let skipped = 0;
for (const p of placements) {
  const hint = p.meshHint || meshHintFromName(p.name);
  const mesh = protoMesh.get(hint);
  if (mesh == null) {
    console.warn('no prototype mesh for', hint);
    skipped++;
    continue;
  }
  const node = {
    name: p.name || `Prop_${hint}_Barrier_${added}`,
    mesh,
    translation: p.translation || [0, 0, 0],
    rotation: p.rotation || [0, 0, 0, 1],
    scale: p.scale || [1, 1, 1],
  };
  const idx = json.nodes.length;
  json.nodes.push(node);
  scene.nodes.push(idx);
  added++;
}

const propCount = json.nodes.filter((n) => /^Prop_/i.test(n.name || '')).length;
console.log('barriers added', added, 'skipped', skipped, 'props total', propCount);

if (!WRITE_LIVE && OUT === LIVE) {
  console.error('Refusing to overwrite LIVE without WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1');
  process.exit(2);
}

if (WRITE_LIVE && !fs.existsSync(BAK)) {
  fs.copyFileSync(LIVE, BAK);
  console.log('created bak', BAK);
}

const outBuf = writeGlb(json, bin);
fs.writeFileSync(OUT, outBuf);
console.log('wrote', OUT, outBuf.length);
if (!WRITE_LIVE) {
  console.log('Dry-run. Re-run with WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1 to replace live GLB.');
}
