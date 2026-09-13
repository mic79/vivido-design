#!/usr/bin/env node
/**
 * Build circular 180°-symmetric Namaqualand mesa layout and merge into
 * terrain-skirmish-1v1.glb (replaces Prop_*_Barrier_*).
 *
 * Assets: RTSVR6/assets/mesa/*_web.glb (Poly Haven CC0, simplified).
 *
 *   WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1 node RTSVR6/scripts/build-mesa-skirmish.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MESA = path.join(ROOT, 'assets/mesa');
const LIVE = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');
const BAK = LIVE + '.pre-mesa.bak';
const PRE_BARRIER = LIVE + '.pre-barriers.bak';
const OUT_MESA = path.join(MESA, 'mesa-skirmish-props.glb');
const PLACEMENTS = path.join(ROOT, 'export/skirmish-1v1-mesa-placements.json');
const WRITE_LIVE =
  process.env.WRITE_LIVE === '1' && process.env.CONFIRM_WRITE_LIVE === '1';
const PORT = Number(process.env.PORT || 8844);
const S = 1 / Math.SQRT2;

const CLEAR = {
  midR: 34,
  flankHalfW: 15,
  flankMinAbs: 32,
  padR: 16, // keep NE/NW/SE/SW approach pads open
};

function tooClosePads(x, z) {
  const r = Math.hypot(x, z);
  if (r < CLEAR.midR) return 'mid';
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax < CLEAR.flankHalfW && az > CLEAR.flankMinAbs) return 'flankNS';
  if (az < CLEAR.flankHalfW && ax > CLEAR.flankMinAbs) return 'flankEW';
  // Corner approach pads near rim of plate (~70–95 along diagonal)
  const corners = [
    [S, S],
    [-S, S],
    [S, -S],
    [-S, -S],
  ];
  for (const [cx, cz] of corners) {
    const px = cx * 78;
    const pz = cz * 78;
    if ((x - px) ** 2 + (z - pz) ** 2 < CLEAR.padR ** 2) return 'pad';
  }
  return null;
}

/** Seed half (NE+NW arms); full = seed ∪ 180° rotate. Varied per-arm so rotate keeps surprise. */
function seedHalf() {
  const out = [];
  const step = 9;
  const t0 = 38;
  const t1 = 90;
  const rowOff = 7.5;
  const yawA = Math.PI * 0.25 + Math.PI * 0.5;
  const yawB = -Math.PI * 0.25 + Math.PI * 0.5;
  const perpA = [-S, S];
  const perpB = [S, S];

  // NE–SW diagonal arm (positive NE): continuous mesa wall, double row
  let i = 0;
  for (let t = t0; t <= t1 + 0.01; t += step) {
    for (const side of [-1, 1]) {
      const mesh = i % 3 === 0 ? 'cliff_02' : 'cliff_01';
      const sx = 1.15 + (i % 4) * 0.08;
      const sy = 1.35 + (i % 3) * 0.15; // taller walls
      const sz = 1.05 + (i % 5) * 0.06;
      out.push({
        mesh,
        x: S * t + perpA[0] * rowOff * side,
        y: 0,
        z: S * t + perpA[1] * rowOff * side,
        yaw: yawA + side * 0.12 + (i % 5) * 0.04,
        scale: [sx * 2.4, sy * 2.6, sz * 2.4],
        role: 'mesa',
      });
      i++;
    }
  }

  // NW–SE diagonal arm (positive NW)
  for (let t = t0; t <= t1 + 0.01; t += step) {
    for (const side of [-1, 1]) {
      const mesh = i % 2 === 0 ? 'cliff_01' : 'cliff_02';
      const sx = 1.1 + (i % 3) * 0.1;
      const sy = 1.25 + (i % 4) * 0.12;
      const sz = 1.0 + (i % 4) * 0.08;
      out.push({
        mesh,
        x: -S * t + perpB[0] * rowOff * side,
        y: 0,
        z: S * t + perpB[1] * rowOff * side,
        yaw: yawB - side * 0.1 + (i % 4) * 0.05,
        scale: [sx * 2.3, sy * 2.5, sz * 2.3],
        role: 'mesa',
      });
      i++;
    }
  }

  // Unique scree only on one half (180° rotate duplicates for balance)
  const scree = [
    { mesh: 'boulder', x: 52, z: 28, yaw: 0.4, scale: [1.8, 1.6, 1.8] },
    { mesh: 'rocks', x: 61, z: 44, yaw: 1.1, scale: [2.2, 1.4, 2.0] },
    { mesh: 'boulder', x: -48, z: 55, yaw: -0.7, scale: [1.5, 1.7, 1.5] },
    { mesh: 'rocks', x: 35, z: 62, yaw: 0.2, scale: [1.9, 1.3, 1.7] },
    { mesh: 'boulder', x: -58, z: 38, yaw: 1.4, scale: [2.0, 1.5, 1.9] },
  ];
  for (const s of scree) out.push({ ...s, y: 0, role: 'scree' });

  return out.filter((p) => !tooClosePads(p.x, p.z));
}

