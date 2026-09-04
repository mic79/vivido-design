/**
 * Story battlefield: Modular Sci-Fi kit GLB (no landscape). Centered on origin,
 * water planes / giant outlier cliffs hidden, dark fill plate under gaps.
 */
import { MAP_SIZE, MAP_UNIT_NAV_RADIUS } from './config.js';
import { ensureThreeGltfLoaders } from './three-gltf-umd.js';

export const STORY_KIT_GLB = 'assets/terrain/scifi-rts-overview.glb';
export const STORY_KIT_LOD2_GLB = 'assets/terrain/scifi-rts-kit-lod2.glb';
export const STORY_KIT_LOD0_GLB = 'assets/terrain/scifi-rts-kit-lod0.glb';
export const OVERVIEW_KIT_GLB = 'assets/terrain/scifi-overview-lods.glb';
export const OVERVIEW_KIT_QUEST_GLB = 'assets/terrain/scifi-overview-lods-quest.glb';
/** Skirmish dirt+rocks (~1.3MB float rebake). Full catalog is `?fullkit=1` only. */
export const OVERVIEW_ROCKS_GLB = 'assets/terrain/scifi-overview-rocks.glb';
export const OVERVIEW_GROUNDSCAPE_GLB = 'assets/terrain/scifi-overview-groundscape.glb';
const MIN_BYTES = 8_000_000;
const MIN_OVERVIEW_BYTES = 400_000;
const MIN_ROCKS_BYTES = 100_000;
/** Switch to LOD0 when closer than this × mesh radius (clamped). */
const LOD_NEAR_RADIUS_MUL = 6.5;
const LOD_NEAR_MIN = 52;
const LOD_NEAR_MAX = 240;
const LOD_FAR_MUL = 1.5;

let glbBufCache = null;
let overviewBufCache = null;
/** Mirrors whether `overviewBufCache` is the full catalog or rocks-only. */
let overviewBufIsFull = null;
/** @type {null | { batches: object[] }} */
let kitLodState = null;
let kitGltfLoader = null;
let kitKtx2Ready = false;

function isDesktopOs() {
  const plat = typeof navigator !== 'undefined' ? navigator.platform || '' : '';
  return /Win32|Win64|MacIntel|Linux x86_64|Linux i686/i.test(plat);
}

