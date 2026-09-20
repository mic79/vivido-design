/**
 * Baked planar-atlas self+neighbor shadows for static skirmish scenery props.
 * Soft PCF atlases from bake-prop-self-shadows.mjs (extras.rtsPropSelfShadows).
 *
 * Unique meshes: stamp bake into COLOR_0 (reliable, still fully baked — no shadow maps).
 * Instanced rocks: sample atlas in-shader with mesh-local planar basis.
 */
export function sceneryNodeKey(obj, sceneRoot) {
  let n = obj;
  while (n.parent && n.parent !== sceneRoot) n = n.parent;
  return n.name || obj.name || '';
}

export function assignPropSelfShadowKeys(root) {
  if (!root) return;
  const perNode = new Map();
  root.updateMatrixWorld?.(true);
  root.traverse((obj) => {
    if (!obj.isMesh && !obj.isSkinnedMesh) return;
    const base = obj.userData?.rtsSourceNode || sceneryNodeKey(obj, root);
    const idx = perNode.get(base) || 0;
    perNode.set(base, idx + 1);
    obj.userData.rtsSelfShadowKey = idx === 0 ? base : `${base}#${idx}`;
  });
}

export function buildPropSelfShadowLookup(spec) {
  if (!spec || !Array.isArray(spec.cells)) return null;
  const byKey = new Map();
  for (const c of spec.cells) {
    if (!c || !c.key || !c.rect) continue;
    const hasLocal = c.origin && c.axisU && c.axisV;
    const hasWorld = c.originW && c.axisUW && c.axisVW;
    if (!hasLocal && !hasWorld) continue;
    byKey.set(c.key, {
      atlas: c.atlas | 0,
      rect: c.rect,
      origin: c.origin || c.originW,
      axisU: c.axisU || c.axisUW,
      axisV: c.axisV || c.axisVW,
      originW: c.originW || c.origin,
      axisUW: c.axisUW || c.axisU,
      axisVW: c.axisVW || c.axisV,
      shadowedFrac: typeof c.shadowedFrac === 'number' ? c.shadowedFrac : null,
      cell: c.cell | 0,
    });
  }
  return byKey;
}

/** Cache atlas pixels for CPU vertex stamping (flipY=false → v=0 at image bottom). */
const _atlasPixels = new WeakMap();

function getAtlasPixels(tex) {
  if (!tex?.image) return null;
  if (_atlasPixels.has(tex)) return _atlasPixels.get(tex);
  const img = tex.image;
  const w = img.width || img.videoWidth || 0;
  const h = img.height || img.videoHeight || 0;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;
  const packed = { w, h, data };
  _atlasPixels.set(tex, packed);
  return packed;
}

function sampleAtlasR(tex, u, v) {
  const pix = getAtlasPixels(tex);
  if (!pix) return 1;
  const uu = Math.min(1, Math.max(0, u));
  const vv = Math.min(1, Math.max(0, v));
  // flipY=false: v=0 → bottom row of image
  const x = Math.min(pix.w - 1, Math.max(0, (uu * (pix.w - 1) + 0.5) | 0));
  const y = Math.min(pix.h - 1, Math.max(0, ((1 - vv) * (pix.h - 1) + 0.5) | 0));
  return pix.data[(y * pix.w + x) * 4] / 255;
}

function planarShadowAt(pos, origin, axisU, axisV, rect, atlasTex) {
  const dx = pos.x - origin[0];
  const dy = pos.y - origin[1];
  const dz = pos.z - origin[2];
  let pu = dx * axisU[0] + dy * axisU[1] + dz * axisU[2];
  let pv = dx * axisV[0] + dy * axisV[1] + dz * axisV[2];
  pu = Math.min(1, Math.max(0, pu));
  pv = Math.min(1, Math.max(0, pv));
  const su = rect[0] + (rect[2] - rect[0]) * pu;
  const sv = rect[1] + (rect[3] - rect[1]) * pv;
  const sh = sampleAtlasR(atlasTex, su, sv);
  // Soft contact — never ink-blot (0.08 floor caused the black smudge).
  return 0.55 + 0.45 * sh;
}

