// match-replay.js — stack-event + dual-cup replay for StacksVR
(function () {
  'use strict';

  var DB_NAME = 'stacksvr-replays';
  var DB_VERSION = 1;
  var STORE_NAME = 'replays';
  var SAMPLE_RATE = 10;
  var SAMPLE_INTERVAL = 1000 / SAMPLE_RATE;

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
    _frames: [],
    _startTime: 0,
    _lastSampleTime: 0,
    _matchTimestamp: 0,

    startRecording: function (matchTimestamp) {
      this._events = [];
      this._frames = [];
      this._startTime = performance.now();
      this._lastSampleTime = -SAMPLE_INTERVAL;
      this._matchTimestamp = matchTimestamp || Date.now();
      this.isRecording = true;
    },

    recordEvent: function (type, data) {
      if (!this.isRecording) return;
      this._events.push({
        t: Math.round(performance.now() - this._startTime),
        type: type,
        data: data
      });
    },

    tick: function () {
      if (!this.isRecording) return;
      var now = performance.now();
      var elapsed = now - this._startTime;
      if (elapsed - this._lastSampleTime < SAMPLE_INTERVAL) return;
      this._lastSampleTime = elapsed;

      var gm = document.querySelector('[stacks-game]');
      var comp = gm && gm.components && gm.components['stacks-game'];
      var frame = {
        t: Math.round(elapsed),
        scores: comp ? { blue: comp.modes.scores.blue, red: comp.modes.scores.red } : null,
        attack: comp ? comp.attackSys.serialize() : null,
        cups: null,
        pose: null
      };
      if (comp && comp.cups.blue && comp.cups.red) {
        frame.cups = {
          blue: comp.cups.blue.serialize(),
          red: comp.cups.red.serialize()
        };
      }
      var cam = document.querySelector('[camera]');
      if (cam) {
        var p = new THREE.Vector3(), q = new THREE.Quaternion();
        cam.object3D.getWorldPosition(p);
        cam.object3D.getWorldQuaternion(q);
        frame.pose = { head: { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w } };
      }
      this._frames.push(frame);
    },

    stopRecording: function () {
      if (!this.isRecording) return null;
      this.isRecording = false;
      var replay = {
        matchTimestamp: this._matchTimestamp,
        version: 1,
        kind: 'stacksvr',
        events: this._events,
        frames: this._frames,
        durationMs: Math.round(performance.now() - this._startTime)
      };
      this._events = [];
      this._frames = [];
      console.log('[MatchReplay] Saved', replay.frames.length, 'frames', replay.events.length, 'events');
      return replay;
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
