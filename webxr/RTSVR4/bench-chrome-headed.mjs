#!/usr/bin/env node
/**
 * Headed Google Chrome on this machine — same GPU/display path as the user.
 * Does not disable vsync. Does not change the game.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8768);
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 4000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'application/json',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function startStaticServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installRenderCounters(page, keepalive) {
  return page.evaluate((keepalive) => {
    const sc = document.querySelector('a-scene');
    const r = sc && sc.renderer;
    if (!r) return false;
    if (!sc.__rtsCompPatched) {
      sc.__rtsCompPatched = true;
      sc.__rtsCompMs = {};
      const kinds = ['tick', 'tock'];
      const order = sc.componentOrder || [];
      for (let i = 0; i < order.length; i++) {
        const cname = order[i];
        const behaviors = sc.behaviors && sc.behaviors[cname];
        if (!behaviors) continue;
        for (let k = 0; k < kinds.length; k++) {
          const kind = kinds[k];
          const set = behaviors[kind];
          if (!set || !set.array) continue;
          for (let j = 0; j < set.array.length; j++) {
            const comp = set.array[j];
            if (!comp || typeof comp[kind] !== 'function' || comp[kind].__rtsTimed) continue;
            const orig = comp[kind].bind(comp);
            const key = kind + ':' + cname + (comp.el && comp.el.id ? '#' + comp.el.id : '');
            sc.__rtsCompMs[key] = 0;
            const wrapped = function () {
              const t0 = performance.now();
              orig.apply(this, arguments);
              sc.__rtsCompMs[key] += performance.now() - t0;
            };
            wrapped.__rtsTimed = true;
            comp[kind] = wrapped;
          }
        }
      }
    }
    if (!sc.__rtsPhaseWrapped) {
      sc.__rtsPhaseWrapped = true;
      sc.__rtsPhase = { n: 0, frames: 0, tick: 0, render: 0, tock: 0, gap: 0, interval: 0, tickMax: 0, renderMax: 0, last: performance.now() };
      const origTick = sc.tick.bind(sc);
      const origTock = sc.tock.bind(sc);
      sc.tick = function () {
        const t0 = performance.now();
        origTick.apply(this, arguments);
        const dt = performance.now() - t0;
        sc.__rtsPhase.tick += dt;
        sc.__rtsPhase.frames++;
        if (dt > sc.__rtsPhase.tickMax) sc.__rtsPhase.tickMax = dt;
      };
      sc.tock = function () {
        const t0 = performance.now();
        origTock.apply(this, arguments);
        const dt = performance.now() - t0;
        sc.__rtsPhase.tock += dt;
      };
      const origSceneRender = sc.render.bind(sc);
      sc.render = function (time, frame) {
        const now = performance.now();
        const ph = sc.__rtsPhase;
        if (ph.n > 0) ph.gap += Math.max(0, now - ph.last - 0.0001);
        ph.interval += now - ph.last;
        ph.last = now;
        origSceneRender(time, frame);
        ph.n++;
      };
    }
    if (!r.__rtsProbeWrappedOnce) {
      r.__rtsProbeWrappedOnce = true;
      r.__rtsProbeEnter = 0;
      r.__rtsProbeOrig = 0;
      r.__rtsProbeSkipFlag = 0;
      r.__rtsProbeKeepN = 0;
      r.__rtsThreeRender = r.render;
      r.render = function (scene, camera) {
        r.__rtsProbeEnter++;
        const t0 = performance.now();
        const ka = r.__rtsKeepalive || '';
        if (sc.__rtsSkipRender) {
          r.__rtsProbeSkipFlag++;
          if (ka === 'empty') {
            const THREE = window.THREE;
            if (THREE) {
              if (!r.__rtsEmptyScene) r.__rtsEmptyScene = new THREE.Scene();
              const prevClear = r.autoClear;
              r.autoClear = false;
              sc.__rtsSkipRender = false;
              r.__rtsThreeRender.call(this, r.__rtsEmptyScene, camera);
              sc.__rtsSkipRender = true;
              r.autoClear = prevClear;
              r.__rtsProbeOrig++;
              const dt = performance.now() - t0;
              sc.__rtsPhase.render += dt;
              if (dt > sc.__rtsPhase.renderMax) sc.__rtsPhase.renderMax = dt;
              return;
            }
          }
          if (ka === 'nth8') {
            r.__rtsProbeKeepN = (r.__rtsProbeKeepN || 0) + 1;
            if (r.__rtsProbeKeepN % 8 === 0) {
              sc.__rtsSkipRender = false;
              r.__rtsProbeOrig++;
              const out = r.__rtsThreeRender.apply(this, arguments);
              const dt = performance.now() - t0;
              sc.__rtsPhase.render += dt;
              if (dt > sc.__rtsPhase.renderMax) sc.__rtsPhase.renderMax = dt;
              return out;
            }
          }
          const skipped = r.__rtsThreeRender.apply(this, arguments);
          const dtSkip = performance.now() - t0;
          sc.__rtsPhase.render += dtSkip;
          if (dtSkip > sc.__rtsPhase.renderMax) sc.__rtsPhase.renderMax = dtSkip;
          return skipped;
        }
        r.__rtsProbeOrig++;
        const out = r.__rtsThreeRender.apply(this, arguments);
        const dt = performance.now() - t0;
        sc.__rtsPhase.render += dt;
        if (dt > sc.__rtsPhase.renderMax) sc.__rtsPhase.renderMax = dt;
        return out;
      };
    }
    r.__rtsKeepalive = keepalive || '';
    r.__rtsProbeKeepN = 0;
    return true;
  }, keepalive || '');
}

async function sample(page, name, keepalive) {
  await installRenderCounters(page, keepalive);
  const t0 = Date.now();
  const rows = [];
  const probe0 = await page.evaluate(() => {
    const sc = document.querySelector('a-scene');
    const r = sc && sc.renderer;
    return {
      enter: (r && r.__rtsProbeEnter) || 0,
      orig: (r && r.__rtsProbeOrig) || 0,
      skipFlag: (r && r.__rtsProbeSkipFlag) || 0,
      frame: r && r.info && r.info.render ? r.info.render.frame | 0 : -1,
    };
  });
  await page.evaluate(() => {
    if (window.__rtsPerf && typeof window.__rtsPerf.resetSamples === 'function') {
      window.__rtsPerf.resetSamples();
    }
    const sc = document.querySelector('a-scene');
    if (sc && sc.__rtsPhase) {
      sc.__rtsPhase.n = 0;
      sc.__rtsPhase.frames = 0;
      sc.__rtsPhase.tick = 0;
      sc.__rtsPhase.render = 0;
      sc.__rtsPhase.tock = 0;
      sc.__rtsPhase.gap = 0;
      sc.__rtsPhase.interval = 0;
      sc.__rtsPhase.tickMax = 0;
      sc.__rtsPhase.renderMax = 0;
      sc.__rtsPhase.last = performance.now();
    }
    if (sc && sc.__rtsCompMs) {
      const keys = Object.keys(sc.__rtsCompMs);
      for (let i = 0; i < keys.length; i++) sc.__rtsCompMs[keys[i]] = 0;
    }
  });
  while (Date.now() - t0 < SAMPLE_MS) {
    rows.push(
      await page.evaluate(() => {
        const sc = document.querySelector('a-scene');
        const r = sc && sc.renderer;
        const info = r && r.info && r.info.render;
        const hud = document.getElementById('hud-version-fps');
        const hudText = hud ? hud.textContent : '';
        const m = /([0-9]+)\s*FPS/.exec(hudText || '');
        return {
          skip: !!(sc && sc.__rtsSkipRender),
          calls: info ? info.calls | 0 : -1,
          tris: info ? info.triangles | 0 : -1,
          fpsHud: m ? Number(m[1]) : null,
          hudText,
          camKey: window.__rtsCamSkipKey || '',
        };
      })
    );
    await sleep(200);
  }
  const probe1 = await page.evaluate(() => {
    const sc = document.querySelector('a-scene');
    const r = sc && sc.renderer;
    const p = window.__rtsPerf && typeof window.__rtsPerf.snapshot === 'function' ? window.__rtsPerf.snapshot() : null;
    const ph = sc && sc.__rtsPhase;
    const n = (ph && ph.frames) || (ph && ph.n) || 1;
    const comp = sc && sc.__rtsCompMs ? sc.__rtsCompMs : {};
    const compTop = Object.keys(comp)
      .map((k) => ({ k, ms: comp[k] / n, sum: comp[k] }))
      .filter((x) => x.sum > 0.5)
      .sort((a, b) => b.sum - a.sum)
      .slice(0, 12);
    return {
      enter: (r && r.__rtsProbeEnter) || 0,
      orig: (r && r.__rtsProbeOrig) || 0,
      skipFlag: (r && r.__rtsProbeSkipFlag) || 0,
      frame: r && r.info && r.info.render ? r.info.render.frame | 0 : -1,
      perf: p,
      phase: ph
        ? {
            n: ph.n,
            tickMs: ph.tick / n,
            renderMs: ph.render / n,
            tockMs: ph.tock / n,
            intervalMs: ph.interval / n,
            tickMax: ph.tickMax,
            renderMax: ph.renderMax,
          }
        : null,
      compTop,
    };
  });
  const n = rows.length || 1;
  const skipN = rows.filter((x) => x.skip).length;
  const fpsVals = rows.map((x) => x.fpsHud).filter((x) => x != null && x > 0);
  const uniqueKeys = new Set(rows.map((x) => x.camKey)).size;
  const last = rows[rows.length - 1] || {};
  const shotDir = path.join(ROOT, 'bench-poses');
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = path.join(shotDir, `chrome-${name}.png`);
  await page.screenshot({ path: shot });
  return {
    name,
    samples: n,
    skipPct: (skipN / n) * 100,
    uniqueCamKeys: uniqueKeys,
    fpsHudLast: last.fpsHud,
    fpsHudAvg: fpsVals.length ? fpsVals.reduce((a, b) => a + b, 0) / fpsVals.length : null,
    fpsHudMin: fpsVals.length ? Math.min(...fpsVals) : null,
    callsLast: last.calls,
    trisLast: last.tris,
    hudText: last.hudText,
    shot,
    probe: {
      enter: probe1.enter - probe0.enter,
      orig: probe1.orig - probe0.orig,
      skipFlag: probe1.skipFlag - probe0.skipFlag,
      frameDelta: probe1.frame >= 0 && probe0.frame >= 0 ? probe1.frame - probe0.frame : null,
    },
    phase: probe1.phase,
    compTop: probe1.compTop,
    perf: probe1.perf
      ? {
          frames: probe1.perf.frames,
          fps: probe1.perf.fps,
          frameMs: probe1.perf.avgMs && probe1.perf.avgMs.frame,
          renderMs: probe1.perf.avgMs && probe1.perf.avgMs.render,
          fogOverlayMs: probe1.perf.avgMs && probe1.perf.avgMs['render.fogOverlay'],
          inputMs: probe1.perf.avgMs && probe1.perf.avgMs.input,
          botMs: probe1.perf.avgMs && probe1.perf.avgMs.bot,
          fogMs: probe1.perf.avgMs && probe1.perf.avgMs.fog,
          uiMs: probe1.perf.avgMs && probe1.perf.avgMs.ui,
          effectsMs: probe1.perf.avgMs && probe1.perf.avgMs.effects,
          gpuSkipPct: probe1.perf.gpu && probe1.perf.gpu.skipPct,
        }
      : null,
  };
}

async function main() {
  const server = await startStaticServer();
  console.log(`Serving ${ROOT} at http://127.0.0.1:${PORT}/ (headed Chrome)`);
  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--new-window', '--start-maximized'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const out = [];
  try {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?perf=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await page.waitForFunction(() => window.__rtsReady === true, null, { timeout: 180000 });
    await page.evaluate(() => {
      if (typeof window._dismissAppStartGate === 'function') window._dismissAppStartGate();
    });
    await sleep(1000);

    await page.evaluate(() => {
      if (typeof window._startGame === 'function') window._startGame('ffa');
    });
    await page.waitForFunction(() => {
      const overlay = document.getElementById('match-prepare-overlay');
      return !(overlay && !overlay.hidden);
    }, { timeout: 180000 });
    await sleep(2000);

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      Input.positionCameraForPlayer(0);
    });
    await sleep(800);
    out.push(await sample(page, 'ffa-look-base'));

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      const Cfg = await import('./js/config.js');
      const cam = Input.getCameraState();
      const R = Cfg.MAP_CAMERA_PAN_RADIUS;
      const s = R / Math.SQRT2;
      cam.x = s;
      cam.z = s;
      cam.y = 28;
      cam.rotY = Math.atan2(s, s) + Math.PI;
    });
    await sleep(1000);
    out.push(await sample(page, 'ffa-edge-out'));

    const rayMs = await page.evaluate(() => {
      const aim = document.getElementById('rightHandRay');
      const rc = aim && aim.components && aim.components.raycaster;
      const ground = document.getElementById('ground');
      if (!rc || typeof rc.checkIntersections !== 'function') return null;
      const n = 30;
      const avg = () => {
        rc.refreshObjects();
        const t0 = performance.now();
        for (let i = 0; i < n; i++) rc.checkIntersections();
        return (performance.now() - t0) / n;
      };
      const cheapMs = avg();
      const cheapN = (rc.objects && rc.objects.length) || 0;
      const had = !!(ground && ground.classList.contains('no-raycast'));
      if (had) ground.classList.remove('no-raycast');
      aim.setAttribute('raycaster', 'objects', '.clickable, #ground');
      const expensiveMs = avg();
      const expensiveN = (rc.objects && rc.objects.length) || 0;
      aim.setAttribute('raycaster', 'objects', '.clickable, #ground-hit');
      if (had) ground.classList.add('no-raycast');
      rc.refreshObjects();
      return { cheapMs, cheapN, expensiveMs, expensiveN };
    });
    console.log(
      rayMs
        ? `\n=== VR aim raycast @ rim (checkIntersections avg) ===\n  #ground-hit: ${rayMs.cheapMs.toFixed(2)}ms (${rayMs.cheapN} objs)\n  #ground plate+skirts: ${rayMs.expensiveMs.toFixed(2)}ms (${rayMs.expensiveN} objs)`
        : '\n=== VR aim raycast @ rim: no raycaster ==='
    );

    await page.evaluate(async () => {
      const Input = await import('./js/input.js');
      const cam = Input.getCameraState();
      cam.y = 16;
    });
    await sleep(800);
    out.push(await sample(page, 'ffa-edge-out-low'));
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n=== headed Chrome HUD FPS (this machine, vsync on) ===');
  console.log(
    `${'pose'.padEnd(16)} ${'hudLast'.padStart(8)} ${'hudAvg'.padStart(8)} ${'hudMin'.padStart(8)} ${'skip%'.padStart(7)} ${'keys'.padStart(5)} ${'calls'.padStart(6)}`
  );
  for (const r of out) {
    console.log(
      `${r.name.padEnd(16)} ${String(r.fpsHudLast).padStart(8)} ${r.fpsHudAvg != null ? r.fpsHudAvg.toFixed(0) : '-'.padStart(8)} ${String(r.fpsHudMin).padStart(8)} ${r.skipPct.toFixed(0).padStart(7)} ${String(r.uniqueCamKeys).padStart(5)} ${String(r.callsLast).padStart(6)}`
    );
  }
  console.log('\n=== present probe (enter = r.render calls, orig = actually drew) ===');
  for (const r of out) {
    const p = r.probe || {};
    const pf = r.perf || {};
    const ph = r.phase || {};
    console.log(
      `${r.name} enter=${p.enter} orig=${p.orig} skipFlag=${p.skipFlag} frameΔ=${p.frameDelta} | cpu frame=${pf.frameMs != null ? pf.frameMs.toFixed(2) : '-'}ms render=${pf.renderMs != null ? pf.renderMs.toFixed(2) : '-'}ms fogOv=${pf.fogOverlayMs != null ? pf.fogOverlayMs.toFixed(2) : '-'} bot=${pf.botMs != null ? pf.botMs.toFixed(2) : '-'} ui=${pf.uiMs != null ? pf.uiMs.toFixed(2) : '-'}`
    );
    console.log(
      `  phase n=${ph.n} tick=${ph.tickMs != null ? ph.tickMs.toFixed(2) : '-'}ms render=${ph.renderMs != null ? ph.renderMs.toFixed(2) : '-'}ms tock=${ph.tockMs != null ? ph.tockMs.toFixed(2) : '-'}ms interval=${ph.intervalMs != null ? ph.intervalMs.toFixed(2) : '-'}ms tickMax=${ph.tickMax != null ? ph.tickMax.toFixed(2) : '-'} renderMax=${ph.renderMax != null ? ph.renderMax.toFixed(2) : '-'}`
    );
    if (r.compTop && r.compTop.length) {
      console.log(
        '  comps ' +
          r.compTop.map((c) => `${c.k}=${c.ms.toFixed(2)}ms`).join(' | ')
      );
    }
  }
  const jsonPath = path.join(ROOT, 'bench-chrome-headed.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ when: new Date().toISOString(), out }, null, 2));
  console.log(`\nWrote ${jsonPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
