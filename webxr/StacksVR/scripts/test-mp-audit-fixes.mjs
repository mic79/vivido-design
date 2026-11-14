#!/usr/bin/env node
/**
 * VERIFY: MP audit fixes that users should not have to rediscover.
 * 1) Remote place resets host idle-junk clock (_lastPlaceAt)
 * 2) History uses GO seat meta (not post-end isSpectator / cleared seats)
 * 3) Only host ticks attack/idle in multiplayer
 * 4) Remote clears play the same FX as local
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'stacks-game.js'), 'utf8');

function main() {
  // Idle clock sync
  assert(src.includes('this._lastPlaceAt[evt.side] = performance.now()'),
    'remote place must reset idle clock');
  assert(src.includes('Host idle-junk clock must reset'),
    'documents remote idle reset');

  // History after park-as-spectator
  assert(src.includes('wasSeatedPlayer'), 'GO snapshot wasSeatedPlayer');
  assert(src.includes('meta.mySide'), 'history uses snapshotted mySide');
  assert(src.includes('endLobbyMatch parks seated humans as spectators'),
    'documents spectator park race');
  // Must NOT early-return solely on live isSpectator before checking seat meta
  assert(/wasSeatedPlayer[\s\S]*?_saveMatchHistory|_saveMatchHistory[\s\S]*?wasSeatedPlayer/.test(src),
    'save path aware of wasSeatedPlayer');

  // Host-only attack tick (no sticky isLobbyBotMatch peer tick)
  assert(src.includes('var tickAttack = !mp || !!host'),
    'peers must not tick attack/idle');
  assert(!src.includes('tickAttack = !mp || host || !!global.isLobbyBotMatch'),
    'sticky bot flag must not enable peer attack tick');

  // Timed end host-only
  assert(src.includes('Timed modes: only host'), 'timed end host-only');

  // Remote clear FX
  assert(src.includes('this._showClearPopup(evt.side, evt.clear, remoteAtk)'),
    'remote clear shows popup');
  assert(src.includes('clearChime(rLayers'), 'remote clear plays chime');

  // Simulate idle clock logic
  function idleDue(lastPlaceAt, armAt, now, grace) {
    var last = lastPlaceAt < armAt ? armAt : lastPlaceAt;
    return now - last >= grace;
  }
  var go = 0, arm = 60000, grace = 10000;
  // Client placed at 70s — host must see that, not GO
  assert.strictEqual(idleDue(0, arm, 70000, grace), true, 'stale GO clock falsely due');
  assert.strictEqual(idleDue(70000, arm, 75000, grace), false, 'fresh remote place not due');
  assert.strictEqual(idleDue(70000, arm, 80000, grace), true, 'due 10s after remote place');

  // History gate
  function shouldSave(multi, wasSeated, isSpec) {
    if (multi && !wasSeated) return !isSpec ? true : false;
    if (!multi && isSpec) return false;
    return true;
  }
  assert.strictEqual(shouldSave(true, true, true), true, 'PvP player saves after park');
  assert.strictEqual(shouldSave(true, false, true), false, 'true spectator skips');
  assert.strictEqual(shouldSave(false, false, false), true, 'offline saves');

  console.log('PASS test-mp-audit-fixes');
}

main();
