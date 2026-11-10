/**
 * Yaw-baked ground cookies + mesh self-shadow for RTSVR5.
 * Atlases from `scripts/bake-unit-yaw-shadows.mjs` → assets/shadows/yaw/
 *
 * Visual contract: identical to the rock lightmap in `baked-moon.js` —
 * ground colour is MULTIPLIED by the atlas value (white = lit, `dark` = umbra),
 * baked with the same `sunDir` the rock LM used. No alpha quads, no extra tint.
 */
import * as Perf from './perf-profiler.js';

const MANIFEST_URL = 'assets/shadows/yaw/manifest.json';
const BASE = 'assets/shadows/yaw/';

/** @type {null | any} */
let _state = null;

function yawToFrame(yaw, frames) {
  const n = Math.max(1, frames | 0);
  let a = yaw || 0;
  a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return Math.round((a / (Math.PI * 2)) * n) % n;
}

export function yawBakedShadowsReady() {
  return !!(_state?.ready && _state.byType?.size);
}

export function getYawBakedShadowsEnabled() {
  return !!(_state?.ready && _state.enabled);
}

export function setYawBakedShadowsEnabled(on) {
  if (!_state) return false;
  _state.enabled = !!on;
  for (const mesh of _state.cookieMeshes.values()) {
    mesh.visible = _state.enabled && mesh.count > 0;
  }
  for (const u of _state.strengthUniforms) u.value = _state.enabled ? 1 : 0;
  return _state.enabled;
}

function setupTex(tex, THREE) {
  if ('colorSpace' in tex) tex.colorSpace = THREE.NoColorSpace || THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
}

/**
 * Load atlases + build cookie InstancedMeshes. Call after scene3D exists.
 */
