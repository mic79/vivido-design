/**
 * VRLeague — tabletop ball + cubes, host-authoritative Cannon physics, PeerJS (up to 4).
 */
(function () {
  'use strict';

  window.lobbyState = window.lobbyState || null;
  window.isMultiplayer = !!window.isMultiplayer;
  window.connectionState = window.connectionState || 'disconnected';
  window.myPlayerId = window.myPlayerId || null;

  window.createLobbyState =
    window.createLobbyState ||
    function () {
      return {
        players: [],
        queue: [],
        matchPlayers: { blue: null, red: null },
        matchState: 'WAITING',
        matchStartTime: 0,
        matchScore: { blue: 0, red: 0 },
        matchGameState: null,
        spectatorSlots: [null, null, null, null],
        mobileSpectatorCount: 0
      };
    };

  var HOST_ID_PREFIX = 'vrleague-host-';
  /** Countdown match length (host clock), same feel as DodgeVR's 3:00. */
  var VL_MATCH_DURATION_MS = 3 * 60 * 1000;
  /** Same Metered-backed TURN/STUN JSON as DodgeVR / RTSVR2 (Cloudflare worker). */
  var VL_TURN_ENDPOINT = 'https://dotmination-turn-proxy.odd-bird-4c2c.workers.dev';

  function vlDefaultIceServers() {
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];
  }

  function vlGetIceServers() {
    return fetch(VL_TURN_ENDPOINT)
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .catch(function () {
        return null;
      })
      .then(function (json) {
        if (json && Array.isArray(json) && json.length) return json;
        return vlDefaultIceServers();
      });
  }

  function vlPeerOptions(iceServers) {
    return {
      host: '0.peerjs.com',
      port: 443,
      secure: true,
      config: { iceServers: iceServers }
    };
  }

  /** True if host id is free (you may create the lobby). Same idea as DodgeVR checkPeerAvailability. */
  function vlCheckHostPeerIdAvailable(hostId) {
    return new Promise(function (resolve) {
      var finished = false;
      function done(ok) {
        if (finished) return;
        finished = true;
        resolve(ok);
      }
      var temp = new Peer(hostId, { host: '0.peerjs.com', port: 443, secure: true });
      var t = setTimeout(function () {
        try {
          temp.destroy();
        } catch (e) {}
        done(false);
      }, 2000);
      temp.on('open', function () {
        clearTimeout(t);
        try {
          temp.destroy();
        } catch (e2) {}
        done(true);
      });
      temp.on('error', function (err) {
        clearTimeout(t);
        try {
          temp.destroy();
        } catch (e3) {}
        if (err && err.type === 'unavailable-id') done(false);
        else done(true);
      });
    });
  }

  window.__vlGetIceServers = vlGetIceServers;
  window.__vlCheckHostPeerIdAvailable = vlCheckHostPeerIdAvailable;

  function vlHandEl(primaryId, fallbackId) {
    return document.getElementById(primaryId) || document.getElementById(fallbackId);
  }

  /** 16-wide LED bitmaps: each string is one row, '1' = on. Idle is 16 rows; tongue 19 (canvas uses 19 rows, idle padded with blank rows). */
  var VL_LED_IDLE_ROWS = [
    '0011000000001100',
    '0011000000001100',
    '1100110000110011',
    '1100110000110011',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '1100000000000011',
    '1100000000000011',
    '0011111111111100',
    '0011111111111100'
  ];
  var VL_LED_TONGUE_ROWS = [
    '0000000000001100',
    '0000000000001100',
    '1111110000110011',
    '1111110000110011',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '1100000000000011',
    '1100000000000011',
    '0011111111111100',
    '0011111111111100',
    '0000000011011000',
    '0000000011011000',
    '0000000001110000'
  ];
  /** Same 16×19 grid as face; shown after non-ball impacts for VL_HIT_FACE_MS. */
  var VL_LED_IMPACT_ROWS = [
    '0000000000000000',
    '0000000000000000',
    '1111110000111111',
    '1111110000111111',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
    '0000001111000000',
    '0000110000110000',
    '0000110000110000',
    '0000001111000000',
    '0000000000000000'
  ];
  /** Bitmap size (idle padded to match tongue height). */
  var VL_LED_FACE_COLS = 16;
  var VL_LED_FACE_ROWS = 19;
  var VL_LED_IDLE_ROWS_PADDED = VL_LED_IDLE_ROWS.concat([
    '0000000000000000',
    '0000000000000000',
    '0000000000000000'
  ]);

  /** Full LED canvas: wider grid; 16×VL_LED_FACE_ROWS face centered (same cell margin L/R as T/B). */
  var VL_LED_GRID_COLS = 24;
  var VL_LED_GRID_ROWS = VL_LED_FACE_ROWS + (VL_LED_GRID_COLS - VL_LED_FACE_COLS);
  var VL_LED_FACE_OX = (VL_LED_GRID_COLS - VL_LED_FACE_COLS) >> 1;
  var VL_LED_FACE_OY = (VL_LED_GRID_ROWS - VL_LED_FACE_ROWS) >> 1;

  /**
   * LED matrix: **24 cells wide**, gutters. Off cells = white; on cells = `onColor` (cube body).
   * @param {'neutral'|'tongue'|'hit'} mode
   * @param {string} onColor CSS hex for lit cells (e.g. SPEC slot color)
   */
  function vlDrawLedFace(ctx, w, h, mode, onColor) {
    ctx.imageSmoothingEnabled = false;
    var cols = VL_LED_GRID_COLS;
    var rows = VL_LED_GRID_ROWS;
    var cell = Math.min(w / cols, h / rows);
    var ox = (w - cell * cols) * 0.5;
    var oy = (h - cell * rows) * 0.5;
    var gutter = Math.max(1, Math.round(cell * 0.12));
    var pxw = Math.max(1, Math.floor(cell - gutter));

    var OFF = '#ffffff';
    var ON = onColor || '#888888';
    var DIM = '#ffffff';

    var bitmap =
      mode === 'hit'
        ? VL_LED_IMPACT_ROWS
        : mode === 'tongue'
          ? VL_LED_TONGUE_ROWS
          : VL_LED_IDLE_ROWS_PADDED;
    var gx, gy;
    var fgx, fgy;
    var rowStr;

    ctx.fillStyle = OFF;
    ctx.fillRect(0, 0, w, h);
    for (gy = 0; gy < rows; gy++) {
      for (gx = 0; gx < cols; gx++) {
        fgx = gx - VL_LED_FACE_OX;
        fgy = gy - VL_LED_FACE_OY;
        if (fgx >= 0 && fgx < VL_LED_FACE_COLS && fgy >= 0 && fgy < VL_LED_FACE_ROWS) {
          rowStr = bitmap[fgy] || '';
          ctx.fillStyle = rowStr.charAt(fgx) === '1' ? ON : DIM;
        } else {
          ctx.fillStyle = DIM;
        }
        ctx.fillRect(Math.floor(ox + gx * cell), Math.floor(oy + gy * cell), pxw, pxw);
      }
    }
  }

  /** World-space head position for LED proximity (A-Frame camera API differs by version). */
  function vlGetCameraWorldPosition(sceneEl, out) {
    if (!sceneEl) return false;
    var c = sceneEl.camera;
    if (c) {
      if (c.el && c.el.object3D) {
        c.el.object3D.getWorldPosition(out);
        return true;
      }
      if (c.object3D) {
        c.object3D.getWorldPosition(out);
        return true;
      }
    }
    var el = document.getElementById('cam') || sceneEl.querySelector('[camera]') || sceneEl.querySelector('a-camera');
    if (el && el.object3D) {
      el.object3D.getWorldPosition(out);
      return true;
    }
    return false;
  }

  function vlCreateCarLedFace(THREE, half, bodyColorHex) {
    var W = VL_LED_GRID_COLS * 4;
    var H = VL_LED_GRID_ROWS * 4;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    var onHex = bodyColorHex || '#888888';
    vlDrawLedFace(ctx, W, H, 'neutral', onHex);
    var tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    var face = half * 2 - 0.006;
    var geo = new THREE.PlaneGeometry(face, face);
    /* Lit / unlit colors live in the canvas map only (white off-cells would pick up uniform emissive). */
    var mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      depthWrite: true,
      side: THREE.FrontSide,
      roughness: 0.42,
      metalness: 0.08
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, 0, half + 0.0032);
    mesh.renderOrder = 1;
    var pivot = new THREE.Group();
    pivot.name = 'vlLedPivot';
    pivot.add(mesh);
    return {
      pivot: pivot,
      texture: tex,
      canvas: canvas,
      ctx: ctx,
      mesh: mesh,
      material: mat,
      geometry: geo
    };
  }

  var ARENA = {
    cx: 0,
    cy: 0.74,
    cz: -1.02,
    halfW: 1.28,
    halfD: 1.28,
    cageH: 0.88,
    wallT: 0.036,
    goalDepth: 0.14
  };
  /* Half-width of goal mouth in local Z (= half of 50% of end-wall span in Z). */
  ARENA.goalW = ARENA.halfD * 0.5;

  /* Rig offset from arena center (world XZ). Goals on ±X; rigs sit in front of each goal facing ball. */
  var SPEC = [
    { ox: -1.42, oz: 0.22, color: '#3388ff' },
    { ox: 1.42, oz: 0.22, color: '#ff8833' },
    { ox: -1.42, oz: -0.22, color: '#33ddcc' },
    { ox: 1.42, oz: -0.22, color: '#dd55cc' }
  ];

  var CAR_HALF = 0.04;
  /** Local head ~this close to a cube → face turns to camera + tongue (see _vlGetCameraWorld). */
  var VL_LED_FACE_PROX_M = 0.42;
  var VL_LED_TONGUE_MS = 4000;
  /** Cube hits wall / another cube (not ball): LED “impact” face duration. */
  var VL_HIT_FACE_MS = 2000;
  var BALL_R = 0.1664;
  var THRUST_FORWARD = 0.625;
  /** HeliVR torque formula uses one scale; tuned down for ~0.02 mass cubes vs HeliVR heli. */
  var HELI_TORQUE_SCALE = 0.006;
  var MAX_LIN_SPEED = 0.36;
  var MAX_ANG_SPEED = 0.32;
  var SYNC_EVERY = 3;
  var INPUT_HZ = 25;

  function zeroInput() {
    return { lx: 0, ly: 0, rx: 0, ry: 0, trig: 0 };
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  /**
   * Equirectangular map: 12 pentagon regions (icosahedron vertices) + 20 hex (face centroids).
   * Dark hex / white pent — reads like a soccer ball on a smooth sphere.
   */
  function vlMakeSoccerBallTexture(THREE) {
    function vlNorm(x, y, z) {
      var L = Math.sqrt(x * x + y * y + z * z);
      return { x: x / L, y: y / L, z: z / L };
    }
    function vlPushUniquePent(arr, v) {
      var eps = 1e-5;
      var i;
      for (i = 0; i < arr.length; i++) {
        var p = arr[i];
        if (Math.abs(p.x - v.x) < eps && Math.abs(p.y - v.y) < eps && Math.abs(p.z - v.z) < eps) {
          return;
        }
      }
      arr.push(v);
    }

    var icos = new THREE.IcosahedronGeometry(1, 0);
    var pos = icos.attributes.position;
    var idx = icos.index;
    var pent = [];
    var pi;
    for (pi = 0; pi < pos.count; pi++) {
      vlPushUniquePent(pent, vlNorm(pos.getX(pi), pos.getY(pi), pos.getZ(pi)));
    }
    var hex = [];
    if (idx && idx.count) {
      for (var f = 0; f < idx.count; f += 3) {
        var ia = idx.getX(f);
        var ib = idx.getX(f + 1);
        var ic = idx.getX(f + 2);
        var hx = pos.getX(ia) + pos.getX(ib) + pos.getX(ic);
        var hy = pos.getY(ia) + pos.getY(ib) + pos.getY(ic);
        var hz = pos.getZ(ia) + pos.getZ(ib) + pos.getZ(ic);
        hex.push(vlNorm(hx, hy, hz));
      }
    } else {
      for (var nf = 0; nf < pos.count; nf += 3) {
        var tx = pos.getX(nf) + pos.getX(nf + 1) + pos.getX(nf + 2);
        var ty = pos.getY(nf) + pos.getY(nf + 1) + pos.getY(nf + 2);
        var tz = pos.getZ(nf) + pos.getZ(nf + 1) + pos.getZ(nf + 2);
        hex.push(vlNorm(tx, ty, tz));
      }
    }
    icos.dispose();

    var centers = [];
    for (pi = 0; pi < pent.length; pi++) {
      centers.push({ x: pent[pi].x, y: pent[pi].y, z: pent[pi].z, pent: true });
    }
    for (var hi = 0; hi < hex.length; hi++) {
      centers.push({ x: hex[hi].x, y: hex[hi].y, z: hex[hi].z, pent: false });
    }

    var w = 1024;
    var h = 512;
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(w, h);
    var d = img.data;
    var ci;
    var cj;
    var seamDot = 0.022;
    for (cj = 0; cj < h; cj++) {
      for (ci = 0; ci < w; ci++) {
        var u = (ci + 0.5) / w;
        var v = (cj + 0.5) / h;
        var lon = (u - 0.5) * Math.PI * 2;
        var lat = (0.5 - v) * Math.PI;
        var cl = Math.cos(lat);
        var sx = cl * Math.cos(lon);
        var sy = Math.sin(lat);
        var sz = cl * Math.sin(lon);

        var best = -2;
        var second = -2;
        var winPent = false;
        var ck;
        for (ck = 0; ck < centers.length; ck++) {
          var c = centers[ck];
          var dot = sx * c.x + sy * c.y + sz * c.z;
          if (dot > best) {
            second = best;
            best = dot;
            winPent = c.pent;
          } else if (dot > second) {
            second = dot;
          }
        }

        var off = (cj * w + ci) * 4;
        var seam = best - second < seamDot;
        if (seam) {
          d[off] = 10;
          d[off + 1] = 11;
          d[off + 2] = 18;
          d[off + 3] = 255;
        } else if (winPent) {
          var hiw = Math.min(255, 235 + Math.floor(best * 28));
          d[off] = hiw;
          d[off + 1] = hiw;
          d[off + 2] = Math.min(255, hiw + 6);
          d[off + 3] = 255;
        } else {
          var shade = 0.55 + best * 0.35;
          d[off] = Math.floor(6 * shade);
          d[off + 1] = Math.floor(8 * shade);
          d[off + 2] = Math.floor(22 * shade);
          d[off + 3] = 255;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace !== undefined) {
      tex.colorSpace = THREE.SRGBColorSpace;
    } else if (THREE.sRGBEncoding !== undefined) {
      tex.encoding = THREE.sRGBEncoding;
    }
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  AFRAME.registerComponent('vrleague-game', {
    schema: {
      lobby: { type: 'int', default: 1 }
    },

    init: function () {
      this.world = new CANNON.World();
      this.world.gravity.set(0, 0, 0);
      this.world.broadphase = new CANNON.NaiveBroadphase();
      this.world.solver.iterations = 16;

      this.defaultMat = new CANNON.Material('def');
      this.ballMat = new CANNON.Material('ball');
      this.floorMat = new CANNON.Material('floor');
      this.carMat = new CANNON.Material('car');
      /* Higher ball friction so tangential slip couples into spin (was ~0.02 — ice-like, almost no torque). */
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.ballMat, this.floorMat, { friction: 0.16, restitution: 0.88 }));
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.ballMat, this.defaultMat, { friction: 0.32, restitution: 0.9 }));
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.ballMat, this.carMat, { friction: 0.38, restitution: 0.82 }));
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.carMat, this.floorMat, { friction: 0.12, restitution: 0.82 }));
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.carMat, this.carMat, { friction: 0.05, restitution: 0.55 }));

      this._onBallCollide = this._onBallCollide.bind(this);
      this._onCarCollide = this._onCarCollide.bind(this);
      this._vlAudioNextBounce = 0;
      this._vlAudioNextCarHit = 0;
      this._vlAudioNextCarObstacle = 0;
      this._vlThrusterPlaying = false;

      this.isHost = false;
      this.peer = null;
      this.hostConn = null;
      this.clientConns = [];
      this.mySlot = 0;
      this.inputs = [zeroInput(), zeroInput(), zeroInput(), zeroInput()];
      this.lastInputSend = 0;
      this.frame = 0;
      this.score = [0, 0];
      this.goalCd = 0;
      this.vlMatchActive = false;
      this.vlMatchStartMs = 0;
      this.vlMatchRemainSec = null;
      this._vlLastHudEmit = 0;
      this._vlHudDirty = true;
      this.statusEl = document.getElementById('vl-status');
      this.scoreEl = document.getElementById('vl-score');

      this.tmpVec = new THREE.Vector3();
      this.tmpVec2 = new THREE.Vector3();
      this._vlCarLed = [];
      this._vlLedScratch = null;
      this.arenaWorldPos = new THREE.Vector3();
      this.camYaw = 0;

      this.ballBody = null;
      this.carBodies = [];
      /** World pose + quaternion for each car at arena build (goal / _resetBall restores these). */
      this._carSpawn = [];
      this.ballEl = null;
      this.carEls = [];
      this.wallBodies = [];
      this.floorBody = null;

      this._buildArena();
      if (this.ballBody) {
        this.ballBody.addEventListener('collide', this._onBallCollide);
      }
      this._bindUi();
      this._rig = document.getElementById('vr-rig');
      this._rigYaw = document.getElementById('vl-spect-yaw') || this._rig;
      this._applySpectatorTransform(0);

      this.keys = {};
      var self = this;
      this._vlReseatSpectator = function reseatSpectatorAfterImmersion() {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () {
            self._applySpectatorTransform(self.mySlot);
          });
        });
      };
      var sceneEl = this.el.sceneEl || this.el;
      sceneEl.addEventListener('enter-vr', this._vlReseatSpectator);
      function bindVlXrSessionReseat() {
        var xr = sceneEl.renderer && sceneEl.renderer.xr;
        if (xr && !self._vlXrSessionBound) {
          self._vlXrSessionBound = true;
          xr.addEventListener('sessionstart', self._vlReseatSpectator);
        }
      }
      if (sceneEl.hasLoaded) {
        bindVlXrSessionReseat();
      } else {
        sceneEl.addEventListener('loaded', function vlOnSceneLoaded() {
          sceneEl.removeEventListener('loaded', vlOnSceneLoaded);
          bindVlXrSessionReseat();
        });
      }
      window.addEventListener('keydown', function (e) {
        self.keys[e.code] = true;
      });
      window.addEventListener('keyup', function (e) {
        self.keys[e.code] = false;
      });

      this.startOffline();
    },

    _setStatus: function (t) {
      if (this.statusEl) this.statusEl.textContent = t;
    },

    _setScoreText: function () {
      if (this.scoreEl) {
        this.scoreEl.textContent = 'Blue ' + this.score[0] + '  —  Orange ' + this.score[1];
      }
      this._vlMarkHudDirty();
    },

    _vlMarkHudDirty: function () {
      this._vlHudDirty = true;
    },

    _vlFormatClock: function (totalSec) {
      if (totalSec == null || !isFinite(totalSec)) return '--:--';
      var s = Math.max(0, Math.floor(totalSec));
      var m = Math.floor(s / 60);
      var r = s % 60;
      return m + ':' + (r < 10 ? '0' : '') + r;
    },

    _vlPumpHud: function (now) {
      if (!this._vlHudDirty && now - this._vlLastHudEmit < 200) return;
      this._vlLastHudEmit = now;
      this._vlHudDirty = false;

      var remSec = null;
      if (this.vlMatchActive) {
        if (this.isHost && this.vlMatchStartMs) {
          remSec = Math.max(0, Math.ceil((VL_MATCH_DURATION_MS - (now - this.vlMatchStartMs)) / 1000));
        } else if (typeof this.vlMatchRemainSec === 'number' && isFinite(this.vlMatchRemainSec)) {
          remSec = Math.max(0, Math.floor(this.vlMatchRemainSec));
        }
      }

      window.__vlHud = {
        matchActive: !!this.vlMatchActive,
        matchRemainSec: remSec,
        blue: this.score[0],
        orange: this.score[1]
      };

      var line =
        'Blue ' +
        this.score[0] +
        ' — Orange ' +
        this.score[1] +
        '   |   ' +
        (this.vlMatchActive ? this._vlFormatClock(remSec) : '--:--');
      var menuLine = document.getElementById('menu-vl-scoreboard');
      if (menuLine) menuLine.setAttribute('text', 'value', line);
      var hudLine = document.getElementById('vl-hud-scoreboard');
      if (hudLine) hudLine.setAttribute('text', 'value', line);

      var scene = this.el.sceneEl;
      if (scene) scene.emit('vl-hud-update');
    },

    _vlBroadcastMatchSync: function () {
      if (!this.isHost || !this.peer || !this.peer.open) return;
      var now = performance.now();
      var remSec = null;
      if (this.vlMatchActive && this.vlMatchStartMs) {
        remSec = Math.max(0, Math.ceil((VL_MATCH_DURATION_MS - (now - this.vlMatchStartMs)) / 1000));
      }
      var pack = {
        type: 'vl-match-sync',
        active: !!this.vlMatchActive,
        score0: this.score[0],
        score1: this.score[1],
        remSec: remSec
      };
      for (var i = 0; i < this.clientConns.length; i++) {
        var c = this.clientConns[i];
        if (c && c.open) c.send(pack);
      }
    },

    vlStartMatch: function () {
      if (!this.isHost) return;
      if (this.vlMatchActive) return;
      this.score[0] = 0;
      this.score[1] = 0;
      this._setScoreText();
      this._resetBall();
      this.vlMatchActive = true;
      this.vlMatchStartMs = performance.now();
      this._setStatus('Match on — ' + this._vlFormatClock(VL_MATCH_DURATION_MS / 1000) + ' countdown. Goals count toward Blue / Orange.');
      this._vlBroadcastLobbyToClients();
      this._vlBroadcastMatchSync();
      this._vlMarkHudDirty();
    },

    vlEndMatch: function (reason) {
      if (!this.isHost) return;
      if (!this.vlMatchActive) return;
      this.vlMatchActive = false;
      this.vlMatchStartMs = 0;
      this.vlMatchRemainSec = null;
      this._setStatus(reason ? String(reason) : 'Match ended. Open the menu to start again or keep practicing.');
      this._vlBroadcastLobbyToClients();
      this._vlBroadcastMatchSync();
      this._vlMarkHudDirty();
    },

    /** Offline menu START / END MATCH (host-only physics). */
    vlToggleMatchFromMenu: function () {
      if (!this.isHost) return;
      if (this.vlMatchActive) this.vlEndMatch();
      else this.vlStartMatch();
    },

    _bindUi: function () {},

    _vlEmitLobbyUpdated: function () {
      var scene = this.el && this.el.sceneEl;
      if (scene) scene.emit('lobby-state-updated');
    },

    _vlClearWindowMultiplayer: function () {
      window.lobbyState = null;
      window.isMultiplayer = false;
      window.connectionState = 'disconnected';
      window.myPlayerId = null;
      this._vlEmitLobbyUpdated();
    },

    _vlRebuildLobbyState: function () {
      if (!this.isHost || !this.peer || !this.peer.open) return;
      var st = window.createLobbyState();
      var hostNick =
        typeof window.playerNickname === 'string' && window.playerNickname.trim()
          ? window.playerNickname.trim().slice(0, 20)
          : 'Host';
      st.players.push({ id: this.peer.id, nickname: hostNick });
      for (var i = 0; i < this.clientConns.length; i++) {
        var c = this.clientConns[i];
        if (!c || !c.open) continue;
        st.players.push({
          id: c.peer || 'peer',
          nickname: c.vlNick || 'Player'
        });
      }
      st.matchState = this.vlMatchActive ? 'PLAYING' : 'WAITING';
      st.matchStartTime = this.vlMatchActive ? Date.now() : 0;
      st.matchScore.blue = this.score[0];
      st.matchScore.red = this.score[1];
      window.lobbyState = st;
    },

    _vlBroadcastLobbyToClients: function () {
      if (!this.isHost || !this.peer || !this.peer.open) return;
      this._vlRebuildLobbyState();
      var st = window.lobbyState;
      if (!st) return;
      var payload = { type: 'vl-lobby-state', state: JSON.parse(JSON.stringify(st)) };
      for (var j = 0; j < this.clientConns.length; j++) {
        var c = this.clientConns[j];
        if (c && c.open) c.send(payload);
      }
      this._vlEmitLobbyUpdated();
    },

    _buildArena: function () {
      var scene = this.el;
      var w = this;
      var A = ARENA;
      var ch = A.cageH;
      var wallCy = 0.02 + ch * 0.5;
      /* Match DodgeVR: depthWrite off so spectators outside can see through stacked glass + interior. */
      var neonGlass =
        'shader: standard; transparent: true; side: double; depthWrite: false; opacity: 0.14; metalness: 0.2; roughness: 0.15; emissiveIntensity: 0.55';

      var root = document.createElement('a-entity');
      root.setAttribute('id', 'vl-arena-root');
      root.setAttribute('position', A.cx + ' ' + A.cy + ' ' + A.cz);
      scene.appendChild(root);

      function wireBox(hw, hh, hd, color, pos, opacity) {
        var e = document.createElement('a-box');
        e.setAttribute('width', (hw * 2).toString());
        e.setAttribute('height', (hh * 2).toString());
        e.setAttribute('depth', (hd * 2).toString());
        e.setAttribute('position', pos);
        e.setAttribute(
          'material',
          'color: ' +
            color +
            '; wireframe: true; opacity: ' +
            opacity +
            '; transparent: true; side: double; depthWrite: false; emissive: ' +
            color +
            '; emissiveIntensity: 0.85'
        );
        root.appendChild(e);
        return e;
      }

      function glassPane(hw, hh, hd, pos, emissive) {
        var e = document.createElement('a-box');
        e.setAttribute('width', (hw * 2).toString());
        e.setAttribute('height', (hh * 2).toString());
        e.setAttribute('depth', (hd * 2).toString());
        e.setAttribute('position', pos);
        e.setAttribute('material', neonGlass + '; color: #030508; emissive: ' + emissive);
        root.appendChild(e);
      }

      wireBox(A.halfW, ch * 0.5, A.wallT, '#00ffff', '0 ' + wallCy + ' ' + (-A.halfD + A.wallT), 0.95);
      wireBox(A.halfW, ch * 0.5, A.wallT, '#00ffff', '0 ' + wallCy + ' ' + (A.halfD - A.wallT), 0.95);
      wireBox(A.wallT, ch * 0.5, A.halfD, '#00ffff', (-A.halfW + A.wallT) + ' ' + wallCy + ' 0', 0.95);
      wireBox(A.wallT, ch * 0.5, A.halfD, '#00ddff', (A.halfW - A.wallT) + ' ' + wallCy + ' 0', 0.95);
      wireBox(A.halfW, A.wallT, A.halfD, '#66ffff', '0 ' + (0.02 + ch + A.wallT) + ' 0', 0.85);

      glassPane(0.006, ch * 0.48, A.halfD - A.wallT * 2, (-A.halfW + A.wallT * 1.6) + ' ' + wallCy + ' 0', '#00ccff');
      glassPane(0.006, ch * 0.48, A.halfD - A.wallT * 2, (A.halfW - A.wallT * 1.6) + ' ' + wallCy + ' 0', '#ff9944');
      glassPane(A.halfW - A.wallT * 2, ch * 0.48, 0.006, '0 ' + wallCy + ' ' + (-A.halfD + A.wallT * 1.6), '#00ddff');
      glassPane(A.halfW - A.wallT * 2, ch * 0.48, 0.006, '0 ' + wallCy + ' ' + (A.halfD - A.wallT * 1.6), '#ff9944');

      var halfFieldL = document.createElement('a-plane');
      halfFieldL.setAttribute('width', A.halfW);
      halfFieldL.setAttribute('height', A.halfD * 2);
      halfFieldL.setAttribute('position', (-A.halfW * 0.5) + ' 0.024 0');
      halfFieldL.setAttribute('rotation', '-90 0 0');
      halfFieldL.setAttribute(
        'material',
        'shader: flat; color: #1144aa; opacity: 0.52; transparent: true; side: double; depthWrite: false; emissive: #2266dd; emissiveIntensity: 0.42'
      );
      root.appendChild(halfFieldL);

      var halfFieldR = document.createElement('a-plane');
      halfFieldR.setAttribute('width', A.halfW);
      halfFieldR.setAttribute('height', A.halfD * 2);
      halfFieldR.setAttribute('position', (A.halfW * 0.5) + ' 0.024 0');
      halfFieldR.setAttribute('rotation', '-90 0 0');
      halfFieldR.setAttribute(
        'material',
        'shader: flat; color: #aa4400; opacity: 0.52; transparent: true; side: double; depthWrite: false; emissive: #ee6622; emissiveIntensity: 0.4'
      );
      root.appendChild(halfFieldR);

      var midLine = document.createElement('a-box');
      midLine.setAttribute('width', '0.014');
      midLine.setAttribute('height', '0.006');
      midLine.setAttribute('depth', (A.halfD * 2 - 0.06).toString());
      midLine.setAttribute('position', '0 0.028 0');
      midLine.setAttribute(
        'material',
        'shader: flat; color: #ccffff; opacity: 0.75; transparent: true; side: double; depthWrite: false; emissive: #ccffff; emissiveIntensity: 0.45'
      );
      root.appendChild(midLine);

      var floorBase = document.createElement('a-box');
      floorBase.setAttribute('width', (A.halfW * 2).toString());
      floorBase.setAttribute('height', '0.018');
      floorBase.setAttribute('depth', (A.halfD * 2).toString());
      floorBase.setAttribute('position', '0 0.009 0');
      floorBase.setAttribute(
        'material',
        'color: #0a0a12; opacity: 0.75; transparent: true; side: double; depthWrite: false; roughness: 0.96; metalness: 0.04'
      );
      root.appendChild(floorBase);
      var floorL = document.createElement('a-box');
      floorL.setAttribute('width', A.halfW.toString());
      floorL.setAttribute('height', '0.014');
      floorL.setAttribute('depth', (A.halfD * 2).toString());
      floorL.setAttribute('position', (-A.halfW * 0.5) + ' 0.018 0');
      floorL.setAttribute(
        'material',
        'shader: flat; color: #1a3a8a; opacity: 0.45; transparent: true; side: double; depthWrite: false; emissive: #3366cc; emissiveIntensity: 0.2'
      );
      root.appendChild(floorL);
      var floorR = document.createElement('a-box');
      floorR.setAttribute('width', A.halfW.toString());
      floorR.setAttribute('height', '0.014');
      floorR.setAttribute('depth', (A.halfD * 2).toString());
      floorR.setAttribute('position', (A.halfW * 0.5) + ' 0.018 0');
      floorR.setAttribute(
        'material',
        'shader: flat; color: #8a3010; opacity: 0.45; transparent: true; side: double; depthWrite: false; emissive: #cc5520; emissiveIntensity: 0.2'
      );
      root.appendChild(floorR);

      var wallFullH = ch;
      var wallFullZ = A.halfD * 2;
      var goalH = wallFullH * 0.5;
      var goalDz = wallFullZ * 0.5;
      var goalDepthX = Math.max(A.wallT * 2 * 0.5, 0.056);
      var innerXF = A.halfW - 2 * A.wallT;
      var g1x = -innerXF + goalDepthX * 0.52;
      var g2x = innerXF - goalDepthX * 0.52;
      var g1w = document.createElement('a-box');
      g1w.setAttribute('id', 'vl-goal-west');
      g1w.setAttribute('width', (goalDepthX + 0.004).toString());
      g1w.setAttribute('height', goalH.toString());
      g1w.setAttribute('depth', goalDz.toString());
      g1w.setAttribute('position', g1x + ' ' + wallCy + ' 0');
      g1w.setAttribute(
        'material',
        'shader: flat; color: #88ccff; wireframe: true; opacity: 0.95; transparent: true; side: double; depthWrite: false; emissive: #aaeeff; emissiveIntensity: 1.1'
      );
      root.appendChild(g1w);
      var g2w = document.createElement('a-box');
      g2w.setAttribute('id', 'vl-goal-east');
      g2w.setAttribute('width', (goalDepthX + 0.004).toString());
      g2w.setAttribute('height', goalH.toString());
      g2w.setAttribute('depth', goalDz.toString());
      g2w.setAttribute('position', g2x + ' ' + wallCy + ' 0');
      g2w.setAttribute(
        'material',
        'shader: flat; color: #ff8833; wireframe: true; opacity: 0.95; transparent: true; side: double; depthWrite: false; emissive: #ffaa66; emissiveIntensity: 1.15'
      );
      root.appendChild(g2w);

      var centerRing = document.createElement('a-ring');
      centerRing.setAttribute('radius-inner', '0.11');
      centerRing.setAttribute('radius-outer', '0.118');
      centerRing.setAttribute('rotation', '-90 0 0');
      centerRing.setAttribute('position', '0 0.028 0');
      centerRing.setAttribute(
        'material',
        'shader: flat; color: #00ffff; opacity: 0.55; transparent: true; side: double; depthWrite: false; emissive: #00ffff; emissiveIntensity: 0.4'
      );
      root.appendChild(centerRing);

      function floorRectOutline(hw, hd, px, py, pz, color, op) {
        var tt = 0.007;
        wireBox(hw, tt, tt, color, px + ' ' + py + ' ' + (pz - hd), op);
        wireBox(hw, tt, tt, color, px + ' ' + py + ' ' + (pz + hd), op);
        wireBox(tt, tt, hd, color, (px - hw) + ' ' + py + ' ' + pz, op);
        wireBox(tt, tt, hd, color, (px + hw) + ' ' + py + ' ' + pz, op);
      }

      floorRectOutline(A.halfW - A.wallT * 1.5, A.halfD - A.wallT * 1.5, 0, 0.027, 0, '#88ffff', 0.9);
      var penD = 0.11;
      var penW = A.goalW * 1.05;
      floorRectOutline(penD * 0.5, penW, -A.halfW + penD * 0.5 + A.wallT * 2, 0.027, 0, '#22ccff', 0.88);
      floorRectOutline(penD * 0.5, penW, A.halfW - penD * 0.5 - A.wallT * 2, 0.027, 0, '#ffaa55', 0.88);

      var floorShape = new CANNON.Box(new CANNON.Vec3(A.halfW, 0.02, A.halfD));
      var floorBody = new CANNON.Body({ mass: 0, material: this.floorMat });
      floorBody.addShape(floorShape);
      floorBody.position.set(A.cx, A.cy, A.cz);
      this.world.addBody(floorBody);
      this.wallBodies.push(floorBody);
      this.floorBody = floorBody;

      function addWall(hx, hy, hz, px, py, pz) {
        var sh = new CANNON.Box(new CANNON.Vec3(hx, hy, hz));
        var b = new CANNON.Body({ mass: 0, material: w.defaultMat });
        b.addShape(sh);
        b.position.set(A.cx + px, A.cy + py, A.cz + pz);
        w.world.addBody(b);
        w.wallBodies.push(b);
      }

      addWall(A.halfW, ch * 0.5, A.wallT, 0, wallCy, -A.halfD + A.wallT);
      addWall(A.halfW, ch * 0.5, A.wallT, 0, wallCy, A.halfD - A.wallT);
      var gw = A.goalW;
      var hzGoalSeg = (A.halfD - gw) * 0.5;
      var zNorth = gw + hzGoalSeg;
      var zSouth = -gw - hzGoalSeg;
      addWall(A.wallT, ch * 0.5, hzGoalSeg, -A.halfW + A.wallT, wallCy, zNorth);
      addWall(A.wallT, ch * 0.5, hzGoalSeg, -A.halfW + A.wallT, wallCy, zSouth);
      addWall(A.wallT, ch * 0.5, hzGoalSeg, A.halfW - A.wallT, wallCy, zNorth);
      addWall(A.wallT, ch * 0.5, hzGoalSeg, A.halfW - A.wallT, wallCy, zSouth);

      /* Goal mouth rims (physics): thin jambs so the ball bounces off the frame, not only walls/net. */
      var jambHz = 0.024;
      var jambHy = ch * 0.46;
      var jambHx = A.wallT * 2.6;
      var jawXw = -A.halfW + A.wallT * 1.08;
      var jawXe = A.halfW - A.wallT * 1.08;
      var jambZoff = jambHz * 0.5 + 0.006;
      addWall(jambHx, jambHy, jambHz, jawXw, wallCy, gw + jambZoff);
      addWall(jambHx, jambHy, jambHz, jawXw, wallCy, -gw - jambZoff);
      addWall(jambHx, jambHy, jambHz, jawXe, wallCy, gw + jambZoff);
      addWall(jambHx, jambHy, jambHz, jawXe, wallCy, -gw - jambZoff);
      var lintHy = 0.014;
      var lintHx = A.wallT * 2.6;
      var lintHz = Math.max(gw - jambHz * 1.5, gw * 0.82);
      var goalHalfY = ch * 0.25;
      addWall(lintHx, lintHy, lintHz, jawXw, wallCy + goalHalfY - lintHy * 0.55, 0);
      addWall(lintHx, lintHy, lintHz, jawXw, wallCy - goalHalfY + lintHy * 0.55, 0);
      addWall(lintHx, lintHy, lintHz, jawXe, wallCy + goalHalfY - lintHy * 0.55, 0);
      addWall(lintHx, lintHy, lintHz, jawXe, wallCy - goalHalfY + lintHy * 0.55, 0);

      var netHx = 0.02;
      var netHy = ch * 0.36;
      var netHz = gw * 0.92;
      /* Deep pocket so the ball can cross the goal line before overlapping the net solid. */
      var netBackX = A.halfW + Math.max(A.goalDepth * 1.45, BALL_R * 4.2);
      addWall(netHx, netHy, netHz, -netBackX, wallCy, 0);
      addWall(netHx, netHy, netHz, netBackX, wallCy, 0);
      addWall(A.halfW, A.wallT, A.halfD, 0, 0.02 + ch + A.wallT, 0);

      this._vlLedScratch = {
        camW: new THREE.Vector3(),
        carW: new THREE.Vector3(),
        dirW: new THREE.Vector3()
      };

      var soccerTex = vlMakeSoccerBallTexture(THREE);
      var ballMat = new THREE.MeshStandardMaterial({
        map: soccerTex,
        roughness: 0.32,
        metalness: 0.06,
        emissive: new THREE.Color(0x080a12),
        emissiveIntensity: 0.06
      });
      var ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 64, 64), ballMat);
      var ballEl = document.createElement('a-entity');
      ballEl.setAttribute('position', '0 ' + (ch * 0.32) + ' 0');
      ballEl.setObject3D('mesh', ballMesh);
      root.appendChild(ballEl);
      this.ballEl = ballEl;
      this._vlSoccerTex = soccerTex;

      var ballShape = new CANNON.Sphere(BALL_R);
      this.ballBody = new CANNON.Body({ mass: 0.22, material: this.ballMat, linearDamping: 0.018, angularDamping: 0.012 });
      this.ballBody.addShape(ballShape);
      this.ballBody.position.set(A.cx, A.cy + ch * 0.32, A.cz);
      this.world.addBody(this.ballBody);

      var dGoal = A.wallT + CAR_HALF * 1.25 + 0.015;
      var westX = -A.halfW + dGoal;
      var eastX = A.halfW - dGoal;
      var dz = 0.22;
      var slotXZ = [
        { x: westX, z: dz },
        { x: eastX, z: dz },
        { x: westX, z: -dz },
        { x: eastX, z: -dz }
      ];
      this._carSpawn = [];
      var ballWx = A.cx;
      var ballWy = A.cy + ch * 0.32;
      var ballWz = A.cz;
      var tmpLook = new THREE.Object3D();

      for (var i = 0; i < 4; i++) {
        var c = SPEC[i];
        var el = document.createElement('a-box');
        el.setAttribute('width', (CAR_HALF * 2).toString());
        el.setAttribute('height', (CAR_HALF * 2).toString());
        el.setAttribute('depth', (CAR_HALF * 2).toString());
        var sx = slotXZ[i].x;
        var sz = slotXZ[i].z;
        var sy = ch * 0.28 + (i % 2) * 0.06;
        el.setAttribute('position', sx + ' ' + sy + ' ' + sz);
        el.setAttribute('material', 'color: ' + c.color + '; metalness: 0.45; roughness: 0.25; emissive: ' + c.color + '; emissiveIntensity: 0.12');
        root.appendChild(el);
        this.carEls.push(el);

        var led = vlCreateCarLedFace(THREE, CAR_HALF, c.color);
        el.object3D.add(led.pivot);
        this._vlCarLed.push({
          pivot: led.pivot,
          texture: led.texture,
          ctx: led.ctx,
          canvasW: led.canvas.width,
          canvasH: led.canvas.height,
          geometry: led.geometry,
          material: led.material,
          mesh: led.mesh,
          ledBodyColor: c.color,
          tongueUntil: 0,
          hitFaceUntil: 0,
          nearLatch: false,
          lastDrawnMode: 'neutral'
        });

        var topCap = document.createElement('a-box');
        topCap.setAttribute('class', 'vl-car-top');
        topCap.setAttribute('width', (CAR_HALF * 2 - 0.006).toString());
        topCap.setAttribute('depth', (CAR_HALF * 2 - 0.006).toString());
        topCap.setAttribute('height', '0.012');
        topCap.setAttribute('position', '0 ' + (CAR_HALF + 0.006) + ' 0');
        topCap.setAttribute(
          'material',
          'shader: flat; color: #6ec8ff; metalness: 0.12; roughness: 0.32; emissive: #4aa8e8; emissiveIntensity: 0.45'
        );
        el.appendChild(topCap);

        var boxShape = new CANNON.Box(new CANNON.Vec3(CAR_HALF, CAR_HALF, CAR_HALF));
        var body = new CANNON.Body({ mass: 0.02, material: this.carMat, linearDamping: 0.55, angularDamping: 0.95 });
        body.addShape(boxShape);
        var wx = A.cx + sx;
        var wy = A.cy + sy;
        var wz = A.cz + sz;
        body.position.set(wx, wy, wz);
        body.fixedRotation = false;
        tmpLook.position.set(wx, wy, wz);
        tmpLook.up.set(0, 1, 0);
        /* THREE.Object3D.lookAt (non-camera): matrix eye=target, target=self → body +Z points toward ball. */
        tmpLook.lookAt(ballWx, ballWy, ballWz);
        body.quaternion.set(tmpLook.quaternion.x, tmpLook.quaternion.y, tmpLook.quaternion.z, tmpLook.quaternion.w);
        body.vlCarSlot = i;
        body.addEventListener('collide', this._onCarCollide);
        this.world.addBody(body);
        this.carBodies.push(body);
        this._carSpawn.push({
          x: body.position.x,
          y: body.position.y,
          z: body.position.z,
          qx: body.quaternion.x,
          qy: body.quaternion.y,
          qz: body.quaternion.z,
          qw: body.quaternion.w
        });
      }

      this._arenaRoot = root;
    },

    _resumeAudioIfNeeded: function () {
      var scene = this.el.sceneEl || this.el;
      if (scene && scene.audioContext && scene.audioContext.state === 'suspended') {
        scene.audioContext.resume().catch(function () {});
      }
    },

    _isWallBody: function (b) {
      if (!b || !this.wallBodies) return false;
      for (var i = 0; i < this.wallBodies.length; i++) {
        if (this.wallBodies[i] === b) return true;
      }
      return false;
    },

    _carBodyIndex: function (b) {
      if (!b || !this.carBodies) return -1;
      for (var i = 0; i < this.carBodies.length; i++) {
        if (this.carBodies[i] === b) return i;
      }
      return -1;
    },

    _broadcastFx: function (msg) {
      if (!this.clientConns || !this.clientConns.length) return;
      for (var i = 0; i < this.clientConns.length; i++) {
        var c = this.clientConns[i];
        if (c && c.open) try { c.send(msg); } catch (e) {}
      }
    },

    _playBounceWorld: function (wx, wy, wz, speed) {
      this._resumeAudioIfNeeded();
      var el = document.getElementById('vl-bounce-sound');
      if (!el) return;
      var sc = el.components && el.components.sound;
      if (!sc) return;
      el.object3D.position.set(wx, wy, wz);
      var normSpeed = Math.min((speed || 0) / 12, 1);
      var rate = 1.12 + normSpeed * 0.42;
      var vol = 0.55 + normSpeed * 0.38;
      try {
        if (sc.pool && sc.pool.children) {
          for (var i = 0; i < sc.pool.children.length; i++) {
            var a = sc.pool.children[i];
            if (a && !a.isPlaying) {
              if (a.setPlaybackRate) a.setPlaybackRate(rate);
              if (a.setVolume) a.setVolume(vol);
            }
          }
        }
      } catch (e1) {}
      sc.stopSound();
      sc.playSound();
    },

    _playGoalSound: function () {
      this._resumeAudioIfNeeded();
      var el = document.getElementById('vl-goal-sound');
      if (!el) return;
      var sc = el.components && el.components.sound;
      if (!sc) return;
      sc.stopSound();
      sc.playSound();
    },

    _hapticActuator: function (handEl) {
      if (!handEl || !handEl.components) return null;
      var names = ['tracked-controls', 'oculus-touch-controls', 'meta-touch-controls'];
      for (var k = 0; k < names.length; k++) {
        var comp = handEl.components[names[k]];
        var g = comp && comp.controller && comp.controller.gamepad;
        if (g && g.hapticActuators && g.hapticActuators[0]) return g.hapticActuators[0];
      }
      return null;
    },

    _pulseHand: function (handEl, intensity, durationMs) {
      var act = this._hapticActuator(handEl);
      if (act) act.pulse(intensity, durationMs).catch(function () {});
    },

    _pulseBothHands: function (intensity, durationMs) {
      this._pulseHand(vlHandEl('leftHand', 'vl-hand-left'), intensity, durationMs);
      this._pulseHand(vlHandEl('rightHand', 'vl-hand-right'), intensity, durationMs);
    },

    /** Cannon 0.6.2: use Body "collide" (World "beginContact" does not exist in this build). */
    _onBallCollide: function (evt) {
      if (!this.isHost || !this.ballBody) return;
      var other = evt.body;
      if (!other) return;
      var ball = this.ballBody;
      var now = performance.now();
      var p = ball.position;
      var sp = ball.velocity.length();
      var impactN = 0;
      if (evt.contact && typeof evt.contact.getImpactVelocityAlongNormal === 'function') {
        try {
          impactN = Math.abs(evt.contact.getImpactVelocityAlongNormal());
        } catch (eN) {}
      }
      var carIdx = this._carBodyIndex(other);
      if (carIdx >= 0) {
        if (now < this._vlAudioNextCarHit) return;
        this._vlAudioNextCarHit = now + 70;
        var carB = this.carBodies[carIdx];
        var midX = (p.x + carB.position.x) * 0.5;
        var midY = (p.y + carB.position.y) * 0.5;
        var midZ = (p.z + carB.position.z) * 0.5;
        var rel = new CANNON.Vec3();
        ball.velocity.vsub(carB.velocity, rel);
        var hitSpeed = Math.max(rel.length(), impactN, 0.15);
        /* Cannon slip is weak on fast glances; add ω ∝ r×v so cube hits visibly spin the ball. */
        var rx = p.x - carB.position.x;
        var ry = p.y - carB.position.y;
        var rz = p.z - carB.position.z;
        var ax = ry * rel.z - rz * rel.y;
        var ay = rz * rel.x - rx * rel.z;
        var az = rx * rel.y - ry * rel.x;
        var spinGain = 5.5;
        ball.angularVelocity.x += ax * spinGain;
        ball.angularVelocity.y += ay * spinGain;
        ball.angularVelocity.z += az * spinGain;
        var w = ball.angularVelocity;
        var wm = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
        if (wm > 42) {
          var k = 42 / wm;
          w.x *= k;
          w.y *= k;
          w.z *= k;
        }
        this._playBounceWorld(midX, midY, midZ, hitSpeed);
        if (carIdx === this.mySlot) {
          this._pulseBothHands(0.72, 95);
        }
        this._broadcastFx({ type: 'vl-carhit', slot: carIdx, x: midX, y: midY, z: midZ, sp: hitSpeed });
        return;
      }
      if (this._isWallBody(other)) {
        if (now < this._vlAudioNextBounce) return;
        this._vlAudioNextBounce = now + 42;
        var bounceSp = Math.max(sp, impactN, 0.12);
        this._playBounceWorld(p.x, p.y, p.z, bounceSp);
        this._broadcastFx({ type: 'vl-bounce', x: p.x, y: p.y, z: p.z, sp: bounceSp });
      }
    },

    /** Car vs wall / car vs car (ball handled on ball’s collide only). */
    _onCarCollide: function (evt) {
      if (!this.isHost || !this.ballBody) return;
      var carBody = evt.target;
      var other = evt.body;
      if (!carBody || !other || other === this.ballBody) return;

      var carIdx = typeof carBody.vlCarSlot === 'number' ? carBody.vlCarSlot : this._carBodyIndex(carBody);
      if (carIdx < 0) return;

      var impactN = 0;
      if (evt.contact && typeof evt.contact.getImpactVelocityAlongNormal === 'function') {
        try {
          impactN = Math.abs(evt.contact.getImpactVelocityAlongNormal());
        } catch (eN) {}
      }

      var otherCarIdx = this._carBodyIndex(other);
      var relSp;
      var midX, midY, midZ;
      var slots;
      var syncAudio;

      if (otherCarIdx >= 0) {
        var rel = carBody.velocity.vsub(other.velocity);
        relSp = Math.max(rel.length(), impactN, 0.15);
        if (relSp < 0.2) return;
        midX = (carBody.position.x + other.position.x) * 0.5;
        midY = (carBody.position.y + other.position.y) * 0.5;
        midZ = (carBody.position.z + other.position.z) * 0.5;
        slots = [carIdx, otherCarIdx];
        syncAudio = carIdx < otherCarIdx;
      } else if (this._isWallBody(other)) {
        relSp = Math.max(carBody.velocity.length(), impactN, 0.12);
        if (relSp < 0.14) return;
        midX = carBody.position.x;
        midY = carBody.position.y;
        midZ = carBody.position.z;
        slots = [carIdx];
        syncAudio = true;
      } else {
        return;
      }

      this._vlApplyCarImpact(slots, midX, midY, midZ, relSp, syncAudio);
    },

    /**
     * @param {number[]} slots car indices
     * @param {boolean} syncAudioAndNet play bounce + broadcast once (car–car: lower slot index only)
     */
    _vlApplyCarImpact: function (slots, midX, midY, midZ, relSp, syncAudioAndNet) {
      var now = performance.now();
      var si, s, L;
      for (si = 0; si < slots.length; si++) {
        s = slots[si];
        if (typeof s !== 'number' || s < 0 || s > 3) continue;
        L = this._vlCarLed[s];
        if (!L) continue;
        L.hitFaceUntil = now + VL_HIT_FACE_MS;
        vlDrawLedFace(L.ctx, L.canvasW, L.canvasH, 'hit', L.ledBodyColor);
        L.texture.needsUpdate = true;
        L.lastDrawnMode = 'hit';
      }
      if (!syncAudioAndNet) return;
      this._broadcastFx({
        type: 'vl-carimpact',
        slots: slots,
        x: midX,
        y: midY,
        z: midZ,
        sp: relSp
      });
      if (now < this._vlAudioNextCarObstacle) return;
      this._vlAudioNextCarObstacle = now + 55;
      this._playBounceWorld(midX, midY, midZ, relSp);
      for (si = 0; si < slots.length; si++) {
        if (slots[si] === this.mySlot) {
          this._pulseBothHands(0.55, 75);
          break;
        }
      }
    },

    _updateThrusterSound: function (inp) {
      var rh = vlHandEl('rightHand', 'vl-hand-right');
      if (!rh) return;
      var el = rh.querySelector('.vl-thruster-sound');
      var vfx = rh.querySelector('.vl-thruster-vfx');
      if (!el || !el.components || !el.components.sound) return;
      var sc = el.components.sound;
      var on = inp && inp.trig > 0.04;
      if (on) {
        this._resumeAudioIfNeeded();
        if (vfx) vfx.setAttribute('visible', true);
        if (!this._vlThrusterPlaying) {
          this._vlThrusterPlaying = true;
          sc.playSound();
        }
      } else {
        if (vfx) vfx.setAttribute('visible', false);
        if (this._vlThrusterPlaying) {
          this._vlThrusterPlaying = false;
          sc.stopSound();
        }
      }
    },

    _applySpectatorTransform: function (slot) {
      if (!this._rig) return;
      var yawEl = this._rigYaw || this._rig;
      var s = SPEC[slot] || SPEC[0];
      var A = ARENA;
      var ox = s.ox;
      var oz = s.oz;
      var len = Math.sqrt(ox * ox + oz * oz) || 1;
      var push = 0.22;
      var rigX = A.cx + ox + (ox / len) * push;
      var rigZ = A.cz + oz + (oz / len) * push;
      var ballX = A.cx;
      var ballZ = A.cz;
      var dx = ballX - rigX;
      var dz = ballZ - rigZ;
      var yDeg;
      var eps = 1e-6;
      if (dx * dx + dz * dz < eps * eps) {
        yDeg = rigX > ballX ? -90 : 90;
      } else {
        /* Horizontal yaw toward ball; use atan2(-dx, dz), not atan2(dx,-dz), which is 180° off for this A-Frame camera rig. */
        yDeg = (Math.atan2(-dx, dz) * 180) / Math.PI;
      }
      this._rig.setAttribute('position', { x: rigX, y: 0, z: rigZ });
      if (yawEl !== this._rig) {
        this._rig.setAttribute('rotation', { x: 0, y: 0, z: 0 });
      }
      yawEl.setAttribute('rotation', { x: 0, y: yDeg, z: 0 });
    },

    /** Rotate a body-local direction into world space (THREE, same convention as Cannon). */
    _bodyDirWorld: function (body, lx, ly, lz) {
      var q = new THREE.Quaternion(
        body.quaternion.x,
        body.quaternion.y,
        body.quaternion.z,
        body.quaternion.w
      );
      this.tmpVec.set(lx, ly, lz);
      this.tmpVec.applyQuaternion(q);
      return this.tmpVec;
    },

    /**
     * Local input: HeliVR/main.js updateHeliPhysics lines 188–216 (keyboard + Quest XR), verbatim
     * mapping. Wire format: lx=yaw, rx=roll, ry=pitch, trig=thrust (unchanged for PeerJS).
     */
    _gatherLocalInput: function () {
      var out = zeroInput();
      var scn = this.el.sceneEl || this.el;
      var vm = scn.components && scn.components['vr-menu'];
      if (vm && vm.menuVisible) return out;
      var kb = this.keys || {};

      var pitch = (kb['ArrowUp'] ? 1 : 0) + (kb['ArrowDown'] ? -1 : 0);
      var roll = (kb['ArrowLeft'] ? -1 : 0) + (kb['ArrowRight'] ? 1 : 0);
      var yaw = (kb['KeyA'] ? 1 : 0) + (kb['KeyD'] ? -1 : 0);
      if (kb['KeyI']) pitch += 1;
      if (kb['KeyK']) pitch -= 1;
      if (kb['KeyU']) roll -= 1;
      if (kb['KeyO']) roll += 1;
      if (kb['KeyJ']) yaw -= 1;
      if (kb['KeyL']) yaw += 1;
      if (kb['KeyN']) pitch += 1;
      if (kb['KeyM']) pitch -= 1;

      var scene = this.el;
      var renderer = scene.renderer;
      if (renderer && renderer.xr && renderer.xr.isPresenting) {
        var session = renderer.xr.getSession();
        if (session && session.inputSources) {
          for (var i = 0; i < session.inputSources.length; i++) {
            var source = session.inputSources[i];
            if (source.gamepad) {
              var axes = source.gamepad.axes;
              var buttons = source.gamepad.buttons;
              if (source.handedness === 'right') {
                /* Axes 2/3 = thumbstick X/Y; sign depends on browser/WebXR runtime (flip both if stick feels inverted). */
                roll += axes[2] || 0;
                pitch -= axes[3] || 0;
                if (buttons[0]) {
                  out.trig = Math.max(out.trig, buttons[0].pressed ? 1 : buttons[0].value || 0);
                }
              } else if (source.handedness === 'left') {
                yaw -= axes[2] || 0;
                if (buttons[0]) {
                  out.trig = Math.max(out.trig, (buttons[0].value || 0) * 0.9);
                }
              }
            }
          }
        }
      }

      out.lx = yaw;
      out.rx = roll;
      out.ry = pitch;
      if (kb['Space']) out.trig = Math.max(out.trig, 1);
      out.lx = clamp(out.lx, -1, 1);
      out.ly = 0;
      out.rx = clamp(out.rx, -1, 1);
      out.ry = clamp(out.ry, -1, 1);
      out.trig = clamp(out.trig, 0, 1);
      return out;
    },

    _applyCarControls: function (slot, inp) {
      var body = this.carBodies[slot];
      if (!body || !inp) return;

      /* HeliVR/main.js lines 226–231: local torque (pitch, yaw*1.5, roll) then applyQuaternion(mesh). */
      var pitch = inp.ry;
      var roll = inp.rx;
      var yaw = inp.lx;
      this.tmpVec2.set(pitch * HELI_TORQUE_SCALE, yaw * HELI_TORQUE_SCALE * 1.5, roll * HELI_TORQUE_SCALE);
      var q = new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      this.tmpVec2.applyQuaternion(q);
      body.torque.x += this.tmpVec2.x;
      body.torque.y += this.tmpVec2.y;
      body.torque.z += this.tmpVec2.z;

      var trig = inp.trig || 0;
      if (trig > 0) {
        var fWorld = this._bodyDirWorld(body, 0, 0, 1);
        body.force.x += fWorld.x * trig * THRUST_FORWARD;
        body.force.y += fWorld.y * trig * THRUST_FORWARD;
        body.force.z += fWorld.z * trig * THRUST_FORWARD;
      }
    },

    _clampCarMotion: function (body) {
      if (!body) return;
      var v = body.velocity;
      var sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (sp > MAX_LIN_SPEED) {
        var k = MAX_LIN_SPEED / sp;
        v.x *= k;
        v.y *= k;
        v.z *= k;
      }
      var w = body.angularVelocity;
      var ws = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
      if (ws > MAX_ANG_SPEED) {
        var k2 = MAX_ANG_SPEED / ws;
        w.x *= k2;
        w.y *= k2;
        w.z *= k2;
      }
    },

    _refreshCubeHighlights: function () {
      for (var i = 0; i < this.carEls.length; i++) {
        var el = this.carEls[i];
        if (!el) continue;
        var c = SPEC[i].color;
        var me = i === this.mySlot;
        el.setAttribute(
          'material',
          'color: ' +
            c +
            '; metalness: 0.42; roughness: 0.22; emissive: ' +
            c +
            '; emissiveIntensity: ' +
            (me ? 0.62 : 0.1)
        );
      }
    },

    _checkGoals: function (dt) {
      if (this.goalCd > 0) {
        this.goalCd -= dt;
        return;
      }
      var b = this.ballBody;
      var A = ARENA;
      if (!b) return;
      var lx = b.position.x - A.cx;
      var lz = b.position.z - A.cz;
      var ly = b.position.y - A.cy;
      var r = BALL_R;
      var gw = A.goalW;
      var ch = A.cageH;
      var wallCy = 0.02 + ch * 0.5;
      /* Whole ball must cross the ±X goal line (FIFA-style), still inside mouth in Z and opening height in Y. */
      if (Math.abs(lz) > gw + r * 0.55) return;
      if (Math.abs(ly - wallCy) > ch * 0.48 + r * 0.45) return;
      var crossedWest = lx + r < -A.halfW;
      var crossedEast = lx - r > A.halfW;
      if (crossedWest) {
        if (this.vlMatchActive) {
          this.score[1]++;
          this._setScoreText();
          this._vlBroadcastLobbyToClients();
        }
        this._playGoalSound();
        this._broadcastFx({ type: 'vl-goal' });
        this._resetBall();
        this.goalCd = 2;
        return;
      }
      if (crossedEast) {
        if (this.vlMatchActive) {
          this.score[0]++;
          this._setScoreText();
          this._vlBroadcastLobbyToClients();
        }
        this._playGoalSound();
        this._broadcastFx({ type: 'vl-goal' });
        this._resetBall();
        this.goalCd = 2;
      }
    },

    _resetBall: function () {
      var A = ARENA;
      if (this.ballBody) {
        this.ballBody.velocity.set(0, 0, 0);
        this.ballBody.angularVelocity.set(0, 0, 0);
        this.ballBody.position.set(A.cx, A.cy + A.cageH * 0.32, A.cz);
      }
      this._resetCarsToSpawn();
    },

    /** Restore all cars to arena spawn pose and zero motion (host physics + offline). */
    _resetCarsToSpawn: function () {
      if (!this.carBodies || !this.carBodies.length || !this._carSpawn || this._carSpawn.length < 4) return;
      var i, body, s;
      for (i = 0; i < 4; i++) {
        body = this.carBodies[i];
        s = this._carSpawn[i];
        if (!body || !s) continue;
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        body.position.set(s.x, s.y, s.z);
        body.quaternion.set(s.qx, s.qy, s.qz, s.qw);
        if (typeof body.wakeUp === 'function') body.wakeUp();
      }
      if (this._vlCarLed) {
        for (i = 0; i < this._vlCarLed.length; i++) {
          var L = this._vlCarLed[i];
          if (!L) continue;
          L.hitFaceUntil = 0;
          L.tongueUntil = 0;
          L.nearLatch = false;
          L.lastDrawnMode = 'neutral';
          vlDrawLedFace(L.ctx, L.canvasW, L.canvasH, 'neutral', L.ledBodyColor);
          L.texture.needsUpdate = true;
        }
      }
    },

    _vlUpdateCarLedFaces: function (nowMs) {
      if (!this._vlCarLed || !this._vlCarLed.length || !this._vlLedScratch) return;
      var scene = this.el.sceneEl || this.el;
      var THREE = AFRAME.THREE;
      var S = this._vlLedScratch;
      if (!vlGetCameraWorldPosition(scene, S.camW)) return;
      if (this._arenaRoot) this._arenaRoot.object3D.updateMatrixWorld(true);

      var proxM = VL_LED_FACE_PROX_M;
      var proxM2 = proxM * proxM;
      /* Solo / practice: your own cube can react too (otherwise only slots 1–3 ever trigger). */
      var skipOwnCube = !!window.isMultiplayer;

      for (var i = 0; i < 4; i++) {
        var L = this._vlCarLed[i];
        var carEl = this.carEls[i];
        var body = this.carBodies[i];
        if (!L || !carEl || !body) continue;

        S.carW.set(body.position.x, body.position.y, body.position.z);
        S.dirW.subVectors(S.camW, S.carW);
        var d2 = S.dirW.lengthSq();
        var near =
          d2 < proxM2 && d2 > 1e-10 && (!skipOwnCube || i !== this.mySlot);

        if (near) {
          if (!L.nearLatch) {
            L.nearLatch = true;
            L.tongueUntil = nowMs + VL_LED_TONGUE_MS;
          }
        } else {
          L.nearLatch = false;
        }

        var hit = nowMs < L.hitFaceUntil;
        var tongue = nowMs < L.tongueUntil;
        var mode = hit ? 'hit' : tongue ? 'tongue' : 'neutral';
        if (mode !== L.lastDrawnMode) {
          vlDrawLedFace(L.ctx, L.canvasW, L.canvasH, mode, L.ledBodyColor);
          L.texture.needsUpdate = true;
          L.lastDrawnMode = mode;
        }

        /* LED stays flush on the cube (+Z face); no billboard / camera tracking. */
        if (L.pivot) L.pivot.quaternion.identity();
      }
    },

    _syncMeshesFromPhysics: function () {
      if (this.ballEl && this.ballBody) {
        this.ballEl.object3D.position.set(
          this.ballBody.position.x - ARENA.cx,
          this.ballBody.position.y - ARENA.cy,
          this.ballBody.position.z - ARENA.cz
        );
        this.ballEl.object3D.quaternion.set(
          this.ballBody.quaternion.x,
          this.ballBody.quaternion.y,
          this.ballBody.quaternion.z,
          this.ballBody.quaternion.w
        );
      }
      for (var i = 0; i < 4; i++) {
        if (this.carEls[i] && this.carBodies[i]) {
          var b = this.carBodies[i];
          this.carEls[i].object3D.position.set(b.position.x - ARENA.cx, b.position.y - ARENA.cy, b.position.z - ARENA.cz);
          this.carEls[i].object3D.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
        }
      }
    },

    _applyNetworkSnap: function (snap) {
      if (!snap || !snap.ball) return;
      var A = ARENA;
      var bp = snap.ball.p;
      var bq = snap.ball.q;
      var bv = snap.ball.v;
      this.ballBody.position.set(bp[0], bp[1], bp[2]);
      this.ballBody.quaternion.set(bq[0], bq[1], bq[2], bq[3]);
      this.ballBody.velocity.set(bv[0], bv[1], bv[2]);
      if (snap.ball.av) {
        this.ballBody.angularVelocity.set(snap.ball.av[0], snap.ball.av[1], snap.ball.av[2]);
      }
      for (var i = 0; i < 4; i++) {
        if (!snap.cars[i]) continue;
        var c = snap.cars[i];
        var body = this.carBodies[i];
        if (this.isHost && i === this.mySlot) continue;
        body.position.set(c.p[0], c.p[1], c.p[2]);
        body.quaternion.set(c.q[0], c.q[1], c.q[2], c.q[3]);
        body.velocity.set(c.v[0], c.v[1], c.v[2]);
        if (c.av) body.angularVelocity.set(c.av[0], c.av[1], c.av[2]);
      }
      if (typeof snap.score0 === 'number') {
        this.score[0] = snap.score0;
        this.score[1] = snap.score1;
        this._setScoreText();
      }
      if (typeof snap.vlMatchActive === 'boolean') {
        this.vlMatchActive = snap.vlMatchActive;
        if (!snap.vlMatchActive) this.vlMatchRemainSec = null;
      }
      if (
        this.vlMatchActive &&
        typeof snap.vlMatchRemainSec === 'number' &&
        isFinite(snap.vlMatchRemainSec)
      ) {
        this.vlMatchRemainSec = snap.vlMatchRemainSec;
      }
    },

    _serializeSnap: function () {
      var b = this.ballBody;
      var now = performance.now();
      var rem = null;
      if (this.vlMatchActive && this.vlMatchStartMs) {
        rem = Math.max(0, (VL_MATCH_DURATION_MS - (now - this.vlMatchStartMs)) / 1000);
      }
      var snap = {
        t: now,
        score0: this.score[0],
        score1: this.score[1],
        vlMatchActive: !!this.vlMatchActive,
        vlMatchRemainSec: rem,
        ball: {
          p: [b.position.x, b.position.y, b.position.z],
          q: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
          v: [b.velocity.x, b.velocity.y, b.velocity.z],
          av: [b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z]
        },
        cars: []
      };
      for (var i = 0; i < 4; i++) {
        var c = this.carBodies[i];
        snap.cars.push({
          p: [c.position.x, c.position.y, c.position.z],
          q: [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w],
          v: [c.velocity.x, c.velocity.y, c.velocity.z],
          av: [c.angularVelocity.x, c.angularVelocity.y, c.angularVelocity.z]
        });
      }
      return snap;
    },

    startOffline: function () {
      this._teardownNet();
      this.isHost = true;
      this.mySlot = 0;
      this.clientConns = [];
      this.vlMatchActive = false;
      this.vlMatchStartMs = 0;
      this.vlMatchRemainSec = null;
      this._vlMarkHudDirty();
      this._applySpectatorTransform(0);
      this._setStatus(
        'Practice (offline) — zero-G arena. Multiplayer: use Play online / Host / Join with the same lobby number. TURN/STUN: same relay as DodgeVR.'
      );
      this._resetBall();
      this._refreshCubeHighlights();
    },

    startHost: function (lobbyNum) {
      var self = this;
      window.connectionState = 'connecting';
      this._vlEmitLobbyUpdated();
      this._teardownNet();
      this._setStatus('Fetching TURN/STUN…');
      vlGetIceServers().then(function (ice) {
        self._openHostPeer(lobbyNum, ice);
      });
    },

    _openHostPeer: function (lobbyNum, iceServers) {
      var self = this;
      var hostId = HOST_ID_PREFIX + lobbyNum;
      this._setStatus('Creating host ' + hostId + '…');

      this.isHost = true;
      this.mySlot = 0;
      this.clientConns = [];
      this.vlMatchActive = false;
      this.vlMatchStartMs = 0;
      this.vlMatchRemainSec = null;
      this._applySpectatorTransform(0);

      this.peer = new Peer(hostId, vlPeerOptions(iceServers));
      this.peer.on('open', function () {
        window.isMultiplayer = true;
        window.connectionState = 'connected';
        window.myPlayerId = self.peer.id;
        self.vlMatchActive = false;
        self.vlMatchStartMs = 0;
        self.vlMatchRemainSec = null;
        self.score[0] = 0;
        self.score[1] = 0;
        self._setScoreText();
        self._vlRebuildLobbyState();
        self._vlEmitLobbyUpdated();
        self._setStatus('Hosting lobby ' + lobbyNum + ' — share this number. TURN: Metered (via relay).');
        self._resetBall();
        self._refreshCubeHighlights();
        self._vlBroadcastMatchSync();
      });
      this.peer.on('connection', function (conn) {
        conn.on('data', function (raw) {
          self._onHostData(conn, raw);
        });
        conn.on('open', function () {
          var slot = self._nextFreeSlot();
          if (slot < 0) {
            conn.send({ type: 'full' });
            conn.close();
            return;
          }
          conn.vlSlot = slot;
          conn.vlNick = 'Player';
          self.clientConns.push(conn);
          conn.send({ type: 'welcome', slot: slot, youHost: false });
          conn.send({ type: 'snap', data: self._serializeSnap() });
          self._vlBroadcastLobbyToClients();
        });
        conn.on('close', function () {
          if (conn.vlSlot != null) self.inputs[conn.vlSlot] = zeroInput();
          self.clientConns = self.clientConns.filter(function (x) { return x !== conn; });
          self._vlBroadcastLobbyToClients();
        });
      });
      this.peer.on('error', function (e) {
        self._setStatus('Host error: ' + (e && e.type ? e.type : String(e)));
        self._vlClearWindowMultiplayer();
        self.startOffline();
      });
    },

    /** If lobby host id is free → host; else join (Dodge-style one-click). */
    connectLobbySmart: function (lobbyNum) {
      var self = this;
      var hostId = HOST_ID_PREFIX + lobbyNum;
      this._setStatus('Checking lobby ' + lobbyNum + '…');
      vlCheckHostPeerIdAvailable(hostId).then(function (idFree) {
        if (idFree) self.startHost(lobbyNum);
        else self.joinClient(lobbyNum);
      });
    },

    _nextFreeSlot: function () {
      var taken = { 0: true };
      for (var i = 0; i < this.clientConns.length; i++) {
        var c = this.clientConns[i];
        if (c.open && c.vlSlot != null) taken[c.vlSlot] = true;
      }
      for (var s = 1; s < 4; s++) {
        if (!taken[s]) return s;
      }
      return -1;
    },

    _onHostData: function (conn, raw) {
      var msg = typeof raw === 'string' ? (function () {
        try { return JSON.parse(raw); } catch (e) { return null; }
      })() : raw;
      if (!msg || !msg.type) return;
      if (msg.type === 'vl-nick') {
        var nk = typeof msg.nick === 'string' ? msg.nick.trim().slice(0, 20) : '';
        conn.vlNick = nk || 'Player';
        this._vlBroadcastLobbyToClients();
        return;
      }
      if (msg.type === 'vl-match-cmd') {
        if (msg.action === 'start') this.vlStartMatch();
        else if (msg.action === 'end') this.vlEndMatch();
        return;
      }
      if (msg.type === 'inp' && conn.vlSlot != null) {
        this.inputs[conn.vlSlot] = {
          lx: typeof msg.lx === 'number' && isFinite(msg.lx) ? msg.lx : 0,
          ly: typeof msg.ly === 'number' && isFinite(msg.ly) ? msg.ly : 0,
          rx: typeof msg.rx === 'number' && isFinite(msg.rx) ? msg.rx : 0,
          ry: typeof msg.ry === 'number' && isFinite(msg.ry) ? msg.ry : 0,
          trig: typeof msg.trig === 'number' && isFinite(msg.trig) ? msg.trig : 0
        };
      }
    },

    joinClient: function (lobbyNum) {
      var self = this;
      window.connectionState = 'connecting';
      this._vlEmitLobbyUpdated();
      this._teardownNet();
      this._setStatus('Fetching TURN/STUN…');
      vlGetIceServers().then(function (ice) {
        self._openJoinPeer(lobbyNum, ice);
      });
    },

    _openJoinPeer: function (lobbyNum, iceServers) {
      var self = this;
      this.isHost = false;
      var hostId = HOST_ID_PREFIX + lobbyNum;
      var pid = 'vl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      this._setStatus('Connecting…');
      this.peer = new Peer(pid, vlPeerOptions(iceServers));
      this.peer.on('open', function () {
        self.hostConn = self.peer.connect(hostId, { serialization: 'json' });
        self.hostConn.on('open', function () {
          window.isMultiplayer = true;
          window.connectionState = 'connected';
          window.myPlayerId = self.peer.id;
          self._vlEmitLobbyUpdated();
          var nick =
            typeof window.playerNickname === 'string' && window.playerNickname.trim()
              ? window.playerNickname.trim().slice(0, 20)
              : 'Player';
          self.hostConn.send({ type: 'vl-nick', nick: nick });
          self._setStatus('Connected to lobby ' + lobbyNum + ' as ' + nick);
        });
        self.hostConn.on('data', function (data) {
          self._onClientData(data);
        });
        self.hostConn.on('close', function () {
          self._setStatus('Disconnected from host.');
          self._vlClearWindowMultiplayer();
          self.startOffline();
        });
        self.hostConn.on('error', function () {
          self._setStatus('Connection error.');
          self._vlClearWindowMultiplayer();
          self.startOffline();
        });
      });
      this.peer.on('error', function (e) {
        self._setStatus('Peer error: ' + (e && e.type ? e.type : String(e)));
        self._vlClearWindowMultiplayer();
        self.startOffline();
      });
    },

    _onClientData: function (data) {
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
          return;
        }
      }
      if (!data || !data.type) return;
      if (data.type === 'vl-lobby-state' && data.state) {
        window.lobbyState = data.state;
        this._vlEmitLobbyUpdated();
        return;
      }
      if (data.type === 'welcome') {
        this.mySlot = data.slot;
        this._applySpectatorTransform(this.mySlot);
        this._refreshCubeHighlights();
        this._setStatus(
          'Player ' +
            (this.mySlot + 1) +
            ' — brightest cube is yours. Sticks = attitude; trigger = forward only. Zeppelin-slow.'
        );
        return;
      }
      if (data.type === 'vl-match-sync') {
        this.vlMatchActive = !!data.active;
        if (typeof data.score0 === 'number') this.score[0] = data.score0;
        if (typeof data.score1 === 'number') this.score[1] = data.score1;
        if (typeof data.remSec === 'number' && isFinite(data.remSec)) {
          this.vlMatchRemainSec = data.remSec;
        } else {
          this.vlMatchRemainSec = null;
        }
        if (!data.active) this.vlMatchRemainSec = null;
        this._setScoreText();
        this._vlMarkHudDirty();
        return;
      }
      if (data.type === 'snap') {
        this._applyNetworkSnap(data.data);
        return;
      }
      if (data.type === 'full') {
        this._setStatus('Lobby full (4 players).');
        return;
      }
      if (data.type === 'vl-goal') {
        this._playGoalSound();
        return;
      }
      if (data.type === 'vl-bounce' && typeof data.x === 'number') {
        this._playBounceWorld(data.x, data.y, data.z, data.sp || 0);
        return;
      }
      if (data.type === 'vl-carhit' && typeof data.x === 'number') {
        this._playBounceWorld(data.x, data.y, data.z, data.sp || 0);
        if (typeof data.slot === 'number' && data.slot === this.mySlot) {
          this._pulseBothHands(0.72, 95);
        }
        return;
      }
      if (data.type === 'vl-carimpact') {
        var slots = data.slots;
        if (!slots || !slots.length) {
          if (typeof data.slot === 'number') slots = [data.slot];
        }
        if (!slots || !slots.length) return;
        var nowCi = performance.now();
        var ci, sci, Lc;
        for (ci = 0; ci < slots.length; ci++) {
          sci = slots[ci];
          if (typeof sci !== 'number' || sci < 0 || sci > 3) continue;
          Lc = this._vlCarLed[sci];
          if (!Lc) continue;
          Lc.hitFaceUntil = nowCi + VL_HIT_FACE_MS;
          vlDrawLedFace(Lc.ctx, Lc.canvasW, Lc.canvasH, 'hit', Lc.ledBodyColor);
          Lc.texture.needsUpdate = true;
          Lc.lastDrawnMode = 'hit';
        }
        if (typeof data.x === 'number') {
          if (nowCi >= this._vlAudioNextCarObstacle) {
            this._vlAudioNextCarObstacle = nowCi + 55;
            this._playBounceWorld(data.x, data.y, data.z, data.sp || 0.2);
          }
        }
        for (ci = 0; ci < slots.length; ci++) {
          if (slots[ci] === this.mySlot) {
            this._pulseBothHands(0.55, 75);
            break;
          }
        }
        return;
      }
    },

    _teardownNet: function () {
      if (this.hostConn) {
        try {
          this.hostConn.close();
        } catch (e) {}
        this.hostConn = null;
      }
      this.clientConns.forEach(function (c) {
        try {
          c.close();
        } catch (e) {}
      });
      this.clientConns = [];
      if (this.peer) {
        try {
          this.peer.destroy();
        } catch (e) {}
        this.peer = null;
      }
      this.isHost = false;
    },

    tick: function (t, dt) {
      var dtSec = dt / 1000;
      if (dtSec <= 0 || dtSec > 0.08) dtSec = 1 / 60;

      var inp = this._gatherLocalInput();
      this._updateThrusterSound(inp);
      if (this.isHost) {
        this.inputs[this.mySlot] = inp;
      } else if (this.hostConn && this.hostConn.open) {
        var now = performance.now();
        if (now - this.lastInputSend > 1000 / INPUT_HZ) {
          this.lastInputSend = now;
          this.hostConn.send({
            type: 'inp',
            lx: inp.lx,
            ly: inp.ly,
            rx: inp.rx,
            ry: inp.ry,
            trig: inp.trig
          });
        }
      }

      if (this.isHost) {
        for (var i = 0; i < 4; i++) {
          this.carBodies[i].force.set(0, 0, 0);
          this.carBodies[i].torque.set(0, 0, 0);
        }
        for (var s = 0; s < 4; s++) {
          this._applyCarControls(s, this.inputs[s]);
        }
        this.world.step(1 / 60, dtSec, 5);
        for (var ci = 0; ci < 4; ci++) {
          this._clampCarMotion(this.carBodies[ci]);
        }
        this._checkGoals(dtSec);
        this._syncMeshesFromPhysics();
        this.frame++;
        if (this.clientConns.length && this.frame % SYNC_EVERY === 0) {
          var snap = this._serializeSnap();
          for (var j = 0; j < this.clientConns.length; j++) {
            if (this.clientConns[j].open) this.clientConns[j].send({ type: 'snap', data: snap });
          }
        }
        if (this.vlMatchActive && this.vlMatchStartMs) {
          if (performance.now() - this.vlMatchStartMs >= VL_MATCH_DURATION_MS) {
            this.vlEndMatch("Time's up.");
          }
        }
      } else {
        this._syncMeshesFromPhysics();
      }
      this._vlPumpHud(t);
      this._vlUpdateCarLedFaces(t);
    },

    remove: function () {
      if (this.ballBody && this._onBallCollide) {
        this.ballBody.removeEventListener('collide', this._onBallCollide);
      }
      if (this._onCarCollide && this.carBodies) {
        for (var cbi = 0; cbi < this.carBodies.length; cbi++) {
          var cb = this.carBodies[cbi];
          if (cb) cb.removeEventListener('collide', this._onCarCollide);
        }
      }
      var sceneEl = this.el && (this.el.sceneEl || this.el);
      if (sceneEl && this._vlReseatSpectator) {
        sceneEl.removeEventListener('enter-vr', this._vlReseatSpectator);
      }
      var xr = this.el && this.el.renderer && this.el.renderer.xr;
      if (xr && this._vlReseatSpectator) {
        xr.removeEventListener('sessionstart', this._vlReseatSpectator);
      }
      this._teardownNet();
      if (this._vlSoccerTex) {
        this._vlSoccerTex.dispose();
        this._vlSoccerTex = null;
      }
      if (this.ballEl) {
        var bm = this.ballEl.getObject3D('mesh');
        if (bm) {
          if (bm.geometry) bm.geometry.dispose();
          if (bm.material) bm.material.dispose();
          this.ballEl.removeObject3D('mesh');
        }
      }
      if (this._vlCarLed) {
        for (var li = 0; li < this._vlCarLed.length; li++) {
          var L = this._vlCarLed[li];
          if (!L) continue;
          if (L.pivot && L.pivot.parent) L.pivot.parent.remove(L.pivot);
          if (L.geometry) L.geometry.dispose();
          if (L.material) L.material.dispose();
          if (L.texture) L.texture.dispose();
        }
        this._vlCarLed = [];
      }
      this._vlLedScratch = null;
    }
  });

  function vlGetVrleagueGame() {
    var el = document.querySelector('[vrleague-game]');
    return el && el.components && el.components['vrleague-game'];
  }

  window.connectToLobby = function (lobbyNum) {
    if (window.isMultiplayer) return;
    if (window.connectionState === 'connecting') return;
    lobbyNum = Math.max(1, Math.min(10, parseInt(lobbyNum, 10) || 1));
    window.connectionState = 'connecting';
    var scene = document.querySelector('a-scene');
    if (scene) scene.emit('lobby-state-updated');
    var hostId = HOST_ID_PREFIX + lobbyNum;
    window.__vlCheckHostPeerIdAvailable(hostId).then(function (idFree) {
      var g = vlGetVrleagueGame();
      if (!g) {
        window.connectionState = 'disconnected';
        if (scene) scene.emit('lobby-state-updated');
        return;
      }
      if (idFree) g.startHost(lobbyNum);
      else g.joinClient(lobbyNum);
    });
  };

  window.endMultiplayer = function () {
    var g = vlGetVrleagueGame();
    if (g) g.startOffline();
    window.lobbyState = null;
    window.isMultiplayer = false;
    window.connectionState = 'disconnected';
    window.myPlayerId = null;
    var scene = document.querySelector('a-scene');
    if (scene) scene.emit('lobby-state-updated');
  };

  window.sendQueueAction = function () {};

  window.sendMatchAction = function (action) {
    var g = vlGetVrleagueGame();
    if (!g) return;
    var hid = g.peer && g.peer.id ? String(g.peer.id) : '';
    var isLobbyHost = g.isHost && hid.indexOf('vrleague-host-') === 0;
    if (isLobbyHost) {
      if (action === 'start') g.vlStartMatch();
      else if (action === 'end') g.vlEndMatch();
      return;
    }
    if (g.hostConn && g.hostConn.open) {
      g.hostConn.send({ type: 'vl-match-cmd', action: action });
    }
  };
})();
