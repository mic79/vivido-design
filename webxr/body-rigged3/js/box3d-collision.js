/**
 * Box3D collision query helpers for body-rigged3.
 * Wraps shape casts, overlaps, and sphere resolution used by hand/finger IK and the player mover.
 */
(function () {
  'use strict';

  const CATEGORY = {
    ENVIRONMENT: 1n,
    PLAYER: 2n,
    HAND: 4n,
    RAGDOLL: 8n
  };

  const SPHERE_PROXY = [0, 0, 0];

  function cloneVec3(v) {
    return { x: v.x, y: v.y, z: v.z };
  }

  function defaultEnvFilter(b3) {
    const filter = b3.b3DefaultQueryFilter();
    filter.maskBits = CATEGORY.ENVIRONMENT;
    return filter;
  }

  function defaultHandFilter(b3) {
    const filter = b3.b3DefaultQueryFilter();
    filter.maskBits = CATEGORY.ENVIRONMENT;
    return filter;
  }

  function shouldExcludeShape(shapeId, exclude) {
    if (!exclude) return false;
    if (Array.isArray(exclude)) {
      for (let i = 0; i < exclude.length; i++) {
        if (shapeId === exclude[i]) return true;
      }
      return false;
    }
    return shapeId === exclude;
  }

  function makeShapeDef(b3, opts) {
    const sd = b3.b3DefaultShapeDef();
    sd.baseMaterial.friction = opts?.friction ?? 0.8;
    sd.baseMaterial.restitution = opts?.restitution ?? 0.05;
    if (opts?.category != null) {
      sd.filter = {
        categoryBits: opts.category,
        maskBits: opts.mask ?? (CATEGORY.PLAYER | CATEGORY.HAND | CATEGORY.RAGDOLL | CATEGORY.ENVIRONMENT),
        groupIndex: opts.groupIndex ?? 0
      };
    }
    if (opts?.isSensor) sd.isSensor = true;
    return sd;
  }

  /**
   * @param {import('box3d.js').Box3DModule} b3
   * @param {unknown} world
   */
  function createCollisionQueries(b3, world) {
    const envFilter = defaultEnvFilter(b3);
    const handFilter = defaultHandFilter(b3);
    const planeScratch = b3.createPlaneResult ? b3.createPlaneResult() : null;

    function castRay(origin, direction, maxDist, filter) {
      const f = filter || envFilter;
      const len = Math.hypot(direction.x, direction.y, direction.z) || 1;
      const scale = maxDist / len;
      const translation = {
        x: direction.x * scale,
        y: direction.y * scale,
        z: direction.z * scale
      };
      const hit = b3.b3World_CastRayClosest(world, origin, translation, f);
      if (!hit || !hit.hit) return null;
      return {
        fraction: hit.fraction,
        normal: hit.normal,
        point: {
          x: origin.x + translation.x * hit.fraction,
          y: origin.y + translation.y * hit.fraction,
          z: origin.z + translation.z * hit.fraction
        },
        timeOfImpact: hit.fraction * maxDist,
        shapeId: hit.shapeId
      };
    }

    function castRayDown(x, y, z, maxDist, excludeShapeIds) {
      const filter = b3.b3DefaultQueryFilter();
      filter.maskBits = CATEGORY.ENVIRONMENT;
      const origin = { x, y, z };
      const hit = castRay(origin, { x: 0, y: -1, z: 0 }, maxDist, filter);
      if (!hit) return null;
      if (excludeShapeIds && shouldExcludeShape(hit.shapeId, excludeShapeIds)) return null;
      return hit;
    }

    function sampleGroundUnderFeet(x, feetY, z, excludeShapeIds) {
      const hit = castRayDown(x, feetY + 0.2, z, 0.5, excludeShapeIds);
      return hit ? hit.point.y : null;
    }

    function sampleGroundY(x, y, z, maxDist, excludeShapeIds) {
      const hit = castRayDown(x, y, z, maxDist, excludeShapeIds);
      return hit ? hit.point.y : null;
    }

    /** Step probe — matches body-rigged2: ray from capsule root + 0.5 m, down 1 m. */
    function sampleStepAhead(x, capsuleRootY, z, excludeShapeIds) {
      const hit = castRayDown(x, capsuleRootY + 0.5, z, 1.0, excludeShapeIds);
      return hit ? hit.point.y : null;
    }

    /** Rapier-style autostep: maxStep ~0.45 m, probe ahead along move direction. */
    function computeAutoStep(position, moveDir, capsule, excludeShapeIds, opts) {
      opts = opts || {};
      const maxStep = opts.maxStep ?? 0.55;
      const minStep = opts.minStep ?? 0.02;

      const len = Math.hypot(moveDir.x, moveDir.z);
      if (len < 0.04) return 0;

      const nx = moveDir.x / len;
      const nz = moveDir.z / len;
      let best = 0;

      const probes = [0.2, 0.32, 0.42];
      for (let i = 0; i < probes.length; i++) {
        const d = probes[i];
        const px = position.x + nx * d;
        const pz = position.z + nz * d;
        const hitY = sampleStepAhead(px, position.y, pz, excludeShapeIds);
        if (hitY == null) continue;
        const stepHeight = hitY - position.y;
        if (stepHeight > minStep && stepHeight < maxStep && stepHeight > best) {
          best = stepHeight;
        }
      }

      return best;
    }

    function sphereOverlaps(center, radius, excludeShapeIds) {
      let overlaps = false;
      b3.b3World_OverlapShape(
        world,
        { x: center.x, y: center.y, z: center.z },
        SPHERE_PROXY,
        radius,
        handFilter,
        (shapeId) => {
          if (shouldExcludeShape(shapeId, excludeShapeIds)) return true;
          overlaps = true;
          return false;
        }
      );
      return overlaps;
    }

    function castSphereSweep(from, to, radius, excludeShapeIds) {
      const delta = {
        x: to.x - from.x,
        y: to.y - from.y,
        z: to.z - from.z
      };
      let bestFraction = 1;
      let bestNormal = { x: 0, y: 1, z: 0 };
      let bestShape = null;

      b3.b3World_CastShape(
        world,
        { x: from.x, y: from.y, z: from.z },
        SPHERE_PROXY,
        radius,
        delta,
        handFilter,
        (shapeId, _point, normal, fraction) => {
          if (shouldExcludeShape(shapeId, excludeShapeIds)) return bestFraction;
          if (fraction < bestFraction) {
            bestFraction = fraction;
            bestNormal = normal;
            bestShape = shapeId;
          }
          return bestFraction;
        }
      );

      const eps = 0.001;
      const t = Math.max(0, bestFraction - eps / (Math.hypot(delta.x, delta.y, delta.z) || 1));
      return {
        hit: bestFraction < 1,
        fraction: bestFraction,
        normal: bestNormal,
        shapeId: bestShape,
        position: new THREE.Vector3(
          from.x + delta.x * t,
          from.y + delta.y * t,
          from.z + delta.z * t
        )
      };
    }

    function pushSphereOutOfOverlap(center, radius, excludeShapeIds, maxIter) {
      const pos = { x: center.x, y: center.y, z: center.z };
      let anyHit = false;
      const dirs = [
        [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
        [0.707, 0.707, 0], [-0.707, 0.707, 0], [0.707, 0, 0.707], [-0.707, 0, 0.707]
      ];

      for (let iter = 0; iter < (maxIter || 8); iter++) {
        if (!sphereOverlaps(pos, radius, excludeShapeIds)) break;

        let bestPush = null;
        for (let d = 0; d < dirs.length; d++) {
          const dir = dirs[d];
          const hit = castRay(
            pos,
            { x: dir[0], y: dir[1], z: dir[2] },
            radius * 2 + 0.06,
            handFilter
          );
          if (!hit || shouldExcludeShape(hit.shapeId, excludeShapeIds)) continue;
          const push = radius - hit.timeOfImpact + 0.002;
          if (push > 0 && (!bestPush || push > bestPush.push)) {
            bestPush = {
              push,
              nx: -dir[0],
              ny: -dir[1],
              nz: -dir[2]
            };
          }
        }

        if (!bestPush) break;
        pos.x += bestPush.nx * bestPush.push;
        pos.y += bestPush.ny * bestPush.push;
        pos.z += bestPush.nz * bestPush.push;
        anyHit = true;
      }

      return {
        position: new THREE.Vector3(pos.x, pos.y, pos.z),
        hit: anyHit
      };
    }

    function resolveSphereFromApproach(srcPos, radius, approachFrom, excludeShapeIds) {
      const approach = approachFrom || srcPos;
      const sweep = castSphereSweep(approach, srcPos, radius, excludeShapeIds);
      if (sweep.hit) {
        const n = new THREE.Vector3(sweep.normal.x, sweep.normal.y, sweep.normal.z);
        if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
        else n.normalize();
        const skin = 0.001;
        const pos = sweep.position.clone().addScaledVector(n, skin);
        return {
          position: pos,
          hit: true,
          normal: n
        };
      }

      const center = { x: srcPos.x, y: srcPos.y, z: srcPos.z };
      if (!sphereOverlaps(center, radius, excludeShapeIds)) {
        return {
          position: srcPos.clone(),
          hit: false,
          normal: new THREE.Vector3(0, 1, 0)
        };
      }

      const away = new THREE.Vector3().subVectors(approach, srcPos);
      if (away.lengthSq() < 1e-8) away.set(0, 0, 1);
      away.normalize();
      const pos = srcPos.clone();
      let hit = false;
      for (let i = 0; i < 12; i++) {
        const probe = { x: pos.x, y: pos.y, z: pos.z };
        if (!sphereOverlaps(probe, radius, excludeShapeIds)) break;
        pos.addScaledVector(away, 0.004);
        hit = true;
      }
      return {
        position: pos,
        hit,
        normal: away.clone().negate()
      };
    }

    function resolveSphereAgainstColliders(srcPos, radius, options) {
      const horizontalOnly = options && options.horizontalOnly;
      const exclude = options && options.excludeShapeIds;
      const pos = { x: srcPos.x, y: srcPos.y, z: srcPos.z };

      if (sphereOverlaps(pos, radius, exclude)) {
        const pushed = pushSphereOutOfOverlap(pos, radius, exclude, options?.maxIterations || 16);
        if (horizontalOnly) pushed.position.y = srcPos.y;
        return pushed;
      }

      return {
        position: srcPos.clone(),
        hit: false
      };
    }

    function slideSphereOnSurface(lastValid, lastTrack, desired, radius, excludeShapeIds, trackingPos) {
      const track = trackingPos || desired;
      if (!lastValid) {
        const resolved = resolveSphereFromApproach(desired, radius, track, excludeShapeIds);
        return resolved.position;
      }

      const sweep = castSphereSweep(lastValid, desired, radius, excludeShapeIds);
      if (!sweep.hit) {
        const resolved = resolveSphereFromApproach(desired, radius, track, excludeShapeIds);
        return resolved.position;
      }

      const n = new THREE.Vector3(sweep.normal.x, sweep.normal.y, sweep.normal.z);
      if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
      else n.normalize();

      const delta = new THREE.Vector3().subVectors(track, lastTrack || lastValid);
      const axisDot = n.dot(delta);
      if (axisDot < 0) delta.addScaledVector(n, -axisDot);

      const candidate = sweep.position.clone().add(delta);
      const resolved = resolveSphereFromApproach(candidate, radius, track, excludeShapeIds);
      return resolved.position;
    }

    function collectMoverPlanes(position, capsule, filter) {
      const planes = [];
      if (!planeScratch) return planes;

      b3.b3World_CollideMover(
        world,
        position,
        capsule,
        filter || envFilter,
        (_shapeId, buf) => {
          const n = b3.getNumPlaneResults(buf);
          for (let i = 0; i < n; i++) {
            b3.getPlaneResultAt(planeScratch, buf, i);
            const nrm = planeScratch.plane.normal;
            planes.push({
              plane: {
                normal: { x: nrm.x, y: nrm.y, z: nrm.z },
                offset: planeScratch.plane.offset
              },
              pushLimit: 3.4e38,
              push: 0,
              clipVelocity: true
            });
          }
          return true;
        }
      );
      return planes;
    }

    function moveCapsuleMover(position, delta, capsule, filter) {
      const planes = collectMoverPlanes(position, capsule, filter);
      const solved = b3.b3SolvePlanes(
        { x: delta.x, y: delta.y, z: delta.z },
        planes
      );
      let d = solved.delta;
      const fraction = b3.b3World_CastMover(
        world,
        position,
        capsule,
        d,
        filter || envFilter,
        () => true
      );
      d = {
        x: d.x * fraction,
        y: d.y * fraction,
        z: d.z * fraction
      };
      return {
        position: {
          x: position.x + d.x,
          y: position.y + d.y,
          z: position.z + d.z
        },
        delta: d,
        planes
      };
    }

    return {
      CATEGORY,
      makeShapeDef,
      castRay,
      castRayDown,
      sphereOverlaps,
      castSphereSweep,
      resolveSphereAgainstColliders,
      resolveSphereFromApproach,
      slideSphereOnSurface,
      collectMoverPlanes,
      moveCapsuleMover,
      sampleGroundY,
      sampleGroundUnderFeet,
      sampleStepAhead,
      computeAutoStep,
      envFilter,
      handFilter
    };
  }

  window.Box3DCollision = {
    CATEGORY,
    makeShapeDef,
    createCollisionQueries
  };
})();
