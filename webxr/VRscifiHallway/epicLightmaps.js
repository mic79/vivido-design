/**
 * Apply UE EPIC_lightmap_textures (HQ) for Three.js.
 *
 * Principle: keep original GLB materials (maps, normals, metalness, roughness, alpha).
 * Only inject tonemapped HQ lightmaps for baked lighting/shadows.
 *
 *  - Metals/chrome: clone MeshStandard, keep MR maps + IBL, add HQ irradiance (* PI)
 *  - Opaque dielectrics: MeshBasic × HQ lightmap (Epic albedo*LM — correct brightness)
 *  - Alpha/foliage: original MASK material; glass RGB cleared so windows aren't a black veil
 */
import * as THREE from 'three';

const LOG_BLACK_POINT = 0.01858136;
const DEFAULT_DIRECTIONALITY = 0.6;

const HQ_DECODE = /* glsl */ `
vec2 epicFlipY(vec2 uv) { return vec2(uv.x, 1.0 - uv.y); }

vec2 epicGetLightmapUV0(vec2 uv, vec4 scaleBias) {
  return (uv * scaleBias.xy + scaleBias.zw) * vec2(1.0, 0.5);
}

vec3 getEpicLightMapColorHQ(
  sampler2D lmTex, vec2 meshUv, vec4 scaleBias, vec4 lmScale, vec4 lmAdd,
  float intensity, float directionality
) {
  vec2 flippedUv = epicFlipY(meshUv);
  vec2 lightmapUv0 = epicFlipY(epicGetLightmapUV0(flippedUv, scaleBias));
  vec2 lightmapUv1 = epicFlipY(epicGetLightmapUV0(flippedUv, scaleBias) + vec2(0.0, 0.5));

  vec4 lightmap0 = texture2D(lmTex, lightmapUv0);
  vec4 lightmap1 = texture2D(lmTex, lightmapUv1);

  float logL = lightmap0.w;
  logL += lightmap1.w * (1.0 / 255.0) - (0.5 / 255.0);
  logL = logL * lmScale.w + lmAdd.w;

  vec3 uvw = lightmap0.rgb * lightmap0.rgb * lmScale.rgb + lmAdd.rgb;
  float l = exp2(logL) - ${LOG_BLACK_POINT};
  float luma = max(l, 0.0) * directionality;
  return uvw * luma * intensity;
}

// Soft display map — preserve AO without crushing office interiors to black
vec3 epicToneMapLM(vec3 lm, float contrast, float whitePoint) {
  lm = max(lm, vec3(0.0));
  float L = max( lm.r, max( lm.g, lm.b ) );
  // Mild shadow lift only — do not multiply dark L by ~0.2
  float shadowMul = mix( 0.72, 1.0, smoothstep( 0.0, 1.2, L ) );
  lm *= shadowMul;
  lm *= max(whitePoint, 0.05);
  lm = lm / (1.0 + lm * 0.85);
  if ( contrast != 1.0 ) {
    lm = pow( max(lm, vec3(0.0)), vec3( mix(1.0, contrast, 0.65) ) );
  }
  return min( lm, vec3( 0.98 ) );
}
`;

function ensureUvAttrs(geometry, texCoord) {
  if (texCoord === 1 && !geometry.attributes.uv1 && geometry.attributes.uv2) {
    geometry.setAttribute('uv1', geometry.attributes.uv2);
  }
}

function classifyMaterial(src) {
  const n = (src.name || '').toLowerCase();
  // Keep chrome / copper / doors / pipes / chrome bins as metals
  if (
    /simple_chrome|simple_copper|chrome|copper|door_|pipe_inst|fusebox|cable_0|^bin_01$/.test(n)
  ) {
    return 'metal';
  }
  // Explicit dielectrics (do NOT swallow chrome via mesh "bin" name — use material name)
  if (
    /floor|wall|tile|fond_wall|bench|divider|office|plant|robot|shelf|worldgrid|dyson|placeholder|glass|master_alpha|alpha_simple|pvc|poster|kitbash/.test(
      n,
    )
  ) {
    return 'dielectric';
  }
  const metal = src.metalness ?? 1;
  const rough = src.roughness ?? 1;
  // Painted surfaces with albedo + high roughness factor (metalness driven by unused default)
  if (metal > 0.5 && rough > 0.85 && src.map) return 'dielectric';
  // MR map, no albedo → chrome-style metal (Bin_01, etc.)
  if (src.metalnessMap && !src.map) return 'metal';
  if (metal > 0.7 && rough < 0.45) return 'metal';
  return 'dielectric';
}

