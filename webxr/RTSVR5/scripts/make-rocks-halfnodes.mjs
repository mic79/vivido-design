#!/usr/bin/env node
/**
 * Build a half-placement twin of scifi-rts-rocks.glb: keep every other rock node, leave the
 * 20 master meshes, materials and all 20 textures untouched. Unlike the half-triangle and
 * half-texture variants this removes whole objects, so instance counts and placed triangles
 * both fall by half.
 *
 *   node RTSVR5/scripts/make-rocks-halfnodes.mjs
 *   KEEP=4 OUT=scifi-rts-rocks-n25.glb node RTSVR5/scripts/make-rocks-halfnodes.mjs
 *
 * Every KEEP-th placement is dropped in scene order rather than by region, so the thinning is
 * spread across the map instead of clearing one side of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets/terrain', process.env.SRC || 'scifi-rts-rocks.glb');
const KEEP = Number(process.env.KEEP || 2); // keep 1 of every KEEP placements
const OUT_NAME = process.env.OUT || 'scifi-rts-rocks-n50.glb';
const DST = path.join(ROOT, 'assets/terrain', OUT_NAME);

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

function trisOfMesh(json, meshIndex) {
  let t = 0;
  for (const p of json.meshes[meshIndex].primitives) {
    const a = p.indices != null ? json.accessors[p.indices] : json.accessors[p.attributes.POSITION];
    t += a.count / 3;
  }
  return t;
}

function main() {
  const { json, bin } = readGlb(SRC);
  const scene = json.scenes[json.scene ?? 0];

  // Walk the graph, keeping structure but thinning mesh-bearing nodes.
  const oldNodes = json.nodes;
  let seenMeshNodes = 0;
  let beforePlacements = 0;
  let beforeTris = 0;
  const keepOld = new Set();

  const visit = (i) => {
    const n = oldNodes[i];
    if (n.mesh != null) {
      beforePlacements++;
      beforeTris += trisOfMesh(json, n.mesh);
      const keep = seenMeshNodes % KEEP === 0;
      seenMeshNodes++;
      if (!keep) return;
    }
    keepOld.add(i);
    for (const c of n.children || []) visit(c);
  };
  for (const r of scene.nodes) visit(r);

  const oldToNew = new Map();
  const kept = [...keepOld].sort((a, b) => a - b);
  kept.forEach((old, i) => oldToNew.set(old, i));
  json.nodes = kept.map((old) => {
    const n = structuredClone(oldNodes[old]);
    if (n.children) {
      n.children = n.children.filter((c) => oldToNew.has(c)).map((c) => oldToNew.get(c));
      if (!n.children.length) delete n.children;
    }
    return n;
  });
  json.scenes = json.scenes.map((s) => ({ ...s, nodes: (s.nodes || []).filter((n) => oldToNew.has(n)).map((n) => oldToNew.get(n)) }));
  json.asset = { ...(json.asset || {}), generator: 'make-rocks-halfnodes' };

  let afterPlacements = 0;
  let afterTris = 0;
  for (const n of json.nodes) {
    if (n.mesh == null) continue;
    afterPlacements++;
    afterTris += trisOfMesh(json, n.mesh);
  }
  if (!afterPlacements) throw new Error('thinned every placement away');

  writeGlb(DST, json, bin);
  console.log(
    `${OUT_NAME}\n` +
      `  placements ${beforePlacements} -> ${afterPlacements}  (${((afterPlacements / beforePlacements) * 100).toFixed(1)}%)\n` +
      `  placed triangles ${(beforeTris / 1e6).toFixed(3)}M -> ${(afterTris / 1e6).toFixed(3)}M\n` +
      `  meshes ${json.meshes.length}  materials ${json.materials.length}  textures ${json.textures.length} (all unchanged)\n` +
      `  size ${(fs.statSync(SRC).size / 1048576).toFixed(2)} MB -> ${(fs.statSync(DST).size / 1048576).toFixed(2)} MB`
  );
}

main();
