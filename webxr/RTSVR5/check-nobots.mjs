#!/usr/bin/env node
/**
 * Proof that `?nobots=1` actually freezes the bot AI: runs a 1v1 for SECONDS_S of match time
 * with and without the flag and reports units/buildings per player. With the flag the bot
 * side must never grow past what it starts with.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8976;
const SECONDS_S = Number(process.env.SECONDS_S || 45);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream' };

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const f = path.normalize(path.join(ROOT, rel));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404);
    res.end('nf');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--ignore-gpu-blocklist', '--mute-audio'] });

for (const [label, q] of [
  ['bots on ', ''],
  ['nobot=1 ', '&nobot=1'],
]) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&leanrocks=1${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
  await page.evaluate(() => {
    if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    window._startGame('1v1');
  });
  await page.waitForFunction(
    () => {
      const o = document.getElementById('match-prepare-overlay');
      return !(o && !o.hidden);
    },
    null,
    { timeout: 300000 }
  );
  await page.waitForTimeout(SECONDS_S * 1000);

  const st = await page.evaluate(async () => {
    const S = await import('./js/state.js');
    const perPlayer = S.players.map((p) => ({
      id: p.id,
      isBot: !!p.isBot,
      units: (S.unitsByPlayer.get(p.id) || new Set()).size,
      buildings: (S.buildingsByPlayer.get(p.id) || new Set()).size,
      credits: Math.round(p.credits || 0),
    }));
    return { elapsed: Math.round(S.gameSession.elapsedTime), perPlayer, totalUnits: S.units.size };
  });
  console.log(`${label}  match elapsed ${st.elapsed}s   total units ${st.totalUnits}`);
  for (const p of st.perPlayer) {
    console.log(`    player ${p.id} ${p.isBot ? 'BOT  ' : 'human'}  units=${String(p.units).padStart(3)}  buildings=${String(p.buildings).padStart(2)}  credits=${p.credits}`);
  }
  await page.close();
}

await browser.close();
server.close();
process.exit(0);