export async function initYawBakedShadows(scene3D, THREE, opts = {}) {
  if (!scene3D || !THREE) return false;
  if (_state?.ready) return true;
  if (typeof Perf.shouldLoadGltfAssets === 'function' && !Perf.shouldLoadGltfAssets()) {
    return false;
  }

  const bust = opts.cacheBust ? `?v=${opts.cacheBust}` : '';
  let manifest;
  try {
    const res = await fetch(MANIFEST_URL + bust);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    console.warn('[yaw-shadows] no manifest', err?.message || err);
    return false;
  }

  const loader = new THREE.TextureLoader();
  const byType = new Map();
  const cookieMeshes = new Map();
  const maxInst = opts.maxInstances || 256;

  for (const e of manifest.entries || []) {
    if (!e.ground || !e.types?.length) continue;
    let groundTex;
    let selfTex;
    try {
      groundTex = await loader.loadAsync(BASE + e.ground + bust);
      selfTex = await loader.loadAsync(BASE + e.self + bust);
    } catch (err) {
      console.warn('[yaw-shadows] tex fail', e.id, err);
      continue;
    }
    setupTex(groundTex, THREE);
    setupTex(selfTex, THREE);

    const atlas = {
      id: e.id,
      frames: e.frames || 1,
      cell: e.cell || 64,
      groundHalfM: e.groundHalfM || 2,
      dark: e.dark ?? manifest.dark ?? 0.32,
      groundTex,
      selfTex,
    };
    for (const t of e.types) byType.set(t, atlas);

    if (!cookieMeshes.has(e.id)) {
      const geo = new THREE.PlaneGeometry(2, 2);
      geo.rotateX(-Math.PI / 2);
      geo.setAttribute(
        'instanceFrame',
        new THREE.InstancedBufferAttribute(new Float32Array(maxInst), 1)
      );

      const mat = new THREE.ShaderMaterial({
        // dst = dst * src — same math as `diffuseColor.rgb *= rockShadowMap` on the moon.
        blending: THREE.MultiplyBlending,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
        uniforms: {
          map: { value: groundTex },
          frames: { value: atlas.frames },
        },
        vertexShader: /* glsl */ `
          attribute float instanceFrame;
          varying vec2 vUv;
          uniform float frames;
          void main() {
            float f = instanceFrame;
            float u0 = f / max(frames, 1.0);
            float u1 = (f + 1.0) / max(frames, 1.0);
            // Plane v=0 → world +Z after rotateX(-90); atlas umbra is at PNG bottom
            // (high v with flipY=false). Flip V so the cast lands on +Z like the rock LM.
            vUv = vec2(mix(u0, u1, uv.x), 1.0 - uv.y);
            vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D map;
          varying vec2 vUv;
          void main() {
            float lum = texture2D(map, vUv).r;
            if (lum > 0.985) discard;
            gl_FragColor = vec4(vec3(lum), 1.0);
          }
        `,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, maxInst);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = `yawCookie_${e.id}`;
      mesh.renderOrder = 2;
      scene3D.add(mesh);
      cookieMeshes.set(e.id, mesh);
      atlas._cookieMesh = mesh;
      atlas._frameAttr = mesh.geometry.getAttribute('instanceFrame');
    } else {
      atlas._cookieMesh = cookieMeshes.get(e.id);
      atlas._frameAttr = atlas._cookieMesh.geometry.getAttribute('instanceFrame');
    }
  }

  if (!byType.size) {
    console.warn('[yaw-shadows] empty');
    return false;
  }

  _state = {
    ready: true,
    enabled: true,
    byType,
    cookieMeshes,
    sun: manifest.sun,
    sunDir: manifest.sunDir || null,
    dark: manifest.dark ?? 0.32,
    maxInst,
    strengthUniforms: new Set(),
  };
  console.log('[yaw-shadows] ready', byType.size, 'types', cookieMeshes.size, 'atlases');
  return true;
}

/* ---------------------------------------------------------------------------
 * Self-shadow: multiply the mesh albedo by the UV-space atlas cell for its yaw
 * frame. `instanced` reads the frame from a per-instance attribute; buildings
 * (one material per clone) use a uniform.
 * ------------------------------------------------------------------------- */
function installSelfShadow(mat, atlas, instanced) {
  if (!mat || mat.userData?.yawSelfInstalled) return;
  mat.userData.yawSelfInstalled = true;
  mat.userData.yawSelfAtlas = atlas;
  if (!mat.userData.yawSelfFrame) mat.userData.yawSelfFrame = { value: 0 };
  const strength = { value: _state.enabled ? 1 : 0 };
  mat.userData.yawSelfStrength = strength;
  _state.strengthUniforms.add(strength);

  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () =>
    (prevKey ? prevKey() : '') + '|yawSelf|' + atlas.id + (instanced ? 'I' : 'U');

  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev(shader, renderer);
    shader.uniforms.yawSelfMap = { value: atlas.selfTex };
    shader.uniforms.yawSelfFrames = { value: atlas.frames };
    shader.uniforms.yawSelfFrame = mat.userData.yawSelfFrame;
    shader.uniforms.yawSelfStrength = strength;
    mat.userData.yawSelfShader = shader;

    if (instanced) {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute float instanceFrame;
          varying float vYawSelfFrame;`
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          vYawSelfFrame = instanceFrame;`
        );
    }

    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      /* glsl */ `
      uniform sampler2D yawSelfMap;
      uniform float yawSelfFrames;
      uniform float yawSelfFrame;
      uniform float yawSelfStrength;
      ${instanced ? 'varying float vYawSelfFrame;' : ''}
      void main() {`
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
      #include <map_fragment>
      #ifdef USE_UV
      {
        float fr = max(yawSelfFrames, 1.0);
        float f = floor(${instanced ? 'vYawSelfFrame' : 'yawSelfFrame'} + 0.5);
        float u0 = f / fr;
        float u1 = (f + 1.0) / fr;
        vec2 suv = vec2(mix(u0, u1, vMapUv.x), vMapUv.y);
        float sh = texture2D(yawSelfMap, suv).r;
        diffuseColor.rgb *= mix(1.0, sh, yawSelfStrength);
      }
      #endif`
    );
  };
  mat.needsUpdate = true;
}

