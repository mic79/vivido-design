/**
 * Radial (true camera-distance) fog via `onBeforeCompile`, so fog does not swim when the
 * headset rotates — stock `THREE.Fog` uses view-depth, not `length(worldPos - camera)`.
 * @module radialFogMaterials
 */
import * as THREE from "three";

/** Shared by all patched programs — update once per frame or when sky colour changes. */
export const radialFogUniforms = {
  near: { value: 1250 },
  far: { value: 2500 },
  color: { value: new THREE.Vector3(0, 0, 0) },
};

/** @param {number} near @param {number} far @param {number} horizonHex */
export function setRadialFogParams(near, far, horizonHex) {
  radialFogUniforms.near.value = near;
  radialFogUniforms.far.value = far;
  setRadialFogColorHex(horizonHex);
}

/** @param {number} horizonHex */
export function setRadialFogColorHex(horizonHex) {
  const c = new THREE.Color(horizonHex);
  radialFogUniforms.color.value.set(c.r, c.g, c.b);
}

const _patchedMaterials = new WeakSet();

/**
 * @param {THREE.Material | null | undefined} m
 * @returns {boolean}
 */
function materialSupportsRadialFog_(m) {
  if (!m || m.isShaderMaterial || m.isRawShaderMaterial) return false;
  if (m.isSpriteMaterial) return false;
  if (m.isShadowMaterial) return false;
  if (m.fog === false) return false;
  if (m.isMeshBasicMaterial && m.depthTest === false) return false;
  return !!(
    m.isMeshStandardMaterial
    || m.isMeshPhysicalMaterial
    || m.isMeshLambertMaterial
    || m.isMeshPhongMaterial
    || m.isMeshToonMaterial
    || m.isMeshBasicMaterial
    || m.isLineBasicMaterial
    || m.isLineDashedMaterial
    || m.isPointsMaterial
  );
}

const _worldPosVert = `vec4 _rfWP = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
	_rfWP = batchingMatrix * _rfWP;
#endif
#ifdef USE_INSTANCING
	_rfWP = instanceMatrix * _rfWP;
#endif
_rfWP = modelMatrix * _rfWP;
vRadialFogWorldPos = _rfWP.xyz;`;

const _fogFrag = `{
	float _rfDist = length( vRadialFogWorldPos - cameraPosition );
	float _rfFogF = smoothstep( radialFogNear, radialFogFar, _rfDist );
	gl_FragColor.rgb = mix( gl_FragColor.rgb, radialFogColor, _rfFogF );
}`;

/**
 * Patch one material once (WeakSet). Safe to call repeatedly on the same instance.
 * @param {THREE.Material | null | undefined} m
 */
export function patchMaterialForRadialFog(m) {
  if (!materialSupportsRadialFog_(m) || _patchedMaterials.has(m)) return;
  _patchedMaterials.add(m);

  const prev = m.onBeforeCompile;
  /** @param {any} parameters — Three passes program `parameters` (vertexShader, fragmentShader, uniforms). */
  m.onBeforeCompile = (parameters) => {
    if (prev) prev(parameters);
    if (parameters.fragmentShader.includes("radialFogNear")) return;
    if (!parameters.vertexShader.includes("#include <fog_vertex>")
      || !parameters.vertexShader.includes("#include <fog_pars_vertex>")
      || !parameters.fragmentShader.includes("#include <fog_pars_fragment>")
      || !parameters.fragmentShader.includes("#include <fog_fragment>")) {
      return;
    }

    /* JS uniforms + matching GLSL declarations (Three does not inject these automatically). */
    parameters.uniforms.radialFogNear = radialFogUniforms.near;
    parameters.uniforms.radialFogFar = radialFogUniforms.far;
    parameters.uniforms.radialFogColor = radialFogUniforms.color;

    /* Fragment: same `varying` as vertex (Three maps `varying` → `in` on WebGL2 fragment). */
    parameters.fragmentShader = parameters.fragmentShader.replace(
      "#include <fog_pars_fragment>",
      `#include <fog_pars_fragment>
uniform float radialFogNear;
uniform float radialFogFar;
uniform vec3 radialFogColor;
varying vec3 vRadialFogWorldPos;`,
    );

    parameters.vertexShader = parameters.vertexShader.replace(
      "#include <fog_pars_vertex>",
      `#include <fog_pars_vertex>
varying vec3 vRadialFogWorldPos;`,
    );
    parameters.vertexShader = parameters.vertexShader.replace(
      "#include <fog_vertex>",
      _worldPosVert,
    );
    parameters.fragmentShader = parameters.fragmentShader.replace(
      "#include <fog_fragment>",
      _fogFrag,
    );
  };
  m.needsUpdate = true;
}

/**
 * Traverse `root` and patch every eligible mesh / line / points material.
 * @param {THREE.Object3D} root
 */
export function patchRadialFogOntoObjectTree(root) {
  root.traverse((o) => {
    const any = /** @type {any} */ (o);
    if (!any.isMesh && !any.isLine && !any.isLineSegments && !any.isPoints) return;
    const mat = any.material;
    if (!mat) return;
    const list = Array.isArray(mat) ? mat : [mat];
    for (let i = 0; i < list.length; i++) patchMaterialForRadialFog(list[i]);
  });
}
