/**
 * grabbable-ragdoll — a standalone Mixamo character that loops idle. Shots add
 * springy hit reactions on top of idle (whole-body nudge + limb recoil, then recover).
 * Grabbing switches to full physics ragdoll for hold/throw.
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

const AIM_SEG_REGIONS = {
  0: 'hips',
  1: 'torso',
  2: 'chest',
  3: 'neck',
  4: 'head',
  5: 'head',
  6: 'leftThigh',
  7: 'leftShin',
  8: 'rightThigh',
  9: 'rightShin',
  10: 'leftUpperArm',
  11: 'leftForearm',
  12: 'rightUpperArm',
  13: 'rightForearm',
  14: 'leftHand',
  15: 'rightHand'
};

const LEG_BONE_KEYS = ['leftUpLeg', 'leftLeg', 'leftFoot', 'rightUpLeg', 'rightLeg', 'rightFoot'];

const HIT_BODY_WOBBLE = [
  { key: 'spine2', w: 0.2 },
  { key: 'spine1', w: 0.14 },
  { key: 'spine', w: 0.1 },
  { key: 'hips', w: 0.07 }
];

const LIMB_HIT_REGIONS = {
  leftThigh: true,
  leftShin: true,
  leftFoot: true,
  rightThigh: true,
  rightShin: true,
  rightFoot: true,
  leftUpperArm: true,
  leftForearm: true,
  leftHand: true,
  rightUpperArm: true,
  rightForearm: true,
  rightHand: true
};

function hitWeightsForRegion(regionId) {
  const arm = (side, upper, fore, hand, shoulder) => ({
    [`${side}Hand`]: [
      { key: hand, w: 1 },
      { key: fore, w: 0.62 },
      { key: upper, w: 0.38 },
      { key: shoulder, w: 0.18 }
    ],
    [`${side}Forearm`]: [
      { key: fore, w: 1 },
      { key: upper, w: 0.52 },
      { key: shoulder, w: 0.22 }
    ],
    [`${side}UpperArm`]: [
      { key: upper, w: 1 },
      { key: shoulder, w: 0.28 }
    ]
  });

  const leg = (side, thigh, shin, foot) => ({
    [`${side}Foot`]: [
      { key: foot, w: 1 },
      { key: shin, w: 0.55 },
      { key: thigh, w: 0.32 }
    ],
    [`${side}Shin`]: [
      { key: shin, w: 1 },
      { key: thigh, w: 0.48 }
    ],
    [`${side}Thigh`]: [
      { key: thigh, w: 1 }
    ]
  });

  return {
    ...arm('left', 'leftUpperArm', 'leftForearm', 'leftHand', 'leftShoulder'),
    ...arm('right', 'rightUpperArm', 'rightForearm', 'rightHand', 'rightShoulder'),
    ...leg('left', 'leftUpLeg', 'leftLeg', 'leftFoot'),
    ...leg('right', 'rightUpLeg', 'rightLeg', 'rightFoot'),
    neck: [{ key: 'neck', w: 1 }, { key: 'head', w: 0.35 }, ...HIT_BODY_WOBBLE],
    head: [{ key: 'head', w: 1 }, { key: 'neck', w: 0.45 }, ...HIT_BODY_WOBBLE],
    hips: [{ key: 'hips', w: 1 }, { key: 'spine', w: 0.35 }],
    torso: [{ key: 'spine', w: 0.8 }, { key: 'spine1', w: 0.55 }, { key: 'hips', w: 0.35 }],
    chest: [{ key: 'spine2', w: 1 }, { key: 'spine1', w: 0.55 }, { key: 'neck', w: 0.2 }, ...HIT_BODY_WOBBLE]
  }[regionId] || HIT_BODY_WOBBLE;
}

/** Fully destroying any of these regions collapses the whole body into physics ragdoll. */
const COLLAPSE_RAGDOLL_REGION_IDS = {
  leftThigh: true,
  leftShin: true,
  leftFoot: true,
  rightThigh: true,
  rightShin: true,
  rightFoot: true,
  head: true,
  neck: true
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

    this._shattered = false;
    this._shards = [];
    this._shardRoot = null;
    this._shatterGroup = null;
    this._shatterRefMesh = null;
    this._shatterSpaceInverse = null;
    this._shatteredRegionKeys = {};
    this._regionDamage = {};
    this._bodyHitCount = 0;
    this._destroyedRegionIds = {};
    this._partialDynamicBoneSet = null;
    this._shardsWorldSpace = false;

    this._hitBoneState = {};
    this._rootNudge = {
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      rotY: 0,
      angVelY: 0
    };
    this._hitEuler = new THREE.Euler();
    this._hitDq = new THREE.Quaternion();
    this._entityBasePos = new THREE.Vector3(this.data.x, this.data.y, this.data.z);
    this._entityBaseRotY = 0;
    this._freeRagdollMode = false;
    this._ragdollStuckTimer = 0;
    this._grabCooldownUntil = 0;
    this.zeroGLegs = window.ZeroGLegs ? new window.ZeroGLegs() : null;
    this._zeroGBodyQuat = new THREE.Quaternion();
    this._zeroGVelScratch = new THREE.Vector3();
    this._hipsRestPos = null;
    this._zeroGLegModeBlend = 0;
    this._legFlinchUntil = 0;
    this._legSnapQuats = null;
    this._shatterBucketCache = { buckets: null, ready: false };
    this._shatterSpaceInverseMat = null;
    this._shatterCachePending = false;

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
      (gltf) => this._onModelLoaded(gltf.scene, gltf.animations || []),
      undefined,
      (err) => console.error('[grabbable-ragdoll] model load error:', err)
    );
  },

  _initIdleAnimation: function (animations) {
    if (!animations?.length || !this.skeleton || !this.model) return false;

    const THREE = window.AFRAME.THREE;
    const aliases = ['Idle', 'idle', 'T-Pose', 'TPose'];
    let clip = null;
    for (let i = 0; i < aliases.length; i++) {
      clip = THREE.AnimationClip.findByName(animations, aliases[i]);
      if (clip) break;
    }
    if (!clip) clip = animations[0];
    if (!clip) return false;

    const mixer = new THREE.AnimationMixer(this.model);
    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.setEffectiveWeight(1);
    action.clampWhenFinished = false;
    action.time = 0;
    mixer.update(0);
    this.skeleton.update();
    this.model.updateMatrixWorld(true);
    action.play();

    this._idleMixer = mixer;
    this._idleAction = action;
    this._idleClip = clip;
    return true;
  },

  _pauseIdleAnimation: function () {
    if (this._idleAction) {
      this._idleAction.paused = true;
      this._idleAction.setEffectiveWeight(0);
    }
  },

  _resumeIdleAnimation: function () {
    if (this._idleAction && this._idleMixer) {
      this._idleAction.reset();
      this._idleAction.setEffectiveWeight(1);
      this._idleAction.paused = false;
      this._idleAction.play();
    }
  },

  _reapplyDestroyedRegionBones: function () {
    const ids = Object.keys(this._destroyedRegionIds || {});
    if (!ids.length) return;
    this._hideShatteredRegionBones(ids);
  },

  _clearHitReactions: function () {
    this._hitBoneState = {};
    this._rootNudge.pos.set(0, 0, 0);
    this._rootNudge.vel.set(0, 0, 0);
    this._rootNudge.rotY = 0;
    this._rootNudge.angVelY = 0;
  },

  _ensureHitBoneState: function (boneKey) {
    if (!this._hitBoneState[boneKey]) {
      this._hitBoneState[boneKey] = {
        offsetQuat: new THREE.Quaternion(),
        angVel: new THREE.Vector3()
      };
    }
    return this._hitBoneState[boneKey];
  },

  _addBoneHitImpulse: function (boneKey, shotDir, impactNormal, magnitude) {
    const bone = this.bones[boneKey];
    if (!bone || magnitude <= 0) return;

    const st = this._ensureHitBoneState(boneKey);
    bone.getWorldQuaternion(this._tmpQ);
    this._hitDq.copy(this._tmpQ).invert();

    this._tmpV.crossVectors(impactNormal, shotDir);
    if (this._tmpV.lengthSq() < 1e-6) {
      this._tmpV.crossVectors(impactNormal, this._segAB.set(0, 1, 0));
    }
    if (this._tmpV.lengthSq() < 1e-6) this._tmpV.set(0, 1, 0);
    else this._tmpV.normalize();
    this._tmpV.applyQuaternion(this._hitDq);

    const impulse = magnitude * 6.2;
    st.angVel.x += this._tmpV.x * impulse;
    st.angVel.y += this._tmpV.y * impulse * 0.65;
    st.angVel.z += this._tmpV.z * impulse;

    this._segAB.copy(shotDir).applyQuaternion(this._hitDq);
    st.angVel.x -= this._segAB.z * magnitude * 3.4;
    st.angVel.z += this._segAB.x * magnitude * 3.4;
    st.angVel.y += impactNormal.y * magnitude * 1.6;
  },

  /**
   * Limb recoil — always push away from the incoming shot (opposite shotDir).
   * Uses bone-axis swing so the reaction reads the same from any hit point on the limb.
   */
  _addLimbPushImpulse: function (boneKey, pushDir, magnitude) {
    const bone = this.bones[boneKey];
    if (!bone || magnitude <= 0) return;

    const st = this._ensureHitBoneState(boneKey);
    bone.getWorldQuaternion(this._tmpQ);

    // Mixamo bone length axis in world space.
    this._segAB.set(0, 1, 0).applyQuaternion(this._tmpQ).normalize();
    if (this._segAB.lengthSq() < 1e-8) return;

    // Spin axis that swings the bone tip along pushDir.
    this._tmpV.crossVectors(this._segAB, pushDir);
    if (this._tmpV.lengthSq() < 1e-6) {
      this._tmpV.crossVectors(this._segAB, this._closestAxis.set(0, 1, 0));
    }
    if (this._tmpV.lengthSq() < 1e-6) {
      this._tmpV.crossVectors(this._segAB, this._closestAxis.set(1, 0, 0));
    }
    if (this._tmpV.lengthSq() < 1e-6) return;
    this._tmpV.normalize();

    this._hitDq.copy(this._tmpQ).invert();
    this._closestAxis.copy(this._tmpV).applyQuaternion(this._hitDq);

    const sign = this._segAB.dot(pushDir) >= 0 ? 1 : -1;
    const k = magnitude * 5.2 * sign;
    st.angVel.x += this._closestAxis.x * k;
    st.angVel.y += this._closestAxis.y * k;
    st.angVel.z += this._closestAxis.z * k;
  },

  /** Impact normal should face toward the incoming shot (away from the surface). */
  _normalFacingIncomingShot: function (shotDir, impactNormal, out) {
    out.copy(impactNormal);
    if (out.lengthSq() < 1e-8) out.copy(shotDir).negate();
    else out.normalize();
    if (out.dot(shotDir) > 0) out.negate();
    return out;
  },

  /** Stable push direction for limbs — recoil opposite incoming shot. */
  _limbPushDirection: function (shotDir, impactNormal, out) {
    this._normalFacingIncomingShot(shotDir, impactNormal, out);
    if (out.dot(shotDir) > -0.15) {
      out.copy(shotDir).negate();
    }
    if (out.lengthSq() < 1e-8) out.copy(shotDir).negate();
    else out.normalize();
    return out;
  },

  _impulseHitReaction: function (shotDir, impactNormal, strength, regionId, stage) {
    if (!regionId) return;

    const str = Math.max(0.35, strength == null ? 1 : strength);
    const stageMul = stage === 1 ? 0.82 : stage === 2 ? 1.05 : 1.28;
    const zeroG = this._isZeroGMode();
    const dir = shotDir.clone().normalize();
    const isLimb = !!LIMB_HIT_REGIONS[regionId];

    const rn = this._rootNudge;
    const nudgeMag = str * stageMul * (zeroG ? 0.22 : 0.1);

    if (isLimb) {
      const push = this._limbPushDirection(dir, impactNormal, this._bonePosTmp);
      rn.vel.x += push.x * nudgeMag * 1.15;
      rn.vel.y += push.y * nudgeMag * 0.55;
      rn.vel.z += push.z * nudgeMag * 1.15;

      const isLegRegion = regionId.indexOf('Thigh') >= 0
        || regionId.indexOf('Shin') >= 0
        || regionId.indexOf('Foot') >= 0;
      const limbKick = (zeroG && isLegRegion) ? 1.65 : 1;
      const weights = hitWeightsForRegion(regionId);
      for (let i = 0; i < weights.length; i++) {
        const w = weights[i];
        this._addLimbPushImpulse(w.key, push, str * w.w * stageMul * limbKick);
      }
      return;
    }

    const norm = this._normalFacingIncomingShot(dir, impactNormal, this._tmpV.clone());
    rn.vel.x += dir.x * nudgeMag + norm.x * nudgeMag * 0.38;
    rn.vel.z += dir.z * nudgeMag + norm.z * nudgeMag * 0.38;
    rn.vel.y += norm.y * str * stageMul * 0.028;
    rn.angVelY += (dir.x * 0.55 - dir.z * 0.35) * str * stageMul * 2.1;

    const weights = hitWeightsForRegion(regionId);
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      this._addBoneHitImpulse(w.key, dir, norm, str * w.w * stageMul);
    }
  },

  _updateHitReactions: function (dt) {
    const zeroG = this._isZeroGMode();
    const legFlinch = zeroG && this._legHitOverlayActive();
    const spring = zeroG ? (legFlinch ? 30 : 14) : 38;
    const damp = zeroG ? (legFlinch ? 6.5 : 4) : 7.2;
    const posSpring = zeroG ? 11 : 32;
    const posDamp = zeroG ? 4 : 8.5;
    const rotSpring = zeroG ? 12 : 28;
    const rotDamp = zeroG ? 4 : 7.5;
    const keys = Object.keys(this._hitBoneState);
    for (let i = 0; i < keys.length; i++) {
      const st = this._hitBoneState[keys[i]];
      const av = st.angVel;
      const ax = av.x * dt;
      const ay = av.y * dt;
      const az = av.z * dt;
      if (Math.abs(ax) + Math.abs(ay) + Math.abs(az) > 1e-7) {
        this._hitEuler.set(ax, ay, az, 'XYZ');
        this._hitDq.setFromEuler(this._hitEuler);
        st.offsetQuat.multiply(this._hitDq);
        st.offsetQuat.normalize();
      }

      this._hitEuler.setFromQuaternion(st.offsetQuat, 'XYZ');
      av.x += (-this._hitEuler.x * spring - av.x * damp) * dt;
      av.y += (-this._hitEuler.y * spring - av.y * damp) * dt;
      av.z += (-this._hitEuler.z * spring - av.z * damp) * dt;

      if (
        av.lengthSq() < 1e-6
        && Math.abs(this._hitEuler.x) + Math.abs(this._hitEuler.y) + Math.abs(this._hitEuler.z) < 0.002
      ) {
        st.offsetQuat.identity();
        av.set(0, 0, 0);
      }
    }

    const rn = this._rootNudge;
    rn.pos.x += rn.vel.x * dt;
    rn.pos.y += rn.vel.y * dt;
    rn.pos.z += rn.vel.z * dt;
    rn.rotY += rn.angVelY * dt;
    rn.vel.x += (-rn.pos.x * posSpring - rn.vel.x * posDamp) * dt;
    rn.vel.y += (-rn.pos.y * (zeroG ? posSpring * 0.85 : 36) - rn.vel.y * (zeroG ? posDamp : 9)) * dt;
    rn.vel.z += (-rn.pos.z * posSpring - rn.vel.z * posDamp) * dt;
    rn.angVelY += (-rn.rotY * rotSpring - rn.angVelY * rotDamp) * dt;

    if (
      rn.pos.lengthSq() < 1e-8
      && rn.vel.lengthSq() < 1e-8
      && Math.abs(rn.rotY) < 1e-5
      && Math.abs(rn.angVelY) < 1e-5
    ) {
      rn.pos.set(0, 0, 0);
      rn.vel.set(0, 0, 0);
      rn.rotY = 0;
      rn.angVelY = 0;
    }
  },

  _applyHitReactionsToPose: function () {
    const keys = Object.keys(this._hitBoneState);
    for (let i = 0; i < keys.length; i++) {
      const boneKey = keys[i];
      const st = this._hitBoneState[boneKey];
      const bone = this.bones[boneKey];
      if (!bone) continue;
      const nearId = st.angVel.lengthSq() < 1e-6
        && Math.abs(st.offsetQuat.x) + Math.abs(st.offsetQuat.y) + Math.abs(st.offsetQuat.z) < 1e-4
        && st.offsetQuat.w > 0.99999;
      if (nearId) continue;
      bone.quaternion.multiply(st.offsetQuat);
      bone.updateMatrixWorld(true);
    }

    const rn = this._rootNudge;
    const bp = this._entityBasePos;
    this.el.object3D.position.set(
      bp.x + rn.pos.x,
      bp.y + rn.pos.y,
      bp.z + rn.pos.z
    );
    this.el.object3D.rotation.y = this._entityBaseRotY + rn.rotY;
  },

  _onModelLoaded: function (modelRoot, animations) {
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
    this._initIdleAnimation(animations || []);
    if (this.model) {
      const box = new THREE.Box3().setFromObject(this.model);
      box.getSize(this._tmpV);
      this._ragdollBoundsRadius = Math.max(0.55, this._tmpV.length() * 0.55);
    }
    this.modelLoaded = true;

    // Snapshot idle rest pose (frame 0) so reset restores the standing dummy, not T-pose.
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
    this._entityBasePos.copy(this._staticPose.entityPos);
    this._entityBaseRotY = this.el.object3D.rotation.y;
    if (this.bones.hips) {
      this._hipsRestPos = this.bones.hips.position.clone();
    }
    this._scheduleShatterCacheBake();
    console.log('[grabbable-ragdoll] ready at', this.data.x, this.data.z);
  },

  _scheduleShatterCacheBake: function () {
    if (this._shatterBucketCache?.ready || this._shatterCachePending) return;
    this._shatterCachePending = true;
    const run = () => {
      this._shatterCachePending = false;
      this._initShatterBucketCache();
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: 2500 });
    } else {
      setTimeout(run, 80);
    }
  },

  _ensureShatterCacheReady: function () {
    if (window.RagdollShatter?.isBucketCacheReady?.(this._shatterBucketCache)) return true;
    this._initShatterBucketCache();
    return !!window.RagdollShatter?.isBucketCacheReady?.(this._shatterBucketCache);
  },

  _shotPatchRegionIds: function (primaryRegionId) {
    if (!primaryRegionId) return null;
    const neighbors = window.RagdollShatter?.REGION_NEIGHBORS?.[primaryRegionId] || [];
    const ids = [primaryRegionId];
    for (let i = 0; i < neighbors.length; i++) ids.push(neighbors[i]);
    return ids;
  },

  /** One-time full mesh bake at rest pose — never per-frame. */
  _initShatterBucketCache: function () {
    const RS = window.RagdollShatter;
    if (!RS?.populateShatterStore || !this._skinnedMeshes?.length || !this.model) return;
    if (this.skeleton) this.skeleton.update();
    this.model.updateMatrixWorld(true);
    if (!this._shatterSpaceInverseMat) {
      this._shatterSpaceInverseMat = new window.AFRAME.THREE.Matrix4();
    }
    this._shatterSpaceInverseMat.copy(this.model.matrixWorld).invert();
    RS.populateShatterStore(
      this._skinnedMeshes,
      this._shatterSpaceInverseMat,
      this._shatterBucketCache
    );
  },

  _updateShatterSpaceInverse: function () {
    if (!this.model) return;
    this.model.updateMatrixWorld(true);
    if (!this._shatterSpaceInverseMat) {
      this._shatterSpaceInverseMat = new window.AFRAME.THREE.Matrix4();
    }
    this._shatterSpaceInverseMat.copy(this.model.matrixWorld).invert();
    this._shatterSpaceInverse = this._shatterSpaceInverseMat;
  },

  _patchShotBuckets: function (regionIds) {
    const RS = window.RagdollShatter;
    if (!RS?.patchBucketsForRegions || !regionIds?.length) return;
    this._syncMeshWorldMatrices(true);
    this._updateShatterSpaceInverse();
    RS.patchBucketsForRegions(
      this._skinnedMeshes,
      this._shatterSpaceInverseMat,
      this._shatterBucketCache,
      regionIds
    );
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

  _prepareEntityForRagdollSpawn: function () {
    this._clearHitReactions();
    this.el.object3D.position.copy(this._entityBasePos);
    this.el.object3D.rotation.y = this._entityBaseRotY;
    this.el.object3D.updateMatrixWorld(true);
    if (this.skeleton) this.skeleton.update();
    if (this.model) this.model.updateMatrixWorld(true);
  },

  _spawnRagdoll: function (opts) {
    opts = opts || {};
    const R = window.Box3DRagdoll;
    const RT = window.Box3DRagdollRetarget;
    if (!R || !RT || !this.b3 || !this.world) return false;

    const collapse = opts.collapse === true;
    this._freeRagdollMode = collapse;
    const jointFriction = collapse ? 0.04 : (opts.jointFriction != null ? opts.jointFriction : 0.14);

    this.el.object3D.getWorldPosition(this._tmpV);
    const basePos = {
      x: this._tmpV.x,
      y: this._isZeroGMode() ? this._tmpV.y : 0,
      z: this._tmpV.z
    };

    this.group = (this.legIk.physics.ragdollGroup++ ) || 1;
    this.human = R.createHuman(
      this.b3, this.world, basePos, this.group,
      jointFriction, undefined, undefined,
      {
        density: this.data.bodyDensity,
        floppyLimbs: true,
        dynamicBones: opts.dynamicBones || null,
        enableJointMotors: collapse ? false : opts.enableJointMotors
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
    this._pauseIdleAnimation();
    if (collapse && R.wakeAllHumanBodies) R.wakeAllHumanBodies(this.b3, this.human);
    this._ragdollStuckTimer = 0;
    return true;
  },

  /** If the ragdoll has settled mid-air (e.g. wedged on a wall), nudge it to fall. */
  _maintainFreeRagdoll: function (dt) {
    if (this._isZeroGMode()) return;
    if (!this._freeRagdollMode || !this.human || !this.b3 || this._heldHandCount() > 0) return;

    const R = window.Box3DRagdoll;
    if (R.wakeAllHumanBodies) R.wakeAllHumanBodies(this.b3, this.human);

    this._ragdollStuckTimer += dt;
    if (this._ragdollStuckTimer < 0.35) return;

    const lowestY = R.computeLowestY(this.b3, this.human);
    if (!isFinite(lowestY) || lowestY <= this.FLOOR_Y + 0.07) {
      this._ragdollStuckTimer = 0;
      return;
    }

    let speedSq = 0;
    for (let i = 0; i < this.human.bodies.length; i++) {
      if (this.human.dynamicFlags && !this.human.dynamicFlags[i]) continue;
      const body = this.human.bodies[i];
      if (!body || !this.b3.b3Body_GetLinearVelocity) continue;
      const v = this.b3.b3Body_GetLinearVelocity(body);
      speedSq += v.x * v.x + v.y * v.y + v.z * v.z;
    }
    if (speedSq > 0.4) return;

    for (let i = 0; i < this.human.bodies.length; i++) {
      if (this.human.dynamicFlags && !this.human.dynamicFlags[i]) continue;
      const body = this.human.bodies[i];
      if (!body || !this.b3.b3Body_SetLinearVelocity) continue;
      const v = this.b3.b3Body_GetLinearVelocity(body);
      this.b3.b3Body_SetLinearVelocity(body, {
        x: v.x * 0.85 + (Math.random() - 0.5) * 0.35,
        y: v.y - 1.4,
        z: v.z * 0.85 + (Math.random() - 0.5) * 0.35
      });
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);
    }
    this._ragdollStuckTimer = 0;
  },

  _isCollapseRagdollRegion: function (regionId) {
    return !!COLLAPSE_RAGDOLL_REGION_IDS[regionId];
  },

  /** Full-body ragdoll when a critical part (leg/head) is blown off. */
  _ragdollFromCriticalLoss: function (shotDir, impactNormal, strength, zones) {
    const RT = window.Box3DRagdollRetarget;
    const R = window.Box3DRagdoll;
    if (!RT || !R || !this.b3 || !this.world) return false;

    this._prepareEntityForRagdollSpawn();

    if (this.human && window.Box3DRagdoll?.destroyHuman) {
      window.Box3DRagdoll.destroyHuman(this.b3, this.human);
    }
    this.human = null;
    this.retargetState = null;
    this.ragdollActive = false;

    if (!this._spawnRagdoll({ collapse: true })) return false;

    const str = strength == null ? 1 : strength;
    this._applyRagdollShotImpulses(shotDir, impactNormal, str, zones, 3, true);
    if (R.wakeAllHumanBodies) R.wakeAllHumanBodies(this.b3, this.human);
    if (RT.apply && this.retargetState) {
      RT.apply(this, this.b3, this.human, this.retargetState);
    }
    return true;
  },

  // Tear the ragdoll down and return the character to its idle rest pose at spawn.
  resetRagdoll: function () {
    if (!this.modelLoaded || !this.model) return;

    this._disposeShatter();

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
    this._clearHitReactions();
    this._freeRagdollMode = false;
    this._ragdollStuckTimer = 0;
    this._entityBasePos.copy(this._staticPose.entityPos);
    this._entityBaseRotY = this._staticPose.entityQuat
      ? new THREE.Euler().setFromQuaternion(this._staticPose.entityQuat).y
      : 0;
    this._resumeIdleAnimation();
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

    // Restore every bone's captured idle rest transform.
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
      if (node.isSkinnedMesh || node.isMesh) node.visible = true;
    });
  },

  _disposeShatter: function () {
    if (this._shards?.length && window.RagdollShatter) {
      const root = this._shardRoot || this.el.object3D;
      window.RagdollShatter.dispose(this._shards, this.b3, root);
    }
    this._shards = [];
    this._shattered = false;
    this._shatterGroup = null;
    this._shatterRefMesh = null;
    this._shatterSpaceInverse = null;
    this._shatteredRegionKeys = {};
    this._regionDamage = {};
    this._bodyHitCount = 0;
    this._destroyedRegionIds = {};
    this._partialDynamicBoneSet = null;
    this._shardsWorldSpace = false;
    this._clearHitReactions();
    if (this._shardRoot?.parent) {
      this._shardRoot.parent.remove(this._shardRoot);
    }
    this._shardRoot = null;
  },

  _releaseAllHands: function (releaseVel) {
    ['left', 'right'].forEach((hand) => {
      if (this._held[hand] < 0) return;
      const idx = this._held[hand];
      const vel = releaseVel || this._handVel[hand];
      this._releaseBody(idx, vel);
      this._held[hand] = -1;
      this._holdStart[hand] = null;
      this._holdEffReady[hand] = false;
      this._holdQuatReady[hand] = false;
      this._grabOffsetLocal[hand].set(0, 0, 0);
      this._grabAnchorWorld[hand].set(0, 0, 0);
      this._holdMotionIntensity[hand] = 0;
      this._holdMotionInit[hand] = false;
      this._clearPlayerArmHold(hand);
    });
  },

  _shotKickVelocity: function (shotDir, impactNormal, strength) {
    const str = Math.max(0.35, strength == null ? 1 : strength);
    const dir = this._meshRayDir.copy(shotDir);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
    else dir.normalize();
    const norm = this._tmpV.copy(impactNormal || shotDir);
    if (norm.lengthSq() < 1e-8) norm.copy(dir);
    else norm.normalize();

    // Whole-body release kick — grounded only; zero-g uses localized region impulse instead.
    if (this._isZeroGMode()) {
      return { x: 0, y: 0, z: 0 };
    }
    const shotMag = 4.2 * str;
    const normMag = 1.6 * str;
    return {
      x: dir.x * shotMag + norm.x * normMag,
      y: dir.y * shotMag + norm.y * normMag,
      z: dir.z * shotMag + norm.z * normMag
    };
  },

  _applyRagdollShotImpulses: function (shotDir, impactNormal, strength, zones, damageStage, shouldCollapse) {
    const RT = window.Box3DRagdollRetarget;
    if (!RT || !this.human || !this.b3) return;

    const zeroG = this._isZeroGMode();
    const holding = this._heldHandCount() > 0;
    const stage = shouldCollapse
      ? 3
      : (damageStage || (zones?.surfaceOnly ? 2 : 1));
    const hitLeg = !!(zones?.primaryId && LIMB_HIT_REGIONS[zones.primaryId]
      && (zones.primaryId.indexOf('Thigh') >= 0
        || zones.primaryId.indexOf('Shin') >= 0
        || zones.primaryId.indexOf('Foot') >= 0));
    const hitArm = !!(zones?.primaryId && LIMB_HIT_REGIONS[zones.primaryId]
      && (zones.primaryId.indexOf('Arm') >= 0 || zones.primaryId.indexOf('Hand') >= 0));
    const limbDestroy = shouldCollapse && (hitLeg || hitArm);

    let impulseScale = shouldCollapse ? 0.45 : (zeroG ? 0.42 : 1.2);
    let shotOpts = null;

    if (shouldCollapse) {
      impulseScale = zeroG ? 0.22 : 0.38;
      shotOpts = {
        primaryOnly: true,
        skipRootBodies: limbDestroy,
        skipBodyIndices: holding ? this._heldBodyIndexSet() : null,
        maxSpeed: zeroG ? 1.35 : 2.8,
        maxAngularSpeed: zeroG ? 4 : 5.5,
        angularBend: limbDestroy,
        angularScale: 0.72
      };
      if (RT.applyStumbleImpulse && limbDestroy) {
        RT.applyStumbleImpulse(this.b3, this.human, shotDir, impactNormal, strength, stage, {
          skipPelvisNudge: true,
          skipSpine: true,
          legsOnly: hitLeg,
          armsOnly: hitArm,
          limbScale: zeroG ? 0.14 : 0.22,
          maxSpeed: zeroG ? 1.2 : 2.4
        });
      } else if (RT.applyStumbleImpulse && !zeroG) {
        RT.applyStumbleImpulse(this.b3, this.human, shotDir, impactNormal, strength, stage, {
          limbScale: 0.32,
          maxSpeed: 3.2
        });
      }
      if (limbDestroy && zones?.primaryId) {
        this._impulseRagdollLegBend(shotDir, impactNormal, strength, zones.primaryId, { subtle: true });
      }
    } else if (RT.applyStumbleImpulse && !zeroG) {
      RT.applyStumbleImpulse(this.b3, this.human, shotDir, impactNormal, strength, stage);
    } else if (zeroG && this.ragdollActive && !shouldCollapse) {
      impulseScale = holding ? 0.48 : 0.82;
      shotOpts = {
        skipBodyIndices: holding ? this._heldBodyIndexSet() : null,
        skipRootBodies: holding && hitLeg,
        primaryOnly: holding,
        maxSpeed: holding ? 2.2 : 8,
        maxAngularSpeed: holding ? 8 : 11,
        angularBend: hitLeg,
        angularScale: holding ? 1.2 : 1
      };
      if (hitLeg) {
        this._impulseRagdollLegBend(shotDir, impactNormal, strength, zones.primaryId);
      }
    } else if (zeroG && this.ragdollActive) {
      impulseScale = 0.82;
      shotOpts = {
        skipBodyIndices: holding ? this._heldBodyIndexSet() : null,
        maxSpeed: 8,
        angularBend: hitLeg,
        angularScale: 0.95
      };
    }

    if (zones && RT.applyShotImpulse && (zones.primaryId || zones.ids?.length)) {
      const skipHeld = (!shotOpts && zeroG) ? this._heldBodyIndexSet() : null;
      RT.applyShotImpulse(
        this.b3,
        this.human,
        zones,
        shotDir,
        impactNormal,
        strength,
        impulseScale,
        shotOpts || { skipBodyIndices: skipHeld }
      );
    }
    if (this.ragdollActive) {
      this._legFlinchUntil = performance.now() + 680;
    }
  },

  /** Bone-space leg kick layered on ragdoll retarget (matches idle limb bend). */
  _impulseRagdollLegBend: function (shotDir, impactNormal, strength, regionId, opts) {
    if (!regionId) return;
    opts = opts || {};
    const str = Math.max(0.35, strength == null ? 1 : strength);
    const push = this._limbPushDirection(shotDir, impactNormal, this._bonePosTmp);
    const weights = hitWeightsForRegion(regionId);
    const stageMul = opts.subtle ? 0.72 : 1.35;
    const legKeys = LEG_BONE_KEYS;
    const armKeys = ['leftUpperArm', 'leftForearm', 'leftHand', 'rightUpperArm', 'rightForearm', 'rightHand'];
    for (let i = 0; i < weights.length; i++) {
      const w = weights[i];
      const isLeg = legKeys.indexOf(w.key) >= 0;
      const isArm = armKeys.indexOf(w.key) >= 0;
      if (!isLeg && !isArm) continue;
      this._addLimbPushImpulse(w.key, push, str * w.w * stageMul * (opts.subtle ? 0.85 : 1.4));
    }
  },

  _updateRagdollLegHitReactions: function (dt) {
    const spring = 22;
    const damp = 5.5;
    for (let i = 0; i < LEG_BONE_KEYS.length; i++) {
      const key = LEG_BONE_KEYS[i];
      const st = this._hitBoneState[key];
      if (!st) continue;
      const av = st.angVel;
      const ax = av.x * dt;
      const ay = av.y * dt;
      const az = av.z * dt;
      if (Math.abs(ax) + Math.abs(ay) + Math.abs(az) > 1e-7) {
        this._hitEuler.set(ax, ay, az, 'XYZ');
        this._hitDq.setFromEuler(this._hitEuler);
        st.offsetQuat.multiply(this._hitDq);
        st.offsetQuat.normalize();
      }

      this._hitEuler.setFromQuaternion(st.offsetQuat, 'XYZ');
      av.x += (-this._hitEuler.x * spring - av.x * damp) * dt;
      av.y += (-this._hitEuler.y * spring - av.y * damp) * dt;
      av.z += (-this._hitEuler.z * spring - av.z * damp) * dt;

      if (
        av.lengthSq() < 1e-6
        && Math.abs(this._hitEuler.x) + Math.abs(this._hitEuler.y) + Math.abs(this._hitEuler.z) < 0.002
      ) {
        st.offsetQuat.identity();
        av.set(0, 0, 0);
      }
    }
  },

  _applyRagdollLegHitOverlay: function () {
    for (let i = 0; i < LEG_BONE_KEYS.length; i++) {
      const boneKey = LEG_BONE_KEYS[i];
      const st = this._hitBoneState[boneKey];
      const bone = this.bones[boneKey];
      if (!st || !bone) continue;
      const nearId = st.angVel.lengthSq() < 1e-6
        && Math.abs(st.offsetQuat.x) + Math.abs(st.offsetQuat.y) + Math.abs(st.offsetQuat.z) < 1e-4
        && st.offsetQuat.w > 0.99999;
      if (nearId) continue;
      bone.quaternion.multiply(st.offsetQuat);
      bone.rotation.setFromQuaternion(bone.quaternion);
      bone.updateMatrixWorld(true);
    }
  },

  _legHitOverlayActive: function () {
    for (let i = 0; i < LEG_BONE_KEYS.length; i++) {
      const st = this._hitBoneState[LEG_BONE_KEYS[i]];
      if (!st) continue;
      if (st.angVel.lengthSq() > 1e-6) return true;
      if (Math.abs(st.offsetQuat.x) + Math.abs(st.offsetQuat.y) + Math.abs(st.offsetQuat.z) > 1e-4) {
        return true;
      }
    }
    return performance.now() < (this._legFlinchUntil || 0);
  },

  _heldBodyIndexSet: function () {
    const set = {};
    if (this._held.left >= 0) set[this._held.left] = true;
    if (this._held.right >= 0) set[this._held.right] = true;
    return set;
  },

  _getShatterBaseVelocity: function () {
    this._tmpV.set(0, 0, 0);
    if (!this.human?.bodies?.[0] || !this.b3) return this._tmpV.clone();
    if (this.b3.b3Body_GetLinearVelocity) {
      const v = this.b3.b3Body_GetLinearVelocity(this.human.bodies[0]);
      this._tmpV.set(v.x, v.y, v.z);
      const len = this._tmpV.length();
      if (len > 3) this._tmpV.multiplyScalar(3 / len);
    }
    return this._tmpV.clone();
  },

  _applyRegionDamageVisual: function (regionId, stage) {
    const RS = window.RagdollShatter;
    const maxStage = RS?.REGION_DAMAGE_MAX || 3;
    if (stage >= maxStage) {
      this._hideShatteredRegionBones([regionId]);
    }
  },

  _markRegionKeysDestroyed: function (regionKeys) {
    if (!regionKeys?.length) return;
    for (let i = 0; i < regionKeys.length; i++) {
      this._shatteredRegionKeys[regionKeys[i]] = true;
    }
  },

  _hideShatteredRegionBones: function (regionIds) {
    const map = window.RagdollShatter?.REGION_BONE_KEYS;
    if (!map || !this.bones) return;
    const tiny = 0.001;
    for (let i = 0; i < regionIds.length; i++) {
      const keys = map[regionIds[i]];
      if (!keys) continue;
      for (let k = 0; k < keys.length; k++) {
        const bone = this.bones[keys[k]];
        if (bone) bone.scale.set(tiny, tiny, tiny);
      }
    }
    if (this.skeleton) this.skeleton.update();
  },

  _isRegionShotThrough: function (regionId) {
    return !!(regionId && this._destroyedRegionIds[regionId]);
  },

  _regionIdFromHit: function (mesh, hit) {
    const RS = window.RagdollShatter;
    if (!RS || !mesh || hit?.faceIndex == null) return null;

    let regionId = RS.regionFromHitFace(mesh, hit.faceIndex);

    if (regionId && RS.CORE_TORSO_REGIONS?.[regionId] && RS.resolveHitRegionAtPoint
      && hit.point && this.model) {
      const Mat4 = mesh.matrixWorld.constructor;
      const spaceInverse = new Mat4().copy(this.model.matrixWorld).invert();
      regionId = RS.resolveHitRegionAtPoint(
        this._skinnedMeshes,
        hit.point,
        spaceInverse,
        regionId,
        this._shatteredRegionKeys
      );
    }
    return regionId;
  },

  /** World-space ray vs posed skinned meshes (for shooter). Ignores shard meshes. */
  raycastFromShot: function (origin, direction, maxDist) {
    if (!this.modelLoaded) return null;

    const dir = this._meshRayDir.copy(direction);
    if (dir.lengthSq() < 1e-8) return null;
    dir.normalize();

    const raycaster = this._meshRaycaster;
    raycaster.set(origin, dir);
    raycaster.near = 0.02;
    raycaster.far = maxDist || 48;

    this._syncMeshWorldMatrices();

    const candidates = [];
    for (let m = 0; m < this._skinnedMeshes.length; m++) {
      const mesh = this._skinnedMeshes[m];
      const hits = raycaster.intersectObject(mesh, false);
      for (let hi = 0; hi < hits.length; hi++) {
        candidates.push({ mesh: mesh, h: hits[hi] });
      }
    }
    candidates.sort((a, b) => a.h.distance - b.h.distance);

    for (let i = 0; i < candidates.length; i++) {
      const mesh = candidates[i].mesh;
      const h = candidates[i].h;
      const regionId = this._regionIdFromHit(mesh, h);
      if (this._isRegionShotThrough(regionId)) continue;
      return {
        point: h.point.clone(),
        normal: h.face?.normal
          ? h.face.normal.clone().transformDirection(mesh.matrixWorld).normalize()
          : dir.clone().negate(),
        distance: h.distance,
        regionId: regionId
      };
    }
    return null;
  },

  _bakeShardsToWorld: function (newShards) {
    if (!newShards?.length || !this.model) return;
    this.model.updateMatrixWorld(true);
    const m = this.model.matrixWorld;
    for (let i = 0; i < newShards.length; i++) {
      const mesh = newShards[i].mesh;
      if (mesh) mesh.position.applyMatrix4(m);
    }
  },

  /**
   * Ragdoll + localized shatter: physics reaction on the dummy, shards only near impact.
   */
  shatterFromShot: function (impactPoint, impactNormal, shotDir, strength, primaryRegionId) {
    if (!this.modelLoaded || !window.RagdollShatter?.fracture) return false;
    if (!this.b3 || !this.world) return false;

    strength = strength == null ? 1 : strength;
    if (!this._ensureShatterCacheReady()) return false;
    this._syncMeshWorldMatrices(true);
    this._updateShatterSpaceInverse();
    const zeroG = this._isZeroGMode();
    const holding = this._heldHandCount() > 0;
    if (!zeroG || !holding) {
      const shotKick = this._shotKickVelocity(shotDir, impactNormal, strength);
      this._releaseAllHands(shotKick);
      this._grabCooldownUntil = performance.now() + 140;
    }

    const ref = this._skinnedMeshes[0];
    if (!ref) return false;

    const RS = window.RagdollShatter;
    const patchIds = this._shotPatchRegionIds(primaryRegionId);
    if (patchIds) this._patchShotBuckets(patchIds);

    const collectOpts = {
      bucketStore: this._shatterBucketCache,
      primaryRegionId: primaryRegionId || null
    };
    const collected = RS.collectRegionEntries(
      this._skinnedMeshes,
      impactPoint,
      this._shatterSpaceInverse,
      this._shatteredRegionKeys,
      collectOpts
    );
    const zones = RS.pickImpactZonesFromEntries(
      collected.entries,
      this._shatteredRegionKeys,
      primaryRegionId || null
    );

    if (zones.ids?.length && patchIds) {
      let needsExtra = false;
      for (let i = 0; i < zones.ids.length; i++) {
        if (patchIds.indexOf(zones.ids[i]) < 0) {
          needsExtra = true;
          break;
        }
      }
      if (needsExtra) {
        this._patchShotBuckets(zones.ids);
        collected.entries = RS.collectFromCatalog(
          this._shatterBucketCache,
          impactPoint,
          this._shatterSpaceInverse,
          this._shatteredRegionKeys,
          zones.ids
        ).entries;
      }
    }

    if (!zones.keys.length && !zones.surfaceOnly) {
      console.warn('[grabbable-ragdoll] shot — no shatter zones (already destroyed there?)');
      return false;
    }

    const damageMax = RS?.REGION_DAMAGE_MAX || 3;
    const bodyHitsToRagdoll = RS?.BODY_HITS_TO_RAGDOLL || 5;
    let damageStage = null;
    let fractureKeys = zones.keys;
    const RT = window.Box3DRagdollRetarget;

    let bodyKnockdown = false;
    if (zones.surfaceOnly) {
      this._bodyHitCount = (this._bodyHitCount || 0) + 1;
      bodyKnockdown = this._bodyHitCount >= bodyHitsToRagdoll;
    }

    if (!zones.surfaceOnly && zones.primaryId) {
      const prevHits = this._regionDamage[zones.primaryId] || 0;
      damageStage = Math.min(damageMax, prevHits + 1);
      this._regionDamage[zones.primaryId] = damageStage;

      fractureKeys = RS.keysForRegionIdFromEntries
        ? RS.keysForRegionIdFromEntries(collected.entries, zones.primaryId)
        : zones.keys.filter((k) => k.indexOf(zones.primaryId + ':') === 0);
    }

    const criticalDestroy = !zones.surfaceOnly
      && zones.primaryId
      && this._isCollapseRagdollRegion(zones.primaryId)
      && damageStage != null
      && damageStage >= damageMax;

    const shouldCollapse = criticalDestroy || bodyKnockdown;

    let reactionRegion = zones.primaryId || (zones.surfaceOnly ? 'chest' : null);
    if (reactionRegion && RS?.CORE_TORSO_REGIONS?.[reactionRegion]) {
      reactionRegion = 'chest';
    }
    if (reactionRegion && !this.ragdollActive && !shouldCollapse) {
      this._impulseHitReaction(
        shotDir,
        impactNormal,
        strength,
        reactionRegion,
        damageStage || 1
      );
      if (this._isZeroGMode() && reactionRegion && LIMB_HIT_REGIONS[reactionRegion]
        && (reactionRegion.indexOf('Thigh') >= 0
          || reactionRegion.indexOf('Shin') >= 0
          || reactionRegion.indexOf('Foot') >= 0)) {
        this._legFlinchUntil = performance.now() + 720;
      }
    }

    if (!this._shardRoot) {
      this._shardRoot = window.RagdollShatter.createShardRoot(ref);
      this._shardRoot.name = 'ragdoll-shards';
      this._shardRoot.visible = true;
      this._shardRoot.frustumCulled = false;
      this.el.sceneEl.object3D.add(this._shardRoot);
      this._shardsWorldSpace = true;
      this._shatterRefMesh = ref;
    }

    const dir = shotDir.clone().normalize();
    const baseVel = this._getShatterBaseVelocity().multiplyScalar(strength);

    if (shouldCollapse) {
      if (!this.ragdollActive) {
        this._ragdollFromCriticalLoss(shotDir, impactNormal, strength, zones);
      } else {
        this._applyRagdollShotImpulses(shotDir, impactNormal, strength, zones, damageStage, true);
      }
    } else if (this.ragdollActive && this.human) {
      this._applyRagdollShotImpulses(shotDir, impactNormal, strength, zones, damageStage, false);
      if (RT?.apply && this.retargetState) {
        RT.apply(this, this.b3, this.human, this.retargetState);
      }
    } else if (RT?.apply && this.retargetState && this.human) {
      RT.apply(this, this.b3, this.human, this.retargetState);
    }

    if (!zones.surfaceOnly && zones.primaryId && damageStage != null && damageStage >= damageMax) {
      this._destroyedRegionIds[zones.primaryId] = true;
      this._markRegionKeysDestroyed(fractureKeys);
      this._hideShatteredRegionBones([zones.primaryId]);
    }

    const newShards = window.RagdollShatter.fracture({
      root: this._shardRoot,
      spaceInverse: this._shatterSpaceInverse,
      skinnedMeshes: this._skinnedMeshes,
      material: ref.material,
      impactPoint: impactPoint,
      impactNormal: impactNormal,
      shotDir: dir,
      b3: this.b3,
      world: this.world,
      group: this.group || 1,
      shotStrength: strength,
      baseVelocity: baseVel,
      skipRegions: this._shatteredRegionKeys,
      regionKeys: fractureKeys,
      surfaceOnly: !!zones.surfaceOnly,
      damageStage: damageStage,
      primaryRegionId: zones.primaryId || null,
      precomputedEntries: collected.entries,
      precomputedV3Class: collected.V3Class,
      bucketStore: this._shatterBucketCache
    });

    if (newShards.length || damageStage) {
      this._bakeShardsToWorld(newShards);
      if (!zones.surfaceOnly && zones.primaryId && damageStage) {
        this._applyRegionDamageVisual(zones.primaryId, damageStage);
      }
      if (!this._shards) this._shards = [];
      for (let i = 0; i < newShards.length; i++) {
        this._shards.push(newShards[i]);
      }
    }

    return newShards.length > 0 || !!zones.surfaceOnly || !!damageStage;
  },

  _aimCapsuleRadius: function (segIdx) {
    if (segIdx >= 14) return 0.048;
    if (segIdx >= 10) return 0.052;
    if (segIdx >= 6) return 0.062;
    return 0.128;
  },

  _rayIntersectSphere: function (origin, dir, center, radius, maxDist, outPoint, outNormal) {
    const oc = this._segAP.copy(origin).sub(center);
    const b = oc.dot(dir);
    const c = oc.dot(oc) - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return null;
    const s = Math.sqrt(disc);
    let t = -b - s;
    if (t < 0) t = -b + s;
    if (t < 0.02 || t > maxDist) return null;
    outPoint.copy(origin).addScaledVector(dir, t);
    outNormal.copy(outPoint).sub(center);
    if (outNormal.lengthSq() < 1e-8) outNormal.copy(dir).negate();
    else outNormal.normalize();
    return t;
  },

  /** Ray vs capsule (segment ab + radius). Returns hit distance t or null. */
  _rayIntersectCapsule: function (origin, dir, a, b, radius, maxDist, outPoint, outNormal) {
    const ba = this._segAB.copy(b).sub(a);
    const oa = this._segAP.copy(origin).sub(a);
    const baba = ba.dot(ba);
    if (baba < 1e-8) {
      return this._rayIntersectSphere(origin, dir, a, radius, maxDist, outPoint, outNormal);
    }

    const bard = ba.dot(dir);
    const baoa = ba.dot(oa);
    const rdoa = dir.dot(oa);
    const oaoa = oa.dot(oa);
    const aa = baba - bard * bard;
    const bb = baba * rdoa - baoa * bard;
    const cc = baba * oaoa - baoa * baoa - radius * radius * baba;
    const h = bb * bb - aa * cc;

    if (h >= 0 && Math.abs(aa) > 1e-8) {
      const sqrtH = Math.sqrt(h);
      for (let s = 0; s < 2; s++) {
        const t = ((-bb + (s === 0 ? -sqrtH : sqrtH)) / aa);
        if (t >= 0.02 && t <= maxDist) {
          const y = baoa + t * bard;
          if (y > 0 && y < baba) {
            outPoint.copy(origin).addScaledVector(dir, t);
            this._closestAxis.copy(a).addScaledVector(ba, y / baba);
            outNormal.copy(outPoint).sub(this._closestAxis);
            if (outNormal.lengthSq() < 1e-8) outNormal.copy(dir).negate();
            else outNormal.normalize();
            return t;
          }
        }
      }
    }

    let tA = this._rayIntersectSphere(origin, dir, a, radius, maxDist, outPoint, outNormal);
    const tB = this._rayIntersectSphere(
      origin, dir, b, radius, maxDist, this._tmpV, this._bonePosTmp
    );
    if (tB != null && (tA == null || tB < tA)) {
      outPoint.copy(this._tmpV);
      outNormal.copy(this._bonePosTmp);
      return tB;
    }
    return tA;
  },

  /**
   * Cheap VR aim preview — bone capsules only (no skinned-mesh raycast).
   * Accurate shot registration still uses raycastFromShot on fire.
   */
  raycastAimPreview: function (origin, direction, maxDist) {
    if (!this.modelLoaded || !this.skeleton) return null;

    const dir = this._meshRayDir.copy(direction);
    if (dir.lengthSq() < 1e-8) return null;
    dir.normalize();
    maxDist = maxDist || 48;

    this._syncMeshWorldMatrices();

    let bestT = maxDist + 1;
    let gotHit = false;
    let bestSeg = -1;

    for (let seg = 0; seg <= 15; seg++) {
      const keys = MESH_BODY_SEGS[seg];
      if (!keys) continue;
      const boneA = this.bones[keys[0]];
      const boneB = this.bones[keys[1]];
      if (!boneA || !boneB) continue;
      boneA.getWorldPosition(this._segA);
      boneB.getWorldPosition(this._segB);
      const t = this._rayIntersectCapsule(
        origin,
        dir,
        this._segA,
        this._segB,
        this._aimCapsuleRadius(seg),
        maxDist,
        this._tmpV,
        this._bonePosTmp
      );
      if (t != null && t < bestT) {
        bestT = t;
        bestSeg = seg;
        this._closestAxis.copy(this._tmpV);
        this._rayOrigin.copy(this._bonePosTmp);
        gotHit = true;
      }
    }

    if (!gotHit) return null;
    return {
      point: this._closestAxis.clone(),
      normal: this._rayOrigin.clone(),
      distance: bestT,
      regionId: AIM_SEG_REGIONS[bestSeg] || null,
      preview: true
    };
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

  _yawOnlyQuat: function (src, out) {
    this._hitEuler.setFromQuaternion(src, 'YXZ');
    out.setFromAxisAngle(this._tmpV.set(0, 1, 0), this._hitEuler.y);
    return out;
  },

  _getDummyZeroGVelocity: function () {
    const v = this._zeroGVelScratch;
    v.set(0, 0, 0);

    if (this.ragdollActive && this.human?.bodies?.[0] && this.b3?.b3Body_GetLinearVelocity) {
      const pv = this.b3.b3Body_GetLinearVelocity(this.human.bodies[0]);
      v.set(pv.x, pv.y, pv.z);
    }

    if (this._heldHandCount() > 0) {
      let n = 0;
      ['left', 'right'].forEach((hand) => {
        if (this._held[hand] < 0) return;
        v.add(this._handVel[hand]);
        n++;
      });
      if (n > 0) v.multiplyScalar(1 / n);
    } else if (!this.ragdollActive) {
      const rn = this._rootNudge.vel;
      v.set(rn.x, rn.y, rn.z);
    }

    return v;
  },

  _updateZeroGLegModeBlend: function (dt) {
    if (window.ZeroGLegs?.updateLegModeBlend) {
      this._zeroGLegModeBlend = window.ZeroGLegs.updateLegModeBlend(
        this._zeroGLegModeBlend,
        this._isZeroGMode(),
        dt
      );
    } else {
      this._zeroGLegModeBlend = this._isZeroGMode() ? 1 : 0;
    }
  },

  /** Procedural float legs (same system as the player body in zero-g). */
  _applyZeroGLegs: function (dt) {
    if (!this.zeroGLegs || !this.bones) return;
    this._updateZeroGLegModeBlend(dt);
    const blend = this._zeroGLegModeBlend;
    if (blend <= 0.001) return;

    const legReact = this._legHitOverlayActive();
    const poseBlend = legReact ? blend * 0.55 : blend;

    if (this.bones.hips && this._hipsRestPos) {
      this.bones.hips.position.copy(this._hipsRestPos);
    }

    if (this.bones.hips) {
      this.bones.hips.getWorldQuaternion(this._zeroGBodyQuat);
      this._yawOnlyQuat(this._zeroGBodyQuat, this._zeroGBodyQuat);
    } else {
      this.el.object3D.getWorldQuaternion(this._zeroGBodyQuat);
      this._yawOnlyQuat(this._zeroGBodyQuat, this._zeroGBodyQuat);
    }

    this.zeroGLegs.update(
      this.bones,
      this._getDummyZeroGVelocity(),
      this._zeroGBodyQuat,
      dt,
      poseBlend
    );
    if (this.skeleton) this.skeleton.update();
    if (this.model) this.model.updateMatrixWorld(true);
  },

  _ensureLegSnapQuats: function () {
    if (this._legSnapQuats) return;
    const THREE = window.AFRAME.THREE;
    this._legSnapQuats = {};
    for (let i = 0; i < LEG_BONE_KEYS.length; i++) {
      this._legSnapQuats[LEG_BONE_KEYS[i]] = new THREE.Quaternion();
    }
  },

  _snapshotLegBoneQuats: function () {
    this._ensureLegSnapQuats();
    for (let i = 0; i < LEG_BONE_KEYS.length; i++) {
      const key = LEG_BONE_KEYS[i];
      const bone = this.bones[key];
      if (bone) this._legSnapQuats[key].copy(bone.quaternion);
    }
  },

  _blendLegBonesFromPhysics: function (zeroGWeight) {
    this._ensureLegSnapQuats();
    zeroGWeight = Math.max(0, Math.min(1, zeroGWeight));
    for (let i = 0; i < LEG_BONE_KEYS.length; i++) {
      const key = LEG_BONE_KEYS[i];
      const bone = this.bones[key];
      if (!bone) continue;
      bone.quaternion.copy(this._legSnapQuats[key]).slerp(bone.quaternion, zeroGWeight);
      bone.rotation.setFromQuaternion(bone.quaternion);
    }
  },

  _ragdollLimbMotionFactor: function () {
    if (!this.human?.bodies || !this.b3?.b3Body_GetLinearVelocity) return 0;
    let maxSpd = 0;
    for (let i = 6; i <= 9; i++) {
      const body = this.human.bodies[i];
      if (!body) continue;
      const v = this.b3.b3Body_GetLinearVelocity(body);
      maxSpd = Math.max(maxSpd, Math.hypot(v.x, v.y, v.z));
    }
    return Math.min(1, maxSpd / 2.2);
  },

  /**
   * Ragdoll: physics retarget drives legs; zero-g pose is cosmetic overlay only
   * so shot impulses remain visible on the limbs.
   */
  _applyZeroGLegsRagdoll: function (dt) {
    if (!this.zeroGLegs || !this.bones) return;
    this._updateZeroGLegModeBlend(dt);
    const modeBlend = this._zeroGLegModeBlend;
    if (modeBlend <= 0.001) return;

    const flinch = this._legHitOverlayActive();
    if (!flinch) {
      this._snapshotLegBoneQuats();

      if (this.bones.hips && this._hipsRestPos) {
        this.bones.hips.position.copy(this._hipsRestPos);
      }

      if (this.bones.hips) {
        this.bones.hips.getWorldQuaternion(this._zeroGBodyQuat);
        this._yawOnlyQuat(this._zeroGBodyQuat, this._zeroGBodyQuat);
      } else {
        this.el.object3D.getWorldQuaternion(this._zeroGBodyQuat);
        this._yawOnlyQuat(this._zeroGBodyQuat, this._zeroGBodyQuat);
      }

      this.zeroGLegs.update(
        this.bones,
        this._getDummyZeroGVelocity(),
        this._zeroGBodyQuat,
        dt,
        modeBlend
      );

      const limbMotion = this._ragdollLimbMotionFactor();
      let cosmetic = modeBlend * (limbMotion > 0.35 ? 0.08 : 0.18);
      cosmetic = Math.min(cosmetic, modeBlend);
      this._blendLegBonesFromPhysics(cosmetic);
    }

    if (this.skeleton) this.skeleton.update();
    if (this.model) this.model.updateMatrixWorld(true);
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

  _syncMeshWorldMatrices: function (force) {
    if (!this.skeleton || !this.model) return;
    if (!force) {
      const t = this.el.sceneEl?.time;
      if (t === this._meshSyncTime) return;
      this._meshSyncTime = t;
    }
    this.el.object3D.updateMatrixWorld(true);
    if (!this.ragdollActive && this._idleMixer) {
      this._idleMixer.update(0);
    }
    this.model.updateMatrixWorld(true);
    this.skeleton.update();
    for (let i = 0; i < this._skinnedMeshes.length; i++) {
      const mesh = this._skinnedMeshes[i];
      mesh.updateMatrixWorld(true);
    }
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

    if (this._shards?.length && window.RagdollShatter?.syncShards) {
      window.RagdollShatter.syncShards(this._shards, this.b3, dt, this.legIk?.queries, {
        root: this._shardRoot,
        refMesh: this._shatterRefMesh || this._shards[0]?.mesh,
        spaceInverse: this._shardsWorldSpace ? null : this._shatterSpaceInverse,
        zeroG: this._isZeroGMode()
      });
    }

    // Grip + hand pose must run while idle too — tock uses this for first grab → ragdoll spawn.
    ['left', 'right'].forEach((hand) => {
      this._updateHand(hand, dt);
      this._grabPressed[hand] = this._isGrabPressed(hand);
    });

    if (!this.ragdollActive) {
      this._updateHitReactions(dt);
      if (this._idleMixer) {
        this._idleMixer.update(dt);
        if (this.skeleton) this.skeleton.update();
        this._reapplyDestroyedRegionBones();
        if (this.model) this.model.updateMatrixWorld(true);
      }
      if (this._zeroGLegModeBlend > 0.001 || this._isZeroGMode()) {
        this._applyZeroGLegs(dt);
      }
      this._applyHitReactionsToPose();
      if (this.skeleton) this.skeleton.update();
      if (this.model) this.model.updateMatrixWorld(true);
      return;
    }

    ['left', 'right'].forEach((hand) => {
      const pressed = this._grabPressed[hand];

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
    this._maintainFreeRagdoll(dt);
  },

  tock: function (time, deltaTime) {
    if (!this.modelLoaded || !this.b3) return;
    const dt = Math.min(deltaTime / 1000, 0.05);

    const palmProbe = this._rayOrigin;
    const palmContact = this._bonePosTmp;

    ['left', 'right'].forEach((hand) => {
      const pressed = this._isGrabPressed(hand);
      this._grabPressed[hand] = pressed;
      if (!pressed || this._held[hand] >= 0) return;
      if (performance.now() < (this._grabCooldownUntil || 0)) return;
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
      if (this._isZeroGMode()) {
        this._updateRagdollLegHitReactions(dt);
      }
      window.Box3DRagdollRetarget.apply(this, this.b3, this.human, this.retargetState);
      if (this._isZeroGMode()) {
        this._applyRagdollLegHitOverlay();
      }
      if (this._zeroGLegModeBlend > 0.001 || this._isZeroGMode()) {
        this._applyZeroGLegsRagdoll(dt);
      }
    }
  }
});
