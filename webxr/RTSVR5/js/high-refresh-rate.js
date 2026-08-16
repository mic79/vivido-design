/**
 * Same approach as DodgeVR: pick max entry in WebXR supportedFrameRates and updateTargetFrameRate
 * (e.g. 120 Hz on Quest 3 when the browser exposes it).
 */
(function () {
  if (typeof AFRAME === 'undefined') return;

  function applyHighFrameRate(session) {
    if (!session) return;

    var plat = navigator.platform || '';
    var desktop = /Win32|Win64|MacIntel|Linux x86_64|Linux i686/i.test(plat);
    var ua = navigator.userAgent || '';
    if (desktop && /Quest|Oculus/i.test(ua)) {
      console.log('[high-refresh-rate] skip (desktop WebXR emulator)');
      return;
    }

    var supported = session.supportedFrameRates;
    if (!supported || !supported.length) {
      console.log('[high-refresh-rate] supportedFrameRates not available');
      return;
    }

    var sortedRates = Array.from(supported).sort(function (a, b) {
      return b - a;
    });
    var target = sortedRates[0];
    if (desktop) {
      var capped = sortedRates.filter(function (r) { return r <= 90; });
      target = capped.length ? capped[0] : sortedRates[sortedRates.length - 1];
    }

    console.log('[high-refresh-rate] supported:', sortedRates, '| requesting:', target);

    if (session.updateTargetFrameRate) {
      session
        .updateTargetFrameRate(target)
        .then(function () {
          console.log('[high-refresh-rate] now running at', target, 'Hz');
        })
        .catch(function (err) {
          console.warn('[high-refresh-rate] failed to set frame rate:', err);
        });
    }
  }

  AFRAME.registerComponent('high-refresh-rate', {
    init: function () {
      var sceneEl = this.el.sceneEl;
      this.onEnterVR = function () {
        applyHighFrameRate(sceneEl.xrSession);
      };

      sceneEl.addEventListener('enter-vr', this.onEnterVR);

      // Meta Browser / WebXR sometimes skips enter-vr; sessionstart still has a session.
      this.onSessionStart = function () {
        var xr = sceneEl.renderer && sceneEl.renderer.xr;
        applyHighFrameRate(xr && xr.getSession ? xr.getSession() : null);
      };

      var bindXr = function () {
        var xr = sceneEl.renderer && sceneEl.renderer.xr;
        if (!xr || this._hrrXrBound) return;
        this._hrrXrBound = true;
        this._hrrXr = xr;
        xr.addEventListener('sessionstart', this.onSessionStart);
      }.bind(this);

      if (sceneEl.hasLoaded) bindXr();
      else sceneEl.addEventListener('loaded', bindXr);
    },

    remove: function () {
      var sceneEl = this.el.sceneEl;
      sceneEl.removeEventListener('enter-vr', this.onEnterVR);
      if (this._hrrXr && this.onSessionStart) {
        this._hrrXr.removeEventListener('sessionstart', this.onSessionStart);
      }
    },
  });
})();