function rotate180(p) {
  return {
    ...p,
    x: -p.x,
    z: -p.z,
    yaw: p.yaw + Math.PI,
  };
}

const seed = seedHalf();
const placements = [];
const seen = new Set();
for (const p of seed) {
  for (const q of [p, rotate180(p)]) {
    if (tooClosePads(q.x, q.z)) continue;
    const key = `${q.mesh}@${q.x.toFixed(1)},${q.z.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    placements.push(q);
  }
}

fs.mkdirSync(path.dirname(PLACEMENTS), { recursive: true });
fs.writeFileSync(
  PLACEMENTS,
  JSON.stringify(
    {
      layout: 'circular-x-mesa-namaqualand',
      symmetry: '180-rotational',
      license: 'Poly Haven models CC0 — see assets/mesa/LICENSE.txt',
      clearance: CLEAR,
      count: placements.length,
      placements,
    },
    null,
    2
  ) + '\n'
);
console.log('placements', placements.length, 'roles', {
  mesa: placements.filter((p) => p.role === 'mesa').length,
  scree: placements.filter((p) => p.role === 'scree').length,
});

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json',
};

const pageHtml = `<!doctype html><html><body>
<script type="importmap">{"imports":{
  "three":"https://cdn.jsdelivr.net/npm/three@0.173.0/build/three.module.js",
  "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.173.0/examples/jsm/"
}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
window.THREE = THREE;
window.GLTFLoader = GLTFLoader;
window.GLTFExporter = GLTFExporter;
window.MeshoptDecoder = MeshoptDecoder;
window.__bakeReady = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(pageHtml);
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end('missing');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('console', (m) => console.log('page', m.type(), m.text()));
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => window.__bakeReady === true);

const exported = await page.evaluate(async ({ placements, urls }) => {
  const THREE = window.THREE;
  const loader = new window.GLTFLoader();
  if (window.MeshoptDecoder) loader.setMeshoptDecoder(window.MeshoptDecoder);
  const templates = {};
  for (const [key, url] of Object.entries(urls)) {
    const gltf = await loader.loadAsync(url);
    templates[key] = gltf.scene;
  }
  const root = new THREE.Group();
  root.name = 'rts-mesa-props';
  let n = 0;
  for (const p of placements) {
    const tpl = templates[p.mesh];
    if (!tpl) continue;
    const clone = tpl.clone(true);
    clone.name = `Prop_Mesa_${p.mesh}_${n}`;
    clone.position.set(p.x, p.y || 0, p.z);
    clone.rotation.y = p.yaw || 0;
    if (Array.isArray(p.scale)) clone.scale.set(p.scale[0], p.scale[1], p.scale[2]);
    else clone.scale.setScalar(p.scale || 1);
    clone.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      o.name = clone.name;
      // Warm mesa tint toward reference red-top / dark face read (subtle multiply).
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || !m.color) continue;
        m.color.multiply(new THREE.Color(1.15, 0.78, 0.62));
        m.needsUpdate = true;
      }
    });
    root.add(clone);
    n++;
  }
  const exporter = new window.GLTFExporter();
  const ab = await new Promise((resolve, reject) => {
    exporter.parse(
      root,
      (res) => resolve(res),
      (err) => reject(err),
      { binary: true, onlyVisible: true }
    );
  });
  const bytes = new Uint8Array(ab);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return { b64: btoa(s), count: n };
}, {
  placements,
  urls: {
    cliff_01: '/assets/mesa/cliff_01_web.glb',
    cliff_02: '/assets/mesa/cliff_02_web.glb',
    rocks: '/assets/mesa/rocks_01_web.glb',
    boulder: '/assets/mesa/boulder_03_web.glb',
  },
});

