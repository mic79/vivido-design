/**
 * Impact shatter — convex hull shards per body region (module THREE on model).
 * Baked triangle soup matches the mesh but does not render in this A-Frame + module GLB setup;
 * convex hulls on the same tree are visible. Regions are split per-bone for limb separation.
 */
(function () {
  const THREE = window.AFRAME.THREE;

  const _v = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _box = new THREE.Box3();
  const _mat4 = new THREE.Matrix4();
  const _plane = new THREE.Plane();
  const _uv = new THREE.Vector2();
  const _skinT = new THREE.Vector3();
  const _skinAcc = new THREE.Vector3();
  const _skinIdx = new THREE.Vector4();
  const _skinW = new THREE.Vector4();
  const _baryAB = new THREE.Vector3();
  const _baryAC = new THREE.Vector3();
  const _baryAP = new THREE.Vector3();
  const _baryVA = new THREE.Vector3();
  const _baryVB = new THREE.Vector3();
  const _baryVC = new THREE.Vector3();

  function createRenderFactory(refMesh) {
    const GeoClass = refMesh.geometry.constructor;
    const MeshClass = Object.getPrototypeOf(refMesh.constructor);
    const GroupClass = refMesh.parent ? refMesh.parent.constructor : MeshClass;
    const Vector3Class = refMesh.position.constructor;

    return {
      Vector3Class,
      GroupClass,
      MeshClass,

      makeGroup: function () {
        const g = new GroupClass();
        g.frustumCulled = false;
        return g;
      },

      makeMesh: function (geometry, material) {
        const mesh = new MeshClass(geometry, material);
        mesh.frustumCulled = false;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.renderOrder = 10;
        mesh.userData.isRagdollShard = true;
        return mesh;
      },

      resolveMaterial: function (mesh, matIdx) {
        if (!mesh) return null;
        const src = Array.isArray(mesh.material)
          ? mesh.material[matIdx] || mesh.material[0]
          : mesh.material;
        if (!src) return null;
        // Share the GLB's live material so body textures stay (clone was grey on mat 0).
        return src;
      }
    };
  }

  function triangleMaterialIndex(geo, indexOffset) {
    const groups = geo.groups;
    if (!groups || !groups.length) return 0;
    for (let g = 0; g < groups.length; g++) {
      const gr = groups[g];
      if (indexOffset >= gr.start && indexOffset < gr.start + gr.count) {
        return gr.materialIndex || 0;
      }
    }
    return 0;
  }

  function bucketKey(region, matIdx) {
    return region + ':' + matIdx;
  }

  /** Fine regions — separate upper/lower arm and leg so convex hulls are not one giant blob. */
  const BONE_NAME_TO_REGION = {
    mixamorigHips: 'hips',
    mixamorigSpine: 'torso',
    mixamorigSpine1: 'torso',
    mixamorigSpine2: 'chest',
    mixamorigNeck: 'neck',
    mixamorigHead: 'head',
    mixamorigLeftShoulder: 'leftUpperArm',
    mixamorigLeftArm: 'leftUpperArm',
    mixamorigLeftForeArm: 'leftForearm',
    mixamorigLeftHand: 'leftHand',
    mixamorigRightShoulder: 'rightUpperArm',
    mixamorigRightArm: 'rightUpperArm',
    mixamorigRightForeArm: 'rightForearm',
    mixamorigRightHand: 'rightHand',
    mixamorigLeftUpLeg: 'leftThigh',
    mixamorigLeftLeg: 'leftShin',
    mixamorigLeftFoot: 'leftFoot',
    mixamorigRightUpLeg: 'rightThigh',
    mixamorigRightLeg: 'rightShin',
    mixamorigRightFoot: 'rightFoot'
  };

  function normBoneName(name) {
    return name.replace(/^mixamorig:/, 'mixamorig');
  }

  function buildBoneIndexToRegion(skeleton) {
    const map = new Array(skeleton.bones.length);
    for (let i = 0; i < skeleton.bones.length; i++) map[i] = null;
    for (let i = 0; i < skeleton.bones.length; i++) {
      const key = normBoneName(skeleton.bones[i].name);
      if (BONE_NAME_TO_REGION[key]) map[i] = BONE_NAME_TO_REGION[key];
    }
    return map;
  }

  function computeSkinnedVertexWorld(mesh, vi, target) {
    const geo = mesh.geometry;
    const posAttr = geo.attributes.position;
    const skinIndex = geo.attributes.skinIndex;
    const skinWeight = geo.attributes.skinWeight;
    const skeleton = mesh.skeleton;
    target.fromBufferAttribute(posAttr, vi);

    if (!skeleton || !skinIndex || !skinWeight) {
      return mesh.localToWorld(target);
    }

    const boneMatrices = skeleton.boneMatrices;
    const boneCount = skeleton.bones.length;
    _skinT.copy(target).applyMatrix4(mesh.bindMatrix);
    _skinAcc.set(0, 0, 0);
    _skinIdx.fromBufferAttribute(skinIndex, vi);
    _skinW.fromBufferAttribute(skinWeight, vi);

    for (let j = 0; j < 4; j++) {
      const w = _skinW.getComponent(j);
      if (w === 0) continue;
      const bi = _skinIdx.getComponent(j) | 0;
      if (bi < 0 || bi >= boneCount) continue;
      _mat4.fromArray(boneMatrices, bi * 16);
      _skinAcc.addScaledVector(_v.copy(_skinT).applyMatrix4(_mat4), w);
    }

    target.copy(_skinAcc).applyMatrix4(mesh.bindMatrixInverse);
    mesh.localToWorld(target);

    if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
      target.fromBufferAttribute(posAttr, vi);
      mesh.localToWorld(target);
    }
    return target;
  }

  function accumulateVertexRegions(mesh, vi, boneToRegion, totals, weightScale) {
    weightScale = weightScale == null ? 1 : weightScale;
    const geo = mesh.geometry;
    const skinIndex = geo.attributes.skinIndex;
    const skinWeight = geo.attributes.skinWeight;
    if (!skinIndex || !skinWeight || !mesh.skeleton) return;

    _skinIdx.fromBufferAttribute(skinIndex, vi);
    _skinW.fromBufferAttribute(skinWeight, vi);

    for (let j = 0; j < 4; j++) {
      const w = _skinW.getComponent(j) * weightScale;
      if (w <= 0) continue;
      const bi = _skinIdx.getComponent(j) | 0;
      const r = boneToRegion[bi];
      if (!r) continue;
      totals[r] = (totals[r] || 0) + w;
    }
  }

  function pickRegionFromTotals(totals) {
    let bestR = 'torso';
    let bestW = 0;
    let bestLimbR = null;
    let bestLimbW = 0;

    const keys = Object.keys(totals);
    if (!keys.length) return 'torso';

    for (let i = 0; i < keys.length; i++) {
      const r = keys[i];
      const w = totals[r];
      if (LIMB_DAMAGE_CHAINS[r] && w > bestLimbW) {
        bestLimbW = w;
        bestLimbR = r;
      }
      if (w > bestW) {
        bestW = w;
        bestR = r;
      }
    }

    if (bestLimbR && CORE_TORSO_REGIONS[bestR] && bestLimbW >= bestW * 0.55) {
      return bestLimbR;
    }
    return bestR;
  }

  function vertexRegion(mesh, vi, boneToRegion) {
    const totals = {};
    accumulateVertexRegions(mesh, vi, boneToRegion, totals);
    return pickRegionFromTotals(totals);
  }

  function triangleRegion(mesh, i0, i1, i2, boneToRegion) {
    const totals = {};
    accumulateVertexRegions(mesh, i0, boneToRegion, totals);
    accumulateVertexRegions(mesh, i1, boneToRegion, totals);
    accumulateVertexRegions(mesh, i2, boneToRegion, totals);
    return pickRegionFromTotals(totals);
  }

  function pushTriangle(bucket, p0, p1, p2) {
    bucket.positions.push(
      p0.x, p0.y, p0.z,
      p1.x, p1.y, p1.z,
      p2.x, p2.y, p2.z
    );
  }

  function buildTriangleRegionIndex(skinnedMeshes, boneToRegion) {
    const index = {};
    for (let m = 0; m < skinnedMeshes.length; m++) {
      const mesh = skinnedMeshes[m];
      const geo = mesh.geometry;
      const posAttr = geo.attributes.position;
      const triAttr = geo.index;
      const triCount = triAttr ? triAttr.count / 3 : posAttr.count / 3;

      for (let t = 0; t < triCount; t++) {
        const i0 = triAttr ? triAttr.getX(t * 3) : t * 3;
        const i1 = triAttr ? triAttr.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = triAttr ? triAttr.getX(t * 3 + 2) : t * 3 + 2;
        const matIdx = triangleMaterialIndex(geo, t * 3);
        const region = triangleRegion(mesh, i0, i1, i2, boneToRegion);
        if (!index[region]) index[region] = [];
        index[region].push({ m, t, matIdx });
      }
    }
    return index;
  }

  function skinTriangleToBucket(mesh, t, matIdx, region, spaceInverse, buckets) {
    const geo = mesh.geometry;
    const index = geo.index;
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const key = bucketKey(region, matIdx);

    if (!buckets[key]) {
      buckets[key] = {
        id: region,
        matIdx,
        meshRef: mesh,
        positions: []
      };
    }

    computeSkinnedVertexWorld(mesh, i0, _v);
    computeSkinnedVertexWorld(mesh, i1, _v2);
    computeSkinnedVertexWorld(mesh, i2, _v3);
    if (spaceInverse) {
      _v.applyMatrix4(spaceInverse);
      _v2.applyMatrix4(spaceInverse);
      _v3.applyMatrix4(spaceInverse);
    }

    if (
      !Number.isFinite(_v.x) || !Number.isFinite(_v.y) || !Number.isFinite(_v.z) ||
      !Number.isFinite(_v2.x) || !Number.isFinite(_v2.y) || !Number.isFinite(_v2.z) ||
      !Number.isFinite(_v3.x) || !Number.isFinite(_v3.y) || !Number.isFinite(_v3.z)
    ) {
      return;
    }

    pushTriangle(buckets[key], _v, _v2, _v3);
  }

  function finalizeBucketCentroid(bucket) {
    const pos = bucket.positions;
    if (pos.length < 3) return false;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let n = 0;
    for (let i = 0; i < pos.length; i += 3) {
      cx += pos[i];
      cy += pos[i + 1];
      cz += pos[i + 2];
      n++;
    }
    bucket.centroidX = cx / n;
    bucket.centroidY = cy / n;
    bucket.centroidZ = cz / n;
    return true;
  }

  function buildEntriesCatalog(buckets) {
    const catalog = {};
    const keys = Object.keys(buckets);
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      const bucket = buckets[key];
      if (bucket.positions.length < 12) continue;
      const id = bucket.id;
      if (!catalog[id]) catalog[id] = [];
      catalog[id].push({
        id,
        matIdx: bucket.matIdx,
        key,
        bucket,
        dist: Infinity
      });
    }
    return catalog;
  }

  function entryDistance(entry, localImpact, V3Class) {
    const bucket = entry.bucket;
    if (bucket.centroidX != null) {
      return Math.sqrt(bucketCentroidDistSq(bucket, localImpact));
    }
    return bucketDistanceToPoint(bucket, localImpact, V3Class);
  }

  function collectFromCatalog(store, impactPoint, spaceInverse, skipRegions, regionIds) {
    const V3Class = store.V3Class || THREE.Vector3;
    const localImpact = new V3Class().copy(impactPoint);
    if (spaceInverse) localImpact.applyMatrix4(spaceInverse);

    const entries = [];
    const catalog = store.entriesCatalog;
    if (!catalog) return { entries, V3Class, localImpact };

    const ids = regionIds?.length
      ? regionIds
      : Object.keys(catalog);

    for (let r = 0; r < ids.length; r++) {
      const list = catalog[ids[r]];
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (skipRegions && skipRegions[entry.key]) continue;
        if (entry.bucket.positions.length < 12) continue;
        entry.dist = entryDistance(entry, localImpact, V3Class);
        entries.push(entry);
      }
    }

    entries.sort((a, b) => a.dist - b.dist);
    return { entries, V3Class, localImpact };
  }

  function bakeRegionBuckets(skinnedMeshes, spaceInverse, boneToRegion, triIndex) {
    const buckets = {};
    if (!skinnedMeshes.length) return buckets;

    boneToRegion = boneToRegion || buildBoneIndexToRegion(skinnedMeshes[0].skeleton);
    triIndex = triIndex || buildTriangleRegionIndex(skinnedMeshes, boneToRegion);

    const regionIds = Object.keys(triIndex);
    for (let r = 0; r < regionIds.length; r++) {
      const region = regionIds[r];
      const tris = triIndex[region];
      for (let i = 0; i < tris.length; i++) {
        const ref = tris[i];
        const mesh = skinnedMeshes[ref.m];
        skinTriangleToBucket(mesh, ref.t, ref.matIdx, region, spaceInverse, buckets);
      }
    }

    return buckets;
  }

  function finalizeBucketCentroids(buckets) {
    const keys = Object.keys(buckets);
    for (let k = 0; k < keys.length; k++) {
      const bucket = buckets[keys[k]];
      if (!finalizeBucketCentroid(bucket)) {
        delete buckets[keys[k]];
      }
    }
  }

  const _moduleBucketCache = { buckets: null };

  function populateShatterStore(skinnedMeshes, spaceInverse, store) {
    const skeleton = skinnedMeshes[0]?.skeleton;
    store.boneToRegion = skeleton ? buildBoneIndexToRegion(skeleton) : [];
    store.triIndex = buildTriangleRegionIndex(skinnedMeshes, store.boneToRegion);
    store.buckets = bakeRegionBuckets(
      skinnedMeshes,
      spaceInverse || null,
      store.boneToRegion,
      store.triIndex
    );
    finalizeBucketCentroids(store.buckets);
    store.entriesCatalog = buildEntriesCatalog(store.buckets);
    const factory = createRenderFactory(skinnedMeshes[0]);
    store.factory = factory;
    store.V3Class = factory.Vector3Class;
    store.ready = true;
    return store.buckets;
  }

  function ensureBucketCache(skinnedMeshes, spaceInverse, store) {
    store = store || _moduleBucketCache;
    if (store.buckets && store.ready) return store.buckets;
    return populateShatterStore(skinnedMeshes, spaceInverse, store);
  }

  /** Re-skin only the buckets touched by this shot (indexed triangles, not full mesh scan). */
  function patchBucketsForRegions(skinnedMeshes, spaceInverse, store, regionIds) {
    if (!skinnedMeshes?.length || !regionIds?.length) {
      return ensureBucketCache(skinnedMeshes, spaceInverse, store);
    }
    store = store || _moduleBucketCache;
    const buckets = ensureBucketCache(skinnedMeshes, spaceInverse, store);
    const triIndex = store.triIndex;
    const idSet = {};
    for (let i = 0; i < regionIds.length; i++) idSet[regionIds[i]] = true;

    const keys = Object.keys(buckets);
    for (let k = 0; k < keys.length; k++) {
      if (idSet[buckets[keys[k]].id]) delete buckets[keys[k]];
    }

    if (triIndex) {
      for (let r = 0; r < regionIds.length; r++) {
        const region = regionIds[r];
        const tris = triIndex[region];
        if (!tris) continue;
        for (let i = 0; i < tris.length; i++) {
          const ref = tris[i];
          skinTriangleToBucket(
            skinnedMeshes[ref.m],
            ref.t,
            ref.matIdx,
            region,
            spaceInverse,
            buckets
          );
        }
      }
    }

    const bucketKeys = Object.keys(buckets);
    for (let k = 0; k < bucketKeys.length; k++) {
      const key = bucketKeys[k];
      const bucket = buckets[key];
      if (!idSet[bucket.id]) continue;
      if (!finalizeBucketCentroid(bucket)) delete buckets[key];
    }

    store.entriesCatalog = buildEntriesCatalog(buckets);
    return buckets;
  }

  function invalidateBucketCache(store) {
    store = store || _moduleBucketCache;
    store.buckets = null;
    store.triIndex = null;
    store.boneToRegion = null;
    store.entriesCatalog = null;
    store.factory = null;
    store.V3Class = null;
    store.ready = false;
  }

  function isBucketCacheReady(store) {
    store = store || _moduleBucketCache;
    return !!(store.ready && store.buckets);
  }

  function getOrBakeBuckets(skinnedMeshes, spaceInverse, bucketStore) {
    return ensureBucketCache(skinnedMeshes, spaceInverse, bucketStore || _moduleBucketCache);
  }

  function bucketCentroidDistSq(bucket, point) {
    const dx = bucket.centroidX - point.x;
    const dy = bucket.centroidY - point.y;
    const dz = bucket.centroidZ - point.z;
    return dx * dx + dy * dy + dz * dz;
  }

  const LARGE_REGIONS = {
    hips: 0.26,
    torso: 0.26,
    chest: 0.28,
    leftThigh: 0.3,
    rightThigh: 0.3,
    leftUpperArm: 0.24,
    rightUpperArm: 0.24
  };

  const DEFAULT_MAX_EXTENT = 0.22;
  const PROXIMITY_RADIUS = 0.6;
  /** Legacy export — selection is now primary + skeleton neighbors, not a sphere. */
  const SHATTER_RADIUS = 0.36;
  const MIN_RESHATTER_SIZE = 0.07;
  /** Neighbor blowout — vertex distance only (model-local m). */
  const ADJACENT_LIMB_MAX = 0.09;
  const ADJACENT_SPINE_MAX = 0.065;
  const MAX_NEIGHBOR_ZONES = 1;
  /** Chest / belly / waist / groin — crater shards only; ragdoll mesh stays intact. */
  const CORE_TORSO_REGIONS = { hips: true, torso: true, chest: true };
  const SURFACE_CRATER_RADIUS = 0.14;
  /** Shots on a limb/head region before it fully breaks off (core torso stays crater-only). */
  const REGION_DAMAGE_MAX = 3;
  /** Core torso hits (chest / belly / groin) before the dummy collapses into ragdoll. */
  const BODY_HITS_TO_RAGDOLL = 5;
  const CRATER_RADIUS_BY_STAGE = { 1: 0.095, 2: 0.155 };
  const MAX_CRATER_SHARDS_BY_STAGE = { 1: 6, 2: 12 };
  /** Per-shot spawn budget — enough debris for impact feel without stutter. */
  const MAX_SHARDS_PER_SHOT = 28;
  /** Final blow that tears off a region — needs more pieces to replace hidden skin. */
  const MAX_SHARDS_FULL_DESTROY = 52;
  /**
   * Cap live debris — oldest shards are removed when this limit is exceeded.
   * This is PER RAGDOLL: CapVR fights 3 bots at once, so the effective on-screen
   * shard count is ~3× this. 128/bot (=~384 total) was the measured cause of the
   * sustained 8–10 ms/frame in syncShards when shooting bots. Keep it modest for
   * Quest. Tune live (per ragdoll) with window.__capvrMaxShards — no rebuild.
   */
  const MAX_ACTIVE_SHARDS = 48;
  let _shardSpawnSeq = 0;

  /** Box3D ragdoll body names to activate when a region is fully destroyed (pelvis stays kinematic). */
  const REGION_PHYSICS_BONES = {
    neck: ['neck', 'head'],
    head: ['neck', 'head'],
    leftThigh: ['thigh_l', 'calf_l'],
    leftShin: ['calf_l'],
    leftFoot: ['calf_l'],
    leftUpperArm: ['upper_arm_l', 'lower_arm_l', 'hand_l'],
    leftForearm: ['lower_arm_l', 'hand_l'],
    leftHand: ['lower_arm_l', 'hand_l'],
    rightThigh: ['thigh_r', 'calf_r'],
    rightShin: ['calf_r'],
    rightFoot: ['calf_r'],
    rightUpperArm: ['upper_arm_r', 'lower_arm_r', 'hand_r'],
    rightForearm: ['lower_arm_r', 'hand_r'],
    rightHand: ['lower_arm_r', 'hand_r']
  };

  function physicsBonesForRegionIds(regionIds) {
    const set = {};
    if (!regionIds?.length) return [];
    for (let i = 0; i < regionIds.length; i++) {
      const names = REGION_PHYSICS_BONES[regionIds[i]];
      if (!names) continue;
      for (let n = 0; n < names.length; n++) set[names[n]] = true;
    }
    return Object.keys(set);
  }
  const LIMB_CHAINS = {
    leftLeg: ['leftFoot', 'leftShin', 'leftThigh'],
    rightLeg: ['rightFoot', 'rightShin', 'rightThigh'],
    leftArm: ['leftHand', 'leftForearm', 'leftUpperArm'],
    rightArm: ['rightHand', 'rightForearm', 'rightUpperArm']
  };

  /** Shared damage pool per limb chain (all forearm/upper-arm/hand hits count together). */
  const LIMB_DAMAGE_CHAINS = {
    leftFoot: 'leftLeg',
    leftShin: 'leftLeg',
    leftThigh: 'leftLeg',
    rightFoot: 'rightLeg',
    rightShin: 'rightLeg',
    rightThigh: 'rightLeg',
    leftHand: 'leftArm',
    leftForearm: 'leftArm',
    leftUpperArm: 'leftArm',
    rightHand: 'rightArm',
    rightForearm: 'rightArm',
    rightUpperArm: 'rightArm'
  };

  function limbDamageChainKey(regionId) {
    return LIMB_DAMAGE_CHAINS[regionId] || regionId;
  }

  function chainMemberRegionIds(chainKey) {
    return LIMB_CHAINS[chainKey] ? LIMB_CHAINS[chainKey].slice() : null;
  }

  /** Prefer proximity limb over misclassified core torso — never override a face-hit limb. */
  function resolveHitRegion(entries, faceRegionId) {
    if (faceRegionId && !CORE_TORSO_REGIONS[faceRegionId]) {
      return faceRegionId;
    }

    const closest = entries?.length ? entries[0] : null;

    if (faceRegionId && CORE_TORSO_REGIONS[faceRegionId]) {
      // Belly / groin / chest: keep core-torso crater behavior unless impact is clearly on a limb.
      if (closest?.id && LIMB_DAMAGE_CHAINS[closest.id] && closest.dist < 0.08) {
        const torsoDist = minDistForRegion(entries, faceRegionId);
        if (torsoDist > closest.dist + 0.02) return closest.id;
      }
      return faceRegionId;
    }

    const closestLimb = closest?.id && LIMB_DAMAGE_CHAINS[closest.id] ? closest.id : null;
    if (closestLimb && closest.dist < 0.09) return closestLimb;
    return closest?.id || null;
  }

  function triangleVertexIndices(geo, faceIndex) {
    const index = geo.index;
    if (index) {
      return [
        index.getX(faceIndex * 3),
        index.getX(faceIndex * 3 + 1),
        index.getX(faceIndex * 3 + 2)
      ];
    }
    const base = faceIndex * 3;
    return [base, base + 1, base + 2];
  }

  function barycentricAtPoint(p, a, b, c) {
    _baryAB.subVectors(b, a);
    _baryAC.subVectors(c, a);
    _baryAP.subVectors(p, a);
    const d00 = _baryAB.dot(_baryAB);
    const d01 = _baryAB.dot(_baryAC);
    const d11 = _baryAC.dot(_baryAC);
    const d20 = _baryAP.dot(_baryAB);
    const d21 = _baryAP.dot(_baryAC);
    const denom = d00 * d11 - d01 * d01;
    if (Math.abs(denom) < 1e-12) return { u: 1 / 3, v: 1 / 3, w: 1 / 3 };
    const v = (d11 * d20 - d01 * d21) / denom;
    const w = (d00 * d21 - d01 * d20) / denom;
    const u = 1 - v - w;
    return { u, v, w };
  }

  function regionFromHitIntersection(mesh, hit) {
    if (!mesh?.geometry || hit?.faceIndex == null || hit.faceIndex < 0) return null;
    const geo = mesh.geometry;
    const skeleton = mesh.skeleton;
    const boneToRegion = skeleton ? buildBoneIndexToRegion(skeleton) : [];
    const idx = triangleVertexIndices(geo, hit.faceIndex);

    const totals = {};
    if (hit.point && skeleton) {
      const va = computeSkinnedVertexWorld(mesh, idx[0], _baryVA);
      const vb = computeSkinnedVertexWorld(mesh, idx[1], _baryVB);
      const vc = computeSkinnedVertexWorld(mesh, idx[2], _baryVC);
      const bc = barycentricAtPoint(hit.point, va, vb, vc);
      accumulateVertexRegions(mesh, idx[0], boneToRegion, totals, bc.u);
      accumulateVertexRegions(mesh, idx[1], boneToRegion, totals, bc.v);
      accumulateVertexRegions(mesh, idx[2], boneToRegion, totals, bc.w);
    } else {
      accumulateVertexRegions(mesh, idx[0], boneToRegion, totals, 1);
      accumulateVertexRegions(mesh, idx[1], boneToRegion, totals, 1);
      accumulateVertexRegions(mesh, idx[2], boneToRegion, totals, 1);
    }
    return pickRegionFromTotals(totals);
  }

  const REGION_TO_LIMB_CHAIN = {};
  Object.keys(LIMB_CHAINS).forEach((chainKey) => {
    const members = LIMB_CHAINS[chainKey];
    for (let i = 0; i < members.length; i++) {
      REGION_TO_LIMB_CHAIN[members[i]] = chainKey;
    }
  });

  /** Direct neighbors for impact blowout (one hop only — no transitive chain). */
  const REGION_NEIGHBORS = {
    hips: ['torso', 'leftThigh', 'rightThigh'],
    torso: ['hips', 'chest'],
    chest: ['torso', 'neck', 'leftUpperArm', 'rightUpperArm'],
    neck: ['chest', 'head'],
    head: ['neck'],
    leftThigh: ['leftShin'],
    leftShin: ['leftThigh', 'leftFoot'],
    leftFoot: ['leftShin'],
    rightThigh: ['rightShin'],
    rightShin: ['rightThigh', 'rightFoot'],
    rightFoot: ['rightShin'],
    leftUpperArm: ['leftForearm'],
    leftForearm: ['leftUpperArm', 'leftHand'],
    leftHand: ['leftForearm'],
    rightUpperArm: ['rightForearm'],
    rightForearm: ['rightUpperArm', 'rightHand'],
    rightHand: ['rightForearm']
  };

  function regionFilterSet(primaryRegionId) {
    if (!primaryRegionId) return null;
    const set = {};
    set[primaryRegionId] = true;
    const neighbors = REGION_NEIGHBORS[primaryRegionId] || [];
    for (let i = 0; i < neighbors.length; i++) {
      set[neighbors[i]] = true;
    }
    return set;
  }

  /** Mixamo bone keys to collapse when a baked region is shattered. */
  const REGION_BONE_KEYS = {
    hips: ['hips'],
    torso: ['spine', 'spine1'],
    chest: ['spine2'],
    neck: ['neck'],
    head: ['head'],
    leftThigh: ['leftUpLeg'],
    leftShin: ['leftLeg'],
    leftFoot: ['leftLeg'],
    rightThigh: ['rightUpLeg'],
    rightShin: ['rightLeg'],
    rightFoot: ['rightLeg'],
    leftUpperArm: ['leftShoulder', 'leftUpperArm'],
    leftForearm: ['leftForearm'],
    leftHand: ['leftHand'],
    rightUpperArm: ['rightShoulder', 'rightUpperArm'],
    rightForearm: ['rightForearm'],
    rightHand: ['rightHand']
  };
  const CONTACT_SKIN = 0.004;
  const IMPACT_BREAK_MIN_SPEED = 3.6;
  const IMPACT_BREAK_COOLDOWN = 0.22;

  /** Closer to impact → smaller max piece size + deeper subdivision. */
  function proximitySplitOpts(dist, proxRadius) {
    const r = proxRadius || PROXIMITY_RADIUS;
    const t = Math.min(1, Math.max(0, dist / r));
    return {
      dist,
      proxRadius: r,
      extentScale: 0.26 + t * 0.9,
      maxDepth: t < 0.12 ? 6 : t < 0.28 ? 5 : t < 0.5 ? 4 : 3
    };
  }

  function bucketCentroid(bucket, V3Class) {
    const pos = bucket.positions;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let n = 0;
    for (let i = 0; i < pos.length; i += 3) {
      cx += pos[i];
      cy += pos[i + 1];
      cz += pos[i + 2];
      n++;
    }
    if (!n) return new V3Class();
    return new V3Class(cx / n, cy / n, cz / n);
  }

  function bucketBounds(bucket, V3Class) {
    const pos = bucket.positions;
    const min = new V3Class(Infinity, Infinity, Infinity);
    const max = new V3Class(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < pos.length; i += 3) {
      min.x = Math.min(min.x, pos[i]);
      min.y = Math.min(min.y, pos[i + 1]);
      min.z = Math.min(min.z, pos[i + 2]);
      max.x = Math.max(max.x, pos[i]);
      max.y = Math.max(max.y, pos[i + 1]);
      max.z = Math.max(max.z, pos[i + 2]);
    }
    return { min, max };
  }

  function bucketMaxExtent(bucket, V3Class) {
    const { min, max } = bucketBounds(bucket, V3Class);
    _v.copy(max).sub(min);
    return Math.max(_v.x, _v.y, _v.z);
  }

  function cloneBucketMeta(bucket) {
    return {
      id: bucket.id,
      matIdx: bucket.matIdx,
      meshRef: bucket.meshRef,
      positions: []
    };
  }

  /** Keep only triangles with a vertex near the impact (surface crater). */
  function filterBucketNearPoint(bucket, point, V3Class, radius) {
    const out = cloneBucketMeta(bucket);
    const pos = bucket.positions;
    const r2 = radius * radius;
    for (let i = 0; i < pos.length; i += 9) {
      let keep = false;
      for (let j = 0; j < 9; j += 3) {
        _v.set(pos[i + j], pos[i + j + 1], pos[i + j + 2]);
        if (_v.distanceToSquared(point) <= r2) {
          keep = true;
          break;
        }
      }
      if (!keep) continue;
      _v.set(pos[i], pos[i + 1], pos[i + 2]);
      _v2.set(pos[i + 3], pos[i + 4], pos[i + 5]);
      _v3.set(pos[i + 6], pos[i + 7], pos[i + 8]);
      pushTriangle(out, _v, _v2, _v3);
    }
    return out;
  }

  /** Split oversized buckets; extent scales with distance from impact (smaller near hit). */
  function subdivideBucket(bucket, V3Class, depth, splitOpts) {
    depth = depth || 0;
    splitOpts = splitOpts || {};
    const maxDepth = splitOpts.maxDepth != null ? splitOpts.maxDepth : 4;
    if (depth > maxDepth || bucket.positions.length < 18) return [bucket];

    const baseExt = LARGE_REGIONS[bucket.id] || DEFAULT_MAX_EXTENT;
    const scale = splitOpts.extentScale != null ? splitOpts.extentScale : 1;
    const maxExt = baseExt * scale;
    const extent = bucketMaxExtent(bucket, V3Class);
    if (extent <= maxExt) return [bucket];

    const { min, max } = bucketBounds(bucket, V3Class);
    _v.copy(max).sub(min);
    let axis = 0;
    if (_v.y > _v.x && _v.y >= _v.z) axis = 1;
    else if (_v.z > _v.x && _v.z > _v.y) axis = 2;
    const mid = (min.getComponent(axis) + max.getComponent(axis)) * 0.5;

    const left = cloneBucketMeta(bucket);
    const right = cloneBucketMeta(bucket);
    const pos = bucket.positions;

    for (let i = 0; i < pos.length; i += 9) {
      const cx = (pos[i] + pos[i + 3] + pos[i + 6]) / 3;
      const cy = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3;
      const cz = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
      const c = axis === 0 ? cx : axis === 1 ? cy : cz;
      const dst = c < mid ? left : right;
      for (let j = 0; j < 9; j++) dst.positions.push(pos[i + j]);
    }

    const out = [];
    if (left.positions.length >= 12) {
      out.push.apply(out, subdivideBucket(left, V3Class, depth + 1, splitOpts));
    }
    if (right.positions.length >= 12) {
      out.push.apply(out, subdivideBucket(right, V3Class, depth + 1, splitOpts));
    }
    return out.length ? out : [bucket];
  }

  function bucketDistanceToPoint(bucket, point, V3Class) {
    return bucketSurfaceDistance(bucket, point, V3Class);
  }

  /** Min distance from point to bucket vertices (AABB omitted — torso AABB covers the whole body). */
  function bucketSurfaceDistance(bucket, point, V3Class) {
    const pos = bucket.positions;
    let minD = Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      _v.set(pos[i], pos[i + 1], pos[i + 2]);
      const d = _v.distanceTo(point);
      if (d < minD) minD = d;
    }
    return minD;
  }

  function keysForRegionId(entries, regionId) {
    const keys = [];
    if (!entries?.length || !regionId) return keys;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].id === regionId) keys.push(entries[i].key);
    }
    return keys;
  }

  /** All baked material buckets for region ids (not proximity-filtered). */
  function catalogKeysForRegionIds(store, regionIds, skipRegions) {
    const keys = [];
    const catalog = store?.entriesCatalog;
    if (!catalog || !regionIds?.length) return keys;
    for (let r = 0; r < regionIds.length; r++) {
      const list = catalog[regionIds[r]];
      if (!list) continue;
      for (let i = 0; i < list.length; i++) {
        const key = list[i].key;
        if (skipRegions && skipRegions[key]) continue;
        if (list[i].bucket?.positions?.length < 12) continue;
        keys.push(key);
      }
    }
    return keys;
  }

  function limitPiecesNearImpact(pieces, localImpact, V3Class, maxCount) {
    if (!maxCount || pieces.length <= maxCount) return pieces;
    const impact = localImpact;
    pieces.sort((a, b) => {
      _v.copy(a.position);
      _v2.copy(b.position);
      return _v.distanceToSquared(impact) - _v2.distanceToSquared(impact);
    });
    return pieces.slice(0, maxCount);
  }

  function closestEntryForRegion(entries, regionId, skipRegions) {
    let best = null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.id !== regionId) continue;
      if (skipRegions && skipRegions[e.key]) continue;
      if (!best || e.dist < best.dist) best = e;
    }
    return best;
  }

  function minDistForRegion(entries, regionId) {
    let minD = Infinity;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.id !== regionId) continue;
      if (e.dist < minD) minD = e.dist;
    }
    return minD;
  }

  /**
   * Primary = ray-hit region when provided, else closest vertex surface;
   * blowout = one skeleton neighbor within chain / tight distance only.
   */
  function pickImpactZones(entries, skipRegions, primaryRegionId) {
    const empty = {
      primaryId: null,
      primaryKey: null,
      keys: [],
      ids: [],
      entries: [],
      surfaceOnly: false
    };
    if (!entries?.length) return empty;

    let resolvedId = primaryRegionId || null;
    if (!resolvedId) {
      resolvedId = resolveHitRegion(entries, null);
    } else if (CORE_TORSO_REGIONS[resolvedId]) {
      resolvedId = resolveHitRegion(entries, resolvedId);
    }

    let primary = resolvedId
      ? closestEntryForRegion(entries, resolvedId, skipRegions)
      : null;
    if (!primary) {
      for (let i = 0; i < entries.length; i++) {
        if (!skipRegions || !skipRegions[entries[i].key]) {
          primary = entries[i];
          break;
        }
      }
    }
    if (!primary) return empty;

    const keySet = {};
    const idSet = {};
    const selectedEntries = [];

    function addByRegionId(regionId) {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (e.id !== regionId) continue;
        if (skipRegions && skipRegions[e.key]) continue;
        if (keySet[e.key]) continue;
        keySet[e.key] = true;
        idSet[e.id] = true;
        selectedEntries.push(e);
      }
    }

    addByRegionId(primary.id);

    const isCoreTorso = !!CORE_TORSO_REGIONS[primary.id];
    if (!isCoreTorso) {
      const limbChainKey = REGION_TO_LIMB_CHAIN[primary.id];
      const limbMembers = limbChainKey ? LIMB_CHAINS[limbChainKey] : null;
      const adjacentMax = limbMembers ? ADJACENT_LIMB_MAX : ADJACENT_SPINE_MAX;
      let neighborIds = REGION_NEIGHBORS[primary.id] || [];
      if (limbMembers) {
        neighborIds = neighborIds.filter((nid) => limbMembers.indexOf(nid) >= 0);
      }

      const neighborCandidates = [];
      for (let n = 0; n < neighborIds.length; n++) {
        const dist = minDistForRegion(entries, neighborIds[n]);
        if (dist <= adjacentMax) {
          neighborCandidates.push({ id: neighborIds[n], dist });
        }
      }
      neighborCandidates.sort((a, b) => a.dist - b.dist);
      for (let n = 0; n < neighborCandidates.length && n < MAX_NEIGHBOR_ZONES; n++) {
        addByRegionId(neighborCandidates[n].id);
      }
    }

    return {
      primaryId: primary.id,
      primaryKey: primary.key,
      keys: Object.keys(keySet),
      ids: Object.keys(idSet),
      entries: selectedEntries,
      surfaceOnly: isCoreTorso
    };
  }

  function splitBucketByPlane(bucket, plane, V3Class) {
    const front = {
      id: bucket.id,
      matIdx: bucket.matIdx,
      meshRef: bucket.meshRef,
      positions: []
    };
    const back = {
      id: bucket.id,
      matIdx: bucket.matIdx,
      meshRef: bucket.meshRef,
      positions: []
    };
    const pos = bucket.positions;

    for (let i = 0; i < pos.length; i += 9) {
      const cx = (pos[i] + pos[i + 3] + pos[i + 6]) / 3;
      const cy = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3;
      const cz = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
      const c = new V3Class(cx, cy, cz);
      const dst = plane.distanceToPoint(c) >= 0 ? front : back;
      for (let j = 0; j < 9; j++) dst.positions.push(pos[i + j]);
    }

    const out = [];
    if (front.positions.length >= 12) out.push(front);
    if (back.positions.length >= 12) out.push(back);
    return out.length ? out : [bucket];
  }

  function centerMeshGeometry(mesh) {
    const geo = mesh.geometry;
    geo.computeBoundingBox();
    _box.copy(geo.boundingBox);
    _box.getCenter(_v);
    const posAttr = geo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      posAttr.setXYZ(
        i,
        posAttr.getX(i) - _v.x,
        posAttr.getY(i) - _v.y,
        posAttr.getZ(i) - _v.z
      );
    }
    posAttr.needsUpdate = true;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    geo.computeVertexNormals();
    mesh.position.copy(_v);
  }

  function convexMeshFromBucket(bucket, factory) {
    const ConvexGeometry = window.BodyRiggedLoaders?.ConvexGeometry;
    if (!ConvexGeometry) {
      console.warn('[ragdoll-shatter] ConvexGeometry not loaded');
      return null;
    }

    const positions = bucket.positions;
    const nVerts = positions.length / 3;
    if (nVerts < 4) return null;

    const V3 = factory.Vector3Class;
    const points = [];
    const maxPts = nVerts < 120 ? nVerts : (nVerts < 800 ? 128 : 80);
    const stride = Math.max(1, Math.floor(nVerts / maxPts));
    for (let i = 0; i < nVerts; i += stride) {
      const j = i * 3;
      points.push(new V3(positions[j], positions[j + 1], positions[j + 2]));
    }
    if (points.length < 4) return null;

    let geo;
    try {
      // Jitter coplanar samples so ConvexHull can find a volume
      if (points.length >= 4) {
        for (let i = 0; i < Math.min(8, points.length); i++) {
          points[i].x += (Math.random() - 0.5) * 1e-4;
          points[i].y += (Math.random() - 0.5) * 1e-4;
          points[i].z += (Math.random() - 0.5) * 1e-4;
        }
      }
      geo = new ConvexGeometry(points);
    } catch (err) {
      // Degenerate shards are common — silent skip (avoid console spam)
      return null;
    }
    geo.computeVertexNormals();

    const material = bucket.material || factory.resolveMaterial(bucket.meshRef, bucket.matIdx);
    if (!material) return null;

    const mesh = factory.makeMesh(geo, material);
    mesh.name = 'shatter-' + bucket.id + '-m' + bucket.matIdx;
    centerMeshGeometry(mesh);

    geo.computeBoundingBox();
    geo.boundingBox.getSize(_v);
    if (_v.length() > 0.55) {
      mesh.geometry.dispose();
      return null;
    }

    mesh.visible = true;
    return mesh;
  }

  /** Build convex pieces from a bucket (subdivide first, optional impact plane cut). */
  function convexPiecesFromBucket(bucket, factory, V3Class, localImpact, localNormal, doImpactCut, splitOpts) {
    splitOpts = splitOpts || proximitySplitOpts(0);
    let subs = subdivideBucket(bucket, V3Class, 0, splitOpts);
    if (doImpactCut) {
      _plane.setFromNormalAndCoplanarPoint(localNormal, localImpact);
      const cut = [];
      for (let i = 0; i < subs.length; i++) {
        const parts = splitBucketByPlane(subs[i], _plane, V3Class);
        for (let p = 0; p < parts.length; p++) {
          const partDist = bucketDistanceToPoint(parts[p], localImpact, V3Class);
          const partOpts = proximitySplitOpts(partDist, splitOpts.proxRadius);
          cut.push.apply(cut, subdivideBucket(parts[p], V3Class, 0, partOpts));
        }
      }
      subs = cut;
    }

    const meshes = [];
    for (let i = 0; i < subs.length; i++) {
      const mesh = convexMeshFromBucket(subs[i], factory);
      if (mesh) meshes.push(mesh);
    }
    return meshes;
  }

  function bucketFromShardMesh(mesh, V3Class) {
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    if (!pos || pos.count < 4) return null;

    const bucket = {
      id: 'shard',
      matIdx: 0,
      meshRef: null,
      material: mesh.material,
      positions: []
    };

    for (let i = 0; i < pos.count; i += 3) {
      for (let j = 0; j < 3; j++) {
        const vi = i + j;
        if (vi >= pos.count) break;
        _v.fromBufferAttribute(pos, vi);
        _v.add(mesh.position);
        bucket.positions.push(_v.x, _v.y, _v.z);
      }
    }
    return bucket.positions.length >= 12 ? bucket : null;
  }

  function meshWorldSize(mesh) {
    mesh.geometry.computeBoundingBox();
    mesh.geometry.boundingBox.getSize(_v);
    return _v.length();
  }

  function removeShardFromList(shards, index, root) {
    if (index < 0 || index >= shards.length) return;
    const s = shards[index];
    if (s.mesh) {
      if (root) root.remove(s.mesh);
      s.mesh.geometry?.dispose();
      if (!s.sharedMaterial && s.mesh.material) {
        const mats = Array.isArray(s.mesh.material) ? s.mesh.material : [s.mesh.material];
        for (let m = 0; m < mats.length; m++) {
          mats[m]?.dispose?.();
        }
      }
    }
    shards.splice(index, 1);
  }

  function queueOldestShardRemovals(shards, pendingRemovals, maxCount) {
    if (!shards?.length || shards.length <= maxCount) return;
    const excess = shards.length - maxCount;
    const ranked = [];
    for (let i = 0; i < shards.length; i++) {
      ranked.push({ i, seq: shards[i].spawnSeq || 0 });
    }
    ranked.sort((a, b) => a.seq - b.seq || a.i - b.i);
    for (let e = 0; e < excess; e++) {
      pendingRemovals.push(ranked[e].i);
    }
  }

  function shardCollisionRadius(mesh) {
    mesh.geometry.computeBoundingSphere();
    const r = mesh.geometry.boundingSphere?.radius || 0.05;
    mesh.getWorldScale(_v3);
    const scale = Math.max(_v3.x, _v3.y, _v3.z, 1);
    return Math.max(0.032, Math.min(0.15, r * scale * 0.82));
  }

  function stripInwardVelocity(vel, nx, ny, nz) {
    const vn = vel.x * nx + vel.y * ny + vel.z * nz;
    if (vn < 0) {
      vel.x -= vn * nx;
      vel.y -= vn * ny;
      vel.z -= vn * nz;
    }
    return vn;
  }

  function pushWorldPosOutOfOverlap(worldPos, radius, queries) {
    if (!queries?.resolveSphereAgainstColliders) return false;
    _v.set(worldPos.x, worldPos.y, worldPos.z);
    const pushed = queries.resolveSphereAgainstColliders(
      _v,
      radius,
      { maxIterations: 10 }
    );
    if (pushed?.hit && pushed.position) {
      worldPos.x = pushed.position.x;
      worldPos.y = pushed.position.y;
      worldPos.z = pushed.position.z;
      return true;
    }
    return false;
  }

  function resolveShardAgainstWorld(from, to, radius, queries) {
    if (!queries?.castSphereSweep) {
      return { pos: to, hit: false, onGround: to.y <= 0.035 };
    }

    const sweep = queries.castSphereSweep(
      { x: from.x, y: from.y, z: from.z },
      { x: to.x, y: to.y, z: to.z },
      radius
    );

    if (!sweep.hit) {
      return { pos: to, hit: false, onGround: false };
    }

    const pos = sweep.position;
    const n = sweep.normal;
    const ny = n?.y != null ? n.y : 1;
    const nlen = Math.sqrt((n?.x || 0) ** 2 + ny ** 2 + (n?.z || 0) ** 2) || 1;
    return {
      pos,
      hit: true,
      normal: n,
      nx: (n?.x || 0) / nlen,
      ny: ny / nlen,
      nz: (n?.z || 0) / nlen,
      onGround: ny / nlen > 0.55
    };
  }

  function clampVelocity(vel, maxSpeed) {
    const len = vel.length();
    if (len > maxSpeed && len > 1e-6) vel.multiplyScalar(maxSpeed / len);
    return vel;
  }

  function randomUnitVector(V3Class) {
    const u = Math.random();
    const v = Math.random();
    const theta = Math.PI * 2 * u;
    const z = 2 * v - 1;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    return new V3Class(r * Math.cos(theta), r * Math.sin(theta), z);
  }

  function shardVelocity(mesh, impactPoint, shotDir, impactNormal, baseVel, impulse, V3Class) {
    const dir = _v.copy(shotDir);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
    else dir.normalize();

    const normal = _v2.copy(impactNormal || dir);
    if (normal.lengthSq() < 1e-8) normal.copy(dir).negate();
    else normal.normalize();

    mesh.getWorldPosition(_v3);
    const radial = new V3Class().copy(_v3).sub(impactPoint);
    const dist = radial.length();
    if (dist > 1e-5) radial.multiplyScalar(1 / dist);
    else radial.set(0, 0.4, 0);

    const scatter = impulse.scatterDir
      ? new V3Class(impulse.scatterDir.x, impulse.scatterDir.y, impulse.scatterDir.z)
      : randomUnitVector(V3Class);
    if (scatter.lengthSq() > 1e-8) scatter.normalize();

    const out = new V3Class();
    const radialScale = dist < 0.12 ? 1.55 : dist < 0.35 ? 1.2 : 0.95;
    out.addScaledVector(dir, impulse.shot || 0);
    out.addScaledVector(radial, (impulse.radial || 0) * radialScale);
    out.addScaledVector(normal, impulse.normal || 0);
    if (impulse.scatter) out.addScaledVector(scatter, impulse.scatter);
    out.add(baseVel);

    return clampVelocity(out, impulse.maxSpeed);
  }

  function spawnShard(root, mesh, impactPoint, shotDir, impactNormal, baseVel, impulse, angVel, V3Class) {
    mesh.visible = true;
    root.add(mesh);
    mesh.updateMatrixWorld(true);
    const velocity = shardVelocity(mesh, impactPoint, shotDir, impactNormal, baseVel, impulse, V3Class);
    return {
      mesh,
      velocity,
      radius: shardCollisionRadius(mesh),
      worldSize: meshWorldSize(mesh),
      maxSpeed: impulse.maxSpeed,
      angularVelocity: angVel.clone(),
      V3Class,
      grounded: false,
      wallContact: false,
      contactNx: 0,
      contactNy: 0,
      contactNz: 0,
      impactBreakCooldown: 0,
      sharedMaterial: true,
      spawnSeq: ++_shardSpawnSeq
    };
  }

  function collectRegionEntries(skinnedMeshes, impactPoint, spaceInverse, skipRegions, opts) {
    if (!skinnedMeshes?.length) return { entries: [], V3Class: THREE.Vector3 };

    opts = opts || {};
    const bucketStore = opts.bucketStore || null;
    const primaryRegionId = opts.primaryRegionId || null;
    const regionFilter = regionFilterSet(primaryRegionId);

    if (bucketStore?.entriesCatalog) {
      const regionIds = regionFilter ? Object.keys(regionFilter) : null;
      return collectFromCatalog(bucketStore, impactPoint, spaceInverse, skipRegions, regionIds);
    }

    const factory = createRenderFactory(skinnedMeshes[0]);
    const V3Class = factory.Vector3Class;
    const localImpact = new V3Class().copy(impactPoint);
    if (spaceInverse) localImpact.applyMatrix4(spaceInverse);

    const buckets = getOrBakeBuckets(skinnedMeshes, spaceInverse || null, bucketStore);
    const keys = Object.keys(buckets);
    const entries = [];
    const nearR = SHATTER_RADIUS + PROXIMITY_RADIUS + 0.22;
    const nearR2 = nearR * nearR;
    const looseR2 = nearR2 * 2.25;

    for (let k = 0; k < keys.length; k++) {
      const key = keys[k];
      if (skipRegions && skipRegions[key]) continue;
      const bucket = buckets[key];
      if (bucket.positions.length < 12) continue;
      if (regionFilter && !regionFilter[bucket.id]) continue;
      if (bucket.centroidX != null) {
        const cd2 = bucketCentroidDistSq(bucket, localImpact);
        if (cd2 > looseR2) continue;
      }

      let dist;
      if (bucket.centroidX != null && bucketCentroidDistSq(bucket, localImpact) > nearR2) {
        dist = Math.sqrt(bucketCentroidDistSq(bucket, localImpact));
      } else {
        dist = bucketDistanceToPoint(bucket, localImpact, V3Class);
      }
      entries.push({
        id: bucket.id,
        matIdx: bucket.matIdx,
        key: bucket.id + ':' + bucket.matIdx,
        bucket,
        dist
      });
    }

    entries.sort((a, b) => a.dist - b.dist);
    return { entries, V3Class };
  }

  const RagdollShatter = {
    ready: true,
    SHATTER_RADIUS,
    PROXIMITY_RADIUS,
    REGION_BONE_KEYS,
    REGION_NEIGHBORS,
    CORE_TORSO_REGIONS,
    REGION_DAMAGE_MAX,
    BODY_HITS_TO_RAGDOLL,
    MAX_ACTIVE_SHARDS,
    MAX_SHARDS_PER_SHOT,
    MAX_SHARDS_FULL_DESTROY,
    catalogKeysForRegionIds,
    REGION_PHYSICS_BONES,
    physicsBonesForRegionIds,
    LIMB_DAMAGE_CHAINS,
    limbDamageChainKey,
    chainMemberRegionIds,
    prepareBucketCache: ensureBucketCache,
    populateShatterStore,
    patchBucketsForRegions,
    invalidateBucketCache,
    isBucketCacheReady,
    collectFromCatalog,
    collectRegionEntries: function (skinnedMeshes, impactPoint, spaceInverse, skipRegions, opts) {
      return collectRegionEntries(skinnedMeshes, impactPoint, spaceInverse, skipRegions, opts);
    },

    resolveHitRegionAtPoint: function (skinnedMeshes, impactPoint, spaceInverse, faceRegionId, skipRegions) {
      const { entries } = collectRegionEntries(skinnedMeshes, impactPoint, spaceInverse, skipRegions);
      return resolveHitRegion(entries, faceRegionId || null);
    },

    regionFromHitIntersection,

    getImpactRegions: function (skinnedMeshes, impactPoint, spaceInverse, skipRegions) {
      const { entries } = collectRegionEntries(skinnedMeshes, impactPoint, spaceInverse, skipRegions);
      return entries.map((e) => ({
        id: e.id,
        matIdx: e.matIdx,
        key: e.key,
        dist: e.dist
      }));
    },

    pickImpactZones: function (skinnedMeshes, impactPoint, spaceInverse, skipRegions, primaryRegionId) {
      const { entries } = collectRegionEntries(skinnedMeshes, impactPoint, spaceInverse, skipRegions);
      return pickImpactZones(entries, skipRegions, primaryRegionId);
    },

    pickImpactZonesFromEntries: function (entries, skipRegions, primaryRegionId) {
      return pickImpactZones(entries, skipRegions, primaryRegionId);
    },

    keysForRegionId: function (skinnedMeshes, impactPoint, spaceInverse, regionId, skipRegions) {
      const { entries } = collectRegionEntries(skinnedMeshes, impactPoint, spaceInverse, skipRegions);
      return keysForRegionId(entries, regionId);
    },

    keysForRegionIdFromEntries: function (entries, regionId) {
      return keysForRegionId(entries, regionId);
    },

    regionFromHitFace: function (mesh, faceIndex) {
      if (!mesh?.geometry || faceIndex == null || faceIndex < 0) return null;
      const geo = mesh.geometry;
      const skeleton = mesh.skeleton;
      const boneToRegion = skeleton ? buildBoneIndexToRegion(skeleton) : [];
      const index = geo.index;
      let i0;
      let i1;
      let i2;
      if (index) {
        i0 = index.getX(faceIndex * 3);
        i1 = index.getX(faceIndex * 3 + 1);
        i2 = index.getX(faceIndex * 3 + 2);
      } else {
        i0 = faceIndex * 3;
        i1 = faceIndex * 3 + 1;
        i2 = faceIndex * 3 + 2;
      }
      return triangleRegion(mesh, i0, i1, i2, boneToRegion);
    },

    createShardRoot: function (refMesh) {
      if (!refMesh) return new THREE.Group();
      return createRenderFactory(refMesh).makeGroup();
    },

    fracture: function (opts) {
      const {
        root,
        skinnedMeshes,
        impactPoint,
        impactNormal,
        shotDir,
        b3,
        world,
        baseVelocity,
        spaceInverse,
        shotStrength = 1,
        shatterRadius = SHATTER_RADIUS,
        skipRegions = null,
        regionKeys = null,
        surfaceOnly = false,
        damageStage = null,
        primaryRegionId = null,
        precomputedEntries = null,
        precomputedV3Class = null,
        bucketStore = null,
        primaryKeyOverride = null,
        maxShardsPerShot = null
      } = opts;

      // DIAGNOSTIC KILL-SWITCH: when disabled, create NO shatter shards at all.
      // Hit detection / damage / laser still run (they don't go through fracture),
      // so this isolates whether the shard system is the sole cause of the
      // shooting-bots dip. Toggle live with window.__capvrShatter(true|false).
      if (window.__capvrShatterOff === true) return [];

      if (!root || !skinnedMeshes?.length || !b3 || !world) return [];

      let bucketEntries;
      let V3Class;
      if (precomputedEntries?.length) {
        bucketEntries = precomputedEntries;
        V3Class = precomputedV3Class || THREE.Vector3;
      } else {
        const collected = collectRegionEntries(
          skinnedMeshes,
          impactPoint,
          spaceInverse,
          skipRegions,
          { bucketStore, primaryRegionId: primaryRegionId || null }
        );
        bucketEntries = collected.entries;
        V3Class = collected.V3Class;
      }
      if (!bucketEntries.length) {
        console.warn('[ragdoll-shatter] no regions baked');
        return [];
      }

      const zones = pickImpactZones(bucketEntries, skipRegions, primaryRegionId || null);
      const keysToShatter = regionKeys || zones.keys;
      if (!keysToShatter.length) return [];

      const keyLookup = {};
      for (let k = 0; k < keysToShatter.length; k++) {
        keyLookup[keysToShatter[k]] = true;
      }

      const factory = bucketStore?.factory || createRenderFactory(skinnedMeshes[0]);
      const str = Math.max(0.35, shotStrength);

      const primaryKey = primaryKeyOverride || zones.primaryKey || bucketEntries[0].key;
      const primaryId = primaryRegionId || zones.primaryId;
      const stage = damageStage == null ? REGION_DAMAGE_MAX : damageStage;
      const fullDestroy = !surfaceOnly && stage >= REGION_DAMAGE_MAX;

      const shardBudget = maxShardsPerShot == null
        ? (fullDestroy ? MAX_SHARDS_FULL_DESTROY : MAX_SHARDS_PER_SHOT)
        : maxShardsPerShot;

      const localImpact = new V3Class().copy(impactPoint);
      if (spaceInverse) localImpact.applyMatrix4(spaceInverse);

      const localNormal = new V3Class().copy(impactNormal || shotDir);
      if (localNormal.lengthSq() < 1e-8) localNormal.copy(shotDir).negate();
      if (spaceInverse) localNormal.transformDirection(spaceInverse);
      localNormal.normalize();

      const worldNormal = new V3Class().copy(impactNormal || shotDir);
      if (worldNormal.lengthSq() < 1e-8) worldNormal.copy(shotDir).negate();
      worldNormal.normalize();

      const shards = [];
      const base = baseVelocity
        ? new V3Class(baseVelocity.x, baseVelocity.y, baseVelocity.z)
        : new V3Class();
      clampVelocity(base, 3 * str);

      const workEntries = bucketEntries.slice();
      workEntries.sort((a, b) => {
        const aPrimary = a.key === primaryKey || a.id === primaryId;
        const bPrimary = b.key === primaryKey || b.id === primaryId;
        if (aPrimary !== bPrimary) return aPrimary ? -1 : 1;
        return a.dist - b.dist;
      });

      let shatteredRegions = 0;

      for (let r = 0; r < workEntries.length; r++) {
        const entry = workEntries[r];
        if (!keyLookup[entry.key]) continue;
        if (skipRegions && skipRegions[entry.key]) continue;
        if (!surfaceOnly && stage < REGION_DAMAGE_MAX && entry.id !== primaryId) continue;

        shatteredRegions++;
        const isHit = entry.key === primaryKey;
        const isCoreCrater = surfaceOnly && entry.id === primaryId;
        const isPartialCrater = !surfaceOnly && stage < REGION_DAMAGE_MAX && entry.id === primaryId;
        const isCrater = isCoreCrater || isPartialCrater;
        let workBucket = entry.bucket;
        if (isCrater) {
          const craterR = isCoreCrater
            ? SURFACE_CRATER_RADIUS
            : (CRATER_RADIUS_BY_STAGE[stage] || CRATER_RADIUS_BY_STAGE[2]);
          workBucket = filterBucketNearPoint(
            entry.bucket,
            localImpact,
            V3Class,
            craterR
          );
          if (workBucket.positions.length < 12) continue;
        }

        let splitOpts = isHit
          ? proximitySplitOpts(0, isCrater ? (isPartialCrater ? 0.11 : 0.1) : 0.2)
          : proximitySplitOpts(0.12, 0.26);
        if (isCrater) {
          splitOpts.maxDepth = isPartialCrater ? 4 : 5;
          splitOpts.extentScale = isPartialCrater ? 0.38 : 0.32;
        } else if (!isHit) {
          splitOpts.maxDepth = Math.min(splitOpts.maxDepth, 4);
        } else if (fullDestroy) {
          splitOpts.maxDepth = Math.max(splitOpts.maxDepth, 6);
        }

        let impulse;
        if (isCrater) {
          const craterScale = isPartialCrater ? (stage === 1 ? 0.85 : 1.0) : 1.0;
          impulse = {
            shot: 2.4 * str * craterScale,
            radial: 3.6 * str * craterScale,
            normal: 2.1 * str * craterScale,
            scatter: 2.6 * str * craterScale,
            maxSpeed: 7.4 * str
          };
        } else if (isHit) {
          impulse = {
            shot: 3.8 * str,
            radial: 2.6 * str,
            normal: 1.5 * str,
            scatter: 2.3 * str,
            maxSpeed: 8.5 * str
          };
        } else {
          impulse = {
            shot: 2.0 * str,
            radial: 1.4 * str,
            normal: 0.9 * str,
            scatter: 1.6 * str,
            maxSpeed: 5.5 * str
          };
        }

        const ang = new V3Class(
          (Math.random() - 0.5) * (isHit ? 2.0 : 1.2),
          (Math.random() - 0.5) * (isHit ? 2.0 : 1.2),
          (Math.random() - 0.5) * (isHit ? 2.0 : 1.2)
        );

        let pieces = convexPiecesFromBucket(
          workBucket,
          factory,
          V3Class,
          localImpact,
          localNormal,
          true,
          splitOpts
        );
        if (isPartialCrater) {
          pieces = limitPiecesNearImpact(
            pieces,
            localImpact,
            V3Class,
            MAX_CRATER_SHARDS_BY_STAGE[stage]
          );
        }
        if (!pieces.length) continue;

        for (let p = 0; p < pieces.length; p++) {
          if (shards.length >= shardBudget) break;
          const shotUnit = new V3Class().copy(shotDir);
          if (shotUnit.lengthSq() < 1e-8) shotUnit.set(0, 0, -1);
          else shotUnit.normalize();

          const scatterDir = randomUnitVector(V3Class);
          scatterDir.addScaledVector(shotUnit, 0.4 + Math.random() * 0.45);
          scatterDir.addScaledVector(worldNormal, 0.15 + Math.random() * 0.3);
          if (scatterDir.lengthSq() > 1e-8) scatterDir.normalize();

          const pieceImpulse = {
            shot: impulse.shot * (0.35 + Math.random() * 0.55),
            radial: impulse.radial * (0.65 + Math.random() * 0.75),
            normal: impulse.normal * (0.55 + Math.random() * 0.65),
            scatter: impulse.scatter * (0.6 + Math.random() * 0.85),
            scatterDir: { x: scatterDir.x, y: scatterDir.y, z: scatterDir.z },
            maxSpeed: impulse.maxSpeed
          };

          shards.push(
            spawnShard(
              root,
              pieces[p],
              impactPoint,
              shotDir,
              worldNormal,
              base,
              pieceImpulse,
              ang,
              V3Class
            )
          );
        }
        if (shards.length >= shardBudget) break;
      }

      root.updateMatrixWorld(true);
      if (root.parent) root.parent.updateMatrixWorld(true);

      return shards;
    },

    /** Break an existing shard — gun hit or hard collision with environment. */
    fractureShard: function (opts) {
      const {
        root,
        shards,
        shardIndex,
        refMesh,
        impactPoint,
        impactNormal,
        shotDir,
        spaceInverse,
        shotStrength = 1,
        fromCollision = false,
        collisionSpeed = 0
      } = opts;

      if (window.__capvrShatterOff === true) return [];

      if (!root || !shards || shardIndex < 0 || shardIndex >= shards.length) {
        return [];
      }

      const shard = shards[shardIndex];
      const mesh = shard?.mesh;
      if (!mesh) return [];

      const size = shard.worldSize || meshWorldSize(mesh);
      if (size < MIN_RESHATTER_SIZE) {
        return [];
      }

      const factory = createRenderFactory(refMesh || mesh);
      const V3Class = factory.Vector3Class;
      const str = fromCollision
        ? Math.min(1.15, Math.max(0.45, Math.abs(collisionSpeed) / 4.8))
        : Math.max(0.35, shotStrength);

      const bucket = bucketFromShardMesh(mesh, V3Class);
      if (!bucket) return [];

      if (!bucket.material && mesh.material) {
        bucket.material = mesh.material;
      }

      const localImpact = new V3Class().copy(impactPoint);
      if (spaceInverse) localImpact.applyMatrix4(spaceInverse);

      const worldNormal = new V3Class().copy(impactNormal || shotDir);
      if (worldNormal.lengthSq() < 1e-8) worldNormal.set(0, 1, 0);
      else worldNormal.normalize();

      const localNormal = worldNormal.clone();
      if (spaceInverse) localNormal.transformDirection(spaceInverse);
      localNormal.normalize();

      const hitDist = bucketDistanceToPoint(bucket, localImpact, V3Class);
      const splitOpts = proximitySplitOpts(hitDist, fromCollision ? 0.28 : 0.35);
      splitOpts.maxDepth = fromCollision ? 5 : 6;
      splitOpts.extentScale *= fromCollision ? 0.62 : 0.55;

      const pieces = convexPiecesFromBucket(
        bucket,
        factory,
        V3Class,
        localImpact,
        localNormal,
        true,
        splitOpts
      );

      if (pieces.length < 2) return [];

      removeShardFromList(shards, shardIndex, root);

      const outward = new V3Class(-worldNormal.x, -worldNormal.y, -worldNormal.z);
      const impulse = fromCollision
        ? {
            shot: 2.2 * str,
            radial: 0.85 * str,
            normal: 1.0 * str,
            maxSpeed: 5.2 * str
          }
        : {
            shot: 6.5 * str,
            radial: 1.6 * str,
            normal: 1.8 * str,
            maxSpeed: 8.5 * str
          };
      const ang = new V3Class(
        (Math.random() - 0.5) * (fromCollision ? 1.1 : 2),
        (Math.random() - 0.5) * (fromCollision ? 1.1 : 2),
        (Math.random() - 0.5) * (fromCollision ? 1.1 : 2)
      );
      const base = shard.velocity
        ? new V3Class(
            shard.velocity.x * (fromCollision ? 0.22 : 0.35),
            shard.velocity.y * (fromCollision ? 0.22 : 0.35),
            shard.velocity.z * (fromCollision ? 0.22 : 0.35)
          )
        : new V3Class();

      const out = [];
      for (let p = 0; p < pieces.length; p++) {
        const pieceImpulse = {
          shot: impulse.shot * (0.9 + Math.random() * 0.2),
          radial: impulse.radial,
          normal: impulse.normal,
          maxSpeed: impulse.maxSpeed
        };
        out.push(
          spawnShard(root, pieces[p], impactPoint, outward, worldNormal, base, pieceImpulse, ang, V3Class)
        );
      }

      shards.push.apply(shards, out);
      if (fromCollision) {
        console.log('[ragdoll-shatter] collision break into', out.length, 'pieces at', Math.abs(collisionSpeed).toFixed(1), 'm/s');
      }
      return out;
    },

    syncShards: function (shards, b3, dt, queries, opts) {
      if (!shards?.length) return;
      const step = typeof dt === 'number' && dt > 0 ? Math.min(dt, 0.033) : 0;
      if (step <= 0) return;

      const pendingBreaks = [];
      const pendingRemovals = [];
      const breakRoot = opts?.root;
      const breakRef = opts?.refMesh;
      const spaceInverse = opts?.spaceInverse;
      const zeroG = !!(opts?.zeroG || (window.BodyRiggedGravity && window.BodyRiggedGravity.isZeroG()));
      let gravityY = -9.8;
      if (!zeroG) {
        const g = window.BodyRiggedGravity?.gravityGrounded;
        if (g && typeof g.y === 'number' && g.y !== 0) {
          gravityY = g.y;
        } else {
          const scene = typeof document !== 'undefined' ? document.querySelector('a-scene') : null;
          const phys = window.CapVRPhysics?.get?.() || scene?.components?.['capvr-physics']?.physics;
          const pg = phys?.getGravity?.();
          if (pg && typeof pg.y === 'number' && pg.y !== 0) gravityY = pg.y;
        }
      } else {
        gravityY = 0;
      }

      // Reuse scratch vectors across all shards. The old `new V3()` ×3 per shard
      // per frame was heavy GC churn (hundreds of allocs/frame with 3 bots' worth
      // of debris) — a prime suspect behind the 111–153 ms shatter-frame stalls.
      // Each is fully overwritten before use every iteration, so this is behaviorally
      // identical to allocating fresh vectors.
      let worldPos = null;
      let localPos = null;
      let desired = null;

      for (let i = 0; i < shards.length; i++) {
        const s = shards[i];
        if (!s.mesh || !s.velocity) continue;

        if (s.impactBreakCooldown > 0) {
          s.impactBreakCooldown = Math.max(0, s.impactBreakCooldown - step);
        }

        const mesh = s.mesh;
        const parent = mesh.parent;
        const V3 = s.V3Class || mesh.position.constructor;
        if (!worldPos) { worldPos = new V3(); localPos = new V3(); desired = new V3(); }
        const maxSpd = s.maxSpeed || 7;
        const radius = s.radius || shardCollisionRadius(mesh);

        clampVelocity(s.velocity, maxSpd);

        mesh.getWorldPosition(worldPos);

        if (s.wallContact) {
          stripInwardVelocity(s.velocity, s.contactNx, s.contactNy, s.contactNz);
        }

        pushWorldPosOutOfOverlap(worldPos, radius, queries);

        if (gravityY !== 0) {
          s.velocity.y += gravityY * step;
        }

        desired.copy(worldPos);
        desired.x += s.velocity.x * step;
        desired.y += s.velocity.y * step;
        desired.z += s.velocity.z * step;

        const resolved = resolveShardAgainstWorld(worldPos, desired, radius, queries);
        worldPos.copy(resolved.pos);

        s.wallContact = false;
        if (resolved.hit) {
          const nx = resolved.nx != null ? resolved.nx : 0;
          const ny = resolved.ny != null ? resolved.ny : 1;
          const nz = resolved.nz != null ? resolved.nz : 0;

          worldPos.x += nx * CONTACT_SKIN;
          worldPos.y += ny * CONTACT_SKIN;
          worldPos.z += nz * CONTACT_SKIN;

          const inwardSpeed = s.velocity.x * nx + s.velocity.y * ny + s.velocity.z * nz;
          stripInwardVelocity(s.velocity, nx, ny, nz);
          if (inwardSpeed < -0.8) {
            const restitution = 0.18;
            s.velocity.x -= restitution * inwardSpeed * nx;
            s.velocity.y -= restitution * inwardSpeed * ny;
            s.velocity.z -= restitution * inwardSpeed * nz;
          }

          const shardSize = s.worldSize || meshWorldSize(mesh);
          if (
            breakRoot &&
            breakRef &&
            s.impactBreakCooldown <= 0 &&
            inwardSpeed < -IMPACT_BREAK_MIN_SPEED &&
            shardSize >= MIN_RESHATTER_SIZE
          ) {
            pendingBreaks.push({
              shardIndex: i,
              impactPoint: new V3(worldPos.x, worldPos.y, worldPos.z),
              impactNormal: new V3(nx, ny, nz),
              collisionSpeed: inwardSpeed
            });
            s.impactBreakCooldown = IMPACT_BREAK_COOLDOWN;
          }

          if (ny < 0.55) {
            s.wallContact = true;
            s.contactNx = nx;
            s.contactNy = ny;
            s.contactNz = nz;
            s.velocity.x *= 0.97;
            s.velocity.z *= 0.97;
          }
        }

        pushWorldPosOutOfOverlap(worldPos, radius, queries);

        let onGround = !zeroG && resolved.hit && resolved.onGround;
        if (!zeroG && !onGround && queries?.sampleGroundY) {
          const gy = queries.sampleGroundY(
            worldPos.x,
            worldPos.y + radius + 0.02,
            worldPos.z,
            radius + 0.15
          );
          if (gy != null && worldPos.y - gy <= radius + 0.04) {
            onGround = true;
          }
        }
        if (!zeroG && !onGround && !queries) {
          onGround = worldPos.y <= radius + 0.03;
        }

        if (parent) {
          parent.updateMatrixWorld(true);
          parent.worldToLocal(localPos.copy(worldPos));
          mesh.position.copy(localPos);
        } else {
          mesh.position.copy(worldPos);
        }

        if (onGround && !zeroG) {
          s.grounded = true;
          s.wallContact = false;
          if (s.velocity.y < 0) s.velocity.y *= -0.08;
          s.velocity.x *= 0.78;
          s.velocity.z *= 0.78;
          if (s.angularVelocity) {
            s.angularVelocity.multiplyScalar(0.65);
            if (s.angularVelocity.length() < 0.35) {
              s.angularVelocity.set(0, 0, 0);
            }
          }
          if (s.velocity.length() < 0.2) {
            s.velocity.set(0, 0, 0);
            if (s.angularVelocity) s.angularVelocity.set(0, 0, 0);
          }
        } else {
          s.grounded = false;
          if (s.angularVelocity) {
            s.angularVelocity.multiplyScalar(0.992);
            mesh.rotation.x += s.angularVelocity.x * step;
            mesh.rotation.y += s.angularVelocity.y * step;
            mesh.rotation.z += s.angularVelocity.z * step;
          }
        }

        clampVelocity(s.velocity, maxSpd);
      }

      if (pendingBreaks.length && breakRoot && breakRef) {
        pendingBreaks.sort((a, b) => b.shardIndex - a.shardIndex);
        for (let b = 0; b < pendingBreaks.length; b++) {
          const pb = pendingBreaks[b];
          if (pb.shardIndex < 0 || pb.shardIndex >= shards.length) continue;
          RagdollShatter.fractureShard({
            root: breakRoot,
            shards,
            shardIndex: pb.shardIndex,
            refMesh: breakRef,
            impactPoint: pb.impactPoint,
            impactNormal: pb.impactNormal,
            shotDir: pb.impactNormal,
            spaceInverse,
            fromCollision: true,
            collisionSpeed: pb.collisionSpeed
          });
        }
      }

      const shardCap = (window.__capvrMaxShards | 0) > 0 ? (window.__capvrMaxShards | 0) : MAX_ACTIVE_SHARDS;
      queueOldestShardRemovals(shards, pendingRemovals, shardCap);

      if (pendingRemovals.length) {
        pendingRemovals.sort((a, b) => b - a);
        const seen = {};
        for (let r = 0; r < pendingRemovals.length; r++) {
          const idx = pendingRemovals[r];
          if (seen[idx]) continue;
          seen[idx] = true;
          const root = breakRoot || shards[idx]?.mesh?.parent;
          removeShardFromList(shards, idx, root);
        }
      }
    },

    dispose: function (shards, b3, root) {
      if (!shards) return;
      for (let i = 0; i < shards.length; i++) {
        const s = shards[i];
        if (s.mesh) {
          if (root) root.remove(s.mesh);
          s.mesh.geometry?.dispose();
          if (!s.sharedMaterial && s.mesh.material?.dispose) {
            s.mesh.material.dispose();
          }
        }
        if (s.body && b3?.b3DestroyBody) {
          b3.b3DestroyBody(s.body);
        }
      }
      shards.length = 0;
    }
  };

  window.RagdollShatter = RagdollShatter;

  // Shatter shards re-ENABLED by default. (Shard-off testing proved shards are only
  // part of the story; the shooting-bots dip persisted without them, so we now
  // isolate the bot hit-response path instead.) Toggle live: __capvrShatter(false).
  if (window.__capvrShatterOff === undefined) window.__capvrShatterOff = false;
  window.__capvrShatter = function (on) {
    window.__capvrShatterOff = (on === false);
    console.log('[CapVR] shatter shards ' + (window.__capvrShatterOff ? 'DISABLED (no shards)' : 'ENABLED'));
    return !window.__capvrShatterOff;
  };
})();
