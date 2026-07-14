/**
 * Zero-G thruster locomotion for body-rigged4 (Box3D capsule mover).
 *
 * Feel / controls adapted from BattleVR / BoltVR / body-rigged-zerog2:
 *   Y / B buttons     — thrusters (force along controller -Y)
 *                       (X is reserved for grounded ↔ zero-g toggle)
 *   Left stick click  — look-direction boost
 *   Right stick click — airbrake (hold)
 *   Right stick X     — yaw the player rig (vr-locomotion, grounded + zero-g)
 *
 * Surface grab pull + release fling still come from mixamo-body / leg-ik-world;
 * this module consumes 3D release momentum via applyPushImpulse().
 */
(function () {
  'use strict';

  AFRAME.registerComponent('zerog-locomotion', {
    schema: {
      thrusterForce: { type: 'number', default: 0.8 },
      maxSpeed: { type: 'number', default: 8 },
      damping: { type: 'number', default: 0.996 },
      minVelocity: { type: 'number', default: 0.01 },
      boostForce: { type: 'number', default: 2.0 },
      brakeForce: { type: 'number', default: 0.92 },
      rotationSpeed: { type: 'number', default: 2.0 },
      boostCooldownMs: { type: 'number', default: 0 }
    },

    init: function () {
      this.velocity = new THREE.Vector3();
      this.thrusterActive = { left: false, right: false };
      this.isBraking = false;
      this._handQuat = new THREE.Quaternion();
      this._thrustDir = new THREE.Vector3();
      this._boostDir = new THREE.Vector3();
      this._moveDelta = { x: 0, y: 0, z: 0 };
      this._lastBoostTime = 0;
      this.enabled = false;

      this.camera = null;
      this.leftHand = null;
      this.rightHand = null;

      this._onBDown = () => {
        if (this._isGripPressed(this.rightHand)) return;
        this.thrusterActive.right = true;
      };
      this._onBUp = () => { this.thrusterActive.right = false; };
      // Left thruster on Y — X is gravity-mode toggle (gravity-mode.js).
      this._onYDown = () => { this.thrusterActive.left = true; };
      this._onYUp = () => { this.thrusterActive.left = false; };
      this._onStickMoved = (evt) => this._handleStickMoved(evt);
      this._onStickDown = (evt) => this._handleStickDown(evt);
      this._onStickUp = (evt) => this._handleStickUp(evt);
      this._onKeyDown = (evt) => this._handleKey(evt, true);
      this._onKeyUp = (evt) => this._handleKey(evt, false);

      const scene = this.el.sceneEl;
      scene.addEventListener('bbuttondown', this._onBDown);
      scene.addEventListener('bbuttonup', this._onBUp);
      scene.addEventListener('ybuttondown', this._onYDown);
      scene.addEventListener('ybuttonup', this._onYUp);
      scene.addEventListener('thumbstickmoved', this._onStickMoved);
      scene.addEventListener('thumbstickdown', this._onStickDown);
      scene.addEventListener('thumbstickup', this._onStickUp);
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);

      this._resolveRefs();
      scene.addEventListener('gravity-mode-changed', () => this._syncEnabled());
      this._syncEnabled();
    },

    remove: function () {
      const scene = this.el.sceneEl;
      if (!scene) return;
      scene.removeEventListener('bbuttondown', this._onBDown);
      scene.removeEventListener('bbuttonup', this._onBUp);
      scene.removeEventListener('ybuttondown', this._onYDown);
      scene.removeEventListener('ybuttonup', this._onYUp);
      scene.removeEventListener('thumbstickmoved', this._onStickMoved);
      scene.removeEventListener('thumbstickdown', this._onStickDown);
      scene.removeEventListener('thumbstickup', this._onStickUp);
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
    },

    _resolveRefs: function () {
      this.camera = this.el.querySelector('#camera') || document.querySelector('#camera');
      this.leftHand = this.el.querySelector('#left-hand') || document.querySelector('#left-hand');
      this.rightHand = this.el.querySelector('#right-hand') || document.querySelector('#right-hand');
    },

    _isGripPressed: function (handEl) {
      const gamepad = handEl?.components?.['tracked-controls']?.controller?.gamepad;
      const grip = gamepad?.buttons?.[1];
      return !!(grip && (grip.pressed || grip.value >= 0.45));
    },

    _syncEnabled: function () {
      this.enabled = !!(window.BodyRiggedGravity && window.BodyRiggedGravity.isZeroG());
    },

    isActive: function () {
      return this.enabled;
    },

    getVelocity: function () {
      return this.velocity;
    },

    /** Impart world-space velocity (grab push-off / fling / collisions). */
    applyPushImpulse: function (wx, wy, wz) {
      if (wx) this.velocity.x += wx;
      if (wy) this.velocity.y += wy;
      if (wz) this.velocity.z += wz;
      this._clampSpeed();
    },

    setVelocity: function (wx, wy, wz) {
      this.velocity.set(wx || 0, wy || 0, wz || 0);
      this._clampSpeed();
    },

    resetForEnterZeroG: function (legIk) {
      this._syncEnabled();
      this.velocity.set(0, 0, 0);
      if (legIk && legIk._grabMomentum) {
        // Carry any leftover horizontal fling into float velocity.
        this.velocity.x += legIk._grabMomentum.x || 0;
        this.velocity.z += legIk._grabMomentum.z || 0;
        this.velocity.y += legIk.playerVelY || 0;
        legIk._grabMomentum.set(0, 0, 0);
        legIk._grabMomentumActive = false;
        legIk.playerVelY = 0;
      }
      // Gentle lift so the capsule isn't glued to the floor when mode flips mid-stand.
      if (legIk?.physics?.playerGrounded && this.velocity.y < 0.35) {
        this.velocity.y = Math.max(this.velocity.y, 0.55);
      }
      if (legIk) {
        legIk.playerGrounded = false;
        if (legIk.physics) legIk.physics.playerGrounded = false;
      }
      this._clampSpeed();
    },

    resetForLeaveZeroG: function (legIk) {
      if (legIk) {
        legIk.playerVelY = this.velocity.y;
        if (legIk._grabMomentum) {
          legIk._grabMomentum.set(this.velocity.x, 0, this.velocity.z);
          legIk._grabMomentumActive = this.velocity.lengthSq() > 0.05;
        }
      }
      this.velocity.set(0, 0, 0);
      this.thrusterActive.left = false;
      this.thrusterActive.right = false;
      this.isBraking = false;
      this._syncEnabled();
    },

    _handleStickMoved: function (evt) {
      // Yaw handled by vr-locomotion (right stick / desktop Z-X).
    },

    _handleStickDown: function (evt) {
      if (!this.enabled) return;
      if (!evt.target || !evt.target.object3D) return;
      const isLeft = (evt.target.id || '') === 'left-hand';
      if (isLeft) this._doBoost();
      else this.isBraking = true;
    },

    _handleStickUp: function (evt) {
      if (!evt.target || !evt.target.object3D) return;
      const isLeft = (evt.target.id || '') === 'left-hand';
      if (!isLeft) this.isBraking = false;
    },

    _handleKey: function (evt, down) {
      if (!this.enabled) return;
      if (evt.repeat) return;
      const t = evt.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      // Desktop: Q/E thrusters · T boost · C brake (Z/X yaw → vr-locomotion)
      if (evt.code === 'KeyQ') this.thrusterActive.left = down;
      if (evt.code === 'KeyE') this.thrusterActive.right = down;
      if (evt.code === 'KeyC') this.isBraking = down;
      if (down && evt.code === 'KeyT') this._doBoost();
    },

    _doBoost: function () {
      if (!this.camera) this._resolveRefs();
      if (!this.camera) return;
      const now = performance.now();
      if (this.data.boostCooldownMs > 0 && now - this._lastBoostTime < this.data.boostCooldownMs) return;
      this._lastBoostTime = now;

      this._boostDir.set(0, 0, -1);
      this.camera.object3D.getWorldQuaternion(this._handQuat);
      this._boostDir.applyQuaternion(this._handQuat);
      this.velocity.addScaledVector(this._boostDir, this.data.boostForce);
      this._clampSpeed();
    },

    _clampSpeed: function () {
      const max = this.data.maxSpeed;
      if (this.velocity.length() > max) {
        this.velocity.normalize().multiplyScalar(max);
      }
      if (this.velocity.length() < this.data.minVelocity) {
        this.velocity.set(0, 0, 0);
      }
    },

    _applyThrusterFromHand: function (handEl, dt) {
      if (!handEl || !handEl.object3D) return;
      handEl.object3D.getWorldQuaternion(this._handQuat);
      this._thrustDir.set(0, -1, 0).applyQuaternion(this._handQuat);
      this.velocity.addScaledVector(this._thrustDir, this.data.thrusterForce * dt);
    },

    /**
     * Called from leg-ik-world._updatePlayerPhysics when gravity mode is zerog.
     * @param {number} dt seconds
     * @param {object} legIkComp leg-ik-world component
     */
    tickZeroG: function (dt, legIkComp) {
      if (!this.enabled) this._syncEnabled();
      if (!this.enabled || !legIkComp || !legIkComp.physics) return;
      if (!this.camera) this._resolveRefs();

      const physics = legIkComp.physics;
      const grabPullActive = !!legIkComp.grabPullLocomotionActive;

      // Thrusters & damping pause while actively yanking along a grab (pull owns pose).
      if (!grabPullActive) {
        if (this.thrusterActive.left) this._applyThrusterFromHand(this.leftHand, dt);
        if (this.thrusterActive.right) this._applyThrusterFromHand(this.rightHand, dt);

        if (this.isBraking) {
          this.velocity.multiplyScalar(this.data.brakeForce);
        } else {
          this.velocity.multiplyScalar(this.data.damping);
        }
        this._clampSpeed();
      }

      if (grabPullActive) {
        // Grab pull path already moved the capsule; keep our float vel for release.
        this._publishState(legIkComp, dt, true);
        return;
      }

      const cur = physics.getPlayerTranslation();
      this._moveDelta.x = this.velocity.x * dt;
      this._moveDelta.y = this.velocity.y * dt;
      this._moveDelta.z = this.velocity.z * dt;

      let pos = cur;
      if (
        Math.abs(this._moveDelta.x) + Math.abs(this._moveDelta.y) + Math.abs(this._moveDelta.z) > 1e-8
      ) {
        const moved = physics.movePlayer(this._moveDelta, { horizontalOnly: false });
        pos = moved.position;

        // Kill velocity component into blocked axes (simple slide response).
        const ax = moved.delta?.x ?? (pos.x - cur.x);
        const ay = moved.delta?.y ?? (pos.y - cur.y);
        const az = moved.delta?.z ?? (pos.z - cur.z);
        if (Math.abs(this._moveDelta.x) > 1e-6 && Math.abs(ax) < Math.abs(this._moveDelta.x) * 0.25) {
          this.velocity.x *= 0.15;
        }
        if (Math.abs(this._moveDelta.y) > 1e-6 && Math.abs(ay) < Math.abs(this._moveDelta.y) * 0.25) {
          this.velocity.y *= 0.15;
        }
        if (Math.abs(this._moveDelta.z) > 1e-6 && Math.abs(az) < Math.abs(this._moveDelta.z) * 0.25) {
          this.velocity.z *= 0.15;
        }
      }

      this.el.object3D.position.set(pos.x, pos.y, pos.z);
      physics.playerGrounded = false;
      legIkComp.playerGrounded = false;
      legIkComp.playerVelY = this.velocity.y;
      physics.playerVelY = this.velocity.y;

      this._publishState(legIkComp, dt, false);
    },

    _publishState: function (legIkComp, dt, grabbing) {
      const speed = this.velocity.length();
      if (legIkComp.scene?.legIkWorld) {
        legIkComp.scene.legIkWorld.isPlayerGrounded = false;
        legIkComp.scene.legIkWorld.playerSpeed = grabbing ? 0 : speed;
        if (legIkComp.scene.legIkWorld.playerMoveDir) {
          if (speed > 0.05 && !grabbing) {
            legIkComp.scene.legIkWorld.playerMoveDir.copy(this.velocity).normalize();
          } else {
            legIkComp.scene.legIkWorld.playerMoveDir.set(0, 0, 0);
          }
        }
      }
      if (legIkComp._syncPlayerRootPos) legIkComp._syncPlayerRootPos();
    }
  });
})();