await browser.close();
server.close();

const mesaBuf = Buffer.from(exported.b64, 'base64');
fs.writeFileSync(OUT_MESA, mesaBuf);
console.log('wrote', OUT_MESA, mesaBuf.length, 'props', exported.count);

// ---- merge into live skirmish GLB ----
function parseGlb(buf) {
  const jlen = buf.readUInt32LE(12);
  let t = buf.slice(20, 20 + jlen).toString('utf8').replace(/:\s*-?inf\b/gi, ':null').replace(/:\s*nan\b/gi, ':null');
  const json = JSON.parse(t);
  const binOff = 20 + jlen;
  const binLen = buf.readUInt32LE(binOff);
  const bin = Buffer.from(buf.subarray(binOff + 8, binOff + 8 + binLen));
  return { json, bin };
}
function writeGlb(json, bin) {
  json.buffers = [{ byteLength: bin.length }];
  const jb = Buffer.from(JSON.stringify(json));
  const jp = (4 - (jb.length % 4)) % 4;
  const bp = (4 - (bin.length % 4)) % 4;
  const jc = jb.length + jp;
  const bc = bin.length + bp;
  const out = Buffer.alloc(12 + 8 + jc + 8 + bc);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jc, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jb.copy(out, 20);
  out.fill(0x20, 20 + jb.length, 20 + jc);
  const o = 20 + jc;
  out.writeUInt32LE(bc, o);
  out.writeUInt32LE(0x004e4942, o + 4);
  bin.copy(out, o + 8);
  return out;
}

const basePath = fs.existsSync(PRE_BARRIER) ? PRE_BARRIER : LIVE;
console.log('merge base', basePath);
const live = parseGlb(fs.readFileSync(basePath));
const mesa = parseGlb(mesaBuf);

// Drop prior barriers / mesa props from base
const drop = new Set();
for (let i = 0; i < live.json.nodes.length; i++) {
  const name = live.json.nodes[i]?.name || '';
  if (/_Barrier_|Prop_Mesa_|ValleyCliff_/i.test(name)) drop.add(i);
}
if (drop.size) {
  const keep = [];
  const map = new Map();
  let ni = 0;
  for (let i = 0; i < live.json.nodes.length; i++) {
    if (drop.has(i)) continue;
    map.set(i, ni++);
    keep.push(live.json.nodes[i]);
  }
  live.json.nodes = keep;
  const scene = live.json.scenes[live.json.scene ?? 0];
  scene.nodes = (scene.nodes || []).map((i) => map.get(i)).filter((i) => i != null);
  for (const n of live.json.nodes) {
    if (n.children) n.children = n.children.map((i) => map.get(i)).filter((i) => i != null);
  }
  console.log('removed old barrier/mesa nodes', drop.size);
}

// Append mesa buffers/meshes/materials/textures/images/accessors/bufferViews
function appendArray(dstKey, srcArr) {
  live.json[dstKey] = live.json[dstKey] || [];
  const base = live.json[dstKey].length;
  for (const item of srcArr || []) live.json[dstKey].push(JSON.parse(JSON.stringify(item)));
  return base;
}
const bvBase = appendArray('bufferViews', mesa.json.bufferViews);
const accBase = appendArray('accessors', mesa.json.accessors);
const imgBase = appendArray('images', mesa.json.images);
const sampBase = appendArray('samplers', mesa.json.samplers);
const texBase = appendArray('textures', mesa.json.textures);
const matBase = appendArray('materials', mesa.json.materials);
const meshBase = appendArray('meshes', mesa.json.meshes);

