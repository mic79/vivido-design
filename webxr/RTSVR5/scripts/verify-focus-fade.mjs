#!/usr/bin/env node
/**
 * Prove focus fade blacks out outside the blue ring (Focus cull ON).
 *
 *   node RTSVR5/scripts/verify-focus-fade.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'verify-focus-fade-out');
const PORT = 8821;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function startStaticServer(root, port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(root, rel));
    if (!filePath.startsWith(root) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal PNG reader → { w, h, rgba Uint8Array } (8-bit RGB or RGBA). */
function decodePngRgba(buf) {
  if (buf[0] !== 0x89) throw new Error('not png');
  let off = 8;
  let w = 0;
  let h = 0;
  let colorType = 6;
  const idats = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`need 8-bit RGB/RGBA png, got ${data[8]}/${colorType}`);
      }
    } else if (type === 'IDAT') idats.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const inflated = zlib.inflateSync(Buffer.concat(idats));
  const stride = w * bpp;
  const raw = new Uint8Array(w * h * bpp);
  let src = 0;
  for (let y = 0; y < h; y++) {
    const filter = inflated[src++];
    const row = inflated.subarray(src, src + stride);
    src += stride;
    const dst = y * stride;
    if (filter === 0) raw.set(row, dst);
    else if (filter === 1) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? raw[dst + i - bpp] : 0;
        raw[dst + i] = (row[i] + left) & 255;
      }
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) {
        const up = y > 0 ? raw[dst - stride + i] : 0;
        raw[dst + i] = (row[i] + up) & 255;
      }
    } else if (filter === 3) {
      // Average of left + up
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? raw[dst + i - bpp] : 0;
        const up = y > 0 ? raw[dst - stride + i] : 0;
        raw[dst + i] = (row[i] + Math.floor((left + up) / 2)) & 255;
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? raw[dst + i - bpp] : 0;
        const up = y > 0 ? raw[dst - stride + i] : 0;
        const upLeft = y > 0 && i >= bpp ? raw[dst - stride + i - bpp] : 0;
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        raw[dst + i] = (row[i] + pred) & 255;
      }
    } else throw new Error(`unsupported png filter ${filter}`);
  }
  if (bpp === 4) return { w, h, rgba: raw };
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0, j = 0; i < raw.length; i += 3, j += 4) {
    rgba[j] = raw[i];
    rgba[j + 1] = raw[i + 1];
    rgba[j + 2] = raw[i + 2];
    rgba[j + 3] = 255;
  }
  return { w, h, rgba };
}

