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
      this._palmPhys = new THREE.Vector3();
      this._palmTrack = new THREE.Vector3();
      this._palmSupportN = new THREE.Vector3();
      this._palmSupportCorr = new THREE.Vector3();
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
      this._floorGripPending = { left: false, right: false };
      this._floorGripEngage = { left: 0, right: 0 };
      this._openFloorWasContact = { left: false, right: false };
      this._openWallWasContact = { left: false, right: false };
      this._wallPlantWasContact = { left: false, right: false };
      this._floorGripPushing = { left: false, right: false };
      this._floorGripWasContact = { left: false, right: false };
      this._palmDrivePush = false;
      this._palmWallPush = false;
      this._palmSkateActive = false;
      this.lastPhysPalmPos = {
        left: new THREE.Vector3(),
        right: new THREE.Vector3()
      };
      this._physPalmReady = { left: false, right: false };
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

      this._pendingVrSnap = false;
      this.el.sceneEl.addEventListener('enter-vr', () => {
        this.ensureHandsVisible();
        this.applyRigOffset();
        this._pendingVrSnap = true;
        this._vrGroundSnapped = true;
        this.snapBodyToHeadset();
        window.setTimeout(() => this.snapBodyToHeadset(), 120);
        window.setTimeout(() => this.snapBodyToHeadset(), 400);
      });

      if (this.rig) this.rig.object3D.rotation.y = this.rotationY;
      if (!this._sceneGroundSnapped) {
        window.setTimeout(() => {
          if (this.isVrLocomotionActive()) this.snapBodyToHeadset();
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

    /** Align locomotion ball under headset; zero velocity (locomotion ball has no floor collider). */
    snapBodyToHeadset: function () {
      if (!this.body || !this.camera) return;
      const cam = new THREE.Vector3();
      const anchor = new THREE.Vector3();
      this.camera.object3D.getWorldPosition(cam);
      this.getBodyAnchorWorld(cam, anchor);
      const floorY = Collide.getFloorHeight(anchor.x, anchor.z, cam.y);
      const y =
        floorY != null ? floorY + C.BODY_BALL_RADIUS : this.body.position.y;
      this.body.position.set(anchor.x, y, anchor.z);
      this.body.velocity.set(0, 0, 0);
      this.body.angularVelocity.set(0, 0, 0);
      this.body.force.set(0, 0, 0);
      this.body.torque.set(0, 0, 0);
      this.grounded = true;
      this.groundNormal.set(0, 1, 0);
      this._groundContactFrames = 12;
      this.resetPalmKinematics();
      this.applyRigOffset();
      if (this.isVrLocomotionActive()) this.syncPlayerFromPhysicsBody();
    },

    snapToGround: function () {
      this.snapBodyToHeadset();
    },

    resetPalmKinematics: function () {
      if (window.VRDriftPalmBall) {
        window.VRDriftPalmBall._ready.left = false;
        window.VRDriftPalmBall._ready.right = false;
      }
      ['left', 'right'].forEach((key) => {
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;
        const palm = new THREE.Vector3();
        this.getTrackedPalmPos(hand, palm);
        this.lastPalmPos[key].copy(palm);
        this.lastPhysPalmPos[key].copy(palm);
        this.palmDelta[key].set(0, 0, 0);
        this.handVel[key].set(0, 0, 0);
        this._palmReady[key] = true;
        this._physPalmReady[key] = false;
      });
    },

    /** One floor settle per frame — Cannon handles contact; snap when close, no multi-pass bounce. */
    constrainBodyToFloor: function () {
      if (!this.body) return;
      const bx = this.body.position.x;
      const by = this.body.position.y;
      const bz = this.body.position.z;
      const reach =
        C.MAX_FLOOR_SUPPORT_REACH != null ? C.MAX_FLOOR_SUPPORT_REACH : 0.55;
      const maxLift =
        C.MAX_FLOOR_CORRECTION != null ? C.MAX_FLOOR_CORRECTION : 0.08;
      const snapTol =
        C.FLOOR_SNAP_TOLERANCE != null ? C.FLOOR_SNAP_TOLERANCE : 0.12;
      const floorY = Col.getSupportFloorHeightAt(
        bx,
        bz,
        '[drift-floor]',
        by,
        reach
      );
      if (floorY == null) return;
      const minY = floorY + C.BODY_BALL_RADIUS;
      const gap = minY - by;
      if (gap <= 0 || gap > reach + C.BODY_BALL_RADIUS) return;
      if (gap <= snapTol) {
        this.body.position.y = minY;
      } else {
        this.body.position.y += Math.min(gap, maxLift);
      }
      if (this.body.velocity.y < 0) this.body.velocity.y = 0;
      this.grounded = true;
      this.groundNormal.set(0, 1, 0);
      this._groundContactFrames = Math.max(this._groundContactFrames, 6);
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
      /* Locomotion ball: floor + walls (same static groups as game ball). */
      this.body.collisionFilterMask = 4 | 32;
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
      if (!this.body || !this.isVrLocomotionActive()) return;
      const b = this.body;
      this.el.object3D.position.set(b.position.x, b.position.y, b.position.z);
      this.velocity.set(b.velocity.x, b.velocity.y, b.velocity.z);
      this.applyRigOffset();
      this.syncBodyCollisionDebug();
    },

    /** Head + torso vs walls/floor (geometric); Cannon ball also hits static group. */
    resolvePlayerCollisions: function () {
      if (!this.body || !Collide) return;
      const grabState = {
        left: !!(
          this.isGrabbing.left ||
          (this.gripHeld.left && this.isBraking.left) ||
          this.palmFloorGripActive('left')
        ),
        right: !!(
          this.isGrabbing.right ||
          (this.gripHeld.right && this.isBraking.right) ||
          this.palmFloorGripActive('right')
        )
      };
      let vel = this.readBodyVelocity(this._bodyVel);
      vel = Collide.resolvePlayer(this.el, vel, grabState);
      this.body.position.set(
        this.el.object3D.position.x,
        this.el.object3D.position.y,
        this.el.object3D.position.z
      );
      this.body.velocity.set(vel.x, vel.y, vel.z);
      this.velocity.copy(vel);
    },

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
          window.VRDriftPalmBall && window.VRDriftPalmBall.hadGameBallContact(key);
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
      return Col.distanceToSurface(hp, this.palmProbeRadius(), gameEl);
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
      if (!down) this._floorGripPushing[key] = false;
      if (down) {
        this.tryGripAttach(key, evt.target);
      } else {
        this._floorGripPending[key] = false;
        const wasFloor =
          this.palmTouch[key] &&
          this.palmTouch[key].hasAttribute('drift-floor');
        const wasWallBrake =
          this.isBraking[key] &&
          this.brakeSurface[key] &&
          !this.brakeSurface[key].hasAttribute('drift-floor');
        this.releaseGrip(key, evt.target);
        this.releaseFloorGrip(key);
        if (wasWallBrake) this.applyWallJump(key);
        if (wasFloor) this.applyWallJump(key);
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

    /** Palm center = physics sphere pose (Orion: palms are the contact authority). */
    getPalmWorldPos: function (hand, out) {
      const key = hand.id === 'leftHand' ? 'left' : 'right';
      if (
        window.VRDriftPalmBall &&
        window.VRDriftPalmBall.getPalmWorldPosition(key, out)
      ) {
        return out;
      }
      const q = new THREE.Quaternion();
      return this.getHandColliderPose(hand, out, q);
    },

    getTrackedPalmPos: function (hand, out) {
      const q = new THREE.Quaternion();
      if (this.fillHandPalmWorldPose(hand, out, q)) return out;
      return hand.object3D.getWorldPosition(out);
    },

    isVrLocomotionActive: function () {
      const scene = this.el.sceneEl;
      return !!(scene && scene.is('vr-mode'));
    },

    /** Flat screen: freeze physics only — never move #player (camera parent) from body pose. */
    holdDesktopBody: function () {
      if (!this.body) return;
      this.body.velocity.set(0, 0, 0);
      this.body.angularVelocity.set(0, 0, 0);
      this.body.force.set(0, 0, 0);
      this.body.torque.set(0, 0, 0);
      this.velocity.set(0, 0, 0);
      this.grounded = true;
    },

    palmProbeRadius: function () {
      return C.PALM_SPHERE_RADIUS != null ? C.PALM_SPHERE_RADIUS : 0.05;
    },

    palmTouchMaxGap: function () {
      if (C.PALM_TOUCH_MAX_GAP != null) return C.PALM_TOUCH_MAX_GAP;
      return C.PALM_CONTACT_DIST != null ? C.PALM_CONTACT_DIST : 0.008;
    },

    palmHadStaticContact: function (key) {
      return !!(window.VRDriftPalmBall && window.VRDriftPalmBall.hadStaticContact(key));
    },

    /** Palm Cannon on drift-floor (useLastFrame = pre-physics support from prior step). */
    palmOnDriftFloor: function (key, useLastFrame) {
      const PB = window.VRDriftPalmBall;
      const hand = key === 'left' ? this.leftHand : this.rightHand;
      if (!hand) return false;
      const gap =
        C.PALM_STATIC_FLOOR_GAP != null ? C.PALM_STATIC_FLOOR_GAP : 0.028;
      const r = this.palmProbeRadius();
      const track = this._palmTrack;
      this.getTrackedPalmPos(hand, track);
      const Col = window.VRDriftCollision;
      if (Col) {
        const floorY = Col.getWalkableHeightAt(
          track.x,
          track.z,
          '[drift-floor]',
          track.y + 2
        );
        if (floorY != null && track.y <= floorY + r + gap) return true;
      }
      if (!PB) return false;
      const contacted = useLastFrame ? PB._wasStaticContact[key] : PB.hadStaticContact(key);
      if (!contacted) return false;
      const touch = this.palmTouch[key];
      if (touch && touch.hasAttribute('drift-floor')) return true;
      return !!this.resolveWalkablePalmTouch(key, hand, gap);
    },

    /** Palm Cannon on wall/ramp side (not walkable floor). */
    palmOnStaticWall: function (key, useLastFrame) {
      if (this.palmOnDriftFloor(key, useLastFrame)) return false;
      const hand = key === 'left' ? this.leftHand : this.rightHand;
      const gap =
        C.PALM_WALL_TOUCH_GAP != null ? C.PALM_WALL_TOUCH_GAP : 0.028;
      if (hand && this.resolveWallPalmTouch(key, hand, gap)) return true;

      const PB = window.VRDriftPalmBall;
      if (!PB) return false;
      const contacted = useLastFrame ? PB._wasStaticContact[key] : PB.hadStaticContact(key);
      if (!contacted) return false;
      const inclineNy =
        C.PALM_FLOOR_SKATE_INCLINE_NY != null ? C.PALM_FLOOR_SKATE_INCLINE_NY : 0.92;
      const n = this._palmSupportN;
      if (PB.getStaticContactNormal(key, n)) {
        if (n.lengthSq() < 1e-8) return true;
        n.normalize();
        return n.y < inclineNy;
      }
      return true;
    },

    /** Cancel world gravity while palms were planted on floor last frame. */
    applyPalmFloorSupportForces: function () {
      if (!this.body || this.isRailGrabActive()) return;
      let count = 0;
      ['left', 'right'].forEach((key) => {
        if (this.palmOnDriftFloor(key, true)) count++;
      });
      if (count < 1) return;
      this.body.wakeUp();
      this.body.force.y += -this.body.mass * C.GRAVITY;
    },

    /**
     * Tracked palm penetrating a wall → shift body so contact stays on the surface.
     * (Moving the rig is how WebXR keeps hands from clipping — we never teleport controllers.)
     */
    applyWallPalmSolidContact: function () {
      if (!this.body) return;
      let handSpeedSq = 0;
      ['left', 'right'].forEach((key) => {
        handSpeedSq += this.handVel[key].lengthSq();
      });
      const handCap =
        C.PALM_WALL_SOLID_MAX_HAND_SPEED != null
          ? C.PALM_WALL_SOLID_MAX_HAND_SPEED
          : 0.35;
      if (handSpeedSq > handCap * handCap) return;

      const r = this.palmProbeRadius();
      const maxFix =
        C.PALM_RIG_WALL_MAX_STEP != null ? C.PALM_RIG_WALL_MAX_STEP : 0.055;
      const tol =
        C.PALM_RIG_WALL_TOLERANCE != null ? C.PALM_RIG_WALL_TOLERANCE : 0.01;
      const palm = this._palmTrack;
      const push = this._palmSupportCorr;
      push.set(0, 0, 0);
      let bestLen = 0;

      ['left', 'right'].forEach((key) => {
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;
        this.getTrackedPalmPos(hand, palm);
        const hit = Col.getBestWallContact(palm, r);
        if (!hit || hit.depth < tol) return;
        const len = hit.push.length();
        if (len > bestLen) {
          bestLen = len;
          push.copy(hit.push);
        }
      });

      if (bestLen < tol) return;
      if (bestLen > maxFix) push.multiplyScalar(maxFix / bestLen);
      this.body.wakeUp();
      this.body.position.x += push.x;
      this.body.position.y += push.y;
      this.body.position.z += push.z;
    },

    /** Kinematic rig lift: floor only — wall solid contact handled separately. */
    applyPalmRigSupport: function () {
      if (!this.body || !window.VRDriftPalmBall || this.isRailGrabActive()) return;
      if (this._palmDrivePush || this._palmSkateActive) return;
      if (
        this.palmOnStaticWall('left', false) ||
        this.palmOnStaticWall('right', false)
      ) {
        return;
      }

      const tol =
        C.PALM_RIG_SUPPORT_TOLERANCE != null ? C.PALM_RIG_SUPPORT_TOLERANCE : 0.018;
      const maxStep =
        C.PALM_RIG_SUPPORT_MAX_STEP != null ? C.PALM_RIG_SUPPORT_MAX_STEP : 0.028;
      const blend =
        C.PALM_RIG_SUPPORT_BLEND != null ? C.PALM_RIG_SUPPORT_BLEND : 0.22;
      const inclineNy =
        C.PALM_FLOOR_SKATE_INCLINE_NY != null ? C.PALM_FLOOR_SKATE_INCLINE_NY : 0.92;

      const phys = this._palmPhys;
      const track = this._palmTrack;
      const n = this._palmSupportN;
      const corr = this._palmSupportCorr;
      let maxLiftY = 0;
      let bestIncline = 0;
      corr.set(0, 0, 0);

      const bodyFloorY = Col.getWalkableHeightAt(
        this.body.position.x,
        this.body.position.z,
        '[drift-floor]',
        this.body.position.y + 2
      );
      if (bodyFloorY != null) {
        const minBodyY = bodyFloorY + C.BODY_BALL_RADIUS;
        if (this.body.position.y < minBodyY - tol) {
          maxLiftY = Math.max(maxLiftY, minBodyY - this.body.position.y);
        }
      }

      ['left', 'right'].forEach((key) => {
        if (!this.palmOnDriftFloor(key, false)) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand || !window.VRDriftPalmBall.getPalmWorldPosition(key, phys)) return;

        this.getTrackedPalmPos(hand, track);
        if (window.VRDriftPalmBall.getStaticContactNormal(key, n)) {
          if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
          else n.normalize();
        } else {
          n.set(0, 1, 0);
        }

        const dx = phys.x - track.x;
        const dy = phys.y - track.y;
        const dz = phys.z - track.z;
        const along = dx * n.x + dy * n.y + dz * n.z;
        if (along > tol) {
          if (n.y >= inclineNy) {
            maxLiftY = Math.max(maxLiftY, along);
          } else if (along > bestIncline) {
            bestIncline = along;
            corr.set(n.x * along, n.y * along, n.z * along);
          }
        }
      });

      let applied = false;
      if (maxLiftY > tol) {
        const lift = Math.min(maxLiftY * blend, maxStep);
        this.body.wakeUp();
        this.body.position.y += lift;
        applied = true;
      }
      if (bestIncline > tol) {
        const clen = corr.length();
        const s = clen > maxStep ? maxStep / clen : blend;
        this.body.wakeUp();
        this.body.position.x += corr.x * s;
        this.body.position.y += corr.y * s;
        this.body.position.z += corr.z * s;
        applied = true;
      }

      if (!applied) return;
      this.zeroPlantedVerticalVelocity();
    },

    zeroPlantedVerticalVelocity: function () {
      if (!this.body) return;
      const v = this.body.velocity;
      if (Math.abs(v.y) < 0.5) v.y = 0;
    },

    /** Kill vertical jitter while palms are planted on the floor. */
    dampPalmPlantedBody: function () {
      if (!this.body || this._palmDrivePush) return;
      let planted = 0;
      ['left', 'right'].forEach((key) => {
        if (this.palmOnDriftFloor(key, false)) planted++;
      });
      if (planted < 1) return;
      const v = this.body.velocity;
      v.y = 0;
      const horiz = Math.sqrt(v.x * v.x + v.z * v.z);
      if (horiz < 0.08) {
        v.x = 0;
        v.z = 0;
      }
    },

    palmTouchesFloor: function (key, hand, forGrip) {
      hand = hand || (key === 'left' ? this.leftHand : this.rightHand);
      if (!hand) return false;
      const maxGap = forGrip
        ? C.PALM_FLOOR_GRIP_MAX_GAP != null
          ? C.PALM_FLOOR_GRIP_MAX_GAP
          : 0.022
        : C.PALM_FLOOR_TOUCH_MAX_GAP != null
          ? C.PALM_FLOOR_TOUCH_MAX_GAP
          : 0.012;
      const floor = this.findNearestSurface(hand, '[drift-floor]', maxGap, 0);
      if (!floor) return false;
      if (this.palmHadStaticContact(key)) return true;
      const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
      const d = Col.distanceToSurface(palm, this.palmProbeRadius(), floor);
      return d <= maxGap;
    },

    getPalmSyncOpts: function () {
      return { floorGrip: { left: null, right: null } };
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

    /** Raw tracked palm frame (avatar/controller) — hands are authoritative. */
    fillHandPalmWorldPose: function (hand, outPos, outQuat) {
      const side = hand.id === 'leftHand' ? 'left' : 'right';
      const bodyEl = document.querySelector('#local-body');
      const avatar = bodyEl && bodyEl.components['mixamo-body-avatar'];
      if (
        avatar &&
        avatar.modelLoaded &&
        avatar.getPalmWorldPose &&
        window.VRDriftPalmFrame &&
        avatar.getPalmWorldPose(side, outPos, outQuat)
      ) {
        return true;
      }
      if (this.isVrLocomotionActive()) {
        hand.object3D.getWorldPosition(outPos);
        hand.object3D.getWorldQuaternion(outQuat);
        return true;
      }
      hand.object3D.updateMatrixWorld(true);
      const localM = this.getPalmColliderLocalMatrix(new THREE.Matrix4());
      const worldM = new THREE.Matrix4().multiplyMatrices(hand.object3D.matrixWorld, localM);
      const scale = new THREE.Vector3();
      worldM.decompose(outPos, outQuat, scale);
      return true;
    },

    getHandColliderPose: function (hand, outPos, outQuat) {
      this.fillHandPalmWorldPose(hand, outPos, outQuat);
      return outPos;
    },

    findNearestSurfaceAtPoint: function (point, selector, maxDist, probeExtra) {
      let best = null;
      let bestD = maxDist != null ? maxDist : this.palmTouchMaxGap();
      const probeR = this.palmProbeRadius() + (probeExtra || 0);
      Col.querySurfaces(selector).forEach((el) => {
        if (window.VRDriftGameBall && window.VRDriftGameBall.isGameBallElement(el)) return;
        const d = Col.distanceToSurface(point, probeR, el);
        if (d <= bestD) {
          bestD = d;
          best = el;
        }
      });
      return best;
    },

    findNearestWallAtPoint: function (point, maxDist) {
      let best = null;
      let bestD = maxDist != null ? maxDist : this.palmTouchMaxGap();
      const probeR = this.palmProbeRadius();
      Col.querySurfaces('[drift-surface]').forEach((el) => {
        if (el.hasAttribute('drift-floor')) return;
        if (window.VRDriftGameBall && window.VRDriftGameBall.isGameBallElement(el)) return;
        const d = Col.distanceToSurface(point, probeR, el);
        if (d <= bestD) {
          bestD = d;
          best = el;
        }
      });
      return best;
    },

    /** Nearest wall at tracked palm — hands are the contact authority for walls. */
    resolveWallPalmTouch: function (key, hand, maxGap) {
      const handRef = hand || (key === 'left' ? this.leftHand : this.rightHand);
      if (!handRef) return null;
      const gap = maxGap != null ? maxGap : 0.008;
      const palm = this._palmPhys;
      this.getTrackedPalmPos(handRef, palm);
      return this.findNearestWallAtPoint(palm, gap);
    },

    findNearestSurface: function (hand, selector, maxDist, probeExtra) {
      const hp = this.getPalmWorldPos(hand, new THREE.Vector3());
      return this.findNearestSurfaceAtPoint(hp, selector, maxDist, probeExtra);
    },

    /**
     * Pick drift-floor under the palm (ramps vs flat arena) using distance + Cannon contact normal.
     */
    resolveWalkablePalmTouch: function (key, hand, maxGap) {
      const handRef = hand || (key === 'left' ? this.leftHand : this.rightHand);
      if (!handRef) return null;
      const palm = new THREE.Vector3();
      if (this.gripHeld[key]) {
        this.getTrackedPalmPos(handRef, palm);
      } else {
        this.getPalmWorldPos(handRef, palm);
      }
      const probeR = this.palmProbeRadius();
      const gap = maxGap != null ? maxGap : 0.032;
      const cn = new THREE.Vector3();
      let hasCn = false;
      if (
        window.VRDriftPalmBall &&
        window.VRDriftPalmBall.getStaticContactNormal(key, cn)
      ) {
        hasCn = true;
      }
      let best = null;
      let bestScore = Infinity;
      Col.querySurfaces('[drift-floor]').forEach((el) => {
        if (window.VRDriftGameBall && window.VRDriftGameBall.isGameBallElement(el)) {
          return;
        }
        const d = Col.distanceToSurface(palm, probeR, el);
        if (d > gap) return;
        let score = d;
        if (hasCn) {
          const gn = Col.getSurfaceNormal(palm, el);
          score += (1 - Math.abs(cn.x * gn.x + cn.y * gn.y + cn.z * gn.z)) * 0.12;
        }
        if (score < bestScore) {
          bestScore = score;
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

    isFloorGrab: function (key) {
      return !!(
        this.gripHeld[key] &&
        this.palmTouch[key] &&
        this.palmTouch[key].hasAttribute('drift-floor')
      );
    },

    palmFloorGripActive: function (key) {
      if (!this.gripHeld[key] || !this.palmHadStaticContact(key)) return false;
      const touch = this.palmTouch[key];
      if (touch && touch.hasAttribute('drift-floor')) return true;
      const hand = key === 'left' ? this.leftHand : this.rightHand;
      if (!hand) return false;
      const gap =
        C.PALM_STATIC_FLOOR_GAP != null ? C.PALM_STATIC_FLOOR_GAP : 0.028;
      return !!this.resolveWalkablePalmTouch(key, hand, gap);
    },

    /** 0 while moving fast, → 1 only after braking below crawl speed (enables full coupling). */
    updateFloorGripEngage: function (key, speed, dt) {
      if (!this.palmFloorGripActive(key)) {
        this._floorGripEngage[key] = 0;
        return 0;
      }
      const crawl =
        C.FLOOR_GRIP_FULL_COUPLE_SPEED != null ? C.FLOOR_GRIP_FULL_COUPLE_SPEED : 1.35;
      const rate = C.FLOOR_GRIP_ENGAGE_RATE != null ? C.FLOOR_GRIP_ENGAGE_RATE : 2.5;
      const target = speed <= crawl ? 1 : 0;
      const alpha = 1 - Math.exp(-rate * dt);
      const e = this._floorGripEngage[key];
      this._floorGripEngage[key] = e + (target - e) * alpha;
      return this._floorGripEngage[key];
    },

    isAnyGrabActive: function () {
      return this.isRailGrabActive();
    },

    releaseFloorGrip: function (key) {
      this._floorGripPending[key] = false;
    },

    tryGripAttach: function (key, hand) {
      if (!hand) return;
      const gripSurf = this.findNearestGrip(hand);
      if (gripSurf) {
        this.attachGrip(key, hand, gripSurf);
        return;
      }
      if (this.palmTouchesFloor(key, hand, true) && window.VRDriftHaptics) {
        window.VRDriftHaptics.pulseHand(
          hand,
          C.HAPTIC_GRIP_INTENSITY != null ? C.HAPTIC_GRIP_INTENSITY : 0.52,
          C.HAPTIC_GRIP_MS != null ? C.HAPTIC_GRIP_MS : 48
        );
      }
    },

    updatePendingFloorGrip: function () {},

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
        ? C.GRIP_MAX_SPEED != null
          ? C.GRIP_MAX_SPEED
          : 3.2
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
      if (!this.body || this.isAnyGrabActive()) return;
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
     * Grip anchor: rails (anchor − palm) and floor (palm − anchor) so the body follows hand motion.
     */
    applyGripAnchor: function (dt) {
      if (!this.body || !dt) return;
      const stiff = C.GRIP_ANCHOR_STIFFNESS != null ? C.GRIP_ANCHOR_STIFFNESS : 22;
      const maxV = C.GRIP_MAX_SPEED != null ? C.GRIP_MAX_SPEED : 3.2;
      const releaseDist = C.GRIP_RELEASE_DIST != null ? C.GRIP_RELEASE_DIST : 0.55;
      const gravCancel = C.GRIP_GRAVITY_CANCEL != null ? C.GRIP_GRAVITY_CANCEL : 0.94;
      let any = false;

      ['left', 'right'].forEach((key) => {
        const info = this.grabInfo[key];
        if (!this.isGrabbing[key] || !info || !info.anchorWorld) return;
        if (!info.isGripPoint) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;
        any = true;

        const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
        let alpha = 1 - Math.exp(-stiff * dt);
        const maxCorr = C.GRIP_MAX_CORR != null ? C.GRIP_MAX_CORR : 0.045;
        const release = releaseDist;

        this._grabPull.copy(palm).sub(info.anchorWorld);
        if (this._grabPull.length() > release) {
          this.releaseGrip(key, hand);
          return;
        }
        this._grabLockErr.copy(info.anchorWorld).sub(palm);
        const b = this.body;
        b.wakeUp();
        let dx = this._grabLockErr.x * alpha;
        let dy = this._grabLockErr.y * alpha;
        let dz = this._grabLockErr.z * alpha;
        const clen = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (clen > maxCorr) {
          const s = maxCorr / clen;
          dx *= s;
          dy *= s;
          dz *= s;
        }
        b.position.x += dx;
        b.position.y += dy;
        b.position.z += dz;
        b.velocity.x = dx / dt;
        b.velocity.y = dy / dt;
        b.velocity.z = dz / dt;
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

    /**
     * Palm on surface + controller motion: rig follows inverse of tracked palm delta.
     * Open-hand floor: lift/jump only from arm push (handInto on rel palm delta). No sphere-gap lift.
     * Fast push: v = sx/dt. Swipe: steer. Flat floor subtracts full body step (no landing bounce).
     */
    applyPalmContactCoupling: function (dt) {
      if (!this.body || !dt || !window.VRDriftPalmBall) return;
      if (this.isRailGrabActive()) return;

      const couple =
        C.PALM_CONTACT_COUPLING != null ? C.PALM_CONTACT_COUPLING : 1;
      const maxStep =
        C.PALM_CONTACT_MAX_STEP != null ? C.PALM_CONTACT_MAX_STEP : 0.055;
      const minInto =
        C.PALM_CONTACT_MIN_INTO != null ? C.PALM_CONTACT_MIN_INTO : 0.0004;
      const maxDelta = C.PALM_DELTA_MAX != null ? C.PALM_DELTA_MAX : 0.07;
      const bv = this.readBodyVelocity(this._bodyVel);
      const bodySpeed = Math.sqrt(bv.x * bv.x + bv.y * bv.y + bv.z * bv.z);
      const n = new THREE.Vector3();
      const bodyStep = new THREE.Vector3();
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let nActive = 0;
      let anyFloorGrip = false;
      let openFloorCoupled = false;
      let openPushInto = false;
      let nSumX = 0;
      let nSumY = 0;
      let nSumZ = 0;
      let nSumN = 0;
      let maxFloorEngage = 0;
      let anyWallCoupled = false;
      let openWallCoupled = false;
      let openWallPush = false;
      const wallSteerBlend =
        C.PALM_WALL_SKATE_STEER_BLEND != null ? C.PALM_WALL_SKATE_STEER_BLEND : 0.32;
      const wallMaxSkateDv =
        C.PALM_WALL_SKATE_MAX_DV != null ? C.PALM_WALL_SKATE_MAX_DV : 1.05;
      const staticFloorGap =
        C.PALM_STATIC_FLOOR_GAP != null ? C.PALM_STATIC_FLOOR_GAP : 0.032;
      const crawlCouple =
        C.FLOOR_GRIP_FULL_COUPLE_SPEED != null ? C.FLOOR_GRIP_FULL_COUPLE_SPEED : 1.35;
      const minSkateTangent =
        C.PALM_FLOOR_SKATE_MIN_TANGENT != null ? C.PALM_FLOOR_SKATE_MIN_TANGENT : 0.018;
      const minSkateInto =
        C.PALM_FLOOR_SKATE_MIN_INTO != null ? C.PALM_FLOOR_SKATE_MIN_INTO : 0.006;
      const minSkateDrive =
        C.PALM_FLOOR_SKATE_MIN_DRIVE != null ? C.PALM_FLOOR_SKATE_MIN_DRIVE : 0.02;
      const maxSkateDv =
        C.PALM_FLOOR_SKATE_MAX_DV != null ? C.PALM_FLOOR_SKATE_MAX_DV : 0.55;
      const steerBlend =
        C.PALM_FLOOR_SKATE_STEER_BLEND != null ? C.PALM_FLOOR_SKATE_STEER_BLEND : 0.22;
      const inclineNy =
        C.PALM_FLOOR_SKATE_INCLINE_NY != null ? C.PALM_FLOOR_SKATE_INCLINE_NY : 0.92;
      const inclineTang =
        C.PALM_FLOOR_SKATE_INCLINE_TANGENT != null
          ? C.PALM_FLOOR_SKATE_INCLINE_TANGENT
          : 0.01;

      ['left', 'right'].forEach((key) => {
        if (!this._palmReady[key]) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;

        let coupled = false;

        if (this.palmHadStaticContact(key)) {
          const walkable = this.resolveWalkablePalmTouch(key, hand, staticFloorGap);
          if (walkable) this.palmTouch[key] = walkable;

          const onFloor = !!(this.palmTouch[key] && this.palmTouch[key].hasAttribute('drift-floor'));
          if (onFloor) {
            coupled = true;
            const floorGrip = this.palmFloorGripActive(key);
            let gripScale = 1;
            if (floorGrip) {
              anyFloorGrip = true;
              gripScale = this.updateFloorGripEngage(key, bodySpeed, dt);
              maxFloorEngage = Math.max(maxFloorEngage, gripScale);
            }
            const onOpenFloor =
              !floorGrip && this.palmTouch[key].hasAttribute('drift-floor');
            const onFloorPlant = onOpenFloor || floorGrip;
            if (onOpenFloor) {
              if (!this._openFloorWasContact[key]) {
                this._openFloorWasContact[key] = true;
                const tp = this.getTrackedPalmPos(hand, new THREE.Vector3());
                this.lastPalmPos[key].copy(tp);
                this.palmDelta[key].set(0, 0, 0);
              }
            } else {
              this._openFloorWasContact[key] = false;
            }
            if (floorGrip) {
              if (!this._floorGripWasContact[key]) {
                this._floorGripWasContact[key] = true;
                const tp = this.getTrackedPalmPos(hand, new THREE.Vector3());
                this.lastPalmPos[key].copy(tp);
                this.palmDelta[key].set(0, 0, 0);
              }
            } else {
              this._floorGripWasContact[key] = false;
            }

            const trackPalm = this.getTrackedPalmPos(hand, new THREE.Vector3());
            if (window.VRDriftPalmBall.getStaticContactNormal(key, n)) {
              /* Cannon contact normal */
            } else {
              n.copy(Col.getSurfaceNormal(trackPalm, this.palmTouch[key]));
            }

            const inclineWalk = onFloorPlant && n.y < inclineNy;
            nSumX += n.x;
            nSumY += n.y;
            nSumZ += n.z;
            nSumN++;

            this._relPalmDelta.copy(this.palmDelta[key]);
            bodyStep.copy(bv).multiplyScalar(dt);
            const bodyAlong = n.x * bodyStep.x + n.y * bodyStep.y + n.z * bodyStep.z;
            if (onFloorPlant && inclineWalk) {
              this._relPalmDelta.x -= n.x * bodyAlong;
              this._relPalmDelta.y -= n.y * bodyAlong;
              this._relPalmDelta.z -= n.z * bodyAlong;
            } else if (onFloorPlant) {
              this._relPalmDelta.sub(bodyStep);
            } else {
              bodyStep.x -= n.x * bodyAlong;
              bodyStep.y -= n.y * bodyAlong;
              bodyStep.z -= n.z * bodyAlong;
              this._relPalmDelta.sub(bodyStep);
            }

            let dLen = this._relPalmDelta.length();
            if (dLen > maxDelta && dLen > 1e-8) {
              this._relPalmDelta.multiplyScalar(maxDelta / dLen);
              dLen = maxDelta;
            }

            const handInto = -(
              this._relPalmDelta.x * n.x +
              this._relPalmDelta.y * n.y +
              this._relPalmDelta.z * n.z
            );

            if (onFloorPlant) {
              const nd =
                this._relPalmDelta.x * n.x +
                this._relPalmDelta.y * n.y +
                this._relPalmDelta.z * n.z;
              const tangX = this._relPalmDelta.x - n.x * nd;
              const tangY = this._relPalmDelta.y - n.y * nd;
              const tangZ = this._relPalmDelta.z - n.z * nd;
              const tangLen = Math.sqrt(tangX * tangX + tangY * tangY + tangZ * tangZ);
              const tangGate = inclineWalk ? inclineTang : minSkateTangent;
              if (tangLen < tangGate && handInto < minSkateInto) return;
              if (handInto >= minSkateInto) {
                openPushInto = true;
                if (floorGrip) this._floorGripPushing[key] = true;
              }
            } else if (handInto < minInto && dLen < minInto) {
              return;
            }

            if (
              floorGrip &&
              (bodySpeed > crawlCouple || gripScale < 0.35) &&
              handInto < minSkateInto
            ) {
              return;
            }

            const coupleScale =
              floorGrip && handInto >= minSkateInto ? 1 : gripScale;
            let mx = -this._relPalmDelta.x * couple * coupleScale;
            let my = -this._relPalmDelta.y * couple * coupleScale;
            let mz = -this._relPalmDelta.z * couple * coupleScale;
            const rigInto = mx * n.x + my * n.y + mz * n.z;
            if (rigInto < 0) {
              mx -= n.x * rigInto;
              my -= n.y * rigInto;
              mz -= n.z * rigInto;
            }

            sx += mx;
            sy += my;
            sz += mz;
            nActive++;
            if (onOpenFloor) openFloorCoupled = true;
            return;
          }
        }

        this._openWallWasContact[key] = false;
        if (coupled || this.palmOnDriftFloor(key, false)) return;

        const wallGap =
          C.PALM_WALL_TOUCH_GAP != null ? C.PALM_WALL_TOUCH_GAP : 0.008;
        const wallSurf = this.resolveWallPalmTouch(key, hand, wallGap);
        if (!wallSurf) {
          this._wallPlantWasContact[key] = false;
          return;
        }

        this.palmTouch[key] = wallSurf;
        const trackPalm = this.getTrackedPalmPos(hand, new THREE.Vector3());
        const r = this.palmProbeRadius();
        if (Col.distanceToSurface(trackPalm, r, wallSurf) > wallGap) {
          this._wallPlantWasContact[key] = false;
          return;
        }

        if (!this._wallPlantWasContact[key]) {
          this._wallPlantWasContact[key] = true;
          this.lastPalmPos[key].copy(trackPalm);
          this.palmDelta[key].set(0, 0, 0);
        }

        this._openWallWasContact[key] = true;
        openWallCoupled = true;
        anyWallCoupled = true;

        n.copy(Col.getSurfaceNormal(trackPalm, wallSurf));
        nSumX += n.x;
        nSumY += n.y;
        nSumZ += n.z;
        nSumN++;

        const wallCouple =
          C.PALM_WALL_COUPLE != null ? C.PALM_WALL_COUPLE : couple;
        /* Hand motion beyond rig/body travel — not body slamming into the wall. */
        this._relPalmDelta.copy(this.palmDelta[key]);
        bodyStep.copy(bv).multiplyScalar(dt);
        this._relPalmDelta.sub(bodyStep);

        let dLen = this._relPalmDelta.length();
        if (dLen > maxDelta && dLen > 1e-8) {
          this._relPalmDelta.multiplyScalar(maxDelta / dLen);
          dLen = maxDelta;
        }

        const handInto = -(
          this._relPalmDelta.x * n.x +
          this._relPalmDelta.y * n.y +
          this._relPalmDelta.z * n.z
        );
        const nd =
          this._relPalmDelta.x * n.x +
          this._relPalmDelta.y * n.y +
          this._relPalmDelta.z * n.z;
        const tangX = this._relPalmDelta.x - n.x * nd;
        const tangY = this._relPalmDelta.y - n.y * nd;
        const tangZ = this._relPalmDelta.z - n.z * nd;
        const tangLen = Math.sqrt(tangX * tangX + tangY * tangY + tangZ * tangZ);
        if (tangLen < minSkateTangent && handInto < minSkateInto) return;
        if (handInto >= minSkateInto) openWallPush = true;

        let mx = -this._relPalmDelta.x * wallCouple;
        let my = -this._relPalmDelta.y * wallCouple;
        let mz = -this._relPalmDelta.z * wallCouple;
        const rigInto = mx * n.x + my * n.y + mz * n.z;
        if (rigInto < 0) {
          mx -= n.x * rigInto;
          my -= n.y * rigInto;
          mz -= n.z * rigInto;
        }

        sx += mx;
        sy += my;
        sz += mz;
        nActive++;
      });

      if (anyFloorGrip) {
        this.applyFloorGripBrake(dt, bodySpeed);
      }

      if (nActive < 1) return;
      sx /= nActive;
      sy /= nActive;
      sz /= nActive;
      let len = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (len < 1e-8) return;
      const wallMaxStep =
        C.PALM_WALL_MAX_STEP != null ? C.PALM_WALL_MAX_STEP : maxStep;
      const stepCap =
        openWallCoupled && !anyFloorGrip && !openFloorCoupled ? wallMaxStep : maxStep;
      if (len > stepCap && len > 1e-8) {
        const s = stepCap / len;
        sx *= s;
        sy *= s;
        sz *= s;
        len = stepCap;
      }

      const brakeOnly =
        anyFloorGrip &&
        !openPushInto &&
        (bodySpeed > crawlCouple || maxFloorEngage < 0.65);
      const openSkateOnly =
        (openFloorCoupled || openWallCoupled) && !anyFloorGrip;
      const floorGripCouple = anyFloorGrip && !openSkateOnly;
      const plantCouple = openSkateOnly || floorGripCouple;
      const plantLaunch = openPushInto && plantCouple && openFloorCoupled;

      this.body.wakeUp();
      if (!brakeOnly) {
        if (plantLaunch) {
          this.body.position.x += sx;
          this.body.position.y += sy;
          this.body.position.z += sz;
          if (dt > 1e-6) {
            this.body.velocity.x = sx / dt;
            this.body.velocity.y = sy / dt;
            this.body.velocity.z = sz / dt;
          }
          this._palmSkateActive = true;
        } else if (plantCouple && openWallCoupled) {
          const driveGate = minSkateInto;
          const driveCouple = len >= driveGate;
          if (driveCouple) {
            this.body.position.x += sx;
            this.body.position.y += sy;
            this.body.position.z += sz;
          }
          if (dt > 1e-6 && len >= driveGate) {
            let cvx = sx / dt;
            let cvy = sy / dt;
            let cvz = sz / dt;
            const capDv =
              C.PALM_WALL_SKATE_MAX_DV != null
                ? C.PALM_WALL_SKATE_MAX_DV
                : this.data.maxSpeed != null
                  ? this.data.maxSpeed
                  : 11;
            const cvLen = Math.sqrt(cvx * cvx + cvy * cvy + cvz * cvz);
            if (cvLen > capDv && cvLen > 1e-8) {
              const s = capDv / cvLen;
              cvx *= s;
              cvy *= s;
              cvz *= s;
            }
            const v = this.body.velocity;
            if (openWallPush) {
              /* Deliberate arm push-off — speed matches hand drive, not inverted body slam. */
              v.x = cvx;
              v.y = cvy;
              v.z = cvz;
            } else {
              /* Swipe along wall only — steer tangent; never launch from body impact. */
              const t =
                steerBlend * Math.min(1, len / driveGate);
              v.x += (cvx - v.x) * t;
              v.y += (cvy - v.y) * t;
              v.z += (cvz - v.z) * t;
            }
            this._palmSkateActive = true;
            this._palmWallPush = openWallPush;
          }
          this.absorbWallBodyImpact(nSumX, nSumY, nSumZ, nSumN, openWallPush);
        } else if (plantCouple) {
          const driveGate = minSkateDrive;
          const driveCouple = len >= driveGate;
          if (driveCouple) {
            this.body.position.x += sx;
            this.body.position.y += sy;
            this.body.position.z += sz;
          }
          if (dt > 1e-6 && len >= driveGate) {
            let cvx = sx / dt;
            let cvy = sy / dt;
            let cvz = sz / dt;
            if (nSumN > 0) {
              let nx = nSumX / nSumN;
              let ny = nSumY / nSumN;
              let nz = nSumZ / nSumN;
              const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
              if (nLen > 1e-8) {
                nx /= nLen;
                ny /= nLen;
                nz /= nLen;
                const nd = cvx * nx + cvy * ny + cvz * nz;
                cvx -= nx * nd;
                cvy -= ny * nd;
                cvz -= nz * nd;
              }
            }
            const capDv = maxSkateDv;
            const cvLen = Math.sqrt(cvx * cvx + cvy * cvy + cvz * cvz);
            if (cvLen > capDv && cvLen > 1e-8) {
              const s = capDv / cvLen;
              cvx *= s;
              cvy *= s;
              cvz *= s;
            }
            if (cvLen > 1e-6) {
              const steerK = steerBlend;
              const drive = Math.min(1, len / driveGate);
              const t = steerK * drive;
              const v = this.body.velocity;
              v.x += (cvx - v.x) * t;
              v.y += (cvy - v.y) * t;
              v.z += (cvz - v.z) * t;
              this._palmSkateActive = true;
            }
          } else if (floorGripCouple) {
            this.zeroPlantedVerticalVelocity();
          }
        } else {
          this.body.position.x += sx;
          this.body.position.y += sy;
          this.body.position.z += sz;
          if (dt > 1e-6) {
            this.body.velocity.x = sx / dt;
            this.body.velocity.y = sy / dt;
            this.body.velocity.z = sz / dt;
          }
        }
      }

      /* Only skip rig damp/support during an actual upward launch, not idle open-hand plant. */
      this._palmDrivePush = openPushInto && this.body.velocity.y > 0.12;
      if (!this._palmDrivePush) {
        this._palmDrivePush = !!this._palmWallPush;
      }

      if (openFloorCoupled && !openPushInto) {
        this.zeroPlantedVerticalVelocity();
      }
      this.capVelocity();
    },

    /** Palm on wall, no arm push: kill motion into the surface (catch/slide, never invert). */
    absorbWallBodyImpact: function (nSumX, nSumY, nSumZ, nSumN, handPushing) {
      if (!this.body || handPushing || nSumN < 1) return;
      let nx = nSumX / nSumN;
      let ny = nSumY / nSumN;
      let nz = nSumZ / nSumN;
      const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nLen < 1e-8) return;
      nx /= nLen;
      ny /= nLen;
      nz /= nLen;
      const v = this.body.velocity;
      const vn = v.x * nx + v.y * ny + v.z * nz;
      if (vn >= -0.02) return;
      v.x -= nx * vn;
      v.y -= ny * vn;
      v.z -= nz * vn;
    },

    /** Grip + floor: ease speed down (m/s²); stronger when moving faster — never snap v to zero. */
    applyFloorGripBrake: function (dt, bodySpeed) {
      if (!this.body || !dt) return;
      let gripCount = 0;
      ['left', 'right'].forEach((key) => {
        if (this.palmFloorGripActive(key)) gripCount++;
      });
      if (gripCount < 1) return;

      const v = this.body.velocity;
      const speed =
        bodySpeed != null
          ? bodySpeed
          : Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (speed < 0.04) return;

      const decel =
        C.FLOOR_GRIP_MAX_DECEL != null ? C.FLOOR_GRIP_MAX_DECEL : 16;
      const shed = decel * dt;
      const scale = Math.max(0, (speed - shed) / speed);
      this.body.wakeUp();
      v.x *= scale;
      v.y *= scale;
      v.z *= scale;
    },

    applyArmPush: function () {},

    applyPalmSurfaceLocomotion: function () {},

    updatePhysPalmKinematics: function () {
      if (!window.VRDriftPalmBall) return;
      const pos = new THREE.Vector3();
      ['left', 'right'].forEach((key) => {
        if (!window.VRDriftPalmBall.getPalmWorldPosition(key, pos)) return;
        this.lastPhysPalmPos[key].copy(pos);
        this._physPalmReady[key] = true;
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
      const q = new THREE.Quaternion();
      ['left', 'right'].forEach((key) => {
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;
        const cur = new THREE.Vector3();
        hand.object3D.getWorldPosition(cur);
        const palm = new THREE.Vector3();
        this.getTrackedPalmPos(hand, palm);
        if (this._palmReady[key] && dt > 0) {
          this.palmDelta[key].subVectors(palm, this.lastPalmPos[key]);
          this.handVel[key].copy(this.palmDelta[key]).divideScalar(dt);
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
      const gap = this.palmTouchMaxGap();
      const floorGap =
        C.PALM_FLOOR_TOUCH_MAX_GAP != null ? C.PALM_FLOOR_TOUCH_MAX_GAP : 0.012;
      const staticFloorGap =
        C.PALM_STATIC_FLOOR_GAP != null ? C.PALM_STATIC_FLOOR_GAP : 0.032;
      ['left', 'right'].forEach((key) => {
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;
        if (this.palmHadStaticContact(key)) {
          const floorHit = this.resolveWalkablePalmTouch(key, hand, staticFloorGap);
          if (floorHit) {
            this.palmTouch[key] = floorHit;
            return;
          }
          const wallHit = this.resolveWallPalmTouch(key, hand, staticFloorGap);
          if (wallHit) {
            this.palmTouch[key] = wallHit;
            return;
          }
          const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
          this.palmTouch[key] = this.findNearestSurfaceAtPoint(
            palm,
            '[drift-surface]',
            staticFloorGap,
            0
          );
          return;
        }
        const wallNear = this.resolveWallPalmTouch(key, hand, floorGap);
        if (wallNear) {
          this.palmTouch[key] = wallNear;
          return;
        }
        const floor = this.resolveWalkablePalmTouch(key, hand, floorGap);
        if (floor) {
          this.palmTouch[key] = floor;
          return;
        }
        if (this.isGrabbing[key] || this.isBraking[key]) return;
        this.palmTouch[key] = null;
      });
    },

    applyPalmSkate: function () {
      /* Replaced by VRDriftPalmBall.drivePlayerFromPalms after physics step. */
    },

    isActivelySkating: function () {
      const coastSpeed =
        C.PALM_FLOOR_SKATE_COAST_SPEED != null ? C.PALM_FLOOR_SKATE_COAST_SPEED : 0.35;
      const wallCoast =
        C.PALM_WALL_COAST_SPEED != null ? C.PALM_WALL_COAST_SPEED : 0.32;
      const bv = this.readBodyVelocity(this._bodyVel);
      const bodySpeed = Math.sqrt(bv.x * bv.x + bv.y * bv.y + bv.z * bv.z);

      return ['left', 'right'].some((key) => {
        if (this.isGrabbing[key] || this.isBraking[key]) return false;

        if (
          this.palmOnStaticWall(key, false) &&
          (this._wallPlantWasContact[key] || this._openWallWasContact[key]) &&
          (bodySpeed >= wallCoast || this.handVel[key].lengthSq() > 0.0012)
        ) {
          return true;
        }

        if (!this.palmTouch[key]) return false;

        if (
          !this.gripHeld[key] &&
          this.palmTouch[key].hasAttribute('drift-floor') &&
          this.palmHadStaticContact(key) &&
          bodySpeed >= coastSpeed
        ) {
          return true;
        }

        if (!this.palmHadStaticContact(key)) return false;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand || !this._physPalmReady[key]) return false;
        const palm = this.getPalmWorldPos(hand, new THREE.Vector3());
        const n = Col.getSurfaceNormal(palm, this.palmTouch[key]);
        const move = palm.clone().sub(this.lastPhysPalmPos[key]);
        const tangent = move.sub(n.clone().multiplyScalar(move.dot(n)));
        return tangent.lengthSq() >= 0.0004;
      });
    },

    applyCoastDamping: function (dt) {
      if (!this.body || !dt) return;
      if (this.isActivelySkating()) return;
      if (this.thrusterActive.left || this.thrusterActive.right) return;
      if (this.isAnyGrabActive()) return;
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
      if (!this.body || !this.grounded || this.isAnyGrabActive()) return;
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
        if (this.isGrabbing[key]) return;

        const gripSurf = this.findNearestGrip(hand);
        if (gripSurf) {
          this.attachGrip(key, hand, gripSurf);
          return;
        }

        if (!this.palmHadStaticContact(key)) return;
        const surf = this.findNearestSurface(
          hand,
          '[drift-surface]',
          this.palmTouchMaxGap()
        );
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
          grabR: this.isGrabbing.right,
          floorL: this.isFloorGrab('left'),
          floorR: this.isFloorGrab('right')
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
      this._palmSkateActive = false;
      this._palmWallPush = false;
      if (this.menuBlocks()) return;

      if (!this.isVrLocomotionActive()) {
        if (
          window.VRDriftPalmBall &&
          window.VRDriftPalmBall.showPalmSphereDebug &&
          window.VRDriftPalmBall.showPalmSphereDebug()
        ) {
          window.VRDriftPalmBall.sync(
            dt,
            this.getHandColliderPose.bind(this),
            this.leftHand,
            this.rightHand,
            this.camera,
            null
          );
          window.VRDriftPalmBall.syncHandCollisionDebug({});
        }
        this.holdDesktopBody();
        this.updateSpeedHud();
        return;
      }

      if (this._pendingVrSnap) {
        this.snapBodyToHeadset();
        this._pendingVrSnap = false;
      }

      this.applyRotation(dt);
      this.updateHandKinematics(dt);
      if (window.VRDriftPalmBall) {
        const palmOpts = this.getPalmSyncOpts();
        const capsule = this.getBodyCapsuleSyncOpts();
        window.VRDriftPalmBall.sync(
          dt,
          this.getHandColliderPose.bind(this),
          this.leftHand,
          this.rightHand,
          this.camera,
          capsule,
          palmOpts
        );
      }
      this.updatePendingFloorGrip();
      this.updateGripHeld();
      this.clearBodyWrench();
      this.applyPalmFloorSupportForces();
      this.applyCoastDamping(dt);
      this.applyBrakePull(dt);
      this.applyThrusterForces(dt);
      this.applyBraking(dt);
      this.detectGround();
      this.cancelVelocityIntoGround();
      this.capVelocity();

      if (Phys && Phys.stepWorld) Phys.stepWorld(dt);

      if (window.VRDriftPalmBall) {
        window.VRDriftPalmBall.finishPhysicsStep();
        window.VRDriftPalmBall.snapPalmsToHands(
          this.getHandColliderPose.bind(this),
          this.leftHand,
          this.rightHand,
          (key) => this.palmOnDriftFloor(key, false)
        );
        const gameBody =
          window.VRDriftGameBall && window.VRDriftGameBall.getBody
            ? window.VRDriftGameBall.getBody()
            : null;
        if (gameBody) {
          window.VRDriftPalmBall.driveGameBallFromPalms(gameBody, dt);
        }
      }

      if (window.VRDriftGameBall) window.VRDriftGameBall.syncAfterPhysics();

      if (window.VRDriftPalmBall) {
        this.detectPalmTouches();
        this.applyGripAnchor(dt);
        window.VRDriftPalmBall.constrainPalms(this.getPalmSyncOpts());
        this.updatePhysPalmKinematics();
      } else {
        this.detectPalmTouches();
      }
      this.detectGameBallContact();
      if (window.VRDriftHaptics) window.VRDriftHaptics.update(this, dt);
      this.stabilizeBody();
      this.dampIdleSpin(dt);
      this.detectGround();
      this.syncPlayerFromPhysicsBody();
      this.resolvePlayerCollisions();
      if (window.VRDriftPalmBall) {
        this.applyPalmContactCoupling(dt);
        this.applyWallPalmSolidContact();
        this.syncPlayerFromPhysicsBody();
      }
      this.applyPalmRigSupport();
      this.dampPalmPlantedBody();
      if (window.VRDriftPalmBall) window.VRDriftPalmBall.enforcePalmsAboveFloor();
      if (window.VRDriftPalmBall) {
        window.VRDriftPalmBall.snapPalmsToHands(
          this.getHandColliderPose.bind(this),
          this.leftHand,
          this.rightHand,
          (key) => this.palmOnDriftFloor(key, false)
        );
      }
      this.syncPlayerFromPhysicsBody();
      this.constrainBodyToFloor();
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
    tickOrder: 2,
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
