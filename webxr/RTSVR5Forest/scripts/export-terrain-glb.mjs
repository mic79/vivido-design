#!/usr/bin/env node
/**
 * Export the live moon plate + horizon skirts as a bake-ready GLB.
 *
 * Unique planar UV0 (world XZ → 0..1). Tiled UV1 = live moon albedo UVs.
 * Lightmass bake is UE **4.27** (same as SciFiHallway): D:\ue4\RTSVR4MoonBake
 * After this: node RTSVR4/scripts/pack-ue427-import.mjs
 * then: powershell -File D:\ue4\RTSVR4MoonBake\run_bake.ps1
 * (import → resavepackages -buildlighting → glTF EPIC_lightmap_textures → assets/terrain/)
 *
 *   node RTSVR4/scripts/export-terrain-glb.mjs
 *   node RTSVR4/scripts/export-terrain-glb.mjs --mode=story --seed=1
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'export');
const PORT = Number(process.env.PORT || 8771);

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const MODE = arg('mode', '1v1');
const SEED = arg('seed', '');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
};

function startStaticServer() {
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/') rel = '/index.html';
      const filePath = path.normalize(path.join(ROOT, rel));
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function align4(n) {
  return (n + 3) & ~3;
}

function bounds3(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function writeGlb(meshes) {
  const views = [];
  const binParts = [];
  let offset = 0;
  const push = (typed, target) => {
    const buf = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    const pad = align4(buf.length) - buf.length;
    views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
    binParts.push({ buf, pad });
    offset += buf.length + pad;
    return views.length - 1;
  };

  const accessors = [];
  const glMeshes = [];
  const nodes = [];
  for (const mesh of meshes) {
    const posView = push(mesh.positions, 34962);
    const nrmView = push(mesh.normals, 34962);
    const uv0View = push(mesh.uv0, 34962);
    const uv1View = push(mesh.uv1, 34962);
    const idxView = push(mesh.indices, 34963);
    const b = bounds3(mesh.positions);
    const a0 = accessors.length;
    accessors.push(
      { bufferView: posView, componentType: 5126, count: mesh.positions.length / 3, type: 'VEC3', min: b.min, max: b.max },
      { bufferView: nrmView, componentType: 5126, count: mesh.normals.length / 3, type: 'VEC3' },
      { bufferView: uv0View, componentType: 5126, count: mesh.uv0.length / 2, type: 'VEC2' },
      { bufferView: uv1View, componentType: 5126, count: mesh.uv1.length / 2, type: 'VEC2' },
      { bufferView: idxView, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' },
    );
    const mi = glMeshes.length;
    glMeshes.push({
      name: mesh.name,
      primitives: [{
        attributes: { POSITION: a0, NORMAL: a0 + 1, TEXCOORD_0: a0 + 2, TEXCOORD_1: a0 + 3 },
        indices: a0 + 4,
        material: 0,
        mode: 4,
      }],
    });
    nodes.push({ mesh: mi, name: mesh.name });
  }

  const json = {
    asset: { version: '2.0', generator: 'RTSVR4 export-terrain-glb' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes: glMeshes,
    materials: [{
      name: 'M_MoonTerrain',
      pbrMetallicRoughness: {
        baseColorFactor: [0.72, 0.72, 0.70, 1],
        metallicFactor: 0,
        roughnessFactor: 0.92,
      },
    }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = align4(jsonBuf.length) - jsonBuf.length;
  const jsonChunkLen = jsonBuf.length + jsonPad;
  const binChunkLen = offset;

  const total = 12 + 8 + jsonChunkLen + 8 + binChunkLen;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  let o = 12;
  out.writeUInt32LE(jsonChunkLen, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4;
  jsonBuf.copy(out, o); o += jsonBuf.length;
  if (jsonPad) out.fill(0x20, o, o + jsonPad);
  o += jsonPad;
  out.writeUInt32LE(binChunkLen, o); o += 4;
  out.writeUInt32LE(0x004e4942, o); o += 4;
  for (const part of binParts) {
    part.buf.copy(out, o); o += part.buf.length;
    if (part.pad) { out.fill(0, o, o + part.pad); o += part.pad; }
  }
  return out;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const server = await startStaticServer();
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage();
  const startMode = MODE === 'story' ? 'story' : '1v1';
  const qs = startMode === 'story' && SEED !== '' ? `&storySeed=${encodeURIComponent(SEED)}` : '';
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1${qs}`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 180000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    });
    await page.evaluate((mode) => {
      if (typeof window._startGame !== 'function') throw new Error('no _startGame');
      window._startGame(mode);
    }, startMode);
    await page.waitForFunction(() => {
      const overlay = document.getElementById('match-prepare-overlay');
      const started = window.__rtsReady && document.querySelector('a-scene');
      return started && !(overlay && !overlay.hidden);
    }, null, { timeout: 180000 });
    await new Promise((r) => setTimeout(r, 800));

    const payload = await page.evaluate(async () => {
      const THREE = window.THREE;
      const groundEl = document.getElementById('ground');
      const root = groundEl && (groundEl.getObject3D('mesh') || groundEl.object3D);
      if (!THREE || !root) throw new Error('no ground mesh');
      root.updateMatrixWorld(true);

      const _v = new THREE.Vector3();
      const _n = new THREE.Vector3();
      const _nMat = new THREE.Matrix3();

      function collect(filterName, outName) {
        const pos = [];
        const nrm = [];
        const uvTiled = [];
        const idx = [];
        root.traverse((obj) => {
          if (!obj.isMesh || !obj.geometry) return;
          let isSkirt = false;
          for (let p = obj; p; p = p.parent) {
            if (p.name === 'rts-horizon-skirt') { isSkirt = true; break; }
          }
          if (filterName === 'skirt' ? !isSkirt : isSkirt) return;
          const g = obj.geometry;
          const pa = g.getAttribute('position');
          const na = g.getAttribute('normal');
          const ua = g.getAttribute('uv');
          if (!pa) return;
          obj.updateWorldMatrix(true, false);
          _nMat.getNormalMatrix(obj.matrixWorld);
          const base = pos.length / 3;
          const index = g.index;
          for (let i = 0; i < pa.count; i++) {
            _v.fromBufferAttribute(pa, i).applyMatrix4(obj.matrixWorld);
            pos.push(_v.x, _v.y, _v.z);
            if (na) {
              _n.fromBufferAttribute(na, i).applyMatrix3(_nMat).normalize();
              nrm.push(_n.x, _n.y, _n.z);
            } else {
              nrm.push(0, 1, 0);
            }
            if (ua) uvTiled.push(ua.getX(i), ua.getY(i));
            else uvTiled.push(0, 0);
          }
          if (index) {
            for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
          } else {
            for (let i = 0; i < pa.count; i++) idx.push(base + i);
          }
        });
        if (!pos.length) return null;
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < pos.length; i += 3) {
          const x = pos[i], z = pos[i + 2];
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const spanX = Math.max(1e-6, maxX - minX);
        const spanZ = Math.max(1e-6, maxZ - minZ);
        const uv0 = new Array((pos.length / 3) * 2);
        for (let i = 0, v = 0; i < pos.length; i += 3, v += 2) {
          uv0[v] = (pos[i] - minX) / spanX;
          uv0[v + 1] = (pos[i + 2] - minZ) / spanZ;
        }
        return {
          name: outName,
          positions: pos,
          normals: nrm,
          uv0,
          uv1: uvTiled,
          indices: idx,
          verts: pos.length / 3,
          tris: idx.length / 3,
          worldMin: [minX, minZ],
          worldMax: [maxX, maxZ],
        };
      }

      const plate = collect('plate', 'rts-moon-plate');
      const skirts = collect('skirt', 'rts-moon-skirts');
      const meshes = [plate, skirts].filter(Boolean);

      const Moon = await import('./js/moon-environment.js');
      const Cfg = await import('./js/config.js');
      const segs = Cfg.MAP_PROFILE === 'story' ? 192 : 96;
      const size = Cfg.MAP_SIZE;
      const half = size * 0.5;
      const heights = new Array((segs + 1) * (segs + 1));
      for (let iz = 0; iz <= segs; iz++) {
        for (let ix = 0; ix <= segs; ix++) {
          const wx = -half + (ix / segs) * size;
          const wz = half - (iz / segs) * size;
          heights[iz * (segs + 1) + ix] = Moon.sampleMoonTerrainWorldY(wx, wz);
        }
      }

      return {
        meshes,
        meta: {
          mode: Cfg.MAP_PROFILE,
          mapSize: size,
          segments: segs,
          parts: meshes.map((m) => ({
            name: m.name,
            verts: m.verts,
            tris: m.tris,
            worldMin: m.worldMin,
            worldMax: m.worldMax,
          })),
        },
        heights,
      };
    });

    const meshes = (payload.meshes || []).map((m) => ({
      name: m.name,
      positions: Float32Array.from(m.positions),
      normals: Float32Array.from(m.normals),
      uv0: Float32Array.from(m.uv0),
      uv1: Float32Array.from(m.uv1),
      indices: Uint32Array.from(m.indices),
    }));
    if (!meshes.length) throw new Error('export produced no meshes');
    const tag = startMode === 'story'
      ? `story-${SEED !== '' ? SEED : 'live'}`
      : 'skirmish';
    const glbPath = path.join(OUT_DIR, `terrain-${tag}.glb`);
    const jsonPath = path.join(OUT_DIR, `terrain-${tag}.height.json`);
    fs.writeFileSync(glbPath, writeGlb(meshes));
    fs.writeFileSync(jsonPath, JSON.stringify({
      ...payload.meta,
      seed: SEED === '' ? null : Number(SEED),
      heights: payload.heights,
    }));
    const st = fs.statSync(glbPath);
    console.log(`Wrote ${glbPath} (${(st.size / 1024).toFixed(1)} KB)`);
    console.log(`Wrote ${jsonPath}`);
    console.log(JSON.stringify(payload.meta, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
