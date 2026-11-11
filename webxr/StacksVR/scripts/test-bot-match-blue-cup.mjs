#!/usr/bin/env node
/**
 * VERIFY: solo host multiplayer vs-bot always owns BLUE cup (never red).
 * Repro: host seated on red → place projected onto red playfield.
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

function localCupSide(g, cups) {
  // Mirrors stacks-game._localCup side selection
  var mp = g.lobbyState && g.lobbyState.matchPlayers;
  var botMatch = !!(g.isLobbyBotMatch || (mp && mp.red === '__BOT__'));
  if (botMatch) return 'blue';
  if (g.isMultiplayer && g.StacksLobby && g.StacksLobby.amMatchPlayer()) {
    return g.StacksLobby.mySide();
  }
  return 'blue';
}

function main() {
  const g = loadLobby();
  const Lobby = g.StacksLobby;
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

  // Poison: host wrongly on red, blue empty / leftover
  Lobby.lobbyState.matchPlayers = { blue: null, red: Lobby.myPlayerId };
  Lobby.lobbyState.matchState = 'WAITING';
  g.startLobbyMatch();
  assert.strictEqual(Lobby.lobbyState.matchPlayers.blue, Lobby.myPlayerId, 'host must move to blue');
  assert.strictEqual(Lobby.lobbyState.matchPlayers.red, '__BOT__', 'red must be bot');
  assert.strictEqual(Lobby.mySide(), 'blue', 'mySide blue in bot match');
  assert.strictEqual(localCupSide(g), 'blue', 'localCup blue in bot match');

  // Poison: __BOT__ occupying blue blocked host from blue seat via queue
  g.endLobbyMatch({ cancelled: true });
  Lobby.lobbyState.matchPlayers = { blue: '__BOT__', red: null };
  Lobby.lobbyState.queue = [Lobby.myPlayerId];
  Lobby.lobbyState.matchState = 'WAITING';
  g.sendQueueAction('join');
  // queue join when already in queue from push — tryAssign should replace __BOT__ blue
  assert.strictEqual(Lobby.lobbyState.matchPlayers.blue, Lobby.myPlayerId,
    'queue must replace __BOT__ blue seat with host');
  g.startLobbyMatch();
  assert.strictEqual(Lobby.mySide(), 'blue');
  assert.strictEqual(localCupSide(g), 'blue');

  console.log('PASS test-bot-match-blue-cup');
}

main();
