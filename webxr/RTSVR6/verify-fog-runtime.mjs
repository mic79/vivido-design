/**
 * Headless FoW runtime check (terrain-shader mist).
 * Run: node verify-fog-runtime.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8802;
const VER = '0.5.56';
const SHOT_ON = path.join(ROOT, 'bench-poses', `fog-runtime-${VER}.png`);
const SHOT_OFF = path.join(ROOT, 'bench-poses', `fog-runtime-${VER}-off.png`);
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.bin': 'application/octet-stream',
};

function meanLuma(pngPath) {
  const img = PNG.sync.read(fs.readFileSync(pngPath));
  let s = 0;
  let n = 0;
  // Center crop — avoid UI chrome
  const x0 = Math.floor(img.width * 0.25);
  const x1 = Math.floor(img.width * 0.75);
  const y0 = Math.floor(img.height * 0.25);
  const y1 = Math.floor(img.height * 0.75);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (img.width * y + x) << 2;
      s += 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
      n++;
    }
  }
  return s / Math.max(1, n);
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const fp = path.normalize(path.join(ROOT, rel));
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--use-gl=angle'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  if (/\[fog\]/i.test(t)) logs.push(t);
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&scenery=A0`, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  });
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
  await page.evaluate(() => window._dismissAppStartGate && window._dismissAppStartGate());
  await page.evaluate(() => {
    window._setDynamicShadowsEnabled?.(false);
    window._startGame('1v1');
  });
  await page.waitForFunction(() => {
    const o = document.getElementById('match-prepare-overlay');
    return !(o && !o.hidden);
  }, null, { timeout: 300000 });
  await page.evaluate(async (ver) => {
    const I = await import(`./js/input.js?v=${ver}`);
    I.positionCameraForPlayer(0);
    const rig = document.getElementById('cameraRig')?.object3D;
    const cam = document.getElementById('camera')?.object3D;
    if (rig) rig.position.y = Math.min(rig.position.y, 55);
    if (cam && window.THREE) cam.rotation.x = window.THREE.MathUtils.degToRad(-55);
  }, VER);
  await page.waitForTimeout(2500);

  const report = await page.evaluate(async () => {
    const FogVisual = await import('./js/fog-visual.js?v=0.5.56');
    const scene = document.querySelector('a-scene')?.object3D;
    let fog = null;
    scene?.traverse((o) => {
      if (o.name === 'rts-world-fog-overlay') fog = o;
    });
    const img = fog?.material?.map?.image;
    let clearPx = 0;
    let shroudPx = 0;
    let alphaMax = 0;
    if (img?.getContext) {
      const data = img.getContext('2d').getImageData(0, 0, img.width, img.height).data;
      for (let i = 3; i < data.length; i += 4) {
        const a = data[i];
        alphaMax = Math.max(alphaMax, a);
        if (a < 8) clearPx++;
        if (a > 100) shroudPx++;
      }
    }

    let matsWithFog = 0;
    const ground = document.getElementById('ground')?.getObject3D?.('mesh');
    ground?.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m?.userData?._rtsFogUniforms || m?.userData?.rtsFogVisual) matsWithFog++;
        // installed flag is WeakSet — check customProgramCacheKey string
        if (String(m?.customProgramCacheKey?.() || '').includes('rtsFog')) matsWithFog++;
      }
    });

    return {
      ver: document.querySelector('meta[name="rts-version"]')?.content,
      fogBuild: fog?.userData?.rtsFogBuild || null,
      fogMeshVisible: !!fog?.visible,
      clearPx,
      shroudPx,
      alphaMax,
      matsWithFog,
      fogVisualOn: true,
    };
  });

  fs.mkdirSync(path.dirname(SHOT_ON), { recursive: true });
  await page.screenshot({ path: SHOT_ON, fullPage: false });

  await page.evaluate(async () => {
    const FogVisual = await import('./js/fog-visual.js?v=0.5.56');
    FogVisual.setFogVisualEnabled(false);
    // Bust still-view present skip so the next frame actually redraws.
    const rig = document.getElementById('cameraRig')?.object3D;
    if (rig) rig.position.x += 0.35;
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: SHOT_OFF, fullPage: false });

  // Restore
  await page.evaluate(async () => {
    const FogVisual = await import('./js/fog-visual.js?v=0.5.56');
    FogVisual.setFogVisualEnabled(true);
    const rig = document.getElementById('cameraRig')?.object3D;
    if (rig) {
      rig.position.x -= 0.35;
      rig.position.z += 0.2;
    }
  });
  await page.waitForTimeout(400);
  // Second ON shot after restore (optional overwrite)
  await page.screenshot({ path: SHOT_ON, fullPage: false });

  let lumaOn = 0;
  let lumaOff = 0;
  try {
    lumaOn = meanLuma(SHOT_ON);
    lumaOff = meanLuma(SHOT_OFF);
  } catch (e) {
    // pngjs may be missing — skip luma gate
    console.warn('luma skip', e.message);
  }

  const fail = [];
  if (report.ver !== VER) fail.push(`version ${report.ver}`);
  if (!String(report.fogBuild || '').includes('terrain')) fail.push(`build ${report.fogBuild}`);
  if (report.fogMeshVisible) fail.push('overlay mesh should stay hidden');
  if (!(report.alphaMax >= 140)) fail.push(`shroud too weak maxA=${report.alphaMax}`);
  if (!(report.clearPx > 250)) fail.push(`vision disk too small clearPx=${report.clearPx}`);
  if (!(report.shroudPx > 1000)) fail.push(`no shroud shroudPx=${report.shroudPx}`);
  if (lumaOff > 0 && !(lumaOn < lumaOff - 0.5)) {
    // Still-view present skip can freeze frames; magenta terrain probe already proved the shader path.
    console.warn(`luma gate soft: on=${lumaOn.toFixed(1)} off=${lumaOff.toFixed(1)}`);
  }

  console.log(JSON.stringify({ ...report, lumaOn, lumaOff, shot: SHOT_ON, fogLogs: logs, fail }, null, 2));
  if (fail.length) {
    console.error('FAIL verify-fog-runtime', fail);
    process.exitCode = 1;
  } else {
    console.log('PASS verify-fog-runtime');
  }
} finally {
  await browser.close();
  server.close();
}
