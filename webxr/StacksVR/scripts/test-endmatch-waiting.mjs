#!/usr/bin/env node
/**
 * VERIFY: endMatch while lobby WAITING (dual-preview clear while hosting)
 * must clear local match flags and must NOT leave _endingMatch stuck.
 *
 * Mirrors the stacks-game endMatch guard without booting A-Frame.
 */
import assert from 'assert';

function simulateEndMatch(state) {
  // Copied control flow from stacks-game.endMatch (keep in sync)
  if (state._endingMatch) return { skipped: true, state: state };
  state._endingMatch = true;
  var lobbyPlaying = !!(state.lobbyState && state.lobbyState.matchState === 'PLAYING');
  var sentEnd = false;
  var localEnded = false;

  if (state.isMultiplayer && lobbyPlaying && state.sendMatchAction) {
    state.sendMatchAction('end');
    sentEnd = true;
    if (state._endingMatch && state.isHost) {
      // safety path
      state._endingMatch = false;
      state.matchActive = false;
      state.modesActive = false;
      state._dualBotPreview = false;
      localEnded = true;
    }
    return { skipped: false, sentEnd: sentEnd, localEnded: localEnded, state: state };
  }
  state._endingMatch = false;
  state.matchActive = false;
  state.modesActive = false;
  state._dualBotPreview = false;
  localEnded = true;
  return { skipped: false, sentEnd: sentEnd, localEnded: localEnded, state: state };
}

function main() {
  // BUG repro: hosting + dual idle (WAITING) used to sendMatchAction('end') no-op
  // and leave _endingMatch true forever.
  var stale = {
    _endingMatch: false,
    isMultiplayer: true,
    isHost: true,
    matchActive: true,
    modesActive: true,
    _dualBotPreview: true,
    lobbyState: { matchState: 'WAITING' },
    sendMatchAction: function () { /* lobby ignores end while WAITING */ }
  };
  var r1 = simulateEndMatch(stale);
  assert.strictEqual(r1.sentEnd, false, 'must not lobby-end while WAITING');
  assert.strictEqual(r1.localEnded, true, 'must clear local dual preview');
  assert.strictEqual(stale._endingMatch, false, '_endingMatch must not stick');
  assert.strictEqual(stale._dualBotPreview, false);
  assert.strictEqual(stale.modesActive, false);

  // Real lobby match end still uses sendMatchAction
  var live = {
    _endingMatch: false,
    isMultiplayer: true,
    isHost: true,
    matchActive: true,
    modesActive: true,
    _dualBotPreview: false,
    lobbyState: { matchState: 'PLAYING' },
    sendMatchAction: function () {
      // host endLobbyMatch would clear via callback — simulate incomplete callback
    }
  };
  var r2 = simulateEndMatch(live);
  assert.strictEqual(r2.sentEnd, true);
  assert.strictEqual(r2.localEnded, true, 'host safety clears if callback missed');
  assert.strictEqual(live._endingMatch, false);

  console.log('PASS test-endmatch-waiting');
}

main();
