#!/usr/bin/env node
/**
 * Quest encode for forest trees kit (ETC1S albedo + Draco).
 * Normals are rare/absent on this pack — ETC1S-only is correct (UASTC reserved for normals).
 *
 *   node RTSVR5Forest/scripts/compress-forest-trees-quest.mjs
 *
 * In:  assets/terrain/forest-trees-kit.glb
 * Out: assets/terrain/forest-trees-quest.glb
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TERRAIN = path.join(ROOT, 'assets', 'terrain');
const INPUT = path.join(TERRAIN, 'forest-trees-kit.glb');
const OUT = path.join(TERRAIN, 'forest-trees-quest.glb');
const PNG_HELPER = path.resolve('D:/ue5/UE58_scifi/Scripts/glb_images_to_png.py');
const TOKTX_DIR = 'C:\\Program Files\\KTX-Software\\bin';
const WORK = path.join(TERRAIN, '_forest-quest-work');

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const tmpRgb = path.join(WORK, '_forest-rgb.glb');
const tmpEtc = path.join(WORK, '_forest-etc1s.glb');

function run(cliArgs) {
  const args = ['--yes', '@gltf-transform/cli@4.1.1', ...cliArgs];
  console.log('Running:', npx, args.join(' '));
  const env = { ...process.env, PATH: `${TOKTX_DIR}${path.delimiter}${process.env.PATH || ''}` };
  execFileSync(npx, args, {
    stdio: 'inherit',
    shell: true,
    cwd: WORK,
    env,
    windowsVerbatimArguments: true,
  });
}

function rel(p) {
  return path.relative(WORK, p) || '.';
}

if (!fs.existsSync(INPUT)) {
  console.error('Missing input', INPUT);
  process.exit(1);
}
if (!fs.existsSync(path.join(TOKTX_DIR, 'toktx.exe'))) {
  console.error('Missing toktx at', TOKTX_DIR);
  process.exit(1);
}

fs.mkdirSync(WORK, { recursive: true });

if (fs.existsSync(PNG_HELPER)) {
  console.log('Flattening images to sRGB PNG (max 1024px for foliage atlases)…');
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', [
    PNG_HELPER,
    INPUT,
    tmpRgb,
    '1024',
  ], { stdio: 'inherit' });
} else {
  console.warn('PNG helper missing — compressing source GLB directly');
  fs.copyFileSync(INPUT, tmpRgb);
}

run(['etc1s', rel(tmpRgb), rel(tmpEtc), '--quality=160', '--jobs', '4']);
run(['draco', rel(tmpEtc), rel(OUT), '--encode-speed', '1']);

const inSize = fs.statSync(INPUT).size;
const outSize = fs.statSync(OUT).size;
console.log(
  `Forest quest ${path.basename(INPUT)} ${(inSize / 1e6).toFixed(2)} MB -> ${path.basename(OUT)} ${(outSize / 1e6).toFixed(2)} MB`
);

const glb = fs.readFileSync(OUT);
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
const used = json.extensionsUsed || [];
const ktx = (json.images || []).filter((im) => im.mimeType === 'image/ktx2').length;
console.log('verify', {
  draco: used.includes('KHR_draco_mesh_compression'),
  ktx2: used.includes('KHR_texture_basisu'),
  ktxImages: ktx,
  meshes: (json.meshes || []).length,
  materials: (json.materials || []).length,
  meshNodes: (json.nodes || []).filter((n) => n.mesh != null).length,
});
if (!used.includes('KHR_draco_mesh_compression') || !used.includes('KHR_texture_basisu')) {
  console.error('Quest GLB missing Draco/KTX2');
  process.exit(3);
}
if (outSize >= 99 * 1024 * 1024) {
  console.error('Over GitHub Pages 100MB cap');
  process.exit(2);
}

for (const p of [tmpRgb, tmpEtc]) {
  try {
    fs.unlinkSync(p);
  } catch {
    /* */
  }
}
console.log('PASS compress-forest-trees-quest');
