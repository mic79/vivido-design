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
 *   - pinch (the headset's own pinch = WebXR select; joint distance as fallback)
 *                                  → triggerdown / triggerup  (grab, place, menu click);
 *   - fist (middle, ring, pinky)   → gripdown / gripup         (StacksVR cup);
 *     while that grip pose is held (also pointing with index + thumb out) the hand's laser is
 *     hidden and stops hovering, since pinching isn't possible then;
 *   - a watch button on the back of the left wrist, tapped with the right index finger
 *                                  → xbuttondown on #leftHand (menu);
 *   - the menu opens as a panel in front of you (not on the wrist) and its buttons can be
 *     pressed with either index fingertip, as well as with laser + pinch;
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

  // Fallback pinch from joints, only used when the runtime sends no select events. Tip joints
  // sit inside the fingertips, so touching fingers still measure ~1.5-2.5 cm apart.
  var PINCH_ON = 0.026;   // thumb tip <-> index tip (m)
  var PINCH_OFF = 0.04;
  var BTN_PRESS = 0.004;  // fingertip past a menu button's face (m)
  var BTN_REARM = 0.015;
  var BTN_HOVER = 0.05;
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
      hiddenMeshes: [],
      sysSelect: false,    // runtime sends select events for this hand -> use them for pinch
      btnArmed: true,      // fingertip menu-button press
      btnHover: null,
      pointerHidden: false // laser hidden while in the grip / pointing pose
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
    /** True while this hand's laser pointer should be hidden (grip / pointing pose). */
    pointerHidden: function (side) {
      side = side === 'leftHand' ? 'left' : side === 'rightHand' ? 'right' : side;
      var s = this.sides[side];
      return !!(s && s.active && s.grab);
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

  function visibleChain(el) {
    var node = el;
    while (node && node.object3D) {
      if (!node.object3D.visible) return false;
      if (node.isScene) return true;
      node = node.parentNode;
    }
    return true;
  }

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
      this.el.addEventListener('loaded', function () { self.ensureMeshes(); self.patchMenu(); });
      if (this.el.hasLoaded) { this.ensureMeshes(); this.patchMenu(); }
      this._session = null;
      this._onSelectStart = function (e) { self.onSelect(e, true); };
      this._onSelectEnd = function (e) { self.onSelect(e, false); };
    },

    // Pinch from the headset's own gesture recogniser (WebXR select events)
    bindSession: function (session) {
      if (!session || session === this._session || !session.addEventListener) return;
      if (this._session && this._session.removeEventListener) {
        this._session.removeEventListener('selectstart', this._onSelectStart);
        this._session.removeEventListener('selectend', this._onSelectEnd);
      }
      this._session = session;
      session.addEventListener('selectstart', this._onSelectStart);
      session.addEventListener('selectend', this._onSelectEnd);
    },

    onSelect: function (e, down) {
      var src = e && e.inputSource;
      if (!src || !src.hand) return;
      var side = src.handedness;
      var st = api.sides[side];
      if (!st || !st.active) return;
      st.sysSelect = true;
      var hand = document.getElementById(ENTITY[side]);
      if (!hand) return;
      if (down && !st.pinch && !st.grab) {
        st.pinch = true;
        hand.emit('triggerdown', { handInput: true });
      } else if (!down && st.pinch) {
        st.pinch = false;
        hand.emit('triggerup', { handInput: true });
      }
    },

    // Menu: in hands-only mode it opens as a panel in front of you
    patchMenu: function () {
      var menuEl = document.querySelector('[vr-menu]');
      var comp = menuEl && menuEl.components && menuEl.components['vr-menu'];
      if (!comp) { setTimeout(this.patchMenu.bind(this), 500); return; }
      if (comp._handInputPatched || typeof comp._attachMenuToLeftHand !== 'function') return;
      comp._handInputPatched = true;
      this.menu = comp;
      var self = this;
      var orig = comp._attachMenuToLeftHand;
      comp._attachMenuToLeftHand = function () {
        if (api.anyHand()) return self.placeMenuInFront();
        // Back on controllers: put the 3D object back on the left hand before the normal attach
        var root = document.getElementById('vr-menu-root');
        var left = document.getElementById('leftHand');
        if (root && left && root.object3D && root.object3D.parent !== left.object3D) left.object3D.add(root.object3D);
        return orig.apply(this, arguments);
      };
    },

    placeMenuInFront: function () {
      var root = document.getElementById('vr-menu-root');
      var cam = this.el.camera;
      if (!root || !cam) return;
      // Move only the 3D object into world space. Moving the element in the DOM makes A-Frame
      // re-initialise every component of the menu (its text then throws on update).
      if (root.object3D.parent !== this.el.object3D) this.el.object3D.add(root.object3D);
      var head = new THREE.Vector3();
      cam.getWorldPosition(head);
      var fwd = new THREE.Vector3();
      cam.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      var pos = head.clone().addScaledVector(fwd, 0.45);
      pos.y -= 0.16;
      var yaw = Math.atan2(-fwd.x, -fwd.z) * 180 / Math.PI;
      root.setAttribute('position', { x: pos.x, y: pos.y, z: pos.z });
      root.setAttribute('rotation', { x: -22, y: yaw, z: 0 });
      root.setAttribute('scale', '0.55 0.55 0.55');
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
      // The games enter XR as immersive-ar on Quest (so passthrough can toggle live): A-Frame
      // then sets 'ar-mode', not 'vr-mode'. Either one means we're in a headset session.
      var inXR = scene.is('vr-mode') || scene.is('ar-mode') || (!!api._testFrame && !api._testNoForce);
      if (!inXR || !frame) {
        if (api.anyHand()) this.deactivateAll();
        return;
      }
      var ref = api._testRef || this.referenceSpace();
      var session = frame.session;
      if (!ref || !session) return;
      this.bindSession(session);

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
        this.updatePointer(side);
      }

      this.updateBody();
      this.updateWatch(time);
      this.updateMenuPoke();
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
      if (st.pointerHidden) { st.grab = false; this.updatePointer(side); }
      st.hiddenMeshes.forEach(function (o) { o.visible = true; });
      st.hiddenMeshes = [];
      st.active = false;
      st.tracked = false;
      st.pinch = false;
      st.grab = false;
      st.savedRay = null;
      st.sysSelect = false;
      if (st.btnHover) { st.btnHover.emit('mouseleave'); st.btnHover = null; }
      st.btnArmed = true;
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
      if (st.sysSelect) return; // the headset reports pinches itself (onSelect)
      if (!st.pinch && !st.grab && pinchDist < PINCH_ON) {
        st.pinch = true;
        hand.emit('triggerdown', { handInput: true });
      } else if (st.pinch && pinchDist > PINCH_OFF) {
        st.pinch = false;
        hand.emit('triggerup', { handInput: true });
      }
    },

    // Hide the menu laser (A-Frame raycaster line) and stop its hovering while the hand is in the
    // grip / pointing pose. Games that draw their own lasers ask HandInput.pointerHidden().
    updatePointer: function (side) {
      var st = api.sides[side];
      var hand = document.getElementById(ENTITY[side]);
      var rc = hand && hand.components && hand.components.raycaster;
      var hide = api.pointerHidden(side);
      if (!hide && !st.pointerHidden) return;
      if (rc && rc.raycaster && rc.data) rc.raycaster.far = hide ? 0.0001 : rc.data.far;
      var line = hand && hand.getObject3D && hand.getObject3D('line');
      if (line) line.visible = hide ? false : !!(rc && rc.data && rc.data.showLine);
      st.pointerHidden = hide;
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

    // Press menu buttons with an index fingertip (either hand)
    updateMenuPoke: function () {
      var menu = this.menu;
      var root = document.getElementById('vr-menu-root');
      var open = !!(menu && menu.menuVisible && root && visibleChain(root));
      SIDES.forEach(function (side) {
        var st = api.sides[side];
        var tip = open && st.active && st.tracked ? api.jointWorld(side, 'index-finger-tip', new THREE.Vector3()) : null;
        var best = null;
        if (tip) {
          var btns = root.querySelectorAll('.menu-btn');
          for (var i = 0; i < btns.length; i++) {
            var el = btns[i];
            if (!el.object3D || !visibleChain(el)) continue;
            var g = el.getAttribute('geometry');
            if (!g || !g.width || !g.height) continue;
            el.object3D.updateWorldMatrix(true, false);
            var local = el.object3D.worldToLocal(tip.clone());
            if (Math.abs(local.x) > g.width / 2 + 0.004 || Math.abs(local.y) > g.height / 2 + 0.004) continue;
            el.object3D.getWorldScale(_v2);
            var dz = (local.z - (g.depth || 0) / 2) * _v2.z; // metres in front of the face
            if (dz > BTN_HOVER || dz < -0.04) continue;
            if (!best || Math.abs(dz) < Math.abs(best.dz)) best = { el: el, dz: dz };
          }
        }
        var hand = document.getElementById(ENTITY[side]);
        var hoverEl = best ? best.el : null;
        if (hoverEl !== st.btnHover) {
          if (st.btnHover) st.btnHover.emit('mouseleave');
          if (hoverEl) hoverEl.emit('mouseenter', { cursorEl: hand });
          st.btnHover = hoverEl;
        }
        if (!best || best.dz > BTN_REARM) st.btnArmed = true;
        if (best && st.btnArmed && best.dz < BTN_PRESS) {
          st.btnArmed = false;
          best.el.emit('click', { cursorEl: hand, handInput: true });
        }
      });
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
