#!/usr/bin/env node
/**
 * Binary-strip Story kit LOD2 down to rocks PLUS an extra set of actor groups, to sweep
 * texture count between the rocks kit (20 textures, 64.5 Hz on PCVR) and the full kit
 * (103 textures, 90.1 Hz). Every workload axis is already ruled out as the cause of that
 * split — GPU ms, CPU ms, draw calls, render wall, triangles, framebuffer pixels, MSAA —
 * so texture count is what is left to test.
 *
 * The extra groups are chosen for texture weight, not triangles: `MainStation_Merged`
 * alone is one node and 0.02M tris but pulls 44 textures, so the sweep moves textures
 * while leaving geometry near the rocks baseline.
 *
 *   OUT=scifi-rts-rocks-t64.glb EXTRA="MainStation" node RTSVR5/scripts/make-kit-subset.mjs
 *
 * Keeps quantized/compressed buffers — much smaller than a float GLTFExporter rebake.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets/terrain/scifi-rts-kit-lod2.glb');
const OUT_NAME = process.env.OUT || 'scifi-rts-rocks-subset.glb';
const DST = path.join(ROOT, 'assets/terrain', OUT_NAME);
const ROCKS_RE = /SM_Rock|SM_Dirt|SM_Cliff|SM_Mineral|SM_WaterPlane/i;
const EXTRA_RE = process.env.EXTRA ? new RegExp(process.env.EXTRA, 'i') : null;

function readGlb(filePath) {
  const buf = fs.readFileSync(filePath);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  let off = 12;
  const jsonLen = dv.getUint32(off, true);
  if (dv.getUint32(off + 4, true) !== 0x4e4f534a) throw new Error('missing JSON chunk');
  const json = JSON.parse(Buffer.from(buf.subarray(off + 8, off + 8 + jsonLen)).toString('utf8'));
  off += 8 + jsonLen;
  const binLen = dv.getUint32(off, true);
  if (dv.getUint32(off + 4, true) !== 0x004e4942) throw new Error('missing BIN chunk');
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

function collectMaterialTextureIndices(mat) {
  const ids = new Set();
  const pbr = mat.pbrMetallicRoughness || {};
  for (const s of [pbr.baseColorTexture, pbr.metallicRoughnessTexture, mat.normalTexture, mat.occlusionTexture, mat.emissiveTexture]) {
    if (s && typeof s.index === 'number') ids.add(s.index);
  }
  return ids;
}

function remapTextureInfo(info, texMap) {
  if (!info || typeof info.index !== 'number') return info;
  return { ...info, index: texMap.get(info.index) };
}

function sceneDescendants(json, scene) {
  const nodes = json.nodes || [];
  const out = new Set();
  const stack = [...(scene.nodes || [])];
  while (stack.length) {
    const i = stack.pop();
    if (out.has(i)) continue;
    out.add(i);
    for (const c of nodes[i]?.children || []) stack.push(c);
  }
  return out;
}

function main() {
  const { json, bin } = readGlb(SRC);
  const lod2 = (json.scenes || []).find((s) => /LOD2/i.test(s.name || '')) || json.scenes[0];
  const inLod2 = sceneDescendants(json, lod2);
  const nodes = json.nodes || [];

  const keepNode = (i) => {
    const nm = nodes[i].name || '';
    return ROCKS_RE.test(nm) || (EXTRA_RE ? EXTRA_RE.test(nm) : false);
  };
  const picked = [...inLod2].filter((i) => nodes[i].mesh != null && keepNode(i));
  if (!picked.length) throw new Error('no matching mesh nodes');

  const meshIds = new Set(picked.map((i) => nodes[i].mesh));
  const matIds = new Set();
  const accIds = new Set();
  for (const mi of meshIds) {
    for (const p of json.meshes[mi].primitives) {
      if (p.material != null) matIds.add(p.material);
      if (p.indices != null) accIds.add(p.indices);
      for (const a of Object.values(p.attributes || {})) accIds.add(a);
    }
  }

  const texIds = new Set();
  for (const mid of matIds) for (const t of collectMaterialTextureIndices(json.materials[mid])) texIds.add(t);
  const imgIds = new Set();
  const sampIds = new Set();
  for (const ti of texIds) {
    const t = json.textures[ti];
    if (t.source != null) imgIds.add(t.source);
    if (t.sampler != null) sampIds.add(t.sampler);
  }

  const bvIds = new Set();
  for (const ai of accIds) {
    const a = json.accessors[ai];
    if (a.bufferView != null) bvIds.add(a.bufferView);
  }
  for (const ii of imgIds) {
    const im = json.images[ii];
    if (im.bufferView != null) bvIds.add(im.bufferView);
  }

  const bvList = [...bvIds].sort((a, b) => a - b);
  const chunks = [];
  let cursor = 0;
  const bvIndex = new Map();
  let seq = 0;
  for (const old of bvList) {
    const bv = json.bufferViews[old];
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad, 0));
      cursor += pad;
    }
    const start = bv.byteOffset || 0;
    chunks.push(bin.subarray(start, start + bv.byteLength));
    bvIndex.set(old, { newIndex: seq++, byteOffset: cursor, byteLength: bv.byteLength, byteStride: bv.byteStride, target: bv.target });
    cursor += bv.byteLength;
  }
  const newBin = Buffer.concat(chunks.length ? chunks : [Buffer.alloc(0)]);

  const bufferViews = bvList.map((old) => {
    const meta = bvIndex.get(old);
    const o = { buffer: 0, byteOffset: meta.byteOffset, byteLength: meta.byteLength };
    if (meta.byteStride != null) o.byteStride = meta.byteStride;
    if (meta.target != null) o.target = meta.target;
    return o;
  });

  const accList = [...accIds].sort((a, b) => a - b);
  const accMap = new Map(accList.map((old, i) => [old, i]));
  const accessors = accList.map((old) => {
    const a = structuredClone(json.accessors[old]);
    if (a.bufferView != null) a.bufferView = bvIndex.get(a.bufferView).newIndex;
    return a;
  });

  const sampList = [...sampIds].sort((a, b) => a - b);
  const sampMap = new Map(sampList.map((old, i) => [old, i]));
  const samplers = sampList.map((old) => structuredClone(json.samplers[old]));

  const imgList = [...imgIds].sort((a, b) => a - b);
  const imgMap = new Map(imgList.map((old, i) => [old, i]));
  const images = imgList.map((old) => {
    const im = structuredClone(json.images[old]);
    if (im.bufferView != null) im.bufferView = bvIndex.get(im.bufferView).newIndex;
    return im;
  });

  const texList = [...texIds].sort((a, b) => a - b);
  const texMap = new Map(texList.map((old, i) => [old, i]));
  const textures = texList.map((old) => {
    const t = structuredClone(json.textures[old]);
    if (t.source != null) t.source = imgMap.get(t.source);
    if (t.sampler != null) t.sampler = sampMap.get(t.sampler);
    return t;
  });

  const matList = [...matIds].sort((a, b) => a - b);
  const matMap = new Map(matList.map((old, i) => [old, i]));
  const materials = matList.map((old) => {
    const mat = structuredClone(json.materials[old]);
    if (mat.pbrMetallicRoughness) {
      mat.pbrMetallicRoughness.baseColorTexture = remapTextureInfo(mat.pbrMetallicRoughness.baseColorTexture, texMap);
      mat.pbrMetallicRoughness.metallicRoughnessTexture = remapTextureInfo(mat.pbrMetallicRoughness.metallicRoughnessTexture, texMap);
    }
    mat.normalTexture = remapTextureInfo(mat.normalTexture, texMap);
    mat.occlusionTexture = remapTextureInfo(mat.occlusionTexture, texMap);
    mat.emissiveTexture = remapTextureInfo(mat.emissiveTexture, texMap);
    return mat;
  });

  const meshList = [...meshIds].sort((a, b) => a - b);
  const meshMap = new Map(meshList.map((old, i) => [old, i]));
  const meshes = meshList.map((old) => {
    const m = structuredClone(json.meshes[old]);
    for (const p of m.primitives) {
      if (p.material != null) p.material = matMap.get(p.material);
      if (p.indices != null) p.indices = accMap.get(p.indices);
      const attrs = {};
      for (const [k, v] of Object.entries(p.attributes || {})) attrs[k] = accMap.get(v);
      p.attributes = attrs;
    }
    return m;
  });

  const outNodes = [{ name: 'StoryRocksTerrain', children: [] }];
  let tris = 0;
  for (const old of picked) {
    const n = nodes[old];
    const nn = { name: n.name, mesh: meshMap.get(n.mesh) };
    if (n.translation) nn.translation = n.translation;
    if (n.rotation) nn.rotation = n.rotation;
    if (n.scale) nn.scale = n.scale;
    if (n.matrix) nn.matrix = n.matrix;
    outNodes[0].children.push(outNodes.length);
    outNodes.push(nn);
    for (const p of json.meshes[n.mesh].primitives) {
      const a = p.indices != null ? json.accessors[p.indices] : json.accessors[p.attributes.POSITION];
      tris += a.count / 3;
    }
  }

  const extUsed = new Set([...(json.extensionsUsed || []), ...(json.extensionsRequired || [])]);
  for (const mat of materials) if (mat.extensions) for (const e of Object.keys(mat.extensions)) extUsed.add(e);
  const keepExt = [...extUsed].filter((e) => /KHR_mesh_quantization|KHR_materials_unlit|KHR_texture_transform/i.test(e));

  const out = {
    asset: { ...(json.asset || {}), generator: 'make-kit-subset' },
    scenes: [{ name: 'LOD2', nodes: [0] }],
    scene: 0,
    nodes: outNodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: newBin.length }],
    images,
    textures,
  };
  if (samplers.length) out.samplers = samplers;
  if (keepExt.length) {
    out.extensionsUsed = keepExt;
    const req = (json.extensionsRequired || []).filter((e) => keepExt.includes(e));
    if (req.length) out.extensionsRequired = req;
  }

  writeGlb(DST, out, newBin);
  const mb = (fs.statSync(DST).size / (1024 * 1024)).toFixed(2);
  console.log(
    `${OUT_NAME.padEnd(30)} ${mb.padStart(6)} MB  nodes=${String(picked.length).padStart(5)}  ` +
      `textures=${String(textures.length).padStart(3)}  materials=${String(materials.length).padStart(3)}  tris=${(tris / 1e6).toFixed(2)}M`
  );
}

main();
