#!/usr/bin/env node
/**
 * Browser VERIFY:
 * 1) vs-bot starts in COUNTDOWN (no grab, no bot yet)
 * 2) after GO: pad piece exists, exactly one pad scrap (no overlap leftovers)
 * 3) End Match → WAITING → dual-bot idle resumes (even while "hosting" WAITING lobby)
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8820 + Math.floor(Math.random() * 40);
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

function countPadPieces(comp) {
  if (!comp._pad) return 0;
  var n = 0;
  for (var i = 0; i < comp._pad.children.length; i++) {
    var ud = comp._pad.children[i].userData || {};
    if (ud.padPiece || ud.padPreview || ud.botPadPiece || ud.spawning) n++;
  }
  return n;
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  let failed = null;
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const el = document.querySelector('[stacks-game]');
      return el && el.components && el.components['stacks-game'] && el.components['stacks-game'].bot;
    }, null, { timeout: 45000 });

    const phase1 = await page.evaluate(() => {
      function countPieces(pad) {
        if (!pad) return 0;
        var n = 0;
        for (var i = 0; i < pad.children.length; i++) {
          var ud = pad.children[i].userData || {};
          if (ud.padPiece || ud.padPreview || ud.botPadPiece || ud.spawning || ud.nextPreview) n++;
        }
        return n;
      }
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      // Seed dual-idle scraps that used to overlap the human pad
      if (typeof comp.startOfflinePreviewMatch === 'function') comp.startOfflinePreviewMatch();
      // Let blue bot drop a pad piece
      for (var t = 0; t < 30; t++) { if (comp.botBlue) comp.botBlue.tick(performance.now() + t * 200); }
      const scrapBefore = countPieces(comp._pad);
      comp.startOfflineBotMatch();
      return {
        scrapBefore: scrapBefore,
        state: comp.matchState,
        modesOn: !!(comp.modes && comp.modes.active),
        botOn: !!(comp.bot && comp.bot.enabled),
        dual: !!comp._dualBotPreview,
        banner: !!(comp._matchBanner && comp._matchBanner.mesh),
        padPieces: countPieces(comp._pad)
      };
    });
    console.log('COUNTDOWN', phase1);
    if (phase1.state !== 'COUNTDOWN') throw new Error('expected COUNTDOWN, got ' + phase1.state);
    if (phase1.modesOn) throw new Error('modes must stay off during countdown');
    if (phase1.botOn) throw new Error('bot must stay off during countdown');
    if (phase1.dual) throw new Error('dual preview must end on vs-bot start');
    if (!phase1.banner) throw new Error('countdown banner missing');
    if (phase1.padPieces !== 0) throw new Error('pad pieces must be cleared during countdown, n=' + phase1.padPieces);

    const phase2 = await page.evaluate(() => {
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      comp._beginLivePlay();
      var padN = 0;
      if (comp._pad) {
        for (var i = 0; i < comp._pad.children.length; i++) {
          var ud = comp._pad.children[i].userData || {};
          if (ud.padPiece || ud.padPreview || ud.botPadPiece || ud.spawning) padN++;
        }
      }
      return {
        state: comp.matchState,
        modesOn: !!(comp.modes && comp.modes.active),
        botOn: !!(comp.bot && comp.bot.enabled),
        padPiece: !!comp._padPiece,
        padN: padN,
        nextType: !!comp._nextType
      };
    });
    console.log('GO', phase2);
    if (phase2.state !== 'PLAYING') throw new Error('expected PLAYING after GO');
    if (!phase2.modesOn || !phase2.botOn) throw new Error('modes/bot must be live after GO');
    if (!phase2.padPiece || !phase2.nextType) throw new Error('human pad piece missing after GO');
    if (phase2.padN !== 1) throw new Error('expected exactly 1 pad piece, got ' + phase2.padN);

    // End match while simulating host WAITING lobby (isMultiplayer true must NOT block dual idle)
    const phase3 = await page.evaluate(async () => {
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      window.isMultiplayer = true;
      window.lobbyState = { matchState: 'WAITING', matchPlayers: { blue: null, red: null }, queue: [] };
      if (window.StacksLobby) window.StacksLobby.isHost = true;
      comp.endMatch();
      // Wait for scheduled dual idle (~350ms)
      await new Promise((r) => setTimeout(r, 700));
      return {
        matchActive: !!comp.matchActive,
        dual: !!comp._dualBotPreview,
        redOn: !!(comp.bot && comp.bot.enabled),
        blueOn: !!(comp.botBlue && comp.botBlue.enabled),
        endingStuck: !!comp._endingMatch,
        lobby: window.lobbyState && window.lobbyState.matchState
      };
    });
    console.log('END→DUAL', phase3);
    if (phase3.endingStuck) throw new Error('_endingMatch stuck true');
    if (!phase3.dual || !phase3.matchActive) throw new Error('dual idle did not resume after End Match');
    if (!phase3.redOn || !phase3.blueOn) throw new Error('both bots must run in dual idle');

    console.log('PASS countdown + clean pad + end→dual-idle');
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
