/**
 * VRdrift2 locomotion — body ball + palm ball-wheels (Box3D).
 * Skate: inverse tracked-palm delta while palm spheres are planted on the floor.
 */
(function () {
  'use strict';

  const C = () => window.VRDRIFT || {};
  const Col = () => window.VRDriftCollision;

  const _palm = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _n = new THREE.Vector3();
  const _rel = new THREE.Vector3();
  const _handDown = new THREE.Vector3();
  const _track = new THREE.Vector3();
  const _localPalm = new THREE.Vector3();
  const _playerQuat = new THREE.Quaternion();
  const _invPlayer = new THREE.Matrix4();

  AFRAME.registerComponent('drift-locomotion', {
    schema: {
      color: { type: 'color', default: '#44aaff' },
      rotationSpeed: { type: 'number', default: 2.2 }
    },

    init: function () {
      this.phys = null;
      this.rig = null;
      this.camera = null;
      this.leftHand = null;
      this.rightHand = null;
      this.rotationY = 0;
      this.thumbstickRotation = { left: 0, right: 0 };
      this.thrusterActive = { left: false, right: false };
      this.grabbing = { left: false, right: false };
      this.gripHeld = { left: false, right: false };
      this.braking = { left: false, right: false };
      this.railGrip = null;
      this._spawned = false;
      this._vrActive = false;
      this._thrustLeft = false;
      this._thrustRight = false;
      this._debugBall = null;
      this._speedHud = null;
      this._palmSkateActive = false;
      this._palmWallPush = false;
      this._palmDrivePush = false;

      this.lastPalmPos = {
        left: new THREE.Vector3(),
        right: new THREE.Vector3()
      };
      this.lastPalmLocal = {
        left: new THREE.Vector3(),
        right: new THREE.Vector3()
      };
      this.palmDelta = {
        left: new THREE.Vector3(),
        right: new THREE.Vector3()
      };
      this.palmDeltaSmooth = {
        left: new THREE.Vector3(),
        right: new THREE.Vector3()
      };
      this.handVel = {
        left: new THREE.Vector3(),
        right: new THREE.Vector3()
      };
      this._palmReady = { left: false, right: false };
      this.palmTouch = { left: null, right: null };
      this._openFloorWasContact = { left: false, right: false };
      this._floorSwipeActive = { left: false, right: false };
      this._floorGripWasContact = { left: false, right: false };
      this._wallPlantWasContact = { left: false, right: false };
      this._floorLostFrames = { left: 0, right: 0 };
      this._wallLostFrames = { left: 0, right: 0 };

      this.el.sceneEl.addEventListener('drift-physics-ready', () => this.onPhysicsReady());
      this.el.sceneEl.addEventListener('enter-vr', () => {
        this._vrActive = true;
        this.ensureHandsVisible();
        this.applyRigOffset();
        this.snapToHeadset();
        window.setTimeout(() => this.snapToHeadset(), 150);
      });
      this.el.sceneEl.addEventListener('exit-vr', () => {
        this._vrActive = false;
      });
      if (window.DriftPhys?.ready) this.onPhysicsReady();
    },

    onPhysicsReady: function () {
      if (this._spawned) return;
      this.phys = window.DriftPhys;
      this.rig = document.querySelector('#rig');
      this.camera = document.querySelector('#camera');
      this.leftHand = document.querySelector('#leftHand');
      this.rightHand = document.querySelector('#rightHand');
      this._speedHud = document.querySelector('#hud-speed');
      this.setupInput();
      this.ensureDebugBall();
      this.ensureHandsVisible();
      this.applyRigOffset();

      const start = this.el.object3D.position;
      const floorY = this.phys.sampleFloorY(start.x, start.y + 2, start.z);
      const y = (floorY != null ? floorY : 0) + C().BODY_BALL_RADIUS;
      this.phys.createPlayerBall(start.x, y, start.z);
      window.VRDriftPalmBall.init();
      this._spawned = true;
      this.bindThrusterButtons();
      this.syncPlayerFromBody();
      console.log('[VRdrift2] Body + palm wheels spawned');
    },

    ensureHandsVisible: function () {
      [this.leftHand, this.rightHand].forEach((h) => {
        if (h) h.setAttribute('visible', true);
      });
    },

    applyRigOffset: function () {
      if (!this.rig) return;
      this.rig.object3D.position.y = C().RIG_Y_OFFSET || 0;
    },

    menuBlocks: function () {
      return !!(window.VRDriftUI && window.VRDriftUI.isMenuOpen && window.VRDriftUI.isMenuOpen());
    },

    isVrActive: function () {
      const scene = this.el.sceneEl;
      return !!(scene.is('vr-mode') || scene.is('ar-mode') || this._vrActive);
    },

    isRailGrabActive: function () {
      return !!this.railGrip;
    },

    ensureDebugBall: function () {
      let ball = document.querySelector('#body-ball-visual');
      if (!ball) {
        ball = document.createElement('a-entity');
        ball.setAttribute('id', 'body-ball-visual');
        this.el.sceneEl.appendChild(ball);
        const THREE = AFRAME.THREE;
        const r = C().BODY_BALL_RADIUS;
        const geo = new THREE.SphereGeometry(r, 28, 20);
        let mat;
        if (window.VRDriftSoccerTexture) {
          mat = window.VRDriftSoccerTexture.create(THREE, this.data.color).material;
          mat.transparent = true;
          mat.opacity = 0.5;
        } else {
          mat = new THREE.MeshStandardMaterial({
            color: this.data.color,
            transparent: true,
            opacity: 0.4
          });
        }
        ball.setObject3D('mesh', new THREE.Mesh(geo, mat));
      }
      this._debugBall = ball;
    },

    setupInput: function () {
      const bindHand = (handEl, side) => {
        if (!handEl) return;
        handEl.addEventListener('gripdown', () => this.onGrip(side, true));
        handEl.addEventListener('gripup', () => this.onGrip(side, false));
        handEl.addEventListener('thumbstickmoved', (e) => {
          const x = e.detail && e.detail.x;
          if (x == null) return;
          if (side === 'right') {
            this.thumbstickRotation.right = Math.abs(x) > 0.12 ? -x : 0;
          } else {
            this.thumbstickRotation.left = Math.abs(x) > 0.12 ? -x : 0;
          }
        });
      };
      bindHand(this.leftHand, 'left');
      bindHand(this.rightHand, 'right');
    },

    bindThrusterButtons: function () {
      const bind = (el, side) => {
        if (!el || el._driftThrustBound) return;
        el._driftThrustBound = true;
        const set = (v) => {
          if (side === 'left') {
            this._thrustLeft = v;
            this.thrusterActive.left = v;
          } else {
            this._thrustRight = v;
            this.thrusterActive.right = v;
          }
        };
        el.addEventListener('ybuttondown', () => set(true));
        el.addEventListener('ybuttonup', () => set(false));
        el.addEventListener('bbuttondown', () => set(true));
        el.addEventListener('bbuttonup', () => set(false));
      };
      bind(this.leftHand, 'left');
      bind(this.rightHand, 'right');
    },

    onGrip: function (side, down) {
      this.gripHeld[side] = down;
      this.braking[side] = !!down;
      if (down) this.tryStartGrip(side);
      else this.releaseGrip(side);
    },

    tryStartGrip: function (side) {
      const palmEl = document.querySelector(side === 'left' ? '#left-palm' : '#right-palm');
      if (!palmEl) return;
      palmEl.object3D.getWorldPosition(_palm);
      const grips = document.querySelectorAll('[drift-grip]');
      let best = null;
      let bestD = C().GRIP_ATTACH_DIST || 0.22;
      grips.forEach((el) => {
        el.object3D.getWorldPosition(_tmp);
        const d = _tmp.distanceTo(_palm);
        if (d < bestD) {
          bestD = d;
          best = el;
        }
      });
      // Rail attach when near a grip. Surface grab hauls via applySurfaceGripPull.
      if (best) {
        this.railGrip = { side, el: best };
        this.grabbing[side] = true;
        this.phys.setPlayerVelocity(0, 0, 0);
      }
    },

    releaseGrip: function (side) {
      this.braking[side] = false;
      this.grabbing[side] = false;
      if (this.railGrip && this.railGrip.side === side) this.railGrip = null;
    },

    /** Grip + palm planted on floor/wall → hand is an anchor on that surface. */
    palmSurfaceGripActive: function (side) {
      if (!this.gripHeld[side] || !window.VRDriftPalmBall) return false;
      return (
        window.VRDriftPalmBall.hadFloorContact(side) ||
        window.VRDriftPalmBall.hadWallContact(side)
      );
    },

    /**
     * Grip on a planted surface: velocity-dependent brake, then haul/crawl once slow.
     * Fast → shed speed at FLOOR_GRIP_MAX_DECEL. Already slow → snap stop.
     * Moving the controller while locked hauls the rig opposite the hand.
     */
    applySurfaceGripPull: function (dt) {
      if (!this.phys?.playerBody || !dt || this.isRailGrabActive()) return;

      let gripping = false;
      ['left', 'right'].forEach((key) => {
        if (this.palmSurfaceGripActive(key)) gripping = true;
        else this._floorGripWasContact[key] = false;
      });
      if (!gripping) return;

      const vel = this.phys.getPlayerVelocity();
      const speed = Math.hypot(vel.x, vel.y, vel.z);
      const crawl =
        C().FLOOR_GRIP_FULL_COUPLE_SPEED != null
          ? C().FLOOR_GRIP_FULL_COUPLE_SPEED
          : 1.35;
      const maxDecel =
        C().FLOOR_GRIP_MAX_DECEL != null ? C().FLOOR_GRIP_MAX_DECEL : 16;

      // Velocity-dependent brake: instant lock when already slow, else shed m/s²
      if (speed > 1e-4) {
        if (speed <= crawl) {
          this.phys.setPlayerVelocity(0, 0, 0);
        } else {
          const shed = maxDecel * dt;
          const scale = Math.max(0, (speed - shed) / speed);
          this.phys.setPlayerVelocity(vel.x * scale, vel.y * scale, vel.z * scale);
        }
        this._palmSkateActive = true;
      }

      // Crawl/haul only once you're slow enough to "hold on"
      const speedNow = Math.hypot(
        this.phys.getPlayerVelocity().x,
        this.phys.getPlayerVelocity().y,
        this.phys.getPlayerVelocity().z
      );
      if (speedNow > crawl) return;

      const maxStep = C().PALM_CONTACT_MAX_STEP != null ? C().PALM_CONTACT_MAX_STEP : 0.12;
      const maxDelta = C().PALM_DELTA_MAX != null ? C().PALM_DELTA_MAX : 0.14;
      const couple = C().PALM_CONTACT_COUPLING != null ? C().PALM_CONTACT_COUPLING : 1.25;
      const minHaul =
        C().PALM_GRIP_HAUL_MIN != null ? C().PALM_GRIP_HAUL_MIN : 0.004;

      let sx = 0;
      let sy = 0;
      let sz = 0;
      let n = 0;

      ['left', 'right'].forEach((key) => {
        if (!this.palmSurfaceGripActive(key)) return;
        if (!this._palmReady[key]) return;
        window.VRDriftPalmBall.getStaticContactNormal(key, _n);
        if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
        else _n.normalize();

        _rel.copy(this.palmDelta[key]);
        if (_rel.lengthSq() < 1e-10) _rel.copy(this.palmDeltaSmooth[key]);
        let dLen = _rel.length();
        if (dLen < minHaul) return;
        if (dLen > maxDelta) {
          _rel.multiplyScalar(maxDelta / dLen);
          dLen = maxDelta;
        }

        const nd = _rel.dot(_n);
        _rel.addScaledVector(_n, -nd);

        sx += -_rel.x * couple;
        sy += -_rel.y * couple;
        sz += -_rel.z * couple;
        n++;
      });
      if (n < 1) return;
      sx /= n;
      sy /= n;
      sz /= n;
      let len = Math.hypot(sx, sy, sz);
      if (len < minHaul) return;
      if (len > maxStep) {
        const s = maxStep / len;
        sx *= s;
        sy *= s;
        sz *= s;
        len = maxStep;
      }

      const pos = this.phys.getPlayerPosition();
      if (this.phys.nudgePlayerPosition) this.phys.nudgePlayerPosition(sx, sy, sz);
      else this.phys.setPlayerPosition(pos.x + sx, pos.y + sy, pos.z + sz);
      if (dt > 1e-6) this.phys.setPlayerVelocity(sx / dt, sy / dt, sz / dt);
      this._palmSkateActive = true;
    },

    /**
     * Skate drive that conserves momentum:
     * - Adds impulse only along the swipe axis (never lerps to absolute swipe speed)
     * - Keeps the full perpendicular component (sideways→forward keeps side speed)
     * - Counter-swipe must overcome existing parallel speed; no instant reverse
     */
    applyMomentumSkateVelocity: function (vel, cvx, cvy, cvz, t, opts) {
      opts = opts || {};
      const keepY = opts.keepY !== false;
      let cx = cvx;
      let cy = keepY ? 0 : cvy;
      let cz = cvz;
      const cvLen = Math.hypot(cx, cy, cz);
      if (cvLen < 1e-6 || t < 1e-6) return;

      const dx = cx / cvLen;
      const dy = cy / cvLen;
      const dz = cz / cvLen;
      const vPar = vel.x * dx + vel.y * dy + vel.z * dz;
      const px = vel.x - dx * vPar;
      const py = vel.y - dy * vPar;
      const pz = vel.z - dz * vPar;

      const impulse =
        C().PALM_SKATE_IMPULSE != null ? C().PALM_SKATE_IMPULSE : 0.32;
      // Additive Δv along swipe — opposing momentum stays until eaten by swipes
      const add = cvLen * Math.min(1, t) * impulse;
      let newPar = vPar + add;
      const maxPar = C().MAX_SPEED != null ? C().MAX_SPEED : 11;
      if (newPar > maxPar) newPar = maxPar;
      if (newPar < -maxPar) newPar = -maxPar;

      const nx = px + dx * newPar;
      const ny = keepY ? vel.y : py + dy * newPar;
      const nz = pz + dz * newPar;
      this.phys.setPlayerVelocity(nx, ny, nz);
    },

    snapToHeadset: function () {
      if (!this.phys?.playerBody || !this.camera) return;
      this.camera.object3D.getWorldPosition(_tmp);
      const q = new THREE.Quaternion();
      this.camera.object3D.getWorldQuaternion(q);
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
      back.y = 0;
      if (back.lengthSq() > 1e-6) back.normalize().multiplyScalar(C().BODY_BACK_OFFSET || 0.15);
      const x = _tmp.x + back.x;
      const z = _tmp.z + back.z;
      const floorY = this.phys.sampleFloorY(x, _tmp.y, z);
      const y = (floorY != null ? floorY : 0) + C().BODY_BALL_RADIUS;
      this.phys.setPlayerPosition(x, y, z);
      this.phys.setPlayerVelocity(0, 0, 0);
      this.syncPlayerFromBody();
    },

    getTrackedPalmPos: function (hand, out) {
      out = out || new THREE.Vector3();
      const side = hand && hand.id === 'leftHand' ? 'left' : 'right';
      const palm = document.querySelector(side === 'left' ? '#left-palm' : '#right-palm');
      if (palm) {
        palm.object3D.updateMatrixWorld(true);
        palm.object3D.getWorldPosition(out);
        return out;
      }
      if (hand) {
        hand.object3D.updateMatrixWorld(true);
        hand.object3D.getWorldPosition(out);
      }
      return out;
    },

    getHandPoseForPalm: function (side) {
      const hand = side === 'left' ? this.leftHand : this.rightHand;
      if (!hand) return null;
      this.getTrackedPalmPos(hand, _track);
      const hv = this.handVel[side];
      const bv = this.phys?.playerBody
        ? this.phys.getPlayerVelocity()
        : { x: 0, y: 0, z: 0 };
      // handVel is player-relative; palms need world velocity
      return {
        x: _track.x,
        y: _track.y,
        z: _track.z,
        vx: hv.x + bv.x,
        vy: hv.y + bv.y,
        vz: hv.z + bv.z
      };
    },

    /**
     * Palm deltas in player-local space → world axes.
     * Excludes #player travel so coasting never looks like a swipe.
     */
    updateHandKinematics: function (dt) {
      if (!dt) return;
      this.el.object3D.updateMatrixWorld(true);
      _invPlayer.copy(this.el.object3D.matrixWorld).invert();
      this.el.object3D.getWorldQuaternion(_playerQuat);

      ['left', 'right'].forEach((key) => {
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;
        this.getTrackedPalmPos(hand, _palm);
        _localPalm.copy(_palm).applyMatrix4(_invPlayer);
        if (this._palmReady[key]) {
          this.palmDelta[key].subVectors(_localPalm, this.lastPalmLocal[key]);
          // Local delta → world direction (rotation only)
          this.palmDelta[key].applyQuaternion(_playerQuat);
          // EMA kills tracking micro-jitter that made skate velocity stutter
          const a = 1 - Math.exp(-28 * dt);
          this.palmDeltaSmooth[key].x += (this.palmDelta[key].x - this.palmDeltaSmooth[key].x) * a;
          this.palmDeltaSmooth[key].y += (this.palmDelta[key].y - this.palmDeltaSmooth[key].y) * a;
          this.palmDeltaSmooth[key].z += (this.palmDelta[key].z - this.palmDeltaSmooth[key].z) * a;
          this.handVel[key].copy(this.palmDeltaSmooth[key]).divideScalar(dt);
        } else {
          this.palmDelta[key].set(0, 0, 0);
          this.palmDeltaSmooth[key].set(0, 0, 0);
          this.handVel[key].set(0, 0, 0);
          this._palmReady[key] = true;
        }
        this.lastPalmLocal[key].copy(_localPalm);
        this.lastPalmPos[key].copy(_palm);
      });
    },

    /** Cancel world gravity while palms were planted — sit on the hand balls. */
    applyPalmFloorSupportForces: function () {
      if (!this.phys?.playerBody || this.isRailGrabActive()) return;
      let count = 0;
      ['left', 'right'].forEach((key) => {
        if (window.VRDriftPalmBall?.hadFloorContact(key)) count++;
      });
      if (count < 1) return;
      const g = C().GRAVITY != null ? C().GRAVITY : -3.2;
      const mass = C().MASS != null ? C().MASS : 55;
      this.phys.applyPlayerForce(0, -mass * g, 0);
    },

    zeroPlantedVerticalVelocity: function () {
      if (!this.phys?.playerBody) return;
      const v = this.phys.getPlayerVelocity();
      if (Math.abs(v.y) < 0.5) this.phys.setPlayerVelocity(v.x, 0, v.z);
    },

    /** Kill vertical jitter while palms are planted (not during jump/swipe). */
    dampPalmPlantedBody: function () {
      if (!this.phys?.playerBody || this._palmDrivePush || this._palmSkateActive) return;
      let planted = 0;
      ['left', 'right'].forEach((key) => {
        if (window.VRDriftPalmBall?.hadFloorContact(key)) planted++;
      });
      if (planted < 1) return;
      const v = this.phys.getPlayerVelocity();
      let vx = v.x;
      let vz = v.z;
      const horiz = Math.hypot(vx, vz);
      if (horiz < 0.08) {
        vx = 0;
        vz = 0;
      }
      this.phys.setPlayerVelocity(vx, 0, vz);
    },

    /**
     * Soft press into a planted surface → push the body off that surface.
     * Floor: lift up. Wall: shove away. Palms stay on the outside.
     */
    applyPalmRigSupport: function () {
      if (!this.phys?.playerBody || !window.VRDriftPalmBall || this.isRailGrabActive()) return;
      if (this._palmDrivePush || this._palmSkateActive) return;

      const tol =
        C().PALM_RIG_SUPPORT_TOLERANCE != null ? C().PALM_RIG_SUPPORT_TOLERANCE : 0.018;
      const maxStep =
        C().PALM_RIG_SUPPORT_MAX_STEP != null ? C().PALM_RIG_SUPPORT_MAX_STEP : 0.028;
      const blend =
        C().PALM_RIG_SUPPORT_BLEND != null ? C().PALM_RIG_SUPPORT_BLEND : 0.22;
      const inclineNy =
        C().PALM_FLOOR_SKATE_INCLINE_NY != null ? C().PALM_FLOOR_SKATE_INCLINE_NY : 0.92;
      const bodyR = C().BODY_BALL_RADIUS != null ? C().BODY_BALL_RADIUS : 0.24;

      const pos = this.phys.getPlayerPosition();
      let maxLiftY = 0;
      let pushX = 0;
      let pushY = 0;
      let pushZ = 0;
      let pushLen = 0;

      const floorY = this.phys.sampleFloorY(pos.x, pos.y + 2, pos.z);
      if (floorY != null) {
        const minBodyY = floorY + bodyR;
        if (pos.y < minBodyY - tol) maxLiftY = Math.max(maxLiftY, minBodyY - pos.y);
      }

      ['left', 'right'].forEach((key) => {
        const onFloor = window.VRDriftPalmBall.hadFloorContact(key);
        const onWall = window.VRDriftPalmBall.hadWallContact(key);
        if (!onFloor && !onWall) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand || !window.VRDriftPalmBall.getPalmWorldPosition(key, _tmp)) return;
        this.getTrackedPalmPos(hand, _track);
        window.VRDriftPalmBall.getStaticContactNormal(key, _n);
        if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
        else _n.normalize();

        const along =
          (_tmp.x - _track.x) * _n.x +
          (_tmp.y - _track.y) * _n.y +
          (_tmp.z - _track.z) * _n.z;
        if (along <= tol) return;

        if (onFloor && _n.y >= inclineNy) {
          maxLiftY = Math.max(maxLiftY, along);
        } else if (onWall || _n.y < inclineNy) {
          if (along > pushLen) {
            pushLen = along;
            pushX = _n.x * along;
            pushY = _n.y * along;
            pushZ = _n.z * along;
          }
        }
      });

      let applied = false;
      if (maxLiftY > tol) {
        const lift = Math.min(maxLiftY * blend, maxStep);
        if (this.phys.nudgePlayerPosition) this.phys.nudgePlayerPosition(0, lift, 0);
        else this.phys.setPlayerPosition(pos.x, pos.y + lift, pos.z);
        applied = true;
      }
      if (pushLen > tol) {
        const s = Math.min(pushLen * blend, maxStep) / pushLen;
        if (this.phys.nudgePlayerPosition) {
          this.phys.nudgePlayerPosition(pushX * s, pushY * s, pushZ * s);
        } else {
          const p2 = this.phys.getPlayerPosition();
          this.phys.setPlayerPosition(p2.x + pushX * s, p2.y + pushY * s, p2.z + pushZ * s);
        }
        applied = true;
      }
      if (applied) this.zeroPlantedVerticalVelocity();
    },

    /**
     * Palm skate:
     * - Open-hand plant: roll / freewheel (no freeze)
     * - Soft press into floor: lift via rig support (palms stay on deck)
     * - Swipe: proportional inverse delta (momentum-aware — no hard reverse)
     * - Strong quick slap-down: jump
     * - Grip on planted surface: hand anchors to ground; move controller → haul rig
     */
    applyPalmContactCoupling: function (dt) {
      if (!this.phys?.playerBody || !dt || !window.VRDriftPalmBall) return;
      if (this.isRailGrabActive()) return;

      const couple = C().PALM_CONTACT_COUPLING != null ? C().PALM_CONTACT_COUPLING : 1;
      const maxStep = C().PALM_CONTACT_MAX_STEP != null ? C().PALM_CONTACT_MAX_STEP : 0.055;
      const maxDelta = C().PALM_DELTA_MAX != null ? C().PALM_DELTA_MAX : 0.07;
      const minSkateTangent =
        C().PALM_FLOOR_SKATE_MIN_TANGENT != null ? C().PALM_FLOOR_SKATE_MIN_TANGENT : 0.018;
      const minSkateInto =
        C().PALM_FLOOR_SKATE_MIN_INTO != null ? C().PALM_FLOOR_SKATE_MIN_INTO : 0.003;
      const launchInto =
        C().PALM_FLOOR_LAUNCH_MIN_INTO != null ? C().PALM_FLOOR_LAUNCH_MIN_INTO : 0.028;
      const launchRatio =
        C().PALM_FLOOR_LAUNCH_INTO_RATIO != null ? C().PALM_FLOOR_LAUNCH_INTO_RATIO : 1.6;
      const launchHandSpeed =
        C().PALM_FLOOR_LAUNCH_HAND_SPEED != null ? C().PALM_FLOOR_LAUNCH_HAND_SPEED : 1.8;
      const minSkateDrive =
        C().PALM_FLOOR_SKATE_MIN_DRIVE != null ? C().PALM_FLOOR_SKATE_MIN_DRIVE : 0.02;
      const maxSkateDv =
        C().PALM_FLOOR_SKATE_MAX_DV != null ? C().PALM_FLOOR_SKATE_MAX_DV : 0.55;
      const steerBlend =
        C().PALM_FLOOR_SKATE_STEER_BLEND != null ? C().PALM_FLOOR_SKATE_STEER_BLEND : 0.22;
      const inclineNy =
        C().PALM_FLOOR_SKATE_INCLINE_NY != null ? C().PALM_FLOOR_SKATE_INCLINE_NY : 0.92;
      const inclineTang =
        C().PALM_FLOOR_SKATE_INCLINE_TANGENT != null ? C().PALM_FLOOR_SKATE_INCLINE_TANGENT : 0.01;
      const wallMaxStep = C().PALM_WALL_MAX_STEP != null ? C().PALM_WALL_MAX_STEP : 0.085;
      const wallMaxDv = C().PALM_WALL_SKATE_MAX_DV != null ? C().PALM_WALL_SKATE_MAX_DV : 9;
      const wallSteer =
        C().PALM_WALL_SKATE_STEER_BLEND != null ? C().PALM_WALL_SKATE_STEER_BLEND : 1;
      const wallCouple = C().PALM_WALL_COUPLE != null ? C().PALM_WALL_COUPLE : 1;
      const wallGap = C().PALM_WALL_TOUCH_GAP != null ? C().PALM_WALL_TOUCH_GAP : 0.008;
      const lostMax = 4;

      let sx = 0;
      let sy = 0;
      let sz = 0;
      let nActive = 0;
      let openFloorCoupled = false;
      let openPushInto = false;
      let openWallCoupled = false;
      let openWallPush = false;
      let nSumX = 0;
      let nSumY = 0;
      let nSumZ = 0;
      let nSumN = 0;
      let openFloorPlanted = false;

      this._palmSkateActive = false;
      this._palmWallPush = false;

      ['left', 'right'].forEach((key) => {
        if (!this._palmReady[key]) return;
        const hand = key === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return;

        if (window.VRDriftPalmBall.hadFloorContact(key)) {
          this._floorLostFrames[key] = 0;
          window.VRDriftPalmBall.getStaticContactNormal(key, _n);
          const onFloorPlant = _n.y >= 0.35;
          if (!onFloorPlant) return;

          if (window.VRDriftPalmBall.hadGameContact(key)) {
            openFloorPlanted = true;
            return;
          }

          // Grip on planted surface = haul/crawl (handled in applySurfaceGripPull)
          if (this.palmSurfaceGripActive(key)) {
            openFloorPlanted = true;
            return;
          }

          if (!this._openFloorWasContact[key]) {
            this._openFloorWasContact[key] = true;
            this.el.object3D.updateMatrixWorld(true);
            _invPlayer.copy(this.el.object3D.matrixWorld).invert();
            this.getTrackedPalmPos(hand, _palm);
            this.lastPalmLocal[key].copy(_palm).applyMatrix4(_invPlayer);
            this.lastPalmPos[key].copy(_palm);
            this.palmDelta[key].set(0, 0, 0);
            this.palmDeltaSmooth[key].set(0, 0, 0);
            openFloorPlanted = true;
            return;
          }
          openFloorPlanted = true;

          const inclineWalk = _n.y < inclineNy;
          nSumX += _n.x;
          nSumY += _n.y;
          nSumZ += _n.z;
          nSumN++;

          const tangGate = inclineWalk ? inclineTang : minSkateTangent;

          // Smoothed player-relative delta — do NOT subtract v*dt
          _rel.copy(this.palmDeltaSmooth[key]);
          let dLen = _rel.length();
          if (dLen > maxDelta && dLen > 1e-8) {
            _rel.multiplyScalar(maxDelta / dLen);
            dLen = maxDelta;
          }
          const handInto = -_rel.dot(_n);
          const nd = _rel.dot(_n);
          const tangLen = Math.hypot(
            _rel.x - _n.x * nd,
            _rel.y - _n.y * nd,
            _rel.z - _n.z * nd
          );
          // Idle plant — freewheel. Do not touch player velocity.
          if (tangLen < tangGate && handInto < minSkateInto) return;

          const hv = this.handVel[key];
          const handSpeed = hv.length();
          const slapDown =
            handInto >= launchInto &&
            handInto >= tangLen * launchRatio &&
            handSpeed >= launchHandSpeed;
          if (slapDown) openPushInto = true;

          let mx = -_rel.x * couple;
          let my = -_rel.y * couple;
          let mz = -_rel.z * couple;
          // Soft press / swipe: strip launch normal (lift comes from rig support)
          if (!slapDown) {
            const intoStep = mx * _n.x + my * _n.y + mz * _n.z;
            if (intoStep > 0) {
              mx -= _n.x * intoStep;
              my -= _n.y * intoStep;
              mz -= _n.z * intoStep;
            }
          }
          const floorRigInto = mx * _n.x + my * _n.y + mz * _n.z;
          if (floorRigInto < 0) {
            mx -= _n.x * floorRigInto;
            my -= _n.y * floorRigInto;
            mz -= _n.z * floorRigInto;
          }
          sx += mx;
          sy += my;
          sz += mz;
          nActive++;
          openFloorCoupled = true;
          return;
        }

        this._floorLostFrames[key] = (this._floorLostFrames[key] || 0) + 1;
        if (this._floorLostFrames[key] > lostMax) {
          this._openFloorWasContact[key] = false;
          this._floorGripWasContact[key] = false;
          this._floorSwipeActive[key] = false;
        }

        if (!Col()) return;
        this.getTrackedPalmPos(hand, _track);
        const r = (C().PALM_SPHERE_RADIUS != null ? C().PALM_SPHERE_RADIUS : 0.05) + wallGap;
        let best = null;
        let bestD = wallGap;
        // Prefer real palm-ball wall contact; fall back to geometric probe
        const palmWall = window.VRDriftPalmBall.hadWallContact(key);
        if (palmWall) {
          window.VRDriftPalmBall.getStaticContactNormal(key, _n);
          best = true;
        } else {
          Col()
            .querySurfaces('[drift-surface]')
            .forEach((el) => {
              if (el.hasAttribute('drift-floor')) return;
              const d = Col().distanceToSurface(_track, r, el);
              if (d != null && d < bestD) {
                bestD = d;
                best = el;
              }
            });
          if (best) _n.copy(Col().getSurfaceNormal(_track, best));
        }
        if (!best) {
          this._wallLostFrames[key] = (this._wallLostFrames[key] || 0) + 1;
          if (this._wallLostFrames[key] > lostMax) this._wallPlantWasContact[key] = false;
          return;
        }

        this._wallLostFrames[key] = 0;
        if (!this._wallPlantWasContact[key]) {
          this._wallPlantWasContact[key] = true;
          this.el.object3D.updateMatrixWorld(true);
          _invPlayer.copy(this.el.object3D.matrixWorld).invert();
          this.getTrackedPalmPos(hand, _palm);
          this.lastPalmLocal[key].copy(_palm).applyMatrix4(_invPlayer);
          this.lastPalmPos[key].copy(_palm);
          this.palmDelta[key].set(0, 0, 0);
          this.palmDeltaSmooth[key].set(0, 0, 0);
          return;
        }

        if (_n.lengthSq() > 1e-8) _n.normalize();
        else return;

        // Grip on wall plant = haul (applySurfaceGripPull), not skate
        if (this.palmSurfaceGripActive(key)) return;

        // Same freewheel gates as floor — idle plant must not touch velocity
        _rel.copy(this.palmDeltaSmooth[key]);
        let dLen = _rel.length();
        if (dLen > maxDelta && dLen > 1e-8) {
          _rel.multiplyScalar(maxDelta / dLen);
          dLen = maxDelta;
        }
        const handInto = -_rel.dot(_n);
        const nd = _rel.dot(_n);
        const tangLen = Math.hypot(
          _rel.x - _n.x * nd,
          _rel.y - _n.y * nd,
          _rel.z - _n.z * nd
        );
        if (tangLen < minSkateTangent && handInto < minSkateInto) return;
        if (handInto >= launchInto && handInto >= tangLen * launchRatio) {
          const hv = this.handVel[key];
          if (hv.length() >= launchHandSpeed * 0.75) openWallPush = true;
        }

        openWallCoupled = true;
        nSumX += _n.x;
        nSumY += _n.y;
        nSumZ += _n.z;
        nSumN++;

        let mx = -_rel.x * wallCouple;
        let my = -_rel.y * wallCouple;
        let mz = -_rel.z * wallCouple;
        // Swipe along wall: strip into-normal (push-off keeps it)
        if (!openWallPush) {
          const intoStep = mx * _n.x + my * _n.y + mz * _n.z;
          if (intoStep > 0) {
            mx -= _n.x * intoStep;
            my -= _n.y * intoStep;
            mz -= _n.z * intoStep;
          }
        }
        const wallRigInto = mx * _n.x + my * _n.y + mz * _n.z;
        if (wallRigInto < 0) {
          mx -= _n.x * wallRigInto;
          my -= _n.y * wallRigInto;
          mz -= _n.z * wallRigInto;
        }
        sx += mx;
        sy += my;
        sz += mz;
        nActive++;
      });

      if (nActive < 1) {
        this._palmDrivePush = false;
        return;
      }
      sx /= nActive;
      sy /= nActive;
      sz /= nActive;
      let len = Math.hypot(sx, sy, sz);
      if (len < 1e-8) return;
      const stepCap = openWallCoupled && !openFloorCoupled ? wallMaxStep : maxStep;
      if (len > stepCap) {
        const s = stepCap / len;
        sx *= s;
        sy *= s;
        sz *= s;
        len = stepCap;
      }

      const pos = this.phys.getPlayerPosition();
      const vel = this.phys.getPlayerVelocity();

      if (openPushInto && openFloorCoupled) {
        // Strong quick slap-down → jump
        this.phys.setPlayerPosition(pos.x + sx, pos.y + sy, pos.z + sz);
        if (dt > 1e-6) this.phys.setPlayerVelocity(sx / dt, sy / dt, sz / dt);
        this._palmSkateActive = true;
        this._palmDrivePush = true;
      } else if (openWallCoupled && !openFloorCoupled) {
        if (nSumN > 0) {
          let nx = nSumX / nSumN;
          let ny = nSumY / nSumN;
          let nz = nSumZ / nSumN;
          const nLen = Math.hypot(nx, ny, nz) || 1;
          nx /= nLen;
          ny /= nLen;
          nz /= nLen;
          if (!openWallPush) {
            const nd = sx * nx + sy * ny + sz * nz;
            sx -= nx * nd;
            sy -= ny * nd;
            sz -= nz * nd;
            len = Math.hypot(sx, sy, sz);
          }
        }
        if (openWallPush && len >= minSkateInto && dt > 1e-6) {
          // Deliberate push into wall → launch off (same idea as floor slap)
          this.phys.setPlayerPosition(pos.x + sx, pos.y + sy, pos.z + sz);
          this.phys.setPlayerVelocity(sx / dt, sy / dt, sz / dt);
          this._palmSkateActive = true;
          this._palmDrivePush = true;
          this._palmWallPush = true;
        } else if (len >= minSkateDrive && dt > 1e-6) {
          // Wall swipe: soft skate along the wall (momentum-aware)
          let cvx = sx / dt;
          let cvy = sy / dt;
          let cvz = sz / dt;
          const cvLen = Math.hypot(cvx, cvy, cvz);
          if (cvLen > wallMaxDv) {
            const s = wallMaxDv / cvLen;
            cvx *= s;
            cvy *= s;
            cvz *= s;
          }
          // Mild follow → impulse scale; never an absolute velocity retarget
          const follow = 1 - Math.exp(-(5 + wallSteer * 7) * dt);
          const t = Math.min(1, follow);
          this.applyMomentumSkateVelocity(vel, cvx, cvy, cvz, t, { keepY: false });
          this._palmSkateActive = true;
        } else if (nSumN > 0) {
          // Idle wall plant: strip into-wall velocity only — keep coasting
          let nx = nSumX / nSumN;
          let ny = nSumY / nSumN;
          let nz = nSumZ / nSumN;
          const nLen = Math.hypot(nx, ny, nz) || 1;
          nx /= nLen;
          ny /= nLen;
          nz /= nLen;
          const vn = vel.x * nx + vel.y * ny + vel.z * nz;
          if (vn < -0.02) {
            this.phys.setPlayerVelocity(
              vel.x - nx * vn,
              vel.y - ny * vn,
              vel.z - nz * vn
            );
          }
        }
      } else if (openFloorCoupled) {
        // Floor swipe: gentle steer-blend toward tangent drive (proportional)
        if (nSumN > 0) {
          let nx = nSumX / nSumN;
          let ny = nSumY / nSumN;
          let nz = nSumZ / nSumN;
          const nLen = Math.hypot(nx, ny, nz) || 1;
          nx /= nLen;
          ny /= nLen;
          nz /= nLen;
          const nd = sx * nx + sy * ny + sz * nz;
          sx -= nx * nd;
          sy -= ny * nd;
          sz -= nz * nd;
          len = Math.hypot(sx, sy, sz);
        }
        if (len >= minSkateDrive && dt > 1e-6) {
          let cvx = sx / dt;
          let cvy = sy / dt;
          let cvz = sz / dt;
          const cvLen = Math.hypot(cvx, cvy, cvz);
          if (cvLen > maxSkateDv) {
            const s = maxSkateDv / cvLen;
            cvx *= s;
            cvy *= s;
            cvz *= s;
          }
          if (cvLen > 1e-6) {
            const follow = 1 - Math.exp(-(5 + steerBlend * 7) * dt);
            const t = Math.min(1, follow);
            this.applyMomentumSkateVelocity(vel, cvx, 0, cvz, t, { keepY: true });
            this._palmSkateActive = true;
          }
        }
      }

      this._palmDrivePush = openPushInto && this.phys.getPlayerVelocity().y > 0.12;
      if (!this._palmDrivePush) this._palmDrivePush = !!this._palmWallPush;

      if (openFloorCoupled && !openPushInto) this.zeroPlantedVerticalVelocity();
    },

    /** Surface grab uses applySurfaceGripPull; rails use railGrip. */
    applyBrakes: function () {},

    applyRailGrip: function () {
      if (!this.railGrip) return;
      const palmEl = document.querySelector(
        this.railGrip.side === 'left' ? '#left-palm' : '#right-palm'
      );
      if (!palmEl) return;
      palmEl.object3D.getWorldPosition(_palm);
      this.railGrip.el.object3D.getWorldPosition(_tmp);
      const pos = this.phys.getPlayerPosition();
      const ox = pos.x - (_palm.x - _tmp.x);
      const oy = pos.y - (_palm.y - _tmp.y) * 0.5;
      const oz = pos.z - (_palm.z - _tmp.z);
      const corr = 0.45;
      const dx = (ox - pos.x) * corr;
      const dy = (oy - pos.y) * corr;
      const dz = (oz - pos.z) * corr;
      this.phys.setPlayerPosition(pos.x + dx, pos.y + dy, pos.z + dz);
      this.phys.setPlayerVelocity(dx / 0.05, dy / 0.05, dz / 0.05);
    },

    applyThrusters: function () {
      if (this.railGrip || this.grabbing.left || this.grabbing.right) return;
      if (this.menuBlocks()) return;
      this.thrusterActive.left = !!this._thrustLeft;
      this.thrusterActive.right = !!this._thrustRight;
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (let i = 0; i < pads.length; i++) {
        const gp = pads[i];
        if (!gp) continue;
        if (gp.buttons[4]?.pressed) this.thrusterActive.left = true;
        if (gp.buttons[5]?.pressed) this.thrusterActive.right = true;
      }
      if (!this.thrusterActive.left && !this.thrusterActive.right) return;
      const force = C().THRUSTER_FORCE || 140;
      const run = (hand, active) => {
        if (!active || !hand) return;
        hand.object3D.updateMatrixWorld(true);
        _handDown.set(0, -1, 0).transformDirection(hand.object3D.matrixWorld).normalize();
        this.phys.applyPlayerForce(_handDown.x * force, _handDown.y * force, _handDown.z * force);
      };
      run(this.leftHand, this.thrusterActive.left);
      run(this.rightHand, this.thrusterActive.right);
    },

    applyThumbstickTurn: function (dt) {
      if (this.menuBlocks()) return;
      let input = this.thumbstickRotation.right;
      if (Math.abs(input) < 0.01) {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (let i = 0; i < pads.length; i++) {
          const gp = pads[i];
          if (!gp || !gp.axes) continue;
          const ax = gp.axes.length >= 3 ? gp.axes[2] : 0;
          if (Math.abs(ax) > Math.abs(input)) input = -ax;
        }
      }
      if (Math.abs(input) > 0.12) {
        this.rotationY += input * (this.data.rotationSpeed || 2.2) * dt;
      }
      if (this.rig) this.rig.object3D.rotation.y = this.rotationY;
    },

    clampSpeed: function () {
      const vel = this.phys.getPlayerVelocity();
      const sp = Math.hypot(vel.x, vel.y, vel.z);
      const max = C().MAX_SPEED || 11;
      if (sp > max) {
        const s = max / sp;
        this.phys.setPlayerVelocity(vel.x * s, vel.y * s, vel.z * s);
      }
    },

    /** Keep body ball spinning like a wheel from its linear velocity. */
    applyBodyBallRoll: function () {
      // Disabled while skating — forcing ω every frame fights the contact solver and chatters.
    },

    syncPlayerFromBody: function () {
      if (!this.phys?.playerBody) return;
      // Velocity-extrapolated visual pose — hides fixed-timestep hitching
      const p =
        typeof this.phys.getPlayerVisualPosition === 'function'
          ? this.phys.getPlayerVisualPosition()
          : this.phys.getPlayerPosition();
      this.el.object3D.position.set(p.x, p.y, p.z);
      this.applyRigOffset();
      this.el.object3D.updateMatrixWorld(true);

      if (this._debugBall) {
        const raw = this.phys.getPlayerPosition();
        this._debugBall.object3D.position.set(raw.x, raw.y, raw.z);
        const rot = this.phys.getPlayerRotation();
        if (rot && rot.v) {
          this._debugBall.object3D.quaternion.set(rot.v.x, rot.v.y, rot.v.z, rot.s);
        }
      }
    },

    getNetworkState: function () {
      const p = this.phys.getPlayerPosition();
      const v = this.phys.getPlayerVelocity();
      return {
        px: p.x,
        py: p.y,
        pz: p.z,
        ry: this.rotationY,
        vx: v.x,
        vy: v.y,
        vz: v.z,
        tl: !!this.thrusterActive.left,
        tr: !!this.thrusterActive.right
      };
    },

    /** Main simulation — after XR poses (order 1); Mixamo follows at order 2. */
    frame: function (timeDelta) {
      if (!this.phys?.ready || !this._spawned) return;
      const dt = Math.min(0.05, (timeDelta || 16) / 1000);
      const blocked = this.menuBlocks();
      const getPose = (side) => this.getHandPoseForPalm(side);

      this.updateHandKinematics(dt);
      window.VRDriftPalmBall.sync(dt, getPose);

      if (!blocked && this.isVrActive()) {
        this.applyThumbstickTurn(dt);
        this.applyRailGrip();
        this.applyThrusters();
        this.applyPalmFloorSupportForces();
      } else if (!blocked) {
        this.applyThumbstickTurn(dt);
      }

      this.phys.step(dt);
      window.VRDriftPalmBall.finishPhysicsStep();

      if (!blocked && this.isVrActive()) {
        this.applyPalmContactCoupling(dt);
        this.applySurfaceGripPull(dt);
        this.applyPalmRigSupport();
        this.dampPalmPlantedBody();
        this.applyBodyBallRoll();
      }

      if (window.VRDriftNet) window.VRDriftNet.applyAuthoritativeBall();
      this.clampSpeed();

      // Camera parent first, then keep world palms/debug glued to that motion
      this.syncPlayerFromBody();
      window.VRDriftPalmBall.snapPalmsToHands(getPose);
      window.VRDriftPalmBall.syncDebugMeshes();
      window.VRDriftPalmBall.driveGameBallFromBody(dt);
      window.VRDriftPalmBall.driveGameBallFromPalms(dt);

      if (window.VRDriftNet) window.VRDriftNet.tickLocal(this);

      if (this._speedHud) {
        const vel = this.phys.getPlayerVelocity();
        const sp = Math.hypot(vel.x, vel.y, vel.z);
        const skate = this._palmSkateActive ? ' · skate' : '';
        this._speedHud.setAttribute('text', 'value', sp.toFixed(1) + ' m/s' + skate);
      }
    },

    tick: function () {}
  });

  /**
   * After XR controller/camera pose updates. Mixamo (tickOrder 2) poses arms after this.
   */
  AFRAME.registerComponent('drift-locomotion-tick', {
    tickOrder: 1,
    tick: function (t, dtMs) {
      const player = document.querySelector('#player');
      const loco = player && player.components['drift-locomotion'];
      if (loco) loco.frame(dtMs);
    }
  });

  AFRAME.registerComponent('drift-thruster-vfx', {
    tick: function () {
      const loco = document.querySelector('#player');
      if (!loco || !loco.components['drift-locomotion']) return;
      const L = loco.components['drift-locomotion'];
      const lh = document.querySelector('#leftHand .thruster-vfx');
      const rh = document.querySelector('#rightHand .thruster-vfx');
      if (lh) lh.setAttribute('visible', !!(L.thrusterActive && L.thrusterActive.left));
      if (rh) rh.setAttribute('visible', !!(L.thrusterActive && L.thrusterActive.right));
    }
  });

  AFRAME.registerComponent('drift-remote', {
    schema: {
      color: { type: 'color', default: '#ff6644' },
      playerId: { type: 'string', default: '' }
    },
    init: function () {
      const col = new THREE.Color(this.data.color);
      const r = C().BODY_BALL_RADIUS || 0.24;
      this.el.setObject3D(
        'mesh',
        new THREE.Mesh(
          new THREE.SphereGeometry(r, 20, 14),
          new THREE.MeshStandardMaterial({
            color: col,
            emissive: col,
            emissiveIntensity: 0.25,
            transparent: true,
            opacity: 0.85
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
      this.el.object3D.position.lerp(this.target, Math.min(1, dt * 14));
      this.el.object3D.rotation.y = THREE.MathUtils.lerp(
        this.el.object3D.rotation.y,
        this.targetRot,
        dt * 10
      );
    }
  });
})();
