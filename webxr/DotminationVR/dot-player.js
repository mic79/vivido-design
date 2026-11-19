// dot-player.js — DotminationVR player name + World Rankings, inside VR.
//   • Name card: an in-world keyboard (laser, finger poke, mouse; a real keyboard works too).
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
      text: currentNick(),
      shift: !currentNick(),       // first letter capital
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
    ctx.fillText(shown || 'Type a name', W / 2, fy + fh / 2 + 2);
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
        self._uiButton(ctx, card, { id: 'shift', x: x, y: y, w: kw, h: kh, label: st.shift ? 'ABC' : 'abc', size: 26 });
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
        if (st.shift && st.text.length === 1) st.shift = false;   // auto-lowercase after a capital
      }
    } else if (id === 'back') {
      st.text = st.text.slice(0, -1);
      if (!st.text) st.shift = true;
    } else if (id === 'space') {
      if (st.text && st.text.length < MAX_LEN && st.text[st.text.length - 1] !== ' ') st.text += ' ';
    } else if (id === 'shift') {
      st.shift = !st.shift;
    } else if (id === 'cancel') {
      this._nameClose(false);
      return;
    } else if (id === 'done') {
      if (this.setPlayerName(st.text)) { this._nameClose(true); return; }
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
  C._rkOpen = function (level) {
    if (!this._uiReady) this._uiInit();
    if (!this._uiReady) return;
    if (!this._rkCard) {
      this._rkCard = this._uiCard('rankings', 0.66, 0.8, this._drawRkCard.bind(this), this._onRkCard.bind(this));
    }
    var info = this.levelInfo ? this.levelInfo() : { level: 1, max: 200 };
    this._rk = this._rk || { tab: 'level' };
    this._rk.level = level || this._rk.level || Math.max(1, info.level || 1);
    this._rk.max = Math.max(1, info.max || 200);
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
    var p = rk.tab === 'overall' ? H.overall() : H.top(rk.level);
    p.then(function (d) {
      if (rk.req !== req) return;
      rk.data = d;
      rk.state = d ? 'ok' : 'off';
      if (self._rkCard) self._rkCard.dirty = true;
    });
  };

  C._drawRkCard = function (ctx, card) {
    var W = card.cw, rk = this._rk || {}, pink = this._sideColorCss('blue'), teal = '#12DACE';
    this._uiPanel(ctx, card);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 56px ' + FONT;
    ctx.fillText('World Rankings', W / 2, 80);
    this._uiButton(ctx, card, { id: 'close', x: W - 104, y: 44, w: 60, h: 60, label: '', icon: 'x', size: 40 });
    // Tabs
    var tw = 250, ty = 128;
    this._uiButton(ctx, card, { id: 'tab-level', x: W / 2 - tw - 10, y: ty, w: tw, h: 64, label: 'This level', primary: rk.tab === 'level', size: 34 });
    this._uiButton(ctx, card, { id: 'tab-overall', x: W / 2 + 10, y: ty, w: tw, h: 64, label: 'Overall', primary: rk.tab === 'overall', size: 34 });
    var y = 236;
    if (rk.tab === 'level') {
      this._uiButton(ctx, card, { id: 'prev', x: 150, y: y - 34, w: 76, h: 68, label: '<', size: 40 });
      this._uiButton(ctx, card, { id: 'next', x: W - 226, y: y - 34, w: 76, h: 68, label: '>', size: 40 });
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 44px ' + FONT;
      ctx.fillText('Level ' + rk.level, W / 2, y);
    } else {
      ctx.fillStyle = TEXT2;
      ctx.font = '400 32px ' + FONT;
      ctx.fillText('Most levels finished, then the fastest total time', W / 2, y);
    }
    // List
    var top = 300, rowH = 58, x0 = 90, x1 = W - 90;
    ctx.font = '400 26px ' + FONT;
    ctx.fillStyle = TEXT2;
    ctx.textAlign = 'left';
    ctx.fillText('#', x0, top);
    ctx.fillText('Player', x0 + 80, top);
    ctx.textAlign = 'right';
    ctx.fillText(rk.tab === 'overall' ? 'Levels · total time' : 'Time', x1, top);
    ctx.textAlign = 'center';
    var d = rk.data;
    var rows = (d && d.top) || [];
    var ly = top + 50;
    if (rk.state === 'loading') {
      ctx.fillStyle = TEXT2; ctx.font = '400 34px ' + FONT;
      ctx.fillText('Loading…', W / 2, ly + 120);
    } else if (rk.state === 'off') {
      ctx.fillStyle = TEXT2; ctx.font = '400 32px ' + FONT;
      ctx.fillText('The rankings are not available right now.', W / 2, ly + 100);
      ctx.fillText('Your times are saved on this headset.', W / 2, ly + 146);
    } else if (!rows.length) {
      ctx.fillStyle = TEXT2; ctx.font = '400 34px ' + FONT;
      ctx.fillText(rk.tab === 'overall' ? 'No rankings yet.' : 'Nobody has finished this level yet.', W / 2, ly + 100);
      if (rk.tab === 'level') ctx.fillText('Be the first!', W / 2, ly + 148);
    } else {
      var fmt = global.VividoHub.fmtMs;
      rows.forEach(function (r, i) {
        var yy = ly + i * rowH;
        if (r.me) {
          UI.roundRect(ctx, x0 - 24, yy - rowH / 2 + 4, x1 - x0 + 48, rowH - 8, 12);
          ctx.fillStyle = 'rgba(225,17,104,0.22)';
          ctx.fill();
        }
        var col = r.me ? pink : '#ffffff';
        ctx.textAlign = 'left';
        ctx.font = '700 34px ' + FONT;
        ctx.fillStyle = i < 3 ? UI.STAR_ON : TEXT2;
        ctx.fillText(String(i + 1), x0, yy);
        ctx.fillStyle = col;
        var name = String(r.nick || 'Player') + (r.me ? ' (you)' : '');
        fitText(ctx, name, '700', 34, x1 - x0 - 330);
        ctx.fillText(name, x0 + 80, yy);
        ctx.textAlign = 'right';
        ctx.font = '700 34px ' + FONT;
        ctx.fillStyle = r.me ? pink : teal;
        var val = rk.tab === 'overall'
          ? r.levels + (r.levels === 1 ? ' level · ' : ' levels · ') + fmt(r.totalMs)
          : fmt(r.ms);
        ctx.fillText(val, x1, yy);
        ctx.textAlign = 'center';
      });
    }
    // Your position
    var my = ly + 10 * rowH + 12;
    ctx.font = '700 34px ' + FONT;
    ctx.fillStyle = '#ffffff';
    var me = d && d.me;
    var line = '';
    if (rk.state === 'ok') {
      if (me && me.rank) {
        line = rk.tab === 'overall'
          ? 'You: #' + me.rank + '  ·  ' + me.levels + ' levels  ·  ' + global.VividoHub.fmtMs(me.totalMs)
          : 'You: #' + me.rank + (d.total ? ' of ' + d.total : '') + '  ·  ' + global.VividoHub.fmtMs(me.ms);
      } else {
        line = rk.tab === 'overall' ? 'Finish a level to join the rankings' : 'Finish this level to get ranked';
      }
    }
    ctx.fillText(line, W / 2, my);
    // Name
    var nick = currentNick() || 'Player';
    this._uiButton(ctx, card, { id: 'name', x: W / 2 - 230, y: card.ch - 132, w: 460, h: 74, label: 'Your name: ' + nick, size: 32 });
  };

  C._onRkCard = function (id) {
    var rk = this._rk;
    if (!rk) return;
    if (id === 'close') { this._uiHide(this._rkCard); return; }
    if (id === 'tab-level' || id === 'tab-overall') {
      var t = id === 'tab-level' ? 'level' : 'overall';
      if (rk.tab !== t) { rk.tab = t; this._rkLoad(); }
    } else if (id === 'prev') {
      rk.level = rk.level > 1 ? rk.level - 1 : rk.max;
      this._rkLoad();
    } else if (id === 'next') {
      rk.level = rk.level < rk.max ? rk.level + 1 : 1;
      this._rkLoad();
    } else if (id === 'name') {
      var self = this, lvl = rk.level;
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
