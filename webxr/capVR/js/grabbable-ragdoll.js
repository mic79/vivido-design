/**
 * grabbable-ragdoll — a standalone Mixamo character that loops idle. Shots add
 * springy hit reactions on top of idle (whole-body nudge + limb recoil, then recover).
 * Grabbing switches to full physics ragdoll for hold/throw.
 *
 * It reuses the shared physics world + ragdoll modules but does NOT touch the player's
 * ragdoll or collider: it calls Box3DRagdoll.createHuman directly (not spawnRagdoll).
 */
// Bone pairs keyed by Box3D body index (grab targeting + limb capsules).
// Hand/foot/head use extendB so the capsule covers the visible mesh past the joint bone.
const MESH_BODY_SEGS = {
  0: { a: 'hips', b: 'spine', r: 0.14 },
  1: { a: 'spine', b: 'spine1', r: 0.12 },
  2: { a: 'spine1', b: 'spine2', r: 0.13 },
  3: { a: 'spine2', b: 'neck', r: 0.14 },
  4: { a: 'neck', b: 'head', r: 0.08 },
  // Head bone is at the skull base — sphere centered up into the cranium.
  5: { a: 'head', b: 'head', r: 0.125, kind: 'sphere', offsetA: 0.09, along: 'worldUp' },
  6: { a: 'leftUpLeg', b: 'leftLeg', r: 0.095 },
  7: { a: 'leftLeg', b: 'leftFoot', r: 0.07 },
  8: { a: 'rightUpLeg', b: 'rightLeg', r: 0.095 },
  9: { a: 'rightLeg', b: 'rightFoot', r: 0.07 },
  10: { a: 'leftUpperArm', b: 'leftForearm', r: 0.08 },
  11: { a: 'leftForearm', b: 'leftHand', r: 0.055 },
  12: { a: 'rightUpperArm', b: 'rightForearm', r: 0.08 },
  13: { a: 'rightForearm', b: 'rightHand', r: 0.055 },
  // Hand bones are at the wrist — prefer finger tip bone, else extend into the palm.
  14: { a: 'leftHand', b: 'leftHandTip', r: 0.055, fallbackExtend: 0.12, along: 'hand' },
  15: { a: 'rightHand', b: 'rightHandTip', r: 0.055, fallbackExtend: 0.12, along: 'hand' }
};

// Extra mesh-only capsules — joint balls (shoulders/hips) + clavicle links + feet.
const MESH_EXTRA_CAPS = [
  // Shoulder balls (upper-arm bone origin sits inside the deltoid).
  { a: 'leftUpperArm', b: 'leftUpperArm', r: 0.095, kind: 'sphere' },
  { a: 'rightUpperArm', b: 'rightUpperArm', r: 0.095, kind: 'sphere' },
  // Clavicle / shoulder girdle into the arm.
  { a: 'spine2', b: 'leftUpperArm', r: 0.08 },
  { a: 'spine2', b: 'rightUpperArm', r: 0.08 },
  { a: 'leftShoulder', b: 'leftUpperArm', r: 0.07 },
  { a: 'rightShoulder', b: 'rightUpperArm', r: 0.07 },
  // Hip balls + pelvis-to-thigh links (covers the outer hip mesh).
  { a: 'leftUpLeg', b: 'leftUpLeg', r: 0.11, kind: 'sphere' },
  { a: 'rightUpLeg', b: 'rightUpLeg', r: 0.11, kind: 'sphere' },
  { a: 'hips', b: 'leftUpLeg', r: 0.12 },
  { a: 'hips', b: 'rightUpLeg', r: 0.12 },
  { a: 'leftFoot', b: 'leftToe', r: 0.05, fallbackExtend: 0.14, along: 'foot' },
  { a: 'rightFoot', b: 'rightToe', r: 0.05, fallbackExtend: 0.14, along: 'foot' }
];

const MESH_CAP_COUNT = 16 + MESH_EXTRA_CAPS.length;

