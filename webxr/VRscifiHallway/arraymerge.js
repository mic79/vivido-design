/**
 * Texture-array mega-material merge (#merge2).
 *
 * Diagnosis (on-device Quest 3, 2026-08-03): ~290 separate-material draws cost
 * ~15ms CPU even with no geometry; one-material draws with FULL geometry cost
 * 13.3ms. Fix: collapse eligible materials into a few "mega materials" whose
 * textures live in 2D array textures (every map texture is 1024x1024 KTX2 with
 * 11 mips), pick the layer per-vertex, and merge geometry per (cell x group).
 * Same texels, same shading math => pixel-identical; draws drop ~10x.
 *
 * Eligible: opaque, non-emissive, no alphaTest, single material, indexed
 * geometry. Transparent/emissive/alpha-tested meshes stay untouched (sorting,
 * UV panners). Any precondition failure bails out and leaves the scene as-is.
 */
export function buildArrayMerge({ THREE, scene, root, mapMeshes, anisotropy = 8 }) {
  const groups = new Map(); // key -> { std, side, items: [{ mesh, index }] }
  const excluded = new Set();

  const texOk = (t) =>
    !t || (t.isCompressedTexture && t.image?.width === 1024 && t.image?.height === 1024
      && Array.isArray(t.mipmaps) && t.mipmaps.length === 11);

  for (let i = 0; i < mapMeshes.length; i++) {
    const mesh = mapMeshes[i];
    const m = mesh.material;
    const g = mesh.geometry;
    let ok = m && !Array.isArray(m) && g?.index && g.attributes.position && g.attributes.normal
      && !m.transparent && !(m.alphaTest > 0) && !m.emissiveMap && !m.alphaMap && !m.aoMap
      && (m.isMeshStandardMaterial || m.isMeshBasicMaterial)
      && !(m.emissive && (m.emissive.r > 0 || m.emissive.g > 0 || m.emissive.b > 0));
    if (ok && m.isMeshStandardMaterial) {
      ok = texOk(m.map) && texOk(m.normalMap) && texOk(m.metalnessMap) && texOk(m.roughnessMap)
        && (m.metalnessMap === m.roughnessMap || !m.metalnessMap || !m.roughnessMap);
    } else if (ok) {
      ok = texOk(m.map);
    }
    if (!ok) { excluded.add(i); continue; }
    const key = (m.isMeshStandardMaterial ? 'std' : 'basic') + '|' + m.side;
    if (!groups.has(key)) groups.set(key, { std: m.isMeshStandardMaterial, side: m.side, items: [] });
    groups.get(key).items.push({ mesh, index: i });
  }

  // ---- layer registries ----
  const slots = { base: new Map(), mr: new Map(), normal: new Map() };
  const layerOf = (slot, tex) => {
    if (!tex) return -1;
    const reg = slots[slot];
    if (!reg.has(tex)) reg.set(tex, reg.size);
    return reg.get(tex);
  };
  for (const grp of groups.values()) {
    for (const { mesh } of grp.items) {
      const m = mesh.material;
      layerOf('base', m.map);
      if (grp.std) {
        layerOf('mr', m.metalnessMap || m.roughnessMap);
        layerOf('normal', m.normalMap);
      }
    }
  }

  // ---- assemble compressed array textures ----
  function buildArray(reg, srgb) {
    if (reg.size === 0) return null;
    const texes = [...reg.keys()];
    const first = texes[0];
    const fmt = first.format;
    for (const t of texes) {
      if (t.format !== fmt || t.mipmaps.length !== 11) return undefined; // abort signal
    }
    const mips = [];
    for (let L = 0; L < 11; L++) {
      const per = texes.map((t) => t.mipmaps[L].data);
      const len = per[0].length;
      if (per.some((d) => d.length !== len)) return undefined;
      const data = new Uint8Array(len * texes.length);
      for (let j = 0; j < texes.length; j++) data.set(per[j], j * len);
      mips.push({ data, width: first.mipmaps[L].width, height: first.mipmaps[L].height });
    }
    const arr = new THREE.CompressedArrayTexture(mips, 1024, 1024, texes.length, fmt);
    arr.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    arr.minFilter = THREE.LinearMipmapLinearFilter;
    arr.magFilter = THREE.LinearFilter;
    arr.wrapS = THREE.RepeatWrapping;
    arr.wrapT = THREE.RepeatWrapping;
    arr.anisotropy = anisotropy;
    arr.generateMipmaps = false;
    arr.needsUpdate = true;
    return arr;
  }
  const baseArr = buildArray(slots.base, true);
  const mrArr = buildArray(slots.mr, false);
  const normArr = buildArray(slots.normal, false);
  // Match ref sampler state exactly: tuneMaterials caps MR anisotropy at 4.
  if (mrArr) mrArr.anisotropy = Math.min(4, anisotropy);
  if (baseArr === undefined || mrArr === undefined || normArr === undefined) {
    console.warn('arraymerge: texture format/mip mismatch — bailing out');
    return null;
  }

  // ---- shader patches ----
  const VERT_DECL = /* glsl */ `
attribute vec4 aLay;   // baseLayer, mrLayer, normalLayer, flags(b0 base,b1 mr,b2 normal)
attribute vec4 aPar;   // metallicFactor, roughnessFactor, unused, unused (u16 norm)
attribute vec4 aTint;  // baseColorFactor rgba (u16 norm, linear)
varying vec2 vAUv;
varying vec4 vLayV;
varying vec4 vParV;
varying vec4 vTintV;
`;
  const VERT_ASSIGN = /* glsl */ `
vAUv = uv;
vLayV = aLay;
vParV = aPar;
vTintV = aTint;
`;
  const FRAG_DECL = /* glsl */ `
uniform highp sampler2DArray baseArr;
#ifdef MEGA_STD
uniform highp sampler2DArray mrArr;
uniform highp sampler2DArray normArr;
#endif
varying vec2 vAUv;
varying vec4 vLayV;
varying vec4 vParV;
varying vec4 vTintV;
`;
  const FRAG_MAP = /* glsl */ `
{
  float flags_ = floor( vLayV.w + 0.5 );
  float hasBase_ = mod( flags_, 2.0 );
  vec4 texel_ = texture( baseArr, vec3( vAUv, floor( vLayV.x + 0.5 ) ) );
  diffuseColor *= vTintV * mix( vec4( 1.0 ), texel_, hasBase_ );
}
`;
  const FRAG_METALNESS = /* glsl */ `
float metalnessFactor = vParV.x;
{
  float hasMR_ = mod( floor( floor( vLayV.w + 0.5 ) / 2.0 ), 2.0 );
  vec4 mrTexel_ = texture( mrArr, vec3( vAUv, floor( vLayV.y + 0.5 ) ) );
  metalnessFactor *= mix( 1.0, mrTexel_.b, hasMR_ );
}
`;
  const FRAG_ROUGHNESS = /* glsl */ `
float roughnessFactor = vParV.y;
{
  float hasMR_ = mod( floor( floor( vLayV.w + 0.5 ) / 2.0 ), 2.0 );
  vec4 mrTexel_ = texture( mrArr, vec3( vAUv, floor( vLayV.y + 0.5 ) ) );
  roughnessFactor *= mix( 1.0, mrTexel_.g, hasMR_ );
}
`;
  // Exact copy of three r170 getTangentFrame (normal_pars_fragment) — derivative
  // tangents, same math as the original per-material normal mapping path.
  const FRAG_TANGENT_FN = /* glsl */ `
mat3 aGetTangentFrame( vec3 eye_pos, vec3 surf_norm, vec2 uv ) {
  vec3 q0 = dFdx( eye_pos.xyz );
  vec3 q1 = dFdy( eye_pos.xyz );
  vec2 st0 = dFdx( uv.st );
  vec2 st1 = dFdy( uv.st );
  vec3 N = surf_norm;
  vec3 q1perp = cross( q1, N );
  vec3 q0perp = cross( N, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float scale = ( det == 0.0 ) ? 0.0 : inversesqrt( det );
  return mat3( T * scale, B * scale, N );
}
`;
  const FRAG_NORMAL = /* glsl */ `
#include <normal_fragment_maps>
{
  float hasN_ = floor( floor( vLayV.w + 0.5 ) / 4.0 );
  mat3 tbn_ = aGetTangentFrame( - vViewPosition, normal, vAUv );
  #if defined( DOUBLE_SIDED ) && ! defined( FLAT_SHADED )
    tbn_[0] *= faceDirection;
    tbn_[1] *= faceDirection;
  #endif
  vec3 mapN_ = texture( normArr, vec3( vAUv, floor( vLayV.z + 0.5 ) ) ).xyz * 2.0 - 1.0;
  vec3 pn_ = normalize( tbn_ * mapN_ );
  normal = normalize( mix( normal, pn_, hasN_ ) );
}
`;
  // questMetalBakeV2 (must match preview5's patchMetalBakedIrradiance exactly)
  const FRAG_COLOR_IRR = /* glsl */ `
#ifdef USE_COLOR
	vec3 bakedIrradiance = vColor.rgb;
#else
	vec3 bakedIrradiance = vec3( 0.0 );
#endif
`;
  const FRAG_LIGHTMAPS_IRR = /* glsl */ `
#include <lights_fragment_maps>
#if defined( RE_IndirectDiffuse )
	irradiance += bakedIrradiance * PI;
#endif
`;

  function makeMega(std, side) {
    const mat = std
      ? new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 1, side })
      : new THREE.MeshBasicMaterial({ vertexColors: true, side });
    mat.toneMapped = true;
    mat.name = (std ? 'megaStd' : 'megaBasic') + '_' + side;
    if (std) mat.envMapIntensity = 1; // per-vertex multiplier applied in shader
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.baseArr = { value: baseArr };
      if (std) {
        shader.uniforms.mrArr = { value: mrArr };
        shader.uniforms.normArr = { value: normArr };
      }
      shader.defines = shader.defines || {};
      if (std) shader.defines.MEGA_STD = '';
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + VERT_DECL)
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n' + VERT_ASSIGN);
      let f = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FRAG_DECL + (std ? FRAG_TANGENT_FN : ''))
        .replace('#include <map_fragment>', FRAG_MAP);
      if (std) {
        f = f
          .replace('#include <metalnessmap_fragment>', FRAG_METALNESS)
          .replace('#include <roughnessmap_fragment>', FRAG_ROUGHNESS)
          .replace('#include <normal_fragment_maps>', FRAG_NORMAL)
          .replace('#include <color_fragment>', FRAG_COLOR_IRR)
          .replace('#include <lights_fragment_maps>', FRAG_LIGHTMAPS_IRR);
        // NOTE: per-material envMapIntensity is NOT forwarded per-vertex.
        // Measured 2026-08-03: setting every ref material's envMapIntensity to 5
        // changes 0.00 pixels — the tiers in applyQuestMaterials are inert with
        // scene.environment in r170. Forwarding them made merge2 28% brighter.
      }
      shader.fragmentShader = f;
    };
    mat.customProgramCacheKey = () => 'mega_' + (std ? 'std' : 'basic') + '_' + side;
    return mat;
  }

  // ---- geometry merge per (cell x group) ----
  const cellOf = (mesh) => {
    let n = mesh;
    while (n && n.parent && n.parent !== root) n = n.parent;
    return n?.name || 'root';
  };
  const nrm3 = new THREE.Matrix3();
  const v3 = new THREE.Vector3();
  const blobs = [];
  const megaMats = new Map();

  // Recursive median split keeps blobs spatially tight so frustum + PVS still
  // cull triangles (single whole-cell blobs pushed views past the 2.5M gate).
  const _c = new THREE.Vector3();
  const centroidOfMesh = (mesh) => {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    mesh.geometry.boundingBox.getCenter(_c).applyMatrix4(mesh.matrixWorld);
    return _c.clone();
  };
  function splitItems(items) {
    if (items.length <= 8) return [items];
    const bb = new THREE.Box3();
    for (const it of items) bb.expandByPoint(it.c);
    const ext = bb.getSize(new THREE.Vector3());
    const maxExt = Math.max(ext.x, ext.y, ext.z);
    if (maxExt < 7) return [items];
    const axis = ext.x === maxExt ? 'x' : ext.y === maxExt ? 'y' : 'z';
    const sorted = [...items].sort((p, q) => p.c[axis] - q.c[axis]);
    const half = sorted.length >> 1;
    return [...splitItems(sorted.slice(0, half)), ...splitItems(sorted.slice(half))];
  }

  for (const [key, grp] of groups) {
    const byCell = new Map();
    for (const it of grp.items) {
      it.c = centroidOfMesh(it.mesh);
      const c = cellOf(it.mesh);
      if (!byCell.has(c)) byCell.set(c, []);
      byCell.get(c).push(it);
    }
    if (!megaMats.has(key)) megaMats.set(key, makeMega(grp.std, grp.side));
    const mega = megaMats.get(key);

    const parts = [];
    for (const [cellName, cellItems] of byCell) {
      splitItems(cellItems).forEach((p, pi) => parts.push([cellName + '_' + pi, p]));
    }
    for (const [cellName, items] of parts) {
      let vtx = 0;
      let idx = 0;
      for (const { mesh } of items) {
        vtx += mesh.geometry.attributes.position.count;
        idx += mesh.geometry.index.count;
      }
      // Blob-local origin: keeps vertex coordinates small so f32 precision
      // stays close to the original transform path (less sub-pixel jitter).
      const centroid = new THREE.Vector3();
      {
        const bb = new THREE.Box3();
        const mbb = new THREE.Box3();
        for (const { mesh } of items) {
          mesh.updateWorldMatrix(true, false);
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          mbb.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
          bb.union(mbb);
        }
        bb.getCenter(centroid);
      }
      const pos = new Float32Array(vtx * 3);
      const nor = new Float32Array(vtx * 3);
      const uv = new Float32Array(vtx * 2);
      const col = new Float32Array(vtx * 3);
      const lay = new Uint16Array(vtx * 4);
      const par = new Uint16Array(vtx * 4);
      const tint = new Uint16Array(vtx * 4);
      const index = new Uint32Array(idx);
      let vo = 0;
      let io = 0;
      const constituents = [];

      for (const { mesh, index: mi } of items) {
        const g = mesh.geometry;
        const m = mesh.material;
        const n = g.attributes.position.count;
        mesh.updateWorldMatrix(true, false);
        const mw = mesh.matrixWorld;
        nrm3.getNormalMatrix(mw);
        const mirrored = mw.determinant() < 0;

        const pa = g.attributes.position;
        const na = g.attributes.normal;
        const ua = g.attributes.uv;
        const ca = g.attributes.color;
        // Only honor COLOR_0 when the ORIGINAL material used it. Otherwise fill
        // neutral: std -> black (bakedIrradiance 0), basic -> white (no tint).
        const useCol = !!(m.vertexColors && ca);
        const fill = grp.std ? 0 : 1;
        for (let k = 0; k < n; k++) {
          v3.fromBufferAttribute(pa, k).applyMatrix4(mw).sub(centroid);
          pos[(vo + k) * 3] = v3.x; pos[(vo + k) * 3 + 1] = v3.y; pos[(vo + k) * 3 + 2] = v3.z;
          v3.fromBufferAttribute(na, k).applyMatrix3(nrm3).normalize();
          nor[(vo + k) * 3] = v3.x; nor[(vo + k) * 3 + 1] = v3.y; nor[(vo + k) * 3 + 2] = v3.z;
          if (ua) { uv[(vo + k) * 2] = ua.getX(k); uv[(vo + k) * 2 + 1] = ua.getY(k); }
          if (useCol) {
            col[(vo + k) * 3] = ca.getX(k); col[(vo + k) * 3 + 1] = ca.getY(k); col[(vo + k) * 3 + 2] = ca.getZ(k);
          } else {
            col[(vo + k) * 3] = fill; col[(vo + k) * 3 + 1] = fill; col[(vo + k) * 3 + 2] = fill;
          }
        }

        const lb = layerOf('base', m.map);
        const lm = grp.std ? layerOf('mr', m.metalnessMap || m.roughnessMap) : -1;
        const ln = grp.std ? layerOf('normal', m.normalMap) : -1;
        const flags = (lb >= 0 ? 1 : 0) + (lm >= 0 ? 2 : 0) + (ln >= 0 ? 4 : 0);
        const metal = m.metalness ?? 1;
        const rough = m.roughness ?? 1;
        const q16 = (x) => Math.max(0, Math.min(65535, Math.round(x * 65535)));
        for (let k = 0; k < n; k++) {
          const o4 = (vo + k) * 4;
          lay[o4] = Math.max(0, lb); lay[o4 + 1] = Math.max(0, lm); lay[o4 + 2] = Math.max(0, ln); lay[o4 + 3] = flags;
          par[o4] = q16(metal); par[o4 + 1] = q16(rough); par[o4 + 2] = 0; par[o4 + 3] = 0;
          tint[o4] = q16(m.color?.r ?? 1); tint[o4 + 1] = q16(m.color?.g ?? 1); tint[o4 + 2] = q16(m.color?.b ?? 1); tint[o4 + 3] = 65535;
        }

        const ia = g.index;
        if (mirrored) {
          for (let k = 0; k < ia.count; k += 3) {
            index[io + k] = ia.getX(k) + vo;
            index[io + k + 1] = ia.getX(k + 2) + vo;
            index[io + k + 2] = ia.getX(k + 1) + vo;
          }
        } else {
          for (let k = 0; k < ia.count; k++) index[io + k] = ia.getX(k) + vo;
        }
        vo += n;
        io += ia.count;
        constituents.push(mi);
        mesh.visible = false; // raycast/PVS bookkeeping only from here on
      }

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setAttribute('aLay', new THREE.BufferAttribute(lay, 4, false));
      geo.setAttribute('aPar', new THREE.BufferAttribute(par, 4, true));
      geo.setAttribute('aTint', new THREE.BufferAttribute(tint, 4, true));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const blob = new THREE.Mesh(geo, mega);
      blob.name = `blob_${key}_${cellName}`;
      blob.position.copy(centroid);
      blob.frustumCulled = true;
      scene.add(blob);
      blobs.push({ mesh: blob, indices: constituents });
    }
  }

  // Free GPU copies of textures that only merged materials used — the array
  // holds the texel data now. Textures still used by excluded (individually
  // rendered) meshes stay. ~400MB VRAM on Quest otherwise held twice.
  {
    const live = new Set();
    for (const i of excluded) {
      const m = mapMeshes[i]?.material;
      const mats = Array.isArray(m) ? m : [m];
      for (const mm of mats) {
        for (const t of [mm?.map, mm?.normalMap, mm?.metalnessMap, mm?.roughnessMap, mm?.emissiveMap, mm?.alphaMap, mm?.aoMap]) {
          if (t) live.add(t);
        }
      }
    }
    let freed = 0;
    for (const reg of [slots.base, slots.mr, slots.normal]) {
      for (const t of reg.keys()) {
        if (!live.has(t)) { t.dispose(); freed++; }
      }
    }
    console.log(`arraymerge: disposed ${freed} source textures (GPU copies)`);
  }

  const mergedCount = mapMeshes.length - excluded.size;
  console.log(
    `arraymerge: ${mergedCount}/${mapMeshes.length} meshes -> ${blobs.length} blobs `
    + `(${megaMats.size} materials; layers base ${slots.base.size}, mr ${slots.mr.size}, normal ${slots.normal.size}); `
    + `${excluded.size} left individual`,
  );

  /** PVS hook: blob visible iff any constituent is in the visible set (null set = all). */
  function applyBlobVis(set) {
    for (const b of blobs) {
      b.mesh.visible = !set || b.indices.some((i) => set.has(i));
    }
  }

  const result = { blobs, excluded, applyBlobVis, merged: new Set([].concat(...blobs.map((b) => b.indices))) };
  // Debug introspection for verification tooling.
  window.__MERGE2__ = {
    baseArr, mrArr, normArr,
    baseTexs: [...slots.base.keys()], mrTexs: [...slots.mr.keys()], normTexs: [...slots.normal.keys()],
    megaMats: [...megaMats.values()],
  };
  return result;
}
