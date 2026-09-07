#!/usr/bin/env node
/**
 * Build a half-texture twin of scifi-rts-rocks.glb: 20 textures -> 10, with geometry, nodes,
 * materials, draw calls and per-material texture slots all left alone. Materials are
 * repointed at another material's maps instead of having slots removed, so the shader
 * permutations and per-pixel texture fetches stay identical and unique-texture residency is
 * the only axis that moves.
 *
 *   node RTSVR5/scripts/make-rocks-halftex.mjs
 *   OUT=scifi-rts-rocks-t10.glb node RTSVR5/scripts/make-rocks-halftex.mjs
 *
 * Cliffs and Minerals borrow the Rocks maps; DirtPile2 borrows DirtPile1's roughness and
 * occlusion but keeps its own base colour, which is what lands the count on exactly 10.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets/terrain', process.env.SRC || 'scifi-rts-rocks.glb');
/** `two` collapses every material onto one base colour + normal pair instead of halving. */
const MODE = process.env.MODE || 'half';
const OUT_NAME = process.env.OUT || 'scifi-rts-rocks-t10.glb';
const DST = path.join(ROOT, 'assets/terrain', OUT_NAME);

/** Source texture index -> texture index to use instead. */
const REMAP = new Map([
  [4, 0], [5, 1], [6, 2], [7, 3], // MI_Cliffs1   -> MI_Rocks
  [8, 0], [9, 1], [10, 2], [11, 3], // MI_Mineral_1 -> MI_Rocks
  [18, 13], [19, 14], // MI_DirtPile2 -> MI_DirtPile_1 (metallicRoughness, occlusion)
]);

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

const SLOT_OWNERS = (mat) => [
  [mat.pbrMetallicRoughness || {}, 'baseColorTexture'],
  [mat.pbrMetallicRoughness || {}, 'metallicRoughnessTexture'],
  [mat, 'normalTexture'],
  [mat, 'occlusionTexture'],
  [mat, 'emissiveTexture'],
];

