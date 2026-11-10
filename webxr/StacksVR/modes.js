// modes.js — match rules wrapper for StacksVR
(function (global) {
  'use strict';

  var MODES = {
    pvp: {
      id: 'pvp',
      label: 'PvP',
      timed: false,
      durationMs: 0,
      winOnOverflow: true,
      winOnScore: false,
      targetLayers: 0
    },
    blitz: {
      id: 'blitz',
      label: 'Blitz',
      timed: true,
      durationMs: 120000,
      winOnOverflow: true,
      winOnScore: true,
      targetLayers: 0
    },
    tenLayers: {
      id: 'tenLayers',
      label: '10 Layers',
      timed: false,
      durationMs: 0,
      winOnOverflow: true,
      winOnScore: false,
      targetLayers: 10
    }
  };

  function ModeController(opts) {
    opts = opts || {};
    this.mode = MODES[opts.mode] || MODES.pvp;
    this.scores = { blue: 0, red: 0 };
    this.layersCleared = { blue: 0, red: 0 };
    this.matchStart = 0;
    this.active = false;
    this.winner = null;
    this.reason = null;
  }

  ModeController.prototype.setMode = function (id) {
    this.mode = MODES[id] || MODES.pvp;
  };

  ModeController.prototype.start = function (now) {
    this.scores = { blue: 0, red: 0 };
    this.layersCleared = { blue: 0, red: 0 };
    this.matchStart = now || Date.now();
    this.active = true;
    this.winner = null;
    this.reason = null;
  };

  ModeController.prototype.stop = function () {
    this.active = false;
  };

  ModeController.prototype.addClear = function (side, clearResult) {
    if (!this.active) return null;
    this.scores[side] += clearResult.score || 0;
    this.layersCleared[side] += clearResult.layersCleared || 0;

    if (this.mode.targetLayers > 0 && this.layersCleared[side] >= this.mode.targetLayers) {
      this.winner = side;
      this.reason = 'target-layers';
      this.active = false;
      return { ended: true, winner: side, reason: this.reason };
    }
    return { ended: false };
  };

  ModeController.prototype.onOverflow = function (side) {
    if (!this.active || !this.mode.winOnOverflow) return null;
    var winner = side === 'blue' ? 'red' : 'blue';
    this.winner = winner;
    this.reason = 'overflow';
    this.active = false;
    return { ended: true, winner: winner, reason: this.reason, loser: side };
  };

  ModeController.prototype.tick = function (now) {
    if (!this.active || !this.mode.timed) return null;
    now = now || Date.now();
    if (now - this.matchStart >= this.mode.durationMs) {
      var winner = null;
      if (this.scores.blue > this.scores.red) winner = 'blue';
      else if (this.scores.red > this.scores.blue) winner = 'red';
      else winner = 'draw';
      this.winner = winner;
      this.reason = 'time';
      this.active = false;
      return { ended: true, winner: winner, reason: this.reason };
    }
    return {
      ended: false,
      remainingMs: this.mode.durationMs - (now - this.matchStart)
    };
  };

  ModeController.prototype.elapsedMs = function (now) {
    return (now || Date.now()) - this.matchStart;
  };

  global.StacksModes = { MODES: MODES, ModeController: ModeController };
})(window);
