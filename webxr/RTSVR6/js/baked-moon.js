/**
 * Skirmish moon from the UE GLB: heightfield + tiled moon_01 on UV0.
 *
 * Cheap unlit (opt-in `?unlitmoon=1`) is MeshBasic × albedo × a planar-XZ RGB
 * lightmap. Default is live Lambert — the island Lightmass unpack was a pixel
 * grid, and the planar bake is still too flat vs Lambert. `?livepbr=1` /
 * `?nobake=1` uses the procedural plate.
 */
import { MAP_TERRAIN_STYLE, isDesktopPcvrHost } from './config.js';
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
/** Desktop PCVR denser heightfield (~10× tris vs Quest plate). Falls back if missing. */
export const BAKED_SKIRMISH_1V1_PCVR_GLB = 'assets/terrain/terrain-skirmish-1v1-pcvr.glb';
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
function isQuestStandaloneUa() {
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    return /OculusBrowser|\bQuest\b|Pacific/i.test(ua);
  } catch (_) {
    return false;
  }
}

export function preferredSkirmishBakeUrl(mode = 'match') {
  if (mode === 'intro' || !wantCombined1v1()) return BAKED_SKIRMISH_INTRO_GLB;
  try {
    const q = `${typeof location !== 'undefined' ? location.search || '' : ''}${
      typeof location !== 'undefined' ? location.hash || '' : ''
    }`;
    if (/(?:[?&#]mesaQuest=1\b)/i.test(q)) return BAKED_SKIRMISH_1V1_GLB;
    // Dense 13M plate: same 8-bit height → no ridge detail, huge GPU cost. Opt-in on
    // desktop; on Quest require mesaPcvrForce=1 (mesaPcvr alone is a footgun).
    if (/(?:[?&#]mesaPcvr=1\b)/i.test(q)) {
      if (!isQuestStandaloneUa() || /(?:[?&#]mesaPcvrForce=1\b)/i.test(q)) {
        return BAKED_SKIRMISH_1V1_PCVR_GLB;
      }
      console.warn(
        '[RTSVR6] mesaPcvr=1 ignored on Quest (13M tris, no visible gain). Use mesaPcvrForce=1 to override.'
      );
    }
  } catch (_) {
    /* */
  }
  return BAKED_SKIRMISH_MATCH_GLB;
}

export function clearBakedMoonGlbCache() {
  glbBufCache = null;
  glbBufUrl = null;
}

async function fetchBakeBuffer(preferUrl) {
  const urls = [];
  if (preferUrl) urls.push(preferUrl);
  // PCVR prefer may 404 — always allow standard Hera, then crater moon.
  if (!urls.includes(BAKED_SKIRMISH_1V1_GLB)) urls.push(BAKED_SKIRMISH_1V1_GLB);
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
  try {
    if (W.DRACOLoader) {
      const draco = new W.DRACOLoader();
      draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
      loader.setDRACOLoader(draco);
    }
  } catch (err) {
    console.warn('[RTSVR6] baked moon DRACOLoader setup failed', err);
  }
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
  // Default: Lambert + normals on ALL hosts (Quest included). Ridge micro-relief in the
  // user's PCVR shots is normal-lit — MeshBasic can never show it. Opt-in cheap path:
  // ?mesaSimple=1 → MeshBasic albedo-only (emergency if FoW+Lambert blacks the plate).
  const questSimple = isQuestMesaSimple();
  const mat = questSimple
    ? new W.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: !hasMap,
        fog: false,
        toneMapped: true,
      })
    : new W.MeshLambertMaterial({
        color: 0xffffff,
        vertexColors: !hasMap,
        fog: false,
      });
  mat.map = adoptTexture(srcMat && srcMat.map, W, false);
  if (!questSimple) {
    mat.normalMap = adoptTexture(srcMat && srcMat.normalMap, W, true);
  }
  const aniso = questSimple ? 8 : 16;
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
  if (mat.normalMap) mat.normalScale = new W.Vector2(1.55, 1.55);
  mat.lightMap = null;
  mat.envMap = null;
  if ('envMapIntensity' in mat) mat.envMapIntensity = 0;
  mat.userData.cheapMoonLook = true;
  mat.userData.rtsMesaHeightfield = true;
  mat.userData.rtsMesaQuestSimple = questSimple;
  mat.userData.shadowRecv = recv;
  mat.needsUpdate = true;
  installFogVisualOnMaterial(mat);
  return mat;
}

/**
 * Cheap Quest path — ONLY when ?mesaSimple=1.
 * Default Quest must match PCVR lighting/normals or ridge detail is structurally impossible.
 */
function isQuestMesaSimple() {
  try {
    const q = `${typeof location !== 'undefined' ? location.search || '' : ''}${
      typeof location !== 'undefined' ? location.hash || '' : ''
    }`;
    if (/(?:[?&#]mesaSimple=1\b)/i.test(q)) return true;
    // mesaFull kept as alias for "not simple" (historical).
    if (/(?:[?&#]mesaFull=1\b)/i.test(q)) return false;
  } catch (_) {
    /* */
  }
  return false;
}

function wantMesaSplatDetail() {
  // BAR splatDistr paints large rectangular patches at headset distance — opt-in only.
  // PCVR close-up detail uses world-XZ Poly Haven / moon_01 overlays instead.
  if (isQuestMesaSimple()) return false;
  try {
    const q = `${typeof location !== 'undefined' ? location.search || '' : ''}${
      typeof location !== 'undefined' ? location.hash || '' : ''
    }`;
    if (/(?:[?&#]forcesplat=1\b)/i.test(q)) return true;
    if (/(?:[?&#]nosplat=1\b)/i.test(q)) return false;
  } catch (_) {
    /* */
  }
  return false;
}

/**
 * Close-up grit: Poly Haven 4K world-XZ overlay (not BAR splatDistr blocks).
 * Preserves Hera macro hue; injects high-frequency albedo contrast + normals.
 *
 * Fade is CAMERA distance — never world-origin.
 *
 * Cost budget (do not regress):
 * - 2 albedo + 1 normal sample (not 3+3)
 * - no negative LOD bias (that forced full-res mips across the plate → bandwidth cliff)
 * - fadeFar short so far hills stay on macro HQ only
 */
function installMesaCloseupDetail(mat, THREE, detail) {
  if (!mat || !detail || !detail.diff || !detail.nor) return;
  if (mat.userData && mat.userData._mesaCloseupInstalled) return;
  mat.userData._mesaCloseupInstalled = true;

  // Readable at RTS cam height without needing sub-metre tiles.
  const scaleA = 0.1; // ~10 m
  const scaleB = 0.28; // ~3.6 m
  const strength = 0.95;
  const fadeNear = 5.0;
  const fadeFar = 72.0;

  const prev = mat.onBeforeCompile;
  const prevKey =
    typeof mat.customProgramCacheKey === 'function'
      ? mat.customProgramCacheKey.bind(mat)
      : () => '';

  mat.onBeforeCompile = (shader) => {
    if (typeof prev === 'function') prev(shader);
    shader.uniforms.mesaDetailDiff = { value: detail.diff };
    shader.uniforms.mesaDetailNor = { value: detail.nor };
    shader.uniforms.mesaDetailScaleA = { value: scaleA };
    shader.uniforms.mesaDetailScaleB = { value: scaleB };
    shader.uniforms.mesaDetailStrength = { value: strength };
    shader.uniforms.mesaDetailFadeNear = { value: fadeNear };
    shader.uniforms.mesaDetailFadeFar = { value: fadeFar };
    mat.userData._mesaCloseupUniforms = shader.uniforms;

    if (!shader.vertexShader.includes('vMesaWorldPos')) {
      if (shader.vertexShader.includes('vRtsFogWorldPos')) {
        if (!shader.vertexShader.includes('varying vec3 vMesaWorldPos')) {
          shader.vertexShader = shader.vertexShader.replace(
            'varying vec3 vRtsFogWorldPos;',
            /* glsl */ `varying vec3 vRtsFogWorldPos;
varying vec3 vMesaWorldPos;`
          );
        }
        const mesaAssign = /* glsl */ `
	vMesaWorldPos = vRtsFogWorldPos;`;
        if (shader.vertexShader.includes('USE_INSTANCING')) {
          shader.vertexShader = shader.vertexShader.replace(
            'vRtsObjXZ = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;',
            `vRtsObjXZ = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;${mesaAssign}`
          );
        }
        if (shader.vertexShader.includes('vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;')) {
          shader.vertexShader = shader.vertexShader.replace(
            'vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
            `vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;${mesaAssign}`
          );
        }
      } else {
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
    }

    if (!shader.fragmentShader.includes('mesaDetailDiff')) {
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
varying vec3 vMesaWorldPos;
uniform sampler2D mesaDetailDiff;
uniform sampler2D mesaDetailNor;
uniform float mesaDetailScaleA;
uniform float mesaDetailScaleB;
uniform float mesaDetailStrength;
uniform float mesaDetailFadeNear;
uniform float mesaDetailFadeFar;

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
		vec2 xz = vMesaWorldPos.xz;
		float camDist = length( vMesaWorldPos - cameraPosition );
		float distFade = 1.0 - smoothstep( mesaDetailFadeNear, mesaDetailFadeFar, camDist );
		float gate = mesaDetailStrength * distFade;
		if ( gate > 1e-4 ) {
			vec3 dA = texture2D( mesaDetailDiff, xz * mesaDetailScaleA ).rgb;
			vec3 dB = texture2D( mesaDetailDiff, xz * mesaDetailScaleB + vec2( 0.37, 0.19 ) ).rgb;
			vec3 detail = mix( dA, dB, 0.5 );
			float luma = max( 1e-3, dot( detail, vec3( 0.2126, 0.7152, 0.0722 ) ) );
			vec3 grit = diffuseColor.rgb * ( detail / luma );
			float punch = ( luma - 0.42 ) * 2.0;
			diffuseColor.rgb = mix( diffuseColor.rgb, grit, gate * 0.9 );
			diffuseColor.rgb *= 1.0 + punch * gate * 0.65;
			diffuseColor.rgb = mix( diffuseColor.rgb, detail * vec3( 1.05, 0.92, 0.82 ), gate * 0.25 );
		}
	}
`
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `#include <normal_fragment_maps>
	{
		vec2 xz = vMesaWorldPos.xz;
		float camDist = length( vMesaWorldPos - cameraPosition );
		float distFade = 1.0 - smoothstep( mesaDetailFadeNear, mesaDetailFadeFar, camDist );
		float gate = mesaDetailStrength * distFade;
		if ( gate > 1e-4 ) {
			// One normal tap — dual albedo already carries most of the grit read.
			vec3 dn = texture2D( mesaDetailNor, xz * mesaDetailScaleA ).xyz * 2.0 - 1.0;
			normal = normalize( mix( normal, mesaRnmBlend( normal, dn ), gate * 0.9 ) );
		}
	}
`
        );
    }
  };
  mat.customProgramCacheKey = () => `${prevKey()}|mesaCloseupV5cheap`;
  mat.needsUpdate = true;
}

/** Materials with animated wind-dust uniforms (time updated once per frame). */
const _mesaWindMats = new Set();
let _mesaWindRaf = 0;

function ensureMesaWindTick() {
  if (_mesaWindRaf) return;
  const step = () => {
    _mesaWindRaf = requestAnimationFrame(step);
    if (_mesaWindMats.size === 0) return;
    const t = performance.now() * 0.001;
    for (const mat of _mesaWindMats) {
      const u = mat.userData && mat.userData._mesaWindUniforms;
      if (u && u.mesaWindTime) u.mesaWindTime.value = t;
    }
  };
  _mesaWindRaf = requestAnimationFrame(step);
}

function wantMesaWindDust() {
  try {
    const q = `${typeof location !== 'undefined' ? location.search || '' : ''}${
      typeof location !== 'undefined' ? location.hash || '' : ''
    }`;
    if (/(?:[?&#]nodust=1\b)/i.test(q)) return false;
    if (/(?:[?&#]dust=1\b)/i.test(q)) return true;
  } catch (_) {
    /* */
  }
  // Procedural (0 extra textures) — fine on Quest standalone too.
  return true;
}

/**
 * Ensure world-pos varying exists (shared by closeup / wind / splat).
 * Idempotent — safe if closeup already injected it.
 */
function ensureMesaWorldPosVarying(shader) {
  if (shader.vertexShader.includes('vMesaWorldPos =')) return;
  if (shader.vertexShader.includes('vRtsFogWorldPos')) {
    if (!shader.vertexShader.includes('varying vec3 vMesaWorldPos')) {
      shader.vertexShader = shader.vertexShader.replace(
        'varying vec3 vRtsFogWorldPos;',
        /* glsl */ `varying vec3 vRtsFogWorldPos;
varying vec3 vMesaWorldPos;`
      );
    }
    const mesaAssign = /* glsl */ `
	vMesaWorldPos = vRtsFogWorldPos;`;
    if (shader.vertexShader.includes('USE_INSTANCING')) {
      shader.vertexShader = shader.vertexShader.replace(
        'vRtsObjXZ = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;',
        `vRtsObjXZ = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;${mesaAssign}`
      );
    }
    if (shader.vertexShader.includes('vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;')) {
      shader.vertexShader = shader.vertexShader.replace(
        'vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
        `vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;${mesaAssign}`
      );
    }
  } else if (!shader.vertexShader.includes('varying vec3 vMesaWorldPos')) {
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
}

/**
 * Subtle wind-blown sand/dust skim — procedural (0 texture taps).
 * Injects before opaque_fragment (same survival strategy as FoW) so Quest MeshBasic
 * and post-FoW reinstalls keep it. map_fragment alone was easy to lose on Quest.
 */
function installMesaWindDust(mat, THREE) {
  if (!mat || !wantMesaWindDust()) return;
  // Stale flag after FoW wiped the hook — must reinstall.
  const keyStr = String(mat.customProgramCacheKey?.() || '');
  if (
    mat.userData &&
    mat.userData._mesaWindInstalled &&
    mat.userData._mesaWindUniforms &&
    keyStr.includes('mesaWindDust')
  ) {
    _mesaWindMats.add(mat);
    ensureMesaWindTick();
    return;
  }
  mat.userData._mesaWindInstalled = true;

  const quest = isQuestStandaloneUa() || isQuestMesaSimple();
  const windDirX = 0.85;
  const windDirZ = 0.35;
  const speed = quest ? 0.65 : 0.52;
  const scale = 0.42;
  const strength = quest ? 0.78 : 0.48;
  const fadeNear = 3.0;
  const fadeFar = quest ? 140.0 : 110.0;

  const prev = mat.onBeforeCompile;
  const prevKey =
    typeof mat.customProgramCacheKey === 'function'
      ? mat.customProgramCacheKey.bind(mat)
      : () => '';

  mat.onBeforeCompile = (shader) => {
    if (typeof prev === 'function') prev(shader);
    shader.uniforms.mesaWindTime = { value: 0 };
    shader.uniforms.mesaWindDir = {
      value: THREE && THREE.Vector2 ? new THREE.Vector2(windDirX, windDirZ) : { x: windDirX, y: windDirZ },
    };
    shader.uniforms.mesaWindSpeed = { value: speed };
    shader.uniforms.mesaWindScale = { value: scale };
    shader.uniforms.mesaWindStrength = { value: strength };
    shader.uniforms.mesaWindFadeNear = { value: fadeNear };
    shader.uniforms.mesaWindFadeFar = { value: fadeFar };
    mat.userData._mesaWindUniforms = shader.uniforms;

    ensureMesaWorldPosVarying(shader);
    if (
      shader.vertexShader.includes('vRtsFogWorldPos') &&
      !shader.vertexShader.includes('vMesaWorldPos = vRtsFogWorldPos')
    ) {
      if (shader.vertexShader.includes('vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;')) {
        shader.vertexShader = shader.vertexShader.replace(
          'vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
          /* glsl */ `vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	vMesaWorldPos = vRtsFogWorldPos;`
        );
      }
    }

    if (!shader.fragmentShader.includes('mesaWindNoise')) {
      const windHelpers = /* glsl */ `
#ifndef MESA_WIND_HELPERS
#define MESA_WIND_HELPERS
uniform float mesaWindTime;
uniform vec2 mesaWindDir;
uniform float mesaWindSpeed;
uniform float mesaWindScale;
uniform float mesaWindStrength;
uniform float mesaWindFadeNear;
uniform float mesaWindFadeFar;

float mesaWindHash( vec2 p ) {
	return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}
float mesaWindNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	float a = mesaWindHash( i );
	float b = mesaWindHash( i + vec2( 1.0, 0.0 ) );
	float c = mesaWindHash( i + vec2( 0.0, 1.0 ) );
	float d = mesaWindHash( i + vec2( 1.0, 1.0 ) );
	return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
vec3 mesaWindBlown( vec3 base ) {
	float camDist = length( vMesaWorldPos - cameraPosition );
	float distFade = 1.0 - smoothstep( mesaWindFadeNear, mesaWindFadeFar, camDist );
	float gate = mesaWindStrength * distFade;
	if ( gate < 1e-4 ) return base;
	vec2 xz = vMesaWorldPos.xz;
	vec2 windN = normalize( mesaWindDir );
	vec2 drift = windN * ( mesaWindTime * mesaWindSpeed );
	vec2 along = vec2( dot( xz, windN ), dot( xz, vec2( -windN.y, windN.x ) ) * 2.5 );
	float n1 = mesaWindNoise( along * mesaWindScale + drift );
	float n2 = mesaWindNoise( xz * ( mesaWindScale * 3.8 ) + drift * 1.55 + vec2( 11.3, 4.7 ) );
	float n3 = mesaWindNoise( xz * ( mesaWindScale * 9.5 ) + drift * 2.1 + vec2( 3.1, 17.9 ) );
	float streak = smoothstep( 0.4, 0.66, n1 );
	float grit = smoothstep( 0.45, 0.72, n2 ) * 0.7 + smoothstep( 0.52, 0.84, n3 ) * 0.55;
	float dust = clamp( streak * 0.55 + grit * 0.9, 0.0, 1.0 );
	vec3 sand = mix(
		mix( vec3( 0.58, 0.44, 0.30 ), vec3( 0.74, 0.60, 0.42 ), n2 ),
		vec3( 0.40, 0.33, 0.26 ),
		n3 * 0.65
	);
	float luma = max( 1e-3, dot( base, vec3( 0.2126, 0.7152, 0.0722 ) ) );
	vec3 tinted = sand * ( luma * 1.35 ) + vec3( 0.035, 0.025, 0.014 );
	vec3 blown = mix( base * 0.74, tinted, 0.68 + grit * 0.28 );
	return mix( base, blown, dust * gate );
}
#endif
`;
      if (!shader.fragmentShader.includes('varying vec3 vMesaWorldPos')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          /* glsl */ `#include <common>
varying vec3 vMesaWorldPos;
${windHelpers}`
        );
      } else {
        shader.fragmentShader = shader.fragmentShader.replace(
          'varying vec3 vMesaWorldPos;',
          /* glsl */ `varying vec3 vMesaWorldPos;
${windHelpers}`
        );
      }

      // MeshBasic (Quest): outgoingLight is already set before opaque — must edit it.
      // Lambert (PCVR): edit diffuseColor in map_fragment so lighting picks it up.
      // Doing both double-applies on Basic; pick one.
      const basic =
        !!(mat.isMeshBasicMaterial || (mat.type && String(mat.type).includes('Basic')));
      if (!basic && shader.fragmentShader.includes('#include <map_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          /* glsl */ `#include <map_fragment>
	diffuseColor.rgb = mesaWindBlown( diffuseColor.rgb );
`
        );
      }
      if (basic || !shader.fragmentShader.includes('mesaWindBlown( diffuseColor')) {
        if (shader.fragmentShader.includes('#include <opaque_fragment>')) {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <opaque_fragment>',
            /* glsl */ `
	outgoingLight = mesaWindBlown( outgoingLight );
	#include <opaque_fragment>
`
          );
        } else if (shader.fragmentShader.includes('#include <output_fragment>')) {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <output_fragment>',
            /* glsl */ `
	outgoingLight = mesaWindBlown( outgoingLight );
	#include <output_fragment>
`
          );
        }
      }
    }
  };
  mat.customProgramCacheKey = () => `${prevKey()}|mesaWindDustV7out`;
  mat.needsUpdate = true;
  _mesaWindMats.add(mat);
  ensureMesaWindTick();
}

/** Re-apply wind after FoW install (FoW upgrade can drop later compile hooks). */
export function ensureMesaWindDustOnRoot(root, THREE) {
  if (!root || !THREE || !wantMesaWindDust()) return 0;
  let n = 0;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat?.userData?.rtsMesaHeightfield) continue;
      // Force reinstall if FoW wiped the hook.
      if (mat.userData._mesaWindInstalled && !String(mat.customProgramCacheKey?.() || '').includes('mesaWindDust')) {
        mat.userData._mesaWindInstalled = false;
        mat.userData._mesaWindUniforms = null;
      }
      if (!mat.userData._mesaWindInstalled) {
        installMesaWindDust(mat, THREE);
        n += 1;
      } else {
        _mesaWindMats.add(mat);
        ensureMesaWindTick();
      }
    }
  });
  return n;
}

function wantMesaCloseupDetail() {
  try {
    const q = `${typeof location !== 'undefined' ? location.search || '' : ''}${
      typeof location !== 'undefined' ? location.hash || '' : ''
    }`;
    if (/(?:[?&#]nodetail=1\b)/i.test(q)) return false;
    if (/(?:[?&#]mesaPcvr=1\b)/i.test(q)) return true;
    if (/(?:[?&#]detail=1\b)/i.test(q)) return true;
  } catch (_) {
    /* */
  }
  // 2×4K overlays — acceptable on Quest; full 10k HQ swap stays desktop-only.
  return true;
}

async function loadMesaCloseupDetailTextures(THREE, sceneEl) {
  if (!wantMesaCloseupDetail()) return null;
  try {
    const q = `${typeof location !== 'undefined' ? location.search || '' : ''}${
      typeof location !== 'undefined' ? location.hash || '' : ''
    }`;
    if (/(?:[?&#]nodetail=1\b)/i.test(q)) return null;
  } catch (_) {
    /* */
  }
  const base = 'assets/mesa/hera-planum/detail/';
  // Prefer reddish rocky_terrain; fall back to aerial_rocks.
  const pairs = [
    ['rocky_terrain_02_diff_4k.jpg', 'rocky_terrain_02_nor_gl_4k.jpg'],
    ['aerial_rocks_02_diff_4k.jpg', 'aerial_rocks_02_nor_gl_4k.jpg'],
  ];
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
  const loadOne = (url, linear) =>
    new Promise((resolve) => {
      loader.load(
        url,
        (tex) => {
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.anisotropy = maxAniso;
          if (linear) {
            if ('colorSpace' in tex && THREE.NoColorSpace) tex.colorSpace = THREE.NoColorSpace;
          } else if ('colorSpace' in tex && THREE.SRGBColorSpace) {
            tex.colorSpace = THREE.SRGBColorSpace;
          }
          tex.needsUpdate = true;
          resolve(tex);
        },
        undefined,
        () => resolve(null)
      );
    });
  for (const [dName, nName] of pairs) {
    const [diff, nor] = await Promise.all([
      loadOne(base + dName, false),
      loadOne(base + nName, true),
    ]);
    if (diff && nor) return { diff, nor, name: dName };
  }
  return null;
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
      // FoW installs first; splat runs after via onBeforeCompile chain. Do NOT replace
      // `#include <common>` wholesale — that drops vRtsFogWorldPos on Quest (FoW → black terrain).
      if (shader.vertexShader.includes('vRtsFogWorldPos')) {
        if (!shader.vertexShader.includes('varying vec3 vMesaWorldPos')) {
          shader.vertexShader = shader.vertexShader.replace(
            'varying vec3 vRtsFogWorldPos;',
            /* glsl */ `varying vec3 vRtsFogWorldPos;
varying vec3 vMesaWorldPos;`
          );
        }
        const mesaAssign = /* glsl */ `
	vMesaWorldPos = vRtsFogWorldPos;`;
        if (!shader.vertexShader.includes('vMesaWorldPos = vRtsFogWorldPos')) {
          if (shader.vertexShader.includes('vRtsObjXZ = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;')) {
            shader.vertexShader = shader.vertexShader.replace(
              'vRtsObjXZ = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;',
              `vRtsObjXZ = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;${mesaAssign}`
            );
          } else if (
            shader.vertexShader.includes('vRtsObjXZ = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;')
          ) {
            shader.vertexShader = shader.vertexShader.replace(
              'vRtsObjXZ = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;',
              `vRtsObjXZ = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;${mesaAssign}`
            );
          } else if (shader.vertexShader.includes('vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;')) {
            shader.vertexShader = shader.vertexShader.replace(
              'vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
              `vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;${mesaAssign}`
            );
          }
        }
      } else {
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
 * Load native Hera SMT/DDS extracts (full 10240) + close-up grit + wind.
 * Prefer KTX2 when present; JPEG fallback.
 * ?mesaSimple=1: MeshBasic + HQ albedo only (no normals) — emergency cheap path.
 * Default (incl. Quest): full Lambert + diffuse/normal HQ — required for ridge relief.
 */
export async function applyMesaHqTextures(root, THREE, sceneEl) {
  if (!root || !THREE) return null;
  if (!(root.userData && root.userData.rtsMesaHeightfield)) return null;

  const questLite = isQuestMesaSimple();

  const hqBase = 'assets/mesa/hera-planum/';
  const splatBase = hqBase + 'splat/';
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');

  const maxAniso = (() => {
    try {
      const r = sceneEl && sceneEl.renderer;
      if (r && r.capabilities && r.capabilities.getMaxAnisotropy) {
        return Math.min(questLite ? 8 : 16, r.capabilities.getMaxAnisotropy());
      }
    } catch (_) {
      /* */
    }
    return questLite ? 8 : 16;
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

  // Quest lite: MeshBasic stays (avoids Lambert+normal black-plate), but swap 10k
  // albedo + grit + wind — that is the ridge detail PCVR has. Skip normal maps.
  if (questLite) {
    const [diffPack, closeup] = await Promise.all([
      loadPreferKtx2('diffuse-hq', false, false),
      loadMesaCloseupDetailTextures(THREE, sceneEl),
    ]);
    const diff = diffPack.tex;
    const useWind = wantMesaWindDust();
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
        mat.color.setRGB(1, 1, 1);
      }
      if (closeup) installMesaCloseupDetail(mat, THREE, closeup);
      installFogVisualOnMaterial(mat);
      if (useWind) installMesaWindDust(mat, THREE);
      mat.needsUpdate = true;
      applied += 1;
    });
    const iw = diff?.image ? diff.image.width || diff.image.videoWidth || 0 : 0;
    console.log('[RTSVR6] mesa Quest lite (HQ albedo on MeshBasic + grit/wind, no normals)', {
      meshes: applied,
      diffuse: iw || null,
      diffuseFmt: diffPack.kind,
      closeup: closeup ? closeup.name : null,
      windDust: useWind,
    });
    return {
      questLite: true,
      diffuse: iw ? [iw, iw] : null,
      closeup: !!(closeup && closeup.name),
      windDust: useWind,
      fmt: diffPack.kind,
    };
  }

  const useSplat = wantMesaSplatDetail();
  const splatLoads = useSplat
    ? Promise.all([
        loadJpg(splatBase + 'distr.png', true, false),
        loadJpg(splatBase + 'dnts1.png', true, true),
        loadJpg(splatBase + 'dnts2.png', true, true),
        loadJpg(splatBase + 'dnts3.png', true, true),
        loadJpg(splatBase + 'dnts4.png', true, true),
      ])
    : Promise.resolve([null, null, null, null, null]);

  const [diffPack, nrmPack, splatTexs, closeup] = await Promise.all([
    loadPreferKtx2('diffuse-hq', false, false),
    loadPreferKtx2('normal-hq', true, false),
    splatLoads,
    loadMesaCloseupDetailTextures(THREE, sceneEl),
  ]);
  const [distr, d1, d2, d3, d4] = splatTexs;
  const diff = diffPack.tex;
  const nrm = nrmPack.tex;
  if (!diff) {
    console.warn('[RTSVR6] mesa HQ diffuse missing — using GLB embeds');
    return null;
  }

  const splat =
    useSplat && distr && d1 && d2 && d3 && d4
      ? { distr, dnts: [d1, d2, d3, d4] }
      : null;
  if (useSplat && !splat) {
    console.warn('[RTSVR6] mesa splat DNTS missing — macro HQ only');
  }
  if (!closeup && isDesktopPcvrHost()) {
    console.warn('[RTSVR6] mesa close-up detail textures missing');
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
      mat.normalScale = new THREE.Vector2(1.55, 1.55);
    }
    mat.color.setRGB(1, 1, 1);
    if (splat) installMesaSplatDetail(mat, THREE, splat);
    if (closeup) installMesaCloseupDetail(mat, THREE, closeup);
    installFogVisualOnMaterial(mat);
    if (wantMesaWindDust()) installMesaWindDust(mat, THREE);
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
    closeup: closeup ? closeup.name : null,
    windDust: wantMesaWindDust(),
    questNoSplat: !useSplat,
  });
  return {
    diffuse: [iw, ih],
    splat: !!splat,
    closeup: !!(closeup && closeup.name),
    windDust: wantMesaWindDust(),
    fmt: diffPack.kind,
  };
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
