/** Player vs surfaces — slide along walls; floor via Cannon + one settle pass. */
(function () {
  const C = window.VRDRIFT;
  const Col = window.VRDriftCollision;

  function bodyProbe(player) {
    const p = player.object3D.position;
    return {
      center: new THREE.Vector3(p.x, p.y, p.z),
      radius: C.PLAYER_COLLISION_RADIUS != null ? C.PLAYER_COLLISION_RADIUS : 0.24
    };
  }

  /** Walls/ramps only — walkable deck is Cannon + floor settle, not geometric push. */
  function blockingSurfaces() {
    return Col.querySurfaces('[drift-surface]').filter((el) => !el.hasAttribute('drift-floor'));
  }

  window.VRDriftCollide = {
    getBallBottomWorld: function () {
      const player = document.querySelector('#player');
      if (player && player.object3D) {
        return player.object3D.position.y - C.BODY_BALL_RADIUS;
      }
      return 0;
    },

    getFloorHeight: function (worldX, worldZ, refY) {
      const reach =
        C.MAX_FLOOR_SUPPORT_REACH != null ? C.MAX_FLOOR_SUPPORT_REACH : 0.55;
      return Col.getSupportFloorHeightAt(
        worldX,
        worldZ,
        '[drift-floor]',
        refY,
        reach
      );
    },

    resolvePlayer: function (player, velocity, grabState) {
      if (!player) return velocity;

      const probe = bodyProbe(player);
      let bestPush = null;
      let bestLenSq = 0;

      blockingSurfaces().forEach((surf) => {
        const push = Col.getCollisionPush(probe.center, probe.radius, surf, 0.01);
        const lenSq = push.lengthSq();
        if (lenSq > bestLenSq) {
          bestLenSq = lenSq;
          bestPush = push;
        }
      });

      if (!bestPush || bestLenSq < 1e-10) return velocity;

      const maxFix =
        C.MAX_COLLISION_CORRECTION != null ? C.MAX_COLLISION_CORRECTION : 0.08;
      const len = Math.sqrt(bestLenSq);
      if (len > maxFix) {
        bestPush.multiplyScalar(maxFix / len);
      }

      const normal = bestPush.clone().normalize();
      const grabbing = grabState && (grabState.left || grabState.right);
      const pushScale = grabbing ? 0.65 : 1.0;
      player.object3D.position.add(bestPush.multiplyScalar(pushScale));

      const vn = velocity.dot(normal);
      if (vn < 0) {
        velocity.addScaledVector(normal, -vn);
      }

      return velocity;
    }
  };
})();
