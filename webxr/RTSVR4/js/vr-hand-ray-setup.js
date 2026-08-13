/**
 * laser-controls always attaches raycaster + cursor to the hand entity. We use a child
 * (rotation -90 X, RTSVR4-style) for the visible ray and hits; this keeps the parent ray off.
 *
 * Desktop / touch: the aim raycaster stays off (hands live on the camera rig).
 * VR / Quest: raycaster objects are `.clickable, #ground-hit` — never the moon plate.
 */
(function () {
  function isPresentingWebXR(scene) {
    if (!scene) return false;
    try {
      if (typeof scene.is === 'function' && scene.is('vr-mode')) return true;
    } catch (_) { /* ignore */ }
    try {
      var xr = scene.renderer && scene.renderer.xr;
      if (xr && xr.isPresenting) return true;
      if (xr && typeof xr.getSession === 'function' && xr.getSession()) return true;
    } catch (_) { /* ignore */ }
    return false;
  }

  /**
   * laser-controls re-enables the parent raycaster every frame while the trigger is held.
   * That draws wrong-direction “laser” lines from the controller root. Kill it every tick; the
   * real aim is the child `[data-vr-aim-ray]` (right hand only has a raycaster line).
   */
  function neuterParentRay(el) {
    if (!el || !el.components || !el.components.raycaster) return;
    el.setAttribute('raycaster', 'enabled', false);
    el.setAttribute('raycaster', 'showLine', false);
    if (el.components.cursor) {
      el.removeAttribute('cursor');
    }
    try {
      el.removeAttribute('line');
    } catch (_) {
      /* ignore */
    }
  }

  function setChildAimRaycasterEnabled(handEl, on) {
    var aim = handEl && handEl.querySelector && handEl.querySelector('[data-vr-aim-ray]');
    if (!aim || !aim.components || !aim.components.raycaster) return;
    var enabled = !!aim.components.raycaster.data.enabled;
    if (enabled === !!on) return;
    aim.setAttribute('raycaster', 'enabled', on ? 'true' : 'false');
    aim.setAttribute('raycaster', 'showLine', on ? 'true' : 'false');
  }

  AFRAME.registerComponent('rts-vr-hand-ray', {
    init: function () {
      this.onReady = this.onReady.bind(this);
      this.el.addEventListener('controllerconnected', this.onReady);
      this.el.addEventListener('controllermodelready', this.onReady);
      setChildAimRaycasterEnabled(this.el, isPresentingWebXR(this.el.sceneEl));
    },
    onReady: function () {
      neuterParentRay(this.el);
      setChildAimRaycasterEnabled(this.el, isPresentingWebXR(this.el.sceneEl));
    },
    tick: function () {
      if (this.el.components.cursor) {
        this.el.removeAttribute('cursor');
      }
      neuterParentRay(this.el);
      setChildAimRaycasterEnabled(this.el, isPresentingWebXR(this.el.sceneEl));
    },
    remove: function () {
      this.el.removeEventListener('controllerconnected', this.onReady);
      this.el.removeEventListener('controllermodelready', this.onReady);
    },
  });

  /**
   * Child aim rays have no A-Frame `cursor`, so `vr-button-hover` never receives mouseenter.
   * Uses the same pick as `input.js` (`globalThis.__rtsPickVrUiHoverTarget`) so hover matches clicks.
   * Attach only to the **right** aim ray so the left ray does not steal mouseleave while the
   * right hand is still aimed at the same `.clickable`.
   */
  AFRAME.registerComponent('rts-vr-aim-ray-ui-hover', {
    init: function () {
      this.hoverTarget = null;
      this._hoverNullStreak = 0;
    },
    tock: function () {
      if (!isPresentingWebXR(this.el.sceneEl)) {
        this.setHoverTarget(null);
        return;
      }
      var fn = globalThis.__rtsPickVrUiHoverTarget;
      if (typeof fn !== 'function') return;
      var hand = this.el.parentElement;
      if (!hand) return;
      var next = fn(hand);
      if (next) {
        this._hoverNullStreak = 0;
        this.setHoverTarget(next);
        return;
      }
      this._hoverNullStreak = (this._hoverNullStreak || 0) + 1;
      if (this._hoverNullStreak >= 2) {
        this.setHoverTarget(null);
      }
    },
    setHoverTarget: function (next) {
      if (next === this.hoverTarget) return;
      this._hoverNullStreak = 0;
      if (this.hoverTarget) {
        var prevC = this.hoverTarget.components && this.hoverTarget.components['vr-button-hover'];
        if (prevC && typeof prevC.applyFromVrUiRay === 'function') {
          prevC.applyFromVrUiRay(false);
        } else {
          this.hoverTarget.emit('mouseleave', {}, true);
        }
      }
      this.hoverTarget = next || null;
      if (this.hoverTarget) {
        var nextC = this.hoverTarget.components && this.hoverTarget.components['vr-button-hover'];
        if (nextC && typeof nextC.applyFromVrUiRay === 'function') {
          nextC.applyFromVrUiRay(true);
        } else {
          this.hoverTarget.emit('mouseenter', {}, true);
        }
        if (typeof globalThis.__rtsVrTryControllerPulse === 'function') {
          globalThis.__rtsVrTryControllerPulse('right', 0.16, 18);
        }
      }
    },
    remove: function () {
      this.setHoverTarget(null);
    },
  });
})();
