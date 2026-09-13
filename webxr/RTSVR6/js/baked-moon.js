/**
 * Skirmish moon from the UE GLB: heightfield + tiled moon_01 on UV0.
 *
 * Cheap unlit (opt-in `?unlitmoon=1`) is MeshBasic × albedo × a planar-XZ RGB
 * lightmap. Default is live Lambert — the island Lightmass unpack was a pixel
 * grid, and the planar bake is still too flat vs Lambert. `?livepbr=1` /
 * `?nobake=1` uses the procedural plate.
 */
import { MAP_TERRAIN_STYLE } from './config.js';
import { ensureThreeGltfLoaders, getSharedKtx2Loader } from './three-gltf-umd.js';
import { installFogVisualOnMaterial } from './fog-visual.js';
import {
  assignPropSelfShadowKeys,
  buildPropSelfShadowLookup,
  sceneryNodeKey,
} from './prop-self-shadows.js';
import {
  buildHeroLightmapLookup,
} from './hero-lightmaps.js';

/** Moon-only crater ridges (Lambert). Lobby/intro scenery + fallback / A0. */
export const BAKED_SKIRMISH_MOON_GLB = 'assets/terrain/terrain-skirmish-ue-lm.glb';
/** Alias: intro/lobby always uses the crater ridges moon (not Hera). */
export const BAKED_SKIRMISH_INTRO_GLB = BAKED_SKIRMISH_MOON_GLB;
/**
 * Match 1v1 ground: Hera Planum heightfield (may be larger than MAP_SIZE_STANDARD).
 * Prop_* rocks are not embedded here — B0 falls back to quest rocks when needed.
 */
export const BAKED_SKIRMISH_1V1_GLB = 'assets/terrain/terrain-skirmish-1v1.glb';
export const BAKED_SKIRMISH_MATCH_GLB = BAKED_SKIRMISH_1V1_GLB;
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
  // Opt out of match Hera file (moon-only crater bake for lobby + match).
  if (/(?:[?&#]moononly=1\b)/i.test(q)) return false;
  return true;
}

/**
 * @param {'intro'|'match'} [mode='match']
 *   intro = crater ridges lobby; match = Hera (or moon-only if `?moononly=1`).
 */
export function preferredSkirmishBakeUrl(mode = 'match') {
  if (mode === 'intro' || !wantCombined1v1()) return BAKED_SKIRMISH_INTRO_GLB;
  return BAKED_SKIRMISH_MATCH_GLB;
}

export function clearBakedMoonGlbCache() {
  glbBufCache = null;
  glbBufUrl = null;
}

async function fetchBakeBuffer(preferUrl) {
  const urls = [];
  if (preferUrl) urls.push(preferUrl);
  // Always allow crater moon as fallback (lobby file / missing match bake).
  if (!urls.includes(BAKED_SKIRMISH_MOON_GLB)) urls.push(BAKED_SKIRMISH_MOON_GLB);
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
  // Re-key after clone so multi-prim order matches the bake.
  if (props.userData.rtsPropSelfShadows) {
    assignPropSelfShadowKeys(props);
    const meshesByKey = new Map();
    props.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const k = o.userData?.rtsSelfShadowKey;
      if (k) meshesByKey.set(k, o);
    });
    props.userData.rtsPropSelfShadows.meshesByKey = meshesByKey;
  }
  if (props.userData.rtsHeroRgbLightmaps) {
    assignPropSelfShadowKeys(props);
  }
  return props;
}

export function peekEmbeddedSkirmishProps() {
  return embeddedSkirmishPropsTemplate;
}

/**
 * @param {{ mode?: 'intro'|'match' }} [opts]
 */
