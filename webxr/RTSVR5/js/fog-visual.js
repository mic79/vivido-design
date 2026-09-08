// Shared FoW visual — darken-only in terrain shaders (no hue, no floating plane).
// Gameplay fog texture covers the nav plane; visual ground beyond nav is also darkened.
import { MAP_NAV_PLANE_HALF_M, MAP_NAV_PLANE_SPAN_M } from './config.js';

/** Visual FoW half-extent (m) — skirts/hills beyond the nav disk stay darkened. */
export const FOG_VISUAL_HALF_M = 520;

/** @type {import('three').Texture | null} */
let fogMap = null;
let fogOn = 0;
/** Unexplored darken strength outside the nav fog texture (0..1). */
let fogOutsideA = 0.72;
/** @type {WeakSet<object>} */
const installed = new WeakSet();
/** @type {Set<object>} */
const uniformBags = new Set();

export function setFogVisualMap(texture) {
  fogMap = texture || null;
  for (const u of uniformBags) {
    if (u.uRtsFogMap) u.uRtsFogMap.value = fogMap;
  }
}

export function setFogVisualEnabled(on) {
  fogOn = on ? 1 : 0;
  for (const u of uniformBags) {
    if (u.uRtsFogOn) u.uRtsFogOn.value = fogOn;
  }
}

export function setFogVisualOutsideAlpha(a) {
  fogOutsideA = Math.max(0, Math.min(1, a));
  for (const u of uniformBags) {
    if (u.uRtsFogOutsideA) u.uRtsFogOutsideA.value = fogOutsideA;
  }
}

export function syncFogVisualExtents() {
  for (const u of uniformBags) {
    if (u.uRtsFogHalf) u.uRtsFogHalf.value = MAP_NAV_PLANE_HALF_M;
    if (u.uRtsFogSpan) u.uRtsFogSpan.value = MAP_NAV_PLANE_SPAN_M;
    if (u.uRtsFogVisHalf) u.uRtsFogVisHalf.value = FOG_VISUAL_HALF_M;
    if (u.uRtsFogOutsideA) u.uRtsFogOutsideA.value = fogOutsideA;
  }
}

/**
 * Darken terrain by FoW alpha (black multiply — no hue).
 * Inside nav plane: sample fog canvas. Beyond nav but within visual half: full outside shroud.
 */
export function installFogVisualOnMaterial(mat) {
  if (!mat || installed.has(mat)) {
    syncFogVisualExtents();
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

    shader.uniforms.uRtsFogMap = { value: fogMap };
    shader.uniforms.uRtsFogOn = { value: fogOn };
    shader.uniforms.uRtsFogHalf = { value: MAP_NAV_PLANE_HALF_M };
    shader.uniforms.uRtsFogSpan = { value: MAP_NAV_PLANE_SPAN_M };
    shader.uniforms.uRtsFogVisHalf = { value: FOG_VISUAL_HALF_M };
    shader.uniforms.uRtsFogOutsideA = { value: fogOutsideA };
    uniformBags.add(shader.uniforms);
    mat.userData._rtsFogUniforms = shader.uniforms;

    if (!shader.vertexShader.includes('vRtsFogWorldPos')) {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `#include <common>
varying vec3 vRtsFogWorldPos;`
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `#include <begin_vertex>
	vRtsFogWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`
        );
    }

    if (!shader.fragmentShader.includes('uRtsFogMap')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        /* glsl */ `#include <common>
varying vec3 vRtsFogWorldPos;
uniform sampler2D uRtsFogMap;
uniform float uRtsFogOn;
uniform float uRtsFogHalf;
uniform float uRtsFogSpan;
uniform float uRtsFogVisHalf;
uniform float uRtsFogOutsideA;`
      );

      // Darken only: rgb *= (1 - a). Never mix toward a tinted color.
      const fogTail = /* glsl */ `
	if ( uRtsFogOn > 0.5 && uRtsFogSpan > 1.0 ) {
		float fogA = 0.0;
		vec2 fuv = vec2(
			( vRtsFogWorldPos.x + uRtsFogHalf ) / uRtsFogSpan,
			1.0 - ( vRtsFogWorldPos.z + uRtsFogHalf ) / uRtsFogSpan
		);
		if ( fuv.x >= 0.0 && fuv.x <= 1.0 && fuv.y >= 0.0 && fuv.y <= 1.0 ) {
			fogA = texture2D( uRtsFogMap, fuv ).a;
		} else {
			float ax = abs( vRtsFogWorldPos.x );
			float az = abs( vRtsFogWorldPos.z );
			if ( ax <= uRtsFogVisHalf && az <= uRtsFogVisHalf ) {
				fogA = uRtsFogOutsideA;
			}
		}
		diffuseColor.rgb *= ( 1.0 - fogA );
	}
`;
      if (shader.fragmentShader.includes('#include <map_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>${fogTail}`
        );
      } else if (shader.fragmentShader.includes('#include <opaque_fragment>')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
	if ( uRtsFogOn > 0.5 && uRtsFogSpan > 1.0 ) {
		float fogA = 0.0;
		vec2 fuv = vec2(
			( vRtsFogWorldPos.x + uRtsFogHalf ) / uRtsFogSpan,
			1.0 - ( vRtsFogWorldPos.z + uRtsFogHalf ) / uRtsFogSpan
		);
		if ( fuv.x >= 0.0 && fuv.x <= 1.0 && fuv.y >= 0.0 && fuv.y <= 1.0 ) {
			fogA = texture2D( uRtsFogMap, fuv ).a;
		} else {
			float ax = abs( vRtsFogWorldPos.x );
			float az = abs( vRtsFogWorldPos.z );
			if ( ax <= uRtsFogVisHalf && az <= uRtsFogVisHalf ) {
				fogA = uRtsFogOutsideA;
			}
		}
		gl_FragColor.rgb *= ( 1.0 - fogA );
	}
`
        );
      }
    }
  };

  mat.customProgramCacheKey = () => `${prevKey()}|rtsFogDarken58`;
  mat.needsUpdate = true;
}

/** Install on every mesh material under a root (ground / baked moon). */
export function installFogVisualUnder(root) {
  if (!root || !root.traverse) return;
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (m) installFogVisualOnMaterial(m);
    }
  });
}
