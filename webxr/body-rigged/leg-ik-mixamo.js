/**
 * Leg IK for A-Frame Mixamo bodies — ported from:
 * https://github.com/Aditya02git/Leg-IK_In_ThreeJS_With_Rapier
 */
(function () {
  'use strict';

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
          crouchAmount: 0
        };

      this._applyCameraFloorOffset();
      this._updateVRHeightPanel();

      this._prevCamLocal = new THREE.Vector3();
      this._prevCamLocalInitialized = false;
      this._lastRecenterMs = 0;
      this._boundRefSpace = null;
      this._refSpaceResetHandler = null;

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
          crouchAmount: 0
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
        { url: 'Problem_1.glb', x: 4, z: -5, name: 'Ramp' },
        { url: 'Problem_2.glb', x: 7, z: -5, name: 'Stairs' }
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

      this.charController = world.createCharacterController(0.05);
      this.charController.setSlideEnabled(true);
      this.charController.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
      this.charController.setMinSlopeSlideAngle((30 * Math.PI) / 180);
      this.charController.enableAutostep(0.2, 0.05, true);
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

      console.log('[Leg IK World] Player character controller ready');
    },

    _updatePlayerPhysics: function (deltaMs) {
      if (!this.playerBody || !this.charController || !this.world) return;

      const rig = document.getElementById('rig');
      const camera = document.getElementById('camera');
      if (!rig || !camera) return;

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

      if (isVR) {
        const vrLoco = rig.components['vr-locomotion'];
        const stick = vrLoco?.thumbstickMove?.left;
        if (stick) {
          if (stick.y) this._playerMov.addScaledVector(this._playerFwd, -stick.y);
          if (stick.x) this._playerMov.addScaledVector(this._playerRgt, stick.x);
        }
      } else {
        if (keys.KeyW || keys.ArrowUp) this._playerMov.add(this._playerFwd);
        if (keys.KeyS || keys.ArrowDown) this._playerMov.sub(this._playerFwd);
        if (keys.KeyA || keys.ArrowLeft) this._playerMov.sub(this._playerRgt);
        if (keys.KeyD || keys.ArrowRight) this._playerMov.add(this._playerRgt);
      }

      const isMoving = this._playerMov.lengthSq() > 0.001;
      if (isMoving) {
        this._playerMov.normalize().multiplyScalar(moveSpeed);
      }

      const GRAVITY = -25;
      this.playerVelY += GRAVITY * dt;
      if (this.playerGrounded && this.playerVelY < 0) {
        this.playerVelY = -2;
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
          if (stepHeight > 0.02 && stepHeight < 0.4) {
            stepUpY = stepHeight;
          }
        }
      }

      const desired = {
        x: this._playerMov.x * dt,
        y: stepUpY > 0 ? stepUpY : this.playerVelY * dt,
        z: this._playerMov.z * dt
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

    tick: function (time, deltaTime) {
      if (this.el.is('vr-mode')) {
        this._updateVRCrouch();
        if (!this._panelTick) this._panelTick = 0;
        if (++this._panelTick % 20 === 0) {
          this._updateVRHeightPanel();
        }
      }
      this._updatePlayerPhysics(deltaTime);
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
