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
    'rightForearm'
  ];

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

  // Elbows (revolute joints): drive the forearm from upper/lower-arm *relative* rotation.
  // Absolute offset retarget fails here because both segments share the same world delta
  // when the arm swings, wiping out the hinge flex (legs don't have this problem).
  const FOREARM_HINGE_PARENT = {
    11: 10, // leftForearm  ← upper_arm_l / leftUpperArm
    13: 12  // rightForearm ← upper_arm_r / rightUpperArm
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
        continue;
      }

      bone.getWorldQuaternion(_boneWorldQuat);
      bodyWorldQuaternion(b3, human.bodies[i], _bodyQuat);
      offsets[i] = _bodyQuat.clone().invert().multiply(_boneWorldQuat);
    }

    const entityWorld0 = new THREE.Vector3();
    mixamoComp.el.object3D.getWorldPosition(entityWorld0);
    const pelvis = b3.b3Body_GetPosition(human.bodies[0]);
    const pelvisWorld0 = new THREE.Vector3(pelvis.x, pelvis.y, pelvis.z);

    const shoulderRest = {};
    ['leftShoulder', 'rightShoulder'].forEach((k) => {
      if (mixamoComp.bones[k]) shoulderRest[k] = mixamoComp.bones[k].quaternion.clone();
    });

    return { offsets, forearmHingeOffsets, entityWorld0, pelvisWorld0, shoulderRest };
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

    if (state.shoulderRest) {
      Object.keys(state.shoulderRest).forEach((k) => {
        if (mixamoComp.bones[k]) {
          mixamoComp.bones[k].quaternion.copy(state.shoulderRest[k]);
          mixamoComp.bones[k].updateMatrixWorld(true);
        }
      });
    }

    for (let i = 0; i < MIXAMO_BONE_KEYS.length; i++) {
      const bone = mixamoComp.bones[MIXAMO_BONE_KEYS[i]];
      if (!bone || !human.bodies[i]) continue;

      const forearmHinge = state.forearmHingeOffsets && state.forearmHingeOffsets[i];
      if (forearmHinge) {
        const parentIdx = FOREARM_HINGE_PARENT[i];
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
      _desiredWorld.copy(_bodyQuat).multiply(offset);

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
    }

    mixamoComp.skeleton.update();
    if (mixamoComp.model) mixamoComp.model.updateMatrixWorld(true);
  }

  function apply(mixamoComp, b3, human, state) {
    if (!mixamoComp || !b3 || !human || !state) return;
    positionEntity(mixamoComp, b3, human, state);
    applyRotations(mixamoComp, b3, human, state);
  }

  window.Box3DRagdollRetarget = {
    MIXAMO_BONE_KEYS,
    calibrate,
    alignHumanToMeshAnchors,
    syncHumanFromMixamo,
    apply,
    applyRotations,
    positionEntity
  };
})();
