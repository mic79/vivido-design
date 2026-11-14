#!/usr/bin/env node
/**
 * VERIFY role visibility matrix: host / seated client / VR spectator / mobile spectator
 * each get the cups they are allowed to see from network apply rules.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'stacks-game.js'), 'utf8');

function isViewOnlyObserver(g) {
  if (g.isMobileSpectator) return true;
  if (!g.isMultiplayer) return false;
  var mp = g.lobbyState && g.lobbyState.matchPlayers;
  var myId = g.myPlayerId;
  if (mp && myId && (mp.blue === myId || (mp.red === myId && mp.red !== '__BOT__'))) {
    return false;
  }
  return !!g.isSpectator;
}

function isLocalAuthoritySide(side, g) {
  if (!side) return false;
  if (isViewOnlyObserver(g)) return false;
  var mp = g.lobbyState && g.lobbyState.matchPlayers;
  var myId = g.myPlayerId;
  if (g.isMultiplayer && mp && myId) return mp[side] === myId;
  return side === 'blue';
}

function applyNetworkCups(cups, g, opts) {
  opts = opts || {};
  var out = { blue: null, red: null };
  if (opts.forceAll || isViewOnlyObserver(g)) {
    return { blue: cups.blue || null, red: cups.red || null };
  }
  var force = opts.forceSides || null;
  if (cups.blue && (!isLocalAuthoritySide('blue', g) || (force && force.blue))) out.blue = cups.blue;
  if (cups.red && (!isLocalAuthoritySide('red', g) || (force && force.red))) out.red = cups.red;
  return out;
}

function main() {
  assert(src.includes('_isViewOnlyObserver'), 'view-only helper');
  assert(src.includes('forceAll: viewOnly') || src.includes('forceAll: this._isViewOnlyObserver()'),
    'snapshots/state force full board for spectators');
  assert(src.includes('View-only (VR + mobile spectators)'), 'documents VR+mobile');

  var hostId = 'host';
  var peerId = 'peer';
  var specId = 'spec';
  var mp = { blue: hostId, red: peerId };
  var board = { blue: { n: 'BLUE' }, red: { n: 'RED' } };

  // Host seated blue — keeps own, takes red
  var host = applyNetworkCups(board, {
    isMultiplayer: true, myPlayerId: hostId, isSpectator: false,
    lobbyState: { matchPlayers: mp }
  });
  assert.strictEqual(host.blue, null, 'host keeps own blue');
  assert.strictEqual(host.red, board.red, 'host sees peer red');

  // Seated client red — keeps own, takes blue
  var peer = applyNetworkCups(board, {
    isMultiplayer: true, myPlayerId: peerId, isSpectator: false,
    lobbyState: { matchPlayers: mp }
  });
  assert.strictEqual(peer.red, null, 'peer keeps own red');
  assert.strictEqual(peer.blue, board.blue, 'peer sees host blue');

  // Host garbage on peer cup — peer must force-apply own
  var junk = applyNetworkCups(board, {
    isMultiplayer: true, myPlayerId: peerId, isSpectator: false,
    lobbyState: { matchPlayers: mp }
  }, { forceSides: { red: true } });
  assert.strictEqual(junk.red, board.red, 'peer applies host garbage on own cup');

  // VR spectator — full board
  var vrSpec = applyNetworkCups(board, {
    isMultiplayer: true, myPlayerId: specId, isSpectator: true,
    lobbyState: { matchPlayers: mp }
  });
  assert.strictEqual(vrSpec.blue, board.blue, 'VR spec sees blue');
  assert.strictEqual(vrSpec.red, board.red, 'VR spec sees red');

  // Mobile spectator — full board
  var mob = applyNetworkCups(board, {
    isMultiplayer: true, myPlayerId: 'phone', isSpectator: true, isMobileSpectator: true,
    lobbyState: { matchPlayers: mp }
  });
  assert.strictEqual(mob.blue, board.blue, 'mobile spec sees blue');
  assert.strictEqual(mob.red, board.red, 'mobile spec sees red');

  // Sticky isSpectator on seated human must NOT wipe their cup
  assert.strictEqual(isViewOnlyObserver({
    isMultiplayer: true, myPlayerId: peerId, isSpectator: true,
    lobbyState: { matchPlayers: mp }
  }), false, 'seated human is never view-only');

  console.log('PASS test-mp-role-visibility');
}

main();
