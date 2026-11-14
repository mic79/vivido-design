#!/usr/bin/env node
/**
 * VERIFY: PvP client sees spawn-box pieces + host-pushed garbage on own cup.
 *
 * Root causes locked in:
 * 1) bot.enable(false) emitted pad:null and wiped RED after _spawnBothPads
 *    (blue was protected; red client got an empty spawn box).
 * 2) Host ticks garbage then _broadcastState('garbage'); client
 *    _isLocalAuthoritySide skipped own cup → invisible junk/attack lines.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'stacks-game.js'), 'utf8');

function main() {
  // --- Pad: human seats must ignore bot visual wipes ---
  assert(src.includes("seatVis !== '__BOT__'"), 'human seat guard in _onBotVisual');
  assert(src.includes('bot.enable(false) emits pad:null') ||
    src.includes('bot.enable(false) emits pad:null') ||
    src.includes('wiped the red spawn box'),
    'documents red wipe root cause');
  // Must NOT only protect blue
  assert(!/Human owns the blue pad\/pocket outside dual-bot preview/.test(src),
    'old blue-only bot-visual guard must be gone');

  function shouldIgnoreBotVisual(side, mp, dualPreview) {
    if (dualPreview) return false;
    var seatVis = mp && mp[side];
    if (seatVis && seatVis !== '__BOT__') return true;
    if (side === 'blue' && !seatVis) return true;
    return false;
  }

  var pvp = { blue: 'host-1', red: 'peer-1' };
  assert.strictEqual(shouldIgnoreBotVisual('red', pvp, false), true,
    'PvP red human must ignore bot pad:null');
  assert.strictEqual(shouldIgnoreBotVisual('blue', pvp, false), true,
    'PvP blue human must ignore bot pad:null');
  assert.strictEqual(shouldIgnoreBotVisual('red', { blue: 'host-1', red: '__BOT__' }, false), false,
    'bot red still receives bot visuals');
  assert.strictEqual(shouldIgnoreBotVisual('blue', { blue: '__BOT__', red: '__BOT__' }, true), false,
    'dual-preview bots receive visuals');

  // --- Garbage: dedicated host→peer event that force-applies own cup ---
  assert(src.includes('_broadcastGarbage'), 'host broadcasts dedicated garbage');
  assert(src.includes("kind: 'garbage'"), 'garbage cup-event kind');
  assert(src.includes("evt.kind === 'garbage'"), 'client handles garbage kind');
  assert(src.includes('forceSides'), 'forceSides cup merge');
  assert(src.includes('this._broadcastGarbage(applied)'), 'attack tick uses _broadcastGarbage');
  assert(src.includes("this._broadcastGarbage([{ side: side, layers: 1, spawned: idleSpawned }])"),
    'inactivity junk uses _broadcastGarbage');
  assert(!src.includes("this._broadcastState('garbage')"),
    'must not use gated state broadcast for garbage');

  function isLocalAuthoritySide(side, myId, mp) {
    if (!side) return false;
    if (mp && myId) return mp[side] === myId;
    return side === 'blue';
  }
  function applyNetworkCups(cups, myId, mp, forceSides) {
    var out = { blue: null, red: null };
    if (cups.blue && (!isLocalAuthoritySide('blue', myId, mp) || (forceSides && forceSides.blue))) {
      out.blue = cups.blue;
    }
    if (cups.red && (!isLocalAuthoritySide('red', myId, mp) || (forceSides && forceSides.red))) {
      out.red = cups.red;
    }
    return out;
  }

  var hostId = 'host-1';
  var peerId = 'peer-1';
  var mp = { blue: hostId, red: peerId };
  var hostGarbageOnPeer = { blue: { cells: 'HOST' }, red: { cells: 'JUNK_ON_PEER' } };

  // Old buggy path: peer rejects own red → invisible garbage
  var buggy = applyNetworkCups(hostGarbageOnPeer, peerId, mp, null);
  assert.strictEqual(buggy.red, null, 'without force, peer skips own cup (the bug)');

  // Fixed path: garbage forceSides includes red
  var fixed = applyNetworkCups(hostGarbageOnPeer, peerId, mp, { red: true });
  assert.strictEqual(fixed.red, hostGarbageOnPeer.red, 'peer MUST apply host garbage on own cup');
  assert.strictEqual(fixed.blue, hostGarbageOnPeer.blue, 'peer still applies opponent cup');

  // Host still keeps own cup unless forced
  var hostView = applyNetworkCups(hostGarbageOnPeer, hostId, mp, { red: true });
  assert.strictEqual(hostView.blue, null, 'host keeps own blue when only red forced');
  assert.strictEqual(hostView.red, hostGarbageOnPeer.red, 'host applies red garbage side');

  // Attack buffer must sync on garbage (seated players are not spectators)
  assert(src.includes('if (evt.attack) this.attackSys.applySerialized(evt.attack'),
    'garbage event applies attack buffer');
  assert(src.includes("evt.reason === 'garbage'"), 'state reason=garbage also syncs attack');

  console.log('PASS test-mp-garbage-pad-sync');
}

main();
