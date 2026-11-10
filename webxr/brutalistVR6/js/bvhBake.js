/**
 * BVH + HDR hemisphere bake (from BuildVR/index5.html).
 * Lightmap UVs live on `uv2` so `uv` stays valid for roughnessMap tiling.
 */

import {
  Vector2,
  Vector3,
  Matrix4,
  Ray,
  BufferAttribute,
  CanvasTexture,
  LinearFilter,
  SRGBColorSpace,
  BoxGeometry,
  PlaneGeometry,
  Mesh,
  FrontSide,
} from "three";
import { MeshBVH, StaticGeometryGenerator } from "three-mesh-bvh";

/**
 * Canvas-backed lightmaps default to mipmaps → moiré / faint checker on large flat faces at grazing angles.
 */
export function configureLightmapCanvasTexture(tex) {
  tex.generateMipmaps = false;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 1;
  /* WebGLPrograms.getChannel: 0→uv, 1→uv1, 2→uv2. Bakes use geometry `uv2` only — NOT channel 1. */
  if ("channel" in tex) tex.channel = 2;
  tex.needsUpdate = true;
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stable seed for each lightmap texel + triangle. Hashing world position per pixel
 * with very few rays (e.g. 32) gave uncorrelated noise between the two tris of each
 * box face → visible diagonal "harlequin" splits (not a geometry subdivision bug).
 */
function bakeRasterSeed(px, py, triIdx, meshName = "") {
  let salt = 2166136261 >>> 0;
  for (let i = 0; i < meshName.length; i++) {
    salt = Math.imul(salt ^ meshName.charCodeAt(i), 16777619) >>> 0;
  }
  let h =
    (Math.imul(px >>> 0, 0x9e3779b1) ^
      Math.imul(py >>> 0, 0x85ebca87) ^
      Math.imul(triIdx >>> 0, 0xc2b2ae3d) ^
      salt) >>>
    0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function getFaceIndex(nx, ny, nz) {
  if (nx > 0.5) return 0;
  if (nx < -0.5) return 1;
  if (ny > 0.5) return 2;
  if (ny < -0.5) return 3;
  if (nz > 0.5) return 4;
  if (nz < -0.5) return 5;
  return 0;
}

function buildBoxFaceBakeData(mesh, geometry) {
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uvs = geometry.attributes.uv2 || geometry.attributes.uv;
  const rot = new Matrix4().extractRotation(mesh.matrixWorld);
  const faceVerts = Array.from({ length: 6 }, () => []);
  for (let i = 0; i < positions.count; i++) {
    const face = getFaceIndex(normals.getX(i), normals.getY(i), normals.getZ(i));
    faceVerts[face].push(i);
  }

  const faces = [];
  for (let face = 0; face < 6; face++) {
    const verts = [...new Set(faceVerts[face])];
    if (verts.length < 3) continue;

    let i0 = verts[0];
    let i1 = verts[1];
    let i2 = verts[2];
    let found = false;
    for (let a = 0; a < verts.length && !found; a++) {
      for (let b = a + 1; b < verts.length && !found; b++) {
        for (let c = b + 1; c < verts.length; c++) {
          const ua = uvs.getX(verts[a]);
          const va = uvs.getY(verts[a]);
          const ub = uvs.getX(verts[b]);
          const vb = uvs.getY(verts[b]);
          const uc = uvs.getX(verts[c]);
          const vc = uvs.getY(verts[c]);
          const det = (ub - ua) * (vc - va) - (vb - va) * (uc - ua);
          if (Math.abs(det) > 1e-8) {
            i0 = verts[a];
            i1 = verts[b];
            i2 = verts[c];
            found = true;
            break;
          }
        }
      }
    }
    if (!found) continue;

    const uv0 = new Vector2(uvs.getX(i0), uvs.getY(i0));
    const uv1 = new Vector2(uvs.getX(i1), uvs.getY(i1));
    const uv2 = new Vector2(uvs.getX(i2), uvs.getY(i2));
    const det = (uv1.x - uv0.x) * (uv2.y - uv0.y) - (uv1.y - uv0.y) * (uv2.x - uv0.x);
    if (Math.abs(det) < 1e-8) continue;

    const p0 = new Vector3(positions.getX(i0), positions.getY(i0), positions.getZ(i0)).applyMatrix4(
      mesh.matrixWorld,
    );
    const p1 = new Vector3(positions.getX(i1), positions.getY(i1), positions.getZ(i1)).applyMatrix4(
      mesh.matrixWorld,
    );
    const p2 = new Vector3(positions.getX(i2), positions.getY(i2), positions.getZ(i2)).applyMatrix4(
      mesh.matrixWorld,
    );
    const normal = new Vector3(normals.getX(i0), normals.getY(i0), normals.getZ(i0))
      .applyMatrix4(rot)
      .normalize();

    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (const idx of verts) {
      const u = uvs.getX(idx);
      const v = uvs.getY(idx);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }

    faces.push({ face, uv0, uv1, uv2, det, p0, p1, p2, normal, minU, minV, maxU, maxV });
  }
  return faces;
}

export function barycentric(px, py, v0, v1, v2) {
  const d00 = (v2.x - v0.x) ** 2 + (v2.y - v0.y) ** 2;
  const d01 = (v2.x - v0.x) * (v1.x - v0.x) + (v2.y - v0.y) * (v1.y - v0.y);
  const d11 = (v1.x - v0.x) ** 2 + (v1.y - v0.y) ** 2;
  const d20 = (px - v0.x) * (v2.x - v0.x) + (py - v0.y) * (v2.y - v0.y);
  const d21 = (px - v0.x) * (v1.x - v0.x) + (py - v0.y) * (v1.y - v0.y);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-10) return { x: -1, y: -1, z: -1 };
  const w = (d11 * d20 - d01 * d21) / denom;
  const v = (d00 * d21 - d01 * d20) / denom;
  const u = 1 - v - w;
  return { x: u, y: v, z: w };
}

export function dilatePixels(imageData, size, iterations) {
  const data = imageData.data;
  const temp = new Uint8ClampedArray(data.length);
  for (let iter = 0; iter < iterations; iter++) {
    temp.set(data);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        if (data[idx + 3] > 0) continue;
        let r = 0,
          g = 0,
          b = 0,
          count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx,
              ny = y + dy;
            if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
            const nIdx = (ny * size + nx) * 4;
            if (temp[nIdx + 3] > 0) {
              r += temp[nIdx];
              g += temp[nIdx + 1];
              b += temp[nIdx + 2];
              count++;
            }
          }
        }
        if (count > 0) {
          data[idx] = Math.round(r / count);
          data[idx + 1] = Math.round(g / count);
          data[idx + 2] = Math.round(b / count);
          data[idx + 3] = 255;
        }
      }
    }
  }
}

