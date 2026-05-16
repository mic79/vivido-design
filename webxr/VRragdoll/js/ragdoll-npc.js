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
    /** @type {{ left: THREE.Vector3 | null, right: THREE.Vector3 | null }} */
    this.grabAnchorOffset = { left: null, right: null };
    this._v = new THREE.Vector3();
    this._grabScratchPos = new THREE.Vector3();
    this._grabScratchVel = new THREE.Vector3();
    this._grabTarget = new THREE.Vector3();

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
    this.grabbedPart.left = null;
    this.grabbedPart.right = null;
    this.grabAnchorOffset.left = null;
    this.grabAnchorOffset.right = null;
  }

  _createRagdoll() {
    const R = this.RAPIER;
    const s = this.spawn;
    const stiffness = 0.03;
    const density = 0.16;
    const torsoWidth = 0.4;
    const thighLength = 0.38 - stiffness * 2;
    const shinLength = 0.43 - stiffness * 2;
    const upperArmLength = 0.3 - stiffness * 2;
    const lowerArmLength = 0.42 - stiffness * 2;

    const tx = s.x;
    const ty = s.y;
    const tz = s.z;

    const torsoDesc = R.ColliderDesc.cuboid(torsoWidth / 2, torsoHeight / 2, 0.1);
    const torsoBodyDesc = R.RigidBodyDesc.dynamic().setTranslation(tx, ty, tz);
    this._bodies.torso = this.world.createRigidBody(torsoBodyDesc);
    this.world.createCollider(torsoDesc, this._bodies.torso);

    const headSize = 0.2;
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
   * @param {RagMode} mode
   */
  setMode(mode) {
    const wasRagdoll = this.mode === 'ragdoll';
    this.mode = mode;
    for (const k of PART_KEYS) {
      const rb = this._bodies[k];
      if (!rb) continue;
      rb.setEnabled(true);
      if (mode === 'animated') {
        rb.setBodyType(this.RAPIER.RigidBodyType.KinematicPositionBased, true);
      } else {
        rb.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
      }
    }
    if (mode === 'ragdoll') {
      this.syncRigidBodiesFromBones();
    }
    if (mode === 'animated' && wasRagdoll && this.idleAction) {
      this.idleAction.reset().fadeIn(0.2).play();
    }
    this.releaseAllGrabs();
  }

  /** Animated → ragdoll without clearing per-hand grabs (used when starting a grab). */
  _enterRagdollFromInteraction() {
    if (this.mode === 'ragdoll') return;
    this.mode = 'ragdoll';
    for (const k of PART_KEYS) {
      const rb = this._bodies[k];
      if (!rb) continue;
      rb.setEnabled(true);
      rb.setBodyType(this.RAPIER.RigidBodyType.Dynamic, true);
    }
    this.syncRigidBodiesFromBones();
  }

  syncRigidBodiesFromBones() {
    if (!this.mesh) return;
    this.mesh.updateMatrixWorld(true);
    for (const key of PART_KEYS) {
      const rb = this._bodies[key];
      const bn = boneMapping[key];
      const bone = this.mesh.getObjectByName(bn);
      if (!rb || !bone) continue;
      bone.updateMatrixWorld(true);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      bone.getWorldPosition(p);
      bone.getWorldQuaternion(q);
      rb.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      rb.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
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
      bone.updateMatrixWorld(true);
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      bone.getWorldPosition(p);
      bone.getWorldQuaternion(q);
      rb.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
      rb.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
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

  findClosestPartKey(point, maxDist = 0.65) {
    if (!this.mesh) return null;
    this.mesh.updateMatrixWorld(true);
    let best = null;
    let bestD = maxDist;
    for (const key of PART_KEYS) {
      const bn = boneMapping[key];
      const bone = this.mesh.getObjectByName(bn);
      if (!bone) continue;
      bone.getWorldPosition(this._v);
      const d = point.distanceTo(this._v);
      if (d < bestD) {
        bestD = d;
        best = key;
      }
    }
    return best;
  }

  /**
   * World offset from rigid-body origin to hand at grab time (keeps hold on the surface point).
   * @param {'left' | 'right'} hand
   * @param {string} partKey
   * @param {THREE.Vector3} handPos
   */
  _bindGrabAnchor(hand, partKey, handPos) {
    const rb = this._bodies[partKey];
    if (!rb) return;
    const t = rb.translation();
    let off = this.grabAnchorOffset[hand];
    if (!off) {
      off = new THREE.Vector3();
      this.grabAnchorOffset[hand] = off;
    }
    /* Offset from physics body origin so the surface point stays under the hand. */
    off.set(handPos.x - t.x, handPos.y - t.y, handPos.z - t.z);
  }

  /** @param {'left' | 'right'} hand */
  _driveGrabbedBody(partKey, handPos, handVel, hand) {
    const rb = this._bodies[partKey];
    if (!rb || this.mode !== 'ragdoll') return;
    const t = rb.translation();
    const offset = this.grabAnchorOffset[hand];
    const target = this._grabTarget.set(t.x, t.y, t.z);
    if (offset) {
      target.set(handPos.x - offset.x, handPos.y - offset.y, handPos.z - offset.z);
    } else {
      target.copy(handPos);
    }
    const kp = 42;
    const kd = 2.4;
    rb.setLinvel(
      {
        x: (target.x - t.x) * kp + handVel.x * kd,
        y: (target.y - t.y) * kp + handVel.y * kd,
        z: (target.z - t.z) * kp + handVel.z * kd
      },
      true
    );
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
        const { side, pos, vel } = list[i];
        const off = this.grabAnchorOffset[side];
        if (off) {
          tx += pos.x - off.x;
          ty += pos.y - off.y;
          tz += pos.z - off.z;
        } else {
          tx += pos.x;
          ty += pos.y;
          tz += pos.z;
        }
        vx += vel.x;
        vy += vel.y;
        vz += vel.z;
      }
      const inv = 1 / list.length;
      const kp = 42;
      const kd = 2.4;
      this._grabTarget.set(tx * inv, ty * inv, tz * inv);
      rb.setLinvel(
        {
          x: (this._grabTarget.x - t.x) * kp + vx * inv * kd,
          y: (this._grabTarget.y - t.y) * kp + vy * inv * kd,
          z: (this._grabTarget.z - t.z) * kp + vz * inv * kd
        },
        true
      );
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /** @param {'left' | 'right'} hand */
  releaseGrab(hand) {
    if (hand === 'left' || hand === 'right') {
      this.grabbedPart[hand] = null;
      this.grabAnchorOffset[hand] = null;
    }
  }

  /** @param {'left' | 'right'} hand */
  tryGrab(handPos, hand) {
    if (hand !== 'left' && hand !== 'right') return false;
    if (this.grabbedPart[hand]) return false;

    const k = this.findClosestPartKey(handPos);
    if (!k) return false;

    if (this.mode === 'animated') {
      this.syncRigidBodiesFromBones();
      this._enterRagdollFromInteraction();
    }
    this.grabbedPart[hand] = k;
    this._bindGrabAnchor(hand, k, handPos);
    this.syncBonesFromPhysics();
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
