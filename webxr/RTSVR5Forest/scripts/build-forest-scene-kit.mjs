#!/usr/bin/env node
/**
 * Normalize Sketchfab forest road-night GLB into a Quest-ready kit terrain:
 * merge 1480 meshes → ~3 by material, MASK foliage, center/scale to 200 m span,
 * name SM_Ground_Forest for nav heightfield.
 *
 *   node RTSVR5Forest/scripts/build-forest-scene-kit.mjs
 *
 * Out: assets/terrain/forest-road-night.glb
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const THREE_ROOT = path.join(ROOT, '..', 'node_modules', 'three');
const PORT = Number(process.env.PORT || 8791);
const DST = path.join(ROOT, 'assets/terrain/forest-road-night.glb');
const SRC = path.join(ROOT, 'assets/a_forest_3_with_a_road_at_night_for_game.glb');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
};

function startStaticServer() {
  if (!fs.existsSync(THREE_ROOT)) {
    throw new Error(`three not found at ${THREE_ROOT}`);
  }
  if (!fs.existsSync(SRC)) {
    throw new Error(`missing source ${SRC}`);
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
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
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const server = await startStaticServer();
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => console.log('[page]', m.text()));
    await page.goto(`http://127.0.0.1:${PORT}/scripts/build-forest-scene-kit.html?span=200&grid=3`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(
      () => !!(window.__forestSceneResult || window.__forestSceneError),
      null,
      { timeout: 600000 }
    );
    const err = await page.evaluate(() => window.__forestSceneError || null);
    if (err) throw new Error(err);
    const out = await page.evaluate(() => window.__forestSceneResult);
    const u8 = Buffer.from(out.b64, 'base64');
    fs.mkdirSync(path.dirname(DST), { recursive: true });
    fs.writeFileSync(DST, u8);
    console.log(
      `wrote ${path.relative(ROOT, DST)} (${(u8.length / 1e6).toFixed(2)} MB) meshes=${out.meshes} ` +
        `grid=${out.grid}x${out.grid} tiles=${out.tiles} map~${out.mapSizeHint}m`
    );
    console.log('stats', JSON.stringify(out.stats, null, 2));
    console.log('cell', { w: out.cellW, d: out.cellD, outSize: out.outSize });

    // Persist map-size hint for runtime (Forest kit plate).
    const hintPath = path.join(ROOT, 'assets/terrain/forest-road-night-map.json');
    fs.writeFileSync(
      hintPath,
      JSON.stringify(
        {
          mapSize: out.mapSizeHint,
          grid: out.grid,
          tiles: out.tiles,
          cellW: out.cellW,
          cellD: out.cellD,
          outSize: out.outSize,
        },
        null,
        2
      )
    );

    const jlen = u8.readUInt32LE(12);
    const json = JSON.parse(u8.subarray(20, 20 + jlen).toString('utf8'));
    const names = (json.nodes || []).filter((n) => n.mesh != null).map((n) => n.name);
    console.log('mesh nodes', names);
    if (!names.some((n) => /SM_Ground/i.test(n || ''))) {
      throw new Error('bake missing SM_Ground_* mesh for heightfield');
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log('PASS build-forest-scene-kit');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