/**
 * Stamp baked shadow into COLOR_0 only (soft multiply).
 * Do NOT also bind the atlas as lightMap — that double-darkened and smeared
 * into the black “ink blot” on platform decks (planar UV2 ≠ lightmap UVs).
 */
function stampBakedShadowVertexColors(mesh, cell, atlasTex, THREE, primaryMesh) {
  const pos = mesh.geometry?.attributes?.position;
  if (!pos || !atlasTex) return { ok: false, mean: 1 };
  mesh.updateMatrixWorld?.(true);
  primaryMesh?.updateMatrixWorld?.(true);
  const n = pos.count;
  const colors = new Float32Array(n * 3);
  let sum = 0;
  const p = new THREE.Vector3();
  const invPrimary =
    primaryMesh && primaryMesh !== mesh
      ? new THREE.Matrix4().copy(primaryMesh.matrixWorld).invert()
      : null;
  const origin = cell.origin;
  const axisU = cell.axisU;
  const axisV = cell.axisV;
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    if (invPrimary) {
      p.applyMatrix4(mesh.matrixWorld).applyMatrix4(invPrimary);
    }
    // Soft floor — never crush to ink-blot black.
    const s = planarShadowAt(p, origin, axisU, axisV, cell.rect, atlasTex);
    colors[i * 3] = s;
    colors[i * 3 + 1] = s;
    colors[i * 3 + 2] = s;
    sum += s;
  }
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return { ok: true, mean: sum / n, verts: n };
}

function enableBakedShadowMaterial(mat, _atlasTex) {
  if (!mat) return mat;
  const clone = mat.clone();
  clone.userData = {
    ...mat.userData,
    rtsPropSelfInstalled: true,
    rtsPropSelfVertex: true,
  };
  clone.vertexColors = true;
  // Keep metalness — don’t force-dielectric; soft vColor only on diffuse.
  // Strip any prior lightMap stamp from 0.5.105.
  if (clone.lightMap && clone.userData?.rtsPropSelfLightMap) {
    clone.lightMap = null;
    clone.lightMapIntensity = 1;
  }
  clone.needsUpdate = true;
  return clone;
}

