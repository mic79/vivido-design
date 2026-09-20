#!/usr/bin/env node
/**
 * Smoke: 1v1 boots with barriers resident; sample mid/flank vs ridge cells.
 *   node RTSVR6/scripts/smoke-skirmish-barriers.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8831);
const VER = fs
  .readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/name="rts-version"\s+content="([^"]+)"/)?.[1];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('missing');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));

await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&focusCull=1&v=${VER}`, {
  waitUntil: 'domcontentloaded',
  timeout: 180000,
});
await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
await page.evaluate(() => window._dismissAppStartGate && window._dismissAppStartGate());
await page.evaluate(() => window._startGame('1v1'));
await page.waitForFunction(() => {
  const o = document.getElementById('match-prepare-overlay');
  return !(o && !o.hidden);
}, null, { timeout: 300000 });
await page.waitForTimeout(2500);

const report = await page.evaluate(async (ver) => {
  const scene = document.querySelector('a-scene')?.object3D;
  let props = 0;
  let instanced = 0;
  let instancedCount = 0;
  scene?.traverse((o) => {
    const n = o.name || '';
    if (/^Prop_/i.test(n) && o.isMesh) props++;
    if (o.isInstancedMesh) {
      instanced++;
      instancedCount += o.count | 0;
    }
  });

  // Barriers become InstancedMesh slots (names drop). Count from GLB extras via
  // scenery root userData if present, else from loaded node names before LOD
  // is impossible — verify via fetch of the live GLB + walkable samples.
  const PF = await import(`./js/pathfinding.js?v=${ver}`);
  const samples = [
    { id: 'mid', x: 0, z: 0 },
    { id: 'flankN', x: 0, z: 48 },
    { id: 'flankE', x: 48, z: 0 },
    { id: 'ridgeNE', x: 48, z: 48 },
    { id: 'ridgeNW', x: -48, z: 48 },
  ].map((s) => ({
    ...s,
    walkable: typeof PF.isPositionWalkable === 'function' ? PF.isPositionWalkable(s.x, s.z) : null,
  }));

  return {
    ver: document.querySelector('meta[name="rts-version"]')?.content,
    props,
    instanced,
    instancedCount,
    samples,
    focusCullBtn: [...document.querySelectorAll('button')].find((b) => /Focus cull/i.test(b.textContent || ''))
      ?.textContent,
  };
}, VER);

const glb = fs.readFileSync(path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb'));
const jlen = glb.readUInt32LE(12);
const json = JSON.parse(
  glb
    .subarray(20, 20 + jlen)
    .toString('utf8')
    .replace(/:\s*-?inf\b/gi, ':null')
    .replace(/:\s*nan\b/gi, ':null')
);
const barrierNodes = (json.nodes || []).filter((n) => /_Barrier_/i.test(n.name || ''));

await browser.close();
server.close();

const out = { report, barrierNodes: barrierNodes.length, errors };
console.log(JSON.stringify(out, null, 2));
if (errors.length) {
  console.error('FAIL page errors');
  process.exit(1);
}
if (barrierNodes.length < 20) {
  console.error('FAIL expected >=20 barrier nodes in GLB, got', barrierNodes.length);
  process.exit(2);
}
if ((report.instanced || 0) < 1) {
  console.error('FAIL expected instanced scenery batches, got', report.instanced);
  process.exit(5);
}
const mid = report.samples.find((s) => s.id === 'mid');
const flankN = report.samples.find((s) => s.id === 'flankN');
if (mid && mid.walkable === false) {
  console.error('FAIL mid should be walkable');
  process.exit(3);
}
if (flankN && flankN.walkable === false) {
  console.error('FAIL flankN should be walkable');
  process.exit(4);
}
console.log('PASS smoke-skirmish-barriers');
