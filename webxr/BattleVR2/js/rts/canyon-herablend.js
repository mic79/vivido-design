/**
 * DriveVR6 canyonbare herablend for BattleVR2 Canyon map.
 * Hera triplanar albedo + soft WF2 splat normals (project-local textures).
 */
const SPLAT_BASE = 'assets/terrain/canyon_splat/';
const MOON_BASE = 'assets/terrain/canyon_moon/';

let splatPack = null;
let splatLoading = null;
let moonPack = null;
let moonLoading = null;

function loadTex(THREE, url, opts = {}) {
  const loader = new THREE.TextureLoader();
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      (tex) => {
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        tex.flipY = false;
        if (opts.nearest) {
          tex.generateMipmaps = false;
          tex.minFilter = THREE.NearestFilter;
          tex.magFilter = THREE.NearestFilter;
          tex.colorSpace = THREE.NoColorSpace;
        } else if (opts.data) {
          tex.colorSpace = THREE.NoColorSpace;
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;
        } else if (opts.repeat) {
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        } else {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.generateMipmaps = true;
          tex.minFilter = THREE.LinearMipmapLinearFilter;
          tex.magFilter = THREE.LinearFilter;
        }
        tex.anisotropy = Math.min(16, opts.aniso || 8);
        tex.needsUpdate = true;
        resolve(tex);
      },
      undefined,
      reject
    );
  });
}

