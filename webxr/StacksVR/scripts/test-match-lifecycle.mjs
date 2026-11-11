#!/usr/bin/env node
/**
 * VERIFY match lifecycle:
 * - vs-bot start enters COUNTDOWN (modes not live yet)
 * - pad/queue/anims wiped before live play (no overlapping scrap)
 * - End Match while hosting WAITING resumes dual idle (not blocked by isMultiplayer)
 * - End Match while lobby PLAYING tears down and schedules dual idle after WAITING
 * - Menu treats COUNTDOWN as real match (END MATCH label)
 */
import assert from 'assert';

function canResumeDualIdle(globalLike) {
  if (globalLike.isMobileSpectator) return false;
  if (globalLike.lobbyState && globalLike.lobbyState.matchState === 'PLAYING') return false;
  return true;
}

function isRealMatchPlaying(comp, lobbyState) {
  if (comp && comp._dualBotPreview) return false;
  if (lobbyState && lobbyState.matchState === 'PLAYING') return true;
  if (!comp || !comp.matchActive) return false;
  if (comp.matchState === 'COUNTDOWN' || comp.matchState === 'PLAYING') return true;
  if (!comp.modes || !comp.modes.active) return false;
  return true;
}

function simulateOnMatchStarted(state) {
  state._dualBotPreview = false;
  state.matchActive = true;
  state.matchState = 'COUNTDOWN';
  state.modesActive = false;
  state.padPieces = [];
  state.queuePieces = [];
  state.anims = [];
  state.stationsReset = true;
  state.countdown = 3;
  return state;
}

function simulateBeginLivePlay(state) {
  assert.strictEqual(state.matchState, 'COUNTDOWN');
  assert.strictEqual(state.stationsReset, true);
  state.padPieces = []; // wipe again before spawn
  state.padPieces.push({ type: 'fresh' });
  state.matchState = 'PLAYING';
  state.modesActive = true;
  state.countdown = null;
  return state;
}

function simulateEndThenDualIdle(state, globalLike) {
  state.matchActive = false;
  state.matchState = 'WAITING';
  state._dualBotPreview = false;
  state.modesActive = false;
  state.padPieces = [];
  state.anims = [];
  if (globalLike.lobbyState) globalLike.lobbyState.matchState = 'WAITING';
  var scheduled = canResumeDualIdle(globalLike);
  if (scheduled) {
    state._dualBotPreview = true;
    state.matchActive = true;
    state.matchState = 'PLAYING';
    state.modesActive = true;
  }
  return { scheduled: scheduled, state: state };
}

function main() {
  // 1) Start → countdown before play
  var s = simulateOnMatchStarted({
    matchActive: false, matchState: 'WAITING', modesActive: false,
    _dualBotPreview: true, padPieces: [{ scrap: 1 }], queuePieces: [{ scrap: 1 }], anims: [{}]
  });
  assert.strictEqual(s.matchState, 'COUNTDOWN');
  assert.strictEqual(s.modesActive, false);
  assert.strictEqual(s.stationsReset, true);
  assert.ok(isRealMatchPlaying(s, null), 'COUNTDOWN must count as real match for END button');

  // 2) GO → live pad, no scrap overlap
  simulateBeginLivePlay(s);
  assert.strictEqual(s.matchState, 'PLAYING');
  assert.strictEqual(s.padPieces.length, 1);
  assert.strictEqual(s.padPieces[0].type, 'fresh');
  assert.ok(isRealMatchPlaying(s, null));

  // 3) Offline end → dual idle resumes
  var gOff = { isMobileSpectator: false, lobbyState: null, isMultiplayer: false };
  var rOff = simulateEndThenDualIdle({
    matchActive: true, matchState: 'PLAYING', modesActive: true, _dualBotPreview: false
  }, gOff);
  assert.strictEqual(rOff.scheduled, true);
  assert.strictEqual(rOff.state._dualBotPreview, true);

  // 4) Host WAITING after end → dual idle MUST resume (was broken: isMultiplayer early-out)
  var gHost = {
    isMobileSpectator: false,
    isMultiplayer: true,
    lobbyState: { matchState: 'WAITING' }
  };
  assert.strictEqual(canResumeDualIdle(gHost), true, 'host WAITING must allow dual idle');
  var rHost = simulateEndThenDualIdle({
    matchActive: true, matchState: 'PLAYING', modesActive: true, _dualBotPreview: false
  }, gHost);
  assert.strictEqual(rHost.scheduled, true);
  assert.strictEqual(rHost.state._dualBotPreview, true);
  assert.strictEqual(isRealMatchPlaying(rHost.state, gHost.lobbyState), false,
    'dual idle must NOT show END MATCH');

  // 5) Lobby PLAYING blocks dual idle
  var gLive = {
    isMobileSpectator: false,
    isMultiplayer: true,
    lobbyState: { matchState: 'PLAYING' }
  };
  assert.strictEqual(canResumeDualIdle(gLive), false);
  assert.ok(isRealMatchPlaying({
    matchActive: true, matchState: 'COUNTDOWN', _dualBotPreview: false, modes: { active: false }
  }, gLive.lobbyState), 'lobby PLAYING + COUNTDOWN → END MATCH');

  console.log('PASS test-match-lifecycle');
}

main();
