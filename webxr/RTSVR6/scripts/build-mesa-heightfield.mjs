#!/usr/bin/env node
/**
 * Build skirmish terrain the RIGHT way: heightmap mesas + slope-based coloring.
 * Same class of work as the crater plate — not rock-prop decoration.
 *
 *   WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1 node RTSVR6/scripts/build-mesa-heightfield.mjs
 *
 * Outputs:
 *   assets/mesa/skirmish-mesa-height.png   (16-bit-ish preview via 8-bit grey)
 *   assets/mesa/skirmish-mesa-plate.glb    (displaced plate)
 *   merges into assets/terrain/terrain-skirmish-1v1.glb as Moon_0 (keeps Moon_1 + non-mesa props)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MESA = path.join(ROOT, 'assets/mesa');
const LIVE = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');
const BASE =
  fs.existsSync(LIVE + '.pre-mesa.bak')
    ? LIVE + '.pre-mesa.bak'
    : fs.existsSync(LIVE + '.pre-barriers.bak')
      ? LIVE + '.pre-barriers.bak'
      : LIVE;
const WRITE_LIVE =
  process.env.WRITE_LIVE === '1' && process.env.CONFIRM_WRITE_LIVE === '1';
const PORT = Number(process.env.PORT || 8851);
const HALF = 100; // plate ±100 m (MAP_SIZE_STANDARD / 2)
const RES = Number(process.env.RES || 384);
const S = 1 / Math.SQRT2;

fs.mkdirSync(MESA, { recursive: true });

/** Soft value noise */
function hash2(ix, iz) {
  let n = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function smoothNoise(x, z) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(x0, z0);
  const b = hash2(x0 + 1, z0);
  const c = hash2(x0, z0 + 1);
  const d = hash2(x0 + 1, z0 + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, z, oct = 4) {
  let a = 0;
  let amp = 1;
  let f = 1;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    a += smoothNoise(x * f, z * f) * amp;
    n += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return a / n;
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Flat-top mesa: height = H inside inner radius, steep falloff to 0 by outer.
 * Steepness controlled by (outer-inner) band width — narrow = cliff wall.
 */
function mesaBlob(x, z, cx, cz, rx, rz, rot, H, wall = 4.5) {
  const dx = x - cx;
  const dz = z - cz;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const lx = (dx * c + dz * s) / rx;
  const lz = (-dx * s + dz * c) / rz;
  const u = Math.hypot(lx, lz);
  const outer = 1;
  const inner = Math.max(0.15, 1 - wall / Math.max(rx, rz));
  if (u >= outer) return 0;
  if (u <= inner) return H;
  // Steep cliff band
  return H * (1 - smoothstep(inner, outer, u));
}

function spire(x, z, cx, cz, r, H) {
  const u = Math.hypot(x - cx, z - cz) / r;
  if (u >= 1) return 0;
  return H * Math.pow(1 - u, 1.65);
}

/** Soft desert floor only — landforms come from Megascans canyon meshes. */
function heightSeed(x, z) {
  let h = (fbm(x * 0.035, z * 0.035, 5) - 0.5) * 1.1;
  h += (fbm(x * 0.12, z * 0.12, 3) - 0.5) * 0.35;
  return h;
}

function heightAt(x, z) {
  // Circular playable disk — soft rim falloff outside
  const r = Math.hypot(x, z);
  const disk = 1 - smoothstep(HALF * 0.92, HALF * 1.02, r);
  const h0 = heightSeed(x, z);
  const h1 = heightSeed(-x, -z); // 180° rotational symmetry
  let h = Math.max(h0, h1) * disk;

  // Keep open mid + cardinal flanks low (navigable)
  const mid = 1 - smoothstep(28, 36, r);
  h *= 1 - mid * 0.92;
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax < 14 && az > 30) h *= 0.08 + 0.92 * smoothstep(14, 22, ax);
  if (az < 14 && ax > 30) h *= 0.08 + 0.92 * smoothstep(14, 22, az);

  // Corner pads near rim diagonals — flatten for bases
  for (const [cx, cz] of [
    [S * 78, S * 78],
    [-S * 78, S * 78],
    [S * 78, -S * 78],
    [-S * 78, -S * 78],
  ]) {
    const d = Math.hypot(x - cx, z - cz);
    if (d < 18) h *= smoothstep(10, 18, d);
  }

  return Math.max(0, h);
}

// Build height grid + preview PNG
const grid = new Float32Array(RES * RES);
let hMin = Infinity;
let hMax = -Infinity;
for (let iz = 0; iz < RES; iz++) {
  for (let ix = 0; ix < RES; ix++) {
    const x = -HALF + (ix / (RES - 1)) * HALF * 2;
    const z = -HALF + (iz / (RES - 1)) * HALF * 2;
    const h = heightAt(x, z);
    grid[iz * RES + ix] = h;
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
}
console.log('height range', hMin.toFixed(2), hMax.toFixed(2));

// 8-bit preview PNG (simple grayscale via uncompressed BMP-ish → use raw pgm)
const pgm = Buffer.alloc(RES * RES);
for (let i = 0; i < grid.length; i++) {
  const t = hMax > hMin ? (grid[i] - hMin) / (hMax - hMin) : 0;
  pgm[i] = Math.max(0, Math.min(255, Math.round(t * 255)));
}
const pgmPath = path.join(MESA, 'skirmish-mesa-height.pgm');
fs.writeFileSync(
  pgmPath,
  Buffer.concat([Buffer.from(`P5\n${RES} ${RES}\n255\n`), pgm])
);
console.log('wrote', pgmPath);

// Persist height function samples for the browser builder
const samplesPath = path.join(MESA, 'skirmish-mesa-height.bin');
fs.writeFileSync(samplesPath, Buffer.from(grid.buffer));
fs.writeFileSync(
  path.join(MESA, 'skirmish-mesa-height.json'),
  JSON.stringify({ res: RES, half: HALF, hMin, hMax, samples: 'skirmish-mesa-height.bin' })
);

const groundTex = path.join(
  MESA,
  'textures_rocky_terrain_02/rocky_terrain_02_Diffuse_1k.jpg'
);
const groundNor = path.join(
  MESA,
  'textures_rocky_terrain_02/rocky_terrain_02_nor_gl_1k.jpg'
);

const pageHtml = `<!doctype html><html><body>
<script type="importmap">{"imports":{
  "three":"https://cdn.jsdelivr.net/npm/three@0.173.0/build/three.module.js",
  "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.173.0/examples/jsm/"
}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
window.THREE = THREE;
window.GLTFExporter = GLTFExporter;
window.__ready = true;
</script></body></html>`;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.bin': 'application/octet-stream',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(pageHtml);
    return;
  }
  const fp = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end();
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
page.on('pageerror', (e) => console.error('pageerror', e));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 120000 });
await page.waitForFunction(() => window.__ready === true);

