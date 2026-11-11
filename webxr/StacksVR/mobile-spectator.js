// mobile-spectator.js — DodgeVR mobile spectator UI/UX for StacksVR
(function (global) {
  'use strict';

  var _wakeLock = null;
  var _wakeLockSetup = false;
  var _lobbyNum = 1;
  var _hudTimerIv = null;
  var _poseCount = 0;
  var _cupEventCount = 0;

  function isMobileDevice() {
    var ua = navigator.userAgent || '';
    if (/OculusBrowser|Quest/i.test(ua)) return false;
    if (/Quest|Oculus|Pico|Vive|Windows MR/i.test(ua)) return false;
    return /Android|iPhone|iPad|iPod/i.test(ua) &&
      ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  }

  // CRITICAL (DodgeVR): set flag BEFORE a-scene upgrades components.
  // If this waits for DOMContentLoaded, mobile-spectator-cam init returns early
  // and orbit/swipe never binds.
  var _paramsEarly = new URLSearchParams(location.search);
  var _forceSpectate = _paramsEarly.get('spectate') === '1';
  var _forceVr = _paramsEarly.get('vr') === '1';
  if (!_forceVr && (_forceSpectate || isMobileDevice())) {
    global.isMobileSpectator = true;
    global.isSpectator = true;
  }

  function requestWakeLock() {
    if (!('wakeLock' in navigator) || _wakeLockSetup) return;
    _wakeLockSetup = true;
    function acquire() {
      if (_wakeLock) return;
      navigator.wakeLock.request('screen').then(function (lock) {
        _wakeLock = lock;
        lock.addEventListener('release', function () { _wakeLock = null; });
      }).catch(function () {});
    }
    acquire();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') acquire();
    });
    setInterval(function () {
      if (document.visibilityState === 'visible') acquire();
    }, 60000);
  }

  function showMatchHud(statusText) {
    var lobbyScreen = document.getElementById('mobile-lobby-screen');
    var matchHud = document.getElementById('mobile-match-hud');
    if (lobbyScreen) lobbyScreen.style.display = 'none';
    if (matchHud) matchHud.classList.add('active');
    var hudStatus = document.getElementById('mobile-hud-status');
    if (hudStatus && statusText != null) hudStatus.textContent = statusText;
  }

  function isMatchPlaying(ls) {
    ls = ls || global.lobbyState;
    if (!ls) return false;
    var mp = ls.matchPlayers || {};
    if (ls.matchState === 'PLAYING' && mp.blue && mp.red) return true;
    if (ls.matchGameState === 'PLAYING' && mp.blue && mp.red) return true;
    var gm = document.querySelector('[stacks-game]');
    var comp = gm && gm.components && gm.components['stacks-game'];
    if (comp && (comp.matchActive || comp.matchState === 'PLAYING') && mp.blue && mp.red) {
      return true;
    }
    return false;
  }

  function activateSpectatorBodies() {
    // Do NOT force-show bodies until a pose arrives — otherwise mobile sees a
    // static T-pose at the origin while cups already sync.
    var blue = document.getElementById('spec-blue-body');
    var red = document.getElementById('bot-body');
    if (blue && blue.dataset.posed === '1') {
      blue.setAttribute('visible', true);
      if (blue.object3D) blue.object3D.visible = true;
    } else if (blue) {
      blue.setAttribute('visible', false);
      if (blue.object3D) blue.object3D.visible = false;
    }
    if (red && red.dataset.posed === '1') {
      red.setAttribute('visible', true);
      if (red.object3D) red.object3D.visible = true;
    } else if (red && global.isMobileSpectator) {
      // Hide idle T-pose bot until networked poses arrive
      red.setAttribute('visible', false);
      if (red.object3D) red.object3D.visible = false;
    }
    var gm = document.querySelector('[stacks-game]');
    var comp = gm && gm.components && gm.components['stacks-game'];
    if (comp && comp._sceneRoot) comp._sceneRoot.visible = true;
    if (comp && comp.cups) {
      if (comp.cups.blue && comp.cups.blue.pivot) comp.cups.blue.pivot.visible = true;
      if (comp.cups.red && comp.cups.red.pivot) comp.cups.red.pivot.visible = true;
    }
    var scoreDisplay = document.getElementById('score-display');
    if (scoreDisplay && scoreDisplay.object3D) scoreDisplay.object3D.visible = true;
    var pb = document.getElementById('player-body');
    if (pb && pb.object3D) pb.object3D.visible = false;
  }

  function updateMobileHudNames() {
    var ls = global.lobbyState;
    if (!ls || !ls.matchPlayers) return;
    var mp = ls.matchPlayers;
    var blueNick = 'Blue';
    var redNick = 'Red';
    if (mp.red === '__BOT__') redNick = 'Bot';
    if (ls.players) {
      for (var i = 0; i < ls.players.length; i++) {
        if (ls.players[i].id === mp.blue) blueNick = ls.players[i].nickname || blueNick;
        if (ls.players[i].id === mp.red && mp.red !== '__BOT__') {
          redNick = ls.players[i].nickname || redNick;
        }
      }
    }
    var bnEl = document.getElementById('mobile-blue-name');
    var rnEl = document.getElementById('mobile-red-name');
    if (bnEl) bnEl.textContent = blueNick;
    if (rnEl) rnEl.textContent = redNick;
  }

  function updateMobileHudStatus() {
    var statusEl = document.getElementById('mobile-hud-status');
    if (!statusEl) return;
    var ls = global.lobbyState;
    if (!ls) {
      statusEl.textContent = 'Connecting...';
      return;
    }
    if (isMatchPlaying(ls)) {
      activateSpectatorBodies();
      statusEl.textContent = 'Swipe to orbit · Watching lobby ' + (_lobbyNum || '');
    } else {
      var pc = ls.players ? ls.players.length : 0;
      statusEl.textContent = 'Waiting for match... (' + pc + ' player' + (pc !== 1 ? 's' : '') + ' in lobby)';
    }
  }

  function updateMobileHudScores() {
    var blue = 0;
    var red = 0;
    var ls = global.lobbyState;
    if (ls && ls.matchScore) {
      blue = ls.matchScore.blue || 0;
      red = ls.matchScore.red || 0;
    }
    var gm = document.querySelector('[stacks-game]');
    var comp = gm && gm.components && gm.components['stacks-game'];
    if (comp && comp.modes && comp.modes.scores) {
      blue = comp.modes.scores.blue || blue;
      red = comp.modes.scores.red || red;
    }
    var bEl = document.getElementById('mobile-blue-score');
    var rEl = document.getElementById('mobile-red-score');
    if (bEl) bEl.textContent = String(blue);
    if (rEl) rEl.textContent = String(red);

    var scoreDisplay = document.getElementById('score-display');
    if (scoreDisplay) {
      scoreDisplay.setAttribute('text', 'value', 'BLUE ' + blue + '  |  RED ' + red);
    }

    var timerEl = document.getElementById('mobile-hud-timer');
    if (timerEl && ls && isMatchPlaying(ls) && ls.matchStartTime) {
      var elapsed = Math.max(0, Math.floor((Date.now() - ls.matchStartTime) / 1000));
      var min = Math.floor(elapsed / 60);
      var sec = elapsed % 60;
      timerEl.textContent = min + ':' + (sec < 10 ? '0' : '') + sec;
    }
  }

  function onLobbyStateUpdated() {
    if (!global.isMobileSpectator) return;
    updateMobileHudNames();
    updateMobileHudStatus();
    updateMobileHudScores();
    if (isMatchPlaying(global.lobbyState)) {
      showMatchHud(null);
      activateSpectatorBodies();
    }
  }

  function applyRemotePose(fromId, data) {
    _poseCount++;
    if (typeof global.applyStacksRemotePose === 'function') {
      global.applyStacksRemotePose(fromId, data);
      return;
    }
    // Fallback if stacks-game not ready yet
    var mp = global.lobbyState && global.lobbyState.matchPlayers;
    var myId = global.myPlayerId || (global.StacksLobby && global.StacksLobby.myPlayerId);
    if (fromId === myId) return;
    var body = null;
    if (mp && (fromId === mp.red || (fromId === '__BOT__' && mp.red === '__BOT__'))) {
      body = document.getElementById('bot-body');
    } else if (mp && fromId === mp.blue) {
      body = document.getElementById('spec-blue-body');
    } else if (fromId === '__BOT__') {
      body = document.getElementById('bot-body');
    } else {
      body = document.getElementById('spec-blue-body');
    }
    if (!body || !data) return;
    var head = data.head || (typeof data.x === 'number' ? data : null);
    if (!head || typeof (head.x != null ? head.x : head.x) === 'undefined') {
      if (typeof data.x !== 'number') return;
      head = { x: data.x, y: data.y, z: data.z, qx: data.hqx, qy: data.hqy, qz: data.hqz, qw: data.hqw };
    }
    body.setAttribute('visible', true);
    if (body.object3D) body.object3D.visible = true;
    body.dataset.posed = '1';
    var mb = body.components && body.components['mixamo-body'];
    if (mb) {
      mb.remoteHandData = {
        head: data.head || head,
        leftHand: data.leftHand || null,
        rightHand: data.rightHand || null
      };
    }
  }

  async function onWatchClick() {
    var statusEl = document.getElementById('mobile-status-msg');
    var watchBtn = document.getElementById('mobile-watch-btn');
    if (statusEl) statusEl.textContent = 'Connecting to lobby ' + _lobbyNum + '...';
    if (watchBtn) watchBtn.disabled = true;

    if (typeof global.connectAsMobileSpectator !== 'function') {
      if (statusEl) statusEl.textContent = 'Lobby system not loaded.';
      if (watchBtn) watchBtn.disabled = false;
      return;
    }

    var res = await global.connectAsMobileSpectator(_lobbyNum);
    if (!res || !res.ok) {
      if (statusEl) statusEl.textContent = (res && res.error) || 'Failed';
      if (watchBtn) watchBtn.disabled = false;
      return;
    }

    requestWakeLock();
    showMatchHud('Watching lobby ' + _lobbyNum);
    updateMobileHudNames();
    updateMobileHudStatus();
    updateMobileHudScores();
    activateSpectatorBodies();

    // Ensure orbit cam is live even if component init raced
    var scene = document.querySelector('a-scene');
    var camComp = scene && scene.components && scene.components['mobile-spectator-cam'];
    if (camComp && typeof camComp.setupMobileCamera === 'function') {
      camComp.setupMobileCamera();
    }

    if (!_hudTimerIv) {
      _hudTimerIv = setInterval(function () {
        updateMobileHudStatus();
        updateMobileHudScores();
      }, 250);
    }
  }

  function onPreviewClick() {
    global.offlinePreview = true;
    document.body.classList.add('offline-preview');
    showMatchHud('Offline Preview — swipe to orbit camera');
    var redName = document.getElementById('mobile-red-name');
    var blueName = document.getElementById('mobile-blue-name');
    if (redName) redName.textContent = 'Red Bot';
    if (blueName) blueName.textContent = 'Blue';
    requestWakeLock();
    activateSpectatorBodies();

    var gm = document.querySelector('[stacks-game]');
    var comp = gm && gm.components && gm.components['stacks-game'];
    if (comp && typeof comp.startOfflineBotMatch === 'function' && !comp.matchActive) {
      comp.startOfflineBotMatch();
    }

    var previewStart = Date.now();
    setInterval(function () {
      var elapsed = Math.floor((Date.now() - previewStart) / 1000);
      var min = Math.floor(elapsed / 60);
      var sec = elapsed % 60;
      var timerEl = document.getElementById('mobile-hud-timer');
      if (timerEl) timerEl.textContent = min + ':' + (sec < 10 ? '0' : '') + sec;
      updateMobileHudScores();
    }, 1000);

    var scene = document.querySelector('a-scene');
    var camComp = scene && scene.components && scene.components['mobile-spectator-cam'];
    if (camComp && typeof camComp.setupMobileCamera === 'function') {
      camComp.setupMobileCamera();
    }
  }

  function wireLobbyCallbacks() {
    if (!global.StacksLobby) return;
    var prevLobby = global.StacksLobby.onLobbyState;
    global.StacksLobby.onLobbyState = function (state) {
      if (typeof prevLobby === 'function') prevLobby(state);
      onLobbyStateUpdated();
    };
    var prevMatch = global.StacksLobby.onMatchStarted;
    global.StacksLobby.onMatchStarted = function (mp, startTime, isBotMatch) {
      if (typeof prevMatch === 'function') {
        prevMatch.apply(null, arguments);
      }
      showMatchHud('');
      activateSpectatorBodies();
      updateMobileHudNames();
      updateMobileHudStatus();
      updateMobileHudScores();
    };
    var prevPose = global.StacksLobby.onPlayerPose;
    global.StacksLobby.onPlayerPose = function (fromId, data) {
      if (typeof prevPose === 'function') prevPose(fromId, data);
      applyRemotePose(fromId, data);
    };
    var prevCup = global.StacksLobby.onCupEvent;
    global.StacksLobby.onCupEvent = function (data) {
      if (typeof prevCup === 'function') prevCup(data);
      _cupEventCount++;
      activateSpectatorBodies();
      updateMobileHudScores();
    };
    var prevSnap = global.StacksLobby.onCupSnapshot;
    global.StacksLobby.onCupSnapshot = function (data) {
      if (typeof prevSnap === 'function') prevSnap(data);
      _cupEventCount++;
      activateSpectatorBodies();
      updateMobileHudScores();
      updateMobileHudStatus();
    };
  }

  function initMobileSpectatorUi() {
    if (!global.isMobileSpectator) return;

    document.body.classList.add('mobile-spectator');

    var boot = document.getElementById('boot');
    if (boot) boot.classList.add('gone');

    var overlay = document.getElementById('mobile-spectator-overlay');
    if (overlay) overlay.classList.add('active');

    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock('landscape').catch(function () {});
    }

    var numEl = document.getElementById('mobile-lobby-num');
    var minus = document.getElementById('mobile-lobby-minus');
    var plus = document.getElementById('mobile-lobby-plus');
    if (minus) {
      minus.addEventListener('click', function () {
        _lobbyNum = Math.max(1, _lobbyNum - 1);
        if (numEl) numEl.textContent = String(_lobbyNum);
      });
    }
    if (plus) {
      plus.addEventListener('click', function () {
        _lobbyNum = Math.min(10, _lobbyNum + 1);
        if (numEl) numEl.textContent = String(_lobbyNum);
      });
    }

    var watch = document.getElementById('mobile-watch-btn');
    if (watch) watch.addEventListener('click', onWatchClick);

    var preview = document.getElementById('mobile-preview-btn');
    if (preview) preview.addEventListener('click', onPreviewClick);

    var exitPreview = document.getElementById('mobile-preview-exit');
    if (exitPreview) {
      exitPreview.addEventListener('click', function () { location.reload(); });
    }

    var scene = document.querySelector('a-scene');
    if (scene) {
      scene.addEventListener('lobby-state-updated', onLobbyStateUpdated);
      scene.addEventListener('loaded', function () {
        var vrBtn = document.querySelector('.a-enter-vr');
        if (vrBtn) vrBtn.style.display = 'none';
        activateSpectatorBodies();
        var camComp = scene.components && scene.components['mobile-spectator-cam'];
        if (camComp && typeof camComp.setupMobileCamera === 'function') {
          camComp.setupMobileCamera();
        }
        wireLobbyCallbacks();
      });
    }

    wireLobbyCallbacks();
    setTimeout(wireLobbyCallbacks, 0);
    setTimeout(wireLobbyCallbacks, 500);
  }

  // Orbit camera — DodgeVR pattern (player at orbit height, yaw the rig)
  if (typeof AFRAME !== 'undefined') {
    AFRAME.registerComponent('mobile-spectator-cam', {
      init: function () {
        // Do NOT early-return forever — flag may be set in same tick; always allow setup
        var self = this;
        this._orbitRadius = 3.4;
        this._orbitHeight = 2.05;
        this._orbitAngle = Math.PI / 2;
        this._orbitTargetAngle = Math.PI / 2;
        this._orbitMinAngle = 0;
        this._orbitMaxAngle = Math.PI;
        this._touchStartX = 0;
        this._touchStartAngle = 0;
        this._isTouching = false;
        this._orbitReady = false;
        this._controlsBound = false;

        function trySetup() {
          if (!global.isMobileSpectator) return;
          self.setupMobileCamera();
        }
        if (this.el.hasLoaded) trySetup();
        this.el.addEventListener('loaded', trySetup);
        // Late flag / late UI path
        setTimeout(trySetup, 0);
        setTimeout(trySetup, 300);
      },

      setupMobileCamera: function () {
        if (!global.isMobileSpectator) return;

        var vrBtn = document.querySelector('.a-enter-vr');
        if (vrBtn) vrBtn.style.display = 'none';

        var cam = document.querySelector('[camera]');
        if (cam) {
          cam.removeAttribute('look-controls');
          cam.removeAttribute('wasd-controls');
          cam.setAttribute('camera', 'fov', 50);
          cam.object3D.position.set(0, 0, 0);
          cam.object3D.rotation.set(0, 0, 0);
        }

        this._playerEl = document.getElementById('player');
        this._rigEl = document.getElementById('rig');
        if (this._playerEl) this._playerEl.removeAttribute('stick-locomotion');

        if (this._playerEl) {
          this._playerEl.object3D.position.set(
            this._orbitRadius * Math.sin(this._orbitAngle),
            this._orbitHeight,
            this._orbitRadius * Math.cos(this._orbitAngle)
          );
        }
        if (this._rigEl) {
          this._rigEl.object3D.rotation.set(-0.28, this._orbitAngle, 0);
        }

        var lh = document.getElementById('leftHand');
        var rh = document.getElementById('rightHand');
        if (lh) lh.object3D.visible = false;
        if (rh) rh.object3D.visible = false;
        var menu = document.getElementById('vr-menu-root');
        if (menu) menu.object3D.visible = false;
        var pb = document.getElementById('player-body');
        if (pb) pb.object3D.visible = false;

        activateSpectatorBodies();
        this.setupOrbitControls();
        this._orbitReady = true;
      },

      setupOrbitControls: function () {
        if (this._controlsBound) return;
        this._controlsBound = true;
        var self = this;

        function sensitivity() {
          return Math.PI / Math.max(window.innerWidth, 1);
        }

        function onStart(clientX, target) {
          if (!global.isMobileSpectator) return false;
          if (!target) return true;
          if (target.tagName === 'BUTTON') return false;
          if (target.closest && target.closest('#mobile-lobby-screen')) return false;
          if (target.closest && target.closest('#mobile-preview-exit')) return false;
          return true;
        }

        document.addEventListener('touchstart', function (e) {
          if (!onStart(e.touches[0] && e.touches[0].clientX, e.target)) return;
          if (e.touches.length !== 1) return;
          self._touchStartX = e.touches[0].clientX;
          self._touchStartAngle = self._orbitTargetAngle;
          self._isTouching = true;
        }, { passive: true, capture: true });

        document.addEventListener('touchmove', function (e) {
          if (!self._isTouching) return;
          var deltaX = e.touches[0].clientX - self._touchStartX;
          var newAngle = self._touchStartAngle - deltaX * sensitivity();
          self._orbitTargetAngle = Math.max(self._orbitMinAngle, Math.min(self._orbitMaxAngle, newAngle));
          e.preventDefault();
        }, { passive: false, capture: true });

        document.addEventListener('touchend', function () {
          self._isTouching = false;
        }, { passive: true, capture: true });

        document.addEventListener('mousedown', function (e) {
          if (!onStart(e.clientX, e.target)) return;
          self._touchStartX = e.clientX;
          self._touchStartAngle = self._orbitTargetAngle;
          self._isTouching = true;
        }, true);

        document.addEventListener('mousemove', function (e) {
          if (!self._isTouching || !e.buttons) return;
          var deltaX = e.clientX - self._touchStartX;
          var newAngle = self._touchStartAngle - deltaX * sensitivity();
          self._orbitTargetAngle = Math.max(self._orbitMinAngle, Math.min(self._orbitMaxAngle, newAngle));
        }, true);

        document.addEventListener('mouseup', function () {
          self._isTouching = false;
        }, true);
      },

      tick: function () {
        if (!global.isMobileSpectator || !this._orbitReady || !this._playerEl) return;
        this._orbitAngle += (this._orbitTargetAngle - this._orbitAngle) * 0.18;
        this._playerEl.object3D.position.set(
          this._orbitRadius * Math.sin(this._orbitAngle),
          this._orbitHeight,
          this._orbitRadius * Math.cos(this._orbitAngle)
        );
        if (this._rigEl) {
          this._rigEl.object3D.rotation.set(-0.28, this._orbitAngle, 0);
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMobileSpectatorUi);
  } else {
    initMobileSpectatorUi();
  }

  global.StacksMobileSpectator = {
    showMatchHud: showMatchHud,
    updateMobileHudNames: updateMobileHudNames,
    updateMobileHudStatus: updateMobileHudStatus,
    updateMobileHudScores: updateMobileHudScores,
    activateSpectatorBodies: activateSpectatorBodies,
    isMatchPlaying: isMatchPlaying,
    requestWakeLock: requestWakeLock,
    getDebug: function () {
      return {
        poseCount: _poseCount,
        cupEventCount: _cupEventCount,
        lobbyNum: _lobbyNum,
        matchPlaying: isMatchPlaying(global.lobbyState),
        matchState: global.lobbyState && global.lobbyState.matchState
      };
    }
  };
})(window);
