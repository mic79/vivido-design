/**
 * Moon ground — RTS-scale subtle height. **Albedo must stay full-range** (`color` white); micro-contrast
 * from Poly Haven `moon_01` **JPG** normal / rough / AO shipped under `assets/textures/moon_01_2k/` (CC0).
 *
 * **Temporary slope topology view:** `?slopeDebug=1` or `?slopeDebug=true` on the URL, or set
 * `window.RTS_MOON_SLOPE_DEBUG = true` before `applyMoonBattlefieldVisuals` runs. 0°–45° from horizontal:
 * green → yellow → red; **≥45°** solid red. Uses mesh geometric normals (not the tiled normal map).
 */

import { MAP_PLAYABLE_RADIUS, MAP_SIZE, MAP_SIZE_STANDARD, MAP_TERRAIN_STYLE, MAP_NAV_PLANE_HALF_M } from './config.js';
import { bakedMoonAllowed, tryLoadBakedSkirmishMoon } from './baked-moon.js';

/** Central plate edge length (m) — follows live `MAP_SIZE` (standard 200 / Story 400). */
function mapPlateM() {
  return MAP_SIZE;
}

const BATTLE_MOON = {
  diff: 'assets/textures/moon_01_2k/moon_01_diff_2k.jpg',
};

function moonLivePbrRequested() {
  if (typeof location === 'undefined') return false;
  const q = `${location.search || ''}${location.hash || ''}`;
  return /(?:[?&#]livepbr=1\b)|(?:[?&#]livepbr(?:&|$))/.test(q);
}

/**
 * Diffuse / data map repeats per 200 m side — **~3.35** keeps the playable patch sharp (not “zoomed”
 * like very low repeats). Skirts use the same value; anti-tile warp ramps in **outside** the MAP square.
 */
const MOON_UV_REPEAT = 3.35;

/**
 * World-XZ UV skew that **ramps in past the playable disk** so the 200×200 m patch stays
 * readable while skirts break tiling. Radial distance past `MAP_PLAYABLE_RADIUS`; long **ramp** + mild,
 * **low-frequency** skew avoids harsh lighting seams at the boundary.
 */
function warpMoonTerrainUv(wx, wz) {
  const MAP = mapPlateM();
  const half = MAP * 0.5;
  let u = (wx + half) / MAP;
  let v = (-wz + half) / MAP;
  const dist = Math.hypot(wx, wz);
  const outside = dist - MAP_PLAYABLE_RADIUS;
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
  get width() { return mapPlateM(); },
  get depth() { return mapPlateM(); },
  segmentsWidth: 96,
  segmentsDepth: 96,
  scale: 50,
  octaves: 6,
  gain: 0.44,
  lacunarity: 2.0,
  /** Subtle silhouette only (~±1 m); not the large Zero-G waves. */
  amp: 2.2,
};

/** Story-mode blocking hills (procedural each run). Empty for crater skirmish. */
let storyBlockingHills = /** @type {Array<Record<string, any>>} */ ([]);

/** Soft kinds only — hard crater-rings / cliff mesas produced paper fins + blocky walls. */
const STORY_HILL_KINDS = new Set(['dome', 'ridge', 'mesa', 'crater', 'crescent', 'saddle']);

/**
 * Blurred macro lift bake (Story only). Mesh + skirts + unit Y all sample this so thin
 * analytic rings cannot appear as single-cell walls on the heightfield.
 */
let storyMacroBake = null;
let storyMacroN = 0;
let storyMacroHalf = 0;
let storyMacroCell = 3;

export function setStoryBlockingHills(hills) {
  storyMacroBake = null;
  storyBlockingHills = Array.isArray(hills)
    ? hills.map(h => {
      let rx = Math.max(52, h.rx != null ? h.rx : h.radius || 64);
      let rz = Math.max(52, h.rz != null ? h.rz : h.radius || 64);
      const kind = STORY_HILL_KINDS.has(h.kind) ? h.kind : 'dome';
      // Allow readable elongation (crescent/ridge) without knife blades.
      const maxAspect =
        kind === 'crescent' ? 2.0 : kind === 'ridge' ? 1.85 : kind === 'saddle' ? 1.7 : 1.5;
      if (rx > rz * maxAspect) rx = rz * maxAspect;
      if (rz > rx * maxAspect) rz = rx * maxAspect;
      if (kind === 'ridge' || kind === 'crescent') {
        // Cross-section stays fat (≥48 m half-width) so curved rims read as walls of rock, not fins.
        rz = Math.max(rz, 48);
        rx = Math.max(rx, rz * 1.2);
      }
      if (kind === 'crater' || kind === 'mesa') {
        rx = Math.max(rx, 64);
        rz = Math.max(rz, 64);
      }
      const minR = Math.min(rx, rz);
      // ~28° shoulder budget — present without becoming vertical cliffs.
      const height = Math.max(1, Math.min(h.height || 1, minR * 0.32));
      const warp = Math.max(0, Math.min(0.22, h.warp != null ? Number(h.warp) : 0.14));
      const bowl = Math.max(0.25, Math.min(0.7, h.bowl != null ? Number(h.bowl) : 0.5));
      const arcHalf = Math.max(0.9, Math.min(2.1, h.arcHalf != null ? Number(h.arcHalf) : 1.35));
      const lobe = Math.max(0.3, Math.min(0.48, h.lobe != null ? Number(h.lobe) : 0.36));
      // Crescent rim thickness (meters) — skirmish-style curved wall, not a gumdrop.
      const tube = Math.max(36, h.tube != null ? Number(h.tube) : minR * 0.42);
      const seed =
        (h.seed != null
          ? h.seed
          : Math.imul((Math.floor(h.x * 12.9898 + h.z * 78.233) | 0) ^ 0x9e3779b1, 0x85ebca6b)) | 0;
      return {
        x: h.x,
        z: h.z,
        rx,
        rz,
        rotation: h.rotation || 0,
        height,
        kind,
        warp,
        bowl,
        arcHalf,
        lobe,
        tube,
        seed,
      };
    })
    : [];
}

export function clearStoryBlockingHills() {
  storyBlockingHills = [];
  storyMacroBake = null;
}

function smoothstep01Local(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function wrapAnglePiLocal(a) {
  let t = a;
  while (t > Math.PI) t -= 2 * Math.PI;
  while (t < -Math.PI) t += 2 * Math.PI;
  return t;
}

function hillShapeNoise(seed, ang, harm) {
  const s = seed | 0;
  return Math.sin(ang * harm + (s % 97) * 0.17) * Math.cos(ang * (harm * 0.61 + 0.4) + (s % 53) * 0.11);
}

/** Soft radial dome profile (double smoothstep). */
function softDomeProfile(u) {
  if (u >= 1) return 0;
  const s0 = 1 - u;
  return smoothstep01Local(smoothstep01Local(s0));
}

/**
 * Raw Story hill lift — skirmish-style curved rims / bowls / saddles, kept fat enough
 * that the mesh cannot collapse to a knife blade. Character comes from profile shape,
 * not from blur-to-gumdrop.
 */
function storyBlockingHillsLiftRaw(wx, wz) {
  if (!storyBlockingHills.length) return 0;
  let sum = 0;
  for (let i = 0; i < storyBlockingHills.length; i++) {
    const h = storyBlockingHills[i];
    const dx = wx - h.x;
    const dz = wz - h.z;
    const c = Math.cos(h.rotation);
    const s = Math.sin(h.rotation);
    const lx = dx * c + dz * s;
    const lz = -dx * s + dz * c;
    const ang = Math.atan2(lz, lx);
    const warp =
      1 +
      h.warp *
        (0.7 * hillShapeNoise(h.seed, ang, 2) +
          0.3 * hillShapeNoise(h.seed ^ 0x55, ang, 5));
    const ux = lx / (h.rx * warp);
    const uz = lz / (h.rz * warp);
    const u = Math.sqrt(ux * ux + uz * uz);

    let profile = 0;
    if (h.kind === 'crater') {
      // Wide raised RING + bowl (same language as skirmish crater rim — not a gumdrop).
      if (u >= 1.05) continue;
      const inner = 0.32;
      const peak = 0.58;
      if (u < inner) {
        const t = u / inner;
        profile = (1 - h.bowl) + h.bowl * (0.15 + 0.25 * t);
      } else if (u < peak) {
        const t = (u - inner) / (peak - inner);
        profile = (1 - h.bowl) * 0.4 + (0.55 + 0.45 * smoothstep01Local(t));
      } else {
        const t = (u - peak) / Math.max(1e-3, 1 - peak);
        profile = 1 - smoothstep01Local(smoothstep01Local(Math.min(1, t)));
        profile *= 0.9 + 0.1 * hillShapeNoise(h.seed, ang, 4);
      }
    } else if (h.kind === 'crescent') {
      // Curved rim ARC like a bite of the skirmish crater wall — fat radial thickness.
      const da = Math.abs(wrapAnglePiLocal(ang));
      if (da > h.arcHalf) continue;
      const angFade = smoothstep01Local(1 - da / h.arcHalf);
      const arcR = 0.55 * h.rx;
      const r = Math.hypot(lx, lz);
      const tube = Math.max(36, h.tube || 0.42 * Math.min(h.rx, h.rz));
      const dArc = r - arcR;
      if (Math.abs(dArc) >= tube) continue;
      // Asymmetric rim: steeper outside, softer inside (crater-wall read).
      const t = dArc / tube; // -1 inner … +1 outer
      const inside = t < 0 ? smoothstep01Local(1 + t) : 1;
      const outside = t > 0 ? 1 - smoothstep01Local(smoothstep01Local(t)) : 1;
      const crest = Math.exp(-1.6 * t * t);
      profile = Math.max(crest, inside * 0.35) * outside * angFade * angFade;
      profile *= 0.92 + 0.08 * hillShapeNoise(h.seed, ang, 3);
    } else if (h.kind === 'saddle') {
      if (u >= 1.12) continue;
      const ox = h.lobe * h.rx;
      const lobeR = 0.78 * Math.min(h.rx, h.rz);
      const d1 = Math.hypot(lx - ox, lz) / lobeR;
      const d2 = Math.hypot(lx + ox, lz) / lobeR;
      const lobe1 = d1 < 1 ? softDomeProfile(d1) : 0;
      const lobe2 = d2 < 1 ? softDomeProfile(d2) : 0;
      profile = Math.max(lobe1, lobe2);
      if (Math.abs(ux) < h.lobe + 0.22) {
        const mid =
          (1 - smoothstep01Local(Math.abs(uz) / 0.7)) *
          (1 - Math.abs(ux) / (h.lobe + 0.22));
        profile = Math.max(profile, mid * 0.45);
      }
    } else if (h.kind === 'mesa') {
      // Plateau with scalloped shoulder — readable cliff-ish without going vertical.
      if (u >= 1) continue;
      const rim = 0.42 + 0.08 * hillShapeNoise(h.seed, ang, 5);
      if (u < rim) {
        profile = 0.94 + 0.06 * hillShapeNoise(h.seed ^ 3, ang, 2);
      } else {
        const t = (u - rim) / (1 - rim);
        profile =
          (1 - smoothstep01Local(smoothstep01Local(t))) *
          (0.92 + 0.08 * hillShapeNoise(h.seed, ang, 3));
      }
    } else if (h.kind === 'ridge') {
      // Elongated massif with a clear spine (still ≥48 m across).
      if (u >= 1) continue;
      const along = softDomeProfile(Math.min(1, Math.abs(ux)));
      const across = 1 - smoothstep01Local(Math.abs(uz));
      const wave = 0.88 + 0.12 * Math.sin(ux * Math.PI * 2.2 + (h.seed % 11) * 0.35);
      profile = along * across * wave;
    } else {
      // Dome with lean + shoulder noise — not a perfect hemisphere.
      if (u >= 1) continue;
      const lean = 1 + 0.22 * ux * hillShapeNoise(h.seed, 0.7, 1);
      const shoulder = 0.9 + 0.1 * hillShapeNoise(h.seed, ang, 4);
      profile = softDomeProfile(u) * Math.max(0.65, lean) * shoulder;
    }
    sum += h.height * profile;
  }
  return sum;
}

function blurHeightGridSeparable(grid, n, sigmaCells) {
  if (sigmaCells < 0.4) return;
  const radius = Math.max(1, Math.ceil(sigmaCells * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp((-0.5 * (i * i)) / (sigmaCells * sigmaCells));
    kernel[i + radius] = v;
    ksum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum;

  const tmp = new Float32Array(grid.length);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = Math.min(n - 1, Math.max(0, ix + k));
        acc += grid[iz * n + j] * kernel[k + radius];
      }
      tmp[iz * n + ix] = acc;
    }
  }
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = Math.min(n - 1, Math.max(0, iz + k));
        acc += tmp[j * n + ix] * kernel[k + radius];
      }
      grid[iz * n + ix] = acc;
    }
  }
}

