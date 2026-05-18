/**
 * Max Payne–style bullet time: ramp in before arrow impact, hold while NPC falls,
 * ramp out as the torso nears the floor. Physics/mixer use scaled dt; headset stays real-time.
 */
import * as THREE from 'three';
import { visitInFlightArrows } from '../../VRrunner/js/bots.js';

const BT_SLOW = 0.08;
const BT_RAMP_IN_SEC = 0.52;
const BT_RAMP_OUT_SEC = 0.62;
/** Start easing to slow-mo when impact is within this travel time (s). */
const BT_IMPACT_LOOKAHEAD_SEC = 0.52;
/** How far ahead (s) to raycast along each arrow path. */
const BT_ARROW_PROBE_SEC = 0.55;
const BT_FLOOR_CLEARANCE = 0.65;

/** @type {number} */
let bulletTimeScale = 1;
/** @type {'idle' | 'impending' | 'falling' | 'recovering'} */
let bulletPhase = 'idle';
let bulletTarget = 1;
let arrowHitThisFrame = false;
/** @type {HTMLElement | null} */
let vignetteEl = null;

const _arrowDir = new THREE.Vector3();
const _arrowStart = new THREE.Vector3();

/**
 * @param {HTMLElement | null} el
 */
export function bindBulletTimeVignette(el) {
  vignetteEl = el;
}

export function notifyArrowHitNpc() {
  arrowHitThisFrame = true;
}

export function getBulletTimeScale() {
  return bulletTimeScale;
}

/**
 * @param {number} realDt
 * @param {import('./ragdoll-npc.js').RagdollNPC | null} ragdoll
 * @param {(pos: { x: number, z: number }) => boolean} isOverPlatformXZ
 * @param {number} platformTopY
 */
/**
 * @param {{ impendingOnly?: boolean }} [opts]
 */
export function updateBulletTime(realDt, ragdoll, isOverPlatformXZ, platformTopY, opts = {}) {
  if (vignetteEl) {
    const v = Math.max(0, 1 - bulletTimeScale);
    vignetteEl.style.opacity = String(Math.min(0.82, v * 1.05));
  }

  if (!ragdoll) {
    bulletTimeScale = 1;
    bulletPhase = 'idle';
    bulletTarget = 1;
    arrowHitThisFrame = false;
    return;
  }

  let impending = false;
  if (!opts.impendingOnly && (bulletPhase === 'falling' || bulletPhase === 'recovering')) {
    const motion = ragdoll.getTorsoMotion();
    if (motion) {
      const floorY = isOverPlatformXZ(motion) ? platformTopY : 0;
      const heightAboveFloor = motion.y - floorY;
      if (heightAboveFloor < BT_FLOOR_CLEARANCE && motion.vy < 1.2) {
        bulletPhase = 'recovering';
        bulletTarget = 1;
      }
    }
    if (bulletPhase === 'recovering' && bulletTimeScale > 0.94) {
      bulletPhase = 'idle';
      bulletTarget = 1;
    }
  }

  if (!opts.impendingOnly && arrowHitThisFrame) {
    bulletPhase = 'falling';
    bulletTarget = BT_SLOW;
    arrowHitThisFrame = false;
  }

  if (bulletPhase === 'idle' || bulletPhase === 'impending') {
    visitInFlightArrows((a) => {
      if (a.speed < 4) return;
      _arrowDir.copy(a.vel).multiplyScalar(1 / a.speed);
      const segLen = a.speed * BT_ARROW_PROBE_SEC;
      _arrowStart.copy(a.pos);
      const probe = ragdoll.probeArrowSegmentHit(_arrowStart, _arrowDir, segLen);
      if (!probe) return;
      const timeToHit = probe.t / a.speed;
      if (timeToHit <= BT_IMPACT_LOOKAHEAD_SEC) impending = true;
    });
    if (impending) {
      bulletPhase = 'impending';
      bulletTarget = BT_SLOW;
    } else if (bulletPhase === 'impending') {
      bulletPhase = 'idle';
      bulletTarget = 1;
    }
  }

  const rampSec = bulletTarget < bulletTimeScale ? BT_RAMP_IN_SEC : BT_RAMP_OUT_SEC;
  const k = 1 - Math.exp(-realDt / Math.max(0.05, rampSec));
  bulletTimeScale = THREE.MathUtils.lerp(bulletTimeScale, bulletTarget, k);
}
