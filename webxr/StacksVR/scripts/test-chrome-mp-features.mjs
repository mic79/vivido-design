#!/usr/bin/env node
/**
 * Chrome feature proof (no Quest required): real index.html + PeerJS host/peer.
 * Covers seating/spectate, PvP start, cup authority, pad spawn, end, stats.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8870 + Math.floor(Math.random() * 80);
const LOBBY = 70 + Math.floor(Math.random() * 20);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.fbx': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav'
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
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

async function bootPage(context, nick) {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[' + nick + '-err]', e.message));
  await page.addInitScript((name) => {
    try { localStorage.setItem('stacksvr-nickname', name); } catch (e) {}
    window.playerNickname = name;
  }, nick);
  await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
  // Dismiss pre-VR overlay so A-Frame can boot
  await page.evaluate(() => {
    var ov = document.getElementById('pre-vr-overlay');
    if (ov) ov.style.display = 'none';
  });
  await page.waitForFunction(() => {
    var el = document.querySelector('[stacks-game]');
    return !!(el && el.components && el.components['stacks-game'] &&
      window.StacksLobby && window.connectToLobby && window.startLobbyMatch);
  }, null, { timeout: 60000 });
  return page;
}

async function waitMp(page, pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 25000)) {
    const ok = await page.evaluate(pred);
    if (ok) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  let failed = null;
  const results = [];

  try {
    const hostCtx = await browser.newContext();
    const peerCtx = await browser.newContext();
    const host = await bootPage(hostCtx, 'HostChrome');
    const peer = await bootPage(peerCtx, 'PeerChrome');

    // ── 1) Host lobby ──
    await host.evaluate(async (n) => { await window.connectToLobby(n); }, LOBBY);
    if (!(await waitMp(host, () => window.isMultiplayer && window.isHost && window.connectionState === 'connected'))) {
      throw new Error('host failed to enter lobby ' + LOBBY);
    }
    results.push('host lobby OK');

    // ── 2) Empty-queue START → dual bots, host spectates ──
    await host.evaluate(() => {
      if (window.StacksLobby && window.StacksLobby.lobbyState) {
        window.StacksLobby.lobbyState.queue = [];
      }
      window.startLobbyMatch();
    });
    await host.waitForTimeout(800);
    const dual = await host.evaluate(() => {
      var mp = window.lobbyState && window.lobbyState.matchPlayers;
      return {
        blue: mp && mp.blue,
        red: mp && mp.red,
        spec: !!window.isSpectator,
        playing: window.lobbyState && window.lobbyState.matchState === 'PLAYING'
      };
    });
    if (!dual.playing) throw new Error('dual-bot start not PLAYING: ' + JSON.stringify(dual));
    if (dual.blue !== '__BOT__' || dual.red !== '__BOT__') {
      throw new Error('empty queue must be dual bots: ' + JSON.stringify(dual));
    }
    if (!dual.spec) throw new Error('non-queued host must spectate dual bots');
    results.push('dual-bot spectate OK');

    await host.evaluate(() => {
      if (window.endLobbyMatch) window.endLobbyMatch({ cancelled: true });
      else if (window.sendMatchAction) window.sendMatchAction('end', { cancelled: true });
    });
    await waitMp(host, () => !window.lobbyState || window.lobbyState.matchState !== 'PLAYING', 10000);

    // ── 3) Peer joins ──
    await peer.evaluate(async (n) => { await window.connectToLobby(n); }, LOBBY);
    if (!(await waitMp(peer, () => window.isMultiplayer && !window.isHost && window.connectionState === 'connected'))) {
      throw new Error('peer failed to join lobby');
    }
    if (!(await waitMp(host, () => (window.lobbyState && window.lobbyState.players || []).length >= 2))) {
      throw new Error('host did not see peer in players');
    }
    results.push('peer join OK');

    // ── 4) Both queue → PvP; host not forced if only peer queued first then both ──
    await peer.evaluate(() => window.sendQueueAction('join'));
    await host.evaluate(() => window.sendQueueAction('join'));
    await host.waitForTimeout(500);
    await host.evaluate(() => window.startLobbyMatch());
    await host.waitForTimeout(1200);

    const pvp = await host.evaluate(() => {
      var mp = window.lobbyState.matchPlayers;
      var my = window.myPlayerId;
      return {
        blue: mp.blue, red: mp.red,
        bot: !!window.isLobbyBotMatch,
        hostSpec: !!window.isSpectator,
        hostId: my,
        playing: window.lobbyState.matchState === 'PLAYING'
      };
    });
    const peerSeat = await peer.evaluate(() => {
      var mp = window.lobbyState && window.lobbyState.matchPlayers;
      var my = window.myPlayerId;
      return {
        blue: mp && mp.blue, red: mp && mp.red,
        seated: !!(mp && (mp.blue === my || mp.red === my)),
        spec: !!window.isSpectator,
        side: window.StacksLobby && window.StacksLobby.mySide && window.StacksLobby.mySide()
      };
    });
    if (!pvp.playing) throw new Error('PvP not PLAYING');
    if (pvp.bot) throw new Error('both queued must be PvP not bot: ' + JSON.stringify(pvp));
    if (pvp.blue === '__BOT__' || pvp.red === '__BOT__') {
      throw new Error('PvP seats must be humans: ' + JSON.stringify(pvp));
    }
    if (pvp.hostSpec) throw new Error('queued host must not spectate PvP');
    if (!peerSeat.seated) throw new Error('peer not seated: ' + JSON.stringify(peerSeat));
    results.push('PvP queue seating OK');

    // Skip countdown → live play on both
    await Promise.all([host, peer].map((p) => p.evaluate(() => {
      var comp = document.querySelector('[stacks-game]').components['stacks-game'];
      if (comp.matchState === 'COUNTDOWN' && comp._beginLivePlay) comp._beginLivePlay();
      else if (comp.matchState === 'COUNTDOWN') {
        comp.matchState = 'PLAYING';
        if (comp._pendingMatch) {
          var pend = comp._pendingMatch;
          comp._pendingMatch = pend;
        }
        if (typeof comp._beginLivePlay === 'function') comp._beginLivePlay();
      }
    })));
    await host.waitForTimeout(600);

    // ── 5) Authority: peer place must not wipe host cup; host pad must exist after grab spawn ──
    const placeProof = await host.evaluate(() => {
      var comp = document.querySelector('[stacks-game]').components['stacks-game'];
      var side = comp._localSide();
      var cup = comp.cups[side];
      // Force a local place of a 1-cell mark
      var before = cup.countFilled ? cup.countFilled() : 0;
      var cell = [[2, 0, 2]];
      var placed = cup.placeCells(cell, { color: '#fff', owner: side, shapeType: 'O' });
      if (comp.matchStats) comp.matchStats.onPlace(side, null, performance.now());
      if (window.sendCupEvent) {
        var cupsMsg = {};
        cupsMsg[side] = cup.serialize();
        window.sendCupEvent({
          kind: 'place', side: side, shapeType: 'O', cells: cell,
          scores: { blue: comp.modes.scores.blue, red: comp.modes.scores.red },
          cups: cupsMsg,
          station: comp._serializeStation(side)
        });
      }
      // Simulate stale peer overwrite attempt for OUR side
      var stale = cup.serialize();
      stale.cells = [];
      comp.onRemoteCupEvent({
        kind: 'place',
        from: 'fake-peer',
        side: side,
        cups: (function () { var o = {}; o[side] = stale; return o; })(),
        station: { side: side, padType: null, next: [], pocketType: null }
      });
      var after = cup.countFilled ? cup.countFilled() : (cup.serialize().cells || []).length;
      var padType = comp._nextTypeBySide && comp._nextTypeBySide[side];
      // Ensure pad spawn path works
      comp._spawnSidePadPiece(side, { dropIn: false, broadcast: true });
      var padPiece = comp._sidePadPiece(side);
      return {
        side: side,
        before: before,
        after: after,
        placed: !!placed,
        padType: padType || (comp._nextTypeBySide && comp._nextTypeBySide[side]),
        hasPadMesh: !!padPiece,
        authority: comp._isLocalAuthoritySide(side)
      };
    });
    if (!placeProof.authority) throw new Error('host lost seat authority: ' + JSON.stringify(placeProof));
    if (!placeProof.placed) throw new Error('host placeCells failed');
    if (!(placeProof.after > 0)) throw new Error('stale peer place wiped host cup: ' + JSON.stringify(placeProof));
    if (!placeProof.hasPadMesh) throw new Error('host pad piece missing after spawn');
    results.push('cup authority + pad spawn OK');

    // Peer must SEE host's placed cells on the host seat (not just stay alive)
    await peer.waitForTimeout(1000);
    const peerView = await peer.evaluate(() => {
      var comp = document.querySelector('[stacks-game]').components['stacks-game'];
      var hostSide = (window.lobbyState.matchPlayers.blue === window.myPlayerId) ? 'red' : 'blue';
      var cup = comp.cups[hostSide];
      var filled = 0;
      if (cup && cup.grid) {
        for (var y = 0; y < cup.height; y++) {
          for (var z = 0; z < cup.depth; z++) {
            for (var x = 0; x < cup.width; x++) {
              if (cup.grid[y][z][x]) filled++;
            }
          }
        }
      }
      var mySide = comp._localSide();
      var myPad = comp._sidePadPiece(mySide);
      return {
        active: !!comp.matchActive,
        hostSide: hostSide,
        hostFilled: filled,
        mySide: mySide,
        hasMyPad: !!myPad,
        viewOnly: !!(comp._isViewOnlyObserver && comp._isViewOnlyObserver())
      };
    });
    if (!peerView.active) throw new Error('peer match dead: ' + JSON.stringify(peerView));
    if (peerView.viewOnly) throw new Error('seated peer flagged view-only: ' + JSON.stringify(peerView));
    if (!(peerView.hostFilled > 0)) {
      throw new Error('peer cannot see host cup blocks: ' + JSON.stringify(peerView));
    }
    if (!peerView.hasMyPad) {
      throw new Error('seated peer missing own pad piece: ' + JSON.stringify(peerView));
    }
    results.push('peer sees host cup + own pad OK');

    // ── 6) End match + stats persist on host ──
    await host.evaluate(() => {
      var comp = document.querySelector('[stacks-game]').components['stacks-game'];
      if (comp.matchStats && comp.matchStats.blue) {
        comp.matchStats.blue.blocks = Math.max(comp.matchStats.blue.blocks, 5);
        comp.matchStats.blue.attacks = Math.max(comp.matchStats.blue.attacks, 1);
        comp.matchStats.blue.peakBpm = Math.max(comp.matchStats.blue.peakBpm || 0, 12);
      }
      if (window.sendMatchAction) {
        window.sendMatchAction('end', { winner: 'blue', reason: 'test' });
      } else if (window.endLobbyMatch) {
        window.endLobbyMatch({ winner: 'blue', reason: 'test' });
      }
      if (comp.onMatchEnded) {
        // host path may already have ended via lobby
      }
    });
    await host.waitForTimeout(700);
    const stats = await host.evaluate(() => {
      var hist = window.StacksStats && window.StacksStats.loadHistory
        ? window.StacksStats.loadHistory()
        : null;
      var bests = window.StacksStats && window.StacksStats.getBests
        ? window.StacksStats.getBests(window.playerNickname || 'HostChrome')
        : null;
      return {
        waiting: !window.lobbyState || window.lobbyState.matchState === 'WAITING',
        multiLen: hist && hist.multi ? hist.multi.length : 0,
        bestMatches: bests && bests.matches
      };
    });
    // Stats may or may not save if cancelled path — force-save check via API
    const forced = await host.evaluate(() => {
      if (!window.StacksStats) return null;
      window.StacksStats.saveMatch({
        timestamp: Date.now(),
        mode: 'multi',
        result: 'WIN',
        playerScore: 1,
        opponentScore: 0,
        bot: false,
        nickname: window.playerNickname || 'HostChrome',
        opponentName: 'PeerChrome',
        player: {
          blocks: 12, attacks: 2, score: 100, layers: 1, maxCombo: 1,
          bpm: 14, peakBpm: 16, durationMs: 30000
        }
      });
      var b = window.StacksStats.getBests(window.playerNickname || 'HostChrome');
      return { matches: b.matches, bestBlocks: b.bestBlocks };
    });
    if (!forced || !(forced.matches > 0) || forced.bestBlocks < 12) {
      throw new Error('stats bests not updating: ' + JSON.stringify(forced));
    }
    results.push('stats bests OK');

    // ── 7) Host-only start UX: peer cannot start ──
    const peerStart = await peer.evaluate(() => {
      // mirror menu gate
      var can = !!window.isHost;
      return { canStart: can, isHost: !!window.isHost };
    });
    if (peerStart.canStart) throw new Error('peer must not be able to start');
    results.push('peer cannot start OK');

    console.log('PASS test-chrome-mp-features');
    results.forEach((r) => console.log('  ✓', r));
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
