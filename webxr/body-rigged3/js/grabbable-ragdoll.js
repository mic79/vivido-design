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
AFRAME.registerComponent('grabbable-ragdoll', {
  schema: {
    modelPath: { type: 'string', default: 'character.glb' },
    x: { type: 'number', default: 1.4 },
    y: { type: 'number', default: 0 },
    z: { type: 'number', default: -1.6 },
    grabRadius: { type: 'number', default: 0.3 },
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
      }
    });

    this._mapBones();
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
      mixamorigRightShoulder: 'rightShoulder',
      mixamorigRightArm: 'rightUpperArm',
      mixamorigRightForeArm: 'rightForearm',
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

  _nearestTarget: function (handPos) {
    let best = -1;
    let bestD = this.data.grabRadius;
    if (this.ragdollActive && this.human) {
      // Measure distance to each limb's capsule surface (segment minus radius), so a
      // hand on the visible arm/leg registers even though the body center is far.
      const BONES = window.Box3DRagdoll.BONES;
      for (let i = 0; i < this.human.bodies.length; i++) {
        const bone = BONES[i];
        const p = this.b3.b3Body_GetPosition(this.human.bodies[i]);
        const r = this.b3.b3Body_GetRotation(this.human.bodies[i]);
        this._segQuat.set(r.v.x, r.v.y, r.v.z, r.s);
        this._segA.set(bone.c1.x, bone.c1.y, bone.c1.z).applyQuaternion(this._segQuat).add(p);
        this._segB.set(bone.c2.x, bone.c2.y, bone.c2.z).applyQuaternion(this._segQuat).add(p);
        const d = this._distToSegment(handPos, this._segA, this._segB) - bone.radius;
        if (d < bestD) { bestD = d; best = i; }
      }
    } else {
      const keys = window.Box3DRagdollRetarget?.MIXAMO_BONE_KEYS || [];
      for (let i = 0; i < keys.length; i++) {
        const bone = this.bones[keys[i]];
        if (!bone) continue;
        bone.getWorldPosition(this._tmpV);
        const d = this._tmpV.distanceTo(handPos);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return best;
  },

  getPlayerArmHold: function () {
    return this._playerArmHold;
  },

  isHandNearGrabbable: function (hand, handPos) {
    if (!this.modelLoaded || this._held[hand] >= 0) return false;
    return this._nearestTarget(handPos) >= 0;
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
    const bonus = nHands >= 2 ? (this.data.twoHandHoldBonus ?? 0.45) : 0;
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

  // Ideal hold goal after weight/peel/floor caps (may be far from current — never apply directly).
  _computeHoldTarget: function (hand, idx, desiredPos) {
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
      + (nHands >= 2 ? (this.data.twoHandHoldBonus ?? 0.45) * 0.5 : 0);
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
  _smoothHoldToward: function (hand, target) {
    const eff = this._effectiveHoldPos[hand];
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

  _updatePlayerArmHold: function (hand, smoothedBodyPos, controllerPos) {
    const h = this._playerArmHold[hand];
    h.active = true;
    const idx = this._held[hand];
    const weightTarget = idx >= 0
      ? this._computeHoldTarget(hand, idx, controllerPos)
      : controllerPos;
    // Arm IK targets the controller, with upward motion clamped by weight limits.
    h.wristWorld.copy(controllerPos);
    if (controllerPos.y > weightTarget.y) {
      h.wristWorld.y = weightTarget.y;
    }
    const dY = controllerPos.y - h.wristWorld.y;
    h.overloaded = dY > 0.008 || controllerPos.distanceTo(h.wristWorld) > this.OVERLOAD_DIST;
  },

  // Attach: make the grabbed body kinematic (so the joint solver can't fight it —
  // this is what eliminates the jitter/spin) and record the hand→body orientation.
  _attachBody: function (hand, idx) {
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
    // relQuat = inverse(handQuat) * bodyQuat
    this._grabRel[hand].copy(this._handQuat[hand]).invert().multiply(this._tmpQ);
    const zero = { x: 0, y: 0, z: 0 };
    if (this.b3.b3Body_SetLinearVelocity) this.b3.b3Body_SetLinearVelocity(body, zero);
    if (this.b3.b3Body_SetAngularVelocity) this.b3.b3Body_SetAngularVelocity(body, zero);
    this.b3.b3Body_SetType(body, this.b3.b3BodyType.b3_kinematicBody);
    if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);
    this._effectiveHoldPos[hand].set(cur.x, cur.y, cur.z);
    this._holdEffReady[hand] = true;
    this._recomputeLiftCeiling();
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
    const desired = this._handPos[hand];
    const target = this._computeHoldTarget(hand, idx, desired);
    const smoothed = this._smoothHoldToward(hand, target);
    const targetQuat = this._tmpQ.copy(this._handQuat[hand]).multiply(this._grabRel[hand]);
    const holdQuat = this._holdSmoothedQuat[hand];
    if (!this._holdQuatReady[hand]) {
      holdQuat.copy(targetQuat);
      this._holdQuatReady[hand] = true;
    } else {
      const qAlpha = 1 - Math.exp(-28 * this._lastDt);
      holdQuat.slerp(targetQuat, qAlpha);
    }
    this._setBodyTransform(idx, smoothed, holdQuat);
    this._updatePlayerArmHold(hand, smoothed, desired);
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
      const handPos = this._handPos[hand];

      if (pressed) {
        if (this._held[hand] < 0) {
          const idx = this._nearestTarget(handPos);
          if (idx >= 0) {
            if (!this.ragdollActive) {
              if (!this._spawnRagdoll()) return;
              this._held[hand] = idx;
              this._attachBody(hand, idx);
            } else {
              const bodyIdx = this._nearestTarget(handPos);
              if (bodyIdx >= 0) {
                this._held[hand] = bodyIdx;
                this._attachBody(hand, bodyIdx);
              }
            }
          }
        }
      } else if (this._held[hand] >= 0) {
        this._detachHand(hand, this._handVel[hand]);
      }
    });

    ['left', 'right'].forEach((hand) => {
      if (this._held[hand] >= 0 && this._isGrabPressed(hand)) {
        this._updateHoldMotionIntensity(hand, dt);
      } else {
        this._holdMotionIntensity[hand] = 0;
        this._holdMotionInit[hand] = false;
      }
    });

    // Apply hold before the physics step (tock) so joints are not integrated against a stale pose.
    this._updateHeldBodies();
  },

  tock: function (time, deltaTime) {
    if (!this.modelLoaded || !this.b3) return;

    // Re-pin kinematic grabs after the solver so the held point cannot drift/jitter.
    if (this._heldHandCount() > 0) {
      this._repinHeldBodies();
    }

    if (this.ragdollActive && this.human && this.retargetState && window.Box3DRagdollRetarget) {
      window.Box3DRagdollRetarget.apply(this, this.b3, this.human, this.retargetState);
    }
  }
});
