#!/usr/bin/env node
/**
 * Sample system-wide process CPU + NVIDIA GPU while VR is running.
 * Aligns with wall-clock seconds so an FPS decay trace can be correlated later.
 *
 *   node RTSVR5/sample-xr-processes.mjs
 *   DURATION_S=180 INTERVAL_MS=1000 node RTSVR5/sample-xr-processes.mjs
 *
 * Watches Meta Link / Oculus, Virtual Desktop, Chrome, and top-N CPU offenders.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DURATION_S = Number(process.env.DURATION_S || 180);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 1000);
const OUT = path.join(ROOT, process.env.OUT || 'proof-xr-processes.json');

const WATCH =
  /^(chrome|msedge|OVRServer_x64|OculusDash|oculus-platform-runtime|oculus-client|VirtualDesktop\.Streamer|VirtualDesktop\.Service|vrmonitor|vrserver|vrcompositor|steam|Meta Quest|OVRRedir|RuntimeBroker)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function psSnapshot() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
Get-Process | ForEach-Object {
  [PSCustomObject]@{
    id = $_.Id
    name = $_.ProcessName
    cpu = [double]($_.CPU)
    wsMB = [math]::Round($_.WorkingSet64/1MB,1)
  }
} | ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-Command', script],
    { maxBuffer: 20 * 1024 * 1024, windowsHide: true }
  );
  const data = JSON.parse(stdout || '[]');
  return Array.isArray(data) ? data : [data];
}

async function nvidiaSnapshot() {
  const smi = 'C:\\Windows\\System32\\nvidia-smi.exe';
  if (!fs.existsSync(smi)) return null;
  try {
    const { stdout: gpu } = await execFileAsync(
      smi,
      [
        '--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,power.draw,clocks.sm,temperature.gpu,pstate',
        '--format=csv,noheader,nounits',
      ],
      { windowsHide: true }
    );
    const parts = gpu.trim().split(',').map((s) => s.trim());
    return {
      utilGpu: Number(parts[0]),
      utilEnc: Number(parts[1]),
      utilDec: Number(parts[2]),
      powerW: Number(parts[3]),
      smMHz: Number(parts[4]),
      tempC: Number(parts[5]),
      pstate: parts[6],
    };
  } catch {
    return null;
  }
}

function deltaCpu(prev, cur) {
  const map = new Map();
  for (const p of prev) map.set(p.id, p.cpu);
  return cur
    .map((p) => ({
      id: p.id,
      name: p.name,
      dCpu: Math.max(0, (p.cpu || 0) - (map.get(p.id) || p.cpu || 0)),
      wsMB: p.wsMB,
    }))
    .filter((p) => p.dCpu > 0.01);
}

function summarize(deltas) {
  const watched = deltas
    .filter((p) => WATCH.test(p.name))
    .sort((a, b) => b.dCpu - a.dCpu);
  const top = [...deltas].sort((a, b) => b.dCpu - a.dCpu).slice(0, 12);
  const byName = {};
  for (const p of watched) {
    byName[p.name] = (byName[p.name] || 0) + p.dCpu;
  }
  return { watched: byName, top: top.map((p) => ({ name: p.name, id: p.id, dCpu: +p.dCpu.toFixed(3), wsMB: p.wsMB })) };
}

async function main() {
  console.log(`XR process soak — ${DURATION_S}s @ ${INTERVAL_MS}ms`);
  console.log('Put the headset on NOW (Meta Link or VD), load the scene, stay in 1v1.\n');
  const t0 = Date.now();
  let prev = await psSnapshot();
  await sleep(INTERVAL_MS);
  const rows = [];
  const n = Math.floor(DURATION_S / (INTERVAL_MS / 1000));
  for (let i = 0; i < n; i++) {
    const cur = await psSnapshot();
    const gpu = await nvidiaSnapshot();
    const sec = Math.round((Date.now() - t0) / 1000);
    const sum = summarize(deltaCpu(prev, cur));
    rows.push({ sec, gpu, watched: sum.watched, top: sum.top });
    const w = sum.watched;
    const bits = Object.entries(w)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `${k}:${v.toFixed(2)}`)
      .join(' ');
    const g = gpu
      ? `gpu=${gpu.utilGpu}% enc=${gpu.utilEnc}% ${gpu.powerW}W ${gpu.smMHz}MHz`
      : 'gpu=?';
    console.log(`t=${String(sec).padStart(3)}s  ${g}  |  ${bits}`);
    prev = cur;
    await sleep(INTERVAL_MS);
  }
  fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), durationS: DURATION_S, rows }, null, 2));
  console.log(`\nWrote ${OUT}`);

  // Compare early vs late windows for watched processes.
  const early = rows.filter((r) => r.sec >= 5 && r.sec <= 30);
  const late = rows.filter((r) => r.sec >= Math.max(60, DURATION_S - 40));
  const meanWatch = (arr) => {
    const acc = {};
    const n = arr.length || 1;
    for (const r of arr) {
      for (const [k, v] of Object.entries(r.watched || {})) acc[k] = (acc[k] || 0) + v;
    }
    for (const k of Object.keys(acc)) acc[k] = +(acc[k] / n).toFixed(3);
    return acc;
  };
  const meanGpu = (arr, key) => {
    const vals = arr.map((r) => r.gpu && r.gpu[key]).filter((v) => Number.isFinite(v));
    return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
  };
  const e = meanWatch(early);
  const l = meanWatch(late);
  console.log('\n=== early (5–30s) vs late (last ~40s) mean CPU-sec / sample ===');
  const names = new Set([...Object.keys(e), ...Object.keys(l)]);
  for (const name of [...names].sort()) {
    const a = e[name] || 0;
    const b = l[name] || 0;
    const d = b - a;
    console.log(
      `  ${name.padEnd(28)} early=${a.toFixed(3)}  late=${b.toFixed(3)}  Δ=${d >= 0 ? '+' : ''}${d.toFixed(3)}`
    );
  }
  console.log('\n=== GPU means ===');
  console.log(
    `  early util=${meanGpu(early, 'utilGpu')}% enc=${meanGpu(early, 'utilEnc')}%  |  late util=${meanGpu(late, 'utilGpu')}% enc=${meanGpu(late, 'utilEnc')}%`
  );
  console.log(
    `  early power=${meanGpu(early, 'powerW')}W sm=${meanGpu(early, 'smMHz')}  |  late power=${meanGpu(late, 'powerW')}W sm=${meanGpu(late, 'smMHz')}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
