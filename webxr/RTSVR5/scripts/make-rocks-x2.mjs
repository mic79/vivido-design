#!/usr/bin/env node
/**
 * Build `scifi-rts-rocks-x2.glb` — the rocks kit with COPIES total copies of every rock,
 * each copy rotated by an even share of 360 deg about the rock cluster centre.
 *
 *   COPIES=2  node RTSVR5/scripts/make-rocks-x2.mjs   # 2430 rocks (default)
 *   COPIES=20 node RTSVR5/scripts/make-rocks-x2.mjs   # 24300 rocks
 *   DEEP=1 COPIES=2 node ...                          # copies get their own buffers/textures
 *
 * Copies SHARE geometry, materials and textures by default. The kit's LOD batcher buckets
 * by `geometry.uuid|material.uuid`, so shared copies collapse into the same InstancedMesh
 * instead of adding a batch each — 24300 rocks stay affordable, and 20 deep copies would
 * otherwise mean 400 resident textures. DEEP=1 duplicates the payload instead; that was
 * built to test whether residency drives the PCVR frame cadence, and it does NOT — 2414
 * source meshes and 40 textures measured 67.3 FPS / 15.50 ms against 1207 and 20 at
 * 67.7 FPS / 15.40 ms. GPU time, CPU time, draw calls and render wall are all ruled out
 * the same way, so keep copies shared unless re-testing that specific question.
 *
 * Rotation is about the geometry world-bbox centre (-82.0, 511.3), NOT the bbox of node
 * translations (631, 834) — this is a UE export whose node translations are pivots. Being
 * ~380 units off pushed copies past the assembler's 420-unit clip radius and shifted the
 * combined centre enough to cull the originals too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets/terrain/scifi-rts-rocks.glb');
const DST = path.join(ROOT, 'assets/terrain/scifi-rts-rocks-x2.glb');
const COPIES = Math.max(2, Number(process.env.COPIES || 2));
const DEEP = process.env.DEEP === '1';

function readGlb(filePath) {
  const buf = fs.readFileSync(filePath);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  let off = 12;
  const jsonLen = dv.getUint32(off, true);
  if (dv.getUint32(off + 4, true) !== 0x4e4f534a) throw new Error('missing JSON chunk');
  const json = JSON.parse(Buffer.from(buf.subarray(off + 8, off + 8 + jsonLen)).toString('utf8'));
  off += 8 + jsonLen;
  if (off >= buf.byteLength) return { json, bin: Buffer.alloc(0) };
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

function shiftTexInfo(info, d) {
  if (!info || typeof info.index !== 'number') return info;
  return { ...info, index: info.index + d };
}

/** Rotate vector `v` by quaternion `q` ([x,y,z,w]). */
function quatRot(q, v) {
  const [x, y, z, w] = q;
  const [a, b, c] = v;
  const ix = w * a + y * c - z * b;
  const iy = w * b + z * a - x * c;
  const iz = w * c + x * b - y * a;
  const iw = -x * a - y * b - z * c;
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}

/** World bbox centre of all mesh geometry, matching what `assembleKitWrap` clips against. */
function geometryCentreXZ(json) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const nd of json.nodes || []) {
    if (nd.mesh == null) continue;
    const t = nd.translation || [0, 0, 0];
    const r = nd.rotation || [0, 0, 0, 1];
    const s = nd.scale || [1, 1, 1];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of json.meshes[nd.mesh].primitives) {
      const a = json.accessors[p.attributes.POSITION];
      if (!a || !a.min || !a.max) continue;
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], a.min[k]);
        hi[k] = Math.max(hi[k], a.max[k]);
      }
    }
    if (!Number.isFinite(lo[0])) continue;
    for (let i = 0; i < 8; i++) {
      const local = [(i & 1 ? hi : lo)[0] * s[0], (i & 2 ? hi : lo)[1] * s[1], (i & 4 ? hi : lo)[2] * s[2]];
      const w = quatRot(r, local);
      for (let k = 0; k < 3; k++) {
        const v = w[k] + t[k];
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
    }
  }
  return { cx: (mn[0] + mx[0]) / 2, cz: (mn[2] + mx[2]) / 2 };
}

