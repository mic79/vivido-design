/**
 * Arena game ball — soccer texture mesh. Physics body is owned by Box3D (DriftPhys).
 */
(function () {
  'use strict';

  const C = () => window.VRDRIFT || {};

  function buildMesh(el, color) {
    const THREE = AFRAME.THREE;
    const r = C().GAME_BALL_RADIUS != null ? C().GAME_BALL_RADIUS : 0.25;
    const geo = new THREE.SphereGeometry(r, 40, 28);
    let mat;
    if (window.VRDriftSoccerTexture) {
      mat = window.VRDriftSoccerTexture.create(THREE, color || '#ffdd44').material;
    } else {
      const col = new THREE.Color(color || '#ffdd44');
      mat = new THREE.MeshStandardMaterial({
        color: col,
        roughness: 0.32,
        metalness: 0.1,
        emissive: col,
        emissiveIntensity: 0.22
      });
    }
    if (mat.emissive) mat.emissiveIntensity = Math.min(mat.emissiveIntensity || 0, 0.22);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'driftArenaGameBallMesh';
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    el.setObject3D('mesh', mesh);
    if (window.VRDriftShadows) window.VRDriftShadows.apply(el.object3D, true, true);
  }

  AFRAME.registerComponent('drift-game-ball', {
    schema: {
      color: { type: 'color', default: '#ffdd44' },
      mass: { type: 'number', default: 3 }
    },

    init: function () {
      this.el.setAttribute('visible', true);
      buildMesh(this.el, this.data.color);
      console.log('[VRdrift2] Arena game ball mesh ready');
    },

    /** After locomotion (order 1) so mesh matches post-palm separation */
    tickOrder: 3,
    tick: function () {
      const phys = window.DriftPhys;
      if (!phys || !phys.gameBallBody) return;
      const p = phys.getGameBallPosition();
      const r = phys.getGameBallRotation();
      if (!p) return;
      this.el.object3D.position.set(p.x, p.y, p.z);
      if (r && r.v) {
        this.el.object3D.quaternion.set(r.v.x, r.v.y, r.v.z, r.s);
      }
    }
  });
})();
