// ========================================
// RTSVR6 — Unit soft-separation policy (DISABLED)
// Soft-body push was removed from updateMovement. Stubs remain for old imports.
// ========================================

/** @deprecated Soft separation removed — always skip. */
export function unitSkipsCrowdSeparation(_unit) {
  return true;
}

/** @deprecated Soft separation removed. */
export function unitIsSeparationMover(_unit) {
  return false;
}

export function separationIdBucket(unitId) {
  const s = String(unitId || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Soft separation is off — never a candidate.
 * @returns {null}
 */
export function getSeparationCandidateKind(_unit, _frameIndex = 0, _stagger = 1) {
  return null;
}
