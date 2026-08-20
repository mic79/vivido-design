/**
 * Drop PVS cells whose centers sit inside solid geometry.
 * Those were ring samples from inside cliffs: a near-empty set that hides the
 * world. Missing cell ⇒ runtime fail-open (preview5 contract).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8780);
const PVS_FILE = path.join(__dirname, 'landscape2', 'pvs.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/preview7.html';
  const filePath = path.normalize(path.join(__dirname, rel));
  if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const pvs = JSON.parse(fs.readFileSync(PVS_FILE, 'utf8'));
const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
page.setDefaultTimeout(0);
await page.goto(`http://127.0.0.1:${PORT}/preview7.html#nopvs`, { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForFunction(() => window.__SCENE_READY__ === true, null, { timeout: 300000 });

  const dropped = await page.evaluate(({ origin, cellSize, yBand, keys }) => {
    const THREE = window.__THREE__;
    const root = window.__ROOT__;
    const saved = [];
    root.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        saved.push([m, m.side]);
        m.side = THREE.DoubleSide;
      }
    });
    const ray = new THREE.Raycaster();
    ray.far = 0.5;
    ray.firstHitOnly = true;
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const o = new THREE.Vector3();
    const d = new THREE.Vector3();
    const inside = [];
    for (const key of keys) {
      const [ix, iz, iy] = key.split('_').map(Number);
      o.set(origin[0] + (ix + 0.5) * cellSize, origin[1] + (iy + 0.5) * yBand, origin[2] + (iz + 0.5) * cellSize);
      let hits = 0;
      for (const dir of dirs) {
        d.set(dir[0], dir[1], dir[2]);
        ray.set(o, d);
        const h = ray.intersectObjects([root], true)[0];
        if (h && h.distance < 0.5) hits++;
      }
      if (hits >= 4) inside.push(key);
    }
    for (const [m, side] of saved) m.side = side;
    return inside;
  }, { origin: pvs.origin, cellSize: pvs.cellSize, yBand: pvs.yBand, keys: Object.keys(pvs.cells) });

for (const k of dropped) delete pvs.cells[k];
fs.writeFileSync(PVS_FILE, JSON.stringify(pvs));
console.log(`Dropped ${dropped.length} inside-solid cells; ${Object.keys(pvs.cells).length} remain`);
await browser.close();
server.close();
