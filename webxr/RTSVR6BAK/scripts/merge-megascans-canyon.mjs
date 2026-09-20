#!/usr/bin/env node
/**
 * Merge UE-exported Megascans canyon props into live skirmish GLB.
 * Keeps existing Moon_0 (mesa heightfield plate); replaces Prop_* with Prop_Megascans_*.
 *
 *   WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1 node RTSVR6/scripts/merge-megascans-canyon.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIVE = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');
const SRC =
  process.env.UE_GLB ||
  'D:/ue5/UE58_scifi/Exported/skirmish-megascans-canyon.glb';
const WRITE_LIVE =
  process.env.WRITE_LIVE === '1' && process.env.CONFIRM_WRITE_LIVE === '1';

function parseGlb(buf) {
  const jlen = buf.readUInt32LE(12);
  let t = buf
    .slice(20, 20 + jlen)
    .toString('utf8')
    .replace(/:\s*-?inf\b/gi, ':null')
    .replace(/:\s*nan\b/gi, ':null');
  const json = JSON.parse(t);
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

if (!fs.existsSync(SRC)) {
  console.error('missing', SRC);
  process.exit(1);
}
if (!fs.existsSync(LIVE)) {
  console.error('missing live', LIVE);
  process.exit(1);
}

const live = parseGlb(fs.readFileSync(LIVE));
const ue = parseGlb(fs.readFileSync(SRC));

// Drop existing Prop_* from live (kit leftovers)
{
  const drop = new Set();
  for (let i = 0; i < live.json.nodes.length; i++) {
    const n = live.json.nodes[i]?.name || '';
    if (/^Prop_/i.test(n)) drop.add(i);
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
    console.log('stripped Prop_*', drop.size);
  }
}

function append(key, arr) {
  live.json[key] = live.json[key] || [];
  const base = live.json[key].length;
  for (const item of arr || []) live.json[key].push(JSON.parse(JSON.stringify(item)));
  return base;
}

// Only append Prop_Megascans_* nodes (+ their mesh deps) from UE export
const uePropIdx = [];
for (let i = 0; i < ue.json.nodes.length; i++) {
  const n = ue.json.nodes[i]?.name || '';
  if (/^Prop_Megascans_/i.test(n) && ue.json.nodes[i].mesh != null) uePropIdx.push(i);
}
console.log('UE megascans props', uePropIdx.length);

const usedMeshes = new Set(uePropIdx.map((i) => ue.json.nodes[i].mesh));
const meshRemap = new Map();
const bv0 = append('bufferViews', ue.json.bufferViews);
const acc0 = append('accessors', ue.json.accessors);
const img0 = append('images', ue.json.images);
const samp0 = append('samplers', ue.json.samplers);
const tex0 = append('textures', ue.json.textures);
const mat0 = append('materials', ue.json.materials);

const liveBinLen = live.bin.length;
const pad = (4 - (liveBinLen % 4)) % 4;
const ueStart = liveBinLen + pad;
const newBin = Buffer.concat([live.bin, Buffer.alloc(pad), ue.bin]);

for (let i = bv0; i < live.json.bufferViews.length; i++) {
  const bv = live.json.bufferViews[i];
  bv.buffer = 0;
  bv.byteOffset = (bv.byteOffset || 0) + ueStart;
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
  if (pbr?.metallicRoughnessTexture?.index != null) pbr.metallicRoughnessTexture.index += tex0;
  if (m.normalTexture?.index != null) m.normalTexture.index += tex0;
  if (m.occlusionTexture?.index != null) m.occlusionTexture.index += tex0;
  if (m.emissiveTexture?.index != null) m.emissiveTexture.index += tex0;
}

const mesh0 = live.json.meshes.length;
for (const mi of usedMeshes) {
  meshRemap.set(mi, live.json.meshes.length);
  const mesh = JSON.parse(JSON.stringify(ue.json.meshes[mi]));
  for (const prim of mesh.primitives || []) {
    if (prim.indices != null) prim.indices += acc0;
    if (prim.material != null) prim.material += mat0;
    if (prim.attributes) {
      for (const k of Object.keys(prim.attributes)) prim.attributes[k] += acc0;
    }
  }
  live.json.meshes.push(mesh);
}
console.log('appended meshes', usedMeshes.size, 'from', mesh0);

const sc = live.json.scenes[live.json.scene ?? 0];
sc.nodes = sc.nodes || [];
for (const ni of uePropIdx) {
  const n = JSON.parse(JSON.stringify(ue.json.nodes[ni]));
  n.mesh = meshRemap.get(n.mesh);
  // Drop children — leaf SM only
  delete n.children;
  live.json.nodes.push(n);
  sc.nodes.push(live.json.nodes.length - 1);
}

live.json.extras = live.json.extras || {};
live.json.extras.rtsMegascansCanyon = {
  source: SRC,
  props: uePropIdx.length,
  method: 'ElectricDreamsEnv2 MassiveCanyonSandstoneMesa + cliffs',
};

const outPath = WRITE_LIVE
  ? LIVE
  : path.join(ROOT, 'assets/mesa/terrain-skirmish-1v1.megascans.glb');
if (WRITE_LIVE && !fs.existsSync(LIVE + '.pre-megascans.bak')) {
  fs.copyFileSync(LIVE, LIVE + '.pre-megascans.bak');
}
const outBuf = writeGlb(live.json, newBin);
fs.writeFileSync(outPath, outBuf);
console.log('wrote', outPath, outBuf.length);
if (!WRITE_LIVE) console.log('Dry-run OK — re-run with WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1');