function main() {
  const { json, bin } = readGlb(SRC);
  const beforeTex = json.textures.length;
  const beforeImg = json.images.length;

  // 1. repoint material slots
  let repointed = 0;
  if (MODE === 'two') {
    // Every surviving slot lands on MI_Rocks' base colour or normal. Verified by image name
    // rather than trusting index 0/2 to still mean that after an upstream transform.
    const nameOf = (t) => json.images[json.textures[t].source]?.name || '';
    const A = json.textures.findIndex((_, i) => /MI_Rocks_BaseColor/i.test(nameOf(i)));
    const B = json.textures.findIndex((_, i) => /MI_Rocks_Normal/i.test(nameOf(i)));
    if (A < 0 || B < 0) throw new Error('MODE=two needs the MI_Rocks base colour and normal maps');
    for (const mat of json.materials) {
      const pbr = mat.pbrMetallicRoughness;
      if (pbr?.baseColorTexture) {
        pbr.baseColorTexture = { ...pbr.baseColorTexture, index: A };
        repointed++;
      }
      if (pbr?.metallicRoughnessTexture) delete pbr.metallicRoughnessTexture;
      if (mat.normalTexture) {
        mat.normalTexture = { ...mat.normalTexture, index: B };
        repointed++;
      }
      delete mat.occlusionTexture;
      delete mat.emissiveTexture;
    }
  } else {
    for (const mat of json.materials) {
      for (const [owner, key] of SLOT_OWNERS(mat)) {
        const info = owner[key];
        if (!info || typeof info.index !== 'number') continue;
        const to = REMAP.get(info.index);
        if (to == null) continue;
        info.index = to;
        repointed++;
      }
    }
  }

  // 2. which textures are still referenced
  const usedTex = new Set();
  for (const mat of json.materials) {
    for (const [owner, key] of SLOT_OWNERS(mat)) {
      const info = owner[key];
      if (info && typeof info.index === 'number') usedTex.add(info.index);
    }
  }
  const texList = [...usedTex].sort((a, b) => a - b);
  const texMap = new Map(texList.map((old, i) => [old, i]));

  const usedImg = new Set();
  for (const t of texList) {
    const src = json.textures[t].source;
    if (src != null) usedImg.add(src);
  }
  const imgList = [...usedImg].sort((a, b) => a - b);
  const imgMap = new Map(imgList.map((old, i) => [old, i]));

  // 3. keep every bufferView an accessor needs, plus the surviving images' views
  const keepBv = new Set();
  for (const a of json.accessors) if (a.bufferView != null) keepBv.add(a.bufferView);
  for (const i of imgList) {
    const bv = json.images[i].bufferView;
    if (bv != null) keepBv.add(bv);
  }
  const bvList = [...keepBv].sort((a, b) => a - b);
  const bvMap = new Map();
  const chunks = [];
  let cursor = 0;
  const newBufferViews = [];
  for (const old of bvList) {
    const bv = json.bufferViews[old];
    const pad = (4 - (cursor % 4)) % 4;
    if (pad) {
      chunks.push(Buffer.alloc(pad, 0));
      cursor += pad;
    }
    const start = bv.byteOffset || 0;
    chunks.push(bin.subarray(start, start + bv.byteLength));
    const nb = { buffer: 0, byteOffset: cursor, byteLength: bv.byteLength };
    if (bv.byteStride != null) nb.byteStride = bv.byteStride;
    if (bv.target != null) nb.target = bv.target;
    bvMap.set(old, newBufferViews.length);
    newBufferViews.push(nb);
    cursor += bv.byteLength;
  }
  const newBin = Buffer.concat(chunks);

  // 4. rewrite the tables that index into what moved
  for (const a of json.accessors) if (a.bufferView != null) a.bufferView = bvMap.get(a.bufferView);
  json.images = imgList.map((old) => {
    const im = structuredClone(json.images[old]);
    if (im.bufferView != null) im.bufferView = bvMap.get(im.bufferView);
    return im;
  });
  json.textures = texList.map((old) => {
    const t = structuredClone(json.textures[old]);
    if (t.source != null) t.source = imgMap.get(t.source);
    return t;
  });
  for (const mat of json.materials) {
    for (const [owner, key] of SLOT_OWNERS(mat)) {
      const info = owner[key];
      if (info && typeof info.index === 'number') info.index = texMap.get(info.index);
    }
  }
  json.buffers = [{ byteLength: newBin.length }];
  json.asset = { ...(json.asset || {}), generator: 'make-rocks-halftex' };

  // tryLoadRocksKit rejects anything under MIN_STORY_ROCKS_BYTES (1 MB) as a truncated
  // download, so a heavily reduced variant has to carry ballast to be loadable at all. The
  // padding is trailing BIN bytes no bufferView points at: never parsed, never uploaded.
  const padTo = Number(process.env.PAD_TO || 0);

  // 5. sanity: nothing may dangle
  for (const mat of json.materials) {
    for (const [owner, key] of SLOT_OWNERS(mat)) {
      const info = owner[key];
      if (info && (info.index == null || info.index >= json.textures.length)) {
        throw new Error(`dangling ${key} on material ${mat.name}`);
      }
    }
  }
  for (const t of json.textures) if (t.source != null && t.source >= json.images.length) throw new Error('dangling image');
  for (const a of json.accessors) if (a.bufferView != null && a.bufferView >= newBufferViews.length) throw new Error('dangling bufferView');

  json.bufferViews = newBufferViews;
  let finalBin = newBin;
  if (padTo && newBin.length < padTo) {
    finalBin = Buffer.concat([newBin, Buffer.alloc(padTo - newBin.length, 0)]);
    json.buffers = [{ byteLength: finalBin.length }];
  }
  writeGlb(DST, json, finalBin);

  const srcMb = fs.statSync(SRC).size / 1048576;
  const dstMb = fs.statSync(DST).size / 1048576;
  console.log(
    `${OUT_NAME}\n` +
      `  textures ${beforeTex} -> ${json.textures.length}   images ${beforeImg} -> ${json.images.length}   slots repointed ${repointed}\n` +
      `  materials ${json.materials.length} (unchanged)   nodes ${json.nodes.length} (unchanged)   meshes ${json.meshes.length} (unchanged)\n` +
      `  size ${srcMb.toFixed(2)} MB -> ${dstMb.toFixed(2)} MB`
  );
}

main();
