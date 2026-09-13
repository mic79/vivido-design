#!/usr/bin/env node
/**
 * Build skirmish terrain FROM the user heightmap + color top-down.
 * Geometry = grayscale heightmap. Albedo = colored top-down (slope-tinted).
 *
 *   WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1 node RTSVR6/scripts/build-from-heightmap.mjs
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
    : LIVE;
const HM = path.join(MESA, 'ref-heightmap.png');
const COL = path.join(MESA, 'ref-topdown.jpg');
const WRITE_LIVE =
  process.env.WRITE_LIVE === '1' && process.env.CONFIRM_WRITE_LIVE === '1';
const PORT = Number(process.env.PORT || 8861);
const HALF = 100;
const RES = Number(process.env.RES || 384);
const H_SCALE = Number(process.env.H_SCALE || 16); // meters black→white

if (!fs.existsSync(HM) || !fs.existsSync(COL)) {
  console.error('missing refs', HM, COL);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  // Map /assets/mesa/* → MESA
  let fp;
  if (rel.startsWith('/assets/mesa/')) {
    fp = path.join(MESA, rel.slice('/assets/mesa/'.length));
  } else {
    fp = path.normalize(path.join(ROOT, rel));
  }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.goto('https://unpkg.com/three@0.167.1/examples/jsm/libs/empty', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
}).catch(() => {});
// Load three via page.addScriptTag from CDN
await page.setContent(`<!DOCTYPE html><html><body>
<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.167.1/build/three.module.js","three/addons/":"https://unpkg.com/three@0.167.1/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
window.THREE = THREE;
window.GLTFExporter = GLTFExporter;
window.__ready = true;
</script></body></html>`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });

const exported = await page.evaluate(
  async ({ res, half, hScale, hmUrl, colUrl }) => {
    const THREE = window.THREE;
    const loadImg = (url) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });

    const hmImg = await loadImg(hmUrl);
    const colImg = await loadImg(colUrl);
    const hmC = document.createElement('canvas');
    hmC.width = hmImg.naturalWidth;
    hmC.height = hmImg.naturalHeight;
    const hmX = hmC.getContext('2d');
    hmX.drawImage(hmImg, 0, 0);
    const hmData = hmX.getImageData(0, 0, hmC.width, hmC.height).data;

    const colC = document.createElement('canvas');
    colC.width = colImg.naturalWidth;
    colC.height = colImg.naturalHeight;
    const colX = colC.getContext('2d');
    colX.drawImage(colImg, 0, 0);
    const colData = colX.getImageData(0, 0, colC.width, colC.height).data;

    const sampleHM = (u, v) => {
      // u,v in 0..1 — heightmap may be non-square; cover full image
      const x = Math.min(hmC.width - 1, Math.max(0, u * (hmC.width - 1)));
      const y = Math.min(hmC.height - 1, Math.max(0, (1 - v) * (hmC.height - 1)));
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(hmC.width - 1, x0 + 1);
      const y1 = Math.min(hmC.height - 1, y0 + 1);
      const fx = x - x0;
      const fy = y - y0;
      const pix = (ix, iy) => {
        const i = (iy * hmC.width + ix) * 4;
        return hmData[i] / 255; // R channel
      };
      const a = pix(x0, y0) * (1 - fx) + pix(x1, y0) * fx;
      const b = pix(x0, y1) * (1 - fx) + pix(x1, y1) * fx;
      return a * (1 - fy) + b * fy;
    };

    const sampleCol = (u, v, out) => {
      const x = Math.min(colC.width - 1, Math.max(0, Math.round(u * (colC.width - 1))));
      const y = Math.min(colC.height - 1, Math.max(0, Math.round((1 - v) * (colC.height - 1))));
      const i = (y * colC.width + x) * 4;
      out.r = colData[i] / 255;
      out.g = colData[i + 1] / 255;
      out.b = colData[i + 2] / 255;
    };

    const geo = new THREE.PlaneGeometry(half * 2, half * 2, res - 1, res - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const uvs = geo.attributes.uv;
    let hMin = Infinity;
    let hMax = -Infinity;

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const u = (x + half) / (half * 2);
      const v = (z + half) / (half * 2);
      let h = sampleHM(u, v) * hScale;
      // Circular plate fade
      const rd = Math.hypot(x, z);
      const disk = rd > half * 0.98 ? 0 : 1;
      if (!disk) h = 0;
      pos.setY(i, h);
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
      uvs.setXY(i, u * 4, v * 4); // mild tile if map present
    }
    geo.computeVertexNormals();
    const nrm = geo.attributes.normal;
    const tmp = new THREE.Color();
    const cliff = new THREE.Color(0x5a4030); // dark rocky steep (match refs)
    const rimLite = new THREE.Color(0xd4a070); // sun-bleached rim

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const u = (x + half) / (half * 2);
      const v = (z + half) / (half * 2);
      const rd = Math.hypot(x, z);
      if (rd > half * 0.98) {
        colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 0.02;
        continue;
      }
      sampleCol(u, v, tmp);
      const ny = Math.abs(nrm.getY(i));
      const slope = 1 - ny;
      // Steep faces → darker rocky; sharp rims get a light kiss
      const steepW = Math.max(0, Math.min(1, (slope - 0.15) / 0.5));
      tmp.lerp(cliff, steepW * 0.55);
      if (slope > 0.35 && ny > 0.2 && ny < 0.75) {
        tmp.lerp(rimLite, 0.12);
      }
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.02,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Moon_0';
    const root = new THREE.Group();
    root.name = 'heightmap-plate';
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
    return { b64: btoa(s), verts: pos.count, hMin, hMax };
  },
  {
    res: RES,
    half: HALF,
    hScale: H_SCALE,
    hmUrl: `http://127.0.0.1:${PORT}/assets/mesa/ref-heightmap.png`,
    colUrl: `http://127.0.0.1:${PORT}/assets/mesa/ref-topdown.jpg`,
  }
);

await browser.close();
server.close();

const plateBuf = Buffer.from(exported.b64, 'base64');
const platePath = path.join(MESA, 'skirmish-from-heightmap.glb');
fs.writeFileSync(platePath, plateBuf);
console.log(
  'wrote',
  platePath,
  plateBuf.length,
  'verts',
  exported.verts,
  'h',
  exported.hMin?.toFixed?.(2),
  exported.hMax?.toFixed?.(2)
);

// ---- Merge: Moon_0 only, strip ALL props ----
function parseGlb(buf) {
  const jlen = buf.readUInt32LE(12);
  const json = JSON.parse(
    buf
      .slice(20, 20 + jlen)
      .toString('utf8')
      .replace(/:\s*-?inf\b/gi, ':null')
      .replace(/:\s*nan\b/gi, ':null')
  );
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

{
  const drop = new Set();
  for (let i = 0; i < live.json.nodes.length; i++) {
    const n = live.json.nodes[i]?.name || '';
    if (/^Prop_/i.test(n)) drop.add(i);
    if (/^Moon_/i.test(n) && !/^Moon_0$/i.test(n)) drop.add(i);
    if (/^(?:SM_)?(?:Rock|Cliff|Dirt|Mineral|Bridge)/i.test(n)) drop.add(i);
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
      if (n.children)
        n.children = n.children.map((c) => map.get(c)).filter((c) => c != null);
    }
    console.log('stripped', drop.size);
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
const mat0 = append('materials', plate.json.materials);
const mesh0 = append('meshes', plate.json.meshes);
const pad = (4 - (live.bin.length % 4)) % 4;
const start = live.bin.length + pad;
const newBin = Buffer.concat([live.bin, Buffer.alloc(pad), plate.bin]);
for (let i = bv0; i < live.json.bufferViews.length; i++) {
  const bv = live.json.bufferViews[i];
  bv.buffer = 0;
  bv.byteOffset = (bv.byteOffset || 0) + start;
}
for (let i = acc0; i < live.json.accessors.length; i++) {
  const a = live.json.accessors[i];
  if (a.bufferView != null) a.bufferView += bv0;
}
for (let i = mat0; i < live.json.materials.length; i++) {
  /* vertex-color only */
}
for (let i = mesh0; i < live.json.meshes.length; i++) {
  for (const prim of live.json.meshes[i].primitives || []) {
    if (prim.indices != null) prim.indices += acc0;
    if (prim.material != null) prim.material += mat0;
    if (prim.attributes)
      for (const k of Object.keys(prim.attributes)) prim.attributes[k] += acc0;
  }
}