export async function tryLoadBakedSkirmishMoon(opts = {}) {
  if (!bakedMoonAllowed()) return null;
  const mode = opts.mode === 'intro' ? 'intro' : 'match';
  const preferUrl = preferredSkirmishBakeUrl(mode);
  if (glbBufCache && glbBufUrl && glbBufUrl !== preferUrl) {
    // Intro crater ↔ match Hera must not share one cached buffer.
    clearBakedMoonGlbCache();
  }
  if (!glbBufCache) {
    const got = await fetchBakeBuffer(preferUrl);
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
  const mesaHfEarly = !!(json.extras && json.extras.rtsMesaHeightfield);
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    const n = obj.name || '';
    if (/^Moon_\d/i.test(n) || /^rts-moon-/i.test(n)) {
      moonMeshes.push(obj);
      return;
    }
    // Heightfield / Hera bake: ignore leftover UE kit (CircularPlatform, Pump, etc.).
    if (mesaHfEarly) {
      obj.visible = false;
      return;
    }
    if (/^Prop_/i.test(n) || /^(?:SM_)?(?:Rock|Cliff|Dirt|Mineral|Bridge)/i.test(n)) {
      obj.userData.rtsSourceNode = sceneryNodeKey(obj, gltf.scene);
      propMeshes.push(obj);
      return;
    }
    // Keep any other authored scenery from the UE GLB (do not silently drop).
    if (!/^RTS_/i.test(n) && !/light|camera|helper|grid/i.test(n)) {
      obj.userData.rtsSourceNode = sceneryNodeKey(obj, gltf.scene);
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
      clone.userData = {
        ...clone.userData,
        rtsSourceNode: src.userData.rtsSourceNode || sceneryNodeKey(src, gltf.scene),
      };
      props.add(clone);
    }
    props.updateMatrixWorld(true);

    const selfSpec = json.extras?.rtsPropSelfShadows;
    if (
      selfSpec &&
      (selfSpec.layout === 'planar-atlas' || selfSpec.layout === 'uv-atlas') &&
      Array.isArray(selfSpec.atlases) &&
      gltf.parser
    ) {
      const atlases = [];
      for (let i = 0; i < selfSpec.atlases.length; i++) {
        try {
          const src = await gltf.parser.getDependency('texture', selfSpec.atlases[i]);
          const tex = adoptLightmapTexture(src, W);
          if (tex) {
            if ('channel' in tex) tex.channel = 0;
            atlases.push(tex);
          } else {
            atlases.push(null);
          }
        } catch (err) {
          console.warn('[RTSVR6] prop self-shadow atlas', i, err);
          atlases.push(null);
        }
      }
      assignPropSelfShadowKeys(props);
      const byKey = buildPropSelfShadowLookup(selfSpec);
      const meshesByKey = new Map();
      props.traverse((o) => {
        if (!o.isMesh && !o.isSkinnedMesh) return;
        const k = o.userData?.rtsSelfShadowKey;
        if (k) meshesByKey.set(k, o);
      });
      props.userData.rtsPropSelfShadows = {
        atlases,
        byKey,
        meshesByKey,
        dark: selfSpec.dark,
        cell: selfSpec.cell,
      };
      console.log('[RTSVR6] prop self-shadows', {
        atlases: atlases.filter(Boolean).length,
        cells: byKey ? byKey.size : 0,
      });
    }

    // Hero RGB lightmaps (UE Lightmass path / offline soft-PCF UV bake)
    const heroSpec = json.extras?.rtsHeroRgbLightmaps;
    if (heroSpec && Array.isArray(heroSpec.maps) && heroSpec.maps.length && gltf.parser) {
      const maxTi = Math.max(...heroSpec.maps.map((m) => m.textureIndex | 0), -1);
      const atlases = [];
      for (let i = 0; i <= maxTi; i++) {
        atlases.push(null);
      }
      for (const m of heroSpec.maps) {
        const ti = m.textureIndex | 0;
        if (atlases[ti]) continue;
        try {
          const src = await gltf.parser.getDependency('texture', ti);
          const tex = adoptLightmapTexture(src, W);
          if (tex) {
            if ('channel' in tex) tex.channel = 2;
            atlases[ti] = tex;
          }
        } catch (err) {
          console.warn('[RTSVR6] hero LM', ti, err);
        }
      }
      assignPropSelfShadowKeys(props);
      props.userData.rtsHeroRgbLightmaps = {
        atlases,
        byKey: buildHeroLightmapLookup(heroSpec),
        dark: heroSpec.dark,
        amb: heroSpec.amb,
      };
      console.log('[RTSVR6] hero RGB lightmaps', {
        maps: heroSpec.maps.length,
        atlases: atlases.filter(Boolean).length,
      });
    }

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
        console.warn('[RTSVR6] rock shadow map', i, err);
      }
    }
  }

  const usePlanar = planarOk && lmTexByIndex.every((e) => e && e.tex && e.bbox);
  const mesaHf = !!(json.extras && json.extras.rtsMesaHeightfield);
  let look = 'lambert+glb-moon01';
  let rockShadows = 0;
  // Mesa: Moon_0 / Moon_0_ci_cj only (never Moon_1 clones). One shared material.
  const moonsToAdopt = mesaHf
    ? moonMeshes.filter((m) => /^Moon_0(_\d+_\d+)?$/i.test(m.name || ''))
    : moonMeshes;
  let sharedMesaMat = null;
  for (const src of moonsToAdopt) {
    if (mesaHf && !(src.geometry && src.geometry.attributes && src.geometry.attributes.position)) {
      continue;
    }
    const isMesaPlate = mesaHf && /^Moon_0(_\d+_\d+)?$/i.test(src.name || '');
    if (isMesaPlate) {
      if (!sharedMesaMat) {
        sharedMesaMat = makeMesaHeightfieldMaterial(src.material, W, recv);
      }
      look = 'mesa-heightfield+cells';
      const adopted = adoptMeshForAframe(src, W, recv, sharedMesaMat, null);
      if (adopted && adopted.isMesh) adopted.frustumCulled = true;
      keep.add(adopted);
      continue;
    }
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
  if (mesaHf) keep.userData.rtsMesaHeightfield = json.extras.rtsMesaHeightfield;

  console.log('[RTSVR6] baked moon ready', {
    bytes: buf.byteLength,
    url: glbBufUrl,
    verts,
    moonMeshes: moonMeshes.length,
    propMeshes: propMeshes.length,
    look,
    planarLm: usePlanar,
    rockShadows,
    mesaHeightfield: mesaHf,
  });
  return keep;
}

