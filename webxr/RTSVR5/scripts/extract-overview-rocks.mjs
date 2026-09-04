#!/usr/bin/env node
/**
 * Build a tiny Overview rocks-only GLB so skirmish never decodes the 89MB catalog.
 *
 *   node RTSVR5/scripts/extract-overview-rocks.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets/terrain/scifi-overview-lods.glb');
const DST = path.join(ROOT, 'assets/terrain/scifi-overview-rocks.glb');
const KEEP_RE = /SM_Rock/i;

function readGlb(filePath) {
  const buf = fs.readFileSync(filePath);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  let off = 12;
  const jsonLen = dv.getUint32(off, true);
  const jsonType = dv.getUint32(off + 4, true);
  if (jsonType !== 0x4e4f534a) throw new Error('missing JSON chunk');
  const json = JSON.parse(Buffer.from(buf.subarray(off + 8, off + 8 + jsonLen)).toString('utf8'));
  off += 8 + jsonLen;
  if (off >= buf.byteLength) return { json, bin: Buffer.alloc(0) };
  const binLen = dv.getUint32(off, true);
  const binType = dv.getUint32(off + 4, true);
  if (binType !== 0x004e4942) throw new Error('missing BIN chunk');
  const bin = Buffer.from(buf.subarray(off + 8, off + 8 + binLen));
  return { json, bin };
}

function writeGlb(filePath, json, bin) {
  const jsonPad = Buffer.from(JSON.stringify(json));
  const jsonAligned = Buffer.alloc(Math.ceil(jsonPad.length / 4) * 4, 0x20);
  jsonPad.copy(jsonAligned);
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
  const slots = [
    mat.pbrMetallicRoughness?.baseColorTexture,
    mat.pbrMetallicRoughness?.metallicRoughnessTexture,
    mat.normalTexture,
    mat.occlusionTexture,
    mat.emissiveTexture,
  ];
  for (const s of slots) if (s && typeof s.index === 'number') ids.add(s.index);
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
  if (!lod2) throw new Error('no LOD2 scene');
  const inLod2 = sceneDescendants(json, lod2);
  const nodes = json.nodes || [];

  const rockOnly = [...inLod2].filter((i) => KEEP_RE.test(nodes[i].name || '') && nodes[i].mesh != null);
  if (!rockOnly.length) throw new Error('no rock mesh nodes in LOD2');

  const meshIds = new Set(rockOnly.map((i) => nodes[i].mesh));
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
  for (const mid of matIds) {
    for (const t of collectMaterialTextureIndices(json.materials[mid])) texIds.add(t);
  }
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
  for (const old of bvList) {
    const bv = json.bufferViews[old];
    const align = 4;
    const pad = (align - (cursor % align)) % align;
    if (pad) {
      chunks.push(Buffer.alloc(pad, 0));
      cursor += pad;
    }
    const start = bv.byteOffset || 0;
    const len = bv.byteLength;
    chunks.push(bin.subarray(start, start + len));
    bvIndex.set(old, { newIndex: bvIndex.size, byteOffset: cursor, byteLength: len, byteStride: bv.byteStride, target: bv.target });
    cursor += len;
  }
  // Rebuild bvIndex map as index-only after size known — fix: use sequential index
  {
    let i = 0;
    for (const old of bvList) {
      const meta = bvIndex.get(old);
      meta.newIndex = i++;
    }
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
      mat.pbrMetallicRoughness.baseColorTexture = remapTextureInfo(
        mat.pbrMetallicRoughness.baseColorTexture,
        texMap
      );
      mat.pbrMetallicRoughness.metallicRoughnessTexture = remapTextureInfo(
        mat.pbrMetallicRoughness.metallicRoughnessTexture,
        texMap
      );
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

  const outNodes = [{ name: 'OverviewRocks', children: [] }];
  for (const old of rockOnly) {
    const n = nodes[old];
    const nn = { name: n.name, mesh: meshMap.get(n.mesh) };
    if (n.translation) nn.translation = n.translation;
    if (n.rotation) nn.rotation = n.rotation;
    if (n.scale) nn.scale = n.scale;
    if (n.matrix) nn.matrix = n.matrix;
    outNodes[0].children.push(outNodes.length);
    outNodes.push(nn);
  }

  const out = {
    asset: { ...(json.asset || {}), generator: 'extract-overview-rocks' },
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
  if (json.extensionsUsed?.includes('KHR_mesh_quantization')) {
    out.extensionsUsed = ['KHR_mesh_quantization'];
    out.extensionsRequired = ['KHR_mesh_quantization'];
  }

  writeGlb(DST, out, newBin);
  const mb = (fs.statSync(DST).size / (1024 * 1024)).toFixed(2);
  console.log(`wrote ${path.relative(ROOT, DST)} (${mb} MB) rocks=${rockOnly.length} mats=${materials.length} images=${images.length}`);
}

main();
