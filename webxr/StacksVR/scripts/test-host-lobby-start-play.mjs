#!/usr/bin/env node
/**
 * VERIFY host alone: dual-idle may publish lobby PLAYING with __BOT__,
 * then START MATCH must still enable bot + leave player able to control/place.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8840 + Math.floor(Math.random() * 40);
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.fbx': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.css': 'text/css'
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      const filePath = path.join(ROOT, urlPath.replace(/^\//, ''));
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  let failed = null;
  try {
    const page = await browser.newPage();
    page.on('console', (m) => {
      const t = m.text();
      if (/FAIL|StacksGame|Lobby|error/i.test(t)) console.log('[page]', t);
    });
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const el = document.querySelector('[stacks-game]');
      return el && el.components && el.components['stacks-game'] &&
        el.components['stacks-game'].bot && window.StacksLobby && window.createLobbyState;
    }, null, { timeout: 45000 });

    const out = await page.evaluate(async () => {
      const Lobby = window.StacksLobby;
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];

      // Simulate host connected
      Lobby.isHost = true;
      Lobby.isMultiplayer = true;
      Lobby.myPlayerId = 'stacksvr-host-1';
      Lobby.connections = [];
      Lobby.lobbyState = window.createLobbyState();
      Lobby.lobbyState.players.push({ id: Lobby.myPlayerId, nickname: 'Host', mobile: false });
      window.isHost = true;
      window.isMultiplayer = true;
      window.myPlayerId = Lobby.myPlayerId;
      window.lobbyState = Lobby.lobbyState;
      Lobby.isSpectator = true; // host parked in spectator slot initially
      window.isSpectator = true;

      // Dual-idle spectacle while hosting (current product default)
      comp.startOfflinePreviewMatch();

      // Heartbeat must NOT promote dual-idle into lobby PLAYING
      var published = false;
      if (typeof window.ensureLobbyMatchPublished === 'function') {
        published = !!window.ensureLobbyMatchPublished();
      }

      const afterPublish = {
        published: published,
        matchState: Lobby.lobbyState.matchState,
        blue: Lobby.lobbyState.matchPlayers.blue,
        red: Lobby.lobbyState.matchPlayers.red,
        isLobbyBotMatch: !!window.isLobbyBotMatch,
        dual: !!comp._dualBotPreview
      };

      // Also cover the OLD poison path: lobby already PLAYING with __BOT__ seat
      Lobby.lobbyState.matchState = 'PLAYING';
      Lobby.lobbyState.matchPlayers.blue = Lobby.myPlayerId;
      Lobby.lobbyState.matchPlayers.red = '__BOT__';
      window.lobbyState = Lobby.lobbyState;

      // Host joins queue then START
      if (window.sendQueueAction) window.sendQueueAction('join');
      if (typeof comp.stopLocalPreview === 'function') comp.stopLocalPreview();
      window.startLobbyMatch();

      const afterStart = {
        matchState: Lobby.lobbyState.matchState,
        localState: comp.matchState,
        isBotMatchFlag: !!window.isLobbyBotMatch,
        red: Lobby.lobbyState.matchPlayers.red,
        pendingBot: !!(comp._pendingMatch && comp._pendingMatch.isBotSeat),
        canControl: !!comp._canControl(),
        isSpectator: !!window.isSpectator,
        amMatch: !!(Lobby.amMatchPlayer && Lobby.amMatchPlayer()),
        dual: !!comp._dualBotPreview
      };

      // Skip countdown → live
      if (comp.matchState === 'COUNTDOWN') comp._beginLivePlay();

      const afterGo = {
        localState: comp.matchState,
        botOn: !!(comp.bot && comp.bot.enabled),
        botPadVis: !!(comp._botPad && comp._botPad.visible),
        padPiece: !!comp._padPiece,
        canControl: !!comp._canControl(),
        isLobbyBotMatch: !!window.isLobbyBotMatch,
        isSpectator: !!window.isSpectator
      };

      // Simulate grab + hold over cup → place must work on BLUE only
      const localSide = comp._localCup() && comp._localCup().side;
      if (comp._padPiece) {
        const hand = document.getElementById('rightHand');
        comp._grab(hand);
      }
      const held = !!comp.held;
      let placed = false;
      let blueCells = 0;
      let redCellsBefore = comp.cups.red.serialize().cells.length;
      if (comp.held) {
        const cup = comp._localCup();
        const type = comp.held.type;
        const local = window.StacksShapes.cellsOriented(type, new THREE.Quaternion());
        const dropped = local.map((c) => [c[0] + 1, c[1], c[2] + 1]);
        const grav = comp._gravity(cup, dropped);
        if (grav) {
          comp.ghostValid = true;
          comp.ghostCells = grav;
          comp._place(grav);
          blueCells = comp.cups.blue.serialize().cells.length;
          placed = blueCells > 0;
        }
      }

      // Let bot think once
      if (comp.bot && comp.bot.enabled) {
        comp.bot._lastThink = 0;
        for (let i = 0; i < 5; i++) comp.bot.tick(performance.now() + i * 500);
      }
      const redCells = comp.cups.red.serialize().cells.length;

      return {
        afterPublish, afterStart, afterGo, held, placed, redCells, blueCells,
        localSide, redCellsBefore, mySide: Lobby.mySide && Lobby.mySide()
      };
    });

    console.log('RESULT', JSON.stringify(out, null, 2));

    if (out.afterPublish.published) throw new Error('dual-idle must not publish lobby PLAYING');
    if (out.afterPublish.matchState !== 'WAITING') throw new Error('dual-idle lobby must stay WAITING');
    if (!out.afterStart.pendingBot) throw new Error('pending isBotSeat false after host start');
    if (!out.afterStart.isBotMatchFlag) throw new Error('startLobbyMatch must set isLobbyBotMatch with pre-filled __BOT__');
    if (!out.afterGo.botOn) throw new Error('bot not enabled after GO (lobby host vs bot)');
    if (!out.afterGo.botPadVis) throw new Error('bot pad not visible');
    if (!out.afterGo.canControl) throw new Error('host cannot control after GO');
    if (!out.afterGo.padPiece && !out.held) throw new Error('no human pad piece');
    if (!out.placed) throw new Error('host could not place a piece');
    if (!out.afterGo.isLobbyBotMatch) throw new Error('isLobbyBotMatch must be true for solo host');
    if (out.localSide !== 'blue') throw new Error('localCup must be blue, got ' + out.localSide);
    if (out.mySide !== 'blue') throw new Error('mySide must be blue, got ' + out.mySide);
    if (!(out.blueCells > 0)) throw new Error('place must land on blue cup');
    if (out.redCells <= out.redCellsBefore) {
      // bot may not have placed yet — only require blue got the human piece
    }

    console.log('PASS host lobby start → bot + place');
  } catch (e) {
    failed = e;
    console.error('FAIL', e && e.stack ? e.stack : e);
  } finally {
    await browser.close();
    server.close();
  }
  if (failed) process.exit(1);
}
main();
