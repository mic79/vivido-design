// ========================================
// RTSVR4 — Desktop perf profiler + ablation flags
// Enable with ?perf=1 (timers) and optional ?nobot=1&nofog=1&…
// ========================================

/** @typedef {{ bot: boolean, fog: boolean, fogOverlay: boolean, combat: boolean, movement: boolean, harvesters: boolean, buildings: boolean, render: boolean, effects: boolean, ui: boolean, input: boolean, network: boolean, spatial: boolean }} AblationFlags */

const BUCKETS = [
  'input',
  'spatial',
  'bot',
  'buildings',
  'movement',
  'harvesters',
  'combat',
  'fog',
  'network',
  // Render breakdown (also summed into `render` by caller if desired — we time leaves only)
  'render.units',
  'render.buildings',
  'render.health',
  'render.rings',
  'render.orders',
  'render.resources',
  'render.projectiles',
  'render.fogOverlay',
  'render.misc',
  'render',
  'effects',
  // UI breakdown
  'ui.hud',
  'ui.minimap',
  'ui.panels',
  'ui.vr',
  'ui',
  'frame',
];

let enabled = false;
/** @type {AblationFlags} */
let ablation = {
  bot: true,
  fog: true,
  fogOverlay: true,
  combat: true,
  movement: true,
  harvesters: true,
  buildings: true,
  render: true,
  effects: true,
  ui: true,
  input: true,
  network: true,
  spatial: true,
};

/** @type {Record<string, number>} */
let sumMs = Object.fromEntries(BUCKETS.map(k => [k, 0]));
/** @type {Record<string, number>} */
let maxMs = Object.fromEntries(BUCKETS.map(k => [k, 0]));
let frames = 0;
let sampleStartedAt = 0;
/** Instantaneous FPS from frame wall time (for min/max during sample). */
let fpsSum = 0;
let fpsMin = Infinity;
let fpsMax = 0;
let gpuCallsSum = 0;
let gpuTrisSum = 0;
let gpuSamples = 0;
let gpuSkipSum = 0;
let lastGpu = { calls: 0, triangles: 0 };
/** Boot-time asset flags (from URL; applied before HDR / GLB load). */
let loadCubemap = true;
let loadGltfAssets = true;

function truthyParam(v) {
  return v === '1' || v === 'true' || v === 'yes';
}

export function initPerfFromUrl(search = typeof location !== 'undefined' ? location.search : '') {
  try {
    const sp = new URLSearchParams(search || '');
    enabled = truthyParam(sp.get('perf'));
    if (truthyParam(sp.get('nobot'))) ablation.bot = false;
    if (truthyParam(sp.get('nofog'))) {
      ablation.fog = false;
      ablation.fogOverlay = false;
    }
    if (truthyParam(sp.get('nofogoverlay'))) ablation.fogOverlay = false;
    if (truthyParam(sp.get('nocombat'))) ablation.combat = false;
    if (truthyParam(sp.get('nomove'))) ablation.movement = false;
    if (truthyParam(sp.get('noharvest'))) ablation.harvesters = false;
    if (truthyParam(sp.get('nobuild'))) ablation.buildings = false;
    if (truthyParam(sp.get('norender'))) ablation.render = false;
    if (truthyParam(sp.get('noeffects'))) ablation.effects = false;
    if (truthyParam(sp.get('noui'))) ablation.ui = false;
    if (truthyParam(sp.get('noinput'))) ablation.input = false;
    if (truthyParam(sp.get('nonet'))) ablation.network = false;
    if (truthyParam(sp.get('nospatial'))) ablation.spatial = false;
    // Boot asset ablations
    if (
      truthyParam(sp.get('nocubemap')) ||
      truthyParam(sp.get('nohdr')) ||
      truthyParam(sp.get('noenv'))
    ) {
      loadCubemap = false;
    }
    if (
      truthyParam(sp.get('simplegeo')) ||
      truthyParam(sp.get('noglb')) ||
      truthyParam(sp.get('notextured'))
    ) {
      loadGltfAssets = false;
    }
  } catch (_) {
    enabled = false;
  }
  if (typeof window !== 'undefined') {
    window.__rtsPerf = api;
  }
  return enabled;
}

export function shouldLoadCubemap() {
  return loadCubemap;
}

export function shouldLoadGltfAssets() {
  return loadGltfAssets;
}

export function isPerfEnabled() {
  return enabled;
}

export function setPerfEnabled(on) {
  enabled = !!on;
}

/** @returns {AblationFlags} */
export function getAblation() {
  return ablation;
}

/** @param {Partial<AblationFlags>} flags */
export function setAblation(flags) {
  ablation = { ...ablation, ...flags };
}

