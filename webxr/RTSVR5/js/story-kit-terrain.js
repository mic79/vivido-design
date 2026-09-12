/**
 * Story battlefield: Modular Sci-Fi kit GLB (no landscape). Centered on origin,
 * water planes / giant outlier cliffs hidden, dark fill plate under gaps.
 */
import { MAP_SIZE, MAP_UNIT_NAV_RADIUS, cameraFocusCullRadiusM, wantFocusSceneryCull } from './config.js';
import { ensureThreeGltfLoaders } from './three-gltf-umd.js';
import * as State from './state.js';
import {
  applyPropSelfShadowOnUniqueMesh,
  preparePropSelfShadowInstancedMaterial,
  fillInstanceSelfRects,
} from './prop-self-shadows.js';
import { applyHeroRgbLightmap, isHeroPropName } from './hero-lightmaps.js';
import { installFogVisualUnder } from './fog-visual.js';

export const STORY_KIT_GLB = 'assets/terrain/scifi-rts-overview.glb';
export const STORY_KIT_LOD2_GLB = 'assets/terrain/scifi-rts-kit-lod2.glb';
export const STORY_KIT_LOD0_GLB = 'assets/terrain/scifi-rts-kit-lod0.glb';
/**
 * Quest-90 base scenery: UE rocks/cliffs/dirt (Draco + KTX2).
 * ~20 shared meshes → ≲40 scenery draws after instancing (envelope ≲140).
 * Built by `scripts/compress-rts-quest.mjs` from `scifi-rts-rocks.glb`.
 * Full JPEG Story kit: `?noquest=1` → `scifi-rts-kit-lod2.glb` (PCVR A/B only).
 */
export const STORY_KIT_QUEST_GLB = 'assets/terrain/scifi-rts-quest.glb';
/** Skirmish lean A/B: same UE rocks master (uncompressed JPEG twin). */
export const STORY_ROCKS_GLB = 'assets/terrain/scifi-rts-rocks.glb';
/** `?rocksx2=1` — same rocks plus a 90°-rotated deep copy: 2430 rocks, 40 textures. */
export const STORY_ROCKS_X2_GLB = 'assets/terrain/scifi-rts-rocks-x2.glb';
export const OVERVIEW_KIT_GLB = 'assets/terrain/scifi-overview-lods.glb';
export const OVERVIEW_KIT_QUEST_GLB = 'assets/terrain/scifi-overview-lods-quest.glb';
/** Skirmish dirt+rocks (~1.3MB float rebake). Full catalog is `?fullkit=1` only. */
export const OVERVIEW_ROCKS_GLB = 'assets/terrain/scifi-overview-rocks.glb';
export const OVERVIEW_GROUNDSCAPE_GLB = 'assets/terrain/scifi-overview-groundscape.glb';
const MIN_BYTES = 8_000_000;
/** Quest-90 rocks encode is small (~1–3MB). */
const MIN_QUEST_KIT_BYTES = 400_000;
const MIN_OVERVIEW_BYTES = 400_000;
const MIN_ROCKS_BYTES = 100_000;
const MIN_STORY_ROCKS_BYTES = 1_000_000;
/** Switch to LOD0 when closer than this × mesh radius (clamped). */
const LOD_NEAR_RADIUS_MUL = 6.5;
const LOD_NEAR_MIN = 52;
const LOD_NEAR_MAX = 240;
const LOD_FAR_MUL = 1.5;

let _maxAnisotropy = 0;

/**
 * Kit GLB textures ship at the Three default anisotropy of 1, which smears ground and
 * cliff detail at the grazing angles an RTS camera spends most of its time at. Costs
 * texture-fetch bandwidth only — no extra draws or triangles.
 */
function applyKitTextureAnisotropy(mat) {
  if (!_maxAnisotropy) {
    try {
      const sceneEl = document.querySelector('a-scene');
      const caps = sceneEl && sceneEl.renderer && sceneEl.renderer.capabilities;
      _maxAnisotropy = caps && caps.getMaxAnisotropy ? caps.getMaxAnisotropy() : 1;
    } catch (_) {
      _maxAnisotropy = 1;
    }
  }
  const aniso = Math.min(16, _maxAnisotropy || 1);
  if (aniso <= 1) return;
  for (const slot of ['map', 'normalMap', 'roughnessMap', 'aoMap', 'emissiveMap']) {
    const tex = mat[slot];
    if (tex && tex.anisotropy !== aniso) {
      tex.anisotropy = aniso;
      tex.needsUpdate = true;
    }
  }
}

