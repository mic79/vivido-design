// ========================================
// RTSVR4 — Enemy soft-separation policy
// Pure helpers (no Three.js) for movers + contact stagger
// ========================================

import { UNIT_SEPARATION_CONTACT_STAGGER } from './config.js';

export function unitSkipsCrowdSeparation(unit) {
  if (
    unit.type === 'harvester' &&
    (unit.state === 'harvesting' || unit.state === 'depositing')
  ) {
    return true;
  }
  return (
    unit.state === 'attacking' &&
    !unit.targetPos &&
    (!unit.path || unit.path.length === 0)
  );
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
 * Movers every tick; idle only while `_sepInContact` (staggered).
 * @returns {'mover'|'contact'|null}
 */
export function getSeparationCandidateKind(
  unit,
  frameIndex = 0,
  stagger = UNIT_SEPARATION_CONTACT_STAGGER
) {
  if (!unit || unit.hp <= 0 || unitSkipsCrowdSeparation(unit)) return null;
  if (unitIsSeparationMover(unit)) return 'mover';
  if (!unit._sepInContact) return null;
  const n = Math.max(1, stagger | 0);
  if ((separationIdBucket(unit.id) + frameIndex) % n !== 0) return null;
  return 'contact';
}