function wantQuestOverview() {
  if (typeof location === 'undefined') return false;
  const q = `${location.search || ''}${location.hash || ''}`;
  if (/(?:[?&#]noquest=1\b)/.test(q)) return false;
  if (/(?:[?&#]quest=1\b)/.test(q)) return true;
  // Desktop (including Immersive Web Emulator spoofing Quest UA) — PNG/desktop
  // GLB has fewer unique draws than the Quest KTX2 split. Real Quest is Android.
  if (isDesktopOs()) return false;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /Quest|OculusBrowser|\bOculus\b/i.test(ua);
}

function sceneRenderer() {
  const el = typeof document !== 'undefined' ? document.querySelector('a-scene') : null;
  return el && el.renderer ? el.renderer : null;
}

function getKitGltfLoader() {
  const THREE = window.THREE;
  if (!THREE || !THREE.GLTFLoader) return null;
  if (!kitGltfLoader) {
    const loader = new THREE.GLTFLoader();
    try {
      if (THREE.DRACOLoader) {
        const draco = new THREE.DRACOLoader();
        draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
        loader.setDRACOLoader(draco);
      }
    } catch (err) {
      console.warn('[RTSVR5] DRACOLoader setup failed', err);
    }
    kitGltfLoader = loader;
  }
  if (!kitKtx2Ready) {
    const renderer = sceneRenderer();
    if (renderer && THREE.KTX2Loader) {
      try {
        const ktx2 = new THREE.KTX2Loader()
          .setTranscoderPath('https://cdn.jsdelivr.net/npm/super-three@0.173.4/examples/jsm/libs/basis/')
          .detectSupport(renderer);
        kitGltfLoader.setKTX2Loader(ktx2);
        kitKtx2Ready = true;
      } catch (err) {
        console.warn('[RTSVR5] KTX2Loader setup failed', err);
      }
    }
  }
  return kitGltfLoader;
}

function parseGlbJson(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = dv.getUint32(12, true);
  const jsonType = dv.getUint32(16, true);
  if (jsonType !== 0x4e4f534a) throw new Error('no JSON chunk');
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
}

function worldScaleMax(obj, THREE) {
  const s = new THREE.Vector3();
  obj.getWorldScale(s);
  return Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
}

function meshName(obj) {
  return `${obj.name || ''} ${obj.parent && obj.parent.name ? obj.parent.name : ''}`;
}

/** Named prop node with TRS — quantized mesh AABBs must not drive centering.
 * Prefer the outermost SM_* ancestor (holder), not a child mesh named SM_*_1. */
function actorNodeForMesh(obj, sceneRoot) {
  let n = obj;
  let found = null;
  while (n && n !== sceneRoot) {
    if (n.name && /SM_/i.test(n.name)) found = n;
    n = n.parent;
  }
  return found || (obj.parent && obj.parent !== sceneRoot ? obj.parent : obj);
}

function expandClusterFromActorNodes(scene, W) {
  const cluster = new W.Box3();
  const dirtMins = [];
  let any = false;
  const p = new W.Vector3();
  scene.updateMatrixWorld(true);
  scene.traverse((obj) => {
    if ((!obj.isMesh && !obj.isSkinnedMesh) || !obj.visible) return;
    const actor = actorNodeForMesh(obj, scene);
    p.set(actor.position.x, actor.position.y, actor.position.z);
    cluster.expandByPoint(p);
    any = true;
    if (/SM_Dirt|SM_Rock/i.test(actor.name || '') || /SM_Dirt|SM_Rock/i.test(meshName(obj))) {
      dirtMins.push(p.y);
    }
  });
  return { cluster, dirtMins, any };
}

function findGltfScene(gltf, name) {
  const scenes = gltf.scenes || [];
  for (let i = 0; i < scenes.length; i++) {
    if (scenes[i] && scenes[i].name === name) return scenes[i];
  }
  return null;
}

/**
 * @param {object} gltf
 * @param {{ kind: string, skipIndoor?: boolean, clipRadius?: number, hideScale?: number, bytes?: number, keepNameRe?: RegExp|null, noPlate?: boolean, targetSpanM?: number, skipDistanceLod?: boolean }} opts
 */
function assembleKitWrap(gltf, opts) {
  const W = window.THREE;
  const kind = opts.kind || 'story';
  const skipIndoor = opts.skipIndoor !== false;
  const clipRadius = opts.clipRadius == null ? 420 : opts.clipRadius;
  const hideScale = opts.hideScale == null ? 20 : opts.hideScale;
  const keepNameRe = opts.keepNameRe || null;
  const noPlate = !!opts.noPlate;
  const targetSpanM = opts.targetSpanM > 0 ? opts.targetSpanM : 0;

  const scene = findGltfScene(gltf, 'LOD2') || gltf.scene;
  // Overview is a 122 m diorama — keep LOD2 only. Holding the LOD0 scene doubled GPU memory
  // and the distance swap never paired (0 LOD0 batches).
  const lod0Root = kind === 'overview' ? null : findGltfScene(gltf, 'LOD0');
  scene.updateMatrixWorld(true);
  if (lod0Root) lod0Root.updateMatrixWorld(true);
  if (kind === 'overview') {
    const unusedLod0 = findGltfScene(gltf, 'LOD0');
    if (unusedLod0 && unusedLod0 !== scene) {
      unusedLod0.traverse((obj) => {
        // Geos are LOD0-only; materials are often shared with LOD2 — do not dispose mats here.
        if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
        obj.geometry = null;
      });
      if (unusedLod0.parent) unusedLod0.parent.remove(unusedLod0);
    }
  }

  let kept = 0;
  let dropped = 0;
  let matsDisposed = 0;
  const dropList = [];
  scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    const n = meshName(obj);
    if (/WaterPlane|Skybox|Template_Map_Floor/i.test(n) || (skipIndoor && /Indoor/i.test(n))) {
      obj.visible = false;
      dropList.push(obj);
      dropped++;
      return;
    }
    if (keepNameRe && !keepNameRe.test(n)) {
      obj.visible = false;
      dropList.push(obj);
      dropped++;
      return;
    }
    if (worldScaleMax(obj, W) > hideScale) {
      obj.visible = false;
      dropList.push(obj);
      dropped++;
      return;
    }
    kept++;
  });

  // Skirmish rocks-only: the Overview GLB still uploaded ~100 textures for hidden
  // modules. That VRAM thrash is why 1v1 (few rocks) was slower than Story.
  if (keepNameRe && dropList.length) {
    const keepMats = new Set();
    scene.traverse((obj) => {
      if ((!obj.isMesh && !obj.isSkinnedMesh) || !obj.visible) return;
      const mats = obj.material == null ? [] : Array.isArray(obj.material) ? obj.material : [obj.material];
      for (let i = 0; i < mats.length; i++) if (mats[i]) keepMats.add(mats[i]);
    });
    const doomedMats = new Set();
    for (let i = 0; i < dropList.length; i++) {
      const obj = dropList[i];
      const mats = obj.material == null ? [] : Array.isArray(obj.material) ? obj.material : [obj.material];
      for (let m = 0; m < mats.length; m++) {
        if (mats[m] && !keepMats.has(mats[m])) doomedMats.add(mats[m]);
      }
      if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
      obj.geometry = null;
      obj.material = null;
      if (obj.parent) obj.parent.remove(obj);
    }
    const texSeen = new Set();
    for (const mat of doomedMats) {
      for (const key of Object.keys(mat)) {
        const v = mat[key];
        if (v && v.isTexture && !texSeen.has(v)) {
          texSeen.add(v);
          if (v.dispose) v.dispose();
        }
      }
      if (mat.dispose) mat.dispose();
    }
    matsDisposed = doomedMats.size;
  }

  // --- Center / scale ---
  // Story: original mesh-AABB center on the scene root (pivot breaks LOD0 + layout).
  // Overview groundscape: actor-node center + pivot group (scale must not share the offset node).
  let cluster;
  let y0;
  if (kind === 'overview' && (keepNameRe || targetSpanM > 0)) {
    const seeded = expandClusterFromActorNodes(scene, W);
    if (!seeded.any || seeded.cluster.isEmpty()) {
      console.warn('[RTSVR5] skip kit: no visible meshes', kind);
      return null;
    }
    cluster = seeded.cluster;
    const dirtMins = seeded.dirtMins;
    dirtMins.sort((a, b) => a - b);
    y0 =
      dirtMins.length > 0
        ? dirtMins[Math.max(0, Math.floor(dirtMins.length * 0.1))]
        : cluster.min.y;
    const cxz = cluster.getCenter(new W.Vector3());

    if (clipRadius > 0) {
      const r2 = clipRadius * clipRadius;
      const clipDrop = [];
      const p = new W.Vector3();
      const center = cxz;
      scene.traverse((obj) => {
        if ((!obj.isMesh && !obj.isSkinnedMesh) || !obj.visible) return;
        const actor = actorNodeForMesh(obj, scene);
        p.set(actor.position.x, actor.position.y, actor.position.z);
        const dx = p.x - center.x;
        const dz = p.z - center.z;
        if (dx * dx + dz * dz > r2) clipDrop.push(obj);
      });
      if (clipDrop.length) {
        const dropSet = new Set(clipDrop);
        const keepMats = new Set();
        scene.traverse((obj) => {
          if ((!obj.isMesh && !obj.isSkinnedMesh) || !obj.visible || dropSet.has(obj)) return;
          const mats = obj.material == null ? [] : Array.isArray(obj.material) ? obj.material : [obj.material];
          for (let i = 0; i < mats.length; i++) if (mats[i]) keepMats.add(mats[i]);
        });
        const doomedMats = new Set();
        for (let i = 0; i < clipDrop.length; i++) {
          const obj = clipDrop[i];
          const mats = obj.material == null ? [] : Array.isArray(obj.material) ? obj.material : [obj.material];
          for (let m = 0; m < mats.length; m++) {
            if (mats[m] && !keepMats.has(mats[m])) doomedMats.add(mats[m]);
          }
          if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
          obj.geometry = null;
          obj.material = null;
          if (obj.parent) obj.parent.remove(obj);
          dropped++;
        }
        const texSeen = new Set();
        for (const mat of doomedMats) {
          for (const key of Object.keys(mat)) {
            const v = mat[key];
            if (v && v.isTexture && !texSeen.has(v)) {
              texSeen.add(v);
              if (v.dispose) v.dispose();
            }
          }
          if (mat.dispose) mat.dispose();
        }
        matsDisposed += doomedMats.size;
        kept = 0;
        scene.traverse((obj) => {
          if ((obj.isMesh || obj.isSkinnedMesh) && obj.visible) kept++;
        });
      }
    }

    const pivot = new W.Group();
    pivot.name = 'rts-kit-pivot';
    while (scene.children.length) pivot.add(scene.children[0]);
    pivot.position.set(-cxz.x, -y0, -cxz.z);
    scene.add(pivot);
    scene.position.set(0, 0, 0);
    scene.scale.set(1, 1, 1);
    scene.updateMatrixWorld(true);
    if (targetSpanM > 0) {
      const spanNow = Math.max(0.01, cluster.max.x - cluster.min.x, cluster.max.z - cluster.min.z);
      const want = Math.min(targetSpanM, MAP_SIZE * 0.85);
      if (spanNow > 0.5 && want > 1) {
        const s = want / spanNow;
        if (s > 0.05 && s < 40) {
          scene.scale.setScalar(s);
          scene.updateMatrixWorld(true);
        }
      }
    }
  } else {
    // Story / full kits: mesh bounds + scene.position offset (pre-pivot behavior).
    const box = new W.Box3();
    let any = false;
    scene.traverse((obj) => {
      if ((!obj.isMesh && !obj.isSkinnedMesh) || !obj.visible) return;
      box.expandByObject(obj);
      any = true;
    });
    if (!any || box.isEmpty()) {
      console.warn('[RTSVR5] skip kit: no visible meshes', kind);
      return null;
    }
    const center = box.getCenter(new W.Vector3());
    if (clipRadius > 0) {
      const r2 = clipRadius * clipRadius;
      scene.traverse((obj) => {
        if ((!obj.isMesh && !obj.isSkinnedMesh) || !obj.visible) return;
        const b = new W.Box3().setFromObject(obj);
        const c = b.getCenter(new W.Vector3());
        const dx = c.x - center.x;
        const dz = c.z - center.z;
        if (dx * dx + dz * dz > r2) obj.visible = false;
      });
    }
    const dirtMins = [];
    cluster = new W.Box3();
    let clusterAny = false;
    scene.traverse((obj) => {
      if ((!obj.isMesh && !obj.isSkinnedMesh) || !obj.visible) return;
      cluster.expandByObject(obj);
      clusterAny = true;
      if (/SM_Dirt|SM_Rock/i.test(meshName(obj))) {
        dirtMins.push(new W.Box3().setFromObject(obj).min.y);
      }
    });
    if (!clusterAny || cluster.isEmpty()) {
      console.warn('[RTSVR5] skip kit: cluster empty', kind);
      return null;
    }
    dirtMins.sort((a, b) => a - b);
    y0 =
      dirtMins.length > 0
        ? dirtMins[Math.max(0, Math.floor(dirtMins.length * 0.1))]
        : cluster.min.y;
    const cxz = cluster.getCenter(new W.Vector3());
    scene.position.set(-cxz.x, -y0, -cxz.z);
    scene.updateMatrixWorld(true);
    if (lod0Root) {
      lod0Root.position.copy(scene.position);
      lod0Root.updateMatrixWorld(true);
    }
  }

  const recv =
    typeof window._getDynamicShadowsEnabled === 'function'
      ? !!window._getDynamicShadowsEnabled()
      : true;
  scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    obj.castShadow = false;
    obj.receiveShadow = recv;
    // XR ArrayCamera / pose frustums disagree with what the headset actually shows —
    // never let Three cull kit meshes (CPU kit LOD owns visibility).
    obj.frustumCulled = false;
    if (kind === 'overview' && obj.geometry) {
      obj.geometry.computeBoundingSphere();
      obj.geometry.computeBoundingBox();
    }
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat) continue;
        mat.fog = false;
        if ('envMapIntensity' in mat) mat.envMapIntensity = kind === 'overview' ? 0.15 : 0.35;
        if (kind === 'overview') {
          if ('metalness' in mat) mat.metalness = 0;
          if ('roughness' in mat) mat.roughness = Math.max(0.72, mat.roughness || 0);
          if (mat.color) mat.color.setHex(0xffffff);
          if ('emissive' in mat && mat.emissive) {
            mat.emissive.setHex(0x3a3828);
            if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.55;
          }
          if (mat.map && 'colorSpace' in mat.map && W.SRGBColorSpace) {
            mat.map.colorSpace = W.SRGBColorSpace;
            mat.map.needsUpdate = true;
          }
          if (mat.alphaTest > 0 || mat.transparent) {
            mat.transparent = false;
            mat.alphaTest = Math.max(mat.alphaTest || 0, 0.35);
            mat.depthWrite = true;
          }
          mat.side = W.DoubleSide;
          mat.needsUpdate = true;
        }
      }
    }
  });

  const wrap = new W.Group();
  wrap.name = kind === 'overview' ? 'rts-overview-kit' : 'rts-story-kit';
  wrap.userData.rtsStoryKit = true;
  wrap.userData.rtsKitKind = kind;
  wrap.userData.rtsSkipIndoor = skipIndoor;
  if (opts.skipDistanceLod) wrap.userData.rtsSkipDistanceLod = true;
  if (lod0Root) wrap.userData.rtsLod0Root = lod0Root;
  wrap.add(scene);

  if (!noPlate) {
    const plate = new W.Mesh(
      new W.PlaneGeometry(MAP_SIZE * 1.08, MAP_SIZE * 1.08),
      new W.MeshLambertMaterial({
        color: kind === 'overview' ? 0x8a8a90 : 0x141210,
        fog: false,
      })
    );
    plate.name = 'rts-kit-ground';
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = -0.04;
    plate.receiveShadow = recv;
    plate.castShadow = false;
    plate.frustumCulled = false;
    plate.userData.rtsMoonPlate = true;
    wrap.add(plate);
  }
  wrap.updateMatrixWorld(true);

  const span = cluster.max.clone().sub(cluster.min);
  console.log('[RTSVR5] kit ready', {
    kind,
    bytes: opts.bytes || 0,
    combinedLod: !!lod0Root,
    keep: keepNameRe ? String(keepNameRe) : 'all',
    meshesKept: kept,
    meshesDropped: dropped,
    matsDisposed,
    spanXZ: [+span.x.toFixed(1), +span.z.toFixed(1)],
    groundY: +y0.toFixed(2),
  });
  return wrap;
}

