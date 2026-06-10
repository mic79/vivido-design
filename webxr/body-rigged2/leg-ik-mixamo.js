/**
 * Leg IK for A-Frame Mixamo bodies — ported from:
 * https://github.com/Aditya02git/Leg-IK_In_ThreeJS_With_Rapier
 */
(function () {
  'use strict';

  /** Bump when Problem_1.glb or Problem_2.glb changes — avoids stale browser cache. */
  const OBSTACLE_GLB_VERSION = '2';

  function obstacleGlbUrl(file) {
    return file + '?v=' + OBSTACLE_GLB_VERSION;
  }

  class SimpleTerrainBuilder {
    constructor({ groundY = 0 } = {}) {
      this.groundY = groundY;
      this.worldSize = 20;
      this.cellSize = 1;
    }

    getHeightAtWorld(x, z) {
      return this.groundY;
    }
  }

  class RapierTerrainQuery {
    constructor({ world, RAPIER, groundY = 0, rayOriginY = 30, excludeCollider = null } = {}) {
      this.world = world;
      this.RAPIER = RAPIER;
      this.groundY = groundY;
      this.rayOriginY = rayOriginY;
      this.excludeCollider = excludeCollider;
      this.worldSize = 20;
      this.cellSize = 1;
    }

    setExcludeCollider(collider) {
      this.excludeCollider = collider;
    }

    getHeightAtWorld(x, z) {
      if (!this.world || !this.RAPIER) return this.groundY;

      const ray = new this.RAPIER.Ray(
        { x, y: this.rayOriginY, z },
        { x: 0, y: -1, z: 0 }
      );

      const hit = this.world.castRay(
        ray,
        this.rayOriginY + 5,
        true,
        null,
        null,
        this.excludeCollider
      );

      if (hit) {
        return this.rayOriginY - hit.timeOfImpact;
      }

      return this.groundY;
    }
  }

  class LegIK {
    constructor(model, terrainBuilder, options = {}, world = null, RAPIER = null, collider = null) {
      this.model = model;
      this.terrain = terrainBuilder;
      this.world = world;
      this.RAPIER = RAPIER;
      this.collider = collider;

      this.raycastHeight = options.raycastHeight ?? 1.2;
      this.raycastLength = options.raycastLength ?? 3.5;
      this.feetPositionOffsetWeight = options.feetPositionOffsetWeight ?? 1.0;
      this.feetRotationOffsetWeight = options.feetRotationOffsetWeight ?? 1.0;
      this.feetPositionOffsetSmoothing = options.feetPositionOffsetSmoothing ?? 0.08;
      this.feetRotationOffsetSmoothing = options.feetRotationOffsetSmoothing ?? 0.1;
      this.bodyPositionOffsetWeight = options.bodyPositionOffsetWeight ?? 1.0;
      this.bodyPositionOffsetSmoothing = options.bodyPositionOffsetSmoothing ?? 0.12;
      this.invertBodyPositionOffset = options.invertBodyPositionOffset ?? false;
      // Natural height of the foot/ankle bone above the ground when standing. The
      // foot is held this far above the raycast hit so the SOLE rests on the surface
      // instead of the ankle bone sinking into it. MUST match the actual model.
      this.footSkinOffset = options.footSkinOffset ?? 0.08;
      this.crouchFootPlantMode = false;

      this.isGrounded = true;
      this.isMoving = false;
      this.jumped = false;
      this.isActive = true;
      this.speed = 0;
      this.ikRunSuppressSpeed = options.ikRunSuppressSpeed ?? 3.5;
      this.ikWalkEngageSpeed = options.ikWalkEngageSpeed ?? 1.5;
      this._globalIKBlend = 1.0;
      this._globalIKBlendSmoothing = options.globalIKBlendSmoothing ?? 0.12;

      this.boneNames = options.boneNames ?? {
        hips: ['mixamorigHips', 'mixamorig:Hips', 'Hips', 'pelvis'],
        leftThigh: ['mixamorigLeftUpLeg', 'mixamorig:LeftUpLeg', 'LeftUpLeg', 'Left_UpperLeg', 'LeftThigh'],
        leftKnee: ['mixamorigLeftLeg', 'mixamorig:LeftLeg', 'LeftLeg', 'Left_LowerLeg', 'LeftKnee'],
        leftFoot: ['mixamorigLeftFoot', 'mixamorig:LeftFoot', 'LeftFoot', 'Left_Foot'],
        rightThigh: ['mixamorigRightUpLeg', 'mixamorig:RightUpLeg', 'RightUpLeg', 'Right_UpperLeg', 'RightThigh'],
        rightKnee: ['mixamorigRightLeg', 'mixamorig:RightLeg', 'RightLeg', 'Right_LowerLeg', 'RightKnee'],
        rightFoot: ['mixamorigRightFoot', 'mixamorig:RightFoot', 'RightFoot', 'Right_Foot']
      };

      this.bones = {};
      this._resolveBones();

      this.feet = {
        left: this._makeFoot(),
        right: this._makeFoot()
      };

      this._bodyPositionOffset = 0;
      this._rootPosition = new THREE.Vector3();
      this._up = new THREE.Vector3(0, 1, 0);
      this._animSnapshot = {
        left: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() },
        right: { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }
      };
    }

    _makeFoot() {
      return {
        positionOffset: 0,
        rotationOffset: new THREE.Quaternion(),
        raycastHit: false,
        raycastHitPoint: new THREE.Vector3(),
        raycastHitNormal: new THREE.Vector3(0, 1, 0),
        raycastOrigin: new THREE.Vector3(),
        _rapierNormal: null
      };
    }

    _resolveBones() {
      const nameMap = {};
      this.model.traverse((o) => {
        if (o.name) {
          nameMap[o.name] = o;
          nameMap[o.name.replace(/^mixamorig:/, 'mixamorig')] = o;
        }
      });
      for (const [slot, candidates] of Object.entries(this.boneNames)) {
        for (const name of candidates) {
          if (nameMap[name]) {
            this.bones[slot] = nameMap[name];
            break;
          }
        }
        if (!this.bones[slot]) {
          console.warn('LegIK: bone not found for "' + slot + '". Tried: ' + candidates.join(', '));
        }
      }
    }

    update(dt, rootWorldPosition) {
      if (!this.isActive) return;

      if (rootWorldPosition) {
        this._rootPosition.copy(rootWorldPosition);
      } else {
        this.model.parent?.getWorldPosition(this._rootPosition) ??
          this.model.getWorldPosition(this._rootPosition);
      }

      const targetGlobalBlend = THREE.MathUtils.clamp(
        1 - (this.speed - this.ikWalkEngageSpeed) / (this.ikRunSuppressSpeed - this.ikWalkEngageSpeed),
        0,
        1
      );
      this._globalIKBlend = THREE.MathUtils.lerp(
        this._globalIKBlend,
        targetGlobalBlend,
        Math.min(1, dt / this._globalIKBlendSmoothing)
      );

      if (this._globalIKBlend <= 0.01) return;

      this.model.updateWorldMatrix(true, true);
      this._snapshotAnimatedPoses();
      this._getRaycastData();
      const lowestHitY = this._offsetTargets(dt);
      this._offsetBodyPosition(dt, lowestHitY);
    }

    _snapshotAnimatedPoses() {
      for (const side of ['left', 'right']) {
        const footBone = this.bones[side === 'left' ? 'leftFoot' : 'rightFoot'];
        if (!footBone) continue;
        footBone.getWorldPosition(this._animSnapshot[side].pos);
        footBone.getWorldQuaternion(this._animSnapshot[side].quat);
      }
    }

    _getRaycastData() {
      if (this.jumped || !this.isGrounded || this._globalIKBlend <= 0.01) {
        this._zeroFoot(this.feet.left);
        this._zeroFoot(this.feet.right);
        return;
      }
      this._sampleFootRaycast('left', this.feet.left);
      this._sampleFootRaycast('right', this.feet.right);
    }

    _zeroFoot(foot) {
      foot.raycastHit = false;
      foot.raycastHitPoint.set(0, 0, 0);
      foot.raycastHitNormal.set(0, 1, 0);
      foot.raycastOrigin.set(0, 0, 0);
    }

    _sampleFootRaycast(side, foot) {
      const footBone = this.bones[side === 'left' ? 'leftFoot' : 'rightFoot'];
      if (!footBone) {
        this._zeroFoot(foot);
        return;
      }

      const snap = this._animSnapshot[side];
      const originX = snap.pos.x;
      const originZ = snap.pos.z;
      const originY = this._rootPosition.y + this.raycastHeight;

      foot.raycastOrigin.set(originX, originY, originZ);

      let groundY = this.terrain.getHeightAtWorld(originX, originZ);
      foot._rapierNormal = null;

      if (this.world && this.RAPIER) {
        const ray = new this.RAPIER.Ray(
          { x: originX, y: originY, z: originZ },
          { x: 0, y: -1, z: 0 }
        );

        const hit = this.world.castRayAndGetNormal(
          ray,
          this.raycastLength,
          true,
          null,
          null,
          this.collider
        );

        if (hit) {
          const hitY = originY - hit.timeOfImpact;
          // Ignore the flat Rapier floor collider on open ground; use terrain height (Y=0).
          const isBasePlane = Math.abs(hitY) < 0.05;
          if (hitY < originY && !isBasePlane && hitY > groundY + 0.015) {
            groundY = hitY;
            foot._rapierNormal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
          }
        }
      }

      if (groundY > originY) {
        this._zeroFoot(foot);
        return;
      }
      if (originY - groundY > this.raycastLength) {
        this._zeroFoot(foot);
        return;
      }

      foot.raycastHit = true;
      foot.raycastHitPoint.set(originX, groundY, originZ);
      foot.raycastHitNormal.copy(foot._rapierNormal ?? this._sampleNormal(originX, originZ));
      foot._rapierNormal = null;
    }

    _offsetTargets(dt) {
      let lowestHitY = this._rootPosition.y;
      this._offsetOneFoot(dt, 'left', this.feet.left, (y) => {
        if (y < lowestHitY) lowestHitY = y;
      });
      this._offsetOneFoot(dt, 'right', this.feet.right, (y) => {
        if (y < lowestHitY) lowestHitY = y;
      });
      return lowestHitY;
    }

    _offsetOneFoot(dt, side, foot, trackLowest) {
      const thighBone = this.bones[side === 'left' ? 'leftThigh' : 'rightThigh'];
      const kneeBone = this.bones[side === 'left' ? 'leftKnee' : 'rightKnee'];
      const footBone = this.bones[side === 'left' ? 'leftFoot' : 'rightFoot'];
      if (!footBone || !kneeBone || !thighBone) return;

      const animatedFootPos = this._animSnapshot[side].pos.clone();
      const animatedFootQuat = this._animSnapshot[side].quat.clone();

      let footPositionOffsetTarget = 0;

      if (foot.raycastHit && this.isGrounded && this.feetPositionOffsetWeight > 0) {
        trackLowest(foot.raycastHitPoint.y);
        const footAboveGround = animatedFootPos.y - foot.raycastHitPoint.y;
        footPositionOffsetTarget = -footAboveGround;
        if (this.feetPositionOffsetWeight !== 1) {
          footPositionOffsetTarget *= this.feetPositionOffsetWeight;
        }
      }

      if (this.feetPositionOffsetSmoothing > 0) {
        foot.positionOffset = THREE.MathUtils.lerp(
          foot.positionOffset,
          footPositionOffsetTarget,
          Math.min(1, dt / this.feetPositionOffsetSmoothing)
        );
      } else {
        foot.positionOffset = footPositionOffsetTarget;
      }

      if (foot.raycastHit) {
        const minOffset = foot.raycastHitPoint.y - animatedFootPos.y + this.footSkinOffset;
        foot.positionOffset = Math.max(foot.positionOffset, minOffset);
      }

      const IK_BLEND_MAX_OFFSET = this.crouchFootPlantMode ? 0.35 : 0.05;
      const IK_BLEND_MIN_OFFSET = 0.005;
      const absOffset = Math.abs(foot.positionOffset);
      const perFootBlend = foot.raycastHit
        ? THREE.MathUtils.clamp(
            (absOffset - IK_BLEND_MIN_OFFSET) / (IK_BLEND_MAX_OFFSET - IK_BLEND_MIN_OFFSET),
            0,
            1
          )
        : 0;

      const ikBlend = perFootBlend * this._globalIKBlend;

      let targetRotOffset = new THREE.Quaternion();
      if (foot.raycastHit && this.feetRotationOffsetWeight > 0) {
        targetRotOffset.setFromUnitVectors(this._up, foot.raycastHitNormal);
        if (this.feetRotationOffsetWeight !== 1) {
          targetRotOffset.slerp(new THREE.Quaternion(), 1 - this.feetRotationOffsetWeight);
        }
      }

      if (this.feetRotationOffsetSmoothing > 0) {
        foot.rotationOffset.slerp(targetRotOffset, Math.min(1, dt / this.feetRotationOffsetSmoothing));
      } else {
        foot.rotationOffset.copy(targetRotOffset);
      }

      const ikTargetPos = animatedFootPos.clone();
      ikTargetPos.y += foot.positionOffset;

      if (foot.raycastHit) {
        const terrainY = this.terrain.getHeightAtWorld(ikTargetPos.x, ikTargetPos.z);
        ikTargetPos.y = Math.max(ikTargetPos.y, terrainY);
      }

      const ikTargetQuat = foot.rotationOffset.clone().multiply(animatedFootQuat);

      this._applyTwoBoneIK(side, ikTargetPos, ikTargetQuat, ikBlend);
      this._postIKClamp(side, foot);
    }

    _postIKClamp(side, foot) {
      if (!foot.raycastHit) return;
      const footBone = this.bones[side === 'left' ? 'leftFoot' : 'rightFoot'];
      if (!footBone) return;

      this.model.updateWorldMatrix(true, true);

      const fp = new THREE.Vector3();
      footBone.getWorldPosition(fp);
      const targetY = foot.raycastHitPoint.y + this.footSkinOffset;

      if (fp.y >= targetY) return;

      const penetration = targetY - fp.y;

      if (!footBone.parent) {
        footBone.position.y += penetration;
        return;
      }

      const parentQuat = new THREE.Quaternion();
      footBone.parent.getWorldQuaternion(parentQuat);
      const localUp = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(parentQuat.clone().invert())
        .normalize();

      footBone.position.addScaledVector(localUp, penetration);
    }

    _offsetBodyPosition(dt, lowestHitY) {
      const hipBone = this.bones.hips;
      if (!hipBone || this.bodyPositionOffsetWeight <= 0) return;

      let bodyOffsetTarget = 0;

      if (this.isGrounded) {
        const leftHit = this.feet.left.raycastHit;
        const rightHit = this.feet.right.raycastHit;

        if (leftHit || rightHit) {
          const leftDelta = leftHit
            ? this.feet.left.raycastHitPoint.y - this._animSnapshot.left.pos.y
            : 0;
          const rightDelta = rightHit
            ? this.feet.right.raycastHitPoint.y - this._animSnapshot.right.pos.y
            : 0;

          if (leftHit && rightHit) {
            bodyOffsetTarget = (leftDelta + rightDelta) / 2;
          } else if (leftHit) {
            bodyOffsetTarget = leftDelta;
          } else {
            bodyOffsetTarget = rightDelta;
          }

          bodyOffsetTarget = Math.min(bodyOffsetTarget, 0);
        }

        if (this.invertBodyPositionOffset) bodyOffsetTarget *= -1;
      }

      if (this.bodyPositionOffsetSmoothing > 0) {
        this._bodyPositionOffset = THREE.MathUtils.lerp(
          this._bodyPositionOffset,
          bodyOffsetTarget,
          Math.min(1, dt / this.bodyPositionOffsetSmoothing)
        );
      } else {
        this._bodyPositionOffset = bodyOffsetTarget;
      }

      if (Math.abs(this._bodyPositionOffset) > 0.001) {
        const hipWorldPos1 = new THREE.Vector3();
        hipBone.getWorldPosition(hipWorldPos1);

        const testAmount = 0.1;
        hipBone.position.y += testAmount;
        this.model.updateWorldMatrix(true, true);
        const hipWorldPos2 = new THREE.Vector3();
        hipBone.getWorldPosition(hipWorldPos2);

        hipBone.position.y -= testAmount;

        const worldPerLocal = (hipWorldPos2.y - hipWorldPos1.y) / testAmount;

        if (Math.abs(worldPerLocal) > 0.001) {
          const localAmount =
            (this._bodyPositionOffset * this.bodyPositionOffsetWeight * this._globalIKBlend) /
            worldPerLocal;
          hipBone.position.y += localAmount;
        }
      }
    }

    _applyTwoBoneIK(side, targetPos, targetQuat, blend = 1.0) {
      const thighBone = this.bones[side === 'left' ? 'leftThigh' : 'rightThigh'];
      const kneeBone = this.bones[side === 'left' ? 'leftKnee' : 'rightKnee'];
      const footBone = this.bones[side === 'left' ? 'leftFoot' : 'rightFoot'];
      if (!thighBone || !kneeBone || !footBone) return;
      if (blend <= 0) return;

      const pA = new THREE.Vector3();
      thighBone.getWorldPosition(pA);
      const pB = new THREE.Vector3();
      kneeBone.getWorldPosition(pB);
      const pC = new THREE.Vector3();
      footBone.getWorldPosition(pC);

      const lenUpper = pA.distanceTo(pB);
      const lenLower = pB.distanceTo(pC);
      const lenTotal = lenUpper + lenLower;

      const toTarget = new THREE.Vector3().subVectors(targetPos, pA);
      const targetDist = Math.min(toTarget.length(), lenTotal * 0.999);
      const targetDir = toTarget.clone().normalize();
      const clampedTarget = pA.clone().addScaledVector(targetDir, targetDist);

      const cosA = THREE.MathUtils.clamp(
        (lenUpper * lenUpper + targetDist * targetDist - lenLower * lenLower) /
          (2 * lenUpper * targetDist),
        -1,
        1
      );
      const angleA = Math.acos(cosA);

      const pivotMatrix = this.model.parent?.matrixWorld ?? this.model.matrixWorld;
      const pivotQuat = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().extractRotation(pivotMatrix)
      );
      const charFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(pivotQuat);
      const charRgt = new THREE.Vector3(1, 0, 0).applyQuaternion(pivotQuat);

      const poleHint = new THREE.Vector3();
      kneeBone.getWorldPosition(poleHint);
      const kneeHint = new THREE.Vector3().subVectors(poleHint, pA).normalize();

      let bendAxis = new THREE.Vector3().crossVectors(targetDir, kneeHint);
      if (bendAxis.lengthSq() < 0.0001) bendAxis.crossVectors(targetDir, charFwd);
      if (bendAxis.lengthSq() < 0.0001) bendAxis.copy(charRgt);
      bendAxis.normalize();

      const desiredThighDir = targetDir.clone().applyAxisAngle(bendAxis, angleA);
      const currentThighDir = new THREE.Vector3().subVectors(pB, pA).normalize();
      const thighDelta = new THREE.Quaternion().setFromUnitVectors(currentThighDir, desiredThighDir);

      const blendedThighDelta = new THREE.Quaternion().slerp(thighDelta, blend);
      this._applyWorldDeltaToLocal(thighBone, blendedThighDelta);

      this.model.updateWorldMatrix(true, true);
      kneeBone.getWorldPosition(pB);
      footBone.getWorldPosition(pC);

      const currentKneeDir = new THREE.Vector3().subVectors(pC, pB).normalize();
      const desiredKneeDir = new THREE.Vector3().subVectors(clampedTarget, pB).normalize();
      const kneeDelta = new THREE.Quaternion().setFromUnitVectors(currentKneeDir, desiredKneeDir);

      const blendedKneeDelta = new THREE.Quaternion().slerp(kneeDelta, blend);
      this._applyWorldDeltaToLocal(kneeBone, blendedKneeDelta);

      this.model.updateWorldMatrix(true, true);

      // Foot rotation: always applied at full weight for ground contact (reference).
      this._setWorldRotation(footBone, targetQuat);
    }

    _sampleNormal(x, z) {
      const eps = 0.25;
      const hL = this.terrain.getHeightAtWorld(x - eps, z);
      const hR = this.terrain.getHeightAtWorld(x + eps, z);
      const hD = this.terrain.getHeightAtWorld(x, z - eps);
      const hU = this.terrain.getHeightAtWorld(x, z + eps);
      return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
    }

    _applyWorldDeltaToLocal(bone, worldDelta) {
      if (!bone.parent) {
        bone.quaternion.premultiply(worldDelta);
        return;
      }
      const parentQ = new THREE.Quaternion();
      bone.parent.getWorldQuaternion(parentQ);
      const parentQInv = parentQ.clone().invert();
      const localDelta = parentQInv.clone().multiply(worldDelta).multiply(parentQ);
      bone.quaternion.premultiply(localDelta);
    }

    _setWorldRotation(bone, worldQuat) {
      if (!bone.parent) {
        bone.quaternion.copy(worldQuat);
        return;
      }
      const parentWorldQuat = new THREE.Quaternion();
      bone.parent.getWorldQuaternion(parentWorldQuat);
      bone.quaternion.copy(parentWorldQuat.clone().invert().multiply(worldQuat));
    }
  }

  window.MixamoLegIK = LegIK;

  const STORAGE_STANDING_EYE = 'bodyRigged.standingEyeHeightM';
  const STORAGE_BODY_OFFSET = 'bodyRigged.playerHeightAdjustM';
  const STORAGE_CAMERA_FLOOR = 'bodyRigged.cameraFloorOffsetM';
  const STORAGE_BODY_FORWARD = 'bodyRigged.bodyForwardOffsetM';
  const STORAGE_BODY_LATERAL = 'bodyRigged.bodyLateralOffsetM';
  const STORAGE_MODEL_SCALE = 'bodyRigged.modelVerticalScale';
  // Desktop preview: camera local Y only — rig stays on the floor (body feet anchor to rig/offset origin).
  const DESKTOP_EYE_HEIGHT = 1.6;

  function shouldExcludeCollider(collider, exclude) {
    if (!exclude) return false;
    if (Array.isArray(exclude)) {
      for (let i = 0; i < exclude.length; i++) {
        if (collider === exclude[i]) return true;
      }
      return false;
    }
    return collider === exclude;
  }

  function projectionIsInside(proj) {
    return !!(proj && (proj.isInside === true || proj.inside === true));
  }

  function sphereOverlaps(world, RAPIER, excludeCollider, centerPos, radius) {
    if (RAPIER && world.intersectionsWithShape) {
      const shape = new RAPIER.Ball(radius);
      let overlaps = false;

      world.intersectionsWithShape(
        { x: centerPos.x, y: centerPos.y, z: centerPos.z },
        { w: 1, x: 0, y: 0, z: 0 },
        shape,
        function (collider) {
          if (shouldExcludeCollider(collider, excludeCollider)) return true;
          overlaps = true;
          return false;
        }
      );

      return overlaps;
    }

    return sphereNeedsCorrectionProjectPoint(world, excludeCollider, centerPos, radius, null);
  }

  function colliderPenetration(collider, centerPos, radius) {
    const pos = { x: centerPos.x, y: centerPos.y, z: centerPos.z };
    const proj = collider.projectPoint(pos, true);
    if (!proj || !proj.point) return 0;

    const dx = pos.x - proj.point.x;
    const dy = pos.y - proj.point.y;
    const dz = pos.z - proj.point.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // isInside must be checked — distance-only misses deep embedding and thin walls.
    if (projectionIsInside(proj)) {
      return radius + dist;
    }
    return radius - dist;
  }

  function pointNeedsSphereCorrection(collider, centerPos, radius) {
    const pos = { x: centerPos.x, y: centerPos.y, z: centerPos.z };
    const proj = collider.projectPoint(pos, true);
    if (!proj || !proj.point) return false;

    if (projectionIsInside(proj)) return true;

    const dx = pos.x - proj.point.x;
    const dy = pos.y - proj.point.y;
    const dz = pos.z - proj.point.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return dist < radius - 0.0001;
  }

  function getSphereSurfaceContactPoint(collider, centerPos, radius, dest) {
    const out = dest || new THREE.Vector3();
    const pos = { x: centerPos.x, y: centerPos.y, z: centerPos.z };
    const proj = collider.projectPoint(pos, true);
    if (!proj || !proj.point) {
      out.copy(centerPos);
      return out;
    }

    const sx = proj.point.x - centerPos.x;
    const sy = proj.point.y - centerPos.y;
    const sz = proj.point.z - centerPos.z;
    const sd = Math.sqrt(sx * sx + sy * sy + sz * sz);

    if (sd < 1e-8) {
      out.set(centerPos.x, centerPos.y + radius, centerPos.z);
      return out;
    }

    const inv = radius / sd;
    out.set(
      centerPos.x + sx * inv,
      centerPos.y + sy * inv,
      centerPos.z + sz * inv
    );
    return out;
  }

  function getColliderNormalAtPoint(collider, centerPos, dest) {
    const out = dest || new THREE.Vector3();
    const pos = { x: centerPos.x, y: centerPos.y, z: centerPos.z };
    const proj = collider.projectPoint(pos, true);
    if (!proj || !proj.point) {
      out.set(0, 1, 0);
      return out;
    }

    out.set(
      centerPos.x - proj.point.x,
      centerPos.y - proj.point.y,
      centerPos.z - proj.point.z
    );

    if (out.lengthSq() < 1e-8) {
      out.set(0, 1, 0);
    } else {
      out.normalize();
    }
    return out;
  }

  function computeSeparationAxis(collider, sphereCenter, target, radius, fallbackAxis) {
    const contact = getSphereSurfaceContactPoint(collider, sphereCenter, radius, new THREE.Vector3());
    const axis = new THREE.Vector3().subVectors(target, contact);
    if (axis.lengthSq() > 1e-8) {
      axis.normalize();
      return axis;
    }
    if (fallbackAxis) {
      return fallbackAxis.clone();
    }
    return getColliderNormalAtPoint(collider, sphereCenter, new THREE.Vector3());
  }

  function slideHandSphereOnCollider(collider, lastResolved, lastDesired, desired, radius, lockAxis, trackingPos) {
    if (!lastResolved || !lastDesired) {
      return placeSphereOnColliderFromProbe(collider, desired, desired, radius);
    }

    const track = trackingPos || desired;
    const base = placeSphereOnColliderFromProbe(collider, lastResolved, lastResolved, radius);
    const start = sphereOverlapsCollider(collider, base, radius) ? lastResolved.clone() : base;

    const outwardAxis = lockAxis
      ? lockAxis.clone()
      : computeSeparationAxis(collider, start, track, radius, null);

    const delta = new THREE.Vector3().subVectors(track, lastDesired);
    const axisDot = outwardAxis.dot(delta);
    const allowedDelta = delta.clone();
    if (axisDot < 0) {
      allowedDelta.addScaledVector(outwardAxis, -axisDot);
    }

    const candidate = start.clone().add(allowedDelta);
    const tSafe = findMaxSafeTOnSegmentForCollider(start, candidate, collider, radius);
    const probe = start.clone().lerp(candidate, tSafe);
    let resolved = placeSphereOnColliderFromProbe(collider, probe, probe, radius);

    if (sphereOverlapsCollider(collider, resolved, radius)) {
      resolved = placeSphereOnColliderFromProbe(collider, start, start, radius);
    }
    if (sphereOverlapsCollider(collider, resolved, radius)) {
      resolved = start.clone();
    }

    return resolved;
  }

  function findDominantCollider(world, excludeCollider, centerPos, radius) {
    let bestCollider = null;
    let bestPen = 0;

    world.forEachCollider(function (collider) {
      if (shouldExcludeCollider(collider, excludeCollider)) return;

      const pen = colliderPenetration(collider, centerPos, radius);
      if (pen > bestPen) {
        bestPen = pen;
        bestCollider = collider;
      }
    });

    if (!bestCollider || bestPen <= 0.0001) return null;
    return { collider: bestCollider, penetration: bestPen };
  }

  function sphereOverlapsCollider(collider, centerPos, radius) {
    return pointNeedsSphereCorrection(collider, centerPos, radius);
  }

  function findFreePointBeforeOverlap(desired, awayFrom, collider, radius, maxBack) {
    const dir = desired.clone().sub(awayFrom);
    if (dir.lengthSq() < 1e-8) {
      dir.set(0, 0, 1);
    } else {
      dir.normalize();
    }

    const backDist = maxBack || 1.5;
    const far = desired.clone().addScaledVector(dir, backDist);

    if (!sphereOverlapsCollider(collider, desired, radius)) {
      return desired.clone();
    }

    if (!sphereOverlapsCollider(collider, far, radius)) {
      let tLow = 0;
      let tHigh = 1;
      const probe = new THREE.Vector3();

      for (let i = 0; i < 12; i++) {
        const t = (tLow + tHigh) * 0.5;
        probe.copy(far).lerp(desired, t);
        if (sphereOverlapsCollider(collider, probe, radius)) {
          tHigh = t;
        } else {
          tLow = t;
        }
      }

      return far.clone().lerp(desired, tLow);
    }

    return far.clone();
  }

  function findMaxSafeTOnSegmentForCollider(start, end, collider, radius) {
    if (!sphereOverlapsCollider(collider, end, radius)) {
      return 1;
    }

    if (!sphereOverlapsCollider(collider, start, radius)) {
      let tLow = 0;
      let tHigh = 1;
      const probe = new THREE.Vector3();

      for (let i = 0; i < 12; i++) {
        const t = (tLow + tHigh) * 0.5;
        probe.copy(start).lerp(end, t);
        if (sphereOverlapsCollider(collider, probe, radius)) {
          tHigh = t;
        } else {
          tLow = t;
        }
      }
      return tLow;
    }

    return 0;
  }

  function placeSphereOnColliderFromProbe(collider, probe, pullToward, radius) {
    const pos = { x: probe.x, y: probe.y, z: probe.z };
    const proj = collider.projectPoint(pos, true);
    if (!proj || !proj.point) return pullToward.clone();

    const tx = pullToward.x - proj.point.x;
    const ty = pullToward.y - proj.point.y;
    const tz = pullToward.z - proj.point.z;
    const tdist = Math.sqrt(tx * tx + ty * ty + tz * tz);

    if (tdist < 0.0001) {
      const fallback = pullToward.clone().sub(probe);
      if (fallback.lengthSq() < 1e-8) {
        fallback.set(0, 0, 1);
      } else {
        fallback.normalize();
      }
      return new THREE.Vector3(
        proj.point.x + fallback.x * radius,
        proj.point.y + fallback.y * radius,
        proj.point.z + fallback.z * radius
      );
    }

    const inv = radius / tdist;
    return new THREE.Vector3(
      proj.point.x + tx * inv,
      proj.point.y + ty * inv,
      proj.point.z + tz * inv
    );
  }

  function findMaxSafeTOnSegment(start, end, world, RAPIER, exclude, radius) {
    if (!sphereOverlaps(world, RAPIER, exclude, end, radius)) {
      return 1;
    }

    if (!sphereOverlaps(world, RAPIER, exclude, start, radius)) {
      let tLow = 0;
      let tHigh = 1;
      const probe = new THREE.Vector3();

      for (let i = 0; i < 12; i++) {
        const t = (tLow + tHigh) * 0.5;
        probe.copy(start).lerp(end, t);
        if (sphereOverlaps(world, RAPIER, exclude, probe, radius)) {
          tHigh = t;
        } else {
          tLow = t;
        }
      }
      return tLow;
    }

    return 0;
  }

  function sphereNeedsCorrection(world, excludeCollider, srcPos, radius, segmentFrom, RAPIER) {
    if (sphereOverlaps(world, RAPIER, excludeCollider, srcPos, radius)) {
      return true;
    }

    if (!segmentFrom) return false;

    const probe = new THREE.Vector3();
    for (let i = 1; i <= 4; i++) {
      probe.copy(segmentFrom).lerp(srcPos, i / 4);
      if (sphereOverlaps(world, RAPIER, excludeCollider, probe, radius)) {
        return true;
      }
    }

    return false;
  }

  function sphereNeedsCorrectionProjectPoint(world, excludeCollider, srcPos, radius, segmentFrom) {
    const pos = { x: srcPos.x, y: srcPos.y, z: srcPos.z };
    let needs = false;

    world.forEachCollider(function (collider) {
      if (shouldExcludeCollider(collider, excludeCollider)) return;
      if (pointNeedsSphereCorrection(collider, pos, radius)) {
        needs = true;
      }
    });

    if (needs || !segmentFrom) return needs;

    const probe = new THREE.Vector3();
    for (let i = 1; i <= 4; i++) {
      probe.copy(segmentFrom).lerp(srcPos, i / 4);
      world.forEachCollider(function (collider) {
        if (shouldExcludeCollider(collider, excludeCollider)) return;
        if (pointNeedsSphereCorrection(collider, probe, radius)) {
          needs = true;
        }
      });
      if (needs) break;
    }

    return needs;
  }

  function resolveSphereAgainstColliders(world, excludeCollider, srcPos, radius, options) {
    const horizontalOnly = options && options.horizontalOnly;
    const maxIterations = (options && options.maxIterations) || 8;
    const pos = { x: srcPos.x, y: srcPos.y, z: srcPos.z };
    let anyHit = false;

    for (let iter = 0; iter < maxIterations; iter++) {
      let moved = false;

      world.forEachCollider(function (collider) {
        if (shouldExcludeCollider(collider, excludeCollider)) return;

        const proj = collider.projectPoint(pos, true);
        if (!proj || !proj.point) return;

        const toCenterX = pos.x - proj.point.x;
        const toCenterY = pos.y - proj.point.y;
        const toCenterZ = pos.z - proj.point.z;
        const dist = Math.sqrt(toCenterX * toCenterX + toCenterY * toCenterY + toCenterZ * toCenterZ);

        if (dist >= radius - 0.0001 && !projectionIsInside(proj)) return;

        if (projectionIsInside(proj) || dist < 0.0001) {
          const tx = pos.x - proj.point.x;
          const ty = pos.y - proj.point.y;
          const tz = pos.z - proj.point.z;
          const tdist = Math.sqrt(tx * tx + ty * ty + tz * tz);
          if (tdist < 0.0001) {
            pos.x = proj.point.x;
            pos.y = proj.point.y + radius;
            pos.z = proj.point.z;
          } else {
            const inv = radius / tdist;
            if (projectionIsInside(proj)) {
              pos.x = proj.point.x - tx * inv;
              pos.y = proj.point.y - ty * inv;
              pos.z = proj.point.z - tz * inv;
            } else {
              pos.x = proj.point.x + tx * inv;
              pos.y = proj.point.y + ty * inv;
              pos.z = proj.point.z + tz * inv;
            }
          }
        } else {
          const invDist = 1 / dist;
          pos.x = proj.point.x + toCenterX * invDist * radius;
          pos.y = proj.point.y + toCenterY * invDist * radius;
          pos.z = proj.point.z + toCenterZ * invDist * radius;
        }

        if (horizontalOnly) {
          pos.y = srcPos.y;
        }

        moved = true;
      });

      if (!moved) break;
      anyHit = true;
    }

    return {
      position: new THREE.Vector3(pos.x, pos.y, pos.z),
      hit: anyHit
    };
  }

  AFRAME.registerComponent('leg-ik-world', {
    init: function () {
      // On <a-scene>, this.el IS the scene — sceneEl is only set on child entities.
      this.scene = this.el;
      this.ready = false;
      this.terrain = new SimpleTerrainBuilder({ groundY: 0 });
      const savedEye = this._loadConfiguredHeight();
      const savedOffset = this._loadBodyOffset();
      const savedCameraFloor = this._loadCameraFloorOffset();
      const savedBodyForward = this._loadBodyForwardOffset();
      const savedBodyLateral = this._loadBodyLateralOffset();
      const savedModelScale = this._loadModelVerticalScale();
      this.scene.legIkWorld = {
          ready: false,
          terrain: this.terrain,
          world: null,
          RAPIER: null,
          playerCollider: null,
          footCollider: null,
          isPlayerGrounded: true,
          playerSpeed: 0,
          configuredStandingEyeY: savedEye,
          standingEyeLocalY: savedEye ?? 1.6,
          playerHeightAdjustM: savedOffset,
          cameraFloorOffsetM: savedCameraFloor,
          bodyForwardOffsetM: savedBodyForward,
          bodyLateralOffsetM: savedBodyLateral,
          modelVerticalScale: savedModelScale,
          crouchAmount: 0,
          mantleCrouchAmount: 0
        };

      this._applyCameraFloorOffset();
      this._updateVRHeightPanel();

      this._prevCamLocal = new THREE.Vector3();
      this._prevCamLocalInitialized = false;
      this._lastRecenterMs = 0;
      this._boundRefSpace = null;
      this._refSpaceResetHandler = null;
      this._ledgeProbeDir = new THREE.Vector3();
      this._ledgeStandTest = new THREE.Vector3();
      this._ledgeMantleTarget = new THREE.Vector3();
      this._ledgeMantleStartPos = new THREE.Vector3();
      this._ledgeMantleActive = false;
      this._ledgeMantleStartDist = 0;
      this._ledgeMantleProgress = 0;
      this._ledgeMantleDuration = 0.5;
      this._ledgeMantlePlan = null;
      this._grabPullRising = false;
      this.mantleCrouchAmount = 0;
      this._colliderCrouchT = -1;
      this._capsuleHalfH = 0.6;
      this._capsuleRadius = 0.4;
      this._capsuleCenterY = 0.9;
      this.ledgeMantleSpeed = 2.8;
      this.ledgeMantleArriveDist = 0.05;

      this._onEnterVR = this._onEnterVR.bind(this);
      this._onExitVR = this._onExitVR.bind(this);
      this.el.addEventListener('enter-vr', this._onEnterVR);
      this.el.addEventListener('exit-vr', this._onExitVR);

      this._initRapier();
    },

    _loadConfiguredHeight: function () {
      try {
        const raw = localStorage.getItem(STORAGE_STANDING_EYE);
        if (raw == null) return null;
        const v = parseFloat(raw);
        return v >= 1.15 && v <= 2.25 ? v : null;
      } catch (e) {
        return null;
      }
    },

    _saveConfiguredHeight: function (y) {
      try {
        localStorage.setItem(STORAGE_STANDING_EYE, String(y));
      } catch (e) { /* ignore */ }
    },

    _loadBodyOffset: function () {
      try {
        const v = parseFloat(localStorage.getItem(STORAGE_BODY_OFFSET));
        return v >= -0.6 && v <= 0.6 ? v : 0;
      } catch (e) {
        return 0;
      }
    },

    _saveBodyOffset: function (offset) {
      try {
        localStorage.setItem(STORAGE_BODY_OFFSET, String(offset));
      } catch (e) { /* ignore */ }
    },

    _loadCameraFloorOffset: function () {
      try {
        const v = parseFloat(localStorage.getItem(STORAGE_CAMERA_FLOOR));
        return v >= -0.5 && v <= 0.5 ? v : 0;
      } catch (e) {
        return 0;
      }
    },

    _saveCameraFloorOffset: function (offset) {
      try {
        localStorage.setItem(STORAGE_CAMERA_FLOOR, String(offset));
      } catch (e) { /* ignore */ }
    },

    _loadBodyForwardOffset: function () {
      try {
        const v = parseFloat(localStorage.getItem(STORAGE_BODY_FORWARD));
        return v >= -0.6 && v <= 0.6 ? v : 0;
      } catch (e) {
        return 0;
      }
    },

    _saveBodyForwardOffset: function (offset) {
      try {
        localStorage.setItem(STORAGE_BODY_FORWARD, String(offset));
      } catch (e) { /* ignore */ }
    },

    _loadBodyLateralOffset: function () {
      try {
        const v = parseFloat(localStorage.getItem(STORAGE_BODY_LATERAL));
        return v >= -0.4 && v <= 0.4 ? v : 0;
      } catch (e) {
        return 0;
      }
    },

    _saveBodyLateralOffset: function (offset) {
      try {
        localStorage.setItem(STORAGE_BODY_LATERAL, String(offset));
      } catch (e) { /* ignore */ }
    },

    _loadModelVerticalScale: function () {
      try {
        const v = parseFloat(localStorage.getItem(STORAGE_MODEL_SCALE));
        return v >= 0.85 && v <= 1.35 ? v : 1;
      } catch (e) {
        return 1;
      }
    },

    _saveModelVerticalScale: function (scale) {
      try {
        localStorage.setItem(STORAGE_MODEL_SCALE, String(scale));
      } catch (e) { /* ignore */ }
    },

    _getTrackedEyeLocalY: function () {
      const camera = document.getElementById('camera');
      return camera?.object3D?.position?.y ?? 0;
    },

    // Tracked headset Y plus calibration offset on #camera-rig (height above local-floor Y=0).
    _getEffectiveEyeLocalY: function () {
      const offset = this.scene.legIkWorld?.cameraFloorOffsetM || 0;
      return this._getTrackedEyeLocalY() + offset;
    },

    _applyCameraFloorOffset: function () {
      const el = document.getElementById('vr-player-offset');
      if (!el || !this.scene.legIkWorld) return;
      el.object3D.position.y = this.scene.legIkWorld.cameraFloorOffsetM || 0;
    },

    _nudgeCameraFloorOffset: function (delta) {
      const w = this.scene.legIkWorld;
      if (!w) return;
      const next = THREE.MathUtils.clamp((w.cameraFloorOffsetM || 0) + delta, -0.5, 0.5);
      if (Math.abs(next - (w.cameraFloorOffsetM || 0)) < 1e-5) return;
      w.cameraFloorOffsetM = next;
      this._saveCameraFloorOffset(next);
      this._applyCameraFloorOffset();
      this.scene.emit('vr-camera-calibrated', { cameraFloorOffsetM: next });
      this._updateVRHeightPanel();
    },

    adjustCameraHeight: function (delta) {
      this._nudgeCameraFloorOffset(delta);
    },

    _nudgeBodyOffset: function (delta) {
      const w = this.scene.legIkWorld;
      if (!w) return;
      const next = THREE.MathUtils.clamp((w.playerHeightAdjustM || 0) + delta, -0.6, 0.6);
      if (Math.abs(next - (w.playerHeightAdjustM || 0)) < 1e-5) return;
      w.playerHeightAdjustM = next;
      this._saveBodyOffset(next);
      this.scene.emit('vr-height-adjusted', { playerHeightAdjustM: next });
      this._updateVRHeightPanel();
    },

    adjustBody: function (delta) {
      this._nudgeBodyOffset(delta);
    },

    _nudgeBodyForwardOffset: function (delta) {
      const w = this.scene.legIkWorld;
      if (!w) return;
      const next = THREE.MathUtils.clamp((w.bodyForwardOffsetM || 0) + delta, -0.6, 0.6);
      if (Math.abs(next - (w.bodyForwardOffsetM || 0)) < 1e-5) return;
      w.bodyForwardOffsetM = next;
      this._saveBodyForwardOffset(next);
      this.scene.emit('vr-body-position-adjusted', { bodyForwardOffsetM: next });
      this._updateVRHeightPanel();
    },

    adjustBodyForward: function (delta) {
      this._nudgeBodyForwardOffset(delta);
    },

    _nudgeBodyLateralOffset: function (delta) {
      const w = this.scene.legIkWorld;
      if (!w) return;
      const next = THREE.MathUtils.clamp((w.bodyLateralOffsetM || 0) + delta, -0.4, 0.4);
      if (Math.abs(next - (w.bodyLateralOffsetM || 0)) < 1e-5) return;
      w.bodyLateralOffsetM = next;
      this._saveBodyLateralOffset(next);
      this.scene.emit('vr-body-position-adjusted', { bodyLateralOffsetM: next });
      this._updateVRHeightPanel();
    },

    adjustBodyLateral: function (delta) {
      this._nudgeBodyLateralOffset(delta);
    },

    _nudgeModelVerticalScale: function (delta) {
      const w = this.scene.legIkWorld;
      if (!w) return;
      const next = THREE.MathUtils.clamp((w.modelVerticalScale || 1) + delta, 0.85, 1.35);
      if (Math.abs(next - (w.modelVerticalScale || 1)) < 1e-5) return;
      w.modelVerticalScale = next;
      this._saveModelVerticalScale(next);
      this.scene.emit('vr-model-scaled', { modelVerticalScale: next });
      this._updateVRHeightPanel();
    },

    adjustModelScale: function (delta) {
      this._nudgeModelVerticalScale(delta);
    },

    _nudgeStandingEye: function (delta) {
      const w = this.scene.legIkWorld;
      if (!w) return;
      let next = (w.standingEyeLocalY || 1.6) + delta;
      next = THREE.MathUtils.clamp(next, 1.15, 2.25);
      if (Math.abs(next - w.standingEyeLocalY) < 1e-5) return;
      w.standingEyeLocalY = next;
      w.configuredStandingEyeY = next;
      w.crouchAmount = 0;
      this._saveConfiguredHeight(next);
      this.scene.emit('vr-height-calibrated', { standingEyeLocalY: next, source: 'vr-manual' });
      this._updateVRHeightPanel();
    },

    adjustStandingBaseline: function (delta) {
      this._nudgeStandingEye(delta);
    },

    _updateVRHeightPanel: function () {
      const w = this.scene.legIkWorld;
      if (!w) return;
      const body = w.playerHeightAdjustM ?? 0;
      const offset = w.cameraFloorOffsetM ?? 0;
      const stand = w.standingEyeLocalY ?? 1.6;
      const forward = w.bodyForwardOffsetM ?? 0;
      const lateral = w.bodyLateralOffsetM ?? 0;
      const scale = w.modelVerticalScale ?? 1;
      const fmtSigned = (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + ' m';
      const offsetEl = document.getElementById('vr-val-offset');
      const bodyEl = document.getElementById('vr-val-body');
      const forwardEl = document.getElementById('vr-val-forward');
      const lateralEl = document.getElementById('vr-val-lateral');
      const scaleEl = document.getElementById('vr-val-scale');
      const camEl = document.getElementById('vr-val-cam');
      const standEl = document.getElementById('vr-val-stand');
      if (offsetEl) offsetEl.setAttribute('value', fmtSigned(offset));
      if (bodyEl) bodyEl.setAttribute('value', fmtSigned(body));
      if (forwardEl) forwardEl.setAttribute('value', fmtSigned(forward));
      if (lateralEl) lateralEl.setAttribute('value', fmtSigned(lateral));
      if (scaleEl) scaleEl.setAttribute('value', scale.toFixed(2) + '×');
      if (standEl) standEl.setAttribute('value', stand.toFixed(2) + ' m');
      if (this.el.is('vr-mode')) {
        const tracked = this._getTrackedEyeLocalY();
        if (camEl) camEl.setAttribute('value', tracked.toFixed(2) + ' m');
      } else if (camEl) {
        camEl.setAttribute('value', '—');
      }
    },

    _isValidEyeHeight: function (y) {
      return typeof y === 'number' && y >= 1.15 && y <= 2.25;
    },

    // Manual eye height in meters (stored + used as standing baseline).
    setConfiguredStandingEyeHeight: function (meters) {
      if (!this._isValidEyeHeight(meters) || !this.scene.legIkWorld) return false;
      this.scene.legIkWorld.configuredStandingEyeY = meters;
      this.scene.legIkWorld.standingEyeLocalY = meters;
      this._saveConfiguredHeight(meters);
      this.scene.emit('vr-height-calibrated', {
        standingEyeLocalY: meters,
        source: 'manual-input'
      });
      console.log('[Leg IK World] Standing eye height set (manual):', meters.toFixed(2), 'm');
      return true;
    },

    // Stand straight on the physical floor, then call this (VR panel Calibrate button).
    calibrateStandingHeight: function (source) {
      const camera = document.getElementById('camera');
      if (!camera || !this.scene.legIkWorld) return false;
      if (!this.el.is('vr-mode')) {
        console.warn('[Leg IK World] Calibrate standing requires VR mode');
        return false;
      }

      const trackedY = this._getTrackedEyeLocalY();
      if (!this._isValidEyeHeight(trackedY)) {
        console.warn('[Leg IK World] Calibrate failed — tracked eye Y out of range:', trackedY);
        return false;
      }

      const w = this.scene.legIkWorld;
      w.configuredStandingEyeY = trackedY;
      w.standingEyeLocalY = trackedY;
      w.crouchAmount = 0;
      this._saveConfiguredHeight(trackedY);

      const modelEye = w.modelEyeHeightM || 1.573;
      const scale = THREE.MathUtils.clamp(trackedY / modelEye, 0.85, 1.35);
      w.modelVerticalScale = scale;
      this._saveModelVerticalScale(scale);

      this.scene.emit('vr-height-calibrated', {
        standingEyeLocalY: trackedY,
        source: source || 'manual-calibrate'
      });
      this.scene.emit('vr-model-scaled', { modelVerticalScale: scale });
      this._updateVRHeightPanel();
      console.log(
        '[Leg IK World] Standing baseline (tracked):', trackedY.toFixed(2), 'm',
        'model scale:', scale.toFixed(2) + '×'
      );
      return true;
    },

    _applyStandingEyeHeight: function (reason) {
      const legIkWorld = this.scene.legIkWorld;
      if (!legIkWorld) return;

      const configured = legIkWorld.configuredStandingEyeY;
      if (configured != null) {
        legIkWorld.standingEyeLocalY = configured;
        return;
      }

      if (reason === 'enter-vr' || reason === 'reference-space-reset') {
        const trackedY = this._getTrackedEyeLocalY();
        if (this._isValidEyeHeight(trackedY)) {
          legIkWorld.standingEyeLocalY = trackedY;
        }
      }
    },

    _applyDesktopCameraHeight: function () {
      if (this.el.is('vr-mode')) return;
      const camera = document.getElementById('camera');
      if (!camera) return;
      camera.object3D.position.set(0, DESKTOP_EYE_HEIGHT, 0);
    },

    _resetVRCameraLocal: function () {
      const camera = document.getElementById('camera');
      if (!camera) return;
      camera.object3D.position.set(0, 0, 0);
    },

    _onEnterVR: function () {
      this._resetVRCameraLocal();
      this._applyCameraFloorOffset();
      this._bindReferenceSpaceReset();
      this._applyStandingEyeHeight('enter-vr');
    },

    _onExitVR: function () {
      this._syncRigToPhysics();
      if (this.scene.legIkWorld) {
        this.scene.legIkWorld.crouchAmount = 0;
      }
      this._prevCamLocalInitialized = false;
      this._applyDesktopCameraHeight();
    },

    _bindReferenceSpaceReset: function () {
      const renderer = this.el.renderer;
      if (!renderer?.xr?.getReferenceSpace) return;

      const tryBind = () => {
        if (!this.el.is('vr-mode')) return;
        const refSpace = renderer.xr.getReferenceSpace();
        if (!refSpace) {
          setTimeout(tryBind, 50);
          return;
        }
        if (this._boundRefSpace === refSpace) return;

        if (this._boundRefSpace && this._refSpaceResetHandler) {
          this._boundRefSpace.removeEventListener('reset', this._refSpaceResetHandler);
        }

        this._refSpaceResetHandler = () => {
          this._recenterPlayer('reference-space-reset');
        };
        refSpace.addEventListener('reset', this._refSpaceResetHandler);
        this._boundRefSpace = refSpace;
      };

      tryBind();
    },

    _setVRRigFeetUnderHead: function () {
      const rig = document.getElementById('rig');
      const camera = document.getElementById('camera');
      const offsetEl = document.getElementById('vr-player-offset');
      if (!rig || !camera || !this.terrain) return;

      const headWorld = new THREE.Vector3();
      camera.object3D.getWorldPosition(headWorld);
      const camLocal = camera.object3D.position;
      const off = offsetEl?.object3D?.position || { x: 0, y: 0, z: 0 };
      const groundY = this.terrain.getHeightAtWorld(headWorld.x, headWorld.z);

      // Rig Y = floor only. Camera local Y is eye height — never subtract it from rig Y.
      rig.object3D.position.set(
        headWorld.x - off.x - camLocal.x,
        groundY,
        headWorld.z - off.z - camLocal.z
      );
    },

    _recenterPlayer: function (reason) {
      const rig = document.getElementById('rig');
      const camera = document.getElementById('camera');
      if (!rig || !camera || !this.playerBody || !this.terrain) return;

      const headWorld = new THREE.Vector3();
      camera.object3D.getWorldPosition(headWorld);
      const groundY = this.terrain.getHeightAtWorld(headWorld.x, headWorld.z);
      const camLocal = camera.object3D.position;

      this.playerVelY = 0;

      if (this.el.is('vr-mode')) {
        this._setVRRigFeetUnderHead();
      } else {
        this._applyDesktopCameraHeight();
        this._setVRRigFeetUnderHead();
      }
      const rigPos = rig.object3D.position;
      this.playerBody.setTranslation({ x: rigPos.x, y: groundY, z: rigPos.z }, true);
      if (this._playerRootPos) {
        this._playerRootPos.set(headWorld.x, groundY, headWorld.z);
      }

      if (reason !== 'origin-jump') {
        this._applyStandingEyeHeight(reason);
      } else if (this.scene.legIkWorld.configuredStandingEyeY != null) {
        this.scene.legIkWorld.standingEyeLocalY = this.scene.legIkWorld.configuredStandingEyeY;
      }

      this._prevCamLocal.copy(camLocal);
      this._prevCamLocalInitialized = true;
      this._lastRecenterMs = performance.now();

      this.scene.emit('vr-recenter', { reason: reason || 'unknown' });
      console.log(
        '[Leg IK World] VR recenter:',
        reason,
        'standingEyeLocalY',
        this.scene.legIkWorld.standingEyeLocalY.toFixed(2)
      );
    },

    _detectOriginJump: function () {
      // Disabled — local-floor room-scale and crouch change camera local Y; recenter caused fly-up.
    },

    _updateVRCrouch: function () {
      if (!this.el.is('vr-mode') || !this.scene.legIkWorld) {
        if (this.scene.legIkWorld) this.scene.legIkWorld.crouchAmount = 0;
        return;
      }

      const camera = document.getElementById('camera');
      if (!camera) return;

      const standing = this.scene.legIkWorld.standingEyeLocalY || 1.6;
      const camY = this._getTrackedEyeLocalY();
      const drop = standing - camY;
      const CROUCH_START = 0.08;
      const CROUCH_FULL = 0.55;
      let target = (drop - CROUCH_START) / (CROUCH_FULL - CROUCH_START);
      target = THREE.MathUtils.clamp(target, 0, 1);

      const prev = this.scene.legIkWorld.crouchAmount || 0;
      this.scene.legIkWorld.crouchAmount = THREE.MathUtils.lerp(prev, target, 0.22);
    },

    _syncRigToPhysics: function () {
      const rig = document.getElementById('rig');
      if (!rig || !this.playerBody) return;
      const pos = this.playerBody.translation();
      rig.object3D.position.set(pos.x, pos.y, pos.z);
    },

    _initRapier: async function () {
      try {
        const RAPIER = await import(
          'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js'
        );
        await RAPIER.init();

        const world = new RAPIER.World({ x: 0, y: -20, z: 0 });

        const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(20, 0.05, 20).setTranslation(0, -0.05, 0).setFriction(0.9),
          groundBody
        );

        this._addSceneColliders(RAPIER, world);

        this.world = world;
        this.RAPIER = RAPIER;

        this.terrain = new RapierTerrainQuery({
          world: this.world,
          RAPIER: this.RAPIER,
          groundY: 0
        });

        await this._loadReferenceObstacles(RAPIER, world);

        this.ready = true;
        this._initPlayerPhysics(RAPIER, world);
        this.terrain.setExcludeCollider(this.playerCollider);
        this._initHeadCollision();
        this.handCollisionRadius = 0.05;
        this._handDominantColliderLeft = null;
        this._handDominantColliderRight = null;
        this._handPalmDebugLeft = null;
        this._handPalmDebugRight = null;
        this._playerExcludeColliders = null;
        this._playerRootPos = new THREE.Vector3();

        // Mutate the existing object in place (do NOT replace it) so any references
        // captured before physics finished still see ready:true and the live data.
        Object.assign(this.scene.legIkWorld, {
          ready: true,
          terrain: this.terrain,
          world: this.world,
          RAPIER: this.RAPIER,
          playerCollider: this.playerCollider,
          footCollider: this.footCollider,
          isPlayerGrounded: true,
          playerSpeed: 0,
          playerRootPos: this._playerRootPos,
          configuredStandingEyeY: this._loadConfiguredHeight(),
          standingEyeLocalY: this._loadConfiguredHeight() ?? 1.6,
          playerHeightAdjustM: this._loadBodyOffset(),
          cameraFloorOffsetM: this.scene.legIkWorld.cameraFloorOffsetM ?? this._loadCameraFloorOffset(),
          bodyForwardOffsetM: this.scene.legIkWorld.bodyForwardOffsetM ?? this._loadBodyForwardOffset(),
          bodyLateralOffsetM: this.scene.legIkWorld.bodyLateralOffsetM ?? this._loadBodyLateralOffset(),
          modelVerticalScale: this.scene.legIkWorld.modelVerticalScale ?? this._loadModelVerticalScale(),
          crouchAmount: 0,
          mantleCrouchAmount: 0
        });
        this._applyCameraFloorOffset();
        this._updateVRHeightPanel();

        const status = document.querySelector('#status');
        if (status && status.textContent === 'Loading...') {
          status.textContent = 'Physics ready';
          status.style.color = '#4CAF50';
        }

        console.log('[Leg IK World] Rapier physics + reference obstacles initialized');
      } catch (err) {
        console.warn('[Leg IK World] Rapier unavailable, using flat terrain only:', err);
        this.scene.legIkWorld.ready = true;
      }
    },

    _waitForGltfLoader: function () {
      return new Promise((resolve) => {
        const check = () => {
          if (window.BodyRiggedLoaders?.ready) resolve();
          else setTimeout(check, 50);
        };
        check();
      });
    },

    _installObstacleTrimesh: function (model, world, RAPIER) {
      const vertices = [];
      const indices = [];
      let indexOffset = 0;

      model.updateWorldMatrix(true, true);

      model.traverse((child) => {
        if (!child.isMesh) return;

        const geo = child.geometry.clone();
        geo.applyMatrix4(child.matrixWorld);

        const pos = geo.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          vertices.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        }

        const idx = geo.getIndex();
        if (idx) {
          for (let i = 0; i < idx.count; i++) {
            indices.push(idx.getX(i) + indexOffset);
          }
        } else {
          for (let i = 0; i < pos.count; i++) {
            indices.push(i + indexOffset);
          }
        }

        indexOffset += pos.count;
      });

      if (vertices.length === 0) {
        console.warn('[Leg IK World] Obstacle trimesh: no vertices');
        return;
      }

      const vertexArray = new Float32Array(vertices);
      const indexArray = new Uint32Array(indices);

      try {
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        const collider = world.createCollider(
          RAPIER.ColliderDesc.trimesh(vertexArray, indexArray).setFriction(0.7),
          body
        );
        console.log(
          '[Leg IK World] Trimesh collider:',
          indexArray.length / 3,
          'tris,',
          vertexArray.length / 3,
          'verts'
        );
        return collider;
      } catch (err) {
        console.warn('[Leg IK World] Trimesh failed, using AABB cuboid fallback:', err);
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(size.x * 0.5, size.y * 0.5, size.z * 0.5)
            .setTranslation(center.x, center.y, center.z)
            .setFriction(0.7),
          body
        );
      }
    },

    _placeObstacleOnGround: function (model, x, z) {
      const threeScene = this.el.object3D;
      model.position.set(x, 0, z);
      threeScene.add(model);
      model.updateWorldMatrix(true, true);

      const box = new THREE.Box3().setFromObject(model);
      model.position.y -= box.min.y;
      model.updateWorldMatrix(true, true);
    },

    _loadReferenceObstacles: async function (RAPIER, world) {
      await this._waitForGltfLoader();

      const loader = new window.BodyRiggedLoaders.GLTFLoader();
      const obstacles = [
        { url: obstacleGlbUrl('Problem_1.glb'), x: 4, z: -5, name: 'Ramp' },
        { url: obstacleGlbUrl('Problem_2.glb'), x: 7, z: -5, name: 'Stairs' }
      ];

      for (const cfg of obstacles) {
        await new Promise((resolve, reject) => {
          loader.load(
            cfg.url,
            (gltf) => {
              const model = gltf.scene;
              model.traverse((child) => {
                if (child.isMesh) {
                  child.castShadow = true;
                  child.receiveShadow = true;
                  if (child.material) {
                    child.material = child.material.clone();
                  }
                }
              });

              this._placeObstacleOnGround(model, cfg.x, cfg.z);
              this._installObstacleTrimesh(model, world, RAPIER);
              console.log('[Leg IK World] Loaded obstacle:', cfg.name, 'at', cfg.x, cfg.z);
              resolve();
            },
            undefined,
            (err) => {
              console.warn('[Leg IK World] Failed to load', cfg.url, err);
              resolve();
            }
          );
        });
      }
    },

    _addSceneColliders: function (RAPIER, world) {
      // Wall: box at (2, 1, -1), size 0.2 x 2 x 2
      const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(0.1, 1.0, 1.0).setTranslation(2, 1, -1).setFriction(0.8),
        wallBody
      );

      // Pillar: cylinder at (-1.5, 1, -1.5), radius 0.3, height 2
      const pillarBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      world.createCollider(
        RAPIER.ColliderDesc.cylinder(1.0, 0.3).setTranslation(-1.5, 1, -1.5).setFriction(0.8),
        pillarBody
      );

      console.log('[Leg IK World] Scene colliders added (wall + pillar)');
    },

    _initPlayerPhysics: function (RAPIER, world) {
      const rig = document.getElementById('rig');
      if (!rig) return;

      const start = rig.object3D.position;
      const groundY = this.terrain.getHeightAtWorld(start.x, start.z);
      const bodyY = groundY;

      this.playerBody = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(start.x, bodyY, start.z)
      );

      this.playerCollider = world.createCollider(
        RAPIER.ColliderDesc.capsule(0.6, 0.4)
          .setTranslation(0, 0.9, 0)
          .setFriction(0.0)
          .setRestitution(0.0),
        this.playerBody
      );

      this.footCollider = world.createCollider(
        RAPIER.ColliderDesc.ball(0.01)
          .setTranslation(0, 0.08, 0)
          .setFriction(0.8)
          .setRestitution(0.0),
        this.playerBody
      );

      this._playerExcludeColliders = [this.playerCollider, this.footCollider];

      this.charController = world.createCharacterController(0.05);
      this.charController.setSlideEnabled(true);
      this.charController.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
      this.charController.setMinSlopeSlideAngle((30 * Math.PI) / 180);
      this.charController.enableAutostep(0.45, 0.08, true);
      this.charController.enableSnapToGround(0.2);

      rig.object3D.position.set(start.x, groundY, start.z);
      if (!this.el.is('vr-mode')) {
        this._applyDesktopCameraHeight();
      }

      this.playerVelY = 0;
      this.playerGrounded = true;
      this._playerFwd = new THREE.Vector3();
      this._playerRgt = new THREE.Vector3();
      this._playerMov = new THREE.Vector3();
      this._grabMomentum = new THREE.Vector3();
      this._grabPullVelocity = new THREE.Vector3();
      this._grabPullVelTmp = new THREE.Vector3();
      this.grabPullLocomotionActive = false;
      this._grabMomentumActive = false;
      this.grabReleaseMaxSpeed = 18.0;
      this.grabPullVelocitySmooth = 0.35;
      this.playerMomentumDamping = 0.96;
      this.maxMantleHeight = 2.5;
      this.minMantleHeight = 0.12;

      console.log('[Leg IK World] Player character controller ready');
    },

    _isGrabPullActive: function () {
      if (this.grabPullLocomotionActive) return true;
      const mixamo = document.querySelector('#local-body')?.components['mixamo-body'];
      return !!(mixamo && (mixamo._grabAnchorActiveLeft || mixamo._grabAnchorActiveRight));
    },

    clearLedgeMantle: function () {
      this._ledgeMantleActive = false;
      this._ledgeMantleStartDist = 0;
      this._ledgeMantleProgress = 0;
      this._ledgeMantleDuration = 0.5;
      this._ledgeMantlePlan = null;
      this.mantleCrouchAmount = 0;
      this._syncPlayerColliderCrouch(0);
      if (this.scene.legIkWorld) {
        this.scene.legIkWorld.mantleCrouchAmount = 0;
      }
      if (this._ledgeMantleTarget) {
        this._ledgeMantleTarget.set(0, 0, 0);
      }
    },

    _computeMantleCrouchPeak: function (stepUp, horizDist) {
      const lipHeight = Math.max(0, stepUp);
      const heightNeed = THREE.MathUtils.clamp(lipHeight / 1.15, 0, 1);
      const forwardNeed = THREE.MathUtils.clamp(horizDist / 0.85, 0.35, 1);
      return THREE.MathUtils.clamp(Math.max(heightNeed * 0.92, 0.5) * forwardNeed, 0.45, 1);
    },

    _syncPlayerColliderCrouch: function (crouchT) {
      if (!this.playerBody || !this.RAPIER || !this.world || !this.playerCollider) return;

      const t = THREE.MathUtils.clamp(crouchT, 0, 1);
      if (this._colliderCrouchT >= 0 && Math.abs(this._colliderCrouchT - t) < 0.025) return;
      this._colliderCrouchT = t;

      const halfH = this._capsuleHalfH * (1 - 0.32 * t);
      const radius = this._capsuleRadius * (1 - 0.1 * t);
      const centerY = this._capsuleCenterY - 0.4 * t;

      this.world.removeCollider(this.playerCollider, true);
      this.playerCollider = this.world.createCollider(
        this.RAPIER.ColliderDesc.capsule(halfH, radius)
          .setTranslation(0, centerY, 0)
          .setFriction(0.0)
          .setRestitution(0.0),
        this.playerBody
      );
      this._playerExcludeColliders = [this.playerCollider, this.footCollider];
      if (this.terrain && this.terrain.setExcludeCollider) {
        this.terrain.setExcludeCollider(this.playerCollider);
      }
      if (this.scene.legIkWorld) {
        this.scene.legIkWorld.playerCollider = this.playerCollider;
      }
    },

    _beginLedgeMantle: function (mount, cur) {
      this._ledgeMantleStartPos.set(cur.x, cur.y, cur.z);
      this._ledgeMantleTarget.set(mount.x, mount.y, mount.z);
      this._ledgeMantlePlan = {
        stepUp: mount.stepUp,
        horizX: mount.horizX,
        horizZ: mount.horizZ,
        crouchPeak: mount.crouchPeak
      };
      const pathLen = Math.sqrt(
        mount.stepUp * mount.stepUp + mount.horizX * mount.horizX + mount.horizZ * mount.horizZ
      );
      this._ledgeMantleDuration = THREE.MathUtils.clamp(
        pathLen / (this.ledgeMantleSpeed || 2.8),
        0.3,
        1.2
      );
      this._ledgeMantleProgress = 0;
      this._ledgeMantleActive = true;
      this._ledgeMantleStartDist = pathLen;
      this.mantleCrouchAmount = mount.crouchPeak * 0.95;
      if (this.scene.legIkWorld) {
        this.scene.legIkWorld.mantleCrouchAmount = this.mantleCrouchAmount;
      }
      this._syncPlayerColliderCrouch(this.mantleCrouchAmount);
      if (this._ledgeMantleStartDist < 0.001) {
        this.clearLedgeMantle();
      }
    },

    _mergeLedgeMantleMovement: function (cur, grabDx, grabDy, grabDz, dt) {
      const plan = this._ledgeMantlePlan;
      if (!plan) {
        this.clearLedgeMantle();
        return { x: grabDx, y: grabDy, z: grabDz };
      }

      this._ledgeMantleProgress = Math.min(
        1,
        this._ledgeMantleProgress + dt / Math.max(this._ledgeMantleDuration, 0.001)
      );
      const t = this._ledgeMantleProgress;
      const ease = t * t * (3 - 2 * t);
      const horizEase = Math.min(1, ease * 1.15);
      const vertEase = 1 - (1 - ease) * (1 - ease);
      const start = this._ledgeMantleStartPos;

      const desiredX = start.x + plan.horizX * horizEase;
      const desiredY = start.y + plan.stepUp * vertEase;
      const desiredZ = start.z + plan.horizZ * horizEase;

      // Crouch at mantle start (knees up), hold over the lip, stand up at the end.
      const standStart = 0.58;
      let mantleCrouch;
      if (ease < standStart) {
        const crouchIn = Math.min(1, ease / 0.1);
        mantleCrouch = plan.crouchPeak * (0.88 + 0.12 * crouchIn);
      } else {
        const standT = (ease - standStart) / (1 - standStart);
        const standEase = standT * standT * (3 - 2 * standT);
        mantleCrouch = plan.crouchPeak * (1 - standEase);
      }
      this.mantleCrouchAmount = mantleCrouch;
      if (this.scene.legIkWorld) {
        this.scene.legIkWorld.mantleCrouchAmount = this.mantleCrouchAmount;
      }
      this._syncPlayerColliderCrouch(this.mantleCrouchAmount);

      const grabBlend = Math.max(0, 0.15 * (1 - ease));
      let dx = (desiredX - cur.x) + grabDx * grabBlend;
      let dy = (desiredY - cur.y) + grabDy * grabBlend;
      let dz = (desiredZ - cur.z) + grabDz * grabBlend;

      if (t >= 1 - 1e-4) {
        dx = this._ledgeMantleTarget.x - cur.x;
        dy = this._ledgeMantleTarget.y - cur.y;
        dz = this._ledgeMantleTarget.z - cur.z;
        this.playerGrounded = true;
        this._grabPullRising = false;
        this.clearLedgeMantle();
      }

      return { x: dx, y: dy, z: dz };
    },

    applyGrabPullMovementDelta: function (worldDelta, dt, hints) {
      if (!this.playerBody || !worldDelta) return;
      const safeDt = Math.max(typeof dt === 'number' ? dt : 0.016, 0.001);
      const deltaSq =
        worldDelta.x * worldDelta.x + worldDelta.y * worldDelta.y + worldDelta.z * worldDelta.z;

      if (deltaSq < 1e-10 && !this._ledgeMantleActive) {
        this.grabPullLocomotionActive = true;
        this._grabPullRising = false;
        return;
      }

      const rig = document.getElementById('rig');
      if (!rig) return;

      const cur = this.playerBody.translation();
      let grabDx = 0;
      let grabDy = 0;
      let grabDz = 0;

      if (deltaSq >= 1e-10) {
        grabDx = worldDelta.x;
        grabDy = worldDelta.y;
        grabDz = worldDelta.z;

        const moveCollider = this.footCollider || this.playerCollider;
        if (this.charController && moveCollider) {
          this.charController.computeColliderMovement(moveCollider, { x: grabDx, y: 0, z: grabDz });
          const horiz = this.charController.computedMovement();
          grabDx = horiz.x;
          grabDz = horiz.z;

          if (Math.abs(worldDelta.y) > 1e-8 && this.playerCollider) {
            this.charController.computeColliderMovement(this.playerCollider, { x: 0, y: worldDelta.y, z: 0 });
            const vert = this.charController.computedMovement();
            grabDy = vert.y;
          }

          this.playerGrounded = this.charController.computedGrounded();
        }
      }

      this._grabPullRising = grabDy > 0.004;

      const waistOffset = (hints && hints.waistOffset) || 1.02;
      const waistY = cur.y + waistOffset;
      const grabAnchors = hints && hints.grabAnchors;
      if (!this._ledgeMantleActive) {
        const mount = this._tryGrabPullLedgeMount(cur, waistY, grabDx, grabDy, grabDz, grabAnchors);
        if (mount) {
          this._beginLedgeMantle(mount, cur);
        }
      }

      let dx = grabDx;
      let dy = grabDy;
      let dz = grabDz;
      if (this._ledgeMantleActive) {
        const merged = this._mergeLedgeMantleMovement(cur, grabDx, grabDy, grabDz, safeDt);
        dx = merged.x;
        dy = merged.y;
        dz = merged.z;
        this._grabPullRising = dy > 0.004;
      }

      const next = { x: cur.x + dx, y: cur.y + dy, z: cur.z + dz };
      this.playerBody.setNextKinematicTranslation(next);
      this.playerBody.setTranslation(next, true);
      rig.object3D.position.set(next.x, next.y, next.z);

      const instant = this._grabPullVelTmp;
      instant.set(dx / safeDt, dy / safeDt, dz / safeDt);
      const blend = this.grabPullVelocitySmooth || 0.35;
      this._grabPullVelocity.x += (instant.x - this._grabPullVelocity.x) * blend;
      this._grabPullVelocity.y += (instant.y - this._grabPullVelocity.y) * blend;
      this._grabPullVelocity.z += (instant.z - this._grabPullVelocity.z) * blend;

      this.playerVelY = 0;
      this.grabPullLocomotionActive = true;
    },

    _hasStandableFloor: function (x, y, z) {
      if (!this.world || !this.RAPIER) return false;

      const ray = new this.RAPIER.Ray({ x, y: y + 0.4, z }, { x: 0, y: -1, z: 0 });
      const hit = this.world.castRay(ray, 0.75, true, null, null, this.playerCollider);
      if (!hit) return false;

      const floorY = y + 0.4 - hit.timeOfImpact;
      return Math.abs(floorY - y) < 0.1;
    },

    _tryGrabPullLedgeMount: function (bodyPos, waistY, dx, dy, dz, grabAnchors) {
      if (!this.world || !this.RAPIER) return null;

      const probeDir = this._ledgeProbeDir;
      probeDir.set(dx, 0, dz);
      if (probeDir.lengthSq() < 1e-6 && grabAnchors && grabAnchors.length) {
        probeDir.set(grabAnchors[0].x - bodyPos.x, 0, grabAnchors[0].z - bodyPos.z);
      }
      if (probeDir.lengthSq() < 1e-6) {
        const cam = document.getElementById('camera');
        if (cam) {
          cam.object3D.getWorldDirection(probeDir);
          probeDir.y = 0;
        }
      }
      if (probeDir.lengthSq() < 1e-6) return null;
      probeDir.normalize();

      const minMantle = this.minMantleHeight || 0.12;
      const maxMantle = this.maxMantleHeight || 2.5;
      const minSurfaceY = bodyPos.y + minMantle * 0.35;
      let best = null;
      let bestScore = -1;

      const tryProbe = (px, py, pz) => {
        const ray = new this.RAPIER.Ray({ x: px, y: py, z: pz }, { x: 0, y: -1, z: 0 });
        const hit = this.world.castRay(ray, py + 1.5, true, null, null, this.playerCollider);
        if (!hit) return;

        const surfaceY = py - hit.timeOfImpact;
        if (surfaceY < minSurfaceY) return;

        const standY = surfaceY + 0.02;
        const stepUp = standY - bodyPos.y;
        if (stepUp < minMantle || stepUp > maxMantle) return;
        if (waistY < surfaceY - 0.08) return;

        const standX = px;
        const standZ = pz;
        if (!this._hasStandableFloor(standX, standY, standZ)) return;

        const horizX = standX - bodyPos.x;
        const horizZ = standZ - bodyPos.z;
        const horizDist = Math.sqrt(horizX * horizX + horizZ * horizZ);
        const crouchPeak = this._computeMantleCrouchPeak(stepUp, horizDist);
        const score = stepUp + (waistY - surfaceY) - horizDist * 0.15;

        if (score > bestScore) {
          bestScore = score;
          best = {
            x: standX,
            y: standY,
            z: standZ,
            stepUp: stepUp,
            horizX: horizX,
            horizZ: horizZ,
            crouchPeak: crouchPeak
          };
        }
      };

      if (grabAnchors && grabAnchors.length) {
        for (let i = 0; i < grabAnchors.length; i++) {
          const anchor = grabAnchors[i];
          tryProbe(anchor.x + probeDir.x * 0.2, anchor.y + 0.3, anchor.z + probeDir.z * 0.2);
          tryProbe(anchor.x + probeDir.x * 0.35, anchor.y + 0.45, anchor.z + probeDir.z * 0.35);
        }
      }

      for (let dist = 0.2; dist <= 0.85; dist += 0.12) {
        tryProbe(
          bodyPos.x + probeDir.x * dist,
          waistY + 0.25,
          bodyPos.z + probeDir.z * dist
        );
      }

      return best;
    },

    transferGrabPullMomentum: function () {
      this._grabMomentum.copy(this._grabPullVelocity);
      this._grabMomentumActive = true;
      this.playerVelY = this._grabPullVelocity.y;

      const speed = Math.sqrt(
        this._grabMomentum.x * this._grabMomentum.x +
        this._grabPullVelocity.y * this._grabPullVelocity.y +
        this._grabMomentum.z * this._grabMomentum.z
      );
      const max = this.grabReleaseMaxSpeed || 18.0;
      if (speed > max) {
        const scale = max / speed;
        this._grabMomentum.multiplyScalar(scale);
        this.playerVelY *= scale;
      }

      if (
        Math.abs(this.playerVelY) > 0.4 ||
        this._grabMomentum.x * this._grabMomentum.x + this._grabMomentum.z * this._grabMomentum.z > 0.16
      ) {
        this.playerGrounded = false;
      }

      this._grabPullVelocity.set(0, 0, 0);
      this.grabPullLocomotionActive = false;
      this.clearLedgeMantle();
    },

    _updatePlayerPhysics: function (deltaMs) {
      if (!this.playerBody || !this.charController || !this.world) return;

      const rig = document.getElementById('rig');
      const camera = document.getElementById('camera');
      if (!rig || !camera) return;

      const dotFx = this.scene._bodyDotEffect;
      if (dotFx && dotFx.frozen && dotFx.frozenPos) {
        const fp = dotFx.frozenPos;
        this.playerBody.setNextKinematicTranslation({ x: fp.x, y: fp.y, z: fp.z });
        rig.object3D.position.set(fp.x, fp.y, fp.z);
        this._playerMov.set(0, 0, 0);
        this._grabMomentum.set(0, 0, 0);
        this._grabMomentumActive = false;
        this.playerVelY = 0;
        this.grabPullLocomotionActive = false;
        if (this.scene.legIkWorld) {
          this.scene.legIkWorld.playerSpeed = 0;
          if (this._playerMoveDir) this._playerMoveDir.set(0, 0, 0);
        }
        return;
      }

      const dt = Math.min(deltaMs / 1000, 0.1);
      const isVR = this.el.is('vr-mode');
      const keys = window._bodyRiggedKeys || {};
      const sprint = keys.ShiftLeft || keys.ShiftRight;
      const moveSpeed = 2.5 * (sprint ? 1.8 : 1.0);

      const camQuat = camera.object3D.quaternion;
      this._playerFwd.set(0, 0, -1).applyQuaternion(camQuat);
      this._playerFwd.y = 0;
      this._playerFwd.normalize();
      this._playerRgt.set(1, 0, 0).applyQuaternion(camQuat);
      this._playerRgt.y = 0;
      this._playerRgt.normalize();

      this._playerMov.set(0, 0, 0);

      const grabPullActive = this.grabPullLocomotionActive;

      if (isVR && !grabPullActive) {
        const vrLoco = rig.components['vr-locomotion'];
        const stick = vrLoco?.thumbstickMove?.left;
        if (stick) {
          if (stick.y) this._playerMov.addScaledVector(this._playerFwd, -stick.y);
          if (stick.x) this._playerMov.addScaledVector(this._playerRgt, stick.x);
        }
      } else if (!isVR && !grabPullActive) {
        if (keys.KeyW || keys.ArrowUp) this._playerMov.add(this._playerFwd);
        if (keys.KeyS || keys.ArrowDown) this._playerMov.sub(this._playerFwd);
        if (keys.KeyA || keys.ArrowLeft) this._playerMov.sub(this._playerRgt);
        if (keys.KeyD || keys.ArrowRight) this._playerMov.add(this._playerRgt);
      }

      const isMoving = this._playerMov.lengthSq() > 0.001;
      if (isMoving) {
        this._playerMov.normalize().multiplyScalar(moveSpeed);
        this._grabMomentumActive = false;
        this._grabMomentum.set(0, 0, 0);
      }

      let moveX = this._playerMov.x;
      let moveZ = this._playerMov.z;
      if (this._grabMomentumActive && !isMoving) {
        moveX = this._grabMomentum.x;
        moveZ = this._grabMomentum.z;
      }

      const GRAVITY = -25;
      if (!grabPullActive) {
        this.playerVelY += GRAVITY * dt;
      }
      if (this.playerGrounded && this.playerVelY < 0) {
        this.playerVelY = -2;
      }
      if (grabPullActive) {
        this.playerVelY = 0;
        // mixamo-body applies grab-pull after this tick.
        return;
      }

      const cur = this.playerBody.translation();
      let stepUpY = 0;

      if (this.playerGrounded && isMoving) {
        const norm = this._playerMov.clone().normalize();
        const probeX = cur.x + norm.x * 0.2;
        const probeZ = cur.z + norm.z * 0.2;
        const stepRay = new this.RAPIER.Ray(
          { x: probeX, y: cur.y + 0.5, z: probeZ },
          { x: 0, y: -1, z: 0 }
        );
        const stepHit = this.world.castRay(
          stepRay,
          1.0,
          true,
          null,
          null,
          this.playerCollider
        );
        if (stepHit) {
          const hitY = cur.y + 0.5 - stepHit.timeOfImpact;
          const stepHeight = hitY - cur.y;
          if (stepHeight > 0.02 && stepHeight < 0.55) {
            stepUpY = stepHeight;
          }
        }
      }

      const desired = {
        x: moveX * dt,
        y: stepUpY > 0 ? stepUpY : this.playerVelY * dt,
        z: moveZ * dt
      };

      this.charController.computeColliderMovement(this.footCollider, desired);
      const corrected = this.charController.computedMovement();
      this.playerGrounded = this.charController.computedGrounded();

      this.playerBody.setNextKinematicTranslation({
        x: cur.x + corrected.x,
        y: cur.y + corrected.y,
        z: cur.z + corrected.z
      });

      const pos = this.playerBody.translation();
      rig.object3D.position.set(pos.x, pos.y, pos.z);

      const actualSpeed = Math.sqrt(
        corrected.x * corrected.x + corrected.z * corrected.z
      ) / Math.max(dt, 0.001);

      if (this._grabMomentumActive && !isMoving) {
        const damp = Math.pow(this.playerMomentumDamping || 0.96, dt * 60);
        this._grabMomentum.x *= damp;
        this._grabMomentum.z *= damp;
        if (this._grabMomentum.lengthSq() < 0.05) {
          this._grabMomentum.set(0, 0, 0);
          this._grabMomentumActive = false;
        }
      }

      if (isVR && this._playerRootPos) {
        const headWorld = new THREE.Vector3();
        camera.object3D.getWorldPosition(headWorld);
        const groundY = this.terrain.getHeightAtWorld(headWorld.x, headWorld.z);
        this._playerRootPos.set(headWorld.x, groundY, headWorld.z);
      } else if (this._playerRootPos) {
        this._playerRootPos.set(pos.x, pos.y, pos.z);
      }

      if (this.scene.legIkWorld) {
        this.scene.legIkWorld.isPlayerGrounded = this.playerGrounded;
        this.scene.legIkWorld.playerSpeed = isMoving ? actualSpeed : 0;
        this.scene.legIkWorld.playerRootPos = this._playerRootPos;
        if (!this._playerMoveDir) this._playerMoveDir = new THREE.Vector3();
        if (isMoving) {
          this._playerMoveDir.set(this._playerMov.x, 0, this._playerMov.z).normalize();
        } else {
          this._playerMoveDir.set(0, 0, 0);
        }
        this.scene.legIkWorld.playerMoveDir = this._playerMoveDir;
      }
    },

    _initHeadCollision: function () {
      this._headCorrection = new THREE.Vector3();
    },

    _checkHeadCollision: function (forceWhenGrabbing) {
      if (!this.el.is('vr-mode')) return;
      if (this._grabPullRising || this._ledgeMantleActive) return;
      if (!forceWhenGrabbing && this._isGrabPullActive()) return;
      if (!this.world || !this.playerCollider || !this.playerBody) return;

      const rig = document.getElementById('rig');
      const camera = document.getElementById('camera');
      if (!rig || !camera) return;

      const headPos = new THREE.Vector3();
      camera.object3D.getWorldPosition(headPos);

      const result = resolveSphereAgainstColliders(
        this.world,
        this._playerExcludeColliders || this.playerCollider,
        headPos,
        0.2,
        { horizontalOnly: true }
      );

      if (!result.hit) return;

      this._headCorrection.subVectors(result.position, headPos);
      this._headCorrection.y = 0;
      this._applyHeadCorrection(rig, this._headCorrection);
    },

    _applyHeadCorrection: function (rig, correction) {
      if (correction.lengthSq() < 0.000001) return;
      rig.object3D.position.add(correction);
      const p = rig.object3D.position;
      this.playerBody.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
    },

    clampHandWorldPos: function (src, dest) {
      if (!this.world) {
        dest.copy(src);
        return false;
      }

      const result = resolveSphereAgainstColliders(
        this.world,
        this._playerExcludeColliders || this.playerCollider,
        src,
        this.handCollisionRadius || 0.05
      );
      dest.copy(result.position);
      return result.hit;
    },

    // Slide on sticky collider; block controller motion along contact→target axis (into surface).
    clampHandPalmAlongTracking: function (lastValid, desired, dest, hand, trackingPos) {
      const debugKey = hand === 'left' ? '_handPalmDebugLeft' : '_handPalmDebugRight';
      const dominantKey = hand === 'left' ? '_handDominantColliderLeft' : '_handDominantColliderRight';
      const lastDesiredKey = hand === 'left' ? '_handLastDesiredLeft' : '_handLastDesiredRight';
      const lockAxisKey = hand === 'left' ? '_handLockAxisLeft' : '_handLockAxisRight';
      const track = trackingPos || desired;
      const emptyDebug = {
        hit: false,
        sticky: null,
        contactPoint: null,
        controller: desired.clone(),
        contactDistance: 0
      };

      const clearHandSlideState = () => {
        this[dominantKey] = null;
        this[lastDesiredKey] = null;
        this[lockAxisKey] = null;
      };

      if (!this.world) {
        dest.copy(desired);
        this[debugKey] = emptyDebug;
        return false;
      }

      const exclude = this._playerExcludeColliders || this.playerCollider;
      const radius = this.handCollisionRadius || 0.05;
      const resetDist = 0.5;

      if (lastValid && lastValid.distanceTo(desired) > resetDist) {
        clearHandSlideState();
        lastValid = null;
      }

      if (!sphereOverlaps(this.world, this.RAPIER, exclude, desired, radius)) {
        dest.copy(desired);
        clearHandSlideState();
        this[debugKey] = emptyDebug;
        this[lastDesiredKey] = track.clone();
        return false;
      }

      const dominantHit = findDominantCollider(this.world, exclude, desired, radius);
      let collider = this[dominantKey];
      const stickyPen = collider ? colliderPenetration(collider, desired, radius) : 0;

      if (!collider && dominantHit) {
        collider = dominantHit.collider;
        this[dominantKey] = collider;
      } else if (dominantHit && collider && collider !== dominantHit.collider) {
        if (dominantHit.penetration > stickyPen + 0.02) {
          collider = dominantHit.collider;
          this[dominantKey] = collider;
          lastValid = null;
          this[lastDesiredKey] = null;
          this[lockAxisKey] = null;
        }
      }

      if (!collider) {
        dest.copy(desired);
        this[debugKey] = emptyDebug;
        return false;
      }

      const lastTrack = this[lastDesiredKey];
      let lockAxis = this[lockAxisKey];
      const penetration = colliderPenetration(collider, desired, radius);

      if (!lockAxis || !lastValid) {
        lockAxis = null;
      } else if (penetration > 0.01) {
        lockAxis = computeSeparationAxis(collider, lastValid, track, radius, lockAxis);
        this[lockAxisKey] = lockAxis.clone();
      }

      const resolved = slideHandSphereOnCollider(
        collider,
        lastValid,
        lastTrack,
        desired,
        radius,
        lockAxis,
        track
      );

      if (!this[lockAxisKey] || !lastValid) {
        this[lockAxisKey] = computeSeparationAxis(collider, resolved, track, radius, lockAxis);
      }

      const contactPoint = getSphereSurfaceContactPoint(collider, resolved, radius, new THREE.Vector3());

      dest.copy(resolved);
      this[lastDesiredKey] = track.clone();
      this[debugKey] = {
        hit: true,
        sticky: resolved.clone(),
        contactPoint: contactPoint,
        controller: track.clone(),
        contactDistance: contactPoint.distanceTo(track)
      };
      return true;
    },

    clampHandPalmConstrained: function (lastValid, desired, dest, hand) {
      return this.clampHandPalmAlongTracking(lastValid, desired, dest, hand);
    },

    tick: function (time, deltaTime) {
      if (this.el.is('vr-mode')) {
        this._updateVRCrouch();
        if (!this._panelTick) this._panelTick = 0;
        if (++this._panelTick % 20 === 0) {
          this._updateVRHeightPanel();
        }
      }
      this._updatePlayerPhysics(deltaTime);
      this._checkHeadCollision();
      if (this.world) {
        this.world.step();
      }
    }
  });

  AFRAME.registerComponent('rapier-locomotion', {
    schema: {},
    init: function () {}
  });
})();
