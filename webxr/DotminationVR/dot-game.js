// dot-game.js — DotminationVR match component.
//
// The game is the original turn-based Dotmination (dot-rules.js / dot-bot.js are ports of the
// flatscreen www/ source) on one vertical board that both players see from their own side.
// Structure and all multiplayer / avatar / spectator / replay / victory plumbing are carried
// over from StacksVR's stacks-game.js (the "from StacksVR" methods are copied verbatim).
//
// What you play:
//   Solo        the original Levels 1–200 (same maps as the phone game, timer, best time,
//               3 stars) — or Level "R" = original Random mode with the Normal / Harder bot.
//   Multiplayer original multiplayer: host picks a Blank or Half-filled start, the starting
//               player alternates every match. Lobby vs bot = Random map.
// Colours: you (blue seat) = original player--2 pink, bot / opponent (red seat) = teal.
(function (global) {
  'use strict';

  var R = global.DotRules;
  var DB = global.DotBoard;
  var VICTORY_HOLD_MS = 30000;
  var VICTORY_CONFETTI_S = 3.6;
  var BOARD_Y = 1.38;
  var SEAT_Z = 0.62;
  var BOT_DELAY_MS = 1000;         // original: gsap.delayedCall(1, getBotMove)
  var POKE_IN = 0.03;    // fingertip within 3 cm of the glass = tap (stacks stand out up to 5.5 cm)
  var POKE_OUT = 0.07;   // pull back past 7 cm (clear of the stacks) before the next poke
  var TURN_MS = 25000;             // PvP only: your own client moves for you after this
  var MOVE_CAP = 600;              // safety net only (original has none): higher score wins
  var PROGRESS_KEY = 'dotminationvr-progress';
  var MAX_LEVEL = 200;

  function otherSide(side) { return side === 'blue' ? 'red' : 'blue'; }

  // Original localStorage shape: { level, levels: { levelN: { time: 'mm:ss' | null } } }
  function loadProgress() {
    try {
      var p = JSON.parse(global.localStorage.getItem(PROGRESS_KEY) || 'null');
      if (p && p.levels) return p;
    } catch (e) { /* ignore */ }
    return { level: 1, levels: { level1: { time: null } } };
  }
  function saveProgress(p) {
    try { global.localStorage.setItem(PROGRESS_KEY, JSON.stringify(p)); } catch (e) { /* ignore */ }
  }
  function maxUnlocked(p) {
    var m = 1;
    for (var k in p.levels) {
      var n = parseInt(k.replace('level', ''), 10);
      if (n > m) m = n;
    }
    return Math.min(MAX_LEVEL, m);
  }
  function fmtTime(ms) {
    var s = Math.floor(ms / 1000);
    return ('0' + Math.floor(s / 60)).slice(-2) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function timeSecs(t) {
    if (!t) return Infinity;
    var p = String(t).split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }

  /** The playfield: logic + view + turn bookkeeping. Duck-types StacksVR's cup API
   *  (serialize / applySnapshot / clearAll / pivot) so the shared modules keep working. */
  function GameBoard() {
    this.key = 'shared';
    this.a = 'blue';
    this.b = 'red';
    this.state = new R.State();
    this.view = new DB.View();
    this.view.root.name = 'dot-board';
    this.turn = 'blue';
    this.turnNo = 0;
    this.rev = 0;
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
    this.turn = this.a;
    this.view.syncFrom(this.state);
  };

  AFRAME.registerComponent('dot-game', {
    schema: {},

    init: function () {
      this.boards = {};
      this.cups = {};
      this.progress = loadProgress();
      this.level = this.progress.level != null ? this.progress.level : 1; // 0 = Random
      this.modes = new global.StacksModes.ModeController({ mode: 'duel' });
      this.matchStats = global.StacksStats ? new global.StacksStats.MatchStats() : null;
      this.bot = null;
      this.botBlue = null;
      this._remoteBodyMap = {};
      this._recent = { blue: [], red: [] };
      this.matchActive = false;
      this.matchState = 'WAITING';
      this.boardSize = 4;
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
      this._buildArenaAtmosphere({ x: 0, z: SEAT_Z + 0.3 }, { x: 0, z: -SEAT_Z - 0.3 });

      var size = (global.getBoardSize && global.getBoardSize()) || 4;
      this.boardSize = size === 6 ? 6 : 4;
      this._layout = {
        seats: {
          blue: { x: 0, y: 0, z: SEAT_Z, ry: 0 },
          red: { x: 0, y: 0, z: -SEAT_Z, ry: 180 }
        },
        cards: {
          blue: { x: 0.68, y: 1.30, z: 0.03, yaw: 0 },
          red: { x: -0.68, y: 1.30, z: -0.03, yaw: Math.PI }
        },
        blueC: { x: 0, z: SEAT_Z },
        redC: { x: 0, z: -SEAT_Z }
      };
      var b = new GameBoard();
      b.view.root.position.set(0, BOARD_Y, 0);
      this._sceneRoot.add(b.view.root);
      var self = this;
      b.view.onStep = function (kind, step) { self._onViewStep(b, kind, step); };
      b.label = this._makeBoardLabel(b, { x: 0, y: BOARD_Y, z: 0, yaw: 0 });
      this.boards = { shared: b };
      this.cups = { blue: b, red: b };
      this._placeStationCards();
      this._placeBotAnchors();
      this._placeOfflinePlayer();
      // Remembered colour scheme (original "Change Colors")
      var savedPal = 0;
      try { savedPal = parseInt(localStorage.getItem('dotminationvr-palette') || '0', 10) || 0; } catch (e) { /* ignore */ }
      if (savedPal) this.applyPalette(savedPal);

      // StacksVR menus/replay call bot.enable(false) — keep a harmless shim
      this.bot = { enabled: false, enable: function (on) { this.enabled = !!on; } };
      this.botBlue = { enabled: false, enable: function (on) { this.enabled = !!on; } };

      this._updateHUD();
      this._desktopHands();
      var selfBoot = this;
      this.el.sceneEl.addEventListener('board-size-changed', function (e) {
        selfBoot.applyBoardSize(e && e.detail && e.detail.boardSize);
      });
      this.el.sceneEl.addEventListener('lobby-state-updated', function () {
        if (global.getBoardSize) selfBoot.applyBoardSize(global.getBoardSize());
        selfBoot._updateNameLabels();
      });
      this._updateNameLabels();
      console.log('[DotGame] ready level=' + this.level);
    },

    /** Seat pose for game-menu.js (player teleport) — {x,y,z,ry(deg)}. */
    seatPose: function (side) {
      return this._layout.seats[side === 'red' ? 'red' : 'blue'];
    },

    _placeBotAnchors: function () {
      var lay = this._layout;
      var cb = document.getElementById('cup-bot');
      if (cb) cb.setAttribute('position', lay.seats.red.x + ' 1.45 ' + (lay.seats.red.z - 0.22));
      var sb = document.getElementById('spec-blue-anchor');
      if (sb) sb.setAttribute('position', lay.seats.blue.x + ' 1.45 ' + (lay.seats.blue.z + 0.22)); // mirror of cup-bot
    },

    _placeOfflinePlayer: function () {
      if (global.isMultiplayer || global.isMobileSpectator) return;
      var seat = this.seatPose('blue');
      var player = document.getElementById('player');
      if (!player || !seat) return;
      player.setAttribute('position', seat.x + ' 0 ' + seat.z);
      player.object3D.rotation.y = THREE.MathUtils.degToRad(seat.ry || 0);
    },

    /** Lobby boardSize slot (inherited from StacksVR) = bot difficulty: 4 Normal, 6 Harder. */
    applyBoardSize: function (size) {
      this.boardSize = size === 6 ? 6 : 4;
      return false;
    },

    _botDifficulty: function () {
      // Original: Levels always use the Normal bot; Random uses the chosen difficulty
      if (this._levelMatch) return 'random';
      return this.boardSize === 6 ? 'smart' : 'random';
    },

    // ── Levels (original Levels mode progression) ─────────────────────────

    levelInfo: function () {
      var max = maxUnlocked(this.progress);
      var entry = this.level > 0 ? this.progress.levels['level' + this.level] : null;
      return { level: this.level, max: max, best: entry && entry.time ? entry.time : null };
    },

    /** 0 = Random map, 1..unlocked = level. Clamped. Saved like the original. */
    setLevel: function (n) {
      var max = maxUnlocked(this.progress);
      n = Math.round(Number(n) || 0);
      if (n > max) n = 0;           // wrap: past the last unlocked level → Random
      if (n < 0) n = max;
      this.level = n;
      this.progress.level = n;
      saveProgress(this.progress);
      this._updateBoardLabels(performance.now(), true);
      return n;
    },

    _recordLevelWin: function (level, elapsedMs) {
      var t = fmtTime(elapsedMs);
      var key = 'level' + level;
      var prev = this.progress.levels[key] && this.progress.levels[key].time;
      var isBest = !prev || timeSecs(t) < timeSecs(prev);
      if (isBest) this.progress.levels[key] = { time: t };
      if (level < MAX_LEVEL && !this.progress.levels['level' + (level + 1)]) {
        this.progress.levels['level' + (level + 1)] = { time: null };
      }
      var secs = elapsedMs / 1000;
      // Original stars: won · under 2:00 · under 1:00
      var stars = 1 + (secs < 120 ? 1 : 0) + (secs < 60 ? 1 : 0);
      this.level = level >= MAX_LEVEL ? 1 : level + 1;
      this.progress.level = this.level;
      saveProgress(this.progress);
      return { time: t, best: isBest ? t : prev, isBest: isBest, stars: stars };
    },

    // ── Colours (original "Change Colors": 4 palettes, you = colour 2) ────

    /** Colour word for a seat in the current palette (blue seat = code 1 = original player--2). */
    _sideColorName: function (side) {
      var names = [['Teal', 'Pink'], ['Blue', 'Orange'], ['Magenta', 'Blue'], ['Indigo', 'Rose']];
      var pal = names[this._palette || 0] || names[0];
      return side === 'blue' ? pal[1] : pal[0];
    },

    cycleColors: function () {
      return this.applyPalette(((this._palette || 0) + 1) % 4);
    },

    /**
     * The 4 original colour schemes. Applied consistently: board + 3D stacks, rim, labels, HUD,
     * stats cards, lasers, UI cards, the menu accents and every seat's Mixamo body.
     */
    applyPalette: function (idx) {
      var pals = [['#12DACE', '#E11168'], ['#1100FF', '#FF3F00'], ['#FF00FF', '#0000FF'], ['#5158af', '#af5160']];
      idx = ((idx | 0) % pals.length + pals.length) % pals.length;
      this._palette = idx;
      try { localStorage.setItem('dotminationvr-palette', String(idx)); } catch (e) { /* private mode */ }
      var pal = pals[idx];
      DB.COLORS[1] = pal[1];
      DB.COLORS[2] = pal[0];
      var b = this.boards && this.boards.shared;
      if (b) b.view.setColors({ 1: pal[1], 2: pal[0] });
      this._recolorBodies();
      this._updateNameLabels && this._updateNameLabels();
      if (this._stationCards) for (var k in this._stationCards) this._stationCards[k].last = '';
      if (this.matchStats) this._updateCupStatsHUD(true); // repaint now, not at the next second
      if (this._uiCards) this._uiCards.forEach(function (c) { c.dirty = true; });
      if (b && b.label) b.label.last = '';
      this._updateBoardLabels(performance.now(), true);
      try { global.dispatchEvent(new CustomEvent('dot-palette-changed', { detail: { you: pal[1], opp: pal[0] } })); } catch (e2) {}
      return idx;
    },

    /** Seat bodies take their seat's dot colour (your body = your seat). */
    _recolorBodies: function () {
      var mySide = this._mySeatSide() || 'blue';
      this._tintBody(document.getElementById('player-body'), this._sideColorCss(mySide));
      this._tintBody(document.getElementById('bot-body'), this._sideColorCss('red'));
      this._tintBody(document.getElementById('spec-blue-body'), this._sideColorCss('blue'));
    },

    /** Full body tint: base colour AND the Fresnel emissive (the glow kept the old hue before). */
    _tintBody: function (el, hex) {
      if (!el) return;
      var mb = el.components && el.components['mixamo-body'];
      if (mb && mb.data) mb.data.color = hex;
      var col = new THREE.Color(hex);
      var root = (mb && mb.model) || el.object3D;
      if (!root) return;
      root.traverse(function (o) {
        if (!o.isMesh || !o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
          if (m.color) m.color.copy(col);
          if (m.emissive) m.emissive.copy(col);
        });
      });
    },

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
      lab.group.position.set(p.x, p.y + board.view.height / 2 + 0.1, p.z);
      lab.group.rotation.y = p.yaw;
      this._sceneRoot.add(lab.group);
      return lab;
    },

    _drawLabel: function (lab, lines, color) {
      var key = JSON.stringify(lines) + color;
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
      ctx.font = "700 82px 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif";
      ctx.fillText(lines[0] || '', W / 2, lines[1] ? 58 : H / 2);
      if (lines[1]) {
        ctx.shadowBlur = 0;
        ctx.font = "700 50px 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif";
        if (typeof lines[1] === 'string') {
          ctx.fillStyle = color;
          ctx.fillText(lines[1], W / 2, 132);
        } else {
          // [{t, c}] segments: each player's points stay in that player's colour
          var segs = lines[1], total = 0, k;
          for (k = 0; k < segs.length; k++) total += ctx.measureText(segs[k].t).width;
          var x = W / 2 - total / 2;
          ctx.textAlign = 'left';
          for (k = 0; k < segs.length; k++) {
            ctx.fillStyle = segs[k].c || color;
            ctx.fillText(segs[k].t, x, 132);
            x += ctx.measureText(segs[k].t).width;
          }
          ctx.textAlign = 'center';
        }
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
      ctx.fillStyle = this._sideColorCss(side);
      ctx.font = "700 46px 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif";
      ctx.fillText(String(nick || ''), left, y);
      y += 52;
      ctx.fillStyle = '#ffffff';
      function block(label, main, rate) {
        ctx.font = "400 36px 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif";
        ctx.fillText(label, left, y);
        y += 52;
        ctx.font = "700 72px 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif";
        ctx.fillText(String(main), left, y);
        if (rate != null && rate !== '') {
          ctx.font = "400 38px 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif";
          ctx.fillText(String(rate) + '/min', rateX, y);
        }
        y += 78;
      }
      block('Moves', f.blocks, null); // no per-minute rate: StacksVR speed stat, meaningless turn-based
      block('Chains', stats.chains | 0, null);
      block('Time', f.time, null);
      card.tex.needsUpdate = true;
    },

    _sideColorCss: function (side) {
      return DB.COLORS[R.code(side)] || '#9fb3c8';
    },

    _turnName: function (side) {
      if (this._dualBotPreview) return this._sideColorName(side).toUpperCase() + ' BOT\'S';
      var me = this._mySeatSide();
      if (me && me === side) return 'YOUR';
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

    _modeTitle: function () {
      if (this._levelMatch) return 'LEVEL ' + this._levelMatch;
      if (global.isMultiplayer) return 'MULTIPLAYER';
      return 'RANDOM';
    },

    _updateBoardLabels: function (now, force) {
      var b = this.boards.shared;
      if (!b || !b.label) return;
      if (force) b.label.last = '';
      var lines;
      var color;
      var NEUTRAL = '#8a9bb0';
      var scoreSegs = [
        { t: String(this.modes.scores.blue | 0), c: this._sideColorCss('blue') },
        { t: '  ·  ', c: NEUTRAL },
        { t: String(this.modes.scores.red | 0), c: this._sideColorCss('red') }
      ];
      if (this._tutorial) {
        lines = ['HOW TO PLAY', this._tutorial.step <= 4 ? 'Step ' + this._tutorial.step + ' of 4' : 'Tutorial complete'];
        color = this._sideColorCss('blue');
      } else if (!this.matchActive && !this._victory) {
        var info = this.levelInfo();
        lines = ['DOTMINATION', info.level > 0
          ? 'Level ' + info.level + (info.best ? '  ·  best ' + info.best : '') + '  ·  START to play'
          : 'Random map  ·  START to play'];
        color = '#9fb3c8';
      } else if (!this.matchActive) {
        lines = ['DOTMINATION!', this._resultSegs ? this._resultSegs() : (this._resultLine || scoreSegs)];
        var wn = this.modes && this.modes.winner;
        color = (wn === 'red' || wn === 'blue') ? this._sideColorCss(wn) : '#ffd56a'; // draw: neutral gold
      } else if (this.matchState === 'COUNTDOWN') {
        lines = [this._modeTitle(), 'get ready'];
        color = '#ffd56a';
      } else {
        var t = this._shownTurn(b);
        var clock = this._dualBotPreview ? '' : '   ' + fmtTime(Date.now() - (this.modes.matchStart || Date.now()));
        var sub = scoreSegs.concat(clock ? [{ t: clock, c: NEUTRAL }] : []);
        if (this._turnClockActive() && this._isLocalHumanSide(t)) {
          var left = Math.max(0, TURN_MS - (now - b.turnStartedAt));
          if (left < 10000) sub.push({ t: '   ⏱ ' + Math.ceil(left / 1000) + 's', c: '#ffd56a' });
        }
        lines = [this._turnName(t) + ' TURN', sub];
        color = this._sideColorCss(t);
      }
      this._drawLabel(b.label, lines, color);
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

    /** Should THIS client execute moves for `side` (its human seat, or a bot it hosts)? */
    _drivesSide: function (side) {
      if (this._dualBotPreview) return true;
      if (this._isBotSide(side)) return this._hostRunsBots() && !global.isMobileSpectator;
      return this._isLocalAuthoritySide(side);
    },

    _isLocalHumanSide: function (side) {
      if (!side || this._dualBotPreview) return false;
      if (this._isBotSide(side)) return false;
      return this._isLocalAuthoritySide(side) && this._canControl();
    },

    /** Turn clock only between two humans (keeps PvP from stalling; original has none). */
    _turnClockActive: function () {
      return !!(global.isMultiplayer && this._seats && !this._seats.blue.bot && !this._seats.red.bot);
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
          // Cards (tutorial / welcome / end card) sit in front of the board: they win the pick
          if (self._uiPickHand && self._uiPress(self._uiPickHand(hand), hand)) return;
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
        if (self._uiPickMouse && self._uiPress(self._uiPickMouse(e), null)) return;
        var pick = self._pickFromMouse(e);
        if (pick && pick.index >= 0) self._tryHumanTap(pick.board, pick.index, null);
      });
      window.addEventListener('mousemove', function (e) {
        if (self._isPresenting() || global.isMobileSpectator) return;
        self._mouseEvt = e;
      });
      window.addEventListener('keydown', function (e) {
        if (e.repeat) return;
        if (e.key === 'c' || e.key === 'C') self.cycleColors(); // original "Change Colors"
        if (e.key === '[' || e.key === ']') self.setLevel(self.level + (e.key === ']' ? 1 : -1));
      });
    },

    _boardsForInput: function () {
      var out = [];
      var keys = Object.keys(this.boards);
      for (var i = 0; i < keys.length; i++) out.push(this.boards[keys[i]]);
      return out;
    },

    /**
     * Tip of the index finger of your own Mixamo hand (the poke should come from the finger you
     * point with, not the controller/laser origin near the thumb). Falls back to the laser origin.
     */
    _fingerTip: function (hand) {
      var body = document.getElementById('player-body');
      var mb = body && body.components && body.components['mixamo-body'];
      var left = hand && hand.id === 'leftHand';
      var b3 = mb && mb.bones && mb.bones[left ? 'leftHandIndex3' : 'rightHandIndex3'];
      var b2 = mb && mb.bones && mb.bones[left ? 'leftHandIndex2' : 'rightHandIndex2'];
      if (b3 && b2 && body.object3D && body.object3D.visible) {
        var p3 = new THREE.Vector3(), p2 = new THREE.Vector3();
        b3.getWorldPosition(p3);
        b2.getWorldPosition(p2);
        var seg = p3.clone().sub(p2);
        var len = seg.length();
        if (len > 0.004 && len < 0.08) return p3.addScaledVector(seg.normalize(), Math.min(0.026, len * 0.9));
      }
      var r = this._handRay(hand);
      return r ? r.origin.addScaledVector(r.dir, 0.035) : null;
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
            var tipPos = self._fingerTip(hand);
            if (tipPos) {
              var pk = mine.view.pokePoint(tipPos);
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
            if (now >= 0) self._pulseHaptic(hand, 0.3, 22); // same tick as menu-button hovers
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
      this._updateLasers(presenting, mine, hit);
    },

    /**
     * VR laser pointers (both hands) toward the board while you play. The menu draws its own
     * line while open, so ours hides then. Brightens when it points at a dot you can take.
     */
    _updateLasers: function (presenting, mine, hit) {
      if (!this._sceneRoot) return;
      if (!this._lasers) {
        this._lasers = {};
        var beamGeo = new THREE.CylinderGeometry(0.0011, 0.0011, 1, 6, 1, true);
        beamGeo.translate(0, 0.5, 0); // base at the controller, grows along +Y
        var dotGeo = new THREE.SphereGeometry(0.006, 12, 8);
        var self = this;
        ['leftHand', 'rightHand'].forEach(function (id) {
          var beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false
          }));
          var dot = new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false
          }));
          beam.renderOrder = 12;
          dot.renderOrder = 13;
          beam.visible = dot.visible = false;
          self._sceneRoot.add(beam);
          self._sceneRoot.add(dot);
          self._lasers[id] = { beam: beam, dot: dot };
        });
        this._laserUp = new THREE.Vector3(0, 1, 0);
      }
      var side = this._mySeatSide();
      var uiOn = !!(this._uiAnyInteractive && this._uiAnyInteractive());
      var active = presenting && ((this.matchActive && !!side && !this._dualBotPreview && !global.replayActive) || uiOn);
      var board = this.boards.shared;
      var col = this._sideColorCss(side || 'blue');
      for (var id in this._lasers) {
        var L = this._lasers[id];
        var hand = document.getElementById(id);
        var rc = hand && hand.components && hand.components.raycaster;
        var menuLaser = !!(rc && rc.data && rc.data.enabled && rc.data.showLine);
        var r = active && !menuLaser ? this._handRay(hand) : null;
        if (!r || !board) { L.beam.visible = L.dot.visible = false; continue; }
        // Length: to the board plane if the ray crosses it within the board, else 1.2 m
        var len = 1.2, onBoard = false;
        var bz = board.view.root.position.z;
        if (Math.abs(r.dir.z) > 1e-4) {
          var t = (bz - r.origin.z) / r.dir.z;
          if (t > 0 && t < 4) {
            var hx = r.origin.x + r.dir.x * t - board.view.root.position.x;
            var hy = r.origin.y + r.dir.y * t - board.view.root.position.y;
            if (Math.abs(hx) <= board.view.width / 2 && Math.abs(hy) <= board.view.height / 2) {
              len = t;
              onBoard = true;
            }
          }
        }
        var p = hit && hit[id];
        var canTake = !!(mine && p && p.board === mine && mine.state.canTap(side, p.index));
        // A card (tutorial / end / welcome) in front of the board ends the beam on it
        var up = this._uiHits && this._uiHits[id];
        if (up && up.dist <= len + 0.001) { len = up.dist; onBoard = true; canTake = !!up.btn; }
        L.beam.material.color.set(col);
        L.beam.material.opacity = canTake ? 0.85 : (mine ? 0.45 : 0.2);
        L.beam.position.copy(r.origin);
        L.beam.quaternion.setFromUnitVectors(this._laserUp, r.dir);
        L.beam.scale.set(1, len, 1);
        L.beam.visible = true;
        L.dot.visible = onBoard;
        if (onBoard) {
          L.dot.material.color.set(canTake ? '#ffffff' : col);
          L.dot.position.copy(r.origin).addScaledVector(r.dir, len);
          L.dot.scale.setScalar(canTake ? 1.3 : 0.8);
        }
      }
    },

    // ── Moves ─────────────────────────────────────────────────────────────

    /** The board, if it is the local human's turn on it (else null). */
    _myActionBoard: function () {
      if (!this.matchActive || this.matchState !== 'PLAYING' || this._endingMatch || this._endPending) return null;
      if (this._dualBotPreview || global.replayActive) return null;
      var side = this._localSide();
      if (!this._isLocalHumanSide(side)) return null;
      var b = this.boards.shared;
      if (!b || b.turn !== side) return null;
      return b;
    },

    _tryHumanTap: function (board, idx, handEl) {
      if (this._tutorial) return this._tutorialTap(board, idx, handEl);
      var mine = this._myActionBoard();
      if (!mine || mine !== board) {
        if (board && this.matchActive && !this._dualBotPreview) this._pulseHaptic(handEl, 0.15, 25);
        return false;
      }
      var side = this._localSide();
      // Original: only empty dots or your own, and not while a chain is animating
      if (board.view.busy() || !board.state.canTap(side, idx)) {
        this._pulseHaptic(handEl, 0.2, 30);
        this._sfx('rotate', { volume: 0.15, rate: 0.6 });
        return false;
      }
      this._pulseHaptic(handEl, 0.55, 35);
      return !!this._performMove(board, side, idx, { human: true });
    },

    // ── Moves (original incrementDotStage → animateNextDot → checkDotmination → nextPlayer) ──

    _performMove: function (board, actor, idx, opts) {
      opts = opts || {};
      var turnNo = board.turnNo;
      var res = board.state.apply(actor, idx);
      if (!res) return null;
      board.turnNo++;
      board.rev++;
      board.turn = otherSide(actor);
      board.turnStartedAt = performance.now();
      board._pitch = 0;
      board.view.play(res, board.state);
      this._afterMove(board, actor, idx, res, { local: true, turnNo: turnNo });
      return res;
    },

    _afterMove: function (board, actor, idx, res, info) {
      var now = performance.now();
      var bursts = res ? (res.bursts | 0) : (info.ex | 0);
      if (this.matchStats) {
        this.matchStats.onPlace(actor, { layersCleared: bursts, score: res ? res.captured | 0 : 0, combo: bursts }, now);
      }
      if (!this._dualBotPreview && bursts >= 2) { // a chain = 2+ explosions from one move
        this._showChainPopup(board, 'Chain ×' + bursts, this._sideColorCss(actor));
      }
      this._refreshScores();
      if (window.matchRecorder && !this._dualBotPreview) {
        window.matchRecorder.recordEvent('move', {
          k: board.key, actor: actor, i: idx, snap: board.serialize(),
          scores: { blue: this.modes.scores.blue, red: this.modes.scores.red }
        });
      }
      if (info.local && global.isMultiplayer && !this._dualBotPreview && global.sendCupEvent) {
        global.sendCupEvent({
          kind: 'move', k: board.key, actor: actor, i: idx, turnNo: info.turnNo,
          ex: bursts, snap: board.serialize(),
          scores: { blue: this.modes.scores.blue, red: this.modes.scores.red }
        });
      }
      var isHost = !!(global.StacksLobby && global.StacksLobby.isHost);
      if (info.local || isHost) this._checkBoardEnd(board);
      this._updateHUD();
    },

    _onViewStep: function (board, kind, step) {
      this._refreshScores();
      this._updateBoardLabels(performance.now());
      // Original incrementSound: sonar ping, pitch 1.0 + 0.05 per increment of the move, vol 0.25
      if (global.StacksAudio && global.StacksAudio.ping) {
        board._pitch = (board._pitch || 0) + 1;
        global.StacksAudio.ping(Math.min(3, 1.0 + 0.05 * (board._pitch - 1)), this._dualBotPreview ? 0.1 : 0.25);
      }
      if (kind === 'burst' && this._mySeatSide()) {
        this._pulseHaptic(document.getElementById('rightHand'), 0.35, 25); // original navigator.vibrate
      }
    },

    /** Original checkDotmination: after ≥2 moves, a player with no dots left has lost. */
    _checkBoardEnd: function (board) {
      if (this._tutorial) return;
      if (this._endingMatch || this._endPending || !this.matchActive || this.matchState !== 'PLAYING') return;
      var winner = null;
      var reason = null;
      var nb = board.state.count('blue');
      var nr = board.state.count('red');
      if (board.turnNo >= 2 && nb === 0 && nr > 0) { winner = 'red'; reason = 'dominated'; }
      else if (board.turnNo >= 2 && nr === 0 && nb > 0) { winner = 'blue'; reason = 'dominated'; }
      else if (board.turnNo >= MOVE_CAP) {
        var sb = board.state.score('blue'), sr = board.state.score('red');
        winner = sb > sr ? 'blue' : (sr > sb ? 'red' : 'draw');
        reason = 'moves';
      }
      if (!winner) return;
      this.modes.winner = winner;
      this.modes.reason = reason;
      this._endPending = true;
      this._matchElapsedMs = Date.now() - (this.modes.matchStart || Date.now());
      var self = this;
      // Let the winning chain finish animating first (the original also waits for it)
      var wait = board.view.remainingMs() + 500;
      setTimeout(function () {
        self._endPending = false;
        self._endFromMode({ ended: true, winner: winner, reason: reason });
      }, wait);
    },

    _refreshScores: function () {
      var b = this.boards.shared;
      if (!this.modes || !b) return;
      // Original score = sum of dot stages — of the board as drawn, so it counts up with the
      // chain (state jumps to the final result as soon as a move is applied)
      var shown = b.view && b.view.busy() && b.view.displayScore;
      this.modes.scores.blue = shown ? b.view.displayScore(1) : b.state.score('blue');
      this.modes.scores.red = shown ? b.view.displayScore(2) : b.state.score('red');
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
      ctx.font = "700 112px 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif";
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

    // ── Bot + turn clock (runs only on the client that drives that side) ──

    _tickDrivers: function (now) {
      if (this._tutorial) return; // tutorial: no bot, no turn clock
      if (!this.matchActive || this.matchState !== 'PLAYING' || this._endingMatch || this._endPending) return;
      if (global.replayActive) return;
      var b = this.boards.shared;
      if (b.view.busy()) { b._schedTurn = -1; this._easeBotHand(now); return; }
      var actor = b.turn;
      if (!this._drivesSide(actor)) { this._easeBotHand(now); return; }
      if (!this._isBotSide(actor)) {
        if (this._turnClockActive() && this._isLocalHumanSide(actor) && now - b.turnStartedAt > TURN_MS) {
          var auto = global.DotBot.chooseMove(b.state, actor, otherSide(actor), 'random');
          if (auto >= 0) this._performMove(b, actor, auto, { auto: true });
        }
        this._easeBotHand(now);
        return;
      }
      if (b._schedTurn !== b.turnNo) {
        b._schedTurn = b.turnNo;
        b._dueAt = now + BOT_DELAY_MS;
        b._botPick = null;
      }
      // Pick a little early so the bot avatar can reach toward the dot
      if (b._botPick == null && now >= b._dueAt - 650) {
        b._botPick = global.DotBot.chooseMove(b.state, actor, otherSide(actor), this._botDifficulty(),
          { recent: this._recent[actor] });
        b.view.setBotChoice(b._botPick); // original bot-choice highlight
      }
      if (b._botPick != null && (actor === 'red' || this._dualBotPreview)) this._botReach(b, b._botPick, now, actor);
      if (now >= b._dueAt && b._botPick != null) {
        var pick = b._botPick;
        b._botPick = null;
        b._dueAt = Infinity;
        b.view.setBotChoice(-1);
        if (pick >= 0 && b.state.canTap(actor, pick)) this._performMove(b, actor, pick, { bot: true });
        else if (pick < 0) this._checkBoardEnd(b);
      }
      this._easeBotHand(now);
    },

    _easeBotHand: function (now) {
      ['botReactionTarget', 'botReactionTargetBlue'].forEach(function (key) {
        var rt = global[key];
        if (rt && rt._releaseAt && now > rt._releaseAt) {
          rt.progress = Math.max(0, rt.progress - 0.06);
          if (rt.progress <= 0) global[key] = null;
        }
      });
    },

    /** Drive mixamo-body bot idle IK hand toward the chosen dot (window.botReactionTarget). */

    _botReach: function (board, idx, now, actor) {
      if (idx == null || idx < 0) return;
      var blueBot = actor === 'blue';   // only in the bot-vs-bot preview
      var body = document.getElementById(blueBot ? 'spec-blue-body' : 'bot-body');
      if (!body || !body.object3D || !body.object3D.visible) return;
      var w = board.view.cellWorld(idx, new THREE.Vector3());
      var span = 650;
      var p = 1 - Math.max(0, Math.min(1, (board._dueAt - now) / span));
      // Fingertip stops just in front of the glass on the bot's own side
      global[blueBot ? 'botReactionTargetBlue' : 'botReactionTarget'] = {
        handTarget: { x: w.x, y: w.y, z: w.z + (blueBot ? 0.03 : -0.03) },
        progress: p,
        _releaseAt: board._dueAt + 120
      };
    },

    // ── Networking (StacksVR cup-event channel, board payloads) ───────────

    _buildSnapshot: function () {
      var b = this.boards.shared;
      var snap = b.serialize();
      return {
        boards: { shared: snap },
        level: this._levelMatch || 0,
        // StacksVR shape so replay-state / older consumers still read it
        blue: snap,
        red: snap,
        scores: { blue: this.modes.scores.blue, red: this.modes.scores.red },
        matchState: this.matchState
      };
    },

    _broadcastState: function (reason) {
      if (!global.sendCupEvent) return;
      global.sendCupEvent({ kind: 'state', reason: reason || 'sync', snap: this._buildSnapshot() });
    },

    /** Newer rev wins; view-only observers (and forced syncs) take any change. */
    _applyBoardSnap: function (s, opts) {
      opts = opts || {};
      var b = this.boards.shared;
      if (!s || !b) return;
      var viewOnly = opts.forceAll || this._isViewOnlyObserver();
      var rev = s.rev | 0;
      if (viewOnly ? (rev !== b.rev || opts.forceAll) : rev > b.rev) b.applySnapshot(s);
      this._refreshScores();
    },

    /** StacksVR name kept for onRemoteReplayMsg (copied). */
    _applyNetworkCups: function (cups, opts) {
      if (!cups) return;
      this._applyBoardSnap(cups.blue || cups.red, opts);
    },

    onRemoteCupEvent: function (evt) {
      if (!evt || !evt.kind) return;
      var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
      if (evt.from && myId && evt.from === myId) return;
      var b = this.boards.shared;
      if (!b) return;
      if (evt.kind === 'state') {
        var snap = evt.snap || {};
        if (snap.level != null) this._levelMatch = snap.level || 0;
        this._applyBoardSnap(snap.boards && snap.boards.shared, {
          forceAll: this._isViewOnlyObserver() || evt.reason === 'match-start' || evt.reason === 'match-go'
        });
        this._updateHUD();
        return;
      }
      if (evt.kind !== 'move') return;
      if (this._drivesSide(evt.actor) && !this._isViewOnlyObserver()) return; // our own move
      if (evt.snap && (evt.snap.rev | 0) <= b.rev && !this._isViewOnlyObserver()) return; // stale
      var res = null;
      // Replay the move locally (rules are deterministic) for the original step animation
      if (evt.snap && (evt.snap.rev | 0) === b.rev + 1 && b.turn === evt.actor && b.state.canTap(evt.actor, evt.i)) {
        res = b.state.apply(evt.actor, evt.i);
      }
      if (evt.snap) b.state.load(evt.snap);
      b.turn = evt.snap && evt.snap.turn ? evt.snap.turn : otherSide(evt.actor);
      b.turnNo = evt.snap && evt.snap.turnNo != null ? evt.snap.turnNo | 0 : b.turnNo + 1;
      b.rev = evt.snap && evt.snap.rev != null ? evt.snap.rev | 0 : b.rev + 1;
      b.turnStartedAt = performance.now();
      b._pitch = 0;
      if (res) b.view.play(res, b.state);
      else b.view.syncFrom(b.state);
      this._afterMove(b, evt.actor, evt.i, res, { local: false, ex: evt.ex });
    },

    onRemoteSnapshot: function (data) {
      if (!data || !data.snapshot) return;
      var snap = data.snapshot;
      if (snap.level != null) this._levelMatch = snap.level || 0;
      if (snap.boards) this._applyBoardSnap(snap.boards.shared, { forceAll: this._isViewOnlyObserver() && !this.matchActive });
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

    // ── Match lifecycle (StacksVR flow; board setup = original populate functions) ──

    _prepBoardsForMatch: function (seed) {
      var size = (global.getBoardSize && global.getBoardSize()) ||
        (global.lobbyState && global.lobbyState.boardSize) || this.boardSize || 4;
      this.boardSize = size === 6 ? 6 : 4;
      this.bagSeed = seed >>> 0;
      if (global.lobbyState) global.lobbyState.bagSeed = this.bagSeed;
      var mp = global.lobbyState && global.lobbyState.matchPlayers;
      var pvp = !!(global.isMultiplayer && mp && mp.blue && mp.red && mp.blue !== '__BOT__' && mp.red !== '__BOT__');
      var solo = !global.isMultiplayer && !this._dualBotPreview;
      this._levelMatch = solo && this.level > 0 ? this.level : 0;
      this._recent = { blue: [], red: [] };
      this._resultLine = '';
      this._resultSegs = null;
      var b = this.boards.shared;
      // Original player--1 = red (bot / host side colour teal), player--2 = blue (you, pink)
      if (this._levelMatch) {
        b.state.populateLevel(this._levelMatch, 'red', 'blue');                 // fieldPopulateByLevel
      } else if (pvp) {
        var st = typeof global.getStartType === 'function' ? global.getStartType() : 'blank';
        if (st === 'half') b.state.populateHalf('red', 'blue');                  // "Half-Filled Start"
        else b.state.clear();                                                    // "Blank Start"
      } else {
        b.state.populateRandom(this.bagSeed, 'red', 'blue');                     // fieldPopulateRandom
      }
      b.turnNo = 0;
      b.rev = 0;
      b._schedTurn = -1;
      b._pitch = 0;
      b.view.setBotChoice(-1);
      b.view.syncFrom(b.state);
      // Who opens: vs a bot the human (original: "User starts"); PvP alternates every match
      if (pvp) {
        var n = (global.lobbyState && global.lobbyState.matchNo) | 0;
        b.turn = n % 2 === 0 ? 'red' : 'blue';
      } else if (mp && mp.blue === '__BOT__' && mp.red && mp.red !== '__BOT__') {
        b.turn = 'red';
      } else {
        b.turn = 'blue';
      }
      this.modes.setMode('duel');
      this._refreshScores();
    },

    onMatchStarted: function (mp, startTime, isBotMatch, bagSeed) {
      if (this._dualIdleTimer) { clearTimeout(this._dualIdleTimer); this._dualIdleTimer = null; }
      if (this._tutorial && this.endTutorial) this.endTutorial(true);
      if (this._welcomeCard && this._uiHide) this._uiHide(this._welcomeCard);
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
      // Preview bots never carry over into a real match
      ['bot-body', 'spec-blue-body'].forEach(function (id) {
        var e = document.getElementById(id);
        if (e && e.dataset && e.dataset.previewBot === '1') this._clearRemoteAvatarEl(e);
      }, this);
      global.botReactionTargetBlue = null;
      this._showMatchBodies({ showBot: reallyBot && !spectating });
      if (global.isMultiplayer && global.StacksLobby && global.StacksLobby.isHost) {
        this._broadcastState('match-start');
      }
      this._updateHUD();
      this._updateBoardLabels(performance.now(), true);
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

      this.modes.start(Date.now()); // original resetTimer/startTimer
      this._refreshScores();
      if (this.matchStats) this.matchStats.start(performance.now());
      var b = this.boards.shared;
      b.turnStartedAt = performance.now();
      b._schedTurn = -1;
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
        window.matchRecorder.recordEvent('init', { level: this._levelMatch || 0, boards: { shared: b.serialize() } });
      }
      this._matchGoAt = performance.now();
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
      ctx.font = "700 150px 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif";
      ctx.shadowColor = this._sideColorCss ? this._sideColorCss('blue') : '#E11168';
      ctx.shadowBlur = 24;
      ctx.fillText(String(text || ''), 256, 128);
      var tex = new THREE.CanvasTexture(canvas);
      var mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.1, 0.55),
        new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide
        })
      );
      mesh.position.set(0, 2.42, 0);
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
        delete el.dataset.previewBot;
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
      var keepPreview = function (id) {
        var e = document.getElementById(id);
        return !!(this._dualBotPreview && e && e.dataset && e.dataset.previewBot === '1');
      }.bind(this);
      if ((!playing || !mp.blue || !live[mp.blue]) && !keepPreview('spec-blue-body')) {
        this._clearRemoteAvatarEl(document.getElementById('spec-blue-body'));
      }
      if (!playing || !mp.red || mp.red === '__BOT__' || !live[mp.red]) {
        // Keep bot-body for vs-bot matches (and the bot-vs-bot filler); otherwise clear stale human pose
        if (!(playing && mp.red === '__BOT__') && !keepPreview('bot-body')) {
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
      var sub = null;
      var elapsed = this._matchElapsedMs || (Date.now() - (this.modes.matchStart || Date.now()));
      var endInfo = { level: this._levelMatch | 0, time: fmtTime(elapsed) };
      // Original stars: won · under 2:00 · under 1:00 (Levels and Random alike)
      endInfo.stars = 1 + (elapsed < 120000 ? 1 : 0) + (elapsed < 60000 ? 1 : 0);
      if (festive && this._levelMatch && !global.isMultiplayer && winner === 'blue') {
        // Original Levels mode: time + stars, best time per level, next level unlocked
        var lw = this._recordLevelWin(this._levelMatch, elapsed);
        endInfo.stars = lw.stars; endInfo.time = lw.time; endInfo.isBest = lw.isBest; endInfo.best = lw.best;
        sub = 'Level ' + this._levelMatch + '  ' + '★★★'.slice(0, lw.stars) + '☆☆☆'.slice(lw.stars) +
          '  ' + lw.time + (lw.isBest ? '  best!' : '  (best ' + lw.best + ')');
      } else if (festive && this._levelMatch && winner === 'red') {
        sub = 'Level ' + this._levelMatch + '  ☆☆☆  Retry';
      } else if (festive) {
        sub = fmtTime(elapsed) + '  ·  ' + (this.modes.scores.blue | 0) + ' – ' + (this.modes.scores.red | 0);
        var selfR = this, rb = this.modes.scores.blue | 0, rr = this.modes.scores.red | 0, rt = fmtTime(elapsed);
        this._resultSegs = function () {
          return [{ t: rt + '   ', c: '#8a9bb0' }, { t: String(rb), c: selfR._sideColorCss('blue') },
            { t: ' – ', c: '#8a9bb0' }, { t: String(rr), c: selfR._sideColorCss('red') }];
        };
      }
      this._resultLine = sub || '';
      if (festive) {
        setTimeout(function () {
          selfEnd._playVictory({
            winner: winner,
            sub: sub,
            level: endInfo.level,
            stars: endInfo.stars,
            time: endInfo.time,
            isBest: endInfo.isBest,
            best: endInfo.best,
            reason: (opts && opts.reason) || (selfEnd.modes && selfEnd.modes.reason),
            wasBotMatch: opts && opts.wasBotMatch,
            blueName: opts && opts.blueName,
            redName: opts && opts.redName
          });
          selfEnd._placeVictory();
        }, 0);
        // Solo: the end card stays (Retry / Next) like the app; lobbies resume the filler after a hold
        if (global.isMultiplayer || global.isMobileSpectator) this._scheduleDualIdle(VICTORY_HOLD_MS);
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
          blue: msg.blueName || this._sideColorName('blue'),
          red: msg.redName || this._sideColorName('red')
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
            blueName: (window._replayNames && window._replayNames.blue) || this._sideColorName('blue'),
            redName: (window._replayNames && window._replayNames.red) || this._sideColorName('red')
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
      if (winner === 'red' || winner === 'blue') return this._sideColorName(winner).toUpperCase() + ' WINS!';
      return String(winner).toUpperCase();
    },

    /** Festive win banner + confetti burst (keeps board visible for a beat). */
    _playVictory: function (info) {
      info = info || {};
      this._clearVictory();
      if (!this._sceneRoot || !THREE) return;

      var winner = info.winner || (this.modes && this.modes.winner) || 'draw';
      var title = this._victoryTitle(winner, info);

      // Winner's dot colour (Pink / Teal or current palette); gold for a draw
      var accent = (winner === 'red' || winner === 'blue')
        ? parseInt(String(this._sideColorCss(winner)).replace('#', ''), 16) || 0xffd56a
        : 0xffd56a;
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
      // Draw after the dark glass (2) and the dot stacks (3-4); otherwise the glass,
      // drawn on top at 80% opacity, made the card nearly invisible
      plate.renderOrder = 10;
      root.add(plate);
      this._victory.plate = plate;

      var rim = new THREE.Mesh(
        new THREE.PlaneGeometry(1.68, 0.62),
        new THREE.MeshBasicMaterial({
          color: accent, transparent: true, opacity: 0.55, depthWrite: false,
          side: THREE.DoubleSide, toneMapped: false
        })
      );
      rim.position.z = -0.03;
      rim.renderOrder = 9;
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
      ctx.font = "700 120px 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif";
      ctx.shadowColor = '#' + ('000000' + accent.toString(16)).slice(-6);
      ctx.shadowBlur = 28;
      ctx.fillText(title, 512, 110);
      ctx.shadowBlur = 0;
      ctx.font = "400 42px 'Roboto Condensed', 'Arial Narrow', Arial, sans-serif";
      ctx.fillStyle = '#c8d6e6';
      var sub = info.sub || (info.reason === 'dominated' ? 'Dotmination!' :
        (info.reason === 'moves' ? 'Move limit — higher score wins' : 'Match over'));
      ctx.fillText(sub, 512, 190);
      var tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      var titleMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.45, 0.36),
        new THREE.MeshBasicMaterial({
          map: tex, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide
        })
      );
      titleMesh.renderOrder = 11;
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

      // Banner pulses, then fades after ~3 s so the final board stays readable
      // (the board label keeps DOTMINATION! + result)
      var fade = Math.max(0, Math.min(1, 1 - (t - 3) / 0.8));
      if (v.titleMesh) {
        v.titleMesh.scale.setScalar(1 + 0.06 * Math.sin(t * 6));
        v.titleMesh.material.opacity = fade;
        v.titleMesh.visible = fade > 0;
      }
      if (v.rim && v.rim.material) {
        v.rim.material.opacity = (0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 5))) * fade;
        v.rim.visible = fade > 0;
      }
      if (v.plate && v.plate.material) {
        v.plate.material.opacity = 0.9 * fade;
        v.plate.visible = fade > 0;
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

    /** Victory banner above the board, facing you. */
    /**
     * DotminationVR: the board label already carries DOTMINATION! + result, so the banner is a
     * compact card floating just in front of the board (on the viewer's side), not a 1.6 m sign
     * above it — at 0.6 m from a seated player that filled the whole view.
     */
    _placeVictory: function () {
      var v = this._victory;
      if (!v || !v.root) return;
      var b = this.boards.shared;
      if (!b) return;
      var p = b.view.root.position;
      var look = new THREE.Vector3();
      var cam = this.el.sceneEl && this.el.sceneEl.camera;
      if (cam) cam.getWorldPosition(look);
      else look.set(p.x, p.y, p.z + 1);
      var side = look.z >= p.z ? 1 : -1;
      v.root.scale.setScalar(0.38);
      v.root.position.set(p.x, p.y + 0.1, p.z + side * 0.12);
      look.y = v.root.position.y;
      v.root.lookAt(look);
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
      this._endPending = false;
      this._prepBoardsForMatch(DB.newSeed());
      this.modes.start(Date.now());
      this._refreshScores();
      if (this.matchStats) this.matchStats.start(performance.now());
      this._clearRemoteAvatarEl(document.getElementById('bot-body'));
      this._clearRemoteAvatarEl(document.getElementById('spec-blue-body'));
      this._hidePreviewBotBodies();
      this._showPreviewBotBodies();
      this._musicIdle();
      this._updateHUD();
    },

    /**
     * DotminationVR: the bots get Mixamo bodies that reach for their dots. The pink seat's
     * bot only appears for spectators — in a headset you stand on that seat yourself.
     */
    _showPreviewBotBodies: function () {
      var show = function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.dataset.posed = '1';   // mobile-spectator only keeps posed bodies visible
        el.dataset.previewBot = '1'; // mixamo-body: run the idle bot pose during offlinePreview
        var mb = el.components && el.components['mixamo-body'];
        if (mb) mb.remoteHandData = null;
        el.setAttribute('visible', true);
        if (el.object3D) el.object3D.visible = true;
      };
      show('bot-body');
      show('spec-blue-body');
      this._lastPreviewBodySync = 0;
      this._syncPreviewBotBodies(performance.now());
    },

    /**
     * A preview bot only appears at a seat nobody is standing at: you (headset), or another
     * lobby player's avatar. After a PvP match both humans usually stay at their seats, and a
     * bot body there would overlap them.
     */
    _syncPreviewBotBodies: function (now) {
      if (!this._dualBotPreview) return;
      if (this._lastPreviewBodySync && now - this._lastPreviewBodySync < 300) return;
      this._lastPreviewBodySync = now;
      var people = [];
      var v = new THREE.Vector3();
      if (!global.isMobileSpectator) {
        var cam = this.el.sceneEl && this.el.sceneEl.camera;
        if (cam) { cam.getWorldPosition(v); people.push({ x: v.x, z: v.z }); }
      }
      for (var i = 0; i < 4; i++) {
        var rb = document.getElementById('remote-body-' + i);
        var mb = rb && rb.components && rb.components['mixamo-body'];
        var hd = mb && mb.remoteHandData && mb.remoteHandData.head;
        if (rb && rb.object3D && rb.object3D.visible && hd && typeof hd.x === 'number') people.push({ x: hd.x, z: hd.z });
      }
      var seatsToBody = { blue: 'spec-blue-body', red: 'bot-body' };
      for (var side in seatsToBody) {
        var el = document.getElementById(seatsToBody[side]);
        if (!el || !el.dataset || el.dataset.previewBot !== '1') continue;
        var seat = this.seatPose(side);
        var taken = false;
        for (var k = 0; k < people.length && seat; k++) {
          var dx = people[k].x - seat.x, dz = people[k].z - seat.z;
          if (dx * dx + dz * dz < 0.7 * 0.7) { taken = true; break; }
        }
        var want = !taken;
        if (el.object3D && el.object3D.visible !== want) {
          el.object3D.visible = want;
          el.setAttribute('visible', want);
          el.dataset.posed = want ? '1' : '';
        }
      }
    },

    _hidePreviewBotBodies: function () {
      // Dual-bot idle is pad-only — bots do NOT use Mixamo seat bodies.
      // Previously bailed on isMultiplayer, so after PvP the red/blue seat kept
      // the last human remoteHandData (client saw themselves ghosted in their slot).
      var self = this;
      ['bot-body', 'spec-blue-body'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.dataset && el.dataset.previewBot === '1') return; // our preview bots stay
        self._clearRemoteAvatarEl(el);
      });
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
        if (!oppName) oppName = this._sideColorName(side === 'red' ? 'blue' : 'red');
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
        level: this._levelMatch || 0,
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
        return this._sideColorName(side);
      }
      // Offline / preview fallbacks
      if (this._dualBotPreview) return this._sideColorName(side) + ' Bot';
      if (side === 'blue') return String(global.playerNickname || 'Player').slice(0, 12);
      if (global.isLobbyBotMatch || (this.bot && this.bot.enabled)) return 'Bot';
      return this._sideColorName('red');
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
        this._setNameLabel('blue', this._sideColorName('blue') + ' Bot', true);
        this._setNameLabel('red', this._sideColorName('red') + ' Bot', true);
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

    _updateHUD: function () {
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

    _updateCupStatsHUD: function () {
      if (!this.matchStats) return;
      var now = performance.now();
      this._drawStationCard('blue', this.matchStats.blue, now);
      this._drawStationCard('red', this.matchStats.red, now);
    },

    /** Nickname floats above each seat, facing the opponent (who is the one reading it). */
    _setNameLabel: function (side, name, visible) {
      var el = document.getElementById(side === 'red' ? 'hud-name-red' : 'hud-name-blue');
      if (!el) return;
      var seat = this.seatPose(side);
      if (seat) el.setAttribute('position', seat.x + ' 2.12 ' + seat.z);
      // Your own name would float over your head inside the headset: only others see it
      if (this._mySeatSide() === side && this._isPresenting()) visible = false;
      el.setAttribute('text', 'value', name || '');
      el.setAttribute('text', 'color', this._sideColorCss(side));
      el.setAttribute('visible', !!visible && !!name);
      if (el.object3D) el.object3D.visible = !!visible && !!name;
    },

    /** Name labels turn (yaw only) toward whoever looks, so they never read back to front. */
    _billboardNameLabels: function () {
      var cam = this.el.sceneEl && this.el.sceneEl.camera;
      if (!cam) return;
      var v = this._bbTmp || (this._bbTmp = new THREE.Vector3());
      cam.getWorldPosition(v);
      ['hud-name-blue', 'hud-name-red'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el || !el.object3D || !el.object3D.visible) return;
        var o = el.object3D;
        o.rotation.set(0, Math.atan2(v.x - o.position.x, v.z - o.position.z), 0);
      });
    },

    /** Kept for game-menu.js (StacksVR BOT BPM hook). Dotmination's bot always takes 1 s. */
    setBotTargetBpm: function (bpm) { return bpm; },
    setBotSpeedScale: function (v) { return v; },

    /** Original: the field and empty dots take the current player's colour. */
    /** Original: the turn passes only after the chain has finished animating. */
    _shownTurn: function (b) {
      if (this._tutorial) return 'blue';
      if (b.view && b.view.busy() && b.turnNo > 0) return b.turn === 'blue' ? 'red' : 'blue';
      return b.turn;
    },

    _updateTurnTint: function () {
      var b = this.boards.shared;
      if (!b) return;
      var c = R.code(this._shownTurn(b));
      b.view.setTurnColor(c);
      // After a match the rim keeps the winner's colour; idle board gets a dim neutral rim
      var w = !this.matchActive && this._victory && this.modes && this.modes.winner;
      var rimCode = this.matchActive ? c : ((w === 'red' || w === 'blue') ? R.code(w) : null);
      b.view.setRim(rimCode, 0);
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
      this.boards.shared.view.tick(now, dt);
      var vb = this.boards.shared.view.busy();
      if (this._viewWasBusy && !vb) this._refreshScores(); // chain finished: settle on the real score
      this._viewWasBusy = vb;
      this._tickPointers();
      this._updateTurnTint();
      this._billboardNameLabels();
      if (this._uiTick) this._uiTick(now);
      // Bodies load / get re-seated asynchronously: keep them in their seat's palette colour
      if (!this._bodyTintAt || now - this._bodyTintAt > 1500) { this._bodyTintAt = now; this._recolorBodies(); }
      if (this.matchActive && !this._endingMatch) {
        if (this.matchState === 'COUNTDOWN') {
          this._tickCountdown(Date.now());
        } else {
          this._tickDrivers(now);
          if (this._dualBotPreview) {
            this._hidePreviewBotBodies();
            this._syncPreviewBotBodies(now);
          }
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

    /** match-replay.js hook: rebuild the board from recorded events (events-only replay). */
    replayApplyEvent: function (e) {
      if (!e || !e.data) return false;
      var d = e.data;
      var b = this.boards.shared;
      if (e.type === 'init') {
        this._levelMatch = d.level || 0;
        if (d.boards && d.boards.shared) this._applyBoardSnap(d.boards.shared, { forceAll: true });
        this._updateHUD();
        return true;
      }
      if (e.type === 'move') {
        var res = b.state.canTap(d.actor, d.i) ? b.state.apply(d.actor, d.i) : null;
        if (d.snap) b.state.load(d.snap);
        b.turn = (d.snap && d.snap.turn) || otherSide(d.actor);
        b.turnNo = d.snap ? d.snap.turnNo | 0 : b.turnNo + 1;
        b.rev = d.snap ? d.snap.rev | 0 : b.rev + 1;
        b._pitch = 0;
        if (res) b.view.play(res, b.state);
        else b.view.syncFrom(b.state);
        if (d.scores && this.modes) {
          this.modes.scores.blue = d.scores.blue;
          this.modes.scores.red = d.scores.red;
        }
        if (this.matchStats) {
          this.matchStats.onPlace(d.actor, { layersCleared: res ? res.bursts : 0, combo: 0, score: 0 }, performance.now());
        }
        if (res && res.bursts >= 2) this._showChainPopup(b, 'Chain ×' + res.bursts, this._sideColorCss(d.actor));
        this._updateHUD();
        return true;
      }
      return false;
    }
  });
})(window);
