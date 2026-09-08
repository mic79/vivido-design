/**
 * Skirmish moon from the UE GLB: heightfield + tiled moon_01 on UV0.
 *
 * Cheap unlit (opt-in `?unlitmoon=1`) is MeshBasic × albedo × a planar-XZ RGB
 * lightmap. Default is live Lambert — the island Lightmass unpack was a pixel
 * grid, and the planar bake is still too flat vs Lambert. `?livepbr=1` /
 * `?nobake=1` uses the procedural plate.
 */
import { MAP_TERRAIN_STYLE } from './config.js';
import { ensureThreeGltfLoaders } from './three-gltf-umd.js';
import { installFogVisualOnMaterial } from './fog-visual.js';

/** Moon-only crater (Lambert). Kept as fallback / A0. */
export const BAKED_SKIRMISH_MOON_GLB = 'assets/terrain/terrain-skirmish-ue-lm.glb';
/**
 * Combined 1v1 scene: Moon_* crater + Prop_* rocks seated on the surface
 * (Blender `seat-rocks-on-crater.py` / UE Skirmish1v1). Prefer this for B0.
 */
export const BAKED_SKIRMISH_1V1_GLB = 'assets/terrain/terrain-skirmish-1v1.glb';
/** @deprecated use BAKED_SKIRMISH_MOON_GLB or BAKED_SKIRMISH_1V1_GLB */
export const BAKED_SKIRMISH_GLB = BAKED_SKIRMISH_1V1_GLB;
const MIN_BAKE_BYTES = 800000;
const MIN_VERTS = 5000;

/** Props extracted from the combined 1v1 GLB (already surface-seated). Kept as a
 * template — rematch must clone again; a one-shot `take` forced the quest-rocks fallback. */
let embeddedSkirmishPropsTemplate = null;

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
  // Same as RTSVR4: crater skirmish uses the UE Lambert moon bake by default.
  return MAP_TERRAIN_STYLE === 'crater';
}

let glbBufCache = null;
let glbBufUrl = null;

