/**
 * Palm collider frame: controller-local (#left-palm) and Mixamo hand-bone-local offsets.
 * Required for getPalmWorldPose — without this, palms fall back to white controller hands.
 */
(function () {
  const C = () => window.VRDRIFT || {};

  function THREE() {
    return (typeof AFRAME !== 'undefined' && AFRAME.THREE) || window.THREE;
  }

  function deg(d) {
    return (d || 0) * (Math.PI / 180);
  }

  function quatFromEulerDeg(rx, ry, rz, order) {
    const T = THREE();
    const e = new T.Euler(deg(rx), deg(ry), deg(rz), order || 'XYZ');
    return new T.Quaternion().setFromEuler(e);
  }

  function quatFromAxisDeg(axis, degrees) {
    const T = THREE();
    const a = axis || 'z';
    const v = new T.Vector3(a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0);
    return new T.Quaternion().setFromAxisAngle(v, deg(degrees));
  }

  window.VRDriftPalmFrame = {
    palmHalfExtents: function () {
      const cfg = C();
      return {
        hx: cfg.PALM_PHYSICS_HALF_WIDTH != null ? cfg.PALM_PHYSICS_HALF_WIDTH : 0.07,
        hy: cfg.PALM_PHYSICS_HALF_THICK != null ? cfg.PALM_PHYSICS_HALF_THICK : 0.014,
        hz: cfg.PALM_PHYSICS_HALF_LENGTH != null ? cfg.PALM_PHYSICS_HALF_LENGTH : 0.052
      };
    },

    /** Palm box on #left-palm / #right-palm (controller-local). */
    composeControllerLocalMatrix: function (outMatrix) {
      const cfg = C();
      const T = THREE();
      const tx = cfg.PALM_COLLIDER_OFFSET_X != null ? cfg.PALM_COLLIDER_OFFSET_X : 0;
      const ty =
        cfg.PALM_COLLIDER_OFFSET_Y != null
          ? cfg.PALM_COLLIDER_OFFSET_Y
          : cfg.PALM_ANCHOR_Y != null
            ? cfg.PALM_ANCHOR_Y
            : -0.03;
      const tz =
        cfg.PALM_COLLIDER_OFFSET_Z != null
          ? cfg.PALM_COLLIDER_OFFSET_Z
          : cfg.PALM_ANCHOR_Z != null
            ? cfg.PALM_ANCHOR_Z
            : -0.07;
      const pos = new T.Vector3(tx, ty, tz);
      const quat = quatFromEulerDeg(
        cfg.PALM_LOCAL_ROT_X != null ? cfg.PALM_LOCAL_ROT_X : -90,
        cfg.PALM_LOCAL_ROT_Y != null ? cfg.PALM_LOCAL_ROT_Y : 0,
        cfg.PALM_LOCAL_ROT_Z != null ? cfg.PALM_LOCAL_ROT_Z : 0
      );
      outMatrix.compose(pos, quat, new T.Vector3(1, 1, 1));
      return outMatrix;
    },

    /** Mirrored palm tilt on mixamorig hand bone (local quat). */
    composeSymmetricPalmLocalQuat: function (side) {
      const cfg = C();
      const sign = side === 'left' ? 1 : -1;
      const qBase = quatFromEulerDeg(
        cfg.PALM_BONE_LOCAL_ROT_X != null ? cfg.PALM_BONE_LOCAL_ROT_X : -90,
        cfg.PALM_BONE_LOCAL_ROT_Y != null ? cfg.PALM_BONE_LOCAL_ROT_Y : 0,
        cfg.PALM_BONE_LOCAL_ROT_Z != null ? cfg.PALM_BONE_LOCAL_ROT_Z : 90
      );
      const qTip = quatFromAxisDeg(
        cfg.PALM_BONE_TIP_AXIS || 'z',
        cfg.PALM_BONE_TIP_DEG != null ? cfg.PALM_BONE_TIP_DEG : 90
      );
      const rollDeg =
        (cfg.PALM_BONE_ROLL_DEG != null ? cfg.PALM_BONE_ROLL_DEG : -16) * sign;
      const qRoll = quatFromAxisDeg('z', rollDeg);
      return qBase.clone().multiply(qTip).multiply(qRoll);
    }
  };
})();