function needsAlphaPreserve(src) {
  // Cutout / blend / foliage / glass — never rewrite these materials.
  return (
    !!src.transparent ||
    (src.alphaTest || 0) > 0 ||
    !!src.alphaMap ||
    /plant|leaf|foliage|grass|glass|master_alpha|alpha_simple|translucent/i.test(src.name || '')
  );
}

function cloneLightmapTexture(texture, texCoord) {
  const lmTex = texture.clone();
  lmTex.colorSpace = THREE.NoColorSpace;
  lmTex.flipY = false;
  lmTex.channel = texCoord;
  lmTex.generateMipmaps = false;
  lmTex.minFilter = THREE.LinearFilter;
  lmTex.magFilter = THREE.LinearFilter;
  lmTex.wrapS = THREE.ClampToEdgeWrapping;
  lmTex.wrapT = THREE.ClampToEdgeWrapping;
  lmTex.needsUpdate = true;
  if (texture.image) lmTex.image = texture.image;
  if (texture.source) lmTex.source = texture.source;
  return lmTex;
}

function decodeEpicLmGlsl(mode) {
  // Epic HQ color is an albedo multiplier (final ≈ albedo * LM).
  // Three MeshStandard does irradiance * BRDF_Lambert(albedo) = irradiance * albedo / PI,
  // so Standard path must feed irradiance = LM * PI.
  const assign =
    mode === 'std'
      ? 'irradiance += epicLm * PI;'
      : 'reflectedLight.indirectDiffuse += epicLm;';
  return `{
		vec2 meshUv = vLightMapUv;
		if ( epicFlipMode == 2 ) meshUv.y = 1.0 - meshUv.y;
		vec3 epicLm;
		if ( epicDebugMode == 1 ) {
			epicLm = vec3( meshUv, 0.0 );
		} else if ( epicDebugMode == 2 ) {
			vec2 flippedUv = ( epicFlipMode == 1 ) ? meshUv : epicFlipY( meshUv );
			vec2 atlasUv = ( epicFlipMode == 1 )
				? epicGetLightmapUV0( flippedUv, lm_coordinateScaleBias )
				: epicFlipY( epicGetLightmapUV0( flippedUv, lm_coordinateScaleBias ) );
			epicLm = texture2D( lightMap, atlasUv ).rgb;
		} else if ( epicFlipMode == 1 ) {
			vec2 lightmapUv0 = epicGetLightmapUV0( meshUv, lm_coordinateScaleBias );
			vec2 lightmapUv1 = lightmapUv0 + vec2( 0.0, 0.5 );
			vec4 lightmap0 = texture2D( lightMap, lightmapUv0 );
			vec4 lightmap1 = texture2D( lightMap, lightmapUv1 );
			float logL = lightmap0.w + lightmap1.w * (1.0/255.0) - (0.5/255.0);
			logL = logL * lm_lightmapScale.w + lm_lightmapAdd.w;
			vec3 uvw = lightmap0.rgb * lightmap0.rgb * lm_lightmapScale.rgb + lm_lightmapAdd.rgb;
			float l = exp2(logL) - ${LOG_BLACK_POINT};
			epicLm = uvw * (max(l, 0.0) * epicDirectionality) * epicIntensity;
		} else {
			epicLm = getEpicLightMapColorHQ(
				lightMap, meshUv, lm_coordinateScaleBias, lm_lightmapScale, lm_lightmapAdd,
				epicIntensity, epicDirectionality
			);
		}
		epicLm = epicToneMapLM( epicLm, epicContrast, epicWhitePoint );
		{
			float lmLuma = max( epicLm.r, max( epicLm.g, epicLm.b ) );
			float shadow = 1.0 - smoothstep( 0.04, 0.38, lmLuma );
			epicLm += vec3( epicAmbient ) * shadow;
		}
		${assign}
	}`;
}

