/**
 * Glossy planar floor reflection (after whiteRoomVR/GlossyReflector):
 * mirror capture + height-from-plane map + separable blur, so things touching the
 * floor reflect crisply and tall architecture dissolves into a soft sheen.
 *
 * Unlike the whiteRoom version this PATCHES a lit MeshStandardMaterial, so the floor
 * keeps its texture, receives sun shadows and IBL, and the reflection is mixed in
 * by fresnel before tone mapping. Captured once per frame (both XR eyes share it).
 */
import * as THREE from 'three';

const blurFrag = /* glsl */ `
uniform sampler2D tDiffuse; uniform vec2 direction; uniform vec2 resolution; varying vec2 vUv;
// one bad texel would otherwise smear into a black block across all blur passes
vec4 S(vec2 p) { return max(min(texture2D(tDiffuse, p), vec4(64.0)), vec4(0.0)); }
void main() {
  vec2 t = direction / resolution;
  vec4 c = S(vUv) * 0.227027;
  c += S(vUv + t * 1.384615) * 0.316216;
  c += S(vUv - t * 1.384615) * 0.316216;
  c += S(vUv + t * 3.230769) * 0.070270;
  c += S(vUv - t * 3.230769) * 0.070270;
  gl_FragColor = c;
}`;
const quadVert = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export class FloorReflector {
  /**
   * @param {THREE.Mesh} mesh floor mesh (geometry lies in its local XZ plane, normal +Y)
   * @param {THREE.MeshStandardMaterial} material material to patch (mesh.material)
   */
  constructor(mesh, material, o = {}) {
    const res = o.resolution ?? 1024;
    this.mesh = mesh;
    this.maxDist = o.maxDist ?? 6;
    this.clipBias = o.clipBias ?? 0.003;
    this.kernels = o.blurKernels ?? [2.0, 4.5, 8.0];
    this.excluded = [];
    const rt = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType };
    this.fbo = new THREE.WebGLRenderTarget(res, res, { ...rt, depthBuffer: true });
    this.fboH = new THREE.WebGLRenderTarget(res / 2, res / 2, { ...rt, depthBuffer: true });
    this.fboA = new THREE.WebGLRenderTarget(res / 2, res / 2, rt);
    this.fboB = new THREE.WebGLRenderTarget(res / 2, res / 2, rt);
    this.res = res;
    this.enabled = true;

    this.distMat = new THREE.ShaderMaterial({
      uniforms: { planePoint: { value: new THREE.Vector3() }, planeNormal: { value: new THREE.Vector3(0, 1, 0) }, maxDist: { value: this.maxDist } },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform vec3 planePoint; uniform vec3 planeNormal; uniform float maxDist; varying vec3 vW;
        void main(){ float h = clamp(abs(dot(vW - planePoint, planeNormal)) / maxDist, 0.0, 1.0); gl_FragColor = vec4(h,h,h,1.0); }`,
      side: THREE.DoubleSide,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, direction: { value: new THREE.Vector2() }, resolution: { value: new THREE.Vector2(res / 2, res / 2) } },
      vertexShader: quadVert,
      fragmentShader: blurFrag,
      depthTest: false,
      depthWrite: false,
    });
    this.blurScene = new THREE.Scene();
    this.blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
    this.blurQuad.frustumCulled = false;
    this.blurScene.add(this.blurQuad);
    this.blurCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.textureMatrix = new THREE.Matrix4();
    this.virtualCamera = new THREE.PerspectiveCamera();
    this.uniforms = {
      tRefl: { value: this.fbo.texture },
      tReflBlur: { value: this.fboB.texture },
      tReflH: { value: this.fboH.texture },
      reflMatrix: { value: this.textureMatrix },
      reflStrength: { value: o.strength ?? 0.9 },
      reflMinF: { value: o.minFresnel ?? 0.55 },
      reflFresnel: { value: o.fresnelPower ?? 3.0 },
      reflSharp: { value: o.heightSharp ?? 0.06 },
      reflSoft: { value: o.heightSoft ?? 0.55 },
      reflNearBlur: { value: o.nearBlur ?? 0.12 },
      reflDistort: { value: o.distort ?? 0.03 },
      reflOn: { value: 0 },
    };
    this._patch(material);
    this._frame = -1;
    mesh.onBeforeRender = (renderer, scene, camera) => this._capture(renderer, scene, camera);
  }

  _patch(mat) {
    const U = this.uniforms;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform mat4 reflMatrix;\nvarying vec4 vReflUv;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvReflUv = reflMatrix * vec4(transformed, 1.0);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tRefl; uniform sampler2D tReflBlur; uniform sampler2D tReflH;
uniform float reflStrength, reflMinF, reflFresnel, reflSharp, reflSoft, reflNearBlur, reflDistort, reflOn;
varying vec4 vReflUv;`)
        .replace('#include <opaque_fragment>', `
if (reflOn > 0.5) {
  vec3 gN = normalize(vNormal);
  vec2 ruv = vReflUv.xy / max(vReflUv.w, 1e-5) + (normal.xy - gN.xy) * reflDistort;
  ruv = clamp(ruv, vec2(0.001), vec2(0.999));
  float rh = texture2D(tReflH, ruv).r;
  vec3 refl = mix(texture2D(tRefl, ruv).rgb, texture2D(tReflBlur, ruv).rgb,
                  mix(reflNearBlur, 1.0, smoothstep(reflSharp, reflSoft, rh)));
  float fr = pow(1.0 - clamp(dot(gN, normalize(vViewPosition)), 0.0, 1.0), reflFresnel);
  float amt = mix(reflStrength * reflMinF, reflStrength, fr) * clamp(1.15 - roughnessFactor * 1.6, 0.0, 1.0);
  outgoingLight = mix(outgoingLight, refl, amt);
}
#include <opaque_fragment>`);
    };
    mat.customProgramCacheKey = () => 'mg5-floor-reflector';
    mat.needsUpdate = true;
  }

  /** Objects hidden during the mirror capture (UI, controllers…). */
  exclude(...objs) {
    this.excluded.push(...objs.filter(Boolean));
  }

  _setupCamera(camera) {
    if (camera.isArrayCamera && camera.cameras?.length) camera = camera.cameras[0];
    const m = this.mesh;
    const P = new THREE.Vector3().setFromMatrixPosition(m.matrixWorld);
    const C = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const R = new THREE.Matrix4().extractRotation(m.matrixWorld);
    const N = new THREE.Vector3(0, 1, 0).applyMatrix4(R).normalize();
    const view = new THREE.Vector3().subVectors(P, C);
    if (view.dot(N) > 0) return false;
    view.reflect(N).negate().add(P);
    const camR = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(camR).add(C);
    const target = new THREE.Vector3().subVectors(P, look).reflect(N).negate().add(P);
    const vc = this.virtualCamera;
    vc.position.copy(view);
    vc.up.set(0, 1, 0).applyMatrix4(camR).reflect(N);
    vc.lookAt(target);
    vc.near = camera.near;
    vc.far = camera.far;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);
    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse).multiply(m.matrixWorld);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(N, P).applyMatrix4(vc.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = vc.projectionMatrix.elements;
    const q = new THREE.Vector4(
      (Math.sign(clip.x) + pm[8]) / pm[0],
      (Math.sign(clip.y) + pm[9]) / pm[5],
      -1,
      (1 + pm[10]) / pm[14],
    );
    clip.multiplyScalar(2 / clip.dot(q));
    pm[2] = clip.x;
    pm[6] = clip.y;
    pm[10] = clip.z + 1 - this.clipBias;
    pm[14] = clip.w;
    this._P = P;
    this._N = N;
    return true;
  }

  _capture(renderer, scene, camera) {
    if (FloorReflector._busy) return;
    if (!this.enabled) {
      this.uniforms.reflOn.value = 0;
      return;
    }
    const frame = renderer.info.render.frame;
    if (frame === this._frame) return;
    this._frame = frame;
    if (!this._setupCamera(camera)) {
      this.uniforms.reflOn.value = 0;
      return;
    }
    FloorReflector._busy = true;
    const prev = {
      target: renderer.getRenderTarget(),
      xr: renderer.xr.enabled,
      shadow: renderer.shadowMap.autoUpdate,
      override: scene.overrideMaterial,
      autoClear: renderer.autoClear,
      bg: scene.background,
      clear: renderer.getClearColor(new THREE.Color()),
      clearA: renderer.getClearAlpha(),
    };
    const hidden = [this.mesh, ...this.excluded].map((o) => [o, o.visible]);
    for (const [o] of hidden) o.visible = false;
    this.uniforms.reflOn.value = 0;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;

    this.distMat.uniforms.planePoint.value.copy(this._P);
    this.distMat.uniforms.planeNormal.value.copy(this._N);
    scene.background = null;
    scene.overrideMaterial = this.distMat;
    renderer.setRenderTarget(this.fboH);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, this.virtualCamera);

    scene.overrideMaterial = prev.override;
    scene.background = prev.bg;
    renderer.setRenderTarget(this.fbo);
    renderer.setClearColor(prev.clear, 1);
    renderer.clear();
    renderer.render(scene, this.virtualCamera);

    const u = this.blurMat.uniforms;
    let src = this.fbo.texture;
    for (const k of this.kernels) {
      u.tDiffuse.value = src;
      u.direction.value.set(k, 0);
      renderer.setRenderTarget(this.fboA);
      renderer.render(this.blurScene, this.blurCam);
      u.tDiffuse.value = this.fboA.texture;
      u.direction.value.set(0, k);
      renderer.setRenderTarget(this.fboB);
      renderer.render(this.blurScene, this.blurCam);
      src = this.fboB.texture;
    }
    u.tDiffuse.value = null;

    renderer.setClearColor(prev.clear, prev.clearA);
    renderer.autoClear = prev.autoClear;
    renderer.xr.enabled = prev.xr;
    renderer.shadowMap.autoUpdate = prev.shadow;
    renderer.setRenderTarget(prev.target);
    if (camera.viewport) renderer.state.viewport(camera.viewport);
    for (const [o, v] of hidden) o.visible = v;
    this.uniforms.reflOn.value = 1;
    // nested renders bump info.render.frame; remember the post-capture value so the
    // second XR eye in this same frame reuses the capture
    this._frame = renderer.info.render.frame;
    FloorReflector._busy = false;
  }

  dispose() {
    this.mesh.onBeforeRender = () => {};
    for (const f of [this.fbo, this.fboH, this.fboA, this.fboB]) f.dispose();
    this.distMat.dispose();
    this.blurMat.dispose();
    this.blurQuad.geometry.dispose();
  }
}
FloorReflector._busy = false;
