/**
 * Orion Drift–inspired locomotion: arm-push + palm skate/carve on surfaces,
 * selective grip rails, momentum wall-jumps, wrist thrusters, rolling body ball.
 * Body ball = small Cannon sphere for locomotion. Arena game ball = separate 1 m object you palm-hit (Orion).
 */
(function () {
  const C = window.VRDRIFT;
  const Col = window.VRDriftCollision;
  const Collide = window.VRDriftCollide;
  const Phys = window.VRDriftPhysics;

  AFRAME.registerComponent('drift-locomotion', {
    schema: {
      color: { type: 'color', default: '#44aaff' },
      mass: { type: 'number', default: 70 },
      thrusterForce: { type: 'number', default: 2.4 },
      maxSpeed: { type: 'number', default: 11 },
      rotationSpeed: { type: 'number', default: 2.2 }
    },

    init: function () {
      this.rig = null;
      this.camera = null;
      this.leftHand = null;
      this.rightHand = null;
      this.leftPalm = null;
      this.rightPalm = null;

      this.velocity = new THREE.Vector3(0, 0, 0);
      this.rotationY = 0;
      this.thumbstickRotation = { left: 0, right: 0 };

      this.gripHeld = { left: false, right: false };
      this.thrusterActive = { left: false, right: false };
      this.isGrabbing = { left: false, right: false };
      this.grabInfo = { left: null, right: null };
      this.isBraking = { left: false, right: false };
      this.brakeSurface = { left: null, right: null };
      this.brakeAnchor = { left: null, right: null };

      this.lastHandPos = { left: new THREE.Vector3(), right: new THREE.Vector3() };
      this.lastPalmPos = { left: new THREE.Vector3(), right: new THREE.Vector3() };
      this.palmDelta = { left: new THREE.Vector3(), right: new THREE.Vector3() };
      this._palmReady = { left: false, right: false };
      this._groundContactFrames = 0;
      this._cImpulse = new CANNON.Vec3();
      this._cPoint = new CANNON.Vec3();
      this._bodyVel = new THREE.Vector3();
      this._relPalmDelta = new THREE.Vector3();
      this._grabPull = new THREE.Vector3();
      this._grabTarget = new THREE.Vector3();
      this._grabLockErr = new THREE.Vector3();
      this.handVel = { left: new THREE.Vector3(), right: new THREE.Vector3() };
      this.palmTouch = { left: null, right: null };
      this.gameBallContact = { left: false, right: false };
      this._vrGroundSnapped = false;
      this._sceneGroundSnapped = false;
      this._prevPalmTouch = { left: null, right: null };
      this._prevBraking = { left: false, right: false };
      this._prevGameBallTouch = { left: false, right: false };
      this._floorGripLockout = { left: false, right: false };
      this._floorGripPending = { left: false, right: false };
      this._lastSkateHaptic = { left: 0, right: 0 };
      this.grounded = false;
      this.groundNormal = new THREE.Vector3(0, 1, 0);
      this.lastGrabTime = 0;

      this.el.sceneEl.addEventListener('loaded', () => this.onSceneLoaded());
    },

    onSceneLoaded: function () {
      this.rig = document.querySelector('#rig');
      this.camera = document.querySelector('#camera');
      this.leftHand = document.querySelector('#leftHand');
      this.rightHand = document.querySelector('#rightHand');
      this.leftPalm = document.querySelector('#left-palm');
      this.rightPalm = document.querySelector('#right-palm');

      this.ensureHandsVisible();
      try {
        this.createPlayerPhysicsBody();
      } catch (err) {
        console.error('[DriftLocomotion] Physics body init failed:', err);
      }
      this.setupInput();
      this.applyRigOffset();
      console.log('[VRdrift] Cannon locomotion + arena game ball loaded');

      this.el.sceneEl.addEventListener('enter-vr', () => {
        this.ensureHandsVisible();
        this.applyRigOffset();
        if (!this._vrGroundSnapped) {
          window.setTimeout(() => {
            this.snapToGround();
            this._vrGroundSnapped = true;
          }, 100);
        }
      });

      if (this.rig) this.rig.object3D.rotation.y = this.rotationY;
      if (!this._sceneGroundSnapped) {
        window.setTimeout(() => {
          this.snapToGround();
          this._sceneGroundSnapped = true;
        }, 200);
      }
      if (window.VRDriftPalmBall) window.VRDriftPalmBall.init();
    },

    /** World point behind the headset (matches mixamo torso +Z back offset). */
    getBodyCapsuleSyncOpts: function () {
      if (!this.camera || !this.body) return null;
      const cam = new THREE.Vector3();
      const anchor = new THREE.Vector3();
      this.camera.object3D.getWorldPosition(cam);
      this.getBodyAnchorWorld(cam, anchor);
      const floorY = Collide.getFloorHeight(anchor.x, anchor.z, cam.y);
      const floor =
        floorY != null ? floorY : this.body.position.y - C.BODY_BALL_RADIUS;
      return {
        anchorX: anchor.x,
        anchorZ: anchor.z,
        floorY: floor,
        topY: cam.y,
        radius: C.PLAYER_COLLISION_RADIUS != null ? C.PLAYER_COLLISION_RADIUS : 0.24
      };
    },

    getBodyAnchorWorld: function (camWorld, out) {
      const back = new THREE.Vector3(0, 0, 1);
      if (this.camera) {
        const q = new THREE.Quaternion();
        this.camera.object3D.getWorldQuaternion(q);
        back.applyQuaternion(q);
      }
      back.y = 0;
      if (back.lengthSq() < 1e-8) back.set(0, 0, 1);
      back.normalize().multiplyScalar(C.BODY_BACK_OFFSET != null ? C.BODY_BACK_OFFSET : 0.15);
      out.set(camWorld.x + back.x, camWorld.y, camWorld.z + back.z);
      return out;
    },

    snapToGround: function () {
      if (!this.body || !this.camera) return;
      const cam = new THREE.Vector3();
      const anchor = new THREE.Vector3();
      this.camera.object3D.getWorldPosition(cam);
      this.getBodyAnchorWorld(cam, anchor);
      const floorY = Collide.getFloorHeight(anchor.x, anchor.z, cam.y);
      if (floorY == null) return;

      const ballY = floorY + C.BODY_BALL_RADIUS;
      const gap = ballY - this.body.position.y;
      if (Math.abs(gap) < 0.008) return;

      this.body.position.x = anchor.x;
      this.body.position.z = anchor.z;
      this.body.position.y += gap;
      if (Math.abs(gap) > 0.04) {
        this.body.velocity.y = 0;
      }
      this.applyRigOffset();
      this.syncPlayerFromPhysicsBody();
    },

    ensureHandsVisible: function () {
      /* BattleVR: #leftHand/#rightHand stay visible=false; only Mixamo arms show */
      [this.leftPalm, this.rightPalm].forEach((palm) => {
        if (palm) palm.setAttribute('visible', false);
      });
      if (window.VRDriftShadows) {
        [this.leftHand, this.rightHand].forEach((hand) => {
          if (hand) window.VRDriftShadows.apply(hand.object3D, true, false);
        });
      }
    },

    createPlayerPhysicsBody: function () {
      if (!Phys || !Phys.world || !Phys.playerMat) {
        console.warn('[DriftLocomotion] Physics world not ready');
        return;
      }
      const spawn = new THREE.Vector3();
      const cam = new THREE.Vector3();
      if (this.camera) {
        const anchor = new THREE.Vector3();
        this.camera.object3D.getWorldPosition(cam);
        this.getBodyAnchorWorld(cam, anchor);
        const floorY = Collide.getFloorHeight(anchor.x, anchor.z, cam.y);
        spawn.set(anchor.x, (floorY != null ? floorY : 0) + C.BODY_BALL_RADIUS, anchor.z);
      } else {
        spawn.copy(this.el.object3D.position);
        spawn.y += C.BODY_BALL_RADIUS;
      }
      const shape = new CANNON.Sphere(C.BODY_BALL_RADIUS);
      const mass = this.data.mass || C.MASS;
      this.body = new CANNON.Body({
        mass: mass,
        shape: shape,
        linearDamping: C.BALL_LINEAR_DAMPING,
        angularDamping: C.BALL_ANGULAR_DAMPING,
        material: Phys.playerMat
      });
      this.body.fixedRotation = false;
      this.body.allowSleep = true;
      this.body.sleepSpeedLimit = 0.12;
      this.body.sleepAngularSpeedLimit = 0.2;
      this.body.position.set(spawn.x, spawn.y, spawn.z);
      this.body.collisionFilterGroup = 1;
      /* Floor/walls only — game ball hits body capsule (GROUP_BODY), not this sphere */
      this.body.collisionFilterMask = 4;
      const self = this;
      this.body.addEventListener('collide', function (e) {
        self.onBodyCollide(e);
      });
      Phys.world.addBody(this.body);
      this.syncBodyCollisionDebug();
      this.syncPlayerFromPhysicsBody();
    },

    syncBodyCollisionDebug: function () {
      const wrap = document.querySelector('#body-collision-debug');
      if (wrap) wrap.object3D.visible = false;
    },

    onBodyCollide: function (e) {
      const c = e && e.contact;
      if (!c || !c.ni) return;
      let nx = c.ni.x;
      let ny = c.ni.y;
      let nz = c.ni.z;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      if (ny > 0.18) {
        this._groundContactFrames = 12;
        this.groundNormal.set(nx, ny, nz).normalize();
        this.grounded = true;
      }
    },

    readBodyVelocity: function (out) {
      if (!this.body) return out.set(0, 0, 0);
      return out.set(this.body.velocity.x, this.body.velocity.y, this.body.velocity.z);
    },

    clampImpulse: function (ix, iy, iz, max) {
      const len = Math.sqrt(ix * ix + iy * iy + iz * iz);
      if (len < 1e-8) {
        this._cImpulse.set(0, 0, 0);
        return;
      }
      if (len > max) {
        const s = max / len;
        this._cImpulse.set(ix * s, iy * s, iz * s);
      } else {
        this._cImpulse.set(ix, iy, iz);
      }
    },

    palmOnWall: function (key) {
      const t = this.palmTouch[key];
      return t && (!window.VRDriftGameBall || !window.VRDriftGameBall.isGameBallElement(t));
    },

    handsDrivingBall: function () {
      return (
        this.gripHeld.left ||
        this.gripHeld.right ||
        this.palmOnWall('left') ||
        this.palmOnWall('right') ||
        this.isGrabbing.left ||
        this.isGrabbing.right ||
        this.isBraking.left ||
        this.isBraking.right ||
        this.thrusterActive.left ||
        this.thrusterActive.right
      );
    },

    clearBodyWrench: function () {
      if (!this.body) return;
      if (this.handsDrivingBall()) this.body.wakeUp();
      this.body.force.set(0, 0, 0);
      this.body.torque.set(0, 0, 0);
    },

    stabilizeBody: function () {
      if (!this.body) return;
      const v = this.body.velocity;
      const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (speed > this.data.maxSpeed * 1.35) {
        const s = (this.data.maxSpeed * 1.35) / speed;
        v.x *= s;
        v.y *= s;
        v.z *= s;
      }
      const av = this.body.angularVelocity;
      const aLen = Math.sqrt(av.x * av.x + av.y * av.y + av.z * av.z);
      const maxA = C.MAX_ANGULAR_SPEED || 14;
      if (aLen > maxA) {
        const s = maxA / aLen;
        av.x *= s;
        av.y *= s;
        av.z *= s;
      }
    },

    /** Grounded + not moving: kill residual spin from contact friction / solver jitter. */
    dampIdleSpin: function (dt) {
      if (!this.body || !this.grounded) return;
      const v = this.body.velocity;
      const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (speed > C.IDLE_LINEAR_SPEED) return;

      if (this.handsDrivingBall()) return;

      const av = this.body.angularVelocity;
      const spin = Math.sqrt(av.x * av.x + av.y * av.y + av.z * av.z);
      if (spin < C.IDLE_SPIN_STOP) {
        av.set(0, 0, 0);
        return;
      }
      const f = Math.pow(0.08, (dt || 0.016) * 60);
      av.x *= f;
      av.y *= f;
      av.z *= f;
    },

    applyRigOffset: function () {
      if (!this.rig) return;
      const y = C.RIG_Y_OFFSET != null ? C.RIG_Y_OFFSET : 0;
      this.rig.object3D.position.set(0, y, 0);
    },

    syncPlayerFromPhysicsBody: function () {
      if (!this.body) return;
      const b = this.body;
      this.el.object3D.position.set(b.position.x, b.position.y, b.position.z);
      this.velocity.set(b.velocity.x, b.velocity.y, b.velocity.z);
      this.applyRigOffset();
      this.syncBodyCollisionDebug();
    },

    /** Ceiling only — wall/floor handled by Cannon player body (avoids post-step teleport fights). */
    resolveCeilingOnly: function () {
      if (!Collide || !this.body || !this.camera) return;
      const ceiling = document.querySelector('#arena-ceiling');
      if (!ceiling) return;
      const cam = new THREE.Vector3();
      this.camera.object3D.getWorldPosition(cam);
      const push = Col.getCollisionPush(cam, C.HEAD_COLLISION_RADIUS, ceiling, 0.005);
      if (!push || push.lengthSq() < 1e-10) return;
      const maxFix = C.MAX_COLLISION_CORRECTION != null ? C.MAX_COLLISION_CORRECTION : 0.08;
      const len = push.length();
      const s = len > maxFix ? maxFix / len : 1;
      this.body.position.x += push.x * s;
      this.body.position.y += push.y * s;
      this.body.position.z += push.z * s;
      const nx = push.x / len;
      const ny = push.y / len;
      const nz = push.z / len;
      const vn = this.body.velocity.x * nx + this.body.velocity.y * ny + this.body.velocity.z * nz;
      if (vn < 0) {
        this.body.velocity.x -= nx * vn;
        this.body.velocity.y -= ny * vn;
        this.body.velocity.z -= nz * vn;
      }
      this.syncPlayerFromPhysicsBody();
    },

    detectGameBallContact: function () {
      ['left', 'right'].forEach((key) => {
        this.gameBallContact[key] =
          window.VRDriftPalmBall && window.VRDriftPalmBall.hadContact(key);
      });
    },

    getGameBallBody: function () {
      return window.VRDriftGameBall ? window.VRDriftGameBall.getBody() : null;
    },

    isTouchingGameBall: function (key) {
      return !!this.gameBallContact[key];
    },

    getGameBallPalmGap: function (hand) {
      const gameEl = window.VRDriftGameBall ? window.VRDriftGameBall.getEl() : null;
      if (!gameEl || !hand) return Infinity;
      const hp = this.getPalmWorldPos(hand, new THREE.Vector3());
      return Col.distanceToSurface(hp, C.PALM_RADIUS, gameEl);
    },

    setupInput: function () {
      const scene = this.el.sceneEl;
      const bindGrip = (hand) => {
        if (!hand) return;
        hand.addEventListener('gripdown', (e) => this.onGrip(e, true));
        hand.addEventListener('gripup', (e) => this.onGrip(e, false));
        hand.addEventListener('squeezedown', (e) => this.onGrip(e, true));
        hand.addEventListener('squeezeup', (e) => this.onGrip(e, false));
      };
      bindGrip(this.leftHand);
      bindGrip(this.rightHand);
      scene.addEventListener('gripdown', (e) => this.onGrip(e, true));
      scene.addEventListener('gripup', (e) => this.onGrip(e, false));
      scene.addEventListener('squeezedown', (e) => this.onGrip(e, true));
      scene.addEventListener('squeezeup', (e) => this.onGrip(e, false));
      scene.addEventListener('bbuttondown', (e) => this.onThruster(e, true));
      scene.addEventListener('bbuttonup', (e) => this.onThruster(e, false));
      scene.addEventListener('ybuttondown', (e) => this.onThruster(e, true));
      scene.addEventListener('ybuttonup', (e) => this.onThruster(e, false));
      scene.addEventListener('thumbstickmoved', (e) => this.onThumbstick(e));
    },

    onThumbstick: function (evt) {
      if (!evt.target || !evt.detail) return;
      if (window.VRDriftUI && window.VRDriftUI.isMenuOpen()) return;
      const isLeft = evt.target.id === 'leftHand';
      if (!isLeft && Math.abs(evt.detail.x) > 0.1) {
        this.thumbstickRotation.right = -evt.detail.x;
      } else if (!isLeft) {
        this.thumbstickRotation.right = 0;
      }
      if (isLeft && Math.abs(evt.detail.x) > 0.1) {
        this.thumbstickRotation.left = -evt.detail.x;
      } else if (isLeft) {
        this.thumbstickRotation.left = 0;
      }
    },

    handKey: function (hand) {
      return hand && hand.id === 'leftHand' ? 'left' : 'right';
    },

    menuBlocks: function () {
      return window.VRDriftUI && window.VRDriftUI.isMenuOpen();
    },

    onGrip: function (evt, down) {
      if (!evt.target || !evt.target.object3D || this.menuBlocks()) return;
      const key = this.handKey(evt.target);
      this.gripHeld[key] = down;
      if (down) {
        this.tryGripAttach(key, evt.target);
      } else {
        this._floorGripLockout[key] = false;
        this._floorGripPending[key] = false;
        const wasBraking = this.isBraking[key];
        this.releaseGrip(key, evt.target);
        this.releaseFloorGrip(key, false);
        if (wasBraking) this.applyWallJump(key);
      }
    },

    onThruster: function (evt, active) {
      if (!evt.target || this.menuBlocks()) return;
      const key = this.handKey(evt.target);
      this.thrusterActive[key] = active;
    },

    isPalmGlowMesh: function (node) {
      let o = node;
      while (o) {
        if (o.el && (o.el.id === 'left-palm' || o.el.id === 'right-palm')) return true;
        o = o.parent;
      }
      return false;
    },

    getPalmWorldPos: function (hand, out) {
      const palmEl = hand.id === 'leftHand' ? this.leftPalm : this.rightPalm;
      if (palmEl && palmEl.object3D) {
        palmEl.object3D.getWorldPosition(out);
      } else {
        hand.object3D.getWorldPosition(out);
      }
      return out;
    },

    /**
     * Palm collider frame in hand-local space (matches #left-palm child on controller).
     * Box: X=width, Y=thin, Z=fingers.
     */
    getPalmColliderLocalMatrix: function (outMatrix) {
      if (window.VRDriftPalmFrame) {
        return window.VRDriftPalmFrame.composeControllerLocalMatrix(outMatrix);
      }
      return outMatrix.identity();
    },

    getHandColliderPose: function (hand, outPos, outQuat) {
      const side = hand.id === 'leftHand' ? 'left' : 'right';
      const bodyEl = document.querySelector('#local-body');
      const avatar = bodyEl && bodyEl.components['mixamo-body-avatar'];
      if (avatar && avatar.getPalmWorldPose && avatar.getPalmWorldPose(side, outPos, outQuat)) {
        return outPos;
      }
      hand.object3D.updateMatrixWorld(true);
      const localM = this.getPalmColliderLocalMatrix(new THREE.Matrix4());
      const worldM = new THREE.Matrix4().multiplyMatrices(hand.object3D.matrixWorld, localM);
      const scale = new THREE.Vector3();
      worldM.decompose(outPos, outQuat, scale);
      return outPos;
    },

    findNearestSurface: function (hand, selector, maxDist, probeExtra) {
      const hp = this.getPalmWorldPos(hand, new THREE.Vector3());
      let best = null;
      let bestD = maxDist != null ? maxDist : C.PALM_CONTACT_DIST;
      const probeR = C.PALM_RADIUS + (probeExtra || 0);
      Col.querySurfaces(selector).forEach((el) => {
        if (window.VRDriftGameBall && window.VRDriftGameBall.isGameBallElement(el)) return;
        const d = Col.distanceToSurface(hp, probeR, el);
        if (d <= bestD) {
          bestD = d;
          best = el;
        }
      });
      return best;
    },

    findNearestGrip: function (hand) {
      return this.findNearestSurface(
        hand,
        '[drift-grip]',
        C.GRIP_CONTACT_DIST,
        C.GRIP_PROBE_EXTRA
      );
    },

    releaseFloorGrip: function (key, lockUntilGripUp) {
      this.isBraking[key] = false;
      this._floorGripPending[key] = false;
      this.brakeSurface[key] = null;
      this.brakeAnchor[key] = null;
      if (lockUntilGripUp) {
        this._floorGripLockout[key] = true;
        this.gripHeld[key] = false;
      }
    },

    startFloorBrake: function (key, hand, surf) {
      const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
      this.isGrabbing[key] = false;
      this.grabInfo[key] = null;
      this._floorGripPending[key] = false;
      this.isBraking[key] = true;
      this.brakeSurface[key] = surf;
      this.brakeAnchor[key] = {
        anchorPalm: palm.clone(),
        lastPalmPos: palm.clone()
      };
      if (this.body) {
        const slow = C.FLOOR_GRIP_INITIAL_SLOW != null ? C.FLOOR_GRIP_INITIAL_SLOW : 0.4;
        const v = this.body.velocity;
        v.x *= slow;
        v.y *= slow;
        v.z *= slow;
      }
    },

    tryGripAttach: function (key, hand) {
      if (!hand || this._floorGripLockout[key]) return;
      const gripSurf = this.findNearestGrip(hand);
      if (gripSurf) {
        this.attachGrip(key, hand, gripSurf);
        return;
      }
      this._floorGripPending[key] = true;
    },

    updatePendingFloorGrip: function () {
      ['left', 'right'].forEach((key) => {
        if (!this._floorGripPending[key] || !this.gripHeld[key] || this._floorGripLockout[key]) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;
        const floor = this.findNearestSurface(hand, '[drift-floor]');
        if (floor) this.startFloorBrake(key, hand, floor);
      });
    },

    attachGrip: function (key, hand, surface) {
      const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
      const anchor = Col.closestPointOnSurface(palm, surface, new THREE.Vector3());
      const attachBody = new THREE.Vector3();
      if (this.body) {
        attachBody.set(this.body.position.x, this.body.position.y, this.body.position.z);
      }
      this.isGrabbing[key] = true;
      this.isBraking[key] = false;
      this.brakeSurface[key] = null;
      this.brakeAnchor[key] = null;
      this.grabInfo[key] = {
        surface: surface,
        isGripPoint: true,
        anchorWorld: anchor,
        attachBodyPos: attachBody,
        lastPalmPos: palm.clone()
      };
      if (this.body) {
        this.body.velocity.set(0, 0, 0);
        this.body.angularVelocity.set(0, 0, 0);
      }
      this.lastGrabTime = Date.now();
      if (hand && window.VRDriftHaptics) {
        window.VRDriftHaptics.pulseHand(
          hand,
          C.HAPTIC_GRIP_INTENSITY != null ? C.HAPTIC_GRIP_INTENSITY : 0.52,
          C.HAPTIC_GRIP_MS != null ? C.HAPTIC_GRIP_MS : 48
        );
      }
    },

    releaseGrip: function (key, hand) {
      const info = this.grabInfo[key];
      if (info && info.isGripPoint && this.body) {
        const v = this.body.velocity;
        const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        if (speed > C.WALL_JUMP_MIN_SPEED) {
          const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
          const n = Col.getSurfaceNormal(palm, info.surface);
          const j = speed * C.WALL_JUMP_GAIN * 0.35;
          v.x += n.x * j;
          v.y += n.y * j;
          v.z += n.z * j;
        }
      }
      this.isGrabbing[key] = false;
      this.grabInfo[key] = null;
    },

    applyWallJump: function (key) {
      if (!this.body) return;
      const surf = this.brakeSurface[key];
      if (!surf) return;
      const v = this.body.velocity;
      const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (speed < C.WALL_JUMP_MIN_SPEED) return;
      const hand = key === 'left' ? this.leftHand : this.rightHand;
      if (!hand) return;
      const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
      const n = Col.getSurfaceNormal(palm, surf);
      const push = this.handVel[key].length() > 0.5
        ? this.handVel[key].clone().normalize()
        : n;
      const j = speed * C.WALL_JUMP_GAIN;
      v.x += push.x * j;
      v.y += push.y * j;
      v.z += push.z * j;
      this.capVelocity();
    },

    capVelocity: function () {
      if (!this.body) return;
      const v = this.body.velocity;
      const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      const max = this.isRailGrabActive()
        ? (C.GRIP_MAX_SPEED != null ? C.GRIP_MAX_SPEED : 3.2)
        : this.data.maxSpeed;
      if (len > max) {
        const s = max / len;
        v.x *= s;
        v.y *= s;
        v.z *= s;
      }
    },

    applyRotation: function (dt) {
      if (!this.rig) return;
      const input = this.thumbstickRotation.right;
      if (Math.abs(input) > 0.1) {
        this.rotationY += input * this.data.rotationSpeed * dt;
      }
      this.rig.object3D.rotation.y = this.rotationY;
    },

    isRailGrabActive: function () {
      return (
        (this.isGrabbing.left && this.grabInfo.left && this.grabInfo.left.isGripPoint) ||
        (this.isGrabbing.right && this.grabInfo.right && this.grabInfo.right.isGripPoint)
      );
    },

    applyThrusterForces: function (dt) {
      if (!this.body || this.isRailGrabActive()) return;
      const mass = this.body.mass;
      const addHand = (hand) => {
        const d = new THREE.Vector3(0, -1, 0);
        const q = new THREE.Quaternion();
        hand.object3D.getWorldQuaternion(q);
        d.applyQuaternion(q).multiplyScalar(this.data.thrusterForce * mass);
        this.body.force.x += d.x;
        this.body.force.y += d.y;
        this.body.force.z += d.z;
      };
      if (this.thrusterActive.left && this.leftHand) addHand(this.leftHand);
      if (this.thrusterActive.right && this.rightHand) addHand(this.rightHand);
    },

    /**
     * Grip rail: lock palm to the world anchor on the bar/pole — body moves so the hand stays glued.
     */
    applyGripAnchor: function (dt) {
      if (!this.body || !dt) return;
      const stiff = C.GRIP_ANCHOR_STIFFNESS != null ? C.GRIP_ANCHOR_STIFFNESS : 26;
      const maxV = C.GRIP_MAX_SPEED != null ? C.GRIP_MAX_SPEED : 3.2;
      const releaseDist = C.GRIP_RELEASE_DIST != null ? C.GRIP_RELEASE_DIST : 0.55;
      const gravCancel = C.GRIP_GRAVITY_CANCEL != null ? C.GRIP_GRAVITY_CANCEL : 0.94;
      const alpha = 1 - Math.exp(-stiff * dt);
      let any = false;

      ['left', 'right'].forEach((key) => {
        const info = this.grabInfo[key];
        if (!this.isGrabbing[key] || !info || !info.isGripPoint) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand || !info.anchorWorld) return;
        any = true;

        const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
        this._grabPull.copy(palm).sub(info.anchorWorld);
        if (this._grabPull.length() > releaseDist) {
          this.releaseGrip(key, hand);
          return;
        }

        this._grabLockErr.copy(info.anchorWorld).sub(palm);
        const b = this.body;
        b.wakeUp();
        b.position.x += this._grabLockErr.x * alpha;
        b.position.y += this._grabLockErr.y * alpha;
        b.position.z += this._grabLockErr.z * alpha;

        b.velocity.x = (this._grabLockErr.x * alpha) / dt;
        b.velocity.y = (this._grabLockErr.y * alpha) / dt;
        b.velocity.z = (this._grabLockErr.z * alpha) / dt;
        const spd = Math.sqrt(b.velocity.x * b.velocity.x + b.velocity.y * b.velocity.y + b.velocity.z * b.velocity.z);
        if (spd > maxV) {
          const s = maxV / spd;
          b.velocity.x *= s;
          b.velocity.y *= s;
          b.velocity.z *= s;
        }

        b.force.y += -b.mass * C.GRAVITY * gravCancel;
        info.lastPalmPos.copy(palm);
      });

      if (any) {
        const av = this.body.angularVelocity;
        av.x *= 0.85;
        av.y *= 0.85;
        av.z *= 0.85;
      }
    },

    /** Wall brake only — floor grip uses applyBraking (pull was launching the player). */
    applyBrakePull: function (dt) {
      if (!this.body || !dt) return;
      ['left', 'right'].forEach((key) => {
        if (!this.isBraking[key] || this.isGrabbing[key] || !this.brakeAnchor[key]) return;
        const surf = this.brakeSurface[key];
        if (surf && surf.hasAttribute('drift-floor')) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;
        const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
        const anchor = this.brakeAnchor[key];
        const last = anchor.lastPalmPos;
        if (!last) {
          anchor.lastPalmPos = palm.clone();
          return;
        }
        const handMove = palm.clone().sub(last);
        const bv = this.readBodyVelocity(this._bodyVel);
        handMove.x -= bv.x * dt;
        handMove.y -= bv.y * dt;
        handMove.z -= bv.z * dt;
        if (handMove.lengthSq() > 1e-8) {
          const v = this.body.velocity;
          const k = 2.2 * dt;
          v.x -= handMove.x * k;
          v.y -= handMove.y * k;
          v.z -= handMove.z * k;
        }
        anchor.lastPalmPos.copy(palm);
      });
    },

    applyArmPush: function (dt) {
      if (!dt) return;
      const pb = this.body;
      const bv = pb ? this.readBodyVelocity(this._bodyVel) : new THREE.Vector3();
      ['left', 'right'].forEach((key) => {
        if (this.isGrabbing[key] || this.isBraking[key]) return;
        if (!this.palmTouch[key] || !this._palmReady[key]) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        const palm = this.getPalmWorldPos(hand, new THREE.Vector3());

        if (!pb) return;
        this._relPalmDelta.copy(this.palmDelta[key]);
        this._relPalmDelta.x -= bv.x * dt;
        this._relPalmDelta.y -= bv.y * dt;
        this._relPalmDelta.z -= bv.z * dt;
        if (this._relPalmDelta.lengthSq() < 1e-8) return;
        const n = Col.getSurfaceNormal(palm, this.palmTouch[key]);
        const push = this._relPalmDelta.clone().negate();
        const into = n.clone().multiplyScalar(push.dot(n));
        if (into.y < 0) push.sub(into);
        if (push.lengthSq() < 1e-8) return;
        pb.wakeUp();
        pb.velocity.x += push.x * C.ARM_PUSH_GAIN;
        pb.velocity.y += push.y * C.ARM_PUSH_GAIN;
        pb.velocity.z += push.z * C.ARM_PUSH_GAIN;
      });
    },

    /**
     * Floor grip: slam speed down at grab point; if the hand moves, release → normal palm-skate.
     */
    updateFloorGripBrake: function (dt) {
      if (!this.body || !dt) return;
      const releaseDist = C.FLOOR_GRIP_RELEASE_DIST != null ? C.FLOOR_GRIP_RELEASE_DIST : 0.1;
      const brakeF = Math.pow(
        C.FLOOR_GRIP_BRAKE_FACTOR != null ? C.FLOOR_GRIP_BRAKE_FACTOR : 0.55,
        dt * 60
      );

      ['left', 'right'].forEach((key) => {
        if (!this.isBraking[key]) return;
        const surf = this.brakeSurface[key];
        if (!surf || !surf.hasAttribute('drift-floor')) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        const anchor = this.brakeAnchor[key];
        if (!hand || !anchor || !anchor.anchorPalm) return;

        const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
        if (palm.distanceTo(anchor.anchorPalm) > releaseDist) {
          this.releaseFloorGrip(key, true);
          return;
        }

        const v = this.body.velocity;
        v.x *= brakeF;
        v.y *= brakeF;
        v.z *= brakeF;
        anchor.lastPalmPos.copy(palm);
      });
    },

    applyBraking: function (dt) {
      if (!this.body || this.isRailGrabActive()) return;
      const wallBrake =
        (this.isBraking.left &&
          this.brakeSurface.left &&
          !this.brakeSurface.left.hasAttribute('drift-floor')) ||
        (this.isBraking.right &&
          this.brakeSurface.right &&
          !this.brakeSurface.right.hasAttribute('drift-floor'));
      if (!wallBrake) return;
      const f = Math.pow(C.BRAKE_FACTOR, dt * 60);
      const v = this.body.velocity;
      v.x *= f;
      v.y *= f;
      v.z *= f;
    },

    updateHandKinematics: function (dt) {
      ['left', 'right'].forEach((key) => {
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;
        const cur = new THREE.Vector3();
        hand.object3D.getWorldPosition(cur);
        const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
        if (this._palmReady[key] && dt > 0) {
          this.palmDelta[key].subVectors(palm, this.lastPalmPos[key]);
          this.handVel[key].copy(this.palmDelta[key]).divideScalar(dt);
          const bv = this.readBodyVelocity(this._bodyVel);
          this.handVel[key].sub(bv);
        } else {
          this.palmDelta[key].set(0, 0, 0);
          this.handVel[key].set(0, 0, 0);
          this._palmReady[key] = true;
        }
        this.lastHandPos[key].copy(cur);
        this.lastPalmPos[key].copy(palm);
      });
    },

    detectPalmTouches: function () {
      ['left', 'right'].forEach((key) => {
        if (this.isGrabbing[key] || this.isBraking[key]) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;
        this.palmTouch[key] = this.findNearestSurface(hand, '[drift-surface]');
      });
    },

    applyPalmSkate: function (dt) {
      if (!dt) return;
      const pb = this.body;
      ['left', 'right'].forEach((key) => {
        if (this.isGrabbing[key] || this.isBraking[key] || !this.palmTouch[key]) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;
        const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
        const n = Col.getSurfaceNormal(palm, this.palmTouch[key]);
        if (pb) {
          const hv = this.handVel[key];
          const tangent = hv.clone().sub(n.clone().multiplyScalar(hv.dot(n)));
          if (tangent.lengthSq() < 0.0004) return;
          pb.wakeUp();
          const v = pb.velocity;
          v.x += tangent.x * C.SKATE_GAIN * dt;
          v.y += tangent.y * C.SKATE_GAIN * dt;
          v.z += tangent.z * C.SKATE_GAIN * dt;
        }
      });
    },

    isActivelySkating: function () {
      return ['left', 'right'].some((key) => {
        if (this.isGrabbing[key] || this.isBraking[key] || !this.palmTouch[key]) return false;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return false;
        const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
        const n = Col.getSurfaceNormal(palm, this.palmTouch[key]);
        const hv = this.handVel[key];
        const tangent = hv.clone().sub(n.clone().multiplyScalar(hv.dot(n)));
        return tangent.lengthSq() >= 0.0004;
      });
    },

    applyCoastDamping: function (dt) {
      if (!this.body || !dt) return;
      if (this.isActivelySkating()) return;
      if (this.thrusterActive.left || this.thrusterActive.right) return;
      if (this.isGrabbing.left || this.isGrabbing.right || this.isRailGrabActive()) return;
      const f = Math.pow(C.AIR_DAMPING != null ? C.AIR_DAMPING : 0.998, dt * 60);
      const v = this.body.velocity;
      v.x *= f;
      v.y *= f;
      v.z *= f;
    },

    detectGround: function () {
      if (!this.body) return;
      if (this._groundContactFrames > 0) {
        this.grounded = true;
        this._groundContactFrames--;
        return;
      }
      this.grounded = false;
      this.groundNormal.set(0, 1, 0);
      const bx = this.body.position.x;
      const by = this.body.position.y;
      const bz = this.body.position.z;
      const floorY = Col.getWalkableHeightAt(bx, bz, '[drift-floor]', by + 0.5);
      if (floorY == null) return;
      const ballBottom = by - C.BODY_BALL_RADIUS;
      if (ballBottom > floorY + 0.12) return;
      this.grounded = true;
      const n = Col.getFloorNormalAt(bx, bz, '[drift-floor]', by + 0.5);
      if (n) this.groundNormal.copy(n);
    },

    cancelVelocityIntoGround: function () {
      if (!this.body || !this.grounded) return;
      const v = this.body.velocity;
      const n = this.groundNormal;
      const into = v.x * n.x + v.y * n.y + v.z * n.z;
      if (into < 0) {
        v.x -= n.x * into;
        v.y -= n.y * into;
        v.z -= n.z * into;
      }
    },

    updateGripHeld: function () {
      ['left', 'right'].forEach((key) => {
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand || !this.gripHeld[key]) return;
        if (this._floorGripLockout[key]) return;
        if (this.isGrabbing[key]) return;

        const gripSurf = this.findNearestGrip(hand);
        if (gripSurf) {
          this.attachGrip(key, hand, gripSurf);
          return;
        }

        const surf = this.findNearestSurface(hand, '[drift-surface]');
        if (surf && !surf.hasAttribute('drift-floor')) {
          this.isBraking[key] = true;
          this.brakeSurface[key] = surf;
          if (!this.brakeAnchor[key]) {
            const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
            this.brakeAnchor[key] = { lastPalmPos: palm.clone() };
          }
        } else if (this.isBraking[key] && !this._floorGripPending[key]) {
          this.isBraking[key] = false;
          this.brakeSurface[key] = null;
          this.brakeAnchor[key] = null;
        }
      });
    },

    updateSpeedHud: function () {
      const el = document.querySelector('#hud-speed');
      if (el) el.setAttribute('text', 'value', this.velocity.length().toFixed(1) + ' m/s');
    },

    syncPalmGlow: function () {
      if (window.VRDriftPalmBall && window.VRDriftPalmBall.syncHandCollisionDebug) {
        window.VRDriftPalmBall.syncHandCollisionDebug({
          left: !!this.palmTouch.left || !!this.gameBallContact.left,
          right: !!this.palmTouch.right || !!this.gameBallContact.right,
          grabL: this.isGrabbing.left,
          grabR: this.isGrabbing.right
        });
      }
    },

    getNetworkState: function () {
      const b = this.body;
      const p = this.el.object3D.position;
      return {
        px: b ? b.position.x : p.x,
        py: b ? b.position.y : p.y,
        pz: b ? b.position.z : p.z,
        ry: this.rotationY,
        vx: b ? b.velocity.x : this.velocity.x,
        vy: b ? b.velocity.y : this.velocity.y,
        vz: b ? b.velocity.z : this.velocity.z,
        tl: this.thrusterActive.left,
        tr: this.thrusterActive.right
      };
    },

    applyNetworkState: function (s) {
      if (!s || !this.rig) return;
      if (this.body) {
        this.body.position.set(s.px, s.py, s.pz);
        this.body.velocity.set(s.vx, s.vy, s.vz);
      }
      this.rotationY = s.ry || 0;
      this.rig.object3D.rotation.y = this.rotationY;
      this.applyRigOffset();
      this.thrusterActive.left = !!s.tl;
      this.thrusterActive.right = !!s.tr;
      this.syncPlayerFromPhysicsBody();
    },

    frame: function (dtMs) {
      if (!this.rig) return;
      const dt = Math.min((dtMs || 16) / 1000, 0.033);
      if (this.menuBlocks()) return;

      this.applyRotation(dt);
      this.updateHandKinematics(dt);
      this.updatePendingFloorGrip();
      this.updateFloorGripBrake(dt);
      this.detectPalmTouches();
      this.updateGripHeld();
      this.clearBodyWrench();
      this.applyArmPush(dt);
      this.applyPalmSkate(dt);
      this.applyCoastDamping(dt);
      this.applyGripAnchor(dt);
      this.applyBrakePull(dt);
      this.applyThrusterForces(dt);
      this.applyBraking(dt);
      this.cancelVelocityIntoGround();
      this.capVelocity();

      if (window.VRDriftPalmBall) {
        const capsule = this.getBodyCapsuleSyncOpts();
        window.VRDriftPalmBall.sync(
          dt,
          this.getHandColliderPose.bind(this),
          this.leftHand,
          this.rightHand,
          this.camera,
          capsule
        );
      }

      if (Phys && Phys.stepWorld) Phys.stepWorld(dt);

      if (window.VRDriftGameBall) window.VRDriftGameBall.syncAfterPhysics();

      this.detectGameBallContact();
      if (window.VRDriftHaptics) window.VRDriftHaptics.update(this, dt);
      this.stabilizeBody();
      this.dampIdleSpin(dt);
      this.detectGround();
      this.syncPlayerFromPhysicsBody();
      this.resolveCeilingOnly();
      this.ensureHandsVisible();
      this.syncPalmGlow();
      this.updateSpeedHud();

      if (window.VRDriftNet) window.VRDriftNet.tickLocal(this);
    },

    remove: function () {
      if (this.body) Phys.world.removeBody(this.body);
    }
  });

  /* Tick after #local-body IK so palm colliders match visible avatar hands. */
  AFRAME.registerComponent('drift-locomotion-tick', {
    tick: function (t, dtMs) {
      const player = document.querySelector('#player');
      if (player && player.components['drift-locomotion']) {
        player.components['drift-locomotion'].frame(dtMs);
      }
    }
  });

  AFRAME.registerComponent('drift-thruster-vfx', {
    tick: function () {
      const loco = document.querySelector('#player');
      if (!loco || !loco.components['drift-locomotion']) return;
      const L = loco.components['drift-locomotion'];
      const lh = document.querySelector('#leftHand .thruster-vfx');
      const rh = document.querySelector('#rightHand .thruster-vfx');
      if (lh) lh.setAttribute('visible', L.thrusterActive.left);
      if (rh) rh.setAttribute('visible', L.thrusterActive.right);
    }
  });

  AFRAME.registerComponent('drift-remote', {
    schema: { color: { type: 'color', default: '#ff6644' } },
    init: function () {
      const THREE = AFRAME.THREE;
      const col = new THREE.Color(this.data.color);
      this.el.setObject3D(
        'mesh',
        new THREE.Mesh(
          new THREE.SphereGeometry(C.GAME_BALL_RADIUS || 0.5, 24, 16),
          new THREE.MeshStandardMaterial({
            color: col,
            emissive: col,
            emissiveIntensity: 0.2,
            transparent: true,
            opacity: 0.9
          })
        )
      );
      this.target = new THREE.Vector3();
      this.targetRot = 0;
    },
    applyState: function (s) {
      if (!s) return;
      this.target.set(s.px, s.py, s.pz);
      this.targetRot = s.ry || 0;
    },
    tick: function (t, dtMs) {
      const dt = Math.min((dtMs || 16) / 1000, 0.033);
      const p = this.el.object3D.position;
      p.lerp(this.target, Math.min(1, dt * 14));
      const THREE = AFRAME.THREE;
      this.el.object3D.rotation.y = THREE.MathUtils.lerp(this.el.object3D.rotation.y, this.targetRot, dt * 10);
    }
  });
})();
