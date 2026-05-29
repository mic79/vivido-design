/**
 * VR controllers + grip hints — copied from VRrunner/js/main.js.
 * Hands live on scene-root group (never on cameraRig / vehicle).
 */
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';

let controller1 = null;
let controller2 = null;
let controllerGrip1 = null;
let controllerGrip2 = null;
/** Scene-only parent for tracked controllers (VRrunner uses crouchViewGroup on cameraRig; Drive keeps hands on scene). */
let driveVrXrHandsRoot = null;
let setupDone = false;

const handToCtrl = { left: null, right: null };
const handToPose = { left: null, right: null };
const _hintMeshes = [];

function readSimpleXrCtrlParam() {
    try {
        return new URLSearchParams(window.location.search).get('simplexrctrl') === '1';
    } catch (_) {
        return false;
    }
}

function removeLegacyControllerFallback(grip) {
    if (!grip) return;
    for (let i = grip.children.length - 1; i >= 0; i--) {
        const ch = grip.children[i];
        if (ch.name === 'controller_fallback') grip.remove(ch);
    }
    delete grip.userData._driveVrFallbackShell;
}

export function makeButtonHint(THREE, letter, label) {
    const group = new THREE.Group();
    group.name = `hint_${letter}`;

    const RING_INNER = 0.0086;
    const RING_OUTER = 0.0099;

    const pulseGroup = new THREE.Group();
    group.add(pulseGroup);

    const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.96,
        side: THREE.DoubleSide, fog: false, toneMapped: false, depthTest: false,
    });
    const ring = new THREE.Mesh(
        new THREE.RingGeometry(RING_INNER, RING_OUTER, 40), ringMat,
    );
    ring.renderOrder = 9990;
    pulseGroup.add(ring);

    const letterCanvasN = 96;
    const letterCanvas = document.createElement('canvas');
    letterCanvas.width = letterCanvasN;
    letterCanvas.height = letterCanvasN;
    {
        const ctx = letterCanvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 ${Math.floor(letterCanvasN * 0.78)}px system-ui, -apple-system, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(letter, letterCanvasN / 2, letterCanvasN / 2 + 1);
    }
    const letterTex = new THREE.CanvasTexture(letterCanvas);
    letterTex.colorSpace = THREE.SRGBColorSpace;
    letterTex.minFilter = THREE.LinearFilter;
    letterTex.magFilter = THREE.LinearFilter;
    letterTex.generateMipmaps = false;
    const letterSize = 0.013;
    const letterMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(letterSize, letterSize),
        new THREE.MeshBasicMaterial({
            map: letterTex, transparent: true, side: THREE.DoubleSide,
            fog: false, toneMapped: false, depthTest: false,
        }),
    );
    letterMesh.position.set(0, 0, 0.0002);
    letterMesh.renderOrder = 9991;
    pulseGroup.add(letterMesh);

    const labelCanvasW = 384;
    const labelCanvasH = 64;
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = labelCanvasW;
    labelCanvas.height = labelCanvasH;
    {
        const ctx = labelCanvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.font = '600 40px system-ui, -apple-system, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(label, 4, labelCanvasH / 2);
    }
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    labelTex.minFilter = THREE.LinearFilter;
    labelTex.magFilter = THREE.LinearFilter;
    labelTex.generateMipmaps = false;
    const LABEL_W = 0.045;
    const LABEL_H = LABEL_W * (labelCanvasH / labelCanvasW);
    const labelMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(LABEL_W, LABEL_H),
        new THREE.MeshBasicMaterial({
            map: labelTex, transparent: true, side: THREE.DoubleSide,
            fog: false, toneMapped: false, depthTest: false,
        }),
    );
    const LABEL_GAP = 0.003;
    labelMesh.position.set(RING_OUTER + LABEL_GAP + LABEL_W / 2, 0, 0.0002);
    labelMesh.renderOrder = 9991;
    group.add(labelMesh);

    group.userData.pulseStart = performance.now();
    group.userData.pulseTick = (now) => {
        const t = (now - group.userData.pulseStart) / 1000;
        const s = 1.0 + 0.1 * (0.5 + 0.5 * Math.sin(t * Math.PI * 1.25));
        pulseGroup.scale.set(s, s, s);
    };

    return group;
}

export function attachHintToGrip(grip, hint) {
    const outer = new THREE.Group();
    outer.userData.vrRunnerHintStack = true;
    outer.position.set(0.002, 0.025, -0.062);
    outer.rotation.set(-Math.PI / 2 + 0.25, 0, 0);
    outer.add(hint);
    grip.add(outer);
    _hintMeshes.push(hint);
    return outer;
}

export function mountHintStackOffset(grip, hint, zOffset) {
    const outer = new THREE.Group();
    outer.userData.vrRunnerHintStack = true;
    outer.position.set(0.002, 0.025, -0.062 + (zOffset || 0));
    outer.rotation.set(-Math.PI / 2 + 0.25, 0, 0);
    outer.add(hint);
    grip.add(outer);
    _hintMeshes.push(hint);
    return outer;
}

export function clearVRControllerHints() {
    for (const grip of [controllerGrip1, controllerGrip2]) {
        if (!grip) continue;
        for (let i = grip.children.length - 1; i >= 0; i--) {
            const ch = grip.children[i];
            if (ch.userData?.vrRunnerHintStack) grip.remove(ch);
        }
        grip.userData._hasDriveLeftHints = false;
        grip.userData._hasDriveRightHints = false;
        grip.userData._hasEditorLeftHints = false;
        grip.userData._hasEditorRightHints = false;
        grip.userData._hasMenuRightHints = false;
        grip.userData._hasFlyLeftHints = false;
        grip.userData._hasFlyRightHints = false;
    }
    _hintMeshes.length = 0;
}

