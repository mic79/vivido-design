#!/usr/bin/env node
/**
 * VERIFY: remote place/state/station must not overwrite the local player's cup
 * or station (root cause of host blocks vanishing / empty pads).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'stacks-game.js'), 'utf8');
const replay = fs.readFileSync(path.join(ROOT, 'match-replay.js'), 'utf8');

function main() {
  assert(src.includes('_isLocalAuthoritySide'), 'authority helper');
  assert(src.includes('_applyNetworkCups'), 'selective cup merge');
  assert(src.includes('_applyNetworkStation'), 'selective station merge');
  assert(src.includes("cupsMsg[side]"), 'place payload is placing seat only');
  assert(!src.includes("stations: {\n            blue: this._serializeStation('blue')"),
    'place must not bundle both stations');
  assert(src.includes('selfEnd._saveMatchHistory'),
    'match history deferred off end frame');
  assert(src.includes('if (opts.cancelled || opts.hostLeft) return;') &&
    src.includes('selfEnd._saveMatchHistory'),
    'cancelled matches must not save history');
  assert(replay.includes("tick: function () {}") && replay.includes('events-only'),
    'replay recorder is events-only (no per-frame cup snapshots)');
  assert(src.includes('_broadcastGarbage'), 'host garbage sync helper');
  assert(src.includes('forceSides'), 'garbage can force-apply own cup');

  // Seat-id authority only (bot seats are never local-player authority)
  function isLocalAuthoritySide(side, myId, mp, mobileSpec) {
    if (!side) return false;
    if (mobileSpec) return false;
    if (mp && myId) return mp[side] === myId;
    return side === 'blue';
  }
  function applyNetworkCups(cups, myId, mp, forceSides) {
    var out = { blue: null, red: null };
    if (cups.blue && (!isLocalAuthoritySide('blue', myId, mp, false) ||
        (forceSides && forceSides.blue))) out.blue = cups.blue;
    if (cups.red && (!isLocalAuthoritySide('red', myId, mp, false) ||
        (forceSides && forceSides.red))) out.red = cups.red;
    return out;
  }

  var hostId = 'host-1';
  var peerId = 'peer-1';
  var mp = { blue: hostId, red: peerId };
  var staleBlue = { cells: 'STALE' };
  var freshRed = { cells: 'FRESH' };
  var merged = applyNetworkCups({ blue: staleBlue, red: freshRed }, hostId, mp);
  assert.strictEqual(merged.blue, null, 'host must keep own blue cup');
  assert.strictEqual(merged.red, freshRed, 'host accepts red');

  assert.strictEqual(isLocalAuthoritySide('blue', hostId, mp, false), true);
  assert.strictEqual(isLocalAuthoritySide('blue', hostId, mp, true), false);
  assert.strictEqual(isLocalAuthoritySide('blue', peerId, mp, false), false);
  assert.strictEqual(isLocalAuthoritySide('red', peerId, mp, false), true);
  assert.strictEqual(
    isLocalAuthoritySide('blue', hostId, { blue: '__BOT__', red: '__BOT__' }, false),
    false,
    'host must not own bot blue while spectating dual bots'
  );

  // Host garbage on peer seat must force-apply on the peer
  var junk = { blue: { cells: 'H' }, red: { cells: 'GARBAGE' } };
  var peerSees = applyNetworkCups(junk, peerId, mp, { red: true });
  assert.strictEqual(peerSees.red, junk.red, 'forced garbage applies to peer own cup');

  console.log('PASS test-authority-cups');
}

main();