async function parseKitBuf(buf) {
  await ensureThreeGltfLoaders();
  const loader = getKitGltfLoader();
  if (!loader) throw new Error('GLTFLoader missing');
  return new Promise((resolve, reject) => {
    loader.parse(buf, '', resolve, reject);
  });
}

/** Skirmish Overview catalog (heavy). Default skirmish uses Story kit instead. */
function wantOverviewFullKit() {
  if (typeof location === 'undefined') return false;
  const q = `${location.search || ''}${location.hash || ''}`;
  return /(?:[?&#]fullkit=1\b)/.test(q);
}

/** Opt-in empty rocks-only GLB (A/B). Default is Story kit — denser occludes HDR sky fill. */
function wantOverviewRocksOnly() {
  if (typeof location === 'undefined') return false;
  const q = `${location.search || ''}${location.hash || ''}`;
  return /(?:[?&#]rocks=1\b)/.test(q);
}

async function ensureStoryKitBuffer() {
  if (glbBufCache) return glbBufCache;
  let res;
  try {
    res = await fetch(STORY_KIT_LOD2_GLB);
    if (!res.ok) res = await fetch(STORY_KIT_GLB);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength < MIN_BYTES) {
    console.warn('[RTSVR5] skip story kit: file too small', buf.byteLength);
    return null;
  }
  try {
    parseGlbJson(buf);
  } catch (err) {
    console.warn('[RTSVR5] skip story kit: bad GLB', err);
    return null;
  }
  glbBufCache = buf;
  return buf;
}

/**
 * @returns {Promise<import('three').Group|null>}
 */
export async function tryLoadStoryKit() {
  const W = window.THREE;
  if (!W) return null;

  const buf = await ensureStoryKitBuffer();
  if (!buf) return null;

  const gltf = await parseKitBuf(buf);
  return assembleKitWrap(gltf, {
    kind: 'story',
    skipIndoor: true,
    clipRadius: 420,
    bytes: buf.byteLength,
  });
}

/**
 * Overview dirt piles + rocks (~1.3MB float rebake). Never fall back to the 89MB
 * full Overview — that path uploaded ~100 textures and locked FPS ~67.
 * @returns {Promise<import('three').Group|null>}
 */
export async function tryLoadOverviewGroundscape() {
  const W = window.THREE;
  if (!W) return null;

  const urls = [OVERVIEW_GROUNDSCAPE_GLB];
  let buf = null;
  let used = urls[0];
  for (const url of urls) {
    let res;
    try {
      res = await fetch(url);
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const next = await res.arrayBuffer();
    if (next.byteLength < MIN_ROCKS_BYTES) continue;
    try {
      const json = parseGlbJson(next);
      const ext = [...(json.extensionsUsed || []), ...(json.extensionsRequired || [])];
      if (ext.some((e) => /quantization/i.test(String(e)))) {
        console.warn('[RTSVR5] skip groundscape: quantized GLB (rebake required)', url);
        continue;
      }
    } catch {
      continue;
    }
    buf = next;
    used = url;
    break;
  }
  if (!buf) {
    console.warn('[RTSVR5] overview groundscape missing — skirmish stays moon-only');
    return null;
  }

  console.log('[RTSVR5] overview groundscape', {
    url: used,
    bytes: buf.byteLength,
  });
  const gltf = await parseKitBuf(buf);
  return assembleKitWrap(gltf, {
    kind: 'overview',
    skipIndoor: true,
    clipRadius: 0,
    keepNameRe: null,
    noPlate: true,
    targetSpanM: MAP_SIZE * 0.72,
    skipDistanceLod: true,
    bytes: buf.byteLength,
  });
}

/**
 * Skirmish Overview scenery (opt-in only).
 * Default skirmish is flat moon (`MAP_TERRAIN_STYLE=crater`) + optional groundscape props.
 * `?rocks=1` loads rocks extract; `?fullkit=1` full catalog (VRAM heavy — A/B only).
 * @returns {Promise<import('three').Group|null>}
 */
export async function tryLoadOverviewKit() {
  const W = window.THREE;
  if (!W) return null;

  const full = wantOverviewFullKit();
  const rocks = !full && wantOverviewRocksOnly();
  if (!full && !rocks) {
    return null;
  }

  if (!overviewBufCache || overviewBufIsFull !== full) {
    const quest = wantQuestOverview();
    const urls = full
      ? quest
        ? [OVERVIEW_KIT_QUEST_GLB, OVERVIEW_KIT_GLB]
        : [OVERVIEW_KIT_GLB]
      : [OVERVIEW_ROCKS_GLB];
    let buf = null;
    let used = urls[0];
    for (const url of urls) {
      let res;
      try {
        res = await fetch(url);
      } catch {
        continue;
      }
      if (!res.ok) continue;
      const next = await res.arrayBuffer();
      const minBytes = full ? MIN_OVERVIEW_BYTES : MIN_ROCKS_BYTES;
      if (next.byteLength < minBytes) continue;
      try {
        parseGlbJson(next);
      } catch {
        continue;
      }
      buf = next;
      used = url;
      break;
    }
    if (!buf) {
      console.warn('[RTSVR5] skip overview kit: missing GLB', { full, rocks, urls });
      return null;
    }
    overviewBufCache = buf;
    overviewBufIsFull = full;
    console.log('[RTSVR5] overview kit file', {
      url: used,
      bytes: buf.byteLength,
      quest,
      rocksOnly: rocks,
      full,
    });
  }

  const gltf = await parseKitBuf(overviewBufCache);
  return assembleKitWrap(gltf, {
    kind: 'overview',
    skipIndoor: true,
    clipRadius: 0,
    keepNameRe: rocks ? /SM_Rock/i : null,
    noPlate: false,
    targetSpanM: rocks ? MAP_SIZE * 0.72 : 0,
    skipDistanceLod: !!rocks,
    bytes: overviewBufCache.byteLength,
  });
}

function kitSceneRoot(root) {
  for (let i = 0; i < root.children.length; i++) {
    const c = root.children[i];
    if (c.name === 'rts-kit-ground') continue;
    return c;
  }
  return root;
}

/** glTF actor name (unique). Walks past the mesh/primitive Group Three creates for multi-prim meshes. */
function instanceNodeName(obj, sceneRoot) {
  let n = obj;
  while (n.parent && n.parent !== sceneRoot) n = n.parent;
  return n.name || obj.name || '';
}

function matNameOf(obj) {
  const m = obj && obj.material;
  if (!m || Array.isArray(m)) return '';
  return m.name || '';
}

function vertCount(geo) {
  return (geo && geo.attributes && geo.attributes.position && geo.attributes.position.count) || 0;
}

/** LOD0 must be the same piece, denser or equal — never a different submesh. */
function plausibleLod0(geo0, geo2) {
  const a = vertCount(geo0);
  const b = vertCount(geo2);
  if (!a || !b) return false;
  return a >= b * 0.75;
}

/** Same local pivot — otherwise the near swap draws the piece somewhere else. */
function lod0LocalSpaceMatches(geo0, geo2) {
  if (!geo0 || !geo2) return false;
  if (geo0.computeBoundingSphere) geo0.computeBoundingSphere();
  if (geo2.computeBoundingSphere) geo2.computeBoundingSphere();
  const s0 = geo0.boundingSphere;
  const s2 = geo2.boundingSphere;
  if (!s0 || !s2 || !s0.center || !s2.center) return false;
  const dc = s0.center.distanceTo(s2.center);
  const r = Math.max(s0.radius, s2.radius, 0.01);
  return dc <= r * 0.35 && s0.radius <= s2.radius * 3 && s2.radius <= s0.radius * 3;
}

function takeLod0Prim(prims, materialName, geo2) {
  if (!prims) return null;
  for (let i = 0; i < prims.length; i++) {
    const p = prims[i];
    if (p.used || p.matName !== materialName) continue;
    if (!plausibleLod0(p.geo, geo2)) continue;
    p.used = true;
    return p;
  }
  return null;
}

function disposeLod0Unused(gltf, keepGeo, keepMat) {
  if (!gltf || !gltf.scene) return;
  gltf.scene.traverse((o) => {
    const mats = o.material == null ? [] : Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      if (!mat || keepMat.has(mat)) continue;
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'bumpMap']) {
        const tex = mat[k];
        if (tex && tex.dispose) tex.dispose();
        if (mat[k]) mat[k] = null;
      }
      if (mat.dispose) mat.dispose();
    }
    if (o.geometry && !keepGeo.has(o.geometry) && o.geometry.dispose) o.geometry.dispose();
  });
}

async function loadLod0PrimsByNode(opts = {}) {
  const skipIndoor = opts.skipIndoor !== false;
  const sceneRoot = opts.lod0Root || null;
  const gltf = null;
  if (!sceneRoot) return { byNode: new Map(), gltf: null };
  const byNode = new Map();
  sceneRoot.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.attributes || !o.geometry.attributes.position) return;
    const n = instanceNodeName(o, sceneRoot);
    if (/WaterPlane/i.test(n) || (skipIndoor && /Indoor/i.test(n))) return;
    let list = byNode.get(n);
    if (!list) {
      list = [];
      byNode.set(n, list);
    }
    list.push({
      matName: matNameOf(o),
      geo: o.geometry,
      mat: Array.isArray(o.material) ? null : o.material,
      used: false,
    });
  });
  return { byNode, gltf };
}

