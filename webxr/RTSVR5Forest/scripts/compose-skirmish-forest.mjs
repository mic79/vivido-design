#!/usr/bin/env node
/**
 * Compose UE skirmish moon + forest Prop_* (drop rock/dirt), for bake-rock-shadows.
 * UE Python remote not required — same shippable GLB shape as export-skirmish-from-ue.
 *
 *   node RTSVR5Forest/scripts/compose-skirmish-forest.mjs
 *   WRITE_LIVE=1 node RTSVR5Forest/scripts/compose-skirmish-forest.mjs
 *
 * Then: GLB_PATH=... node scripts/bake-rock-shadows.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIRMISH = path.join(ROOT, 'assets', 'terrain', 'terrain-skirmish-1v1.glb');
const ROCKS_BAK = path.join(ROOT, 'assets', 'terrain', 'terrain-skirmish-1v1-rocks.bak.glb');
const OUT_COMPOSE = path.join(ROOT, 'assets', 'terrain', 'terrain-skirmish-1v1-forest-compose.glb');
const LIVE = SKIRMISH;
const WRITE_LIVE = process.env.WRITE_LIVE === '1';
const PORT = Number(process.env.PORT || 8796);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

if (!fs.existsSync(SKIRMISH)) throw new Error('missing ' + SKIRMISH);
if (!fs.existsSync(path.join(ROOT, 'assets/terrain/forest-trees-kit.glb'))) {
  throw new Error('missing forest-trees-kit.glb — run build-forest-trees-kit.mjs first');
}

// Keep one rocks-era backup so we can restore / A/B.
if (!fs.existsSync(ROCKS_BAK)) {
  fs.copyFileSync(SKIRMISH, ROCKS_BAK);
  console.log('backed up rocks skirmish →', ROCKS_BAK);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/scripts/compose-skirmish-forest-page.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
page.on('console', (msg) => console.log('page:', msg.type(), msg.text()));
page.on('pageerror', (err) => console.error('pageerror', err.message));

const pageUrl =
  `http://127.0.0.1:${PORT}/scripts/compose-skirmish-forest-page.html` +
  `?skirmish=${encodeURIComponent('../assets/terrain/terrain-skirmish-1v1.glb')}` +
  `&forest=${encodeURIComponent('../assets/terrain/forest-trees-kit.glb')}`;
await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(
  () => !!(window.__composeForestResult || window.__composeForestError),
  null,
  { timeout: 600000 }
);
const err = await page.evaluate(() => window.__composeForestError || null);
if (err) {
  await browser.close();
  server.close();
  throw new Error(err);
}
const result = await page.evaluate(() => window.__composeForestResult);
await browser.close();
server.close();

const buf = Buffer.from(result.b64, 'base64');
fs.writeFileSync(OUT_COMPOSE, buf);
console.log(
  JSON.stringify(
    {
      out: OUT_COMPOSE,
      bytes: buf.length,
      mb: +(buf.length / 1048576).toFixed(2),
      removed: result.removed,
      seated: result.seated,
    },
    null,
    2
  )
);

if (WRITE_LIVE) {
  fs.copyFileSync(OUT_COMPOSE, LIVE);
  console.log('WRITE_LIVE →', LIVE);
}
console.log('PASS compose-skirmish-forest');
console.log('Next: GLB_PATH="' + OUT_COMPOSE.replace(/\\/g, '/') + '" node scripts/bake-rock-shadows.mjs');
