#!/usr/bin/env node
/**
 * Desktop ?leanrocks=1 must keep the Story kit resident + lean look.
 * Explicit ?rocksfile= / ?leanrocksFile=1 still selects the rocks GLB.
 *
 *   node RTSVR5/check-leanrocks-desktop-remap.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9138);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.hdr': 'application/octet-stream' };

function serve() {
  const s = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const f = path.normalize(path.join(ROOT, rel));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404);
      res.end('nf');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(PORT, '127.0.0.1', () => resolve(s));
  });
}

async function probe(page, query) {
  await page.goto(`http://127.0.0.1:${PORT}/index.html?${query}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  return page.evaluate(async () => {
    const c = await import('./js/config.js');
    return {
      kit: c.skirmishKitKind(),
      lean: c.leanRocksStoryLeanRequested(),
      rocksGlb: c.rocksGlbLoadRequested(),
      desktop: c.isDesktopPcvrHost(),
    };
  });
}

async function main() {
  const server = await serve();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const fails = [];
  try {
    const cases = [
      ['', { kit: 'story', lean: false, rocksGlb: false }],
      ['leanrocks=1', { kit: 'story', lean: true, rocksGlb: false }],
      ['leanlook=1', { kit: 'story', lean: true, rocksGlb: false }],
      ['leanrocks=1&rocksfile=scifi-rts-rocks-tenth', { kit: 'rocks', lean: false, rocksGlb: true }],
      ['leanrocksFile=1', { kit: 'rocks', lean: false, rocksGlb: true }],
    ];
    for (const [q, want] of cases) {
      const got = await probe(page, q);
      const ok = got.kit === want.kit && got.lean === want.lean && got.rocksGlb === want.rocksGlb;
      console.log(`${ok ? 'OK' : 'FAIL'} ?${q || '(none)'} →`, got);
      if (!got.desktop) fails.push('expected desktop host in this Playwright Chromium');
      if (!ok) fails.push(`?${q}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (fails.length) {
    for (const f of fails) console.error(f);
    process.exit(1);
  }
  console.log('\nPASS — desktop leanrocks remaps to story+lean; rocksfile still loads rocks GLB.');
  process.exit(0);
}

main();