function familyPrimaryKey(key) {
  if (!key) return key;
  return String(key).replace(/#\d+$/, '');
}

/** Pick a platform/pump family cell that has umbra but isn't flooded black. */
function pickFamilyShadowCell(fam, byKey, meshesByKey) {
  let best = null;
  let bestScore = Infinity;
  for (const [k, cell] of byKey) {
    if (familyPrimaryKey(k) !== fam) continue;
    const f = cell.shadowedFrac;
    if (f == null) continue;
    // Prefer ~25–40% shadowed (readable umbra, not crushed).
    if (f < 0.1 || f > 0.55) continue;
    const score = Math.abs(f - 0.3);
    const mesh = meshesByKey?.get(k);
    if (score < bestScore && mesh) {
      bestScore = score;
      best = { key: k, cell, mesh };
    }
  }
  if (best) return best;
  const fallback = byKey.get(fam);
  return fallback
    ? { key: fam, cell: fallback, mesh: meshesByKey?.get(fam) || null }
    : null;
}

/** Unique Mesh: stamp BAKED atlas into vertex colors (visible, not dynamic shadows). */
export function applyPropSelfShadowOnUniqueMesh(mesh, atlases, byKey, THREE, meshesByKey) {
  if (!mesh?.isMesh || !atlases?.length || !byKey || !THREE) return false;
  // Heroes use real / RGB lightmaps — never the planar ink-blot stamp.
  const probe =
    mesh.name ||
    mesh.userData?.rtsSourceNode ||
    mesh.userData?.rtsSelfShadowKey ||
    '';
  if (/circularplatform|pump_merged|cliff_185|cliff_131/i.test(probe)) return false;
  const key = mesh.userData?.rtsSelfShadowKey;
  if (!key) return false;
  const fam = familyPrimaryKey(key);
  let cell = byKey.get(key);
  let primaryMesh = null;
  if (/Platform|Pump|Circular/i.test(fam)) {
    const picked = pickFamilyShadowCell(fam, byKey, meshesByKey);
    if (picked) {
      cell = picked.cell;
      primaryMesh = picked.mesh;
    }
  }
  if (!cell) return false;
  const atlas = atlases[cell.atlas];
  if (!atlas) return false;

  const stamped = stampBakedShadowVertexColors(mesh, cell, atlas, THREE, primaryMesh);
  if (!stamped.ok) return false;

  if (Array.isArray(mesh.material)) {
    mesh.material = mesh.material.map((m) => enableBakedShadowMaterial(m, atlas));
  } else {
    mesh.material = enableBakedShadowMaterial(mesh.material, atlas);
  }
  mesh.userData.rtsPropSelfMean = stamped.mean;
  mesh.userData.rtsPropSelfCell = cell === byKey.get(key) ? key : fam;
  mesh.userData.rtsPropSelfInstalled = true;
  return true;
}

function installSelfShadowShader(mat, atlases, atlasIndex, instanced) {
  if (!mat || mat.userData?.rtsPropSelfInstalled) return;
  const list = Array.isArray(atlases) ? atlases.filter(Boolean) : atlases ? [atlases] : [];
  if (!list.length) return;
  const primary = list[Math.min(atlasIndex | 0, list.length - 1)] || list[0];

  mat.userData.rtsPropSelfInstalled = true;
  mat.userData.rtsPropSelfAtlas = primary;
  mat.userData.rtsPropSelfAtlases = list;
  if (!mat.userData.rtsPropSelfRect) {
    mat.userData.rtsPropSelfRect = { value: new Float32Array([0, 0, 1, 1]) };
  }
  if (!mat.userData.rtsPropSelfOrigin) {
    mat.userData.rtsPropSelfOrigin = { value: { x: 0, y: 0, z: 0 } };
  }
  if (!mat.userData.rtsPropSelfAxisU) {
    mat.userData.rtsPropSelfAxisU = { value: { x: 1, y: 0, z: 0 } };
  }
  if (!mat.userData.rtsPropSelfAxisV) {
    mat.userData.rtsPropSelfAxisV = { value: { x: 0, y: 0, z: 1 } };
  }
  if (!mat.userData.rtsPropSelfAtlasIndex) {
    mat.userData.rtsPropSelfAtlasIndex = { value: atlasIndex | 0 };
  }
  if (!mat.userData.rtsPropSelfStrength) {
    mat.userData.rtsPropSelfStrength = { value: 1 };
  }

  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () =>
    (prevKey ? prevKey() : '') + '|propSelfQ|' + list.length + (instanced ? 'I' : 'U');

  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev(shader, renderer);
    shader.uniforms.propSelfMap0 = { value: list[0] || primary };
    shader.uniforms.propSelfMap1 = { value: list[1] || list[0] || primary };
    shader.uniforms.propSelfMap2 = { value: list[2] || list[0] || primary };
    shader.uniforms.propSelfMap3 = { value: list[3] || list[0] || primary };
    shader.uniforms.propSelfRect = mat.userData.rtsPropSelfRect;
    shader.uniforms.propSelfOrigin = mat.userData.rtsPropSelfOrigin;
    shader.uniforms.propSelfAxisU = mat.userData.rtsPropSelfAxisU;
    shader.uniforms.propSelfAxisV = mat.userData.rtsPropSelfAxisV;
    shader.uniforms.propSelfAtlasIndex = mat.userData.rtsPropSelfAtlasIndex;
    shader.uniforms.propSelfStrength = mat.userData.rtsPropSelfStrength;
    mat.userData.rtsPropSelfShader = shader;

    if (instanced) {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute vec4 instanceSelfRect;
          attribute vec3 instanceSelfOrigin;
          attribute vec3 instanceSelfAxisU;
          attribute vec3 instanceSelfAxisV;
          attribute float instanceSelfAtlas;
          varying vec4 vPropSelfRect;
          varying vec3 vPropSelfOrigin;
          varying vec3 vPropSelfAxisU;
          varying vec3 vPropSelfAxisV;
          varying float vPropSelfAtlas;
          varying vec3 vPropSelfLocal;`
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          vPropSelfRect = instanceSelfRect;
          vPropSelfOrigin = instanceSelfOrigin;
          vPropSelfAxisU = instanceSelfAxisU;
          vPropSelfAxisV = instanceSelfAxisV;
          vPropSelfAtlas = instanceSelfAtlas;
          vPropSelfLocal = transformed;`
        );
    } else {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          varying vec3 vPropSelfLocal;`
        )
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          #include <begin_vertex>
          vPropSelfLocal = transformed;`
        );
    }

    const sampleFn = /* glsl */ `
      uniform sampler2D propSelfMap0;
      uniform sampler2D propSelfMap1;
      uniform sampler2D propSelfMap2;
      uniform sampler2D propSelfMap3;
      uniform vec4 propSelfRect;
      uniform vec3 propSelfOrigin;
      uniform vec3 propSelfAxisU;
      uniform vec3 propSelfAxisV;
      uniform float propSelfAtlasIndex;
      uniform float propSelfStrength;
      varying vec3 vPropSelfLocal;
      ${
        instanced
          ? `varying vec4 vPropSelfRect;
      varying vec3 vPropSelfOrigin;
      varying vec3 vPropSelfAxisU;
      varying vec3 vPropSelfAxisV;
      varying float vPropSelfAtlas;`
          : ''
      }
      float propSelfSample(vec2 uv, float ai) {
        if (ai < 0.5) return texture2D(propSelfMap0, uv).r;
        if (ai < 1.5) return texture2D(propSelfMap1, uv).r;
        if (ai < 2.5) return texture2D(propSelfMap2, uv).r;
        return texture2D(propSelfMap3, uv).r;
      }
      float propSelfMul() {
        vec4 r = ${instanced ? 'vPropSelfRect' : 'propSelfRect'};
        vec3 o = ${instanced ? 'vPropSelfOrigin' : 'propSelfOrigin'};
        vec3 au = ${instanced ? 'vPropSelfAxisU' : 'propSelfAxisU'};
        vec3 av = ${instanced ? 'vPropSelfAxisV' : 'propSelfAxisV'};
        float ai = ${instanced ? 'vPropSelfAtlas' : 'propSelfAtlasIndex'};
        vec3 d = vPropSelfLocal - o;
        vec2 puv = clamp(vec2(dot(d, au), dot(d, av)), 0.0, 1.0);
        vec2 suv = mix(r.xy, r.zw, puv);
        float sh = propSelfSample(suv, ai);
        float shaped = mix(0.38, 1.0, smoothstep(0.1, 0.92, sh));
        return mix(1.0, shaped, propSelfStrength);
      }
    `;

    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      `${sampleFn}\nvoid main() {`
    );

    const applyLit = /* glsl */ `
      {
        float shadowMul = propSelfMul();
        reflectedLight.directDiffuse *= shadowMul;
        reflectedLight.directSpecular *= shadowMul;
        reflectedLight.indirectDiffuse *= shadowMul;
        reflectedLight.indirectSpecular *= shadowMul;
      }`;

    if (shader.fragmentShader.includes('vec3 outgoingLight = reflectedLight.directDiffuse')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec3 outgoingLight = reflectedLight.directDiffuse',
        `${applyLit}\n	vec3 outgoingLight = reflectedLight.directDiffuse`
      );
    } else if (shader.fragmentShader.includes('#include <aomap_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>\n${applyLit}`
      );
    } else if (shader.fragmentShader.includes('#include <lights_fragment_end>')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>\n${applyLit}`
      );
    }
  };
  mat.needsUpdate = true;
}

function setBasisUniforms(mat, cell, THREE) {
  mat.userData.rtsPropSelfRect = {
    value: new Float32Array([cell.rect[0], cell.rect[1], cell.rect[2], cell.rect[3]]),
  };
  mat.userData.rtsPropSelfOrigin = {
    value: new THREE.Vector3(cell.origin[0], cell.origin[1], cell.origin[2]),
  };
  mat.userData.rtsPropSelfAxisU = {
    value: new THREE.Vector3(cell.axisU[0], cell.axisU[1], cell.axisU[2]),
  };
  mat.userData.rtsPropSelfAxisV = {
    value: new THREE.Vector3(cell.axisV[0], cell.axisV[1], cell.axisV[2]),
  };
  mat.userData.rtsPropSelfAtlasIndex = { value: cell.atlas | 0 };
  mat.userData.rtsPropSelfStrength = { value: 1 };
}

/** Shared material for InstancedMesh — multi-atlas + per-instance planar cells. */
export function preparePropSelfShadowInstancedMaterial(mat, atlases) {
  if (!mat || !atlases?.length) return mat;
  if (mat.userData?.rtsPropSelfInstalled && mat.userData?.rtsPropSelfInstanced) return mat;
  const out = mat.userData?.rtsPropSelfInstanced ? mat : mat.clone();
  out.userData = { ...mat.userData, rtsPropSelfInstanced: true };
  out.userData.rtsPropSelfRect = out.userData.rtsPropSelfRect || {
    value: new Float32Array([0, 0, 1, 1]),
  };
  out.userData.rtsPropSelfOrigin = out.userData.rtsPropSelfOrigin || {
    value: { x: 0, y: 0, z: 0 },
  };
  out.userData.rtsPropSelfAxisU = out.userData.rtsPropSelfAxisU || {
    value: { x: 1, y: 0, z: 0 },
  };
  out.userData.rtsPropSelfAxisV = out.userData.rtsPropSelfAxisV || {
    value: { x: 0, y: 0, z: 1 },
  };
  out.userData.rtsPropSelfAtlasIndex = out.userData.rtsPropSelfAtlasIndex || { value: 0 };
  out.userData.rtsPropSelfStrength = out.userData.rtsPropSelfStrength || { value: 1 };
  installSelfShadowShader(out, atlases, 0, true);
  return out;
}

export function fillInstanceSelfRects(instancedMesh, items, meshes, byKey, THREE) {
  if (!instancedMesh || !byKey || !THREE) return;
  const n = items.length;
  const rect = new Float32Array(n * 4);
  const origin = new Float32Array(n * 3);
  const axisU = new Float32Array(n * 3);
  const axisV = new Float32Array(n * 3);
  const atlas = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const mesh = meshes[i];
    const key = mesh?.userData?.rtsSelfShadowKey;
    const cell = key && byKey.get(key);
    const r = i * 4;
    const o = i * 3;
    if (cell) {
      rect[r] = cell.rect[0];
      rect[r + 1] = cell.rect[1];
      rect[r + 2] = cell.rect[2];
      rect[r + 3] = cell.rect[3];
      origin[o] = cell.origin[0];
      origin[o + 1] = cell.origin[1];
      origin[o + 2] = cell.origin[2];
      axisU[o] = cell.axisU[0];
      axisU[o + 1] = cell.axisU[1];
      axisU[o + 2] = cell.axisU[2];
      axisV[o] = cell.axisV[0];
      axisV[o + 1] = cell.axisV[1];
      axisV[o + 2] = cell.axisV[2];
      atlas[i] = cell.atlas | 0;
    } else {
      rect[r + 2] = 1;
      rect[r + 3] = 1;
      axisU[o] = 1;
      axisV[o + 2] = 1;
    }
  }
  const geo = instancedMesh.geometry.clone();
  geo.setAttribute('instanceSelfRect', new THREE.InstancedBufferAttribute(rect, 4));
  geo.setAttribute('instanceSelfOrigin', new THREE.InstancedBufferAttribute(origin, 3));
  geo.setAttribute('instanceSelfAxisU', new THREE.InstancedBufferAttribute(axisU, 3));
  geo.setAttribute('instanceSelfAxisV', new THREE.InstancedBufferAttribute(axisV, 3));
  geo.setAttribute('instanceSelfAtlas', new THREE.InstancedBufferAttribute(atlas, 1));
  instancedMesh.geometry = geo;
}
