#!/usr/bin/env node
/**
 * Bake soft sun occlusion into RGB lightmaps for HERO scenery only
 * (platform / pump / key cliffs). Uses TEXCOORD_1 when present (UE LM UV),
 * else planar unwrap. Writes extras.rtsHeroRgbLightmaps — cheap at runtime.
 *
 * Used when UE EPIC_lightmap_textures is empty (common if Lightmass didn't run).
 *
 *   node RTSVR5/scripts/bake-hero-rgb-lightmaps.mjs
 *
 * Env: CELL=512 DARK=0.42 AMB=0.55 DEPTH=1536 PORT=8796
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GLB_PATH = path.join(ROOT, 'assets', 'terrain', 'terrain-skirmish-1v1.glb');
const SHOT = path.join(ROOT, 'bench-poses');
const PORT = Number(process.env.PORT || 8796);
const CELL = Number(process.env.CELL || 512);
const DEPTH = Number(process.env.DEPTH || 1536);
const DARK = Math.min(0.85, Math.max(0.3, Number(process.env.DARK || 0.42)));
const AMB = Math.min(0.85, Math.max(0.35, Number(process.env.AMB || 0.55)));
const HERO_RE = /circularplatform|pump_merged|cliff_185|cliff_131/i;
const GAME_SUN = { x: -0.005, y: 55, z: -48.83 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

function parseGlb(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = dv.getUint32(12, true);
  let text = new TextDecoder().decode(buf.subarray(20, 20 + jsonLen));
  text = text.replace(/:\s*-?inf\b/gi, ':null').replace(/:\s*nan\b/gi, ':null');
  const json = JSON.parse(text);
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
      return { x: x / L, y: y / L, z: z / L };
    }
  }
  const L = Math.hypot(GAME_SUN.x, GAME_SUN.y, GAME_SUN.z) || 1;
  return { x: GAME_SUN.x / L, y: GAME_SUN.y / L, z: GAME_SUN.z / L };
}

/**
 * Drop planar self-shadow + prior hero LM atlas images. Never drop a
 * bufferView referenced by any accessor (that corrupted mesh indices).
 * Orphan PNG bytes may remain; Pages budget still OK after stopping re-append.
 */
