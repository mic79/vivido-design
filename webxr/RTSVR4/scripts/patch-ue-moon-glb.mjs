#!/usr/bin/env node
/**
 * Rewrite the UE GLTFExporter moon GLB so it actually contains tiled moon_01
 * on mesh UV0 (WorldPosition materials cannot export as a repeating texture —
 * the exporter baked a 1024 unique-UV snapshot onto TEXCOORD_1).
 *
 * Keeps HQ EPIC lightmaps + TEXCOORD_1. Does not invent lighting.
 *
 *   node scripts/patch-ue-moon-glb.mjs
 *   node scripts/decode-hq-to-rgb.mjs   (unpack HQ → UV1 RGB lightmaps)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB_IN = path.join(ROOT, 'export', 'terrain-skirmish-ue-lm.glb');
const GLB_OUT = path.join(ROOT, 'assets', 'terrain', 'terrain-skirmish-ue-lm.glb');
const DIFF = path.join(ROOT, 'export', 'moon_01_diff_2k.jpg');
const NOR = path.join(ROOT, 'export', 'moon_01_nor_gl_2k.jpg');
const AO = path.join(ROOT, 'export', 'moon_01_ao_2k.jpg');
const MOON_UV_REPEAT = 3.35;
const MAP_M = 200;
const UV_SCALE = MOON_UV_REPEAT / MAP_M;
const REPEAT = 10497;
const LINEAR = 9729;
const MIP = 9987;

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
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

function viewSlice(bin, json, viewIndex) {
  const v = json.bufferViews[viewIndex];
  const start = v.byteOffset || 0;
  return bin.subarray(start, start + v.byteLength);
}

function appendBytes(bin, bytes) {
  const start = bin.length;
  const pad = pad4(bytes.length);
  const next = Buffer.concat([bin, bytes, Buffer.alloc(pad)]);
  return { bin: next, byteOffset: start, byteLength: bytes.length };
}

const buf = fs.readFileSync(GLB_IN);
const { json, bin: bin0 } = parseGlb(buf);
let bin = Buffer.from(bin0);

for (const mesh of json.meshes || []) {
  for (const prim of mesh.primitives || []) {
    const posAcc = json.accessors[prim.attributes.POSITION];
    const uvAcc = json.accessors[prim.attributes.TEXCOORD_0];
    const pos = viewSlice(bin, json, posAcc.bufferView);
    const uvView = json.bufferViews[uvAcc.bufferView];
    const uv = bin.subarray(uvView.byteOffset || 0, (uvView.byteOffset || 0) + uvView.byteLength);
    const pf = new Float32Array(pos.buffer, pos.byteOffset + (posAcc.byteOffset || 0), posAcc.count * 3);
    const uf = new Float32Array(uv.buffer, uv.byteOffset + (uvAcc.byteOffset || 0), uvAcc.count * 2);
    if (uf.length !== posAcc.count * 2) throw new Error(`${mesh.name} uv/pos count mismatch`);
    for (let i = 0; i < posAcc.count; i++) {
      uf[i * 2] = pf[i * 3] * UV_SCALE;
      uf[i * 2 + 1] = pf[i * 3 + 1] * UV_SCALE;
    }
    delete uvAcc.min;
    delete uvAcc.max;
  }
}

const diffJpg = fs.readFileSync(DIFF);
const norJpg = fs.readFileSync(NOR);
const aoJpg = fs.readFileSync(AO);
const d = appendBytes(bin, diffJpg);
bin = d.bin;
const n = appendBytes(bin, norJpg);
bin = n.bin;
const a = appendBytes(bin, aoJpg);
bin = a.bin;

json.bufferViews.push(
  { buffer: 0, byteOffset: d.byteOffset, byteLength: d.byteLength },
  { buffer: 0, byteOffset: n.byteOffset, byteLength: n.byteLength },
  { buffer: 0, byteOffset: a.byteOffset, byteLength: a.byteLength }
);
const bvDiff = json.bufferViews.length - 3;
const bvNor = json.bufferViews.length - 2;
const bvAo = json.bufferViews.length - 1;

json.images.push(
  { name: 'moon_01_diff_2k', mimeType: 'image/jpeg', bufferView: bvDiff },
  { name: 'moon_01_nor_gl_2k', mimeType: 'image/jpeg', bufferView: bvNor },
  { name: 'moon_01_ao_2k', mimeType: 'image/jpeg', bufferView: bvAo }
);
const imgDiff = json.images.length - 3;
const imgNor = json.images.length - 2;
const imgAo = json.images.length - 1;

json.samplers.push(
  { name: 'moon_01_wrap', magFilter: LINEAR, minFilter: MIP, wrapS: REPEAT, wrapT: REPEAT },
  { name: 'moon_01_wrap_linear', magFilter: LINEAR, minFilter: MIP, wrapS: REPEAT, wrapT: REPEAT }
);
const sampSrgb = json.samplers.length - 2;
const sampLin = json.samplers.length - 1;

json.textures.push(
  { name: 'moon_01_diff_2k', sampler: sampSrgb, source: imgDiff },
  { name: 'moon_01_nor_gl_2k', sampler: sampLin, source: imgNor },
  { name: 'moon_01_ao_2k', sampler: sampLin, source: imgAo }
);
const texDiff = json.textures.length - 3;
const texNor = json.textures.length - 2;
const texAo = json.textures.length - 1;

for (const mat of json.materials || []) {
  mat.pbrMetallicRoughness = mat.pbrMetallicRoughness || {};
  mat.pbrMetallicRoughness.baseColorTexture = { index: texDiff, texCoord: 0 };
  mat.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
  mat.pbrMetallicRoughness.metallicFactor = 0;
  mat.normalTexture = { index: texNor, texCoord: 0 };
  mat.occlusionTexture = { index: texAo, texCoord: 0 };
  delete mat.emissiveTexture;
  mat.emissiveFactor = [0, 0, 0];
}

const out = writeGlb(json, bin);
fs.mkdirSync(path.dirname(GLB_OUT), { recursive: true });
fs.writeFileSync(GLB_OUT, out);
console.log(
  JSON.stringify(
    {
      out: GLB_OUT,
      bytes: out.length,
      uvScale: UV_SCALE,
      materials: (json.materials || []).map((m) => ({
        name: m.name,
        albedoTc: m.pbrMetallicRoughness?.baseColorTexture?.texCoord,
        albedoTex: json.textures[m.pbrMetallicRoughness?.baseColorTexture?.index]?.name,
      })),
    },
    null,
    2
  )
);
