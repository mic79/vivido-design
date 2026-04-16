/**
 * Moon ground — RTS-scale subtle height. **Albedo must stay full-range** (`color` white); micro-contrast
 * from Poly Haven `moon_01` **JPG** normal / rough / AO shipped under `assets/textures/moon_01_2k/` (CC0).
 */

const MAP = 200;

const BATTLE_MOON = {
  diff: 'assets/textures/moon_01_2k/moon_01_diff_2k.jpg',
};

/**
 * Diffuse / data map repeats per 200 m side — **~3.35** keeps the playable patch sharp (not “zoomed”
 * like very low repeats). Skirts use the same value; anti-tile warp ramps in **outside** the MAP square.
 */
const MOON_UV_REPEAT = 3.35;

/**
 * World-XZ UV skew that **ramps in past the playable square** so the 200×200 m area stays
 * axis-aligned while skirts break tiling. Chebyshev distance from the MAP AABB; long **ramp** + mild,
 * **low-frequency** skew avoids harsh “diamond” lighting / streaky normal-map seams at the boundary.
 */
function warpMoonTerrainUv(wx, wz) {
  const half = MAP * 0.5;
  let u = (wx + half) / MAP;
  let v = (-wz + half) / MAP;
  const cheb = Math.max(Math.abs(wx), Math.abs(wz));
  const outside = cheb - half;
  const rampM = 98;
  const t = outside <= 0 ? 0 : smoothstep01(outside / rampM);
  const blend = t * t;
  const du =
    0.14 * Math.sin(wz * 0.0064 + wx * 0.0022) + 0.08 * Math.cos(wx * 0.011 + wz * 0.0036);
  const dv =
    0.14 * Math.sin(wx * 0.0061 + wz * 0.0023) + 0.07 * Math.cos(wz * 0.0105 + wx * 0.0031);
  u += du * blend;
  v += dv * blend;
  return { u, v };
}

function applyWarpedMoonTerrainUvs(geometry) {
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  if (!pos || !uv) return;
  const pa = pos.array;
  const ua = uv.array;
  for (let i = 0, j = 0; i < pa.length; i += 3, j += 2) {
    const wx = pa[i];
    const wz = -pa[i + 1];
    const w = warpMoonTerrainUv(wx, wz);
    ua[j] = w.u;
    ua[j + 1] = w.v;
  }
  uv.needsUpdate = true;
}

/** Tangents for normal-mapped ground after custom UVs (avoids streaky TBN at skirt ↔ playfield). */
function computeMoonGroundTangents(geometry) {
  if (!geometry || !geometry.index || typeof geometry.computeTangents !== 'function') return;
  try {
    geometry.computeTangents();
    const t = geometry.attributes.tangent;
    if (t) t.needsUpdate = true;
  } catch (_) {
    /* degenerate tris / WebGL1 */
  }
}

/** Tangents from `moon_01_nor_gl` (JPG or local). */
const MOON_NORMAL_SCALE = 1.0;
/** Until `nor_gl` JPG loads, bump-from-diffuse. */
const MOON_BUMP_SCALE = 0.4;

function assetUrlCandidates(relativePath) {
  const out = [];
  try {
    out.push(new URL(`../${relativePath}`, import.meta.url).href);
  } catch (_) {
    /* opaque origin / file */
  }
  out.push(relativePath);
  return out;
}

/**
 * Gentle **fictitious** sphere sag so the playfield rolls slightly toward the horizon (edges drop vs center).
 * Real lunar curvature over 200 m is negligible (~mm); this is purely visual “infinite plain” read.
 * `window.RTS_MOON_CURVATURE_RADIUS` — sphere radius in **meters** (larger = flatter). `0` disables.
 * Default ~3.5 km → ~1.4 m drop at the 100 m rim (readable “surface” roll). Try ~9000 for subtler sag.
 */
function moonHorizonCurvatureRadiusM() {
  if (typeof window !== 'undefined' && window.RTS_MOON_CURVATURE_RADIUS === 0) return Infinity;
  if (
    typeof window !== 'undefined' &&
    Number.isFinite(window.RTS_MOON_CURVATURE_RADIUS) &&
    window.RTS_MOON_CURVATURE_RADIUS > 0
  ) {
    return Math.max(400, window.RTS_MOON_CURVATURE_RADIUS);
  }
  return 3500;
}