let glbBufCache = null;
/** Which Story kit URL `glbBufCache` holds (desktop LOD2 vs Quest KTX2). */
let glbBufUrl = null;
let rocksBufCache = null;
/** Which rocks GLB `rocksBufCache` holds, so `?rocksx2=1` does not reuse the 1x buffer. */
let rocksBufUrl = null;
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

/**
 * Prefer Quest KTX2/Draco kit (`scifi-rts-quest.glb`) on PCVR and Quest.
 * Opt out with `?noquest=1` to force the desktop JPEG `scifi-rts-kit-lod2.glb`.
 * (`?quest=1` kept as an explicit alias; default is already Quest encode.)
 */
function wantQuestAssets() {
  if (typeof location === 'undefined') return true;
  const q = `${location.search || ''}${location.hash || ''}`;
  if (/(?:[?&#]noquest=1\b)/.test(q)) return false;
  return true;
}

function wantQuestOverview() {
  return wantQuestAssets();
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
 * Original modular map sat on a water sheet (`SM_WaterPlane*`). That Y is the
 * true "ground" the props were authored against — dirt mins sit ~1–2 m above it.
 * @returns {number|null} world-space top of water (median), or null if absent
 */
function sampleWaterSurfaceY(scene, W) {
  const ys = [];
  scene.updateMatrixWorld(true);
  scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    if (!/WaterPlane/i.test(meshName(obj))) return;
    // Measure even if already hidden — geometry is still present for Story.
    const prev = obj.visible;
    obj.visible = true;
    const box = new W.Box3().setFromObject(obj);
    obj.visible = prev;
    if (!box.isEmpty()) ys.push(box.max.y);
  });
  if (!ys.length) return null;
  ys.sort((a, b) => a - b);
  return ys[Math.floor((ys.length - 1) * 0.5)];
}

function dirtFloorYFromMins(dirtMins, fallbackMinY) {
  if (!dirtMins.length) return fallbackMinY;
  dirtMins.sort((a, b) => a - b);
  return dirtMins[Math.max(0, Math.floor(dirtMins.length * 0.1))];
}

/**
 * @param {object} gltf
 * @param {{ kind: string, skipIndoor?: boolean, clipRadius?: number, hideScale?: number, bytes?: number, keepNameRe?: RegExp|null, noPlate?: boolean, targetSpanM?: number, skipDistanceLod?: boolean, asProps?: boolean, url?: string, quest?: boolean }} opts
 */
function assembleKitWrap(gltf, opts) {
  const W = window.THREE;
  const kind = opts.kind || 'story';
  const skipIndoor = opts.skipIndoor !== false;
  const clipRadius = opts.clipRadius == null ? 420 : opts.clipRadius;
  const hideScale = opts.hideScale == null ? 20 : opts.hideScale;
  const keepNameRe = opts.keepNameRe || null;
  const noPlate = !!opts.noPlate;
  const asProps = !!opts.asProps;
  const targetSpanM = opts.targetSpanM > 0 ? opts.targetSpanM : 0;

  const scene = findGltfScene(gltf, 'LOD2') || gltf.scene;
  // Overview / rocks extracts are single-scene. Story may pair LOD0 for distance swap.
  const lod0Root = kind === 'story' ? findGltfScene(gltf, 'LOD0') : null;
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
    if (/Water|Skybox|Template_Map_Floor/i.test(n) || (skipIndoor && /Indoor/i.test(n))) {
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

  // Need water surface Y before disposing WaterPlane geometry (rocks path).
  const waterYEarly = kind === 'rocks' || keepNameRe ? sampleWaterSurfaceY(scene, W) : null;

  // Dispose hidden meshes' GPU payloads. Rocks extract had water planes left
  // resident (visible=false only) — same class of VRAM thrash as Overview strip.
  // Story full kit keeps dropList geometry for waterY sampling / rare re-show.
  if ((keepNameRe || kind === 'rocks') && dropList.length) {
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
  // Vertical origin = original water surface when present (moon plate replaces water).
  // Dirt-min percentile floats the kit ~1.6 m too high vs that sheet.
  const waterY = waterYEarly != null ? waterYEarly : sampleWaterSurfaceY(scene, W);
  // Story: original mesh-AABB center on the scene root (pivot breaks LOD0 + layout).
  // Overview groundscape: actor-node center + pivot group (scale must not share the offset node).
  let cluster;
  let y0;
  let y0Source = 'dirt';
  if ((kind === 'overview' || asProps) && (keepNameRe || targetSpanM > 0)) {
    const seeded = expandClusterFromActorNodes(scene, W);
    if (!seeded.any || seeded.cluster.isEmpty()) {
      console.warn('[RTSVR5] skip kit: no visible meshes', kind);
      return null;
    }
    cluster = seeded.cluster;
    const dirtMins = seeded.dirtMins;
    y0 = waterY != null ? waterY : dirtFloorYFromMins(dirtMins, cluster.min.y);
    y0Source = waterY != null ? 'water' : 'dirt';
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
      // Props on skirmish: allow span up to nav diameter. Overview extract: clamp to plate.
      const want = asProps ? targetSpanM : Math.min(targetSpanM, MAP_SIZE * 0.85);
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
    y0 = waterY != null ? waterY : dirtFloorYFromMins(dirtMins, cluster.min.y);
    y0Source = waterY != null ? 'water' : 'dirt';
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
        // Rocks extract: glTF default metalness=1 made every cliff read as chrome, and
        // dirt/rock are dielectric, so metalness stays 0. Environment lighting does NOT —
        // it was zeroed chasing a frame cost that measured 0.93 ms GPU/frame against the
        // full kit's 3.57 ms, i.e. the rocks path was never the expensive one.
        if (kind === 'rocks') {
          if ('metalness' in mat) mat.metalness = 0;
          if ('metalnessMap' in mat) mat.metalnessMap = null;
          if ('envMapIntensity' in mat) mat.envMapIntensity = 0.35;
          applyKitTextureAnisotropy(mat);
          mat.needsUpdate = true;
        } else if ('envMapIntensity' in mat) {
          mat.envMapIntensity = kind === 'overview' ? 0.15 : 0.35;
        }
        if (kind === 'overview' && !asProps) {
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
  wrap.name = asProps
    ? 'rts-rocks-props'
    : kind === 'overview'
      ? 'rts-overview-kit'
      : kind === 'rocks'
        ? 'rts-rocks-kit'
        : 'rts-story-kit';
  wrap.userData.rtsStoryKit = !asProps;
  wrap.userData.rtsKitKind = asProps ? 'rocks-props' : kind;
  wrap.userData.rtsSkipIndoor = skipIndoor;
  if (asProps) wrap.userData.rtsQuestRocksProps = true;
  if (opts.url) wrap.userData.rtsKitUrl = opts.url;
  if (opts.quest != null) wrap.userData.rtsKitQuest = !!opts.quest;
  if (opts.skipDistanceLod) wrap.userData.rtsSkipDistanceLod = true;
  if (lod0Root) wrap.userData.rtsLod0Root = lod0Root;
  wrap.add(scene);
  applyTexturePadding(W, wrap);

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
    y0Source,
    waterY: waterY != null ? +waterY.toFixed(2) : null,
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

/** Opt-in Overview rocks-only GLB (A/B). Default Overview path is not this flag. */
function wantOverviewRocksOnly() {
  if (typeof location === 'undefined') return false;
  const q = `${location.search || ''}${location.hash || ''}`;
  return /(?:[?&#]rocks=1\b)/.test(q);
}

async function ensureStoryKitBuffer() {
  const quest = wantQuestAssets();
  const urls = quest
    ? [STORY_KIT_QUEST_GLB, STORY_KIT_LOD2_GLB, STORY_KIT_GLB]
    : [STORY_KIT_LOD2_GLB, STORY_KIT_GLB];
  const wantUrl = urls[0];
  if (glbBufCache && glbBufUrl === wantUrl) return glbBufCache;
  if (glbBufCache && glbBufUrl !== wantUrl) {
    glbBufCache = null;
    glbBufUrl = null;
  }

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
    const minBytes = url === STORY_KIT_QUEST_GLB ? MIN_QUEST_KIT_BYTES : MIN_BYTES;
    if (next.byteLength < minBytes) {
      console.warn('[RTSVR5] skip story kit: file too small', url, next.byteLength);
      continue;
    }
    try {
      parseGlbJson(next);
    } catch (err) {
      console.warn('[RTSVR5] skip story kit: bad GLB', url, err);
      continue;
    }
    buf = next;
    used = url;
    break;
  }
  if (!buf) return null;
  glbBufCache = buf;
  glbBufUrl = used;
  console.log('[RTSVR5] story kit file', {
    url: used,
    bytes: buf.byteLength,
    quest,
  });
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
    url: glbBufUrl || STORY_KIT_LOD2_GLB,
    quest: !!(glbBufUrl && /scifi-rts-quest\.glb/i.test(glbBufUrl)),
  });
}

/**
 * Opt-in rocks-only GLB (`?leanrocks=1` → `scifi-rts-rocks.glb`) plus a tiny
 * depth-occluder sidecar so stereo fill stays blocked without loading the full kit.
 * @returns {Promise<import('three').Group|null>}
 */
export async function tryLoadRocksKit() {
  const W = window.THREE;
  if (!W) return null;

  // `?rocksfile=NAME` picks any GLB in assets/terrain — used to sweep texture count
  // (rocks 20 -> 64 -> 88 -> 103) against the PCVR frame cadence.
  const url = (() => {
    try {
      const q = location.search || '';
      const m = /(?:^|[?&#])rocksfile=([\w.-]+)/i.exec(q);
      if (m) return `assets/terrain/${m[1].endsWith('.glb') ? m[1] : `${m[1]}.glb`}`;
      if (/(?:^|[?&#])rocksx2=1(?:&|$)/i.test(q)) return STORY_ROCKS_X2_GLB;
    } catch (_) {
      /* no location */
    }
    return STORY_ROCKS_GLB;
  })();
  if (rocksBufCache && rocksBufUrl !== url) rocksBufCache = null;
  rocksBufUrl = url;

  if (!rocksBufCache) {
    let res;
    try {
      res = await fetch(url);
    } catch {
      return null;
    }
    if (!res.ok) {
      console.warn('[RTSVR5] skip rocks kit: missing', url);
      return null;
    }
    const next = await res.arrayBuffer();
    if (next.byteLength < MIN_STORY_ROCKS_BYTES) {
      console.warn('[RTSVR5] skip rocks kit: file too small', next.byteLength);
      return null;
    }
    try {
      parseGlbJson(next);
    } catch (err) {
      console.warn('[RTSVR5] skip rocks kit: bad GLB', err);
      return null;
    }
    rocksBufCache = next;
    console.log('[RTSVR5] rocks kit file', { url, bytes: next.byteLength });
  }

  const gltf = await parseKitBuf(rocksBufCache);
  return assembleKitWrap(gltf, {
    kind: 'rocks',
    skipIndoor: true,
    clipRadius: 420,
    skipDistanceLod: false,
    bytes: rocksBufCache.byteLength,
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
    url: used,
  });
}

/**
 * Quest UE rocks as *props* on the crater moon (product path B0).
 * Does not replace the heightfield — moon bake stays the ground.
 * @returns {Promise<import('three').Group|null>}
 */
export async function tryLoadQuestRocksProps() {
  const W = window.THREE;
  if (!W) return null;

  const urls = wantQuestAssets()
    ? [STORY_KIT_QUEST_GLB, STORY_ROCKS_GLB]
    : [STORY_ROCKS_GLB, STORY_KIT_QUEST_GLB];

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
    const minBytes = url === STORY_KIT_QUEST_GLB ? MIN_QUEST_KIT_BYTES : MIN_STORY_ROCKS_BYTES;
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
    console.warn('[RTSVR5] quest rocks props missing');
    return null;
  }

  console.log('[RTSVR5] quest rocks props file', { url: used, bytes: buf.byteLength });
  const gltf = await parseKitBuf(buf);
  // Dressing on crater moon: scale to skirmish nav diameter, keep rocks materials,
  // no Overview emissive hacks, no distance-LOD singleton fight with Story kit.
  return assembleKitWrap(gltf, {
    kind: 'rocks',
    asProps: true,
    skipIndoor: true,
    clipRadius: 0,
    keepNameRe: null,
    noPlate: true,
    targetSpanM: Math.max(MAP_SIZE * 0.9, MAP_UNIT_NAV_RADIUS * 2 * 0.92),
    skipDistanceLod: false,
    bytes: buf.byteLength,
    url: used,
    quest: /scifi-rts-quest\.glb/i.test(used),
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

function makeInstanced(THREE, geo, mat, n, name, recv, opts) {
  const inst = new THREE.InstancedMesh(geo, mat, n);
  inst.name = name;
  inst.castShadow = false;
  inst.receiveShadow = !!recv;
  // Default false: map-spanning Story batches never frustum-skip, and native cull
  // with bad spheres caused XR pop-out before. Rocks cells opt in explicitly.
  inst.frustumCulled = !!(opts && opts.frustumCulled);
  inst.count = 0;
  inst.matrixAutoUpdate = false;
  try {
    if (THREE.DynamicDrawUsage) inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  } catch (_) {
    /* */
  }
  return inst;
}

/** World-ish AABB → InstancedMesh.boundingSphere so Three can skip off-screen cells. */
function syncInstancedBoundsFromItems(THREE, inst, items) {
  if (!inst || !items || !items.length) return;
  if (!_kitBoundBox) _kitBoundBox = new THREE.Box3();
  if (!inst.boundingSphere) inst.boundingSphere = new THREE.Sphere();
  let minx = Infinity;
  let miny = Infinity;
  let minz = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  let maxz = -Infinity;
  let any = false;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.drawn) continue;
    any = true;
    if (it.minx < minx) minx = it.minx;
    if (it.miny < miny) miny = it.miny;
    if (it.minz < minz) minz = it.minz;
    if (it.maxx > maxx) maxx = it.maxx;
    if (it.maxy > maxy) maxy = it.maxy;
    if (it.maxz > maxz) maxz = it.maxz;
  }
  if (!any) {
    inst.boundingSphere.center.set(0, 0, 0);
    inst.boundingSphere.radius = 0;
    return;
  }
  _kitBoundBox.min.set(minx, miny, minz);
  _kitBoundBox.max.set(maxx, maxy, maxz);
  _kitBoundBox.getBoundingSphere(inst.boundingSphere);
  // Pad for headset FOV / timewarp periphery without CPU eye-frustum math.
  inst.boundingSphere.radius *= 1.12;
  inst.frustumCulled = true;
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
  // Unique pieces stay as Mesh (cheaper than InstancedMesh n=1).
  // Keep frustumCulled=false on uniques — XR ArrayCamera + tight unique bounds caused
  // on-screen pop-out before; InstancedMesh cells use native cull instead.
  if (n < 2 && !geo0) {
    const self = root.userData && root.userData.rtsPropSelfShadows;
    const hero = root.userData && root.userData.rtsHeroRgbLightmaps;
    for (let i = 0; i < n; i++) {
      const mesh = spec.meshes[i];
      if (!mesh || !mesh.isMesh) continue;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      const heroName =
        mesh.name || mesh.userData?.rtsSourceNode || mesh.userData?.rtsSelfShadowKey || '';
      let gotHeroLm = false;
      if (hero?.atlases && hero?.byKey) {
        gotHeroLm = applyHeroRgbLightmap(mesh, hero.atlases, hero.byKey, THREE);
      }
      // Planar stamp is dead for heroes (ink blot). Skip when LM present or hero name.
      if (!gotHeroLm && !isHeroPropName(heroName) && self?.atlases && self?.byKey) {
        applyPropSelfShadowOnUniqueMesh(
          mesh,
          self.atlases,
          self.byKey,
          THREE,
          self.meshesByKey
        );
      }
      const sph = sphereFromObject(mesh, tmpBox, tmpSize, tmpCenter);
      batches.push({
        unique: true,
        mesh,
        mesh0: null,
        mesh2: null,
        label: spec.label || mesh.name || '',
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

  // Same batching as Story. Spatial cells + native frustumCulled were rocks-only
  // "optimizations" that diverge from the proven ~90 FPS path and hurt under XR ArrayCamera.
  return pushInstancedBatchCell(
    THREE,
    root,
    parentInv,
    local,
    batches,
    spec,
    spec.meshes,
    tmpBox,
    tmpSize,
    tmpCenter,
    false
  );
}

function pushInstancedBatchCell(THREE, root, parentInv, local, batches, spec, cellMeshes, tmpBox, tmpSize, tmpCenter, useNativeCull) {
  const n = cellMeshes.length;
  if (n < 1) return 0;
  const geo0 = spec.geo0;
  const geo2 = spec.geo2;
  if (geo2 && geo2.computeBoundingSphere) geo2.computeBoundingSphere();
  if (geo0 && geo0.computeBoundingSphere) geo0.computeBoundingSphere();
  const cullOpts = useNativeCull ? { frustumCulled: true } : null;
  const self = root.userData && root.userData.rtsPropSelfShadows;
  let mat = spec.mat;
  if (self?.atlases?.length && self?.byKey) {
    mat = preparePropSelfShadowInstancedMaterial(mat, self.atlases);
  }
  const mesh2 = geo2 ? makeInstanced(THREE, geo2, mat, n, `${spec.label}_lod2`, spec.recv, cullOpts) : null;
  const mesh0 = geo0 ? makeInstanced(THREE, geo0, mat, n, `${spec.label}_lod0`, spec.recv, cullOpts) : null;
  const items = [];
  for (let i = 0; i < n; i++) {
    const mesh = cellMeshes[i];
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
  }
  if (mesh2) {
    mesh2.instanceMatrix.needsUpdate = true;
    mesh2.count = n;
    if (useNativeCull) syncInstancedBoundsFromItems(THREE, mesh2, items);
    if (self?.byKey) fillInstanceSelfRects(mesh2, items, cellMeshes, self.byKey, THREE);
    root.add(mesh2);
  }
  if (mesh0) {
    mesh0.instanceMatrix.needsUpdate = true;
    mesh0.count = 0;
    mesh0.visible = false;
    if (self?.byKey) fillInstanceSelfRects(mesh0, items, cellMeshes, self.byKey, THREE);
    root.add(mesh0);
  }
  batches.push({ items, mesh0, mesh2, label: spec.label || '', nativeCull: !!useNativeCull });
  for (let i = 0; i < n; i++) {
    const mesh = cellMeshes[i];
    if (mesh && mesh.removeFromParent) mesh.removeFromParent();
  }
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
      label: (mat && mat.name) || (batches[idxs[0]] && batches[idxs[0]].label) || 'kit-unique-merged',
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

/**
 * `?texpad=N` — attach N tiny 4x4 textures to the kit so the session holds 90 Hz.
 *
 * Measured on PCVR with 90 s traces, fresh browser per variant: the same rocks geometry
 * decays from 90 Hz to 65 Hz at 20 textures (sec 28) and at 64 textures (sec 12), but
 * SUSTAINS 90 Hz at 88 textures (90/91 s) and 103 textures (91/91 s) — at identical GPU
 * cost, ~1.16-1.22 ms per frame for all of 20/64/88. So the threshold is the number of
 * texture objects, not rendering load, and padding to it costs a few KB rather than the
 * 23 MB of the 88-texture kit subset.
 *
 * Each pad texture needs its own material on a rendered mesh, otherwise three never
 * uploads it and it does not count. The quads are sub-pixel and depth-test off.
 */
function applyTexturePadding(THREE, root) {
  let want = 0;
  try {
    const m = /[?&#]texpad=(\d+)/i.exec(`${location.search || ''}${location.hash || ''}`);
    if (m) want = parseInt(m[1], 10);
  } catch (_) {
    return;
  }
  if (!want || !root) return;
  const holder = new THREE.Group();
  holder.name = 'rts-texpad';
  holder.frustumCulled = false;
  const geo = new THREE.PlaneGeometry(0.002, 0.002);
  for (let i = 0; i < want; i++) {
    // Unique pixel data per texture so nothing dedupes them into one upload.
    const data = new Uint8Array(4 * 4 * 4);
    for (let p = 0; p < data.length; p += 4) {
      data[p] = (i * 7) & 255;
      data[p + 1] = (i * 13) & 255;
      data[p + 2] = (i * 29) & 255;
      data[p + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, 4, 4);
    tex.needsUpdate = true;
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.002, depthWrite: false, depthTest: false })
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = -2000;
    mesh.position.set(0, 1.5, -0.5);
    holder.add(mesh);
  }
  root.add(holder);
  console.log('[RTSVR5] texpad', { added: want });
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
    // Same bucketing as Story — UE rocks export shares BufferGeometry like the full kit.
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

  // Same unique merge as Story (draw join). Rocks used to skip this.
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
  // Same FoW/focus darken as terrain — props must fade black before focus-cull hides them.
  installFogVisualUnder(root);
  updateStoryKitLodFromView();
}

const LEAN_ROCKS_KEEP_RE = /SM_Rock|SM_Dirt|SM_Cliff|SM_Mineral|MI_Rock|MI_Cliff|MI_Dirt|Rocks|Cliff|DirtPile|Mineral/i;

let _leanDepthOnlyMat = null;

function ensureLeanDepthOnlyMaterial(THREE) {
  if (_leanDepthOnlyMat) return _leanDepthOnlyMat;
  _leanDepthOnlyMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    fog: false,
  });
  _leanDepthOnlyMat.name = 'rts-lean-depth-occluder';
  return _leanDepthOnlyMat;
}

/**
 * ?leanrocks=1: rocks stay shaded; buildings become depth-only occluders so HDR
 * sky does not fill the FOV (hiding buildings with visible=false was the PCVR ~65 FPS cliff).
 * Uses the full Story kit GPU path — same moon / textures as the ~90 FPS build.
 */
export function applyLeanRocksHideBuildings(root) {
  const THREE = window.THREE;
  if (!THREE || !kitLodState || !kitLodState.batches) return;
  if (root && kitLodState.root !== root) return;
  const depthMat = ensureLeanDepthOnlyMaterial(THREE);
  const batches = kitLodState.batches;
  let kept = 0;
  let occluders = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const mat =
      (batch.mesh && batch.mesh.material) ||
      (batch.mesh2 && batch.mesh2.material) ||
      (batch.mesh0 && batch.mesh0.material) ||
      null;
    const matName = mat && !Array.isArray(mat) ? mat.name || '' : '';
    const label = `${batch.label || ''} ${batch.mesh && batch.mesh.name ? batch.mesh.name : ''} ${
      batch.mesh2 && batch.mesh2.name ? batch.mesh2.name : ''
    } ${batch.mesh0 && batch.mesh0.name ? batch.mesh0.name : ''} ${matName}`;
    if (LEAN_ROCKS_KEEP_RE.test(label)) {
      kept++;
      continue;
    }
    occluders++;
    batch.occluder = true;
    const items = batch.items || [];
    if (batch.unique && batch.mesh) {
      batch.mesh.material = depthMat;
      batch.mesh.visible = true;
      batch.mesh.castShadow = false;
      batch.mesh.receiveShadow = false;
      batch.mesh.frustumCulled = false;
      if (items[0]) items[0].drawn = true;
      continue;
    }
    if (batch.mesh0) {
      batch.mesh0.visible = false;
      batch.mesh0.count = 0;
    }
    if (batch.mesh2) {
      batch.mesh2.material = depthMat;
      batch.mesh2.castShadow = false;
      batch.mesh2.receiveShadow = false;
      batch.mesh2.frustumCulled = false;
      for (let j = 0; j < items.length; j++) {
        items[j].drawn = true;
        if (items[j].matrix) batch.mesh2.setMatrixAt(j, items[j].matrix);
      }
      batch.mesh2.count = items.length;
      batch.mesh2.visible = items.length > 0;
      batch.mesh2.instanceMatrix.needsUpdate = items.length > 0;
    }
  }
  kitLodState.lastCullKey = '';
  if (kitLodState.root && kitLodState.root.userData) {
    kitLodState.root.userData.rtsLeanRocksVisual = true;
  }
  updateStoryKitLodFromView();
  console.log('[RTSVR5] leanrocks: rocks shaded + building depth occluders', {
    keptBatches: kept,
    occluderBatches: occluders,
  });
}

let _kitCamVec = null;
let _kitBoundBox = null;

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

function kitCullKey(cam) {
  if (!cam || !cam.matrixWorld) return '';
  const e = cam.matrixWorld.elements;
  // e[9]/e[10] capture headset pitch; yaw-only keys skipped look-down recull.
  return `${e[12].toFixed(2)},${e[13].toFixed(2)},${e[14].toFixed(2)},${e[0].toFixed(3)},${e[8].toFixed(3)},${e[9].toFixed(3)},${e[10].toFixed(3)}`;
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

/** Same disk as the blue focus ribbon (cameraRig XZ + zoom-scaled R). */
function readFocusCullDisk() {
  if (!wantFocusSceneryCull()) return null;
  const rig = typeof document !== 'undefined' ? document.getElementById('cameraRig') : null;
  let fx = 0;
  let fy = 40;
  let fz = 0;
  if (rig && rig.object3D) {
    fx = rig.object3D.position.x;
    fy = rig.object3D.position.y;
    fz = rig.object3D.position.z;
  } else if (rig && typeof rig.getAttribute === 'function') {
    const p = rig.getAttribute('position');
    if (p && typeof p === 'object') {
      fx = Number(p.x) || 0;
      fy = Number(p.y) || 40;
      fz = Number(p.z) || 0;
    }
  }
  const r = cameraFocusCullRadiusM(fy);
  return { x: fx, z: fz, r, r2: r * r, key: `${fx.toFixed(1)},${fz.toFixed(1)},${r.toFixed(0)}` };
}

function outsideFocusCullDisk(it, disk) {
  if (!disk) return false;
  const dx = it.x - disk.x;
  const dz = it.z - disk.z;
  return dx * dx + dz * dz > disk.r2;
}

function showAllKitInstances() {
  const THREE = window.THREE;
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
      if (THREE && batch.nativeCull) syncInstancedBoundsFromItems(THREE, batch.mesh2, items);
    }
    if (batch.mesh0) {
      batch.mesh0.count = 0;
      batch.mesh0.visible = false;
    }
  }
  kitLodState.uploadedFull = !kitLodState.hasLod0;
}

/** Re-bucket kit instances by camera distance only (no CPU view frustum). */
export function updateStoryKitLodFromView(renderCam) {
  if (!kitLodState || !kitLodState.batches.length) return;
  if (kitLodState.root && kitLodState.root.visible === false) return;
  // Lobby / pre-match: never pay kit LOD (kit should not be live yet; if it leaked, skip).
  if (State.gameSession && !State.gameSession.gameStarted) return;
  const THREE = window.THREE;
  if (!THREE) return;
  if (!_kitCamVec) _kitCamVec = new THREE.Vector3();

  const hasLod0 = !!kitLodState.hasLod0;

  const cam = renderCam && !renderCam.isArrayCamera ? renderCam : kitCullCamera();
  if (!cam || !cam.matrixWorld) {
    if (!hasLod0 && !kitLodState.uploadedFull) showAllKitInstances();
    return;
  }
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
  const focusDisk = readFocusCullDisk();
  const key = `${kitCullKey(cam)}|${focusDisk ? focusDisk.key : 'nocull'}`;
  if (kitLodState.lastCullKey === key) return;
  kitLodState.lastCullKey = key;

  const batches = kitLodState.batches;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const items = batch.items;
    const nItems = items.length;
    // Depth occluders: leave matrices alone (fully populated at lean setup).
    if (batch.occluder) continue;
    if (batch.unique && batch.mesh) {
      const it = items[0];
      batch.mesh.frustumCulled = false;
      const vis = !outsideFocusCullDisk(it, focusDisk) && !itemTooSmallOnScreen(it, cx, cy, cz);
      batch.mesh.visible = vis;
      it.drawn = vis;
      continue;
    }
    let n0 = 0;
    let n2 = 0;
    for (let i = 0; i < nItems; i++) {
      const it = items[i];
      if (outsideFocusCullDisk(it, focusDisk) || itemTooSmallOnScreen(it, cx, cy, cz)) {
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
      if (batch.nativeCull && n0 > 0) {
        const subset = [];
        for (let i = 0; i < nItems; i++) {
          if (items[i].drawn && items[i].lod === 0) subset.push(items[i]);
        }
        syncInstancedBoundsFromItems(THREE, batch.mesh0, subset);
      } else if (!batch.nativeCull) {
        batch.mesh0.frustumCulled = false;
      }
    }
    if (batch.mesh2) {
      batch.mesh2.count = n2;
      batch.mesh2.visible = n2 > 0;
      batch.mesh2.instanceMatrix.needsUpdate = n2 > 0;
      if (batch.nativeCull && n2 > 0) {
        const subset = [];
        for (let i = 0; i < nItems; i++) {
          const it = items[i];
          if (!it.drawn) continue;
          if (batch.mesh0 && it.lod === 0) continue;
          subset.push(it);
        }
        syncInstancedBoundsFromItems(THREE, batch.mesh2, subset);
      } else if (!batch.nativeCull) {
        batch.mesh2.frustumCulled = false;
      }
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