export function denoiseTexture(imageData, size, iterations = 2) {
  const data = imageData.data;
  const temp = new Uint8ClampedArray(data.length);
  const spatialSigma = 2.0;
  const rangeSigma = 30.0;
  const kernelRadius = 3;
  for (let iter = 0; iter < iterations; iter++) {
    temp.set(data);
    for (let y = kernelRadius; y < size - kernelRadius; y++) {
      for (let x = kernelRadius; x < size - kernelRadius; x++) {
        const centerIdx = (y * size + x) * 4;
        if (temp[centerIdx + 3] === 0) continue;
        const centerR = temp[centerIdx];
        const centerG = temp[centerIdx + 1];
        const centerB = temp[centerIdx + 2];
        let sumR = 0,
          sumG = 0,
          sumB = 0,
          sumWeight = 0;
        for (let ky = -kernelRadius; ky <= kernelRadius; ky++) {
          for (let kx = -kernelRadius; kx <= kernelRadius; kx++) {
            const nx = x + kx,
              ny = y + ky;
            const nIdx = (ny * size + nx) * 4;
            if (temp[nIdx + 3] === 0) continue;
            const nR = temp[nIdx];
            const nG = temp[nIdx + 1];
            const nB = temp[nIdx + 2];
            const spatialDist = Math.sqrt(kx * kx + ky * ky);
            const spatialWeight = Math.exp(
              -(spatialDist * spatialDist) / (2 * spatialSigma * spatialSigma),
            );
            const colorDist = Math.sqrt(
              (nR - centerR) ** 2 + (nG - centerG) ** 2 + (nB - centerB) ** 2,
            );
            const rangeWeight = Math.exp(
              -(colorDist * colorDist) / (2 * rangeSigma * rangeSigma),
            );
            const weight = spatialWeight * rangeWeight;
            sumR += nR * weight;
            sumG += nG * weight;
            sumB += nB * weight;
            sumWeight += weight;
          }
        }
        if (sumWeight > 0) {
          data[centerIdx] = Math.round(sumR / sumWeight);
          data[centerIdx + 1] = Math.round(sumG / sumWeight);
          data[centerIdx + 2] = Math.round(sumB / sumWeight);
        }
      }
    }
  }
}

/**
 * Linear contrast around a midpoint (after denoise). Denoise softens shadow edges; this brings
 * occluded texels closer to black vs sky so BVH bakes read richer vs path-traced preview.
 */
export function punchLightmapContrast(imageData, size, punch = 1.38, midpoint = 0.38) {
  if (punch <= 1.001) return;
  const d = imageData.data;
  const mid = midpoint;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) {
      let v = d[i + c] / 255;
      v = mid + (v - mid) * punch;
      d[i + c] = Math.min(255, Math.max(0, Math.round(v * 255)));
    }
  }
}

/**
 * Pack box faces into a 3×2 uv2 grid; leaves `uv` unchanged for material maps.
 * For `PlaneGeometry` (single quad), just mirrors `uv` into `uv2` so the whole atlas
 * is one face — used by the ground plane so it can receive baked shadows from the
 * surrounding slabs.
 */
export function generateLightmapUV2(geometry) {
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uvs = geometry.attributes.uv;
  if (!uvs || !normals) return false;

  if (geometry instanceof PlaneGeometry || positions.count === 4) {
    const newUVs = new Float32Array(positions.count * 2);
    const padding = 0.005;
    const inner = 1 - padding * 2;
    for (let i = 0; i < positions.count; i++) {
      newUVs[i * 2] = padding + uvs.getX(i) * inner;
      newUVs[i * 2 + 1] = padding + uvs.getY(i) * inner;
    }
    geometry.setAttribute("uv2", new BufferAttribute(newUVs, 2));
    geometry.attributes.uv2.needsUpdate = true;
    return true;
  }

  if (!(geometry instanceof BoxGeometry) || positions.count !== 24) {
    console.warn("generateLightmapUV2: expected BoxGeometry with 24 verts, got", positions.count);
    return false;
  }
  const newUVs = new Float32Array(positions.count * 2);
  const cellW = 1 / 3;
  const cellH = 1 / 2;
  const padding = 0.01;
  function getFaceIndex(nx, ny, nz) {
    if (nx > 0.5) return 0;
    if (nx < -0.5) return 1;
    if (ny > 0.5) return 2;
    if (ny < -0.5) return 3;
    if (nz > 0.5) return 4;
    if (nz < -0.5) return 5;
    return 0;
  }
  for (let i = 0; i < positions.count; i++) {
    const nx = normals.getX(i);
    const ny = normals.getY(i);
    const nz = normals.getZ(i);
    const faceIdx = getFaceIndex(nx, ny, nz);
    const col = faceIdx % 3;
    const row = Math.floor(faceIdx / 3);
    const baseU = col * cellW + padding;
    const baseV = row * cellH + padding;
    const innerW = cellW - padding * 2;
    const innerH = cellH - padding * 2;
    const origU = uvs.getX(i);
    const origV = uvs.getY(i);
    newUVs[i * 2] = baseU + origU * innerW;
    newUVs[i * 2 + 1] = baseV + origV * innerH;
  }
  geometry.setAttribute("uv2", new BufferAttribute(newUVs, 2));
  geometry.attributes.uv2.needsUpdate = true;
  return true;
}