function moonHorizonSagY(wx, wz) {
  const R = moonHorizonCurvatureRadiusM();
  if (!Number.isFinite(R) || R > 1e9) return 0;
  const r2 = wx * wx + wz * wz;
  return -r2 / (2 * R);
}

// --- Low macro relief for RTS (flat-ish tactics plane); detail comes from textures + normals ---
const BATTLE_TERRAIN = {
  width: MAP,
  depth: MAP,
  segmentsWidth: 96,
  segmentsDepth: 96,
  scale: 50,
  octaves: 6,
  gain: 0.44,
  lacunarity: 2.0,
  /** Subtle silhouette only (~±1 m); not the large Zero-G waves. */
  amp: 2.2,
};

function battleTerrainHash(px, py, pz) {
  let x = Math.abs(px);
  let y = Math.abs(py);
  let z = Math.abs(pz);
  x = ((x * 0.3183099 + 0.1) % 1);
  y = ((y * 0.3183099 + 0.1) % 1);
  z = ((z * 0.3183099 + 0.1) % 1);
  return (x * y * z * 17) % 1;
}

function battleTerrainNoise(x, y, z) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);

  const a = battleTerrainHash(ix, iy, iz);
  const b = battleTerrainHash(ix + 1, iy, iz);
  const c = battleTerrainHash(ix, iy + 1, iz);
  const d = battleTerrainHash(ix + 1, iy + 1, iz);
  const e = battleTerrainHash(ix, iy, iz + 1);
  const f = battleTerrainHash(ix + 1, iy, iz + 1);
  const g = battleTerrainHash(ix, iy + 1, iz + 1);
  const h = battleTerrainHash(ix + 1, iy + 1, iz + 1);

  const k0 = a + (b - a) * u;
  const k1 = c + (d - c) * u;
  const k2 = e + (f - e) * u;
  const k3 = g + (h - g) * u;

  return k0 + (k1 - k0) * v + (k2 + (k3 - k2) * v - (k0 + (k1 - k0) * v)) * w;
}

function battleTerrainFbm(x, y, z) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  for (let i = 0; i < BATTLE_TERRAIN.octaves; i++) {
    value += amplitude * battleTerrainNoise(x * frequency, y * frequency, z * frequency);
    frequency *= BATTLE_TERRAIN.lacunarity;
    amplitude *= BATTLE_TERRAIN.gain;
  }
  return value;
}

/**
 * World-space ground Y at (wx, wz). Matches `PlaneGeometry` displacement + mesh `rotation.x = -π/2`
 * (plane x → world x, plane y → world -z, displaced plane z → world y).
 */
export function sampleMoonTerrainWorldY(wx, wz) {
  if (!Number.isFinite(wx) || !Number.isFinite(wz)) return 0;
  const half = MAP * 0.5;
  const cx = Math.max(-half, Math.min(half, wx));
  const cz = Math.max(-half, Math.min(half, wz));
  const planeX = cx;
  const planeY = -cz;
  const noiseVal = battleTerrainFbm(planeX / BATTLE_TERRAIN.scale, 0, planeY / BATTLE_TERRAIN.scale) - 0.5;
  return noiseVal * BATTLE_TERRAIN.amp + moonHorizonSagY(wx, wz);
}

/** Same noise + sag as the mesh, but **uncapped** world XZ so skirts continue FBM past the playable square. */
function sampleMoonTerrainWorldYVisual(wx, wz) {
  if (!Number.isFinite(wx) || !Number.isFinite(wz)) return 0;
  const planeX = wx;
  const planeY = -wz;
  const noiseVal = battleTerrainFbm(planeX / BATTLE_TERRAIN.scale, 0, planeY / BATTLE_TERRAIN.scale) - 0.5;
  const half = MAP * 0.5;
  const edge = Math.max(Math.abs(wx), Math.abs(wz));
  let damp = 1;
  if (edge > half * 0.9) {
    damp = 1 - 0.28 * smoothstep01((edge - half * 0.9) / Math.max(half * 0.35, horizonSkirtDepthM() * 0.12));
  }
  return noiseVal * BATTLE_TERRAIN.amp * damp + moonHorizonSagY(wx, wz);
}

/**
 * Continuation meshes outside the playable MAP square (same material as core terrain).
 * Default **~0.92 km** past each edge so the hard cutoff sits far outside typical RTS framing / VR FOV.
 * `window.RTS_HORIZON_SKIRT_DEPTH` — meters (clamped ~80–2800).
 */
