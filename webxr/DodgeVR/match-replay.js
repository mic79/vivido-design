// match-replay.js — Match recording & replay system for DodgeVR
// Records both players + both balls at 20 Hz with delta encoding, stores in IndexedDB
(function () {
  'use strict';

  var DB_NAME = 'dodgevr-replays';
  var DB_VERSION = 1;
  var STORE_NAME = 'replays';
  var SAMPLE_RATE = 20;
  var SAMPLE_INTERVAL = 1000 / SAMPLE_RATE;
  var KEYFRAME_EVERY = 20; // full keyframe every 20 samples (1 second)
  // Frame layout: 69 values
  // [0]      timestamp (ms from match start)
  // [1-7]    blue head:  px py pz qx qy qz qw
  // [8-14]   blue left:  px py pz qx qy qz qw
  // [15-21]  blue right: px py pz qx qy qz qw
  // [22-28]  red head:   px py pz qx qy qz qw
  // [29-35]  red left:   px py pz qx qy qz qw
  // [36-42]  red right:  px py pz qx qy qz qw
  // [43-55]  blue ball:  px py pz vx vy vz ax ay az qx qy qz qw
  // [56-68]  red ball:   px py pz vx vy vz ax ay az qx qy qz qw
  var FV = 69;

  function r3(v) { return Math.round(v * 1000) / 1000; }

  // ==================== IndexedDB ====================

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

  // ==================== RECORDER ====================

  window.matchRecorder = {
    isRecording: false,
    _rawFrames: [],
    _startTime: 0,
    _lastSampleTime: 0,
    _matchTimestamp: 0,
    _events: [],
    _lastBlueScore: 0,
    _lastRedScore: 0,
    _cam: null,
    _lh: null,
    _rh: null,
    _botBody: null,
    _blueBall: null,
    _redBall: null,

    startRecording: function (matchTimestamp) {
      this._rawFrames = [];
      this._events = [];
      this._startTime = performance.now();
      this._lastSampleTime = -SAMPLE_INTERVAL; // capture first frame immediately
      this._matchTimestamp = matchTimestamp || Date.now();
      this._lastBlueScore = 0;
      this._lastRedScore = 0;
      this._cam = document.querySelector('[camera]');
      this._lh = document.getElementById('leftHand');
      this._rh = document.getElementById('rightHand');
      this._botBody = document.getElementById('bot-body');
      this._blueBall = document.querySelector('[simple-grab="player: player2"]');
      this._redBall = document.querySelector('[simple-grab="player: player1"]');
      this.isRecording = true;
      console.log('[MatchReplay] Recording started');
    },

    recordEvent: function (type, data) {
      if (!this.isRecording) return;
      this._events.push({ t: Math.round(performance.now() - this._startTime), type: type, data: data });
    },

    tick: function () {
      if (!this.isRecording) return;
      var now = performance.now();
      var elapsed = now - this._startTime;
      if (elapsed - this._lastSampleTime < SAMPLE_INTERVAL) return;
      this._lastSampleTime = elapsed;
      var f = this._captureFrame(elapsed);
      if (f) this._rawFrames.push(f);
      this._checkScoreChange();
    },

    _checkScoreChange: function () {
      var gmEl = document.querySelector('#game-manager');
      var gm = gmEl && gmEl.components && gmEl.components['game-manager'];
      if (!gm) return;
      var blue, red;
      if (window.isMultiplayer && !window.isLobbyBotMatch) {
        var ms = window.multiplayerScore;
        blue = ms ? ms.local : 0;
        red = ms ? ms.remote : 0;
      } else {
        blue = gm.playerScore || 0;
        red = gm.botScore || 0;
      }
      if (blue !== this._lastBlueScore || red !== this._lastRedScore) {
        this._lastBlueScore = blue;
        this._lastRedScore = red;
        this.recordEvent('score', { blue: blue, red: red });
      }
    },

    _captureFrame: function (elapsed) {
      var f = new Array(FV);
      f[0] = Math.round(elapsed);

      // Blue player (local human)
      this._writePlayerState(f, 1, this._cam, this._lh, this._rh);

      // Red player (bot/remote) — read from bot-body's last applied pose
      var mb = this._botBody && this._botBody.components && this._botBody.components['mixamo-body'];
      if (mb && mb._lastAppliedPose) {
        var p = mb._lastAppliedPose;
        f[22] = r3(p.headPos.x); f[23] = r3(p.headPos.y); f[24] = r3(p.headPos.z);
        f[25] = r3(p.headQuat.x); f[26] = r3(p.headQuat.y); f[27] = r3(p.headQuat.z); f[28] = r3(p.headQuat.w);
        f[29] = r3(p.leftPos.x); f[30] = r3(p.leftPos.y); f[31] = r3(p.leftPos.z);
        f[32] = r3(p.leftQuat.x); f[33] = r3(p.leftQuat.y); f[34] = r3(p.leftQuat.z); f[35] = r3(p.leftQuat.w);
        f[36] = r3(p.rightPos.x); f[37] = r3(p.rightPos.y); f[38] = r3(p.rightPos.z);
        f[39] = r3(p.rightQuat.x); f[40] = r3(p.rightQuat.y); f[41] = r3(p.rightQuat.z); f[42] = r3(p.rightQuat.w);
      } else if (mb && mb.remoteHandData) {
        var rd = mb.remoteHandData;
        f[22] = r3(rd.head.x); f[23] = r3(rd.head.y); f[24] = r3(rd.head.z);
        f[25] = r3(rd.head.qx || 0); f[26] = r3(rd.head.qy || 0); f[27] = r3(rd.head.qz || 0); f[28] = r3(rd.head.qw || 1);
        var lh = rd.leftHand;
        if (lh) { f[29]=r3(lh.x); f[30]=r3(lh.y); f[31]=r3(lh.z); f[32]=r3(lh.qx); f[33]=r3(lh.qy); f[34]=r3(lh.qz); f[35]=r3(lh.qw); }
        else { f[29]=0; f[30]=1.1; f[31]=-5.75; f[32]=0; f[33]=0; f[34]=0; f[35]=1; }
        var rh = rd.rightHand;
        if (rh) { f[36]=r3(rh.x); f[37]=r3(rh.y); f[38]=r3(rh.z); f[39]=r3(rh.qx); f[40]=r3(rh.qy); f[41]=r3(rh.qz); f[42]=r3(rh.qw); }
        else { f[36]=0; f[37]=1.1; f[38]=-5.75; f[39]=0; f[40]=0; f[41]=0; f[42]=1; }
      } else {
        f[22]=0; f[23]=1.9; f[24]=-6;
        f[25]=0; f[26]=0; f[27]=0; f[28]=1;
        f[29]=0.3; f[30]=1.1; f[31]=-5.75; f[32]=0; f[33]=0; f[34]=0; f[35]=1;
        f[36]=-0.3; f[37]=1.1; f[38]=-5.75; f[39]=0; f[40]=0; f[41]=0; f[42]=1;
      }

      // Blue ball
      this._writeBallState(f, 43, this._blueBall);
      // Red ball
      this._writeBallState(f, 56, this._redBall);

      return f;
    },

    _writePlayerState: function (f, off, camEl, lhEl, rhEl) {
      var wp = new THREE.Vector3();
      var wq = new THREE.Quaternion();
      if (camEl) {
        camEl.object3D.getWorldPosition(wp); camEl.object3D.getWorldQuaternion(wq);
        f[off]=r3(wp.x); f[off+1]=r3(wp.y); f[off+2]=r3(wp.z);
        f[off+3]=r3(wq.x); f[off+4]=r3(wq.y); f[off+5]=r3(wq.z); f[off+6]=r3(wq.w);
      } else {
        f[off]=0; f[off+1]=1.6; f[off+2]=6; f[off+3]=0; f[off+4]=0; f[off+5]=0; f[off+6]=1;
      }
      if (lhEl) {
        lhEl.object3D.getWorldPosition(wp); lhEl.object3D.getWorldQuaternion(wq);
        f[off+7]=r3(wp.x); f[off+8]=r3(wp.y); f[off+9]=r3(wp.z);
        f[off+10]=r3(wq.x); f[off+11]=r3(wq.y); f[off+12]=r3(wq.z); f[off+13]=r3(wq.w);
      } else {
        f[off+7]=0.3; f[off+8]=1.1; f[off+9]=5.75; f[off+10]=0; f[off+11]=0; f[off+12]=0; f[off+13]=1;
      }
      if (rhEl) {
        rhEl.object3D.getWorldPosition(wp); rhEl.object3D.getWorldQuaternion(wq);
        f[off+14]=r3(wp.x); f[off+15]=r3(wp.y); f[off+16]=r3(wp.z);
        f[off+17]=r3(wq.x); f[off+18]=r3(wq.y); f[off+19]=r3(wq.z); f[off+20]=r3(wq.w);
      } else {
        f[off+14]=-0.3; f[off+15]=1.1; f[off+16]=5.75; f[off+17]=0; f[off+18]=0; f[off+19]=0; f[off+20]=1;
      }
    },

    _writeBallState: function (f, off, ballEl) {
      var g = ballEl && ballEl.components && ballEl.components['simple-grab'];
      if (g && g.body) {
        var b = g.body;
        f[off]=r3(b.position.x); f[off+1]=r3(b.position.y); f[off+2]=r3(b.position.z);
        f[off+3]=r3(b.velocity.x); f[off+4]=r3(b.velocity.y); f[off+5]=r3(b.velocity.z);
        f[off+6]=r3(b.angularVelocity.x); f[off+7]=r3(b.angularVelocity.y); f[off+8]=r3(b.angularVelocity.z);
        f[off+9]=r3(b.quaternion.x); f[off+10]=r3(b.quaternion.y); f[off+11]=r3(b.quaternion.z); f[off+12]=r3(b.quaternion.w);
      } else {
        for (var i = 0; i < 12; i++) f[off + i] = 0;
        f[off + 12] = 1;
      }
    },

    stopRecording: function () {
      if (!this.isRecording) return null;
      this.isRecording = false;
      var frames = this._rawFrames;
      if (frames.length < 10) {
        console.log('[MatchReplay] Too few frames (' + frames.length + '), discarding');
        this._rawFrames = [];
        return null;
      }
      var encoded = this._deltaEncode(frames);
      var replay = {
        matchTimestamp: this._matchTimestamp,
        duration: frames[frames.length - 1][0],
        sampleRate: SAMPLE_RATE,
        frames: encoded,
        events: this._events
      };
      var rawSize = JSON.stringify(replay).length;
      console.log('[MatchReplay] Saved: ' + frames.length + ' frames, ' +
        Math.round(replay.duration / 1000) + 's, ~' + Math.round(rawSize / 1024) + ' KB');
      this._rawFrames = [];
      this._events = [];
      return replay;
    },

    _deltaEncode: function (frames) {
      var result = [];
      for (var i = 0; i < frames.length; i++) {
        if (i % KEYFRAME_EVERY === 0) {
          var kf = [1];
          for (var j = 0; j < FV; j++) kf.push(frames[i][j]);
          result.push(kf);
        } else {
          var df = [0, frames[i][0] - frames[i - 1][0]];
          for (var k = 1; k < FV; k++) df.push(r3(frames[i][k] - frames[i - 1][k]));
          result.push(df);
        }
      }
      return result;
    }
  };

  // ==================== REPLAY ENGINE ====================

  // Cached output frame to avoid per-tick allocation
  function makeBodyData() {
    return {
      head: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      leftHand: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      rightHand: { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
    };
  }
  function makeBallData() {
    return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  }
  var _cf = { blue: makeBodyData(), red: makeBodyData(), blueBall: makeBallData(), redBall: makeBallData(), elapsed: 0 };

  window.replayEngine = {
    isPlaying: false,
    isPaused: false,
    playbackSpeed: 1.0,
    _decoded: null,
    _events: null,
    _startTime: 0,
    _pauseTime: 0,
    _pauseAccum: 0,
    _frameIdx: 0,
    _duration: 0,
    _eventIdx: 0,
    _matchTimestamp: 0,
    _onEnd: null,

    startReplay: function (replay, onEnd) {
      if (!replay || !replay.frames || replay.frames.length === 0) return false;
      this._decoded = deltaDecode(replay.frames);
      this._events = replay.events || [];
      this._duration = replay.duration;
      this._matchTimestamp = replay.matchTimestamp;
      this._startTime = performance.now();
      this._pauseAccum = 0;
      this._frameIdx = 0;
      this._eventIdx = 0;
      this._onEnd = onEnd || null;
      this.isPlaying = true;
      this.isPaused = false;
      this.playbackSpeed = 1.0;
      console.log('[MatchReplay] Replay playing: ' + this._decoded.length + ' frames, ' +
        Math.round(this._duration / 1000) + 's');
      return true;
    },

    stopReplay: function () {
      var was = this.isPlaying;
      this.isPlaying = false;
      this.isPaused = false;
      this._decoded = null;
      this._events = null;
      return was;
    },

    togglePause: function () {
      if (!this.isPlaying) return;
      if (this.isPaused) {
        this._pauseAccum += performance.now() - this._pauseTime;
        this.isPaused = false;
      } else {
        this._pauseTime = performance.now();
        this.isPaused = true;
      }
    },

    getElapsed: function () {
      if (!this.isPlaying) return 0;
      var now = this.isPaused ? this._pauseTime : performance.now();
      return (now - this._startTime - this._pauseAccum) * this.playbackSpeed;
    },

    getProgress: function () {
      return this._duration > 0 ? Math.min(1, this.getElapsed() / this._duration) : 0;
    },

    getFrame: function () {
      if (!this.isPlaying || this.isPaused || !this._decoded) return null;
      var elapsed = this.getElapsed();
      var frames = this._decoded;

      while (this._frameIdx < frames.length - 1 && frames[this._frameIdx + 1][0] <= elapsed) {
        this._frameIdx++;
      }

      if (this._frameIdx >= frames.length - 1) {
        this.isPlaying = false;
        if (this._onEnd) this._onEnd();
        return null;
      }

      var f1 = frames[this._frameIdx];
      var f2 = frames[Math.min(this._frameIdx + 1, frames.length - 1)];
      var seg = f2[0] - f1[0];
      var t = seg > 0 ? Math.max(0, Math.min(1, (elapsed - f1[0]) / seg)) : 0;

      fillBody(_cf.blue, f1, f2, t, 1);
      fillBody(_cf.red, f1, f2, t, 22);
      fillBall(_cf.blueBall, f1, f2, t, 43);
      fillBall(_cf.redBall, f1, f2, t, 56);
      _cf.elapsed = elapsed;
      return _cf;
    },

    getPendingEvents: function () {
      if (!this.isPlaying || !this._events) return null;
      var elapsed = this.getElapsed();
      var first = -1, last = -1;
      while (this._eventIdx < this._events.length && this._events[this._eventIdx].t <= elapsed) {
        if (first < 0) first = this._eventIdx;
        last = this._eventIdx;
        this._eventIdx++;
      }
      return first >= 0 ? this._events.slice(first, last + 1) : null;
    }
  };

  // ==================== FRAME INTERPOLATION ====================

  function lp(a, b, t) { return a + (b - a) * t; }

  function nlerpQ(h, f1, f2, t, i) {
    var dot = f1[i] * f2[i] + f1[i + 1] * f2[i + 1] + f1[i + 2] * f2[i + 2] + f1[i + 3] * f2[i + 3];
    var s = dot < 0 ? -1 : 1;
    var x = f1[i] + (s * f2[i] - f1[i]) * t;
    var y = f1[i + 1] + (s * f2[i + 1] - f1[i + 1]) * t;
    var z = f1[i + 2] + (s * f2[i + 2] - f1[i + 2]) * t;
    var w = f1[i + 3] + (s * f2[i + 3] - f1[i + 3]) * t;
    var len = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
    h.qx = x / len; h.qy = y / len; h.qz = z / len; h.qw = w / len;
  }

  function fillBody(bd, f1, f2, t, off) {
    var h = bd.head;
    h.x = lp(f1[off], f2[off], t);
    h.y = lp(f1[off + 1], f2[off + 1], t);
    h.z = lp(f1[off + 2], f2[off + 2], t);
    nlerpQ(h, f1, f2, t, off + 3);

    var l = bd.leftHand;
    l.x = lp(f1[off + 7], f2[off + 7], t);
    l.y = lp(f1[off + 8], f2[off + 8], t);
    l.z = lp(f1[off + 9], f2[off + 9], t);
    nlerpQ(l, f1, f2, t, off + 10);

    var r = bd.rightHand;
    r.x = lp(f1[off + 14], f2[off + 14], t);
    r.y = lp(f1[off + 15], f2[off + 15], t);
    r.z = lp(f1[off + 16], f2[off + 16], t);
    nlerpQ(r, f1, f2, t, off + 17);
  }

  function fillBall(bl, f1, f2, t, off) {
    bl.x = lp(f1[off], f2[off], t);
    bl.y = lp(f1[off + 1], f2[off + 1], t);
    bl.z = lp(f1[off + 2], f2[off + 2], t);
    bl.vx = lp(f1[off + 3], f2[off + 3], t);
    bl.vy = lp(f1[off + 4], f2[off + 4], t);
    bl.vz = lp(f1[off + 5], f2[off + 5], t);
    bl.ax = lp(f1[off + 6], f2[off + 6], t);
    bl.ay = lp(f1[off + 7], f2[off + 7], t);
    bl.az = lp(f1[off + 8], f2[off + 8], t);
    nlerpQ(bl, f1, f2, t, off + 9);
  }

  // ==================== DELTA DECODE ====================

  function deltaDecode(encoded) {
    var decoded = [];
    var prev = null;
    for (var i = 0; i < encoded.length; i++) {
      var enc = encoded[i];
      if (enc[0] === 1) {
        var frame = enc.slice(1);
        decoded.push(frame);
        prev = frame;
      } else {
        if (!prev) continue;
        var frame2 = new Array(FV);
        frame2[0] = prev[0] + enc[1];
        for (var j = 1; j < FV; j++) frame2[j] = prev[j] + enc[j + 1];
        decoded.push(frame2);
        prev = frame2;
      }
    }
    return decoded;
  }

  // ==================== REPLAY RENDERING ====================

  window.replayActive = false;

  // Saved player position/rotation to restore after singleplayer replay
  var _savedPlayerPos = null;
  var _savedRigRotation = null;

  // Per-ball respawn visual state during replay
  var _replayRespawns = { player1: null, player2: null };
  // Per-ball stage tracking during replay
  var _replayStages = { player1: 1, player2: 1 };
  // Racket visibility state during replay
  var _replayRackets = {
    player1: { left: false, right: false },
    player2: { left: false, right: false }
  };
  // Last broadcast score during replay (for computing hitPlayer delta)
  var _replayBroadcastScore = { blue: 0, red: 0 };
  // Throttle replay broadcast to match recording sample rate (20Hz)
  var _lastReplayBroadcastTime = 0;
  var RESPAWN_FADE_OUT = 500;
  var RESPAWN_FADE_IN = 500;
  var RESPAWN_TOTAL = RESPAWN_FADE_OUT + RESPAWN_FADE_IN;

  function applyReplayRespawnVisuals(ballEl, playerKey, elapsed) {
    var rs = _replayRespawns[playerKey];
    if (!rs) return;
    var dt = elapsed - rs.startTime;
    if (dt >= RESPAWN_TOTAL) {
      _replayRespawns[playerKey] = null;
      ballEl.object3D.scale.setScalar(window.getStageBallScale ? window.getStageBallScale(_replayStages[playerKey]) : 1);
      setReplayBallOpacity(ballEl, 1);
      return;
    }
    var stage = _replayStages[playerKey];
    var baseScale = window.getStageBallScale ? window.getStageBallScale(stage) : 1;
    if (dt < RESPAWN_FADE_OUT) {
      var p = dt / RESPAWN_FADE_OUT;
      var eased = 1 - (1 - p) * (1 - p); // easeOutQuad
      var s = baseScale * (1 - eased * 0.5);
      ballEl.object3D.scale.setScalar(s);
      setReplayBallOpacity(ballEl, 1 - eased);
    } else {
      var p2 = (dt - RESPAWN_FADE_OUT) / RESPAWN_FADE_IN;
      var eased2 = 1 - (1 - p2) * (1 - p2);
      var s2 = baseScale * (0.5 + eased2 * 0.5);
      ballEl.object3D.scale.setScalar(s2);
      setReplayBallOpacity(ballEl, eased2);
    }
  }

  function setReplayBallOpacity(ballEl, opacity) {
    ballEl.object3D.traverse(function (child) {
      if (child.material) {
        child.material.opacity = opacity;
        child.material.transparent = opacity < 1;
      }
    });
    var lightEl = ballEl.querySelector && ballEl.querySelector('[light]');
    if (lightEl) {
      var lc = lightEl.components && lightEl.components.light;
      if (lc && lc.light) lc.light.intensity = 1.5 * opacity;
    }
  }

  window.startMatchReplay = function (matchTimestamp) {
    if (window.replayActive) window.stopMatchReplay();

    loadReplay(matchTimestamp).then(function (replay) {
      if (!replay) {
        console.warn('[MatchReplay] No replay found for', matchTimestamp);
        return;
      }

      window.replayActive = true;

      // Disable bot AI
      var botEl = document.querySelector('[advanced-bot]');
      if (botEl) botEl.setAttribute('advanced-bot', 'enabled', false);

      // Disable ball interaction
      var blueBall = document.querySelector('[simple-grab="player: player2"]');
      if (blueBall && blueBall.components['simple-grab']) {
        blueBall.components['simple-grab'].spectatorMode = true;
      }

      // Move player to spectator position to watch the replay
      var playerEl = document.getElementById('player');
      var rigEl = document.getElementById('rig');
      if (playerEl) {
        var curPos = playerEl.getAttribute('position');
        _savedPlayerPos = { x: curPos.x, y: curPos.y, z: curPos.z };
        _savedRigRotation = rigEl ? rigEl.getAttribute('rotation') : { x: 0, y: 0, z: 0 };
        playerEl.setAttribute('position', '-4 0 3');
        if (rigEl) rigEl.setAttribute('rotation', '0 -53 0');
        var pc = playerEl.components['player-collision'];
        if (pc && pc.body) {
          pc.body.position.set(-4, 1.0, 3);
          pc.body.velocity.set(0, 0, 0);
        }
      }

      // Make both player bodies visible
      var botBody = document.querySelector('#bot-body');
      var blueBody = document.getElementById('spectator-blue-body');
      if (botBody) botBody.object3D.visible = true;
      if (blueBody) { blueBody.setAttribute('visible', true); blueBody.object3D.visible = true; }

      // Show score/timer
      var scoreDisplay = document.getElementById('score-display');
      var timerDisplay = document.getElementById('timer-display');
      var startMessage = document.getElementById('start-message');
      if (scoreDisplay) scoreDisplay.object3D.visible = true;
      if (timerDisplay) timerDisplay.object3D.visible = true;
      if (startMessage) startMessage.object3D.visible = false;

      var blueScoreEl = document.getElementById('blue-score');
      var redScoreEl = document.getElementById('red-score');
      if (blueScoreEl) blueScoreEl.setAttribute('text', 'value', '0');
      if (redScoreEl) redScoreEl.setAttribute('text', 'value', '0');

      // Show player name labels from match history
      var history = window.loadMatchHistory ? window.loadMatchHistory() : { single: [], multi: [] };
      var allMatches = history.single.concat(history.multi);
      var matchRecord = null;
      for (var i = 0; i < allMatches.length; i++) {
        if (allMatches[i].timestamp === matchTimestamp) { matchRecord = allMatches[i]; break; }
      }
      var blueName = document.getElementById('spectator-blue-name');
      var redName = document.getElementById('spectator-red-name');
      if (blueName) { blueName.setAttribute('text', 'value', 'You'); blueName.object3D.visible = true; }
      if (redName) {
        redName.setAttribute('text', 'value', matchRecord ? (matchRecord.opponentName || 'Bot') : 'Bot');
        redName.object3D.visible = true;
      }

      if (timerDisplay) timerDisplay.setAttribute('text', 'value', 'REPLAY');

      // For multiplayer: pause arena bots and notify spectators
      var isMP = window.isMultiplayer && window.isHost;
      if (isMP && window.arenaBots) {
        window._replayPrevArenaState = {
          redActive: window.arenaBots.redBotActive,
          blueActive: window.arenaBots.blueBotActive
        };
        window.arenaBots.redBotActive = false;
        window.arenaBots.blueBotActive = false;
        var abBotEl = document.querySelector('[advanced-bot]');
        if (abBotEl) abBotEl.setAttribute('advanced-bot', 'enabled', false);
        // Activate spectator view on all connected clients
        var conns = window.connections;
        if (conns) {
          var replayMP = { blue: '__replay_blue__', red: '__replay_red__' };
          for (var ci = 0; ci < conns.length; ci++) {
            if (conns[ci].conn.open) {
              conns[ci].conn.send({
                type: 'match-started',
                matchPlayers: replayMP,
                startTime: Date.now()
              });
            }
          }
        }
      }

      // Reset replay state tracking
      _replayRespawns.player1 = null;
      _replayRespawns.player2 = null;
      _replayStages.player1 = 1;
      _replayStages.player2 = 1;
      _replayRackets.player1.left = false; _replayRackets.player1.right = false;
      _replayRackets.player2.left = false; _replayRackets.player2.right = false;
      _replayBroadcastScore.blue = 0;
      _replayBroadcastScore.red = 0;
      _lastReplayBroadcastTime = 0;

      // Reset ball scales and opacity to default
      var allBalls = [blueBall, document.querySelector('[simple-grab="player: player1"]')];
      for (var bi = 0; bi < allBalls.length; bi++) {
        if (allBalls[bi]) {
          allBalls[bi].object3D.scale.setScalar(1);
          setReplayBallOpacity(allBalls[bi], 1);
        }
      }

      window.replayEngine.startReplay(replay, function () {
        window.stopMatchReplay();
      });

      console.log('[MatchReplay] Replay started for match', matchTimestamp);
    }).catch(function (e) {
      console.error('[MatchReplay] Failed to load replay:', e);
    });
  };

  window.stopMatchReplay = function () {
    if (!window.replayActive) return;
    window.replayActive = false;
    window.replayEngine.stopReplay();

    // Re-enable bot
    var botEl = document.querySelector('[advanced-bot]');
    if (botEl && !window.isMultiplayer) {
      botEl.object3D.position.set(0, 1.6, -6);
      botEl.setAttribute('advanced-bot', 'enabled', true);
    }

    // Re-enable ball interaction
    var blueBall = document.querySelector('[simple-grab="player: player2"]');
    if (blueBall && blueBall.components['simple-grab']) {
      blueBall.components['simple-grab'].spectatorMode = false;
    }

    // In singleplayer, move player back to arena position
    // In multiplayer, stay at spectator position (player must re-queue to rejoin arena)
    if (!window.isMultiplayer) {
      var playerEl = document.getElementById('player');
      var rigEl = document.getElementById('rig');
      if (playerEl) {
        if (_savedPlayerPos) {
          playerEl.setAttribute('position', _savedPlayerPos.x + ' ' + _savedPlayerPos.y + ' ' + _savedPlayerPos.z);
        } else {
          playerEl.setAttribute('position', '0 0 6');
        }
        if (rigEl) {
          if (_savedRigRotation) {
            rigEl.setAttribute('rotation', _savedRigRotation.x + ' ' + _savedRigRotation.y + ' ' + _savedRigRotation.z);
          } else {
            rigEl.setAttribute('rotation', '0 0 0');
          }
        }
        var pc = playerEl.components['player-collision'];
        if (pc && pc.body) {
          var px = _savedPlayerPos ? _savedPlayerPos.x : 0;
          var pz = _savedPlayerPos ? _savedPlayerPos.z : 6;
          pc.body.position.set(px, 1.0, pz);
          pc.body.velocity.set(0, 0, 0);
        }
      }
    }
    _savedPlayerPos = null;
    _savedRigRotation = null;

    // Reset ball positions, scales, and opacity
    var bb = blueBall && blueBall.components['simple-grab'];
    if (bb) bb.resetPosition();
    if (blueBall) {
      blueBall.object3D.scale.setScalar(1);
      setReplayBallOpacity(blueBall, 1);
    }
    var redBall = document.querySelector('[simple-grab="player: player1"]');
    var rb = redBall && redBall.components['simple-grab'];
    if (rb) rb.resetPosition();
    if (redBall) {
      redBall.object3D.scale.setScalar(1);
      setReplayBallOpacity(redBall, 1);
    }
    _replayRespawns.player1 = null;
    _replayRespawns.player2 = null;
    _replayStages.player1 = 1;
    _replayStages.player2 = 1;
    _replayRackets.player1.left = false; _replayRackets.player1.right = false;
    _replayRackets.player2.left = false; _replayRackets.player2.right = false;

    // Hide bot rackets
    var botBodyStop = document.querySelector('#bot-body');
    var bbComp = botBodyStop && botBodyStop.components && botBodyStop.components['mixamo-body'];
    if (bbComp && bbComp.botRackets) {
      bbComp.botRackets.left.visible = false;
      bbComp.botRackets.right.visible = false;
    }
    var blueBodyStop = document.getElementById('spectator-blue-body');
    var sbComp = blueBodyStop && blueBodyStop.components && blueBodyStop.components['mixamo-body'];
    if (sbComp && sbComp.botRackets) {
      sbComp.botRackets.left.visible = false;
      sbComp.botRackets.right.visible = false;
    }

    // Hide blue body (only used for spectator/replay)
    var blueBody = document.getElementById('spectator-blue-body');
    if (blueBody && !window.isMultiplayer) {
      blueBody.setAttribute('visible', false);
      if (blueBody.components['mixamo-body']) blueBody.components['mixamo-body'].remoteHandData = null;
    }

    // Reset bot body
    var botBody = document.querySelector('#bot-body');
    if (botBody && botBody.components['mixamo-body']) {
      botBody.components['mixamo-body'].remoteHandData = null;
    }

    // Hide name labels
    var blueName = document.getElementById('spectator-blue-name');
    var redName = document.getElementById('spectator-red-name');
    if (blueName) blueName.object3D.visible = false;
    if (redName) redName.object3D.visible = false;

    // Hide score/timer
    var gmEl = document.querySelector('#game-manager');
    var gm = gmEl && gmEl.components && gmEl.components['game-manager'];
    if (gm && gm.matchState !== 'PLAYING' && gm.matchState !== 'OVERTIME') {
      var sd = document.getElementById('score-display');
      var td = document.getElementById('timer-display');
      if (sd) sd.object3D.visible = false;
      if (td) td.object3D.visible = false;
    }

    // Restore arena bots in multiplayer and notify spectators
    // Player stays at spectator position, so both arena bot slots should be active
    if (window.isMultiplayer && window.isHost && window.arenaBots) {
      window.arenaBots.setSlotHuman('blue', false);
      window.arenaBots.setSlotHuman('red', false);
      window._replayPrevArenaState = null;
      // Notify spectators that the replay/match ended
      var conns = window.connections;
      if (conns) {
        for (var ci = 0; ci < conns.length; ci++) {
          if (conns[ci].conn.open) {
            conns[ci].conn.send({ type: 'match-ended', winner: 'Replay ended' });
          }
        }
      }
    }

    console.log('[MatchReplay] Replay stopped');
  };

  // Called every tick from multiplayer-sync to render replay
  window.tickReplay = function () {
    if (!window.replayActive || !window.replayEngine.isPlaying) return;
    var frame = window.replayEngine.getFrame();
    if (!frame) return;

    // Blue player body
    var blueBody = document.getElementById('spectator-blue-body');
    if (blueBody && blueBody.components['mixamo-body']) {
      blueBody.components['mixamo-body'].remoteHandData = frame.blue;
    }

    // Red player body
    var botBody = document.querySelector('#bot-body');
    if (botBody) botBody.object3D.visible = true;
    if (botBody && botBody.components['mixamo-body']) {
      botBody.components['mixamo-body'].remoteHandData = frame.red;
    }

    // Blue ball
    var blueBallEl = document.querySelector('[simple-grab="player: player2"]');
    if (blueBallEl) {
      var fb = frame.blueBall;
      blueBallEl.object3D.position.set(fb.x, fb.y, fb.z);
      blueBallEl.object3D.quaternion.set(fb.qx, fb.qy, fb.qz, fb.qw);
      var bg = blueBallEl.components['simple-grab'];
      if (bg && bg.body) {
        bg.body.position.set(fb.x, fb.y, fb.z);
        bg.body.velocity.set(0, 0, 0);
        bg.body.angularVelocity.set(fb.ax, fb.ay, fb.az);
        bg.body.quaternion.set(fb.qx, fb.qy, fb.qz, fb.qw);
      }
    }

    // Red ball
    var redBallEl = document.querySelector('[simple-grab="player: player1"]');
    if (redBallEl) {
      var fr = frame.redBall;
      redBallEl.object3D.position.set(fr.x, fr.y, fr.z);
      redBallEl.object3D.quaternion.set(fr.qx, fr.qy, fr.qz, fr.qw);
      var rg = redBallEl.components['simple-grab'];
      if (rg && rg.body) {
        rg.body.position.set(fr.x, fr.y, fr.z);
        rg.body.velocity.set(0, 0, 0);
        rg.body.angularVelocity.set(fr.ax, fr.ay, fr.az);
        rg.body.quaternion.set(fr.qx, fr.qy, fr.qz, fr.qw);
      }
    }

    // Process events (score updates, hit explosions, respawns, stages)
    var elapsed = window.replayEngine.getElapsed();
    var events = window.replayEngine.getPendingEvents();
    if (events) {
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (ev.type === 'score') {
          var bsEl = document.getElementById('blue-score');
          var rsEl = document.getElementById('red-score');
          if (bsEl) bsEl.setAttribute('text', 'value', ev.data.blue.toString());
          if (rsEl) rsEl.setAttribute('text', 'value', ev.data.red.toString());
          // Broadcast to spectators so mobile/VR spectators see score updates + hit effects
          if (window.isMultiplayer && window.isHost && window.connections) {
            var hitPlayer = null;
            if (ev.data.blue > _replayBroadcastScore.blue) hitPlayer = 'red';
            else if (ev.data.red > _replayBroadcastScore.red) hitPlayer = 'blue';
            _replayBroadcastScore.blue = ev.data.blue;
            _replayBroadcastScore.red = ev.data.red;
            var scoreMsg = { type: 'spectator-score', blueScore: ev.data.blue, redScore: ev.data.red, hitPlayer: hitPlayer };
            var conns = window.connections;
            for (var si = 0; si < conns.length; si++) {
              if (conns[si].conn.open) conns[si].conn.send(scoreMsg);
            }
          }
        } else if (ev.type === 'hit') {
          if (ev.data.player === 'red') {
            var bt = document.querySelector('#bot-target');
            if (bt && bt.components['impact-effect']) bt.components['impact-effect'].playEffect();
          } else if (ev.data.player === 'blue') {
            var sbh = document.getElementById('spectator-blue-hit');
            if (sbh) {
              if (frame && frame.blue && frame.blue.head) {
                sbh.object3D.position.set(frame.blue.head.x, frame.blue.head.y || 1.6, frame.blue.head.z);
              }
              if (sbh.components['impact-effect']) sbh.components['impact-effect'].playEffect();
            }
          }
        } else if (ev.type === 'respawn') {
          _replayRespawns[ev.data.player] = { startTime: elapsed };
        } else if (ev.type === 'stage') {
          _replayStages[ev.data.player] = ev.data.stage;
          var stBallEl = ev.data.player === 'player2' ? blueBallEl : redBallEl;
          if (stBallEl) {
            var stScale = window.getStageBallScale ? window.getStageBallScale(ev.data.stage) : 1;
            stBallEl.object3D.scale.setScalar(stScale);
          }
        } else if (ev.type === 'racket') {
          _replayRackets[ev.data.player][ev.data.hand] = ev.data.active;
        }
      }
    }

    // Apply racket visibility on both player bodies
    var blueBodyComp = blueBody && blueBody.components && blueBody.components['mixamo-body'];
    if (blueBodyComp && blueBodyComp.botRackets) {
      blueBodyComp.botRackets.left.visible = _replayRackets.player2.left;
      blueBodyComp.botRackets.right.visible = _replayRackets.player2.right;
    }
    var botBodyComp = botBody && botBody.components && botBody.components['mixamo-body'];
    if (botBodyComp && botBodyComp.botRackets) {
      botBodyComp.botRackets.left.visible = _replayRackets.player1.left;
      botBodyComp.botRackets.right.visible = _replayRackets.player1.right;
    }

    // Apply per-ball respawn visual effects (fade-out/fade-in)
    if (blueBallEl) applyReplayRespawnVisuals(blueBallEl, 'player2', elapsed);
    if (redBallEl) applyReplayRespawnVisuals(redBallEl, 'player1', elapsed);

    // Position name labels above player heads, facing the camera
    var camEl = document.querySelector('[camera]');
    if (camEl) {
      var camPos = camEl.object3D.getWorldPosition(new THREE.Vector3());
      var bnEl = document.getElementById('spectator-blue-name');
      if (bnEl && frame.blue) {
        var bx = frame.blue.head.x, by = (frame.blue.head.y || 1.6) + 0.5, bz = frame.blue.head.z;
        bnEl.object3D.position.set(bx, by, bz);
        bnEl.object3D.rotation.y = Math.atan2(camPos.x - bx, camPos.z - bz);
      }
      var rnEl = document.getElementById('spectator-red-name');
      if (rnEl && frame.red) {
        var rx = frame.red.head.x, ry = (frame.red.head.y || 1.6) + 0.5, rz = frame.red.head.z;
        rnEl.object3D.position.set(rx, ry, rz);
        rnEl.object3D.rotation.y = Math.atan2(camPos.x - rx, camPos.z - rz);
      }
    }

    // Update timer display
    var remaining = Math.max(0, window.replayEngine._duration - elapsed);
    var mins = Math.floor(remaining / 60000);
    var secs = Math.floor((remaining % 60000) / 1000);
    var timerEl = document.getElementById('timer-display');
    if (timerEl) {
      timerEl.setAttribute('text', 'value', 'REPLAY  ' + mins + ':' + (secs < 10 ? '0' : '') + secs);
    }

    // In multiplayer, broadcast replay state to spectators (throttled to 20Hz to avoid data channel overflow)
    if (window.isMultiplayer && window.isHost && window.connections) {
      var now = performance.now();
      if (now - _lastReplayBroadcastTime >= SAMPLE_INTERVAL) {
        _lastReplayBroadcastTime = now;
        broadcastReplayToSpectators(frame);
      }
    }
  };

  // Broadcast replay frame data to multiplayer spectators using the spectator message format
  function broadcastReplayToSpectators(frame) {
    var conns = window.connections;
    if (!conns || conns.length === 0) return;

    // Convert red player from world space to "sender perspective" (un-mirror for spectator view)
    var rh = frame.red.head;
    var rlh = frame.red.leftHand;
    var rrh = frame.red.rightHand;
    // Un-mirror quaternion: premultiply with yFlip(0,1,0,0) → (qz, qw, -qx, -qy)
    var redState = {
      x: -rh.x, y: rh.y, z: -rh.z,
      hqx: rh.qz, hqy: rh.qw, hqz: -rh.qx, hqw: -rh.qy,
      lhx: -rlh.x, lhy: rlh.y, lhz: -rlh.z,
      lhqx: rlh.qz, lhqy: rlh.qw, lhqz: -rlh.qx, lhqw: -rlh.qy,
      rhx: -rrh.x, rhy: rrh.y, rhz: -rrh.z,
      rhqx: rrh.qz, rhqy: rrh.qw, rhqz: -rrh.qx, rhqw: -rrh.qy
    };

    // Blue player: no conversion needed
    var bh = frame.blue.head;
    var blh = frame.blue.leftHand;
    var brh = frame.blue.rightHand;
    var blueState = {
      x: bh.x, y: bh.y, z: bh.z,
      hqx: bh.qx, hqy: bh.qy, hqz: bh.qz, hqw: bh.qw,
      lhx: blh.x, lhy: blh.y, lhz: blh.z,
      lhqx: blh.qx, lhqy: blh.qy, lhqz: blh.qz, lhqw: blh.qw,
      rhx: brh.x, rhy: brh.y, rhz: brh.z,
      rhqx: brh.qx, rhqy: brh.qy, rhqz: brh.qz, rhqw: brh.qw
    };

    // Un-mirror red ball
    var rb = frame.redBall;
    var rbqFlip = { x: rb.qz, y: rb.qw, z: -rb.qx, w: -rb.qy };
    var redBallState = {
      x: -rb.x, y: rb.y, z: -rb.z,
      vx: -rb.vx, vy: rb.vy, vz: -rb.vz,
      ax: -rb.ax, ay: rb.ay, az: -rb.az,
      qx: rbqFlip.x, qy: rbqFlip.y, qz: rbqFlip.z, qw: rbqFlip.w
    };

    // Blue ball: no conversion
    var bb = frame.blueBall;
    var blueBallState = {
      x: bb.x, y: bb.y, z: bb.z,
      vx: bb.vx, vy: bb.vy, vz: bb.vz,
      ax: bb.ax, ay: bb.ay, az: bb.az,
      qx: bb.qx, qy: bb.qy, qz: bb.qz, qw: bb.qw
    };

    for (var i = 0; i < conns.length; i++) {
      if (!conns[i].conn.open) continue;
      conns[i].conn.send({ type: 'spectator-player', fromId: '__replay_blue__', state: blueState });
      conns[i].conn.send({ type: 'spectator-player', fromId: '__replay_red__', state: redState });
      conns[i].conn.send({ type: 'spectator-ball', fromId: '__replay_blue__', state: blueBallState });
      conns[i].conn.send({ type: 'spectator-ball', fromId: '__replay_red__', state: redBallState });
    }
  }

  // ==================== INIT ====================

  openDB().then(function () {
    console.log('[MatchReplay] IndexedDB ready');
  }).catch(function (e) {
    console.warn('[MatchReplay] IndexedDB unavailable:', e);
  });

  window.matchReplayStorage = {
    save: saveReplay,
    load: loadReplay,
    remove: deleteReplay,
    listTimestamps: listReplayTimestamps,
    pruneOld: pruneOldReplays
  };
})();
