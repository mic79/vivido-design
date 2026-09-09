#!/usr/bin/env node
/**
 * Remove RTSVR5 local bench junk + unused terrain A/B (not needed to run/ship).
 * Keeps product terrain: quest, kit-lod2, overview fallback, rocks, groundscape.
 *
 *   node RTSVR5/cleanup-local-junk.mjs
 *   node RTSVR5/cleanup-local-junk.mjs --dry
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry');

const KEEP_TERRAIN = new Set([
  'scifi-rts-quest.glb',
  'scifi-rts-kit-lod2.glb',
  'scifi-rts-overview.glb',
  'scifi-rts-rocks.glb',
  'scifi-overview-groundscape.glb',
]);

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
  if (DRY) {
    console.log(`DRY ${bytes} ${p}`);
    return bytes;
  }
  fs.rmSync(p, { recursive: true, force: true });
  console.log(`RM  ${bytes} ${p}`);
  return bytes;
}

let total = 0;

for (const name of fs.readdirSync(ROOT, { withFileTypes: true })) {
  const n = name.name;
  const p = path.join(ROOT, n);
  if (
    /^\.(chrome|iwe)/i.test(n) ||
    /^proof-/i.test(n) ||
    /^bench-/i.test(n) ||
    n === 'export' ||
    n === '_quest-work'
  ) {
    total += rm(p);
    continue;
  }
  if (
    name.isFile() &&
    /\.(png|json|txt|log)$/i.test(n) &&
    /^(proof-|bisect-|sample-xr|decay-|entervr-|chrome-flags)/i.test(n)
  ) {
    total += rm(p);
  }
}

const terrainDir = path.join(ROOT, 'assets', 'terrain');
if (fs.existsSync(terrainDir)) {
  for (const name of fs.readdirSync(terrainDir)) {
    if (KEEP_TERRAIN.has(name)) continue;
    // Keep compress work leftovers out; delete A/B + lod0 + overview catalogs + ue bake
    total += rm(path.join(terrainDir, name));
  }
}

console.log(`${DRY ? 'DRY' : 'DONE'} total ${(total / 1e9).toFixed(2)} GB`);
