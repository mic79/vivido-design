/**
 * Verify fog sheet stays above navigable bowl (no FBM punch-through gaps).
 * Mirrors renderer fog build (lift 3m + neighborhood clearance).
 * Run: node verify-fog-nav.mjs
 */
import { applyMapProfile, MAP_NAV_PLANE_SPAN_M } from './js/config.js';
import { sampleMoonTraversableBaseY } from './js/moon-environment.js';

const FOG_OVERLAY_ABOVE_NAV_M = 3;

function fogNavigableClearanceY(wx, wz, halfCell) {
  const s = Math.max(6, halfCell * 1.15);
  let m = sampleMoonTraversableBaseY(wx, wz);
  for (const [dx, dz] of [
    [s, 0], [-s, 0], [0, s], [0, -s],
    [s, s], [-s, -s], [s, -s], [-s, s],
  ]) {
    m = Math.max(m, sampleMoonTraversableBaseY(wx + dx, wz + dz));
  }
  return Number.isFinite(m) ? m : 0;
}

function buildFogGrid() {
  const span = MAP_NAV_PLANE_SPAN_M;
  const half = span * 0.5;
  const segs = Math.max(64, Math.min(128, Math.round(span / 12)));
  const halfCell = span / segs / 2;
  const row = segs + 1;
  const ys = new Float32Array(row * row);
  for (let iz = 0; iz <= segs; iz++) {
    const wz = -(-half + (iz / segs) * span);
    for (let ix = 0; ix <= segs; ix++) {
      const wx = -half + (ix / segs) * span;
      ys[iz * row + ix] = fogNavigableClearanceY(wx, wz, halfCell) + FOG_OVERLAY_ABOVE_NAV_M;
    }
  }
  return { span, half, segs, row, ys };
}

function sampleFogBilinear(grid, wx, wz) {
  const { span, half, segs, row, ys } = grid;
  const u = (wx + half) / span;
  const v = (-wz + half) / span; // matches build: localY = -half+tv*span, wz=-localY
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const x = u * segs;
  const z = v * segs;
  const x0 = Math.min(segs - 1, Math.max(0, Math.floor(x)));
  const z0 = Math.min(segs - 1, Math.max(0, Math.floor(z)));
  const fx = x - x0;
  const fz = z - z0;
  const y00 = ys[z0 * row + x0];
  const y10 = ys[z0 * row + x0 + 1];
  const y01 = ys[(z0 + 1) * row + x0];
  const y11 = ys[(z0 + 1) * row + x0 + 1];
  const y0 = y00 * (1 - fx) + y10 * fx;
  const y1 = y01 * (1 - fx) + y11 * fx;
  return y0 * (1 - fz) + y1 * fz;
}

function assertNoPierce(profile) {
  applyMapProfile(profile);
  const grid = buildFogGrid();
  const { half } = grid;
  let pierce = 0;
  let worst = 0;
  let minClear = Infinity;
  const n = 80;
  for (let iz = 0; iz <= n; iz++) {
    for (let ix = 0; ix <= n; ix++) {
      const wx = -half + (ix / n) * (2 * half);
      const wz = -half + (iz / n) * (2 * half);
      const fogY = sampleFogBilinear(grid, wx, wz);
      if (fogY == null) continue;
      const nav = sampleMoonTraversableBaseY(wx, wz);
      const clear = fogY - nav;
      if (clear < minClear) minClear = clear;
      if (nav > fogY + 0.05) {
        pierce++;
        if (nav - fogY > worst) worst = nav - fogY;
      }
    }
  }
  console.log(
    `[${profile}] lift=${FOG_OVERLAY_ABOVE_NAV_M} minClear=${minClear.toFixed(2)} pierce=${pierce}`
  );
  if (pierce > 0) {
    throw new Error(`${profile}: fog pierced by navigable FBM (worst ${worst.toFixed(2)} m)`);
  }
  if (minClear < 1.5) {
    throw new Error(`${profile}: clearance too thin (${minClear.toFixed(2)} m)`);
  }
}

assertNoPierce('standard');
assertNoPierce('story');
console.log('PASS verify-fog-nav');
