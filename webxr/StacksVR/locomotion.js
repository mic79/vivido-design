// locomotion.js — thumbstick move + comfort snap-turn for StacksVR
(function () {
  'use strict';

  AFRAME.registerComponent('stick-locomotion', {
    schema: {
      speed: { type: 'number', default: 1.6 },
      snapDegrees: { type: 'number', default: 45 },
      snapDeadzone: { type: 'number', default: 0.7 },
      moveDeadzone: { type: 'number', default: 0.15 }
    },

    init: function () {
      this._lx = 0;
      this._ly = 0;
      this._rx = 0;
      this._snapReady = true;
      this._fwd = new THREE.Vector3();
      this._right = new THREE.Vector3();
      this._quat = new THREE.Quaternion();
      this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
      this._camBefore = new THREE.Vector3();
      this._camAfter = new THREE.Vector3();

      var self = this;
      this._onStick = function (evt) {
        var hand = evt.target;
        if (!hand || !hand.id) return;
        var d = evt.detail || {};
        var x = d.x || 0;
        var y = d.y || 0;
        if (hand.id === 'leftHand') {
          self._lx = x;
          self._ly = y;
        } else if (hand.id === 'rightHand') {
          self._rx = x;
        }
      };
      // Listen on scene + hands — laser/hand-controls can swallow scene bubbling
      this.el.sceneEl.addEventListener('thumbstickmoved', this._onStick);
      var selfBind = this;
      setTimeout(function bindHands() {
        var lh = document.getElementById('leftHand');
        var rh = document.getElementById('rightHand');
        if (lh) lh.addEventListener('thumbstickmoved', selfBind._onStick);
        if (rh) rh.addEventListener('thumbstickmoved', selfBind._onStick);
        if (!lh || !rh) setTimeout(bindHands, 400);
      }, 100);
    },

    remove: function () {
      if (this.el.sceneEl) {
        this.el.sceneEl.removeEventListener('thumbstickmoved', this._onStick);
      }
      var lh = document.getElementById('leftHand');
      var rh = document.getElementById('rightHand');
      if (lh) lh.removeEventListener('thumbstickmoved', this._onStick);
      if (rh) rh.removeEventListener('thumbstickmoved', this._onStick);
    },

    tick: function (t, dt) {
      if (window.isSpectator) return;
      var ms = Math.min(dt || 16, 50) / 1000;
      var cam = document.getElementById('camera');
      if (!cam) return;

      var dz = this._moveDeadened(this._ly);
      var dx = this._moveDeadened(this._lx);
      if (dx !== 0 || dz !== 0) {
        cam.object3D.getWorldQuaternion(this._quat);
        this._euler.setFromQuaternion(this._quat, 'YXZ');
        var yaw = this._euler.y;
        this._fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));
        var dist = this.data.speed * ms;
        this.el.object3D.position.addScaledVector(this._fwd, -dz * dist);
        this.el.object3D.position.addScaledVector(this._right, dx * dist);
      }

      if (Math.abs(this._rx) < this.data.snapDeadzone) {
        this._snapReady = true;
      } else if (this._snapReady) {
        var sign = this._rx > 0 ? -1 : 1;
        this._comfortSnap(THREE.MathUtils.degToRad(this.data.snapDegrees) * sign);
        this._snapReady = false;
      }
    },

    // Rotate around the headset, not the player-entity origin (avoids orbit when cam ≠ origin)
    _comfortSnap: function (deltaRad) {
      var cam = document.getElementById('camera');
      if (!cam) {
        this.el.object3D.rotation.y += deltaRad;
        return;
      }
      cam.object3D.getWorldPosition(this._camBefore);
      this.el.object3D.rotation.y += deltaRad;
      this.el.object3D.updateMatrixWorld(true);
      cam.object3D.getWorldPosition(this._camAfter);
      this.el.object3D.position.x += this._camBefore.x - this._camAfter.x;
      this.el.object3D.position.z += this._camBefore.z - this._camAfter.z;
    },

    _moveDeadened: function (v) {
      var dead = this.data.moveDeadzone;
      if (Math.abs(v) < dead) return 0;
      var s = (Math.abs(v) - dead) / (1 - dead);
      return Math.sign(v) * Math.min(1, s);
    }
  });
})();