function sampleLuma(rgba, w, h, x, y, rad = 6) {
  let sum = 0;
  let n = 0;
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      const xx = Math.max(0, Math.min(w - 1, x + dx));
      const yy = Math.max(0, Math.min(h - 1, y + dy));
      const i = (yy * w + xx) * 4;
      sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
      n++;
    }
  }
  return sum / n;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startStaticServer(ROOT, PORT);
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const report = { ok: false, veil: null, luma: null, error: null };
  try {
    const url = `http://127.0.0.1:${PORT}/index.html?focusCull=1&storySeed=42&perf=1`;
    console.log('goto', url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 180000 });
    await page.evaluate(() => {
      window._dismissAppStartGate?.();
      window._setFocusCullEnabled?.(true);
    });
    await page.evaluate(() => window._startGame('story'));
    await page.waitForFunction(() => {
      const overlay = document.getElementById('match-prepare-overlay');
      return !(overlay && !overlay.hidden);
    }, null, { timeout: 300000 });
    await sleep(2500);
    await page.evaluate(async () => {
      const State = await import('./js/state.js');
      const Input = await import('./js/input.js');
      if (!State.gameSession.gameStarted) throw new Error('story did not start');
      window._setFocusCullEnabled?.(true);
      Input.positionCameraForPlayer(State.gameSession.myPlayerId);
      // Pull camera up a bit so more of the fade band is on screen
      const cam = Input.getCameraState();
      if (cam) cam.y = Math.max(cam.y || 40, 70);
    });
    await sleep(1200);
    await page.evaluate(() => window._setFocusCullEnabled?.(true));
    await sleep(400);

    report.veil = await page.evaluate(() => {
      const sc = document.querySelector('a-scene');
      const cam = sc && sc.camera;
      let veil = cam?.getObjectByName?.('rts-focus-fade-veil') || null;
      if (!veil) {
        sc?.object3D?.traverse((o) => {
          if (o.name === 'rts-focus-fade-veil') veil = o;
        });
      }
      const u = veil?.material?.uniforms;
      return {
        found: !!veil,
        visible: !!veil?.visible,
        parentIsCamera: !!(veil && cam && veil.parent === cam),
        strength: u?.uStrength?.value ?? null,
        innerR: u?.uInnerR?.value ?? null,
        outerR: u?.uOuterR?.value ?? null,
        center: u?.uCenter?.value ? [u.uCenter.value.x, u.uCenter.value.y] : null,
        cullEnabled: window._getFocusCullEnabled?.() ?? null,
      };
    });
    console.log('veil', report.veil);

    const shotPath = path.join(OUT, 'focus-fade.png');
    await page.screenshot({ path: shotPath, type: 'png' });
    const png = fs.readFileSync(shotPath);
    const { w, h, rgba } = decodePngRgba(png);

    // Find cyan/blue ring pixels, then sample just outside vs inside along the radial.
    const ringPts = [];
    for (let y = 40; y < h - 80; y += 2) {
      for (let x = 40; x < w - 40; x += 2) {
        const i = (y * w + x) * 4;
        const r = rgba[i];
        const g = rgba[i + 1];
        const b = rgba[i + 2];
        // Blue ribbon ~#3399ff
        if (b > 140 && b > r + 40 && b > g + 10 && g > 80) ringPts.push(x, y);
      }
    }
    let outSum = 0;
    let inSum = 0;
    let nPair = 0;
    const cx = w * 0.5;
    const cy = h * 0.72; // focus center tends toward lower half in spawn view
    for (let i = 0; i + 1 < Math.min(ringPts.length, 400); i += 2) {
      const x = ringPts[i];
      const y = ringPts[i + 1];
      const dx = x - cx;
      const dy = y - cy;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      // 28px outside the ring along radial; 28px inside
      const ox = Math.max(0, Math.min(w - 1, Math.round(x + ux * 28)));
      const oy = Math.max(0, Math.min(h - 1, Math.round(y + uy * 28)));
      const ix = Math.max(0, Math.min(w - 1, Math.round(x - ux * 28)));
      const iy = Math.max(0, Math.min(h - 1, Math.round(y - uy * 28)));
      outSum += sampleLuma(rgba, w, h, ox, oy, 3);
      inSum += sampleLuma(rgba, w, h, ix, iy, 3);
      nPair++;
    }
    const outsideRing = nPair > 8 ? outSum / nPair : 999;
    const insideRing = nPair > 8 ? inSum / nPair : 0;
    const mid = sampleLuma(rgba, w, h, (w / 2) | 0, (h * 0.55) | 0, 12);
    report.luma = {
      w,
      h,
      ringPts: ringPts.length / 2,
      pairs: nPair,
      outsideRing,
      insideRing,
      mid,
    };
    console.log('luma', report.luma);

    const veilLive =
      report.veil?.found &&
      report.veil?.visible &&
      report.veil?.parentIsCamera &&
      report.veil?.strength === 1 &&
      report.veil?.cullEnabled === true &&
      Number(report.veil?.innerR) > 0.05 &&
      Number(report.veil?.outerR) > Number(report.veil?.innerR);
    // Outside samples must be near-black; inside must stay clearly brighter.
    const pixelsOk =
      nPair > 8 && outsideRing < 18 && insideRing > 22 && insideRing > outsideRing * 2.2;
    report.ok = !!(veilLive && pixelsOk);
    if (!veilLive) report.error = 'veil not live';
    else if (nPair <= 8) report.error = `could not find blue ring pixels (n=${nPair})`;
    else if (!pixelsOk) {
      report.error = `ring-adjacent fail outside=${outsideRing.toFixed(1)} inside=${insideRing.toFixed(1)} mid=${mid.toFixed(1)}`;
    }
  } catch (err) {
    report.error = String(err && err.stack ? err.stack : err);
    console.error(report.error);
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(report.ok ? 'PASS' : 'FAIL', report.error || '');
  process.exit(report.ok ? 0 : 1);
}

main();