function main() {
  const { json, bin } = readGlb(SRC);
  const nodes = json.nodes || [];
  const meshNodes = nodes.filter((n) => n.mesh != null);
  if (!meshNodes.length) throw new Error('no mesh nodes to duplicate');

  const dBv = (json.bufferViews || []).length;
  const dAcc = (json.accessors || []).length;
  const dImg = (json.images || []).length;
  const dTex = (json.textures || []).length;
  const dSamp = (json.samplers || []).length;
  const dMat = (json.materials || []).length;
  const dMesh = (json.meshes || []).length;

  const outBufferViews = (json.bufferViews || []).map((b) => structuredClone(b));
  const outAccessors = (json.accessors || []).map((a) => structuredClone(a));
  const outSamplers = (json.samplers || []).map((s) => structuredClone(s));
  const outImages = (json.images || []).map((i) => structuredClone(i));
  const outTextures = (json.textures || []).map((t) => structuredClone(t));
  const outMaterials = (json.materials || []).map((m) => structuredClone(m));
  const outMeshes = (json.meshes || []).map((m) => structuredClone(m));
  const outNodes = nodes.map((n) => structuredClone(n));
  const binParts = [bin];
  let binLen = bin.length;

  /** Append one deep copy of the whole payload; returns the mesh index offset. */
  function addDeepPayload(tag) {
    const pad = (4 - (binLen % 4)) % 4;
    if (pad) {
      binParts.push(Buffer.alloc(pad, 0));
      binLen += pad;
    }
    const base = binLen;
    binParts.push(bin);
    binLen += bin.length;

    const bvOff = outBufferViews.length;
    for (const b of json.bufferViews || []) {
      outBufferViews.push({ ...structuredClone(b), byteOffset: (b.byteOffset || 0) + base });
    }
    const accOff = outAccessors.length;
    for (const a of json.accessors || []) {
      const c = structuredClone(a);
      if (c.bufferView != null) c.bufferView = c.bufferView - 0 + bvOff;
      outAccessors.push(c);
    }
    const sampOff = outSamplers.length;
    for (const s of json.samplers || []) outSamplers.push(structuredClone(s));
    const imgOff = outImages.length;
    for (const i of json.images || []) {
      const c = structuredClone(i);
      if (c.bufferView != null) c.bufferView = c.bufferView - 0 + bvOff;
      outImages.push(c);
    }
    const texOff = outTextures.length;
    for (const t of json.textures || []) {
      const c = structuredClone(t);
      if (c.source != null) c.source = c.source - 0 + imgOff;
      if (c.sampler != null) c.sampler = c.sampler - 0 + sampOff;
      outTextures.push(c);
    }
    const matOff = outMaterials.length;
    for (const m of json.materials || []) {
      const c = structuredClone(m);
      c.name = `${c.name || 'mat'}${tag}`;
      if (c.pbrMetallicRoughness) {
        c.pbrMetallicRoughness.baseColorTexture = shiftTexInfo(c.pbrMetallicRoughness.baseColorTexture, texOff - 0);
        c.pbrMetallicRoughness.metallicRoughnessTexture = shiftTexInfo(c.pbrMetallicRoughness.metallicRoughnessTexture, texOff - 0);
      }
      c.normalTexture = shiftTexInfo(c.normalTexture, texOff - 0);
      c.occlusionTexture = shiftTexInfo(c.occlusionTexture, texOff - 0);
      c.emissiveTexture = shiftTexInfo(c.emissiveTexture, texOff - 0);
      outMaterials.push(c);
    }
    const meshOff = outMeshes.length;
    for (const m of json.meshes || []) {
      const c = structuredClone(m);
      c.name = `${c.name || 'mesh'}${tag}`;
      for (const p of c.primitives) {
        if (p.material != null) p.material = p.material - 0 + matOff;
        if (p.indices != null) p.indices = p.indices - 0 + accOff;
        const attrs = {};
        for (const [k, v] of Object.entries(p.attributes || {})) attrs[k] = v - 0 + accOff;
        p.attributes = attrs;
      }
      outMeshes.push(c);
    }
    return meshOff;
  }

  const { cx, cz } = geometryCentreXZ(json);
  const origRoots = (json.scenes[json.scene || 0].nodes || []).slice();
  const topChildren = [...origRoots];

  for (let copy = 1; copy < COPIES; copy++) {
    const tag = `_x${copy + 1}`;
    const meshOff = DEEP ? addDeepPayload(tag) : 0;
    const th = (copy * 2 * Math.PI) / COPIES;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    // M = T(c) . Ry(th) . T(-c), column-major as glTF wants it.
    const tx = cx - (cos * cx + sin * cz);
    const tz = cz - (-sin * cx + cos * cz);
    const groupIndex = outNodes.length;
    outNodes.push({
      name: `StoryRocksTerrain${tag}`,
      matrix: [cos, 0, -sin, 0, 0, 1, 0, 0, sin, 0, cos, 0, tx, 0, tz, 1],
      children: [],
    });
    for (const n of nodes) {
      if (n.mesh == null) continue;
      const c = structuredClone(n);
      c.name = `${n.name || 'node'}${tag}`;
      c.mesh = n.mesh + (DEEP ? meshOff : 0);
      delete c.children;
      outNodes[groupIndex].children.push(outNodes.length);
      outNodes.push(c);
    }
    topChildren.push(groupIndex);
  }

  const topIndex = outNodes.length;
  outNodes.push({ name: 'StoryRocksTerrainX2Root', children: topChildren });

  const newBin = Buffer.concat(binParts);
  const out = {
    ...json,
    asset: { ...(json.asset || {}), generator: 'make-rocks-x2' },
    scenes: [{ name: json.scenes[json.scene || 0].name || 'LOD2', nodes: [topIndex] }],
    scene: 0,
    nodes: outNodes,
    meshes: outMeshes,
    materials: outMaterials,
    accessors: outAccessors,
    bufferViews: outBufferViews,
    buffers: [{ byteLength: newBin.length }],
    images: outImages,
    textures: outTextures,
  };
  if (outSamplers.length) out.samplers = outSamplers;

  writeGlb(DST, out, newBin);
  const srcMb = (fs.statSync(SRC).size / (1024 * 1024)).toFixed(2);
  const dstMb = (fs.statSync(DST).size / (1024 * 1024)).toFixed(2);
  console.log(
    `wrote ${path.relative(ROOT, DST)}  ${srcMb} MB -> ${dstMb} MB   payload=${DEEP ? 'deep copies' : 'shared'}\n` +
      `  rocks ${meshNodes.length} -> ${meshNodes.length * COPIES}   textures ${dTex} -> ${outTextures.length}   ` +
      `materials ${dMat} -> ${outMaterials.length}   meshes ${dMesh} -> ${outMeshes.length}\n` +
      `  ${COPIES} copies at ${(360 / COPIES).toFixed(1)} deg steps about cluster centre (${cx.toFixed(1)}, ${cz.toFixed(1)})`
  );
  if (dAcc + dBv === 0) throw new Error('empty source');
}

main();
