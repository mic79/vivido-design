/**
 * grabbable-ragdoll — a standalone Mixamo character that starts static (bind/T-pose)
 * and becomes a physics ragdoll the moment a hand grabs it. While held, the grabbed
 * body chases the hand (the rest of the body swings from the joints); on release the
 * hand's velocity is imparted so it can be thrown. Once ragdolled it stays a ragdoll,
 * so it remains grabbable/throwable after it settles on the floor.
 *
 * It reuses the shared physics world + ragdoll modules but does NOT touch the player's
 * ragdoll or collider: it calls Box3DRagdoll.createHuman directly (not spawnRagdoll).
 */
// Visible limb segments for palm raycast / nearest-target (matches Mixamo mesh, not raw physics).
const MESH_BODY_SEGS = {
  0: ['hips', 'spine'],
  1: ['spine', 'spine1'],
  2: ['spine1', 'spine2'],
  3: ['spine2', 'neck'],
  4: ['neck', 'head'],
  5: ['neck', 'head'],
  6: ['leftUpLeg', 'leftLeg'],
  7: ['leftLeg', 'leftFoot'],
  8: ['rightUpLeg', 'rightLeg'],
  9: ['rightLeg', 'rightFoot'],
  10: ['leftUpperArm', 'leftForearm'],
  11: ['leftForearm', 'leftHand'],
  12: ['rightUpperArm', 'rightForearm'],
  13: ['rightForearm', 'rightHand'],
  14: ['leftForearm', 'leftHand'],
  15: ['rightForearm', 'rightHand']
};

