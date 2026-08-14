/**
 * Skirmish moon from the UE GLB: heightfield + tiled moon_01 on UV0.
 *
 * Cheap unlit (opt-in `?unlitmoon=1`) is MeshBasic × albedo × a planar-XZ RGB
 * lightmap. Default is live Lambert — the island Lightmass unpack was a pixel
 * grid, and the planar bake is still too flat vs Lambert. `?livepbr=1` /
 * `?nobake=1` uses the procedural plate.
 */
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MAP_TERRAIN_STYLE } from './config.js';

export const BAKED_SKIRMISH_GLB = 'assets/terrain/terrain-skirmish-ue-lm.glb';
const MIN_BAKE_BYTES = 800000;
const MIN_VERTS = 5000;

function parseGlbJson(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not glb');
  const jsonLen = dv.getUint32(12, true);
  const jsonType = dv.getUint32(16, true);
  if (jsonType !== 0x4e4f534a) throw new Error('no JSON chunk');
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
}

function gltfPositionVerts(json) {
  let n = 0;
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const acc = json.accessors?.[prim.attributes?.POSITION];
      if (acc) n += acc.count;
    }
  }
  return n;
}

function wantUnlitBake() {
  if (typeof location === 'undefined') return false;
  const q = `${location.search || ''}${location.hash || ''}`;
  return /(?:[?&#]unlitmoon=1\b)|(?:[?&#]unlitmoon(?:&|$))/.test(q);
}

function adoptTexture(src, W, linear) {
  if (!src || !src.image) return null;
  const tex = new W.Texture();
  tex.image = src.image;
  tex.needsUpdate = true;
  tex.flipY = src.flipY;
  tex.wrapS = W.RepeatWrapping;
  tex.wrapT = W.RepeatWrapping;
  tex.magFilter = src.magFilter;
  tex.minFilter = src.minFilter;
  tex.generateMipmaps = src.generateMipmaps !== false;
  if (linear) {
    if ('colorSpace' in tex && W.NoColorSpace) tex.colorSpace = W.NoColorSpace;
  } else if ('colorSpace' in tex && W.SRGBColorSpace) {
    tex.colorSpace = W.SRGBColorSpace;
  }
  if (src.repeat) tex.repeat.copy(src.repeat);
  if (src.offset) tex.offset.copy(src.offset);
  return tex;
}

function adoptLightmapTexture(src, W) {
  if (!src || !src.image) return null;
  const tex = new W.Texture();
  tex.image = src.image;
  tex.needsUpdate = true;
  tex.flipY = false;
  tex.wrapS = W.ClampToEdgeWrapping;
  tex.wrapT = W.ClampToEdgeWrapping;
  tex.magFilter = W.LinearFilter;
  tex.minFilter = W.LinearFilter;
  tex.generateMipmaps = false;
  if ('channel' in tex) tex.channel = 1;
  if ('colorSpace' in tex && W.NoColorSpace) tex.colorSpace = W.NoColorSpace;
  return tex;
}

function lmIndexForName(name) {
  const m = /Moon_(\d)/i.exec(name || '');
  if (m) return Number(m[1]);
  if (/skirt/i.test(name || '')) return 1;
  return 0;
}

function setPlanarUv1(geo, W, bbox) {
  const pos = geo.attributes.position;
  const uv1 = new Float32Array(pos.count * 2);
  const minX = bbox.min[0];
  const minZ = bbox.min[2];
  const sx = bbox.max[0] - minX || 1;
  const sz = bbox.max[2] - minZ || 1;
  for (let i = 0; i < pos.count; i++) {
    uv1[i * 2] = (pos.getX(i) - minX) / sx;
    uv1[i * 2 + 1] = (pos.getZ(i) - minZ) / sz;
  }
  const attr = new W.BufferAttribute(uv1, 2);
  geo.setAttribute('uv1', attr);
  geo.setAttribute('uv2', attr.clone());
}

export function bakedMoonAllowed() {
  if (typeof location === 'undefined') return false;
  const q = `${location.search || ''}${location.hash || ''}`;
  if (/(?:[?&#]livepbr=1\b)|(?:[?&#]livepbr(?:&|$))/.test(q)) return false;
  if (/(?:[?&#]nobake=1\b)|(?:[?&#]nobake(?:&|$))/.test(q)) return false;
  return MAP_TERRAIN_STYLE !== 'hills';
}

export async function tryLoadBakedSkirmishMoon() {
  if (!bakedMoonAllowed()) return null;
  let res;
  try {
    res = await fetch(BAKED_SKIRMISH_GLB, { cache: 'no-store' });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength < MIN_BAKE_BYTES) {
    console.warn('[RTSVR4] skip baked moon: file too small', buf.byteLength);
    return null;
  }
  let json;
  try {
    json = parseGlbJson(buf);
  } catch (err) {
    console.warn('[RTSVR4] skip baked moon: bad GLB', err);
    return null;
  }
  const verts = gltfPositionVerts(json);
  if (verts < MIN_VERTS) {
    console.warn('[RTSVR4] skip baked moon: decimated mesh', { bytes: buf.byteLength, verts });
    return null;
  }

  const W = window.THREE;
  if (!W) {
    console.warn('[RTSVR4] skip baked moon: no A-Frame THREE');
    return null;
  }

  const loader = new GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(buf, '', resolve, reject);
  });

  const keep = new W.Group();
  keep.name = 'rts-ground-mesh';
  const moonMeshes = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    if (!/^Moon_\d/i.test(obj.name || '') && !/^rts-moon-/i.test(obj.name || '')) {
      obj.visible = false;
      return;
    }
    moonMeshes.push(obj);
  });
  if (!moonMeshes.length) {
    console.warn('[RTSVR4] skip baked moon: no Moon_* meshes');
    return null;
  }
  const recv =
    typeof window._getDynamicShadowsEnabled === 'function'
      ? !!window._getDynamicShadowsEnabled()
      : true;

  const lmSpecs = json.extras?.rtsMoonRgbLightmaps || [];
  const planarOk =
    wantUnlitBake() &&
    lmSpecs.length > 0 &&
    lmSpecs.every((s) => s.layout === 'planar-xz' && s.bbox);
  const lmTexByIndex = [];
  if (planarOk && gltf.parser) {
    for (let i = 0; i < lmSpecs.length; i++) {
      const spec = lmSpecs[i];
      try {
        const src = await gltf.parser.getDependency('texture', spec.textureIndex);
        lmTexByIndex[i] = {
          tex: adoptLightmapTexture(src, W),
          intensity: spec.intensity || Math.PI,
          bbox: spec.bbox,
        };
      } catch (err) {
        console.warn('[RTSVR4] baked moon lightmap', i, err);
      }
    }
  }

  const usePlanar = planarOk && lmTexByIndex.every((e) => e && e.tex && e.bbox);
  let look = 'lambert+glb-moon01';
  for (const src of moonMeshes) {
    const lm = usePlanar ? lmTexByIndex[lmIndexForName(src.name)] : null;
    const mat =
      lm && lm.tex
        ? makeBakedMoonMaterial(src.material, W, recv, lm.tex, lm.intensity)
        : makeLitMoonMaterial(src.material, W, recv);
    if (mat.userData.bakedRgbLm) look = 'basic+planar-lm';
    keep.add(adoptMeshForAframe(src, W, recv, mat, lm && lm.bbox));
  }
  keep.updateMatrixWorld(true);

  console.log('[RTSVR4] baked moon ready', {
    bytes: buf.byteLength,
    verts,
    moonMeshes: moonMeshes.length,
    look,
    planarLm: usePlanar,
  });
  return keep;
}

function makeBakedMoonMaterial(srcMat, W, recv, lmTex, intensity) {
  const mat = new W.MeshBasicMaterial({
    color: 0xffffff,
    fog: false,
  });
  mat.map = adoptTexture(srcMat && srcMat.map, W, false);
  mat.color.setRGB(1.55, 1.55, 1.55);
  mat.lightMap = lmTex;
  mat.lightMapIntensity = intensity || Math.PI;
  mat.envMap = null;
  if ('envMapIntensity' in mat) mat.envMapIntensity = 0;
  mat.toneMapped = true;
  mat.userData.cheapMoonLook = true;
  mat.userData.bakedRgbLm = true;
  mat.userData.shadowRecv = recv;
  mat.needsUpdate = true;
  return mat;
}

function makeLitMoonMaterial(srcMat, W, recv) {
  const mat = new W.MeshLambertMaterial({
    color: 0xffffff,
    fog: false,
  });
  mat.map = adoptTexture(srcMat && srcMat.map, W, false);
  mat.normalMap = adoptTexture(srcMat && srcMat.normalMap, W, true);
  if (mat.normalMap) mat.normalScale = new W.Vector2(1, 1);
  mat.aoMap = adoptTexture(srcMat && srcMat.aoMap, W, true);
  if (mat.aoMap) {
    mat.aoMapIntensity = 0.5;
    if ('channel' in mat.aoMap) mat.aoMap.channel = 0;
  }
  mat.lightMap = null;
  mat.envMap = null;
  if ('envMapIntensity' in mat) mat.envMapIntensity = 0;
  mat.color.setRGB(1.55, 1.55, 1.55);
  mat.userData.cheapMoonLook = true;
  mat.userData.shadowRecv = recv;
  mat.needsUpdate = true;
  return mat;
}

function adoptMeshForAframe(src, W, recv, sharedMat, planarBbox) {
  src.updateMatrixWorld(true);
  const geo = new W.BufferGeometry();
  const srcGeo = src.geometry;
  for (const name of Object.keys(srcGeo.attributes)) {
    const a = srcGeo.attributes[name];
    geo.setAttribute(name, new W.BufferAttribute(a.array.slice(), a.itemSize, a.normalized));
  }
  if (srcGeo.index) {
    geo.setIndex(new W.BufferAttribute(srcGeo.index.array.slice(), 1));
  }
  const baked = new W.Matrix4();
  baked.fromArray(src.matrixWorld.elements);
  geo.applyMatrix4(baked);
  if (geo.attributes.normal) geo.normalizeNormals();
  if (planarBbox) {
    setPlanarUv1(geo, W, planarBbox);
  } else if (geo.attributes.uv && !geo.attributes.uv2) {
    geo.setAttribute('uv2', geo.attributes.uv.clone());
  }
  try {
    if (!planarBbox && geo.index && geo.attributes.uv && geo.computeTangents) geo.computeTangents();
  } catch (_) {
    /* degenerate */
  }
  geo.computeBoundingBox();
  geo.computeBoundingSphere();

  const mesh = new W.Mesh(geo, sharedMat);
  mesh.name = src.name;
  mesh.receiveShadow = recv;
  mesh.castShadow = false;
  mesh.frustumCulled = true;
  return mesh;
}
