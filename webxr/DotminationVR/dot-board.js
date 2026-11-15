// dot-board.js — Dotmination rules + hex playfield (logic) and its WebXR view.
//
// Rules (same as the flatscreen game / earlier DotminationVR 360 build):
//  - Hexagonal field of dots. Each dot has an owner (none / blue / red / virus) and a
//    stage 0..5 (shown as dot size).
//  - On your turn tap an empty dot or one of your own dots: it grows one stage.
//  - Growing past stage 5 makes it burst: every neighbour grows one stage AND switches to
//    your colour. Neighbours pushed past 5 burst too (chain reaction). A dot bursts at most
//    once per chain, so every chain terminates.
//  - BURST_LEAVES decides what a burst dot becomes. The DotminationVR 360 build emptied it
//    ('empty'), but simulated games then swing back and forth for 300+ moves and often
//    never finish. Leaving a stage-1 dot of the burster's colour ('own') makes chains
//    snowball, so games end decisively (~35–55 moves per player). Flip it here if the
//    original flatscreen rule is 'empty'.
//  - Win by owning every coloured dot on the field (opponent has none left).
//
// Logic (DotBoardState) is pure + deterministic so moves can be replayed on every peer.
(function (global) {
  'use strict';

  var MAX_STAGE = 5;
  var BURST_LEAVES = 'own'; // 'own' | 'empty' — see header
  var OWNER = { none: 0, blue: 1, red: 2, virus: 3 };
  var OWNER_NAME = ['none', 'blue', 'red', 'virus'];
  var COLORS = {
    0: 0x39404f,
    1: 0x2f86ff,
    2: 0xff4a3a,
    3: 0xb44dff
  };
  var ACCENT = { blue: 0x33bbff, red: 0xff6a3d, virus: 0xc070ff, none: 0x8899aa };

  function ownerCode(side) {
    if (typeof side === 'number') return side;
    return OWNER[side] || 0;
  }

  function ownerName(code) {
    return OWNER_NAME[code] || 'none';
  }

  // ── Seeded RNG (mulberry32) ─────────────────────────────────────────────
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

  function newSeed() {
    return ((Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0);
  }

  // ── Hex layout (axial coords, pointy-top cells, flat-top overall hexagon) ──
  var _layouts = {};
  var DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

  function layoutFor(radius) {
    radius = radius | 0;
    if (_layouts[radius]) return _layouts[radius];
    var cells = [];
    var index = {};
    for (var r = -radius; r <= radius; r++) {
      var q0 = Math.max(-radius, -r - radius);
      var q1 = Math.min(radius, -r + radius);
      for (var q = q0; q <= q1; q++) {
        index[q + ',' + r] = cells.length;
        cells.push({
          q: q,
          r: r,
          x: Math.sqrt(3) * (q + r / 2),
          // +r goes DOWN the vertical board so row 0 of the array is the top row
          y: -1.5 * r
        });
      }
    }
    var neighbors = [];
    var mirror = [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var nb = [];
      for (var d = 0; d < DIRS.length; d++) {
        var k = (c.q + DIRS[d][0]) + ',' + (c.r + DIRS[d][1]);
        if (index[k] != null) nb.push(index[k]);
      }
      nb.sort(function (a, b) { return a - b; });
      neighbors.push(nb);
      mirror.push(index[(-c.q) + ',' + (-c.r)]);
    }
    var lay = { radius: radius, cells: cells, neighbors: neighbors, mirror: mirror, count: cells.length };
    _layouts[radius] = lay;
    return lay;
  }

  /** Lobby boardSize (4 | 6, inherited from StacksVR) → hex radius. */
  function radiusForBoardSize(size) {
    return size === 4 ? 3 : 4;
  }

  // ── Board state ─────────────────────────────────────────────────────────
  function DotBoardState(radius) {
    this.layout = layoutFor(radius || 4);
    this.radius = this.layout.radius;
    this.owner = new Uint8Array(this.layout.count);
    this.stage = new Uint8Array(this.layout.count);
  }

  DotBoardState.prototype.clone = function () {
    var b = Object.create(DotBoardState.prototype);
    b.layout = this.layout;
    b.radius = this.radius;
    b.owner = new Uint8Array(this.owner);
    b.stage = new Uint8Array(this.stage);
    return b;
  };

  DotBoardState.prototype.clear = function () {
    this.owner.fill(0);
    this.stage.fill(0);
  };

  DotBoardState.prototype.count = function (who) {
    var code = ownerCode(who);
    var n = 0;
    for (var i = 0; i < this.owner.length; i++) if (this.owner[i] === code) n++;
    return n;
  };

  DotBoardState.prototype.stageSum = function (who) {
    var code = ownerCode(who);
    var n = 0;
    for (var i = 0; i < this.owner.length; i++) if (this.owner[i] === code) n += this.stage[i];
    return n;
  };

  DotBoardState.prototype.canTap = function (who, i) {
    var code = ownerCode(who);
    if (i == null || i < 0 || i >= this.owner.length) return false;
    var o = this.owner[i];
    return o === 0 || o === code;
  };

  DotBoardState.prototype.legalMoves = function (who) {
    var code = ownerCode(who);
    var out = [];
    for (var i = 0; i < this.owner.length; i++) {
      if (this.owner[i] === 0 || this.owner[i] === code) out.push(i);
    }
    return out;
  };

  /**
   * Apply a tap. Returns null when illegal. Otherwise:
   *   { cell, owner, explosions, captured, waves: [[idx...]...],
   *     steps: [[{i,o,s}...]...] }  ← per-frame display deltas for the view
   * opts.noSteps skips step building (AI search).
   */
  DotBoardState.prototype.apply = function (who, i, opts) {
    var code = ownerCode(who);
    if (!this.canTap(code, i)) return null;
    var wantSteps = !(opts && opts.noSteps);
    var owner = this.owner;
    var stage = this.stage;
    var nbs = this.layout.neighbors;
    var res = { cell: i, owner: code, explosions: 0, captured: 0, waves: [], steps: wantSteps ? [] : null };

    stage[i] += 1;
    owner[i] = code;
    if (stage[i] <= MAX_STAGE) {
      if (wantSteps) res.steps.push([{ i: i, o: code, s: stage[i], kind: 'grow' }]);
      return res;
    }
    stage[i] = MAX_STAGE;
    if (wantSteps) res.steps.push([{ i: i, o: code, s: MAX_STAGE, kind: 'charge' }]);

    var n = owner.length;
    var exploded = new Uint8Array(n);
    var queued = new Uint8Array(n);
    var frontier = [i];
    queued[i] = 1;
    while (frontier.length) {
      frontier.sort(function (a, b) { return a - b; });
      res.waves.push(frontier.slice());
      var burstStep = wantSteps ? [] : null;
      var growStep = wantSteps ? [] : null;
      var next = [];
      for (var w = 0; w < frontier.length; w++) {
        var c = frontier[w];
        exploded[c] = 1;
        var leaveOwn = BURST_LEAVES === 'own';
        owner[c] = leaveOwn ? code : 0;
        stage[c] = leaveOwn ? 1 : 0;
        res.explosions++;
        if (wantSteps) burstStep.push({ i: c, o: owner[c], s: stage[c], kind: 'burst' });
      }
      for (var w2 = 0; w2 < frontier.length; w2++) {
        var src = frontier[w2];
        var list = nbs[src];
        for (var k = 0; k < list.length; k++) {
          var nb = list[k];
          if (exploded[nb]) continue;
          if (owner[nb] !== 0 && owner[nb] !== code) res.captured++;
          owner[nb] = code;
          stage[nb] += 1;
          if (stage[nb] > MAX_STAGE) {
            stage[nb] = MAX_STAGE;
            if (!queued[nb]) {
              queued[nb] = 1;
              next.push(nb);
            }
          }
          if (wantSteps) growStep.push({ i: nb, o: code, s: stage[nb], kind: 'hit', from: src });
        }
      }
      if (wantSteps) {
        res.steps.push(burstStep);
        if (growStep.length) res.steps.push(growStep);
      }
      frontier = next;
    }
    return res;
  };

  /**
   * RUSH attack ("infection"): flip `amount` of `victim`'s dots to `attacker` and charge
   * them one stage. Highest stages first (most dangerous), seeded tie-break. Never takes
   * the victim's last dot. Returns the changed cell indices.
   */
  DotBoardState.prototype.infect = function (victim, attacker, amount, seed) {
    var v = ownerCode(victim);
    var a = ownerCode(attacker);
    var rand = rng(seed || 1);
    var mine = [];
    for (var i = 0; i < this.owner.length; i++) {
      if (this.owner[i] === v) mine.push({ i: i, s: this.stage[i], t: rand() });
    }
    mine.sort(function (x, y) { return (y.s - x.s) || (x.t - y.t); });
    var take = Math.min(amount | 0, Math.max(0, mine.length - 1));
    var changed = [];
    for (var k = 0; k < take; k++) {
      var c = mine[k].i;
      this.owner[c] = a;
      this.stage[c] = Math.min(MAX_STAGE, this.stage[c] + 1);
      changed.push(c);
    }
    return changed;
  };

  /**
   * Random-mode start ("Random mode generates an infinite amount of challenges"):
   * point-symmetric so both colours start with an identical position.
   */
  DotBoardState.prototype.prefill = function (seed, sideA, sideB, opts) {
    opts = opts || {};
    var a = ownerCode(sideA);
    var b = ownerCode(sideB);
    var rand = rng(seed);
    var empty = opts.emptyChance != null ? opts.emptyChance : 0.42;
    var maxStart = opts.maxStage != null ? opts.maxStage : 4;
    this.clear();
    var mirror = this.layout.mirror;
    var placed = 0;
    for (var i = 0; i < this.owner.length; i++) {
      var m = mirror[i];
      if (m < i) continue;
      var roll = rand();
      var st = 1 + Math.floor(rand() * maxStart);
      var flip = rand() < 0.5;
      if (m === i || roll < empty) continue;
      this.owner[i] = flip ? a : b;
      this.owner[m] = flip ? b : a;
      this.stage[i] = st;
      this.stage[m] = st;
      placed++;
    }
    // Guarantee a playable opening (≥3 dots each)
    var guard = 0;
    while (placed < 3 && guard++ < 200) {
      var j = Math.floor(rand() * this.owner.length);
      var mj = mirror[j];
      if (mj === j || this.owner[j] || this.owner[mj]) continue;
      this.owner[j] = a; this.owner[mj] = b;
      this.stage[j] = 2; this.stage[mj] = 2;
      placed++;
    }
    return this;
  };

  DotBoardState.prototype.serialize = function () {
    var o = '';
    var s = '';
    for (var i = 0; i < this.owner.length; i++) {
      o += this.owner[i];
      s += this.stage[i];
    }
    return { r: this.radius, o: o, s: s };
  };

  DotBoardState.prototype.load = function (snap) {
    if (!snap || snap.o == null) return false;
    if (snap.r && snap.r !== this.radius) {
      this.layout = layoutFor(snap.r);
      this.radius = this.layout.radius;
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

  // ── View (THREE) ────────────────────────────────────────────────────────
  var STEP_MS = 150;

  function DotBoardView(opts) {
    opts = opts || {};
    this.radius = opts.radius || 4;
    this.layout = layoutFor(this.radius);
    // Fit the field to ~0.82m wide regardless of radius
    this.spacing = opts.spacing || (0.82 / (Math.sqrt(3) * (2 * this.radius + 1)));
    this.root = new THREE.Group();
    this.root.name = 'dot-board';
    this.dispOwner = new Uint8Array(this.layout.count);
    this.dispStage = new Uint8Array(this.layout.count);
    this._pulse = new Float32Array(this.layout.count);
    this._queue = [];
    this._stepAt = 0;
    this._particles = [];
    this._rimColor = new THREE.Color(ACCENT.none);
    this._rimTarget = new THREE.Color(ACCENT.none);
    this._threat = 0;
    this.onStep = null;
    this._build();
  }

  DotBoardView.prototype._build = function () {
    var s = this.spacing;
    var R = this.radius;
    var plateR = Math.sqrt(3) * R * s + s * 1.05;
    this.plateRadius = plateR;

    // Translucent dark plate — players see each other through it in DUEL
    var plate = new THREE.Mesh(
      new THREE.CircleGeometry(plateR, 6),
      new THREE.MeshStandardMaterial({
        color: 0x0b0f18, roughness: 0.25, metalness: 0.6,
        transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false
      })
    );
    plate.renderOrder = 1;
    this.root.add(plate);
    this.plate = plate;

    var rimMat = new THREE.MeshBasicMaterial({ color: ACCENT.none, side: THREE.DoubleSide, toneMapped: false });
    var rim = new THREE.Mesh(new THREE.RingGeometry(plateR, plateR + 0.014, 6), rimMat);
    rim.position.z = 0.001;
    this.root.add(rim);
    this.rim = rim;

    var n = this.layout.count;
    // Sockets: faint ring per cell so empty spots read on both sides
    var sockGeo = new THREE.RingGeometry(s * 0.30, s * 0.36, 24);
    var sockMat = new THREE.MeshBasicMaterial({
      color: 0x2a3344, side: THREE.DoubleSide, transparent: true, opacity: 0.9, toneMapped: false
    });
    this.sockets = new THREE.InstancedMesh(sockGeo, sockMat, n);
    this.sockets.renderOrder = 2;
    var m = new THREE.Matrix4();
    for (var i = 0; i < n; i++) {
      var c = this.layout.cells[i];
      m.makeTranslation(c.x * s, c.y * s, 0);
      this.sockets.setMatrixAt(i, m);
    }
    this.sockets.instanceMatrix.needsUpdate = true;
    this.root.add(this.sockets);

    // Dots: flattened spheres → readable from both faces of the vertical board
    var dotGeo = new THREE.SphereGeometry(1, 20, 14);
    var dotMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.32, metalness: 0.15,
      emissive: 0x000000
    });
    // Per-instance emissive tint via onBeforeCompile would be heavier; use bright vertexless color
    this.dots = new THREE.InstancedMesh(dotGeo, dotMat, n);
    this.dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dots.renderOrder = 3;
    this.dots.castShadow = false;
    var col = new THREE.Color();
    for (var j = 0; j < n; j++) {
      this.dots.setColorAt(j, col.setHex(COLORS[0]));
    }
    this.root.add(this.dots);

    // Hover rings (one per hand + mouse)
    this.hovers = [];
    for (var h = 0; h < 2; h++) {
      var hr = new THREE.Mesh(
        new THREE.RingGeometry(s * 0.43, s * 0.5, 28),
        new THREE.MeshBasicMaterial({
          color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
          depthWrite: false, toneMapped: false
        })
      );
      hr.visible = false;
      hr.renderOrder = 5;
      this.root.add(hr);
      this.hovers.push(hr);
    }

    // Burst particles (pooled, instanced)
    this._pMax = 96;
    this.parts = new THREE.InstancedMesh(
      new THREE.SphereGeometry(s * 0.09, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
      this._pMax
    );
    this.parts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.parts.count = 0;
    this.parts.renderOrder = 4;
    this.root.add(this.parts);

    this._refreshAll();
  };

  DotBoardView.prototype.setRadius = function (radius) {
    if (radius === this.radius) return;
    var parent = this.root.parent;
    var pos = this.root.position.clone();
    var quat = this.root.quaternion.clone();
    var name = this.root.name;
    if (parent) parent.remove(this.root);
    this.root.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    DotBoardView.call(this, { radius: radius });
    this.root.name = name;
    this.root.position.copy(pos);
    this.root.quaternion.copy(quat);
    if (parent) parent.add(this.root);
  };

  DotBoardView.prototype.cellLocal = function (i, out) {
    var c = this.layout.cells[i];
    out = out || new THREE.Vector3();
    return out.set(c.x * this.spacing, c.y * this.spacing, 0);
  };

  DotBoardView.prototype.cellWorld = function (i, out) {
    out = this.cellLocal(i, out);
    this.root.updateWorldMatrix(true, false);
    return this.root.localToWorld(out);
  };

  DotBoardView.prototype._dotScale = function (stage) {
    var s = this.spacing;
    if (!stage) return 0.0001;
    return s * (0.15 + 0.062 * stage);
  };

  DotBoardView.prototype._writeDot = function (i, extra) {
    var c = this.layout.cells[i];
    var st = this.dispStage[i];
    var r = this._dotScale(st) * (1 + (extra || 0));
    if (!st) r = 0.0001;
    var m = DotBoardView._m || (DotBoardView._m = new THREE.Matrix4());
    m.makeScale(r, r, r * 0.42);
    m.setPosition(c.x * this.spacing, c.y * this.spacing, 0);
    this.dots.setMatrixAt(i, m);
  };

  DotBoardView.prototype._paintDot = function (i, flash) {
    var col = DotBoardView._c || (DotBoardView._c = new THREE.Color());
    col.setHex(COLORS[this.dispOwner[i]] || COLORS[0]);
    if (this.dispStage[i] >= MAX_STAGE) col.lerp(DotBoardView._white || (DotBoardView._white = new THREE.Color(0xffffff)), 0.18);
    if (flash) col.lerp(DotBoardView._white || (DotBoardView._white = new THREE.Color(0xffffff)), Math.min(1, flash));
    this.dots.setColorAt(i, col);
  };

  DotBoardView.prototype._refreshAll = function () {
    for (var i = 0; i < this.layout.count; i++) {
      this._writeDot(i, 0);
      this._paintDot(i, 0);
    }
    this.dots.instanceMatrix.needsUpdate = true;
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
  };

  /** Snap display to logic (no animation). Cancels queued animation steps. */
  DotBoardView.prototype.syncFrom = function (state) {
    if (state.radius !== this.radius) this.setRadius(state.radius);
    this._queue = [];
    this.dispOwner.set(state.owner);
    this.dispStage.set(state.stage);
    this._refreshAll();
  };

  /** Queue animation steps from DotBoardState.apply(); `finalState` re-syncs at the end. */
  DotBoardView.prototype.play = function (res, finalState) {
    if (!res || !res.steps) {
      if (finalState) this.syncFrom(finalState);
      return;
    }
    for (var k = 0; k < res.steps.length; k++) this._queue.push({ cells: res.steps[k] });
    if (finalState) this._queue.push({ sync: finalState.serialize() });
    if (!this._stepAt) this._stepAt = performance.now();
  };

  DotBoardView.prototype.flashCells = function (cells, color) {
    for (var i = 0; i < cells.length; i++) this._pulse[cells[i]] = 1;
    if (color != null) this._flashColor = color;
  };

  DotBoardView.prototype.busy = function () {
    return this._queue.length > 0;
  };

  DotBoardView.prototype.setRim = function (side, threat) {
    var hex = ACCENT[side] != null ? ACCENT[side] : ACCENT.none;
    this._rimTarget.setHex(hex);
    this._threat = threat || 0;
  };

  DotBoardView.prototype.setHover = function (slot, i) {
    var hr = this.hovers[slot | 0];
    if (!hr) return;
    if (i == null || i < 0) { hr.visible = false; return; }
    this.cellLocal(i, hr.position);
    hr.position.z = 0.002;
    hr.visible = true;
  };

  DotBoardView.prototype._spawnBurst = function (i, ownerCodeHit) {
    var c = this.layout.cells[i];
    var nb = this.layout.neighbors[i];
    for (var k = 0; k < nb.length; k++) {
      if (this._particles.length >= this._pMax) break;
      var t = this.layout.cells[nb[k]];
      this._particles.push({
        x0: c.x * this.spacing, y0: c.y * this.spacing,
        x1: t.x * this.spacing, y1: t.y * this.spacing,
        t: 0, dur: STEP_MS * 1.1, color: ownerCodeHit
      });
    }
  };

  /** Advance animation; returns true while busy. */
  DotBoardView.prototype.tick = function (now, dt) {
    now = now || performance.now();
    dt = dt || 16;
    var dirty = false;
    var colorDirty = false;

    while (this._queue.length && now >= this._stepAt) {
      var step = this._queue.shift();
      if (step.sync) {
        for (var si = 0; si < this.layout.count && si < step.sync.o.length; si++) {
          this.dispOwner[si] = step.sync.o.charCodeAt(si) - 48;
          this.dispStage[si] = step.sync.s.charCodeAt(si) - 48;
        }
        for (var sj = 0; sj < this.layout.count; sj++) { this._writeDot(sj, 0); this._paintDot(sj, 0); }
        dirty = colorDirty = true;
        this._stepAt = now;
        continue;
      }
      var kind = null;
      for (var j = 0; j < step.cells.length; j++) {
        var d = step.cells[j];
        kind = d.kind;
        if (d.kind === 'burst') {
          this._spawnBurst(d.i, this.dispOwner[d.i]);
          this._pulse[d.i] = 1;
        } else {
          this._pulse[d.i] = Math.max(this._pulse[d.i], d.kind === 'hit' ? 0.7 : 0.45);
        }
        this.dispOwner[d.i] = d.o;
        this.dispStage[d.i] = d.s;
      }
      if (this.onStep) this.onStep(kind, step.cells);
      dirty = colorDirty = true;
      this._stepAt = now + (kind === 'grow' ? 60 : STEP_MS);
    }
    if (!this._queue.length) this._stepAt = 0;

    // Pulses + stage-5 breathing
    var breathe = 0.06 * Math.sin(now * 0.012);
    for (var i = 0; i < this.layout.count; i++) {
      var p = this._pulse[i];
      if (p > 0) {
        p = Math.max(0, p - dt / 260);
        this._pulse[i] = p;
        this._writeDot(i, p * 0.35);
        this._paintDot(i, p * 0.8);
        dirty = colorDirty = true;
      } else if (this.dispStage[i] >= MAX_STAGE) {
        this._writeDot(i, breathe);
        dirty = true;
      }
    }

    // Particles
    var m = DotBoardView._pm || (DotBoardView._pm = new THREE.Matrix4());
    var pc = DotBoardView._pc || (DotBoardView._pc = new THREE.Color());
    var live = 0;
    for (var q = 0; q < this._particles.length; q++) {
      var pt = this._particles[q];
      pt.t += dt;
      var u = Math.min(1, pt.t / pt.dur);
      if (u >= 1) continue;
      var e = u * (2 - u);
      m.makeScale(1 - u * 0.5, 1 - u * 0.5, 1 - u * 0.5);
      m.setPosition(pt.x0 + (pt.x1 - pt.x0) * e, pt.y0 + (pt.y1 - pt.y0) * e, 0.012 * Math.sin(u * Math.PI));
      this.parts.setMatrixAt(live, m);
      this.parts.setColorAt(live, pc.setHex(COLORS[pt.color] || 0xffffff).lerp(DotBoardView._white || (DotBoardView._white = new THREE.Color(0xffffff)), 0.4));
      this._particles[live] = pt;
      live++;
    }
    this._particles.length = live;
    this.parts.count = live;
    if (live) {
      this.parts.instanceMatrix.needsUpdate = true;
      if (this.parts.instanceColor) this.parts.instanceColor.needsUpdate = true;
    }

    if (dirty) this.dots.instanceMatrix.needsUpdate = true;
    if (colorDirty && this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;

    // Rim: lerp to turn colour, throb when under attack (RUSH)
    this._rimColor.lerp(this._rimTarget, Math.min(1, dt / 160));
    var rc = this.rim.material.color;
    rc.copy(this._rimColor);
    if (this._threat > 0) {
      var th = 0.5 + 0.5 * Math.sin(now * 0.02);
      rc.lerp(DotBoardView._warn || (DotBoardView._warn = new THREE.Color(0xffcc33)), this._threat * th);
    }
    return this.busy();
  };

  /**
   * Ray (world) → cell index or -1. Analytic plane hit; no per-dot raycast meshes.
   */
  DotBoardView.prototype.pickRay = function (origin, dir) {
    var inv = DotBoardView._inv || (DotBoardView._inv = new THREE.Matrix4());
    this.root.updateWorldMatrix(true, false);
    inv.copy(this.root.matrixWorld).invert();
    var o = (DotBoardView._o || (DotBoardView._o = new THREE.Vector3())).copy(origin).applyMatrix4(inv);
    var e = (DotBoardView._e || (DotBoardView._e = new THREE.Vector3())).copy(origin).add(dir).applyMatrix4(inv);
    var dz = e.z - o.z;
    if (Math.abs(dz) < 1e-6) return { index: -1 };
    var t = -o.z / dz;
    if (t < 0) return { index: -1 };
    var hx = o.x + (e.x - o.x) * t;
    var hy = o.y + (e.y - o.y) * t;
    var idx = this._nearest(hx, hy, 0.56);
    return { index: idx, dist: t * dir.length(), x: hx, y: hy };
  };

  /** Fingertip poke (world point) → { index, depth } when touching the plane. */
  DotBoardView.prototype.pokePoint = function (worldPoint) {
    var inv = DotBoardView._inv2 || (DotBoardView._inv2 = new THREE.Matrix4());
    this.root.updateWorldMatrix(true, false);
    inv.copy(this.root.matrixWorld).invert();
    var p = (DotBoardView._pp || (DotBoardView._pp = new THREE.Vector3())).copy(worldPoint).applyMatrix4(inv);
    var idx = this._nearest(p.x, p.y, 0.5);
    return { index: idx, depth: Math.abs(p.z), z: p.z };
  };

  DotBoardView.prototype._nearest = function (x, y, frac) {
    var s = this.spacing;
    var best = -1;
    var bestD = (s * frac) * (s * frac);
    for (var i = 0; i < this.layout.count; i++) {
      var c = this.layout.cells[i];
      var dx = c.x * s - x;
      var dy = c.y * s - y;
      var d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    return best;
  };

  global.DotBoard = {
    MAX_STAGE: MAX_STAGE,
    BURST_LEAVES: BURST_LEAVES,
    OWNER: OWNER,
    COLORS: COLORS,
    ACCENT: ACCENT,
    ownerCode: ownerCode,
    ownerName: ownerName,
    rng: rng,
    newSeed: newSeed,
    layoutFor: layoutFor,
    radiusForBoardSize: radiusForBoardSize,
    State: DotBoardState,
    View: DotBoardView
  };
})(typeof window !== 'undefined' ? window : globalThis);
