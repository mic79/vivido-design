/**
 * Reads <meta name="rts-version" content="…"> and updates FPS + build label on the wrist and in the DOM.
 * Loaded after A-Frame (see index.html).
 */
(function () {
  function readVersion() {
    const m = document.querySelector('meta[name="rts-version"]');
    const c = m && m.getAttribute('content');
    return (c && String(c).trim()) || 'dev';
  }

  if (typeof AFRAME === 'undefined') return;

  AFRAME.registerComponent('rts-version-fps', {
    init: function () {
      this.frameCount = 0;
      this.lastTime = performance.now();
      this.fps = 0;
      this.fpsHistory = [];
      this.lastUpdate = 0;
      this.updateInterval = 500;
      this.version = readVersion();
    },

    tick: function () {
      const currentTime = performance.now();
      this.frameCount++;

      if (currentTime - this.lastUpdate < this.updateInterval) return;

      const deltaTime = currentTime - this.lastTime;
      const currentFPS =
        deltaTime > 0 ? Math.round((this.frameCount * 1000) / deltaTime) : 0;

      this.fpsHistory.push(currentFPS);
      if (this.fpsHistory.length > 5) this.fpsHistory.shift();

      const avgFPS = Math.round(
        this.fpsHistory.reduce(function (a, b) {
          return a + b;
        }, 0) / this.fpsHistory.length
      );
      this.fps = avgFPS;

      var label = 'RTSVR2 ' + this.version + ' | ' + this.fps + ' FPS';

      var htmlEl = document.getElementById('hud-version-fps');
      if (htmlEl) htmlEl.textContent = label;

      var vrEl = document.getElementById('vr-version-fps');
      if (vrEl) vrEl.setAttribute('value', label);

      this.frameCount = 0;
      this.lastTime = currentTime;
      this.lastUpdate = currentTime;
    },
  });
})();
