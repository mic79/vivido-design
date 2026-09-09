#!/usr/bin/env node
/**
 * Bake Prop_* rock shadows onto Moon_* as planar-XZ grayscale maps, using the
 * HDR environment sun (brightest equirect texel). Embedded in the combined
 * 1v1 GLB as extras.rtsMoonRockShadows for runtime Lambert multiply.
 *
 *   node RTSVR5/scripts/bake-rock-shadows.mjs
 *
 * Env: RES_PLATE=2048 RES_SKIRT=1024 SHADOW_MAP=4096 DARK=0.32 PORT=8794
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB_PATH = path.join(ROOT, 'assets', 'terrain', 'terrain-skirmish-1v1.glb');
const HDR_PATH = 'assets/earthlike_planet.hdr';
const SHOT = path.join(ROOT, 'bench-poses');
const PORT = Number(process.env.PORT || 8794);
const RES_PLATE = Number(process.env.RES_PLATE || 2048);
const RES_SKIRT = Number(process.env.RES_SKIRT || 1024);
const SHADOW_MAP = Number(process.env.SHADOW_MAP || 4096);
const DARK = Math.min(0.95, Math.max(0.05, Number(process.env.DARK || 0.48)));
/** Game directional fallback (index.html) if HDR peak is unusable. */
const GAME_SUN = { x: -0.005, y: 55, z: -48.83 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
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
  if (rel === '/') rel = '/scripts/bake-rock-shadows-page.html';
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
await page.goto(`http://127.0.0.1:${PORT}/scripts/bake-rock-shadows-page.html`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForFunction(() => window.__bakeReady === true, null, { timeout: 60000 });

const baked = await page.evaluate(
  async ({ glbUrl, hdrUrl, resPlate, resSkirt, shadowMapRes, dark, gameSun }) => {
    const THREE = window.THREE;
    const loader = new window.GLTFLoader();
    const rgbe = new window.RGBELoader();

    function normalize(v) {
      const L = Math.hypot(v.x, v.y, v.z) || 1;
      return { x: v.x / L, y: v.y / L, z: v.z / L };
    }

    /** Brightest equirect texel → direction (Three equirect convention). */
    async function sunFromHdr(url) {
      const tex = await new Promise((resolve, reject) => {
        rgbe.load(url, resolve, undefined, reject);
      });
      const img = tex.image;
      const data = img.data;
      const w = img.width;
      const h = img.height;
      const stride = data.length / (w * h);
      let best = -1;
      let bestI = 0;
      // Step to keep peak-finding fast on large HDRs.
      const stepX = Math.max(1, Math.floor(w / 1024));
      const stepY = Math.max(1, Math.floor(h / 512));
      for (let y = 0; y < h; y += stepY) {
        for (let x = 0; x < w; x += stepX) {
          const i = (y * w + x) * stride;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (L > best) {
            best = L;
            bestI = y * w + x;
          }
        }
      }
      // Refine in a small window around the coarse peak.
      const cx = bestI % w;
      const cy = (bestI / w) | 0;
      const rad = Math.max(stepX, stepY) * 2;
      for (let y = Math.max(0, cy - rad); y <= Math.min(h - 1, cy + rad); y++) {
        for (let x = Math.max(0, cx - rad); x <= Math.min(w - 1, cx + rad); x++) {
          const i = (y * w + x) * stride;
          const L = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          if (L > best) {
            best = L;
            bestI = y * w + x;
          }
        }
      }
      const u = ((bestI % w) + 0.5) / w;
      const v = (((bestI / w) | 0) + 0.5) / h;
      const theta = (u - 0.5) * Math.PI * 2;
      const phi = (v - 0.5) * Math.PI;
      const cp = Math.cos(phi);
      const dir = normalize({
        x: cp * Math.cos(theta),
        y: Math.sin(phi),
        z: cp * Math.sin(theta),
      });
      tex.dispose();
      return { dir, peakL: best, uv: [u, v], size: [w, h] };
    }

    let sunInfo;
    try {
      sunInfo = await sunFromHdr(hdrUrl);
    } catch (e) {
      console.warn('HDR sun failed, using game sun', e && e.message);
      sunInfo = { dir: normalize(gameSun), peakL: 0, uv: null, size: null, fallback: true };
    }
    // Prefer an elevated sun; if HDR peak is near-horizon / below, blend toward game sun.
    if (sunInfo.dir.y < 0.25) {
      const g = normalize(gameSun);
      sunInfo.dir = normalize({
        x: sunInfo.dir.x * 0.35 + g.x * 0.65,
        y: Math.max(0.35, sunInfo.dir.y * 0.35 + g.y * 0.65),
        z: sunInfo.dir.z * 0.35 + g.z * 0.65,
      });
      sunInfo.elevated = true;
    }

    const buf = await fetch(glbUrl).then((r) => r.arrayBuffer());
    const gltf = await new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject));
    gltf.scene.updateMatrixWorld(true);

    const moons = [];
    const rocks = [];
    gltf.scene.traverse((obj) => {
      if (!obj.isMesh) return;
      const n = obj.name || '';
      if (/^Moon_\d/i.test(n) || /^rts-moon-/i.test(n)) {
        moons.push(obj);
        return;
      }
      // Every non-moon scenery mesh casts (new UE pieces may not be named Prop_*).
      if (/^RTS_/i.test(n) || /light|camera|helper|grid/i.test(n)) return;
      rocks.push(obj);
    });
    moons.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!moons.length) throw new Error('no moon meshes');
    if (!rocks.length) throw new Error('no scenery meshes to cast');

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
    renderer.setSize(64, 64, false);
    renderer.outputColorSpace = THREE.NoColorSpace || THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false;

    // World bounds from moons (plate + skirts).
    const worldBox = new THREE.Box3();
    for (const m of moons) {
      m.updateMatrixWorld(true);
      worldBox.expandByObject(m);
    }
    const size = new THREE.Vector3();
    worldBox.getSize(size);
    const half = Math.max(size.x, size.z) * 0.5 + 40;
    const sunDir = new THREE.Vector3(sunInfo.dir.x, sunInfo.dir.y, sunInfo.dir.z).normalize();
    if (Math.abs(sunDir.y) < 0.08) sunDir.y = 0.08;
    sunDir.normalize();

    /** Project rock mesh onto a ground Y along the light ray (continuous contact+cast umbra). */
    function projectRockOntoGround(src, groundY) {
      const geo = src.geometry.clone();
      geo.applyMatrix4(src.matrixWorld);
      const pos = geo.attributes.position;
      const Ly = sunDir.y;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const t = (y - groundY) / Ly;
        pos.setXYZ(i, x - sunDir.x * t, groundY, z - sunDir.z * t);
      }
      pos.needsUpdate = true;
      return geo;
    }

    const blackMat = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
    const whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });

    const out = [];
    for (const src of moons) {
      const idx = moonIndex(src.name);
      const res = idx === 0 ? resPlate : resSkirt;
      src.updateMatrixWorld(true);
      const geo = src.geometry.clone();
      geo.applyMatrix4(src.matrixWorld);
      if (geo.attributes.normal) geo.normalizeNormals();
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const minX = bb.min.x;
      const maxX = bb.max.x;
      const minZ = bb.min.z;
      const maxZ = bb.max.z;
      const midY = (bb.min.y + bb.max.y) * 0.5;

      const scene = new THREE.Scene();
      // No moon mesh in the color pass — it would depth-occlude flat projections.
      // White clear = lit; black projected rocks = umbra (contact + cast as one).

      const projected = [];
      blackMat.depthTest = false;
      blackMat.depthWrite = false;
      for (const rock of rocks) {
        rock.updateMatrixWorld(true);
        const rbox = new THREE.Box3().setFromObject(rock);
        // Seat height ≈ rock base (props already sit on the crater).
        const groundY = rbox.min.y + 0.02;
        const pgeo = projectRockOntoGround(rock, groundY);
        // Keep only rocks whose projection overlaps this moon's XZ bbox.
        pgeo.computeBoundingBox();
        const pb = pgeo.boundingBox;
        if (
          pb.max.x < minX ||
          pb.min.x > maxX ||
          pb.max.z < minZ ||
          pb.min.z > maxZ
        ) {
          pgeo.dispose();
          continue;
        }
        const mesh = new THREE.Mesh(pgeo, blackMat);
        mesh.matrixAutoUpdate = false;
        mesh.matrix.identity();
        mesh.matrixWorld.identity();
        mesh.frustumCulled = false;
        scene.add(mesh);
        projected.push({ mesh, pgeo });
      }

      // up=(0,0,-1) ⇒ camera +Y is world −Z, so top/bottom must be −minZ / −maxZ
      // for world Z to match planar uv v=(z-minZ)/sz with flipY=false.
      const cam = new THREE.OrthographicCamera(minX, maxX, -minZ, -maxZ, 0.1, 5000);
      cam.position.set((minX + maxX) * 0.5, Math.max(bb.max.y, midY) + 800, (minZ + maxZ) * 0.5);
      cam.up.set(0, 0, -1);
      cam.lookAt((minX + maxX) * 0.5, midY, (minZ + maxZ) * 0.5);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();

      const rt = new THREE.WebGLRenderTarget(res, res, {
        type: THREE.UnsignedByteType,
        format: THREE.RGBAFormat,
        magFilter: THREE.LinearFilter,
        minFilter: THREE.LinearFilter,
        generateMipmaps: false,
      });
      renderer.setSize(res, res, false);
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);

      const pixels = new Uint8Array(res * res * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, res, res, pixels);
      rt.dispose();
      for (const p of projected) {
        scene.remove(p.mesh);
        p.pgeo.dispose();
      }
      geo.dispose();

      // Soften umbra edges (3×3 box) without separating contact from cast.
      const soft = new Uint8Array(res * res);
      for (let y = 0; y < res; y++) {
        const srcY = res - 1 - y;
        for (let x = 0; x < res; x++) {
          let acc = 0;
          let cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              const yy = srcY + dy;
              if (xx < 0 || yy < 0 || xx >= res || yy >= res) continue;
              const si = (yy * res + xx) * 4;
              acc += (pixels[si] + pixels[si + 1] + pixels[si + 2]) / 3;
              cnt++;
            }
          }
          soft[y * res + x] = acc / Math.max(1, cnt);
        }
      }

      let sum = 0;
      let sum2 = 0;
      let shadowed = 0;
      let n = 0;
      const c = document.createElement('canvas');
      c.width = res;
      c.height = res;
      const ctx = c.getContext('2d');
      const id = ctx.createImageData(res, res);
      const darkByte = Math.round(dark * 255);
      for (let y = 0; y < res; y++) {
        for (let x = 0; x < res; x++) {
          const di = (y * res + x) * 4;
          let v = soft[y * res + x];
          if (v < 250) v = Math.max(darkByte, v);
          id.data[di] = v;
          id.data[di + 1] = v;
          id.data[di + 2] = v;
          id.data[di + 3] = 255;
          const L = v / 255;
          n++;
          sum += L;
          sum2 += L * L;
          if (L < 0.92) shadowed++;
        }
      }
      ctx.putImageData(id, 0, 0);
      const mean = n ? sum / n : 1;
      const std = n ? Math.sqrt(Math.max(0, sum2 / n - mean * mean)) : 0;
      out.push({
        i: idx,
        name: src.name,
        res,
        mean,
        std,
        shadowedFrac: n ? shadowed / n : 0,
        bbox: {
          min: [bb.min.x, bb.min.y, bb.min.z],
          max: [bb.max.x, bb.max.y, bb.max.z],
        },
        png: c.toDataURL('image/png').split(',')[1],
      });
    }

    blackMat.dispose();
    whiteMat.dispose();
    renderer.dispose();

    return {
      sun: sunInfo,
      rocks: rocks.length,
      moons: moons.length,
      half,
      maps: out,
    };
  },
  {
    glbUrl: `http://127.0.0.1:${PORT}/assets/terrain/terrain-skirmish-1v1.glb`,
    hdrUrl: `http://127.0.0.1:${PORT}/${HDR_PATH}`,
    resPlate: RES_PLATE,
    resSkirt: RES_SKIRT,
    shadowMapRes: SHADOW_MAP,
    dark: DARK,
    gameSun: GAME_SUN,
  }
);

