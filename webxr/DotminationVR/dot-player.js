// dot-player.js — DotminationVR player name + World Rankings, inside VR.
//   • Name card: an in-world keyboard (laser, finger poke, mouse; a real keyboard works too).
//     Not the Meta system keyboard: in the Quest store app its key presses reach the page but
//     the typed text never does.
//     The Meta Quest store app starts straight in VR (no 2D start screen), so this is where
//     players set the name shown in lobbies, cross-play and the World Rankings. Asked once on
//     first launch when no name is saved.
//   • Rankings card: this level's top 10 / overall top 10, your own position (vivido-hub.js).
// Uses the dot-ui.js card system; loaded after dot-ui.js.
(function (global) {
  'use strict';
  if (!global.AFRAME || !AFRAME.components['dot-game'] || !global.DotUI) {
    console.error('[dot-player] dot-game and dot-ui must load first');
    return;
  }
  var C = AFRAME.components['dot-game'].Component.prototype;
  var UI = global.DotUI;
  var FONT = UI.FONT;
  var TEXT2 = '#b4c8c8';
  var NICK_KEY = 'dotminationvr-nickname';
  var ASKED_KEY = 'dotminationvr-name-asked';
  var MAX_LEN = 12;
  var ROWS = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
  var LEVELS = 200;   // every level's ranking is public, not only the ones you unlocked

  function store(k, v) {
    try {
      if (v === undefined) return global.localStorage.getItem(k);
      global.localStorage.setItem(k, v);
    } catch (e) { /* storage blocked */ }
    return null;
  }
  // Same fallback as the start screen: a StacksVR name on this site counts as your name too
  function currentNick() {
    return (store(NICK_KEY) || store('stacksvr-nickname') || '').trim().slice(0, MAX_LEN);
  }
  function fitText(ctx, text, weight, size, maxW) {
    var sz = size;
    ctx.font = weight + ' ' + sz + 'px ' + FONT;
    while (sz > 16 && ctx.measureText(text).width > maxW) { sz -= 2; ctx.font = weight + ' ' + sz + 'px ' + FONT; }
    return sz;
  }

  // ── Player name ──────────────────────────────────────────────────────────
  /** Save a name everywhere it is used: lobby/cross-play labels, rankings, the 2D start screen. */
  C.setPlayerName = function (name) {
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
    if (name.length < 2) return false;
    store(NICK_KEY, name);
    global.playerNickname = name;
    var input = document.getElementById('nickname-input');
    if (input) input.value = name;
    if (global.VividoHub && global.VividoHub.setNick) global.VividoHub.setNick(name);
    if (this._updateNameLabels) this._updateNameLabels();
    this.el.sceneEl.emit('player-name-changed', { name: name });
    return true;
  };

  C._nameOpen = function (opts) {
    if (!this._uiReady) this._uiInit();
    if (!this._uiReady) return;
    if (!this._nameCard) {
      this._nameCard = this._uiCard('name', 0.66, 0.52, this._drawNameCard.bind(this), this._onNameCard.bind(this));
    }
    this._nameState = {
      current: currentNick(),      // shown greyed until you type; kept if you type nothing
      text: '',
      shift: false,                // the player decides the case (no auto-capital)
      after: (opts && opts.after) || null,
      first: !!(opts && opts.first),
      msg: ''
    };
    if (this._rkCard) this._uiHide(this._rkCard);
    this._uiShow(this._nameCard, this._uiFrontPos(0.03));
  };

  C._nameClose = function (saved) {
    var st = this._nameState;
    this._uiHide(this._nameCard);
    this._nameState = null;
    store(ASKED_KEY, '1');
    if (st && st.after) st.after(saved);
  };

  C._drawNameCard = function (ctx, card) {
    var st = this._nameState || { text: '' };
    var W = card.cw, pink = this._sideColorCss('blue');
    this._uiPanel(ctx, card);
    ctx.fillStyle = '#ffffff';
    fitText(ctx, st.first ? 'Choose your player name' : 'Your player name', '700', 52, W - 200);
    ctx.fillText(st.first ? 'Choose your player name' : 'Your player name', W / 2, 78);
    ctx.font = '400 30px ' + FONT;
    ctx.fillStyle = TEXT2;
    ctx.fillText(st.msg || 'Shown to other players and in the World Rankings', W / 2, 124);
    // Text field
    var fx = 120, fw = W - 240, fy = 150, fh = 76;
    UI.roundRect(ctx, fx, fy, fw, fh, 16);
    ctx.fillStyle = '#1b3030';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = pink;
    ctx.stroke();
    var shown = st.text || '';
    ctx.font = '700 46px ' + FONT;
    ctx.fillStyle = shown ? '#ffffff' : 'rgba(180,200,200,0.5)';
    ctx.fillText(shown || st.current || 'Type a name', W / 2, fy + fh / 2 + 2);
    if (shown && Math.floor(performance.now() / 500) % 2 === 0) {
      var tw = ctx.measureText(shown).width;
      ctx.fillStyle = pink;
      ctx.fillRect(W / 2 + tw / 2 + 4, fy + 18, 4, fh - 36);
    }
    ctx.font = '400 24px ' + FONT;
    ctx.fillStyle = TEXT2;
    ctx.textAlign = 'right';
    ctx.fillText(shown.length + '/' + MAX_LEN, fx + fw - 14, fy + fh - 16);
    ctx.textAlign = 'center';
    // Keys
    var kw = 74, kh = 64, gap = 8, y = 250;
    var self = this;
    ROWS.forEach(function (row, ri) {
      var n = row.length + (ri === 3 ? 2 : 0);   // last row: shift + letters + backspace
      var x = (W - (n * kw + (n - 1) * gap)) / 2;
      if (ri === 3) {
        self._uiButton(ctx, card, { id: 'shift', x: x, y: y, w: kw, h: kh, label: 'Shift', primary: st.shift, size: 24 });
        x += kw + gap;
      }
      for (var i = 0; i < row.length; i++) {
        var ch = row[i];
        var label = /[A-Z]/.test(ch) && !st.shift ? ch.toLowerCase() : ch;
        self._uiButton(ctx, card, { id: 'k:' + label, x: x, y: y, w: kw, h: kh, label: label, size: 36 });
        x += kw + gap;
      }
      if (ri === 3) self._uiButton(ctx, card, { id: 'back', x: x, y: y, w: kw, h: kh, label: '<-', size: 32 });
      y += kh + gap;
    });
    // Bottom row: Cancel · Space · Done
    var by = y + 8;
    this._uiButton(ctx, card, { id: 'cancel', x: 70, y: by, w: 210, h: 72, label: st.first ? 'Skip' : 'Cancel', size: 34 });
    this._uiButton(ctx, card, { id: 'space', x: W / 2 - 150, y: by, w: 300, h: 72, label: 'Space', size: 32 });
    this._uiButton(ctx, card, { id: 'done', x: W - 280, y: by, w: 210, h: 72, label: 'Done', primary: true, size: 36 });
    card.redrawAt = performance.now() + 500;   // blink the caret
  };

  C._onNameCard = function (id) {
    var st = this._nameState;
    if (!st) return;
    st.msg = '';
    if (id.indexOf('k:') === 0) {
      if (st.text.length < MAX_LEN) {
        st.text += id.slice(2);
        st.shift = false;   // Shift applies to one letter, like a phone keyboard
      }
    } else if (id === 'back') {
      st.text = st.text.slice(0, -1);
    } else if (id === 'space') {
      if (st.text && st.text.length < MAX_LEN && st.text[st.text.length - 1] !== ' ') st.text += ' ';
    } else if (id === 'shift') {
      st.shift = !st.shift;
    } else if (id === 'cancel') {
      this._nameClose(false);
      return;
    } else if (id === 'done') {
      var name = st.text || st.current;
      if (this.setPlayerName(name)) { this._nameClose(true); return; }
      st.msg = 'Use at least 2 letters or numbers';
    }
    if (this._nameCard) this._nameCard.dirty = true;
  };

  // Desktop / Bluetooth keyboard typing while the name card is open
  global.addEventListener('keydown', function (e) {
    var g = document.querySelector('[dot-game]');
    var comp = g && g.components && g.components['dot-game'];
    if (!comp || !comp._nameState || !comp._nameCard || !comp._nameCard.group.visible) return;
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    var st = comp._nameState;
    if (e.key === 'Enter') comp._onNameCard('done');
    else if (e.key === 'Escape') comp._onNameCard('cancel');
    else if (e.key === 'Backspace') comp._onNameCard('back');
    else if (e.key === ' ') comp._onNameCard('space');
    else if (/^[A-Za-z0-9]$/.test(e.key)) { st.shift = false; comp._onNameCard('k:' + e.key); }
    else return;
    e.preventDefault();
  });

  // First launch without a name (the store app has no 2D start screen): ask once, then continue
  // with the usual welcome card.
  var origWelcome = C._maybeWelcome;
  C._maybeWelcome = function () {
    var self = this;
    var needs = !currentNick() && store(ASKED_KEY) !== '1' && !global.isMobileSpectator && !global.isMultiplayer;
    if (needs && !this._nameState) {
      this._nameOpen({ first: true, after: function () { setTimeout(function () { origWelcome.call(self); }, 400); } });
      return;
    }
    return origWelcome.call(this);
  };

  // ── World Rankings ───────────────────────────────────────────────────────
  // Levels tab: only levels somebody has finished, 6 per page, each with Play.
  // Tap a row for that level's top 10. Overall tab: most levels, then fastest total.
  var RK_PER_PAGE = 6;

  C._rkOpen = function (level) {
    if (!this._uiReady) this._uiInit();
    if (!this._uiReady) return;
    if (!this._rkCard) {
      this._rkCard = this._uiCard('rankings', 0.66, 0.8, this._drawRkCard.bind(this), this._onRkCard.bind(this));
    }
    this._rk = this._rk || { tab: 'levels', view: 'list', page: 0 };
    this._rk.tab = 'levels';
    if (level > 0) { this._rk.view = 'level'; this._rk.level = Math.min(LEVELS, level | 0); }
    else this._rk.view = 'list';
    if (this._nameCard) this._uiHide(this._nameCard);
    this._uiShow(this._rkCard, this._uiFrontPos(0.08));
    this._rkLoad();
  };

  C._rkLoad = function () {
    var rk = this._rk, self = this;
    rk.data = null;
    rk.state = 'loading';
    var H = global.VividoHub;
    if (!H || !H.app) { rk.state = 'off'; this._rkCard.dirty = true; return; }
    var req = ++rk.req || (rk.req = 1);
    this._rkCard.dirty = true;
    var p = rk.tab === 'overall' ? H.overall()
      : rk.view === 'level' ? H.top(rk.level)
      : (H.levels ? H.levels() : Promise.resolve(null));
    p.then(function (d) {
      if (rk.req !== req) return;
      rk.data = d;
      rk.state = d ? 'ok' : 'off';
      if (d && d.levels) {
        rk.list = d.levels;
        if (self._setWorldLevels) self._setWorldLevels(d.levels);
        rk.page = Math.min(rk.page || 0, Math.max(0, Math.ceil(d.levels.length / RK_PER_PAGE) - 1));
      }
      if (self._rkCard) self._rkCard.dirty = true;
    });
  };

  C._rkUnlocked = function (n) {
    var info = this.levelInfo ? this.levelInfo() : { max: 1 };
    return n >= 1 && n <= (info.max || 1);
  };

  // Play / lock in a row or header (no Play while in a multiplayer lobby)
  C._rkPlayBtn = function (ctx, card, n, x, y, w, h) {
    if (global.isMultiplayer) return;
    if (this._rkUnlocked(n)) {
      this._uiButton(ctx, card, { id: 'play:' + n, x: x, y: y, w: w, h: h, label: 'Play', icon: 'arrow', primary: true, size: 32 });
    } else {
      ctx.font = '400 28px ' + FONT;
      ctx.fillStyle = TEXT2;
      ctx.fillText('Locked', x + w / 2, y + h / 2 + 2);
    }
  };

  C._drawRkCard = function (ctx, card) {
    var W = card.cw, rk = this._rk || {}, pink = this._sideColorCss('blue'), teal = '#12DACE';
    var fmt = global.VividoHub ? global.VividoHub.fmtMs : function (ms) { return String(ms); };
    this._uiPanel(ctx, card);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 56px ' + FONT;
    ctx.fillText('World Rankings', W / 2, 80);
    this._uiButton(ctx, card, { id: 'close', x: W - 104, y: 44, w: 60, h: 60, label: '', icon: 'x', size: 40 });
    var tw = 250, ty = 128;
    this._uiButton(ctx, card, { id: 'tab-levels', x: W / 2 - tw - 10, y: ty, w: tw, h: 64, label: 'Levels', primary: rk.tab === 'levels', size: 34 });
    this._uiButton(ctx, card, { id: 'tab-overall', x: W / 2 + 10, y: ty, w: tw, h: 64, label: 'Overall', primary: rk.tab === 'overall', size: 34 });
    var x0 = 70, x1 = W - 70, y = 236;
    var d = rk.data;

    function message(a, b) {
      ctx.fillStyle = TEXT2; ctx.font = '400 34px ' + FONT;
      ctx.fillText(a, W / 2, 470);
      if (b) ctx.fillText(b, W / 2, 518);
    }
    function status() {
      if (rk.state === 'loading') { message('Loading…'); return true; }
      if (rk.state === 'off') { message('The rankings are not available right now.', 'Your times are saved on this headset.'); return true; }
      return false;
    }

    if (rk.tab === 'levels' && rk.view === 'list') {
      // ── All levels with times ──
      var list = rk.list || [];
      if (!status()) {
        if (!list.length) message('Nobody has finished a level yet.', 'Be the first!');
        else {
          ctx.font = '400 26px ' + FONT;
          ctx.fillStyle = TEXT2;
          ctx.textAlign = 'left';
          ctx.fillText('Level', x0, y);
          ctx.fillText('World best', x0 + 180, y);
          ctx.fillText('You', x0 + 470, y);
          ctx.textAlign = 'center';
          var pages = Math.ceil(list.length / RK_PER_PAGE);
          var page = Math.min(rk.page || 0, pages - 1);
          var rowH = 92, top = 300, playW = 150, playX = x1 - playW;
          list.slice(page * RK_PER_PAGE, (page + 1) * RK_PER_PAGE).forEach(function (r, i) {
            var yy = top + i * rowH, id = 'lv:' + r.level, hov = card.hover === id;
            var rx = x0 - 24, rw = playX - 16 - rx;
            UI.roundRect(ctx, rx, yy - rowH / 2 + 6, rw, rowH - 12, 14);
            ctx.fillStyle = hov ? 'rgba(70,111,111,0.9)' : 'rgba(255,255,255,0.05)';
            ctx.fill();
            card.buttons.push({ id: id, x: rx, y: yy - rowH / 2 + 6, w: rw, h: rowH - 12 });
            ctx.textAlign = 'left';
            ctx.font = '700 36px ' + FONT;
            ctx.fillStyle = hov ? pink : '#ffffff';
            ctx.fillText(String(r.level), x0, yy);
            ctx.fillStyle = teal;
            ctx.font = '700 34px ' + FONT;
            var bt = fmt(r.best);
            ctx.fillText(bt, x0 + 180, yy);
            var bw = ctx.measureText(bt).width;
            ctx.fillStyle = r.meBest ? pink : TEXT2;
            var who = r.meBest ? 'you' : String(r.nick || 'Player');
            fitText(ctx, who, '400', 28, 280 - bw - 16);
            ctx.fillText(who, x0 + 180 + bw + 14, yy + 1);
            ctx.font = '700 34px ' + FONT;
            if (r.mine != null) {
              ctx.fillStyle = pink;
              ctx.fillText(fmt(r.mine) + '  #' + r.rank, x0 + 470, yy);
            } else {
              ctx.fillStyle = TEXT2;
              ctx.fillText('–', x0 + 470, yy);
            }
            ctx.textAlign = 'center';
            this._rkPlayBtn(ctx, card, r.level, playX, yy - 32, playW, 64);
          }, this);
          if (pages > 1) {
            var py = top + RK_PER_PAGE * rowH - 6;
            if (page > 0) this._uiButton(ctx, card, { id: 'page-prev', x: W / 2 - 170, y: py - 32, w: 76, h: 64, label: '<', size: 38 });
            if (page < pages - 1) this._uiButton(ctx, card, { id: 'page-next', x: W / 2 + 94, y: py - 32, w: 76, h: 64, label: '>', size: 38 });
            ctx.font = '400 30px ' + FONT;
            ctx.fillStyle = TEXT2;
            ctx.fillText((page + 1) + ' / ' + pages, W / 2, py);
          }
        }
      }
    } else {
      // ── One level's top 10, or Overall ──
      var lvl = rk.tab === 'levels';
      if (lvl) {
        this._uiButton(ctx, card, { id: 'back', x: x0 - 10, y: y - 32, w: 150, h: 64, label: '< Levels', size: 30 });
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 44px ' + FONT;
        ctx.fillText('Level ' + rk.level, W / 2, y);
        this._rkPlayBtn(ctx, card, rk.level, x1 - 150 + 10, y - 32, 150, 64);
      } else {
        ctx.fillStyle = TEXT2;
        ctx.font = '400 32px ' + FONT;
        ctx.fillText('Most levels finished, then the fastest total time', W / 2, y);
      }
      var top2 = 300, rowH2 = 58, ly = top2 + 50;
      ctx.font = '400 26px ' + FONT;
      ctx.fillStyle = TEXT2;
      ctx.textAlign = 'left';
      ctx.fillText('#', x0 + 20, top2);
      ctx.fillText('Player', x0 + 100, top2);
      ctx.textAlign = 'right';
      ctx.fillText(lvl ? 'Time' : 'Levels · total time', x1 - 20, top2);
      ctx.textAlign = 'center';
      var rows = (d && d.top) || [];
      if (!status()) {
        if (!rows.length) message(lvl ? 'Nobody has finished this level yet.' : 'No rankings yet.', lvl ? 'Be the first!' : '');
        rows.forEach(function (r, i) {
          var yy = ly + i * rowH2;
          if (r.me) {
            UI.roundRect(ctx, x0 - 4, yy - rowH2 / 2 + 4, x1 - x0 + 8, rowH2 - 8, 12);
            ctx.fillStyle = 'rgba(225,17,104,0.22)';
            ctx.fill();
          }
          ctx.textAlign = 'left';
          ctx.font = '700 34px ' + FONT;
          ctx.fillStyle = i < 3 ? UI.STAR_ON : TEXT2;
          ctx.fillText(String(i + 1), x0 + 20, yy);
          ctx.fillStyle = r.me ? pink : '#ffffff';
          var name = String(r.nick || 'Player') + (r.me ? ' (you)' : '');
          fitText(ctx, name, '700', 34, x1 - x0 - 370);
          ctx.fillText(name, x0 + 100, yy);
          ctx.textAlign = 'right';
          ctx.font = '700 34px ' + FONT;
          ctx.fillStyle = r.me ? pink : teal;
          ctx.fillText(lvl ? fmt(r.ms) : r.levels + (r.levels === 1 ? ' level · ' : ' levels · ') + fmt(r.totalMs), x1 - 20, yy);
          ctx.textAlign = 'center';
        });
        var me = d && d.me, line = '';
        if (me && me.rank) {
          line = lvl ? 'You: #' + me.rank + (d.total ? ' of ' + d.total : '') + '  ·  ' + fmt(me.ms)
            : 'You: #' + me.rank + '  ·  ' + me.levels + ' levels  ·  ' + fmt(me.totalMs);
        } else if (rk.state === 'ok') {
          line = lvl ? 'Finish this level to get ranked' : 'Finish a level to join the rankings';
        }
        ctx.font = '700 34px ' + FONT;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(line, W / 2, ly + 10 * rowH2 + 12);
      }
    }
    var nick = currentNick() || 'Player';
    this._uiButton(ctx, card, { id: 'name', x: W / 2 - 230, y: card.ch - 132, w: 460, h: 74, label: 'Your name: ' + nick, size: 32 });
  };

  // Play a level straight from the rankings: ends whatever is running, starts that level vs the bot
  C._rkPlay = function (n) {
    if (global.isMultiplayer || !this._rkUnlocked(n)) return;
    this._uiHide(this._rkCard);
    var menu = document.querySelector('[vr-menu]');
    menu = menu && menu.components && menu.components['vr-menu'];
    if (menu && menu.menuVisible) menu.toggleMenu();
    if (this._dualBotPreview && this.stopLocalPreview) this.stopLocalPreview();
    else if (this.matchActive && this.onMatchEnded) this.onMatchEnded({ cancelled: true });
    if (this._endCard) this._uiHide(this._endCard);
    this.setLevel(n);
    this.startOfflineBotMatch();
  };

  C._onRkCard = function (id) {
    var rk = this._rk;
    if (!rk) return;
    if (id === 'close') { this._uiHide(this._rkCard); return; }
    if (id.indexOf('play:') === 0) { this._rkPlay(parseInt(id.slice(5), 10)); return; }
    if (id.indexOf('lv:') === 0) { rk.view = 'level'; rk.level = parseInt(id.slice(3), 10); this._rkLoad(); return; }
    if (id === 'back') { rk.view = 'list'; this._rkLoad(); return; }
    if (id === 'tab-levels' || id === 'tab-overall') {
      var t = id === 'tab-levels' ? 'levels' : 'overall';
      if (rk.tab !== t || (t === 'levels' && rk.view !== 'list')) { rk.tab = t; rk.view = 'list'; this._rkLoad(); }
    } else if (id === 'page-prev') {
      rk.page = Math.max(0, (rk.page || 0) - 1);
    } else if (id === 'page-next') {
      rk.page = (rk.page || 0) + 1;
    } else if (id === 'name') {
      var self = this, lvl = rk.view === 'level' ? rk.level : 0;
      this._nameOpen({ after: function () { self._rkOpen(lvl); } });
      return;
    }
    this._rkCard.dirty = true;
  };

  // Caret blink: redraw the name card twice a second while it's open
  var origTick = C._uiTick;
  C._uiTick = function (now) {
    if (this._nameCard && this._nameCard.group.visible && this._nameCard.redrawAt && now > this._nameCard.redrawAt) {
      this._nameCard.dirty = true;
    }
    return origTick.call(this, now);
  };
})(typeof window !== 'undefined' ? window : globalThis);
