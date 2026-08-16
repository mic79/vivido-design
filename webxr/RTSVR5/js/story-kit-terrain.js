/**
 * Story battlefield: Modular Sci-Fi kit GLB (no landscape). Centered on origin,
 * water planes / giant outlier cliffs hidden, dark fill plate under gaps.
 */
import { MAP_SIZE } from './config.js';
import { ensureThreeGltfLoaders } from './three-gltf-umd.js';

export const STORY_KIT_GLB = 'assets/terrain/scifi-rts-overview.glb';
export const STORY_KIT_LOD2_GLB = 'assets/terrain/scifi-rts-kit-lod2.glb';
export const STORY_KIT_LOD0_GLB = 'assets/terrain/scifi-rts-kit-lod0.glb';
export const OVERVIEW_KIT_GLB = 'assets/terrain/scifi-overview-lods.glb';
export const OVERVIEW_KIT_QUEST_GLB = 'assets/terrain/scifi-overview-lods-quest.glb';
const MIN_BYTES = 8_000_000;
const MIN_OVERVIEW_BYTES = 400_000;
/** Switch to LOD0 when closer than this × mesh radius (clamped). */
const LOD_NEAR_RADIUS_MUL = 6.5;
const LOD_NEAR_MIN = 52;
const LOD_NEAR_MAX = 240;
const LOD_FAR_MUL = 1.5;

let glbBufCache = null;
let overviewBufCache = null;
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

function findGltfScene(gltf, name) {
  const scenes = gltf.scenes || [];
  for (let i = 0; i < scenes.length; i++) {
    if (scenes[i] && scenes[i].name === name) return scenes[i];
  }
  return null;
}

/**
 * @param {object} gltf
 * @param {{ kind: string, skipIndoor?: boolean, clipRadius?: number, hideScale?: number, bytes?: number }} opts
 */