function wantCombined1v1() {
  if (typeof location === 'undefined') return true;
  const q = `${location.search || ''}${location.hash || ''}`;
  // Opt out of combined crater+rocks file (moon-only bake).
  if (/(?:[?&#]moononly=1\b)/i.test(q)) return false;
  return true;
}

async function fetchBakeBuffer() {
  const urls = wantCombined1v1()
    ? [BAKED_SKIRMISH_1V1_GLB, BAKED_SKIRMISH_MOON_GLB]
    : [BAKED_SKIRMISH_MOON_GLB];
  for (const url of urls) {
    let res;
    try {
      res = await fetch(url);
    } catch {
      continue;
    }
    if (!res.ok) continue;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < MIN_BAKE_BYTES) continue;
    return { buf, url };
  }
  return null;
}

/** Fresh Prop_* group from the combined 1v1 bake (clone of retained template). */
export function takeEmbeddedSkirmishProps() {
  if (!embeddedSkirmishPropsTemplate) return null;
  const props = embeddedSkirmishPropsTemplate.clone(true);
  props.name = 'rts-overview-props';
  props.userData = {
    ...embeddedSkirmishPropsTemplate.userData,
    rtsOverviewProps: true,
    rtsSceneryMode: 'B0',
    rtsQuestRocksProps: true,
    rtsSeatedOnCrater: true,
    rtsSeatedClone: true,
  };
  return props;
}

export function peekEmbeddedSkirmishProps() {
  return embeddedSkirmishPropsTemplate;
}

export async function tryLoadBakedSkirmishMoon() {
  if (!bakedMoonAllowed()) return null;
  if (!glbBufCache) {
    const got = await fetchBakeBuffer();
    if (!got) {
      console.warn('[RTSVR4] skip baked moon: no GLB');
      return null;
    }
    glbBufCache = got.buf;
    glbBufUrl = got.url;
  }
  const buf = glbBufCache;
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

  await ensureThreeGltfLoaders();
  const loader = new W.GLTFLoader();
  const gltf = await new Promise((resolve, reject) => {
    loader.parse(buf, '', resolve, reject);
  });

  const keep = new W.Group();
  keep.userData.rtsSkirmishBake = true;
  keep.userData.rtsBakeUrl = glbBufUrl || '';
  keep.name = 'rts-ground-mesh';
  const moonMeshes = [];
  const propMeshes = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    const n = obj.name || '';
    if (/^Moon_\d/i.test(n) || /^rts-moon-/i.test(n)) {
      moonMeshes.push(obj);
      return;
    }
    if (/^Prop_/i.test(n) || /^(?:SM_)?(?:Rock|Cliff|Dirt|Mineral)/i.test(n)) {
      propMeshes.push(obj);
      return;
    }
    obj.visible = false;
  });
  if (!moonMeshes.length) {
    console.warn('[RTSVR4] skip baked moon: no Moon_* meshes');
    return null;
  }

  // Surface-seated scenery from the combined 1v1 GLB (skip second rocks fetch).
  // Retained as a template so every rematch can clone props again.
  embeddedSkirmishPropsTemplate = null;
  if (propMeshes.length) {
    const props = new W.Group();
    props.name = 'rts-overview-props-template';
    props.userData.rtsOverviewProps = true;
    props.userData.rtsSceneryMode = 'B0';
    props.userData.rtsQuestRocksProps = true;
    props.userData.rtsSeatedOnCrater = true;
    props.userData.rtsKitUrl = glbBufUrl || BAKED_SKIRMISH_1V1_GLB;
    for (const src of propMeshes) {
      src.updateMatrixWorld(true);
      const clone = src.clone(true);
      clone.matrix.copy(src.matrixWorld);
      clone.matrix.decompose(clone.position, clone.quaternion, clone.scale);
      clone.matrixAutoUpdate = true;
      props.add(clone);
    }
    props.updateMatrixWorld(true);
    embeddedSkirmishPropsTemplate = props;
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

  const rockShadowSpecs = json.extras?.rtsMoonRockShadows || [];
  const rockShadowByIndex = [];
  if (rockShadowSpecs.length && gltf.parser) {
    for (let i = 0; i < rockShadowSpecs.length; i++) {
      const spec = rockShadowSpecs[i];
      if (!spec || spec.layout !== 'planar-xz' || !spec.bbox) continue;
      try {
        const src = await gltf.parser.getDependency('texture', spec.textureIndex);
        rockShadowByIndex[i] = {
          tex: adoptLightmapTexture(src, W),
          bbox: spec.bbox,
        };
      } catch (err) {
        console.warn('[RTSVR5] rock shadow map', i, err);
      }
    }
  }

  const usePlanar = planarOk && lmTexByIndex.every((e) => e && e.tex && e.bbox);
  let look = 'lambert+glb-moon01';
  let rockShadows = 0;
  for (const src of moonMeshes) {
    const idx = lmIndexForName(src.name);
    const lm = usePlanar ? lmTexByIndex[idx] : null;
    const rs = rockShadowByIndex[idx] || null;
    const mat =
      lm && lm.tex
        ? makeBakedMoonMaterial(src.material, W, recv, lm.tex, lm.intensity, rs)
        : makeLitMoonMaterial(src.material, W, recv, rs);
    if (mat.userData.bakedRgbLm) look = 'basic+planar-lm';
    if (rs && rs.tex) rockShadows += 1;
    // Planar uv1 from rock-shadow bbox (preferred) or unlit RGB LM bbox.
    const planarBbox = (rs && rs.bbox) || (lm && lm.bbox) || null;
    keep.add(adoptMeshForAframe(src, W, recv, mat, planarBbox));
  }
  keep.updateMatrixWorld(true);

  console.log('[RTSVR4] baked moon ready', {
    bytes: buf.byteLength,
    url: glbBufUrl,
    verts,
    moonMeshes: moonMeshes.length,
    propMeshes: propMeshes.length,
    look,
    planarLm: usePlanar,
    rockShadows,
  });
  return keep;
}

function makeBakedMoonMaterial(srcMat, W, recv, lmTex, intensity, rockShadow) {
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
  // Unlit path already uses lightMap for RGB lighting; multiply albedo by rock shadow.
  if (rockShadow && rockShadow.tex) {
    const shadowTex = rockShadow.tex;
    mat.userData.rockShadowMap = shadowTex;
    mat.userData.rockShadowStrength = 0;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader) => {
      if (typeof prev === 'function') prev(shader);
      shader.uniforms.rockShadowMap = { value: shadowTex };
      shader.uniforms.rockShadowStrength = { value: 0 };
      mat.userData._rockShadowStrengthUniform = shader.uniforms.rockShadowStrength;
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
uniform sampler2D rockShadowMap;
uniform float rockShadowStrength;`
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
	if ( rockShadowStrength > 0.5 ) {
		diffuseColor.rgb *= texture2D( rockShadowMap, vLightMapUv ).rgb;
	}`
        );
    };
    mat.customProgramCacheKey = () => `unlitMoonRockShadow|${mat.uuid}`;
  }
  mat.needsUpdate = true;
  installFogVisualOnMaterial(mat);
  return mat;
}

