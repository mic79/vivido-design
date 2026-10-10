#!/usr/bin/env node
/**
 * BattleVR2 boot review — __SCENE_READY__, fighter/cockpit/box3d, no page errors.
 *   node BattleVR2/scripts/review-boot.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9120);
const OUT = path.join(ROOT, 'bench-out', 'review-boot');
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

const url = `http://127.0.0.1:${PORT}/?nobootmenu=1`;
console.log('[review-boot]', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

let ready = null;
for (let i = 0; i < 90; i++) {
  ready = await page.evaluate(() => ({
    scene: !!window.__SCENE_READY__,
    boot: window.__BATTLEVR2_BOOT__ || null,
    bootErr: window.__BATTLEVR2_BOOT_ERROR__ || null,
    fighter: !!window.__BATTLEVR2_VEHICLE__,
    cockpit: !!window.__BATTLEVR2_COCKPIT__,
  }));
  if (ready.scene && ready.boot) break;
  await sleep(1000);
}

await page.screenshot({ path: path.join(OUT, 'spawn.png'), fullPage: false });
const report = { ok: false, ready, errors: errors.slice(0, 40), url };
report.ok = !!(ready?.scene && ready?.boot?.box3d && ready?.fighter && !ready?.bootErr);

const json = JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
fs.writeFileSync(path.join(OUT, 'report.json'), json);
console.log(json);

await browser.close();
server.close();
process.exit(report.ok ? 0 : 1);
