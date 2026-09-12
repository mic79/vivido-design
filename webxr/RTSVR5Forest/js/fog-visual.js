// Shared FoW visual — darken-only in terrain shaders (no hue, no floating plane).
// Gameplay fog texture covers the nav plane; visual ground beyond nav is also darkened.
// Focus-cull fade: same multiply darken outside the blue camera ring (world XZ).
import { MAP_SIZE, MAP_NAV_PLANE_HALF_M, MAP_NAV_PLANE_SPAN_M } from './config.js';

/**
 * Visual FoW half-extent (m). Must cover the horizon skirt:
 * plate half (MAP_SIZE/2) + default skirt depth (~920) ≈ 1020.
 */
export function fogVisualHalfM() {
  const plateHalf = Math.max(100, MAP_SIZE * 0.5);
  const skirtDepth =
    typeof window !== 'undefined' && Number.isFinite(window.RTS_HORIZON_SKIRT_DEPTH)
      ? Math.max(80, Math.min(2800, window.RTS_HORIZON_SKIRT_DEPTH))
      : 920;
  return plateHalf + skirtDepth + 40;
}

/** @type {import('three').Texture | null} */
let fogMap = null;
let fogOn = 0;
/** Unexplored darken strength outside the nav fog texture (0..1). */
let fogOutsideA = 0.72;

/** Focus-ring fade (same darken multiply as FoW). */
let focusFadeOn = 0;
let focusFadeX = 0;
let focusFadeZ = 0;
let focusFadeInner = 80;
let focusFadeOuter = 150;

/** @type {WeakSet<object>} */
const installed = new WeakSet();
/** @type {Set<object>} */
const uniformBags = new Set();

function makeFocusXZ() {
  const T = typeof window !== 'undefined' ? window.THREE : null;
  return T ? new T.Vector2(focusFadeX, focusFadeZ) : { x: focusFadeX, y: focusFadeZ, set(x, z) { this.x = x; this.y = z; } };
}

function pushAllUniforms() {
  const visHalf = fogVisualHalfM();
  for (const u of uniformBags) {
    if (u.uRtsFogMap) u.uRtsFogMap.value = fogMap;
    if (u.uRtsFogOn) u.uRtsFogOn.value = fogOn;
    if (u.uRtsFogHalf) u.uRtsFogHalf.value = MAP_NAV_PLANE_HALF_M;
    if (u.uRtsFogSpan) u.uRtsFogSpan.value = MAP_NAV_PLANE_SPAN_M;
    if (u.uRtsFogVisHalf) u.uRtsFogVisHalf.value = visHalf;
    if (u.uRtsFogOutsideA) u.uRtsFogOutsideA.value = fogOutsideA;
    if (u.uRtsFocusFadeOn) u.uRtsFocusFadeOn.value = focusFadeOn;
    if (u.uRtsFocusXZ?.value?.set) u.uRtsFocusXZ.value.set(focusFadeX, focusFadeZ);
    if (u.uRtsFocusInner) u.uRtsFocusInner.value = focusFadeInner;
    if (u.uRtsFocusOuter) u.uRtsFocusOuter.value = focusFadeOuter;
  }
}

export function setFogVisualMap(texture) {
  fogMap = texture || null;
  pushAllUniforms();
}

export function setFogVisualEnabled(on) {
  fogOn = on ? 1 : 0;
  pushAllUniforms();
}

export function setFogVisualOutsideAlpha(a) {
  fogOutsideA = Math.max(0, Math.min(1, a));
  pushAllUniforms();
}

export function syncFogVisualExtents() {
  pushAllUniforms();
}

/**
 * Fade terrain to black outside the blue focus ring (world XZ).
 * Same multiply path as FoW — no screen-space veil.
 */
export function setFocusFadeDisk(on, x, z, innerR, outerR) {
  focusFadeOn = on ? 1 : 0;
  focusFadeX = Number(x) || 0;
  focusFadeZ = Number(z) || 0;
  focusFadeInner = Math.max(1, Number(innerR) || 80);
  focusFadeOuter = Math.max(focusFadeInner + 1, Number(outerR) || focusFadeInner + 55);
  pushAllUniforms();
}

/** After map_fragment: FoW uses per-vertex XZ; focus uses per-vertex on terrain,
 * instance/object origin on InstancedMesh so whole props black out together. */
const SHROUD_AFTER_MAP = /* glsl */ `
	float rtsShroudMul = 1.0;
	{
		float shroudA = 0.0;
		if ( uRtsFogOn > 0.5 && uRtsFogSpan > 1.0 ) {
			float fogA = 0.0;
			vec2 fuv = vec2(
				( vRtsFogWorldPos.x + uRtsFogHalf ) / uRtsFogSpan,
				1.0 - ( vRtsFogWorldPos.z + uRtsFogHalf ) / uRtsFogSpan
			);
			if ( fuv.x >= 0.0 && fuv.x <= 1.0 && fuv.y >= 0.0 && fuv.y <= 1.0 ) {
				fogA = texture2D( uRtsFogMap, fuv ).a;
			} else if ( abs( vRtsFogWorldPos.x ) <= uRtsFogVisHalf && abs( vRtsFogWorldPos.z ) <= uRtsFogVisHalf ) {
				fogA = uRtsFogOutsideA;
			}
			shroudA = fogA;
		}
		if ( uRtsFocusFadeOn > 0.5 ) {
			// Terrain = large non-instanced mesh: MUST use per-vertex XZ (origin would
			// black/dim the entire plate when the blue ring leaves map center).
			// Instanced props = fade from instance origin so the whole rock goes black.
#ifdef USE_INSTANCING
			float fd = length( vRtsObjXZ - uRtsFocusXZ );
#else
			float fd = length( vRtsFogWorldPos.xz - uRtsFocusXZ );
#endif
			float focusA = smoothstep( uRtsFocusInner, max( uRtsFocusOuter, uRtsFocusInner + 1.0 ), fd );
			focusA = clamp( focusA / 0.28, 0.0, 1.0 );
			shroudA = max( shroudA, focusA );
		}
		rtsShroudMul = 1.0 - shroudA;
		diffuseColor.rgb *= rtsShroudMul;
	}
`;