/**
 * Kill thin walls that survive neighbor-max spike checks (crest cells prop each other up).
 * Cap each cell by the stricter of the X/Z slope envelopes from distant flanks.
 */
function erodeThinWallFeatures(grid, n, cellM, minHalfWidthM = 14, maxSlopeDeg = 26) {
  const maxDy = Math.tan((maxSlopeDeg * Math.PI) / 180) * cellM;
  const span = Math.max(2, Math.ceil(minHalfWidthM / cellM));
  const tmp = new Float32Array(grid.length);
  for (let pass = 0; pass < 5; pass++) {
    tmp.set(grid);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        let capX = Infinity;
        let capZ = Infinity;
        for (let s = 1; s <= span; s++) {
          const dy = maxDy * s;
          if (ix >= s) capX = Math.min(capX, grid[i - s] + dy);
          if (ix + s < n) capX = Math.min(capX, grid[i + s] + dy);
          if (iz >= s) capZ = Math.min(capZ, grid[i - s * n] + dy);
          if (iz + s < n) capZ = Math.min(capZ, grid[i + s * n] + dy);
        }
        const cap = Math.min(capX, capZ);
        if (Number.isFinite(cap) && tmp[i] > cap) tmp[i] = cap;
      }
    }
    grid.set(tmp);
  }
}

/** Pull down peaks that are isolated in BOTH X and Z (true needles), leave long rims alone. */
function crushBiaxialNeedles(grid, n, cellM, maxSlopeDeg = 28) {
  const maxDy = Math.tan((maxSlopeDeg * Math.PI) / 180) * cellM;
  const tmp = new Float32Array(grid.length);
  for (let pass = 0; pass < 3; pass++) {
    tmp.set(grid);
    for (let iz = 1; iz < n - 1; iz++) {
      for (let ix = 1; ix < n - 1; ix++) {
        const i = iz * n + ix;
        const h = grid[i];
        const hL = grid[i - 1];
        const hR = grid[i + 1];
        const hU = grid[i - n];
        const hD = grid[i + n];
        const neighMax = Math.max(hL, hR, hU, hD);
        const dropX = h - Math.max(hL, hR);
        const dropZ = h - Math.max(hU, hD);
        // Needle: rises sharply above neighbors on both axes.
        if (dropX > maxDy * 1.25 && dropZ > maxDy * 1.25) {
          tmp[i] = Math.min(h, neighMax + maxDy);
        }
      }
    }
    grid.set(tmp);
  }
}

/**
 * Bake Story macro hills → blurred + thin-wall-eroded grid. Call after setStoryBlockingHills
 * and before building plate/skirts.
 */
export function rebuildStoryMacroBake() {
  if (MAP_TERRAIN_STYLE !== 'hills' || !storyBlockingHills.length) {
    storyMacroBake = null;
    storyMacroN = 0;
    return;
  }
  const half = mapPlateM() * 0.5 + horizonSkirtDepthM() + 4;
  const cell = 3;
  const n = Math.max(3, Math.ceil((2 * half) / cell) + 1);
  const grid = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    const wz = -half + (iz / (n - 1)) * (2 * half);
    for (let ix = 0; ix < n; ix++) {
      const wx = -half + (ix / (n - 1)) * (2 * half);
      grid[iz * n + ix] = storyBlockingHillsLiftRaw(wx, wz);
    }
  }
  // Light anti-spike only — do not blur away crater-rim character.
  blurHeightGridSeparable(grid, n, 2.2 / cell);
  // Crush true needles (thin in both axes). Wide crescent/crater rims survive.
  erodeThinWallFeatures(grid, n, (2 * half) / (n - 1), 9, 28);
  crushBiaxialNeedles(grid, n, (2 * half) / (n - 1), 28);

  storyMacroBake = grid;
  storyMacroN = n;
  storyMacroHalf = half;
  storyMacroCell = (2 * half) / (n - 1);
}

function sampleStoryMacroBake(wx, wz) {
  const g = storyMacroBake;
  const n = storyMacroN;
  if (!g || n < 2) return null;
  const half = storyMacroHalf;
  if (Math.abs(wx) > half + 1e-3 || Math.abs(wz) > half + 1e-3) return null;
  let fx = ((wx + half) / (2 * half)) * (n - 1);
  let fz = ((wz + half) / (2 * half)) * (n - 1);
  fx = Math.min(Math.max(fx, 0), n - 1 - 1e-9);
  fz = Math.min(Math.max(fz, 0), n - 1 - 1e-9);
  const ix = Math.min(Math.floor(fx), n - 2);
  const iz = Math.min(Math.floor(fz), n - 2);
  const u = fx - ix;
  const v = fz - iz;
  const h00 = g[iz * n + ix];
  const h10 = g[iz * n + ix + 1];
  const h01 = g[(iz + 1) * n + ix];
  const h11 = g[(iz + 1) * n + ix + 1];
  if (u + v <= 1) return (1 - u - v) * h00 + v * h01 + u * h10;
  return (1 - u) * h01 + (1 - v) * h10 + (u + v - 1) * h11;
}

/**
 * Public Story hill lift — uses blurred bake when available (mesh-consistent).
 */
export function storyBlockingHillsLift(wx, wz) {
  const baked = sampleStoryMacroBake(wx, wz);
  if (baked != null) return baked;
  return storyBlockingHillsLiftRaw(wx, wz);
}

/**
 * Diagnostics for verify scripts: max slope + thin-wall hits on the bake.
 * @returns {{ ok: boolean, maxSlopeDeg: number, thinWalls: number, n: number, cell: number }}
 */
