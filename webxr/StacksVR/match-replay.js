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

  var PLACE_GHOST_MS = 320;
  var PLACE_BLINK_MS = 520;
  var PLACE_BLINK_STEP = 85;

  var REPLAY_BROADCAST_MS = 100;

  function resolveReplayNames(replay) {
    var blue = 'Blue';
    var red = 'Red';
    try {
      var hist = (window.StacksStats && window.StacksStats.loadHistory)
        ? window.StacksStats.loadHistory()
        : { single: [], multi: [] };
      var all = (hist.single || []).concat(hist.multi || []);
      var ts = replay && replay.matchTimestamp;
      for (var i = 0; i < all.length; i++) {
        if (all[i].timestamp === ts) {
          if (all[i].playerName) blue = all[i].playerName;
          else if (window.playerNickname) blue = window.playerNickname;
          red = all[i].opponentName || (all[i].bot ? 'Bot' : red);
          break;
        }
      }
    } catch (e) { /* ignore */ }
    if (blue === 'Blue' && window.playerNickname) blue = window.playerNickname;
    return { blue: blue, red: red };
  }

  function canBroadcastLobbyReplay() {
    return !!(window.isMultiplayer && window.sendReplayMsg &&
      !(window.matchReplayPlayer && window.matchReplayPlayer._remoteOnly));
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
    _placeFx: null,
    _lastBroadcast: 0,
    _remoteOnly: false,
    _sharing: false,

    play: function (replay) {
      if (!replay) return;
      this.stop({ silent: true });
      this._remoteOnly = false;
      this._replay = replay;
      this.playing = true;
      window.replayActive = true;
      window.replaySpectator = false;
      this._matchTimestamp = replay.matchTimestamp;
      this._start = performance.now();
      this._eventIdx = 0;
      this._frameIdx = 0;
      this._placeFx = null;
      this._lastBroadcast = 0;
      var names = resolveReplayNames(replay);
      window._replayNames = names;
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
          comp.modes.matchStart = Date.now();
          comp.modes.active = false;
        }
        if (comp.matchStats && comp.matchStats.start) {
          comp.matchStats.start(this._start);
        }
        this._clearBlue = window.StacksClear ? new window.StacksClear() : null;
        this._clearRed = window.StacksClear ? new window.StacksClear() : null;
        this._lastHud = 0;
        if (comp._updateHUD) comp._updateHUD();
        if (comp._updateDamageHUD) comp._updateDamageHUD();
      }
      // DodgeVR: stream Watch to the whole lobby so everyone sees the same replay
      this._sharing = canBroadcastLobbyReplay();
      if (this._sharing) {
        window.sendReplayMsg({
          type: 'replay-started',
          matchTimestamp: replay.matchTimestamp,
          blueName: names.blue,
          redName: names.red,
          durationMs: replay.durationMs | 0
        });
        this._broadcastState(true);
      }
      console.log('[MatchReplay] Playing', replay.matchTimestamp,
        (replay.events && replay.events.length) || 0, 'events',
        this._sharing ? '(lobby share)' : '');
    },

    elapsedMs: function () {
      if (!this.playing || !this._start) return 0;
      return Math.max(0, performance.now() - this._start);
    },

    _broadcastState: function (force) {
      if (!this._sharing || !window.sendReplayMsg) return;
      var now = performance.now();
      if (!force && now - this._lastBroadcast < REPLAY_BROADCAST_MS) return;
      this._lastBroadcast = now;
      var comp = getGame();
      if (!comp || !comp.cups) return;
      var t = this.elapsedMs();
      var rem = Math.max(0, (this._replay && this._replay.durationMs | 0) - t);
      var mins = Math.floor(rem / 60000);
      var secs = Math.floor((rem % 60000) / 1000);
      var timerText = 'REPLAY  ' + mins + ':' + (secs < 10 ? '0' : '') + secs;
      var scores = comp.modes
        ? { blue: comp.modes.scores.blue | 0, red: comp.modes.scores.red | 0 }
        : { blue: 0, red: 0 };
      window.sendReplayMsg({
        type: 'replay-state',
        t: Math.round(t),
        timerText: timerText,
        scores: scores,
        cups: {
          blue: comp.cups.blue.serialize(),
          red: comp.cups.red.serialize()
        }
      });
    },

    stop: function (opts) {
      opts = opts || {};
      var wasSharing = this._sharing && !this._remoteOnly;
      this._finishPlaceFx(true);
      this.playing = false;
      this._replay = null;
      this._matchTimestamp = null;
      this._placeFx = null;
      this._sharing = false;
      this._remoteOnly = false;
      window.replayActive = false;
      if (wasSharing && !opts.silent && window.sendReplayMsg && window.isMultiplayer) {
        window.sendReplayMsg({ type: 'replay-ended' });
      }
      if (!opts.silent && !opts.keepIdle) {
        var comp = getGame();
        if (comp && typeof comp._scheduleDualIdle === 'function') {
          comp._scheduleDualIdle(400);
        }
      }
    },

    _removeGhostGroup: function (fx) {
      if (!fx || !fx.ghostGroup) return;
      if (fx.ghostGroup.parent) fx.ghostGroup.parent.remove(fx.ghostGroup);
      fx.ghostGroup.traverse(function (o) {
        if (o.isMesh) {
          if (o.material) o.material.dispose();
        }
      });
      fx.ghostGroup = null;
    },

    _makeGhostGroup: function (cup, cells) {
      if (!cup || !cells || !cells.length || !THREE) return null;
      var group = new THREE.Group();
      group.name = 'replay-place-ghost';
      var geo = (window.StacksShapes && window.StacksShapes.roundedBlockGeo)
        ? window.StacksShapes.roundedBlockGeo()
        : new THREE.BoxGeometry(0.11, 0.11, 0.11);
      var mat = new THREE.MeshBasicMaterial({
        color: 0x69F0AE,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        toneMapped: false
      });
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        var x = c[0] != null ? c[0] : c.x;
        var y = c[1] != null ? c[1] : c.y;
        var z = c[2] != null ? c[2] : c.z;
        var mesh = new THREE.Mesh(geo, mat.clone());
        mesh.renderOrder = 12;
        if (cup.cellCenterLocal) {
          mesh.position.copy(cup.cellCenterLocal(x, y, z));
        } else {
          var cs = cup.cellSize || 0.12;
          mesh.position.set((x + 0.5) * cs, (y + 0.5) * cs, (z + 0.5) * cs);
        }
        group.add(mesh);
      }
      (cup.blocksRoot || cup.root).add(group);
      return group;
    },

    _beginPlaceFx: function (e) {
      var comp = getGame();
      var d = e && e.data;
      if (!comp || !d || !d.side || !d.cells || !comp.cups[d.side]) {
        this._applyPlaceCommit(e);
        return;
      }
      this._finishPlaceFx(true);
      var cup = comp.cups[d.side];
      this._placeFx = {
        event: e,
        side: d.side,
        cells: d.cells,
        type: d.type || null,
        phase: 'ghost',
        t0: performance.now(),
        ghostGroup: this._makeGhostGroup(cup, d.cells),
        placed: null
      };
    },

    /** Commit board place + clear popup / chime / stats (instant / ghost-flush path). */
    _applyPlaceCommit: function (e, placedOpt) {
      var comp = getGame();
      if (!comp || !e || !e.data) return;
      var d = e.data;
      var cup = comp.cups[d.side];
      if (!cup) return;
      var placed = placedOpt;
      if (!placed) {
        placed = cup.placeCells(d.cells, {
          owner: d.side,
          shapeType: d.type || null
        });
      }
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
      // Trigger clear/combo callout + chime from live logic (not stored as video)
      var popupClear = clearResult || d.clear;
      if (popupClear && (popupClear.layersCleared | 0) > 0) {
        if (typeof comp._showClearPopup === 'function') {
          comp._showClearPopup(d.side, popupClear, d.atk || null);
        }
        if (window.StacksAudio && typeof window.StacksAudio.clearChime === 'function') {
          window.StacksAudio.clearChime(popupClear.layersCleared | 0, 0.5);
        }
      }
      if (comp._updateHUD) comp._updateHUD();
    },

    _finishPlaceFx: function (instant) {
      var fx = this._placeFx;
      if (!fx) return;
      this._removeGhostGroup(fx);
      if (fx.phase === 'ghost' || (fx.phase === 'blink' && !fx.placed)) {
        this._applyPlaceCommit(fx.event);
      } else if (fx.phase === 'blink' && fx.placed) {
        // Clear was deferred until blink end — commit clear side now
        this._applyPlaceCommitAfterBlink(fx);
      }
      this._placeFx = null;
      if (instant) { /* no-op */ }
    },

    _applyPlaceCommitAfterBlink: function (fx) {
      var e = fx.event;
      var d = e && e.data;
      var comp = getGame();
      if (!comp || !d) return;
      var cup = comp.cups[d.side];
      var clearResult = null;
      if (fx.placed && cup) {
        var clearSys = d.side === 'red' ? this._clearRed : this._clearBlue;
        if (clearSys && clearSys.resolveAfterPlace) {
          clearResult = clearSys.resolveAfterPlace(cup, fx.placed, d.type || null);
        }
      }
      if (d.scores && comp.modes) {
        if (d.scores.blue != null) comp.modes.scores.blue = d.scores.blue;
        if (d.scores.red != null) comp.modes.scores.red = d.scores.red;
      }
      if (comp.matchStats) {
        var at = this._start + ((e && e.t) | 0);
        var clearForStats = d.clear || clearResult;
        comp.matchStats.onPlace(d.side, clearForStats, at);
        if (d.atk && d.atk.sent > 0) {
          comp.matchStats.onAttack(d.side, d.atk.sent, at);
        }
      }
      var popupClear = clearResult || d.clear;
      if (popupClear && (popupClear.layersCleared | 0) > 0) {
        if (typeof comp._showClearPopup === 'function') {
          comp._showClearPopup(d.side, popupClear, d.atk || null);
        }
        if (window.StacksAudio && typeof window.StacksAudio.clearChime === 'function') {
          window.StacksAudio.clearChime(popupClear.layersCleared | 0, 0.5);
        }
      }
      if (comp._updateHUD) comp._updateHUD();
    },

    _tickPlaceFx: function () {
      var fx = this._placeFx;
      if (!fx) return;
      var now = performance.now();
      var elapsed = now - fx.t0;
      var comp = getGame();
      var cup = comp && comp.cups[fx.side];

      if (fx.phase === 'ghost') {
        if (elapsed < PLACE_GHOST_MS) return;
        this._removeGhostGroup(fx);
        if (!cup) {
          this._applyPlaceCommit(fx.event);
          this._placeFx = null;
          return;
        }
        var placed = cup.placeCells(fx.cells, {
          owner: fx.side,
          shapeType: fx.type || null
        });
        fx.placed = placed;
        fx.phase = 'blink';
        fx.t0 = now;
        if (comp && typeof comp._startBlockBlink === 'function') {
          comp._startBlockBlink(placed, { stepMs: PLACE_BLINK_STEP, durationMs: PLACE_BLINK_MS });
        }
        return;
      }

      if (fx.phase === 'blink') {
        if (elapsed < PLACE_BLINK_MS) return;
        this._applyPlaceCommitAfterBlink(fx);
        this._placeFx = null;
      }
    },

    _applyEvent: function (e) {
      var comp = getGame();
      if (!comp || !e || !e.data) return;
      var d = e.data;
      if (e.type === 'place' && d.side && d.cells && comp.cups[d.side]) {
        this._beginPlaceFx(e);
        return;
      }
      if (e.type === 'garbage' && d.side && d.layers > 0 && comp.cups[d.side]) {
        if (comp.cups[d.side].spawnGarbageLayers) {
          var gLayers = comp.cups[d.side].spawnGarbageLayers(
            d.layers | 0, d.holes != null ? d.holes : 1);
          var gSpawned = [];
          if (gLayers && gLayers.length) {
            for (var gi = 0; gi < gLayers.length; gi++) {
              if (gLayers[gi].cells) {
                for (var gj = 0; gj < gLayers[gi].cells.length; gj++) {
                  gSpawned.push(gLayers[gi].cells[gj]);
                }
              }
            }
          }
          if (gSpawned.length && typeof comp._startBlockBlink === 'function') {
            comp._startBlockBlink(gSpawned, { garbage: true });
          }
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
      // Advance place ghost→blink→clear before pulling more events
      if (this._placeFx) this._tickPlaceFx();

      var t = performance.now() - this._start;
      var events = this._replay.events || [];
      var applied = false;
      while (!this._placeFx && this._eventIdx < events.length && events[this._eventIdx].t <= t) {
        this._applyEvent(events[this._eventIdx++]);
        applied = true;
      }

      var frames = this._replay.frames || [];
      if (frames.length && !this._placeFx) {
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
            applied = true;
          }
        }
      }

      if (!this._lastHud || performance.now() - this._lastHud > 100) {
        this._lastHud = performance.now();
        var hudComp = getGame();
        if (hudComp) {
          if (hudComp.matchStats) {
            if (hudComp.matchStats.blue) hudComp.matchStats.blue._startMs = this._start;
            if (hudComp.matchStats.red) hudComp.matchStats.red._startMs = this._start;
          }
          if (hudComp._updateCupStatsHUD) hudComp._updateCupStatsHUD();
          if (hudComp._updateHUD) hudComp._updateHUD();
        }
      }

      // Stream board to lobby peers (DodgeVR replay-state)
      if (this._sharing) this._broadcastState(applied);

      var doneEvents = this._eventIdx >= events.length && !this._placeFx;
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
