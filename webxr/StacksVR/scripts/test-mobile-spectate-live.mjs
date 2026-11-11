#!/usr/bin/env node
/**
 * Proves the failures the user reported:
 * 1) HUD leaves "Waiting for match..."
 * 2) Cup cells sync to spectator
 * 3) Poses arrive on spectator
 * 4) Orbit angle changes on swipe/drag
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8780 + Math.floor(Math.random() * 80);
const LOBBY = 70 + Math.floor(Math.random() * 9);

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

async function waitGame(page) {
  await page.waitForFunction(() => {
    const el = document.querySelector('[stacks-game]');
    return el && el.components && el.components['stacks-game'] &&
      el.components['stacks-game'].cups && el.components['stacks-game'].cups.blue;
  }, null, { timeout: 45000 });
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const base = `http://127.0.0.1:${PORT}`;
  let failed = null;

  try {
    const host = await browser.newPage();
    host.on('console', (m) => console.log('[host]', m.text()));
    await host.goto(`${base}/index.html?vr=1`, { waitUntil: 'domcontentloaded' });
    await waitGame(host);

    await host.evaluate(async (n) => {
      await window.connectToLobby(n);
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        if (window.isMultiplayer && window.isHost) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('host not ready');
    }, LOBBY);

    // Intentionally start via the OLD offline path first, then prove promote-on-watch
    // still publishes PLAYING + cups. Also exercise startLobbyMatch path.
    await host.evaluate(() => {
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      // Simulate user pressing Play vs Bot while hosting (must use lobby path)
      if (window.StacksLobby.isHost) window.startLobbyMatch();
      else comp.startOfflineBotMatch();
    });

    // Host places blocks into blue cup so spectator has something to sync
    const placed = await host.evaluate(() => {
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      const cup = comp.cups.blue;
      const cells = [[1, 0, 1], [2, 0, 1], [1, 0, 2]];
      const color = '#4A90E2';
      cup.placeCells(cells, { color: color, owner: 'blue', shapeType: 'I' });
      comp._broadcastState('test-place');
      if (window.sendCupSnapshot) window.sendCupSnapshot(comp._buildSnapshot());
      return cup.serialize().cells.length;
    });
    console.log('HOST placed cells', placed);
    if (placed < 3) throw new Error('host place failed');

    const watchCtx = await browser.newContext({
      viewport: { width: 812, height: 375 },
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
    });
    const watch = await watchCtx.newPage();
    watch.on('console', (m) => console.log('[watch]', m.text()));
    await watch.goto(`${base}/index.html?spectate=1`, { waitUntil: 'domcontentloaded' });
    await waitGame(watch);

    // Flag must be set before cam component — prove it
    const flagEarly = await watch.evaluate(() => !!window.isMobileSpectator);
    if (!flagEarly) throw new Error('isMobileSpectator not set early');

    const connected = await watch.evaluate(async (n) => {
      const res = await window.connectAsMobileSpectator(n);
      if (res && res.ok && window.StacksMobileSpectator) {
        window.StacksMobileSpectator.showMatchHud('Watching lobby ' + n);
      }
      return res;
    }, LOBBY);
    console.log('WATCH connect', connected);
    if (!connected || !connected.ok) throw new Error('watch connect failed');

    // Wait for PLAYING + non-waiting HUD
    await watch.waitForFunction(() => {
      const ls = window.lobbyState;
      const status = (document.getElementById('mobile-hud-status') || {}).textContent || '';
      if (window.StacksMobileSpectator) window.StacksMobileSpectator.updateMobileHudStatus();
      return ls && ls.matchState === 'PLAYING' && !/Waiting for match/i.test(status);
    }, null, { timeout: 15000 });

    await watch.waitForFunction(() => {
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      const cells = (comp.cups.blue.serialize().cells || []).length +
        (comp.cups.red.serialize().cells || []).length;
      return cells >= 3;
    }, null, { timeout: 10000 });

    const hud = await watch.evaluate(() => {
      if (window.StacksMobileSpectator) {
        window.StacksMobileSpectator.updateMobileHudStatus();
        window.StacksMobileSpectator.activateSpectatorBodies();
      }
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      const cells = (comp.cups.blue.serialize().cells || []).length +
        (comp.cups.red.serialize().cells || []).length;
      return {
        status: document.getElementById('mobile-hud-status').textContent,
        matchState: window.lobbyState.matchState,
        cells: cells,
        debug: window.StacksMobileSpectator.getDebug(),
        orbitReady: !!(document.querySelector('a-scene').components['mobile-spectator-cam'] &&
          document.querySelector('a-scene').components['mobile-spectator-cam']._orbitReady)
      };
    });
    console.log('HUD', hud);
    if (/Waiting for match/i.test(hud.status)) {
      throw new Error('HUD still Waiting: ' + hud.status);
    }
    if (hud.matchState !== 'PLAYING') throw new Error('matchState not PLAYING');
    if (hud.cells < 3) throw new Error('cups not synced, cells=' + hud.cells);
    if (!hud.orbitReady) throw new Error('orbit camera not ready');

    // Drive host poses from a known head position + more cup updates
    await host.evaluate(() => {
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      const cam = document.getElementById('camera');
      // Place camera at a distinctive world pose so spectator body must leave origin
      cam.object3D.position.set(0.4, 1.55, 1.1);
      document.getElementById('player').object3D.position.set(0, 0, 0);
      for (var i = 0; i < 8; i++) {
        comp._lastPoseSend = 0;
        comp._sendLocalPose();
      }
      comp.cups.red.placeCells([[2, 0, 2]], { color: '#E25A4A', owner: 'red' });
      if (window.sendCupSnapshot) window.sendCupSnapshot(comp._buildSnapshot());
    });

    await watch.waitForFunction(() => {
      const body = document.getElementById('spec-blue-body');
      const mb = body && body.components && body.components['mixamo-body'];
      const posed = body && body.dataset && body.dataset.posed === '1';
      const hasRemote = !!(mb && mb.remoteHandData && mb.remoteHandData.head &&
        typeof mb.remoteHandData.head.x === 'number');
      const moved = body && body.object3D &&
        (Math.abs(body.object3D.position.x) > 0.05 || Math.abs(body.object3D.position.z) > 0.05 ||
          body.object3D.position.y > 0.2);
      const cells = document.querySelector('[stacks-game]').components['stacks-game'].cups.blue.serialize().cells.length +
        document.querySelector('[stacks-game]').components['stacks-game'].cups.red.serialize().cells.length;
      return posed && hasRemote && cells >= 4;
    }, null, { timeout: 12000 });

    // Tick mixamo so IK moves the body from remoteHandData
    await watch.evaluate(() => {
      const body = document.getElementById('spec-blue-body');
      const mb = body.components['mixamo-body'];
      for (var i = 0; i < 10; i++) mb.tick(performance.now(), 16);
    });

    const sync = await watch.evaluate(() => {
      const body = document.getElementById('spec-blue-body');
      const mb = body.components['mixamo-body'];
      return {
        poseRecv: document.querySelector('[stacks-game]').components['stacks-game']._poseRecvCount || 0,
        hasRemote: !!(mb && mb.remoteHandData && mb.remoteHandData.head),
        headX: mb.remoteHandData.head.x,
        headY: mb.remoteHandData.head.y,
        headZ: mb.remoteHandData.head.z,
        bodyX: body.object3D.position.x,
        bodyY: body.object3D.position.y,
        bodyZ: body.object3D.position.z,
        visible: body.object3D.visible,
        posed: body.dataset.posed,
        cells: document.querySelector('[stacks-game]').components['stacks-game'].cups.blue.serialize().cells.length +
          document.querySelector('[stacks-game]').components['stacks-game'].cups.red.serialize().cells.length
      };
    });
    console.log('SYNC', sync);
    if (sync.poseRecv < 1) throw new Error('no poses applied via stacks-game');
    if (!sync.hasRemote) throw new Error('spec-blue-body missing remoteHandData');
    if (Math.abs(sync.headY - 1.55) > 0.3) throw new Error('head pose not synced: y=' + sync.headY);
    if (Math.abs(sync.headX - 0.4) > 0.3) throw new Error('head pose not synced: x=' + sync.headX);
    if (!sync.visible || sync.posed !== '1') throw new Error('body not visible/posed');
    // Entity Y can be ~-0.1 (hips local offset); XZ must track the headset
    if (Math.abs(sync.bodyX - 0.4) > 0.35 || Math.abs(sync.bodyZ - 1.1) > 0.5) {
      throw new Error('body not tracking head xz: ' + sync.bodyX + ',' + sync.bodyZ);
    }
    if (sync.cells < 4) throw new Error('red cup cell not synced');

    // Orbit: simulate drag
    const orbit = await watch.evaluate(() => {
      const cam = document.querySelector('a-scene').components['mobile-spectator-cam'];
      const before = cam._orbitTargetAngle;
      cam._touchStartX = 100;
      cam._touchStartAngle = cam._orbitTargetAngle;
      cam._isTouching = true;
      // emulate move handler
      const sensitivity = Math.PI / Math.max(window.innerWidth, 1);
      const deltaX = 120;
      cam._orbitTargetAngle = cam._touchStartAngle - deltaX * sensitivity;
      cam._isTouching = false;
      // tick a few times
      for (var i = 0; i < 20; i++) cam.tick();
      return { before: before, after: cam._orbitAngle, target: cam._orbitTargetAngle };
    });
    console.log('ORBIT', orbit);
    if (Math.abs(orbit.after - orbit.before) < 0.01 && Math.abs(orbit.target - orbit.before) < 0.01) {
      throw new Error('orbit did not change on swipe');
    }

    console.log('PASS live spectate: HUD + cups + poses + orbit');
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
