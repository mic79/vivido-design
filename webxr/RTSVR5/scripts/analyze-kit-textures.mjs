#!/usr/bin/env node
/**
 * Group the full Story kit's LOD2 meshes by name prefix and report how many textures each
 * group pulls in, so texture-count subsets between rocks (20 tex) and the full kit (123)
 * can be picked deliberately.
 *
 *   node RTSVR5/scripts/analyze-kit-textures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets/terrain/scifi-rts-kit-lod2.glb');

function readGlb(p) {
  const b = fs.readFileSync(p);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const jl = dv.getUint32(12, true);
  return JSON.parse(b.subarray(20, 20 + jl).toString('utf8'));
}

const j = readGlb(SRC);
const sc = (j.scenes || []).find((s) => /LOD2/i.test(s.name || '')) || j.scenes[0];
const seen = new Set();
const stack = [...sc.nodes];
while (stack.length) {
  const i = stack.pop();
  if (seen.has(i)) continue;
  seen.add(i);
  for (const c of j.nodes[i].children || []) stack.push(c);
}

function texOf(mi) {
  const s = new Set();
  const m = j.materials[mi];
  if (!m) return s;
  const pbr = m.pbrMetallicRoughness || {};
  for (const t of [pbr.baseColorTexture, pbr.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture]) {
    if (t && typeof t.index === 'number') s.add(t.index);
  }
  return s;
}

const groups = new Map();
for (const i of seen) {
  const n = j.nodes[i];
  if (n.mesh == null) continue;
  const m = /^(SM_[A-Za-z]+)/.exec(n.name || '');
  const pre = m ? m[1] : (n.name || '?').slice(0, 20);
  let g = groups.get(pre);
  if (!g) {
    g = { n: 0, tex: new Set(), tris: 0 };
    groups.set(pre, g);
  }
  g.n++;
  for (const p of j.meshes[n.mesh].primitives) {
    if (p.material != null) for (const t of texOf(p.material)) g.tex.add(t);
    const a = p.indices != null ? j.accessors[p.indices] : j.accessors[p.attributes.POSITION];
    g.tris += a.count / 3;
  }
}

console.log('total textures in file:', (j.textures || []).length, ' mesh nodes:', [...groups.values()].reduce((s, g) => s + g.n, 0));
const ROCKS = /SM_Rock|SM_Dirt|SM_Cliff|SM_Mineral|SM_WaterPlane/i;
const rows = [...groups.entries()].sort((a, b) => b[1].tex.size - a[1].tex.size);
const cum = new Set();
for (const [k, v] of rows) if (ROCKS.test(k)) for (const t of v.tex) cum.add(t);
console.log(`rocks baseline: ${cum.size} textures`);
console.log('--- adding non-rock groups, largest texture set first ---');
for (const [k, v] of rows) {
  if (ROCKS.test(k)) continue;
  for (const t of v.tex) cum.add(t);
  console.log(`${k.padEnd(24)} nodes=${String(v.n).padStart(5)} tex=${String(v.tex.size).padStart(3)} cumTex=${String(cum.size).padStart(4)} tris=${(v.tris / 1e6).toFixed(2)}M`);
}
