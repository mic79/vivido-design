/**
 * Box3D ragdoll human — ported from box3d.js example-ragdoll / ragdoll-human.ts
 * (14 bones) with added wrist-hand capsules so Mixamo hands can bend at the wrist.
 */
(function () {
  'use strict';

  const DEG = Math.PI / 180;

  const BONES = [
    {
      name: 'pelvis', parent: -1,
      refP: { x: 0.0, y: 0.932087, z: -0.051708 },
      refQ: { v: { x: 0.739169, y: 0.0, z: 0.0 }, s: 0.67352 },
      c1: { x: 0.07, y: 0.0, z: -0.08 }, c2: { x: -0.07, y: 0.0, z: -0.08 },
      radius: 0.13, groupFilter: false
    },
    {
      name: 'spine_01', parent: 0,
      refP: { x: 0.0, y: 1.113505, z: -0.03481 },
      refQ: { v: { x: 0.739973, y: 0.0, z: 0.0 }, s: 0.672637 },
      c1: { x: 0.06, y: -0.0, z: -0.052264 }, c2: { x: -0.06, y: 0.0, z: -0.052264 },
      radius: 0.12, groupFilter: true,
      joint: {
        type: 'spherical',
        localFrameA: { p: { x: 0.0, y: 0.0, z: -0.182204 }, q: { v: { x: -0.999999, y: 0.0, z: -0.0 }, s: 0.001194 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: -0.007736 }, q: { v: { x: -1.0, y: 0.0, z: -0.0 }, s: 0.0 } },
        swing: 25.0 * DEG, twistLo: -15.0 * DEG, twistHi: 15.0 * DEG, friction: 1.0
      }
    },
    {
      name: 'spine_02', parent: 1,
      refP: { x: 0.0, y: 1.194336, z: -0.027087 },
      refQ: { v: { x: 0.703611, y: 0.0, z: 0.0 }, s: 0.710586 },
      c1: { x: 0.08, y: -0.015133, z: -0.091801 }, c2: { x: -0.08, y: -0.015133, z: -0.091801 },
      radius: 0.1, groupFilter: false,
      joint: {
        type: 'spherical',
        localFrameA: { p: { x: 0.0, y: -0.0, z: -0.088935 }, q: { v: { x: -0.998619, y: -0.0, z: 0.0 }, s: -0.05254 } },
        localFrameB: { p: { x: -0.0, y: 0.0, z: -0.008199 }, q: { v: { x: -1.0, y: 0.0, z: -0.0 }, s: 0.0 } },
        swing: 25.0 * DEG, twistLo: -15.0 * DEG, twistHi: 15.0 * DEG, friction: 1.0
      }
    },
    {
      name: 'spine_03', parent: 2,
      refP: { x: -0.0, y: 1.31043, z: -0.028232 },
      refQ: { v: { x: 0.669856, y: 1e-6, z: -1e-6 }, s: 0.742491 },
      c1: { x: 0.11, y: -0.039753, z: -0.13 }, c2: { x: -0.11, y: -0.039753, z: -0.13 },
      radius: 0.145, groupFilter: false,
      joint: {
        type: 'spherical',
        localFrameA: { p: { x: -0.0, y: 0.0, z: -0.124298 }, q: { v: { x: -0.998921, y: 1e-6, z: -1e-6 }, s: -0.046434 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: -1.0, y: 0.0, z: -1e-6 }, s: 0.0 } },
        swing: 15.0 * DEG, twistLo: -10.0 * DEG, twistHi: 10.0 * DEG, friction: 1.0
      }
    },
    {
      name: 'neck', parent: 3,
      refP: { x: 0.0, y: 1.575582, z: -0.055837 },
      refQ: { v: { x: 0.879922, y: 0.0, z: 0.0 }, s: 0.475118 },
      c1: { x: -1e-6, y: -0.0, z: -0.02 }, c2: { x: 0.0, y: -0.005, z: -0.08 },
      radius: 0.07, groupFilter: false,
      joint: {
        type: 'spherical',
        localFrameA: { p: { x: 1e-6, y: -0.000259, z: -0.266585 }, q: { v: { x: -0.942192, y: -1e-6, z: 0.0 }, s: 0.335074 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: -1.0, y: 0.0, z: -1e-6 }, s: 0.0 } },
        swing: 45.0 * DEG, twistLo: -15.0 * DEG, twistHi: 15.0 * DEG, friction: 0.8
      }
    },
    {
      name: 'head', parent: 4,
      refP: { x: 0.0, y: 1.653348, z: -0.003241 },
      refQ: { v: { x: 0.750288, y: 0.0, z: 0.0 }, s: 0.661111 },
      c1: { x: -1e-6, y: 0.016892, z: -0.05869 }, c2: { x: 0.0, y: -0.003629, z: -0.115072 },
      radius: 0.0975, groupFilter: false,
      joint: {
        type: 'spherical',
        localFrameA: { p: { x: 0.0, y: 0.001321, z: -0.093873 }, q: { v: { x: -0.974301, y: -0.0, z: -0.0 }, s: -0.225251 } },
        localFrameB: { p: { x: 0.0, y: 0.001268, z: -0.005104 }, q: { v: { x: -1.0, y: 0.0, z: -0.0 }, s: 0.0 } },
        swing: 15.0 * DEG, twistLo: -15.0 * DEG, twistHi: 15.0 * DEG, friction: 0.4
      }
    },
    {
      name: 'thigh_l', parent: 0,
      refP: { x: 0.090416, y: 0.986104, z: -0.03509 },
      refQ: { v: { x: -0.703287, y: -0.070715, z: 0.053866 }, s: 0.705327 },
      c1: { x: 0.023719, y: 0.006008, z: -0.039068 }, c2: { x: -0.064492, y: -0.004664, z: -0.424718 },
      radius: 0.09, groupFilter: true,
      joint: {
        type: 'spherical',
        localFrameA: { p: { x: 0.05, y: 0.011537, z: -0.055325 }, q: { v: { x: -0.714896, y: -0.022305, z: -0.698361 }, s: -0.02679 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: -0.002064, y: 0.758987, z: 0.017046 }, s: 0.65088 } },
        swing: 10.0 * DEG, twistLo: -60.0 * DEG, twistHi: 40.0 * DEG, friction: 1.0
      }
    },
    {
      name: 'calf_l', parent: 6,
      refP: { x: 0.101198, y: 0.527027, z: -0.037374 },
      refQ: { v: { x: -0.653328, y: -0.06686, z: 0.058582 }, s: 0.751838 },
      c1: { x: 0.001778, y: 0.0, z: 0.009841 }, c2: { x: -0.078577, y: 0.014707, z: -0.41816 },
      radius: 0.075, groupFilter: false,
      joint: {
        type: 'revolute',
        localFrameA: { p: { x: -0.069989, y: 0.000253, z: -0.453844 }, q: { v: { x: -0.000677, y: 0.760087, z: 0.105674 }, s: 0.641171 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: -0.044589, y: 0.76554, z: 0.053368 }, s: 0.639619 } },
        swing: 0, twistLo: -5.0 * DEG, twistHi: 45.0 * DEG, friction: 1.0
      }
    },
    {
      name: 'thigh_r', parent: 0,
      refP: { x: -0.090416, y: 0.986104, z: -0.03509 },
      refQ: { v: { x: -0.703287, y: 0.070715, z: -0.053865 }, s: 0.705326 },
      c1: { x: -0.023719, y: 0.006008, z: -0.039068 }, c2: { x: 0.064492, y: -0.004664, z: -0.424718 },
      radius: 0.09, groupFilter: true,
      joint: {
        type: 'spherical',
        localFrameA: { p: { x: -0.05, y: 0.011537, z: -0.055326 }, q: { v: { x: -0.039089, y: -0.714094, z: 0.043177 }, s: 0.697623 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: 0.758805, y: -0.019886, z: -0.651012 }, s: -0.001759 } },
        swing: 10.0 * DEG, twistLo: -30.0 * DEG, twistHi: 60.0 * DEG, friction: 1.0
      }
    },
    {
      name: 'calf_r', parent: 8,
      refP: { x: -0.101198, y: 0.527027, z: -0.037373 },
      refQ: { v: { x: -0.653327, y: 0.06686, z: -0.058582 }, s: 0.751839 },
      c1: { x: -0.00182, y: 0.0, z: 0.010071 }, c2: { x: 0.077883, y: 0.014825, z: -0.418047 },
      radius: 0.075, groupFilter: false,
      joint: {
        type: 'revolute',
        localFrameA: { p: { x: 0.069988, y: 0.000253, z: -0.453844 }, q: { v: { x: 0.760086, y: -0.000675, z: -0.641171 }, s: -0.105676 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: 0.76554, y: -0.044589, z: -0.639619 }, s: -0.053368 } },
        swing: 0, twistLo: -45.0 * DEG, twistHi: 5.0 * DEG, friction: 1.0
      }
    },
    {
      name: 'upper_arm_l', parent: 3,
      refP: { x: 0.20378, y: 1.484275, z: -0.115897 },
      refQ: { v: { x: 0.143082, y: 0.69598, z: -0.69013 }, s: 0.13733 },
      c1: { x: 0.0, y: 0.0, z: 0.0 }, c2: { x: -0.091118, y: 0.037775, z: 0.229719 },
      radius: 0.075, groupFilter: false,
      joint: {
        type: 'spherical',
        localFrameA: { p: { x: 0.20378, y: -0.069369, z: -0.181921 }, q: { v: { x: -0.278486, y: 0.4456, z: -0.097014 }, s: 0.845266 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: -0.201396, y: -0.001586, z: 0.90185 }, s: 0.382234 } },
        swing: 60.0 * DEG, twistLo: -5.0 * DEG, twistHi: 5.0 * DEG, friction: 1.0
      }
    },
    {
      name: 'lower_arm_l', parent: 10,
      refP: { x: 0.305614, y: 1.242908, z: -0.117599 },
      refQ: { v: { x: 0.165048, y: 0.563437, z: -0.802002 }, s: 0.109959 },
      c1: { x: 0.0, y: 0.0, z: 0.0 }, c2: { x: -0.115, y: 0.032, z: 0.208 },
      radius: 0.05, groupFilter: false,
      joint: {
        type: 'revolute',
        localFrameA: { p: { x: -0.095482, y: 0.039584, z: 0.240723 }, q: { v: { x: 0.512487, y: -0.180629, z: 0.839474 }, s: 0.003742 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: 0.503803, y: -0.029831, z: 0.858168 }, s: 0.094017 } },
        swing: 0, twistLo: -5.0 * DEG, twistHi: 60.0 * DEG, friction: 1.0
      }
    },
    {
      name: 'upper_arm_r', parent: 3,
      refP: { x: -0.20378, y: 1.484276, z: -0.115899 },
      refQ: { v: { x: 0.143083, y: -0.695978, z: 0.690132 }, s: 0.137329 },
      c1: { x: 0.0, y: 0.0, z: 0.0 }, c2: { x: 0.091118, y: 0.037775, z: 0.229718 },
      radius: 0.075, groupFilter: false,
      joint: {
        type: 'spherical',
        localFrameA: { p: { x: -0.203779, y: -0.069371, z: -0.181922 }, q: { v: { x: -0.253621, y: -0.414842, z: 0.106962 }, s: 0.867261 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: -0.201397, y: 0.001587, z: -0.90185 }, s: 0.382233 } },
        swing: 60.0 * DEG, twistLo: -5.0 * DEG, twistHi: 5.0 * DEG, friction: 1.0
      }
    },
    {
      name: 'lower_arm_r', parent: 12,
      refP: { x: -0.305614, y: 1.242907, z: -0.117599 },
      refQ: { v: { x: 0.165048, y: -0.563437, z: 0.802002 }, s: 0.109959 },
      c1: { x: 0.0, y: 0.0, z: 0.0 }, c2: { x: 0.115, y: 0.032, z: 0.208 },
      radius: 0.05, groupFilter: false,
      joint: {
        type: 'revolute',
        localFrameA: { p: { x: 0.095484, y: 0.039585, z: 0.240723 }, q: { v: { x: -0.180627, y: 0.512487, z: -0.003744 }, s: -0.839474 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: -0.029831, y: 0.503803, z: -0.094017 }, s: -0.858169 } },
        swing: 0, twistLo: -60.0 * DEG, twistHi: 5.0 * DEG, friction: 1.0
      }
    },
    // Wrist-hand segments (reference ragdoll stops at the forearm; hands stay T-pose without these).
    {
      name: 'hand_l', parent: 11,
      refP: { x: 0.418, y: 1.281, z: 0.144 },
      refQ: { v: { x: 0.165048, y: 0.563437, z: -0.802002 }, s: 0.109959 },
      c1: { x: 0.0, y: 0.0, z: 0.0 }, c2: { x: -0.048, y: 0.012, z: 0.085 },
      radius: 0.042, groupFilter: false,
      joint: {
        type: 'spherical',
        localFrameA: { p: { x: -0.115, y: 0.032, z: 0.208 }, q: { v: { x: 0.503803, y: -0.029831, z: 0.858168 }, s: 0.094017 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: -1.0, y: 0.0, z: 0.0 }, s: 0.0 } },
        swing: 35.0 * DEG, twistLo: -25.0 * DEG, twistHi: 25.0 * DEG, friction: 0.6
      }
    },
    {
      name: 'hand_r', parent: 13,
      refP: { x: -0.418, y: 1.281, z: 0.144 },
      refQ: { v: { x: 0.165048, y: -0.563437, z: 0.802002 }, s: 0.109959 },
      c1: { x: 0.0, y: 0.0, z: 0.0 }, c2: { x: 0.048, y: 0.012, z: 0.085 },
      radius: 0.042, groupFilter: false,
      joint: {
        type: 'spherical',
        localFrameA: { p: { x: 0.115, y: 0.032, z: 0.208 }, q: { v: { x: -0.029831, y: 0.503803, z: -0.094017 }, s: -0.858169 } },
        localFrameB: { p: { x: 0.0, y: 0.0, z: 0.0 }, q: { v: { x: -1.0, y: 0.0, z: 0.0 }, s: 0.0 } },
        swing: 35.0 * DEG, twistLo: -25.0 * DEG, twistHi: 25.0 * DEG, friction: 0.6
      }
    }
  ];

  // Foot capsule sizing (added to each shin body; reference ragdoll has no feet).
  // heel drop + radius ≈ ankleToSole (~0.08) so the foot bottom lands at the sole
  // rather than well below it (which would pop the ragdoll upward on spawn).
  const FOOT_DROP = 0.03;   // ankle → heel center
  const FOOT_LEN = 0.16;    // heel → toe (forward)
  const FOOT_RADIUS = 0.05;

  function normQ(qv, s) {
    const len = Math.hypot(qv.x, qv.y, qv.z, s) || 1;
    return { v: { x: qv.x / len, y: qv.y / len, z: qv.z / len }, s: s / len };
  }

  function createHuman(b3, world, position, group, friction, hertz, damping, opts) {
    friction = friction ?? 0.05;
    hertz = hertz ?? 0;
    damping = damping ?? 0.5;
    opts = opts || {};

    // Optional partial ragdoll: only bones named here stay dynamic (go limp); all
    // other bones are kinematic so the rest of the body holds its pose in place.
    const dynamicBones = opts.dynamicBones ? new Set(opts.dynamicBones) : null;
    const enableJointMotors = opts.enableJointMotors !== false && friction > 0;
    const shapeDensity = opts.density;
    const floppyLimbs = opts.floppyLimbs === true;

    const bodies = [];
    const joints = [];
    const dynamicFlags = new Array(BONES.length).fill(true);
    const CATEGORY = window.Box3DCollision?.CATEGORY || { RAGDOLL: 8n, ENVIRONMENT: 1n };

    for (let i = 0; i < BONES.length; i++) {
      const bone = BONES[i];
      const isDynamic = !dynamicBones || dynamicBones.has(bone.name);
      dynamicFlags[i] = isDynamic;
      const bodyDef = b3.b3DefaultBodyDef();
      bodyDef.type = isDynamic
        ? b3.b3BodyType.b3_dynamicBody
        : b3.b3BodyType.b3_kinematicBody;
      bodyDef.rotation = bone.refQ;
      bodyDef.position = {
        x: position.x + bone.refP.x,
        y: position.y + bone.refP.y,
        z: position.z + bone.refP.z
      };
      // Never let ragdoll bodies sleep. We teleport them onto the live skeleton
      // pose at spawn (near rest velocity); with sleeping enabled the solver would
      // treat them as already settled and they'd freeze instead of falling.
      bodyDef.enableSleep = false;
      bodyDef.isAwake = true;
      const body = b3.b3CreateBody(world, bodyDef);

      const shapeDef = b3.b3DefaultShapeDef();
      if (shapeDensity != null) shapeDef.density = shapeDensity;
      shapeDef.baseMaterial.rollingResistance = 0.2;
      // Category RAGDOLL (not ENVIRONMENT) so the player capsule, its ground rays,
      // and its hand-grab (all masked to ENVIRONMENT) ignore the ragdoll. Otherwise
      // the player stands on / gets grab-pulled by a flailing ragdoll. It still
      // collides with the environment and with itself.
      shapeDef.filter.categoryBits = CATEGORY.RAGDOLL;
      shapeDef.filter.maskBits = CATEGORY.ENVIRONMENT | CATEGORY.RAGDOLL;
      shapeDef.filter.groupIndex = bone.groupFilter ? -group : 0;
      b3.b3CreateCapsuleShape(body, shapeDef, {
        center1: bone.c1,
        center2: bone.c2,
        radius: bone.radius
      });

      // The reference ragdoll has no feet — the calf capsule ends at the ankle, so
      // the mesh soles (~ankleToSole below) had nothing to rest on and sank into the
      // ground. Add a simple foot capsule to each shin so physics actually has feet
      // for ground contact and environment collision. No joint (same body).
      if (bone.name === 'calf_l' || bone.name === 'calf_r') {
        const q = new THREE.Quaternion(bone.refQ.v.x, bone.refQ.v.y, bone.refQ.v.z, bone.refQ.s).invert();
        const down = new THREE.Vector3(0, -1, 0).applyQuaternion(q);
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
        const ankle = new THREE.Vector3(bone.c2.x, bone.c2.y, bone.c2.z);
        const heel = ankle.clone().addScaledVector(down, FOOT_DROP);
        const toe = heel.clone().addScaledVector(fwd, FOOT_LEN);
        const footDef = b3.b3DefaultShapeDef();
        if (shapeDensity != null) footDef.density = shapeDensity;
        footDef.baseMaterial.rollingResistance = 0.2;
        footDef.filter.categoryBits = CATEGORY.RAGDOLL;
        footDef.filter.maskBits = CATEGORY.ENVIRONMENT | CATEGORY.RAGDOLL;
        footDef.filter.groupIndex = bone.groupFilter ? -group : 0;
        b3.b3CreateCapsuleShape(body, footDef, {
          center1: { x: heel.x, y: heel.y, z: heel.z },
          center2: { x: toe.x, y: toe.y, z: toe.z },
          radius: FOOT_RADIUS
        });
      }
      bodies.push(body);
    }

    for (let i = 1; i < BONES.length; i++) {
      const bone = BONES[i];
      if (!bone.joint) continue;
      // A joint between two non-dynamic (kinematic) bodies is pointless and can be
      // rejected by the solver — skip it in partial-ragdoll mode.
      if (!dynamicFlags[i] && !dynamicFlags[bone.parent]) continue;
      const j = bone.joint;
      const bodyA = bodies[bone.parent];
      const bodyB = bodies[i];
      const frameA = { p: j.localFrameA.p, q: normQ(j.localFrameA.q.v, j.localFrameA.q.s) };
      const frameB = { p: j.localFrameB.p, q: normQ(j.localFrameB.q.v, j.localFrameB.q.s) };

      if (j.type === 'revolute') {
        const def = b3.b3DefaultRevoluteJointDef();
        def.base.bodyIdA = bodyA;
        def.base.bodyIdB = bodyB;
        def.base.localFrameA = frameA;
        def.base.localFrameB = frameB;
        def.enableLimit = true;
        let lo = j.twistLo;
        let hi = j.twistHi;
        // Grabbable-only: widen elbow hinge so forearms fold more easily under gravity/drag.
        if (floppyLimbs && (bone.name === 'lower_arm_l' || bone.name === 'lower_arm_r')) {
          lo -= 20.0 * DEG;
          hi += 20.0 * DEG;
        }
        def.lowerAngle = lo;
        def.upperAngle = hi;
        def.enableSpring = hertz > 0;
        def.hertz = hertz;
        def.dampingRatio = damping;
        def.enableMotor = enableJointMotors;
        def.maxMotorTorque = enableJointMotors ? j.friction * friction : 0;
        joints.push(b3.b3CreateRevoluteJoint(world, def));
      } else {
        const def = b3.b3DefaultSphericalJointDef();
        def.base.bodyIdA = bodyA;
        def.base.bodyIdB = bodyB;
        def.base.localFrameA = frameA;
        def.base.localFrameB = frameB;
        def.enableConeLimit = true;
        let swing = j.swing;
        let twistLo = j.twistLo;
        let twistHi = j.twistHi;
        // Grabbable-only: the reference shoulder twist limits (±5°) lock the upper arm
        // near T-pose and prevent the elbow from getting leverage to fold.
        if (floppyLimbs && (bone.name === 'upper_arm_l' || bone.name === 'upper_arm_r')) {
          swing = 75.0 * DEG;
          twistLo = -40.0 * DEG;
          twistHi = 40.0 * DEG;
        }
        if (floppyLimbs && (bone.name === 'hand_l' || bone.name === 'hand_r')) {
          swing = 55.0 * DEG;
          twistLo = -40.0 * DEG;
          twistHi = 40.0 * DEG;
        }
        def.coneAngle = swing;
        def.enableTwistLimit = true;
        def.lowerTwistAngle = twistLo;
        def.upperTwistAngle = twistHi;
        def.enableSpring = hertz > 0;
        def.hertz = hertz;
        def.dampingRatio = damping;
        def.enableMotor = enableJointMotors;
        def.maxMotorTorque = enableJointMotors ? j.friction * friction : 0;
        joints.push(b3.b3CreateSphericalJoint(world, def));
      }
    }

    // Thigh–thigh filter joint (stop the legs colliding). Only needed when at least
    // one thigh is dynamic; skip it if both are kinematic in partial-ragdoll mode.
    if (dynamicFlags[6] || dynamicFlags[8]) {
      const filterDef = b3.b3DefaultFilterJointDef();
      filterDef.base.bodyIdA = bodies[6];
      filterDef.base.bodyIdB = bodies[8];
      joints.push(b3.b3CreateFilterJoint(world, filterDef));
    }

    return { bodies, joints, dynamicFlags, boneNames: BONES.map((b) => b.name) };
  }

  function destroyHuman(b3, human) {
    if (!human) return;
    for (let i = 0; i < human.joints.length; i++) {
      b3.b3DestroyJoint(human.joints[i], false);
    }
    for (let i = 0; i < human.bodies.length; i++) {
      b3.b3DestroyBody(human.bodies[i]);
    }
  }

  const _lowLocal = new THREE.Vector3();
  const _lowQuat = new THREE.Quaternion();

  /**
   * Lowest world-space point of the whole ragdoll (bottom of the lowest capsule),
   * accounting for each body's current rotation and capsule radius.
   */
  function computeLowestY(b3, human) {
    let minY = Infinity;
    for (let i = 0; i < BONES.length; i++) {
      const body = human.bodies[i];
      if (!body) continue;
      const bone = BONES[i];
      const pos = b3.b3Body_GetPosition(body);
      const rot = b3.b3Body_GetRotation(body);
      _lowQuat.set(rot.v.x, rot.v.y, rot.v.z, rot.s);
      const ends = [bone.c1, bone.c2];
      for (let e = 0; e < ends.length; e++) {
        _lowLocal.set(ends[e].x, ends[e].y, ends[e].z).applyQuaternion(_lowQuat);
        const wy = pos.y + _lowLocal.y - bone.radius;
        if (wy < minY) minY = wy;
      }
      // Foot capsules (same geometry as createHuman) — without these, lowestY sits
      // ~8 cm above the real sole and every lift limit thinks the body is airborne.
      if (bone.name === 'calf_l' || bone.name === 'calf_r') {
        const refInv = new THREE.Quaternion(
          bone.refQ.v.x, bone.refQ.v.y, bone.refQ.v.z, bone.refQ.s
        ).invert();
        const down = new THREE.Vector3(0, -1, 0).applyQuaternion(refInv);
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(refInv);
        const ankle = new THREE.Vector3(bone.c2.x, bone.c2.y, bone.c2.z);
        const heel = ankle.clone().addScaledVector(down, FOOT_DROP);
        const toe = heel.clone().addScaledVector(fwd, FOOT_LEN);
        for (const footLocal of [heel, toe]) {
          _lowLocal.copy(footLocal).applyQuaternion(_lowQuat);
          const wy = pos.y + _lowLocal.y - FOOT_RADIUS;
          if (wy < minY) minY = wy;
        }
      }
    }
    return minY;
  }

  /** Give every dynamic body an initial linear velocity (carry player momentum). */
  function setHumanVelocity(b3, human, vx, vy, vz) {
    if (!b3.b3Body_SetLinearVelocity) return;
    const vel = { x: vx, y: vy, z: vz };
    for (let i = 0; i < BONES.length; i++) {
      const body = human.bodies[i];
      if (!body) continue;
      if (human.dynamicFlags && !human.dynamicFlags[i]) continue;
      b3.b3Body_SetLinearVelocity(body, vel);
      if (b3.b3Body_SetAwake) b3.b3Body_SetAwake(body, true);
    }
  }

  /** Rigidly translate every body by the same delta (preserves all joints). */
  function translateHuman(b3, human, dx, dy, dz) {
    for (let i = 0; i < BONES.length; i++) {
      const body = human.bodies[i];
      if (!body) continue;
      const pos = b3.b3Body_GetPosition(body);
      const rot = b3.b3Body_GetRotation(body);
      b3.b3Body_SetTransform(
        body,
        { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz },
        rot
      );
      if (b3.b3Body_SetAwake) b3.b3Body_SetAwake(body, true);
    }
  }

  const _yawPivot = new THREE.Vector3();
  const _yawRelPos = new THREE.Vector3();
  const _yawQ = new THREE.Quaternion();
  const _yawBodyQ = new THREE.Quaternion();
  const _yawNewQ = new THREE.Quaternion();
  const _yawAxis = new THREE.Vector3(0, 1, 0);

  /** Rotate every body around the pelvis by a world-Y yaw (preserves joints). */
  function rotateHumanYaw(b3, human, angleRad) {
    if (!human?.bodies?.length || !angleRad) return;
    const pelvisPos = b3.b3Body_GetPosition(human.bodies[0]);
    _yawPivot.set(pelvisPos.x, pelvisPos.y, pelvisPos.z);
    _yawQ.setFromAxisAngle(_yawAxis, angleRad);

    for (let i = 0; i < human.bodies.length; i++) {
      const body = human.bodies[i];
      const pos = b3.b3Body_GetPosition(body);
      const rot = b3.b3Body_GetRotation(body);

      _yawRelPos.set(pos.x - _yawPivot.x, pos.y - _yawPivot.y, pos.z - _yawPivot.z);
      _yawRelPos.applyQuaternion(_yawQ);

      _yawBodyQ.set(rot.v.x, rot.v.y, rot.v.z, rot.s);
      _yawNewQ.copy(_yawQ).multiply(_yawBodyQ);

      b3.b3Body_SetTransform(
        body,
        {
          x: _yawPivot.x + _yawRelPos.x,
          y: _yawPivot.y + _yawRelPos.y,
          z: _yawPivot.z + _yawRelPos.z
        },
        { v: { x: _yawNewQ.x, y: _yawNewQ.y, z: _yawNewQ.z }, s: _yawNewQ.w }
      );
      if (b3.b3Body_SetAwake) b3.b3Body_SetAwake(body, true);
    }
  }

  function capsuleGeometryFromBone(bone, scale) {
    const axis = new THREE.Vector3(
      bone.c2.x - bone.c1.x,
      bone.c2.y - bone.c1.y,
      bone.c2.z - bone.c1.z
    );
    const len = axis.length();
    const geom = new THREE.CapsuleGeometry(bone.radius * scale, Math.max(0.01, len * scale), 8, 16);
    if (len > 1e-6) {
      geom.applyQuaternion(
        new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize())
      );
    }
    geom.translate(
      (bone.c1.x + bone.c2.x) * 0.5 * scale,
      (bone.c1.y + bone.c2.y) * 0.5 * scale,
      (bone.c1.z + bone.c2.z) * 0.5 * scale
    );
    return geom;
  }

  function capsuleGeometryForBody(b3, body, bone, scale) {
    scale = scale || 1;
    try {
      if (b3.b3Body_GetShapes && b3.b3Shape_GetCapsule) {
        const shapes = b3.b3Body_GetShapes(body);
        if (shapes && shapes.length > 0) {
          const cap = b3.b3Shape_GetCapsule(shapes[0]);
          const axis = new THREE.Vector3(
            cap.center2.x - cap.center1.x,
            cap.center2.y - cap.center1.y,
            cap.center2.z - cap.center1.z
          );
          const len = axis.length();
          const geom = new THREE.CapsuleGeometry(cap.radius * scale, Math.max(0.01, len * scale), 8, 16);
          if (len > 1e-6) {
            geom.applyQuaternion(
              new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize())
            );
          }
          geom.translate(
            (cap.center1.x + cap.center2.x) * 0.5 * scale,
            (cap.center1.y + cap.center2.y) * 0.5 * scale,
            (cap.center1.z + cap.center2.z) * 0.5 * scale
          );
          return geom;
        }
      }
    } catch (e) { /* use bone fallback */ }
    return capsuleGeometryFromBone(bone, scale);
  }

  function syncHumanToThree(b3, human, rootGroup, scale) {
    if (!human || !rootGroup) return;
    scale = scale || 1;
    for (let i = 0; i < human.bodies.length; i++) {
      let mesh = rootGroup.children[i];
      if (!mesh) {
        const geom = capsuleGeometryForBody(b3, human.bodies[i], BONES[i], scale);
        mesh = new THREE.Mesh(
          geom,
          new THREE.MeshStandardMaterial({ color: i === 0 ? 0x4a90e2 : 0x66bb6a, roughness: 0.5, metalness: 0.05 })
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        rootGroup.add(mesh);
      }
      const pos = b3.b3Body_GetPosition(human.bodies[i]);
      const rot = b3.b3Body_GetRotation(human.bodies[i]);
      mesh.position.set(pos.x, pos.y, pos.z);
      mesh.quaternion.set(rot.v.x, rot.v.y, rot.v.z, rot.s);
    }
  }

  function _createRagdollCapsuleMesh(b3, body, bone, scale, color) {
    const geom = capsuleGeometryForBody(b3, body, bone, scale);
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshStandardMaterial({ color: color, roughness: 0.5, metalness: 0.05 })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  function ensureMirrorVisualMeshes(b3, human, mirrorGroup, scale) {
    if (!human || !mirrorGroup || !b3) return;
    scale = scale || 1;
    for (let i = 0; i < human.bodies.length; i++) {
      if (mirrorGroup.children[i]) continue;
      mirrorGroup.add(_createRagdollCapsuleMesh(b3, human.bodies[i], BONES[i], scale, i === 0 ? 0x43a047 : 0x81c784));
    }
  }

  /** Mirror ragdoll pose like mixamo-body syncPoseFromLocal (offset −Z + thumbstick yaw). */
  function syncMirroredHumanToThree(sourceGroup, mirrorGroup, opts) {
    if (!sourceGroup || !mirrorGroup) return;
    const mirrorDistance = opts?.mirrorDistance ?? 2;
    const manualRotationY = opts?.manualRotationY ?? 0;
    const camera = opts?.camera;

    let mirrorCenter = null;
    let manualQuat = null;
    let rotMat = null;
    if (manualRotationY !== 0 && camera?.object3D) {
      const headWorldPos = new THREE.Vector3();
      camera.object3D.getWorldPosition(headWorldPos);
      mirrorCenter = new THREE.Vector3(
        headWorldPos.x,
        headWorldPos.y - 0.3,
        headWorldPos.z - mirrorDistance
      );
      manualQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), manualRotationY);
      rotMat = new THREE.Matrix4().makeRotationY(manualRotationY);
    }

    sourceGroup.updateMatrixWorld(true);
    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();

    for (let i = 0; i < sourceGroup.children.length; i++) {
      const src = sourceGroup.children[i];
      const dst = mirrorGroup.children[i];
      if (!src || !dst) continue;

      src.getWorldPosition(worldPos);
      src.getWorldQuaternion(worldQuat);

      worldPos.z -= mirrorDistance;

      if (mirrorCenter && rotMat && manualQuat) {
        worldPos.sub(mirrorCenter).applyMatrix4(rotMat).add(mirrorCenter);
        worldQuat.premultiply(manualQuat);
      }

      dst.position.copy(worldPos);
      dst.quaternion.copy(worldQuat);
    }
  }

  window.Box3DRagdoll = {
    BONES,
    createHuman,
    destroyHuman,
    computeLowestY,
    translateHuman,
    rotateHumanYaw,
    setHumanVelocity,
    syncHumanToThree,
    ensureMirrorVisualMeshes,
    syncMirroredHumanToThree
  };
})();