function injectHqUniforms(shader, params, uScaleBias, uAdd, uScale) {
  const { intensity, directionality, contrast, flipMode, debugMode, whitePoint, ambient } = params;
  shader.uniforms.lm_coordinateScaleBias = { value: uScaleBias };
  shader.uniforms.lm_lightmapAdd = { value: uAdd };
  shader.uniforms.lm_lightmapScale = { value: uScale };
  shader.uniforms.epicIntensity = { value: intensity };
  shader.uniforms.epicDirectionality = { value: directionality };
  shader.uniforms.epicContrast = { value: contrast };
  shader.uniforms.epicWhitePoint = { value: whitePoint ?? 1.8 };
  shader.uniforms.epicAmbient = { value: ambient ?? 0 };
  shader.uniforms.epicAlbedoLift = { value: params.albedoLift ?? 0 };
  shader.uniforms.epicFlipMode = { value: flipMode };
  shader.uniforms.epicDebugMode = { value: debugMode };

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    `#include <common>
uniform vec4 lm_coordinateScaleBias;
uniform vec4 lm_lightmapAdd;
uniform vec4 lm_lightmapScale;
uniform float epicIntensity;
uniform float epicDirectionality;
uniform float epicContrast;
uniform float epicWhitePoint;
uniform float epicAmbient;
uniform float epicAlbedoLift;
uniform int epicFlipMode;
uniform int epicDebugMode;
${HQ_DECODE}`,
  );
}

function attachLightmap(mat, params) {
  const { texture, texCoord, lightmapAdd, lightmapScale, coordinateScaleBias } = params;
  mat.lightMap = cloneLightmapTexture(texture, texCoord);
  mat.lightMapIntensity = 1;
  mat.defines = { ...(mat.defines || {}), EPIC_HQ_LM: '' };
  if (texCoord >= 1) mat.defines.USE_UV1 = '';

  const uScaleBias = new THREE.Vector4().fromArray(coordinateScaleBias);
  const uAdd = new THREE.Vector4().fromArray(lightmapAdd);
  const uScale = new THREE.Vector4().fromArray(lightmapScale);
  return { uScaleBias, uAdd, uScale };
}

/** Opaque dielectrics: albedo × baked LM (no IBL wash). */
function makeBasicLitMaterial(src, params) {
  const { texture, texCoord } = params;

  const mat = new THREE.MeshBasicMaterial();
  mat.name = (src.name || 'mat') + '_epicLM';
  mat.userData.epicLightmap = true;
  mat.userData.epicKind = 'dielectric';
  // Keep original albedo/textures — do not invent colors
  mat.map = src.map || null;
  mat.color.copy(src.color || new THREE.Color(0xffffff));
  mat.transparent = !!src.transparent;
  mat.opacity = src.opacity ?? 1;
  mat.alphaTest = src.alphaTest || 0;
  mat.side = src.side ?? THREE.FrontSide;
  mat.toneMapped = true;
  mat.alphaMap = src.alphaMap || null;
  if (src.alphaMap) mat.transparent = true;

  const emissiveMap = src.emissiveMap || null;
  const emissive = src.emissive ? src.emissive.clone() : new THREE.Color(0, 0, 0);
  const emissiveIntensity = src.emissiveIntensity ?? 1;
  if (emissiveMap && !mat.map) {
    const whiteMap = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteMap.needsUpdate = true;
    mat.map = whiteMap;
    mat.color.setRGB(0.02, 0.02, 0.02);
  }

  const { uScaleBias, uAdd, uScale } = attachLightmap(mat, params);

  mat.onBeforeCompile = (shader) => {
    injectHqUniforms(shader, params, uScaleBias, uAdd, uScale);
    shader.uniforms.epicEmissiveMap = { value: emissiveMap };
    shader.uniforms.epicEmissive = { value: emissive };
    shader.uniforms.epicEmissiveIntensity = { value: emissiveIntensity };
    shader.uniforms.epicHasEmissiveMap = { value: emissiveMap ? 1 : 0 };

    shader.fragmentShader = shader.fragmentShader.replace(
      'uniform int epicDebugMode;',
      `uniform int epicDebugMode;
uniform sampler2D epicEmissiveMap;
uniform vec3 epicEmissive;
uniform float epicEmissiveIntensity;
uniform int epicHasEmissiveMap;`,
    );

    const replaced = shader.fragmentShader.replace(
      /vec4\s+lightMapTexel\s*=\s*texture2D\(\s*lightMap\s*,\s*vLightMapUv\s*\)\s*;\s*reflectedLight\.indirectDiffuse\s*\+=\s*lightMapTexel\.rgb\s*\*\s*lightMapIntensity\s*\*\s*RECIPROCAL_PI\s*;/,
      `${decodeEpicLmGlsl('basic')}
		vec3 em = epicEmissive * epicEmissiveIntensity;
		if ( epicHasEmissiveMap == 1 ) {
			#if defined( USE_MAP )
			em *= texture2D( epicEmissiveMap, vMapUv ).rgb;
			#else
			em *= texture2D( epicEmissiveMap, vLightMapUv ).rgb;
			#endif
		}
		reflectedLight.directSpecular += max(em, vec3(0.0));`,
    );
    if (replaced === shader.fragmentShader) {
      console.warn('EPIC lightmap: failed to patch MeshBasic lightmap sample');
    }
    shader.fragmentShader = replaced;
    shader.fragmentShader = shader.fragmentShader.replace(
      'reflectedLight.indirectDiffuse *= diffuseColor.rgb;',
      `{
		vec3 alb = diffuseColor.rgb;
		if ( max(alb.r, max(alb.g, alb.b)) < 0.001 ) alb = vec3(0.25);
		reflectedLight.indirectDiffuse *= alb;
		float albL = max(alb.r, max(alb.g, alb.b));
		vec3 tint = alb / albL;
		float darkMat = 1.0 - smoothstep(0.16, 0.72, albL);
		reflectedLight.indirectDiffuse += tint * epicAlbedoLift * darkMat;
	}`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 outgoingLight = reflectedLight.indirectDiffuse;',
      'vec3 outgoingLight = reflectedLight.indirectDiffuse + reflectedLight.directSpecular;',
    );
  };

  mat.customProgramCacheKey = () =>
    `epicBasicKeep2|ch${texCoord}|f${params.flipMode}|d${params.debugMode}|i${params.intensity}|c${params.contrast}|w${params.whitePoint}|a${params.ambient ?? 0}|l${params.albedoLift ?? 0}`;
  mat.needsUpdate = true;
  return mat;
}

