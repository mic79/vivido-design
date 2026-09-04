#!/usr/bin/env node
/**
 * Prove 1v1 = Overview rocks/dirt ON moon-textured plate (not bare moon, not black plate).
 *   node RTSVR5/bench-skirmish-groundscape.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8779);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await startStaticServer();
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('console', (msg) => {
      const t = msg.text();
      if (/groundscape|kit ready|moon|plate dressed|LOD skipped/i.test(t)) console.log('  [page]', t);
    });
    await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
      if (typeof window._setDynamicShadowsEnabled === 'function') window._setDynamicShadowsEnabled(false);
      window._startGame('1v1');
    });
    await page.waitForFunction(() => {
      const overlay = document.getElementById('match-prepare-overlay');
      return !(overlay && !overlay.hidden);
    }, null, { timeout: 300000 });
    await sleep(1000);
    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
    });
    await sleep(200);

    const dump = await page.evaluate(() => {
      const groundEl = document.getElementById('ground');
      const mesh = groundEl && groundEl.getObject3D && groundEl.getObject3D('mesh');
      const props = groundEl && groundEl.getObject3D && groundEl.getObject3D('overviewProps');
      let plate = null;
      let rockVis = 0;
      let dirtVis = 0;
      let sceneScale = null;
      if (mesh) {
        mesh.traverse((o) => {
          if (!o.isMesh || !o.visible) return;
          if (o.name === 'rts-kit-ground' || o.userData?.rtsMoonPlate) {
            plate = o;
            return;
          }
          const n = `${o.name || ''} ${o.parent && o.parent.name ? o.parent.name : ''}`;
          if (/SM_Rock/i.test(n)) rockVis++;
          if (/SM_Dirt/i.test(n)) dirtVis++;
        });
        for (let i = 0; i < mesh.children.length; i++) {
          const c = mesh.children[i];
          if (c.name === 'rts-kit-ground') continue;
          if (c.scale) sceneScale = c.scale.x;
        }
      }
      const mat = plate && plate.material;
      return {
        kitKind: mesh && mesh.userData && mesh.userData.rtsKitKind,
        separateProps: !!props,
        rockVis,
        dirtVis,
        hasPlate: !!plate,
        plateHasMap: !!(mat && mat.map),
        plateHasNormal: !!(mat && mat.normalMap),
        plateColor: mat && mat.color ? `#${mat.color.getHexString()}` : null,
        sceneScale,
      };
    });

    console.log('\n=== expect: overview kit + rocks/dirt + moon plate ===');
    console.log(JSON.stringify(dump, null, 2));

    let fail = 0;
    if (dump.kitKind !== 'overview') {
      console.error('FAIL not overview kit', dump.kitKind);
      fail = 1;
    }
    if (dump.separateProps) {
      console.error('FAIL leftover separate overviewProps (wrong architecture)');
      fail = 1;
    }
    if (dump.rockVis < 5) {
      console.error('FAIL rocks missing', dump.rockVis);
      fail = 1;
    }
    if (!dump.hasPlate || !dump.plateHasMap) {
      console.error('FAIL moon-textured plate missing', dump);
      fail = 1;
    }
    if (!(dump.sceneScale >= 3 && dump.sceneScale <= 20)) {
      console.error('FAIL unexpected groundscape scale', dump.sceneScale);
      fail = 1;
    }
    // Rocks must sit on the playable plate — prior bug left them at ~600–1100 m.
    if (dump.rockMaxD == null || dump.rockMaxD > 120) {
      console.error('FAIL rocks off playable plate', dump.rockMaxD);
      fail = 1;
    }
    if (!fail) console.log('PASS Overview rocks/dirt on moon-textured foundation');
    process.exit(fail);
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