function horizonSkirtDepthM() {
  if (typeof window !== 'undefined' && Number.isFinite(window.RTS_HORIZON_SKIRT_DEPTH)) {
    return Math.max(80, Math.min(2800, window.RTS_HORIZON_SKIRT_DEPTH));
  }
  return 920;
}

let horizonSkirtAttached = false;

function buildTerrainSkirtPatchGeometry(THREE, wx0, wx1, wz0, wz1, segX, segZ) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let iz = 0; iz <= segZ; iz++) {
    const tz = iz / segZ;
    const wz = wz0 + (wz1 - wz0) * tz;
    for (let ix = 0; ix <= segX; ix++) {
      const tx = ix / segX;
      const wx = wx0 + (wx1 - wx0) * tx;
      const h = sampleMoonTerrainWorldYVisual(wx, wz);
      positions.push(wx, -wz, h);
      const wuv = warpMoonTerrainUv(wx, wz);
      uvs.push(wuv.u, wuv.v);
    }
  }
  const row = segX + 1;
  for (let iz = 0; iz < segZ; iz++) {
    for (let ix = 0; ix < segX; ix++) {
      const a = iz * row + ix;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  duplicateUvForAoMap(geom);
  computeMoonGroundTangents(geom);
  return geom;
}

function disposeHorizonSkirtUnder(mesh) {
  const g = mesh.getObjectByName('rts-horizon-skirt');
  if (!g) return;
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
  mesh.remove(g);
}

function tryAttachHorizonSkirt(THREE, mesh) {
  if (!mesh || !mesh.material || horizonSkirtAttached) return;
  horizonSkirtAttached = true;
  disposeHorizonSkirtUnder(mesh);
  const half = MAP * 0.5;
  const d = horizonSkirtDepthM();
  const g = new THREE.Group();
  g.name = 'rts-horizon-skirt';
  const mat = mesh.material;
  /**
   * Match core `PlaneGeometry(segmentsWidth × segmentsDepth)` along every **200 m** shared edge so
   * vertices line up with the playable plate (no T-junction height gaps). Use one **segDeep** for all
   * **d m** edges so strips ↔ corners share the same vertex count on seams.
   */
  const segAlongX = BATTLE_TERRAIN.segmentsWidth;
  const segAlongZ = BATTLE_TERRAIN.segmentsDepth;
  const segDeep = Math.max(44, Math.min(160, Math.ceil(d / 8)));
  const addPatch = (wx0, wx1, wz0, wz1, sx, sz) => {
    const geo = buildTerrainSkirtPatchGeometry(THREE, wx0, wx1, wz0, wz1, sx, sz);
    const m = new THREE.Mesh(geo, mat);
    m.receiveShadow = true;
    m.castShadow = false;
    m.frustumCulled = false;
    g.add(m);
  };
  addPatch(-half, half, half, half + d, segAlongX, segDeep);
  addPatch(-half, half, -half - d, -half, segAlongX, segDeep);
  addPatch(half, half + d, -half, half, segDeep, segAlongZ);
  addPatch(-half - d, -half, -half, half, segDeep, segAlongZ);
  addPatch(half, half + d, half, half + d, segDeep, segDeep);
  addPatch(-half - d, -half, half, half + d, segDeep, segDeep);
  addPatch(half, half + d, -half - d, -half, segDeep, segDeep);
  addPatch(-half - d, -half, -half - d, -half, segDeep, segDeep);
  mesh.add(g);
}

function buildBattleTerrainGeometry(THREE) {
  const geometry = new THREE.PlaneGeometry(
    BATTLE_TERRAIN.width,
    BATTLE_TERRAIN.depth,
    BATTLE_TERRAIN.segmentsWidth,
    BATTLE_TERRAIN.segmentsDepth
  );
  const vertices = geometry.attributes.position.array;
  const Rcurv = moonHorizonCurvatureRadiusM();
  const inv2R = Number.isFinite(Rcurv) && Rcurv < 1e9 ? 1 / (2 * Rcurv) : 0;
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i];
    const z = vertices[i + 1];
    const noiseVal = battleTerrainFbm(x / BATTLE_TERRAIN.scale, 0, z / BATTLE_TERRAIN.scale) - 0.5;
    const r2 = x * x + z * z;
    vertices[i + 2] = noiseVal * BATTLE_TERRAIN.amp - r2 * inv2R;
  }
  geometry.computeVertexNormals();
  geometry.attributes.position.needsUpdate = true;
  applyWarpedMoonTerrainUvs(geometry);
  duplicateUvForAoMap(geometry);
  computeMoonGroundTangents(geometry);
  return geometry;
}

