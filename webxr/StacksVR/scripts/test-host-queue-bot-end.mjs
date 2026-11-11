#!/usr/bin/env node
/**
 * VERIFY: Host lobby → join queue alone → START = vs bot;
 * END returns to WAITING and can START again.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadLobbyDirect() {
  const code = fs.readFileSync(path.join(ROOT, 'lobby.js'), 'utf8');
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Peer: function Peer() { this.on = function () {}; this.destroy = function () {}; },
    fetch: async () => ({ ok: false }),
    document: { querySelector: () => null },
    window: null
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'lobby.js' });
  return sandbox;
}

function main() {
  const g = loadLobbyDirect();
  const Lobby = g.StacksLobby;
  assert(Lobby, 'StacksLobby missing');

  Lobby.isHost = true;
  Lobby.isMultiplayer = true;
  Lobby.myPlayerId = 'stacksvr-host-1';
  Lobby.connections = [];
  Lobby.lobbyState = g.createLobbyState();
  Lobby.lobbyState.players.push({ id: Lobby.myPlayerId, nickname: 'Host', mobile: false });
  g.isHost = true;
  g.isMultiplayer = true;
  g.myPlayerId = Lobby.myPlayerId;
  g.lobbyState = Lobby.lobbyState;

  let started = null;
  let ended = null;
  Lobby.onMatchStarted = function (mp, t, isBot, seed) {
    started = { mp: Object.assign({}, mp), isBotMatch: !!isBot, seed: seed };
  };
  Lobby.onMatchEnded = function (opts) { ended = opts || {}; };

  // Host joins queue alone → seated blue only
  g.sendQueueAction('join');
  assert.strictEqual(Lobby.lobbyState.matchPlayers.blue, Lobby.myPlayerId, 'host should seat blue from queue');
  assert.strictEqual(Lobby.lobbyState.matchPlayers.red, null, 'red must stay open for bot fill');

  // START → vs bot
  started = null;
  g.startLobbyMatch();
  assert(started, 'onMatchStarted not fired');
  assert.strictEqual(started.isBotMatch, true, 'solo host start must be bot match');
  assert.strictEqual(started.mp.red, '__BOT__', 'red seat must be __BOT__');
  assert.strictEqual(Lobby.lobbyState.matchState, 'PLAYING');
  assert.strictEqual(g.isLobbyBotMatch, true);

  // END → WAITING, can start again
  ended = null;
  g.endLobbyMatch({ cancelled: true });
  assert(ended && ended.cancelled, 'onMatchEnded cancelled expected');
  assert.strictEqual(Lobby.lobbyState.matchState, 'WAITING');
  assert.notStrictEqual(Lobby.lobbyState.matchPlayers.red, '__BOT__', 'bot seat cleared');

  // START again without re-queue (host auto-seat)
  started = null;
  g.startLobbyMatch();
  assert(started && started.isBotMatch === true, 'host restart alone must still be vs bot');
  assert.strictEqual(started.mp.blue, Lobby.myPlayerId);
  assert.strictEqual(started.mp.red, '__BOT__');

  // START while red already __BOT__ (dual-idle publish left seat filled) must stay bot match
  g.endLobbyMatch({ cancelled: true });
  Lobby.lobbyState.matchPlayers = { blue: Lobby.myPlayerId, red: '__BOT__' };
  Lobby.lobbyState.matchState = 'WAITING';
  started = null;
  g.startLobbyMatch();
  assert(started && started.isBotMatch === true, 'pre-filled __BOT__ red must still be bot match');
  assert.strictEqual(g.isLobbyBotMatch, true);

  // Two humans seated → PvP (no bot)
  g.endLobbyMatch({ cancelled: true });
  Lobby.lobbyState.matchPlayers = { blue: Lobby.myPlayerId, red: 'peer-2' };
  Lobby.lobbyState.queue = [];
  Lobby.lobbyState.matchState = 'WAITING';
  started = null;
  g.startLobbyMatch();
  assert(started, 'pvp start missing');
  assert.strictEqual(started.isBotMatch, false, 'two humans must be PvP not bot');
  assert.strictEqual(started.mp.red, 'peer-2');

  console.log('PASS test-host-queue-bot-end');
}

main();