function makeInstanced(THREE, geo, mat, n, name, recv) {
  const inst = new THREE.InstancedMesh(geo, mat, n);
  inst.name = name;
  inst.castShadow = false;
  inst.receiveShadow = !!recv;
  inst.frustumCulled = false;
  inst.count = 0;
  inst.matrixAutoUpdate = false;
  try {
    if (THREE.DynamicDrawUsage) inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  } catch (_) {
    /* */
  }
  return inst;
}

function sphereFromObject(obj, tmpBox, tmpSize, tmpCenter) {
  tmpBox.setFromObject(obj);
  if (tmpBox.isEmpty()) {
    const e = obj.matrixWorld.elements;
    return {
      x: e[12],
      y: e[13],
      z: e[14],
      r: 4,
      rVis: 4,
      minx: e[12] - 4,
      miny: e[13] - 4,
      minz: e[14] - 4,
      maxx: e[12] + 4,
      maxy: e[13] + 4,
      maxz: e[14] + 4,
    };
  }
  tmpBox.getCenter(tmpCenter);
  tmpBox.getSize(tmpSize);
  return {
    x: tmpCenter.x,
    y: tmpCenter.y,
    z: tmpCenter.z,
    rVis: Math.max(0.05, 0.5 * Math.hypot(tmpSize.x, tmpSize.y, tmpSize.z)),
    r: Math.max(4, 0.5 * Math.hypot(tmpSize.x, tmpSize.y, tmpSize.z)),
    minx: tmpBox.min.x,
    miny: tmpBox.min.y,
    minz: tmpBox.min.z,
    maxx: tmpBox.max.x,
    maxy: tmpBox.max.y,
    maxz: tmpBox.max.z,
  };
}

