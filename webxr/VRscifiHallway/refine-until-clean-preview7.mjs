/**
 * Multi-seed PVS refine for preview7 until N consecutive virgin seeds pass round 1.
 * Usage: node refine-until-clean-preview7.mjs
 * Env: PASS_N=2 (default), SEED0=100000
 */
import { spawn } from 'child_process';

const PASS_N = Number(process.env.PASS_N || 2);
const SEED0 = Number(process.env.SEED0 || 100000);

function run(envExtra) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...envExtra };
    if (!('REFINE' in envExtra) || !envExtra.REFINE) delete env.REFINE;
    const child = spawn(process.execPath, ['verify-pvs-preview7.mjs'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });
    let out = '';
    child.stdout.on('data', (d) => { const s = d.toString(); out += s; process.stdout.write(s); });
    child.stderr.on('data', (d) => { const s = d.toString(); out += s; process.stderr.write(s); });
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', reject);
  });
}

async function main() {
  let streak = 0;
  let seed = SEED0;
  while (streak < PASS_N) {
    console.log(`\n=== virgin seed ${seed} (streak ${streak}/${PASS_N}) ===`);
    let r = await run({ SEED: String(seed) });
    if (r.code === 0 && /failCount":0/.test(r.out)) {
      streak++;
      console.log(`PASS streak ${streak}/${PASS_N}`);
    } else {
      console.log('FAIL — refining this seed…');
      r = await run({ SEED: String(seed), REFINE: '1' });
      if (r.code !== 0) {
        console.error('Refine did not converge on this seed');
        process.exit(1);
      }
      streak = 0;
    }
    seed++;
  }
  console.log(`\nDONE — ${PASS_N} consecutive virgin seeds clean`);
}

main().catch((e) => { console.error(e); process.exit(1); });
