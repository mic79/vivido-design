/**
 * Prove preview7 PVS changes nothing visually vs everything-visible.
 * Same contract as Map1 verify-pvs.mjs: independent walkable eyes, pixel diff,
 * REFINE=1 merges missing meshes into the fail cell + face neighbors only.
 *
 * Usage:
 *   node verify-pvs-preview7.mjs
 *   REFINE=1 SEED=<n> node verify-pvs-preview7.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8779);
const COLUMNS = Number(process.env.COLUMNS || 40);
const YAWS = 4;
const RES = 640;
const FAIL_FRAC = 0.001;
const SEED = Number(process.env.SEED || 1234567);
const REFINE = process.env.REFINE === '1';
const PVS_FILE = path.join(__dirname, 'landscape2', 'pvs.json');

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

async function runPass(browser) {
  const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(180000);
  page.on('pageerror', (e) => console.error('PAGEERR', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/preview7.html#nobatch`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction(() => window.__SCENE_READY__ === true, null, { timeout: 300000 });
  const pvsOn = await page.evaluate(() => !!window.__PVS__);
  if (!pvsOn) throw new Error('PVS did not activate on the page — nothing to verify');

  const out = await page.evaluate(async ({ COLUMNS, YAWS, RES, FAIL_FRAC, SEED }) => {
    const THREE = window.__THREE__;
    const renderer = window.__RENDERER__;
    const scene = window.__SCENE__;
    const root = window.__ROOT__;
    const camera = window.__CAMERA__;
    const controls = window.__CONTROLS__;
    const B = window.__PVS_BOUNDS__ || window.__BOUNDS__;
    const spawn = window.__MERGE__?.spawn;

    const ray = new THREE.Raycaster();
    ray.far = 500;
    const eyes = [];
    let seed = SEED;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const nrm = new THREE.Vector3();
    if (spawn) eyes.push([spawn.x, spawn.y + 1.6, spawn.z]);
    for (let c = 0; c < COLUMNS; c++) {
      const x = B.min[0] + rnd() * (B.max[0] - B.min[0]);
      const z = B.min[2] + rnd() * (B.max[2] - B.min[2]);
      ray.set(new THREE.Vector3(x, B.max[1] + 2, z), new THREE.Vector3(0, -1, 0));
      const hits = ray.intersectObjects([root], true);
      let added = 0;
      for (let i = 0; i < hits.length && added < 2; i++) {
        const h = hits[i];
        if (!h.face) continue;
        const hn = `${h.object.name || ''} ${h.object.parent?.name || ''}`;
        if (/cliff|rock|mineral|dirtpile/i.test(hn)) continue;
        nrm.copy(h.face.normal).transformDirection(h.object.matrixWorld);
        if (nrm.y < 0.5) continue;
        const above = i > 0 ? hits[i - 1].point.y : B.max[1] + 2;
        if (above - h.point.y < 1.9) continue;
        eyes.push([x, h.point.y + 1.6, z]);
        added++;
      }
    }

    const rt = new THREE.WebGLRenderTarget(RES, RES, { samples: 0 });
    const a = new Uint8Array(RES * RES * 4);
    const b = new Uint8Array(RES * RES * 4);
    const results = [];
    let worst = { frac: 0 };
    for (const e of eyes) {
      for (let k = 0; k < YAWS; k++) {
        const yaw = (k / YAWS) * Math.PI * 2;
        const pitch = (rnd() - 0.5) * 0.6;
        camera.position.set(e[0], e[1], e[2]);
        controls.target.set(
          e[0] + Math.sin(yaw) * Math.cos(pitch) * 5,
          e[1] + Math.sin(pitch) * 5,
          e[2] + Math.cos(yaw) * Math.cos(pitch) * 5,
        );
        controls.update();
        window.__PVS_ENABLE__(true);
        window.__PVS_UPDATE__();
        renderer.setRenderTarget(rt);
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(rt, 0, 0, RES, RES, a);
        const drawsPvs = renderer.info.render.calls;
        const trisPvs = renderer.info.render.triangles;
        window.__PVS_ENABLE__(false);
        renderer.render(scene, camera);
        renderer.readRenderTargetPixels(rt, 0, 0, RES, RES, b);
        const drawsAll = renderer.info.render.calls;
        const trisAll = renderer.info.render.triangles;
        let bad = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (Math.abs(a[i] - b[i]) > 3 || Math.abs(a[i + 1] - b[i + 1]) > 3 || Math.abs(a[i + 2] - b[i + 2]) > 3) bad++;
        }
        const frac = bad / (RES * RES);
        const rec = {
          eye: e.map((v) => +v.toFixed(1)), eyeExact: e, yaw: +(yaw * 180 / Math.PI).toFixed(0),
          diffFrac: +frac.toFixed(5), drawsPvs, drawsAll, trisPvs, trisAll,
          FAIL: frac > FAIL_FRAC,
        };
        results.push(rec);
        if (frac > worst.frac) worst = { frac, rec };
      }
    }
    renderer.setRenderTarget(null);

    const fails = results.filter((r) => r.FAIL);
    const failEyes = [];
    if (fails.length) {
      const uniq = new Map();
      for (const f of fails) uniq.set(f.eye.join(','), f.eyeExact);
      const idRes = RES * 2;
      const idRt = new THREE.WebGLRenderTarget(idRes, idRes, { samples: 0 });
      const idPx = new Uint8Array(idRes * idRes * 4);
      const allMeshes = [];
      root.traverse((o) => { if (o.isMesh) allMeshes.push(o); });
      const oldFog = scene.fog;
      for (const eye of uniq.values()) {
        camera.position.set(eye[0], eye[1], eye[2]);
        controls.target.set(eye[0], eye[1], eye[2] - 5);
        controls.update();
        window.__PVS_ENABLE__(true);
        window.__PVS_UPDATE__();
        const have = new Set(allMeshes.map((m, i) => (m.visible ? i : -1)).filter((i) => i >= 0));
        window.__PVS_ENABLE__(false);
        const saved = allMeshes.map((m) => m.material);
        allMeshes.forEach((m, i) => {
          const mats = Array.isArray(saved[i]) ? saved[i] : [saved[i]];
          if (mats.some((x) => x && (x.transparent || (x.alphaTest || 0) > 0))) { m.visible = false; return; }
          const mm = new THREE.MeshBasicMaterial();
          const c = i + 1;
          mm.color.setRGB(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255);
          if (mats[0]) mm.side = mats[0].side;
          m.material = mm;
        });
        const oldTm = renderer.toneMapping;
        const oldCs = renderer.outputColorSpace;
        const oldBg = scene.background;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
        scene.background = new THREE.Color(0, 0, 0);
        scene.fog = null;
        const idCam = new THREE.PerspectiveCamera(90, 1, 0.05, 2000);
        idCam.position.set(eye[0], eye[1], eye[2]);
        const missing = new Set();
        for (const d of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          idCam.up.set(0, Math.abs(d[1]) === 1 ? 0 : 1, Math.abs(d[1]) === 1 ? 1 : 0);
          idCam.lookAt(eye[0] + d[0], eye[1] + d[1], eye[2] + d[2]);
          idCam.updateMatrixWorld(true);
          renderer.setRenderTarget(idRt);
          renderer.render(scene, idCam);
          renderer.readRenderTargetPixels(idRt, 0, 0, idRes, idRes, idPx);
          for (let i = 0; i < idPx.length; i += 4) {
            const id = (idPx[i] << 16) | (idPx[i + 1] << 8) | idPx[i + 2];
            if (id > 0 && id <= allMeshes.length && !have.has(id - 1)) missing.add(id - 1);
          }
        }
        renderer.setRenderTarget(null);
        allMeshes.forEach((m, i) => { m.material = saved[i]; m.visible = true; });
        renderer.toneMapping = oldTm;
        renderer.outputColorSpace = oldCs;
        scene.background = oldBg;
        scene.fog = oldFog;
        failEyes.push({ eye, missing: [...missing] });
      }
    }
    window.__PVS_ENABLE__(true);
    const avg = (f) => Math.round(results.reduce((s, r) => s + f(r), 0) / results.length);
    return {
      poses: results.length,
      fails: fails.slice(0, 10),
      failCount: fails.length,
      failEyes,
      worstDiffFrac: +worst.frac.toFixed(5),
      avgDrawsPvs: avg((r) => r.drawsPvs), avgDrawsAll: avg((r) => r.drawsAll),
      avgTrisPvs: avg((r) => r.trisPvs), avgTrisAll: avg((r) => r.trisAll),
      maxDrawsPvs: Math.max(...results.map((r) => r.drawsPvs)),
    };
  }, { COLUMNS, YAWS, RES, FAIL_FRAC, SEED });

  await page.close();
  return out;
}

function mergeFailEyes(failEyes) {
  const pvs = JSON.parse(fs.readFileSync(PVS_FILE, 'utf8'));
  let merged = 0;
  for (const { eye, missing } of failEyes) {
    if (!missing?.length) continue;
    const ix = Math.floor((eye[0] - pvs.origin[0]) / pvs.cellSize);
    const iz = Math.floor((eye[2] - pvs.origin[2]) / pvs.cellSize);
    const iy = Math.floor((eye[1] - pvs.origin[1]) / pvs.yBand);
    const keys = [
      `${ix}_${iz}_${iy}`,
      `${ix + 1}_${iz}_${iy}`, `${ix - 1}_${iz}_${iy}`,
      `${ix}_${iz + 1}_${iy}`, `${ix}_${iz - 1}_${iy}`,
      `${ix}_${iz}_${iy + 1}`, `${ix}_${iz}_${iy - 1}`,
    ];
    for (const nk of keys) {
      const cell = pvs.cells[nk];
      if (!cell) continue;
      const set = new Set(cell);
      const before = set.size;
      for (const id of missing) set.add(id);
      if (set.size !== before) {
        pvs.cells[nk] = [...set].sort((x, y) => x - y);
        merged += set.size - before;
      }
    }
  }
  if (merged) fs.writeFileSync(PVS_FILE, JSON.stringify(pvs));
  return merged;
}

async function main() {
  if (!fs.existsSync(PVS_FILE)) throw new Error(`Missing ${PVS_FILE} — run bake-pvs-preview7.mjs first`);
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
  });
  console.log('verify preview7 PVS', `seed=${SEED}`, REFINE ? '(refine mode)' : '');
  const maxRounds = REFINE ? 10 : 1;
  let out;
  try {
    for (let round = 1; round <= maxRounds; round++) {
      out = await runPass(browser);
      console.log(`round ${round}:`, JSON.stringify({
        poses: out.poses, failCount: out.failCount, worstDiffFrac: out.worstDiffFrac,
        avgDrawsPvs: out.avgDrawsPvs, avgDrawsAll: out.avgDrawsAll,
        avgTrisPvs: out.avgTrisPvs, avgTrisAll: out.avgTrisAll,
      }));
      if (out.failCount === 0 || !REFINE) break;
      const merged = mergeFailEyes(out.failEyes);
      console.log(`merged ${merged} mesh entries from ${out.failEyes.length} failing eyes — re-checking`);
      if (merged === 0) {
        console.error('Nothing left to merge but still failing — investigate manually');
        break;
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (out.failCount > 0) {
    console.error(`FAIL — ${out.failCount}/${out.poses} poses differ visually`);
    for (const f of out.fails) console.error(' ', JSON.stringify(f));
    process.exit(1);
  }
  console.log(`OK — ${out.poses} poses pixel-identical · draws ${out.avgDrawsAll}→${out.avgDrawsPvs} avg · tris ${(out.avgTrisAll / 1e6).toFixed(2)}M→${(out.avgTrisPvs / 1e6).toFixed(2)}M avg`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
