#!/usr/bin/env node
/**
 * VERIFY: boardSize 4×4/6×6 rides lobby-state + match-started; peers request host.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadLobby(emits) {
  const code = fs.readFileSync(path.join(ROOT, 'lobby.js'), 'utf8');
  const sandbox = {
    console, setTimeout, clearTimeout,
    Peer: function Peer() { this.on = function () {}; this.destroy = function () {}; },
    fetch: async () => ({ ok: false }),
    document: {
      querySelector: () => ({
        emit: function (name, detail) { emits.push({ name: name, detail: detail || null }); }
      })
    },
    window: null
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox, { filename: 'lobby.js' });
  return sandbox;
}

function makeTHREE() {
  function Group() {
    this.children = [];
    this.position = { x: 0, y: 0, z: 0, set: function (x, y, z) { this.x = x; this.y = y; this.z = z; } };
    this.rotation = { y: 0 };
    this.visible = true;
    this.name = '';
    this.add = function (c) { this.children.push(c); c.parent = this; };
    this.remove = function (c) {
      var i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    };
    this.traverse = function (fn) { fn(this); for (var i = 0; i < this.children.length; i++) {
      if (this.children[i].traverse) this.children[i].traverse(fn);
      else fn(this.children[i]);
    }};
  }
  function Mesh() {
    this.userData = {};
    this.position = { x: 0, y: 0, z: 0, set: function (x, y, z) { this.x = x; this.y = y; this.z = z; } };
    this.rotation = { y: 0 };
    this.material = {};
    this.geometry = { dispose: function () {} };
    this.visible = true;
    this.children = [];
    this.parent = null;
    this.add = function (c) { this.children.push(c); c.parent = this; };
    this.remove = function (c) {
      var i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    };
    this.traverse = function (fn) {
      fn(this);
      for (var i = 0; i < this.children.length; i++) {
        var ch = this.children[i];
        if (ch && typeof ch.traverse === 'function') ch.traverse(fn);
        else if (ch) fn(ch);
      }
    };
  }
  function Mat() { this.dispose = function () {}; this.clone = function () { return new Mat(); }; }
  return {
    Group: Group,
    Mesh: Mesh,
    Line: Mesh,
    MeshBasicMaterial: Mat,
    MeshStandardMaterial: Mat,
    LineBasicMaterial: Mat,
    BoxGeometry: function () { this.dispose = function () {}; },
    TubeGeometry: function () { this.dispose = function () {}; },
    RingGeometry: function () { this.dispose = function () {}; },
    BufferGeometry: function () {
      this.setFromPoints = function () { return this; };
      this.dispose = function () {};
    },
    CurvePath: function () { this.add = function () {}; },
    LineCurve3: function () {},
    QuadraticBezierCurve3: function () {},
    Vector3: function (x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; },
    Color: function () {},
    MathUtils: {
      clamp: function (v, a, b) { return Math.max(a, Math.min(b, v)); }
    },
    DoubleSide: 2,
    FrontSide: 0
  };
}

function main() {
  const emits = [];
  const g = loadLobby(emits);
  const Lobby = g.StacksLobby;
  Lobby.isHost = true;
  Lobby.isMultiplayer = true;
  Lobby.myPlayerId = 'host-1';
  Lobby.connections = [];
  Lobby.lobbyState = g.createLobbyState();
  assert.strictEqual(Lobby.lobbyState.boardSize, 6, 'default boardSize 6');
  assert.strictEqual(g.getBoardSize(), 6);

  assert.strictEqual(g.setBoardSize(4), true);
  assert.strictEqual(Lobby.lobbyState.boardSize, 4);
  assert.strictEqual(g.getBoardSize(), 4);
  assert.ok(emits.some(function (e) {
    return e.name === 'board-size-changed' && e.detail && e.detail.boardSize === 4;
  }), 'host emits board-size-changed');

  // Broadcast payload includes boardSize
  var peerGot = null;
  Lobby.connections = [{
    conn: {
      open: true,
      send: function (msg) {
        if (msg.type === 'lobby-state') peerGot = msg.state;
      }
    }
  }];
  g.setBoardSize(4); // same size — no rebroadcast of change, force broadcast
  g.broadcastLobbyState();
  assert.ok(peerGot);
  assert.strictEqual(peerGot.boardSize, 4, 'lobby-state carries boardSize');

  // match-started payload includes boardSize
  var matchMsg = null;
  Lobby.connections = [{
    conn: {
      open: true,
      send: function (msg) {
        if (msg.type === 'match-started') matchMsg = msg;
      }
    }
  }];
  Lobby.lobbyState.matchPlayers = { blue: 'host-1', red: 'peer-1' };
  Lobby.lobbyState.matchState = 'WAITING';
  Lobby.lobbyState.boardSize = 4;
  g.startLobbyMatch();
  assert.ok(matchMsg, 'match-started sent');
  assert.strictEqual(matchMsg.boardSize, 4, 'match-started.boardSize');
  assert.strictEqual(matchMsg.state.boardSize, 4, 'match-started.state.boardSize');

  // Non-host cannot set; requestBoardSize sends to host
  const peerEmits = [];
  const peer = loadLobby(peerEmits);
  peer.StacksLobby.isHost = false;
  peer.StacksLobby.isMultiplayer = true;
  peer.StacksLobby.myPlayerId = 'peer-1';
  peer.StacksLobby.connections = [];
  peer.StacksLobby.lobbyState = peer.createLobbyState();
  assert.strictEqual(peer.setBoardSize(4), false, 'non-host cannot set directly');
  var sent = [];
  peer.StacksLobby.conn = { open: true, send: function (m) { sent.push(m); } };
  assert.strictEqual(peer.requestBoardSize(4), true);
  assert.strictEqual(sent[0].type, 'board-size');
  assert.strictEqual(sent[0].size, 4);

  assert.strictEqual(g.StacksLobby.normalizeBoardSize(4), 4);
  assert.strictEqual(g.StacksLobby.normalizeBoardSize(5), 6);
  assert.strictEqual(g.StacksLobby.normalizeBoardSize(6), 6);

  // Cup.resize
  const THREE = makeTHREE();
  const cupSandbox = {
    console,
    THREE,
    StacksShapes: {
      CELL: 0.12,
      createBlockMesh: function () { return new THREE.Mesh(); }
    },
    window: null
  };
  cupSandbox.window = cupSandbox;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'cup.js'), 'utf8'), cupSandbox, { filename: 'cup.js' });
  const Cup = cupSandbox.StacksCup;
  assert.ok(Cup, 'StacksCup exported');
  const c = new Cup({
    id: 't', side: 'blue', width: 6, depth: 6, height: 12,
    position: { x: 0, y: 0.9, z: 0 }
  });
  assert.strictEqual(c.width, 6);
  var cx = c.pivot.position.x;
  var cz = c.pivot.position.z;
  assert.strictEqual(c.resize(4, 4), true);
  assert.strictEqual(c.width, 4);
  assert.strictEqual(c.depth, 4);
  assert.strictEqual(c.pivot.position.x, cx, 'pivot center X preserved');
  assert.strictEqual(c.pivot.position.z, cz, 'pivot center Z preserved');
  assert.strictEqual(c.serialize().width, 4);
  assert.strictEqual(c.resize(4, 4), false);
  c.applySnapshot({ width: 6, depth: 6, cells: [] });
  assert.strictEqual(c.width, 6);

  console.log('PASS test-board-size-sync');
}

main();