await browser.close();
server.close();

if (!baked?.maps?.length) {
  console.error('FAIL: no shadow maps');
  process.exit(1);
}

fs.mkdirSync(SHOT, { recursive: true });
console.log(
  JSON.stringify(
    {
      sun: baked.sun,
      rocks: baked.rocks,
      moons: baked.moons,
      half: baked.half,
    },
    null,
    2
  )
);

const buf = fs.readFileSync(GLB_PATH);
const parsed = parseGlb(buf);
let bin = Buffer.from(parsed.bin);
const json = parsed.json;
json.extras = json.extras || {};
const existing = json.extras.rtsMoonRockShadows || [];
const extras = [];

for (const d of baked.maps) {
  const png = Buffer.from(d.png, 'base64');
  fs.writeFileSync(path.join(SHOT, `rock-shadow-${d.i}-${d.name}.png`), png);
  console.log(
    JSON.stringify(
      {
        i: d.i,
        name: d.name,
        res: d.res,
        mean: d.mean,
        std: d.std,
        shadowedFrac: d.shadowedFrac,
        pngBytes: png.length,
      },
      null,
      2
    )
  );
  if (d.std < 0.005 && d.shadowedFrac < 0.001) {
    console.error(`FAIL: ${d.name} rock-shadow map is empty (no shadows)`);
    process.exit(1);
  }
  const a = appendBytes(bin, png);
  bin = a.bin;
  const view = { buffer: 0, byteOffset: a.byteOffset, byteLength: a.byteLength };
  let texIndex;
  if (existing[d.i] && json.textures[existing[d.i].textureIndex]) {
    const tex = json.textures[existing[d.i].textureIndex];
    const img = json.images[tex.source];
    json.bufferViews[img.bufferView] = view;
    img.name = `rock_shadow_planar_${d.i}`;
    img.mimeType = 'image/png';
    tex.name = `rock_shadow_planar_${d.i}`;
    texIndex = existing[d.i].textureIndex;
  } else {
    json.bufferViews.push(view);
    json.images.push({
      name: `rock_shadow_planar_${d.i}`,
      mimeType: 'image/png',
      bufferView: json.bufferViews.length - 1,
    });
    json.samplers = json.samplers || [];
    json.samplers.push({
      name: `rock_shadow_clamp_${d.i}`,
      magFilter: 9729,
      minFilter: 9729,
      wrapS: 33071,
      wrapT: 33071,
    });
    json.textures.push({
      name: `rock_shadow_planar_${d.i}`,
      sampler: json.samplers.length - 1,
      source: json.images.length - 1,
    });
    texIndex = json.textures.length - 1;
  }
  extras[d.i] = {
    textureIndex: texIndex,
    texCoord: 1,
    layout: 'planar-xz',
    bbox: d.bbox,
    dark: DARK,
    sunDir: [baked.sun.dir.x, baked.sun.dir.y, baked.sun.dir.z],
    shadowedFrac: d.shadowedFrac,
  };
}

json.extras.rtsMoonRockShadows = extras;
const out = writeGlb(json, bin);
fs.writeFileSync(GLB_PATH, out);
console.log(JSON.stringify({ out: GLB_PATH, bytes: out.length, extras }, null, 2));
