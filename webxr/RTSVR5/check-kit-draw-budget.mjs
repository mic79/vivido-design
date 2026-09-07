#!/usr/bin/env node
/**
 * Prove default Quest-90 scenery stays under the draw envelope (≲140 scenery draws).
 *
 *   node RTSVR5/check-kit-draw-budget.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
};

async function measure(browser, query) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const f = path.normalize(path.join(ROOT, rel));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); res.end('nf'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?perf=1&nobots=1${query}`, {
    waitUntil: 'domcontentloaded', timeout: 120000,
  });
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
  await page.evaluate(() => {
    if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    window._startGame('1v1');
  });
  await page.waitForFunction(() => {
    const o = document.getElementById('match-prepare-overlay');
    return !(o && !o.hidden);
  }, null, { timeout: 300000 });
  await page.waitForTimeout(3500);
  const st = await page.evaluate(() => {
    const sceneEl = document.querySelector('a-scene');
    const r = sceneEl && sceneEl.renderer;
    const ground = document.getElementById('ground');
    const kit = ground && ground.getObject3D && ground.getObject3D('mesh');
    // Hide everything except ground/kit for scenery-only draw count.
    const hide = [];
    if (ground && ground.object3D && ground.object3D.parent) {
      for (const ch of ground.object3D.parent.children) {
        if (ch !== ground.object3D && ch.visible) {
          hide.push(ch);
          ch.visible = false;
        }
      }
    }
    // Also hide A-Frame HUD / cursors under scene if present as siblings of camera
    if (r && sceneEl.camera) {
      r.info.reset();
      r.render(sceneEl.object3D, sceneEl.camera);
    }
    const draws = r && r.info.render ? r.info.render.calls : null;
    const tris = r && r.info.render ? r.info.render.triangles : null;
    const tex = r && r.info.memory ? r.info.memory.textures : null;
    for (const ch of hide) ch.visible = true;
    return {
      draws,
      tris,
      tex,
      kind: kit && kit.userData && kit.userData.rtsKitKind,
      url: kit && kit.userData && kit.userData.rtsKitUrl,
      quest: !!(kit && kit.userData && kit.userData.rtsKitQuest),
      diag: window.__rtsHudDiag && window.__rtsHudDiag.diag,
    };
  });
  await page.close();
  server.close();
  return st;
}

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});

let fail = 0;
const quest = await measure(browser, '');
const lod2 = await measure(browser, '&noquest=1');
await browser.close();

console.log('quest90', quest);
console.log('lod2', lod2);

// Use HUD draws if scenery-only hide returned 0 (A-Frame camera graph quirks).
const qDraws = quest.draws > 0 ? quest.draws : (quest.diag && /d=(\d+)/.exec(quest.diag) ? +RegExp.$1 : 9999);
const qTris = quest.tris > 0 ? quest.tris : (quest.diag && /tK=(\d+)/.exec(quest.diag) ? +RegExp.$1 * 1000 : 9999999);

if (!quest.quest || !/scifi-rts-quest/.test(quest.url || '')) {
  console.error('FAIL default is not quest90 GLB', quest);
  fail = 1;
}
if (qDraws > 140) {
  console.error('FAIL quest90 scenery draws over envelope', { qDraws, limit: 140 });
  fail = 1;
}
if (qTris > 2_500_000) {
  console.error('FAIL quest90 tris over soft cap', { qTris });
  fail = 1;
}
if (!fail) {
  console.log('PASS quest90 under draw envelope', { draws: qDraws, tris: qTris, tex: quest.tex });
}
process.exit(fail);