/** `MeshStandardMaterial.aoMap` samples `uv2` in recent Three; duplicate `uv` if missing. */
function duplicateUvForAoMap(geometry) {
  if (!geometry || geometry.getAttribute('uv2')) return;
  const uv = geometry.getAttribute('uv');
  if (!uv) return;
  const THREE = window.THREE;
  if (!THREE) return;
  const copy = uv.array.slice();
  geometry.setAttribute('uv2', new THREE.BufferAttribute(copy, 2));
}

function smoothstep01(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function hash01(i, j, salt = 0) {
  const s =
    Math.imul(i ^ 0x9e3779b1, 0x85ebca6b) ^
    Math.imul(j ^ 0x9e3779b9, 0xc2b2ae35) ^
    Math.imul(salt | 0, 0x165667b1);
  const x = Math.sin(s * 0.0001) * 43758.5453123;
  return x - Math.floor(x);
}

function valueNoise(wx, wz, scale) {
  const x = wx * scale;
  const z = wz * scale;
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fz = z - z0;
  const u = smoothstep01(fx);
  const v = smoothstep01(fz);
  const a = hash01(x0, z0, 0);
  const b = hash01(x0 + 1, z0, 0);
  const c = hash01(x0, z0 + 1, 0);
  const d = hash01(x0 + 1, z0 + 1, 0);
  const ab = a * (1 - u) + b * u;
  const cd = c * (1 - u) + d * u;
  return ab * (1 - v) + cd * v;
}

function regolithBase(wx, wz) {
  let n = 0;
  n += 0.45 * valueNoise(wx, wz, 0.018);
  n += 0.28 * valueNoise(wx, wz, 0.042);
  n += 0.18 * valueNoise(wx, wz, 0.09);
  n += 0.12 * valueNoise(wx, wz, 0.19);
  const mare = smoothstep01((n - 0.38) * 2.2);
  const grain = 0.5 + 0.5 * Math.sin(wx * 0.71 + wz * 0.53) * Math.cos(wx * 0.31 - wz * 0.47);
  const lum = 0.38 + n * 0.28 + grain * 0.04 - mare * 0.22;
  return { lum: Math.max(0.06, Math.min(0.92, lum)), mare };
}

function craterMod(wx, wz) {
  const CELL = 8.5;
  const ci = Math.floor((wx + MAP * 0.5) / CELL);
  const cj = Math.floor((wz + MAP * 0.5) / CELL);
  let mult = 1;
  let rim = 0;
  for (let di = -2; di <= 2; di++) {
    for (let dj = -2; dj <= 2; dj++) {
      const i = ci + di;
      const j = cj + dj;
      const h0 = hash01(i, j, 1);
      const h1 = hash01(i, j, 2);
      const h2 = hash01(i, j, 3);
      const h3 = hash01(i, j, 4);
      if (h3 > 0.78) continue;
      const cx = -MAP * 0.5 + (i + 0.12 + h0 * 0.76) * CELL;
      const cz = -MAP * 0.5 + (j + 0.12 + h1 * 0.76) * CELL;
      const r = 0.35 + h2 * h2 * 5.8;
      const d = Math.hypot(wx - cx, wz - cz);
      if (d >= r * 1.14) continue;
      const u = d / r;
      if (u < 0.8) {
        const bowl = smoothstep01(u / 0.8);
        mult *= 0.38 + 0.62 * (1 - bowl * 0.88);
      } else if (u < 1.06) {
        const t = (u - 0.8) / 0.26;
        rim += 0.14 * Math.sin(t * Math.PI);
      }
    }
  }
  return { mult, rim };
}

function buildProceduralMoonTexture(THREE, sceneEl) {
  const W = 512;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let py = 0; py < H; py++) {
    const wz = ((py + 0.5) / H - 0.5) * MAP;
    for (let px = 0; px < W; px++) {
      const wx = ((px + 0.5) / W - 0.5) * MAP;
      const { lum: lum0, mare } = regolithBase(wx, wz);
      const { mult, rim } = craterMod(wx, wz);
      let lum = lum0 * mult + rim - mare * 0.06;
      lum = Math.max(0.05, Math.min(0.96, lum));
      const t = lum;
      // Single-channel gray (moon is ~achromatic; old R>G>B + warm read yellow-brown).
      const v = (88 + t * 118) | 0;
      const idx = (py * W + px) * 4;
      d[idx] = v;
      d[idx + 1] = v;
      d[idx + 2] = v;
      d[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(1, 1);
  const renderer = sceneEl && sceneEl.renderer;
  if (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  } else {
    tex.anisotropy = 4;
  }
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function configureMoonDiffuseTexture(tex, THREE, sceneEl) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(MOON_UV_REPEAT, MOON_UV_REPEAT);
  const renderer = sceneEl && sceneEl.renderer;
  if (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
    const cap = renderer.capabilities.getMaxAnisotropy();
    tex.anisotropy = Math.min(16, cap);
  } else {
    tex.anisotropy = 8;
  }
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  if ('colorSpace' in tex && THREE.SRGBColorSpace) {
    tex.colorSpace = THREE.SRGBColorSpace;
  } else if (THREE.sRGBEncoding !== undefined) {
    tex.encoding = THREE.sRGBEncoding;
  }
}

/** Normal / rough / AO: linear data in textures, tiled like diffuse. */
function configureMoonDataTexture(tex, THREE, sceneEl) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(MOON_UV_REPEAT, MOON_UV_REPEAT);
  const renderer = sceneEl && sceneEl.renderer;
  if (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
    const cap = renderer.capabilities.getMaxAnisotropy();
    tex.anisotropy = Math.min(16, cap);
  } else {
    tex.anisotropy = 8;
  }
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  if ('colorSpace' in tex && THREE.NoColorSpace) {
    tex.colorSpace = THREE.NoColorSpace;
  }
}

function collectMoonNorJpgUrls() {
  return assetUrlCandidates('assets/textures/moon_01_2k/moon_01_nor_gl_2k.jpg');
}

function collectMoonRoughJpgUrls() {
  return assetUrlCandidates('assets/textures/moon_01_2k/moon_01_rough_2k.jpg');
}

function collectMoonAoJpgUrls() {
  return assetUrlCandidates('assets/textures/moon_01_2k/moon_01_ao_2k.jpg');
}

/**
 * Loads `nor_gl` / `rough` / `AO` JPGs with the same `THREE.TextureLoader` as the scene (fixes “no pop”
 * when CDN EXRLoader used a different Three module and never attached).
 */
function attachMoonSurfaceTextureMaps(THREE, sceneEl, material) {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');

  const norUrls = collectMoonNorJpgUrls();
  loadTextureChain(
    loader,
    norUrls,
    0,
    (norTex) => {
      configureMoonDataTexture(norTex, THREE, sceneEl);
      material.normalMap = norTex;
      material.normalScale.set(MOON_NORMAL_SCALE, MOON_NORMAL_SCALE);
      material.bumpMap = null;
      material.bumpScale = 0;
      material.needsUpdate = true;

      const roughUrls = collectMoonRoughJpgUrls();
      loadTextureChain(
        loader,
        roughUrls,
        0,
        (roughTex) => {
          configureMoonDataTexture(roughTex, THREE, sceneEl);
          material.roughnessMap = roughTex;
          material.roughness = 1;
          material.needsUpdate = true;
        },
        () => {}
      );

      const aoUrls = collectMoonAoJpgUrls();
      loadTextureChain(
        loader,
        aoUrls,
        0,
        (aoTex) => {
          configureMoonDataTexture(aoTex, THREE, sceneEl);
          material.aoMap = aoTex;
          material.aoMapIntensity = 1;
          material.needsUpdate = true;
        },
        () => {}
      );
    },
    () => {}
  );
}

/** Slightly lift exposure so Poly Haven albedo + AO read closer to reference. */
export function configureTerrainPresentation(sceneEl) {
  const THREE = window.THREE;
  const r = sceneEl && sceneEl.renderer;
  if (!r || !THREE) return;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = 1.06;
}

function disposeMaterial(mat) {
  if (mat && mat.dispose) mat.dispose();
}

function styleMoonGrid() {
  const mount = document.getElementById('gridHelper');
  const root = mount && mount.object3D;
  if (!root) return;
  root.traverse((obj) => {
    if (!obj.isLineSegments || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      m.transparent = true;
      m.opacity = 0.1;
      m.depthWrite = false;
      if (i === 0) m.color.setHex(0x5a5a64);
      else m.color.setHex(0x404048);
    }
  });
}

function collectFallbackDiffuseUrls() {
  const names = ['moon-ground.jpg', 'moon-ground.png', 'moon-ground.webp'];
  const paths = [];
  if (typeof window !== 'undefined' && window.RTS_MOON_TEXTURE_URL) {
    paths.push(String(window.RTS_MOON_TEXTURE_URL));
  }
  for (const n of names) {
    paths.push(`textures/${n}`);
    try {
      paths.push(new URL(`../textures/${n}`, import.meta.url).href);
    } catch {
      /* ignore */
    }
  }
  return paths;
}

function loadFallbackDiffuseChain(THREE, sceneEl, mesh, urls, index) {
  if (index >= urls.length) {
    const map = buildProceduralMoonTexture(THREE, sceneEl);
    if (!map) return;
    disposeMaterial(mesh.material);
    mesh.material = new THREE.MeshLambertMaterial({ map, color: 0xffffff });
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    tryAttachHorizonSkirt(THREE, mesh);
    return;
  }
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  loader.load(
    urls[index],
    (tex) => {
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.repeat.set(1, 1);
      const renderer = sceneEl && sceneEl.renderer;
      if (renderer && renderer.capabilities && renderer.capabilities.getMaxAnisotropy) {
        tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      }
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      disposeMaterial(mesh.material);
      mesh.material = new THREE.MeshLambertMaterial({ map: tex, color: 0xffffff });
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      tryAttachHorizonSkirt(THREE, mesh);
    },
    undefined,
    () => loadFallbackDiffuseChain(THREE, sceneEl, mesh, urls, index + 1)
  );
}

function loadTextureChain(loader, urls, index, onTex, onFail) {
  if (index >= urls.length) {
    onFail();
    return;
  }
  loader.load(
    urls[index],
    onTex,
    undefined,
    () => loadTextureChain(loader, urls, index + 1, onTex, onFail)
  );
}

function applyBattleMoon(THREE, sceneEl, mesh) {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const diffUrls = assetUrlCandidates(BATTLE_MOON.diff);

  loadTextureChain(
    loader,
    diffUrls,
    0,
    (colorTexture) => {
      configureMoonDiffuseTexture(colorTexture, THREE, sceneEl);
      disposeMaterial(mesh.material);
      const material = new THREE.MeshStandardMaterial({
        map: colorTexture,
        bumpMap: colorTexture,
        bumpScale: MOON_BUMP_SCALE,
        /** Full albedo range — gray multiply was crushing crater contrast (muddy look). */
        color: 0xffffff,
        roughness: 0.88,
        metalness: 0,
        flatShading: false,
        fog: false,
      });
      mesh.material = material;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      attachMoonSurfaceTextureMaps(THREE, sceneEl, material);
      setTimeout(() => tryAttachHorizonSkirt(THREE, mesh), 700);
    },
    () => {
      loadFallbackDiffuseChain(THREE, sceneEl, mesh, collectFallbackDiffuseUrls(), 0);
    }
  );
}

/** @param {HTMLElement} sceneEl — `<a-scene>` */
let terrainGridVisible = false;

/** Toggle the XZ helper grid under #gridHelper. Returns new visibility. */
export function toggleTerrainGrid() {
  const mount = document.getElementById('gridHelper');
  if (!mount || !mount.object3D) return terrainGridVisible;
  terrainGridVisible = !terrainGridVisible;
  mount.object3D.traverse((o) => {
    if (o.isLineSegments) o.visible = terrainGridVisible;
  });
  return terrainGridVisible;
}

export function applyMoonBattlefieldVisuals(sceneEl) {
  const THREE = window.THREE;
  if (!THREE || !sceneEl) return;

  const groundEl = document.getElementById('ground');
  if (!groundEl || !groundEl.object3D) return;

  horizonSkirtAttached = false;

  const terrainGeom = buildBattleTerrainGeometry(THREE);
  const mesh = new THREE.Mesh(
    terrainGeom,
    new THREE.MeshLambertMaterial({ color: 0x5c5c60 })
  );
  mesh.name = 'rts-ground-mesh';
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  groundEl.setObject3D('mesh', mesh);

  applyBattleMoon(THREE, sceneEl, mesh);
  configureTerrainPresentation(sceneEl);
  styleMoonGrid();
  const gridMount = document.getElementById('gridHelper');
  if (gridMount && gridMount.object3D) {
    gridMount.object3D.traverse((o) => {
      if (o.isLineSegments) terrainGridVisible = o.visible;
    });
  }
}