const exported = await page.evaluate(
  async ({ res, half, hMin, hMax, hasTex }) => {
    const THREE = window.THREE;
    const meta = await (await fetch('/assets/mesa/skirmish-mesa-height.json')).json();
    const ab = await (await fetch('/assets/mesa/' + meta.samples)).arrayBuffer();
    const grid = new Float32Array(ab);

    const geo = new THREE.PlaneGeometry(half * 2, half * 2, res - 1, res - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const uvs = geo.attributes.uv;

    // World-XZ UV for tiled ground
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const ix = Math.round(((x + half) / (half * 2)) * (res - 1));
      const iz = Math.round(((z + half) / (half * 2)) * (res - 1));
      const h = grid[iz * res + ix] || 0;
      pos.setY(i, h);
      uvs.setXY(i, (x + half) / 40, (z + half) / 40); // tile ~40m
    }
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;

    // Slope + height material blend → vertex color (reference look)
    // floor grey, steep dark charcoal streaks, flat tops rusty red
    // Floor only — Megascans canyon meshes carry the landform look.
    // Do NOT paint solid red caps (that was the fake "debug" look).
    const floor = new THREE.Color(0x8a7a68);
    const steep = new THREE.Color(0x3a322c);
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const ny = Math.abs(nrm.getY(i));
      const h = pos.getY(i);
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const rd = Math.hypot(x, z);
      if (rd > half * 0.98) {
        colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 0.02;
        continue;
      }
      const slope = 1 - ny;
      const steepW = Math.max(0, Math.min(1, (slope - 0.2) / 0.55));
      tmp.copy(floor);
      const mott = 0.9 + 0.18 * ((Math.sin(x * 0.31) * Math.cos(z * 0.27) + 1) * 0.5);
      tmp.multiplyScalar(mott);
      tmp.lerp(steep, steepW * 0.65);
      if (h < 1.2) tmp.multiplyScalar(0.92 + h * 0.05);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    let map = null;
    let nor = null;
    if (hasTex) {
      const loader = new THREE.TextureLoader();
      map = await loader.loadAsync('/assets/mesa/textures_rocky_terrain_02/rocky_terrain_02_Diffuse_1k.jpg');
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.colorSpace = THREE.SRGBColorSpace;
      nor = await loader.loadAsync('/assets/mesa/textures_rocky_terrain_02/rocky_terrain_02_nor_gl_1k.jpg');
      nor.wrapS = nor.wrapT = THREE.RepeatWrapping;
    }

    const mat = new THREE.MeshStandardMaterial({
      map,
      normalMap: nor,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
      flatShading: false,
    });
    // Multiply texture with vertex colors (default) for slope tint over albedo
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Moon_0';
    mesh.castShadow = false;
    mesh.receiveShadow = true;

    const root = new THREE.Group();
    root.name = 'mesa-plate';
    root.add(mesh);

    const exporter = new window.GLTFExporter();
    const abOut = await new Promise((resolve, reject) => {
      exporter.parse(root, resolve, reject, { binary: true, onlyVisible: true });
    });
    const bytes = new Uint8Array(abOut);
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { b64: btoa(s), verts: pos.count };
  },
  {
    res: RES,
    half: HALF,
    hMin,
    hMax,
    hasTex: false, // vertex-color slope blend only — rocky_terrain_02 reads green/lichen, wrong for ref
  }
);

