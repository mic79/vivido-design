#!/usr/bin/env node
/**
 * One-shot: compose moon+Prop_Forest_* then bake planar ground cookies into the live GLB.
 * Same end asset as UE export → bake-rock-shadows (UE Python remote optional).
 *
 *   node RTSVR5Forest/scripts/rebuild-skirmish-forest-with-cookies.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1-forest-compose.glb');
const LIVE = path.join(ROOT, 'assets/terrain/terrain-skirmish-1v1.glb');

function run(script, env = {}) {
  console.log('>', 'node', script);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script)], {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
  if ((r.status || 0) !== 0) process.exit(r.status || 1);
}

run('compose-skirmish-forest.mjs', { PORT: process.env.COMPOSE_PORT || '8796' });
run('bake-rock-shadows.mjs', {
  GLB_PATH: COMPOSE,
  OUT_GLB: LIVE,
  PORT: process.env.BAKE_PORT || '8797',
});
console.log('PASS rebuild-skirmish-forest-with-cookies →', LIVE);
