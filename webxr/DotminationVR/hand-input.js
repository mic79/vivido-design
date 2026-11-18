/*
 * hand-input.js — hands-only play (WebXR hand tracking) for DotminationVR and StacksVR.
 * Shared file: keep the copies in DotminationVR/ and StacksVR/ identical.
 *
 * A-Frame 1.7 binds its controller components to tracked hands but never updates their pose or
 * buttons (tracked-controls skips inputs that have `.hand`), so with hands only the #leftHand /
 * #rightHand entities freeze and no trigger ever fires. This system takes over for exactly
 * those inputs and leaves real controllers completely alone:
 *
 *   - drives #leftHand / #rightHand from the hand's grip pose (same frame tracked-controls uses);
 *   - points their raycaster along the hand's target ray (the system pointer ray);
 *   - pinch (thumb + index)        → triggerdown / triggerup  (grab, place, menu click);
 *   - fist (middle, ring, pinky)   → gripdown / gripup         (StacksVR cup);
 *   - a watch button on the back of the left wrist, tapped with the right index finger
 *                                  → xbuttondown on #leftHand (menu);
 *   - shows the tracked hand mesh and hides your own avatar body (others still see it);
 *   - exposes real finger curls so the networked finger sync follows your fingers.
 *
 * Disable with ?hands=0 in the URL.
 */