function pushInstancedBatch(THREE, root, parentInv, local, batches, spec) {
  const n = spec.meshes.length;
  if (n < 1) return 0;
  const geo0 = spec.geo0;
  const tmpBox = new THREE.Box3();
  const tmpSize = new THREE.Vector3();
  const tmpCenter = new THREE.Vector3();
  // Unique pieces stay as Mesh (cheaper than InstancedMesh n=1) but Three's
  // frustumCulled uses the XR ArrayCamera parent — hide-in-view in VR.
  // CPU-cull with the same eye frustums as instances.
  if (n < 2 && !geo0) {
    for (let i = 0; i < n; i++) {
      const mesh = spec.meshes[i];
      if (!mesh || !mesh.isMesh) continue;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      const sph = sphereFromObject(mesh, tmpBox, tmpSize, tmpCenter);
      batches.push({
        unique: true,
        mesh,
        mesh0: null,
        mesh2: null,
        items: [{
          matrix: null,
          x: sph.x,
          y: sph.y,
          z: sph.z,
          r: sph.r,
          rVis: sph.rVis || sph.r,
          minx: sph.minx,
          miny: sph.miny,
          minz: sph.minz,
          maxx: sph.maxx,
          maxy: sph.maxy,
          maxz: sph.maxz,
          lod: 2,
          drawn: true,
        }],
      });
    }
    return 0;
  }
  const geo2 = spec.geo2;
  const boundGeo = geo0 || geo2;
  if (boundGeo && boundGeo.computeBoundingSphere) boundGeo.computeBoundingSphere();
  if (geo2 && geo2.computeBoundingSphere) geo2.computeBoundingSphere();
  const mesh2 = geo2 ? makeInstanced(THREE, geo2, spec.mat, n, `${spec.label}_lod2`, spec.recv) : null;
  const mesh0 = geo0 ? makeInstanced(THREE, geo0, spec.mat, n, `${spec.label}_lod0`, spec.recv) : null;
  const items = [];
  for (let i = 0; i < n; i++) {
    const mesh = spec.meshes[i];
    const src = mesh.isMesh ? mesh : mesh;
    const mw = src.matrixWorld || mesh.matrixWorld;
    local.multiplyMatrices(parentInv, mw);
    const matrix = local.clone();
    const sph = sphereFromObject(src, tmpBox, tmpSize, tmpCenter);
    const dNear = Math.max(LOD_NEAR_MIN, Math.min(LOD_NEAR_MAX, sph.r * LOD_NEAR_RADIUS_MUL));
    items.push({
      matrix,
      x: sph.x,
      y: sph.y,
      z: sph.z,
      r: sph.r,
      rVis: sph.rVis || sph.r,
      minx: sph.minx,
      miny: sph.miny,
      minz: sph.minz,
      maxx: sph.maxx,
      maxy: sph.maxy,
      maxz: sph.maxz,
      dNear,
      dFar: dNear * LOD_FAR_MUL,
      lod: 2,
      drawn: true,
    });
    if (mesh2) mesh2.setMatrixAt(i, matrix);
    if (mesh0) mesh0.setMatrixAt(i, matrix);
    if (src.removeFromParent) src.removeFromParent();
  }
  if (mesh2) {
    mesh2.instanceMatrix.needsUpdate = true;
    mesh2.count = n;
    root.add(mesh2);
  }
  if (mesh0) {
    mesh0.instanceMatrix.needsUpdate = true;
    mesh0.count = 0;
    root.add(mesh0);
  }
  batches.push({ items, mesh0, mesh2 });
  return geo0 ? n : 0;
}

function geoIsFloatMergeable(geo) {
  const pos = geo && geo.getAttribute && geo.getAttribute('position');
  return !!(pos && pos.array instanceof Float32Array && !pos.normalized);
}

function mergeGeometriesSimple(THREE, geos) {
  if (!geos.length) return null;
  const attrs = ['position', 'normal', 'uv', 'uv2'];
  const arrays = {};
  const offsets = {};
  for (let a = 0; a < attrs.length; a++) {
    const name = attrs[a];
    let bytes = 0;
    let itemSize = 0;
    for (let i = 0; i < geos.length; i++) {
      const attr = geos[i].getAttribute(name);
      if (!attr) {
        if (name === 'position') return null;
        bytes = -1;
        break;
      }
      if (!(attr.array instanceof Float32Array) || attr.normalized) return null;
      itemSize = attr.itemSize;
      bytes += attr.array.length;
    }
    if (bytes <= 0) continue;
    arrays[name] = new Float32Array(bytes);
    offsets[name] = 0;
  }
  let useIndex = true;
  let indexCount = 0;
  for (let i = 0; i < geos.length; i++) {
    if (!geos[i].index) {
      useIndex = false;
      break;
    }
    indexCount += geos[i].index.count;
  }
  const indexOut = useIndex ? new Uint32Array(indexCount) : null;
  let indexOff = 0;
  let vertOff = 0;
  for (let i = 0; i < geos.length; i++) {
    const g = geos[i];
    const pos = g.getAttribute('position');
    for (const name of Object.keys(arrays)) {
      const attr = g.getAttribute(name);
      arrays[name].set(attr.array, offsets[name]);
      offsets[name] += attr.array.length;
    }
    if (useIndex) {
      const src = g.index.array;
      for (let k = 0; k < src.length; k++) indexOut[indexOff++] = src[k] + vertOff;
    }
    vertOff += pos.count;
  }
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(arrays)) {
    const itemSize = geos[0].getAttribute(name).itemSize;
    out.setAttribute(name, new THREE.BufferAttribute(arrays[name], itemSize));
  }
  if (useIndex && indexOut) out.setIndex(new THREE.BufferAttribute(indexOut, 1));
  return out;
}

/**
 * n=1 kit pieces are each a draw. Join those that share a material so PCVR
 * is not paying ~300 extra PBR calls for unique props.
 */
function mergeUniqueByMaterial(THREE, root, batches) {
  const groups = new Map();
  for (let i = 0; i < batches.length; i++) {
    const b = batches[i];
    if (!b.unique || !b.mesh || !b.mesh.geometry || !b.mesh.material) continue;
    if (Array.isArray(b.mesh.material)) continue;
    if (!geoIsFloatMergeable(b.mesh.geometry)) continue;
    const key = b.mesh.material.uuid;
    let g = groups.get(key);
    if (!g) {
      g = [];
      groups.set(key, g);
    }
    g.push(i);
  }
  const remove = new Set();
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    const geos = [];
    let minx = Infinity;
    let miny = Infinity;
    let minz = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    let maxz = -Infinity;
    let mat = null;
    let recv = false;
    for (let k = 0; k < idxs.length; k++) {
      const b = batches[idxs[k]];
      const mesh = b.mesh;
      mat = mesh.material;
      recv = recv || !!mesh.receiveShadow;
      mesh.updateMatrixWorld(true);
      const geo = mesh.geometry.clone();
      geo.applyMatrix4(mesh.matrixWorld);
      geos.push(geo);
      const it = b.items[0];
      if (it.minx < minx) minx = it.minx;
      if (it.miny < miny) miny = it.miny;
      if (it.minz < minz) minz = it.minz;
      if (it.maxx > maxx) maxx = it.maxx;
      if (it.maxy > maxy) maxy = it.maxy;
      if (it.maxz > maxz) maxz = it.maxz;
    }
    let merged = null;
    try {
      merged = mergeGeometriesSimple(THREE, geos);
    } catch (_) {
      merged = null;
    }
    for (let g = 0; g < geos.length; g++) {
      if (geos[g] && geos[g].dispose) geos[g].dispose();
    }
    if (!merged) continue;
    for (let k = 0; k < idxs.length; k++) {
      const srcMesh = batches[idxs[k]].mesh;
      if (srcMesh && srcMesh.removeFromParent) srcMesh.removeFromParent();
      remove.add(idxs[k]);
    }
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = 'kit-unique-merged';
    mesh.castShadow = false;
    mesh.receiveShadow = recv;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrixWorld(true);
    root.add(mesh);
    const cx = (minx + maxx) * 0.5;
    const cy = (miny + maxy) * 0.5;
    const cz = (minz + maxz) * 0.5;
    const rVis = Math.max(0.05, 0.5 * Math.hypot(maxx - minx, maxy - miny, maxz - minz));
    batches.push({
      unique: true,
      mesh,
      mesh0: null,
      mesh2: null,
      items: [{
        matrix: null,
        x: cx,
        y: cy,
        z: cz,
        r: Math.max(4, rVis),
        rVis,
        minx,
        miny,
        minz,
        maxx,
        maxy,
        maxz,
        lod: 2,
        drawn: true,
      }],
    });
  }
  if (!remove.size) return;
  for (let i = batches.length - 1; i >= 0; i--) {
    if (remove.has(i)) batches.splice(i, 1);
  }
}

