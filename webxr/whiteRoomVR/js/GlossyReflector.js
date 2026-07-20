/**
 * Planar glossy floor reflector — distance-from-plane blur.
 * Kept simple: one capture path (no soft-mesh composite — that broke reflections).
 */
import {
  Color,
  DepthTexture,
  DepthFormat,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  UnsignedShortType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three';

const blurVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const blurFragment = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 direction;
uniform vec2 resolution;
varying vec2 vUv;
void main() {
  vec2 t = direction / resolution;
  vec4 c = texture2D(tDiffuse, vUv) * 0.227027;
  c += texture2D(tDiffuse, vUv + t * 1.384615) * 0.316216;
  c += texture2D(tDiffuse, vUv - t * 1.384615) * 0.316216;
  c += texture2D(tDiffuse, vUv + t * 3.230769) * 0.070270;
  c += texture2D(tDiffuse, vUv - t * 3.230769) * 0.070270;
  gl_FragColor = c;
}
`;

const distVertex = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const distFragment = /* glsl */ `
uniform vec3 planePoint;
uniform vec3 planeNormal;
uniform float maxDist;
varying vec3 vWorldPos;
void main() {
  float d = abs(dot(vWorldPos - planePoint, planeNormal));
  float h = clamp(d / maxDist, 0.0, 1.0);
  gl_FragColor = vec4(h, h, h, 1.0);
}
`;

const surfaceVertex = /* glsl */ `
uniform mat4 textureMatrix;
varying vec4 vReflectUv;
varying vec3 vViewDir;
varying vec3 vWorldNormal;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vViewDir = cameraPosition - world.xyz;
  vWorldNormal = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, 1.0));
  vReflectUv = textureMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const surfaceFragment = /* glsl */ `
uniform sampler2D tDiffuse;
uniform sampler2D tDiffuseBlur;
uniform sampler2D tHeight;
uniform vec3 tint;
uniform float mirrorStrength;
uniform float mixBlur;
uniform float fresnelPower;
uniform float baseLift;
uniform float heightSharp;
uniform float heightSoft;
uniform float nearBlur;
uniform vec2 reflRes;
uniform float debugHeight;
varying vec4 vReflectUv;
varying vec3 vViewDir;
varying vec3 vWorldNormal;

void main() {
  vec2 uv = vReflectUv.xy / max(vReflectUv.w, 1e-5);
  uv = clamp(uv, vec2(0.001), vec2(0.999));
  float h = texture2D(tHeight, uv).r;

  if (debugHeight > 0.5) {
    gl_FragColor = vec4(h, h * 0.85, h * 0.55, 1.0);
    return;
  }

  vec3 sharp = texture2D(tDiffuse, uv).rgb;
  vec3 soft = texture2D(tDiffuseBlur, uv).rgb;

  // Extra wide sample when fully soft (tables stamped at h≈1) — kills stair-steps
  float tableSoft = smoothstep(0.75, 0.95, h);
  if (tableSoft > 0.01) {
    vec2 px = vec2(2.0 + 6.0 * tableSoft) / reflRes;
    vec3 wide = (
      soft
      + texture2D(tDiffuseBlur, clamp(uv + vec2(px.x, 0.0), 0.001, 0.999)).rgb
      + texture2D(tDiffuseBlur, clamp(uv - vec2(px.x, 0.0), 0.001, 0.999)).rgb
      + texture2D(tDiffuseBlur, clamp(uv + vec2(0.0, px.y), 0.001, 0.999)).rgb
      + texture2D(tDiffuseBlur, clamp(uv - vec2(0.0, px.y), 0.001, 0.999)).rgb
      + texture2D(tDiffuseBlur, clamp(uv + px, 0.001, 0.999)).rgb
      + texture2D(tDiffuseBlur, clamp(uv - px, 0.001, 0.999)).rgb
      + texture2D(tDiffuseBlur, clamp(uv + vec2(px.x, -px.y), 0.001, 0.999)).rgb
      + texture2D(tDiffuseBlur, clamp(uv + vec2(-px.x, px.y), 0.001, 0.999)).rgb
      + texture2D(tDiffuseBlur, clamp(uv + vec2(px.x * 2.0, 0.0), 0.001, 0.999)).rgb
      + texture2D(tDiffuseBlur, clamp(uv - vec2(px.x * 2.0, 0.0), 0.001, 0.999)).rgb
      + texture2D(tDiffuseBlur, clamp(uv + vec2(0.0, px.y * 2.0), 0.001, 0.999)).rgb
      + texture2D(tDiffuseBlur, clamp(uv - vec2(0.0, px.y * 2.0), 0.001, 0.999)).rgb
    ) * (1.0 / 13.0);
    soft = mix(soft, wide, tableSoft);
  }

  float blurAmt = mix(nearBlur, 1.0, smoothstep(heightSharp, heightSoft, h));
  blurAmt = max(blurAmt, tableSoft); // tables always fully soft
  blurAmt = clamp(blurAmt * mixBlur, 0.0, 1.0);
  vec3 refl = mix(sharp, soft, blurAmt);

  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(vViewDir);
  float fresnel = pow(1.0 - max(dot(N, V), 0.0), fresnelPower);
  float mirrorAmt = mix(mirrorStrength * 0.62, mirrorStrength, fresnel);

  vec3 base = tint * baseLift;
  vec3 color = mix(base, refl * tint, mirrorAmt);
  color = mix(color, refl, fresnel * 0.28);

  gl_FragColor = vec4(color, 1.0);
}
`;

