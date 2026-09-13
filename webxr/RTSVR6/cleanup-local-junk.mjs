#!/usr/bin/env node
/**
 * Safe RTSVR6 disk cleanup — only deletes confirmed non-runtime junk.
 * Does NOT touch live match/lobby GLBs, units, audio, HDR, moon textures,
 * or Hera runtime HQ (diffuse-hq / normal-hq / splat).
 *
 *   node RTSVR6/cleanup-local-junk.mjs
 *   node RTSVR6/cleanup-local-junk.mjs --dry
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry');

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.size;
    let n = 0;
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      n += sizeOf(path.join(p, ent.name));
    }
    return n;
  } catch {
    return 0;
  }
}

function rm(p) {
  const bytes = sizeOf(p);
  if (!fs.existsSync(p)) return 0;
  const rel = path.relative(ROOT, p);
  if (DRY) {
    console.log(`DRY ${(bytes / 1e6).toFixed(1)}MB  ${rel}`);
    return bytes;
  }
  fs.rmSync(p, { recursive: true, force: true });
  console.log(`RM  ${(bytes / 1e6).toFixed(1)}MB  ${rel}`);
  return bytes;
}

let total = 0;

// --- Local profiles / bench outputs (gitignored) ---
for (const name of fs.readdirSync(ROOT, { withFileTypes: true })) {
  const n = name.name;
  const p = path.join(ROOT, n);
  if (/^\.(chrome|iwe)/i.test(n) || /^proof-/i.test(n) || /^bench-/i.test(n) || n === 'export' || n === '_quest-work') {
    total += rm(p);
    continue;
  }
  if (
    name.isFile() &&
    /\.(png|json|txt|log)$/i.test(n) &&
    /^(proof-|bisect-|sample-xr|decay-|entervr-|chrome-flags|bench-)/i.test(n)
  ) {
    total += rm(p);
  }
  if (name.isDirectory() && /^verify-/i.test(n)) total += rm(p);
}

// --- Terrain: keep live product GLBs only; drop .bak / Copy / empty work dirs ---
const KEEP_TERRAIN = new Set([
  'terrain-skirmish-1v1.glb', // live Hera match (unique to RTSVR6)
  'terrain-skirmish-ue-lm.glb', // lobby crater (also in RTSVR5)
  'scifi-rts-quest.glb',
  'scifi-rts-kit-lod2.glb',
  'scifi-rts-overview.glb',
  'scifi-rts-rocks.glb',
  'scifi-overview-groundscape.glb',
]);
const terrainDir = path.join(ROOT, 'assets', 'terrain');
if (fs.existsSync(terrainDir)) {
  for (const name of fs.readdirSync(terrainDir)) {
    if (KEEP_TERRAIN.has(name)) continue;
    total += rm(path.join(terrainDir, name));
  }
}

// --- Hera: keep runtime HQ + splat + height (rebuild) + SOURCE ---
const HERA_KEEP = new Set([
  'diffuse-hq.jpg',
  'normal-hq.jpg',
  'height.png',
  'SOURCE.txt',
  'splat',
]);
const heraDir = path.join(ROOT, 'assets', 'mesa', 'hera-planum');
if (fs.existsSync(heraDir)) {
  for (const name of fs.readdirSync(heraDir)) {
    if (HERA_KEEP.has(name)) continue;
    total += rm(path.join(heraDir, name));
  }
}

// --- Abandoned mesa experiment packs (not loaded by js/; not in RTSVR5) ---
const MESA_DROP = [
  'textures_sand_01',
  'textures_aerial_beach_01',
  'textures_rocky_terrain_02',
  'namaqualand_cliff_01',
  'namaqualand_cliff_02',
  'namaqualand_rocks_01',
  'namaqualand_boulder_03',
  'megascans',
  'megascans-canyon-props.glb',
  'mesa-skirmish-props.glb',
  'skirmish-mesa-plate.glb',
  'skirmish-from-heightmap.glb',
  'cliff_01_web.glb',
  'cliff_02_web.glb',
  'rocks_01_web.glb',
  'boulder_03_web.glb',
  'skirmish-mesa-height.bin',
  'skirmish-mesa-height.r16',
  'skirmish-mesa-height.pgm',
  'skirmish-mesa-height.json',
  'ref-perspective.jpg',
  'ref-topdown.jpg',
  'ref-heightmap.png',
];
const mesaDir = path.join(ROOT, 'assets', 'mesa');
for (const name of MESA_DROP) {
  total += rm(path.join(mesaDir, name));
}

console.log(
  `\n${DRY ? 'DRY total' : 'Removed'}: ${(total / 1e6).toFixed(1)} MB`
);