/**
 * Clone original Standard/Physical material; only add HQ lightmap.
 * isMetal: keep MR + IBL. !isMetal: kill metalness (glTF default) + env diffuse wash.
 * opts.keepEnv: foliage/glass — keep original env so cutouts aren't black when lights are zeroed.
 */
function makeStandardLitMaterial(src, params, isMetal, opts = {}) {
  const { texCoord, envMapIntensity } = params;
  const keepEnv = !!opts.keepEnv;

  const mat =
    src.isMeshStandardMaterial || src.isMeshPhysicalMaterial
      ? src.clone()
      : new THREE.MeshStandardMaterial({
          map: src.map || null,
          color: (src.color || new THREE.Color(0xffffff)).clone(),
          metalness: isMetal ? (src.metalness ?? 1) : 0,
          roughness: src.roughness ?? 0.5,
          transparent: !!src.transparent,
          opacity: src.opacity ?? 1,
          alphaTest: src.alphaTest || 0,
          side: src.side ?? THREE.FrontSide,
          alphaMap: src.alphaMap || null,
        });

  mat.name = (src.name || 'mat') + (isMetal ? '_epicMetal' : '_epicStd');
  mat.userData.epicLightmap = true;
  mat.userData.epicKind = isMetal ? 'metal' : 'dielectric';
  mat.toneMapped = true;

  // Preserve alpha / side from source
  mat.transparent = !!src.transparent;
  mat.opacity = src.opacity ?? mat.opacity ?? 1;
  mat.alphaTest = src.alphaTest || 0;
  mat.alphaMap = src.alphaMap || mat.alphaMap;
  mat.side = src.side ?? mat.side;
  if (src.alphaMap) mat.transparent = true;
  // MASK foliage: keep depthWrite so leaves sort correctly
  if (mat.alphaTest > 0) {
    mat.depthWrite = true;
    mat.transparent = false;
  }

  // Keep glTF emissives (office ceiling lights, etc.) — do not invent new ones
  if (src.emissive) mat.emissive.copy(src.emissive);
  if (src.emissiveMap) mat.emissiveMap = src.emissiveMap;
  mat.emissiveIntensity = src.emissiveIntensity ?? mat.emissiveIntensity ?? 1;

  if (isMetal) {
    // Do NOT rewrite metalness/roughness/color — keep original GLB chrome/pipes
    mat.envMapIntensity =
      envMapIntensity != null ? envMapIntensity : (mat.envMapIntensity ?? 1);
  } else if (keepEnv) {
    // Foliage/glass: preserve MASK alpha; LM only (no env wash / black-quad hacks)
    mat.metalness = 0;
    mat.metalnessMap = null;
    mat.envMapIntensity = 0;
  } else {
    // Opaque dielectric: keep albedo/normal/AO maps; kill metal + env so LM owns lighting
    mat.metalness = 0;
    mat.metalnessMap = null;
    mat.envMapIntensity = 0;
  }

  const { uScaleBias, uAdd, uScale } = attachLightmap(mat, params);

  mat.onBeforeCompile = (shader) => {
    injectHqUniforms(shader, params, uScaleBias, uAdd, uScale);
    if (isMetal) {
      // Specular IBL only + HQ irradiance (no diffuse IBL stacking)
      const replaced = shader.fragmentShader.replace(
        '#include <lights_fragment_maps>',
        /* glsl */ `
#if defined( RE_IndirectDiffuse )
	#ifdef USE_LIGHTMAP
	${decodeEpicLmGlsl('std')}
	#endif
#endif
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
	radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );
	#ifdef USE_CLEARCOAT
		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
	#endif
#endif
`,
      );
      if (replaced === shader.fragmentShader) {
        console.warn('EPIC lightmap: failed to patch metal lights_fragment_maps');
      }
      shader.fragmentShader = replaced;
    } else {
      // Dielectric / foliage: HQ lightmap only (no IBL wash)
      const replaced = shader.fragmentShader.replace(
        '#include <lights_fragment_maps>',
        /* glsl */ `
#if defined( RE_IndirectDiffuse )
	#ifdef USE_LIGHTMAP
	${decodeEpicLmGlsl('std')}
	#endif
#endif
`,
      );
      if (replaced === shader.fragmentShader) {
        console.warn('EPIC lightmap: failed to patch std lights_fragment_maps');
      }
      shader.fragmentShader = replaced;
    }
  };

  mat.customProgramCacheKey = () =>
    `epicStdKeep5|${isMetal ? 'm' : 'd'}|ke${keepEnv ? 1 : 0}|ch${texCoord}|f${params.flipMode}|i${params.intensity}|c${params.contrast}|w${params.whitePoint}|e${mat.envMapIntensity}|a${params.ambient ?? 0}`;
  mat.needsUpdate = true;
  return mat;
}

