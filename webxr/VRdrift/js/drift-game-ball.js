/**
 * Orion-style arena game ball — 1 m diameter, dynamic Cannon body, palm-push target.
 * This is NOT the locomotion body ball (small physics sphere on #player).
 */
(function () {
  const C = window.VRDRIFT;
  const GROUP_PLAYER = 1;
  const GROUP_STATIC = 4;
  const GROUP_GAME_BALL = 8;
  const GROUP_PALM = 16;
  const GROUP_CHEST = 32;
  const GROUP_BODY = 64;

  function buildMesh(el, color) {
    const THREE = AFRAME.THREE;
    const r = C.GAME_BALL_RADIUS != null ? C.GAME_BALL_RADIUS : 0.5;
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
        emissiveIntensity: 0.45
      });
    }
    if (mat.emissive) mat.emissiveIntensity = Math.min(mat.emissiveIntensity || 0, 0.22);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'driftArenaGameBallMesh';
    mesh.frustumCulled = false;
    mesh.renderOrder = 30;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    el.setObject3D('mesh', mesh);
    if (window.VRDriftShadows) window.VRDriftShadows.apply(el.object3D, true, true);
  }

  AFRAME.registerComponent('drift-game-ball', {
    schema: {
      color: { type: 'color', default: '#ffdd44' },
      mass: { type: 'number', default: 4.5 }
    },

    init: function () {
      this.el.setAttribute('drift-surface', '');
      this.el.setAttribute('visible', true);
      this.body = null;
      this._spawned = false;

      const spawn = () => this.ensureBall();
      if (this.el.sceneEl.hasLoaded) spawn();
      else this.el.sceneEl.addEventListener('loaded', spawn);
      this.el.addEventListener('loaded', () => window.setTimeout(spawn, 0));
    },

    ensureBall: function () {
      const Phys = window.VRDriftPhysics;
      if (!Phys || !Phys.world) return;
      if (this.body) return;

      const r = C.GAME_BALL_RADIUS != null ? C.GAME_BALL_RADIUS : 0.5;
      const pos = new THREE.Vector3();
      this.el.object3D.getWorldPosition(pos);
      const floorY = window.VRDriftCollision
        ? window.VRDriftCollision.getWalkableHeightAt(pos.x, pos.z, '[drift-floor]', pos.y + 2)
        : null;
      const y = floorY != null ? floorY + r : r;

      const ballMat = Phys.gameBallMat || Phys.defaultMat;
      this.body = new CANNON.Body({
        mass: this.data.mass || C.GAME_BALL_MASS || 4.5,
        shape: new CANNON.Sphere(r),
        linearDamping: C.GAME_BALL_LINEAR_DAMPING != null ? C.GAME_BALL_LINEAR_DAMPING : 0.012,
        angularDamping: C.GAME_BALL_ANGULAR_DAMPING != null ? C.GAME_BALL_ANGULAR_DAMPING : 0.05,
        material: ballMat
      });
      this.body.fixedRotation = false;
      this.body.collisionFilterGroup = GROUP_GAME_BALL;
      this.body.collisionFilterMask =
        GROUP_STATIC | GROUP_PALM | GROUP_BODY | GROUP_CHEST;
      this.body.position.set(pos.x, y, pos.z);
      Phys.world.addBody(this.body);
      this.el._driftGameBallBody = this.body;

      buildMesh(this.el, this.data.color);
      this.el.removeAttribute('position');
      this.syncMesh();
      this._spawned = true;
      console.log('[VRdrift] Arena game ball spawned at', pos.x, y, pos.z);
    },

    syncMesh: function () {
      if (!this.body) return;
      const b = this.body;
      const o = this.el.object3D;
      o.position.set(b.position.x, b.position.y, b.position.z);
      o.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      o.updateMatrixWorld(true);
    },

    capBallSpeed: function () {
      if (!this.body) return;
      const maxV = C.GAME_BALL_MAX_SPEED != null ? C.GAME_BALL_MAX_SPEED : 7.5;
      const v = this.body.velocity;
      const spd = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (spd > maxV) {
        const s = maxV / spd;
        v.x *= s;
        v.y *= s;
        v.z *= s;
      }
    },

    tick: function () {
      if (!this.body) this.ensureBall();
    },

    remove: function () {
      if (this.body && window.VRDriftPhysics && window.VRDriftPhysics.world) {
        window.VRDriftPhysics.world.removeBody(this.body);
      }
      this.body = null;
    }
  });

  window.VRDriftGameBall = {
    getEl: function () {
      return document.querySelector('#arena-game-ball');
    },
    getBody: function () {
      const el = document.querySelector('#arena-game-ball');
      return el && el._driftGameBallBody ? el._driftGameBallBody : null;
    },
    isGameBallElement: function (el) {
      if (!el) return false;
      return el.id === 'arena-game-ball';
    },
    syncAfterPhysics: function () {
      const el = document.querySelector('#arena-game-ball');
      const comp = el && el.components['drift-game-ball'];
      if (!comp || !comp.body) return;
      comp.capBallSpeed();
      comp.syncMesh();
    }
  };

  const origAdd = window.VRDriftPhysics && window.VRDriftPhysics.addStaticFromElement;
  if (origAdd && !window.VRDriftPhysics._gameBallGroups) {
    window.VRDriftPhysics._gameBallGroups = true;
    window.VRDriftPhysics.addStaticFromElement = function (el, material) {
      const body = origAdd.call(this, el, material);
      if (body) {
        body.collisionFilterGroup = GROUP_STATIC;
        body.collisionFilterMask = GROUP_PLAYER | GROUP_GAME_BALL;
      }
      return body;
    };
  }
})();