export function installYawSelfShadowOnInstancedMesh(mesh, unitType, THREE) {
  if (!_state?.ready || !mesh?.material || !THREE) return;
  const atlas = _state.byType.get(unitType);
  if (!atlas?.selfTex) return;
  const n = mesh.instanceMatrix.count;
  if (!mesh.geometry.getAttribute('instanceFrame')) {
    mesh.geometry.setAttribute(
      'instanceFrame',
      new THREE.InstancedBufferAttribute(new Float32Array(n), 1)
    );
  }
  installSelfShadow(mesh.material, atlas, true);
}

export function writeUnitInstanceYawFrame(mesh, slot, yaw, unitType) {
  if (!_state?.ready || !mesh) return;
  const atlas = _state.byType.get(unitType);
  if (!atlas) return;
  const fa = mesh.geometry.getAttribute('instanceFrame');
  if (!fa) return;
  fa.setX(slot, yawToFrame(yaw, atlas.frames));
  fa.needsUpdate = true;
}

export function installYawSelfShadowOnMaterial(material, unitType) {
  if (!_state?.ready || !material) return;
  const atlas = _state.byType.get(unitType);
  if (!atlas?.selfTex) return;
  installSelfShadow(material, atlas, false);
}

export function syncYawSelfShadowOnObject3D(root, type, yaw) {
  if (!_state?.ready || !root) return;
  const atlas = _state.byType.get(type);
  if (!atlas) return;
  const f = yawToFrame(yaw, atlas.frames);
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (!m.userData?.yawSelfInstalled) installSelfShadow(m, atlas, false);
      if (m.userData.yawSelfFrame) m.userData.yawSelfFrame.value = f;
    }
  });
}

/**
 * Sync ground cookies. Pass sampleY(x,z) and entity visibility via u._renderVisible.
 */
export function updateYawBakedShadowCookies(State, sampleY, THREE) {
  if (!_state?.ready) return;
  if (!_state.enabled) {
    for (const m of _state.cookieMeshes.values()) {
      m.count = 0;
      m.visible = false;
    }
    return;
  }

  const counts = new Map();
  for (const id of _state.cookieMeshes.keys()) counts.set(id, 0);

  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _mat4 = new THREE.Matrix4();

  const place = (type, x, z, yaw) => {
    const atlas = _state.byType.get(type);
    if (!atlas) return;
    const mesh = atlas._cookieMesh;
    if (!mesh) return;
    let slot = counts.get(atlas.id) || 0;
    if (slot >= mesh.instanceMatrix.count) return;
    const y = sampleY(x, z) + 0.08;
    const half = atlas.groundHalfM;
    // Atlas cells are captured top-down in WORLD XZ with the fixed rock sun; the
    // yaw frame already encodes the unit's heading. Never rotate the quad.
    _quat.identity();
    _mat4.compose(_pos.set(x, y, z), _quat, _scale.set(half, 1, half));
    mesh.setMatrixAt(slot, _mat4);
    const fa = atlas._frameAttr;
    if (fa) fa.setX(slot, yawToFrame(yaw, atlas.frames));
    counts.set(atlas.id, slot + 1);
  };

  State.units.forEach((u) => {
    if (u.hp <= 0) return;
    if (u._renderVisible === false) return;
    place(u.type, u.x, u.z, u.rotation || 0);
  });
  State.buildings.forEach((b) => {
    if (b.hp <= 0) return;
    if (b._renderDrawn === false) return;
    place(b.type, b.x, b.z, b.rotation || 0);
  });

  for (const [id, mesh] of _state.cookieMeshes) {
    const n = counts.get(id) || 0;
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    const fa = mesh.geometry.getAttribute('instanceFrame');
    if (fa) fa.needsUpdate = true;
    mesh.visible = n > 0;
  }
}

/** When yaw baked is active, suppress expensive PCF casting from gameplay meshes. */
export function applyYawShadowCasterPolicy(root, preferBaked) {
  if (!root || !preferBaked || !_state?.ready || !_state.enabled) return;
  root.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (/^yawCookie_/.test(o.name || '')) return;
    if (/^units_|^buildings_|^hq_|^barracks_|^warFactory_|^refinery_/.test(o.name || '')) {
      o.castShadow = false;
    }
  });
}
