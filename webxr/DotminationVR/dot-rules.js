// dot-rules.js — the original flatscreen Dotmination rules, ported 1:1 to pure state.
// Source: Dotmination-v1/dotmination-v3/www (script.js, modules/botLogic.js,
// modules/realTimeResourceMode.js). DOM/jQuery replaced by arrays; behaviour kept.
//
//  Field   9 rows, even rows 4 dots (shifted half a dot), odd rows 5 dots = 40 dots.
//          Neighbours = the 6 touching dots (original Draggable.hitTest on 64px dots).
//  Tap     an empty dot or one of your own (Real-Time: own dots only) → +1 stage,
//          a dot always takes the colour of whoever incremented it.
//  Burst   incrementing a stage-5 dot empties it and queues +1 on every neighbour.
//          Queued increments run one at a time, lowest dot index first; dots that
//          already burst can be refilled by the same chain (original animateNextDot).
//  Score   sum of stages of your dots (original calculatePlayerScore).
//  Win     after ≥2 moves, the opponent has no dots left ("Dotmination!").
(function (global) {
  'use strict';

  var STAGES = 5;
  var ROWS = 9;
  var COLS = 5;
  var OWNER = { none: 0, blue: 1, red: 2, virus: 3 };
  var OWNER_NAME = ['none', 'blue', 'red', 'virus'];
  var CHAIN_CAP = 4000; // safety only — original has none

  function code(side) { return typeof side === 'number' ? side : (OWNER[side] || 0); }
  function isEven(n) { return n % 2 === 0; }

  // ── Layout (original setDots: dot_size 64, row step 64/1.25) ──────────
  var _layouts = {};
  function layoutFor(rows, cols) {
    rows = rows || ROWS;
    cols = cols || COLS;
    var key = rows + 'x' + cols;
    if (_layouts[key]) return _layouts[key];
    var cells = [];
    for (var i = 0; i < rows; i++) {
      var inRow = isEven(i) ? cols - 1 : cols;
      for (var j = 0; j < inRow; j++) {
        var left = isEven(i) ? 64 * j + 32 : 64 * j;
        cells.push({ row: i, col: j, x: left + 32, y: (64 * i) / 1.25 + 32 });
      }
    }
    // Draggable.hitTest(dot, hitarea 101%) ⇒ centres closer than ~64.3px touch
    var neighbors = [];
    for (var a = 0; a < cells.length; a++) {
      var nb = [];
      for (var b = 0; b < cells.length; b++) {
        if (a === b) continue;
        var dx = Math.abs(cells[a].x - cells[b].x);
        var dy = Math.abs(cells[a].y - cells[b].y);
        if (dx < 64.32 && dy < 64.32) nb.push(b);
      }
      neighbors.push(nb);
    }
    var lay = {
      rows: rows, cols: cols, cells: cells, neighbors: neighbors, count: cells.length,
      width: cols * 64, height: (64 * (rows - 1)) / 1.25 + 64
    };
    _layouts[key] = lay;
    return lay;
  }

  // ── Seeded RNG ───────────────────────────────────────────────────────
  function rng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function newSeed() { return ((Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0); }

  // ── State ────────────────────────────────────────────────────────────
  function State(rows, cols) {
    this.layout = layoutFor(rows, cols);
    this.owner = new Uint8Array(this.layout.count);
    this.stage = new Uint8Array(this.layout.count);
  }
  State.prototype.clone = function () {
    var s = Object.create(State.prototype);
    s.layout = this.layout;
    s.owner = new Uint8Array(this.owner);
    s.stage = new Uint8Array(this.stage);
    return s;
  };
  State.prototype.clear = function () { this.owner.fill(0); this.stage.fill(0); };
  State.prototype.count = function (who) {
    var c = code(who), n = 0;
    for (var i = 0; i < this.owner.length; i++) if (this.owner[i] === c) n++;
    return n;
  };
  /** Original score: sum of stages. */
  State.prototype.score = function (who) {
    var c = code(who), n = 0;
    for (var i = 0; i < this.owner.length; i++) if (this.owner[i] === c) n += this.stage[i];
    return n;
  };
  State.prototype.canTap = function (who, i, ownOnly) {
    if (i == null || i < 0 || i >= this.owner.length) return false;
    var o = this.owner[i];
    if (ownOnly) return o === code(who);
    return o === 0 || o === code(who);
  };
  State.prototype.legalMoves = function (who, ownOnly) {
    var out = [];
    for (var i = 0; i < this.owner.length; i++) if (this.canTap(who, i, ownOnly)) out.push(i);
    return out;
  };

  /**
   * Original click → incrementDotStage/animateNextDot. Returns null if illegal, else
   * { cell, owner, bursts, captured, steps:[{i,o,s,kind:'grow'|'burst', from}] } where
   * steps are the increments in the exact order the phone game animates them.
   */
  State.prototype.apply = function (who, i, opts) {
    opts = opts || {};
    var c = code(who);
    if (!this.canTap(c, i, opts.ownOnly)) return null;
    var owner = this.owner, stage = this.stage, nbs = this.layout.neighbors;
    var n = owner.length;
    var pending = new Uint16Array(n);
    var res = { cell: i, owner: c, bursts: 0, captured: 0, steps: opts.noSteps ? null : [] };
    pending[i] = 1;
    var guard = 0;
    var next = i;
    while (next >= 0 && guard++ < CHAIN_CAP) {
      pending[next]--;
      if (owner[next] !== 0 && owner[next] !== c) res.captured++;
      if (stage[next] < STAGES) {
        stage[next] += 1;
        owner[next] = c;
        if (res.steps) res.steps.push({ i: next, o: c, s: stage[next], kind: 'grow', by: c });
      } else {
        stage[next] = 0;
        owner[next] = 0;
        res.bursts++;
        var list = nbs[next];
        for (var k = 0; k < list.length; k++) pending[list[k]]++;
        if (res.steps) res.steps.push({ i: next, o: 0, s: 0, kind: 'burst', nb: list, by: c });
      }
      next = -1;
      for (var q = 0; q < n; q++) if (pending[q] > 0) { next = q; break; }
    }
    res.truncated = guard >= CHAIN_CAP;
    return res;
  };

  /** RUSH infection: flip `amount` of the victim's strongest dots to the attacker. */
  State.prototype.infect = function (victim, attacker, amount, seed) {
    var v = code(victim), a = code(attacker), r = rng(seed || 1), mine = [];
    for (var i = 0; i < this.owner.length; i++) if (this.owner[i] === v) mine.push({ i: i, s: this.stage[i], t: r() });
    mine.sort(function (x, y) { return (y.s - x.s) || (x.t - y.t); });
    var take = Math.min(amount | 0, Math.max(0, mine.length - 1));
    var changed = [];
    for (var k = 0; k < take; k++) {
      var c = mine[k].i;
      this.owner[c] = a;
      changed.push(c);
    }
    return changed;
  };

  // ── Start layouts (original populate functions) ──────────────────────
  /** fieldPopulateByLevel — identical maps to the phone game's levels 1..200.
   *  p1 = original player--1 (the bot), p2 = original player--2 (you). */
  State.prototype.populateLevel = function (level, p1, p2) {
    this.clear();
    var c1 = code(p1), c2 = code(p2);
    for (var index = 0; index < this.owner.length; index++) {
      var piString = (Math.PI * (index + 1) * level).toString();
      var defaultStage = (index + level) % 5;
      var defaultPlayer = (index % 2) + 1;
      var stageChar = piString[7];
      var stageNum = Number(stageChar);
      var dotStage = (stageChar === undefined || isNaN(stageNum)) ? defaultStage : Math.floor(stageNum / 10 * 5);
      var playerChar = piString[5];
      var playerNum = Number(playerChar);
      var dotPlayer = (playerChar === undefined || isNaN(playerNum)) ? defaultPlayer : Math.floor(playerNum / 10 * 2) + 1;
      if (dotStage === 0) continue;
      dotStage = Math.max(0, Math.min(5, dotStage));
      if (dotPlayer !== 1 && dotPlayer !== 2) dotPlayer = defaultPlayer;
      this.stage[index] = dotStage;
      this.owner[index] = dotPlayer === 1 ? c1 : c2;
    }
    return this;
  };

  /** fieldPopulateRandom — every dot random stage 0..5, random owner (seeded here). */
  State.prototype.populateRandom = function (seed, p1, p2) {
    this.clear();
    var r = rng(seed), c1 = code(p1), c2 = code(p2);
    for (var i = 0; i < this.owner.length; i++) {
      var st = Math.floor(r() * (STAGES + 1));
      var pl = Math.floor(r() * 2) + 1;
      if (!st) continue;
      this.stage[i] = st;
      this.owner[i] = pl === 1 ? c1 : c2;
    }
    return this;
  };

  /** Multiplayer 'half-filled': first half (top rows) p1 stage 3, rest p2 stage 3. */
  State.prototype.populateHalf = function (p1, p2) {
    this.clear();
    var mid = Math.ceil(this.owner.length / 2);
    for (var i = 0; i < this.owner.length; i++) {
      this.stage[i] = 3;
      this.owner[i] = i < mid ? code(p1) : code(p2);
    }
    return this;
  };

  /** Real-Time start: empty field, p1 stage-5 dot at index 6, p2 at index 33. */
  State.prototype.populateRealtime = function (p1, p2) {
    this.clear();
    this.owner[6] = code(p1); this.stage[6] = 5;
    this.owner[33] = code(p2); this.stage[33] = 5;
    return this;
  };

  State.prototype.serialize = function () {
    // Original map string: hex per dot, 0 empty, 1-5 p1 stage, 6-A p2 stage; we need 3 owners
    var o = '', s = '';
    for (var i = 0; i < this.owner.length; i++) { o += this.owner[i]; s += this.stage[i]; }
    return { rows: this.layout.rows, cols: this.layout.cols, o: o, s: s };
  };
  State.prototype.load = function (snap) {
    if (!snap || snap.o == null) return false;
    if (snap.rows && (snap.rows !== this.layout.rows || snap.cols !== this.layout.cols)) {
      this.layout = layoutFor(snap.rows, snap.cols);
      this.owner = new Uint8Array(this.layout.count);
      this.stage = new Uint8Array(this.layout.count);
    }
    var n = Math.min(this.owner.length, snap.o.length);
    for (var i = 0; i < n; i++) {
      this.owner[i] = snap.o.charCodeAt(i) - 48;
      this.stage[i] = snap.s.charCodeAt(i) - 48;
    }
    return true;
  };

  global.DotRules = {
    STAGES: STAGES, ROWS: ROWS, COLS: COLS, OWNER: OWNER, OWNER_NAME: OWNER_NAME,
    code: code, layoutFor: layoutFor, rng: rng, newSeed: newSeed, State: State
  };
})(typeof window !== 'undefined' ? window : globalThis);
