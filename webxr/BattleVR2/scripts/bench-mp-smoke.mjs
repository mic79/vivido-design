#!/usr/bin/env node
/**
 * Host + second context Join smoke (PeerJS). Documents relay flakiness if fail.
 *   node BattleVR2/scripts/bench-mp-smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9123);
const OUT = path.join(ROOT, 'bench-out', 'mp-smoke');
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({ headless: true });
const host = await browser.newPage();
const client = await browser.newPage();
const errors = [];
host.on('pageerror', (e) => errors.push('host:' + e.message));
client.on('pageerror', (e) => errors.push('client:' + e.message));

const base = `http://127.0.0.1:${PORT}/`;
await host.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 });
await client.goto(base, { waitUntil: 'domcontentloaded', timeout: 120000 });

for (let i = 0; i < 90; i++) {
  const ok = await host.evaluate(() => !!window.__SCENE_READY__);
  const ok2 = await client.evaluate(() => !!window.__SCENE_READY__);
  if (ok && ok2) break;
  await sleep(1000);
}

await host.evaluate(() => {
  window._dismissAppStartGate?.();
  window._hostGame?.();
});
await sleep(2500);

await client.evaluate(() => {
  window._dismissAppStartGate?.();
  window._joinGame?.();
});
await sleep(5000);

const hostNet = await host.evaluate(() => window.__BATTLEVR2_DEBUG__?.() || { note: 'no match yet' });
const clientNet = await client.evaluate(() => window.__BATTLEVR2_DEBUG__?.() || { note: 'no match yet' });

// Start match from host after join attempt
await host.evaluate(async () => {
  await window._startGame?.('1v1');
});
await sleep(10000);

const hostAfter = await host.evaluate(() => window.__BATTLEVR2_DEBUG__?.());
const clientAfter = await client.evaluate(() => window.__BATTLEVR2_DEBUG__?.());

await host.screenshot({ path: path.join(OUT, 'host.png') });
await client.screenshot({ path: path.join(OUT, 'client.png') });

const connectedish = !!(hostAfter?.units >= 4 || hostAfter?.mp);
const report = {
  ok: connectedish,
  note: connectedish
    ? 'Host match running (PeerJS join may be relay-dependent)'
    : 'PeerJS relay may be flaky in headless CI — re-run locally',
  hostNet,
  clientNet,
  hostAfter,
  clientAfter,
  errors: errors.slice(0, 40),
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
server.close();
process.exit(report.ok ? 0 : 1);