/**
 * Rock shadows are a planar grayscale atlas on uv1. Three's lightMap *adds*
 * irradiance; we keep lightMapIntensity at 0 and multiply diffuse by the atlas.
 * `rockShadowStrength` stays 0 until scenery props attach (intro/lobby = clean moon).
 */
function attachRockShadowMultiply(mat, shadowTex) {
  if (!mat || !shadowTex) return;
  mat.lightMap = shadowTex;
  mat.lightMapIntensity = 0;
  mat.userData.rockShadowMap = shadowTex;
  mat.userData.rockShadowStrength = 0;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    if (typeof prev === 'function') prev(shader);
    shader.uniforms.rockShadowStrength = { value: mat.userData.rockShadowStrength ? 1 : 0 };
    mat.userData._rockShadowStrengthUniform = shader.uniforms.rockShadowStrength;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
uniform float rockShadowStrength;`
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `#include <aomap_fragment>
#ifdef USE_LIGHTMAP
	if ( rockShadowStrength > 0.5 ) {
		float rockShadow = texture2D( lightMap, vLightMapUv ).r;
		reflectedLight.directDiffuse *= rockShadow;
		reflectedLight.indirectDiffuse *= rockShadow;
	}
#endif
`
      );
  };
  mat.customProgramCacheKey = () =>
    `moonRockShadow|${mat.userData.shadowRecv ? 1 : 0}|${mat.uuid}`;
}

/** Enable/disable baked rock-shadow multiply on a moon root (props on ↔ on). */
export function setBakedMoonRockShadowsEnabled(root, enabled) {
  if (!root || typeof root.traverse !== 'function') return;
  const on = !!enabled;
  root.traverse((obj) => {
    const mats = obj.isMesh
      ? Array.isArray(obj.material)
        ? obj.material
        : obj.material
          ? [obj.material]
          : []
      : [];
    for (const mat of mats) {
      if (!mat || !mat.userData || !mat.userData.rockShadowMap) continue;
      mat.userData.rockShadowStrength = on ? 1 : 0;
      const u = mat.userData._rockShadowStrengthUniform;
      if (u) u.value = on ? 1 : 0;
      mat.needsUpdate = true;
    }
  });
}

function makeLitMoonMaterial(srcMat, W, recv, rockShadow) {
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
  if (rockShadow && rockShadow.tex) attachRockShadowMultiply(mat, rockShadow.tex);
  mat.needsUpdate = true;
  installFogVisualOnMaterial(mat);
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
