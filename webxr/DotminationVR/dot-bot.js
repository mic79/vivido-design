// dot-bot.js — original Dotmination bots (modules/botLogic.js + realTimeResourceMode.js)
// ported from jQuery/DOM to DotRules.State. Same heuristics, constants and fallbacks:
//   'random' = Normal bot, 'smart' = Harder bot, realtime = Real-Time mode bot.
(function (global) {
  'use strict';

  var R = global.DotRules;
  var C = {
    SCORE_THRESHOLD: 5,
    RECENT_MOVES_LIMIT: 3,
    CHAIN_WEIGHT: 2,
    DISRUPT_WEIGHT: 1.5,
    EARLY_GAME_TURNS: 10,
    MIN_VIABLE_TARGETS: 3,
    HIGH_STAGE_THRESHOLD: 3
  };

  function pick(arr, rand) { return arr[Math.floor(rand() * arr.length)]; }

  /** Bot's own stage-5 dots that touch an opponent stage-5 dot (botActionRandom / tryStage5Hits). */
  function s5Hits(st, me, opp) {
    var out = [];
    var nbs = st.layout.neighbors;
    for (var i = 0; i < st.owner.length; i++) {
      if (st.owner[i] !== me || st.stage[i] !== 5) continue;
      for (var k = 0; k < nbs[i].length; k++) {
        var j = nbs[i][k];
        if (st.owner[j] === opp && st.stage[j] === 5) { out.push(i); break; }
      }
    }
    return out;
  }

  // ── Normal ('random') ────────────────────────────────────────────────
  function moveRandom(st, me, opp, rand) {
    var targets = st.legalMoves(me);
    if (!targets.length) return -1;
    var hits = s5Hits(st, me, opp);
    if (hits.length) return pick(hits, rand);
    return pick(targets, rand);
  }

  // ── Harder ('smart') ─────────────────────────────────────────────────
  function evaluateTarget(st, t, me, opp) {
    var d = { isSafe: true, myStage: st.owner[t] === me ? st.stage[t] : 0, chain: 0, disrupt: 0, neighbors: 0 };
    var nb = st.layout.neighbors[t];
    for (var k = 0; k < nb.length; k++) {
      var j = nb[k];
      d.neighbors++;
      var stage = st.stage[j];
      if (st.owner[j] === opp) {
        if (stage > d.myStage && stage >= C.HIGH_STAGE_THRESHOLD + 1 && d.myStage < 2) d.isSafe = false;
        if (stage >= C.HIGH_STAGE_THRESHOLD) d.disrupt += stage * C.DISRUPT_WEIGHT;
      } else if (st.owner[j] === me) {
        if (stage >= C.HIGH_STAGE_THRESHOLD) d.chain += (5 - stage) * C.CHAIN_WEIGHT;
      }
    }
    return d;
  }

  function scoreOf(d, turnCount) {
    return (d.chain * C.CHAIN_WEIGHT) + d.disrupt +
      (d.myStage === 0 && d.neighbors < 3 ? 5 : 0) +
      (turnCount < C.EARLY_GAME_TURNS && d.disrupt >= C.HIGH_STAGE_THRESHOLD * 2 ? 5 : 0);
  }

  function moveSmart(st, me, opp, rand, recent) {
    recent = recent || [];
    var targets = st.legalMoves(me);
    if (!targets.length) return -1;
    var hits = s5Hits(st, me, opp);
    if (hits.length) return hits[0];
    var turnCount = st.count(me);
    var viable = [];
    for (var i = 0; i < targets.length; i++) {
      var d = evaluateTarget(st, targets[i], me, opp);
      if (!d.isSafe) continue;
      var sc = scoreOf(d, turnCount);
      if (sc > C.SCORE_THRESHOLD || viable.length < C.MIN_VIABLE_TARGETS) viable.push({ i: targets[i], score: sc });
    }
    if (viable.length) {
      viable.sort(function (a, b) { return b.score - a.score; });
      return viable[0].i;
    }
    // Fallback: disruption / chain potential, skipping recent moves
    var fb = [];
    for (var f = 0; f < targets.length; f++) {
      var t = targets[f];
      if (recent.indexOf(t) >= 0) continue;
      var dis = 0, ch = 0, nb = st.layout.neighbors[t];
      for (var k = 0; k < nb.length; k++) {
        var j = nb[k];
        if (st.owner[j] === opp) dis = Math.max(dis, st.stage[j]);
        else if (st.owner[j] === me) ch += (5 - st.stage[j]);
      }
      if (dis >= C.HIGH_STAGE_THRESHOLD || ch > 0) fb.push({ i: t, score: ch * C.CHAIN_WEIGHT + dis * C.DISRUPT_WEIGHT });
    }
    if (fb.length) {
      fb.sort(function (a, b) { return b.score - a.score; });
      return fb[0].i;
    }
    var pool = targets.filter(function (x) { return recent.indexOf(x) < 0; });
    return pick(pool.length ? pool : targets, rand);
  }

  // ── Real-Time mode bot (own dots only; simplified from runSmartBotLogic) ──
  function moveRealtime(st, me, opp, rand) {
    var own = st.legalMoves(me, true);
    if (!own.length) return -1;
    var hits = s5Hits(st, me, opp);
    if (hits.length) return pick(hits, rand);
    // Push the strongest dot on the front line, else grow the strongest dot
    var best = -1, bestScore = -1;
    for (var i = 0; i < own.length; i++) {
      var t = own[i], front = 0, nb = st.layout.neighbors[t];
      for (var k = 0; k < nb.length; k++) if (st.owner[nb[k]] === opp) front++;
      var sc = st.stage[t] * 2 + front * 3 + rand();
      if (sc > bestScore) { bestScore = sc; best = t; }
    }
    return best;
  }

  /** difficulty: 'random' | 'smart' | 'realtime'. recent: array kept by caller (smart). */
  function chooseMove(st, me, opp, difficulty, opts) {
    opts = opts || {};
    me = R.code(me);
    opp = R.code(opp);
    var rand = opts.rand || Math.random;
    var mv;
    if (difficulty === 'realtime') mv = moveRealtime(st, me, opp, rand);
    else if (difficulty === 'smart') mv = moveSmart(st, me, opp, rand, opts.recent);
    else mv = moveRandom(st, me, opp, rand);
    if (opts.recent && mv >= 0) {
      opts.recent.push(mv);
      while (opts.recent.length > C.RECENT_MOVES_LIMIT) opts.recent.shift();
    }
    return mv;
  }

  global.DotBot = { chooseMove: chooseMove, CONSTANTS: C };
})(typeof window !== 'undefined' ? window : globalThis);
