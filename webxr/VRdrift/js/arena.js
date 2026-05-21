/** Play-space geometry + Cannon static bodies for drift surfaces. */
(function () {
  AFRAME.registerComponent('drift-arena', {
    init: function () {
      const run = () => this.registerStaticBodies();
      this.el.sceneEl.addEventListener('loaded', () => {
        run();
        window.setTimeout(run, 0);
        window.setTimeout(run, 120);
      });
    },

    registerStaticBodies: function () {
      const Phys = window.VRDriftPhysics;
      if (!Phys || !Phys.addStaticFromElement) return;
      /* Cannon: floors, walls, grip props. drift-surface alone = hand queries only. */
      const seen = new Set();
      document.querySelectorAll('[drift-floor], [drift-wall], [drift-grip]').forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        const mat = el.hasAttribute('drift-floor') ? Phys.floorMat : Phys.defaultMat;
        Phys.addStaticFromElement(el, mat);
      });
    }
  });
})();