export function diagnoseStoryHillBake(opts = {}) {
  // Paper fins are ~few metres across. Wide crescent/crater rims (~35 m+) must NOT fail.
  const maxSlopeAllow = opts.maxSlopeDeg ?? 42;
  const minWidthM = opts.minWidthM ?? 7;
  const g = storyMacroBake;
  const n = storyMacroN;
  if (!g || n < 3) {
    return { ok: false, maxSlopeDeg: 0, thinWalls: -1, n: 0, cell: 0, reason: 'no-bake' };
  }
  const cell = storyMacroCell;
  let maxSlopeDeg = 0;
  let thinWalls = 0;
  const span = Math.max(1, Math.ceil(minWidthM / cell));
  for (let iz = 1; iz < n - 1; iz++) {
    for (let ix = 1; ix < n - 1; ix++) {
      const i = iz * n + ix;
      const h = g[i];
      const gx = (g[i + 1] - g[i - 1]) / (2 * cell);
      const gz = (g[i + n] - g[i - n]) / (2 * cell);
      const slope = (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
      if (slope > maxSlopeDeg) maxSlopeDeg = slope;

      if (h < 5) continue;
      const thr = h * 0.45;
      let thinX = false;
      let thinZ = false;
      if (ix >= span && ix + span < n) {
        if (g[i - span] < thr && g[i + span] < thr) thinX = true;
      }
      if (iz >= span && iz + span < n) {
        if (g[i - span * n] < thr && g[i + span * n] < thr) thinZ = true;
      }
      // True needle/fin: thin in BOTH axes. A crescent rim is only thin across one axis.
      if (thinX && thinZ) thinWalls++;
    }
  }
  const ok = maxSlopeDeg <= maxSlopeAllow && thinWalls === 0;
  return {
    ok,
    maxSlopeDeg: Math.round(maxSlopeDeg * 10) / 10,
    thinWalls,
    n,
    cell,
    half: storyMacroHalf,
    maxSlopeAllow,
    minWidthM,
  };
}

/**
 * Vertex heights of the central battle plate (same layout as `THREE.PlaneGeometry` buffer:
 * `iy` outer 0..segmentsDepth, `ix` inner 0..segmentsWidth). Used so units sit on the **rendered**
 * piecewise-linear mesh, not the smooth analytic continuation of the same noise.
 */
let centralTerrainHeightGrid = null;
/** Baked skirmish GLB after Y-up bake — height samples raycast this instead of the procedural plate. */
let bakedMoonRoot = null;
let bakedMoonPlate = null;

/**
 * Full nav-plane height field (plate mesh on-center, analytic elsewhere) so units outside the
 * MAP_SIZE square match the skirt surface instead of floating on the smooth FBM above coarse tris.
 */
let gameplayHeightGrid = null;
let gameplayHeightN = 0;
let gameplayHeightHalf = 0;
let gameplayHeightCell = 4;
/** Bumped on every terrain rebuild — invalidates per-entity `_tY` caches. */
let terrainHeightGen = 0;

export function getTerrainHeightGen() {
  return terrainHeightGen;
}

let _bakedMoonRaycaster = null;

function raycastBakedMoonY(wx, wz) {
  const target = bakedMoonPlate || bakedMoonRoot;
  if (!target || !window.THREE) return null;
  const THREE = window.THREE;
  if (!_bakedMoonRaycaster) _bakedMoonRaycaster = new THREE.Raycaster();
  _bakedMoonRaycaster.far = 500;
  _bakedMoonRaycaster.set(new THREE.Vector3(wx, 80, wz), new THREE.Vector3(0, -1, 0));
  const hits = _bakedMoonRaycaster.intersectObject(target, false);
  if (!hits.length) return null;
  const y = hits[0].point.y;
  return Number.isFinite(y) ? y : null;
}

function yieldFrame() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const failsafe = setTimeout(done, 48);
    const hop = () => {
      clearTimeout(failsafe);
      done();
    };
    try {
      const sceneEl = document.querySelector('a-scene');
      const xr = sceneEl && sceneEl.renderer && sceneEl.renderer.xr;
      const session = xr && xr.isPresenting && typeof xr.getSession === 'function' ? xr.getSession() : null;
      if (session && typeof session.requestAnimationFrame === 'function') {
        session.requestAnimationFrame(() => hop());
        return;
      }
    } catch (_) {
      /* */
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(hop);
    else setTimeout(hop, 0);
  });
}

async function adoptBakedMoonHeightField(root) {
  bakedMoonRoot = root || null;
  bakedMoonPlate = null;
  if (!root) {
    centralTerrainHeightGrid = null;
    return;
  }
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (o.isMesh && /^Moon_0/i.test(o.name)) bakedMoonPlate = o;
  });
  const segW = BATTLE_TERRAIN.segmentsWidth;
  const segD = BATTLE_TERRAIN.segmentsDepth;
  const row = segW + 1;
  const grid = new Float32Array(row * (segD + 1));
  const MAP = mapPlateM();
  const half = MAP * 0.5;
  for (let iy = 0; iy <= segD; iy++) {
    const wz = half - (iy / segD) * MAP;
    for (let ix = 0; ix <= segW; ix++) {
      const wx = -half + (ix / segW) * MAP;
      const y = raycastBakedMoonY(wx, wz);
      grid[iy * row + ix] = y != null ? y : 0;
    }
    if ((iy & 15) === 15) await yieldFrame();
  }
  centralTerrainHeightGrid = grid;
  rebuildGameplayHeightGrid();
}

async function finishBakedMoonLook(THREE, sceneEl, root, opts = {}) {
  const recv =
    typeof window._getDynamicShadowsEnabled === 'function'
      ? !!window._getDynamicShadowsEnabled()
      : true;
  let cheap = false;
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    if (obj.material && obj.material.userData && obj.material.userData.cheapMoonLook) cheap = true;
    obj.receiveShadow = recv;
    obj.castShadow = false;
    if (obj.material && obj.material.userData) obj.material.userData.shadowRecv = recv;
  });
  if (!cheap) {
    const material = await createBattleMoonMaterial(THREE, sceneEl);
    if (material) {
      if (material.userData) material.userData.shadowRecv = recv;
      root.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.material = material;
        obj.receiveShadow = recv;
        obj.castShadow = false;
      });
    }
  }
  if (!opts.skipHeight) await adoptBakedMoonHeightField(root);
}

/**
 * Kill single-column / fin spikes: a vertex may not rise more than ~maxSlope above its
 * neighbors. Real massifs are many cells wide so they survive; knife blades do not.
 */
function suppressHeightSpikes(grid, cols, rows, cellM, maxSlopeDeg = 34, iters = 5) {
  if (!grid || cols < 3 || rows < 3) return;
  const maxDy = Math.tan((maxSlopeDeg * Math.PI) / 180) * Math.max(0.5, cellM);
  const tmp = new Float32Array(grid.length);
  for (let iter = 0; iter < iters; iter++) {
    tmp.set(grid);
    for (let iz = 0; iz < rows; iz++) {
      for (let ix = 0; ix < cols; ix++) {
        const i = iz * cols + ix;
        let neighMax = -Infinity;
        if (ix > 0) neighMax = Math.max(neighMax, grid[i - 1]);
        if (ix < cols - 1) neighMax = Math.max(neighMax, grid[i + 1]);
        if (iz > 0) neighMax = Math.max(neighMax, grid[i - cols]);
        if (iz < rows - 1) neighMax = Math.max(neighMax, grid[i + cols]);
        if (!(neighMax > -1e300)) continue;
        if (tmp[i] > neighMax + maxDy) tmp[i] = neighMax + maxDy;
      }
    }
    grid.set(tmp);
  }
}

function rebuildGameplayHeightGrid() {
  const skirtReach = mapPlateM() * 0.5 + horizonSkirtDepthM() + 4;
  const half = Math.max(MAP_NAV_PLANE_HALF_M, skirtReach);
  // Match plate density on Story (~1.5–2 m); skirmish stays coarser.
  const cell = MAP_TERRAIN_STYLE === 'hills' ? 2 : 4;
  const n = Math.max(3, Math.ceil((2 * half) / cell) + 1);
  const grid = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    const wz = -half + (iz / (n - 1)) * (2 * half);
    for (let ix = 0; ix < n; ix++) {
      const wx = -half + (ix / (n - 1)) * (2 * half);
      let h = sampleCentralPlateMeshSurfaceY(wx, wz);
      if (h == null) h = sampleMoonTerrainWorldYVisual(wx, wz);
      grid[iz * n + ix] = Number.isFinite(h) ? h : 0;
    }
  }
  // No post-erode here — see buildBattleTerrainGeometry comment (creases on real hills).
  gameplayHeightGrid = grid;
  gameplayHeightN = n;
  gameplayHeightHalf = half;
  gameplayHeightCell = (2 * half) / (n - 1);
  terrainHeightGen = (terrainHeightGen + 1) >>> 0;
}

/**
 * Same two-triangle split as `THREE.PlaneGeometry` / central plate sampler — not bilinear —
 * so unit feet match a heightfield triangulation (and skirts built from the same samples).
 */
