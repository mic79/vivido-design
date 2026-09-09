#!/usr/bin/env node
/**
 * Bake Lambert lighting (game sun + tiled normals/AO, no albedo) into
 * continuous planar-XZ lightmaps. Lightmass unique-UV islands are unusable.
 *
 *   node scripts/bake-planar-lightmap.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB_PATH = path.join(ROOT, 'assets', 'terrain', 'terrain-skirmish-ue-lm.glb');
const SHOT = path.join(ROOT, 'bench-poses');
const PORT = Number(process.env.PORT || 8793);
const RES_PLATE = Number(process.env.RES_PLATE || 2048);
const RES_SKIRT = Number(process.env.RES_SKIRT || 1024);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + jsonLen)));
  const binOff = 20 + jsonLen;
  const binLen = dv.getUint32(binOff, true);
  const bin = Buffer.from(buf.subarray(binOff + 8, binOff + 8 + binLen));
  return { json, bin };
}

function pad4(n) {
  return (4 - (n % 4)) % 4;
}

function writeGlb(json, bin) {
  json.buffers = [{ byteLength: bin.length }];
  const jsonBuf = Buffer.from(JSON.stringify(json));
  const jsonPad = pad4(jsonBuf.length);
  const binPad = pad4(bin.length);
  const jsonChunk = jsonBuf.length + jsonPad;
  const binChunk = bin.length + binPad;
  const out = Buffer.alloc(12 + 8 + jsonChunk + 8 + binChunk);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonChunk, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonBuf.copy(out, 20);
  out.fill(0x20, 20 + jsonBuf.length, 20 + jsonChunk);
  const binHdr = 20 + jsonChunk;
  out.writeUInt32LE(binChunk, binHdr);
  out.writeUInt32LE(0x004e4942, binHdr + 4);
  bin.copy(out, binHdr + 8);
  return out;
}

function appendBytes(bin, bytes) {
  const start = bin.length;
  const pad = pad4(bytes.length);
  const next = Buffer.concat([bin, bytes, Buffer.alloc(pad)]);
  return { bin: next, byteOffset: start, byteLength: bytes.length };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/scripts/bake-lm-page.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
page.on('console', (msg) => console.log('page:', msg.type(), msg.text()));
page.on('pageerror', (err) => console.error('pageerror', err.message));
await page.goto(`http://127.0.0.1:${PORT}/scripts/bake-lm-page.html`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForFunction(() => window.__bakeReady === true, null, { timeout: 60000 });

const baked = await page.evaluate(
  async ({ glbUrl, resPlate, resSkirt }) => {
    const THREE = window.THREE;
    const loader = new window.GLTFLoader();
    const buf = await fetch(glbUrl).then((r) => r.arrayBuffer());
    const gltf = await new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject));
    gltf.scene.updateMatrixWorld(true);

    const meshes = [];
    gltf.scene.traverse((obj) => {
      if (!obj.isMesh) return;
      if (!/^Moon_\d/i.test(obj.name || '') && !/^rts-moon-/i.test(obj.name || '')) return;
      meshes.push(obj);
    });
    meshes.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!meshes.length) throw new Error('no moon meshes');

    function moonIndex(name) {
      const m = /Moon_(\d)/i.exec(name || '');
      if (m) return Number(m[1]);
      if (/skirt/i.test(name || '')) return 1;
      return 0;
    }

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    renderer.outputColorSpace = THREE.NoColorSpace || THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = false;

    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xc8d0dc, 0.28));
    const sun = new THREE.DirectionalLight(0xffffff, 1.95);
    sun.position.set(-0.005, 55, -48.83);
    sun.target.position.set(0, 0, 0);
    scene.add(sun);
    scene.add(sun.target);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    camera.position.set(0, 0, 1);
    camera.lookAt(0, 0, 0);

    const dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    dummy.needsUpdate = true;
    dummy.channel = 1;

    const out = [];
    for (const src of meshes) {
      const idx = moonIndex(src.name);
      const res = idx === 0 ? resPlate : resSkirt;
      src.updateMatrixWorld(true);
      const geo = src.geometry.clone();
      geo.applyMatrix4(src.matrixWorld);
      if (geo.attributes.normal) geo.normalizeNormals();
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const minX = bb.min.x;
      const minZ = bb.min.z;
      const sx = bb.max.x - minX || 1;
      const sz = bb.max.z - minZ || 1;
      const pos = geo.attributes.position;
      const uv1 = new Float32Array(pos.count * 2);
      for (let i = 0; i < pos.count; i++) {
        uv1[i * 2] = (pos.getX(i) - minX) / sx;
        uv1[i * 2 + 1] = (pos.getZ(i) - minZ) / sz;
      }
      geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
      geo.setAttribute('bakeUv', new THREE.BufferAttribute(uv1.slice(), 2));
      try {
        if (geo.index && geo.attributes.uv && geo.computeTangents) geo.computeTangents();
      } catch (_) {
        /* */
      }

      const sunDir = new THREE.Vector3(-0.005, 55, -48.83).normalize();
      const amb = new THREE.Color(0xc8d0dc).multiplyScalar(0.28);
      const sunCol = new THREE.Color(1, 1, 1).multiplyScalar(1.95);
      const hasN = !!(src.material && src.material.normalMap);
      const hasAo = !!(src.material && src.material.aoMap);
      const mat = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        toneMapped: false,
        uniforms: {
          mapN: { value: hasN ? src.material.normalMap : dummy },
          aoMap: { value: hasAo ? src.material.aoMap : dummy },
          hasNormal: { value: hasN ? 1 : 0 },
          hasAo: { value: hasAo ? 1 : 0 },
          sunDir: { value: sunDir },
          ambient: { value: amb },
          sunCol: { value: sunCol },
          lift: { value: 1.0 },
        },
        vertexShader: /* glsl */ `
attribute vec2 bakeUv;
varying vec3 vN;
varying vec3 vT;
varying vec3 vB;
varying vec2 vUv;
varying float vHasT;
void main() {
  vN = normalize(normal);
  vUv = uv;
  vHasT = 0.0;
#ifdef USE_TANGENT
  vT = normalize(tangent.xyz);
  vB = cross(vN, vT) * tangent.w;
  vHasT = 1.0;
#endif
  gl_Position = vec4(bakeUv * 2.0 - 1.0, 0.0, 1.0);
}
`,
        fragmentShader: /* glsl */ `
uniform sampler2D mapN;
uniform sampler2D aoMap;
uniform int hasNormal;
uniform int hasAo;
uniform vec3 sunDir;
uniform vec3 ambient;
uniform vec3 sunCol;
uniform float lift;
varying vec3 vN;
varying vec3 vT;
varying vec3 vB;
varying vec2 vUv;
varying float vHasT;
void main() {
  vec3 n = normalize(vN);
  if (hasNormal == 1 && vHasT > 0.5) {
    vec3 tn = texture2D(mapN, vUv).xyz * 2.0 - 1.0;
    n = normalize(mat3(normalize(vT), normalize(vB), n) * tn);
  }
  float ao = 1.0;
  if (hasAo == 1) ao = mix(1.0, texture2D(aoMap, vUv).r, 0.5);
  float ndotl = max(dot(n, sunDir), 0.0);
  vec3 lit = (ambient + sunCol * ndotl) * ao / 3.14159265;
  gl_FragColor = vec4(lit, 1.0);
}
`,
      });
      if (geo.attributes.tangent) mat.defines = { USE_TANGENT: '' };
      mat.customProgramCacheKey = () => `planarBake3|${src.name}|${hasN}|${hasAo}`;

      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.identity();
      mesh.matrixWorld.identity();

      const rt = new THREE.WebGLRenderTarget(res, res, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        magFilter: THREE.LinearFilter,
        minFilter: THREE.LinearFilter,
        generateMipmaps: false,
        colorSpace: THREE.NoColorSpace || THREE.LinearSRGBColorSpace,
      });
      renderer.setSize(res, res, false);
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      scene.add(mesh);
      renderer.render(scene, camera);
      scene.remove(mesh);

      const pixels = new Uint8Array(res * res * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, res, res, pixels);
      rt.dispose();
      geo.dispose();
      mat.dispose();

      let peak = 0;
      let sum = 0;
      let sum2 = 0;
      let n = 0;
      const c = document.createElement('canvas');
      c.width = res;
      c.height = res;
      const ctx = c.getContext('2d');
      const id = ctx.createImageData(res, res);
      for (let y = 0; y < res; y++) {
        const srcY = res - 1 - y;
        for (let x = 0; x < res; x++) {
          const si = (srcY * res + x) * 4;
          const di = (y * res + x) * 4;
          id.data[di] = pixels[si];
          id.data[di + 1] = pixels[si + 1];
          id.data[di + 2] = pixels[si + 2];
          id.data[di + 3] = 255;
          const L = (pixels[si] + pixels[si + 1] + pixels[si + 2]) / (3 * 255);
          if (L > 0.002) {
            n++;
            sum += L;
            sum2 += L * L;
            if (L > peak) peak = L;
          }
        }
      }
      ctx.putImageData(id, 0, 0);
      const mean = n ? sum / n : 0;
      const std = n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0;
      out.push({
        i: idx,
        name: src.name,
        res,
        peak,
        mean,
        std,
        n,
        bbox: {
          min: [bb.min.x, bb.min.y, bb.min.z],
          max: [bb.max.x, bb.max.y, bb.max.z],
        },
        png: c.toDataURL('image/png').split(',')[1],
      });
    }
    renderer.dispose();
    return out;
  },
  {
    glbUrl: `http://127.0.0.1:${PORT}/assets/terrain/terrain-skirmish-ue-lm.glb`,
    resPlate: RES_PLATE,
    resSkirt: RES_SKIRT,
  }
);