async function loadSplatPack(THREE) {
  if (splatPack) return splatPack;
  if (splatLoading) return splatLoading;
  splatLoading = (async () => {
    const res = await fetch(`${SPLAT_BASE}splat.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`splat.json ${res.status}`);
    const meta = await res.json();
    const nrmUrl = meta.normalAtlas || null;
    const parts = await Promise.all([
      loadTex(THREE, SPLAT_BASE + meta.splatI, { nearest: true }),
      loadTex(THREE, SPLAT_BASE + meta.splatW, { data: true }),
      loadTex(THREE, SPLAT_BASE + (meta.colorAtlas || 'color_atlas.jpg')),
      nrmUrl ? loadTex(THREE, SPLAT_BASE + nrmUrl, { data: true }) : Promise.resolve(null),
    ]);
    if (parts[3]) {
      parts[3].wrapS = THREE.ClampToEdgeWrapping;
      parts[3].wrapT = THREE.ClampToEdgeWrapping;
      parts[3].colorSpace = THREE.NoColorSpace;
      parts[3].generateMipmaps = true;
      parts[3].minFilter = THREE.LinearMipmapLinearFilter;
      parts[3].magFilter = THREE.LinearFilter;
      parts[3].needsUpdate = true;
    }
    splatPack = {
      meta,
      splatI: parts[0],
      splatW: parts[1],
      atlas: parts[2],
      normalAtlas: parts[3],
    };
    splatLoading = null;
    console.log(
      '[RTSVR6] canyon splat',
      meta.layers?.length,
      'layers',
      parts[3] ? '+normals' : '(albedo only)'
    );
    return splatPack;
  })().catch((err) => {
    splatLoading = null;
    console.warn('[RTSVR6] canyon splat failed', err);
    throw err;
  });
  return splatLoading;
}

async function loadMoonDiff(THREE) {
  if (moonPack) return moonPack;
  if (moonLoading) return moonLoading;
  moonLoading = loadTex(THREE, `${MOON_BASE}diffuse-bake.jpg`, { repeat: true })
    .then((diff) => {
      moonPack = { diff };
      moonLoading = null;
      return moonPack;
    })
    .catch((err) => {
      moonLoading = null;
      console.warn('[RTSVR6] canyon Hera diffuse failed', err);
      throw err;
    });
  return moonLoading;
}

function layerPickFns(layers) {
  let tilePick = 'float canyonTileOf(int layer) {\n';
  let cellPick = 'float canyonCellOf(int layer) {\n';
  let deadPick = 'bool canyonDead(int layer) {\n';
  for (let lk = 0; lk < layers.length; lk++) {
    tilePick += `  if (layer == ${lk}) return ${(layers[lk].tile || 1).toFixed(1)};\n`;
    cellPick += `  if (layer == ${lk}) return ${(layers[lk].atlasCell || 0).toFixed(1)};\n`;
    if (layers[lk].dead) deadPick += `  if (layer == ${lk}) return true;\n`;
  }
  tilePick += '  return 1.0;\n}\n';
  cellPick += '  return 0.0;\n}\n';
  deadPick += '  return false;\n}\n';
  return { tilePick, cellPick, deadPick };
}

/**
 * Apply DriveVR6 herablend (Hera albedo + soft splat N) to canyon ground mats.
 * @returns {Promise<number>} materials patched
 */
export async function applyCanyonHerablend(root, THREE) {
  if (!root || !THREE) return 0;
  const [pack, moon] = await Promise.all([loadSplatPack(THREE), loadMoonDiff(THREE)]);
  const meta = pack.meta;
  const layers = meta.layers || [];
  const cols = meta.atlasCols || 4;
  const rows = meta.atlasRows || 4;
  const hasNrm = !!pack.normalAtlas;
  const picks = layerPickFns(layers);
  let patched = 0;

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const wasArray = Array.isArray(obj.material);
    const list = wasArray ? obj.material.slice() : [obj.material];
    for (let mi = 0; mi < list.length; mi++) {
      let mat = list[mi];
      if (!mat || mat.userData._canyonHerablend) continue;
      // DriveVR6 canyon mats are Standard + roughness 1 — Lambert turns splat N into sandpaper.
      if (!mat.isMeshStandardMaterial && !mat.isMeshPhysicalMaterial) {
        const std = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          map: mat.map || null,
          fog: false,
          roughness: 1,
          metalness: 0,
        });
        std.userData = { ...mat.userData };
        if (mat.userData?.shadowRecv != null) std.userData.shadowRecv = mat.userData.shadowRecv;
        // Keep FoW compile chain if already installed on Lambert.
        if (typeof mat.onBeforeCompile === 'function') std.onBeforeCompile = mat.onBeforeCompile;
        if (typeof mat.customProgramCacheKey === 'function') {
          const pk = mat.customProgramCacheKey.bind(mat);
          std.customProgramCacheKey = () => `${pk()}|canyonStd`;
        }
        mat = std;
        list[mi] = mat;
      }
      mat.userData._canyonHerablend = true;
      mat.userData.cheapMoonLook = true;
      mat.emissiveMap = null;
      if (mat.emissive) mat.emissive.setHex(0x000000);
      if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0;
      mat.aoMap = null;
      mat.aoMapIntensity = 0;
      mat.lightMap = null;
      mat.roughnessMap = null;
      mat.metalnessMap = null;
      mat.roughness = 1;
      mat.metalness = 0;
      if ('envMapIntensity' in mat) mat.envMapIntensity = 0;
      mat.envMap = null;
      if (mat.color) mat.color.setRGB(1, 1, 1);

      if (hasNrm) {
        if (!mat.userData._canyonFlatNrm) {
          const flatN = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
          flatN.colorSpace = THREE.NoColorSpace;
          flatN.needsUpdate = true;
          mat.userData._canyonFlatNrm = flatN;
        }
        mat.normalMap = mat.userData._canyonFlatNrm;
        // Soft grit — 0.9+ sparks under RTS sun; 0 = flat clay Hera.
        if (mat.normalScale) mat.normalScale.set(0.5, 0.5);
      }

      const prevCompile = mat.onBeforeCompile;
      mat.onBeforeCompile = (shader) => {
        if (typeof prevCompile === 'function') prevCompile(shader);
        shader.uniforms.canyonSplatI = { value: pack.splatI };
        shader.uniforms.canyonSplatW = { value: pack.splatW };
        shader.uniforms.canyonAtlas = { value: pack.atlas };
        shader.uniforms.canyonAtlasCols = { value: cols };
        shader.uniforms.canyonAtlasRows = { value: rows };
        if (hasNrm) shader.uniforms.canyonNrmAtlas = { value: pack.normalAtlas };
        shader.uniforms.canyonHeraDiff = { value: moon.diff };
        shader.uniforms.canyonHeraScale = { value: 0.007 };

        const nrmUniform = hasNrm ? 'uniform sampler2D canyonNrmAtlas;\n' : '';
        const sampleFn =
          'vec3 canyonSampleAtlas(sampler2D atlas, float cell, vec2 uv) {\n' +
          '  float c = floor(cell + 0.5);\n' +
          '  float cx = mod(c, canyonAtlasCols);\n' +
          '  float cy = floor(c / canyonAtlasCols);\n' +
          '  vec2 local = fract(uv);\n' +
          '  local = local * 0.998 + 0.001;\n' +
          '  vec2 auv = (vec2(cx, cy) + local) / vec2(canyonAtlasCols, canyonAtlasRows);\n' +
          '  return texture2D(atlas, auv).rgb;\n' +
          '}\n' +
          'vec3 canyonSampleAtlasBias(sampler2D atlas, float cell, vec2 uv, float bias) {\n' +
          '  float c = floor(cell + 0.5);\n' +
          '  float cx = mod(c, canyonAtlasCols);\n' +
          '  float cy = floor(c / canyonAtlasCols);\n' +
          '  vec2 local = fract(uv);\n' +
          '  local = local * 0.998 + 0.001;\n' +
          '  vec2 auv = (vec2(cx, cy) + local) / vec2(canyonAtlasCols, canyonAtlasRows);\n' +
          '  return texture2D(atlas, auv, bias).rgb;\n' +
          '}\n';

        shader.vertexShader = shader.vertexShader.replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vCanyonHeraWorld;'
        );
        if (shader.vertexShader.includes('#include <worldpos_vertex>')) {
          shader.vertexShader = shader.vertexShader.replace(
            '#include <worldpos_vertex>',
            '#include <worldpos_vertex>\nvCanyonHeraWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
          );
        } else {
          shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\nvCanyonHeraWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;'
          );
        }

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <common>',
          '#include <common>\n' +
            'uniform sampler2D canyonSplatI;\n' +
            'uniform sampler2D canyonSplatW;\n' +
            'uniform sampler2D canyonAtlas;\n' +
            nrmUniform +
            'uniform sampler2D canyonHeraDiff;\n' +
            'uniform float canyonHeraScale;\n' +
            'varying vec3 vCanyonHeraWorld;\n' +
            'uniform float canyonAtlasCols;\n' +
            'uniform float canyonAtlasRows;\n' +
            'vec3 canyonDetailN;\n' +
            picks.tilePick +
            picks.cellPick +
            picks.deadPick +
            sampleFn
        );

        if (!shader.fragmentShader.includes('#include <map_fragment>')) return;

        const albedoAssign =
          '  vec3 wp = vCanyonHeraWorld;\n' +
          '  vec3 dpdx = dFdx(wp);\n' +
          '  vec3 dpdy = dFdy(wp);\n' +
          '  vec3 bn = normalize(abs(cross(dpdx, dpdy)));\n' +
          '  bn = max(bn - 0.2, 0.0);\n' +
          '  bn /= (bn.x + bn.y + bn.z + 1e-4);\n' +
          '  float sM = canyonHeraScale;\n' +
          '  vec2 hUVx = wp.zy * sM;\n' +
          '  vec2 hUVy = wp.xz * sM;\n' +
          '  vec2 hUVz = wp.xy * sM;\n' +
          '  float hBias = 0.5 * log2(max(1e-8, max(length(fwidth(hUVy)), 1e-4))) + 0.85;\n' +
          '  hBias = clamp(hBias, 0.0, 8.0);\n' +
          '  vec3 hX = texture2D(canyonHeraDiff, hUVx, hBias).rgb;\n' +
          '  vec3 hY = texture2D(canyonHeraDiff, hUVy, hBias).rgb;\n' +
          '  vec3 hZ = texture2D(canyonHeraDiff, hUVz, hBias).rgb;\n' +
          '  vec3 heraCol = hX * bn.x + hY * bn.y + hZ * bn.z;\n' +
          '  diffuseColor = vec4(mix(heraCol, canyonCol, 0.28), opacity);\n';

        const nAcc = hasNrm
          ? '    float nBias = clamp(0.5 * log2(max(1e-8, length(fwidth(canyonLUV)))) + 1.6, 0.0, 7.0);\n' +
            '    canyonNacc += (canyonSampleAtlasBias(canyonNrmAtlas, canyonCell, canyonLUV, nBias) * 2.0 - 1.0) * canyonWi;\n'
          : '';

        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          '{\n' +
            '  vec2 canyonUV = vMapUv;\n' +
            '  vec4 canyonIdx = texture2D(canyonSplatI, canyonUV) * 255.0;\n' +
            '  vec4 canyonW = texture2D(canyonSplatW, canyonUV);\n' +
            '  vec3 canyonCol = vec3(0.0);\n' +
            '  vec3 canyonNacc = vec3(0.0);\n' +
            '  float canyonWsum = 0.0;\n' +
            '  for (int canyonC = 0; canyonC < 4; canyonC++) {\n' +
            '    float canyonWi = canyonC == 0 ? canyonW.r : (canyonC == 1 ? canyonW.g : (canyonC == 2 ? canyonW.b : canyonW.a));\n' +
            '    float canyonIi = canyonC == 0 ? canyonIdx.r : (canyonC == 1 ? canyonIdx.g : (canyonC == 2 ? canyonIdx.b : canyonIdx.a));\n' +
            '    int canyonLi = int(canyonIi + 0.5);\n' +
            '    if (canyonDead(canyonLi) || canyonWi < 0.004) continue;\n' +
            '    float canyonTile = canyonTileOf(canyonLi);\n' +
            '    float canyonCell = canyonCellOf(canyonLi);\n' +
            '    vec2 canyonLUV = canyonUV * canyonTile;\n' +
            '    canyonCol += canyonSampleAtlas(canyonAtlas, canyonCell, canyonLUV) * canyonWi;\n' +
            nAcc +
            '    canyonWsum += canyonWi;\n' +
            '  }\n' +
            '  if (canyonWsum > 0.001) { canyonCol /= canyonWsum; canyonNacc /= canyonWsum; }\n' +
            '  else { canyonCol = vec3(0.45, 0.32, 0.22); canyonNacc = vec3(0.0, 0.0, 1.0); }\n' +
            '  canyonNacc.z = max(canyonNacc.z, 0.15);\n' +
            '  canyonDetailN = normalize(canyonNacc);\n' +
            albedoAssign +
            '}\n'
        );

        if (hasNrm && shader.fragmentShader.includes('#include <normal_fragment_maps>')) {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <normal_fragment_maps>',
            '{\n' +
              '  vec3 mapN = canyonDetailN;\n' +
              '  float distFade = smoothstep(25.0, 110.0, length(vViewPosition));\n' +
              '  float nStr = mix(0.75, 0.2, distFade);\n' +
              '  vec3 geoN = normalize(normal);\n' +
              '  float slopeSoft = smoothstep(0.2, 0.7, geoN.y);\n' +
              '  nStr *= mix(0.3, 1.0, slopeSoft);\n' +
              '  mapN.xy = clamp(mapN.xy, -0.7, 0.7);\n' +
              '  mapN.xy *= normalScale * nStr;\n' +
              '  vec3 q0 = dFdx(vViewPosition.xyz);\n' +
              '  vec3 q1 = dFdy(vViewPosition.xyz);\n' +
              '  vec2 st0 = dFdx(vMapUv);\n' +
              '  vec2 st1 = dFdy(vMapUv);\n' +
              '  vec3 N = normalize(normal);\n' +
              '  vec3 q1perp = cross(q1, N);\n' +
              '  vec3 q0perp = cross(N, q0);\n' +
              '  vec3 T = q1perp * st0.x + q0perp * st1.x;\n' +
              '  vec3 B = q1perp * st0.y + q0perp * st1.y;\n' +
              '  float det = max(dot(T, T), dot(B, B));\n' +
              '  float invMax = det == 0.0 ? 0.0 : inversesqrt(det);\n' +
              '  T *= invMax; B *= invMax;\n' +
              '  normal = normalize(T * mapN.x + B * mapN.y + N * mapN.z);\n' +
              '}\n'
          );
        }
      };
      mat.customProgramCacheKey = () =>
        `canyonHerablend_v16${hasNrm ? '_nrm' : ''}|${mat.uuid}`;
      mat.needsUpdate = true;
      list[mi] = mat;
      patched += 1;
    }
    obj.material = wasArray ? list : list[0];
  });

  console.log('[RTSVR6] canyon herablend applied', { mats: patched, hasNrm });
  return patched;
}
