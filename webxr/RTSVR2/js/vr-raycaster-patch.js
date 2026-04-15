/**
 * From DodgeVR game-menu.js: skip invisible Object3D nodes in raycaster lists so hidden
 * menu meshes do not block hits on the ground or visible buttons.
 */
(function () {
  if (typeof AFRAME === 'undefined') return;
  var def = AFRAME.components.raycaster;
  if (!def || !def.Component || !def.Component.prototype.refreshObjects) return;
  var orig = def.Component.prototype.refreshObjects;
  def.Component.prototype.refreshObjects = function () {
    orig.call(this);
    if (!this.objects || !this.objects.length) return;
    this.objects = this.objects.filter(function (obj3d) {
      var node = obj3d;
      while (node) {
        if (node.visible === false) return false;
        node = node.parent;
      }
      node = obj3d;
      while (node) {
        if (node.el && node.el.classList && node.el.classList.contains('no-raycast')) {
          return false;
        }
        node = node.parent;
      }
      return true;
    });
  };
})();
