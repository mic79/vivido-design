/**
 * Normalize UE-exported skirmish-1v1 GLB for WebXR.
 *
 * After import fix (UE yaw = -glTF yaw), UE's exporter restores game yaw — do
 * not flip prop rotations here.
 *
 * Moons: UE imports Y-up glTF and converts to Z-up; exporter writes Y-up
 * meters again. After a correct import, moon nodes should be identity Y-up
 * (plate Y ≈ −2…16). Clear translation; force scale [1,1,1]; drop rotation.
 *
 * If a bad double-converted import left Z-up verts in the export, detect via
 * AABB (Y thin, Z tall) and apply Rx(-90°) as a salvage — but prefer fixing
 * the UE import instead.
 *
 *   node RTSVR5/scripts/normalize-ue-skirmish-glb.mjs [in.glb] [out.glb]
 *   node RTSVR5/scripts/bake-rock-shadows.mjs
 */
const MOON_RX_NEG90 = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = process.argv[2] || path.join('D:/ue5/UE58_scifi/Exported/skirmish-1v1-from-ue.glb');
const OUT = process.argv[3] || path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = dv.getUint32(12, true);
  // UE sometimes emits non-JSON tokens (inf/NaN) in material extras.
  let jsonText = Buffer.from(buf.subarray(20, 20 + jsonLen)).toString('utf8');
  jsonText = jsonText.replace(/:\s*-?inf\b/gi, ':null').replace(/:\s*nan\b/gi, ':null');
  const json = JSON.parse(jsonText);
  const binStart = 20 + jsonLen;
  const binLen = dv.getUint32(binStart, true);
  const bin = buf.subarray(binStart + 8, binStart + 8 + binLen);
  return { json, bin };
}

function writeGlb(json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunkLen = jsonBuf.length + jsonPad;
  const binChunkLen = bin.length + binPad;
  const out = Buffer.alloc(12 + 8 + jsonChunkLen + 8 + binChunkLen);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonChunkLen, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBuf.copy(out, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBuf.length + i] = 0x20;
  const binOff = 20 + jsonChunkLen;
  out.writeUInt32LE(binChunkLen, binOff);
  out.writeUInt32LE(0x004e4942, binOff + 4);
  bin.copy(out, binOff + 8);
  return out;
}

const buf = fs.readFileSync(IN);
const { json, bin } = parseGlb(buf);
let props = 0;
let moons = 0;
for (const n of json.nodes || []) {
  const name = n.name || '';
  if (/^Prop_/i.test(name)) {
    props++;
  }
  if (/^Moon_/i.test(name)) {
    delete n.translation;
    n.scale = [1, 1, 1];
    // Probe local AABB: correct Y-up has large XZ + height on Y.
    let useSalvage = false;
    if (typeof n.mesh === 'number' && json.meshes?.[n.mesh]?.primitives?.[0]) {
      const prim = json.meshes[n.mesh].primitives[0];
      const acc = json.accessors?.[prim.attributes?.POSITION];
      if (acc?.min && acc?.max) {
        const ex = acc.max[0] - acc.min[0];
        const ey = acc.max[1] - acc.min[1];
        const ez = acc.max[2] - acc.min[2];
        // Z-up leftover: XY disc, Z height → salvage with Rx(-90).
        if (ex > 50 && ey > 50 && ez < ex * 0.5 && ey > ez * 2) {
          useSalvage = true;
        }
      }
    }
    if (useSalvage) {
      n.rotation = MOON_RX_NEG90.slice();
    } else {
      delete n.rotation;
    }
    moons++;
  }
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
if (fs.existsSync(OUT) && path.resolve(OUT) !== path.resolve(IN)) {
  fs.copyFileSync(OUT, OUT + '.pre-normalize.bak');
}
fs.writeFileSync(OUT, writeGlb(json, bin));
console.log('normalized', IN, '->', OUT, 'props', props, 'moons', moons);
console.log('NEXT: node scripts/bake-rock-shadows.mjs');