function pruneShadowAtlases(json, bin) {
  delete json.extras?.rtsPropSelfShadows;
  delete json.extras?.rtsHeroRgbLightmaps;

  const dropImage = new Set();
  for (let i = 0; i < (json.images || []).length; i++) {
    const n = json.images[i]?.name || '';
    if (/^prop_self_shadow_/i.test(n) || /^hero_lm_/i.test(n)) dropImage.add(i);
  }
  if (!dropImage.size) return { json, bin: Buffer.from(bin) };

  const accessorViews = new Set();
  for (const acc of json.accessors || []) {
    if (acc.bufferView != null) accessorViews.add(acc.bufferView);
  }

  const dropTex = new Set();
  for (let i = 0; i < (json.textures || []).length; i++) {
    const src = json.textures[i]?.source;
    if (src != null && dropImage.has(src)) dropTex.add(i);
  }

  const dropView = new Set();
  for (const ii of dropImage) {
    const bv = json.images[ii]?.bufferView;
    if (bv == null) continue;
    if (accessorViews.has(bv)) {
      console.warn('skip dropping bufferView still used by accessor', bv);
      continue;
    }
    dropView.add(bv);
  }

  // Remap images / textures
  const imageMap = new Map();
  const newImages = [];
  for (let i = 0; i < json.images.length; i++) {
    if (dropImage.has(i)) continue;
    imageMap.set(i, newImages.length);
    newImages.push(json.images[i]);
  }
  const texMap = new Map();
  const newTextures = [];
  for (let i = 0; i < (json.textures || []).length; i++) {
    if (dropTex.has(i)) continue;
    const t = { ...json.textures[i] };
    if (t.source != null && imageMap.has(t.source)) t.source = imageMap.get(t.source);
    else if (t.source != null && !imageMap.has(t.source)) {
      console.warn('texture source missing after image drop', i, t.source);
    }
    texMap.set(i, newTextures.length);
    newTextures.push(t);
  }

  for (const mat of json.materials || []) {
    const rewrite = (slot) => {
      if (!slot || slot.index == null) return;
      if (texMap.has(slot.index)) slot.index = texMap.get(slot.index);
    };
    rewrite(mat.pbrMetallicRoughness?.baseColorTexture);
    rewrite(mat.pbrMetallicRoughness?.metallicRoughnessTexture);
    rewrite(mat.normalTexture);
    rewrite(mat.occlusionTexture);
    rewrite(mat.emissiveTexture);
  }

  const remExtraTex = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      if (s && s.textureIndex != null && texMap.has(s.textureIndex)) {
        s.textureIndex = texMap.get(s.textureIndex);
      }
    }
  };
  if (json.extras?.rtsMoonRockShadows) remExtraTex(json.extras.rtsMoonRockShadows);
  if (json.extras?.rtsMoonRgbLightmaps) remExtraTex(json.extras.rtsMoonRgbLightmaps);

  // If nothing safe to strip from BIN, only drop JSON image/texture entries
  // and leave orphan bytes (still removes runtime ink-blot + stops growth).
  if (!dropView.size) {
    json.images = newImages;
    json.textures = newTextures;
    // Fix image bufferView refs that survived
    console.log('pruned atlas JSON only (no safe BIN views to drop)', {
      droppedImages: dropImage.size,
      droppedTextures: dropTex.size,
    });
    return { json, bin: Buffer.from(bin) };
  }

  const viewMap = new Map();
  const newViews = [];
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < (json.bufferViews || []).length; i++) {
    if (dropView.has(i)) continue;
    const v = json.bufferViews[i];
    const end = (v.byteOffset | 0) + (v.byteLength | 0);
    if (v.byteLength < 1 || end > bin.length) {
      console.warn('bad bufferView kept as-is copy skip', i, v);
      // Keep a 4-byte stub so remaps stay aligned — better to fail loud
      throw new Error('corrupt bufferView ' + i + ' len=' + v.byteLength);
    }
    const slice = Buffer.from(bin.subarray(v.byteOffset, end));
    const pad = (4 - (slice.length % 4)) % 4;
    const nv = { buffer: 0, byteOffset: offset, byteLength: slice.length };
    if (v.byteStride != null) nv.byteStride = v.byteStride;
    if (v.target != null) nv.target = v.target;
    if (v.name) nv.name = v.name;
    viewMap.set(i, newViews.length);
    newViews.push(nv);
    chunks.push(slice);
    if (pad) chunks.push(Buffer.alloc(pad));
    offset += slice.length + pad;
  }

  for (const acc of json.accessors || []) {
    if (acc.bufferView == null) continue;
    if (!viewMap.has(acc.bufferView)) {
      throw new Error('accessor references dropped bufferView ' + acc.bufferView);
    }
    acc.bufferView = viewMap.get(acc.bufferView);
  }
  for (const img of newImages) {
    if (img.bufferView != null && viewMap.has(img.bufferView)) {
      img.bufferView = viewMap.get(img.bufferView);
    }
  }

  json.images = newImages;
  json.textures = newTextures;
  json.bufferViews = newViews;
  const newBin = Buffer.concat(chunks);
  console.log('pruned atlases', {
    droppedImages: dropImage.size,
    droppedTextures: dropTex.size,
    droppedViews: dropView.size,
    binBefore: bin.length,
    binAfter: newBin.length,
  });
  return { json, bin: newBin };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/scripts/bake-rock-shadows-page.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    return res.end('missing');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
  });
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const glbBuf = fs.readFileSync(GLB_PATH);
const parsed0 = parseGlb(glbBuf);
const sun = sunFromExtras(parsed0.json);
console.log('sun', sun, 'CELL', CELL, 'DARK', DARK, 'AMB', AMB);

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
page.on('console', (m) => {
  if (m.type() === 'error' || /hero|baked|FAIL/i.test(m.text())) console.log('page', m.text().slice(0, 200));
});
await page.goto(`http://127.0.0.1:${PORT}/scripts/bake-rock-shadows-page.html`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForFunction(() => window.__bakeReady === true, null, { timeout: 60000 });

const baked = await page.evaluate(
  async ({ glbUrl, sunDir, cell, depthRes, dark, amb, heroReSource }) => {
    const THREE = window.THREE;
    const heroRe = new RegExp(heroReSource, 'i');
    const loader = new window.GLTFLoader();
    const buf = await fetch(glbUrl).then((r) => r.arrayBuffer());
    const gltf = await new Promise((res, rej) => loader.parse(buf, '', res, rej));
    gltf.scene.updateMatrixWorld(true);

    const scenery = [];
    gltf.scene.traverse((obj) => {
      if (!obj.isMesh && !obj.isSkinnedMesh) return;
      const n = obj.name || obj.parent?.name || '';
      if (/^Moon_/i.test(n) || /^RTS_/i.test(n)) return;
      scenery.push(obj);
    });

    const heroes = scenery.filter((m) => heroRe.test(m.name || m.parent?.name || ''));
    if (!heroes.length) throw new Error('no hero meshes');

    // Group by root actor-ish name (strip SM_ / #suffix)
    function familyKey(mesh) {
      let n = mesh.name || '';
      n = n.replace(/^SM_/i, '');
      const p = mesh.parent?.name || '';
      if (/circularplatform|pump_merged|cliff_185|cliff_131/i.test(p)) n = p.replace(/^SM_/i, '');
      return n.replace(/#\d+$/, '') || n;
    }

    const byFam = new Map();
    for (const m of heroes) {
      const k = familyKey(m);
      if (!byFam.has(k)) byFam.set(k, []);
      byFam.get(k).push(m);
    }

    const sunV = new THREE.Vector3(sunDir.x, sunDir.y, sunDir.z).normalize();
    if (Math.abs(sunV.y) < 0.08) {
      sunV.y = 0.08;
      sunV.normalize();
    }

    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: true });
    renderer.setSize(64, 64, false);
    renderer.outputColorSpace = THREE.NoColorSpace || THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false;

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
    const selfRT = new THREE.WebGLRenderTarget(cell * SS, cell * SS);
    const entries = [];
    const pngs = [];

    for (const [fam, meshes] of byFam) {
      // Combined bounds for local sun camera
      const box = new THREE.Box3();
      for (const m of meshes) box.expandByObject(m);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = 0.5 * Math.hypot(size.x, size.y, size.z);
      const localExt = Math.max(radius * 1.35 + 4, 6);
      const dist = localExt * 4 + 16;
      light.position.copy(center).addScaledVector(sunV, dist);
      light.target.position.copy(center);
      lightHolder.updateMatrixWorld(true);
      light.shadow.camera.left = -localExt;
      light.shadow.camera.right = localExt;
      light.shadow.camera.top = localExt;
      light.shadow.camera.bottom = -localExt;
      light.shadow.camera.near = 0.1;
      light.shadow.camera.far = dist * 2 + 40;
      light.shadow.camera.updateProjectionMatrix();
      light.shadow.camera.position.setFromMatrixPosition(light.matrixWorld);
      light.shadow.camera.lookAt(center);
      light.shadow.camera.updateMatrixWorld(true);

      const depthScene = new THREE.Scene();
      // Always include other hero casters (pump↔platform) even if slightly outside radius.
      const reach = Math.max(localExt * 2.5, 18);
      for (const m of scenery) {
        const isHero = heroRe.test(m.name || m.parent?.name || '');
        const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
        if (!isHero && c.distanceTo(center) > reach + radius) continue;
        if (isHero && c.distanceTo(center) > reach * 2 + radius) continue;
        const dm = new THREE.Mesh(m.geometry, depthMat);
        dm.matrix.copy(m.matrixWorld);
        dm.matrixWorld.copy(m.matrixWorld);
        dm.matrixAutoUpdate = false;
        dm.frustumCulled = false;
        depthScene.add(dm);
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
      const texel = 1 / dSize;

      // Prefer planar-XZ for flat tops (platform/pump) — UE LM UV islands
      // under-shadowed the deck (~3% texels). Cliffs keep unique UV.
      const usePlanar = /circularplatform|pump/i.test(fam);
      let uvAttr = 'uv';
      let useLmUv = false;
      let bbox = null;
      if (usePlanar) {
        bbox = {
          min: [box.min.x, box.min.y, box.min.z],
          max: [box.max.x, box.max.y, box.max.z],
        };
      } else {
        for (const m of meshes) {
          if (m.geometry?.attributes?.uv2) {
            uvAttr = 'uv2';
            useLmUv = true;
            break;
          }
          if (m.geometry?.attributes?.uv1) {
            uvAttr = 'uv1';
            useLmUv = true;
            break;
          }
        }
      }

      const mat = new THREE.ShaderMaterial({
        uniforms: {
          shadowMap: { value: depthRT.texture },
          shadowMatrix: { value: shadowMatrix },
          dark: { value: dark },
          amb: { value: amb },
          texelSize: { value: texel },
          useLmUv: { value: useLmUv ? 1 : 0 },
          usePlanar: { value: usePlanar ? 1 : 0 },
          uvSet: { value: uvAttr === 'uv2' ? 2 : uvAttr === 'uv1' ? 1 : 0 },
          bboxMin: {
            value: usePlanar
              ? new THREE.Vector3(bbox.min[0], bbox.min[1], bbox.min[2])
              : new THREE.Vector3(),
          },
          bboxSize: {
            value: usePlanar
              ? new THREE.Vector3(
                  Math.max(1e-4, bbox.max[0] - bbox.min[0]),
                  1,
                  Math.max(1e-4, bbox.max[2] - bbox.min[2])
                )
              : new THREE.Vector3(1, 1, 1),
          },
        },
        vertexShader: /* glsl */ `
          attribute vec2 uv1;
          attribute vec2 uv2;
          uniform mat4 shadowMatrix;
          uniform float useLmUv;
          uniform float usePlanar;
          uniform float uvSet;
          uniform vec3 bboxMin;
          uniform vec3 bboxSize;
          varying vec4 vShadowCoord;
          void main() {
            vec4 worldPos = modelMatrix * vec4(position, 1.0);
            vShadowCoord = shadowMatrix * worldPos;
            vec2 u = uv;
            if (usePlanar > 0.5) {
              u = vec2(
                (worldPos.x - bboxMin.x) / bboxSize.x,
                (worldPos.z - bboxMin.z) / bboxSize.z
              );
            } else if (useLmUv > 0.5) {
              u = uvSet > 1.5 ? uv2 : uv1;
            }
            gl_Position = vec4(u * 2.0 - 1.0, 0.0, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          #include <packing>
          uniform sampler2D shadowMap;
          uniform float dark;
          uniform float amb;
          uniform float texelSize;
          varying vec4 vShadowCoord;
          float hardSample(vec2 uv, float z) {
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || z > 1.0) return 1.0;
            float depth = unpackRGBAToDepth(texture2D(shadowMap, uv));
            float bias = 0.0015;
            return z - bias > depth ? dark : 1.0;
          }
          float softShadow() {
            vec3 proj = vShadowCoord.xyz / vShadowCoord.w;
            proj = proj * 0.5 + 0.5;
            float sum = 0.0;
            float wsum = 0.0;
            for (int y = -2; y <= 2; y++) {
              for (int x = -2; x <= 2; x++) {
                float w = 1.0 - 0.12 * float(abs(x) + abs(y));
                vec2 uv = proj.xy + vec2(float(x), float(y)) * texelSize * 1.4;
                sum += hardSample(uv, proj.z) * w;
                wsum += w;
              }
            }
            float s = sum / wsum;
            // Remap lit→1, shadow→dark into amb..1 (soft fill, no ink blot)
            return mix(amb, 1.0, (s - dark) / max(1.0 - dark, 0.05));
          }
          void main() {
            float s = clamp(softShadow(), amb, 1.0);
            gl_FragColor = vec4(vec3(s), 1.0);
          }
        `,
        side: THREE.DoubleSide,
      });

      const uvScene = new THREE.Scene();
      for (const m of meshes) {
        const draw = new THREE.Mesh(m.geometry, mat);
        draw.matrix.copy(m.matrixWorld);
        draw.matrixWorld.copy(m.matrixWorld);
        draw.matrixAutoUpdate = false;
        draw.frustumCulled = false;
        uvScene.add(draw);
      }

      const hi = cell * SS;
      renderer.setSize(hi, hi, false);
      renderer.setRenderTarget(selfRT);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear();
      renderer.render(uvScene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
      const pix = new Uint8Array(hi * hi * 4);
      renderer.readRenderTargetPixels(selfRT, 0, 0, hi, hi, pix);
      renderer.setRenderTarget(null);
      mat.dispose();

      // Downsample + mild blur
      const canvas = document.createElement('canvas');
      canvas.width = cell;
      canvas.height = cell;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(cell, cell);
      let shadowed = 0;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          let acc = 0;
          for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
              const ry = hi - 1 - (y * SS + sy);
              acc += pix[(ry * hi + x * SS + sx) * 4];
            }
          }
          const v = Math.round(acc / (SS * SS));
          const di = (y * cell + x) * 4;
          img.data[di] = v;
          img.data[di + 1] = v;
          img.data[di + 2] = v;
          img.data[di + 3] = 255;
          if (v < 240) shadowed++;
        }
      }
      // 3x3 blur
      const soft = new Uint8ClampedArray(img.data);
      for (let y = 1; y < cell - 1; y++) {
        for (let x = 1; x < cell - 1; x++) {
          let acc = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              acc += img.data[((y + dy) * cell + (x + dx)) * 4];
            }
          }
          soft[(y * cell + x) * 4] = Math.round(acc / 9);
          soft[(y * cell + x) * 4 + 1] = Math.round(acc / 9);
          soft[(y * cell + x) * 4 + 2] = Math.round(acc / 9);
        }
      }
      img.data.set(soft);
      ctx.putImageData(img, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      pngs.push(dataUrl.split(',')[1]);
      entries.push({
        key: fam,
        layout: usePlanar ? 'planar-xz' : 'uv-rgb',
        texCoord: usePlanar ? 1 : uvAttr === 'uv2' ? 2 : uvAttr === 'uv1' ? 1 : 0,
        bbox: usePlanar ? bbox : undefined,
        cell,
        shadowedFrac: shadowed / (cell * cell),
        meshNames: meshes.map((m) => m.name),
      });
      console.log(
        'hero baked',
        fam,
        usePlanar ? 'planar-xz' : 'uv ' + uvAttr,
        'shadowed',
        (shadowed / (cell * cell)).toFixed(3)
      );
    }

    depthRT.dispose();
    selfRT.dispose();
    depthMat.dispose();
    renderer.dispose();
    return { entries, pngs, sunDir: [sunV.x, sunV.y, sunV.z], dark, amb, cell };
  },
  {
    glbUrl: `http://127.0.0.1:${PORT}/assets/terrain/terrain-skirmish-1v1.glb`,
    sunDir: sun,
    cell: CELL,
    depthRes: DEPTH,
    dark: DARK,
    amb: AMB,
    heroReSource: HERO_RE.source,
  }
);