/** Hera Planum / heightfield plate: diffuse + normal from bake (no moon albedo wipe). */
function makeMesaHeightfieldMaterial(srcMat, W, recv) {
  const hasMap = !!(srcMat && srcMat.map);
  const mat = new W.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: !hasMap,
    fog: false,
  });
  mat.map = adoptTexture(srcMat && srcMat.map, W, false);
  mat.normalMap = adoptTexture(srcMat && srcMat.normalMap, W, true);
  // Resolution only: sharper filtering — do not retint or re-light the plate.
  const aniso = 16;
  for (const tex of [mat.map, mat.normalMap]) {
    if (!tex) continue;
    tex.wrapS = W.ClampToEdgeWrapping;
    tex.wrapT = W.ClampToEdgeWrapping;
    tex.anisotropy = aniso;
    tex.generateMipmaps = true;
    tex.minFilter = W.LinearMipmapLinearFilter;
    tex.magFilter = W.LinearFilter;
    tex.needsUpdate = true;
  }
  if (mat.normalMap) mat.normalScale = new W.Vector2(1.15, 1.15);
  mat.lightMap = null;
  mat.envMap = null;
  if ('envMapIntensity' in mat) mat.envMapIntensity = 0;
  // cheapMoonLook: finishBakedMoonLook must NOT replace with moon_01 albedo
  mat.userData.cheapMoonLook = true;
  mat.userData.rtsMesaHeightfield = true;
  mat.userData.shadowRecv = recv;
  mat.needsUpdate = true;
  installFogVisualOnMaterial(mat);
  return mat;
}

/** @deprecated Detail overlay changed brightness — disabled. Kept so old imports resolve. */
export async function enhanceMesaHeightfieldDetail(_root, _THREE) {
  return;
}

