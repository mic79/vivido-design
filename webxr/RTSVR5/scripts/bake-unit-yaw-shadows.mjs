#!/usr/bin/env node
/**
 * Bake per-type yaw shadow atlases (ground cookie + mesh self-shadow) for RTSVR5.
 *
 *   node RTSVR5/scripts/bake-unit-yaw-shadows.mjs
 *
 * Env: FRAMES=36 CELL=64 PORT=8795 DARK=0.32
 * Writes assets/shadows/yaw/<id>-ground.png, <id>-self.png, manifest.json
 *
 * Sun must match rock LM (`extras.rtsMoonRockShadows[].sunDir` from terrain GLB).
 * meshYawY must match renderer.js bakeBoxUnitGeometryFromGltfRoot yawY per type.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'assets', 'shadows', 'yaw');
const TERRAIN_GLB = path.join(ROOT, 'assets', 'terrain', 'terrain-skirmish-1v1.glb');
const PORT = Number(process.env.PORT || 8795);
const FRAMES = Math.max(1, Math.min(72, Number(process.env.FRAMES || 36)));
const CELL = Math.max(32, Math.min(256, Number(process.env.CELL || 128)));
/** Umbra floor (rock LM uses ~0.32). */
const DARK = Math.min(0.9, Math.max(0.05, Number(process.env.DARK || 0.32)));

/** Fallback if GLB extras missing — same as bake-rock-shadows GAME_SUN direction. */
const GAME_SUN_POS = { x: -0.005, y: 55, z: -48.83 };

function readRockSunDir() {
  try {
    const buf = fs.readFileSync(TERRAIN_GLB);
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    const extras = json.extras?.rtsMoonRockShadows;
    const list = Array.isArray(extras) ? extras : extras ? Object.values(extras) : [];
    const hit = list.find((e) => e && Array.isArray(e.sunDir) && e.sunDir.length >= 3);
    if (hit) {
      const [x, y, z] = hit.sunDir;
      const len = Math.hypot(x, y, z) || 1;
      return { x: x / len, y: y / len, z: z / len, source: 'terrain-glb' };
    }
  } catch (err) {
    console.warn('rock sunDir read failed', err?.message || err);
  }
  const L = Math.hypot(GAME_SUN_POS.x, GAME_SUN_POS.y, GAME_SUN_POS.z) || 1;
  return {
    x: GAME_SUN_POS.x / L,
    y: GAME_SUN_POS.y / L,
    z: GAME_SUN_POS.z / L,
    source: 'game-sun-fallback',
  };
}

const ROCK_SUN = readRockSunDir();
console.log('sunDir', ROCK_SUN);

/**
 * meshYawY: same radians as renderer bakeBoxUnitGeometryFromGltfRoot.
 * fitBox: {w,h,d} = UNIT_SHAPES × GLB_VISUAL_SCALE — bake must use min(sx,sy,sz)
 *   like runtime, NOT XZ-only (that blew up scoutBike/mobileHq/artillery cookies).
 * targetWidth: buildings only — footprint max(XZ) × visual scale.
 */
