// ========================================
// RTSVR4 — Enemy soft-separation policy
// Pure helpers (no Three.js) for movers + contact stagger
// ========================================

import { UNIT_SEPARATION_CONTACT_STAGGER } from './config.js';

export function unitSkipsCrowdSeparation(unit) {
  // Only park harvesters mid-job — standing attackers used to skip too, which
  // froze melee piles in place (cheap ≠ “never resolve overlap”).
  if (
    unit.type === 'harvester' &&
    (unit.state === 'harvesting' || unit.state === 'depositing')
  ) {
    return true;
  }
  return false;
}

export function unitIsSeparationMover(unit) {
  return unit.state === 'moving' || (unit.state === 'attacking' && !!unit.targetPos);
}

export function separationIdBucket(unitId) {
  const s = String(unitId || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Movers every tick; standing attackers + idle-in-contact staggered.
 * @returns {'mover'|'contact'|null}
 */
export function getSeparationCandidateKind(
  unit,
  frameIndex = 0,
  stagger = UNIT_SEPARATION_CONTACT_STAGGER
) {
  if (!unit || unit.hp <= 0 || unitSkipsCrowdSeparation(unit)) return null;
  if (unitIsSeparationMover(unit)) return 'mover';
  const n = Math.max(1, stagger | 0);
  const due = (separationIdBucket(unit.id) + frameIndex) % n === 0;
  if (!due) return null;
  // Melee / hold-fire: keep soft-pushing while overlapping enemies.
  if (unit.state === 'attacking') return 'contact';
  if (!unit._sepInContact) return null;
  return 'contact';
}
