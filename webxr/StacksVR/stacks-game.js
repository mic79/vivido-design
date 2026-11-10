// stacks-game.js — StacksVR match + hand-pose block grab/place
(function (global) {
  'use strict';

  var CELL = (global.StacksShapes && global.StacksShapes.CELL) || 0.12;
  var GRAB_REACH = 0.32;       // pad piece pickup
  // Pocket is at x=-0.55, pad at x=0.2 (~0.75m apart) — 0.28 won't steal pad grabs
  var POCKET_REACH = 0.28;
  var REGRAB_REACH = 0.28;
  var CUP_GRAB_REACH = 0.28;
  var CUP_MARGIN = CELL * 0.85;

  AFRAME.registerComponent('stacks-game', {
    schema: {
      mode: { type: 'string', default: 'pvp' }
    },

    init: function () {
      this.cups = {};
      this.clearSys = new global.StacksClear();
      this.attackSys = new global.StacksAttack();
      this.modes = new global.StacksModes.ModeController({ mode: this.data.mode });
      this.bag = new global.StacksShapes.ShapeBag();
      this.bot = null;

      this.held = null; // { mesh, type, rot, handEl }
      this.ghostMesh = null;
      this.ghostCells = null;
      this.ghostValid = false;

      this.matchActive = false;
      this.localSide = 'blue';
      this.playerScore = 0;
      this.botScore = 0;
      this.matchState = 'WAITING';

      this._sceneRoot = null;
      this._pad = null;
      this._padMesh = null;
      this._padPiece = null;
      this._previewPiece = null;
      this._nextType = null;
      this._pocket = null;
      this._pocketMesh = null;
      this._pocketType = null; // stashed shape type or null
      this._pocketUsed = false; // tetris-style: one swap until next place
      this._cupGrab = null; // { handEl, cup, startHandAngle, startYaw }
      this._lastTransformSend = 0;
      this._lastPoseSend = 0;
      this._remoteHeld = {}; // side -> { mesh, type }

      this._tmp = new THREE.Vector3();
      this._tmp2 = new THREE.Vector3();
      this._tmpQ = new THREE.Quaternion();
      this._tmpQ2 = new THREE.Quaternion();
      this._fwd = new THREE.Vector3();
      this._right = new THREE.Vector3();
      this._up = new THREE.Vector3();
      this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
      this._mat = new THREE.Matrix4();
      this._cupCenter = new THREE.Vector3();

      var self = this;
      this.el.sceneEl.addEventListener('loaded', function () { self._boot(); });
      if (this.el.sceneEl.hasLoaded) this._boot();

      if (global.StacksLobby) {
        function chain(key, fn) {
          var prev = global.StacksLobby[key];
          global.StacksLobby[key] = function () {
            if (typeof prev === 'function') prev.apply(null, arguments);
            return fn.apply(self, arguments);
          };
        }
        chain('onMatchStarted', self.onMatchStarted);
        chain('onMatchEnded', self.onMatchEnded);
        chain('onCupEvent', self.onRemoteCupEvent);
        chain('onCupSnapshot', self.onRemoteSnapshot);
        global.StacksLobby.onRequestSnapshot = function () {
          return self._buildSnapshot();
        };
      }

      this._bindInput();
    },

    _boot: function () {
      if (this._sceneRoot) return;
      var scene = this.el.sceneEl.object3D;
      this._sceneRoot = new THREE.Group();
      this._sceneRoot.name = 'stacks-arena';
      scene.add(this._sceneRoot);

      var blue = new global.StacksCup({
        id: 'blue', side: 'blue',
        width: 6, depth: 6, height: 12,
        position: { x: -0.4, y: 0.9, z: -0.15 }
      });
      var red = new global.StacksCup({
        id: 'red', side: 'red',
        width: 6, depth: 6, height: 12,
        position: { x: 0.55, y: 0.9, z: -0.15 }
      });
      this.cups.blue = blue;
      this.cups.red = red;
      this._sceneRoot.add(blue.pivot || blue.root);
      this._sceneRoot.add(red.pivot || red.root);

      // Spawn stack pad — in front of player, easy reach
      this._pad = new THREE.Group();
      this._pad.position.set(0.2, 1.05, 0.85);
      this._sceneRoot.add(this._pad);
      this._padMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.45, 0.04, 0.32),
        new THREE.MeshStandardMaterial({ color: 0x314055, roughness: 0.65, metalness: 0.15 })
      );
      this._pad.add(this._padMesh);
      var ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.16, 0.01, 8, 32),
        new THREE.MeshBasicMaterial({ color: 0x69F0AE })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.03;
      this._pad.add(ring);

      // Hold / storage pocket (Tetris-style swap)
      this._pocket = new THREE.Group();
      this._pocket.position.set(-0.55, 1.05, 0.85);
      this._sceneRoot.add(this._pocket);
      var pocketBase = new THREE.Mesh(
        new THREE.BoxGeometry(0.32, 0.04, 0.32),
        new THREE.MeshStandardMaterial({ color: 0x3a3050, roughness: 0.6, metalness: 0.2 })
      );
      this._pocket.add(pocketBase);
      var pocketRing = new THREE.Mesh(
        new THREE.TorusGeometry(0.12, 0.01, 8, 24),
        new THREE.MeshBasicMaterial({ color: 0xCE93D8 })
      );
      pocketRing.rotation.x = Math.PI / 2;
      pocketRing.position.y = 0.03;
      this._pocket.add(pocketRing);
      this._pocketType = null;
      this._pocketUsed = false;

      var self = this;
      this.bot = new global.StacksCupBot({
        cup: red,
        side: 'red',
        onPlace: function (side, type, cells, meta) {
          self._afterPlace(side, type, cells, meta.placed, true);
        }
      });

      this._spawnPadPiece();
      this._updateHUD();
      this._desktopHands();
      console.log('[StacksGame] ready');
    },

    _desktopHands: function () {
      var self = this;
      this._poseDesktop = function () {
        var scene = self.el.sceneEl;
        if (scene.renderer && scene.renderer.xr && scene.renderer.xr.isPresenting) return;
        var cam = document.getElementById('camera');
        var lh = document.getElementById('leftHand');
        var rh = document.getElementById('rightHand');
        var rig = document.getElementById('rig');
        if (!cam || !lh || !rh || !rig) return;
        cam.object3D.updateWorldMatrix(true, false);
        cam.object3D.getWorldPosition(self._tmp);
        cam.object3D.getWorldQuaternion(self._tmpQ);
        self._fwd.set(0, 0, -1).applyQuaternion(self._tmpQ);
        self._right.set(1, 0, 0).applyQuaternion(self._tmpQ);
        self._up.set(0, 1, 0).applyQuaternion(self._tmpQ);
        function put(el, side) {
          var p = self._tmp.clone()
            .addScaledVector(self._fwd, 0.45)
            .addScaledVector(self._right, side * 0.22)
            .addScaledVector(self._up, -0.35);
          rig.object3D.updateWorldMatrix(true, false);
          el.object3D.position.copy(rig.object3D.worldToLocal(p));
          el.object3D.quaternion.copy(self._tmpQ);
        }
        put(lh, -1);
        put(rh, 1);
      };
    },

    _bindInput: function () {
      var self = this;
      this._triggerDown = { leftHand: false, rightHand: false };

      function ownerId() {
        return self.held && self.held.handEl && self.held.handEl.id;
      }

      function tryGrabFrom(handEl) {
        if (!self._canControl() || !handEl) return;
        // Owning hand holding — stash if hand or held block is over the purple bin
        if (self.held && self.held.handEl === handEl) {
          if (self._nearPocket(handEl)) self._interactPocket(handEl);
          return;
        }

        // Free hand while other holds: steal / take-from-pocket / rotate cup
        if (self.held && self.held.handEl !== handEl) {
          if (self._handNearHeld(handEl)) {
            self._transferHold(handEl);
            return;
          }
          if (self._pocketType && self._nearPocket(handEl)) {
            self._interactPocket(handEl);
            return;
          }
          var cupBusy = self._localCup();
          if (self._handDistToCup(handEl, cupBusy) <= CUP_GRAB_REACH) {
            self._startCupGrab(handEl, cupBusy);
          }
          return;
        }

        // Empty hands: pad grab preferred; pocket only if clearly in-bin (and useful)
        var cup = self._localCup();
        var padD = self._handDistToPad(handEl);
        var cupD = self._handDistToCup(handEl, cup);
        var pocketD = self._distToPocket(handEl);
        var nearPad = padD <= GRAB_REACH;
        var nearCup = cupD <= CUP_GRAB_REACH;
        var nearPocket = pocketD <= POCKET_REACH;

        // Pad first when in reach — pocket must not steal near-miss pad grabs
        if (nearPad && (!nearPocket || padD <= pocketD + 0.04)) {
          self._grab(handEl);
          return;
        }
        // Empty pocket + empty hand is a no-op — never early-return on that
        if (nearPocket && self._pocketType && (!nearPad || pocketD + 0.04 < padD)) {
          self._interactPocket(handEl);
          return;
        }
        if (nearCup && (!nearPad || cupD < padD - 0.02)) {
          self._startCupGrab(handEl, cup);
          return;
        }
        if (nearPad) {
          self._grab(handEl);
          return;
        }
        // Desktop / far: still allow pad grab without proximity when not presenting
        if (!self._isPresenting()) self._grab(handEl);
      }

      function tryReleaseFrom(handEl) {
        if (!self._canControl() || !handEl) return;
        if (self._cupGrab && self._cupGrab.handEl === handEl) {
          self._endCupGrab(handEl);
          return;
        }
        if (!self.held) return;
        // Never place from the non-owning hand
        if (ownerId() !== handEl.id) return;
        // Steal / fresh acquire: consume this trigger-up without placing
        if (self.held.suppressPlace) {
          self.held.suppressPlace = false;
          self._pulseHaptic(handEl, 0.25, 30);
          return;
        }
        // Release over purple bin = stash (when not a valid cup place)
        if (self._nearPocket(handEl) && !self.ghostValid) {
          self._interactPocket(handEl);
          return;
        }
        if (self.ghostValid && self.ghostCells) {
          self._place(self.ghostCells);
        }
      }

      function attachHand(id) {
        var hand = document.getElementById(id);
        if (!hand) { setTimeout(function () { attachHand(id); }, 200); return; }
        hand.addEventListener('triggerdown', function (evt) {
          if (evt) evt.stopPropagation();
          self._triggerDown[id] = true;
          tryGrabFrom(hand);
        });
        hand.addEventListener('triggerup', function (evt) {
          if (evt) evt.stopPropagation();
          self._triggerDown[id] = false;
          tryReleaseFrom(hand);
        });
        // Grip also grabs/rotates the cup (Battleblocks-style free hand)
        hand.addEventListener('gripdown', function (evt) {
          if (evt) evt.stopPropagation();
          if (!self._canControl()) return;
          if (self.held && self.held.handEl === hand) return;
          if (self.held && self._handNearHeld(hand)) {
            self._transferHold(hand);
            return;
          }
          if (!self.held || self.held.handEl !== hand) {
            var cup = self._localCup();
            if (self._handDistToCup(hand, cup) <= CUP_GRAB_REACH) {
              self._startCupGrab(hand, cup);
            }
          }
        });
        hand.addEventListener('gripup', function (evt) {
          if (evt) evt.stopPropagation();
          if (self._cupGrab && self._cupGrab.handEl === hand) self._endCupGrab(hand);
        });
      }
      attachHand('leftHand');
      attachHand('rightHand');

      window.addEventListener('keydown', function (e) {
        if (!self._canControl()) return;
        if (e.repeat) return;
        if (e.code === 'Space') {
          e.preventDefault();
          if (!self.held) tryGrabFrom(document.getElementById('rightHand'));
          else tryReleaseFrom(self.held.handEl);
        } else if (e.key === 'g' || e.key === 'G') {
          if (!self.held) tryGrabFrom(document.getElementById('rightHand'));
        } else if (e.key === 'h' || e.key === 'H') {
          self._interactPocket(document.getElementById('rightHand'));
        } else if (e.key === 'r' || e.key === 'R') {
          // Desktop: rotate local cup 45°
          var cupR = self._localCup();
          if (cupR) cupR.setYaw((cupR.yaw || 0) + Math.PI / 4);
        } else if (e.code === 'PageUp' || e.key === '+') {
          var cupUp = self._localCup();
          if (cupUp && cupUp.setHeight) cupUp.setHeight(cupUp.getHeight() + 0.05);
        } else if (e.code === 'PageDown' || e.key === '-') {
          var cupDn = self._localCup();
          if (cupDn && cupDn.setHeight) cupDn.setHeight(cupDn.getHeight() - 0.05);
        } else if (e.key === 't' || e.key === 'T') {
          if (!self.held) return;
          var other = self.held.handEl && self.held.handEl.id === 'rightHand'
            ? document.getElementById('leftHand')
            : document.getElementById('rightHand');
          if (other) self._transferHold(other);
        } else if (e.key === 'Escape') {
          self._cancelHold();
          if (self._cupGrab) self._endCupGrab(self._cupGrab.handEl);
        }
      });

      // Desktop only — VR controllers often synthesize mouse clicks from either hand
      window.addEventListener('mousedown', function (e) {
        if (e.button !== 0 || !self._canControl()) return;
        if (self._isPresenting()) return;
        if (self.held && self.ghostValid) tryReleaseFrom(self.held.handEl);
      });
    },

    _pulseHaptic: function (handEl, intensity, durationMs) {
      if (!handEl) return;
      try {
        var gp = handEl.components && handEl.components['tracked-controls'] &&
          handEl.components['tracked-controls'].controller &&
          handEl.components['tracked-controls'].controller.gamepad;
        var act = gp && gp.hapticActuators && gp.hapticActuators[0];
        if (act && act.pulse) {
          var p = act.pulse(intensity || 0.4, durationMs || 40);
          if (p && p.catch) p.catch(function () {});
          return;
        }
        // WebXR haptic actuators (newer)
        var pads = gp && gp.vibrationActuator;
        if (pads && pads.playEffect) {
          pads.playEffect('dual-rumble', {
            startDelay: 0,
            duration: durationMs || 40,
            weakMagnitude: intensity || 0.4,
            strongMagnitude: intensity || 0.4
          });
        }
      } catch (err) { /* no haptics */ }
    },

    _canControl: function () {
      if (global.isMobileSpectator) return false;
      if (global.isSpectator && global.isMultiplayer && !global.isLobbyBotMatch) return false;
      if (global.isMultiplayer && global.StacksLobby && global.lobbyState &&
          global.lobbyState.matchState === 'PLAYING' && !global.StacksLobby.amMatchPlayer()) {
        return false;
      }
      return true;
    },

    _localCup: function () {
      if (global.isMultiplayer && global.StacksLobby && global.StacksLobby.amMatchPlayer()) {
        return this.cups[global.StacksLobby.mySide()];
      }
      return this.cups.blue;
    },

    _isPresenting: function () {
      return !!(this.el.sceneEl.renderer && this.el.sceneEl.renderer.xr &&
        this.el.sceneEl.renderer.xr.isPresenting);
    },

    _handWorld: function (handEl) {
      var el = handEl || (this.held && this.held.handEl) || document.getElementById('rightHand') ||
        document.getElementById('camera');
      if (!el) return null;
      el.object3D.updateWorldMatrix(true, false);
      el.object3D.getWorldPosition(this._tmp);
      el.object3D.getWorldQuaternion(this._tmpQ);
      this._fwd.set(0, 0, -1).applyQuaternion(this._tmpQ).normalize();
      return { pos: this._tmp.clone(), quat: this._tmpQ.clone(), fwd: this._fwd.clone(), el: el };
    },

    _handNearPad: function (handEl) {
      return this._handDistToPad(handEl) <= GRAB_REACH;
    },

    _handDistToPad: function (handEl) {
      if (!this._padPiece || !handEl) return Infinity;
      handEl.object3D.updateWorldMatrix(true, false);
      handEl.object3D.getWorldPosition(this._tmp);
      this._padPiece.updateWorldMatrix(true, false);
      this._padPiece.getWorldPosition(this._tmp2);
      return this._tmp.distanceTo(this._tmp2);
    },

    _pocketWorldPos: function (out) {
      if (!this._pocket) return null;
      this._pocket.updateWorldMatrix(true, false);
      this._pocket.getWorldPosition(out);
      out.y += 0.1;
      return out;
    },

    _distToPocket: function (handEl) {
      if (!this._pocket || !handEl) return Infinity;
      if (!this._pocketWorldPos(this._tmp2)) return Infinity;
      handEl.object3D.updateWorldMatrix(true, false);
      handEl.object3D.getWorldPosition(this._tmp);
      var d = this._tmp.distanceTo(this._tmp2);
      // Also count held block (palm origin can miss while the mesh is over the bin)
      if (this.held && this.held.mesh && this.held.handEl === handEl) {
        this.held.mesh.updateWorldMatrix(true, false);
        this.held.mesh.getWorldPosition(this._tmp);
        d = Math.min(d, this._tmp.distanceTo(this._tmp2));
      }
      return d;
    },

    _handDistToPocket: function (handEl) {
      return this._distToPocket(handEl);
    },

    _nearPocket: function (handEl) {
      return this._distToPocket(handEl) <= POCKET_REACH;
    },

    _refreshPocketMesh: function () {
      if (!this._pocket) return;
      for (var i = this._pocket.children.length - 1; i >= 0; i--) {
        var ch = this._pocket.children[i];
        if (ch.userData && ch.userData.pocketPiece) this._pocket.remove(ch);
      }
      this._pocketMesh = null;
      if (!this._pocketType) return;
      var mesh = global.StacksShapes.createShapeMesh(this._pocketType, {
        centerPivot: true, rotationY: 0
      });
      mesh.userData.pocketPiece = true;
      mesh.position.set(0, 0.1, 0);
      mesh.scale.setScalar(0.85);
      this._pocket.add(mesh);
      this._pocketMesh = mesh;
    },

    /** Deposit held → pocket, or swap / take from pocket (one use until place). */
    _interactPocket: function (handEl) {
      if (!this._canControl()) return;
      if (this._pocketUsed && this.held) {
        this._pulseHaptic(handEl, 0.15, 20);
        return;
      }
      if (this.held) {
        var incoming = this.held.type;
        var outgoing = this._pocketType;
        if (this.held.mesh.parent) this.held.mesh.parent.remove(this.held.mesh);
        this.held = null;
        this._clearGhost();
        this._pocketType = incoming;
        this._refreshPocketMesh();
        this._pocketUsed = true;
        if (outgoing) {
          this._spawnHeldType(handEl, outgoing);
        }
        this._pulseHaptic(handEl, 0.5, 50);
        this._broadcastHold();
        this._updateHUD();
        return;
      }
      if (this._pocketType) {
        var take = this._pocketType;
        this._pocketType = null;
        this._refreshPocketMesh();
        this._spawnHeldType(handEl, take);
        this._pocketUsed = true;
        this._pulseHaptic(handEl, 0.5, 50);
        this._broadcastHold();
        this._updateHUD();
      }
    },

    _spawnHeldType: function (handEl, type) {
      var hand = handEl || document.getElementById('rightHand');
      if (!hand || !type) return;
      var mesh = global.StacksShapes.createShapeMesh(type, { centerPivot: true, rotationY: 0 });
      hand.object3D.add(mesh);
      mesh.position.set(0, 0, -0.06);
      mesh.quaternion.identity();
      this.held = {
        mesh: mesh, type: type, rot: 0, handEl: hand,
        suppressPlace: true, wasGhostValid: false
      };
      this._updateGhost();
    },

    _handNearHeld: function (handEl) {
      if (!this.held || !this.held.mesh || !handEl) return false;
      handEl.object3D.updateWorldMatrix(true, false);
      handEl.object3D.getWorldPosition(this._tmp);
      this.held.mesh.updateWorldMatrix(true, false);
      this.held.mesh.getWorldPosition(this._tmp2);
      return this._tmp.distanceTo(this._tmp2) <= REGRAB_REACH;
    },

    _handDistToCup: function (handEl, cup) {
      if (!handEl || !cup) return Infinity;
      handEl.object3D.updateWorldMatrix(true, false);
      handEl.object3D.getWorldPosition(this._tmp);
      // Prefer rim if present
      if (cup._rim) {
        cup._rim.updateWorldMatrix(true, false);
        cup._rim.getWorldPosition(this._tmp2);
        var rimDist = this._tmp.distanceTo(this._tmp2);
        // Also allow grabbing near side walls via horizontal distance to center
        cup.getWorldCenter(this._cupCenter);
        var dx = this._tmp.x - this._cupCenter.x;
        var dz = this._tmp.z - this._cupCenter.z;
        var horiz = Math.sqrt(dx * dx + dz * dz);
        var halfW = cup.width * CELL * 0.5;
        var halfD = cup.depth * CELL * 0.5;
        var edge = Math.max(halfW, halfD);
        var yOk = this._tmp.y > this._cupCenter.y - 0.1 &&
          this._tmp.y < this._cupCenter.y + cup.height * CELL + 0.25;
        var wallDist = yOk ? Math.abs(horiz - edge) : Infinity;
        return Math.min(rimDist, wallDist);
      }
      cup.getWorldCenter(this._cupCenter);
      return this._tmp.distanceTo(this._cupCenter);
    },

    _handAngleAroundCup: function (handEl, cup) {
      handEl.object3D.updateWorldMatrix(true, false);
      handEl.object3D.getWorldPosition(this._tmp);
      cup.getWorldCenter(this._cupCenter);
      return Math.atan2(this._tmp.x - this._cupCenter.x, this._tmp.z - this._cupCenter.z);
    },

    _startCupGrab: function (handEl, cup) {
      if (!handEl || !cup) return;
      if (this._cupGrab) this._endCupGrab(this._cupGrab.handEl);
      handEl.object3D.updateWorldMatrix(true, false);
      handEl.object3D.getWorldPosition(this._tmp);
      this._cupGrab = {
        handEl: handEl,
        cup: cup,
        startHandAngle: this._handAngleAroundCup(handEl, cup),
        startYaw: cup.yaw || 0,
        startHandY: this._tmp.y,
        startCupY: cup.getHeight ? cup.getHeight() : (cup.pivot ? cup.pivot.position.y : cup.root.position.y)
      };
      this._pulseHaptic(handEl, 0.4, 40);
      this._updateHUD();
    },

    _endCupGrab: function (handEl) {
      if (!this._cupGrab) return;
      if (handEl && this._cupGrab.handEl !== handEl) return;
      this._pulseHaptic(this._cupGrab.handEl, 0.25, 30);
      this._cupGrab = null;
      this._updateHUD();
    },

    _updateCupGrab: function () {
      if (!this._cupGrab) return;
      var g = this._cupGrab;
      var ang = this._handAngleAroundCup(g.handEl, g.cup);
      var delta = ang - g.startHandAngle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      g.cup.setYaw(g.startYaw + delta);

      // Raise / lower with hand height
      g.handEl.object3D.updateWorldMatrix(true, false);
      g.handEl.object3D.getWorldPosition(this._tmp);
      var dy = this._tmp.y - g.startHandY;
      if (g.cup.setHeight) g.cup.setHeight(g.startCupY + dy);

      // Sync playfield pose to peers (throttled)
      var now = performance.now();
      if (global.isMultiplayer && now - this._lastTransformSend > 80) {
        this._lastTransformSend = now;
        this._broadcastCupTransform(g.cup);
      }
    },

    _broadcastCupTransform: function (cup) {
      if (!global.sendCupEvent || !cup) return;
      global.sendCupEvent({
        kind: 'transform',
        side: cup.side,
        yaw: cup.yaw || 0,
        heightY: cup.getHeight ? cup.getHeight() : cup.position.y
      });
    },

    _broadcastHold: function () {
      if (!global.isMultiplayer || !global.sendCupEvent) return;
      var side = this._localCup() ? this._localCup().side : 'blue';
      var payload = { kind: 'hold', side: side, holding: false };
      if (this.held) {
        this.held.mesh.updateWorldMatrix(true, false);
        this.held.mesh.getWorldPosition(this._tmp);
        this.held.mesh.getWorldQuaternion(this._tmpQ);
        payload.holding = true;
        payload.shapeType = this.held.type;
        payload.pos = { x: this._tmp.x, y: this._tmp.y, z: this._tmp.z };
        payload.quat = { x: this._tmpQ.x, y: this._tmpQ.y, z: this._tmpQ.z, w: this._tmpQ.w };
      }
      payload.pocketType = this._pocketType;
      global.sendCupEvent(payload);
    },

    _buildSnapshot: function () {
      return {
        blue: this.cups.blue.serialize(),
        red: this.cups.red.serialize(),
        scores: { blue: this.modes.scores.blue, red: this.modes.scores.red },
        attack: this.attackSys.serialize()
      };
    },

    _broadcastState: function (reason) {
      if (!global.sendCupEvent) return;
      global.sendCupEvent({
        kind: 'state',
        reason: reason || 'sync',
        scores: { blue: this.modes.scores.blue, red: this.modes.scores.red },
        cups: { blue: this.cups.blue.serialize(), red: this.cups.red.serialize() },
        attack: this.attackSys.serialize()
      });
    },

    _applyRemoteCups: function (cups) {
      if (!cups) return;
      if (cups.blue) this.cups.blue.applySnapshot(cups.blue);
      if (cups.red) this.cups.red.applySnapshot(cups.red);
    },

    _setRemoteHeld: function (side, data) {
      if (!this._sceneRoot) return;
      var prev = this._remoteHeld[side];
      if (prev && prev.mesh && prev.mesh.parent) prev.mesh.parent.remove(prev.mesh);
      this._remoteHeld[side] = null;
      if (!data || !data.holding || !data.shapeType) return;
      var mesh = global.StacksShapes.createShapeMesh(data.shapeType, {
        centerPivot: true, rotationY: 0
      });
      mesh.scale.setScalar(0.85);
      this._sceneRoot.add(mesh);
      if (data.pos) mesh.position.set(data.pos.x, data.pos.y, data.pos.z);
      if (data.quat) mesh.quaternion.set(data.quat.x, data.quat.y, data.quat.z, data.quat.w);
      this._remoteHeld[side] = { mesh: mesh, type: data.shapeType };
    },

    /** True only when the held block's center is inside the cup volume. */
    _heldInCup: function (cup) {
      if (!this.held || !this.held.mesh || !cup) return false;
      this.held.mesh.updateWorldMatrix(true, false);
      this.held.mesh.getWorldPosition(this._tmp);
      cup.root.updateWorldMatrix(true, false);
      var local = cup.root.worldToLocal(this._tmp.clone());
      var w = cup.width * CELL;
      var d = cup.depth * CELL;
      var h = cup.height * CELL;
      var m = CUP_MARGIN;
      return local.x >= -m && local.x <= w + m &&
        local.z >= -m && local.z <= d + m &&
        local.y >= -m && local.y <= h + m;
    },

    _transferHold: function (toHand) {
      if (!this.held || !toHand || this.held.handEl === toHand) return;
      var mesh = this.held.mesh;
      mesh.updateWorldMatrix(true, false);
      mesh.getWorldPosition(this._tmp);
      mesh.getWorldQuaternion(this._tmpQ);

      toHand.object3D.updateWorldMatrix(true, false);
      toHand.object3D.add(mesh);
      toHand.object3D.getWorldQuaternion(this._tmpQ2);
      mesh.quaternion.copy(this._tmpQ2.clone().invert().multiply(this._tmpQ));
      mesh.position.copy(toHand.object3D.worldToLocal(this._tmp.clone()));

      // Comfortable palm if the transfer left it awkwardly far
      if (mesh.position.length() > 0.3) {
        mesh.position.set(0, 0, -0.06);
        mesh.quaternion.identity();
      }

      this.held.handEl = toHand;
      // Next trigger-up on this hand must not place (steal click)
      this.held.suppressPlace = true;
      this._pulseHaptic(toHand, 0.45, 45);
      this._updateGhost();
      this._updateHUD();
    },

    _spawnPadPiece: function () {
      for (var i = this._pad.children.length - 1; i >= 0; i--) {
        var ch = this._pad.children[i];
        if (ch.userData && (ch.userData.padPiece || ch.userData.padPreview)) this._pad.remove(ch);
      }
      this._nextType = this.bag.next();
      var mesh = global.StacksShapes.createShapeMesh(this._nextType, {
        centerPivot: true,
        rotationY: 0
      });
      mesh.userData.padPiece = true;
      mesh.position.set(-0.06, 0.1, 0);
      this._pad.add(mesh);
      this._padPiece = mesh;

      // Next-piece preview (peek, don't consume)
      var peek = this.bag.peek(1);
      this._previewPiece = null;
      if (peek && peek[0]) {
        var prev = global.StacksShapes.createShapeMesh(peek[0], {
          centerPivot: true,
          rotationY: 0,
          ghost: true,
          valid: true
        });
        prev.userData.padPreview = true;
        prev.position.set(0.16, 0.08, 0);
        prev.scale.setScalar(0.55);
        prev.traverse(function (o) {
          if (o.isMesh && o.material) {
            o.material.opacity = 0.45;
            o.material.transparent = true;
          }
        });
        this._pad.add(prev);
        this._previewPiece = prev;
      }
    },

    _grab: function (handEl) {
      if (this.held || !this._nextType || !this._padPiece) return;

      var hand = handEl || document.getElementById('rightHand');
      if (!hand) return;

      // In VR require proximity to the pad piece; desktop Space/G always allowed
      if (this._isPresenting() && !this._handNearPad(hand)) return;

      // Capture pad piece world pose so the grab doesn't jump
      this._padPiece.updateWorldMatrix(true, false);
      this._padPiece.getWorldPosition(this._tmp);
      this._padPiece.getWorldQuaternion(this._tmpQ);

      if (this._padPiece.parent) this._padPiece.parent.remove(this._padPiece);
      this._padPiece = null;

      var mesh = global.StacksShapes.createShapeMesh(this._nextType, {
        centerPivot: true,
        rotationY: 0
      });

      // Parent to hand — block follows hand position + orientation continuously
      hand.object3D.updateWorldMatrix(true, false);
      hand.object3D.add(mesh);

      // Keep world pose from the pad (natural pick-up), then settle into palm if far
      hand.object3D.getWorldQuaternion(this._tmpQ2);
      var inv = this._tmpQ2.clone().invert();
      mesh.quaternion.copy(inv).multiply(this._tmpQ);
      mesh.position.copy(hand.object3D.worldToLocal(this._tmp.clone()));

      // If grab was from desktop / far, snap into a comfortable palm hold
      if (mesh.position.length() > 0.35 || !this._isPresenting()) {
        mesh.position.set(0, 0, -0.06);
        mesh.quaternion.identity();
      }

      this.held = {
        mesh: mesh,
        type: this._nextType,
        rot: 0,
        handEl: hand,
        suppressPlace: false,
        wasGhostValid: false
      };
      this._nextType = null;
      this._spawnPadPiece();
      this._pulseHaptic(hand, 0.55, 55);
      this._broadcastHold();
      this._updateGhost();
      this._updateHUD();
    },

    _cancelHold: function () {
      if (!this.held) return;
      var hand = this.held.handEl;
      if (this.held.mesh.parent) this.held.mesh.parent.remove(this.held.mesh);
      this.held = null;
      this._clearGhost();
      this._pulseHaptic(hand, 0.3, 35);
      this._broadcastHold();
      this._updateHUD();
    },

    _clearGhost: function () {
      if (this.ghostMesh && this.ghostMesh.parent) this.ghostMesh.parent.remove(this.ghostMesh);
      this.ghostMesh = null;
      this.ghostCells = null;
      this.ghostValid = false;
      this._ghostKey = null;
    },

    // Full hand/mesh orientation relative to cup (not yaw-only)
    _handSnapQuat: function (cup) {
      this.held.mesh.updateWorldMatrix(true, false);
      this.held.mesh.getWorldQuaternion(this._tmpQ);
      cup.root.updateWorldMatrix(true, false);
      cup.root.getWorldQuaternion(this._tmpQ2);
      return this._tmpQ2.clone().invert().multiply(this._tmpQ);
    },

    _projectCells: function (cup) {
      if (!this.held) return null;

      // No ghost / place unless the held block is actually over the playfield
      if (!this._heldInCup(cup)) {
        this.held.localCells = null;
        return null;
      }

      var qLocal = this._handSnapQuat(cup);
      var cells0 = global.StacksShapes.cellsOriented(this.held.type, qLocal);
      var ext = global.StacksShapes.extentOfCells(cells0);
      var oKey = global.StacksShapes.orientKey(qLocal);
      this.held.orientKey = oKey;
      this.held.localCells = cells0;

      this.held.mesh.updateWorldMatrix(true, false);
      this.held.mesh.getWorldPosition(this._tmp);
      cup.root.updateWorldMatrix(true, false);
      var local = cup.root.worldToLocal(this._tmp.clone());

      var cx = 0, cy = 0, cz = 0;
      for (var i = 0; i < cells0.length; i++) {
        cx += cells0[i][0] + 0.5;
        cy += cells0[i][1] + 0.5;
        cz += cells0[i][2] + 0.5;
      }
      cx /= cells0.length; cy /= cells0.length; cz /= cells0.length;

      var ox = Math.round(local.x / CELL - cx);
      var oy = Math.round(local.y / CELL - cy);
      var oz = Math.round(local.z / CELL - cz);

      // Keep in-bounds for the shape footprint — hand is already inside the cup
      ox = Math.max(0, Math.min(cup.width - 1 - ext.maxX, ox));
      oz = Math.max(0, Math.min(cup.depth - 1 - ext.maxZ, oz));
      oy = Math.max(0, Math.min(cup.height - 1 - ext.maxY, oy));

      var floated = cells0.map(function (c) { return [ox + c[0], oy + c[1], oz + c[2]]; });
      var dropped = this._gravity(cup, floated);
      if (dropped) return { cells: dropped, valid: true, orientKey: oKey, localCells: cells0 };

      // Small local search only while inside the cup
      var best = null, bestDist = 99;
      for (var dx = -1; dx <= 1; dx++) {
        for (var dz = -1; dz <= 1; dz++) {
          var ox2 = ox + dx, oz2 = oz + dz;
          if (ox2 < 0 || oz2 < 0) continue;
          if (ox2 > cup.width - 1 - ext.maxX) continue;
          if (oz2 > cup.depth - 1 - ext.maxZ) continue;
          var start = cells0.map(function (c) {
            return [ox2 + c[0], cup.height - 1 - ext.maxY, oz2 + c[2]];
          });
          var dcells = this._gravity(cup, start);
          if (!dcells) continue;
          var dist = Math.abs(dx) + Math.abs(dz);
          if (dist < bestDist) { bestDist = dist; best = dcells; }
        }
      }
      if (best) return { cells: best, valid: true, orientKey: oKey, localCells: cells0 };

      return { cells: floated, valid: false, orientKey: oKey, localCells: cells0 };
    },

    _gravity: function (cup, cells) {
      if (!cells) return null;
      var cur = cells;
      if (!cup.canPlace(cur)) {
        var found = null;
        for (var u = 1; u < cup.height; u++) {
          var up = cells.map(function (c) { return [c[0], c[1] + u, c[2]]; });
          var ok = true;
          for (var i = 0; i < up.length; i++) {
            if (!cup.inBounds(up[i][0], up[i][1], up[i][2])) { ok = false; break; }
          }
          if (!ok) break;
          if (cup.canPlace(up)) { found = up; break; }
        }
        if (!found) return null;
        cur = found;
      }
      for (;;) {
        var next = cur.map(function (c) { return [c[0], c[1] - 1, c[2]]; });
        if (!cup.canPlace(next)) break;
        cur = next;
      }
      var resting = false;
      for (var j = 0; j < cur.length; j++) {
        if (cur[j][1] <= 0) { resting = true; break; }
        if (!cup.isEmpty(cur[j][0], cur[j][1] - 1, cur[j][2])) { resting = true; break; }
      }
      return resting && cup.canPlace(cur) ? cur : null;
    },

    _updateGhost: function () {
      if (!this.held) { this._clearGhost(); return; }
      var cup = this._localCup();
      var snap = this._projectCells(cup);
      if (!snap) {
        if (this.held.wasGhostValid) this.held.wasGhostValid = false;
        this._clearGhost();
        return;
      }

      var key = (snap.valid ? '1' : '0') + ':' + this.held.type + ':' + snap.orientKey + ':' +
        snap.cells.map(function (c) { return c.join(','); }).join('|');
      if (this._ghostKey === key && this.ghostMesh) {
        this.ghostCells = snap.cells;
        this.ghostValid = snap.valid;
        return;
      }
      this._clearGhost();

      var mesh = global.StacksShapes.createShapeMesh(this.held.type, {
        cells: snap.localCells,
        ghost: true,
        valid: snap.valid
      });
      var minX = snap.cells[0][0], minY = snap.cells[0][1], minZ = snap.cells[0][2];
      for (var i = 1; i < snap.cells.length; i++) {
        minX = Math.min(minX, snap.cells[i][0]);
        minY = Math.min(minY, snap.cells[i][1]);
        minZ = Math.min(minZ, snap.cells[i][2]);
      }
      mesh.position.set(minX * CELL, minY * CELL + 0.01, minZ * CELL);
      mesh.scale.setScalar(1.05);
      mesh.traverse(function (o) {
        if (o.isMesh) {
          o.renderOrder = 10;
          o.material.depthTest = false;
        }
      });
      cup.root.add(mesh);

      this.ghostMesh = mesh;
      this.ghostCells = snap.cells;
      this.ghostValid = snap.valid;
      this._ghostKey = key;

      // Light tick when a valid snap first appears / changes into placeable
      if (snap.valid && !this.held.wasGhostValid) {
        this._pulseHaptic(this.held.handEl, 0.22, 25);
      }
      this.held.wasGhostValid = !!snap.valid;
    },

    _place: function (cells) {
      if (!this.held || !cells) return;
      var cup = this._localCup();
      var type = this.held.type;
      var hand = this.held.handEl;
      var color = global.StacksShapes.DEFS[type].color;
      if (this.held.mesh.parent) this.held.mesh.parent.remove(this.held.mesh);
      this.held = null;
      this._clearGhost();

      var placed = cup.placeCells(cells, { color: color, owner: cup.side, shapeType: type });
      if (!placed) return;
      this._pulseHaptic(hand, 0.7, 70);
      this._pocketUsed = false; // can swap again after a place
      this._broadcastHold();
      this._afterPlace(cup.side, type, cells, placed, true);
      this._updateHUD();
    },

    _afterPlace: function (side, type, cells, placed, broadcast) {
      var cup = this.cups[side];
      var clearResult = this.clearSys.resolveAfterPlace(cup, placed, type);
      if (clearResult.layersCleared > 0) {
        this.attackSys.onClear(side, clearResult, performance.now());
        if (this.matchActive) {
          var endInfo = this.modes.addClear(side, clearResult);
          this.playerScore = this.modes.scores.blue;
          this.botScore = this.modes.scores.red;
          if (global.lobbyState && global.lobbyState.matchScore) {
            global.lobbyState.matchScore.blue = this.modes.scores.blue;
            global.lobbyState.matchScore.red = this.modes.scores.red;
          }
          if (endInfo && endInfo.ended) this._endFromMode(endInfo);
        }
        if (window.matchRecorder) {
          window.matchRecorder.recordEvent('clear', {
            side: side, layers: clearResult.layersCleared, score: clearResult.score
          });
        }
      } else {
        this.clearSys.resetCombo();
      }

      if (window.matchRecorder) {
        window.matchRecorder.recordEvent('place', { side: side, type: type, cells: cells });
      }
      if (broadcast && global.sendCupEvent) {
        global.sendCupEvent({
          kind: 'place', side: side, shapeType: type, cells: cells, clear: clearResult,
          scores: { blue: this.modes.scores.blue, red: this.modes.scores.red },
          cups: { blue: this.cups.blue.serialize(), red: this.cups.red.serialize() },
          attack: this.attackSys.serialize()
        });
      }
      if (cup.isToppedOut()) {
        var over = this.modes.onOverflow(side);
        if (over) this._endFromMode(over);
      }
      this._updateHUD();
      this._updateDamageHUD();
    },

    onRemoteCupEvent: function (evt) {
      if (!evt || !evt.kind) return;
      var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
      if (evt.from && myId && evt.from === myId) return;

      if (evt.kind === 'transform' && evt.side && this.cups[evt.side]) {
        this.cups[evt.side].applyTransform({ yaw: evt.yaw, heightY: evt.heightY });
        return;
      }
      if (evt.kind === 'hold') {
        this._setRemoteHeld(evt.side, evt);
        return;
      }
      if (evt.kind === 'place' || evt.kind === 'state') {
        this._applyRemoteCups(evt.cups);
        if (evt.scores) {
          this.modes.scores.blue = evt.scores.blue;
          this.modes.scores.red = evt.scores.red;
          if (global.lobbyState && global.lobbyState.matchScore) {
            global.lobbyState.matchScore.blue = evt.scores.blue;
            global.lobbyState.matchScore.red = evt.scores.red;
          }
        }
        if (evt.attack) this.attackSys.applySerialized(evt.attack);
        if (evt.kind === 'place' && evt.side) this._setRemoteHeld(evt.side, { holding: false });
        this._updateHUD();
        this._updateDamageHUD();
      }
    },

    onRemoteSnapshot: function (data) {
      if (!data || !data.snapshot) return;
      this._applyRemoteCups(data.snapshot);
      if (data.snapshot.scores) {
        this.modes.scores.blue = data.snapshot.scores.blue;
        this.modes.scores.red = data.snapshot.scores.red;
      }
      if (data.snapshot.attack) this.attackSys.applySerialized(data.snapshot.attack);
      this._updateHUD();
      this._updateDamageHUD();
    },

    onMatchStarted: function (mp, startTime, isBotMatch) {
      this.matchActive = true;
      this.matchState = 'PLAYING';
      this.cups.blue.clearAll();
      this.cups.red.clearAll();
      this.clearSys = new global.StacksClear();
      this.attackSys.reset();
      this.modes.setMode(this.data.mode);
      this.modes.start(startTime || Date.now());
      this.playerScore = 0;
      this.botScore = 0;
      this.bag = new global.StacksShapes.ShapeBag();
      this._cancelHold();
      this._pocketType = null;
      this._pocketUsed = false;
      this._refreshPocketMesh();
      this._spawnPadPiece();
      this._setRemoteHeld('blue', { holding: false });
      this._setRemoteHeld('red', { holding: false });
      if (this.bot) {
        this.bot.reset();
        this.bot.setCup(this.cups.red);
        this.bot.enable(!!isBotMatch || (mp && mp.red === '__BOT__'));
      }
      if (window.matchRecorder) window.matchRecorder.startRecording(startTime || Date.now());
      this._updateHUD();
      // Host pushes a clean board to everyone
      if (global.isMultiplayer && global.StacksLobby && global.StacksLobby.isHost) {
        this._broadcastState('match-start');
      }
    },

    onMatchEnded: function () {
      this.matchActive = false;
      this.matchState = 'WAITING';
      if (this.bot) this.bot.enable(false);
      if (window.matchRecorder && window.matchRecorder.isRecording) {
        var replay = window.matchRecorder.stopRecording();
        if (replay && window.matchReplayStorage) window.matchReplayStorage.save(replay);
      }
      this._saveMatchHistory();
      this._updateHUD();
    },

    startOfflineBotMatch: function () {
      global.isLobbyBotMatch = true;
      this.onMatchStarted({ blue: 'local', red: '__BOT__' }, Date.now(), true);
    },

    endMatch: function () {
      if (global.isMultiplayer && global.sendMatchAction) global.sendMatchAction('end');
      else this.onMatchEnded();
    },

    _endFromMode: function (info) {
      if (global.isMultiplayer && global.StacksLobby && global.StacksLobby.isHost) global.endLobbyMatch();
      else if (!global.isMultiplayer) this.onMatchEnded();
      else if (global.sendMatchAction) global.sendMatchAction('end');
    },

    _saveMatchHistory: function () {
      var KEY = 'stacksvr-match-history';
      var list = [];
      try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { list = []; }
      list.unshift({
        ts: Date.now(), mode: this.modes.mode.id,
        blue: this.modes.scores.blue, red: this.modes.scores.red,
        winner: this.modes.winner, reason: this.modes.reason, bot: !!global.isLobbyBotMatch
      });
      if (list.length > 50) list = list.slice(0, 50);
      try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
      if (window.matchReplayStorage) {
        window.matchReplayStorage.pruneOld(list.map(function (m) { return m.ts; }));
      }
    },

    _updateHUD: function () {
      var scoreEl = document.getElementById('score-display');
      if (scoreEl) {
        scoreEl.setAttribute('text', 'value',
          'BLUE ' + (this.modes.scores.blue | 0) + '  |  RED ' + (this.modes.scores.red | 0));
      }
      var hBlue = document.getElementById('cup-height-blue');
      var hRed = document.getElementById('cup-height-red');
      if (hBlue && this.cups.blue) hBlue.setAttribute('text', 'value', 'H ' + this.cups.blue.constructionHeight);
      if (hRed && this.cups.red) hRed.setAttribute('text', 'value', 'H ' + this.cups.red.constructionHeight);
      var hint = document.getElementById('control-hint');
      if (hint) {
        var msg;
        if (this._cupGrab) msg = 'Twist = yaw · raise/lower hand = height';
        else if (this.held) {
          msg = this.ghostValid
            ? 'Release to place · H/pocket = stash'
            : 'Over cup to snap · purple pocket = hold';
        } else {
          msg = 'Pad = grab · purple = pocket · rim = move cup';
        }
        hint.setAttribute('text', 'value', msg);
      }
    },

    _updateDamageHUD: function () {
      var now = performance.now();
      this._updateThreat('blue', now);
      this._updateThreat('red', now);
    },

    _updateThreat: function (side, now) {
      var cup = this.cups[side];
      var buf = this.attackSys.buffers[side];
      var dEl = document.getElementById(side === 'blue' ? 'damage-blue' : 'damage-red');
      if (!cup || !buf) return;

      var pending = buf.pending | 0;
      var soon = 0;
      var minReady = Infinity;
      for (var i = 0; i < buf.queue.length; i++) {
        var q = buf.queue[i];
        if (q.readyAt < minReady) minReady = q.readyAt;
        soon += q.amount;
      }
      var urgency = 0;
      if (pending > 0 && minReady < Infinity) {
        var left = Math.max(0, minReady - now);
        urgency = 1 - Math.min(1, left / Math.max(1, this.attackSys.damageDelayMs));
        urgency = Math.max(urgency, 0.25);
      }
      cup.setThreat(urgency);

      if (dEl) {
        var label = 'DMG ' + pending;
        if (pending > 0 && minReady < Infinity) {
          var sec = Math.max(0, (minReady - now) / 1000);
          label += '  ' + sec.toFixed(1) + 's';
        }
        dEl.setAttribute('text', 'value', label);
        dEl.setAttribute('text', 'color', urgency > 0.55 ? '#ff8866' : '#aaaaaa');
      }
    },

    _sendLocalPose: function () {
      if (!global.isMultiplayer || !global.sendPlayerPose) return;
      if (global.isSpectator && !global.isLobbyBotMatch) return;
      var now = performance.now();
      if (now - this._lastPoseSend < 50) return;
      this._lastPoseSend = now;
      var cam = document.getElementById('camera');
      var lh = document.getElementById('leftHand');
      var rh = document.getElementById('rightHand');
      if (!cam) return;
      function pack(el) {
        if (!el) return null;
        el.object3D.updateWorldMatrix(true, false);
        var p = new THREE.Vector3();
        var q = new THREE.Quaternion();
        el.object3D.getWorldPosition(p);
        el.object3D.getWorldQuaternion(q);
        // Flat layout expected by mixamo-body remoteHandData
        return { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
      }
      global.sendPlayerPose({
        head: pack(cam),
        leftHand: pack(lh),
        rightHand: pack(rh)
      });
      if (this.held && now - (this._lastHoldSend || 0) > 100) {
        this._lastHoldSend = now;
        this._broadcastHold();
      }
    },

    tick: function () {
      if (!this._sceneRoot) return;
      if (this._poseDesktop) this._poseDesktop();

      this._updateCupGrab();
      this._sendLocalPose();

      if (this.held) {
        this._updateGhost();
        if (this._pad) this._pad.visible = true;
      } else if (this._pad) {
        this._pad.visible = true;
      }

      if (this.matchActive) {
        // In multiplayer, only host (or offline/bot) advances attack timers —
        // peers receive board via state/place snapshots (avoids RNG garbage desync).
        var mp = !!global.isMultiplayer;
        var host = global.StacksLobby && global.StacksLobby.isHost;
        var tickAttack = !mp || host || !!global.isLobbyBotMatch;
        if (tickAttack) {
          var applied = this.attackSys.tick(this.cups, performance.now());
          if (applied && applied.length) {
            for (var i = 0; i < applied.length; i++) {
              if (this.cups[applied[i].side].isToppedOut()) {
                var over = this.modes.onOverflow(applied[i].side);
                if (over) this._endFromMode(over);
              }
              if (applied[i].side === (this._localCup() && this._localCup().side)) {
                var hand = (this.held && this.held.handEl) || document.getElementById('rightHand');
                this._pulseHaptic(hand, 0.8, 90);
              }
            }
            if (mp && host) this._broadcastState('garbage');
            this._updateHUD();
          }
        }
        this._updateDamageHUD();
        var t = this.modes.tick(Date.now());
        if (t && t.ended) this._endFromMode(t);
        if (this.bot && this.bot.enabled) this.bot.tick(performance.now());
      } else {
        if (this.cups.blue) this.cups.blue.setThreat(0);
        if (this.cups.red) this.cups.red.setThreat(0);
      }

      if (window.matchRecorder && window.matchRecorder.tick) window.matchRecorder.tick();
    }
  });
})(window);