await browser.close();
server.close();

if (!baked?.entries?.length) {
  console.error('FAIL: no hero lightmaps');
  process.exit(1);
}

fs.mkdirSync(SHOT, { recursive: true });
let { json, bin } = parseGlb(fs.readFileSync(GLB_PATH));
({ json, bin } = pruneShadowAtlases(json, bin));

json.extras = json.extras || {};
const atlasTexIndices = [];
for (let i = 0; i < baked.pngs.length; i++) {
  const png = Buffer.from(baked.pngs[i], 'base64');
  fs.writeFileSync(path.join(SHOT, `hero-lm-${baked.entries[i].key}.png`), png);
  const ap = appendBytes(bin, png);
  bin = ap.bin;
  json.bufferViews.push({ buffer: 0, byteOffset: ap.byteOffset, byteLength: ap.byteLength });
  json.images.push({
    name: `hero_lm_${baked.entries[i].key}`,
    mimeType: 'image/png',
    bufferView: json.bufferViews.length - 1,
  });
  json.samplers = json.samplers || [];
  json.samplers.push({
    magFilter: 9729,
    minFilter: 9729,
    wrapS: 33071,
    wrapT: 33071,
  });
  json.textures.push({
    name: `hero_lm_${baked.entries[i].key}`,
    sampler: json.samplers.length - 1,
    source: json.images.length - 1,
  });
  atlasTexIndices.push(json.textures.length - 1);
  baked.entries[i].textureIndex = atlasTexIndices[i];
}

json.extras.rtsHeroRgbLightmaps = {
  layout: 'mixed',
  sunDir: baked.sunDir,
  dark: baked.dark,
  amb: baked.amb,
  cell: baked.cell,
  maps: baked.entries,
};

const out = writeGlb(json, bin);
fs.writeFileSync(GLB_PATH, out);
console.log(
  JSON.stringify(
    {
      out: GLB_PATH,
      bytes: out.length,
      heroes: baked.entries.map((e) => ({
        key: e.key,
        texCoord: e.texCoord,
        shadowedFrac: e.shadowedFrac,
        textureIndex: e.textureIndex,
      })),
    },
    null,
    2
  )
);
if (out.length >= 100 * 1024 * 1024) {
  console.error('FAIL: GLB >= 100MB Pages limit');
  process.exit(2);
}
console.log('PASS bake-hero-rgb-lightmaps');