export function prepareBoxesForBake(sceneObjects) {
  for (const obj of sceneObjects) {
    if (obj.userData.skipBake) continue;
    const g = obj.geometry;
    if (g instanceof BoxGeometry || g instanceof PlaneGeometry) generateLightmapUV2(g);
  }
}

/**
 * @param {import('three').Scene} scene
 * @param {import('three').Mesh[]} sceneObjects
 */
export function buildSceneBVH(scene, sceneObjects) {
  scene.updateMatrixWorld(true);
  for (const obj of sceneObjects) obj.updateMatrixWorld(true);
  const generator = new StaticGeometryGenerator(sceneObjects);
  generator.attributes = ["position", "normal"];
  const mergedGeometry = generator.generate();
  mergedGeometry.boundsTree = new MeshBVH(mergedGeometry);
  const sceneBVH = mergedGeometry.boundsTree;
  /* Debug-only: merged world BVH (do not add to scene — duplicates geometry). */
  const bvhMesh = new Mesh(mergedGeometry);
  bvhMesh.visible = false;
  return { sceneBVH, bvhMesh, mergedGeometry };
}

/* Module-scope scratch vectors for `randomCosineHemisphere`. v5 allocated 4
 * Vector3s per call; v6 calls it ~MAX_BOUNCES × numSamples times per texel
 * (~290× per texel at defaults vs v5's ~5×), so per-call allocation lights
 * up the GC. Reused safely because all callers run on the JS main thread
 * and use the result immediately. */
const _rchTangent = new Vector3();
const _rchBitangent = new Vector3();
const _rchTmpAxis = new Vector3();

/**
 * Sample a unit vector from the cosine-weighted upper hemisphere around
 * `normal`. Writes the result into `outVec` and returns it.
 *
 * For backward-compatibility callers that don't pass `outVec`, allocates a
 * fresh Vector3 (matches v5 signature). v6 hot loops always pass an
 * `outVec` to avoid that allocation.
 */
function randomCosineHemisphere(normal, pixelRandom, outVec) {
  const u1 = pixelRandom();
  const u2 = pixelRandom();
  const r = Math.sqrt(u1);
  const theta = 2 * Math.PI * u2;
  const x = r * Math.cos(theta);
  const y = r * Math.sin(theta);
  const z = Math.sqrt(1 - u1);
  /* Build an orthonormal frame around `normal` using a deterministic
   * non-parallel seed axis (avoid the degenerate cross-product). */
  if (Math.abs(normal.x) > 0.9) _rchTmpAxis.set(0, 1, 0);
  else _rchTmpAxis.set(1, 0, 0);
  _rchBitangent.crossVectors(normal, _rchTmpAxis).normalize();
  _rchTangent.crossVectors(_rchBitangent, normal).normalize();
  const out = outVec || new Vector3();
  out
    .set(0, 0, 0)
    .addScaledVector(_rchTangent, x)
    .addScaledVector(_rchBitangent, y)
    .addScaledVector(normal, z)
    .normalize();
  return out;
}

