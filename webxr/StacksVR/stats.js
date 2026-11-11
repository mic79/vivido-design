// stats.js — BattleBlocks match stats (from in-game HUD screenshot)
(function (global) {
  'use strict';

  /**
   * BattleBlocks floating player card:
   *   Time: MM:SS.cc
   *   Attacks: N (X.X/min)
   *   Blocks: N (X.X/min)
   * Cup-side panel:
   *   Score / BPS / Attacks
   * BPS in BB equals overall blocks/min (292 blocks / 15:58.32 → 18.282).
   */
  function SideStats() {
    this.reset();
  }

  SideStats.prototype.reset = function () {
    this.blocks = 0;
    this.attacks = 0;
    this.score = 0;
    this.layers = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.perfectClears = 0;
    this.tStacks = 0;
    this.placeTimes = [];
    this.attackTimes = [];
    this._startMs = 0;
    // aliases used by older pace code
    this.pieces = 0;
  };

  SideStats.prototype.start = function (now) {
    this.reset();
    this._startMs = now || performance.now();
  };

  SideStats.prototype.elapsedMs = function (now) {
    now = now || performance.now();
    if (!this._startMs) return 0;
    return Math.max(0, now - this._startMs);
  };

  SideStats.prototype.onPlace = function (now, clearResult) {
    now = now || performance.now();
    if (!this._startMs) this._startMs = now;
    this.blocks += 1;
    this.pieces = this.blocks;
    this.placeTimes.push(now);
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

  SideStats.prototype.onAttack = function (amount, now) {
    now = now || performance.now();
    if (!amount || amount <= 0) return;
    this.attacks += amount | 0;
    this.attackTimes.push(now);
    var cutoff = now - 45000;
    while (this.attackTimes.length && this.attackTimes[0] < cutoff) {
      this.attackTimes.shift();
    }
  };

  SideStats.prototype._ratePerMin = function (count, now) {
    var min = Math.max(1 / 60, this.elapsedMs(now) / 60000);
    return count / min;
  };

  /** Overall blocks/min — BattleBlocks labels this BPS on the cup panel. */
  SideStats.prototype.bps = function (now) {
    return this._ratePerMin(this.blocks, now);
  };

  SideStats.prototype.attacksPerMin = function (now) {
    return this._ratePerMin(this.attacks, now);
  };

  /** Rolling blocks/min for bot pacing (recent window). */
  SideStats.prototype.ppmRolling = function (now) {
    now = now || performance.now();
    var times = this.placeTimes;
    if (times.length < 2) return this.bps(now);
    var spanMs = Math.max(1000, now - times[0]);
    return (times.length / spanMs) * 60000;
  };

  SideStats.prototype.ppmOverall = function (now) {
    return this.bps(now);
  };

  SideStats.prototype.meanPlaceGapMs = function () {
    var times = this.placeTimes;
    if (times.length < 2) return null;
    var sum = 0;
    for (var i = 1; i < times.length; i++) sum += times[i] - times[i - 1];
    return sum / (times.length - 1);
  };

  SideStats.prototype.formatTime = function (now) {
    var ms = this.elapsedMs(now);
    var totalSec = ms / 1000;
    var mm = Math.floor(totalSec / 60);
    var ss = Math.floor(totalSec % 60);
    var cc = Math.floor((ms % 1000) / 10);
    return mm + ':' +
      (ss < 10 ? '0' : '') + ss + '.' +
      (cc < 10 ? '0' : '') + cc;
  };

  /** Floating card: Time / Attacks / Blocks — matches BattleBlocks screenshot. */
  SideStats.prototype.cardText = function (now) {
    now = now || performance.now();
    var apm = this.attacksPerMin(now);
    var bpm = this.bps(now);
    return 'Time\n' + this.formatTime(now) + '\n' +
      'Attacks\n' + (this.attacks | 0) + '   ' + apm.toFixed(1) + '/min\n' +
      'Blocks\n' + (this.blocks | 0) + '   ' + bpm.toFixed(1) + '/min';
  };

  SideStats.prototype.cardFields = function (now) {
    now = now || performance.now();
    return {
      time: this.formatTime(now),
      attacks: String(this.attacks | 0),
      attackRate: this.attacksPerMin(now).toFixed(1) + '/min',
      blocks: String(this.blocks | 0),
      blockRate: this.bps(now).toFixed(1) + '/min'
    };
  };

  /** Cup-side panel: Score / BPS / Attacks — matches BattleBlocks screenshot. */
  SideStats.prototype.cupText = function (now) {
    now = now || performance.now();
    return 'Score\n' + (this.score | 0) + '\n' +
      'BPS\n' + this.bps(now).toFixed(3) + '\n' +
      'Attacks\n' + (this.attacks | 0);
  };

  SideStats.prototype.cupFields = function (now) {
    now = now || performance.now();
    return {
      score: String(this.score | 0),
      bps: this.bps(now).toFixed(3),
      attacks: String(this.attacks | 0)
    };
  };

  // Kept for callers that want a single string — card only (no duplicate Attacks/BPS).
  SideStats.prototype.hudText = function (now) {
    return this.cardText(now);
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

  MatchStats.prototype.onAttack = function (side, amount, now) {
    var s = side === 'red' ? this.red : this.blue;
    s.onAttack(amount, now || performance.now());
  };

  global.StacksStats = { SideStats: SideStats, MatchStats: MatchStats };
})(window);
