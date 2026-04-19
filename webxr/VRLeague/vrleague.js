/**
 * VRLeague — tabletop ball + cubes, host-authoritative Cannon physics, PeerJS (up to 4).
 */
(function () {
  'use strict';

  window.lobbyState = window.lobbyState || null;
  window.isMultiplayer = !!window.isMultiplayer;
  window.connectionState = window.connectionState || 'disconnected';
  window.myPlayerId = window.myPlayerId || null;
  window.vlBotUnbeatableMode = !!window.vlBotUnbeatableMode;

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
  /** Cockpit / first-person camera follow — off by default (set `true` to re-enable B / KeyB). */
  var VL_FPV_ENABLED = false;

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

  /** 5×7 block digits ('#' = LED on); centered on full 24×VL_LED_GRID_ROWS grid (no face). */
  var VL_LED_DIGIT_PATTERNS = [
    [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
    ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
    [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
    [' ### ', '#   #', '    #', ' ### ', '    #', '#   #', ' ### '],
    ['#   #', '#   #', '#   #', '#####', '    #', '    #', '    #'],
    ['#####', '#    ', '#    ', '#### ', '    #', '#   #', ' ### '],
    [' ### ', '#   #', '#    ', '#### ', '#   #', '#   #', ' ### '],
    ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
    [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
    [' ### ', '#   #', '#   #', ' ####', '    #', '#   #', ' ### ']
  ];

  function vlDrawLedSolidWhite(ctx, w, h) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }

  function vlDrawLedCountdownDigit(ctx, w, h, digit, onColor) {
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
    var pat = VL_LED_DIGIT_PATTERNS[digit % 10];
    var pw = 5;
    var ph = 7;
    var ox0 = Math.floor((cols - pw) * 0.5);
    var oy0 = Math.floor((rows - ph) * 0.5);
    var gx, gy, rowStr, ch;
    ctx.fillStyle = OFF;
    ctx.fillRect(0, 0, w, h);
    for (gy = 0; gy < rows; gy++) {
      for (gx = 0; gx < cols; gx++) {
        if (gx >= ox0 && gx < ox0 + pw && gy >= oy0 && gy < oy0 + ph) {
          rowStr = pat[gy - oy0] || '';
          ch = rowStr.charAt(gx - ox0);
          ctx.fillStyle = ch === '#' ? ON : OFF;
        } else {
          ctx.fillStyle = OFF;
        }
        ctx.fillRect(Math.floor(ox + gx * cell), Math.floor(oy + gy * cell), pxw, pxw);
      }
    }
  }

  /** Overshoot past 1 then settle (used for elastic pop). */
  function vlEaseOutBack(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    var s = 1.70158;
    var x = t - 1;
    return x * x * ((s + 1) * x + s) + 1;
  }

  function vlEaseInQuad(t) {
    return t * t;
  }

  function vlEaseOutQuad(t) {
    return 1 - (1 - t) * (1 - t);
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
  /** Bump emote: same sonar clip, lower playbackRate than tongue (1). */
  var VL_LED_SONAR_BUMP_RATE = 0.72;
  /** Host-authored LED mode per cube, replicated via `snap.vlLm` (single small int each). */
  var VL_LED_SM_NEUTRAL = 0;
  var VL_LED_SM_TONGUE = 1;
  var VL_LED_SM_HIT = 2;
  var VL_LED_SM_RESET_BLANK = 20;
  /** Countdown digit d (0–9) on LED uses code 30 + d. */
  var VL_LED_SM_RESET_DIGIT_BASE = 30;
  var BALL_R = 0.1664;
  var THRUST_FORWARD = 0.625;
  /** Left trigger reverse uses same order of magnitude as forward (tweak feel 0.7–1). */
  var THRUST_REVERSE_SCALE = 0.88;
  /** Auto-roll: wing-level only — body +Y → proj(worldUp) onto plane ⊥ thrust (+Z); corrects bank, not pitch. */
  var VL_AUTO_ROLL_UP_KP = 0.036;
  var VL_AUTO_ROLL_UP_KD = 0.014;
  var VL_AUTO_ROLL_UP_MAX = 0.028;
  /** Skip bank PD when thrust axis nearly parallel to world up (gimbal). */
  var VL_AUTO_ROLL_LEVEL_MIN_LEN_SQ = 0.00012;
  /** HeliVR torque formula uses one scale; tuned down for ~0.02 mass cubes vs HeliVR heli. */
  var HELI_TORQUE_SCALE = 0.006;
  var MAX_LIN_SPEED = 0.36;
  var MAX_ANG_SPEED = 0.32;
  /** Baseline physics broadcast interval (frames). During grab / cube reset / elastic scale, host sends every frame instead (see `_vlNeedHighFrequencySnap`). */
  var SYNC_EVERY = 3;
  var INPUT_HZ = 25;
  /** Hand within this distance (m) of cube center can start grab. */
  var VL_GRAB_REACH = 0.11;
  /** Throw speed cap (m/s) after release. */
  var VL_THROW_LIN_CAP = 3.6;
  var VL_THROW_ANG_CAP = 16;
  var VL_CUBE_RESET_CD_SEC = 5;
  /** Ungrabbed cube reset: tumble (body X/Y/Z mix), rad/s at countdown start / end; `out` phase holds at W1 until teleport. */
  var VL_RESET_CD_SPIN_W0 = 0.75;
  var VL_RESET_CD_SPIN_W1 = 9;
  var VL_RESET_CD_SPIN_MAX_ANG = 12;
  var VL_RESET_OUT_MS = 500;
  var VL_RESET_IN_MS = 500;
  /**
   * Host bots: stand on the ray opposing-goal → ball, past the ball toward own goal (m), so the line
   * through opp goal and ball places the cube on the correct “back” side to shove toward opp goal.
   */
  var VL_BOT_LINE_STANDOFF = 0.28;
  /** Within this distance of the ideal slot (m), blend steering toward shove axis (opp goal − ball). */
  var VL_BOT_ENGAGE_DIST = 0.36;
  /** Opposing goal mouth anchor inset from ±halfW (m). */
  var VL_BOT_OPP_GOAL_INSET = 0.08;
  /** Softer physics than humans — fewer boundary hits; defense uses low thrust too. */
  var VL_BOT_THRUST_SCALE = 0.32;
  var VL_BOT_TORQUE_SCALE = 0.52;
  /** Arena-local AABB inset from walls (m); repulsion ramps inside `VL_BOT_WALL_BAND` of this box. */
  var VL_BOT_WALL_INSET = CAR_HALF + ARENA.wallT * 2.75 + 0.05;
  var VL_BOT_WALL_BAND = 0.52;
  var VL_BOT_WALL_REP_K = 6.2;
  /** Steering: when clearance < SAFE+RANGE, blend toward pure wall-escape heading (0..1). */
  var VL_BOT_WALL_CLEAR_SAFE = 0.12;
  var VL_BOT_WALL_CLEAR_RANGE = 0.55;
  /** Post-physics: strip inward speed into walls below this (m/s) = “self” hit; keep more if faster (pushed). */
  var VL_BOT_WALL_PUSH_TRUST_MS = 0.48;
  /** Teleport bot cube to spawn if center escapes cage (goal pockets allowed on ±X). */
  var VL_BOT_ARENA_RECOVER_COOLDOWN_MS = 900;
  var VL_BOT_OUT_PAD_X = 0.52;
  var VL_BOT_OUT_PAD_Z = 0.38;
  var VL_BOT_OUT_PAD_Y_LOW = 0.42;
  var VL_BOT_OUT_PAD_Y_HIGH = 0.38;
  var VL_BOT_DIFFICULTY_UNBEATABLE = 3;

  function zeroInput() {
    return {
      lx: 0,
      ly: 0,
      rx: 0,
      ry: 0,
      trig: 0,
      trigRev: 0,
      autoRoll: 1,
      grip: 0,
      gripL: 0,
      gripR: 0,
      aEdge: 0,
      camOk: 0,
      camx: 0,
      camy: 0,
      camz: 0,
      lwx: 0,
      lwy: 0,
      lwz: 0,
      lqw: 1,
      lqx: 0,
      lqy: 0,
      lqz: 0,
      rwx: 0,
      rwy: 0,
      rwz: 0,
      rqw: 1,
      rqx: 0,
      rqy: 0,
      rqz: 0
    };
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  /**
   * Equirectangular map: 12 pentagon regions (icosahedron vertices) + 20 hex (face centroids).
   * Line-forward style: bright opaque edges where Voronoi cells meet; interior texels are alpha 0 (see-through).
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
    /* Larger = thicker seam lines on the equirectangular map (tune 0.028–0.045). */
    var seamDot = 0.038;
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
        var ck;
        for (ck = 0; ck < centers.length; ck++) {
          var c = centers[ck];
          var dot = sx * c.x + sy * c.y + sz * c.z;
          if (dot > best) {
            second = best;
            best = dot;
          } else if (dot > second) {
            second = dot;
          }
        }

        var off = (cj * w + ci) * 4;
        var seam = best - second < seamDot;
        if (seam) {
          /* Panel boundary (pent/hex Voronoi edges) — opaque so lines stay visible. */
          d[off] = 218;
          d[off + 1] = 224;
          d[off + 2] = 236;
          d[off + 3] = 255;
        } else {
          /* Transparent “body”: only seam lines occlude; map alpha drives blending on the material. */
          d[off] = 0;
          d[off + 1] = 0;
          d[off + 2] = 0;
          d[off + 3] = 0;
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
      /** Client: A-button cube-reset edge is one frame; input is sent at INPUT_HZ — latch until included in a packet. */
      this._vlPendingAEdge = 0;
      /** Local: cockpit view — scene-root `vr-rig` follows the car mesh each tick; camera eye offset applied on toggle only. */
      this._vlFpvActive = false;
      this._vlFpvLookControlsWereDisabled = false;
      this._vlPrevBKey = false;
      /** Debounce FPV toggle when both `bbuttondown` and gamepad edge fire same physical press (RTSVR2-style + raw pad). */
      this._vlLastFpvToggleMs = 0;
      /** XR right gamepad B — on Quest, index 4 is often the A (primary) button in raw WebXR; use only [5] for B here. */
      this._vlPrevBGamepadXR = false;
      this._vlRightBHandlersBound = false;
      this._vlRightHandBHook = null;
      this._vlOnBbuttondown = null;
      this._vlExitVrFpv = null;
      this._vlFpvHeadOffset = new THREE.Vector3();
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

      /** Per-slot: grab + throw (host sim). rel* = inv(q_hand_grab)*q_cube_grab so q_cube = q_hand * rel each frame. */
      this._vlGrabState = [];
      for (var gsi = 0; gsi < 4; gsi++) {
        this._vlGrabState.push({
          active: false,
          hand: 'R',
          handPrevX: 0,
          handPrevY: 0,
          handPrevZ: 0,
          handPrevQw: 1,
          handPrevQx: 0,
          handPrevQy: 0,
          handPrevQz: 0,
          relQw: 1,
          relQx: 0,
          relQy: 0,
          relQz: 0,
          lvx: 0,
          lvy: 0,
          lvz: 0,
          avx: 0,
          avy: 0,
          avz: 0,
          prevT: 0
        });
      }
      this._vlNoGrabUntil = [0, 0, 0, 0];
      this._vlCdHapticNext = [0, 0, 0, 0];
      this._vlSlotReset = [
        { phase: 'idle', t0: 0, grabHand: null },
        { phase: 'idle', t0: 0, grabHand: null },
        { phase: 'idle', t0: 0, grabHand: null },
        { phase: 'idle', t0: 0, grabHand: null }
      ];
      this._vlHostLedCd = [-1, -1, -1, -1];
      this._vlLedMode = [0, 0, 0, 0];
      this.carVisScale = [1, 1, 1, 1];
      this._vlPrevA = false;
      this._vlPrevRkey = false;
      this._vlRightAPressEdge = false;
      this._vlRightAHandlersBound = false;
      this._vlOnAbuttondown = null;
      this._vlOnAbuttonup = null;
      this._vlResetHintEl = null;
      this._vlXMenuHintEl = null;
      this._vlBotState = [
        { driftUntil: 0, smx: null, smz: null },
        { driftUntil: 0, smx: null, smz: null },
        { driftUntil: 0, smx: null, smz: null },
        { driftUntil: 0, smx: null, smz: null }
      ];
      this._vlBotArenaRecoverAt = [0, 0, 0, 0];
      this._vlGoalHapticTimer = null;
      this._vlThrowClampUntil = [0, 0, 0, 0];
      this._tmpQHand = new AFRAME.THREE.Quaternion();
      this._tmpQPrev = new AFRAME.THREE.Quaternion();
      this._tmpQDelta = new AFRAME.THREE.Quaternion();
      this._tmpQInv = new AFRAME.THREE.Quaternion();
      this._tmpVecHand = new THREE.Vector3();
      this._tmpVecThrow = new AFRAME.THREE.Vector3();
      this._tmpVecAng = new AFRAME.THREE.Vector3();
      this._vlGatherLp = new AFRAME.THREE.Vector3();
      this._vlGatherRp = new AFRAME.THREE.Vector3();
      this._vlGatherLq = new AFRAME.THREE.Quaternion();
      this._vlGatherRq = new AFRAME.THREE.Quaternion();

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
            if (!self._vlFpvActive) self._applySpectatorTransform(self.mySlot);
          });
        });
      };
      var sceneEl = this.el.sceneEl || this.el;
      sceneEl.addEventListener('enter-vr', this._vlReseatSpectator);
      this._vlEnterVrStartBgm = function vlEnterVrStartBgm() {
        self._vlTryStartBackgroundMusic();
      };
      sceneEl.addEventListener('enter-vr', this._vlEnterVrStartBgm);
      this._vlEnterVrBindA = function () {
        self._vlBindRightAButton();
        self._vlBindRightBButton();
      };
      sceneEl.addEventListener('enter-vr', this._vlEnterVrBindA);
      this._vlExitVrFpv = function () {
        self._vlExitFpvIfActive();
        self._vlPrevBGamepadXR = false;
      };
      sceneEl.addEventListener('exit-vr', this._vlExitVrFpv);
      function bindVlXrSessionReseat() {
        var xr = sceneEl.renderer && sceneEl.renderer.xr;
        if (xr && !self._vlXrSessionBound) {
          self._vlXrSessionBound = true;
          xr.addEventListener('sessionstart', self._vlReseatSpectator);
        }
      }
      if (sceneEl.hasLoaded) {
        bindVlXrSessionReseat();
        self._vlBindRightAButton();
        self._vlBindRightBButton();
      } else {
        sceneEl.addEventListener('loaded', function vlOnSceneLoaded() {
          sceneEl.removeEventListener('loaded', vlOnSceneLoaded);
          bindVlXrSessionReseat();
          self._vlBindRightAButton();
          self._vlBindRightBButton();
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
        transparent: true,
        opacity: 1,
        depthWrite: false,
        roughness: 0.35,
        metalness: 0.04,
        emissive: new THREE.Color(0x000000),
        emissiveIntensity: 0,
        side: THREE.DoubleSide
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

    /** Start lobby BGM on first immersive session if Music wasn’t turned off (same path as menu toggle). */
    _vlTryStartBackgroundMusic: function () {
      if (window._musicEnabled === false) return;
      this._resumeAudioIfNeeded();
      var sceneEl = this.el.sceneEl || this.el;
      var sm = sceneEl.components && sceneEl.components['sound-manager'];
      var bgm = document.querySelector('#bg-music');
      if (!bgm || !bgm.components || !bgm.components.sound) return;
      var sc = bgm.components.sound;
      var playing = false;
      try {
        if (sc.pool && sc.pool.children) {
          var ii;
          for (ii = 0; ii < sc.pool.children.length; ii++) {
            if (sc.pool.children[ii].isPlaying) {
              playing = true;
              break;
            }
          }
        }
      } catch (eP) {}
      if (playing) return;
      if (sm) {
        sm._setVolume(bgm, 0);
        sc.playSound();
        sm._fadeSound(bgm, 0, sm.bgMusicVolume, 900);
      } else {
        sc.playSound();
      }
      window._musicEnabled = true;
      window._bgMusicStarted = true;
      var btn = document.getElementById('menu-music-toggle');
      if (btn) {
        var vmc = btn.components && btn.components['menu-click'];
        if (vmc && typeof vmc.setColor === 'function') {
          vmc.setColor('#44aa44');
        } else {
          btn.setAttribute('material', 'color', '#44aa44');
        }
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
      el.object3D.updateMatrixWorld(true);
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

    /**
     * One-shot sonar at a cube (slot 0–3); each slot has its own entity so two cubes can overlap.
     * @param {number} slot
     * @param {number} playbackRate 1 = tongue, lower = bump emote
     */
    _playLedSonarSlot: function (slot, playbackRate) {
      if (typeof slot !== 'number' || slot < 0 || slot > 3) return;
      this._resumeAudioIfNeeded();
      var el = document.getElementById('vl-led-sonar-' + slot);
      if (!el) return;
      var sc = el.components && el.components.sound;
      if (!sc) return;
      var body = this.carBodies && this.carBodies[slot];
      if (body) {
        el.object3D.position.set(body.position.x, body.position.y, body.position.z);
        el.object3D.updateMatrixWorld(true);
      }
      var rate = typeof playbackRate === 'number' && isFinite(playbackRate) ? playbackRate : 1;
      rate = Math.max(0.35, Math.min(2.2, rate));
      /* Tongue (rate ~1) louder; bump emote (lower rate) a bit quieter so it doesn’t overpower. */
      var vol = rate >= 0.92 ? 0.98 : 0.62;
      try {
        if (sc.pool && sc.pool.children) {
          var pi;
          for (pi = 0; pi < sc.pool.children.length; pi++) {
            var aud = sc.pool.children[pi];
            if (aud && aud.setPlaybackRate) aud.setPlaybackRate(rate);
            if (aud && aud.setVolume) aud.setVolume(vol);
          }
        }
      } catch (eS) {}
      sc.stopSound();
      sc.playSound();
    },

    /**
     * Goal / score: global stinger (`vl-goal-sound`) + spatial hit at the goal mouth (`vl-goal-impact-sound`).
     * @param {number} [ix] world X at goal (omit on clients if host sent no coords)
     * @param {number} [iy]
     * @param {number} [iz]
     */
    _playGoalFxWorld: function (ix, iy, iz) {
      this._resumeAudioIfNeeded();
      this._vlStartGoalHapticBurst();
      var st = document.getElementById('vl-goal-sound');
      if (st) {
        var sc0 = st.components && st.components.sound;
        if (sc0) {
          sc0.stopSound();
          sc0.playSound();
        }
      }
      if (
        typeof ix !== 'number' ||
        typeof iy !== 'number' ||
        typeof iz !== 'number' ||
        !isFinite(ix) ||
        !isFinite(iy) ||
        !isFinite(iz)
      ) {
        return;
      }
      var im = document.getElementById('vl-goal-impact-sound');
      if (!im) return;
      var sc1 = im.components && im.components.sound;
      if (!sc1) return;
      im.object3D.position.set(ix, iy, iz);
      im.object3D.updateMatrixWorld(true);
      sc1.stopSound();
      sc1.playSound();
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

    _vlStopGoalHapticBurst: function () {
      if (this._vlGoalHapticTimer != null) {
        clearInterval(this._vlGoalHapticTimer);
        this._vlGoalHapticTimer = null;
      }
    },

    /** Both controllers ~2s (runtime caps single pulses — re-pulse on an interval). */
    _vlStartGoalHapticBurst: function () {
      var self = this;
      this._vlStopGoalHapticBurst();
      var start = performance.now();
      var repulse = function () {
        self._pulseBothHands(0.78, 95);
      };
      repulse();
      this._vlGoalHapticTimer = setInterval(function () {
        if (performance.now() - start >= 2000) {
          self._vlStopGoalHapticBurst();
          return;
        }
        repulse();
      }, 100);
    },

    _vlGrabGripOk: function (inp, hand) {
      if (!inp) return false;
      if (hand === 'L') return (inp.gripL || 0) > 0.42;
      return (inp.gripR || 0) > 0.42;
    },

    _vlReadHandFromInput: function (inp, hand, outPos, outQuat) {
      if (!inp) return false;
      if (hand === 'L') {
        outPos.set(inp.lwx || 0, inp.lwy || 0, inp.lwz || 0);
        outQuat.set(inp.lqx || 0, inp.lqy || 0, inp.lqz || 0, inp.lqw != null ? inp.lqw : 1);
        return true;
      }
      outPos.set(inp.rwx || 0, inp.rwy || 0, inp.rwz || 0);
      outQuat.set(inp.rqx || 0, inp.rqy || 0, inp.rqz || 0, inp.rqw != null ? inp.rqw : 1);
      return true;
    },

    _vlReleaseGrabSlot: function (slot, now, skipThrow) {
      var G = this._vlGrabState[slot];
      var body = this.carBodies[slot];
      if (!G || !G.active || !body) {
        if (G) G.active = false;
        return;
      }
      G.active = false;
      if (skipThrow) {
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        return;
      }
      /* Use last tracked hand linear / angular velocity from sustain (body.pos matched hand each frame, so pos-delta was always ~0). */
      this._tmpVecThrow.set(G.lvx || 0, G.lvy || 0, G.lvz || 0);
      var sp = this._tmpVecThrow.length();
      if (sp < 0.04) {
        this._tmpVecThrow.set(0, 0, 0);
      } else if (sp > VL_THROW_LIN_CAP) {
        this._tmpVecThrow.multiplyScalar(VL_THROW_LIN_CAP / sp);
      }
      body.velocity.copy(this._tmpVecThrow);
      body.angularVelocity.set(G.avx || 0, G.avy || 0, G.avz || 0);
      var inp = this.inputs[slot];
      if (inp) {
        body.angularVelocity.x += (inp.rx || 0) * 4.2;
        body.angularVelocity.y += (inp.lx || 0) * 4.2;
        body.angularVelocity.z += (inp.ry || 0) * 4.2;
      }
      var wm = body.angularVelocity.length();
      if (wm > VL_THROW_ANG_CAP) {
        var k = VL_THROW_ANG_CAP / wm;
        body.angularVelocity.x *= k;
        body.angularVelocity.y *= k;
        body.angularVelocity.z *= k;
      }
      if (typeof body.wakeUp === 'function') body.wakeUp();
      this._vlThrowClampUntil[slot] = now + 220;
    },

    _vlTryStartCubeReset: function (slot) {
      if (!this.isHost || typeof slot !== 'number' || slot < 0 || slot > 3) return;
      var R = this._vlSlotReset[slot];
      if (!R || R.phase !== 'idle') return;
      var now = performance.now();
      R.phase = 'cd';
      R.t0 = now;
      this._vlCdHapticNext[slot] = now;
    },

    _vlTickCubeResets: function (now) {
      var si;
      for (si = 0; si < 4; si++) {
        this._vlTickOneCubeReset(si, now);
      }
    },

    _vlTickOneCubeReset: function (slot, now) {
      var R = this._vlSlotReset[slot];
      var body = this.carBodies[slot];
      var spawn = this._carSpawn && this._carSpawn[slot];
      if (!R || !body || !spawn) return;
      var elapsed;
      var t;
      var sc;
      var G = this._vlGrabState[slot];
      if (R.phase === 'idle') {
        this._vlHostLedCd[slot] = -1;
        this.carVisScale[slot] = 1;
        return;
      }
      if (R.phase === 'cd') {
        elapsed = (now - R.t0) / 1000;
        if (elapsed >= VL_CUBE_RESET_CD_SEC) {
          this._vlHostLedCd[slot] = 0;
          if (G && G.active) {
            var hel = G.hand === 'L' ? vlHandEl('leftHand', 'vl-hand-left') : vlHandEl('rightHand', 'vl-hand-right');
            this._pulseHand(hel, 1, 120);
            this._vlReleaseGrabSlot(slot, now, true);
          }
          R.phase = 'out';
          R.t0 = now;
        } else {
          this._vlHostLedCd[slot] = 5 - Math.floor(elapsed);
        }
        if (G && G.active && now >= this._vlCdHapticNext[slot]) {
          this._vlCdHapticNext[slot] = now + 200;
          var h2 = G.hand === 'L' ? vlHandEl('leftHand', 'vl-hand-left') : vlHandEl('rightHand', 'vl-hand-right');
          this._pulseHand(h2, 0.55, 40);
        }
        return;
      }
      if (R.phase === 'out') {
        body.velocity.set(0, 0, 0);
        var tLed = (now - R.t0) / 1000;
        if (tLed < 0.12) this._vlHostLedCd[slot] = 0;
        else this._vlHostLedCd[slot] = 100;
        t = (now - R.t0) / VL_RESET_OUT_MS;
        if (t < 0.5) {
          sc = 1 + vlEaseOutBack(t * 2);
          if (sc > 2) sc = 2;
          this.carVisScale[slot] = sc;
        } else if (t < 1) {
          sc = 2 * (1 - vlEaseInQuad((t - 0.5) * 2));
          this.carVisScale[slot] = sc;
        } else {
          this.carVisScale[slot] = 0;
          body.velocity.set(0, 0, 0);
          body.angularVelocity.set(0, 0, 0);
          body.position.set(spawn.x, spawn.y, spawn.z);
          body.quaternion.set(spawn.qx, spawn.qy, spawn.qz, spawn.qw);
          if (typeof body.wakeUp === 'function') body.wakeUp();
          R.phase = 'in1';
          R.t0 = now;
        }
        return;
      }
      if (R.phase === 'in1') {
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        t = (now - R.t0) / (VL_RESET_IN_MS * 0.5);
        if (t < 1) {
          sc = 2 * vlEaseOutBack(t);
          if (sc > 2) sc = 2;
          this.carVisScale[slot] = sc;
        } else {
          this.carVisScale[slot] = 2;
          R.phase = 'in2';
          R.t0 = now;
        }
        return;
      }
      if (R.phase === 'in2') {
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        t = (now - R.t0) / (VL_RESET_IN_MS * 0.5);
        if (t < 1) {
          this.carVisScale[slot] = 2 - vlEaseOutQuad(t);
        } else {
          this.carVisScale[slot] = 1;
          R.phase = 'idle';
          this._vlHostLedCd[slot] = -1;
          this._vlNoGrabUntil[slot] = now + 50;
          var L = this._vlCarLed[slot];
          if (L) {
            L.hitFaceUntil = 0;
            L.tongueUntil = 0;
            L.nearLatch = false;
            L.lastDrawnMode = 'neutral';
            vlDrawLedFace(L.ctx, L.canvasW, L.canvasH, 'neutral', L.ledBodyColor);
            L.texture.needsUpdate = true;
          }
        }
      }
    },

    _vlApplyGrabForSlot: function (slot, inp, now) {
      var body = this.carBodies[slot];
      if (!body || !inp) return;
      var R = this._vlSlotReset[slot];
      var G = this._vlGrabState[slot];
      var lp = this._vlGatherLp;
      var rp = this._vlGatherRp;
      var lq = this._vlGatherLq;
      var rq = this._vlGatherRq;
      var distL = 1e9;
      var distR = 1e9;
      var cx = body.position.x;
      var cy = body.position.y;
      var cz = body.position.z;
      if (this._vlReadHandFromInput(inp, 'L', lp, lq)) {
        distL = Math.sqrt((lp.x - cx) * (lp.x - cx) + (lp.y - cy) * (lp.y - cy) + (lp.z - cz) * (lp.z - cz));
      }
      if (this._vlReadHandFromInput(inp, 'R', rp, rq)) {
        distR = Math.sqrt((rp.x - cx) * (rp.x - cx) + (rp.y - cy) * (rp.y - cy) + (rp.z - cz) * (rp.z - cz));
      }
      var canNew = R.phase === 'idle' && now >= this._vlNoGrabUntil[slot];
      if (G.active) {
        var sustain = R.phase === 'idle' || R.phase === 'cd';
        var ok = sustain && this._vlGrabGripOk(inp, G.hand);
        if (!ok) {
          this._vlReleaseGrabSlot(slot, now, false);
          return;
        }
        var hp = G.hand === 'L' ? lp : rp;
        var hq = G.hand === 'L' ? lq : rq;
        var dt = Math.max(1 / 200, Math.min(0.05, now - G.prevT));
        G.lvx = (hp.x - G.handPrevX) / dt;
        G.lvy = (hp.y - G.handPrevY) / dt;
        G.lvz = (hp.z - G.handPrevZ) / dt;
        this._tmpQHand.set(hq.x, hq.y, hq.z, hq.w);
        this._tmpQPrev.set(G.handPrevQx, G.handPrevQy, G.handPrevQz, G.handPrevQw);
        if (typeof this._tmpQPrev.invert === 'function') {
          this._tmpQInv.copy(this._tmpQPrev).invert();
        } else {
          this._tmpQInv.copy(this._tmpQPrev).inverse();
        }
        this._tmpQDelta.copy(this._tmpQHand).multiply(this._tmpQInv);
        var hang = 2 * Math.acos(clamp(this._tmpQDelta.w, -1, 1));
        this._tmpVecAng.set(this._tmpQDelta.x, this._tmpQDelta.y, this._tmpQDelta.z);
        if (this._tmpVecAng.lengthSq() > 1e-14 && hang > 1e-5) {
          this._tmpVecAng.normalize();
          this._tmpVecAng.multiplyScalar(hang / dt);
          G.avx = this._tmpVecAng.x;
          G.avy = this._tmpVecAng.y;
          G.avz = this._tmpVecAng.z;
        } else {
          G.avx = 0;
          G.avy = 0;
          G.avz = 0;
        }
        body.velocity.set(G.lvx, G.lvy, G.lvz);
        body.position.set(hp.x, hp.y, hp.z);
        body.angularVelocity.set(0, 0, 0);
        this._tmpQPrev.set(G.relQx, G.relQy, G.relQz, G.relQw);
        this._tmpQDelta.copy(this._tmpQHand).multiply(this._tmpQPrev);
        body.quaternion.set(this._tmpQDelta.x, this._tmpQDelta.y, this._tmpQDelta.z, this._tmpQDelta.w);
        G.handPrevX = hp.x;
        G.handPrevY = hp.y;
        G.handPrevZ = hp.z;
        G.handPrevQw = hq.w;
        G.handPrevQx = hq.x;
        G.handPrevQy = hq.y;
        G.handPrevQz = hq.z;
        G.prevT = now;
        return;
      }
      if (!canNew) return;
      if ((inp.gripR || 0) < 0.82 && (inp.gripL || 0) < 0.82) return;
      var pickR = (inp.gripR || 0) > 0.82 && distR < VL_GRAB_REACH;
      var pickL = (inp.gripL || 0) > 0.82 && distL < VL_GRAB_REACH;
      if (!pickL && !pickR) return;
      var hand = pickR && (!pickL || distR <= distL) ? 'R' : 'L';
      if (!pickR && pickL) hand = 'L';
      G.active = true;
      G.hand = hand;
      G.prevT = now;
      var hpx = hand === 'L' ? lp.x : rp.x;
      var hpy = hand === 'L' ? lp.y : rp.y;
      var hpz = hand === 'L' ? lp.z : rp.z;
      var hq2 = hand === 'L' ? lq : rq;
      G.handPrevX = hpx;
      G.handPrevY = hpy;
      G.handPrevZ = hpz;
      G.handPrevQw = hq2.w;
      G.handPrevQx = hq2.x;
      G.handPrevQy = hq2.y;
      G.handPrevQz = hq2.z;
      G.lvx = 0;
      G.lvy = 0;
      G.lvz = 0;
      G.avx = 0;
      G.avy = 0;
      G.avz = 0;
      this._tmpQHand.set(hq2.x, hq2.y, hq2.z, hq2.w);
      if (typeof this._tmpQHand.invert === 'function') {
        this._tmpQInv.copy(this._tmpQHand).invert();
      } else {
        this._tmpQInv.copy(this._tmpQHand).inverse();
      }
      this._tmpQPrev.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      this._tmpQDelta.copy(this._tmpQInv).multiply(this._tmpQPrev);
      G.relQx = this._tmpQDelta.x;
      G.relQy = this._tmpQDelta.y;
      G.relQz = this._tmpQDelta.z;
      G.relQw = this._tmpQDelta.w;
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      var hel = hand === 'L' ? vlHandEl('leftHand', 'vl-hand-left') : vlHandEl('rightHand', 'vl-hand-right');
      this._pulseHand(hel, 0.45, 55);
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
      /* Car–car fires twice; play bump sonar only on the first callback (sync false) so we don’t double. */
      var playBumpSonar = slots.length === 1 ? true : !syncAudioAndNet;
      for (si = 0; si < slots.length; si++) {
        s = slots[si];
        if (typeof s !== 'number' || s < 0 || s > 3) continue;
        L = this._vlCarLed[s];
        if (!L) continue;
        L.hitFaceUntil = now + VL_HIT_FACE_MS;
        if (playBumpSonar) this._playLedSonarSlot(s, VL_LED_SONAR_BUMP_RATE);
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
      var el = document.getElementById('vl-thruster-sound');
      if (!el || !el.components || !el.components.sound) return;
      var sc = el.components.sound;
      var on = inp && (inp.trig > 0.04 || (inp.trigRev || 0) > 0.04);
      var slot = this.mySlot;
      if (on) {
        this._resumeAudioIfNeeded();
        if (
          typeof slot === 'number' &&
          slot >= 0 &&
          slot < 4 &&
          this.carBodies &&
          this.carBodies[slot]
        ) {
          var bp = this.carBodies[slot].position;
          el.object3D.position.set(bp.x, bp.y, bp.z);
          el.object3D.updateMatrixWorld(true);
        }
        if (!this._vlThrusterPlaying) {
          this._vlThrusterPlaying = true;
          sc.playSound();
        }
      } else {
        if (this._vlThrusterPlaying) {
          this._vlThrusterPlaying = false;
          sc.stopSound();
        }
      }
    },

    _applySpectatorTransform: function (slot) {
      if (!this._rig) return;
      if (this._vlFpvActive) return;
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

    _vlHandWorld: function (handEl, outPos, outQuat) {
      if (!handEl || !handEl.object3D) return false;
      handEl.object3D.updateMatrixWorld(true);
      handEl.object3D.getWorldPosition(outPos);
      handEl.object3D.getWorldQuaternion(outQuat);
      return true;
    },

    /** Quest “A” is unreliable via raw `gamepad.buttons` across runtimes; A-Frame emits `abuttondown` on the right hand entity. */
    _vlUpdateResetHintVisibility: function () {
      var scn = this.el.sceneEl || this.el;
      var xrOn = !!(scn && scn.renderer && scn.renderer.xr && scn.renderer.xr.isPresenting);
      var vm = scn && scn.components && scn.components['vr-menu'];
      var menuOn = !!(vm && vm.menuVisible);
      var v = xrOn && !menuOn;
      var el = this._vlResetHintEl;
      if (!el) {
        el = document.getElementById('vl-reset-hint');
        this._vlResetHintEl = el || null;
      }
      if (el) el.setAttribute('visible', v);
      var xh = this._vlXMenuHintEl;
      if (!xh) {
        xh = document.getElementById('vl-x-menu-hint');
        this._vlXMenuHintEl = xh || null;
      }
      if (xh) xh.setAttribute('visible', v);
    },

    _vlBindRightAButton: function () {
      var self = this;
      if (this._vlRightAHandlersBound) return;
      var rh = vlHandEl('rightHand', 'vl-hand-right');
      if (!rh) return;
      this._vlRightAHandlersBound = true;
      this._vlRightHandAHook = rh;
      this._vlOnAbuttondown = function () {
        self._vlRightAPressEdge = true;
      };
      this._vlOnAbuttonup = function () {
        self._vlPrevA = false;
      };
      rh.addEventListener('abuttondown', this._vlOnAbuttondown);
      rh.addEventListener('abuttonup', this._vlOnAbuttonup);
    },

    /**
     * RTSVR2-style: `bbuttondown` on `#rightHand` only. Do not use generic `buttondown` with id 4 — on Quest/WebXR
     * that index is often the A (primary) button, so it was toggling FPV together with cube reset.
     * Raw gamepad B uses only `buttons[5]` in _gatherLocalInput (see comment there).
     */
    /** Pause A-Frame `position` / `rotation` so they do not overwrite `object3D` each tick (FPV jitter / camera Y). */
    _vlFpvPauseTransformComponents: function (el) {
      if (!el || typeof el.pauseComponent !== 'function') return;
      try {
        el.pauseComponent('position');
        el.pauseComponent('rotation');
      } catch (eP) {}
    },

    _vlFpvPlayTransformComponents: function (el) {
      if (!el || typeof el.playComponent !== 'function') return;
      try {
        el.playComponent('position');
        el.playComponent('rotation');
      } catch (ePl) {}
    },

    _vlBindRightBButton: function () {
      if (!VL_FPV_ENABLED) return;
      var self = this;
      if (this._vlRightBHandlersBound) return;
      var rh = vlHandEl('rightHand', 'vl-hand-right');
      if (!rh) return;
      this._vlRightBHandlersBound = true;
      this._vlRightHandBHook = rh;
      this._vlOnBbuttondown = function () {
        self._vlTryToggleFpv();
      };
      rh.addEventListener('bbuttondown', this._vlOnBbuttondown);
    },

    /**
     * Cockpit vs standing eye height on `#cam`. Do **not** call every frame in WebXR — resetting `rotation` here
     * would wipe head tracking. In immersive WebXR, Three’s `WebXRManager.updateUserCamera` writes `#cam`’s local
     * matrix from the viewer pose and **parent** `matrixWorld`; that requires `matrixAutoUpdate: false` on the
     * camera (same as look-controls `onEnterVR`). Leaving it `true` lets A-Frame rebuild the matrix from attrs and
     * fight WebXR → unstable stereo / drift / “FPV never works”.
     */
    _vlApplyFpvEyePose: function (cockpit) {
      var cam = document.getElementById('cam');
      if (!cam || !cam.object3D) return;
      var scene = cam.sceneEl || this.el.sceneEl || this.el;
      var hmd =
        scene &&
        typeof scene.checkHeadsetConnected === 'function' &&
        scene.checkHeadsetConnected() &&
        (scene.is('vr-mode') || scene.is('ar-mode'));
      var webxr = !!(hmd && scene.hasWebXR);

      if (cockpit) {
        cam.object3D.position.set(0, 0, 0);
      } else {
        cam.object3D.position.set(0, 1.55, 0);
      }
      cam.object3D.rotation.set(0, 0, 0);
      cam.object3D.quaternion.identity();
      cam.object3D.scale.set(1, 1, 1);
      cam.object3D.updateMatrix();

      /* FPV + WebXR: Keep matrixAutoUpdate to TRUE. This allows Three.js's XR manager
       * to manage eye synchronization properly, avoiding "seeing double." 
       * We rely on pausing the 'position'/'rotation' components to stop A-Frame 
       * attributes from overwriting our manual object3D state. */
      cam.object3D.matrixAutoUpdate = true;
      if (!webxr) {
        cam.setAttribute(
          'position',
          cockpit ? { x: 0, y: 0, z: 0 } : { x: 0, y: 1.55, z: 0 }
        );
        cam.setAttribute('rotation', { x: 0, y: 0, z: 0 });
      }

      var lc = cam.components && cam.components['look-controls'];
      if (lc && lc.pitchObject && lc.yawObject) {
        lc.pitchObject.rotation.set(0, 0, 0);
        lc.yawObject.rotation.set(0, 0, 0);
      }
      cam.object3D.updateMatrixWorld(true);
    },

    _vlSyncYawGroupIdentity: function (yawEl) {
      if (!yawEl || !yawEl.object3D) return;
      yawEl.object3D.matrixAutoUpdate = true;
      yawEl.object3D.position.set(0, 0, 0);
      yawEl.object3D.rotation.set(0, 0, 0);
      yawEl.object3D.quaternion.identity();
      yawEl.object3D.scale.set(1, 1, 1);
      yawEl.object3D.updateMatrix();
      yawEl.setAttribute('position', { x: 0, y: 0, z: 0 });
      yawEl.setAttribute('rotation', { x: 0, y: 0, z: 0 });
    },

    _vlExitFpvIfActive: function () {
      if (!this._vlFpvActive) return;
      this._vlFpvActive = false;
      var cam = document.getElementById('cam');
      if (cam && cam.setAttribute && this._vlFpvLookControlsWereDisabled) {
        cam.setAttribute('look-controls', 'enabled: true; pointerLockEnabled: false');
      }
      this._vlFpvLookControlsWereDisabled = false;
      var yawEl = this._rigYaw;
      var self = this;
      var slot = this.mySlot;
      function applyOut() {
        var rigE = self._rig;
        var camE = document.getElementById('cam');
        if (rigE) self._vlFpvPlayTransformComponents(rigE);
        if (camE) self._vlFpvPlayTransformComponents(camE);
        if (yawEl) self._vlFpvPlayTransformComponents(yawEl);
        self._vlSyncYawGroupIdentity(yawEl);
        self._vlApplyFpvEyePose(false);
        if (self._rig && self._rig.object3D) {
          self._rig.object3D.matrixAutoUpdate = true;
        }
        if (typeof slot === 'number') self._applySpectatorTransform(slot);
      }
      applyOut();
      if (typeof window !== 'undefined' && window.requestAnimationFrame) {
        window.requestAnimationFrame(function () {
          window.requestAnimationFrame(applyOut);
        });
      }
    },

    /**
     * FPV: keep `#vr-rig` under the scene (WebXR expects a stable rig chain). Each frame copy the **visual**
     * car mesh world pose so the rig matches what you see; apply π yaw in body space so camera −Z aligns
     * with cube +Z (thrust). Do not call `_vlApplyFpvEyePose` here — resetting camera rotation every tick
     * would destroy head tracking.
     */
    _vlTickFpvRigFollowCarMesh: function () {
      if (!this._vlFpvActive || !this._rig || !this.carEls) return;
      var slot = this.mySlot;
      var carEl = this.carEls[slot];
      if (!carEl || !carEl.object3D) return;
      var rig = this._rig;
      var yawEl = this._rigYaw;
      var o = rig.object3D;
      var cam = document.getElementById('cam');

      carEl.object3D.updateMatrixWorld(true);
      carEl.object3D.getWorldPosition(this.tmpVec);
      carEl.object3D.getWorldQuaternion(this._tmpQHand);

      /* Flip yaw so camera −Z coincides with car +Z. */
      this._tmpQDelta.setFromAxisAngle(this.tmpVec2.set(0, 1, 0), Math.PI);
      this._tmpQHand.multiply(this._tmpQDelta);

      /* Fix Jitter / Feedback Loop: Use STATIC Head Offset captured at toggle start.
       * If we subtracted cam.object3D.position every frame, we would create a jittery 
       * feedback loop between tracked head position and rig movement. */
      if (this._vlFpvHeadOffset) {
        this.tmpVec2.copy(this._vlFpvHeadOffset);
        this.tmpVec2.applyQuaternion(this._tmpQHand);
        this.tmpVec.sub(this.tmpVec2);
      }

      var parent = o.parent;
      if (parent) {
        parent.updateMatrixWorld(true);
        parent.worldToLocal(this.tmpVec);
      }

      o.position.copy(this.tmpVec);
      o.quaternion.copy(this._tmpQHand);
      o.scale.set(1, 1, 1);
      o.updateMatrix();
      
      if (yawEl && yawEl.object3D) {
        yawEl.object3D.rotation.set(0, 0, 0);
        yawEl.object3D.quaternion.identity();
        yawEl.object3D.updateMatrix();
      }
      
      /* Essential update order for WebXR eye poses. */
      o.updateMatrixWorld(true);
      if (cam && cam.object3D) {
        cam.object3D.updateMatrixWorld(true);
      }
    },

    /** Toggle first-person view: scene-root rig follows car mesh; cockpit eye offset applied once. */
    _vlTryToggleFpv: function () {
      if (!VL_FPV_ENABLED) return;
      var scn = this.el.sceneEl || this.el;
      var vm = scn.components && scn.components['vr-menu'];
      if (vm && vm.menuVisible) return;
      var nowMs = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      if (nowMs - (this._vlLastFpvToggleMs || 0) < 220) return;
      this._vlLastFpvToggleMs = nowMs;
      if (this._vlFpvActive) {
        this._vlExitFpvIfActive();
        return;
      }
      var body = this.carBodies && this.carBodies[this.mySlot];
      var cam = document.getElementById('cam');
      var rig = this._rig;
      var yawEl = this._rigYaw;
      if (!body || !cam || !rig) return;
      this._vlFpvActive = true;
      var xrOn = !!(scn && scn.renderer && scn.renderer.xr && scn.renderer.xr.isPresenting);
      this._vlFpvLookControlsWereDisabled = xrOn;
      if (xrOn && cam.setAttribute) {
        cam.setAttribute('look-controls', 'enabled: false; pointerLockEnabled: false');
      }
      /* Stop `position` / `rotation` components from fighting `object3D` (floating camera + rig judder). */
      this._vlFpvPauseTransformComponents(rig);
      if (xrOn) {
        this._vlFpvPauseTransformComponents(cam);
      }
      this._vlSyncYawGroupIdentity(yawEl);
      if (yawEl) {
        this._vlFpvPauseTransformComponents(yawEl);
      }
      /* Capture initial head position for static offset (prevents jitter feedback loop). */
      if (cam && cam.object3D) {
        this._vlFpvHeadOffset = this._vlFpvHeadOffset || new THREE.Vector3();
        this._vlFpvHeadOffset.copy(cam.object3D.position);
      }
      this._vlApplyFpvEyePose(true);
      this._vlTickFpvRigFollowCarMesh();
      var self = this;
      function applyIn() {
        /* Yaw/rig/cam transform components stay paused — do not setAttribute here (would not apply). */
        self._vlApplyFpvEyePose(true);
        self._vlTickFpvRigFollowCarMesh();
      }
      if (typeof window !== 'undefined' && window.requestAnimationFrame) {
        window.requestAnimationFrame(function () {
          window.requestAnimationFrame(applyIn);
        });
      }
    },

    _vlFakeDesktopHand: function (scene, outPos, outQuat) {
      outQuat.set(0, 0, 0, 1);
      if (!vlGetCameraWorldPosition(scene, outPos)) return false;
      var camEl = document.getElementById('cam') || scene.querySelector('[camera]');
      if (!camEl || !camEl.object3D) return true;
      camEl.object3D.getWorldQuaternion(this._tmpQHand);
      outQuat.copy(this._tmpQHand);
      this._tmpVecHand.set(0, 0, -0.38);
      this._tmpVecHand.applyQuaternion(this._tmpQHand);
      outPos.add(this._tmpVecHand);
      return true;
    },

    /**
     * Local input: HeliVR/main.js updateHeliPhysics lines 188–216 (keyboard + Quest XR), verbatim
     * mapping. Wire format: lx=yaw, rx=roll, ry=pitch, trig=right trigger forward, trigRev=left reverse.
     * Adds grip (squeeze), aEdge (Quest A / right primary), and hand world poses for grab sync.
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
      var lp = this._vlGatherLp;
      var rp = this._vlGatherRp;
      var lq = this._vlGatherLq;
      var rq = this._vlGatherRq;
      var gotL = false;
      var gotR = false;
      var gripL = 0;
      var gripR = 0;
      var aNow = false;
      var bNowXR = false;

      if (renderer && renderer.xr && renderer.xr.isPresenting) {
        var session = renderer.xr.getSession();
        if (session && session.inputSources) {
          for (var i = 0; i < session.inputSources.length; i++) {
            var source = session.inputSources[i];
            if (source.gamepad) {
              var axes = source.gamepad.axes;
              var buttons = source.gamepad.buttons;
              if (source.handedness === 'right') {
                roll += axes[2] || 0;
                pitch -= axes[3] || 0;
                if (buttons[0]) {
                  out.trig = Math.max(out.trig, buttons[0].pressed ? 1 : buttons[0].value || 0);
                }
                if (buttons[1]) gripR = Math.max(gripR, buttons[1].value || (buttons[1].pressed ? 1 : 0));
                /* A = primary face button only (index 3). Never scan index 5: on Quest/WebXR it is often B — that falsely set aNow → aEdge → cube reset. */
                var abA = buttons[3];
                if (abA) {
                  aNow = aNow || !!(abA.pressed || (abA.value || 0) > 0.35);
                }
                /* B: only index 5 — index 4 is the A/primary button on many Quest WebXR gamepad mappings. */
                var abB = buttons[5];
                if (abB) {
                  bNowXR = bNowXR || !!(abB.pressed || (abB.value || 0) > 0.35);
                }
              } else if (source.handedness === 'left') {
                yaw -= axes[2] || 0;
                if (buttons[0]) {
                  out.trigRev = Math.max(out.trigRev, (buttons[0].value || 0) * 0.95);
                }
                if (buttons[1]) gripL = Math.max(gripL, buttons[1].value || (buttons[1].pressed ? 1 : 0));
              }
            }
          }
          var bEdgeXR = bNowXR && !this._vlPrevBGamepadXR;
          this._vlPrevBGamepadXR = !!bNowXR;
          if (VL_FPV_ENABLED && bEdgeXR) {
            this._vlTryToggleFpv();
          }
        }
        var lh = vlHandEl('leftHand', 'vl-hand-left');
        var rh = vlHandEl('rightHand', 'vl-hand-right');
        gotL = this._vlHandWorld(lh, lp, lq);
        gotR = this._vlHandWorld(rh, rp, rq);
      } else {
        if (kb['KeyG']) gripR = 1;
        if (kb['KeyR']) {
          if (!this._vlPrevRkey) out.aEdge = 1;
          this._vlPrevRkey = true;
        } else {
          this._vlPrevRkey = false;
        }
        gotR = this._vlFakeDesktopHand(scn, rp, rq);
        gotL = false;
      }

      if (gotL) {
        out.lwx = lp.x;
        out.lwy = lp.y;
        out.lwz = lp.z;
        out.lqw = lq.w;
        out.lqx = lq.x;
        out.lqy = lq.y;
        out.lqz = lq.z;
      }
      if (gotR) {
        out.rwx = rp.x;
        out.rwy = rp.y;
        out.rwz = rp.z;
        out.rqw = rq.w;
        out.rqx = rq.x;
        out.rqy = rq.y;
        out.rqz = rq.z;
      }

      out.gripL = Math.max(gripL, kb['KeyG'] ? 1 : 0);
      out.gripR = Math.max(gripR, kb['KeyG'] ? 1 : 0);
      out.grip = Math.max(out.gripL, out.gripR);
      if (renderer && renderer.xr && renderer.xr.isPresenting) {
        if (this._vlRightAPressEdge) {
          out.aEdge = 1;
          this._vlRightAPressEdge = false;
          this._vlPrevA = true;
        } else {
          out.aEdge = aNow && !this._vlPrevA ? 1 : 0;
          this._vlPrevA = !!aNow;
        }
      } else {
        if (!out.aEdge) {
          out.aEdge = aNow && !this._vlPrevA ? 1 : 0;
        }
        this._vlPrevA = !!aNow;
      }

      out.lx = yaw;
      out.rx = roll;
      out.ry = pitch;
      if (kb['Space']) out.trig = Math.max(out.trig, 1);
      if (kb['KeyC']) out.trigRev = Math.max(out.trigRev, 1);
      out.lx = clamp(out.lx, -1, 1);
      out.ly = 0;
      out.rx = clamp(out.rx, -1, 1);
      out.ry = clamp(out.ry, -1, 1);
      out.trig = clamp(out.trig, 0, 1);
      out.trigRev = clamp(out.trigRev, 0, 1);
      if (vlGetCameraWorldPosition(scn, this.tmpVec)) {
        out.camOk = 1;
        out.camx = this.tmpVec.x;
        out.camy = this.tmpVec.y;
        out.camz = this.tmpVec.z;
      } else {
        out.camOk = 0;
      }
      out.autoRoll = window._vlAutoRollEnabled ? 1 : 0;
      return out;
    },

    _applyCarControls: function (slot, inp, noStickTorque) {
      var body = this.carBodies[slot];
      if (!body || !inp) return;
      var botSlot = this.isHost && !this._vlIsHumanOccupyingSlot(slot);
      var unbeatable = botSlot && !!window.vlBotUnbeatableMode;
      var tScale = unbeatable ? HELI_TORQUE_SCALE * 3.0 : (botSlot ? HELI_TORQUE_SCALE * VL_BOT_TORQUE_SCALE : HELI_TORQUE_SCALE);
      var fThrust = unbeatable ? THRUST_FORWARD : (botSlot ? THRUST_FORWARD * VL_BOT_THRUST_SCALE : THRUST_FORWARD);
      var autoRollHuman =
        (inp.autoRoll === undefined || inp.autoRoll === 1 || inp.autoRoll === true) &&
        this._vlIsHumanOccupyingSlot(slot);

      if (!noStickTorque) {
        /* HeliVR/main.js lines 226–231: local torque (pitch, yaw*1.5, roll) then applyQuaternion(mesh). */
        var pitch = inp.ry;
        var roll = inp.rx;
        var yaw = inp.lx;
        if (autoRollHuman) {
          roll = 0;
        }
        this.tmpVec2.set(pitch * tScale, yaw * tScale * 1.5, roll * tScale);
        var q = new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
        this.tmpVec2.applyQuaternion(q);
        body.torque.x += this.tmpVec2.x;
        body.torque.y += this.tmpVec2.y;
        body.torque.z += this.tmpVec2.z;
      }

      var trig = inp.trig || 0;
      var trigRev = inp.trigRev || 0;
      if (trig > 0) {
        var fWorld = this._bodyDirWorld(body, 0, 0, 1);
        body.force.x += fWorld.x * trig * fThrust;
        body.force.y += fWorld.y * trig * fThrust;
        body.force.z += fWorld.z * trig * fThrust;
      }
      if (trigRev > 0) {
        var fBack = this._bodyDirWorld(body, 0, 0, 1);
        var rScale = fThrust * THRUST_REVERSE_SCALE;
        body.force.x -= fBack.x * trigRev * rScale;
        body.force.y -= fBack.y * trigRev * rScale;
        body.force.z -= fBack.z * trigRev * rScale;
      }
      /* Wing-level roll only: target roof axis = level dir for current pitch (proj of world up ⊥ thrust). */
      if (autoRollHuman && !noStickTorque) {
        var fW = this._bodyDirWorld(body, 0, 0, 1);
        var fy = fW.y;
        var px = -fy * fW.x;
        var py = 1 - fy * fy;
        var pz = -fy * fW.z;
        var lenSq = px * px + py * py + pz * pz;
        if (lenSq >= VL_AUTO_ROLL_LEVEL_MIN_LEN_SQ) {
          var invL = 1 / Math.sqrt(lenSq);
          var tLx = px * invL;
          var tLy = py * invL;
          var tLz = pz * invL;
          var uB = this._bodyDirWorld(body, 0, 1, 0);
          var ex = uB.y * tLz - uB.z * tLy;
          var ey = uB.z * tLx - uB.x * tLz;
          var ez = uB.x * tLy - uB.y * tLx;
          var tqx = ex * VL_AUTO_ROLL_UP_KP;
          var tqy = ey * VL_AUTO_ROLL_UP_KP;
          var tqz = ez * VL_AUTO_ROLL_UP_KP;
          var tH = Math.sqrt(tqx * tqx + tqy * tqy + tqz * tqz);
          if (tH > VL_AUTO_ROLL_UP_MAX) {
            var tS = VL_AUTO_ROLL_UP_MAX / tH;
            tqx *= tS;
            tqy *= tS;
            tqz *= tS;
          }
          body.torque.x += tqx;
          body.torque.y += tqy;
          body.torque.z += tqz;
          var wx = body.angularVelocity.x;
          var wy = body.angularVelocity.y;
          var wz = body.angularVelocity.z;
          var wRoll = wx * fW.x + wy * fW.y + wz * fW.z;
          var kdR = VL_AUTO_ROLL_UP_KD * wRoll;
          body.torque.x -= kdR * fW.x;
          body.torque.y -= kdR * fW.y;
          body.torque.z -= kdR * fW.z;
        }
      }
    },

    /**
     * Host: auto-roll for **human** cubes — strip ω along body +Z (barrel spin). Wing-level bank is handled
     * in `_applyCarControls`. Skipped for bots, grab, reset cd/out.
     */
    _vlApplyRollLockIfEnabled: function (slot) {
      var inp = this.inputs[slot];
      var body = this.carBodies[slot];
      if (!body || !inp) return;
      var autoRollOn = inp.autoRoll === undefined || inp.autoRoll === 1 || inp.autoRoll === true;
      if (!autoRollOn) return;
      if (!this._vlIsHumanOccupyingSlot(slot)) return;
      var G = this._vlGrabState[slot];
      var R = this._vlSlotReset[slot];
      if (G && G.active) return;
      if (R && (R.phase === 'cd' || R.phase === 'out')) return;

      var fwd = this._bodyDirWorld(body, 0, 0, 1);
      var fx = fwd.x;
      var fy = fwd.y;
      var fz = fwd.z;
      var fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1e-6;
      fx /= fl;
      fy /= fl;
      fz /= fl;
      var wx = body.angularVelocity.x;
      var wy = body.angularVelocity.y;
      var wz = body.angularVelocity.z;
      var spin = wx * fx + wy * fy + wz * fz;
      body.angularVelocity.x -= fx * spin;
      body.angularVelocity.y -= fy * spin;
      body.angularVelocity.z -= fz * spin;
    },

    _clampCarMotion: function (body, slot) {
      if (!body) return;
      var relaxThrow = typeof slot === 'number' && this._vlThrowClampUntil[slot] > performance.now();
      var resetHostSpin =
        typeof slot === 'number' &&
        this._vlSlotReset &&
        this._vlSlotReset[slot] &&
        this._vlGrabState &&
        this._vlGrabState[slot] &&
        !this._vlGrabState[slot].active &&
        (this._vlSlotReset[slot].phase === 'cd' || this._vlSlotReset[slot].phase === 'out');
      var maxLin = relaxThrow ? VL_THROW_LIN_CAP * 1.35 : MAX_LIN_SPEED;
      var maxAng = resetHostSpin
        ? VL_RESET_CD_SPIN_MAX_ANG
        : relaxThrow
          ? VL_THROW_ANG_CAP * 1.2
          : MAX_ANG_SPEED;
      var v = body.velocity;
      var sp = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (sp > maxLin) {
        var k = maxLin / sp;
        v.x *= k;
        v.y *= k;
        v.z *= k;
      }
      var w = body.angularVelocity;
      var ws = Math.sqrt(w.x * w.x + w.y * w.y + w.z * w.z);
      if (ws > maxAng) {
        var k2 = maxAng / ws;
        w.x *= k2;
        w.y *= k2;
        w.z *= k2;
      }
    },

    /**
     * Host: if the cube is not grabbed during reset countdown (`cd`) or elastic shrink (`out`), apply a fast tumble:
     * angular velocity along a time-varying mix of body +X / +Y / +Z (all axes), magnitude eased in `cd`, max in `out`.
     */
    _vlApplyResetSpin: function (slot, nowMs) {
      var R = this._vlSlotReset[slot];
      var body = this.carBodies[slot];
      var G = this._vlGrabState[slot];
      if (!R || !body || !G || G.active) return;
      /* Reset tumble is visual juice for human-owned cubes; skip for bots so torque + spin don’t stack. */
      if (!this._vlIsHumanOccupyingSlot(slot)) return;
      var w;
      var elapsed;
      var u;
      var g;
      var ph;
      var a;
      var b;
      var c;
      var ox;
      var oy;
      var oz;
      var len;
      var inv;
      if (R.phase === 'cd') {
        elapsed = Math.min(VL_CUBE_RESET_CD_SEC, Math.max(0, (nowMs - R.t0) / 1000));
        u = VL_CUBE_RESET_CD_SEC > 1e-6 ? elapsed / VL_CUBE_RESET_CD_SEC : 1;
        if (u < 0) u = 0;
        if (u > 1) u = 1;
        g = u * u;
        w = VL_RESET_CD_SPIN_W0 + (VL_RESET_CD_SPIN_W1 - VL_RESET_CD_SPIN_W0) * g;
      } else if (R.phase === 'out') {
        w = VL_RESET_CD_SPIN_W1;
      } else {
        return;
      }
      this._tmpVecThrow.copy(this._bodyDirWorld(body, 1, 0, 0));
      this.tmpVec2.copy(this._bodyDirWorld(body, 0, 1, 0));
      this._tmpVecAng.copy(this._bodyDirWorld(body, 0, 0, 1));
      ph = nowMs * 0.0028;
      a = 0.52 + 0.48 * Math.sin(ph);
      b = 0.52 + 0.48 * Math.sin(ph * 1.23 + 1.1);
      c = 0.52 + 0.48 * Math.cos(ph * 0.97 + 0.4);
      ox = this._tmpVecThrow.x * a + this.tmpVec2.x * b + this._tmpVecAng.x * c;
      oy = this._tmpVecThrow.y * a + this.tmpVec2.y * b + this._tmpVecAng.y * c;
      oz = this._tmpVecThrow.z * a + this.tmpVec2.z * b + this._tmpVecAng.z * c;
      len = Math.sqrt(ox * ox + oy * oy + oz * oz);
      if (len < 1e-8) {
        ox = this._tmpVecAng.x;
        oy = this._tmpVecAng.y;
        oz = this._tmpVecAng.z;
        len = Math.sqrt(ox * ox + oy * oy + oz * oz) || 1;
      }
      inv = w / len;
      body.angularVelocity.set(ox * inv, oy * inv, oz * inv);
    },

    /** Host: slot driven by a human (local host player or an open PeerJS client). */
    _vlIsHumanOccupyingSlot: function (slot) {
      if (!this.isHost) return false;
      if (slot === this.mySlot) return true;
      var i;
      var c;
      for (i = 0; i < this.clientConns.length; i++) {
        c = this.clientConns[i];
        if (c && c.open && c.vlSlot === slot) return true;
      }
      return false;
    },

    /** Host: bot cube center clearly outside the cage (±Z / ±Y, or ±X past goal geometry). */
    _vlBotCubeEscapedArena: function (body) {
      var A = ARENA;
      if (!body || !body.position) return false;
      var lx = body.position.x - A.cx;
      var lz = body.position.z - A.cz;
      var ly = body.position.y - A.cy;
      var gw = A.goalW + CAR_HALF * 1.15;
      if (Math.abs(lz) > A.halfD + VL_BOT_OUT_PAD_Z) return true;
      if (ly < -VL_BOT_OUT_PAD_Y_LOW || ly > A.cageH + 0.02 + VL_BOT_OUT_PAD_Y_HIGH) return true;
      if (lx < -A.halfW - VL_BOT_OUT_PAD_X || lx > A.halfW + VL_BOT_OUT_PAD_X) return true;
      if (Math.abs(lx) > A.halfW + CAR_HALF * 0.45 && Math.abs(lz) > gw) return true;
      return false;
    },

    /**
     * Host: ungrabbed bot cube that left the arena → snap to spawn (no 5s reset UI).
     * Cooldown avoids fighting the physics engine if something keeps ejecting the body.
     */
    _vlRecoverBotCubeIfOutside: function (slot, nowMs) {
      if (!this.isHost || this._vlIsHumanOccupyingSlot(slot)) return;
      var body = this.carBodies[slot];
      var spawn = this._carSpawn && this._carSpawn[slot];
      var G = this._vlGrabState[slot];
      var R = this._vlSlotReset[slot];
      if (!body || !spawn || !G || G.active || !R || R.phase !== 'idle') return;
      if (!this._vlBotCubeEscapedArena(body)) return;
      if (nowMs < (this._vlBotArenaRecoverAt[slot] || 0)) return;
      this._vlBotArenaRecoverAt[slot] = nowMs + VL_BOT_ARENA_RECOVER_COOLDOWN_MS;
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      body.position.set(spawn.x, spawn.y, spawn.z);
      body.quaternion.set(spawn.qx, spawn.qy, spawn.qz, spawn.qw);
      if (typeof body.wakeUp === 'function') body.wakeUp();
      var st = this._vlBotState && this._vlBotState[slot];
      if (st) {
        st.smx = null;
        st.smz = null;
        st.driftUntil = 0;
      }
    },

    /**
     * Host: after physics, reduce a bot cube’s velocity *into* nearby cage faces so self-thrust doesn’t
     * slam boundaries; leaves most inward speed if already fast (likely another body / throw).
     */
    _vlBotSoftenInwardWallVel: function (slot) {
      if (!this.isHost || this._vlIsHumanOccupyingSlot(slot)) return;
      var body = this.carBodies[slot];
      var G = this._vlGrabState[slot];
      var R = this._vlSlotReset[slot];
      if (!body || !G || G.active || !R || R.phase !== 'idle') return;
      var A = ARENA;
      var lx = body.position.x - A.cx;
      var ly = body.position.y - A.cy;
      var lz = body.position.z - A.cz;
      var ix = A.halfW - VL_BOT_WALL_INSET;
      var iz = A.halfD - VL_BOT_WALL_INSET;
      var yLo = 0.02 + CAR_HALF + 0.06;
      var yHi = 0.02 + A.cageH - CAR_HALF - 0.08;
      var band = VL_BOT_WALL_BAND + 0.1;
      var vx = body.velocity.x;
      var vy = body.velocity.y;
      var vz = body.velocity.z;
      var d;
      var c;
      var hard;
      var inward;
      d = lx + ix;
      if (d < band && vx < 0) {
        inward = -vx;
        c = clamp(1 - d / band, 0, 1);
        hard = inward > VL_BOT_WALL_PUSH_TRUST_MS ? 0.26 : 0.9;
        vx *= 1 - c * hard;
      }
      d = ix - lx;
      if (d < band && vx > 0) {
        inward = vx;
        c = clamp(1 - d / band, 0, 1);
        hard = inward > VL_BOT_WALL_PUSH_TRUST_MS ? 0.26 : 0.9;
        vx *= 1 - c * hard;
      }
      d = lz + iz;
      if (d < band && vz < 0) {
        inward = -vz;
        c = clamp(1 - d / band, 0, 1);
        hard = inward > VL_BOT_WALL_PUSH_TRUST_MS ? 0.26 : 0.9;
        vz *= 1 - c * hard;
      }
      d = iz - lz;
      if (d < band && vz > 0) {
        inward = vz;
        c = clamp(1 - d / band, 0, 1);
        hard = inward > VL_BOT_WALL_PUSH_TRUST_MS ? 0.26 : 0.9;
        vz *= 1 - c * hard;
      }
      d = ly - yLo;
      if (d < band * 0.65 && vy < 0) {
        inward = -vy;
        c = clamp(1 - d / (band * 0.65), 0, 1);
        hard = inward > VL_BOT_WALL_PUSH_TRUST_MS ? 0.22 : 0.85;
        vy *= 1 - c * hard;
      }
      d = yHi - ly;
      if (d < band * 0.65 && vy > 0) {
        inward = vy;
        c = clamp(1 - d / (band * 0.65), 0, 1);
        hard = inward > VL_BOT_WALL_PUSH_TRUST_MS ? 0.22 : 0.85;
        vy *= 1 - c * hard;
      }
      body.velocity.x = vx;
      body.velocity.y = vy;
      body.velocity.z = vz;
    },

    /** Slots 0,2 defend −X (west) mouth; 1,3 defend +X (east). */
    _vlBotDefendsWest: function (slot) {
      return slot === 0 || slot === 2;
    },

    /**
     * Bot steering: keep cubes mostly upright — yaw in XZ to face thrust target, mild pitch, low roll, capped thrust.
     * Avoids full stick Heli mapping (that fought attitude and caused endless spin).
     */
    _vlBotFlatSteer: function (body, dirx, diry, dirz, out) {
      var fxw = this._bodyDirWorld(body, 0, 0, 1);
      var fhx = fxw.x;
      var fhz = fxw.z;
      var fh = Math.sqrt(fhx * fhx + fhz * fhz) + 1e-6;
      fhx /= fh;
      fhz /= fh;
      var dhx = dirx;
      var dhz = dirz;
      var dh = Math.sqrt(dhx * dhx + dhz * dhz) + 1e-6;
      dhx /= dh;
      dhz /= dh;
      var cross = fhx * dhz - fhz * dhx;
      var dot = clamp(fhx * dhx + fhz * dhz, -1, 1);
      var yawErr = Math.atan2(cross, dot);
      out.lx = clamp(yawErr * 0.88, -0.36, 0.36);
      out.rx = clamp(-yawErr * 0.1, -0.14, 0.14);
      out.ry = clamp(-diry * 0.85 - clamp(fxw.y, -0.3, 0.3) * 0.34, -0.24, 0.24);
      out.trig = clamp(0.09 + Math.max(0, dot) * 0.4, 0, 0.46);
      if (Math.abs(yawErr) > 0.58) {
        out.trig *= 0.52;
      }
    },

    /**
     * Host: geometry from user spec — ray opposing-goal center → ball; cube sits past the ball on that ray
     * (toward own goal) at VL_BOT_LINE_STANDOFF. Near the slot, blend steering so body +Z aligns with
     * (opp goal − ball) to shove toward the opponent net. Wall escape + own-goal leak unchanged.
     */
    _vlSteerSlotBot: function (slot, nowMs) {
      var A = ARENA;
      var b = this.ballBody;
      var body = this.carBodies[slot];
      var st = this._vlBotState && this._vlBotState[slot];
      if (!b || !body || !st) return;
      var defWest = this._vlBotDefendsWest(slot);
      var vxa = b.velocity.x;
      var vza = b.velocity.z;
      var vya = b.velocity.y;
      var pred = 0.18;
      var bx = b.position.x + vxa * pred;
      var by = b.position.y + vya * pred;
      var bz = b.position.z + vza * pred;
      var cx = body.position.x;
      var cy = body.position.y;
      var cz = body.position.z;
      var lx = cx - A.cx;
      var ly = cy - A.cy;
      var lz = cz - A.cz;
      var ix = A.halfW - VL_BOT_WALL_INSET;
      var iz = A.halfD - VL_BOT_WALL_INSET;
      var yLo = 0.02 + CAR_HALF + 0.06;
      var yHi = 0.02 + A.cageH - CAR_HALF - 0.08;
      var band = VL_BOT_WALL_BAND;
      var k = VL_BOT_WALL_REP_K;
      var repX = 0;
      var repY = 0;
      var repZ = 0;
      if (lx < -ix + band) repX += k * ((-ix + band) - lx);
      if (lx > ix - band) repX -= k * (lx - (ix - band));
      if (lz < -iz + band) repZ += k * ((-iz + band) - lz);
      if (lz > iz - band) repZ -= k * (lz - (iz - band));
      if (ly < yLo + band * 0.55) repY += k * 0.92 * ((yLo + band * 0.55) - ly);
      if (ly > yHi - band * 0.55) repY -= k * 0.92 * (ly - (yHi - band * 0.55));
      var endXBand = band * 0.65;
      if (defWest && lx < -ix + endXBand) repX += k * 1.25 * ((-ix + endXBand) - lx);
      if (!defWest && lx > ix - endXBand) repX -= k * 1.25 * (lx - (ix - endXBand));
      var dwx = ix + band - Math.abs(lx);
      var dwz = iz + band - Math.abs(lz);
      var dwyLo = ly - (yLo - band * 0.35);
      var dwyHi = yHi + band * 0.35 - ly;
      var wallClear = Math.min(dwx, dwz, dwyLo, dwyHi);
      var pen = clamp(1 - (wallClear - VL_BOT_WALL_CLEAR_SAFE) / VL_BOT_WALL_CLEAR_RANGE, 0, 1);
      var ch = A.cageH;
      var wallCy = 0.02 + ch * 0.5;
      var goalOppX = defWest ? A.cx + A.halfW - VL_BOT_OPP_GOAL_INSET : A.cx - A.halfW + VL_BOT_OPP_GOAL_INSET;
      var goalOppY = A.cy + wallCy;
      var goalOppZ = A.cz;
      var dx = bx - goalOppX;
      var dy = by - goalOppY;
      var dz = bz - goalOppZ;
      var dlen = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-5;
      if (dlen < 0.085) {
        dx = defWest ? -1 : 1;
        dy = 0;
        dz = 0;
        dlen = 1;
      } else {
        dx /= dlen;
        dy /= dlen;
        dz /= dlen;
      }
      var vTowardOwn = defWest ? Math.max(0, -vxa - 0.02) : Math.max(0, vxa - 0.02);
      vTowardOwn = Math.min(vTowardOwn * 2.6, 1.35);
      var standoff = clamp(VL_BOT_LINE_STANDOFF - Math.min(vTowardOwn * 0.052, 0.085), 0.17, 0.38);
      var Px = bx + dx * standoff;
      var Py = by + dy * standoff;
      var Pz = bz + dz * standoff;
      var mxSlot = Px - cx;
      var mySlot = Py - cy;
      var mzSlot = Pz - cz;
      var slotLen = Math.sqrt(mxSlot * mxSlot + mySlot * mySlot + mzSlot * mzSlot) + 1e-6;
      var sx = mxSlot / slotLen;
      var sy = mySlot / slotLen;
      var sz = mzSlot / slotLen;
      var shx = goalOppX - bx;
      var shy = goalOppY - by;
      var shz = goalOppZ - bz;
      var shLen = Math.sqrt(shx * shx + shy * shy + shz * shz) + 1e-6;
      shx /= shLen;
      shy /= shLen;
      shz /= shLen;
      var wEngage = clamp(1 - slotLen / VL_BOT_ENGAGE_DIST, 0, 1);
      if (vTowardOwn > 0.12) {
        wEngage = Math.max(wEngage, Math.min(0.55, vTowardOwn * 0.42));
      }
      var rx = sx * (1 - wEngage) + shx * wEngage;
      var ry = sy * (1 - wEngage) + shy * wEngage;
      var rz = sz * (1 - wEngage) + shz * wEngage;
      var ml = Math.sqrt(rx * rx + ry * ry + rz * rz) + 1e-6;
      rx /= ml;
      ry /= ml;
      rz /= ml;
      var ehx = repX;
      var ehz = repZ;
      var enl = Math.sqrt(ehx * ehx + ehz * ehz);
      if (enl < 1e-5) {
        ehx = lx >= 0 ? -1 : 1;
        ehz = 0;
        enl = 1;
      } else {
        ehx /= enl;
        ehz /= enl;
      }
      var hor = Math.sqrt(rx * rx + rz * rz) + 1e-6;
      var ux0 = rx / hor;
      var uz0 = rz / hor;
      var vxh = ux0 * (1 - pen) + ehx * pen;
      var vzh = uz0 * (1 - pen) + ehz * pen;
      var vnh = Math.sqrt(vxh * vxh + vzh * vzh) + 1e-6;
      vxh /= vnh;
      vzh /= vnh;
      var mx = vxh + repX * 0.045;
      var my = ry + repY * 0.055;
      var mz = vzh + repZ * 0.045;
      ml = Math.sqrt(mx * mx + my * my + mz * mz) + 1e-6;
      mx /= ml;
      my /= ml;
      mz /= ml;
      var tx = mx;
      var tz = mz;
      var th = Math.sqrt(tx * tx + tz * tz);
      if (th < 0.055) {
        tx = defWest ? 1 : -1;
        tz = 0;
        th = 1;
      }
      tx /= th;
      tz /= th;
      if (typeof st.smx !== 'number' || typeof st.smz !== 'number' || !isFinite(st.smx) || !isFinite(st.smz)) {
        st.smx = tx;
        st.smz = tz;
      } else {
        var al = pen > 0.55 ? 0.38 : 0.22 + wEngage * 0.14;
        st.smx += (tx - st.smx) * al;
        st.smz += (tz - st.smz) * al;
        var nh = Math.sqrt(st.smx * st.smx + st.smz * st.smz) + 1e-6;
        st.smx /= nh;
        st.smz /= nh;
      }
      var diry = clamp(b.position.y - cy, -0.55, 0.55) * 0.1 + shy * 0.18 * wEngage + my * 0.18;
      var z = zeroInput();
      this._vlBotFlatSteer(body, st.smx, diry, st.smz, z);
      z.trig *= 0.68 + (1 - pen) * 0.22 + wEngage * 0.14;
      wallClear = Math.min(dwx, dwz, dwyLo, dwyHi);
      var wallTrigMul = clamp((wallClear - 0.03) / 0.34, 0.04, 1);
      z.trig *= wallTrigMul;
      var bx0 = b.position.x;
      var vxb = b.velocity.x;
      var ownLeak = 1;
      if (defWest) {
        if (bx0 < cx + 0.06 && vxb < -0.055 && cx - bx0 < 0.36) {
          ownLeak = 0.12 + Math.min(1, (cx - bx0) / 0.36) * 0.28;
        }
      } else {
        if (bx0 > cx - 0.06 && vxb > 0.055 && bx0 - cx < 0.36) {
          ownLeak = 0.12 + Math.min(1, (bx0 - cx) / 0.36) * 0.28;
        }
      }
      z.trig *= ownLeak;
      z.trig = clamp(z.trig, 0, 0.4 + wEngage * 0.04);
      st.driftUntil = 0;
      this.inputs[slot] = z;
    },

    /**
     * Unbeatable bot v4: The Absolute Shield.
     * Snaps to the vector between the ball and its own net.
     */
    _vlSteerUnbeatableBot: function (slot, nowMs) {
      if (!this.isHost || !this.ballBody || !this.carBodies) return;
      var A = ARENA;
      var b = this.ballBody;
      var body = this.carBodies[slot];
      if (!b || !body) return;

      var defWest = this._vlBotDefendsWest(slot);
      var cx = body.position.x;
      var cy = body.position.y;
      var cz = body.position.z;
      var vx = body.velocity.x;
      var vy = body.velocity.y;
      var vz = body.velocity.z;

      var ownGoalX = defWest ? A.cx - A.halfW : A.cx + A.halfW;
      var ownGoalY = A.cy + (0.02 + A.cageH * 0.5);
      var ownGoalZ = A.cz;

      // 1. Predicted Ball Position (short lookahead for snappy response)
      var targetB = this._vlPredictBallTrajectory(0.12);
      var bx = targetB.x;
      var by = targetB.y;
      var bz = targetB.z;

      // 2. The Shield Vector: Own Goal -> Ball
      var gtx = bx - ownGoalX;
      var gty = by - ownGoalY;
      var gtz = bz - ownGoalZ;
      var gtLen = Math.sqrt(gtx * gtx + gty * gty + gtz * gtz) + 1e-6;
      var ugtx = gtx / gtLen;
      var ugty = gty / gtLen;
      var ugtz = gtz / gtLen;

      // Target position: on the goal-ball line, offset 0.38m from the ball's center
      var Px = bx - ugtx * 0.38;
      var Py = by - ugty * 0.38;
      var Pz = bz - ugtz * 0.38;

      // 3. Absolute Snapping (Torque-boosted in _applyCarControls)
      var z = zeroInput();
      
      // Face the ball directly
      var targetFaceX = bx - cx;
      var targetFaceY = by - cy;
      var targetFaceZ = bz - cz;
      var fLen = Math.sqrt(targetFaceX * targetFaceX + targetFaceY * targetFaceY + targetFaceZ * targetFaceZ) + 1e-6;
      targetFaceX /= fLen; targetFaceY /= fLen; targetFaceZ /= fLen;

      var upB = this._bodyDirWorld(body, 0, 1, 0);
      var rightB = this._bodyDirWorld(body, 1, 0, 0);
      
      // Scalar projection onto local axes
      var yawErr = -(targetFaceX * rightB.x + targetFaceY * rightB.y + targetFaceZ * rightB.z);
      var pitchErr = -(targetFaceX * upB.x + targetFaceY * upB.y + targetFaceZ * upB.z);

      // High response factor for snappy turning
      z.lx = clamp(yawErr * 5.2, -1, 1); 
      z.ry = clamp(pitchErr * 5.2, -1, 1);

      // 4. Snappy Movement to Line
      var mx = Px - cx;
      var my = Py - cy;
      var mz = Pz - cz;
      var mlen = Math.sqrt(mx * mx + my * my + mz * mz) + 1e-6;
      mx /= mlen; my /= mlen; mz /= mlen;

      var fxw = this._bodyDirWorld(body, 0, 0, 1);
      var dotMove = clamp(fxw.x * mx + fxw.y * my + fxw.z * mz, -1, 1);
      var distToP = mlen;
      var speedActual = vx * mx + vy * my + vz * mz;

      if (distToP > 0.04) {
        // Broad alignment tolerance (45 degrees) for immediate action
        if (dotMove > 0.7) {
          z.trig = 1.0;
          if (speedActual > 1.8 && distToP < 0.25) z.trig = 0; // Braking
        } else if (dotMove < -0.5) {
          z.trigRev = 1.0;
        } else {
          // Pointing sideways? Force a nudge to get moving
          z.trig = 0.32;
        }
      }

      // 5. Strike / Clear
      // Only strike if we are securely between the ball and our goal (dotSide > 0)
      var botToBallX = bx - cx;
      var botToBallY = by - cy;
      var botToBallZ = bz - cz;
      var dotSide = (botToBallX * ugtx + botToBallY * ugty + botToBallZ * ugtz); 
      var distToBall = Math.sqrt(botToBallX * botToBallX + botToBallY * botToBallY + botToBallZ * botToBallZ);

      if (distToBall < 0.26 && dotSide > 0.05) {
        z.trig = 1.0;
      }

      this.inputs[slot] = z;
    },

    /**
     * Physics-based prediction of ball position with wall reflection.
     */
    _vlPredictBallTrajectory: function (dt) {
      var A = ARENA;
      var b = this.ballBody;
      if (!b) return { x: 0, y: 0, z: 0 };

      var px = b.position.x;
      var py = b.position.y;
      var pz = b.position.z;
      var vx = b.velocity.x;
      var vy = b.velocity.y;
      var vz = b.velocity.z;

      var r = BALL_R;
      var minX = A.cx - A.halfW + r + A.wallT;
      var maxX = A.cx + A.halfW - r - A.wallT;
      var minZ = A.cz - A.halfD + r + A.wallT;
      var maxZ = A.cz + A.halfD - r - A.wallT;
      var minY = A.cy + 0.02 + r;
      var maxY = A.cy + 0.02 + A.cageH - r;

      // Simulate a few steps for simple wall bounces
      var steps = 3;
      var stepDt = dt / steps;
      for (var i = 0; i < steps; i++) {
        px += vx * stepDt;
        py += vy * stepDt;
        pz += vz * stepDt;

        // Bounce X
        if (px < minX) { px = minX + (minX - px); vx *= -0.9; }
        else if (px > maxX) { px = maxX - (px - maxX); vx *= -0.9; }
        
        // Bounce Z 
        if (pz < minZ) { pz = minZ + (minZ - pz); vz *= -0.9; }
        else if (pz > maxZ) { pz = maxZ - (pz - maxZ); vz *= -0.9; }

        // Bounce Y
        if (py < minY) { py = minY + (minY - py); vy *= -0.9; }
        else if (py > maxY) { py = maxY - (py - maxY); vy *= -0.9; }
      }

      return { x: px, y: py, z: pz };
    },

    /** Host: fill `inputs` for any slot not controlled by a human (offline or MP). */
    _vlApplyBotInputs: function (nowMs) {
      if (!this.isHost || !this.ballBody || !this.carBodies) return;
      /* MP lobby: stay idle until match starts. Offline (no peer): bots on empty slots for practice. */
      var lobbyWaiting = !!(this.peer && this.peer.open) && !this.vlMatchActive;
      if (lobbyWaiting) return;
      var s;
      for (s = 0; s < 4; s++) {
        if (this._vlIsHumanOccupyingSlot(s)) continue;
        if (window.vlBotUnbeatableMode) {
          this._vlSteerUnbeatableBot(s, nowMs);
        } else {
          this._vlSteerSlotBot(s, nowMs);
        }
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
        var gixW = A.cx - A.halfW + 0.06;
        var giyW = b.position.y;
        var gizW = b.position.z;
        this._playGoalFxWorld(gixW, giyW, gizW);
        this._broadcastFx({ type: 'vl-goal', ix: gixW, iy: giyW, iz: gizW });
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
        var gixE = A.cx + A.halfW - 0.06;
        var giyE = b.position.y;
        var gizE = b.position.z;
        this._playGoalFxWorld(gixE, giyE, gizE);
        this._broadcastFx({ type: 'vl-goal', ix: gixE, iy: giyE, iz: gizE });
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
      for (i = 0; i < 4; i++) {
        this._vlReleaseGrabSlot(i, performance.now(), true);
        this._vlGrabState[i].active = false;
        this._vlSlotReset[i].phase = 'idle';
        this._vlHostLedCd[i] = -1;
        this._vlLedMode[i] = VL_LED_SM_NEUTRAL;
        this.carVisScale[i] = 1;
      }
    },

    _vlUpdateCarLedFaces: function (nowMs) {
      if (!this._vlCarLed || !this._vlCarLed.length) return;
      var i;
      var L;
      var sm;
      var drawMode;
      for (i = 0; i < 4; i++) {
        L = this._vlCarLed[i];
        if (!L) continue;
        sm = this._vlLedMode && typeof this._vlLedMode[i] === 'number' ? this._vlLedMode[i] : 0;
        if (sm >= VL_LED_SM_RESET_DIGIT_BASE && sm <= VL_LED_SM_RESET_DIGIT_BASE + 9) {
          drawMode = 'r' + (sm - VL_LED_SM_RESET_DIGIT_BASE);
        } else if (sm === VL_LED_SM_RESET_BLANK) {
          drawMode = 'blank';
        } else if (sm === VL_LED_SM_HIT) {
          drawMode = 'hit';
        } else if (sm === VL_LED_SM_TONGUE) {
          drawMode = 'tongue';
        } else {
          drawMode = 'neutral';
        }
        if (drawMode !== L._vlLastLedDrawToken) {
          L._vlLastLedDrawToken = drawMode;
          if (sm >= VL_LED_SM_RESET_DIGIT_BASE && sm <= VL_LED_SM_RESET_DIGIT_BASE + 9) {
            vlDrawLedCountdownDigit(L.ctx, L.canvasW, L.canvasH, sm - VL_LED_SM_RESET_DIGIT_BASE, L.ledBodyColor);
          } else if (sm === VL_LED_SM_RESET_BLANK) {
            vlDrawLedSolidWhite(L.ctx, L.canvasW, L.canvasH);
          } else if (sm === VL_LED_SM_HIT) {
            vlDrawLedFace(L.ctx, L.canvasW, L.canvasH, 'hit', L.ledBodyColor);
          } else if (sm === VL_LED_SM_TONGUE) {
            vlDrawLedFace(L.ctx, L.canvasW, L.canvasH, 'tongue', L.ledBodyColor);
          } else {
            vlDrawLedFace(L.ctx, L.canvasW, L.canvasH, 'neutral', L.ledBodyColor);
          }
          L.texture.needsUpdate = true;
        }
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
          var sc = this.carVisScale && typeof this.carVisScale[i] === 'number' ? this.carVisScale[i] : 1;
          if (!isFinite(sc)) sc = 1;
          if (sc <= 0) sc = 0.001;
          this.carEls[i].object3D.scale.set(sc, sc, sc);
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
      if (snap.vlLm && snap.vlLm.length === 4) {
        for (var ii = 0; ii < 4; ii++) {
          var om = this._vlLedMode[ii];
          var nm = snap.vlLm[ii];
          if (typeof nm !== 'number' || !isFinite(nm)) continue;
          if (nm === VL_LED_SM_TONGUE && om !== VL_LED_SM_TONGUE) {
            this._playLedSonarSlot(ii, 1);
          }
          if (nm === VL_LED_SM_HIT && om !== VL_LED_SM_HIT) {
            this._playLedSonarSlot(ii, VL_LED_SONAR_BUMP_RATE);
          }
          this._vlLedMode[ii] = nm;
        }
      } else if (snap.vlRD && snap.vlRD.length === 4) {
        for (var ir = 0; ir < 4; ir++) {
          var rd = snap.vlRD[ir];
          var nm2 =
            rd === 100
              ? VL_LED_SM_RESET_BLANK
              : typeof rd === 'number' && rd >= 0 && rd <= 9
                ? VL_LED_SM_RESET_DIGIT_BASE + rd
                : VL_LED_SM_NEUTRAL;
          this._vlLedMode[ir] = nm2;
        }
      }
      if (snap.cvSc && snap.cvSc.length === 4) {
        for (var isc = 0; isc < 4; isc++) {
          this.carVisScale[isc] = snap.cvSc[isc];
        }
      } else if (!this.isHost) {
        for (var isc0 = 0; isc0 < 4; isc0++) {
          this.carVisScale[isc0] = 1;
        }
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
      if (!this.isHost) {
        this._syncMeshesFromPhysics();
      }
    },

    /**
     * Host only: derive each cube’s LED mode (neutral / tongue / hit / reset) from physics + all players’ cameras.
     * Clients consume `snap.vlLm` only — no per-viewer LED divergence.
     */
    _vlRecomputeLedModesHost: function (nowMs) {
      if (!this.isHost || !this._vlCarLed || !this.carBodies) return;
      var proxM = VL_LED_FACE_PROX_M;
      var proxM2 = proxM * proxM;
      var i;
      var p;
      var inp;
      var cd;
      var body;
      var L;
      var tongue;
      var dx;
      var dy;
      var dz;
      var d2;
      var nextMode;
      var prev;
      for (i = 0; i < 4; i++) {
        L = this._vlCarLed[i];
        body = this.carBodies[i];
        if (!L || !body) continue;
        prev = this._vlLedMode[i] || 0;
        cd = this._vlHostLedCd[i];
        if (typeof cd === 'number' && cd >= 0 && cd <= 9) {
          nextMode = VL_LED_SM_RESET_DIGIT_BASE + cd;
        } else if (cd === 100) {
          nextMode = VL_LED_SM_RESET_BLANK;
        } else if (nowMs < L.hitFaceUntil) {
          nextMode = VL_LED_SM_HIT;
        } else {
          tongue = false;
          for (p = 0; p < 4; p++) {
            inp = this.inputs[p];
            if (!inp || !inp.camOk) continue;
            dx = inp.camx - body.position.x;
            dy = inp.camy - body.position.y;
            dz = inp.camz - body.position.z;
            d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < proxM2 && d2 > 1e-10) {
              tongue = true;
              break;
            }
          }
          nextMode = tongue ? VL_LED_SM_TONGUE : VL_LED_SM_NEUTRAL;
        }
        if (nextMode === VL_LED_SM_TONGUE && prev !== VL_LED_SM_TONGUE) {
          this._playLedSonarSlot(i, 1);
        }
        this._vlLedMode[i] = nextMode;
      }
    },

    /**
     * When true, host sends physics snap every frame so clients stay aligned on fast motion,
     * grab/follow, LED countdown digits, and elastic cube scale.
     */
    _vlNeedHighFrequencySnap: function () {
      var i;
      if (this._vlGrabState) {
        for (i = 0; i < 4; i++) {
          if (this._vlGrabState[i] && this._vlGrabState[i].active) return true;
        }
      }
      if (this._vlSlotReset) {
        for (i = 0; i < 4; i++) {
          if (this._vlSlotReset[i] && this._vlSlotReset[i].phase !== 'idle') return true;
        }
      }
      if (this.carVisScale) {
        for (i = 0; i < 4; i++) {
          var sc = this.carVisScale[i];
          if (typeof sc === 'number' && isFinite(sc) && Math.abs(sc - 1) > 0.02) return true;
        }
      }
      if (this._vlLedMode) {
        for (i = 0; i < 4; i++) {
          if (this._vlLedMode[i] !== VL_LED_SM_NEUTRAL) return true;
        }
      }
      return false;
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
        cars: [],
        vlLm: [this._vlLedMode[0], this._vlLedMode[1], this._vlLedMode[2], this._vlLedMode[3]],
        cvSc: [this.carVisScale[0], this.carVisScale[1], this.carVisScale[2], this.carVisScale[3]]
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
        'Practice (offline) — zero-G arena. Quest B (or B key on desktop) toggles cockpit view inside your cube. Multiplayer: VR menu → Play online → Host or Join with a lobby number.'
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
          self._vlRecomputeLedModesHost(performance.now());
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
        var sl = conn.vlSlot;
        this.inputs[sl] = {
          lx: typeof msg.lx === 'number' && isFinite(msg.lx) ? msg.lx : 0,
          ly: typeof msg.ly === 'number' && isFinite(msg.ly) ? msg.ly : 0,
          rx: typeof msg.rx === 'number' && isFinite(msg.rx) ? msg.rx : 0,
          ry: typeof msg.ry === 'number' && isFinite(msg.ry) ? msg.ry : 0,
          trig: typeof msg.trig === 'number' && isFinite(msg.trig) ? msg.trig : 0,
          trigRev: typeof msg.trigRev === 'number' && isFinite(msg.trigRev) ? msg.trigRev : 0,
          autoRoll: (function () {
            var ar = msg.autoRoll;
            if (ar === undefined || ar === null) ar = msg.autoYaw;
            return ar === 0 || ar === false ? 0 : 1;
          })(),
          grip: typeof msg.grip === 'number' && isFinite(msg.grip) ? msg.grip : 0,
          gripL: typeof msg.gripL === 'number' && isFinite(msg.gripL) ? msg.gripL : 0,
          gripR: typeof msg.gripR === 'number' && isFinite(msg.gripR) ? msg.gripR : 0,
          aEdge: msg.aEdge ? 1 : 0,
          lwx: typeof msg.lwx === 'number' && isFinite(msg.lwx) ? msg.lwx : 0,
          lwy: typeof msg.lwy === 'number' && isFinite(msg.lwy) ? msg.lwy : 0,
          lwz: typeof msg.lwz === 'number' && isFinite(msg.lwz) ? msg.lwz : 0,
          lqw: typeof msg.lqw === 'number' && isFinite(msg.lqw) ? msg.lqw : 1,
          lqx: typeof msg.lqx === 'number' && isFinite(msg.lqx) ? msg.lqx : 0,
          lqy: typeof msg.lqy === 'number' && isFinite(msg.lqy) ? msg.lqy : 0,
          lqz: typeof msg.lqz === 'number' && isFinite(msg.lqz) ? msg.lqz : 0,
          rwx: typeof msg.rwx === 'number' && isFinite(msg.rwx) ? msg.rwx : 0,
          rwy: typeof msg.rwy === 'number' && isFinite(msg.rwy) ? msg.rwy : 0,
          rwz: typeof msg.rwz === 'number' && isFinite(msg.rwz) ? msg.rwz : 0,
          rqw: typeof msg.rqw === 'number' && isFinite(msg.rqw) ? msg.rqw : 1,
          rqx: typeof msg.rqx === 'number' && isFinite(msg.rqx) ? msg.rqx : 0,
          rqy: typeof msg.rqy === 'number' && isFinite(msg.rqy) ? msg.rqy : 0,
          rqz: typeof msg.rqz === 'number' && isFinite(msg.rqz) ? msg.rqz : 0,
          camOk: msg.camOk ? 1 : 0,
          camx: typeof msg.camx === 'number' && isFinite(msg.camx) ? msg.camx : 0,
          camy: typeof msg.camy === 'number' && isFinite(msg.camy) ? msg.camy : 0,
          camz: typeof msg.camz === 'number' && isFinite(msg.camz) ? msg.camz : 0
        };
        if (this.inputs[sl].aEdge) {
          this._vlTryStartCubeReset(sl);
          this.inputs[sl].aEdge = 0;
        }
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
        this._vlExitFpvIfActive();
        this._applySpectatorTransform(this.mySlot);
        this._refreshCubeHighlights();
        this._setStatus(
          'Player ' +
            (this.mySlot + 1) +
            ' — brightest cube is yours. Sticks = attitude; right trigger = forward, left = reverse. Quest B = cockpit view inside your cube. Zeppelin-slow.'
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
        this._playGoalFxWorld(data.ix, data.iy, data.iz);
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
        /* LED “hit” face is driven only by `snap.vlLm` so all players match. */
        /* No client-side throttle: host already coalesces car–car audio; everyone hears the same impacts. */
        if (typeof data.x === 'number') {
          this._playBounceWorld(data.x, data.y, data.z, data.sp || 0.2);
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
      this._vlPendingAEdge = 0;
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
      var kb = this.keys || {};
      if (VL_FPV_ENABLED && kb['KeyB']) {
        if (!this._vlPrevBKey) this._vlTryToggleFpv();
        this._vlPrevBKey = true;
      } else {
        this._vlPrevBKey = false;
      }
      if (inp.aEdge) {
        this._pulseHand(vlHandEl('rightHand', 'vl-hand-right'), 0.45, 58);
      }
      if (this.isHost) {
        this.inputs[this.mySlot] = inp;
      } else if (this.hostConn && this.hostConn.open) {
        if (inp.aEdge) this._vlPendingAEdge = 1;
        var now = performance.now();
        if (now - this.lastInputSend > 1000 / INPUT_HZ) {
          this.lastInputSend = now;
          var aEdgeSend = this._vlPendingAEdge ? 1 : 0;
          if (this._vlPendingAEdge) this._vlPendingAEdge = 0;
          this.hostConn.send({
            type: 'inp',
            lx: inp.lx,
            ly: inp.ly,
            rx: inp.rx,
            ry: inp.ry,
            trig: inp.trig,
            trigRev: inp.trigRev,
            autoRoll: inp.autoRoll,
            grip: inp.grip,
            gripL: inp.gripL,
            gripR: inp.gripR,
            aEdge: aEdgeSend,
            lwx: inp.lwx,
            lwy: inp.lwy,
            lwz: inp.lwz,
            lqw: inp.lqw,
            lqx: inp.lqx,
            lqy: inp.lqy,
            lqz: inp.lqz,
            rwx: inp.rwx,
            rwy: inp.rwy,
            rwz: inp.rwz,
            rqw: inp.rqw,
            rqx: inp.rqx,
            rqy: inp.rqy,
            rqz: inp.rqz,
            camOk: inp.camOk,
            camx: inp.camx,
            camy: inp.camy,
            camz: inp.camz
          });
        }
      }

      if (this.isHost) {
        var nowHost = performance.now();
        this._vlApplyBotInputs(nowHost);
        var ia;
        for (ia = 0; ia < 4; ia++) {
          if (this.inputs[ia] && this.inputs[ia].aEdge) {
            this._vlTryStartCubeReset(ia);
            this.inputs[ia].aEdge = 0;
          }
        }
        this._vlTickCubeResets(nowHost);
        for (var i = 0; i < 4; i++) {
          this.carBodies[i].force.set(0, 0, 0);
          this.carBodies[i].torque.set(0, 0, 0);
        }
        for (var gs = 0; gs < 4; gs++) {
          this._vlApplyGrabForSlot(gs, this.inputs[gs], nowHost);
        }
        for (var s = 0; s < 4; s++) {
          var Rs = this._vlSlotReset[s];
          var Gs = this._vlGrabState[s];
          if (!Gs.active && Rs.phase !== 'out' && Rs.phase !== 'in1' && Rs.phase !== 'in2') {
            this._applyCarControls(s, this.inputs[s], Rs.phase === 'cd');
          }
        }
        this.world.step(1 / 60, dtSec, 5);
        for (var ci = 0; ci < 4; ci++) {
          this._clampCarMotion(this.carBodies[ci], ci);
        }
        for (var vb = 0; vb < 4; vb++) {
          this._vlBotSoftenInwardWallVel(vb);
        }
        for (var rb = 0; rb < 4; rb++) {
          this._vlRecoverBotCubeIfOutside(rb, nowHost);
        }
        for (var cr = 0; cr < 4; cr++) {
          this._vlApplyResetSpin(cr, nowHost);
        }
        for (var yl = 0; yl < 4; yl++) {
          this._vlApplyRollLockIfEnabled(yl);
        }
        this._checkGoals(dtSec);
        this._syncMeshesFromPhysics();
        this._vlRecomputeLedModesHost(nowHost);
        this.frame++;
        var syncHi = this._vlNeedHighFrequencySnap();
        if (
          this.clientConns.length &&
          (this.frame % SYNC_EVERY === 0 || (syncHi && this.frame % 2 === 0))
        ) {
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
      this._updateThrusterSound(inp);
      this._vlPumpHud(t);
      this._vlUpdateCarLedFaces(t);
      if (this._vlFpvActive) {
        this._vlTickFpvRigFollowCarMesh();
      }
      this._vlUpdateResetHintVisibility();
    },

    remove: function () {
      this._vlExitFpvIfActive();
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
      if (sceneEl && this._vlEnterVrStartBgm) {
        sceneEl.removeEventListener('enter-vr', this._vlEnterVrStartBgm);
        this._vlEnterVrStartBgm = null;
      }
      if (sceneEl && this._vlEnterVrBindA) {
        sceneEl.removeEventListener('enter-vr', this._vlEnterVrBindA);
        this._vlEnterVrBindA = null;
      }
      if (sceneEl && this._vlExitVrFpv) {
        sceneEl.removeEventListener('exit-vr', this._vlExitVrFpv);
        this._vlExitVrFpv = null;
      }
      var rhA = this._vlRightHandAHook;
      if (rhA && this._vlOnAbuttondown) {
        rhA.removeEventListener('abuttondown', this._vlOnAbuttondown);
        rhA.removeEventListener('abuttonup', this._vlOnAbuttonup);
      }
      this._vlRightAHandlersBound = false;
      var rhB = this._vlRightHandBHook;
      if (rhB && this._vlOnBbuttondown) {
        rhB.removeEventListener('bbuttondown', this._vlOnBbuttondown);
      }
      this._vlRightBHandlersBound = false;
      this._vlRightHandBHook = null;
      this._vlOnBbuttondown = null;
      var xr = this.el && this.el.renderer && this.el.renderer.xr;
      if (xr && this._vlReseatSpectator) {
        xr.removeEventListener('sessionstart', this._vlReseatSpectator);
      }
      this._teardownNet();
      this._vlStopGoalHapticBurst();
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

  /** Lets vr-menu `toggleMusic` fade #bg-music / #match-music (same contract as DodgeVR). */
  if (typeof AFRAME !== 'undefined' && !AFRAME.components['sound-manager']) {
    AFRAME.registerComponent('sound-manager', {
      init: function () {
        this._fadeTickers = {};
        this.bgMusic = this.el.sceneEl.querySelector('#bg-music');
        this.matchMusic = this.el.sceneEl.querySelector('#match-music');
        this.bgMusicVolume = 0.3;
        this.matchMusicVolume = 0.28;
      },
      _setVolume: function (el, vol) {
        var sc = el && el.components && el.components.sound;
        if (!sc || !sc.pool || !sc.pool.children) return;
        var i;
        for (i = 0; i < sc.pool.children.length; i++) {
          var ch = sc.pool.children[i];
          if (ch && ch.setVolume) ch.setVolume(vol);
        }
      },
      _fadeSound: function (el, fromVol, toVol, durationMs, onDone) {
        if (!el || !el.id) return;
        var id = el.id;
        if (this._fadeTickers[id]) clearInterval(this._fadeTickers[id]);
        var self = this;
        var steps = 30;
        var stepMs = Math.max(16, durationMs / steps);
        var current = fromVol;
        var delta = (toVol - fromVol) / steps;
        var count = 0;
        this._fadeTickers[id] = setInterval(function () {
          count++;
          current += delta;
          if (count >= steps) {
            current = toVol;
            clearInterval(self._fadeTickers[id]);
            delete self._fadeTickers[id];
            if (onDone) onDone();
          }
          self._setVolume(el, Math.max(0, current));
        }, stepMs);
      }
    });
  }
})();
