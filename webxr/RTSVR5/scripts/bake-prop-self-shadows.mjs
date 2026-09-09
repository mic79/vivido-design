#!/usr/bin/env node
/**
 * LEGACY — planar prop self-shadow atlases (ink-blot on heroes).
 * Pipeline now uses bake-hero-rgb-lightmaps.mjs for platform/pump/cliffs.
 * Keep for A/B only; export-skirmish-from-ue no longer calls it.
 *
 * Bake soft self+neighbor shadows for every scenery mesh (static).
 * Local sun depth per mesh → soft PCF → 2× SS + blur → planar atlas cell.
 * Variable cell sizes (platform/pump 256, large 128, rest 96).
 *
 *   node RTSVR5/scripts/bake-prop-self-shadows.mjs
 *
 * Env: ATLAS=4096 DEPTH=1536 DARK=0.45 PORT=8795
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB_PATH = path.join(ROOT, 'assets', 'terrain', 'terrain-skirmish-1v1.glb');
const SHOT = path.join(ROOT, 'bench-poses');
const PORT = Number(process.env.PORT || 8795);
const ATLAS = Number(process.env.ATLAS || 4096);
const DEPTH = Number(process.env.DEPTH || 1536);
/** Soft floor — never crush to pure black (old 0.22 looked like binary voids). */
const DARK = Math.min(0.9, Math.max(0.25, Number(process.env.DARK || 0.45)));
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

