// stacks-audio.js — music + SFX for StacksVR (DodgeVR sound-manager pattern)
(function (global) {
  'use strict';

  var _unlocked = false;
  var _fadeTickers = {};

  function el(id) {
    return document.getElementById(id);
  }

  function soundComp(node) {
    return node && node.components && node.components.sound;
  }

  function setVolume(node, vol) {
    var sc = soundComp(node);
    if (!sc || !sc.pool || !sc.pool.children) return;
    for (var i = 0; i < sc.pool.children.length; i++) {
      sc.pool.children[i].setVolume(vol);
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

  var AudioApi = {
    bgVol: 0.28,
    matchVol: 0.32,
    sfxEnabled: true,
    musicEnabled: true,

    unlock: function () {
      resumeCtx();
      if (_unlocked) return;
      _unlocked = true;
      if (global._musicEnabled === false || AudioApi.musicEnabled === false) return;
      var bg = el('sfx-bg-music');
      if (bg && soundComp(bg) && !isPlaying(bg) && !global._stacksMatchMusic) {
        setVolume(bg, AudioApi.bgVol);
        try { soundComp(bg).playSound(); } catch (e) { /* ignore */ }
        global._bgMusicStarted = true;
      }
    },

    /** Play a one-shot SFX by entity id suffix: grab, place, clear, attack, boom, win, ui, rotate */
    sfx: function (name, opts) {
      opts = opts || {};
      if (AudioApi.sfxEnabled === false) return;
      AudioApi.unlock();
      var node = el('sfx-' + name);
      var sc = soundComp(node);
      if (!sc) return;
      try {
        if (opts.volume != null) setVolume(node, opts.volume);
        sc.stopSound();
        sc.playSound();
      } catch (e) { /* ignore */ }
    },

    toMatch: function () {
      if (global._musicEnabled === false || AudioApi.musicEnabled === false) return;
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
      if (global._musicEnabled === false || AudioApi.musicEnabled === false) return;
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
      scene.addEventListener('enter-vr', function () { AudioApi.unlock(); });
      scene.addEventListener('loaded', function () {
        // Warm SFX pools silently
        ['grab', 'place', 'clear', 'attack', 'boom', 'win', 'ui', 'rotate'].forEach(function (n) {
          var node = el('sfx-' + n);
          var sc = soundComp(node);
          if (!sc) return;
          try {
            sc.playSound();
            sc.pauseSound();
          } catch (e) { /* ignore */ }
        });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUnlock);
  } else {
    bindUnlock();
  }
})(window);
