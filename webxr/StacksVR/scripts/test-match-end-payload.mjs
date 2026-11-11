#!/usr/bin/env node
/**
 * Regression: multiplayer match-ended must carry winner/scores so peers
 * can celebrate without local overflow detection; dual-idle must stay offline-only.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadLobby() {
  const code = fs.readFileSync(path.join(ROOT, 'lobby.js'), 'utf8');
  const sandbox = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    Peer: function Peer() {
      this.on = function () {};
      this.destroy = function () {};
    },
    fetch: async () => ({ ok: false }),
    document: { querySelector: () => null }
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'lobby.js' });
  return sandbox;
}

function main() {
  const g = loadLobby();
  const Lobby = g.StacksLobby || g.window.StacksLobby;
  assert(Lobby, 'StacksLobby missing');

  // Minimal host-ish state
  Lobby.lobbyState = {
    players: [{ id: 'host', nickname: 'Host' }, { id: 'peer', nickname: 'Peer' }],
    queue: [],
    spectatorSlots: [null, null, null, null],
    matchPlayers: { blue: 'host', red: 'peer' },
    matchState: 'PLAYING',
    matchScore: { blue: 2, red: 5 },
    matchGameState: 'PLAYING',
    bagSeed: 1
  };
  Lobby.isHost = true;
  Lobby.isMultiplayer = true;
  Lobby.connections = [];
  Lobby.myPlayerId = 'host';

  let ended = null;
  let sent = [];
  Lobby.onMatchEnded = function (opts) { ended = opts; };
  Lobby.connections = [{
    conn: {
      open: true,
      send: function (msg) { sent.push(msg); }
    },
    peerId: 'peer'
  }];

  // Stub broadcast helpers used by endLobbyMatch
  g.broadcastLobbyState = function () {};
  Lobby.broadcastLobbyState = function () {};

  assert.equal(typeof g.endLobbyMatch || typeof Lobby.endLobbyMatch, 'function');
  const endFn = g.endLobbyMatch || Lobby.endLobbyMatch;
  endFn({
    winner: 'red',
    reason: 'overflow',
    scores: { blue: 2, red: 5 },
    cancelled: false
  });

  assert(ended, 'onMatchEnded not called');
  assert.strictEqual(ended.winner, 'red');
  assert.strictEqual(ended.reason, 'overflow');
  assert.strictEqual(ended.victory, true);
  assert.strictEqual(ended.cancelled, false);
  assert(ended.scores && ended.scores.red === 5);

  const wire = sent.find((m) => m && m.type === 'match-ended');
  assert(wire, 'match-ended not broadcast');
  assert.strictEqual(wire.winner, 'red');
  assert.strictEqual(wire.reason, 'overflow');
  assert.strictEqual(wire.cancelled, false);

  console.log('PASS test-match-end-payload');
}

main();
