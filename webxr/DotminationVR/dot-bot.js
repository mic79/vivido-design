// dot-bot.js — Dotmination AI (move choice only; timing/avatar handled by dot-game).
// Greedy 1-ply or 1.5-ply (opponent best reply) search on DotBoardState clones.
(function (global) {
  'use strict';

  var DB = global.DotBoard;

  function evaluate(st, me, opp) {
    var myN = 0, oppN = 0, myS = 0, oppS = 0, danger = 0, threat = 0;
    var owner = st.owner;
    var stage = st.stage;
    var nbs = st.layout.neighbors;
    for (var i = 0; i < owner.length; i++) {
      var o = owner[i];
      if (o === me) { myN++; myS += stage[i]; }
      else if (o === opp) { oppN++; oppS += stage[i]; }
      if (o === opp && stage[i] >= DB.MAX_STAGE) {
        // Opp charged dot next to mine = I can lose those dots next turn
        var list = nbs[i];
        for (var k = 0; k < list.length; k++) if (owner[list[k]] === me) danger++;
      } else if (o === me && stage[i] >= DB.MAX_STAGE) {
        var list2 = nbs[i];
        for (var k2 = 0; k2 < list2.length; k2++) if (owner[list2[k2]] === opp) threat++;
      }
    }
    if (oppN === 0 && myN > 0) return 10000;
    if (myN === 0 && oppN > 0) return -10000;
    return (myN - oppN) * 3 + (myS - oppS) * 0.45 - danger * 0.9 + threat * 0.5;
  }

  /**
   * opts: { depth: 1|2, noise: number, randomChance: 0..1, rand: fn }
   * Returns cell index or -1.
   */
  function chooseMove(state, me, opp, opts) {
    opts = opts || {};
    me = DB.ownerCode(me);
    opp = DB.ownerCode(opp);
    var rand = opts.rand || Math.random;
    var moves = state.legalMoves(me);
    if (!moves.length) return -1;
    if (opts.randomChance && rand() < opts.randomChance) {
      return moves[Math.floor(rand() * moves.length)];
    }
    var depth = opts.depth || 1;
    var noise = opts.noise != null ? opts.noise : 0.5;
    var best = -1;
    var bestScore = -Infinity;
    for (var m = 0; m < moves.length; m++) {
      var c = state.clone();
      c.apply(me, moves[m], { noSteps: true });
      var score = evaluate(c, me, opp);
      if (depth >= 2 && score < 5000) {
        var replies = c.legalMoves(opp);
        var worst = Infinity;
        for (var r = 0; r < replies.length; r++) {
          var c2 = c.clone();
          c2.apply(opp, replies[r], { noSteps: true });
          var s2 = evaluate(c2, me, opp);
          if (s2 < worst) worst = s2;
          if (worst <= -5000) break;
        }
        if (worst !== Infinity) score = score * 0.25 + worst * 0.75;
      }
      score += (rand() - 0.5) * noise;
      if (score > bestScore) { bestScore = score; best = moves[m]; }
    }
    return best;
  }

  /** Presets used by dot-game. */
  var PROFILES = {
    duel: { depth: 2, noise: 0.6, randomChance: 0 },
    // Board virus in RUSH: beatable, a little erratic
    virus: { depth: 1, noise: 2.4, randomChance: 0.12 },
    // Bot seat playing its own RUSH board
    rushSeat: { depth: 1, noise: 0.8, randomChance: 0.03 }
  };

  global.DotBot = {
    evaluate: evaluate,
    chooseMove: chooseMove,
    PROFILES: PROFILES
  };
})(typeof window !== 'undefined' ? window : globalThis);
