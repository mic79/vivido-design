/**
 * Drive a Mixamo skinned skeleton from Box3D ragdoll physics bodies.
 *
 * Method (standard rigid retarget, robust for skinned meshes):
 *   At calibration we record, per bone, the world-rotation offset between the
 *   physics body and the Mixamo bone:  offset = bodyWorld0^-1 * boneWorld0.
 *   Each frame the bone's desired world rotation is  bodyWorld * offset, i.e. the
 *   body's rotation delta since spawn applied to the bone's initial world pose.
 *   We then convert that to a local rotation via the (already-updated) parent.
 *   Roll and bind pose are preserved because we use full body quaternions, not
 *   an aim direction.
 *
 * Root translation: the entity is translated by the pelvis body's world delta so
 * the hips follow the physics pelvis, independent of any parent transform.
 */
(function () {
  'use strict';

  const BONES = window.Box3DRagdoll?.BONES || [];

  const MIXAMO_BONE_KEYS = [
    'hips',
    'spine',
    'spine1',
    'spine2',
    'neck',
    'head',
    'leftUpLeg',
    'leftLeg',
    'rightUpLeg',
    'rightLeg',
    'leftUpperArm',
    'leftForearm',
    'rightUpperArm',
    'rightForearm',
    'leftHand',
    'rightHand'
  ];

  // Physics body indices for wrist-hand capsules (appended after reference 14-bone human).
  const HAND_BODY_IDX = { leftHand: 14, rightHand: 15 };

  /** Physics body indices driven by each baked shatter region. */
  const REGION_BODY_INDICES = {
    hips: [0],
    torso: [1, 2],
    chest: [3],
    neck: [4],
    head: [5],
    leftThigh: [6],
    leftShin: [7],
    leftFoot: [7],
    rightThigh: [8],
    rightShin: [9],
    rightFoot: [9],
    leftUpperArm: [10],
    leftForearm: [11],
    leftHand: [14],
    rightUpperArm: [12],
    rightForearm: [13],
    rightHand: [15]
  };

  const SHOT_IMPULSE_RADIUS = 0.55;
  const ADJACENT_IMPULSE_SCALE = 0.42;

  const LEG_BODY_INDICES = { 6: true, 7: true, 8: true, 9: true };
  const THIGH_BODY_INDICES = { 6: true, 8: true };
  const SHIN_BODY_INDICES = { 7: true, 9: true };

  const _bodyQuat = new THREE.Quaternion();
  const _boneWorldQuat = new THREE.Quaternion();
  const _parentWorldQuat = new THREE.Quaternion();
  const _desiredWorld = new THREE.Quaternion();
  const _localQuat = new THREE.Quaternion();
  const _pelvisWorld = new THREE.Vector3();
  const _desiredEntityWorld = new THREE.Vector3();
  const _boneWorldPos = new THREE.Vector3();
  const _zeroVel = { x: 0, y: 0, z: 0 };
  const _relBody = new THREE.Quaternion();
  const _relBone = new THREE.Quaternion();
  const _parentBodyQuat = new THREE.Quaternion();
  const _boneLinVel = new THREE.Vector3();
  const _spawnBaseVel = new THREE.Vector3();

  // Elbows (revolute joints): drive the forearm from upper/lower-arm *relative* rotation.
  // Absolute offset retarget fails here because both segments share the same world delta
  // when the arm swings, wiping out the hinge flex (legs don't have this problem).
  const FOREARM_HINGE_PARENT = {
    11: 10, // leftForearm  ← upper_arm_l / leftUpperArm
    13: 12, // rightForearm ← upper_arm_r / rightUpperArm
    14: 11, // leftHand     ← lower_arm_l / leftForearm (wrist hinge)
    15: 13  // rightHand    ← lower_arm_r / rightForearm
  };

  function bodyWorldQuaternion(b3, body, out) {
    const rot = b3.b3Body_GetRotation(body);
    return out.set(rot.v.x, rot.v.y, rot.v.z, rot.s);
  }

  function quatFinite(q) {
    return isFinite(q.x) && isFinite(q.y) && isFinite(q.z) && isFinite(q.w) &&
      (q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) > 1e-6;
  }

  /**
   * Rigidly move the ragdoll so it matches the live Mixamo anchor points:
   *   XZ — pelvis body → hips bone
   *   Y  — lowest capsule → ankle (foot bone), not player feetY / sole
   * Without this, physics ends at the shin while mesh soles extend below, so feet
   * sink into the ground the moment ragdoll starts.
   */
  function alignHumanToMeshAnchors(mixamoComp, b3, human) {
    if (!mixamoComp?.bones?.hips || !b3 || !human || !window.Box3DRagdoll?.translateHuman) return;

    mixamoComp.model.updateMatrixWorld(true);
    mixamoComp.skeleton.update();

    const pelvis = b3.b3Body_GetPosition(human.bodies[0]);
    const hips = new THREE.Vector3();
    mixamoComp.bones.hips.getWorldPosition(hips);

    let ankleY = hips.y;
    if (mixamoComp.bones.leftFoot && mixamoComp.bones.rightFoot) {
      const lf = new THREE.Vector3();
      const rf = new THREE.Vector3();
      mixamoComp.bones.leftFoot.getWorldPosition(lf);
      mixamoComp.bones.rightFoot.getWorldPosition(rf);
      ankleY = Math.min(lf.y, rf.y);
    }

    const lowestY = window.Box3DRagdoll.computeLowestY(b3, human);
    if (!isFinite(lowestY)) return;

    window.Box3DRagdoll.translateHuman(
      b3,
      human,
      hips.x - pelvis.x,
      ankleY - lowestY,
      hips.z - pelvis.z
    );
  }

  function calibrate(mixamoComp, b3, human) {
    if (!mixamoComp?.bones || !mixamoComp.skeleton || !b3 || !human || !BONES.length) return null;

    mixamoComp.model.updateMatrixWorld(true);
    mixamoComp.skeleton.update();

    const offsets = new Array(MIXAMO_BONE_KEYS.length).fill(null);
    const forearmHingeOffsets = {};
    const boneWorld0 = new Array(MIXAMO_BONE_KEYS.length).fill(null);
    const bodyWorld0 = new Array(MIXAMO_BONE_KEYS.length).fill(null);
    for (let i = 0; i < MIXAMO_BONE_KEYS.length; i++) {
      const bone = mixamoComp.bones[MIXAMO_BONE_KEYS[i]];
      if (!bone || !human.bodies[i]) continue;

      const parentIdx = FOREARM_HINGE_PARENT[i];
      if (parentIdx !== undefined) {
        const parentBone = mixamoComp.bones[MIXAMO_BONE_KEYS[parentIdx]];
        const parentBody = human.bodies[parentIdx];
        if (!parentBone || !parentBody) continue;
        bone.getWorldQuaternion(_boneWorldQuat);
        parentBone.getWorldQuaternion(_parentWorldQuat);
        bodyWorldQuaternion(b3, human.bodies[i], _bodyQuat);
        bodyWorldQuaternion(b3, parentBody, _parentBodyQuat);
        _relBody.copy(_parentBodyQuat).invert().multiply(_bodyQuat);
        _relBone.copy(_parentWorldQuat).invert().multiply(_boneWorldQuat);
        forearmHingeOffsets[i] = _relBody.clone().invert().multiply(_relBone);
        // Also keep absolute offset — Echo skips hinge apply and needs this.
        offsets[i] = _bodyQuat.clone().invert().multiply(_boneWorldQuat);
        boneWorld0[i] = _boneWorldQuat.clone();
        bodyWorld0[i] = _bodyQuat.clone();
        continue;
      }

      bone.getWorldQuaternion(_boneWorldQuat);
      bodyWorldQuaternion(b3, human.bodies[i], _bodyQuat);
      offsets[i] = _bodyQuat.clone().invert().multiply(_boneWorldQuat);
      boneWorld0[i] = _boneWorldQuat.clone();
      bodyWorld0[i] = _bodyQuat.clone();
    }

    const entityWorld0 = new THREE.Vector3();
    mixamoComp.el.object3D.getWorldPosition(entityWorld0);
    const pelvis = b3.b3Body_GetPosition(human.bodies[0]);
    const pelvisWorld0 = new THREE.Vector3(pelvis.x, pelvis.y, pelvis.z);

    const shoulderRest = {};
    ['leftShoulder', 'rightShoulder'].forEach((k) => {
      if (mixamoComp.bones[k]) shoulderRest[k] = mixamoComp.bones[k].quaternion.clone();
    });

    const isEcho = !!(mixamoComp._echoPlantLegs
      || (typeof mixamoComp._isEchoModel === 'function'
        && mixamoComp._isEchoModel(mixamoComp.data?.modelPath)));
    let echoHipsBindPos = null;
    if (isEcho && mixamoComp.bones.hips) {
      echoHipsBindPos = mixamoComp.bones.hips.position.clone();
    }

    return {
      offsets,
      forearmHingeOffsets,
      entityWorld0,
      pelvisWorld0,
      shoulderRest,
      boneWorld0,
      bodyWorld0,
      // World-space body delta via body*offset (same as YBot). Echo skips forearm
      // hinge retarget (spaghetti arms). Capsule-axis align is intentionally NOT used:
      // swinging bodies after createHuman pancakes Echo (hipsY~0.12 vs YBot~0.56).
      echoBoneLocalDelta: false,
      echoNoHingeRetarget: isEcho,
      echoHipsBindPos
    };
  }

  function syncHumanFromMixamo(mixamoComp, b3, human) {
    if (!mixamoComp?.bones || !mixamoComp.skeleton || !b3 || !human) return;

    mixamoComp.model.updateMatrixWorld(true);
    mixamoComp.skeleton.update();

    for (let i = 0; i < MIXAMO_BONE_KEYS.length; i++) {
      const bone = mixamoComp.bones[MIXAMO_BONE_KEYS[i]];
      const body = human.bodies[i];
      if (!bone || !body) continue;

      bone.getWorldPosition(_boneWorldPos);
      bone.getWorldQuaternion(_boneWorldQuat);
      b3.b3Body_SetTransform(
        body,
        { x: _boneWorldPos.x, y: _boneWorldPos.y, z: _boneWorldPos.z },
        { v: { x: _boneWorldQuat.x, y: _boneWorldQuat.y, z: _boneWorldQuat.z }, s: _boneWorldQuat.w }
      );
      if (b3.b3Body_SetLinearVelocity) b3.b3Body_SetLinearVelocity(body, _zeroVel);
      if (b3.b3Body_SetAngularVelocity) b3.b3Body_SetAngularVelocity(body, _zeroVel);
      if (b3.b3Body_SetAwake) b3.b3Body_SetAwake(body, true);
    }
  }

  function positionEntity(mixamoComp, b3, human, state) {
    if (!state || mixamoComp.data.isMirror) return;
    const pelvis = b3.b3Body_GetPosition(human.bodies[0]);
    _pelvisWorld.set(pelvis.x, pelvis.y, pelvis.z);

    if (!isFinite(_pelvisWorld.x) || !isFinite(_pelvisWorld.y) || !isFinite(_pelvisWorld.z)) return;

    _desiredEntityWorld.copy(state.entityWorld0).add(_pelvisWorld).sub(state.pelvisWorld0);

    const obj = mixamoComp.el.object3D;
    if (obj.parent) {
      obj.parent.updateMatrixWorld(true);
      obj.parent.worldToLocal(_desiredEntityWorld);
    }
    obj.position.copy(_desiredEntityWorld);
    obj.updateMatrixWorld(true);
  }

  function applyRotations(mixamoComp, b3, human, state) {
    if (!mixamoComp?.bones || !mixamoComp.skeleton || !b3 || !human || !state || !BONES.length) return;

    if (state.shoulderRest && !mixamoComp._freeRagdollMode) {
      Object.keys(state.shoulderRest).forEach((k) => {
        if (mixamoComp.bones[k]) {
          mixamoComp.bones[k].quaternion.copy(state.shoulderRest[k]);
          mixamoComp.bones[k].updateMatrixWorld(true);
        }
      });
    }

    // Echo FBX GeometricTranslation lives in hips.position (~870 units). Never let
    // retarget/physics overwrite it — rotating with a drifted hips.position orbits
    // the whole skinned mesh into a crumpled ball.
    const echoHipsBind = state.echoHipsBindPos || null;

    for (let i = 0; i < MIXAMO_BONE_KEYS.length; i++) {
      const bone = mixamoComp.bones[MIXAMO_BONE_KEYS[i]];
      if (!bone || !human.bodies[i]) continue;

      const parentIdx = FOREARM_HINGE_PARENT[i];
      // Echo wrist/elbow hinge retarget stretches arms into spaghetti — use absolute offsets.
      const forearmHinge = state.forearmHingeOffsets && state.forearmHingeOffsets[i];
      if (parentIdx !== undefined && forearmHinge && !state.echoNoHingeRetarget) {
        const parentBone = mixamoComp.bones[MIXAMO_BONE_KEYS[parentIdx]];
        const parentBody = human.bodies[parentIdx];
        if (!parentBone || !parentBody) continue;

        parentBone.getWorldQuaternion(_parentWorldQuat);
        bodyWorldQuaternion(b3, parentBody, _parentBodyQuat);
        bodyWorldQuaternion(b3, human.bodies[i], _bodyQuat);
        _relBody.copy(_parentBodyQuat).invert().multiply(_bodyQuat);
        _relBone.copy(_relBody).multiply(forearmHinge);
        _desiredWorld.copy(_parentWorldQuat).multiply(_relBone);

        if (bone.parent) {
          bone.parent.getWorldQuaternion(_parentWorldQuat);
          _localQuat.copy(_parentWorldQuat).invert().multiply(_desiredWorld);
        } else {
          _localQuat.copy(_desiredWorld);
        }
        if (quatFinite(_localQuat)) {
          bone.quaternion.copy(_localQuat);
          bone.updateMatrixWorld(true);
        }
        continue;
      }

      const offset = state.offsets[i];
      if (!offset) continue;

      bodyWorldQuaternion(b3, human.bodies[i], _bodyQuat);

      if (state.echoBoneLocalDelta && state.boneWorld0 && state.boneWorld0[i] && state.bodyWorld0 && state.bodyWorld0[i]) {
        // Apply physics delta in bone-local space: bone0 * (body0^-1 * body).
        // Absolute body*offset crumples Echo (large bind-roll offsets ~90°+).
        _relBody.copy(state.bodyWorld0[i]).invert().multiply(_bodyQuat);
        _desiredWorld.copy(state.boneWorld0[i]).multiply(_relBody);
      } else {
        _desiredWorld.copy(_bodyQuat).multiply(offset);
      }

      if (bone.parent) {
        bone.parent.getWorldQuaternion(_parentWorldQuat);
        _localQuat.copy(_parentWorldQuat).invert().multiply(_desiredWorld);
      } else {
        _localQuat.copy(_desiredWorld);
      }
      if (quatFinite(_localQuat)) {
        bone.quaternion.copy(_localQuat);
        if (i === 0 && echoHipsBind) {
          bone.position.copy(echoHipsBind);
        }
        bone.updateMatrixWorld(true);
      }
    }

    mixamoComp.skeleton.update();
    if (mixamoComp.model) mixamoComp.model.updateMatrixWorld(true);
  }

  /** Hand capsules are small and spin easily — cap wrist whirl after impacts. */
  function dampHandAngularVelocity(b3, human, maxRadPerSec) {
    if (!b3?.b3Body_GetAngularVelocity || !b3.b3Body_SetAngularVelocity || !human?.bodies) return;
    maxRadPerSec = maxRadPerSec == null ? 14 : maxRadPerSec;
    const indices = [HAND_BODY_IDX.leftHand, HAND_BODY_IDX.rightHand];
    for (let i = 0; i < indices.length; i++) {
      const body = human.bodies[indices[i]];
      if (!body) continue;
      if (human.dynamicFlags && !human.dynamicFlags[indices[i]]) continue;
      const w = b3.b3Body_GetAngularVelocity(body);
      const speed = Math.hypot(w.x, w.y, w.z);
      if (speed > maxRadPerSec) {
        const s = maxRadPerSec / speed;
        b3.b3Body_SetAngularVelocity(body, { x: w.x * s, y: w.y * s, z: w.z * s });
      }
    }
  }

  /**
   * Swing torso physics capsules so their axes match the Mixamo spine chain.
   * Echo FBX torso capsules sit ~90° off the spine (body X vs bone Y); absolute
   * body*offset retarget then crumples the mesh when the ragdoll tips.
   * Limbs stay createHuman-oriented — aligning thighs removed the knee-prop that
   * keeps YBot's pelvis up in a kneeling collapse (Echo pancaked to hipsY~0.12).
   * Pure swing (no full quat copy) — keeps hand joints from overstating.
   * Caller must rebuildHumanJointsAtCurrentPose after this.
   */
  function alignBodyCapsuleAxesToMesh(mixamoComp, b3, human) {
    if (!mixamoComp?.bones || !b3 || !human || !BONES.length) return;

    mixamoComp.model.updateMatrixWorld(true);
    mixamoComp.skeleton.update();

    const childKey = {
      spine: 'spine1',
      spine1: 'spine2',
      spine2: 'neck',
      neck: 'head'
    };
    // Spine chain only — skip pelvis/hips. Aligning pelvis+thighs pancaked Echo
    // (hipsY~0.12); YBot keeps kneeling (~0.56) with createHuman limb frames.
    const torsoKeys = { spine: 1, spine1: 1, spine2: 1, neck: 1, head: 1 };

    for (let i = 0; i < MIXAMO_BONE_KEYS.length; i++) {
      const key = MIXAMO_BONE_KEYS[i];
      if (!torsoKeys[key]) continue;

      const bone = mixamoComp.bones[key];
      const body = human.bodies[i];
      const def = BONES[i];
      if (!bone || !body || !def) continue;

      _spawnBaseVel.set(def.c2.x - def.c1.x, def.c2.y - def.c1.y, def.c2.z - def.c1.z);
      if (_spawnBaseVel.lengthSq() < 1e-8) continue;
      _spawnBaseVel.normalize();

      bodyWorldQuaternion(b3, body, _bodyQuat);
      _desiredEntityWorld.copy(_spawnBaseVel).applyQuaternion(_bodyQuat);
      if (_desiredEntityWorld.lengthSq() < 1e-8) continue;
      _desiredEntityWorld.normalize();

      const ck = childKey[key];
      const child = ck ? mixamoComp.bones[ck] : null;
      if (child) {
        bone.getWorldPosition(_boneWorldPos);
        child.getWorldPosition(_pelvisWorld);
        _boneLinVel.copy(_pelvisWorld).sub(_boneWorldPos);
      } else {
        bone.getWorldQuaternion(_boneWorldQuat);
        _boneLinVel.set(0, 1, 0).applyQuaternion(_boneWorldQuat);
      }
      if (_boneLinVel.lengthSq() < 1e-8) continue;
      _boneLinVel.normalize();

      const dot = _desiredEntityWorld.dot(_boneLinVel);
      if (dot > 0.98) continue; // already aligned

      _relBody.setFromUnitVectors(_desiredEntityWorld, _boneLinVel);
      _desiredWorld.copy(_relBody).multiply(_bodyQuat);

      const pos = b3.b3Body_GetPosition(body);
      b3.b3Body_SetTransform(
        body,
        { x: pos.x, y: pos.y, z: pos.z },
        { v: { x: _desiredWorld.x, y: _desiredWorld.y, z: _desiredWorld.z }, s: _desiredWorld.w }
      );
      if (b3.b3Body_SetLinearVelocity) b3.b3Body_SetLinearVelocity(body, _zeroVel);
      if (b3.b3Body_SetAngularVelocity) b3.b3Body_SetAngularVelocity(body, _zeroVel);
    }
  }

  /** Snap wrist-hand physics bodies onto the live Mixamo hand bones before calibrate.
   *  Position only — copying Echo hand bone quats into Box3D wrist joints overstole
   *  angular limits and exploded the ragdoll into a stiff floating pose.
   *  Clamp reach from the forearm body so short Echo arms cannot tear constraints.
   */
  function snapHandBodiesFromMesh(mixamoComp, b3, human) {
    if (!mixamoComp?.bones || !b3 || !human) return;
    mixamoComp.model.updateMatrixWorld(true);
    mixamoComp.skeleton.update();
    const pairs = [
      { key: 'leftHand', idx: HAND_BODY_IDX.leftHand, foreIdx: 11 },
      { key: 'rightHand', idx: HAND_BODY_IDX.rightHand, foreIdx: 13 }
    ];
    const MAX_REACH = 0.34;
    for (let i = 0; i < pairs.length; i++) {
      const bone = mixamoComp.bones[pairs[i].key];
      const body = human.bodies[pairs[i].idx];
      const foreBody = human.bodies[pairs[i].foreIdx];
      if (!bone || !body) continue;
      bone.getWorldPosition(_boneWorldPos);

      if (foreBody) {
        const fp = b3.b3Body_GetPosition(foreBody);
        _spawnBaseVel.set(
          _boneWorldPos.x - fp.x,
          _boneWorldPos.y - fp.y,
          _boneWorldPos.z - fp.z
        );
        const dist = _spawnBaseVel.length();
        if (dist > MAX_REACH && dist > 1e-6) {
          _spawnBaseVel.multiplyScalar(MAX_REACH / dist);
          _boneWorldPos.set(
            fp.x + _spawnBaseVel.x,
            fp.y + _spawnBaseVel.y,
            fp.z + _spawnBaseVel.z
          );
        }
      }

      // Keep existing physics orientation (from createHuman) — do not copy mesh hand quat.
      const rot = b3.b3Body_GetRotation(body);
      b3.b3Body_SetTransform(
        body,
        { x: _boneWorldPos.x, y: _boneWorldPos.y, z: _boneWorldPos.z },
        rot || { v: { x: 0, y: 0, z: 0 }, s: 1 }
      );
      if (b3.b3Body_SetLinearVelocity) b3.b3Body_SetLinearVelocity(body, _zeroVel);
      if (b3.b3Body_SetAngularVelocity) b3.b3Body_SetAngularVelocity(body, _zeroVel);
      if (b3.b3Body_SetAwake) b3.b3Body_SetAwake(body, true);
    }
  }

  function apply(mixamoComp, b3, human, state) {
    if (!mixamoComp || !b3 || !human || !state) return;
    positionEntity(mixamoComp, b3, human, state);
    applyRotations(mixamoComp, b3, human, state);
    dampHandAngularVelocity(b3, human);
  }

  /** Per-bone world linear velocity from mixamo-body's frame-to-frame bone tracking. */
  function sampleMixamoBoneLinearVel(mixamoComp, boneKey, dest) {
    dest.set(0, 0, 0);
    if (!mixamoComp?.skeleton || !mixamoComp.bones) return dest;
    const bone = mixamoComp.bones[boneKey];
    if (!bone) return dest;
    const boneVel = mixamoComp._dotBoneVelWorld;
    if (!boneVel) return dest;
    const skIdx = mixamoComp.skeleton.bones.indexOf(bone);
    if (skIdx < 0) return dest;
    const b = skIdx * 3;
    if (b + 2 >= boneVel.length) return dest;
    dest.set(boneVel[b], boneVel[b + 1], boneVel[b + 2]);
    return dest;
  }

  /**
   * Carry rig + limb momentum into the ragdoll at spawn.
   * Uses per-bone tracked velocity when available; otherwise uniform baseVel (thruster / walk).
   */
  function applyMixamoSpawnMomentum(mixamoComp, b3, human, baseVel) {
    if (!b3 || !human || !b3.b3Body_SetLinearVelocity) return;
    _spawnBaseVel.set(baseVel?.x || 0, baseVel?.y || 0, baseVel?.z || 0);
    const baseSpeedSq = _spawnBaseVel.lengthSq();
    const minBoneSpeedSq = 0.08 * 0.08;

    for (let i = 0; i < BONES.length; i++) {
      const body = human.bodies[i];
      if (!body) continue;
      if (human.dynamicFlags && !human.dynamicFlags[i]) continue;

      let vx = _spawnBaseVel.x;
      let vy = _spawnBaseVel.y;
      let vz = _spawnBaseVel.z;

      const key = MIXAMO_BONE_KEYS[i];
      if (key && mixamoComp) {
        sampleMixamoBoneLinearVel(mixamoComp, key, _boneLinVel);
        if (_boneLinVel.lengthSq() > minBoneSpeedSq) {
          vx = _boneLinVel.x;
          vy = _boneLinVel.y;
          vz = _boneLinVel.z;
        } else if (baseSpeedSq <= minBoneSpeedSq && mixamoComp.headVelocity && i === 0) {
          vx = mixamoComp.headVelocity.x;
          vy = mixamoComp.headVelocity.y;
          vz = mixamoComp.headVelocity.z;
        }
      }

      b3.b3Body_SetLinearVelocity(body, { x: vx, y: vy, z: vz });
      if (b3.b3Body_SetAwake) b3.b3Body_SetAwake(body, true);
    }
  }

  /**
   * Apply shot momentum to the primary hit region and its skeleton neighbors only.
   * zones: { primaryId, ids } from RagdollShatter.pickImpactZones.
   */
  function applyShotImpulse(b3, human, zones, shotDir, impactNormal, strength, impulseScale, opts) {
    if (!b3 || !human || !b3.b3Body_SetLinearVelocity || !zones?.primaryId) return;

    opts = opts || {};
    const skipHeld = opts.skipBodyIndices || null;
    const skipRootBodies = !!opts.skipRootBodies;
    const primaryOnly = !!opts.primaryOnly;
    const angularBend = !!opts.angularBend;
    const angularScale = opts.angularScale == null ? 1 : opts.angularScale;
    const str = strength == null ? 1 : Math.max(0.35, strength);
    const scaleMul = impulseScale == null ? 1 : impulseScale;
    const coreBoost = zones.surfaceOnly ? 1.3 : 1;
    const dir = _boneLinVel.copy(shotDir);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
    else dir.normalize();

    const normal = _spawnBaseVel.copy(impactNormal || shotDir);
    if (normal.lengthSq() < 1e-8) normal.copy(dir);
    else normal.normalize();

    const deltas = new Map();
    const ids = primaryOnly ? [zones.primaryId] : (zones.ids || []);
    const primaryId = zones.primaryId;

    for (let r = 0; r < ids.length; r++) {
      const regionId = ids[r];
      const isPrimary = regionId === primaryId;
      const scale = isPrimary ? 1 : ADJACENT_IMPULSE_SCALE;
      const shotMag = (isPrimary ? 8.5 : 4.0) * str * scale * coreBoost * scaleMul;
      const normMag = (isPrimary ? 2.4 : 1.0) * str * scale * coreBoost * scaleMul;
      const indices = REGION_BODY_INDICES[regionId];
      if (!indices) continue;

      for (let i = 0; i < indices.length; i++) {
        const idx = indices[i];
        if (skipRootBodies && idx < 6) continue;
        let d = deltas.get(idx);
        if (!d) {
          d = { x: 0, y: 0, z: 0 };
          deltas.set(idx, d);
        }
        d.x += dir.x * shotMag + normal.x * normMag;
        d.y += dir.y * shotMag + normal.y * normMag;
        d.z += dir.z * shotMag + normal.z * normMag;
      }
    }

    let bendAxis = null;
    if (angularBend && b3.b3Body_SetAngularVelocity) {
      _desiredEntityWorld.set(0, 1, 0).cross(dir);
      if (_desiredEntityWorld.lengthSq() < 1e-6) _desiredEntityWorld.set(1, 0, 0).cross(dir);
      if (_desiredEntityWorld.lengthSq() > 1e-8) {
        _desiredEntityWorld.normalize();
        bendAxis = _desiredEntityWorld;
      }
    }

    const maxSpd = opts.maxSpeed != null ? opts.maxSpeed : (11 * str);
    const maxAng = opts.maxAngularSpeed != null ? opts.maxAngularSpeed : (9 * str * angularScale);

    deltas.forEach((delta, idx) => {
      const body = human.bodies[idx];
      if (!body) return;
      if (skipHeld && skipHeld[idx]) return;
      if (skipRootBodies && idx < 6) return;
      if (human.dynamicFlags && !human.dynamicFlags[idx]) return;

      let vx = delta.x;
      let vy = delta.y;
      let vz = delta.z;
      if (b3.b3Body_GetLinearVelocity) {
        const cur = b3.b3Body_GetLinearVelocity(body);
        vx += cur.x;
        vy += cur.y;
        vz += cur.z;
      }

      const sp = Math.hypot(vx, vy, vz);
      if (sp > maxSpd) {
        const s = maxSpd / sp;
        vx *= s;
        vy *= s;
        vz *= s;
      }

      b3.b3Body_SetLinearVelocity(body, { x: vx, y: vy, z: vz });
      if (b3.b3Body_SetAwake) b3.b3Body_SetAwake(body, true);

      if (bendAxis && LEG_BODY_INDICES[idx]) {
        let angMag = 0;
        if (SHIN_BODY_INDICES[idx]) angMag = str * 5.4 * scaleMul * angularScale;
        else if (THIGH_BODY_INDICES[idx]) angMag = str * 3.1 * scaleMul * angularScale;
        if (angMag > 0) {
          let wx = bendAxis.x * angMag;
          let wy = bendAxis.y * angMag;
          let wz = bendAxis.z * angMag;
          if (b3.b3Body_GetAngularVelocity) {
            const curW = b3.b3Body_GetAngularVelocity(body);
            wx += curW.x;
            wy += curW.y;
            wz += curW.z;
          }
          const wSp = Math.hypot(wx, wy, wz);
          if (wSp > maxAng) {
            const s = maxAng / wSp;
            wx *= s;
            wy *= s;
            wz *= s;
          }
          b3.b3Body_SetAngularVelocity(body, { x: wx, y: wy, z: wz });
        }
      }
    });
  }

  /**
   * Whole-body stumble: nudge kinematic pelvis/legs and kick dynamic spine/limb bodies.
   * Keeps the dummy upright while visibly recoiling from each hit.
   */
  function applyStumbleImpulse(b3, human, shotDir, impactNormal, strength, stage, opts) {
    if (!b3 || !human) return;

    opts = opts || {};
    const skipPelvisNudge = !!opts.skipPelvisNudge;
    const skipSpine = !!opts.skipSpine;
    const limbScale = opts.limbScale == null ? 1 : opts.limbScale;
    const legsOnly = !!opts.legsOnly;
    const armsOnly = !!opts.armsOnly;

    const str = strength == null ? 1 : Math.max(0.35, strength);
    const stageMul = stage === 1 ? 0.9 : stage === 2 ? 1.2 : 1.55;

    const dir = _boneLinVel.copy(shotDir);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
    else dir.normalize();

    const norm = _spawnBaseVel.copy(impactNormal || shotDir);
    if (norm.lengthSq() < 1e-8) norm.copy(dir);
    else norm.normalize();

    const transX = (dir.x * 0.68 + norm.x * 0.32) * str * stageMul * 0.062;
    const transY = norm.y * str * stageMul * 0.022;
    const transZ = (dir.z * 0.68 + norm.z * 0.32) * str * stageMul * 0.062;

    const bodyCount = human.bodies.length;
    for (let i = 0; i < bodyCount; i++) {
      const body = human.bodies[i];
      if (!body) continue;

      const isDynamic = !human.dynamicFlags || human.dynamicFlags[i];

      if (!isDynamic && b3.b3Body_SetTransform && b3.b3Body_GetPosition && b3.b3Body_GetRotation) {
        if (skipPelvisNudge && i === 0) continue;
        if (legsOnly || armsOnly || skipSpine) continue;
        const pos = b3.b3Body_GetPosition(body);
        const rot = b3.b3Body_GetRotation(body);
        b3.b3Body_SetTransform(body, {
          x: pos.x + transX,
          y: pos.y + transY,
          z: pos.z + transZ
        }, rot);
        continue;
      }

      if (!isDynamic || !b3.b3Body_SetLinearVelocity) continue;
      if (legsOnly && i < 6) continue;
      if (armsOnly && (i < 10 || i > 15)) continue;
      if (skipSpine && i >= 0 && i <= 5) continue;

      let spineMag = 0;
      if (i >= 1 && i <= 3) {
        if (legsOnly || armsOnly || skipSpine) continue;
        spineMag = str * stageMul * (i === 3 ? 4.8 : 3.6);
      } else if (i >= 6) {
        if (armsOnly && i < 10) continue;
        spineMag = str * stageMul * 5.2 * limbScale;
      } else {
        continue;
      }

      let vx = dir.x * spineMag + norm.x * str * stageMul * 0.85 * (i >= 6 ? limbScale : 1);
      let vy = dir.y * spineMag * 0.35 + norm.y * str * stageMul * 0.75 * (i >= 6 ? limbScale : 1);
      let vz = dir.z * spineMag + norm.z * str * stageMul * 0.85 * (i >= 6 ? limbScale : 1);

      if (b3.b3Body_GetLinearVelocity) {
        const cur = b3.b3Body_GetLinearVelocity(body);
        vx += cur.x;
        vy += cur.y;
        vz += cur.z;
      }

      const maxSpd = opts.maxSpeed != null ? opts.maxSpeed : (9.5 * str * stageMul);
      const sp = Math.hypot(vx, vy, vz);
      if (sp > maxSpd) {
        const s = maxSpd / sp;
        vx *= s;
        vy *= s;
        vz *= s;
      }

      b3.b3Body_SetLinearVelocity(body, { x: vx, y: vy, z: vz });
      if (b3.b3Body_SetAwake) b3.b3Body_SetAwake(body, true);
    }
  }

  window.Box3DRagdollRetarget = {
    MIXAMO_BONE_KEYS,
    HAND_BODY_IDX,
    REGION_BODY_INDICES,
    SHOT_IMPULSE_RADIUS,
    calibrate,
    alignHumanToMeshAnchors,
    alignBodyCapsuleAxesToMesh,
    snapHandBodiesFromMesh,
    syncHumanFromMixamo,
    apply,
    applyRotations,
    positionEntity,
    sampleMixamoBoneLinearVel,
    applyMixamoSpawnMomentum,
    applyShotImpulse,
    applyStumbleImpulse
  };
})();
