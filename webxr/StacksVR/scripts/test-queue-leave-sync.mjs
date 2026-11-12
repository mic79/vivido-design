#!/usr/bin/env node
/**
 * VERIFY: queue keeps players listed (Q:N), leave removes only that player,
 * two queued humans start as PvP on correct seats.
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

function main() {
  const g = loadLobby();
  const Lobby = g.StacksLobby;
  Lobby.isHost = true;
  Lobby.isMultiplayer = true;
  Lobby.myPlayerId = 'host-1';
  Lobby.connections = [];
  Lobby.lobbyState = g.createLobbyState();
  Lobby.lobbyState.players.push({ id: 'host-1', nickname: 'Host', mobile: false });
  Lobby.lobbyState.players.push({ id: 'peer-2', nickname: 'Peer', mobile: false });
  g.isHost = true;
  g.isMultiplayer = true;
  g.myPlayerId = 'host-1';
  g.lobbyState = Lobby.lobbyState;

  // Both join queue — stay in queue AND get seats
  g.sendQueueAction('join');
  Lobby.isHost = true; // handle as host for peer via handleQueueAction
  // Simulate peer join through host handler
  const handle = (function () {
    // access via send from peer path
    return null;
  })();
  // Directly invoke by re-getting through queue-action simulation:
  // Host receives peer's queue-action
  const code = fs.readFileSync(path.join(ROOT, 'lobby.js'), 'utf8');
  // Use exported sendQueueAction only works for local host; call internal via
  // joining peer by pushing through Lobby — use setBoardSize pattern: broadcast after manual
  // The host processes peer actions via handleData — call join for peer:
  // Expose: we can use the fact handleQueueAction isn't exported — join host then
  // manually call through a trick: temporarily set myPlayerId
  g.sendQueueAction('join'); // host already in queue
  assert.strictEqual(Lobby.lobbyState.queue.length, 1);
  assert.strictEqual(Lobby.lobbyState.matchPlayers.blue, 'host-1');

  // Peer joins (simulate host handling peer queue-action)
  Lobby.lobbyState.queue.push('peer-2');
  // Re-run assign — need to call tryAssign. Easiest: leave+rejoin host path won't work.
  // Use sendQueueAction with swapped id by calling join via match-action style —
  // Patch: invoke by temporarily being host processing:
  const prev = Lobby.myPlayerId;
  // Directly use filter/assign by re-joining through exported API after exposing —
  // Read: handleQueueAction is closed. Use leave then reconstruct.
  // Actually broadcast path: set Lobby and call sendQueueAction while myPlayerId=peer
  Lobby.myPlayerId = 'peer-2';
  g.myPlayerId = 'peer-2';
  g.sendQueueAction('join');
  Lobby.myPlayerId = prev;
  g.myPlayerId = prev;

  assert.strictEqual(Lobby.lobbyState.queue.length, 2, 'both stay in queue → Q:2');
  assert.strictEqual(Lobby.lobbyState.matchPlayers.blue, 'host-1');
  assert.strictEqual(Lobby.lobbyState.matchPlayers.red, 'peer-2');

  // Peer leaves queue — only peer removed, host stays Q:1
  Lobby.myPlayerId = 'peer-2';
  g.myPlayerId = 'peer-2';
  g.sendQueueAction('leave');
  Lobby.myPlayerId = prev;
  g.myPlayerId = prev;

  assert.strictEqual(Lobby.lobbyState.queue.length, 1, 'leave must leave Q:1 not Q:0');
  assert.strictEqual(Lobby.lobbyState.queue[0], 'host-1');
  assert.strictEqual(Lobby.lobbyState.matchPlayers.blue, 'host-1');
  assert.notStrictEqual(Lobby.lobbyState.matchPlayers.red, 'peer-2', 'peer unseated');

  // Re-join peer, start PvP
  Lobby.myPlayerId = 'peer-2';
  g.sendQueueAction('join');
  Lobby.myPlayerId = prev;
  assert.strictEqual(Lobby.lobbyState.queue.length, 2);

  let started = null;
  Lobby.onMatchStarted = function (mp, t, isBot) {
    started = { mp: Object.assign({}, mp), isBotMatch: !!isBot };
  };
  g.startLobbyMatch();
  assert(started, 'match started');
  assert.strictEqual(started.isBotMatch, false, 'two humans = PvP');
  assert.strictEqual(started.mp.blue, 'host-1');
  assert.strictEqual(started.mp.red, 'peer-2');
  assert.strictEqual(Lobby.lobbyState.queue.length, 0, 'queue consumed on start');

  console.log('PASS test-queue-leave-sync');
}

main();
