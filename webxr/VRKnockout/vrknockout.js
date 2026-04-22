/**
 * VRKnockout — Fall Guys–style uphill race: gravity, heavy rolling hazards, finish line.
 * Host-authoritative Cannon.js + PeerJS (up to 8 humans). Bots fill empty slots on the host.
 */
(function () {
  'use strict';

  /** Track 1 (ramp) ghost library — unchanged key for backward compatibility. */
  var VK_GHOST_STORAGE_KEY = 'vrknockout-track-ghosts-v1';
  /** Track 2 (spinners) — separate top-10 / bot pool. */
  var VK_GHOST_STORAGE_KEY_T2 = 'vrknockout-track-ghosts-v1-t2';
  /** Track 3 (sliding squares) — separate top-10 / bot pool. */
  var VK_GHOST_STORAGE_KEY_T3 = 'vrknockout-track-ghosts-v1-t3';
  /** Incremented each time a qualifying finish is merged into the ghost library (not capped at 10). */
  var VK_GHOST_TOTAL_COMMITS_KEY = 'vrknockout-track-ghost-total-commits-v1';
  var VK_GHOST_TOTAL_COMMITS_KEY_T2 = 'vrknockout-track-ghost-total-commits-v1-t2';
  var VK_GHOST_TOTAL_COMMITS_KEY_T3 = 'vrknockout-track-ghost-total-commits-v1-t3';
  var VK_SPAWN_LANE_ROT_KEY = 'vrknockout-spawn-lane-rot';
  var VK_GHOST_SAMPLE_MS = 100;
  var VK_GHOST_MAX_RUNS = 10;
  /** Mid-session qualifying runs merged ahead of localStorage ghosts for bot spine selection (host only). */
  var VK_SESSION_GHOST_MAX = 8;
  /** Looser than before so rocks / physics jitter do not keep bots in seek-only mode vs the recording. */
  var VK_GHOST_DEVIATION_M = 1.05;
  var VK_GHOST_RECOVER_OK_M = 0.55;
  var VK_GHOST_RECOVER_MS = 900;
  /**
   * Track 2–3: spinners / tiles desync bots from pure race-clock indexing; widen frame search and tolerances
   * so `_vkTryGhostBot` replays inputs instead of staying in seek recovery.
   */
  var VK_GHOST_SYNC_BACK_T23 = 110;
  var VK_GHOST_SYNC_FWD_T23 = 70;
  var VK_GHOST_DEVIATION_T23 = 2.45;
  var VK_GHOST_RECOVER_OK_T23 = 1.18;

  function vkGhostTrackParams(courseTrack) {
    var t = vkNormalizeCourseTrack(courseTrack);
    if (t === 2 || t === 3) {
      return {
        syncBack: VK_GHOST_SYNC_BACK_T23,
        syncFwd: VK_GHOST_SYNC_FWD_T23,
        devM: VK_GHOST_DEVIATION_T23,
        recoverOk: VK_GHOST_RECOVER_OK_T23
      };
    }
    return { syncBack: 24, syncFwd: 16, devM: VK_GHOST_DEVIATION_M, recoverOk: VK_GHOST_RECOVER_OK_M };
  }

  /** Unit directions of icosahedron vertices — black “pentagon” caps on a soccer-style hazard sphere texture. */
  function vkIcosahedronUnitDirs() {
    var phi = (1 + Math.sqrt(5)) / 2;
    var raw = [
      [0, 1, phi],
      [0, -1, phi],
      [0, 1, -phi],
      [0, -1, -phi],
      [1, phi, 0],
      [-1, phi, 0],
      [1, -phi, 0],
      [-1, -phi, 0],
      [phi, 0, 1],
      [phi, 0, -1],
      [-phi, 0, 1],
      [-phi, 0, -1]
    ];
    var out = [];
    var i, L, x, y, z;
    for (i = 0; i < raw.length; i++) {
      x = raw[i][0];
      y = raw[i][1];
      z = raw[i][2];
      L = Math.sqrt(x * x + y * y + z * z);
      out.push({ x: x / L, y: y / L, z: z / L });
    }
    return out;
  }

  /**
   * Canvas texture aligned with THREE.SphereGeometry UVs (u = θ/2π, v = φ/π, y-up, north at v=0).
   * White base + 12 dark pentagonal caps + faint seam grid for readable spin at gameplay distance.
   */
  function vkBuildSoccerHazardRockTexture(THREE) {
    var w = 640;
    var h = 320;
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(w, h);
    var data = img.data;
    var dirs = vkIcosahedronUnitDirs();
    var ix, iy, u, v, theta, phi, x, y, z, di, dot, g, seam, c;
    for (iy = 0; iy < h; iy++) {
      for (ix = 0; ix < w; ix++) {
        u = (ix + 0.5) / w;
        v = (iy + 0.5) / h;
        theta = u * Math.PI * 2;
        phi = v * Math.PI;
        y = Math.cos(phi);
        var sp = Math.sin(phi);
        x = sp * Math.sin(theta);
        z = sp * Math.cos(theta);
        g = 1;
        for (di = 0; di < dirs.length; di++) {
          dot = x * dirs[di].x + y * dirs[di].y + z * dirs[di].z;
          if (dot > 0.992) g = 0.06;
          else if (dot > 0.935) g = Math.min(g, 0.06 + (0.992 - dot) / 0.057 * 0.94);
        }
        seam =
          0.12 *
          (Math.abs(Math.sin(theta * 5.5)) * Math.abs(Math.sin(phi * 6)) +
            Math.abs(Math.sin(theta * 3 + phi * 4)));
        c = Math.floor(255 * clamp(g * (1 - seam), 0, 1));
        var p = (iy * w + ix) * 4;
        data[p] = c;
        data[p + 1] = c;
        data[p + 2] = Math.floor(c * 0.97);
        data[p + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    var tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  /** 2×8 start grid: column 0–7, row 0–1 (laneIdx 0–7 front row, 8–15 back row). Eight cars pick eight distinct lane indices each reset / match. */
  var VK_SPAWN_LANE_COUNT = 16;
  /** Z offset from start row center for row 0 vs row 1 (m), separated so pads do not overlap. */
  var VK_SPAWN_ROW_Z_DZ = [0.15, -0.15];

  function vkShuffleInPlace(a) {
    var i, j, t;
    for (i = a.length - 1; i > 0; i--) {
      j = Math.floor(Math.random() * (i + 1));
      t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  /** Column 0–7 within the 8-wide grid. */
  function vkLaneCol8(laneIdx) {
    return (laneIdx | 0) % 8;
  }

  /** Row 0 (lanes 0–7) or 1 (lanes 8–15). */
  function vkLaneRow2(laneIdx) {
    return ((laneIdx | 0) >> 3) & 1;
  }

  function vkLaneGridDist16(a, b) {
    return (
      Math.abs(vkLaneCol8(a) - vkLaneCol8(b)) +
      Math.abs(vkLaneRow2(a) - vkLaneRow2(b))
    );
  }

  /**
   * World XZ for logical lane 0–15: 8 columns × 2 rows, non-overlapping.
   * `rot` (0–3) shifts column labels along the grid like the old lane rotation.
   */
  function vkWorldXZForLane(pathHalfX, z0, rot, laneIdx) {
    var phx = pathHalfX && isFinite(pathHalfX) ? pathHalfX : 2.35;
    var col8 = vkLaneCol8(laneIdx);
    var row2 = vkLaneRow2(laneIdx);
    var r = (rot | 0) % 4;
    var colMap = (col8 + r * 2) & 7;
    var span = phx * 1.62;
    var x0 = -span * 0.5;
    var sx = span <= 1e-6 ? 0 : x0 + (span * colMap) / 7;
    var dz = VK_SPAWN_ROW_Z_DZ[row2] != null ? VK_SPAWN_ROW_Z_DZ[row2] : 0;
    return { x: sx, z: z0 + dz };
  }

  /** First ghost frame must be a numeric position array (avoids `!f0` treating 0 as missing). */
  function vkGhostFrame0Valid(fr) {
    return (
      Array.isArray(fr) &&
      fr.length >= 3 &&
      isFinite(fr[0]) &&
      isFinite(fr[1]) &&
      isFinite(fr[2])
    );
  }

  function vkRunHasPlayableFrames(r) {
    return !!(r && r.frames && r.frames.length >= 12 && vkGhostFrame0Valid(r.frames[0]));
  }

  function vkFilterPlayableGhostRuns(lib) {
    if (!lib || !lib.length) return [];
    var out = [];
    var i;
    for (i = 0; i < lib.length; i++) {
      if (vkRunHasPlayableFrames(lib[i])) out.push(lib[i]);
    }
    return out;
  }

  /** Same nearest-lane rule as green pads (`_vkLanesWithRecordingMask`): returns lane 0–15 or −1. */
  function vkInferSpawnLaneIdxForRot(run, phx, z0, rot) {
    if (!vkRunHasPlayableFrames(run)) return -1;
    var f0 = run.frames[0];
    var fx = f0[0];
    var fz = f0[2];
    var best = 0;
    var bestD2 = 1e9;
    var L;
    for (L = 0; L < VK_SPAWN_LANE_COUNT; L++) {
      var p = vkWorldXZForLane(phx, z0, rot, L);
      var dx = fx - p.x;
      var dz = fz - p.z;
      var d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = L;
      }
    }
    if (bestD2 >= 0.55) return -1;
    return best;
  }

  /** Stored lane match, or legacy runs with no `spawnLaneIdx` inferred from first frame (matches green pads). */
  function vkGhostRunsLaneMatches(lib, want, phx, z0, rot) {
    if (!lib || !lib.length) return [];
    want = want | 0;
    rot = (rot | 0) % 4;
    var out = [];
    var i, r;
    for (i = 0; i < lib.length; i++) {
      r = lib[i];
      if (!vkRunHasPlayableFrames(r)) continue;
      if (r.spawnLaneIdx != null && (r.spawnLaneIdx | 0) === want) {
        out.push(r);
        continue;
      }
      if (r.spawnLaneIdx == null && vkInferSpawnLaneIdxForRot(r, phx, z0, rot) === want) out.push(r);
    }
    return out;
  }

  function vkSortGhostRunsLaneFirst(lib, laneIdx, phx, z0, rot) {
    if (!lib || !lib.length) return lib || [];
    var want = laneIdx | 0;
    rot = (rot | 0) % 4;
    var pref = [];
    var rest = [];
    var i, r;
    for (i = 0; i < lib.length; i++) {
      r = lib[i];
      if (!vkRunHasPlayableFrames(r)) continue;
      var matchStored = r.spawnLaneIdx != null && (r.spawnLaneIdx | 0) === want;
      var matchInf = r.spawnLaneIdx == null && vkInferSpawnLaneIdxForRot(r, phx, z0, rot) === want;
      if (matchStored || matchInf) pref.push(r);
      else rest.push(r);
    }
    vkShuffleInPlace(pref);
    vkShuffleInPlace(rest);
    return pref.concat(rest);
  }

  function vkNormalizeCourseTrack(ct) {
    ct = ct | 0;
    if (ct === 2 || ct === 3) return ct;
    return 1;
  }

  function vkGhostStorageKey(courseTrack) {
    var t = vkNormalizeCourseTrack(courseTrack);
    if (t === 2) return VK_GHOST_STORAGE_KEY_T2;
    if (t === 3) return VK_GHOST_STORAGE_KEY_T3;
    return VK_GHOST_STORAGE_KEY;
  }

  function vkGhostTotalCommitsKey(courseTrack) {
    var t = vkNormalizeCourseTrack(courseTrack);
    if (t === 2) return VK_GHOST_TOTAL_COMMITS_KEY_T2;
    if (t === 3) return VK_GHOST_TOTAL_COMMITS_KEY_T3;
    return VK_GHOST_TOTAL_COMMITS_KEY;
  }

  /** Active course for ghost I/O (1 ramp / 2 spinners / 3 sliding tiles). */
  function vkGetGhostRunsCourseTrack() {
    try {
      var g = vkGetKnockoutGame();
      if (g) return vkNormalizeCourseTrack(g._vkCourseTrack);
    } catch (e) {}
    return 1;
  }

  /** Parse stored ghost JSON (v1–v3); fastest first, capped at VK_GHOST_MAX_RUNS. */
  function vkParseGhostRunsFromRaw(raw) {
    var all = [];
    try {
      if (!raw) return [];
      var j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (j && j.v === 3 && Array.isArray(j.runs)) {
        var ai;
        for (ai = 0; ai < j.runs.length; ai++) {
          var ra = j.runs[ai];
          if (ra && ra.frames) {
            if (ra.spawnLaneIdx != null) ra.spawnLaneIdx = (ra.spawnLaneIdx | 0) % VK_SPAWN_LANE_COUNT;
            all.push(ra);
          }
        }
      } else if (j && j.v === 2 && j.byRot && typeof j.byRot === 'object') {
        var kk;
        for (kk = 0; kk < 4; kk++) {
          var sk = String(kk);
          var arr = j.byRot[sk];
          if (!Array.isArray(arr)) continue;
          var ii;
          for (ii = 0; ii < arr.length; ii++) {
            var rb = arr[ii];
            if (rb && rb.frames) all.push(rb);
          }
        }
      } else if (j && Array.isArray(j.runs)) {
        var bi;
        for (bi = 0; bi < j.runs.length; bi++) {
          var rc = j.runs[bi];
          if (rc && rc.frames) all.push(rc);
        }
      }
    } catch (e) {}
    all.sort(function (a, b) {
      return (a.durationMs || 1e9) - (b.durationMs || 1e9);
    });
    if (all.length > VK_GHOST_MAX_RUNS) all.length = VK_GHOST_MAX_RUNS;
    return all;
  }

  /** @param {number} [courseTrack] 1–3; omit to use active vrknockout-game course. */
  function vkLoadGhostRuns(courseTrack) {
    var tr =
      courseTrack != null && courseTrack !== undefined
        ? vkNormalizeCourseTrack(courseTrack)
        : vkGetGhostRunsCourseTrack();
    try {
      return vkParseGhostRunsFromRaw(localStorage.getItem(vkGhostStorageKey(tr)));
    } catch (e) {
      return [];
    }
  }

  /** Ghost frames are recorded for a given lane rotation; bots must use matching runs or they never track the path. */
  function vkGhostRunsForSpawnRot(spawnRot, courseTrack) {
    var tr =
      courseTrack != null && courseTrack !== undefined
        ? vkNormalizeCourseTrack(courseTrack)
        : vkGetGhostRunsCourseTrack();
    var all = vkLoadGhostRuns(tr);
    var r = (spawnRot | 0) % 4;
    var out = [];
    var i;
    for (i = 0; i < all.length; i++) {
      var rec = all[i];
      if (!rec || !rec.frames) continue;
      var sr = rec.spawnRot != null ? rec.spawnRot | 0 : 0;
      if ((sr % 4) === r) out.push(rec);
    }
    return out;
  }

  function vkSaveGhostRuns(runs, courseTrack) {
    var tr =
      courseTrack != null && courseTrack !== undefined
        ? vkNormalizeCourseTrack(courseTrack)
        : vkGetGhostRunsCourseTrack();
    try {
      localStorage.setItem(vkGhostStorageKey(tr), JSON.stringify({ v: 3, runs: runs }));
    } catch (e) {}
  }

  function vkTryInsertGhostRun(run, courseTrack) {
    if (!run || !run.frames || run.frames.length < 12) return;
    var tr =
      courseTrack != null && courseTrack !== undefined
        ? vkNormalizeCourseTrack(courseTrack)
        : vkGetGhostRunsCourseTrack();
    var runs = vkLoadGhostRuns(tr);
    runs.push({
      durationMs: run.durationMs,
      spawnRot: run.spawnRot | 0,
      spawnLaneIdx: run.spawnLaneIdx != null ? (run.spawnLaneIdx | 0) % VK_SPAWN_LANE_COUNT : 0,
      frames: run.frames.slice()
    });
    runs.sort(function (a, b) {
      return (a.durationMs || 1e9) - (b.durationMs || 1e9);
    });
    if (runs.length > VK_GHOST_MAX_RUNS) runs.length = VK_GHOST_MAX_RUNS;
    vkSaveGhostRuns(runs, tr);
    try {
      var ckey = vkGhostTotalCommitsKey(tr);
      var tc = parseInt(localStorage.getItem(ckey), 10) || 0;
      localStorage.setItem(ckey, String(tc + 1));
    } catch (e2) {}
    try {
      var g = vkGetKnockoutGame();
      if (g && typeof g._vkRefreshLeaderboardPanels === 'function') g._vkRefreshLeaderboardPanels();
    } catch (e3) {}
  }

  var HOST_ID_PREFIX = 'vrknockout-host-';
  var VK_TURN_ENDPOINT = 'https://dotmination-turn-proxy.odd-bird-4c2c.workers.dev';
  var VK_MATCH_START_COUNTDOWN_MS = 4000;
  var VK_MATCH_DURATION_MS = 60 * 1000;
  /** Rise per unit −Z along ramp centerline — pillar rows use this; main ramp tilt = atan(grade) so they match. */
  var VK_RAMP_GRADE = 0.091;
  var VK_SLOPE_RAD = Math.atan(VK_RAMP_GRADE);
  /** Player ball radius (m) — doubled from first ball pass for Fall Guys scale. */
  var PLAYER_R = 0.09;
  /** Hazard boulders (~2× prior size vs player). */
  var ROCK_R = Math.max(0.11, PLAYER_R * 1.22);
  /**
   * Drive: right trigger thrust along carriage heading (_vkCarriageYawRad); left stick X only steers that yaw (cube).
   * Right-stick pitch/roll still apply Heli-style torque on the physics ball (auto-roll humans zero roll torque).
   */
  var VK_THRUST_FORWARD = 0.31875;
  var VK_THRUST_REVERSE_SCALE = 0.88;
  /** Left stick X → carriage yaw rate (rad/s) at full deflection. */
  var VK_CUBE_STICK_YAW_SPEED = 4.5;
  var VK_HELI_TORQUE_SCALE = 0.026;
  /** Base linear scale vs humans (1 = same VK_THRUST_FORWARD). */
  var VK_BOT_THRUST_SCALE = 1;
  var VK_BOT_TORQUE_SCALE = 1;
  /**
   * Extra forward thrust when the bot is moving slowly along thrust dir (“grunt”), tapering out by
   * VK_BOT_THRUST_TAPER_SPEED so cruise / max speed stay close to the human curve.
   */
  var VK_BOT_THRUST_GRUNT = 0.4;
  var VK_BOT_THRUST_TAPER_SPEED = 2.05;
  /** Same idea as VRLeague auto-roll: keep roof roughly level (right-stick pitch still torques the ball). */
  var VK_AUTO_ROLL_UP_KP = 0.036;
  var VK_AUTO_ROLL_UP_KD = 0.014;
  var VK_AUTO_ROLL_UP_MAX = 0.028;
  var VK_AUTO_ROLL_LEVEL_MIN_LEN_SQ = 0.00012;
  var BALL_MASS = 0.22;
  var BALL_LINEAR_DAMPING = 0.14;
  var BALL_ANGULAR_DAMPING = 0.15;
  var INPUT_HZ = 25;
  var SYNC_EVERY = 2;
  /** Pool size: each 2s wave releases 3 rocks; need headroom while earlier rocks roll. */
  var MAX_ROCKS = 24;
  var ROCK_MASS = 44;
  /** Host: each interval during countdown + race, spawn 3 rocks at the three gaps between the top 4-pillar row. */
  var ROCK_SPAWN_INTERVAL_MS = 2000;
  /** Top finish slab full thickness (matches `platVis` height); platform + arch lowered by this amount. */
  var VK_FINISH_PLATFORM_THICK = 0.22;
  /** Extra vertical offset for finish deck, collider, arch, and qualify Y (negative = lower). */
  var VK_FINISH_PLATFORM_Y_EXTRA = -0.1;
  /** Finish platform center Y after lowering (was 1.52). */
  var VK_FINISH_PLATFORM_CY = 1.52 - VK_FINISH_PLATFORM_THICK + VK_FINISH_PLATFORM_Y_EXTRA;
  /** Min ball Y to count as on the finish platform (was 1.22; tracks lowered slab). */
  var VK_FINISH_QUALIFY_MIN_Y = 1.22 - VK_FINISH_PLATFORM_THICK + VK_FINISH_PLATFORM_Y_EXTRA;
  /** Finish deck + detection line shift toward −Z (m), further from +Z start area. */
  var VK_FINISH_SHIFT_Z = -1.0;
  var VK_FINISH_PLATFORM_CENTER_Z = -5.65 + VK_FINISH_SHIFT_Z;
  var VK_FINISH_LINE_Z = -4.55 + VK_FINISH_SHIFT_Z;
  /** Lower Z bound for finish qualification band (was −7.75; moves with finish). */
  var VK_FINISH_CHECK_Z_MIN = -7.75 + VK_FINISH_SHIFT_Z;
  /** Leaderboard root Y (was 2.82); raised for readability. */
  var VK_LEADERBOARD_ROOT_Y = 2.82 + 2.0;
  /**
   * Hazard drop anchors (world X, Y, Z): just above the visible ramp / approach to the top platform (not sky-high).
   */
  var VK_FROZEN_ROCK_POS = [
    [-1.05, 1.48 - VK_FINISH_PLATFORM_THICK, -3.15 + VK_FINISH_SHIFT_Z],
    [1.02, 1.52 - VK_FINISH_PLATFORM_THICK, -3.28 + VK_FINISH_SHIFT_Z],
    [0.0, 1.56 - VK_FINISH_PLATFORM_THICK, -3.42 + VK_FINISH_SHIFT_Z],
    [-0.82, 1.6 - VK_FINISH_PLATFORM_THICK, -3.58 + VK_FINISH_SHIFT_Z],
    [0.78, 1.58 - VK_FINISH_PLATFORM_THICK, -3.72 + VK_FINISH_SHIFT_Z],
    [-0.04, 1.64 - VK_FINISH_PLATFORM_THICK, -3.88 + VK_FINISH_SHIFT_Z]
  ];
  var VK_SPEC = [
    { ox: -3.35, oz: 3.1, color: '#3388ff' },
    { ox: 3.35, oz: 3.1, color: '#ee3333' },
    { ox: -3.35, oz: -2.85, color: '#33ddcc' },
    { ox: 3.35, oz: -2.85, color: '#dd55cc' },
    { ox: 0, oz: 3.45, color: '#ffaa22' },
    { ox: -3.55, oz: 0.12, color: '#88ee44' },
    { ox: 3.55, oz: 0.12, color: '#aa66ff' },
    { ox: 0, oz: -3.15, color: '#ffcc00' }
  ];

  function vkDefaultIceServers() {
    return [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];
  }

  function vkGetIceServers() {
    return fetch(VK_TURN_ENDPOINT)
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .catch(function () {
        return null;
      })
      .then(function (json) {
        if (json && Array.isArray(json) && json.length) return json;
        return vkDefaultIceServers();
      });
  }

  function vkPeerOptions(iceServers) {
    return {
      host: '0.peerjs.com',
      port: 443,
      secure: true,
      config: { iceServers: iceServers }
    };
  }

  function vkCheckHostPeerIdAvailable(hostId) {
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

  window.__vkCheckHostPeerIdAvailable = vkCheckHostPeerIdAvailable;

  function vkHandEl(primaryId, fallbackId) {
    return document.getElementById(primaryId) || document.getElementById(fallbackId);
  }

  function vkGetCameraWorldPosition(sceneEl, out) {
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
      gripLVal: 0,
      gripRVal: 0,
      aEdge: 0,
      j: 0,
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

  /** Contestants: cars, inputs, snap, HUD (was 4). */
  var VK_MAX_SLOTS = 8;

  if (typeof window.createLobbyState !== 'function') {
    window.createLobbyState = function () {
      return {
        players: [],
        matchState: 'WAITING',
        matchStartTime: 0,
        matchScore: { blue: 0, red: 0 },
        matchPlayers: { blue: '', red: '' },
        queue: [],
        /** VRKnockout course 1–3; host authoritative in multiplayer. */
        vkCourseTrack: 1
      };
    };
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  /** Some runtimes put thumbstick on axes 0,1; others on 2,3 — pick the stronger deflection. */
  function vkPickStickX(axes) {
    if (!axes || !axes.length) return 0;
    var a0 = axes[0] || 0;
    var a2 = axes.length > 2 ? axes[2] || 0 : 0;
    return Math.abs(a0) >= Math.abs(a2) ? a0 : a2;
  }

  function vkPickStickY(axes) {
    if (!axes || !axes.length) return 0;
    var a1 = axes[1] || 0;
    var a3 = axes.length > 3 ? axes[3] || 0 : 0;
    return Math.abs(a1) >= Math.abs(a3) ? a1 : a3;
  }

  function vkMaxSignedMag(cur, nxt) {
    if (typeof nxt !== 'number' || !isFinite(nxt)) return cur;
    if (Math.abs(nxt) > Math.abs(cur)) return nxt;
    return cur;
  }

  /** Body cube half-extent (matches VRLeague CAR_HALF for LED plane sizing). */
  var VK_BODY_HALF = 0.04;
  /** Right-stick cage lean about the ball center (rad); max ±15°. */
  var VK_CUBE_LEAN_MAX_RAD = (15 * Math.PI) / 180;
  /** Per-frame smoothing toward stick target (0–1). */
  var VK_CUBE_LEAN_SMOOTH = 0.22;
  /**
   * Fraction of former right-stick heli torque still applied to the physics ball (rest is “spent” on cage lean).
   * Pure lean = 0; small value keeps a bit of ball twitch from the stick.
   */
  var VK_LEAN_RIGHTSTICK_BALL_TORQUE = 0.08;
  /**
   * When true, trigger thrust/reverse align with the tilted cage: the base thrust direction is rotated by the
   * same carriage-local lean (roll ∘ pitch about ball center) used for the mesh. Set false to keep thrust
   * purely carriage-yaw + uphill blend (lean cosmetic only).
   */
  var VK_THRUST_FOLLOWS_CAGE_LEAN = true;
  /**
   * Roll lean rotates about carriage-local +Z, which is parallel to the default “forward” thrust axis, so pure
   * rotation does not deflect that axis. This adds a small sideways component ∝ sin(roll) so left/right lean is
   * still felt in physics (bank → slight lateral push). Set 0 for strict “only rotate forward” behavior.
   */
  var VK_LEAN_ROLL_THRUST_LATERAL = 0.55;
  /**
   * Forward thrust (right trigger) multiplier from right-stick forward pitch only (not motion dynamic pitch —
   * dynamic surge pitch was cancelling stick lean and killed the bonus while accelerating). At full forward stick
   * (VK_CUBE_LEAN_MAX_RAD) boost ≈ this fraction (linear in lean). Flip VK_LEAN_FWD_PITCH_THRUST_SIGN if inverted.
   */
  var VK_LEAN_FWD_THRUST_BONUS = 0.38;
  var VK_LEAN_FWD_PITCH_THRUST_SIGN = 1;
  /** Absolute cap on |stick lean + motion lean| per axis (rad). */
  var VK_LEAN_COMBINED_MAX_RAD = (22 * Math.PI) / 180;
  /** Motion-induced cage roll: outward lean when yawing while moving along carriage forward (sign·yawRate·vFwd). */
  var VK_DYN_LEAN_MAX_ROLL = (12 * Math.PI) / 180;
  var VK_DYN_LEAN_MAX_PITCH = (9 * Math.PI) / 180;
  /** Scales yawRate(rad/s) × vFwd(m/s) → target roll (rad). */
  var VK_DYN_LEAN_YAW_V_GAIN = 0.1;
  /** +1 if left yaw should lean right; flip if lean feels inverted. */
  var VK_DYN_LEAN_YAW_ROLL_SIGN = 1;
  /** Longitudinal accel along carriage forward → pitch (brake / surge). */
  var VK_DYN_LEAN_ACCEL_PITCH_GAIN = 0.024;
  var VK_DYN_LEAN_SPRING = 58;
  var VK_DYN_LEAN_DAMP = 10;
  var VK_DYN_LEAN_ROLL_VEL_MAX = 3.2;
  var VK_DYN_LEAN_PITCH_VEL_MAX = 2.6;
  /** Ignore absurd yaw steps (e.g. snap glitches) when integrating motion lean on clients. */
  var VK_DYN_LEAN_YAW_RATE_CLAMP = 9;
  /**
   * Motorcycle-style steering: at high |yawCmd|×|vFwd|, carriage yaw rate is scaled down unless the cage rolls
   * *into* the turn (right stick + motion lean vs ideal inward roll). Good match → up to YAW_BONUS; poor → YAW_MIN.
   * Bots skip this (yaw scale = 1).
   */
  var VK_MOTO_INTENSITY_I0 = 0.38;
  var VK_MOTO_INTENSITY_IW = 2.65;
  /** Inward roll target magnitude vs outward reference (same sign basis as VK_DYN_LEAN_YAW_ROLL_SIGN path). */
  var VK_MOTO_IDEAL_INWARD_FACTOR = 1.08;
  /** Angular error (rad) at which “lean match” hits zero. */
  var VK_MOTO_LEAN_ERR_BAND_RAD = (12 * Math.PI) / 180;
  var VK_MOTO_YAW_MIN_MULT = 0.34;
  var VK_MOTO_YAW_BONUS_MAX = 1.22;
  var VK_MOTO_YAW_HARD_MIN = 0.26;
  var VK_MOTO_YAW_HARD_MAX = 1.3;

  /**
   * VR: smooth rig XZ follow — world +Z offset from ball (toward grid start / away from finish on this course).
   * Same X as ball (no yaw orbit); Z distance scales smoothly when carriage faces away from finish (see yaw dist).
   */
  var VK_CAM_FOLLOW_WORLD_DZ = 1.58;
  /** First-order lag (rad/s) on follow XZ; lower = smoother. */
  var VK_CAM_FOLLOW_POS_HZ = 1.75;
  /** Grip squeeze above this (0–1) counts as “pressed” for jump; below `VK_GRIP_JUMP_RELEASE` clears latch. */
  var VK_GRIP_JUMP_PRESS = 0.52;
  var VK_GRIP_JUMP_RELEASE = 0.28;
  /** If angle between carriage forward and ball→finish exceeds this (rad), start backing the camera up (60°). */
  var VK_CAM_FOLLOW_YAW_DIST_MIN_RAD = (60 * Math.PI) / 180;
  /** Z offset multiplier at 180° misalignment vs finish (1 = no extra at ≤60°). */
  var VK_CAM_FOLLOW_YAW_DIST_MAX_MULT = 1.82;
  /** Lag on the distance multiplier so pull-back eases in/out without snapping. */
  var VK_CAM_FOLLOW_DIST_MUL_HZ = 2.35;
  /** First-order lag (rad/s) on rig Y follow from car height (separate from XZ). */
  var VK_CAM_FOLLOW_POS_Y_HZ = 2.05;
  /** If |car vertical speed| exceeds this (m/s), hold Y target — skips jump / air spikes, still follows slow terrain. */
  var VK_CAM_FOLLOW_Y_AIR_VY = 1.02;

  var VK_LED_IDLE_ROWS = [
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
  var VK_LED_TONGUE_ROWS = [
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
  var VK_LED_IMPACT_ROWS = [
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
  var VK_LED_FACE_COLS = 16;
  var VK_LED_FACE_ROWS = 19;
  var VK_LED_IDLE_ROWS_PADDED = VK_LED_IDLE_ROWS.concat([
    '0000000000000000',
    '0000000000000000',
    '0000000000000000'
  ]);
  var VK_LED_GRID_COLS = 24;
  var VK_LED_GRID_ROWS = VK_LED_FACE_ROWS + (VK_LED_GRID_COLS - VK_LED_FACE_COLS);
  var VK_LED_FACE_OX = (VK_LED_GRID_COLS - VK_LED_FACE_COLS) >> 1;
  var VK_LED_FACE_OY = (VK_LED_GRID_ROWS - VK_LED_FACE_ROWS) >> 1;

  function vkDrawLedFace(ctx, w, h, mode, onColor) {
    ctx.imageSmoothingEnabled = false;
    var cols = VK_LED_GRID_COLS;
    var rows = VK_LED_GRID_ROWS;
    var cell = Math.min(w / cols, h / rows);
    var ox = (w - cell * cols) * 0.5;
    var oy = (h - cell * rows) * 0.5;
    var gutter = Math.max(1, Math.round(cell * 0.12));
    var pxw = Math.max(1, Math.floor(cell - gutter));
    var OFF = '#ffffff';
    var ON = onColor || '#888888';
    var DIM = '#ffffff';
    var bitmap =
      mode === 'hit' ? VK_LED_IMPACT_ROWS : mode === 'tongue' ? VK_LED_TONGUE_ROWS : VK_LED_IDLE_ROWS_PADDED;
    var gx;
    var gy;
    var fgx;
    var fgy;
    var rowStr;
    ctx.fillStyle = OFF;
    ctx.fillRect(0, 0, w, h);
    for (gy = 0; gy < rows; gy++) {
      for (gx = 0; gx < cols; gx++) {
        fgx = gx - VK_LED_FACE_OX;
        fgy = gy - VK_LED_FACE_OY;
        if (fgx >= 0 && fgx < VK_LED_FACE_COLS && fgy >= 0 && fgy < VK_LED_FACE_ROWS) {
          rowStr = bitmap[fgy] || '';
          ctx.fillStyle = rowStr.charAt(fgx) === '1' ? ON : DIM;
        } else {
          ctx.fillStyle = DIM;
        }
        ctx.fillRect(Math.floor(ox + gx * cell), Math.floor(oy + gy * cell), pxw, pxw);
      }
    }
  }

  /** 12 vertices of icosahedron on unit sphere — classic soccer black pentagon centers. */
  function vkSoccerIcosahedronVertsNormalized() {
    var phi = (1 + Math.sqrt(5)) / 2;
    var v = [
      [0, 1, phi],
      [0, 1, -phi],
      [0, -1, phi],
      [0, -1, -phi],
      [1, phi, 0],
      [1, -phi, 0],
      [-1, phi, 0],
      [-1, -phi, 0],
      [phi, 0, 1],
      [phi, 0, -1],
      [-phi, 0, 1],
      [-phi, 0, -1]
    ];
    var out = [];
    var i;
    for (i = 0; i < v.length; i++) {
      var x = v[i][0];
      var y = v[i][1];
      var z = v[i][2];
      var L = Math.sqrt(x * x + y * y + z * z);
      out.push([x / L, y / L, z / L]);
    }
    return out;
  }

  function vkCanvasDrawPentagon(ctx, cx, cy, rPx, fillStyle, strokeStyle, lineW) {
    ctx.beginPath();
    var k;
    for (k = 0; k < 5; k++) {
      var a = -Math.PI / 2 + k * ((2 * Math.PI) / 5);
      var px = cx + rPx * Math.cos(a);
      var py = cy + rPx * Math.sin(a);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    if (fillStyle) {
      ctx.fillStyle = fillStyle;
      ctx.fill();
    }
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineW || 2;
      ctx.stroke();
    }
  }

  /** Equirectangular-style UV map for SphereGeometry: high-contrast pentagons so roll reads clearly. */
  function vkCreateSoccerBallTexture(THREE) {
    var w = 1536;
    var h = 768;
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f2f2f0';
    ctx.fillRect(0, 0, w, h);
    var verts = vkSoccerIcosahedronVertsNormalized();
    var rPx = 50;
    var j;
    for (j = 0; j < verts.length; j++) {
      var p = verts[j];
      var lon = Math.atan2(p[2], p[0]);
      var lat = Math.asin(Math.max(-1, Math.min(1, p[1])));
      var u = 0.5 + lon / (2 * Math.PI);
      var v = 0.5 - lat / Math.PI;
      var cx = u * w;
      var cy = v * h;
      vkCanvasDrawPentagon(ctx, cx, cy, rPx, 'rgba(22,22,24,0.94)', '#080808', 2.5);
      if (cx < rPx + 10) {
        vkCanvasDrawPentagon(ctx, cx + w, cy, rPx, 'rgba(22,22,24,0.94)', '#080808', 2.5);
      }
      if (cx > w - rPx - 10) {
        vkCanvasDrawPentagon(ctx, cx - w, cy, rPx, 'rgba(22,22,24,0.94)', '#080808', 2.5);
      }
    }
    var tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  function vkCreateCarLedFace(THREE, half, bodyColorHex) {
    var W = VK_LED_GRID_COLS * 4;
    var H = VK_LED_GRID_ROWS * 4;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    var onHex = bodyColorHex || '#888888';
    vkDrawLedFace(ctx, W, H, 'neutral', onHex);
    var tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    var face = half * 2 - 0.006;
    var geo = new THREE.PlaneGeometry(face, face);
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
    pivot.name = 'vkLedPivot';
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

  AFRAME.registerComponent('vrknockout-game', {
    schema: {
      lobby: { type: 'int', default: 1 },
      /** 1 = ramp+plinko+rocks. 2 = spinners. 3 = sliding square tiles (flat, no rocks). */
      track: { type: 'int', default: 1 }
    },

    init: function () {
      this.world = new CANNON.World();
      this.world.gravity.set(0, -9.82, 0);
      this.world.broadphase = new CANNON.NaiveBroadphase();
      this.world.solver.iterations = 32;
      this.world.allowSleep = false;
      if (this.world.defaultContactMaterial) {
        this.world.defaultContactMaterial.friction = 0.35;
        this.world.defaultContactMaterial.restitution = 0.05;
      }

      this.defaultMat = new CANNON.Material('vkdef');
      this.floorMat = new CANNON.Material('vkfloor');
      this.carMat = new CANNON.Material('vkcar');
      this.rockMat = new CANNON.Material('vkrock');
      /* Track 2 spinners: lower friction so thrust can overcome rim drag when driving counter to ω×r. */
      this.spinnerMat = new CANNON.Material('vkspin');
      /* Ball–surface: enough friction to couple roll torque into motion; moderate bounce. */
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.carMat, this.floorMat, { friction: 0.36, restitution: 0.32 }));
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.carMat, this.defaultMat, { friction: 0.38, restitution: 0.34 }));
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.carMat, this.spinnerMat, { friction: 0.14, restitution: 0.34 }));
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.carMat, this.carMat, { friction: 0.05, restitution: 0.55 }));
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.rockMat, this.floorMat, { friction: 0.35, restitution: 0.55 }));
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.rockMat, this.carMat, { friction: 0.42, restitution: 0.35 }));
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.rockMat, this.rockMat, { friction: 0.28, restitution: 0.5 }));

      this.isHost = false;
      this.peer = null;
      this.hostConn = null;
      this.clientConns = [];
      this.mySlot = 0;
      this.inputs = [];
      for (var ii = 0; ii < VK_MAX_SLOTS; ii++) this.inputs.push(zeroInput());
      this.lastInputSend = 0;
      this._vkPendingAEdge = 0;
      this._vkPendingJ = 0;
      this._vkPendingBJumpEdge = false;
      this._vkRightAPressEdge = false;
      this._vkPrevA = false;
      this._vkPrevRkey = false;
      this._vkPrevBKeyDesk = false;
      this._vkPrevBGamepadXR = false;
      this._vkOnAbuttondown = null;
      this._vkOnBbuttondown = null;
      this._vkRightAHandlersBound = false;
      this._vkRightBHandlersBound = false;
      this._vkRightHandAHook = null;
      this._vkRightHandBHook = null;
      this._vkJumpNextMs = [];
      this._vkGrounded = [];
      this._vkFinished = [];
      for (var ii = 0; ii < VK_MAX_SLOTS; ii++) {
        this._vkJumpNextMs.push(0);
        this._vkGrounded.push(0);
        this._vkFinished.push(false);
      }
      this._vkFinishOrder = [];
      this.frame = 0;
      this.carBodies = [];
      this.carEls = [];
      this._vkCarLed = [];
      this._vkLedCamPos = new THREE.Vector3();
      this._vkLedCamsBuf = [];
      /** Per slot: last horizontal yaw used when forward is ill-defined (carriage stays stable). */
      this._vkCarriageYawRad = [];
      /** Smoothed cage lean (rad) about ball center: pitch X, roll Z in carriage-local axes. */
      this._vkCubeLeanPitchSn = [];
      this._vkCubeLeanRollSn = [];
      /** Spring state: motion-induced lean (rad) from yaw×speed and longitudinal accel; settles when forces ease. */
      this._vkLeanDynRoll = [];
      this._vkLeanDynRollVel = [];
      this._vkLeanDynPitch = [];
      this._vkLeanDynPitchVel = [];
      this._vkDynLeanYawPrev = [];
      this._vkDynLeanPrevVFwd = [];
      for (var i2 = 0; i2 < VK_MAX_SLOTS; i2++) {
        this._vkCarriageYawRad.push(0);
        this._vkCubeLeanPitchSn.push(0);
        this._vkCubeLeanRollSn.push(0);
        this._vkLeanDynRoll.push(0);
        this._vkLeanDynRollVel.push(0);
        this._vkLeanDynPitch.push(0);
        this._vkLeanDynPitchVel.push(0);
        this._vkDynLeanYawPrev.push(0);
        this._vkDynLeanPrevVFwd.push(0);
      }
      this._vkCubeLeanPivotEls = [];
      this._vkLeanQPitch = new THREE.Quaternion();
      this._vkLeanQRoll = new THREE.Quaternion();
      this._vkLeanQComb = new THREE.Quaternion();
      this._vkLeanAxisX = new THREE.Vector3(1, 0, 0);
      this._vkLeanAxisZ = new THREE.Vector3(0, 0, 1);
      this._vkCarriageQ = new THREE.Quaternion();
      this._vkCarriageQInv = new THREE.Quaternion();
      this._vkBallMeshQ = new THREE.Quaternion();
      this._vkWorldUp = new THREE.Vector3(0, 1, 0);
      this._vkThrustDir = new THREE.Vector3();
      this._carSpawn = [];
      this.rockBodies = [];
      this.rockEls = [];
      this._vkSoccerRockTex = null;
      this._vkRockSpawnNext = 0;
      this._vkPlinkoGapXs = null;
      this._vkPlinkoRockSpawnZ = null;
      this._vkPlinkoRockSpawnDzJitter = 0;
      /** Per slot: remaining ms to show impact LED face (host sets on collide; replicated in snap). */
      this._vkLedHitRemainMs = [];
      for (var i3 = 0; i3 < VK_MAX_SLOTS; i3++) this._vkLedHitRemainMs.push(0);
      this.staticBodies = [];
      this.vkMatchActive = false;
      this.vkMatchStartMs = 0;
      this._vkMatchCountdownT0 = 0;
      this.vkMatchRemainSec = null;
      this._vkClientMatchPreStart = false;
      this._vkLastHudEmit = 0;
      this._vkHudDirty = true;
      this._vkLastCountdownSec = -999;
      this._vkClientCountBeepRem = -999;
      this._vkGoFlashUntil = 0;
      this._vkFinishFxHideTimer = null;
      this._vkFinishFxWrap = null;
      this._vkFinishFxMainText = null;
      this._vkFinishFxSubText = null;
      this._vkFinishFxSparkEls = null;
      /** Per-spark ballistic state while finish celebration is visible (see `_vkTickFinishFxSparks`). */
      this._vkFinishFxSparkState = null;
      /** World XZ + avoid radius for pink pillars — bots steer around these. */
      this._vkPillarAvoidPts = [];
      /** Track 1 plinko: mid-gap XZ bands (void between pillars) — lateral dodge + jump suppress. */
      this._vkPlinkoGapAvoidPts = [];
      this._vkLaneCols = null;
      this._vkLaneSlotZ = null;
      this._vkSpawnPhysY = 0;
      this._vkSpawnBaseZ = 0;
      this._vkMatchSpawnRot = 0;
      /** Per car slot: which of VK_SPAWN_LANE_COUNT start lanes this match (host picks; replicated for visuals). */
      this._vkSlotSpawnLaneIdx = [0, 1, 2, 3, 8, 9, 10, 11];
      this._vkGhostRecBuf = null;
      this._vkGhostLastSample = 0;
      /** Host: per human slot, sampled trajectory for ghost library + live spine handoff (see `_vkGhostRecordTickAfterPhysics`). */
      this._vkGhostRecBufBySlot = [];
      for (var ig = 0; ig < VK_MAX_SLOTS; ig++) this._vkGhostRecBufBySlot.push(null);
      this._vkSessionGhostRuns = [];
      this._vkSpineHudDebug = false;
      /** Host: THREE.Line showing one bot’s ghost path in world space (see `_vkTickSpineGuideLine`). */
      this._vkSpineGuide = null;
      this._vkSpineGuideLastRebuild = 0;
      this._vkSpineGuideLastRec = null;
      try {
        if (localStorage.getItem('vrknockout-debug-spine') === '1') this._vkSpineHudDebug = true;
      } catch (eLsSp) {}
      try {
        var qsu =
          typeof window !== 'undefined' &&
          window.location &&
          typeof window.location.search === 'string'
            ? window.location.search
            : '';
        if (/\bvkSpine=1\b/i.test(qsu)) this._vkSpineHudDebug = true;
      } catch (eSp) {}
      this._vkBotGhost = [];
      for (var i4 = 0; i4 < VK_MAX_SLOTS; i4++) this._vkBotGhost.push(null);
      /** Bot: best uphill progress (m) from spawn along _vkUphill; _vkBotHillProgAt = last time that improved. */
      this._vkBotBestHill = [];
      this._vkBotHillProgAt = [];
      for (var i5 = 0; i5 < VK_MAX_SLOTS; i5++) {
        this._vkBotBestHill.push(0);
        this._vkBotHillProgAt.push(0);
      }
      this._vkLeaderboardRoot = null;
      this._vkLeaderboardAllTimeEl = null;
      this._vkLeaderboardMatchEl = null;
      /** Start grid: one marker per logical lane 0–15 (ring + infill). */
      this._vkLaneMarkersRoot = null;
      this._vkLaneMarkers = null;
      /** Host + snap-fed: display name per slot (max ~16 chars). */
      this._vkSlotDisplayNames = [];
      for (var inm = 0; inm < VK_MAX_SLOTS; inm++) this._vkSlotDisplayNames.push('Player ' + (inm + 1));
      /** Current race finish rows: { slot, ms } in finish order; display sorted by ms. */
      this._vkRoundFinishes = [];
      this.statusEl = document.getElementById('vk-status');
      this.scoreEl = document.getElementById('vk-score');
      this.tmpVec = new THREE.Vector3();
      this.tmpVec2 = new THREE.Vector3();
      this._tmpQ = new THREE.Quaternion();
      this._vkGatherLp = new THREE.Vector3();
      this._vkGatherRp = new THREE.Vector3();
      this._vkGatherLq = new THREE.Quaternion();
      this._vkGatherRq = new THREE.Quaternion();
      this.keys = {};
      /* Finish plane on top platform (see VK_FINISH_LINE_Z / VK_FINISH_PLATFORM_CENTER_Z). */
      this._vkFinishZ = VK_FINISH_LINE_Z;
      this._vkSpawnZ = 4.05;
      this._vkRampQuat = new THREE.Quaternion();
      this._vkRampNormal = new THREE.Vector3();
      this._vkPathHalfX = 2.35;
      this._vkUphill = new THREE.Vector3(0, 0, -1);
      this._vkRollAxis = new THREE.Vector3(1, 0, 0);
      this._vkHandBindIv = null;
      this._vkXrSessionBound = false;
      this._vkSessionStartHandler = null;
      /** RTSVR2-style grip pan: rig-local hand delta, ref updates each frame (see RTSVR2/js/input.js applyGripPan). */
      this._vkGripPanLInited = false;
      this._vkGripPanRInited = false;
      this._vkGripJumpLatchedL = false;
      this._vkGripJumpLatchedR = false;
      this._vkGripHandLocal = new THREE.Vector3();
      this._vkGripRefL = new THREE.Vector3();
      this._vkGripRefR = new THREE.Vector3();
      this._vkGripLocalDelta = new THREE.Vector3();
      this._vkGripWorldDelta = new THREE.Vector3();
      /** Two-hand: separation → rig Y, twist → vl-spect-yaw. */
      this._vkTwoHand = null;
      /** Smoothed rig XZ for VR follow-behind-car; Y follows car delta with jump gate (grip no longer moves rig). */
      this._vkFollowSmX = 0;
      this._vkFollowSmZ = 0;
      this._vkFollowSmY = 0;
      /** Car / rig world Y at last anchor — rig Y tracks rigBase + (carY - carBase) while grounded. */
      this._vkFollowCarYBase = null;
      this._vkFollowRigYBase = 0;
      /** Smoothed Z-distance multiplier when facing away from finish (1 = baseline). */
      this._vkFollowDistMulSn = 1;
      /** Track 2: CANNON.Quaternion scratch for bar pose (see _vkTickTrack2Spinners). */
      this._vkT2BarQy = null;
      this._vkT2BarQMul = null;

      this._vkCourseTrack = 1;
      this._vkSpinnerBodies = [];
      this._vkT3SliderBodies = [];
      this._vkFinishQualifyMinY = null;
      this._vkFinishQualifyMaxY = null;
      this._vkFinishQualifyHalfX = null;
      this._vkFinishCheckZMin = null;
      {
        var trInit = this.data.track | 0;
        if (trInit !== 1 && trInit !== 2 && trInit !== 3) trInit = 1;
        if (trInit === 1) {
          try {
            var lsTr = localStorage.getItem('vrknockout-course-track');
            if (lsTr === '3') trInit = 3;
            else if (lsTr === '2') trInit = 2;
            else if (lsTr === '1') trInit = 1;
          } catch (eTrk) {}
        }
        this._vkCourseTrack = vkNormalizeCourseTrack(trInit);
      }

      this._buildCourse();
      this._rig = document.getElementById('vr-rig');
      this._rigYaw = document.getElementById('vl-spect-yaw') || this._rig;
      this._applySpectatorTransform(0);

      var self = this;
      var sceneEl = this.el.sceneEl || this.el;
      function vkOnEnterVr() {
        self._vkScheduleHandBindRetries();
        self._applySpectatorTransform(self.mySlot);
      }
      sceneEl.addEventListener('enter-vr', vkOnEnterVr);
      this._vkOnEnterVrRef = vkOnEnterVr;
      function vkBindSessionReseat() {
        var xr = sceneEl.renderer && sceneEl.renderer.xr;
        if (xr && !self._vkXrSessionBound) {
          self._vkXrSessionBound = true;
          self._vkSessionStartHandler = function () {
            self._vkScheduleHandBindRetries();
            self._applySpectatorTransform(self.mySlot);
          };
          xr.addEventListener('sessionstart', self._vkSessionStartHandler);
        }
      }
      if (sceneEl.hasLoaded) {
        vkBindSessionReseat();
        self._vkScheduleHandBindRetries();
      } else {
        sceneEl.addEventListener('loaded', function onLd() {
          sceneEl.removeEventListener('loaded', onLd);
          vkBindSessionReseat();
          self._vkScheduleHandBindRetries();
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

    _vkMarkHudDirty: function () {
      this._vkHudDirty = true;
    },

    _vkFormatClock: function (totalSec) {
      if (totalSec == null || !isFinite(totalSec)) return '--:--';
      var s = Math.max(0, Math.floor(totalSec));
      var m = Math.floor(s / 60);
      var r = s % 60;
      return m + ':' + (r < 10 ? '0' : '') + r;
    },

    _vkPumpHud: function (now) {
      var ghostHudStrEarly = null;
      if (this.isHost && this.vkMatchActive) {
        var tbE = 0;
        var wgh = 0;
        var wgE;
        for (wgE = 0; wgE < VK_MAX_SLOTS; wgE++) {
          if (this._vkIsHumanOccupyingSlot(wgE)) continue;
          tbE++;
          var GGe = this._vkBotGhost && this._vkBotGhost[wgE];
          if (GGe && GGe.rec && GGe.rec.frames && GGe.rec.frames.length >= 12) wgh++;
        }
        if (tbE > 0) ghostHudStrEarly = wgh + '/' + tbE;
      }
      var spineFast = !!(
        this.isHost &&
        this.vkMatchActive &&
        (this._vkSpineHudDebug || (ghostHudStrEarly && this.vkMatchStartMs))
      );
      if (!this._vkHudDirty && now - this._vkLastHudEmit < 220 && !spineFast) return;
      this._vkLastHudEmit = now;
      this._vkHudDirty = false;
      var remSec = null;
      var preStart = false;
      if (this.vkMatchActive) {
        if (this.isHost) {
          if (this.vkMatchStartMs) {
            remSec = Math.max(0, Math.ceil((VK_MATCH_DURATION_MS - (now - this.vkMatchStartMs)) / 1000));
          } else {
            preStart = true;
            remSec = Math.max(0, Math.ceil((VK_MATCH_START_COUNTDOWN_MS - (now - this._vkMatchCountdownT0)) / 1000));
          }
        } else if (typeof this.vkMatchRemainSec === 'number' && isFinite(this.vkMatchRemainSec)) {
          remSec = Math.max(0, Math.floor(this.vkMatchRemainSec));
          preStart = !!this._vkClientMatchPreStart;
        }
      }
      var q = 0;
      var qi;
      for (qi = 0; qi < VK_MAX_SLOTS; qi++) {
        if (this._vkFinished[qi]) q++;
      }
      if (!this.isHost && preStart && remSec != null) {
        if (remSec !== this._vkClientCountBeepRem && remSec > 0) {
          this._vkClientCountBeepRem = remSec;
          var sonC = document.getElementById('vl-pu-sonar-sound');
          if (sonC && sonC.components && sonC.components.sound) sonC.components.sound.playSound();
        }
      } else if (!preStart) {
        this._vkClientCountBeepRem = -999;
      }
      var tail =
        !this.vkMatchActive || remSec == null
          ? '--:--'
          : preStart
            ? 'GO in ' + remSec + '…'
            : this._vkFormatClock(remSec);
      var ghostHudStr = ghostHudStrEarly;
      var line =
        'Qualified ' + q + '/' + VK_MAX_SLOTS + '   |   ' + tail + (ghostHudStr ? '   ·   ghosts ' + ghostHudStr : '');
      if (this.scoreEl) this.scoreEl.textContent = line;
      var menuLine = document.getElementById('menu-vk-scoreboard');
      if (menuLine) menuLine.setAttribute('text', 'value', line);
      var hudLine = document.getElementById('vk-hud-scoreboard');
      if (hudLine) hudLine.setAttribute('text', 'value', line);
      var clockNow = typeof performance !== 'undefined' && performance.now ? performance.now() : now;
      var cdBig = document.getElementById('vk-hud-countdown-big');
      if (cdBig) {
        if (preStart && remSec != null) {
          cdBig.setAttribute('visible', true);
          cdBig.setAttribute('text', 'value', String(Math.max(1, remSec)));
        } else if (this._vkGoFlashUntil && clockNow < this._vkGoFlashUntil) {
          cdBig.setAttribute('visible', true);
          cdBig.setAttribute('text', 'value', 'GO!');
        } else {
          cdBig.setAttribute('visible', false);
          if (this._vkGoFlashUntil && clockNow >= this._vkGoFlashUntil) this._vkGoFlashUntil = 0;
        }
      }
      window.__vlHud = {
        matchActive: !!this.vkMatchActive,
        matchRemainSec: remSec,
        matchPreStart: preStart,
        blue: q,
        red: VK_MAX_SLOTS - q,
        vkBotGhosts: ghostHudStr
      };
      var spineDbg = document.getElementById('vk-spine-debug');
      if (spineDbg) {
        var spineDbgOn =
          this.isHost &&
          this.vkMatchActive &&
          (this._vkSpineHudDebug || (ghostHudStr && this.vkMatchStartMs));
        if (spineDbgOn) {
          var parts = [];
          var sb;
          for (sb = 0; sb < VK_MAX_SLOTS; sb++) {
            if (this._vkIsHumanOccupyingSlot(sb)) continue;
            var Gb = this._vkBotGhost && this._vkBotGhost[sb];
            if (!Gb || !Gb.rec || !Gb.rec.frames || !Gb.rec.frames.length) {
              parts.push('B' + (sb + 1) + ':—');
              continue;
            }
            var src = Gb.spineSrc || 'lib';
            var frn = Gb.rec.frames.length;
            parts.push('B' + (sb + 1) + ':' + src + '(' + frn + ')');
          }
          spineDbg.textContent = parts.join('  ');
          spineDbg.style.display = parts.length ? 'block' : 'none';
        } else {
          spineDbg.textContent = '';
          spineDbg.style.display = 'none';
        }
      }
      var scene = this.el.sceneEl;
      if (scene) scene.emit('vl-hud-update');
    },

    _vkBroadcastMatchSync: function (opts) {
      if (!this.isHost || !this.peer || !this.peer.open) return;
      opts = opts || {};
      var now = performance.now();
      var remSec = null;
      var preStart = false;
      if (this.vkMatchActive) {
        if (this.vkMatchStartMs) {
          remSec = Math.max(0, Math.ceil((VK_MATCH_DURATION_MS - (now - this.vkMatchStartMs)) / 1000));
        } else {
          preStart = true;
          remSec = Math.max(0, Math.ceil((VK_MATCH_START_COUNTDOWN_MS - (now - this._vkMatchCountdownT0)) / 1000));
        }
      }
      var pack = {
        type: 'vl-match-sync',
        active: !!this.vkMatchActive,
        score0: 0,
        score1: 0,
        remSec: remSec,
        vlPreStart: preStart
      };
      if (this._vkSlotSpawnLaneIdx && this._vkSlotSpawnLaneIdx.length === VK_MAX_SLOTS) {
        pack.vkSpawnLanes = this._vkSlotSpawnLaneIdx.slice();
      }
      if (opts.endBanner) pack.endBanner = opts.endBanner;
      for (var i = 0; i < this.clientConns.length; i++) {
        var c = this.clientConns[i];
        if (c && c.open) c.send(pack);
      }
    },

    _vkBroadcastSnapToClients: function () {
      if (!this.isHost || !this.clientConns || !this.clientConns.length) return;
      var snap = this._serializeSnap();
      var j;
      for (j = 0; j < this.clientConns.length; j++) {
        var cc = this.clientConns[j];
        if (cc && cc.open) cc.send({ type: 'snap', data: snap });
      }
    },

    /**
     * Remove arena visuals and all course-related physics bodies so `_buildCourse` can run again.
     */
    _vkTeardownCourse: function () {
      var w = this.world;
      var i;
      this._vkDisposeSpineGuideLine();
      this._vkStopFinishFxCelebration();
      if (this.carBodies && this.carBodies.length) {
        for (i = 0; i < this.carBodies.length; i++) {
          var cb = this.carBodies[i];
          if (cb && w && w.bodies.indexOf(cb) !== -1) w.removeBody(cb);
        }
      }
      this.carBodies = [];
      this.carEls = [];
      this._vkCubeLeanPivotEls = [];
      this._vkCarLed = [];
      if (this.rockBodies && this.rockBodies.length) {
        for (i = 0; i < this.rockBodies.length; i++) {
          var rb = this.rockBodies[i];
          if (rb && w && w.bodies.indexOf(rb) !== -1) w.removeBody(rb);
        }
      }
      this.rockBodies = [];
      this.rockEls = [];
      this._vkRockIdleMs = [];
      this._vkRockActive = [];
      if (this.staticBodies && this.staticBodies.length) {
        for (i = 0; i < this.staticBodies.length; i++) {
          var sb = this.staticBodies[i];
          if (sb && w && w.bodies.indexOf(sb) !== -1) w.removeBody(sb);
        }
      }
      this.staticBodies = [];
      if (this._vkSpinnerBodies) this._vkSpinnerBodies.length = 0;
      if (this._vkT3SliderBodies) this._vkT3SliderBodies.length = 0;
      this._vkLaneMarkersRoot = null;
      this._vkLaneMarkers = null;
      this._vkLeaderboardRoot = null;
      this._vkLeaderboardAllTimeEl = null;
      this._vkLeaderboardMatchEl = null;
      this._vkFinishFxWrap = null;
      this._vkFinishFxMainText = null;
      this._vkFinishFxSubText = null;
      this._vkFinishFxSparkEls = null;
      this._vkFinishFxSparkState = null;
      if (this._arenaRoot && this._arenaRoot.parentNode) {
        try {
          this._arenaRoot.parentNode.removeChild(this._arenaRoot);
        } catch (eRm) {}
      }
      this._arenaRoot = null;
    },

    /**
     * Replace the playable course (teardown + build + round reset). Host and clients use the same path.
     */
    _vkApplyCourseTrack: function (track) {
      var t = vkNormalizeCourseTrack(track);
      this._vkTeardownCourse();
      this._vkCourseTrack = t;
      try {
        localStorage.setItem('vrknockout-course-track', String(t));
      } catch (eLs) {}
      if (this.el && this.el.setAttribute) {
        this.el.setAttribute('vrknockout-game', 'track', t);
      }
      this._buildCourse();
      this._resetRoundBodies();
      this._vkGhostRecBuf = null;
      this._vkSessionGhostRuns = [];
      if (this._vkGhostRecBufBySlot) {
        var gx;
        for (gx = 0; gx < this._vkGhostRecBufBySlot.length; gx++) this._vkGhostRecBufBySlot[gx] = null;
      }
      this._vkRoundFinishes = [];
      this._vkFinishOrder = [];
      if (this._vkFinished) {
        for (var fi = 0; fi < VK_MAX_SLOTS; fi++) this._vkFinished[fi] = false;
      }
      this._vkRefreshMatchResultsPanel();
      if (this.isHost) this._vkAssignBotGhosts();
      this._refreshCubeHighlights();
      this._vkMarkHudDirty();
      this._applySpectatorTransform(this.mySlot);
    },

    /** Menu: wrap prev/next to cycle 1 → 2 → 3. Host/solo only (clients follow lobby). */
    vkCycleMenuCourse: function (delta) {
      var cur = this._vkCourseTrack | 0;
      var idx = cur - 1 + (delta | 0);
      idx = ((idx % 3) + 3) % 3;
      this.vkHostSetCourseTrack(idx + 1);
    },

    /**
     * Host or solo: change course, stop any active match, sync lobby + physics snapshot to clients.
     */
    vkHostSetCourseTrack: function (track) {
      if (!this.isHost) return;
      var t = vkNormalizeCourseTrack(track);
      if ((this._vkCourseTrack | 0) === t && this._arenaRoot) {
        this._vkBroadcastLobbyToClients();
        this._vkBroadcastSnapToClients();
        return;
      }
      if (this.vkMatchActive) {
        this.vkEndMatch('Course changed — match stopped.');
      } else {
        this._vkStopFinishFxCelebration();
      }
      this._vkApplyCourseTrack(t);
      this._vkBroadcastLobbyToClients();
      this._vkBroadcastMatchSync();
      this._vkBroadcastSnapToClients();
      this._vkEmitLobbyUpdated();
      var lab = t === 3 ? 'Track 3 (sliding tiles)' : t === 2 ? 'Track 2 (spinners)' : 'Track 1 (ramp)';
      this._setStatus('Course: ' + lab);
    },

    _buildCourse: function () {
      var scene = this.el;
      var w = this;
      var root = document.createElement('a-entity');
      root.setAttribute('id', 'vk-arena-root');
      root.setAttribute('position', '0 0 0');
      scene.appendChild(root);
      this._arenaRoot = root;

      var courseTrack = vkNormalizeCourseTrack(w._vkCourseTrack);
      w._vkCourseTrack = courseTrack;
      w._vkFinishQualifyMinY = null;
      w._vkFinishQualifyMaxY = null;
      w._vkFinishQualifyHalfX = null;
      w._vkFinishCheckZMin = null;
      if (!w._vkSpinnerBodies) w._vkSpinnerBodies = [];
      else w._vkSpinnerBodies.length = 0;
      if (!w._vkT3SliderBodies) w._vkT3SliderBodies = [];
      else w._vkT3SliderBodies.length = 0;

      if (courseTrack === 1) {
        /* +X rotation: ramp rises toward −Z (finish); low end at +Z where contestants + rocks start. */
        this._vkRampQuat.setFromEuler(new THREE.Euler(VK_SLOPE_RAD, 0, 0, 'XYZ'));
        this._vkRampNormal.set(0, 1, 0).applyQuaternion(this._vkRampQuat).normalize();
        {
          var grav = new THREE.Vector3(0, -1, 0);
          var nrm = this._vkRampNormal.clone();
          var gPar = grav.clone().sub(nrm.multiplyScalar(grav.dot(nrm)));
          if (gPar.lengthSq() < 1e-12) {
            this._vkUphill.set(0, 0, -1);
          } else {
            gPar.normalize();
            this._vkUphill.copy(gPar).multiplyScalar(-1).normalize();
          }
          this._vkRollAxis.copy(this._vkUphill).cross(new THREE.Vector3(0, 1, 0));
          if (this._vkRollAxis.lengthSq() < 1e-12) this._vkRollAxis.set(1, 0, 0);
          else this._vkRollAxis.normalize();
        }
      } else {
        /* Tracks 2–3: flat deck — race direction still −Z; thrust rolls like track 1. */
        this._vkRampQuat.set(0, 0, 0, 1);
        this._vkRampNormal.set(0, 1, 0);
        this._vkUphill.set(0, 0, -1);
        this._vkRollAxis.set(1, 0, 0);
      }

      function addStaticBox(hx, hy, hz, px, py, pz, qx, qy, qz, qw, mat) {
        var sh = new CANNON.Box(new CANNON.Vec3(hx, hy, hz));
        var b = new CANNON.Body({ mass: 0, material: mat || w.floorMat });
        b.addShape(sh);
        b.position.set(px, py, pz);
        b.quaternion.set(qx, qy, qz, qw);
        w.world.addBody(b);
        w.staticBodies.push(b);
        return b;
      }

      /* Path half-width: > eight ball diameters (16·R) plus margin. */
      var pathHalfX = Math.max(2.2, 8 * PLAYER_R + 0.88);
      this._vkPathHalfX = pathHalfX;

      var startHy = 0.17;
      var startCy = 0.565;
      /* Match `platVis` / `startPlatVis` A-Frame box sizes (Cannon uses half-extents). */
      var vkFinHx = (pathHalfX * 2 + 1.35) * 0.5;
      var vkFinHy = 0.22 * 0.5;
      var vkFinHz = 4.4 * 0.5;
      var rq = this._vkRampQuat;
      if (courseTrack === 1) {
        addStaticBox(pathHalfX, 0.22, 5.8, 0, 0.78, 0.35, rq.x, rq.y, rq.z, rq.w, this.floorMat);
        addStaticBox(vkFinHx, vkFinHy, vkFinHz, 0, VK_FINISH_PLATFORM_CY, VK_FINISH_PLATFORM_CENTER_Z, 0, 0, 0, 1, this.floorMat);
      } else {
        /* No continuous middle slab — gaps crossed on track-2 spinners or track-3 sliding tiles. */
        addStaticBox(vkFinHx, vkFinHy, vkFinHz, 0, startCy, VK_FINISH_PLATFORM_CENTER_Z, 0, 0, 0, 1, this.floorMat);
        w._vkFinishCheckZMin = VK_FINISH_CHECK_Z_MIN;
      }
      /* Half-extents: match `startPlatVis` width/depth (3.55 full depth → half 1.775). */
      var vkStartHx = (pathHalfX * 2 + 1.32) * 0.5;
      addStaticBox(vkStartHx, startHy, 3.55 * 0.5, 0, startCy, 4.62, 0, 0, 0, 1, this.floorMat);

      /*
       * Finish qualification volume (all tracks): X ≈ arch span, Y from finish slab top through arch top,
       * Z band unchanged. Uses finish slab top — not the higher start deck (fixes T2/T3 false rejects).
       */
      var platTopY =
        courseTrack === 1 ? VK_FINISH_PLATFORM_CY + vkFinHy : startCy + vkFinHy;
      var archBaseYQ =
        courseTrack === 1
          ? 1.38 - VK_FINISH_PLATFORM_THICK + VK_FINISH_PLATFORM_Y_EXTRA
          : startCy + vkFinHy;
      var archVolTopY = archBaseYQ + 1.88;
      w._vkFinishQualifyMinY = platTopY - PLAYER_R - 0.36;
      w._vkFinishQualifyMaxY = archVolTopY + PLAYER_R * 0.75;
      w._vkFinishQualifyHalfX = vkFinHx + 0.24;

      /* Car spawn columns (independent of plinko pillars). */
      var cols = [];
      var nc = VK_MAX_SLOTS;
      for (var ci = 0; ci < nc; ci++) {
        cols.push(-pathHalfX * 0.84 + (pathHalfX * 1.68 * ci) / Math.max(1, nc - 1));
      }

      if (courseTrack === 1) {
        var pillarQ = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), this._vkRampNormal);
        var pillarRad = 0.088;
        var pillarHalfH = 0.33;
        /*
         * Plinko peg rows (same Z per row). Ramp rises toward −Z (finish); +Z is the low start end.
         * Row 0 = four pillars at the *high* end of the slope (−Z, high Y); each step +minRowDz in +Z goes *down* the ramp.
         * Three-row X positions: half-pitch offset (L+p/2, L+3p/2, L+5p/2 vs L, L+p, L+2p, L+3p, L = −1.5p).
         */
        var minCenterDx = 2 * pillarRad + 4 * ROCK_R;
        var minRowDz = Math.max(4 * ROCK_R, 0.5);
        var maxHalfSpanX = pathHalfX * 0.86 - pillarRad;
        var pitchX = Math.max(minCenterDx, Math.min(maxHalfSpanX / 1.5, (pathHalfX * 1.72) / 3));
        if (1.5 * pitchX > maxHalfSpanX + 1e-6) {
          pitchX = maxHalfSpanX / 1.5;
        }
        var leftFour = -1.5 * pitchX;
        function plinkoXsFour() {
          return [leftFour, leftFour + pitchX, leftFour + 2 * pitchX, leftFour + 3 * pitchX];
        }
        function plinkoXsThree() {
          return [leftFour + 0.5 * pitchX, leftFour + 1.5 * pitchX, leftFour + 2.5 * pitchX];
        }
        var xs4Top = plinkoXsFour();
        var zPegLowEnd = 3.9;
        var zPegHighEnd = -3.35;
        var zPegRow0 = zPegHighEnd + pillarRad * 0.5;
        var zPegMax = zPegLowEnd - minRowDz * 0.35;
        this._vkPillarAvoidPts.length = 0;
        this._vkPlinkoGapAvoidPts.length = 0;
        var rampEdgeX = pathHalfX + pillarRad * 0.92;
        var pr;
        for (pr = 0; pr < 96; pr++) {
          var pz = zPegRow0 + pr * minRowDz;
          if (pz > zPegMax) break;
          var useFour = pr % 2 === 0;
          var xs = useFour ? plinkoXsFour() : plinkoXsThree();
          var pi;
          for (pi = 0; pi < xs.length; pi++) {
            var px = xs[pi];
            var py = 0.64 + VK_RAMP_GRADE * (this._vkSpawnZ - pz);
            if (Math.abs(px) > rampEdgeX || py < 0.08 || py > 2.58 || pz > zPegMax + 0.12) continue;
            this._vkPillarAvoidPts.push({
              x: px,
              z: pz,
              r: pillarRad + PLAYER_R * 1.12
            });
            var pb = new CANNON.Body({ mass: 0, material: w.defaultMat });
            pb.addShape(new CANNON.Box(new CANNON.Vec3(pillarRad, pillarHalfH, pillarRad)));
            pb.position.set(px, py, pz);
            pb.quaternion.set(pillarQ.x, pillarQ.y, pillarQ.z, pillarQ.w);
            w.world.addBody(pb);
            w.staticBodies.push(pb);
            var vis = document.createElement('a-cylinder');
            vis.setAttribute('radius', String(pillarRad));
            vis.setAttribute('height', '0.66');
            vis.setAttribute('position', px + ' ' + py + ' ' + pz);
            var euler = new THREE.Euler().setFromQuaternion(pillarQ, 'YXZ');
            vis.setAttribute(
              'rotation',
              (euler.x * 180) / Math.PI + ' ' + (euler.y * 180) / Math.PI + ' ' + (euler.z * 180) / Math.PI
            );
            vis.setAttribute('material', 'color: #ff9ec8; metalness: 0.35; roughness: 0.28; emissive: #aa4477; emissiveIntensity: 0.15');
            root.appendChild(vis);
          }
          var gi;
          for (gi = 0; gi < xs.length - 1; gi++) {
            var gxm = (xs[gi] + xs[gi + 1]) * 0.5;
            var gzm = pz;
            var gym = 0.64 + VK_RAMP_GRADE * (this._vkSpawnZ - gzm);
            var gapHalfW = (xs[gi + 1] - xs[gi]) * 0.36;
            var gHalfZ = minRowDz * 0.38;
            if (
              gapHalfW > 0.032 &&
              Math.abs(gxm) <= rampEdgeX - 0.02 &&
              gym >= 0.08 &&
              gym <= 2.58 &&
              gzm <= zPegMax + 0.12
            ) {
              this._vkPlinkoGapAvoidPts.push({ x: gxm, z: gzm, halfW: gapHalfW, halfZ: gHalfZ });
            }
          }
        }
        w._vkPlinkoGapXs = [
          (xs4Top[0] + xs4Top[1]) * 0.5,
          (xs4Top[1] + xs4Top[2]) * 0.5,
          (xs4Top[2] + xs4Top[3]) * 0.5
        ];
        w._vkPlinkoRockSpawnZ = zPegRow0 - minRowDz * 0.55;
        w._vkPlinkoRockSpawnDzJitter = Math.min(minRowDz * 0.32, 0.2);
      } else {
        this._vkPillarAvoidPts.length = 0;
        if (this._vkPlinkoGapAvoidPts) this._vkPlinkoGapAvoidPts.length = 0;
        w._vkPlinkoGapXs = null;
        w._vkPlinkoRockSpawnZ = null;
        w._vkPlinkoRockSpawnDzJitter = 0;
        if (courseTrack === 2) {
          this._buildTrack2Spinners(w, root, pathHalfX, startCy, startHy);
        } else {
          this._buildTrack3MovingPlatforms(w, root, pathHalfX, startCy, startHy);
        }
      }

      var archLeg = pathHalfX * 0.9;
      var archBeamW = pathHalfX * 2 + 0.42;
      /* Flat tracks: arch feet on finish slab top (`platVis` center `startCy`, half-height `vkFinHy`). Track 1 keeps ramp-tuned Y. */
      var archBaseY =
        courseTrack === 1
          ? 1.38 - VK_FINISH_PLATFORM_THICK + VK_FINISH_PLATFORM_Y_EXTRA
          : startCy + vkFinHy;
      /* Finish arch (visual) — raised with finish line on the top platform. */
      var arch = document.createElement('a-entity');
      arch.setAttribute('position', '0 ' + archBaseY + ' ' + this._vkFinishZ);
      var leg1 = document.createElement('a-box');
      leg1.setAttribute('width', '0.1');
      leg1.setAttribute('height', '1.1');
      leg1.setAttribute('depth', '0.1');
      leg1.setAttribute('position', -archLeg + ' 0.55 0');
      leg1.setAttribute('material', 'color: #44ffaa; emissive: #22cc88; emissiveIntensity: 0.35');
      var leg2 = document.createElement('a-box');
      leg2.setAttribute('width', '0.1');
      leg2.setAttribute('height', '1.1');
      leg2.setAttribute('depth', '0.1');
      leg2.setAttribute('position', archLeg + ' 0.55 0');
      leg2.setAttribute('material', 'color: #44ffaa; emissive: #22cc88; emissiveIntensity: 0.35');
      var beam = document.createElement('a-box');
      beam.setAttribute('width', archBeamW.toString());
      beam.setAttribute('height', '0.12');
      beam.setAttribute('depth', '0.14');
      beam.setAttribute('position', '0 1.12 0');
      beam.setAttribute('material', 'color: #ffff88; emissive: #ffcc00; emissiveIntensity: 0.45');
      arch.appendChild(leg1);
      arch.appendChild(leg2);
      arch.appendChild(beam);
      var banner = document.createElement('a-text');
      banner.setAttribute('value', 'FINISH');
      banner.setAttribute('align', 'center');
      banner.setAttribute('position', '0 1.42 0');
      banner.setAttribute('width', '2.2');
      banner.setAttribute('color', '#ffffff');
      arch.appendChild(banner);
      root.appendChild(arch);

      if (courseTrack === 1) {
        var rampVis = document.createElement('a-box');
        rampVis.setAttribute('width', (pathHalfX * 2 + 0.16).toString());
        rampVis.setAttribute('height', '0.26');
        rampVis.setAttribute('depth', '11.6');
        rampVis.setAttribute('position', '0 0.78 0.35');
        rampVis.setAttribute('rotation', (VK_SLOPE_RAD * 180) / Math.PI + ' 0 0');
        rampVis.setAttribute(
          'material',
          'color: #66aaff; opacity: 0.35; transparent: true; side: double; depthWrite: false; emissive: #4488dd; emissiveIntensity: 0.2'
        );
        root.appendChild(rampVis);
      }

      var platVis = document.createElement('a-box');
      platVis.setAttribute('width', (pathHalfX * 2 + 1.35).toString());
      platVis.setAttribute('height', '0.22');
      platVis.setAttribute('depth', '4.4');
      platVis.setAttribute(
        'position',
        '0 ' + (courseTrack === 1 ? VK_FINISH_PLATFORM_CY : startCy) + ' ' + VK_FINISH_PLATFORM_CENTER_Z
      );
      platVis.setAttribute('material', 'color: #eeddff; roughness: 0.55; metalness: 0.08; emissive: #bbaaff; emissiveIntensity: 0.08');
      root.appendChild(platVis);

      var startPlatVis = document.createElement('a-box');
      startPlatVis.setAttribute('width', (pathHalfX * 2 + 1.32).toString());
      startPlatVis.setAttribute('height', (startHy * 2).toString());
      startPlatVis.setAttribute('depth', '3.55');
      startPlatVis.setAttribute('position', '0 ' + startCy + ' 4.62');
      startPlatVis.setAttribute('material', 'color: #ddeeff; roughness: 0.52; metalness: 0.06; emissive: #aab8dd; emissiveIntensity: 0.06');
      root.appendChild(startPlatVis);

      {
        /**
         * Finish −Z, ramp +Z. Text toward +Z (see zTxt). MSDF text faces −Z by default; ramp viewers need the other
         * face — text side: double so readable from both sides.
         */
        var lbRoot = document.createElement('a-entity');
        lbRoot.setAttribute('id', 'vk-leaderboard-root');
        lbRoot.setAttribute('position', '0 ' + VK_LEADERBOARD_ROOT_Y + ' -8.08');
        lbRoot.setAttribute('rotation', '0 0 0');
        var lbW = pathHalfX * 2 + 4.35;
        var lbBack = document.createElement('a-plane');
        lbBack.setAttribute('width', lbW.toString());
        lbBack.setAttribute('height', '2.86');
        lbBack.setAttribute('position', '0 0 -0.44');
        lbBack.setAttribute('rotation', '0 180 0');
        lbBack.setAttribute(
          'material',
          'shader: flat; color: #0a0614; opacity: 0.92; transparent: true; side: front; depthWrite: true'
        );
        var zTxt = 0.4;
        var colOff = Math.min(1.22, pathHalfX * 0.52);
        var lbTexts = document.createElement('a-entity');
        lbTexts.setAttribute('id', 'vk-leaderboard-texts');
        lbTexts.setAttribute('position', '0 0 ' + zTxt);
        var trackHead = document.createElement('a-text');
        trackHead.setAttribute('align', 'center');
        trackHead.setAttribute('anchor', 'center');
        trackHead.setAttribute('baseline', 'bottom');
        trackHead.setAttribute('position', '0 1.1 0');
        trackHead.setAttribute(
          'value',
          courseTrack === 3
            ? 'TRACK 3 — SLIDING TILES'
            : courseTrack === 2
              ? 'TRACK 2 — SPINNER GAUNTLET'
              : 'TRACK 1 — UPHILL RAMP'
        );
        trackHead.setAttribute('width', '7.2');
        trackHead.setAttribute('color', '#fff4dd');
        trackHead.setAttribute('shader', 'msdf');
        trackHead.setAttribute('side', 'double');
        lbTexts.appendChild(trackHead);
        function addCol(parent, xLocal, titleStr) {
          var col = document.createElement('a-entity');
          col.setAttribute('position', xLocal + ' 0 0');
          var tt = document.createElement('a-text');
          tt.setAttribute('align', 'center');
          tt.setAttribute('anchor', 'center');
          tt.setAttribute('baseline', 'bottom');
          tt.setAttribute('position', '0 0.62 0');
          tt.setAttribute('value', titleStr);
          tt.setAttribute('width', '5.8');
          tt.setAttribute('color', '#ffdd99');
          tt.setAttribute('shader', 'msdf');
          tt.setAttribute('side', 'double');
          col.appendChild(tt);
          var bt = document.createElement('a-text');
          bt.setAttribute('align', 'center');
          bt.setAttribute('anchor', 'center');
          bt.setAttribute('baseline', 'top');
          bt.setAttribute('position', '0 0.38 0');
          bt.setAttribute('value', '');
          bt.setAttribute('width', '5.2');
          bt.setAttribute('wrapCount', '20');
          bt.setAttribute('lineHeight', '64');
          bt.setAttribute('color', '#f0f4ff');
          bt.setAttribute('shader', 'msdf');
          bt.setAttribute('side', 'double');
          col.appendChild(bt);
          parent.appendChild(col);
          return { col: col, body: bt };
        }
        var packL = addCol(lbTexts, -colOff, 'ALL-TIME TOP 10');
        var packR = addCol(lbTexts, colOff, 'THIS RACE');
        this._vkLeaderboardAllTimeEl = packL.body;
        this._vkLeaderboardMatchEl = packR.body;
        lbRoot.appendChild(lbBack);
        lbRoot.appendChild(lbTexts);
        root.appendChild(lbRoot);
        this._vkLeaderboardRoot = lbRoot;
        this._vkRefreshLeaderboardPanels();
      }
      try {
        vkSaveGhostRuns(vkLoadGhostRuns(courseTrack), courseTrack);
      } catch (eLb) {}

      this._carSpawn = [];
      var z0 = this._vkSpawnZ;
      /* One contestant per column; Z stagger so balls do not spawn inside each other. */
      var slotXZ = [];
      var zOffs = [0.06, -0.02, 0.02, -0.06, 0.05, -0.03, 0.03, -0.05];
      var szi;
      for (szi = 0; szi < VK_MAX_SLOTS; szi++) {
        slotXZ.push({ x: cols[szi], z: z0 + (zOffs[szi] != null ? zOffs[szi] : 0) });
      }
      var spawnY = startCy + startHy + PLAYER_R + 0.07;
      var idQ = new THREE.Quaternion(0, 0, 0, 1);
      var i;
      var halfB = VK_BODY_HALF;
      this._vkCarLed.length = 0;
      this._vkCubeLeanPivotEls = [];
      for (i = 0; i < VK_MAX_SLOTS; i++) {
        var wrap = document.createElement('a-entity');
        wrap.setAttribute('position', slotXZ[i].x + ' ' + spawnY + ' ' + slotXZ[i].z);
        root.appendChild(wrap);
        this.carEls.push(wrap);

        var ballEl = document.createElement('a-entity');
        ballEl.setAttribute('class', 'vk-player-ball');
        ballEl.setAttribute('position', '0 0 0');
        /* Do not name this `THREE` — `var` hoists and shadows global THREE for all of _buildCourse. */
        var RootTHREE = window.THREE || (typeof AFRAME !== 'undefined' && AFRAME.THREE);
        var ballGeo = new RootTHREE.SphereGeometry(PLAYER_R, 40, 28);
        var soccerTex = vkCreateSoccerBallTexture(RootTHREE);
        var specC = new RootTHREE.Color(VK_SPEC[i].color);
        var ballMat = new RootTHREE.MeshStandardMaterial({
          map: soccerTex,
          roughness: 0.36,
          metalness: 0.08,
          emissive: specC,
          emissiveIntensity: 0.12
        });
        var ballMesh = new RootTHREE.Mesh(ballGeo, ballMat);
        ballMesh.name = 'vkPlayerWheelMesh';
        ballEl.setObject3D('mesh', ballMesh);
        wrap.appendChild(ballEl);

        var bodyEl = document.createElement('a-box');
        bodyEl.setAttribute('class', 'vk-player-body');
        bodyEl.setAttribute('width', (halfB * 2).toString());
        bodyEl.setAttribute('height', (halfB * 2).toString());
        bodyEl.setAttribute('depth', (halfB * 2).toString());
        var bodyCy = PLAYER_R + halfB + 0.012;
        bodyEl.setAttribute('position', '0 ' + bodyCy + ' 0');
        bodyEl.setAttribute(
          'material',
          'color: ' +
            VK_SPEC[i].color +
            '; metalness: 0.45; roughness: 0.25; emissive: ' +
            VK_SPEC[i].color +
            '; emissiveIntensity: 0.12'
        );
        var leanPivot = document.createElement('a-entity');
        leanPivot.setAttribute('class', 'vk-cube-lean-pivot');
        leanPivot.setAttribute('position', '0 0 0');
        wrap.appendChild(leanPivot);
        leanPivot.appendChild(bodyEl);
        this._vkCubeLeanPivotEls.push(leanPivot);

        var led = vkCreateCarLedFace(THREE, halfB, VK_SPEC[i].color);
        bodyEl.object3D.add(led.pivot);
        this._vkCarLed.push({
          pivot: led.pivot,
          texture: led.texture,
          ctx: led.ctx,
          canvasW: led.canvas.width,
          canvasH: led.canvas.height,
          geometry: led.geometry,
          material: led.material,
          mesh: led.mesh,
          ledBodyColor: VK_SPEC[i].color,
          lastDrawnMode: 'neutral'
        });

        var topCap = document.createElement('a-box');
        topCap.setAttribute('class', 'vk-player-topcap');
        topCap.setAttribute('width', (halfB * 2 - 0.006).toString());
        topCap.setAttribute('depth', (halfB * 2 - 0.006).toString());
        topCap.setAttribute('height', '0.012');
        topCap.setAttribute('position', '0 ' + (halfB + 0.006) + ' 0');
        topCap.setAttribute(
          'material',
          'shader: flat; color: #6ec8ff; metalness: 0.12; roughness: 0.32; emissive: #4aa8e8; emissiveIntensity: 0.45'
        );
        bodyEl.appendChild(topCap);

        var crownEl = document.createElement('a-cone');
        crownEl.setAttribute('class', 'vk-player-crown');
        crownEl.setAttribute('position', '0 ' + (halfB + 0.1) + ' 0');
        crownEl.setAttribute('radius-bottom', '0.052');
        crownEl.setAttribute('radius-top', '0.004');
        crownEl.setAttribute('height', '0.1');
        crownEl.setAttribute('rotation', '180 0 0');
        crownEl.setAttribute('visible', 'false');
        crownEl.setAttribute(
          'material',
          'shader: flat; color: #ffd54a; emissive: #cc8800; emissiveIntensity: 0.38; metalness: 0.2; roughness: 0.35'
        );
        bodyEl.appendChild(crownEl);

        var sphShape = new CANNON.Sphere(PLAYER_R);
        var body = new CANNON.Body({
          mass: BALL_MASS,
          material: this.carMat,
          linearDamping: BALL_LINEAR_DAMPING,
          angularDamping: BALL_ANGULAR_DAMPING
        });
        body.addShape(sphShape);
        body.position.set(slotXZ[i].x, spawnY, slotXZ[i].z);
        body.quaternion.set(idQ.x, idQ.y, idQ.z, idQ.w);
        body.fixedRotation = false;
        body.vkSlot = i;
        var self = this;
        (function (slot) {
          body.addEventListener('collide', function (e) {
            var c = e && e.contact;
            /* Jump support: any strong vertical contact (either normal sign) + mild boost for steep walls/rims. */
            if (c && c.ni) {
              var nyy = c.ni.y;
              if (typeof nyy === 'number' && isFinite(nyy)) {
                if (Math.abs(nyy) > 0.12) {
                  self._vkGrounded[slot] = 32;
                } else {
                  var nxx = c.ni.x;
                  var nzz = c.ni.z;
                  if (typeof nxx === 'number' && typeof nzz === 'number' && Math.sqrt(nxx * nxx + nzz * nzz) > 0.65 && Math.abs(nyy) < 0.5) {
                    self._vkGrounded[slot] = Math.max(self._vkGrounded[slot] | 0, 14);
                  }
                }
              }
            }
            var impact = 0.6;
            if (c && typeof c.getImpactVelocityAlongNormal === 'function') {
              try {
                impact = Math.abs(c.getImpactVelocityAlongNormal());
              } catch (err) {
                impact = 0.6;
              }
            } else if (c && c.ni) {
              var bi = c.bi;
              var bj = c.bj;
              if (bi && bj) {
                var dvx = bi.velocity.x - bj.velocity.x;
                var dvy = bi.velocity.y - bj.velocity.y;
                var dvz = bi.velocity.z - bj.velocity.z;
                impact = Math.abs(dvx * c.ni.x + dvy * c.ni.y + dvz * c.ni.z);
              }
            }
            if (impact > 0.14 && self._vkLedHitRemainMs) {
              self._vkLedHitRemainMs[slot] = Math.max(self._vkLedHitRemainMs[slot], 280);
            }
          });
        })(i);
        this.world.addBody(body);
        this.carBodies.push(body);
        this._carSpawn.push({
          x: body.position.x,
          y: spawnY,
          z: body.position.z,
          qx: idQ.x,
          qy: idQ.y,
          qz: idQ.z,
          qw: idQ.w
        });
        this._vkCarriageYawRad[i] = Math.atan2(this._vkUphill.x, this._vkUphill.z);
      }

      this._vkLaneCols = cols.slice();
      this._vkLaneSlotZ = [0.06, -0.02, 0.02, -0.06];
      this._vkSpawnPhysY = spawnY;
      this._vkSpawnBaseZ = z0;
      this._vkRebuildCarSpawnFromRot(0);
      this._vkCreateLaneStartMarkers();
      this._vkUpdateLaneMarkerColorsAndPositions();

      {
        var fzC = this._vkFinishZ;
        var fxWrap = document.createElement('a-entity');
        fxWrap.setAttribute('id', 'vk-finish-celeb-wrap');
        fxWrap.setAttribute('position', '0 2.14 ' + (fzC + 0.38));
        fxWrap.setAttribute('visible', 'false');
        var celebMain = document.createElement('a-text');
        celebMain.setAttribute('id', 'vk-finish-celeb-main');
        celebMain.setAttribute('align', 'center');
        celebMain.setAttribute('anchor', 'center');
        celebMain.setAttribute('baseline', 'center');
        celebMain.setAttribute('position', '0 0.32 0');
        celebMain.setAttribute('value', '');
        celebMain.setAttribute('width', '14');
        celebMain.setAttribute('color', '#ffee66');
        celebMain.setAttribute('shader', 'msdf');
        fxWrap.appendChild(celebMain);
        var subC = document.createElement('a-text');
        subC.setAttribute('id', 'vk-finish-celeb-sub');
        subC.setAttribute('align', 'center');
        subC.setAttribute('position', '0 -0.02 0');
        subC.setAttribute('value', '');
        subC.setAttribute('width', '7');
        subC.setAttribute('color', '#ffccff');
        subC.setAttribute('shader', 'msdf');
        fxWrap.appendChild(subC);
        var sparkList = [];
        var sparkIdx;
        for (sparkIdx = 0; sparkIdx < 12; sparkIdx++) {
          var sphFx = document.createElement('a-sphere');
          sphFx.setAttribute('class', 'vk-finish-celeb-spark');
          sphFx.setAttribute('radius', '0.03');
          sphFx.setAttribute('visible', 'false');
          var hue = sparkIdx % 3 === 0 ? '#ffee44' : sparkIdx % 3 === 1 ? '#ff66aa' : '#66ddff';
          sphFx.setAttribute('material', 'shader: flat; color: ' + hue + '; opacity: 0.96; transparent: true');
          fxWrap.appendChild(sphFx);
          sparkList.push(sphFx);
        }
        root.appendChild(fxWrap);
        this._vkFinishFxWrap = fxWrap;
        this._vkFinishFxMainText = celebMain;
        this._vkFinishFxSubText = subC;
        this._vkFinishFxSparkEls = sparkList;
      }

      this._vkRockIdleMs = [];
      this._vkRockActive = [];
      if (courseTrack === 1) {
        for (var ri = 0; ri < MAX_ROCKS; ri++) {
          this._addRockBody(false);
        }
      }
    },

    /**
     * Track 2: yaw-spinning discs + opposite-yaw crossbars over the void (kinematic Cannon bodies).
     */
    _buildTrack2Spinners: function (w, root, pathHalfX, startCy, startHy) {
      var deckTop = startCy + startHy;
      var discR = Math.min(pathHalfX * 0.88, 1.14);
      var discH = 0.14;
      /* Disc bottom flush with runway top (same as start/finish deck). */
      var discY = deckTop + discH * 0.5;
      var pillarRad = 0.088;
      /* Horizontal round arm: length ≤ platform diameter; same radius as track 1 pillars. */
      var armLen = Math.min(2 * discR * 0.96, 2 * discR - pillarRad * 0.25);
      var armY = deckTop + discH + pillarRad;
      var KIN =
        typeof CANNON.Body !== 'undefined' && CANNON.Body.KINEMATIC !== undefined ? CANNON.Body.KINEMATIC : 4;
      var nDisc = 5;
      var zHi = 2.35;
      var zLo = -5.35;
      /* Cannon.Cylinder mesh axis is +Z; map that to body +Y to match `a-cylinder` primitives. */
      if (!w._vkT2CylZToBodyY) {
        w._vkT2CylZToBodyY = new CANNON.Quaternion();
        w._vkT2CylZToBodyY.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI * 0.5);
      }
      /* Bar mesh + Cannon body +Y should map to world +X at yaw 0 → Rz(-90°), not Ry (Y is unchanged by Ry). */
      if (!w._vkT2BarBodyAlign) {
        w._vkT2BarBodyAlign = new CANNON.Quaternion();
        w._vkT2BarBodyAlign.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), -Math.PI * 0.5);
      }
      var cylZToBodyY = w._vkT2CylZToBodyY;
      var barBodyAlign = w._vkT2BarBodyAlign;
      var discHalfH = discH * 0.5;
      /* Second disc (−X from start view): center distance in XZ = 2·R so rims touch (Z step is dz; solve |Δx|). */
      var zSpan = zLo - zHi;
      var dzConsecutive = Math.abs(zSpan / Math.max(1, nDisc - 1));
      var twoR = 2 * discR;
      var innerTouch = twoR * twoR - dzConsecutive * dzConsecutive;
      var cxTouch = innerTouch > 1e-8 ? Math.sqrt(innerTouch) : 0;
      /* 2nd disc −X vs 1st; 4th disc +X vs 3rd — same |Δx| for consecutive Z spacing (rim tangency in XZ). */
      var cxSecond = -cxTouch;
      var cxFourth = cxTouch;
      var di;
      for (di = 0; di < nDisc; di++) {
        var t = nDisc > 1 ? di / (nDisc - 1) : 0.5;
        var cz = zHi + t * (zLo - zHi);
        var cx = di === 1 ? cxSecond : di === 3 ? cxFourth : 0;
        var wDisc = 0.38 + (di % 3) * 0.07;
        var wBar = -wDisc;
        var ph0 = di * 0.55;
        var ph1 = di * 0.31;
        /* Convex cylinder in Cannon 0.6.2 is along local Z; `cylZToBodyY` aligns it with `a-cylinder` (+Y). */
        var discShape = new CANNON.Cylinder(discR * 0.998, discR * 0.998, discH, 16);
        var discBody = new CANNON.Body({ mass: 0, material: w.spinnerMat || w.defaultMat });
        discBody.type = KIN;
        discBody.addShape(discShape, new CANNON.Vec3(0, 0, 0), cylZToBodyY);
        discBody.position.set(cx, discY, cz);
        {
          var hd0 = ph0 * 0.5;
          discBody.quaternion.set(0, Math.sin(hd0), 0, Math.cos(hd0));
        }
        w.world.addBody(discBody);
        w.staticBodies.push(discBody);
        var barCylShape = new CANNON.Cylinder(pillarRad * 0.998, pillarRad * 0.998, armLen, 14);
        var barBody = new CANNON.Body({ mass: 0, material: w.spinnerMat || w.defaultMat });
        barBody.type = KIN;
        barBody.addShape(barCylShape, new CANNON.Vec3(0, 0, 0), cylZToBodyY);
        if (!w._vkT2BarQy) {
          w._vkT2BarQy = new CANNON.Quaternion();
          w._vkT2BarQMul = new CANNON.Quaternion();
        }
        w._vkT2BarQy.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), ph1);
        w._vkT2BarQy.mult(barBodyAlign, w._vkT2BarQMul);
        barBody.quaternion.copy(w._vkT2BarQMul);
        barBody.position.set(cx, armY, cz);
        w.world.addBody(barBody);
        w.staticBodies.push(barBody);
        /* Pie sectors: stacked partial cylinders (theta in degrees) so the rim reads as alternating colors. */
        var nSectors = 12;
        var sectorDeg = 360 / nSectors;
        var patternTwist = (di % 2) * (sectorDeg * 0.5);
        var discEl = document.createElement('a-entity');
        discEl.setAttribute('position', cx + ' ' + discY + ' ' + cz);
        var sw;
        for (sw = 0; sw < nSectors; sw++) {
          var wedge = document.createElement('a-cylinder');
          wedge.setAttribute('radius', String(discR));
          wedge.setAttribute('height', String(discH));
          wedge.setAttribute('segments-radial', '8');
          wedge.setAttribute('theta-start', String(sw * sectorDeg + patternTwist));
          wedge.setAttribute('theta-length', String(sectorDeg));
          wedge.setAttribute('open-ended', 'false');
          var even = sw % 2 === 0;
          wedge.setAttribute(
            'material',
            even
              ? 'color: #5ea8d8; metalness: 0.28; roughness: 0.4; emissive: #1a4a6e; emissiveIntensity: 0.14; side: double'
              : 'color: #d4eefc; metalness: 0.18; roughness: 0.44; emissive: #5a88aa; emissiveIntensity: 0.1; side: double'
          );
          discEl.appendChild(wedge);
        }
        root.appendChild(discEl);
        var barEl = document.createElement('a-cylinder');
        barEl.setAttribute('radius', String(pillarRad));
        barEl.setAttribute('height', String(armLen));
        barEl.setAttribute('position', cx + ' ' + armY + ' ' + cz);
        barEl.setAttribute(
          'material',
          'color: #ff9ec8; metalness: 0.35; roughness: 0.28; emissive: #aa4477; emissiveIntensity: 0.15'
        );
        root.appendChild(barEl);
        w._vkSpinnerBodies.push({
          discBody: discBody,
          barBody: barBody,
          discEl: discEl,
          barEl: barEl,
          discY: discY,
          discHalfH: discHalfH,
          discR: discR,
          armY: armY,
          cx: cx,
          cz: cz,
          wDisc: wDisc,
          wBar: wBar,
          ph0: ph0,
          ph1: ph1
        });
      }
    },

    /**
     * Track 3: six square kinematic slabs along Z (touching), each oscillating in X with its own ω and phase.
     */
    _buildTrack3MovingPlatforms: function (w, root, pathHalfX, startCy, startHy) {
      var deckTop = startCy + startHy;
      var slabHalfY = 0.07;
      var platY = deckTop + slabHalfY;
      var n = 6;
      var zHi = 2.35;
      var zLo = -5.35;
      var zSpan = zLo - zHi;
      var dzCenters = zSpan / Math.max(1, n - 1);
      var halfHz = Math.abs(dzCenters) * 0.5;
      var halfHx = halfHz;
      var maxAmp = Math.max(0.1, pathHalfX * 0.9 - halfHx);
      var KIN =
        typeof CANNON.Body !== 'undefined' && CANNON.Body.KINEMATIC !== undefined ? CANNON.Body.KINEMATIC : 4;
      var mat = w.spinnerMat || w.defaultMat;
      var i;
      for (i = 0; i < n; i++) {
        var t = n > 1 ? i / (n - 1) : 0.5;
        var cz = zHi + t * zSpan;
        var omega = 0.52 + i * 0.15 + (i % 2) * 0.11;
        var phase = i * 1.41 + (i % 3) * 0.55;
        var amp = maxAmp * (0.82 + 0.035 * ((i * 7) % 5));
        var box = new CANNON.Box(new CANNON.Vec3(halfHx, slabHalfY, halfHz));
        var body = new CANNON.Body({ mass: 0, material: mat });
        body.type = KIN;
        body.addShape(box);
        body.position.set(0, platY, cz);
        body.quaternion.set(0, 0, 0, 1);
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        w.world.addBody(body);
        w.staticBodies.push(body);
        var el = document.createElement('a-box');
        el.setAttribute('width', (halfHx * 2).toString());
        el.setAttribute('height', (slabHalfY * 2).toString());
        el.setAttribute('depth', (halfHz * 2).toString());
        el.setAttribute('position', '0 ' + platY + ' ' + cz);
        el.setAttribute(
          'material',
          'color: #aac8ff; metalness: 0.22; roughness: 0.5; emissive: #4466aa; emissiveIntensity: 0.1'
        );
        root.appendChild(el);
        w._vkT3SliderBodies.push({
          body: body,
          el: el,
          baseZ: cz,
          baseY: platY,
          halfHx: halfHx,
          halfHz: halfHz,
          slabHalfY: slabHalfY,
          amp: amp,
          omega: omega,
          phase: phase
        });
      }
    },

    _vkTickTrack3Sliders: function (nowMs, opts) {
      if ((this._vkCourseTrack | 0) !== 3 || !this._vkT3SliderBodies || !this._vkT3SliderBodies.length) return;
      var reSnap = opts && opts.reSnapPose;
      var s = nowMs * 0.001;
      var si;
      var list = this._vkT3SliderBodies;
      for (si = 0; si < list.length; si++) {
        var p = list[si];
        if (!p || !p.body) continue;
        var sn = p.omega * s + p.phase;
        var x = p.amp * Math.sin(sn);
        var vx = p.amp * p.omega * Math.cos(sn);
        p.body.position.set(x, p.baseY, p.baseZ);
        p.body.quaternion.set(0, 0, 0, 1);
        if (!reSnap) {
          p.body.velocity.set(vx, 0, 0);
          p.body.angularVelocity.set(0, 0, 0);
        }
      }
    },

    /**
     * Track 3: help balls pick up sideways tile velocity (Cannon kinematic friction is weak).
     */
    _vkApplyTrack3SliderCarry: function (dtSec, nowMs) {
      if (!this.isHost || (this._vkCourseTrack | 0) !== 3 || !this._vkT3SliderBodies || !this._vkT3SliderBodies.length) return;
      if (!dtSec || dtSec <= 0 || dtSec > 0.12) dtSec = 1 / 60;
      var s = nowMs * 0.001;
      var list = this._vkT3SliderBodies;
      var sl;
      for (sl = 0; sl < VK_MAX_SLOTS; sl++) {
        var body = this.carBodies[sl];
        if (!body) continue;
        var inp = this.inputs[sl];
        var thrust = inp ? Math.max(Math.abs(inp.trig || 0), Math.abs(inp.trigRev || 0)) : 0;
        var k = (12 * (1 - Math.min(thrust, 1)) + 3.5 * Math.min(thrust, 1)) * dtSec;
        if (k > 0.88) k = 0.88;
        var px = body.position.x;
        var py = body.position.y;
        var pz = body.position.z;
        var si;
        for (si = 0; si < list.length; si++) {
          var p = list[si];
          if (!p || !p.body || p.halfHx == null) continue;
          var sn = p.omega * s + p.phase;
          var platX = p.amp * Math.sin(sn);
          var vxPlat = p.amp * p.omega * Math.cos(sn);
          var dx = px - platX;
          var dz = pz - p.baseZ;
          if (Math.abs(dx) > p.halfHx - PLAYER_R * 1.05 || Math.abs(dz) > p.halfHz - PLAYER_R * 0.85) continue;
          var surfY = p.baseY + p.slabHalfY;
          var ballBottom = py - PLAYER_R;
          if (ballBottom < surfY - 0.07 || ballBottom > surfY + 0.1) continue;
          var vx = body.velocity.x;
          if ((vxPlat > 1e-4 && vx < vxPlat - 1e-4) || (vxPlat < -1e-4 && vx > vxPlat + 1e-4)) {
            body.velocity.x += (vxPlat - vx) * k;
          }
          break;
        }
      }
    },

    /**
     * Track 2 host: shelf tangential ω×r — only boost when already moving *with* the rim (v·û ≥ 0)
     * but slower than the shelf; never blend toward +|ω×r| when v·û < 0 or that would fight counter-drive.
     * Yaw carry skips when spin clearly opposes the disc (wy·ω < 0).
     */
    _vkApplyTrack2DiscCarry: function (dtSec) {
      if (!this.isHost || (this._vkCourseTrack | 0) !== 2 || !this._vkSpinnerBodies || !this._vkSpinnerBodies.length) return;
      if (!dtSec || dtSec <= 0 || dtSec > 0.12) dtSec = 1 / 60;
      var spList = this._vkSpinnerBodies;
      var sl;
      for (sl = 0; sl < VK_MAX_SLOTS; sl++) {
        var body = this.carBodies[sl];
        if (!body) continue;
        var inp = this.inputs[sl];
        var thrust = inp ? Math.max(Math.abs(inp.trig || 0), Math.abs(inp.trigRev || 0)) : 0;
        var k = (14 * (1 - Math.min(thrust, 1)) + 4 * Math.min(thrust, 1)) * dtSec;
        if (k > 0.92) k = 0.92;
        var px = body.position.x;
        var py = body.position.y;
        var pz = body.position.z;
        var si;
        for (si = 0; si < spList.length; si++) {
          var sp = spList[si];
          if (!sp || sp.discR == null || sp.discHalfH == null) continue;
          var dr = sp.discR - PLAYER_R * 1.12;
          if (dr < 0.06) dr = 0.06;
          var dx = px - sp.cx;
          var dz = pz - sp.cz;
          if (dx * dx + dz * dz > dr * dr) continue;
          var surfY = sp.discY + sp.discHalfH;
          var ballBottom = py - PLAYER_R;
          if (ballBottom < surfY - 0.07 || ballBottom > surfY + 0.1) continue;
          var om = sp.wDisc;
          var vxPlat = om * (pz - sp.cz);
          var vzPlat = -om * (px - sp.cx);
          var dp = vxPlat * vxPlat + vzPlat * vzPlat;
          if (dp > 1e-10) {
            var vpLen = Math.sqrt(dp);
            var ux = vxPlat / vpLen;
            var uz = vzPlat / vpLen;
            var s = body.velocity.x * ux + body.velocity.z * uz;
            var sPlat = vpLen;
            /* s ≥ 0: motion with the shelf direction; s < 0 = counter to rim — do not pull toward +sPlat. */
            if (s >= -1e-4 && s < sPlat - 1e-4) {
              var sNew = s + (sPlat - s) * k;
              var vx = body.velocity.x;
              var vz = body.velocity.z;
              body.velocity.x = ux * sNew + (vx - ux * s);
              body.velocity.z = uz * sNew + (vz - uz * s);
            }
          }
          var wy = body.angularVelocity.y;
          if (wy * om >= -0.04 && (om - wy) * om > 1e-6) {
            body.angularVelocity.y += (om - wy) * k * 0.9;
          }
          break;
        }
      }
    },

    /**
     * Track 2 spinner kinematics. Cannon contacts use body.velocity / angularVelocity at the contact
     * point (see Body#getVelocityAtWorldPoint), so we set ω each frame; after world.step we optionally
     * re-apply pose only to undo Euler integration drift on kinematic bodies.
     * @param {number} nowMs
     * @param {{ reSnapPose?: boolean }} [opts] reSnapPose: only reset quaternions from closed form (after physics).
     */
    _vkTickTrack2Spinners: function (nowMs, opts) {
      if ((this._vkCourseTrack | 0) !== 2 || !this._vkSpinnerBodies || !this._vkSpinnerBodies.length) return;
      var reSnap = opts && opts.reSnapPose;
      var s = nowMs * 0.001;
      var si;
      var w = this;
      var barAlign = w._vkT2BarBodyAlign;
      for (si = 0; si < this._vkSpinnerBodies.length; si++) {
        var sp = this._vkSpinnerBodies[si];
        if (!sp || !sp.discBody || !sp.barBody) continue;
        var ad = sp.wDisc * s + sp.ph0;
        var ab = sp.wBar * s + sp.ph1;
        var hd = ad * 0.5;
        sp.discBody.quaternion.set(0, Math.sin(hd), 0, Math.cos(hd));
        if (barAlign && w._vkT2BarQy && w._vkT2BarQMul) {
          w._vkT2BarQy.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), ab);
          w._vkT2BarQy.mult(barAlign, w._vkT2BarQMul);
          sp.barBody.quaternion.copy(w._vkT2BarQMul);
        } else {
          var hb = ab * 0.5;
          sp.barBody.quaternion.set(0, Math.sin(hb), 0, Math.cos(hb));
        }
        if (!reSnap) {
          sp.discBody.velocity.set(0, 0, 0);
          sp.discBody.angularVelocity.set(0, sp.wDisc, 0);
          sp.barBody.velocity.set(0, 0, 0);
          sp.barBody.angularVelocity.set(0, sp.wBar, 0);
        }
        var cxx = sp.cx != null && isFinite(sp.cx) ? sp.cx : 0;
        var czz = sp.cz != null && isFinite(sp.cz) ? sp.cz : 0;
        var dy = sp.discY != null && isFinite(sp.discY) ? sp.discY : 0;
        var ay = sp.armY != null && isFinite(sp.armY) ? sp.armY : 0;
        sp.discBody.position.set(cxx, dy, czz);
        sp.barBody.position.set(cxx, ay, czz);
      }
    },

    /** Spawn above the top plinko row: one lane per gap between the four pillars (gapIdx 0..2). */
    _vkPlaceRockPlinkoDrop: function (body, gapIdx) {
      if (!body) return;
      var gxs = this._vkPlinkoGapXs;
      var gz = this._vkPlinkoRockSpawnZ;
      var dzJ = this._vkPlinkoRockSpawnDzJitter || 0;
      if (!gxs || gxs.length < 3 || gz == null || !isFinite(gz)) {
        body.position.set(0, 1.95, -3.55);
        body.velocity.set(0, -0.12, 0.42);
        body.angularVelocity.set((Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 2.2, (Math.random() - 0.5) * 2.2);
        return;
      }
      var gi = (gapIdx != null && isFinite(gapIdx) ? Math.floor(gapIdx) : 0) % 3;
      var oz = gz + (Math.random() - 0.5) * 2 * dzJ;
      var ox = gxs[gi] + (Math.random() - 0.5) * ROCK_R * 0.5;
      var baseY = 0.64 + VK_RAMP_GRADE * (this._vkSpawnZ - oz);
      var oy = baseY + ROCK_R * 1.12;
      body.position.set(ox, oy, oz);
      /* +Z = downhill along the ramp; release is slightly −Z of row 0 so rocks fall into the first gaps. */
      body.velocity.set((Math.random() - 0.5) * 0.36, -0.08, 0.22 + Math.random() * 0.18);
      body.angularVelocity.set((Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 2.4, (Math.random() - 0.5) * 2.4);
    },

    _addRockBody: function (active) {
      var THREE = window.THREE || (typeof AFRAME !== 'undefined' && AFRAME.THREE);
      if (!this._vkSoccerRockTex && THREE) {
        try {
          this._vkSoccerRockTex = vkBuildSoccerHazardRockTexture(THREE);
        } catch (eTex) {
          this._vkSoccerRockTex = null;
        }
      }
      var matOpts = {
        roughness: 0.42,
        metalness: 0.08
      };
      if (this._vkSoccerRockTex) {
        matOpts.map = this._vkSoccerRockTex;
        matOpts.color = 0xffffff;
      } else {
        matOpts.color = 0xff5533;
        matOpts.emissive = 0x441100;
        matOpts.emissiveIntensity = 0.2;
      }
      var mesh = new THREE.Mesh(new THREE.SphereGeometry(ROCK_R, 32, 24), new THREE.MeshStandardMaterial(matOpts));
      var el = document.createElement('a-entity');
      el.setObject3D('mesh', mesh);
      this._arenaRoot.appendChild(el);
      this.rockEls.push(el);
      var shape = new CANNON.Sphere(ROCK_R);
      var body = new CANNON.Body({
        mass: active ? ROCK_MASS : 0,
        material: this.rockMat,
        linearDamping: 0.02,
        angularDamping: 0.06
      });
      body.addShape(shape);
      var idx = this.rockBodies.length;
      if (!active) {
        if (typeof CANNON.Body.KINEMATIC !== 'undefined') {
          body.type = CANNON.Body.KINEMATIC;
          body.mass = 0;
          body.updateMassProperties();
        } else {
          body.type = CANNON.Body.STATIC;
        }
        body.position.set(118 + idx * 2.4, -10, 118);
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
      } else {
        body.type = CANNON.Body.DYNAMIC;
        this._vkPlaceRockPlinkoDrop(body, idx % 3);
      }
      this.world.addBody(body);
      this.rockBodies.push(body);
      this._vkRockIdleMs.push(0);
      this._vkRockActive.push(!!active);
    },

    _vkRecycleRock: function (idx, gapIdx) {
      var body = this.rockBodies[idx];
      if (!body) return;
      if (this.world.bodies.indexOf(body) !== -1) {
        this.world.removeBody(body);
      }
      body.type = CANNON.Body.DYNAMIC;
      body.mass = ROCK_MASS;
      body.material = this.rockMat;
      body.updateMassProperties();
      this._vkPlaceRockPlinkoDrop(body, gapIdx);
      body.force.set(0, 0, 0);
      body.torque.set(0, 0, 0);
      this.world.addBody(body);
      if (typeof body.wakeUp === 'function') body.wakeUp();
      if (this._vkRockActive) this._vkRockActive[idx] = true;
      if (this._vkRockIdleMs) this._vkRockIdleMs[idx] = 0;
    },

    /** Park all rock bodies off-world (kinematic) between rounds. */
    /** Park one rock off-world (same as cars when y < −0.42). */
    _vkDespawnRock: function (idx) {
      var body = this.rockBodies[idx];
      if (!body) return;
      if (this.world.bodies.indexOf(body) !== -1) {
        this.world.removeBody(body);
      }
      if (typeof CANNON.Body.KINEMATIC !== 'undefined') {
        body.type = CANNON.Body.KINEMATIC;
      } else {
        body.type = CANNON.Body.STATIC;
      }
      body.mass = 0;
      body.updateMassProperties();
      body.position.set(118 + idx * 2.4, -10, 118);
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      body.force.set(0, 0, 0);
      body.torque.set(0, 0, 0);
      this.world.addBody(body);
      if (this._vkRockActive) this._vkRockActive[idx] = false;
      if (this._vkRockIdleMs) this._vkRockIdleMs[idx] = 0;
    },

    _vkParkAllRocks: function () {
      var idx;
      for (idx = 0; idx < this.rockBodies.length; idx++) {
        this._vkDespawnRock(idx);
      }
    },

    /** Despawn rocks only when they fall off the world (same Y bound as contestants). */
    _vkTickRockHazardRecycleHost: function () {
      if (!this.vkMatchActive || !this.rockBodies.length) return;
      var rbi;
      for (rbi = 0; rbi < this.rockBodies.length; rbi++) {
        if (!this._vkRockActive || !this._vkRockActive[rbi]) continue;
        var Rb = this.rockBodies[rbi];
        if (!Rb) continue;
        if (Rb.position.y < -0.42) {
          this._vkDespawnRock(rbi);
        }
      }
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

    /**
     * Place the VR rig just behind this slot's start ball, looking uphill (−Z).
     */
    _applySpectatorTransform: function (slot) {
      if (!this._rig) return;
      var yawEl = this._rigYaw || this._rig;
      var sp = this._carSpawn && this._carSpawn[slot];
      if (!sp) {
        var s = VK_SPEC[slot] || VK_SPEC[0];
        this._rig.setAttribute('position', { x: s.ox, y: 0, z: s.oz });
        if (yawEl !== this._rig) this._rig.setAttribute('rotation', { x: 0, y: 0, z: 0 });
        yawEl.setAttribute('rotation', { x: 0, y: 0, z: 0 });
        this._vkResetCameraFollowAnchors(slot);
        return;
      }
      var behind = 1.65;
      var rigX = sp.x;
      var rigZ = sp.z + behind;
      var lookX = sp.x;
      var lookZ = sp.z - 2.8;
      var dx = lookX - rigX;
      var dz = lookZ - rigZ;
      var yDeg;
      var eps = 1e-6;
      if (dx * dx + dz * dz < eps * eps) {
        yDeg = 180;
      } else {
        /* Rig local −Z should align with world (dx,dz); atan2(-dx,dz) faced +Z (wrong). */
        yDeg = (Math.atan2(dx, -dz) * 180) / Math.PI;
      }
      this._rig.setAttribute('position', { x: rigX, y: 0, z: rigZ });
      if (yawEl !== this._rig) {
        this._rig.setAttribute('rotation', { x: 0, y: 0, z: 0 });
      }
      yawEl.setAttribute('rotation', { x: 0, y: yDeg, z: 0 });
      this._vkResetCameraFollowAnchors(slot);
    },

    /** World XZ where the spectator rig should sit for a slot (spawn anchor; same basis as _applySpectatorTransform). */
    _vkSpectatorAnchorXZ: function (slot) {
      var sp = this._carSpawn && this._carSpawn[slot];
      if (!sp) {
        var s = VK_SPEC[slot] || VK_SPEC[0];
        return { x: s.ox, z: s.oz };
      }
      var behind = 1.65;
      return { x: sp.x, z: sp.z + behind };
    },

    /**
     * Target Z-distance multiplier (1…MAX) from angle between horizontal carriage forward and ball→finish.
     * No lateral offset — only scales world +Z pull when turned >60° away from the goal, max at 180°.
     */
    _vkFollowCamYawDistTargetMul: function (bx, bz, cy) {
      var finZ =
        this._vkFinishZ != null && isFinite(this._vkFinishZ) ? this._vkFinishZ : VK_FINISH_LINE_Z;
      var gfx = -bx;
      var gfz = finZ - bz;
      var glen = Math.sqrt(gfx * gfx + gfz * gfz);
      if (glen < 0.04) {
        gfx = 0;
        gfz = 1;
        glen = 1;
      }
      gfx /= glen;
      gfz /= glen;
      var ucx = Math.sin(cy);
      var ucz = Math.cos(cy);
      var dot = clamp(ucx * gfx + ucz * gfz, -1, 1);
      var ang = Math.acos(dot);
      var t = 0;
      if (ang > VK_CAM_FOLLOW_YAW_DIST_MIN_RAD) {
        t = (ang - VK_CAM_FOLLOW_YAW_DIST_MIN_RAD) / (Math.PI - VK_CAM_FOLLOW_YAW_DIST_MIN_RAD);
        t = clamp(t, 0, 1);
      }
      return 1 + t * (VK_CAM_FOLLOW_YAW_DIST_MAX_MULT - 1);
    },

    /** Snap smoothed follow state to car-behind or current rig (call after spectator teleport). */
    _vkResetCameraFollowAnchors: function (slot) {
      if (!this._rig) return;
      var ms = typeof slot === 'number' ? slot | 0 : 0;
      if (ms < 0 || ms >= VK_MAX_SLOTS) ms = 0;
      var body = this.carBodies && this.carBodies[ms];
      if (body) {
        var cy =
          this._vkCarriageYawRad && typeof this._vkCarriageYawRad[ms] === 'number'
            ? this._vkCarriageYawRad[ms]
            : 0;
        this._vkFollowDistMulSn = this._vkFollowCamYawDistTargetMul(
          body.position.x,
          body.position.z,
          cy
        );
        var dz0 = VK_CAM_FOLLOW_WORLD_DZ * this._vkFollowDistMulSn;
        this._vkFollowSmX = body.position.x;
        this._vkFollowSmZ = body.position.z + dz0;
        var pry = this._rig.getAttribute('position');
        var py0 = pry && typeof pry.y === 'number' && isFinite(pry.y) ? pry.y : 0;
        this._vkFollowCarYBase = body.position.y;
        this._vkFollowRigYBase = py0;
        this._vkFollowSmY = py0;
      } else {
        this._vkFollowDistMulSn = 1;
        var ax = this._vkSpectatorAnchorXZ(ms);
        this._vkFollowSmX = ax.x;
        this._vkFollowSmZ = ax.z;
        this._vkFollowCarYBase = null;
        var prn = this._rig.getAttribute('position');
        var pyn = prn && typeof prn.y === 'number' && isFinite(prn.y) ? prn.y : 0;
        this._vkFollowRigYBase = pyn;
        this._vkFollowSmY = pyn;
      }
    },

    /**
     * XR: smoothly move vr-rig — XZ same as ball (+ world +Z back, yaw distance scale); Y follows car height
     * via aligned baseline, smoothed, with vertical target frozen while |vy| is jump/air-like.
     */
    _vkSmoothCameraFollow: function (dtSec, inp) {
      if (window._vlVkCamFollow === false) return;
      if (!this._rig) return;
      var scn = this.el.sceneEl || this.el;
      var renderer = this.el.renderer;
      var xrOn = !!(renderer && renderer.xr && renderer.xr.isPresenting);
      if (!xrOn) return;
      var vm = scn.components && scn.components['vr-menu'];
      if (vm && vm.menuVisible) return;
      if (!inp) inp = {};
      var ms = this.mySlot | 0;
      if (ms < 0 || ms >= VK_MAX_SLOTS) ms = 0;
      var tgtX;
      var tgtZ;
      var body = this.carBodies && this.carBodies[ms];
      var followBall = !!body;
      var alphaM = 1 - Math.exp(-VK_CAM_FOLLOW_DIST_MUL_HZ * dtSec);
      if (!isFinite(this._vkFollowDistMulSn)) this._vkFollowDistMulSn = 1;
      if (followBall) {
        var cy =
          this._vkCarriageYawRad && typeof this._vkCarriageYawRad[ms] === 'number'
            ? this._vkCarriageYawRad[ms]
            : 0;
        var tgtMul = this._vkFollowCamYawDistTargetMul(body.position.x, body.position.z, cy);
        this._vkFollowDistMulSn += (tgtMul - this._vkFollowDistMulSn) * alphaM;
        var dz = VK_CAM_FOLLOW_WORLD_DZ * this._vkFollowDistMulSn;
        tgtX = body.position.x;
        tgtZ = body.position.z + dz;
      } else {
        /* No car body yet (e.g. before course init): fall back to spawn anchor only. */
        this._vkFollowDistMulSn += (1 - this._vkFollowDistMulSn) * alphaM;
        var ax = this._vkSpectatorAnchorXZ(ms);
        tgtX = ax.x;
        tgtZ = ax.z;
      }
      var alpha = 1 - Math.exp(-VK_CAM_FOLLOW_POS_HZ * dtSec);
      var alphaY = 1 - Math.exp(-VK_CAM_FOLLOW_POS_Y_HZ * dtSec);
      if (!isFinite(this._vkFollowSmX) || !isFinite(this._vkFollowSmZ)) {
        this._vkFollowSmX = tgtX;
        this._vkFollowSmZ = tgtZ;
      } else {
        this._vkFollowSmX += (tgtX - this._vkFollowSmX) * alpha;
        this._vkFollowSmZ += (tgtZ - this._vkFollowSmZ) * alpha;
      }
      var tgtRigY;
      if (followBall) {
        if (this._vkFollowCarYBase == null || !isFinite(this._vkFollowCarYBase)) {
          var prb = this._rig.getAttribute('position');
          var pyb = prb && typeof prb.y === 'number' && isFinite(prb.y) ? prb.y : 0;
          this._vkFollowCarYBase = body.position.y;
          this._vkFollowRigYBase = pyb;
          if (!isFinite(this._vkFollowSmY)) this._vkFollowSmY = pyb;
        }
        var vy = body.velocity && typeof body.velocity.y === 'number' ? body.velocity.y : 0;
        if (Math.abs(vy) > VK_CAM_FOLLOW_Y_AIR_VY) {
          tgtRigY = this._vkFollowSmY;
        } else {
          tgtRigY = this._vkFollowRigYBase + (body.position.y - this._vkFollowCarYBase);
        }
      } else {
        this._vkFollowCarYBase = null;
        tgtRigY = 0;
      }
      if (!isFinite(this._vkFollowSmY)) this._vkFollowSmY = tgtRigY;
      this._vkFollowSmY += (tgtRigY - this._vkFollowSmY) * alphaY;
      var yLo = 0.12;
      var yHi = 3.6;
      var py = this._vkFollowSmY;
      if (py < yLo) py = yLo;
      if (py > yHi) py = yHi;
      this._vkFollowSmY = py;
      this._rig.setAttribute('position', { x: this._vkFollowSmX, y: py, z: this._vkFollowSmZ });
    },

    _bodyDirWorld: function (body, lx, ly, lz) {
      var q = new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      this.tmpVec.set(lx, ly, lz);
      this.tmpVec.applyQuaternion(q);
      return this.tmpVec;
    },

    _vkScheduleHandBindRetries: function () {
      var self = this;
      if (this._vkHandBindIv) {
        clearInterval(this._vkHandBindIv);
        this._vkHandBindIv = null;
      }
      this._vkHandBindTries = 0;
      this._vkHandBindIv = setInterval(function () {
        self._vkTryBindHandsOnce();
        self._vkHandBindTries++;
        if (self._vkHandBindTries > 90 || (self._vkRightAHandlersBound && self._vkRightBHandlersBound)) {
          clearInterval(self._vkHandBindIv);
          self._vkHandBindIv = null;
        }
      }, 100);
    },

    _vkTryBindHandsOnce: function () {
      if (!this._vkRightAHandlersBound) this._vkBindRightAButton();
      if (!this._vkRightBHandlersBound) this._vkBindRightBButton();
    },

    _vkGetGamepadFromHand: function (handEl) {
      if (!handEl || !handEl.components) return null;
      var names = [
        'oculus-touch-controls',
        'meta-touch-controls',
        'pico-controls',
        'windows-motion-controls',
        'generic-tracked-controls'
      ];
      var i;
      for (i = 0; i < names.length; i++) {
        var comp = handEl.components[names[i]];
        var g = comp && comp.controller && comp.controller.gamepad;
        if (g) return g;
      }
      var tc = handEl.components['tracked-controls'];
      if (tc && tc.controller && tc.controller.gamepad) return tc.controller.gamepad;
      return null;
    },

    _vkReadGamepadButton: function (btn) {
      if (!btn) return 0;
      if (btn.pressed) return 1;
      var v = btn.value;
      return typeof v === 'number' && isFinite(v) ? v : 0;
    },

    _vkBindRightAButton: function () {
      var self = this;
      if (this._vkRightAHandlersBound) return;
      var rh = vkHandEl('rightHand', 'vl-hand-right');
      if (!rh) return;
      this._vkRightAHandlersBound = true;
      this._vkRightHandAHook = rh;
      this._vkOnAbuttondown = function () {
        self._vkRightAPressEdge = true;
      };
      rh.addEventListener('abuttondown', this._vkOnAbuttondown);
    },

    _vkBindRightBButton: function () {
      var self = this;
      if (this._vkRightBHandlersBound) return;
      var rh = vkHandEl('rightHand', 'vl-hand-right');
      if (!rh) return;
      this._vkRightBHandlersBound = true;
      this._vkRightHandBHook = rh;
      this._vkOnBbuttondown = function () {
        /* Host: do not write inputs[] here — tick replaces inputs from gather and would erase j. */
        if (self.isHost) self._vkPendingBJumpEdge = true;
        else self._vkPendingJ = 1;
        self._pulseHand(rh, 0.42, 45);
      };
      rh.addEventListener('bbuttondown', this._vkOnBbuttondown);
    },

    _vkHandWorld: function (handEl, outPos, outQuat) {
      if (!handEl || !handEl.object3D) return false;
      handEl.object3D.updateMatrixWorld(true);
      handEl.object3D.getWorldPosition(outPos);
      handEl.object3D.getWorldQuaternion(outQuat);
      return true;
    },

    /** Body-local direction → world (same convention as VRLeague ` _bodyDirWorld`). */
    _vkBodyDirWorld: function (body, lx, ly, lz) {
      var q = this._tmpQ;
      q.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      this.tmpVec.set(lx, ly, lz);
      this.tmpVec.applyQuaternion(q);
      return this.tmpVec;
    },

    /**
     * World thrust direction for triggers: matches the *carriage* heading (see _vkCarriageYawRad), not body +Z.
     * A rolling sphere’s local +Z flips in world space, which made “forward” trigger sometimes push backward.
     * Blends a bit of _vkUphill so the ramp still gets climb component.
     * If VK_THRUST_FOLLOWS_CAGE_LEAN, _applyCarControls rotates this vector by the smoothed cage lean.
     */
    _vkThrustDirForSlot: function (slot) {
      var cy =
        this._vkCarriageYawRad && typeof this._vkCarriageYawRad[slot] === 'number'
          ? this._vkCarriageYawRad[slot]
          : 0;
      var uh = this._vkUphill;
      var fhx = Math.sin(cy);
      var fhz = Math.cos(cy);
      var blend = 0.16;
      var vx = fhx * (1 - blend) + uh.x * blend;
      var vy = uh.y * blend * 0.95;
      var vz = fhz * (1 - blend) + uh.z * blend;
      var len = Math.sqrt(vx * vx + vy * vy + vz * vz);
      var o = this._vkThrustDir;
      if (len > 1e-7) {
        o.set(vx / len, vy / len, vz / len);
      } else {
        o.set(fhx, 0, fhz);
      }
      return o;
    },

    /**
     * Apply smoothed cage lean to a world-space thrust unit vector: express in carriage frame, apply the same
     * qRoll * qPitch as the lean pivot mesh, map back to world, then optionally add a lateral bias for roll
     * (see VK_LEAN_ROLL_THRUST_LATERAL).
     */
    _vkRotateWorldDirByCageLean: function (slot, vec3) {
      if (!VK_THRUST_FOLLOWS_CAGE_LEAN) return;
      if (!this._vkCubeLeanPitchSn || !this._vkCubeLeanRollSn) return;
      var pSn = this._vkEffectiveLeanPitchSlot(slot);
      var rSn = this._vkEffectiveLeanRollSlot(slot);
      if (Math.abs(pSn) < 1e-7 && Math.abs(rSn) < 1e-7) return;
      var cy =
        this._vkCarriageYawRad && typeof this._vkCarriageYawRad[slot] === 'number'
          ? this._vkCarriageYawRad[slot]
          : 0;
      this._vkCarriageQ.setFromAxisAngle(this._vkWorldUp, cy);
      this._vkCarriageQInv.copy(this._vkCarriageQ).invert();
      this._vkLeanQPitch.setFromAxisAngle(this._vkLeanAxisX, pSn);
      this._vkLeanQRoll.setFromAxisAngle(this._vkLeanAxisZ, rSn);
      this._vkLeanQComb.multiplyQuaternions(this._vkLeanQRoll, this._vkLeanQPitch);
      this.tmpVec.copy(vec3);
      this.tmpVec.applyQuaternion(this._vkCarriageQInv);
      this.tmpVec.applyQuaternion(this._vkLeanQComb);
      this.tmpVec.applyQuaternion(this._vkCarriageQ);
      vec3.copy(this.tmpVec);
      var len = Math.sqrt(vec3.x * vec3.x + vec3.y * vec3.y + vec3.z * vec3.z);
      if (len > 1e-7) vec3.multiplyScalar(1 / len);
      if (VK_LEAN_ROLL_THRUST_LATERAL > 0 && Math.abs(rSn) > 1e-7) {
        var ux = this._vkWorldUp.x;
        var uy = this._vkWorldUp.y;
        var uz = this._vkWorldUp.z;
        var vx = vec3.x;
        var vy = vec3.y;
        var vz = vec3.z;
        var sx = uy * vz - uz * vy;
        var sy = uz * vx - ux * vz;
        var sz = ux * vy - uy * vx;
        var sLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
        if (sLen > 1e-7) {
          var k = Math.sin(rSn) * VK_LEAN_ROLL_THRUST_LATERAL;
          sx *= k / sLen;
          sy *= k / sLen;
          sz *= k / sLen;
          vec3.x += sx;
          vec3.y += sy;
          vec3.z += sz;
          len = Math.sqrt(vec3.x * vec3.x + vec3.y * vec3.y + vec3.z * vec3.z);
          if (len > 1e-7) vec3.multiplyScalar(1 / len);
        }
      }
    },

    _gatherLocalInput: function () {
      var out = zeroInput();
      var scn = this.el.sceneEl || this.el;
      var vm = scn.components && scn.components['vr-menu'];
      if (vm && vm.menuVisible) {
        this._vkGripPanLInited = false;
        this._vkGripPanRInited = false;
        this._vkGripJumpLatchedL = false;
        this._vkGripJumpLatchedR = false;
        this._vkTwoHand = null;
        return out;
      }
      var kb = this.keys || {};
      var pitch = (kb['ArrowUp'] ? 1 : 0) + (kb['ArrowDown'] ? -1 : 0);
      var roll = (kb['ArrowLeft'] ? -1 : 0) + (kb['ArrowRight'] ? 1 : 0);
      var yaw = (kb['KeyA'] ? 1 : 0) + (kb['KeyD'] ? -1 : 0);
      var renderer = this.el.renderer;
      var lp = this._vkGatherLp;
      var rp = this._vkGatherRp;
      var lq = this._vkGatherLq;
      var rq = this._vkGatherRq;
      var gotL = false;
      var gotR = false;
      var aNow = false;
      var xrOn = !!(renderer && renderer.xr && renderer.xr.isPresenting);

      if (xrOn) {
        var session = renderer.xr.getSession ? renderer.xr.getSession() : null;
        var lh = vkHandEl('leftHand', 'vl-hand-left');
        var rh = vkHandEl('rightHand', 'vl-hand-right');
        var gpL = this._vkGetGamepadFromHand(lh);
        var gpR = this._vkGetGamepadFromHand(rh);
        var lxAdd = 0;
        var rxAdd = 0;
        var ryAdd = 0;
        var bHeld = false;
        if (session && session.inputSources) {
          var si;
          for (si = 0; si < session.inputSources.length; si++) {
            var src = session.inputSources[si];
            if (!src || !src.gamepad) continue;
            var sax = src.gamepad.axes || [];
            var sbt = src.gamepad.buttons || [];
            if (src.handedness === 'right') {
              rxAdd = vkMaxSignedMag(rxAdd, vkPickStickX(sax));
              ryAdd = vkMaxSignedMag(ryAdd, vkPickStickY(sax));
              out.trig = Math.max(out.trig, this._vkReadGamepadButton(sbt[0]));
              out.gripRVal = Math.max(out.gripRVal, this._vkReadGamepadButton(sbt[1]));
              var abA0 = sbt[3];
              if (abA0) aNow = aNow || !!(abA0.pressed || (abA0.value || 0) > 0.35);
              var abB0 = sbt[5] || sbt[4];
              if (abB0) bHeld = bHeld || !!(abB0.pressed || (abB0.value || 0) > 0.35);
            } else if (src.handedness === 'left') {
              lxAdd = vkMaxSignedMag(lxAdd, vkPickStickX(sax));
              out.trigRev = Math.max(out.trigRev, this._vkReadGamepadButton(sbt[0]) * 0.98);
              out.gripLVal = Math.max(out.gripLVal, this._vkReadGamepadButton(sbt[1]));
            }
          }
        }
        if (gpR) {
          var axR = gpR.axes || [];
          var btR = gpR.buttons || [];
          rxAdd = vkMaxSignedMag(rxAdd, vkPickStickX(axR));
          ryAdd = vkMaxSignedMag(ryAdd, vkPickStickY(axR));
          out.trig = Math.max(out.trig, this._vkReadGamepadButton(btR[0]));
          out.gripRVal = Math.max(out.gripRVal, this._vkReadGamepadButton(btR[1]));
          var abA = btR[3];
          if (abA) {
            aNow = aNow || !!(abA.pressed || (abA.value || 0) > 0.35);
          }
          var abB = btR[5] || btR[4];
          if (abB) bHeld = bHeld || !!(abB.pressed || (abB.value || 0) > 0.35);
        }
        if (bHeld && !this._vkPrevBGamepadXR) out.j = 1;
        this._vkPrevBGamepadXR = bHeld;
        if (gpL) {
          var axL = gpL.axes || [];
          var btL = gpL.buttons || [];
          lxAdd = vkMaxSignedMag(lxAdd, vkPickStickX(axL));
          out.trigRev = Math.max(out.trigRev, this._vkReadGamepadButton(btL[0]) * 0.98);
          out.gripLVal = Math.max(out.gripLVal, this._vkReadGamepadButton(btL[1]));
        }
        /* Some runtimes omit handedness on inputSources — fall back to getGamepads(). */
        if (Math.abs(lxAdd) < 0.02) {
          var pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : null;
          if (pads) {
            var pi;
            for (pi = 0; pi < pads.length; pi++) {
              var gpx = pads[pi];
              if (!gpx || !gpx.axes || !gpx.axes.length) continue;
              if (gpx.hand === 'left' || (gpx.hand !== 'right' && pi === 0)) {
                lxAdd = vkMaxSignedMag(lxAdd, vkPickStickX(gpx.axes));
              }
            }
          }
        }
        yaw -= lxAdd;
        roll += rxAdd;
        pitch -= ryAdd;
        out.grip = Math.max(out.gripLVal, out.gripRVal);
        var glv = out.gripLVal || 0;
        var grv = out.gripRVal || 0;
        var pulseL = false;
        var pulseR = false;
        if (this._vkGripJumpLatchedL) {
          if (glv < VK_GRIP_JUMP_RELEASE) this._vkGripJumpLatchedL = false;
        } else if (glv >= VK_GRIP_JUMP_PRESS) {
          out.j = 1;
          this._vkGripJumpLatchedL = true;
          pulseL = true;
        }
        if (this._vkGripJumpLatchedR) {
          if (grv < VK_GRIP_JUMP_RELEASE) this._vkGripJumpLatchedR = false;
        } else if (grv >= VK_GRIP_JUMP_PRESS) {
          out.j = 1;
          this._vkGripJumpLatchedR = true;
          pulseR = true;
        }
        if (pulseL) this._pulseHand(vkHandEl('leftHand', 'vl-hand-left'), 0.34, 40);
        if (pulseR) this._pulseHand(vkHandEl('rightHand', 'vl-hand-right'), 0.34, 40);
        gotL = this._vkHandWorld(lh, lp, lq);
        gotR = this._vkHandWorld(rh, rp, rq);
      } else {
        this._vkGripJumpLatchedL = false;
        this._vkGripJumpLatchedR = false;
        if (kb['KeyR']) {
          if (!this._vkPrevRkey) out.aEdge = 1;
          this._vkPrevRkey = true;
        } else {
          this._vkPrevRkey = false;
        }
        if (kb['Space']) out.trig = 1;
        if (kb['KeyC']) out.trigRev = 1;
        if (kb['KeyB']) {
          if (!this._vkPrevBKeyDesk) out.j = 1;
          this._vkPrevBKeyDesk = true;
        } else {
          this._vkPrevBKeyDesk = false;
        }
        gotR = false;
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

      if (xrOn) {
        if (this._vkRightAPressEdge) {
          out.aEdge = 1;
          this._vkRightAPressEdge = false;
          this._vkPrevA = true;
        } else {
          out.aEdge = aNow && !this._vkPrevA ? 1 : 0;
          this._vkPrevA = !!aNow;
        }
      } else {
        if (!out.aEdge) {
          out.aEdge = aNow && !this._vkPrevA ? 1 : 0;
        }
        this._vkPrevA = !!aNow;
      }

      out.lx = clamp(yaw, -1, 1);
      out.rx = clamp(roll, -1, 1);
      out.ry = clamp(pitch, -1, 1);
      out.trig = clamp(out.trig, 0, 1);
      out.trigRev = clamp(out.trigRev, 0, 1);
      if (vkGetCameraWorldPosition(scn, this.tmpVec)) {
        out.camOk = 1;
        out.camx = this.tmpVec.x;
        out.camy = this.tmpVec.y;
        out.camz = this.tmpVec.z;
      }
      out.autoRoll = window._vlAutoRollEnabled !== false ? 1 : 0;
      return out;
    },

    /**
     * XR rig grip locomotion (disabled): the VR rig follows the car; left/right squeeze is jump
     * (see `_gatherLocalInput`). Kept as a no-op that clears stale grip-pan state.
     */
    _vkApplyRigLocomotion: function (inp) {
      var renderer = this.el.renderer;
      if (!renderer || !renderer.xr || !renderer.xr.isPresenting || !this._rig) return;
      var scn = this.el.sceneEl || this.el;
      var vm = scn.components && scn.components['vr-menu'];
      if (vm && vm.menuVisible) {
        this._vkGripPanLInited = false;
        this._vkGripPanRInited = false;
        this._vkTwoHand = null;
        return;
      }
      this._vkGripPanLInited = false;
      this._vkGripPanRInited = false;
      this._vkTwoHand = null;
    },

    _applyCarControls: function (slot, inp, dtSec) {
      var body = this.carBodies[slot];
      if (!body || !inp) return;
      if (!dtSec || dtSec <= 0 || dtSec > 0.12) dtSec = 1 / 60;
      var botSlot = this.isHost && !this._vkIsHumanOccupyingSlot(slot);
      var tScale = botSlot ? VK_HELI_TORQUE_SCALE * VK_BOT_TORQUE_SCALE : VK_HELI_TORQUE_SCALE;
      var fThrust = botSlot ? VK_THRUST_FORWARD * VK_BOT_THRUST_SCALE : VK_THRUST_FORWARD;
      var autoRollAssist =
        (inp.autoRoll === undefined || inp.autoRoll === 1 || inp.autoRoll === true) &&
        (this._vkIsHumanOccupyingSlot(slot) || botSlot);

      var cyEnter =
        this._vkCarriageYawRad && typeof this._vkCarriageYawRad[slot] === 'number'
          ? this._vkCarriageYawRad[slot]
          : 0;
      var fhx0 = Math.sin(cyEnter);
      var fhz0 = Math.cos(cyEnter);
      var vFwdCarriage = body.velocity.x * fhx0 + body.velocity.z * fhz0;
      var lx = inp.lx || 0;
      var yawRateScale = botSlot ? VK_BOT_TORQUE_SCALE : 1;
      var baseYawDelta = 0;
      if (this._vkCarriageYawRad && Math.abs(lx) > 0.012) {
        baseYawDelta = lx * VK_CUBE_STICK_YAW_SPEED * dtSec * yawRateScale;
      }
      var yawCmdRadPerSec = baseYawDelta / dtSec;
      var yawScale = 1;
      if (!botSlot && this._vkCarriageYawRad && this._vkCubeLeanRollSn && this._vkLeanDynRoll) {
        var stickR = this._vkCubeLeanRollSn[slot] || 0;
        var dynR = this._vkLeanDynRoll[slot] || 0;
        yawScale = this._vkMotorcycleYawScale(yawCmdRadPerSec, vFwdCarriage, stickR, dynR);
      }
      if (this._vkCarriageYawRad && baseYawDelta !== 0) {
        this._vkCarriageYawRad[slot] += baseYawDelta * yawScale;
      }
      var cyAfter =
        this._vkCarriageYawRad && typeof this._vkCarriageYawRad[slot] === 'number'
          ? this._vkCarriageYawRad[slot]
          : cyEnter;
      var dYawFrame = cyAfter - cyEnter;
      while (dYawFrame > Math.PI) dYawFrame -= Math.PI * 2;
      while (dYawFrame < -Math.PI) dYawFrame += Math.PI * 2;
      var yawRateFrame = dYawFrame / dtSec;
      this._vkStepDynamicLeanForSlot(slot, dtSec, yawRateFrame, body);

      /* Right stick only: local (pitch, 0, roll) torque → world via body quat — left stick does not spin the ball. */
      var pitch = inp.ry || 0;
      var roll = inp.rx || 0;
      if (autoRollAssist) {
        roll = 0;
      }
      var stickHeli = botSlot ? 1 : VK_LEAN_RIGHTSTICK_BALL_TORQUE;
      this.tmpVec2.set(pitch * tScale * stickHeli, 0, roll * tScale * stickHeli);
      this._tmpQ.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      this.tmpVec2.applyQuaternion(this._tmpQ);
      body.torque.x += this.tmpVec2.x;
      body.torque.y += this.tmpVec2.y;
      body.torque.z += this.tmpVec2.z;

      var trig = inp.trig || 0;
      var trigRev = inp.trigRev || 0;
      /* No forward/reverse thrust until GO (bots already get trig=0 from _vkGoalSeekBotFill pre-GO). */
      if (this.vkMatchActive && !this.vkMatchStartMs) {
        trig = 0;
        trigRev = 0;
      }
      var td = this._vkThrustDirForSlot(slot);
      this._vkRotateWorldDirByCageLean(slot, td);
      var tdx = td.x;
      var tdy = td.y;
      var tdz = td.z;
      if (botSlot && trig > 0 && VK_BOT_THRUST_GRUNT > 0 && VK_BOT_THRUST_TAPER_SPEED > 1e-4) {
        var vxf = body.velocity.x;
        var vyf = body.velocity.y;
        var vzf = body.velocity.z;
        var vFwd = vxf * tdx + vyf * tdy + vzf * tdz;
        var forwardSpeed = vFwd > 0 ? vFwd : 0;
        var taper = clamp(1 - forwardSpeed / VK_BOT_THRUST_TAPER_SPEED, 0, 1);
        fThrust *= 1 + VK_BOT_THRUST_GRUNT * taper;
      }
      var stickPitch = (this._vkCubeLeanPitchSn && this._vkCubeLeanPitchSn[slot]) || 0;
      var fwdLeanSigned = stickPitch * VK_LEAN_FWD_PITCH_THRUST_SIGN;
      var fwdLean01 =
        fwdLeanSigned > 0 ? clamp(fwdLeanSigned / VK_CUBE_LEAN_MAX_RAD, 0, 1) : 0;
      var fThrustForward = fThrust * (1 + VK_LEAN_FWD_THRUST_BONUS * fwdLean01);
      if (trig > 0) {
        body.force.x += tdx * trig * fThrustForward;
        body.force.y += tdy * trig * fThrustForward;
        body.force.z += tdz * trig * fThrustForward;
      }
      if (trigRev > 0) {
        var rScale = fThrust * VK_THRUST_REVERSE_SCALE;
        body.force.x -= tdx * trigRev * rScale;
        body.force.y -= tdy * trigRev * rScale;
        body.force.z -= tdz * trigRev * rScale;
      }

      if (autoRollAssist) {
        var fwx = tdx;
        var fwy = tdy;
        var fwz = tdz;
        var fy = fwy;
        var px = -fy * fwx;
        var py = 1 - fy * fy;
        var pz = -fy * fwz;
        var lenSq = px * px + py * py + pz * pz;
        if (lenSq >= VK_AUTO_ROLL_LEVEL_MIN_LEN_SQ) {
          var invL = 1 / Math.sqrt(lenSq);
          var tLx = px * invL;
          var tLy = py * invL;
          var tLz = pz * invL;
          var uB = this._vkBodyDirWorld(body, 0, 1, 0);
          var ex = uB.y * tLz - uB.z * tLy;
          var ey = uB.z * tLx - uB.x * tLz;
          var ez = uB.x * tLy - uB.y * tLx;
          var tqx = ex * VK_AUTO_ROLL_UP_KP;
          var tqy = ey * VK_AUTO_ROLL_UP_KP;
          var tqz = ez * VK_AUTO_ROLL_UP_KP;
          var tH = Math.sqrt(tqx * tqx + tqy * tqy + tqz * tqz);
          if (tH > VK_AUTO_ROLL_UP_MAX) {
            var tS = VK_AUTO_ROLL_UP_MAX / tH;
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
          var wRoll = wx * fwx + wy * fwy + wz * fwz;
          var kdR = VK_AUTO_ROLL_UP_KD * wRoll;
          body.torque.x -= kdR * fwx;
          body.torque.y -= kdR * fwy;
          body.torque.z -= kdR * fwz;
        }
      }
    },

    /** Last-resort if Cannon misses a floor contact — respawn instead of falling forever. */
    _vkEnsurePlayersOnTrack: function () {
      if (!this.isHost) return;
      var i;
      for (i = 0; i < VK_MAX_SLOTS; i++) {
        var b = this.carBodies[i];
        if (!b) continue;
        if (b.position.y < -0.42) {
          /* Same as A reset: new random grid lane for this slot only (humans + bots), then snap pose. */
          this._vkInstantResetSlot(i, true);
        }
      }
    },

    /**
     * Pick a recording for this car’s spawn lane. Prefer exact `spawnLaneIdx` from library.
     * @param {boolean} [playFromNow] if true, bot restarts at frame 0 of the clip (after respawn); else sync to match clock.
     */
    _vkRepickGhostForSlot: function (slot, playFromNow) {
      if (!this.isHost) return;
      if (this._vkIsHumanOccupyingSlot(slot)) return;
      var lib = this._vkGhostLibraryForBots();
      var lanePref =
        this._vkSlotSpawnLaneIdx && typeof this._vkSlotSpawnLaneIdx[slot] === 'number'
          ? this._vkSlotSpawnLaneIdx[slot] | 0
          : 0;
      if (!this._vkBotGhost[slot]) {
        this._vkBotGhost[slot] = { rec: null, recIdx: 0, recoverUntil: 0, playT0: null };
      }
      if (!lib.length) {
        this._vkBotGhost[slot].rec = null;
        this._vkBotGhost[slot].recoverUntil = 0;
        this._vkBotGhost[slot].playT0 = null;
        return;
      }
      var pickR2 = this._vkSelectGhostForBotSlot(lib, lanePref);
      this._vkBotGhost[slot].rec = pickR2;
      this._vkBotGhost[slot].spineSrc = this._vkSpineSrcForRun(pickR2);
      this._vkBotGhost[slot].recIdx = 0;
      this._vkBotGhost[slot].recoverUntil = 0;
      this._vkBotGhost[slot].playT0 = playFromNow ? performance.now() : null;
    },

    /** Choose a run for the bot: lane match (stored or inferred legacy), else lane-sorted pool. */
    _vkSelectGhostForBotSlot: function (lib, laneIdx) {
      if (!lib || !lib.length) return null;
      lib = vkFilterPlayableGhostRuns(lib);
      if (!lib.length) return null;
      var phx = this._vkPathHalfX || 2.35;
      var z0 = this._vkSpawnBaseZ;
      var rot = (window.isMultiplayer ? 0 : this._vkMatchSpawnRot || 0) % 4;
      var want = laneIdx | 0;
      var exact = vkGhostRunsLaneMatches(lib, want, phx, z0, rot);
      if (exact.length) {
        return exact[Math.floor(Math.random() * exact.length)];
      }
      var sorted = vkSortGhostRunsLaneFirst(lib, want, phx, z0, rot);
      return sorted.length ? sorted[Math.floor(Math.random() * sorted.length)] : null;
    },

    /**
     * Host: choose distinct start lanes (0–15) for this match — shuffle with bias toward lanes that
     * appear on saved ghosts for the current spawnRot (so recordings line up more often).
     */
    _vkPickRandomSpawnLanesHost: function () {
      var rot = this._vkMatchSpawnRot | 0;
      var lib = vkFilterPlayableGhostRuns(vkGhostRunsForSpawnRot(rot, this._vkCourseTrack));
      var pref = {};
      var pi;
      for (pi = 0; pi < lib.length; pi++) {
        var R = lib[pi];
        if (!R || R.spawnLaneIdx == null) continue;
        var L = R.spawnLaneIdx | 0;
        if (L >= 0 && L < VK_SPAWN_LANE_COUNT) pref[L] = true;
      }
      var prefLanes = [];
      var otherLanes = [];
      var L;
      for (L = 0; L < VK_SPAWN_LANE_COUNT; L++) {
        if (pref[L]) prefLanes.push(L);
        else otherLanes.push(L);
      }
      vkShuffleInPlace(prefLanes);
      vkShuffleInPlace(otherLanes);
      var pool = prefLanes.concat(otherLanes);
      var chosen = pool.slice(0, VK_MAX_SLOTS);
      vkShuffleInPlace(chosen);
      var slotsPerm = [];
      var sp;
      for (sp = 0; sp < VK_MAX_SLOTS; sp++) slotsPerm.push(sp);
      vkShuffleInPlace(slotsPerm);
      if (!this._vkSlotSpawnLaneIdx || this._vkSlotSpawnLaneIdx.length < VK_MAX_SLOTS) {
        this._vkSlotSpawnLaneIdx = [0, 1, 2, 3, 8, 9, 10, 11];
      }
      for (var si = 0; si < VK_MAX_SLOTS; si++) {
        this._vkSlotSpawnLaneIdx[slotsPerm[si]] = chosen[si] % VK_SPAWN_LANE_COUNT;
      }
      this._vkNudgeBotSlotsOntoRecordingLanesHost();
    },

    /**
     * After the base lane deal, try to put each *bot* car on a lane that has a saved recording (green pad), if one is free.
     */
    _vkNudgeBotSlotsOntoRecordingLanesHost: function () {
      if (!this.isHost) return;
      if (!this._vkSlotSpawnLaneIdx || this._vkSlotSpawnLaneIdx.length < VK_MAX_SLOTS) return;
      var rrot = (this._vkMatchSpawnRot | 0) % 4;
      var recM = this._vkLanesWithRecordingMask(rrot);
      var anyRec = false;
      var a;
      for (a in recM) {
        if (recM[a]) {
          anyRec = true;
          break;
        }
      }
      if (!anyRec) return;
      var sb;
      for (sb = 0; sb < VK_MAX_SLOTS; sb++) {
        if (this._vkIsHumanOccupyingSlot(sb)) continue;
        var myL = this._vkSlotSpawnLaneIdx[sb] | 0;
        if (recM[myL]) continue;
        var used = {};
        var j;
        for (j = 0; j < VK_MAX_SLOTS; j++) {
          if (j !== sb) used[this._vkSlotSpawnLaneIdx[j] | 0] = true;
        }
        var alt = [];
        var L;
        for (L = 0; L < VK_SPAWN_LANE_COUNT; L++) {
          if (!recM[L] || used[L]) continue;
          if (L !== myL) alt.push(L);
        }
        if (!alt.length) {
          for (L = 0; L < VK_SPAWN_LANE_COUNT; L++) {
            if (recM[L] && !used[L]) alt.push(L);
          }
        }
        if (!alt.length) continue;
        vkShuffleInPlace(alt);
        this._vkSlotSpawnLaneIdx[sb] = alt[0] % VK_SPAWN_LANE_COUNT;
      }
    },

    /**
     * Host: give the just-finished run to every racing bot that does not already have a spine (`rec` null).
     * @param {number} finishSlot index 0–7 of who crossed (must match frames owner — local human in solo/MP host).
     */
    _vkGiveFinishedRecordingToBot: function (framesCopy, durationMs, finishSlot) {
      if (!this.isHost || !framesCopy || framesCopy.length < 12) return;
      var fs = typeof finishSlot === 'number' ? finishSlot | 0 : this.mySlot | 0;
      if (fs < 0 || fs >= VK_MAX_SLOTS) fs = this.mySlot | 0;
      var candidates = [];
      var s;
      for (s = 0; s < VK_MAX_SLOTS; s++) {
        if (s === fs) continue;
        if (this._vkFinished[s]) continue;
        if (this._vkIsHumanOccupyingSlot(s)) continue;
        candidates.push(s);
      }
      if (!candidates.length) return;
      var laneFin =
        this._vkSlotSpawnLaneIdx && typeof this._vkSlotSpawnLaneIdx[fs] === 'number'
          ? this._vkSlotSpawnLaneIdx[fs] | 0
          : 0;
      var livePayload = {
        durationMs: durationMs | 0,
        spawnRot: this._vkMatchSpawnRot | 0,
        spawnLaneIdx: laneFin % VK_SPAWN_LANE_COUNT,
        frames: framesCopy
      };
      var tAssign = performance.now();
      var ci;
      for (ci = 0; ci < candidates.length; ci++) {
        var slot = candidates[ci];
        if (!this._vkBotGhost[slot]) {
          this._vkBotGhost[slot] = { rec: null, recIdx: 0, recoverUntil: 0, playT0: null };
        }
        if (this._vkBotGhost[slot].rec) continue;
        this._vkBotGhost[slot].rec = livePayload;
        this._vkBotGhost[slot].recIdx = 0;
        this._vkBotGhost[slot].recoverUntil = 0;
        this._vkBotGhost[slot].playT0 = tAssign;
        this._vkBotGhost[slot].spineSrc = 'live';
      }
      var sessRun = {
        durationMs: durationMs | 0,
        spawnRot: this._vkMatchSpawnRot | 0,
        spawnLaneIdx: laneFin % VK_SPAWN_LANE_COUNT,
        frames: framesCopy
      };
      this._vkSessionGhostRuns.push(sessRun);
      while (this._vkSessionGhostRuns.length > VK_SESSION_GHOST_MAX) {
        this._vkSessionGhostRuns.shift();
      }
    },

    _vkSanLb: function (s) {
      return String(s == null ? '' : s)
        .replace(/[\r\n\t]/g, ' ')
        .trim()
        .slice(0, 18);
    },

    _vkRebuildSlotNamesHost: function () {
      var nm = [];
      for (var nmi = 0; nmi < VK_MAX_SLOTS; nmi++) nm.push('Player ' + (nmi + 1));
      var s;
      for (s = 0; s < VK_MAX_SLOTS; s++) {
        if (this._vkIsHumanOccupyingSlot(s)) {
          if (s === this.mySlot) {
            var hn =
              typeof window.playerNickname === 'string' && window.playerNickname.trim()
                ? window.playerNickname.trim().slice(0, 16)
                : 'You';
            nm[s] = hn;
          } else {
            var found = false;
            var i;
            for (i = 0; i < this.clientConns.length; i++) {
              var c = this.clientConns[i];
              if (c && c.open && c.vkSlot === s) {
                var ck = typeof c.vkNick === 'string' && c.vkNick.trim() ? c.vkNick.trim().slice(0, 16) : 'Player';
                nm[s] = ck;
                found = true;
                break;
              }
            }
            if (!found) nm[s] = 'Player';
          }
        } else {
          nm[s] = 'Bot ' + (s + 1);
        }
      }
      this._vkSlotDisplayNames = nm;
    },

    _vkRefreshMatchResultsPanel: function () {
      var el = this._vkLeaderboardMatchEl;
      if (!el) return;
      var names = this._vkSlotDisplayNames;
      if (!names || !names.length) {
        names = [];
        var nd;
        for (nd = 0; nd < VK_MAX_SLOTS; nd++) names.push('P' + (nd + 1));
      }
      var rows = (this._vkRoundFinishes || []).slice();
      rows.sort(function (a, b) {
        return (a.ms || 0) - (b.ms || 0);
      });
      var lines = [];
      var ri;
      for (ri = 0; ri < rows.length; ri++) {
        var row = rows[ri];
        var sl = row.slot | 0;
        var nm = this._vkSanLb(names[sl] || 'Player ' + (sl + 1));
        lines.push(nm + '  ' + ((row.ms || 0) / 1000).toFixed(2) + 's');
      }
      if (!lines.length) {
        lines.push('—');
      }
      el.setAttribute('value', lines.join('\n'));
    },

    /** Which lanes 0–15 have at least one saved ghost for this ramp rotation (legacy runs inferred from first frame XZ). */
    _vkLanesWithRecordingMask: function (rot) {
      var set = {};
      var r = (rot | 0) % 4;
      var trk = this._vkCourseTrack | 0;
      var lib = vkGhostRunsForSpawnRot(r, trk);
      if (!lib.length) lib = vkLoadGhostRuns(trk);
      var phx = this._vkPathHalfX || 2.35;
      var z0 = this._vkSpawnBaseZ;
      var pi;
      for (pi = 0; pi < lib.length; pi++) {
        var run = lib[pi];
        if (!vkRunHasPlayableFrames(run)) continue;
        if (run.spawnLaneIdx != null) {
          var Ln = (run.spawnLaneIdx | 0) % VK_SPAWN_LANE_COUNT;
          set[Ln] = true;
          continue;
        }
        var infL = vkInferSpawnLaneIdxForRot(run, phx, z0, r);
        if (infL >= 0) set[infL] = true;
      }
      return set;
    },

    _vkCreateLaneStartMarkers: function () {
      if (this._vkLaneMarkersRoot || !this._arenaRoot) return;
      var root = document.createElement('a-entity');
      root.setAttribute('id', 'vk-lane-markers');
      this._arenaRoot.appendChild(root);
      this._vkLaneMarkersRoot = root;
      this._vkLaneMarkers = [];
      var L;
      for (L = 0; L < VK_SPAWN_LANE_COUNT; L++) {
        var wrap = document.createElement('a-entity');
        wrap.setAttribute('id', 'vk-lane-m-' + L);
        var infill = document.createElement('a-circle');
        infill.setAttribute('radius', 0.09);
        infill.setAttribute('segments', 48);
        infill.setAttribute('rotation', '-90 0 0');
        infill.setAttribute(
          'material',
          'shader: flat; color: #25252e; transparent: true; opacity: 0.88'
        );
        infill.setAttribute('position', '0 0.001 0');
        var ring = document.createElement('a-ring');
        ring.setAttribute('radius-inner', 0.076);
        ring.setAttribute('radius-outer', 0.102);
        ring.setAttribute('segments-theta', 48);
        ring.setAttribute('rotation', '-90 0 0');
        ring.setAttribute(
          'material',
          'shader: flat; color: #6a8ec8; transparent: true; opacity: 0.82'
        );
        ring.setAttribute('position', '0 0.003 0');
        wrap.appendChild(infill);
        wrap.appendChild(ring);
        root.appendChild(wrap);
        this._vkLaneMarkers.push({ wrap: wrap, infill: infill, ring: ring });
      }
    },

    _vkUpdateLaneMarkerColorsAndPositions: function () {
      if (!this._vkLaneMarkers || !this._vkLaneMarkers.length) return;
      var phx = this._vkPathHalfX || 2.35;
      var z0 = this._vkSpawnBaseZ;
      var spawnY = this._vkSpawnPhysY;
      if (spawnY == null || !isFinite(spawnY)) return;
      var rot = (this._vkMatchSpawnRot | 0) % 4;
      var padY = spawnY - PLAYER_R * 0.82;
      var recSet = this._vkLanesWithRecordingMask(rot);
      var L;
      for (L = 0; L < VK_SPAWN_LANE_COUNT; L++) {
        var xz = vkWorldXZForLane(phx, z0, rot, L);
        var m = this._vkLaneMarkers[L];
        if (!m || !m.wrap) continue;
        m.wrap.setAttribute('position', { x: xz.x, y: padY, z: xz.z });
        var green = !!recSet[L];
        m.infill.setAttribute(
          'material',
          green
            ? 'shader: flat; color: #1a6b38; transparent: true; opacity: 0.92'
            : 'shader: flat; color: #25252e; transparent: true; opacity: 0.88'
        );
        m.ring.setAttribute(
          'material',
          green
            ? 'shader: flat; color: #5af098; transparent: true; opacity: 0.9'
            : 'shader: flat; color: #6a8ec8; transparent: true; opacity: 0.82'
        );
      }
    },

    _vkRefreshLeaderboardPanels: function () {
      var elA = this._vkLeaderboardAllTimeEl;
      if (elA) {
        var runs = vkLoadGhostRuns();
        var lines = [];
        var rank;
        for (rank = 0; rank < 10; rank++) {
          var prefix = rank + 1 + '. ';
          if (rank < runs.length && runs[rank] && runs[rank].durationMs != null) {
            lines.push(prefix + (runs[rank].durationMs / 1000).toFixed(2) + 's');
          } else {
            lines.push(prefix + '—');
          }
        }
        elA.setAttribute('value', lines.join('\n'));
      }
      this._vkRefreshMatchResultsPanel();
      this._vkUpdateLaneMarkerColorsAndPositions();
    },

    /** Call when GO fires so stuck detection does not punish the pre-move frame. */
    _vkResetBotHillProgress: function (nowMs) {
      var uh = this._vkUphill;
      var uhx = uh.x;
      var uhz = uh.z;
      var h = Math.sqrt(uhx * uhx + uhz * uhz) || 1;
      uhx /= h;
      uhz /= h;
      var s;
      for (s = 0; s < VK_MAX_SLOTS; s++) {
        var b = this.carBodies[s];
        var sp = this._carSpawn[s];
        if (b && sp) {
          var cur = (b.position.x - sp.x) * uhx + (b.position.z - sp.z) * uhz;
          this._vkBotBestHill[s] = cur;
        } else {
          this._vkBotBestHill[s] = 0;
        }
        this._vkBotHillProgAt[s] = nowMs;
      }
    },

    /** Host: if a bot has not improved for 8s, respawn that bot on a new lane (prefers a green / recorded lane), other cars unchanged. */
    _vkTickBotStuckHost: function (nowMs) {
      if (!this.isHost || !this.vkMatchActive || !this.vkMatchStartMs) return;
      var uh = this._vkUphill;
      var uhx = uh.x;
      var uhz = uh.z;
      var h = Math.sqrt(uhx * uhx + uhz * uhz) || 1;
      uhx /= h;
      uhz /= h;
      var s;
      for (s = 0; s < VK_MAX_SLOTS; s++) {
        if (this._vkIsHumanOccupyingSlot(s) || this._vkFinished[s]) continue;
        var body = this.carBodies[s];
        var sp = this._carSpawn[s];
        if (!body || !sp) continue;
        var cur = (body.position.x - sp.x) * uhx + (body.position.z - sp.z) * uhz;
        if (cur > this._vkBotBestHill[s] + 0.028) {
          this._vkBotBestHill[s] = cur;
          this._vkBotHillProgAt[s] = nowMs;
        } else if (nowMs - this._vkBotHillProgAt[s] >= 8000) {
          this._vkInstantResetSlot(s, true);
          var b2 = this.carBodies[s];
          var sp2 = this._carSpawn[s];
          if (b2 && sp2) {
            var cur2 = (b2.position.x - sp2.x) * uhx + (b2.position.z - sp2.z) * uhz;
            this._vkBotBestHill[s] = cur2;
          } else {
            this._vkBotBestHill[s] = 0;
          }
          this._vkBotHillProgAt[s] = nowMs;
        }
      }
    },

    _vkTryJump: function (slot) {
      var body = this.carBodies[slot];
      if (!body) return;
      var now = performance.now();
      if (now < this._vkJumpNextMs[slot]) return;
      var sp = this._carSpawn[slot];
      var vy = body.velocity.y;
      var spawnY = this._vkSpawnPhysY;
      var yCap =
        spawnY != null && isFinite(spawnY)
          ? spawnY + 5.75
          : 6.5;
      var grounded =
        this._vkGrounded[slot] > 0 ||
        (vy < 1.35 && body.position.y < yCap && body.position.y > -0.25);
      if (!grounded) return;
      body.velocity.x *= 0.92;
      body.velocity.z *= 0.92;
      body.velocity.y += 2.84;
      this._vkJumpNextMs[slot] = now + 520;
      this._vkGrounded[slot] = 0;
    },

    _vkSetMatchMusicPlaying: function (on) {
      if (window._musicEnabled === false) return;
      var scene = this.el && this.el.sceneEl;
      if (!scene) return;
      var sm = scene.components && scene.components['sound-manager'];
      if (!sm || !sm._fadeSound || !sm._setVolume) return;
      var bgm = document.getElementById('bg-music');
      var mm = document.getElementById('match-music');
      if (!bgm || !bgm.components || !bgm.components.sound) return;
      if (mm && mm.components && mm.components.sound) {
        mm.components.sound.stopSound();
        if (sm._fadeTickers && sm._fadeTickers['match-music']) {
          clearInterval(sm._fadeTickers['match-music']);
          delete sm._fadeTickers['match-music'];
        }
      }
      if (on) {
        if (sm._fadeTickers && sm._fadeTickers['bg-music']) {
          clearInterval(sm._fadeTickers['bg-music']);
          delete sm._fadeTickers['bg-music'];
        }
        var bgS = bgm.components.sound;
        if (!window._bgMusicStarted) {
          bgS.playSound();
          window._bgMusicStarted = true;
          sm._setVolume(bgm, sm.bgMusicVolume);
        }
        sm._fadeSound(bgm, sm.bgMusicVolume, sm.matchMusicVolume, 550);
      } else {
        if (sm._fadeTickers && sm._fadeTickers['bg-music']) {
          clearInterval(sm._fadeTickers['bg-music']);
          delete sm._fadeTickers['bg-music'];
        }
        sm._fadeSound(bgm, sm.matchMusicVolume, sm.bgMusicVolume, 900);
      }
    },

    _vkPlayGoalSoundsAt: function (wx, wy, wz) {
      var gs = document.getElementById('vl-goal-sound');
      if (gs && gs.components && gs.components.sound) gs.components.sound.playSound();
      var gi = document.getElementById('vl-goal-impact-sound');
      if (gi) {
        gi.setAttribute('position', { x: wx, y: wy, z: wz });
        if (gi.components && gi.components.sound) gi.components.sound.playSound();
      }
    },

    _vkTickFinishFxSparks: function (dtSec) {
      var st = this._vkFinishFxSparkState;
      if (!st || !st.length) return;
      var g = 1.35;
      var d = 0.988;
      var k;
      var q;
      for (k = 0; k < st.length; k++) {
        q = st[k];
        if (!q || !q.active) continue;
        q.vy -= g * dtSec;
        q.px += q.vx * dtSec;
        q.py += q.vy * dtSec;
        q.pz += q.vz * dtSec;
        q.vx *= d;
        q.vy *= d;
        q.vz *= d;
        q.life -= dtSec * 0.22;
        if (q.life <= 0) {
          q.active = false;
          if (q.el) q.el.setAttribute('visible', false);
        } else if (q.el) {
          q.el.setAttribute('position', q.px + ' ' + q.py + ' ' + q.pz);
        }
      }
    },

    _vkPlayFinishPodiumFx: function (wx, wy, wz, playerLabelNum) {
      var self = this;
      var wrap = this._vkFinishFxWrap;
      var mainEl = this._vkFinishFxMainText;
      var subEl = this._vkFinishFxSubText;
      if (!wrap || !mainEl || !subEl) return;
      if (this._vkFinishFxHideTimer) {
        clearTimeout(this._vkFinishFxHideTimer);
        this._vkFinishFxHideTimer = null;
      }
      this._vkFinishFxSparkState = null;
      mainEl.setAttribute('value', 'QUALIFIED!');
      subEl.setAttribute('value', 'Player ' + playerLabelNum);
      wrap.setAttribute('visible', true);
      var sparks = this._vkFinishFxSparkEls;
      if (sparks && sparks.length) {
        var sim = [];
        var k;
        for (k = 0; k < sparks.length; k++) {
          var sp = sparks[k];
          if (!sp) continue;
          var vx = (Math.random() - 0.5) * 2.65;
          var vy = Math.random() * 1.95 + 0.95;
          var vz = (Math.random() - 0.5) * 1.85;
          var px = (Math.random() - 0.5) * 0.12;
          var py = (Math.random() - 0.5) * 0.08;
          var pz = (Math.random() - 0.5) * 0.12;
          var hue = Math.floor(Math.random() * 360);
          var rad = (0.02 + Math.random() * 0.028).toFixed(3);
          sp.setAttribute('radius', rad);
          sp.setAttribute(
            'material',
            'shader: flat; color: hsl(' + hue + ', 88%, 58%); opacity: 0.96; transparent: true; side: double'
          );
          sp.setAttribute('position', px + ' ' + py + ' ' + pz);
          sp.setAttribute('visible', true);
          sim.push({ el: sp, active: true, vx: vx, vy: vy, vz: vz, px: px, py: py, pz: pz, life: 1 });
        }
        this._vkFinishFxSparkState = sim;
      }
      this._vkPlayGoalSoundsAt(wx, wy, wz);
      this._vkFinishFxHideTimer = setTimeout(function () {
        self._vkStopFinishFxCelebration();
      }, 2600);
    },

    _vkStopFinishFxCelebration: function () {
      if (this._vkFinishFxHideTimer) {
        clearTimeout(this._vkFinishFxHideTimer);
        this._vkFinishFxHideTimer = null;
      }
      this._vkFinishFxSparkState = null;
      if (this._vkFinishFxWrap) this._vkFinishFxWrap.setAttribute('visible', false);
      if (this._vkFinishFxSparkEls) {
        var u;
        for (u = 0; u < this._vkFinishFxSparkEls.length; u++) {
          var s2 = this._vkFinishFxSparkEls[u];
          if (s2) s2.setAttribute('visible', false);
        }
      }
    },

    _vkIsHumanOccupyingSlot: function (slot) {
      if (!this.isHost) return slot === this.mySlot;
      if (slot === this.mySlot) return true;
      for (var i = 0; i < this.clientConns.length; i++) {
        var c = this.clientConns[i];
        if (c && c.open && c.vkSlot === slot) return true;
      }
      return false;
    },

    /**
     * Host: saved ghosts for this spawn rotation + course, with mid-session qualifying runs prepended
     * so fresh human lines beat stale library picks.
     */
    _vkGhostLibraryForBots: function () {
      var trk = this._vkCourseTrack | 0;
      var lib = vkGhostRunsForSpawnRot(this._vkMatchSpawnRot | 0, trk);
      if (!lib.length) lib = vkLoadGhostRuns(trk);
      lib = vkFilterPlayableGhostRuns(lib);
      var sess = this._vkSessionGhostRuns && this._vkSessionGhostRuns.length
        ? vkFilterPlayableGhostRuns(this._vkSessionGhostRuns)
        : [];
      if (!sess.length) return lib;
      return sess.concat(lib);
    },

    _vkAssignBotGhosts: function () {
      var s;
      for (s = 0; s < VK_MAX_SLOTS; s++) {
        this._vkBotGhost[s] = { rec: null, recIdx: 0, recoverUntil: 0, playT0: null };
      }
      if (!this.isHost) return;
      for (s = 0; s < VK_MAX_SLOTS; s++) {
        if (this._vkIsHumanOccupyingSlot(s) || this._vkFinished[s]) continue;
        var lib = this._vkGhostLibraryForBots();
        var lanePref =
          this._vkSlotSpawnLaneIdx && typeof this._vkSlotSpawnLaneIdx[s] === 'number'
            ? this._vkSlotSpawnLaneIdx[s] | 0
            : 0;
        if (!lib.length) continue;
        var pickR = this._vkSelectGhostForBotSlot(lib, lanePref);
        this._vkBotGhost[s].rec = pickR;
        this._vkBotGhost[s].spineSrc = this._vkSpineSrcForRun(pickR);
        this._vkBotGhost[s].playT0 = null;
      }
    },

    /** Whether a ghost run object came from this match's session pool (reference identity). */
    _vkSpineSrcForRun: function (rec) {
      if (!rec) return 'lib';
      var sj;
      if (this._vkSessionGhostRuns && this._vkSessionGhostRuns.length) {
        for (sj = 0; sj < this._vkSessionGhostRuns.length; sj++) {
          if (this._vkSessionGhostRuns[sj] === rec) return 'sess';
        }
      }
      return 'lib';
    },

    /**
     * Solo: merge a qualifying finish into localStorage ghost library. Multiplayer: no-op (no shared ghost store).
     * @param {number} durationMs
     * @param {number} finishSlot 0–7
     * @param {Array} [framesOpt] if set, use this frame array instead of `_vkGhostRecBufBySlot[finishSlot]`.
     */
    _vkGhostCommitFinish: function (durationMs, finishSlot, framesOpt) {
      if (window.isMultiplayer) return;
      var fs = typeof finishSlot === 'number' ? finishSlot | 0 : this.mySlot | 0;
      if (fs < 0 || fs >= VK_MAX_SLOTS) fs = this.mySlot | 0;
      var frames =
        framesOpt && framesOpt.length >= 12
          ? framesOpt
          : this._vkGhostRecBufBySlot && this._vkGhostRecBufBySlot[fs] && this._vkGhostRecBufBySlot[fs].length >= 12
            ? this._vkGhostRecBufBySlot[fs]
            : null;
      if (!frames || frames.length < 12) return;
      var laneIdx =
        this._vkSlotSpawnLaneIdx && typeof this._vkSlotSpawnLaneIdx[fs] === 'number'
          ? this._vkSlotSpawnLaneIdx[fs] | 0
          : 0;
      vkTryInsertGhostRun(
        {
          durationMs: durationMs,
          spawnRot: this._vkMatchSpawnRot | 0,
          spawnLaneIdx: laneIdx % VK_SPAWN_LANE_COUNT,
          frames: frames
        },
        this._vkCourseTrack
      );
      this._vkGhostRecBuf = null;
    },

    _vkGhostWorldTargetFromFrame: function (slot, fr, f0) {
      var sp = this._carSpawn[slot];
      if (!sp || !vkGhostFrame0Valid(fr) || !vkGhostFrame0Valid(f0)) return null;
      return {
        x: sp.x + (fr[0] - f0[0]),
        y: sp.y + (fr[1] - f0[1]),
        z: sp.z + (fr[2] - f0[2])
      };
    },

    _vkDisposeSpineGuideLine: function () {
      var sg = this._vkSpineGuide;
      if (!sg || !sg.line) {
        this._vkSpineGuide = null;
        return;
      }
      try {
        if (sg.line.parent) sg.line.parent.remove(sg.line);
        if (sg.geo) sg.geo.dispose();
        if (sg.mat) sg.mat.dispose();
      } catch (eSg) {}
      this._vkSpineGuide = null;
      this._vkSpineGuideLastRec = null;
    },

    /**
     * Host: rebuild a green world-space polyline from the first racing bot’s ghost frames (throttled).
     * Off in production; enable with `?vkSpine=1` or `localStorage 'vrknockout-debug-spine' === '1'` (see init).
     */
    _vkTickSpineGuideLine: function (nowMs) {
      var T = (typeof AFRAME !== 'undefined' && AFRAME.THREE) || (typeof window !== 'undefined' && window.THREE);
      if (!this.isHost || !T || !this._arenaRoot || !this._arenaRoot.object3D) {
        if (!this.isHost || !this.vkMatchActive) this._vkDisposeSpineGuideLine();
        return;
      }
      if (!this.vkMatchActive || !this.vkMatchStartMs) {
        this._vkDisposeSpineGuideLine();
        return;
      }
      var showSlot = -1;
      var Gshow = null;
      var sb;
      for (sb = 0; sb < VK_MAX_SLOTS; sb++) {
        if (this._vkIsHumanOccupyingSlot(sb)) continue;
        var Gx = this._vkBotGhost && this._vkBotGhost[sb];
        if (Gx && Gx.rec && Gx.rec.frames && Gx.rec.frames.length >= 16) {
          showSlot = sb;
          Gshow = Gx;
          break;
        }
      }
      if (showSlot < 0 || !Gshow || !Gshow.rec) {
        this._vkDisposeSpineGuideLine();
        return;
      }
      var rec = Gshow.rec;
      if (nowMs - this._vkSpineGuideLastRebuild < 380 && this._vkSpineGuideLastRec === rec && this._vkSpineGuide) {
        return;
      }
      this._vkSpineGuideLastRebuild = nowMs;
      this._vkSpineGuideLastRec = rec;
      var frames = rec.frames;
      var f0 = frames[0];
      var sp = this._carSpawn[showSlot];
      if (!sp || !vkGhostFrame0Valid(f0)) return;
      var maxPts = 512;
      var step = Math.max(1, Math.floor(frames.length / maxPts));
      var nVert = Math.min(maxPts, 1 + Math.ceil(frames.length / step));
      if (!this._vkSpineGuide) {
        var geo = new T.BufferGeometry();
        var pos = new Float32Array(maxPts * 3);
        geo.setAttribute('position', new T.BufferAttribute(pos, 3));
        geo.setDrawRange(0, 0);
        var mat = new T.LineBasicMaterial({
          color: 0x55ee99,
          transparent: true,
          opacity: 0.62,
          depthTest: true,
          depthWrite: false
        });
        var line = new T.Line(geo, mat);
        line.frustumCulled = false;
        line.renderOrder = 2;
        this._arenaRoot.object3D.add(line);
        this._vkSpineGuide = { line: line, geo: geo, attr: geo.attributes.position, maxPts: maxPts };
      }
      var attr = this._vkSpineGuide.attr;
      var v = 0;
      var fi;
      for (fi = 0; fi < frames.length && v < maxPts; fi += step) {
        var fr = frames[fi];
        if (!vkGhostFrame0Valid(fr)) continue;
        attr.setXYZ(v, sp.x + (fr[0] - f0[0]), sp.y + (fr[1] - f0[1]) + 0.07, sp.z + (fr[2] - f0[2]));
        v++;
      }
      if (v < 2) {
        this._vkSpineGuide.line.visible = false;
        return;
      }
      attr.needsUpdate = true;
      this._vkSpineGuide.geo.setDrawRange(0, v);
      this._vkSpineGuide.line.visible = true;
    },

    /**
     * Tracks 2–3: match ghost by nearest point in space (race-clock sync drifts on spinners/tiles).
     * Track 1: time-localized window only.
     */
    _vkGhostBotPickFrameIndex: function (slot, body, frames, f0, tIdx) {
      var gtp = vkGhostTrackParams(this._vkCourseTrack);
      var t23 = (this._vkCourseTrack | 0) === 2 || (this._vkCourseTrack | 0) === 3;
      var best = Math.min(frames.length - 1, Math.max(0, tIdx | 0));
      var bestD2 = 1e18;
      var ii;
      var self = this;
      function consider(idx) {
        var w = self._vkGhostWorldTargetFromFrame(slot, frames[idx], f0);
        if (!w) return;
        var dx = body.position.x - w.x;
        var dy = body.position.y - w.y;
        var dz = body.position.z - w.z;
        var dd = dx * dx + dy * dy + dz * dz;
        if (dd < bestD2) {
          bestD2 = dd;
          best = idx;
        }
      }
      if (t23) {
        var stride = Math.max(1, Math.floor(frames.length / 96));
        for (ii = 0; ii < frames.length; ii += stride) consider(ii);
        var r0 = Math.max(0, best - 44);
        var r1 = Math.min(frames.length - 1, best + 44);
        for (ii = r0; ii <= r1; ii++) consider(ii);
      } else {
        var lo = Math.max(0, tIdx - gtp.syncBack);
        var hi = Math.min(frames.length - 1, tIdx + gtp.syncFwd);
        for (ii = lo; ii <= hi; ii++) consider(ii);
      }
      return { best: best, bestD2: bestD2 };
    },

    _vkGhostRecordTickAfterPhysics: function (now) {
      if (!this.isHost || !this.vkMatchActive || !this.vkMatchStartMs) return;
      if (now - this._vkGhostLastSample < VK_GHOST_SAMPLE_MS) return;
      this._vkGhostLastSample = now;
      var maxF = 620;
      var slot;
      for (slot = 0; slot < VK_MAX_SLOTS; slot++) {
        if (!this._vkIsHumanOccupyingSlot(slot)) continue;
        if (this._vkFinished[slot]) continue;
        var buf = this._vkGhostRecBufBySlot && this._vkGhostRecBufBySlot[slot];
        if (!buf) continue;
        if (buf.length > maxF) continue;
        var b = this.carBodies[slot];
        var inp = this.inputs[slot];
        if (!b || !inp) continue;
        var cy =
          this._vkCarriageYawRad && typeof this._vkCarriageYawRad[slot] === 'number'
            ? this._vkCarriageYawRad[slot]
            : 0;
        buf.push([
          Math.round(b.position.x * 1000) / 1000,
          Math.round(b.position.y * 1000) / 1000,
          Math.round(b.position.z * 1000) / 1000,
          Math.round(cy * 1000) / 1000,
          Math.round((inp.lx || 0) * 1000) / 1000,
          Math.round((inp.trig || 0) * 1000) / 1000,
          Math.round((inp.trigRev || 0) * 1000) / 1000,
          inp.j ? 1 : 0
        ]);
      }
    },

    /**
     * Short-horizon waypoint (~1 m) toward the finish, snapped onto the nearest safe support on T2/T3.
     * Finishes the “aim finish + local plan” idea without continuous competing lateral pulls (reduces orbiting).
     */
    _vkBotShortGoalWorld: function (body, nowMs, uhx, uhz, slot) {
      var out = { wx: body.position.x, wz: body.position.z, suggestJump: false };
      if (!body || !body.position) return out;
      var bx = body.position.x;
      var by = body.position.y;
      var bz = body.position.z;
      var vx = body.velocity.x;
      var vy = body.velocity.y;
      var vz = body.velocity.z;
      var pastZ =
        (this._vkFinishZ != null && isFinite(this._vkFinishZ) ? this._vkFinishZ : VK_FINISH_LINE_Z) - 2.65;
      var phx = this._vkPathHalfX || 2.35;
      var trk = this._vkCourseTrack | 0;
      var now =
        nowMs != null && isFinite(nowMs)
          ? nowMs
          : typeof performance !== 'undefined' && performance.now
            ? performance.now()
            : 0;
      var uhH = Math.sqrt(uhx * uhx + uhz * uhz) || 1;
      var uhxN = uhx / uhH;
      var uhzN = uhz / uhH;
      if (trk === 1) {
        var spIdx = slot != null && slot >= 0 ? slot | 0 : 0;
        var spawn = this._carSpawn && this._carSpawn[spIdx] ? this._carSpawn[spIdx] : null;
        var tx =
          spawn && typeof spawn.x === 'number'
            ? spawn.x * 0.35 + bx * 0.65
            : bx * 0.92;
        tx = clamp(tx, -phx * 0.94, phx * 0.94);
        var dxf = tx - bx;
        var dzf = pastZ - bz;
        var lenf = Math.sqrt(dxf * dxf + dzf * dzf) + 1e-5;
        var step = Math.min(1.2, 0.5 + lenf * 0.22);
        out.wx = bx + (dxf / lenf) * step;
        out.wz = bz + (dzf / lenf) * step;
        return out;
      }
      if (trk === 2 && this._vkSpinnerBodies && this._vkSpinnerBodies.length) {
        var Lk = 1.05;
        var ax = bx + uhxN * Lk;
        var az = bz + uhzN * Lk;
        var spb = this._vkSpinnerBodies;
        var si2;
        var bestDh = 1e9;
        var near2 = null;
        for (si2 = 0; si2 < spb.length; si2++) {
          var sp2 = spb[si2];
          if (!sp2 || sp2.discR == null) continue;
          var ddx = ax - sp2.cx;
          var ddz = az - sp2.cz;
          var dh = Math.sqrt(ddx * ddx + ddz * ddz);
          if (dh < bestDh) {
            bestDh = dh;
            near2 = sp2;
          }
        }
        if (near2) {
          out.wx = near2.cx * 0.74 + ax * 0.26;
          out.wz = near2.cz * 0.74 + az * 0.26;
        } else {
          out.wx = ax;
          out.wz = az;
        }
        var bestCur = 1e9;
        var curN = null;
        for (si2 = 0; si2 < spb.length; si2++) {
          var spc = spb[si2];
          if (!spc || spc.discR == null) continue;
          var dxc = bx - spc.cx;
          var dzc = bz - spc.cz;
          var dhc = Math.sqrt(dxc * dxc + dzc * dzc);
          if (dhc < bestCur) {
            bestCur = dhc;
            curN = spc;
          }
        }
        var progB = -(bx * uhxN + bz * uhzN);
        var fwdN = null;
        var fwdDh = 1e9;
        for (si2 = 0; si2 < spb.length; si2++) {
          var spf = spb[si2];
          if (!spf || spf.discR == null) continue;
          var progF = -(spf.cx * uhxN + spf.cz * uhzN);
          if (progF < progB - 0.14) continue;
          var dxfw = bx - spf.cx;
          var dzfw = bz - spf.cz;
          var dhfw = Math.sqrt(dxfw * dxfw + dzfw * dzfw);
          if (dhfw < fwdDh) {
            fwdDh = dhfw;
            fwdN = spf;
          }
        }
        if (!fwdN) fwdN = curN;
        if (fwdN && fwdN.discY != null) {
          var discTopY = fwdN.discY + (fwdN.discHalfH != null ? fwdN.discHalfH : 0.07);
          var ballBottom = by - PLAYER_R;
          var rF = fwdN.discR;
          if (
            vy < 1.08 &&
            ballBottom < discTopY - 0.015 &&
            ballBottom > discTopY - 0.58 &&
            fwdDh > rF * 0.24 &&
            fwdDh < rF * 1.14
          ) {
            out.suggestJump = true;
          }
        }
        var aheadNear = 1e9;
        var aheadSp = null;
        for (si2 = 0; si2 < spb.length; si2++) {
          var spa = spb[si2];
          if (!spa || spa.discR == null) continue;
          var progD = -(spa.cx * uhxN + spa.cz * uhzN);
          if (progD <= progB + 0.03) continue;
          var dxa = bx - spa.cx;
          var dza = bz - spa.cz;
          var dha = Math.sqrt(dxa * dxa + dza * dza);
          if (dha < aheadNear) {
            aheadNear = dha;
            aheadSp = spa;
          }
        }
        if (
          curN &&
          aheadSp &&
          bestCur > curN.discR * 0.4 &&
          aheadNear > curN.discR * 0.28 &&
          aheadNear < curN.discR * 2.15 &&
          vy < 0.95 &&
          by < (aheadSp.discY != null ? aheadSp.discY : curN.discY) + 0.42
        ) {
          out.suggestJump = true;
        }
        return out;
      }
      if (trk === 3 && this._vkT3SliderBodies && this._vkT3SliderBodies.length) {
        var list3 = this._vkT3SliderBodies;
        var s3 = now * 0.001;
        var Lk3 = 1.05;
        var ax3 = bx + uhxN * Lk3;
        var az3 = bz + uhzN * Lk3;
        var bestD2 = 1e9;
        var pickX = ax3;
        var pickZ = az3;
        var si3;
        for (si3 = 0; si3 < list3.length; si3++) {
          var p3 = list3[si3];
          if (!p3 || p3.halfHx == null) continue;
          var sn = p3.omega * s3 + p3.phase;
          var px = p3.amp * Math.sin(sn);
          var sx = clamp(ax3, px - p3.halfHx, px + p3.halfHx);
          var sz = clamp(az3, p3.baseZ - p3.halfHz, p3.baseZ + p3.halfHz);
          var ddx = sx - ax3;
          var ddz = sz - az3;
          var d2 = ddx * ddx + ddz * ddz;
          if (d2 < bestD2) {
            bestD2 = d2;
            pickX = sx * 0.68 + ax3 * 0.32;
            pickZ = sz * 0.68 + az3 * 0.32;
          }
        }
        out.wx = pickX;
        out.wz = pickZ;
        var bestCur3 = 1e9;
        var curP = null;
        var platXC = bx;
        for (si3 = 0; si3 < list3.length; si3++) {
          var p3c = list3[si3];
          if (!p3c || p3c.halfHx == null) continue;
          var snC = p3c.omega * s3 + p3c.phase;
          var pxc = p3c.amp * Math.sin(snC);
          var dxc3 = bx - pxc;
          var dzc3 = bz - p3c.baseZ;
          var dhc3 = Math.sqrt(dxc3 * dxc3 + dzc3 * dzc3);
          if (dhc3 < bestCur3) {
            bestCur3 = dhc3;
            curP = p3c;
            platXC = pxc;
          }
        }
        if (curP && Math.abs(bx - platXC) > curP.halfHx * 0.55 && vy < 0.9 && bestCur3 < curP.halfHx * 1.9) {
          out.suggestJump = true;
        }
        return out;
      }
      return out;
    },

    _vkBotHazardPack: function (body, uhx, uhz, nowMs) {
      var dodgeLx = 0;
      var wantJump = false;
      var pillarPin = false;
      var voidGap = false;
      var now =
        nowMs != null && isFinite(nowMs)
          ? nowMs
          : typeof performance !== 'undefined' && performance.now
            ? performance.now()
            : 0;
      var ri;
      var avoidR = ROCK_R * 4.5 + PLAYER_R * 2.2;
      var avoidR2 = avoidR * avoidR;
      for (ri = 0; ri < this.rockBodies.length; ri++) {
        var R = this.rockBodies[ri];
        if (!R || R.position.y < -1.2 || (this._vkRockActive && this._vkRockActive[ri] === false)) continue;
        var rdx = R.position.x - body.position.x;
        var rdy = R.position.y - body.position.y;
        var rdz = R.position.z - body.position.z;
        var d2 = rdx * rdx + rdy * rdy + rdz * rdz;
        if (d2 > avoidR2) continue;
        var ahead = rdx * uhx + rdz * uhz;
        if (ahead < -0.35) continue;
        var perp = rdx * uhz - rdz * uhx;
        var wClose = 1 - Math.sqrt(d2) / avoidR;
        if (wClose < 0) wClose = 0;
        dodgeLx -= clamp(perp * 2.45, -0.82, 0.82) * wClose;
        if (d2 < ROCK_R * ROCK_R * 10 && ahead > -0.12 && Math.abs(rdy) < ROCK_R * 3.5) wantJump = true;
      }
      var pts = this._vkPillarAvoidPts;
      if (pts && pts.length) {
        var pi;
        for (pi = 0; pi < pts.length; pi++) {
          var pp = pts[pi];
          var pr = pp.r || 0.2;
          var pdx = pp.x - body.position.x;
          var pdz = pp.z - body.position.z;
          var d2p = pdx * pdx + pdz * pdz;
          var avR = pr + 0.34;
          if (d2p > avR * avR) continue;
          var aheadP = pdx * uhx + pdz * uhz;
          if (aheadP < -0.62) continue;
          var perpP = pdx * uhz - pdz * uhx;
          var wP = 1 - Math.sqrt(d2p) / avR;
          if (wP < 0) wP = 0;
          dodgeLx -= clamp(perpP * 3.35, -1, 1) * (0.55 + 0.45 * wP);
          if (d2p < (pr + 0.12) * (pr + 0.12) && aheadP > -0.35) {
            pillarPin = true;
            wantJump = true;
          }
        }
      }
      var gaps = this._vkPlinkoGapAvoidPts;
      if (gaps && gaps.length) {
        var gk;
        for (gk = 0; gk < gaps.length; gk++) {
          var gg = gaps[gk];
          var gHalfZ = gg.halfZ != null ? gg.halfZ : 0.35;
          var dxg = body.position.x - gg.x;
          var dzg = body.position.z - gg.z;
          if (Math.abs(dxg) > gg.halfW + 0.14 || Math.abs(dzg) > gHalfZ + 0.12) continue;
          voidGap = true;
          var aheadG = dxg * uhx + dzg * uhz;
          if (aheadG > -0.92) {
            var wCloseG = 1 - Math.max(Math.abs(dxg) / (gg.halfW + 0.06), Math.abs(dzg) / (gHalfZ + 0.05));
            if (wCloseG < 0) wCloseG = 0;
            dodgeLx -= clamp((dxg / (gg.halfW + 0.08)) * 2.05, -1, 1) * (0.42 + 0.58 * wCloseG);
          }
        }
      }
      var trk = this._vkCourseTrack | 0;
      if (trk === 2 && this._vkSpinnerBodies && this._vkSpinnerBodies.length) {
        var bz2 = body.position.z;
        var by2 = body.position.y;
        var bx2 = body.position.x;
        if (bz2 < 2.68 && bz2 > -5.78) {
          var spb = this._vkSpinnerBodies;
          var si2;
          var bestDh = 1e9;
          var near2 = null;
          for (si2 = 0; si2 < spb.length; si2++) {
            var sp2 = spb[si2];
            if (!sp2 || sp2.discR == null) continue;
            var ddx2 = bx2 - sp2.cx;
            var ddz2 = bz2 - sp2.cz;
            var dh2 = Math.sqrt(ddx2 * ddx2 + ddz2 * ddz2);
            if (dh2 < bestDh) {
              bestDh = dh2;
              near2 = sp2;
            }
          }
          if (near2) {
            var discR2 = near2.discR;
            var topY2 = near2.discY + (near2.discHalfH != null ? near2.discHalfH : 0.07) + 0.04;
            if (by2 < topY2 + PLAYER_R * 0.98 && by2 > near2.discY - 1.42) {
              if (bestDh > discR2 * 0.84) voidGap = true;
            }
          }
        }
      }
      if (trk === 3 && this._vkT3SliderBodies && this._vkT3SliderBodies.length) {
        var list3 = this._vkT3SliderBodies;
        var bz3 = body.position.z;
        var by3 = body.position.y;
        var bx3 = body.position.x;
        if (bz3 < 2.78 && bz3 > -5.72) {
          var refY3 = list3[0].baseY + (list3[0].slabHalfY != null ? list3[0].slabHalfY : 0.07);
          if (by3 - PLAYER_R < refY3 + 0.34) {
            var s3 = now * 0.001;
            var onAny3 = false;
            var si3;
            for (si3 = 0; si3 < list3.length; si3++) {
              var p3 = list3[si3];
              if (!p3 || !p3.body || p3.halfHx == null) continue;
              var sn3 = p3.omega * s3 + p3.phase;
              var platX3 = p3.amp * Math.sin(sn3);
              var dx3 = bx3 - platX3;
              var dz3 = bz3 - p3.baseZ;
              if (
                Math.abs(dx3) <= p3.halfHx - PLAYER_R * 0.06 &&
                Math.abs(dz3) <= p3.halfHz - PLAYER_R * 0.06 &&
                by3 - PLAYER_R < refY3 + 0.22
              ) {
                onAny3 = true;
                break;
              }
            }
            var bestPlatX = bx3;
            var bestHalfHx = list3[0].halfHx != null ? list3[0].halfHx : 0.55;
            var bestHalfHz = list3[0].halfHz != null ? list3[0].halfHz : 0.55;
            var bestDz3 = 1e9;
            for (si3 = 0; si3 < list3.length; si3++) {
              var p3b = list3[si3];
              if (!p3b) continue;
              var dzz = Math.abs(bz3 - p3b.baseZ);
              if (dzz < bestDz3) {
                bestDz3 = dzz;
                var snb = p3b.omega * s3 + p3b.phase;
                bestPlatX = p3b.amp * Math.sin(snb);
                if (p3b.halfHx != null) bestHalfHx = p3b.halfHx;
                if (p3b.halfHz != null) bestHalfHz = p3b.halfHz;
              }
            }
            var nearSlabXZ =
              bestDz3 < bestHalfHz * 1.12 &&
              Math.abs(bx3 - bestPlatX) < bestHalfHx - PLAYER_R * 0.08;
            if (!onAny3 && !nearSlabXZ) voidGap = true;
          }
        }
      }
      return { dodgeLx: dodgeLx, wantJump: wantJump, pillarPin: pillarPin, voidGap: voidGap };
    },

    _vkSeekTowardWorld: function (s, z, wx, wy, wz, uhx, uhz, body, nowMs) {
      var trkW0 = this._vkCourseTrack | 0;
      if (trkW0 === 2 || trkW0 === 3) {
        var sgW = this._vkBotShortGoalWorld(body, nowMs, uhx, uhz, s);
        wx = wx * 0.22 + sgW.wx * 0.78;
        wz = wz * 0.22 + sgW.wz * 0.78;
      }
      var toX = wx - body.position.x;
      var toZ = wz - body.position.z;
      var toH = Math.sqrt(toX * toX + toZ * toZ) + 1e-5;
      var gx = toX / toH;
      var gz = toZ / toH;
      var wantYaw = Math.atan2(gx, gz);
      var cy = this._vkCarriageYawRad[s];
      var yawErr = wantYaw - cy;
      while (yawErr > Math.PI) yawErr -= Math.PI * 2;
      while (yawErr < -Math.PI) yawErr += Math.PI * 2;
      z.lx = clamp(yawErr * 3.65 + (wx - body.position.x) * 0.42, -1, 1);
      var vx = body.velocity.x;
      var vz = body.velocity.z;
      var vAlong = vx * uhx + vz * uhz;
      var trig = 0.74;
      if (vAlong < 0.1) trig = 0.96;
      if (body.position.y < wy - 0.08) trig = Math.max(trig, 0.88);
      z.trig = clamp(trig + 0.03 * Math.sin(nowMs * 0.0011 + s * 1.3), 0.52, 1);
      z.trigRev = vAlong < -0.16 ? 0.42 : 0;
      z.ry = clamp(-body.velocity.y * 0.034, -0.42, 0.42);
      z.rx = 0;
      var haz = this._vkBotHazardPack(body, uhx, uhz, nowMs);
      z.lx = clamp(z.lx + haz.dodgeLx, -1, 1);
      var trkSv = this._vkCourseTrack | 0;
      var sgRec = this._vkBotShortGoalWorld(body, nowMs, uhx, uhz, s);
      if (trkSv === 2 || trkSv === 3) {
        var jmT2 = trkSv === 2 ? 0.58 : 0.4;
        if (sgRec.suggestJump && body.velocity.y < 0.92 && Math.random() < jmT2) z.j = 1;
        else if (haz.pillarPin && haz.wantJump && Math.random() < 0.38) z.j = 1;
      } else if (haz.wantJump && !haz.voidGap && Math.random() < 0.45) {
        z.j = 1;
      }
    },

    _vkTryGhostBot: function (s, z, nowMs, uhx, uhz) {
      var G = this._vkBotGhost[s];
      if (!G || !G.rec || !G.rec.frames || !G.rec.frames.length) return false;
      if (!this.vkMatchActive) return false;
      var body = this.carBodies[s];
      var frames = G.rec.frames;
      var f0 = frames[0];
      if (!body || !vkGhostFrame0Valid(f0)) return false;
      var t23 = (this._vkCourseTrack | 0) === 2 || (this._vkCourseTrack | 0) === 3;
      /* playT0 = mid-match reset; vkMatchStartMs = after GO; else pre-GO (clip t≈0, no heuristic drift). */
      var elapsed;
      if (G.playT0 != null && isFinite(G.playT0)) {
        elapsed = nowMs - G.playT0;
      } else if (this.vkMatchStartMs) {
        elapsed = nowMs - this.vkMatchStartMs;
      } else {
        elapsed = 0;
      }
      if (elapsed < 0) elapsed = 0;
      var tIdx = Math.min(frames.length - 1, Math.floor(elapsed / VK_GHOST_SAMPLE_MS));
      var gtp = vkGhostTrackParams(this._vkCourseTrack);
      var pick = this._vkGhostBotPickFrameIndex(s, body, frames, f0, tIdx);
      var best = pick.best;
      var bestD2 = pick.bestD2;
      var bestD = Math.sqrt(bestD2);
      if (bestD < gtp.devM * 0.55) G.recoverUntil = 0;
      G.recIdx = best;
      var frUse = frames[best];
      var wT = this._vkGhostWorldTargetFromFrame(s, frUse, f0);
      if (!wT) return false;
      var needRecover = bestD > gtp.devM || G.recoverUntil > nowMs;
      if (bestD > gtp.devM && G.recoverUntil <= nowMs) {
        G.recoverUntil = nowMs + VK_GHOST_RECOVER_MS;
      }
      if (needRecover && bestD > gtp.recoverOk) {
        this._vkSeekTowardWorld(s, z, wT.x, wT.y, wT.z, uhx, uhz, body, nowMs);
        return true;
      }
      if (bestD <= gtp.recoverOk) G.recoverUntil = 0;
      var frN = frames[Math.min(frames.length - 1, best + 1)];
      var a = (elapsed - best * VK_GHOST_SAMPLE_MS) / VK_GHOST_SAMPLE_MS;
      if (a < 0) a = 0;
      if (a > 1) a = 1;
      z.lx = (frUse[4] || 0) * (1 - a) + (frN ? frN[4] || 0 : 0) * a;
      z.trig = clamp((frUse[5] || 0) * (1 - a) + (frN ? frN[5] || 0 : 0) * a, 0, 1);
      z.trigRev = clamp((frUse[6] || 0) * (1 - a) + (frN ? frN[6] || 0 : 0) * a, 0, 1);
      z.ry = clamp(-body.velocity.y * 0.032, -0.42, 0.42);
      z.rx = 0;
      var haz2 = this._vkBotHazardPack(body, uhx, uhz, nowMs);
      var allowJump = !haz2.voidGap || haz2.pillarPin;
      var trackOk = !needRecover || bestD <= gtp.recoverOk;
      var tightBand = Math.min(0.85, gtp.recoverOk * 0.72);
      var hazW = trackOk && bestD < tightBand ? (t23 ? 0.12 : 0.2) : t23 ? 0.38 : 0.55;
      if (t23) hazW = Math.max(hazW, 0.36);
      if (haz2.voidGap) hazW = Math.max(hazW, 0.58);
      var dodgeTerm = haz2.dodgeLx * hazW;
      if (t23) {
        var sgB = this._vkBotShortGoalWorld(body, nowMs, uhx, uhz, s);
        var cyB = this._vkCarriageYawRad[s];
        var dxb = sgB.wx - body.position.x;
        var dzb = sgB.wz - body.position.z;
        if (Math.abs(dxb) + Math.abs(dzb) < 1e-5) {
          dzb = -1;
          dxb = 0;
        }
        var wyB = Math.atan2(dxb, dzb);
        var yawEB = wyB - cyB;
        while (yawEB > Math.PI) yawEB -= Math.PI * 2;
        while (yawEB < -Math.PI) yawEB += Math.PI * 2;
        var lxWp = clamp(yawEB * 3.4 + dxb * 0.52, -1, 1);
        var wf = bestD < tightBand ? 0.35 : 0.66;
        z.lx = clamp(z.lx * (1 - wf) + lxWp * wf + dodgeTerm * 0.32, -1, 1);
        z.trig = clamp(z.trig, 0.52, 0.99);
        z.trigRev = Math.min(z.trigRev, 0.36);
        z.j = 0;
        if (
          allowJump &&
          (sgB.suggestJump || haz2.pillarPin) &&
          body.velocity.y < 0.95 &&
          ((this._vkCourseTrack | 0) === 2 ? Math.random() < 0.62 : Math.random() < 0.4)
        ) {
          z.j = 1;
        }
      } else {
        z.lx = clamp(z.lx + dodgeTerm, -1, 1);
        if (allowJump && (frUse[7] || 0) > 0.5) {
          if (Math.random() < 0.88) z.j = 1;
        }
        if (allowJump && haz2.wantJump && Math.random() < 0.18) z.j = 1;
      }
      return true;
    },

    /**
     * Simple bot race plan: aim at a point past the finish (−Z), yaw the carriage toward it, then full thrust
     * along the carriage forward axis (same control model as players).
     */
    /**
     * @param {boolean} [allowThrust] default true; false during pre-GO countdown (yaw toward goal only).
     */
    _vkGoalSeekBotFill: function (s, z, uhx, uhz, allowThrust, nowMs) {
      var body = this.carBodies[s];
      if (!body) return;
      var spawn = this._carSpawn[s];
      var phx = this._vkPathHalfX || 2.35;
      var pastZ = (this._vkFinishZ != null && isFinite(this._vkFinishZ) ? this._vkFinishZ : VK_FINISH_LINE_Z) - 2.65;
      var trkH = this._vkCourseTrack | 0;
      var sg = null;
      if (trkH === 2 || trkH === 3) sg = this._vkBotShortGoalWorld(body, nowMs, uhx, uhz, s);
      var dx;
      var dz;
      if (sg) {
        dx = sg.wx - body.position.x;
        dz = sg.wz - body.position.z;
      } else {
        var tx =
          spawn && typeof spawn.x === 'number'
            ? spawn.x * 0.42 + body.position.x * 0.58
            : body.position.x;
        tx = clamp(tx, -phx * 0.94, phx * 0.94);
        dx = tx - body.position.x;
        dz = pastZ - body.position.z;
      }
      if (Math.abs(dx) + Math.abs(dz) < 1e-5) {
        dz = -1;
        dx = 0;
      }
      var wantYaw = Math.atan2(dx, dz);
      var cy = this._vkCarriageYawRad[s];
      var yawErr = wantYaw - cy;
      while (yawErr > Math.PI) yawErr -= Math.PI * 2;
      while (yawErr < -Math.PI) yawErr += Math.PI * 2;
      z.lx = clamp(yawErr * 3.55, -1, 1);
      z.trigRev = 0;
      z.trig = Math.abs(yawErr) < 0.38 ? 1 : clamp(0.62 + 0.38 * (1 - Math.min(1, Math.abs(yawErr) / 1.9)), 0.55, 0.95);
      z.ry = clamp(-body.velocity.y * 0.032, -0.42, 0.42);
      z.rx = 0;
      var haz = this._vkBotHazardPack(body, uhx, uhz, nowMs);
      var dodgeW = trkH === 2 || trkH === 3 ? 0.24 : haz.voidGap ? 0.55 : 0.28;
      z.lx = clamp(z.lx + haz.dodgeLx * dodgeW, -1, 1);
      if (trkH !== 2 && trkH !== 3 && haz.wantJump && !haz.voidGap && Math.abs(yawErr) < 0.48 && Math.random() < 0.15) {
        z.j = 1;
      } else if (
        sg &&
        sg.suggestJump &&
        body.velocity.y < 0.95 &&
        (trkH === 2 ? Math.random() < 0.64 : Math.random() < 0.38)
      ) {
        z.j = 1;
      }
      if (allowThrust === false) {
        z.trig = 0;
        z.trigRev = 0;
      }
    },

    /**
     * Tracks 2–3: if the bot is asking for forward thrust but world velocity along the race direction
     * stays tiny while hugging a platform, queue a jump (host `_vkTryJump` still applies cooldown / grounded).
     */
    _vkBotUnstuckForwardJump: function (slot, z, body, uhx, uhz, nowMs) {
      var trk = this._vkCourseTrack | 0;
      if (trk !== 2 && trk !== 3) return;
      if (!body || !body.velocity) return;
      var trig = z.trig || 0;
      var rev = z.trigRev || 0;
      if (trig < 0.26 || rev > 0.52) return;
      var vy = body.velocity.y;
      if (vy > 0.78) return;
      var uhH = Math.sqrt(uhx * uhx + uhz * uhz) || 1;
      var uhxN = uhx / uhH;
      var uhzN = uhz / uhH;
      var vAlong = body.velocity.x * uhxN + body.velocity.z * uhzN;
      if (vAlong > 0.11) return;
      var bx = body.position.x;
      var bz = body.position.z;
      var by = body.position.y;
      if (trk === 2 && this._vkSpinnerBodies && this._vkSpinnerBodies.length) {
        var spb = this._vkSpinnerBodies;
        var si;
        var bestD = 1e9;
        var onCrown = false;
        for (si = 0; si < spb.length; si++) {
          var sp = spb[si];
          if (!sp || sp.discR == null) continue;
          var dx = bx - sp.cx;
          var dz = bz - sp.cz;
          var dh = Math.sqrt(dx * dx + dz * dz);
          if (dh < bestD) bestD = dh;
          if (dh < sp.discR * 0.4) {
            var dTop = sp.discY + (sp.discHalfH != null ? sp.discHalfH : 0.07);
            var bb = by - PLAYER_R;
            if (bb > dTop - 0.11 && bb < dTop + 0.2) onCrown = true;
          }
        }
        if (onCrown && bestD < 0.5) return;
        for (si = 0; si < spb.length; si++) {
          var sp2 = spb[si];
          if (!sp2 || sp2.discR == null) continue;
          var dx2 = bx - sp2.cx;
          var dz2 = bz - sp2.cz;
          if (dx2 * dx2 + dz2 * dz2 < (sp2.discR * 1.65) * (sp2.discR * 1.65)) {
            z.j = 1;
            return;
          }
        }
      } else if (trk === 3 && this._vkT3SliderBodies && this._vkT3SliderBodies.length) {
        var list3 = this._vkT3SliderBodies;
        var s3 = (nowMs != null && isFinite(nowMs) ? nowMs : performance.now()) * 0.001;
        var sj;
        for (sj = 0; sj < list3.length; sj++) {
          var p3 = list3[sj];
          if (!p3 || p3.halfHx == null) continue;
          var sn = p3.omega * s3 + p3.phase;
          var px = p3.amp * Math.sin(sn);
          if (Math.abs(bx - px) < p3.halfHx * 1.22 && Math.abs(bz - p3.baseZ) < p3.halfHz * 1.25) {
            z.j = 1;
            return;
          }
        }
      }
    },

    _vkApplyBotInputs: function (nowMs) {
      if (!this.isHost) return;
      var uh = this._vkUphill;
      var uhx = uh.x;
      var uhz = uh.z;
      var uhH = Math.sqrt(uhx * uhx + uhz * uhz);
      if (uhH < 1e-5) {
        uhx = 0;
        uhz = -1;
        uhH = 1;
      }
      uhx /= uhH;
      uhz /= uhH;
      var s;
      for (s = 0; s < VK_MAX_SLOTS; s++) {
        /* Human slots get input from the network / local gather; finished cars coast with zero AI. */
        if (this._vkIsHumanOccupyingSlot(s) || this._vkFinished[s]) continue;
        var body = this.carBodies[s];
        if (!body) continue;
        var z = zeroInput();
        if (this.vkMatchActive) {
          var preGo = !this.vkMatchStartMs;
          var ghosted = !preGo && this._vkTryGhostBot(s, z, nowMs, uhx, uhz);
          if (!ghosted) this._vkGoalSeekBotFill(s, z, uhx, uhz, !preGo, nowMs);
          if (!preGo) this._vkBotUnstuckForwardJump(s, z, body, uhx, uhz, nowMs);
        }
        this.inputs[s] = z;
      }
    },

    /** Right-stick cage lean (all slots on host; local slot on client + snap for others). */
    _vkUpdateCubeLeanFromInputs: function (localInp) {
      if (!this._vkCubeLeanPitchSn || !this._vkCubeLeanRollSn) return;
      var maxR = VK_CUBE_LEAN_MAX_RAD;
      var alpha = VK_CUBE_LEAN_SMOOTH;
      var ms = this.mySlot | 0;
      var i;
      for (i = 0; i < VK_MAX_SLOTS; i++) {
        if (!this.isHost && i !== ms) continue;
        var src = i === ms ? localInp : this.inputs[i];
        if (!src) continue;
        var tgtP = clamp((src.ry || 0) * maxR, -maxR, maxR);
        var tgtR = clamp((src.rx || 0) * maxR, -maxR, maxR);
        this._vkCubeLeanPitchSn[i] += (tgtP - this._vkCubeLeanPitchSn[i]) * alpha;
        this._vkCubeLeanRollSn[i] += (tgtR - this._vkCubeLeanRollSn[i]) * alpha;
      }
    },

    _vkEffectiveLeanPitchSlot: function (slot) {
      var s = (this._vkCubeLeanPitchSn && this._vkCubeLeanPitchSn[slot]) || 0;
      var d = (this._vkLeanDynPitch && this._vkLeanDynPitch[slot]) || 0;
      return clamp(s + d, -VK_LEAN_COMBINED_MAX_RAD, VK_LEAN_COMBINED_MAX_RAD);
    },

    _vkEffectiveLeanRollSlot: function (slot) {
      var s = (this._vkCubeLeanRollSn && this._vkCubeLeanRollSn[slot]) || 0;
      var d = (this._vkLeanDynRoll && this._vkLeanDynRoll[slot]) || 0;
      return clamp(s + d, -VK_LEAN_COMBINED_MAX_RAD, VK_LEAN_COMBINED_MAX_RAD);
    },

    /**
     * Spring-damped motion lean from yaw×forward speed (centrifugal-style roll) and longitudinal accel (pitch).
     * Host: call from _applyCarControls with yaw rate from this frame’s carriage change. Client: call from tick
     * with yaw rate from finite-differenced replicated cy.
     */
    _vkStepDynamicLeanForSlot: function (slot, dtSec, yawRate, body) {
      if (!this._vkLeanDynRoll || !this._vkLeanDynPitch || !body) return;
      if (!dtSec || dtSec <= 0 || dtSec > 0.12) dtSec = 1 / 60;
      if (!this.vkMatchActive || !this.vkMatchStartMs) {
        this._vkLeanDynRoll[slot] *= 0.86;
        this._vkLeanDynPitch[slot] *= 0.86;
        this._vkLeanDynRollVel[slot] *= 0.84;
        this._vkLeanDynPitchVel[slot] *= 0.84;
        return;
      }
      var cy =
        this._vkCarriageYawRad && typeof this._vkCarriageYawRad[slot] === 'number'
          ? this._vkCarriageYawRad[slot]
          : 0;
      var fhx = Math.sin(cy);
      var fhz = Math.cos(cy);
      var vx = body.velocity.x;
      var vz = body.velocity.z;
      var vFwd = vx * fhx + vz * fhz;
      var prevV = this._vkDynLeanPrevVFwd[slot];
      var aFwd = (vFwd - prevV) / dtSec;
      this._vkDynLeanPrevVFwd[slot] = vFwd;

      var desiredRoll = clamp(
        VK_DYN_LEAN_YAW_ROLL_SIGN * yawRate * vFwd * VK_DYN_LEAN_YAW_V_GAIN,
        -VK_DYN_LEAN_MAX_ROLL,
        VK_DYN_LEAN_MAX_ROLL
      );
      var desiredPitch = clamp(
        -aFwd * VK_DYN_LEAN_ACCEL_PITCH_GAIN,
        -VK_DYN_LEAN_MAX_PITCH,
        VK_DYN_LEAN_MAX_PITCH
      );

      var dr = this._vkLeanDynRoll[slot];
      var dvr = this._vkLeanDynRollVel[slot];
      var er = desiredRoll - dr;
      dvr += (VK_DYN_LEAN_SPRING * er - VK_DYN_LEAN_DAMP * dvr) * dtSec;
      dr += dvr * dtSec;
      dr = clamp(dr, -VK_DYN_LEAN_MAX_ROLL, VK_DYN_LEAN_MAX_ROLL);
      dvr = clamp(dvr, -VK_DYN_LEAN_ROLL_VEL_MAX, VK_DYN_LEAN_ROLL_VEL_MAX);
      this._vkLeanDynRollVel[slot] = dvr;
      this._vkLeanDynRoll[slot] = dr;

      var dp = this._vkLeanDynPitch[slot];
      var dvp = this._vkLeanDynPitchVel[slot];
      var ep = desiredPitch - dp;
      dvp += (VK_DYN_LEAN_SPRING * ep - VK_DYN_LEAN_DAMP * dvp) * dtSec;
      dp += dvp * dtSec;
      dp = clamp(dp, -VK_DYN_LEAN_MAX_PITCH, VK_DYN_LEAN_MAX_PITCH);
      dvp = clamp(dvp, -VK_DYN_LEAN_PITCH_VEL_MAX, VK_DYN_LEAN_PITCH_VEL_MAX);
      this._vkLeanDynPitchVel[slot] = dvp;
      this._vkLeanDynPitch[slot] = dp;
      if (this._vkDynLeanYawPrev && this._vkCarriageYawRad) {
        this._vkDynLeanYawPrev[slot] = this._vkCarriageYawRad[slot];
      }
    },

    _vkUpdateDynamicLeanClient: function (dtSec) {
      if (this.isHost || !this._vkLeanDynRoll || !this.carBodies) return;
      if (!dtSec || dtSec <= 0 || dtSec > 0.12) dtSec = 1 / 60;
      var slot;
      for (slot = 0; slot < VK_MAX_SLOTS; slot++) {
        var body = this.carBodies[slot];
        if (!body || !this._vkCarriageYawRad) continue;
        var prev = this._vkDynLeanYawPrev[slot];
        var cy = this._vkCarriageYawRad[slot];
        var dYaw = cy - prev;
        while (dYaw > Math.PI) dYaw -= Math.PI * 2;
        while (dYaw < -Math.PI) dYaw += Math.PI * 2;
        var yawRate = clamp(dYaw / dtSec, -VK_DYN_LEAN_YAW_RATE_CLAMP, VK_DYN_LEAN_YAW_RATE_CLAMP);
        this._vkStepDynamicLeanForSlot(slot, dtSec, yawRate, body);
      }
    },

    _vkInitDynamicLeanState: function () {
      if (!this._vkLeanDynRoll || !this._vkCarriageYawRad) return;
      var i;
      for (i = 0; i < VK_MAX_SLOTS; i++) {
        this._vkLeanDynRoll[i] = 0;
        this._vkLeanDynRollVel[i] = 0;
        this._vkLeanDynPitch[i] = 0;
        this._vkLeanDynPitchVel[i] = 0;
        this._vkDynLeanPrevVFwd[i] = 0;
        this._vkDynLeanYawPrev[i] =
          typeof this._vkCarriageYawRad[i] === 'number' && isFinite(this._vkCarriageYawRad[i])
            ? this._vkCarriageYawRad[i]
            : 0;
      }
    },

    /**
     * Scales commanded carriage yaw (rad this frame) for humans at speed: wide line if upright, sharper if
     * rolled into the corner. Uses stick-smoothed roll + previous-frame motion roll vs ideal inward lean.
     */
    _vkMotorcycleYawScale: function (yawCmdRadPerSec, vFwd, stickRollSn, dynRoll) {
      var I = Math.abs(yawCmdRadPerSec) * Math.abs(vFwd);
      var blend = clamp((I - VK_MOTO_INTENSITY_I0) / VK_MOTO_INTENSITY_IW, 0, 1);
      if (blend < 0.004) return 1;
      var outRef =
        VK_DYN_LEAN_YAW_ROLL_SIGN * yawCmdRadPerSec * vFwd * VK_DYN_LEAN_YAW_V_GAIN;
      outRef = clamp(outRef, -VK_DYN_LEAN_MAX_ROLL, VK_DYN_LEAN_MAX_ROLL);
      var idealInwardRoll = -outRef * VK_MOTO_IDEAL_INWARD_FACTOR;
      var totalR = (stickRollSn || 0) + (dynRoll || 0);
      var err = Math.abs(idealInwardRoll - totalR);
      var match = 1 - clamp(err / VK_MOTO_LEAN_ERR_BAND_RAD, 0, 1);
      var scale =
        (1 - blend * (1 - VK_MOTO_YAW_MIN_MULT) * (1 - match)) *
        (1 + blend * match * (VK_MOTO_YAW_BONUS_MAX - 1));
      return clamp(scale, VK_MOTO_YAW_HARD_MIN, VK_MOTO_YAW_HARD_MAX);
    },

    _vkResetMotionLeanSlot: function (slot) {
      if (!this._vkLeanDynRoll || typeof slot !== 'number' || slot < 0 || slot >= VK_MAX_SLOTS) return;
      this._vkLeanDynRoll[slot] = 0;
      this._vkLeanDynRollVel[slot] = 0;
      this._vkLeanDynPitch[slot] = 0;
      this._vkLeanDynPitchVel[slot] = 0;
      this._vkDynLeanPrevVFwd[slot] = 0;
      if (this._vkCarriageYawRad && typeof this._vkCarriageYawRad[slot] === 'number') {
        this._vkDynLeanYawPrev[slot] = this._vkCarriageYawRad[slot];
      } else {
        this._vkDynLeanYawPrev[slot] = 0;
      }
    },

    /**
     * After `world.step`, Cannon keeps active pairs in `world.contacts`. Resting bodies often stop firing
     * `collide` events every frame, so we refresh jump support from the solved contact normals here.
     */
    _vkRefreshGroundedFromContactsPostStep: function () {
      var contacts = this.world && this.world.contacts;
      if (!contacts || !contacts.length) return;
      var k;
      for (k = 0; k < contacts.length; k++) {
        var eq = contacts[k];
        if (!eq || !eq.bi || !eq.bj || !eq.ni) continue;
        var bi = eq.bi;
        var bj = eq.bj;
        var biCar = typeof bi.vkSlot === 'number' && bi.vkSlot >= 0 && bi.vkSlot < VK_MAX_SLOTS;
        var bjCar = typeof bj.vkSlot === 'number' && bj.vkSlot >= 0 && bj.vkSlot < VK_MAX_SLOTS;
        if (biCar && bjCar) continue;
        var slot = biCar ? bi.vkSlot : bjCar ? bj.vkSlot : null;
        if (slot == null) continue;
        var carBody = this.carBodies[slot];
        var ny = eq.ni.y;
        if (typeof ny !== 'number' || !isFinite(ny)) continue;
        if (Math.abs(ny) > 0.1) {
          this._vkGrounded[slot] = Math.max(this._vkGrounded[slot] | 0, 30);
        } else {
          var nx = eq.ni.x;
          var nz = eq.ni.z;
          if (typeof nx === 'number' && typeof nz === 'number') {
            var hor = Math.sqrt(nx * nx + nz * nz);
            if (hor > 0.55 && Math.abs(ny) < 0.55 && carBody && carBody.velocity.y < 1.05) {
              this._vkGrounded[slot] = Math.max(this._vkGrounded[slot] | 0, 12);
            }
          }
        }
      }
    },

    _vkTickGroundedDecay: function () {
      var i;
      for (i = 0; i < VK_MAX_SLOTS; i++) {
        if (this._vkGrounded[i] > 0) this._vkGrounded[i]--;
      }
    },

    _vkCheckFinish: function () {
      if (!this.isHost || !this.vkMatchActive || !this.vkMatchStartMs) return;
      var i;
      for (i = 0; i < VK_MAX_SLOTS; i++) {
        if (this._vkFinished[i]) continue;
        var b = this.carBodies[i];
        if (!b) continue;
        var finMinY =
          this._vkFinishQualifyMinY != null && isFinite(this._vkFinishQualifyMinY)
            ? this._vkFinishQualifyMinY
            : VK_FINISH_QUALIFY_MIN_Y;
        var finMaxY =
          this._vkFinishQualifyMaxY != null && isFinite(this._vkFinishQualifyMaxY)
            ? this._vkFinishQualifyMaxY
            : 8.0;
        var finHalfX =
          this._vkFinishQualifyHalfX != null && isFinite(this._vkFinishQualifyHalfX)
            ? this._vkFinishQualifyHalfX
            : (this._vkPathHalfX || 2.35) + 0.55;
        var finZMin =
          this._vkFinishCheckZMin != null && isFinite(this._vkFinishCheckZMin)
            ? this._vkFinishCheckZMin
            : VK_FINISH_CHECK_Z_MIN;
        var finZPlane = this._vkFinishZ != null && isFinite(this._vkFinishZ) ? this._vkFinishZ : VK_FINISH_LINE_Z;
        var finZPast = finZPlane + 0.55;
        if (
          b.position.z <= finZPast &&
          b.position.z >= finZMin &&
          Math.abs(b.position.x) < finHalfX &&
          b.position.y > finMinY &&
          b.position.y < finMaxY
        ) {
          var ghostCopy = null;
          if (this._vkIsHumanOccupyingSlot(i)) {
            if (
              this._vkGhostRecBufBySlot &&
              this._vkGhostRecBufBySlot[i] &&
              this._vkGhostRecBufBySlot[i].length >= 12
            ) {
              ghostCopy = this._vkGhostRecBufBySlot[i].slice();
            }
          }
          this._vkFinished[i] = true;
          var finMs = Math.round(performance.now() - this.vkMatchStartMs);
          if (ghostCopy && ghostCopy.length >= 12) {
            this._vkGhostCommitFinish(finMs, i, ghostCopy);
            this._vkGiveFinishedRecordingToBot(ghostCopy, finMs, i);
          }
          if (this._vkGhostRecBufBySlot && this._vkGhostRecBufBySlot[i]) {
            this._vkGhostRecBufBySlot[i].length = 0;
          }
          this._vkFinishOrder.push(i);
          this._vkRoundFinishes.push({ slot: i, ms: finMs });
          this._vkRefreshMatchResultsPanel();
          this._vkPlayFinishPodiumFx(b.position.x, b.position.y, b.position.z, i + 1);
          this._setStatus('Player ' + (i + 1) + ' reached the finish!');
          this._vkMarkHudDirty();
          this._pulseHand(vkHandEl('rightHand', 'vl-hand-right'), 0.6, 70);
          var qn = 0;
          var q;
          for (q = 0; q < VK_MAX_SLOTS; q++) {
            if (this._vkFinished[q]) qn++;
          }
          if (qn >= VK_MAX_SLOTS) {
            this.vkEndMatch('Everyone qualified!');
          }
        }
      }
    },

    _syncMeshesFromPhysics: function () {
      var i;
      for (i = 0; i < this.rockBodies.length; i++) {
        var rb = this.rockBodies[i];
        var re = this.rockEls[i];
        if (rb && re) {
          re.object3D.position.set(rb.position.x, rb.position.y, rb.position.z);
          re.object3D.quaternion.set(rb.quaternion.x, rb.quaternion.y, rb.quaternion.z, rb.quaternion.w);
        }
      }
      if (this._vkSpinnerBodies && this._vkSpinnerBodies.length) {
        for (i = 0; i < this._vkSpinnerBodies.length; i++) {
          var spn = this._vkSpinnerBodies[i];
          if (!spn || !spn.discBody || !spn.discEl || !spn.discEl.object3D) continue;
          spn.discEl.object3D.position.set(spn.discBody.position.x, spn.discBody.position.y, spn.discBody.position.z);
          spn.discEl.object3D.quaternion.set(
            spn.discBody.quaternion.x,
            spn.discBody.quaternion.y,
            spn.discBody.quaternion.z,
            spn.discBody.quaternion.w
          );
          if (spn.barBody && spn.barEl && spn.barEl.object3D) {
            var bwb = spn.barBody;
            spn.barEl.object3D.position.set(bwb.position.x, bwb.position.y, bwb.position.z);
            spn.barEl.object3D.quaternion.set(bwb.quaternion.x, bwb.quaternion.y, bwb.quaternion.z, bwb.quaternion.w);
          }
        }
      }
      if (this._vkT3SliderBodies && this._vkT3SliderBodies.length) {
        for (i = 0; i < this._vkT3SliderBodies.length; i++) {
          var tp = this._vkT3SliderBodies[i];
          if (!tp || !tp.body || !tp.el || !tp.el.object3D) continue;
          tp.el.object3D.position.set(tp.body.position.x, tp.body.position.y, tp.body.position.z);
          tp.el.object3D.quaternion.set(
            tp.body.quaternion.x,
            tp.body.quaternion.y,
            tp.body.quaternion.z,
            tp.body.quaternion.w
          );
        }
      }
      for (i = 0; i < VK_MAX_SLOTS; i++) {
        if (this.carEls[i] && this.carBodies[i]) {
          var b = this.carBodies[i];
          var wrap = this.carEls[i];
          wrap.object3D.position.set(b.position.x, b.position.y, b.position.z);

          /* Carriage (cube) yaw is player-driven via left stick; do not overwrite from ball velocity. */
          var qBody = this._tmpQ;
          qBody.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
          var yaw = this._vkCarriageYawRad[i];
          this._vkCarriageQ.setFromAxisAngle(this._vkWorldUp, yaw);
          wrap.object3D.quaternion.copy(this._vkCarriageQ);

          this._vkCarriageQInv.copy(this._vkCarriageQ).invert();
          this._vkBallMeshQ.multiplyQuaternions(this._vkCarriageQInv, qBody);
          var ballEl = wrap.querySelector && wrap.querySelector('.vk-player-ball');
          if (ballEl && ballEl.object3D) {
            ballEl.object3D.quaternion.set(
              this._vkBallMeshQ.x,
              this._vkBallMeshQ.y,
              this._vkBallMeshQ.z,
              this._vkBallMeshQ.w
            );
          }
          var lpiv = this._vkCubeLeanPivotEls && this._vkCubeLeanPivotEls[i];
          if (lpiv && lpiv.object3D) {
            var pSn = this._vkEffectiveLeanPitchSlot(i);
            var rSn = this._vkEffectiveLeanRollSlot(i);
            this._vkLeanQPitch.setFromAxisAngle(this._vkLeanAxisX, pSn);
            this._vkLeanQRoll.setFromAxisAngle(this._vkLeanAxisZ, rSn);
            this._vkLeanQComb.multiplyQuaternions(this._vkLeanQRoll, this._vkLeanQPitch);
            lpiv.object3D.quaternion.copy(this._vkLeanQComb);
          }
          var crown = wrap.querySelector && wrap.querySelector('.vk-player-crown');
          if (crown) crown.setAttribute('visible', this._vkFinished[i] ? true : false);
        }
      }
    },

    _vkGatherLedCams: function (outArr) {
      outArr.length = 0;
      var p;
      var inp;
      if (this.isHost) {
        for (p = 0; p < VK_MAX_SLOTS; p++) {
          inp = this.inputs[p];
          if (inp && inp.camOk) {
            outArr.push({ x: inp.camx, y: inp.camy, z: inp.camz });
          }
        }
      } else {
        var scn = this.el.sceneEl || this.el;
        if (vkGetCameraWorldPosition(scn, this._vkLedCamPos)) {
          outArr.push({ x: this._vkLedCamPos.x, y: this._vkLedCamPos.y, z: this._vkLedCamPos.z });
        }
      }
    },

    _vkLedTongueNearBody: function (body, cams) {
      if (!body || !cams || !cams.length) return false;
      var proxM2 = 0.42 * 0.42;
      var ci;
      for (ci = 0; ci < cams.length; ci++) {
        var dx = cams[ci].x - body.position.x;
        var dy = cams[ci].y - body.position.y;
        var dz = cams[ci].z - body.position.z;
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < proxM2 && d2 > 1e-10) return true;
      }
      return false;
    },

    /** Tongue (VR cam / head proximity) overrides brief impact face, which overrides idle. */
    _vkLedResolveMode: function (slot, body, cams) {
      if (this._vkLedTongueNearBody(body, cams)) return 'tongue';
      if (this._vkLedHitRemainMs && this._vkLedHitRemainMs[slot] > 0) return 'hit';
      return 'neutral';
    },

    /**
     * VRLeague-style LED: idle grid, “tongue” when a player head/cam is near that ball, impact face after bumps.
     */
    _vkUpdateCarLedFaces: function () {
      if (!this._vkCarLed || !this.carBodies) return;
      var cams = this._vkLedCamsBuf;
      this._vkGatherLedCams(cams);
      var i;
      var L;
      var body;
      var mode;
      for (i = 0; i < VK_MAX_SLOTS; i++) {
        L = this._vkCarLed[i];
        body = this.carBodies[i];
        if (!L || !body || !L.ctx) continue;
        mode = this._vkLedResolveMode(i, body, cams);
        if (mode !== L.lastDrawnMode) {
          vkDrawLedFace(L.ctx, L.canvasW, L.canvasH, mode, L.ledBodyColor || '#888888');
          L.texture.needsUpdate = true;
          L.lastDrawnMode = mode;
        }
      }
    },

    _serializeSnap: function () {
      var now = performance.now();
      var rem = null;
      var vlPreStart = false;
      if (this.vkMatchActive) {
        if (this.vkMatchStartMs) {
          rem = Math.max(0, (VK_MATCH_DURATION_MS - (now - this.vkMatchStartMs)) / 1000);
        } else {
          vlPreStart = true;
          rem = Math.max(0, (VK_MATCH_START_COUNTDOWN_MS - (now - this._vkMatchCountdownT0)) / 1000);
        }
      }
      var rocks = [];
      for (var r = 0; r < this.rockBodies.length; r++) {
        var b = this.rockBodies[r];
        rocks.push({
          p: [b.position.x, b.position.y, b.position.z],
          q: [b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w],
          v: [b.velocity.x, b.velocity.y, b.velocity.z],
          av: [b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z]
        });
      }
      var zPad = [];
      var zp;
      for (zp = 0; zp < VK_MAX_SLOTS; zp++) zPad.push(0);
      var oPad = [];
      for (zp = 0; zp < VK_MAX_SLOTS; zp++) oPad.push(1);
      var nickPad = [];
      for (zp = 0; zp < VK_MAX_SLOTS; zp++) nickPad.push('');
      var snap = {
        t: now,
        score0: 0,
        score1: 0,
        vkMatchActive: !!this.vkMatchActive,
        vkMatchRemainSec: rem,
        vlPreStart: vlPreStart,
        vkFin: this._vkFinished.slice(),
        ball: rocks.length
          ? {
              p: rocks[0].p,
              q: rocks[0].q,
              v: rocks[0].v,
              av: rocks[0].av
            }
          : { p: [0, -20, 0], q: [0, 0, 0, 1], v: [0, 0, 0], av: [0, 0, 0] },
        cars: [],
        rocks: rocks,
        vlLm: zPad.slice(),
        cvSc: oPad.slice(),
        vlPu: { i: zPad.slice(), o: null, d: [] },
        lh: this._vkLedHitRemainMs ? this._vkLedHitRemainMs.slice() : zPad.slice(),
        vkNick4: this._vkSlotDisplayNames ? this._vkSlotDisplayNames.slice() : nickPad.slice(),
        vkRoundFin: (this._vkRoundFinishes || []).map(function (r) {
          return { slot: r.slot | 0, ms: r.ms | 0 };
        }),
        vkSpawnLanes:
          this._vkSlotSpawnLaneIdx && this._vkSlotSpawnLaneIdx.length === VK_MAX_SLOTS
            ? this._vkSlotSpawnLaneIdx.slice()
            : null,
        vkLp: this._vkCubeLeanPitchSn ? this._vkCubeLeanPitchSn.slice() : zPad.slice(),
        vkLr: this._vkCubeLeanRollSn ? this._vkCubeLeanRollSn.slice() : zPad.slice()
      };
      for (var ci = 0; ci < VK_MAX_SLOTS; ci++) {
        var c = this.carBodies[ci];
        snap.cars.push({
          p: [c.position.x, c.position.y, c.position.z],
          q: [c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w],
          v: [c.velocity.x, c.velocity.y, c.velocity.z],
          av: [c.angularVelocity.x, c.angularVelocity.y, c.angularVelocity.z],
          cy: this._vkCarriageYawRad && typeof this._vkCarriageYawRad[ci] === 'number' ? this._vkCarriageYawRad[ci] : 0
        });
      }
      return snap;
    },

    _applyNetworkSnap: function (snap) {
      if (!snap || !snap.cars) return;
      if (!this.isHost && snap.vkSpawnLanes && snap.vkSpawnLanes.length === VK_MAX_SLOTS) {
        var li;
        var changed = false;
        if (!this._vkSlotSpawnLaneIdx || this._vkSlotSpawnLaneIdx.length < VK_MAX_SLOTS) {
          this._vkSlotSpawnLaneIdx = [0, 1, 2, 3, 8, 9, 10, 11];
          changed = true;
        }
        for (li = 0; li < VK_MAX_SLOTS; li++) {
          var nv = snap.vkSpawnLanes[li] | 0;
          if ((this._vkSlotSpawnLaneIdx[li] | 0) !== nv) changed = true;
          this._vkSlotSpawnLaneIdx[li] = nv;
        }
        if (changed) {
          this._vkRebuildCarSpawnFromRot(window.isMultiplayer ? 0 : this._vkMatchSpawnRot || 0);
          this._vkUpdateLaneMarkerColorsAndPositions();
        }
      }
      if (!this.isHost && snap.rocks && snap.rocks.length) {
        for (var r = 0; r < snap.rocks.length && r < this.rockBodies.length; r++) {
          var br = this.rockBodies[r];
          var sr = snap.rocks[r];
          if (!br || !sr || !sr.p) continue;
          br.position.set(sr.p[0], sr.p[1], sr.p[2]);
          br.quaternion.set(sr.q[0], sr.q[1], sr.q[2], sr.q[3]);
          br.velocity.set(sr.v[0], sr.v[1], sr.v[2]);
          if (sr.av) br.angularVelocity.set(sr.av[0], sr.av[1], sr.av[2]);
        }
      }
      if (snap.vkFin && snap.vkFin.length) {
        var nf = Math.min(VK_MAX_SLOTS, snap.vkFin.length);
        for (var f = 0; f < nf; f++) {
          var wasFin = !!this._vkFinished[f];
          var nowFin = !!snap.vkFin[f];
          if (!wasFin && nowFin && snap.cars && snap.cars[f] && snap.cars[f].p) {
            var pf = snap.cars[f].p;
            this._vkPlayFinishPodiumFx(pf[0], pf[1], pf[2], f + 1);
          }
          this._vkFinished[f] = nowFin;
        }
      }
      for (var i = 0; i < VK_MAX_SLOTS; i++) {
        if (!snap.cars[i]) continue;
        var c = snap.cars[i];
        var body = this.carBodies[i];
        if (!body) continue;
        if (this.isHost && i === this.mySlot) continue;
        body.position.set(c.p[0], c.p[1], c.p[2]);
        body.quaternion.set(c.q[0], c.q[1], c.q[2], c.q[3]);
        body.velocity.set(c.v[0], c.v[1], c.v[2]);
        if (c.av) body.angularVelocity.set(c.av[0], c.av[1], c.av[2]);
        if (this._vkCarriageYawRad && typeof c.cy === 'number' && isFinite(c.cy)) {
          this._vkCarriageYawRad[i] = c.cy;
        }
      }
      if (
        !this.isHost &&
        snap.vkLp &&
        snap.vkLr &&
        snap.vkLp.length === VK_MAX_SLOTS &&
        snap.vkLr.length === VK_MAX_SLOTS &&
        this._vkCubeLeanPitchSn &&
        this._vkCubeLeanRollSn
      ) {
        var msl = this.mySlot | 0;
        for (var li = 0; li < VK_MAX_SLOTS; li++) {
          if (li === msl) continue;
          var vpi = snap.vkLp[li];
          var vri = snap.vkLr[li];
          this._vkCubeLeanPitchSn[li] = typeof vpi === 'number' && isFinite(vpi) ? vpi : 0;
          this._vkCubeLeanRollSn[li] = typeof vri === 'number' && isFinite(vri) ? vri : 0;
        }
      }
      if (typeof snap.vkMatchActive === 'boolean') {
        this.vkMatchActive = snap.vkMatchActive;
      }
      if (typeof snap.vlPreStart === 'boolean') {
        if (!this.isHost && this._vkClientMatchPreStart && !snap.vlPreStart && this.vkMatchActive) {
          var gNow = performance.now();
          this._vkGoFlashUntil = gNow + 780;
          var bounceC = document.getElementById('vl-bounce-sound');
          if (bounceC && bounceC.components && bounceC.components.sound) bounceC.components.sound.playSound();
        }
        this._vkClientMatchPreStart = snap.vlPreStart;
      }
      if (typeof snap.vkMatchRemainSec === 'number' && isFinite(snap.vkMatchRemainSec)) {
        this.vkMatchRemainSec = snap.vkMatchRemainSec;
      }
      if (snap.lh && snap.lh.length && this._vkLedHitRemainMs) {
        var nlh = Math.min(VK_MAX_SLOTS, snap.lh.length);
        for (var lh = 0; lh < nlh; lh++) {
          var vh = snap.lh[lh];
          if (typeof vh === 'number' && isFinite(vh)) {
            this._vkLedHitRemainMs[lh] = vh;
          }
        }
      }
      if (snap.vkNick4 && snap.vkNick4.length) {
        var ni;
        var nn = Math.min(VK_MAX_SLOTS, snap.vkNick4.length);
        for (ni = 0; ni < nn; ni++) {
          this._vkSlotDisplayNames[ni] =
            typeof snap.vkNick4[ni] === 'string' && snap.vkNick4[ni].trim()
              ? snap.vkNick4[ni].trim().slice(0, 18)
              : this._vkSlotDisplayNames[ni] || 'Player ' + (ni + 1);
        }
      }
      if (Array.isArray(snap.vkRoundFin)) {
        this._vkRoundFinishes = [];
        var rf;
        for (rf = 0; rf < snap.vkRoundFin.length; rf++) {
          var rr = snap.vkRoundFin[rf];
          if (!rr || typeof rr.slot !== 'number' || typeof rr.ms !== 'number') continue;
          this._vkRoundFinishes.push({ slot: rr.slot | 0, ms: rr.ms | 0 });
        }
        this._vkRefreshMatchResultsPanel();
      }
      this._vkMarkHudDirty();
    },

    _vkTickMatchCountdownHost: function (now) {
      if (!this.vkMatchActive || this.vkMatchStartMs) return;
      var remPre = Math.max(0, Math.ceil((VK_MATCH_START_COUNTDOWN_MS - (now - this._vkMatchCountdownT0)) / 1000));
      if (remPre !== this._vkLastCountdownSec && remPre > 0) {
        this._vkLastCountdownSec = remPre;
        var son = document.getElementById('vl-pu-sonar-sound');
        if (son && son.components && son.components.sound) son.components.sound.playSound();
      }
      if (now - this._vkMatchCountdownT0 >= VK_MATCH_START_COUNTDOWN_MS) {
        this.vkMatchStartMs = now;
        this._vkResetBotHillProgress(now);
        this._vkGoFlashUntil = now + 780;
        this._vkLastCountdownSec = -999;
        this._setStatus('GO! Race uphill — dodge the boulders; B or either grip to jump.');
        /* Allow first rock wave on the next tick (was `now + 800`, which delayed waves by ~interval + 800 ms). */
        this._vkRockSpawnNext = now - ROCK_SPAWN_INTERVAL_MS - 1;
        var bounce = document.getElementById('vl-bounce-sound');
        if (bounce && bounce.components && bounce.components.sound) bounce.components.sound.playSound();
        this._vkBroadcastMatchSync();
        this._vkMarkHudDirty();
      }
    },

    vkStartMatch: function () {
      if (!this.isHost) return;
      if (this.vkMatchActive) return;
      this.vkMatchActive = true;
      this.vkMatchStartMs = 0;
      this._vkMatchCountdownT0 = performance.now();
      /* First boulder wave on next tick (same as post–GO) — hazards roll during countdown. */
      this._vkRockSpawnNext = performance.now() - ROCK_SPAWN_INTERVAL_MS - 1;
      this._vkLastCountdownSec = -999;
      this._vkGoFlashUntil = 0;
      this._vkFinished = [];
      for (var fi = 0; fi < VK_MAX_SLOTS; fi++) this._vkFinished.push(false);
      this._vkFinishOrder = [];
      this._vkRoundFinishes = [];
      this._vkRebuildSlotNamesHost();
      if (!window.isMultiplayer) {
        var curR = (parseInt(localStorage.getItem(VK_SPAWN_LANE_ROT_KEY), 10) || 0) % 4;
        this._vkMatchSpawnRot = curR;
        try {
          localStorage.setItem(VK_SPAWN_LANE_ROT_KEY, String((curR + 1) % 4));
        } catch (eRot) {}
      } else {
        this._vkMatchSpawnRot = 0;
      }
      this._vkGhostRecBuf = null;
      this._vkGhostLastSample = 0;
      this._vkSessionGhostRuns = [];
      this._vkGhostRecBufBySlot = [];
      var gsi;
      for (gsi = 0; gsi < VK_MAX_SLOTS; gsi++) {
        this._vkGhostRecBufBySlot.push(this._vkIsHumanOccupyingSlot(gsi) ? [] : null);
      }
      this._resetRoundBodies();
      this._vkAssignBotGhosts();
      this._setStatus('Get ready… countdown on the HUD.');
      this._vkSetMatchMusicPlaying(true);
      this._vkBroadcastLobbyToClients();
      this._vkBroadcastMatchSync();
      this._vkMarkHudDirty();
      this._vkEmitLobbyUpdated();
      this._vkRefreshLeaderboardPanels();
    },

    vkEndMatch: function (reason) {
      if (!this.isHost) return;
      this._vkDisposeSpineGuideLine();
      this.vkMatchActive = false;
      this.vkMatchStartMs = 0;
      this.vkMatchRemainSec = null;
      this._vkClientMatchPreStart = false;
      this._vkGoFlashUntil = 0;
      this._vkLastCountdownSec = -999;
      this._vkStopFinishFxCelebration();
      this._vkGhostRecBuf = null;
      this._vkSessionGhostRuns = [];
      if (this._vkGhostRecBufBySlot) {
        var ge;
        for (ge = 0; ge < this._vkGhostRecBufBySlot.length; ge++) this._vkGhostRecBufBySlot[ge] = null;
      }
      var banner = reason ? String(reason) : 'Match over.';
      this._setStatus(banner);
      this._vkSetMatchMusicPlaying(false);
      this._vkBroadcastLobbyToClients();
      this._vkBroadcastMatchSync({ endBanner: banner });
      this._vkMarkHudDirty();
      this._vkEmitLobbyUpdated();
    },

    vkToggleMatchFromMenu: function () {
      if (!this.isHost) return;
      if (this.vkMatchActive) this.vkEndMatch('Match ended from menu.');
      else this.vkStartMatch();
    },

    _vkRebuildCarSpawnFromRot: function (rot) {
      if (!this._carSpawn || this._carSpawn.length < VK_MAX_SLOTS || this._vkSpawnPhysY == null) return;
      var phx = this._vkPathHalfX || 2.35;
      var z0 = this._vkSpawnBaseZ;
      var spawnY = this._vkSpawnPhysY;
      var idQ = { x: 0, y: 0, z: 0, w: 1 };
      var yawUp = Math.atan2(this._vkUphill.x, this._vkUphill.z);
      var r = (rot | 0) % 4;
      var i;
      if (!this._vkSlotSpawnLaneIdx || this._vkSlotSpawnLaneIdx.length < VK_MAX_SLOTS) {
        this._vkSlotSpawnLaneIdx = [0, 1, 2, 3, 8, 9, 10, 11];
      }
      for (i = 0; i < VK_MAX_SLOTS; i++) {
        var laneIdx = this._vkSlotSpawnLaneIdx[i] | 0;
        if (laneIdx < 0 || laneIdx >= VK_SPAWN_LANE_COUNT) laneIdx = (i * 4 + r * 2) % VK_SPAWN_LANE_COUNT;
        var xz = vkWorldXZForLane(phx, z0, r, laneIdx);
        var sx = xz.x;
        var sz = xz.z;
        var s = this._carSpawn[i];
        if (!s) continue;
        s.x = sx;
        s.y = spawnY;
        s.z = sz;
        s.qx = idQ.x;
        s.qy = idQ.y;
        s.qz = idQ.z;
        s.qw = idQ.w;
        var body = this.carBodies[i];
        if (body) {
          body.position.set(sx, spawnY, sz);
          body.quaternion.set(idQ.x, idQ.y, idQ.z, idQ.w);
          body.velocity.set(0, 0, 0);
          body.angularVelocity.set(0, 0, 0);
          if (typeof body.wakeUp === 'function') body.wakeUp();
        }
        var wrap = this.carEls[i];
        if (wrap) wrap.setAttribute('position', { x: sx, y: spawnY, z: sz });
      }
      if (this._vkCarriageYawRad) {
        for (i = 0; i < VK_MAX_SLOTS; i++) {
          this._vkCarriageYawRad[i] = yawUp;
        }
      }
    },

    _resetRoundBodies: function () {
      if (this.isHost && this._vkLaneCols && this._vkLaneCols.length >= VK_MAX_SLOTS) {
        this._vkPickRandomSpawnLanesHost();
      }
      if (this._vkLaneCols && this._vkLaneCols.length >= VK_MAX_SLOTS) {
        this._vkRebuildCarSpawnFromRot(window.isMultiplayer ? 0 : this._vkMatchSpawnRot || 0);
      }
      var i;
      for (i = 0; i < VK_MAX_SLOTS; i++) {
        var body = this.carBodies[i];
        var s = this._carSpawn[i];
        if (body && s) {
          body.velocity.set(0, 0, 0);
          body.angularVelocity.set(0, 0, 0);
          body.position.set(s.x, s.y, s.z);
          body.quaternion.set(s.qx, s.qy, s.qz, s.qw);
          if (typeof body.wakeUp === 'function') body.wakeUp();
        }
        this._vkFinished[i] = false;
      }
      if (this._vkCarriageYawRad) {
        var yawUp = Math.atan2(this._vkUphill.x, this._vkUphill.z);
        for (i = 0; i < VK_MAX_SLOTS; i++) {
          this._vkCarriageYawRad[i] = yawUp;
        }
      }
      if (this._vkCubeLeanPitchSn && this._vkCubeLeanRollSn) {
        for (i = 0; i < VK_MAX_SLOTS; i++) {
          this._vkCubeLeanPitchSn[i] = 0;
          this._vkCubeLeanRollSn[i] = 0;
        }
      }
      this._vkInitDynamicLeanState();
      if (this._vkLedHitRemainMs) {
        for (i = 0; i < VK_MAX_SLOTS; i++) {
          this._vkLedHitRemainMs[i] = 0;
        }
      }
      this._vkParkAllRocks();
      if (this._vkRockIdleMs) {
        for (i = 0; i < this._vkRockIdleMs.length; i++) {
          this._vkRockIdleMs[i] = 0;
        }
      }
      this._vkUpdateLaneMarkerColorsAndPositions();
      this._applySpectatorTransform(this.mySlot);
    },

    _vkEmitLobbyUpdated: function () {
      var scene = this.el && this.el.sceneEl;
      if (scene) scene.emit('lobby-state-updated');
    },

    _vkClearWindowMultiplayer: function () {
      window.lobbyState = null;
      window.isMultiplayer = false;
      window.connectionState = 'disconnected';
      window.myPlayerId = null;
      this._vkEmitLobbyUpdated();
    },

    _vkRebuildLobbyState: function () {
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
        st.players.push({ id: c.peer || 'peer', nickname: c.vkNick || 'Player' });
      }
      st.matchState = this.vkMatchActive ? 'PLAYING' : 'WAITING';
      st.matchStartTime = this.vkMatchActive ? Date.now() : 0;
      st.matchScore.blue = 0;
      st.matchScore.red = 0;
      st.vkCourseTrack = vkNormalizeCourseTrack(this._vkCourseTrack);
      window.lobbyState = st;
    },

    _vkBroadcastLobbyToClients: function () {
      if (!this.isHost || !this.peer || !this.peer.open) return;
      this._vkRebuildLobbyState();
      var st = window.lobbyState;
      if (!st) return;
      var payload = { type: 'vl-lobby-state', state: JSON.parse(JSON.stringify(st)) };
      for (var j = 0; j < this.clientConns.length; j++) {
        var c = this.clientConns[j];
        if (c && c.open) c.send(payload);
      }
      this._vkEmitLobbyUpdated();
    },

    startOffline: function () {
      this._teardownNet();
      window.isMultiplayer = false;
      window.connectionState = 'disconnected';
      window.myPlayerId = null;
      this.isHost = true;
      /* Solo: random car index each session so you are not always the same grid slot / color. */
      this.mySlot = Math.floor(Math.random() * VK_MAX_SLOTS);
      this.clientConns = [];
      this.vkMatchActive = false;
      this.vkMatchStartMs = 0;
      this.vkMatchRemainSec = null;
      this._vkMatchCountdownT0 = 0;
      this._vkClientMatchPreStart = false;
      this._resetRoundBodies();
      this._applySpectatorTransform(this.mySlot);
      this._refreshCubeHighlights();
        this._setStatus(
        'VR Knockout — race uphill (−Z). Right trigger thrusts along the cube’s facing (pitch lean tilts thrust; roll lean adds a slight sideways push); left trigger reverse; left stick turns the cube (aim). Right stick leans the cage (±15°); at speed, lean into corners for full steering — upright = wider line. Motion adds sway that settles. B or squeeze either grip to jump (the VR view follows your car). X = menu, A = reset. Multiplayer: host fills empty slots with bots.'
      );
      this._vkMarkHudDirty();
      this._vkRebuildSlotNamesHost();
      this._vkRefreshMatchResultsPanel();
      this._vkUpdateLaneMarkerColorsAndPositions();
    },

    _refreshCubeHighlights: function () {
      var i;
      for (i = 0; i < this.carEls.length; i++) {
        var wrap = this.carEls[i];
        if (!wrap) continue;
        var c = VK_SPEC[i].color;
        var me = i === this.mySlot;
        var em = me ? 0.55 : 0.12;
        var ballEl = wrap.querySelector && wrap.querySelector('.vk-player-ball');
        var bodyEl = wrap.querySelector && wrap.querySelector('.vk-player-body');
        var bodyMat =
          'color: ' +
          c +
          '; metalness: 0.45; roughness: 0.25; emissive: ' +
          c +
          '; emissiveIntensity: ' +
          (me ? 0.22 : 0.12);
        if (ballEl) {
          var bMesh = ballEl.getObject3D('mesh');
          if (bMesh && bMesh.material && window.THREE) {
            bMesh.material.emissive = new window.THREE.Color(c);
            bMesh.material.emissiveIntensity = em;
            bMesh.material.needsUpdate = true;
          }
        }
        if (bodyEl) bodyEl.setAttribute('material', bodyMat);
        var L = this._vkCarLed && this._vkCarLed[i];
        if (L && L.ctx) {
          L.ledBodyColor = c;
          var cams = this._vkLedCamsBuf;
          this._vkGatherLedCams(cams);
          var bLed = this.carBodies[i];
          var ledMode = this._vkLedResolveMode(i, bLed, cams);
          vkDrawLedFace(L.ctx, L.canvasW, L.canvasH, ledMode, c);
          L.lastDrawnMode = ledMode;
          L.texture.needsUpdate = true;
        }
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
        } catch (e2) {}
      });
      this.clientConns = [];
      this._vkPendingAEdge = 0;
      if (this.peer) {
        try {
          this.peer.destroy();
        } catch (e3) {}
        this.peer = null;
      }
      this.isHost = false;
    },

    startHost: function (lobbyNum) {
      var self = this;
      window.connectionState = 'connecting';
      this._vkEmitLobbyUpdated();
      this._teardownNet();
      this._setStatus('Fetching TURN/STUN…');
      vkGetIceServers().then(function (ice) {
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
      this.peer = new Peer(hostId, vkPeerOptions(iceServers));
      this.peer.on('open', function () {
        window.isMultiplayer = true;
        window.connectionState = 'connected';
        window.myPlayerId = self.peer.id;
        self.vkMatchActive = false;
        self.vkMatchStartMs = 0;
        self._resetRoundBodies();
        self._vkUpdateLaneMarkerColorsAndPositions();
        self._vkRebuildLobbyState();
        self._vkEmitLobbyUpdated();
        self._setStatus('Hosting lobby ' + lobbyNum + ' — share this number.');
        self._refreshCubeHighlights();
        self._vkBroadcastMatchSync();
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
          conn.vkSlot = slot;
          conn.vkNick = 'Player';
          self.clientConns.push(conn);
          self._vkRebuildSlotNamesHost();
          self._vkRefreshMatchResultsPanel();
          conn.send({ type: 'welcome', slot: slot, youHost: false });
          /* Lobby before snap so clients apply `vkCourseTrack` (and player list) before physics sync. */
          self._vkBroadcastLobbyToClients();
          conn.send({ type: 'snap', data: self._serializeSnap() });
        });
        conn.on('close', function () {
          if (conn.vkSlot != null) self.inputs[conn.vkSlot] = zeroInput();
          self.clientConns = self.clientConns.filter(function (x) {
            return x !== conn;
          });
          self._vkRebuildSlotNamesHost();
          self._vkRefreshMatchResultsPanel();
          self._vkBroadcastLobbyToClients();
        });
      });
      this.peer.on('error', function (e) {
        self._setStatus('Host error: ' + (e && e.type ? e.type : String(e)));
        self._vkClearWindowMultiplayer();
        self.startOffline();
      });
    },

    _nextFreeSlot: function () {
      var taken = { 0: true };
      for (var i = 0; i < this.clientConns.length; i++) {
        var c = this.clientConns[i];
        if (c.open && c.vkSlot != null) taken[c.vkSlot] = true;
      }
      for (var s = 1; s < VK_MAX_SLOTS; s++) {
        if (!taken[s]) return s;
      }
      return -1;
    },

    _onHostData: function (conn, raw) {
      var msg = typeof raw === 'string' ? (function () {
        try {
          return JSON.parse(raw);
        } catch (e) {
          return null;
        }
      })() : raw;
      if (!msg || !msg.type) return;
      if (msg.type === 'vl-nick') {
        var nk = typeof msg.nick === 'string' ? msg.nick.trim().slice(0, 20) : '';
        conn.vkNick = nk || 'Player';
        if (this.isHost) {
          this._vkRebuildSlotNamesHost();
          this._vkRefreshMatchResultsPanel();
        }
        this._vkBroadcastLobbyToClients();
        return;
      }
      if (msg.type === 'vl-match-cmd') {
        if (msg.action === 'start') this.vkStartMatch();
        else if (msg.action === 'end') this.vkEndMatch('Host ended match.');
        return;
      }
      if (msg.type === 'inp' && conn.vkSlot != null) {
        var sl = conn.vkSlot;
        this.inputs[sl] = {
          lx: typeof msg.lx === 'number' && isFinite(msg.lx) ? msg.lx : 0,
          ly: typeof msg.ly === 'number' && isFinite(msg.ly) ? msg.ly : 0,
          rx: typeof msg.rx === 'number' && isFinite(msg.rx) ? msg.rx : 0,
          ry: typeof msg.ry === 'number' && isFinite(msg.ry) ? msg.ry : 0,
          trig: typeof msg.trig === 'number' && isFinite(msg.trig) ? msg.trig : 0,
          trigRev: typeof msg.trigRev === 'number' && isFinite(msg.trigRev) ? msg.trigRev : 0,
          autoRoll: msg.autoRoll === 0 || msg.autoRoll === false ? 0 : 1,
          grip: 0,
          gripL: 0,
          gripR: 0,
          aEdge: msg.aEdge ? 1 : 0,
          j: msg.j ? 1 : 0,
          camOk: msg.camOk ? 1 : 0,
          camx: typeof msg.camx === 'number' ? msg.camx : 0,
          camy: typeof msg.camy === 'number' ? msg.camy : 0,
          camz: typeof msg.camz === 'number' ? msg.camz : 0,
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
        if (this.inputs[sl].aEdge) {
          this._vkInstantResetSlot(sl, true);
          this.inputs[sl].aEdge = 0;
        }
        if (this.inputs[sl].j) {
          this._vkTryJump(sl);
          this.inputs[sl].j = 0;
        }
      }
    },

    /** Update only one car’s spawn pose from `_vkSlotSpawnLaneIdx` (no other slots / bodies). */
    _vkApplySingleSlotSpawnFromCurrentLane: function (slot) {
      if (typeof slot !== 'number' || slot < 0 || slot >= VK_MAX_SLOTS) return;
      if (!this._carSpawn || !this._carSpawn[slot] || !this.carBodies[slot]) return;
      var r = (window.isMultiplayer ? 0 : this._vkMatchSpawnRot || 0) % 4;
      var phx = this._vkPathHalfX || 2.35;
      var z0 = this._vkSpawnBaseZ;
      var spawnY = this._vkSpawnPhysY;
      if (spawnY == null || !isFinite(spawnY)) return;
      if (!this._vkSlotSpawnLaneIdx || this._vkSlotSpawnLaneIdx.length < VK_MAX_SLOTS) {
        this._vkSlotSpawnLaneIdx = [0, 1, 2, 3, 8, 9, 10, 11];
      }
      var laneIdx = this._vkSlotSpawnLaneIdx[slot] | 0;
      if (laneIdx < 0 || laneIdx >= VK_SPAWN_LANE_COUNT) {
        laneIdx = (slot * 4 + r * 2) % VK_SPAWN_LANE_COUNT;
        this._vkSlotSpawnLaneIdx[slot] = laneIdx;
      }
      var xz = vkWorldXZForLane(phx, z0, r, laneIdx);
      var idQ = { x: 0, y: 0, z: 0, w: 1 };
      var s = this._carSpawn[slot];
      s.x = xz.x;
      s.y = spawnY;
      s.z = xz.z;
      s.qx = idQ.x;
      s.qy = idQ.y;
      s.qz = idQ.z;
      s.qw = idQ.w;
      var body = this.carBodies[slot];
      body.position.set(xz.x, spawnY, xz.z);
      body.quaternion.set(idQ.x, idQ.y, idQ.z, idQ.w);
      var wrap = this.carEls[slot];
      if (wrap) wrap.setAttribute('position', { x: xz.x, y: spawnY, z: xz.z });
      if (this._vkCarriageYawRad) {
        this._vkCarriageYawRad[slot] = Math.atan2(this._vkUphill.x, this._vkUphill.z);
      }
    },

    /**
     * Host: assign a new grid lane for this slot, not used by the other three cars.
     * For bots, `opt.preferRecording` prefers lanes that have a library ghost (green pads) so replay + spawn match.
     */
    _vkPickNewRandomLaneForSlot: function (slot, opt) {
      if (!this.isHost) return;
      opt = opt || {};
      var preferRec = !!opt.preferRecording;
      if (typeof slot !== 'number' || slot < 0 || slot >= VK_MAX_SLOTS) return;
      if (!this._vkSlotSpawnLaneIdx || this._vkSlotSpawnLaneIdx.length < VK_MAX_SLOTS) {
        this._vkSlotSpawnLaneIdx = [0, 1, 2, 3, 8, 9, 10, 11];
      }
      var cur = this._vkSlotSpawnLaneIdx[slot] | 0;
      var used = {};
      var j;
      for (j = 0; j < VK_MAX_SLOTS; j++) {
        if (j !== slot) used[this._vkSlotSpawnLaneIdx[j] | 0] = true;
      }
      var pool = [];
      var L;
      if (preferRec) {
        var rrot = (this._vkMatchSpawnRot | 0) % 4;
        var recMask = this._vkLanesWithRecordingMask(rrot);
        for (L = 0; L < VK_SPAWN_LANE_COUNT; L++) {
          if (!recMask[L]) continue;
          if (used[L]) continue;
          if (L !== cur) pool.push(L);
        }
        vkShuffleInPlace(pool);
      }
      if (!pool.length) {
        for (L = 0; L < VK_SPAWN_LANE_COUNT; L++) {
          if (!used[L] && L !== cur) pool.push(L);
        }
        if (!pool.length) {
          for (L = 0; L < VK_SPAWN_LANE_COUNT; L++) {
            if (!used[L]) pool.push(L);
          }
        }
        if (!pool.length) pool.push(cur);
        vkShuffleInPlace(pool);
      }
      this._vkSlotSpawnLaneIdx[slot] = pool[Math.floor(Math.random() * pool.length)] % VK_SPAWN_LANE_COUNT;
    },

    /**
     * Snap one car to its spawn. `newLane` true (A): host picks a new 16-lane index for that slot only, then teleports
     * only that car. `newLane` false: snap to current spawn (stuck recovery) — does not move other contestants.
     */
    _vkInstantResetSlot: function (slot, newLane) {
      if (this.isHost) {
        if (newLane) {
          var isHuman = this._vkIsHumanOccupyingSlot(slot);
          this._vkPickNewRandomLaneForSlot(slot, { preferRecording: !isHuman });
          this._vkApplySingleSlotSpawnFromCurrentLane(slot);
        }
        /* if (!newLane) _carSpawn[slot] is unchanged; we only re-zero motion below */
      }
      var s = this._carSpawn[slot];
      var body = this.carBodies[slot];
      if (!s || !body) return;
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
      body.position.set(s.x, s.y, s.z);
      body.quaternion.set(s.qx, s.qy, s.qz, s.qw);
      if (this._vkCarriageYawRad && typeof slot === 'number' && slot >= 0 && slot < VK_MAX_SLOTS) {
        this._vkCarriageYawRad[slot] = Math.atan2(this._vkUphill.x, this._vkUphill.z);
      }
      if (
        this._vkCubeLeanPitchSn &&
        this._vkCubeLeanRollSn &&
        typeof slot === 'number' &&
        slot >= 0 &&
        slot < VK_MAX_SLOTS
      ) {
        this._vkCubeLeanPitchSn[slot] = 0;
        this._vkCubeLeanRollSn[slot] = 0;
      }
      this._vkResetMotionLeanSlot(slot);
      if (typeof body.wakeUp === 'function') body.wakeUp();
      if (!this._vkIsHumanOccupyingSlot(slot)) {
        this._vkRepickGhostForSlot(slot, true);
      }
      if (this.vkMatchActive && this.vkMatchStartMs && typeof slot === 'number' && slot >= 0 && slot < VK_MAX_SLOTS) {
        var uh0 = this._vkUphill;
        var uhx0 = uh0.x;
        var uhz0 = uh0.z;
        var h0 = Math.sqrt(uhx0 * uhx0 + uhz0 * uhz0) || 1;
        uhx0 /= h0;
        uhz0 /= h0;
        var cur0 = (body.position.x - s.x) * uhx0 + (body.position.z - s.z) * uhz0;
        this._vkBotBestHill[slot] = cur0;
        this._vkBotHillProgAt[slot] = performance.now();
      }
    },

    joinClient: function (lobbyNum) {
      var self = this;
      window.connectionState = 'connecting';
      this._vkEmitLobbyUpdated();
      this._teardownNet();
      this.isHost = false;
      vkGetIceServers().then(function (ice) {
        self._openJoinPeer(lobbyNum, ice);
      });
    },

    _openJoinPeer: function (lobbyNum, iceServers) {
      var self = this;
      var hostId = HOST_ID_PREFIX + lobbyNum;
      var pid = 'vk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      this._setStatus('Connecting…');
      this.peer = new Peer(pid, vkPeerOptions(iceServers));
      this.peer.on('open', function () {
        self.hostConn = self.peer.connect(hostId, { serialization: 'json' });
        self.hostConn.on('open', function () {
          window.isMultiplayer = true;
          window.connectionState = 'connected';
          window.myPlayerId = self.peer.id;
          self._vkEmitLobbyUpdated();
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
          self._vkClearWindowMultiplayer();
          self.startOffline();
        });
        self.hostConn.on('error', function () {
          self._setStatus('Connection error.');
          self._vkClearWindowMultiplayer();
          self.startOffline();
        });
      });
      this.peer.on('error', function (e) {
        self._setStatus('Peer error: ' + (e && e.type ? e.type : String(e)));
        self._vkClearWindowMultiplayer();
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
        var st = data.state;
        var trRaw = st.vkCourseTrack;
        var tr =
          trRaw === 2 || trRaw === 3 || trRaw === 1
            ? vkNormalizeCourseTrack(trRaw)
            : this._vkCourseTrack | 0;
        window.lobbyState = st;
        if (!this.isHost && (tr | 0) !== (this._vkCourseTrack | 0)) {
          this._vkApplyCourseTrack(tr);
        }
        this._vkEmitLobbyUpdated();
        return;
      }
      if (data.type === 'welcome') {
        this.mySlot = data.slot;
        this._applySpectatorTransform(this.mySlot);
        this._refreshCubeHighlights();
        this._setStatus(
          'Player ' +
            (this.mySlot + 1) +
            ' — brightest ball is yours. Right trigger forward along cube aim, left back, left stick turns cube. B or either grip jumps; the view follows your car.'
        );
        return;
      }
      if (data.type === 'vl-match-sync') {
        var wasActive = this.vkMatchActive;
        this.vkMatchActive = !!data.active;
        if (this.vkMatchActive && !wasActive) {
          this._vkSetMatchMusicPlaying(true);
        } else if (!this.vkMatchActive && wasActive) {
          this._vkSetMatchMusicPlaying(false);
          this._vkGoFlashUntil = 0;
          this._vkClientCountBeepRem = -999;
          this._vkStopFinishFxCelebration();
        }
        if (typeof data.remSec === 'number' && isFinite(data.remSec)) {
          this.vkMatchRemainSec = data.remSec;
        } else {
          this.vkMatchRemainSec = null;
        }
        if (!data.active) {
          this.vkMatchRemainSec = null;
          this._vkClientMatchPreStart = false;
        }
        if (typeof data.vlPreStart === 'boolean') {
          this._vkClientMatchPreStart = data.vlPreStart;
        }
        if (data.vkSpawnLanes && data.vkSpawnLanes.length === VK_MAX_SLOTS) {
          var li;
          if (!this._vkSlotSpawnLaneIdx || this._vkSlotSpawnLaneIdx.length < VK_MAX_SLOTS) {
            this._vkSlotSpawnLaneIdx = [0, 1, 2, 3, 8, 9, 10, 11];
          }
          for (li = 0; li < VK_MAX_SLOTS; li++) {
            this._vkSlotSpawnLaneIdx[li] = data.vkSpawnLanes[li] | 0;
          }
          this._vkRebuildCarSpawnFromRot(window.isMultiplayer ? 0 : this._vkMatchSpawnRot || 0);
        }
        if (data.endBanner) {
          this._setStatus(String(data.endBanner));
        }
        this._vkUpdateLaneMarkerColorsAndPositions();
        this._vkMarkHudDirty();
        this._vkEmitLobbyUpdated();
        return;
      }
      if (data.type === 'snap') {
        this._applyNetworkSnap(data.data);
        return;
      }
      if (data.type === 'full') {
        this._setStatus('Lobby full (' + VK_MAX_SLOTS + ' players).');
        return;
      }
    },

    connectLobbySmart: function (lobbyNum) {
      var self = this;
      var hostId = HOST_ID_PREFIX + lobbyNum;
      this._setStatus('Checking lobby ' + lobbyNum + '…');
      vkCheckHostPeerIdAvailable(hostId).then(function (idFree) {
        if (idFree) self.startHost(lobbyNum);
        else self.joinClient(lobbyNum);
      });
    },

    tick: function (t, dt) {
      var dtSec = dt / 1000;
      if (dtSec <= 0 || dtSec > 0.08) dtSec = 1 / 60;

      var iLed;
      if (this.isHost && this._vkLedHitRemainMs) {
        for (iLed = 0; iLed < VK_MAX_SLOTS; iLed++) {
          if (this._vkLedHitRemainMs[iLed] > 0) {
            this._vkLedHitRemainMs[iLed] = Math.max(0, this._vkLedHitRemainMs[iLed] - dtSec * 1000);
          }
        }
      }

      this._vkTryBindHandsOnce();
      var inp = this._gatherLocalInput();
      this._vkSmoothCameraFollow(dtSec, inp);
      this._vkApplyRigLocomotion(inp);
      if (inp.aEdge) {
        this._pulseHand(vkHandEl('rightHand', 'vl-hand-right'), 0.45, 58);
      }

      if (this.isHost) {
        if (this._vkPendingBJumpEdge) {
          inp.j = 1;
          this._vkPendingBJumpEdge = false;
        }
        this.inputs[this.mySlot] = inp;
      } else if (this.hostConn && this.hostConn.open) {
        if (inp.aEdge) this._vkPendingAEdge = 1;
        if (inp.j) this._vkPendingJ = 1;
        var now = performance.now();
        if (now - this.lastInputSend > 1000 / INPUT_HZ) {
          this.lastInputSend = now;
          var aEdgeSend = this._vkPendingAEdge ? 1 : 0;
          if (this._vkPendingAEdge) this._vkPendingAEdge = 0;
          var jSend = this._vkPendingJ ? 1 : 0;
          if (this._vkPendingJ) this._vkPendingJ = 0;
          this.hostConn.send({
            type: 'inp',
            lx: inp.lx,
            ly: inp.ly,
            rx: inp.rx,
            ry: inp.ry,
            trig: inp.trig,
            trigRev: inp.trigRev,
            autoRoll: inp.autoRoll,
            aEdge: aEdgeSend,
            j: jSend,
            camOk: inp.camOk,
            camx: inp.camx,
            camy: inp.camy,
            camz: inp.camz
          });
        }
      }

      var nowHost = performance.now();
      if (this.isHost) {
        this._vkTickMatchCountdownHost(nowHost);
        this._vkApplyBotInputs(nowHost);
        if (this._vkSpineHudDebug) this._vkTickSpineGuideLine(nowHost);
        else if (this._vkSpineGuide) this._vkDisposeSpineGuideLine();
      }
      this._vkUpdateCubeLeanFromInputs(inp);
      if (this.isHost) {
        var ia;
        for (ia = 0; ia < VK_MAX_SLOTS; ia++) {
          if (this.inputs[ia] && this.inputs[ia].aEdge) {
            this._vkInstantResetSlot(ia, true);
            this.inputs[ia].aEdge = 0;
          }
          if (this.inputs[ia] && this.inputs[ia].j) {
            this._vkTryJump(ia);
            this.inputs[ia].j = 0;
          }
        }
        for (var i = 0; i < VK_MAX_SLOTS; i++) {
          this.carBodies[i].force.set(0, 0, 0);
          this.carBodies[i].torque.set(0, 0, 0);
        }
        if (
          (this._vkCourseTrack | 0) === 1 &&
          this.vkMatchActive &&
          (this.vkMatchStartMs || this._vkMatchCountdownT0) &&
          nowHost - this._vkRockSpawnNext >= ROCK_SPAWN_INTERVAL_MS
        ) {
          this._vkRockSpawnNext = nowHost;
          var nR = this.rockBodies.length;
          var waveG;
          for (waveG = 0; waveG < 3; waveG++) {
            var kr;
            for (kr = 0; kr < nR; kr++) {
              if (!this._vkRockActive[kr]) {
                this._vkRecycleRock(kr, waveG);
                break;
              }
            }
          }
        }
        for (var s = 0; s < VK_MAX_SLOTS; s++) {
          this._applyCarControls(s, this.inputs[s], dtSec);
        }
        this._vkTickTrack2Spinners(nowHost);
        this._vkTickTrack3Sliders(nowHost);
        this.world.step(1 / 60, dtSec, 22);
        this._vkTickTrack2Spinners(nowHost, { reSnapPose: true });
        this._vkTickTrack3Sliders(nowHost, { reSnapPose: true });
        this._vkApplyTrack2DiscCarry(dtSec);
        this._vkApplyTrack3SliderCarry(dtSec, nowHost);
        this._vkTickRockHazardRecycleHost();
        this._vkEnsurePlayersOnTrack();
        this._vkTickBotStuckHost(nowHost);
        this._vkRefreshGroundedFromContactsPostStep();
        this._vkTickGroundedDecay();
        this._vkCheckFinish();
        this._vkGhostRecordTickAfterPhysics(nowHost);
        this._syncMeshesFromPhysics();
        this._vkUpdateCarLedFaces();
        this.frame++;
        if (this.clientConns.length && this.frame % SYNC_EVERY === 0) {
          var snap = this._serializeSnap();
          for (var j = 0; j < this.clientConns.length; j++) {
            if (this.clientConns[j].open) this.clientConns[j].send({ type: 'snap', data: snap });
          }
        }
        if (this.vkMatchActive && this.vkMatchStartMs) {
          if (performance.now() - this.vkMatchStartMs >= VK_MATCH_DURATION_MS) {
            this.vkEndMatch("Time's up — check who reached the finish!");
          }
        }
      } else {
        this._vkUpdateDynamicLeanClient(dtSec);
        this._vkTickTrack2Spinners(performance.now());
        this._vkTickTrack3Sliders(performance.now());
        this._syncMeshesFromPhysics();
        this._vkUpdateCarLedFaces();
      }
      this._vkTickFinishFxSparks(dtSec);
      this._vkPumpHud(t);
      this._vkUpdateHints();
    },

    _vkUpdateHints: function () {
      var scn = this.el.sceneEl || this.el;
      var xrOn = !!(scn && scn.renderer && scn.renderer.xr && scn.renderer.xr.isPresenting);
      var vm = scn && scn.components && scn.components['vr-menu'];
      var menuOn = !!(vm && vm.menuVisible);
      var v = xrOn && !menuOn;
      var el = document.getElementById('vk-reset-hint');
      if (el) el.setAttribute('visible', v);
      var xh = document.getElementById('vk-x-menu-hint');
      if (xh) xh.setAttribute('visible', v);
      var jh = document.getElementById('vk-jump-hint');
      if (jh) jh.setAttribute('visible', v);
    },

    remove: function () {
      var sceneEl = this.el && (this.el.sceneEl || this.el);
      if (this._vkHandBindIv) {
        clearInterval(this._vkHandBindIv);
        this._vkHandBindIv = null;
      }
      if (sceneEl && this._vkOnEnterVrRef) {
        sceneEl.removeEventListener('enter-vr', this._vkOnEnterVrRef);
        this._vkOnEnterVrRef = null;
      }
      if (this._vkSessionStartHandler && sceneEl && sceneEl.renderer && sceneEl.renderer.xr) {
        sceneEl.renderer.xr.removeEventListener('sessionstart', this._vkSessionStartHandler);
        this._vkSessionStartHandler = null;
      }
      var rhA = this._vkRightHandAHook;
      if (rhA && this._vkOnAbuttondown) {
        rhA.removeEventListener('abuttondown', this._vkOnAbuttondown);
      }
      this._vkRightAHandlersBound = false;
      var rhB = this._vkRightHandBHook;
      if (rhB && this._vkOnBbuttondown) {
        rhB.removeEventListener('bbuttondown', this._vkOnBbuttondown);
      }
      this._vkRightBHandlersBound = false;
      this._teardownNet();
    }
  });

  function vkGetKnockoutGame() {
    var el = document.querySelector('[vrknockout-game]');
    return el && el.components && el.components['vrknockout-game'];
  }

  window.connectToLobby = function (lobbyNum) {
    if (window.isMultiplayer) return;
    if (window.connectionState === 'connecting') return;
    lobbyNum = Math.max(1, Math.min(10, parseInt(lobbyNum, 10) || 1));
    window.connectionState = 'connecting';
    var scene = document.querySelector('a-scene');
    if (scene) scene.emit('lobby-state-updated');
    var hostId = HOST_ID_PREFIX + lobbyNum;
    vkCheckHostPeerIdAvailable(hostId).then(function (idFree) {
      var g = vkGetKnockoutGame();
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
    var g = vkGetKnockoutGame();
    if (g) g.startOffline();
    window.lobbyState = null;
    window.isMultiplayer = false;
    window.connectionState = 'disconnected';
    window.myPlayerId = null;
    var scene = document.querySelector('a-scene');
    if (scene) scene.emit('lobby-state-updated');
  };

  window.sendQueueAction = function () {};

  window.vkLoadGhostRuns = vkLoadGhostRuns;
  window.vkGhostStats = function () {
    var tr = vkGetGhostRunsCourseTrack();
    var total = 0;
    try {
      total = parseInt(localStorage.getItem(vkGhostTotalCommitsKey(tr)), 10) || 0;
    } catch (e) {}
    return {
      /** Runs in the TOP 10 library for the active course (max 10). */
      libraryCount: vkLoadGhostRuns(tr).length,
      /** Finishes merged into that course’s ghost library (this browser). */
      totalCommits: total,
      courseTrack: tr
    };
  };

  window.sendMatchAction = function (action) {
    var g = vkGetKnockoutGame();
    if (!g) return;
    var hid = g.peer && g.peer.id ? String(g.peer.id) : '';
    var isLobbyHost = g.isHost && hid.indexOf('vrknockout-host-') === 0;
    if (isLobbyHost) {
      if (action === 'start') g.vkStartMatch();
      else if (action === 'end') g.vkEndMatch('Host ended match.');
      return;
    }
    if (g.hostConn && g.hostConn.open) {
      g.hostConn.send({ type: 'vl-match-cmd', action: action });
    }
  };

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
