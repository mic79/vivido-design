import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";

const _WORLD_UP = new THREE.Vector3(0, 1, 0);
const _DOWN_AXIS = new THREE.Vector3(0, -1, 0);
const DEFAULT_MODEL_URL = new URL("../3d/Y Bot.fbx", import.meta.url).href;

class BodyIkAvatar {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.color = opts.color ?? 0x4a90e2;
    this.enabled = opts.enabled !== false;
    this.hideHead = opts.hideHead !== false;
    this.modelUrl = opts.modelUrl || DEFAULT_MODEL_URL;

    this.root = new THREE.Group();
    this.root.name = "vr_runner_body_ik_avatar";
    this.root.visible = false;
    this.scene.add(this.root);

    this.model = null;
    this.modelLoaded = false;
    this.skinnedMesh = null;
    this.skeleton = null;
    this.bones = {};
    this.initialBoneRotations = {};

    this.boneNames = {
      hips: "mixamorigHips",
      spine: "mixamorigSpine",
      spine1: "mixamorigSpine1",
      spine2: "mixamorigSpine2",
      neck: "mixamorigNeck",
      head: "mixamorigHead",
      leftShoulder: "mixamorigLeftShoulder",
      leftArm: "mixamorigLeftArm",
      leftForeArm: "mixamorigLeftForeArm",
      leftHand: "mixamorigLeftHand",
      rightShoulder: "mixamorigRightShoulder",
      rightArm: "mixamorigRightArm",
      rightForeArm: "mixamorigRightForeArm",
      rightHand: "mixamorigRightHand",
      leftUpLeg: "mixamorigLeftUpLeg",
      leftLeg: "mixamorigLeftLeg",
      leftFoot: "mixamorigLeftFoot",
      rightUpLeg: "mixamorigRightUpLeg",
      rightLeg: "mixamorigRightLeg",
      rightFoot: "mixamorigRightFoot",
      leftHandThumb1: "mixamorigLeftHandThumb1",
      leftHandThumb2: "mixamorigLeftHandThumb2",
      leftHandThumb3: "mixamorigLeftHandThumb3",
      leftHandIndex1: "mixamorigLeftHandIndex1",
      leftHandIndex2: "mixamorigLeftHandIndex2",
      leftHandIndex3: "mixamorigLeftHandIndex3",
      leftHandMiddle1: "mixamorigLeftHandMiddle1",
      leftHandMiddle2: "mixamorigLeftHandMiddle2",
      leftHandMiddle3: "mixamorigLeftHandMiddle3",
      leftHandRing1: "mixamorigLeftHandRing1",
      leftHandRing2: "mixamorigLeftHandRing2",
      leftHandRing3: "mixamorigLeftHandRing3",
      leftHandPinky1: "mixamorigLeftHandPinky1",
      leftHandPinky2: "mixamorigLeftHandPinky2",
      leftHandPinky3: "mixamorigLeftHandPinky3",
      rightHandThumb1: "mixamorigRightHandThumb1",
      rightHandThumb2: "mixamorigRightHandThumb2",
      rightHandThumb3: "mixamorigRightHandThumb3",
      rightHandIndex1: "mixamorigRightHandIndex1",
      rightHandIndex2: "mixamorigRightHandIndex2",
      rightHandIndex3: "mixamorigRightHandIndex3",
      rightHandMiddle1: "mixamorigRightHandMiddle1",
      rightHandMiddle2: "mixamorigRightHandMiddle2",
      rightHandMiddle3: "mixamorigRightHandMiddle3",
      rightHandRing1: "mixamorigRightHandRing1",
      rightHandRing2: "mixamorigRightHandRing2",
      rightHandRing3: "mixamorigRightHandRing3",
      rightHandPinky1: "mixamorigRightHandPinky1",
      rightHandPinky2: "mixamorigRightHandPinky2",
      rightHandPinky3: "mixamorigRightHandPinky3",
    };

    this.config = {
      shoulderWidth: 0.34,
      upperArmLength: 0.31,
      lowerArmLength: 0.31,
      upperLegLength: 0.45,
      lowerLegLength: 0.45,
    };

    this.torsoRotation = new THREE.Quaternion();
    this.bodyTilt = new THREE.Quaternion();
    this.smoothingFactor = 0.15;
    this.previousHeadPos = new THREE.Vector3();
    this.previousHeadPosInitialized = false;
    this.headVelocity = new THREE.Vector3();
    this.headAcceleration = new THREE.Vector3();
    this.previousHeadVelocity = new THREE.Vector3();
    this.torsoLean = new THREE.Vector3();
    this.torsoLeanVelocity = 0.15;

    this.legIdlePhase = 0;
    this.legIdleRate = 0.3;
    this.legIdleAmount = 3;
    this.smoothedLegPose = {
      left: { hipFlex: 0, hipSpread: 0, kneeBend: 0, ankleFlex: 0, ankleSway: 0 },
      right: { hipFlex: 0, hipSpread: 0, kneeBend: 0, ankleFlex: 0, ankleSway: 0 },
    };
    this.legSmoothingFactor = 0.15;
    this.currentDominantDirection = "rest";
    this.directionSwitchThreshold = 0.35;
    this.directionMaintainThreshold = 0.15;
    this.legPoses = {
      rest: { hipFlex: -10, hipSpread: 8, kneeBend: 20, ankleFlex: 15 },
      forward: { hipFlex: -5, hipSpread: 6, kneeBend: 15, ankleFlex: 10 },
      backward: { hipFlex: -20, hipSpread: 10, kneeBend: 30, ankleFlex: 25 },
      up: { hipFlex: 5, hipSpread: 10, kneeBend: 25, ankleFlex: 30 },
      down: { hipFlex: -25, hipSpread: 8, kneeBend: 35, ankleFlex: 30 },
      sideways: { hipFlex: -5, hipSpread: 4, kneeBend: 25, ankleFlex: 25 },
    };
    this.currentLegPose = { ...this.legPoses.rest };
    this.legPoseBlendSpeed = 0.1;

