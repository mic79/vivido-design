// cup-bot.js — simple placement AI for StacksVR __BOT__ seat
(function (global) {
  'use strict';

  function CupBot(opts) {
    opts = opts || {};
    this.cup = opts.cup || null;
    this.side = opts.side || 'red';
    this.bag = opts.bag || new global.StacksShapes.ShapeBag();
    this.enabled = false;
    this.thinkIntervalMs = opts.thinkIntervalMs || 900;
    this._lastThink = 0;
    this.currentType = null;
    this.onPlace = opts.onPlace || null;
  }

  CupBot.prototype.setCup = function (cup) {
    this.cup = cup;
  };

  CupBot.prototype.reset = function () {
    this.bag = new global.StacksShapes.ShapeBag();
    this.currentType = null;
    this._lastThink = 0;
  };

  CupBot.prototype.enable = function (on) {
    this.enabled = !!on;
    if (on && !this.currentType) this.currentType = this.bag.next();
  };

  CupBot.prototype.tick = function (now) {
    if (!this.enabled || !this.cup) return null;
    now = now || performance.now();
    if (now - this._lastThink < this.thinkIntervalMs) return null;
    this._lastThink = now;

    if (!this.currentType) this.currentType = this.bag.next();
    var best = this._findBestPlacement(this.currentType);
    if (!best) {
      this.currentType = this.bag.next();
      return null;
    }

    var placed = this.cup.placeCells(best.cells, {
      color: global.StacksShapes.DEFS[this.currentType].color,
      owner: this.side,
      shapeType: this.currentType
    });
    var type = this.currentType;
    this.currentType = this.bag.next();
    if (placed && this.onPlace) {
      this.onPlace(this.side, type, best.cells, { placed: placed, rotationY: best.rot });
    }
    return { type: type, cells: best.cells, placed: placed, score: best.score };
  };

  CupBot.prototype._findBestPlacement = function (type) {
    var def = global.StacksShapes.DEFS[type];
    if (!def) return null;
    var cup = this.cup;
    var best = null;

    for (var rot = 0; rot < 4; rot++) {
      var local = global.StacksShapes.normalizeXZ(global.StacksShapes.rotateY(def.cells, rot));
      var maxX = 0, maxZ = 0;
      for (var i = 0; i < local.length; i++) {
        if (local[i][0] > maxX) maxX = local[i][0];
        if (local[i][2] > maxZ) maxZ = local[i][2];
      }

      for (var ox = 0; ox <= cup.width - 1 - maxX; ox++) {
        for (var oz = 0; oz <= cup.depth - 1 - maxZ; oz++) {
          var dropped = this._dropAt(cup, local, ox, oz);
          if (!dropped) continue;
          var score = this._scorePlacement(cup, dropped);
          if (!best || score > best.score) {
            best = { cells: dropped, rot: rot, score: score };
          }
        }
      }
    }
    return best;
  };

  CupBot.prototype._dropAt = function (cup, local, ox, oz) {
    // Spawn from the highest fitting Y, then gravity-drop
    var found = null;
    for (var y = cup.height - 1; y >= 0; y--) {
      var cells = local.map(function (c) { return [ox + c[0], y + c[1], oz + c[2]]; });
      if (cup.canPlace(cells)) { found = cells; break; }
    }
    if (!found) return null;

    for (;;) {
      var next = found.map(function (c) { return [c[0], c[1] - 1, c[2]]; });
      if (!cup.canPlace(next)) break;
      found = next;
    }

    var resting = false;
    for (var i = 0; i < found.length; i++) {
      if (found[i][1] <= 0) { resting = true; break; }
      if (!cup.isEmpty(found[i][0], found[i][1] - 1, found[i][2])) { resting = true; break; }
    }
    return resting ? found : null;
  };

  CupBot.prototype._scorePlacement = function (cup, cells) {
    var sumY = 0;
    var touching = 0;
    for (var i = 0; i < cells.length; i++) {
      sumY += cells[i][1];
      var x = cells[i][0], y = cells[i][1], z = cells[i][2];
      var neigh = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]];
      for (var n = 0; n < neigh.length; n++) {
        var nx = x + neigh[n][0], ny = y + neigh[n][1], nz = z + neigh[n][2];
        if (!cup.inBounds(nx, ny, nz)) { touching += 0.25; continue; }
        if (!cup.isEmpty(nx, ny, nz)) touching += 1;
      }
    }

    var fillBonus = 0;
    var layerAdds = {};
    for (var j = 0; j < cells.length; j++) {
      var ly = cells[j][1];
      layerAdds[ly] = (layerAdds[ly] || 0) + 1;
    }
    Object.keys(layerAdds).forEach(function (key) {
      var yv = parseInt(key, 10);
      var filled = 0;
      for (var zz = 0; zz < cup.depth; zz++) {
        for (var xx = 0; xx < cup.width; xx++) {
          if (!cup.isEmpty(xx, yv, zz)) filled++;
        }
      }
      filled += layerAdds[key];
      if (filled >= cup.width * cup.depth) fillBonus += 80;
    });

    return fillBonus * 10 + touching * 3 - sumY * 2;
  };

  global.StacksCupBot = CupBot;
})(window);
