/**
 * Motion-controller haptics for VRdrift2:
 * - Palm begin-touch (static surface or play ball)
 * - Continuous skate rumble while palm planted, scaled by rig speed
 * - Head / body impacts → both controllers, scaled by impact intensity
 */
(function () {
  const C = () => window.VRDRIFT || {};

  const CTRL_NAMES = ['tracked-controls', 'oculus-touch-controls', 'meta-touch-controls'];

  function hapticActuator(handEl) {
    if (!handEl || !handEl.components) return null;
    for (let i = 0; i < CTRL_NAMES.length; i++) {
      const comp = handEl.components[CTRL_NAMES[i]];
      const g = comp && comp.controller && comp.controller.gamepad;
      if (g && g.hapticActuators && g.hapticActuators[0]) return g.hapticActuators[0];
    }
    return null;
  }

  function pulseHand(handEl, intensity, durationMs) {
    const act = hapticActuator(handEl);
    if (!act) return;
    const i = Math.max(0, Math.min(1, intensity));
    const d = Math.max(10, durationMs | 0);
    act.pulse(i, d).catch(function () {});
  }

  function pulseBoth(loco, intensity, durationMs) {
    if (!loco) return;
    pulseHand(loco.leftHand, intensity, durationMs);
    pulseHand(loco.rightHand, intensity, durationMs);
  }

  function handForKey(loco, key) {
    return key === 'left' ? loco.leftHand : loco.rightHand;
  }

  function ensureState(loco) {
    if (!loco._prevPalmSurface) loco._prevPalmSurface = { left: false, right: false };
    if (!loco._prevGameBallTouch) loco._prevGameBallTouch = { left: false, right: false };
    if (!loco._lastSkateHaptic) loco._lastSkateHaptic = { left: 0, right: 0 };
    if (loco._lastImpactHaptic == null) loco._lastImpactHaptic = 0;
  }

  function palmOnSurface(key) {
    const pb = window.VRDriftPalmBall;
    if (!pb) return false;
    return !!(pb.hadFloorContact(key) || pb.hadWallContact(key));
  }

  function palmOnBall(key) {
    const pb = window.VRDriftPalmBall;
    return !!(pb && pb.hadGameContact(key));
  }

  function rigSpeed(loco) {
    if (!loco.phys?.getPlayerVelocity) return 0;
    const v = loco.phys.getPlayerVelocity();
    return Math.hypot(v.x || 0, v.y || 0, v.z || 0);
  }

  /**
   * Body / head impact pulse on both hands.
   * @param {number} intensity 0..1 impact strength
   */
  function impactBoth(loco, intensity) {
    if (!loco || !intensity || intensity < 0.04) return;
    ensureState(loco);
    const now = performance.now();
    const gap = C().HAPTIC_IMPACT_INTERVAL_MS != null ? C().HAPTIC_IMPACT_INTERVAL_MS : 90;
    if (now - loco._lastImpactHaptic < gap) return;
    loco._lastImpactHaptic = now;
    const hitI = C().HAPTIC_IMPACT_INTENSITY != null ? C().HAPTIC_IMPACT_INTENSITY : 0.85;
    const hitMs = C().HAPTIC_IMPACT_MS != null ? C().HAPTIC_IMPACT_MS : 55;
    const i = Math.min(1, intensity) * hitI;
    pulseBoth(loco, i, hitMs + Math.floor(i * 40));
  }

  function update(loco, dt) {
    if (!loco || (loco.menuBlocks && loco.menuBlocks())) return;
    ensureState(loco);
    const now = performance.now();
    const hitI = C().HAPTIC_HIT_INTENSITY != null ? C().HAPTIC_HIT_INTENSITY : 0.45;
    const hitMs = C().HAPTIC_HIT_MS != null ? C().HAPTIC_HIT_MS : 42;
    const skateI = C().HAPTIC_SKATE_INTENSITY != null ? C().HAPTIC_SKATE_INTENSITY : 0.32;
    const skateMs = C().HAPTIC_SKATE_MS != null ? C().HAPTIC_SKATE_MS : 28;
    const skateGap = C().HAPTIC_SKATE_INTERVAL_MS != null ? C().HAPTIC_SKATE_INTERVAL_MS : 45;
    const skateMin = C().HAPTIC_SKATE_MIN_SPEED != null ? C().HAPTIC_SKATE_MIN_SPEED : 0.35;
    const skateMax = C().HAPTIC_SKATE_MAX_SPEED != null ? C().HAPTIC_SKATE_MAX_SPEED : 7;

    const spd = rigSpeed(loco);

    ['left', 'right'].forEach((key) => {
      const hand = handForKey(loco, key);
      const curSurf = palmOnSurface(key);
      const curBall = palmOnBall(key);
      const prevSurf = loco._prevPalmSurface[key];
      const prevBall = loco._prevGameBallTouch[key];

      if ((!prevSurf && curSurf) || (!prevBall && curBall)) {
        if (hand) pulseHand(hand, hitI, hitMs);
        if (window.VRDriftAudio) {
          if (!prevSurf && curSurf) window.VRDriftAudio.palmSurfaceHit(key, spd);
          if (!prevBall && curBall) window.VRDriftAudio.palmBallHit(key, spd);
        }
      }

      loco._prevPalmSurface[key] = curSurf;
      loco._prevGameBallTouch[key] = curBall;

      if ((!curSurf && !curBall) || !hand) {
        loco._lastSkateHaptic[key] = 0;
        return;
      }

      // Continuous rumble while planted — intensity from rig speed
      if (spd < skateMin) return;
      if (now - (loco._lastSkateHaptic[key] || 0) < skateGap) return;
      const t = Math.min(1, (spd - skateMin) / Math.max(0.01, skateMax - skateMin));
      pulseHand(hand, skateI * (0.4 + 0.6 * t), skateMs);
      loco._lastSkateHaptic[key] = now;
    });
  }

  window.VRDriftHaptics = {
    pulseHand: pulseHand,
    pulseBoth: pulseBoth,
    impactBoth: impactBoth,
    update: update
  };
})();
