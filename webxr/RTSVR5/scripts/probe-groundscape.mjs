#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREE_ROOT = path.join(ROOT, '..', 'node_modules', 'three');
const PORT = 8789;
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let fp;
  if (rel.startsWith('/vendor/three/')) {
    fp = path.normalize(path.join(THREE_ROOT, rel.slice('/vendor/three/'.length)));
    if (!fp.startsWith(THREE_ROOT) || !fs.existsSync(fp)) {
      res.writeHead(404);
      res.end();
      return;
    }
  } else {
    fp = path.normalize(path.join(ROOT, rel));
    if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/scripts/probe-groundscape.html`, {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
await page.waitForFunction(() => window.__out || window.__err, null, { timeout: 60000 });
const err = await page.evaluate(() => window.__err || null);
if (err) console.error(err);
else console.log(JSON.stringify(await page.evaluate(() => window.__out), null, 2));
await browser.close();
server.close();
