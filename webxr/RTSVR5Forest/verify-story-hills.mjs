/**
 * Verify Story hill bake: no thin walls, no extreme slopes.
 * Run: node --input-type=module verify-story-hills.mjs
 */
import { applyMapProfile } from './js/config.js';
import {
  setStoryBlockingHills,
  rebuildStoryMacroBake,
  diagnoseStoryHillBake,
  storyBlockingHillsLift,
} from './js/moon-environment.js';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

applyMapProfile('story');

// Adversarial set: shapes that previously produced fins / blocky rings.
const adversarial = [
  { x: 80, z: 40, rx: 40, rz: 20, height: 22, kind: 'ridge', rotation: 0.4, seed: 1 },
  { x: -60, z: 90, rx: 100, rz: 30, height: 18, kind: 'crescent', arcHalf: 0.7, tube: 12, seed: 2 },
  { x: 120, z: -70, rx: 90, rz: 90, height: 20, kind: 'crater', bowl: 0.9, seed: 3 },
  { x: -100, z: -40, rx: 80, rz: 70, height: 24, kind: 'mesa', seed: 4 },
  { x: 20, z: -120, rx: 110, rz: 50, height: 16, kind: 'saddle', lobe: 0.5, seed: 5 },
  { x: 200, z: 200, rx: 70, rz: 28, height: 19, kind: 'crescent', arcHalf: 0.9, tube: 18, seed: 6 },
];

setStoryBlockingHills(adversarial);
rebuildStoryMacroBake();
const diagAdv = diagnoseStoryHillBake({ maxSlopeDeg: 42, minWidthM: 7 });
console.log('[adversarial]', diagAdv);
assert(diagAdv.ok, `adversarial bake failed: slope=${diagAdv.maxSlopeDeg} thin=${diagAdv.thinWalls}`);

// Several random-ish soft layouts (clamped by setStoryBlockingHills).
for (let seed = 1; seed <= 8; seed++) {
  const hills = [];
  const kinds = ['dome', 'ridge', 'mesa', 'crater', 'crescent', 'saddle'];
  for (let i = 0; i < 18; i++) {
    const kind = kinds[i % kinds.length];
    const ang = (i / 18) * Math.PI * 2 + seed * 0.3;
    const r = 80 + ((i * 37 + seed * 17) % 220);
    hills.push({
      x: Math.cos(ang) * r,
      z: Math.sin(ang) * r,
      rx: 70 + (i % 5) * 12,
      rz: 60 + (i % 4) * 10,
      height: 10 + (i % 6),
      kind,
      rotation: ang * 0.5,
      bowl: 0.5,
      arcHalf: 1.35,
      tube: 40,
      lobe: 0.36,
      warp: 0.14,
      seed: seed * 100 + i,
    });
  }
  setStoryBlockingHills(hills);
  rebuildStoryMacroBake();
  const d = diagnoseStoryHillBake({ maxSlopeDeg: 42, minWidthM: 7 });
  console.log(`[seed ${seed}]`, d);
  assert(d.ok, `seed ${seed} failed: slope=${d.maxSlopeDeg} thin=${d.thinWalls}`);

  const y0 = storyBlockingHillsLift(0, 0);
  assert(Number.isFinite(y0), 'lift non-finite');
}

console.log('PASS verify-story-hills');