export function resetSamples() {
  sumMs = Object.fromEntries(BUCKETS.map(k => [k, 0]));
  maxMs = Object.fromEntries(BUCKETS.map(k => [k, 0]));
  frames = 0;
  sampleStartedAt = performance.now();
  fpsSum = 0;
  fpsMin = Infinity;
  fpsMax = 0;
  gpuCallsSum = 0;
  gpuTrisSum = 0;
  gpuSamples = 0;
  gpuSkipSum = 0;
  lastGpu = { calls: 0, triangles: 0 };
}

/** Call from A-Frame `tock` (after WebGL present) so draw/tri counts are real. */
export function noteGpuFromRenderer(renderer) {
  if (!enabled || !renderer || !renderer.info || !renderer.info.render) return;
  const sceneEl = typeof document !== 'undefined' ? document.querySelector('a-scene') : null;
  if (sceneEl && sceneEl.__rtsSkipRender) {
    lastGpu = { calls: 0, triangles: 0 };
    gpuSkipSum++;
    gpuSamples++;
    return;
  }
  const r = renderer.info.render;
  lastGpu = { calls: r.calls | 0, triangles: r.triangles | 0 };
  gpuCallsSum += lastGpu.calls;
  gpuTrisSum += lastGpu.triangles;
  gpuSamples++;
}

/**
 * @param {string} name
 * @param {() => void} fn
 */
export function time(name, fn) {
  if (!enabled) {
    fn();
    return;
  }
  const t0 = performance.now();
  fn();
  const dt = performance.now() - t0;
  if (sumMs[name] == null) {
    sumMs[name] = 0;
    maxMs[name] = 0;
  }
  sumMs[name] += dt;
  if (dt > maxMs[name]) maxMs[name] = dt;
}

export function beginFrame() {
  if (!enabled) return;
  // counted in endFrame
}

export function endFrame(frameMs) {
  if (!enabled) return;
  frames++;
  sumMs.frame += frameMs;
  if (frameMs > maxMs.frame) maxMs.frame = frameMs;
  const instFps = frameMs > 0.0001 ? 1000 / frameMs : 0;
  if (instFps > 0) {
    fpsSum += instFps;
    if (instFps < fpsMin) fpsMin = instFps;
    if (instFps > fpsMax) fpsMax = instFps;
  }
}

export function snapshot() {
  const wallMs = Math.max(1, performance.now() - (sampleStartedAt || performance.now()));
  const avg = {};
  const pct = {};
  for (const k of Object.keys(sumMs)) {
    avg[k] = frames > 0 ? sumMs[k] / frames : 0;
  }
  // Roll up leaf buckets into ui / render totals (leaves are timed; parents are derived).
  avg.ui =
    (avg['ui.hud'] || 0) +
    (avg['ui.minimap'] || 0) +
    (avg['ui.panels'] || 0) +
    (avg['ui.vr'] || 0);
  avg.render =
    (avg['render.units'] || 0) +
    (avg['render.buildings'] || 0) +
    (avg['render.health'] || 0) +
    (avg['render.rings'] || 0) +
    (avg['render.orders'] || 0) +
    (avg['render.resources'] || 0) +
    (avg['render.projectiles'] || 0) +
    (avg['render.fogOverlay'] || 0) +
    (avg['render.misc'] || 0);
  const frameAvg = avg.frame || 0;
  for (const k of Object.keys(avg)) {
    pct[k] = frameAvg > 0 ? (avg[k] / frameAvg) * 100 : 0;
  }
  const wallFps = (frames / wallMs) * 1000;
  return {
    enabled,
    ablation: { ...ablation },
    boot: {
      cubemap: loadCubemap,
      gltfAssets: loadGltfAssets,
    },
    frames,
    wallMs,
    /** Average FPS over the sample window (frames / wall time). */
    fps: wallFps,
    fpsAvg: wallFps,
    fpsMin: frames > 0 && fpsMin !== Infinity ? fpsMin : 0,
    fpsMax: frames > 0 ? fpsMax : 0,
    /** Mean of per-frame instantaneous FPS (1/frameMs). */
    fpsMeanInstant: frames > 0 ? fpsSum / frames : 0,
    gpu: {
      callsAvg: gpuSamples > 0 ? gpuCallsSum / gpuSamples : 0,
      trisAvg: gpuSamples > 0 ? gpuTrisSum / gpuSamples : 0,
      callsLast: lastGpu.calls,
      trisLast: lastGpu.triangles,
      samples: gpuSamples,
      skipPct: gpuSamples > 0 ? (gpuSkipSum / gpuSamples) * 100 : 0,
    },
    avgMs: avg,
    maxMs: { ...maxMs },
    pctOfFrame: pct,
    sumMs: { ...sumMs },
  };
}

const api = {
  initPerfFromUrl,
  isPerfEnabled,
  setPerfEnabled,
  shouldLoadCubemap,
  shouldLoadGltfAssets,
  getAblation,
  setAblation,
  resetSamples,
  time,
  noteGpuFromRenderer,
  snapshot,
  buckets: BUCKETS,
};

export default api;
