#!/usr/bin/env node
/**
 * VERIFY: client queues first, host queues, host starts → PvP (not vs-bot).
 * Regression: startLobbyMatch cleared host off red then forced blue=host + red=__BOT__.
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
    console, setTimeout, clearTimeout,
    Peer: function Peer() { this.on = function () {}; this.destroy = function () {}; },
    fetch: async () => ({ ok: false }),
    document: { querySelector: () => null },
    window: null
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'lobby.js' });
  return sandbox;
}

function asPlayer(g, id) {
  g.StacksLobby.myPlayerId = id;
  g.myPlayerId = id;
}

function main() {
  const g = loadLobby();
  const Lobby = g.StacksLobby;
  Lobby.isHost = true;
  Lobby.isMultiplayer = true;
  Lobby.myPlayerId = 'host-1';
  Lobby.connections = [];
  Lobby.lobbyState = g.createLobbyState();
  Lobby.lobbyState.players.push({ id: 'host-1', nickname: 'Host', mobile: false });
  Lobby.lobbyState.players.push({ id: 'peer-1', nickname: 'Client', mobile: false });
  g.isHost = true;
  g.isMultiplayer = true;
  g.myPlayerId = 'host-1';
  g.lobbyState = Lobby.lobbyState;

  let started = null;
  Lobby.onMatchStarted = function (mp, t, isBot) {
    started = { mp: Object.assign({}, mp), isBotMatch: !!isBot };
  };

  // Client joins queue FIRST → takes blue
  asPlayer(g, 'peer-1');
  // Host machine still processes queue via handleQueueAction(playerId)
  // Simulate by calling join with swapped myPlayerId while isHost (same as earlier tests)
  g.sendQueueAction('join');
  assert.strictEqual(Lobby.lobbyState.matchPlayers.blue, 'peer-1', 'client first → blue');
  assert.strictEqual(Lobby.lobbyState.queue.length, 1);

  // Host joins queue → takes red
  asPlayer(g, 'host-1');
  g.sendQueueAction('join');
  assert.strictEqual(Lobby.lobbyState.queue.length, 2, 'Q:2');
  assert.strictEqual(Lobby.lobbyState.matchPlayers.blue, 'peer-1', 'client keeps blue');
  assert.strictEqual(Lobby.lobbyState.matchPlayers.red, 'host-1', 'host on red');

  // Host starts — MUST be PvP, not bot
  started = null;
  g.startLobbyMatch();
  assert(started, 'match started');
  assert.strictEqual(started.isBotMatch, false, 'must be PvP not bot');
  assert.strictEqual(started.mp.blue, 'peer-1', 'client stays blue');
  assert.strictEqual(started.mp.red, 'host-1', 'host stays red');
  assert.notStrictEqual(started.mp.red, '__BOT__', 'red is not bot');
  assert.strictEqual(Lobby.lobbyState.matchState, 'PLAYING');

  // Variant: client queued, host starts WITHOUT joining queue → host takes red, PvP
  g.endLobbyMatch({ cancelled: true });
  Lobby.lobbyState.matchPlayers = { blue: null, red: null };
  Lobby.lobbyState.queue = [];
  asPlayer(g, 'peer-1');
  g.sendQueueAction('join');
  assert.strictEqual(Lobby.lobbyState.matchPlayers.blue, 'peer-1');
  asPlayer(g, 'host-1');
  started = null;
  g.startLobbyMatch();
  assert(started && started.isBotMatch === false, 'host start without queue still PvP vs queued client');
  assert.strictEqual(started.mp.blue, 'peer-1');
  assert.strictEqual(started.mp.red, 'host-1');

  // Solo host still gets bot
  g.endLobbyMatch({ cancelled: true });
  Lobby.lobbyState.matchPlayers = { blue: null, red: null };
  Lobby.lobbyState.queue = [];
  asPlayer(g, 'host-1');
  started = null;
  g.startLobbyMatch();
  assert(started && started.isBotMatch === true, 'solo host → bot');
  assert.strictEqual(started.mp.blue, 'host-1');
  assert.strictEqual(started.mp.red, '__BOT__');

  console.log('PASS test-pvp-queue-start');
}

main();
