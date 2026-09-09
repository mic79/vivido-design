#!/usr/bin/env node
/**
 * Review yaw-baked shadows: atlas integrity + in-match cookie placement.
 *   node RTSVR5/verify-yaw-shadows.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8811);
const VER = fs
  .readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/name="rts-version"\s+content="([^"]+)"/)?.[1];
const SHOT = path.join(ROOT, 'bench-poses', `yaw-shadows-${VER}.png`);
const fail = [];

function decodePng(buf) {
  let off = 8;
  let w = 0;
  let h = 0;
  const idats = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
    }
    if (type === 'IDAT') idats.push(data);
    if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    for (let i = 0; i < stride; i++) {
      let v = row[i];
      if (filter === 1) v = (v + (i >= bpp ? out[y * stride + i - bpp] : 0)) & 255;
      else if (filter === 2) v = (v + (y ? out[(y - 1) * stride + i] : 0)) & 255;
      else if (filter === 3) {
        const a = i >= bpp ? out[y * stride + i - bpp] : 0;
        const b = y ? out[(y - 1) * stride + i] : 0;
        v = (v + Math.floor((a + b) / 2)) & 255;
      } else if (filter === 4) {
        const a = i >= bpp ? out[y * stride + i - bpp] : 0;
        const b = y ? out[(y - 1) * stride + i] : 0;
        const c = y && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0;
        const p0 = a + b - c;
        const pa = Math.abs(p0 - a);
        const pb = Math.abs(p0 - b);
        const pc = Math.abs(p0 - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      out[y * stride + i] = v;
    }
  }
  return { w, h, rgba: out };
}

const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/shadows/yaw/manifest.json'), 'utf8'));
// Runtime box-fit caps (UNIT_SHAPES × visualScale). Cookies must not exceed ~2× the
// tallest cast that box can produce (height * castRatio + half-diagonal).
const CAST_RATIO = Math.hypot(man.sunDir.x, man.sunDir.z) / Math.max(man.sunDir.y, 0.18);
const MAX_HALF = {
  scoutBike: (2.4 * CAST_RATIO + Math.hypot(3.2, 7.2) * 0.5) * 1.4,
  mobileHq: (4.6 * CAST_RATIO + Math.hypot(7.2, 9.6) * 0.5) * 1.4,
  artillery: (3.12 * CAST_RATIO + Math.hypot(4.68, 10.92) * 0.5) * 1.4,
  harvester: (2.0 * CAST_RATIO + Math.hypot(3.2, 4.0) * 0.5) * 1.4,
  lightTank: (2.0 * CAST_RATIO + Math.hypot(2.8, 3.6) * 0.5) * 1.4,
  heavyTank: (3.12 * CAST_RATIO + Math.hypot(4.68, 5.72) * 0.5) * 1.4,
};
const atlasReport = {};
for (const e of man.entries) {
  const g = decodePng(fs.readFileSync(path.join(ROOT, 'assets/shadows/yaw', e.ground)));
  const s = decodePng(fs.readFileSync(path.join(ROOT, 'assets/shadows/yaw', e.self)));
  const cell = g.h;
  let sumY = 0;
  let mass = 0;
  let gDark = 0;
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const v = g.rgba[(y * g.w + x) * 4];
      if (v < 210) {
        gDark++;
        const m = (255 - v) / 255;
        sumY += y * m;
        mass += m;
      }
    }
  }
  let sDark = 0;
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      if (s.rgba[(y * s.w + x) * 4] < 240) sDark++;
    }
  }
  const cy = mass ? sumY / mass - cell / 2 : 0;
  atlasReport[e.id] = { half: e.groundHalfM, gDark, sDark, cy: +cy.toFixed(1) };
  // Cast must lean toward PNG +Y (world +Z / away from rock sun).
  if (cy < 2) fail.push(`${e.id} ground cy=${cy.toFixed(1)} (want >2 toward +Z)`);
  if (gDark < 20) fail.push(`${e.id} ground too empty dark=${gDark}`);
  if (['hq', 'barracks', 'refinery', 'infantry'].includes(e.id) && sDark < 10) {
    fail.push(`${e.id} self atlas still empty dark=${sDark}`);
  }
  const cap = MAX_HALF[e.id];
  if (cap && e.groundHalfM > cap) {
    fail.push(`${e.id} groundHalfM=${e.groundHalfM.toFixed(2)} > box-fit cap ${cap.toFixed(2)} (XZ-only bake?)`);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.css': 'text/css',
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
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({
  headless: true,
  channel: 'chrome',
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => {
  console.warn('pageerror', e.message);
  fail.push(`pageerror ${e.message}`);
});
page.on('console', (m) => {
  const t = m.text();
  if (/Shader Error|Program Info Log|yaw-shadows\] (tex fail|no manifest|empty)/i.test(t)) {
    console.warn('console', t.slice(0, 300));
    fail.push(`console ${t.slice(0, 120)}`);
  }
});

// B0 scenery = in-match rock props with the baked rock lightmap (the reference look).
await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1&scenery=B0`, {
  waitUntil: 'domcontentloaded',
  timeout: 180000,
});
await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
await page.waitForTimeout(4000);
fs.mkdirSync(path.dirname(SHOT), { recursive: true });
// Pre-gate lobby showcase (the view the user compares against).
const LOBBY_SHOT = SHOT.replace('.png', '-lobby.png');
await page.screenshot({ path: LOBBY_SHOT, fullPage: false });
await page.evaluate(() => window._dismissAppStartGate && window._dismissAppStartGate());
await page.waitForTimeout(1000);

await page.evaluate(() => {
  // Same toggle drives PCF and baked cookies — must be ON to see either.
  window._setDynamicShadowsEnabled?.(true);
  window._startGame('1v1');
});
await page.waitForFunction(() => {
  const o = document.getElementById('match-prepare-overlay');
  return !(o && !o.hidden);
}, null, { timeout: 300000 });
// Let the HQ lander finish its descent so its cookie/self-shadow are the landed state.
await page.waitForTimeout(16000);
// Camera: south of the player HQ (cast side), pitched -55° so cookies + rocks share the frame.
const camInfo = await page.evaluate(async (ver) => {
  const S = await import(`./js/state.js?v=${ver}`);
  let hq = null;
  S.buildings.forEach((b) => {
    if (!hq && b.type === 'hq' && b.playerId === 0) hq = b;
  });
  if (!hq) S.buildings.forEach((b) => { if (!hq && b.type === 'hq') hq = b; });
  const rig = document.getElementById('cameraRig')?.object3D;
  const cam = document.getElementById('camera')?.object3D;
  if (hq && rig && cam && window.THREE) {
    rig.position.set(hq.x, (hq.y || 0) + 34, hq.z + 26);
    rig.rotation.set(0, 0, 0);
    cam.position.set(0, 0, 0);
    cam.rotation.set(window.THREE.MathUtils.degToRad(-52), 0, 0);
  }
  return hq ? { x: hq.x, z: hq.z } : null;
}, VER);
await page.waitForTimeout(1500);

const live = await page.evaluate(() => {
  const scene = document.querySelector('a-scene')?.object3D;
  const cookies = [];
  scene?.traverse((o) => {
    if (!o.isInstancedMesh || !/^yawCookie_/.test(o.name || '')) return;
    cookies.push({ name: o.name, count: o.count, visible: o.visible });
  });
  return {
    ver: document.querySelector('meta[name="rts-version"]')?.content,
    cookies,
  };
});

if (live.ver !== VER) fail.push(`runtime ver ${live.ver} != ${VER}`);
const hqCookie = live.cookies.find((c) => c.name === 'yawCookie_hq');
if (!hqCookie || hqCookie.count < 1) fail.push('hq cookie count=0 in match (or menu)');
const barracksCookie = live.cookies.find((c) => c.name === 'yawCookie_barracks');
// barracks may be 0 if not built yet — only warn
await page.screenshot({ path: SHOT, fullPage: false });

console.log(
  JSON.stringify(
    {
      VER,
      atlasReport,
      live,
      shot: SHOT,
      lobbyShot: LOBBY_SHOT,
      camInfo,
      fail,
      barracksCookie,
    },
    null,
    2
  )
);

await browser.close();
server.close();
if (fail.length) {
  console.error('VERIFY FAIL', fail);
  process.exit(1);
}
console.log('VERIFY OK');
