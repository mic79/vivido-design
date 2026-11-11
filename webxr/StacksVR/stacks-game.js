// stacks-game.js — StacksVR match + hand-pose block grab/place
(function (global) {
  'use strict';

  var CELL = (global.StacksShapes && global.StacksShapes.CELL) || 0.12;
  var GRAB_REACH = 0.28;       // pad piece pickup
  // Pad/pocket sit ~0.4m apart — keep reaches tight so they don't steal each other
  var POCKET_REACH = 0.22;
  var REGRAB_REACH = 0.28;
  var CUP_GRAB_REACH = 0.28;
  var CUP_MARGIN = CELL * 0.85;

  AFRAME.registerComponent('stacks-game', {
    schema: {
      mode: { type: 'string', default: 'pvp' }
    },

    init: function () {
      this.cups = {};
      this.clearSysBlue = new global.StacksClear();
      this.clearSysRed = new global.StacksClear();
      this.clearSys = this.clearSysBlue; // back-compat
      this.attackSys = new global.StacksAttack();
      this.modes = new global.StacksModes.ModeController({ mode: this.data.mode });
      this.matchStats = global.StacksStats
        ? new global.StacksStats.MatchStats()
        : null;
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
      this._pieceAnims = [];
      this._pocket = null;
      this._pocketMesh = null;
      this._pocketType = null; // stashed shape type or null
      this._pocketUsed = false; // tetris-style: one swap until next place
      this._pocketLockUntil = 0; // ignore pocket actions briefly after take/deposit
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
        chain('onPlayerPose', self.onRemotePlayerPose);
        global.StacksLobby.onRequestSnapshot = function () {
          return self._buildSnapshot();
        };
      }
      // Stable entry point so lobby.js can apply poses even if callbacks were rebound
      global.applyStacksRemotePose = function (fromId, data) {
        self.onRemotePlayerPose(fromId, data);
      };

      this._bindInput();
    },

    _boot: function () {
      if (this._sceneRoot) return;
      var scene = this.el.sceneEl.object3D;
      this._sceneRoot = new THREE.Group();
      this._sceneRoot.name = 'stacks-arena';
      scene.add(this._sceneRoot);

      // Layout from BattleBlocks screenshot:
      // - POSITION is diagonal (blue left-near, red right-far)
      // - ROTATION stays axis-aligned — cups face each other head-on along Z
      //   (floor squares are not diamond-rotated).
      var CUP_Y = 0.92;
      var CUP_HALF = (6 * CELL) / 2; // 0.36
      var PAD_Y = 1.12;
      var SHIFT_X = 0.65; // lateral stagger
      var SHIFT_Z = 0.85; // depth separation
      var blueC = { x: -SHIFT_X, z: SHIFT_Z };
      var redC = { x: SHIFT_X, z: -SHIFT_Z };
      // Head-on along Z: blue faces -Z (toward red), red faces +Z (toward blue)
      var blueYaw = 0;
      var redYaw = Math.PI;

      function cornerFromCenter(c) {
        return { x: c.x - CUP_HALF, y: CUP_Y, z: c.z - CUP_HALF };
      }
      // Axis-aligned offsets: fwd = toward opponent along Z, right = +X in player view
      function offsetBlue(alongFwd, alongRight) {
        // blue faces -Z ⇒ forward is -Z, right is +X
        return {
          x: blueC.x + alongRight,
          y: PAD_Y,
          z: blueC.z - alongFwd
        };
      }
      function offsetRed(alongFwd, alongRight) {
        // red faces +Z ⇒ forward is +Z, right is -X (mirrored)
        return {
          x: redC.x - alongRight,
          y: PAD_Y,
          z: redC.z + alongFwd
        };
      }

      var blue = new global.StacksCup({
        id: 'blue', side: 'blue',
        width: 6, depth: 6, height: 12,
        position: cornerFromCenter(blueC)
      });
      var red = new global.StacksCup({
        id: 'red', side: 'red',
        width: 6, depth: 6, height: 12,
        position: cornerFromCenter(redC)
      });
      this.cups.blue = blue;
      this.cups.red = red;
      this._sceneRoot.add(blue.pivot || blue.root);
      this._sceneRoot.add(red.pivot || red.root);
      if (blue.pivot) { blue.pivot.rotation.y = blueYaw; blue.yaw = blueYaw; }
      if (red.pivot) { red.pivot.rotation.y = redYaw; red.yaw = redYaw; }

      // BattleBlocks: NEXT on playfield-right; pad+pocket far enough apart that
      // full tetromino footprints never collide (I-piece ~0.44m at scale 1).
      var blueNextPos = offsetBlue(-0.38, 0.90);
      var bluePadPos = offsetBlue(-0.58, 0.48);
      var bluePocketPos = offsetBlue(-0.58, 1.28);
      var redNextPos = offsetRed(-0.38, 0.90);
      var redPadPos = offsetRed(-0.58, 0.48);
      var redPocketPos = offsetRed(-0.58, 1.28);

      // Floor diamond outline (no fill) — BattleBlocks station marks
      function neonDiamond(half, color) {
        var edge = new THREE.Mesh(
          new THREE.RingGeometry(half * 0.82, half, 4),
          new THREE.MeshBasicMaterial({
            color: color, side: THREE.DoubleSide, toneMapped: false
          })
        );
        edge.rotation.x = -Math.PI / 2;
        edge.rotation.z = Math.PI / 4;
        edge.position.y = 0.006;
        return edge;
      }

      function buildNextColumn(pos, color, yaw) {
        var root = new THREE.Group();
        root.position.set(pos.x, pos.y, pos.z);
        root.rotation.y = yaw;
        // Tall neon frame (slightly wider at bottom like BB)
        var fwTop = 0.26, fwBot = 0.34, fh = 1.28, r = 0.05, tube = 0.009;
        var path = new THREE.CurvePath();
        function L(a, b) { path.add(new THREE.LineCurve3(a, b)); }
        function C(a, ctrl, b) { path.add(new THREE.QuadraticBezierCurve3(a, ctrl, b)); }
        var p = function (x, y) { return new THREE.Vector3(x, y, 0); };
        var y0 = -fh / 2, y1 = fh / 2;
        L(p(-fwBot / 2 + r, y0), p(fwBot / 2 - r, y0));
        C(p(fwBot / 2 - r, y0), p(fwBot / 2, y0), p(fwBot / 2, y0 + r));
        L(p(fwBot / 2, y0 + r), p(fwTop / 2, y1 - r));
        C(p(fwTop / 2, y1 - r), p(fwTop / 2, y1), p(fwTop / 2 - r, y1));
        L(p(fwTop / 2 - r, y1), p(-fwTop / 2 + r, y1));
        C(p(-fwTop / 2 + r, y1), p(-fwTop / 2, y1), p(-fwTop / 2, y1 - r));
        L(p(-fwTop / 2, y1 - r), p(-fwBot / 2, y0 + r));
        C(p(-fwBot / 2, y0 + r), p(-fwBot / 2, y0), p(-fwBot / 2 + r, y0));
        var frame = new THREE.Mesh(
          new THREE.TubeGeometry(path, 80, tube, 5, true),
          new THREE.MeshBasicMaterial({ color: color, toneMapped: false })
        );
        frame.position.y = 0.78;
        root.add(frame);
        // "NEXT" label
        var canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 64;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 256, 64);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'italic 600 40px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NEXT', 128, 32);
        var label = new THREE.Mesh(
          new THREE.PlaneGeometry(0.20, 0.05),
          new THREE.MeshBasicMaterial({
            map: new THREE.CanvasTexture(canvas),
            transparent: true, depthWrite: false, toneMapped: false
          })
        );
        label.position.set(0, 1.40, 0.02);
        root.add(label);
        var slots = new THREE.Group();
        slots.name = 'nextSlots';
        slots.position.set(0, 0.20, 0);
        root.add(slots);
        this._sceneRoot.add(root);
        return { root: root, slots: slots };
      }

      this._pad = new THREE.Group();
      this._pad.position.set(bluePadPos.x, bluePadPos.y, bluePadPos.z);
      this._sceneRoot.add(this._pad);
      this._padMesh = neonDiamond(0.18, 0x33bbff);
      this._pad.add(this._padMesh);

      this._pocket = new THREE.Group();
      this._pocket.position.set(bluePocketPos.x, bluePocketPos.y, bluePocketPos.z);
      this._sceneRoot.add(this._pocket);
      this._pocket.add(neonDiamond(0.18, 0x33bbff));
      this._pocketType = null;
      this._pocketUsed = false;

      var blueNext = buildNextColumn.call(this, blueNextPos, 0x33bbff, 0);
      this._nextBlue = blueNext;

      this._botPad = new THREE.Group();
      this._botPad.position.set(redPadPos.x, redPadPos.y, redPadPos.z);
      this._sceneRoot.add(this._botPad);
      this._botPad.add(neonDiamond(0.18, 0xff6a3d));
      this._botPadPiece = null;

      this._botPocket = new THREE.Group();
      this._botPocket.position.set(redPocketPos.x, redPocketPos.y, redPocketPos.z);
      this._sceneRoot.add(this._botPocket);
      this._botPocket.add(neonDiamond(0.18, 0xff6a3d));
      this._botPocketMesh = null;
      this._botHoldMesh = null;

      var redNext = buildNextColumn.call(this, redNextPos, 0xff6a3d, Math.PI);
      this._nextRed = redNext;

      this._buildArenaAtmosphere(blueC, redC);

      // Players stand behind their cup, looking head-on along Z
      this._layout = {
        blueC: blueC, redC: redC,
        blueYaw: blueYaw, redYaw: redYaw,
        bluePad: bluePadPos, bluePocket: bluePocketPos, blueNext: blueNextPos,
        redPad: redPadPos, redPocket: redPocketPos, redNext: redNextPos,
        player: { x: blueC.x, y: 0, z: blueC.z + 0.90 },
        opponent: { x: redC.x, y: 0, z: redC.z - 0.90 }
      };

      var self = this;
      this._dualBotPreview = false;
      this._botHold = { blue: null, red: null };
      this.bot = new global.StacksCupBot({
        cup: red,
        side: 'red',
        thinkIntervalMs: 1200,
        onPlace: function (side, type, cells, meta) {
          self._afterPlace(side, type, cells, meta.placed, !self._dualBotPreview);
        },
        onVisual: function (evt) {
          self._onBotVisual('red', evt);
        }
      });
      this.botBlue = new global.StacksCupBot({
        cup: blue,
        side: 'blue',
        thinkIntervalMs: 1450,
        onPlace: function (side, type, cells, meta) {
          self._afterPlace(side, type, cells, meta.placed, !self._dualBotPreview);
        },
        onVisual: function (evt) {
          self._onBotVisual('blue', evt);
        }
      });
      this._setBotStationVisible(false);

      this._spawnPadPiece();
      this._updateHUD();
      this._desktopHands();
      console.log('[StacksGame] ready');
    },

    _botStation: function (side) {
      if (side === 'blue') {
        return { pad: this._pad, pocket: this._pocket, padKey: 'padPiece', pocketKey: 'pocketPiece' };
      }
      return { pad: this._botPad, pocket: this._botPocket, padKey: 'botPadPiece', pocketKey: 'botPocketPiece' };
    },

    _setBotStationVisible: function (on) {
      if (this._botPad) this._botPad.visible = !!on;
      if (this._botPocket) this._botPocket.visible = !!on;
      if (!on) {
        this._clearBotStationPieces('red');
        this._clearBotHoldMesh('red');
        if (this._dualBotPreview) {
          this._clearBotStationPieces('blue');
          this._clearBotHoldMesh('blue');
        }
      }
    },

    _clearBotStationPieces: function (side) {
      var st = this._botStation(side);
      if (st.pad) {
        for (var i = st.pad.children.length - 1; i >= 0; i--) {
          var ch = st.pad.children[i];
          if (ch.userData && (ch.userData.botPadPiece || ch.userData.padPiece || ch.userData.padPreview)) {
            st.pad.remove(ch);
          }
        }
      }
      if (st.pocket) {
        for (var j = st.pocket.children.length - 1; j >= 0; j--) {
          var pch = st.pocket.children[j];
          if (pch.userData && (pch.userData.botPocketPiece || pch.userData.pocketPiece)) {
            st.pocket.remove(pch);
          }
        }
      }
      if (side === 'red') {
        this._botPadPiece = null;
        this._botPocketMesh = null;
      } else {
        this._padPiece = null;
        this._previewPiece = null;
        this._pocketMesh = null;
      }
    },

    _clearBotHoldMesh: function (side) {
      side = side || 'red';
      var mesh = this._botHold && this._botHold[side];
      if (mesh && mesh.parent) mesh.parent.remove(mesh);
      if (this._botHold) this._botHold[side] = null;
      // legacy single-mesh field
      if (side === 'red') this._botHoldMesh = null;
      this._setRemoteHeld(side, { holding: false });
    },

    _onBotVisual: function (side, evt) {
      if (!evt || !evt.kind) return;
      var st = this._botStation(side);
      if (evt.kind === 'reset') {
        this._clearBotStationPieces(side);
        this._clearBotHoldMesh(side);
        return;
      }
      if (evt.kind === 'pad') {
        if (st.pad) {
          for (var i = st.pad.children.length - 1; i >= 0; i--) {
            var ch = st.pad.children[i];
            if (ch.userData && (ch.userData.botPadPiece || ch.userData.padPiece || ch.userData.padPreview)) {
              st.pad.remove(ch);
            }
          }
        }
        if (side === 'red') this._botPadPiece = null;
        else { this._padPiece = null; this._previewPiece = null; }
        if (!evt.type || !st.pad) return;
        var bot = side === 'blue' ? this.botBlue : this.bot;
        var col = side === 'red' ? this._nextRed : this._nextBlue;
        var bottom = col && col.slots && col.slots.children[0];
        if (bottom && bot && bot.bag) {
          // Bag already advanced — slide queue bottom onto pad
          this._animateQueueAdvance(side, bot.bag, bottom);
        } else {
          var mesh = global.StacksShapes.createShapeMesh(evt.type, {
            centerPivot: true, rotationY: 0
          });
          mesh.userData.botPadPiece = true;
          mesh.userData.padPiece = true;
          mesh.position.set(0, 0.1, 0);
          this._fitStationPiece(mesh, 0.30);
          st.pad.add(mesh);
          if (side === 'red') this._botPadPiece = mesh;
          else this._padPiece = mesh;
          if (bot && bot.bag) this._rebuildNextQueue(side, bot.bag, { dropIn: true });
        }
        return;
      }
      if (evt.kind === 'pocket') {
        if (st.pocket) {
          for (var j = st.pocket.children.length - 1; j >= 0; j--) {
            var pch = st.pocket.children[j];
            if (pch.userData && (pch.userData.botPocketPiece || pch.userData.pocketPiece)) {
              st.pocket.remove(pch);
            }
          }
        }
        if (!evt.type || !st.pocket) return;
        var pm = global.StacksShapes.createShapeMesh(evt.type, {
          centerPivot: true, rotationY: 0
        });
        pm.userData.botPocketPiece = true;
        pm.userData.pocketPiece = true;
        pm.position.set(0, 0.1, 0);
        this._fitStationPiece(pm, 0.30);
        st.pocket.add(pm);
        if (side === 'red') this._botPocketMesh = pm;
        else this._pocketMesh = pm;
        return;
      }
      if (evt.kind === 'hold') {
        if (!evt.holding) {
          this._clearBotHoldMesh(side);
          if (!this._dualBotPreview && global.sendCupEvent) {
            global.sendCupEvent({ kind: 'hold', side: side, holding: false });
          }
          return;
        }
        var cup = this.cups[side];
        if (!cup || !evt.cells || !evt.cells.length) return;

        // Placement centroid in cup-local space (blocksRoot / root coords)
        var targetLocal = new THREE.Vector3();
        for (var ci = 0; ci < evt.cells.length; ci++) {
          targetLocal.add(cup.cellCenterLocal(
            evt.cells[ci][0], evt.cells[ci][1], evt.cells[ci][2]
          ));
        }
        targetLocal.multiplyScalar(1 / evt.cells.length);
        var hoverLocal = targetLocal.clone();
        hoverLocal.y += 0.32; // slightly above destination

        if (!this._botHold[side]) {
          this._botHold[side] = global.StacksShapes.createShapeMesh(evt.type, {
            centerPivot: true, rotationY: 0
          });
          // Parent under cup.root so orientation matches placed blocks (no yaw snap)
          cup.root.add(this._botHold[side]);
          if (side === 'red') this._botHoldMesh = this._botHold[side];
          this._botHold[side].userData.botHoldStartQuat = new THREE.Quaternion();
          this._botHold[side].quaternion.identity();
        }
        var holdMesh = this._botHold[side];

        var endQuat = new THREE.Quaternion();
        if (evt.quat && typeof evt.quat.w === 'number') {
          endQuat.set(evt.quat.x, evt.quat.y, evt.quat.z, evt.quat.w);
        } else if (evt.quat && evt.quat.isQuaternion) {
          endQuat.copy(evt.quat);
        } else {
          endQuat.identity();
        }
        if (global.StacksShapes.snapQuatToGrid) {
          endQuat = global.StacksShapes.snapQuatToGrid(endQuat);
        }
        var startQuat = holdMesh.userData.botHoldStartQuat || new THREE.Quaternion();

        // Phases: 0–0.40 move above · 0.40–0.68 orient · 0.68–1.0 lower
        var p = Math.max(0, Math.min(1, evt.progress != null ? evt.progress : 0));
        var fromLocal = hoverLocal.clone();
        if (st.pad) {
          // Pad world → cup.root local
          st.pad.updateWorldMatrix(true, false);
          cup.root.updateWorldMatrix(true, false);
          var padWorld = new THREE.Vector3();
          st.pad.getWorldPosition(padWorld);
          padWorld.y += 0.12;
          fromLocal.copy(padWorld);
          cup.root.worldToLocal(fromLocal);
        } else {
          fromLocal.copy(hoverLocal).add(new THREE.Vector3(0, 0.2, side === 'blue' ? 0.35 : -0.35));
        }

        var pos = new THREE.Vector3();
        var q = new THREE.Quaternion();
        if (p < 0.40) {
          var u = p / 0.40;
          pos.copy(fromLocal).lerp(hoverLocal, u);
          q.copy(startQuat);
        } else if (p < 0.68) {
          var u2 = (p - 0.40) / 0.28;
          pos.copy(hoverLocal);
          q.copy(startQuat).slerp(endQuat, u2);
        } else {
          var u3 = (p - 0.68) / 0.32;
          pos.copy(hoverLocal).lerp(targetLocal, u3);
          q.copy(endQuat);
        }
        holdMesh.position.copy(pos);
        holdMesh.quaternion.copy(q);

        if (!this._dualBotPreview && global.sendCupEvent) {
          var now = performance.now();
          var key = '_lastBotHoldSend_' + side;
          if (!this[key] || now - this[key] > 80 || p < 0.02) {
            this[key] = now;
            // Broadcast scene-root-local pose for remote spectators
            var worldPos = new THREE.Vector3();
            holdMesh.getWorldPosition(worldPos);
            this._sceneRoot.updateWorldMatrix(true, false);
            this._sceneRoot.worldToLocal(worldPos);
            global.sendCupEvent({
              kind: 'hold',
              side: side,
              holding: true,
              shapeType: evt.type,
              pos: { x: worldPos.x, y: worldPos.y, z: worldPos.z },
              quat: { x: q.x, y: q.y, z: q.z, w: q.w }
            });
          }
        }
      }
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
        var pocketReady = performance.now() >= (self._pocketLockUntil || 0);

        // Owning hand holding — trigger over bin stashes (not on trigger-up)
        if (self.held && self.held.handEl === handEl) {
          if (pocketReady && self._nearPocket(handEl)) self._interactPocket(handEl);
          return;
        }

        // Free hand while other holds: steal / take-from-pocket / rotate cup
        if (self.held && self.held.handEl !== handEl) {
          if (self._handNearHeld(handEl)) {
            self._transferHold(handEl);
            return;
          }
          if (pocketReady && self._pocketType && self._nearPocket(handEl)) {
            self._interactPocket(handEl);
            return;
          }
          var cupBusy = self._localCup();
          if (self._handDistToCup(handEl, cupBusy) <= CUP_GRAB_REACH) {
            self._startCupGrab(handEl, cupBusy);
          }
          return;
        }

        // Empty hands
        var cup = self._localCup();
        var padD = self._handDistToPad(handEl);
        var cupD = self._handDistToCup(handEl, cup);
        var pocketD = self._distToPocket(handEl);
        var nearPad = padD <= GRAB_REACH;
        var nearCup = cupD <= CUP_GRAB_REACH;
        var nearPocket = pocketD <= POCKET_REACH;

        // Take from pocket FIRST when over the bin (pad is ~0.75m away — no conflict)
        if (pocketReady && nearPocket && self._pocketType) {
          self._interactPocket(handEl);
          return;
        }
        if (nearPad) {
          self._grab(handEl);
          return;
        }
        if (nearCup) {
          self._startCupGrab(handEl, cup);
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
        // Steal / fresh acquire: consume this trigger-up without placing/stashing
        if (self.held.suppressPlace) {
          self.held.suppressPlace = false;
          self._pulseHaptic(handEl, 0.25, 30);
          return;
        }
        // Stash is trigger-down only — trigger-up over bin was putting takes straight back
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
      // Prefer shared helper (covers oculus-touch / webxr / vive gamepads)
      if (global.StacksHaptics && global.StacksHaptics.pulse) {
        global.StacksHaptics.pulse(handEl, intensity || 0.4, durationMs || 40);
        return;
      }
      try {
        var comps = handEl.components || {};
        var keys = [
          'tracked-controls', 'tracked-controls-webxr',
          'oculus-touch-controls', 'meta-touch-controls', 'vive-controls'
        ];
        var gp = null;
        for (var i = 0; i < keys.length; i++) {
          var c = comps[keys[i]];
          if (c && c.controller && c.controller.gamepad) { gp = c.controller.gamepad; break; }
        }
        var act = gp && gp.hapticActuators && gp.hapticActuators[0];
        if (act && act.pulse) {
          var p = act.pulse(intensity || 0.4, durationMs || 40);
          if (p && p.catch) p.catch(function () {});
          return;
        }
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
      this._fitStationPiece(mesh, 0.30);
      this._pocket.add(mesh);
      this._pocketMesh = mesh;
    },

    /** Deposit held → pocket, or swap / take from pocket.
     *  Put-back into an empty pocket is always allowed.
     *  Swap (pocket already full) is one-shot until the next place. */
    _interactPocket: function (handEl) {
      if (!this._canControl()) return;
      if (performance.now() < (this._pocketLockUntil || 0)) return;
      if (this.held) {
        var incoming = this.held.type;
        var outgoing = this._pocketType;
        // Block only a second swap this piece — empty bin put-back is fine
        if (this._pocketUsed && outgoing) {
          this._pulseHaptic(handEl, 0.15, 20);
          return;
        }
        if (this.held.mesh.parent) this.held.mesh.parent.remove(this.held.mesh);
        this.held = null;
        this._clearGhost();
        this._pocketType = incoming;
        this._refreshPocketMesh();
        if (outgoing) {
          this._pocketUsed = true;
          this._spawnHeldType(handEl, outgoing);
        }
        this._pocketLockUntil = performance.now() + 350;
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
        // Lock briefly so trigger-up / bounce cannot immediately re-deposit
        this._pocketLockUntil = performance.now() + 350;
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

    // Vertical stack inside NEXT — small silhouettes with clear gaps
    _nextSlotY: function (i) { return 0.02 + i * 0.24; },
    _nextSlotScale: function (i) { return Math.max(0.09, 0.20 - i * 0.022); },

    /** Scale pad/pocket pieces so longest tetromino fits inside its diamond. */
    _fitStationPiece: function (mesh, maxSpan) {
      if (!mesh) return;
      maxSpan = maxSpan || 0.30;
      var type = mesh.userData && mesh.userData.shapeType;
      var span = CELL * 3;
      if (type && global.StacksShapes && StacksShapes.shapeExtent) {
        var e = StacksShapes.shapeExtent(type, 0);
        var cells = Math.max(e.maxX, e.maxY, e.maxZ) + 1;
        span = cells * CELL * 0.92;
      }
      var s = Math.min(0.82, maxSpan / Math.max(0.01, span));
      mesh.scale.setScalar(s);
      mesh.userData.stationScale = s;
    },

    /** Stand pieces in XY so silhouettes read clearly in the NEXT frame. */
    _orientNextQueueMesh: function (mesh) {
      if (!mesh) return;
      mesh.rotation.set(Math.PI / 2, 0, 0);
    },

    _spawnPadPiece: function (opts) {
      opts = opts || {};
      for (var i = this._pad.children.length - 1; i >= 0; i--) {
        var ch = this._pad.children[i];
        if (ch.userData && (ch.userData.padPiece || ch.userData.padPreview)) this._pad.remove(ch);
      }
      this._nextType = this.bag.next();
      this._padPiece = null;
      this._previewPiece = null;

      var bottom = this._nextBlue && this._nextBlue.slots && this._nextBlue.slots.children[0];
      if (opts.animate && bottom) {
        this._animateQueueAdvance('blue', this.bag, bottom);
        return;
      }

      var mesh = global.StacksShapes.createShapeMesh(this._nextType, {
        centerPivot: true,
        rotationY: 0
      });
      mesh.userData.padPiece = true;
      mesh.position.set(0, 0.1, 0);
      this._fitStationPiece(mesh, 0.30);
      this._pad.add(mesh);
      this._padPiece = mesh;
      this._rebuildNextQueue('blue', this.bag, { dropIn: !!opts.dropIn });
    },

    /** Instant or drop-in fill of the NEXT column from bag.peek. */
    _rebuildNextQueue: function (side, bag, opts) {
      opts = opts || {};
      var col = side === 'red' ? this._nextRed : this._nextBlue;
      if (!col || !col.slots || !bag || !bag.peek) return;
      while (col.slots.children.length) col.slots.remove(col.slots.children[0]);
      var peek = bag.peek(5);
      var now = performance.now();
      for (var i = 0; i < peek.length; i++) {
        var m = global.StacksShapes.createShapeMesh(peek[i], {
          centerPivot: true,
          rotationY: 0
        });
        m.userData.nextPreview = true;
        this._orientNextQueueMesh(m);
        var y = this._nextSlotY(i);
        var s = this._nextSlotScale(i);
        if (opts.dropIn) {
          m.position.set(0, y + 0.28 + i * 0.04, 0);
          m.scale.setScalar(0.12);
          col.slots.add(m);
          this._pieceAnims.push({
            mesh: m,
            fromPos: m.position.clone(),
            toPos: new THREE.Vector3(0, y, 0),
            fromScale: 0.12,
            toScale: s,
            t0: now + i * 40,
            dur: 320
          });
        } else {
          m.scale.setScalar(s);
          m.position.set(0, y, 0);
          col.slots.add(m);
        }
      }
    },

    /** Slide queue[0] onto the pad; shift others down; drop a new piece in at the top. */
    _animateQueueAdvance: function (side, bag, bottomMesh) {
      var col = side === 'red' ? this._nextRed : this._nextBlue;
      var pad = side === 'red' ? this._botPad : this._pad;
      if (!col || !pad || !bottomMesh || !this._sceneRoot) return;

      pad.updateWorldMatrix(true, false);
      var toWorld = pad.localToWorld(new THREE.Vector3(0, 0.1, 0));

      this._sceneRoot.attach(bottomMesh);
      bottomMesh.userData.nextPreview = false;
      bottomMesh.userData.padPiece = true;
      bottomMesh.userData.botPadPiece = side === 'red';
      bottomMesh.userData.spawning = true;
      if (side === 'blue') this._padPiece = bottomMesh;
      else this._botPadPiece = bottomMesh;

      var toLocal = this._sceneRoot.worldToLocal(toWorld.clone());
      var now = performance.now();
      var flatQ = new THREE.Quaternion();
      var self = this;
      var fitScale = 0.82;
      if (bottomMesh.userData && bottomMesh.userData.shapeType && global.StacksShapes) {
        var ext = StacksShapes.shapeExtent(bottomMesh.userData.shapeType, 0);
        var cells = Math.max(ext.maxX, ext.maxY, ext.maxZ) + 1;
        fitScale = Math.min(0.82, 0.30 / Math.max(0.01, cells * CELL * 0.92));
      }
      this._pieceAnims.push({
        mesh: bottomMesh,
        fromPos: bottomMesh.position.clone(),
        toPos: toLocal,
        fromScale: bottomMesh.scale.x,
        toScale: fitScale,
        fromQuat: bottomMesh.quaternion.clone(),
        toQuat: flatQ,
        t0: now,
        dur: 360,
        onDone: function () {
          pad.attach(bottomMesh);
          bottomMesh.position.set(0, 0.1, 0);
          bottomMesh.quaternion.identity();
          self._fitStationPiece(bottomMesh, 0.30);
          bottomMesh.userData.spawning = false;
        }
      });

      var remaining = Array.prototype.slice.call(col.slots.children);
      for (var i = 0; i < remaining.length; i++) {
        var k = remaining[i];
        this._pieceAnims.push({
          mesh: k,
          fromPos: k.position.clone(),
          toPos: new THREE.Vector3(0, this._nextSlotY(i), 0),
          fromScale: k.scale.x,
          toScale: this._nextSlotScale(i),
          t0: now,
          dur: 300
        });
      }

      var peek = bag.peek(5);
      var newIdx = remaining.length;
      if (peek[newIdx]) {
        var m = global.StacksShapes.createShapeMesh(peek[newIdx], {
          centerPivot: true,
          rotationY: 0
        });
        m.userData.nextPreview = true;
        this._orientNextQueueMesh(m);
        var y = this._nextSlotY(newIdx);
        m.position.set(0, y + 0.3, 0);
        m.scale.setScalar(0.12);
        col.slots.add(m);
        this._pieceAnims.push({
          mesh: m,
          fromPos: m.position.clone(),
          toPos: new THREE.Vector3(0, y, 0),
          fromScale: 0.12,
          toScale: this._nextSlotScale(newIdx),
          t0: now + 40,
          dur: 340
        });
      }
    },

    _tickPieceAnims: function (now) {
      if (!this._pieceAnims || !this._pieceAnims.length) return;
      now = now || performance.now();
      for (var i = this._pieceAnims.length - 1; i >= 0; i--) {
        var a = this._pieceAnims[i];
        if (!a.mesh) { this._pieceAnims.splice(i, 1); continue; }
        if (now < a.t0) continue;
        var u = Math.min(1, (now - a.t0) / Math.max(1, a.dur));
        var e = 1 - Math.pow(1 - u, 3);
        a.mesh.position.lerpVectors(a.fromPos, a.toPos, e);
        var s = a.fromScale + (a.toScale - a.fromScale) * e;
        a.mesh.scale.setScalar(s);
        if (a.fromQuat && a.toQuat) {
          a.mesh.quaternion.slerpQuaternions(a.fromQuat, a.toQuat, e);
        }
        if (u >= 1) {
          if (a.onDone) a.onDone();
          this._pieceAnims.splice(i, 1);
        }
      }
    },

    /** @deprecated — use _rebuildNextQueue */
    _refreshNextQueue: function (side, bag) {
      this._rebuildNextQueue(side, bag, { dropIn: false });
    },

    _grab: function (handEl) {
      if (this._dualBotPreview) return;
      if (this.held || !this._nextType || !this._padPiece) return;
      if (this._padPiece.userData && this._padPiece.userData.spawning) return;

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
      this._spawnPadPiece({ animate: true });
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
      var clearSys = side === 'red' ? this.clearSysRed : this.clearSysBlue;
      var clearResult = clearSys.resolveAfterPlace(cup, placed, type);
      if (this.matchStats) this.matchStats.onPlace(side, clearResult, performance.now());
      if (clearResult.layersCleared > 0) {
        var atk = this.attackSys.onClear(side, clearResult, performance.now());
        if (this.matchStats && atk && atk.sent > 0) {
          this.matchStats.onAttack(side, atk.sent, performance.now());
        }
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
        clearSys.resetCombo();
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

    /**
     * Apply networked head/hand pose to the correct remote body.
     * Accepts nested {head,leftHand,rightHand} or DodgeVR flat {x,y,z,hqx,...,lhx,...}.
     */
    onRemotePlayerPose: function (fromId, data) {
      if (!data) return;
      var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
      if (fromId && myId && fromId === myId) return;

      var rd = this._normalizeRemotePose(data);
      if (!rd || !rd.head) return;

      var mp = global.lobbyState && global.lobbyState.matchPlayers;
      var body = null;
      var isBot = fromId === '__BOT__' || (mp && fromId === mp.red && mp.red === '__BOT__');
      if (isBot || (mp && fromId === mp.red)) {
        body = document.getElementById('bot-body');
      } else if (mp && fromId === mp.blue) {
        body = document.getElementById('spec-blue-body');
      } else if (fromId === '__BOT__') {
        body = document.getElementById('bot-body');
      } else {
        // Host / unknown match player → blue spectator body
        body = document.getElementById('spec-blue-body');
      }
      if (!body) return;

      // Never drive the local VR player's own body with remote data
      if (body.id === 'player-body') return;

      body.setAttribute('visible', true);
      if (body.object3D) body.object3D.visible = true;
      body.dataset.posed = '1';

      var mb = body.components && body.components['mixamo-body'];
      if (!mb) {
        // Component not ready — retry briefly
        var self = this;
        setTimeout(function () {
          self.onRemotePlayerPose(fromId, data);
        }, 100);
        return;
      }
      mb.remoteHandData = rd;
      this._poseRecvCount = (this._poseRecvCount || 0) + 1;
    },

    _normalizeRemotePose: function (data) {
      // Nested StacksVR format
      if (data.head && typeof data.head.x === 'number') {
        return {
          head: data.head,
          leftHand: data.leftHand || null,
          rightHand: data.rightHand || null
        };
      }
      // DodgeVR flat format
      if (typeof data.x === 'number' && typeof data.y === 'number') {
        var rd = {
          head: {
            x: data.x, y: data.y, z: data.z,
            qx: data.hqx, qy: data.hqy, qz: data.hqz, qw: data.hqw
          },
          leftHand: null,
          rightHand: null
        };
        if (typeof data.lhx === 'number') {
          rd.leftHand = {
            x: data.lhx, y: data.lhy, z: data.lhz,
            qx: data.lhqx, qy: data.lhqy, qz: data.lhqz, qw: data.lhqw
          };
        }
        if (typeof data.rhx === 'number') {
          rd.rightHand = {
            x: data.rhx, y: data.rhy, z: data.rhz,
            qx: data.rhqx, qy: data.rhqy, qz: data.rhqz, qw: data.rhqw
          };
        }
        return rd;
      }
      return null;
    },

    _resolveBagSeed: function (bagSeed) {
      if (bagSeed != null) return bagSeed >>> 0;
      if (global.lobbyState && global.lobbyState.bagSeed != null) {
        return global.lobbyState.bagSeed >>> 0;
      }
      return global.StacksShapes.newBagSeed
        ? global.StacksShapes.newBagSeed()
        : ((Date.now() ^ (Math.random() * 0x100000000)) >>> 0);
    },

    /** Fair mirrored bags: same seed for local + both bots / both seats. */
    _applyMirroredBags: function (bagSeed) {
      var seed = this._resolveBagSeed(bagSeed);
      this.bagSeed = seed;
      if (global.lobbyState) global.lobbyState.bagSeed = seed;
      this.bag = new global.StacksShapes.ShapeBag(seed);
      if (this.bot) this.bot.reset(seed);
      if (this.botBlue) this.botBlue.reset(seed);
      return seed;
    },

    onMatchStarted: function (mp, startTime, isBotMatch, bagSeed) {
      this.matchActive = true;
      this.matchState = 'PLAYING';
      var spectating = !!(global.isMobileSpectator ||
        (global.isSpectator && global.isMultiplayer &&
          !(global.StacksLobby && global.StacksLobby.amMatchPlayer && global.StacksLobby.amMatchPlayer())));
      // Spectators must NOT clear — late-join snapshot would be wiped by match-started
      if (!spectating) {
        this.cups.blue.clearAll();
        this.cups.red.clearAll();
      }
      if (this._sceneRoot) this._sceneRoot.visible = true;
      this.clearSysBlue = new global.StacksClear();
      this.clearSysRed = new global.StacksClear();
      this.clearSys = this.clearSysBlue;
      this.attackSys.reset();
      this.modes.setMode(this.data.mode);
      this.modes.start(startTime || Date.now());
      if (this.matchStats) this.matchStats.start(performance.now());
      this.playerScore = 0;
      this.botScore = 0;
      this._applyMirroredBags(bagSeed);
      this._cancelHold();
      this._pocketType = null;
      this._pocketUsed = false;
      this._refreshPocketMesh();
      this._setRemoteHeld('blue', { holding: false });
      this._setRemoteHeld('red', { holding: false });
      // Spectators mirror host board — no local spawn pad
      if (!spectating) this._spawnPadPiece({ dropIn: true });
      else if (this._pad) this._pad.visible = false;
      this._dualBotPreview = false;
      if (this.botBlue) this.botBlue.enable(false);
      if (this.bot) {
        // reset() already applied seed in _applyMirroredBags
        this.bot.setCup(this.cups.red);
        // Only the host (or offline) runs the red bot AI; spectators receive poses
        var isBotSeat = !!isBotMatch || (mp && mp.red === '__BOT__');
        var runBot = (!spectating) && isBotSeat;
        // Show red pad/pocket to everyone in a bot match (host animates; peers see platforms)
        this._setBotStationVisible(!!isBotSeat);
        this.bot.enable(runBot);
        if (runBot) this.bot.setTargetPpm(12);
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
      this._dualBotPreview = false;
      if (this.bot) this.bot.enable(false);
      if (this.botBlue) this.botBlue.enable(false);
      this._setBotStationVisible(false);
      this._clearBotHoldMesh('blue');
      this._clearBotStationPieces('blue');
      if (window.matchRecorder && window.matchRecorder.isRecording) {
        var replay = window.matchRecorder.stopRecording();
        if (replay && window.matchReplayStorage) window.matchReplayStorage.save(replay);
      }
      this._saveMatchHistory();
      this._updateHUD();
    },

    startOfflineBotMatch: function () {
      // If hosting a lobby, never stay offline-only — spectators need match-started.
      if (global.StacksLobby && global.StacksLobby.isHost && global.startLobbyMatch) {
        global.startLobbyMatch();
        return;
      }
      global.isLobbyBotMatch = true;
      var seed = global.StacksShapes.newBagSeed
        ? global.StacksShapes.newBagSeed()
        : ((Date.now() ^ (Math.random() * 0x100000000)) >>> 0);
      this.onMatchStarted({ blue: 'local', red: '__BOT__' }, Date.now(), true, seed);
    },

    /**
     * DodgeVR-style mobile Offline Preview: two local bots play each other.
     * No network, orbit camera watches blue pad vs red pad.
     */
    startOfflinePreviewMatch: function () {
      global.offlinePreview = true;
      global.isLobbyBotMatch = true;
      this._dualBotPreview = true;
      this.matchActive = true;
      this.matchState = 'PLAYING';

      this.cups.blue.clearAll();
      this.cups.red.clearAll();
      this.clearSysBlue = new global.StacksClear();
      this.clearSysRed = new global.StacksClear();
      this.clearSys = this.clearSysBlue;
      this.attackSys.reset();
      this.modes.setMode(this.data.mode);
      this.modes.start(Date.now());
      if (this.matchStats) this.matchStats.start(performance.now());
      this.playerScore = 0;
      this.botScore = 0;
      var seed = this._applyMirroredBags(null);
      this._cancelHold();
      this._pocketType = null;
      this._pocketUsed = false;
      this._nextType = null;

      // Human pad/pocket become the blue bot station
      this._clearBotStationPieces('blue');
      this._clearBotStationPieces('red');
      this._clearBotHoldMesh('blue');
      this._clearBotHoldMesh('red');
      if (this._pad) this._pad.visible = true;
      if (this._pocket) this._pocket.visible = true;
      this._setBotStationVisible(true);

      if (this.bot) {
        this.bot.setCup(this.cups.red);
        this.bot._lastThink = performance.now() - 400;
        this.bot.setTargetPpm(14);
        this.bot.enable(true);
      }
      if (this.botBlue) {
        this.botBlue.setCup(this.cups.blue);
        this.botBlue._lastThink = performance.now();
        this.botBlue.setTargetPpm(13);
        this.botBlue.enable(true);
      }

      // Hide avatar bodies until we can drive accurate place motions
      this._hideBotBodies();

      this._updateHUD();
      console.log('[StacksGame] offline preview: blue bot vs red bot seed=' + seed);
    },

    _hideBotBodies: function () {
      var ids = ['bot-body', 'spec-blue-body', 'player-body'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (!el) continue;
        el.setAttribute('visible', false);
        if (el.object3D) el.object3D.visible = false;
        if (el.dataset) el.dataset.posed = '';
      }
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
      var blueScore = document.getElementById('blue-score');
      var redScore = document.getElementById('red-score');
      if (blueScore) blueScore.setAttribute('text', 'value', String(this.modes.scores.blue | 0));
      if (redScore) redScore.setAttribute('text', 'value', String(this.modes.scores.red | 0));

      this._updateCupStatsHUD();
      var hint = document.getElementById('control-hint');
      if (hint) {
        var msg = '';
        if (this._cupGrab) msg = 'Twist = yaw · raise/lower = height';
        else if (this.held) {
          msg = this.ghostValid
            ? 'Release to place'
            : 'Aim over cup to snap';
        }
        hint.setAttribute('text', 'value', msg);
      }
    },

    _setTextValue: function (id, value) {
      var el = document.getElementById(id);
      if (!el) return;
      if (el.tagName && String(el.tagName).toLowerCase() === 'a-text') {
        el.setAttribute('value', value);
      } else {
        el.setAttribute('text', 'value', value);
      }
    },

    /** BattleBlocks station card: one canvas — Blocks / Attacks / Time, italic, no name. */
    _ensureStationCard: function (side) {
      if (!this._stationCards) this._stationCards = {};
      if (this._stationCards[side]) return this._stationCards[side];
      if (!this._sceneRoot) return null;
      var canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 700;
      var tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      var mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide
      });
      var mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.66), mat);
      mesh.frustumCulled = false;
      this._sceneRoot.add(mesh);
      var card = { mesh: mesh, canvas: canvas, tex: tex, mat: mat };
      this._stationCards[side] = card;
      return card;
    },

    _drawStationCard: function (side, stats, now) {
      var card = this._ensureStationCard(side);
      if (!card || !stats) return;
      var f = stats.cardFields(now);
      var ctx = card.canvas.getContext('2d');
      var W = card.canvas.width;
      var H = card.canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#ffffff';

      var y = 8;
      function label(t) {
        ctx.font = 'italic 600 48px Arial, Helvetica, sans-serif';
        ctx.globalAlpha = 1;
        ctx.fillText(t, 8, y);
        y += 58;
      }
      function row(main, rate) {
        ctx.font = 'italic 700 92px Arial, Helvetica, sans-serif';
        ctx.globalAlpha = 1;
        ctx.fillText(String(main), 8, y);
        if (rate != null && rate !== '') {
          ctx.font = 'italic 600 56px Arial, Helvetica, sans-serif';
          ctx.fillText(String(rate), 250, y + 22);
        }
        y += 118;
      }

      label('Blocks');
      row(f.blocks, f.blockRate);
      label('Attacks');
      row(f.attacks, f.attackRate);
      label('Time');
      row(f.time, null);

      card.tex.needsUpdate = true;
      card.mesh.visible = true;
    },

    _updateCupStatsHUD: function () {
      if (!this.matchStats) return;
      var now = performance.now();
      var blue = this.matchStats.blue;
      var red = this.matchStats.red;

      this._drawStationCard('blue', blue, now);
      this._drawStationCard('red', red, now);

      // Hidden test mirrors (card / cup panels)
      var blueEl = document.getElementById('stats-blue');
      var redEl = document.getElementById('stats-red');
      if (blueEl) blueEl.setAttribute('text', 'value', blue.cardText(now));
      if (redEl) redEl.setAttribute('text', 'value', red.cardText(now));
      var blueCup = document.getElementById('cup-stats-blue');
      var redCup = document.getElementById('cup-stats-red');
      if (blueCup) blueCup.setAttribute('text', 'value', blue.cupText(now));
      if (redCup) redCup.setAttribute('text', 'value', red.cupText(now));
    },

    /** Bake a neon void into scene.environment for IBL reflections. */
    _setupArenaEnvMap: function (sceneEl) {
      if (!sceneEl || !sceneEl.renderer || !THREE.PMREMGenerator) return null;
      if (this._envMap) return this._envMap;
      var renderer = sceneEl.renderer;
      var bake = new THREE.Scene();
      bake.add(new THREE.AmbientLight(0xffffff, 0.15));
      bake.add(new THREE.HemisphereLight(0xaa88cc, 0x100818, 1.4));
      function glowOrb(color, x, y, z, s) {
        var m = new THREE.Mesh(
          new THREE.SphereGeometry(s || 0.6, 16, 16),
          new THREE.MeshBasicMaterial({ color: color })
        );
        m.position.set(x, y, z);
        bake.add(m);
      }
      glowOrb(0x66ddff, -4, 2.5, 3, 0.9);
      glowOrb(0xff7744, 4, 2.2, -3, 0.9);
      glowOrb(0xffe8d8, 0, 6, 1, 1.6);
      glowOrb(0x331144, 0, -2, 0, 3.5);
      var pmrem = new THREE.PMREMGenerator(renderer);
      var rt = pmrem.fromScene(bake, 0.06);
      this._envMap = rt.texture;
      pmrem.dispose();
      bake.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      return this._envMap;
    },

    /** BattleBlocks-like void arena: glossy floor, IBL, neon lamps, soft shadows. */
    _buildArenaAtmosphere: function (blueC, redC) {
      var root = this._sceneRoot;
      if (!root || this._arenaBuilt) return;
      this._arenaBuilt = true;

      var sceneEl = this.el.sceneEl;
      var scene3d = sceneEl && sceneEl.object3D;
      if (scene3d) {
        scene3d.fog = new THREE.FogExp2(0x09060c, 0.010);
        sceneEl.setAttribute('background', 'color', '#06040a');
      }
      if (sceneEl && sceneEl.renderer) {
        sceneEl.renderer.shadowMap.enabled = true;
        sceneEl.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        if (sceneEl.renderer.toneMappingExposure != null) {
          sceneEl.renderer.toneMappingExposure = 1.12;
        }
      }

      var envMap = this._setupArenaEnvMap(sceneEl);
      if (envMap && scene3d) {
        scene3d.environment = envMap;
        if (scene3d.environmentIntensity != null) scene3d.environmentIntensity = 0.95;
      }

      // Glossy dark floor — picks up IBL + neon (BattleBlocks reflections)
      var groundMat = new THREE.MeshStandardMaterial({
        color: 0x06070c,
        roughness: 0.16,
        metalness: 0.92,
        envMapIntensity: 1.6
      });
      if (envMap) groundMat.envMap = envMap;
      var ground = new THREE.Mesh(new THREE.CircleGeometry(7.5, 64), groundMat);
      ground.rotation.x = -Math.PI / 2;
      ground.position.y = 0.001;
      ground.receiveShadow = true;
      root.add(ground);
      this._groundMat = groundMat;

      // Soft radial neon under-glow (additive so it reads as floor bloom)
      var underGlow = new THREE.Mesh(
        new THREE.CircleGeometry(3.4, 48),
        new THREE.MeshBasicMaterial({
          color: 0x3a1858,
          transparent: true,
          opacity: 0.28,
          toneMapped: false,
          depthWrite: false,
          blending: THREE.AdditiveBlending
        })
      );
      underGlow.rotation.x = -Math.PI / 2;
      underGlow.position.y = 0.012;
      root.add(underGlow);

      function stationPlate(cx, cz, color) {
        var g = new THREE.Group();
        g.position.set(cx, 0.015, cz);
        var plateMat = new THREE.MeshStandardMaterial({
          color: 0x080a12,
          roughness: 0.22,
          metalness: 0.85,
          envMapIntensity: 1.4,
          transparent: true,
          opacity: 0.92
        });
        if (envMap) plateMat.envMap = envMap;
        var plate = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.15), plateMat);
        plate.rotation.x = -Math.PI / 2;
        plate.receiveShadow = true;
        g.add(plate);
        var edge = new THREE.Mesh(
          new THREE.RingGeometry(0.72, 0.76, 4),
          new THREE.MeshBasicMaterial({
            color: color, transparent: true, opacity: 0.95,
            side: THREE.DoubleSide, toneMapped: false
          })
        );
        edge.rotation.x = -Math.PI / 2;
        edge.rotation.z = Math.PI / 4;
        g.add(edge);
        var edge2 = new THREE.Mesh(
          new THREE.RingGeometry(0.58, 0.61, 4),
          new THREE.MeshBasicMaterial({
            color: color, transparent: true, opacity: 0.4,
            side: THREE.DoubleSide, toneMapped: false
          })
        );
        edge2.rotation.x = -Math.PI / 2;
        edge2.rotation.z = Math.PI / 4;
        g.add(edge2);
        root.add(g);
        return g;
      }
      stationPlate(blueC.x, blueC.z, 0x33bbff);
      stationPlate(redC.x, redC.z, 0xff6a3d);

      // Distant horizon band
      var horizon = new THREE.Mesh(
        new THREE.CylinderGeometry(9.5, 9.5, 1.6, 48, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x1a0a18,
          transparent: true,
          opacity: 0.55,
          side: THREE.BackSide,
          depthWrite: false,
          toneMapped: false
        })
      );
      horizon.position.y = 0.7;
      root.add(horizon);

      var haze = new THREE.Mesh(
        new THREE.CylinderGeometry(9.2, 9.2, 0.8, 48, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0x4a1838,
          transparent: true,
          opacity: 0.2,
          side: THREE.BackSide,
          depthWrite: false,
          toneMapped: false
        })
      );
      haze.position.y = 1.4;
      root.add(haze);

      // Neon station lamps — light the white blocks + feed glossy floor
      var blueLamp = new THREE.PointLight(0x66ddff, 1.4, 6.5, 1.6);
      blueLamp.position.set(blueC.x, 2.35, blueC.z + 0.15);
      root.add(blueLamp);
      var blueRim = new THREE.PointLight(0x33bbff, 0.7, 3.5, 2);
      blueRim.position.set(blueC.x + 0.55, 1.35, blueC.z);
      root.add(blueRim);
      var redLamp = new THREE.PointLight(0xff8855, 1.3, 6.5, 1.6);
      redLamp.position.set(redC.x, 2.35, redC.z - 0.15);
      root.add(redLamp);
      var redRim = new THREE.PointLight(0xff6a3d, 0.7, 3.5, 2);
      redRim.position.set(redC.x - 0.55, 1.35, redC.z);
      root.add(redRim);
      // Soft overhead fill for block tops
      var keyFill = new THREE.PointLight(0xfff0e8, 0.55, 10, 1.8);
      keyFill.position.set(0, 4.2, 0.4);
      root.add(keyFill);
    },

    _prepareMatchHud: function () {
      // Legacy a-text cards stay hidden; canvas station cards are the HUD
      var hideIds = [
        'hud-card-blue', 'hud-card-red', 'hud-cup-blue', 'hud-cup-red',
        'hud-name-blue', 'hud-name-red'
      ];
      for (var h = 0; h < hideIds.length; h++) {
        var hide = document.getElementById(hideIds[h]);
        if (!hide) continue;
        hide.setAttribute('visible', false);
        if (hide.object3D) hide.object3D.visible = false;
      }
      this._hudPrepared = true;
    },

    _placeMatchHud: function () {
      if (!this.cups) return;
      this._placeStationCard('blue');
      this._placeStationCard('red');
    },

    _placeStationCard: function (side) {
      var card = this._ensureStationCard(side);
      if (!card || !card.mesh) return;
      var L = this._layout || {};
      var pad = side === 'blue' ? L.bluePad : L.redPad;
      var next = side === 'blue' ? L.blueNext : L.redNext;
      if (!pad || !next) return;

      // Flush right of NEXT — mid-height of the frame (BattleBlocks)
      var outboard = side === 'blue' ? 1 : -1;
      var yaw = side === 'blue' ? 0 : Math.PI;
      card.mesh.position.set(
        next.x + outboard * 0.34,
        (pad.y || 1.12) + 0.78,
        next.z
      );
      card.mesh.rotation.set(0, yaw, 0);
      card.mesh.visible = true;
    },

    /** Bot pace tracks player (or rival bot) PPM with built-in wander. */
    _updateBotPace: function () {
      if (!this.matchStats) return;
      var now = performance.now();
      var blue = this.matchStats.blue;
      var red = this.matchStats.red;

      if (this.bot && this.bot.enabled) {
        var targetPpm;
        if (this._dualBotPreview) {
          // Dual demo: each bot loosely tracks the other / shared mid pace
          targetPpm = red.pieces >= 3 ? red.ppmRolling(now) : 14;
          if (blue.pieces >= 3) targetPpm = 0.55 * targetPpm + 0.45 * blue.ppmRolling(now);
        } else if (blue.pieces >= 3) {
          targetPpm = blue.ppmRolling(now);
        } else {
          targetPpm = 12;
        }
        this.bot.setTargetPpm(targetPpm, now);
      }
      if (this.botBlue && this.botBlue.enabled) {
        var blueTarget = red.pieces >= 3 ? red.ppmRolling(now) : 13;
        if (blue.pieces >= 3) blueTarget = 0.5 * blueTarget + 0.5 * blue.ppmRolling(now);
        this.botBlue.setTargetPpm(blueTarget, now);
      }
    },

    _updateDamageHUD: function () {
      var now = performance.now();
      this._updateThreat('blue', now);
      this._updateThreat('red', now);
      if (this.cups.blue && this.cups.blue.tickHighLine) this.cups.blue.tickHighLine(now);
      if (this.cups.red && this.cups.red.tickHighLine) this.cups.red.tickHighLine(now);
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
        if (pending <= 0) {
          dEl.setAttribute('visible', false);
          dEl.setAttribute('text', 'value', '');
        } else {
          var sec = (minReady < Infinity)
            ? Math.max(0, (minReady - now) / 1000).toFixed(1) + 's'
            : '';
          dEl.setAttribute('visible', true);
          dEl.setAttribute('text', 'value', 'IN ' + pending + (sec ? '  ' + sec : ''));
          dEl.setAttribute('text', 'color', urgency > 0.55 ? '#ff8866' : '#ccccaa');
        }
      }
    },

    _packWorld: function (obj3d) {
      if (!obj3d) return null;
      obj3d.updateWorldMatrix(true, false);
      var p = new THREE.Vector3();
      var q = new THREE.Quaternion();
      obj3d.getWorldPosition(p);
      obj3d.getWorldQuaternion(q);
      return { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
    },

    _packEl: function (el) {
      return el ? this._packWorld(el.object3D) : null;
    },

    _packMixamoBone: function (bodyEl, boneKey) {
      var mb = bodyEl && bodyEl.components && bodyEl.components['mixamo-body'];
      if (mb && mb.bones && mb.bones[boneKey]) {
        return this._packWorld(mb.bones[boneKey]);
      }
      return bodyEl ? this._packWorld(bodyEl.object3D) : null;
    },

    _sendLocalPose: function () {
      if (!global.isMultiplayer || !global.sendPlayerPose) return;
      if (global.isMobileSpectator) return;

      var host = global.StacksLobby && global.StacksLobby.isHost;
      var seated = global.StacksLobby && global.StacksLobby.amMatchPlayer &&
        global.StacksLobby.amMatchPlayer();
      var hasPeers = host
        ? (global.StacksLobby.connections && global.StacksLobby.connections.length > 0)
        : !!(global.StacksLobby.conn && global.StacksLobby.conn.open);
      // DodgeVR: stream whenever multiplayer + peers exist (not only after matchActive)
      if (!hasPeers) return;
      if (!host && !seated) return;

      var now = performance.now();
      if (now - this._lastPoseSend < 50) return;
      this._lastPoseSend = now;

      var cam = document.getElementById('camera');
      var lh = document.getElementById('leftHand');
      var rh = document.getElementById('rightHand');
      if (!cam) return;

      var head = this._packEl(cam);
      if (!head) return;
      var left = this._packEl(lh);
      var right = this._packEl(rh);
      // Skip untracked controllers parked at origin (DodgeVR)
      if (left && (left.x * left.x + left.y * left.y + left.z * left.z) < 0.001) left = null;
      if (right && (right.x * right.x + right.y * right.y + right.z * right.z) < 0.001) right = null;

      // Nested + flat fields so any consumer can read the pose
      global.sendPlayerPose({
        head: head,
        leftHand: left,
        rightHand: right,
        x: head.x, y: head.y, z: head.z,
        hqx: head.qx, hqy: head.qy, hqz: head.qz, hqw: head.qw,
        lhx: left ? left.x : undefined,
        lhy: left ? left.y : undefined,
        lhz: left ? left.z : undefined,
        lhqx: left ? left.qx : undefined,
        lhqy: left ? left.qy : undefined,
        lhqz: left ? left.qz : undefined,
        lhqw: left ? left.qw : undefined,
        rhx: right ? right.x : undefined,
        rhy: right ? right.y : undefined,
        rhz: right ? right.z : undefined,
        rhqx: right ? right.qx : undefined,
        rhqy: right ? right.qy : undefined,
        rhqz: right ? right.qz : undefined,
        rhqw: right ? right.qw : undefined
      });
      this._poseSendCount = (this._poseSendCount || 0) + 1;

      // Stream red bot skeleton so spectators match host bot motion
      var redIsBot = global.isLobbyBotMatch ||
        (global.lobbyState && global.lobbyState.matchPlayers &&
          global.lobbyState.matchPlayers.red === '__BOT__');
      if (host && redIsBot && this.matchActive) {
        var botBody = document.getElementById('bot-body');
        if (botBody) {
          var bh = this._packMixamoBone(botBody, 'head') || this._packEl(botBody);
          var bl = this._packMixamoBone(botBody, 'leftHandBone');
          var br = this._packMixamoBone(botBody, 'rightHandBone');
          if (bh) {
            global.sendPlayerPose({
              from: '__BOT__',
              head: bh,
              leftHand: bl,
              rightHand: br,
              x: bh.x, y: bh.y, z: bh.z,
              hqx: bh.qx, hqy: bh.qy, hqz: bh.qz, hqw: bh.qw
            });
          }
        }
      }

      if (this.held && now - (this._lastHoldSend || 0) > 100) {
        this._lastHoldSend = now;
        this._broadcastHold();
      }
    },

    _heartbeatSpectatorSync: function () {
      if (!(global.StacksLobby && global.StacksLobby.isHost)) return;
      if (!this.matchActive) return;
      if (!global.StacksLobby.connections || !global.StacksLobby.connections.length) return;
      var now = performance.now();
      if (now - (this._lastSpecSync || 0) < 750) return;
      this._lastSpecSync = now;
      // Keep lobby PLAYING published if host started offline then got spectators
      if (typeof global.ensureLobbyMatchPublished === 'function') {
        global.ensureLobbyMatchPublished();
      }
      if (global.lobbyState && global.lobbyState.matchScore && this.modes && this.modes.scores) {
        global.lobbyState.matchScore.blue = this.modes.scores.blue;
        global.lobbyState.matchScore.red = this.modes.scores.red;
      }
      if (typeof global.sendCupSnapshot === 'function') {
        global.sendCupSnapshot(this._buildSnapshot());
      } else {
        this._broadcastState('heartbeat');
      }
    },

    tick: function () {
      if (!this._sceneRoot) return;
      if (this._poseDesktop) this._poseDesktop();
      this._tickPieceAnims();
      this._prepareMatchHud();
      this._placeMatchHud();

      this._updateCupGrab();

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
        this._updateBotPace();
        if (this.bot && this.bot.enabled) this.bot.tick(performance.now());
        if (this.botBlue && this.botBlue.enabled) this.botBlue.tick(performance.now());
        if (this._dualBotPreview) this._hideBotBodies();
        // Refresh PPM / timer on cup-side stats ~4Hz
        if (!this._lastStatsHud || performance.now() - this._lastStatsHud > 250) {
          this._lastStatsHud = performance.now();
          this._updateCupStatsHUD();
        }
        this._heartbeatSpectatorSync();
      } else {
        if (this.cups.blue) this.cups.blue.setThreat(0);
        if (this.cups.red) this.cups.red.setThreat(0);
      }

      // After bot/player sim so bone packs match what host renders
      this._sendLocalPose();

      if (window.matchRecorder && window.matchRecorder.tick) window.matchRecorder.tick();
    }
  });
})(window);
