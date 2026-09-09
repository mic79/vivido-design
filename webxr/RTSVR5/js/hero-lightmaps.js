/**
 * Apply baked hero RGB lightmaps (extras.rtsHeroRgbLightmaps).
 * Soft sun occlusion — no dynamic scenery shadows.
 *
 * MeshPhysical specular/IBL washed the bake to flat. Heroes use Lambert ×
 * albedo × COLOR_0 occlusion (same class as moon rock cookies).
 */
export function heroFamilyKey(name) {
  let n = String(name || '').replace(/^SM_/i, '');
  return n.replace(/#\d+$/, '');
}

export function isHeroPropName(name) {
  return /circularplatform|pump_merged|cliff_185|cliff_131/i.test(name || '');
}

export function buildHeroLightmapLookup(spec) {
  if (!spec || !Array.isArray(spec.maps)) return null;
  const byKey = new Map();
  for (const m of spec.maps) {
    if (!m?.key || m.textureIndex == null) continue;
    byKey.set(heroFamilyKey(m.key), m);
    for (const n of m.meshNames || []) byKey.set(heroFamilyKey(n), m);
  }
  return byKey;
}

function setPlanarUv2FromWorld(mesh, bbox, THREE) {
  const geometry = mesh?.geometry;
  if (!geometry?.attributes?.position || !bbox || !THREE) return null;
  mesh.updateMatrixWorld?.(true);
  const pos = geometry.attributes.position;
  const uv2 = new Float32Array(pos.count * 2);
  const minX = bbox.min[0];
  const minZ = bbox.min[2];
  const sx = bbox.max[0] - minX || 1;
  const sz = bbox.max[2] - minZ || 1;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    uv2[i * 2] = (v.x - minX) / sx;
    uv2[i * 2 + 1] = (v.z - minZ) / sz;
  }
  const attr = new THREE.BufferAttribute(uv2, 2);
  geometry.setAttribute('uv2', attr);
  return attr;
}

function ensureLightmapUv(mesh, entry, THREE) {
  const geometry = mesh?.geometry;
  if (!geometry) return null;
  if (entry.layout === 'planar-xz' && entry.bbox) {
    return setPlanarUv2FromWorld(mesh, entry.bbox, THREE);
  }
  const texCoord = entry.texCoord | 0;
  const src =
    texCoord === 2
      ? geometry.attributes.uv2 || geometry.attributes.uv1 || geometry.attributes.uv
      : texCoord === 1
        ? geometry.attributes.uv1 || geometry.attributes.uv2 || geometry.attributes.uv
        : geometry.attributes.uv || geometry.attributes.uv1;
  if (!src) return null;
  geometry.setAttribute('uv2', src.clone ? src.clone() : src);
  return geometry.attributes.uv2;
}

const _pixCache = new WeakMap();

function atlasPixels(tex) {
  if (!tex?.image) return null;
  if (_pixCache.has(tex)) return _pixCache.get(tex);
  const img = tex.image;
  const w = img.width || img.videoWidth || 0;
  const h = img.height || img.videoHeight || 0;
  if (!w || !h) return null;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const packed = { w, h, data: ctx.getImageData(0, 0, w, h).data };
  _pixCache.set(tex, packed);
  return packed;
}

function sampleLm(tex, u, v) {
  const pix = atlasPixels(tex);
  if (!pix) return 1;
  const uu = Math.min(1, Math.max(0, u));
  const vv = Math.min(1, Math.max(0, v));
  const x = Math.min(pix.w - 1, Math.max(0, (uu * (pix.w - 1) + 0.5) | 0));
  // flipY=false: v=0 → image bottom
  const y = Math.min(pix.h - 1, Math.max(0, ((1 - vv) * (pix.h - 1) + 0.5) | 0));
  return pix.data[(y * pix.w + x) * 4] / 255;
}

function stampVertexOcclusion(mesh, uvAttr, tex, THREE) {
  const pos = mesh.geometry?.attributes?.position;
  if (!pos || !uvAttr || !tex) return false;
  const n = pos.count;
  const colors = new Float32Array(n * 3);
  let sum = 0;
  let dark = 0;
  for (let i = 0; i < n; i++) {
    // Bake already floors at AMB (~0.52). Square for readable umbra on deck.
    const s = sampleLm(tex, uvAttr.getX(i), uvAttr.getY(i));
    const v = Math.min(1, Math.max(0.32, s * s));
    colors[i * 3] = v;
    colors[i * 3 + 1] = v;
    colors[i * 3 + 2] = v;
    sum += v;
    if (v < 0.85) dark++;
  }
  mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  mesh.userData.rtsHeroLmStamp = { mean: sum / n, darkFrac: dark / n };
  return sum / n;
}

/**
 * Apply hero RGB LM to a unique Mesh. Returns true if applied.
 */
export function applyHeroRgbLightmap(mesh, atlases, byKey, THREE) {
  if (!mesh?.isMesh || !byKey || !atlases?.length || !THREE) return false;
  const names = [
    mesh.name,
    mesh.parent?.name,
    mesh.userData?.rtsSourceNode,
    mesh.userData?.rtsSelfShadowKey,
  ];
  let entry = null;
  for (const n of names) {
    if (!n) continue;
    entry = byKey.get(heroFamilyKey(n));
    if (entry) break;
    if (!isHeroPropName(n)) continue;
    for (const [, e] of byKey) {
      const match =
        (/platform/i.test(n) && /platform/i.test(e.key)) ||
        (/pump/i.test(n) && /pump/i.test(e.key)) ||
        (/cliff_185/i.test(n) && /cliff_185/i.test(e.key)) ||
        (/cliff_131/i.test(n) && /cliff_131/i.test(e.key));
      if (match) {
        entry = e;
        break;
      }
    }
    if (entry) break;
  }
  if (!entry) return false;
  const tex = atlases[entry.textureIndex];
  if (!tex) return false;

  const uvAttr = ensureLightmapUv(mesh, entry, THREE);
  if ('channel' in tex) tex.channel = 2;
  const mean = stampVertexOcclusion(mesh, uvAttr || mesh.geometry.attributes.uv2, tex, THREE);

  const applyMat = (mat) => {
    if (!mat || mat.userData?.rtsHeroLm) return mat;
    // Unlit × albedo × COLOR_0 occlusion. Neon debug proved vertex colors bind;
    // MeshPhysical/Lambert lighting washed the umbra back to flat.
    const basic = new THREE.MeshBasicMaterial();
    basic.name = (mat.name || 'hero') + '_heroLm';
    basic.map = mat.map || null;
    if (mat.color) basic.color.copy(mat.color);
    else basic.color.setRGB(1, 1, 1);
    basic.vertexColors = true;
    basic.side = mat.side ?? THREE.FrontSide;
    basic.transparent = !!mat.transparent;
    basic.opacity = mat.opacity ?? 1;
    basic.alphaTest = mat.alphaTest || 0;
    basic.toneMapped = true;
    basic.userData = { ...mat.userData, rtsHeroLm: true, rtsHeroLmMean: mean };
    basic.needsUpdate = true;
    return basic;
  };

  if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(applyMat);
  else mesh.material = applyMat(mesh.material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.rtsHeroLmApplied = true;
  return true;
}