function makeLitMaterial(src, params) {
  // Foliage / glass / MASK: keep original cutout material.
  if (needsAlphaPreserve(src)) {
    const mat =
      src.isMeshStandardMaterial || src.isMeshPhysicalMaterial
        ? src.clone()
        : src;
    if (mat !== src) {
      mat.name = (src.name || 'mat') + '_epicAlpha';
      mat.userData.epicLightmap = true;
      mat.userData.epicKind = 'alpha';
      mat.metalness = 0;
      mat.metalnessMap = null;
      mat.envMapIntensity = 1;
      if ((mat.alphaTest || 0) > 0) {
        mat.transparent = false;
        mat.depthWrite = true;
      }
      // UE near-black glass albedo + Three alpha-blend = black veil over interiors
      if (/^glass/i.test(src.name || '')) {
        mat.color.setRGB(1, 1, 1);
        // UE glass albedo was near-black; keep a light window, lower opacity so interiors read
        mat.opacity = Math.min(mat.opacity ?? 0.4, 0.18);
        mat.roughness = Math.min(mat.roughness ?? 0.2, 0.12);
        mat.envMapIntensity = 1.35;
      }
      mat.needsUpdate = true;
    } else {
      src.userData = src.userData || {};
      src.userData.epicSkippedAlpha = true;
    }
    return mat;
  }
  const kind = classifyMaterial(src);
  if (kind === 'metal' || params.forceStandard) {
    return makeStandardLitMaterial(src, params, kind === 'metal');
  }
  // Opaque dielectrics: MeshBasic × HQ LM (Epic semantics: albedo * lightmap).
  // MeshStandard applies Lambert/PI and under-lit interiors even with PI compensation.
  return makeBasicLitMaterial(src, params);
}