    this.targetCurls = {
      left: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
      right: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
    };
    this.currentCurls = {
      left: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
      right: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
    };
    this.fingerSmoothingFactor = 0.3;

    this.breathingPhase = 0;
    this.breathingRate = 0.25;
    this.breathingAmount = 0.015;

    this._headPos = new THREE.Vector3();
    this._headQuat = new THREE.Quaternion();
    this._leftHandPos = new THREE.Vector3();
    this._rightHandPos = new THREE.Vector3();
    this._leftHandQuat = new THREE.Quaternion();
    this._rightHandQuat = new THREE.Quaternion();
    this._tmpA = new THREE.Vector3();
    this._tmpB = new THREE.Vector3();
    this._tmpC = new THREE.Vector3();
    this._tmpD = new THREE.Vector3();
    this._tmpE = new THREE.Vector3();
    this._tmpF = new THREE.Vector3();
    this._tmpG = new THREE.Vector3();
    this._tmpH = new THREE.Vector3();
    this._tmpQ0 = new THREE.Quaternion();
    this._tmpQ1 = new THREE.Quaternion();
    this._tmpQ2 = new THREE.Quaternion();
    this._tmpQ3 = new THREE.Quaternion();
    this._tmpEuler = new THREE.Euler();

    this.loadModel();
  }

  loadModel() {
    const loader = new FBXLoader();
    loader.load(
      this.modelUrl,
      (fbx) => this.onModelLoaded(fbx),
      undefined,
      (error) => console.error("[VRragdoll body IK] FBX load error:", error),
    );
  }

  onModelLoaded(fbx) {
    this.modelLoaded = true;
    this.model = fbx;
    fbx.scale.set(0.01, 0.01, 0.01);
    fbx.rotation.y = Math.PI;
    this.root.add(fbx);

    fbx.traverse((node) => {
      if (node.isSkinnedMesh && node.skeleton) {
        this.skeleton = node.skeleton;
        this.skinnedMesh = node;
        this.mapBones();
        if (node.material) {
          if (Array.isArray(node.material)) {
            node.material = node.material.map((m) => {
              const c = m.clone();
              c.color.set(this.color);
              return c;
            });
          } else {
            node.material = node.material.clone();
            node.material.color.set(this.color);
          }
        }
      } else if (node.isMesh && node.material) {
        if (Array.isArray(node.material)) {
          node.material = node.material.map((m) => {
            const c = m.clone();
            c.color.set(this.color);
            return c;
          });
        } else {
          node.material = node.material.clone();
          node.material.color.set(this.color);
        }
      }
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });
  }

  mapBones() {
    this.initialBoneRotations = {};
    this.bones = {};
    this.skeleton.bones.forEach((bone) => {
      const name = bone.name;
      this.initialBoneRotations[name] = bone.quaternion.clone();
      if (name === this.boneNames.hips) this.bones.hips = bone;
      else if (name === this.boneNames.spine) this.bones.spine = bone;
      else if (name === this.boneNames.spine1) this.bones.spine1 = bone;
      else if (name === this.boneNames.spine2) this.bones.spine2 = bone;
      else if (name === this.boneNames.neck) this.bones.neck = bone;
      else if (name === this.boneNames.head) {
        this.bones.head = bone;
        if (this.hideHead) bone.scale.set(0.001, 0.001, 0.001);
      } else if (name === this.boneNames.leftShoulder) this.bones.leftShoulder = bone;
      else if (name === this.boneNames.leftArm) this.bones.leftUpperArm = bone;
      else if (name === this.boneNames.leftForeArm) this.bones.leftForearm = bone;
      else if (name === this.boneNames.leftHand) this.bones.leftHandBone = bone;
      else if (name === this.boneNames.rightShoulder) this.bones.rightShoulder = bone;
      else if (name === this.boneNames.rightArm) this.bones.rightUpperArm = bone;
      else if (name === this.boneNames.rightForeArm) this.bones.rightForearm = bone;
      else if (name === this.boneNames.rightHand) this.bones.rightHandBone = bone;
      else if (name === this.boneNames.leftUpLeg) this.bones.leftUpLeg = bone;
      else if (name === this.boneNames.leftLeg) this.bones.leftLeg = bone;
      else if (name === this.boneNames.leftFoot) this.bones.leftFoot = bone;
      else if (name === this.boneNames.rightUpLeg) this.bones.rightUpLeg = bone;
      else if (name === this.boneNames.rightLeg) this.bones.rightLeg = bone;
      else if (name === this.boneNames.rightFoot) this.bones.rightFoot = bone;
      else if (name === this.boneNames.leftHandThumb1) this.bones.leftHandThumb1 = bone;
      else if (name === this.boneNames.leftHandThumb2) this.bones.leftHandThumb2 = bone;
      else if (name === this.boneNames.leftHandThumb3) this.bones.leftHandThumb3 = bone;
      else if (name === this.boneNames.leftHandIndex1) this.bones.leftHandIndex1 = bone;
      else if (name === this.boneNames.leftHandIndex2) this.bones.leftHandIndex2 = bone;
      else if (name === this.boneNames.leftHandIndex3) this.bones.leftHandIndex3 = bone;
      else if (name === this.boneNames.leftHandMiddle1) this.bones.leftHandMiddle1 = bone;
      else if (name === this.boneNames.leftHandMiddle2) this.bones.leftHandMiddle2 = bone;
      else if (name === this.boneNames.leftHandMiddle3) this.bones.leftHandMiddle3 = bone;
      else if (name === this.boneNames.leftHandRing1) this.bones.leftHandRing1 = bone;
      else if (name === this.boneNames.leftHandRing2) this.bones.leftHandRing2 = bone;
      else if (name === this.boneNames.leftHandRing3) this.bones.leftHandRing3 = bone;
      else if (name === this.boneNames.leftHandPinky1) this.bones.leftHandPinky1 = bone;
      else if (name === this.boneNames.leftHandPinky2) this.bones.leftHandPinky2 = bone;
      else if (name === this.boneNames.leftHandPinky3) this.bones.leftHandPinky3 = bone;
      else if (name === this.boneNames.rightHandThumb1) this.bones.rightHandThumb1 = bone;
      else if (name === this.boneNames.rightHandThumb2) this.bones.rightHandThumb2 = bone;
      else if (name === this.boneNames.rightHandThumb3) this.bones.rightHandThumb3 = bone;
      else if (name === this.boneNames.rightHandIndex1) this.bones.rightHandIndex1 = bone;
      else if (name === this.boneNames.rightHandIndex2) this.bones.rightHandIndex2 = bone;
      else if (name === this.boneNames.rightHandIndex3) this.bones.rightHandIndex3 = bone;
      else if (name === this.boneNames.rightHandMiddle1) this.bones.rightHandMiddle1 = bone;
      else if (name === this.boneNames.rightHandMiddle2) this.bones.rightHandMiddle2 = bone;
      else if (name === this.boneNames.rightHandMiddle3) this.bones.rightHandMiddle3 = bone;
      else if (name === this.boneNames.rightHandRing1) this.bones.rightHandRing1 = bone;
      else if (name === this.boneNames.rightHandRing2) this.bones.rightHandRing2 = bone;
      else if (name === this.boneNames.rightHandRing3) this.bones.rightHandRing3 = bone;
      else if (name === this.boneNames.rightHandPinky1) this.bones.rightHandPinky1 = bone;
      else if (name === this.boneNames.rightHandPinky2) this.bones.rightHandPinky2 = bone;
      else if (name === this.boneNames.rightHandPinky3) this.bones.rightHandPinky3 = bone;
    });
  }

  getFallbackHands(headPos, headQuat) {
    this._leftHandPos.copy(headPos).add(this._tmpA.set(-0.24, -0.38, -0.2).applyQuaternion(headQuat));
    this._rightHandPos.copy(headPos).add(this._tmpA.set(0.24, -0.38, -0.2).applyQuaternion(headQuat));
    this._leftHandQuat.copy(headQuat);
    this._rightHandQuat.copy(headQuat);
  }

  update(opts) {
    if (!this.enabled || !opts?.active || !opts.headObject || !this.modelLoaded || !this.skeleton) {
      this.root.visible = false;
      return;
    }

    const dt = Math.max(0.0001, Math.min(opts.dtSec || 0.016, 0.1));
    this.root.visible = true;

    opts.headObject.getWorldPosition(this._headPos);
    opts.headObject.getWorldQuaternion(this._headQuat);

    if (opts.leftHandObject && opts.rightHandObject) {
      const leftHandRotationObject = opts.leftHandRotationObject || opts.leftHandObject;
      const rightHandRotationObject = opts.rightHandRotationObject || opts.rightHandObject;
      opts.leftHandObject.getWorldPosition(this._leftHandPos);
      leftHandRotationObject.getWorldQuaternion(this._leftHandQuat);
      opts.rightHandObject.getWorldPosition(this._rightHandPos);
      rightHandRotationObject.getWorldQuaternion(this._rightHandQuat);
    } else {
      this.getFallbackHands(this._headPos, this._headQuat);
    }

    if (this.previousHeadPosInitialized) {
      const newVelocity = this._tmpA.copy(this._headPos).sub(this.previousHeadPos).divideScalar(dt);
      this.headAcceleration.copy(newVelocity).sub(this.previousHeadVelocity).divideScalar(dt);
      this.headVelocity.copy(newVelocity);
      this.previousHeadVelocity.copy(newVelocity);
    } else {
      this.previousHeadPosInitialized = true;
    }
    this.previousHeadPos.copy(this._headPos);
    if (opts.velocity) this.headVelocity.copy(opts.velocity);

    this.breathingPhase += dt * this.breathingRate * Math.PI * 2;
    if (this.breathingPhase > Math.PI * 2) this.breathingPhase -= Math.PI * 2;

    this.calculateTorsoOrientation(this._headPos, this._headQuat, this._leftHandPos, this._rightHandPos, dt);
    this.calculateBodyTilt(this._headPos, this._leftHandPos, this._rightHandPos, dt);

    const desiredHipsY = this._headPos.y - 0.65;
    const modelHipsLocalY = 1.0;
    const bodyY = desiredHipsY - modelHipsLocalY;
    const backwardOffset = this._tmpA.set(0, 0, 0.15).applyQuaternion(this.torsoRotation);
    this.root.position.set(this._headPos.x + backwardOffset.x, bodyY, this._headPos.z + backwardOffset.z);
    this.root.quaternion.copy(this.torsoRotation).multiply(this.bodyTilt);

    this.updateBones(
      this._headPos,
      this._headQuat,
      this._leftHandPos,
      this._rightHandPos,
      this._leftHandQuat,
      this._rightHandQuat,
      dt,
    );
    this.updateFingerPoses(opts.leftHandObject, opts.rightHandObject);
  }

  calculateTorsoOrientation(headPos, headQuat, leftHandPos, rightHandPos, dt) {
    const headForwardFlat = this._tmpA.set(0, 0, -1).applyQuaternion(headQuat);
    headForwardFlat.y = 0;
    if (headForwardFlat.lengthSq() < 1e-5) {
      headForwardFlat.set(0, 0, -1);
    } else {
      headForwardFlat.normalize();
    }

    const shoulderLine = this._tmpB.copy(rightHandPos).sub(leftHandPos);
    shoulderLine.y = 0;
    const shoulderDist = shoulderLine.length();
    const blendedForward = this._tmpD.copy(headForwardFlat);

    if (shoulderDist >= 1e-5) {
      shoulderLine.normalize();

      const controllerForward = this._tmpC.crossVectors(shoulderLine, _WORLD_UP);
      if (controllerForward.lengthSq() >= 1e-5) {
        controllerForward.normalize();

        // Keep the controller-derived torso heading in the same hemisphere as the headset.
        // This prevents the body from snapping to face backward when the hand line gets ambiguous.
        if (controllerForward.dot(headForwardFlat) < 0) controllerForward.negate();

        // Headset yaw is the primary driver. Controllers only add a modest shoulder-line bias.
        let controllerWeight = 0.2;
        if (shoulderDist < 0.25) controllerWeight = 0.08;
        else if (shoulderDist > 0.45) controllerWeight = 0.35;

        blendedForward
          .multiplyScalar(1.0 - controllerWeight)
          .addScaledVector(controllerForward, controllerWeight);

        if (blendedForward.lengthSq() < 1e-5) blendedForward.copy(headForwardFlat);
        else blendedForward.normalize();
      }
    }

    const targetRotation = this._tmpQ0.setFromUnitVectors(this._tmpB.set(0, 0, -1), blendedForward);
    this.torsoRotation.slerp(targetRotation, this.smoothingFactor);
  }

  calculateBodyTilt() {
    this.bodyTilt.identity();
  }

  updateBones(headPos, headQuat, leftHandPos, rightHandPos, leftHandQuat, rightHandQuat, dt) {
    if (this.bones.hips) this.bones.hips.quaternion.identity();
    if (this.bones.spine) this.bones.spine.quaternion.identity();
    if (this.bones.spine1) this.bones.spine1.quaternion.identity();
    if (this.bones.spine2) this.bones.spine2.quaternion.identity();

    const bodyCenter = this._tmpA.copy(headPos);
    bodyCenter.y -= 0.5;
    const leftRelative = this._tmpB.copy(leftHandPos).sub(bodyCenter);
    const rightRelative = this._tmpC.copy(rightHandPos).sub(bodyCenter);
    const avgHandPos = this._tmpD.copy(leftRelative).add(rightRelative).multiplyScalar(0.5);

    const invTorsoRot = this._tmpQ0.copy(this.torsoRotation).invert();
    avgHandPos.applyQuaternion(invTorsoRot);
    const handForwardLean = Math.max(-0.08, Math.min(0.05, -avgHandPos.z * 0.08));
    const handSideLean = Math.max(-0.08, Math.min(0.08, avgHandPos.x * 0.1));

    const localVelocity = this._tmpB.copy(this.headVelocity).applyQuaternion(invTorsoRot);
    const targetLean = this._tmpC.set(localVelocity.z * 0.6, 0, -localVelocity.x * 0.5);
    targetLean.x = Math.max(-0.35, Math.min(0.35, targetLean.x));
    targetLean.z = Math.max(-0.3, Math.min(0.3, targetLean.z));
    this.torsoLean.x = THREE.MathUtils.lerp(this.torsoLean.x, targetLean.x, this.torsoLeanVelocity);
    this.torsoLean.y = THREE.MathUtils.lerp(this.torsoLean.y, targetLean.y, this.torsoLeanVelocity);
    this.torsoLean.z = THREE.MathUtils.lerp(this.torsoLean.z, targetLean.z, this.torsoLeanVelocity);

    const totalForwardLean = handForwardLean + this.torsoLean.x;
    const totalSideLean = handSideLean + this.torsoLean.z;
    const breathingExpansion = Math.sin(this.breathingPhase) * this.breathingAmount;

    const spineRotations = [
      { bone: this.bones.hips, amount: 1.5, breathingAmount: 0.0 },
      { bone: this.bones.spine, amount: -1.0, breathingAmount: 0.3 },
      { bone: this.bones.spine1, amount: -0.3, breathingAmount: 0.4 },
      { bone: this.bones.spine2, amount: -0.2, breathingAmount: 0.3 },
    ];
    spineRotations.forEach(({ bone, amount, breathingAmount }) => {
      if (!bone) return;
      const breathingLean = -breathingExpansion * breathingAmount;
      this._tmpEuler.set(-totalForwardLean * amount + breathingLean, 0, -totalSideLean * amount, "YXZ");
      bone.quaternion.setFromEuler(this._tmpEuler);
    });

    if (this.bones.neck) {
      const relativeHeadQuat = this._tmpQ1.copy(headQuat);
      const invBodyQuat = this._tmpQ0.copy(this.torsoRotation).invert();
      relativeHeadQuat.premultiply(invBodyQuat);
      this._tmpEuler.setFromQuaternion(relativeHeadQuat, "YXZ");
      this._tmpEuler.x = -this._tmpEuler.x;
      this._tmpEuler.z = -this._tmpEuler.z;
      this.bones.neck.quaternion.copy(this._tmpQ1.setFromEuler(this._tmpEuler));
    }

    this.solveArmIK("left", leftHandPos, leftHandQuat);
    this.solveArmIK("right", rightHandPos, rightHandQuat);
    this.updateZeroGLegs(dt);
  }

  updateZeroGLegs(dt) {
    const invTorsoRot = this._tmpQ0.copy(this.torsoRotation).invert();
    const localVel = this._tmpA.copy(this.headVelocity).applyQuaternion(invTorsoRot);
    const speed = localVel.length();
    const targetPose = { ...this.legPoses.rest };

    if (speed > 0.1) {
      const velNorm = localVel.normalize();
      const forwardAmount = Math.max(0, -velNorm.z);
      const backwardAmount = Math.max(0, velNorm.z);
      const upAmount = Math.max(0, velNorm.y);
      const downAmount = Math.max(0, -velNorm.y);
      const sidewaysAmount = Math.abs(velNorm.x);
      const directions = [
        { name: "forward", amount: forwardAmount },
        { name: "backward", amount: backwardAmount },
        { name: "up", amount: upAmount },
        { name: "down", amount: downAmount },
        { name: "sideways", amount: sidewaysAmount },
      ];
      const strongest = directions.reduce((max, d) => (d.amount > max.amount ? d : max));
      const threshold = this.currentDominantDirection === strongest.name
        ? this.directionMaintainThreshold
        : this.directionSwitchThreshold;
      if (strongest.amount > threshold || speed < 0.2) this.currentDominantDirection = strongest.name;
      if (speed < 0.2) this.currentDominantDirection = "rest";

      const poseWeights = [
        { pose: this.legPoses.forward, weight: forwardAmount * (this.currentDominantDirection === "forward" ? 1.3 : 1.0) },
        { pose: this.legPoses.backward, weight: backwardAmount * (this.currentDominantDirection === "backward" ? 1.3 : 1.0) },
        { pose: this.legPoses.up, weight: upAmount * (this.currentDominantDirection === "up" ? 1.3 : 1.0) },
        { pose: this.legPoses.down, weight: downAmount * (this.currentDominantDirection === "down" ? 1.3 : 1.0) },
        { pose: this.legPoses.sideways, weight: sidewaysAmount * (this.currentDominantDirection === "sideways" ? 1.3 : 1.0) },
      ];

      targetPose.hipFlex = 0;
      targetPose.hipSpread = 0;
      targetPose.kneeBend = 0;
      targetPose.ankleFlex = 0;
      let totalWeight = 0;
      poseWeights.forEach(({ pose, weight }) => {
        if (weight <= 0) return;
        targetPose.hipFlex += pose.hipFlex * weight;
        targetPose.hipSpread += pose.hipSpread * weight;
        targetPose.kneeBend += pose.kneeBend * weight;
        targetPose.ankleFlex += pose.ankleFlex * weight;
        totalWeight += weight;
      });
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
    }

    this.currentLegPose.hipFlex = THREE.MathUtils.lerp(this.currentLegPose.hipFlex, targetPose.hipFlex, this.legPoseBlendSpeed);
    this.currentLegPose.hipSpread = THREE.MathUtils.lerp(this.currentLegPose.hipSpread, targetPose.hipSpread, this.legPoseBlendSpeed);
    this.currentLegPose.kneeBend = THREE.MathUtils.lerp(this.currentLegPose.kneeBend, targetPose.kneeBend, this.legPoseBlendSpeed);
    this.currentLegPose.ankleFlex = THREE.MathUtils.lerp(this.currentLegPose.ankleFlex, targetPose.ankleFlex, this.legPoseBlendSpeed);

    const leftPose = { ...this.currentLegPose };
    const rightPose = { ...this.currentLegPose };
    const sidewaysVel = localVel.x;
    const sidewaysAmount = Math.abs(sidewaysVel);
    this.legIdlePhase += dt * this.legIdleRate;
    const idleInfluence = Math.max(0, 1.0 - speed * 2.0);
    const leftIdleOffset = Math.sin(this.legIdlePhase) * this.legIdleAmount * idleInfluence;
    const rightIdleOffset = Math.sin(this.legIdlePhase + Math.PI) * this.legIdleAmount * idleInfluence;
    leftPose.hipFlex += leftIdleOffset * 0.5;
    leftPose.kneeBend += leftIdleOffset;
    leftPose.ankleFlex += leftIdleOffset * 0.3;
    rightPose.hipFlex += rightIdleOffset * 0.5;
    rightPose.kneeBend += rightIdleOffset;
    rightPose.ankleFlex += rightIdleOffset * 0.3;

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
    } else {
      leftPose.ankleSway = 0;
      rightPose.ankleSway = 0;
    }

    ["hipFlex", "hipSpread", "kneeBend", "ankleFlex", "ankleSway"].forEach((prop) => {
      this.smoothedLegPose.left[prop] = THREE.MathUtils.lerp(this.smoothedLegPose.left[prop], leftPose[prop] || 0, this.legSmoothingFactor);
      this.smoothedLegPose.right[prop] = THREE.MathUtils.lerp(this.smoothedLegPose.right[prop], rightPose[prop] || 0, this.legSmoothingFactor);
    });

    this.applyLegPose("left", this.smoothedLegPose.left);
    this.applyLegPose("right", this.smoothedLegPose.right);
  }

  applyLegPose(side, pose) {
    const upLegBone = this.bones[`${side}UpLeg`];
    const legBone = this.bones[`${side}Leg`];
    const footBone = this.bones[`${side}Foot`];
    if (!upLegBone || !legBone || !footBone) return;

    const hipFlexRad = THREE.MathUtils.degToRad(pose.hipFlex);
    const hipSpreadRad = THREE.MathUtils.degToRad(pose.hipSpread) * (side === "left" ? 1 : -1);
    const kneeBendRad = THREE.MathUtils.degToRad(pose.kneeBend);
    const ankleFlexRad = THREE.MathUtils.degToRad(pose.ankleFlex);
    const ankleSwayRad = THREE.MathUtils.degToRad(pose.ankleSway || 0);
    const hipZRot = Math.PI + hipSpreadRad;
    upLegBone.rotation.set(hipFlexRad, 0, hipZRot, "XYZ");
    legBone.rotation.set(-kneeBendRad, 0, 0, "XYZ");
    footBone.rotation.set(ankleFlexRad, 0, ankleSwayRad, "XYZ");
  }

  solveArmIK(hand, handWorldPos, handWorldQuat) {
    const shoulderBone = this.bones[`${hand}Shoulder`];
    const upperArmBone = this.bones[`${hand}UpperArm`];
    const forearmBone = this.bones[`${hand}Forearm`];
    const handBone = this.bones[`${hand}HandBone`];
    if (!shoulderBone || !upperArmBone || !forearmBone) return;

    // Keep each live value on its own temp. Reusing them here corrupts
    // the target/elbow positions mid-solve and makes the forearm/wrist jitter.
    const shoulderWorldPos = this._tmpE.set(0, 0, 0);
    shoulderBone.getWorldPosition(shoulderWorldPos);

    const adjustedHandPos = this._tmpF.copy(handWorldPos);
    const leftRightOffsetWorld = this._tmpG
      .set(hand === "left" ? 0.1 : -0.1, 0, 0)
      .applyQuaternion(this.root.quaternion);
    adjustedHandPos.add(leftRightOffsetWorld);

    const shoulderToHand = this._tmpH.copy(adjustedHandPos).sub(shoulderWorldPos);
    const distance = shoulderToHand.length();
    const maxReach = (this.config.upperArmLength + this.config.lowerArmLength) * 0.999;
    const minReach = Math.abs(this.config.upperArmLength - this.config.lowerArmLength) * 1.001;
    const targetHandPos = this._tmpC.copy(adjustedHandPos);
    if (distance > maxReach) {
      targetHandPos.copy(shoulderWorldPos).add(shoulderToHand.normalize().multiplyScalar(maxReach));
    } else if (distance < minReach) {
      targetHandPos.copy(shoulderWorldPos).add(shoulderToHand.normalize().multiplyScalar(minReach));
    }

    const toTarget = this._tmpD.copy(targetHandPos).sub(shoulderWorldPos);
    const targetDist = toTarget.length();
    const toTargetDir = toTarget.normalize();
    const upperSq = this.config.upperArmLength * this.config.upperArmLength;
    const lowerSq = this.config.lowerArmLength * this.config.lowerArmLength;
    const distSq = targetDist * targetDist;
    const cosAngle = (upperSq + distSq - lowerSq) / (2 * this.config.upperArmLength * targetDist);
    const clampedCos = Math.max(-0.999, Math.min(0.999, cosAngle));
    const angle = Math.acos(clampedCos);

    const bodyRight = this._tmpA.set(1, 0, 0).applyQuaternion(this.torsoRotation);
    const bodyOutward = bodyRight.multiplyScalar(hand === "left" ? -1 : 1);
    const bendDir = this._tmpB
      .set(0, 0, 0)
      .addScaledVector(bodyOutward, 0.4)
      .addScaledVector(this._tmpA.set(0, -1, 0), 0.4)
      .normalize();
    const handUp = this._tmpG.set(0, 1, 0).applyQuaternion(handWorldQuat);
    bendDir.addScaledVector(handUp, 0.3).normalize();
    bendDir.addScaledVector(toTargetDir, -bendDir.dot(toTargetDir)).normalize();

    const elbowDir = this._tmpA
      .set(0, 0, 0)
      .addScaledVector(toTargetDir, Math.cos(angle))
      .addScaledVector(bendDir, Math.sin(angle))
      .normalize();
    const elbowWorldPos = this._tmpF.copy(shoulderWorldPos).add(elbowDir.multiplyScalar(this.config.upperArmLength));

    const shoulderToElbow = this._tmpH.copy(elbowWorldPos).sub(shoulderWorldPos);
    if (Math.abs(shoulderToElbow.length() - this.config.upperArmLength) > 0.0001) {
      elbowWorldPos.copy(shoulderWorldPos).add(shoulderToElbow.normalize().multiplyScalar(this.config.upperArmLength));
    }
    const elbowToHand = this._tmpD.copy(targetHandPos).sub(elbowWorldPos);
    if (Math.abs(elbowToHand.length() - this.config.lowerArmLength) > 0.0001) {
      targetHandPos.copy(elbowWorldPos).add(elbowToHand.normalize().multiplyScalar(this.config.lowerArmLength));
    }

    this.root.updateMatrixWorld(true);
    upperArmBone.parent.updateMatrixWorld(true);
    const shoulderInParent = upperArmBone.parent.worldToLocal(shoulderWorldPos.clone());
    const elbowInParent = upperArmBone.parent.worldToLocal(elbowWorldPos.clone());
    const upperArmParentDir = shoulderInParent.clone().sub(elbowInParent).normalize();
    const upperArmQuat = this._tmpQ0.setFromUnitVectors(_DOWN_AXIS, upperArmParentDir);
    upperArmBone.quaternion.copy(upperArmQuat);
    upperArmBone.updateMatrixWorld(true);

    forearmBone.parent.updateMatrixWorld(true);
    const elbowInUpperArm = forearmBone.parent.worldToLocal(elbowWorldPos.clone());
    const handInUpperArm = forearmBone.parent.worldToLocal(targetHandPos.clone());
    const forearmParentDir = elbowInUpperArm.clone().sub(handInUpperArm).normalize();
    const forearmQuat = this._tmpQ3.setFromUnitVectors(_DOWN_AXIS, forearmParentDir);

    forearmBone.updateMatrixWorld(true);
    const forearmWorldQuat = this._tmpQ0;
    forearmBone.getWorldQuaternion(forearmWorldQuat);
    const handRelativeForearm = this._tmpQ1.copy(handWorldQuat).premultiply(this._tmpQ2.copy(forearmWorldQuat).invert());
    const handEuler = this._tmpEuler.setFromQuaternion(handRelativeForearm, "YXZ");
    const twistAngle = handEuler.y;
    const forearmTwist = this._tmpQ0.setFromAxisAngle(this._tmpA.set(0, 1, 0), twistAngle * 0.5);
    forearmBone.quaternion.copy(forearmQuat).multiply(forearmTwist);
    forearmBone.updateMatrixWorld(true);

    if (handBone) {
      const forearmWorldQuat2 = this._tmpQ0;
      forearmBone.getWorldQuaternion(forearmWorldQuat2);
      const handLocalQuat = this._tmpQ1.copy(handWorldQuat).premultiply(this._tmpQ2.copy(forearmWorldQuat2).invert());
      const localXFlip = this._tmpQ0.setFromAxisAngle(this._tmpA.set(1, 0, 0), Math.PI);
      handLocalQuat.multiply(localXFlip);
      const rollCorrection = this._tmpQ0.setFromAxisAngle(this._tmpA.set(0, 1, 0), hand === "left" ? Math.PI / 2 : -Math.PI / 2);
      handLocalQuat.multiply(rollCorrection);
      handBone.quaternion.copy(handLocalQuat);
    }
  }

  updateFingerPoses(leftHandObject, rightHandObject) {
    const leftGamepad = leftHandObject?.userData?.xrInputSource?.gamepad;
    const rightGamepad = rightHandObject?.userData?.xrInputSource?.gamepad;
    if (leftGamepad?.buttons) {
      const trigger = leftGamepad.buttons[0]?.value || 0;
      const grip = leftGamepad.buttons[1]?.value || 0;
      let anyThumbTouch = 0;
      for (let i = 2; i <= 6; i++) {
        if (leftGamepad.buttons[i]?.touched) {
          anyThumbTouch = 1;
          break;
        }
      }
      this.updateTargetCurls("left", trigger, grip, anyThumbTouch);
    }
    if (rightGamepad?.buttons) {
      const trigger = rightGamepad.buttons[0]?.value || 0;
      const grip = rightGamepad.buttons[1]?.value || 0;
      let anyThumbTouch = 0;
      for (let i = 2; i <= 6; i++) {
        if (rightGamepad.buttons[i]?.touched) {
          anyThumbTouch = 1;
          break;
        }
      }
      this.updateTargetCurls("right", trigger, grip, anyThumbTouch);
    }

    ["left", "right"].forEach((hand) => {
      ["thumb", "index", "middle", "ring", "pinky"].forEach((finger) => {
        const current = this.currentCurls[hand][finger];
        const target = this.targetCurls[hand][finger];
        this.currentCurls[hand][finger] = current + (target - current) * this.fingerSmoothingFactor;
      });
    });
    this.applyFingerCurls("left", this.currentCurls.left);
    this.applyFingerCurls("right", this.currentCurls.right);
  }

  updateTargetCurls(hand, trigger, grip, thumbTouch) {
    const restingCurls = { thumb: 0.1, index: 0.15, middle: 0.2, ring: 0.25, pinky: 0.25 };
    const activeCurls = {
      thumb: thumbTouch * 0.8,
      index: trigger,
      middle: grip * 1.1,
      ring: grip * 1.15,
      pinky: grip * 1.2,
    };
    if (grip > 0.1 && trigger < 0.1) activeCurls.index = 0;
    const curls = {
      thumb: Math.max(restingCurls.thumb, activeCurls.thumb),
      index: Math.max(restingCurls.index, activeCurls.index),
      middle: Math.max(restingCurls.middle, activeCurls.middle),
      ring: Math.max(restingCurls.ring, activeCurls.ring),
      pinky: Math.max(restingCurls.pinky, activeCurls.pinky),
    };
    if (grip > 0.1 && trigger < 0.1) curls.index = 0.05;
    if (grip > 0.5 && thumbTouch < 0.5) curls.thumb = -0.15;
    this.targetCurls[hand] = curls;
  }

  applyFingerCurls(hand, curls) {
    const fingerBones = {
      thumb: hand === "left"
        ? [this.bones.leftHandThumb1, this.bones.leftHandThumb2, this.bones.leftHandThumb3]
        : [this.bones.rightHandThumb1, this.bones.rightHandThumb2, this.bones.rightHandThumb3],
      index: hand === "left"
        ? [this.bones.leftHandIndex1, this.bones.leftHandIndex2, this.bones.leftHandIndex3]
        : [this.bones.rightHandIndex1, this.bones.rightHandIndex2, this.bones.rightHandIndex3],
      middle: hand === "left"
        ? [this.bones.leftHandMiddle1, this.bones.leftHandMiddle2, this.bones.leftHandMiddle3]
        : [this.bones.rightHandMiddle1, this.bones.rightHandMiddle2, this.bones.rightHandMiddle3],
      ring: hand === "left"
        ? [this.bones.leftHandRing1, this.bones.leftHandRing2, this.bones.leftHandRing3]
        : [this.bones.rightHandRing1, this.bones.rightHandRing2, this.bones.rightHandRing3],
      pinky: hand === "left"
        ? [this.bones.leftHandPinky1, this.bones.leftHandPinky2, this.bones.leftHandPinky3]
        : [this.bones.rightHandPinky1, this.bones.rightHandPinky2, this.bones.rightHandPinky3],
    };

    Object.keys(fingerBones).forEach((fingerName) => {
      const bones = fingerBones[fingerName];
      const curl = curls[fingerName];
      const isThumb = fingerName === "thumb";
      const axis = isThumb ? this._tmpA.set(0, 0, 1) : this._tmpA.set(1, 0, 0);
      const sign = isThumb ? (hand === "left" ? -1 : 1) : 1;
      bones.forEach((bone, i) => {
        if (!bone) return;
        const initialRot = this.initialBoneRotations[bone.name];
        if (initialRot) bone.quaternion.copy(initialRot);
        const curlAmount = curl * (0.5 + i * 0.25);
        const curlAngle = curlAmount * Math.PI * 0.6 * sign;
        const curlQuat = this._tmpQ0.setFromAxisAngle(axis, curlAngle);
        bone.quaternion.multiply(curlQuat);
      });
    });
  }

  /**
   * IK-solved hand position (what you see), not the controller grip.
   * @param {'left' | 'right'} side
   * @param {THREE.Vector3} out
   */
  getHandWorldPosition(side, out) {
    if (!this.modelLoaded || !this.root.visible) return false;
    const bone = side === 'left' ? this.bones.leftHandBone : this.bones.rightHandBone;
    if (!bone) return false;
    this.root.updateMatrixWorld(true);
    bone.getWorldPosition(out);
    return true;
  }

  /**
   * World-space collision samples for arms, torso, legs, and finger tips.
   * @param {{ x: number, y: number, z: number, r: number }[]} out
   */
  collectCollisionSpheres(out) {
    if (!this.modelLoaded || !this.root.visible) return;
    this.root.updateMatrixWorld(true);

    /** @param {THREE.Bone | undefined} bone @param {number} r */
    const add = (bone, r) => {
      if (!bone) return;
      bone.getWorldPosition(this._tmpA);
      out.push({ x: this._tmpA.x, y: this._tmpA.y, z: this._tmpA.z, r });
    };

    add(this.bones.head, 0.17);
    add(this.bones.neck, 0.11);
    add(this.bones.spine2, 0.2);
    add(this.bones.hips, 0.22);
    add(this.bones.leftUpperArm, 0.11);
    add(this.bones.leftForearm, 0.1);
    add(this.bones.leftHandBone, 0.08);
    add(this.bones.rightUpperArm, 0.11);
    add(this.bones.rightForearm, 0.1);
    add(this.bones.rightHandBone, 0.08);
    add(this.bones.leftUpLeg, 0.12);
    add(this.bones.leftLeg, 0.1);
    add(this.bones.leftFoot, 0.09);
    add(this.bones.rightUpLeg, 0.12);
    add(this.bones.rightLeg, 0.1);
    add(this.bones.rightFoot, 0.09);

    const fingerTips = [
      this.bones.leftHandThumb3,
      this.bones.leftHandIndex3,
      this.bones.leftHandMiddle3,
      this.bones.leftHandRing3,
      this.bones.leftHandPinky3,
      this.bones.rightHandThumb3,
      this.bones.rightHandIndex3,
      this.bones.rightHandMiddle3,
      this.bones.rightHandRing3,
      this.bones.rightHandPinky3
    ];
    for (let i = 0; i < fingerTips.length; i++) {
      add(fingerTips[i], 0.03);
    }
  }

  dispose() {
    this.root.removeFromParent();
    this.root.traverse((o) => {
      if (o.isMesh) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m?.dispose?.());
        else o.material?.dispose?.();
      }
    });
  }
}

export function createBodyIkAvatar(scene, opts) {
  return new BodyIkAvatar(scene, opts);
}
