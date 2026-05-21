/**
 * Motion-controller haptics: palm contact hits and skate roll along surfaces.
 */
(function () {
  const C = window.VRDRIFT || {};
  const Col = window.VRDriftCollision;

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

  function handForKey(loco, key) {
    return key === 'left' ? loco.leftHand : loco.rightHand;
  }

  function skateTangentSpeed(loco, key) {
    if (!loco.palmTouch[key] || loco.isGrabbing[key] || !Col) return 0;
    const hand = handForKey(loco, key);
    if (!hand) return 0;
    const palm = loco.getPalmWorldPos(hand, new THREE.Vector3());
    const n = Col.getSurfaceNormal(palm, loco.palmTouch[key]);
    const hv = loco.handVel[key];
    const tangent = hv.clone().sub(n.clone().multiplyScalar(hv.dot(n)));
    return tangent.length();
  }

  function update(loco, dt) {
    if (!loco || (loco.menuBlocks && loco.menuBlocks())) return;
    const now = performance.now();
    const hitI = C.HAPTIC_HIT_INTENSITY != null ? C.HAPTIC_HIT_INTENSITY : 0.45;
    const hitMs = C.HAPTIC_HIT_MS != null ? C.HAPTIC_HIT_MS : 42;
    const skateI = C.HAPTIC_SKATE_INTENSITY != null ? C.HAPTIC_SKATE_INTENSITY : 0.3;
    const skateMs = C.HAPTIC_SKATE_MS != null ? C.HAPTIC_SKATE_MS : 30;
    const skateGap = C.HAPTIC_SKATE_INTERVAL_MS != null ? C.HAPTIC_SKATE_INTERVAL_MS : 48;
    const skateMin = C.HAPTIC_SKATE_MIN_TANGENT != null ? C.HAPTIC_SKATE_MIN_TANGENT : 0.2;
    const skateMax = C.HAPTIC_SKATE_MAX_TANGENT != null ? C.HAPTIC_SKATE_MAX_TANGENT : 2.4;

    ['left', 'right'].forEach((key) => {
      const hand = handForKey(loco, key);
      const prevTouch = loco._prevPalmTouch[key];
      const curTouch = loco.palmTouch[key];
      const prevBall = loco._prevGameBallTouch && loco._prevGameBallTouch[key];
      const curBall = loco.gameBallContact && loco.gameBallContact[key];

      if ((!prevTouch && curTouch) || (!prevBall && curBall)) {
        if (hand) pulseHand(hand, hitI, hitMs);
      }
      loco._prevPalmTouch[key] = curTouch;
      if (!loco._prevGameBallTouch) loco._prevGameBallTouch = { left: false, right: false };
      loco._prevGameBallTouch[key] = curBall;

      const prevBrake = loco._prevBraking[key];
      if (!prevBrake && loco.isBraking[key] && hand) {
        pulseHand(hand, hitI * 0.92, hitMs);
      }
      loco._prevBraking[key] = loco.isBraking[key];

      if ((!curTouch && !curBall) || loco.isGrabbing[key] || !hand) {
        loco._lastSkateHaptic[key] = 0;
        return;
      }

      const tSpeed = skateTangentSpeed(loco, key);
      if (tSpeed < skateMin) return;
      if (now - (loco._lastSkateHaptic[key] || 0) < skateGap) return;

      const t = Math.min(1, (tSpeed - skateMin) / Math.max(0.01, skateMax - skateMin));
      pulseHand(hand, skateI * (0.55 + 0.45 * t), skateMs);
      loco._lastSkateHaptic[key] = now;
    });
  }

  window.VRDriftHaptics = {
    pulseHand: pulseHand,
    update: update
  };
})();
