#!/usr/bin/env node
/** Prove bot uses pad/pocket and can clear layers (not random teleport). */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8790 + Math.floor(Math.random() * 50);

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
    page.on('console', (m) => console.log('[page]', m.text()));
    await page.goto(`http://127.0.0.1:${PORT}/index.html?vr=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const el = document.querySelector('[stacks-game]');
      return el && el.components && el.components['stacks-game'] && el.components['stacks-game'].bot;
    }, null, { timeout: 45000 });

    const start = await page.evaluate(() => {
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      comp.startOfflineBotMatch();
      return {
        botOn: !!(comp.bot && comp.bot.enabled),
        padVis: !!(comp._botPad && comp._botPad.visible),
        pocketVis: !!(comp._botPocket && comp._botPocket.visible),
        padPiece: !!comp._botPadPiece
      };
    });
    console.log('START', start);
    if (!start.botOn) throw new Error('bot not enabled');
    if (!start.padVis || !start.pocketVis) throw new Error('bot pad/pocket not visible');
    if (!start.padPiece) throw new Error('bot pad piece missing');

    // Let bot play for a while
    await page.waitForTimeout(16000);

    const stats = await page.evaluate(() => {
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      const redCells = comp.cups.red.serialize().cells.length;
      const blueCells = comp.cups.blue.serialize().cells.length;
      return {
        redCells: redCells,
        blueCells: blueCells,
        redScore: comp.modes.scores.red,
        blueScore: comp.modes.scores.blue,
        redLayers: comp.modes.layersCleared.red,
        padVis: !!(comp._botPad && comp._botPad.visible),
        held: !!(comp._botHoldMesh || (comp.bot && comp.bot.state === 'animating')),
        current: comp.bot && comp.bot.currentType,
        pocket: comp.bot && comp.bot.pocketType
      };
    });
    console.log('STATS', stats);
    if (stats.redCells < 8) throw new Error('bot barely placed anything: ' + stats.redCells);
    // With clear-focused AI, expect at least one clear within ~16s of play
    if (stats.redLayers < 1 && stats.redScore < 100) {
      throw new Error('bot never cleared a layer (score=' + stats.redScore + ' layers=' + stats.redLayers + ')');
    }
    console.log('PASS bot plays with visible pad/pocket and clears');
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
