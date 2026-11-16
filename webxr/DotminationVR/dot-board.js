// dot-board.js — VR view of the original Dotmination field.
// Draws the phone game's look onto a canvas texture (white field, dots with CSS-style
// halo rings per stage, empty dots tinted in the current player's colour, tap ripples,
// floating "+1"s, 0.1s step animation) and puts it on a vertical double-sided panel.
// Seen from behind the field is mirrored, exactly like a real glass board.
(function (global) {
  'use strict';

  var R = global.DotRules;
  var K = 2.4;           // canvas px per original CSS px
  var M = 26;            // margin around the field (CSS px)
  var METERS_PER_PX = 0.00186; // 64px dot spacing ≈ 12 cm
  var STEP_MS = 100;     // original gsap.delayedCall(0.1, incrementDotStage)
  // Original palette (style.css). Owner code 1 = blue seat = you = original player--2 (#E11168),
  // code 2 = red seat = bot / opponent = original player--1 (#12DACE). Neutral #7f7f7f.
  var DEFAULT_COLORS = { 0: '#7f7f7f', 1: '#E11168', 2: '#12DACE' };
  // .dot.stage--N box-shadow rings: [spread px, alpha] — drawn largest first
  var RINGS = {
    1: [[19.2, 0.1], [14.4, 0.2], [9.6, 0.3], [4.8, 0.4]],
    2: [[14.4, 0.1], [9.6, 0.2], [4.8, 0.3]],
    3: [[9.6, 0.1], [4.8, 0.2]],
    4: [[4.8, 0.1]],
    5: []
  };

  function hexRgb(hex) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgba(hex, a) { var c = hexRgb(hex); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  // transition: 0.3s cubic-bezier(0, 1.4, 1, 1) — springy overshoot
  function springEase(u) {
    if (u >= 1) return 1;
    var lo = 0, hi = 1, t = u;
    for (var k = 0; k < 18; k++) {
      t = (lo + hi) / 2;
      var x = 3 * (1 - t) * t * t + t * t * t; // P1.x=0, P2.x=1
      if (x < u) lo = t; else hi = t;
    }
    return 3 * (1 - t) * (1 - t) * t * 1.4 + 3 * (1 - t) * t * t + t * t * t;
  }

  function View(opts) {
    opts = opts || {};
    this.layout = R.layoutFor(opts.rows, opts.cols);
    this.colors = Object.assign({}, DEFAULT_COLORS, opts.colors || {});
    this.turnColor = this.colors[2];
    this.rimColor = '#3c4756';
    this._rimTarget = this.rimColor;
    this._threat = 0;
    this.speed = opts.stepMs != null ? opts.stepMs : STEP_MS;
    var n = this.layout.count;
    this.dispOwner = new Uint8Array(n);
    this.dispStage = new Uint8Array(n);
    this._size = new Float32Array(n);     // animated stage (float)
    this._from = new Float32Array(n);
    this._t0 = new Float64Array(n);
    this._flash = new Float32Array(n);
    this._hover = [-1, -1];
    this._botChoice = -1;
    this._queue = [];
    this._stepAt = 0;
    this._fx = [];       // ripples + floating texts
    this.onStep = null;
    this._build();
  }

  View.prototype._build = function () {
    var L = this.layout;
    this.pxW = L.width + 2 * M;
    this.pxH = L.height + 2 * M;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(this.pxW * K);
    this.canvas.height = Math.round(this.pxH * K);
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    // Mipmaps: the board is seen from far away by spectators; plain linear filtering shimmers
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.tex.generateMipmaps = true;
    this.tex.anisotropy = 4;
    if ('colorSpace' in this.tex && THREE.SRGBColorSpace) this.tex.colorSpace = THREE.SRGBColorSpace;
    else if (THREE.sRGBEncoding) this.tex.encoding = THREE.sRGBEncoding;
    this.width = this.pxW * METERS_PER_PX;
    this.height = this.pxH * METERS_PER_PX;
    this.root = new THREE.Group();
    this.root.name = 'dot-board';
    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(this.width, this.height),
      new THREE.MeshBasicMaterial({
        map: this.tex, transparent: true, side: THREE.DoubleSide, toneMapped: false, depthWrite: false
      })
    );
    this.panel.renderOrder = 2;
    this.root.add(this.panel);
    // No separate frame: the rounded rim (current player's colour) outlines the board.
    this._dirty = true;
    this._draw(performance.now());
  };

  View.prototype.dispose = function () {
    this.root.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
  };

  View.prototype.setColors = function (map) {
    Object.assign(this.colors, map || {});
    this._dirty = true;
  };

  /** Empty dots take the current player's colour (original .field.player--N rule). */
  View.prototype.setTurnColor = function (code) {
    var c = this.colors[code] || this.colors[0];
    if (c !== this.turnColor) { this.turnColor = c; this._dirty = true; }
  };

  View.prototype.setRim = function (code, threat) {
    var c = code == null ? '#3c4756' : (this.colors[code] || '#3c4756'); // idle: dim slate, not white
    if (c !== this._rimTarget || (threat || 0) !== this._threat) {
      this._rimTarget = c;
      this._threat = threat || 0;
      this._dirty = true;
    }
  };

  View.prototype._px = function (i) {
    var c = this.layout.cells[i];
    return { x: (M + c.x) * K, y: (M + c.y) * K };
  };

  View.prototype.cellLocal = function (i, out) {
    var c = this.layout.cells[i];
    out = out || new THREE.Vector3();
    return out.set((M + c.x - this.pxW / 2) * METERS_PER_PX, (this.pxH / 2 - (M + c.y)) * METERS_PER_PX, 0);
  };

  View.prototype.cellWorld = function (i, out) {
    out = this.cellLocal(i, out);
    this.root.updateWorldMatrix(true, false);
    return this.root.localToWorld(out);
  };

  View.prototype._setDot = function (i, o, s, now) {
    if (this.dispStage[i] !== s) {
      this._from[i] = this._size[i];
      this._t0[i] = now;
    }
    this.dispOwner[i] = o;
    this.dispStage[i] = s;
    this._dirty = true;
  };

  View.prototype.syncFrom = function (state) {
    if (state.layout !== this.layout) {
      // Different field size: rebuild in place
      var parent = this.root.parent, pos = this.root.position.clone(), q = this.root.quaternion.clone();
      if (parent) parent.remove(this.root);
      this.dispose();
      View.call(this, { rows: state.layout.rows, cols: state.layout.cols, colors: this.colors });
      this.root.position.copy(pos); this.root.quaternion.copy(q);
      if (parent) parent.add(this.root);
    }
    this._queue = [];
    this._stepAt = 0;
    var now = performance.now();
    for (var i = 0; i < this.layout.count; i++) {
      this.dispOwner[i] = state.owner[i];
      this.dispStage[i] = state.stage[i];
      this._size[i] = state.stage[i];
      this._t0[i] = 0;
    }
    this._dirty = true;
    this._draw(now);
  };

  /** Queue the original one-increment-at-a-time animation; resync to finalState at the end. */
  View.prototype.play = function (res, finalState, opts) {
    opts = opts || {};
    var now = performance.now();
    if (res && res.steps) {
      this._fx.push({ kind: 'ripple', i: res.cell, t0: now });
      for (var k = 0; k < res.steps.length; k++) this._queue.push({ step: res.steps[k], first: k === 0 });
    }
    if (finalState) this._queue.push({ sync: finalState.serialize() });
    if (!this._stepAt) this._stepAt = now;
    if (opts.instant) this._flushQueue(now);
  };

  View.prototype._flushQueue = function (now) {
    while (this._queue.length) this._runStep(this._queue.shift(), now, true);
    this._stepAt = 0;
  };

  View.prototype._runStep = function (item, now, quiet) {
    if (item.sync) {
      for (var i = 0; i < this.layout.count && i < item.sync.o.length; i++) {
        this._setDot(i, item.sync.o.charCodeAt(i) - 48, item.sync.s.charCodeAt(i) - 48, now);
      }
      return null;
    }
    var st = item.step;
    this._setDot(st.i, st.o, st.s, now);
    if (!quiet) {
      if (st.kind === 'grow') this._float(st.i, st.o, now);
      else if (st.nb) for (var k = 0; k < st.nb.length; k++) this._float(st.nb[k], st.by, now);
    }
    this._flash[st.i] = 1;
    if (this.onStep) this.onStep(st.kind, st, quiet);
    return st;
  };

  View.prototype._float = function (i, owner, now) {
    this._fx.push({ kind: 'plus', i: i, o: owner, t0: now });
    if (this._fx.length > 120) this._fx.splice(0, this._fx.length - 120);
  };

  View.prototype.busy = function () { return this._queue.length > 0; };
  /** Score as currently drawn (sum of displayed stages): counts along with the chain. */
  View.prototype.displayScore = function (code) {
    var t = 0;
    for (var i = 0; i < this.dispOwner.length; i++) if (this.dispOwner[i] === code) t += this.dispStage[i];
    return t;
  };

  /** ms left in the queued animation. */
  View.prototype.remainingMs = function () {
    return this._queue.length * this.speed;
  };

  View.prototype.flashCells = function (cells) {
    var now = performance.now();
    for (var i = 0; i < cells.length; i++) {
      this._flash[cells[i]] = 1;
      this._fx.push({ kind: 'ripple', i: cells[i], t0: now, warn: true });
    }
    this._dirty = true;
  };

  View.prototype.setHover = function (slot, i) {
    i = i == null ? -1 : i;
    if (this._hover[slot | 0] !== i) { this._hover[slot | 0] = i; this._dirty = true; }
  };

  /** Original bot "visual feedback": highlight the dot the bot is about to tap. */
  View.prototype.setBotChoice = function (i) {
    i = i == null ? -1 : i;
    if (this._botChoice !== i) { this._botChoice = i; this._dirty = true; }
  };

  View.prototype.tick = function (now, dt) {
    now = now || performance.now();
    while (this._queue.length && now >= this._stepAt) {
      var item = this._queue.shift();
      var st = this._runStep(item, now, false);
      this._stepAt = st ? now + this.speed : now; // original: 0.1 s per increment
    }
    if (!this._queue.length) this._stepAt = 0;
    var animating = false;
    for (var i = 0; i < this.layout.count; i++) {
      var target = this.dispStage[i];
      if (this._t0[i]) {
        var u = Math.min(1, (now - this._t0[i]) / 300);
        this._size[i] = this._from[i] + (target - this._from[i]) * springEase(u);
        if (u >= 1) { this._t0[i] = 0; this._size[i] = target; }
        animating = true;
      }
      if (this._flash[i] > 0) {
        this._flash[i] = Math.max(0, this._flash[i] - (dt || 16) / 350);
        animating = true;
      }
    }
    if (this._fx.length) animating = true;
    if (this._threat > 0) animating = true;
    if (animating || this._dirty) this._draw(now);
    return this.busy();
  };

  View.prototype._draw = function (now) {
    var ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    // Field card: dark glass (original dark mode) instead of the app's white body, so it
    // doesn't glare in a headset; faint diagonal grid from the svg kept as a hint of the surface.
    var r = 22 * K;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(r, 0); ctx.arcTo(W, 0, W, H, r); ctx.arcTo(W, H, 0, H, r); ctx.arcTo(0, H, 0, 0, r); ctx.arcTo(0, 0, W, 0, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(8,12,18,0.8)';
    ctx.fill();
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1.5;
    for (var g = -H; g < W + H; g += 60 * K) {
      ctx.beginPath(); ctx.moveTo(g, 0); ctx.lineTo(g + H * 0.577, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(g, H); ctx.lineTo(g + H * 0.577, 0); ctx.stroke();
    }
    ctx.restore();
    // Rim in turn colour (pulses amber when a RUSH infection is incoming)
    var rim = this._rimTarget;
    ctx.lineWidth = 7 * K;
    ctx.strokeStyle = rim;
    if (this._threat > 0) {
      var th = 0.5 + 0.5 * Math.sin(now * 0.02);
      ctx.strokeStyle = th * this._threat > 0.35 ? '#ffb300' : rim;
    }
    ctx.beginPath();
    ctx.moveTo(r, 3.5 * K); ctx.arcTo(W - 3.5 * K, 3.5 * K, W - 3.5 * K, H, r);
    ctx.arcTo(W - 3.5 * K, H - 3.5 * K, 0, H - 3.5 * K, r);
    ctx.arcTo(3.5 * K, H - 3.5 * K, 3.5 * K, 0, r); ctx.arcTo(3.5 * K, 3.5 * K, W, 3.5 * K, r);
    ctx.closePath();
    ctx.stroke();

    // Ripples under the dots
    var keep = [];
    for (var f = 0; f < this._fx.length; f++) {
      var fx = this._fx[f];
      var age = now - fx.t0;
      if (fx.kind === 'ripple') {
        if (age > 400) continue;
        var p = this._px(fx.i), u = age / 400;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 50 * K * 1.5 * u, 0, Math.PI * 2);
        ctx.fillStyle = fx.warn ? 'rgba(255,179,0,' + (0.5 * (1 - u)) + ')' : 'rgba(200,200,200,' + (0.5 * (1 - u)) + ')';
        ctx.fill();
      }
      keep.push(fx);
    }

    // Dots
    for (var i = 0; i < this.layout.count; i++) {
      var pp = this._px(i);
      var o = this.dispOwner[i];
      var size = this._size[i];
      var hovered = this._hover[0] === i || this._hover[1] === i;
      var scale = hovered ? 1.2 : 1;
      if (o === 0 || size <= 0.05) {
        // Empty: 5% dot (15% on hover), tinted in the current player's colour, opacity 0.4
        var er = 64 * (hovered ? 0.15 : 0.05) / 2 * K;
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, Math.max(er, 1.6 * K), 0, Math.PI * 2);
        ctx.fillStyle = rgba(this.turnColor, 0.4);
        ctx.fill();
        if (hovered) {
          ctx.beginPath(); ctx.arc(pp.x, pp.y, 26 * K, 0, Math.PI * 2);
          ctx.strokeStyle = rgba(this.turnColor, 0.5); ctx.lineWidth = 2 * K; ctx.stroke();
        }
        continue;
      }
      var col = this.colors[o] || this.colors[0];
      var core = 64 * 0.16 * Math.max(0, size) / 2 * K * scale;
      var rings = RINGS[this.dispStage[i]] || [];
      for (var k = 0; k < rings.length; k++) {
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, core + rings[k][0] * K * scale, 0, Math.PI * 2);
        ctx.fillStyle = rgba(col, rings[k][1]);
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, core, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      if (this._flash[i] > 0) {
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, core, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,' + (0.55 * this._flash[i]) + ')';
        ctx.fill();
      }
      if (hovered) {
        ctx.beginPath(); ctx.arc(pp.x, pp.y, Math.max(core + 6 * K, 26 * K), 0, Math.PI * 2);
        ctx.strokeStyle = rgba(col, 0.6); ctx.lineWidth = 2 * K; ctx.stroke();
      }
    }
    if (this._botChoice >= 0) {
      var bp = this._px(this._botChoice);
      ctx.beginPath(); ctx.arc(bp.x, bp.y, 30 * K, 0, Math.PI * 2);
      ctx.setLineDash([6 * K, 5 * K]);
      ctx.strokeStyle = 'rgba(40,40,40,0.55)'; ctx.lineWidth = 2.5 * K; ctx.stroke();
      ctx.setLineDash([]);
    }

    // Floating "+1" (original .increment-animation: bold 1.5rem, rises 40px over 0.8s)
    ctx.font = 'bold ' + Math.round(24 * K) + 'px Roboto, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    var keep2 = [];
    for (var q = 0; q < keep.length; q++) {
      var e = keep[q];
      if (e.kind !== 'plus') { keep2.push(e); continue; }
      var a = now - e.t0;
      if (a > 800) continue;
      var t = a / 800;
      var ep = this._px(e.i);
      var ease = 1 - (1 - t) * (1 - t);
      ctx.globalAlpha = 1 - ease;
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 2 * K;
      ctx.shadowOffsetX = ctx.shadowOffsetY = K;
      ctx.fillStyle = this.colors[e.o] || '#ffffff';
      ctx.fillText('+1', ep.x, ep.y - 40 * K * ease);
      ctx.globalAlpha = 1;
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = ctx.shadowOffsetY = 0;
      keep2.push(e);
    }
    this._fx = keep2;
    this.tex.needsUpdate = true;
    this._dirty = false;
  };

  // ── Picking ───────────────────────────────────────────────────────────
  View.prototype._toCss = function (lx, ly) {
    return { x: lx / METERS_PER_PX + this.pxW / 2 - M, y: this.pxH / 2 - ly / METERS_PER_PX - M };
  };

  View.prototype._nearest = function (lx, ly, maxPx) {
    var p = this._toCss(lx, ly);
    var best = -1, bestD = maxPx * maxPx;
    for (var i = 0; i < this.layout.count; i++) {
      var c = this.layout.cells[i];
      var dx = c.x - p.x, dy = c.y - p.y, d2 = dx * dx + dy * dy;
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    return best;
  };

  View.prototype.pickRay = function (origin, dir) {
    var inv = View._inv || (View._inv = new THREE.Matrix4());
    this.root.updateWorldMatrix(true, false);
    inv.copy(this.root.matrixWorld).invert();
    var o = (View._o || (View._o = new THREE.Vector3())).copy(origin).applyMatrix4(inv);
    var e = (View._e || (View._e = new THREE.Vector3())).copy(origin).add(dir).applyMatrix4(inv);
    var dz = e.z - o.z;
    if (Math.abs(dz) < 1e-6) return { index: -1 };
    var t = -o.z / dz;
    if (t < 0) return { index: -1 };
    var hx = o.x + (e.x - o.x) * t, hy = o.y + (e.y - o.y) * t;
    return { index: this._nearest(hx, hy, 34), dist: t * dir.length() };
  };

  View.prototype.pokePoint = function (worldPoint) {
    var inv = View._inv2 || (View._inv2 = new THREE.Matrix4());
    this.root.updateWorldMatrix(true, false);
    inv.copy(this.root.matrixWorld).invert();
    var p = (View._pp || (View._pp = new THREE.Vector3())).copy(worldPoint).applyMatrix4(inv);
    return { index: this._nearest(p.x, p.y, 30), depth: Math.abs(p.z), z: p.z };
  };

  global.DotBoard = {
    View: View,
    COLORS: DEFAULT_COLORS,
    METERS_PER_PX: METERS_PER_PX,
    newSeed: R.newSeed // lobby.js seeds matches through DotBoard.newSeed
  };
})(typeof window !== 'undefined' ? window : globalThis);