export function createHdrBvhLighting(envData, sceneBVH, params) {
  let sunDirection = null;
  let pixelRandom = mulberry32(12345);
  /* v5's `bvhSunFraction` param is intentionally NOT consumed in v6: with NEE
   * sun fired at every bounce, there is no separate sun/sky sample budget to
   * split. The param still lives in `main.js` so v5 console snippets keep
   * parsing, but v6 ignores it. */
  /* ── v6 multi-bounce path-traced bake ────────────────────────────────────
   *
   * v5 was direct-only with a constant `skyFill` for every blocked ray — fast
   * and noise-free, but every blocked direction contributed the same colour
   * regardless of what the ray hit, so light could not propagate through
   * doorways/openings into enclosed volumes. v6 replaces that with a real
   * Monte Carlo path tracer per lightmap texel.
   *
   * Per-path algorithm (one path = one Monte Carlo sample):
   *   1. NEE sun at primary surface  → contribute `sunAverageColor` if unblocked.
   *   2. Cast 1 cosine-weighted hemisphere bounce ray.
   *      - Escapes BVH                → contribute `throughput * skyAverageRaw`,
   *                                     end path.
   *      - Hits surface S₁            → advance origin/normal to S₁, multiply
   *                                     throughput by `BOUNCE_ALBEDO`, repeat
   *                                     from step 1 (NEE sun + bounce) at S₁.
   *   3. Stop after `MAX_BOUNCES` bounce rays. Terminator contribution is
   *      `throughput * skyFill` (modelling the energy that *would* escape to
   *      sky if more bounces were allowed, attenuated by all the bounces
   *      already taken). With `BOUNCE_ENABLED=0` the terminator is `0`
   *      (strict — deep enclosed corners stay near-black, no implicit fill).
   *
   * Why NEE every bounce: variance reduction. Without NEE, sun light only
   * arrives via a hemisphere ray that happens to escape into the sun region
   * — extremely unlikely for any single bounce. NEE casts a deterministic
   * shadow ray toward the sun at every hit, so any sun-visible bounce
   * surface lights the path.
   *
   * Material model: single global Lambertian `BOUNCE_ALBEDO` for every hit
   * surface. Real albedos vary, but the brutalist court is uniform concrete,
   * and `sceneBVH` is built by `StaticGeometryGenerator` which discards
   * material info — so per-hit albedo would require an extra mesh-lookup
   * step we'd rather not pay for here.
   *
   * Cost per path ≈ `MAX_BOUNCES * 2` rays (1 NEE + 1 hemisphere per
   * bounce). With default 96 paths × 4 bounces × 2 ≈ 768 rays/texel — roughly
   * the same total ray budget as v5's 384, but spent on real GI. */
  const MAX_BOUNCES = Math.max(0, Math.min(8, params.bvhMaxBounces ?? 3));
  /** When true, max-depth-reached paths terminate with `throughput * skyFill`
   * (small implicit fill — better convergence with low MAX_BOUNCES). When
   * false, terminate with 0 (strict, more bias-prone in enclosed scenes). */
  const BOUNCE_ENABLED = (params.bvhBounce ?? 1) >= 1;
  /** Multiplied into throughput at every bounce. Concrete ≈ 0.6, white ≈ 0.85. */
  const BOUNCE_ALBEDO = Math.max(0, Math.min(1, params.bvhBounceAlbedo ?? 0.6));
  /** Hard floor used when bounce terminator is disabled — kept dark on purpose. */
  const OCCLUDED_FLOOR = 0.042;
  /**
   * World-space lift off the receiver surface to dodge floating-point self-hits.
   * Was 0.06 — combined with the 0.1 `near` skip below that produced a 0.16-unit
   * "blind zone" past every surface, so any occluder closer than that registered
   * as clear sky and contributed a bright sample. With ~1–5u thick walls and
   * sub-unit gaps between fins/bridge/cantilever elements, that was a real source
   * of bright leaks at the seams. 5 mm is plenty for self-intersection avoidance.
   */
  const RAY_ORIGIN_OFFSET = 0.005;
  /** `MeshBVH.raycastFirst` `near` value — ignore hits in the first 0.5 mm. */
  const RAY_CAST_NEAR_SKIP = 0.0005;

  /* Sun model: brightness-weighted centroid of the HDR's bright region as the
   * sun direction, plus a small jitter cone around it for penumbra width.
   *
   * The centroid (rather than "the single brightest pixel") matters because it
   * matches what the path tracer effectively uses when it importance-samples the
   * HDR — a sun-with-halo HDR has its brightest pixel offset slightly from the
   * apparent sun centre, and using that one pixel produced shadows whose shapes
   * disagreed with the preview.
   *
   * The jitter cone gives each direct-lighting sample a slightly different
   * direction within a tunable angular radius, so adjacent shadows blend
   * smoothly across their penumbra (the gap between two close shadows
   * disappears once the cone is wider than the angle subtended by the gap from
   * the receiver). All rays still hit the bright region, so the per-sample
   * colour is essentially constant and the lit floor stays free of MC noise. */
  /** Half-angle of the jitter cone, in pre-normalize units added per axis to
   * `sunDirection`. 0.05 ≈ ±1.5° (sharp shadows, narrow penumbra), 0.18 ≈ ±5°
   * (default — wide enough to merge close shadows the way the preview does),
   * 0.30 ≈ ±9° (very soft, almost overcast). */
  const SUN_JITTER = Math.max(0, Math.min(0.5, params.bvhSunJitter ?? 0.18));
  /** Brightness threshold for centroid + average-colour computation, as a
   * fraction of HDR peak. Anything above contributes to "the sun"; anything
   * below is treated as ambient sky and integrated into `skyAverageRaw`. */
  const SUN_REGION_THRESHOLD = Math.max(
    0.005,
    Math.min(1, params.bvhSunThreshold ?? 0.06),
  );
  /** Tone-mapped average colour of all sun-region pixels — the constant
   * "unblocked sun ray" contribution. Direction is jittered for penumbras,
   * but the *colour* is held constant so a fully-lit texel always sums to
   * the same value across the bake (no per-texel MC noise on flat sun-lit
   * surfaces). */
  let sunAverageColor = { r: 0, g: 0, b: 0 };

  /* Scratch vectors reused by `computeLightingBVH` to keep allocations out
   * of the per-texel hot loop (96 paths × ~8 rays × ~14 meshes × LM² texels). */
  const _ptOffsetOrigin = new Vector3();
  const _ptSunDir = new Vector3();
  const _ptJitter = new Vector3();
  const _ptCurOrigin = new Vector3();
  const _ptCurNormal = new Vector3();
  const _ptBounceDir = new Vector3();
  const _ptRay = new Ray();

  function findSunInHDR() {
    if (!envData || sunDirection) return;
    const W = envData.width;
    const H = envData.height;
    const data = envData.data;
    let maxBright = 0;
    const step = 4;
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const idx = (y * W + x) * 4;
        const b = data[idx] + data[idx + 1] + data[idx + 2];
        if (b > maxBright) maxBright = b;
      }
    }
    const threshold = maxBright * SUN_REGION_THRESHOLD;
    let centroidX = 0, centroidY = 0, centroidZ = 0, weight = 0;
    let avgR = 0, avgG = 0, avgB = 0;
    let count = 0;
    const exposure = params.environmentIntensity * 0.5;
    for (let y = 0; y < H; y += step) {
      const v = (y + 0.5) / H;
      const theta = v * Math.PI;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      for (let x = 0; x < W; x += step) {
        const idx = (y * W + x) * 4;
        const rawR = data[idx];
        const rawG = data[idx + 1];
        const rawB = data[idx + 2];
        const b = rawR + rawG + rawB;
        if (b < threshold) continue;
        const u = (x + 0.5) / W;
        const phi = (u - 0.5) * 2 * Math.PI;
        const dx = sinT * Math.cos(phi);
        const dy = cosT;
        const dz = sinT * Math.sin(phi);
        centroidX += dx * b;
        centroidY += dy * b;
        centroidZ += dz * b;
        weight += b;
        avgR += (rawR * exposure) / (1 + rawR * exposure);
        avgG += (rawG * exposure) / (1 + rawG * exposure);
        avgB += (rawB * exposure) / (1 + rawB * exposure);
        count++;
      }
    }
    if (count > 0) {
      sunAverageColor = {
        r: avgR / count,
        g: avgG / count,
        b: avgB / count,
      };
    }
    if (weight > 0) {
      sunDirection = new Vector3(
        centroidX / weight,
        centroidY / weight,
        centroidZ / weight,
      ).normalize();
    }
    if (typeof console !== "undefined" && console.log) {
      const angle = sunDirection
        ? Math.acos(Math.max(-1, Math.min(1, sunDirection.y))) * 180 / Math.PI
        : 0;
      const avgL =
        sunAverageColor.r * 0.299 +
        sunAverageColor.g * 0.587 +
        sunAverageColor.b * 0.114;
      console.log(
        `[brutalistVR6] BVH sun: centroid elevation ${(90 - angle).toFixed(1)}° from ${count} bright pixels above ${(SUN_REGION_THRESHOLD * 100).toFixed(1)}% of peak; jitter cone ±${(Math.atan(SUN_JITTER / 2) * 180 / Math.PI).toFixed(1)}°; avg luminance ${avgL.toFixed(3)}; path tracer: ${MAX_BOUNCES} bounces, albedo ${BOUNCE_ALBEDO.toFixed(2)}, terminator ${BOUNCE_ENABLED ? "skyFill" : "0"}`,
      );
    }
  }

  function sampleHDR(direction) {
    if (!envData) return { r: 0.7, g: 0.7, b: 0.7 };
    const u = 0.5 + Math.atan2(direction.z, direction.x) / (2 * Math.PI);
    const v = 0.5 - Math.asin(Math.max(-1, Math.min(1, direction.y))) / Math.PI;
    const px = Math.floor(u * envData.width) % envData.width;
    const py = Math.floor(v * envData.height) % envData.height;
    const idx = (py * envData.width + px) * 4;
    const rawR = envData.data[idx];
    const rawG = envData.data[idx + 1];
    const rawB = envData.data[idx + 2];
    const exposure = params.environmentIntensity * 0.5;
    const tonemapR = (rawR * exposure) / (1 + rawR * exposure);
    const tonemapG = (rawG * exposure) / (1 + rawG * exposure);
    const tonemapB = (rawB * exposure) / (1 + rawB * exposure);
    return { r: tonemapR, g: tonemapG, b: tonemapB };
  }

  /**
   * Cosine-weighted upper-hemisphere average of the HDR, computed once. Two
   * variants are produced from the same sample set:
   *   - `skyAverageRaw`: the unblocked-sky contribution. A sky ray that
   *     escapes the BVH used to read `sampleHDR(dir)` directly, which produced
   *     visible per-texel noise on the lit floor (one direction landing on
   *     the sun returns ~0.95, the next direction returns ~0.4 — with only
   *     ~6 sky samples per texel and a strong display boost the variance
   *     becomes a fine-grained noise texture). Replacing the per-direction
   *     read with this constant keeps the right *energy* and zero variance.
   *   - `skyFill`: the blocked-ray contribution. Same average, scaled by
   *     `BOUNCE_ALBEDO` to model multi-bounce attenuation.
   * Excludes the brightest 0.5 % of samples so the sun spike doesn't push
   * fill into "sunlit room" territory.
   */
  function computeSkyAverages() {
    if (!envData) {
      return {
        raw: { r: 0.4, g: 0.4, b: 0.4 },
        fill: { r: 0.4 * BOUNCE_ALBEDO, g: 0.4 * BOUNCE_ALBEDO, b: 0.4 * BOUNCE_ALBEDO },
      };
    }
    const N = 512;
    const tmpRng = mulberry32(0x5dee5);
    const up = new Vector3(0, 1, 0);
    const samples = [];
    for (let i = 0; i < N; i++) {
      const dir = randomCosineHemisphere(up, tmpRng);
      const env = sampleHDR(dir);
      samples.push(env);
    }
    samples.sort((a, b) => b.r + b.g + b.b - (a.r + a.g + a.b));
    const trim = Math.floor(N * 0.005);
    let r = 0, g = 0, b = 0;
    for (let i = trim; i < N; i++) {
      r += samples[i].r;
      g += samples[i].g;
      b += samples[i].b;
    }
    const denom = N - trim;
    const raw = { r: r / denom, g: g / denom, b: b / denom };
    return {
      raw,
      fill: {
        r: raw.r * BOUNCE_ALBEDO,
        g: raw.g * BOUNCE_ALBEDO,
        b: raw.b * BOUNCE_ALBEDO,
      },
    };
  }

  const skyAverages = computeSkyAverages();
  const skyAverageRaw = skyAverages.raw;
  const skyFill = BOUNCE_ENABLED
    ? skyAverages.fill
    : { r: OCCLUDED_FLOOR, g: OCCLUDED_FLOOR, b: OCCLUDED_FLOOR };

  /**
   * Add the next-event-estimation (NEE) sun contribution to the running
   * accumulators for one path at one surface point, attenuated by the path's
   * current throughput. Single jittered shadow ray; if it reaches the sun
   * unblocked, contributes `sunAverageColor` (constant — colour variance
   * comes from sun visibility, not from sampling the HDR per ray).
   *
   * Returns the pair of accumulated `[r,g,b]` increments via the `out` arg.
   * (We add to caller's totalR/G/B inline because returning an object would
   * allocate per call. Out-arrays of length 3 are reused by the caller.)
   */
  function neeSun(curOrigin, curNormal, throughR, throughG, throughB, rng, out) {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    if (!sunDirection) return;
    const sunDot = curNormal.dot(sunDirection);
    if (sunDot <= 0) return;
    const jx = (rng() - 0.5) * SUN_JITTER;
    const jy = (rng() - 0.5) * SUN_JITTER;
    const jz = (rng() - 0.5) * SUN_JITTER;
    _ptSunDir
      .copy(sunDirection)
      .add(_ptJitter.set(jx, jy, jz))
      .normalize();
    if (curNormal.dot(_ptSunDir) <= 0) return;
    _ptOffsetOrigin
      .copy(curOrigin)
      .addScaledVector(curNormal, RAY_ORIGIN_OFFSET);
    _ptRay.origin.copy(_ptOffsetOrigin);
    _ptRay.direction.copy(_ptSunDir);
    const blocker = sceneBVH.raycastFirst(
      _ptRay,
      FrontSide,
      RAY_CAST_NEAR_SKIP,
      Infinity,
    );
    if (blocker) return;
    out[0] = throughR * sunAverageColor.r;
    out[1] = throughG * sunAverageColor.g;
    out[2] = throughB * sunAverageColor.b;
  }

  /* Reused per-call output of `neeSun` to avoid per-NEE allocation. */
  const _neeOut = [0, 0, 0];

  function computeLightingBVH(worldPos, normal, numSamples, rasterSeed) {
    if (!sunDirection) findSunInHDR();
    let seed;
    if (rasterSeed !== undefined && rasterSeed !== null) {
      seed = (rasterSeed >>> 0) || 1;
    } else {
      seed =
        Math.floor(
          Math.abs(worldPos.x * 73856093) ^
            Math.abs(worldPos.y * 19349663) ^
            Math.abs(worldPos.z * 83492791),
        ) + 1;
    }
    pixelRandom = mulberry32(seed);

    /* MAX_BOUNCES === 0 is a degenerate "direct sun NEE only" mode kept for
     * debugging — no hemisphere sampling, no GI, no fill. Caller would normally
     * use ?bvhMaxBounces=1+ for any visible result. */
    if (MAX_BOUNCES === 0) {
      let totalR = 0,
        totalG = 0,
        totalB = 0;
      for (let s = 0; s < numSamples; s++) {
        neeSun(worldPos, normal, 1, 1, 1, pixelRandom, _neeOut);
        totalR += _neeOut[0];
        totalG += _neeOut[1];
        totalB += _neeOut[2];
      }
      return {
        r: Math.min(1, totalR / numSamples),
        g: Math.min(1, totalG / numSamples),
        b: Math.min(1, totalB / numSamples),
      };
    }

    let totalR = 0,
      totalG = 0,
      totalB = 0;

    for (let s = 0; s < numSamples; s++) {
      let throughR = 1,
        throughG = 1,
        throughB = 1;
      _ptCurOrigin.copy(worldPos);
      _ptCurNormal.copy(normal);

      /* NEE sun at primary surface (depth 0). */
      neeSun(
        _ptCurOrigin,
        _ptCurNormal,
        throughR,
        throughG,
        throughB,
        pixelRandom,
        _neeOut,
      );
      totalR += _neeOut[0];
      totalG += _neeOut[1];
      totalB += _neeOut[2];

      /* Bounce loop. Each iteration casts one cosine-weighted hemisphere ray;
       * on hit, advances to that surface and does NEE there; on escape, adds
       * sky contribution and ends the path. After `MAX_BOUNCES` bounces with
       * no escape, the terminator below adds the final fill term. */
      let escaped = false;
      for (let depth = 0; depth < MAX_BOUNCES; depth++) {
        /* `randomCosineHemisphere` writes into the scratch `_ptBounceDir`
         * (no allocation) — see comment on the function. */
        randomCosineHemisphere(_ptCurNormal, pixelRandom, _ptBounceDir);
        _ptOffsetOrigin
          .copy(_ptCurOrigin)
          .addScaledVector(_ptCurNormal, RAY_ORIGIN_OFFSET);
        _ptRay.origin.copy(_ptOffsetOrigin);
        _ptRay.direction.copy(_ptBounceDir);
        const hit = sceneBVH.raycastFirst(
          _ptRay,
          FrontSide,
          RAY_CAST_NEAR_SKIP,
          Infinity,
        );

        if (!hit) {
          totalR += throughR * skyAverageRaw.r;
          totalG += throughG * skyAverageRaw.g;
          totalB += throughB * skyAverageRaw.b;
          escaped = true;
          break;
        }

        /* Advance to hit surface. With FrontSide culling, `hit.face.normal`
         * points back toward where the ray came from — i.e. it is already
         * the outward surface normal we want for the next bounce/NEE. */
        _ptCurOrigin.copy(hit.point);
        _ptCurNormal.copy(hit.face.normal).normalize();
        throughR *= BOUNCE_ALBEDO;
        throughG *= BOUNCE_ALBEDO;
        throughB *= BOUNCE_ALBEDO;

        /* NEE sun at the new surface (every bounce). */
        neeSun(
          _ptCurOrigin,
          _ptCurNormal,
          throughR,
          throughG,
          throughB,
          pixelRandom,
          _neeOut,
        );
        totalR += _neeOut[0];
        totalG += _neeOut[1];
        totalB += _neeOut[2];
      }

      if (!escaped) {
        /* Path reached MAX_BOUNCES without escaping — terminate with implicit
         * ambient fill (skyFill, already × BOUNCE_ALBEDO once). With
         * `?bounce=0` the terminator becomes the OCCLUDED_FLOOR constant
         * baked into `skyFill` below — very dark. */
        totalR += throughR * skyFill.r;
        totalG += throughG * skyFill.g;
        totalB += throughB * skyFill.b;
      }
    }

    return {
      r: Math.min(1, totalR / numSamples),
      g: Math.min(1, totalG / numSamples),
      b: Math.min(1, totalB / numSamples),
    };
  }

  return {
    computeLightingBVH,
    findSunInHDR,
    /* Read by main.js to align the procedural Sky's sun with the HDR-derived
     * sun used by the BVH bake — keeps visible sun and baked shadows in sync. */
    get sunDirection() {
      return sunDirection;
    },
  };
}

function yieldToPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/**
 * @param {import('three').Mesh} mesh
 * @param {number} size
 * @param {number} shadowSamples
 * @param {(s: string) => void} [onStatus]
 * @param {(meshPct: number, detail: string) => void} [onProgress] 0–100 within this mesh; lets UI repaint while baking
 * @param {number} [denoiseIterations=1] bilateral passes (3 blurs fine detail on large lightmaps — use 0–1 while iterating)
 * @param {number} [lightmapPunch=1.38] contrast around midpoint after denoise (1 = off)
 */
export async function bakeObjectBVH(
  mesh,
  size,
  shadowSamples,
  lighting,
  onStatus,
  onProgress,
  denoiseIterations = 1,
  lightmapPunch = 1.38,
) {
  const { computeLightingBVH } = lighting;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(size, size);
  mesh.updateMatrixWorld(true);
  const geometry = mesh.geometry;
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal;
  const uvs = geometry.attributes.uv2 || geometry.attributes.uv;
  const index = geometry.index;
  if (!uvs || !normals) {
    ctx.putImageData(imageData, 0, 0);
    const tex = new CanvasTexture(canvas);
    tex.flipY = true;
    tex.colorSpace = SRGBColorSpace;
    configureLightmapCanvasTexture(tex);
    return tex;
  }
  const triangleCount = index ? index.count / 3 : positions.count / 3;
  const isCanonicalBox =
    geometry instanceof BoxGeometry && positions.count === 24 && !!geometry.attributes.uv2;
  const uv0 = new Vector2();
  const uv1 = new Vector2();
  const uv2 = new Vector2();
  const p0 = new Vector3();
  const p1 = new Vector3();
  const p2 = new Vector3();
  const n0 = new Vector3();
  const rot = new Matrix4();
  let innerSamples = 0;
  const yieldEvery = Math.max(64, Math.floor(size * 0.25));
  if (isCanonicalBox) {
    const faces = buildBoxFaceBakeData(mesh, geometry);
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi];
      const minU = Math.max(0, Math.floor(f.minU * size) - 1);
      const maxU = Math.min(size - 1, Math.ceil(f.maxU * size) + 1);
      const minV = Math.max(0, Math.floor(f.minV * size) - 1);
      const maxV = Math.min(size - 1, Math.ceil(f.maxV * size) + 1);
      const du1 = f.uv1.x - f.uv0.x;
      const dv1 = f.uv1.y - f.uv0.y;
      const du2 = f.uv2.x - f.uv0.x;
      const dv2 = f.uv2.y - f.uv0.y;
      const e1 = f.p1.clone().sub(f.p0);
      const e2 = f.p2.clone().sub(f.p0);
      for (let py = minV; py <= maxV; py++) {
        for (let px = minU; px <= maxU; px++) {
          innerSamples++;
          if (innerSamples % yieldEvery === 0) {
            const rowSpan = Math.max(1, maxV - minV + 1);
            const local = (py - minV + (px - minU + 1) / Math.max(1, maxU - minU + 1)) / rowSpan;
            const meshPct = Math.min(99, ((fi + Math.max(0, Math.min(1, local))) / faces.length) * 100);
            if (onProgress) onProgress(meshPct, `${mesh.name} · BVH rays (face ${fi + 1}/${faces.length})`);
            if (onStatus) onStatus(`BVH: ${mesh.name} ~${Math.floor(meshPct)}%`);
            await yieldToPaint();
          }
          const u = (px + 0.5) / size;
          const v = (py + 0.5) / size;
          if (u < f.minU || u > f.maxU || v < f.minV || v > f.maxV) continue;
          const du = u - f.uv0.x;
          const dv = v - f.uv0.y;
          const a = (du * dv2 - dv * du2) / f.det;
          const b = (dv * du1 - du * dv1) / f.det;
          const worldPos = f.p0.clone().addScaledVector(e1, a).addScaledVector(e2, b);
          const color = computeLightingBVH(
            worldPos,
            f.normal,
            shadowSamples,
            bakeRasterSeed(px, py, f.face, mesh.name),
          );
          const flippedPy = size - 1 - py;
          const out = (flippedPy * size + px) * 4;
          imageData.data[out] = Math.min(255, Math.floor(color.r * 255));
          imageData.data[out + 1] = Math.min(255, Math.floor(color.g * 255));
          imageData.data[out + 2] = Math.min(255, Math.floor(color.b * 255));
          imageData.data[out + 3] = 255;
        }
      }
      const meshPct = Math.min(99, ((fi + 1) / Math.max(1, faces.length)) * 100);
      if (onProgress) onProgress(meshPct, `${mesh.name} · face ${fi + 1}/${faces.length}`);
      if (onStatus) onStatus(`BVH: ${mesh.name} ~${Math.floor(meshPct)}%`);
      await yieldToPaint();
    }
  } else {
  for (let t = 0; t < triangleCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    uv0.set(uvs.getX(i0), uvs.getY(i0));
    uv1.set(uvs.getX(i1), uvs.getY(i1));
    uv2.set(uvs.getX(i2), uvs.getY(i2));
    p0.set(positions.getX(i0), positions.getY(i0), positions.getZ(i0)).applyMatrix4(mesh.matrixWorld);
    p1.set(positions.getX(i1), positions.getY(i1), positions.getZ(i1)).applyMatrix4(mesh.matrixWorld);
    p2.set(positions.getX(i2), positions.getY(i2), positions.getZ(i2)).applyMatrix4(mesh.matrixWorld);
    n0.set(normals.getX(i0), normals.getY(i0), normals.getZ(i0));
    n0.applyMatrix4(rot.extractRotation(mesh.matrixWorld)).normalize();
    const minU = Math.max(0, Math.floor(Math.min(uv0.x, uv1.x, uv2.x) * size) - 1);
    const maxU = Math.min(size - 1, Math.ceil(Math.max(uv0.x, uv1.x, uv2.x) * size) + 1);
    const minV = Math.max(0, Math.floor(Math.min(uv0.y, uv1.y, uv2.y) * size) - 1);
    const maxV = Math.min(size - 1, Math.ceil(Math.max(uv0.y, uv1.y, uv2.y) * size) + 1);
    for (let py = minV; py <= maxV; py++) {
      for (let px = minU; px <= maxU; px++) {
        innerSamples++;
        if (innerSamples % yieldEvery === 0) {
          const rowSpan = Math.max(1, maxV - minV + 1);
          const triLocal = (py - minV + (px - minU + 1) / Math.max(1, maxU - minU + 1)) / rowSpan;
          const meshPct = Math.min(99, ((t + Math.max(0, Math.min(1, triLocal))) / triangleCount) * 100);
          if (onProgress) onProgress(meshPct, `${mesh.name} · BVH rays (tri ${t + 1}/${triangleCount})`);
          if (onStatus) onStatus(`BVH: ${mesh.name} ~${Math.floor(meshPct)}%`);
          await yieldToPaint();
        }
        const u = (px + 0.5) / size;
        const v = (py + 0.5) / size;
        const bary = barycentric(u, v, uv0, uv1, uv2);
        if (bary.x < -0.01 || bary.y < -0.01 || bary.z < -0.01) continue;
        const worldPos = new Vector3()
          .addScaledVector(p0, bary.x)
          .addScaledVector(p1, bary.y)
          .addScaledVector(p2, bary.z);
        const normal = n0.clone();
        const color = computeLightingBVH(
          worldPos,
          normal,
          shadowSamples,
          bakeRasterSeed(px, py, t, mesh.name),
        );
        const flippedPy = size - 1 - py;
        const idx = (flippedPy * size + px) * 4;
        imageData.data[idx] = Math.min(255, Math.floor(color.r * 255));
        imageData.data[idx + 1] = Math.min(255, Math.floor(color.g * 255));
        imageData.data[idx + 2] = Math.min(255, Math.floor(color.b * 255));
        imageData.data[idx + 3] = 255;
      }
    }
    if (t % 2 === 0) {
      const meshPct = Math.min(99, ((t + 1) / triangleCount) * 100);
      if (onProgress) onProgress(meshPct, `${mesh.name} · tri ${t + 1}/${triangleCount}`);
      if (onStatus) onStatus(`BVH: ${mesh.name} ~${Math.floor(meshPct)}%`);
      await yieldToPaint();
    }
  }
  }
  if (onProgress) onProgress(100, `${mesh.name} · dilate`);
  if (onStatus) onStatus(`BVH: ${mesh.name} · dilating…`);
  await yieldToPaint();
  dilatePixels(imageData, size, 5);
  if (onStatus) onStatus(`BVH: ${mesh.name} · denoise…`);
  await yieldToPaint();
  if (denoiseIterations > 0) denoiseTexture(imageData, size, denoiseIterations);
  punchLightmapContrast(imageData, size, lightmapPunch, 0.38);
  ctx.putImageData(imageData, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.flipY = true;
  texture.colorSpace = SRGBColorSpace;
  configureLightmapCanvasTexture(texture);
  return texture;
}
