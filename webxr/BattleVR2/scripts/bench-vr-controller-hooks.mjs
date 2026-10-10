#!/usr/bin/env node
/**
 * Assert VR controller hooks exist after boot/match (laser RTS + FP sticks + board).
 *   node BattleVR2/scripts/bench-vr-controller-hooks.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9129);
const OUT = path.join(ROOT, 'bench-out', 'vr-controller-hooks');
fs.mkdirSync(OUT, { recursive: true });

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
for (let i = 0; i < 90; i++) {
  if (await page.evaluate(() => !!window.__SCENE_READY__ && !!window.__BATTLEVR2_BOOT__)) break;
  await sleep(1000);
}

await page.evaluate(async () => {
  window._dismissAppStartGate?.();
  if (typeof window._startGame === 'function') await window._startGame('1v1');
});
for (let i = 0; i < 90; i++) {
  if (await page.evaluate(() => !!window.__BATTLEVR2_MATCH__)) break;
  await sleep(500);
}
await sleep(800);

const probe = await page.evaluate(() => {
  const left = document.getElementById('leftHand');
  const right = document.getElementById('rightHand');
  const boardBtn = document.getElementById('vr-btn-board');
  const ray = document.getElementById('rightHandRay');
  return {
    boot: window.__BATTLEVR2_BOOT__,
    match: !!window.__BATTLEVR2_MATCH__,
    fpInput: typeof window.__BATTLEVR2_FP_INPUT__ === 'function',
    boardHook: typeof window._battleVr2Board === 'function',
    tryBoard: typeof window.__BATTLEVR2_TRY_BOARD__ === 'function',
    leftHand: !!left,
    rightHand: !!right,
    rightLaserControls: !!(right && right.getAttribute('laser-controls')),
    rightRaycaster: !!(ray && ray.getAttribute('raycaster')),
    boardBtn: !!boardBtn,
    boardBtnAction: (() => {
      const raw = boardBtn?.getAttribute('rts-vr-menu-btn');
      if (!raw) return null;
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'object' && raw.action) return String(raw.action);
      return String(raw);
    })(),
    menu1v1: !!document.querySelector('[rts-vr-menu-btn="action: 1v1"]'),
    appStart: !!document.querySelector('[rts-vr-menu-btn="action: app_start"]'),
  };
});

const ok = !!(
  probe.match &&
  probe.fpInput &&
  probe.boardHook &&
  probe.leftHand &&
  probe.rightHand &&
  probe.rightLaserControls &&
  probe.rightRaycaster &&
  probe.boardBtn &&
  String(probe.boardBtnAction || '') === 'board' ||
    String(probe.boardBtnAction || '').includes('board')
);

const report = { ok, probe, errors: errors.slice(0, 20) };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