function toFallbackStandard(src) {
  // Leave unmapped meshes as-is (or gentle clone) — do not reinvent materials
  if (src.isMeshStandardMaterial || src.isMeshPhysicalMaterial || src.isMeshBasicMaterial) {
    const mat = src.clone();
    mat.userData.epicFallback = true;
    return mat;
  }
  const mat = new THREE.MeshStandardMaterial();
  mat.map = src.map || null;
  mat.color.copy(src.color || new THREE.Color(0xffffff));
  mat.metalness = 0;
  mat.roughness = src.roughness ?? 0.5;
  mat.transparent = !!src.transparent;
  mat.opacity = src.opacity ?? 1;
  mat.alphaTest = src.alphaTest || 0;
  mat.alphaMap = src.alphaMap || null;
  mat.side = src.side ?? THREE.FrontSide;
  mat.userData.epicFallback = true;
  return mat;
}

function meshesForNode(object) {
  if (!object) return [];
  if (object.isMesh || object.isSkinnedMesh) return [object];
  const out = [];
  object.traverse((c) => {
    if (c.isMesh || c.isSkinnedMesh) out.push(c);
  });
  return out;
}

export function balanceRealtimeLights(root, opts = {}) {
  // Kill punctual lights — baked LM owns diffuse; metals use scene env specular
  const scale = opts.scale ?? 0.0;
  let n = 0;
  root.traverse((obj) => {
    if (!obj.isLight) return;
    if (obj.userData.epicLightScaled) return;
    obj.userData.epicOrigIntensity = obj.intensity;
    obj.intensity *= scale;
    obj.userData.epicLightScaled = true;
    n++;
  });
  return n;
}