function sunFromExtras(json) {
  const specs = json.extras?.rtsMoonRockShadows || [];
  for (const s of specs) {
    if (s && Array.isArray(s.sunDir) && s.sunDir.length === 3) {
      const [x, y, z] = s.sunDir;
      const L = Math.hypot(x, y, z) || 1;
      return { x: x / L, y: y / L, z: z / L, from: 'rock-shadows' };
    }
  }
  const L = Math.hypot(GAME_SUN.x, GAME_SUN.y, GAME_SUN.z) || 1;
  return { x: GAME_SUN.x / L, y: GAME_SUN.y / L, z: GAME_SUN.z / L, from: 'game-sun' };
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
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
  });
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const glbBuf = fs.readFileSync(GLB_PATH);
const glbJson = parseGlb(glbBuf).json;
const sun = sunFromExtras(glbJson);
console.log('sun', sun, 'DARK', DARK, 'DEPTH', DEPTH, 'ATLAS', ATLAS);

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
  async ({ glbUrl, sunDir, atlas, depthRes, dark }) => {
    const THREE = window.THREE;
    const loader = new window.GLTFLoader();
    const buf = await fetch(glbUrl).then((r) => r.arrayBuffer());
    const gltf = await new Promise((resolve, reject) => loader.parse(buf, '', resolve, reject));
    gltf.scene.updateMatrixWorld(true);

    function nodeKey(obj, sceneRoot) {
      let n = obj;
      while (n.parent && n.parent !== sceneRoot) n = n.parent;
      return n.name || obj.name || '';
    }

    function cellSizeFor(key, radius) {
      if (/Platform|Pump/i.test(key)) return 256;
      if (radius >= 10) return 128;
      if (radius >= 4) return 112;
      return 96;
    }

    const scenery = [];
    const sceneRoot = gltf.scene;
    const perNode = new Map();
    sceneRoot.traverse((obj) => {
      if (!obj.isMesh) return;
      const n = obj.name || '';
      if (/^Moon_\d/i.test(n) || /^rts-moon-/i.test(n)) return;
      if (/^RTS_/i.test(n) || /light|camera|helper|grid/i.test(n)) return;
      if (!obj.geometry?.attributes?.position) return;
      const keyBase = nodeKey(obj, sceneRoot);
      const idx = perNode.get(keyBase) || 0;
      perNode.set(keyBase, idx + 1);
      const key = idx === 0 ? keyBase : `${keyBase}#${idx}`;
      scenery.push({ mesh: obj, key });
    });
    if (!scenery.length) throw new Error('no scenery meshes');

    function planarBasisForMesh(mesh, sunDir) {
      mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mesh);
      const c = new THREE.Vector3();
      box.getCenter(c);
      const axisU = new THREE.Vector3();
      const axisV = new THREE.Vector3();
      let up = new THREE.Vector3(0, 1, 0);
      if (Math.abs(sunDir.dot(up)) > 0.92) up.set(1, 0, 0);
      axisU.crossVectors(up, sunDir).normalize();
      axisV.crossVectors(sunDir, axisU).normalize();
      const corners = [
        new THREE.Vector3(box.min.x, box.min.y, box.min.z),
        new THREE.Vector3(box.min.x, box.min.y, box.max.z),
        new THREE.Vector3(box.min.x, box.max.y, box.min.z),
        new THREE.Vector3(box.min.x, box.max.y, box.max.z),
        new THREE.Vector3(box.max.x, box.min.y, box.min.z),
        new THREE.Vector3(box.max.x, box.min.y, box.max.z),
        new THREE.Vector3(box.max.x, box.max.y, box.min.z),
        new THREE.Vector3(box.max.x, box.max.y, box.max.z),
      ];
      let minU = Infinity;
      let maxU = -Infinity;
      let minV = Infinity;
      let maxV = -Infinity;
      for (const p of corners) {
        const d = p.clone().sub(c);
        const u = d.dot(axisU);
        const v = d.dot(axisV);
        if (u < minU) minU = u;
        if (u > maxU) maxU = u;
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
      const padU = Math.max(0.08, (maxU - minU) * 0.06);
      const padV = Math.max(0.08, (maxV - minV) * 0.06);
      minU -= padU;
      maxU += padU;
      minV -= padV;
      maxV += padV;
      const su = maxU - minU || 1;
      const sv = maxV - minV || 1;
      const originW = c.clone().addScaledVector(axisU, minU).addScaledVector(axisV, minV);
      const scaleUW = axisU.clone().multiplyScalar(1 / su);
      const scaleVW = axisV.clone().multiplyScalar(1 / sv);
      // Runtime sampling uses LOCAL space (survives ground parent xforms).
      const inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
      const originL = originW.clone().applyMatrix4(inv);
      const nrm = new THREE.Matrix3().getNormalMatrix(inv);
      const axisUL = scaleUW.clone().applyMatrix3(nrm);
      const axisVL = scaleVW.clone().applyMatrix3(nrm);
      return {
        // World — used only while baking the planar unwrap.
        originW: [originW.x, originW.y, originW.z],
        axisUW: [scaleUW.x, scaleUW.y, scaleUW.z],
        axisVW: [scaleVW.x, scaleVW.y, scaleVW.z],
        // Local — embedded for runtime.
        origin: [originL.x, originL.y, originL.z],
        axisU: [axisUL.x, axisUL.y, axisUL.z],
        axisV: [axisVL.x, axisVL.y, axisVL.z],
        space: 'local',
      };
    }

    const sunV = new THREE.Vector3(sunDir.x, sunDir.y, sunDir.z).normalize();
    if (Math.abs(sunV.y) < 0.08) {
      sunV.y = 0.08;
      sunV.normalize();
    }
    const castRatio = Math.hypot(sunV.x, sunV.z) / Math.max(sunV.y, 0.2);

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(64, 64, false);
    renderer.outputColorSpace = THREE.NoColorSpace || THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false;

    const meta = [];
    for (const { mesh, key } of scenery) {
      mesh.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(mesh);
      const c = box.getCenter(new THREE.Vector3());
      const s = box.getSize(new THREE.Vector3());
      const radius = 0.5 * Math.hypot(s.x, s.y, s.z);
      meta.push({
        mesh,
        key,
        box,
        center: c,
        radius,
        height: s.y,
        cell: cellSizeFor(key, radius),
      });
    }
    // Pack large cells first.
    meta.sort((a, b) => b.cell - a.cell || a.key.localeCompare(b.key));

    /** Shelf pack variable-size cells into square atlases. */
    function packCells(items, atlasSize) {
      const atlases = [{ x: 0, y: 0, rowH: 0, placed: [] }];
      for (const it of items) {
        const sz = it.cell;
        let placed = false;
        for (const a of atlases) {
          if (a.x + sz > atlasSize) {
            a.y += a.rowH;
            a.x = 0;
            a.rowH = 0;
          }
          if (a.y + sz > atlasSize) continue;
          a.placed.push({
            ...it,
            atlas: atlases.indexOf(a),
            px: a.x,
            py: a.y,
            sz,
          });
          a.x += sz;
          a.rowH = Math.max(a.rowH, sz);
          placed = true;
          break;
        }
        if (!placed) {
          const a = { x: sz, y: 0, rowH: sz, placed: [] };
          a.placed.push({ ...it, atlas: atlases.length, px: 0, py: 0, sz });
          atlases.push(a);
        }
      }
      return atlases;
    }

    const shelves = packCells(meta, atlas);
    const atlasCanvases = shelves.map(() => {
      const c = document.createElement('canvas');
      c.width = atlas;
      c.height = atlas;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, atlas, atlas);
      return { canvas: c, ctx };
    });

    const depthMat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.DoubleSide,
    });
    const dSize = Math.min(depthRes, 1536);
    const depthRT = new THREE.WebGLRenderTarget(dSize, dSize);
    const light = new THREE.DirectionalLight(0xffffff, 1);
    const lightHolder = new THREE.Scene();
    lightHolder.add(light);
    lightHolder.add(light.target);

    const SS = 2;
    const maxCell = 256;
    const selfRT = new THREE.WebGLRenderTarget(maxCell * SS, maxCell * SS, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const pixelsSS = new Uint8Array(maxCell * SS * maxCell * SS * 4);
    const cells = [];
    let totalShadowed = 0;
    let totalPx = 0;
    let done = 0;
    const total = meta.length;

    const allPlaced = shelves.flatMap((s) => s.placed);

    for (const item of allPlaced) {
      const { mesh, key, center: meshCenter, radius, height, cell: cellSz, atlas: atlasIndex, px, py, box: meshBox } =
        item;

      const castLen = Math.max(height, 0.5) * castRatio + 4;
      const localExt = Math.max(radius * 1.25 + castLen, 5);
      const dist = localExt * 4 + 16;
      light.position.copy(meshCenter).addScaledVector(sunV, dist);
      light.target.position.copy(meshCenter);
      lightHolder.updateMatrixWorld(true);
      light.shadow.camera.left = -localExt;
      light.shadow.camera.right = localExt;
      light.shadow.camera.top = localExt;
      light.shadow.camera.bottom = -localExt;
      light.shadow.camera.near = 0.1;
      light.shadow.camera.far = dist * 2 + 40;
      light.shadow.camera.updateProjectionMatrix();
      light.shadow.camera.position.setFromMatrixPosition(light.matrixWorld);
      light.shadow.camera.lookAt(meshCenter);
      light.shadow.camera.updateMatrixWorld(true);

      const depthScene = new THREE.Scene();
      const reach = localExt * 1.4;
      for (let j = 0; j < meta.length; j++) {
        if (meta[j].center.distanceTo(meshCenter) > reach + meta[j].radius) continue;
        const m = new THREE.Mesh(meta[j].mesh.geometry, depthMat);
        m.matrix.copy(meta[j].mesh.matrixWorld);
        m.matrixWorld.copy(meta[j].mesh.matrixWorld);
        m.matrixAutoUpdate = false;
        m.frustumCulled = false;
        depthScene.add(m);
      }
      renderer.setSize(dSize, dSize, false);
      renderer.setRenderTarget(depthRT);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(depthScene, light.shadow.camera);
      renderer.setRenderTarget(null);

      const shadowMatrix = new THREE.Matrix4().multiplyMatrices(
        light.shadow.camera.projectionMatrix,
        light.shadow.camera.matrixWorldInverse
      );
      const basis = planarBasisForMesh(mesh, sunV);
      const texel = 1 / dSize;

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          shadowMap: { value: depthRT.texture },
          shadowMatrix: { value: shadowMatrix },
          dark: { value: dark },
          origin: { value: new THREE.Vector3().fromArray(basis.originW) },
          axisU: { value: new THREE.Vector3().fromArray(basis.axisUW) },
          axisV: { value: new THREE.Vector3().fromArray(basis.axisVW) },
          texelSize: { value: texel },
        },
        vertexShader: /* glsl */ `
          uniform mat4 shadowMatrix;
          uniform vec3 origin;
          uniform vec3 axisU;
          uniform vec3 axisV;
          varying vec4 vShadowCoord;
          void main() {
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vShadowCoord = shadowMatrix * worldPos;
            vec3 d = worldPos.xyz - origin;
            vec2 puv = vec2(dot(d, axisU), dot(d, axisV));
            gl_Position = vec4(puv * 2.0 - 1.0, 0.0, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          #include <packing>
          uniform sampler2D shadowMap;
          uniform float dark;
          uniform float texelSize;
          varying vec4 vShadowCoord;
          float hardSample(vec2 uv, float z) {
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || z > 1.0) return 1.0;
            float depth = unpackRGBAToDepth(texture2D(shadowMap, uv));
            float bias = 0.0012 + 0.002 * (1.0 - abs(z - depth));
            return z - bias > depth ? dark : 1.0;
          }
          // 5×5 Poisson-ish PCF — soft penumbra, kills salt/pepper.
          float softShadow() {
            vec3 proj = vShadowCoord.xyz / vShadowCoord.w;
            proj = proj * 0.5 + 0.5;
            float sum = 0.0;
            float wsum = 0.0;
            for (int y = -2; y <= 2; y++) {
              for (int x = -2; x <= 2; x++) {
                float w = 1.0 - 0.15 * float(abs(x) + abs(y));
                vec2 uv = proj.xy + vec2(float(x), float(y)) * texelSize * 1.25;
                sum += hardSample(uv, proj.z) * w;
                wsum += w;
              }
            }
            return sum / wsum;
          }
          void main() {
            float s = softShadow();
            gl_FragColor = vec4(vec3(s), 1.0);
          }
        `,
        side: THREE.DoubleSide,
      });

      const uvScene = new THREE.Scene();
      const draw = new THREE.Mesh(mesh.geometry, mat);
      draw.matrix.copy(mesh.matrixWorld);
      draw.matrixWorld.copy(mesh.matrixWorld);
      draw.matrixAutoUpdate = false;
      draw.frustumCulled = false;
      uvScene.add(draw);

      // Neighbor cast onto this receiver (rock-cookie style): project casters onto
      // receiver height along the sun, stamp into the same planar cell. PCF alone
      // was leaving platform decks almost white (pump umbra never stuck).
      const groundY = meshBox.min.y + 0.04;
      const stampMat = new THREE.ShaderMaterial({
        uniforms: {
          origin: { value: new THREE.Vector3().fromArray(basis.originW) },
          axisU: { value: new THREE.Vector3().fromArray(basis.axisUW) },
          axisV: { value: new THREE.Vector3().fromArray(basis.axisVW) },
          dark: { value: dark },
        },
        vertexShader: /* glsl */ `
          uniform vec3 origin;
          uniform vec3 axisU;
          uniform vec3 axisV;
          void main() {
            vec3 d = position - origin;
            vec2 puv = vec2(dot(d, axisU), dot(d, axisV));
            gl_Position = vec4(puv * 2.0 - 1.0, 0.0, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float dark;
          void main() { gl_FragColor = vec4(vec3(dark), 1.0); }
        `,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        blending: THREE.MultiplyBlending,
        transparent: true,
      });
      const projected = [];
      for (let j = 0; j < meta.length; j++) {
        if (meta[j].mesh === mesh) continue;
        if (meta[j].center.distanceTo(meshCenter) > reach + meta[j].radius) continue;
        // NEVER stamp supporting terrain / rock under the receiver — that flooded
        // platform decks black. Only elevated neighbors (pump on deck, etc.).
        if (/^Moon_/i.test(meta[j].key)) continue;
        const sitsOnDeck = meta[j].box.min.y > groundY - 0.08;
        const elevated = meta[j].center.y > groundY + 0.35;
        if (!sitsOnDeck && !elevated) continue;
        // Skip huge casters that dwarf the receiver (cliff next to pad).
        if (meta[j].radius > radius * 2.5 && meta[j].height > height * 2) continue;
        const pgeo = meta[j].mesh.geometry.clone();
        pgeo.applyMatrix4(meta[j].mesh.matrixWorld);
        const ppos = pgeo.attributes.position;
        const Ly = Math.max(0.12, sunV.y);
        for (let vi = 0; vi < ppos.count; vi++) {
          const x = ppos.getX(vi);
          const y = ppos.getY(vi);
          const z = ppos.getZ(vi);
          // Only project verts that are above the deck (no underside fill).
          if (y < groundY - 0.05) {
            ppos.setXYZ(vi, -1e6, groundY, -1e6);
            continue;
          }
          const t = (y - groundY) / Ly;
          ppos.setXYZ(vi, x - sunV.x * t, groundY, z - sunV.z * t);
        }
        ppos.needsUpdate = true;
        const pm = new THREE.Mesh(pgeo, stampMat);
        pm.frustumCulled = false;
        pm.matrixAutoUpdate = false;
        pm.matrix.identity();
        pm.matrixWorld.identity();
        uvScene.add(pm);
        projected.push({ pm, pgeo });
      }

      const hi = cellSz * SS;
      renderer.setSize(hi, hi, false);
      renderer.setRenderTarget(selfRT);
      renderer.setViewport(0, 0, hi, hi);
      renderer.setScissor(0, 0, hi, hi);
      renderer.setScissorTest(true);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.autoClear = false;
      renderer.render(uvScene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
      renderer.autoClear = true;
      renderer.setScissorTest(false);
      const pix = new Uint8Array(hi * hi * 4);
      renderer.readRenderTargetPixels(selfRT, 0, 0, hi, hi, pix);
      renderer.setRenderTarget(null);
      mat.dispose();
      stampMat.dispose();
      for (const p of projected) {
        uvScene.remove(p.pm);
        p.pgeo.dispose();
      }

      // Box-downsample SS→1 then 3×3 blur into atlas cell.
      const down = new Float32Array(cellSz * cellSz);
      for (let y = 0; y < cellSz; y++) {
        for (let x = 0; x < cellSz; x++) {
          let acc = 0;
          for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
              const ry = hi - 1 - (y * SS + sy);
              acc += pix[(ry * hi + x * SS + sx) * 4];
            }
          }
          down[y * cellSz + x] = acc / (SS * SS);
        }
      }
      const soft = new Uint8Array(cellSz * cellSz);
      for (let y = 0; y < cellSz; y++) {
        for (let x = 0; x < cellSz; x++) {
          let acc = 0;
          let cnt = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              const yy = y + dy;
              if (xx < 0 || yy < 0 || xx >= cellSz || yy >= cellSz) continue;
              acc += down[yy * cellSz + xx];
              cnt++;
            }
          }
          soft[y * cellSz + x] = Math.round(acc / cnt);
        }
      }

      const img = atlasCanvases[atlasIndex].ctx.createImageData(cellSz, cellSz);
      let shadowed = 0;
      for (let y = 0; y < cellSz; y++) {
        for (let x = 0; x < cellSz; x++) {
          const v = soft[y * cellSz + x];
          const di = (y * cellSz + x) * 4;
          img.data[di] = v;
          img.data[di + 1] = v;
          img.data[di + 2] = v;
          img.data[di + 3] = 255;
          if (v < 245) shadowed++;
        }
      }
      // Atlas PNG y grows down; py is from top of shelf pack.
      atlasCanvases[atlasIndex].ctx.putImageData(img, px, py);

      const u0 = px / atlas;
      const v0 = 1 - (py + cellSz) / atlas;
      const u1 = (px + cellSz) / atlas;
      const v1 = 1 - py / atlas;

      totalShadowed += shadowed;
      totalPx += cellSz * cellSz;
      cells.push({
        key,
        atlas: atlasIndex,
        rect: [u0, v0, u1, v1],
        // Local (instanced / parented props).
        origin: basis.origin,
        axisU: basis.axisU,
        axisV: basis.axisV,
        // World (unique Mesh stamp — survives metalness + multi-primitive families).
        originW: basis.originW,
        axisUW: basis.axisUW,
        axisVW: basis.axisVW,
        cell: cellSz,
        shadowedFrac: shadowed / (cellSz * cellSz),
      });

      done++;
      if (done % 150 === 0) console.log('baked', done, '/', total, 'cell', cellSz);
    }

    selfRT.dispose();
    depthRT.dispose();
    depthMat.dispose();
    renderer.dispose();

    // Quality gate on platform deck cell.
    const plat = cells.find((c) => c.key === 'CIrcularPlatform_Merged');
    const pump = cells.find((c) => c.key === 'Pump_Merged' || c.key === 'Pump_Merged#7');

    const pngs = atlasCanvases.map((a) => a.canvas.toDataURL('image/png').split(',')[1]);
    return {
      scenery: scenery.length,
      atlas,
      depthRes: dSize,
      dark,
      sunDir: [sunV.x, sunV.y, sunV.z],
      shadowedFrac: totalPx ? totalShadowed / totalPx : 0,
      cells,
      pngs,
      sampleKeys: cells
        .filter((c) => /Platform|Pump|Cliff_185|Cliff_131/i.test(c.key))
        .slice(0, 40)
        .map((c) => ({
          key: c.key,
          shadowedFrac: c.shadowedFrac,
          atlas: c.atlas,
          cell: c.cell,
        })),
      platFrac: plat ? plat.shadowedFrac : null,
      pumpFrac: pump ? pump.shadowedFrac : null,
    };
  },
  {
    glbUrl: `http://127.0.0.1:${PORT}/assets/terrain/terrain-skirmish-1v1.glb`,
    sunDir: sun,
    atlas: ATLAS,
    depthRes: DEPTH,
    dark: DARK,
  }
);