const AIM_SEG_REGIONS = {
  0: 'hips',
  1: 'torso',
  2: 'chest',
  // spine2→neck is upper chest for aim assist; mesh raycast owns real registration.
  3: 'chest',
  4: 'neck',
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
    twoHandHoldBonus: { type: 'number', default: 0.45 },
    // Debug: limb capsules used for hand-vs-character collision.
    showCollisionWireframe: { type: 'boolean', default: false },
    // Hand only queries character limbs within this radius of the palm (metres).
    handMeshQueryRadius: { type: 'number', default: 0.32 },
    /**
     * CapVR combat bots: false — grip must NOT spawn a physics ragdoll.
     * body-rigged4 grab-dummy: true (default) — grip picks up and spawns human.
     * Combat death/collapse still calls _spawnRagdoll({ collapse: true }).
     */
    allowPalmGrab: { type: 'boolean', default: true },
    /** CapVR: when true, skip locomotion/idle/hit tick (bots OFF). */
    paused: { type: 'boolean', default: false }
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
    this._queryCollidersOnly = false;
    this.group = null;
    this._collisionWireGroup = null;
    this._meshHandNear = false;
    this._lastLimbHitIdx = -1;
    this._lastLimbContact = null;
    this._holdHighlight = { left: null, right: null };
    this._holdHighlightRing = { left: null, right: null };

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
    // Virtual-palm offset from the controller at grab (controller-local). Hold drives
    // the contact to controllerPose * this, so the pin stays under the hand that
    // was touching — not a re-sampled bone palm that can drift from IK.
    this._grabPalmCtrlLocal = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this._grabPalmCtrlReady = { left: false, right: false };
    // Hand-bone offset from that palm (controller-local). Arm IK targets
    // anchor + R_ctrl * this so weight limits pull the virtual hand with the body.
    this._grabPalmToBoneCtrlLocal = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this._grabPalmToBoneReady = { left: false, right: false };
    this._grabReleaseBaseline = { left: 0, right: 0 };
    // Player wrist / hand pose locked in the grabbed body's local space (static-grab style).
    this._holdWristLocal = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this._holdHandQuatLocal = { left: new THREE.Quaternion(), right: new THREE.Quaternion() };
    this._holdHandQuatReady = { left: false, right: false };
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
      left: {
        active: false,
        overloaded: false,
        wristWorld: new THREE.Vector3(),
        handQuat: new THREE.Quaternion(),
        hasHandQuat: false
      },
      right: {
        active: false,
        overloaded: false,
        wristWorld: new THREE.Vector3(),
        handQuat: new THREE.Quaternion(),
        hasHandQuat: false
      }
    };
    // Weight/peel limits ease in over this many seconds after grab.
    this.HOLD_WEIGHT_BLEND_S = 2.5;
    this._forceDetached = { left: false, right: false };
    this._holdMotionPrev = { left: new THREE.Vector3(), right: new THREE.Vector3() };
    this._holdMotionIntensity = { left: 0, right: 0 };
    this._holdMotionInit = { left: false, right: false };
    this._savedBodyTransforms = null;
    this._lastDt = 0.016;
    this.FLOOR_Y = 0;
    this.FLOOR_EPS = 0.1;
    this.OVERLOAD_DIST = 0.03;
    // Peel/detach: controller may leave the grab contact this far before the hold breaks
    // (same idea as mixamo-body grabReleaseDist on static surfaces).
    this.HOLD_RELEASE_DIST = 0.14;
    this.HOLD_RELEASE_UP_M = 0.10;
    // Hard cap — always break even during the early weight-blend grace period.
    this.HOLD_DETACH_MAX_M = 0.42;
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
    const host = window.CapVRPhysics?.host?.() || this.sceneEl.components['capvr-physics'];
    const phys = window.CapVRPhysics?.get?.() || host?.physics;
    const ready =
      window.BodyRiggedLoaders?.ready &&
      phys?.b3 &&
      phys?.world;
    if (!ready) {
      setTimeout(() => this._loadWhenReady(), 100);
      return;
    }
    this.legIk = host || null;
    this.b3 = phys.b3;
    this.world = phys.world;
    this._loadModel();
  },

  _loadModel: function () {
    const path = this.data.modelPath || 'character.glb';
    const isFbx = /\.fbx($|\?)/i.test(path);
    const onErr = (err) => console.error('[grabbable-ragdoll] model load error:', err);

    if (isFbx) {
      const FBXLoader = window.BodyRiggedLoaders?.FBXLoader;
      if (!FBXLoader) {
        console.error('[grabbable-ragdoll] No FBXLoader for', path);
        return;
      }
      new FBXLoader().load(
        path,
        (fbx) => this._onModelLoaded(fbx, fbx.animations || [], { isFbx: true }),
        undefined,
        onErr
      );
      return;
    }

    const GLTFLoader = window.BodyRiggedLoaders?.GLTFLoader;
    if (!GLTFLoader) {
      console.error('[grabbable-ragdoll] No GLTFLoader for', path);
      return;
    }
    new GLTFLoader().load(
      path,
      (gltf) => this._onModelLoaded(gltf.scene, gltf.animations || [], { isFbx: false }),
      undefined,
      onErr
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

  _onModelLoaded: function (modelRoot, animations, meta) {
    this.model = modelRoot;
    // GLB (character.glb) is metres; Mixamo FBX is cm → 0.01
    if (meta?.isFbx) {
      modelRoot.scale.set(0.01, 0.01, 0.01);
      modelRoot.position.y = 0;
    } else {
      modelRoot.scale.set(1, 1, 1);
      modelRoot.position.y = 0.05;
    }
    modelRoot.rotation.y = Math.PI;

    this.el.object3D.add(modelRoot);

    modelRoot.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
        node.frustumCulled = false;
        if (node.material) {
          // Share by look across bots of the same source mesh; team emissive
          // swaps to a pooled variant in CapVRCombat.applyCharacterVisibility.
          if (window.CapVRMaterials) {
            node.material = window.CapVRMaterials.avatarTint(node.material, {});
          } else {
            node.material = node.material.clone();
          }
        }
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
    this.ensureGrabColliders();
    console.log('[grabbable-ragdoll] ready at', this.data.x, this.data.z);
  },

  /**
   * CapVR hitch-a-ride: bone-local .grabbable-player markers so zerog-player can grab
   * anywhere on the visible body (not just the head hit sphere). Does NOT enable
   * allowPalmGrab ragdoll pickup — tether grab stays on BoltVR playerGrab path.
   */
  _resolveGrabPlayerId: function () {
    let pid = this.el.getAttribute('data-player-id');
    if (pid) return pid;
    const botId = this.el.getAttribute('data-bot-id') || '';
    if (botId.startsWith('zerog-bot-')) return 'bot_' + botId.slice('zerog-bot-'.length);
    if (botId.startsWith('bot_') || botId.startsWith('bot-')) {
      return botId.replace(/^bot-/, 'bot_');
    }
    return null;
  },

  ensureGrabColliders: function () {
    if (this.grabCollidersBuilt) return;
    if (!this.bones || !this.bones.head) return;
    const pid = this._resolveGrabPlayerId();
    if (!pid) return;

    const b = this.bones;
    const handL = b.leftHandBone || b.leftHand;
    const handR = b.rightHandBone || b.rightHand;
    const parts = [
      [b.spine2, 0.18], [b.hips, 0.18],
      [b.leftUpperArm, 0.11], [b.rightUpperArm, 0.11],
      [b.leftForearm, 0.10], [b.rightForearm, 0.10],
      [handL, 0.12], [handR, 0.12],
      [b.leftUpLeg, 0.12], [b.rightUpLeg, 0.12],
      [b.leftLeg, 0.10], [b.rightLeg, 0.10],
      [b.leftFoot, 0.10], [b.rightFoot, 0.10],
      [b.head, 0.14], [b.neck, 0.10]
    ];

    this.grabMarkers = [];
    parts.forEach((p) => {
      const bone = p[0];
      if (!bone) return;
      const marker = document.createElement('a-entity');
      marker.classList.add('grabbable-player');
      marker.setAttribute('data-player-id', pid);
      marker.setAttribute('radius', p[1]);
      marker.setAttribute('data-body-collider', 'true');
      this.el.appendChild(marker);
      this.grabMarkers.push({ marker: marker, bone: bone, radius: p[1] });
      if (window.__grabVizOn && window.__addGrabViz) window.__addGrabViz(marker);
    });

    this._colliderTmp = this._colliderTmp || new THREE.Vector3();
    this.grabCollidersBuilt = true;
  },

  updateGrabColliders: function () {
    this.ensureGrabColliders();
    if (!this.grabCollidersBuilt || !this.grabMarkers) return;
    const tmp = this._colliderTmp;
    for (let i = 0; i < this.grabMarkers.length; i++) {
      const gm = this.grabMarkers[i];
      if (!gm.marker?.object3D || !gm.bone) continue;
      gm.bone.getWorldPosition(tmp);
      const parent = gm.marker.object3D.parent;
      if (parent) {
        parent.updateWorldMatrix(true, false);
        gm.marker.object3D.position.copy(parent.worldToLocal(tmp.clone()));
      }
    }
  },

  /** Same limb capsules as mixamo-body-avatar — used by zerog-player grab-snap / finger grasp. */
  ensureGraspCapsules: function () {
    if (this.graspCapsules) return this.graspCapsules;
    if (!this.bones || !this.bones.head) return null;
    const b = this.bones;
    const handL = b.leftHandBone || b.leftHand;
    const handR = b.rightHandBone || b.rightHand;
    const defs = [
      [b.leftUpperArm, b.leftForearm, 0.055],
      [b.leftForearm, handL, 0.045],
      [b.rightUpperArm, b.rightForearm, 0.055],
      [b.rightForearm, handR, 0.045],
      [b.leftUpLeg, b.leftLeg, 0.085],
      [b.leftLeg, b.leftFoot, 0.06],
      [b.rightUpLeg, b.rightLeg, 0.085],
      [b.rightLeg, b.rightFoot, 0.06],
      [b.hips, b.spine2, 0.13],
      [b.head, b.head, 0.10]
    ];
    this.graspCapsules = defs
      .filter((d) => d[0] && d[1])
      .map((d) => ({ a: d[0], b: d[1], r: d[2] }));
    return this.graspCapsules;
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
      mixamorigLeftHandMiddle3: 'leftHandTip',
      mixamorigRightShoulder: 'rightShoulder',
      mixamorigRightArm: 'rightUpperArm',
      mixamorigRightForeArm: 'rightForearm',
      mixamorigRightHand: 'rightHand',
      mixamorigRightHandMiddle3: 'rightHandTip',
      mixamorigLeftUpLeg: 'leftUpLeg',
      mixamorigLeftLeg: 'leftLeg',
      mixamorigLeftFoot: 'leftFoot',
      mixamorigLeftToeBase: 'leftToe',
      mixamorigLeftFootToeBase: 'leftToe',
      mixamorigRightUpLeg: 'rightUpLeg',
      mixamorigRightLeg: 'rightLeg',
      mixamorigRightFoot: 'rightFoot',
      mixamorigRightToeBase: 'rightToe',
      mixamorigRightFootToeBase: 'rightToe'
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

  /**
   * Hand-vs-character collision using live Mixamo limb capsules (same segments as
   * grab targeting). Matches the visible mesh pose — no Box3D proxy, no BVH bake.
   */
  _limbSegDef: function (idx) {
    if (idx < 16) return MESH_BODY_SEGS[idx] || null;
    return MESH_EXTRA_CAPS[idx - 16] || null;
  },

  _limbCapsuleRadius: function (idx) {
    const seg = this._limbSegDef(idx);
    if (seg && seg.r != null) return seg.r;
    return 0.06;
  },

  _boneWorldPos: function (key, dest) {
    const bone = this.bones[key];
    if (!bone) return false;
    bone.getWorldPosition(dest);
    return true;
  },

  _extendAlongBone: function (boneKey, along, dist, fromPos, dest) {
    if (dist <= 0) {
      dest.copy(fromPos);
      return;
    }
    if (along === 'worldUp') {
      dest.copy(fromPos).addScaledVector(this._segAB.set(0, 1, 0), dist);
      return;
    }
    const bone = this.bones[boneKey];
    if (!bone) {
      dest.copy(fromPos);
      return;
    }
    bone.getWorldQuaternion(this._tmpQ);
    if (along === 'up') {
      this._segAB.set(0, 1, 0).applyQuaternion(this._tmpQ).normalize();
      if (this._segAB.y < 0.35) this._segAB.set(0, 1, 0);
    } else if (along === 'hand') {
      this._segAB.set(0, 0, 0);
      const tipKey = boneKey.indexOf('left') === 0 ? 'leftHandTip' : 'rightHandTip';
      if (this.bones[tipKey] && tipKey !== boneKey) {
        this.bones[tipKey].getWorldPosition(this._closestAxis);
        this._segAB.copy(this._closestAxis).sub(fromPos);
      }
      if (this._segAB.lengthSq() < 1e-8) {
        const foreKey = boneKey.indexOf('left') === 0 ? 'leftForearm' : 'rightForearm';
        if (this.bones[foreKey]) {
          this.bones[foreKey].getWorldPosition(this._closestAxis);
          this._segAB.copy(fromPos).sub(this._closestAxis);
        }
      }
      if (this._segAB.lengthSq() < 1e-8) {
        this._segAB.set(0, 0, -1).applyQuaternion(this._tmpQ);
      }
      this._segAB.normalize();
    } else if (along === 'foot') {
      this._segAB.set(0, 0, 1).applyQuaternion(this._tmpQ);
      this._segAB.y = 0;
      if (this._segAB.lengthSq() < 1e-8) this._segAB.set(0, 0, 1);
      else this._segAB.normalize();
    } else {
      this._segAB.set(0, 1, 0).applyQuaternion(this._tmpQ).normalize();
    }
    dest.copy(fromPos).addScaledVector(this._segAB, dist);
  },

  _meshCapsuleEndpoints: function (idx, outA, outB) {
    const seg = this._limbSegDef(idx);
    if (!seg || !this.skeleton) return false;
    this._syncMeshWorldMatrices();
    if (!this._boneWorldPos(seg.a, outA)) return false;

    if (seg.offsetA) {
      this._extendAlongBone(seg.a, seg.along || 'worldUp', seg.offsetA, outA, outA);
    }

    if (seg.kind === 'sphere') {
      outB.copy(outA);
      return true;
    }

    if (seg.b && seg.b !== seg.a && this.bones[seg.b]) {
      this._boneWorldPos(seg.b, outB);
      if (seg.extendB) {
        this._extendAlongBone(seg.b, seg.along || 'up', seg.extendB, outB, outB);
      }
      return true;
    }

    const ext = seg.extendB || seg.fallbackExtend || 0.08;
    this._extendAlongBone(seg.a, seg.along || 'up', ext, outA, outB);
    return true;
  },

  _resolveSphereVsLimbCapsules: function (center, radius, preferToward) {
    const THREE = window.AFRAME.THREE;
    let bestPen = 0;
    let bestPos = null;
    let bestNormal = null;
    let bestContact = null;
    let bestIdx = -1;

    for (let i = 0; i < MESH_CAP_COUNT; i++) {
      if (!this._limbSegDef(i)) continue;
      if (!this._meshCapsuleEndpoints(i, this._segA, this._segB)) continue;
      const capR = this._limbCapsuleRadius(i);
      this._segAB.copy(this._segB).sub(this._segA);
      const abLen2 = this._segAB.lengthSq() || 1e-6;
      this._segAP.copy(center).sub(this._segA);
      let t = this._segAP.dot(this._segAB) / abLen2;
      t = Math.max(0, Math.min(1, t));
      this._closestAxis.copy(this._segA).addScaledVector(this._segAB, t);
      this._segAB.copy(center).sub(this._closestAxis);
      const dist = this._segAB.length();
      const need = radius + capR;
      const pen = need - dist;
      if (pen <= 1e-5) continue;
      if (pen <= bestPen) continue;

      let normal;
      if (dist > 1e-6) {
        normal = this._segAB.clone().multiplyScalar(1 / dist);
      } else if (preferToward) {
        normal = preferToward.clone().sub(this._closestAxis);
        if (normal.lengthSq() < 1e-10) normal.set(0, 1, 0);
        else normal.normalize();
      } else {
        normal = new THREE.Vector3(0, 1, 0);
      }
      bestPen = pen;
      bestContact = this._closestAxis.clone();
      bestNormal = normal;
      bestPos = this._closestAxis.clone().addScaledVector(normal, need + 0.0015);
      bestIdx = i;
    }

    if (!bestPos) {
      return {
        position: center.clone(),
        hit: false,
        normal: new THREE.Vector3(0, 1, 0),
        contactPoint: center.clone(),
        shapeId: null,
        limbIdx: -1
      };
    }
    return {
      position: bestPos,
      hit: true,
      normal: bestNormal,
      contactPoint: bestContact,
      shapeId: 'mesh-limb',
      limbIdx: bestIdx
    };
  },

  _invalidatePlayerHandCollisionHistory: function () {
    const mb = document.querySelector('#local-body')?.components['mixamo-body'];
    if (mb && mb.invalidateHandCollisionHistory) mb.invalidateHandCollisionHistory();
  },

  _ensureLimbDebugGroup: function () {
    if (this._limbDebugGroup) return this._limbDebugGroup;
    const group = new THREE.Group();
    group.name = 'grab-dummy-limb-collision-debug';
    group.frustumCulled = false;
    this.sceneEl.object3D.add(group);
    this._limbDebugGroup = group;
    return group;
  },

  _disposeLimbDebug: function () {
    if (!this._limbDebugGroup) return;
    while (this._limbDebugGroup.children.length) {
      const m = this._limbDebugGroup.children[0];
      this._limbDebugGroup.remove(m);
      if (m.geometry) m.geometry.dispose();
      if (m.material) m.material.dispose();
    }
    if (this._limbDebugGroup.parent) this._limbDebugGroup.parent.remove(this._limbDebugGroup);
    this._limbDebugGroup = null;
    this._limbContactMarker = null;
    this._holdHighlight.left = null;
    this._holdHighlight.right = null;
    this._holdHighlightRing.left = null;
    this._holdHighlightRing.right = null;
  },

  _syncLimbCollisionDebug: function (activeIdx, contact) {
    // CapVR bots / no debug: skip entirely (was still creating hold-highlight groups every frame).
    if (!this.data.showCollisionWireframe && this._heldHandCount() === 0) {
      return;
    }
    // Hold markers always update (even if limb wires are hidden).
    if (!this.data.showCollisionWireframe) {
      if (this._limbDebugGroup) {
        // Hide limb capsules but keep hold markers if present.
        for (let i = 0; i < this._limbDebugGroup.children.length; i++) {
          const m = this._limbDebugGroup.children[i];
          if (m === this._holdHighlight.left || m === this._holdHighlight.right ||
              m === this._holdHighlightRing.left || m === this._holdHighlightRing.right) {
            continue;
          }
          if (m === this._limbContactMarker) m.visible = false;
          else if (m.name && m.name.indexOf('ragdoll-hold-') === 0) continue;
          else m.visible = false;
        }
      }
      this._syncHoldHighlights(this._ensureLimbDebugGroup());
      return;
    }
    if (!this.modelLoaded || !this.skeleton) {
      this._syncHoldHighlights(null);
      return;
    }

    const group = this._ensureLimbDebugGroup();
    group.visible = true;

    // Keep the contact marker out of the capsule slot list.
    if (this._limbContactMarker && this._limbContactMarker.parent === group) {
      group.remove(this._limbContactMarker);
    }

    while (group.children.length < MESH_CAP_COUNT) {
      const geo = new THREE.CapsuleGeometry(0.05, 0.1, 4, 8);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00e5ff,
        wireframe: true,
        transparent: true,
        opacity: 0.35,
        depthTest: false,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1004;
      group.add(mesh);
    }

    for (let i = 0; i < MESH_CAP_COUNT; i++) {
      const mesh = group.children[i];
      if (!mesh) continue;
      const seg = this._limbSegDef(i);
      if (!seg || !this._meshCapsuleEndpoints(i, this._segA, this._segB)) {
        mesh.visible = false;
        continue;
      }
      const capR = this._limbCapsuleRadius(i);
      this._segAB.copy(this._segB).sub(this._segA);
      const len = this._segAB.length();
      const asSphere = seg.kind === 'sphere' || len < capR * 0.35;
      mesh.visible = true;
      mesh.position.copy(this._segA).add(this._segB).multiplyScalar(0.5);
      if (!asSphere && len > 1e-6) {
        mesh.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          this._segAB.clone().normalize()
        );
      } else {
        mesh.quaternion.identity();
      }
      const cyl = asSphere ? 0 : Math.max(0.001, len - 2 * capR);
      const shapeKey = asSphere ? 'sphere' : 'capsule';
      if (mesh.userData.shapeKey !== shapeKey ||
          !mesh.userData.capR || Math.abs(mesh.userData.capR - capR) > 1e-4 ||
          Math.abs(mesh.userData.cyl - cyl) > 1e-4) {
        if (mesh.geometry) mesh.geometry.dispose();
        mesh.geometry = asSphere
          ? new THREE.SphereGeometry(capR, 12, 10)
          : new THREE.CapsuleGeometry(capR, cyl, 4, 8);
        mesh.userData.shapeKey = shapeKey;
        mesh.userData.capR = capR;
        mesh.userData.cyl = cyl;
        mesh.scale.set(1, 1, 1);
      }
      mesh.material.color.setHex(
        this._isHeldLimbIdx(i) ? 0xffaa33
          : (i === activeIdx ? 0xff66aa : 0x00e5ff)
      );
      mesh.material.opacity = (this._isHeldLimbIdx(i) || i === activeIdx) ? 0.95 : 0.28;
    }

    if (!this._limbContactMarker) {
      this._limbContactMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.012, 10, 8),
        new THREE.MeshBasicMaterial({
          color: 0xff66aa,
          depthTest: false,
          depthWrite: false,
          transparent: true,
          opacity: 0.95
        })
      );
      this._limbContactMarker.renderOrder = 1006;
    }
    group.add(this._limbContactMarker);
    if (contact) {
      this._limbContactMarker.visible = true;
      this._limbContactMarker.position.copy(contact);
    } else {
      this._limbContactMarker.visible = false;
    }

    this._syncHoldHighlights(group);
  },

  _isHeldLimbIdx: function (idx) {
    if (idx < 0 || idx > 15) return false;
    return this._held.left === idx || this._held.right === idx;
  },

  _ensureHoldMarker: function (hand, group) {
    if (this._holdHighlight[hand]) return this._holdHighlight[hand];
    const color = hand === 'left' ? 0xffcc44 : 0xff8844;
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.028, 14, 12),
      new THREE.MeshBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95
      })
    );
    sphere.name = `ragdoll-hold-${hand}`;
    sphere.frustumCulled = false;
    sphere.renderOrder = 1007;
    group.add(sphere);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.045, 0.006, 8, 24),
      new THREE.MeshBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.85
      })
    );
    ring.frustumCulled = false;
    ring.renderOrder = 1007;
    group.add(ring);

    this._holdHighlight[hand] = sphere;
    this._holdHighlightRing[hand] = ring;
    return sphere;
  },

  /** Bright markers at each live grab-anchor on the ragdoll. */
  _syncHoldHighlights: function (group) {
    // Hold markers are debug-only; keep them hidden in normal play.
    if (this._holdHighlight.left) this._holdHighlight.left.visible = false;
    if (this._holdHighlight.right) this._holdHighlight.right.visible = false;
    if (this._holdHighlightRing.left) this._holdHighlightRing.left.visible = false;
    if (this._holdHighlightRing.right) this._holdHighlightRing.right.visible = false;
    return;
  },
  /**
   * Slide a palm sphere on live Mixamo limb capsules near the hand.
   */
  slidePalmOnMesh: function (lastValid, desired, dest, opts) {
    opts = opts || {};
    try {
      if (!this.modelLoaded || !this.skeleton) return null;

      const queryR = this.data.handMeshQueryRadius || 0.32;
      if (!this.isPalmNearRagdoll(desired, queryR)) {
        return null;
      }

      const radius = opts.radius != null ? opts.radius : 0.026;
      const preferToward = opts.preferToward || null;

      // Continuous: resolve along lastValid → desired if we have history.
      let result;
      if (lastValid) {
        const start = this._resolveSphereVsLimbCapsules(lastValid, radius, preferToward);
        if (start.hit) {
          result = start;
        } else {
          const delta = this._tmpV.copy(desired).sub(lastValid);
          let lo = 0;
          let hi = 1;
          const probe = new THREE.Vector3();
          for (let i = 0; i < 10; i++) {
            const mid = (lo + hi) * 0.5;
            probe.copy(lastValid).addScaledVector(delta, mid);
            if (this._resolveSphereVsLimbCapsules(probe, radius, preferToward).hit) hi = mid;
            else lo = mid;
          }
          probe.copy(lastValid).addScaledVector(delta, hi);
          result = this._resolveSphereVsLimbCapsules(probe, radius, preferToward);
          if (!result.hit) {
            result = this._resolveSphereVsLimbCapsules(desired, radius, preferToward);
          }
        }
      } else {
        result = this._resolveSphereVsLimbCapsules(desired, radius, preferToward);
      }

      this._lastLimbHitIdx = result.hit ? result.limbIdx : -1;
      this._lastLimbContact = result.hit ? result.contactPoint : null;

      if (dest && result.position) dest.copy(result.position);
      return result;
    } catch (e) {
      console.warn('[grabbable-ragdoll] slidePalmOnMesh failed:', e);
      return null;
    }
  },

  /**
   * Resolve a world-space sphere against live Mixamo limb capsules (head / probes).
   * Same geometry as hand collision — not Box3D ragdoll shapes.
   */
  resolveSphereOnMesh: function (center, radius, opts) {
    opts = opts || {};
    if (!this.modelLoaded || !this.skeleton || !center) return null;
    const r = radius != null ? radius : 0.2;
    const queryR = opts.queryRadius != null
      ? opts.queryRadius
      : Math.max(0.55, (this.data.handMeshQueryRadius || 0.32) + r);
    if (!this.isPalmNearRagdoll(center, queryR)) return null;

    const result = this._resolveSphereVsLimbCapsules(center, r, opts.preferToward || null);
    if (!result.hit) return null;

    if (opts.horizontalOnly) {
      result.position.y = center.y;
      if (result.normal) {
        result.normal.y = 0;
        if (result.normal.lengthSq() > 1e-8) result.normal.normalize();
        else result.normal.set(0, 0, 1);
      }
    }
    return result;
  },

  /**
   * Depenetrate the player locomotion capsule vs live Mixamo limb capsules.
   * Returns { hit, dx, dy, dz } to add to player translation, or null.
   */
  resolvePlayerCapsuleOnMesh: function (playerPos, capsule, opts) {
    opts = opts || {};
    if (!this.modelLoaded || !this.skeleton || !playerPos || !capsule) return null;

    const r = capsule.radius != null ? capsule.radius : 0.18;
    const c1y = capsule.center1?.y ?? 0.3;
    const c2y = capsule.center2?.y ?? 1.5;
    const samples = opts.samples != null ? opts.samples : 4;
    const horizontalOnly = opts.horizontalOnly !== false;
    const queryR = opts.queryRadius != null ? opts.queryRadius : 0.9;

    const midY = playerPos.y + (c1y + c2y) * 0.5;
    this._tmpV.set(playerPos.x, midY, playerPos.z);
    if (!this.isPalmNearRagdoll(this._tmpV, queryR)) return null;

    let preferToward = opts.preferToward || null;
    if (!preferToward && this.model) {
      this.model.getWorldPosition(this._modelCenter);
      // Push toward a point on the far side of the player from the dummy.
      this._segAP.set(
        playerPos.x * 2 - this._modelCenter.x,
        midY,
        playerPos.z * 2 - this._modelCenter.z
      );
      preferToward = this._segAP;
    }

    let hit = false;
    let corrX = 0;
    let corrY = 0;
    let corrZ = 0;
    const probe = this._bonePosTmp;

    for (let i = 0; i < samples; i++) {
      const t = samples <= 1 ? 0.5 : i / (samples - 1);
      const ly = c1y + (c2y - c1y) * t;
      probe.set(playerPos.x, playerPos.y + ly, playerPos.z);
      const res = this._resolveSphereVsLimbCapsules(probe, r, preferToward);
      if (!res.hit) continue;
      hit = true;
      let dx = res.position.x - probe.x;
      let dy = res.position.y - probe.y;
      let dz = res.position.z - probe.z;
      if (horizontalOnly) dy = 0;
      if (Math.abs(dx) > Math.abs(corrX)) corrX = dx;
      if (Math.abs(dy) > Math.abs(corrY)) corrY = dy;
      if (Math.abs(dz) > Math.abs(corrZ)) corrZ = dz;
    }

    if (!hit) return null;
    return { hit: true, dx: corrX, dy: corrY, dz: corrZ };
  },

  _spawnRagdoll: function (opts) {
    opts = opts || {};
    const R = window.Box3DRagdoll;
    const RT = window.Box3DRagdollRetarget;
    if (!R || !RT || !this.b3 || !this.world) return false;

    // Drop leftover idle query capsules if any older session left them around.
    if (this.human && this._queryCollidersOnly) {
      if (R.destroyHuman) R.destroyHuman(this.b3, this.human);
      this.human = null;
      this._queryCollidersOnly = false;
      if (this.legIk?.physics?.clearRagdollQueryShapes) {
        this.legIk.physics.clearRagdollQueryShapes();
      }
      this._invalidatePlayerHandCollisionHistory();
    } else if (this.human) {
      return true;
    }

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
    this._queryCollidersOnly = false;
    // Hand contact uses Mixamo limb capsules; Box3D ragdoll shapes are for dynamics only.
    if (this.legIk.physics && this.legIk.physics.clearRagdollQueryShapes) {
      this.legIk.physics.clearRagdollQueryShapes();
    }

    if (R.rotateHumanYaw) R.rotateHumanYaw(this.b3, this.human, Math.PI);

    RT.alignHumanToMeshAnchors(this, this.b3, this.human);
    RT.snapHandBodiesFromMesh(this, this.b3, this.human);
    this.retargetState = RT.calibrate(this, this.b3, this.human);
    this.ragdollActive = true;
    this._spawnedStanding = true;
    this._pauseIdleAnimation();
    if (collapse && R.wakeAllHumanBodies) R.wakeAllHumanBodies(this.b3, this.human);
    this._ragdollStuckTimer = 0;
    this._invalidatePlayerHandCollisionHistory();
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
    this._queryCollidersOnly = false;
    if (this.legIk?.physics?.clearRagdollQueryShapes) {
      this.legIk.physics.clearRagdollQueryShapes();
      this.legIk.physics.setHandCollideRagdoll?.(false);
    }

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
    this._queryCollidersOnly = false;
    this.group = null;
    this._meshHandNear = false;
    if (this.legIk?.physics?.clearRagdollQueryShapes) {
      this.legIk.physics.clearRagdollQueryShapes();
      this.legIk.physics.setHandCollideRagdoll?.(false);
    }

    this._restoreStaticPose();
    this._clearHitReactions();
    this._freeRagdollMode = false;
    this._ragdollStuckTimer = 0;
    this._entityBasePos.copy(this._staticPose.entityPos);
    this._entityBaseRotY = this._staticPose.entityQuat
      ? new THREE.Euler().setFromQuaternion(this._staticPose.entityQuat).y
      : 0;
    this._resumeIdleAnimation();
    this._disposeLimbDebug();
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
      this._grabPalmCtrlLocal[hand].set(0, 0, 0);
      this._grabPalmCtrlReady[hand] = false;
      this._grabPalmToBoneCtrlLocal[hand].set(0, 0, 0);
      this._grabPalmToBoneReady[hand] = false;
      this._grabReleaseBaseline[hand] = 0;
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

  /** Seed every ragdoll bone with pre-death flight velocity (zerog thruster carry). */
  _applyCarryVelocityToRagdoll: function (vel) {
    if (!vel || !this.human?.bodies || !this.b3?.b3Body_SetLinearVelocity) return;
    let vx = vel.x || 0;
    let vy = vel.y || 0;
    let vz = vel.z || 0;
    const speed = Math.hypot(vx, vy, vz);
    const maxCarry = this._isZeroGMode() ? 9 : 6;
    if (speed > maxCarry) {
      const s = maxCarry / speed;
      vx *= s; vy *= s; vz *= s;
    }
    if (speed < 0.05) return;
    for (let i = 0; i < this.human.bodies.length; i++) {
      if (this.human.dynamicFlags && !this.human.dynamicFlags[i]) continue;
      const body = this.human.bodies[i];
      if (!body) continue;
      let ox = 0;
      let oy = 0;
      let oz = 0;
      if (this.b3.b3Body_GetLinearVelocity) {
        const cur = this.b3.b3Body_GetLinearVelocity(body);
        ox = cur.x || 0; oy = cur.y || 0; oz = cur.z || 0;
      }
      this.b3.b3Body_SetLinearVelocity(body, {
        x: ox + vx,
        y: oy + vy,
        z: oz + vz
      });
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);
    }
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
  shatterFromShot: function (impactPoint, impactNormal, shotDir, strength, primaryRegionId, opts) {
    if (!this.modelLoaded || !window.RagdollShatter?.fracture) return false;
    if (!this.b3 || !this.world) return false;
    opts = opts || {};
    // Default (undefined): collapse on critical limb / body-knockdown only.
    // CapVR alive hits pass allowCollapse:false (chunks only).
    // CapVR death passes allowCollapse:true → always full ragdoll (not just on crit regions).
    const allowCollapse = opts.allowCollapse !== false;
    const forceDeathCollapse = opts.allowCollapse === true;

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
    const collectOpts = {
      bucketStore: this._shatterBucketCache,
      primaryRegionId: primaryRegionId || null
    };
    let collected = RS.collectRegionEntries(
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

    const shouldCollapse = forceDeathCollapse
      || (allowCollapse && (criticalDestroy || bodyKnockdown));

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
      // Inherit bot thruster / entity flight velocity so corpses keep momentum in zero-G.
      if (opts.carryVelocity) this._applyCarryVelocityToRagdoll(opts.carryVelocity);
    } else if (this.ragdollActive && this.human) {
      this._applyRagdollShotImpulses(shotDir, impactNormal, strength, zones, damageStage, false);
      if (RT?.apply && this.retargetState) {
        RT.apply(this, this.b3, this.human, this.retargetState);
      }
    } else if (RT?.apply && this.retargetState && this.human) {
      RT.apply(this, this.b3, this.human, this.retargetState);
    }

    if (zones.ids?.length) {
      this._syncMeshWorldMatrices(true);
      this._updateShatterSpaceInverse();
      this._patchShotBuckets(zones.ids);
      collected = RS.collectFromCatalog(
        this._shatterBucketCache,
        impactPoint,
        this._shatterSpaceInverse,
        this._shatteredRegionKeys,
        zones.ids
      );
      if (!zones.surfaceOnly && zones.primaryId) {
        fractureKeys = RS.keysForRegionIdFromEntries
          ? RS.keysForRegionIdFromEntries(collected.entries, zones.primaryId)
          : zones.keys.filter((k) => k.indexOf(zones.primaryId + ':') === 0);
      }
    }

    const fullRegionDestroy = !zones.surfaceOnly
      && zones.primaryId
      && damageStage != null
      && damageStage >= damageMax;

    // Full destroy must use every baked bucket for the region, not just proximity entries.
    if (fullRegionDestroy && RS.catalogKeysForRegionIds) {
      fractureKeys = RS.catalogKeysForRegionIds(
        this._shatterBucketCache,
        [zones.primaryId],
        this._shatteredRegionKeys
      );
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
      bucketStore: this._shatterBucketCache,
      primaryKeyOverride: zones.primaryKey || null,
      maxShardsPerShot: fullRegionDestroy ? RS.MAX_SHARDS_FULL_DESTROY : null
    });

    // Mark regions shattered only after fracture — marking before skipRegions blocked the final blow.
    if (fullRegionDestroy) {
      this._destroyedRegionIds[zones.primaryId] = true;
      this._markRegionKeysDestroyed(fractureKeys);
      this._hideShatteredRegionBones([zones.primaryId]);
    }

    if (newShards.length || damageStage) {
      this._bakeShardsToWorld(newShards);
      if (!zones.surfaceOnly && zones.primaryId && damageStage && !fullRegionDestroy) {
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
    // Grab radii are padded; aim uses a tighter hull so open-air shots past a
    // shoulder/neck don't register as mid-air hits a few meters out.
    return this._limbCapsuleRadius(segIdx) * 0.78;
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
      if (!this._meshCapsuleEndpoints(seg, this._segA, this._segB)) continue;
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
    const handKey = idx === 14 ? 'leftHand' : 'rightHand';
    const handBone = this.bones[handKey];
    if (!handBone) return false;
    handBone.getWorldPosition(this._tmpV);
    return this._tmpV.distanceTo(handPos) <= 0.09;
  },

  // Slight reach boost for limbs; torso/head use full grab radius (no penalty).
  _grabReachForBody: function (idx, baseDist, handPos) {
    if (idx >= 14) {
      return (handPos && this._handBodyEligible(idx, handPos)) ? baseDist * 1.15 : 0;
    }
    if (idx >= 10) return baseDist * 1.2;
    if (idx >= 6) return baseDist * 1.12;
    return baseDist;
  },

  _meshSegGrabPad: function (idx) {
    if (idx >= 14) return 0.05;
    if (idx >= 10) return 0.045;
    if (idx >= 6) return 0.04;
    if (idx === 5) return 0.06; // head sphere
    return 0.05; // torso
  },

  /**
   * Nearest grab body by live Mixamo limb/torso capsules (idle + ragdoll).
   * Searches the full body (0–15) — not limbs-only — so chest/head/hips grab
   * the same shapes the pink collision highlight shows.
   */
  _nearestMeshBodyTarget: function (handPos, maxDist) {
    if (!this.skeleton) return -1;
    this._syncMeshWorldMatrices();
    let best = -1;
    let bestD = maxDist;
    for (let i = 0; i <= 15; i++) {
      if (!this._handBodyEligible(i, handPos)) continue;
      if (!this._meshCapsuleEndpoints(i, this._segA, this._segB)) continue;
      const pad = this._meshSegGrabPad(i);
      const capR = this._limbCapsuleRadius(i);
      const d = this._distToSegment(handPos, this._segA, this._segB) - pad - capR * 0.15;
      const limit = this._grabReachForBody(i, maxDist, handPos);
      if (limit > 0 && d < limit && d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  },

  // Back-compat alias used by preview / palm projection.
  _nearestMeshLimbTarget: function (handPos, maxDist) {
    return this._nearestMeshBodyTarget(handPos, maxDist);
  },

  _nearestTargetWithin: function (handPos, maxDist) {
    // Prefer mesh capsules (match collision debug). Physics capsules only as fallback
    // while ragdoll is active and mesh endpoints fail.
    const meshHit = this._nearestMeshBodyTarget(handPos, maxDist);
    if (meshHit >= 0) return meshHit;

    if (!this.ragdollActive || !this.human) return -1;

    let best = -1;
    let bestD = maxDist;
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
      const limit = this._grabReachForBody(i, maxDist, handPos);
      if (limit > 0 && rawD < limit && rawD < bestD) {
        bestD = rawD;
        best = i;
      }
    }
    return best;
  },

  _nearestTarget: function (handPos) {
    const r = this.data.grabRadius;
    // Single pass over all body capsules (torso + limbs). Do NOT prefer limbs first —
    // that made idle grabs jump to arms/legs when the palm was on the chest/head.
    return this._nearestMeshBodyTarget(handPos, r * 1.25);
  },

  _isPalmNearRagdoll: function (palmWorld, pad) {
    if (!this.model || !palmWorld) return false;
    this.model.getWorldPosition(this._modelCenter);
    const reach = this._ragdollBoundsRadius + this.data.touchRadius + 0.1 + (pad || 0);
    return this._modelCenter.distanceToSquared(palmWorld) <= reach * reach;
  },

  isPalmNearRagdoll: function (palmWorld, pad) {
    return this._isPalmNearRagdoll(palmWorld, pad);
  },

  _nearestPreviewTarget: function (handPos) {
    const r = this.data.touchRadius;
    const idx = this._nearestMeshBodyTarget(handPos, r);
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
      this._playerArmHold[hand].hasHandQuat = false;
      this._holdHandQuatReady[hand] = false;
      return;
    }
    this._playerArmHold.left.active = false;
    this._playerArmHold.left.overloaded = false;
    this._playerArmHold.left.hasHandQuat = false;
    this._playerArmHold.right.active = false;
    this._playerArmHold.right.overloaded = false;
    this._playerArmHold.right.hasHandQuat = false;
    this._holdHandQuatReady.left = false;
    this._holdHandQuatReady.right = false;
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

  // Move the effective hold toward the target. Keep motion continuous — never snap.
  _smoothHoldToward: function (hand, target, idx) {
    const eff = this._effectiveHoldPos[hand];
    const dt = Math.max(this._lastDt || 0.016, 0.001);
    // Fast follow so the pin stays under the palm; still eases to avoid one-frame pops.
    const rate = this._isLimbBody(idx) ? 36 : 22;
    const alpha = 1 - Math.exp(-rate * dt);
    eff.lerp(target, alpha);
    return eff;
  },

  _holdWeightBlend: function (hand) {
    const hs = this._holdStart[hand];
    if (!hs || hs.t0 == null) return 1;
    const age = (performance.now() - hs.t0) / 1000;
    const t = Math.max(0, Math.min(1, age / (this.HOLD_WEIGHT_BLEND_S || 2.5)));
    // Smoothstep — weight limits fade in over ~2.5s.
    return t * t * (3 - 2 * t);
  },

  // Break the hold when the controller peels too far from the grab contact.
  // Without this, weight-capped bodies keep following the controller while the
  // virtual hand stays on the object — telekinetic drag with no detach.
  _shouldForceDetachHold: function (hand, ctrl, anchorWorld) {
    if (!ctrl || !anchorWorld) return false;
    const dist = ctrl.distanceTo(anchorWorld);
    if (dist > (this.HOLD_DETACH_MAX_M || 0.42)) return true;

    const blend = this._holdWeightBlend(hand);
    if (blend < 0.15) return false;

    const baseline = this._grabReleaseBaseline[hand] || 0;
    if (dist > baseline + (this.HOLD_RELEASE_DIST || 0.14)) return true;
    if ((ctrl.y - anchorWorld.y) > (this.HOLD_RELEASE_UP_M || 0.10)) return true;
    return false;
  },

  _updatePlayerArmHold: function (hand, bodyPos, bodyQuat, anchorWorld) {
    const h = this._playerArmHold[hand];
    h.active = true;
    // IK wrist = grab contact + the palm→handBone offset from grab time.
    // When weight caps the body, the anchor lags the controller and the virtual
    // hand stays on the object instead of tracking the controller freely.
    if (this._grabPalmToBoneReady[hand]) {
      this._segA.copy(this._grabPalmToBoneCtrlLocal[hand])
        .applyQuaternion(this._handQuat[hand])
        .add(anchorWorld);
      h.wristWorld.copy(this._segA);
    } else {
      h.wristWorld.copy(anchorWorld);
    }
    h.hasHandQuat = false;
    const ctrl = this._handPos[hand];
    const blend = this._holdWeightBlend(hand);
    h.overloaded = blend > 0.35 && (
      ctrl.distanceTo(anchorWorld) > 0.18 ||
      (ctrl.y - anchorWorld.y) > 0.05
    );
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
      upright,
      t0: performance.now()
    };
    const r = this.b3.b3Body_GetRotation(body);
    this._tmpQ.set(r.v.x, r.v.y, r.v.z, r.s);
    const bodyPos = { x: cur.x, y: cur.y, z: cur.z };

    // Pin exactly where the virtual palm was at the grab decision — never project
    // onto the mesh/capsule. Projection was sliding the anchor off the hand by
    // up to a few cm so the hold marker didn't match the visible palm.
    const pinPalm = this._segB;
    if (palmWorld && Number.isFinite(palmWorld.x)) {
      pinPalm.copy(palmWorld);
    } else if (this._getPlayerPalm(hand, this._rayOrigin, this._bonePosTmp)) {
      pinPalm.copy(this._bonePosTmp);
    } else {
      pinPalm.copy(this._handPos[hand]);
    }

    this._captureGrabAnchor(hand, bodyPos, this._tmpQ, pinPalm);
    this._grabRel[hand].copy(this._handQuat[hand]).invert().multiply(this._tmpQ);
    // Remember where the virtual palm sat relative to the controller at grab.
    this._grabPalmCtrlLocal[hand].copy(pinPalm).sub(this._handPos[hand]);
    this._tmpQ2 = this._tmpQ2 || new THREE.Quaternion();
    this._tmpQ2.copy(this._handQuat[hand]).invert();
    this._grabPalmCtrlLocal[hand].applyQuaternion(this._tmpQ2);
    this._grabPalmCtrlReady[hand] = true;
    this._grabReleaseBaseline[hand] = this._handPos[hand].distanceTo(pinPalm);

    // Palm → hand-bone offset in controller space (for weight-driven arm IK).
    this._grabPalmToBoneReady[hand] = false;
    const mb = document.querySelector('#local-body')?.components['mixamo-body'];
    const handBone = mb?.bones?.[`${hand}HandBone`];
    if (handBone) {
      if (mb.model) mb.model.updateMatrixWorld(true);
      if (mb.skeleton) mb.skeleton.update();
      handBone.getWorldPosition(this._segAP);
      this._grabPalmToBoneCtrlLocal[hand].copy(this._segAP).sub(pinPalm);
      this._tmpQ2.copy(this._handQuat[hand]).invert();
      this._grabPalmToBoneCtrlLocal[hand].applyQuaternion(this._tmpQ2);
      this._grabPalmToBoneReady[hand] = true;
    }

    this._holdHandQuatReady[hand] = false;

    const zero = { x: 0, y: 0, z: 0 };
    if (this.b3.b3Body_SetLinearVelocity) this.b3.b3Body_SetLinearVelocity(body, zero);
    if (this.b3.b3Body_SetAngularVelocity) this.b3.b3Body_SetAngularVelocity(body, zero);
    this.b3.b3Body_SetType(body, this.b3.b3BodyType.b3_kinematicBody);
    if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);

    // Keep the body where it is — offset was captured from the live palm, so the
    // hold marker starts under the hand. No snap/teleport on grab.
    this._holdSmoothedQuat[hand].copy(this._tmpQ);
    this._holdQuatReady[hand] = true;
    this._effectiveHoldPos[hand].set(cur.x, cur.y, cur.z);
    this._holdEffReady[hand] = true;
    this._setBodyTransform(idx, this._effectiveHoldPos[hand], this._tmpQ);
    this._recomputeLiftCeiling();
    this._anchorWorldFromBody(hand, this._effectiveHoldPos[hand], this._tmpQ, this._segB);
    this._grabAnchorWorld[hand].copy(this._segB);
    this._updatePlayerArmHold(hand, this._effectiveHoldPos[hand], this._tmpQ, this._segB);
  },

  // Hold: drive the kinematic body so the grab contact follows the virtual palm
  // (controller + grab-time palm offset), with weight/peel limits fading in.
  _holdBodyAtHand: function (hand, idx) {
    const body = this.human.bodies[idx];
    if (!body) return;
    if (!this._holdEffReady[hand]) {
      const cur = this.b3.b3Body_GetPosition(body);
      this._effectiveHoldPos[hand].set(cur.x, cur.y, cur.z);
      this._holdEffReady[hand] = true;
    }
    const ctrl = this._handPos[hand];
    // Prefer the grab-time palm-under-controller relationship so the pin stays
    // where the virtual hand was, instead of a live bone palm that can drift.
    const pullTarget = this._segAP;
    if (this._grabPalmCtrlReady[hand]) {
      pullTarget.copy(this._grabPalmCtrlLocal[hand]).applyQuaternion(this._handQuat[hand]).add(ctrl);
    } else {
      const probe = this._rayOrigin;
      const palmContact = this._bonePosTmp;
      if (this._getPlayerPalm(hand, probe, palmContact)) {
        pullTarget.copy(palmContact);
      } else {
        pullTarget.copy(ctrl);
      }
    }

    const targetQuat = this._tmpQ.copy(this._handQuat[hand]).multiply(this._grabRel[hand]);
    const holdQuat = this._holdSmoothedQuat[hand];
    if (!this._holdQuatReady[hand]) {
      holdQuat.copy(targetQuat);
      this._holdQuatReady[hand] = true;
    } else {
      const qAlpha = 1 - Math.exp(-18 * this._lastDt);
      holdQuat.slerp(targetQuat, qAlpha);
    }

    const freeCenter = this._bodyCenterForAnchor(hand, pullTarget, holdQuat, this._segA);
    const cappedCenter = this._computeHoldTarget(hand, idx, freeCenter);
    const blend = this._holdWeightBlend(hand);
    this._closestAxis.copy(freeCenter).lerp(cappedCenter, blend);

    const smoothed = this._smoothHoldToward(hand, this._closestAxis, idx);
    this._setBodyTransform(idx, smoothed, holdQuat);
    const anchorWorld = this._anchorWorldFromBody(hand, smoothed, holdQuat, this._segB);
    this._grabAnchorWorld[hand].copy(anchorWorld);
    this._updatePlayerArmHold(hand, smoothed, holdQuat, this._segB);

    if (this._shouldForceDetachHold(hand, ctrl, anchorWorld)) {
      this.forceReleaseHand(hand);
    }
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
    this._grabPalmCtrlLocal[hand].set(0, 0, 0);
    this._grabPalmCtrlReady[hand] = false;
    this._grabPalmToBoneCtrlLocal[hand].set(0, 0, 0);
    this._grabPalmToBoneReady[hand] = false;
    this._grabReleaseBaseline[hand] = 0;
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
    if (this.data.paused && !this.ragdollActive && !(this._shards && this._shards.length)) return;
    const dt = Math.min(deltaTime / 1000, 0.05);
    if (dt <= 0) return;
    this._lastDt = dt;

    if (this._shards?.length && window.RagdollShatter?.syncShards) {
      window.RagdollShatter.syncShards(this._shards, this.b3, dt, this.legIk?.queries || window.CapVRPhysics?.get?.()?.queries, {
        root: this._shardRoot,
        refMesh: this._shatterRefMesh || this._shards[0]?.mesh,
        spaceInverse: this._shardsWorldSpace ? null : this._shatterSpaceInverse,
        zeroG: this._isZeroGMode()
      });
    }

    const palmGrab = this.data.allowPalmGrab !== false;
    // Player hand tracking only when this instance is a grab-dummy (or already a live ragdoll hold).
    if (palmGrab || this.ragdollActive) {
      ['left', 'right'].forEach((hand) => {
        this._updateHand(hand, dt);
        this._grabPressed[hand] = this._isGrabPressed(hand);
      });
    }

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
      // Avoid a second full skeleton pass — hit-react already had one update above.
      if (this.model) this.model.updateMatrixWorld(true);
      this.updateGrabColliders();
      this._syncLimbCollisionDebug(this._lastLimbHitIdx, this._lastLimbContact);
      this._lastLimbHitIdx = -1;
      this._lastLimbContact = null;
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
    if (this.data.paused && !this.ragdollActive) return;
    const dt = Math.min(deltaTime / 1000, 0.05);
    const palmGrab = this.data.allowPalmGrab !== false;

    // Combat bots: no palm-grip → ragdoll. Death/collapse still enables ragdollActive.
    if (palmGrab || this.ragdollActive) {
      const palmProbe = this._rayOrigin;
      const palmContact = this._bonePosTmp;

      if (palmGrab) {
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
      }

      if (this._heldHandCount() > 0) {
        this._repinHeldBodies();
      }
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
      this._syncLimbCollisionDebug(this._lastLimbHitIdx, this._lastLimbContact);
      this._lastLimbHitIdx = -1;
      this._lastLimbContact = null;
    }
  }
});
