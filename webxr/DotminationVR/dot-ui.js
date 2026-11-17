// dot-ui.js — DotminationVR in-world UI, in the original app's (dark-mode) brand style:
//   • brand cards (darkslategrey, Roboto Condensed, pink "selected" glow) with buttons that work
//     with the VR laser + trigger, a finger poke, and the desktop mouse
//   • the original 5-step interactive tutorial (modules/tutorial.js), incl. the first-run
//     "Welcome to Dotmination!" card
//   • the original round end card ("Dotmination!" · 3 stars · Retry / Next / Next Level / Rematch)
// Extends the dot-game component (loaded after dot-game.js).
(function (global) {
  'use strict';
  if (!global.AFRAME || !AFRAME.components['dot-game']) {
    console.error('[dot-ui] dot-game must load first');
    return;
  }
  var C = AFRAME.components['dot-game'].Component.prototype;
  var THREE = global.THREE;

  var FONT = "'Roboto Condensed', 'Arial Narrow', Arial, sans-serif";
  var SLATE = '#2F4F4F';          // original .dark-mode card / modal (darkslategrey)
  var SLATE_DEEP = '#243d3d';
  var SLATE_BTN = '#3b6161';
  var TEXT2 = '#b4c8c8';
  var STAR_ON = '#FFC94D';
  var STAR_OFF = 'rgba(127,127,127,0.55)'; // original --color-neutral
  var PX_PER_M = 1400;                     // card canvas resolution
  var TUT_KEY = 'dotminationvr-tutorial-seen'; // original localStorage 'hasPlayedBefore'
  var POKE_UI = 0.025;

  // ── Small drawing helpers ───────────────────────────────────────────────
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function star(ctx, cx, cy, r, fill) {
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 5;
      var rr = i % 2 === 0 ? r : r * 0.45;
      ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }
  // Simple line icons (FontAwesome isn't available in a canvas): undo, arrow, shuffle, cap, x
  function icon(ctx, kind, cx, cy, s, color) {
    ctx.save();
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = s * 0.16; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    if (kind === 'undo') {
      ctx.arc(cx, cy, s * 0.42, Math.PI * 1.05, Math.PI * 2.75);
      ctx.stroke();
      ctx.beginPath();
      var ax = cx - s * 0.42, ay = cy - s * 0.08;
      ctx.moveTo(ax - s * 0.2, ay - s * 0.12); ctx.lineTo(ax, ay + s * 0.08); ctx.lineTo(ax + s * 0.18, ay - s * 0.14);
      ctx.stroke();
    } else if (kind === 'arrow') {
      ctx.moveTo(cx - s * 0.45, cy); ctx.lineTo(cx + s * 0.4, cy);
      ctx.moveTo(cx + s * 0.1, cy - s * 0.32); ctx.lineTo(cx + s * 0.42, cy); ctx.lineTo(cx + s * 0.1, cy + s * 0.32);
      ctx.stroke();
    } else if (kind === 'shuffle') {
      ctx.moveTo(cx - s * 0.48, cy + s * 0.3); ctx.bezierCurveTo(cx - s * 0.05, cy + s * 0.3, cx + s * 0.05, cy - s * 0.3, cx + s * 0.42, cy - s * 0.3);
      ctx.moveTo(cx - s * 0.48, cy - s * 0.3); ctx.bezierCurveTo(cx - s * 0.05, cy - s * 0.3, cx + s * 0.05, cy + s * 0.3, cx + s * 0.42, cy + s * 0.3);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + s * 0.24, cy - s * 0.46); ctx.lineTo(cx + s * 0.46, cy - s * 0.3); ctx.lineTo(cx + s * 0.24, cy - s * 0.14);
      ctx.moveTo(cx + s * 0.24, cy + s * 0.14); ctx.lineTo(cx + s * 0.46, cy + s * 0.3); ctx.lineTo(cx + s * 0.24, cy + s * 0.46);
      ctx.stroke();
    } else if (kind === 'cap') {
      ctx.moveTo(cx - s * 0.5, cy - s * 0.1); ctx.lineTo(cx, cy - s * 0.35); ctx.lineTo(cx + s * 0.5, cy - s * 0.1);
      ctx.lineTo(cx, cy + s * 0.15); ctx.closePath(); ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.28, cy + s * 0.02); ctx.lineTo(cx - s * 0.28, cy + s * 0.3);
      ctx.quadraticCurveTo(cx, cy + s * 0.45, cx + s * 0.28, cy + s * 0.3); ctx.lineTo(cx + s * 0.28, cy + s * 0.02);
      ctx.stroke();
    } else if (kind === 'layers') {
      for (var k = 0; k < 3; k++) {
        var y = cy - s * 0.3 + k * s * 0.28;
        ctx.moveTo(cx - s * 0.45, y); ctx.lineTo(cx, y + s * 0.2); ctx.lineTo(cx + s * 0.45, y);
      }
      ctx.stroke();
    } else if (kind === 'x') {
      ctx.moveTo(cx - s * 0.3, cy - s * 0.3); ctx.lineTo(cx + s * 0.3, cy + s * 0.3);
      ctx.moveTo(cx + s * 0.3, cy - s * 0.3); ctx.lineTo(cx - s * 0.3, cy + s * 0.3);
      ctx.stroke();
    }
    ctx.restore();
  }
  function lighten(hex, amt) {
    var c = new THREE.Color(hex);
    c.lerp(new THREE.Color('#ffffff'), amt);
    return '#' + c.getHexString();
  }
  // Largest font size (≤ size) at which text fits maxW
  function fit(ctx, text, weight, size, maxW) {
    var sz = size;
    ctx.font = weight + ' ' + sz + 'px ' + FONT;
    while (sz > 18 && ctx.measureText(text).width > maxW) { sz -= 2; ctx.font = weight + ' ' + sz + 'px ' + FONT; }
    return sz;
  }
  function wrap(ctx, text, maxW) {
    var words = String(text).split(' '), lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = words[i]; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  // Rich text line: [{t, c, b}] segments, wrapped
  function richLines(ctx, segs, maxW, size) {
    var words = [];
    segs.forEach(function (sg) {
      String(sg.t).split(' ').forEach(function (w, i, arr) {
        if (w === '' && i < arr.length - 1) return;
        words.push({ t: w, c: sg.c, b: sg.b });
      });
    });
    var lines = [], line = [], width = 0;
    words.forEach(function (w) {
      ctx.font = (w.b ? '700 ' : '400 ') + size + 'px ' + FONT;
      var ww = ctx.measureText(w.t + ' ').width;
      if (width + ww > maxW && line.length) { lines.push(line); line = []; width = 0; }
      line.push({ t: w.t, c: w.c, b: w.b, w: ww });
      width += ww;
    });
    if (line.length) lines.push(line);
    return lines;
  }
  function drawRich(ctx, lines, cx, y, size, lineH, defColor) {
    lines.forEach(function (ln) {
      var tot = ln.reduce(function (a, w) { return a + w.w; }, 0);
      var x = cx - tot / 2;
      ctx.textAlign = 'left';
      ln.forEach(function (w) {
        ctx.font = (w.b ? '700 ' : '400 ') + size + 'px ' + FONT;
        ctx.fillStyle = w.c || defColor;
        ctx.fillText(w.t, x, y);
        x += w.w;
      });
      y += lineH;
    });
    ctx.textAlign = 'center';
    return y;
  }

  // Shared with game-menu.js (level strip)
  global.DotUI = { FONT: FONT, star: star, icon: icon, roundRect: roundRect, STAR_ON: STAR_ON, STAR_OFF: STAR_OFF };

  /** Original level list stars: won · under 2:00 · under 1:00 (from the saved best time). */
  C.levelStars = function (n) {
    var e = this.progress && this.progress.levels && this.progress.levels['level' + n];
    if (!e || !e.time) return { stars: 0, time: null };
    var parts = String(e.time).split(':');
    var secs = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
    return { stars: 1 + (secs < 120 ? 1 : 0) + (secs < 60 ? 1 : 0), time: e.time };
  };

  /** Original "View Stats": best / worst level time. */
  C.levelTimeExtremes = function () {
    var best = null, worst = null;
    var lv = (this.progress && this.progress.levels) || {};
    for (var k in lv) {
      if (!lv[k] || !lv[k].time) continue;
      var parts = String(lv[k].time).split(':');
      var secs = (parseInt(parts[0], 10) || 0) * 60 + (parseInt(parts[1], 10) || 0);
      var n = parseInt(k.replace('level', ''), 10);
      if (!best || secs < best.secs) best = { secs: secs, time: lv[k].time, level: n };
      if (!worst || secs > worst.secs) worst = { secs: secs, time: lv[k].time, level: n };
    }
    return { best: best, worst: worst };
  };

  // ── Cards ────────────────────────────────────────────────────────────────
  C._uiInit = function () {
    if (this._uiReady || !this._sceneRoot) return;
    this._uiReady = true;
    this._uiCards = [];
    this._uiRay = new THREE.Raycaster();
    this._uiPoke = { leftHand: { armed: true }, rightHand: { armed: true } };
    var self = this;
    // Brand font (original Roboto Condensed): redraw everything once it has loaded
    if (document.fonts && document.fonts.load) {
      Promise.all([
        document.fonts.load('700 40px "Roboto Condensed"'),
        document.fonts.load('400 40px "Roboto Condensed"')
      ]).then(function () {
        self._uiCards.forEach(function (c) { c.dirty = true; });
        var b = self.boards && self.boards.shared;
        if (b && b.label) b.label.last = '';
        if (self._stationCards) for (var k in self._stationCards) self._stationCards[k].last = '';
      }).catch(function () {});
    }
    this._welcomeCard = this._uiCard('welcome', 0.56, 0.36, this._drawWelcome.bind(this), this._onWelcome.bind(this));
    this._tutCard = this._uiCard('tutorial', 0.34, 0.5, this._drawTutorialCard.bind(this), this._onTutorial.bind(this));
    this._endCard = this._uiCard('end', 0.58, 0.58, this._drawEndCard.bind(this), this._onEndCard.bind(this));
    this._endCard.round = true;
    // First visit (original checkStartTutorial): welcome card, solo only
    setTimeout(function () { self._maybeWelcome(); }, 1500);
  };

  C._uiCard = function (id, wM, hM, drawFn, onPress) {
    var cw = Math.round(wM * PX_PER_M), ch = Math.round(hM * PX_PER_M);
    var canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    var tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, toneMapped: false
    }));
    mesh.renderOrder = 30; // after the glass (2), dot stacks (3-4) and lasers' board pass
    var group = new THREE.Group();
    group.add(mesh);
    group.visible = false;
    this._sceneRoot.add(group);
    var card = {
      id: id, w: wM, h: hM, cw: cw, ch: ch, canvas: canvas, ctx: canvas.getContext('2d'), tex: tex,
      mesh: mesh, group: group, buttons: [], hover: null, draw: drawFn, onPress: onPress,
      dirty: true, shownAt: 0, flash: 0
    };
    this._uiCards.push(card);
    return card;
  };

  C._uiShow = function (card, pos) {
    if (!card) return;
    if (pos) card.group.position.set(pos.x, pos.y, pos.z);
    if (!card.group.visible) card.shownAt = performance.now();
    card.group.visible = true;
    card.dirty = true;
  };
  C._uiHide = function (card) {
    if (!card) return;
    card.group.visible = false;
    card.hover = null;
  };

  C._uiRedraw = function (card) {
    var ctx = card.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, card.cw, card.ch);
    card.buttons = [];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    card.draw(ctx, card);
    card.tex.needsUpdate = true;
    card.dirty = false;
  };

  // Brand card background (rounded darkslategrey, soft glow like the app's box-shadow)
  C._uiPanel = function (ctx, card, glowColor) {
    var m = 24, r = 34;
    ctx.save();
    ctx.shadowColor = glowColor || 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 24;
    roundRect(ctx, m, m, card.cw - 2 * m, card.ch - 2 * m, r);
    ctx.fillStyle = 'rgba(47,79,79,0.96)';
    ctx.fill();
    ctx.restore();
  };

  // Button = original ".card.btn": slate card; hover = ".selected" (pink text + pink glow)
  C._uiButton = function (ctx, card, b) {
    var hov = card.hover === b.id;
    var pink = this._sideColorCss('blue');
    ctx.save();
    ctx.shadowColor = hov ? pink : 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = hov ? 28 : 12;
    roundRect(ctx, b.x, b.y, b.w, b.h, 18);
    ctx.fillStyle = b.primary ? (hov ? lighten(pink, 0.18) : pink) : (hov ? '#466f6f' : SLATE_BTN);
    ctx.fill();
    ctx.restore();
    var fg = b.primary ? '#ffffff' : (hov ? pink : '#ffffff');
    var size = b.size || 46;
    ctx.font = '700 ' + size + 'px ' + FONT;
    var tw = ctx.measureText(b.label).width;
    var iconS = b.icon ? size * 0.9 : 0;
    var gap = b.icon ? size * 0.35 : 0;
    var x0 = b.x + b.w / 2 - (tw + iconS + gap) / 2;
    ctx.fillStyle = fg;
    ctx.textAlign = 'left';
    ctx.fillText(b.label, x0, b.y + b.h / 2 + 2);
    ctx.textAlign = 'center';
    if (b.icon) icon(ctx, b.icon, x0 + tw + gap + iconS / 2, b.y + b.h / 2, iconS, fg);
    card.buttons.push(b);
  };

  // ── Picking (laser / mouse / poke) ─────────────────────────────────────────
  C._uiPickRay = function (origin, dir) {
    if (!this._uiCards) return null;
    var best = null;
    this._uiRay.set(origin, dir);
    for (var i = 0; i < this._uiCards.length; i++) {
      var c = this._uiCards[i];
      if (!c.group.visible || !c.buttons.length) continue;
      var hits = this._uiRay.intersectObject(c.mesh, false);
      if (!hits.length || !hits[0].uv) continue;
      var h = hits[0];
      var px = h.uv.x * c.cw, py = (1 - h.uv.y) * c.ch;
      var btn = null;
      for (var k = 0; k < c.buttons.length; k++) {
        var b = c.buttons[k];
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) { btn = b; break; }
      }
      if (!best || h.distance < best.dist) best = { card: c, btn: btn, dist: h.distance, point: h.point };
    }
    return best;
  };

  C._uiPokeAt = function (pos) {
    if (!this._uiCards) return null;
    var best = null;
    var local = new THREE.Vector3();
    for (var i = 0; i < this._uiCards.length; i++) {
      var c = this._uiCards[i];
      if (!c.group.visible || !c.buttons.length) continue;
      c.mesh.updateMatrixWorld(true);
      local.copy(pos);
      c.mesh.worldToLocal(local);
      var sx = c.group.scale.x || 1;
      var dist = Math.abs(local.z) * sx;
      var px = (local.x / c.w + 0.5) * c.cw, py = (0.5 - local.y / c.h) * c.ch;
      for (var k = 0; k < c.buttons.length; k++) {
        var b = c.buttons[k];
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) {
          if (!best || dist < best.dist) best = { card: c, btn: b, dist: dist };
        }
      }
    }
    return best;
  };

  C._uiPickHand = function (hand) {
    var r = this._handRay(hand);
    return r ? this._uiPickRay(r.origin, r.dir) : null;
  };

  C._uiPickMouse = function (e) {
    var cam = this.el.sceneEl.camera, canvas = this.el.sceneEl.canvas;
    if (!cam || !canvas || !this._uiCards) return null;
    var rect = canvas.getBoundingClientRect();
    var ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    var rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, cam);
    return this._uiPickRay(rc.ray.origin, rc.ray.direction);
  };

  /** Returns true if the pick landed on a card (button pressed or card blocking the board). */
  C._uiPress = function (pick, hand) {
    if (!pick) return false;
    if (pick.btn) {
      this._pulseHaptic(hand, 0.5, 30);
      this._sfx('click', { volume: 0.4 });
      pick.card.onPress(pick.btn.id, pick.btn);
    }
    return true;
  };

  C._uiAnyInteractive = function () {
    if (!this._uiCards) return false;
    for (var i = 0; i < this._uiCards.length; i++) {
      if (this._uiCards[i].group.visible && this._uiCards[i].buttons.length) return true;
    }
    return false;
  };

  // Called every frame from dot-game tick
  C._uiTick = function (now) {
    if (!this._uiReady) { this._uiInit(); if (!this._uiReady) return; }
    // The welcome card is for a solo player only (never spectators / lobbies)
    if (this._welcomeCard && this._welcomeCard.group.visible && (global.isMobileSpectator || global.isMultiplayer)) {
      this._uiHide(this._welcomeCard);
    }
    var cam = this.el.sceneEl && this.el.sceneEl.camera;
    var camPos = this._uiCamPos || (this._uiCamPos = new THREE.Vector3());
    if (cam) cam.getWorldPosition(camPos);
    // Hover from both lasers (VR) or the mouse (desktop)
    var hovers = {};
    var presenting = this._isPresenting();
    var self = this;
    if (presenting) {
      ['leftHand', 'rightHand'].forEach(function (id) {
        var hand = document.getElementById(id);
        var rc = hand && hand.components && hand.components.raycaster;
        if (rc && rc.data && rc.data.enabled && rc.data.showLine) return; // menu laser owns this hand
        var p = hand && self._uiPickHand(hand);
        self._uiHits = self._uiHits || {};
        self._uiHits[id] = p;
        if (p && p.btn) hovers[p.card.id] = p.btn.id;
        // Hover tick on the hand that is pointing (same feel as the menu buttons)
        self._uiHoverKey = self._uiHoverKey || {};
        var key = p && p.btn ? p.card.id + ':' + p.btn.id : '';
        if (key !== (self._uiHoverKey[id] || '')) {
          self._uiHoverKey[id] = key;
          if (key) self._pulseHaptic(hand, 0.35, 28);
        }
        // Finger poke with the index fingertip (not the controller/laser origin)
        var tipPos = hand && self._fingerTip(hand);
        var pk = tipPos && self._uiPokeAt(tipPos);
        var st = self._uiPoke[id];
        if (!pk || pk.dist > POKE_UI * 2.5) st.armed = true;
        if (pk && pk.btn && st.armed && pk.dist < POKE_UI) { st.armed = false; self._uiPress(pk, hand); }
      });
    } else if (this._mouseEvt && !global.isMobileSpectator) {
      var pm = this._uiPickMouse(this._mouseEvt);
      if (pm && pm.btn) hovers[pm.card.id] = pm.btn.id;
    }
    for (var i = 0; i < this._uiCards.length; i++) {
      var c = this._uiCards[i];
      if (!c.group.visible) continue;
      var hv = hovers[c.id] || null;
      if (hv !== c.hover) { c.hover = hv; c.dirty = true; }
      // Face the viewer (yaw only), like the name labels
      c.group.rotation.set(0, Math.atan2(camPos.x - c.group.position.x, camPos.z - c.group.position.z), 0);
      // Original end-card entrance: scale 0 → 1, elastic.out(1, 0.3) over ~2 s
      var age = (now - c.shownAt) / 1000;
      var sc = c.round ? elasticOut(Math.min(1, age / 1.6)) : Math.min(1, 0.85 + age * 2.5);
      c.group.scale.setScalar(Math.max(0.001, sc));
      if (c.id === 'tutorial' && this._tutorial && this._tutorial.flashUntil > now) c.dirty = true;
      if (c.dirty) this._uiRedraw(c);
    }
    // Tutorial: evaluate the step once the chain has finished animating (original animateNextDot callback)
    if (this._tutorial && this._tutorial.pending && !this.boards.shared.view.busy()) {
      this._tutorial.pending = false;
      this._tutorialCheck();
    }
  };

  function elasticOut(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    var p = 0.3;
    return Math.pow(2, -10 * t) * Math.sin((t - p / 4) * (2 * Math.PI) / p) + 1;
  }

  // Where cards go: in front of the board on the viewer's side (end / welcome), or beside it
  C._uiFrontPos = function (yOff) {
    var b = this.boards.shared, p = b.view.root.position;
    var cam = this.el.sceneEl && this.el.sceneEl.camera;
    var v = new THREE.Vector3(p.x, p.y, p.z + 1);
    if (cam) cam.getWorldPosition(v);
    var side = v.z >= p.z ? 1 : -1;
    return { x: p.x, y: p.y + (yOff || 0), z: p.z + side * 0.13 };
  };

  // ── Welcome (original .welcome-tutorial-modal) ────────────────────────────
  C._maybeWelcome = function () {
    var seen = false;
    try { seen = localStorage.getItem(TUT_KEY) === 'true'; } catch (e) {}
    if (seen || global.isMultiplayer || global.isMobileSpectator || this._tutorial) return;
    if (this.matchActive && !this._dualBotPreview) return;
    this._uiShow(this._welcomeCard, this._uiFrontPos(0.02));
  };

  C._drawWelcome = function (ctx, card) {
    var W = card.cw, pink = this._sideColorCss('blue');
    this._uiPanel(ctx, card);
    ctx.fillStyle = '#ffffff';
    fit(ctx, 'Welcome to Dotmination!', '700', 64, W - 220);
    ctx.fillText('Welcome to Dotmination!', W / 2, 110);
    ctx.font = '400 38px ' + FONT;
    ctx.fillStyle = TEXT2;
    ctx.fillText('Learn the basics with a quick interactive tutorial.', W / 2, 172);
    var bw = 270, bh = 160, gap = 40, y = 215;
    this._uiTile(ctx, card, { id: 'start', x: W / 2 - bw - gap / 2, y: y, w: bw, h: bh, label: 'Start Tutorial', icon: 'cap' });
    this._uiTile(ctx, card, { id: 'level1', x: W / 2 + gap / 2, y: y, w: bw, h: bh, label: 'Play Level 1', icon: 'layers' });
    ctx.font = '400 30px ' + FONT;
    ctx.fillStyle = TEXT2;
    ctx.fillText('You can start it anytime from the menu: HOW TO PLAY.', W / 2, card.ch - 60);
    this._uiButton(ctx, card, { id: 'close', x: W - 96, y: 36, w: 56, h: 56, label: '', icon: 'x', size: 38 });
  };

  // Original mode card: big icon over a caption, ".selected" pink on hover
  C._uiTile = function (ctx, card, b) {
    var hov = card.hover === b.id, pink = this._sideColorCss('blue');
    ctx.save();
    ctx.shadowColor = hov ? pink : 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = hov ? 30 : 12;
    roundRect(ctx, b.x, b.y, b.w, b.h, 20);
    ctx.fillStyle = hov ? '#466f6f' : SLATE_BTN;
    ctx.fill();
    ctx.restore();
    var fg = hov ? pink : '#ffffff';
    icon(ctx, b.icon, b.x + b.w / 2, b.y + b.h * 0.38, 58, fg);
    ctx.font = '700 38px ' + FONT;
    ctx.fillStyle = fg;
    ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h * 0.78);
    card.buttons.push(b);
  };

  C._markTutorialSeen = function () {
    try { localStorage.setItem(TUT_KEY, 'true'); } catch (e) {}
  };

  C._onWelcome = function (id) {
    this._markTutorialSeen();
    this._uiHide(this._welcomeCard);
    if (id === 'start') this.startTutorial();
    else if (id === 'level1') { this.setLevel(1); this.startOfflineBotMatch(); }
  };

  // ── Tutorial (original modules/tutorial.js, 1:1 steps / maps / checks / wording) ──
  // Original maps (45-char strings, "6"/"A" = player--2 stage 1/5, "3"/"5" = player--1 stage 3/5);
  // player--2 = you (pink, seat "blue"), player--1 = opponent (teal, seat "red").
  var TUT = {
    2: { you: [[15, 1]], opp: [], target: [15] },
    3: { you: [[11, 5]], opp: [[10, 3]], target: [11] },
    4: { you: [[5, 5], [11, 5], [15, 5]], opp: [[7, 5], [10, 5]], target: [5, 11, 15] }
  };

  C.startTutorial = function () {
    if (global.isMultiplayer) return false; // solo only (as in the app)
    if (this._dualIdleTimer) { clearTimeout(this._dualIdleTimer); this._dualIdleTimer = null; }
    this._clearVictory();
    this._clearMatchBanner();
    this._uiHide(this._welcomeCard);
    this._uiHide(this._endCard);
    this._markTutorialSeen();
    this._dualBotPreview = false;
    global.offlinePreview = false;
    global.isLobbyBotMatch = false;
    this._endingMatch = false;
    this._endPending = false;
    this._levelMatch = 0;
    this._seats = { blue: { bot: false }, red: { bot: true } };
    this.matchActive = true;
    this.matchState = 'PLAYING';
    this._tutorial = { step: 0, pending: false, flashUntil: 0 };
    if (this._showMatchBodies) this._showMatchBodies({ showBot: true });
    this._musicIdle();
    this._tutorialAdvance();
    return true;
  };

  C._tutorialAdvance = function () {
    var t = this._tutorial;
    if (!t) return;
    t.step++;
    t.pending = false;
    var b = this.boards.shared;
    if (t.step <= 4) {
      b.state.clear();
      var spec = TUT[t.step];
      if (spec) {
        spec.you.forEach(function (d) { b.state.owner[d[0]] = 1; b.state.stage[d[0]] = d[1]; });
        spec.opp.forEach(function (d) { b.state.owner[d[0]] = 2; b.state.stage[d[0]] = d[1]; });
      }
      b.turn = 'blue';
      b.turnNo = 0;
      b.rev = 0;
      b._pitch = 0;
      b.view.setBotChoice(-1);
      b.view.syncFrom(b.state);
      b.view.setHighlights(spec ? spec.target : []);
      this._refreshScores();
    } else {
      b.view.setHighlights([]);
    }
    // Step card beside the board, on your side (the app's step modal, no backdrop)
    var p = b.view.root.position;
    this._uiShow(this._tutCard, { x: p.x - b.view.width / 2 - 0.2, y: p.y + 0.04, z: p.z + 0.06 });
    this._tutCard.shownAt = performance.now();
    this._tutCard.dirty = true;
    this._updateBoardLabels(performance.now(), true);
  };

  /** Original handleTutorialDotClick: only the step's dots respond. */
  C._tutorialTap = function (board, idx, handEl) {
    var t = this._tutorial;
    if (!t || t.step > 4 || board.view.busy() || t.pending) return false;
    var o = board.state.owner[idx];
    var ok = false;
    if (t.step === 1) ok = o === 0;                                   // claim empty dots
    else ok = o === 1 && TUT[t.step].target.indexOf(idx) >= 0;       // your highlighted dot(s)
    if (!ok) {
      t.flashUntil = performance.now() + 700;
      this._tutCard.dirty = true;
      this._pulseHaptic(handEl, 0.2, 40);
      this._sfx('rotate', { volume: 0.15, rate: 0.6 });
      return false;
    }
    this._pulseHaptic(handEl, 0.55, 35);
    var res = this._performMove(board, 'blue', idx, { human: true });
    board.turn = 'blue'; // the tutorial never hands the turn over
    if (t.step === 2) t.target = idx;
    t.pending = true;
    this._tutCard.dirty = true;
    return !!res;
  };

  /** Original checkTutorialStepCompletionInternal + updateTutorialFeedback. */
  C._tutorialCheck = function () {
    var t = this._tutorial;
    if (!t) return;
    var st = this.boards.shared.state;
    var done = false;
    if (t.step === 1) done = st.count('blue') >= 3;
    else if (t.step === 2) done = st.stage[15] >= 5;
    else if (t.step === 3) done = st.owner[10] === 1;
    else if (t.step === 4) done = st.owner[7] === 1 || st.owner[10] === 1;
    this._tutCard.dirty = true;
    if (done) {
      var self = this;
      t.done = true;
      this._sfx('place', { volume: 0.5, rate: 1.3 });
      setTimeout(function () { if (self._tutorial === t) { t.done = false; self._tutorialAdvance(); } }, 900);
    }
  };

  C._tutorialObjective = function () {
    var t = this._tutorial, st = this.boards.shared.state, pink = this._sideColorCss('blue');
    if (!t) return [];
    var you = { t: 'your', c: pink, b: true };
    switch (t.step) {
      case 1: return [{ t: 'Claim any 3 empty dots. (' + Math.min(3, st.count('blue')) + '/3 claimed)' }];
      case 2:
        return st.stage[15] >= 5 ? [{ t: 'Dot reached Stage 5!' }]
          : [{ t: 'Tap ' }, you, { t: 'highlighted dot until it reaches Stage 5. (Currently Stage ' + st.stage[15] + '/5)' }];
      case 3:
        return st.owner[10] === 1 ? [{ t: "Opponent's dot captured!" }]
          : [{ t: 'Tap ' }, { t: 'your Stage 5 dot', c: pink, b: true }, { t: "to take over the opponent's dot." }];
      case 4:
        return (st.owner[7] === 1 || st.owner[10] === 1) ? [{ t: 'Chain reaction complete!' }]
          : [{ t: 'Tap one of ' }, { t: 'your dots', c: pink, b: true }, { t: 'to start a chain reaction.' }];
      default: return [];
    }
  };

  var TUT_TEXT = {
    1: { title: 'Claiming Dots', body: 'The game field is made of dots. Each turn you can add 1 dot. Tap empty dots to claim them for your color.' },
    2: { title: 'Growing Dots', body: 'Tapping your own dot again makes it grow +1. Dots grow from Stage 1 up to Stage 5.' },
    3: { title: 'Explosions & Take-overs', body: 'Tapping a dot at Stage 5 makes it explode, adding a stage to neighboring dots and converting them to your color.' },
    4: { title: 'Chain Reactions', body: 'It all adds up, so one explosion can trigger chain reactions.' }
  };

  C._drawTutorialCard = function (ctx, card) {
    var t = this._tutorial;
    if (!t) return;
    var W = card.cw, pink = this._sideColorCss('blue');
    var flash = t.flashUntil > performance.now();
    this._uiPanel(ctx, card, flash ? 'rgba(255,90,90,0.8)' : null);
    var y;
    if (t.step <= 4) {
      var tx = TUT_TEXT[t.step];
      ctx.fillStyle = TEXT2;
      ctx.font = '400 32px ' + FONT;
      ctx.fillText('Step ' + t.step + ' of 4', W / 2, 78);
      ctx.fillStyle = pink;
      fit(ctx, tx.title, '700', 52, W - 80);
      ctx.fillText(tx.title, W / 2, 132);
      ctx.fillStyle = '#ffffff';
      ctx.font = '400 33px ' + FONT;
      y = 194;
      wrap(ctx, tx.body, W - 100).forEach(function (ln) { ctx.fillText(ln, W / 2, y); y += 42; });
      // Objective (live progress)
      y += 18;
      ctx.fillStyle = flash ? '#ff8080' : '#ffffff';
      ctx.font = '700 36px ' + FONT;
      ctx.fillText(t.done ? 'Done!' : 'Objective', W / 2, y);
      y += 48;
      var lines = richLines(ctx, this._tutorialObjective(), W - 100, 32);
      drawRich(ctx, lines, W / 2, y, 32, 41, flash ? '#ffb0b0' : '#ffffff');
      // dots of progress
      for (var i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.arc(W / 2 + (i - 2.5) * 34, card.ch - 138, i === t.step ? 10 : 7, 0, Math.PI * 2);
        ctx.fillStyle = i < t.step ? pink : (i === t.step ? '#ffffff' : 'rgba(255,255,255,0.3)');
        ctx.fill();
      }
      this._uiButton(ctx, card, { id: 'quit', x: W / 2 - 150, y: card.ch - 112, w: 300, h: 72, label: 'Quit Tutorial', size: 36 });
    } else {
      ctx.fillStyle = pink;
      fit(ctx, 'Tutorial Complete!', '700', 56, W - 80);
      ctx.fillText('Tutorial Complete!', W / 2, 150);
      ctx.fillStyle = '#ffffff';
      ctx.font = '400 38px ' + FONT;
      y = 230;
      wrap(ctx, "You've learned the basics of Dotmination!", W - 120).forEach(function (ln) { ctx.fillText(ln, W / 2, y); y += 50; });
      for (var s = 0; s < 3; s++) star(ctx, W / 2 + (s - 1) * 86, y + 70, 34, STAR_ON);
      this._uiButton(ctx, card, { id: 'level1', x: W / 2 - 180, y: card.ch - 200, w: 360, h: 92, label: 'Start Level 1', icon: 'arrow', primary: true, size: 42 });
      this._uiButton(ctx, card, { id: 'quit', x: W / 2 - 120, y: card.ch - 92, w: 240, h: 60, label: 'Close', size: 32 });
    }
  };

  C._onTutorial = function (id) {
    if (id === 'quit') this.endTutorial(false);
    else if (id === 'level1') { this.endTutorial(true); this.setLevel(1); this.startOfflineBotMatch(); }
  };

  C.endTutorial = function (startingNext) {
    if (!this._tutorial) return;
    this._tutorial = null;
    this._uiHide(this._tutCard);
    var b = this.boards.shared;
    b.view.setHighlights([]);
    this.matchActive = false;
    this.matchState = 'IDLE';
    if (!startingNext) {
      b.state.clear();
      b.view.syncFrom(b.state);
      this._refreshScores();
      this._updateBoardLabels(performance.now(), true);
      this._scheduleDualIdle(800);
    }
  };

  // ── Round end card (original .overlay.end > .card) ─────────────────────────
  C._playVictory = function (info) {
    info = info || {};
    this._clearVictory();
    if (!this._sceneRoot) return;
    if (!this._uiReady) this._uiInit();
    var winner = info.winner || (this.modes && this.modes.winner) || 'draw';
    var mySide = this._mySeatSide();
    // The lobby has already cleared the seats by now: use the seats this match had
    if (!mySide && global.isMultiplayer && !global.isMobileSpectator && this._lastMatchSeats) {
      var meId = (global.StacksLobby && global.StacksLobby.myPlayerId) || global.myPlayerId;
      if (meId && this._lastMatchSeats.blue === meId) mySide = 'blue';
      else if (meId && this._lastMatchSeats.red === meId) mySide = 'red';
    }
    var solo = !global.isMultiplayer && !this._dualBotPreview;
    var host = !!(global.StacksLobby && global.StacksLobby.isHost);
    var e = {
      winner: winner,
      title: 'Dotmination!',
      stars: null,
      buttons: [],
      sub: ''
    };
    if (global.isMultiplayer && mySide) {
      // Original showMultiplayerGameOverOverlay: You Win! / You Lose! + Rematch
      e.title = winner === 'draw' ? 'Draw!' : (winner === mySide ? 'You Win!' : 'You Lose!');
      if (host) e.buttons = [{ id: 'rematch', label: 'Rematch', icon: 'undo', primary: true }];
      else e.sub = 'Waiting for the host';
    } else if (!mySide) {
      // Spectators: "Pink Wins!" / "Michiel Wins!" in the app's title case
      e.title = winner === 'draw' ? 'Draw!' : this._victoryTitle(winner, info).toLowerCase()
        .replace(/(^|\s)\S/g, function (m) { return m.toUpperCase(); });
    } else if (solo && info.level) {
      if (winner === 'blue') {
        e.stars = info.stars || 1;
        e.sub = info.time ? (info.time + (info.isBest ? '  ·  best!' : '  ·  best ' + info.best)) : '';
        e.buttons = [{ id: 'next-level', label: 'Next Level', icon: 'arrow', primary: true }];
      } else {
        e.stars = 0;
        e.buttons = [{ id: 'retry', label: 'Retry', icon: 'undo', primary: true }];
      }
    } else if (solo) {
      // Random mode: stars by time when you win; Retry / Next either way
      e.stars = winner === 'blue' ? (info.stars || 1) : 0;
      e.sub = info.time || '';
      e.buttons = [{ id: 'retry', label: 'Retry', icon: 'undo' }, { id: 'next-map', label: 'Next', icon: 'shuffle', primary: true }];
    }
    // 1–2 VR players in the lobby: everyone gets Play again (no queue / host START)
    var rm = this._rematchOffer();
    e._player = !!(global.isMultiplayer && mySide);
    if (rm) { e.buttons = rm.buttons; e.sub = rm.sub; e._rematch = true; }
    this._listenRematch();
    this._endInfo = e;
    this._victory = { root: this._endCard.group, t0: performance.now(), endCard: true };
    this._uiShow(this._endCard, this._uiFrontPos(0.04));
    this._endCard.shownAt = performance.now();
    this._sfx('win', { volume: 0.5 });
  };

  // ── Quick rematch (lobby.js rematchInfo) ───────────────────────────────────
  C._lobbyNick = function (id) {
    var ps = (global.lobbyState && global.lobbyState.players) || [];
    for (var i = 0; i < ps.length; i++) {
      if (ps[i] && ps[i].id === id) return String(ps[i].nickname || 'Player').slice(0, 12);
    }
    return 'Opponent';
  };

  /** End-card buttons + status for this player, or null when no quick rematch applies. */
  C._rematchOffer = function () {
    if (!global.isMultiplayer || global.isMobileSpectator || this._xplay) return null;
    var info = typeof global.rematchInfo === 'function' ? global.rematchInfo() : null;
    var Lobby = global.StacksLobby;
    var me = (Lobby && Lobby.myPlayerId) || global.myPlayerId;
    if (!info || !me || info.players.indexOf(me) < 0) return null;
    var meReady = info.ready.indexOf(me) >= 0;
    var others = info.players.filter(function (id) { return id !== me; });
    var otherReady = others.some(function (id) { return info.ready.indexOf(id) >= 0; });
    var name = others.length ? this._lobbyNick(others[0]) : '';
    var buttons = [{ id: 'play-again', label: 'Play again', icon: 'undo', primary: true }];
    var sub = '';
    if (!others.length) {
      // Alone (or the opponent left after you readied): the next match is vs the bot
      if (meReady) buttons = [{ id: 'play-again', label: 'Play vs Bot', icon: 'arrow', primary: true }];
    } else if (meReady) {
      buttons = [];
      sub = 'Waiting for ' + name + '...';
    } else if (otherReady) {
      sub = name + ' is ready!';
    }
    return { buttons: buttons, sub: sub };
  };

  C._listenRematch = function () {
    if (this._rematchListening || !this.el || !this.el.sceneEl) return;
    this._rematchListening = true;
    var self = this;
    this.el.sceneEl.addEventListener('lobby-state-updated', function () { self._refreshRematchCard(); });
  };

  C._refreshRematchCard = function () {
    var e = this._endInfo;
    if (!e || !this._endCard || this._xplay) return;
    var rm = this._rematchOffer();
    if (rm) {
      e.buttons = rm.buttons; e.sub = rm.sub; e._rematch = true;
    } else if (e._rematch) {
      // Offer withdrawn (a 3rd VR player joined): back to the host-driven Rematch
      e._rematch = false;
      var host = !!(global.StacksLobby && global.StacksLobby.isHost);
      var mine = e._player;
      e.buttons = host && mine ? [{ id: 'rematch', label: 'Rematch', icon: 'undo', primary: true }] : [];
      e.sub = !host && mine ? 'Waiting for the host' : '';
    } else {
      return;
    }
    this._endCard.dirty = true;
  };

  C._placeVictory = function () { /* the end card places itself (_uiFrontPos) */ };
  C._tickVictory = function () { /* animation handled in _uiTick */ };
  C._clearVictory = function () {
    if (this._endCard) this._uiHide(this._endCard);
    this._endInfo = null;
    this._victory = null;
  };

  C._drawEndCard = function (ctx, card) {
    var e = this._endInfo;
    if (!e) return;
    var W = card.cw, H = card.ch, cx = W / 2, cy = H / 2;
    var col = (e.winner === 'red' || e.winner === 'blue') ? this._sideColorCss(e.winner) : '#FFC94D';
    var R = W / 2 - 12;
    // Halo rings (the card's ::before box-shadow: neutral rings, like a dot) — thin, so the
    // card itself gets most of the space
    var rings = [[R, 0.1], [R * 0.96, 0.2], [R * 0.92, 0.3]];
    rings.forEach(function (r) {
      ctx.beginPath(); ctx.arc(cx, cy, r[0], 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(127,127,127,' + (r[1] * 0.5) + ')'; ctx.fill();
    });
    ctx.save();
    ctx.shadowColor = col; ctx.shadowBlur = 40;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.88, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(47,79,79,0.97)'; ctx.fill();
    ctx.restore();
    ctx.lineWidth = 6; ctx.strokeStyle = col;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.88, 0, Math.PI * 2); ctx.stroke();
    // Title in the winner's colour (original .overlay.end.player--N colour)
    var hasStars = e.stars != null;
    var inner = R * 0.88;
    ctx.fillStyle = col;
    fit(ctx, e.title, '700', 76, inner * 1.6);
    ctx.fillText(e.title, cx, cy - (hasStars ? 118 : 74));
    if (hasStars) {
      for (var s = 0; s < 3; s++) star(ctx, cx + (s - 1) * 74, cy - 40, 28, s < e.stars ? STAR_ON : STAR_OFF);
    }
    if (e.sub) {
      ctx.fillStyle = TEXT2;
      fit(ctx, e.sub, '400', 34, inner * 1.5);
      ctx.fillText(e.sub, cx, cy + (hasStars ? 14 : -10));
    }
    var n = e.buttons.length;
    var bw = n > 1 ? 184 : 250, bh = 70, gap = 20;
    var y0 = cy + (hasStars ? 58 : 40);
    for (var i = 0; i < n; i++) {
      var bx = cx - (n * bw + (n - 1) * gap) / 2 + i * (bw + gap);
      var b = e.buttons[i];
      this._uiButton(ctx, card, { id: b.id, x: bx, y: y0, w: bw, h: bh, label: b.label, icon: b.icon, primary: b.primary, size: 36 });
    }
  };

  C._onEndCard = function (id) {
    if (id === 'play-again') {
      // Ready up = join the queue; the host starts once every VR player is ready
      if (typeof global.sendQueueAction === 'function') global.sendQueueAction('join');
      this._refreshRematchCard();
      return;
    }
    var lvl = this._levelMatch | 0;          // the match that just ended
    var seed = this.bagSeed;
    this._clearVictory();
    if (id === 'next-level') {
      var max = this.levelInfo().max;
      this.setLevel(Math.min(max, lvl + 1) || 1);
      this.startOfflineBotMatch();
    } else if (id === 'retry') {
      if (lvl > 0) { this.setLevel(lvl); this.startOfflineBotMatch(); }
      else {
        // Original Retry: the same random map again
        this.setLevel(0);
        global.isLobbyBotMatch = true;
        this.onMatchStarted({ blue: 'local', red: '__BOT__' }, Date.now(), true, seed);
      }
    } else if (id === 'next-map') { this.setLevel(0); this.startOfflineBotMatch(); }
    else if (id === 'rematch' && typeof global.startLobbyMatch === 'function') global.startLobbyMatch();
  };
})(typeof window !== 'undefined' ? window : globalThis);
