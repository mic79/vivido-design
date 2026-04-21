// motion-recorder.js — Event-driven motion clip recording and playback for bot AI
//
// Recording path:
//   SERVE: idle → ball grabbed → recording_serve → release as serve → serve_followthrough → SAVE
(function () {
  'use strict';

  var STORAGE_KEY = 'dodgevr-motion-clips';
  var SERVE_FOLLOW_MS = 1000;
  var MAX_SERVE_MS = 10000;
  var RING_BUFFER_SIZE = 30;

  function r3(v) { return Math.round(v * 1000) / 1000; }

  if (!window.motionClipLibrary) window.motionClipLibrary = {};
  window.botRecordedMode = false;
  window.botRecordedSubMode = 'random';
  window.clipBrowseIndex = 0;

  // ==================== RECORDER ====================

  window.motionRecorder = {
    _state: 'idle',
    _frames: [],
    _ringBuffer: [],
    _recordStartTime: 0,
    _releaseTime: 0,
    _releaseVelocity: null,
    _releaseAngVelocity: null,
    _prevBg: false,

    recordFrame: function (data) {
      var bg = !!data.bg;
      var wasGrabbed = this._prevBg;
      this._prevBg = bg;

      switch (this._state) {

        case 'idle':
          this._pushToRingBuffer(data);

          if (!wasGrabbed && bg) {
            this._state = 'recording_serve';
            this._frames = this._drainRingBuffer();
            this._recordStartTime = performance.now();
            this._pushFrame(data);
          }
          break;

        case 'recording_serve':
          this._pushFrame(data);

          if (wasGrabbed && !bg) {
            var vel = data.obv;
            if (vel) {
              var speed = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
              if (vel.z > 1 && speed > 2) {
                this._releaseVelocity = { x: r3(vel.x), y: r3(vel.y), z: r3(vel.z) };
                var avel = data.oba;
                this._releaseAngVelocity = avel
                  ? { x: r3(avel.x), y: r3(avel.y), z: r3(avel.z) } : null;
                this._releaseTime = performance.now();
                this._state = 'serve_followthrough';
                break;
              }
            }
            this._state = 'idle';
            this._frames = [];
          } else if (performance.now() - this._recordStartTime > MAX_SERVE_MS) {
            this._state = 'idle';
            this._frames = [];
          }
          break;

        case 'serve_followthrough':
          this._pushFrame(data);
          var ftElapsed = performance.now() - this._releaseTime;
          if (ftElapsed >= SERVE_FOLLOW_MS || (!wasGrabbed && bg)) {
            this._saveClip('serve', this._releaseVelocity, this._releaseAngVelocity);
            this._state = 'idle';
            this._frames = [];
            this._releaseVelocity = null;
            this._releaseAngVelocity = null;
          }
          break;

      }
    },

    // ---- Ring buffer for pre-trigger capture ----

    _pushToRingBuffer: function (data) {
      this._ringBuffer.push({
        t: performance.now(),
        hp: { x: data.hp.x, y: data.hp.y, z: data.hp.z },
        hq: { x: data.hq.x, y: data.hq.y, z: data.hq.z, w: data.hq.w },
        lp: { x: data.lp.x, y: data.lp.y, z: data.lp.z },
        lq: { x: data.lq.x, y: data.lq.y, z: data.lq.z, w: data.lq.w },
        rp: { x: data.rp.x, y: data.rp.y, z: data.rp.z },
        rq: { x: data.rq.x, y: data.rq.y, z: data.rq.z, w: data.rq.w },
        lc: { thumb: data.lc.thumb, index: data.lc.index, middle: data.lc.middle, ring: data.lc.ring, pinky: data.lc.pinky },
        rc: { thumb: data.rc.thumb, index: data.rc.index, middle: data.rc.middle, ring: data.rc.ring, pinky: data.rc.pinky },
        bg: data.bg, bh: data.bh,
        bp: data.bp ? { x: data.bp.x, y: data.bp.y, z: data.bp.z } : null
      });
      while (this._ringBuffer.length > RING_BUFFER_SIZE) {
        this._ringBuffer.shift();
      }
    },

    _drainRingBuffer: function () {
      var frames = [];
      for (var i = 0; i < this._ringBuffer.length; i++) {
        var rb = this._ringBuffer[i];
        frames.push(this._formatFrame(rb.t, rb));
      }
      this._ringBuffer = [];
      return frames;
    },

    // ---- Frame formatting ----

    _formatFrame: function (t, data) {
      return {
        t: t,
        hp: [r3(data.hp.x), r3(data.hp.y), r3(data.hp.z)],
        hq: [r3(data.hq.x), r3(data.hq.y), r3(data.hq.z), r3(data.hq.w)],
        lp: [r3(data.lp.x), r3(data.lp.y), r3(data.lp.z)],
        lq: [r3(data.lq.x), r3(data.lq.y), r3(data.lq.z), r3(data.lq.w)],
        rp: [r3(data.rp.x), r3(data.rp.y), r3(data.rp.z)],
        rq: [r3(data.rq.x), r3(data.rq.y), r3(data.rq.z), r3(data.rq.w)],
        fc: [
          r3(data.lc.thumb), r3(data.lc.index), r3(data.lc.middle), r3(data.lc.ring), r3(data.lc.pinky),
          r3(data.rc.thumb), r3(data.rc.index), r3(data.rc.middle), r3(data.rc.ring), r3(data.rc.pinky)
        ],
        bg: data.bg ? 1 : 0,
        bh: data.bh || 0,
        bp: data.bp ? [r3(data.bp.x), r3(data.bp.y), r3(data.bp.z)] : null
      };
    },

    _pushFrame: function (data) {
      this._frames.push(this._formatFrame(performance.now(), data));
    },

    reset: function () {
      this._state = 'idle';
      this._frames = [];
      this._ringBuffer = [];
      this._releaseVelocity = null;
      this._releaseAngVelocity = null;
      this._prevBg = false;
    },

    // ---- Clip storage ----

    _saveClip: function (tag, releaseVelocity, releaseAngVelocity) {
      if (this._frames.length < 10) return;

      var frames = [];
      var startTime = this._frames[0].t;
      for (var i = 0; i < this._frames.length; i++) {
        var src = this._frames[i];
        frames.push({
          t: Math.round(src.t - startTime),
          hp: src.hp, hq: src.hq,
          lp: src.lp, lq: src.lq,
          rp: src.rp, rq: src.rq,
          fc: src.fc, bg: src.bg, bh: src.bh, bp: src.bp
        });
      }

      var releaseFrame = -1;
      if (tag === 'serve') {
        releaseFrame = frames.length - 1;
        for (var j = frames.length - 1; j > 0; j--) {
          if (frames[j].bg === 0 && frames[j - 1].bg === 1) {
            releaseFrame = j;
            break;
          }
        }
      }

      var clip = {
        tag: tag,
        ts: Date.now(),
        rv: releaseVelocity,
        rav: releaseAngVelocity || null,
        rf: releaseFrame,
        frames: frames
      };

      if (!window.motionClipLibrary[tag]) window.motionClipLibrary[tag] = [];
      window.motionClipLibrary[tag].push(clip);

      this._saveToStorage();
      this._updateClipCountDisplay();

      var duration = (frames[frames.length - 1].t / 1000).toFixed(1);
      console.log('[MotionRecorder] Saved ' + tag + ' clip #' +
        window.motionClipLibrary[tag].length + ' (' + frames.length + ' frames, ' + duration + 's)');

      this._pulseHaptic();
    },

    _pulseHaptic: function () {
      var ids = ['leftHand', 'rightHand'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        if (!el) continue;
        var ctrl = el.components && el.components['tracked-controls'];
        var ha = ctrl && ctrl.controller && ctrl.controller.gamepad &&
          ctrl.controller.gamepad.hapticActuators && ctrl.controller.gamepad.hapticActuators[0];
        if (ha) ha.pulse(0.3, 150).catch(function () {});
      }
    },

    _saveToStorage: function () {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(window.motionClipLibrary));
      } catch (e) {
        console.warn('[MotionRecorder] Storage full, removing oldest clips');
        var lib = window.motionClipLibrary;
        for (var tag in lib) {
          if (lib[tag] && lib[tag].length > 1) lib[tag].shift();
        }
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(lib));
        } catch (e2) {
          console.error('[MotionRecorder] Failed to save:', e2);
        }
      }
    },

    loadFromStorage: function () {
      try {
        var data = localStorage.getItem(STORAGE_KEY);
        if (data) {
          window.motionClipLibrary = JSON.parse(data);
          var counts = this.getClipCounts();
          console.log('[MotionRecorder] Loaded clips:', JSON.stringify(counts));
        }
      } catch (e) {
        console.warn('[MotionRecorder] Failed to load:', e);
        window.motionClipLibrary = {};
      }
    },

    getClipCounts: function () {
      var lib = window.motionClipLibrary || {};
      var counts = {};
      for (var tag in lib) {
        if (lib.hasOwnProperty(tag)) counts[tag] = lib[tag].length;
      }
      return counts;
    },

    _updateClipCountDisplay: function () {
      var counts = this.getClipCounts();
      var el = document.getElementById('menu-clip-count');
      if (el) {
        var total = counts.serve || 0;
        el.setAttribute('text', 'value', 'Clips: ' + total);
        el.setAttribute('visible', total > 0);
      }
    },

    clearClips: function (tag) {
      if (tag) {
        if (window.motionClipLibrary) window.motionClipLibrary[tag] = [];
      } else {
        window.motionClipLibrary = {};
      }
      this._saveToStorage();
      this._updateClipCountDisplay();
      console.log('[MotionRecorder] Clips cleared' + (tag ? ' (' + tag + ')' : ''));
    }
  };

  // ==================== PLAYBACK ====================

  window.motionPlayback = {
    isPlaying: false,
    looping: false,
    currentClip: null,
    currentTag: null,
    clipStartTime: 0,
    _frameIdx: 0,
    _prevBg: false,
    _cachedFrame: null,
    _cachedFrameIdx: -1,

    hasClips: function (tag) {
      var lib = window.motionClipLibrary;
      return lib && lib[tag] && lib[tag].length > 0;
    },

    startClip: function (tag) {
      if (!this.hasClips(tag)) return false;

      var clips = window.motionClipLibrary[tag];
      this.currentClip = clips[Math.floor(Math.random() * clips.length)];
      this.currentTag = tag;
      this.looping = false;
      this._startCurrentClip();

      console.log('[MotionPlayback] Playing ' + tag + ' clip (' +
        this.currentClip.frames.length + ' frames, ' +
        (this.currentClip.frames[this.currentClip.frames.length - 1].t / 1000).toFixed(1) + 's)');
      return true;
    },

    startClipByIndex: function (tag, index) {
      var lib = window.motionClipLibrary;
      if (!lib || !lib[tag] || index < 0 || index >= lib[tag].length) return false;

      this.currentClip = lib[tag][index];
      this.currentTag = tag;
      this.looping = true;
      this._startCurrentClip();

      console.log('[MotionPlayback] Previewing ' + tag + ' clip ' + (index + 1) + '/' + lib[tag].length);
      return true;
    },

    _resetBotBall: function () {
      var botBall = document.querySelector('[simple-grab="player: player1"]');
      if (botBall && botBall.components['simple-grab']) {
        botBall.components['simple-grab'].resetPosition();
      }
    },

    _startCurrentClip: function () {
      this.clipStartTime = performance.now();
      this._frameIdx = 0;
      this._prevBg = false;
      this._cachedFrame = null;
      this._cachedFrameIdx = -1;
      this.isPlaying = true;
      this._resetBotBall();
    },

    getFrame: function () {
      if (!this.isPlaying || !this.currentClip) return null;

      var elapsed = performance.now() - this.clipStartTime;
      var frames = this.currentClip.frames;

      while (this._frameIdx < frames.length - 1 && frames[this._frameIdx + 1].t <= elapsed) {
        this._frameIdx++;
      }

      if (this._frameIdx >= frames.length - 1) {
        if (this.looping) {
          this._resetBotBall();
          this.clipStartTime = performance.now();
          this._frameIdx = 0;
          this._prevBg = false;
          this._cachedFrame = null;
          this._cachedFrameIdx = -1;
          elapsed = 0;
        } else {
          this.isPlaying = false;
          this.currentClip = null;
          this.currentTag = null;
          this._cachedFrame = null;
          return null;
        }
      }

      if (this._frameIdx === this._cachedFrameIdx && this._cachedFrame) {
        return this._cachedFrame;
      }
      this._cachedFrameIdx = this._frameIdx;

      var f1 = frames[this._frameIdx];
      var f2 = frames[Math.min(this._frameIdx + 1, frames.length - 1)];
      var segDur = f2.t - f1.t;
      var t = segDur > 0 ? Math.max(0, Math.min(1, (elapsed - f1.t) / segDur)) : 0;

      var bg = !!f1.bg;
      var justReleased = this._prevBg && !bg;
      this._prevBg = bg;

      this._cachedFrame = {
        hp: lerpArr3(f1.hp, f2.hp, t),
        hq: slerpArr4(f1.hq, f2.hq, t),
        lp: lerpArr3(f1.lp, f2.lp, t),
        lq: slerpArr4(f1.lq, f2.lq, t),
        rp: lerpArr3(f1.rp, f2.rp, t),
        rq: slerpArr4(f1.rq, f2.rq, t),
        fc: f1.fc,
        bg: bg,
        bp: (f1.bp && f2.bp) ? lerpArr3(f1.bp, f2.bp, t) : (f1.bp || null),
        justReleased: justReleased,
        rv: justReleased ? this.currentClip.rv : null,
        rav: justReleased ? this.currentClip.rav : null
      };
      return this._cachedFrame;
    }
  };

  // ==================== MATH HELPERS ====================

  function lerpArr3(a, b, t) {
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t
    ];
  }

  function slerpArr4(a, b, t) {
    var dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    var b2 = b;
    if (dot < 0) {
      b2 = [-b[0], -b[1], -b[2], -b[3]];
      dot = -dot;
    }
    if (dot > 0.9995) {
      return [
        a[0] + (b2[0] - a[0]) * t,
        a[1] + (b2[1] - a[1]) * t,
        a[2] + (b2[2] - a[2]) * t,
        a[3] + (b2[3] - a[3]) * t
      ];
    }
    var theta = Math.acos(Math.min(1, dot));
    var sinTheta = Math.sin(theta);
    var wa = Math.sin((1 - t) * theta) / sinTheta;
    var wb = Math.sin(t * theta) / sinTheta;
    return [
      wa * a[0] + wb * b2[0],
      wa * a[1] + wb * b2[1],
      wa * a[2] + wb * b2[2],
      wa * a[3] + wb * b2[3]
    ];
  }

  // ==================== INIT ====================

  window.motionRecorder.loadFromStorage();
})();
