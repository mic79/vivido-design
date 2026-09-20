#!/usr/bin/env node
/**
 * Decode UE HQ lightmaps into UV1-space RGB (albedo multipliers) and inject
 * them into the patched moon GLB so MeshBasic can sample lightMap without the
 * EPIC packed-atlas shader.
 *
 *   node scripts/decode-hq-to-rgb.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB_IN = path.join(ROOT, 'assets', 'terrain', 'terrain-skirmish-ue-lm.glb');
const GLB_OUT = GLB_IN;
const SHOT = path.join(ROOT, 'bench-poses');
const PORT = Number(process.env.PORT || 8791);
const LOG_BLACK = 0.01858136;
const DIRECTIONALITY = 1.0;
const INTENSITY = 1.0;
const OUT_SIZE = 1024;

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

function viewSlice(bin, json, viewIndex) {
  const v = json.bufferViews[viewIndex];
  const start = v.byteOffset || 0;
  return bin.subarray(start, start + v.byteLength);
}

function appendBytes(bin, bytes) {
  const start = bin.length;
  const pad = pad4(bytes.length);
  const next = Buffer.concat([bin, bytes, Buffer.alloc(pad)]);
  return { bin: next, byteOffset: start, byteLength: bytes.length };
}

const buf = fs.readFileSync(GLB_IN);
const { json, bin: bin0 } = parseGlb(buf);
let bin = Buffer.from(bin0);
const epic = json.extensions?.EPIC_lightmap_textures?.lightmaps;
if (!epic?.length) throw new Error('no EPIC_lightmap_textures');

const images = epic.map((lm, i) => {
  const tex = json.textures[lm.texture.index];
  const img = json.images[tex.source];
  const bytes = viewSlice(bin, json, img.bufferView);
  const outName = `hq-src-${i}-${img.name}.png`;
  fs.mkdirSync(SHOT, { recursive: true });
  fs.writeFileSync(path.join(SHOT, outName), bytes);
  return {
    i,
    name: img.name,
    scale: lm.lightmapScale,
    add: lm.lightmapAdd,
    bias: lm.coordinateScaleBias,
    b64: bytes.toString('base64'),
  };
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body>decode</body></html>');
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
await page.goto(`http://127.0.0.1:${PORT}/`);

const decoded = await page.evaluate(
  async ({ images, LOG_BLACK, DIRECTIONALITY, INTENSITY, OUT_SIZE }) => {
    function loadPng(b64) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('png'));
        img.src = 'data:image/png;base64,' + b64;
      });
    }
    function stats(arr, n) {
      let min = 1e9;
      let max = -1e9;
      let sum = 0;
      let sum2 = 0;
      let c = 0;
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        if (!(v > 0.0001)) continue;
        c++;
        sum += v;
        sum2 += v * v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const mean = c ? sum / c : 0;
      const std = c ? Math.sqrt(Math.max(0, sum2 / c - mean * mean)) : 0;
      return { min: c ? min : 0, max: c ? max : 0, mean, std, n: c };
    }
    function decodePair(lm0, lm1, scale, add) {
      const r = lm0[0] / 255;
      const g = lm0[1] / 255;
      const b = lm0[2] / 255;
      const a0 = lm0[3] / 255;
      const a1 = lm1[3] / 255;
      let logL = a0 + a1 * (1 / 255) - 0.5 / 255;
      logL = logL * scale[3] + add[3];
      const uvw = [r * r * scale[0] + add[0], g * g * scale[1] + add[1], b * b * scale[2] + add[2]];
      const l = Math.max(0, Math.exp(Math.LN2 * logL) - LOG_BLACK) * DIRECTIONALITY * INTENSITY;
      return [uvw[0] * l, uvw[1] * l, uvw[2] * l];
    }

    const out = [];
    for (const spec of images) {
      const img = await loadPng(spec.b64);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const src = ctx.getImageData(0, 0, w, h).data;
      const at = (x, y) => {
        const ix = Math.max(0, Math.min(w - 1, x | 0));
        const iy = Math.max(0, Math.min(h - 1, y | 0));
        const o = (iy * w + ix) * 4;
        return [src[o], src[o + 1], src[o + 2], src[o + 3]];
      };
      const variants = ['pngY', 'flipY'];
      const variantStats = {};
      let best = 'pngY';
      let bestStd = -1;
      for (const variant of variants) {
        const lum = [];
        const N = 96;
        for (let j = 0; j < N; j++) {
          for (let i = 0; i < N; i++) {
            const u = (i + 0.5) / N;
            const v = (j + 0.5) / N;
            const u0 = u * spec.bias[0] + spec.bias[2];
            const v0 = (v * spec.bias[1] + spec.bias[3]) * 0.5;
            let sx = u0 * w;
            let sy0 = v0 * h;
            let sy1 = (v0 + 0.5) * h;
            if (variant === 'flipY') {
              sy0 = h - 1 - sy0;
              sy1 = h - 1 - sy1;
            }
            const rgb = decodePair(at(sx, sy0), at(sx, sy1), spec.scale, spec.add);
            lum.push((rgb[0] + rgb[1] + rgb[2]) / 3);
          }
        }
        const st = stats(lum, lum.length);
        variantStats[variant] = st;
        if (st.std > bestStd) {
          bestStd = st.std;
          best = variant;
        }
      }

      const dst = document.createElement('canvas');
      dst.width = OUT_SIZE;
      dst.height = OUT_SIZE;
      const dctx = dst.getContext('2d');
      const id = dctx.createImageData(OUT_SIZE, OUT_SIZE);
      const luma = [];
      let peak = 0;
      const linear = new Float32Array(OUT_SIZE * OUT_SIZE * 3);
      for (let y = 0; y < OUT_SIZE; y++) {
        for (let x = 0; x < OUT_SIZE; x++) {
          const u = (x + 0.5) / OUT_SIZE;
          const v = (y + 0.5) / OUT_SIZE;
          const u0 = u * spec.bias[0] + spec.bias[2];
          const v0 = (v * spec.bias[1] + spec.bias[3]) * 0.5;
          let sx = u0 * w;
          let sy0 = v0 * h;
          let sy1 = (v0 + 0.5) * h;
          if (best === 'flipY') {
            sy0 = h - 1 - sy0;
            sy1 = h - 1 - sy1;
          }
          const rgb = decodePair(at(sx, sy0), at(sx, sy1), spec.scale, spec.add);
          const o = (y * OUT_SIZE + x) * 3;
          linear[o] = rgb[0];
          linear[o + 1] = rgb[1];
          linear[o + 2] = rgb[2];
          const L = (rgb[0] + rgb[1] + rgb[2]) / 3;
          luma.push(L);
          if (L > peak) peak = L;
        }
      }
      const scale = peak > 1e-6 ? 1 / peak : 1;
      for (let i = 0; i < OUT_SIZE * OUT_SIZE; i++) {
        const o = i * 4;
        const lo = i * 3;
        id.data[o] = Math.max(0, Math.min(255, Math.round(linear[lo] * scale * 255)));
        id.data[o + 1] = Math.max(0, Math.min(255, Math.round(linear[lo + 1] * scale * 255)));
        id.data[o + 2] = Math.max(0, Math.min(255, Math.round(linear[lo + 2] * scale * 255)));
        id.data[o + 3] = 255;
      }
      dctx.putImageData(id, 0, 0);
      out.push({
        i: spec.i,
        name: spec.name,
        hqSize: [w, h],
        best,
        variantStats,
        peak,
        scale,
        lum: stats(luma, luma.length),
        png: dst.toDataURL('image/png').split(',')[1],
      });
    }
    return out;
  },
  { images, LOG_BLACK, DIRECTIONALITY, INTENSITY, OUT_SIZE }
);

await browser.close();
server.close();

const rgbPngs = [];
for (const d of decoded) {
  const png = Buffer.from(d.png, 'base64');
  const fname = `lm-rgb-${d.i}-${d.name}.png`;
  fs.writeFileSync(path.join(SHOT, fname), png);
  rgbPngs.push(png);
  console.log(
    JSON.stringify(
      {
        i: d.i,
        name: d.name,
        hqSize: d.hqSize,
        best: d.best,
        variantStats: d.variantStats,
        peak: d.peak,
        storeScale: d.scale,
        lum: d.lum,
        pngBytes: png.length,
      },
      null,
      2
    )
  );
}

if (decoded.some((d) => d.lum.std < 0.01)) {
  console.error('FAIL: decoded lightmap luma is still flat');
  process.exit(1);
}

const existing = json.extras?.rtsMoonRgbLightmaps || [];
const texIndices = [];
for (let i = 0; i < rgbPngs.length; i++) {
  const a = appendBytes(bin, rgbPngs[i]);
  bin = a.bin;
  const view = { buffer: 0, byteOffset: a.byteOffset, byteLength: a.byteLength };
  if (existing[i] && json.textures[existing[i].textureIndex]) {
    const tex = json.textures[existing[i].textureIndex];
    const img = json.images[tex.source];
    json.bufferViews[img.bufferView] = view;
    img.mimeType = 'image/png';
    texIndices[i] = existing[i].textureIndex;
  } else {
    json.bufferViews.push(view);
    json.images.push({
      name: `lightmap_rgb_${i}`,
      mimeType: 'image/png',
      bufferView: json.bufferViews.length - 1,
    });
    json.samplers = json.samplers || [];
    json.samplers.push({
      name: `lightmap_rgb_clamp_${i}`,
      magFilter: 9729,
      minFilter: 9729,
      wrapS: 33071,
      wrapT: 33071,
    });
    json.textures.push({
      name: `lightmap_rgb_${i}`,
      sampler: json.samplers.length - 1,
      source: json.images.length - 1,
    });
    texIndices[i] = json.textures.length - 1;
  }
}

json.extras = json.extras || {};
json.extras.rtsMoonRgbLightmaps = decoded.map((d, i) => ({
  textureIndex: texIndices[i],
  peak: d.peak,
  storeScale: d.scale,
  intensity: Math.PI / d.scale,
  texCoord: 1,
  flip: d.best,
}));

const out = writeGlb(json, bin);
fs.writeFileSync(GLB_OUT, out);
console.log(
  JSON.stringify(
    {
      out: GLB_OUT,
      bytes: out.length,
      extras: json.extras.rtsMoonRgbLightmaps,
    },
    null,
    2
  )
);
