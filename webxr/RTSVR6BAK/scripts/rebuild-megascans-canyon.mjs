#!/usr/bin/env node
/**
 * Rebuild UE Megascans export with REAL canyon albedo (not WorldGrid) + landform scale.
 * Then merge onto live heightfield Moon_0.
 *
 *   WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1 node RTSVR6/scripts/rebuild-megascans-canyon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UE_GLB = 'D:/ue5/UE58_scifi/Exported/skirmish-megascans-canyon.glb';
const TEX = path.join(ROOT, 'assets/mesa/megascans');
const LIVE = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');
// Prefer current live Moon_0 (may be flat desert plate); do not roll back to
// pre-megascans.bak which still has the solid-red heightfield caps.
const BASE = LIVE;
const WRITE_LIVE =
  process.env.WRITE_LIVE === '1' && process.env.CONFIRM_WRITE_LIVE === '1';
const SCALE = 3.2;

const MESH_TEX = {
  // UE export mesh index → texture stem
  2: 'mesa',
  3: 'terrain',
  4: 'eroded',
  5: 'cliff1',
  6: 'cliff2',
  7: 'cliff3',
};

function parseGlb(buf) {
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(
    buf
      .slice(20, 20 + jlen)
      .toString('utf8')
      .replace(/:\s*-?inf\b/gi, ':null')
      .replace(/:\s*nan\b/gi, ':null')
  );
  const binOff = 20 + jlen;
  const binLen = buf.readUInt32LE(binOff);
  const bin = Buffer.from(buf.subarray(binOff + 8, binOff + 8 + binLen));
  return { json, bin };
}
function writeGlb(json, bin) {
  json.buffers = [{ byteLength: bin.length }];
  const jb = Buffer.from(JSON.stringify(json));
  const jp = (4 - (jb.length % 4)) % 4;
  const bp = (4 - (bin.length % 4)) % 4;
  const jc = jb.length + jp;
  const bc = bin.length + bp;
  const out = Buffer.alloc(12 + 8 + jc + 8 + bc);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jc, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jb.copy(out, 20);
  out.fill(0x20, 20 + jb.length, 20 + jc);
  const o = 20 + jc;
  out.writeUInt32LE(bc, o);
  out.writeUInt32LE(0x004e4942, o + 4);
  bin.copy(out, o + 8);
  return out;
}

function appendBytes(binParts, bytes) {
  const pad = (4 - (bytes.length % 4)) % 4;
  const off = binParts.reduce((a, b) => a + b.length, 0);
  binParts.push(bytes);
  if (pad) binParts.push(Buffer.alloc(pad));
  return { byteOffset: off, byteLength: bytes.length };
}

const ue = parseGlb(fs.readFileSync(UE_GLB));

// Keep only Prop_Megascans nodes; drop Moon (use live heightfield instead)
const propNodes = ue.json.nodes.filter(
  (n) => /^Prop_Megascans_/i.test(n.name || '') && n.mesh != null
);
const usedMesh = [...new Set(propNodes.map((n) => n.mesh))];
console.log('props', propNodes.length, 'meshes', usedMesh);

const binParts = [];
const bufferViews = [];
const accessors = [];
const images = [];
const samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
const textures = [];
const materials = [];
const meshes = [];
const meshRemap = new Map();

// Build one material per mesh type from real canyon JPEGs
const matByStem = new Map();
function ensureMat(stem) {
  if (matByStem.has(stem)) return matByStem.get(stem);
  const bc = fs.readFileSync(path.join(TEX, `${stem}_bc.jpg`));
  const nrm = fs.readFileSync(path.join(TEX, `${stem}_n.jpg`));
  const bcBv = appendBytes(binParts, bc);
  const nBv = appendBytes(binParts, nrm);
  const bcBvI = bufferViews.length;
  bufferViews.push({ buffer: 0, ...bcBv });
  const nBvI = bufferViews.length;
  bufferViews.push({ buffer: 0, ...nBv });
  const bcImg = images.length;
  images.push({ mimeType: 'image/jpeg', bufferView: bcBvI });
  const nImg = images.length;
  images.push({ mimeType: 'image/jpeg', bufferView: nBvI });
  const bcTex = textures.length;
  textures.push({ sampler: 0, source: bcImg });
  const nTex = textures.length;
  textures.push({ sampler: 0, source: nImg });
  const mi = materials.length;
  materials.push({
    name: `M_Canyon_${stem}`,
    pbrMetallicRoughness: {
      baseColorTexture: { index: bcTex },
      metallicFactor: 0.02,
      roughnessFactor: 0.9,
    },
    normalTexture: { index: nTex },
  });
  matByStem.set(stem, mi);
  return mi;
}

// Copy mesh geometry bufferViews/accessors from UE GLB
function copyAccessor(accId) {
  const a = ue.json.accessors[accId];
  const bv = ue.json.bufferViews[a.bufferView];
  const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
  // Copy whole bufferView for simplicity (stride-safe)
  const raw = ue.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
  const newBv = appendBytes(binParts, Buffer.from(raw));
  const bvi = bufferViews.length;
  bufferViews.push({
    buffer: 0,
    byteOffset: newBv.byteOffset,
    byteLength: newBv.byteLength,
    byteStride: bv.byteStride,
    target: bv.target,
  });
  const ai = accessors.length;
  const na = JSON.parse(JSON.stringify(a));
  na.bufferView = bvi;
  delete na.byteOffset;
  accessors.push(na);
  return ai;
}

for (const mi of usedMesh) {
  const stem = MESH_TEX[mi];
  if (!stem) {
    console.warn('no tex map for mesh', mi);
    continue;
  }
  const matI = ensureMat(stem);
  const src = ue.json.meshes[mi];
  const prims = [];
  for (const p of src.primitives || []) {
    const attrs = {};
    for (const [k, v] of Object.entries(p.attributes || {})) attrs[k] = copyAccessor(v);
    const prim = { attributes: attrs, material: matI, mode: p.mode ?? 4 };
    if (p.indices != null) prim.indices = copyAccessor(p.indices);
    prims.push(prim);
  }
  meshRemap.set(mi, meshes.length);
  meshes.push({ name: src.name || `CanyonMesh_${mi}`, primitives: prims });
}

const nodes = [];
const sceneNodes = [];
for (const n of propNodes) {
  if (!meshRemap.has(n.mesh)) continue;
  const nn = {
    name: n.name,
    mesh: meshRemap.get(n.mesh),
    translation: n.translation || [0, 0, 0],
    rotation: n.rotation || [0, 0, 0, 1],
    scale: (n.scale || [1, 1, 1]).map((v) => v * SCALE),
  };
  sceneNodes.push(nodes.length);
  nodes.push(nn);
}

const propsJson = {
  asset: { version: '2.0', generator: 'rebuild-megascans-canyon' },
  scenes: [{ nodes: sceneNodes }],
  scene: 0,
  nodes,
  meshes,
  materials,
  textures,
  samplers,
  images,
  accessors,
  bufferViews,
  buffers: [{ byteLength: 0 }],
};
const propsBin = Buffer.concat(binParts);
const propsGlb = writeGlb(propsJson, propsBin);
const propsPath = path.join(ROOT, 'assets/mesa/megascans-canyon-props.glb');
fs.writeFileSync(propsPath, propsGlb);
console.log('wrote', propsPath, propsGlb.length);

// ---- Merge onto live heightfield base ----
const live = parseGlb(fs.readFileSync(BASE));
{
  const drop = new Set();
  for (let i = 0; i < live.json.nodes.length; i++) {
    const n = live.json.nodes[i]?.name || '';
    if (/^Prop_/i.test(n)) drop.add(i);
    if (/^Moon_/i.test(n) && !/^Moon_0$/i.test(n)) drop.add(i);
  }
  if (drop.size) {
    const keep = [];
    const map = new Map();
    let ni = 0;
    for (let i = 0; i < live.json.nodes.length; i++) {
      if (drop.has(i)) continue;
      map.set(i, ni++);
      keep.push(live.json.nodes[i]);
    }
    live.json.nodes = keep;
    const sc = live.json.scenes[live.json.scene ?? 0];
    sc.nodes = (sc.nodes || []).map((i) => map.get(i)).filter((i) => i != null);
    for (const n of live.json.nodes) {
      if (n.children)
        n.children = n.children.map((c) => map.get(c)).filter((c) => c != null);
    }
    console.log('stripped', drop.size);
  }
}

const props = parseGlb(propsGlb);
function append(key, arr) {
  live.json[key] = live.json[key] || [];
  const base = live.json[key].length;
  for (const item of arr || []) live.json[key].push(JSON.parse(JSON.stringify(item)));
  return base;
}
const bv0 = append('bufferViews', props.json.bufferViews);
const acc0 = append('accessors', props.json.accessors);
const img0 = append('images', props.json.images);
const samp0 = append('samplers', props.json.samplers);
const tex0 = append('textures', props.json.textures);
const mat0 = append('materials', props.json.materials);
const mesh0 = append('meshes', props.json.meshes);
const pad = (4 - (live.bin.length % 4)) % 4;
const start = live.bin.length + pad;
const newBin = Buffer.concat([live.bin, Buffer.alloc(pad), props.bin]);
for (let i = bv0; i < live.json.bufferViews.length; i++) {
  const bv = live.json.bufferViews[i];
  bv.buffer = 0;
  bv.byteOffset = (bv.byteOffset || 0) + start;
}
for (let i = acc0; i < live.json.accessors.length; i++) {
  const a = live.json.accessors[i];
  if (a.bufferView != null) a.bufferView += bv0;
}
for (let i = img0; i < live.json.images.length; i++) {
  const im = live.json.images[i];
  if (im.bufferView != null) im.bufferView += bv0;
}
for (let i = tex0; i < live.json.textures.length; i++) {
  const t = live.json.textures[i];
  if (t.source != null) t.source += img0;
  if (t.sampler != null) t.sampler += samp0;
}
for (let i = mat0; i < live.json.materials.length; i++) {
  const m = live.json.materials[i];
  const pbr = m.pbrMetallicRoughness;
  if (pbr?.baseColorTexture?.index != null) pbr.baseColorTexture.index += tex0;
  if (m.normalTexture?.index != null) m.normalTexture.index += tex0;
}
for (let i = mesh0; i < live.json.meshes.length; i++) {
  for (const prim of live.json.meshes[i].primitives || []) {
    if (prim.indices != null) prim.indices += acc0;
    if (prim.material != null) prim.material += mat0;
    if (prim.attributes) for (const k of Object.keys(prim.attributes)) prim.attributes[k] += acc0;
  }
}
const sc = live.json.scenes[live.json.scene ?? 0];
sc.nodes = sc.nodes || [];
for (const n of props.json.nodes) {
  const nn = JSON.parse(JSON.stringify(n));
  nn.mesh += mesh0;
  live.json.nodes.push(nn);
  sc.nodes.push(live.json.nodes.length - 1);
}
live.json.extras = live.json.extras || {};
live.json.extras.rtsMegascansCanyon = {
  method: 'ElectricDreams MassiveCanyonSandstoneMesa + real BC',
  scale: SCALE,
};

const outPath = WRITE_LIVE ? LIVE : path.join(ROOT, 'assets/mesa/terrain-skirmish-megascans.glb');
const outBuf = writeGlb(live.json, newBin);
fs.writeFileSync(outPath, outBuf);
console.log('wrote', outPath, outBuf.length);
if (!WRITE_LIVE) console.log('Dry-run — WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1 to ship');
