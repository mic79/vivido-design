/**
 * Zero-G floating leg poses for Mixamo skeletons (from body-rigged-zerog2).
 * Driven by body-local velocity — no floor IK. Shared by local + mirror bodies.
 */
(function () {
  'use strict';

  const DEG = Math.PI / 180;

  const DEFAULT_POSES = {
    rest: { hipFlex: -10, hipSpread: 8, kneeBend: 20, ankleFlex: 15 },
    forward: { hipFlex: 20, hipSpread: 6, kneeBend: 10, ankleFlex: 5 },
    backward: { hipFlex: -60, hipSpread: 10, kneeBend: 100, ankleFlex: 110 },
    up: { hipFlex: 20, hipSpread: 10, kneeBend: 35, ankleFlex: 40 },
    down: { hipFlex: -55, hipSpread: 8, kneeBend: 95, ankleFlex: 105 },
    sideways: { hipFlex: -5, hipSpread: 4, kneeBend: 25, ankleFlex: 25 }
  };

  function emptyPose() {
    return { hipFlex: 0, hipSpread: 0, kneeBend: 0, ankleFlex: 0, ankleSway: 0 };
  }

  class ZeroGLegs {
    constructor(options = {}) {
      this.legPoses = options.poses || { ...DEFAULT_POSES };
      this.currentLegPose = { ...this.legPoses.rest };
      this.smoothedLegPose = {
        left: emptyPose(),
        right: emptyPose()
      };
      this.legPoseBlendSpeed = options.legPoseBlendSpeed ?? 0.1;
      this.legSmoothingFactor = options.legSmoothingFactor ?? 0.15;
      this.legIdlePhase = 0;
      this.legIdleRate = options.legIdleRate ?? 0.3;
      this.legIdleAmount = options.legIdleAmount ?? 3;
      this.currentDominantDirection = 'rest';
      this.directionSwitchThreshold = options.directionSwitchThreshold ?? 0.35;
      this.directionMaintainThreshold = options.directionMaintainThreshold ?? 0.15;
      this._localVel = new THREE.Vector3();
      this._invBody = new THREE.Quaternion();
      this._legGroundedQ = new THREE.Quaternion();
      this._legTargetQ = new THREE.Quaternion();
      this._legEuler = new THREE.Euler();
    }

    /**
     * @param {object} bones map with leftUpLeg/leftLeg/leftFoot + right*
     * @param {THREE.Vector3} worldVelocity player / torso world velocity
     * @param {THREE.Quaternion} bodyWorldQuat torso orientation
     * @param {number} dt seconds
     * @param {number} modeBlend 0 = grounded leg pose on bones, 1 = full zero-g pose
     */
    update(bones, worldVelocity, bodyWorldQuat, dt, modeBlend) {
      if (!bones || !worldVelocity) return;
      modeBlend = modeBlend == null ? 1 : Math.max(0, Math.min(1, modeBlend));
      if (modeBlend <= 0) return;
      const safeDt = Math.min(Math.max(dt || 0.016, 0.001), 0.1);

      this._invBody.copy(bodyWorldQuat || new THREE.Quaternion()).invert();
      this._localVel.copy(worldVelocity).applyQuaternion(this._invBody);

      const localVel = this._localVel;
      const speed = localVel.length();
      const targetPose = { ...this.legPoses.rest };

      if (speed > 0.1) {
        const velNorm = localVel.clone().normalize();
        const forwardAmount = Math.max(0, -velNorm.z);
        const backwardAmount = Math.max(0, velNorm.z);
        const upAmount = Math.max(0, velNorm.y);
        const downAmount = Math.max(0, -velNorm.y);
        const sidewaysAmount = Math.abs(velNorm.x);

        const directions = [
          { name: 'forward', amount: forwardAmount },
          { name: 'backward', amount: backwardAmount },
          { name: 'up', amount: upAmount },
          { name: 'down', amount: downAmount },
          { name: 'sideways', amount: sidewaysAmount }
        ];
        const strongest = directions.reduce((max, d) => (d.amount > max.amount ? d : max));

        const threshold = this.currentDominantDirection === strongest.name
          ? this.directionMaintainThreshold
          : this.directionSwitchThreshold;

        if (strongest.amount > threshold || speed < 0.2) {
          this.currentDominantDirection = strongest.name;
        }
        if (speed < 0.2) this.currentDominantDirection = 'rest';

        const poseWeights = [
          { pose: this.legPoses.forward, weight: forwardAmount * (this.currentDominantDirection === 'forward' ? 1.3 : 1.0) },
          { pose: this.legPoses.backward, weight: backwardAmount * (this.currentDominantDirection === 'backward' ? 1.3 : 1.0) },
          { pose: this.legPoses.up, weight: upAmount * (this.currentDominantDirection === 'up' ? 1.3 : 1.0) },
          { pose: this.legPoses.down, weight: downAmount * (this.currentDominantDirection === 'down' ? 1.3 : 1.0) },
          { pose: this.legPoses.sideways, weight: sidewaysAmount * (this.currentDominantDirection === 'sideways' ? 1.3 : 1.0) }
        ];

        targetPose.hipFlex = 0;
        targetPose.hipSpread = 0;
        targetPose.kneeBend = 0;
        targetPose.ankleFlex = 0;

        let totalWeight = 0;
        for (let i = 0; i < poseWeights.length; i++) {
          const { pose, weight } = poseWeights[i];
          if (weight <= 0) continue;
          targetPose.hipFlex += pose.hipFlex * weight;
          targetPose.hipSpread += pose.hipSpread * weight;
          targetPose.kneeBend += pose.kneeBend * weight;
          targetPose.ankleFlex += pose.ankleFlex * weight;
          totalWeight += weight;
        }
        if (totalWeight > 0) {
          targetPose.hipFlex /= totalWeight;
          targetPose.hipSpread /= totalWeight;
          targetPose.kneeBend /= totalWeight;
          targetPose.ankleFlex /= totalWeight;
        }

        const speedFactor = Math.min(1.0, speed);
        targetPose.hipFlex = THREE.MathUtils.lerp(this.legPoses.rest.hipFlex, targetPose.hipFlex, speedFactor);
        targetPose.hipSpread = THREE.MathUtils.lerp(this.legPoses.rest.hipSpread, targetPose.hipSpread, speedFactor);
        targetPose.kneeBend = THREE.MathUtils.lerp(this.legPoses.rest.kneeBend, targetPose.kneeBend, speedFactor);
        targetPose.ankleFlex = THREE.MathUtils.lerp(this.legPoses.rest.ankleFlex, targetPose.ankleFlex, speedFactor);
      } else {
        this.currentDominantDirection = 'rest';
      }

      this.currentLegPose.hipFlex = THREE.MathUtils.lerp(this.currentLegPose.hipFlex, targetPose.hipFlex, this.legPoseBlendSpeed);
      this.currentLegPose.hipSpread = THREE.MathUtils.lerp(this.currentLegPose.hipSpread, targetPose.hipSpread, this.legPoseBlendSpeed);
      this.currentLegPose.kneeBend = THREE.MathUtils.lerp(this.currentLegPose.kneeBend, targetPose.kneeBend, this.legPoseBlendSpeed);
      this.currentLegPose.ankleFlex = THREE.MathUtils.lerp(this.currentLegPose.ankleFlex, targetPose.ankleFlex, this.legPoseBlendSpeed);

      const leftPose = { ...this.currentLegPose, ankleSway: 0 };
      const rightPose = { ...this.currentLegPose, ankleSway: 0 };

      this.legIdlePhase += safeDt * this.legIdleRate;
      const idleInfluence = Math.max(0, 1.0 - speed * 2.0);
      const leftIdleOffset = Math.sin(this.legIdlePhase) * this.legIdleAmount * idleInfluence;
      const rightIdleOffset = Math.sin(this.legIdlePhase + Math.PI) * this.legIdleAmount * idleInfluence;
      leftPose.hipFlex += leftIdleOffset * 0.5;
      leftPose.kneeBend += leftIdleOffset;
      leftPose.ankleFlex += leftIdleOffset * 0.3;
      rightPose.hipFlex += rightIdleOffset * 0.5;
      rightPose.kneeBend += rightIdleOffset;
      rightPose.ankleFlex += rightIdleOffset * 0.3;

      const sidewaysVel = localVel.x;
      const sidewaysAmount = Math.abs(sidewaysVel);
      if (sidewaysAmount > 0.1) {
        if (sidewaysVel < 0) {
          leftPose.kneeBend *= 0.6;
          rightPose.kneeBend *= 1.4;
          leftPose.ankleSway = -15;
          rightPose.ankleSway = 10;
        } else {
          rightPose.kneeBend *= 0.6;
          leftPose.kneeBend *= 1.4;
          rightPose.ankleSway = 15;
          leftPose.ankleSway = -10;
        }
      }

      const props = ['hipFlex', 'hipSpread', 'kneeBend', 'ankleFlex', 'ankleSway'];
      for (let i = 0; i < props.length; i++) {
        const prop = props[i];
        this.smoothedLegPose.left[prop] = THREE.MathUtils.lerp(
          this.smoothedLegPose.left[prop],
          leftPose[prop] || 0,
          this.legSmoothingFactor
        );
        this.smoothedLegPose.right[prop] = THREE.MathUtils.lerp(
          this.smoothedLegPose.right[prop],
          rightPose[prop] || 0,
          this.legSmoothingFactor
        );
      }

      this.applyLegPose(bones, 'left', this.smoothedLegPose.left, modeBlend);
      this.applyLegPose(bones, 'right', this.smoothedLegPose.right, modeBlend);
    }

    _blendBoneRotation(bone, targetEuler, modeBlend) {
      if (!bone) return;
      if (modeBlend >= 0.999) {
        bone.rotation.copy(targetEuler);
        return;
      }
      this._legGroundedQ.copy(bone.quaternion);
      this._legTargetQ.setFromEuler(targetEuler);
      this._legGroundedQ.slerp(this._legTargetQ, modeBlend);
      bone.quaternion.copy(this._legGroundedQ);
      bone.rotation.setFromQuaternion(bone.quaternion);
    }

    applyLegPose(bones, side, pose, modeBlend) {
      modeBlend = modeBlend == null ? 1 : Math.max(0, Math.min(1, modeBlend));
      if (modeBlend <= 0) return;

      const upLegBone = bones[`${side}UpLeg`] || bones[side === 'left' ? 'leftThigh' : 'rightThigh'];
      const legBone = bones[`${side}Leg`] || bones[side === 'left' ? 'leftKnee' : 'rightKnee'];
      const footBone = bones[`${side}Foot`] || bones[side === 'left' ? 'leftFoot' : 'rightFoot'];
      if (!upLegBone || !legBone || !footBone) return;

      const hipFlexRad = pose.hipFlex * DEG;
      const hipSpreadRad = pose.hipSpread * DEG * (side === 'left' ? 1 : -1);
      const kneeBendRad = pose.kneeBend * DEG;
      const ankleFlexRad = pose.ankleFlex * DEG;
      const ankleSwayRad = (pose.ankleSway || 0) * DEG;

      this._blendBoneRotation(
        upLegBone,
        this._legEuler.set(hipFlexRad, 0, Math.PI + hipSpreadRad, 'XYZ'),
        modeBlend
      );
      this._blendBoneRotation(
        legBone,
        this._legEuler.set(-kneeBendRad, 0, 0, 'XYZ'),
        modeBlend
      );
      this._blendBoneRotation(
        footBone,
        this._legEuler.set(ankleFlexRad, 0, ankleSwayRad, 'XYZ'),
        modeBlend
      );
    }
  }

  /** Smooth 0↔1 blend for grounded ↔ zero-g leg poses (~0.35s default). */
  function updateLegModeBlend(current, isZeroG, dt, rate) {
    const target = isZeroG ? 1 : 0;
    const blendRate = rate == null ? 5.5 : rate;
    const safeDt = Math.min(Math.max(dt || 0.016, 0.001), 0.1);
    return current + (target - current) * Math.min(1, safeDt * blendRate);
  }

  window.ZeroGLegs = ZeroGLegs;
  window.ZeroGLegs.DEFAULT_POSES = DEFAULT_POSES;
  window.ZeroGLegs.updateLegModeBlend = updateLegModeBlend;
})();
