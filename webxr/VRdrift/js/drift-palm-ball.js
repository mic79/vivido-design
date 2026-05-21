/**
 * Kinematic palm boxes + chest + body capsule ↔ game ball.
 */
(function () {
  const C = window.VRDRIFT || {};

  /** Shared palm frame: controller vs Mixamo hand bone. */
  window.VRDriftPalmFrame = {
    palmHalfExtents: function () {
      return {
        hx: C.PALM_PHYSICS_HALF_WIDTH != null ? C.PALM_PHYSICS_HALF_WIDTH : 0.07,
        hy: C.PALM_PHYSICS_HALF_THICK != null ? C.PALM_PHYSICS_HALF_THICK : 0.014,
        hz: C.PALM_PHYSICS_HALF_LENGTH != null ? C.PALM_PHYSICS_HALF_LENGTH : 0.052
      };
    },

    composeControllerLocalMatrix: function (outMatrix) {
      const ay = C.PALM_ANCHOR_Y != null ? C.PALM_ANCHOR_Y : -0.03;
      const az = C.PALM_ANCHOR_Z != null ? C.PALM_ANCHOR_Z : -0.07;
      const cz = C.PALM_COLLIDER_OFFSET_Z != null ? C.PALM_COLLIDER_OFFSET_Z : 0.02;
      const localPos = new THREE.Vector3(
        C.PALM_COLLIDER_OFFSET_X != null ? C.PALM_COLLIDER_OFFSET_X : 0,
        ay,
        az + cz
      );
      const localQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(C.PALM_LOCAL_ROT_X != null ? C.PALM_LOCAL_ROT_X : -90),
          THREE.MathUtils.degToRad(C.PALM_LOCAL_ROT_Y || 0),
          THREE.MathUtils.degToRad(C.PALM_LOCAL_ROT_Z || 0),
          'XYZ'
        )
      );
      return outMatrix.compose(localPos, localQuat, new THREE.Vector3(1, 1, 1));
    },

    composeBoneLocalMatrix: function (outMatrix, side) {
      const sign = side === 'left' ? 1 : -1;
      const localPos = new THREE.Vector3(
        (C.PALM_BONE_OFFSET_X || 0) * sign,
        C.PALM_BONE_OFFSET_Y != null ? C.PALM_BONE_OFFSET_Y : 0,
        C.PALM_BONE_OFFSET_Z != null ? C.PALM_BONE_OFFSET_Z : 8
      );
      const rz =
        (C.PALM_BONE_ROT_Z != null ? C.PALM_BONE_ROT_Z : 90) * (side === 'left' ? 1 : -1);
      const localQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(C.PALM_BONE_ROT_X || 0),
          THREE.MathUtils.degToRad(C.PALM_BONE_ROT_Y || 0),
          THREE.MathUtils.degToRad(rz),
          'XYZ'
        )
      );
      return outMatrix.compose(localPos, localQuat, new THREE.Vector3(1, 1, 1));
    },

    /** Mirrored palm frame in Mixamo hand-bone space (cm); box Y=thin, Z=fingers. */
    composeSymmetricPalmLocalQuat: function (side) {
      const cfg = window.VRDRIFT || {};
      const sign = side === 'left' ? 1 : -1;
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          THREE.MathUtils.degToRad(
            cfg.PALM_BONE_LOCAL_ROT_X != null ? cfg.PALM_BONE_LOCAL_ROT_X : -90
          ),
          THREE.MathUtils.degToRad((cfg.PALM_BONE_LOCAL_ROT_Y || 0) * sign),
          THREE.MathUtils.degToRad(
            (cfg.PALM_BONE_LOCAL_ROT_Z != null ? cfg.PALM_BONE_LOCAL_ROT_Z : 90) *
              sign
          ),
          'XYZ'
        )
      );
      const tipDeg = cfg.PALM_BONE_TIP_DEG != null ? cfg.PALM_BONE_TIP_DEG : 0;
      if (tipDeg) {
        const tipAxis =
          cfg.PALM_BONE_TIP_AXIS === 'y'
            ? new THREE.Vector3(0, 1, 0)
            : cfg.PALM_BONE_TIP_AXIS === 'z'
              ? new THREE.Vector3(0, 0, 1)
              : new THREE.Vector3(1, 0, 0);
        q.multiply(
          new THREE.Quaternion().setFromAxisAngle(
            tipAxis,
            THREE.MathUtils.degToRad(tipDeg)
          )
        );
      }
      const roll = (cfg.PALM_BONE_ROLL_DEG || 0) * sign;
      if (roll) {
        q.multiply(
          new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 0, 1),
            THREE.MathUtils.degToRad(roll)
          )
        );
      }
      return q;
    }
  };
  const GROUP_GAME_BALL = 8;
  const GROUP_PALM = 16;
  const GROUP_CHEST = 32;
  const GROUP_BODY = 64;

  function kinematicType() {
    return typeof CANNON !== 'undefined' && CANNON.Body.KINEMATIC != null
      ? CANNON.Body.KINEMATIC
      : 1;
  }

  function makeKinematicSphere(radius, material, group, mask) {
    const body = new CANNON.Body({
      mass: 1,
      type: kinematicType(),
      shape: new CANNON.Sphere(radius),
      material: material,
      collisionFilterGroup: group,
      collisionFilterMask: mask
    });
    body.linearDamping = 0;
    body.angularDamping = 0;
    return body;
  }

  function makeKinematicPalmBox(material, group, mask) {
    const hx =
      C.PALM_PHYSICS_HALF_WIDTH != null ? C.PALM_PHYSICS_HALF_WIDTH : 0.07;
    const hy =
      C.PALM_PHYSICS_HALF_THICK != null ? C.PALM_PHYSICS_HALF_THICK : 0.014;
    const hz =
      C.PALM_PHYSICS_HALF_LENGTH != null ? C.PALM_PHYSICS_HALF_LENGTH : 0.052;
    const body = new CANNON.Body({
      mass: 1,
      type: kinematicType(),
      material: material,
      collisionFilterGroup: group,
      collisionFilterMask: mask
    });
    body.linearDamping = 0;
    body.angularDamping = 0;
    body.addShape(new CANNON.Box(new CANNON.Vec3(hx, hy, hz)));
    return body;
  }

  function makeKinematicCylinder(radius, height, material, group, mask) {
    const body = new CANNON.Body({
      mass: 1,
      type: kinematicType(),
      material: material,
      collisionFilterGroup: group,
      collisionFilterMask: mask
    });
    body.linearDamping = 0;
    body.angularDamping = 0;
    body.addShape(new CANNON.Cylinder(radius, radius, height, 12));
    return body;
  }

  window.VRDriftPalmBall = {
    left: null,
    right: null,
    chest: null,
    torso: null,
    _torsoH: 0,
    _torsoPrev: new THREE.Vector3(),
    _torsoReady: false,
    _contact: { left: false, right: false },
    _prevPos: { left: new THREE.Vector3(), right: new THREE.Vector3() },
    _ready: { left: false, right: false },

    init: function () {
      const Phys = window.VRDriftPhysics;
      if (!Phys || !Phys.world || !Phys.palmMat) return false;
      if (this.left) return true;

      const chestR = C.CHEST_TRAP_RADIUS != null ? C.CHEST_TRAP_RADIUS : 0.22;
      const mat = Phys.palmMat;

      this.left = makeKinematicPalmBox(mat, GROUP_PALM, GROUP_GAME_BALL);
      this.right = makeKinematicPalmBox(mat, GROUP_PALM, GROUP_GAME_BALL);
      this.chest = makeKinematicSphere(chestR, Phys.playerMat, GROUP_CHEST, GROUP_GAME_BALL);
      const capR =
        C.PLAYER_COLLISION_RADIUS != null ? C.PLAYER_COLLISION_RADIUS : 0.24;
      this.torso = makeKinematicCylinder(
        capR,
        1.6,
        Phys.playerMat,
        GROUP_BODY,
        GROUP_GAME_BALL
      );

      Phys.world.addBody(this.left);
      Phys.world.addBody(this.right);
      Phys.world.addBody(this.chest);
      Phys.world.addBody(this.torso);

      const self = this;
      function bindContact(key, palmBody) {
        palmBody.addEventListener('collide', function (e) {
          const other = e.body === palmBody ? e.target : e.body;
          const gb = window.VRDriftGameBall && window.VRDriftGameBall.getBody();
          if (gb && other === gb) self._contact[key] = true;
        });
      }
      bindContact('left', this.left);
      bindContact('right', this.right);
      return true;
    },

    resetContacts: function () {
      this._contact.left = false;
      this._contact.right = false;
    },

    hadContact: function (key) {
      return !!this._contact[key];
    },

    syncChest: function (camera, anchorX, anchorZ) {
      if (!this.chest || !camera || !camera.object3D) return;
      const cam = new THREE.Vector3();
      camera.object3D.getWorldPosition(cam);
      const oy = C.CHEST_TRAP_OFFSET_Y != null ? C.CHEST_TRAP_OFFSET_Y : -0.42;
      const ax = anchorX != null ? anchorX : cam.x;
      const az = anchorZ != null ? anchorZ : cam.z;
      this.chest.position.set(ax, cam.y + oy, az);
      this.chest.velocity.set(0, 0, 0);
    },

    syncBodyCapsule: function (opts) {
      if (!this.torso || !opts) return;
      const r = opts.radius != null ? opts.radius : 0.24;
      const floorY = opts.floorY;
      const topY = opts.topY;
      if (floorY == null || topY == null) return;
      const h = Math.max(0.15, topY - floorY);
      const cx = opts.anchorX;
      const cz = opts.anchorZ;
      const cy = floorY + h * 0.5;

      if (Math.abs(h - this._torsoH) > 0.02) {
        this.torso.shapes = [];
        this.torso.addShape(new CANNON.Cylinder(r, r, h, 12));
        this._torsoH = h;
      }

      const step = opts.dt > 1e-6 ? opts.dt : 1 / 90;
      let vx = 0;
      let vy = 0;
      let vz = 0;
      if (this._torsoReady) {
        vx = (cx - this._torsoPrev.x) / step;
        vy = (cy - this._torsoPrev.y) / step;
        vz = (cz - this._torsoPrev.z) / step;
      } else {
        this._torsoReady = true;
      }
      this.torso.position.set(cx, cy, cz);
      this.torso.velocity.set(vx, vy, vz);
      this._torsoPrev.set(cx, cy, cz);
    },

    sync: function (dt, getHandColliderPose, leftHand, rightHand, camera, bodyCapsule) {
      if (!this.init()) return;
      this.resetContacts();
      const ax = bodyCapsule && bodyCapsule.anchorX;
      const az = bodyCapsule && bodyCapsule.anchorZ;
      this.syncChest(camera, ax, az);
      if (bodyCapsule) {
        bodyCapsule.dt = dt;
        this.syncBodyCapsule(bodyCapsule);
      }
      const step = dt > 1e-6 ? dt : 1 / 90;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const pairs = [
        ['left', this.left, leftHand],
        ['right', this.right, rightHand]
      ];
      pairs.forEach(([key, body, hand]) => {
        if (!hand || !body) return;
        getHandColliderPose(hand, pos, quat);
        let vx = 0;
        let vy = 0;
        let vz = 0;
        if (this._ready[key]) {
          vx = (pos.x - this._prevPos[key].x) / step;
          vy = (pos.y - this._prevPos[key].y) / step;
          vz = (pos.z - this._prevPos[key].z) / step;
        } else {
          this._ready[key] = true;
        }

        const gb = window.VRDriftGameBall && window.VRDriftGameBall.getBody();
        if (
          gb &&
          vy > 0.12 &&
          pos.y < gb.position.y - (C.GAME_BALL_RADIUS || 0.25) * 0.4
        ) {
          vy += C.PALM_SCOOP_LIFT_BIAS != null ? C.PALM_SCOOP_LIFT_BIAS : 0.12;
        }

        const maxV = C.PALM_MAX_DRIVE_SPEED != null ? C.PALM_MAX_DRIVE_SPEED : 2.4;
        const spd = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (spd > maxV) {
          const s = maxV / spd;
          vx *= s;
          vy *= s;
          vz *= s;
        }

        body.position.set(pos.x, pos.y, pos.z);
        body.quaternion.set(quat.x, quat.y, quat.z, quat.w);
        body.velocity.set(vx, vy, vz);
        this._prevPos[key].copy(pos);
      });
    },

    syncHandCollisionDebug: function (glowState) {
      const show = C.SHOW_HAND_COLLISION_DEBUG !== false;
      const body = document.querySelector('#local-body');
      const avatar = body && body.components['mixamo-body-avatar'];
      if (!avatar || !avatar.setPalmDebugVisible) return;
      avatar.setPalmDebugVisible(show);
      if (!show || !glowState) return;
      avatar.setPalmDebugActive('left', !!(glowState.left || glowState.grabL));
      avatar.setPalmDebugActive('right', !!(glowState.right || glowState.grabR));
    }
  };
})();
