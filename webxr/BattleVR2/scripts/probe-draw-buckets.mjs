#!/usr/bin/env node
/** One-shot: count visible meshes by bucket for hera vs canyon 1v1 (explains draw delta). */
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startStaticServer, sleep } from './lib-serve.mjs';

const PORT = Number(process.env.PORT || 9131);

async function waitReady(page, ms = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(() => !!(window.__SCENE_READY__ && window.__BATTLEVR2_BOOT__))) return true;
    await sleep(400);
  }
  return false;
}

async function waitMatch(page, ms = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await page.evaluate(() => {
      const m = window.__BATTLEVR2_MATCH__;
      return !!(m && (m.units > 0 || window.__BATTLEVR2_DEBUG__?.()?.units > 0));
    });
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

function bucketOf(name, ud) {
  const n = name || '';
  if (ud?.rtsCanyonMap || /^Moon_0/i.test(n) || /^Terrain_/i.test(n) || n === 'rts-ground-mesh') return 'terrain-plate';
  if (/horizon-skirt|skirt/i.test(n)) return 'horizon-skirt';
  if (/fog|shroud|fow/i.test(n)) return 'fog-overlay';
  if (/instanced|Instance/i.test(n) || ud?.rtsInstanced) return 'instanced';
  if (/HQ|Barracks|Refinery|WarFactory|Solar|Turret|Artillery|building/i.test(n)) return 'buildings';
  if (/unit|vehicle|harvester|tank|bot|fighter|scout/i.test(n)) return 'units';
  if (/prop|rock|cliff|scenery|overview/i.test(n)) return 'props';
  if (/sky|cloud|sun|environ/i.test(n)) return 'sky';
  if (/ui|hud|minimap|ring|select|marker|ghost|cursor/i.test(n)) return 'ui-markers';
  if (/nav|debug|helper|grid/i.test(n)) return 'debug';
  return 'other';
}

async function probe(page, map) {
  await page.goto(`http://127.0.0.1:${PORT}/?perf=1&map=${map}`, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  });
  if (!(await waitReady(page, map === 'canyon' ? 240000 : 120000))) throw new Error('boot');
  await page.evaluate(async () => {
    window._dismissAppStartGate?.();
    await window._startGame?.('1v1');
  });
  if (!(await waitMatch(page, map === 'canyon' ? 300000 : 180000))) throw new Error('match');
  await sleep(map === 'canyon' ? 4000 : 1500);

  return page.evaluate((bucketOfSrc) => {
    // eslint-disable-next-line no-new-func
    const bucketOf = new Function(`return (${bucketOfSrc})`)();
    const sc = document.querySelector('a-scene');
    const r = sc.renderer;
    const cam = sc.camera;
    const root = sc.object3D;
    cam.updateMatrixWorld(true);
    root.updateMatrixWorld(true);
    if (typeof r.render === 'function') {
      r.info.reset();
      r.render(root, cam);
    }

    const buckets = {};
    const matKeys = new Map();
    let meshTotal = 0;
    let meshVisible = 0;
    let culledGuess = 0;
    const samples = [];

    const frustum = new window.THREE.Frustum();
    const proj = new window.THREE.Matrix4().multiplyMatrices(
      cam.projectionMatrix,
      cam.matrixWorldInverse
    );
    frustum.setFromProjectionMatrix(proj);

    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh && !o.isBatchedMesh && !o.isSkinnedMesh) return;
      meshTotal++;
      if (!o.visible) return;
      // Ancestors hidden?
      let p = o.parent;
      let anc = true;
      while (p) {
        if (p.visible === false) {
          anc = false;
          break;
        }
        p = p.parent;
      }
      if (!anc) return;
      meshVisible++;

      let inFrust = true;
      if (o.frustumCulled && o.geometry) {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        if (o.geometry.boundingSphere) {
          const s = o.geometry.boundingSphere.clone();
          s.applyMatrix4(o.matrixWorld);
          inFrust = frustum.intersectsSphere(s);
        }
      }
      if (!inFrust) {
        culledGuess++;
        return;
      }

      const b = bucketOf(o.name, o.userData || {});
      // Walk up for better labels
      let walk = o;
      let label = o.name || o.type;
      while (walk) {
        if (walk.userData?.rtsCanyonMap) {
          label = 'canyon-ground';
          break;
        }
        if (walk.userData?.rtsMesaHeightfield) {
          label = walk.name || 'mesa-cell';
          break;
        }
        if (walk.name && /rts-|Moon_|Terrain_|ground|skirt|prop|HQ/i.test(walk.name)) {
          label = walk.name;
        }
        walk = walk.parent;
      }
      const bucket = bucketOf(label, o.userData || {});
      buckets[bucket] = (buckets[bucket] || 0) + 1;

      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if (!m) continue;
        const key = `${m.type}|${m.uuid?.slice(0, 8)}|map=${!!m.map}|hera=${!!m.userData?._canyonHerablend}|mesa=${!!m.userData?.rtsMesaHeightfield}`;
        matKeys.set(key, (matKeys.get(key) || 0) + 1);
      }

      if (samples.length < 40) {
        samples.push({
          name: o.name || o.type,
          label,
          bucket,
          frustumCulled: !!o.frustumCulled,
          instanced: !!o.isInstancedMesh,
          count: o.count ?? null,
          herablend: !!(mats[0]?.userData?._canyonHerablend),
          mesa: !!(mats[0]?.userData?.rtsMesaHeightfield || o.userData?.rtsMesaHeightfield),
        });
      }
    });

    // Ground subtree specifically
    const ground = document.getElementById('ground')?.getObject3D?.('mesh');
    let groundMeshes = 0;
    let groundVisible = 0;
    let groundNames = [];
    if (ground) {
      ground.traverse((o) => {
        if (!o.isMesh) return;
        groundMeshes++;
        if (o.visible) {
          groundVisible++;
          if (groundNames.length < 20) groundNames.push(o.name || '(anon)');
        }
      });
    }

    return {
      draws: r.info.render.calls,
      tris: r.info.render.triangles,
      textures: r.info.memory?.textures ?? null,
      meshTotal,
      meshVisible,
      culledGuess,
      buckets,
      uniqueMatsOnVisible: matKeys.size,
      topMats: [...matKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
      ground: {
        canyon: !!ground?.userData?.rtsCanyonMap,
        mesa: !!ground?.userData?.rtsMesaHeightfield,
        meshes: groundMeshes,
        visible: groundVisible,
        names: groundNames,
      },
      samples,
    };
  }, bucketOf.toString());
}

const server = await startStaticServer(ROOT, PORT);
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const out = {};
try {
  for (const map of ['hera', 'canyon']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    console.log('probe', map);
    out[map] = await probe(page, map);
    console.log(JSON.stringify(out[map], null, 2));
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log('\nDELTA buckets (canyon - hera):');
const bh = out.hera.buckets;
const bc = out.canyon.buckets;
const keys = new Set([...Object.keys(bh), ...Object.keys(bc)]);
for (const k of [...keys].sort()) {
  const d = (bc[k] || 0) - (bh[k] || 0);
  if (d) console.log(`  ${k}: hera=${bh[k] || 0} canyon=${bc[k] || 0} Δ=${d > 0 ? '+' : ''}${d}`);
}
console.log(`draws: hera=${out.hera.draws} canyon=${out.canyon.draws} Δ=${out.canyon.draws - out.hera.draws}`);
console.log(`ground meshes: hera=${out.hera.ground.visible} canyon=${out.canyon.ground.visible}`);
