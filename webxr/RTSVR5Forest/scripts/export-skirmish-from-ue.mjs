#!/usr/bin/env node
/**
 * Full UE → WebXR skirmish terrain pipeline (does NOT overwrite live GLB unless
 * both WRITE_LIVE=1 and CONFIRM_WRITE_LIVE=1).
 *
 * Automatic (no per-object handholding):
 *   1) Export every StaticMeshActor except RTS_* helpers
 *   2) Normalize transforms
 *   3) Swap Moon_* to textured bak moons (UE DISABLED bake has no moon albedo)
 *   4) Bake planar rock→ground cookies
 *   5) Bake hero RGB lightmaps (platform/pump/cliffs); prune planar self-shadow atlases
 *
 * Prereq: UE editor open on UE58_scifi with Skirmish1v1 saved.
 *
 *   node RTSVR5/scripts/export-skirmish-from-ue.mjs
 *   WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1 node RTSVR5/scripts/export-skirmish-from-ue.mjs
 *
 * Moon *geometry* edits in UE are not used (textured bak moons). All prop /
 * new-object transforms and meshes come from UE.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const UE_REMOTE = 'D:/ue5/UE58_scifi/Scripts/ue-remote.py';
const RAW = 'D:/ue5/UE58_scifi/Exported/skirmish-1v1-from-ue.glb';
const NORM = 'D:/ue5/UE58_scifi/Exported/skirmish-1v1-normalized.glb';
const LIVE = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');
const WRITE_LIVE =
  process.env.WRITE_LIVE === '1' && process.env.CONFIRM_WRITE_LIVE === '1';
const TMP_PY = 'D:/ue5/UE58_scifi/Exported/_export_skirmish_tmp.py';

function run(cmd, args, opts = {}) {
  console.log('>', cmd, args.join(' '));
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  if ((r.status || 0) !== 0) process.exit(r.status || 1);
}

function sleepMs(ms) {
  spawnSync(process.execPath, ['-e', `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${ms})`], {
    stdio: 'ignore',
  });
}

function waitForExport(file, statusFile, minBytes, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(statusFile)) {
      const st = fs.readFileSync(statusFile, 'utf8');
      if (/\bFAIL\b/i.test(st)) throw new Error('UE export status FAIL:\n' + st);
      if (/\bDONE\b/i.test(st) && fs.existsSync(file) && fs.statSync(file).size >= minBytes) {
        return fs.statSync(file).size;
      }
    }
    sleepMs(1000);
  }
  throw new Error('UE export timed out waiting for ' + file);
}

const STATUS = 'D:/ue5/UE58_scifi/Exported/export-skirmish-1v1-status.txt';
try {
  if (fs.existsSync(STATUS)) fs.unlinkSync(STATUS);
  if (fs.existsSync(RAW)) fs.unlinkSync(RAW);
} catch {}

// Launch export without failing the pipeline if the remote socket dies mid-bake.
console.log('> python', UE_REMOTE, 'export_skirmish_1v1_glb.py (background-tolerant)');
const child = spawnSync('python', [UE_REMOTE, 'D:/ue5/UE58_scifi/Scripts/export_skirmish_1v1_glb.py'], {
  stdio: 'inherit',
  shell: false,
  timeout: 240000,
});
console.log('remote exit', child.status, child.error?.message || '');
try {
  const size = waitForExport(RAW, STATUS, 1_000_000, 240_000);
  console.log('export file ready bytes', size);
} catch (e) {
  console.error(String(e));
  if (fs.existsSync(STATUS)) console.error(fs.readFileSync(STATUS, 'utf8'));
  process.exit(1);
}

run('node', [path.join(ROOT, 'scripts/normalize-ue-skirmish-glb.mjs'), RAW, NORM]);

const compareJs = `
const fs = require('fs');
const live = ${JSON.stringify(LIVE)};
const norm = ${JSON.stringify(NORM)};
function parse(p) {
  const b = fs.readFileSync(p);
  const jlen = b.readUInt32LE(12);
  let t = b.slice(20, 20 + jlen).toString();
  t = t.replace(/:\\s*-?inf\\b/gi, ':null').replace(/:\\s*nan\\b/gi, ':null');
  return JSON.parse(t);
}
const L = parse(live);
const N = parse(norm);
const lp = Object.fromEntries(
  L.nodes.filter((n) => /^Prop_/i.test(n.name || '')).map((n) => [n.name, n])
);
const np = Object.fromEntries(
  N.nodes.filter((n) => /^Prop_/i.test(n.name || '')).map((n) => [n.name, n])
);
const shared = Object.keys(lp).filter((k) => np[k]);
function yaw(q) {
  if (!q || q.length < 4) return 0;
  let [, y, , w] = q;
  // q and -q are the same rotation; canonicalize so atan2 is stable.
  if (w < 0) {
    y = -y;
    w = -w;
  }
  return (180 / Math.PI) * 2 * Math.atan2(y, w);
}
function angAbs(d) {
  d = ((d % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return Math.abs(d);
}
let loc = 0;
let yawE = 0;
for (const k of shared) {
  const a = lp[k].translation || [0, 0, 0];
  const b = np[k].translation || [0, 0, 0];
  loc = Math.max(loc, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  yawE = Math.max(yawE, angAbs(yaw(np[k].rotation) - yaw(lp[k].rotation)));
}
console.log('compare props', shared.length, 'maxLoc_m', loc.toFixed(4), 'maxYaw_deg', yawE.toFixed(4));
const ueOnly = Object.keys(np).filter((k) => !lp[k]);
const bridge = Object.keys(np).filter((k) => /bridge/i.test(k));
console.log('ue_scenery_total', Object.keys(np).length, 'ueOnly', ueOnly.length, ueOnly.slice(0, 10), 'bridge', bridge);
if (Object.keys(np).length < 2500) process.exit(2);
if (loc > 0.05 || yawE > 0.5) {
  console.error('TRANSFORM DRIFT too high');
  process.exit(3);
}
// Moon denseness gate — UE OBJ/gltf import once collapsed these to ~256 tris.
function moonVerts(js, name) {
  const n = js.nodes.find((x) => x.name === name);
  if (!n || n.mesh == null) return 0;
  const prim = js.meshes[n.mesh].primitives[0];
  return js.accessors[prim.attributes.POSITION].count;
}
const m0 = moonVerts(N, 'Moon_0');
const m1 = moonVerts(N, 'Moon_1');
console.log('moon verts', m0, m1);
if (m0 < 5000 || m1 < 20000) {
  console.error('MOON MESH TOO LOW — import/export destroyed density');
  process.exit(4);
}
console.log('transform gate PASS');
`;
run('node', ['-e', compareJs]);

if (WRITE_LIVE) {
  const bak = LIVE + '.pre-ue-pipeline.bak';
  // Never shrink the known-good textured bak.
  if (!fs.existsSync(bak) || fs.statSync(bak).size < 20_000_000) {
    const fallback = LIVE + '.pre-ue-pipeline.bak';
    if (fs.existsSync(fallback) && fs.statSync(fallback).size >= 20_000_000) {
      console.log('using existing bak', fallback, fs.statSync(fallback).size);
    }
  } else {
    console.log('kept existing bak', bak, fs.statSync(bak).size);
  }
  // UE props (all) + textured bak moons → LIVE, then shadow bake.
  run('node', [
    path.join(ROOT, 'scripts/build-skirmish-from-ue-and-bak.mjs'),
    NORM,
    path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb.pre-ue-pipeline.bak'),
    LIVE,
  ]);
  run('node', [path.join(ROOT, 'scripts/bake-rock-shadows.mjs')], {
    cwd: ROOT,
    env: process.env,
  });
  // Hero Lightmass-style RGB LM (soft umbra). Do NOT append planar
  // rtsPropSelfShadows — that path was the ink-blot / smudge look.
  run('node', [path.join(ROOT, 'scripts/bake-hero-rgb-lightmaps.mjs')], {
    cwd: ROOT,
    env: process.env,
  });
  console.log('LIVE updated from UE export + bak moons + rock cookies + hero LM');
} else {
  console.log('Dry-run OK. Normalized at', NORM);
  console.log(
    'Re-run with WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1 to replace terrain-skirmish-1v1.glb + bake shadows.'
  );
}