function sampleGameplayHeightGrid(wx, wz) {
  const g = gameplayHeightGrid;
  const n = gameplayHeightN;
  if (!g || n < 2) return null;
  const half = gameplayHeightHalf;
  if (Math.abs(wx) > half + 1e-3 || Math.abs(wz) > half + 1e-3) return null;

  let fx = ((wx + half) / (2 * half)) * (n - 1);
  let fz = ((wz + half) / (2 * half)) * (n - 1);
  fx = Math.min(Math.max(fx, 0), n - 1 - 1e-9);
  fz = Math.min(Math.max(fz, 0), n - 1 - 1e-9);
  const ix = Math.min(Math.floor(fx), n - 2);
  const iz = Math.min(Math.floor(fz), n - 2);
  const u = fx - ix;
  const v = fz - iz;
  const h00 = g[iz * n + ix];
  const h10 = g[iz * n + ix + 1];
  const h01 = g[(iz + 1) * n + ix];
  const h11 = g[(iz + 1) * n + ix + 1];
  if (u + v <= 1) {
    return (1 - u - v) * h00 + v * h01 + u * h10;
  }
  return (1 - u) * h01 + (1 - v) * h10 + (u + v - 1) * h11;
}

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

/** Wrap angle to (−π, π]. */
function wrapAnglePi(x) {
  let t = x;
  while (t > Math.PI) t -= 2 * Math.PI;
  while (t < -Math.PI) t += 2 * Math.PI;
  return t;
}

/**
 * Soft cardinal modulation on the rim wall (`atan2(wz, wx)` — E / N / W / S): wide Gaussian so
 * the wall height does not swing wildly with angle (smoother shoulders than a hard notch).
 */
const CRATER_RIM_CARDINAL_GATE_FLOOR = 0.62;
const CRATER_RIM_CARDINAL_NOTCH_SIGMA_DEG = 14;

function craterRimCardinalFlatGate(wx, wz) {
  const phi = Math.atan2(wz, wx);
  const centers = [0, Math.PI * 0.5, Math.PI, -Math.PI * 0.5];
  const sigma = (CRATER_RIM_CARDINAL_NOTCH_SIGMA_DEG * Math.PI) / 180;
  let dipMax = 0;
  for (let i = 0; i < centers.length; i++) {
    const ad = Math.abs(wrapAnglePi(phi - centers[i]));
    const g = Math.exp(-0.5 * (ad / sigma) * (ad / sigma));
    if (g > dipMax) dipMax = g;
  }
  return CRATER_RIM_CARDINAL_GATE_FLOOR + (1 - CRATER_RIM_CARDINAL_GATE_FLOOR) * (1 - dipMax);
}

/**
 * Cardinal **passages** through the rim: peaks at (d ≈ `MAP_PLAYABLE_RADIUS`, on E/N/W/S rays).
 * Angular × radial Gaussians carve a smooth valley crossing the wall (inside ↔ outside), not a path
 * along the rim crest.
 */
const CRATER_RIM_PASS_ANG_SIGMA_DEG = 11;
const CRATER_RIM_PASS_RADIAL_SIGMA_M = 32;
const CRATER_RIM_PASSAGE_DEPTH = 0.93;

function craterRimPassageRelief(wx, wz) {
  const R = MAP_PLAYABLE_RADIUS;
  const d = Math.hypot(wx, wz);
  const phi = Math.atan2(wz, wx);
  const centers = [0, Math.PI * 0.5, Math.PI, -Math.PI * 0.5];
  const sigA = (CRATER_RIM_PASS_ANG_SIGMA_DEG * Math.PI) / 180;
  const sigR = CRATER_RIM_PASS_RADIAL_SIGMA_M;
  let angP = 0;
  for (let i = 0; i < centers.length; i++) {
    const ad = Math.abs(wrapAnglePi(phi - centers[i]));
    const g = Math.exp(-0.5 * (ad / sigA) * (ad / sigA));
    if (g > angP) angP = g;
  }
  const radP = Math.exp(-0.5 * ((d - R) / sigR) * ((d - R) / sigR));
  return angP * radP;
}

/** Raised ring at the playable disk edge (crater rim). Meters of extra world Y. Disabled in Story (hills). */
export function getCraterRimNavLift(wx, wz) {
  if (MAP_TERRAIN_STYLE === 'hills') return storyBlockingHillsLift(wx, wz);
  return craterRimLift(wx, wz);
}

function craterRimLift(wx, wz) {
  if (MAP_TERRAIN_STYLE === 'hills') return 0;
  const R = MAP_PLAYABLE_RADIUS;
  /** Wider radial bands + double-smoothstep keep the wall smooth; cardinal `passage` carves crossings. */
  const inner = R - 22;
  const outer = R + 56;
  const PEAK = 17.5;
  const d = Math.hypot(wx, wz);
  if (d <= inner || d >= outer) return 0;
  const gate = craterRimCardinalFlatGate(wx, wz);
  const passage = craterRimPassageRelief(wx, wz);
  const passMul = 1 - CRATER_RIM_PASSAGE_DEPTH * passage;
  if (d <= R) {
    const t = (d - inner) / Math.max(1e-3, R - inner);
    const s = Math.max(0, Math.min(1, t));
    const profile = smoothstep01(smoothstep01(s));
    return PEAK * profile * gate * passMul;
  }
  const t = (d - R) / Math.max(1e-3, outer - R);
  const s = Math.max(0, Math.min(1, t));
  const profile = smoothstep01(smoothstep01(s));
  return PEAK * (1 - profile) * gate * passMul;
}

/**
 * Small bowls **just outside** the gameplay disk (`d > R`), within ~50 m past the outer edge of
 * `craterRimLift` (`outer + 50`).
 *
 * **Why this is easy to miss:** `R` circumscribes the 200×200 map square, so most horizon-skirt
 * vertices (outside the square but still “near” the map) still satisfy `d ≤ R`. This lift is
 * therefore **zero on most of the inner skirt**; see `skirtOutsideSquareCratersLift` for that band.
 */
function rimSatelliteDecorLift(wx, wz) {
  const R = MAP_PLAYABLE_RADIUS;
  const outer = R + 56;
  const bandM = 50;
  const dMax = outer + bandM;
  const d2 = wx * wx + wz * wz;
  if (d2 <= R * R || d2 > dMax * dMax) return 0;
  const d = Math.sqrt(d2);
  const edgeFade = smoothstep01((d - R) / 10) * smoothstep01((dMax - d) / 18);
  if (edgeFade <= 1e-4) return 0;

  const anchors = 52;
  let sum = 0;
  for (let k = 0; k < anchors; k++) {
    const base = (k / anchors) * Math.PI * 2;
    const a = base + (hash01(k, 0, 801) - 0.5) * 0.42;
    const r0 = R + 10 + hash01(k, 1, 802) * (dMax - R - 20);
    const cx = Math.cos(a) * r0;
    const cz = Math.sin(a) * r0;
    const radM = 4.2 + hash01(k, 2, 803) * 8.5;
    const depthM = 0.95 + hash01(k, 3, 804) * 2.85;
    const jx = (hash01(k, 4, 805) - 0.5) * 5.5;
    const jz = (hash01(k, 5, 806) - 0.5) * 5.5;
    const dx = wx - cx - jx;
    const dz = wz - cz - jz;
    const dd = Math.hypot(dx, dz);
    if (dd >= radM) continue;
    const u = dd / radM;
    const t = 1 - u;
    sum -= depthM * t * t;
    const rimU = (u - 0.58) / 0.42;
    if (rimU > 0 && rimU < 1) {
      sum += depthM * 0.24 * Math.sin(rimU * Math.PI);
    }
  }
  return sum * edgeFade;
}

/**
 * Larger, denser bowls on **skirt meshes only** (`max(|x|,|z|) > map half-edge`), including where
 * `d ≤ MAP_PLAYABLE_RADIUS` (most inner skirt — where `rimSatelliteDecorLift` is always zero).
 * Does **not** touch the central 200×200 plate.
 * `window.RTS_SKIRT_OUTSIDE_SQ_CRATER_DENSITY` — 0..0.65 (default ~0.42).
 */
function skirtOutsideSquareCratersLift(wx, wz) {
  const half = mapPlateM() * 0.5;
  const maxAbs = Math.max(Math.abs(wx), Math.abs(wz));
  if (maxAbs <= half + 1e-6) return 0;

  const edgeW = smoothstep01((maxAbs - half) / 36) * smoothstep01((2600 - maxAbs) / 2600);
  if (edgeW <= 1e-4) return 0;

  let density = 0.42;
  if (typeof window !== 'undefined' && Number.isFinite(window.RTS_SKIRT_OUTSIDE_SQ_CRATER_DENSITY)) {
    density = Math.max(0, Math.min(0.65, window.RTS_SKIRT_OUTSIDE_SQ_CRATER_DENSITY));
  }
  const thresh = 1 - density;

  const CELL = 38;
  const ci = Math.floor(wx / CELL);
  const cj = Math.floor(wz / CELL);
  let sum = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const i = ci + di;
      const j = cj + dj;
      if (hash01(i, j, 920) < thresh) continue;
      const radM = 6 + hash01(i, j, 921) * 16;
      const depthM = 1.15 + hash01(i, j, 922) * 4.4;
      const jx = (hash01(i, j, 923) - 0.5) * CELL * 0.62;
      const jz = (hash01(i, j, 924) - 0.5) * CELL * 0.62;
      const cx = (i + 0.5) * CELL + jx;
      const cz = (j + 0.5) * CELL + jz;
      if (Math.max(Math.abs(cx), Math.abs(cz)) <= half + 0.5) continue;
      const dd = Math.hypot(wx - cx, wz - cz);
      if (dd >= radM) continue;
      const u = dd / radM;
      const t = 1 - u;
      sum -= depthM * t * t;
      const rimU = (u - 0.55) / 0.45;
      if (rimU > 0 && rimU < 1) {
        sum += depthM * 0.26 * Math.sin(rimU * Math.PI);
      }
    }
  }
  return sum * edgeW;
}

