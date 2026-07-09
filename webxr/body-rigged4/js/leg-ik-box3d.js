/**
 * Leg IK for A-Frame Mixamo bodies — Box3D physics (body-rigged4)
 */
(function () {
  'use strict';

  /** Bump when Problem_1.glb or Problem_2.glb changes â€” avoids stale browser cache. */
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

  class Box3DTerrainQuery {
    constructor({ queries, groundY = 0, rayOriginY = 30, excludeShapeIds = null } = {}) {
      this.queries = queries;
      this.groundY = groundY;
      this.rayOriginY = rayOriginY;
      this.excludeShapeIds = excludeShapeIds;
      this.worldSize = 20;
      this.cellSize = 1;
    }

    setExcludeCollider(shapeIds) {
      this.excludeShapeIds = shapeIds;
    }

    getHeightAtWorld(x, z) {
      if (!this.queries) return this.groundY;
      const hit = this.queries.castRayDown(x, this.rayOriginY, z, this.rayOriginY + 5, this.excludeShapeIds);
      return hit ? hit.point.y : this.groundY;
    }
  }

  class LegIK {
    constructor(model, terrainBuilder, options = {}, queries = null, playerShapeIds = null) {
      this.model = model;
      this.terrain = terrainBuilder;
      this.queries = queries;
      this.playerShapeIds = playerShapeIds;

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
      this.lateralFootPlantMode = false;

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
      this._airborneRelaxBlend = 0;
      this._airborneRelaxPerFoot = {
        left: 0,
        right: 0
      };
      this._airborneFootPitch = options.airborneFootPitch ?? 0.52;
      this._airborneToePitch = options.airborneToePitch ?? 0.38;
      this._airborneKneeBend = options.airborneKneeBend ?? 0.14;
      this._airborneClearanceFull = options.airborneClearanceFull ?? 0.07;
      this._toeBones = { left: null, right: null };
      this._resolveToeBones();
    }

    _resolveToeBones() {
      for (const side of ['left', 'right']) {
        const foot = this.bones[side === 'left' ? 'leftFoot' : 'rightFoot'];
        if (!foot) continue;
        for (let i = 0; i < foot.children.length; i++) {
          const child = foot.children[i];
          if (child.isBone && /toe/i.test(child.name)) {
            this._toeBones[side] = child;
            break;
          }
        }
      }
    }

    _makeFoot() {
      return {
        positionOffset: 0,
        rotationOffset: new THREE.Quaternion(),
        raycastHit: false,
        raycastHitPoint: new THREE.Vector3(),
        raycastHitNormal: new THREE.Vector3(0, 1, 0),
        raycastOrigin: new THREE.Vector3(),
        _surfaceNormal: null
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
      if (rootWorldPosition) {
        this._rootPosition.copy(rootWorldPosition);
      } else {
        this.model.parent?.getWorldPosition(this._rootPosition) ??
          this.model.getWorldPosition(this._rootPosition);
      }

      this.model.updateWorldMatrix(true, true);

      const relaxAlpha = Math.min(1, dt * 14);
      const allowAirborneRelax = this.jumped || !this.isGrounded;
      for (const side of ['left', 'right']) {
        const relaxTarget = allowAirborneRelax ? this._measureFootClearanceWeight(side) : 0;
        this._airborneRelaxPerFoot[side] = THREE.MathUtils.lerp(
          this._airborneRelaxPerFoot[side],
          relaxTarget,
          relaxAlpha
        );
        if (this._airborneRelaxPerFoot[side] > 0.001) {
          this._applyAirborneFootRelaxSide(side, this._airborneRelaxPerFoot[side]);
        }
      }
      this._airborneRelaxBlend = Math.max(
        this._airborneRelaxPerFoot.left,
        this._airborneRelaxPerFoot.right
      );

      const skipGroundIK = this.jumped || !this.isGrounded;
      if (skipGroundIK) return;

      if (!this.isActive) return;

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

      this._snapshotAnimatedPoses();
      this._getRaycastData();
      const lowestHitY = this._offsetTargets(dt);
      this._offsetBodyPosition(dt, lowestHitY);
    }

    _measureFootClearanceWeight(side) {
      const footBone = this.bones[side === 'left' ? 'leftFoot' : 'rightFoot'];
      if (!footBone) return 0;

      const footWorld = new THREE.Vector3();
      footBone.getWorldPosition(footWorld);
      const soleY = footWorld.y - this.footSkinOffset;

      let groundY = this.terrain.getHeightAtWorld(footWorld.x, footWorld.z);
      if (this.queries) {
        const hit = this.queries.castRayDown(
          footWorld.x,
          footWorld.y + 0.35,
          footWorld.z,
          1.4,
          this.playerShapeIds
        );
        if (hit) groundY = Math.max(groundY, hit.point.y);
      }

      const clearance = soleY - groundY;
      const minClear = 0.012;
      if (clearance <= minClear) return 0;
      return THREE.MathUtils.clamp(clearance / this._airborneClearanceFull, 0, 1);
    }

    _applyAirborneFootRelaxSide(side, weight) {
      const footPitch = this._airborneFootPitch * weight;
      const toePitch = this._airborneToePitch * weight;
      const kneeBend = this._airborneKneeBend * weight;
      const plantarFlexSign = -1;

      const footBone = this.bones[side === 'left' ? 'leftFoot' : 'rightFoot'];
      const kneeBone = this.bones[side === 'left' ? 'leftKnee' : 'rightKnee'];
      if (!footBone) return;

      const footAxis = new THREE.Vector3(1, 0, 0);
      const footDelta = new THREE.Quaternion().setFromAxisAngle(footAxis, footPitch * plantarFlexSign);
      footBone.quaternion.multiply(footDelta);

      const toeBone = this._toeBones[side];
      if (toeBone) {
        const toeDelta = new THREE.Quaternion().setFromAxisAngle(footAxis, toePitch * plantarFlexSign);
        toeBone.quaternion.multiply(toeDelta);
      }

      if (kneeBone && kneeBend > 0.001) {
        const kneeDelta = new THREE.Quaternion().setFromAxisAngle(footAxis, kneeBend * plantarFlexSign);
        kneeBone.quaternion.multiply(kneeDelta);
      }
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
      foot._surfaceNormal = null;

      if (this.queries) {
        const hit = this.queries.castRayDown(originX, originY, originZ, this.raycastLength, this.playerShapeIds);
        if (hit) {
          const hitY = hit.point.y;
          const isBasePlane = Math.abs(hitY) < 0.05;
          if (hitY < originY && !isBasePlane && hitY > groundY + 0.015) {
            groundY = hitY;
            foot._surfaceNormal = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
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
      foot.raycastHitNormal.copy(foot._surfaceNormal ?? this._sampleNormal(originX, originZ));
      foot._surfaceNormal = null;
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

      const IK_BLEND_MAX_OFFSET = this.crouchFootPlantMode
        ? 0.35
        : (this.lateralFootPlantMode ? 0.18 : 0.05);
      const IK_BLEND_MIN_OFFSET = 0.005;
      const absOffset = Math.abs(foot.positionOffset);
      const perFootBlend = foot.raycastHit
        ? THREE.MathUtils.clamp(
            (absOffset - IK_BLEND_MIN_OFFSET) / (IK_BLEND_MAX_OFFSET - IK_BLEND_MIN_OFFSET),
            0,
            1
          )
        : 0;

      let ikBlend = perFootBlend * this._globalIKBlend;
      if (this.crouchFootPlantMode && foot.raycastHit) {
        ikBlend = Math.max(ikBlend, 0.94 * this._globalIKBlend);
      }

      let targetRotOffset = new THREE.Quaternion();
      const applyFootTilt = foot.raycastHit && this.feetRotationOffsetWeight > 0 && !this.crouchFootPlantMode;
      if (applyFootTilt) {
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

      const ikTargetQuat = applyFootTilt
        ? foot.rotationOffset.clone().multiply(animatedFootQuat)
        : animatedFootQuat.clone();

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
      const err = targetY - fp.y;
      const threshold = this.crouchFootPlantMode ? 0.0003 : 0.001;

      if (Math.abs(err) < threshold) return;

      if (!footBone.parent) {
        footBone.position.y += err;
        return;
      }

      const parentQuat = new THREE.Quaternion();
      footBone.parent.getWorldQuaternion(parentQuat);
      const localUp = new THREE.Vector3(0, 1, 0)
        .applyQuaternion(parentQuat.clone().invert())
        .normalize();

      footBone.position.addScaledVector(localUp, err);
    }

    _offsetBodyPosition(dt, lowestHitY) {
      const hipBone = this.bones.hips;
      if (!hipBone || this.bodyPositionOffsetWeight <= 0 || this.crouchFootPlantMode) return;

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

  const STORAGE_STANDING_EYE = 'bodyRigged3.standingEyeHeightM';
  const STORAGE_BODY_OFFSET = 'bodyRigged3.playerHeightAdjustM';
  const STORAGE_CAMERA_FLOOR = 'bodyRigged3.cameraFloorOffsetM';
  const STORAGE_BODY_FORWARD = 'bodyRigged3.bodyForwardOffsetM';
  const STORAGE_BODY_LATERAL = 'bodyRigged3.bodyLateralOffsetM';
  const STORAGE_MODEL_SCALE = 'bodyRigged3.modelVerticalScale';
  // Desktop preview: camera local Y only â€” rig stays on the floor (body feet anchor to rig/offset origin).
  const DESKTOP_EYE_HEIGHT = 1.6;
  const BOX3D_CDN = 'https://cdn.jsdelivr.net/npm/box3d.js@0.0.2/dist/box3d.inline.mjs';

  AFRAME.registerComponent('leg-ik-world', {
    init: function () {
      // On <a-scene>, this.el IS the scene â€” sceneEl is only set on child entities.
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
          b3: null,
          queries: null,
          playerShapeIds: null,
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
          maxCrouchAmount: 0.62,
          maxCrouchDropM: 0.38,
          mantleCrouchAmount: 0,
          ragdollActive: false
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
      this._grabPullVelocity = new THREE.Vector3();
      this._grabPullVelTmp = new THREE.Vector3();
      this.grabPullVelocitySmooth = 0.35;
      this.grabReleaseMaxSpeed = 18.0;
      this.minMantleHeight = 0.12;
      this.maxMantleHeight = 2.5;
      this.mantleCrouchAmount = 0;
      this._colliderCrouchT = -1;
      this._capsuleHalfH = 0.6;
      this._capsuleRadius = 0.18;
      this._capsuleCenterY = 0.9;
      this.ledgeMantleSpeed = 2.8;
      this.ledgeMantleArriveDist = 0.05;
      // Grab-pull auto mantle (ledge hop) — disabled; was causing bounce loops on static grabs.
      this.enableGrabPullLedgeMantle = false;
      this._playerRootPos = new THREE.Vector3();
      this._playerFwd = new THREE.Vector3();
      this._playerRgt = new THREE.Vector3();
      this._playerMov = new THREE.Vector3();
      this._playerMoveDir = new THREE.Vector3();
      this._grabMomentum = new THREE.Vector3();
      this._grabMomentumActive = false;
      this.playerVelY = 0;
      this.playerGrounded = true;

      this._onEnterVR = this._onEnterVR.bind(this);
      this._onExitVR = this._onExitVR.bind(this);
      this.el.addEventListener('enter-vr', this._onEnterVR);
      this.el.addEventListener('exit-vr', this._onExitVR);

      this._initBox3D();
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
      if (scaleEl) scaleEl.setAttribute('value', scale.toFixed(2) + 'Ã—');
      if (standEl) standEl.setAttribute('value', stand.toFixed(2) + ' m');
      if (this.el.is('vr-mode')) {
        const tracked = this._getTrackedEyeLocalY();
        if (camEl) camEl.setAttribute('value', tracked.toFixed(2) + ' m');
      } else if (camEl) {
        camEl.setAttribute('value', 'â€”');
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
        console.warn('[Leg IK World] Calibrate failed â€” tracked eye Y out of range:', trackedY);
        return false;
      }

      const w = this.scene.legIkWorld;
      w.configuredStandingEyeY = trackedY;
      w.standingEyeLocalY = trackedY;
      w.crouchAmount = 0;
      w.playerHeightAdjustM = 0;
      this._saveConfiguredHeight(trackedY);
      this._saveBodyOffset(0);

      const modelEye = w.modelEyeHeightM || 1.573;
      const scale = THREE.MathUtils.clamp(trackedY / modelEye, 0.85, 1.35);
      w.modelVerticalScale = scale;
      this._saveModelVerticalScale(scale);

      this.scene.emit('vr-height-calibrated', {
        standingEyeLocalY: trackedY,
        modelVerticalScale: scale,
        playerHeightAdjustM: 0,
        source: source || 'manual-calibrate',
        finalizeFeet: true
      });
      this.scene.emit('vr-model-scaled', { modelVerticalScale: scale });
      this.scene.emit('vr-height-adjusted', { playerHeightAdjustM: 0 });
      this._recenterPlayer(source || 'manual-calibrate');
      this._updateVRHeightPanel();
      const modelStand = w.modelStandingHeightM || 1.66;
      console.log(
        '[Leg IK World] Calibrated — eye:', trackedY.toFixed(2), 'm',
        'scale:', scale.toFixed(2) + '×',
        'avatar ~', (modelStand * scale).toFixed(2), 'm'
      );
      return true;
    },

    setBodyHeightAdjust: function (meters) {
      const w = this.scene.legIkWorld;
      if (!w) return false;
      const next = THREE.MathUtils.clamp(meters, -0.6, 0.6);
      if (Math.abs(next - (w.playerHeightAdjustM || 0)) < 1e-5) return true;
      w.playerHeightAdjustM = next;
      this._saveBodyOffset(next);
      this.scene.emit('vr-height-adjusted', { playerHeightAdjustM: next });
      this._updateVRHeightPanel();
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

      const w = this.scene.legIkWorld;
      const hasSaved = w?.configuredStandingEyeY != null;

      const finishEnter = () => {
        if (!this.el.is('vr-mode')) return;
        if (!hasSaved) {
          this.calibrateStandingHeight('auto-enter-vr');
        } else {
          this._applyStandingEyeHeight('enter-vr');
          this._recenterPlayer('enter-vr');
        }
      };

      setTimeout(finishEnter, hasSaved ? 80 : 350);
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

      // Rig Y = floor only. Camera local Y is eye height â€” never subtract it from rig Y.
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
      if (this.physics) {
        this.physics.setPlayerTranslation(rigPos.x, groundY, rigPos.z);
      }
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
      // Disabled â€” local-floor room-scale and crouch change camera local Y; recenter caused fly-up.
    },

    _syncPlayerColliderCrouch: function (crouchT) {
      if (!this.physics?.setPlayerCapsuleForCrouch) return;
      this.physics.setPlayerCapsuleForCrouch(THREE.MathUtils.clamp(crouchT, 0, 1), {
        halfH: this._capsuleHalfH,
        radius: this._capsuleRadius,
        centerY: this._capsuleCenterY
      });
    },

    _getPlayerColliderCrouchT: function () {
      const w = this.scene.legIkWorld;
      if (!w) return 0;
      const maxCrouch = w.maxCrouchAmount ?? 0.62;
      const vrT = maxCrouch > 1e-4 ? (w.crouchAmount || 0) / maxCrouch : 0;
      const mantleT = w.mantleCrouchAmount || 0;
      return Math.max(vrT, mantleT);
    },

    _updateVRCrouch: function () {
      if (!this.el.is('vr-mode') || !this.scene.legIkWorld) {
        if (this.scene.legIkWorld) this.scene.legIkWorld.crouchAmount = 0;
        this._syncPlayerColliderCrouch(0);
        return;
      }

      const camera = document.getElementById('camera');
      if (!camera) return;

      const standing = this.scene.legIkWorld.standingEyeLocalY || 1.6;
      const camY = this._getTrackedEyeLocalY();
      const drop = standing - camY;
      const CROUCH_START = 0.08;
      const CROUCH_FULL = 0.55;
      const MAX_CROUCH = this.scene.legIkWorld.maxCrouchAmount ?? 0.62;
      const MAX_DROP_M = this.scene.legIkWorld.maxCrouchDropM ?? 0.38;
      const effectiveDrop = Math.min(Math.max(0, drop), MAX_DROP_M);
      let target = (effectiveDrop - CROUCH_START) / (CROUCH_FULL - CROUCH_START);
      target = THREE.MathUtils.clamp(target, 0, MAX_CROUCH);

      const prev = this.scene.legIkWorld.crouchAmount || 0;
      this.scene.legIkWorld.crouchAmount = THREE.MathUtils.clamp(
        THREE.MathUtils.lerp(prev, target, 0.22),
        0,
        MAX_CROUCH
      );
      this._syncPlayerColliderCrouch(this._getPlayerColliderCrouchT());
    },

    _syncRigToPhysics: function () {
      const rig = document.getElementById('rig');
      if (!rig || !this.physics) return;
      const pos = this.physics.getPlayerTranslation();
      rig.object3D.position.set(pos.x, pos.y, pos.z);
    },

    _initBox3D: async function () {
      try {
        const physics = new window.Box3DPhysicsWorld();
        await physics.init();
        this.physics = physics;
        this.b3 = physics.b3;
        this.world = physics.world;
        this.queries = physics.queries;

        this.terrain = new Box3DTerrainQuery({ queries: this.queries, groundY: 0 });

        await this._loadReferenceObstacles();

        const rig = document.getElementById('rig');
        const start = rig ? rig.object3D.position : { x: 0, y: 0, z: 0 };
        const groundY = this.terrain.getHeightAtWorld(start.x, start.z);
        this.physics.initPlayerAt(start.x, groundY, start.z);
        this.playerBody = this.physics;
        if (rig) rig.object3D.position.set(start.x, groundY, start.z);

        this.handCollisionRadius = 0.026;
        this.fingerCollisionRadius = 0.011;
        this.knuckleCollisionRadius = 0.016;
        this._handPalmDebugLeft = null;
        this._handPalmDebugRight = null;
        this.playerVelY = 0;
        this.playerGrounded = true;
        this.grabPullLocomotionActive = false;
        this.ragdollActive = false;
        this.ready = true;

        Object.assign(this.scene.legIkWorld, {
          ready: true,
          terrain: this.terrain,
          world: this.world,
          b3: this.b3,
          queries: this.queries,
          physics: this.physics,
          playerShapeIds: this.physics.playerShapeIds,
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
          maxCrouchAmount: 0.62,
          maxCrouchDropM: 0.38,
          mantleCrouchAmount: 0
        });
        this._applyCameraFloorOffset();
        this._updateVRHeightPanel();

        const status = document.querySelector('#status');
        if (status && status.textContent === 'Loading...') {
          status.textContent = 'Box3D physics ready';
          status.style.color = '#4CAF50';
        }
        console.log('[Leg IK World] Box3D physics initialized');
      } catch (err) {
        console.warn('[Leg IK World] Box3D unavailable:', err);
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

    _placeObstacleOnGround: function (model, x, z) {
      const threeScene = this.el.object3D;
      model.position.set(x, 0, z);
      threeScene.add(model);
      model.updateWorldMatrix(true, true);
      const box = new THREE.Box3().setFromObject(model);
      model.position.y -= box.min.y;
      model.updateWorldMatrix(true, true);
      return new THREE.Box3().setFromObject(model);
    },

    /** 15 cm diameter pipe at stairs corner (toward red wall), 2× stairs height. */
    _addStairsCornerPipe: function (stairsBox) {
      if (!stairsBox || !this.physics?.b3) return;

      const stairsHeight = stairsBox.max.y - stairsBox.min.y;
      const pipeRadius = 0.075;
      const pipeHeight = Math.max(0.5, stairsHeight * 2);
      const halfH = pipeHeight * 0.5;
      // Corner nearest the red test wall (x=2, z=-1): low X, high Z on the stairs footprint.
      const pipeX = stairsBox.min.x + pipeRadius;
      const pipeZ = stairsBox.max.z - pipeRadius;
      const pipeY = halfH;

      const pipeGroup = new THREE.Group();
      pipeGroup.name = 'stairs-corner-pipe';
      const geom = new THREE.CylinderGeometry(pipeRadius, pipeRadius, pipeHeight, 16);
      const mat = new THREE.MeshStandardMaterial({
        color: 0x607d8b,
        roughness: 0.55,
        metalness: 0.35
      });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      pipeGroup.add(mesh);
      pipeGroup.position.set(pipeX, pipeY, pipeZ);
      this.el.object3D.add(pipeGroup);

      const b3 = this.physics.b3;
      const sd = window.Box3DCollision.makeShapeDef(b3, {
        category: this.physics.CATEGORY.ENVIRONMENT,
        mask: this.physics.CATEGORY.PLAYER | this.physics.CATEGORY.HAND
          | this.physics.CATEGORY.RAGDOLL | this.physics.CATEGORY.ENVIRONMENT,
        friction: 0.85,
        restitution: 0.02
      });
      const bodyDef = b3.b3DefaultBodyDef();
      bodyDef.position = { x: pipeX, y: pipeY, z: pipeZ };
      const body = b3.b3CreateBody(this.physics.world, bodyDef);
      b3.b3CreateCapsuleShape(body, sd, {
        center1: { x: 0, y: -halfH, z: 0 },
        center2: { x: 0, y: halfH, z: 0 },
        radius: pipeRadius
      });
      console.log('[Leg IK World] Stairs corner pipe:', pipeHeight.toFixed(2), 'm tall at', pipeX.toFixed(2), pipeZ.toFixed(2));
    },

    _loadReferenceObstacles: async function () {
      await this._waitForGltfLoader();
      if (!this.physics) return;
      const loader = new window.BodyRiggedLoaders.GLTFLoader();
      const obstacles = [
        { url: obstacleGlbUrl('Problem_1.glb'), x: 4, z: -5, name: 'Ramp' },
        { url: obstacleGlbUrl('Problem_2.glb'), x: 7, z: -5, name: 'Stairs', addCornerPipe: true }
      ];
      for (const cfg of obstacles) {
        await new Promise((resolve) => {
          loader.load(cfg.url, (gltf) => {
            const model = gltf.scene;
            model.traverse((child) => {
              if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
                if (child.material) child.material = child.material.clone();
              }
            });
            const worldBox = this._placeObstacleOnGround(model, cfg.x, cfg.z);
            this.physics.addTrimeshFromObject(model);
            if (cfg.addCornerPipe) {
              this._addStairsCornerPipe(worldBox);
            }
            console.log('[Leg IK World] Loaded obstacle:', cfg.name);
            resolve();
          }, undefined, () => resolve());
        });
      }
    },

    toggleRagdoll: function () {
      if (!this.physics || !this.b3) return;
      const localComp = document.querySelector('#local-body')?.components['mixamo-body'];
      const mirrorComp = document.querySelector('#mirror-body')?.components['mixamo-body'];
      const p = this.physics.getPlayerTranslation();

      if (this.physics.ragdollActive) {
        const rig = document.getElementById('rig');
        this.physics.destroyRagdoll();
        if (rig && this.physics) {
          const rp = rig.object3D.position;
          this.physics.setPlayerTranslation(rp.x, rp.y, rp.z);
          this.physics.setPlayerColliderEnabled(true);
        }
        this.ragdollActive = false;
        if (this.scene.legIkWorld) {
          this.scene.legIkWorld.ragdollActive = false;
          this.scene.legIkWorld.ragdollHuman = null;
          this.scene.legIkWorld.ragdollRetargetState = null;
        }
        if (localComp) this._exitRagdollMixamo(localComp);
        if (mirrorComp) this._exitRagdollMixamo(mirrorComp);
        return;
      }

      const feetY = p.y + this.physics._feetOffsetY();
      const human = this.physics.spawnRagdoll(
        this.el.object3D,
        { x: p.x, y: feetY, z: p.z },
        // Drive the skinned Mixamo character from the physics bodies (retarget).
        // Set showDebug:true to also see the raw physics capsules for debugging.
        {
          showDebug: false,
          mirrorOpts: this._getMirrorRagdollOpts(),
          // TEMPORARY: ragdoll everything above the ankles. This skeleton has no
          // foot/ankle bodies (the calf capsule ends at the ankle), so every body
          // is dynamic here — i.e. a full ragdoll. Remove `dynamicBones` entirely
          // for the same effect.
          dynamicBones: [
            'pelvis',
            'spine_01', 'spine_02', 'spine_03',
            'neck', 'head',
            'thigh_l', 'calf_l',
            'thigh_r', 'calf_r',
            'upper_arm_l', 'lower_arm_l', 'hand_l',
            'upper_arm_r', 'lower_arm_r', 'hand_r'
          ]
        }
      );

      this.ragdollActive = true;
      if (this.scene.legIkWorld) {
        this.scene.legIkWorld.ragdollActive = true;
        this.scene.legIkWorld.ragdollHuman = human;
        this.scene.legIkWorld.b3 = this.b3;
        this.scene.legIkWorld.ragdollRetargetState = null;
      }

      // Align physics to the live mesh (hips XZ, ankle Y) before calibrating.
      // Do NOT use player feetY — mesh soles sit below the physics ankle capsules.
      if (localComp && window.Box3DRagdollRetarget?.alignHumanToMeshAnchors) {
        window.Box3DRagdollRetarget.alignHumanToMeshAnchors(localComp, this.b3, human);
      }

      // Carry rig + limb momentum into the ragdoll (thruster / walk + per-bone velocity).
      {
        let vx = 0;
        let vy = 0;
        let vz = 0;
        const rig = document.getElementById('rig');
        const zc = rig?.components?.['zerog-locomotion'];
        if (window.BodyRiggedGravity?.isZeroG?.()) {
          const thrusterVel = zc?.getVelocity?.();
          if (thrusterVel) {
            vx = thrusterVel.x;
            vy = thrusterVel.y;
            vz = thrusterVel.z;
          } else if (localComp?.headVelocity) {
            vx = localComp.headVelocity.x;
            vy = localComp.headVelocity.y;
            vz = localComp.headVelocity.z;
          }
        } else {
          const speed = this.scene.legIkWorld?.playerSpeed || 0;
          const dir = this._playerMoveDir || { x: 0, z: 0 };
          vy = (this.physics.playerVelY ?? this.playerVelY) || 0;
          vx = dir.x * speed;
          vz = dir.z * speed;
          vy = Math.max(vy, -6);
        }
        const baseVel = { x: vx, y: vy, z: vz };
        if (window.Box3DRagdollRetarget?.applyMixamoSpawnMomentum && localComp) {
          window.Box3DRagdollRetarget.applyMixamoSpawnMomentum(localComp, this.b3, human, baseVel);
        } else if (window.Box3DRagdoll.setHumanVelocity) {
          window.Box3DRagdoll.setHumanVelocity(this.b3, human, vx, vy, vz);
        }
      }

      if (localComp && window.Box3DRagdollRetarget && this.scene.legIkWorld) {
        // Do NOT force the bodies onto the Mixamo pose — the joints are authored for
        // the bodies' natural reference orientations, so teleporting them to arbitrary
        // bone rotations violates every joint and the solver snaps them explosively.
        // Instead the offset-based calibration captures the current mesh pose while the
        // bodies stay in their joint-consistent reference pose: frame 0 reproduces the
        // visible character exactly, then it falls smoothly from there.
        this.scene.legIkWorld.ragdollRetargetState = window.Box3DRagdollRetarget.calibrate(
          localComp,
          this.b3,
          human
        );
        window.Box3DRagdollRetarget.apply(
          localComp,
          this.b3,
          human,
          this.scene.legIkWorld.ragdollRetargetState
        );
        localComp._publishPoseSnapshot();
      }

      if (localComp) this._enterRagdollMixamo(localComp);
      if (mirrorComp) {
        this._enterRagdollMixamo(mirrorComp);
        if (mirrorComp.syncPoseFromLocal) mirrorComp.syncPoseFromLocal();
      }
    },

    _enterRagdollMixamo: function (comp) {
      if (!comp) return;
      if (comp.mixer) comp.mixer.stopAllAction();
      comp._ragdollPausedAnim = true;
      // Skinned character is driven by the retarget; keep it visible.
      if (comp.model) comp.model.visible = true;
    },

    _exitRagdollMixamo: function (comp) {
      if (!comp) return;
      comp._ragdollPausedAnim = false;
      if (comp.model) comp.model.visible = true;
      if (comp.mixer && comp.animClips?.idle) {
        const idle = comp.mixer.clipAction(comp.animClips.idle);
        idle.reset();
        idle.setLoop(THREE.LoopRepeat, Infinity);
        idle.setEffectiveWeight(1);
        idle.play();
        comp.currentAnim = 'idle';
      }
    },

    _getMirrorRagdollOpts: function () {
      const rig = document.getElementById('rig');
      const camera = document.getElementById('camera');
      const vrLoco = rig?.components['vr-locomotion'];
      const mirrorEl = document.getElementById('mirror-body');
      const mirrorComp = mirrorEl?.components['mixamo-body'];
      return {
        mirrorDistance: mirrorComp?.mirrorDistance ?? 2,
        manualRotationY: vrLoco?.mirrorRotationY ?? 0,
        camera: camera || null
      };
    },

    _computeMantleCrouchPeak: function (stepUp, horizDist) {
      const lipHeight = Math.max(0, stepUp);
      const heightNeed = THREE.MathUtils.clamp(lipHeight / 1.15, 0, 1);
      const forwardNeed = THREE.MathUtils.clamp(horizDist / 0.85, 0.35, 1);
      return THREE.MathUtils.clamp(Math.max(heightNeed * 0.92, 0.5) * forwardNeed, 0.45, 1);
    },

    _hasStandableFloor: function (x, y, z) {
      if (!this.queries) return false;
      const hit = this.queries.castRayDown(x, y + 0.4, z, 0.75, this.physics?.playerShapeIds);
      if (!hit) return false;
      return Math.abs(hit.point.y - y) < 0.1;
    },

    _tryGrabPullLedgeMount: function (bodyPos, waistY, dx, dy, dz, grabAnchors) {
      if (!this.queries) return null;

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
        const hit = this.queries.castRay(
          { x: px, y: py, z: pz },
          { x: 0, y: -1, z: 0 },
          py + 1.5
        );
        if (!hit) return;

        const surfaceY = hit.point.y;
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
            stepUp,
            horizX,
            horizZ,
            crouchPeak
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
      this._syncPlayerColliderCrouch(this._getPlayerColliderCrouchT());
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
      this._syncPlayerColliderCrouch(this._getPlayerColliderCrouchT());

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
      if (!this.physics || !worldDelta) return;
      const safeDt = Math.max(typeof dt === 'number' ? dt : 0.016, 0.001);
      const rig = document.getElementById('rig');
      if (!rig) return;

      const deltaSq =
        worldDelta.x * worldDelta.x + worldDelta.y * worldDelta.y + worldDelta.z * worldDelta.z;

      if (deltaSq < 1e-10 && !this._ledgeMantleActive) {
        this.grabPullLocomotionActive = true;
        this._grabPullRising = false;
        this._syncPlayerRootPos();
        return;
      }

      const cur = this.physics.getPlayerTranslation();
      let grabDx = 0;
      let grabDy = 0;
      let grabDz = 0;

      if (deltaSq >= 1e-10) {
        grabDx = worldDelta.x;
        grabDy = worldDelta.y;
        grabDz = worldDelta.z;

        if (Math.abs(grabDx) + Math.abs(grabDz) > 1e-8 && this.queries) {
          const horiz = this.queries.moveCapsuleMover(
            cur,
            { x: grabDx, y: 0, z: grabDz },
            this.physics.capsule,
            this.physics.moverFilter
          );
          grabDx = horiz.delta.x;
          grabDz = horiz.delta.z;
        }

        if (grabDy < -1e-6 && this.queries) {
          const vert = this.queries.moveCapsuleMover(
            cur,
            { x: 0, y: grabDy, z: 0 },
            this.physics.capsule,
            this.physics.moverFilter
          );
          grabDy = vert.delta.y;
        }
      }

      this._grabPullRising = grabDy > 0.004;

      const waistOffset = (hints && hints.waistOffset) || 1.02;
      const waistY = cur.y + waistOffset;
      const grabAnchors = hints && hints.grabAnchors;
      let dx = grabDx;
      let dy = grabDy;
      let dz = grabDz;
      if (this.enableGrabPullLedgeMantle) {
        if (!this._ledgeMantleActive) {
          const mount = this._tryGrabPullLedgeMount(cur, waistY, grabDx, grabDy, grabDz, grabAnchors);
          if (mount) {
            this._beginLedgeMantle(mount, cur);
          }
        }
        if (this._ledgeMantleActive) {
          const merged = this._mergeLedgeMantleMovement(cur, grabDx, grabDy, grabDz, safeDt);
          dx = merged.x;
          dy = merged.y;
          dz = merged.z;
          this._grabPullRising = dy > 0.004;
        }
      }

      if (dy > 1e-6) {
        this.physics.setPlayerTranslation(cur.x + dx, cur.y + dy, cur.z + dz);
        rig.object3D.position.set(cur.x + dx, cur.y + dy, cur.z + dz);
        this.playerGrounded = false;
      } else if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-8) {
        const moved = this.physics.movePlayer({ x: dx, y: dy, z: dz }, { horizontalOnly: false });
        rig.object3D.position.set(moved.position.x, moved.position.y, moved.position.z);
        this.playerGrounded = this.physics.playerGrounded;
      }

      const instant = this._grabPullVelTmp;
      instant.set(dx / safeDt, dy / safeDt, dz / safeDt);
      const blend = this.grabPullVelocitySmooth || 0.35;
      this._grabPullVelocity.x += (instant.x - this._grabPullVelocity.x) * blend;
      this._grabPullVelocity.y += (instant.y - this._grabPullVelocity.y) * blend;
      this._grabPullVelocity.z += (instant.z - this._grabPullVelocity.z) * blend;

      this.playerVelY = 0;
      this.grabPullLocomotionActive = true;
      this._syncPlayerRootPos();
    },

    _syncPlayerRootPos: function () {
      if (!this.physics || !this.scene.legIkWorld) return;
      const pos = this.physics.getPlayerTranslation();
      const camera = document.getElementById('camera');
      if (this.el.is('vr-mode') && camera) {
        camera.object3D.getWorldPosition(this._playerRootPos);
        this._playerRootPos.y = pos.y;
      } else {
        this._playerRootPos.set(pos.x, pos.y, pos.z);
      }
      this.scene.legIkWorld.playerRootPos = this._playerRootPos;
      this.scene.legIkWorld.isPlayerGrounded = this.playerGrounded;
    },

    clearLedgeMantle: function () {
      this._ledgeMantleActive = false;
      this._ledgeMantleStartDist = 0;
      this._ledgeMantleProgress = 0;
      this._ledgeMantleDuration = 0.5;
      this._ledgeMantlePlan = null;
      this.mantleCrouchAmount = 0;
      if (this.scene.legIkWorld) this.scene.legIkWorld.mantleCrouchAmount = 0;
      if (this._ledgeMantleTarget) {
        this._ledgeMantleTarget.set(0, 0, 0);
      }
      this._syncPlayerColliderCrouch(this._getPlayerColliderCrouchT());
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

      // In zero-g, hand the full 3D fling to thruster locomotion instead of walk momentum.
      const zc = document.getElementById('rig')?.components?.['zerog-locomotion'];
      if (window.BodyRiggedGravity?.isZeroG?.() && zc?.applyPushImpulse) {
        zc.applyPushImpulse(this._grabMomentum.x, this.playerVelY, this._grabMomentum.z);
        this._grabMomentum.set(0, 0, 0);
        this._grabMomentumActive = false;
        this.playerVelY = 0;
        this.playerGrounded = false;
      } else if (
        Math.abs(this.playerVelY) > 0.4 ||
        this._grabMomentum.x * this._grabMomentum.x + this._grabMomentum.z * this._grabMomentum.z > 0.16
      ) {
        this.playerGrounded = false;
      }

      this._grabPullVelocity.set(0, 0, 0);
      this.grabPullLocomotionActive = false;
      this.clearLedgeMantle();
    },

    _holdPlayerForDotEffect: function () {
      const dotFx = this.scene._bodyDotEffect;
      if (!dotFx || !dotFx.frozen || !dotFx.frozenPos) return false;

      const fp = dotFx.frozenPos;
      const rig = document.getElementById('rig');
      if (rig) rig.object3D.position.set(fp.x, fp.y, fp.z);
      if (this.physics) {
        this.physics.setPlayerTranslation(fp.x, fp.y, fp.z);
      }
      if (this._playerMov) this._playerMov.set(0, 0, 0);
      if (this._grabMomentum) {
        this._grabMomentum.set(0, 0, 0);
        this._grabMomentumActive = false;
      }
      if (this._playerMoveDir) this._playerMoveDir.set(0, 0, 0);
      this.playerVelY = 0;
      this.grabPullLocomotionActive = false;
      if (this.scene.legIkWorld) {
        this.scene.legIkWorld.playerSpeed = 0;
      }
      return true;
    },

    _feetOffsetFromCapsule: function () {
      const cap = this.physics?.capsule;
      if (!cap) return 0;
      return cap.center1.y - cap.radius;
    },

    // Smoothly conform capsule root Y to terrain (ramps/stairs) instead of instant autostep pops.
    _computeGroundFollowDy: function (cur, dt, isMoving) {
      if (!this.terrain || !this.physics) return 0;
      const feetOff = this._feetOffsetFromCapsule();
      let surfaceY = this.terrain.getHeightAtWorld(cur.x, cur.z);

      if (isMoving) {
        const horizLen = Math.hypot(this._playerMov.x, this._playerMov.z);
        if (horizLen > 0.04) {
          const lookAhead = Math.min(0.42, horizLen * dt * 2.2 + 0.16);
          const ax = cur.x + (this._playerMov.x / horizLen) * lookAhead;
          const az = cur.z + (this._playerMov.z / horizLen) * lookAhead;
          const aheadY = this.terrain.getHeightAtWorld(ax, az);
          if (aheadY > surfaceY) surfaceY = aheadY;
        }
      }

      const targetY = surfaceY - feetOff;
      const deltaY = targetY - cur.y;
      if (Math.abs(deltaY) < 1e-5) return 0;

      const upSpeed = isMoving ? 4.2 : 2.0;
      const downSpeed = isMoving ? 5.0 : 2.5;
      const maxDy = (deltaY > 0 ? upSpeed : downSpeed) * dt;
      return THREE.MathUtils.clamp(deltaY, -maxDy, maxDy);
    },

    _updatePlayerPhysics: function (deltaMs) {
      if (this._holdPlayerForDotEffect()) return;
      if (!this.ready || !this.physics || this.ragdollActive) return;
      const rig = document.getElementById('rig');
      const camera = document.getElementById('camera');
      if (!rig || !camera) return;

      const dt = Math.min(deltaMs / 1000, 0.1);

      // Zero-G mode: thruster / boost / airbrake controller owns capsule motion.
      const zc = rig.components?.['zerog-locomotion'];
      if (window.BodyRiggedGravity?.isZeroG?.() && zc?.tickZeroG) {
        zc.tickZeroG(dt, this);
        return;
      }

      const isVR = this.el.is('vr-mode');
      const keys = window._bodyRiggedKeys || {};
      const sprint = keys.ShiftLeft || keys.ShiftRight;
      const moveSpeed = 2.5 * (sprint ? 1.8 : 1.0);
      const grabPullActive = this.grabPullLocomotionActive;
      this.playerGrounded = this.physics.playerGrounded;

      const camWorldQuat = new THREE.Quaternion();
      camera.object3D.getWorldQuaternion(camWorldQuat);
      this._playerFwd.set(0, 0, -1).applyQuaternion(camWorldQuat);
      this._playerFwd.y = 0;
      if (this._playerFwd.lengthSq() > 1e-8) this._playerFwd.normalize();
      else this._playerFwd.set(0, 0, -1);
      this._playerRgt.set(1, 0, 0).applyQuaternion(camWorldQuat);
      this._playerRgt.y = 0;
      if (this._playerRgt.lengthSq() > 1e-8) this._playerRgt.normalize();
      else this._playerRgt.set(1, 0, 0);
      this._playerMov.set(0, 0, 0);

      const stickDeadzone = 0.08;

      if (isVR && !grabPullActive) {
        const vrLoco = rig.components['vr-locomotion'];
        const stick = vrLoco?.thumbstickMove?.left;
        if (stick) {
          const sx = stick.x || 0;
          const sy = stick.y || 0;
          const mag = Math.min(1, Math.hypot(sx, sy));
          if (mag > stickDeadzone) {
            const nx = sx / mag;
            const ny = sy / mag;
            this._playerMov.addScaledVector(this._playerFwd, -ny * mag);
            this._playerMov.addScaledVector(this._playerRgt, nx * mag);
          }
        }
      } else if (!isVR && !grabPullActive) {
        if (keys.KeyW || keys.ArrowUp) this._playerMov.add(this._playerFwd);
        if (keys.KeyS || keys.ArrowDown) this._playerMov.sub(this._playerFwd);
        if (keys.KeyA || keys.ArrowLeft) this._playerMov.sub(this._playerRgt);
        if (keys.KeyD || keys.ArrowRight) this._playerMov.add(this._playerRgt);
      }

      const isMoving = this._playerMov.lengthSq() > 0.001;
      if (isMoving) {
        const intentMag = Math.min(1, this._playerMov.length());
        this._playerMov.normalize().multiplyScalar(moveSpeed * intentMag);
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
        if (this.scene.legIkWorld) {
          this.scene.legIkWorld.playerSpeed = 0;
          if (this.scene.legIkWorld.playerMoveDir) {
            this.scene.legIkWorld.playerMoveDir.set(0, 0, 0);
          }
        }
        this._syncPlayerRootPos();
        return;
      }

      const cur = this.physics.getPlayerTranslation();
      let pos = cur;

      const horizDt = { x: moveX * dt, y: 0, z: moveZ * dt };
      if (Math.abs(horizDt.x) + Math.abs(horizDt.z) > 1e-8) {
        const h = this.physics.movePlayer(horizDt, { horizontalOnly: true });
        pos = h.position;
        this.playerGrounded = this.physics.playerGrounded;
      }

      if (this.playerGrounded) {
        const dyGround = this._computeGroundFollowDy(pos, dt, isMoving);
        if (Math.abs(dyGround) > 1e-6) {
          const v = this.physics.movePlayer({ x: 0, y: dyGround, z: 0 }, { horizontalOnly: false });
          pos = v.position;
          this.playerGrounded = this.physics.playerGrounded;
        }
      } else {
        const v = this.physics.movePlayer(
          { x: 0, y: this.playerVelY * dt, z: 0 },
          { horizontalOnly: false }
        );
        pos = v.position;
        this.playerGrounded = this.physics.playerGrounded;
      }

      rig.object3D.position.set(pos.x, pos.y, pos.z);

      const moved = {
        position: pos,
        delta: {
          x: pos.x - cur.x,
          y: pos.y - cur.y,
          z: pos.z - cur.z
        }
      };

      this.playerGrounded = this.physics.playerGrounded;
      if (this.playerGrounded && this.playerVelY < 0) {
        this.playerVelY = -2;
      }

      this.physics.playerVelY = this.playerVelY;

      const actualSpeed = Math.sqrt(
        moved.delta.x * moved.delta.x + moved.delta.z * moved.delta.z
      ) / Math.max(dt, 0.001);

      if (this._grabMomentumActive && !isMoving) {
        const damp = Math.pow(0.96, dt * 60);
        this._grabMomentum.x *= damp;
        this._grabMomentum.z *= damp;
        if (this._grabMomentum.lengthSq() < 0.05) {
          this._grabMomentum.set(0, 0, 0);
          this._grabMomentumActive = false;
        }
      }

      if (this.scene.legIkWorld) {
        this.scene.legIkWorld.isPlayerGrounded = this.playerGrounded;
        this.scene.legIkWorld.playerSpeed = isMoving ? actualSpeed : 0;
        this.scene.legIkWorld.playerRootPos = this._playerRootPos;
        if (isMoving) {
          this._playerMoveDir.set(this._playerMov.x, 0, this._playerMov.z).normalize();
        } else {
          this._playerMoveDir.set(0, 0, 0);
        }
        this.scene.legIkWorld.playerMoveDir = this._playerMoveDir;
        if (isVR) {
          camera.object3D.getWorldPosition(this._playerRootPos);
          this._playerRootPos.y = pos.y;
        } else {
          this._playerRootPos.set(pos.x, pos.y, pos.z);
        }
      }
    },

    _checkHeadCollision: function () {
      if (!this.physics || !this.el.is('vr-mode') || this.grabPullLocomotionActive) return;
      const rig = document.getElementById('rig');
      const camera = document.getElementById('camera');
      if (!rig || !camera) return;
      const headPos = new THREE.Vector3();
      camera.object3D.getWorldPosition(headPos);
      const result = this.physics.resolveSphere(headPos, 0.2, { horizontalOnly: true });
      if (!result.hit) return;
      const correction = result.position.clone().sub(headPos);
      correction.y = 0;
      rig.object3D.position.add(correction);
      const p = rig.object3D.position;
      this.physics.setPlayerTranslation(p.x, p.y, p.z);
    },

    clampHandWorldPos: function (src, dest) {
      if (!this.physics) {
        dest.copy(src);
        return false;
      }
      const result = this.physics.resolveSphere(src, this.handCollisionRadius || 0.05);
      dest.copy(result.position);
      return result.hit;
    },

    clampFingerTips: function (tips) {
      if (!this.physics) {
        return { tips: tips.map((t) => t.desired.clone()), hit: false };
      }
      return this.physics.clampFingerTips(tips, this.fingerCollisionRadius || 0.012);
    },

    clampHandPalmAlongTracking: function (lastValid, desired, dest, hand, trackingPos, options) {
      options = options || {};
      const debugKey = hand === 'left' ? '_handPalmDebugLeft' : '_handPalmDebugRight';
      const track = trackingPos || desired;
      const emptyDebug = {
        hit: false,
        sticky: null,
        contactPoint: null,
        normal: new THREE.Vector3(0, 1, 0),
        controller: track.clone(),
        contactDistance: 0
      };

      if (!this.physics || !this.physics.queries) {
        dest.copy(desired);
        this[debugKey] = emptyDebug;
        return false;
      }

      const radius = this.handCollisionRadius || 0.05;
      const resetDist = 0.5;

      // If the tracked hand jumped far (teleport / respawn), drop the history so
      // we don't try to slide across the whole scene in one frame.
      if (lastValid && lastValid.distanceTo(desired) > resetDist) {
        lastValid = null;
      }

      const slide = this.physics.slideHandSphere(lastValid, lastValid || track, desired, radius, track);
      dest.copy(slide.position);

      const n = slide.normal ? slide.normal.clone() : new THREE.Vector3(0, 1, 0);
      if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
      else n.normalize();

      const blocked = slide.hit || dest.distanceTo(desired) > 1e-4;
      this[debugKey] = {
        hit: blocked,
        sticky: slide.position.clone(),
        contactPoint: slide.contactPoint
          ? slide.contactPoint.clone()
          : slide.position.clone().addScaledVector(n, -radius),
        normal: n,
        controller: track.clone(),
        contactDistance: blocked ? slide.position.distanceTo(track) : 0
      };
      return blocked;
    },

    clampHandPalmConstrained: function (lastValid, desired, dest, hand) {
      return this.clampHandPalmAlongTracking(lastValid, desired, dest, hand);
    },

    tick: function (time, deltaTime) {
      const zeroG = !!(window.BodyRiggedGravity && window.BodyRiggedGravity.isZeroG());
      if (this.el.is('vr-mode')) {
        if (!zeroG) this._updateVRCrouch();
        else this._syncPlayerColliderCrouch(0);
        if (!this._panelTick) this._panelTick = 0;
        if (++this._panelTick % 20 === 0) {
          this._updateVRHeightPanel();
        }
      } else {
        this._syncPlayerColliderCrouch(0);
      }
      this._updatePlayerPhysics(deltaTime);
      this._checkHeadCollision();
    },

    tock: function (time, deltaTime) {
      if (this.ready && this.physics) {
        this.physics.step(deltaTime / 1000);
      }
    }
  });

  AFRAME.registerComponent('box3d-locomotion', {
    schema: {},
    init: function () {}
  });
})();
