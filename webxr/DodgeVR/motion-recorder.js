// motion-recorder.js — Records player motion clips during mirror mode and plays them back for bot AI
(function () {
  'use strict';

  var STORAGE_KEY = 'dodgevr-motion-clips';
  var BUFFER_DURATION_MS = 3000;

  function r3(v) { return Math.round(v * 1000) / 1000; }

  if (!window.motionClipLibrary) window.motionClipLibrary = {};
  window.botRecordedMode = false;

  // ==================== RECORDER ====================

  window.motionRecorder = {
    frameBuffer: [],
    _prevBallGrabbed: false,

    captureFrame: function (data) {
      var now = performance.now();
      this.frameBuffer.push({
        t: now,
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
        bg: data.bg ? 1 : 0
      });

      while (this.frameBuffer.length > 1 && now - this.frameBuffer[0].t > BUFFER_DURATION_MS) {
        this.frameBuffer.shift();
      }
    },

    checkServe: function (ballVelocity) {
      if (this.frameBuffer.length === 0) return false;
      var isGrabbed = !!this.frameBuffer[this.frameBuffer.length - 1].bg;
      var wasGrabbed = this._prevBallGrabbed;
      this._prevBallGrabbed = isGrabbed;

      if (wasGrabbed && !isGrabbed && ballVelocity) {
        var speed = Math.sqrt(ballVelocity.x * ballVelocity.x + ballVelocity.y * ballVelocity.y + ballVelocity.z * ballVelocity.z);
        if (ballVelocity.z > 1 && speed > 2) {
          this._saveClip('serve', {
            x: r3(ballVelocity.x),
            y: r3(ballVelocity.y),
            z: r3(ballVelocity.z)
          });
          return true;
        }
      }
      return false;
    },

    _saveClip: function (tag, releaseVelocity) {
      if (this.frameBuffer.length < 10) return;

      var frames = [];
      var startTime = this.frameBuffer[0].t;
      for (var i = 0; i < this.frameBuffer.length; i++) {
        var src = this.frameBuffer[i];
        var f = {
          t: Math.round(src.t - startTime),
          hp: src.hp, hq: src.hq,
          lp: src.lp, lq: src.lq,
          rp: src.rp, rq: src.rq,
          fc: src.fc, bg: src.bg
        };
        frames.push(f);
      }

      var releaseFrame = frames.length - 1;
      for (var j = frames.length - 1; j > 0; j--) {
        if (frames[j].bg === 0 && frames[j - 1].bg === 1) {
          releaseFrame = j;
          break;
        }
      }

      var clip = {
        tag: tag,
        ts: Date.now(),
        rv: releaseVelocity,
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
        el.setAttribute('text', 'value', 'Clips: S:' + (counts.serve || 0));
        el.setAttribute('visible', true);
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
    currentClip: null,
    clipStartTime: 0,
    _frameIdx: 0,
    _prevBg: false,

    hasClips: function (tag) {
      var lib = window.motionClipLibrary;
      return lib && lib[tag] && lib[tag].length > 0;
    },

    startClip: function (tag) {
      if (!this.hasClips(tag)) return false;

      var clips = window.motionClipLibrary[tag];
      this.currentClip = clips[Math.floor(Math.random() * clips.length)];
      this.clipStartTime = performance.now();
      this._frameIdx = 0;
      this._prevBg = false;
      this.isPlaying = true;

      var botBall = document.querySelector('[simple-grab="player: player1"]');
      if (botBall && botBall.components['simple-grab']) {
        botBall.components['simple-grab'].resetPosition();
      }

      console.log('[MotionPlayback] Playing ' + tag + ' clip (' +
        this.currentClip.frames.length + ' frames, ' +
        (this.currentClip.frames[this.currentClip.frames.length - 1].t / 1000).toFixed(1) + 's)');
      return true;
    },

    getFrame: function () {
      if (!this.isPlaying || !this.currentClip) return null;

      var elapsed = performance.now() - this.clipStartTime;
      var frames = this.currentClip.frames;

      while (this._frameIdx < frames.length - 1 && frames[this._frameIdx + 1].t <= elapsed) {
        this._frameIdx++;
      }

      if (this._frameIdx >= frames.length - 1) {
        this.isPlaying = false;
        this.currentClip = null;
        return null;
      }

      var f1 = frames[this._frameIdx];
      var f2 = frames[this._frameIdx + 1];
      var segDur = f2.t - f1.t;
      var t = segDur > 0 ? Math.max(0, Math.min(1, (elapsed - f1.t) / segDur)) : 0;

      var bg = !!f1.bg;
      var justReleased = this._prevBg && !bg;
      this._prevBg = bg;

      return {
        hp: lerpArr3(f1.hp, f2.hp, t),
        hq: slerpArr4(f1.hq, f2.hq, t),
        lp: lerpArr3(f1.lp, f2.lp, t),
        lq: slerpArr4(f1.lq, f2.lq, t),
        rp: lerpArr3(f1.rp, f2.rp, t),
        rq: slerpArr4(f1.rq, f2.rq, t),
        fc: f1.fc,
        bg: bg,
        justReleased: justReleased,
        rv: justReleased ? this.currentClip.rv : null
      };
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