/**
 * Extra bowls on the **horizon skirt only** (outside the MAP_SIZE square): sparse deterministic craters,
 * each at most ~half the vertical/horizontal scale of `craterRimLift` (rim peak ~17.5 m, span tens of m).
 */
function skirtDecorCratersLift(wx, wz) {
  const half = mapPlateM() * 0.5;
  if (Math.max(Math.abs(wx), Math.abs(wz)) <= half + 1e-6) return 0;

  let density = 0.2;
  if (typeof window !== 'undefined' && Number.isFinite(window.RTS_SKIRT_CRATER_DENSITY)) {
    density = Math.max(0, Math.min(0.35, window.RTS_SKIRT_CRATER_DENSITY));
  }
  const thresh = 1 - density;

  const CELL = 56;
  const MAX_R = 16;
  const MAX_DEPTH = 3.4;
  const ci = Math.floor(wx / CELL);
  const cj = Math.floor(wz / CELL);
  let sum = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const i = ci + di;
      const j = cj + dj;
      if (hash01(i, j, 710) < thresh) continue;
      const radM = 4.5 + hash01(i, j, 711) * (MAX_R - 4.5);
      const depthM = 0.55 + hash01(i, j, 712) * (MAX_DEPTH - 0.55);
      const jx = (hash01(i, j, 713) - 0.5) * CELL * 0.58;
      const jz = (hash01(i, j, 714) - 0.5) * CELL * 0.58;
      const cx = (i + 0.5) * CELL + jx;
      const cz = (j + 0.5) * CELL + jz;
      if (Math.max(Math.abs(cx), Math.abs(cz)) <= half + 0.5) continue;
      const d = Math.hypot(wx - cx, wz - cz);
      if (d >= radM) continue;
      const u = d / radM;
      const t = 1 - u;
      sum -= depthM * t * t;
      const rimU = (u - 0.62) / 0.38;
      if (rimU > 0 && rimU < 1) {
        sum += depthM * 0.28 * Math.sin(rimU * Math.PI);
      }
    }
  }
  return sum;
}

/**
 * Barycentric height on the **same two-triangle split** as `THREE.PlaneGeometry` (triangles a,b,c
 * then b,d,c). Returns null if `(wx,wz)` is outside the 200×200 m plate or grid is missing.
 */
function sampleCentralPlateMeshSurfaceY(wx, wz) {
  const g = centralTerrainHeightGrid;
  if (!g) return null;
  const MAP = mapPlateM();
  const half = MAP * 0.5;
  if (Math.abs(wx) > half + 1e-4 || Math.abs(wz) > half + 1e-4) return null;

  const segW = BATTLE_TERRAIN.segmentsWidth;
  const segD = BATTLE_TERRAIN.segmentsDepth;
  const row = segW + 1;

  let fx = ((wx + half) / MAP) * segW;
  let fz = ((half - wz) / MAP) * segD;
  fx = Math.min(Math.max(fx, 0), segW - 1e-9);
  fz = Math.min(Math.max(fz, 0), segD - 1e-9);

  const ix = Math.min(Math.floor(fx), segW - 1);
  const iy = Math.min(Math.floor(fz), segD - 1);
  const u = fx - ix;
  const v = fz - iy;

  const h00 = g[iy * row + ix];
  const h10 = g[iy * row + ix + 1];
  const h01 = g[(iy + 1) * row + ix];
  const h11 = g[(iy + 1) * row + ix + 1];

  if (u + v <= 1) {
    return (1 - u - v) * h00 + v * h01 + u * h10;
  }
  return (1 - u) * h01 + (1 - v) * h10 + (u + v - 1) * h11;
}

/** Pathfinding / nav: same as internal plate sampler; `null` outside the 200×200 m mesh or before grid init. */
export function sampleNavPlateMeshY(wx, wz) {
  return sampleCentralPlateMeshSurfaceY(wx, wz);
}

/**
 * World-space **visual** ground Y at (wx, wz): navigable bowl (curvature + micro-relief)
 * plus non-navigable macros (Story hills / crater rims).
 * For units/buildings/resources/FoW use `sampleMoonTraversableBaseY` / entity helpers —
 * never sit entities on hill macros.
 */
export function sampleMoonTerrainWorldY(wx, wz) {
  if (!Number.isFinite(wx) || !Number.isFinite(wz)) return 0;

  const MAP = mapPlateM();
  const half = MAP * 0.5;
  if (Math.abs(wx) <= half + 1e-4 && Math.abs(wz) <= half + 1e-4) {
    const hTri = sampleCentralPlateMeshSurfaceY(wx, wz);
    if (hTri != null) return hTri;
  }

  const hGrid = sampleGameplayHeightGrid(wx, wz);
  if (hGrid != null) return hGrid;

  return sampleMoonTerrainWorldYVisual(wx, wz);
}

/** Cache full visual terrain Y (rarely needed). Prefer `sampleGameplayEntityYCached`. */
export function sampleMoonTerrainWorldYCached(entity, wx, wz) {
  const quant = MAP_TERRAIN_STYLE === 'hills' ? 8 : 0.5;
  const gx = Math.round(wx * quant);
  const gz = Math.round(wz * quant);
  if (
    entity._tGen === terrainHeightGen &&
    entity._tGx === gx &&
    entity._tGz === gz &&
    entity._tY != null
  ) {
    return entity._tY;
  }
  entity._tGen = terrainHeightGen;
  entity._tGx = gx;
  entity._tGz = gz;
  entity._tY = sampleMoonTerrainWorldY(wx, wz);
  return entity._tY;
}

/**
 * Navigable surface Y: planet-like bowl (horizon sag) + subtle FBM.
 * Height is “zero-based” relative to this surface — entities sit ON it.
 * Does **not** include Story hills / crater-rim macros (those are non-navigable).
 */
export function sampleMoonTraversableBaseY(wx, wz) {
  if (!Number.isFinite(wx) || !Number.isFinite(wz)) return 0;
  const planeX = wx;
  const planeY = -wz;
  const noiseVal = battleTerrainFbm(planeX / BATTLE_TERRAIN.scale, 0, planeY / BATTLE_TERRAIN.scale) - 0.5;
  const R = MAP_PLAYABLE_RADIUS;
  const MAP = mapPlateM();
  const halfPl = MAP * 0.5;
  const dist = Math.hypot(wx, wz);
  let damp = 1;
  if (Math.max(Math.abs(wx), Math.abs(wz)) <= halfPl && dist > R * 0.9) {
    damp = 1 - 0.28 * smoothstep01((dist - R * 0.9) / Math.max(R * 0.35, horizonSkirtDepthM() * 0.12));
  }
  return noiseVal * BATTLE_TERRAIN.amp * damp + moonHorizonSagY(wx, wz);
}

/** Non-navigable raised macros only (hills / crater décor). */
function sampleNonNavigableMacroLift(wx, wz) {
  if (MAP_TERRAIN_STYLE === 'hills') return storyBlockingHillsLift(wx, wz);
  return (
    craterRimLift(wx, wz) +
    rimSatelliteDecorLift(wx, wz) +
    skirtOutsideSquareCratersLift(wx, wz) +
    skirtDecorCratersLift(wx, wz)
  );
}

/** Visual height = navigable bowl + macros. */
function sampleMoonTerrainWorldYVisual(wx, wz) {
  if (!Number.isFinite(wx) || !Number.isFinite(wz)) return 0;
  return sampleMoonTraversableBaseY(wx, wz) + sampleNonNavigableMacroLift(wx, wz);
}

/**
 * Gameplay entity / FoW ground Y — always the navigable curved surface (never hill tops).
 */
export function sampleGameplayEntityY(wx, wz) {
  return sampleMoonTraversableBaseY(wx, wz);
}

