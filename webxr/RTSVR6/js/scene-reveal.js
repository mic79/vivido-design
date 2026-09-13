/**
 * Cinematic first paint: ramp from black via low tone exposure, then a strong exposure overshoot
 * (ACES highlight punch) while fading a DOM overlay on desktop. In WebXR the overlay is skipped
 * so the same exposure / HDR-intensity ramp carries the effect in-headset.
 */

import { MOON_TONE_MAPPING_EXPOSURE } from './moon-environment.js';

const HDR_ENV_BASE = 0.4;
const HDR_BG_BASE = 1;

function easeOutCubic(t) {
  const x = 1 - Math.max(0, Math.min(1, t));
  return 1 - x * x * x;
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

function collectDirectionalLights(root, out) {
  if (!root) return;
  root.traverse((o) => {
    if (o && o.isDirectionalLight) out.push(o);
  });
}

/**
 * @param {HTMLElement} sceneEl
 * @returns {HTMLElement | null}
 */
function getRevealOverlay() {
  return document.getElementById('scene-reveal-overlay');
}

/**
 * Full black + crushed exposure before HDR / terrain are shown.
 * @param {HTMLElement} sceneEl
 */
export function primeSceneRevealBlack(sceneEl) {
  const overlay = getRevealOverlay();
  if (overlay) {
    overlay.style.display = 'block';
    overlay.style.opacity = '1';
    overlay.style.pointerEvents = 'auto';
  }
  const r = sceneEl && sceneEl.renderer;
  const scene = sceneEl && sceneEl.object3D;
  if (r) r.toneMappingExposure = 0.02;
  if (scene && 'backgroundIntensity' in scene && typeof scene.backgroundIntensity === 'number') {
    scene.backgroundIntensity = 0;
  }
  if (scene && 'environmentIntensity' in scene && typeof scene.environmentIntensity === 'number') {
    scene.environmentIntensity = 0;
  }
}

/**
 * @param {HTMLElement} sceneEl
 * @param {object} [opts]
 * @param {number} [opts.durationMs]
 * @param {number} [opts.peakExposure] — ACES exposure overshoot for the reveal
 * @returns {Promise<void>}
 */
export function runSceneRevealFromBlack(sceneEl, opts = {}) {
  const durationMs = typeof opts.durationMs === 'number' ? opts.durationMs : 3200;
  const peakExposure = typeof opts.peakExposure === 'number' ? opts.peakExposure : 2.75;
  const finalExposure = MOON_TONE_MAPPING_EXPOSURE;
  const peakEnvMul = typeof opts.peakEnvMul === 'number' ? opts.peakEnvMul : 2.15;
  const peakBgMul = typeof opts.peakBgMul === 'number' ? opts.peakBgMul : 1.35;

  const overlay = getRevealOverlay();
  const r = sceneEl && sceneEl.renderer;
  const scene = sceneEl && sceneEl.object3D;
  const xrSkipOverlay = !!(r && r.xr && r.xr.isPresenting);

  const dirs = [];
  collectDirectionalLights(scene, dirs);
  const dirBases = dirs.map((l) => l.intensity);

  return new Promise((resolve) => {
    const t0 = performance.now();

    function frame(now) {
      const u = Math.min(1, (now - t0) / durationMs);
      const overlayEase = easeOutCubic(u);

      if (overlay && !xrSkipOverlay) {
        overlay.style.opacity = String(1 - overlayEase);
      }

      // Exposure: dark → strong peak (mid) → settled
      const peakT = 0.36;
      let exp;
      if (u < peakT) {
        const v = smoothstep(0, peakT, u);
        exp = 0.02 + (peakExposure - 0.02) * v;
      } else {
        const v = smoothstep(peakT, 1, u);
        exp = peakExposure + (finalExposure - peakExposure) * v;
      }

      if (r) r.toneMappingExposure = exp;

      // HDR sky / IBL: fade in, then a short intensity pulse (no postprocess; WebXR-safe).
      const open = smoothstep(0, 0.26, u);
      const pulse = Math.sin(Math.PI * Math.pow(Math.min(1, u / 0.52), 1.05));
      if (scene && 'backgroundIntensity' in scene && typeof scene.backgroundIntensity === 'number') {
        const mul = 1 + (peakBgMul - 1) * pulse;
        scene.backgroundIntensity = HDR_BG_BASE * open * mul;
      }
      if (scene && 'environmentIntensity' in scene && typeof scene.environmentIntensity === 'number') {
        const mul = 1 + (peakEnvMul - 1) * pulse;
        scene.environmentIntensity = HDR_ENV_BASE * open * mul;
      }

      const dirBoost = 1 + 0.95 * Math.sin(Math.PI * Math.min(1, u / 0.42));
      for (let i = 0; i < dirs.length; i++) {
        dirs[i].intensity = dirBases[i] * dirBoost;
      }

      if (u < 1) {
        requestAnimationFrame(frame);
        return;
      }

      if (r) r.toneMappingExposure = finalExposure;
      if (scene && 'backgroundIntensity' in scene && typeof scene.backgroundIntensity === 'number') {
        scene.backgroundIntensity = HDR_BG_BASE;
      }
      if (scene && 'environmentIntensity' in scene && typeof scene.environmentIntensity === 'number') {
        scene.environmentIntensity = HDR_ENV_BASE;
      }
      for (let i = 0; i < dirs.length; i++) {
        dirs[i].intensity = dirBases[i];
      }
      if (overlay) {
        overlay.style.opacity = '0';
        overlay.style.pointerEvents = 'none';
        overlay.style.display = 'none';
      }
      resolve();
    }

    requestAnimationFrame(frame);
  });
}
