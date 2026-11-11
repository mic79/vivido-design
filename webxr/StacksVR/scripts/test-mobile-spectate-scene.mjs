#!/usr/bin/env node
/**
 * Headless check: mobile spectate shell shows playfields (cup meshes) and
 * flips HUD off "Waiting for match..." once a lobby match is PLAYING.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8770 + Math.floor(Math.random() * 80);
const LOBBY = 80 + Math.floor(Math.random() * 9);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.fbx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm'
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
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

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const base = `http://127.0.0.1:${PORT}`;
  let failed = null;

  try {
    // Host = full StacksVR page (VR path)
    const hostCtx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0'
    });
    const hostPage = await hostCtx.newPage();
    hostPage.on('console', (m) => console.log('[host]', m.text()));
    await hostPage.goto(`${base}/index.html?vr=1`, { waitUntil: 'domcontentloaded' });
    await hostPage.waitForFunction(() => {
      const el = document.querySelector('[stacks-game]');
      return el && el.components && el.components['stacks-game'] &&
        el.components['stacks-game'].cups && el.components['stacks-game'].cups.blue;
    }, null, { timeout: 30000 });

    // Start hosting lobby
    await hostPage.evaluate(async (n) => {
      await window.connectToLobby(n);
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        if (window.isMultiplayer && window.isHost) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('host not ready');
    }, LOBBY);
    console.log('HOST ready lobby', LOBBY);

    // Spectator = forced mobile spectate UA + ?spectate=1
    const watchCtx = await browser.newContext({
      viewport: { width: 812, height: 375 },
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
    });
    const watchPage = await watchCtx.newPage();
    watchPage.on('console', (m) => console.log('[watch]', m.text()));
    await watchPage.goto(`${base}/index.html?spectate=1`, { waitUntil: 'domcontentloaded' });

    await watchPage.waitForSelector('#mobile-spectator-overlay.active', { timeout: 15000 });
    await watchPage.waitForFunction(() => {
      const el = document.querySelector('[stacks-game]');
      return el && el.components && el.components['stacks-game'] &&
        el.components['stacks-game']._sceneRoot;
    }, null, { timeout: 30000 });

    // Cups must exist in the Three scene (playfields)
    const cupsOk = await watchPage.evaluate(() => {
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      const blue = comp.cups.blue;
      const red = comp.cups.red;
      return {
        hasBlue: !!(blue && blue.pivot),
        hasRed: !!(red && red.pivot),
        blueVisible: !!(blue && blue.pivot && blue.pivot.visible),
        redVisible: !!(red && red.pivot && red.pivot.visible),
        sceneVisible: !!(comp._sceneRoot && comp._sceneRoot.visible),
        childCount: comp._sceneRoot ? comp._sceneRoot.children.length : 0
      };
    });
    console.log('CUPS before watch', cupsOk);
    if (!cupsOk.hasBlue || !cupsOk.hasRed || cupsOk.childCount < 2) {
      throw new Error('Playfields missing in spectator scene: ' + JSON.stringify(cupsOk));
    }

    // Click WATCH
    await watchPage.evaluate((n) => {
      window._testLobbyNum = n;
      const num = document.getElementById('mobile-lobby-num');
      if (num) num.textContent = String(n);
    }, LOBBY);
    // Set lobby number via buttons if needed
    await watchPage.evaluate((n) => {
      // Patch internal lobby num by clicking +/- is hard; call connect directly after UI show
      const btn = document.getElementById('mobile-watch-btn');
      // Force the module lobby num through a small hack: set text then trigger connectAsMobileSpectator
      return n;
    }, LOBBY);

    const watchRes = await watchPage.evaluate(async (n) => {
      // Bypass UI counter — call same path WATCH uses
      const res = await window.connectAsMobileSpectator(n);
      if (res && res.ok && window.StacksMobileSpectator) {
        window.StacksMobileSpectator.showMatchHud('Watching lobby ' + n);
        window.StacksMobileSpectator.updateMobileHudStatus();
      }
      return res;
    }, LOBBY);
    console.log('WATCH connect', watchRes);
    if (!watchRes || !watchRes.ok) throw new Error('watch failed ' + JSON.stringify(watchRes));

    await hostPage.waitForTimeout(800);

    // Host starts match (same as Start Match / Play vs Bot in lobby)
    await hostPage.evaluate(() => window.startLobbyMatch());

    await watchPage.waitForFunction(() => {
      return window.lobbyState && window.lobbyState.matchState === 'PLAYING' &&
        window.lobbyState.matchPlayers && window.lobbyState.matchPlayers.blue &&
        window.lobbyState.matchPlayers.red;
    }, null, { timeout: 10000 });

    // Force HUD refresh like the live interval
    const hud = await watchPage.evaluate(() => {
      if (window.StacksMobileSpectator) {
        window.StacksMobileSpectator.activateSpectatorBodies();
        window.StacksMobileSpectator.updateMobileHudNames();
        window.StacksMobileSpectator.updateMobileHudStatus();
        window.StacksMobileSpectator.updateMobileHudScores();
      }
      const status = (document.getElementById('mobile-hud-status') || {}).textContent || '';
      const lobbyScreen = document.getElementById('mobile-lobby-screen');
      const matchHud = document.getElementById('mobile-match-hud');
      const blueBody = document.getElementById('spec-blue-body');
      const redBody = document.getElementById('bot-body');
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      return {
        status: status,
        lobbyHidden: lobbyScreen && lobbyScreen.style.display === 'none',
        matchHudActive: matchHud && matchHud.classList.contains('active'),
        matchState: window.lobbyState.matchState,
        matchBlue: window.lobbyState.matchPlayers.blue,
        matchRed: window.lobbyState.matchPlayers.red,
        blueBodyVisible: !!(blueBody && blueBody.object3D && blueBody.object3D.visible),
        redBodyVisible: !!(redBody && redBody.object3D && redBody.object3D.visible),
        sceneVisible: !!(comp._sceneRoot && comp._sceneRoot.visible),
        matchActive: !!comp.matchActive
      };
    });
    console.log('HUD during match', hud);

    if (hud.matchState !== 'PLAYING') {
      throw new Error('matchState not PLAYING');
    }
    if (/Waiting for match/i.test(hud.status)) {
      throw new Error('HUD still Waiting for match: ' + hud.status);
    }
    if (!hud.matchHudActive || !hud.lobbyHidden) {
      throw new Error('Match HUD not shown over scene');
    }
    if (!hud.sceneVisible) {
      throw new Error('stacks-arena scene root hidden');
    }
    if (!hud.matchActive) {
      throw new Error('stacks-game.matchActive false on spectator');
    }
    if (!hud.blueBodyVisible || !hud.redBodyVisible) {
      throw new Error('Player bodies not visible: ' + JSON.stringify(hud));
    }

    console.log('PASS mobile spectate scene cups + PLAYING HUD + bodies');
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
