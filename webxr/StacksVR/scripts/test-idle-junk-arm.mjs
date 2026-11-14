#!/usr/bin/env node
/**
 * VERIFY: inactivity junk is optional + armed only after MATCH_ARM from GO
 * (not from match start). Idle clock resets at arm so openers stay clean.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const game = fs.readFileSync(path.join(ROOT, 'stacks-game.js'), 'utf8');
const lobby = fs.readFileSync(path.join(ROOT, 'lobby.js'), 'utf8');
const menu = fs.readFileSync(path.join(ROOT, 'game-menu.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function main() {
  assert(/INACTIVE_MATCH_ARM_MS\s*=\s*60000/.test(game), '60s match arm');
  assert(game.includes('_idleJunkEnabled'), 'toggle gate');
  assert(game.includes('if (!this._idleJunkEnabled()) return'), 'skips when off');
  assert(game.includes('if (!goAt || now < armAt) return'), 'no junk before arm');
  assert(game.includes('if (last < armAt) last = armAt'), 'idle clock starts at arm');
  assert(game.includes('this._matchGoAt = goNow'), 'records GO time');

  assert(lobby.includes('idleJunk: !!preferredIdleJunk'), 'lobby state field');
  assert(lobby.includes('function setIdleJunk'), 'setIdleJunk');
  assert(lobby.includes('function getIdleJunk'), 'getIdleJunk');
  assert(lobby.includes("type: 'idle-junk'"), 'peer can request toggle');
  assert(lobby.includes("data.type === 'idle-junk'"), 'host handles idle-junk');

  assert(menu.includes("case 'toggle-idle-junk'"), 'menu action');
  assert(menu.includes('_setIdleJunkButton'), 'menu UI');
  assert(html.includes('menu-idle-junk-toggle'), 'IDLE button in HUD');

  // Timing model
  var ARM = 60000;
  var GRACE = 10000;
  function firstJunkAt(goAt, lastPlaceAt) {
    var armAt = goAt + ARM;
    var last = lastPlaceAt < armAt ? armAt : lastPlaceAt;
    return last + GRACE;
  }
  var go = 1000;
  assert.strictEqual(firstJunkAt(go, go), go + ARM + GRACE,
    'no place → first junk at GO+70s');
  assert.strictEqual(firstJunkAt(go, go + 50000), go + ARM + GRACE,
    'place before arm does not arm early');
  assert.strictEqual(firstJunkAt(go, go + 65000), go + 65000 + GRACE,
    'place after arm extends idle from that place');

  // Toggle off simulation
  function shouldTick(enabled, now, goAt) {
    if (!enabled) return false;
    if (!goAt || now < goAt + ARM) return false;
    return true;
  }
  assert.strictEqual(shouldTick(false, go + 999999, go), false, 'off = never');
  assert.strictEqual(shouldTick(true, go + 30000, go), false, '30s still safe');
  assert.strictEqual(shouldTick(true, go + 60000, go), true, 'armed at 60s');

  console.log('PASS test-idle-junk-arm');
}

main();
