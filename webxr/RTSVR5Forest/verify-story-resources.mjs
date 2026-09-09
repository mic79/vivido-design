/**
 * Verify Story layouts can place ≥20 ore fields on flat pads.
 * Run: node verify-story-resources.mjs
 */
import {
  applyMapProfile,
  MAP_UNIT_NAV_RADIUS,
  MATCH_HQ_SPAWN_MARGIN,
  clampWorldToPlayableDisk,
} from './js/config.js';
import {
  setStoryBlockingHills,
  rebuildStoryMacroBake,
  sampleMoonTerrainWorldY,
  storyBlockingHillsLift,
} from './js/moon-environment.js';

const MIN = 20;
const MAX_LIFT = 0.4;
const MAX_SLOPE = 14;

function estimateSlopeDeg(x, z, span = 2.5) {
  const yL = sampleMoonTerrainWorldY(x - span, z);
  const yR = sampleMoonTerrainWorldY(x + span, z);
  const yU = sampleMoonTerrainWorldY(x, z - span);
  const yD = sampleMoonTerrainWorldY(x, z + span);
  const gx = (yR - yL) / (2 * span);
  const gz = (yD - yU) / (2 * span);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
}

function isFlat(x, z) {
  if (storyBlockingHillsLift(x, z) > MAX_LIFT) return false;
  if (estimateSlopeDeg(x, z) > MAX_SLOPE) return false;
  return true;
}

function findFlatNear(cx, cz, maxR, avoid, minSep) {
  const baseY = sampleMoonTerrainWorldY(cx, cz);
  const minSep2 = minSep * minSep;
  for (let r = 0; r <= maxR; r += r === 0 ? 1.5 : 1.25) {
    const steps = r === 0 ? 1 : Math.max(16, Math.floor(r * 3.5));
    for (let i = 0; i < steps; i++) {
      const ang = (i / steps) * Math.PI * 2 + r * 1.7;
      const p =
        r === 0
          ? clampWorldToPlayableDisk(cx, cz, 8)
          : clampWorldToPlayableDisk(cx + Math.cos(ang) * r, cz + Math.sin(ang) * r, 8);
      let blocked = false;
      for (const a of avoid) {
        const dx = a.x - p.x;
        const dz = a.z - p.z;
        if (dx * dx + dz * dz < minSep2) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      if (!isFlat(p.x, p.z)) continue;
      if (Math.abs(sampleMoonTerrainWorldY(p.x, p.z) - baseY) > 120) continue;
      return p;
    }
  }
  return null;
}

applyMapProfile('story');
const R = MAP_UNIT_NAV_RADIUS - MATCH_HQ_SPAWN_MARGIN;
const rim = Math.max(40, R - 8);

for (let seed = 1; seed <= 10; seed++) {
  const hills = [];
  for (let i = 0; i < 14; i++) {
    const ang = (i / 14) * Math.PI * 2 + seed * 0.4;
    const r = rim * (0.55 + (i % 5) * 0.08);
    hills.push({
      x: Math.cos(ang) * r,
      z: Math.sin(ang) * r,
      rx: 70 + (i % 4) * 14,
      rz: 60 + (i % 3) * 12,
      height: 9 + (i % 5),
      kind: ['dome', 'crater', 'mesa', 'crescent', 'ridge'][i % 5],
      rotation: ang * 0.5,
      bowl: 0.35,
      arcHalf: 1.4,
      tube: 45,
      warp: 0.1,
      seed: seed * 100 + i,
    });
  }
  setStoryBlockingHills(hills);
  rebuildStoryMacroBake();

  const target = MIN + (seed % 9);
  const resources = [];
  let guard = 0;
  let sep = 26;
  while (resources.length < target && guard++ < 1200) {
    if (guard > 350) sep = 20;
    if (guard > 550) sep = 16;
    if (guard > 800) sep = 14;
    const ang = (guard * 0.37 + seed) % (Math.PI * 2);
    const rr = 35 + ((guard * 17 + seed * 13) % Math.max(1, Math.floor(rim * 0.9 - 35)));
    const hint = clampWorldToPlayableDisk(Math.cos(ang) * rr, Math.sin(ang) * rr, 12);
    const pad = findFlatNear(hint.x, hint.z, 90, resources, sep);
    if (pad) resources.push(pad);
  }

  if (resources.length < MIN) {
    throw new Error(`seed ${seed}: only ${resources.length} resources (need ≥${MIN})`);
  }
  console.log(`[seed ${seed}] OK resources=${resources.length} (target ${target})`);
}

console.log('PASS verify-story-resources');
