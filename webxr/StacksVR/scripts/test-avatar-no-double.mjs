#!/usr/bin/env node
/**
 * VERIFY: match seats use bot-body / spec-blue-body only — lobby remote-body-N
 * for that peer must be released or host/client see TWO avatars on the opponent.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'stacks-game.js'), 'utf8');

function main() {
  assert(src.includes('_releaseRemoteBodySlot'), 'release lobby pool slot');
  assert(src.includes('_rebindMatchSeatAvatars'), 'rebind on GO');
  assert(src.includes('this._rebindMatchSeatAvatars()'), 'called from live play');
  assert(src.includes('this._releaseRemoteBodySlot(fromId)'), 'release before seat body');
  assert(src.includes("indexOf('remote-body-') === 0"), 'only clear pool bodies');
  // Dual-idle must clear seats even while still connected to a lobby
  assert(!/if \(global\.isMultiplayer\) return;\s*\n\s*\/\/ Must null remoteHandData/.test(src),
    'dual-idle must not skip seat clear when isMultiplayer');
  assert(src.includes('bots do NOT use Mixamo seat bodies'), 'documents pad-only bots');
  assert(src.includes("this._clearRemoteAvatarEl(document.getElementById('bot-body'))"),
    'match end / dual-idle clears bot-body');

  // Simulate map transition
  var map = { peer1: 'remote-body-0', host1: 'remote-body-1' };
  var mp = { blue: 'host1', red: 'peer1' };
  var myId = 'host1';
  // Host view: release peer1 lobby slot when binding to bot-body
  function release(fromId) {
    var bid = map[fromId];
    if (!bid) return null;
    delete map[fromId];
    return bid;
  }
  assert.strictEqual(release(mp.red), 'remote-body-0');
  assert.strictEqual(map.peer1, undefined);
  assert.strictEqual(map.host1, 'remote-body-1'); // local never driven remotely
  // Playing prune: seated remotes must leave the pool map
  delete map[mp.blue]; // local
  assert.strictEqual(Object.keys(map).length, 0, 'no pool bodies for match seats');

  console.log('PASS test-avatar-no-double');
}

main();
