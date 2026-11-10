#!/usr/bin/env node
/**
 * Strip Story kit to natural scenery only (rocks / cliffs / dirt / minerals + water
 * marker) via Three loader + float GLTFExporter. Source is the UE-exported
 * scifi-rts-kit-lod2.glb — no Blender round-trip.
 *
 *   node RTSVR5/scripts/rebake-story-rocks.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const THREE_ROOT = path.join(ROOT, '..', 'node_modules', 'three');
const PORT = Number(process.env.PORT || 8797);
const DST = path.join(ROOT, 'assets/terrain/scifi-rts-rocks.glb');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
};

function startStaticServer() {
  if (!fs.existsSync(THREE_ROOT)) {
    throw new Error(`three not found at ${THREE_ROOT}`);
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
    await page.goto(`http://127.0.0.1:${PORT}/scripts/rebake-story-rocks.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(
      () => !!(window.__rebakeResult || window.__rebakeError),
      null,
      { timeout: 600000 }
    );
    const err = await page.evaluate(() => window.__rebakeError || null);
    if (err) throw new Error(err);
    const out = await page.evaluate(() => window.__rebakeResult);
    const u8 = Buffer.from(out.b64, 'base64');
    fs.writeFileSync(DST, u8);
    console.log(
      `wrote ${path.relative(ROOT, DST)} (${(u8.length / 1e6).toFixed(2)} MB) kept=${out.kept} mats=${out.mats}`,
      out.prefixCount
    );

    const jlen = u8.readUInt32LE(12);
    const json = JSON.parse(u8.subarray(20, 20 + jlen).toString('utf8'));
    const ext = [...(json.extensionsUsed || []), ...(json.extensionsRequired || [])];
    if (ext.some((e) => /quantization/i.test(e))) {
      throw new Error('rebake still has quantization: ' + ext.join(','));
    }
    const types = {};
    for (const a of json.accessors || []) {
      types[a.componentType] = (types[a.componentType] || 0) + 1;
    }
    // 5123 = indices (ok), 5126 = float verts (ok), 5121 = uchar colors (core glTF ok).
    // Reject signed byte/short vertex attrs that need KHR_mesh_quantization.
    if (types[5120] || types[5122]) {
      throw new Error('rebake has quantized-style attrs: ' + JSON.stringify(types));
    }
    console.log('ok', {
      images: (json.images || []).length,
      mats: (json.materials || []).length,
      meshes: (json.meshes || []).length,
      accessorTypes: types,
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
