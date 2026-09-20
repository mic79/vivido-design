#!/usr/bin/env node
/**
 * Top-down unlit diffuse (albedo) of UE scifi kit: original landscape + rocks,
 * no buildings / fences / pads.
 *
 *   node RTSVR6/scripts/bake-ue-topdown-diffuse.mjs
 *
 * Env: RES=2048 SRC=assets/terrain/scifi-rts-kit-lod2.glb
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const THREE_ROOT = path.join(ROOT, '..', 'node_modules', 'three');
const PORT = Number(process.env.PORT || 8796);
const RES = Number(process.env.RES || 2048);
const SRC = process.env.SRC || 'assets/terrain/scifi-rts-kit-lod2.glb';
const OUT = path.join(ROOT, 'assets/mesa/ue-scifi/diffuse-topdown.png');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
  '.bin': 'application/octet-stream',
};

function startStaticServer() {
  if (!fs.existsSync(THREE_ROOT)) {
    throw new Error(`three not found at ${THREE_ROOT}`);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/scripts/bake-ue-topdown-diffuse.html';
    let filePath;
    if (rel.startsWith('/vendor/three/')) {
      filePath = path.normalize(path.join(THREE_ROOT, rel.slice('/vendor/three/'.length)));
      if (!filePath.startsWith(THREE_ROOT)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
    } else {
      filePath = path.normalize(path.join(ROOT, rel));
      if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function main() {
  const srcAbs = path.join(ROOT, SRC.replace(/^\.\.\//, ''));
  if (!fs.existsSync(srcAbs)) throw new Error(`missing ${srcAbs}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const server = await startStaticServer();
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: RES, height: RES } });
    page.on('console', (m) => console.log('[page]', m.text()));
    const q = `src=${encodeURIComponent('../' + SRC.replace(/\\/g, '/'))}&res=${RES}`;
    await page.goto(`http://127.0.0.1:${PORT}/scripts/bake-ue-topdown-diffuse.html?${q}`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(() => !!(window.__topdownResult || window.__topdownError), null, {
      timeout: 600000,
    });
    const err = await page.evaluate(() => window.__topdownError || null);
    if (err) throw new Error(err);
    const out = await page.evaluate(() => window.__topdownResult);
    const b64 = out.dataUrl.replace(/^data:image\/png;base64,/, '');
    const png = Buffer.from(b64, 'base64');
    fs.writeFileSync(OUT, png);
    console.log('wrote', path.relative(ROOT, OUT), (png.length / 1e6).toFixed(2) + 'MB', {
      kept: out.kept,
      dropped: out.dropped,
      spanXZ: out.spanXZ,
      half: out.half,
      res: out.res,
    });
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
