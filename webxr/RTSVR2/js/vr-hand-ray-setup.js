/**
 * laser-controls always attaches raycaster + cursor to the hand entity. We use a child
 * (rotation -90 X, RTSVR-style) for the visible ray and hits; this keeps the parent ray off.
 */
(function () {
  function neuterParentRay(el) {
    if (!el || !el.components || !el.components.raycaster) return;
    el.setAttribute('raycaster', 'enabled', false);
    el.setAttribute('raycaster', 'showLine', false);
    if (el.components.cursor) {
      el.removeAttribute('cursor');
    }
  }

  AFRAME.registerComponent('rts-vr-hand-ray', {
    init: function () {
      this.onReady = this.onReady.bind(this);
      this.el.addEventListener('controllerconnected', this.onReady);
      this.el.addEventListener('controllermodelready', this.onReady);
    },
    onReady: function () {
      neuterParentRay(this.el);
    },
    tick: function () {
      if (this.el.components.cursor) {
        this.el.removeAttribute('cursor');
      }
      const rc = this.el.components.raycaster;
      if (rc && rc.data && rc.data.enabled) {
        neuterParentRay(this.el);
      }
    },
    remove: function () {
      this.el.removeEventListener('controllerconnected', this.onReady);
      this.el.removeEventListener('controllermodelready', this.onReady);
    },
  });
})();
