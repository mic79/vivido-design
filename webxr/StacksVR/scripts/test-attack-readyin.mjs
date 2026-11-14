#!/usr/bin/env node
/** VERIFY: attack wire format uses readyIn (DodgeVR-style clock-safe sync). */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const attackSrc = fs.readFileSync(path.join(ROOT, 'attack.js'), 'utf8');
const game = fs.readFileSync(path.join(ROOT, 'stacks-game.js'), 'utf8');

function main() {
  assert(attackSrc.includes('readyIn'), 'serialize readyIn');
  assert(game.includes("kind: 'attack'"), 'host attack echo');
  assert(game.includes('placeMsg.attack = this.attackSys.serialize'), 'host place carries attack');

  const sandbox = { window: {}, performance: { now: () => 10000 } };
  vm.runInNewContext(attackSrc.replace('(window)', '(window)'), sandbox);
  const Attack = sandbox.window.StacksAttack;
  const a = new Attack({ damageDelayMs: 1500 });
  a.onClear('blue', { damage: 2, layersCleared: 2 }, 10000);
  const wire = a.serialize(10000);
  assert.strictEqual(wire.red.pending, 2);
  assert.strictEqual(wire.red.queue[0].readyIn, 1500);
  assert.strictEqual(wire.red.queue[0].readyAt, undefined);

  const b = new Attack();
  sandbox.performance.now = () => 50000;
  b.applySerialized(wire, 50000);
  assert.strictEqual(b.buffers.red.pending, 2);
  assert.strictEqual(b.buffers.red.queue[0].readyAt, 51500, 'receiver reconstructs local readyAt');

  console.log('PASS test-attack-readyin');
}

main();
