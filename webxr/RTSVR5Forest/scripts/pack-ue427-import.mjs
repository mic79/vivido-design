#!/usr/bin/env node
/**
 * Pack moon mesh + Poly Haven textures for UE 4.27 import (SciFiHallway pipeline).
 *
 * OBJ vt = tiled albedo UVs (glTF TEXCOORD_1). UE Generate Lightmap UVs → UV1 for Lightmass.
 * Textures sit next to the OBJ so the .mtl maps resolve on import.
 *
 *   node RTSVR4/scripts/pack-ue427-import.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'export');
const TEX = path.join(ROOT, 'assets', 'textures', 'moon_01_2k');
const GLB = path.join(OUT, 'terrain-skirmish.glb');

const TEXTURES = [
  'moon_01_diff_2k.jpg',
  'moon_01_nor_gl_2k.jpg',
  'moon_01_rough_2k.jpg',
  'moon_01_ao_2k.jpg',
];

const MTL = `newmtl M_MoonTerrain
Ka 1.000 1.000 1.000
Kd 1.000 1.000 1.000
Ks 0.040 0.040 0.040
Ns 8.000
d 1.000
illum 2
map_Kd moon_01_diff_2k.jpg
map_Bump moon_01_nor_gl_2k.jpg
map_Ns moon_01_rough_2k.jpg
# AO (UE has no OBJ slot — import this jpg and hook to Ambient Occlusion)
# moon_01_ao_2k.jpg
`;

function readGlb(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const jsonPad = (jsonLen + 3) & ~3;
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  const binHeader = 12 + 8 + jsonPad;
  const binLen = buf.readUInt32LE(binHeader);
  const bin = buf.subarray(binHeader + 8, binHeader + 8 + binLen);
  return { json, bin };
}

function f32(bin, json, accessorIndex) {
  const acc = json.accessors[accessorIndex];
  const v = json.bufferViews[acc.bufferView];
  const comps = acc.type === 'VEC3' ? 3 : acc.type === 'VEC2' ? 2 : 1;
  return new Float32Array(
    bin.buffer,
    bin.byteOffset + v.byteOffset + (acc.byteOffset || 0),
    acc.count * comps,
  );
}

function u32(bin, json, accessorIndex) {
  const acc = json.accessors[accessorIndex];
  const v = json.bufferViews[acc.bufferView];
  return new Uint32Array(
    bin.buffer,
    bin.byteOffset + v.byteOffset + (acc.byteOffset || 0),
    acc.count,
  );
}

function writeObj(json, bin, mesh, objPath) {
  const p = mesh.primitives[0];
  const pos = f32(bin, json, p.attributes.POSITION);
  const nrm = f32(bin, json, p.attributes.NORMAL);
  // Tiled moon UVs (TEXCOORD_1). Unique LM unwrap is TEXCOORD_0 — UE 4.27 generates LM UVs.
  const uvAttr = p.attributes.TEXCOORD_1 ?? p.attributes.TEXCOORD_0;
  const uv = f32(bin, json, uvAttr);
  const idx = u32(bin, json, p.indices);
  const mtlName = path.basename(objPath, '.obj') + '.mtl';
  let o = `mtllib ${mtlName}\no ${mesh.name}\nusemtl M_MoonTerrain\n`;
  for (let i = 0; i < pos.length; i += 3) {
    o += `v ${pos[i]} ${pos[i + 1]} ${pos[i + 2]}\n`;
  }
  for (let i = 0; i < uv.length; i += 2) {
    o += `vt ${uv[i]} ${uv[i + 1]}\n`;
  }
  for (let i = 0; i < nrm.length; i += 3) {
    o += `vn ${nrm[i]} ${nrm[i + 1]} ${nrm[i + 2]}\n`;
  }
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] + 1;
    const b = idx[i + 1] + 1;
    const c = idx[i + 2] + 1;
    o += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\n`;
  }
  fs.writeFileSync(objPath, o);
  fs.writeFileSync(path.join(path.dirname(objPath), mtlName), MTL);
  console.log(
    `${path.basename(objPath)} verts=${pos.length / 3} tris=${idx.length / 3}  ${(o.length / 1024).toFixed(0)} KB`,
  );
}

if (!fs.existsSync(GLB)) {
  console.error('Missing', GLB, '— run export-terrain-glb.mjs first');
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
for (const name of TEXTURES) {
  const src = path.join(TEX, name);
  if (!fs.existsSync(src)) {
    console.error('Missing texture', src);
    process.exit(1);
  }
  const dest = path.join(OUT, name);
  fs.copyFileSync(src, dest);
  const st = fs.statSync(dest);
  console.log(`texture ${name}  ${(st.size / 1024).toFixed(0)} KB`);
}

const { json, bin } = readGlb(GLB);
for (const mesh of json.meshes) {
  writeObj(json, bin, mesh, path.join(OUT, `${mesh.name}.obj`));
}

console.log('UE 4.27 import folder:', OUT);
console.log('Project: D:\\ue4\\RTSVR4MoonBake (EngineAssociation 4.27, GLTFExporter like SciFiHallway)');
