#!/usr/bin/env node
/** Dump every kit-related console line and error for one rocksfile, to find why it is rejected. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8975;
const FILE = process.env.FILE || 'scifi-rts-rocks-tenth';
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

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e)}`));
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => {
  if (r.url().includes('.glb')) logs.push(`[http ${r.status()}] ${r.url().split('/').pop()}`);
});

const QUERY = process.env.QUERY || `&leanrocks=1&rocksfile=${FILE}`;
await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1${QUERY}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
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
await page.waitForTimeout(3000);

console.log(`=== ${FILE} ===`);
for (const l of logs) {
  if (/kit|rock|glb|error|fail|warn|reject|skip|invalid|GLTF/i.test(l)) console.log('  ' + l.slice(0, 400));
}

await browser.close();
server.close();
process.exit(0);
