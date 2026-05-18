/**
 * NPC ragdoll ported from mattvb91/rapierjs-ragdoll (same bone names + physics layout + skin sync).
 * GLB: https://github.com/mattvb91/rapierjs-ragdoll/blob/main/public/character.glb
 */
import * as THREE from 'three';

/** @typedef {'animated' | 'ragdoll'} RagMode */

/** @type {const} */
const PART_KEYS = [
  'torso',
  'head',
  'armUpperLeft',
  'armLowerLeft',
  'armUpperRight',
  'armLowerRight',
  'thighLeft',
  'shinLeft',
  'thighRight',
  'shinRight'
];

const boneMapping = {
  head: 'head',
  torso: 'spine',
  armUpperLeft: 'upperArml',
  armUpperRight: 'upperArmr',
  armLowerLeft: 'lowerArml',
  armLowerRight: 'lowerArmr',
  thighLeft: 'hipl',
  thighRight: 'hipr',
  shinLeft: 'shinl',
  shinRight: 'shinr'
};

const torsoHeight = 0.55;
const headSize = 0.2;
const jointStiffness = 0.03;
const upperArmLength = 0.3 - jointStiffness * 2;
const lowerArmLength = 0.42 - jointStiffness * 2;
const thighLength = 0.38 - jointStiffness * 2;
const shinLength = 0.43 - jointStiffness * 2;

/** Distal bone for limb segment midpoint (collider center, not joint). */
const limbDistalBone = {
  armUpperLeft: 'lowerArml',
  armLowerLeft: null,
  armUpperRight: 'lowerArmr',
  armLowerRight: null,
  thighLeft: 'shinl',
  shinLeft: null,
  thighRight: 'shinr',
  shinRight: null
};

const limbSegmentHalf = {
  armUpperLeft: upperArmLength * 0.5,
  armLowerLeft: lowerArmLength * 0.5,
  armUpperRight: upperArmLength * 0.5,
  armLowerRight: lowerArmLength * 0.5,
  thighLeft: thighLength * 0.5,
  shinLeft: shinLength * 0.5,
  thighRight: thighLength * 0.5,
  shinRight: shinLength * 0.5
};

const GRAB_DRIVE_KP = 32;
const GRAB_DRIVE_KD = 2.4;
const GRAB_MAX_SPEED = 7;
/** Match VRrunner arrow shaft radius for hit tests. */
const ARROW_HIT_RADIUS = 0.0055;
const RAGDOLL_SETTLE_SEC = 0.65;
/** Gently pull arms toward idle; legs stay on the floor (driving legs lifts the mesh onto its toes). */
const RAGDOLL_COLLAPSE_DRIVE_SEC = 0.38;
const COLLAPSE_DRIVE_KP = 12;
const COLLAPSE_DRIVE_KD = 3;
const COLLAPSE_MAX_LINVEL = 2.2;
const COLLAPSE_DRIVE_PARTS = new Set([
  'armUpperLeft',
  'armLowerLeft',
  'armUpperRight',
  'armLowerRight'
]);

/** Approximate collider radius per ragdoll part (m). */
const PART_COLLISION_RADIUS = {
  torso: 0.26,
  head: 0.14,
  armUpperLeft: 0.11,
  armLowerLeft: 0.1,
  armUpperRight: 0.11,
  armLowerRight: 0.1,
  thighLeft: 0.12,
  shinLeft: 0.1,
  thighRight: 0.12,
  shinRight: 0.1
};

export class RagdollNPC {
  /**
   * @param {import('@dimforge/rapier3d-compat').World} world
   * @param {typeof import('@dimforge/rapier3d-compat')} RAPIER
   */
  constructor(world, RAPIER) {
    this.world = world;
    this.RAPIER = RAPIER;
    /** @type {THREE.Vector3} */
    this.spawn = new THREE.Vector3();
    /** @type {THREE.Group | null} */
    this.mesh = null;
    /** @type {THREE.AnimationMixer | null} */
    this.mixer = null;
    /** @type {THREE.AnimationAction | null} */
    this.idleAction = null;
    /** @type {Map<string, THREE.Quaternion>} */
    this.initialBoneWorldQuat = new Map();
    /** @type {RagMode} */
    this.mode = 'animated';
    /** @type {{ left: string | null, right: string | null }} */
    this.grabbedPart = { left: null, right: null };
    this._spawnMeshPos = new THREE.Vector3();
    this._spawnMeshQuat = new THREE.Quaternion();
    /** @type {Map<string, { position: THREE.Vector3, quaternion: THREE.Quaternion }>} */
    this._restBoneLocal = new Map();
    /** Grab point in rigid-body local space (stays on the limb when it rotates). */
    /** @type {{ left: THREE.Vector3 | null, right: THREE.Vector3 | null }} */
    this.grabAnchorLocal = { left: null, right: null };
    this._v = new THREE.Vector3();
    this._grabScratchPos = new THREE.Vector3();
    this._grabScratchVel = new THREE.Vector3();
    this._grabTarget = new THREE.Vector3();
    this._boneWorldPos = new THREE.Vector3();
    this._boneWorldQuat = new THREE.Quaternion();
    this._bodyPos = new THREE.Vector3();
    this._bodyQuat = new THREE.Quaternion();
    this._offset = new THREE.Vector3();
    this._tailWorld = new THREE.Vector3();
    this._invInitialQuat = new THREE.Quaternion();
    this._settleTimer = 0;
    this._collapseDriveTimer = 0;

    /** @type {Record<string, import('@dimforge/rapier3d-compat').RigidBody>} */
    this._bodies = {};
  }

