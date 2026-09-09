#!/usr/bin/env node
/**
 * Merge Moon_* geometry from a known-good GLB into a UE-normalized export.
 * Props / other scenery stay from UE. Fixes Interchange skirt decimation holes.
 *
 *   node RTSVR5/scripts/merge-moons-into-ue-export.mjs [ue-norm.glb] [moon-src.glb] [out.glb]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UE =
  process.argv[2] || 'D:/ue5/UE58_scifi/Exported/skirmish-1v1-normalized.glb';
const MOON_SRC =
  process.argv[3] ||
  path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb.pre-ue-pipeline.bak');
const OUT =
  process.argv[4] || 'D:/ue5/UE58_scifi/Exported/skirmish-1v1-merged.glb';

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(Buffer.from(buf.subarray(20, 20 + jsonLen)).toString('utf8'));
  const binStart = 20 + jsonLen;
  const binLen = dv.getUint32(binStart, true);
  const bin = Buffer.from(buf.subarray(binStart + 8, binStart + 8 + binLen));
  return { json, bin };
}

function writeGlb(json, bin) {
  json.buffers = [{ byteLength: bin.length }];
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
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
  const binOff = 20 + jsonChunk;
  out.writeUInt32LE(binChunk, binOff);
  out.writeUInt32LE(0x004e4942, binOff + 4);
  bin.copy(out, binOff + 8);
  out.fill(0, binOff + 8 + bin.length);
  return out;
}

function pad4(n) {
  return (4 - (n % 4)) % 4;
}

function copyAccessorBlob(srcJson, srcBin, accIdx, dstBin) {
  const acc = srcJson.accessors[accIdx];
  const bv = srcJson.bufferViews[acc.bufferView];
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  // Conservative: copy whole bufferView (common for tightly packed mesh attrs)
  const viewStart = bv.byteOffset || 0;
  const viewLen = bv.byteLength;
  const chunk = srcBin.subarray(viewStart, viewStart + viewLen);
  const off = dstBin.length + pad4(dstBin.length);
  const pad = Buffer.alloc(pad4(dstBin.length));
  const next = Buffer.concat([dstBin, pad, chunk]);
  const newBv = {
    buffer: 0,
    byteOffset: dstBin.length + pad.length,
    byteLength: viewLen,
  };
  if (bv.byteStride) newBv.byteStride = bv.byteStride;
  if (bv.target) newBv.target = bv.target;
  return { bin: next, bufferView: newBv, accessor: { ...acc, bufferView: -1, byteOffset: 0 } };
}

const ue = parseGlb(fs.readFileSync(UE));
const src = parseGlb(fs.readFileSync(MOON_SRC));

const srcMoonNodes = (src.json.nodes || []).filter((n) => /^Moon_[01]$/i.test(n.name || ''));
if (srcMoonNodes.length < 2) throw new Error('moon src missing Moon_0/1');

// Build new binary: keep UE bin, append moon bufferViews from src
let bin = ue.json.bin ? ue.bin : ue.bin;
bin = Buffer.from(ue.bin);
const bufferViews = [...(ue.json.bufferViews || [])];
const accessors = [...(ue.json.accessors || [])];
const meshes = [...(ue.json.meshes || [])];
const nodes = [...(ue.json.nodes || [])];
const materials = [...(ue.json.materials || [])];
const textures = [...(ue.json.textures || [])];
const images = [...(ue.json.images || [])];
const samplers = [...(ue.json.samplers || [])];

// Map moon name → new mesh index
const moonMeshIndex = {};

for (const sn of srcMoonNodes) {
  const name = sn.name;
  const sm = src.json.meshes[sn.mesh];
  const prim = sm.primitives[0];
  const attrMap = {};
  for (const [attr, accIdx] of Object.entries(prim.attributes)) {
    const { bin: b2, bufferView, accessor } = copyAccessorBlob(
      src.json,
      src.bin,
      accIdx,
      bin
    );
    bin = b2;
    const bvIdx = bufferViews.length;
    bufferViews.push(bufferView);
    accessor.bufferView = bvIdx;
    // Preserve byteOffset inside view if accessor had one relative to view
    const srcAcc = src.json.accessors[accIdx];
    accessor.byteOffset = srcAcc.byteOffset || 0;
    const aIdx = accessors.length;
    accessors.push(accessor);
    attrMap[attr] = aIdx;
  }
  let indicesAcc = undefined;
  if (prim.indices != null) {
    const { bin: b2, bufferView, accessor } = copyAccessorBlob(
      src.json,
      src.bin,
      prim.indices,
      bin
    );
    bin = b2;
    const bvIdx = bufferViews.length;
    bufferViews.push(bufferView);
    accessor.bufferView = bvIdx;
    accessor.byteOffset = src.json.accessors[prim.indices].byteOffset || 0;
    indicesAcc = accessors.length;
    accessors.push(accessor);
  }

  // Prefer source moon material if present; else keep UE moon mat index
  let matIdx = undefined;
  const ueMoon = nodes.find((n) => n.name === name);
  if (ueMoon && meshes[ueMoon.mesh]?.primitives?.[0]?.material != null) {
    matIdx = meshes[ueMoon.mesh].primitives[0].material;
  }

  const newMeshIdx = meshes.length;
  meshes.push({
    name,
    primitives: [
      {
        attributes: attrMap,
        indices: indicesAcc,
        mode: prim.mode ?? 4,
        material: matIdx,
      },
    ],
  });
  moonMeshIndex[name] = newMeshIdx;

  // Point UE moon node at new mesh; restore Rx(+90) from bak if present
  for (const n of nodes) {
    if (n.name !== name) continue;
    n.mesh = newMeshIdx;
    delete n.translation;
    n.scale = [1, 1, 1];
    if (sn.rotation) n.rotation = sn.rotation.slice();
    else delete n.rotation;
  }
}

const outJson = {
  ...ue.json,
  asset: { ...(ue.json.asset || {}), generator: 'merge-moons-into-ue-export' },
  nodes,
  meshes,
  accessors,
  bufferViews,
  materials,
  textures,
  images,
  samplers,
  buffers: [{ byteLength: bin.length }],
};
// Drop extras rock shadows — re-bake after merge
if (outJson.extras) {
  delete outJson.extras.rtsMoonRockShadows;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, writeGlb(outJson, bin));
console.log('merged moons from', MOON_SRC, 'into', OUT);
console.log(
  'moon meshes',
  moonMeshIndex,
  'props',
  nodes.filter((n) => /^Prop_/i.test(n.name || '')).length,
  'bytes',
  fs.statSync(OUT).size
);
