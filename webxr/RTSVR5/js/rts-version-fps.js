/**
 * Reads <meta name="rts-version" content="…"> and updates FPS + build label on the wrist and in the DOM.
 * In XR, appends kit/draws/fbScale/msaa so headset runs can be compared without trusting IWE.
 * Loaded after A-Frame (see index.html).
 */
(function () {
  function readVersion() {
    const m = document.querySelector('meta[name="rts-version"]');
    const c = m && m.getAttribute('content');
    return (c && String(c).trim()) || 'dev';
  }

  function diagLine(sceneEl) {
    const r = sceneEl && sceneEl.renderer;
    const xr = r && r.xr;
    const presenting = !!(xr && xr.isPresenting);
    let fb = '?';
    try {
      if (xr && typeof xr.getFramebufferScaleFactor === 'function') {
        fb = Number(xr.getFramebufferScaleFactor()).toFixed(2);
      }
    } catch (_) {
      /* */
    }
    let kind = '-';
    let lean = false;
    try {
      const ground = document.getElementById('ground');
      const mesh = ground && ground.getObject3D && ground.getObject3D('mesh');
      kind = (mesh && mesh.userData && mesh.userData.rtsKitKind) || (mesh && mesh.name) || '-';
      lean = !!(mesh && mesh.userData && mesh.userData.rtsLeanRocksVisual);
      if (lean && kind === 'story') kind = 'story-lean';
    } catch (_) {
      /* */
    }
    const calls = r && r.info && r.info.render ? r.info.render.calls : '?';
    const trisK =
      r && r.info && r.info.render
        ? Math.round((r.info.render.triangles || 0) / 1000)
        : '?';
    const tex = r && r.info && r.info.memory ? r.info.memory.textures : '?';
    const msaa = window.__rtsMsaa4x === true ? '1' : '0';
    const xrTag = presenting ? 'XR' : '2D';
    return (
      xrTag +
      ' kit=' +
      kind +
      ' d=' +
      calls +
      ' tK=' +
      trisK +
      ' tex=' +
      tex +
      ' fb=' +
      fb +
      ' msaa=' +
      msaa
    );
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

      const sceneEl = this.el.sceneEl || document.querySelector('a-scene');
      const diag = diagLine(sceneEl);
      const label = 'RTSVR5 ' + this.version + ' | ' + this.fps + ' FPS\n' + diag;

      var htmlEl = document.getElementById('hud-version-fps');
      if (htmlEl) htmlEl.textContent = label;

      var vrEl = document.getElementById('vr-version-fps');
      if (vrEl) {
        vrEl.setAttribute('value', label);
        // Two lines need a bit more wrap width in VR.
        if (!vrEl.getAttribute('width') || Number(vrEl.getAttribute('width')) < 1.15) {
          vrEl.setAttribute('width', 1.2);
        }
      }

      if (typeof window !== 'undefined') {
        window.__rtsHudDiag = {
          version: this.version,
          fps: this.fps,
          diag: diag,
          at: currentTime,
        };
      }

      this.frameCount = 0;
      this.lastTime = currentTime;
      this.lastUpdate = currentTime;
    },
  });
})();
