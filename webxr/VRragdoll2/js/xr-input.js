/**
 * Quest / WebXR gamepad pairing (from VRrunner sandboxSectorEditor).
 */

/** @param {GamepadButton | undefined} btn */
export function xrGripSqueezed(btn) {
  if (!btn) return false;
  if (btn.pressed) return true;
  const v = typeof btn.value === 'number' ? btn.value : 0;
  return v > 0.55;
}

/**
 * @param {XRSession | null | undefined} session
 * @returns {{ L: XRInputSource | null, R: XRInputSource | null }}
 */
export function pairTouchGamepads(session) {
  /** @type {XRInputSource[]} */
  const list = [];
  const srcs = session?.inputSources;
  if (!srcs) return { L: null, R: null };
  for (let i = 0; i < srcs.length; i++) {
    const s = srcs[i];
    if (s?.gamepad?.buttons?.length) list.push(s);
  }
  let L = null;
  let R = null;
  /** @type {XRInputSource[]} */
  const amb = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    const h = s.handedness;
    if (h === 'left') L = s;
    else if (h === 'right') R = s;
    else amb.push(s);
  }
  for (let i = 0; i < amb.length; i++) {
    const s = amb[i];
    if (!L) L = s;
    else if (!R) R = s;
    else break;
  }
  return { L, R };
}

/**
 * @param {XRInputSource | null} src
 * @param {THREE.Object3D | null | undefined} gripA
 * @param {THREE.Object3D | null | undefined} gripB
 */
function gripForInputSource(src, gripA, gripB) {
  if (!src) return null;
  if (gripA?.userData?.xrInputSource === src) return gripA;
  if (gripB?.userData?.xrInputSource === src) return gripB;
  return null;
}

/**
 * @param {XRSession | null | undefined} session
 * @param {THREE.Object3D | null | undefined} gripA
 * @param {THREE.Object3D | null | undefined} gripB
 */
export function getPairedXRControllerGrips(session, gripA, gripB) {
  const { L, R } = pairTouchGamepads(session);
  let leftGrip = gripForInputSource(L, gripA, gripB);
  let rightGrip = gripForInputSource(R, gripA, gripB);
  if (!leftGrip && !rightGrip && (gripA || gripB)) {
    leftGrip = gripA || null;
    rightGrip = gripB && gripB !== leftGrip ? gripB : null;
  } else {
    if (!leftGrip && rightGrip && gripA && gripA !== rightGrip) leftGrip = gripA;
    if (!rightGrip && leftGrip && gripB && gripB !== leftGrip) rightGrip = gripB;
  }
  const squeezeLeft = L?.gamepad ? xrGripSqueezed(L.gamepad.buttons[1]) : false;
  const squeezeRight = R?.gamepad ? xrGripSqueezed(R.gamepad.buttons[1]) : false;
  return { L, R, leftGrip, rightGrip, squeezeLeft, squeezeRight };
}

/**
 * Grip position in XR reference space (stable in the play area; not affected by rig locomotion).
 * @param {XRFrame | null | undefined} xrFrame
 * @param {XRReferenceSpace | null | undefined} refSpace
 * @param {XRInputSource | null | undefined} inputSource
 * @param {THREE.Vector3} out
 */
export function getGripRefPosition(xrFrame, refSpace, inputSource, out) {
  if (!xrFrame || !refSpace || !inputSource?.gripSpace) return false;
  const pose = xrFrame.getPose(inputSource.gripSpace, refSpace);
  if (!pose) return false;
  const p = pose.transform.position;
  out.set(p.x, p.y, p.z);
  return true;
}

/** @param {Gamepad | null | undefined} gp @param {boolean} toLeftHand */
export function applyGamepadAxesToVRInput(gp, toLeftHand, vrInput) {
  if (!gp?.axes || gp.axes.length < 2) return;
  const axes = gp.axes;
  let stickX;
  let stickY;
  if (axes.length >= 4) {
    stickX = axes[2];
    stickY = axes[3];
  } else {
    stickX = axes[0] || 0;
    stickY = axes[1] || 0;
  }
  if (toLeftHand) {
    vrInput.leftStick.x = stickX;
    vrInput.leftStick.y = stickY;
  } else {
    vrInput.rightStick.x = stickX;
    vrInput.rightStick.y = stickY;
  }
}
