/**
 * Arena registration — builds Box3D statics once physics is ready.
 */
(function () {
  'use strict';

  AFRAME.registerComponent('drift-surface', {});
  AFRAME.registerComponent('drift-floor', {});
  AFRAME.registerComponent('drift-wall', {});

  AFRAME.registerComponent('drift-arena', {
    init: function () {
      this._registered = false;
      this.el.sceneEl.addEventListener('drift-physics-ready', () => this.register());
      this.el.sceneEl.addEventListener('loaded', () => {
        if (window.DriftPhys?.ready) this.register();
      });
    },

    register: function () {
      if (this._registered) return;
      const phys = window.DriftPhys;
      if (!phys?.ready) return;

      const root = document.querySelector('#arena') || this.el;
      requestAnimationFrame(() => {
        if (this._registered) return;
        this._registered = true;
        const nodes = root.querySelectorAll('[drift-surface], [drift-grip]');
        let n = 0;
        nodes.forEach((el) => {
          if (el.id === 'arena-game-ball' || el.components?.['drift-game-ball']) return;
          phys.addStaticFromElement(el, {
            friction: el.hasAttribute('drift-grip') ? 0.9 : 0.65,
            restitution: 0.04,
            isFloor: el.hasAttribute('drift-floor'),
            isGrip: el.hasAttribute('drift-grip')
          });
          n++;
        });

        const spawn = document.querySelector('#arena-game-ball');
        if (spawn && !phys.gameBallBody) {
          spawn.object3D.updateMatrixWorld(true);
          const p = new THREE.Vector3();
          spawn.object3D.getWorldPosition(p);
          const r = window.VRDRIFT.GAME_BALL_RADIUS || 0.25;
          phys.createGameBall(p.x, Math.max(p.y, r + 0.02), p.z);
        }

        console.log('[VRdrift2] Arena statics registered:', n);
        this.el.sceneEl.emit('drift-arena-ready');
      });
    }
  });
})();
