// stats.js — BattleBlocks match stats (from in-game HUD screenshot)
(function (global) {
  'use strict';

  /** Station card rates use a rolling window (live pace). Overall BPS kept for cup panel. */
  var RATE_WINDOW_MS = 30000;

  /**
   * BattleBlocks floating player card:
   *   Time: MM:SS.cc
   *   Attacks: N (X.X/min)
   *   Blocks: N (X.X/min)
   * Cup-side panel:
   *   Score / BPS / Attacks
   * Card /min = recent pace (last ~30s). Cup BPS = overall match average.
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
    this.peakBpm = 0;
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
    this._prunePlaceTimes(now);
    var roll = this.ppmRolling(now);
    if (roll > this.peakBpm) this.peakBpm = roll;
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

  /** Compact snapshot for match history / all-time bests. */
  SideStats.prototype.snapshot = function (now) {
    now = now || performance.now();
    return {
      blocks: this.blocks | 0,
      attacks: this.attacks | 0,
      score: this.score | 0,
      layers: this.layers | 0,
      maxCombo: this.maxCombo | 0,
      perfectClears: this.perfectClears | 0,
      bpm: Math.round(this.bps(now) * 10) / 10,
      peakBpm: Math.round((this.peakBpm || 0) * 10) / 10,
      durationMs: this.elapsedMs(now) | 0
    };
  };

  SideStats.prototype.onAttack = function (amount, now) {
    now = now || performance.now();
    if (!amount || amount <= 0) return;
    this.attacks += amount | 0;
    // One stamp per attack line-sent so multi-line clears weight the rolling rate
    var n = amount | 0;
    for (var i = 0; i < n; i++) this.attackTimes.push(now);
    this._pruneAttackTimes(now);
  };

  SideStats.prototype._prunePlaceTimes = function (now) {
    var cutoff = now - RATE_WINDOW_MS;
    while (this.placeTimes.length && this.placeTimes[0] < cutoff) {
      this.placeTimes.shift();
    }
  };

  SideStats.prototype._pruneAttackTimes = function (now) {
    var cutoff = now - RATE_WINDOW_MS;
    while (this.attackTimes.length && this.attackTimes[0] < cutoff) {
      this.attackTimes.shift();
    }
  };

  SideStats.prototype._rollingPerMin = function (times, now) {
    now = now || performance.now();
    var elapsed = this.elapsedMs(now);
    if (elapsed <= 0) return 0;
    var denomMs = Math.min(RATE_WINDOW_MS, Math.max(1000, elapsed));
    return (times.length / denomMs) * 60000;
  };

  SideStats.prototype._ratePerMin = function (count, now) {
    var min = Math.max(1 / 60, this.elapsedMs(now) / 60000);
    return count / min;
  };

  /** Overall blocks/min — BattleBlocks labels this BPS on the cup panel. */
  SideStats.prototype.bps = function (now) {
    return this._ratePerMin(this.blocks, now);
  };

  /** Overall attacks/min (match average). */
  SideStats.prototype.attacksPerMinOverall = function (now) {
    return this._ratePerMin(this.attacks, now);
  };

  /** Live attacks/min (last ~30s) — what the station card shows. */
  SideStats.prototype.attacksPerMin = function (now) {
    now = now || performance.now();
    this._pruneAttackTimes(now);
    return this._rollingPerMin(this.attackTimes, now);
  };

  /** Live blocks/min (last ~30s) — station card + bot pacing. */
  SideStats.prototype.ppmRolling = function (now) {
    now = now || performance.now();
    this._prunePlaceTimes(now);
    return this._rollingPerMin(this.placeTimes, now);
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

  /** Floating card: Time / Attacks / Blocks — rates are live (rolling ~30s). */
  SideStats.prototype.cardText = function (now) {
    now = now || performance.now();
    var apm = this.attacksPerMin(now);
    var bpm = this.ppmRolling(now);
    return 'Time\n' + this.formatTime(now) + '\n' +
      'Attacks\n' + (this.attacks | 0) + '   ' + apm.toFixed(1) + '/min\n' +
      'Blocks\n' + (this.blocks | 0) + '   ' + bpm.toFixed(1) + '/min';
  };

  SideStats.prototype.cardFields = function (now) {
    now = now || performance.now();
    return {
      time: this.formatTime(now),
      attacks: String(this.attacks | 0),
      attackRate: this.attacksPerMin(now).toFixed(1),
      blocks: String(this.blocks | 0),
      blockRate: this.ppmRolling(now).toFixed(1)
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

  // ── Persistent history + all-time bests (DodgeVR-style progression) ──
  var HISTORY_KEY = 'stacksvr-match-history-v2';
  var HISTORY_LEGACY_KEY = 'stacksvr-match-history';
  var HISTORY_MAX = 50;

  function emptyBests(nickname) {
    return {
      nickname: nickname || 'Player',
      bestBpm: 0,
      peakBpm: 0,
      bestBlocks: 0,
      bestAttacks: 0,
      bestLayers: 0,
      bestScore: 0,
      bestMaxCombo: 0,
      longestMs: 0,
      wins: 0,
      losses: 0,
      matches: 0,
      winStreak: 0,
      bestWinStreak: 0
    };
  }

  function loadHistoryRaw() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        return {
          single: Array.isArray(data.single) ? data.single : [],
          multi: Array.isArray(data.multi) ? data.multi : [],
          bests: data.bests && typeof data.bests === 'object' ? data.bests : {}
        };
      }
    } catch (e) { /* ignore */ }

    // Migrate flat v1 list once
    try {
      var legacy = JSON.parse(localStorage.getItem(HISTORY_LEGACY_KEY) || '[]');
      if (Array.isArray(legacy) && legacy.length) {
        var migrated = { single: [], multi: [], bests: {} };
        for (var i = 0; i < legacy.length; i++) {
          var m = legacy[i];
          if (!m) continue;
          var rec = {
            timestamp: m.ts || m.timestamp || Date.now(),
            mode: m.bot ? 'single' : (m.mode === 'pvp' ? 'multi' : (m.bot === false ? 'multi' : 'single')),
            result: m.winner === 'blue' ? 'WIN' : (m.winner === 'red' ? 'LOSS' : (m.winner || null)),
            playerScore: m.blue | 0,
            opponentScore: m.red | 0,
            bot: !!m.bot,
            reason: m.reason || null,
            player: null,
            opponentName: m.bot ? 'Bot' : null
          };
          if (m.bot || rec.mode === 'single') migrated.single.push(rec);
          else migrated.multi.push(rec);
        }
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(migrated)); } catch (e2) {}
        return migrated;
      }
    } catch (e3) { /* ignore */ }
    return { single: [], multi: [], bests: {} };
  }

  function saveHistoryRaw(data) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(data));
    } catch (e) { console.warn('[StacksStats] history save failed', e); }
  }

  function bestsKey(nickname) {
    var n = String(nickname || 'Player').trim().slice(0, 12) || 'Player';
    return n.toLowerCase();
  }

  function applyBests(bestsMap, nickname, snap, won) {
    var key = bestsKey(nickname);
    var b = bestsMap[key] || emptyBests(nickname);
    b.nickname = String(nickname || b.nickname || 'Player').slice(0, 12);
    if (snap) {
      if ((snap.bpm || 0) > (b.bestBpm || 0)) b.bestBpm = snap.bpm;
      if ((snap.peakBpm || 0) > (b.peakBpm || 0)) b.peakBpm = snap.peakBpm;
      if ((snap.blocks | 0) > (b.bestBlocks | 0)) b.bestBlocks = snap.blocks | 0;
      if ((snap.attacks | 0) > (b.bestAttacks | 0)) b.bestAttacks = snap.attacks | 0;
      if ((snap.layers | 0) > (b.bestLayers | 0)) b.bestLayers = snap.layers | 0;
      if ((snap.score | 0) > (b.bestScore | 0)) b.bestScore = snap.score | 0;
      if ((snap.maxCombo | 0) > (b.bestMaxCombo | 0)) b.bestMaxCombo = snap.maxCombo | 0;
      if ((snap.durationMs | 0) > (b.longestMs | 0)) b.longestMs = snap.durationMs | 0;
    }
    b.matches = (b.matches | 0) + 1;
    if (won) {
      b.wins = (b.wins | 0) + 1;
      b.winStreak = (b.winStreak | 0) + 1;
      if (b.winStreak > (b.bestWinStreak | 0)) b.bestWinStreak = b.winStreak;
    } else {
      b.losses = (b.losses | 0) + 1;
      b.winStreak = 0;
    }
    bestsMap[key] = b;
    return b;
  }

  function saveMatchRecord(record) {
    if (!record) return null;
    var hist = loadHistoryRaw();
    var list = record.mode === 'multi' ? hist.multi : hist.single;
    list.unshift(record);
    if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
    if (record.player && record.nickname) {
      applyBests(hist.bests, record.nickname, record.player, record.result === 'WIN');
    }
    saveHistoryRaw(hist);
    return hist;
  }

  function clearHistory(mode) {
    var hist = loadHistoryRaw();
    if (mode === 'multi') hist.multi = [];
    else if (mode === 'single') hist.single = [];
    else {
      hist.single = [];
      hist.multi = [];
      hist.bests = {};
    }
    saveHistoryRaw(hist);
    return hist;
  }

  function getBests(nickname) {
    var hist = loadHistoryRaw();
    var key = bestsKey(nickname);
    return hist.bests[key] || emptyBests(nickname);
  }

  function formatDuration(ms) {
    ms = ms | 0;
    var sec = Math.floor(ms / 1000);
    var mm = Math.floor(sec / 60);
    var ss = sec % 60;
    return mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  global.StacksStats = {
    SideStats: SideStats,
    MatchStats: MatchStats,
    HISTORY_KEY: HISTORY_KEY,
    loadHistory: loadHistoryRaw,
    saveMatch: saveMatchRecord,
    clearHistory: clearHistory,
    getBests: getBests,
    formatDuration: formatDuration,
    emptyBests: emptyBests
  };
  global.loadStacksMatchHistory = loadHistoryRaw;
  global.clearStacksMatchHistory = clearHistory;
})(window);
