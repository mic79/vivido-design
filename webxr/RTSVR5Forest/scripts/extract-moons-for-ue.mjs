#!/usr/bin/env node
/**
 * Extract Moon_0 / Moon_1 from live skirmish GLB as standard Y-up meter GLBs
 * for UE Interchange/glTF import.
 *
 * IMPORTANT: Do NOT pre-convert to Z-up. UE's glTF importer already applies
 * Y-up → Z-up. Writing Z-up into the file double-rotates the crater into a
 * vertical wall (exactly the broken Lit look).
 *
 *   node RTSVR5/scripts/extract-moons-for-ue.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');
const OUT_DIR = 'D:/ue5/UE58_scifi/Imported/SkirmishMoon';

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

function readAccessor(json, bin, accIdx) {
  const acc = json.accessors[accIdx];
  const bv = json.bufferViews[acc.bufferView];
  const componentType = acc.componentType;
  const bytesPer =
    componentType === 5126 ? 4 : componentType === 5125 ? 4 : componentType === 5123 ? 2 : 1;
  const nComp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const stride = bv.byteStride || bytesPer * nComp;
  const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const out = [];
  for (let i = 0; i < acc.count; i++) {
    const o = base + i * stride;
    const v = [];
    for (let c = 0; c < nComp; c++) {
      if (componentType === 5126) v.push(bin.readFloatLE(o + c * 4));
      else if (componentType === 5125) v.push(bin.readUInt32LE(o + c * 4));
      else if (componentType === 5123) v.push(bin.readUInt16LE(o + c * 2));
      else v.push(bin[o + c]);
    }
    out.push(v);
  }
  return { data: out, componentType, type: acc.type, count: acc.count };
}

function quatMulVec(q, v) {
  const [qx, qy, qz, qw] = q;
  const [x, y, z] = v;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

function writeGlb(positions, indices, name) {
  // positions: Float32 Y-up meters (standard glTF); indices: uint32
  const posBuf = Buffer.alloc(positions.length * 12);
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const [x, y, z] = positions[i];
    posBuf.writeFloatLE(x, i * 12);
    posBuf.writeFloatLE(y, i * 12 + 4);
    posBuf.writeFloatLE(z, i * 12 + 8);
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  }
  // Keep glTF CCW winding; UE's Y→Z convert handles facing.
  const idxBuf = Buffer.alloc(indices.length * 4);
  for (let i = 0; i < indices.length; i++) {
    idxBuf.writeUInt32LE(indices[i], i * 4);
  }
  const bin = Buffer.concat([posBuf, idxBuf]);
  const json = {
    asset: { version: '2.0', generator: 'extract-moons-for-ue' },
    scenes: [{ nodes: [0] }],
    scene: 0,
    nodes: [{ mesh: 0, name }],
    meshes: [
      {
        name,
        primitives: [
          {
            attributes: { POSITION: 0 },
            indices: 1,
            mode: 4,
          },
        ],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length,
        type: 'VEC3',
        max,
        min,
      },
      {
        bufferView: 1,
        componentType: 5125,
        count: indices.length,
        type: 'SCALAR',
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: posBuf.length, byteLength: idxBuf.length, target: 34963 },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBuf = Buffer.from(JSON.stringify(json));
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
  return { out, min, max, verts: positions.length, tris: indices.length / 3 };
}

const buf = fs.readFileSync(GLB);
const { json, bin } = parseGlb(buf);
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const n of json.nodes || []) {
  const name = n.name || '';
  if (!/^Moon_[01]$/.test(name)) continue;
  const mesh = json.meshes[n.mesh];
  const prim = mesh.primitives[0];
  const posAcc = readAccessor(json, bin, prim.attributes.POSITION);
  const idxAcc = readAccessor(json, bin, prim.indices);
  const q = n.rotation || [0, 0, 0, 1];
  const t = n.translation || [0, 0, 0];
  const s = n.scale || [1, 1, 1];
  // Bake node transform → world Y-up meters (matches game).
  const yup = posAcc.data.map(([x, y, z]) => {
    let vx = x * s[0];
    let vy = y * s[1];
    let vz = z * s[2];
    [vx, vy, vz] = quatMulVec(q, [vx, vy, vz]);
    return [vx + t[0], vy + t[1], vz + t[2]];
  });
  const indices = idxAcc.data.map((v) => v[0]);
  const { out, min, max, verts, tris } = writeGlb(yup, indices, name);
  const outPath = path.join(OUT_DIR, `${name}_YUpM.glb`);
  fs.writeFileSync(outPath, out);
  // Keep old filename as copy so existing UE scripts can find either.
  fs.writeFileSync(path.join(OUT_DIR, `${name}_ZUpCm.glb`), out);
  console.log(
    name,
    'verts',
    verts,
    'tris',
    tris,
    'Y-up_m',
    min.map((v) => +v.toFixed(2)),
    '→',
    max.map((v) => +v.toFixed(2)),
    outPath
  );
}
console.log('DONE — Y-up meters for UE glTF import (no pre Z-up convert)');
