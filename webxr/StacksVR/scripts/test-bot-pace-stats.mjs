#!/usr/bin/env node
/** Prove match stats + adaptive bot pace (not fixed frequency). */
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
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const el = document.querySelector('[stacks-game]');
      return el && el.components && el.components['stacks-game'] &&
        el.components['stacks-game'].matchStats && el.components['stacks-game'].bot;
    }, null, { timeout: 45000 });

    const out = await page.evaluate(async () => {
      const comp = document.querySelector('[stacks-game]').components['stacks-game'];
      comp.startOfflineBotMatch();
      // Skip 3-2-1-GO so matchStats aren't wiped mid-test by _beginLivePlay
      if (comp.matchState === 'COUNTDOWN' && typeof comp._beginLivePlay === 'function') {
        comp._beginLivePlay();
      }

      // Direct PPM targets (avoids synthetic timestamp / wall-clock skew)
      comp.bot._paceMul = 1;
      comp.bot._paceTargetMul = 1;
      comp.bot.setTargetPpm(28, performance.now());
      const thinkFast = comp.bot.thinkIntervalMs;
      const animFast = comp.bot.placeAnimMs;

      comp.bot._paceMul = 1;
      comp.bot._paceTargetMul = 1;
      comp.bot.setTargetPpm(8, performance.now());
      const thinkSlow = comp.bot.thinkIntervalMs;

      // Jitter: snap mul to extremes so spread is obvious
      const samples = [];
      for (let i = 0; i < 20; i++) {
        comp.bot._nextPaceJitterAt = 0;
        comp.bot._paceMul = i % 2 === 0 ? 0.72 : 1.28;
        comp.bot._paceTargetMul = comp.bot._paceMul;
        comp.bot._applyPaceMul(performance.now());
        samples.push(comp.bot.thinkIntervalMs);
      }
      const minT = Math.min.apply(null, samples);
      const maxT = Math.max.apply(null, samples);

      // Wire path: real places → rolling PPM drives bot
      comp.matchStats.blue.start(performance.now());
      for (let i = 0; i < 5; i++) {
        comp.matchStats.onPlace('blue', { layersCleared: 0 }, performance.now());
        await new Promise((r) => setTimeout(r, 400));
      }
      comp._updateBotPace();
      const drivenThink = comp.bot.thinkIntervalMs;
      const drivenPpm = comp.matchStats.blue.ppmRolling(performance.now());

      // Dual preview accumulates stats
      comp.startOfflinePreviewMatch();
      await new Promise((r) => setTimeout(r, 8000));
      const bluePcs = comp.matchStats.blue.blocks;
      const redPcs = comp.matchStats.red.blocks;
      // Record an attack and prove HUD labels match BattleBlocks screenshot
      comp.matchStats.onAttack('blue', 3, performance.now());
      comp._updateCupStatsHUD();
      function txt(id) {
        var el = document.getElementById(id);
        if (!el) return '';
        if (el.getAttribute('value') != null) return String(el.getAttribute('value'));
        var t = el.getAttribute('text');
        return (t && t.value) ? String(t.value) : '';
      }
      const cardTime = txt('hud-time-blue');
      const cardAtk = txt('hud-atk-blue');
      const cardBlk = txt('hud-blk-blue');
      const cupScore = txt('hud-score-blue');
      const cupBps = txt('hud-bps-blue');
      const cupAtk = txt('hud-cup-atk-blue');
      const cardHasBps = !!(document.getElementById('hud-bps-blue') &&
        document.getElementById('hud-card-blue') &&
        document.getElementById('hud-card-blue').contains(document.getElementById('hud-bps-blue')));

      return {
        thinkFast: thinkFast,
        thinkSlow: thinkSlow,
        animFast: animFast,
        jitterSpread: maxT - minT,
        drivenThink: drivenThink,
        drivenPpm: drivenPpm,
        bluePcs: bluePcs,
        redPcs: redPcs,
        attacks: comp.matchStats.blue.attacks,
        hudHasTime: !!cardTime,
        hudHasBlocks: !!cardBlk,
        hudHasAttacks: !!cardAtk,
        cupHasBps: !!cupBps,
        cupHasScore: !!cupScore,
        cupHasAttacks: !!cupAtk,
        cardHasNoBps: !cardHasBps,
        cardTime: cardTime,
        cupBps: cupBps
      };
    });

    console.log('RESULT', out);
    if (!(out.thinkFast < out.thinkSlow * 0.75)) {
      throw new Error('bot should think faster at 28ppm than 8ppm');
    }
    if (out.jitterSpread < 50) throw new Error('expected pace variation, spread=' + out.jitterSpread);
    if (!(out.drivenPpm > 10)) throw new Error('player places should yield PPM');
    if (out.bluePcs < 2 || out.redPcs < 2) throw new Error('dual preview stats not counting pieces');
    if (out.attacks < 3) throw new Error('attacks not tracked');
    if (!out.hudHasTime || !out.hudHasBlocks || !out.hudHasAttacks) {
      throw new Error('floating card missing Time/Attacks/Blocks');
    }
    if (!out.cupHasBps || !out.cupHasScore || !out.cupHasAttacks) {
      throw new Error('cup panel missing Score/BPS/Attacks');
    }
    if (!out.cardHasNoBps) {
      throw new Error('floating card should not duplicate BPS');
    }
    console.log('PASS adaptive pace + BattleBlocks HUD stats');
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
