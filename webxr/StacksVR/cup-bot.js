// cup-bot.js — visible pad/pocket + clear-focused placement AI for StacksVR
(function (global) {
  'use strict';

  function CupBot(opts) {
    opts = opts || {};
    this.cup = opts.cup || null;
    this.side = opts.side || 'red';
    this._bagSeed = opts.bagSeed != null ? opts.bagSeed : null;
    this.bag = opts.bag || new global.StacksShapes.ShapeBag(this._bagSeed);
    this.enabled = false;
    this.thinkIntervalMs = opts.thinkIntervalMs != null ? opts.thinkIntervalMs : 1200;
    // Long enough for move-above → orient → lower (3 readable phases)
    this.placeAnimMs = opts.placeAnimMs != null ? opts.placeAnimMs : 1100;
    this.baseThinkMs = this.thinkIntervalMs;
    this.basePlaceAnimMs = this.placeAnimMs;
    // Adaptive pacing: follow a target PPM with wandering variation
    this.adaptPace = opts.adaptPace !== false;
    this._paceMul = 1;
    this._paceTargetMul = 1;
    this._nextPaceJitterAt = 0;
    this._lastThink = 0;
    this.currentType = null;
    this.pocketType = null;
    this.pocketUsed = false;
    this.onPlace = opts.onPlace || null;
    this.onVisual = opts.onVisual || null;

    this.state = 'idle'; // idle | animating
    this._anim = null;
    this._busyUntil = 0;
  }

  CupBot.prototype.setCup = function (cup) {
    this.cup = cup;
  };

  CupBot.prototype.setBagSeed = function (seed) {
    this._bagSeed = seed == null ? null : (seed >>> 0);
    this.bag = new global.StacksShapes.ShapeBag(this._bagSeed);
  };

  CupBot.prototype.reset = function (seed) {
    if (seed != null) this._bagSeed = seed >>> 0;
    this.bag = new global.StacksShapes.ShapeBag(this._bagSeed);
    this.currentType = null;
    this.pocketType = null;
    this.pocketUsed = false;
    this._lastThink = 0;
    this._busyUntil = 0;
    this.state = 'idle';
    this._anim = null;
    this._paceMul = 1;
    this._paceTargetMul = 1;
    this._nextPaceJitterAt = 0;
    this.thinkIntervalMs = this.baseThinkMs;
    this.placeAnimMs = this.basePlaceAnimMs;
    this._emit({ kind: 'reset' });
  };

  /**
   * Match a player's pieces-per-minute. Variation wanders ~±20% over time.
   * cycleMs = think + anim + busy ≈ 60000/ppm.
   */
  CupBot.prototype.setTargetPpm = function (ppm, now) {
    if (!this.adaptPace) return;
    now = now || performance.now();
    ppm = Math.max(4, Math.min(40, ppm || 12));
    var cycleMs = 60000 / ppm;
    // Split cycle: ~45% think/idle, ~45% place anim, ~10% post-busy
    var think = Math.max(280, cycleMs * 0.42);
    var anim = Math.max(450, Math.min(1600, cycleMs * 0.45));
    this.baseThinkMs = think;
    this.basePlaceAnimMs = anim;
    this._applyPaceMul(now);
  };

  CupBot.prototype._applyPaceMul = function (now) {
    now = now || performance.now();
    if (now >= this._nextPaceJitterAt) {
      // Wander target multiplier: sometimes faster, sometimes slower
      this._paceTargetMul = 0.72 + Math.random() * 0.56; // 0.72–1.28
      this._nextPaceJitterAt = now + 3500 + Math.random() * 6500;
    }
    // Ease current multiplier toward target
    this._paceMul += (this._paceTargetMul - this._paceMul) * 0.12;
    // Higher mul = faster = shorter intervals
    var inv = 1 / Math.max(0.55, Math.min(1.6, this._paceMul));
    this.thinkIntervalMs = Math.max(220, this.baseThinkMs * inv);
    this.placeAnimMs = Math.max(400, Math.min(1800, this.basePlaceAnimMs * inv));
  };

  CupBot.prototype.enable = function (on) {
    this.enabled = !!on;
    if (on) {
      if (!this.currentType) this.currentType = this.bag.next();
      this._emit({ kind: 'pad', type: this.currentType });
      this._emit({ kind: 'pocket', type: this.pocketType });
    } else {
      this.state = 'idle';
      this._anim = null;
      this._emit({ kind: 'pad', type: null });
      this._emit({ kind: 'pocket', type: null });
      this._emit({ kind: 'hold', holding: false });
    }
  };

  CupBot.prototype._emit = function (evt) {
    if (typeof this.onVisual === 'function') this.onVisual(evt);
  };

  CupBot.prototype.tick = function (now) {
    if (!this.enabled || !this.cup) return null;
    now = now || performance.now();
    if (this.adaptPace) this._applyPaceMul(now);

    if (this.state === 'animating' && this._anim) {
      return this._tickAnim(now);
    }

    if (now < this._busyUntil) return null;
    if (now - this._lastThink < this.thinkIntervalMs) return null;
    this._lastThink = now;

    if (!this.currentType) {
      this.currentType = this.bag.next();
      this._emit({ kind: 'pad', type: this.currentType });
    }

    var plan = this._planMove();
    if (!plan) return null;

    if (plan.action === 'hold') {
      // Current → pocket, draw next
      this.pocketType = this.currentType;
      this.currentType = this.bag.next();
      this.pocketUsed = true;
      this._emit({ kind: 'pad', type: this.currentType });
      this._emit({ kind: 'pocket', type: this.pocketType });
      this._busyUntil = now + 320;
      return null;
    }

    if (plan.action === 'swap') {
      var held = this.currentType;
      this.currentType = this.pocketType;
      this.pocketType = held;
      this.pocketUsed = true;
      this._emit({ kind: 'pad', type: this.currentType });
      this._emit({ kind: 'pocket', type: this.pocketType });
      this._busyUntil = now + 320;
      return null;
    }

    // Animate place: move above → orient → lower
    this.state = 'animating';
    this._anim = {
      type: plan.type,
      cells: plan.cells,
      score: plan.score,
      quat: plan.quat || null,
      started: now,
      duration: this.placeAnimMs
    };
    this._emit({ kind: 'pad', type: null });
    this._emit({
      kind: 'hold',
      holding: true,
      type: plan.type,
      cells: plan.cells,
      quat: plan.quat || null,
      progress: 0
    });
    return null;
  };

  CupBot.prototype._tickAnim = function (now) {
    var a = this._anim;
    if (!a) {
      this.state = 'idle';
      return null;
    }
    var t = (now - a.started) / Math.max(1, a.duration);
    this._emit({
      kind: 'hold',
      holding: true,
      type: a.type,
      cells: a.cells,
      quat: a.quat || null,
      progress: Math.min(1, t)
    });
    if (t < 1) return null;

    var placed = this.cup.placeCells(a.cells, {
      color: global.StacksShapes.DEFS[a.type].color,
      owner: this.side,
      shapeType: a.type
    });
    var type = a.type;
    var cells = a.cells;
    var score = a.score;
    this._anim = null;
    this.state = 'idle';
    this._emit({ kind: 'hold', holding: false });

    this.currentType = this.bag.next();
    this.pocketUsed = false;
    this._emit({ kind: 'pad', type: this.currentType });
    this._busyUntil = now + 250;

    if (placed && this.onPlace) {
      this.onPlace(this.side, type, cells, { placed: placed, score: score });
    }
    return { type: type, cells: cells, placed: placed, score: score };
  };

  CupBot.prototype._orientations = function (type) {
    var def = global.StacksShapes.DEFS[type];
    if (!def) return [];
    var seen = {};
    var out = [];
    var quats = global.StacksShapes.cubeOrients ? global.StacksShapes.cubeOrients() : null;
    if (quats && quats.length) {
      for (var i = 0; i < quats.length; i++) {
        var cells = global.StacksShapes.orientCells(def.cells, quats[i]);
        var key = cells.map(function (c) { return c.join(','); }).sort().join('|');
        if (seen[key]) continue;
        seen[key] = true;
        out.push({ cells: cells, quat: quats[i] });
      }
    } else {
      for (var rot = 0; rot < 4; rot++) {
        var e = new THREE.Euler(0, rot * Math.PI / 2, 0, 'XYZ');
        var q = new THREE.Quaternion().setFromEuler(e);
        out.push({
          cells: global.StacksShapes.normalizeXZ(global.StacksShapes.rotateY(def.cells, rot)),
          quat: q
        });
      }
    }
    return out;
  };

  CupBot.prototype._dropAt = function (cup, local, ox, oz) {
    var found = null;
    for (var y = cup.height - 1; y >= 0; y--) {
      var tryCells = local.map(function (c) { return [ox + c[0], y + c[1], oz + c[2]]; });
      if (cup.canPlace(tryCells)) { found = tryCells; break; }
    }
    if (!found) return null;

    for (;;) {
      var next = found.map(function (c) { return [c[0], c[1] - 1, c[2]]; });
      if (!cup.canPlace(next)) break;
      found = next;
    }

    for (var i = 0; i < found.length; i++) {
      if (found[i][1] <= 0) return found;
      if (!cup.isEmpty(found[i][0], found[i][1] - 1, found[i][2])) return found;
    }
    return null;
  };

  CupBot.prototype._bestForType = function (type) {
    if (!type || !this.cup) return null;
    var cup = this.cup;
    var orients = this._orientations(type);
    var best = null;

    for (var oi = 0; oi < orients.length; oi++) {
      var orient = orients[oi];
      var local = orient.cells || orient;
      var quat = orient.quat || null;
      var maxX = 0, maxZ = 0, maxY = 0;
      for (var i = 0; i < local.length; i++) {
        if (local[i][0] > maxX) maxX = local[i][0];
        if (local[i][1] > maxY) maxY = local[i][1];
        if (local[i][2] > maxZ) maxZ = local[i][2];
      }
      if (maxY >= cup.height) continue;

      for (var ox = 0; ox <= cup.width - 1 - maxX; ox++) {
        for (var oz = 0; oz <= cup.depth - 1 - maxZ; oz++) {
          var dropped = this._dropAt(cup, local, ox, oz);
          if (!dropped) continue;
          var score = this._scorePlacement(cup, dropped, type);
          if (!best || score > best.score) {
            best = { type: type, cells: dropped, score: score, quat: quat };
          }
        }
      }
    }
    return best;
  };

  CupBot.prototype._planMove = function () {
    var cur = this._bestForType(this.currentType);
    if (!cur) return null;

    var pocketBest = this.pocketType ? this._bestForType(this.pocketType) : null;

    // Swap if pocket piece is clearly better
    if (!this.pocketUsed && pocketBest && pocketBest.score > cur.score + 35) {
      return { action: 'swap' };
    }

    // Hold current into empty pocket if it's awful and next looks better
    if (!this.pocketUsed && !this.pocketType && cur.score < -100) {
      var peek = this.bag.peek ? this.bag.peek(1) : null;
      var nextType = peek && peek[0];
      if (nextType) {
        var nextBest = this._bestForType(nextType);
        if (nextBest && nextBest.score > cur.score + 80) {
          return { action: 'hold' };
        }
      }
    }

    return {
      action: 'place',
      type: cur.type,
      cells: cur.cells,
      score: cur.score,
      quat: cur.quat || null
    };
  };

  /** Occupancy clone — never touches live meshes (scoring must be cheap). */
  CupBot.prototype._cloneOcc = function (cup) {
    var g = [];
    for (var y = 0; y < cup.height; y++) {
      var layer = [];
      for (var z = 0; z < cup.depth; z++) {
        var row = [];
        for (var x = 0; x < cup.width; x++) {
          row.push(cup.grid[y][z][x] ? 1 : 0);
        }
        layer.push(row);
      }
      g.push(layer);
    }
    return g;
  };

  CupBot.prototype._scorePlacement = function (cup, cells, type) {
    var w = cup.width, d = cup.depth, h = cup.height;
    var g = this._cloneOcc(cup);
    for (var i = 0; i < cells.length; i++) {
      var cx = cells[i][0], cy = cells[i][1], cz = cells[i][2];
      if (cx < 0 || cy < 0 || cz < 0 || cx >= w || cy >= h || cz >= d) return -99999;
      if (g[cy][cz][cx]) return -99999;
      g[cy][cz][cx] = 1;
    }

    var full = [];
    for (var y = 0; y < h; y++) {
      var layerFull = true;
      for (var z = 0; z < d && layerFull; z++) {
        for (var x = 0; x < w; x++) {
          if (!g[y][z][x]) { layerFull = false; break; }
        }
      }
      if (layerFull) full.push(y);
    }
    var lines = full.length;

    // Collapse full layers on the occupancy clone
    if (lines > 0) {
      var keep = [];
      for (var yy = 0; yy < h; yy++) {
        if (full.indexOf(yy) < 0) keep.push(g[yy]);
      }
      while (keep.length < h) {
        var empty = [];
        for (var zz = 0; zz < d; zz++) {
          var erow = [];
          for (var xx = 0; xx < w; xx++) erow.push(0);
          empty.push(erow);
        }
        keep.push(empty);
      }
      g = keep;
    }

    var holes = 0;
    var aggHeight = 0;
    var colHeights = [];
    var maxH = 0;
    for (var x2 = 0; x2 < w; x2++) {
      for (var z2 = 0; z2 < d; z2++) {
        var ch = 0;
        var blockSeen = false;
        for (var y2 = h - 1; y2 >= 0; y2--) {
          if (g[y2][z2][x2]) {
            if (!blockSeen) {
              ch = y2 + 1;
              blockSeen = true;
            }
          } else if (blockSeen) {
            holes++;
          }
        }
        colHeights.push(ch);
        aggHeight += ch;
        if (ch > maxH) maxH = ch;
      }
    }

    var bumpiness = 0;
    for (var b = 0; b < colHeights.length - 1; b++) {
      bumpiness += Math.abs(colHeights[b] - colHeights[b + 1]);
    }

    var sumY = 0;
    for (var c = 0; c < cells.length; c++) sumY += cells[c][1];

    return lines * 5200 +
      (lines >= 2 ? 1800 : 0) +
      (lines >= 3 ? 2400 : 0) +
      (lines >= 4 ? 4000 : 0) -
      holes * 160 -
      aggHeight * 8 -
      bumpiness * 6 -
      maxH * 25 -
      sumY * 2;
  };

  global.StacksCupBot = CupBot;
})(window);
