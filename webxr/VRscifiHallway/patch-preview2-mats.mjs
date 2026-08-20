#!/usr/bin/env node
/** Copy SIMPLE-baked material textures from landscape1 onto LandscapePreview2 (Disabled bake left many mats empty). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(ROOT, 'landscape1');
const DST_DIR = path.join(ROOT, 'landscape2');
const SRC = JSON.parse(fs.readFileSync(path.join(SRC_DIR, 'LandscapePreview1.gltf'), 'utf8'));
const DST = JSON.parse(fs.readFileSync(path.join(DST_DIR, 'LandscapePreview2.gltf'), 'utf8'));

const srcMats = new Map((SRC.materials || []).map((m) => [m.name, m]));
const srcTex = SRC.textures || [];
const srcImg = SRC.images || [];

function texUri(texIndex) {
  const tex = srcTex[texIndex];
  if (!tex) return null;
  const img = srcImg[tex.source];
  return img?.uri || null;
}

function addImage(uri) {
  const i = DST.images.findIndex((im) => im.uri === uri);
  if (i >= 0) return i;
  DST.images.push({ uri });
  return DST.images.length - 1;
}

function addTexture(uri, sampler = 0) {
  const source = addImage(uri);
  const existing = (DST.textures || []).findIndex((t) => t.source === source);
  if (existing >= 0) return existing;
  DST.textures = DST.textures || [];
  DST.textures.push({ sampler, source });
  return DST.textures.length - 1;
}

function slot(mat, pathArr) {
  let o = mat;
  for (const k of pathArr) {
    if (!o || typeof o !== 'object') return undefined;
    o = o[k];
  }
  return o;
}

function setSlot(mat, pathArr, texIndex) {
  let o = mat;
  for (let i = 0; i < pathArr.length - 1; i++) {
    const k = pathArr[i];
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k];
  }
  o[pathArr[pathArr.length - 1]] = { index: texIndex };
}

const SLOTS = [
  ['pbrMetallicRoughness', 'baseColorTexture'],
  ['pbrMetallicRoughness', 'metallicRoughnessTexture'],
  ['normalTexture'],
  ['occlusionTexture'],
  ['emissiveTexture'],
];

let patched = 0;
let copiedFiles = 0;
for (const mat of DST.materials || []) {
  const src = srcMats.get(mat.name);
  if (!src) continue;
  let changed = false;
  for (const pathArr of SLOTS) {
    const have = slot(mat, pathArr)?.index;
    if (Number.isInteger(have)) continue;
    const srcIndex = slot(src, pathArr)?.index;
    if (!Number.isInteger(srcIndex)) continue;
    const uri = texUri(srcIndex);
    if (!uri) continue;
    const from = path.join(SRC_DIR, uri);
    const to = path.join(DST_DIR, uri);
    if (!fs.existsSync(from)) continue;
    if (!fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      copiedFiles++;
    }
    setSlot(mat, pathArr, addTexture(uri));
    changed = true;
  }
  if (changed) patched++;
}

fs.writeFileSync(path.join(DST_DIR, 'LandscapePreview2.gltf'), JSON.stringify(DST));
const gltf = path.join(DST_DIR, 'LandscapePreview2.gltf');
let text = fs.readFileSync(gltf, 'utf8');
text = text.replaceAll(': inf', ': 1.5').replaceAll(':inf', ': 1.5');
fs.writeFileSync(gltf, text);
console.log(JSON.stringify({ patched, copiedFiles, images: DST.images.length, textures: DST.textures.length }));