/** Per-entity cache of navigable-surface Y (invalidated when terrain gen bumps). */
export function sampleGameplayEntityYCached(entity, wx, wz) {
  const quant = 0.5;
  const gx = Math.round(wx * quant);
  const gz = Math.round(wz * quant);
  if (
    entity._navGen === terrainHeightGen &&
    entity._navGx === gx &&
    entity._navGz === gz &&
    entity._navY != null
  ) {
    return entity._navY;
  }
  entity._navGen = terrainHeightGen;
  entity._navGx = gx;
  entity._navGz = gz;
  entity._navY = sampleMoonTraversableBaseY(wx, wz);
  return entity._navY;
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
/** Skirmish GLB kept on GPU while Story is showing — Story→skirmish must not decode 40MB again. */
let parkedSkirmish = null;

/**
 * Skirt patch on the gameplay heightfield lattice — kept for optional debug; live path uses
 * `buildTerrainSkirtPatchGeometry` (segmented).
 */
function buildTerrainSkirtLatticePatch(THREE, wx0, wx1, wz0, wz1) {
  const g = gameplayHeightGrid;
  const n = gameplayHeightN;
  const half = gameplayHeightHalf;
  if (!g || n < 2) {
    const sx = Math.max(2, Math.ceil(Math.abs(wx1 - wx0) / 8));
    const sz = Math.max(2, Math.ceil(Math.abs(wz1 - wz0) / 8));
    return buildTerrainSkirtPatchGeometry(THREE, wx0, wx1, wz0, wz1, sx, sz);
  }

  const span = 2 * half;
  const toIx = (wx) => Math.round(((wx + half) / span) * (n - 1));
  const toIz = (wz) => Math.round(((wz + half) / span) * (n - 1));
  let ix0 = Math.min(toIx(wx0), toIx(wx1));
  let ix1 = Math.max(toIx(wx0), toIx(wx1));
  let iz0 = Math.min(toIz(wz0), toIz(wz1));
  let iz1 = Math.max(toIz(wz0), toIz(wz1));
  ix0 = Math.max(0, Math.min(n - 1, ix0));
  ix1 = Math.max(0, Math.min(n - 1, ix1));
  iz0 = Math.max(0, Math.min(n - 1, iz0));
  iz1 = Math.max(0, Math.min(n - 1, iz1));
  if (ix1 <= ix0 || iz1 <= iz0) return null;

  const positions = [];
  const uvs = [];
  const indices = [];
  const cols = ix1 - ix0 + 1;
  for (let iz = iz0; iz <= iz1; iz++) {
    const wz = -half + (iz / (n - 1)) * span;
    for (let ix = ix0; ix <= ix1; ix++) {
      const wx = -half + (ix / (n - 1)) * span;
      const h = g[iz * n + ix];
      positions.push(wx, -wz, h);
      const wuv = warpMoonTerrainUv(wx, wz);
      uvs.push(wuv.u, wuv.v);
    }
  }
  for (let iz = 0; iz < iz1 - iz0; iz++) {
    for (let ix = 0; ix < ix1 - ix0; ix++) {
      const a = iz * cols + ix;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      // Match sampleGameplayHeightGrid diagonal (u+v ≤ 1 → a,c,b / else b,c,d)
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
      // Always analytic/visual (includes Story macro bake). Do not depend on gameplay
      // grid here — a missing builder name previously aborted skirt attach and left the
      // intro plate edge as a naked cliff/spike on the menu horizon.
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
  const skirt = mesh.getObjectByName('rts-horizon-skirt');
  if (skirt) {
    skirt.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
    });
    mesh.remove(skirt);
  }
  const overlay = mesh.getObjectByName('rts-outside-overlay');
  if (overlay) {
    let disposedMat = false;
    overlay.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && !disposedMat) {
        disposeMaterial(o.material);
        disposedMat = true;
      }
    });
    mesh.remove(overlay);
  }
}

function tryAttachHorizonSkirt(THREE, mesh, sceneEl) {
  if (!mesh || !mesh.material || horizonSkirtAttached) return;
  horizonSkirtAttached = true;
  try {
    disposeHorizonSkirtUnder(mesh);
    rebuildGameplayHeightGrid();
    const half = mapPlateM() * 0.5;
    const d = horizonSkirtDepthM();
    const g = new THREE.Group();
    g.name = 'rts-horizon-skirt';
    const mat = mesh.material;
    const segAlongX = BATTLE_TERRAIN.segmentsWidth;
    const segAlongZ = BATTLE_TERRAIN.segmentsDepth;
    const segDeep = Math.max(44, Math.min(120, Math.ceil(d / 8)));
    const addPatch = (wx0, wx1, wz0, wz1, sx, sz) => {
      const geo = buildTerrainSkirtPatchGeometry(THREE, wx0, wx1, wz0, wz1, sx, sz);
      const m = new THREE.Mesh(geo, mat);
      m.receiveShadow = !!mesh.receiveShadow;
      m.castShadow = false;
      m.frustumCulled = true;
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
  } catch (err) {
    horizonSkirtAttached = false;
    console.error('[moon] horizon skirt attach failed — intro/horizon will look clipped', err);
  }
}

function buildBattleTerrainGeometry(THREE) {
  // Blurred Story macro bake must exist before plate/skirt sampling.
  if (MAP_TERRAIN_STYLE === 'hills') rebuildStoryMacroBake();

  // Story plate: dense enough for soft shoulders, not so dense it tanks FPS with skirts.
  if (MAP_TERRAIN_STYLE === 'hills') {
    BATTLE_TERRAIN.segmentsWidth = 192;
    BATTLE_TERRAIN.segmentsDepth = 192;
  } else {
    BATTLE_TERRAIN.segmentsWidth = 96;
    BATTLE_TERRAIN.segmentsDepth = 96;
  }
  const geometry = new THREE.PlaneGeometry(
    BATTLE_TERRAIN.width,
    BATTLE_TERRAIN.depth,
    BATTLE_TERRAIN.segmentsWidth,
    BATTLE_TERRAIN.segmentsDepth
  );
  const vertices = geometry.attributes.position.array;
  const Rcurv = moonHorizonCurvatureRadiusM();
  const inv2R = Number.isFinite(Rcurv) && Rcurv < 1e9 ? 1 / (2 * Rcurv) : 0;
  const segW = BATTLE_TERRAIN.segmentsWidth;
  const segD = BATTLE_TERRAIN.segmentsDepth;
  const nVerts = (segW + 1) * (segD + 1);
  centralTerrainHeightGrid = new Float32Array(nVerts);

  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i];
    const z = vertices[i + 1];
    const wx = x;
    const wz = -z;
    const noiseVal = battleTerrainFbm(x / BATTLE_TERRAIN.scale, 0, z / BATTLE_TERRAIN.scale) - 0.5;
    const r2 = x * x + z * z;
    // Navigable bowl (planet curvature + micro-relief). Macros are non-navigable blockers.
    const base = noiseVal * BATTLE_TERRAIN.amp - r2 * inv2R;
    const macro = sampleNonNavigableMacroLift(wx, wz);
    const y = base + macro;
    vertices[i + 2] = y;
    centralTerrainHeightGrid[i / 3] = y;
  }
  // Do NOT run spike/erode on the composed plate — that carved black crease lines across
  // legitimate soft hills (crest cells get crushed by low cross-axis flanks). Thin-wall
  // killing belongs only in `rebuildStoryMacroBake` on the macro lift.
  geometry.computeVertexNormals();
  geometry.attributes.position.needsUpdate = true;
  applyWarpedMoonTerrainUvs(geometry);
  duplicateUvForAoMap(geometry);
  computeMoonGroundTangents(geometry);
  // Available immediately for path/spawn Y; skirts rebuild the same field before attaching.
  rebuildGameplayHeightGrid();
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
  const MAP = mapPlateM();
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
  const MAP = mapPlateM();
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

/** Keep in sync with `scene-reveal.js` settle target. */
export const MOON_TONE_MAPPING_EXPOSURE = 1.06;

/** Slightly lift exposure so Poly Haven albedo + AO read closer to reference. */
export function configureTerrainPresentation(sceneEl) {
  const THREE = window.THREE;
  const r = sceneEl && sceneEl.renderer;
  if (!r || !THREE) return;
  r.toneMapping = THREE.ACESFilmicToneMapping;
  r.toneMappingExposure = MOON_TONE_MAPPING_EXPOSURE;
}

function disposeMaterial(mat) {
  if (mat && mat.dispose) mat.dispose();
}

/** When true, skip moon textures and draw slope heat from world-space geometric normals. */
function moonSlopeDebugActive() {
  if (typeof window === 'undefined') return false;
  if (window.RTS_MOON_SLOPE_DEBUG === true) return true;
  try {
    const v = new URLSearchParams(window.location.search).get('slopeDebug');
    return v === '1' || v === 'true';
  } catch (_) {
    return false;
  }
}

/**
 * Angle from **horizontal** (0° = flat, 90° = vertical): `acos(clamp(worldNormal.y,0,1))`.
 * 0°–45°: green → yellow → red; **≥45°** solid red. Unlit; ignores albedo / normal maps.
 */
