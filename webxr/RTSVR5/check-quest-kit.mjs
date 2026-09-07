#!/usr/bin/env node
/**
 * Prove default (and ?quest=1) load scifi-rts-quest.glb; ?noquest=1 keeps JPEG lod2.
 *
 *   node RTSVR5/check-quest-kit.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const QUEST_GLB = path.join(ROOT, 'assets/terrain/scifi-rts-quest.glb');
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
};

if (!fs.existsSync(QUEST_GLB) || fs.statSync(QUEST_GLB).size < 400_000) {
  console.error('FAIL missing scifi-rts-quest.glb — run scripts/compress-rts-quest.mjs');
  process.exit(1);
}

async function runCase(browser, label, query, expectQuest) {
  const fetched = [];
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/') rel = '/index.html';
    fetched.push(rel);
    const f = path.normalize(path.join(ROOT, rel));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404);
      res.end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html?perf=1${query}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 240000 });
  await page.evaluate(() => {
    if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    window._startGame('1v1');
  });
  await page.waitForFunction(
    () => {
      const o = document.getElementById('match-prepare-overlay');
      return !(o && !o.hidden);
    },
    null,
    { timeout: 300000 }
  );
  await page.waitForTimeout(2500);

  const st = await page.evaluate(() => {
    const g = document.getElementById('ground');
    const m = g && g.getObject3D && g.getObject3D('mesh');
    return {
      kind: m && m.userData && m.userData.rtsKitKind,
      url: m && m.userData && m.userData.rtsKitUrl,
      quest: !!(m && m.userData && m.userData.rtsKitQuest),
      diag: window.__rtsHudDiag && window.__rtsHudDiag.diag,
    };
  });
  await page.close();
  server.close();

  const gotQuest = fetched.some((u) => u.includes('scifi-rts-quest.glb'));
  const gotLod2 = fetched.some((u) => u.includes('scifi-rts-kit-lod2.glb'));
  let fail = 0;
  if (expectQuest && !gotQuest) {
    console.error(`FAIL ${label}: did not fetch quest GLB`, fetched.filter((u) => u.includes('.glb')));
    fail = 1;
  }
  if (expectQuest && !st.quest) {
    console.error(`FAIL ${label}: rtsKitQuest false`, st);
    fail = 1;
  }
  if (!expectQuest && !gotLod2) {
    console.error(`FAIL ${label}: did not fetch lod2`, { gotQuest, st });
    fail = 1;
  }
  if (!expectQuest && st.quest) {
    console.error(`FAIL ${label}: rtsKitQuest should be false`, st);
    fail = 1;
  }
  if (st.kind !== 'story') {
    console.error(`FAIL ${label}: kind`, st);
    fail = 1;
  }
  if (!fail) console.log(`PASS ${label}`, { url: st.url, quest: st.quest, diag: st.diag });
  return fail;
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-gl=angle', '--ignore-gpu-blocklist'],
});
let fail = 0;
fail |= await runCase(browser, 'default→quest', '', true);
fail |= await runCase(browser, 'noquest→lod2', '&noquest=1', false);
await browser.close();
process.exit(fail);
