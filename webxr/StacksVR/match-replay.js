// match-replay.js — events-only replay for StacksVR
// DodgeVR samples ~70 floats/frame; StacksVR never dumps full cup JSON @10Hz
// (that froze Quest on IDB). Places + garbage events reconstruct the board.
(function () {
  'use strict';

  var DB_NAME = 'stacksvr-replays';
  var DB_VERSION = 1;
  var STORE_NAME = 'replays';
  var MAX_EVENTS = 4000;

  var db = null;

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (db) { resolve(db); return; }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(STORE_NAME)) {
          d.createObjectStore(STORE_NAME, { keyPath: 'matchTimestamp' });
        }
      };
      req.onsuccess = function (e) { db = e.target.result; resolve(db); };
      req.onerror = function (e) { reject(e); };
    });
  }

  function saveReplay(replay) {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(replay);
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
    });
  }

  function loadReplay(ts) {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE_NAME, 'readonly');
        var r = tx.objectStore(STORE_NAME).get(ts);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = reject;
      });
    });
  }

  function deleteReplay(ts) {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(ts);
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
    });
  }

  function listReplayTimestamps() {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE_NAME, 'readonly');
        var r = tx.objectStore(STORE_NAME).getAllKeys();
        r.onsuccess = function () { resolve(r.result || []); };
        r.onerror = reject;
      });
    });
  }

  function pruneOldReplays(keepTimestamps) {
    return listReplayTimestamps().then(function (all) {
      var keep = {};
      for (var i = 0; i < keepTimestamps.length; i++) keep[keepTimestamps[i]] = true;
      var toDelete = all.filter(function (ts) { return !keep[ts]; });
      if (toDelete.length === 0) return Promise.resolve();
      return openDB().then(function (d) {
        return new Promise(function (resolve) {
          var tx = d.transaction(STORE_NAME, 'readwrite');
          var store = tx.objectStore(STORE_NAME);
          for (var i = 0; i < toDelete.length; i++) store.delete(toDelete[i]);
          tx.oncomplete = resolve;
        });
      });
    });
  }

  window.matchReplayStorage = {
    save: function (replay) { return saveReplay(replay); },
    load: loadReplay,
    remove: deleteReplay,
    list: listReplayTimestamps,
    pruneOld: pruneOldReplays
  };

  window.matchRecorder = {
    isRecording: false,
    _events: [],
    _startTime: 0,
    _matchTimestamp: 0,
    _durationMs: 0,

    startRecording: function (matchTimestamp) {
      this._events = [];
      this._startTime = performance.now();
      this._matchTimestamp = matchTimestamp || Date.now();
      this._durationMs = 0;
      this.isRecording = true;
    },

    recordEvent: function (type, data) {
      if (!this.isRecording) return;
      if (this._events.length >= MAX_EVENTS) return;
      this._events.push({
        t: Math.round(performance.now() - this._startTime),
        type: type,
        data: data
      });
    },

    tick: function () {},

    stopCapture: function () {
      if (!this.isRecording && !this._events.length) return;
      if (this.isRecording) {
        this._durationMs = Math.round(performance.now() - this._startTime);
      }
      this.isRecording = false;
    },

    takeReplay: function () {
      this.isRecording = false;
      if (!this._events.length && !this._durationMs) return null;
      var replay = {
        matchTimestamp: this._matchTimestamp,
        version: 3,
        kind: 'stacksvr',
        events: this._events,
        frames: [],
        durationMs: this._durationMs || Math.round(performance.now() - this._startTime)
      };
      this._events = [];
      this._durationMs = 0;
      console.log('[MatchReplay] events-only', replay.events.length, 'events',
        Math.round(replay.durationMs / 1000) + 's');
      return replay;
    },

    stopRecording: function () {
      this.stopCapture();
      return this.takeReplay();
    }
  };

  function getGame() {
    var gm = document.querySelector('[stacks-game]');
    return gm && gm.components && gm.components['stacks-game'];
  }

  window.matchReplayPlayer = {
    playing: false,
    _replay: null,
    _start: 0,
    _eventIdx: 0,
    _frameIdx: 0,
    _matchTimestamp: null,
    _clearBlue: null,
    _clearRed: null,

    play: function (replay) {
      if (!replay) return;
      this.stop();
      this._replay = replay;
      this.playing = true;
      window.replayActive = true;
      this._matchTimestamp = replay.matchTimestamp;
      this._start = performance.now();
      this._eventIdx = 0;
      this._frameIdx = 0;
      var comp = getGame();
      if (comp) {
        if (comp._dualIdleTimer) {
          clearTimeout(comp._dualIdleTimer);
          comp._dualIdleTimer = null;
        }
        if (comp.bot) comp.bot.enable(false);
        if (comp.botBlue) comp.botBlue.enable(false);
        comp._dualBotPreview = false;
        comp.matchActive = false;
        if (comp.cups && comp.cups.blue) comp.cups.blue.clearAll();
        if (comp.cups && comp.cups.red) comp.cups.red.clearAll();
        if (comp.attackSys) comp.attackSys.reset();
        if (comp.modes) {
          comp.modes.scores.blue = 0;
          comp.modes.scores.red = 0;
          // Align mode clock with replay playback so Blitz remaining / elapsed match
          comp.modes.matchStart = Date.now();
          comp.modes.active = false;
        }
        // Station-card Time must follow replay playback, not a stale live match clock
        if (comp.matchStats && comp.matchStats.start) {
          comp.matchStats.start(this._start);
        }
        this._clearBlue = window.StacksClear ? new window.StacksClear() : null;
        this._clearRed = window.StacksClear ? new window.StacksClear() : null;
        this._lastHud = 0;
        if (comp._updateHUD) comp._updateHUD();
        if (comp._updateDamageHUD) comp._updateDamageHUD();
      }
      console.log('[MatchReplay] Playing', replay.matchTimestamp,
        (replay.events && replay.events.length) || 0, 'events');
    },

    elapsedMs: function () {
      if (!this.playing || !this._start) return 0;
      return Math.max(0, performance.now() - this._start);
    },

    stop: function () {
      this.playing = false;
      this._replay = null;
      this._matchTimestamp = null;
      window.replayActive = false;
      var comp = getGame();
      if (comp && typeof comp._scheduleDualIdle === 'function') {
        comp._scheduleDualIdle(400);
      }
    },

    _applyEvent: function (e) {
      var comp = getGame();
      if (!comp || !e || !e.data) return;
      var d = e.data;
      if (e.type === 'place' && d.side && d.cells && comp.cups[d.side]) {
        var cup = comp.cups[d.side];
        var placed = cup.placeCells(d.cells, {
          owner: d.side,
          shapeType: d.type || null
        });
        var clearResult = null;
        if (placed) {
          var clearSys = d.side === 'red' ? this._clearRed : this._clearBlue;
          if (clearSys && clearSys.resolveAfterPlace) {
            clearResult = clearSys.resolveAfterPlace(cup, placed, d.type || null);
          }
        }
        if (d.scores && comp.modes) {
          if (d.scores.blue != null) comp.modes.scores.blue = d.scores.blue;
          if (d.scores.red != null) comp.modes.scores.red = d.scores.red;
        } else if (d.clear && d.clear.score && comp.modes) {
          comp.modes.scores[d.side] = (comp.modes.scores[d.side] | 0) + (d.clear.score | 0);
        }
        if (comp.matchStats) {
          var at = this._start + (e.t | 0);
          var clearForStats = d.clear || clearResult;
          comp.matchStats.onPlace(d.side, clearForStats, at);
          if (d.atk && d.atk.sent > 0) {
            comp.matchStats.onAttack(d.side, d.atk.sent, at);
          }
        }
        if (comp._updateHUD) comp._updateHUD();
        return;
      }
      if (e.type === 'garbage' && d.side && d.layers > 0 && comp.cups[d.side]) {
        if (comp.cups[d.side].spawnGarbageLayers) {
          comp.cups[d.side].spawnGarbageLayers(d.layers | 0, d.holes != null ? d.holes : 1);
        }
        if (comp._updateHUD) comp._updateHUD();
        return;
      }
      if (e.type === 'score' && d && comp.modes) {
        if (d.blue != null) comp.modes.scores.blue = d.blue;
        if (d.red != null) comp.modes.scores.red = d.red;
        if (comp._updateHUD) comp._updateHUD();
      }
    },

    tick: function () {
      if (!this.playing || !this._replay) return;
      var t = performance.now() - this._start;
      var events = this._replay.events || [];
      while (this._eventIdx < events.length && events[this._eventIdx].t <= t) {
        this._applyEvent(events[this._eventIdx++]);
      }
      // Legacy frame path (pre-v2)
      var frames = this._replay.frames || [];
      if (frames.length) {
        while (this._frameIdx < frames.length && frames[this._frameIdx].t <= t) {
          var f = frames[this._frameIdx++];
          var comp = getGame();
          if (comp && f.cups) {
            if (f.cups.blue) comp.cups.blue.applySnapshot(f.cups.blue);
            if (f.cups.red) comp.cups.red.applySnapshot(f.cups.red);
            if (f.scores) {
              comp.modes.scores.blue = f.scores.blue;
              comp.modes.scores.red = f.scores.red;
              comp._updateHUD();
            }
          }
        }
      }
      // Keep Time / rates ticking every ~100ms even between sparse place events
      if (!this._lastHud || performance.now() - this._lastHud > 100) {
        this._lastHud = performance.now();
        var hudComp = getGame();
        if (hudComp) {
          // Pin stats clock to replay t=0 so formatTime == playback elapsed
          if (hudComp.matchStats) {
            if (hudComp.matchStats.blue) hudComp.matchStats.blue._startMs = this._start;
            if (hudComp.matchStats.red) hudComp.matchStats.red._startMs = this._start;
          }
          if (hudComp._updateCupStatsHUD) hudComp._updateCupStatsHUD();
          if (hudComp._updateHUD) hudComp._updateHUD();
        }
      }
      var doneEvents = this._eventIdx >= events.length;
      var doneFrames = !frames.length || this._frameIdx >= frames.length;
      if (doneEvents && doneFrames && t > (this._replay.durationMs || 0) + 600) {
        this.stop();
      }
    }
  };

  window.startMatchReplay = function (ts) {
    if (!window.matchReplayStorage) return;
    window.matchReplayStorage.load(ts).then(function (replay) {
      if (replay && window.matchReplayPlayer) window.matchReplayPlayer.play(replay);
    }).catch(function (err) {
      console.warn('[MatchReplay] load failed', err);
    });
  };

  window.stopMatchReplay = function () {
    if (window.matchReplayPlayer) window.matchReplayPlayer.stop();
  };

  AFRAME.registerComponent('match-replay-ticker', {
    tick: function () {
      if (window.matchReplayPlayer) window.matchReplayPlayer.tick();
    }
  });
})();
