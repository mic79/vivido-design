#!/usr/bin/env node
/**
 * Apply UE-exported Prop_* (and extra scenery) transforms onto the known-good
 * moon GLB. Moons stay seamless from bak; rocks/bridge follow the UE level.
 *
 *   node RTSVR5/scripts/apply-ue-props-onto-bak.mjs [ue-norm.glb] [bak.glb] [out.glb]
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
  const json = JSON.parse(Buffer.from(buf.subarray(20, 20 + jsonLen)).toString('utf8'));
  const binStart = 20 + jsonLen;
  const binLen = dv.getUint32(binStart, true);
  const bin = Buffer.from(buf.subarray(binStart + 8, binStart + 8 + binLen));
  return { json, bin };
}

function writeGlb(json, bin) {
  json.buffers = [{ byteLength: bin.length }];
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunk = jsonBuf.length + jsonPad;
  const binChunk = bin.length + binPad;
  const out = Buffer.alloc(12 + 8 + jsonChunk + 8 + binChunk);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonChunk, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBuf.copy(out, 20);
  out.fill(0x20, 20 + jsonBuf.length, 20 + jsonChunk);
  const binOff = 20 + jsonChunk;
  out.writeUInt32LE(binChunk, binOff);
  out.writeUInt32LE(0x004e4942, binOff + 4);
  bin.copy(out, binOff + 8);
  return out;
}

function isScenery(name) {
  if (!name) return false;
  if (/^Moon_/i.test(name)) return false;
  if (/^Prop_/i.test(name)) return true;
  if (/Bridge|Rock|Cliff|Dirt|Mineral|SM_/i.test(name)) return true;
  return false;
}

const ue = parseGlb(fs.readFileSync(UE));
const bak = parseGlb(fs.readFileSync(BAK));

const bakByName = Object.fromEntries(
  (bak.json.nodes || []).map((n) => [n.name, n])
);
const ueScenery = (ue.json.nodes || []).filter((n) => isScenery(n.name || ''));

let updated = 0;
let missing = 0;
const missingNames = [];
for (const un of ueScenery) {
  const bn = bakByName[un.name];
  if (!bn) {
    // Bridge etc. — not in bak; skip geometry merge here (handled by full UE path)
    missing++;
    if (missingNames.length < 20) missingNames.push(un.name);
    continue;
  }
  if (un.translation) bn.translation = un.translation.slice();
  else delete bn.translation;
  if (un.rotation) bn.rotation = un.rotation.slice();
  else delete bn.rotation;
  if (un.scale) bn.scale = un.scale.slice();
  else delete bn.scale;
  updated++;
}

// If UE has scenery absent from bak (e.g. Modular_Bridge), we need full mesh copy.
// For now: if only transforms of shared props, write bak with updated props.
const sharedProps = ueScenery.filter((n) => bakByName[n.name]).length;
console.log({
  ueScenery: ueScenery.length,
  updated,
  missingInBak: missing,
  missingNames,
  sharedProps,
  bakProps: (bak.json.nodes || []).filter((n) => /^Prop_/i.test(n.name || '')).length,
});

if (missing > 0) {
  console.warn(
    'WARN: UE scenery not in bak — those meshes will NOT appear until full mesh merge:',
    missingNames.join(', ')
  );
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
// Preserve bak extras (rock shadows); caller should re-bake after prop moves
fs.writeFileSync(OUT, writeGlb(bak.json, bak.bin));
console.log('wrote', OUT, 'bytes', fs.statSync(OUT).size);
