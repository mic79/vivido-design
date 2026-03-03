/* game-menu.js - VR Menu, Lobby, Queue & Spectator system for DodgeVR */

(function () {
  'use strict';

  var SPECTATOR_POSITIONS = [
    { x: -4, y: 0, z: 3, ry: -53 },
    { x: 4, y: 0, z: 3, ry: 53 },
    { x: -4, y: 0, z: -3, ry: -127 },
    { x: 4, y: 0, z: -3, ry: 127 }
  ];

  var PLAYER_POSITION_BLUE = { x: 0, y: 0, z: 6 };

  AFRAME.registerComponent('vr-menu', {
    init: function () {
      this.menuVisible = false;
      this.menuMode = 'single';
      this.lobbyNumber = 1;
      this._refsReady = false;

      this.menu = null;
      this.leftHand = null;
      this.rightHand = null;
      this.lobbySection = null;
      this.queueButtons = null;

      this.statsSubTab = 'single';
      this.statsPage = 0;
      this.STATS_PER_PAGE = 3;

      var self = this;

      if (this.el.hasLoaded) {
        this.cacheRefs();
      }
      this.el.addEventListener('loaded', function () {
        self.cacheRefs();
      });

      // X button is on the left controller - listen there AND on scene for robustness
      this.el.sceneEl.addEventListener('xbuttondown', function () {
        self.toggleMenu();
      });
      // Also attach directly to the left hand entity once available
      function attachXButton() {
        var leftHand = document.getElementById('leftHand');
        if (leftHand) {
          leftHand.addEventListener('xbuttondown', function () {
            self.toggleMenu();
          });
        } else {
          setTimeout(attachXButton, 500);
        }
      }
      setTimeout(attachXButton, 100);

      this.el.sceneEl.addEventListener('enter-vr', function () {
        var overlay = document.getElementById('pre-vr-overlay');
        if (overlay) overlay.style.display = 'none';
      });

      this.el.sceneEl.addEventListener('lobby-state-updated', function () {
        self.updateMenuDisplay();
      });
    },

    cacheRefs: function () {
      this.menu = document.getElementById('game-menu');
      this.leftHand = document.getElementById('leftHand');
      this.rightHand = document.getElementById('rightHand');
      this.lobbySection = document.getElementById('menu-lobby-section');
      this.queueButtons = document.getElementById('menu-queue-buttons');
      this._refsReady = !!(this.menu && this.leftHand && this.rightHand);
    },

    ensureRefs: function () {
      if (!this._refsReady) this.cacheRefs();
    },

    toggleMenu: function () {
      var now = Date.now();
      if (now - (this._lastToggle || 0) < 400) return;
      this._lastToggle = now;

      this.ensureRefs();
      this.menuVisible = !this.menuVisible;
      console.log('VR Menu toggled:', this.menuVisible, 'menu ref:', !!this.menu);
      if (this.menu) this.menu.setAttribute('visible', this.menuVisible);
      this.setRaycasters(this.menuVisible);
      if (this.menuVisible) this.updateMenuDisplay();
    },

    setRaycasters: function (enabled) {
      this.ensureRefs();
      var hands = [this.leftHand, this.rightHand];
      for (var i = 0; i < hands.length; i++) {
        var hand = hands[i];
        if (!hand) continue;
        hand.setAttribute('raycaster', {
          objects: enabled ? '.clickable' : '',
          showLine: enabled,
          lineColor: '#ffffff',
          lineOpacity: enabled ? 1 : 0,
          far: 10,
          enabled: enabled
        });
      }
      // Defer line hide to run after raycaster processes the setAttribute update
      setTimeout(function () {
        for (var i = 0; i < hands.length; i++) {
          var hand = hands[i];
          if (!hand) continue;
          var rc = hand.components.raycaster;
          if (rc && rc.line) rc.line.visible = enabled;
        }
      }, 0);
    },

    handleMenuClick: function (buttonId) {
      switch (buttonId) {
        case 'menu-single': this.setMode('single'); break;
        case 'menu-multi': this.setMode('multi'); break;
        case 'menu-stats': this.setMode('stats'); break;
        case 'menu-lobby-minus':
          this.lobbyNumber = Math.max(1, this.lobbyNumber - 1);
          this.updateLobbyNumberDisplay();
          break;
        case 'menu-lobby-plus':
          this.lobbyNumber = Math.min(10, this.lobbyNumber + 1);
          this.updateLobbyNumberDisplay();
          break;
        case 'menu-join': this.handleJoin(); break;
        case 'menu-join-queue': this.joinQueue(); break;
        case 'menu-leave-queue': this.leaveQueue(); break;
        case 'menu-mirror-toggle': this.toggleMirrorMode(); break;
        case 'menu-rec-mode-toggle': this.toggleRecSubMode(); break;
        case 'menu-difficulty-toggle': this.cycleDifficulty(); break;
        case 'menu-clip-prev': this.clipPrev(); break;
        case 'menu-clip-next': this.clipNext(); break;
        case 'menu-clip-delete': this.deleteCurrentClip(); break;
        case 'menu-delete-last': this.deleteLastClip(); break;
        case 'menu-clear-clips': this.clearAllClips(); break;
        case 'menu-music-toggle': this.toggleMusic(); break;
        case 'menu-start-match': this.toggleMatch(); break;
        case 'menu-stats-sp': this.setStatsSubTab('single'); break;
        case 'menu-stats-mp': this.setStatsSubTab('multi'); break;
        case 'menu-stats-prev': this.statsPagePrev(); break;
        case 'menu-stats-next': this.statsPageNext(); break;
        case 'menu-stats-clear': this.clearStats(); break;
      }
    },

    setMode: function (mode) {
      this.menuMode = mode;
      var singleBtn = document.getElementById('menu-single');
      var multiBtn = document.getElementById('menu-multi');
      var statsBtn = document.getElementById('menu-stats');
      if (singleBtn) singleBtn.setAttribute('material', 'color', mode === 'single' ? '#4488ff' : '#333333');
      if (multiBtn) multiBtn.setAttribute('material', 'color', mode === 'multi' ? '#4488ff' : '#333333');
      if (statsBtn) statsBtn.setAttribute('material', 'color', mode === 'stats' ? '#4488ff' : '#333333');
      if (this.lobbySection) this.lobbySection.setAttribute('visible', mode === 'multi');
      if (this.queueButtons) this.queueButtons.setAttribute('visible', mode === 'multi' && window.isMultiplayer);

      var mirrorSection = document.getElementById('menu-mirror-section');
      if (mirrorSection) mirrorSection.setAttribute('visible', mode === 'single');

      var statsSection = document.getElementById('menu-stats-section');
      if (statsSection) statsSection.setAttribute('visible', mode === 'stats');

      var startMatchBtn = document.getElementById('menu-start-match');
      if (startMatchBtn) startMatchBtn.setAttribute('visible', mode !== 'stats');

      if (mode === 'multi') {
        this.setMirrorMode(false);
        // End any active singleplayer match when switching to multiplayer
        var gmEl = document.querySelector('#game-manager');
        var gm = gmEl && gmEl.components['game-manager'];
        if (gm && (gm.matchState === 'PLAYING' || gm.matchState === 'OVERTIME' || gm.matchState === 'COUNTDOWN')) {
          gm.endMatch(true);
        }
      }

      if (mode === 'single' && window.isMultiplayer) {
        if (typeof window.endMultiplayer === 'function') window.endMultiplayer();
        this.moveToMatchPosition();
      }

      if (mode === 'stats') {
        this.statsPage = 0;
        this.updateStatsDisplay();
      }

      this.updateMenuDisplay();
    },

    toggleMirrorMode: function () {
      if (!window.botMirrorMode && !window.botRecordedMode) {
        this.setBotMode('mirror');
      } else if (window.botMirrorMode) {
        this.setBotMode('recorded');
      } else {
        this.setBotMode('normal');
      }
    },

    setMirrorMode: function (enabled) {
      this.setBotMode(enabled ? 'mirror' : 'normal');
    },

    setBotMode: function (mode) {
      if (window.motionPlayback) {
        window.motionPlayback.isPlaying = false;
        window.motionPlayback.looping = false;
      }
      if (window.motionRecorder && window.motionRecorder.reset) window.motionRecorder.reset();

      window.botMirrorMode = (mode === 'mirror');
      window.botRecordedMode = (mode === 'recorded');
      if (mode !== 'recorded') window.botRecordedSubMode = 'random';

      var mirrorText = document.getElementById('menu-mirror-text');
      var mirrorBtn = document.getElementById('menu-mirror-toggle');
      var labels = { normal: 'NORMAL', mirror: 'MIRRORED', recorded: 'RECORDED' };
      var colors = { normal: '#555555', mirror: '#4488ff', recorded: '#44aa44' };
      if (mirrorText) mirrorText.setAttribute('text', 'value', labels[mode] || 'NORMAL');
      if (mirrorBtn) mirrorBtn.setAttribute('material', 'color', colors[mode] || '#555555');

      this.updateClipButtons();

      window.botReactionTarget = null;

      if (mode !== 'mirror') {
        var botEntity = document.querySelector('[advanced-bot]');
        if (botEntity) botEntity.object3D.position.set(0, 1.6, -6);
        var botBall = document.querySelector('[simple-grab="player: player1"]');
        if (botBall && botBall.components['simple-grab']) {
          botBall.components['simple-grab'].resetPosition();
        }
        var botBodyEl = document.getElementById('bot-body');
        if (botBodyEl && botBodyEl.components['mixamo-body']) {
          var mb = botBodyEl.components['mixamo-body'];
          mb._mirrorRefs = false;
          mb._pbRefs = false;
          if (mb.botRackets) {
            mb.botRackets.left.visible = false;
            mb.botRackets.right.visible = false;
          }
        }
      }
    },

    cycleDifficulty: function () {
      var levels = ['easy', 'medium', 'hard'];
      var botEl = document.querySelector('[advanced-bot]');
      if (!botEl) return;
      var current = botEl.getAttribute('advanced-bot').difficulty || 'medium';
      var idx = levels.indexOf(current);
      var next = levels[(idx + 1) % levels.length];
      botEl.setAttribute('advanced-bot', 'difficulty', next);

      var bot = botEl.components['advanced-bot'];
      if (bot) {
        bot.difficultyMultiplier = bot.getDifficultyMultiplier();
        bot._initReactionParams();
      }
      this.updateClipButtons();
    },

    // ---- Recorded sub-mode (All Random / Single) ----

    toggleRecSubMode: function () {
      var newMode = window.botRecordedSubMode === 'random' ? 'single' : 'random';
      window.botRecordedSubMode = newMode;

      if (newMode === 'single') {
        this._initBrowseCategory();
        this._startBrowsePreview();
      } else {
        if (window.motionPlayback) {
          window.motionPlayback.isPlaying = false;
          window.motionPlayback.looping = false;
        }
      }
      this.updateClipButtons();
    },

    _initBrowseCategory: function () {
      window.clipBrowseIndex = 0;
    },

    clipPrev: function () {
      var lib = window.motionClipLibrary || {};
      var arr = lib.serve;
      if (!arr || arr.length === 0) return;
      window.clipBrowseIndex = (window.clipBrowseIndex - 1 + arr.length) % arr.length;
      this._startBrowsePreview();
      this.updateClipButtons();
    },

    clipNext: function () {
      var lib = window.motionClipLibrary || {};
      var arr = lib.serve;
      if (!arr || arr.length === 0) return;
      window.clipBrowseIndex = (window.clipBrowseIndex + 1) % arr.length;
      this._startBrowsePreview();
      this.updateClipButtons();
    },

    deleteCurrentClip: function () {
      var lib = window.motionClipLibrary || {};
      var arr = lib.serve;
      if (!arr || arr.length === 0) return;
      arr.splice(window.clipBrowseIndex, 1);
      if (window.motionRecorder) {
        window.motionRecorder._saveToStorage();
        window.motionRecorder._updateClipCountDisplay();
      }
      if (window.clipBrowseIndex >= arr.length) {
        window.clipBrowseIndex = Math.max(0, arr.length - 1);
      }
      this._startBrowsePreview();
      this.updateClipButtons();
    },

    _startBrowsePreview: function () {
      if (!window.motionPlayback) return;
      var lib = window.motionClipLibrary || {};
      var arr = lib.serve;
      if (!arr || arr.length === 0) {
        window.motionPlayback.isPlaying = false;
        window.motionPlayback.looping = false;
        return;
      }
      var idx = Math.min(window.clipBrowseIndex, arr.length - 1);
      window.clipBrowseIndex = idx;
      window.motionPlayback.startClipByIndex('serve', idx);
    },

    // ---- Legacy clip management (mirror mode) ----

    deleteLastClip: function () {
      if (!window.motionClipLibrary) return;
      var arr = window.motionClipLibrary.serve;
      if (arr && arr.length > 0) {
        arr.pop();
        if (window.motionRecorder) {
          window.motionRecorder._saveToStorage();
          window.motionRecorder._updateClipCountDisplay();
        }
        this.updateClipButtons();
      }
    },

    clearAllClips: function () {
      if (window.motionRecorder) {
        window.motionRecorder.clearClips();
      }
      this.updateClipButtons();
    },

    // ---- Match History (Stats tab) ----

    setStatsSubTab: function (tab) {
      this.statsSubTab = tab;
      this.statsPage = 0;
      var spBtn = document.getElementById('menu-stats-sp');
      var mpBtn = document.getElementById('menu-stats-mp');
      if (spBtn) spBtn.setAttribute('material', 'color', tab === 'single' ? '#4488ff' : '#333333');
      if (mpBtn) mpBtn.setAttribute('material', 'color', tab === 'multi' ? '#4488ff' : '#333333');
      this.updateStatsDisplay();
    },

    statsPagePrev: function () {
      if (this.statsPage > 0) {
        this.statsPage--;
        this.updateStatsDisplay();
      }
    },

    statsPageNext: function () {
      var history = window.loadMatchHistory ? window.loadMatchHistory() : { single: [], multi: [] };
      var list = this.statsSubTab === 'multi' ? history.multi : history.single;
      var maxPage = Math.max(0, Math.ceil(list.length / this.STATS_PER_PAGE) - 1);
      if (this.statsPage < maxPage) {
        this.statsPage++;
        this.updateStatsDisplay();
      }
    },

    clearStats: function () {
      if (window.clearMatchHistory) {
        window.clearMatchHistory(this.statsSubTab);
      }
      this.statsPage = 0;
      this.updateStatsDisplay();
    },

    updateStatsDisplay: function () {
      var history = window.loadMatchHistory ? window.loadMatchHistory() : { single: [], multi: [] };
      var list = this.statsSubTab === 'multi' ? history.multi : history.single;
      var summaryEl = document.getElementById('menu-stats-summary');
      var textEl = document.getElementById('menu-stats-text');
      var pageEl = document.getElementById('menu-stats-page');

      if (list.length === 0) {
        if (summaryEl) summaryEl.setAttribute('text', 'value', 'No matches yet');
        if (textEl) textEl.setAttribute('text', 'value', '');
        if (pageEl) pageEl.setAttribute('text', 'value', '');
        return;
      }

      var wins = 0, totalAcc = 0;
      for (var i = 0; i < list.length; i++) {
        if (list[i].result === 'WIN') wins++;
        totalAcc += (list[i].player && list[i].player.accuracy) || 0;
      }
      var losses = list.length - wins;
      var avgAcc = Math.round(totalAcc / list.length);
      if (summaryEl) {
        summaryEl.setAttribute('text', 'value',
          'Record: ' + wins + 'W - ' + losses + 'L  |  Avg Acc: ' + avgAcc + '%');
      }

      var totalPages = Math.ceil(list.length / this.STATS_PER_PAGE);
      var startIdx = this.statsPage * this.STATS_PER_PAGE;
      var endIdx = Math.min(startIdx + this.STATS_PER_PAGE, list.length);
      var lines = [];

      for (var j = startIdx; j < endIdx; j++) {
        var m = list[j];
        var num = j + 1;
        var mins = Math.floor((m.durationSeconds || 0) / 60);
        var secs = (m.durationSeconds || 0) % 60;
        var timeStr = mins + ':' + (secs < 10 ? '0' : '') + secs;
        var header = '#' + num + '  ' + m.result + '  |  ' +
          m.playerScore + ' - ' + m.opponentScore + '  |  ' + timeStr;
        if (m.overtime) header += '  |  OT';
        lines.push(header);

        var p = m.player || {};
        lines.push('  You: T:' + (p.throws || 0) + ' R:' + (p.racketHits || 0) +
          ' B:' + (p.blocks || 0) + ' D:' + (p.dodges || 0) +
          ' Acc:' + (p.accuracy || 0) + '% Spd:' + (p.maxSpeed || 0) +
          ' Stg:' + (p.finalStage || 1));

        var o = m.opponent || {};
        var oppLabel = m.opponentName || 'Bot';
        lines.push('  ' + oppLabel + ': T:' + (o.throws || 0) + ' R:' + (o.racketHits || 0) +
          ' B:' + (o.blocks || 0) + ' D:' + (o.dodges || 0) +
          ' Acc:' + (o.accuracy || 0) + '% Spd:' + (o.maxSpeed || 0) +
          ' Stg:' + (o.finalStage || 1));

        var dateLine = '';
        if (m.botMode) dateLine += m.botMode + '  |  ';
        if (m.timestamp) {
          var d = new Date(m.timestamp);
          var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          dateLine += months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' ' +
            d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
        }
        if (dateLine) lines.push('  ' + dateLine);
        lines.push('');
      }

      if (textEl) textEl.setAttribute('text', 'value', lines.join('\n'));
      if (pageEl) {
        pageEl.setAttribute('text', 'value', totalPages > 1 ? (this.statsPage + 1) + ' / ' + totalPages : '');
      }
    },

    updateClipButtons: function () {
      var lib = window.motionClipLibrary || {};
      var total = (lib.serve ? lib.serve.length : 0);

      var clipCountEl = document.getElementById('menu-clip-count');
      var clipBtnsEl = document.getElementById('menu-clip-buttons');
      var showClips = (window.botMirrorMode || window.botRecordedMode) && this.menuMode === 'single';

      if (clipCountEl) {
        clipCountEl.setAttribute('text', 'value', 'Clips: ' + total);
        clipCountEl.setAttribute('visible', showClips && total > 0);
      }
      if (clipBtnsEl) {
        clipBtnsEl.setAttribute('visible', showClips && window.botMirrorMode && total > 0);
      }

      var recSubSection = document.getElementById('menu-rec-sub-section');
      var browseSection = document.getElementById('menu-single-browse');
      var showRecSub = window.botRecordedMode && this.menuMode === 'single' && total > 0;

      if (recSubSection) recSubSection.setAttribute('visible', showRecSub);

      var recModeText = document.getElementById('menu-rec-mode-text');
      if (recModeText) {
        recModeText.setAttribute('text', 'value', window.botRecordedSubMode === 'random' ? 'ALL RANDOM' : 'SINGLE');
      }
      var recModeBtn = document.getElementById('menu-rec-mode-toggle');
      if (recModeBtn) {
        recModeBtn.setAttribute('material', 'color', window.botRecordedSubMode === 'random' ? '#555555' : '#4488ff');
      }

      var showBrowse = showRecSub && window.botRecordedSubMode === 'single';
      var showDifficulty = showRecSub && !showBrowse;

      var diffRow = document.getElementById('menu-difficulty-row');
      if (diffRow) diffRow.setAttribute('visible', showDifficulty);

      if (showDifficulty) {
        var diffText = document.getElementById('menu-difficulty-text');
        var diffBtn = document.getElementById('menu-difficulty-toggle');
        if (diffText && diffBtn) {
          var botEl = document.querySelector('[advanced-bot]');
          var diff = botEl ? (botEl.getAttribute('advanced-bot').difficulty || 'medium') : 'medium';
          var diffLabels = { easy: 'EASY', medium: 'MEDIUM', hard: 'HARD' };
          var diffColors = { easy: '#44aa44', medium: '#cc8800', hard: '#cc3333' };
          diffText.setAttribute('text', 'value', diffLabels[diff] || 'MEDIUM');
          diffBtn.setAttribute('material', 'color', diffColors[diff] || '#555555');
        }
      }

      if (browseSection) browseSection.setAttribute('visible', showBrowse);

      if (showBrowse) {
        var arr = lib.serve || [];
        var counterText = document.getElementById('menu-clip-counter');
        if (counterText) {
          counterText.setAttribute('text', 'value', arr.length > 0 ? (window.clipBrowseIndex + 1) + ' / ' + arr.length : '0 / 0');
        }
      }
    },

    updateLobbyNumberDisplay: function () {
      var numDisplay = document.getElementById('menu-lobby-number');
      if (numDisplay) numDisplay.setAttribute('text', 'value', this.lobbyNumber.toString());
    },

    handleJoin: function () {
      if (window.isMultiplayer) {
        if (typeof window.endMultiplayer === 'function') window.endMultiplayer();
        this.moveToMatchPosition();
        this.updateMenuDisplay();
      } else {
        if (typeof window.connectToLobby === 'function') {
          window.connectToLobby(this.lobbyNumber);
        }
      }
    },

    joinQueue: function () {
      if (typeof window.sendQueueAction === 'function') {
        window.sendQueueAction('join');
      }
    },

    leaveQueue: function () {
      if (typeof window.sendQueueAction === 'function') {
        window.sendQueueAction('leave');
      }
    },

    toggleMusic: function () {
      window._musicEnabled = window._musicEnabled !== false;
      window._musicEnabled = !window._musicEnabled;

      var btn = document.getElementById('menu-music-toggle');
      if (btn) {
        btn.setAttribute('material', 'color', window._musicEnabled ? '#44aa44' : '#555555');
      }

      var sm = this.el.sceneEl.components['sound-manager'];
      var bgm = document.querySelector('#bg-music');
      var mm = document.querySelector('#match-music');

      if (window._musicEnabled) {
        var gmEl = document.querySelector('#game-manager');
        var gm = gmEl && gmEl.components['game-manager'];
        var inMatch = gm && (gm.matchState === 'PLAYING' || gm.matchState === 'OVERTIME' || gm.matchState === 'COUNTDOWN');
        if (inMatch) {
          if (mm && mm.components.sound) {
            mm.components.sound.playSound();
            if (sm) {
              sm._setVolume(mm, 0);
              sm._fadeSound(mm, 0, sm.matchMusicVolume, 500);
            }
          }
        } else {
          if (bgm && bgm.components.sound) {
            bgm.components.sound.playSound();
            if (sm) {
              sm._setVolume(bgm, 0);
              sm._fadeSound(bgm, 0, sm.bgMusicVolume, 500);
            }
          }
        }
        window._bgMusicStarted = true;
      } else {
        if (bgm && bgm.components.sound) bgm.components.sound.stopSound();
        if (mm && mm.components.sound) mm.components.sound.stopSound();
        if (sm) {
          if (sm._fadeTickers['bg-music']) { clearInterval(sm._fadeTickers['bg-music']); delete sm._fadeTickers['bg-music']; }
          if (sm._fadeTickers['match-music']) { clearInterval(sm._fadeTickers['match-music']); delete sm._fadeTickers['match-music']; }
        }
      }
    },

    toggleMatch: function () {
      var ls = window.lobbyState;
      if (!window.isMultiplayer) {
        this.startSingleplayerMatch();
        return;
      }
      if (typeof window.sendMatchAction === 'function') {
        if (ls && ls.matchState === 'PLAYING') {
          window.sendMatchAction('end');
        } else {
          window.sendMatchAction('start');
        }
      }
      this.menuVisible = false;
      if (this.menu) this.menu.setAttribute('visible', false);
      this.setRaycasters(false);
    },

    startSingleplayerMatch: function () {
      var gmEl = document.querySelector('#game-manager');
      if (gmEl && gmEl.components['game-manager']) {
        var gm = gmEl.components['game-manager'];
        if (gm.matchState === 'PLAYING' || gm.matchState === 'OVERTIME' || gm.matchState === 'COUNTDOWN') {
          gm.endMatch(true);
          this.updateMenuDisplay();
          return;
        }
        if (gm.matchState === 'WAITING' || gm.matchState === 'ENDED') {
          if (gm.matchState === 'ENDED') gm.resetMatch();
          gm.startCountdown();
        }
      }
      this.menuVisible = false;
      if (this.menu) this.menu.setAttribute('visible', false);
      this.setRaycasters(false);
    },

    movePlayerToPosition: function (pos) {
      var player = document.getElementById('player');
      if (player) {
        player.setAttribute('position', pos.x + ' ' + pos.y + ' ' + pos.z);
        if (pos.ry !== undefined) {
          var rig = document.getElementById('rig');
          if (rig) rig.setAttribute('rotation', '0 ' + pos.ry + ' 0');
        }
        var pc = player.components['player-collision'];
        if (pc && pc.body) {
          pc.body.position.set(pos.x, (pos.y || 0) + 1.0, pos.z);
          pc.body.velocity.set(0, 0, 0);
        }
      }
    },

    moveToSpectator: function (slotIndex) {
      if (slotIndex >= 0 && slotIndex < SPECTATOR_POSITIONS.length) {
        this.movePlayerToPosition(SPECTATOR_POSITIONS[slotIndex]);
        window.isSpectator = true;
        this.disableBallInteraction(true);
      }
    },

    moveToMatchPosition: function () {
      this.movePlayerToPosition(PLAYER_POSITION_BLUE);
      var rig = document.getElementById('rig');
      if (rig) rig.setAttribute('rotation', '0 0 0');
      window.isSpectator = false;
      this.disableBallInteraction(false);
    },

    disableBallInteraction: function (disable) {
      var blueBall = document.querySelector('[simple-grab="player: player2"]');
      if (blueBall && blueBall.components['simple-grab']) {
        blueBall.components['simple-grab'].spectatorMode = disable;
      }
    },

    updateMenuDisplay: function () {
      this.ensureRefs();
      var ls = window.lobbyState;

      var joinBtn = document.getElementById('menu-join');
      if (joinBtn) {
        var joinText = joinBtn.querySelector('a-text');
        if (joinText) {
          if (window.isMultiplayer) {
            joinText.setAttribute('text', 'value', 'LEAVE');
            joinBtn.setAttribute('material', 'color', '#cc3333');
          } else {
            joinText.setAttribute('text', 'value', 'JOIN');
            joinBtn.setAttribute('material', 'color', '#22aa44');
          }
        }
      }

      var mirrorSection = document.getElementById('menu-mirror-section');
      if (mirrorSection) mirrorSection.setAttribute('visible', this.menuMode === 'single');
      var mirrorText = document.getElementById('menu-mirror-text');
      var mirrorBtn = document.getElementById('menu-mirror-toggle');
      var currentMode = window.botMirrorMode ? 'MIRRORED' : (window.botRecordedMode ? 'RECORDED' : 'NORMAL');
      var currentColor = window.botMirrorMode ? '#4488ff' : (window.botRecordedMode ? '#44aa44' : '#555555');
      if (mirrorText) mirrorText.setAttribute('text', 'value', currentMode);
      if (mirrorBtn) mirrorBtn.setAttribute('material', 'color', currentColor);

      this.updateClipButtons();

      var statsSection = document.getElementById('menu-stats-section');
      if (statsSection) statsSection.setAttribute('visible', this.menuMode === 'stats');

      if (!ls) {
        if (this.queueButtons) this.queueButtons.setAttribute('visible', false);
        var startMatchBtn = document.getElementById('menu-start-match');
        if (startMatchBtn) {
          var showStart = this.menuMode !== 'stats';
          startMatchBtn.setAttribute('visible', showStart);
          if (showStart) {
            var stxt = document.getElementById('menu-start-match-text');
            var gmEl = document.querySelector('#game-manager');
            var gm = gmEl && gmEl.components['game-manager'];
            var isPlaying = gm && (gm.matchState === 'PLAYING' || gm.matchState === 'OVERTIME' || gm.matchState === 'COUNTDOWN');
            if (stxt) stxt.setAttribute('text', 'value', isPlaying ? 'END MATCH' : 'START MATCH');
            startMatchBtn.setAttribute('material', 'color', isPlaying ? '#cc3333' : '#ff8800');
          }
        }
        return;
      }

      var playersList = document.getElementById('menu-players-list');
      if (playersList) {
        var text = 'Players:';
        for (var i = 0; i < ls.players.length; i++) {
          var p = ls.players[i];
          text += '\n  ' + p.nickname + (p.id === window.myPlayerId ? ' (you)' : '');
        }
        playersList.setAttribute('text', 'value', text);
      }

      var queueStatus = document.getElementById('menu-queue-status');
      if (queueStatus) {
        var qtext = '';
        if (ls.matchPlayers.blue || ls.matchPlayers.red) {
          var blueName = '-', redName = '-';
          for (var j = 0; j < ls.players.length; j++) {
            if (ls.players[j].id === ls.matchPlayers.blue) blueName = ls.players[j].nickname;
            if (ls.players[j].id === ls.matchPlayers.red) redName = ls.players[j].nickname;
          }
          qtext += 'Match: ' + blueName + ' vs ' + redName + '\n';
        }
        if (ls.queue.length > 0) {
          var names = [];
          for (var k = 0; k < ls.queue.length; k++) {
            var qp = null;
            for (var m = 0; m < ls.players.length; m++) {
              if (ls.players[m].id === ls.queue[k]) { qp = ls.players[m]; break; }
            }
            names.push(qp ? qp.nickname : '?');
          }
          qtext += 'Queue: ' + names.join(', ');
        }
        if (ls.matchState === 'PLAYING') qtext += '\nMatch in progress';
        queueStatus.setAttribute('text', 'value', qtext);
      }

      if (this.queueButtons && this.menuMode === 'multi') {
        this.queueButtons.setAttribute('visible', window.isMultiplayer);
      }

      var inQueue = ls.queue.indexOf(window.myPlayerId) >= 0;
      var isMatchPlayer = ls.matchPlayers.blue === window.myPlayerId || ls.matchPlayers.red === window.myPlayerId;
      var matchNotStarted = ls.matchState !== 'PLAYING';
      var joinQueueBtn = document.getElementById('menu-join-queue');
      var leaveQueueBtn = document.getElementById('menu-leave-queue');
      // Show "Join Queue" when not in queue and not in a match spot
      if (joinQueueBtn) joinQueueBtn.setAttribute('visible', !inQueue && !isMatchPlayer);
      // Show "Leave Queue" when in queue OR in a match spot before match has started
      if (leaveQueueBtn) leaveQueueBtn.setAttribute('visible', inQueue || (isMatchPlayer && matchNotStarted));

      var startMatchBtn2 = document.getElementById('menu-start-match');
      var startMatchText = document.getElementById('menu-start-match-text');
      if (startMatchBtn2 && startMatchText) {
        if (this.menuMode === 'stats') {
          startMatchBtn2.setAttribute('visible', false);
        } else {
          var bothSlotsFilled = ls.matchPlayers.blue && ls.matchPlayers.red;
          if (isMatchPlayer && ls.matchState === 'PLAYING') {
            startMatchBtn2.setAttribute('visible', true);
            startMatchText.setAttribute('text', 'value', 'END MATCH');
            startMatchBtn2.setAttribute('material', 'color', '#cc3333');
          } else if (isMatchPlayer && bothSlotsFilled) {
            startMatchBtn2.setAttribute('visible', true);
            startMatchText.setAttribute('text', 'value', 'START MATCH');
            startMatchBtn2.setAttribute('material', 'color', '#ff8800');
          } else {
            startMatchBtn2.setAttribute('visible', false);
          }
        }
      }

    }
  });

  function lightenColor(hex, amount) {
    var c = hex.replace('#', '');
    if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var r = parseInt(c.substring(0, 2), 16);
    var g = parseInt(c.substring(2, 4), 16);
    var b = parseInt(c.substring(4, 6), 16);
    r = Math.min(255, Math.round(r + (255 - r) * amount));
    g = Math.min(255, Math.round(g + (255 - g) * amount));
    b = Math.min(255, Math.round(b + (255 - b) * amount));
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  function isEffectivelyVisible(el) {
    var node = el;
    while (node && node !== node.sceneEl) {
      if (node.object3D && !node.object3D.visible) return false;
      node = node.parentNode;
    }
    return true;
  }

  AFRAME.registerComponent('menu-click', {
    init: function () {
      var self = this;
      this.originalColor = null;
      this.originalOpacity = null;

      this.el.addEventListener('click', function () {
        if (!isEffectivelyVisible(self.el)) return;
        var vrMenu = self.el.sceneEl.components['vr-menu'];
        if (vrMenu) {
          vrMenu.handleMenuClick(self.el.id);
        }
      });

      this.el.addEventListener('mouseenter', function () {
        if (!isEffectivelyVisible(self.el)) return;
        var mat = self.el.getAttribute('material');
        if (mat) {
          self.originalColor = mat.color;
          self.originalOpacity = mat.opacity;
        }
        var baseColor = self.originalColor || '#333333';
        self.el.setAttribute('material', 'color', lightenColor(baseColor, 0.2));
      });

      this.el.addEventListener('mouseleave', function () {
        if (self.originalColor) {
          self.el.setAttribute('material', 'color', self.originalColor);
        }
        if (self.originalOpacity !== null) {
          self.el.setAttribute('material', 'opacity', self.originalOpacity);
        }
      });
    }
  });
})();