function makeBlurMaterial() {
  return new ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
      direction: { value: new Vector2(1, 0) },
      resolution: { value: new Vector2(512, 512) },
    },
    vertexShader: blurVertex,
    fragmentShader: blurFragment,
  });
}

export class GlossyReflector extends Mesh {
  static instances = [];
  static bakeProxies = [];
  static hideWhileCapturing = [];
  static _updateDepth = 0;

  static setBakeProxies(meshes, hideWhileCapturing = []) {
    GlossyReflector.bakeProxies = meshes.filter(Boolean);
    GlossyReflector.hideWhileCapturing = hideWhileCapturing.filter(Boolean);
    for (const m of GlossyReflector.bakeProxies) m.visible = false;
  }

  /** Props stamped as max blur in the height map (tables) — color pass still renders them normally. */
  static softMeshes = [];

  static setSoftMeshes(meshes = []) {
    GlossyReflector.softMeshes = meshes.filter(Boolean);
  }

  constructor(geometry, options = {}) {
    const resolution = options.resolution ?? 512;
    const color = options.color !== undefined ? new Color(options.color) : new Color(0xd5e8ea);
    const maxDist = options.maxDist ?? options.maxHeight ?? 3.6;
    const kernels = options.blurKernels ?? [2.0, 4.0, 7.0, 11.0];

    const reflectorPlane = new Plane();
    const normal = new Vector3();
    const reflectorWorldPosition = new Vector3();
    const cameraWorldPosition = new Vector3();
    const rotationMatrix = new Matrix4();
    const lookAtPosition = new Vector3(0, 0, -1);
    const clipPlane = new Vector4();
    const view = new Vector3();
    const target = new Vector3();
    const q = new Vector4();
    const textureMatrix = new Matrix4();
    const virtualCamera = new PerspectiveCamera();
    virtualCamera.layers.set(0);

    const rtColor = {
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      type: HalfFloatType,
    };

    const fboSharp = new WebGLRenderTarget(resolution, resolution, {
      ...rtColor,
      depthBuffer: true,
    });
    fboSharp.depthTexture = new DepthTexture(resolution, resolution);
    fboSharp.depthTexture.format = DepthFormat;
    fboSharp.depthTexture.type = UnsignedShortType;

    const fboHeight = new WebGLRenderTarget(resolution, resolution, {
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      type: HalfFloatType,
    });
    const fboBlurA = new WebGLRenderTarget(resolution, resolution, rtColor);
    const fboBlurB = new WebGLRenderTarget(resolution, resolution, rtColor);

    const distMaterial = new ShaderMaterial({
      uniforms: {
        planePoint: { value: new Vector3() },
        planeNormal: { value: new Vector3(0, 1, 0) },
        maxDist: { value: maxDist },
      },
      vertexShader: distVertex,
      fragmentShader: distFragment,
    });

    // Forces full blur in the height map (used only for softMeshes / tables)
    const maxBlurMaterial = new ShaderMaterial({
      vertexShader: distVertex,
      fragmentShader: /* glsl */ `
        void main() { gl_FragColor = vec4(1.0); }
      `,
      depthTest: false,
      depthWrite: false,
    });

    const blurScene = new Scene();
    const blurCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const blurQuad = new Mesh(new PlaneGeometry(2, 2), makeBlurMaterial());
    blurScene.add(blurQuad);

    const material = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: fboSharp.texture },
        tDiffuseBlur: { value: fboBlurB.texture },
        tHeight: { value: fboHeight.texture },
        textureMatrix: { value: textureMatrix },
        tint: { value: color },
        mirrorStrength: { value: options.mirrorStrength ?? 0.48 },
        mixBlur: { value: options.mixBlur ?? 1.0 },
        fresnelPower: { value: options.fresnelPower ?? 2.6 },
        baseLift: { value: options.baseLift ?? 0.5 },
        heightSharp: { value: options.heightSharp ?? 0.32 },
        heightSoft: { value: options.heightSoft ?? 0.75 },
        nearBlur: { value: options.nearBlur ?? 0.0 },
        reflRes: { value: new Vector2(resolution, resolution) },
        debugHeight: { value: 0 },
      },
      vertexShader: surfaceVertex,
      fragmentShader: surfaceFragment,
    });

    super(geometry, material);
    this.isGlossyReflector = true;
    this.clipBias = options.clipBias ?? 0.003;
    GlossyReflector.instances.push(this);

    this.setDebugHeight = (on) => {
      material.uniforms.debugHeight.value = on ? 1 : 0;
    };

    this.setBaseLift = (v) => {
      material.uniforms.baseLift.value = v;
    };

    this.setTintHex = (hex) => {
      material.uniforms.tint.value.setHex(hex);
    };

    const scope = this;

    function setupVirtualCamera(camera) {
      if (camera.isArrayCamera && camera.cameras && camera.cameras.length) {
        camera = camera.cameras[0];
      }

      reflectorWorldPosition.setFromMatrixPosition(scope.matrixWorld);
      cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);
      rotationMatrix.extractRotation(scope.matrixWorld);

      normal.set(0, 0, 1);
      normal.applyMatrix4(rotationMatrix);

      view.subVectors(reflectorWorldPosition, cameraWorldPosition);
      if (view.dot(normal) > 0) return false;

      view.reflect(normal).negate();
      view.add(reflectorWorldPosition);

      rotationMatrix.extractRotation(camera.matrixWorld);
      lookAtPosition.set(0, 0, -1);
      lookAtPosition.applyMatrix4(rotationMatrix);
      lookAtPosition.add(cameraWorldPosition);

      target.subVectors(reflectorWorldPosition, lookAtPosition);
      target.reflect(normal).negate();
      target.add(reflectorWorldPosition);

      virtualCamera.position.copy(view);
      virtualCamera.up.set(0, 1, 0);
      virtualCamera.up.applyMatrix4(rotationMatrix);
      virtualCamera.up.reflect(normal);
      virtualCamera.lookAt(target);
      virtualCamera.near = camera.near;
      virtualCamera.far = camera.far;
      virtualCamera.updateMatrixWorld();
      virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

      textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
      textureMatrix.multiply(virtualCamera.projectionMatrix);
      textureMatrix.multiply(virtualCamera.matrixWorldInverse);
      textureMatrix.multiply(scope.matrixWorld);

      reflectorPlane.setFromNormalAndCoplanarPoint(normal, reflectorWorldPosition);
      reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse);
      clipPlane.set(
        reflectorPlane.normal.x,
        reflectorPlane.normal.y,
        reflectorPlane.normal.z,
        reflectorPlane.constant,
      );

      const projectionMatrix = virtualCamera.projectionMatrix;
      q.x = (Math.sign(clipPlane.x) + projectionMatrix.elements[8]) / projectionMatrix.elements[0];
      q.y = (Math.sign(clipPlane.y) + projectionMatrix.elements[9]) / projectionMatrix.elements[5];
      q.z = -1;
      q.w = (1 + projectionMatrix.elements[10]) / projectionMatrix.elements[14];
      clipPlane.multiplyScalar(2 / clipPlane.dot(q));
      projectionMatrix.elements[2] = clipPlane.x;
      projectionMatrix.elements[6] = clipPlane.y;
      projectionMatrix.elements[10] = clipPlane.z + 1 - scope.clipBias;
      projectionMatrix.elements[14] = clipPlane.w;
      return true;
    }

    function runBlur(renderer) {
      const u = blurQuad.material.uniforms;
      u.resolution.value.set(resolution, resolution);
      let srcTex = fboSharp.texture;
      for (const k of kernels) {
        u.tDiffuse.value = srcTex;
        u.direction.value.set(k, 0);
        renderer.setRenderTarget(fboBlurA);
        renderer.render(blurScene, blurCam);

        u.tDiffuse.value = fboBlurA.texture;
        u.direction.value.set(0, k);
        renderer.setRenderTarget(fboBlurB);
        renderer.render(blurScene, blurCam);

        srcTex = fboBlurB.texture;
      }
      u.tDiffuse.value = null;
    }

    this.onBeforeRender = function (renderer, scene, camera) {
      if (GlossyReflector._updateDepth > 0) return;
      if (!setupVirtualCamera(camera)) return;

      GlossyReflector._updateDepth++;

      const vis = [];
      for (const r of GlossyReflector.instances) {
        vis.push(r.visible);
        r.visible = false;
      }
      for (const m of GlossyReflector.hideWhileCapturing) m.visible = false;
      for (const m of GlossyReflector.bakeProxies) m.visible = true;

      material.uniforms.tDiffuse.value = null;
      material.uniforms.tDiffuseBlur.value = null;
      material.uniforms.tHeight.value = null;

      distMaterial.uniforms.planePoint.value.copy(reflectorWorldPosition);
      distMaterial.uniforms.planeNormal.value.copy(normal);
      distMaterial.uniforms.maxDist.value = maxDist;

      const softList = GlossyReflector.softMeshes;
      const softVis = softList.map((m) => m.visible);
      for (const m of softList) m.visible = false;

      const prevTarget = renderer.getRenderTarget();
      const prevXr = renderer.xr.enabled;
      const prevShadow = renderer.shadowMap.autoUpdate;
      const prevOverride = scene.overrideMaterial;
      const prevAutoClear = renderer.autoClear;
      renderer.xr.enabled = false;
      renderer.shadowMap.autoUpdate = false;
      renderer.autoClear = true;

      const prevBg = scene.background;
      scene.background = null;

      // Height: walls/room only (real distance blur)
      scene.overrideMaterial = distMaterial;
      renderer.setRenderTarget(fboHeight);
      renderer.state.buffers.depth.setMask(true);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(scene, virtualCamera);

      // Height: stamp tables as max blur (h=1). depthTest off + clearDepth so walls can't block.
      if (softList.length) {
        const childVis = scene.children.map((c) => c.visible);
        for (const c of scene.children) c.visible = false;
        for (const m of softList) {
          m.visible = true;
          m.traverse((o) => {
            o.visible = true;
          });
        }
        scene.overrideMaterial = maxBlurMaterial;
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(scene, virtualCamera);
        renderer.autoClear = true;
        for (let i = 0; i < scene.children.length; i++) {
          scene.children[i].visible = childVis[i];
        }
      }
      for (let i = 0; i < softList.length; i++) softList[i].visible = softVis[i];

      scene.background = prevBg;
      scene.overrideMaterial = prevOverride;

      renderer.setRenderTarget(fboSharp);
      renderer.state.buffers.depth.setMask(true);
      renderer.setClearColor(0xd8ecee, 1);
      renderer.clear();
      renderer.render(scene, virtualCamera);

      runBlur(renderer);

      material.uniforms.tDiffuse.value = fboSharp.texture;
      material.uniforms.tDiffuseBlur.value = fboBlurB.texture;
      material.uniforms.tHeight.value = fboHeight.texture;

      renderer.autoClear = prevAutoClear;
      renderer.xr.enabled = prevXr;
      renderer.shadowMap.autoUpdate = prevShadow;
      renderer.setRenderTarget(prevTarget);
      if (camera.viewport) renderer.state.viewport(camera.viewport);

      for (const m of GlossyReflector.bakeProxies) m.visible = false;
      for (const m of GlossyReflector.hideWhileCapturing) m.visible = true;
      for (let i = 0; i < GlossyReflector.instances.length; i++) {
        GlossyReflector.instances[i].visible = vis[i];
      }
      GlossyReflector._updateDepth--;
    };

    this.dispose = function () {
      const idx = GlossyReflector.instances.indexOf(this);
      if (idx >= 0) GlossyReflector.instances.splice(idx, 1);
      fboSharp.dispose();
      fboHeight.dispose();
      fboBlurA.dispose();
      fboBlurB.dispose();
      material.dispose();
      distMaterial.dispose();
      maxBlurMaterial.dispose();
      blurQuad.material.dispose();
      blurQuad.geometry.dispose();
    };
  }
}