await browser.close();
server.close();

const plateBuf = Buffer.from(exported.b64, 'base64');
const platePath = path.join(MESA, 'skirmish-mesa-plate.glb');
fs.writeFileSync(platePath, plateBuf);
console.log('wrote', platePath, plateBuf.length, 'verts', exported.verts);

// ---- Merge: replace Moon_0 mesh in live GLB, strip Prop_Mesa_* ----
function parseGlb(buf) {
  const jlen = buf.readUInt32LE(12);
  let t = buf
    .slice(20, 20 + jlen)
    .toString('utf8')
    .replace(/:\s*-?inf\b/gi, ':null')
    .replace(/:\s*nan\b/gi, ':null');
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

console.log('merge base', BASE);
const live = parseGlb(fs.readFileSync(BASE));
const plate = parseGlb(plateBuf);

// Remove ALL kit scenery + legacy Moon clones. Mesa plate is the whole look
// (heightmap + slope vertex colors) — leftover Prop_Rock/Cliff read as a fake crater rim.
{
  const drop = new Set();
  for (let i = 0; i < live.json.nodes.length; i++) {
    const n = live.json.nodes[i]?.name || '';
    if (/^Prop_/i.test(n)) drop.add(i);
    if (/^(?:SM_)?(?:Rock|Cliff|Dirt|Mineral|Bridge)/i.test(n)) drop.add(i);
    if (/Prop_Mesa_|_Barrier_|ValleyCliff_/i.test(n)) drop.add(i);
    if (/^Moon_/i.test(n) && !/^Moon_0$/i.test(n)) drop.add(i);
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
    const sc = live.json.scenes[live.json.scene ?? 0];
    sc.nodes = (sc.nodes || []).map((i) => map.get(i)).filter((i) => i != null);
    for (const n of live.json.nodes) {
      if (n.children) n.children = n.children.map((c) => map.get(c)).filter((c) => c != null);
    }
    console.log('stripped scenery/moon clones', drop.size);
  }
}

function append(key, arr) {
  live.json[key] = live.json[key] || [];
  const base = live.json[key].length;
  for (const item of arr || []) live.json[key].push(JSON.parse(JSON.stringify(item)));
  return base;
}

const bv0 = append('bufferViews', plate.json.bufferViews);
const acc0 = append('accessors', plate.json.accessors);
const img0 = append('images', plate.json.images);
const samp0 = append('samplers', plate.json.samplers);
const tex0 = append('textures', plate.json.textures);
const mat0 = append('materials', plate.json.materials);
const mesh0 = append('meshes', plate.json.meshes);

const liveBinLen = live.bin.length;
const pad = (4 - (liveBinLen % 4)) % 4;
const plateStart = liveBinLen + pad;
const newBin = Buffer.concat([live.bin, Buffer.alloc(pad), plate.bin]);

for (let i = bv0; i < live.json.bufferViews.length; i++) {
  const bv = live.json.bufferViews[i];
  bv.buffer = 0;
  bv.byteOffset = (bv.byteOffset || 0) + plateStart;
}
for (let i = acc0; i < live.json.accessors.length; i++) {
  const a = live.json.accessors[i];
  if (a.bufferView != null) a.bufferView += bv0;
}
for (let i = img0; i < live.json.images.length; i++) {
  const im = live.json.images[i];
  if (im.bufferView != null) im.bufferView += bv0;
}
for (let i = tex0; i < live.json.textures.length; i++) {
  const t = live.json.textures[i];
  if (t.source != null) t.source += img0;
  if (t.sampler != null) t.sampler += samp0;
}
for (let i = mat0; i < live.json.materials.length; i++) {
  const m = live.json.materials[i];
  const pbr = m.pbrMetallicRoughness;
  if (pbr?.baseColorTexture?.index != null) pbr.baseColorTexture.index += tex0;
  if (pbr?.metallicRoughnessTexture?.index != null) pbr.metallicRoughnessTexture.index += tex0;
  if (m.normalTexture?.index != null) m.normalTexture.index += tex0;
}
for (let i = mesh0; i < live.json.meshes.length; i++) {
  const mesh = live.json.meshes[i];
  for (const prim of mesh.primitives || []) {
    if (prim.indices != null) prim.indices += acc0;
    if (prim.material != null) prim.material += mat0;
    if (prim.attributes) {
      for (const k of Object.keys(prim.attributes)) prim.attributes[k] += acc0;
    }
  }
}

// Retarget Moon_0 node to new mesh; hide/remove old moon mesh index usage
let moonNode = live.json.nodes.find((n) => /^Moon_0$/i.test(n.name || ''));
if (!moonNode) {
  moonNode = { name: 'Moon_0' };
  live.json.nodes.push(moonNode);
  live.json.scenes[live.json.scene ?? 0].nodes.push(live.json.nodes.length - 1);
}
// Plate exporter mesh is index 0 in plate → mesh0 in live
moonNode.mesh = mesh0;
delete moonNode.translation;
delete moonNode.rotation;
moonNode.scale = [1, 1, 1];
moonNode.name = 'Moon_0';

live.json.extras = live.json.extras || {};
live.json.extras.rtsMesaHeightfield = {
  res: RES,
  half: HALF,
  hMin,
  hMax,
  method: 'heightmap+slope-vertex-colors',
};

const outPath = WRITE_LIVE ? LIVE : path.join(MESA, 'terrain-skirmish-1v1.heightfield.glb');
if (WRITE_LIVE && !fs.existsSync(LIVE + '.pre-heightfield.bak')) {
  if (fs.existsSync(LIVE)) fs.copyFileSync(LIVE, LIVE + '.pre-heightfield.bak');
}
const outBuf = writeGlb(live.json, newBin);
fs.writeFileSync(outPath, outBuf);
console.log('wrote', outPath, outBuf.length);
if (!WRITE_LIVE) console.log('Dry-run OK — re-run with WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1');