export function resetKitLodState(root) {
  if (root && kitLodState && kitLodState.root !== root) return;
  kitLodState = null;
}

/**
 * After height rasterize: instance the kit and split each type into LOD0 / LOD2 batches.
 * Nearby copies use the high-detail mesh; far copies stay on the LOD2 export.
 * Pairing is (actor name + material name) — not "first primitive on the node".
 */
export async function setupStoryKitDistanceLod(root, THREE) {
  kitLodState = null;
  if (!root || !THREE) return;
  if (root.userData && root.userData.rtsSkipDistanceLod) {
    console.log('[RTSVR5] kit distance LOD skipped (overview groundscape)');
    return;
  }
  root.updateMatrixWorld(true);
  if (!THREE.InstancedMesh) return;

  let lod0 = { byNode: new Map(), gltf: null };
  // Only pair LOD0 from the SAME glTF (combined LOD0+LOD2 scenes). The separate
  // Story LOD0 file shares actor names but not pivots — swapping to it hides the
  // piece that is right in front of the camera.
  const lod0Root = root.userData && root.userData.rtsLod0Root;
  if (lod0Root) {
    try {
      lod0 = await loadLod0PrimsByNode({
        lod0Root,
        skipIndoor: !(root.userData && root.userData.rtsSkipIndoor === false),
      });
    } catch (err) {
      console.warn('[RTSVR5] LOD0 kit load failed, LOD2 only', err);
    }
  }

  const sceneRoot = kitSceneRoot(root);
  const parentInv = new THREE.Matrix4();
  parentInv.copy(root.matrixWorld).invert();
  const local = new THREE.Matrix4();
  const buckets = new Map();
  const liveMatByName = new Map();
  const nodeXform = new Map();
  const keepGeo = new Set();
  const keepMat = new Set();
  const meshes = [];
  root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.visible) return;
    if (o.name === 'rts-kit-ground') return;
    meshes.push(o);
    const mn = matNameOf(o);
    if (mn && !liveMatByName.has(mn)) liveMatByName.set(mn, o.material);
  });

  for (const mesh of meshes) {
    const geo = mesh.geometry;
    const mat = mesh.material;
    if (!geo || !mat || Array.isArray(mat)) continue;
    if (!geo.attributes || !geo.attributes.position) continue;
    const instName = instanceNodeName(mesh, sceneRoot);
    const det = mesh.matrixWorld.determinant();
    const key = `${geo.uuid}|${mat.uuid}|${det < 0 ? 'm' : 'p'}`;
    let b = buckets.get(key);
    if (!b) {
      b = { geo2: geo, geo0: null, mat, recv: !!mesh.receiveShadow, label: instName || mesh.name || 'kit', meshes: [] };
      buckets.set(key, b);
    }
    b.meshes.push(mesh);
    if (!nodeXform.has(instName)) {
      nodeXform.set(instName, {
        matrixWorld: mesh.matrixWorld.clone(),
        det,
        recv: !!mesh.receiveShadow,
      });
    }
    const hit = takeLod0Prim(lod0.byNode.get(instName), matNameOf(mesh), geo);
    if (hit && lod0LocalSpaceMatches(hit.geo, geo)) {
      keepGeo.add(hit.geo);
      if (!b.geo0 && hit.geo !== geo) b.geo0 = hit.geo;
    } else if (hit) {
      hit.used = false;
    }
  }

  const batches = [];
  let withLod0 = 0;
  for (const b of buckets.values()) {
    withLod0 += pushInstancedBatch(THREE, root, parentInv, local, batches, b);
  }

  mergeUniqueByMaterial(THREE, root, batches);

  disposeLod0Unused(lod0.gltf, keepGeo, keepMat);

  let uniqueN = 0;
  for (let i = 0; i < batches.length; i++) if (batches[i].unique) uniqueN++;
  kitLodState = { root, batches, hasLod0: withLod0 > 0, lastCullKey: '', uploadedFull: false };
  console.log('[RTSVR5] kit distance LOD', {
    kind: (root.userData && root.userData.rtsKitKind) || 'story',
    combinedLod: !!(root.userData && root.userData.rtsLod0Root),
    sourceMeshes: meshes.length,
    types: buckets.size,
    uniqueDraws: uniqueN,
    withLod0,
    lod0Actors: lod0.byNode.size,
  });
  updateStoryKitLodFromView();
}

let _kitCamVec = null;
let _kitProj = null;
let _kitProjA = null;
let _kitEyeLocal = null;
let _kitEyeWorld = null;
let _kitEyeInv = null;
let _kitSphere = null;
let _kitBox = null;
let _kitXrPoseKey = '';
const _kitFrustums = [];

function instanceCullPad(xr, it) {
  // Headset FOV + timewarp sees wider than the cull frustum; pad must cover
  // large rock/building extents or they pop off while still on-screen.
  const span =
    it && it.maxx != null
      ? Math.max(it.maxx - it.minx, it.maxy - it.miny, it.maxz - it.minz)
      : 0;
  if (xr) return Math.max(48, span * 0.85 + 24);
  return Math.max(12, span * 0.35 + 6);
}

function instanceCullRadius(it, xr) {
  const base = Math.max(it.r || 4, 4);
  return xr ? base * 4 + 28 : base * 2 + 8;
}

function itemTooSmallOnScreen(it, cx, cy, cz) {
  const dx = it.x - cx;
  const dy = it.y - cy;
  const dz = it.z - cz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < 55 * 55) return false;
  const d = Math.sqrt(d2);
  const r = it.rVis || it.r || 4;
  // Was 0.0055 — culled mid-size props while still readable in VR periphery.
  return r / d < 0.0025;
}

function aabbInAnyFrustum(_it, _xr) {
  // ALWAYS visible. Previous CPU frustum used viewer-pose × cameraRig in a way that
  // stayed near the *spawn* facing: as you yaw/pitch away, a growing wedge of the
  // real view was treated as "outside" (~deg-proportional pop-out). Distance LOD
  // below is enough; InstancedMesh already batches draws.
  return true;
}

function xrSessionActive(renderer, sceneEl) {
  if (typeof window !== 'undefined' && window.__rtsKitCullForceXr) return true;
  if (renderer && renderer.xr && renderer.xr.isPresenting) return true;
  if (sceneEl && typeof sceneEl.is === 'function' && sceneEl.is('vr-mode')) return true;
  return false;
}

