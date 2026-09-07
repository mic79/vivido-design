#!/usr/bin/env node
/**
 * Report how scifi-rts-rocks.glb wires materials to textures, so a half-texture variant can
 * be built by remapping material slots rather than by deleting geometry.
 *
 *   node RTSVR5/scripts/inspect-rocks-textures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.SRC || path.join(ROOT, 'assets/terrain/scifi-rts-rocks.glb');

function readGlb(p) {
  const b = fs.readFileSync(p);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const jl = dv.getUint32(12, true);
  return JSON.parse(b.subarray(20, 20 + jl).toString('utf8'));
}

const j = readGlb(SRC);
const SLOTS = ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'];

function slotsOf(m) {
  const pbr = m.pbrMetallicRoughness || {};
  return {
    baseColorTexture: pbr.baseColorTexture?.index,
    metallicRoughnessTexture: pbr.metallicRoughnessTexture?.index,
    normalTexture: m.normalTexture?.index,
    occlusionTexture: m.occlusionTexture?.index,
    emissiveTexture: m.emissiveTexture?.index,
  };
}

console.log(path.basename(SRC));
console.log(`  materials=${(j.materials || []).length}  textures=${(j.textures || []).length}  images=${(j.images || []).length}  meshes=${(j.meshes || []).length}  nodes=${(j.nodes || []).length}`);

// bytes per image, to predict how much residency a halving actually removes
const imgBytes = (j.images || []).map((im) => (im.bufferView != null ? j.bufferViews[im.bufferView].byteLength : 0));
const total = imgBytes.reduce((s, v) => s + v, 0);
console.log(`  image bytes total = ${(total / 1048576).toFixed(2)} MB`);

console.log('\n  material -> texture slots');
for (let i = 0; i < (j.materials || []).length; i++) {
  const m = j.materials[i];
  const s = slotsOf(m);
  const used = SLOTS.filter((k) => s[k] != null).map((k) => `${k.replace('Texture', '')}=${s[k]}`);
  console.log(`   [${String(i).padStart(2)}] ${(m.name || '?').padEnd(34)} ${used.join(' ')}`);
}

console.log('\n  texture -> image (mime, bytes)');
for (let t = 0; t < (j.textures || []).length; t++) {
  const tex = j.textures[t];
  const src = tex.source ?? tex.extensions?.KHR_texture_basisu?.source;
  const im = src != null ? j.images[src] : null;
  const bytes = src != null ? imgBytes[src] : 0;
  console.log(
    `   [${String(t).padStart(2)}] img=${String(src).padStart(3)} ${(im?.mimeType || '?').padEnd(12)} ${(bytes / 1024).toFixed(0).padStart(7)} KB  ${im?.name || ''}`
  );
}
