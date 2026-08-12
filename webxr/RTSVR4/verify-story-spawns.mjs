/**
 * Verify Story spawn pads stay off hillsides (flat + low lift).
 * Mirrors story-mode pad rules without importing browser/THREE modules.
 * Run: node verify-story-spawns.mjs
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

const MAX_LIFT = 0.4;
const MAX_SLOPE = 14;
const FOOT_R = 6.5;

function estimateSlopeDeg(x, z, span = 2.5) {
  const yL = sampleMoonTerrainWorldY(x - span, z);
  const yR = sampleMoonTerrainWorldY(x + span, z);
  const yU = sampleMoonTerrainWorldY(x, z - span);
  const yD = sampleMoonTerrainWorldY(x, z + span);
  const gx = (yR - yL) / (2 * span);
  const gz = (yD - yU) / (2 * span);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
}

function isFlatPad(x, z, footprintR = FOOT_R) {
  const check = (px, pz) =>
    storyBlockingHillsLift(px, pz) <= MAX_LIFT && estimateSlopeDeg(px, pz) <= MAX_SLOPE;
  if (!check(x, z)) return false;
  const y0 = sampleMoonTerrainWorldY(x, z);
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const p = clampWorldToPlayableDisk(
      x + Math.cos(ang) * footprintR,
      z + Math.sin(ang) * footprintR,
      4
    );
    if (!check(p.x, p.z)) return false;
    if (Math.abs(sampleMoonTerrainWorldY(p.x, p.z) - y0) > 1.0) return false;
  }
  return true;
}

/** Same height rule as story-mode: no preferY ⇒ allow large ΔY off hillsides. */
function findFlatNear(cx, cz, maxR = 140, avoid = [], minSep = 18) {
  const maxDy = 120;
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
      if (!isFlatPad(p.x, p.z)) continue;
      if (Math.abs(sampleMoonTerrainWorldY(p.x, p.z) - baseY) > maxDy) continue;
      return p;
    }
  }
  return null;
}

function snap(spawn, avoid) {
  let pad = findFlatNear(spawn.x, spawn.z, 180, avoid);
  if (!pad) pad = findFlatNear(spawn.x * 0.45, spawn.z * 0.45, 160, avoid);
  if (!pad) pad = findFlatNear(0, 0, 180, avoid);
  if (!pad) throw new Error(`no flat pad near (${spawn.x}, ${spawn.z})`);
  spawn.x = pad.x;
  spawn.z = pad.z;
  return spawn;
}

applyMapProfile('story');

const R = MAP_UNIT_NAV_RADIUS - MATCH_HQ_SPAWN_MARGIN;
const rim = Math.max(40, R - 8);

for (let seed = 1; seed <= 8; seed++) {
  // Intentionally put large hills near rim bases (the failure mode in the screenshot).
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

  // Place spawns ON hill footprints (bad), then snap — must leave hillsides.
  const player = {
    x: hills[0].x + 8,
    z: hills[0].z + 6,
  };
  const bases = [
    { x: hills[3].x - 10, z: hills[3].z + 5 },
    { x: hills[7].x + 6, z: hills[7].z - 8 },
    { x: hills[11].x, z: hills[11].z + 12 },
  ];

  const beforeLift = storyBlockingHillsLift(player.x, player.z);
  if (!(beforeLift > 1)) {
    // Nudge onto a guaranteed massif sample
    player.x = hills[0].x;
    player.z = hills[0].z;
  }

  const avoid = [];
  snap(player, avoid);
  avoid.push({ x: player.x, z: player.z });
  for (const b of bases) {
    snap(b, avoid);
    avoid.push({ x: b.x, z: b.z });
  }

  for (const label of [
    ['player', player],
    ...bases.map((b, i) => [`base${i}`, b]),
  ]) {
    const [name, p] = label;
    if (!isFlatPad(p.x, p.z)) {
      throw new Error(
        `seed ${seed} ${name} still non-flat @ (${p.x.toFixed(1)},${p.z.toFixed(1)}) ` +
          `lift=${storyBlockingHillsLift(p.x, p.z).toFixed(2)} slope=${estimateSlopeDeg(p.x, p.z).toFixed(1)}`
      );
    }
  }

  // Ore near each base must also land flat
  for (const b of [player, ...bases]) {
    const toward = Math.atan2(-b.z, -b.x);
    const hint = {
      x: b.x + Math.cos(toward) * 28,
      z: b.z + Math.sin(toward) * 28,
    };
    const ore = findFlatNear(hint.x, hint.z, 72, avoid, 26);
    if (!ore || !isFlatPad(ore.x, ore.z, 3)) {
      throw new Error(`seed ${seed} ore near (${b.x.toFixed(0)},${b.z.toFixed(0)}) not flat`);
    }
    avoid.push(ore);
  }

  console.log(
    `[seed ${seed}] OK player=(${player.x.toFixed(0)},${player.z.toFixed(0)}) ` +
      `lift0was=${beforeLift.toFixed(1)}`
  );
}

console.log('PASS verify-story-spawns');
