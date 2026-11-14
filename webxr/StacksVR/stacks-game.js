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
  // Battle Blocks inactivity pressure — late-match urgency, not from GO.
  // No junk until MATCH_ARM after GO; then GRACE idle → 1 layer every INTERVAL.
  var INACTIVE_MATCH_ARM_MS = 60000;
  var INACTIVE_GRACE_MS = 10000;
  var INACTIVE_INTERVAL_MS = 4000;

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
      this.bags = { blue: this.bag, red: new global.StacksShapes.ShapeBag() };
      this.bot = null;
      this._remoteBodyMap = {}; // playerId -> element id
      this._nextTypeBySide = { blue: null, red: null };
      this._pocketTypeBySide = { blue: null, red: null };
      this.botTargetBpm = (global.StacksBotBpm && global.StacksBotBpm.load)
        ? global.StacksBotBpm.load()
        : (global._botTargetBpm != null ? global._botTargetBpm : 12);

      this.held = null; // { mesh, type, rot, handEl }
      this.ghostMesh = null;
      this.ghostCells = null;
      this.ghostValid = false;

      this.matchActive = false;
      this.localSide = 'blue';
      this.playerScore = 0;
      this.botScore = 0;
      this.matchState = 'WAITING';
      this.boardSize = 6;

      this._sceneRoot = null;
      this._pad = null;
      this._padMesh = null;
      this._padPiece = null;
      this._previewPiece = null;
      this._nextType = null;
      this._pieceAnims = [];
      this._pocket = null;
      this._pocketMesh = null;
      this._pocketType = null; // stashed shape type or null (local side)
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
      this.el.sceneEl.addEventListener('lobby-state-updated', function () {
        self._pruneRemoteAvatarsToLobby();
        self._updateNameLabels();
      });

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
        chain('onReplayMsg', self.onRemoteReplayMsg);
        chain('onDisconnected', self.onHostDisconnected);
        global.StacksLobby.onRequestSnapshot = function () {
          return self._buildSnapshot();
        };
      }
      // Stable entry point so lobby.js can apply poses even if callbacks were rebound
      global.applyStacksRemotePose = function (fromId, data) {
        self.onRemotePlayerPose(fromId, data);
      };
      global.clearStacksRemoteAvatars = function () {
        self._clearAllRemoteAvatars();
      };

      this._bindInput();
    },

    _boot: function () {
      if (this._sceneRoot) return;
      this._fpsFrames = 0;
      this._fpsLast = performance.now();
      this._fpsValue = 0;
      this._refreshVersionDisplay();
      var scene = this.el.sceneEl.object3D;
      this._sceneRoot = new THREE.Group();
      this._sceneRoot.name = 'stacks-arena';
      scene.add(this._sceneRoot);

      // Layout from BattleBlocks screenshot:
      // - POSITION is diagonal (blue left-near, red right-far)
      // - ROTATION stays axis-aligned — cups face each other head-on along Z
      //   (floor squares are not diamond-rotated).
      var boardSize = (global.getBoardSize && global.getBoardSize()) || 6;
      this.boardSize = boardSize === 4 ? 4 : 6;
      var CUP_Y = 0.92;
      var CUP_HALF = (this.boardSize * CELL) / 2;
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
        width: this.boardSize, depth: this.boardSize, height: 12,
        position: cornerFromCenter(blueC)
      });
      var red = new global.StacksCup({
        id: 'red', side: 'red',
        width: this.boardSize, depth: this.boardSize, height: 12,
        position: cornerFromCenter(redC)
      });
      this.cups.blue = blue;
      this.cups.red = red;
      this._sceneRoot.add(blue.pivot || blue.root);
      this._sceneRoot.add(red.pivot || red.root);
      if (blue.pivot) { blue.pivot.rotation.y = blueYaw; blue.yaw = blueYaw; }
      if (red.pivot) { red.pivot.rotation.y = redYaw; red.yaw = redYaw; }

      // BattleBlocks station: compact NEXT + pad/pocket under it
      var blueNextPos = offsetBlue(-0.40, 0.85);
      var bluePadPos = offsetBlue(-0.60, 0.55);
      var bluePocketPos = offsetBlue(-0.60, 1.15);
      var redNextPos = offsetRed(-0.40, 0.85);
      var redPadPos = offsetRed(-0.60, 0.55);
      var redPocketPos = offsetRed(-0.60, 1.15);

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
        // Snug trapezoid around 3 pieces (not an empty tower)
        var fwTop = 0.22, fwBot = 0.28, fh = 0.72, r = 0.04, tube = 0.008;
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
        frame.position.y = 0.50;
        root.add(frame);
        // "NEXT" label — just above frame
        var canvas = document.createElement('canvas');
        canvas.width = 256; canvas.height = 64;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, 256, 64);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'italic 700 44px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('NEXT', 128, 32);
        var label = new THREE.Mesh(
          new THREE.PlaneGeometry(0.18, 0.045),
          new THREE.MeshBasicMaterial({
            map: new THREE.CanvasTexture(canvas),
            transparent: true, depthWrite: false, toneMapped: false, depthTest: false
          })
        );
        label.position.set(0, 0.90, 0.02);
        label.renderOrder = 21;
        root.add(label);
        var slots = new THREE.Group();
        slots.name = 'nextSlots';
        slots.position.set(0, 0.22, 0);
        root.add(slots);
        this._sceneRoot.add(root);
        return { root: root, slots: slots, frameH: fh, frameY: 0.50 };
      }

      this._pad = new THREE.Group();
      this._pad.position.set(bluePadPos.x, bluePadPos.y, bluePadPos.z);
      this._sceneRoot.add(this._pad);
      this._padMesh = neonDiamond(0.15, 0x33bbff);
      this._pad.add(this._padMesh);

      this._pocket = new THREE.Group();
      this._pocket.position.set(bluePocketPos.x, bluePocketPos.y, bluePocketPos.z);
      this._sceneRoot.add(this._pocket);
      this._pocket.add(neonDiamond(0.15, 0x33bbff));
      this._pocketType = null;
      this._pocketUsed = false;

      var blueNext = buildNextColumn.call(this, blueNextPos, 0x33bbff, 0);
      this._nextBlue = blueNext;

      this._botPad = new THREE.Group();
      this._botPad.position.set(redPadPos.x, redPadPos.y, redPadPos.z);
      this._sceneRoot.add(this._botPad);
      this._botPad.add(neonDiamond(0.15, 0xff6a3d));
      this._botPadPiece = null;

      this._botPocket = new THREE.Group();
      this._botPocket.position.set(redPocketPos.x, redPocketPos.y, redPocketPos.z);
      this._sceneRoot.add(this._botPocket);
      this._botPocket.add(neonDiamond(0.15, 0xff6a3d));
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
      if (this.bot && this.bot.setTargetBpm) this.bot.setTargetBpm(this.botTargetBpm);
      if (this.botBlue && this.botBlue.setTargetBpm) this.botBlue.setTargetBpm(this.botTargetBpm);
      this._setBotStationVisible(false);

      // No human pad piece until a real match — idle uses dual-bot preview
      this._nextType = null;
      this._padPiece = null;
      this._updateHUD();
      this._desktopHands();

      var selfBoot = this;
      this.el.sceneEl.addEventListener('board-size-changed', function (e) {
        var sz = e && e.detail && e.detail.boardSize;
        selfBoot.applyBoardSize(sz);
      });
      this.el.sceneEl.addEventListener('lobby-state-updated', function () {
        if (global.getBoardSize) selfBoot.applyBoardSize(global.getBoardSize());
        selfBoot._updateNameLabels();
      });
      this._updateNameLabels();
      console.log('[StacksGame] ready board=' + this.boardSize + 'x' + this.boardSize);
    },

    /**
     * Resize both cups to 4×4 or 6×6. Keeps world centers. Clears cells.
     * Called from lobby boardSize sync (host toggle / peer lobby-state / match-started).
     */
    applyBoardSize: function (size) {
      size = size === 4 ? 4 : 6;
      if (this.cups.blue && this.cups.blue.width === size &&
          this.cups.red && this.cups.red.width === size) {
        this.boardSize = size;
        return false;
      }
      this.boardSize = size;
      if (this.held && this._cancelHold) this._cancelHold();
      else if (this._clearGhost) this._clearGhost();
      if (this.cups.blue && this.cups.blue.resize) this.cups.blue.resize(size, size);
      if (this.cups.red && this.cups.red.resize) this.cups.red.resize(size, size);
      if (global.isMultiplayer && global.StacksLobby && global.StacksLobby.isHost &&
          this.matchActive && this._broadcastState) {
        this._broadcastState('board-resize');
      }
      return true;
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

    _isPieceUserData: function (ud) {
      if (!ud) return false;
      return !!(ud.botPadPiece || ud.padPiece || ud.padPreview || ud.botPocketPiece ||
        ud.pocketPiece || ud.nextPreview || ud.spawning);
    },

    _clearBotStationPieces: function (side) {
      var st = this._botStation(side);
      if (st.pad) {
        for (var i = st.pad.children.length - 1; i >= 0; i--) {
          var ch = st.pad.children[i];
          if (this._isPieceUserData(ch.userData)) st.pad.remove(ch);
        }
      }
      if (st.pocket) {
        for (var j = st.pocket.children.length - 1; j >= 0; j--) {
          var pch = st.pocket.children[j];
          if (this._isPieceUserData(pch.userData)) st.pocket.remove(pch);
        }
      }
      if (side === 'red') {
        this._botPadPiece = null;
        this._botPocketMesh = null;
      } else {
        this._padPiece = null;
        this._previewPiece = null;
        this._pocketMesh = null;
        this._nextType = null;
      }
    },

    /** Kill in-flight queue→pad tweens and any detached spawn meshes. */
    _clearPieceAnims: function () {
      var anims = this._pieceAnims || [];
      for (var i = 0; i < anims.length; i++) {
        var m = anims[i] && anims[i].mesh;
        if (m && m.parent) m.parent.remove(m);
      }
      this._pieceAnims = [];
      // Orphans attached to scene root during queue advance
      if (this._sceneRoot) {
        for (var c = this._sceneRoot.children.length - 1; c >= 0; c--) {
          var ch = this._sceneRoot.children[c];
          if (this._isPieceUserData(ch.userData)) this._sceneRoot.remove(ch);
        }
      }
    },

    _clearNextQueue: function (side) {
      var col = side === 'red' ? this._nextRed : this._nextBlue;
      if (!col || !col.slots) return;
      while (col.slots.children.length) col.slots.remove(col.slots.children[0]);
    },

    /** Full station wipe before a real match so dual-preview scraps can't overlap. */
    _resetStationsForMatch: function () {
      this._clearPieceAnims();
      this._clearBotStationPieces('blue');
      this._clearBotStationPieces('red');
      this._clearBotHoldMesh('blue');
      this._clearBotHoldMesh('red');
      this._clearNextQueue('blue');
      this._clearNextQueue('red');
      this._cancelHold();
      this._pocketType = null;
      this._pocketUsed = false;
      this._pocketTypeBySide = { blue: null, red: null };
      this._applyPocketVisual('blue', null);
      this._applyPocketVisual('red', null);
      this._nextType = null;
      this._nextTypeBySide = { blue: null, red: null };
      this._padPiece = null;
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
      // Human seats own their pad/pocket. bot.enable(false) emits pad:null —
      // that used to wipe the red spawn box in PvP right after _spawnBothPads
      // (blue was protected; red was not → client on red saw an empty pad).
      if (!this._dualBotPreview) {
        var mpVis = global.lobbyState && global.lobbyState.matchPlayers;
        var seatVis = mpVis && mpVis[side];
        if (seatVis && seatVis !== '__BOT__') return;
        // Offline / default: blue is always the human station
        if (side === 'blue' && !seatVis) return;
      }
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
        if (!this._dualBotPreview) this._broadcastStation(side);
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
        if (!evt.type || !st.pocket) {
          this._applyPocketVisual(side, null);
          if (!this._dualBotPreview) this._broadcastStation(side);
          return;
        }
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
        this._applyPocketVisual(side, evt.type);
        if (!this._dualBotPreview) this._broadcastStation(side);
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

    _sfx: function (name, opts) {
      if (global.StacksAudio && typeof global.StacksAudio.sfx === 'function') {
        global.StacksAudio.sfx(name, opts);
      }
    },

    _musicMatch: function () {
      if (global.StacksAudio && typeof global.StacksAudio.toMatch === 'function') {
        global.StacksAudio.toMatch();
      }
    },

    _musicIdle: function () {
      if (global.StacksAudio && typeof global.StacksAudio.toIdle === 'function') {
        global.StacksAudio.toIdle();
      }
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
      var ls = global.lobbyState;
      var Lobby = global.StacksLobby;
      var myId = global.myPlayerId || (Lobby && Lobby.myPlayerId);
      var mp = ls && ls.matchPlayers;
      var seated = !!(mp && myId &&
        (mp.blue === myId || (mp.red === myId && mp.red !== '__BOT__')));
      // Only seated humans control — host is NOT auto-granted control for bot
      // matches (that blocked spectating dual-bots / client-vs-bot).
      if (global.isMultiplayer && ls && ls.matchState === 'PLAYING') {
        return seated;
      }
      if (global.isSpectator && global.isMultiplayer && !seated) return false;
      return true;
    },

    _localCup: function () {
      var mp = global.lobbyState && global.lobbyState.matchPlayers;
      // PvP seat wins — NEVER let a sticky isLobbyBotMatch from a prior match force blue
      if (global.isMultiplayer && global.StacksLobby && global.StacksLobby.amMatchPlayer &&
          global.StacksLobby.amMatchPlayer()) {
        var side = global.StacksLobby.mySide ? global.StacksLobby.mySide() : 'blue';
        return this.cups[side] || this.cups.blue;
      }
      // Human vs bot: the grabbable pad is always the blue station
      var botMatch = !!(mp && mp.red === '__BOT__') || !!global.isLobbyBotMatch;
      if (botMatch) return this.cups.blue;
      return this.cups.blue;
    },

    _localSide: function () {
      var cup = this._localCup();
      return cup ? cup.side : 'blue';
    },

    _sideBag: function (side) {
      side = side || this._localSide();
      if (!this.bags) this.bags = { blue: this.bag, red: this.bag };
      if (side === 'red') {
        if (!this.bags.red) this.bags.red = this.bag;
        return this.bags.red;
      }
      if (!this.bags.blue) this.bags.blue = this.bag;
      return this.bags.blue;
    },

    _sidePad: function (side) {
      return side === 'red' ? this._botPad : this._pad;
    },

    _sidePocket: function (side) {
      return side === 'red' ? this._botPocket : this._pocket;
    },

    _sidePadPiece: function (side) {
      return side === 'red' ? this._botPadPiece : this._padPiece;
    },

    _setSidePadPiece: function (side, mesh) {
      if (side === 'red') this._botPadPiece = mesh;
      else this._padPiece = mesh;
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
      var side = this._localSide();
      var piece = this._sidePadPiece(side);
      if (!piece || !handEl) return Infinity;
      handEl.object3D.updateWorldMatrix(true, false);
      handEl.object3D.getWorldPosition(this._tmp);
      piece.updateWorldMatrix(true, false);
      piece.getWorldPosition(this._tmp2);
      return this._tmp.distanceTo(this._tmp2);
    },

    _pocketWorldPos: function (out) {
      var pocket = this._sidePocket(this._localSide());
      if (!pocket) return null;
      pocket.updateWorldMatrix(true, false);
      pocket.getWorldPosition(out);
      out.y += 0.1;
      return out;
    },

    _distToPocket: function (handEl) {
      var pocket = this._sidePocket(this._localSide());
      if (!pocket || !handEl) return Infinity;
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
      var side = this._localSide();
      this._applyPocketVisual(side, this._pocketType);
    },

    _applyPocketVisual: function (side, type) {
      side = side === 'red' ? 'red' : 'blue';
      if (!this._pocketTypeBySide) this._pocketTypeBySide = { blue: null, red: null };
      this._pocketTypeBySide[side] = type || null;
      if (side === this._localSide()) this._pocketType = type || null;
      var pocket = this._sidePocket(side);
      if (!pocket) return;
      for (var i = pocket.children.length - 1; i >= 0; i--) {
        var ch = pocket.children[i];
        if (ch.userData && (ch.userData.pocketPiece || ch.userData.botPocketPiece)) {
          pocket.remove(ch);
        }
      }
      if (side === 'red') this._botPocketMesh = null;
      else this._pocketMesh = null;
      if (!type) return;
      var mesh = global.StacksShapes.createShapeMesh(type, {
        centerPivot: true, rotationY: 0
      });
      mesh.userData.pocketPiece = true;
      if (side === 'red') mesh.userData.botPocketPiece = true;
      mesh.position.set(0, 0.1, 0);
      this._fitStationPiece(mesh, 0.30);
      pocket.add(mesh);
      if (side === 'red') this._botPocketMesh = mesh;
      else this._pocketMesh = mesh;
    },

    /** Absolute pad + NEXT + pocket visuals for one side (no bag.advance). */
    _serializeStation: function (side) {
      side = side === 'red' ? 'red' : 'blue';
      var padType = (this._nextTypeBySide && this._nextTypeBySide[side]) || null;
      var next = [];
      var bag = this._sideBag(side);
      if (bag && bag.peek) next = bag.peek(this._nextQueueCount || 3);
      var pocketType = (this._pocketTypeBySide && this._pocketTypeBySide[side]) || null;
      if (side === this._localSide() && this._pocketType) pocketType = this._pocketType;
      return {
        side: side,
        padType: padType,
        next: next.slice(),
        pocketType: pocketType
      };
    },

    _applyStationVisual: function (data) {
      if (!data || !data.side) return;
      var side = data.side === 'red' ? 'red' : 'blue';
      var pad = this._sidePad(side);
      if (pad) {
        for (var i = pad.children.length - 1; i >= 0; i--) {
          var ch = pad.children[i];
          if (this._isPieceUserData(ch.userData)) pad.remove(ch);
        }
      }
      this._setSidePadPiece(side, null);
      if (!this._nextTypeBySide) this._nextTypeBySide = { blue: null, red: null };
      this._nextTypeBySide[side] = data.padType || null;
      if (side === this._localSide()) this._nextType = data.padType || null;

      if (data.padType && pad) {
        var mesh = global.StacksShapes.createShapeMesh(data.padType, {
          centerPivot: true, rotationY: 0
        });
        mesh.userData.padPiece = true;
        if (side === 'red') mesh.userData.botPadPiece = true;
        mesh.position.set(0, 0.1, 0);
        this._fitStationPiece(mesh, 0.30);
        pad.add(mesh);
        this._setSidePadPiece(side, mesh);
      }

      // NEXT column from absolute list (not bag.peek — avoids desync)
      var col = side === 'red' ? this._nextRed : this._nextBlue;
      if (col && col.slots) {
        while (col.slots.children.length) col.slots.remove(col.slots.children[0]);
        var peek = data.next || [];
        for (var n = 0; n < peek.length; n++) {
          var nm = global.StacksShapes.createShapeMesh(peek[n], {
            centerPivot: true, rotationY: 0
          });
          nm.userData.nextPreview = true;
          this._orientNextQueueMesh(nm);
          nm.position.set(0, this._nextSlotY(n), 0);
          nm.scale.setScalar(this._nextSlotScale(n));
          col.slots.add(nm);
        }
      }

      this._applyPocketVisual(side, data.pocketType || null);
    },

    _broadcastStation: function (side) {
      if (!global.isMultiplayer || !global.sendCupEvent) return;
      if (this._dualBotPreview) return;
      side = side || this._localSide();
      var st = this._serializeStation(side);
      global.sendCupEvent({
        kind: 'station',
        side: st.side,
        padType: st.padType,
        next: st.next,
        pocketType: st.pocketType
      });
    },

    /** Deposit held → pocket, or swap / take from pocket.
     *  Put-back into an empty pocket is always allowed.
     *  Swap (pocket already full) is one-shot until the next place. */
    _interactPocket: function (handEl) {
      if (!this._canControl()) return;
      if (!this.matchActive || this._dualBotPreview || this.matchState === 'COUNTDOWN') return;
      if (performance.now() < (this._pocketLockUntil || 0)) return;
      var side = this._localSide();
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
        this._applyPocketVisual(side, incoming);
        if (outgoing) {
          this._pocketUsed = true;
          this._spawnHeldType(handEl, outgoing);
        }
        this._pocketLockUntil = performance.now() + 350;
        this._pulseHaptic(handEl, 0.5, 50);
        this._broadcastHold();
        this._broadcastStation(side);
        this._updateHUD();
        return;
      }
      if (this._pocketType) {
        var take = this._pocketType;
        this._pocketType = null;
        this._applyPocketVisual(side, null);
        this._spawnHeldType(handEl, take);
        // Lock briefly so trigger-up / bounce cannot immediately re-deposit
        this._pocketLockUntil = performance.now() + 350;
        this._pulseHaptic(handEl, 0.5, 50);
        this._broadcastHold();
        this._broadcastStation(side);
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
      this._sfx('rotate');
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
        // Scene-root local — remotes parent under _sceneRoot
        if (this._sceneRoot) {
          this._sceneRoot.updateWorldMatrix(true, false);
          this._sceneRoot.worldToLocal(this._tmp);
        }
        payload.holding = true;
        payload.shapeType = this.held.type;
        payload.pos = { x: this._tmp.x, y: this._tmp.y, z: this._tmp.z };
        payload.quat = { x: this._tmpQ.x, y: this._tmpQ.y, z: this._tmpQ.z, w: this._tmpQ.w };
      }
      payload.pocketType = this._pocketType;
      payload.station = this._serializeStation(side);
      global.sendCupEvent(payload);
    },

    _buildSnapshot: function () {
      var held = { blue: null, red: null };
      var localSide = this._localSide();
      if (this.held && this.held.type) {
        held[localSide] = { holding: true, shapeType: this.held.type };
      }
      if (this._remoteHeld) {
        if (this._remoteHeld.blue && this._remoteHeld.blue.type) {
          held.blue = { holding: true, shapeType: this._remoteHeld.blue.type };
        }
        if (this._remoteHeld.red && this._remoteHeld.red.type) {
          held.red = { holding: true, shapeType: this._remoteHeld.red.type };
        }
      }
      return {
        blue: this.cups.blue.serialize(),
        red: this.cups.red.serialize(),
        scores: { blue: this.modes.scores.blue, red: this.modes.scores.red },
        attack: this.attackSys.serialize(),
        stations: {
          blue: this._serializeStation('blue'),
          red: this._serializeStation('red')
        },
        held: held
      };
    },

    _broadcastState: function (reason) {
      if (!global.sendCupEvent) return;
      global.sendCupEvent({
        kind: 'state',
        reason: reason || 'sync',
        scores: { blue: this.modes.scores.blue, red: this.modes.scores.red },
        cups: { blue: this.cups.blue.serialize(), red: this.cups.red.serialize() },
        attack: this.attackSys.serialize(),
        stations: {
          blue: this._serializeStation('blue'),
          red: this._serializeStation('red')
        }
      });
    },

    _applyRemoteCups: function (cups) {
      if (!cups) return;
      if (cups.blue) this.cups.blue.applySnapshot(cups.blue);
      if (cups.red) this.cups.red.applySnapshot(cups.red);
    },

    /**
     * True when this client owns gameplay for `side`.
     * Seat id is source of truth — NEVER trust stale isSpectator / canControl alone
     * (that let peer place/state wipe the host cup + pad).
     */
    _isLocalAuthoritySide: function (side) {
      if (!side) return false;
      if (this._isViewOnlyObserver()) return false;
      var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
      var mp = global.lobbyState && global.lobbyState.matchPlayers;
      if (global.isMultiplayer && mp && myId) {
        if (mp[side] === myId) return true;
        // Bot seats are never local-player authority (host may drive them as AI)
        return false;
      }
      // Offline / preview: player owns blue only
      if (!global.isMultiplayer) return side === 'blue';
      return side === this._localSide();
    },

    /**
     * VR / mobile / late-join watchers — must mirror BOTH cups/stations from host.
     * Seat id wins: queued humans are never "view-only" even if isSpectator flickered.
     */
    _isViewOnlyObserver: function () {
      if (global.isMobileSpectator) return true;
      if (!global.isMultiplayer) return false;
      var Lobby = global.StacksLobby;
      if (Lobby && typeof Lobby.amMatchPlayer === 'function' && Lobby.amMatchPlayer()) {
        return false;
      }
      var myId = global.myPlayerId || (Lobby && Lobby.myPlayerId);
      var mp = global.lobbyState && global.lobbyState.matchPlayers;
      if (mp && myId && (mp.blue === myId || (mp.red === myId && mp.red !== '__BOT__'))) {
        return false;
      }
      return !!(global.isSpectator || global.isMobileSpectator);
    },

    /**
     * Merge networked cups without clobbering the cup we own.
     * Always gate per-seat — never "force both" just because canControl flickered.
     * opts.forceSides = { blue: true, red: true } — host garbage / wipe authority.
     * View-only observers always take the full host picture.
     */
    _applyNetworkCups: function (cups, opts) {
      opts = opts || {};
      if (!cups) return;
      if (opts.forceAll || this._isViewOnlyObserver()) {
        this._applyRemoteCups(cups);
        return;
      }
      var force = opts.forceSides || null;
      if (cups.blue && (!this._isLocalAuthoritySide('blue') || (force && force.blue))) {
        this.cups.blue.applySnapshot(cups.blue);
      }
      if (cups.red && (!this._isLocalAuthoritySide('red') || (force && force.red))) {
        this.cups.red.applySnapshot(cups.red);
      }
    },

    /**
     * Host-only: push garbage that landed on one or more cups.
     * Peers MUST apply these cups even on their own seat (host is sole attack ticker).
     */
    _broadcastGarbage: function (applied) {
      if (!global.sendCupEvent || !applied || !applied.length) return;
      var cupsMsg = {};
      var sides = [];
      var blink = {};
      for (var i = 0; i < applied.length; i++) {
        var a = applied[i];
        if (!a || !a.side || !this.cups[a.side]) continue;
        sides.push(a.side);
        cupsMsg[a.side] = this.cups[a.side].serialize();
        var cells = [];
        if (a.spawned && a.spawned.length) {
          for (var c = 0; c < a.spawned.length; c++) {
            var sc = a.spawned[c];
            if (!sc) continue;
            if (sc.cell || sc.x != null) {
              cells.push({
                x: sc.x != null ? sc.x : (sc.cell && sc.cell.x),
                y: sc.y != null ? sc.y : (sc.cell && sc.cell.y),
                z: sc.z != null ? sc.z : (sc.cell && sc.cell.z)
              });
            } else if (Array.isArray(sc)) {
              cells.push({ x: sc[0], y: sc[1], z: sc[2] });
            }
          }
        }
        blink[a.side] = cells;
      }
      if (!sides.length) return;
      global.sendCupEvent({
        kind: 'garbage',
        sides: sides,
        cups: cupsMsg,
        blink: blink,
        attack: this.attackSys.serialize(),
        scores: { blue: this.modes.scores.blue, red: this.modes.scores.red }
      });
    },

    _applyNetworkStation: function (data) {
      if (!data || !data.side) return;
      if (this._isLocalAuthoritySide(data.side)) return;
      this._applyStationVisual(data);
    },

    _applyNetworkStations: function (stations) {
      if (!stations) return;
      if (stations.blue) this._applyNetworkStation(stations.blue);
      if (stations.red) this._applyNetworkStation(stations.red);
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

    // Vertical stack inside NEXT — 3 pieces, sized to fill the snug frame
    _nextQueueCount: 3,
    _nextSlotY: function (i) { return 0.05 + i * 0.20; },
    _nextSlotScale: function (i) { return Math.max(0.20, 0.36 - i * 0.06); },

    /** Scale pad/pocket pieces so longest tetromino fits inside its diamond. */
    _fitStationPiece: function (mesh, maxSpan) {
      if (!mesh) return;
      maxSpan = maxSpan || 0.26;
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

    /** Spawn / refresh the pad piece for one side (blue or red). */
    _spawnSidePadPiece: function (side, opts) {
      opts = opts || {};
      side = side === 'red' ? 'red' : 'blue';
      var pad = this._sidePad(side);
      var bag = this._sideBag(side);
      if (!pad || !bag) return;
      for (var i = pad.children.length - 1; i >= 0; i--) {
        var ch = pad.children[i];
        if (this._isPieceUserData(ch.userData)) pad.remove(ch);
      }
      this._setSidePadPiece(side, null);
      if (side === 'blue') this._previewPiece = null;

      var nextType = bag.next();
      if (!this._nextTypeBySide) this._nextTypeBySide = { blue: null, red: null };
      this._nextTypeBySide[side] = nextType;
      if (side === this._localSide()) this._nextType = nextType;

      var col = side === 'red' ? this._nextRed : this._nextBlue;
      var bottom = col && col.slots && col.slots.children[0];
      if (opts.animate && bottom) {
        var animBefore = (this._pieceAnims && this._pieceAnims.length) || 0;
        this._animateQueueAdvance(side, bag, bottom);
        // If animate bailed (missing pad/root), fall through to instant mesh
        if (((this._pieceAnims && this._pieceAnims.length) || 0) > animBefore ||
            this._sidePadPiece(side)) {
          if (opts.broadcast !== false && this.matchActive && !this._dualBotPreview) {
            this._broadcastStation(side);
          }
          return;
        }
      }

      var mesh = global.StacksShapes.createShapeMesh(nextType, {
        centerPivot: true,
        rotationY: 0
      });
      mesh.userData.padPiece = true;
      if (side === 'red') mesh.userData.botPadPiece = true;
      mesh.position.set(0, 0.1, 0);
      this._fitStationPiece(mesh, 0.30);
      pad.add(mesh);
      this._setSidePadPiece(side, mesh);
      this._rebuildNextQueue(side, bag, { dropIn: !!opts.dropIn });
      if (opts.broadcast !== false && this.matchActive && !this._dualBotPreview) {
        this._broadcastStation(side);
      }
    },

    _spawnPadPiece: function (opts) {
      opts = opts || {};
      this._spawnSidePadPiece(this._localSide(), opts);
    },

    /** PvP: both stations get a first piece from mirrored bags. */
    _spawnBothPads: function (opts) {
      opts = opts || {};
      opts = Object.assign({}, opts, { broadcast: false });
      this._spawnSidePadPiece('blue', opts);
      this._spawnSidePadPiece('red', opts);
      if (this.matchActive && !this._dualBotPreview) {
        this._broadcastStation('blue');
        this._broadcastStation('red');
      }
    },

    /** Instant or drop-in fill of the NEXT column from bag.peek. */
    _rebuildNextQueue: function (side, bag, opts) {
      opts = opts || {};
      var col = side === 'red' ? this._nextRed : this._nextBlue;
      if (!col || !col.slots || !bag || !bag.peek) return;
      while (col.slots.children.length) col.slots.remove(col.slots.children[0]);
      var peek = bag.peek(this._nextQueueCount);
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
      var pad = this._sidePad(side);
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

      var peek = bag.peek(this._nextQueueCount);
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
      if (!this.matchActive || this._dualBotPreview || this.matchState === 'COUNTDOWN') return;
      var side = this._localSide();
      var padPiece = this._sidePadPiece(side);
      var nextType = (this._nextTypeBySide && this._nextTypeBySide[side]) || this._nextType;
      if (this.held || !nextType || !padPiece) return;
      if (padPiece.userData && padPiece.userData.spawning) return;

      var hand = handEl || document.getElementById('rightHand');
      if (!hand) return;

      // In VR require proximity to the pad piece; desktop Space/G always allowed
      if (this._isPresenting() && !this._handNearPad(hand)) return;

      // Capture pad piece world pose so the grab doesn't jump
      padPiece.updateWorldMatrix(true, false);
      padPiece.getWorldPosition(this._tmp);
      padPiece.getWorldQuaternion(this._tmpQ);

      if (padPiece.parent) padPiece.parent.remove(padPiece);
      this._setSidePadPiece(side, null);
      if (side === 'blue') this._padPiece = null;

      this._nextType = nextType;
      var mesh = global.StacksShapes.createShapeMesh(nextType, {
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
        type: nextType,
        rot: 0,
        handEl: hand,
        suppressPlace: false,
        wasGhostValid: false
      };
      this._nextType = null;
      if (this._nextTypeBySide) this._nextTypeBySide[side] = null;
      this._spawnSidePadPiece(side, { animate: true });
      this._sfx('grab');
      this._pulseHaptic(hand, 0.55, 55);
      this._broadcastHold();
      this._broadcastStation(side);
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
      // Live + bot places: blink newly locked blocks (replay drives its own FX)
      if (placed && placed.length && !global.replayActive) {
        this._startBlockBlink(placed);
      }
      var clearResult = clearSys.resolveAfterPlace(cup, placed, type);
      var atk = null;
      if (!this._lastPlaceAt) this._lastPlaceAt = { blue: 0, red: 0 };
      this._lastPlaceAt[side] = performance.now();
      if (this.matchStats) this.matchStats.onPlace(side, clearResult, performance.now());
      if (clearResult.layersCleared > 0) {
        // Exact Dotmination sonar (Web Audio) — pitch rises with layers cleared.
        // Skip place click so it isn't masked by the blip.
        if (!this._dualBotPreview) {
          var layers = clearResult.layersCleared | 0;
          if (global.StacksAudio && typeof global.StacksAudio.clearChime === 'function') {
            global.StacksAudio.clearChime(layers, 0.55);
          } else {
            this._sfx('clear', { layers: layers, volume: 0.55 });
          }
        }
        atk = this.attackSys.onClear(side, clearResult, performance.now());
        if (this.matchStats && atk && atk.sent > 0) {
          this.matchStats.onAttack(side, atk.sent, performance.now());
        }
        if (!this._dualBotPreview) this._showClearPopup(side, clearResult, atk);
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
      } else {
        if (!this._dualBotPreview) this._sfx('place');
        clearSys.resetCombo();
      }

      if (window.matchRecorder) {
        window.matchRecorder.recordEvent('place', {
          side: side,
          type: type,
          cells: cells,
          clear: clearResult.layersCleared > 0 ? {
            layersCleared: clearResult.layersCleared,
            score: clearResult.score,
            damage: clearResult.damage,
            combo: clearResult.combo,
            tStack: !!clearResult.tStack,
            perfectClear: !!clearResult.perfectClear
          } : null,
          scores: { blue: this.modes.scores.blue, red: this.modes.scores.red },
          atk: atk || null
        });
      }
      if (broadcast && global.sendCupEvent) {
        // ONLY the placing seat cup/station — attack is host-mirrored like DodgeVR state.
        var cupsMsg = {};
        cupsMsg[side] = this.cups[side].serialize();
        var placeMsg = {
          kind: 'place', side: side, shapeType: type, cells: cells, clear: clearResult,
          scores: { blue: this.modes.scores.blue, red: this.modes.scores.red },
          cups: cupsMsg,
          station: this._serializeStation(side)
        };
        // Host includes authoritative attack (readyIn) so every peer/spectator matches HUD
        if (global.StacksLobby && global.StacksLobby.isHost) {
          placeMsg.attack = this.attackSys.serialize(performance.now());
        }
        global.sendCupEvent(placeMsg);
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
        // Never let the opponent spin/raise our cup
        if (this._isLocalAuthoritySide(evt.side)) return;
        this.cups[evt.side].applyTransform({ yaw: evt.yaw, heightY: evt.heightY });
        return;
      }
      if (evt.kind === 'station') {
        this._applyNetworkStation(evt);
        return;
      }
      // Host attack echo after peer clears (DodgeVR-style authoritative state push)
      if (evt.kind === 'attack') {
        if (!(global.StacksLobby && global.StacksLobby.isHost) || this._isViewOnlyObserver()) {
          if (evt.attack) this.attackSys.applySerialized(evt.attack, performance.now());
          if (evt.scores) {
            this.modes.scores.blue = evt.scores.blue;
            this.modes.scores.red = evt.scores.red;
          }
          this._updateHUD();
          this._updateDamageHUD();
        }
        return;
      }
      // Host-authoritative garbage (attack flush + inactivity junk). Must apply
      // even to the local player's cup — host is the only attack ticker.
      if (evt.kind === 'garbage') {
        var forceSides = {};
        if (evt.sides && evt.sides.length) {
          for (var gs = 0; gs < evt.sides.length; gs++) forceSides[evt.sides[gs]] = true;
        } else {
          if (evt.cups && evt.cups.blue) forceSides.blue = true;
          if (evt.cups && evt.cups.red) forceSides.red = true;
        }
        this._applyNetworkCups(evt.cups, { forceSides: forceSides });
        if (evt.attack) this.attackSys.applySerialized(evt.attack, performance.now());
        if (evt.scores) {
          this.modes.scores.blue = evt.scores.blue;
          this.modes.scores.red = evt.scores.red;
          if (global.lobbyState && global.lobbyState.matchScore) {
            global.lobbyState.matchScore.blue = evt.scores.blue;
            global.lobbyState.matchScore.red = evt.scores.red;
          }
        }
        if (evt.blink) {
          var bSides = ['blue', 'red'];
          for (var bi = 0; bi < bSides.length; bi++) {
            var bSide = bSides[bi];
            var bCells = evt.blink[bSide];
            if (!bCells || !bCells.length || !this.cups[bSide]) continue;
            var blinkList = [];
            for (var bj = 0; bj < bCells.length; bj++) {
              var bc = bCells[bj];
              var bx = bc.x != null ? bc.x : bc[0];
              var by = bc.y != null ? bc.y : bc[1];
              var bz = bc.z != null ? bc.z : bc[2];
              var bcell = this.cups[bSide].grid[by] &&
                this.cups[bSide].grid[by][bz] &&
                this.cups[bSide].grid[by][bz][bx];
              if (bcell) blinkList.push({ x: bx, y: by, z: bz, cell: bcell });
            }
            if (blinkList.length) this._startBlockBlink(blinkList, { garbage: true });
          }
        }
        if (!this._dualBotPreview) this._sfx('attack', { volume: 0.5 });
        this._updateHUD();
        this._updateDamageHUD();
        return;
      }
      if (evt.kind === 'hold') {
        // Hold mesh only for the remote side — never remap onto our seat
        if (!this._isLocalAuthoritySide(evt.side)) {
          this._setRemoteHeld(evt.side, evt);
        }
        if (evt.station) {
          this._applyNetworkStation(evt.station);
        } else if (evt.pocketType !== undefined && evt.side) {
          if (!this._isLocalAuthoritySide(evt.side)) {
            this._applyPocketVisual(evt.side, evt.pocketType || null);
          }
        }
        return;
      }
      if (evt.kind === 'place' || evt.kind === 'state') {
        if (evt.kind === 'place' && evt.side && evt.cups && evt.cups[evt.side]) {
          // Place: apply ONLY the placing side's cup (authoritative for that seat)
          if (!this._isLocalAuthoritySide(evt.side)) {
            this.cups[evt.side].applySnapshot(evt.cups[evt.side]);
            // Blink the remote place cells so peers see the same lock flash
            if (evt.cells && evt.cells.length && this.cups[evt.side]) {
              var rPlaced = [];
              for (var ri = 0; ri < evt.cells.length; ri++) {
                var rc = evt.cells[ri];
                var rx = rc[0] != null ? rc[0] : rc.x;
                var ry = rc[1] != null ? rc[1] : rc.y;
                var rz = rc[2] != null ? rc[2] : rc.z;
                var rcell = this.cups[evt.side].grid[ry] &&
                  this.cups[evt.side].grid[ry][rz] &&
                  this.cups[evt.side].grid[ry][rz][rx];
                if (rcell) rPlaced.push({ x: rx, y: ry, z: rz, cell: rcell });
              }
              if (rPlaced.length) this._startBlockBlink(rPlaced);
            }
          }
        } else if (evt.kind === 'state') {
          // Spectators: full board. Seated: gate own cup unless host garbage/wipe.
          var stateForce = null;
          if (evt.reason === 'garbage' || evt.reason === 'match-start') {
            stateForce = {};
            if (evt.cups && evt.cups.blue) stateForce.blue = true;
            if (evt.cups && evt.cups.red) stateForce.red = true;
          }
          this._applyNetworkCups(evt.cups, {
            forceAll: this._isViewOnlyObserver(),
            forceSides: stateForce
          });
        }

        if (evt.scores) {
          this.modes.scores.blue = evt.scores.blue;
          this.modes.scores.red = evt.scores.red;
          if (global.lobbyState && global.lobbyState.matchScore) {
            global.lobbyState.matchScore.blue = evt.scores.blue;
            global.lobbyState.matchScore.red = evt.scores.red;
          }
        }

        // Attack: DodgeVR-style — host is authority; everyone else applies readyIn snapshots.
        var isHostPeer = !!(global.StacksLobby && global.StacksLobby.isHost);
        if (evt.kind === 'place' && evt.clear && evt.clear.layersCleared > 0 && evt.side) {
          var remoteAtk = null;
          if (isHostPeer) {
            // Host owns the buffer + tick (same as DodgeVR host sim)
            remoteAtk = this.attackSys.onClear(evt.side, evt.clear, performance.now());
          } else if (evt.attack) {
            this.attackSys.applySerialized(evt.attack, performance.now());
            remoteAtk = evt.atk || null;
          } else {
            // Optimistic until host attack echo arrives
            remoteAtk = this.attackSys.onClear(evt.side, evt.clear, performance.now());
          }
          if (!this._dualBotPreview) {
            var rLayers = evt.clear.layersCleared | 0;
            if (global.StacksAudio && typeof global.StacksAudio.clearChime === 'function') {
              global.StacksAudio.clearChime(rLayers, 0.55);
            } else {
              this._sfx('clear', { layers: rLayers, volume: 0.55 });
            }
            this._showClearPopup(evt.side, evt.clear, remoteAtk);
          }
        } else if (evt.attack) {
          // state / attack echo — every non-sim peer takes host buffer
          if (!isHostPeer || this._isViewOnlyObserver()) {
            this.attackSys.applySerialized(evt.attack, performance.now());
          }
        }

        if (evt.kind === 'place' && evt.side) {
          // Host idle-junk clock must reset when the peer places — otherwise the
          // active client still gets inactivity layers (lastPlace stayed at GO).
          if (!this._lastPlaceAt) this._lastPlaceAt = { blue: 0, red: 0 };
          this._lastPlaceAt[evt.side] = performance.now();
          if (!this._isLocalAuthoritySide(evt.side)) {
            this._setRemoteHeld(evt.side, { holding: false });
          }
          if (this.matchStats && evt.side) {
            this.matchStats.onPlace(evt.side, evt.clear || null, performance.now());
          }
          // After a peer place, host pushes attack so placer/spectators match (DodgeVR echo)
          if (isHostPeer && evt.clear && evt.clear.layersCleared > 0 && global.sendCupEvent) {
            global.sendCupEvent({
              kind: 'attack',
              attack: this.attackSys.serialize(performance.now()),
              scores: { blue: this.modes.scores.blue, red: this.modes.scores.red }
            });
          }
        }

        // Stations: never apply our own seat (stale padType was swapping held/next)
        if (evt.stations) {
          this._applyNetworkStations(evt.stations);
        } else if (evt.station) {
          this._applyNetworkStation(evt.station);
        } else if (evt.kind === 'place' && evt.side && !this._isLocalAuthoritySide(evt.side)) {
          this._spawnSidePadPiece(evt.side, { dropIn: false, broadcast: false });
        }
        this._updateHUD();
        this._updateDamageHUD();
      }
    },

    onRemoteSnapshot: function (data) {
      if (!data || !data.snapshot) return;
      var snap = data.snapshot;
      var viewOnly = this._isViewOnlyObserver();
      // Seated players: never clobber the cup/station they own.
      // View-only (VR + mobile spectators): take the full host picture.
      this._applyNetworkCups(snap, { forceAll: viewOnly });
      if (snap.scores) {
        this.modes.scores.blue = snap.scores.blue;
        this.modes.scores.red = snap.scores.red;
      }
      // Heartbeat attack: everyone except the host sim takes it (readyIn clocks)
      if (snap.attack && (viewOnly || !(global.StacksLobby && global.StacksLobby.isHost))) {
        this.attackSys.applySerialized(snap.attack, performance.now());
      }
      if (snap.stations) {
        if (viewOnly) {
          if (snap.stations.blue) this._applyStationVisual(snap.stations.blue);
          if (snap.stations.red) this._applyStationVisual(snap.stations.red);
        } else {
          this._applyNetworkStations(snap.stations);
        }
      }
      if (snap.held) {
        if (snap.held.blue && (viewOnly || !this._isLocalAuthoritySide('blue'))) {
          this._setRemoteHeld('blue', snap.held.blue);
        }
        if (snap.held.red && (viewOnly || !this._isLocalAuthoritySide('red'))) {
          this._setRemoteHeld('red', snap.held.red);
        }
      }
      this._updateHUD();
      this._updateDamageHUD();
    },

    /**
     * Drop a peer's lobby remote-body-N slot so match seats don't double-render.
     * (Lobby poses stick remoteHandData on remote-body-N; match then also drives
     * bot-body / spec-blue-body → two avatars at the opponent.)
     */
    _releaseRemoteBodySlot: function (fromId) {
      if (!fromId || !this._remoteBodyMap) return;
      var bid = this._remoteBodyMap[fromId];
      if (!bid) return;
      delete this._remoteBodyMap[fromId];
      // Only clear pool bodies — never wipe the seat mesh we are switching to
      if (String(bid).indexOf('remote-body-') === 0) {
        this._clearRemoteAvatarEl(document.getElementById(bid));
      }
    },

    /**
     * On GO: seated humans use seat bodies only. Clear any leftover lobby pool
     * avatars for those peer ids (root cause of double opponent bodies).
     */
    _rebindMatchSeatAvatars: function () {
      var mp = global.lobbyState && global.lobbyState.matchPlayers;
      if (!mp) return;
      var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
      var sides = ['blue', 'red'];
      for (var i = 0; i < sides.length; i++) {
        var pid = mp[sides[i]];
        if (!pid || pid === '__BOT__' || pid === myId) continue;
        this._releaseRemoteBodySlot(pid);
      }
      // Also hide any pool body that still has pose data but is not mapped
      if (!this._remoteBodyMap) this._remoteBodyMap = {};
      var used = {};
      for (var id in this._remoteBodyMap) {
        if (Object.prototype.hasOwnProperty.call(this._remoteBodyMap, id)) {
          used[this._remoteBodyMap[id]] = true;
        }
      }
      for (var r = 0; r < 4; r++) {
        var rid = 'remote-body-' + r;
        if (!used[rid]) this._clearRemoteAvatarEl(document.getElementById(rid));
      }
    },

    /**
     * Pick a visible Mixamo body for a remote player.
     * Match seats prefer bot-body / spec-blue-body; everyone else gets remote-body-N.
     */
    _bodyForRemotePlayer: function (fromId) {
      if (!fromId) return null;
      var mp = global.lobbyState && global.lobbyState.matchPlayers;
      var playing = global.lobbyState && global.lobbyState.matchState === 'PLAYING';
      if (fromId === '__BOT__' || (mp && mp.red === '__BOT__' && fromId === mp.red)) {
        this._releaseRemoteBodySlot(fromId);
        return document.getElementById('bot-body');
      }
      if (playing && mp && fromId === mp.red) {
        this._releaseRemoteBodySlot(fromId);
        return document.getElementById('bot-body');
      }
      if (playing && mp && fromId === mp.blue) {
        this._releaseRemoteBodySlot(fromId);
        return document.getElementById('spec-blue-body');
      }

      if (!this._remoteBodyMap) this._remoteBodyMap = {};
      if (this._remoteBodyMap[fromId]) {
        var existing = document.getElementById(this._remoteBodyMap[fromId]);
        if (existing) return existing;
      }
      // Assign first free remote-body-0..3
      var used = {};
      var id;
      for (id in this._remoteBodyMap) {
        if (Object.prototype.hasOwnProperty.call(this._remoteBodyMap, id)) {
          used[this._remoteBodyMap[id]] = true;
        }
      }
      for (var i = 0; i < 4; i++) {
        var bid = 'remote-body-' + i;
        if (used[bid]) continue;
        var el = document.getElementById(bid);
        if (!el) continue;
        this._remoteBodyMap[fromId] = bid;
        return el;
      }
      // Fallback
      return document.getElementById('spec-blue-body') || document.getElementById('remote-body-0');
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

      var body = this._bodyForRemotePlayer(fromId);
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
      this.bags = {
        blue: new global.StacksShapes.ShapeBag(seed),
        red: new global.StacksShapes.ShapeBag(seed)
      };
      this.bag = this.bags.blue;
      this._nextTypeBySide = { blue: null, red: null };
      if (this.bot) this.bot.reset(seed);
      if (this.botBlue) this.botBlue.reset(seed);
      return seed;
    },

    onMatchStarted: function (mp, startTime, isBotMatch, bagSeed) {
      if (this._dualIdleTimer) { clearTimeout(this._dualIdleTimer); this._dualIdleTimer = null; }
      this._clearVictory();
      this._clearMatchBanner();
      this._endingMatch = false;
      // Leave dual-preview ownership BEFORE bag reset / bot disable so blue
      // pad visuals cannot wipe the human spawn below.
      this._dualBotPreview = false;
      global.offlinePreview = false;
      if (this.bot) this.bot.enable(false);
      if (this.botBlue) this.botBlue.enable(false);

      // Clear sticky bot flag from a previous match — human on red ⇒ always PvP
      var liveMp = mp || (global.lobbyState && global.lobbyState.matchPlayers);
      var reallyBot = !!(liveMp && liveMp.red === '__BOT__') ||
        (!!isBotMatch && !(liveMp && liveMp.red && liveMp.red !== '__BOT__'));
      global.isLobbyBotMatch = reallyBot;
      if (global.StacksLobby) global.StacksLobby.isLobbyBotMatch = reallyBot;

      this.matchActive = true;
      this.matchState = 'COUNTDOWN';
      this._pendingMatch = {
        mp: liveMp,
        startTime: startTime || Date.now(),
        isBotMatch: reallyBot,
        isBotSeat: reallyBot,
        bagSeed: bagSeed
      };
      var spectating = !!(global.isMobileSpectator ||
        (global.isSpectator && global.isMultiplayer &&
          !(global.StacksLobby && global.StacksLobby.amMatchPlayer && global.StacksLobby.amMatchPlayer())));
      this._pendingMatch.spectating = spectating;

      // Sync playfield size from lobby (4×4 / 6×6) before wipe / spectator snapshot
      var bs = (global.getBoardSize && global.getBoardSize()) ||
        (global.lobbyState && global.lobbyState.boardSize) || 6;
      this.applyBoardSize(bs);

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
      // Timer / play begin after countdown — keep modes inactive until GO
      if (this.modes.stop) this.modes.stop();
      this.playerScore = 0;
      this.botScore = 0;
      this._applyMirroredBags(bagSeed);
      this._resetStationsForMatch();
      this._setRemoteHeld('blue', { holding: false });
      this._setRemoteHeld('red', { holding: false });

      var isBotSeat = reallyBot;
      this._pendingMatch.isBotSeat = isBotSeat;
      this._pendingMatch.isBotMatch = reallyBot;
      // Keep both stations visible for everyone (players + spectators)
      if (this._pad) this._pad.visible = true;
      if (this._pocket) this._pocket.visible = true;
      this._setBotStationVisible(true);
      this._showMatchBodies({ showBot: !!isBotSeat && !spectating });

      // Host pushes board wipe; live pad spawn happens on GO
      if (global.isMultiplayer && global.StacksLobby && global.StacksLobby.isHost) {
        this._broadcastState('match-start');
      }
      this._updateHUD();
      this._musicMatch();
      this._startCountdown(this._pendingMatch.startTime);
    },

    _startCountdown: function (startTime) {
      this.matchState = 'COUNTDOWN';
      this._countdownStart = startTime || Date.now();
      this._countdownDur = 3;
      this._countdownLastShown = null;
      this._countdownGoAt = null;
      this._showMatchBanner('3');
      this._sfx('ui');
    },

    _tickCountdown: function (now) {
      if (this.matchState !== 'COUNTDOWN') return;
      now = now || Date.now();
      if (this._countdownGoAt) {
        if (now >= this._countdownGoAt) {
          this._countdownGoAt = null;
          this._beginLivePlay();
        }
        return;
      }
      var elapsed = (now - (this._countdownStart || now)) / 1000;
      var remaining = Math.ceil(this._countdownDur - elapsed);
      if (remaining > 0) {
        if (remaining !== this._countdownLastShown) {
          this._countdownLastShown = remaining;
          this._showMatchBanner(String(remaining));
          this._sfx('ui');
          var hand = document.getElementById('rightHand') || document.getElementById('leftHand');
          this._pulseHaptic(hand, 0.45, 40);
        }
      } else {
        this._countdownLastShown = 0;
        this._showMatchBanner('GO!');
        this._sfx('ui');
        this._countdownGoAt = now + 450;
      }
    },

    _beginLivePlay: function () {
      var pending = this._pendingMatch || {};
      this._clearMatchBanner();
      this.matchState = 'PLAYING';
      this._pendingMatch = null;

      // Re-resolve seats from live lobby — pending flags alone can be stale.
      var mp = (pending.mp) || (global.lobbyState && global.lobbyState.matchPlayers);
      var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
      var seated = !!(mp && myId &&
        (mp.blue === myId || (mp.red === myId && mp.red !== '__BOT__')));
      // Seat id wins over any sticky isSpectator / "host vs bot ⇒ play" shortcut
      var spectating = !!pending.spectating;
      if (global.isMultiplayer) {
        spectating = !seated;
        global.isSpectator = spectating;
        if (global.StacksLobby) global.StacksLobby.isSpectator = spectating;
      }
      var blueBot = !!(mp && mp.blue === '__BOT__');
      var redBot = !!(mp && mp.red === '__BOT__');
      var isBotSeat = redBot || blueBot;
      global.isLobbyBotMatch = !!isBotSeat;
      if (global.StacksLobby) global.StacksLobby.isLobbyBotMatch = !!isBotSeat;
      var startTime = pending.startTime || Date.now();
      var hostRunsBots = !global.isMultiplayer ||
        !!(global.StacksLobby && global.StacksLobby.isHost);

      this.modes.start(startTime);
      if (this.matchStats) this.matchStats.start(performance.now());

      this._resetStationsForMatch();
      this._applyMirroredBags(pending.bagSeed != null ? pending.bagSeed : this.bagSeed);
      if (spectating || (blueBot && redBot) || (!blueBot && !redBot)) {
        // Spectators / dual-bot / PvP: both pads
        this._spawnBothPads({ dropIn: true });
      } else if (redBot && !blueBot) {
        // Human on blue vs red bot
        this._spawnSidePadPiece('blue', { dropIn: true });
      } else if (blueBot && !redBot) {
        this._spawnSidePadPiece('red', { dropIn: true });
      }

      // Snap local player to the correct side / body color now that seats are final
      var sceneEl = this.el.sceneEl;
      if (sceneEl) sceneEl.emit('lobby-state-updated');

      // Always show both stations during a live match (PvP + bot + spectators)
      if (this._pad) this._pad.visible = true;
      if (this._pocket) this._pocket.visible = true;
      this._setBotStationVisible(true);

      var bpm = this.botTargetBpm != null ? this.botTargetBpm : 12;
      if (this.bot) {
        this.bot.setCup(this.cups.red);
        var runRed = !!(redBot && hostRunsBots);
        this.bot.enable(runRed);
        if (runRed && this.bot.setTargetBpm) this.bot.setTargetBpm(bpm);
      }
      if (this.botBlue) {
        this.botBlue.setCup(this.cups.blue);
        var runBlue = !!(blueBot && hostRunsBots);
        this.botBlue.enable(runBlue);
        if (runBlue && this.botBlue.setTargetBpm) this.botBlue.setTargetBpm(bpm);
      }
      // Safety: bot.enable(false) used to emit pad:null and wipe human red.
      // If a pad mesh is missing but we already drew from the bag, restore it
      // without calling bag.next() again (would desync pieces).
      if (!this._dualBotPreview && this._nextTypeBySide) {
        var restoreSides = ['blue', 'red'];
        for (var rsi = 0; rsi < restoreSides.length; rsi++) {
          var rside = restoreSides[rsi];
          var rSeat = mp && mp[rside];
          var humanSeat = (rSeat && rSeat !== '__BOT__') ||
            (rside === 'blue' && !rSeat && !blueBot);
          if (!humanSeat) continue;
          if (this._sidePadPiece(rside)) continue;
          if (!this._nextTypeBySide[rside]) continue;
          this._applyStationVisual(this._serializeStation(rside));
        }
      }
      this._showMatchBodies({ showBot: !!redBot });
      // Lobby remote-body-N → seat body; without this both stay posed (double avatar)
      this._rebindMatchSeatAvatars();

      // Snapshot seats for victory/history — endLobbyMatch parks everyone as spectator.
      var mySeatSide = null;
      if (seated && myId && mp) {
        if (mp.blue === myId) mySeatSide = 'blue';
        else if (mp.red === myId && mp.red !== '__BOT__') mySeatSide = 'red';
      }
      this._matchSeatMeta = {
        blueIsBot: !!blueBot,
        redIsBot: !!redBot,
        blueName: this._sideNickname('blue'),
        redName: this._sideNickname('red'),
        wasBotMatch: !!isBotSeat,
        mySide: mySeatSide,
        wasSeatedPlayer: !!seated
      };

      if (window.matchRecorder) window.matchRecorder.startRecording(startTime);
      var goNow = performance.now();
      this._matchGoAt = goNow;
      this._lastPlaceAt = { blue: goNow, red: goNow };
      this._lastInactiveJunkAt = { blue: 0, red: 0 };
      this._updateHUD();
      if (global.isMultiplayer && global.StacksLobby && global.StacksLobby.isHost) {
        this._broadcastState('match-go');
      }
    },

    _showMatchBanner: function (text) {
      this._clearMatchBanner();
      if (!this._sceneRoot || !THREE) return;
      var canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 256;
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 512, 256);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 140px Arial, Helvetica, sans-serif';
      ctx.shadowColor = '#33bbff';
      ctx.shadowBlur = 24;
      ctx.fillText(String(text || ''), 256, 128);
      var tex = new THREE.CanvasTexture(canvas);
      var mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.1, 0.55),
        new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide
        })
      );
      mesh.position.set(0, 1.55, 0);
      var player = document.getElementById('player');
      if (player && player.object3D) {
        var look = new THREE.Vector3();
        player.object3D.getWorldPosition(look);
        look.y = mesh.position.y;
        mesh.lookAt(look);
      }
      this._sceneRoot.add(mesh);
      this._matchBanner = { mesh: mesh, tex: tex };
    },

    _clearMatchBanner: function () {
      var b = this._matchBanner;
      if (!b) return;
      if (b.mesh && b.mesh.parent) b.mesh.parent.remove(b.mesh);
      if (b.tex) b.tex.dispose();
      if (b.mesh && b.mesh.material) b.mesh.material.dispose();
      this._matchBanner = null;
    },

    /**
     * Strip networked avatar state. Critical: mixamo-body re-shows any entity that
     * still has remoteHandData each frame — hide alone is not enough (DodgeVR clears it).
     */
    _clearRemoteAvatarEl: function (el) {
      if (!el) return;
      el.setAttribute('visible', false);
      if (el.object3D) el.object3D.visible = false;
      if (el.dataset) {
        delete el.dataset.posed;
        el.dataset.posed = '';
      }
      var mb = el.components && el.components['mixamo-body'];
      if (mb) mb.remoteHandData = null;
    },

    _clearAllRemoteAvatars: function () {
      var ids = ['spec-blue-body', 'bot-body', 'remote-body-0', 'remote-body-1',
        'remote-body-2', 'remote-body-3'];
      for (var i = 0; i < ids.length; i++) {
        this._clearRemoteAvatarEl(document.getElementById(ids[i]));
      }
      this._remoteBodyMap = {};
      this._setRemoteHeld('blue', { holding: false });
      this._setRemoteHeld('red', { holding: false });
      this._clearBotHoldMesh('blue');
      this._clearBotHoldMesh('red');
    },

    /** Drop avatars for peer ids no longer in the lobby (opponent left, you stayed). */
    _pruneRemoteAvatarsToLobby: function () {
      if (!global.isMultiplayer || !global.lobbyState) {
        this._clearAllRemoteAvatars();
        return;
      }
      var live = {};
      var players = global.lobbyState.players || [];
      for (var i = 0; i < players.length; i++) {
        if (players[i] && players[i].id) live[players[i].id] = true;
      }
      var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
      if (myId) live[myId] = true;
      live['__BOT__'] = true;

      if (!this._remoteBodyMap) this._remoteBodyMap = {};
      var nextMap = {};
      var stillUsed = {};
      for (var pid in this._remoteBodyMap) {
        if (!Object.prototype.hasOwnProperty.call(this._remoteBodyMap, pid)) continue;
        var bid = this._remoteBodyMap[pid];
        if (live[pid]) {
          nextMap[pid] = bid;
          stillUsed[bid] = true;
        } else {
          this._clearRemoteAvatarEl(document.getElementById(bid));
        }
      }
      this._remoteBodyMap = nextMap;

      // Seat bodies (bot/spec-blue) — clear if that seat's human is gone
      var mp = global.lobbyState.matchPlayers || {};
      var playing = global.lobbyState.matchState === 'PLAYING';
      if (!playing || !mp.blue || !live[mp.blue]) {
        this._clearRemoteAvatarEl(document.getElementById('spec-blue-body'));
      }
      if (!playing || !mp.red || mp.red === '__BOT__' || !live[mp.red]) {
        // Keep bot-body for vs-bot matches; otherwise clear stale human pose
        if (!(playing && mp.red === '__BOT__')) {
          this._clearRemoteAvatarEl(document.getElementById('bot-body'));
        }
      }

      // During PLAYING, match seats must NOT also occupy remote-body-N
      if (playing) {
        var myId2 = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
        var seatSides = ['blue', 'red'];
        for (var s = 0; s < seatSides.length; s++) {
          var pid = mp[seatSides[s]];
          if (!pid || pid === '__BOT__' || pid === myId2) continue;
          if (nextMap[pid]) {
            var oldBid = nextMap[pid];
            delete nextMap[pid];
            delete stillUsed[oldBid];
            if (String(oldBid).indexOf('remote-body-') === 0) {
              this._clearRemoteAvatarEl(document.getElementById(oldBid));
            }
          }
        }
        this._remoteBodyMap = nextMap;
      }

      // Free unused remote-body slots
      for (var r = 0; r < 4; r++) {
        var rid = 'remote-body-' + r;
        if (!stillUsed[rid]) this._clearRemoteAvatarEl(document.getElementById(rid));
      }
    },

    /**
     * Host left / connection dropped / voluntary leave — clear remotes.
     * Match end is usually already fired by handleHostGone; this is the safety net.
     */
    onHostDisconnected: function (opts) {
      opts = opts || {};
      this._clearAllRemoteAvatars();
      if (this.matchActive) {
        this.onMatchEnded({
          cancelled: true,
          victory: false,
          reason: (opts && opts.reason) || 'host-left',
          hostLeft: !!(opts && opts.hostLeft)
        });
      } else if (!global.isMobileSpectator) {
        this._scheduleDualIdle(400);
      }
    },

    onMatchEnded: function (opts) {
      opts = opts || {};
      // Idempotent — host-leaving may fire match-ended then onDisconnected
      if (!this.matchActive && this.matchState === 'WAITING' && !this._pendingMatch) {
        if (!opts.hostLeft) {
          var sceneEarly = this.el && this.el.sceneEl;
          if (sceneEarly) sceneEarly.emit('lobby-state-updated');
          return;
        }
      }
      this.matchActive = false;
      this.matchState = 'WAITING';
      this._dualBotPreview = false;
      global.offlinePreview = false;
      this._pendingMatch = null;
      this._countdownGoAt = null;
      this._matchGoAt = 0;
      this._clearMatchBanner();
      this._clearClearPopup();
      if (this.bot) this.bot.enable(false);
      if (this.botBlue) this.botBlue.enable(false);
      this._setBotStationVisible(false);
      this._clearPieceAnims();
      this._clearBotHoldMesh('blue');
      this._clearBotHoldMesh('red');
      this._clearBotStationPieces('blue');
      this._clearBotStationPieces('red');
      this._clearNextQueue('blue');
      this._clearNextQueue('red');
      this._nextType = null;
      this._padPiece = null;
      this._cancelHold();

      // Drop human poses off seat meshes immediately — dual-bot idle / lobby must
      // not keep a ghost in the seat you (or the opponent) just vacated.
      this._clearRemoteAvatarEl(document.getElementById('bot-body'));
      this._clearRemoteAvatarEl(document.getElementById('spec-blue-body'));

      // Multiplayer peers may only learn the winner from match-ended payload
      if (this.modes) {
        if (opts.winner) this.modes.winner = opts.winner;
        if (opts.reason) this.modes.reason = opts.reason;
        if (opts.scores) {
          if (opts.scores.blue != null) this.modes.scores.blue = opts.scores.blue;
          if (opts.scores.red != null) this.modes.scores.red = opts.scores.red;
        }
        if (this.modes.stop) this.modes.stop();
      }

      // Stop capture NOW (O(1)). Never package/save replay on the win frame —
      // offline bot matches used to dump full cup JSON @10Hz and freeze Quest on IDB.
      var selfEnd = this;
      try {
        if (window.matchRecorder) {
          if (typeof window.matchRecorder.stopCapture === 'function') {
            window.matchRecorder.stopCapture();
          } else {
            window.matchRecorder.isRecording = false;
          }
        }
      } catch (e) { console.warn('[StacksGame] replay stopCapture failed', e); }

      this._updateHUD();

      var winner = (opts && opts.winner) || (this.modes && this.modes.winner);
      var festive = !opts.cancelled && !!winner;
      // Merge end payload seat labels (host clears matchPlayers before banner)
      if (opts.wasBotMatch != null || opts.blueName || opts.redName) {
        this._matchSeatMeta = Object.assign({}, this._matchSeatMeta || {}, {
          wasBotMatch: opts.wasBotMatch != null ? !!opts.wasBotMatch :
            !!(this._matchSeatMeta && this._matchSeatMeta.wasBotMatch),
          redIsBot: opts.wasBotMatch != null ? !!opts.wasBotMatch :
            !!(this._matchSeatMeta && this._matchSeatMeta.redIsBot),
          blueName: opts.blueName || (this._matchSeatMeta && this._matchSeatMeta.blueName) || null,
          redName: opts.redName || (this._matchSeatMeta && this._matchSeatMeta.redName) || null
        });
      }
      this._musicIdle();
      if (festive) {
        // Defer heavy canvas/confetti one frame so the last place still paints
        setTimeout(function () {
          selfEnd._playVictory({
            winner: winner,
            reason: (opts && opts.reason) || (selfEnd.modes && selfEnd.modes.reason),
            wasBotMatch: opts && opts.wasBotMatch,
            blueName: opts && opts.blueName,
            redName: opts && opts.redName
          });
        }, 0);
        this._scheduleDualIdle(3800);
      } else {
        this._clearVictory();
        this._scheduleDualIdle(350);
      }
      this._endingMatch = false;
      // Keep VR menu START/END label in sync after lobby/local ends
      var scene = this.el && this.el.sceneEl;
      if (scene) scene.emit('lobby-state-updated');

      // History + events-only replay well after victory paints.
      // CRITICAL: history.timestamp MUST equal replay.matchTimestamp or pruneOld
      // deletes every replay (was the "no replays" bug).
      setTimeout(function () {
        if (opts.cancelled || opts.hostLeft) return;
        try {
          var replayPending = null;
          if (window.matchRecorder) {
            if (typeof window.matchRecorder.takeReplay === 'function') {
              replayPending = window.matchRecorder.takeReplay();
            } else if (typeof window.matchRecorder.stopRecording === 'function') {
              replayPending = window.matchRecorder.stopRecording();
            }
          }
          var ts = (replayPending && replayPending.matchTimestamp) ||
            (window.matchRecorder && window.matchRecorder._matchTimestamp) ||
            Date.now();
          selfEnd._saveMatchHistory(opts, ts);
          if (replayPending && window.matchReplayStorage) {
            replayPending.matchTimestamp = ts;
            var p = window.matchReplayStorage.save(replayPending);
            if (p && typeof p.then === 'function') {
              p.then(function () {
                try {
                  var hist = global.StacksStats && global.StacksStats.loadHistory
                    ? global.StacksStats.loadHistory() : { single: [], multi: [] };
                  var keep = (hist.single || []).concat(hist.multi || []).map(function (m) {
                    return m.timestamp;
                  });
                  if (window.matchReplayStorage.pruneOld) window.matchReplayStorage.pruneOld(keep);
                } catch (ePrune) { /* ignore */ }
              }).catch(function (err) {
                console.warn('[StacksGame] replay save failed', err);
              });
            }
          }
        } catch (e3) { console.warn('[StacksGame] replay/history save failed', e3); }
      }, 400);
    },

    /**
     * Dual-bot spectacle resumes whenever no REAL match is PLAYING.
     * Hosting a WAITING lobby must still show 2 bots (user can START vs BOT / queue later).
     */
    _canResumeDualIdle: function () {
      if (global.isMobileSpectator) return false;
      if (global.replayActive || global.replaySpectator) return false;
      if (global.lobbyState && global.lobbyState.matchState === 'PLAYING') return false;
      return true;
    },

    _isLiveMatchPlaying: function () {
      if (global.stacksReplayGate && typeof global.stacksReplayGate.isLiveMatchPlaying === 'function') {
        return !!global.stacksReplayGate.isLiveMatchPlaying();
      }
      if (this._dualBotPreview) return false;
      if (global.lobbyState &&
          (global.lobbyState.matchState === 'PLAYING' || global.lobbyState.matchState === 'COUNTDOWN')) {
        return true;
      }
      return !!(this.matchActive && !global.replayActive && !global.replaySpectator);
    },

    _replayMsgFromHost: function (msg) {
      if (!msg || !msg.from) return false;
      var Lobby = global.StacksLobby;
      if (Lobby && Lobby.hostPlayerId && msg.from === Lobby.hostPlayerId) return true;
      if (typeof msg.from === 'string' && msg.from.indexOf('stacksvr-host-') === 0) return true;
      return false;
    },

    /**
     * DodgeVR parity: lobby Watch stream. Never interrupts a live match.
     * Only the host may interrupt another player's Watch (client drivers yield).
     */
    onRemoteReplayMsg: function (msg) {
      if (!msg || !msg.type) return;
      var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
      if (msg.from && myId && msg.from === myId) return;

      // Live match wins — never clear cups for a late/errant Watch packet
      if (msg.type !== 'replay-ended' && this._isLiveMatchPlaying()) return;

      var localDriver = global.replayActive && window.matchReplayPlayer &&
        window.matchReplayPlayer.playing && !window.matchReplayPlayer._remoteOnly;
      if (localDriver) {
        // Peer streams ignored while we drive; host interrupt forces yield
        if (!this._replayMsgFromHost(msg)) return;
        window.matchReplayPlayer.stop({ silent: true, force: true, keepIdle: true });
        localDriver = false;
      }

      if (msg.type === 'replay-started') {
        if (this._dualIdleTimer) {
          clearTimeout(this._dualIdleTimer);
          this._dualIdleTimer = null;
        }
        if (this.bot) this.bot.enable(false);
        if (this.botBlue) this.botBlue.enable(false);
        this._dualBotPreview = false;
        this.matchActive = false;
        if (this.cups && this.cups.blue) this.cups.blue.clearAll();
        if (this.cups && this.cups.red) this.cups.red.clearAll();
        if (this.attackSys) this.attackSys.reset();
        if (this.modes) {
          this.modes.scores.blue = 0;
          this.modes.scores.red = 0;
          this.modes.active = false;
        }
        global.replaySpectator = true;
        global.replayActive = true;
        window._replayNames = {
          blue: msg.blueName || 'Blue',
          red: msg.redName || 'Red'
        };
        if (this._updateHUD) this._updateHUD();
        if (this._updateDamageHUD) this._updateDamageHUD();
        return;
      }

      if (msg.type === 'replay-state') {
        if (!global.replaySpectator && !global.replayActive) {
          this.onRemoteReplayMsg({
            type: 'replay-started',
            from: msg.from,
            blueName: (window._replayNames && window._replayNames.blue) || 'Blue',
            redName: (window._replayNames && window._replayNames.red) || 'Red'
          });
        }
        if (this._isLiveMatchPlaying()) return;
        if (msg.cups) this._applyNetworkCups(msg.cups, { forceAll: true });
        if (msg.scores && this.modes) {
          if (msg.scores.blue != null) this.modes.scores.blue = msg.scores.blue;
          if (msg.scores.red != null) this.modes.scores.red = msg.scores.red;
        }
        if (this._updateHUD) this._updateHUD();
        return;
      }

      if (msg.type === 'replay-ended') {
        global.replaySpectator = false;
        global.replayActive = false;
        if (this.cups && this.cups.blue) this.cups.blue.clearAll();
        if (this.cups && this.cups.red) this.cups.red.clearAll();
        if (this.modes) {
          this.modes.scores.blue = 0;
          this.modes.scores.red = 0;
        }
        if (this._updateHUD) this._updateHUD();
        this._scheduleDualIdle(400);
      }
    },

    _scheduleDualIdle: function (delayMs) {
      if (!this._canResumeDualIdle()) return;
      if (typeof this.startOfflinePreviewMatch !== 'function') return;
      var self = this;
      if (this._dualIdleTimer) clearTimeout(this._dualIdleTimer);
      this._dualIdleTimer = setTimeout(function () {
        self._dualIdleTimer = null;
        if (self.matchActive) return;
        if (!self._canResumeDualIdle()) return;
        self._clearVictory();
        self.startOfflinePreviewMatch();
      }, delayMs == null ? 400 : delayMs);
    },

    /** Resolve end-banner text. NEVER assume red === Bot (PvP red is a human). */
    _victoryTitle: function (winner, info) {
      info = info || {};
      if (winner === 'draw') return 'DRAW!';

      var meta = this._matchSeatMeta || {};
      var mySide = meta.mySide || 'blue';
      if (!meta.mySide) {
        if (global.isMultiplayer && global.StacksLobby && global.StacksLobby.mySide) {
          mySide = global.StacksLobby.mySide() || 'blue';
        } else if (typeof this._localSide === 'function') {
          mySide = this._localSide() || 'blue';
        }
      }
      if (winner === mySide) return 'YOU WIN!';

      // Seat meta is snapshotted at GO — endLobbyMatch clears matchPlayers before banner.
      var mp = global.lobbyState && global.lobbyState.matchPlayers;
      var oppIsBot = false;
      if (winner === 'red') {
        if (info.wasBotMatch != null) oppIsBot = !!info.wasBotMatch;
        else if (meta.redIsBot != null) oppIsBot = !!meta.redIsBot;
        else if (mp && mp.red === '__BOT__') oppIsBot = true;
        else if (!global.isMultiplayer &&
          (global.isLobbyBotMatch || (this.bot && this.bot.enabled) || this._dualBotPreview)) {
          oppIsBot = true;
        }
      } else if (winner === 'blue') {
        oppIsBot = !!(meta.blueIsBot || (mp && mp.blue === '__BOT__'));
      }
      if (oppIsBot) return 'BOT WINS!';

      var name = (winner === 'red'
        ? (info.redName || meta.redName)
        : (info.blueName || meta.blueName)) ||
        (typeof this._sideNickname === 'function' ? this._sideNickname(winner) : null);
      if (name && name !== 'Blue' && name !== 'Red' && name !== 'Bot') {
        return String(name).toUpperCase() + ' WINS!';
      }
      if (winner === 'red') return 'RED WINS!';
      if (winner === 'blue') return 'BLUE WINS!';
      return String(winner).toUpperCase();
    },

    /** Festive win banner + confetti burst (keeps board visible for a beat). */
    _playVictory: function (info) {
      info = info || {};
      this._clearVictory();
      if (!this._sceneRoot || !THREE) return;

      var winner = info.winner || (this.modes && this.modes.winner) || 'draw';
      var title = this._victoryTitle(winner, info);

      var accent = winner === 'red' ? 0xff6a3d : (winner === 'blue' ? 0x33bbff : 0xffd56a);
      var root = new THREE.Group();
      root.name = 'stacks-victory';
      root.position.set(0, 1.55, 0);
      this._sceneRoot.add(root);
      this._victory = { root: root, bits: [], t0: performance.now(), accent: accent };

      // Soft glow plate behind text
      var plate = new THREE.Mesh(
        new THREE.PlaneGeometry(1.6, 0.55),
        new THREE.MeshBasicMaterial({
          color: 0x05070c, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide
        })
      );
      plate.position.z = -0.02;
      root.add(plate);

      var rim = new THREE.Mesh(
        new THREE.PlaneGeometry(1.68, 0.62),
        new THREE.MeshBasicMaterial({
          color: accent, transparent: true, opacity: 0.55, depthWrite: false,
          side: THREE.DoubleSide, toneMapped: false
        })
      );
      rim.position.z = -0.03;
      root.add(rim);
      this._victory.rim = rim;

      // Canvas title
      var canvas = document.createElement('canvas');
      canvas.width = 1024;
      canvas.height = 256;
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 120px Arial, Helvetica, sans-serif';
      ctx.shadowColor = '#' + ('000000' + accent.toString(16)).slice(-6);
      ctx.shadowBlur = 28;
      ctx.fillText(title, 512, 110);
      ctx.shadowBlur = 0;
      ctx.font = '600 42px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#c8d6e6';
      var sub = info.reason === 'overflow' ? 'Top-out!' :
        (info.reason === 'target-layers' ? 'Layer goal!' :
          (info.reason === 'time' ? 'Time!' : 'Match over'));
      ctx.fillText(sub, 512, 190);
      var tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      var titleMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.45, 0.36),
        new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide
        })
      );
      root.add(titleMesh);
      this._victory.titleMesh = titleMesh;
      this._victory.titleTex = tex;

      // Confetti cubes (keep count modest — 64 mats hitch mid/low-end GPUs)
      var colors = [accent, 0xffffff, 0xffe27a, 0x66ffcc, 0xff66aa, 0x88aaff];
      var geo = new THREE.BoxGeometry(0.04, 0.04, 0.04);
      for (var i = 0; i < 24; i++) {
        var mat = new THREE.MeshBasicMaterial({
          color: colors[i % colors.length],
          transparent: true,
          opacity: 0.95,
          toneMapped: false
        });
        var bit = new THREE.Mesh(geo, mat);
        bit.position.set(
          (Math.random() - 0.5) * 0.4,
          (Math.random() - 0.2) * 0.2,
          (Math.random() - 0.5) * 0.3
        );
        root.add(bit);
        this._victory.bits.push({
          mesh: bit,
          vx: (Math.random() - 0.5) * 1.6,
          vy: 1.2 + Math.random() * 1.8,
          vz: (Math.random() - 0.5) * 1.6,
          spin: (Math.random() - 0.5) * 8
        });
      }
      this._victory.sharedGeo = geo;

      // Face the local player
      var player = document.getElementById('player');
      if (player && player.object3D) {
        var look = new THREE.Vector3();
        player.object3D.getWorldPosition(look);
        look.y = root.position.y;
        root.lookAt(look);
      }

      this._sfx('win');
      var hand = document.getElementById('rightHand') || document.getElementById('leftHand');
      this._pulseHaptic(hand, 0.95, 160);
      setTimeout(function () {
        this._pulseHaptic(hand, 0.7, 90);
      }.bind(this), 180);
    },

    _clearVictory: function () {
      var v = this._victory;
      if (!v) return;
      if (v.root && v.root.parent) v.root.parent.remove(v.root);
      if (v.titleTex) v.titleTex.dispose();
      if (v.titleMesh && v.titleMesh.material) v.titleMesh.material.dispose();
      if (v.sharedGeo) v.sharedGeo.dispose();
      if (v.bits) {
        for (var i = 0; i < v.bits.length; i++) {
          if (v.bits[i].mesh && v.bits[i].mesh.material) v.bits[i].mesh.material.dispose();
        }
      }
      this._victory = null;
    },

    /** Floating clear callout: lines / combo / attack sent or cancelled. */
    _showClearPopup: function (side, clearResult, atk) {
      if (!this._sceneRoot || !THREE || !clearResult) return;
      this._clearClearPopup();
      var layers = clearResult.layersCleared | 0;
      if (layers <= 0) return;
      var names = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'QUAD'];
      var title = layers <= 4 ? names[layers] : (layers + ' LINES');
      if (clearResult.perfectClear) title = 'PERFECT';
      if (clearResult.tStack) title += '  T';

      var lines = [title];
      if ((clearResult.combo | 0) > 1) lines.push('COMBO x' + (clearResult.combo | 0));
      var sent = atk && atk.sent > 0 ? (atk.sent | 0) : 0;
      var cancelled = atk && atk.cancelled > 0 ? (atk.cancelled | 0) : 0;
      if (sent > 0) lines.push('+' + sent + ' ATK');
      else if (cancelled > 0) lines.push('-' + cancelled + ' BLOCK');
      else if (layers === 1) lines.push('no attack');
      lines.push('+' + (clearResult.score | 0));

      var canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 256;
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, 512, 256);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 72px Arial, Helvetica, sans-serif';
      ctx.fillStyle = side === 'red' ? '#ff8a5c' : '#5ad0ff';
      ctx.shadowColor = 'rgba(0,0,0,0.75)';
      ctx.shadowBlur = 12;
      ctx.fillText(lines[0], 256, 70);
      ctx.shadowBlur = 0;
      ctx.font = '600 42px Arial, Helvetica, sans-serif';
      ctx.fillStyle = '#e8eef6';
      for (var i = 1; i < lines.length; i++) {
        ctx.fillText(lines[i], 256, 70 + i * 48);
      }
      var tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      var mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide
      });
      var mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.28), mat);
      var cup = this.cups[side];
      var pos = new THREE.Vector3(side === 'blue' ? -0.55 : 0.55, 1.55, side === 'blue' ? 1.15 : -1.15);
      if (cup && cup.root) {
        cup.root.getWorldPosition(pos);
        pos.y += 0.55;
      }
      mesh.position.copy(pos);
      var player = document.getElementById('player');
      if (player && player.object3D) {
        var look = new THREE.Vector3();
        player.object3D.getWorldPosition(look);
        look.y = mesh.position.y;
        mesh.lookAt(look);
      }
      this._sceneRoot.add(mesh);
      this._clearPopup = { mesh: mesh, tex: tex, mat: mat, t0: performance.now() };
    },

    _clearClearPopup: function () {
      var p = this._clearPopup;
      if (!p) return;
      if (p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh);
      if (p.tex) p.tex.dispose();
      if (p.mat) p.mat.dispose();
      if (p.mesh && p.mesh.geometry) p.mesh.geometry.dispose();
      this._clearPopup = null;
    },

    _tickClearPopup: function (now) {
      var p = this._clearPopup;
      if (!p || !p.mesh) return;
      now = now || performance.now();
      var t = (now - p.t0) / 1000;
      p.mesh.position.y += 0.012;
      var op = t < 0.15 ? (t / 0.15) : Math.max(0, 1 - (t - 0.9) / 0.55);
      if (p.mat) p.mat.opacity = op;
      p.mesh.scale.setScalar(1 + Math.min(0.12, t * 0.35));
      if (t > 1.5) this._clearClearPopup();
    },

    /**
     * Flash newly placed / junk blocks white a few times (live + replay share this).
     * placed: [{ cell: { mesh, color } }, ...] from placeCells / spawnGarbageLayers.
     */
    _startBlockBlink: function (placed, opts) {
      if (!placed || !placed.length) return;
      opts = opts || {};
      if (!this._blockBlinks) this._blockBlinks = [];
      var meshes = [];
      var colors = [];
      for (var i = 0; i < placed.length; i++) {
        var cell = placed[i] && (placed[i].cell || placed[i]);
        var mesh = cell && cell.mesh;
        if (!mesh || !mesh.material) continue;
        meshes.push(mesh);
        colors.push(cell.color || (opts.garbage ? '#e8e8ee' : '#ffffff'));
      }
      if (!meshes.length) return;
      var fx = {
        meshes: meshes,
        colors: colors,
        t0: performance.now(),
        stepMs: opts.stepMs != null ? opts.stepMs : 85,
        durationMs: opts.durationMs != null ? opts.durationMs : 520,
        garbage: !!opts.garbage
      };
      this._blockBlinks.push(fx);
      this._paintBlockBlink(fx, true);
    },

    _paintBlockBlink: function (fx, bright) {
      if (!fx || !fx.meshes) return;
      for (var i = 0; i < fx.meshes.length; i++) {
        var m = fx.meshes[i].material;
        if (!m) continue;
        if (bright) {
          if (m.color) m.color.set(0xffffff);
          if (m.emissive) m.emissive.set(0xffffff);
          if (m.emissiveIntensity != null) m.emissiveIntensity = fx.garbage ? 0.95 : 1.15;
        } else {
          if (m.color) m.color.set(fx.garbage ? 0x9aa3ad : 0xb0b8c4);
          if (m.emissive) m.emissive.set(fx.garbage ? 0x556677 : 0x445566);
          if (m.emissiveIntensity != null) m.emissiveIntensity = 0.22;
        }
        m.needsUpdate = true;
      }
    },

    _restoreBlockBlink: function (fx) {
      if (!fx || !fx.meshes) return;
      for (var i = 0; i < fx.meshes.length; i++) {
        var mesh = fx.meshes[i];
        if (!mesh || !mesh.material) continue;
        var m = mesh.material;
        var col = fx.colors[i] || '#ffffff';
        if (m.color) m.color.set(col);
        if (m.emissive) m.emissive.set(0xffffff);
        if (m.emissiveIntensity != null) m.emissiveIntensity = 0.42;
        m.needsUpdate = true;
      }
    },

    _tickBlockBlinks: function (now) {
      if (!this._blockBlinks || !this._blockBlinks.length) return;
      now = now || performance.now();
      var kept = [];
      for (var i = 0; i < this._blockBlinks.length; i++) {
        var fx = this._blockBlinks[i];
        var elapsed = now - fx.t0;
        if (elapsed >= fx.durationMs) {
          this._restoreBlockBlink(fx);
          continue;
        }
        var step = Math.floor(elapsed / Math.max(1, fx.stepMs));
        this._paintBlockBlink(fx, (step % 2) === 0);
        kept.push(fx);
      }
      this._blockBlinks = kept;
    },

    _tickVictory: function (now) {
      var v = this._victory;
      if (!v || !v.root) return;
      now = now || performance.now();
      var t = (now - v.t0) / 1000;
      var dt = Math.min(0.05, (this._lastVictoryTick ? (now - this._lastVictoryTick) / 1000 : 0.016));
      this._lastVictoryTick = now;

      if (v.titleMesh) {
        v.titleMesh.scale.setScalar(1 + 0.06 * Math.sin(t * 6));
      }
      if (v.rim && v.rim.material) {
        v.rim.material.opacity = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 5));
      }
      for (var i = 0; i < v.bits.length; i++) {
        var b = v.bits[i];
        b.vy -= 3.2 * dt;
        b.mesh.position.x += b.vx * dt;
        b.mesh.position.y += b.vy * dt;
        b.mesh.position.z += b.vz * dt;
        b.mesh.rotation.x += b.spin * dt;
        b.mesh.rotation.z += b.spin * 0.7 * dt;
        if (b.mesh.material) {
          b.mesh.material.opacity = Math.max(0, 0.95 - t * 0.28);
        }
      }
      if (t > 3.6) this._clearVictory();
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
      if (this._dualIdleTimer) { clearTimeout(this._dualIdleTimer); this._dualIdleTimer = null; }
      this._clearVictory();
      this._clearMatchBanner();
      this._endingMatch = false;
      this._pendingMatch = null;
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
      this._resetStationsForMatch();
      if (this._pad) this._pad.visible = true;
      if (this._pocket) this._pocket.visible = true;
      this._setBotStationVisible(true);

      var bpm = this.botTargetBpm != null ? this.botTargetBpm : 12;
      if (this.bot) {
        this.bot.setCup(this.cups.red);
        this.bot._lastThink = performance.now() - 400;
        if (this.bot.setTargetBpm) this.bot.setTargetBpm(bpm);
        this.bot.enable(true);
      }
      if (this.botBlue) {
        this.botBlue.setCup(this.cups.blue);
        this.botBlue._lastThink = performance.now();
        if (this.botBlue.setTargetBpm) this.botBlue.setTargetBpm(bpm);
        this.botBlue.enable(true);
      }

      // Dual preview: hide undriven bot avatars only — never the local player body
      this._hidePreviewBotBodies();

      this._musicIdle();
      this._updateHUD();
      console.log('[StacksGame] offline preview: blue bot vs red bot seed=' + seed);
    },

    _hidePreviewBotBodies: function () {
      // Dual-bot idle is pad-only — bots do NOT use Mixamo seat bodies.
      // Previously bailed on isMultiplayer, so after PvP the red/blue seat kept
      // the last human remoteHandData (client saw themselves ghosted in their slot).
      this._clearRemoteAvatarEl(document.getElementById('bot-body'));
      this._clearRemoteAvatarEl(document.getElementById('spec-blue-body'));
      // Offline-only: wipe lobby pool too. In a live lobby, remote-body-N still
      // shows other waiting players around the ring.
      if (!global.isMultiplayer) {
        for (var i = 0; i < 4; i++) {
          this._clearRemoteAvatarEl(document.getElementById('remote-body-' + i));
        }
        this._remoteBodyMap = {};
      }
    },

    /**
     * Local player body always on.
     * Offline bot: show red bot avatar.
     * Multiplayer: leave remote-driven bodies alone (poses keep them visible).
     */
    _showMatchBodies: function (opts) {
      opts = opts || {};
      var player = document.getElementById('player-body');
      if (player) {
        player.setAttribute('visible', true);
        if (player.object3D) player.object3D.visible = true;
      }

      if (global.isMultiplayer) return;

      var bot = document.getElementById('bot-body');
      var showBot = !!opts.showBot;
      if (bot) {
        bot.setAttribute('visible', showBot);
        if (bot.object3D) bot.object3D.visible = showBot;
        if (!showBot && bot.dataset) bot.dataset.posed = '';
      }

      var spec = document.getElementById('spec-blue-body');
      if (spec) {
        spec.setAttribute('visible', false);
        if (spec.object3D) spec.object3D.visible = false;
      }
    },

    _matchEndResult: function (info, cancelled) {
      info = info || {};
      var meta = this._matchSeatMeta || {};
      var mp = global.lobbyState && global.lobbyState.matchPlayers;
      var wasBot = meta.wasBotMatch;
      if (wasBot == null) {
        wasBot = !!(mp && mp.red === '__BOT__') ||
          (!!global.isLobbyBotMatch && !(mp && mp.red && mp.red !== '__BOT__'));
      }
      return {
        cancelled: !!cancelled,
        winner: cancelled ? null : (info.winner || (this.modes && this.modes.winner) || null),
        reason: cancelled ? null : (info.reason || (this.modes && this.modes.reason) || null),
        scores: this.modes && this.modes.scores
          ? { blue: this.modes.scores.blue | 0, red: this.modes.scores.red | 0 }
          : null,
        wasBotMatch: !!wasBot,
        blueName: meta.blueName || null,
        redName: meta.redName || null
      };
    },

    endMatch: function () {
      if (this._endingMatch) return;
      var lobbyPlaying = !!(global.lobbyState && global.lobbyState.matchState === 'PLAYING');

      // Spectators / late joiners must NEVER end a live lobby match
      if (global.isMultiplayer && lobbyPlaying) {
        var can = global.StacksLobby && typeof global.StacksLobby.canIControlMatch === 'function'
          ? global.StacksLobby.canIControlMatch()
          : !!(global.StacksLobby && global.StacksLobby.isHost);
        if (!can) {
          console.warn('[StacksGame] endMatch ignored — not a match controller');
          return;
        }
      }

      this._endingMatch = true;
      if (this._dualIdleTimer) { clearTimeout(this._dualIdleTimer); this._dualIdleTimer = null; }
      this._countdownGoAt = null;
      this._clearMatchBanner();
      var result = this._matchEndResult(null, true);

      // Only hit the lobby end path while a lobby match is actually PLAYING.
      // Hosting + dual-bot idle is WAITING — sendMatchAction('end') was a no-op and
      // left _endingMatch stuck true (START button stayed on END MATCH).
      if (global.isMultiplayer && lobbyPlaying && global.sendMatchAction) {
        global.sendMatchAction('end', result);
        // Host: endLobbyMatch → onMatchEnded sync. Peer: wait for match-ended.
        // Safety if host end somehow skipped the callback:
        if (this._endingMatch && global.StacksLobby && global.StacksLobby.isHost) {
          this.onMatchEnded(result);
        }
        return;
      }
      // Offline / WAITING lobby / COUNTDOWN local: always tear down + resume dual idle
      this.onMatchEnded(result);
    },

    /** Stop dual-bot idle / local preview without touching lobby match state. */
    stopLocalPreview: function () {
      if (!this._dualBotPreview && !(this.matchActive && !(global.lobbyState &&
          global.lobbyState.matchState === 'PLAYING'))) {
        return;
      }
      if (this._dualIdleTimer) { clearTimeout(this._dualIdleTimer); this._dualIdleTimer = null; }
      this._endingMatch = false;
      this.onMatchEnded({ cancelled: true });
    },

    _endFromMode: function (info) {
      if (this._endingMatch || !this.matchActive) return;
      this._endingMatch = true;
      // Freeze sim immediately so bots / garbage can't keep mutating during victory
      this.matchActive = false;
      if (this.modes && this.modes.stop) this.modes.stop();
      if (this.bot) this.bot.enable(false);
      if (this.botBlue) this.botBlue.enable(false);
      if (this._dualIdleTimer) { clearTimeout(this._dualIdleTimer); this._dualIdleTimer = null; }

      var result = this._matchEndResult(info, false);
      var selfEnd = this;
      // Defer teardown so the winning place can finish record/broadcast on this frame
      // (sync onMatchEnded mid-_afterPlace previously cleared cups before serialize).
      setTimeout(function () {
        if (global.isMultiplayer && global.StacksLobby && global.StacksLobby.isHost) {
          global.endLobbyMatch(result);
        } else if (!global.isMultiplayer) {
          selfEnd.onMatchEnded(Object.assign({ victory: true }, result));
        } else if (global.sendMatchAction) {
          global.sendMatchAction('end', result);
          // onMatchEnded arrives via match-ended broadcast (with winner payload)
          selfEnd._endingMatch = false;
        }
      }, 0);
    },

    _saveMatchHistory: function (opts, matchTimestamp) {
      opts = opts || {};
      if (global.isMobileSpectator) return;
      if (this._dualBotPreview) return;
      if (!global.StacksStats || typeof global.StacksStats.saveMatch !== 'function') return;

      // endLobbyMatch parks seated humans as spectators BEFORE deferred history runs.
      // Use GO seat snapshot — never trust live isSpectator / cleared matchPlayers.
      var meta = this._matchSeatMeta || {};
      var wasSeated = !!meta.wasSeatedPlayer;
      if (global.isMultiplayer && !wasSeated) {
        if (global.isSpectator) return;
      } else if (!global.isMultiplayer && global.isSpectator) {
        return;
      }

      var side = meta.mySide || (this._localSide ? this._localSide() : 'blue');
      var statsSide = this.matchStats && (side === 'red' ? this.matchStats.red : this.matchStats.blue);
      var snap = statsSide && statsSide.snapshot
        ? statsSide.snapshot(performance.now())
        : null;
      var scores = (this.modes && this.modes.scores) || { blue: 0, red: 0 };
      var winner = (opts && opts.winner) || (this.modes && this.modes.winner) || null;
      var bot = meta.wasBotMatch != null
        ? !!meta.wasBotMatch
        : !!(global.isLobbyBotMatch ||
          (global.lobbyState && global.lobbyState.matchPlayers &&
            global.lobbyState.matchPlayers.red === '__BOT__'));
      var multi = !!global.isMultiplayer && !bot;
      var nick = (global.playerNickname || 'Player').slice(0, 12);
      var oppName = bot ? 'Bot' : null;
      if (multi) {
        oppName = (side === 'red' ? meta.blueName : meta.redName) || oppName;
        if (!oppName && global.lobbyState) {
          var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
          var mp = global.lobbyState.matchPlayers || {};
          var oppId = mp.blue === myId ? mp.red : mp.blue;
          var players = global.lobbyState.players || [];
          for (var i = 0; i < players.length; i++) {
            if (players[i].id === oppId) {
              oppName = (players[i].nickname || 'Player').slice(0, 12);
              break;
            }
          }
        }
        if (!oppName) oppName = side === 'red' ? 'Blue' : 'Red';
      }
      var result = null;
      if (winner === side) result = 'WIN';
      else if (winner && winner !== 'draw') result = 'LOSS';
      else if (winner === 'draw') result = 'DRAW';

      var record = {
        // Must match IndexedDB replay key or Watch replay / prune cannot find it
        timestamp: matchTimestamp || Date.now(),
        mode: multi ? 'multi' : 'single',
        result: result,
        playerScore: scores[side] | 0,
        opponentScore: scores[side === 'red' ? 'blue' : 'red'] | 0,
        bot: bot,
        reason: (opts && opts.reason) || (this.modes && this.modes.reason) || null,
        nickname: nick,
        opponentName: oppName,
        side: side,
        player: snap,
        boardSize: this.boardSize || 6,
        hasReplay: true
      };
      global.StacksStats.saveMatch(record);
    },

    _appVersion: function () {
      return String(global.STACKS_VERSION || '0.0.0');
    },

    /** DodgeVR-style discreet stamp: vX.Y.Z [| N FPS] [| lobby status] */
    _refreshVersionDisplay: function (extra) {
      var ver = 'v' + this._appVersion();
      var parts = [ver];
      if (this._fpsValue > 0) parts.push(this._fpsValue + ' FPS');
      if (extra) parts.push(extra);
      var label = parts.join(' | ');
      var el = document.getElementById('version-display');
      if (el) el.setAttribute('text', 'value', label);
      var chip = document.getElementById('app-version-chip');
      if (chip) chip.textContent = ver;
      var mob = document.getElementById('mobile-version-label');
      if (mob) mob.textContent = ver;
    },

    _tickVersionFps: function () {
      this._fpsFrames = (this._fpsFrames || 0) + 1;
      var now = performance.now();
      if (!this._fpsLast) this._fpsLast = now;
      if (now - this._fpsLast < 500) return;
      this._fpsValue = Math.round((this._fpsFrames * 1000) / (now - this._fpsLast));
      this._fpsFrames = 0;
      this._fpsLast = now;
      var status = '';
      if (global.isMultiplayer) {
        if (global.isHost) status = 'HOST';
        else if (global.isMobileSpectator) status = 'WATCH';
        else status = 'JOINED';
      }
      this._refreshVersionDisplay(status || null);
    },

    _updateHUD: function () {
      var blueScore = document.getElementById('blue-score');
      var redScore = document.getElementById('red-score');
      if (blueScore) blueScore.setAttribute('text', 'value', String(this.modes.scores.blue | 0));
      if (redScore) redScore.setAttribute('text', 'value', String(this.modes.scores.red | 0));

      this._updateNameLabels();
      this._updateCupStatsHUD();
      this._refreshVersionDisplay(
        global.isMultiplayer
          ? (global.isHost ? 'HOST' : (global.isMobileSpectator ? 'WATCH' : 'JOINED'))
          : null
      );
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

    /** BattleBlocks station card — compact, right of NEXT, aligned columns. */
    _ensureStationCard: function (side) {
      if (!this._stationCards) this._stationCards = {};
      if (this._stationCards[side]) return this._stationCards[side];
      var nextCol = side === 'red' ? this._nextRed : this._nextBlue;
      if (!nextCol || !nextCol.root) return null;

      var canvas = document.createElement('canvas');
      canvas.width = 480;
      canvas.height = 560;
      var tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      var mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide
      });
      // Left-origin plane: left edge clears NEXT frame (~0.14 half-width)
      var mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.40, 0.47), mat);
      mesh.geometry.translate(0.20, 0, 0);
      mesh.frustumCulled = false;
      mesh.renderOrder = 20;
      mesh.position.set(0.18, 0.48, 0.05);
      nextCol.root.add(mesh);
      var card = { mesh: mesh, canvas: canvas, tex: tex, mat: mat, side: side };
      this._stationCards[side] = card;
      return card;
    },

    _sideNickname: function (side) {
      var ls = global.lobbyState;
      var mp = ls && ls.matchPlayers;
      if (mp && mp[side]) {
        var id = mp[side];
        if (id === '__BOT__') return 'Bot';
        var players = ls.players || [];
        for (var i = 0; i < players.length; i++) {
          if (players[i].id === id) {
            return String(players[i].nickname || 'Player').slice(0, 12);
          }
        }
        return side === 'blue' ? 'Blue' : 'Red';
      }
      // Offline / preview fallbacks
      if (side === 'blue') return String(global.playerNickname || 'Player').slice(0, 12);
      if (this._dualBotPreview) return 'Bot';
      if (global.isLobbyBotMatch || (this.bot && this.bot.enabled)) return 'Bot';
      return 'Red';
    },

    _setNameLabel: function (side, name, visible) {
      var el = document.getElementById(side === 'red' ? 'hud-name-red' : 'hud-name-blue');
      if (!el) return;
      var layout = this._layout;
      if (layout) {
        var c = side === 'red' ? layout.redC : layout.blueC;
        // Above cup, facing that side's player
        var zOff = side === 'red' ? -0.15 : 0.15;
        el.setAttribute('position', c.x + ' 2.08 ' + (c.z + zOff));
        el.setAttribute('rotation', side === 'red' ? '0 180 0' : '0 0 0');
      }
      el.setAttribute('text', 'value', name || '');
      el.setAttribute('visible', !!visible && !!name);
      if (el.object3D) el.object3D.visible = !!visible && !!name;
    },

    _updateNameLabels: function () {
      var multi = !!global.isMultiplayer;
      var playing = !!this.matchActive && !this._dualBotPreview;
      var preview = !!this._dualBotPreview;
      if (!multi && !playing && !preview) {
        this._setNameLabel('blue', '', false);
        this._setNameLabel('red', '', false);
        return;
      }
      // Preview: show bot labels; live/offline match or lobby seats: real nicknames
      if (preview) {
        this._setNameLabel('blue', 'Blue Bot', true);
        this._setNameLabel('red', 'Red Bot', true);
        return;
      }
      var show = multi || playing;
      this._setNameLabel('blue', this._sideNickname('blue'), show);
      this._setNameLabel('red', this._sideNickname('red'), show);
    },

    _drawStationCard: function (side, stats, now) {
      var card = this._ensureStationCard(side);
      if (!card || !stats) return;
      var f = stats.cardFields(now);
      var nick = this._sideNickname(side);
      var ctx = card.canvas.getContext('2d');
      var W = card.canvas.width;
      var H = card.canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      var left = 8;
      var rateX = 300;
      var y = 42;

      // Nickname header (chosen name — was missing vs DodgeVR)
      ctx.fillStyle = side === 'red' ? '#ff8866' : '#66ccff';
      ctx.font = 'italic 700 44px Arial, Helvetica, sans-serif';
      ctx.fillText(String(nick || ''), left, y);
      y += 52;
      ctx.fillStyle = '#ffffff';

      function block(label, main, rate) {
        ctx.font = 'italic 600 36px Arial, Helvetica, sans-serif';
        ctx.fillText(label, left, y);
        y += 52;
        ctx.font = 'italic 700 72px Arial, Helvetica, sans-serif';
        ctx.fillText(String(main), left, y);
        if (rate != null && rate !== '') {
          ctx.font = 'italic 600 44px Arial, Helvetica, sans-serif';
          ctx.fillText(String(rate) + '/min', rateX, y);
        }
        y += 78;
      }

      block('Blocks', f.blocks, f.blockRate);
      block('Attacks', f.attacks, f.attackRate);
      block('Time', f.time, null);

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
      ground.name = 'arena-ground';
      root.add(ground);
      this._groundMat = groundMat;
      this._arenaGround = ground;

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
      underGlow.name = 'arena-underglow';
      root.add(underGlow);
      this._arenaUnderGlow = underGlow;

      // Station floor plates (black squares + neon diamond rings) removed —
      // they z-fought / flickered against the arena ground.

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
      horizon.name = 'arena-horizon';
      root.add(horizon);
      this._arenaHorizon = horizon;

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
      haze.name = 'arena-haze';
      root.add(haze);
      this._arenaHaze = haze;

      // Honor passthrough preference if already set before arena boot
      if (global.StacksPassthrough && global.StacksPassthrough.enabled) {
        this.applyPassthroughVisuals(true);
      }

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

    /**
     * Quest passthrough look (VRLeague-style): stay in immersive-ar and only
     * show/hide an opaque shell. Transparent clear ⇒ room; opaque dome ⇒ VR void.
     * Cups / stations / bodies always stay visible.
     */
    applyPassthroughVisuals: function (on) {
      var sceneEl = this.el && this.el.sceneEl;
      var scene3d = sceneEl && sceneEl.object3D;
      var root = this._sceneRoot;
      var showShell = !on;

      if (this._arenaGround) this._arenaGround.visible = showShell;
      if (this._arenaUnderGlow) this._arenaUnderGlow.visible = showShell;
      if (this._arenaHorizon) this._arenaHorizon.visible = showShell;
      if (this._arenaHaze) this._arenaHaze.visible = showShell;

      // Full-sphere veil so AR alpha-blend can't leak room when PASS is off
      if (root && THREE && !this._arenaPassVeil) {
        var veil = new THREE.Mesh(
          new THREE.SphereGeometry(12, 24, 16),
          new THREE.MeshBasicMaterial({
            color: 0x06040a,
            side: THREE.BackSide,
            depthWrite: true,
            fog: false,
            toneMapped: false
          })
        );
        veil.name = 'arena-pass-veil';
        veil.renderOrder = -10;
        root.add(veil);
        this._arenaPassVeil = veil;
      }
      if (this._arenaPassVeil) this._arenaPassVeil.visible = showShell;

      if (!sceneEl || !scene3d) return;

      if (on) {
        sceneEl.removeAttribute('background');
        scene3d.background = null;
        scene3d.fog = null;
        if (sceneEl.renderer) sceneEl.renderer.setClearColor(0x000000, 0);
      } else {
        sceneEl.setAttribute('background', 'color', '#06040a');
        scene3d.fog = new THREE.FogExp2(0x09060c, 0.010);
        // Keep renderer alpha true (AR session); opaque veil + clear cover the room
        if (sceneEl.renderer) sceneEl.renderer.setClearColor(0x06040a, 1);
      }
    },

    _prepareMatchHud: function () {
      // Legacy a-text cards stay hidden; canvas station cards are the HUD.
      // Name labels are driven separately by _updateNameLabels.
      var hideIds = [
        'hud-card-blue', 'hud-card-red', 'hud-cup-blue', 'hud-cup-red'
      ];
      for (var h = 0; h < hideIds.length; h++) {
        var hide = document.getElementById(hideIds[h]);
        if (!hide) continue;
        hide.setAttribute('visible', false);
        if (hide.object3D) hide.object3D.visible = false;
      }
      this._hudPrepared = true;
      this._updateNameLabels();
    },

    _placeMatchHud: function () {
      if (!this.cups) return;
      this._placeStationCard('blue');
      this._placeStationCard('red');
    },

    _placeStationCard: function (side) {
      var card = this._ensureStationCard(side);
      if (!card || !card.mesh) return;
      // Mid-height of snug NEXT frame, left edge clear of neon
      card.mesh.position.set(0.18, 0.48, 0.05);
      card.mesh.rotation.set(0, 0, 0);
      card.mesh.visible = true;
    },

    /** Absolute bot blocks/min. 0 = frozen (no new moves). */
    setBotTargetBpm: function (bpm) {
      if (global.StacksBotBpm) bpm = global.StacksBotBpm.clamp(bpm);
      else {
        bpm = Number(bpm);
        if (!isFinite(bpm) || bpm < 0) bpm = 12;
        bpm = Math.max(0, Math.min(40, Math.round(bpm)));
      }
      this.botTargetBpm = bpm;
      global._botTargetBpm = bpm;
      if (this.bot && this.bot.setTargetBpm) this.bot.setTargetBpm(bpm);
      if (this.botBlue && this.botBlue.setTargetBpm) this.botBlue.setTargetBpm(bpm);
      this._updateBotPace();
      return bpm;
    },

    // Back-compat for older menu hooks
    setBotSpeedScale: function (v) {
      return this.setBotTargetBpm(v);
    },

    /** Drive bots toward the configured average BPM (light wander stays inside CupBot). */
    _updateBotPace: function () {
      var now = performance.now();
      var bpm = this.botTargetBpm;
      if (bpm == null && global.StacksBotBpm) bpm = global.StacksBotBpm.load();
      if (bpm == null) bpm = 12;

      if (this.bot && this.bot.enabled && this.bot.setTargetBpm) {
        this.bot.setTargetBpm(bpm, now);
      }
      if (this.botBlue && this.botBlue.enabled && this.botBlue.setTargetBpm) {
        this.botBlue.setTargetBpm(bpm, now);
      }
    },

    _idleJunkEnabled: function () {
      if (typeof global.getIdleJunk === 'function') return !!global.getIdleJunk();
      if (global.lobbyState && global.lobbyState.idleJunk != null) {
        return !!global.lobbyState.idleJunk;
      }
      return true;
    },

    /**
     * Battle Blocks inactivity pressure: optional, and only after MATCH_ARM from GO.
     * Then GRACE with no place → 1 junk layer every INTERVAL until they act / top out.
     */
    _tickInactivityJunk: function (now) {
      if (!this.matchActive || this._endingMatch || this._dualBotPreview) return;
      if (global.replayActive) return;
      if (!this._idleJunkEnabled()) return;
      now = now || performance.now();
      var goAt = this._matchGoAt || 0;
      var armAt = goAt + INACTIVE_MATCH_ARM_MS;
      // Whole match is safe until arm — pressure is late-game, not opener
      if (!goAt || now < armAt) return;

      if (!this._lastPlaceAt) this._lastPlaceAt = { blue: now, red: now };
      if (!this._lastInactiveJunkAt) this._lastInactiveJunkAt = { blue: 0, red: 0 };

      var sides = ['blue', 'red'];
      for (var i = 0; i < sides.length; i++) {
        var side = sides[i];
        // Skip sides that are AI-driven — bots place on their own clock
        if (side === 'red' && this.bot && this.bot.enabled) continue;
        if (side === 'blue' && this.botBlue && this.botBlue.enabled) continue;

        // Idle clock starts at arm (or last place after arm), not from GO
        var last = this._lastPlaceAt[side] || goAt;
        if (last < armAt) last = armAt;
        var idle = now - last;
        if (idle < INACTIVE_GRACE_MS) continue;

        var sinceJunk = now - (this._lastInactiveJunkAt[side] || 0);
        // First junk fires once grace expires; then every INTERVAL
        var firstDue = !(this._lastInactiveJunkAt[side]) ||
          (this._lastInactiveJunkAt[side] < last);
        if (!firstDue && sinceJunk < INACTIVE_INTERVAL_MS) continue;
        if (firstDue && idle < INACTIVE_GRACE_MS) continue;

        var cup = this.cups[side];
        if (!cup || !cup.spawnGarbageLayers) continue;
        var idleLayers = cup.spawnGarbageLayers(1, this.attackSys.garbageHoles);
        var idleSpawned = [];
        if (idleLayers && idleLayers.length) {
          for (var il = 0; il < idleLayers.length; il++) {
            if (idleLayers[il].cells) {
              for (var ic = 0; ic < idleLayers[il].cells.length; ic++) {
                idleSpawned.push(idleLayers[il].cells[ic]);
              }
            }
          }
        }
        if (idleSpawned.length) this._startBlockBlink(idleSpawned, { garbage: true });
        this._lastInactiveJunkAt[side] = now;
        if (window.matchRecorder) {
          window.matchRecorder.recordEvent('garbage', {
            side: side, layers: 1, holes: this.attackSys.garbageHoles, reason: 'inactive'
          });
        }
        if (!this._dualBotPreview) this._sfx('attack', { volume: 0.4 });
        if (cup.isToppedOut()) {
          var over = this.modes.onOverflow(side);
          if (over) this._endFromMode(over);
        }
        var mp = !!global.isMultiplayer;
        var host = global.StacksLobby && global.StacksLobby.isHost;
        if (mp && host && global.sendCupEvent) {
          this._broadcastGarbage([{ side: side, layers: 1, spawned: idleSpawned }]);
        }
        this._updateHUD();
        this._updateDamageHUD();
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
      var hasPeers = host
        ? (global.StacksLobby.connections && global.StacksLobby.connections.length > 0)
        : !!(global.StacksLobby.conn && global.StacksLobby.conn.open);
      // Everyone in the lobby streams poses (players + VR spectators) so joiners
      // can see who is already here. Mobile watchers stay receive-only.
      if (!hasPeers) return;

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
      this._tickVersionFps();
      if (this._poseDesktop) this._poseDesktop();
      this._tickPieceAnims();
      this._tickVictory();
      this._tickClearPopup();
      this._tickBlockBlinks();
      this._prepareMatchHud();
      this._placeMatchHud();

      this._updateCupGrab();

      if (this.held) {
        this._updateGhost();
        if (this._pad) this._pad.visible = true;
      } else if (this._pad) {
        this._pad.visible = true;
      }

      if (this.matchActive && !this._endingMatch) {
        if (this.matchState === 'COUNTDOWN') {
          this._tickCountdown(Date.now());
        } else {
          // In multiplayer, ONLY the host advances attack/idle timers.
          // Never trust sticky isLobbyBotMatch on a peer (double-spawn + RNG desync).
          var mp = !!global.isMultiplayer;
          var host = global.StacksLobby && global.StacksLobby.isHost;
          var tickAttack = !mp || !!host;
          if (tickAttack) {
            var applied = this.attackSys.tick(this.cups, performance.now());
            if (applied && applied.length) {
              if (!this._dualBotPreview) this._sfx('attack', { volume: 0.5 });
              for (var i = 0; i < applied.length; i++) {
                if (applied[i].spawned && applied[i].spawned.length) {
                  this._startBlockBlink(applied[i].spawned, { garbage: true });
                }
                if (window.matchRecorder) {
                  window.matchRecorder.recordEvent('garbage', {
                    side: applied[i].side,
                    layers: applied[i].layers,
                    holes: this.attackSys.garbageHoles
                  });
                }
                if (this.cups[applied[i].side].isToppedOut()) {
                  var over = this.modes.onOverflow(applied[i].side);
                  if (over) this._endFromMode(over);
                }
                if (applied[i].side === (this._localCup() && this._localCup().side)) {
                  var hand = (this.held && this.held.handEl) || document.getElementById('rightHand');
                  this._pulseHaptic(hand, 0.8, 90);
                }
              }
              if (mp && host) this._broadcastGarbage(applied);
              this._updateHUD();
            }
            // Battle Blocks inactivity fill (host / offline / lobby-bot only)
            this._tickInactivityJunk(performance.now());
          }
          this._updateDamageHUD();
          // Timed modes: only host (or offline) may end on clock — peers get match-ended
          if (!mp || host) {
            var t = this.modes.tick(Date.now());
            if (t && t.ended) this._endFromMode(t);
          }
          this._updateBotPace();
          if (this.bot && this.bot.enabled) this.bot.tick(performance.now());
          if (this.botBlue && this.botBlue.enabled) this.botBlue.tick(performance.now());
          if (this._dualBotPreview) this._hidePreviewBotBodies();
          // Refresh PPM / timer on cup-side stats ~4Hz
          if (!this._lastStatsHud || performance.now() - this._lastStatsHud > 250) {
            this._lastStatsHud = performance.now();
            this._updateCupStatsHUD();
          }
          this._heartbeatSpectatorSync();
        }
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