const ENTRIES = [
  {
    id: 'infantry',
    url: 'assets/Meshy_AI_Apollo_astronaut_with_0416105251_texture.glb',
    frames: FRAMES,
    meshYawY: 0,
    cookieScale: 1.15,
    // Cylinder fit ≈ rifleman height 1.6 / dominant radius band — keep XZ target.
    targetWidth: 1.2,
    types: ['rifleman', 'rocketSoldier', 'sniper', 'engineer'],
  },
  {
    id: 'harvester',
    url: 'assets/Meshy_AI_A_lunar_harvester_of_0417212738_texture.glb',
    frames: FRAMES,
    meshYawY: -Math.PI / 2,
    cookieScale: 1.15,
    fitBox: { width: 3.2, height: 2.0, depth: 4.0 },
    types: ['harvester'],
  },
  {
    id: 'lightTank',
    url: 'assets/Meshy_AI_A_lunar_light_tank_r_0417231220_texture.glb',
    frames: FRAMES,
    meshYawY: Math.PI / 2,
    cookieScale: 1.15,
    fitBox: { width: 2.8, height: 2.0, depth: 3.6 },
    types: ['lightTank'],
  },
  {
    id: 'heavyTank',
    url: 'assets/Meshy_AI_A_lunar_heavy_tank_r_0417233308_texture.glb',
    frames: FRAMES,
    meshYawY: Math.PI / 2,
    cookieScale: 1.15,
    fitBox: { width: 4.68, height: 3.12, depth: 5.72 },
    types: ['heavyTank'],
  },
  {
    id: 'mobileHq',
    url: 'assets/Meshy_AI_A_lunar_mobile_HQ_wh_0417234643_texture.glb',
    frames: FRAMES,
    meshYawY: Math.PI / 2,
    cookieScale: 1.15,
    fitBox: { width: 7.2, height: 4.6, depth: 9.6 },
    types: ['mobileHq'],
  },
  {
    id: 'scoutBike',
    url: 'assets/Meshy_AI_A_lunar_rover_realis_0417235006_texture.glb',
    frames: FRAMES,
    meshYawY: Math.PI / 2,
    cookieScale: 1.15,
    fitBox: { width: 3.2, height: 2.4, depth: 7.2 },
    types: ['scoutBike'],
  },
  {
    id: 'artillery',
    url: 'assets/Meshy_AI_A_lunar_artillery_tan_0418000218_texture.glb',
    frames: FRAMES,
    meshYawY: Math.PI / 2,
    cookieScale: 1.15,
    fitBox: { width: 4.68, height: 3.12, depth: 10.92 },
    types: ['artillery'],
  },
  {
    id: 'hq',
    url: 'assets/lunar-lander/lunar_lander.glb',
    frames: Math.min(FRAMES, 24),
    cell: 256,
    meshYawY: 0,
    cookieScale: 1.15,
    targetWidth: 24,
    types: ['hq'],
  },
  {
    id: 'barracks',
    url: 'assets/Meshy_AI_A_lunar_temporary_bar_0417224422_texture.glb',
    frames: Math.min(FRAMES, 16),
    meshYawY: 0,
    cookieScale: 1.15,
    targetWidth: 8,
    types: ['barracks'],
  },
  {
    id: 'warFactory',
    url: 'assets/Meshy_AI_A_lunar_temporary_gar_0417231334_texture.glb',
    frames: Math.min(FRAMES, 16),
    meshYawY: 0,
    cookieScale: 1.15,
    targetWidth: 10,
    types: ['warFactory'],
  },
  {
    id: 'refinery',
    url: 'assets/Meshy_AI_A_lunar_temporary_ref_0417211214_texture.glb',
    frames: Math.min(FRAMES, 16),
    meshYawY: 0,
    cookieScale: 1.15,
    targetWidth: 6,
    types: ['refinery'],
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

fs.mkdirSync(OUT, { recursive: true });

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/scripts/bake-unit-yaw-shadows-page.html';
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
  channel: 'chrome',
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
page.on('console', (msg) => console.log('page:', msg.type(), msg.text()));
page.on('pageerror', (err) => console.error('pageerror', err.message));
await page.goto(`http://127.0.0.1:${PORT}/scripts/bake-unit-yaw-shadows-page.html`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForFunction(() => window.__bakeReady === true, null, { timeout: 60000 });

const manifest = {
  version: 2,
  framesDefault: FRAMES,
  cell: CELL,
  dark: DARK,
  sunDir: { x: ROCK_SUN.x, y: ROCK_SUN.y, z: ROCK_SUN.z },
  sunSource: ROCK_SUN.source,
  /** Legacy position form (same ray) for older readers. */
  sun: {
    x: ROCK_SUN.x * 100,
    y: ROCK_SUN.y * 100,
    z: ROCK_SUN.z * 100,
  },
  entries: [],
};

for (const entry of ENTRIES) {
  const glbPath = path.join(ROOT, entry.url);
  if (!fs.existsSync(glbPath)) {
    console.warn('skip missing', entry.url);
    continue;
  }
  console.log('bake', entry.id, entry.frames, 'frames, meshYawY=', entry.meshYawY, '…');
  const result = await page.evaluate(
    async ({ id, url, frames, cell, dark, sunDir, meshYawY, cookieScale, targetWidth, fitBox }) => {
      const THREE = window.THREE;
      const loader = new window.GLTFLoader();
      const gltf = await new Promise((resolve, reject) => {
        loader.load(url, resolve, undefined, reject);
      });
      const root = gltf.scene || gltf.scenes[0];

      // Match renderer geometry yaw before centering/fitting.
      if (Math.abs(meshYawY) > 1e-8) {
        root.rotation.y = meshYawY;
      }
      root.updateMatrixWorld(true);

      // Same pivot as renderer computeBottomFootprintPivotAndScaleFactors:
      // mean XZ of bottom-band verts (lander is asymmetric — AABB center puts the
      // cookie on the wrong side of the mesh).
      function footprintPivot(obj) {
        obj.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(obj);
        const y0 = box.min.y;
        const ySpan = Math.max(1e-6, box.max.y - y0);
        const v = new THREE.Vector3();
        let cx = 0;
        let cz = 0;
        let n = 0;
        for (const frac of [0.04, 0.12, 0.35]) {
          const band = y0 + ySpan * frac;
          cx = 0;
          cz = 0;
          n = 0;
          obj.traverse((o) => {
            if (!o.isMesh || !o.geometry?.attributes?.position) return;
            const pos = o.geometry.attributes.position;
            for (let i = 0; i < pos.count; i++) {
              v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
              if (v.y <= band) {
                cx += v.x;
                cz += v.z;
                n++;
              }
            }
          });
          if (n >= 12) break;
        }
        if (n < 1) {
          cx = (box.min.x + box.max.x) * 0.5;
          cz = (box.min.z + box.max.z) * 0.5;
        } else {
          cx /= n;
          cz /= n;
        }
        return { cx, cz, y0, box };
      }

      let fp = footprintPivot(root);
      root.position.x -= fp.cx;
      root.position.z -= fp.cz;
      root.position.y -= fp.y0;
      root.updateMatrixWorld(true);
      fp = footprintPivot(root);
      const size = new THREE.Vector3();
      fp.box.getSize(size);
      // Units: same as renderer bakeBoxUnitGeometryFromGltfRoot — uniform scale
      // into the visual box (min of X/Y/Z ratios). XZ-only fit was the scoutBike /
      // mobileHq / artillery oversized-cookie bug.
      // Buildings/infantry: footprint max(XZ) → targetWidth.
      let fit = 1;
      if (fitBox && fitBox.width > 0 && fitBox.height > 0 && fitBox.depth > 0) {
        const sx = fitBox.width / Math.max(size.x, 1e-6);
        const sy = fitBox.height / Math.max(size.y, 1e-6);
        const sz = fitBox.depth / Math.max(size.z, 1e-6);
        fit = Math.min(sx, sy, sz);
      } else {
        const span = Math.max(size.x, size.z, 0.01);
        fit = targetWidth > 0 ? targetWidth / span : 1;
      }
      root.scale.setScalar(fit);
      root.updateMatrixWorld(true);
      // Re-seat after scale (scale is about local origin).
      fp = footprintPivot(root);
      root.position.x -= fp.cx;
      root.position.z -= fp.cz;
      root.position.y -= fp.y0;
      root.updateMatrixWorld(true);
      fp = footprintPivot(root);
      fp.box.getSize(size);
      {
        const parts = [];
        root.traverse((o) => {
          if (!o.isMesh) return;
          const b = new THREE.Box3().setFromObject(o);
          const s = new THREE.Vector3();
          b.getSize(s);
          parts.push(`${o.name || '?'}:${s.x.toFixed(1)}x${s.y.toFixed(1)}x${s.z.toFixed(1)}@y${b.min.y.toFixed(1)}`);
        });
        console.log('fit', id, 'size', size.x.toFixed(1), size.y.toFixed(1), size.z.toFixed(1), 'parts', parts.join(' | '));
      }

      // EXACT rock-LM sun. Any elevation tweak makes unit casts a different length
      // than the boulder shadows (that mismatch was user-visible).
      const bakeSun = { x: sunDir.x, y: sunDir.y, z: sunDir.z };
      {
        const L = Math.hypot(bakeSun.x, bakeSun.y, bakeSun.z) || 1;
        bakeSun.x /= L;
        bakeSun.y /= L;
        bakeSun.z /= L;
      }

      const renderer = new THREE.WebGLRenderer({
        antialias: false,
        preserveDrawingBuffer: true,
        alpha: true,
      });
      renderer.setSize(cell, cell);
      renderer.setPixelRatio(1);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setClearColor(0xffffff, 1);
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

      const sunHoriz = Math.hypot(bakeSun.x, bakeSun.z) || 0.01;
      const castRatio = sunHoriz / Math.max(bakeSun.y, 0.18);
      const castLen = Math.max(size.y, 0.5) * castRatio;
      // Yaw-independent reach: a vertex at XZ radius r and height y can land at most
      // r + y*castRatio from the pivot for ANY yaw. Tight cell = max resolution.
      let reach = 0.5;
      {
        const vv = new THREE.Vector3();
        root.updateMatrixWorld(true);
        root.traverse((o) => {
          if (!o.isMesh || !o.geometry?.attributes?.position) return;
          const pos = o.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            vv.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            const r = Math.hypot(vv.x, vv.z) + Math.max(0, vv.y) * castRatio;
            if (r > reach) reach = r;
          }
        });
      }
      const groundW = reach * cookieScale;
      console.log('reach', id, reach.toFixed(2), 'castRatio', castRatio.toFixed(2), 'halfM', groundW.toFixed(2));

      const groundCanvas = document.createElement('canvas');
      groundCanvas.width = cell * frames;
      groundCanvas.height = cell;
      const groundCtx = groundCanvas.getContext('2d');
      groundCtx.clearRect(0, 0, groundCanvas.width, groundCanvas.height);
      const selfCanvas = document.createElement('canvas');
      selfCanvas.width = cell * frames;
      selfCanvas.height = cell;
      const selfCtx = selfCanvas.getContext('2d');
      selfCtx.fillStyle = '#ffffff';
      selfCtx.fillRect(0, 0, selfCanvas.width, selfCanvas.height);

      const pivot = new THREE.Group();
      pivot.add(root);

      // Ground pass = SAME technique as bake-rock-shadows.mjs: every vertex is
      // slid along -sunDir onto y=0 and the flattened geometry is drawn black
      // (contact + cast as one hard silhouette, DoubleSide, no depth test).
      // Rendered at 2x and box-downsampled for the same soft-ish edge the 2048px
      // rock plate gets from bilinear filtering.
      const SS = 2;
      const groundRT = new THREE.WebGLRenderTarget(cell * SS, cell * SS, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        type: THREE.UnsignedByteType,
      });
      const blackMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      });
      const gCam = new THREE.OrthographicCamera(-groundW, groundW, groundW, -groundW, 0.1, 400);
      gCam.position.set(0, 100, 0);
      gCam.up.set(0, 0, -1); // +X right, +Z down in image (= PNG +Y)
      gCam.lookAt(0, 0, 0);
      gCam.updateProjectionMatrix();

      // Self-shadow light/shadow-camera (depth RT rendered explicitly below).
      const dist = Math.max(groundW * 4, size.y * 3 + 10, castLen * 2.5 + 8);
      const light = new THREE.DirectionalLight(0xffffff, 1);
      light.position.set(bakeSun.x * dist, bakeSun.y * dist, bakeSun.z * dist);
      light.target.position.set(0, size.y * 0.2, 0);
      light.castShadow = true;
      {
        const ext = groundW * 1.15;
        light.shadow.camera.left = -ext;
        light.shadow.camera.right = ext;
        light.shadow.camera.top = ext;
        light.shadow.camera.bottom = -ext;
        light.shadow.camera.near = 0.5;
        light.shadow.camera.far = dist * 2 + 30;
        light.shadow.camera.updateProjectionMatrix();
      }
      const lightHolder = new THREE.Scene();
      lightHolder.add(light);
      lightHolder.add(light.target);
      lightHolder.updateMatrixWorld(true);
      // Mirror DirectionalLightShadow.updateMatrices() so shadow.camera is placed.
      light.shadow.camera.position.setFromMatrixPosition(light.matrixWorld);
      {
        const tgt = new THREE.Vector3().setFromMatrixPosition(light.target.matrixWorld);
        light.shadow.camera.lookAt(tgt);
      }
      light.shadow.camera.updateMatrixWorld(true);

      for (let f = 0; f < frames; f++) {
        const yaw = (f / frames) * Math.PI * 2;
        pivot.rotation.y = yaw;
        pivot.updateMatrixWorld(true);

        const gScene = new THREE.Scene();
        gScene.background = new THREE.Color(0xffffff);
        const projected = [];
        const v = new THREE.Vector3();
        pivot.traverse((o) => {
          if (!o.isMesh || !o.geometry?.attributes?.position) return;
          const geo = o.geometry.clone();
          geo.applyMatrix4(o.matrixWorld);
          const pos = geo.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i);
            const t = Math.max(0, v.y) / bakeSun.y;
            pos.setXYZ(i, v.x - bakeSun.x * t, 0, v.z - bakeSun.z * t);
          }
          pos.needsUpdate = true;
          const m = new THREE.Mesh(geo, blackMat);
          m.frustumCulled = false;
          projected.push(m);
          gScene.add(m);
        });
        if (f === 0) console.log('project', id, 'meshes', projected.length);

        renderer.setRenderTarget(groundRT);
        renderer.setClearColor(0xffffff, 1);
        renderer.clear();
        renderer.render(gScene, gCam);
        const pixSS = new Uint8Array(cell * SS * cell * SS * 4);
        renderer.readRenderTargetPixels(groundRT, 0, 0, cell * SS, cell * SS, pixSS);
        renderer.setRenderTarget(null);
        for (const m of projected) m.geometry.dispose();

        const img = groundCtx.createImageData(cell, cell);
        let shadowPx = 0;
        let sumX = 0;
        let sumY = 0;
        let mass = 0;
        let minDy = cell;
        let maxDy = -1;
        const W = cell * SS;
        for (let y = 0; y < cell; y++) {
          for (let x = 0; x < cell; x++) {
            let acc = 0;
            for (let sy = 0; sy < SS; sy++) {
              for (let sx = 0; sx < SS; sx++) {
                // RT rows are bottom-up; PNG rows top-down.
                const ry = W - 1 - (y * SS + sy);
                acc += pixSS[(ry * W + x * SS + sx) * 4];
              }
            }
            const lit = acc / (SS * SS * 255); // 1 = lit, 0 = umbra
            const g = Math.round((dark + (1 - dark) * lit) * 255);
            if (g < 230) {
              shadowPx++;
              const mss = (255 - g) / 255;
              sumX += x * mss;
              sumY += y * mss;
              mass += mss;
              if (y < minDy) minDy = y;
              if (y > maxDy) maxDy = y;
            }
            const dst = (y * cell + x) * 4;
            img.data[dst] = g;
            img.data[dst + 1] = g;
            img.data[dst + 2] = g;
            img.data[dst + 3] = 255;
          }
        }
        groundCtx.putImageData(img, f * cell, 0);
        if (f === 0) {
          const cx = mass ? sumX / mass - cell / 2 : 0;
          const cy = mass ? sumY / mass - cell / 2 : 0;
          console.log(
            'bake ground frame0',
            id,
            'shadowPx',
            shadowPx,
            'areaM2',
            (shadowPx * ((groundW * 2) / cell) ** 2).toFixed(0),
            'centroidXY',
            cx.toFixed(1),
            cy.toFixed(1),
            'halfM',
            groundW.toFixed(2),
            'zExtentM',
            (((minDy - cell / 2) * groundW * 2) / cell).toFixed(1) +
              '..' +
              (((maxDy + 1 - cell / 2) * groundW * 2) / cell).toFixed(1),
            'expectZmax',
            (size.z / 2 + size.y * castRatio).toFixed(1)
          );
        }

        // Self-shadow via explicit RGBA depth map (Three r170 depth textures don't
        // sample correctly as sampler2D.r in a custom UV unwrap).
        const depthRT = new THREE.WebGLRenderTarget(1024, 1024);
        const depthMat = new THREE.MeshDepthMaterial({
          depthPacking: THREE.RGBADepthPacking,
          side: THREE.DoubleSide,
        });
        const depthScene = new THREE.Scene();
        depthScene.add(pivot);
        const shadowCam = light.shadow.camera;
        shadowCam.updateMatrixWorld(true);
        shadowCam.updateProjectionMatrix();
        const prevOM = depthScene.overrideMaterial;
        depthScene.overrideMaterial = depthMat;
        renderer.setRenderTarget(depthRT);
        renderer.setClearColor(0xffffff, 1);
        renderer.clear();
        renderer.render(depthScene, shadowCam);
        depthScene.overrideMaterial = prevOM;
        renderer.setRenderTarget(null);

        const shadowMatrix = new THREE.Matrix4().multiplyMatrices(
          light.shadow.camera.projectionMatrix,
          light.shadow.camera.matrixWorldInverse
        );

        const selfRT = new THREE.WebGLRenderTarget(cell, cell, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
        });
        const uvScene = new THREE.Scene();
        const shadowMats = [];
        pivot.updateMatrixWorld(true);
        pivot.traverse((o) => {
          if (!o.isMesh || !o.geometry) return;
          if (!o.geometry.attributes.uv) return;
          const mat = new THREE.ShaderMaterial({
            uniforms: {
              shadowMap: { value: depthRT.texture },
              shadowMatrix: { value: shadowMatrix },
              dark: { value: dark },
            },
            vertexShader: /* glsl */ `
              uniform mat4 shadowMatrix;
              varying vec4 vShadowCoord;
              void main() {
                vec4 worldPos = modelMatrix * vec4(position, 1.0);
                vShadowCoord = shadowMatrix * worldPos;
                gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
              }
            `,
            fragmentShader: /* glsl */ `
              #include <packing>
              uniform sampler2D shadowMap;
              uniform float dark;
              varying vec4 vShadowCoord;
              float shadowSample() {
                vec3 proj = vShadowCoord.xyz / vShadowCoord.w;
                proj = proj * 0.5 + 0.5;
                if (proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0) return 1.0;
                float depth = unpackRGBAToDepth(texture2D(shadowMap, proj.xy));
                float bias = 0.0025;
                return proj.z - bias > depth ? dark : 1.0;
              }
              void main() {
                float s = shadowSample();
                gl_FragColor = vec4(vec3(s), 1.0);
              }
            `,
            side: THREE.DoubleSide,
          });
          shadowMats.push(mat);
          const mesh = new THREE.Mesh(o.geometry, mat);
          mesh.matrix.copy(o.matrixWorld);
          mesh.matrixAutoUpdate = false;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          uvScene.add(mesh);
        });

        const uvCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        renderer.setRenderTarget(selfRT);
        renderer.setClearColor(0xffffff, 1);
        renderer.clear();
        if (uvScene.children.length) renderer.render(uvScene, uvCam);
        renderer.setRenderTarget(null);

        const selfPix = new Uint8Array(cell * cell * 4);
        renderer.readRenderTargetPixels(selfRT, 0, 0, cell, cell, selfPix);
        const selfImg = selfCtx.createImageData(cell, cell);
        let selfDark = 0;
        for (let i = 0; i < cell * cell; i++) {
          const srcRow = Math.floor(i / cell);
          const col = i % cell;
          const src = ((cell - 1 - srcRow) * cell + col) * 4;
          const lum = selfPix[src] / 255;
          if (lum < 0.95) selfDark++;
          const dst = i * 4;
          selfImg.data[dst] = Math.round(lum * 255);
          selfImg.data[dst + 1] = Math.round(lum * 255);
          selfImg.data[dst + 2] = Math.round(lum * 255);
          selfImg.data[dst + 3] = 255;
        }
        selfCtx.putImageData(selfImg, f * cell, 0);
        if (f === 0) console.log('bake self frame0', id, 'darkPx', selfDark, '/', cell * cell);

        for (const m of shadowMats) m.dispose();
        while (uvScene.children.length) uvScene.remove(uvScene.children[0]);
        selfRT.dispose();
        depthRT.dispose();
        depthMat.dispose();

        while (gScene.children.length) gScene.remove(gScene.children[0]);
      }

      groundRT.dispose();
      renderer.dispose();
      return {
        groundDataUrl: groundCanvas.toDataURL('image/png'),
        selfDataUrl: selfCanvas.toDataURL('image/png'),
        groundHalf: groundW,
        size: { x: size.x, y: size.y, z: size.z },
        meshYawY,
      };
    },
    {
      id: entry.id,
      url: '/' + entry.url.replace(/\\/g, '/'),
      frames: entry.frames,
      cell: entry.cell || CELL,
      dark: DARK,
      sunDir: { x: ROCK_SUN.x, y: ROCK_SUN.y, z: ROCK_SUN.z },
      meshYawY: entry.meshYawY || 0,
      cookieScale: entry.cookieScale,
      targetWidth: entry.targetWidth || 0,
      fitBox: entry.fitBox || null,
    }
  );

  function dataUrlToPng(dataUrl, file) {
    const b64 = dataUrl.split(',')[1];
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  }
  const groundFile = `${entry.id}-ground.png`;
  const selfFile = `${entry.id}-self.png`;
  dataUrlToPng(result.groundDataUrl, path.join(OUT, groundFile));
  dataUrlToPng(result.selfDataUrl, path.join(OUT, selfFile));
  manifest.entries.push({
    id: entry.id,
    types: entry.types,
    frames: entry.frames,
    cell: entry.cell || CELL,
    ground: groundFile,
    self: selfFile,
    groundHalfM: result.groundHalf,
    dark: DARK,
    meshYawY: entry.meshYawY || 0,
  });
  console.log('  wrote', groundFile, selfFile, 'half', result.groundHalf.toFixed(2));
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('manifest', path.join(OUT, 'manifest.json'));
await browser.close();
server.close();
