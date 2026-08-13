/**
 * Skirmish moon *geometry* from the UE 4.27 Lightmass export.
 * Visuals are the live triplanar MeshStandard moon (same as before) — MeshBasic×LM
 * flattened the dust/normals and fought the scene sun.
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
  // UE dumped (orig.x, orig.z, -orig.y). Rx(+90°) restores Y-up XZ ground.
  keep.rotation.x = Math.PI / 2;
  keep.updateMatrixWorld(true);

  console.log('[RTSVR4] baked moon ready', {
    bytes: buf.byteLength,
    verts,
    moonMeshes: moonMeshes.length,
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
  const mesh = new W.Mesh(geo, new W.MeshLambertMaterial({ color: 0x5c5c60 }));
  mesh.name = src.name;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.frustumCulled = true;
  return mesh;
}