/**
 * BAR/Spring splat detail: tiled DNTS (RGB normal, A diffuse) × splat distribution.
 * Macro SMT alone is ≤10240 over ±1000 m (~5 px/m); this is the real close-up resolution.
 * Mean-preserving A multiply (×2 around ~0.5) — no grit darkening.
 */
function installMesaSplatDetail(mat, THREE, splat) {
  if (!mat || !splat || !splat.distr || !splat.dnts || splat.dnts.length < 4) return;
  if (mat.userData && mat.userData._mesaSplatInstalled) return;
  mat.userData._mesaSplatInstalled = true;

  // Spring TexScales on 10240-elmo map → our 2000 m plate: scale *= 10240/2000.
  const elmoPerM = 10240 / 2000;
  const scales = new THREE.Vector4(
    0.003 * elmoPerM,
    0.004 * elmoPerM,
    0.0032 * elmoPerM,
    0.0025 * elmoPerM
  );
  const mults = new THREE.Vector4(0.85, 0.5, 0.43, 0.36);

  const prev = mat.onBeforeCompile;
  const prevKey =
    typeof mat.customProgramCacheKey === 'function'
      ? mat.customProgramCacheKey.bind(mat)
      : () => '';

  mat.onBeforeCompile = (shader) => {
    if (typeof prev === 'function') prev(shader);
    shader.uniforms.mesaSplatDistr = { value: splat.distr };
    shader.uniforms.mesaDnts1 = { value: splat.dnts[0] };
    shader.uniforms.mesaDnts2 = { value: splat.dnts[1] };
    shader.uniforms.mesaDnts3 = { value: splat.dnts[2] };
    shader.uniforms.mesaDnts4 = { value: splat.dnts[3] };
    shader.uniforms.mesaSplatScales = { value: scales };
    shader.uniforms.mesaSplatMults = { value: mults };
    shader.uniforms.mesaSplatStrength = { value: 1.0 };
    // Fade tiled DNTS beyond playable ~90–180 m (macro SMT carries far field).
    shader.uniforms.mesaSplatFadeNear = { value: 90.0 };
    shader.uniforms.mesaSplatFadeFar = { value: 180.0 };
    mat.userData._mesaSplatUniforms = shader.uniforms;

    if (!shader.vertexShader.includes('vMesaWorldPos')) {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
varying vec3 vMesaWorldPos;`
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
	vMesaWorldPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
#else
	vMesaWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif`
        );
    }

    if (!shader.fragmentShader.includes('mesaSplatDistr')) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
varying vec3 vMesaWorldPos;
uniform sampler2D mesaSplatDistr;
uniform sampler2D mesaDnts1;
uniform sampler2D mesaDnts2;
uniform sampler2D mesaDnts3;
uniform sampler2D mesaDnts4;
uniform vec4 mesaSplatScales;
uniform vec4 mesaSplatMults;
uniform float mesaSplatStrength;
uniform float mesaSplatFadeNear;
uniform float mesaSplatFadeFar;

vec3 mesaRnmBlend( vec3 n1, vec3 n2 ) {
	n1 += vec3( 0.0, 0.0, 1.0 );
	n2 *= vec3( -1.0, -1.0, 1.0 );
	return normalize( n1 * dot( n1, n2 ) / max( n1.z, 1e-4 ) - n2 );
}
`
        )
        .replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
	{
		vec2 mesaUv = vMapUv;
		vec4 sw = texture2D( mesaSplatDistr, mesaUv );
		vec2 xz = vMesaWorldPos.xz;
		float distFade = 1.0 - smoothstep( mesaSplatFadeNear, mesaSplatFadeFar, length( xz ) );
		float splatGate = mesaSplatStrength * distFade;
		if ( splatGate > 1e-4 ) {
			vec4 d1 = texture2D( mesaDnts1, xz * mesaSplatScales.x );
			vec4 d2 = texture2D( mesaDnts2, xz * mesaSplatScales.y );
			vec4 d3 = texture2D( mesaDnts3, xz * mesaSplatScales.z );
			vec4 d4 = texture2D( mesaDnts4, xz * mesaSplatScales.w );
			float w1 = sw.r * mesaSplatMults.x;
			float w2 = sw.g * mesaSplatMults.y;
			float w3 = sw.b * mesaSplatMults.z;
			float w4 = sw.a * mesaSplatMults.w;
			float wSum = w1 + w2 + w3 + w4;
			if ( wSum > 1e-4 ) {
				float detailA = ( d1.a * w1 + d2.a * w2 + d3.a * w3 + d4.a * w4 ) / wSum;
				// Mean A ≈ 0.5 → 2*A preserves macro brightness (no sand-grit darkening).
				float damp = clamp( wSum, 0.0, 1.0 ) * splatGate;
				diffuseColor.rgb *= mix( 1.0, 2.0 * detailA, damp );
			}
		}
	}
`
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `#include <normal_fragment_maps>
	{
		vec2 mesaUv = vMapUv;
		vec4 sw = texture2D( mesaSplatDistr, mesaUv );
		vec2 xz = vMesaWorldPos.xz;
		float distFade = 1.0 - smoothstep( mesaSplatFadeNear, mesaSplatFadeFar, length( xz ) );
		float splatGate = mesaSplatStrength * distFade;
		if ( splatGate > 1e-4 ) {
			vec4 d1 = texture2D( mesaDnts1, xz * mesaSplatScales.x );
			vec4 d2 = texture2D( mesaDnts2, xz * mesaSplatScales.y );
			vec4 d3 = texture2D( mesaDnts3, xz * mesaSplatScales.z );
			vec4 d4 = texture2D( mesaDnts4, xz * mesaSplatScales.w );
			float w1 = sw.r * mesaSplatMults.x;
			float w2 = sw.g * mesaSplatMults.y;
			float w3 = sw.b * mesaSplatMults.z;
			float w4 = sw.a * mesaSplatMults.w;
			float wSum = w1 + w2 + w3 + w4;
			if ( wSum > 1e-4 ) {
				vec3 dn =
					normalize( d1.xyz * 2.0 - 1.0 ) * w1 +
					normalize( d2.xyz * 2.0 - 1.0 ) * w2 +
					normalize( d3.xyz * 2.0 - 1.0 ) * w3 +
					normalize( d4.xyz * 2.0 - 1.0 ) * w4;
				dn = normalize( dn / wSum );
				float damp = clamp( wSum, 0.0, 1.0 ) * splatGate;
				normal = normalize( mix( normal, mesaRnmBlend( normal, dn ), damp ) );
			}
		}
	}
`
        );
    }
  };
  mat.customProgramCacheKey = () => `${prevKey()}|mesaSplatV2fade`;
  mat.needsUpdate = true;
}