function buildMoonSlopeDebugMaterial(THREE) {
  return new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      varying vec3 vWorldN;
      void main() {
        vWorldN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vWorldN;
      void main() {
        float cosUp = clamp(vWorldN.y, 0.0, 1.0);
        float theta = acos(cosUp);
        const float PI_OVER_4 = 0.7853981633974483;
        float u = theta / PI_OVER_4;
        vec3 green = vec3(0.0, 1.0, 0.0);
        vec3 yellow = vec3(1.0, 1.0, 0.0);
        vec3 red = vec3(1.0, 0.0, 0.0);
        vec3 col;
        if (u >= 1.0) {
          col = red;
        } else {
          float t = clamp(u, 0.0, 1.0);
          col = t < 0.5
            ? mix(green, yellow, t * 2.0)
            : mix(yellow, red, (t - 0.5) * 2.0);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    fog: false,
    side: THREE.DoubleSide,
    glslVersion: THREE.GLSL1,
  });
}

function installMoonSlopeDebugMaterialIfActive(THREE, sceneEl, mesh) {
  if (!moonSlopeDebugActive()) return false;
  disposeMaterial(mesh.material);
  mesh.material = buildMoonSlopeDebugMaterial(THREE);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  tryAttachHorizonSkirt(THREE, mesh, sceneEl);
  return true;
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

/** Recreate the optional XZ helper grid to match the live plate size (Story 400 / standard 200). */
function syncTerrainGridHelperSize() {
  const THREE = window.THREE;
  const mount = document.getElementById('gridHelper');
  if (!THREE || !mount || !mount.object3D) return;
  const root = mount.object3D;
  let wasVisible = false;
  const doomed = [];
  root.traverse((obj) => {
    if (obj.isLineSegments) {
      wasVisible = wasVisible || obj.visible;
      doomed.push(obj);
    }
  });
  for (const obj of doomed) {
    if (obj.parent) obj.parent.remove(obj);
    obj.geometry?.dispose?.();
  }
  const size = mapPlateM();
  const divs = MAP_TERRAIN_STYLE === 'hills' ? 40 : 28;
  const gridHelper = new THREE.GridHelper(size, divs, 0x4a4a52, 0x35353c);
  gridHelper.position.y = 0.02;
  gridHelper.visible = wasVisible;
  root.add(gridHelper);
  styleMoonGrid();
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

/**
 * @returns {Promise<void>} Resolves when a diffuse map is on `mesh` (file, procedural, or give up).
 */
function loadFallbackDiffuseChain(THREE, sceneEl, mesh, urls, index) {
  return new Promise((resolve) => {
    if (installMoonSlopeDebugMaterialIfActive(THREE, sceneEl, mesh)) {
      resolve();
      return;
    }
    if (index >= urls.length) {
      const map = buildProceduralMoonTexture(THREE, sceneEl);
      if (!map) {
        resolve();
        return;
      }
      disposeMaterial(mesh.material);
      mesh.material = new THREE.MeshLambertMaterial({ map, color: 0xffffff });
      mesh.receiveShadow = false;
      mesh.castShadow = false;
      tryAttachHorizonSkirt(THREE, mesh, sceneEl);
      resolve();
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
        mesh.receiveShadow = false;
        mesh.castShadow = false;
        tryAttachHorizonSkirt(THREE, mesh, sceneEl);
        resolve();
      },
      undefined,
      () => {
        loadFallbackDiffuseChain(THREE, sceneEl, mesh, urls, index + 1).then(resolve);
      }
    );
  });
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

/** First successful URL wins; all failures → `null`. */
function loadFirstTextureFromUrls(loader, urls) {
  return new Promise((resolve) => {
    let index = 0;
    function tryNext() {
      if (index >= urls.length) {
        resolve(null);
        return;
      }
      const url = urls[index];
      index += 1;
      loader.load(
        url,
        (tex) => resolve(tex),
        undefined,
        tryNext
      );
    }
    tryNext();
  });
}

function tryRendererInitTexture(renderer, tex) {
  if (!tex || !renderer || typeof renderer.initTexture !== 'function') return;
  try {
    renderer.initTexture(tex);
  } catch (_) {
    /* ignore */
  }
}

/**
 * Moon ground UVs are top-down (world XZ). That looks fine on flats but **stretches into stripes**
 * on steep Story hills / crater walls. Patch MeshStandardMaterial to sample map / rough / AO / normals
 * with world-space triplanar blending instead.
 *
 * World density is locked to the **standard 200 m plate** so Story's larger map stays as sharp as skirmish
 * (do not divide by `MAP_SIZE_STORY` or detail halves).
 *
 * Flat look is preserved: blend weights favor the Y (top-down) projection wherever the surface is
 * mostly horizontal, so skirmish / Story flats match. Side projections only win on steep faces.
 */
function moonTriplanarWorldToUv() {
  return MOON_UV_REPEAT / Math.max(1, MAP_SIZE_STANDARD);
}

function syncMoonTriplanarUniforms(material) {
  if (!material || !material.userData) return;
  material.userData.moonTriScale = moonTriplanarWorldToUv();
  const sh = material.userData.moonTriShader;
  if (sh && sh.uniforms && sh.uniforms.uMoonTriScale) {
    sh.uniforms.uMoonTriScale.value = material.userData.moonTriScale;
  }
}

function installMoonTriplanarSampling(material) {
  if (!material || material.userData.moonTriplanarInstalled) {
    syncMoonTriplanarUniforms(material);
    return;
  }
  material.userData.moonTriplanarInstalled = true;
  material.userData.moonTriScale = moonTriplanarWorldToUv();
  // Bump key whenever the GLSL below changes (force recompile).
  material.customProgramCacheKey = () =>
    'rts-moon-triplanar-v5|sh' + (material.userData.shadowRecv ? '1' : '0');

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMoonTriScale = { value: material.userData.moonTriScale };
    material.userData.moonTriShader = shader;

    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      /* glsl */ `
      varying vec3 vMoonWorldPos;
      varying vec3 vMoonWorldNormal;
      void main() {
      `
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      /* glsl */ `
      #include <begin_vertex>
      vMoonWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vMoonWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      /* glsl */ `
      varying vec3 vMoonWorldPos;
      varying vec3 vMoonWorldNormal;
      uniform float uMoonTriScale;

      // Per-pixel face normal beats coarse vertex normals on steep massifs.
      vec3 moonFaceNormal() {
        vec3 vn = normalize(vMoonWorldNormal);
        vec3 fn = cross(dFdx(vMoonWorldPos), dFdy(vMoonWorldPos));
        float fl = length(fn);
        if (fl > 1e-8) {
          fn /= fl;
          if (dot(fn, vn) < 0.0) fn = -fn;
          // Prefer analytic face direction on slopes; keep vertex n on flats for stability.
          float steep = 1.0 - abs(vn.y);
          vn = normalize(mix(vn, fn, smoothstep(0.15, 0.55, steep)));
        }
        return vn;
      }

      vec3 moonTriBlend() {
        vec3 b = abs(moonFaceNormal());
        // Mild power: flats stay almost pure +Y (same look as skirmish); slopes hand off cleanly.
        b = pow(max(b, vec3(1e-4)), vec3(3.0));
        return b / (b.x + b.y + b.z);
      }

      vec4 moonTriSample(sampler2D tex) {
        vec3 b = moonTriBlend();
        float s = uMoonTriScale;
        vec4 x = texture2D(tex, vMoonWorldPos.zy * s);
        vec4 y = texture2D(tex, vMoonWorldPos.xz * s);
        vec4 z = texture2D(tex, vMoonWorldPos.xy * s);
        return x * b.x + y * b.y + z * b.z;
      }

      void main() {
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
      #ifdef USE_MAP
        vec4 sampledDiffuseColor = moonTriSample(map);
        diffuseColor *= sampledDiffuseColor;
      #endif
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      /* glsl */ `
      float roughnessFactor = roughness;
      #ifdef USE_ROUGHNESSMAP
        vec4 texelRoughness = moonTriSample(roughnessMap);
        roughnessFactor *= texelRoughness.g;
      #endif
      `
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <aomap_fragment>',
      /* glsl */ `
      #ifdef USE_AOMAP
        float ambientOcclusion = ( moonTriSample( aoMap ).r - 1.0 ) * aoMapIntensity + 1.0;
        reflectedLight.indirectDiffuse *= ambientOcclusion;
        #if defined( USE_ENVMAP ) && defined( STANDARD )
          float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
          reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
        #endif
      #endif
      `
    );

    // Replace planar tangent-space normals — those were the remaining "smear" on hills.
    // Defined here (after normalmap_pars) so `normalMap` / `normalScale` exist.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */ `
      #ifdef USE_NORMALMAP
        {
          vec3 nG = moonFaceNormal();
          vec3 bN = moonTriBlend();
          float sN = uMoonTriScale;
          vec3 axisSign = sign(nG + vec3(1e-4));

          vec3 tX = texture2D(normalMap, vMoonWorldPos.zy * sN).xyz * 2.0 - 1.0;
          vec3 tY = texture2D(normalMap, vMoonWorldPos.xz * sN).xyz * 2.0 - 1.0;
          vec3 tZ = texture2D(normalMap, vMoonWorldPos.xy * sN).xyz * 2.0 - 1.0;
          tX.xy *= normalScale;
          tY.xy *= normalScale;
          tZ.xy *= normalScale;

          // Whiteout / RNM triplanar (bgolus) — flats keep pebble detail; slopes don't streak.
          tX = vec3(tX.xy + nG.zy, abs(tX.z) * nG.x);
          tY = vec3(tY.xy + nG.xz, abs(tY.z) * nG.y);
          tZ = vec3(tZ.xy + nG.xy, abs(tZ.z) * nG.z);

          vec3 nW =
            tX.zyx * vec3(axisSign.x, 1.0, 1.0) * bN.x +
            tY.xzy * vec3(1.0, axisSign.y, 1.0) * bN.y +
            tZ.xyz * vec3(1.0, 1.0, axisSign.z) * bN.z;
          normal = normalize( mat3( viewMatrix ) * normalize( nW ) );
        }
      #elif defined( USE_BUMPMAP )
        normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
      #endif
      `
    );
  };

  material.needsUpdate = true;
}

/**
 * Normal / rough / AO for the battle moon (await before scene reveal).
 * @returns {Promise<void>}
 */
async function attachMoonSurfaceTextureMapsAsync(THREE, sceneEl, material) {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const renderer = sceneEl && sceneEl.renderer;

  const norTex = await loadFirstTextureFromUrls(loader, collectMoonNorJpgUrls());
  if (norTex) {
    configureMoonDataTexture(norTex, THREE, sceneEl);
    material.normalMap = norTex;
    material.normalScale.set(MOON_NORMAL_SCALE, MOON_NORMAL_SCALE);
    material.bumpMap = null;
    material.bumpScale = 0;
    material.needsUpdate = true;
    tryRendererInitTexture(renderer, norTex);
  }

  if (material.isMeshStandardMaterial) {
    const roughTex = await loadFirstTextureFromUrls(loader, collectMoonRoughJpgUrls());
    if (roughTex) {
      configureMoonDataTexture(roughTex, THREE, sceneEl);
      material.roughnessMap = roughTex;
      material.roughness = 1;
      material.needsUpdate = true;
      tryRendererInitTexture(renderer, roughTex);
    }
  }

  const aoTex = await loadFirstTextureFromUrls(loader, collectMoonAoJpgUrls());
  if (aoTex) {
    configureMoonDataTexture(aoTex, THREE, sceneEl);
    material.aoMap = aoTex;
    material.aoMapIntensity = material.isMeshStandardMaterial ? 1 : 0.5;
    material.needsUpdate = true;
    tryRendererInitTexture(renderer, aoTex);
  }
}

/**
 * @returns {Promise<void>} Resolves when diffuse + detail maps + horizon skirt are in place (or fallback diffuse only).
 */
async function createBattleMoonMaterial(THREE, sceneEl) {
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const colorTexture = await loadFirstTextureFromUrls(loader, assetUrlCandidates(BATTLE_MOON.diff));
  if (!colorTexture) return null;
  configureMoonDiffuseTexture(colorTexture, THREE, sceneEl);
  const livePbr = moonLivePbrRequested();
  const material = livePbr
    ? new THREE.MeshStandardMaterial({
        map: colorTexture,
        bumpMap: colorTexture,
        bumpScale: MOON_BUMP_SCALE,
        color: 0xffffff,
        roughness: 0.88,
        metalness: 0,
        flatShading: false,
        fog: false,
      })
    : new THREE.MeshLambertMaterial({
        map: colorTexture,
        color: 0xffffff,
        fog: false,
      });
  if (!livePbr) {
    material.color.setRGB(1.55, 1.55, 1.55);
    material.envMap = null;
    if ('envMapIntensity' in material) material.envMapIntensity = 0;
    material.userData.cheapMoonLook = true;
  }
  installMoonTriplanarSampling(material);
  tryRendererInitTexture(sceneEl && sceneEl.renderer, colorTexture);
  await attachMoonSurfaceTextureMapsAsync(THREE, sceneEl, material);
  return material;
}

function applyBattleMoon(THREE, sceneEl, mesh) {
  return new Promise((resolve) => {
    if (installMoonSlopeDebugMaterialIfActive(THREE, sceneEl, mesh)) {
      resolve();
      return;
    }
    void (async () => {
      try {
        const material = await createBattleMoonMaterial(THREE, sceneEl);
        if (!material) {
          await loadFallbackDiffuseChain(THREE, sceneEl, mesh, collectFallbackDiffuseUrls(), 0);
          return;
        }
        disposeMaterial(mesh.material);
        mesh.material = material;
        mesh.receiveShadow =
          typeof window._getDynamicShadowsEnabled === 'function'
            ? !!window._getDynamicShadowsEnabled()
            : false;
        mesh.castShadow = false;
        if (material.userData) material.userData.shadowRecv = !!mesh.receiveShadow;
        tryAttachHorizonSkirt(THREE, mesh, sceneEl);
      } finally {
        resolve();
      }
    })();
  });
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

function disposeGroundObject(root, keepMat) {
  if (!root) return;
  disposeHorizonSkirtUnder(root);
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    const mats = obj.material == null ? [] : Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (mat && mat !== keepMat) disposeMaterial(mat);
    }
  });
}

function disposeGroundVisual(groundEl, keepMat) {
  const prev = groundEl.getObject3D('mesh');
  if (!prev) return;
  groundEl.removeObject3D('mesh');
  disposeGroundObject(prev, keepMat);
}

function snapshotSkirmishPark(root) {
  parkedSkirmish = {
    root,
    plate: bakedMoonPlate,
    centralGrid: centralTerrainHeightGrid,
    gameplayGrid: gameplayHeightGrid,
    gameplayN: gameplayHeightN,
    gameplayHalf: gameplayHeightHalf,
    gameplayCell: gameplayHeightCell,
  };
}

function restoreSkirmishPark() {
  const live = parkedSkirmish;
  parkedSkirmish = null;
  if (!live || !live.root) return null;
  live.root.visible = true;
  bakedMoonRoot = live.root;
  bakedMoonPlate = live.plate;
  centralTerrainHeightGrid = live.centralGrid;
  gameplayHeightGrid = live.gameplayGrid;
  gameplayHeightN = live.gameplayN;
  gameplayHeightHalf = live.gameplayHalf;
  gameplayHeightCell = live.gameplayCell;
  terrainHeightGen += 1;
  return live.root;
}

export async function applyMoonBattlefieldVisuals(sceneEl) {
  const THREE = window.THREE;
  if (!THREE || !sceneEl) return;

  const groundEl = document.getElementById('ground');
  if (!groundEl || !groundEl.object3D) return;

  horizonSkirtAttached = false;
  bakedMoonRoot = null;
  bakedMoonPlate = null;

  const baked = await tryLoadBakedSkirmishMoon();
  if (baked) {
    groundEl.setObject3D('mesh', baked);
    await finishBakedMoonLook(THREE, sceneEl, baked);
    configureTerrainPresentation(sceneEl);
    styleMoonGrid();
    const gridMount = document.getElementById('gridHelper');
    if (gridMount && gridMount.object3D) {
      gridMount.object3D.traverse((o) => {
        if (o.isLineSegments) terrainGridVisible = o.visible;
      });
    }
    return;
  }

  const terrainGeom = buildBattleTerrainGeometry(THREE);
  const mesh = new THREE.Mesh(
    terrainGeom,
    new THREE.MeshLambertMaterial({ color: 0x5c5c60 })
  );
  mesh.name = 'rts-ground-mesh';
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow =
    typeof window._getDynamicShadowsEnabled === 'function'
      ? !!window._getDynamicShadowsEnabled()
      : false;
  mesh.castShadow = false;
  groundEl.setObject3D('mesh', mesh);

  await applyBattleMoon(THREE, sceneEl, mesh);
  configureTerrainPresentation(sceneEl);
  styleMoonGrid();
  const gridMount = document.getElementById('gridHelper');
  if (gridMount && gridMount.object3D) {
    gridMount.object3D.traverse((o) => {
      if (o.isLineSegments) terrainGridVisible = o.visible;
    });
  }
}

/**
 * Rebuild central plate + skirts after `applyMapProfile` / Story hill changes.
 * Keeps the skirmish GLB resident during Story (load-before-unload) so returning
 * to 1v1 does not freeze Quest on a 40MB decode + height raycast.
 */
export async function rebuildMoonBattlefield(sceneEl) {
  const THREE = window.THREE;
  if (!THREE || !sceneEl) return;

  const groundEl = document.getElementById('ground');
  if (!groundEl || !groundEl.object3D) return;

  const prev = groundEl.getObject3D('mesh');
  const prevIsBake = !!(prev && prev.userData && prev.userData.rtsSkirmishBake);

  if (bakedMoonAllowed() && parkedSkirmish && parkedSkirmish.root) {
    const restored = restoreSkirmishPark();
    if (restored) {
      BATTLE_TERRAIN.segmentsWidth = 96;
      BATTLE_TERRAIN.segmentsDepth = 96;
      groundEl.setObject3D('mesh', restored);
      if (prev && prev !== restored) disposeGroundObject(prev);
      horizonSkirtAttached = false;
      await finishBakedMoonLook(THREE, sceneEl, restored, { skipHeight: true });
      configureTerrainPresentation(sceneEl);
      syncTerrainGridHelperSize();
      console.log('[RTSVR4] restored parked skirmish moon');
      return;
    }
  }

  if (!bakedMoonAllowed() && prevIsBake) {
    snapshotSkirmishPark(prev);
  }

  horizonSkirtAttached = false;
  bakedMoonRoot = null;
  bakedMoonPlate = null;

  const baked = await tryLoadBakedSkirmishMoon();
  if (baked) {
    groundEl.setObject3D('mesh', baked);
    if (prev && prev !== baked) {
      if (parkedSkirmish && prev === parkedSkirmish.root) prev.visible = false;
      else disposeGroundObject(prev);
    }
    await finishBakedMoonLook(THREE, sceneEl, baked);
    configureTerrainPresentation(sceneEl);
    syncTerrainGridHelperSize();
    return;
  }

  const keepMat =
    prev && prev.isMesh && prev.material && !prevIsBake ? prev.material : null;
  const terrainGeom = buildBattleTerrainGeometry(THREE);
  const mesh = new THREE.Mesh(
    terrainGeom,
    keepMat || new THREE.MeshLambertMaterial({ color: 0x5c5c60 })
  );
  mesh.name = 'rts-ground-mesh';
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow =
    typeof window._getDynamicShadowsEnabled === 'function'
      ? !!window._getDynamicShadowsEnabled()
      : false;
  mesh.castShadow = false;
  groundEl.setObject3D('mesh', mesh);
  if (prev && prev !== mesh) {
    if (parkedSkirmish && prev === parkedSkirmish.root) prev.visible = false;
    else disposeGroundObject(prev, keepMat);
  }

  await applyBattleMoon(THREE, sceneEl, mesh);
  configureTerrainPresentation(sceneEl);
  syncTerrainGridHelperSize();
}
