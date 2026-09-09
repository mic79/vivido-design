#!/usr/bin/env node
/** Headless: does ?leanlook=1 cold-load the full kit and apply the lean look? */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8961;
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
for (const [label, q] of [
  ['?leanlook=1', '&leanlook=1'],
  ['plain full kit', ''],
]) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1${q}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
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
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => {
    const g = document.getElementById('ground');
    const m = g && g.getObject3D && g.getObject3D('mesh');
    return { kind: m && m.userData && m.userData.rtsKitKind, lean: !!(m && m.userData && m.userData.rtsLeanRocksVisual) };
  });
  const line = logs.find((l) => l.includes('leanrocks: rocks shaded')) || '(no lean log)';
  console.log(`${label.padEnd(16)} kit=${st.kind} lean=${st.lean}`);
  console.log(`                 ${line}`);
  await page.close();
}
await browser.close();
server.close();
process.exit(0);
