#!/usr/bin/env node
/**
 * Build a half-triangle twin of scifi-rts-rocks.glb by decimating the 20 master meshes with
 * meshoptimizer. Node count, instance placements, materials and all 20 textures stay put, so
 * triangle count is the only axis that moves.
 *
 *   node RTSVR5/scripts/make-rocks-halftris.mjs
 *   RATIO=0.25 OUT=scifi-rts-rocks-q25.glb node RTSVR5/scripts/make-rocks-halftris.mjs
 *
 * Only the index buffers are rewritten (appended to the end of the BIN); vertex attributes are
 * left alone, since an indexed draw never shades the vertices that survive nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptSimplifier } from 'meshoptimizer';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.SRC ? path.join(ROOT, 'assets/terrain', process.env.SRC) : path.join(ROOT, 'assets/terrain/scifi-rts-rocks.glb');
const RATIO = Number(process.env.RATIO || 0.5);
const OUT_NAME = process.env.OUT || 'scifi-rts-rocks-h50.glb';
const DST = path.join(ROOT, 'assets/terrain', OUT_NAME);

const COMPONENT = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array };

function readGlb(filePath) {
  const buf = fs.readFileSync(filePath);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  let off = 12;
  const jsonLen = dv.getUint32(off, true);
  const json = JSON.parse(Buffer.from(buf.subarray(off + 8, off + 8 + jsonLen)).toString('utf8'));
  off += 8 + jsonLen;
  const binLen = dv.getUint32(off, true);
  return { json, bin: Buffer.from(buf.subarray(off + 8, off + 8 + binLen)) };
}

function writeGlb(filePath, json, bin) {
  const jsonRaw = Buffer.from(JSON.stringify(json));
  const jsonAligned = Buffer.alloc(Math.ceil(jsonRaw.length / 4) * 4, 0x20);
  jsonRaw.copy(jsonAligned);
  const binAligned = Buffer.alloc(Math.ceil(bin.length / 4) * 4, 0);
  bin.copy(binAligned);
  const total = 12 + 8 + jsonAligned.length + 8 + binAligned.length;
  const out = Buffer.alloc(total);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  let o = 12;
  dv.setUint32(o, jsonAligned.length, true);
  dv.setUint32(o + 4, 0x4e4f534a, true);
  jsonAligned.copy(out, o + 8);
  o += 8 + jsonAligned.length;
  dv.setUint32(o, binAligned.length, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  binAligned.copy(out, o + 8);
  fs.writeFileSync(filePath, out);
}

function accessorBytes(json, bin, accIndex) {
  const a = json.accessors[accIndex];
  const bv = json.bufferViews[a.bufferView];
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  return { a, bv, start };
}

function readIndices(json, bin, accIndex) {
  const { a, start } = accessorBytes(json, bin, accIndex);
  const Ctor = COMPONENT[a.componentType];
  const src = new Ctor(bin.buffer, bin.byteOffset + start, a.count);
  return Uint32Array.from(src);
}

function readPositions(json, bin, accIndex) {
  const { a, bv, start } = accessorBytes(json, bin, accIndex);
  if (a.componentType !== 5126) throw new Error('POSITION is not float32');
  const stride = bv.byteStride || 12;
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) {
    const o = start + i * stride;
    out[i * 3] = bin.readFloatLE(o);
    out[i * 3 + 1] = bin.readFloatLE(o + 4);
    out[i * 3 + 2] = bin.readFloatLE(o + 8);
  }
  return out;
}

async function main() {
  await MeshoptSimplifier.ready;
  const { json, bin } = readGlb(SRC);

  const extra = [];
  let extraLen = 0;
  const appended = new Map(); // shared index accessors are only decimated once
  let before = 0;
  let after = 0;

  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives) {
      if (prim.indices == null || (prim.mode ?? 4) !== 4) continue;
      if (appended.has(prim.indices)) {
        prim.indices = appended.get(prim.indices);
        continue;
      }
      const oldIdx = prim.indices;
      const indices = readIndices(json, bin, oldIdx);
      const positions = readPositions(json, bin, prim.attributes.POSITION);
      before += indices.length / 3;

      const target = Math.max(3, Math.floor((indices.length * RATIO) / 3) * 3);
      // Generous error budget: these masters are ~300 tris each, so a tight bound would
      // refuse to reach the target and the ablation would not actually move.
      const [simplified] = MeshoptSimplifier.simplify(indices, positions, 3, target, 1.0);
      after += simplified.length / 3;

      const srcAcc = json.accessors[oldIdx];
      let max = 0;
      for (const v of simplified) if (v > max) max = v;
      const componentType = max < 256 ? 5121 : max < 65536 ? 5123 : 5125;
      const Ctor = COMPONENT[componentType];
      const packed = new Ctor(simplified.length);
      packed.set(simplified);
      const bytes = Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength);
      const pad = (4 - (extraLen % 4)) % 4;
      if (pad) {
        extra.push(Buffer.alloc(pad, 0));
        extraLen += pad;
      }
      const bvIndex = json.bufferViews.length;
      json.bufferViews.push({ buffer: 0, byteOffset: -1, byteLength: bytes.length, target: 34963, __extraOffset: extraLen });
      extra.push(bytes);
      extraLen += bytes.length;

      const accIndex = json.accessors.length;
      json.accessors.push({
        bufferView: bvIndex,
        componentType,
        count: simplified.length,
        type: 'SCALAR',
        max: [max],
        min: [0],
      });
      appended.set(oldIdx, accIndex);
      prim.indices = accIndex;
      void srcAcc;
    }
  }

  // Splice the appended index data onto the end of the original BIN.
  const basePad = (4 - (bin.length % 4)) % 4;
  const newBin = Buffer.concat([bin, Buffer.alloc(basePad, 0), ...extra]);
  const baseOffset = bin.length + basePad;
  for (const bv of json.bufferViews) {
    if (bv.byteOffset === -1) {
      bv.byteOffset = baseOffset + bv.__extraOffset;
      delete bv.__extraOffset;
    }
  }
  json.buffers = [{ byteLength: newBin.length }];
  json.asset = { ...(json.asset || {}), generator: 'make-rocks-halftris' };

  for (const bv of json.bufferViews) {
    if (bv.byteOffset + bv.byteLength > newBin.length) throw new Error('bufferView runs past the buffer');
  }

  writeGlb(DST, json, newBin);
  console.log(
    `${OUT_NAME}\n` +
      `  triangles ${before} -> ${after}  (${((after / before) * 100).toFixed(1)}% of source, target ${RATIO * 100}%)\n` +
      `  nodes ${json.nodes.length} (unchanged)  meshes ${json.meshes.length} (unchanged)  ` +
      `materials ${json.materials.length}  textures ${json.textures.length}\n` +
      `  size ${(fs.statSync(SRC).size / 1048576).toFixed(2)} MB -> ${(fs.statSync(DST).size / 1048576).toFixed(2)} MB`
  );
}

main();
