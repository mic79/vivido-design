// stacks-audio.js — music + SFX for StacksVR (DodgeVR sound-manager pattern)
// Line-clear uses Web Audio (Dotmination Howler pattern) — A-Frame sound pools
// were silently failing / still tied to the old explosion asset.
(function (global) {
  'use strict';

  var _unlocked = false;
  var _fadeTickers = {};
  var _clearBuf = null;
  var _clearBufLoading = null;
  var CLEAR_URL = 'audio/dotmination-clear.mp3';

  function el(id) {
    return document.getElementById(id);
  }

  function soundComp(node) {
    return node && node.components && node.components.sound;
  }

  function getAudioCtx() {
    var scene = document.querySelector('a-scene');
    var ctx = scene && scene.audioListener && scene.audioListener.context;
    if (!ctx && scene && scene.audioContext) ctx = scene.audioContext;
    if (!ctx && global.AudioContext) {
      try { ctx = new AudioContext(); } catch (e) { /* ignore */ }
    }
    return ctx || null;
  }

  function setVolume(node, vol) {
    var sc = soundComp(node);
    if (!sc || !sc.pool || !sc.pool.children) return;
    for (var i = 0; i < sc.pool.children.length; i++) {
      sc.pool.children[i].setVolume(vol);
    }
  }

  function setPlaybackRate(node, rate) {
    var sc = soundComp(node);
    if (!sc || !sc.pool || !sc.pool.children) return;
    var r = (rate != null && isFinite(rate)) ? Math.max(0.4, Math.min(2.5, rate)) : 1;
    for (var i = 0; i < sc.pool.children.length; i++) {
      var child = sc.pool.children[i];
      if (child && typeof child.setPlaybackRate === 'function') {
        try { child.setPlaybackRate(r); } catch (e) { /* ignore */ }
      }
    }
  }

  function isPlaying(node) {
    var sc = soundComp(node);
    if (!sc || !sc.pool || !sc.pool.children) return false;
    for (var i = 0; i < sc.pool.children.length; i++) {
      if (sc.pool.children[i].isPlaying) return true;
    }
    return false;
  }

  function ensureClearBuffer() {
    if (_clearBuf) return Promise.resolve(_clearBuf);
    if (_clearBufLoading) return _clearBufLoading;
    var ctx = getAudioCtx();
    if (!ctx || typeof fetch !== 'function') {
      return Promise.reject(new Error('no audio ctx'));
    }
    _clearBufLoading = fetch(CLEAR_URL, { cache: 'force-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('clear fetch ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (ab) {
        return new Promise(function (resolve, reject) {
          ctx.decodeAudioData(ab.slice(0), resolve, reject);
        });
      })
      .then(function (buf) {
        _clearBuf = buf;
        _clearBufLoading = null;
        return buf;
      })
      .catch(function (err) {
        _clearBufLoading = null;
        console.warn('[StacksAudio] clear buffer load failed', err);
        throw err;
      });
    return _clearBufLoading;
  }

  // Dotmination showIncrementAnimation / chainReactionCounter:
  // each overtake plays one sonar at basePitch + i * pitchStep, then counter++.
  // Classic chain steps use ~0.1s delayedCall between increments.
  var CLEAR_BASE_PITCH = 1.0;
  var CLEAR_PITCH_STEP = 0.05;
  var CLEAR_STEP_S = 0.1;
  var CLEAR_MAX_TONES = 8;

  /**
   * Play Dotmination-style rising sequence: 1 line → pitch 0 only;
   * 2 lines → pitch 0 then pitch 1; etc. Never a single "final" pitch alone.
   */
  function playClearChime(layers, volume) {
    if (AudioApi.sfxEnabled === false) return;
    resumeCtx();
    var ctx = getAudioCtx();
    if (!ctx) return;
    var n = Math.max(1, Math.min(CLEAR_MAX_TONES, layers | 0));
    var vol = volume != null ? volume : 0.45;

    function fireSequence(buf) {
      try {
        if (ctx.state === 'suspended') ctx.resume();
        var t0 = ctx.currentTime;
        for (var i = 0; i < n; i++) {
          var rate = CLEAR_BASE_PITCH + i * CLEAR_PITCH_STEP;
          var src = ctx.createBufferSource();
          src.buffer = buf;
          src.playbackRate.value = rate;
          var gain = ctx.createGain();
          gain.gain.value = vol;
          src.connect(gain);
          gain.connect(ctx.destination);
          src.start(t0 + i * CLEAR_STEP_S);
        }
      } catch (e) {
        console.warn('[StacksAudio] clearChime play failed', e);
      }
    }

    function fireSequenceFallback() {
      // A-Frame path: schedule each tone (no recurse into clearChime)
      var node = el('sfx-clear');
      var sc = soundComp(node);
      if (!sc) return;
      var i = 0;
      function step() {
        if (i >= n) return;
        try {
          setVolume(node, vol);
          setPlaybackRate(node, CLEAR_BASE_PITCH + i * CLEAR_PITCH_STEP);
          sc.stopSound();
          sc.playSound();
        } catch (e2) { /* ignore */ }
        i++;
        if (i < n) setTimeout(step, CLEAR_STEP_S * 1000);
      }
      step();
    }

    if (_clearBuf) {
      fireSequence(_clearBuf);
      return;
    }
    ensureClearBuffer().then(fireSequence).catch(fireSequenceFallback);
  }

  function fadeSound(node, fromVol, toVol, durationMs, onDone) {
    if (!node || !node.id) return;
    if (_fadeTickers[node.id]) clearInterval(_fadeTickers[node.id]);
    var steps = 24;
    var stepMs = Math.max(16, (durationMs || 1200) / steps);
    var current = fromVol;
    var delta = (toVol - fromVol) / steps;
    var count = 0;
    _fadeTickers[node.id] = setInterval(function () {
      count++;
      current += delta;
      if (count >= steps) {
        current = toVol;
        clearInterval(_fadeTickers[node.id]);
        delete _fadeTickers[node.id];
        if (onDone) onDone();
      }
      setVolume(node, Math.max(0, current));
    }, stepMs);
  }

  function resumeCtx() {
    var scene = document.querySelector('a-scene');
    var ctx = scene && scene.audioListener && scene.audioListener.context;
    if (!ctx && scene && scene.audioContext) ctx = scene.audioContext;
    if (ctx && ctx.state === 'suspended') {
      try { ctx.resume(); } catch (e) { /* ignore */ }
    }
  }

  var STORAGE_KEY = 'stacksvr-music-enabled';

  function loadMusicPref() {
    try {
      var v = localStorage.getItem(STORAGE_KEY);
      if (v === '0' || v === 'false') return false;
      if (v === '1' || v === 'true') return true;
    } catch (e) { /* ignore */ }
    return true;
  }

  function saveMusicPref(on) {
    try { localStorage.setItem(STORAGE_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function stopAllMusic() {
    ['sfx-bg-music', 'sfx-match-music'].forEach(function (id) {
      if (_fadeTickers[id]) {
        clearInterval(_fadeTickers[id]);
        delete _fadeTickers[id];
      }
      var node = el(id);
      var sc = soundComp(node);
      if (sc) {
        try { sc.stopSound(); } catch (e) { /* ignore */ }
      }
      setVolume(node, 0);
    });
  }

  var AudioApi = {
    // Keep beds under dialogue/SFX — users reported prior 0.28/0.32 as too loud
    bgVol: 0.12,
    matchVol: 0.14,
    sfxEnabled: true,
    musicEnabled: loadMusicPref(),

    isMusicEnabled: function () {
      return AudioApi.musicEnabled !== false && global._musicEnabled !== false;
    },

    setMusicEnabled: function (on) {
      on = !!on;
      AudioApi.musicEnabled = on;
      global._musicEnabled = on;
      saveMusicPref(on);
      if (!on) {
        stopAllMusic();
        return;
      }
      // Resume whichever bed fits current state
      AudioApi.unlock();
      if (global._stacksMatchMusic) AudioApi.toMatch();
      else AudioApi.toIdle();
    },

    toggleMusic: function () {
      AudioApi.setMusicEnabled(!AudioApi.isMusicEnabled());
      return AudioApi.isMusicEnabled();
    },

    unlock: function () {
      resumeCtx();
      if (_unlocked) return;
      _unlocked = true;
      if (!AudioApi.isMusicEnabled()) return;
      var bg = el('sfx-bg-music');
      if (bg && soundComp(bg) && !isPlaying(bg) && !global._stacksMatchMusic) {
        setVolume(bg, AudioApi.bgVol);
        try { soundComp(bg).playSound(); } catch (e) { /* ignore */ }
        global._bgMusicStarted = true;
      }
    },

    /**
     * Play a one-shot SFX by entity id suffix: grab, place, clear, garbage, win, ui, rotate.
     * NEVER play boom/explosion — remapped or dropped (user request, repeated).
     * opts.rate — playbackRate. opts.volume — one-shot level.
     * Prefer clearChime() for line clears — not this path.
     */
    sfx: function (name, opts) {
      opts = opts || {};
      if (AudioApi.sfxEnabled === false) return;
      if (name === 'clear') {
        playClearChime(opts.layers != null ? opts.layers : 1, opts.volume);
        return;
      }
      // Hard ban on explosion assets (boom.mp3 / attack.mp3 were the offenders)
      if (name === 'boom' || name === 'attack') {
        name = 'garbage';
      }
      // Soft thud for incoming garbage lines — place click, not a blast
      if (name === 'garbage') {
        name = 'place';
        if (opts.volume == null) opts.volume = 0.22;
        if (opts.rate == null) opts.rate = 0.85;
      }
      AudioApi.unlock();
      var node = el('sfx-' + name);
      var sc = soundComp(node);
      if (!sc) return;
      try {
        var rate = opts.rate != null ? opts.rate : 1;
        if (opts.volume != null) setVolume(node, opts.volume);
        setPlaybackRate(node, rate);
        sc.stopSound();
        sc.playSound();
        setPlaybackRate(node, rate);
      } catch (e) { /* ignore */ }
    },

    clearChime: function (layers, volume) {
      playClearChime(layers, volume);
    },

    preloadClear: function () {
      resumeCtx();
      ensureClearBuffer().catch(function () { /* ignore */ });
    },

    toMatch: function () {
      if (!AudioApi.isMusicEnabled()) return;
      AudioApi.unlock();
      global._stacksMatchMusic = true;
      var bg = el('sfx-bg-music');
      var mm = el('sfx-match-music');
      if (mm && soundComp(mm)) {
        if (!isPlaying(mm)) {
          setVolume(mm, 0);
          try { soundComp(mm).playSound(); } catch (e) { /* ignore */ }
        }
        fadeSound(mm, 0, AudioApi.matchVol, 1800);
      }
      if (bg) fadeSound(bg, AudioApi.bgVol, 0, 1800);
    },

    toIdle: function () {
      if (!AudioApi.isMusicEnabled()) return;
      AudioApi.unlock();
      global._stacksMatchMusic = false;
      var bg = el('sfx-bg-music');
      var mm = el('sfx-match-music');
      if (bg && soundComp(bg)) {
        if (!isPlaying(bg)) {
          setVolume(bg, 0);
          try { soundComp(bg).playSound(); } catch (e) { /* ignore */ }
        }
        fadeSound(bg, 0, AudioApi.bgVol, 1800);
      }
      if (mm) {
        fadeSound(mm, AudioApi.matchVol, 0, 1800, function () {
          var sc = soundComp(mm);
          if (sc) {
            try { sc.stopSound(); } catch (e2) { /* ignore */ }
          }
        });
      }
    }
  };

  global._musicEnabled = AudioApi.musicEnabled;
  global.StacksAudio = AudioApi;

  // Unlock on first pointer / VR enter / key
  function bindUnlock() {
    var once = function () {
      AudioApi.unlock();
      window.removeEventListener('pointerdown', once);
      window.removeEventListener('keydown', once);
      window.removeEventListener('touchstart', once);
    };
    window.addEventListener('pointerdown', once);
    window.addEventListener('keydown', once);
    window.addEventListener('touchstart', once, { passive: true });
    var scene = document.querySelector('a-scene');
    if (scene) {
      scene.addEventListener('enter-vr', function () {
        AudioApi.unlock();
        AudioApi.preloadClear();
      });
      scene.addEventListener('loaded', function () {
        AudioApi.preloadClear();
        // Do NOT playSound()/pauseSound() to "warm" pools — that blasted every
        // SFX (including boom/win) on page open. Decode-only preload is enough.
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUnlock);
  } else {
    bindUnlock();
  }
})(window);