export async function applyEpicLightmaps(gltf, opts = {}) {
  const intensity = opts.intensity ?? 1.15;
  const directionality = opts.directionality ?? DEFAULT_DIRECTIONALITY;
  const contrast = opts.contrast ?? 1.35;
  const whitePoint = opts.whitePoint ?? 1.8;
  const flipMode = opts.flipMode ?? 1;
  const debugMode = opts.debugMode ?? 0;
  const forceTexCoord = opts.forceTexCoord ?? null;
  const envMapIntensity = opts.envMapIntensity ?? 1.0;
  const baseAmbient = opts.ambient ?? 0;
  const indoorAmbient = opts.indoorAmbient ?? 0;
  const indoorRe = opts.indoorRe ?? /indoor|interior/i;
  const albedoLift = opts.albedoLift ?? 0;
  const parser = gltf.parser;
  const json = parser.json;
  const lightmaps = json.extensions?.EPIC_lightmap_textures?.lightmaps;
  if (!lightmaps?.length) {
    console.warn('No EPIC_lightmap_textures on this glTF');
    return { applied: 0 };
  }

  const baseTexCache = new Map();
  async function getBaseLightmapTexture(textureIndex) {
    if (baseTexCache.has(textureIndex)) return baseTexCache.get(textureIndex);
    const tex = await parser.getDependency('texture', textureIndex);
    const cloned = cloneLightmapTexture(tex, 0);
    baseTexCache.set(textureIndex, cloned);
    return cloned;
  }

  const matCache = new Map();
  const patchedMeshes = new Set();
  let applied = 0;
  let metalCount = 0;
  let dielectricCount = 0;
  const uvStats = { 0: 0, 1: 0, 2: 0, 3: 0, missing: 0 };
  const fallbackNames = [];

  for (let nodeIndex = 0; nodeIndex < json.nodes.length; nodeIndex++) {
    const nodeDef = json.nodes[nodeIndex];
    const lmRef = nodeDef.extensions?.EPIC_lightmap_textures?.lightmap;
    if (lmRef == null || nodeDef.mesh == null) continue;
    const lm = lightmaps[lmRef];
    if (!lm?.texture) continue;

    const object = await parser.getDependency('node', nodeIndex);
    const targets = meshesForNode(object);
    if (!targets.length) continue;

    const baseTex = await getBaseLightmapTexture(lm.texture.index);
    const declaredTc = forceTexCoord != null ? forceTexCoord : lm.texture.texCoord;

    for (const mesh of targets) {
      let localTexCoord;
      if (declaredTc != null && declaredTc !== undefined) {
        localTexCoord = declaredTc;
      } else {
        localTexCoord = mesh.geometry.attributes.uv1 ? 1 : 0;
      }
      ensureUvAttrs(mesh.geometry, localTexCoord);
      const want = localTexCoord === 0 ? 'uv' : `uv${localTexCoord}`;
      if (!mesh.geometry.attributes[want]) {
        uvStats.missing++;
        if (mesh.geometry.attributes.uv1) localTexCoord = 1;
        else if (mesh.geometry.attributes.uv) localTexCoord = 0;
      }
      uvStats[localTexCoord] = (uvStats[localTexCoord] || 0) + 1;

      const meshLabel = `${mesh.name || ''} ${mesh.parent?.name || ''}`;
      const indoor = indoorRe.test(meshLabel);
      const params = {
        texture: baseTex,
        texCoord: localTexCoord,
        lightmapAdd: lm.lightmapAdd,
        lightmapScale: lm.lightmapScale,
        coordinateScaleBias: lm.coordinateScaleBias,
        intensity: indoor ? intensity * (opts.indoorIntensityScale ?? 1) : intensity * (opts.outdoorIntensityScale ?? 1),
        directionality,
        contrast,
        whitePoint,
        flipMode,
        debugMode,
        envMapIntensity,
        ambient: baseAmbient + (indoor ? indoorAmbient : 0),
        albedoLift,
        forceStandard: !!opts.forceStandard,
        meshLabel,
      };

      const srcMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const outMats = srcMats.map((src) => {
        const kind = classifyMaterial(src);
        // Mild damp only on hot floor LMs — never touch chrome/bin/pipe albedos
        const sn = src.name || '';
        const isFloorish = /floor|placeholder_floor|worldgrid/i.test(sn);
        const lmPeak = Math.max(
          lm.lightmapScale?.[0] ?? 1,
          lm.lightmapScale?.[1] ?? 1,
          lm.lightmapScale?.[2] ?? 1,
        );
        // Floors only — PI-correct Standard path already fixes underlit interiors
        const floorDamp = isFloorish ? (lmPeak > 1.8 ? 0.72 : lmPeak > 1.2 ? 0.82 : 0.9) : 1.0;
        const localParams =
          floorDamp === 1 ? params : { ...params, intensity: params.intensity * floorDamp };
        const key = [
          src.uuid,
          kind,
          lm.texture.index,
          localTexCoord,
          lm.coordinateScaleBias.join(','),
          lm.lightmapScale.join(','),
          lm.lightmapAdd.join(','),
          flipMode,
          debugMode,
          localParams.intensity,
          directionality,
          contrast,
          whitePoint,
          envMapIntensity,
          localParams.ambient ?? 0,
          localParams.albedoLift ?? 0,
          opts.forceStandard ? 1 : 0,
          needsAlphaPreserve(src) ? 'a' : 'o',
        ].join('|');
        if (matCache.has(key)) return matCache.get(key);
        if (kind === 'metal') metalCount++;
        else dielectricCount++;
        const patched = makeLitMaterial(src, localParams);
        matCache.set(key, patched);
        return patched;
      });
      mesh.material = Array.isArray(mesh.material) ? outMats : outMats[0];
      patchedMeshes.add(mesh);
      applied++;
    }
  }

  let fallbacks = 0;
  gltf.scene.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    if (patchedMeshes.has(obj)) return;
    const srcMats = Array.isArray(obj.material) ? obj.material : [obj.material];
    if (srcMats.every((m) => m?.userData?.epicLightmap || m?.userData?.epicFallback)) return;
    const out = srcMats.map((m) => toFallbackStandard(m));
    obj.material = Array.isArray(obj.material) ? out : out[0];
    fallbacks++;
    fallbackNames.push(obj.name || '(unnamed)');
  });

  console.log('EPIC lightmap UV', uvStats, 'dielectric', dielectricCount, 'metal', metalCount, 'fallbacks', fallbacks);
  return { applied, uvStats, fallbacks, fallbackNames, metalCount, dielectricCount };
}

export function sanitizeGltfJson(json) {
  if (!json.animations) return json;
  json.animations = json.animations
    .map((anim) => ({
      ...anim,
      channels: (anim.channels || []).filter((ch) => ch.target?.node != null && ch.target.node >= 0),
    }))
    .filter((anim) => anim.channels?.length);
  return json;
}