/**
 * Load native Hera SMT/DDS extracts (full 10240) + BAR splat DNTS for close-up res.
 * Prefer KTX2 (GPU-compressed) when present; JPEG fallback. Resolution only — no retints.
 */
export async function applyMesaHqTextures(root, THREE, sceneEl) {
  if (!root || !THREE) return null;
  if (!(root.userData && root.userData.rtsMesaHeightfield)) return null;

  const hqBase = 'assets/mesa/hera-planum/';
  const splatBase = hqBase + 'splat/';
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');

  const maxAniso = (() => {
    try {
      const r = sceneEl && sceneEl.renderer;
      if (r && r.capabilities && r.capabilities.getMaxAnisotropy) {
        return Math.min(16, r.capabilities.getMaxAnisotropy());
      }
    } catch (_) {
      /* */
    }
    return 16;
  })();

  const configureTex = (tex, linear, wrapRepeat) => {
    if (!tex) return null;
    tex.wrapS = wrapRepeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.wrapT = wrapRepeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    // KTX2 already carries mips — do not ask WebGL to generate more on compressed data.
    if (tex.isCompressedTexture) {
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
    } else {
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
    }
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = maxAniso;
    if (linear) {
      if ('colorSpace' in tex && THREE.NoColorSpace) tex.colorSpace = THREE.NoColorSpace;
    } else if ('colorSpace' in tex && THREE.SRGBColorSpace) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    tex.needsUpdate = true;
    return tex;
  };

  const loadJpg = (url, linear, wrapRepeat) =>
    new Promise((resolve) => {
      loader.load(
        url,
        (tex) => resolve(configureTex(tex, linear, wrapRepeat)),
        undefined,
        () => resolve(null)
      );
    });

  const ensureKtx2 = async () => {
    try {
      const renderer = sceneEl && sceneEl.renderer;
      return await getSharedKtx2Loader(renderer);
    } catch (err) {
      console.warn('[RTSVR6] mesa KTX2Loader setup failed', err);
      return null;
    }
  };

  const loadKtx2 = async (url, linear, wrapRepeat) => {
    const ktx = await ensureKtx2();
    if (!ktx) return null;
    return new Promise((resolve) => {
      ktx.load(
        url,
        (tex) => resolve(configureTex(tex, linear, wrapRepeat)),
        undefined,
        () => resolve(null)
      );
    });
  };

  const loadPreferKtx2 = async (baseName, linear, wrapRepeat) => {
    const ktx = await loadKtx2(hqBase + baseName + '.ktx2', linear, wrapRepeat);
    if (ktx) return { tex: ktx, kind: 'ktx2' };
    const jpg = await loadJpg(hqBase + baseName + '.jpg', linear, wrapRepeat);
    return jpg ? { tex: jpg, kind: 'jpg' } : { tex: null, kind: null };
  };

  const [diffPack, nrmPack, distr, d1, d2, d3, d4] = await Promise.all([
    loadPreferKtx2('diffuse-hq', false, false),
    loadPreferKtx2('normal-hq', true, false),
    loadJpg(splatBase + 'distr.png', true, false),
    loadJpg(splatBase + 'dnts1.png', true, true),
    loadJpg(splatBase + 'dnts2.png', true, true),
    loadJpg(splatBase + 'dnts3.png', true, true),
    loadJpg(splatBase + 'dnts4.png', true, true),
  ]);
  const diff = diffPack.tex;
  const nrm = nrmPack.tex;
  if (!diff) {
    console.warn('[RTSVR6] mesa HQ diffuse missing — using GLB embeds');
    return null;
  }

  const splat =
    distr && d1 && d2 && d3 && d4
      ? { distr, dnts: [d1, d2, d3, d4] }
      : null;
  if (!splat) {
    console.warn('[RTSVR6] mesa splat DNTS missing — macro HQ only');
  }

  // Shared material across cells — apply textures once.
  const seen = new Set();
  let applied = 0;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material || !obj.material.userData?.rtsMesaHeightfield) return;
    const mat = obj.material;
    if (seen.has(mat)) {
      applied += 1;
      return;
    }
    seen.add(mat);
    if (diff) {
      if (mat.map && mat.map.dispose && mat.map !== diff) mat.map.dispose();
      mat.map = diff;
    }
    if (nrm) {
      if (mat.normalMap && mat.normalMap.dispose && mat.normalMap !== nrm) mat.normalMap.dispose();
      mat.normalMap = nrm;
      mat.normalScale = new THREE.Vector2(1.15, 1.15);
    }
    mat.color.setRGB(1, 1, 1);
    if (splat) installMesaSplatDetail(mat, THREE, splat);
    mat.needsUpdate = true;
    applied += 1;
  });

  const iw = diff.image ? diff.image.width || diff.image.videoWidth || 0 : 0;
  const ih = diff.image ? diff.image.height || diff.image.videoHeight || 0 : 0;
  console.log('[RTSVR6] mesa HQ textures applied', {
    meshes: applied,
    materials: seen.size,
    diffuse: iw && ih ? `${iw}x${ih}` : null,
    diffuseFmt: diffPack.kind,
    normalFmt: nrmPack.kind,
    splat: !!splat,
  });
  return { diffuse: [iw, ih], splat: !!splat, fmt: diffPack.kind };
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