AFRAME.registerComponent('grabbable-ragdoll', {
  schema: {
    modelPath: { type: 'string', default: 'character.glb' },
    x: { type: 'number', default: 1.4 },
    y: { type: 'number', default: 0 },
    z: { type: 'number', default: -1.6 },
    grabRadius: { type: 'number', default: 0.10 },
    // Debug preview only (magenta line) — grab uses grabRadius on palm contact.
    touchRadius: { type: 'number', default: 0.14 },
    // Capsule density (kg/m³). Default Box3D ~1.0 is very light; ~3.5 feels human-ish
    // and makes dragging/lifting off the floor noticeably heavier without touching grab.
    bodyDensity: { type: 'number', default: 3.5 },
    // Approximate dead-lift capacity per hand (kg) for peel-off-from-floor limit.
    liftPerHandKg: { type: 'number', default: 14 },
    // One-hand hold (and player arm) cannot rise above floor Y + this (metres).
    maxHoldAboveFloor: { type: 'number', default: 1.0 },
    // Extra height when two hands are holding (added to maxHoldAboveFloor).
    twoHandHoldBonus: { type: 'number', default: 0.45 }
  },

  init: function () {
    this.sceneEl = this.el.sceneEl;
    this.leftController = document.querySelector('#left-hand');
    this.rightController = document.querySelector('#right-hand');

    this.model = null;
    this.skeleton = null;
    this.bones = {};
    this.modelLoaded = false;
    this.ankleToSoleM = 0.08;

    this.human = null;
    this.retargetState = null;
    this.ragdollActive = false;
    this.group = null;

    // Per-hand grab state.
    this._held = { left: -1, right: -1 };
    this._handPos = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this._handPrev = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this._handVel = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this._handQuat = { left: new THREE.Quaternion(), right: new THREE.Quaternion() };
    this._handInit = { left: false, right: false };
    // Orientation offset (hand → grabbed body) captured at grab, so the held body
    // keeps its relative pose to the controller: bodyQuat = handQuat * relQuat.
    this._grabRel = { left: new THREE.Quaternion(), right: new THREE.Quaternion() };
    // Contact point offset from physics body center (body-local). Keeps the grabbed
    // mesh point pinned to the controller — never snap the capsule origin to the hand.
    this._grabOffsetLocal = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    // World anchor at grab — same role as mixamo-body _grabAnchorLeft on static surfaces.
    this._grabAnchorWorld = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this._effectiveHoldPos = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this._holdSmoothedQuat = { left: new THREE.Quaternion(), right: new THREE.Quaternion() };
    this._holdQuatReady = { left: false, right: false };
    this._holdEffReady = { left: false, right: false };
    this._cachedRigidLiftMax = null;
    this._cachedRigidLiftRefY = null;
    this._holdStart = { left: null, right: null };
    this._liftCeilingY = null;
    this._sessionLowestY = null;
    this._sessionSupportY = null;
    this._sessionPelvisY = null;
    this._spawnedStanding = false;
    this._playerArmHold = {
      left: { active: false, wristWorld: new THREE.Vector3(), overloaded: false },
      right: { active: false, wristWorld: new THREE.Vector3(), overloaded: false }
    };
    this._forceDetached = { left: false, right: false };
    this._holdMotionPrev = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this._holdMotionIntensity = { left: 0, right: 0 };
    this._holdMotionInit = { left: false, right: false };
    this._savedBodyTransforms = null;
    this._lastDt = 0.016;
    this.FLOOR_Y = 0;
    this.FLOOR_EPS = 0.1;
    this.OVERLOAD_DIST = 0.03;
    // Legacy small deltas — floor-relative cap (maxHoldAboveFloor) is the main limit.
    this.SINGLE_HAND_LIFT_M = 0.06;
    this.TWO_HAND_LIFT_M = 0.35;
    this.UPRIGHT_GRAB_SPAN_M = 0.45;

    this._tmpV = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._segA = new THREE.Vector3();
    this._segB = new THREE.Vector3();
    this._segAB = new THREE.Vector3();
    this._segAP = new THREE.Vector3();
    this._segQuat = new THREE.Quaternion();
    this._closestAxis = new THREE.Vector3();
    this._rayOrigin = new THREE.Vector3();
    this._rayDir = new THREE.Vector3();
    this._palmRadius = 0.026;
    this._palmQueryTmp = new THREE.Vector3();
    this._bonePosTmp = new THREE.Vector3();
    this._skinnedMeshes = [];
    this._meshRaycaster = new THREE.Raycaster();
    this._meshRayOri = new THREE.Vector3();
    this._meshRayDir = new THREE.Vector3();
    this._modelCenter = new THREE.Vector3();
    this._meshHitTmp = new THREE.Vector3();
    this._ragdollBoundsRadius = 0.9;
    this._meshSyncTime = -1;

    this._grabPressed = { left: false, right: false };

    this.el.object3D.position.set(this.data.x, this.data.y, this.data.z);

    this.MAX_THROW_SPEED = 14;

    this._loadWhenReady();
  },

  _loadWhenReady: function () {
    const ready =
      window.BodyRiggedLoaders?.ready &&
      this.sceneEl.components['leg-ik-world']?.b3 &&
      this.sceneEl.components['leg-ik-world']?.world;
    if (!ready) {
      setTimeout(() => this._loadWhenReady(), 100);
      return;
    }
    this.legIk = this.sceneEl.components['leg-ik-world'];
    this.b3 = this.legIk.b3;
    this.world = this.legIk.world;
    this._loadModel();
  },

  _loadModel: function () {
    const path = this.data.modelPath;
    const loader = new window.BodyRiggedLoaders.GLTFLoader();
    loader.load(
      path,
      (gltf) => this._onModelLoaded(gltf.scene),
      undefined,
      (err) => console.error('[grabbable-ragdoll] model load error:', err)
    );
  },

  _onModelLoaded: function (modelRoot) {
    this.model = modelRoot;
    modelRoot.scale.set(1, 1, 1);
    modelRoot.position.y = 0.05;
    modelRoot.rotation.y = Math.PI;

    this.el.object3D.add(modelRoot);

    modelRoot.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        node.frustumCulled = false;
        if (node.material) node.material = node.material.clone();
      }
      if (node.isSkinnedMesh && node.skeleton) {
        this.skeleton = node.skeleton;
        this._skinnedMeshes.push(node);
      }
    });

    this._mapBones();
    if (this.model) {
      const box = new THREE.Box3().setFromObject(this.model);
      box.getSize(this._tmpV);
      this._ragdollBoundsRadius = Math.max(0.55, this._tmpV.length() * 0.55);
    }
    this.modelLoaded = true;

    // Snapshot the exact loaded ("static T-pose") transforms so reset restores the
    // character byte-for-byte instead of relying on skeleton.pose() (which for this
    // GLB can collapse the mesh) or on the physics-driven entity position.
    this._staticPose = {
      entityPos: new THREE.Vector3(this.data.x, this.data.y, this.data.z),
      entityQuat: this.el.object3D.quaternion.clone(),
      entityScale: this.el.object3D.scale.clone(),
      modelPos: this.model.position.clone(),
      modelQuat: this.model.quaternion.clone(),
      modelScale: this.model.scale.clone(),
      bones: this.skeleton
        ? this.skeleton.bones.map((b) => ({
            bone: b,
            pos: b.position.clone(),
            quat: b.quaternion.clone(),
            scale: b.scale.clone()
          }))
        : []
    };
    console.log('[grabbable-ragdoll] ready at', this.data.x, this.data.z);
  },

  // Mirror mixamo-body.mapBones for exactly the keys the retarget needs.
  _mapBones: function () {
    const map = {
      mixamorigHips: 'hips',
      mixamorigSpine: 'spine',
      mixamorigSpine1: 'spine1',
      mixamorigSpine2: 'spine2',
      mixamorigNeck: 'neck',
      mixamorigHead: 'head',
      mixamorigLeftShoulder: 'leftShoulder',
      mixamorigLeftArm: 'leftUpperArm',
      mixamorigLeftForeArm: 'leftForearm',
      mixamorigLeftHand: 'leftHand',
      mixamorigRightShoulder: 'rightShoulder',
      mixamorigRightArm: 'rightUpperArm',
      mixamorigRightForeArm: 'rightForearm',
      mixamorigRightHand: 'rightHand',
      mixamorigLeftUpLeg: 'leftUpLeg',
      mixamorigLeftLeg: 'leftLeg',
      mixamorigLeftFoot: 'leftFoot',
      mixamorigRightUpLeg: 'rightUpLeg',
      mixamorigRightLeg: 'rightLeg',
      mixamorigRightFoot: 'rightFoot'
    };
    if (!this.skeleton) return;
    this.skeleton.bones.forEach((bone) => {
      const norm = bone.name.replace(/^mixamorig:/, 'mixamorig');
      const key = map[norm];
      if (key) this.bones[key] = bone;
    });
  },

  // Retarget contract note: this component IS the mixamoComp passed to the retarget
  // (it exposes .bones/.skeleton/.model/.el.object3D). data.isMirror is undefined
  // (falsy) so positionEntity runs and the model follows the physics pelvis.

  _getAnkleToSoleM: function () {
    return this.ankleToSoleM;
  },

  _isGrabPressed: function (hand) {
    const ctrl = hand === 'left' ? this.leftController : this.rightController;
    const tc = ctrl && ctrl.components['tracked-controls'];
    const gamepad = tc ? tc.controller?.gamepad : null;
    const btn = gamepad && gamepad.buttons ? gamepad.buttons[1] : null;
    if (!btn) return false;
    return btn.pressed || btn.value >= 0.45;
  },

  _spawnRagdoll: function () {
    const R = window.Box3DRagdoll;
    const RT = window.Box3DRagdollRetarget;
    if (!R || !RT || !this.b3 || !this.world) return false;

    this.el.object3D.getWorldPosition(this._tmpV);
    const basePos = { x: this._tmpV.x, y: 0, z: this._tmpV.z };

    this.group = (this.legIk.physics.ragdollGroup++ ) || 1;
    this.human = R.createHuman(
      this.b3, this.world, basePos, this.group,
      0, undefined, undefined,
      {
        enableJointMotors: false,
        density: this.data.bodyDensity,
        floppyLimbs: true
      }
    );

    // Physics reference has left/right on opposite X from the GLB (model.rotation.y = π).
    // alignHumanToMeshAnchors only translates — without this yaw the capsules sit on the
    // wrong sides and grabbing a visible leg/arm picks the opposite physics body.
    if (R.rotateHumanYaw) R.rotateHumanYaw(this.b3, this.human, Math.PI);

    // Snap physics bodies onto the live mesh pose, then calibrate the retarget so
    // frame 0 reproduces the visible character exactly (no pop).
    RT.alignHumanToMeshAnchors(this, this.b3, this.human);
    RT.snapHandBodiesFromMesh(this, this.b3, this.human);
    this.retargetState = RT.calibrate(this, this.b3, this.human);
    this.ragdollActive = true;
    this._spawnedStanding = true;
    return true;
  },

  // Tear the ragdoll down and return the character to its initial static T-pose at
  // its spawn location. Called by B / R so each press re-arms the dummy.
  resetRagdoll: function () {
    if (!this.modelLoaded || !this.model) return;

    // Drop any held hands without imparting a throw.
    this._held.left = -1;
    this._held.right = -1;
    this._holdStart.left = null;
    this._holdStart.right = null;
    this._holdEffReady.left = false;
    this._holdEffReady.right = false;
    this._holdQuatReady.left = false;
    this._holdQuatReady.right = false;
    this._grabOffsetLocal.left.set(0, 0, 0);
    this._grabOffsetLocal.right.set(0, 0, 0);
    this._grabAnchorWorld.left.set(0, 0, 0);
    this._grabAnchorWorld.right.set(0, 0, 0);
    this._cachedRigidLiftMax = null;
    this._cachedRigidLiftRefY = null;
    this._liftCeilingY = null;
    this._sessionLowestY = null;
    this._sessionSupportY = null;
    this._sessionPelvisY = null;
    this._spawnedStanding = false;
    this._handInit.left = false;
    this._handInit.right = false;
    this._forceDetached.left = false;
    this._forceDetached.right = false;
    this._holdMotionIntensity.left = 0;
    this._holdMotionIntensity.right = 0;
    this._holdMotionInit.left = false;
    this._holdMotionInit.right = false;
    this._clearPlayerArmHold();

    if (this.human && window.Box3DRagdoll?.destroyHuman && this.b3) {
      window.Box3DRagdoll.destroyHuman(this.b3, this.human);
    }
    this.human = null;
    this.retargetState = null;
    this.ragdollActive = false;
    this.group = null;

    this._restoreStaticPose();
  },

  _restoreStaticPose: function () {
    const st = this._staticPose;
    if (!st || !this.model) return;

    this.el.object3D.position.copy(st.entityPos);
    this.el.object3D.quaternion.copy(st.entityQuat);
    this.el.object3D.scale.copy(st.entityScale);

    this.model.visible = true;
    this.model.position.copy(st.modelPos);
    this.model.quaternion.copy(st.modelQuat);
    this.model.scale.copy(st.modelScale);

    // Restore every bone's captured local transform (exact T-pose the model loaded
    // with) rather than skeleton.pose(), which can produce a collapsed/invisible mesh.
    for (let i = 0; i < st.bones.length; i++) {
      const b = st.bones[i];
      b.bone.position.copy(b.pos);
      b.bone.quaternion.copy(b.quat);
      b.bone.scale.copy(b.scale);
    }

    this.el.object3D.updateMatrixWorld(true);
    if (this.skeleton) this.skeleton.update();
    this.model.updateMatrixWorld(true);
    this.model.traverse((node) => {
      if (node.isMesh) node.visible = true;
    });
  },

  // Distance from a point to a segment (both THREE.Vector3), reusing scratch vecs.
  _distToSegment: function (p, a, b) {
    this._segAB.copy(b).sub(a);
    this._segAP.copy(p).sub(a);
    const abLen2 = this._segAB.lengthSq() || 1e-6;
    let t = this._segAP.dot(this._segAB) / abLen2;
    t = Math.max(0, Math.min(1, t));
    this._segAP.copy(a).addScaledVector(this._segAB, t);
    return this._segAP.distanceTo(p);
  },

  // Box3D body index for a Mixamo bone key (matches MIXAMO_BONE_KEYS / BONES order).
  _bodyIdxForBoneKey: function (key) {
    const keys = window.Box3DRagdollRetarget?.MIXAMO_BONE_KEYS || [];
    const idx = keys.indexOf(key);
    return idx >= 0 ? idx : -1;
  },

  _tryPointGrab: function (handPos, boneKey, pad, bestIdx, bestD, bodyIdxOverride) {
    const bone = this.bones[boneKey];
    const bodyIdx = bodyIdxOverride != null
      ? bodyIdxOverride
      : this._bodyIdxForBoneKey(boneKey);
    if (!bone || bodyIdx < 0) return { idx: bestIdx, d: bestD };
    bone.getWorldPosition(this._bonePosTmp);
    const d = this._bonePosTmp.distanceTo(handPos) - pad;
    if (d < bestD) return { idx: bodyIdx, d };
    return { idx: bestIdx, d: bestD };
  },

  _trySegmentGrab: function (handPos, keyA, keyB, bodyIdx, pad, bestIdx, bestD) {
    const a = this.bones[keyA];
    const b = this.bones[keyB];
    if (!a || !b || bodyIdx < 0) return { idx: bestIdx, d: bestD };
    a.getWorldPosition(this._segA);
    b.getWorldPosition(this._segB);
    const d = this._distToSegment(handPos, this._segA, this._segB) - pad;
    if (d < bestD) return { idx: bodyIdx, d };
    return { idx: bestIdx, d: bestD };
  },

  // Two-hand lift bonus only when BOTH controllers are actively pulling up —
  // touching with a second hand must not raise peel/ceiling limits instantly.
  _twoHandLiftBonusActive: function () {
    if (this._heldHandCount() < 2) return false;
    const thresh = 0.02;
    let leftOk = this._held.left < 0;
    let rightOk = this._held.right < 0;
    if (this._held.left >= 0 && this._holdStart.left) {
      leftOk = this._handPos.left.y >= this._holdStart.left.handY + thresh;
    }
    if (this._held.right >= 0 && this._holdStart.right) {
      rightOk = this._handPos.right.y >= this._holdStart.right.handY + thresh;
    }
    return leftOk && rightOk;
  },

  _isZeroGMode: function () {
    return !!(window.BodyRiggedGravity && window.BodyRiggedGravity.isZeroG());
  },

  _isLimbBody: function (idx) {
    return idx >= 6;
  },

  _isArmLimbBody: function (idx) {
    return idx >= 10 && idx <= 15;
  },

  // Wrist hand capsules (14/15) only when the palm is actually at the hand.
  _handBodyEligible: function (idx, handPos) {
    if (idx < 14) return true;
    const keys = MESH_BODY_SEGS[idx];
    if (!keys || !this.bones) return false;
    const handBone = this.bones[keys[1]];
    if (!handBone) return false;
    handBone.getWorldPosition(this._tmpV);
    return this._tmpV.distanceTo(handPos) <= 0.07;
  },

  // Limbs/hands get a larger effective grab radius; torso is slightly deprioritized.
  _grabReachForBody: function (idx, baseDist, handPos) {
    if (idx >= 14) {
      return (handPos && this._handBodyEligible(idx, handPos)) ? baseDist * 1.2 : 0;
    }
    if (idx >= 10) return baseDist * 1.35;
    if (idx >= 6) return baseDist * 1.2;
    if (idx <= 5) return baseDist * 0.92;
    return baseDist;
  },

  _nearestMeshLimbTarget: function (handPos, maxDist) {
    if (!this.skeleton) return -1;
    this._syncMeshWorldMatrices();
    let best = -1;
    let bestD = maxDist;
    for (let i = 6; i <= 15; i++) {
      if (!this._handBodyEligible(i, handPos)) continue;
      const keys = MESH_BODY_SEGS[i];
      if (!keys) continue;
      const boneA = this.bones[keys[0]];
      const boneB = this.bones[keys[1]];
      if (!boneA || !boneB) continue;
      boneA.getWorldPosition(this._segA);
      boneB.getWorldPosition(this._segB);
      const pad = i >= 14 ? 0.04 : (i >= 10 ? 0.045 : 0.035);
      const d = this._distToSegment(handPos, this._segA, this._segB) - pad;
      const limit = this._grabReachForBody(i, maxDist, handPos);
      if (limit > 0 && d < limit && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  },

  _nearestTargetWithin: function (handPos, maxDist) {
    let best = -1;
    let bestD = maxDist;
    const torsoBias = 0.055;
    if (this.ragdollActive && this.human) {
      const BONES = window.Box3DRagdoll.BONES;
      for (let i = 0; i < this.human.bodies.length; i++) {
        if (!this._handBodyEligible(i, handPos)) continue;
        const bone = BONES[i];
        const p = this.b3.b3Body_GetPosition(this.human.bodies[i]);
        const r = this.b3.b3Body_GetRotation(this.human.bodies[i]);
        this._segQuat.set(r.v.x, r.v.y, r.v.z, r.s);
        this._segA.set(bone.c1.x, bone.c1.y, bone.c1.z).applyQuaternion(this._segQuat).add(p);
        this._segB.set(bone.c2.x, bone.c2.y, bone.c2.z).applyQuaternion(this._segQuat).add(p);
        const rawD = this._distToSegment(handPos, this._segA, this._segB) - bone.radius;
        const score = rawD + (i <= 5 ? torsoBias : 0);
        const limit = this._grabReachForBody(i, maxDist, handPos);
        if (limit > 0 && score < limit && score < bestD) {
          bestD = score;
          best = i;
        }
      }
    } else {
      const keys = window.Box3DRagdollRetarget?.MIXAMO_BONE_KEYS || [];
      for (let i = 0; i < keys.length; i++) {
        if (!this._handBodyEligible(i, handPos)) continue;
        const bone = this.bones[keys[i]];
        if (!bone) continue;
        bone.getWorldPosition(this._tmpV);
        const rawD = this._tmpV.distanceTo(handPos);
        const score = rawD + (i <= 5 ? torsoBias : 0);
        const limit = this._grabReachForBody(i, maxDist, handPos);
        if (limit > 0 && score < limit && score < bestD) {
          bestD = score;
          best = i;
        }
      }
    }
    return best;
  },

  _nearestTarget: function (handPos) {
    const r = this.data.grabRadius;
    const limb = this._nearestMeshLimbTarget(handPos, r * 1.15);
    if (limb >= 0) return limb;
    return this._nearestTargetWithin(handPos, r);
  },

  _isPalmNearRagdoll: function (palmWorld) {
    if (!this.model || !palmWorld) return false;
    this.model.getWorldPosition(this._modelCenter);
    const reach = this._ragdollBoundsRadius + this.data.touchRadius + 0.1;
    return this._modelCenter.distanceToSquared(palmWorld) <= reach * reach;
  },

  isPalmNearRagdoll: function (palmWorld) {
    return this._isPalmNearRagdoll(palmWorld);
  },

  _nearestPreviewTarget: function (handPos) {
    const r = this.data.touchRadius;
    const idx = this._nearestMeshLimbTarget(handPos, r);
    if (idx >= 0) return idx;
    if (!this._skinnedMeshes.length) {
      return this._nearestTargetWithin(handPos, r);
    }
    return -1;
  },

  // One cheap ray against skinned mesh — grab-time only (not per-frame debug).
  _raycastSkinnedMeshSurfaceOnce: function (worldPos, towardHint, dest) {
    if (!this._skinnedMeshes.length || !towardHint) return false;
    this._syncMeshWorldMatrices();

    this._meshRayDir.copy(towardHint).sub(worldPos);
    const span = this._meshRayDir.length();
    if (span < 1e-4) return false;
    this._meshRayDir.multiplyScalar(1 / span);
    this._meshRayOri.copy(worldPos).addScaledVector(this._meshRayDir, -0.1);

    const raycaster = this._meshRaycaster;
    raycaster.set(this._meshRayOri, this._meshRayDir);
    raycaster.near = 0;
    raycaster.far = span + 0.28;

    let bestDist = Infinity;
    let found = false;
    for (let m = 0; m < this._skinnedMeshes.length; m++) {
      const hits = raycaster.intersectObject(this._skinnedMeshes[m], false);
      if (!hits.length) continue;
      const palmDist = hits[0].point.distanceTo(worldPos);
      if (palmDist > 0.35 || palmDist >= bestDist) continue;
      bestDist = palmDist;
      dest.copy(hits[0].point);
      found = true;
    }
    return found;
  },

  _meshSkinPointToward: function (idx, worldPos, dest) {
    if (!this._meshCapsuleEndpoints(idx, this._segA, this._segB)) {
      return dest.copy(worldPos);
    }
    this._segAB.copy(this._segB).sub(this._segA);
    this._segAP.copy(worldPos).sub(this._segA);
    const abLen2 = this._segAB.lengthSq() || 1e-6;
    let t = this._segAP.dot(this._segAB) / abLen2;
    t = Math.max(0, Math.min(1, t));
    this._closestAxis.copy(this._segA).addScaledVector(this._segAB, t);
    this._segAB.copy(worldPos).sub(this._closestAxis);
    const axisDist = this._segAB.length();
    if (axisDist > 1e-6) {
      const skinPush = Math.min(axisDist, 0.04);
      dest.copy(this._closestAxis).addScaledVector(this._segAB, skinPush / axisDist);
    } else {
      dest.copy(this._closestAxis);
    }
    return dest;
  },

  _contactWorldForGrab: function (idx, palmWorld, dest) {
    if (!this.skeleton) {
      return this._physicsCapsuleSurfaceToward(idx, palmWorld, dest);
    }
    let toward = null;
    if (this._meshCapsuleEndpoints(idx, this._segA, this._segB)) {
      toward = this._closestAxis.copy(this._segA).add(this._segB).multiplyScalar(0.5);
    } else if (this.model) {
      toward = this._modelCenter;
      this.model.getWorldPosition(toward);
    }
    if (toward && this._raycastSkinnedMeshSurfaceOnce(palmWorld, toward, dest)) {
      if (dest.distanceTo(palmWorld) < 0.06) {
        dest.copy(palmWorld);
      }
      return dest;
    }
    this._meshSkinPointToward(idx, palmWorld, dest);
    if (dest.distanceTo(palmWorld) < 0.06) {
      dest.copy(palmWorld);
    }
    return dest;
  },

  _physicsCapsuleSurfaceToward: function (idx, worldPoint, dest) {
    const BONES = window.Box3DRagdoll.BONES;
    const bone = BONES[idx];
    if (!this.human?.bodies?.[idx] || !this.b3 || !bone) return dest.copy(worldPoint);
    const p = this.b3.b3Body_GetPosition(this.human.bodies[idx]);
    const r = this.b3.b3Body_GetRotation(this.human.bodies[idx]);
    this._segQuat.set(r.v.x, r.v.y, r.v.z, r.s);
    this._segA.set(bone.c1.x, bone.c1.y, bone.c1.z).applyQuaternion(this._segQuat).add(p);
    this._segB.set(bone.c2.x, bone.c2.y, bone.c2.z).applyQuaternion(this._segQuat).add(p);
    this._segAB.copy(this._segB).sub(this._segA);
    this._segAP.copy(worldPoint).sub(this._segA);
    const abLen2 = this._segAB.lengthSq() || 1e-6;
    let t = this._segAP.dot(this._segAB) / abLen2;
    t = Math.max(0, Math.min(1, t));
    this._closestAxis.copy(this._segA).addScaledVector(this._segAB, t);
    this._segAB.copy(worldPoint).sub(this._closestAxis);
    const axisDist = this._segAB.length();
    if (axisDist > 1e-6) {
      dest.copy(this._closestAxis).addScaledVector(this._segAB, bone.radius / axisDist);
    } else {
      this._segAB.set(0, 0, 1);
      this._segAB.normalize();
      dest.copy(this._closestAxis).addScaledVector(this._segAB, bone.radius);
    }
    return dest;
  },

  // Frozen at grab — body-local offset from physics body center to mesh/palm contact.
  _captureGrabAnchor: function (hand, bodyPos, bodyQuat, contactWorld) {
    this._grabAnchorWorld[hand].copy(contactWorld);
    this._grabOffsetLocal[hand].copy(contactWorld);
    this._grabOffsetLocal[hand].x -= bodyPos.x;
    this._grabOffsetLocal[hand].y -= bodyPos.y;
    this._grabOffsetLocal[hand].z -= bodyPos.z;
    this._grabOffsetLocal[hand].applyQuaternion(bodyQuat.clone().invert());
  },

  _anchorWorldFromBody: function (hand, bodyPos, bodyQuat, dest) {
    dest.copy(this._grabOffsetLocal[hand]).applyQuaternion(bodyQuat);
    dest.x += bodyPos.x;
    dest.y += bodyPos.y;
    dest.z += bodyPos.z;
    return dest;
  },

  _bodyCenterForAnchor: function (hand, anchorWorld, bodyQuat, dest) {
    dest.copy(this._grabOffsetLocal[hand]).applyQuaternion(bodyQuat);
    dest.set(anchorWorld.x - dest.x, anchorWorld.y - dest.y, anchorWorld.z - dest.z);
    return dest;
  },

  /** Palm → ragdoll: cheap bone preview when near; mesh raycast only at grab time. */
  projectPalmOntoRagdoll: function (hand, palmWorld) {
    if (!this.modelLoaded || !palmWorld) return null;
    if (!this._isPalmNearRagdoll(palmWorld)) return null;

    const heldIdx = this._held[hand];
    if (heldIdx >= 0 && this.human?.bodies?.[heldIdx]) {
      return {
        palm: palmWorld.clone(),
        hit: palmWorld.clone(),
        bodyIdx: heldIdx,
        near: true,
        frozen: true
      };
    }

    if (!this.skeleton) return null;
    const previewIdx = this._nearestMeshLimbTarget(palmWorld, this.data.touchRadius);
    if (previewIdx < 0) return null;
    const hit = this._meshSkinPointToward(previewIdx, palmWorld, this._tmpV);
    return {
      palm: palmWorld.clone(),
      hit: hit.clone(),
      bodyIdx: previewIdx,
      near: true,
      frozen: false
    };
  },

  _syncMeshWorldMatrices: function () {
    if (!this.skeleton || !this.model) return;
    const t = this.el.sceneEl?.time;
    if (t === this._meshSyncTime) return;
    this._meshSyncTime = t;
    this.el.object3D.updateMatrixWorld(true);
    this.model.updateMatrixWorld(true);
    this.skeleton.update();
  },

  _meshCapsuleEndpoints: function (idx, outA, outB) {
    const keys = MESH_BODY_SEGS[idx];
    if (!keys || !this.skeleton) return false;
    const boneA = this.bones[keys[0]];
    const boneB = this.bones[keys[1]];
    if (!boneA || !boneB) return false;
    this._syncMeshWorldMatrices();
    boneA.getWorldPosition(outA);
    boneB.getWorldPosition(outB);
    return true;
  },

  getPlayerArmHold: function () {
    return this._playerArmHold;
  },

  isHandNearGrabbable: function (hand, handPos) {
    if (!this.modelLoaded || this._held[hand] >= 0) return false;
    if (!this._isPalmNearRagdoll(handPos)) return false;
    const probe = this._rayOrigin;
    const contact = this._bonePosTmp;
    const query = this._getPlayerPalm(hand, probe, contact) ? contact : handPos;
    return this._nearestTarget(query) >= 0;
  },

  getHoldMotionIntensity: function (hand) {
    return this._holdMotionIntensity[hand] || 0;
  },

  wasForceDetached: function (hand) {
    const flagged = !!this._forceDetached[hand];
    if (flagged) this._forceDetached[hand] = false;
    return flagged;
  },

  _updateHoldMotionIntensity: function (hand, dt) {
    if (this._held[hand] < 0 || !this.human || !this.b3) {
      this._holdMotionIntensity[hand] = 0;
      this._holdMotionInit[hand] = false;
      return;
    }
    const body = this.human.bodies[this._held[hand]];
    if (!body) return;
    const p = this.b3.b3Body_GetPosition(body);
    const prev = this._holdMotionPrev[hand];
    if (!this._holdMotionInit[hand]) {
      prev.set(p.x, p.y, p.z);
      this._holdMotionInit[hand] = true;
      this._holdMotionIntensity[hand] = 0;
      return;
    }
    const bodySpeed = Math.hypot(p.x - prev.x, p.y - prev.y, p.z - prev.z) / Math.max(dt, 0.001);
    const handSpeed = this._handVel[hand].length();
    const target = Math.max(bodySpeed, handSpeed * 0.4);
    const cur = this._holdMotionIntensity[hand];
    this._holdMotionIntensity[hand] = cur + (target - cur) * Math.min(1, dt * 10);
    prev.set(p.x, p.y, p.z);
  },

  _clearPlayerArmHold: function (hand) {
    if (hand) {
      this._playerArmHold[hand].active = false;
      this._playerArmHold[hand].overloaded = false;
      return;
    }
    this._playerArmHold.left.active = false;
    this._playerArmHold.left.overloaded = false;
    this._playerArmHold.right.active = false;
    this._playerArmHold.right.overloaded = false;
  },

  _setBodyTransform: function (idx, p, q) {
    const body = this.human.bodies[idx];
    if (!body) return;
    const zero = { x: 0, y: 0, z: 0 };
    if (this.b3.b3Body_SetLinearVelocity) this.b3.b3Body_SetLinearVelocity(body, zero);
    if (this.b3.b3Body_SetAngularVelocity) this.b3.b3Body_SetAngularVelocity(body, zero);
    this.b3.b3Body_SetTransform(
      body,
      { x: p.x, y: p.y, z: p.z },
      { v: { x: q.x, y: q.y, z: q.z }, s: q.w }
    );
    if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);
  },

  // Nearest visible mesh point for a physics body index (contact ≠ capsule center).
  _meshContactForBodyIdx: function (idx, handPos, dest) {
    const segMap = {
      10: ['leftUpperArm'],
      11: ['leftForearm'],
      12: ['rightUpperArm'],
      13: ['rightForearm'],
      14: ['leftHand'],
      15: ['rightHand'],
      7: ['leftLeg', 'leftFoot'],
      9: ['rightLeg', 'rightFoot'],
      6: ['leftUpLeg'],
      8: ['rightUpLeg'],
      0: ['hips'],
      1: ['spine'],
      2: ['spine1'],
      3: ['spine2'],
      4: ['neck'],
      5: ['head']
    };
    const keys = segMap[idx];
    if (!keys || !this.skeleton) {
      return dest.copy(handPos);
    }
    this.el.object3D.updateMatrixWorld(true);
    if (this.skeleton) this.skeleton.update();
    let bestD = Infinity;
    let found = false;
    for (let i = 0; i < keys.length; i++) {
      const bone = this.bones[keys[i]];
      if (!bone) continue;
      bone.getWorldPosition(this._tmpV);
      const d = this._tmpV.distanceTo(handPos);
      if (d < bestD) {
        bestD = d;
        dest.copy(this._tmpV);
        found = true;
      }
    }
    if (!found) dest.copy(handPos);
    return dest;
  },

  _getPlayerPalm: function (hand, probeOut, contactOut) {
    const mb = document.querySelector('#local-body')?.components['mixamo-body'];
    if (mb?.modelLoaded && mb._getHandPalmProbeWorldPos && mb._getHandPalmContactWorldPos) {
      if (mb.model) mb.model.updateMatrixWorld(true);
      if (mb.skeleton) mb.skeleton.update();
      mb._getHandPalmProbeWorldPos(hand, probeOut);
      mb._getHandPalmContactWorldPos(hand, contactOut);
      return true;
    }
    probeOut.copy(this._handPos[hand]);
    contactOut.copy(this._handPos[hand]);
    return false;
  },

  _capsuleEndpoints: function (idx, outA, outB) {
    if (this._meshCapsuleEndpoints(idx, outA, outB)) return;
    if (!this.human || !this.b3) return;
    const BONES = window.Box3DRagdoll.BONES;
    const bone = BONES[idx];
    const body = this.human.bodies[idx];
    if (!bone || !body) return;
    const p = this.b3.b3Body_GetPosition(body);
    const r = this.b3.b3Body_GetRotation(body);
    this._segQuat.set(r.v.x, r.v.y, r.v.z, r.s);
    outA.set(bone.c1.x, bone.c1.y, bone.c1.z).applyQuaternion(this._segQuat).add(p);
    outB.set(bone.c2.x, bone.c2.y, bone.c2.z).applyQuaternion(this._segQuat).add(p);
  },

  /** Closest point on capsule surface toward worldPoint (physics capsule, not bone pivot). */
  _capsuleSurfaceToward: function (idx, worldPoint, dest, normalOut) {
    const BONES = window.Box3DRagdoll.BONES;
    const bone = BONES[idx];
    this._capsuleEndpoints(idx, this._segA, this._segB);
    this._segAB.copy(this._segB).sub(this._segA);
    this._segAP.copy(worldPoint).sub(this._segA);
    const abLen2 = this._segAB.lengthSq() || 1e-6;
    let t = this._segAP.dot(this._segAB) / abLen2;
    t = Math.max(0, Math.min(1, t));
    this._closestAxis.copy(this._segA).addScaledVector(this._segAB, t);
    this._segAB.copy(worldPoint).sub(this._closestAxis);
    const axisDist = this._segAB.length();
    if (axisDist > 1e-6) {
      dest.copy(this._closestAxis).addScaledVector(this._segAB, bone.radius / axisDist);
      if (normalOut) normalOut.copy(this._segAB).multiplyScalar(1 / axisDist);
    } else {
      this._segAB.set(0, 0, 1);
      if (this._handPos.left && this._handPos.right) {
        this._segAB.copy(worldPoint).sub(this._closestAxis);
      }
      if (this._segAB.lengthSq() < 1e-8) this._segAB.set(0, 0, 1);
      this._segAB.normalize();
      dest.copy(this._closestAxis).addScaledVector(this._segAB, bone.radius);
      if (normalOut) normalOut.copy(this._segAB);
    }
    return dest;
  },

  _heldHandCount: function () {
    let n = 0;
    if (this._held.left >= 0) n++;
    if (this._held.right >= 0) n++;
    return n;
  },

  _getTotalMass: function () {
    if (!this.human || !this.b3?.b3Body_GetMass) return 55;
    let m = 0;
    for (let i = 0; i < this.human.bodies.length; i++) {
      const body = this.human.bodies[i];
      if (!body) continue;
      if (this.human.dynamicFlags && !this.human.dynamicFlags[i]) continue;
      m += this.b3.b3Body_GetMass(body) || 0;
    }
    // Box3D capsule masses are tiny with density alone; use a human-scale nominal
    // mass scaled by density so strength limits actually bite.
    const nominal = 55 * (this.data.bodyDensity / 3.5);
    return Math.max(m, nominal * 0.85);
  },

  _getSurfaceYAt: function (x, z, probeY) {
    if (this.legIk?.terrain?.getHeightAtWorld) {
      return this.legIk.terrain.getHeightAtWorld(x, z);
    }
    const queries = this.legIk?.queries;
    if (queries?.castRayDown) {
      const y0 = probeY ?? 30;
      const hit = queries.castRayDown(x, y0, z, y0 + 5, null);
      if (hit) return hit.point.y;
    }
    return this.FLOOR_Y;
  },

  // Highest environment surface under the ragdoll footprint (stairs/ramp aware).
  _getRagdollSupportSurfaceY: function () {
    if (!this.human?.bodies?.length || !this.b3) return this.FLOOR_Y;
    let surfaceY = this.FLOOR_Y;
    const sampleBody = (idx) => {
      const body = this.human.bodies[idx];
      if (!body) return;
      const p = this.b3.b3Body_GetPosition(body);
      const sy = this._getSurfaceYAt(p.x, p.z, Math.max(p.y + 2, 4));
      if (sy > surfaceY) surfaceY = sy;
    };
    sampleBody(0); // pelvis
    sampleBody(7); // calf_l
    sampleBody(9); // calf_r
    if (this._held.left >= 0) sampleBody(this._held.left);
    if (this._held.right >= 0) sampleBody(this._held.right);
    return surfaceY;
  },

  _isBodyOnGround: function (lowestY, surfaceY) {
    if (surfaceY == null) surfaceY = this._getRagdollSupportSurfaceY();
    return Number.isFinite(lowestY) && lowestY <= surfaceY + this.FLOOR_EPS;
  },

  _isUprightGrab: function (holdStart) {
    if (!holdStart) return false;
    if (holdStart.upright) return true;
    const supportY = holdStart.supportY ?? holdStart.lowestY ?? this.FLOOR_Y;
    return (holdStart.bodyY - supportY) > this.UPRIGHT_GRAB_SPAN_M;
  },

  _getFloorHoldMaxY: function (nHands, surfaceY) {
    if (surfaceY == null) surfaceY = this._getRagdollSupportSurfaceY();
    const base = this.data.maxHoldAboveFloor ?? 1.0;
    const bonus = this._twoHandLiftBonusActive() ? (this.data.twoHandHoldBonus ?? 0.45) : 0;
    return surfaceY + base + bonus;
  },

  _recomputeLiftCeiling: function () {
    const nHands = this._heldHandCount();
    if (nHands === 0) {
      this._liftCeilingY = null;
      this._sessionLowestY = null;
      this._sessionSupportY = null;
      this._sessionPelvisY = null;
      return;
    }
    this._liftCeilingY = this._getFloorHoldMaxY(nHands);
  },

  _saveBodyTransforms: function () {
    const saved = [];
    for (let i = 0; i < this.human.bodies.length; i++) {
      const p = this.b3.b3Body_GetPosition(this.human.bodies[i]);
      const r = this.b3.b3Body_GetRotation(this.human.bodies[i]);
      saved.push({
        p: { x: p.x, y: p.y, z: p.z },
        r: { v: { x: r.v.x, y: r.v.y, z: r.v.z }, s: r.s }
      });
    }
    this._savedBodyTransforms = saved;
  },

  _restoreBodyTransforms: function () {
    if (!this._savedBodyTransforms) return;
    for (let i = 0; i < this.human.bodies.length; i++) {
      const s = this._savedBodyTransforms[i];
      if (!s) continue;
      this.b3.b3Body_SetTransform(this.human.bodies[i], s.p, s.r);
    }
  },

  // Upper bound on rigid upward translate before feet leave the floor.
  _maxRigidLiftDy: function (maxDy) {
    const R = window.Box3DRagdoll;
    if (!R?.computeLowestY || !R.translateHuman || maxDy <= 0) return 0;

    this._saveBodyTransforms();
    let lo = 0;
    let hi = maxDy;
    let best = 0;
    for (let i = 0; i < 12; i++) {
      this._restoreBodyTransforms();
      const mid = (lo + hi) * 0.5;
      R.translateHuman(this.b3, this.human, 0, mid, 0);
      const low = R.computeLowestY(this.b3, this.human);
      // Feet still on floor while lowest point is at/near floor — NOT while floating.
      if (this._isBodyOnGround(low)) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    this._restoreBodyTransforms();
    this._savedBodyTransforms = null;
    return best;
  },

  // Ideal hold goal after weight/peel/floor caps.
  _computeHoldTarget: function (hand, idx, desiredPos, opts) {
    opts = opts || {};
    if (opts.skipCaps || this._isZeroGMode()) {
      return this._tmpV.set(desiredPos.x, desiredPos.y, desiredPos.z);
    }
    const eff = this._effectiveHoldPos[hand];
    const hs = this._holdStart[hand];
    this._tmpV.set(desiredPos.x, desiredPos.y, desiredPos.z);

    const nHands = this._heldHandCount();
    const surfaceY = this._getRagdollSupportSurfaceY();
    const floorHoldMaxY = this._getFloorHoldMaxY(nHands, surfaceY);
    let maxY = Math.min(desiredPos.y, floorHoldMaxY);

    // Standing / off-floor grab: only the absolute hand ceiling applies.
    if (this._isUprightGrab(hs)) {
      this._tmpV.y = maxY;
      return this._tmpV;
    }

    const R = window.Box3DRagdoll;
    const lowestY = R?.computeLowestY ? R.computeLowestY(this.b3, this.human) : surfaceY;

    if (!Number.isFinite(lowestY) || !this._isBodyOnGround(lowestY, surfaceY)) {
      // Airborne — no surface-relative height cap.
      this._tmpV.y = desiredPos.y;
      return this._tmpV;
    }

    // Peel-from-surface: lowest point may rise peelBudget above local support.
    const peelBudget = (this.data.maxHoldAboveFloor ?? 1.0)
      + (this._twoHandLiftBonusActive() ? (this.data.twoHandHoldBonus ?? 0.45) * 0.5 : 0);
    const maxAllowedLowest = surfaceY + peelBudget;
    const peelHeadroom = maxAllowedLowest - lowestY;

    if (peelHeadroom <= 0.003) {
      maxY = Math.min(maxY, floorHoldMaxY);
    } else if (desiredPos.y > eff.y + 0.001) {
      maxY = Math.min(maxY, eff.y + peelHeadroom * 0.95);
    }

    this._tmpV.y = Math.min(desiredPos.y, maxY);
    return this._tmpV;
  },

  // Move the effective hold toward the target — horizontal follows quickly; vertical
  // eases in only when weight/peel limits cap upward motion (never snap/teleport).
  _smoothHoldToward: function (hand, target, idx) {
    const eff = this._effectiveHoldPos[hand];
    // Limb bodies: large body-center→palm offset — smoothing leaves anchor far from palm.
    if (this._isLimbBody(idx)) {
      eff.copy(target);
      return eff;
    }
    const nHands = this._heldHandCount();
    const mass = this._getTotalMass();
    const capacity = nHands * this.data.liftPerHandKg;
    const supportRatio = capacity / Math.max(mass, 1);
    const vertRate = Math.max(10, 28 * Math.min(1, supportRatio));
    const horizRate = 48;
    const hAlpha = 1 - Math.exp(-horizRate * this._lastDt);
    const vAlpha = 1 - Math.exp(-vertRate * this._lastDt);
    eff.x += (target.x - eff.x) * hAlpha;
    eff.z += (target.z - eff.z) * hAlpha;
    eff.y += (target.y - eff.y) * vAlpha;
    return eff;
  },

  _updatePlayerArmHold: function (hand, smoothedBodyPos, anchorWorld) {
    const h = this._playerArmHold[hand];
    h.active = true;
    const idx = this._held[hand];
    const ctrl = this._handPos[hand];
    const weightTarget = idx >= 0
      ? this._computeHoldTarget(hand, idx, ctrl)
      : ctrl;
    // Player arms track the controller; ragdoll anchor is physics-only.
    h.wristWorld.copy(ctrl);
    if (ctrl.y > weightTarget.y) {
      h.wristWorld.y = weightTarget.y;
    }
    const dY = ctrl.y - h.wristWorld.y;
    h.overloaded = dY > 0.008 || ctrl.distanceTo(anchorWorld) > 0.22;
  },

  _attachBody: function (hand, idx, palmWorld) {
    const body = this.human.bodies[idx];
    if (!body) return;
    const cur = this.b3.b3Body_GetPosition(body);
    const R = window.Box3DRagdoll;
    const lowestY = R?.computeLowestY ? R.computeLowestY(this.b3, this.human) : this.FLOOR_Y;
    const surfaceY = this._getRagdollSupportSurfaceY();
    if (this._sessionLowestY == null && Number.isFinite(lowestY)) {
      this._sessionLowestY = lowestY;
    }
    if (this._sessionSupportY == null && Number.isFinite(surfaceY)) {
      this._sessionSupportY = surfaceY;
    }
    const pelvisBody = this.human.bodies[0];
    if (this._sessionPelvisY == null && pelvisBody) {
      this._sessionPelvisY = this.b3.b3Body_GetPosition(pelvisBody).y;
    }
    const upright = (cur.y - surfaceY) > this.UPRIGHT_GRAB_SPAN_M || this._spawnedStanding;
    this._spawnedStanding = false;
    this._holdStart[hand] = {
      bodyY: cur.y,
      lowestY,
      supportY: surfaceY,
      handY: this._handPos[hand].y,
      upright
    };
    const r = this.b3.b3Body_GetRotation(body);
    this._tmpQ.set(r.v.x, r.v.y, r.v.z, r.s);
    const bodyPos = { x: cur.x, y: cur.y, z: cur.z };
    const contactWorld = this._contactWorldForGrab(idx, palmWorld, this._segA);
    this._captureGrabAnchor(hand, bodyPos, this._tmpQ, contactWorld);
    this._grabRel[hand].copy(this._handQuat[hand]).invert().multiply(this._tmpQ);
    const zero = { x: 0, y: 0, z: 0 };
    if (this.b3.b3Body_SetLinearVelocity) this.b3.b3Body_SetLinearVelocity(body, zero);
    if (this.b3.b3Body_SetAngularVelocity) this.b3.b3Body_SetAngularVelocity(body, zero);
    this.b3.b3Body_SetType(body, this.b3.b3BodyType.b3_kinematicBody);
    if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);
    this._holdQuatReady[hand] = false;
    this._holdSmoothedQuat[hand].copy(this._tmpQ);
    this._holdQuatReady[hand] = true;
    const snapCenter = this._bodyCenterForAnchor(hand, palmWorld, this._tmpQ, this._segA);
    this._effectiveHoldPos[hand].copy(snapCenter);
    this._holdEffReady[hand] = true;
    this._setBodyTransform(idx, snapCenter, this._tmpQ);
    this._recomputeLiftCeiling();
    this._anchorWorldFromBody(hand, snapCenter, this._tmpQ, this._segB);
    this._updatePlayerArmHold(hand, snapCenter, this._segB);
  },

  // Hold: drive the kinematic body toward the weight-clamped goal without teleporting.
  _holdBodyAtHand: function (hand, idx) {
    const body = this.human.bodies[idx];
    if (!body) return;
    if (!this._holdEffReady[hand]) {
      const cur = this.b3.b3Body_GetPosition(body);
      this._effectiveHoldPos[hand].set(cur.x, cur.y, cur.z);
      this._holdEffReady[hand] = true;
    }
    const ctrl = this._handPos[hand];
    const probe = this._rayOrigin;
    const palmContact = this._bonePosTmp;
    const pullTarget = this._getPlayerPalm(hand, probe, palmContact) ? palmContact : ctrl;
    const targetQuat = this._tmpQ.copy(this._handQuat[hand]).multiply(this._grabRel[hand]);
    const holdQuat = this._holdSmoothedQuat[hand];
    if (!this._holdQuatReady[hand]) {
      holdQuat.copy(targetQuat);
      this._holdQuatReady[hand] = true;
    } else {
      const qAlpha = 1 - Math.exp(-28 * this._lastDt);
      holdQuat.slerp(targetQuat, qAlpha);
    }
    const desiredBodyCenter = this._bodyCenterForAnchor(hand, pullTarget, holdQuat, this._segA);
    const target = this._computeHoldTarget(hand, idx, desiredBodyCenter);
    const smoothed = this._smoothHoldToward(hand, target, idx);
    this._setBodyTransform(idx, smoothed, holdQuat);
    const anchorWorld = this._anchorWorldFromBody(hand, smoothed, holdQuat, this._segB);
    this._updatePlayerArmHold(hand, smoothed, anchorWorld);
  },

  _updateHeldBodies: function () {
    ['left', 'right'].forEach((hand) => {
      if (this._held[hand] >= 0 && this._isGrabPressed(hand)) {
        this._holdBodyAtHand(hand, this._held[hand]);
      }
    });
  },

  _repinHeldBodies: function () {
    ['left', 'right'].forEach((hand) => {
      const idx = this._held[hand];
      if (idx < 0 || !this._isGrabPressed(hand)) return;
      const eff = this._effectiveHoldPos[hand];
      const holdQuat = this._holdSmoothedQuat[hand];
      this._setBodyTransform(idx, eff, holdQuat);
    });
  },

  _detachHand: function (hand, throwVel) {
    if (this._held[hand] < 0) return;
    this._releaseBody(this._held[hand], throwVel || this._handVel[hand]);
    this._held[hand] = -1;
    this._holdStart[hand] = null;
    this._holdEffReady[hand] = false;
    this._holdQuatReady[hand] = false;
    this._grabOffsetLocal[hand].set(0, 0, 0);
    this._grabAnchorWorld[hand].set(0, 0, 0);
    this._cachedRigidLiftMax = null;
    this._cachedRigidLiftRefY = null;
    this._holdMotionIntensity[hand] = 0;
    this._holdMotionInit[hand] = false;
    this._recomputeLiftCeiling();
    this._clearPlayerArmHold(hand);
  },

  forceReleaseHand: function (hand) {
    this._forceDetached[hand] = true;
    this._detachHand(hand, this._handVel[hand]);
  },

  // Release: hand the body back to dynamics and impart the hand velocity (throw).
  _releaseBody: function (idx, handVel) {
    const body = this.human.bodies[idx];
    if (!body) return;
    this.b3.b3Body_SetType(body, this.b3.b3BodyType.b3_dynamicBody);
    if (this.b3.b3Body_ApplyMassFromShapes) this.b3.b3Body_ApplyMassFromShapes(body);
    let vx = handVel.x, vy = handVel.y, vz = handVel.z;
    const sp = Math.hypot(vx, vy, vz);
    if (sp > this.MAX_THROW_SPEED) {
      const s = this.MAX_THROW_SPEED / sp;
      vx *= s; vy *= s; vz *= s;
    }
    this.b3.b3Body_SetLinearVelocity(body, { x: vx, y: vy, z: vz });
    if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);
  },

  _updateHand: function (hand, dt) {
    const ctrl = hand === 'left' ? this.leftController : this.rightController;
    if (!ctrl) return;
    const pos = this._handPos[hand];
    const prev = this._handPrev[hand];
    ctrl.object3D.getWorldPosition(pos);
    ctrl.object3D.getWorldQuaternion(this._handQuat[hand]);
    if (this._handInit[hand] && dt > 0) {
      const vel = this._handVel[hand];
      // Smooth the finite-difference velocity a little to reject single-frame spikes.
      vel.lerp(this._tmpV.copy(pos).sub(prev).multiplyScalar(1 / dt), 0.5);
    } else {
      this._handInit[hand] = true;
    }
    prev.copy(pos);
  },

  tick: function (time, deltaTime) {
    if (!this.modelLoaded || !this.b3) return;
    const dt = Math.min(deltaTime / 1000, 0.05);
    if (dt <= 0) return;
    this._lastDt = dt;

    ['left', 'right'].forEach((hand) => {
      this._updateHand(hand, dt);
      const pressed = this._isGrabPressed(hand);
      this._grabPressed[hand] = pressed;

      if (!pressed && this._held[hand] >= 0) {
        this._detachHand(hand, this._handVel[hand]);
      } else if (this._held[hand] >= 0 && pressed) {
        this._updateHoldMotionIntensity(hand, dt);
      } else {
        this._holdMotionIntensity[hand] = 0;
        this._holdMotionInit[hand] = false;
      }
    });

    this._updateHeldBodies();
  },

  tock: function (time, deltaTime) {
    if (!this.modelLoaded || !this.b3) return;

    const palmProbe = this._rayOrigin;
    const palmContact = this._bonePosTmp;

    ['left', 'right'].forEach((hand) => {
      if (!this._grabPressed[hand] || this._held[hand] >= 0) return;
      const query = this._getPlayerPalm(hand, palmProbe, palmContact)
        ? palmContact
        : this._handPos[hand];
      const idx = this._nearestTarget(query);
      if (idx < 0) return;
      if (!this.ragdollActive) {
        if (!this._spawnRagdoll()) return;
      }
      this._held[hand] = idx;
      this._attachBody(hand, idx, query);
    });

    if (this._heldHandCount() > 0) {
      this._repinHeldBodies();
    }

    if (this.ragdollActive && this.human && this.retargetState && window.Box3DRagdollRetarget) {
      window.Box3DRagdollRetarget.apply(this, this.b3, this.human, this.retargetState);
    }
  }
});
