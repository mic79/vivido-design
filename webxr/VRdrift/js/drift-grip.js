/** Marks Orion-style grip rails: hand grab + Cannon static collider. */
(function () {
  function registerBody(el) {
    const Phys = window.VRDriftPhysics;
    if (!Phys || !Phys.addStaticFromElement || el._driftStaticBody) return;
    Phys.addStaticFromElement(el, Phys.defaultMat);
  }

  AFRAME.registerComponent('drift-grip', {
    init: function () {
      if (!this.el.hasAttribute('drift-surface')) this.el.setAttribute('drift-surface', '');
      if (!this.el.hasAttribute('drift-wall')) this.el.setAttribute('drift-wall', '');

      const tryRegister = () => registerBody(this.el);
      if (this.el.sceneEl.hasLoaded) {
        tryRegister();
        window.setTimeout(tryRegister, 50);
      } else {
        this.el.sceneEl.addEventListener('loaded', () => {
          tryRegister();
          window.setTimeout(tryRegister, 50);
        });
      }
      this.el.addEventListener('loaded', () => window.setTimeout(tryRegister, 0));
    }
  });
})();
