// dot-game.js — DotminationVR match component.
//
// Structure and all multiplayer / avatar / spectator / replay / victory plumbing are
// carried over from StacksVR's stacks-game.js (methods marked "from StacksVR" are copied
// verbatim or with only cup→board edits). The Dotmination-specific parts are new:
// hex boards (dot-board.js), DUEL vs RUSH layouts, tap/poke input, turn handling,
// bots (dot-bot.js) and RUSH "infection" attacks via StacksVR's attack.js buffers.
//
// Modes (lobby splitBoards flag, host-synced like StacksVR's idle-junk toggle):
//   DUEL  one shared vertical board between the players, turn-based, blue vs red.
//   RUSH  each player gets an own board vs a purple "virus" bot (StacksVR-style stations).
//         Clear your board first. Chain reactions of 4+ bursts infect the opponent's board.
(function (global) {
  'use strict';

  var DB = global.DotBoard;
  var VICTORY_HOLD_MS = 30000;
  var VICTORY_CONFETTI_S = 3.6;
  var BOARD_Y = 1.38;
  var DUEL_SEAT_Z = 0.62;
  var RUSH_SEAT = { x: 0.7, z: 1.77 };
  var RUSH_BOARD_Z = 1.15;
  var DUEL_TURN_MS = 25000;        // local human auto-move after this (only own client acts)
  var DUEL_MOVE_CAP = 160;         // safety net: most dots wins
  var RUSH_MS = 180000;            // race clock (modes.js 'rush')
  var VIRUS_DELAY_MS = 420;
  var ATTACK_MIN_BURSTS = 4;       // chain of 4+ bursts attacks in RUSH
  var POKE_IN = 0.022;
  var POKE_OUT = 0.05;

  function otherSide(side) { return side === 'blue' ? 'red' : 'blue'; }

  /** One playfield: logic + view + turn bookkeeping. Duck-types StacksVR's cup API
   *  (serialize / applySnapshot / clearAll / pivot) so shared modules keep working. */
  function GameBoard(key, a, b, radius) {
    this.key = key;
    this.a = a;           // first player (blue/red)
    this.b = b;           // opponent (red or 'virus')
    this.state = new DB.State(radius);
    this.view = new DB.View({ radius: radius });
    this.view.root.name = 'dot-board-' + key;
    this.turn = a;
    this.turnNo = 0;
    this.rev = 0;
    this.moves = {};
    this.turnStartedAt = performance.now();
    this.pivot = this.view.root;
  }
  GameBoard.prototype.serialize = function () {
    var s = this.state.serialize();
    s.k = this.key;
    s.turn = this.turn;
    s.turnNo = this.turnNo;
    s.rev = this.rev;
    return s;
  };
  GameBoard.prototype.applySnapshot = function (snap) {
    if (!snap) return;
    this.state.load(snap);
    if (snap.turn) this.turn = snap.turn;
    if (snap.turnNo != null) this.turnNo = snap.turnNo | 0;
    if (snap.rev != null) this.rev = snap.rev | 0;
    this.turnStartedAt = performance.now();
    this.view.syncFrom(this.state);
  };
  GameBoard.prototype.clearAll = function () {
    this.state.clear();
    this.turnNo = 0;
    this.rev = 0;
    this.moves = {};
    this.turn = this.a;
    this.view.syncFrom(this.state);
  };

  AFRAME.registerComponent('dot-game', {
    schema: {
      mode: { type: 'string', default: 'duel' }
    },

    init: function () {
      this.boards = {};
      this.cups = {};
      this.mode = 'duel';
      this.radius = 4;
      this.attackSys = new global.StacksAttack({ damageCap: 6, damageDelayMs: 2200 });
      this.modes = new global.StacksModes.ModeController({ mode: 'duel' });
      this.matchStats = global.StacksStats ? new global.StacksStats.MatchStats() : null;
      this.bot = null;      // StacksVR menu/replay poke .enable(); see _botShim
      this.botBlue = null;
      this._remoteBodyMap = {};
      this.botTargetBpm = (global.StacksBotBpm && global.StacksBotBpm.load)
        ? global.StacksBotBpm.load()
        : (global._botTargetBpm != null ? global._botTargetBpm : 12);
      this.matchActive = false;
      this.matchState = 'WAITING';
      this.boardSize = 6;
      this._sceneRoot = null;
      this._lastPoseSend = 0;
      this._hover = { leftHand: -1, rightHand: -1 };
      this._poke = { leftHand: { armed: true }, rightHand: { armed: true } };
      this._tmp = new THREE.Vector3();
      this._tmp2 = new THREE.Vector3();
      this._tmpQ = new THREE.Quaternion();
      this._fwd = new THREE.Vector3();
      this._right = new THREE.Vector3();
      this._up = new THREE.Vector3();
      this._ray = new THREE.Raycaster();
      this._popups = [];

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
      this._sceneRoot.name = 'dotmination-arena';
      scene.add(this._sceneRoot);

      this._buildArenaAtmosphere({ x: -0.45, z: 1.0 }, { x: 0.45, z: -1.0 });

      var size = (global.getBoardSize && global.getBoardSize()) || 6;
      this.boardSize = size === 4 ? 4 : 6;
      var split = typeof global.getSplitBoards === 'function' ? !!global.getSplitBoards() : false;
      this._buildBoards(split ? 'rush' : 'duel', DB.radiusForBoardSize(this.boardSize));

      // StacksVR menus/replay call bot.enable(false) — keep a harmless shim
      var shim = { enabled: false, enable: function (on) { this.enabled = !!on; } };
      this.bot = shim;
      this.botBlue = { enabled: false, enable: function (on) { this.enabled = !!on; } };

      this._updateHUD();
      this._desktopHands();

      var selfBoot = this;
      this.el.sceneEl.addEventListener('board-size-changed', function (e) {
        var sz = e && e.detail && e.detail.boardSize;
        selfBoot.applyBoardSize(sz);
      });
      this.el.sceneEl.addEventListener('split-boards-changed', function (e) {
        var on = !!(e && e.detail && e.detail.splitBoards);
        selfBoot.applyMode(on ? 'rush' : 'duel');
      });
      this.el.sceneEl.addEventListener('lobby-state-updated', function () {
        if (selfBoot._isLiveMatchPlaying() || selfBoot.matchState === 'COUNTDOWN') return;
        if (global.getBoardSize) selfBoot.applyBoardSize(global.getBoardSize());
        if (global.getSplitBoards) selfBoot.applyMode(global.getSplitBoards() ? 'rush' : 'duel');
        selfBoot._updateNameLabels();
      });
      this._updateNameLabels();
      console.log('[DotGame] ready mode=' + this.mode + ' radius=' + this.radius);
    },

    // ── Layout ────────────────────────────────────────────────────────────

    _layoutFor: function (mode) {
      if (mode === 'rush') {
        return {
          mode: 'rush',
          boards: {
            blue: { x: -RUSH_SEAT.x, y: BOARD_Y, z: RUSH_BOARD_Z, yaw: 0 },
            red: { x: RUSH_SEAT.x, y: BOARD_Y, z: -RUSH_BOARD_Z, yaw: Math.PI }
          },
          seats: {
            blue: { x: -RUSH_SEAT.x, y: 0, z: RUSH_SEAT.z, ry: 0 },
            red: { x: RUSH_SEAT.x, y: 0, z: -RUSH_SEAT.z, ry: 180 }
          },
          cards: {
            blue: { x: -RUSH_SEAT.x + 0.66, y: 1.30, z: RUSH_BOARD_Z, yaw: 0 },
            red: { x: RUSH_SEAT.x - 0.66, y: 1.30, z: -RUSH_BOARD_Z, yaw: Math.PI }
          },
          blueC: { x: -RUSH_SEAT.x, z: RUSH_SEAT.z },
          redC: { x: RUSH_SEAT.x, z: -RUSH_SEAT.z }
        };
      }
      return {
        mode: 'duel',
        boards: { shared: { x: 0, y: BOARD_Y, z: 0, yaw: 0 } },
        seats: {
          blue: { x: 0, y: 0, z: DUEL_SEAT_Z, ry: 0 },
          red: { x: 0, y: 0, z: -DUEL_SEAT_Z, ry: 180 }
        },
        cards: {
          blue: { x: 0.68, y: 1.30, z: 0.03, yaw: 0 },
          red: { x: -0.68, y: 1.30, z: -0.03, yaw: Math.PI }
        },
        blueC: { x: 0, z: DUEL_SEAT_Z },
        redC: { x: 0, z: -DUEL_SEAT_Z }
      };
    },

    /** Seat pose for game-menu.js (player teleport) — {x,y,z,ry(deg)}. */
    seatPose: function (side) {
      var lay = this._layout || this._layoutFor(this.mode);
      return lay.seats[side === 'red' ? 'red' : 'blue'];
    },

    _buildBoards: function (mode, radius) {
      mode = mode === 'rush' ? 'rush' : 'duel';
      var keys = Object.keys(this.boards || {});
      for (var i = 0; i < keys.length; i++) {
        var old = this.boards[keys[i]];
        if (old.view.root.parent) old.view.root.parent.remove(old.view.root);
        if (old.label && old.label.group.parent) old.label.group.parent.remove(old.label.group);
        old.view.root.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        });
        if (old.label) { old.label.tex.dispose(); old.label.group.children[0].material.dispose(); }
      }
      this.mode = mode;
      this.radius = radius;
      this.boards = {};
      var lay = this._layoutFor(mode);
      this._layout = lay;
      if (mode === 'duel') {
        this.boards.shared = new GameBoard('shared', 'blue', 'red', radius);
        this.cups = { blue: this.boards.shared, red: this.boards.shared };
      } else {
        this.boards.blue = new GameBoard('blue', 'blue', 'virus', radius);
        this.boards.red = new GameBoard('red', 'red', 'virus', radius);
        this.cups = { blue: this.boards.blue, red: this.boards.red };
      }
      var self = this;
      Object.keys(this.boards).forEach(function (k) {
        var b = self.boards[k];
        var p = lay.boards[k];
        b.view.root.position.set(p.x, p.y, p.z);
        b.view.root.rotation.y = p.yaw;
        self._sceneRoot.add(b.view.root);
        b.view.onStep = function (kind, cells) { self._onViewStep(b, kind, cells); };
        b.label = self._makeBoardLabel(b, p);
      });
      this._placeStationCards();
      this._placeBotAnchors();
      this._placeOfflinePlayer();
      this.modes.setMode(mode);
      this._refreshScores();
      this._updateNameLabels();
    },

    _placeBotAnchors: function () {
      var lay = this._layout;
      var cb = document.getElementById('cup-bot');
      if (cb && lay) cb.setAttribute('position', lay.seats.red.x + ' 1.45 ' + (lay.seats.red.z + (this.mode === 'duel' ? -0.22 : -0.05)));
      var sb = document.getElementById('spec-blue-anchor');
      if (sb && lay) sb.setAttribute('position', lay.seats.blue.x + ' 1.6 ' + lay.seats.blue.z);
    },

    /** Offline / VR solo: stand at the blue seat whenever the layout changes. */
    _placeOfflinePlayer: function () {
      if (global.isMultiplayer || global.isMobileSpectator) return;
      if (this._placedForMode === this.mode) return;
      this._placedForMode = this.mode;
      var seat = this.seatPose('blue');
      var player = document.getElementById('player');
      if (!player || !seat) return;
      player.setAttribute('position', seat.x + ' 0 ' + seat.z);
      player.object3D.rotation.y = THREE.MathUtils.degToRad(seat.ry || 0);
    },

    /** Lobby boardSize 4 → small hex (37 dots), 6 → large hex (61 dots). */
    applyBoardSize: function (size) {
      size = size === 4 ? 4 : 6;
      this.boardSize = size;
      var r = DB.radiusForBoardSize(size);
      if (r === this.radius) return false;
      if (this._isLiveMatchPlaying() || this.matchState === 'COUNTDOWN') return false;
      this._rebuildIdle(this.mode, r);
      return true;
    },

    applyMode: function (mode) {
      mode = mode === 'rush' ? 'rush' : 'duel';
      if (mode === this.mode) return false;
      if (this._isLiveMatchPlaying() || this.matchState === 'COUNTDOWN') return false;
      this._rebuildIdle(mode, this.radius);
      return true;
    },

    _rebuildIdle: function (mode, radius) {
      var wasPreview = !!this._dualBotPreview;
      this._buildBoards(mode, radius);
      if (wasPreview) {
        this._dualBotPreview = false;
        this.matchActive = false;
        this.startOfflinePreviewMatch();
      }
    },

    // ── Canvas labels (board status + station cards) ─────────────────────

    _makeCanvasPlane: function (w, h, cw, ch) {
      var canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      var tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      var mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, toneMapped: false
      });
      var front = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      var back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      back.rotation.y = Math.PI; // readable (not mirrored) from behind
      var group = new THREE.Group();
      group.add(front);
      group.add(back);
      front.renderOrder = back.renderOrder = 20;
      return { group: group, canvas: canvas, ctx: canvas.getContext('2d'), tex: tex, last: '' };
    },

    _makeBoardLabel: function (board, p) {
      var lab = this._makeCanvasPlane(0.78, 0.13, 1024, 170);
      lab.group.position.set(p.x, p.y + board.view.plateRadius + 0.1, p.z);
      lab.group.rotation.y = p.yaw;
      this._sceneRoot.add(lab.group);
      return lab;
    },

    _drawLabel: function (lab, lines, color) {
      var key = lines.join('|') + color;
      if (lab.last === key) return;
      lab.last = key;
      var ctx = lab.ctx;
      var W = lab.canvas.width;
      var H = lab.canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = color;
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#ffffff';
      ctx.font = 'italic 800 78px Arial, Helvetica, sans-serif';
      ctx.fillText(lines[0] || '', W / 2, lines[1] ? 58 : H / 2);
      if (lines[1]) {
        ctx.shadowBlur = 0;
        ctx.fillStyle = color;
        ctx.font = '600 50px Arial, Helvetica, sans-serif';
        ctx.fillText(lines[1], W / 2, 132);
      }
      lab.tex.needsUpdate = true;
    },

    _placeStationCards: function () {
      if (!this._stationCards) this._stationCards = {};
      var lay = this._layout;
      var sides = ['blue', 'red'];
      for (var i = 0; i < sides.length; i++) {
        var card = this._ensureStationCard(sides[i]);
        var c = lay.cards[sides[i]];
        card.group.position.set(c.x, c.y, c.z);
        card.group.rotation.y = c.yaw;
      }
    },

    _ensureStationCard: function (side) {
      if (!this._stationCards) this._stationCards = {};
      if (this._stationCards[side]) return this._stationCards[side];
      var card = this._makeCanvasPlane(0.34, 0.40, 480, 560);
      card.group.children[1].visible = false; // one-sided: faces its own seat
      card.side = side;
      this._sceneRoot.add(card.group);
      this._stationCards[side] = card;
      return card;
    },

    /** BattleBlocks-style station card from StacksVR, relabelled for dots. */
    _drawStationCard: function (side, stats, now) {
      var card = this._ensureStationCard(side);
      if (!card || !stats) return;
      var f = stats.cardFields(now);
      var nick = this._sideNickname(side);
      var key = [nick, f.blocks, f.blockRate, f.attacks, f.attackRate, f.time.slice(0, -3)].join('|');
      if (card.last === key) return;
      card.last = key;
      var ctx = card.ctx;
      var W = card.canvas.width;
      var H = card.canvas.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(6,8,14,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      var left = 18;
      var rateX = 250;
      var y = 52;
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
          ctx.font = 'italic 600 38px Arial, Helvetica, sans-serif';
          ctx.fillText(String(rate) + '/min', rateX, y);
        }
        y += 78;
      }
      block('Moves', f.blocks, f.blockRate);
      block(this.mode === 'rush' ? 'Attacks' : 'Bursts', this.mode === 'rush' ? f.attacks : (stats.layers | 0),
        this.mode === 'rush' ? f.attackRate : null);
      block('Time', f.time, null);
      card.tex.needsUpdate = true;
    },

    _updateCupStatsHUD: function () {
      if (!this.matchStats) return;
      var now = performance.now();
      this._drawStationCard('blue', this.matchStats.blue, now);
      this._drawStationCard('red', this.matchStats.red, now);
      var blueEl = document.getElementById('stats-blue');
      var redEl = document.getElementById('stats-red');
      if (blueEl) blueEl.setAttribute('text', 'value', this.matchStats.blue.cardText(now));
      if (redEl) redEl.setAttribute('text', 'value', this.matchStats.red.cardText(now));
    },

    _sideColorCss: function (side) {
      if (side === 'red') return '#ff6a4a';
      if (side === 'virus') return '#c27bff';
      return '#4aa8ff';
    },

    _turnName: function (side) {
      if (side === 'virus') return 'VIRUS';
      if (this._dualBotPreview) return side.toUpperCase() + " BOT'S";
      var me = this._mySeatSide();
      if (me && me === side && !this._dualBotPreview) return 'YOUR';
      var n = this._sideNickname(side) || side;
      return String(n).toUpperCase() + "'S";
    },

    _mySeatSide: function () {
      if (global.isMobileSpectator) return null;
      if (global.isMultiplayer) {
        var Lobby = global.StacksLobby;
        if (Lobby && Lobby.amMatchPlayer && Lobby.amMatchPlayer()) return Lobby.mySide();
        return null;
      }
      return 'blue';
    },

    _updateBoardLabels: function (now) {
      var keys = Object.keys(this.boards);
      for (var i = 0; i < keys.length; i++) {
        var b = this.boards[keys[i]];
        if (!b.label) continue;
        var lines;
        var color;
        if (!this.matchActive && !this._victory) {
          lines = ['DOTMINATION', this.mode === 'rush' ? 'RUSH · clear the virus first' : 'DUEL · take every dot'];
          color = '#9fb3c8';
        } else if (!this.matchActive) {
          var w = this.modes && this.modes.winner;
          lines = ['GAME OVER', this.mode === 'duel'
            ? b.state.count('blue') + '  ·  ' + b.state.count('red')
            : Math.round(100 * b.state.count(b.a) / Math.max(1, b.state.count(b.a) + b.state.count('virus'))) + '% dominated'];
          color = this._sideColorCss(w === 'red' ? 'red' : 'blue');
        } else if (this.matchState === 'COUNTDOWN') {
          lines = [this.mode === 'rush' ? 'CLEAR YOUR BOARD' : 'DOMINATE THE FIELD', 'get ready'];
          color = '#ffd56a';
        } else if (this.mode === 'duel') {
          var t = b.turn;
          var sub = b.state.count('blue') + '  ·  ' + b.state.count('red');
          if (this._isLocalHumanSide(t) && this.matchActive) {
            var left = Math.max(0, DUEL_TURN_MS - (now - b.turnStartedAt));
            if (left < 10000) sub += '   ⏱ ' + Math.ceil(left / 1000) + 's';
          }
          lines = [this._turnName(t) + ' TURN', sub];
          color = this._sideColorCss(t);
        } else {
          var own = b.state.count(b.a);
          var vir = b.state.count('virus');
          var pct = Math.round(100 * own / Math.max(1, own + vir));
          var pend = this.attackSys.getPending(b.a);
          var head = b.turn === 'virus' ? 'VIRUS…' : (this._isLocalHumanSide(b.a) ? 'YOUR MOVE' : this._turnName(b.a) + ' MOVE');
          var rem = this.modes && this.modes.mode && this.modes.mode.timed && this.modes.active
            ? Math.max(0, this.modes.mode.durationMs - (Date.now() - this.modes.matchStart)) : 0;
          var clock = rem ? '   ' + Math.floor(rem / 60000) + ':' + ('0' + Math.floor((rem % 60000) / 1000)).slice(-2) : '';
          lines = [head, pct + '% dominated' + (pend ? '   ⚠ +' + pend : '') + clock];
          color = pend ? '#ffcc33' : this._sideColorCss(b.a);
        }
        this._drawLabel(b.label, lines, color);
      }
    },

    // ── Seats / authority ──────────────────────────────────────────────────

    _localSide: function () {
      var Lobby = global.StacksLobby;
      if (global.isMultiplayer && Lobby && Lobby.amMatchPlayer && Lobby.amMatchPlayer()) {
        return Lobby.mySide ? Lobby.mySide() : 'blue';
      }
      return 'blue';
    },

    _isBotSide: function (side) {
      if (this._dualBotPreview) return true;
      return !!(this._seats && this._seats[side] && this._seats[side].bot);
    },

    _hostRunsBots: function () {
      return !global.isMultiplayer || !!(global.StacksLobby && global.StacksLobby.isHost);
    },

    /** Should THIS client execute moves for player `side` (human seat or bot)? */
    _drivesSide: function (side) {
      if (side === 'virus') return false;
      if (this._dualBotPreview) return true;
      if (this._isBotSide(side)) return this._hostRunsBots() && !global.isMobileSpectator;
      return this._isLocalAuthoritySide(side);
    },

    _isLocalHumanSide: function (side) {
      if (!side || side === 'virus' || this._dualBotPreview) return false;
      if (this._isBotSide(side)) return false;
      return this._isLocalAuthoritySide(side) && this._canControl();
    },

    /** Driver of the next/last move on this board. RUSH virus is run by the board owner's driver. */
    _drivesBoardActor: function (board, actor) {
      if (actor === 'virus') return this._drivesSide(board.a);
      return this._drivesSide(actor);
    },

    // ── Input: laser point + trigger, finger poke, desktop mouse ────────────

    _bindInput: function () {
      var self = this;
      function menuOpen() {
        var m = document.querySelector('[vr-menu]');
        var c = m && m.components && m.components['vr-menu'];
        return !!(c && c.menuVisible);
      }
      function attachHand(id) {
        var hand = document.getElementById(id);
        if (!hand) { setTimeout(function () { attachHand(id); }, 200); return; }
        hand.addEventListener('triggerdown', function () {
          if (menuOpen() && id === 'rightHand') return;
          var pick = self._pickForHand(hand);
          if (pick && pick.index >= 0) self._tryHumanTap(pick.board, pick.index, hand);
        });
      }
      attachHand('leftHand');
      attachHand('rightHand');

      // Desktop: click a dot with the mouse (pointer-lock look stays on drag)
      var down = null;
      window.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        down = { x: e.clientX, y: e.clientY };
      });
      window.addEventListener('mouseup', function (e) {
        if (e.button !== 0 || !down) return;
        var moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
        down = null;
        if (moved > 6 || self._isPresenting() || global.isMobileSpectator) return;
        var pick = self._pickFromMouse(e);
        if (pick && pick.index >= 0) self._tryHumanTap(pick.board, pick.index, null);
      });
      window.addEventListener('mousemove', function (e) {
        if (self._isPresenting() || global.isMobileSpectator) return;
        self._mouseEvt = e;
      });
      window.addEventListener('keydown', function (e) {
        if (e.repeat) return;
        if (e.key === 'n' || e.key === 'N') {
          // Desktop helper: toggle DUEL/RUSH (host or offline)
          var want = self.mode !== 'rush';
          if (global.requestSplitBoards) global.requestSplitBoards(want);
        }
      });
    },

    _boardsForInput: function () {
      var out = [];
      var keys = Object.keys(this.boards);
      for (var i = 0; i < keys.length; i++) out.push(this.boards[keys[i]]);
      return out;
    },

    _handRay: function (hand) {
      if (!hand || !hand.object3D) return null;
      hand.object3D.updateWorldMatrix(true, false);
      var rc = hand.components && hand.components.raycaster;
      var o = new THREE.Vector3();
      var d = new THREE.Vector3(0, 0, -1);
      if (rc && rc.data && rc.data.origin) o.set(rc.data.origin.x, rc.data.origin.y, rc.data.origin.z);
      if (rc && rc.data && rc.data.direction) d.set(rc.data.direction.x, rc.data.direction.y, rc.data.direction.z);
      hand.object3D.localToWorld(o);
      hand.object3D.getWorldQuaternion(this._tmpQ);
      d.applyQuaternion(this._tmpQ).normalize();
      return { origin: o, dir: d };
    },

    _pickRay: function (origin, dir) {
      var best = null;
      var boards = this._boardsForInput();
      for (var i = 0; i < boards.length; i++) {
        var hit = boards[i].view.pickRay(origin, dir);
        if (hit.index >= 0 && hit.dist < 6 && (!best || hit.dist < best.dist)) {
          best = { board: boards[i], index: hit.index, dist: hit.dist };
        }
      }
      return best;
    },

    _pickForHand: function (hand) {
      var r = this._handRay(hand);
      return r ? this._pickRay(r.origin, r.dir) : null;
    },

    _pickFromMouse: function (e) {
      var cam = this.el.sceneEl.camera;
      var canvas = this.el.sceneEl.canvas;
      if (!cam || !canvas) return null;
      var rect = canvas.getBoundingClientRect();
      var ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      this._ray.setFromCamera(ndc, cam);
      return this._pickRay(this._ray.ray.origin, this._ray.ray.direction);
    },

    /** Board the local human may act on right now (or null). */
    _myActionBoard: function () {
      if (!this.matchActive || this.matchState !== 'PLAYING' || this._endingMatch || this._endPending) return null;
      if (this._dualBotPreview || global.replayActive) return null;
      var side = this._localSide();
      if (!this._isLocalHumanSide(side)) return null;
      var b = this.mode === 'duel' ? this.boards.shared : this.boards[side];
      if (!b || b.turn !== side) return null;
      return b;
    },

    _tryHumanTap: function (board, idx, handEl) {
      var mine = this._myActionBoard();
      if (!mine || mine !== board) {
        if (board && this.matchActive && !this._dualBotPreview) this._pulseHaptic(handEl, 0.15, 25);
        return false;
      }
      var side = this._localSide();
      if (board.view.busy() || !board.state.canTap(side, idx)) {
        this._pulseHaptic(handEl, 0.2, 30);
        this._sfx('rotate', { volume: 0.15, rate: 0.6 });
        return false;
      }
      this._pulseHaptic(handEl, 0.55, 35);
      return !!this._performMove(board, side, idx, { human: true });
    },

    _tickPointers: function () {
      var presenting = this._isPresenting();
      var boards = this._boardsForInput();
      var mine = this._myActionBoard();
      var slots = { leftHand: 0, rightHand: 1 };
      var hit = {};
      if (presenting) {
        var self = this;
        ['leftHand', 'rightHand'].forEach(function (id) {
          var hand = document.getElementById(id);
          if (!hand) return;
          var pick = self._pickForHand(hand);
          hit[id] = pick;
          // Finger poke: controller tip pushed through the board plane
          if (mine && !mine.view.busy()) {
            var tip = self._handRay(hand);
            if (tip) {
              tip.origin.addScaledVector(tip.dir, 0.035);
              var pk = mine.view.pokePoint(tip.origin);
              var st = self._poke[id];
              if (pk.depth > POKE_OUT) st.armed = true;
              if (st.armed && pk.depth < POKE_IN && pk.index >= 0) {
                st.armed = false;
                self._tryHumanTap(mine, pk.index, hand);
              }
            }
          }
          var prev = self._hover[id];
          var now = pick && pick.board === mine ? pick.index : -1;
          if (now !== prev) {
            self._hover[id] = now;
            if (now >= 0) self._pulseHaptic(hand, 0.08, 10);
          }
        });
      } else if (this._mouseEvt && !global.isMobileSpectator) {
        hit.rightHand = this._pickFromMouse(this._mouseEvt);
      }
      for (var i = 0; i < boards.length; i++) {
        var b = boards[i];
        for (var id in slots) {
          var p = hit[id];
          var show = p && p.board === b && b === mine && b.state.canTap(this._localSide(), p.index);
          b.view.setHover(slots[id], show ? p.index : -1);
        }
      }
    },

    // ── Moves ─────────────────────────────────────────────────────────────

    _performMove: function (board, actor, idx, opts) {
      opts = opts || {};
      var turnNo = board.turnNo;
      var res = board.state.apply(actor, idx);
      if (!res) return null;
      board.turnNo++;
      board.rev++;
      board.turn = actor === board.a ? board.b : board.a;
      board.moves[actor] = (board.moves[actor] || 0) + 1;
      board.turnStartedAt = performance.now();
      board.view.play(res, board.state);
      this._afterMove(board, actor, idx, res, { local: true, turnNo: turnNo });
      return res;
    },

    _afterMove: function (board, actor, idx, res, info) {
      var now = performance.now();
      var isHost = !!(global.StacksLobby && global.StacksLobby.isHost);
      var hostSim = !global.isMultiplayer || isHost;
      var playerSide = actor === 'virus' ? null : actor;
      var explosions = res ? (res.explosions | 0) : (info.ex | 0);
      if (playerSide && this.matchStats) {
        this.matchStats.onPlace(playerSide, {
          layersCleared: explosions,
          score: res ? res.captured | 0 : 0,
          combo: res && res.waves ? res.waves.length : 0
        }, now);
      }
      var atk = null;
      if (this.mode === 'rush' && playerSide && explosions >= ATTACK_MIN_BURSTS) {
        var clear = {
          damage: Math.min(6, Math.floor(explosions / 2)),
          layersCleared: explosions // ≥2 also cancels incoming (StacksVR offset rule)
        };
        if (hostSim) atk = this.attackSys.onClear(playerSide, clear, now);
        else if (info.attack) {
          this.attackSys.applySerialized(info.attack, now);
          atk = info.atk || null;
        } else {
          atk = this.attackSys.onClear(playerSide, clear, now); // optimistic until host echo
        }
        if (atk && atk.sent > 0 && this.matchStats) this.matchStats.onAttack(playerSide, atk.sent, now);
      }
      if (!this._dualBotPreview && explosions >= 3) {
        var txt = 'CHAIN ×' + explosions;
        if (atk && atk.sent) txt += '  ▶ ' + atk.sent;
        else if (atk && atk.cancelled) txt += '  ✚ ' + atk.cancelled;
        this._showChainPopup(board, txt, this._sideColorCss(actor));
        if (global.StacksAudio && global.StacksAudio.clearChime) {
          global.StacksAudio.clearChime(Math.min(8, 1 + Math.floor(explosions / 3)), 0.4);
        }
      }
      this._refreshScores();
      if (window.matchRecorder && !this._dualBotPreview) {
        window.matchRecorder.recordEvent('move', {
          k: board.key, actor: actor, i: idx, snap: board.serialize(),
          scores: { blue: this.modes.scores.blue, red: this.modes.scores.red }
        });
      }
      if (info.local && global.isMultiplayer && !this._dualBotPreview && global.sendCupEvent) {
        var evt = {
          kind: 'move', k: board.key, actor: actor, i: idx, turnNo: info.turnNo,
          ex: explosions, snap: board.serialize(),
          scores: { blue: this.modes.scores.blue, red: this.modes.scores.red }
        };
        if (isHost && atk) { evt.attack = this.attackSys.serialize(now); evt.atk = atk; }
        global.sendCupEvent(evt);
      }
      // Host echoes the authoritative attack buffer after a peer's chain (StacksVR/DodgeVR echo)
      if (!info.local && isHost && atk && global.sendCupEvent) {
        global.sendCupEvent({
          kind: 'attack',
          attack: this.attackSys.serialize(now),
          scores: { blue: this.modes.scores.blue, red: this.modes.scores.red }
        });
      }
      if (info.local || isHost) this._checkBoardEnd(board);
      this._updateHUD();
    },

    _onViewStep: function (board, kind, cells) {
      if (this._dualBotPreview && !global.isMobileSpectator) {
        if (kind !== 'burst') return;
      }
      var vol = this._dualBotPreview ? 0.12 : 0.35;
      if (kind === 'grow') {
        this._sfx('place', { volume: vol * 0.8, rate: 0.9 + 0.08 * (cells[0] ? cells[0].s : 1) });
      } else if (kind === 'burst') {
        if (global.StacksAudio && global.StacksAudio.ping) {
          board._chainDepth = (board._chainDepth || 0) + 1;
          global.StacksAudio.ping(0.85 + Math.min(1.2, board._chainDepth * 0.08), vol + 0.1);
        }
        var mine = this.mode === 'rush' ? this._isLocalHumanSide(board.a) : (this.mode === 'duel' && !!this._mySeatSide());
        if (mine) {
          var h = document.getElementById('rightHand');
          this._pulseHaptic(h, 0.35, 25);
        }
      } else if (kind === 'charge') {
        board._chainDepth = 0;
      }
    },

    _checkBoardEnd: function (board) {
      if (this._endingMatch || this._endPending || !this.matchActive || this.matchState !== 'PLAYING') return;
      var winner = null;
      var reason = null;
      if (this.mode === 'duel') {
        var nb = board.state.count('blue');
        var nr = board.state.count('red');
        if (nb === 0 && nr > 0) { winner = 'red'; reason = 'dominated'; }
        else if (nr === 0 && nb > 0) { winner = 'blue'; reason = 'dominated'; }
        else if (board.turnNo >= DUEL_MOVE_CAP) {
          winner = nb > nr ? 'blue' : (nr > nb ? 'red' : 'draw');
          reason = 'moves';
        }
      } else {
        if (board.state.count('virus') === 0) { winner = board.a; reason = 'dominated'; }
        else if (board.state.count(board.a) === 0) { winner = otherSide(board.a); reason = 'overrun'; }
      }
      if (!winner) return;
      this.modes.winner = winner;
      this.modes.reason = reason;
      this._endPending = true;
      var self = this;
      // Let the winning chain finish animating before the banner
      var wait = Math.min(2500, board.view._queue.length * 150 + 250);
      this._endPendingAt = performance.now() + wait;
      setTimeout(function () {
        self._endPending = false;
        self._endFromMode({ ended: true, winner: winner, reason: reason });
      }, wait);
    },

    _refreshScores: function () {
      if (!this.modes) return;
      if (this.mode === 'duel' && this.boards.shared) {
        this.modes.scores.blue = this.boards.shared.state.count('blue');
        this.modes.scores.red = this.boards.shared.state.count('red');
      } else if (this.boards.blue && this.boards.red) {
        var sides = ['blue', 'red'];
        for (var i = 0; i < sides.length; i++) {
          var b = this.boards[sides[i]];
          var own = b.state.count(b.a);
          var vir = b.state.count('virus');
          this.modes.scores[sides[i]] = Math.round(100 * own / Math.max(1, own + vir));
        }
      }
      if (global.lobbyState && global.lobbyState.matchScore && this._isLiveMatchPlaying()) {
        global.lobbyState.matchScore.blue = this.modes.scores.blue;
        global.lobbyState.matchScore.red = this.modes.scores.red;
      }
    },

    _showChainPopup: function (board, text, color) {
      if (!this._sceneRoot) return;
      var lab = this._makeCanvasPlane(0.6, 0.12, 900, 180);
      var ctx = lab.ctx;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = color;
      ctx.shadowBlur = 24;
      ctx.fillStyle = '#ffffff';
      ctx.font = 'italic 900 110px Arial, Helvetica, sans-serif';
      ctx.fillText(text, 450, 95);
      lab.tex.needsUpdate = true;
      var p = board.view.root;
      lab.group.position.copy(p.position);
      lab.group.position.y += 0.05;
      lab.group.rotation.y = p.rotation.y;
      // nudge toward viewers on both faces
      this._sceneRoot.add(lab.group);
      this._popups.push({ lab: lab, t0: performance.now() });
    },

    _tickPopups: function (now) {
      for (var i = this._popups.length - 1; i >= 0; i--) {
        var p = this._popups[i];
        var t = (now - p.t0) / 1000;
        p.lab.group.position.y += 0.0009;
        var op = t < 0.9 ? 1 : Math.max(0, 1 - (t - 0.9) / 0.5);
        p.lab.group.children[0].material.opacity = op;
        var s = 1 + Math.min(0.25, t * 0.6);
        p.lab.group.scale.setScalar(s);
        if (t > 1.4) {
          if (p.lab.group.parent) p.lab.group.parent.remove(p.lab.group);
          p.lab.tex.dispose();
          p.lab.group.children[0].material.dispose();
          this._popups.splice(i, 1);
        }
      }
    },

    // ── Bots / virus / turn clock (driver side only) ─────────────────────

    _botDelayMs: function () {
      var bpm = this.botTargetBpm != null ? this.botTargetBpm : 12;
      if (bpm <= 0) return Infinity;
      if (this.mode === 'duel') return Math.max(700, Math.min(7000, 900 + 24000 / bpm));
      return Math.max(600, 60000 / bpm);
    },

    _tickDrivers: function (now) {
      if (!this.matchActive || this.matchState !== 'PLAYING' || this._endingMatch || this._endPending) return;
      if (global.replayActive) return;
      var keys = Object.keys(this.boards);
      for (var i = 0; i < keys.length; i++) {
        var b = this.boards[keys[i]];
        if (b.view.busy()) { b._schedTurn = -1; continue; }
        var actor = b.turn;
        if (!this._drivesBoardActor(b, actor)) continue;
        var isVirus = actor === 'virus';
        var isBot = isVirus || this._isBotSide(actor);
        if (!isBot) {
          // Local human: duel turn clock (own client only → race-free)
          if (this.mode === 'duel' && this._isLocalHumanSide(actor) &&
              now - b.turnStartedAt > DUEL_TURN_MS) {
            var auto = global.DotBot.chooseMove(b.state, actor, b.b === actor ? b.a : b.b, { depth: 1, noise: 3 });
            if (auto >= 0) this._performMove(b, actor, auto, { auto: true });
          }
          continue;
        }
        if (b._schedTurn !== b.turnNo) {
          b._schedTurn = b.turnNo;
          var delay = isVirus ? VIRUS_DELAY_MS : this._botDelayMs();
          if (this._dualBotPreview && !isVirus) delay = Math.max(900, Math.min(delay, 2600));
          b._dueAt = now + delay;
          b._botPick = null;
        }
        if (!isFinite(b._dueAt)) continue;
        var opp = actor === b.a ? b.b : b.a;
        // Pick slightly early so the bot avatar can reach toward the dot
        if (b._botPick == null && now >= b._dueAt - 650) {
          var prof = isVirus ? global.DotBot.PROFILES.virus
            : (this.mode === 'duel' ? global.DotBot.PROFILES.duel : global.DotBot.PROFILES.rushSeat);
          b._botPick = global.DotBot.chooseMove(b.state, actor, opp, prof);
        }
        if (b._botPick != null && !isVirus && actor === 'red') this._botReach(b, b._botPick, now);
        if (now >= b._dueAt && b._botPick != null) {
          var pick = b._botPick;
          b._botPick = null;
          b._dueAt = Infinity;
          if (pick >= 0 && b.state.canTap(actor, pick)) this._performMove(b, actor, pick, { bot: true });
          else if (pick < 0) this._checkBoardEnd(b);
        }
      }
      // Ease bot hand back after a tap
      var rt = global.botReactionTarget;
      if (rt && rt._releaseAt && now > rt._releaseAt) {
        rt.progress = Math.max(0, rt.progress - 0.06);
        if (rt.progress <= 0) global.botReactionTarget = null;
      }
    },

    /** Drive mixamo-body bot idle IK hand toward the chosen dot (window.botReactionTarget). */
    _botReach: function (board, idx, now) {
      if (this._dualBotPreview || idx == null || idx < 0) return;
      var body = document.getElementById('bot-body');
      if (!body || !body.object3D || !body.object3D.visible) return;
      var w = board.view.cellWorld(idx, new THREE.Vector3());
      var span = 650;
      var p = 1 - Math.max(0, Math.min(1, (board._dueAt - now) / span));
      global.botReactionTarget = {
        handTarget: { x: w.x, y: w.y, z: w.z + (board.view.root.rotation.y ? 0.03 : -0.03) },
        progress: p,
        _releaseAt: board._dueAt + 120
      };
    },

    // ── RUSH garbage ("infection") — host ticks buffers, board driver applies ──

    _garbageTargets: function () {
      var self = this;
      var out = {};
      ['blue', 'red'].forEach(function (side) {
        out[side] = {
          spawnGarbageLayers: function (amount) {
            var b = self.boards[side];
            if (!b) return [];
            var seed = ((self.bagSeed || 1) ^ Math.imul(b.rev + 1, 2654435761)) >>> 0;
            if (self._drivesSide(b.a)) {
              return [{ cells: self._applyGarbage(b, amount, seed, true) }];
            }
            if (global.sendCupEvent) {
              global.sendCupEvent({ kind: 'garbage-req', side: side, amount: amount, seed: seed });
            }
            return [];
          }
        };
      });
      return out;
    },

    _applyGarbage: function (board, amount, seed, local) {
      var changed = board.state.infect(board.a, 'virus', amount, seed);
      if (!changed.length) return changed;
      board.rev++;
      if (board.view.busy()) board.view.play({ steps: [] }, board.state);
      else board.view.syncFrom(board.state);
      board.view.flashCells(changed);
      this._sfx('garbage');
      if (this._isLocalHumanSide(board.a)) {
        this._pulseHaptic(document.getElementById('rightHand'), 0.8, 90);
        this._pulseHaptic(document.getElementById('leftHand'), 0.8, 90);
      }
      this._refreshScores();
      if (window.matchRecorder && !this._dualBotPreview) {
        window.matchRecorder.recordEvent('garbage', { k: board.key, cells: changed, snap: board.serialize() });
      }
      if (local && global.isMultiplayer && global.sendCupEvent) {
        var isHost = !!(global.StacksLobby && global.StacksLobby.isHost);
        var evt = { kind: 'garbage', k: board.key, cells: changed, snap: board.serialize(),
          scores: { blue: this.modes.scores.blue, red: this.modes.scores.red } };
        if (isHost) evt.attack = this.attackSys.serialize(performance.now());
        global.sendCupEvent(evt);
      }
      this._updateHUD();
      return changed;
    },

    // ── Networking (StacksVR cup-event channel, board payloads) ───────────

    _buildSnapshot: function () {
      var boards = {};
      var keys = Object.keys(this.boards);
      for (var i = 0; i < keys.length; i++) boards[keys[i]] = this.boards[keys[i]].serialize();
      return {
        mode: this.mode,
        radius: this.radius,
        boards: boards,
        // StacksVR shape so replay-state / older consumers still read it
        blue: this.cups.blue ? this.cups.blue.serialize() : null,
        red: this.cups.red ? this.cups.red.serialize() : null,
        scores: { blue: this.modes.scores.blue, red: this.modes.scores.red },
        attack: this.attackSys.serialize(performance.now()),
        matchState: this.matchState
      };
    },

    _broadcastState: function (reason) {
      if (!global.sendCupEvent) return;
      global.sendCupEvent({ kind: 'state', reason: reason || 'sync', snap: this._buildSnapshot() });
    },

    _ensureModeFor: function (mode, radius) {
      mode = mode === 'rush' ? 'rush' : 'duel';
      radius = radius || this.radius;
      if (mode !== this.mode || radius !== this.radius) this._buildBoards(mode, radius);
    },

    /** Merge boards from host/peer. Newer rev wins; view-only observers take any change. */
    _applyBoardSnaps: function (snaps, opts) {
      opts = opts || {};
      if (!snaps) return;
      var viewOnly = opts.forceAll || this._isViewOnlyObserver();
      var keys = Object.keys(snaps);
      for (var i = 0; i < keys.length; i++) {
        var s = snaps[keys[i]];
        if (!s) continue;
        var b = this.boards[s.k || keys[i]];
        if (!b) continue;
        var rev = s.rev | 0;
        if (viewOnly ? rev !== b.rev || opts.forceAll : rev > b.rev) {
          b.applySnapshot(s);
        }
      }
      this._refreshScores();
    },

    /** StacksVR name kept for onRemoteReplayMsg (copied) — cups map side→board snapshot. */
    _applyNetworkCups: function (cups, opts) {
      if (!cups) return;
      var mode = (cups.blue && cups.blue.k === 'shared') || (cups.red && cups.red.k === 'shared') ? 'duel' : 'rush';
      var r = (cups.blue && cups.blue.r) || (cups.red && cups.red.r) || this.radius;
      this._ensureModeFor(mode, r);
      var snaps = {};
      if (cups.blue) snaps[cups.blue.k || 'blue'] = cups.blue;
      if (cups.red) snaps[cups.red.k || 'red'] = cups.red;
      this._applyBoardSnaps(snaps, opts);
    },

    onRemoteCupEvent: function (evt) {
      if (!evt || !evt.kind) return;
      var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
      if (evt.from && myId && evt.from === myId) return;
      var isHost = !!(global.StacksLobby && global.StacksLobby.isHost);

      if (evt.kind === 'state') {
        var snap = evt.snap || {};
        if (snap.mode) this._ensureModeFor(snap.mode, snap.radius);
        this._applyBoardSnaps(snap.boards, {
          forceAll: this._isViewOnlyObserver() || evt.reason === 'match-start' || evt.reason === 'match-go'
        });
        if (snap.attack && (!isHost || this._isViewOnlyObserver())) {
          this.attackSys.applySerialized(snap.attack, performance.now());
        }
        this._updateHUD();
        return;
      }
      if (evt.kind === 'attack') {
        if (!isHost || this._isViewOnlyObserver()) {
          if (evt.attack) this.attackSys.applySerialized(evt.attack, performance.now());
        }
        this._updateHUD();
        return;
      }
      var board = evt.k ? this.boards[evt.k] : null;
      if (evt.kind === 'garbage-req') {
        var gb = this.boards[evt.side];
        if (gb && this._drivesSide(gb.a)) this._applyGarbage(gb, evt.amount | 0, evt.seed >>> 0, true);
        return;
      }
      if (!board) return;
      if (evt.kind === 'garbage') {
        if (this._drivesSide(board.a)) return; // we applied it ourselves
        if ((evt.snap && (evt.snap.rev | 0)) > board.rev || this._isViewOnlyObserver()) {
          board.applySnapshot(evt.snap);
          if (evt.cells) board.view.flashCells(evt.cells);
          if (!this._dualBotPreview) this._sfx('garbage');
        }
        if (evt.attack && (!isHost || this._isViewOnlyObserver())) {
          this.attackSys.applySerialized(evt.attack, performance.now());
        }
        this._refreshScores();
        this._updateHUD();
        return;
      }
      if (evt.kind === 'move') {
        if (this._drivesBoardActor(board, evt.actor) && !this._isViewOnlyObserver()) return;
        var res = null;
        if (evt.turnNo === board.turnNo && board.turn === evt.actor && board.state.canTap(evt.actor, evt.i)) {
          res = board.state.apply(evt.actor, evt.i); // animate locally (deterministic)
        }
        if (evt.snap) board.state.load(evt.snap);
        board.turn = evt.snap && evt.snap.turn ? evt.snap.turn : (evt.actor === board.a ? board.b : board.a);
        board.turnNo = evt.snap && evt.snap.turnNo != null ? evt.snap.turnNo | 0 : board.turnNo + 1;
        board.rev = evt.snap && evt.snap.rev != null ? evt.snap.rev | 0 : board.rev + 1;
        board.turnStartedAt = performance.now();
        board.moves[evt.actor] = (board.moves[evt.actor] || 0) + 1;
        if (res) board.view.play(res, board.state);
        else board.view.syncFrom(board.state);
        this._afterMove(board, evt.actor, evt.i, res, {
          local: false, ex: evt.ex, attack: evt.attack, atk: evt.atk
        });
      }
    },

    onRemoteSnapshot: function (data) {
      if (!data || !data.snapshot) return;
      var snap = data.snapshot;
      var viewOnly = this._isViewOnlyObserver();
      if (snap.mode) this._ensureModeFor(snap.mode, snap.radius);
      if (snap.boards) this._applyBoardSnaps(snap.boards, { forceAll: viewOnly && !this.matchActive });
      if (snap.attack && (viewOnly || !(global.StacksLobby && global.StacksLobby.isHost))) {
        this.attackSys.applySerialized(snap.attack, performance.now());
      }
      this._updateHUD();
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

    _isPresenting: function () {
      return !!(this.el.sceneEl.renderer && this.el.sceneEl.renderer.xr &&
        this.el.sceneEl.renderer.xr.isPresenting);
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

    // ── Match lifecycle (StacksVR flow; board setup is Dotmination) ───────

    _prepBoardsForMatch: function (seed) {
      var mode = typeof global.getSplitBoards === 'function' && global.getSplitBoards() ? 'rush' : 'duel';
      var size = (global.getBoardSize && global.getBoardSize()) ||
        (global.lobbyState && global.lobbyState.boardSize) || this.boardSize || 6;
      this.boardSize = size === 4 ? 4 : 6;
      var radius = DB.radiusForBoardSize(this.boardSize);
      if (mode !== this.mode || radius !== this.radius || !Object.keys(this.boards).length) {
        this._buildBoards(mode, radius);
      }
      this.bagSeed = seed >>> 0;
      if (global.lobbyState) global.lobbyState.bagSeed = this.bagSeed;
      var keys = Object.keys(this.boards);
      for (var i = 0; i < keys.length; i++) {
        var b = this.boards[keys[i]];
        // RUSH: both boards share the seed → identical start (StacksVR "mirrored bags")
        b.state.prefill(this.bagSeed, b.a, b.b);
        b.turnNo = 0;
        b.rev = 0;
        b.moves = {};
        b.turn = b.a;
        b._schedTurn = -1;
        b.view.syncFrom(b.state);
      }
      if (mode === 'duel') {
        var mp = global.lobbyState && global.lobbyState.matchPlayers;
        var humanVsBot = !global.isMultiplayer || (mp && (mp.red === '__BOT__') !== (mp.blue === '__BOT__'));
        // vs bot the human opens; PvP / dual-bot: seed decides
        if (humanVsBot && !this._dualBotPreview) {
          this.boards.shared.turn = mp && mp.blue === '__BOT__' ? 'red' : 'blue';
        } else {
          this.boards.shared.turn = (this.bagSeed & 1) ? 'red' : 'blue';
        }
      }
      this.attackSys.reset();
      this.modes.setMode(mode);
      this.modes.mode.durationMs = mode === 'rush' ? RUSH_MS : 0;
      this._refreshScores();
    },

    onMatchStarted: function (mp, startTime, isBotMatch, bagSeed) {
      if (this._dualIdleTimer) { clearTimeout(this._dualIdleTimer); this._dualIdleTimer = null; }
      this._clearVictory();
      this._clearMatchBanner();
      this._endingMatch = false;
      this._endPending = false;
      this._dualBotPreview = false;
      global.offlinePreview = false;
      global.botReactionTarget = null;

      var liveMp = mp || (global.lobbyState && global.lobbyState.matchPlayers);
      var reallyBot = !!(liveMp && liveMp.red === '__BOT__') ||
        (!!isBotMatch && !(liveMp && liveMp.red && liveMp.red !== '__BOT__'));
      global.isLobbyBotMatch = reallyBot;
      if (global.StacksLobby) global.StacksLobby.isLobbyBotMatch = reallyBot;

      this.matchActive = true;
      this.matchState = 'COUNTDOWN';
      var spectating = !!(global.isMobileSpectator ||
        (global.isSpectator && global.isMultiplayer &&
          !(global.StacksLobby && global.StacksLobby.amMatchPlayer && global.StacksLobby.amMatchPlayer())));
      this._pendingMatch = {
        mp: liveMp,
        startTime: startTime || Date.now(),
        isBotMatch: reallyBot,
        bagSeed: bagSeed,
        spectating: spectating
      };
      var seed = bagSeed != null ? bagSeed >>> 0
        : (global.lobbyState && global.lobbyState.bagSeed != null ? global.lobbyState.bagSeed >>> 0 : DB.newSeed());
      this._seats = {
        blue: { bot: !!(liveMp && liveMp.blue === '__BOT__') },
        red: { bot: !!(liveMp && liveMp.red === '__BOT__') || (!global.isMultiplayer && reallyBot) }
      };
      this._prepBoardsForMatch(seed);
      if (this.modes.stop) this.modes.stop();
      if (this._sceneRoot) this._sceneRoot.visible = true;
      this._showMatchBodies({ showBot: reallyBot && !spectating });
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

      var mp = pending.mp || (global.lobbyState && global.lobbyState.matchPlayers);
      var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
      var seated = !!(mp && myId &&
        (mp.blue === myId || (mp.red === myId && mp.red !== '__BOT__')));
      if (global.isMultiplayer) {
        global.isSpectator = !seated;
        if (global.StacksLobby) global.StacksLobby.isSpectator = !seated;
      }
      var blueBot = !!(mp && mp.blue === '__BOT__');
      var redBot = !!(mp && mp.red === '__BOT__');
      this._seats = { blue: { bot: blueBot }, red: { bot: redBot } };
      global.isLobbyBotMatch = !!(blueBot || redBot);
      if (global.StacksLobby) global.StacksLobby.isLobbyBotMatch = !!(blueBot || redBot);
      var startTime = pending.startTime || Date.now();

      this.modes.start(Date.now());
      this.modes.mode.durationMs = this.mode === 'rush' ? RUSH_MS : 0;
      this._refreshScores();
      if (this.matchStats) this.matchStats.start(performance.now());
      var goNow = performance.now();
      var keys = Object.keys(this.boards);
      for (var i = 0; i < keys.length; i++) {
        this.boards[keys[i]].turnStartedAt = goNow;
        this.boards[keys[i]]._schedTurn = -1;
      }
      var sceneEl = this.el.sceneEl;
      if (sceneEl) sceneEl.emit('lobby-state-updated');
      this._showMatchBodies({ showBot: !!redBot });
      this._rebindMatchSeatAvatars();

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
        wasBotMatch: !!(blueBot || redBot),
        mySide: mySeatSide,
        wasSeatedPlayer: !!seated
      };

      if (window.matchRecorder) {
        window.matchRecorder.startRecording(startTime);
        var init = {};
        for (var k = 0; k < keys.length; k++) init[keys[k]] = this.boards[keys[k]].serialize();
        window.matchRecorder.recordEvent('init', { mode: this.mode, radius: this.radius, boards: init });
      }
      this._matchGoAt = goNow;
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
      mesh.position.set(0, 2.08, 0);
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
      if (!this.matchActive && this.matchState === 'WAITING' && !this._pendingMatch) {
        if (!opts.hostLeft) {
          var sceneEarly = this.el && this.el.sceneEl;
          if (sceneEarly) sceneEarly.emit('lobby-state-updated');
          return;
        }
      }
      this._endPending = false;
      var wasPreview = !!this._dualBotPreview;
      this.matchActive = false;
      this.matchState = 'WAITING';
      this._dualBotPreview = false;
      global.offlinePreview = false;
      global.botReactionTarget = null;
      this._pendingMatch = null;
      this._countdownGoAt = null;
      this._matchGoAt = 0;
      this._clearMatchBanner();
      this._clearRemoteAvatarEl(document.getElementById('bot-body'));
      this._clearRemoteAvatarEl(document.getElementById('spec-blue-body'));

      if (this.modes) {
        if (opts.winner) this.modes.winner = opts.winner;
        if (opts.reason) this.modes.reason = opts.reason;
        if (opts.scores) {
          if (opts.scores.blue != null) this.modes.scores.blue = opts.scores.blue;
          if (opts.scores.red != null) this.modes.scores.red = opts.scores.red;
        }
        if (this.modes.stop) this.modes.stop();
      }
      var selfEnd = this;
      try {
        if (window.matchRecorder && !wasPreview) {
          if (typeof window.matchRecorder.stopCapture === 'function') window.matchRecorder.stopCapture();
          else window.matchRecorder.isRecording = false;
        }
      } catch (e) { console.warn('[DotGame] replay stopCapture failed', e); }

      this._updateHUD();
      var winner = (opts && opts.winner) || (this.modes && this.modes.winner);
      var festive = !opts.cancelled && !!winner && !wasPreview;
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
        setTimeout(function () {
          selfEnd._playVictory({
            winner: winner,
            reason: (opts && opts.reason) || (selfEnd.modes && selfEnd.modes.reason),
            wasBotMatch: opts && opts.wasBotMatch,
            blueName: opts && opts.blueName,
            redName: opts && opts.redName
          });
        }, 0);
        this._scheduleDualIdle(VICTORY_HOLD_MS);
      } else if (wasPreview && winner && !opts.cancelled) {
        // Dual-bot idle: short breather then a fresh board
        this._scheduleDualIdle(2500);
      } else {
        this._clearVictory();
        this._scheduleDualIdle(350);
      }
      this._endingMatch = false;
      var scene = this.el && this.el.sceneEl;
      if (scene) scene.emit('lobby-state-updated');

      setTimeout(function () {
        if (opts.cancelled || opts.hostLeft || wasPreview) return;
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
                console.warn('[DotGame] replay save failed', err);
              });
            }
          }
        } catch (e3) { console.warn('[DotGame] replay/history save failed', e3); }
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
      root.name = 'dot-victory';
      root.position.set(0, 2.05, 0);
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
      var sub = info.reason === 'dominated' ? 'Total domination!' :
        (info.reason === 'overrun' ? 'Board overrun by the virus' :
          (info.reason === 'moves' ? 'Move limit — most dots wins' :
            (info.reason === 'time' ? 'Time! Most dominated board wins' : 'Match over')));
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

    _tickVictory: function (now) {
      var v = this._victory;
      if (!v || !v.root) return;
      now = now || performance.now();
      var t = (now - v.t0) / 1000;
      var dt = Math.min(0.05, (this._lastVictoryTick ? (now - this._lastVictoryTick) / 1000 : 0.016));
      this._lastVictoryTick = now;

      // Title stays for VICTORY_HOLD_MS (cleared by dual-idle / START / Watch)
      if (v.titleMesh) {
        v.titleMesh.scale.setScalar(1 + 0.06 * Math.sin(t * 6));
      }
      if (v.rim && v.rim.material) {
        v.rim.material.opacity = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 5));
      }
      // Confetti burst only — strip bits after fade, keep banner
      if (v.bits && v.bits.length) {
        for (var i = 0; i < v.bits.length; i++) {
          var b = v.bits[i];
          if (!b.mesh) continue;
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
        if (t > VICTORY_CONFETTI_S) {
          for (var j = 0; j < v.bits.length; j++) {
            var bj = v.bits[j];
            if (!bj.mesh) continue;
            if (bj.mesh.parent) bj.mesh.parent.remove(bj.mesh);
            if (bj.mesh.material) bj.mesh.material.dispose();
            bj.mesh = null;
          }
          v.bits = [];
          if (v.sharedGeo) {
            v.sharedGeo.dispose();
            v.sharedGeo = null;
          }
        }
      }
    },

    startOfflineBotMatch: function () {
      // If hosting a lobby, never stay offline-only — spectators need match-started.
      if (global.StacksLobby && global.StacksLobby.isHost && global.startLobbyMatch) {
        global.startLobbyMatch();
        return;
      }
      global.isLobbyBotMatch = true;
      this.onMatchStarted({ blue: 'local', red: '__BOT__' }, Date.now(), true, DB.newSeed());
    },

    /** Idle spectacle / mobile Offline Preview: two local bots (StacksVR dual-bot idle). */
    startOfflinePreviewMatch: function () {
      if (this._dualIdleTimer) { clearTimeout(this._dualIdleTimer); this._dualIdleTimer = null; }
      this._clearVictory();
      this._clearMatchBanner();
      this._endingMatch = false;
      this._endPending = false;
      this._pendingMatch = null;
      global.offlinePreview = true;
      global.isLobbyBotMatch = true;
      this._dualBotPreview = true;
      this.matchActive = true;
      this.matchState = 'PLAYING';
      this._seats = { blue: { bot: true }, red: { bot: true } };
      var split = typeof global.getSplitBoards === 'function' && global.getSplitBoards();
      if ((split ? 'rush' : 'duel') !== this.mode) this._buildBoards(split ? 'rush' : 'duel', this.radius);
      this._prepBoardsForMatch(DB.newSeed());
      this.modes.start(Date.now());
      this.modes.mode.durationMs = this.mode === 'rush' ? RUSH_MS : 0;
      this._refreshScores();
      if (this.matchStats) this.matchStats.start(performance.now());
      this._hidePreviewBotBodies();
      this._musicIdle();
      this._updateHUD();
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
          console.warn('[DotGame] endMatch ignored — not a match controller');
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
        variant: this.mode,
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
        if (this._myActionBoard()) {
          msg = this._isPresenting() ? 'Point + trigger, or poke a dot' : 'Click a dot';
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

    /** Nickname floats above each seat, facing the opponent (who is the one reading it). */
    _setNameLabel: function (side, name, visible) {
      var el = document.getElementById(side === 'red' ? 'hud-name-red' : 'hud-name-blue');
      if (!el) return;
      var seat = this.seatPose(side);
      if (seat) {
        el.setAttribute('position', seat.x + ' 2.12 ' + seat.z);
        el.setAttribute('rotation', side === 'red' ? '0 0 0' : '0 180 0');
      }
      el.setAttribute('text', 'value', name || '');
      el.setAttribute('visible', !!visible && !!name);
      if (el.object3D) el.object3D.visible = !!visible && !!name;
    },

    /** Bot moves/min (menu BOT SPEED). DUEL: think delay; RUSH: seat bot pace. 0 = frozen. */
    setBotTargetBpm: function (bpm) {
      if (global.StacksBotBpm) bpm = global.StacksBotBpm.clamp(bpm);
      else {
        bpm = Number(bpm);
        if (!isFinite(bpm) || bpm < 0) bpm = 12;
        bpm = Math.max(0, Math.min(40, Math.round(bpm)));
      }
      this.botTargetBpm = bpm;
      global._botTargetBpm = bpm;
      var keys = Object.keys(this.boards);
      for (var i = 0; i < keys.length; i++) this.boards[keys[i]]._schedTurn = -1;
      return bpm;
    },

    setBotSpeedScale: function (v) {
      return this.setBotTargetBpm(v);
    },

    _updateThreats: function () {
      if (this.mode !== 'rush') {
        if (this.boards.shared) {
          var t = this.boards.shared.turn;
          this.boards.shared.view.setRim(this.matchActive ? t : 'none', 0);
        }
        return;
      }
      var now = performance.now();
      var sides = ['blue', 'red'];
      for (var i = 0; i < sides.length; i++) {
        var b = this.boards[sides[i]];
        if (!b) continue;
        var buf = this.attackSys.buffers[sides[i]];
        var urgency = 0;
        if (buf && buf.pending > 0) {
          var minReady = Infinity;
          for (var q = 0; q < buf.queue.length; q++) minReady = Math.min(minReady, buf.queue[q].readyAt);
          var left = Math.max(0, minReady - now);
          urgency = Math.max(0.25, 1 - Math.min(1, left / Math.max(1, this.attackSys.damageDelayMs)));
        }
        b.view.setRim(this.matchActive ? (b.turn === 'virus' ? 'virus' : b.a) : 'none', urgency);
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

    tick: function (time, delta) {
      if (!this._sceneRoot) return;
      var now = performance.now();
      var dt = Math.min(60, delta || 16);
      this._tickVersionFps();
      if (this._poseDesktop) this._poseDesktop();
      this._tickVictory();
      this._tickPopups(now);
      var keys = Object.keys(this.boards);
      for (var i = 0; i < keys.length; i++) this.boards[keys[i]].view.tick(now, dt);
      this._tickPointers();
      this._updateThreats();

      if (this.matchActive && !this._endingMatch) {
        if (this.matchState === 'COUNTDOWN') {
          this._tickCountdown(Date.now());
        } else {
          var mp = !!global.isMultiplayer;
          var host = global.StacksLobby && global.StacksLobby.isHost;
          if (this.mode === 'rush' && (!mp || host)) {
            var applied = this.attackSys.tick(this._garbageTargets(), now);
            if (applied && applied.length && window.matchRecorder) {
              for (var a = 0; a < applied.length; a++) {
                if (mp && host && global.sendCupEvent) {
                  global.sendCupEvent({ kind: 'attack', attack: this.attackSys.serialize(now) });
                }
              }
            }
          }
          if (!mp || host) {
            var t = this.modes.tick(Date.now());
            if (t && t.ended) this._endFromMode(t);
          }
          this._tickDrivers(now);
          if (this._dualBotPreview) this._hidePreviewBotBodies();
          if (!this._lastStatsHud || now - this._lastStatsHud > 250) {
            this._lastStatsHud = now;
            this._updateCupStatsHUD();
          }
          this._heartbeatSpectatorSync();
        }
      }
      if (!this._lastLabelAt || now - this._lastLabelAt > 200) {
        this._lastLabelAt = now;
        this._updateBoardLabels(now);
      }
      this._sendLocalPose();
    },

    /** match-replay.js hook: rebuild boards from recorded events (events-only replay). */
    replayApplyEvent: function (e) {
      if (!e || !e.data) return false;
      var d = e.data;
      if (e.type === 'init') {
        this._ensureModeFor(d.mode, d.radius);
        this._applyBoardSnaps(d.boards, { forceAll: true });
        this._updateHUD();
        return true;
      }
      if (e.type === 'move') {
        var b = this.boards[d.k];
        if (!b) return true;
        var res = b.state.canTap(d.actor, d.i) ? b.state.apply(d.actor, d.i) : null;
        if (d.snap) b.state.load(d.snap);
        b.turn = d.snap && d.snap.turn || b.turn;
        b.turnNo = d.snap ? d.snap.turnNo | 0 : b.turnNo + 1;
        b.rev = d.snap ? d.snap.rev | 0 : b.rev + 1;
        if (res) b.view.play(res, b.state);
        else b.view.syncFrom(b.state);
        if (d.scores && this.modes) {
          this.modes.scores.blue = d.scores.blue;
          this.modes.scores.red = d.scores.red;
        }
        if (d.actor !== 'virus' && this.matchStats) {
          this.matchStats.onPlace(d.actor, { layersCleared: res ? res.explosions : 0, combo: 0, score: 0 }, performance.now());
        }
        if (res && res.explosions >= 3) this._showChainPopup(b, 'CHAIN ×' + res.explosions, this._sideColorCss(d.actor));
        this._updateHUD();
        return true;
      }
      if (e.type === 'garbage') {
        var g = this.boards[d.k];
        if (g && d.snap) {
          g.applySnapshot(d.snap);
          if (d.cells) g.view.flashCells(d.cells);
          this._sfx('garbage');
        }
        return true;
      }
      return false;
    }
  });
})(window);
