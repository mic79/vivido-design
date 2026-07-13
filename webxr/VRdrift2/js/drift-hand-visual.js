/** BattleVR: hide low-poly hand-controls meshes; controllers still track. */
(function () {
  AFRAME.registerComponent('custom-hand-controls', {
    init: function () {
      setTimeout(() => {
        const handControls = this.el.components['hand-controls'];
        if (handControls) {
          this.originalAnimateGesture = handControls.animateGesture;
          this.originalPlayAnimation = handControls.playAnimation;
          handControls.animateGesture = function () {};
          handControls.playAnimation = function () {};
        }
      }, 100);
    },
    remove: function () {
      const handControls = this.el.components['hand-controls'];
      if (handControls && this.originalAnimateGesture && this.originalPlayAnimation) {
        handControls.animateGesture = this.originalAnimateGesture;
        handControls.playAnimation = this.originalPlayAnimation;
      }
    }
  });
})();
