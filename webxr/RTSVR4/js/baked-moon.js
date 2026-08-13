/**
 * Skirmish moon geometry from the UE export.
 * Surface look = live moon albedo + normal + AO under the scene sun via MeshLambert.
 * No MeshStandard, no IBL, no triplanar, no PCF — same dust/pockmarks, cheap lighting.
 */
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MAP_TERRAIN_STYLE } from './config.js';

export const BAKED_SKIRMISH_GLB = 'assets/terrain/terrain-skirmish-ue-lm.glb';
const MIN_BAKE_BYTES = 800000;
const MIN_VERTS = 5000;
const LIVE_MOON_DIFF = 'assets/textures/moon_01_2k/moon_01_diff_2k.jpg';
const LIVE_MOON_NOR = 'assets/textures/moon_01_2k/moon_01_nor_gl_2k.jpg';
const LIVE_MOON_AO = 'assets/textures/moon_01_2k/moon_01_ao_2k.jpg';
const MOON_UV_REPEAT = 3.35;
const MAP_PLATE_M = 200;

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

export function bakedMoonAllowed() {
  if (typeof location !== 'undefined') {
    const q = `${location.search || ''}${location.hash || ''}`;
    if (/(?:[?&#]livepbr=1\b)|(?:[?&#]livepbr(?:&|$))/.test(q)) return false;
  }
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

  const moonMeshes = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    if (!/^Moon_\d/i.test(obj.name || '')) {
      obj.visible = false;
      return;
    }
    moonMeshes.push(obj);
  });
  if (!moonMeshes.length) {
    console.warn('[RTSVR4] skip baked moon: no Moon_* meshes');
    return null;
  }

  const keep = new W.Group();
  keep.name = 'rts-ground-mesh';
  for (const src of moonMeshes) {
    keep.add(adoptMeshForAframe(src, W));
  }
  keep.rotation.x = Math.PI / 2;
  keep.updateMatrixWorld(true);

  rewriteAlbedoUvsFromWorldXz(keep, W);
  recomputeTangents(keep);
  await bindCheapMoonLook(keep, W);

  console.log('[RTSVR4] baked moon ready', {
    bytes: buf.byteLength,
    verts,
    moonMeshes: moonMeshes.length,
    look: 'lambert+normal',
  });
  return keep;
}

function adoptMeshForAframe(src, W) {
  const geo = new W.BufferGeometry();
  const srcGeo = src.geometry;
  for (const name of Object.keys(srcGeo.attributes)) {
    const a = srcGeo.attributes[name];
    geo.setAttribute(name, new W.BufferAttribute(a.array, a.itemSize, a.normalized));
  }
  if (srcGeo.index) {
    geo.setIndex(new W.BufferAttribute(srcGeo.index.array, 1));
  }
  const mesh = new W.Mesh(geo, new W.MeshLambertMaterial({ color: 0x888888 }));
  mesh.name = src.name;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.frustumCulled = true;
  return mesh;
}

function rewriteAlbedoUvsFromWorldXz(root, W) {
  const half = MAP_PLATE_M * 0.5;
  const v = new W.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.attributes.position;
    let uv = mesh.geometry.attributes.uv;
    if (!pos) return;
    if (!uv || uv.count !== pos.count) {
      uv = new W.BufferAttribute(new Float32Array(pos.count * 2), 2);
      mesh.geometry.setAttribute('uv', uv);
    }
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      mesh.localToWorld(v);
      uv.setXY(i, (v.x + half) / MAP_PLATE_M, (-v.z + half) / MAP_PLATE_M);
    }
    uv.needsUpdate = true;
    mesh.geometry.setAttribute('uv2', uv.clone());
  });
}

function recomputeTangents(root) {
  root.traverse((mesh) => {
    if (!mesh.isMesh || !mesh.geometry?.computeTangents) return;
    try {
      if (!mesh.geometry.index) return;
      mesh.geometry.computeTangents();
    } catch (_) {
      /* degenerate */
    }
  });
}

function loadMoonTex(W, url, linear) {
  return new Promise((resolve) => {
    const loader = new W.TextureLoader();
    loader.setCrossOrigin('anonymous');
    loader.load(
      url,
      (tex) => {
        tex.wrapS = tex.wrapT = W.RepeatWrapping;
        tex.repeat.set(MOON_UV_REPEAT, MOON_UV_REPEAT);
        tex.generateMipmaps = true;
        tex.minFilter = W.LinearMipmapLinearFilter;
        tex.magFilter = W.LinearFilter;
        if (linear) {
          if ('colorSpace' in tex && W.NoColorSpace) tex.colorSpace = W.NoColorSpace;
        } else if ('colorSpace' in tex && W.SRGBColorSpace) {
          tex.colorSpace = W.SRGBColorSpace;
        }
        const sceneEl = document.querySelector('a-scene');
        const renderer = sceneEl && sceneEl.renderer;
        if (renderer?.capabilities?.getMaxAnisotropy) {
          tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
        }
        if (renderer && typeof renderer.initTexture === 'function') {
          try {
            renderer.initTexture(tex);
          } catch (_) {
            /* ignore */
          }
        }
        resolve(tex);
      },
      undefined,
      () => resolve(null)
    );
  });
}

async function bindCheapMoonLook(root, W) {
  const [diff, nor, ao] = await Promise.all([
    loadMoonTex(W, LIVE_MOON_DIFF, false),
    loadMoonTex(W, LIVE_MOON_NOR, true),
    loadMoonTex(W, LIVE_MOON_AO, true),
  ]);
  if (!diff) {
    console.warn('[RTSVR4] baked moon: live albedo failed');
    return;
  }
  const mat = new W.MeshLambertMaterial({
    map: diff,
    color: 0xffffff,
    fog: false,
  });
  // No IBL on Lambert — lift so the same albedo reads like the old Standard+env fill.
  mat.color.setRGB(1.55, 1.55, 1.55);
  if (nor) {
    mat.normalMap = nor;
    mat.normalScale = new W.Vector2(1, 1);
  }
  if (ao) {
    mat.aoMap = ao;
    mat.aoMapIntensity = 0.5;
  }
  mat.envMap = null;
  if ('envMapIntensity' in mat) mat.envMapIntensity = 0;
  mat.userData.cheapMoonLook = true;
  mat.needsUpdate = true;

  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.material = mat;
    obj.receiveShadow = false;
    obj.castShadow = false;
  });
}