(function (global) {
  'use strict';

  if (typeof AFRAME === 'undefined') return;

  var params = new URLSearchParams(global.location.search);
  var ENABLED = params.get('hands') !== '0';

  var SIDES = ['left', 'right'];
  var ENTITY = { left: 'leftHand', right: 'rightHand' };

  var FINGER_JOINTS = {
    thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
    index: ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate',
      'index-finger-phalanx-distal', 'index-finger-tip'],
    middle: ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate',
      'middle-finger-phalanx-distal', 'middle-finger-tip'],
    ring: ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate',
      'ring-finger-phalanx-distal', 'ring-finger-tip'],
    pinky: ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate',
      'pinky-finger-phalanx-distal', 'pinky-finger-tip']
  };
  var FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];
  // Total bend (radians) that counts as fully curled
  var FULL_BEND = { thumb: 1.5, index: 3.6, middle: 3.8, ring: 3.8, pinky: 3.6 };

  var PINCH_ON = 0.018;   // thumb tip ↔ index tip (m)
  var PINCH_OFF = 0.032;
  var GRAB_ON = 0.62;     // mean curl of middle/ring/pinky
  var GRAB_OFF = 0.42;
  var WATCH_PRESS = 0.026; // right index tip ↔ watch button centre (m)
  var WATCH_REARM = 0.06;
  var WATCH_COOLDOWN_MS = 600;

  function newSide() {
    return {
      active: false,       // a tracked hand (not a controller) is the input for this side
      tracked: false,      // joints available this frame
      joints: {},          // name -> { p: Vector3, q: Quaternion } in rig-local (reference space) coords
      pinch: false,
      grab: false,
      curls: { thumb: 0.15, index: 0.2, middle: 0.25, ring: 0.3, pinky: 0.3 },
      savedRay: null,      // controller raycaster origin/direction to restore
      hiddenMeshes: []
    };
  }

  var api = {
    enabled: ENABLED,
    sides: { left: newSide(), right: newSide() },
    /** True when this side ('left' | 'right' | 'leftHand' | 'rightHand') is a tracked hand. */
    isHand: function (side) {
      side = side === 'leftHand' ? 'left' : side === 'rightHand' ? 'right' : side;
      var s = this.sides[side];
      return !!(s && s.active);
    },
    /** Any hand-only input active. */
    anyHand: function () { return this.sides.left.active || this.sides.right.active; },
    /** Finger curls {thumb..pinky} from the real joints, or null. */
    curls: function (side) {
      var s = this.sides[side];
      return s && s.active && s.tracked ? s.curls : null;
    },
    /** World position of a joint (e.g. 'index-finger-tip'), or null. */
    jointWorld: function (side, name, out) {
      side = side === 'leftHand' ? 'left' : side === 'rightHand' ? 'right' : side;
      var s = this.sides[side];
      var j = s && s.active && s.tracked && s.joints[name];
      var parent = rigParent(side);
      if (!j || !parent) return null;
      out = out || new THREE.Vector3();
      parent.updateWorldMatrix(true, false);
      return out.copy(j.p).applyMatrix4(parent.matrixWorld);
    }
  };
  global.HandInput = api;

  function rigParent(side) {
    var el = document.getElementById(ENTITY[side]);
    return el && el.object3D && el.object3D.parent;
  }

  var _v1 = new THREE.Vector3();
  var _v2 = new THREE.Vector3();
  var _v3 = new THREE.Vector3();
  var _m1 = new THREE.Matrix4();
  var _m2 = new THREE.Matrix4();
  var _q1 = new THREE.Quaternion();

  function fingerCurl(s, finger) {
    var names = FINGER_JOINTS[finger];
    var bend = 0;
    for (var i = 0; i + 2 < names.length; i++) {
      var a = s.joints[names[i]], b = s.joints[names[i + 1]], c = s.joints[names[i + 2]];
      if (!a || !b || !c) return null;
      _v1.subVectors(b.p, a.p);
      _v2.subVectors(c.p, b.p);
      if (_v1.lengthSq() < 1e-8 || _v2.lengthSq() < 1e-8) continue;
      bend += _v1.angleTo(_v2);
    }
    return Math.max(0, Math.min(1.2, bend / FULL_BEND[finger]));
  }

  AFRAME.registerSystem('hand-input', {
    init: function () {
      this.watch = null;
      this.watchArmed = true;
      this.watchLastAt = 0;
      this.meshEls = {};
      this.bodyHidden = false;
      var self = this;
      this.el.addEventListener('exit-vr', function () { self.deactivateAll(); });
      this.el.addEventListener('loaded', function () { self.ensureMeshes(); });
      if (this.el.hasLoaded) this.ensureMeshes();
    },

    // Tracked hand mesh (A-Frame hand-tracking-controls). It only shows while that hand is the
    // active input, so it never appears next to real controllers.
    ensureMeshes: function () {
      if (!ENABLED) return;
      var self = this;
      SIDES.forEach(function (side) {
        if (self.meshEls[side]) return;
        var hand = document.getElementById(ENTITY[side]);
        var parent = hand && hand.parentNode;
        if (!parent) return;
        var el = document.createElement('a-entity');
        el.id = side + 'HandMesh';
        el.setAttribute('hand-tracking-controls', { hand: side, modelStyle: 'mesh', modelColor: '#ffd9cc' });
        parent.appendChild(el);
        self.meshEls[side] = el;
      });
    },

    referenceSpace: function () {
      var tc = this.el.systems['tracked-controls'];
      if (tc && tc.referenceSpace) return tc.referenceSpace;
      var xr = this.el.renderer && this.el.renderer.xr;
      return xr && xr.getReferenceSpace ? xr.getReferenceSpace() : null;
    },

    tick: function (time) {
      if (!ENABLED) return;
      var scene = this.el;
      var frame = api._testFrame || scene.frame;
      var inVR = api._testFrame ? true : scene.is('vr-mode');
      if (!inVR || !frame) {
        if (api.anyHand()) this.deactivateAll();
        return;
      }
      var ref = api._testRef || this.referenceSpace();
      var session = frame.session;
      if (!ref || !session) return;

      var sources = session.inputSources || [];
      for (var k = 0; k < SIDES.length; k++) {
        var side = SIDES[k];
        var src = null;
        for (var i = 0; i < sources.length; i++) {
          if (sources[i].handedness === side) { src = sources[i]; break; }
        }
        var isHand = !!(src && src.hand);
        var st = api.sides[side];
        if (isHand && !st.active) this.activate(side);
        else if (!isHand && st.active) this.deactivate(side);
        if (isHand) this.updateSide(side, src, frame, ref);
      }

      this.updateBody();
      this.updateWatch(time);
    },

    activate: function (side) {
      var st = api.sides[side];
      st.active = true;
      st.pinch = false;
      st.grab = false;
      var hand = document.getElementById(ENTITY[side]);
      if (hand) {
        var rc = hand.components && hand.components.raycaster;
        if (rc && rc.data) {
          st.savedRay = {
            origin: { x: rc.data.origin.x, y: rc.data.origin.y, z: rc.data.origin.z },
            direction: { x: rc.data.direction.x, y: rc.data.direction.y, z: rc.data.direction.z }
          };
        }
      }
      this.el.emit('hand-input-changed', { side: side, active: true });
    },

    deactivate: function (side) {
      var st = api.sides[side];
      var hand = document.getElementById(ENTITY[side]);
      // Never leave a press hanging when tracking switches back to controllers
      if (hand) {
        if (st.pinch) hand.emit('triggerup', { handInput: true });
        if (st.grab) hand.emit('gripup', { handInput: true });
        var rc = hand.components && hand.components.raycaster;
        if (rc && rc.data && st.savedRay) {
          rc.data.origin.x = st.savedRay.origin.x; rc.data.origin.y = st.savedRay.origin.y; rc.data.origin.z = st.savedRay.origin.z;
          rc.data.direction.x = st.savedRay.direction.x; rc.data.direction.y = st.savedRay.direction.y;
          rc.data.direction.z = st.savedRay.direction.z;
          if (rc.updateOriginDirection) rc.updateOriginDirection();
        }
      }
      st.hiddenMeshes.forEach(function (o) { o.visible = true; });
      st.hiddenMeshes = [];
      st.active = false;
      st.tracked = false;
      st.pinch = false;
      st.grab = false;
      st.savedRay = null;
      this.el.emit('hand-input-changed', { side: side, active: false });
    },

    deactivateAll: function () {
      var self = this;
      SIDES.forEach(function (s) { if (api.sides[s].active) self.deactivate(s); });
      this.updateBody();
      if (this.watch) this.watch.visible = false;
    },

    updateSide: function (side, src, frame, ref) {
      var st = api.sides[side];
      var hand = document.getElementById(ENTITY[side]);
      if (!hand) return;

      // Joints
      var tracked = false;
      if (src.hand && frame.getJointPose) {
        tracked = true;
        var names = ['wrist'];
        for (var f = 0; f < FINGERS.length; f++) names = names.concat(FINGER_JOINTS[FINGERS[f]]);
        for (var n = 0; n < names.length; n++) {
          var space = src.hand.get ? src.hand.get(names[n]) : null;
          var jp = space ? frame.getJointPose(space, ref) : null;
          if (!jp) { if (names[n] === 'wrist' || /tip$/.test(names[n])) tracked = false; continue; }
          var j = st.joints[names[n]] || (st.joints[names[n]] = { p: new THREE.Vector3(), q: new THREE.Quaternion() });
          j.p.set(jp.transform.position.x, jp.transform.position.y, jp.transform.position.z);
          j.q.set(jp.transform.orientation.x, jp.transform.orientation.y, jp.transform.orientation.z,
            jp.transform.orientation.w);
        }
      }
      st.tracked = tracked;

      // Hand entity pose: grip space (what controllers use), wrist as fallback
      var grip = src.gripSpace ? frame.getPose(src.gripSpace, ref) : null;
      var o3 = hand.object3D;
      if (grip) {
        o3.position.set(grip.transform.position.x, grip.transform.position.y, grip.transform.position.z);
        o3.quaternion.set(grip.transform.orientation.x, grip.transform.orientation.y, grip.transform.orientation.z,
          grip.transform.orientation.w);
      } else if (tracked && st.joints.wrist) {
        o3.position.copy(st.joints.wrist.p);
        o3.quaternion.copy(st.joints.wrist.q);
      }
      if (grip || tracked) {
        o3.visible = true;
        o3.updateMatrix();
      }

      // Hide the controller-style hand models on this entity (keep game UI children such as the menu)
      if (!st.hiddenMeshes.length) {
        var hide = [];
        var mesh = hand.getObject3D && hand.getObject3D('mesh');
        if (mesh && mesh.visible) hide.push(mesh);
        var gen = hand.components && hand.components['generic-tracked-controller-controls'];
        if (gen && gen.modelEl && gen.modelEl.object3D && gen.modelEl.object3D.visible) hide.push(gen.modelEl.object3D);
        hide.forEach(function (o) { o.visible = false; });
        st.hiddenMeshes = hide.length ? hide : [{ visible: true }];
      }

      // Raycaster along the system pointer ray, expressed in the hand entity's local frame
      var rc = hand.components && hand.components.raycaster;
      var ray = src.targetRaySpace ? frame.getPose(src.targetRaySpace, ref) : null;
      if (rc && rc.data && ray && (grip || tracked)) {
        _m1.compose(o3.position, o3.quaternion, _v3.set(1, 1, 1)).invert();
        _m2.fromArray(ray.transform.matrix);
        _m1.multiply(_m2);
        _v1.setFromMatrixPosition(_m1);
        _q1.setFromRotationMatrix(_m1);
        _v2.set(0, 0, -1).applyQuaternion(_q1).normalize();
        rc.data.origin.x = _v1.x; rc.data.origin.y = _v1.y; rc.data.origin.z = _v1.z;
        rc.data.direction.x = _v2.x; rc.data.direction.y = _v2.y; rc.data.direction.z = _v2.z;
        if (rc.updateOriginDirection) rc.updateOriginDirection();
      }

      // Gestures
      if (!tracked) {
        if (st.pinch) { st.pinch = false; hand.emit('triggerup', { handInput: true }); }
        if (st.grab) { st.grab = false; hand.emit('gripup', { handInput: true }); }
        return;
      }
      for (var c = 0; c < FINGERS.length; c++) {
        var v = fingerCurl(st, FINGERS[c]);
        if (v != null) st.curls[FINGERS[c]] = v;
      }
      var grabCurl = (st.curls.middle + st.curls.ring + st.curls.pinky) / 3;
      var tipT = st.joints['thumb-tip'], tipI = st.joints['index-finger-tip'];
      var pinchDist = tipT && tipI ? tipT.p.distanceTo(tipI.p) : 1;

      if (!st.grab && grabCurl > GRAB_ON && !st.pinch) {
        st.grab = true;
        hand.emit('gripdown', { handInput: true });
      } else if (st.grab && grabCurl < GRAB_OFF) {
        st.grab = false;
        hand.emit('gripup', { handInput: true });
      }
      if (!st.pinch && !st.grab && pinchDist < PINCH_ON) {
        st.pinch = true;
        hand.emit('triggerdown', { handInput: true });
      } else if (st.pinch && pinchDist > PINCH_OFF) {
        st.pinch = false;
        hand.emit('triggerup', { handInput: true });
      }
    },

    // Your own avatar model is hidden while you play with hands (other players still see you).
    // Only the model is touched, so the game's own show/hide of #player-body keeps working.
    updateBody: function () {
      var body = document.getElementById('player-body');
      var mb = body && body.components && body.components['mixamo-body'];
      var model = mb && mb.model;
      if (!model) return;
      if (api.anyHand()) {
        model.visible = false;
        this.bodyHidden = true;
      } else if (this.bodyHidden) {
        model.visible = true;
        this.bodyHidden = false;
      }
    },

    // Watch button on the back of the left wrist → menu (replaces the X button)
    buildWatch: function () {
      var g = new THREE.Group();
      var ring = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.0022, 8, 32),
        new THREE.MeshBasicMaterial({ color: 0x12dace, toneMapped: false }));
      var disc = new THREE.Mesh(new THREE.CircleGeometry(0.0145, 32),
        new THREE.MeshBasicMaterial({ color: 0x0b1f24, transparent: true, opacity: 0.85, toneMapped: false }));
      disc.position.z = -0.0005;
      g.add(ring);
      g.add(disc);
      var barGeo = new THREE.PlaneGeometry(0.014, 0.0024);
      var barMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      [-0.005, 0, 0.005].forEach(function (y) {
        var b = new THREE.Mesh(barGeo, barMat);
        b.position.set(0, y, 0.0005);
        g.add(b);
      });
      g.visible = false;
      g.userData.ring = ring;
      this.el.object3D.add(g);
      this.watch = g;
    },

    updateWatch: function (time) {
      var L = api.sides.left, R = api.sides.right;
      if (!L.active || !L.tracked || !L.joints.wrist) {
        if (this.watch) this.watch.visible = false;
        return;
      }
      if (!this.watch) this.buildWatch();
      var parent = rigParent('left');
      if (!parent) return;
      parent.updateWorldMatrix(true, false);

      // Wrist frame in world space
      var wrist = L.joints.wrist;
      var wp = _v1.copy(wrist.p).applyMatrix4(parent.matrixWorld);
      parent.getWorldQuaternion(_q1);
      var wq = _q1.multiply(wrist.q);
      var up = new THREE.Vector3(0, 1, 0).applyQuaternion(wq);       // out of the back of the hand
      var toArm = new THREE.Vector3(0, 0, 1).applyQuaternion(wq);    // from wrist towards the elbow
      var cam = this.el.camera;
      var head = new THREE.Vector3();
      if (cam) cam.getWorldPosition(head);
      // Face the watch towards your eyes, whichever way the wrist is turned
      if (up.dot(_v2.copy(head).sub(wp)) < 0) up.negate();
      var pos = wp.clone().addScaledVector(up, 0.028).addScaledVector(toArm, 0.045);
      this.watch.position.copy(pos);
      this.watch.lookAt(head);
      this.watch.visible = true;

      // Press with the right index fingertip
      var tip = R.active ? api.jointWorld('right', 'index-finger-tip', _v3) : null;
      var d = tip ? tip.distanceTo(pos) : 1;
      this.watch.scale.setScalar(d < 0.07 ? 1.25 : 1);
      this.watch.userData.ring.material.color.setHex(d < 0.07 ? 0xffffff : 0x12dace);
      if (!this.watchArmed && d > WATCH_REARM) this.watchArmed = true;
      if (this.watchArmed && d < WATCH_PRESS && (time - this.watchLastAt) > WATCH_COOLDOWN_MS) {
        this.watchArmed = false;
        this.watchLastAt = time;
        var leftHand = document.getElementById('leftHand');
        if (leftHand) leftHand.emit('xbuttondown', { handInput: true });
        if (global.StacksAudio && global.StacksAudio.sfx) {
          try { global.StacksAudio.sfx('ui'); } catch (e) { /* no audio */ }
        }
      }
    }
  });
})(window);
