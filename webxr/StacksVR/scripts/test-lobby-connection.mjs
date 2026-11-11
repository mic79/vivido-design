#!/usr/bin/env node
/**
 * Absolute confirmation: host lobby + mobile spectator can open a PeerJS data channel
 * and exchange lobby-state (same path StacksVR uses in production).
 *
 * Usage: node scripts/test-lobby-connection.mjs
 * Requires network (0.peerjs.com + TURN proxy).
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8765 + Math.floor(Math.random() * 100);
const LOBBY = 90 + Math.floor(Math.random() * 9); // 90-98 avoid colliding with human lobby 1

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json'
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/scripts/lobby-harness.html';
      const filePath = path.join(ROOT, urlPath.replace(/^\//, ''));
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function waitReady(page) {
  await page.waitForFunction(() => window.__HARNESS_READY__ === true, null, { timeout: 15000 });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const base = `http://127.0.0.1:${PORT}/scripts/lobby-harness.html`;
  let failed = null;

  try {
    const hostCtx = await browser.newContext();
    const watchCtx = await browser.newContext();
    const hostPage = await hostCtx.newPage();
    const watchPage = await watchCtx.newPage();
    hostPage.on('console', (m) => console.log('[host]', m.text()));
    watchPage.on('console', (m) => console.log('[watch]', m.text()));

    await Promise.all([hostPage.goto(base), watchPage.goto(base)]);
    await Promise.all([waitReady(hostPage), waitReady(watchPage)]);

    console.log('TEST lobby', LOBBY);
    const iceProbe = await hostPage.evaluate(async () => window.__lobbyTest.probeIce());
    console.log('ICE', iceProbe);
    if (!iceProbe.hasTurn) {
      throw new Error('ice-servers.json missing TURN — Quest↔mobile will fail NAT');
    }

    const hostStatus = await hostPage.evaluate(async (n) => window.__lobbyTest.host(n), LOBBY);
    console.log('HOST', hostStatus);
    if (!hostStatus.isHost || !hostStatus.isMultiplayer) {
      throw new Error('Host did not enter HOSTING state: ' + JSON.stringify(hostStatus));
    }
    const iceSource = await hostPage.evaluate(() => (window.StacksLobby && window.StacksLobby._iceSource) || null);
    console.log('ICE source used by host:', iceSource);
    if (!iceSource) {
      throw new Error('Host did not load TURN ice-servers.json (NAT spectate will fail on device)');
    }

    const watchStatus = await watchPage.evaluate(async (n) => window.__lobbyTest.watch(n), LOBBY);
    console.log('WATCH', watchStatus);
    if (!watchStatus.isMultiplayer || !watchStatus.isMobileSpectator) {
      throw new Error('Spectator did not connect: ' + JSON.stringify(watchStatus));
    }

    // Host should see at least itself; after hello, spectator registered
    await hostPage.waitForTimeout(1500);
    const hostAfter = await hostPage.evaluate(() => window.__lobbyTest.status());
    console.log('HOST after watch', hostAfter);
    if (hostAfter.players < 1) {
      throw new Error('Host lobbyState missing players');
    }

    // Host starts match — spectator MUST flip to PLAYING (this was the stuck-WAITING bug)
    const hostStart = await hostPage.evaluate(() => window.__lobbyTest.startMatch());
    console.log('HOST startMatch', hostStart);
    if (hostStart.matchState !== 'PLAYING' || !hostStart.matchBlue || !hostStart.matchRed) {
      throw new Error('Host match did not enter PLAYING: ' + JSON.stringify(hostStart));
    }

    await watchPage.waitForFunction(() => {
      return window.lobbyState &&
        window.lobbyState.matchState === 'PLAYING' &&
        window.lobbyState.matchPlayers &&
        window.lobbyState.matchPlayers.blue &&
        window.lobbyState.matchPlayers.red;
    }, null, { timeout: 10000 });

    const watchPlaying = await watchPage.evaluate(() => window.__lobbyTest.status());
    console.log('WATCH during match', watchPlaying);
    if (watchPlaying.matchState !== 'PLAYING') {
      throw new Error('Spectator stuck WAITING during match: ' + JSON.stringify(watchPlaying));
    }
    if (!watchPlaying.matchBlue || !watchPlaying.matchRed) {
      throw new Error('Spectator missing matchPlayers during match: ' + JSON.stringify(watchPlaying));
    }

    // Late-join path: second spectator connects while match already PLAYING
    const lateCtx = await browser.newContext();
    const latePage = await lateCtx.newPage();
    latePage.on('console', (m) => console.log('[late]', m.text()));
    await latePage.goto(base);
    await waitReady(latePage);
    const lateWatch = await latePage.evaluate(async (n) => window.__lobbyTest.watch(n), LOBBY);
    console.log('LATE watch connect', lateWatch);
    await latePage.waitForFunction(() => {
      return window.lobbyState && window.lobbyState.matchState === 'PLAYING' &&
        window.lobbyState.matchPlayers && window.lobbyState.matchPlayers.blue;
    }, null, { timeout: 10000 });
    const latePlaying = await latePage.evaluate(() => window.__lobbyTest.status());
    console.log('LATE during match', latePlaying);
    if (latePlaying.matchState !== 'PLAYING') {
      throw new Error('Late spectator stuck WAITING: ' + JSON.stringify(latePlaying));
    }
    await latePage.evaluate(() => window.__lobbyTest.leave());
    await lateCtx.close();

    await watchPage.evaluate(() => window.__lobbyTest.leave());
    await hostPage.evaluate(() => window.__lobbyTest.leave());
    console.log('PASS host↔mobile spectator PeerJS lobby + match-started PLAYING');
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