function assembleKitWrap(gltf, opts) {
  const W = window.THREE;
  const kind = opts.kind || 'story';
  const skipIndoor = opts.skipIndoor !== false;
  const clipRadius = opts.clipRadius == null ? 420 : opts.clipRadius;
  const hideScale = opts.hideScale == null ? 20 : opts.hideScale;

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
        if (obj.geometry && obj.geometry.dispose) obj.geometry.dispose();
      });
    }
  }

  scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    const n = meshName(obj);
    if (/WaterPlane|Skybox|Template_Map_Floor/i.test(n) || (skipIndoor && /Indoor/i.test(n))) {
      obj.visible = false;
      return;
    }
    if (worldScaleMax(obj, W) > hideScale) obj.visible = false;
  });

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
  const cluster = new W.Box3();
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
  const y0 =
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

  const recv =
    typeof window._getDynamicShadowsEnabled === 'function'
      ? !!window._getDynamicShadowsEnabled()
      : true;
  scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    obj.castShadow = false;
    obj.receiveShadow = recv;
    obj.frustumCulled = true;
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat) continue;
        mat.fog = false;
        if ('envMapIntensity' in mat) mat.envMapIntensity = 0.35;
      }
    }
  });

  const wrap = new W.Group();
  wrap.name = kind === 'overview' ? 'rts-overview-kit' : 'rts-story-kit';
  wrap.userData.rtsStoryKit = true;
  wrap.userData.rtsKitKind = kind;
  wrap.userData.rtsSkipIndoor = skipIndoor;
  if (lod0Root) wrap.userData.rtsLod0Root = lod0Root;
  wrap.add(scene);

  const plate = new W.Mesh(
    new W.PlaneGeometry(MAP_SIZE * 1.08, MAP_SIZE * 1.08),
    new W.MeshLambertMaterial({ color: 0x141210, fog: false })
  );
  plate.name = 'rts-kit-ground';
  plate.rotation.x = -Math.PI / 2;
  plate.position.y = -0.04;
  plate.receiveShadow = recv;
  plate.castShadow = false;
  wrap.add(plate);
  wrap.updateMatrixWorld(true);

  const span = cluster.max.clone().sub(cluster.min);
  console.log('[RTSVR5] kit ready', {
    kind,
    bytes: opts.bytes || 0,
    combinedLod: !!lod0Root,
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

/**
 * @returns {Promise<import('three').Group|null>}
 */
export async function tryLoadStoryKit() {
  const W = window.THREE;
  if (!W) return null;

  if (!glbBufCache) {
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
  }

  const gltf = await parseKitBuf(glbBufCache);
  return assembleKitWrap(gltf, {
    kind: 'story',
    skipIndoor: true,
    clipRadius: 420,
    bytes: glbBufCache.byteLength,
  });
}

/**
 * Skirmish battlefield: OverviewScene catalog, LOD0+LOD2 in one GLB (textures once).
 * @returns {Promise<import('three').Group|null>}
 */
export async function tryLoadOverviewKit() {
  const W = window.THREE;
  if (!W) return null;

  if (!overviewBufCache) {
    const quest = wantQuestOverview();
    const urls = quest ? [OVERVIEW_KIT_QUEST_GLB, OVERVIEW_KIT_GLB] : [OVERVIEW_KIT_GLB];
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
      if (next.byteLength < MIN_OVERVIEW_BYTES) continue;
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
      console.warn('[RTSVR5] skip overview kit: missing GLB');
      return null;
    }
    overviewBufCache = buf;
    console.log('[RTSVR5] overview kit file', { url: used, bytes: buf.byteLength, quest });
  }

  const gltf = await parseKitBuf(overviewBufCache);
  return assembleKitWrap(gltf, {
    kind: 'overview',
    skipIndoor: true,
    clipRadius: 0,
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
let _kitSphere = null;
let _kitBox = null;
const _kitFrustums = [];

function instanceCullPad(xr) {
  return xr ? 8 : 3;
}

function instanceCullRadius(it, xr) {
  const base = Math.max(it.r || 4, 4);
  return xr ? base * 2.5 + 10 : base * 1.5 + 4;
}

function itemTooSmallOnScreen(it, cx, cy, cz) {
  const dx = it.x - cx;
  const dy = it.y - cy;
  const dz = it.z - cz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 < 40 * 40) return false;
  const d = Math.sqrt(d2);
  const r = it.rVis || it.r || 4;
  return r / d < 0.0055;
}

function aabbInAnyFrustum(it, xr) {
  if (!_kitFrustums.length) return true;
  if (it.minx == null || !_kitBox) {
    return sphereInAnyFrustum(it.x, it.y, it.z, instanceCullRadius(it, xr));
  }
  const pad = instanceCullPad(xr);
  _kitBox.min.set(it.minx - pad, it.miny - pad, it.minz - pad);
  _kitBox.max.set(it.maxx + pad, it.maxy + pad, it.maxz + pad);
  for (let i = 0; i < _kitFrustums.length; i++) {
    if (_kitFrustums[i].intersectsBox(_kitBox)) return true;
  }
  return false;
}

function xrSessionActive(renderer, sceneEl) {
  if (typeof window !== 'undefined' && window.__rtsKitCullForceXr) return true;
  if (renderer && renderer.xr && renderer.xr.isPresenting) return true;
  if (sceneEl && typeof sceneEl.is === 'function' && sceneEl.is('vr-mode')) return true;
  return false;
}

function sphereInAnyFrustum(x, y, z, r) {
  if (!_kitSphere || !_kitFrustums.length) return true;
  _kitSphere.center.set(x, y, z);
  _kitSphere.radius = r;
  for (let i = 0; i < _kitFrustums.length; i++) {
    if (_kitFrustums[i].intersectsSphere(_kitSphere)) return true;
  }
  return false;
}

function projectionLooksValid(cam) {
  const pe = cam && cam.projectionMatrix && cam.projectionMatrix.elements;
  return !!(pe && Math.abs(pe[0]) > 1e-6 && Math.abs(pe[5]) > 1e-6);
}

function composeEyeWorld(eye, parent) {
  if (parent && parent.matrixWorld) {
    parent.updateMatrixWorld(true);
    eye.matrixWorld.multiplyMatrices(parent.matrixWorld, eye.matrix);
  } else {
    eye.matrixWorld.copy(eye.matrix);
  }
  eye.matrixWorldInverse.copy(eye.matrixWorld).invert();
}

function refreshKitCullFrustums(THREE, renderCam) {
  const sceneEl = typeof document !== 'undefined' ? document.querySelector('a-scene') : null;
  const renderer = sceneEl && sceneEl.renderer;
  if (!_kitProj) _kitProj = new THREE.Matrix4();
  if (!_kitSphere) _kitSphere = new THREE.Sphere();
  if (!_kitBox) _kitBox = new THREE.Box3();
  let n = 0;
  const testCams = typeof window !== 'undefined' ? window.__rtsKitCullTestCameras : null;
  const addCam = (cam) => {
    if (!cam || cam.isArrayCamera) return;
    if (cam.cameras && cam.cameras.length) return;
    if (!cam.projectionMatrix || !projectionLooksValid(cam)) return;
    if (!cam.matrixWorldInverse) return;
    cam.updateMatrixWorld();
    if (!_kitFrustums[n]) _kitFrustums[n] = new THREE.Frustum();
    _kitProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _kitFrustums[n].setFromProjectionMatrix(_kitProj);
    n++;
  };
  if (Array.isArray(testCams) && testCams.length) {
    for (let i = 0; i < testCams.length; i++) addCam(testCams[i]);
  } else if (xrSessionActive(renderer, sceneEl)) {
    // Do NOT call renderer.xr.updateCamera() here. That path rewrites eye
    // projection from PerspectiveCamera.fov (~50°) and hides headset-visible
    // meshes. Views already wrote XR projection + local matrix this frame.
    const userCam = kitCullCamera();
    const parent = userCam && userCam.parent;
    const xrCam = renderer && renderer.xr && typeof renderer.xr.getCamera === 'function' ? renderer.xr.getCamera() : null;
    const eyes = xrCam && xrCam.cameras;
    if (eyes && eyes.length) {
      for (let i = 0; i < eyes.length; i++) {
        const eye = eyes[i];
        if (!eye || eye.isArrayCamera) continue;
        if (!projectionLooksValid(eye)) continue;
        composeEyeWorld(eye, parent);
        if (!_kitFrustums[n]) _kitFrustums[n] = new THREE.Frustum();
        _kitProj.multiplyMatrices(eye.projectionMatrix, eye.matrixWorldInverse);
        _kitFrustums[n].setFromProjectionMatrix(_kitProj);
        n++;
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
  return `${e[12].toFixed(2)},${e[13].toFixed(2)},${e[14].toFixed(3)},${e[0].toFixed(3)},${e[8].toFixed(3)}`;
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

/** Re-bucket kit instances by camera distance / frustum. No-op if kit is not loaded. */
export function updateStoryKitLodFromView(renderCam) {
  if (!kitLodState || !kitLodState.batches.length) return;
  if (kitLodState.root && kitLodState.root.visible === false) return;
  const THREE = window.THREE;
  if (!THREE) return;
  if (!_kitCamVec) _kitCamVec = new THREE.Vector3();
  const sceneEl = typeof document !== 'undefined' ? document.querySelector('a-scene') : null;
  const renderer = sceneEl && sceneEl.renderer;
  const xr = xrSessionActive(renderer, sceneEl);
  const cam = renderCam && !renderCam.isArrayCamera ? renderCam : kitCullCamera();
  if (!cam || !cam.matrixWorld) return;
  cam.updateMatrixWorld();
  refreshKitCullFrustums(THREE, renderCam);
  if (xr && _kitFrustums.length < 1) {
    showAllKitInstances();
    kitLodState.lastCullKey = '';
    return;
  }
  let keyCam = cam;
  const testCams = typeof window !== 'undefined' ? window.__rtsKitCullTestCameras : null;
  if (Array.isArray(testCams) && testCams[0]) {
    keyCam = testCams[0];
    keyCam.updateMatrixWorld();
  } else if (xr && renderer && renderer.xr && typeof renderer.xr.getCamera === 'function') {
    const xrCam = renderer.xr.getCamera();
    if (xrCam && xrCam.cameras && xrCam.cameras[0] && !xrCam.cameras[0].isArrayCamera) {
      keyCam = xrCam.cameras[0];
      // matrixWorld already composed in refreshKitCullFrustums — do not
      // updateMatrixWorld() (that drops the rig parent and parks the eye at origin).
    } else {
      keyCam.updateMatrixWorld();
    }
  } else {
    keyCam.updateMatrixWorld();
  }
  if (typeof keyCam.getWorldPosition === 'function') keyCam.getWorldPosition(_kitCamVec);
  else if (typeof cam.getWorldPosition === 'function') cam.getWorldPosition(_kitCamVec);
  const cx = _kitCamVec.x;
  const cy = _kitCamVec.y;
  const cz = _kitCamVec.z;
  const fx = -keyCam.matrixWorld.elements[8];
  const fy = -keyCam.matrixWorld.elements[9];
  const fz = -keyCam.matrixWorld.elements[10];
  const key = kitCullKey(keyCam);
  const hasLod0 = !!kitLodState.hasLod0;
  if (!hasLod0 && kitLodState.lastCullKey === key && kitLodState.uploadedFull) return;
  if (!hasLod0 && kitLodState.uploadedFull) {
    let allIn = true;
    for (let b = 0; b < kitLodState.batches.length && allIn; b++) {
      const items = kitLodState.batches[b].items;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!aabbInAnyFrustum(it, xr)) {
          allIn = false;
          break;
        }
      }
    }
    if (allIn) {
      kitLodState.lastCullKey = key;
      return;
    }
  }
  kitLodState.lastCullKey = key;

  const batches = kitLodState.batches;
  let anyPartial = false;
  let drewAny = false;
  let uniqueOn = 0;
  let uniqueOff = 0;
  let instOn = 0;
  let hiddenInFront = 0;
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const items = batch.items;
    const nItems = items.length;
    if (batch.unique && batch.mesh) {
      const it = items[0];
      if (xr) {
        // Stereo render culls per eye. CPU-hiding here used a stale/wrong
        // frustum and dropped pieces sitting in the headset view.
        batch.mesh.visible = true;
        batch.mesh.frustumCulled = true;
        it.drawn = true;
        uniqueOn++;
        drewAny = true;
        continue;
      }
      batch.mesh.frustumCulled = false;
      const vis = aabbInAnyFrustum(it, xr) && !itemTooSmallOnScreen(it, cx, cy, cz);
      batch.mesh.visible = vis;
      it.drawn = vis;
      if (vis) {
        uniqueOn++;
        drewAny = true;
      } else {
        uniqueOff++;
        anyPartial = true;
        const dx = it.x - cx;
        const dy = it.y - cy;
        const dz = it.z - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > 0.2 && dist < 55) {
          const ndot = (dx * fx + dy * fy + dz * fz) / dist;
          if (ndot > 0.65) hiddenInFront++;
        }
      }
      continue;
    }
    let n0 = 0;
    let n2 = 0;
    for (let i = 0; i < nItems; i++) {
      const it = items[i];
      if (!aabbInAnyFrustum(it, xr)) {
        it.drawn = false;
        const dx = it.x - cx;
        const dy = it.y - cy;
        const dz = it.z - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > 0.2 && dist < 55) {
          const ndot = (dx * fx + dy * fy + dz * fz) / dist;
          if (ndot > 0.65) hiddenInFront++;
        }
        continue;
      }
      if (itemTooSmallOnScreen(it, cx, cy, cz)) {
        it.drawn = false;
        continue;
      }
      it.drawn = true;
      let lod = it.lod;
      if (hasLod0 && batch.mesh0) {
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
    if (n0 + n2 < nItems) anyPartial = true;
    if (n0 + n2 > 0) drewAny = true;
    instOn += n0 + n2;
    if (batch.mesh0) {
      batch.mesh0.count = n0;
      batch.mesh0.visible = n0 > 0;
      batch.mesh0.instanceMatrix.needsUpdate = n0 > 0;
    }
    if (batch.mesh2) {
      batch.mesh2.count = n2;
      batch.mesh2.visible = n2 > 0;
      batch.mesh2.instanceMatrix.needsUpdate = n2 > 0;
    }
  }
  kitLodState.uploadedFull = !hasLod0 && drewAny && !anyPartial;
  if (typeof window !== 'undefined') {
    window.__rtsKitCullDebug = {
      xr,
      nFrustums: _kitFrustums.length,
      uniqueOn,
      uniqueOff,
      instOn,
      hiddenInFront,
      fov: keyCam.fov || 0,
    };
  }
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
