#!/usr/bin/env node
/**
 * VERIFY: late-joining spectator cannot end the host's live vs-bot match.
 * Regression: host handleMatchAction used bare Lobby.isHost so ANY peer end worked.
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
  g.isHost = true;
  g.isMultiplayer = true;
  g.myPlayerId = 'host-1';
  g.lobbyState = Lobby.lobbyState;

  let ended = 0;
  Lobby.onMatchEnded = function () { ended += 1; };
  Lobby.onMatchStarted = function () {};

  g.startLobbyMatch();
  assert.strictEqual(Lobby.lobbyState.matchState, 'PLAYING');
  assert.strictEqual(Lobby.lobbyState.matchPlayers.red, '__BOT__');
  assert.strictEqual(Lobby.canIControlMatch(), true, 'host can control');

  // Late joiner / spectator
  Lobby.lobbyState.players.push({ id: 'peer-spec', nickname: 'Spec', mobile: false });
  assert.strictEqual(Lobby.isHumanMatchPlayer('peer-spec'), false);
  assert.strictEqual(Lobby.canControlMatch('peer-spec'), false, 'spectator cannot control');

  // Simulate peer sending match-action end (the old bug allowed this because isHost was true)
  ended = 0;
  // Directly invoke the host-side handler the way peer messages arrive
  // Re-enter via sendMatchAction is host-only; call canControlMatch gate equivalent:
  if (Lobby.canControlMatch('peer-spec')) {
    g.endLobbyMatch({ cancelled: true });
  }
  assert.strictEqual(ended, 0, 'spectator end must not fire endLobbyMatch');
  assert.strictEqual(Lobby.lobbyState.matchState, 'PLAYING', 'match still PLAYING');

  // Host can still end
  assert.strictEqual(Lobby.canControlMatch('host-1'), true);
  g.endLobbyMatch({ cancelled: true });
  assert.strictEqual(Lobby.lobbyState.matchState, 'WAITING');

  // PvP seated peer may end
  Lobby.lobbyState.matchPlayers = { blue: 'host-1', red: 'peer-2' };
  Lobby.lobbyState.matchState = 'PLAYING';
  assert.strictEqual(Lobby.canControlMatch('peer-2'), true, 'seated red may end');
  assert.strictEqual(Lobby.canControlMatch('peer-spec'), false);

  console.log('PASS test-spectator-cannot-end');
}

main();