  /**
   * @param {THREE.Group} sceneRoot
   * @param {THREE.Group} gltfScene
   * @param {THREE.AnimationClip[]} clips
   * @param {number} [npcZ=-1.25] — world Z (Three.js forward is −Z)
   * @param {number} [floorY=0] — world Y for feet after ground snap
   */
  attachFromGLTF(sceneRoot, gltfScene, clips, npcZ = -1.25, floorY = 0) {
    this.mesh = gltfScene;
    this.mesh.position.set(0, 0, npcZ);
    sceneRoot.add(this.mesh);

    gltfScene.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
      }
    });

    const box = new THREE.Box3().setFromObject(this.mesh);
    this.mesh.position.y += -box.min.y + floorY + 0.02;
    this.mesh.updateMatrixWorld(true);

    const spine = this.mesh.getObjectByName('spine');
    if (!spine) {
      throw new Error('character.glb missing spine bone');
    }
    spine.getWorldPosition(this.spawn);

    if (clips.length > 0) {
      this.mixer = new THREE.AnimationMixer(gltfScene);
      this.idleAction = this.mixer.clipAction(clips[0]);
      this.idleAction.reset().setLoop(THREE.LoopRepeat).play();
    }

    const boneNames = new Set(Object.values(boneMapping));
    const walk = (object) => {
      if (boneNames.has(object.name)) {
        const quat = new THREE.Quaternion();
        object.getWorldQuaternion(quat);
        this.initialBoneWorldQuat.set(object.name, quat.clone());
      }
      for (const c of object.children) walk(c);
    };
    this.mesh.updateMatrixWorld(true);
    walk(this.mesh);

    this.mesh.rotation.y = Math.PI;

    this._createRagdoll();
    this.setMode('animated');
    if (this.mixer) {
      this.mixer.setTime(0);
      this.mixer.update(0);
    }
    this.mesh.updateMatrixWorld(true);
    this._captureRestPose();
    this._captureSpawnPose();
  }

  _captureRestPose() {
    if (!this.mesh) return;
    this._restBoneLocal.clear();
    for (const boneName of Object.values(boneMapping)) {
      const bone = this.mesh.getObjectByName(boneName);
      if (!bone) continue;
      this._restBoneLocal.set(boneName, {
        position: bone.position.clone(),
        quaternion: bone.quaternion.clone()
      });
    }
  }

  _restoreRestPose() {
    if (!this.mesh) return;
    for (const [boneName, rest] of this._restBoneLocal) {
      const bone = this.mesh.getObjectByName(boneName);
      if (!bone) continue;
      bone.position.copy(rest.position);
      bone.quaternion.copy(rest.quaternion);
    }
    this.mesh.updateMatrixWorld(true);
  }

  _captureSpawnPose() {
    if (!this.mesh) return;
    this._spawnMeshPos.copy(this.mesh.position);
    this._spawnMeshQuat.copy(this.mesh.quaternion);
    const spine = this.mesh.getObjectByName('spine');
    if (spine) spine.getWorldPosition(this.spawn);
  }

  /** Standing idle at initial placement; clears grabs and physics drift. */
  resetToSpawn() {
    if (!this.mesh) return;
    this.releaseAllGrabs();

    this.mesh.position.copy(this._spawnMeshPos);
    this.mesh.quaternion.copy(this._spawnMeshQuat);
    this._restoreRestPose();

    if (this.mixer && this.idleAction) {
      this.idleAction.stop();
      this.idleAction.reset();
      this.idleAction.setEffectiveWeight(1);
      this.idleAction.play();
      this.mixer.setTime(0);
      this.mixer.update(0);
    }
    this.mesh.updateMatrixWorld(true);

    const wasRagdoll = this.mode === 'ragdoll';
    this.mode = 'animated';
    for (const k of PART_KEYS) {
      const rb = this._bodies[k];
      if (!rb) continue;
      rb.setEnabled(true);
      rb.setBodyType(this.RAPIER.RigidBodyType.KinematicPositionBased, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.syncRigidBodiesFromBones();
    if (wasRagdoll && this.idleAction) {
      this.idleAction.play();
    }
  }

  releaseAllGrabs() {
    const parts = new Set();
    if (this.grabbedPart.left) parts.add(this.grabbedPart.left);
    if (this.grabbedPart.right) parts.add(this.grabbedPart.right);
    this.grabbedPart.left = null;
    this.grabbedPart.right = null;
    this.grabAnchorLocal.left = null;
    this.grabAnchorLocal.right = null;
    for (const k of parts) {
      this._releasePartPhysicsIfIdle(k);
    }
  }

  _createRagdoll() {
    const R = this.RAPIER;
    const s = this.spawn;
    const stiffness = 0.03;
    const density = 0.16;
    const torsoWidth = 0.4;
    const tx = s.x;
    const ty = s.y;
    const tz = s.z;

    const torsoDesc = R.ColliderDesc.cuboid(torsoWidth / 2, torsoHeight / 2, 0.1);
    const torsoBodyDesc = R.RigidBodyDesc.dynamic().setTranslation(tx, ty, tz);
    this._bodies.torso = this.world.createRigidBody(torsoBodyDesc);
    this.world.createCollider(torsoDesc, this._bodies.torso).setDensity(density);

    const headDesc = R.ColliderDesc.cuboid(headSize / 2, headSize / 2, headSize / 2);
    const headBodyDesc = R.RigidBodyDesc.dynamic().setTranslation(
      tx,
      ty + headSize / 2 + torsoHeight / 2 + stiffness,
      tz
    );
    this._bodies.head = this.world.createRigidBody(headBodyDesc);
    this.world.createCollider(headDesc, this._bodies.head).setDensity(density);

    const armThickness = 0.15;
    const armUpperRDesc = R.ColliderDesc.cuboid(upperArmLength / 2, armThickness / 2, armThickness / 2);
    const armUpperRBodyDesc = R.RigidBodyDesc.dynamic().setTranslation(tx + torsoWidth + stiffness, ty + 0.1, tz);
    this._bodies.armUpperRight = this.world.createRigidBody(armUpperRBodyDesc);
    this.world.createCollider(armUpperRDesc, this._bodies.armUpperRight).setDensity(density);

    const armLowerRDesc = R.ColliderDesc.cuboid(lowerArmLength / 2, armThickness / 2, armThickness / 2);
    const armLowerRBodyDesc = R.RigidBodyDesc.dynamic().setTranslation(
      tx + torsoWidth + lowerArmLength + stiffness * 2,
      ty + 0.1,
      tz
    );
    this._bodies.armLowerRight = this.world.createRigidBody(armLowerRBodyDesc);
    this.world.createCollider(armLowerRDesc, this._bodies.armLowerRight).setDensity(density);

    const armUpperLDesc = R.ColliderDesc.cuboid(upperArmLength / 2, armThickness / 2, armThickness / 2);
    const armUpperLBodyDesc = R.RigidBodyDesc.dynamic().setTranslation(tx - torsoWidth - stiffness, ty + 0.1, tz);
    this._bodies.armUpperLeft = this.world.createRigidBody(armUpperLBodyDesc);
    this.world.createCollider(armUpperLDesc, this._bodies.armUpperLeft).setDensity(density);

    const armLowerLDesc = R.ColliderDesc.cuboid(lowerArmLength / 2, armThickness / 2, armThickness / 2);
    const armLowerLBodyDesc = R.RigidBodyDesc.dynamic().setTranslation(
      tx - torsoWidth - lowerArmLength - stiffness * 2,
      ty + 0.1,
      tz
    );
    this._bodies.armLowerLeft = this.world.createRigidBody(armLowerLBodyDesc);
    this.world.createCollider(armLowerLDesc, this._bodies.armLowerLeft).setDensity(density);

    const legthickness = 0.18;
    const legUpperRDesc = R.ColliderDesc.cuboid(legthickness / 2, thighLength / 2, legthickness / 2);
    const legUpperRBodyDesc = R.RigidBodyDesc.dynamic().setTranslation(
      tx + torsoWidth / 2 - 0.1,
      torsoBodyDesc.translation.y - torsoHeight / 2 - thighLength / 2 - stiffness,
      tz
    );
    this._bodies.thighRight = this.world.createRigidBody(legUpperRBodyDesc);
    this.world.createCollider(legUpperRDesc, this._bodies.thighRight).setDensity(density);

    const legLowerRDesc = R.ColliderDesc.cuboid(legthickness / 2, shinLength / 2, legthickness / 2);
    const legLowerRBodyDesc = R.RigidBodyDesc.dynamic().setTranslation(
      legUpperRBodyDesc.translation.x,
      legUpperRBodyDesc.translation.y - shinLength - stiffness,
      tz
    );
    this._bodies.shinRight = this.world.createRigidBody(legLowerRBodyDesc);
    this.world.createCollider(legLowerRDesc, this._bodies.shinRight).setDensity(density);

    const legUpperLDesc = R.ColliderDesc.cuboid(legthickness / 2, thighLength / 2, legthickness / 2);
    const legUpperLBodyDesc = R.RigidBodyDesc.dynamic().setTranslation(
      tx - torsoWidth / 2 + 0.1,
      torsoBodyDesc.translation.y - torsoHeight / 2 - thighLength / 2 - stiffness,
      tz
    );
    this._bodies.thighLeft = this.world.createRigidBody(legUpperLBodyDesc);
    this.world.createCollider(legUpperLDesc, this._bodies.thighLeft).setDensity(density);

    const legLowerLDesc = R.ColliderDesc.cuboid(legthickness / 2, shinLength / 2, legthickness / 2);
    const legLowerLBodyDesc = R.RigidBodyDesc.dynamic().setTranslation(
      legUpperLBodyDesc.translation.x,
      legUpperLBodyDesc.translation.y - shinLength - stiffness,
      tz
    );
    this._bodies.shinLeft = this.world.createRigidBody(legLowerLBodyDesc);
    this.world.createCollider(legLowerLDesc, this._bodies.shinLeft).setDensity(density);

    const localAnchorHead = { x: 0, y: -headSize / 2 - stiffness, z: 0 };
    const localAnchorNeck = { x: 0, y: torsoHeight / 2, z: 0 };
    const localAnchorRTorso = { x: torsoWidth / 2 + stiffness, y: torsoWidth / 2, z: 0 };
    const localAnchorRArm = { x: -upperArmLength / 2, y: 0, z: 0 };
    const localAnchorRArmBottom = { x: upperArmLength / 2 + stiffness, y: 0, z: 0 };
    const localAnchorRArmLower = { x: -lowerArmLength / 2, y: 0, z: 0 };
    const localAnchorLTorso = { x: -(torsoWidth / 2) - stiffness, y: torsoWidth / 2, z: 0 };
    const localAnchorLArm = { x: upperArmLength / 2, y: 0, z: 0 };
    const localAnchorLArmBottom = { x: -(upperArmLength / 2) - stiffness, y: 0, z: 0 };
    const localAnchorLArmLower = { x: lowerArmLength / 2, y: 0, z: 0 };
    const localAnchorRTorsoBottom = { x: torsoWidth / 2 - legthickness / 2, y: -torsoHeight / 2 - stiffness, z: 0 };
    const localAnchorRLegUpper = { x: 0, y: thighLength / 2, z: 0 };
    const localAnchorLTorsoBottom = { x: -(torsoWidth / 2) + legthickness / 2, y: -torsoHeight / 2 - stiffness, z: 0 };
    const localAnchorLLegUpper = { x: 0, y: thighLength / 2, z: 0 };
    const localAnchorRLegUpperLower = { x: 0, y: -shinLength / 2 - stiffness, z: 0 };
    const localAnchorRLegLowerTop = { x: 0, y: shinLength / 2, z: 0 };
    const localAnchorLLegUpperLower = { x: 0, y: -shinLength / 2 - stiffness, z: 0 };
    const localAnchorLLegLowerTop = { x: 0, y: shinLength / 2, z: 0 };

    const j = (a1, a2, b1, b2) => {
      this.world.createImpulseJoint(R.JointData.spherical(a1, a2), b1, b2, true);
    };
    j(localAnchorHead, localAnchorNeck, this._bodies.head, this._bodies.torso);
    j(localAnchorRTorso, localAnchorRArm, this._bodies.torso, this._bodies.armUpperRight);
    j(localAnchorRArmBottom, localAnchorRArmLower, this._bodies.armUpperRight, this._bodies.armLowerRight);
    j(localAnchorLTorso, localAnchorLArm, this._bodies.torso, this._bodies.armUpperLeft);
    j(localAnchorLArmBottom, localAnchorLArmLower, this._bodies.armUpperLeft, this._bodies.armLowerLeft);
    j(localAnchorLTorsoBottom, localAnchorLLegUpper, this._bodies.torso, this._bodies.thighLeft);
    j(localAnchorRTorsoBottom, localAnchorRLegUpper, this._bodies.torso, this._bodies.thighRight);
    j(localAnchorRLegUpperLower, localAnchorRLegLowerTop, this._bodies.thighRight, this._bodies.shinRight);
    j(localAnchorLLegUpperLower, localAnchorLLegLowerTop, this._bodies.thighLeft, this._bodies.shinLeft);
  }

  /** @param {string} key */
  getBody(key) {
    return this._bodies[key];
  }

  get bodies() {
    return new Map(Object.entries(this._bodies));
  }

  /**
   * Animated bone world pose → rigid-body center + rotation (inverse of syncBonesFromPhysics).
   * @param {string} key
   * @param {THREE.Bone} bone
   * @param {THREE.Vector3} outPos
   * @param {THREE.Quaternion} outQuat
   */
  _boneWorldToBodyPose(key, bone, outPos, outQuat) {
    bone.getWorldPosition(this._boneWorldPos);
    bone.getWorldQuaternion(this._boneWorldQuat);

    const boneName = boneMapping[key];
    const initialQuat = this.initialBoneWorldQuat.get(boneName);
    outQuat.copy(this._boneWorldQuat);
    if (initialQuat) {
      this._invInitialQuat.copy(initialQuat).invert();
      outQuat.multiply(this._invInitialQuat);
    }

    if (key === 'torso') {
      outPos.copy(this._boneWorldPos);
      this._offset.set(0, torsoHeight / 2, 0).applyQuaternion(outQuat);
      outPos.add(this._offset);
      return;
    }
    if (key === 'head') {
      outPos.copy(this._boneWorldPos);
      this._offset.set(0, headSize / 2 + jointStiffness, 0).applyQuaternion(outQuat);
      outPos.sub(this._offset);
      return;
    }

    const distalName = limbDistalBone[key];
    const distal = distalName ? this.mesh.getObjectByName(distalName) : null;
    if (distal) {
      distal.getWorldPosition(this._tailWorld);
      outPos.copy(this._boneWorldPos).add(this._tailWorld).multiplyScalar(0.5);
      return;
    }

    const half = limbSegmentHalf[key] || 0.15;
    this._offset.set(0, -half, 0).applyQuaternion(this._boneWorldQuat);
    outPos.copy(this._boneWorldPos).add(this._offset);
  }

  _zeroAllBodyVelocities() {
    for (const k of PART_KEYS) {
      const rb = this._bodies[k];
      if (!rb) continue;
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  isCollapseDriving() {
    return this.mode === 'ragdoll' && this._collapseDriveTimer > 0;
  }

  _beginRagdollSettle() {
    this._settleTimer = RAGDOLL_SETTLE_SEC;
    for (const k of PART_KEYS) {
      const rb = this._bodies[k];
      if (!rb) continue;
      rb.setLinearDamping(2.2);
      rb.setAngularDamping(2.8);
    }
    this._zeroAllBodyVelocities();
  }

  /** Pull bodies toward animated bone targets so collapse is visible frame-by-frame. */
  _applyCollapseDrive(dt) {
    if (this.anyGrabActive || this._collapseDriveTimer <= 0 || !this.mesh) return;

    const wasDriving = this._collapseDriveTimer > 0;
    this._collapseDriveTimer = Math.max(0, this._collapseDriveTimer - dt);
    const weight = this._collapseDriveTimer / RAGDOLL_COLLAPSE_DRIVE_SEC;
    if (wasDriving && this._collapseDriveTimer <= 0 && this.idleAction) {
      this.idleAction.stop();
    }
    if (weight <= 0) return;

    this.mesh.updateMatrixWorld(true);
    for (const key of COLLAPSE_DRIVE_PARTS) {
      const rb = this._bodies[key];
      const bn = boneMapping[key];
      const bone = this.mesh.getObjectByName(bn);
      if (!rb || !bone) continue;

      this._boneWorldToBodyPose(key, bone, this._grabTarget, this._bodyQuat);
      const t = rb.translation();
      const lv = rb.linvel();
      let vx = (this._grabTarget.x - t.x) * COLLAPSE_DRIVE_KP * weight - lv.x * COLLAPSE_DRIVE_KD * weight;
      let vy = (this._grabTarget.y - t.y) * COLLAPSE_DRIVE_KP * weight - lv.y * COLLAPSE_DRIVE_KD * weight;
      let vz = (this._grabTarget.z - t.z) * COLLAPSE_DRIVE_KP * weight - lv.z * COLLAPSE_DRIVE_KD * weight;
      const speed = Math.hypot(vx, vy, vz);
      if (speed > COLLAPSE_MAX_LINVEL) {
        const s = COLLAPSE_MAX_LINVEL / speed;
        vx *= s;
        vy *= s;
        vz *= s;
      }
      rb.setLinvel({ x: vx, y: vy, z: vz }, true);
    }
  }

  /** Collapse drive + settle damping. */
  prePhysicsStep(dt) {
    if (this.mode !== 'ragdoll') return;

    this._applyCollapseDrive(dt);

    if (this._settleTimer <= 0) return;
    this._settleTimer = Math.max(0, this._settleTimer - dt);
    const blend = this._settleTimer / RAGDOLL_SETTLE_SEC;
    const linD = THREE.MathUtils.lerp(0.35, 2.2, blend);
    const angD = THREE.MathUtils.lerp(0.45, 2.8, blend);
    for (const k of PART_KEYS) {
      const rb = this._bodies[k];
      if (!rb) continue;
      rb.setLinearDamping(linD);
      rb.setAngularDamping(angD);
    }
  }

  _activateRagdollFromPose() {
    if (!this.mesh || this.mode === 'ragdoll') return;
    this.mesh.updateMatrixWorld(true);
    this.syncRigidBodiesFromBones();
    this.mode = 'ragdoll';
    this._collapseDriveTimer = RAGDOLL_COLLAPSE_DRIVE_SEC;

    for (const k of PART_KEYS) {
      const rb = this._bodies[k];
      if (!rb) continue;
      rb.setEnabled(true);
      rb.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
    }
    this._beginRagdollSettle();

    if (this.idleAction && !this.idleAction.isRunning()) {
      this.idleAction.reset().fadeIn(0.05).play();
    }
  }

  /**
   * @param {THREE.Vector3} target
   * @param {THREE.Vector3} handVel
   */
  _applyGrabDriveVelocity(rb, target, handVel) {
    const t = rb.translation();
    let vx = (target.x - t.x) * GRAB_DRIVE_KP + handVel.x * GRAB_DRIVE_KD;
    let vy = (target.y - t.y) * GRAB_DRIVE_KP + handVel.y * GRAB_DRIVE_KD;
    let vz = (target.z - t.z) * GRAB_DRIVE_KP + handVel.z * GRAB_DRIVE_KD;
    const speed = Math.hypot(vx, vy, vz);
    if (speed > GRAB_MAX_SPEED) {
      const s = GRAB_MAX_SPEED / speed;
      vx *= s;
      vy *= s;
      vz *= s;
    }
    rb.setLinvel({ x: vx, y: vy, z: vz }, true);
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /**
   * @param {RagMode} mode
   */
  setMode(mode) {
    const wasRagdoll = this.mode === 'ragdoll';

    if (mode === 'ragdoll') {
      this._activateRagdollFromPose();
    } else {
      this.mode = mode;
      this._settleTimer = 0;
      this._collapseDriveTimer = 0;
      for (const k of PART_KEYS) {
        const rb = this._bodies[k];
        if (!rb) continue;
        rb.setEnabled(true);
        rb.setBodyType(this.RAPIER.RigidBodyType.KinematicPositionBased, true);
        rb.setLinearDamping(0);
        rb.setAngularDamping(0);
        rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
        rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    }

    if (mode === 'animated' && wasRagdoll && this.idleAction) {
      this.idleAction.reset().fadeIn(0.2).play();
    }
    this.releaseAllGrabs();
  }

  /** Animated → ragdoll without clearing per-hand grabs (used when starting a grab). */
  _enterRagdollFromInteraction() {
    this._activateRagdollFromPose();
  }

  syncRigidBodiesFromBones() {
    if (!this.mesh) return;
    this.mesh.updateMatrixWorld(true);
    for (const key of PART_KEYS) {
      const rb = this._bodies[key];
      const bn = boneMapping[key];
      const bone = this.mesh.getObjectByName(bn);
      if (!rb || !bone) continue;
      this._boneWorldToBodyPose(key, bone, this._bodyPos, this._bodyQuat);
      rb.setTranslation({ x: this._bodyPos.x, y: this._bodyPos.y, z: this._bodyPos.z }, true);
      rb.setRotation(
        { x: this._bodyQuat.x, y: this._bodyQuat.y, z: this._bodyQuat.z, w: this._bodyQuat.w },
        true
      );
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  stepKinematicBodies() {
    if (this.mode !== 'animated' || !this.mesh) return;
    this.mesh.updateMatrixWorld(true);
    for (const key of PART_KEYS) {
      const rb = this._bodies[key];
      const bn = boneMapping[key];
      const bone = this.mesh.getObjectByName(bn);
      if (!rb || !bone) continue;
      this._boneWorldToBodyPose(key, bone, this._bodyPos, this._bodyQuat);
      rb.setNextKinematicTranslation({ x: this._bodyPos.x, y: this._bodyPos.y, z: this._bodyPos.z });
      rb.setNextKinematicRotation({
        x: this._bodyQuat.x,
        y: this._bodyQuat.y,
        z: this._bodyQuat.z,
        w: this._bodyQuat.w
      });
    }
  }

  /** Same update order as reference Ragdoll.ts */
  syncBonesFromPhysics() {
    if (this.mode !== 'ragdoll' || !this.mesh) return;
    this.mesh.updateMatrixWorld(true);

    const orderedKeys = [
      'torso',
      'head',
      'armUpperLeft',
      'armLowerLeft',
      'armUpperRight',
      'armLowerRight',
      'thighLeft',
      'shinLeft',
      'thighRight',
      'shinRight'
    ];

    for (const key of orderedKeys) {
      const boneName = boneMapping[key];
      const bone = this.mesh.getObjectByName(boneName);
      const body = this._bodies[key];
      if (!bone || !body) continue;

      const parent = bone.parent;
      if (!parent) continue;

      const rotation = body.rotation();
      const bodyQuat = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);

      if (key === 'torso') {
        const t = body.translation();
        const offset = new THREE.Vector3(0, -torsoHeight / 2, 0).applyQuaternion(bodyQuat);
        const bodyPos = new THREE.Vector3(t.x + offset.x, t.y + offset.y, t.z + offset.z);
        parent.worldToLocal(bodyPos);
        bone.position.copy(bodyPos);
      }

      const parentQuat = new THREE.Quaternion();
      parent.getWorldQuaternion(parentQuat);

      const initialQuat = this.initialBoneWorldQuat.get(boneName);
      const targetWorld = initialQuat ? bodyQuat.clone().multiply(initialQuat) : bodyQuat.clone();

      bone.quaternion.copy(parentQuat.clone().invert()).multiply(targetWorld);
      bone.updateMatrixWorld(true);
    }
  }

  /**
   * @param {THREE.Vector3} point
   * @param {number} [maxDist=0.65]
   * @returns {{ key: string, dist: number } | null}
   */
  probeGrabPart(point, maxDist = 0.65) {
    if (!this.mesh) return null;
    this.mesh.updateMatrixWorld(true);
    let best = null;
    let bestD = maxDist;
    for (const key of PART_KEYS) {
      const rb = this._bodies[key];
      let d = maxDist;
      if (rb) {
        const t = rb.translation();
        this._v.set(t.x, t.y, t.z);
        const r = PART_COLLISION_RADIUS[key] || 0.12;
        d = Math.max(0, point.distanceTo(this._v) - r);
      } else {
        const bn = boneMapping[key];
        const bone = this.mesh.getObjectByName(bn);
        if (!bone) continue;
        bone.getWorldPosition(this._v);
        d = point.distanceTo(this._v);
      }
      if (d < bestD) {
        bestD = d;
        best = key;
      }
    }
    return best ? { key: best, dist: bestD } : null;
  }

  findClosestPartKey(point, maxDist = 0.65) {
    return this.probeGrabPart(point, maxDist)?.key ?? null;
  }

  /**
   * Ray vs ragdoll part spheres (no impulse).
   * @returns {{ t: number, point: THREE.Vector3, key: string } | null}
   */
  probeArrowSegmentHit(origin, dir, maxDist) {
    if (!this.mesh) return null;
    let bestT = maxDist + 1;
    let bestKey = null;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;

    for (const key of PART_KEYS) {
      const rb = this._bodies[key];
      if (!rb) continue;
      const t = rb.translation();
      const r = (PART_COLLISION_RADIUS[key] || 0.12) + ARROW_HIT_RADIUS;
      const cx = t.x - ox;
      const cy = t.y - oy;
      const cz = t.z - oz;
      const b = cx * dx + cy * dy + cz * dz;
      const c = cx * cx + cy * cy + cz * cz - r * r;
      const disc = b * b - c;
      if (disc < 0) continue;
      const sqrtD = Math.sqrt(disc);
      let hitT = -b - sqrtD;
      if (hitT < 0) hitT = -b + sqrtD;
      if (hitT < 0 || hitT > maxDist) continue;
      if (hitT < bestT) {
        bestT = hitT;
        bestKey = key;
      }
    }

    if (!bestKey) return null;
    this._grabTarget.set(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
    return { t: bestT, point: this._grabTarget.clone(), key: bestKey };
  }

  /**
   * Ray vs ragdoll part spheres along arrow segment (for VRrunner archery).
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} dir — unit
   * @param {number} maxDist
   * @param {number} speed
   * @returns {{ t: number, point: THREE.Vector3 } | null}
   */
  testArrowSegmentHit(origin, dir, maxDist, speed) {
    const probe = this.probeArrowSegmentHit(origin, dir, maxDist);
    if (!probe) return null;
    this.applyArrowHit(probe.key, dir, speed, probe.point);
    return { t: probe.t, point: probe.point };
  }

  /** @returns {{ y: number, vy: number, x: number, z: number } | null} */
  getTorsoMotion() {
    const rb = this._bodies.torso;
    if (!rb) return null;
    const t = rb.translation();
    const lv = rb.linvel();
    return { y: t.y, vy: lv.y, x: t.x, z: t.z };
  }

  /**
   * @param {string} partKey
   * @param {THREE.Vector3} dir — unit, arrow flight direction
   * @param {number} speed — m/s at impact
   * @param {THREE.Vector3} point — world impact
   */
  _clampAllBodyLinvel(maxSpeed) {
    for (const key of PART_KEYS) {
      const rb = this._bodies[key];
      if (!rb) continue;
      const lv = rb.linvel();
      const sp = Math.hypot(lv.x, lv.y, lv.z);
      if (sp > maxSpeed) {
        const s = maxSpeed / sp;
        rb.setLinvel({ x: lv.x * s, y: lv.y * s, z: lv.z * s }, true);
      }
    }
  }

  applyArrowHit(partKey, dir, speed, point) {
    const rb = this._bodies[partKey];
    if (!rb) return;
    if (this.mode === 'animated') {
      this._enterRagdollFromInteraction();
    }
    if (this.mode !== 'ragdoll') return;

    rb.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
    const dV = THREE.MathUtils.clamp(speed * 0.011, 0.3, 1.05);
    const lv = rb.linvel();
    rb.setLinvel(
      { x: lv.x + dir.x * dV, y: lv.y + dir.y * dV, z: lv.z + dir.z * dV },
      true
    );
    this._clampAllBodyLinvel(3.2);
    this._settleTimer = Math.max(this._settleTimer, 0.2);
  }

  /**
   * Explosive arrow blast (VRrunner-style radial push on all parts).
   * @param {THREE.Vector3} center
   * @param {number} radius
   * @param {number} push — peak m/s knockback scale from runner
   */
  applyExplosion(center, radius, push) {
    if (this.mode === 'animated') {
      this._enterRagdollFromInteraction();
    }
    if (this.mode !== 'ragdoll') return;

    const cx = center.x;
    const cy = center.y;
    const cz = center.z;
    const r2 = radius * radius;

    for (const key of PART_KEYS) {
      const rb = this._bodies[key];
      if (!rb) continue;
      const t = rb.translation();
      const dx = t.x - cx;
      const dy = t.y - cy;
      const dz = t.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 0.001;
      const falloff = 1 - d / radius;
      const mag = push * falloff * 0.1;
      rb.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
      const lv = rb.linvel();
      rb.setLinvel(
        {
          x: lv.x + (dx / d) * mag,
          y: lv.y + (dy / d) * mag + mag * 0.06,
          z: lv.z + (dz / d) * mag
        },
        true
      );
    }
    this._clampAllBodyLinvel(3.5);
    this._settleTimer = Math.max(this._settleTimer, 0.35);
  }

  /**
   * Body translation so the grab point (local anchor) sits at handPos.
   * @param {THREE.Vector3} handPos
   * @param {import('@dimforge/rapier3d-compat').RigidBody} rb
   * @param {THREE.Vector3} anchorLocal
   * @param {THREE.Vector3} out
   */
  _bodyTranslationForHand(handPos, rb, anchorLocal, out) {
    const r = rb.rotation();
    this._bodyQuat.set(r.x, r.y, r.z, r.w);
    this._offset.copy(anchorLocal).applyQuaternion(this._bodyQuat);
    out.set(handPos.x - this._offset.x, handPos.y - this._offset.y, handPos.z - this._offset.z);
  }

  /**
   * @param {'left' | 'right'} hand
   * @param {string} partKey
   * @param {THREE.Vector3} handPos
   */
  _bindGrabAnchor(hand, partKey, handPos) {
    const rb = this._bodies[partKey];
    if (!rb) return;
    const t = rb.translation();
    const r = rb.rotation();
    this._bodyQuat.set(r.x, r.y, r.z, r.w);
    this._invInitialQuat.copy(this._bodyQuat).invert();

    let local = this.grabAnchorLocal[hand];
    if (!local) {
      local = new THREE.Vector3();
      this.grabAnchorLocal[hand] = local;
    }
    this._offset.set(handPos.x - t.x, handPos.y - t.y, handPos.z - t.z);
    local.copy(this._offset).applyQuaternion(this._invInitialQuat);

    rb.setBodyType(this.RAPIER.RigidBodyType.KinematicPositionBased, true);
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  _releasePartPhysicsIfIdle(partKey) {
    if (!partKey || this.mode !== 'ragdoll') return;
    if (this.grabbedPart.left === partKey || this.grabbedPart.right === partKey) return;
    const rb = this._bodies[partKey];
    if (!rb) return;
    rb.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
  }

  /** @param {'left' | 'right'} hand */
  _driveGrabbedBody(partKey, handPos, handVel, hand) {
    const rb = this._bodies[partKey];
    if (!rb || this.mode !== 'ragdoll') return;
    const anchorLocal = this.grabAnchorLocal[hand];
    if (!anchorLocal) return;

    this._bodyTranslationForHand(handPos, rb, anchorLocal, this._grabTarget);

    const rot = rb.rotation();
    rb.setNextKinematicTranslation({
      x: this._grabTarget.x,
      y: this._grabTarget.y,
      z: this._grabTarget.z
    });
    rb.setNextKinematicRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w });
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
    rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /**
   * @param {{ left?: { pos: THREE.Vector3, vel: THREE.Vector3 }, right?: { pos: THREE.Vector3, vel: THREE.Vector3 }} | null} hands
   */
  stepGrabs(hands) {
    if (this.mode !== 'ragdoll' || !hands) return;

    /** @type {Record<string, { side: 'left' | 'right', pos: THREE.Vector3, vel: THREE.Vector3 }[]>} */
    const byPart = {};
    for (const side of ['left', 'right']) {
      const partKey = this.grabbedPart[side];
      const h = hands[side];
      if (!partKey || !h) continue;
      if (!byPart[partKey]) byPart[partKey] = [];
      byPart[partKey].push({ side, pos: h.pos, vel: h.vel });
    }

    for (const partKey of Object.keys(byPart)) {
      const list = byPart[partKey];
      if (list.length === 1) {
        const { side, pos, vel } = list[0];
        this._driveGrabbedBody(partKey, pos, vel, side);
        continue;
      }

      const rb = this._bodies[partKey];
      if (!rb) continue;
      const t = rb.translation();
      let tx = 0;
      let ty = 0;
      let tz = 0;
      let vx = 0;
      let vy = 0;
      let vz = 0;
      for (let i = 0; i < list.length; i++) {
        const { side, pos } = list[i];
        const anchorLocal = this.grabAnchorLocal[side];
        if (anchorLocal) {
          this._bodyTranslationForHand(pos, rb, anchorLocal, this._grabScratchPos);
          tx += this._grabScratchPos.x;
          ty += this._grabScratchPos.y;
          tz += this._grabScratchPos.z;
        } else {
          tx += pos.x;
          ty += pos.y;
          tz += pos.z;
        }
      }
      const inv = 1 / list.length;
      this._grabTarget.set(tx * inv, ty * inv, tz * inv);
      const rot = rb.rotation();
      rb.setNextKinematicTranslation({
        x: this._grabTarget.x,
        y: this._grabTarget.y,
        z: this._grabTarget.z
      });
      rb.setNextKinematicRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w });
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /** @param {'left' | 'right'} hand */
  releaseGrab(hand) {
    if (hand === 'left' || hand === 'right') {
      const partKey = this.grabbedPart[hand];
      this.grabbedPart[hand] = null;
      this.grabAnchorLocal[hand] = null;
      this._releasePartPhysicsIfIdle(partKey);
    }
  }

  /** @param {'left' | 'right'} hand */
  tryGrab(handPos, hand) {
    if (hand !== 'left' && hand !== 'right') return false;
    if (this.grabbedPart[hand]) return false;

    const k = this.findClosestPartKey(handPos);
    if (!k) return false;

    if (this.mode === 'animated') {
      this._enterRagdollFromInteraction();
    }
    this.grabbedPart[hand] = k;
    this._bindGrabAnchor(hand, k, handPos);
    return true;
  }

  get anyGrabActive() {
    return !!(this.grabbedPart.left || this.grabbedPart.right);
  }

  /**
   * Tight player pushback samples (bone-based, not full physics hulls).
   * @param {{ x: number, y: number, z: number, r: number }[]} out
   * @param {{ x: number, z: number }} playerXZ — rig position XZ
   * @param {number} [maxHorizDist=0.72] — ignore NPC when player is farther than this (m)
   */
  collectPlayerBlockSpheres(out, playerXZ, maxHorizDist = 0.72) {
    if (!this.mesh) return;
    const spine = this.mesh.getObjectByName('spine');
    if (!spine) return;
    spine.getWorldPosition(this._v);
    const dx = playerXZ.x - this._v.x;
    const dz = playerXZ.z - this._v.z;
    if (dx * dx + dz * dz > maxHorizDist * maxHorizDist) return;

    this.mesh.updateMatrixWorld(true);
    const blockParts = [
      ['spine', 0.13],
      ['head', 0.1]
    ];
    for (let i = 0; i < blockParts.length; i++) {
      const bone = this.mesh.getObjectByName(blockParts[i][0]);
      if (!bone) continue;
      bone.getWorldPosition(this._v);
      out.push({
        x: this._v.x,
        y: this._v.y,
        z: this._v.z,
        r: blockParts[i][1]
      });
    }
  }

  canAutoStand() {
    if (this.mode !== 'ragdoll') return false;
    const hips = this._bodies.torso;
    if (!hips) return false;
    const lv = hips.linvel();
    if (Math.hypot(lv.x, lv.y, lv.z) > 0.35) return false;
    const r = hips.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    return up.y > 0.65;
  }

  canReturnToAnimated() {
    if (this.mode !== 'ragdoll') return false;
    if (this.canAutoStand()) return true;
    const t = this._bodies.torso;
    if (!t) return false;
    const lv = t.linvel();
    return Math.hypot(lv.x, lv.y, lv.z) < 1.05;
  }
}
