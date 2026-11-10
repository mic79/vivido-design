// clear.js — layer clears, combo, Perfect Clear, T-Stack for StacksVR
(function (global) {
  'use strict';

  var STACK_BONUS_SHAPES = ['T'];

  function ClearSystem(opts) {
    opts = opts || {};
    this.comboPenalty = opts.comboPenalty != null ? opts.comboPenalty : 2;
    this.stackBonusShapes = opts.stackBonusShapes || STACK_BONUS_SHAPES.slice();
    this.combo = 0;
  }

  ClearSystem.prototype.resetCombo = function () {
    this.combo = 0;
  };

  ClearSystem.prototype.findFullLayers = function (cup) {
    var layers = [];
    for (var y = 0; y < cup.height; y++) {
      if (cup.isLayerFull(y)) layers.push(y);
    }
    return layers;
  };

  // placedCells: [{x,y,z,cell}], shapeType optional
  ClearSystem.prototype.resolveAfterPlace = function (cup, placedCells, shapeType) {
    var full = this.findFullLayers(cup);
    if (full.length === 0) {
      this.combo = 0;
      return {
        layersCleared: 0,
        clearedYs: [],
        combo: 0,
        perfectClear: false,
        tStack: false,
        damage: 0,
        score: 0
      };
    }

    this.combo += 1;
    var tStack = this._isTStack(cup, full, placedCells, shapeType);
    var beforeClearCount = cup.occupiedCount();
    var cellsInCleared = 0;
    for (var i = 0; i < full.length; i++) {
      for (var z = 0; z < cup.depth; z++) {
        for (var x = 0; x < cup.width; x++) {
          if (cup.grid[full[i]][z][x]) cellsInCleared++;
        }
      }
    }

    for (var j = 0; j < full.length; j++) cup.clearLayer(full[j]);
    cup.collapseAbove(full);

    var perfectClear = cup.isPerfectlyClear();
    var layers = full.length;
    var baseDamage = Math.max(0, layers - 1); // single=0, double=1, triple=2, quad=3
    if (tStack) baseDamage += 2;

    var comboExtra = 0;
    if (this.combo > this.comboPenalty) {
      comboExtra = this.combo - this.comboPenalty;
    }
    // Combo damage starts from x2: 2x gives no extra (penalty=2), 3x does
    var damage = baseDamage + comboExtra;

    var score = layers * 100;
    if (layers === 2) score = 300;
    if (layers === 3) score = 500;
    if (layers === 4) score = 800;
    if (tStack) score += 400;
    if (perfectClear) {
      // Blitz-style PC ladder by layers: 2k/3k/4k/6k
      var pc = [0, 2000, 3000, 4000, 6000];
      score += pc[Math.min(layers, 4)] || 6000;
    }
    if (this.combo > 1) score += (this.combo - 1) * 50;

    return {
      layersCleared: layers,
      clearedYs: full,
      combo: this.combo,
      perfectClear: perfectClear,
      tStack: tStack,
      damage: damage,
      score: score,
      cellsCleared: cellsInCleared,
      beforeClearCount: beforeClearCount
    };
  };

  ClearSystem.prototype._isTStack = function (cup, clearedYs, placedCells, shapeType) {
    if (!shapeType || this.stackBonusShapes.indexOf(shapeType) < 0) return false;
    if (!placedCells || placedCells.length === 0) return false;
    // T must be fully consumed by the cleared layers
    for (var i = 0; i < placedCells.length; i++) {
      if (clearedYs.indexOf(placedCells[i].y) < 0) return false;
    }
    return clearedYs.length >= 2;
  };

  global.StacksClear = ClearSystem;
})(window);