function projectionLooksValid(cam) {
  const pe = cam && cam.projectionMatrix && cam.projectionMatrix.elements;
  return !!(pe && Math.abs(pe[0]) > 1e-6 && Math.abs(pe[5]) > 1e-6);
}

function pushWorldProjFrustum(THREE, n, worldMat, projMat) {
  if (!_kitEyeInv) _kitEyeInv = new THREE.Matrix4();
  _kitEyeInv.copy(worldMat).invert();
  if (!_kitFrustums[n]) _kitFrustums[n] = new THREE.Frustum();
  _kitProj.multiplyMatrices(projMat, _kitEyeInv);
  // Widen cull FOV (~22%) so periphery matches what the headset still composites.
  const e = _kitProj.elements;
  e[0] *= 0.78;
  e[5] *= 0.78;
  _kitFrustums[n].setFromProjectionMatrix(_kitProj);
}

function xrViewerPose(renderer) {
  try {
    const xr = renderer && renderer.xr;
    if (!xr || typeof xr.getFrame !== 'function' || typeof xr.getReferenceSpace !== 'function') return null;
    const frame = xr.getFrame();
    const space = xr.getReferenceSpace();
    if (!frame || !space || typeof frame.getViewerPose !== 'function') return null;
    return frame.getViewerPose(space);
  } catch (_) {
    return null;
  }
}

function refreshKitCullFrustums(THREE, renderCam) {
  const sceneEl = typeof document !== 'undefined' ? document.querySelector('a-scene') : null;
  const renderer = sceneEl && sceneEl.renderer;
  if (!_kitProj) _kitProj = new THREE.Matrix4();
  if (!_kitProjA) _kitProjA = new THREE.Matrix4();
  if (!_kitEyeLocal) _kitEyeLocal = new THREE.Matrix4();
  if (!_kitEyeWorld) _kitEyeWorld = new THREE.Matrix4();
  if (!_kitSphere) _kitSphere = new THREE.Sphere();
  if (!_kitBox) _kitBox = new THREE.Box3();
  let n = 0;
  _kitXrPoseKey = '';
  const testCams = typeof window !== 'undefined' ? window.__rtsKitCullTestCameras : null;
  const addCam = (cam) => {
    if (!cam || cam.isArrayCamera) return;
    if (cam.cameras && cam.cameras.length) return;
    if (!cam.projectionMatrix || !projectionLooksValid(cam)) return;
    if (!cam.matrixWorldInverse) return;
    cam.updateMatrixWorld();
    if (!_kitFrustums[n]) _kitFrustums[n] = new THREE.Frustum();
    _kitProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const e = _kitProj.elements;
    e[0] *= 0.85;
    e[5] *= 0.85;
    _kitFrustums[n].setFromProjectionMatrix(_kitProj);
    n++;
  };
  if (Array.isArray(testCams) && testCams.length) {
    for (let i = 0; i < testCams.length; i++) addCam(testCams[i]);
  } else if (xrSessionActive(renderer, sceneEl)) {
    // Headset orientation lives on XRViewerPose, NOT on the RTS #camera entity.
    // Thumbstick yaws cameraRig (parent.matrixWorld). Using Three eye.matrix here
    // was often identity at cull time → frustum ignored look-up/down.
    const userCam = renderCam && !renderCam.isArrayCamera ? renderCam : kitCullCamera();
    const parent = userCam && userCam.parent;
    if (parent && parent.updateMatrixWorld) parent.updateMatrixWorld(true);
    const pose = xrViewerPose(renderer);
    const views = pose && pose.views;
    if (views && views.length) {
      _kitXrPoseKey = poseViewKey(views);
      for (let i = 0; i < views.length; i++) {
        const view = views[i];
        const tm = view.transform && view.transform.matrix;
        const pm = view.projectionMatrix;
        if (!tm || !pm) continue;
        _kitEyeLocal.fromArray(tm);
        if (parent && parent.matrixWorld) {
          _kitEyeWorld.multiplyMatrices(parent.matrixWorld, _kitEyeLocal);
        } else {
          _kitEyeWorld.copy(_kitEyeLocal);
        }
        _kitProjA.fromArray(pm);
        pushWorldProjFrustum(THREE, n, _kitEyeWorld, _kitProjA);
        n++;
      }
    } else {
      const xrCam = renderer && renderer.xr && typeof renderer.xr.getCamera === 'function' ? renderer.xr.getCamera() : null;
      const eyes = xrCam && xrCam.cameras;
      if (eyes && eyes.length) {
        for (let i = 0; i < eyes.length; i++) {
          const eye = eyes[i];
          if (!eye || eye.isArrayCamera || !projectionLooksValid(eye)) continue;
          if (parent && parent.matrixWorld) {
            parent.updateMatrixWorld(true);
            _kitEyeWorld.multiplyMatrices(parent.matrixWorld, eye.matrix);
          } else if (eye.matrixWorld) {
            _kitEyeWorld.copy(eye.matrixWorld);
          } else {
            continue;
          }
          pushWorldProjFrustum(THREE, n, _kitEyeWorld, eye.projectionMatrix);
          n++;
        }
      }
    }
  } else {
    addCam(renderCam || kitCullCamera());
  }
  _kitFrustums.length = n;
}

function kitCullKey(cam) {
  if (!cam || !cam.matrixWorld) return '';
  const e = cam.matrixWorld.elements;
  // e[9]/e[10] capture headset pitch; yaw-only keys skipped look-down recull.
  return `${e[12].toFixed(2)},${e[13].toFixed(2)},${e[14].toFixed(2)},${e[0].toFixed(3)},${e[8].toFixed(3)},${e[9].toFixed(3)},${e[10].toFixed(3)}`;
}

function poseViewKey(views) {
  let k = '';
  for (let i = 0; i < views.length; i++) {
    const m = views[i].transform && views[i].transform.matrix;
    if (!m) continue;
    k += `${m[0].toFixed(3)},${m[8].toFixed(3)},${m[9].toFixed(3)},${m[10].toFixed(3)},${m[12].toFixed(2)},${m[13].toFixed(2)},${m[14].toFixed(2)};`;
  }
  return k;
}

function kitCullCamera() {
  const sceneEl = typeof document !== 'undefined' ? document.querySelector('a-scene') : null;
  const camEl = typeof document !== 'undefined' ? document.getElementById('camera') : null;
  return (
    (camEl && camEl.getObject3D && camEl.getObject3D('camera')) ||
    (sceneEl && sceneEl.camera) ||
    null
  );
}

function showAllKitInstances() {
  const batches = kitLodState.batches;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const items = batch.items;
    const n = items.length;
    if (batch.unique && batch.mesh) {
      batch.mesh.visible = true;
      for (let i = 0; i < n; i++) items[i].drawn = true;
      continue;
    }
    if (batch.mesh2) {
      for (let i = 0; i < n; i++) {
        items[i].drawn = true;
        batch.mesh2.setMatrixAt(i, items[i].matrix);
      }
      batch.mesh2.count = n;
      batch.mesh2.visible = n > 0;
      batch.mesh2.instanceMatrix.needsUpdate = n > 0;
    }
    if (batch.mesh0) {
      batch.mesh0.count = 0;
      batch.mesh0.visible = false;
    }
  }
  kitLodState.uploadedFull = !kitLodState.hasLod0;
}