await browser.close();
server.close();

if (!baked?.cells?.length || !baked?.pngs?.length) {
  console.error('FAIL: no prop self-shadow bake');
  process.exit(1);
}

fs.mkdirSync(SHOT, { recursive: true });
console.log(
  JSON.stringify(
    {
      scenery: baked.scenery,
      atlas: baked.atlas,
      atlases: baked.pngs.length,
      shadowedFrac: baked.shadowedFrac,
      dark: baked.dark,
      platFrac: baked.platFrac,
      pumpFrac: baked.pumpFrac,
      sampleKeys: baked.sampleKeys,
    },
    null,
    2
  )
);

if (baked.shadowedFrac < 0.005) {
  console.error('FAIL: prop self-shadow atlas too empty', baked.shadowedFrac);
  process.exit(1);
}

const parsed = parseGlb(fs.readFileSync(GLB_PATH));
let bin = Buffer.from(parsed.bin);
const json = parsed.json;
json.extras = json.extras || {};

// Always append fresh atlas images (variable pack may change count).
const atlasTexIndices = [];
for (let a = 0; a < baked.pngs.length; a++) {
  const png = Buffer.from(baked.pngs[a], 'base64');
  fs.writeFileSync(path.join(SHOT, `prop-self-shadow-atlas-${a}.png`), png);
  console.log('atlas', a, 'pngBytes', png.length);
  const ap = appendBytes(bin, png);
  bin = ap.bin;
  json.bufferViews.push({ buffer: 0, byteOffset: ap.byteOffset, byteLength: ap.byteLength });
  json.images.push({
    name: `prop_self_shadow_${a}`,
    mimeType: 'image/png',
    bufferView: json.bufferViews.length - 1,
  });
  json.samplers = json.samplers || [];
  json.samplers.push({
    name: `prop_self_shadow_clamp_${a}`,
    magFilter: 9729,
    minFilter: 9729,
    wrapS: 33071,
    wrapT: 33071,
  });
  json.textures.push({
    name: `prop_self_shadow_${a}`,
    sampler: json.samplers.length - 1,
    source: json.images.length - 1,
  });
  atlasTexIndices.push(json.textures.length - 1);
}

json.extras.rtsPropSelfShadows = {
  layout: 'planar-atlas',
  atlas: baked.atlas,
  dark: DARK,
  sunDir: baked.sunDir,
  atlases: atlasTexIndices,
  cells: baked.cells,
  shadowedFrac: baked.shadowedFrac,
  quality: 'pcf5-ss2-blur-local',
  space: 'local',
};

const out = writeGlb(json, bin);
fs.writeFileSync(GLB_PATH, out);
console.log(
  JSON.stringify(
    {
      out: GLB_PATH,
      bytes: out.length,
      cells: baked.cells.length,
      atlases: atlasTexIndices,
    },
    null,
    2
  )
);
console.log('PASS bake-prop-self-shadows (soft PCF)');