let moonNode = live.json.nodes.find((n) => /^Moon_0$/i.test(n.name || ''));
if (!moonNode) {
  moonNode = { name: 'Moon_0' };
  live.json.nodes.push(moonNode);
  live.json.scenes[live.json.scene ?? 0].nodes.push(live.json.nodes.length - 1);
}
moonNode.mesh = mesh0;
delete moonNode.translation;
delete moonNode.rotation;
moonNode.scale = [1, 1, 1];
moonNode.name = 'Moon_0';

live.json.extras = live.json.extras || {};
live.json.extras.rtsMesaHeightfield = {
  res: RES,
  half: HALF,
  hMin: exported.hMin,
  hMax: exported.hMax,
  method: 'user-heightmap+color-topdown',
  source: 'ref-heightmap.png / ref-topdown.jpg',
};
delete live.json.extras.rtsMegascansCanyon;

const outPath = WRITE_LIVE ? LIVE : path.join(MESA, 'terrain-from-heightmap.glb');
if (WRITE_LIVE && !fs.existsSync(LIVE + '.pre-user-hm.bak')) {
  if (fs.existsSync(LIVE)) fs.copyFileSync(LIVE, LIVE + '.pre-user-hm.bak');
}
fs.writeFileSync(outPath, writeGlb(live.json, newBin));
console.log('wrote', outPath);
if (!WRITE_LIVE) console.log('Dry-run — WRITE_LIVE=1 CONFIRM_WRITE_LIVE=1');
