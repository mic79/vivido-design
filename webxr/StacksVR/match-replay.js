// match-replay.js — events-only replay for StacksVR
// DodgeVR can sample every frame because each frame is ~70 floats (delta-encoded).
// StacksVR used to dump full cup JSON grids @10Hz offline — that ballooned to
// multi-MB and froze Quest on IndexedDB save at match end. Never do that again.
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
      var toDelete = all.filter(function (ts) { return keepTimestamps.indexOf(ts) < 0; });
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

    // Intentionally empty: cup snapshots @10Hz froze Quest on bot-win IDB save.
    // Events (place/clear) are enough for history; board replay needs a compact
    // binary format like DodgeVR before we sample frames again.
    tick: function () {},

    /** Stop capturing immediately (O(1)). Call takeReplay later off the win frame. */
    stopCapture: function () {
      if (!this.isRecording && !this._events.length) return;
      if (this.isRecording) {
        this._durationMs = Math.round(performance.now() - this._startTime);
      }
      this.isRecording = false;
    },

    /** Package events into a lightweight replay object. Safe after stopCapture. */
    takeReplay: function () {
      this.isRecording = false;
      if (!this._events.length && !this._durationMs) return null;
      var replay = {
        matchTimestamp: this._matchTimestamp,
        version: 2,
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

    /** Back-compat: stop + package (prefer stopCapture + deferred takeReplay). */
    stopRecording: function () {
      this.stopCapture();
      return this.takeReplay();
    }
  };

  window.matchReplayPlayer = {
    playing: false,
    _replay: null,
    _start: 0,
    _eventIdx: 0,
    _frameIdx: 0,

    play: function (replay) {
      this._replay = replay;
      this.playing = true;
      this._start = performance.now();
      this._eventIdx = 0;
      this._frameIdx = 0;
      var gm = document.querySelector('[stacks-game]');
      var comp = gm && gm.components && gm.components['stacks-game'];
      if (comp) {
        comp.cups.blue.clearAll();
        comp.cups.red.clearAll();
      }
      console.log('[MatchReplay] Playing replay', replay.matchTimestamp);
    },

    stop: function () {
      this.playing = false;
      this._replay = null;
    },

    tick: function () {
      if (!this.playing || !this._replay) return;
      var t = performance.now() - this._start;
      var frames = this._replay.frames || [];
      while (this._frameIdx < frames.length && frames[this._frameIdx].t <= t) {
        var f = frames[this._frameIdx++];
        var gm = document.querySelector('[stacks-game]');
        var comp = gm && gm.components && gm.components['stacks-game'];
        if (comp && f.cups) {
          if (f.cups.blue) comp.cups.blue.applySnapshot(f.cups.blue);
          if (f.cups.red) comp.cups.red.applySnapshot(f.cups.red);
          if (f.scores) {
            comp.modes.scores.blue = f.scores.blue;
            comp.modes.scores.red = f.scores.red;
            comp._updateHUD();
          }
          if (f.attack) {
            comp.attackSys.applySerialized(f.attack);
            comp._updateDamageHUD();
          }
        }
      }
      if (this._frameIdx >= frames.length && t > (this._replay.durationMs || 0) + 500) {
        this.stop();
      }
    }
  };

  AFRAME.registerComponent('match-replay-ticker', {
    tick: function () {
      if (window.matchReplayPlayer) window.matchReplayPlayer.tick();
    }
  });
})();
