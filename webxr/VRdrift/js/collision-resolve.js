/** Player vs surfaces — slide along walls, settle on floor (no bounce). */
(function () {
  const C = window.VRDRIFT;
  const Col = window.VRDriftCollision;

  function getCameraWorld() {
    const camera = document.querySelector('#camera');
    if (!camera) return null;
    const p = new THREE.Vector3();
    camera.object3D.getWorldPosition(p);
    return p;
  }

  function bodyCenter(camPos) {
    const center = camPos.clone();
    const camera = document.querySelector('#camera');
    if (camera) {
      const q = new THREE.Quaternion();
      camera.object3D.getWorldQuaternion(q);
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      back.y = 0;
      if (back.lengthSq() > 1e-8) {
        back
          .normalize()
          .multiplyScalar(C.BODY_BACK_OFFSET != null ? C.BODY_BACK_OFFSET : 0.15);
        center.x += back.x;
        center.z += back.z;
      }
    }
    center.y += C.BODY_PHYSICS_OFFSET;
    return center;
  }

  function wallSurfaces() {
    return Col.querySurfaces('[drift-surface]').filter((el) => !el.hasAttribute('drift-floor'));
  }

  window.VRDriftCollide = {
    getBallBottomWorld: function (camPos) {
      const player = document.querySelector('#player');
      if (player && player.object3D) {
        const p = new THREE.Vector3();
        player.object3D.getWorldPosition(p);
        return p.y - C.BODY_BALL_RADIUS;
      }
      if (camPos) return camPos.y + C.BODY_PHYSICS_OFFSET - C.BODY_BALL_RADIUS;
      const cam = getCameraWorld();
      return cam ? cam.y + C.BODY_PHYSICS_OFFSET - C.BODY_BALL_RADIUS : 0;
    },

    getFloorHeight: function (worldX, worldZ, camY) {
      const maxY = camY != null ? camY + 0.35 : null;
      return Col.getWalkableHeightAt(worldX, worldZ, '[drift-floor]', maxY);
    },

    /** Soft floor support — position only, no upward impulse. */
    clampPlayerToFloor: function (player, velocity) {
      if (!player) return velocity;
      const cam = getCameraWorld();
      if (!cam) return velocity;
      const floorY = window.VRDriftCollide.getFloorHeight(cam.x, cam.z, cam.y);
      if (floorY == null) return velocity;

      const ballBottom = window.VRDriftCollide.getBallBottomWorld(cam);
      const gap = floorY - ballBottom;
      if (gap > 0.012) {
        player.object3D.position.y += gap;
      }
      return velocity;
    },

    resolvePlayer: function (player, velocity, grabState) {
      const cam = getCameraWorld();
      if (!player || !cam) return velocity;

      const headR = C.HEAD_COLLISION_RADIUS != null ? C.HEAD_COLLISION_RADIUS : 0.2;
      const probes = [
        { center: bodyCenter(cam), radius: C.PLAYER_COLLISION_RADIUS },
        { center: cam, radius: headR }
      ];

      let bestPush = null;
      let bestLenSq = 0;

      probes.forEach((probe) => {
        wallSurfaces().forEach((surf) => {
          const push = Col.getCollisionPush(probe.center, probe.radius, surf, 0.01);
          const lenSq = push.lengthSq();
          if (lenSq > bestLenSq) {
            bestLenSq = lenSq;
            bestPush = push;
          }
        });
      });

      if (!bestPush || bestLenSq < 1e-10) return velocity;

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
