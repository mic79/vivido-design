/**
 * Bake a Potentially Visible Set for preview7 / LandscapePreview2.
 *
 * Same method as Map1 preview5 (webxr-bake/bake-pvs.mjs):
 *  ID-buffer cube renders from a walkable eye grid. Transparent meshes never
 *  occlude and stay always-visible. ID materials copy source `side`.
 *  No neighborhood dilation. No occupancy heuristics.
 *
 * Usage: node bake-pvs-preview7.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8778);
const OUT = path.join(__dirname, 'landscape2', 'pvs.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
};

const BAKE = {
  step: 1,
  yBand: 3,
  eyeHeight: 1.65,
  headroom: 1.9,
  res: 512,
  nearR: 0,
  far: 2000,
  spawnRadius: 36,
};

function startServer() {
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
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)));
}

async function main() {
  const server = await startServer();
  const pageUrl = `http://127.0.0.1:${PORT}/preview7.html#nopvs&nobatch`;
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(180000);
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('PVS:')) console.log(t);
  });
  page.on('pageerror', (e) => console.error('PAGEERR', e.message));

  console.log('GOTO', pageUrl);
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__SCENE_READY__ === true, null, { timeout: 300000 });

  const result = await page.evaluate(async (cfg) => {
    const THREE = window.__THREE__;
    const renderer = window.__RENDERER__;
    const scene = window.__SCENE__;
    const root = window.__ROOT__;
    const sceneB = window.__BOUNDS__;
    const pvsB = window.__PVS_BOUNDS__ || sceneB;
    const spawn = window.__MERGE__?.spawn || { x: 0, y: 0, z: 0 };

    const meshes = [];
    root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    for (const child of scene.children) {
      if (child !== root) child.visible = false;
    }

    const nonOccluder = meshes.map((m) => {
      const mat = m.material;
      const mats = Array.isArray(mat) ? mat : [mat];
      return mats.some((x) => x && (x.transparent || (x.alphaTest || 0) > 0));
    });

    const idMats = [];
    for (let i = 0; i < meshes.length; i++) {
      const c = i + 1;
      const mat = new THREE.MeshBasicMaterial();
      mat.color.setRGB(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255);
      const src = Array.isArray(meshes[i].material) ? meshes[i].material[0] : meshes[i].material;
      if (src) mat.side = src.side;
      idMats.push(mat);
      meshes[i].userData.__origMat = meshes[i].material;
      meshes[i].material = mat;
      if (nonOccluder[i]) meshes[i].visible = false;
    }
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    scene.background = new THREE.Color(0, 0, 0);
    scene.fog = null;
    scene.environment = null;

    const minX = Math.max(pvsB.min[0], spawn.x - cfg.spawnRadius);
    const maxX = Math.min(pvsB.max[0], spawn.x + cfg.spawnRadius);
    const minY = Math.max(pvsB.min[1], spawn.y - 8);
    const maxY = Math.min(pvsB.max[1], spawn.y + 16);
    const minZ = Math.max(pvsB.min[2], spawn.z - cfg.spawnRadius);
    const maxZ = Math.min(pvsB.max[2], spawn.z + cfg.spawnRadius);

    const ray = new THREE.Raycaster();
    ray.far = 500;
    const down = new THREE.Vector3(0, -1, 0);
    const nrm = new THREE.Vector3();
    const eyes = [];
    for (let x = minX + cfg.step / 2; x <= maxX; x += cfg.step) {
      for (let z = minZ + cfg.step / 2; z <= maxZ; z += cfg.step) {
        ray.set(new THREE.Vector3(x, maxY + 2, z), down);
        const hits = ray.intersectObjects([root], true);
        let added = 0;
        for (let i = 0; i < hits.length && added < 4; i++) {
          const h = hits[i];
          if (!h.face) continue;
          const hn = `${h.object.name || ''} ${h.object.parent?.name || ''}`;
          if (/cliff|rock|mineral|dirtpile/i.test(hn)) continue;
          nrm.copy(h.face.normal).transformDirection(h.object.matrixWorld);
          if (nrm.y < 0.5) continue;
          const above = i > 0 ? hits[i - 1].point.y : maxY + 2;
          if (above - h.point.y < cfg.headroom) continue;
          const ey = h.point.y + cfg.eyeHeight;
          if (ey < minY || ey > maxY) continue;
          eyes.push([x, ey, z]);
          added++;
        }
      }
    }
    console.log(`PVS: ${meshes.length} meshes (${nonOccluder.filter(Boolean).length} non-occluders), ${eyes.length} eye samples`);
    console.log(`PVS: bake volume [${minX.toFixed(1)},${minY.toFixed(1)},${minZ.toFixed(1)}] … [${maxX.toFixed(1)},${maxY.toFixed(1)},${maxZ.toFixed(1)}]`);

    const rt = new THREE.WebGLRenderTarget(cfg.res, cfg.res, { samples: 0 });
    const cam = new THREE.PerspectiveCamera(90, 1, 0.05, cfg.far);
    scene.add(cam);
    const px = new Uint8Array(cfg.res * cfg.res * 4);
    const dirs = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ];
    const origin = [minX, minY, minZ];
    const keyOf = (p) =>
      Math.floor((p[0] - origin[0]) / cfg.step) + '_'
      + Math.floor((p[2] - origin[2]) / cfg.step) + '_'
      + Math.floor((p[1] - origin[1]) / cfg.yBand);
    const cells = new Map();
    const t0 = performance.now();
    const renderEyeInto = (set, e) => {
      cam.position.set(e[0], e[1], e[2]);
      for (const d of dirs) {
        cam.up.set(0, Math.abs(d[1]) === 1 ? 0 : 1, Math.abs(d[1]) === 1 ? 1 : 0);
        cam.lookAt(e[0] + d[0], e[1] + d[1], e[2] + d[2]);
        renderer.setRenderTarget(rt);
        renderer.render(scene, cam);
        renderer.readRenderTargetPixels(rt, 0, 0, cfg.res, cfg.res, px);
        for (let i = 0; i < px.length; i += 4) {
          const id = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
          if (id > 0 && id <= meshes.length) set.add(id - 1);
        }
      }
    };
    for (let s = 0; s < eyes.length; s++) {
      const e = eyes[s];
      const key = keyOf(e);
      let set = cells.get(key);
      if (!set) cells.set(key, set = new Set());
      renderEyeInto(set, e);
      if (s % 50 === 49) {
        const dt = (performance.now() - t0) / 1000;
        console.log(`PVS: sample ${s + 1}/${eyes.length} (${dt.toFixed(0)}s)`);
      }
    }

    // No ring cells. A ring sample from a cell center inside a wall/cliff bakes a
    // near-empty set; runtime would hide the world. Missing cell ⇒ fail-open.
    console.log('PVS: skipping ring cells (fail-open at unsampled keys)');
    renderer.setRenderTarget(null);

    const boxes = cfg.nearR > 0 ? meshes.map((m) => new THREE.Box3().setFromObject(m)) : null;
    const ctr = new THREE.Vector3();
    let sum = 0;
    for (const [key, set] of cells) {
      const [ix, iz, iy] = key.split('_').map(Number);
      ctr.set(
        origin[0] + (ix + 0.5) * cfg.step,
        origin[1] + (iy + 0.5) * cfg.yBand,
        origin[2] + (iz + 0.5) * cfg.step,
      );
      for (let i = 0; i < meshes.length; i++) {
        if (nonOccluder[i]) set.add(i);
        else if (boxes && boxes[i].distanceToPoint(ctr) < cfg.nearR) set.add(i);
      }
      sum += set.size;
    }

    const seenAnywhere = new Set();
    for (const set of cells.values()) for (const v of set) seenAnywhere.add(v);
    const neverSeen = [];
    for (let i = 0; i < meshes.length; i++) if (!seenAnywhere.has(i)) neverSeen.push(i);

    const cellsObj = {};
    for (const [key, set] of cells) cellsObj[key] = [...set].sort((a, b) => a - b);
    return {
      meshCount: meshes.length,
      cellSize: cfg.step,
      yBand: cfg.yBand,
      origin,
      cells: cellsObj,
      stats: {
        samples: eyes.length,
        cells: cells.size,
        avgVisible: Math.round(sum / Math.max(1, cells.size)),
        neverSeen: neverSeen.length,
        nonOccluders: nonOccluder.filter(Boolean).length,
        bakeSeconds: Math.round((performance.now() - t0) / 1000),
        tight: true,
        nearR: cfg.nearR,
        dilated: false,
        far: cfg.far,
        volume: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      },
    };
  }, BAKE);

  await browser.close();
  server.close();

  console.log('STATS', JSON.stringify(result.stats));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(result);
  fs.writeFileSync(OUT, json);
  console.log(`Wrote ${OUT} (${(json.length / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
