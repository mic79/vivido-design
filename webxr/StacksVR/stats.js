// stats.js — BattleBlocks-style match stats (cup-side realtime) for StacksVR
(function (global) {
  'use strict';

  /**
   * BattleBlocks demo changelog calls out realtime cup-side stats for Blitz /
   * 10 Layers, plus combo / Perfect Clear / T-Stack / score / end-round stats.
   * We track the same core set per side and expose PPM for bot pacing.
   */
  function SideStats() {
    this.reset();
  }

  SideStats.prototype.reset = function () {
    this.pieces = 0;
    this.layers = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.perfectClears = 0;
    this.tStacks = 0;
    this.placeTimes = []; // ms timestamps of recent places
    this._startMs = 0;
  };

  SideStats.prototype.start = function (now) {
    this.reset();
    this._startMs = now || performance.now();
  };

  SideStats.prototype.onPlace = function (now, clearResult) {
    now = now || performance.now();
    if (!this._startMs) this._startMs = now;
    this.pieces += 1;
    this.placeTimes.push(now);
    // Keep ~45s window for rolling PPM
    var cutoff = now - 45000;
    while (this.placeTimes.length && this.placeTimes[0] < cutoff) {
      this.placeTimes.shift();
    }
    if (clearResult) {
      if (clearResult.layersCleared > 0) {
        this.layers += clearResult.layersCleared | 0;
        this.score += clearResult.score | 0;
        this.combo = clearResult.combo | 0;
        if (this.combo > this.maxCombo) this.maxCombo = this.combo;
        if (clearResult.perfectClear) this.perfectClears += 1;
        if (clearResult.tStack) this.tStacks += 1;
      } else {
        this.combo = 0;
      }
    }
  };

  /** Overall pieces per minute since match start. */
  SideStats.prototype.ppmOverall = function (now) {
    now = now || performance.now();
    var elapsedMin = Math.max(1 / 60, ((now - this._startMs) / 60000));
    return this.pieces / elapsedMin;
  };

  /** Rolling PPM over recent places (or overall if sparse). */
  SideStats.prototype.ppmRolling = function (now) {
    now = now || performance.now();
    var times = this.placeTimes;
    if (times.length < 2) return this.ppmOverall(now);
    var spanMs = Math.max(1000, now - times[0]);
    return (times.length / spanMs) * 60000;
  };

  /** Mean gap between recent places (ms). */
  SideStats.prototype.meanPlaceGapMs = function () {
    var times = this.placeTimes;
    if (times.length < 2) return null;
    var sum = 0;
    for (var i = 1; i < times.length; i++) sum += times[i] - times[i - 1];
    return sum / (times.length - 1);
  };

  SideStats.prototype.elapsedSec = function (now) {
    now = now || performance.now();
    if (!this._startMs) return 0;
    return Math.max(0, Math.floor((now - this._startMs) / 1000));
  };

  SideStats.prototype.summaryLines = function (now) {
    now = now || performance.now();
    var sec = this.elapsedSec(now);
    var mm = Math.floor(sec / 60);
    var ss = sec % 60;
    var t = mm + ':' + (ss < 10 ? '0' : '') + ss;
    var ppm = this.ppmRolling(now);
    return [
      'SCR ' + (this.score | 0),
      'LAY ' + (this.layers | 0),
      'PCS ' + (this.pieces | 0),
      'PPM ' + ppm.toFixed(1),
      'CMB ' + (this.combo | 0) + (this.maxCombo ? ' (max ' + this.maxCombo + ')' : ''),
      'PC ' + (this.perfectClears | 0) + '  TS ' + (this.tStacks | 0),
      t
    ];
  };

  SideStats.prototype.hudText = function (now) {
    return this.summaryLines(now).join('\n');
  };

  function MatchStats() {
    this.blue = new SideStats();
    this.red = new SideStats();
  }

  MatchStats.prototype.start = function (now) {
    now = now || performance.now();
    this.blue.start(now);
    this.red.start(now);
  };

  MatchStats.prototype.onPlace = function (side, clearResult, now) {
    var s = side === 'red' ? this.red : this.blue;
    s.onPlace(now || performance.now(), clearResult);
  };

  global.StacksStats = { SideStats: SideStats, MatchStats: MatchStats };
})(window);