/** Kill specular / env / emissive leftovers (props stay lit if only albedo is multiplied). */
const SHROUD_BEFORE_OPAQUE = /* glsl */ `
	outgoingLight *= rtsShroudMul;
`;

/**
 * Darken terrain + scenery by FoW + optional focus-ring fade (black multiply — no hue).
 */
export function installFogVisualOnMaterial(mat) {
  if (!mat || installed.has(mat)) {
    pushAllUniforms();
    return;
  }
  installed.add(mat);

  const prev = mat.onBeforeCompile;
  const prevKey =
    typeof mat.customProgramCacheKey === 'function'
      ? mat.customProgramCacheKey.bind(mat)
      : () => '';

  mat.onBeforeCompile = (shader) => {
    if (typeof prev === 'function') prev(shader);

    const visHalf = fogVisualHalfM();
    shader.uniforms.uRtsFogMap = { value: fogMap };
    shader.uniforms.uRtsFogOn = { value: fogOn };
    shader.uniforms.uRtsFogHalf = { value: MAP_NAV_PLANE_HALF_M };
    shader.uniforms.uRtsFogSpan = { value: MAP_NAV_PLANE_SPAN_M };
    shader.uniforms.uRtsFogVisHalf = { value: visHalf };
    shader.uniforms.uRtsFogOutsideA = { value: fogOutsideA };
    shader.uniforms.uRtsFocusFadeOn = { value: focusFadeOn };
    shader.uniforms.uRtsFocusXZ = { value: makeFocusXZ() };
    shader.uniforms.uRtsFocusInner = { value: focusFadeInner };
    shader.uniforms.uRtsFocusOuter = { value: focusFadeOuter };
    if (shader.uniforms.uRtsFocusXZ.value?.set) {
      shader.uniforms.uRtsFocusXZ.value.set(focusFadeX, focusFadeZ);
    }
    uniformBags.add(shader.uniforms);
    mat.userData._rtsFogUniforms = shader.uniforms;

    if (!shader.vertexShader.includes('vRtsObjXZ')) {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
varying vec3 vRtsFogWorldPos;
varying vec2 vRtsObjXZ;`
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
	vRtsFogWorldPos = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
	vRtsObjXZ = ( modelMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;
#else
	vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
	vRtsObjXZ = ( modelMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xz;
#endif`
        );
    }

    if (!shader.fragmentShader.includes('uRtsFocusFadeOn')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        /* glsl */ `#include <common>
varying vec3 vRtsFogWorldPos;
varying vec2 vRtsObjXZ;
uniform sampler2D uRtsFogMap;
uniform float uRtsFogOn;
uniform float uRtsFogHalf;
uniform float uRtsFogSpan;
uniform float uRtsFogVisHalf;
uniform float uRtsFogOutsideA;
uniform float uRtsFocusFadeOn;
uniform vec2 uRtsFocusXZ;
uniform float uRtsFocusInner;
uniform float uRtsFocusOuter;`
      );

      if (shader.fragmentShader.includes('#include <map_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>${SHROUD_AFTER_MAP}`
        );
      } else {
        // No map chunk (rare): declare mul so opaque path still compiles.
        shader.fragmentShader = shader.fragmentShader.replace(
          'void main() {',
          `void main() {\n	float rtsShroudMul = 1.0;`
        );
      }

      // Always kill final lit color (specular/env/emissive survive albedo-only mul on props).
      if (shader.fragmentShader.includes('#include <opaque_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          `${SHROUD_BEFORE_OPAQUE}\n	#include <opaque_fragment>`
        );
      } else if (shader.fragmentShader.includes('#include <output_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <output_fragment>',
          `${SHROUD_BEFORE_OPAQUE}\n	#include <output_fragment>`
        );
      }
    }
  };

  mat.customProgramCacheKey = () => `${prevKey()}|rtsFogFocusFade6`;
  mat.needsUpdate = true;
}

/** Install on every mesh material under a root (ground / kit props / forest / skirts). */
export function installFogVisualUnder(root) {
  if (!root || !root.traverse) return;
  root.traverse((obj) => {
    if (!obj.isMesh && !obj.isInstancedMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      // Depth-only occluders (colorWrite false) — skip.
      if (!m || m.colorWrite === false) continue;
      installFogVisualOnMaterial(m);
    }
  });
  pushAllUniforms();
}