// Fix indices inside appended objects
for (let i = bvBase; i < live.json.bufferViews.length; i++) {
  const bv = live.json.bufferViews[i];
  // will rewrite byteOffset after bin concat — mark relative to mesa bin first
  bv._mesa = true;
}
for (let i = accBase; i < live.json.accessors.length; i++) {
  const a = live.json.accessors[i];
  if (a.bufferView != null) a.bufferView += bvBase;
}
for (let i = imgBase; i < live.json.images.length; i++) {
  const im = live.json.images[i];
  if (im.bufferView != null) im.bufferView += bvBase;
}
for (let i = texBase; i < live.json.textures.length; i++) {
  const t = live.json.textures[i];
  if (t.source != null) t.source += imgBase;
  if (t.sampler != null) t.sampler += sampBase;
}
for (let i = matBase; i < live.json.materials.length; i++) {
  const m = live.json.materials[i];
  const pbr = m.pbrMetallicRoughness;
  if (pbr?.baseColorTexture?.index != null) pbr.baseColorTexture.index += texBase;
  if (pbr?.metallicRoughnessTexture?.index != null) pbr.metallicRoughnessTexture.index += texBase;
  if (m.normalTexture?.index != null) m.normalTexture.index += texBase;
  if (m.occlusionTexture?.index != null) m.occlusionTexture.index += texBase;
  if (m.emissiveTexture?.index != null) m.emissiveTexture.index += texBase;
}
for (let i = meshBase; i < live.json.meshes.length; i++) {
  const mesh = live.json.meshes[i];
  for (const prim of mesh.primitives || []) {
    if (prim.indices != null) prim.indices += accBase;
    if (prim.material != null) prim.material += matBase;
    if (prim.attributes) {
      for (const k of Object.keys(prim.attributes)) prim.attributes[k] += accBase;
    }
  }
}

// Concatenate binary: live + mesa, fix mesa bufferViews
const liveBinLen = live.bin.length;
const pad = (4 - (liveBinLen % 4)) % 4;
const mesaBinStart = liveBinLen + pad;
const newBin = Buffer.concat([live.bin, Buffer.alloc(pad), mesa.bin]);
for (let i = bvBase; i < live.json.bufferViews.length; i++) {
  const bv = live.json.bufferViews[i];
  bv.buffer = 0;
  bv.byteOffset = (bv.byteOffset || 0) + mesaBinStart;
  delete bv._mesa;
}

// Append mesa nodes (flatten: each mesh-bearing node)
const scene = live.json.scenes[live.json.scene ?? 0];
scene.nodes = scene.nodes || [];
const nodeBase = live.json.nodes.length;
function remapNode(n) {
  const nn = JSON.parse(JSON.stringify(n));
  if (nn.mesh != null) nn.mesh += meshBase;
  if (nn.children) {
    // children remapped after all nodes pushed — handle flat exporter first
  }
  return nn;
}

// GLTFExporter usually creates a root + children. Remap recursively.
const mesaNodes = mesa.json.nodes || [];
const mesaNodeBase = live.json.nodes.length;
for (const n of mesaNodes) {
  const nn = remapNode(n);
  live.json.nodes.push(nn);
}
for (let i = 0; i < mesaNodes.length; i++) {
  const nn = live.json.nodes[mesaNodeBase + i];
  if (nn.children) {
    nn.children = nn.children.map((c) => c + mesaNodeBase);
  }
}
// Add mesa scene roots
for (const r of mesa.json.scenes?.[0]?.nodes || [0]) {
  scene.nodes.push(mesaNodeBase + r);
}

live.json.extras = live.json.extras || {};
live.json.extras.rtsMesaLayout = {
  count: exported.count,
  license: 'Poly Haven CC0',
  layout: 'circular-x-mesa-namaqualand',
};

const outPath = WRITE_LIVE ? LIVE : path.join(MESA, 'terrain-skirmish-1v1.mesa-merged.glb');
if (WRITE_LIVE) {
  if (!fs.existsSync(BAK)) {
    fs.copyFileSync(LIVE, BAK);
    console.log('bak', BAK);
  }
}
const outBuf = writeGlb(live.json, newBin);
fs.writeFileSync(outPath, outBuf);
console.log('wrote', outPath, outBuf.length);
if (!WRITE_LIVE) console.log('Dry-run. Re-run with WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1');