await browser.close();
server.close();

if (!baked?.length) {
  console.error('FAIL: no baked maps');
  process.exit(1);
}

fs.mkdirSync(SHOT, { recursive: true });
const buf = fs.readFileSync(GLB_PATH);
const parsed = parseGlb(buf);
let bin = Buffer.from(parsed.bin);
const json = parsed.json;
const existing = json.extras?.rtsMoonRgbLightmaps || [];
const texIndices = [];
const extras = [];

for (const d of baked) {
  const png = Buffer.from(d.png, 'base64');
  fs.writeFileSync(path.join(SHOT, `lm-planar-${d.i}-${d.name}.png`), png);
  console.log(
    JSON.stringify(
      {
        i: d.i,
        name: d.name,
        res: d.res,
        peak: d.peak,
        mean: d.mean,
        std: d.std,
        n: d.n,
        bbox: d.bbox,
        pngBytes: png.length,
      },
      null,
      2
    )
  );
  if (d.i === 0 && d.std < 0.03) {
    console.error(`FAIL: ${d.name} lightmap too flat std=${d.std}`);
    process.exit(1);
  }
  if (d.i !== 0 && d.std < 0.008) {
    console.error(`FAIL: ${d.name} skirt lightmap too flat std=${d.std}`);
    process.exit(1);
  }
  const a = appendBytes(bin, png);
  bin = a.bin;
  const view = { buffer: 0, byteOffset: a.byteOffset, byteLength: a.byteLength };
  if (existing[d.i] && json.textures[existing[d.i].textureIndex]) {
    const tex = json.textures[existing[d.i].textureIndex];
    const img = json.images[tex.source];
    json.bufferViews[img.bufferView] = view;
    img.name = `lightmap_planar_${d.i}`;
    img.mimeType = 'image/png';
    tex.name = `lightmap_planar_${d.i}`;
    texIndices[d.i] = existing[d.i].textureIndex;
  } else {
    json.bufferViews.push(view);
    json.images.push({
      name: `lightmap_planar_${d.i}`,
      mimeType: 'image/png',
      bufferView: json.bufferViews.length - 1,
    });
    json.samplers = json.samplers || [];
    json.samplers.push({
      name: `lightmap_planar_clamp_${d.i}`,
      magFilter: 9729,
      minFilter: 9729,
      wrapS: 33071,
      wrapT: 33071,
    });
    json.textures.push({
      name: `lightmap_planar_${d.i}`,
      sampler: json.samplers.length - 1,
      source: json.images.length - 1,
    });
    texIndices[d.i] = json.textures.length - 1;
  }
  extras[d.i] = {
    textureIndex: texIndices[d.i],
    peak: d.peak,
    intensity: Math.PI,
    texCoord: 1,
    layout: 'planar-xz',
    bbox: d.bbox,
  };
}

json.extras = json.extras || {};
json.extras.rtsMoonRgbLightmaps = extras;
const out = writeGlb(json, bin);
fs.writeFileSync(GLB_PATH, out);
console.log(JSON.stringify({ out: GLB_PATH, bytes: out.length, extras }, null, 2));