/** Re-bucket kit instances by camera distance only (no view frustum). */
export function updateStoryKitLodFromView(renderCam) {
  if (!kitLodState || !kitLodState.batches.length) return;
  if (kitLodState.root && kitLodState.root.visible === false) return;
  const THREE = window.THREE;
  if (!THREE) return;
  if (!_kitCamVec) _kitCamVec = new THREE.Vector3();

  const hasLod0 = !!kitLodState.hasLod0;
  // No LOD0 swap → upload every instance once and leave them alone. Frustum cull
  // was the yaw-proportional pop-out bug; do not bring it back.
  if (!hasLod0) {
    if (!kitLodState.uploadedFull) showAllKitInstances();
    return;
  }

  const cam = renderCam && !renderCam.isArrayCamera ? renderCam : kitCullCamera();
  if (!cam || !cam.matrixWorld) return;
  cam.updateMatrixWorld();
  if (typeof cam.getWorldPosition === 'function') cam.getWorldPosition(_kitCamVec);
  else {
    _kitCamVec.set(
      cam.matrixWorld.elements[12],
      cam.matrixWorld.elements[13],
      cam.matrixWorld.elements[14]
    );
  }
  const cx = _kitCamVec.x;
  const cy = _kitCamVec.y;
  const cz = _kitCamVec.z;
  const key = kitCullKey(cam);
  if (kitLodState.lastCullKey === key) return;
  kitLodState.lastCullKey = key;

  const batches = kitLodState.batches;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const items = batch.items;
    const nItems = items.length;
    if (batch.unique && batch.mesh) {
      const it = items[0];
      batch.mesh.frustumCulled = false;
      const vis = !itemTooSmallOnScreen(it, cx, cy, cz);
      batch.mesh.visible = vis;
      it.drawn = vis;
      continue;
    }
    let n0 = 0;
    let n2 = 0;
    for (let i = 0; i < nItems; i++) {
      const it = items[i];
      if (itemTooSmallOnScreen(it, cx, cy, cz)) {
        it.drawn = false;
        continue;
      }
      it.drawn = true;
      let lod = it.lod;
      if (batch.mesh0) {
        const dx = it.x - cx;
        const dy = it.y - cy;
        const dz = it.z - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (lod === 0) {
          if (d > it.dFar) lod = 2;
        } else if (d < it.dNear) lod = 0;
        it.lod = lod;
      }
      if (lod === 0 && batch.mesh0) {
        batch.mesh0.setMatrixAt(n0++, it.matrix);
      } else if (batch.mesh2) {
        batch.mesh2.setMatrixAt(n2++, it.matrix);
      }
    }
    if (batch.mesh0) {
      batch.mesh0.count = n0;
      batch.mesh0.visible = n0 > 0;
      batch.mesh0.instanceMatrix.needsUpdate = n0 > 0;
      batch.mesh0.frustumCulled = false;
    }
    if (batch.mesh2) {
      batch.mesh2.count = n2;
      batch.mesh2.visible = n2 > 0;
      batch.mesh2.instanceMatrix.needsUpdate = n2 > 0;
      batch.mesh2.frustumCulled = false;
    }
  }
  kitLodState.uploadedFull = false;
}

if (typeof window !== 'undefined') window.__rtsUpdateKitLod = updateStoryKitLodFromView;

function barycentric(px, pz, ax, az, bx, bz, cx, cz) {
  const v0x = bx - ax;
  const v0z = bz - az;
  const v1x = cx - ax;
  const v1z = cz - az;
  const v2x = px - ax;
  const v2z = pz - az;
  const den = v0x * v1z - v1x * v0z;
  if (Math.abs(den) < 1e-12) return null;
  const v = (v2x * v1z - v1x * v2z) / den;
  const w = (v0x * v2z - v2x * v0z) / den;
  const u = 1 - v - w;
  if (u < -1e-4 || v < -1e-4 || w < -1e-4) return null;
  return [u, v, w];
}

function isKitGroundMesh(obj) {
  if (!obj || obj.name === 'rts-kit-ground') return true;
  const n = `${obj.name || ''} ${obj.parent && obj.parent.name ? obj.parent.name : ''}`;
  return /SM_Dirt|SM_Rock|SM_Sand|SM_Ground|SM_Road|SM_Floor|Landscape|Terrain/i.test(n);
}

/**
 * Max-Y heightfield on the same lattice as the central plate (`iy` outer, `ix` inner).
 * Ground-like meshes only — stamping buildings put fog on rooftops and hid the kit.
 * @returns {Promise<Float32Array>}
 */
export async function rasterizeKitHeights(root, THREE, mapSize, segsW, segsD, yieldFn) {
  const row = segsW + 1;
  const grid = new Float32Array(row * (segsD + 1));
  const half = mapSize * 0.5;
  const cell = mapSize / segsW;
  root.updateMatrixWorld(true);

  const va = new THREE.Vector3();
  const vb = new THREE.Vector3();
  const vc = new THREE.Vector3();
  let tris = 0;

  const stampTri = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const minx = Math.min(ax, bx, cx);
    const maxx = Math.max(ax, bx, cx);
    const minz = Math.min(az, bz, cz);
    const maxz = Math.max(az, bz, cz);
    let ix0 = Math.floor((minx + half) / cell);
    let ix1 = Math.ceil((maxx + half) / cell);
    let iy0 = Math.floor((half - maxz) / cell);
    let iy1 = Math.ceil((half - minz) / cell);
    ix0 = Math.max(0, ix0);
    ix1 = Math.min(segsW, ix1);
    iy0 = Math.max(0, iy0);
    iy1 = Math.min(segsD, iy1);
    for (let iy = iy0; iy <= iy1; iy++) {
      const wz = half - (iy / segsD) * mapSize;
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = -half + (ix / segsW) * mapSize;
        const b = barycentric(wx, wz, ax, az, bx, bz, cx, cz);
        if (!b) continue;
        const y = b[0] * ay + b[1] * by + b[2] * cy;
        const i = iy * row + ix;
        if (y > grid[i]) grid[i] = y;
      }
    }
  };

  const meshes = [];
  root.traverse((obj) => {
    if ((obj.isMesh || obj.isSkinnedMesh) && obj.visible && obj.geometry && !obj.isInstancedMesh && isKitGroundMesh(obj)) {
      meshes.push(obj);
    }
  });
  if (!meshes.length) {
    root.traverse((obj) => {
      if ((obj.isMesh || obj.isSkinnedMesh) && obj.visible && obj.geometry && !obj.isInstancedMesh) meshes.push(obj);
    });
  }

  for (let m = 0; m < meshes.length; m++) {
    const obj = meshes[m];
    const geo = obj.geometry;
    const pos = geo.attributes && geo.attributes.position;
    if (!pos) continue;
    const mw = obj.matrixWorld;
    const idx = geo.index;
    const apply = (ia, ib, ic) => {
      va.fromBufferAttribute(pos, ia).applyMatrix4(mw);
      vb.fromBufferAttribute(pos, ib).applyMatrix4(mw);
      vc.fromBufferAttribute(pos, ic).applyMatrix4(mw);
      stampTri(va.x, va.y, va.z, vb.x, vb.y, vb.z, vc.x, vc.y, vc.z);
      tris++;
    };
    if (idx) {
      const arr = idx.array;
      for (let i = 0; i + 2 < arr.length; i += 3) apply(arr[i], arr[i + 1], arr[i + 2]);
    } else {
      for (let i = 0; i + 2 < pos.count; i += 3) apply(i, i + 1, i + 2);
    }
    if (yieldFn && (m & 15) === 15) await yieldFn();
  }

  console.log('[RTSVR5] kit height raster', { tris, segsW, segsD, mapSize });
  return grid;
}
