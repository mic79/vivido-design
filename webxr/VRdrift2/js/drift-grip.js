/** Marks Orion-style grip rails (Box3D statics registered by drift-arena). */
(function () {
  'use strict';

  AFRAME.registerComponent('drift-grip', {
    init: function () {
      if (!this.el.hasAttribute('drift-surface')) this.el.setAttribute('drift-surface', '');
      if (!this.el.hasAttribute('drift-wall')) this.el.setAttribute('drift-wall', '');
    }
  });
})();
