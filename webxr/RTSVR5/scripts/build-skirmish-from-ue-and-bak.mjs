#!/usr/bin/env node
/**
 * Automatic UE → shippable skirmish GLB (no per-object special cases):
 *   - Start from UE-normalized export (ALL props / new scenery / transforms)
 *   - Replace Moon_* with textured moons from the known-good bak
 *     (UE glTF DISABLED bake strips moon albedo; bak keeps game look)
 *   - Caller runs bake-rock-shadows.mjs (casts every Prop_* descendant)
 *
 *   node RTSVR5/scripts/build-skirmish-from-ue-and-bak.mjs [ue-norm.glb] [bak.glb] [out.glb]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UE =
  process.argv[2] || 'D:/ue5/UE58_scifi/Exported/skirmish-1v1-normalized.glb';
const BAK =
  process.argv[3] ||
  path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb.pre-ue-pipeline.bak');
const OUT = process.argv[4] || path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = dv.getUint32(12, true);
  let jsonText = Buffer.from(buf.subarray(20, 20 + jsonLen)).toString('utf8');
  jsonText = jsonText.replace(/:\s*-?inf\b/gi, ':null').replace(/:\s*nan\b/gi, ':null');
  const json = JSON.parse(jsonText);
  const binStart = 20 + jsonLen;
  const binLen = dv.getUint32(binStart, true);
  const bin = Buffer.from(buf.subarray(binStart + 8, binStart + 8 + binLen));
  return { json, bin };
}

function writeGlb(json, bin) {
  json.buffers = [{ byteLength: bin.length }];
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jp = (4 - (jsonBuf.length % 4)) % 4;
  const bp = (4 - (bin.length % 4)) % 4;
  const jc = jsonBuf.length + jp;
  const bc = bin.length + bp;
  const out = Buffer.alloc(12 + 8 + jc + 8 + bc);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jc, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBuf.copy(out, 20);
  out.fill(0x20, 20 + jsonBuf.length, 20 + jc);
  const o = 20 + jc;
  out.writeUInt32LE(bc, o);
  out.writeUInt32LE(0x004e4942, o + 4);
  bin.copy(out, o + 8);
  return out;
}

function pad4(n) {
  return (4 - (n % 4)) % 4;
}

const ue = parseGlb(fs.readFileSync(UE));
const bak = parseGlb(fs.readFileSync(BAK));

let bin = Buffer.from(ue.bin);
const bufferViews = [...(ue.json.bufferViews || [])];
const accessors = [...(ue.json.accessors || [])];
const meshes = [...(ue.json.meshes || [])];
const nodes = [...(ue.json.nodes || [])];
const materials = [...(ue.json.materials || [])];
const textures = [...(ue.json.textures || [])];
const images = [...(ue.json.images || [])];
const samplers = [...(ue.json.samplers || [])];

function appendView(srcJson, srcBin, bvIdx) {
  const bv = srcJson.bufferViews[bvIdx];
  const start = bv.byteOffset || 0;
  const chunk = srcBin.subarray(start, start + bv.byteLength);
  const pad = Buffer.alloc(pad4(bin.length));
  const byteOffset = bin.length + pad.length;
  bin = Buffer.concat([bin, pad, chunk]);
  const nb = { buffer: 0, byteOffset, byteLength: bv.byteLength };
  if (bv.byteStride) nb.byteStride = bv.byteStride;
  if (bv.target) nb.target = bv.target;
  bufferViews.push(nb);
  return bufferViews.length - 1;
}

function copyAccessor(srcJson, srcBin, accIdx) {
  const acc = { ...srcJson.accessors[accIdx] };
  acc.bufferView = appendView(srcJson, srcBin, acc.bufferView);
  accessors.push(acc);
  return accessors.length - 1;
}

function copyImage(srcJson, srcBin, imgIdx) {
  const img = { ...srcJson.images[imgIdx] };
  if (img.bufferView != null) img.bufferView = appendView(srcJson, srcBin, img.bufferView);
  images.push(img);
  return images.length - 1;
}

function copyTexture(srcJson, srcBin, texIdx, imgMap) {
  const tex = { ...srcJson.textures[texIdx] };
  if (tex.source != null) {
    if (imgMap[tex.source] == null) imgMap[tex.source] = copyImage(srcJson, srcBin, tex.source);
    tex.source = imgMap[tex.source];
  }
  if (tex.sampler != null && srcJson.samplers?.[tex.sampler]) {
    samplers.push({ ...srcJson.samplers[tex.sampler] });
    tex.sampler = samplers.length - 1;
  }
  textures.push(tex);
  return textures.length - 1;
}

function copyMaterial(srcJson, srcBin, matIdx, imgMap, texMap) {
  const mat = JSON.parse(JSON.stringify(srcJson.materials[matIdx]));
  const remap = (ref) => {
    if (!ref || ref.index == null) return;
    if (texMap[ref.index] == null) {
      texMap[ref.index] = copyTexture(srcJson, srcBin, ref.index, imgMap);
    }
    ref.index = texMap[ref.index];
  };
  const pbr = mat.pbrMetallicRoughness || {};
  remap(pbr.baseColorTexture);
  remap(pbr.metallicRoughnessTexture);
  remap(mat.normalTexture);
  remap(mat.occlusionTexture);
  remap(mat.emissiveTexture);
  materials.push(mat);
  return materials.length - 1;
}

const bakMoons = (bak.json.nodes || []).filter((n) => /^Moon_[01]$/i.test(n.name || ''));
if (bakMoons.length < 2) throw new Error('bak missing Moon_0/1');

const imgMap = {};
const texMap = {};
const matMap = {};

for (const bn of bakMoons) {
  const name = bn.name;
  const srcMesh = bak.json.meshes[bn.mesh];
  const prim = srcMesh.primitives[0];
  const attrs = {};
  for (const [k, ai] of Object.entries(prim.attributes || {})) {
    attrs[k] = copyAccessor(bak.json, bak.bin, ai);
  }
  const newPrim = { attributes: attrs, mode: prim.mode ?? 4 };
  if (prim.indices != null) newPrim.indices = copyAccessor(bak.json, bak.bin, prim.indices);
  if (prim.material != null) {
    if (matMap[prim.material] == null) {
      matMap[prim.material] = copyMaterial(bak.json, bak.bin, prim.material, imgMap, texMap);
    }
    newPrim.material = matMap[prim.material];
  }
  const meshIdx = meshes.length;
  meshes.push({ name, primitives: [newPrim] });

  let hit = false;
  for (const n of nodes) {
    if (n.name !== name) continue;
    n.mesh = meshIdx;
    delete n.translation;
    n.scale = [1, 1, 1];
    if (bn.rotation) n.rotation = bn.rotation.slice();
    else delete n.rotation;
    hit = true;
  }
  if (!hit) {
    const node = { name, mesh: meshIdx, scale: [1, 1, 1] };
    if (bn.rotation) node.rotation = bn.rotation.slice();
    nodes.push(node);
    if (ue.json.scenes?.[0]?.nodes) ue.json.scenes[0].nodes.push(nodes.length - 1);
  }
  console.log('replaced moon', name, 'mesh', meshIdx, 'from bak');
}

const outJson = {
  ...ue.json,
  asset: { ...(ue.json.asset || {}), generator: 'build-skirmish-from-ue-and-bak' },
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
if (outJson.extras) {
  delete outJson.extras.rtsMoonRockShadows;
  delete outJson.extras.rtsPropSelfShadows;
  delete outJson.extras.rtsHeroRgbLightmaps;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, writeGlb(outJson, bin));

const check = parseGlb(fs.readFileSync(OUT));
const props = (check.json.nodes || []).filter((n) => !/^Moon_/i.test(n.name || ''));
const propNamed = (check.json.nodes || []).filter((n) => /^Prop_/i.test(n.name || ''));
for (const name of ['Moon_0', 'Moon_1']) {
  const n = check.json.nodes.find((x) => x.name === name);
  const prim = check.json.meshes[n.mesh].primitives[0];
  const mat = check.json.materials[prim.material];
  const hasMap = !!mat?.pbrMetallicRoughness?.baseColorTexture;
  if (!hasMap) {
    console.error('FAIL', name, 'missing albedo');
    process.exit(2);
  }
  console.log('OK', name, 'textured');
}
console.log('wrote', OUT, 'bytes', fs.statSync(OUT).size);
console.log('prop_nodes', propNamed.length, 'non_moon_nodes', props.length);
console.log('PASS build-skirmish-from-ue-and-bak (UE props + bak moons)');
