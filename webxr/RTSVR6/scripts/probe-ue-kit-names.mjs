#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2);
if (!files.length) {
  files.push(
    'assets/terrain/scifi-rts-kit-lod2.glb',
    'assets/terrain/scifi-rts-overview.glb',
    'assets/terrain/scifi-overview-groundscape.glb',
    'assets/terrain/scifi-rts-rocks.glb'
  );
}

function namesFromGlb(p) {
  const buf = fs.readFileSync(p);
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jlen).toString('utf8').replace(/\0+$/, ''));
  const nodes = (json.nodes || []).map((n) => n.name || '').filter(Boolean);
  const meshes = (json.meshes || []).map((m) => m.name || '').filter(Boolean);
  const counts = new Map();
  for (const n of [...nodes, ...meshes]) {
    const key = n.replace(/_\d+$/, '_*');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return { nodes: nodes.length, meshes: meshes.length, top: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40) };
}

for (const rel of files) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.log(rel, 'MISSING');
    continue;
  }
  const info = namesFromGlb(p);
  console.log('\n==', rel, (fs.statSync(p).size / 1e6).toFixed(1) + 'MB', 'nodes', info.nodes, 'meshes', info.meshes);
  for (const [n, c] of info.top) console.log(String(c).padStart(5), n);
}