export function tickVRControllerHintPulse() {
    if (_hintMeshes.length === 0) return;
    const now = performance.now();
    for (const h of _hintMeshes) {
        if (h.userData?.pulseTick) h.userData.pulseTick(now);
    }
}

export function ensureDriveVrXrHandsVisible() {
    if (driveVrXrHandsRoot) driveVrXrHandsRoot.visible = true;
    for (const grip of [controllerGrip1, controllerGrip2]) {
        if (!grip) continue;
        removeLegacyControllerFallback(grip);
        grip.visible = true;
        grip.traverse((obj) => {
            if (obj.isMesh || obj.isLine) {
                obj.visible = true;
                const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                for (const m of mats) {
                    if (m && 'fog' in m) m.fog = false;
                }
            }
        });
    }
    for (const ctrl of [controller1, controller2]) {
        if (ctrl) ctrl.visible = true;
    }
}

/**
 * @param {typeof import('three')} THREE — same namespace as the app renderer/scene
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').Object3D} handsParent — MUST be the same parent as the XR camera
 *        (DriveVR2: cameraRig). WebXR controller poses are composed with this parent's
 *        world matrix exactly like the headset pose, so hands only line up with the head
 *        when they share the camera's parent. Falls back to scene if not provided.
 * @param {import('three').Scene} scene
 */
export function setupVRControllers(THREE, renderer, handsParent, scene, hooks) {
    if (setupDone) {
        ensureDriveVrXrHandsVisible();
        hooks?.onRefreshHints?.();
        return getVRControllers();
    }

    const skipXrControllerGltf = readSimpleXrCtrlParam();
    let factory = null;
    if (!skipXrControllerGltf) {
        try {
            factory = new XRControllerModelFactory();
        } catch (err) {
            console.warn('[DriveVR2] XRControllerModelFactory:', err);
        }
    }

    /* Parent the hands group to the SAME node as the XR camera (cameraRig). */
    driveVrXrHandsRoot = handsParent || scene;

    controller1 = renderer.xr.getController(0);
    driveVrXrHandsRoot.add(controller1);
    controllerGrip1 = renderer.xr.getControllerGrip(0);
    if (skipXrControllerGltf || !factory) {
        console.info('[DriveVR2] simplexrctrl=1 or no factory — grip models only (no debug shells).');
        controllerGrip1.add(new THREE.Group());
    } else {
        try {
            controllerGrip1.add(factory.createControllerModel(controllerGrip1));
        } catch (err) {
            console.warn('[DriveVR2] createControllerModel grip0:', err);
        }
    }
    driveVrXrHandsRoot.add(controllerGrip1);

    controller2 = renderer.xr.getController(1);
    driveVrXrHandsRoot.add(controller2);
    controllerGrip2 = renderer.xr.getControllerGrip(1);
    if (skipXrControllerGltf || !factory) {
        controllerGrip2.add(new THREE.Group());
    } else {
        try {
            controllerGrip2.add(factory.createControllerModel(controllerGrip2));
        } catch (err) {
            console.warn('[DriveVR2] createControllerModel grip1:', err);
        }
    }
    driveVrXrHandsRoot.add(controllerGrip2);

    function clearHandSlotForGrip(grip, ctrl) {
        if (handToCtrl.left === grip) handToCtrl.left = null;
        if (handToCtrl.right === grip) handToCtrl.right = null;
        if (handToPose.left === ctrl) handToPose.left = null;
        if (handToPose.right === ctrl) handToPose.right = null;
    }

    function onGripConnected(grip, ctrl, e) {
        const src = e.data || null;
        grip.userData.xrInputSource = src;
        ctrl.userData.xrInputSource = src;
        const h = src?.handedness;
        if (h === 'left') {
            handToCtrl.left = grip;
            handToPose.left = ctrl;
        } else if (h === 'right') {
            handToCtrl.right = grip;
            handToPose.right = ctrl;
        } else {
            if (!handToCtrl.left) {
                handToCtrl.left = grip;
                handToPose.left = ctrl;
            } else if (!handToCtrl.right) {
                handToCtrl.right = grip;
                handToPose.right = ctrl;
            }
        }
        ensureDriveVrXrHandsVisible();
        const idx = ctrl === controller1 ? 0 : 1;
        hooks?.onConnected?.(idx, ctrl, grip, e);
        hooks?.onRefreshHints?.();
    }

    function onGripDisconnected(grip, ctrl) {
        grip.userData.xrInputSource = null;
        ctrl.userData.xrInputSource = null;
        clearHandSlotForGrip(grip, ctrl);
        hooks?.onRefreshHints?.();
    }

    controller1.addEventListener('connected', (e) => onGripConnected(controllerGrip1, controller1, e));
    controller1.addEventListener('disconnected', () => onGripDisconnected(controllerGrip1, controller1));
    controller2.addEventListener('connected', (e) => onGripConnected(controllerGrip2, controller2, e));
    controller2.addEventListener('disconnected', () => onGripDisconnected(controllerGrip2, controller2));

    setupDone = true;
    ensureDriveVrXrHandsVisible();
    console.log('[DriveVR2] VR controllers ready (VRrunner port, scene hands root)');
    hooks?.onRefreshHints?.();
    return getVRControllers();
}

export function getVRControllers() {
    return {
        controller1,
        controller2,
        controllerGrip1,
        controllerGrip2,
        driveVrXrHandsRoot,
        handToCtrl,
        handToPose,
        makeButtonHint,
        attachHintToGrip,
        mountHintStackOffset,
        clearVRControllerHints,
        tickVRControllerHintPulse,
        ensureDriveVrXrHandsVisible,
    };
}
