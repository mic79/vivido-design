/**
 * Body foundation components extracted from body-rigged4/index.html
 * hide-hand-model, scene-shadows, floor-grid, fixed-sun-light, vr-*, mixamo-body
 */
(function () {
  'use strict';
      AFRAME.registerComponent('hide-hand-model', {
        init: function () {
          const hideMesh = () => {
            const mesh = this.el.getObject3D('mesh');
            if (mesh) mesh.visible = false;
          };
          this.el.addEventListener('object3dset', (e) => {
            if (e.detail && e.detail.type === 'mesh') hideMesh();
          });
          this.el.addEventListener('model-loaded', hideMesh);
          hideMesh();
        }
      });

      AFRAME.registerComponent('scene-shadows', {
        init: function () {
          const enable = () => {
            const renderer = this.el.renderer;
            if (!renderer) return;
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;
          };
          if (this.el.hasLoaded) enable();
          else this.el.addEventListener('loaded', enable);
        }
      });

      AFRAME.registerComponent('floor-grid', {
        schema: {
          cellSize: { default: 0.1 },
          size: { default: 40 },
          majorEvery: { default: 10 }
        },
        init: function () {
          const cellSize = this.data.cellSize;
          const majorEvery = this.data.majorEvery;
          const blockM = cellSize * majorEvery;
          const cells = majorEvery;
          const res = 512;
          const canvas = document.createElement('canvas');
          canvas.width = res;
          canvas.height = res;
          const ctx = canvas.getContext('2d');
          const step = res / cells;

          ctx.fillStyle = '#6EB892';
          ctx.fillRect(0, 0, res, res);

          for (let i = 0; i <= cells; i++) {
            const p = Math.round(i * step) + 0.5;
            const major = i === 0 || i === cells;
            ctx.strokeStyle = major ? 'rgba(25, 65, 45, 0.55)' : 'rgba(255, 255, 255, 0.32)';
            ctx.lineWidth = major ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(p, 0);
            ctx.lineTo(p, res);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(0, p);
            ctx.lineTo(res, p);
            ctx.stroke();
          }

          const tex = new THREE.CanvasTexture(canvas);
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.repeat.set(this.data.size / blockM, this.data.size / blockM);
          tex.anisotropy = 8;
          this._gridTexture = tex;

          const apply = () => {
            const mesh = this.el.getObject3D('mesh');
            if (!mesh?.material) return;
            mesh.material.map = tex;
            mesh.material.color.set('#ffffff');
            mesh.material.roughness = 0.92;
            mesh.material.metalness = 0;
            mesh.material.receiveShadow = true;
            mesh.receiveShadow = true;
          };
          if (this.el.getObject3D('mesh')) apply();
          else this.el.addEventListener('object3dset', apply, { once: true });
        },
        remove: function () {
          this._gridTexture?.dispose();
        }
      });

      AFRAME.registerComponent('fixed-sun-light', {
        init: function () {
          const light = this.el.getObject3D('light');
          if (!light?.castShadow) return;
          light.shadow.normalBias = 0.02;
          // Aim at a fixed point in the scene â€” sun direction must NOT follow the player
          // or static props (stairs/ramp) will cast sliding shadows on the floor.
          light.target.position.set(0, 0, 0);
          light.target.updateMatrixWorld();
        }
      });

      (function initHeightStatusUI() {
        const statusEl = document.getElementById('eye-height-status');
        const sceneEl = document.querySelector('a-scene');

        function refreshStatus() {
          const w = sceneEl?.legIkWorld;
          if (!statusEl || !w) return;
          const body = w.playerHeightAdjustM ?? 0;
          const offset = w.cameraFloorOffsetM ?? 0;
          const stand = w.standingEyeLocalY ?? 1.6;
          const forward = w.bodyForwardOffsetM ?? 0;
          const lateral = w.bodyLateralOffsetM ?? 0;
          const scale = w.modelVerticalScale ?? 1;
          const modelH = w.modelStandingHeightM;
          const legIk = sceneEl?.components?.['leg-ik-world'];
          const tracked = sceneEl?.is('vr-mode') && legIk ? legIk._getTrackedEyeLocalY() : null;
          const crouch = w.crouchAmount ?? 0;
          statusEl.innerHTML =
            (modelH != null ? 'Model ~' + modelH.toFixed(2) + ' m Â· scale ' + scale.toFixed(2) + 'Ã— Â· ' : '') +
            'Camera offset: ' + (offset >= 0 ? '+' : '') + offset.toFixed(2) + ' m Â· Tracked eye: ' +
            (tracked != null ? tracked.toFixed(2) + ' m' : 'â€”') +
            ' Â· Stand posture: ' + stand.toFixed(2) + ' m Â· Crouch: ' + (crouch * 100).toFixed(0) + '%<br>' +
            '<span style="color:#888;">Partial crouch? Lower Stand posture toward Tracked eye Â· Scale â–² for taller Â· Snap to auto-set both.</span>';
        }

        sceneEl?.addEventListener('model-dimensions-measured', refreshStatus);
        sceneEl?.addEventListener('vr-body-position-adjusted', refreshStatus);
        sceneEl?.addEventListener('vr-model-scaled', refreshStatus);
        sceneEl?.addEventListener('vr-height-calibrated', refreshStatus);
        sceneEl?.addEventListener('vr-height-adjusted', refreshStatus);
        sceneEl?.addEventListener('vr-camera-calibrated', refreshStatus);
        sceneEl?.addEventListener('loaded', refreshStatus);
        setInterval(refreshStatus, 1000);
      })();

      AFRAME.registerComponent('vr-height-btn-hover', {
        schema: {
          hoverColor: { type: 'color', default: '#66BB6A' }
        },
        init: function () {
          this.baseColor = this.el.getAttribute('material')?.color || '#555555';
          this.onEnter = () => this.el.setAttribute('material', 'color', this.data.hoverColor);
          this.onLeave = () => this.el.setAttribute('material', 'color', this.baseColor);
          this.el.addEventListener('mouseenter', this.onEnter);
          this.el.addEventListener('mouseleave', this.onLeave);
        },
        remove: function () {
          this.el.removeEventListener('mouseenter', this.onEnter);
          this.el.removeEventListener('mouseleave', this.onLeave);
        }
      });

      AFRAME.registerComponent('vr-mirror-toggle', {
        init: function () {
          this.btnLabel = this.el.querySelector('#vr-mirror-btn-label');
          this.onClick = this.onClick.bind(this);
          this.onToggled = this.onToggled.bind(this);
          this.el.addEventListener('click', this.onClick);
          this.el.sceneEl.addEventListener('mirror-body-toggled', this.onToggled);
          this.el.sceneEl.addEventListener('loaded', () => {
            const legIk = this.el.sceneEl.components['leg-ik-world'];
            if (legIk?._syncMirrorToggleUI) legIk._syncMirrorToggleUI();
          });
        },
        onClick: function () {
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (legIk?.toggleMirrorBody) legIk.toggleMirrorBody();
        },
        onToggled: function (evt) {
          this._refreshButton(evt?.detail?.visible);
        },
        _refreshButton: function (visible) {
          const on = !!visible;
          if (this.btnLabel) {
            this.btnLabel.setAttribute('value', on ? 'Hide mirror' : 'Show mirror');
          }
          this.el.setAttribute('material', 'color', on ? '#388E3C' : '#555555');
          const hover = this.el.components['vr-height-btn-hover'];
          if (hover) hover.baseColor = on ? '#388E3C' : '#555555';
        },
        remove: function () {
          this.el.removeEventListener('click', this.onClick);
          this.el.sceneEl.removeEventListener('mirror-body-toggled', this.onToggled);
        }
      });

      AFRAME.registerComponent('vr-height-btn', {
        schema: {
          target: { type: 'string' },
          direction: { type: 'int', default: 1 }
        },
        init: function () {
          this.onClick = this.onClick.bind(this);
          this.el.addEventListener('click', this.onClick);
        },
        onClick: function () {
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (!legIk) return;
          if (this.data.target === 'calibrate') {
            legIk.calibrateStandingHeight('vr-panel');
            return;
          }
          const steps = { camera: 0.02, body: 0.02, forward: 0.03, lateral: 0.03, scale: 0.02, stand: 0.02 };
          const step = (steps[this.data.target] || 0.02) * this.data.direction;
          if (this.data.target === 'camera') legIk.adjustCameraHeight(step);
          else if (this.data.target === 'body') legIk.adjustBody(step);
          else if (this.data.target === 'forward') legIk.adjustBodyForward(step);
          else if (this.data.target === 'lateral') legIk.adjustBodyLateral(step);
          else if (this.data.target === 'scale') legIk.adjustModelScale(step);
          else if (this.data.target === 'stand') legIk.adjustStandingBaseline(step);
        },
        remove: function () {
          this.el.removeEventListener('click', this.onClick);
        }
      });

      // VR Locomotion â€” player snap-yaw (right stick) + mirror inspection rotation
      AFRAME.registerComponent('vr-locomotion', {
        schema: {
          rotationSpeed: { type: 'number', default: 2.0 }
        },

        init: function() {
          this.playerYaw = 0;
          this._lastYawDelta = 0;
          this.mirrorRotationY = 0;
          this.thumbstickRotation = { right: 0 };
          this.thumbstickMove = { left: { x: 0, y: 0 } };
          this.mirrorBody = null;
          this.moveDeadzone = 0.15;
          this._yAxis = new THREE.Vector3(0, 1, 0);
          this._desktopYaw = 0;

          setTimeout(() => {
            this.mirrorBody = document.querySelector('#mirror-body');
          }, 100);

          this.el.sceneEl.addEventListener('thumbstickmoved', (evt) => {
            if (!evt.target || !evt.target.object3D) return;
            this.handleThumbstick(evt.target, evt.detail);
          });

          this._onKeyDown = (evt) => {
            if (evt.repeat) return;
            if (evt.code === 'KeyZ') this._desktopYaw = 1;
            if (evt.code === 'KeyX') this._desktopYaw = -1;
          };
          this._onKeyUp = (evt) => {
            if (evt.code === 'KeyZ' && this._desktopYaw > 0) this._desktopYaw = 0;
            if (evt.code === 'KeyX' && this._desktopYaw < 0) this._desktopYaw = 0;
          };
          window.addEventListener('keydown', this._onKeyDown);
          window.addEventListener('keyup', this._onKeyUp);
          this._applyRigYawOnly();
        },

        remove: function () {
          window.removeEventListener('keydown', this._onKeyDown);
          window.removeEventListener('keyup', this._onKeyUp);
        },

        handleThumbstick: function(hand, detail) {
          const isLeft = hand.id === 'left-hand';
          const dz = this.moveDeadzone;

          if (isLeft) {
            this.thumbstickMove.left.x = this._stickAxis(detail.x, dz);
            this.thumbstickMove.left.y = this._stickAxis(detail.y, dz);
            return;
          }

          this.thumbstickRotation.right = this._stickAxis(-detail.x, dz);
        },

        /** Remap stick axis past deadzone to 0â€“1 (analog, not on/off). */
        _stickAxis: function (value, deadzone) {
          const v = value || 0;
          const a = Math.abs(v);
          if (a <= deadzone) return 0;
          const sign = v < 0 ? -1 : 1;
          return sign * (a - deadzone) / (1 - deadzone);
        },

        /** Yaw-only rig rotation â€” never introduces pitch/roll. */
        _applyRigYawOnly: function () {
          this.el.object3D.quaternion.setFromAxisAngle(this._yAxis, this.playerYaw);
          this.el.object3D.rotation.set(0, this.playerYaw, 0, 'YXZ');
        },

        applyYawDelta: function (deltaRad) {
          if (!deltaRad) return;
          this._lastYawDelta = deltaRad;
          this.playerYaw += deltaRad;
          while (this.playerYaw > Math.PI) this.playerYaw -= Math.PI * 2;
          while (this.playerYaw < -Math.PI) this.playerYaw += Math.PI * 2;
          this._applyRigYawOnly();
        },

        tick: function(time, deltaTime) {
          const dt = Math.min(deltaTime / 1000, 0.1);
          this._lastYawDelta = 0;
          const rotationInput = Math.abs(this.thumbstickRotation.right) > 0.001
            ? this.thumbstickRotation.right
            : this._desktopYaw;

          if (Math.abs(rotationInput) > 0.001) {
            this.applyYawDelta(rotationInput * this.data.rotationSpeed * dt);
          }

          // Re-sanitize every frame (look-controls / parent drift must not accumulate pitch/roll).
          this._applyRigYawOnly();

          if (this.mirrorBody && this.mirrorBody.components['mixamo-body']) {
            this.mirrorBody.components['mixamo-body'].manualRotationY = this.mirrorRotationY;
          }
        }
      });

      // Mixamo VR Body component
      AFRAME.registerComponent('mixamo-body', {
        schema: {
          isMirror: { type: 'boolean', default: false },
          color: { type: 'color', default: '#4A90E2' },
          modelPath: { type: 'string', default: 'character.glb' }
        },

        _resolveControllers: function () {
          // CapVR/BoltVR uses #leftHand/#rightHand; body-rigged4 uses #left-hand/#right-hand.
          this.leftController =
            document.getElementById('left-hand') ||
            document.getElementById('leftHand') ||
            document.querySelector('#left-hand') ||
            document.querySelector('#leftHand');
          this.rightController =
            document.getElementById('right-hand') ||
            document.getElementById('rightHand') ||
            document.querySelector('#right-hand') ||
            document.querySelector('#rightHand');
          if (!this.camera) this.camera = document.querySelector('#camera');
          if (!this.rig) this.rig = document.querySelector('#rig');
        },

        init: function() {
          this.camera = document.querySelector('#camera');
          this._resolveControllers();
          this.rig = document.querySelector('#rig');
          
          this.skeleton = null;
          this.bones = {};
          this.model = null;
          this.modelLoaded = false;
          this.isGltf = false;
          this.useAnimatedLocomotion = false;
          this.modelHipsLocalY = 1.0;
          this.modelFeetLocalY = 0;
          this.ankleToSoleM = 0.08;
          this.zeroGLegs = window.ZeroGLegs ? new window.ZeroGLegs() : null;
          this._zeroGBodyQuat = new THREE.Quaternion();
          this._zeroGVel = new THREE.Vector3();
          this._zeroGLegModeBlend = 0;
          
          // Mixamo bone names
          this.boneNames = {
            hips: 'mixamorigHips',
            spine: 'mixamorigSpine',
            spine1: 'mixamorigSpine1',
            spine2: 'mixamorigSpine2',
            neck: 'mixamorigNeck',
            head: 'mixamorigHead',
            headTop: 'mixamorigHeadTop_End',
            leftShoulder: 'mixamorigLeftShoulder',
            leftArm: 'mixamorigLeftArm',
            leftForeArm: 'mixamorigLeftForeArm',
            leftHand: 'mixamorigLeftHand',
            rightShoulder: 'mixamorigRightShoulder',
            rightArm: 'mixamorigRightArm',
            rightForeArm: 'mixamorigRightForeArm',
            rightHand: 'mixamorigRightHand',
            // Finger bones - Left hand
            leftHandThumb1: 'mixamorigLeftHandThumb1',
            leftHandThumb2: 'mixamorigLeftHandThumb2',
            leftHandThumb3: 'mixamorigLeftHandThumb3',
            leftHandIndex1: 'mixamorigLeftHandIndex1',
            leftHandIndex2: 'mixamorigLeftHandIndex2',
            leftHandIndex3: 'mixamorigLeftHandIndex3',
            leftHandMiddle1: 'mixamorigLeftHandMiddle1',
            leftHandMiddle2: 'mixamorigLeftHandMiddle2',
            leftHandMiddle3: 'mixamorigLeftHandMiddle3',
            leftHandRing1: 'mixamorigLeftHandRing1',
            leftHandRing2: 'mixamorigLeftHandRing2',
            leftHandRing3: 'mixamorigLeftHandRing3',
            leftHandPinky1: 'mixamorigLeftHandPinky1',
            leftHandPinky2: 'mixamorigLeftHandPinky2',
            leftHandPinky3: 'mixamorigLeftHandPinky3',
            // Finger bones - Right hand
            rightHandThumb1: 'mixamorigRightHandThumb1',
            rightHandThumb2: 'mixamorigRightHandThumb2',
            rightHandThumb3: 'mixamorigRightHandThumb3',
            rightHandIndex1: 'mixamorigRightHandIndex1',
            rightHandIndex2: 'mixamorigRightHandIndex2',
            rightHandIndex3: 'mixamorigRightHandIndex3',
            rightHandMiddle1: 'mixamorigRightHandMiddle1',
            rightHandMiddle2: 'mixamorigRightHandMiddle2',
            rightHandMiddle3: 'mixamorigRightHandMiddle3',
            rightHandRing1: 'mixamorigRightHandRing1',
            rightHandRing2: 'mixamorigRightHandRing2',
            rightHandRing3: 'mixamorigRightHandRing3',
            rightHandPinky1: 'mixamorigRightHandPinky1',
            rightHandPinky2: 'mixamorigRightHandPinky2',
            rightHandPinky3: 'mixamorigRightHandPinky3',
            leftUpLeg: 'mixamorigLeftUpLeg',
            leftLeg: 'mixamorigLeftLeg',
            leftFoot: 'mixamorigLeftFoot',
            rightUpLeg: 'mixamorigRightUpLeg',
            rightLeg: 'mixamorigRightLeg',
            rightFoot: 'mixamorigRightFoot'
          };
          
          // IK config (from body.html)
          this.config = {
            shoulderWidth: 0.34,
            shoulderForward: 0.08,
            upperArmLength: 0.31,
            lowerArmLength: 0.31,
            hipHalfWidth: 0.11,
            upperLegLength: 0.42,
            lowerLegLength: 0.41,
            minStepLength: 0.2,
            maxStepLength: 0.72,
            stepLengthScale: 0.36,
            maxStepHeight: 0.13,
            stanceRatio: 0.62
          };
          
          // Smoothing
          this.torsoRotation = new THREE.Quaternion();
          this.bodyTilt = new THREE.Quaternion();
          this.smoothingFactor = 0.15;
          this.mirrorDistance = 2.0;
          this.manualRotationY = 0; // Set by vr-locomotion
          
          // Finger curl smoothing (for smooth finger animations)
          this.targetCurls = {
            left: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
            right: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 }
          };
          this.currentCurls = {
            left: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
            right: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 }
          };
          // Grab finger freeze: after a short settle window the conformed finger
          // curls are captured and held constant until the hand releases.
          this._grabFingersFrozenLeft = false;
          this._grabFingersFrozenRight = false;
          this._grabFingerSettleLeft = 0;
          this._grabFingerSettleRight = 0;
          this._grabFrozenCurlsLeft = null;
          this._grabFrozenCurlsRight = null;
          this.fingerSmoothingFactor = 0.3; // How fast fingers move (0-1, higher = faster)
          
          // Breathing animation
          this.breathingPhase = 0; // Current phase of breathing cycle (0 to 2*PI)
          this.breathingRate = 0.25; // Breaths per second (15 breaths/min)
          this.breathingAmount = 0.015; // Chest expansion amount (1.5cm)

          // Dot disintegration (Quest A / F key)
          this._dotPoints = null;
          this._dotMaterial = null;
          this._dotSourceMesh = null;
          this._dotSourceIndices = null;
          this._dotParticleSources = null;
          this._dotNormals = null;
          this._dotFadeInDuration = 1.0;
          this._dotFadeOutDuration = 5.0;
          this._dotModelDissolveDuration = 1.0;
          this._dotModelWhiteDuration = 0.35;
          this._dotTravelM = 0.2;
          this._dotBaseSize = 0.018;
          this._dotSkinnedTmp = new THREE.Vector3();
          this._dotSkinAcc = new THREE.Vector3();
          this._dotSkinT = new THREE.Vector3();
          this._dotSkinMatrix = new THREE.Matrix4();
          this._dotSkinIndexVec = new THREE.Vector4();
          this._dotSkinWeightVec = new THREE.Vector4();
          this._dotBindLocal = null;
          this._dotAnchorWorld = null;
          this._dotNormalWorld = null;
          this._dotVelocityWorld = null;
          this._dotBodyMoveThreshold = 0.04;
          this._dotMomentumCarryS = 0.45;
          this._dotMomentumDrag = 0.3;
          this._dotAnchorGen = -1;
          this._dotWorldPos = new THREE.Vector3();
          this._dotNormalTmp = new THREE.Vector3();
          this._dotBodyMomVec = new THREE.Vector3();
          this._dotParticleVelTmp = new THREE.Vector3();
          this._dotBonePrevWorld = null;
          this._dotBoneVelWorld = null;
          this._dotHiddenMeshes = null;
          this._dotModelMaterialStates = null;
          this._dotDissolveWhite = new THREE.Color(1, 1, 1);
          
          // Body dynamics for natural movement
          this.previousHeadPos = new THREE.Vector3();
          this.previousHeadPosInitialized = false;
          this.headVelocity = new THREE.Vector3();
          this._rawMoveDir = new THREE.Vector3();
          this._smoothedHorizontalSpeed = 0;
          this.torsoLean = new THREE.Vector3(); // Current torso lean (smoothed)
          this.torsoLeanVelocity = 0.15; // How fast torso reacts to movement
          
          // Palm: small inset probe for physics; contact patch rests on surfaces.
          this.palmProbeRadius = 0.026;
          this.palmProbeInset = 0.042;
          this.palmSurfaceOffset = 0.022;
          // Residual gap left between palm skin and surface (0 = touch).
          this.palmTouchGap = 0;
          this.handCollisionRadius = this.palmProbeRadius;
          this.showHandCollisionDebug = false;
          this.showLegDebug = false;
          this.fingerCollisionRadius = 0.011;
          this.knuckleCollisionRadius = 0.016;
          this.showPlayerBodyCollisionDebug = false;
          this._playerBodyDebug = null;
          this._playerCapsuleGeoKey = null;
          this._palmContactLocalLeft = null;
          this._palmContactLocalRight = null;
          this._palmProbeLocalLeft = null;
          this._palmProbeLocalRight = null;
          this._palmForwardLocalLeft = null;
          this._palmForwardLocalRight = null;
          this._palmNormalLocalLeft = null;
          this._palmNormalLocalRight = null;
          this._palmLocalLeft = null;
          this._palmLocalRight = null;
          this._fingerTipLocal = { left: {}, right: {} };
          // Debug ray hits recorded by the finger / palm surface raycasts (world coords).
          this._fingerRayHits = { left: {}, right: {} };
          this._palmRayHits = { left: null, right: null };
          this._palmWorldTmp = new THREE.Vector3();
          this._palmWorldTmp2 = new THREE.Vector3();
          this._lastStablePalmLeft = new THREE.Vector3();
          this._lastStablePalmRight = new THREE.Vector3();
          this._hasStablePalmLeft = false;
          this._hasStablePalmRight = false;
          this._lastPalmTrackLeft = new THREE.Vector3();
          this._lastPalmTrackRight = new THREE.Vector3();
          this._hasPalmTrackLeft = false;
          this._hasPalmTrackRight = false;
          this._smoothCollPalmLeft = new THREE.Vector3();
          this._smoothCollPalmRight = new THREE.Vector3();
          this._hasSmoothCollPalmLeft = false;
          this._hasSmoothCollPalmRight = false;
          this._smoothCollHitLeft = false;
          this._smoothCollHitRight = false;
          this._smoothCollDisplayTmp = new THREE.Vector3();
          this._smoothCollPrevTmp = new THREE.Vector3();
          this.handCollisionSmoothRateHit = 18;
          this.handCollisionSmoothRateFree = 28;
          this.handCollisionMaxStepHit = 0.022;
          this.handCollisionMaxStepFree = 0.05;
          this._grabAnchorLeft = new THREE.Vector3();
          this._grabAnchorRight = new THREE.Vector3();
          this._grabAnchorActiveLeft = false;
          this._grabAnchorActiveRight = false;
          this.grabButtonThreshold = 0.45;
          this.grabReleaseDist = 0.12;
          this._grabReleaseBaselineLeft = 0;
          this._grabReleaseBaselineRight = 0;
          this._grabCollisionMissLeft = 0;
          this._grabCollisionMissRight = 0;
          this._grabPullRef = document.querySelector('#vr-player-offset');
          this._grabLastCtrlLocalLeft = new THREE.Vector3();
          this._grabLastCtrlLocalRight = new THREE.Vector3();
          this._grabPullLastRigPos = new THREE.Vector3();
          this._grabPullLastRigPosActive = false;
          this._grabPullWasActive = false;
          this._wasMantleCrouching = false;
          this._grabPullRigDeltaLocalTmp = new THREE.Vector3();
          this._grabPullInvQuatTmp = new THREE.Quaternion();
          this._grabPullLocalTmp = new THREE.Vector3();
          this._grabPullLocalDeltaTmp = new THREE.Vector3();
          this._grabPullQuatTmp = new THREE.Quaternion();
          this._grabPullTmp = new THREE.Vector3();
          this._leftCtrlWorldTmp = new THREE.Vector3();
          this._rightCtrlWorldTmp = new THREE.Vector3();
          this._handCollisionDebugLeft = null;
          this._handCollisionDebugRight = null;
          this._handPalmTouchLeft = false;
          this._handPalmTouchRight = false;
          this._lastSlideHapticLeft = 0;
          this._lastSlideHapticRight = 0;
          this._lastRagdollHoldHapticLeft = 0;
          this._lastRagdollHoldHapticRight = 0;
          this._ragdollHoldWasActiveLeft = false;
          this._ragdollHoldWasActiveRight = false;
          this._ragdollNearTouchLeft = false;
          this._ragdollNearTouchRight = false;
          this._envGrabWasActiveLeft = false;
          this._envGrabWasActiveRight = false;
          this._lastCtrlHapticPosLeft = null;
          this._lastCtrlHapticPosRight = null;
          this._handHapticDt = 0.016;
          this.fingerCurlSmoothRate = 14;
          this.palmContactSmoothRate = 16;
          this.palmContactMaxStep = 0.028;
          this.fingerPenetrationCurlRate = 4.5;
          this.fingerRaycastMaxDist = 0.22;
          this._grabLockedHandQuatLeft = new THREE.Quaternion();
          this._grabLockedHandQuatRight = new THREE.Quaternion();
          this._grabLockedHandWorldLeft = new THREE.Quaternion();
          this._grabLockedHandWorldRight = new THREE.Quaternion();
          this._grabHandLockLeft = false;
          this._grabHandLockRight = false;
          // Wrist world position captured at grab time; the hand freezes here
          // (world space) until release, ignoring further controller motion.
          this._grabLockedWristWorldLeft = new THREE.Vector3();
          this._grabLockedWristWorldRight = new THREE.Vector3();
          this._grabWristCorrLeft = new THREE.Vector3();
          this._grabWristCorrRight = new THREE.Vector3();
          this._grabWristErrTmp = new THREE.Vector3();
          this._grabWristLockLeft = false;
          this._grabWristLockRight = false;
          this._grabSurfaceContactLeft = false;
          this._grabSurfaceContactRight = false;
          this._grabPalmNormalLeft = new THREE.Vector3(0, 1, 0);
          this._grabPalmNormalRight = new THREE.Vector3(0, 1, 0);
          this._smoothedPalmContactLeft = new THREE.Vector3();
          this._smoothedPalmContactRight = new THREE.Vector3();
          this._hasSmoothedPalmContactLeft = false;
          this._hasSmoothedPalmContactRight = false;
          this._ragdollArmHold = {
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

          // Leg IK (Box3D physics via leg-ik-box3d.js)
          this.legIK = null;
          this.mixer = null;
          this.animClips = {};
          this.currentAnim = null;
          this.horizontalSpeed = 0;
          this.lateralSpeed = 0;
          this.forwardSpeed = 0;
          this.strafeReferenceSpeed = 1.6;
          this.moveYawTwist = 0;
          this._smoothedMoveYawTarget = 0;
          this._smoothedMoveDir = new THREE.Vector3();
          this._walkBackSign = 1;
          this._crouchAnimWeight = 0;
          this._standingHipsLocalY = null;
          this._restHeadAboveNeck = 0.14;
          this._vrHeadDrop = 0;
          this._modelBaseY = 0.05;
          this._soleGroundOffset = 0;
          this._headEyeOffsetY = 0.06;
          this._pendingFootCalibration = false;
          this._headFacingQuat = new THREE.Quaternion();
          this._prevHeadYaw = null;
          this._headTurnRate = 0;
          this._stableStrafeDir = 0;
          this._strafePending = 0;
          this._strafeHoldT = 0;
          // 2D Blend Space state (per-instance)
          this._blendSpaceInited = false;
          this._blendWeights = { idle: 1, walk: 0, run: 0, strafeLeft: 0, strafeRight: 0 };
          this._blendWeightsTarget = { idle: 1, walk: 0, run: 0, strafeLeft: 0, strafeRight: 0 };
          this._blendPhase = 0;

          this.walkPhase = 0;
          this.walkThreshold = 0.08;
          this.sprintThreshold = 3.5;
          this.footTargetSmoothing = 0.22;
          this.footTargets = {
            left: { current: new THREE.Vector3(), ready: false },
            right: { current: new THREE.Vector3(), ready: false }
          };
          
          // Enable local clipping in renderer
          this.el.sceneEl.addEventListener('loaded', () => {
            const renderer = this.el.sceneEl.renderer;
            if (renderer) {
              renderer.localClippingEnabled = true;
            }
          });
          
          this.el.sceneEl.addEventListener('vr-recenter', () => {
            this.previousHeadPosInitialized = false;
            delete this.el.sceneEl._bodyLocomotionState;
          });
          this.el.sceneEl.addEventListener('vr-height-calibrated', (evt) => {
            this._standingHipsLocalY = null;
            this.previousHeadPosInitialized = false;
            this._applyModelVerticalScale();
            if (evt?.detail?.finalizeFeet && !this.data.isMirror) {
              this._pendingFootCalibration = true;
            }
          });
          this.el.sceneEl.addEventListener('vr-model-scaled', () => {
            this._applyModelVerticalScale();
          });
          
          if (!window._bodyRiggedKeys) {
            window._bodyRiggedKeys = {};
            // CapVR: never arm body-rigged4 lab toggles (F dots / R ragdoll / M mirror).
            // Those write world pose into child #rig and eject the player from their body.
            const isCapVR = () => !!(
              window.CapVRGame || document.querySelector('[zerog-player]') || document.getElementById('flag-red')
            );
            const toggleRagdollAndReset = () => {
              if (isCapVR()) return;
              const legIk = document.querySelector('a-scene')?.components['leg-ik-world'];
              if (legIk && legIk.toggleRagdoll) legIk.toggleRagdoll();
              const dummy = document.querySelector('#grab-dummy')?.components['grabbable-ragdoll'];
              if (dummy && dummy.resetRagdoll) dummy.resetRagdoll();
            };
            const onKeyDown = (e) => {
              if (isCapVR() && (e.code === 'KeyF' || e.code === 'KeyR' || e.code === 'KeyM')) {
                // Do not arm KeyF for body-dot dissolve
                return;
              }
              window._bodyRiggedKeys[e.code] = true;
              if (e.code === 'KeyF') {
                e.preventDefault();
                e.stopImmediatePropagation();
              }
              if (e.code === 'KeyR') {
                toggleRagdollAndReset();
              }
              if (e.code === 'KeyM') {
                e.preventDefault();
                const legIk = document.querySelector('a-scene')?.components['leg-ik-world'];
                if (legIk?.toggleMirrorBody) legIk.toggleMirrorBody();
              }
            };
            const onKeyUp = (e) => {
              window._bodyRiggedKeys[e.code] = false;
            };
            window.addEventListener('keydown', onKeyDown, true);
            window.addEventListener('keyup', onKeyUp, true);

            const isGripPressed = (handEl) => {
              const gamepad = handEl?.components?.['tracked-controls']?.controller?.gamepad;
              const grip = gamepad?.buttons?.[1];
              return !!(grip && (grip.pressed || grip.value >= 0.45));
            };
            // B = thruster in zero-g; grip+B toggles ragdoll while floating (body-rigged lab only).
            const rightHand = document.querySelector('#right-hand') || document.querySelector('#rightHand');
            if (rightHand) {
              rightHand.addEventListener('bbuttondown', () => {
                if (isCapVR()) return;
                const zeroG = window.BodyRiggedGravity?.isZeroG?.();
                if (zeroG && !isGripPressed(rightHand)) return;
                toggleRagdollAndReset();
              });
            }
          }
          
          this._loadModel();
        },

        _loadModel: function() {
          const path = this.data.modelPath;
          const isGlb = /\.glb$/i.test(path);
          
          if (isGlb) {
            const tryGltf = () => {
              if (!window.BodyRiggedLoaders?.ready) {
                setTimeout(tryGltf, 50);
                return;
              }
              new window.BodyRiggedLoaders.GLTFLoader().load(
                path,
                (gltf) => this.onModelLoaded(gltf.scene, { animations: gltf.animations, isGltf: true }),
                undefined,
                (error) => console.error('[Mixamo Body] GLB load error:', error)
              );
            };
            tryGltf();
            return;
          }
          
          const loader = new THREE.FBXLoader();
          loader.load(
            path,
            (fbx) => this.onModelLoaded(fbx, { animations: fbx.animations, isGltf: false }),
            undefined,
            (error) => console.error('[Mixamo Body] FBX load error:', error)
          );
        },

        onModelLoaded: function(modelRoot, meta) {
          this.modelLoaded = true;
          this.model = modelRoot;
          this.isGltf = meta.isGltf;
          
          if (meta.isGltf) {
            modelRoot.scale.set(1, 1, 1);
            modelRoot.position.y = 0.05;
            modelRoot.rotation.y = Math.PI;
          } else {
            modelRoot.scale.set(0.01, 0.01, 0.01);
            modelRoot.rotation.y = Math.PI;
          }
          this._modelBaseY = modelRoot.position.y;
          
          this.el.object3D.add(modelRoot);
          
          const allMaterials = [];
          modelRoot.traverse((node) => {
            if (node.isMesh) {
              node.castShadow = true;
            }
            if (node.isSkinnedMesh && node.skeleton) {
              this.skeleton = node.skeleton;
              this.mapBones();
              this.skinnedMesh = node;
              node.castShadow = true;
              node.receiveShadow = true;
              node.frustumCulled = false;
              
              if (node.material) {
                node.material = node.material.clone();
                if (this.data.isMirror && node.material.color) {
                  node.material.color.set(this.data.color);
                }
                allMaterials.push(node.material);
              }
            } else if (node.isMesh) {
              if (node.material) {
                node.material = node.material.clone();
                if (this.data.isMirror && node.material.color) {
                  node.material.color.set(this.data.color);
                }
                allMaterials.push(node.material);
              }
            }
          });
          
          console.log('[Mixamo Body]', this.data.isMirror ? 'Mirror' : 'Local',
            '-', meta.isGltf ? 'GLB' : 'FBX', '- materials:', allMaterials.length);

          this._captureBindPose();
          this._initAnimations(meta.animations || []);
          this._measureLegLengths();
          this._measureBodyOffsets();
          this._applyModelVerticalScale();
          this._measureHandPalmOffsets();
          this._measureFingerTipOffsets();
          this._syncHandCollisionRadiiToLegIk();

          const statusEl = document.querySelector('#status');
          if (statusEl) {
            statusEl.textContent = 'Active';
            statusEl.style.color = '#4CAF50';
          }

          this._initBodyDotOverlay();
        },

        _captureBindPose: function () {
          if (!this.skeleton) return;
          this._bindPose = this.skeleton.bones.map((b) => ({
            pos: b.position.clone(),
            quat: b.quaternion.clone(),
            scale: b.scale.clone()
          }));
        },

        _restoreBindPose: function () {
          if (!this.skeleton || !this._bindPose) return;
          for (let i = 0; i < this.skeleton.bones.length; i++) {
            const snap = this._bindPose[i];
            if (!snap) continue;
            const b = this.skeleton.bones[i];
            b.position.copy(snap.pos);
            b.quaternion.copy(snap.quat);
            b.scale.copy(snap.scale);
          }
          this.skeleton.update();
          if (this.model) this.model.updateMatrixWorld(true);
        },
        
        _initAnimations: function(animations) {
          this.useAnimatedLocomotion = false;
          
          if (!animations || animations.length === 0) {
            console.log('[Mixamo Body] No embedded animations â€” using procedural walk cycle');
            return;
          }
          
          const aliases = {
            idle: ['Idle', 'idle', 'T-Pose', 'TPose'],
            walk: ['Walk', 'walk', 'Walking'],
            run: ['Sprint', 'Run', 'run', 'Jog']
          };
          
          for (const [slot, names] of Object.entries(aliases)) {
            for (const name of names) {
              const clip = THREE.AnimationClip.findByName(animations, name);
              if (clip) {
                this.animClips[slot] = clip;
                break;
              }
            }
          }
          
          if (!this.animClips.walk) {
            console.log('[Mixamo Body] No walk clip â€” using procedural walk cycle. Found:',
              animations.map((c) => c.name));
            return;
          }
          
          this.mixer = new THREE.AnimationMixer(this.model);
          this.useAnimatedLocomotion = true;
          
          if (!this.animClips.idle && animations[0]) {
            this.animClips.idle = animations[0];
          }
          
          console.log('[Mixamo Body] Animation clips:',
            Object.fromEntries(Object.entries(this.animClips).map(([k, v]) => [k, v.name])));

          // Stay in bind pose until the player moves â€” no looping idle at load.
          this.currentAnim = null;

          this._loadStrafeClip();
          this._loadCrouchClip();
        },
        
        _loadCrouchClip: function() {
          const CROUCH_CLIP_CACHE_VERSION = 4;
          if (window._crouchClipCacheVersion !== CROUCH_CLIP_CACHE_VERSION) {
            window._crouchClipCache = null;
            window._crouchClipCacheVersion = CROUCH_CLIP_CACHE_VERSION;
          }
          
          const onClip = (clip) => {
            if (!clip || !this.mixer) return;
            this.animClips.crouchStand = this._retargetClipToSkeleton(
              clip.clone(),
              'CrouchStand',
              { mode: 'crouch' }
            );
            console.log('[Mixamo Body]', this.data.isMirror ? 'Mirror' : 'Local',
              '- Crouch clip ready, duration', this.animClips.crouchStand.duration.toFixed(2), 's');
          };
          
          if (window._crouchClipCache) { onClip(window._crouchClipCache); return; }
          if (window._crouchClipWaiters) { window._crouchClipWaiters.push(onClip); return; }
          window._crouchClipWaiters = [onClip];
          
          const startLoad = () => {
            const Loaders = window.BodyRiggedLoaders;
            if (!Loaders?.ready || !Loaders.FBXLoader) {
              setTimeout(startLoad, 50);
              return;
            }
            new Loaders.FBXLoader().load(
              'Crouched To Standing.fbx',
              (fbx) => {
                const clip = (fbx.animations && fbx.animations[0]) || null;
                window._crouchClipCache = clip;
                (window._crouchClipWaiters || []).forEach((fn) => fn(clip));
                window._crouchClipWaiters = null;
              },
              undefined,
              (err) => {
                console.warn('[Mixamo Body] Crouch FBX load failed:', err);
                window._crouchClipWaiters = null;
              }
            );
          };
          startLoad();
        },
        
        // Load the external strafe FBX once (shared across both bodies), retarget its
        // tracks to this GLB skeleton, then build right + mirrored-left strafe clips.
        _loadStrafeClip: function() {
          const onClip = (clip) => {
            if (!clip || !this.mixer) return;
            const right = this._retargetClipToSkeleton(clip.clone(), 'StrafeRight');
            const left = this._mirrorClip(right, 'StrafeLeft');
            this.animClips.strafeRight = right;
            this.animClips.strafeLeft = left;
            if (!window._strafeReferenceSpeed) {
              window._strafeReferenceSpeed = this._calibrateStrafeReferenceSpeed(right);
            }
            this.strafeReferenceSpeed = window._strafeReferenceSpeed;
            console.log('[Mixamo Body]', this.data.isMirror ? 'Mirror' : 'Local',
              '- Strafe clips ready (right + mirrored left), ref speed',
              this.strafeReferenceSpeed.toFixed(2), 'm/s');
          };
          
          if (window._strafeClipCache) { onClip(window._strafeClipCache); return; }
          if (window._strafeClipWaiters) { window._strafeClipWaiters.push(onClip); return; }
          window._strafeClipWaiters = [onClip];
          
          const startLoad = () => {
            const Loaders = window.BodyRiggedLoaders;
            if (!Loaders?.ready || !Loaders.FBXLoader) {
              setTimeout(startLoad, 50);
              return;
            }
            new Loaders.FBXLoader().load(
              'Walk Strafe Right.fbx',
              (fbx) => {
                const clip = (fbx.animations && fbx.animations[0]) || null;
                window._strafeClipCache = clip;
                (window._strafeClipWaiters || []).forEach((fn) => fn(clip));
                window._strafeClipWaiters = null;
              },
              undefined,
              (err) => {
                console.warn('[Mixamo Body] Strafe FBX load failed:', err);
                window._strafeClipWaiters = null;
              }
            );
          };
          startLoad();
        },
        
        // Mixamo FBX tracks target "mixamorigXxx" in centimeters; the GLB skeleton uses
        // "mixamorig:Xxx" in meters. Rename track targets to existing bones and scale
        // position tracks to meters so the clip applies cleanly.
        _retargetClipToSkeleton: function(clip, newName, options) {
          options = options || {};
          // Build a normalized-name -> actual bone name map (strip "mixamorig", ":",
          // spaces, underscores; lowercase) so we match regardless of how the FBX
          // exporter formatted the bone names.
          // FBX exports the rig as "mixamorig1:Hips" (note the digit); the GLB uses
          // "mixamorig:Hips". Strip "mixamorig" + optional digits + namespace chars.
          const normalize = (n) => n.replace(/mixamorig\d*/i, '').replace(/[:_\s|]/g, '').toLowerCase();
          const boneByNorm = {};
          this.skeleton.bones.forEach((b) => { boneByNorm[normalize(b.name)] = b.name; });
          
          // Detect cm vs m from the hips position track magnitude.
          let scale = 1;
          for (const track of clip.tracks) {
            if (/hips\.position$/i.test(track.name.replace(/[:_\s]/g, ''))) {
              let maxAbs = 0;
              for (let i = 0; i < track.values.length; i++) {
                maxAbs = Math.max(maxAbs, Math.abs(track.values[i]));
              }
              if (maxAbs > 10) scale = 0.01;
              break;
            }
          }
          
          const originalCount = clip.tracks.length;
          const keptTracks = [];
          clip.tracks.forEach((track) => {
            const dot = track.name.lastIndexOf('.');
            const node = track.name.substring(0, dot);
            const prop = track.name.substring(dot + 1);
            const actual = boneByNorm[normalize(node)];
            if (!actual) return; // drop tracks that don't map to a real bone
            track.name = actual + '.' + prop;
            if (scale !== 1 && prop === 'position') {
              for (let i = 0; i < track.values.length; i++) track.values[i] *= scale;
            }
            keptTracks.push(track);
          });
          clip.tracks = keptTracks;
          clip.name = newName;
          if (options.mode === 'crouch') {
            this._sanitizeCrouchClip(clip);
            this._addIdleHipsHold(clip, { includePosition: true });
          } else {
            this._sanitizeStrafeClip(clip);
            this._addIdleHipsHold(clip);
          }
          console.log('[Mixamo Body]', options.mode === 'crouch' ? 'Crouch' : 'Strafe',
            'retarget:', clip.tracks.length, 'tracks after sanitize (was', originalCount + '); scale', scale);
          return clip;
        },
        
        // Limb rotations only â€” no FBX hips translate/rotate (tips body horizontal
        // and sinks the mesh; leg IK + idle hips hold handle vertical + feet).
        _sanitizeCrouchClip: function(clip) {
          const normalize = (n) => n.replace(/mixamorig\d*/i, '').replace(/[:_\s|]/g, '').toLowerCase();
          clip.tracks = clip.tracks.filter((track) => {
            const dot = track.name.lastIndexOf('.');
            const bone = track.name.substring(0, dot);
            const prop = track.name.substring(dot + 1);
            const boneKey = normalize(bone);
            if (prop === 'scale') return false;
            if (boneKey === 'hips') return false;
            if (prop === 'position') return false;
            return prop === 'quaternion' || prop === 'rotation';
          });
        },
        
        // Hold hips at idle frame-0 pose so external FBX clips stay upright.
        _addIdleHipsHold: function(clip, options) {
          options = options || {};
          const hipsName = this.bones.hips?.name;
          if (!hipsName || !this.animClips.idle) return;
          
          const props = options.includePosition
            ? ['quaternion', 'rotation', 'position']
            : ['quaternion', 'rotation'];
          
          props.forEach((wantProp) => {
            const idleTrack = this.animClips.idle.tracks.find((t) => {
              const prop = t.name.substring(t.name.lastIndexOf('.') + 1);
              return t.name.startsWith(hipsName + '.') && prop === wantProp;
            });
            if (!idleTrack) return;
            const prop = idleTrack.name.substring(idleTrack.name.lastIndexOf('.') + 1);
            const TrackCtor = idleTrack.constructor;
            const valueCount = prop === 'quaternion' ? 4 : 3;
            clip.tracks.push(new TrackCtor(
              hipsName + '.' + prop,
              [0],
              idleTrack.values.slice(0, valueCount)
            ));
          });
        },
        
        // External Mixamo FBX uses a different bind pose (mixamorig1:) than our GLB
        // (mixamorig:). Hips/root position+rotation from the FBX tip the whole body
        // onto the floor. Keep rotation-only limb tracks; entity handles facing/move.
        _sanitizeStrafeClip: function(clip) {
          const normalize = (n) => n.replace(/mixamorig\d*/i, '').replace(/[:_\s|]/g, '').toLowerCase();
          clip.tracks = clip.tracks.filter((track) => {
            const dot = track.name.lastIndexOf('.');
            const bone = track.name.substring(0, dot);
            const prop = track.name.substring(dot + 1);
            const boneKey = normalize(bone);
            if (boneKey === 'hips') return false;
            if (prop === 'position' || prop === 'scale') return false;
            return prop === 'quaternion' || prop === 'rotation';
          });
        },
        
        // Mirror a clip across the body's sagittal plane: swap Left/Right bone targets,
        // negate X of positions and the Y/Z of quaternions.
        _mirrorClip: function(clip, newName) {
          const tracks = clip.tracks.map((track) => {
            const dot = track.name.lastIndexOf('.');
            let node = track.name.substring(0, dot);
            const prop = track.name.substring(dot + 1);
            if (/Left/.test(node)) node = node.replace('Left', 'Right');
            else if (/Right/.test(node)) node = node.replace('Right', 'Left');
            
            const values = track.values.slice();
            if (prop === 'quaternion') {
              for (let i = 0; i < values.length; i += 4) {
                values[i + 1] = -values[i + 1];
                values[i + 2] = -values[i + 2];
              }
            } else if (prop === 'position') {
              for (let i = 0; i < values.length; i += 3) {
                values[i] = -values[i];
              }
            }
            return new track.constructor(node + '.' + prop, track.times.slice(), values);
          });
          // Use the source clip's own constructor so the clip stays the same THREE
          // flavor as the GLB-loaded clips (the page mixes module + global THREE).
          return new clip.constructor(newName, clip.duration, tracks);
        },
        
        // Measure how fast the strafe clip moves the foot (m/s at timeScale 1) so playback
        // can be scaled to match real sideways travel speed.
        _calibrateStrafeReferenceSpeed: function(clip) {
          if (!this.mixer || !this.skeleton || !this.model) return 1.6;
          const foot = this.bones.rightFoot || this.bones.leftFoot;
          if (!foot) return 1.6;
          
          const saved = this.skeleton.bones.map((b) => ({
            q: b.quaternion.clone(),
            p: b.position.clone()
          }));
          
          const action = this.mixer.clipAction(clip);
          action.reset();
          action.setEffectiveWeight(1);
          action.play();
          action.timeScale = 1;
          
          let pathLen = 0;
          const prev = new THREE.Vector3();
          const steps = 50;
          
          action.time = 0;
          this.mixer.update(0);
          this.skeleton.update();
          this.model.updateWorldMatrix(true, true);
          foot.getWorldPosition(prev);
          
          for (let i = 1; i <= steps; i++) {
            action.time = (i / steps) * clip.duration;
            this.mixer.update(0);
            this.skeleton.update();
            this.model.updateWorldMatrix(true, true);
            const p = new THREE.Vector3();
            foot.getWorldPosition(p);
            pathLen += p.distanceTo(prev);
            prev.copy(p);
          }
          
          action.stop();
          action.setEffectiveWeight(0);
          
          saved.forEach((s, i) => {
            this.skeleton.bones[i].quaternion.copy(s.q);
            this.skeleton.bones[i].position.copy(s.p);
          });
          this.skeleton.update();
          
          // Foot path is longer than center-of-mass travel; ~2.2x for a strafe cycle.
          return Math.max(pathLen / (clip.duration * 2.2), 0.4);
        },
        
        _updateSmoothedMoveDir: function(dt) {
          const raw = this._rawMoveDir;
          if (raw && raw.lengthSq() > 0.0001) {
            // Responsive blend â€” tracks stick input closely for accurate blend space weights
            const blend = Math.min(1, dt * 14);
            if (this._smoothedMoveDir.lengthSq() < 0.0001) {
              this._smoothedMoveDir.copy(raw);
            } else {
              this._smoothedMoveDir.lerp(raw, blend);
            }
          } else {
            this._smoothedMoveDir.lerp(new THREE.Vector3(0, 0, 0), Math.min(1, dt * 12));
          }
        },
        
        _getMoveFacingComponents: function(opts) {
          opts = opts || {};
          const moveDir = opts.raw ? this._rawMoveDir : this._smoothedMoveDir;
          if (!moveDir || moveDir.lengthSq() < 0.0001) return null;
          
          const yawQuat = this._isLocalRigChild()
            ? this._getWorldLocomotionYawQuat()
            : this._getYawQuat();
          const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(yawQuat);
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(yawQuat);
          return {
            fwdComp: moveDir.dot(fwd),
            rightComp: moveDir.dot(right)
          };
        },

        _isPureStrafeInput: function(comps) {
          if (!comps) return false;
          const absFwd = Math.abs(comps.fwdComp);
          const absRight = Math.abs(comps.rightComp);
          return absRight > absFwd * 1.35 && absFwd < 0.28;
        },

        _resetMoveYawTwist: function() {
          this.moveYawTwist = 0;
          this._smoothedMoveYawTarget = 0;
        },
        
        _shortestYawDelta: function(from, to) {
          let delta = to - from;
          while (delta > Math.PI) delta -= Math.PI * 2;
          while (delta < -Math.PI) delta += Math.PI * 2;
          return delta;
        },

        _getHeadYaw: function() {
          const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this._headFacingQuat);
          fwd.y = 0;
          if (fwd.lengthSq() < 1e-6) return this._prevHeadYaw ?? 0;
          fwd.normalize();
          return Math.atan2(fwd.x, -fwd.z);
        },

        _getLocomotionStrafeDir: function(speed, dt) {
          if (!this.animClips.strafeRight || !this.animClips.strafeLeft) return 0;
          if (speed < this.walkThreshold || speed >= this.sprintThreshold) {
            this._stableStrafeDir = 0;
            this._strafePending = 0;
            this._strafeHoldT = 0;
            return 0;
          }
          
          // Raw stick intent â€” smoothed dir lags after fwd/bkw taps and blocks strafe entry.
          const comps = this._getMoveFacingComponents({ raw: true });
          if (!comps) return this._stableStrafeDir || 0;
          
          if (!this._isPureStrafeInput(comps)) {
            this._stableStrafeDir = 0;
            this._strafePending = 0;
            this._strafeHoldT = 0;
            return 0;
          }
          
          const candidate = comps.rightComp > 0 ? 1 : -1;
          
          // Enter strafe immediately from walk; only debounce left/right flips while strafing.
          if (this._stableStrafeDir === 0) {
            this._stableStrafeDir = candidate;
            this._strafePending = candidate;
            this._strafeHoldT = 0;
            return candidate;
          }
          
          if (candidate === this._stableStrafeDir) {
            this._strafePending = candidate;
            this._strafeHoldT = 0;
            return this._stableStrafeDir;
          }
          if (candidate === this._strafePending) {
            this._strafeHoldT += dt || 0.016;
          } else {
            this._strafePending = candidate;
            this._strafeHoldT = 0;
          }
          if (this._strafeHoldT > 0.12) {
            this._stableStrafeDir = candidate;
          }
          return this._stableStrafeDir || 0;
        },
        
        _getMoveYawOffset: function(speed, strafeDir) {
          if (speed < this.walkThreshold || speed >= this.sprintThreshold) return 0;
          if (this._headTurnRate > 2.5) return 0;

          // No hip twist when strafe animation is active (it handles sideways motion)
          const strafeBlend = (this._blendWeights.strafeLeft || 0) + (this._blendWeights.strafeRight || 0);
          if (strafeBlend > 0.5) return 0;

          const comps = this._getMoveFacingComponents({ raw: true })
            || this._getMoveFacingComponents();
          if (!comps) return 0;
          const { fwdComp, rightComp } = comps;
          const absFwd = Math.abs(fwdComp);
          const absRight = Math.abs(rightComp);

          const maxTwist = Math.PI * 0.42;
          const lateralAngle = Math.atan2(rightComp, Math.max(absFwd, 0.08));
          const signedTwist = fwdComp >= 0 ? -lateralAngle : lateralAngle;
          const lateralRatio = absRight / Math.max(absFwd, 0.08);
          const diagonalWeight = lateralRatio >= 0.32
            ? 1
            : THREE.MathUtils.smoothstep(0.06, 0.32, lateralRatio);
          return THREE.MathUtils.clamp(signedTwist * diagonalWeight, -maxTwist, maxTwist);
        },
        
        // Headset yaw in the rig-local frame (snap-turn lives on the parent rig).
        _updateHeadFacing: function(headQuat, dt) {
          const look = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuat);
          look.y = 0;
          if (look.lengthSq() < 1e-6) return;
          look.normalize();

          const target = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), look);
          if (this._prevHeadYaw === null) {
            this._headFacingQuat.copy(target);
          } else {
            this._headFacingQuat.slerp(target, Math.min(1, dt * 18));
          }
          this.torsoRotation.copy(this._headFacingQuat);

          const headYaw = Math.atan2(look.x, -look.z);
          if (this._prevHeadYaw !== null) {
            let delta = headYaw - this._prevHeadYaw;
            while (delta > Math.PI) delta -= Math.PI * 2;
            while (delta < -Math.PI) delta += Math.PI * 2;
            this._headTurnRate = Math.abs(delta) / Math.max(dt, 0.001);
          } else {
            this._headTurnRate = 0;
          }
          this._prevHeadYaw = headYaw;
        },

        /** Rig-local body yaw (does NOT include parent rig snap-turn). */
        _getYawQuat: function() {
          if (this.useAnimatedLocomotion) {
            return this._headFacingQuat;
          }
          const yaw = new THREE.Euler().setFromQuaternion(this.torsoRotation, 'YXZ').y;
          return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        },

        /** Body orientation in world space (includes parent rig snap-yaw when rig-child). */
        _getBodyWorldQuat: function (out) {
          out = out || new THREE.Quaternion();
          if (this._isLocalRigChild()) {
            this.el.object3D.getWorldQuaternion(out);
          } else {
            out.copy(this.el.object3D.quaternion);
          }
          return out;
        },

        /** World horizontal facing for locomotion blends / move direction. */
        _getWorldLocomotionYawQuat: function() {
          if (!this.camera) return new THREE.Quaternion();
          const q = new THREE.Quaternion();
          this.camera.object3D.getWorldQuaternion(q);
          return this._yawOnlyQuat(q);
        },

        /**
         * Rig-local tracking when body is a rig child â€” parent rig carries snap-yaw.
         * World tracking for mirror / non-child bodies.
         */
        _readTrackingTransforms: function (out) {
          if (this._isLocalRigChild()) {
            out.headPos.copy(this.camera.object3D.position);
            out.headQuat.copy(this.camera.object3D.quaternion);
            out.leftPos.copy(this.leftController.object3D.position);
            out.leftQuat.copy(this.leftController.object3D.quaternion);
            out.rightPos.copy(this.rightController.object3D.position);
            out.rightQuat.copy(this.rightController.object3D.quaternion);
            out.space = 'offset';
            return out;
          }
          this.camera.object3D.getWorldPosition(out.headPos);
          this.camera.object3D.getWorldQuaternion(out.headQuat);
          this.leftController.object3D.getWorldPosition(out.leftPos);
          this.leftController.object3D.getWorldQuaternion(out.leftQuat);
          this.rightController.object3D.getWorldPosition(out.rightPos);
          this.rightController.object3D.getWorldQuaternion(out.rightQuat);
          out.space = 'world';
          return out;
        },
        
        // Lower body only: twist hips (legs follow), counter-rotate spine so torso/head stay on headset.
        _applyLowerBodyMoveYaw: function(dt, targetOffset) {
          if (!this.bones.hips) return;

          // When strafe animation is playing, it handles sideways â€” no hip twist
          const strafeBlend = (this._blendWeights.strafeLeft || 0) + (this._blendWeights.strafeRight || 0);
          if (strafeBlend > 0.5) {
            this._resetMoveYawTwist();
            return;
          }
          
          const currentTarget = this._smoothedMoveYawTarget || 0;
          const closing = Math.abs(targetOffset) < Math.abs(currentTarget);
          this._smoothedMoveYawTarget = THREE.MathUtils.lerp(
            currentTarget,
            targetOffset,
            Math.min(1, dt * (closing ? 5 : 9))
          );
          
          const maxStep = (closing ? 2.2 : 3.4) * dt;
          const twistDelta = this._shortestYawDelta(this.moveYawTwist, this._smoothedMoveYawTarget);
          this.moveYawTwist += THREE.MathUtils.clamp(twistDelta, -maxStep, maxStep);
          
          if (Math.abs(this.moveYawTwist) < 0.0005 && Math.abs(this._smoothedMoveYawTarget) < 0.0005) {
            this._resetMoveYawTwist();
            return;
          }
          if (Math.abs(this.moveYawTwist) < 0.0005) return;
          
          const yAxis = new THREE.Vector3(0, 1, 0);
          const twistQuat = new THREE.Quaternion().setFromAxisAngle(yAxis, this.moveYawTwist);
          const invTwist = twistQuat.clone().invert();
          
          // Legs (upLeg â†’ foot) are hip children â€” they aim toward travel direction.
          this.bones.hips.quaternion.multiply(twistQuat);
          
          // Spine chain sits on hips; undo the yaw there so shoulders/neck/head keep entity forward.
          // VR head + hand IK run afterward in updateBones().
          if (this.bones.spine) {
            this.bones.spine.quaternion.premultiply(invTwist);
          }
        },
        
        _measureBodyOffsets: function() {
          if (!this.bones.hips) return;
          
          this.el.object3D.position.set(0, 0, 0);
          this.el.object3D.updateMatrixWorld(true);
          
          if (this.mixer && this.animClips.idle) {
            const idle = this.mixer.clipAction(this.animClips.idle);
            idle.play();
            idle.time = 0;
            this.mixer.update(0);
          }
          if (this.skeleton) {
            this.skeleton.update();
          }
          this.model.updateWorldMatrix(true, true);
          
          const hipsWorld = new THREE.Vector3();
          const entityWorld = new THREE.Vector3();
          this.bones.hips.getWorldPosition(hipsWorld);
          this.el.object3D.getWorldPosition(entityWorld);
          this.modelHipsLocalY = hipsWorld.y - entityWorld.y;
          
          if (this.bones.leftFoot && this.bones.rightFoot) {
            const left = new THREE.Vector3();
            const right = new THREE.Vector3();
            this.bones.leftFoot.getWorldPosition(left);
            this.bones.rightFoot.getWorldPosition(right);
            this.modelFeetLocalY = Math.min(left.y, right.y) - entityWorld.y;
            const meshBounds = new THREE.Box3().setFromObject(this.model);
            const soleWorldY = meshBounds.min.y;
            const ankleWorldY = Math.min(left.y, right.y);
            this.ankleToSoleM = THREE.MathUtils.clamp(ankleWorldY - soleWorldY, 0.04, 0.14);
          } else {
            const bounds = new THREE.Box3().setFromObject(this.model);
            this.modelFeetLocalY = bounds.min.y - entityWorld.y;
            this.ankleToSoleM = 0.08;
          }
          
          if (this.bones.head && this.bones.neck) {
            const headW = new THREE.Vector3();
            const neckW = new THREE.Vector3();
            this.bones.head.getWorldPosition(headW);
            this.bones.neck.getWorldPosition(neckW);
            this._restHeadAboveNeck = Math.max(0.08, headW.y - neckW.y);
          }
          if (this.bones.hips) {
            this._standingHipsLocalY = this.bones.hips.position.y;
          }
          
          if (this.bones.head) {
            const headW = new THREE.Vector3();
            this.bones.head.getWorldPosition(headW);
            this.modelHeadLocalY = headW.y - entityWorld.y;
          }
          if (this.bones.headTop) {
            const topW = new THREE.Vector3();
            this.bones.headTop.getWorldPosition(topW);
            this.modelHeadTopLocalY = topW.y - entityWorld.y;
          } else if (this.modelHeadLocalY != null) {
            this.modelHeadTopLocalY = this.modelHeadLocalY + (this._restHeadAboveNeck || 0.1);
          }
          this.modelStandingHeightM =
            (this.modelHeadTopLocalY != null ? this.modelHeadTopLocalY : this.modelHeadLocalY || 0) -
            this.modelFeetLocalY;
          this.modelEyeHeightM = (this.modelHeadLocalY || 1.6) - (this._headEyeOffsetY || 0.06);
          
          const w = this.el.sceneEl.legIkWorld;
          if (w) {
            w.modelStandingHeightM = this.modelStandingHeightM;
            w.modelEyeHeightM = this.modelEyeHeightM;
            w.modelFeetLocalY = this.modelFeetLocalY;
            w.ankleToSoleM = this.ankleToSoleM;
          }
          this.el.sceneEl.emit('model-dimensions-measured', {
            standingHeightM: this.modelStandingHeightM,
            eyeHeightM: this.modelEyeHeightM,
            feetLocalY: this.modelFeetLocalY,
            ankleToSoleM: this.ankleToSoleM
          });
          
          const heightInfo = document.getElementById('model-height-info');
          if (heightInfo) {
            heightInfo.textContent =
              '~' + this.modelStandingHeightM.toFixed(2) + ' m tall Â· model eye ~' +
              this.modelEyeHeightM.toFixed(2) + ' m';
          }
          
          console.log('[Mixamo Body] standingHeight:', this.modelStandingHeightM.toFixed(3), 'm',
            'modelEye:', this.modelEyeHeightM.toFixed(3), 'm',
            'modelHipsLocalY:', this.modelHipsLocalY.toFixed(3),
            'modelFeetLocalY:', this.modelFeetLocalY.toFixed(3),
            'ankleToSole:', this.ankleToSoleM.toFixed(3),
            'headAboveNeck:', (this._restHeadAboveNeck || 0).toFixed(3));
        },
        
        // Hips sit ~15 cm behind the head; character forward is -Z, so +Z is backward.
        _getHipsBackOffset: function() {
          const back = new THREE.Vector3(0, 0, 0.15);
          back.applyQuaternion(this._getYawQuat());
          return back;
        },
        
        /** Flatten any quaternion to yaw-only (for locomotion / zero-g legs). */
        _yawOnlyQuat: function (q, out) {
          const look = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
          look.y = 0;
          if (look.lengthSq() < 1e-6) {
            return (out || new THREE.Quaternion()).identity();
          }
          look.normalize();
          return (out || new THREE.Quaternion()).setFromUnitVectors(
            new THREE.Vector3(0, 0, -1),
            look
          );
        },

        // World floor stays at Y=0 (local-floor). Anchor body XZ under the head at physical ground.
        _isLocalRigChild: function() {
          if (this.data.isMirror || !this.rig) return false;
          let node = this.el.object3D;
          while (node) {
            if (node === this.rig.object3D) return true;
            node = node.parent;
          }
          return false;
        },

        _getPhysicalGroundY: function(headWorldX, headWorldZ) {
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (this._isLocalRigChild() && legIk?.physics) {
            return legIk.physics.getPlayerTranslation().y;
          }
          const legIkWorld = this.el.sceneEl.legIkWorld;
          if (this._isLocalRigChild() && legIkWorld?.playerRootPos) {
            return legIkWorld.playerRootPos.y;
          }
          if (legIkWorld?.terrain) {
            return legIkWorld.terrain.getHeightAtWorld(headWorldX, headWorldZ);
          }
          return 0;
        },

        _getManualBodyOffsetLocal: function() {
          const w = this.el.sceneEl.legIkWorld;
          if (!w || !this._isLocalRigChild()) return new THREE.Vector3();
          const local = new THREE.Vector3(
            w.bodyLateralOffsetM || 0,
            0,
            w.bodyForwardOffsetM || 0
          );
          local.applyQuaternion(this._getYawQuat());
          return local;
        },

        _applyModelVerticalScale: function() {
          if (!this.model) return;
          const scale = this.el.sceneEl.legIkWorld?.modelVerticalScale ?? 1;
          this.model.scale.set(1, scale, 1);
        },

        _getCameraLocalAnchor: function() {
          const camLocal = this.camera.object3D.position.clone();
          camLocal.add(this._getManualBodyOffsetLocal());
          camLocal.y = 0;
          return camLocal;
        },

        _getCameraFootWorld: function() {
          const foot = this._cameraFootWorldTmp || (this._cameraFootWorldTmp = new THREE.Vector3());
          foot.copy(this._getCameraLocalAnchor());
          const parent = this.camera?.object3D?.parent;
          if (parent) {
            parent.updateWorldMatrix(true, true);
            foot.applyMatrix4(parent.matrixWorld);
          }
          foot.y = this._getPhysicalGroundY(foot.x, foot.z);
          return foot;
        },

        _computeFootRoot: function(headWorldX, headWorldZ) {
          const groundY = this._getPhysicalGroundY(headWorldX, headWorldZ);
          return new THREE.Vector3(headWorldX, groundY, headWorldZ);
        },
        
        _anchorBodyAtFeet: function(footRoot) {
          // Room-scale: camera local XZ changes on the rig â€” anchor body there, not at rig origin.
          if (this._isLocalRigChild()) {
            this.el.object3D.position.copy(this._getCameraLocalAnchor());
            this.el.object3D.quaternion.copy(this._getYawQuat());
            return;
          }
          this.el.object3D.position.copy(footRoot);
          this.el.object3D.quaternion.copy(this._getYawQuat());
        },
        
        _getLegIKFootRoot: function(headWorldPos) {
          if (this._isLocalRigChild()) {
            return this._getCameraFootWorld();
          }
          const back = this._getHipsBackOffset();
          return this._computeFootRoot(
            headWorldPos.x + back.x,
            headWorldPos.z + back.z
          );
        },
        
        _updateLegDebug: function() {
          if (this.data.isMirror || !this.showLegDebug) return;
          const ik = this.legIK;
          const f = (v) => (v === undefined || v === null ? 'â€”' : v.toFixed(3));
          let line;
          if (!ik) {
            line = 'legIK: not initialized';
          } else {
            const w = this.el.sceneEl.legIkWorld;
            const L = ik.feet.left;
            const R = ik.feet.right;
            // Live world foot bone heights (what you actually see)
            const lw = new THREE.Vector3();
            const rw = new THREE.Vector3();
            if (this.bones.leftFoot) this.bones.leftFoot.getWorldPosition(lw);
            if (this.bones.rightFoot) this.bones.rightFoot.getWorldPosition(rw);
            line =
              'physics:' + (w?.world ? 'ON' : 'OFF') +
              ' active:' + ik.isActive +
              ' blend:' + f(ik._globalIKBlend) +
              ' spd:' + f(this.horizontalSpeed) +
              ' vrDrop:' + f(this._vrHeadDrop) +
              ' bodyAdj:' + f(w?.playerHeightAdjustM) +
              ' depth:' + f(w?.bodyForwardOffsetM) +
              ' side:' + f(w?.bodyLateralOffsetM) +
              ' scale:' + f(w?.modelVerticalScale) +
              ' camOff:' + f(w?.cameraFloorOffsetM) +
              ' camY:' + f(this.camera?.object3D?.position?.y) +
              ' standEye:' + f(w?.standingEyeLocalY) +
              ' crouch:' + f(w?.crouchAmount) +
              ' root:' + f(ik._rootPosition.y) +
              ' | L hit:' + (L.raycastHit ? f(L.raycastHitPoint.y) : 'NO') +
              ' off:' + f(L.positionOffset) +
              ' footY:' + f(lw.y) +
              ' | R hit:' + (R.raycastHit ? f(R.raycastHitPoint.y) : 'NO') +
              ' off:' + f(R.positionOffset) +
              ' footY:' + f(rw.y);
          }
          
          const el = document.querySelector('#legdebug');
          if (el) el.textContent = line;
          // Console logging disabled now that IK is confirmed working. Re-enable by
          // setting window._legDebugLog = true in the console if you need it again.
          if (window._legDebugLog) {
            this._legDebugCount = (this._legDebugCount || 0) + 1;
            if (this._legDebugCount % 60 === 0) console.log('[Leg IK]', line);
          }
        },
        
        _isZeroGMode: function () {
          return !!(window.BodyRiggedGravity && window.BodyRiggedGravity.isZeroG());
        },

        _getZeroGWorldVelocity: function () {
          const zc = this.rig?.components?.['zerog-locomotion'];
          if (zc && zc.getVelocity) {
            this._zeroGVel.copy(zc.getVelocity());
            return this._zeroGVel;
          }
          if (this.headVelocity) {
            this._zeroGVel.copy(this.headVelocity);
            return this._zeroGVel;
          }
          this._zeroGVel.set(0, 0, 0);
          return this._zeroGVel;
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

        _applyZeroGLegs: function (dt, modeBlend) {
          if (!this.zeroGLegs || !this.bones) return;
          const blend = modeBlend != null ? modeBlend : this._zeroGLegModeBlend;
          if (blend <= 0.001) return;
          const refQuat = this._zeroGBodyQuat || (this._zeroGBodyQuat = new THREE.Quaternion());
          if (this._isLocalRigChild()) {
            this.el.object3D.getWorldQuaternion(refQuat);
            this._yawOnlyQuat(refQuat, refQuat);
          } else {
            this._yawOnlyQuat(this.torsoRotation, refQuat);
          }
          this.zeroGLegs.update(
            this.bones,
            this._getZeroGWorldVelocity(),
            refQuat,
            dt,
            blend
          );
          if (this.skeleton) this.skeleton.update();
        },

        _isGrabHangActive: function () {
          if (this.data.isMirror || this._isZeroGMode()) return false;
          if (!(this._grabAnchorActiveLeft || this._grabAnchorActiveRight)) return false;
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          return !!legIk?.grabPullLocomotionActive && legIk?.playerGrounded === false;
        },

        _getGrabHangWorldVelocity: function () {
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (!this._hangVel) this._hangVel = new THREE.Vector3();
          if (legIk?._grabPullVelocity) {
            this._hangVel.copy(legIk._grabPullVelocity);
          } else {
            this._hangVel.set(0, 0, 0);
          }
          return this._hangVel;
        },

        _applyGrabHangLegs: function (dt) {
          if (!this.zeroGLegs || !this.bones) return;
          const refQuat = this._zeroGBodyQuat || (this._zeroGBodyQuat = new THREE.Quaternion());
          if (this._isLocalRigChild()) {
            this.el.object3D.getWorldQuaternion(refQuat);
            this._yawOnlyQuat(refQuat, refQuat);
          } else {
            this._yawOnlyQuat(this.torsoRotation, refQuat);
          }
          this.zeroGLegs.update(
            this.bones,
            this._getGrabHangWorldVelocity(),
            refQuat,
            dt
          );
          if (this.skeleton) this.skeleton.update();
        },

        _applyLegIKTerrain: function(dt, footRoot) {
          const legBlend = this._zeroGLegModeBlend;
          const fullZeroG = this._isZeroGMode() && legBlend > 0.88;

          // Zero-G legs are applied at end of updateBones (after hip/spine reset).
          if (fullZeroG) {
            if (this.legIK) {
              this.legIK.isActive = false;
              this.legIK.isGrounded = false;
              this.legIK.jumped = true;
              this.legIK.isMoving = false;
            }
            return;
          }

          if (this._isGrabHangActive()) {
            if (this.legIK) {
              this.legIK.isActive = false;
              this.legIK.isGrounded = false;
              this.legIK.jumped = true;
              this.legIK.isMoving = false;
            }
            if (!this.useAnimatedLocomotion) {
              const mantleCrouch = this.el.sceneEl.legIkWorld?.mantleCrouchAmount || 0;
              if (mantleCrouch < 0.05) {
                const hipsInitialPos = this.initialBonePositions[this.bones.hips?.name];
                if (hipsInitialPos) {
                  this.bones.hips.position.copy(hipsInitialPos);
                }
              }
            }
            return;
          }

          const mantleCrouch = this.el.sceneEl.legIkWorld?.mantleCrouchAmount || 0;
          const legIkComp = this.el.sceneEl.components['leg-ik-world'];
          const grabbing = this._grabAnchorActiveLeft || this._grabAnchorActiveRight;
          const grabAirborne = grabbing && (
            !!legIkComp?._grabPullRising || legIkComp?.playerGrounded === false
          );
          if (!this.useAnimatedLocomotion) {
            if (mantleCrouch < 0.05) {
              const hipsInitialPos = this.initialBonePositions[this.bones.hips?.name];
              if (hipsInitialPos) {
                this.bones.hips.position.copy(hipsInitialPos);
              }
            }
            if (!this._isGrabHangActive()) {
              this.updateLegAnimation(dt, this.horizontalSpeed);
            }
          }
          
          if (!this.legIK) return;
          
          const sprint = this._smoothedHorizontalSpeed >= this.sprintThreshold;
          const crouchAmt = this.el.sceneEl.legIkWorld?.crouchAmount || 0;
          const effectiveCrouch = Math.max(crouchAmt, mantleCrouch);
          const crouchWeight = Math.max(this._crouchAnimWeight || 0, mantleCrouch);
          const strafeWeight = (this._blendWeights.strafeLeft || 0) + (this._blendWeights.strafeRight || 0);
          this.legIK.crouchFootPlantMode = effectiveCrouch > 0.03;
          this.legIK.lateralFootPlantMode = strafeWeight > 0.42 && effectiveCrouch < 0.2;
          if (grabAirborne) {
            this.legIK.isGrounded = false;
            this.legIK.jumped = true;
            this.legIK.isMoving = false;
          } else {
            this.legIK.isGrounded = true;
            this.legIK.isMoving = mantleCrouch > 0.08
              ? false
              : this._smoothedHorizontalSpeed > this.walkThreshold;
            this.legIK.jumped = false;
          }
          this.legIK.isActive = !sprint && !grabAirborne;
          this.legIK.speed = this._smoothedHorizontalSpeed;
          
          this.legIK.update(dt, footRoot);
          
          if (this.skeleton) {
            this.skeleton.update();
          }
        },
        
        // --- 2D Blend Space Locomotion (UE-style) ---
        // All locomotion clips play simultaneously; weights interpolated each frame
        // from the 2D movement vector relative to character facing.

        _initBlendSpace: function() {
          if (!this.mixer) return;
          const slots = ['idle', 'walk', 'run', 'strafeLeft', 'strafeRight'];
          slots.forEach((slot) => {
            if (!this.animClips[slot]) return;
            const action = this.mixer.clipAction(this.animClips[slot]);
            if (!action.isRunning()) {
              action.reset();
              action.setLoop(THREE.LoopRepeat, Infinity);
              action.setEffectiveWeight(0);
              action.setEffectiveTimeScale(1);
              action.play();
            }
          });
          this._blendSpaceInited = true;
        },

        _computeBlendWeights: function(speed, fwdComp, rightComp) {
          const w = { idle: 0, walk: 0, run: 0, strafeLeft: 0, strafeRight: 0 };

          if (speed < this.walkThreshold) {
            return w;
          }

          const hasStrafe = !!(this.animClips.strafeLeft && this.animClips.strafeRight);
          const hasRun = !!this.animClips.run;

          // Pure strafe = lateral input dominates with very little forward.
          // Diagonals use walk + hip rotation (no strafe blending).
          const absFwd = Math.abs(fwdComp);
          const absRight = Math.abs(rightComp);
          const isPureStrafe = hasStrafe && absRight > absFwd * 1.35 && absFwd < 0.28;

          // Speed zones with smooth ramps
          const runEntry = this.sprintThreshold * 0.8;
          const runFull = this.sprintThreshold;

          const locoRamp = THREE.MathUtils.smoothstep(speed, this.walkThreshold, this.walkThreshold + 0.4);
          let idleBlend = 1 - locoRamp;
          let locoBlend = locoRamp;
          let runBlend = 0;

          if (hasRun && speed > runEntry) {
            const runRamp = THREE.MathUtils.smoothstep(speed, runEntry, runFull);
            runBlend = runRamp * locoBlend;
            locoBlend *= (1 - runRamp);
          }

          w.idle = idleBlend;

          if (isPureStrafe) {
            // Pure sideways: strafe animation only
            if (rightComp < 0) {
              w.strafeLeft = locoBlend + runBlend;
            } else {
              w.strafeRight = locoBlend + runBlend;
            }
          } else {
            // Forward, backward, or diagonal: walk/run + hip rotation handles direction
            w.walk = locoBlend;
            w.run = runBlend;
          }

          return w;
        },

        _updateBlendTimeScales: function(speed) {
          const walkRef = 2.0;
          const runRef = 3.5;
          const strafeRef = this.strafeReferenceSpeed || 1.6;

          const absSpeed = Math.abs(speed);
          const sign = this._walkBackSign;
          const moving = absSpeed > this.walkThreshold;

          if (this.animClips.walk) {
            const walkScale = moving ? THREE.MathUtils.clamp(absSpeed / walkRef, 0.5, 2.5) : 1;
            this.mixer.clipAction(this.animClips.walk).setEffectiveTimeScale(sign * walkScale);
          }
          if (this.animClips.run) {
            const runScale = moving ? THREE.MathUtils.clamp(absSpeed / runRef, 0.7, 2.5) : 1;
            this.mixer.clipAction(this.animClips.run).setEffectiveTimeScale(sign * runScale);
          }
          if (this.animClips.strafeLeft) {
            const sScale = moving ? THREE.MathUtils.clamp(absSpeed / strafeRef, 0.4, 3.0) : 1;
            this.mixer.clipAction(this.animClips.strafeLeft).setEffectiveTimeScale(sScale);
          }
          if (this.animClips.strafeRight) {
            const sScale = moving ? THREE.MathUtils.clamp(absSpeed / strafeRef, 0.4, 3.0) : 1;
            this.mixer.clipAction(this.animClips.strafeRight).setEffectiveTimeScale(sScale);
          }
          if (this.animClips.idle) {
            this.mixer.clipAction(this.animClips.idle).setEffectiveTimeScale(1);
          }
        },

        _applyBlendWeights: function(dt) {
          const BLEND_SPEED = 12;
          const alpha = Math.min(1, dt * BLEND_SPEED);

          const slots = ['idle', 'walk', 'run', 'strafeLeft', 'strafeRight'];
          slots.forEach((slot) => {
            if (!this.animClips[slot]) {
              this._blendWeights[slot] = 0;
              return;
            }
            this._blendWeights[slot] = THREE.MathUtils.lerp(
              this._blendWeights[slot],
              this._blendWeightsTarget[slot],
              alpha
            );
            this.mixer.clipAction(this.animClips[slot]).setEffectiveWeight(
              Math.max(this._blendWeights[slot], 0.0001)
            );
          });
        },

        _playAnimation: function(name, fadeTime) {
          if (!this.mixer || !this.animClips[name]) return;
          if (this.currentAnim === name) return;
          this.currentAnim = name;
        },

        _isLocomotionSuppressed: function() {
          return !!(this._grabAnchorActiveLeft || this._grabAnchorActiveRight);
        },
        
        _updateLocomotionAnimation: function(dt) {
          if (!this.mixer) return;

          this._updateSmoothedMoveDir(dt);

          const locomotionSuppressed = this._isLocomotionSuppressed();
          const speed = locomotionSuppressed ? 0 : this._smoothedHorizontalSpeed;
          const crouchAmt = this.el.sceneEl.legIkWorld?.crouchAmount || 0;
          const crouching = crouchAmt > 0.12 || (this._crouchAnimWeight || 0) > 0.12;

          if (speed < this.walkThreshold && !crouching && !locomotionSuppressed) {
            if (this.mixer) this.mixer.stopAllAction();
            this._blendSpaceInited = false;
            this._restoreBindPose();
            return;
          }

          this._initBlendSpace();

          // Decompose movement into facing-relative forward/right components
          let comps = locomotionSuppressed ? null : this._getMoveFacingComponents();
          let fwdComp = 0, rightComp = 0;
          if (speed >= this.walkThreshold) {
            if (comps) {
              fwdComp = comps.fwdComp;
              rightComp = comps.rightComp;
            } else {
              fwdComp = 1;
            }
          }

          // Track walk direction for backward playback
          if (fwdComp < -0.12) this._walkBackSign = -1;
          else if (fwdComp > 0.08) this._walkBackSign = 1;

          // Compute blend weights from 2D movement vector
          this._blendWeightsTarget = this._computeBlendWeights(speed, fwdComp, rightComp);

          // Smoothly interpolate weights each frame
          this._applyBlendWeights(dt);

          // Set timeScale on each clip to match actual travel speed
          this._updateBlendTimeScales(speed);

          // Crouch overlay
          this._updateCrouchPose(dt);

          // Advance mixer â€” all actions play naturally at their timeScale
          this.mixer.update(dt);

          if (this.bones.hips) {
            this._animatedHipsLocalY = this.bones.hips.position.y;
          }
          if (!this.animClips.crouchStand) {
            this._applyVRCrouchProcedural();
          }

          if (crouchAmt < 0.03 && this.bones.hips) {
            this._standingHipsLocalY = this.bones.hips.position.y;
          }

          // Lower-body yaw twist for diagonal movement
          const strafeWeight = (this._blendWeights.strafeLeft || 0) + (this._blendWeights.strafeRight || 0);
          const isMostlyStrafing = strafeWeight > 0.65;
          let yawOffset = 0;
          if (locomotionSuppressed) {
            this._resetMoveYawTwist();
          } else if (!isMostlyStrafing && speed >= this.walkThreshold) {
            yawOffset = this._getMoveYawOffset(speed, 0);
          }
          const crouchWalking = crouching && speed > this.walkThreshold;
          this._applyLowerBodyMoveYaw(
            dt,
            locomotionSuppressed ? 0 : (crouchWalking ? yawOffset * 0.65 : (crouching ? 0 : yawOffset))
          );

          if (!this.data.isMirror) {
            this._hideLocalHeadMesh();
          }
        },
        
        _applyMantleCrouchBlend: function (dt, mantleAmount) {
          if (mantleAmount < 0.01 || this.data.isMirror) return;

          const clip = this.animClips.crouchStand;
          if (clip && this.mixer) {
            this._crouchAnimWeight = THREE.MathUtils.lerp(
              this._crouchAnimWeight || 0,
              mantleAmount,
              Math.min(1, dt * 40)
            );
            if (mantleAmount > 0.55) {
              this._crouchAnimWeight = Math.max(this._crouchAnimWeight, mantleAmount * 0.96);
            }

            const action = this.mixer.clipAction(clip);
            action.setLoop(THREE.LoopOnce, 1);
            action.clampWhenFinished = true;
            if (!action.isRunning()) {
              action.reset();
              action.play();
            }
            action.setEffectiveTimeScale(0);
            action.time = THREE.MathUtils.clamp((1 - mantleAmount) * clip.duration, 0, clip.duration);
            action.setEffectiveWeight(Math.max(mantleAmount * 0.98, this._crouchAnimWeight));

            ['idle', 'walk', 'run', 'strafeRight', 'strafeLeft'].forEach((slot) => {
              if (!this.animClips[slot]) return;
              const locoAction = this.mixer.clipAction(this.animClips[slot]);
              if (!locoAction.isRunning()) return;
              locoAction.setEffectiveWeight(0.01);
            });

            this.mixer.update(0);
          }

          if (this.bones.hips && this._animatedHipsLocalY !== undefined) {
            this.bones.hips.position.y = this._animatedHipsLocalY - mantleAmount * 0.52;
          }

          if (this.skeleton) {
            this.skeleton.update();
          }
        },

        _updateCrouchPose: function(dt) {
          const mantleCrouch = this.el.sceneEl.legIkWorld?.mantleCrouchAmount || 0;
          if (mantleCrouch > 0.02) return;

          const vrCrouch = this.el.sceneEl.legIkWorld?.crouchAmount || 0;
          const target = Math.min(1, vrCrouch);
          const clip = this.animClips.crouchStand;

          if (!clip || !this.mixer) {
            return;
          }

          this._crouchAnimWeight = THREE.MathUtils.lerp(
            this._crouchAnimWeight || 0,
            target > 0.03 ? 1 : 0,
            Math.min(1, dt * 10)
          );

          const speed = this._smoothedHorizontalSpeed || 0;
          const moving = speed > this.walkThreshold;
          const moveBlend = moving
            ? THREE.MathUtils.clamp(
                (speed - this.walkThreshold) / Math.max(this.sprintThreshold - this.walkThreshold, 0.4),
                0,
                1
              )
            : 0;

          const action = this.mixer.clipAction(clip);
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
          if (!action.isRunning()) {
            action.reset();
            action.play();
          }
          action.setEffectiveTimeScale(0);
          action.time = THREE.MathUtils.clamp((1 - target) * clip.duration, 0, clip.duration);

          const crouchEffective = this._crouchAnimWeight * (
            moving ? THREE.MathUtils.lerp(1, 0.38, moveBlend) : 1
          );
          action.setEffectiveWeight(crouchEffective);

          // When crouching, scale locomotion weights so crouch pose can dominate
          if (this._crouchAnimWeight > 0.05) {
            let locoFade;
            if (moving) {
              locoFade = THREE.MathUtils.lerp(0.3, 1.0, moveBlend);
            } else {
              locoFade = this._crouchAnimWeight > 0.35
                ? Math.max(0, 1 - this._crouchAnimWeight * 0.98)
                : 1 - this._crouchAnimWeight * 0.92;
            }

            ['idle', 'walk', 'run', 'strafeRight', 'strafeLeft'].forEach((slot) => {
              if (!this.animClips[slot]) return;
              const locoAction = this.mixer.clipAction(this.animClips[slot]);
              if (!locoAction.isRunning()) return;
              locoAction.setEffectiveWeight(
                Math.max((this._blendWeights[slot] || 0) * locoFade, 0.0001)
              );
            });
          }
        },
        
        _applyWorldDeltaToLocal: function(bone, worldDelta) {
          if (!bone.parent) {
            bone.quaternion.premultiply(worldDelta);
            return;
          }
          const parentQ = new THREE.Quaternion();
          bone.parent.getWorldQuaternion(parentQ);
          const localDelta = parentQ.clone().invert().multiply(worldDelta).multiply(parentQ);
          bone.quaternion.premultiply(localDelta);
        },
        
        _getEffectiveEyeLocalY: function() {
          const comp = this.el.sceneEl.components['leg-ik-world'];
          if (comp?._getEffectiveEyeLocalY) return comp._getEffectiveEyeLocalY();
          return this.camera?.object3D?.position?.y ?? 0;
        },

        _getMaxCrouchDropM: function() {
          const w = this.el.sceneEl.legIkWorld;
          if (!w) return 0.38;
          if (w.maxCrouchDropM != null) return w.maxCrouchDropM;
          const maxCrouch = w.maxCrouchAmount ?? 0.62;
          return 0.08 + maxCrouch * (0.55 - 0.08);
        },

        _getVRHeadDrop: function() {
          if (!this.camera || !this.el.sceneEl.is('vr-mode')) return 0;
          const legIkWorld = this.el.sceneEl.legIkWorld;
          if (!legIkWorld) return 0;
          const camY = this.camera.object3D.position.y;
          if (camY < 0.35 || camY > 2.4) return 0;
          const standing = legIkWorld.standingEyeLocalY || 1.6;
          const raw = Math.max(0, standing - camY);
          return Math.min(raw, this._getMaxCrouchDropM());
        },
        
        // Shift avatar mesh vs tracked headset. standingEyeLocalY sets standing drop; body tune fine-tunes feet.
        _applyVRVerticalDrop: function() {
          if (!this.model) return;
          const drop = this._getVRHeadDrop();
          const base = this._modelBaseY ?? 0.05;
          const adjust = this.el.sceneEl.legIkWorld?.playerHeightAdjustM || 0;
          const scale = this.el.sceneEl.legIkWorld?.modelVerticalScale ?? 1;
          const ankleToSole = (this.ankleToSoleM || this.el.sceneEl.legIkWorld?.ankleToSoleM || 0.08) * scale;
          const feetLift = Math.max(0, (this.modelFeetLocalY || 0) * scale - ankleToSole);
          const soleOffset = this._soleGroundOffset || 0;
          this.model.position.y = base - drop + adjust - feetLift - soleOffset;
          this._vrHeadDrop = drop;
        },

        _updateSoleGroundOffset: function(dt) {
          if (this.data.isMirror || !this.model) return;

          const legIk = this.el.sceneEl.components['leg-ik-world'];
          const grabbing = this._grabAnchorActiveLeft || this._grabAnchorActiveRight;
          if (grabbing && (legIk?._grabPullRising || legIk?.playerGrounded === false)) {
            this._soleGroundOffset = THREE.MathUtils.lerp(
              this._soleGroundOffset || 0,
              0,
              Math.min(1, dt * 8)
            );
            return;
          }

          const w = this.el.sceneEl.legIkWorld;
          if ((w?.mantleCrouchAmount || 0) > 0.05) return;

          const speed = this._smoothedHorizontalSpeed || 0;
          const strafeWeight = (this._blendWeights?.strafeLeft || 0) + (this._blendWeights?.strafeRight || 0);
          const isStrafing = strafeWeight > 0.42;
          const crouchBlend = Math.max(w?.crouchAmount || 0, this._crouchAnimWeight || 0);

          // Leg IK handles feet during walk/strafe; decay stale sole offset (avoids mesh bob).
          if (speed > 0.15 && !isStrafing && crouchBlend < 0.08) {
            this._soleGroundOffset = THREE.MathUtils.lerp(
              this._soleGroundOffset || 0,
              0,
              Math.min(1, dt * 10)
            );
            return;
          }

          const gap = this._measureSoleGroundGap();
          if (gap == null || Math.abs(gap) > 0.35) return;

          const settleSpeed = crouchBlend > 0.05 ? 28 : 16;
          const alpha = Math.min(1, dt * settleSpeed);

          if (Math.abs(gap) < 0.001) {
            this._soleGroundOffset = THREE.MathUtils.lerp(
              this._soleGroundOffset || 0,
              0,
              alpha * 0.35
            );
            return;
          }

          this._soleGroundOffset = (this._soleGroundOffset || 0) + gap * alpha;
          this._soleGroundOffset = THREE.MathUtils.clamp(this._soleGroundOffset, -0.12, 0.12);
        },

        _getAnkleToSoleM: function() {
          const scale = this.el.sceneEl.legIkWorld?.modelVerticalScale ?? 1;
          return (this.ankleToSoleM || this.el.sceneEl.legIkWorld?.ankleToSoleM || 0.08) * scale;
        },

        _getSoleWorldY: function() {
          if (!this.bones.leftFoot || !this.bones.rightFoot) return null;
          const left = new THREE.Vector3();
          const right = new THREE.Vector3();
          this.bones.leftFoot.getWorldPosition(left);
          this.bones.rightFoot.getWorldPosition(right);
          return Math.min(left.y, right.y) - this._getAnkleToSoleM();
        },

        _measureSoleGroundGap: function() {
          if (!this.bones.leftFoot || !this.bones.rightFoot) return null;
          const left = new THREE.Vector3();
          const right = new THREE.Vector3();
          this.bones.leftFoot.getWorldPosition(left);
          this.bones.rightFoot.getWorldPosition(right);
          const midX = (left.x + right.x) * 0.5;
          const midZ = (left.z + right.z) * 0.5;
          let groundY = this._getPhysicalGroundY(midX, midZ);
          if (this.legIK?.queries) {
            const hit = this.legIK.queries.castRayDown(
              midX,
              Math.max(left.y, right.y) + 0.4,
              midZ,
              1.2,
              this.legIK.playerShapeIds
            );
            if (hit) groundY = hit.point.y;
          } else if (this.el.sceneEl.legIkWorld?.queries) {
            const hit = this.el.sceneEl.legIkWorld.queries.castRayDown(
              midX,
              Math.max(left.y, right.y) + 0.4,
              midZ,
              1.2,
              this.el.sceneEl.legIkWorld.playerShapeIds
            );
            if (hit) groundY = hit.point.y;
          }
          const soleY = this._getSoleWorldY();
          if (soleY == null) return null;
          return soleY - groundY;
        },

        _applySoleGroundLock: function() {
          // Deprecated â€” sole alignment is integrated via _updateSoleGroundOffset + _applyVRVerticalDrop.
        },

        _finalizeCalibrationFromFeet: function() {
          const gap = this._measureSoleGroundGap();
          if (gap == null || Math.abs(gap) > 0.4) {
            this._pendingFootCalibration = false;
            return;
          }

          if (Math.abs(gap) >= 0.002) {
            this._soleGroundOffset = (this._soleGroundOffset || 0) + gap;
            this._soleGroundOffset = THREE.MathUtils.clamp(this._soleGroundOffset, -0.12, 0.12);
          }

          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (legIk?.setBodyHeightAdjust) {
            legIk.setBodyHeightAdjust(0);
          }
          this._pendingFootCalibration = false;
        },
        
        // Close the vertical gap between HMD and animated neck each frame.
        _syncTorsoToHead: function(headWorldPos) {
          if (!this.bones.hips || !this.bones.neck) return;
          const crouch = this.el.sceneEl.legIkWorld?.crouchAmount || 0;
          if (crouch < 0.05) return;

          const maxCompress = this._getMaxCrouchDropM() * 0.55;
          
          this.model.updateWorldMatrix(true, true);
          
          const headTarget = headWorldPos.clone();
          headTarget.y -= this._headEyeOffsetY;
          const standing = this.el.sceneEl.legIkWorld?.standingEyeLocalY || 1.6;
          const rig = this.rig?.object3D;
          if (rig) {
            const minHeadWorldY = rig.localToWorld(
              new THREE.Vector3(0, standing - this._getMaxCrouchDropM(), 0)
            ).y;
            headTarget.y = Math.max(headTarget.y, minHeadWorldY);
          }
          
          const neckWorld = new THREE.Vector3();
          this.bones.neck.getWorldPosition(neckWorld);
          const rest = this._restHeadAboveNeck ?? 0.14;
          let errorY = headTarget.y - (neckWorld.y + rest);
          
          if (errorY >= -0.015) return;
          
          let compress = Math.min(-errorY, maxCompress);
          const hips = this.bones.hips;
          const hipsWorld = new THREE.Vector3();
          hips.getWorldPosition(hipsWorld);
          hipsWorld.y -= compress * 0.68;
          if (hips.parent) {
            hips.position.copy(hips.parent.worldToLocal(hipsWorld.clone()));
          }
          
          this.model.updateWorldMatrix(true, true);
          this.bones.neck.getWorldPosition(neckWorld);
          errorY = headTarget.y - (neckWorld.y + rest);
          if (errorY >= -0.015) return;
          
          compress = Math.min(-errorY, maxCompress * 0.45);
          const pitch = Math.min(compress * 0.85, 0.72);
          const bendAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(this._getYawQuat());
          const spineBones = [this.bones.spine, this.bones.spine1, this.bones.spine2];
          const weights = [0.22, 0.33, 0.45];
          spineBones.forEach((bone, i) => {
            if (!bone) return;
            const q = new THREE.Quaternion().setFromAxisAngle(bendAxis, pitch * weights[i]);
            this._applyWorldDeltaToLocal(bone, q);
          });
        },
        
        _applyPreLegIKPosture: function(headWorldPos) {
          this._syncTorsoToHead(headWorldPos);
          this._applyVRVerticalDrop();
        },

        _applyPostLegIKGrounding: function(headWorldPos, dt) {
          this._updateSoleGroundOffset(dt || 0.016);
          this._applyVRVerticalDrop();
        },
        
        _applyVRCrouchProcedural: function() {
          if (this.data.isMirror) return;
          const vrCrouch = this.el.sceneEl.legIkWorld?.crouchAmount || 0;
          const mantleCrouch = this.el.sceneEl.legIkWorld?.mantleCrouchAmount || 0;
          const crouch = Math.min(1, Math.max(vrCrouch, mantleCrouch));
          const hips = this.bones.hips;
          if (!hips || this._animatedHipsLocalY === undefined) return;
          
          if (crouch < 0.001) {
            hips.position.y = this._animatedHipsLocalY;
            return;
          }
          
          const drop = crouch * 0.45;
          hips.position.y = this._animatedHipsLocalY - drop;
          
          const lean = crouch * 0.38;
          const spineBones = [this.bones.spine, this.bones.spine1, this.bones.spine2];
          spineBones.forEach((bone, i) => {
            if (!bone) return;
            bone.quaternion.multiply(
              new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0),
                lean * (0.12 + i * 0.08)
              )
            );
          });
        },

        mapBones: function() {
          // Store initial T-pose rotations for reference
          this.initialBoneRotations = {};
          this.initialBonePositions = {};
          this.loggedHandTPose = false;
          this.skeleton.bones.forEach((bone) => {
            const name = bone.name;
            const mixamo = name.replace(/^mixamorig:/, 'mixamorig');
            
            this.initialBoneRotations[name] = bone.quaternion.clone();
            this.initialBonePositions[name] = bone.position.clone();
            
            if (mixamo === this.boneNames.hips) {
              this.bones.hips = bone;
            }
            else if (mixamo === this.boneNames.spine) this.bones.spine = bone;
            else if (mixamo === this.boneNames.spine1) this.bones.spine1 = bone;
            else if (mixamo === this.boneNames.spine2) this.bones.spine2 = bone;
            else if (mixamo === this.boneNames.neck) this.bones.neck = bone;
            else if (mixamo === this.boneNames.head) {
              this.bones.head = bone;
            }
            else if (mixamo === this.boneNames.headTop) {
              this.bones.headTop = bone;
            }
            else if (mixamo === this.boneNames.leftShoulder) this.bones.leftShoulder = bone;
            else if (mixamo === this.boneNames.leftArm) this.bones.leftUpperArm = bone;
            else if (mixamo === this.boneNames.leftForeArm) this.bones.leftForearm = bone;
            else if (mixamo === this.boneNames.leftHand) {
              this.bones.leftHandBone = bone;
              console.log('[T-Pose] Left Hand initial quat:', bone.quaternion.toArray());
            }
            // Left finger bones
            else if (mixamo === this.boneNames.leftHandThumb1) this.bones.leftHandThumb1 = bone;
            else if (mixamo === this.boneNames.leftHandThumb2) this.bones.leftHandThumb2 = bone;
            else if (mixamo === this.boneNames.leftHandThumb3) this.bones.leftHandThumb3 = bone;
            else if (mixamo === this.boneNames.leftHandIndex1) this.bones.leftHandIndex1 = bone;
            else if (mixamo === this.boneNames.leftHandIndex2) this.bones.leftHandIndex2 = bone;
            else if (mixamo === this.boneNames.leftHandIndex3) this.bones.leftHandIndex3 = bone;
            else if (mixamo === this.boneNames.leftHandMiddle1) this.bones.leftHandMiddle1 = bone;
            else if (mixamo === this.boneNames.leftHandMiddle2) this.bones.leftHandMiddle2 = bone;
            else if (mixamo === this.boneNames.leftHandMiddle3) this.bones.leftHandMiddle3 = bone;
            else if (mixamo === this.boneNames.leftHandRing1) this.bones.leftHandRing1 = bone;
            else if (mixamo === this.boneNames.leftHandRing2) this.bones.leftHandRing2 = bone;
            else if (mixamo === this.boneNames.leftHandRing3) this.bones.leftHandRing3 = bone;
            else if (mixamo === this.boneNames.leftHandPinky1) this.bones.leftHandPinky1 = bone;
            else if (mixamo === this.boneNames.leftHandPinky2) this.bones.leftHandPinky2 = bone;
            else if (mixamo === this.boneNames.leftHandPinky3) this.bones.leftHandPinky3 = bone;
            else if (mixamo === this.boneNames.rightShoulder) this.bones.rightShoulder = bone;
            else if (mixamo === this.boneNames.rightArm) this.bones.rightUpperArm = bone;
            else if (mixamo === this.boneNames.rightForeArm) this.bones.rightForearm = bone;
            else if (mixamo === this.boneNames.rightHand) {
              this.bones.rightHandBone = bone;
              console.log('[T-Pose] Right Hand initial quat:', bone.quaternion.toArray());
            }
            // Right finger bones
            else if (mixamo === this.boneNames.rightHandThumb1) this.bones.rightHandThumb1 = bone;
            else if (mixamo === this.boneNames.rightHandThumb2) this.bones.rightHandThumb2 = bone;
            else if (mixamo === this.boneNames.rightHandThumb3) this.bones.rightHandThumb3 = bone;
            else if (mixamo === this.boneNames.rightHandIndex1) this.bones.rightHandIndex1 = bone;
            else if (mixamo === this.boneNames.rightHandIndex2) this.bones.rightHandIndex2 = bone;
            else if (mixamo === this.boneNames.rightHandIndex3) this.bones.rightHandIndex3 = bone;
            else if (mixamo === this.boneNames.rightHandMiddle1) this.bones.rightHandMiddle1 = bone;
            else if (mixamo === this.boneNames.rightHandMiddle2) this.bones.rightHandMiddle2 = bone;
            else if (mixamo === this.boneNames.rightHandMiddle3) this.bones.rightHandMiddle3 = bone;
            else if (mixamo === this.boneNames.rightHandRing1) this.bones.rightHandRing1 = bone;
            else if (mixamo === this.boneNames.rightHandRing2) this.bones.rightHandRing2 = bone;
            else if (mixamo === this.boneNames.rightHandRing3) this.bones.rightHandRing3 = bone;
            else if (mixamo === this.boneNames.rightHandPinky1) this.bones.rightHandPinky1 = bone;
            else if (mixamo === this.boneNames.rightHandPinky2) this.bones.rightHandPinky2 = bone;
            else if (mixamo === this.boneNames.rightHandPinky3) this.bones.rightHandPinky3 = bone;
            else if (mixamo === this.boneNames.leftUpLeg) this.bones.leftUpLeg = bone;
            else if (mixamo === this.boneNames.leftLeg) this.bones.leftLeg = bone;
            else if (mixamo === this.boneNames.leftFoot) this.bones.leftFoot = bone;
            else if (mixamo === this.boneNames.rightUpLeg) this.bones.rightUpLeg = bone;
            else if (mixamo === this.boneNames.rightLeg) this.bones.rightLeg = bone;
            else if (mixamo === this.boneNames.rightFoot) this.bones.rightFoot = bone;
          });
          
          if (!this.data.isMirror) {
            this._hideLocalHeadMesh();
          }
          
          this._initLegIK();
        },
        
        _hideLocalHeadMesh: function() {
          // Walk/idle clips animate head scale every frame â€” must re-apply after mixer.update.
          const hidden = 0.001;
          if (this.bones.head) {
            this.bones.head.scale.set(hidden, hidden, hidden);
            const headName = this.bones.head.name;
            if (this.initialBonePositions[headName]) {
              this.bones.head.position.copy(this.initialBonePositions[headName]);
            }
          }
          if (this.bones.headTop) {
            this.bones.headTop.scale.set(hidden, hidden, hidden);
            const topName = this.bones.headTop.name;
            if (this.initialBonePositions[topName]) {
              this.bones.headTop.position.copy(this.initialBonePositions[topName]);
            }
          }
        },
        
        _initLegIK: function() {
          // IMPORTANT: read the scene's legIkWorld FRESH each retry. The physics code
          // REPLACES scene.legIkWorld with a new object once Box3D is ready, so a
          // captured reference would stay ready:false forever and the IK would never
          // be created (that was the bug: legs never adapted at all).
          const legIkWorld = this.el.sceneEl.legIkWorld;
          if (!window.MixamoLegIK || !legIkWorld || !legIkWorld.ready) {
            setTimeout(() => this._initLegIK(), 50);
            return;
          }
          
          this.legIK = new window.MixamoLegIK(
            this.model,
            legIkWorld.terrain,
            {
              raycastHeight: 1.2,
              raycastLength: 3.5,
              feetPositionOffsetWeight: 1.0,
              feetRotationOffsetWeight: 1.0,
              feetPositionOffsetSmoothing: 0.06,
              feetRotationOffsetSmoothing: 0.08,
              bodyPositionOffsetWeight: 1.0,
              bodyPositionOffsetSmoothing: 0.12,
              invertBodyPositionOffset: false,
              // Ankle-to-sole distance (NOT modelFeetLocalY â€” that is bone height in the rig).
              footSkinOffset: this.ankleToSoleM || 0.08,
              // Keep feet fully adapting through normal walking (player walk speed
              // ~2.5); only fade IK out at sprint speed so footwork doesn't fight
              // the run animation.
              ikWalkEngageSpeed: 3.0,
              ikRunSuppressSpeed: 4.6
            },
            legIkWorld.queries,
            legIkWorld.playerShapeIds || null
          );
          
          const legSlots = ['hips', 'leftThigh', 'leftKnee', 'leftFoot', 'rightThigh', 'rightKnee', 'rightFoot'];
          const missingLeg = legSlots.filter((s) => !this.legIK.bones[s]);
          console.log('[Mixamo Body]', this.data.isMirror ? 'Mirror' : 'Local', '- Leg IK initialized',
            missingLeg.length ? { missingBones: missingLeg } : 'all bones resolved');
        },

        _createDotSpriteTexture: function() {
          const size = 64;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          const center = size * 0.5;
          const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
          gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
          gradient.addColorStop(0.45, 'rgba(255, 255, 255, 1)');
          gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.fillStyle = gradient;
          ctx.fillRect(0, 0, size, size);
          const texture = new THREE.CanvasTexture(canvas);
          texture.needsUpdate = true;
          return texture;
        },

        _easeOutCubic: function(t) {
          const c = Math.max(0, Math.min(1, t));
          return 1 - Math.pow(1 - c, 3);
        },

        _getBodyDotEffectState: function() {
          const scene = this.el.sceneEl;
          if (!scene._bodyDotEffect) {
            scene._bodyDotEffect = {
              time: -1,
              triggerWasPressed: false,
              captureGen: 0,
              frozen: false,
              frozenPos: null,
              frozenPoseSnapshot: null
            };
          }
          return scene._bodyDotEffect;
        },

        _getControllerGamepad: function(hand) {
          const handedness = hand === 'left' ? 'left' : 'right';
          const scene = this.el.sceneEl;
          const session = scene.renderer?.xr?.getSession?.();
          if (session && session.inputSources) {
            for (let i = 0; i < session.inputSources.length; i++) {
              const source = session.inputSources[i];
              if (source.handedness === handedness && source.gamepad) {
                return source.gamepad;
              }
            }
          }

          const ctrl = hand === 'left' ? this.leftController : this.rightController;
          if (ctrl && ctrl.components) {
            const compNames = ['tracked-controls', 'oculus-touch-controls', 'meta-touch-controls'];
            for (let i = 0; i < compNames.length; i++) {
              const comp = ctrl.components[compNames[i]];
              const gamepad = comp && comp.controller ? comp.controller.gamepad : null;
              if (gamepad) return gamepad;
            }
          }

          const pads = navigator.getGamepads ? navigator.getGamepads() : [];
          for (let i = 0; i < pads.length; i++) {
            const pad = pads[i];
            if (!pad || !pad.connected) continue;
            const id = (pad.id || '').toLowerCase();
            const isRight = hand === 'right' && (id.indexOf('right') >= 0 || id.indexOf('(r)') >= 0);
            const isLeft = hand === 'left' && (id.indexOf('left') >= 0 || id.indexOf('(l)') >= 0);
            if (isRight || isLeft) return pad;
          }
          return null;
        },

        _isRightAButtonPressed: function() {
          const gamepad = this._getControllerGamepad('right');
          if (!gamepad || !gamepad.buttons) return false;
          const aBtn = gamepad.buttons[4];
          return !!(aBtn && (aBtn.pressed || aBtn.value > 0.5));
        },

        _initDotModelMaterials: function() {
          if (this._dotModelMaterialStates || !this.model) return;

          this._dotModelMaterialStates = [];
          this.model.traverse((node) => {
            if (!node.isMesh && !node.isSkinnedMesh) return;
            const mats = Array.isArray(node.material) ? node.material : [node.material];
            for (let i = 0; i < mats.length; i++) {
              const mat = mats[i];
              if (!mat || mat.userData._dotDissolveCached) continue;
              mat.userData._dotDissolveCached = true;
              this._dotModelMaterialStates.push({
                mat: mat,
                color: mat.color.clone(),
                emissive: mat.emissive ? mat.emissive.clone() : new THREE.Color(0, 0, 0),
                emissiveIntensity: typeof mat.emissiveIntensity === 'number' ? mat.emissiveIntensity : 1,
                opacity: typeof mat.opacity === 'number' ? mat.opacity : 1,
                transparent: !!mat.transparent
              });
            }
          });
        },

        _updateCharacterDissolve: function(effectTime) {
          if (!this.model) return;
          this._initDotModelMaterials();
          const states = this._dotModelMaterialStates;
          if (!states || !states.length) return;

          const total = this._dotModelDissolveDuration;
          const whiteEnd = this._dotModelWhiteDuration;
          const t = Math.min(effectTime, total);
          const whiteT = Math.min(1, t / whiteEnd);
          const fadeT = t <= whiteEnd ? 0 : Math.min(1, (t - whiteEnd) / (total - whiteEnd));
          const white = this._dotDissolveWhite;

          for (let i = 0; i < states.length; i++) {
            const s = states[i];
            const mat = s.mat;
            mat.transparent = true;
            mat.color.copy(s.color).lerp(white, whiteT);
            if (mat.emissive) {
              mat.emissive.copy(s.emissive).lerp(white, whiteT * 0.75);
            }
            if (typeof mat.emissiveIntensity === 'number') {
              mat.emissiveIntensity = s.emissiveIntensity + whiteT * 1.25;
            }
            mat.opacity = (1 - fadeT) * s.opacity;
            mat.depthWrite = mat.opacity > 0.95;
            mat.needsUpdate = true;
          }

          this._setCharacterModelVisible(fadeT < 1 || effectTime < total);
        },

        _resetCharacterDissolve: function() {
          const states = this._dotModelMaterialStates;
          if (!states) return;

          for (let i = 0; i < states.length; i++) {
            const s = states[i];
            const mat = s.mat;
            mat.color.copy(s.color);
            if (mat.emissive) mat.emissive.copy(s.emissive);
            if (typeof mat.emissiveIntensity === 'number') {
              mat.emissiveIntensity = s.emissiveIntensity;
            }
            mat.opacity = s.opacity;
            mat.transparent = s.transparent;
            mat.depthWrite = true;
            mat.needsUpdate = true;
          }
          this._setCharacterModelVisible(true);
        },

        _initBodyDotOverlay: function() {
          const skinnedMeshes = [];
          if (this.model) {
            this.model.traverse((node) => {
              if (node.isSkinnedMesh && node.skeleton) {
                skinnedMeshes.push(node);
              }
            });
          }
          if (!skinnedMeshes.length) {
            console.warn('[Mixamo Body]', this.data.isMirror ? 'Mirror' : 'Local',
              '- dot disintegration skipped: no skinned mesh');
            return;
          }

          const targetDotCount = 2800;
          let totalVerts = 0;
          for (let m = 0; m < skinnedMeshes.length; m++) {
            totalVerts += skinnedMeshes[m].geometry.attributes.position.count;
          }

          const sources = [];
          for (let m = 0; m < skinnedMeshes.length; m++) {
            const mesh = skinnedMeshes[m];
            const srcCount = mesh.geometry.attributes.position.count;
            const meshDots = Math.max(1, Math.round(targetDotCount * (srcCount / totalVerts)));
            const stride = Math.max(1, Math.floor(srcCount / meshDots));
            for (let i = 0; i < srcCount; i += stride) {
              sources.push({ mesh: mesh, vi: i });
            }
          }

          this._dotParticleSources = sources;
          this._dotSourceMesh = skinnedMeshes[0];
          this._dotSourceIndices = sources.map((src) => src.vi);
          const count = sources.length;

          const normTmp = new THREE.Vector3();
          const normals = new Float32Array(count * 3);
          const bindTmp = new THREE.Vector3();

          for (let i = 0; i < count; i++) {
            const src = sources[i];
            const mesh = src.mesh;
            const srcGeo = mesh.geometry;
            if (!srcGeo.attributes.normal) {
              srcGeo.computeVertexNormals();
            }
            normTmp.fromBufferAttribute(srcGeo.attributes.normal, src.vi);
            if (normTmp.lengthSq() < 1e-8) {
              normTmp.set(0, 1, 0);
            } else {
              normTmp.normalize();
            }
            normals[i * 3] = normTmp.x;
            normals[i * 3 + 1] = normTmp.y;
            normals[i * 3 + 2] = normTmp.z;
          }
          this._dotNormals = normals;

          const positions = new Float32Array(count * 3);
          this._dotBindLocal = new Float32Array(count * 3);
          for (let i = 0; i < count; i++) {
            const src = sources[i];
            const mesh = src.mesh;
            const srcPos = mesh.geometry.attributes.position;
            bindTmp.fromBufferAttribute(srcPos, src.vi);
            const base = i * 3;
            positions[base] = bindTmp.x;
            positions[base + 1] = bindTmp.y;
            positions[base + 2] = bindTmp.z;
            this._dotBindLocal[base] = bindTmp.x;
            this._dotBindLocal[base + 1] = bindTmp.y;
            this._dotBindLocal[base + 2] = bindTmp.z;
          }

          const dotGeo = new THREE.BufferGeometry();
          dotGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
          dotGeo.computeBoundingSphere();

          if (!window._bodyDotSpriteTexture) {
            window._bodyDotSpriteTexture = this._createDotSpriteTexture();
          }

          const pointSize = this.isGltf ? this._dotBaseSize : this._dotBaseSize * 100;
          this._dotMaterial = new THREE.PointsMaterial({
            map: window._bodyDotSpriteTexture,
            size: pointSize,
            sizeAttenuation: true,
            color: 0xffffff,
            transparent: true,
            opacity: 0,
            alphaTest: 0.02,
            depthWrite: false,
            depthTest: false,
            toneMapped: false,
            fog: false
          });

          this._dotPoints = new THREE.Points(dotGeo, this._dotMaterial);
          this._dotPoints.frustumCulled = false;
          this._dotPoints.renderOrder = 999;
          this._dotPoints.visible = false;
          this.model.add(this._dotPoints);

          console.log('[Mixamo Body]', this.data.isMirror ? 'Mirror' : 'Local',
            '- dot disintegration ready:', count, 'particles');
        },

        _computeSkinnedVertex: function(mesh, vertexIndex, target) {
          const geo = mesh.geometry;
          const srcPos = geo.attributes.position;
          const skinIndex = geo.attributes.skinIndex;
          const skinWeight = geo.attributes.skinWeight;
          const skeleton = mesh.skeleton;
          const bindPos = this._dotSkinnedTmp;

          bindPos.fromBufferAttribute(srcPos, vertexIndex);

          if (!skeleton || !skinIndex || !skinWeight) {
            target.copy(bindPos);
            return target;
          }

          const boneCount = skeleton.bones.length;
          const boneMatrices = skeleton.boneMatrices;
          this._dotSkinT.copy(bindPos).applyMatrix4(mesh.bindMatrix);
          this._dotSkinAcc.set(0, 0, 0);
          this._dotSkinIndexVec.fromBufferAttribute(skinIndex, vertexIndex);
          this._dotSkinWeightVec.fromBufferAttribute(skinWeight, vertexIndex);

          for (let j = 0; j < 4; j++) {
            const weight = this._dotSkinWeightVec.getComponent(j);
            if (weight === 0) continue;
            const boneIdx = this._dotSkinIndexVec.getComponent(j) | 0;
            if (boneIdx < 0 || boneIdx >= boneCount) continue;
            this._dotSkinMatrix.fromArray(boneMatrices, boneIdx * 16);
            this._dotSkinAcc.addScaledVector(
              bindPos.copy(this._dotSkinT).applyMatrix4(this._dotSkinMatrix),
              weight
            );
          }

          target.copy(this._dotSkinAcc).applyMatrix4(mesh.bindMatrixInverse);

          if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
            target.fromBufferAttribute(srcPos, vertexIndex);
          }
          return target;
        },

        _sampleBodyMomentumWorld: function() {
          const out = this._dotBodyMomVec;
          out.set(0, 0, 0);
          const minSpeed = this._dotBodyMoveThreshold;

          if (this._isZeroGMode()) {
            const zc = this.rig?.components?.['zerog-locomotion'];
            const thrusterVel = zc?.getVelocity?.();
            if (thrusterVel && thrusterVel.lengthSq() > minSpeed * minSpeed) {
              out.copy(thrusterVel);
              return out;
            }
            if (this.headVelocity.lengthSq() > minSpeed * minSpeed) {
              out.copy(this.headVelocity);
              return out;
            }
            return out;
          }

          const legIkWorld = this.el.sceneEl.legIkWorld;
          const intentDir = legIkWorld?.playerMoveDir;
          const physicsSpeed = legIkWorld?.playerSpeed || 0;
          if (intentDir && intentDir.lengthSq() > 0.0001 && physicsSpeed > minSpeed) {
            out.set(intentDir.x * physicsSpeed, 0, intentDir.z * physicsSpeed);
            return out;
          }

          const legIk = this.el.sceneEl.components['leg-ik-world'];
          const intentVel = legIk?._playerMov;
          if (intentVel && intentVel.lengthSq() > minSpeed * minSpeed) {
            out.set(intentVel.x, 0, intentVel.z);
            return out;
          }

          const moveDir = this._rawMoveDir;
          const speed = this._smoothedHorizontalSpeed || this.horizontalSpeed || 0;
          if (moveDir.lengthSq() > 0.0001 && speed > minSpeed) {
            out.set(moveDir.x * speed, 0, moveDir.z * speed);
            return out;
          }

          const headSpeed = Math.hypot(this.headVelocity.x, this.headVelocity.z);
          if (headSpeed > minSpeed) {
            out.set(this.headVelocity.x, 0, this.headVelocity.z);
          }
          return out;
        },

        _updateDotBoneVelocityScratch: function(dt) {
          if (!this.skeleton) return;
          const bones = this.skeleton.bones;
          const n = bones.length;
          if (!this._dotBonePrevWorld || this._dotBonePrevWorld.length !== n) {
            this._dotBonePrevWorld = new Array(n);
            this._dotBoneVelWorld = new Float32Array(n * 3);
            for (let i = 0; i < n; i++) {
              this._dotBonePrevWorld[i] = new THREE.Vector3();
            }
            if (this.model) this.model.updateMatrixWorld(true);
            this.skeleton.update();
            for (let i = 0; i < n; i++) {
              bones[i].getWorldPosition(this._dotBonePrevWorld[i]);
            }
            return;
          }

          const invDt = 1 / Math.max(dt, 0.001);
          const vel = this._dotBoneVelWorld;
          const tmp = this._dotSkinT;
          if (this.model) this.model.updateMatrixWorld(true);
          this.skeleton.update();
          for (let i = 0; i < n; i++) {
            bones[i].getWorldPosition(tmp);
            const prev = this._dotBonePrevWorld[i];
            const b = i * 3;
            vel[b] = (tmp.x - prev.x) * invDt;
            vel[b + 1] = (tmp.y - prev.y) * invDt;
            vel[b + 2] = (tmp.z - prev.z) * invDt;
            prev.copy(tmp);
          }
        },

        _sampleParticleMomentumWorld: function(mesh, vertexIndex, bodyMom, dest) {
          const skeleton = mesh.skeleton;
          const boneVel = this._dotBoneVelWorld;
          if (!skeleton || !boneVel || boneVel.length < skeleton.bones.length * 3) {
            return dest.copy(bodyMom);
          }

          const skinIndex = mesh.geometry.attributes.skinIndex;
          const skinWeight = mesh.geometry.attributes.skinWeight;
          if (!skinIndex || !skinWeight) {
            return dest.copy(bodyMom);
          }

          this._dotSkinIndexVec.fromBufferAttribute(skinIndex, vertexIndex);
          this._dotSkinWeightVec.fromBufferAttribute(skinWeight, vertexIndex);
          dest.set(0, 0, 0);
          let wSum = 0;
          for (let j = 0; j < 4; j++) {
            const w = this._dotSkinWeightVec.getComponent(j);
            if (w === 0) continue;
            const boneIdx = this._dotSkinIndexVec.getComponent(j) | 0;
            if (boneIdx < 0 || boneIdx >= skeleton.bones.length) continue;
            const b = boneIdx * 3;
            dest.x += boneVel[b] * w;
            dest.y += boneVel[b + 1] * w;
            dest.z += boneVel[b + 2] * w;
            wSum += w;
          }

          if (wSum > 0) {
            dest.multiplyScalar(1 / wSum);
          } else {
            dest.copy(bodyMom);
          }

          const minSpeed = this._dotBodyMoveThreshold;
          const boneSpeedSq = dest.lengthSq();
          const bodySpeedSq = bodyMom.lengthSq();
          if (boneSpeedSq < minSpeed * minSpeed && bodySpeedSq > minSpeed * minSpeed) {
            dest.copy(bodyMom);
          } else if (boneSpeedSq > minSpeed * minSpeed && bodySpeedSq > minSpeed * minSpeed) {
            dest.add(bodyMom).multiplyScalar(0.5);
          }
          return dest;
        },

        _captureDotAnchors: function() {
          if (!this._dotParticleSources || !this._dotNormals) return;

          const sources = this._dotParticleSources;
          const norms = this._dotNormals;
          const bind = this._dotBindLocal;
          if (this.model) this.model.updateMatrixWorld(true);
          for (let m = 0; m < sources.length; m++) {
            const mesh = sources[m].mesh;
            mesh.updateMatrixWorld(true);
            if (mesh.skeleton) mesh.skeleton.update();
          }

          const n = sources.length;
          if (!this._dotAnchorWorld || this._dotAnchorWorld.length !== n * 3) {
            this._dotAnchorWorld = new Float32Array(n * 3);
            this._dotNormalWorld = new Float32Array(n * 3);
          }
          if (!this._dotVelocityWorld || this._dotVelocityWorld.length !== n * 3) {
            this._dotVelocityWorld = new Float32Array(n * 3);
          }

          const bodyMom = this._sampleBodyMomentumWorld();
          const vel = this._dotVelocityWorld;
          const particleVel = this._dotParticleVelTmp;

          const v = this._dotSkinT;
          const nl = this._dotNormalTmp;
          for (let i = 0; i < n; i++) {
            const src = sources[i];
            const mesh = src.mesh;
            this._computeSkinnedVertex(mesh, src.vi, v);
            const b = i * 3;
            if (!Number.isFinite(v.x)) {
              v.set(bind[b], bind[b + 1], bind[b + 2]);
            }
            v.applyMatrix4(mesh.matrixWorld);
            this._dotAnchorWorld[b] = v.x;
            this._dotAnchorWorld[b + 1] = v.y;
            this._dotAnchorWorld[b + 2] = v.z;

            nl.set(norms[b], norms[b + 1], norms[b + 2]);
            nl.transformDirection(mesh.matrixWorld).normalize();
            this._dotNormalWorld[b] = nl.x;
            this._dotNormalWorld[b + 1] = nl.y;
            this._dotNormalWorld[b + 2] = nl.z;

            this._sampleParticleMomentumWorld(mesh, src.vi, bodyMom, particleVel);
            vel[b] = particleVel.x;
            vel[b + 1] = particleVel.y;
            vel[b + 2] = particleVel.z;
          }

          this._initDotModelMaterials();
        },

        _updateDotDisintegrationPositions: function(effectTime) {
          if (!this._dotPoints || !this._dotAnchorWorld || !this._dotNormalWorld || !this._dotVelocityWorld
            || !this._dotParticleSources || !this.model) return;

          const total = this._dotFadeInDuration + this._dotFadeOutDuration;
          const progress = Math.min(1, Math.max(0, effectTime / total));
          const travel = this._dotTravelM * progress;
          const momFalloff = 1 - this._dotMomentumDrag * progress;
          const momTravel = this._dotMomentumCarryS * progress * momFalloff;
          const outAttr = this._dotPoints.geometry.attributes.position;
          const arr = outAttr.array;
          const anchors = this._dotAnchorWorld;
          const norms = this._dotNormalWorld;
          const vel = this._dotVelocityWorld;
          const worldPos = this._dotWorldPos;
          this.model.updateMatrixWorld(true);
          const invModel = this._dotSkinMatrix.copy(this.model.matrixWorld).invert();

          for (let i = 0; i < this._dotParticleSources.length; i++) {
            const b = i * 3;
            worldPos.set(
              anchors[b] + norms[b] * travel + vel[b] * momTravel,
              anchors[b + 1] + norms[b + 1] * travel + vel[b + 1] * momTravel,
              anchors[b + 2] + norms[b + 2] * travel + vel[b + 2] * momTravel
            );
            worldPos.applyMatrix4(invModel);
            arr[b] = worldPos.x;
            arr[b + 1] = worldPos.y;
            arr[b + 2] = worldPos.z;
          }
          outAttr.needsUpdate = true;
        },

        _setCharacterModelVisible: function(visible) {
          if (!this.model) return;
          if (!this._dotHiddenMeshes) {
            this._dotHiddenMeshes = [];
            this.model.traverse((node) => {
              if (node.isSkinnedMesh || node.isMesh) {
                this._dotHiddenMeshes.push(node);
              }
            });
          }
          for (let i = 0; i < this._dotHiddenMeshes.length; i++) {
            this._dotHiddenMeshes[i].visible = visible;
          }
        },

        _isDotEffectTriggerPressed: function() {
          // CapVR: body-dot dissolve is a lab demo — never arm it (F or Quest A).
          if (window.CapVRGame || document.querySelector('[zerog-player]')) return false;
          const keys = window._bodyRiggedKeys || {};
          if (keys.KeyF) return true;
          return this._isRightAButtonPressed();
        },

        _captureFrozenPoseForDotEffect: function(state) {
          if (this.data.isMirror || !this.skeleton || !this.model) return;

          const bones = {};
          for (let i = 0; i < this.skeleton.bones.length; i++) {
            const bone = this.skeleton.bones[i];
            const useRestHeadPos = bone === this.bones.head || bone === this.bones.headTop;
            bones[bone.name] = {
              q: bone.quaternion.clone(),
              p: useRestHeadPos && this.initialBonePositions[bone.name]
                ? this.initialBonePositions[bone.name].clone()
                : bone.position.clone(),
              s: bone.scale.clone()
            };
          }

          state.frozenPoseSnapshot = {
            modelY: this.model.position.y,
            modelScaleY: this.model.scale.y,
            headFacingQuat: this._headFacingQuat.clone(),
            torsoRotation: this.torsoRotation.clone(),
            entityWorldPos: new THREE.Vector3(),
            entityWorldQuat: new THREE.Quaternion(),
            bones: bones
          };
          this.el.object3D.getWorldPosition(state.frozenPoseSnapshot.entityWorldPos);
          this.el.object3D.getWorldQuaternion(state.frozenPoseSnapshot.entityWorldQuat);
        },

        _applyFrozenPoseSnapshot: function(snap) {
          if (!snap || !this.skeleton || !this.model) return;

          this.torsoRotation.copy(snap.torsoRotation);
          this._headFacingQuat.copy(snap.headFacingQuat);

          if (this.data.isMirror) {
            const mirrorPos = snap.entityWorldPos.clone().add(new THREE.Vector3(0, 0, -this.mirrorDistance));
            const facing = snap.entityWorldQuat.clone();

            if (this.manualRotationY !== 0) {
              const headWorldPos = new THREE.Vector3();
              this.camera.object3D.getWorldPosition(headWorldPos);
              const mirrorCenter = new THREE.Vector3(
                headWorldPos.x,
                headWorldPos.y - 0.3,
                headWorldPos.z - this.mirrorDistance
              );
              const rot = new THREE.Matrix4().makeRotationY(this.manualRotationY);
              mirrorPos.sub(mirrorCenter).applyMatrix4(rot).add(mirrorCenter);
              const manualQuat = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0),
                this.manualRotationY
              );
              facing.premultiply(manualQuat);
            }

            this.el.object3D.position.copy(mirrorPos);
            this.el.object3D.quaternion.copy(facing);
          }

          this.model.position.y = snap.modelY;
          this.model.scale.set(1, snap.modelScaleY, 1);

          for (let i = 0; i < this.skeleton.bones.length; i++) {
            const bone = this.skeleton.bones[i];
            const src = snap.bones[bone.name];
            if (!src) continue;
            bone.quaternion.copy(src.q);
            bone.position.copy(src.p);
            if (bone === this.bones.head || bone === this.bones.headTop) {
              bone.scale.set(1, 1, 1);
            } else {
              bone.scale.copy(src.s);
            }
          }
          this.skeleton.update();
        },

        _freezePlayerForDotEffect: function(state) {
          state.frozen = true;
          const rig = this.rig || document.getElementById('rig');
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          const ragdollActive = !!(legIk?.ragdollActive || this.el.sceneEl.legIkWorld?.ragdollActive);

          if (legIk) {
            if (legIk._playerMov) legIk._playerMov.set(0, 0, 0);
            if (legIk._grabMomentum) {
              legIk._grabMomentum.set(0, 0, 0);
              legIk._grabMomentumActive = false;
            }
            if (legIk._playerMoveDir) legIk._playerMoveDir.set(0, 0, 0);
            legIk.playerVelY = 0;
            legIk.grabPullLocomotionActive = false;
          }

          // While ragdolling the player capsule is disabled â€” its translation is the
          // stale spawn point, not where the rig/camera actually are. Anchor freeze
          // to the live rig or F will teleport the headset.
          if (ragdollActive && rig) {
            state.frozenPos = {
              x: rig.object3D.position.x,
              y: rig.object3D.position.y,
              z: rig.object3D.position.z
            };
          } else if (legIk?.ready && legIk.physics) {
            const p = legIk.physics.getPlayerTranslation();
            state.frozenPos = { x: p.x, y: p.y, z: p.z };
          }

          if (!state.frozenPos && rig) {
            state.frozenPos = {
              x: rig.object3D.position.x,
              y: rig.object3D.position.y,
              z: rig.object3D.position.z
            };
          }

          this._captureFrozenPoseForDotEffect(state);
          if (state.frozenPoseSnapshot) {
            this._applyFrozenPoseSnapshot(state.frozenPoseSnapshot);
          }
        },

        _unfreezePlayerForDotEffect: function(state) {
          state.frozen = false;
          state.frozenPos = null;
          state.frozenPoseSnapshot = null;
        },

        _updateBodyDotEffect: function(dt) {
          if (!this._dotPoints || !this._dotMaterial) return;

          const state = this._getBodyDotEffectState();

          if (!this.data.isMirror) {
            const pressed = this._isDotEffectTriggerPressed();
            if (pressed && !state.triggerWasPressed) {
              state.time = 0;
              state.captureGen = (state.captureGen || 0) + 1;
              this._freezePlayerForDotEffect(state);
              console.log('[Mixamo Body] dot disintegration triggered');
            }
            state.triggerWasPressed = pressed;
            if (state.time >= 0) {
              state.time += dt;
            }
          }

          if (state.time < 0) {
            this._dotMaterial.opacity = 0;
            this._dotPoints.visible = false;
            this._resetCharacterDissolve();
            this._unfreezePlayerForDotEffect(state);
            return;
          }

          if (this._dotAnchorGen !== state.captureGen) {
            this._captureDotAnchors();
            this._dotAnchorGen = state.captureGen;
          }
          this._updateDotDisintegrationPositions(state.time);
          this._updateCharacterDissolve(state.time);

          const fadeIn = this._dotFadeInDuration;
          const fadeOut = this._dotFadeOutDuration;
          const total = fadeIn + fadeOut;
          let opacity;

          if (state.time <= fadeIn) {
            opacity = state.time / fadeIn;
          } else if (state.time <= total) {
            opacity = 1 - (state.time - fadeIn) / fadeOut;
          } else {
            opacity = 0;
            state.time = -1;
            this._unfreezePlayerForDotEffect(state);
          }

          const globalT = Math.max(0, Math.min(1, state.time / total));
          opacity *= 1 - this._easeOutCubic(globalT) * 0.35;

          opacity = Math.max(0, Math.min(1, opacity));
          this._dotMaterial.opacity = opacity;
          this._dotMaterial.size = (this.isGltf ? this._dotBaseSize : this._dotBaseSize * 100)
            * (1 - globalT * 0.55);
          this._dotMaterial.needsUpdate = true;
          this._dotPoints.visible = opacity > 0.001;
        },

        tick: function(time, deltaTime) {
          if (!this.modelLoaded || !this.skeleton) return;
          if (!this.leftController || !this.rightController || !this.camera) {
            this._resolveControllers();
          }
          if (!this.camera || !this.leftController || !this.rightController) return;
          
          const dt = Math.min(deltaTime / 1000, 0.1);
          this._updateDotBoneVelocityScratch(dt);
          const dotState = this._getBodyDotEffectState();
          const poseFrozen = dotState.frozen && dotState.frozenPoseSnapshot;
          const ragdollActive = !!this.el.sceneEl.legIkWorld?.ragdollActive;

          if (ragdollActive) {
            const legIkWorld = this.el.sceneEl.legIkWorld;
            if (this.model) this.model.visible = true;
            if (poseFrozen) {
              this._applyFrozenPoseSnapshot(dotState.frozenPoseSnapshot);
              if (!this.data.isMirror) {
                this._publishPoseSnapshot();
              }
            } else if (
              legIkWorld?.ragdollHuman &&
              legIkWorld.b3 &&
              legIkWorld.ragdollRetargetState &&
              window.Box3DRagdollRetarget
            ) {
              if (!this.data.isMirror) {
                window.Box3DRagdollRetarget.apply(
                  this,
                  legIkWorld.b3,
                  legIkWorld.ragdollHuman,
                  legIkWorld.ragdollRetargetState
                );
                this._publishPoseSnapshot();
              } else {
                this.syncPoseFromLocal();
              }
            }
            this._updateBodyDotEffect(dt);
            return;
          }
          
          // Headset yaw in rig-local frame (parent rig owns snap-turn).
          if (this.useAnimatedLocomotion && this.camera && !this.data.isMirror && !poseFrozen) {
            const headQuat = new THREE.Quaternion();
            if (this._isLocalRigChild()) {
              headQuat.copy(this.camera.object3D.quaternion);
            } else {
              this.camera.object3D.getWorldQuaternion(headQuat);
            }
            this._updateHeadFacing(headQuat, dt);
          }
          
          // Update breathing animation phase
          if (!poseFrozen) {
            this.breathingPhase += dt * this.breathingRate * Math.PI * 2;
            if (this.breathingPhase > Math.PI * 2) {
              this.breathingPhase -= Math.PI * 2;
            }
          }
          
          this._updateHorizontalSpeed(dt);
          
          if (this.data.isMirror) {
            if (poseFrozen) {
              this._applyFrozenPoseSnapshot(dotState.frozenPoseSnapshot);
            } else {
              this.syncPoseFromLocal();
            }
            this._updateBodyDotEffect(dt);
          } else {
            if (poseFrozen) {
              this._applyFrozenPoseSnapshot(dotState.frozenPoseSnapshot);
            } else {
              this.updateLocalBody(dt);
              this.updateFingerPoses(dt);
            }
            this._updateBodyDotEffect(dt);
            if (!poseFrozen) {
              this._publishPoseSnapshot();
            }
          }
        },

        tock: function (time, deltaTime) {
          if (this.data.isMirror || !this.modelLoaded || !this.skeleton) return;
          if (!this.leftController || !this.rightController) return;

          // Grab-dummy tock may attach mid-frame; re-solve arms so weight-limited
          // wrist targets apply the same frame as the new hold.
          const comp = document.querySelector('#grab-dummy')?.components['grabbable-ragdoll'];
          const hold = comp?.getPlayerArmHold?.();
          const ragHoldActive = !!(hold?.left?.active || hold?.right?.active);

          if (ragHoldActive && !this.el.sceneEl.legIkWorld?.ragdollActive) {
            const dt = Math.min(deltaTime / 1000, 0.1);
            const leftHandWorldPos = new THREE.Vector3();
            const rightHandWorldPos = new THREE.Vector3();
            const leftHandWorldQuat = new THREE.Quaternion();
            const rightHandWorldQuat = new THREE.Quaternion();
            this.leftController.object3D.getWorldPosition(leftHandWorldPos);
            this.rightController.object3D.getWorldPosition(rightHandWorldPos);
            this.leftController.object3D.getWorldQuaternion(leftHandWorldQuat);
            this.rightController.object3D.getWorldQuaternion(rightHandWorldQuat);
            this._applyRagdollDummyArmHold(leftHandWorldPos, rightHandWorldPos);
            if (hold.left?.active) {
              this.solveArmIK('left', leftHandWorldPos, leftHandWorldQuat, { dt });
            }
            if (hold.right?.active) {
              this.solveArmIK('right', rightHandWorldPos, rightHandWorldQuat, { dt });
            }
            if (this.skeleton) this.skeleton.update();
            if (this.model) this.model.updateMatrixWorld(true);
          }

          // After grabbable-ragdoll tock â€” palm spheres + ragdoll projection rays.
          this._refreshHandCollisionDebugAfterRagdoll();
        },
        
        _updateHorizontalSpeed: function(dt) {
          if (this.data.isMirror) {
            const shared = this.el.sceneEl._bodyLocomotionState;
            if (!shared) return;
            this.horizontalSpeed = shared.horizontalSpeed;
            this._smoothedHorizontalSpeed = shared.smoothedHorizontalSpeed;
            this._rawMoveDir.copy(shared.rawMoveDir);
            this.lateralSpeed = shared.lateralSpeed;
            this.forwardSpeed = shared.forwardSpeed;
            this.headVelocity.copy(shared.headVelocity);
            return;
          }
          
          const legIkWorld = this.el.sceneEl.legIkWorld;
          const invDt = 1 / Math.max(dt, 0.001);
          const locomotionSuppressed = this._isLocomotionSuppressed();
          
          // Head world velocity = thumbstick rig motion + room-scale physical walking.
          const headPos = new THREE.Vector3();
          this.camera.object3D.getWorldPosition(headPos);
          if (this.previousHeadPosInitialized) {
            this.headVelocity.copy(headPos).sub(this.previousHeadPos).multiplyScalar(invDt);
          } else {
            this.previousHeadPosInitialized = true;
            this.headVelocity.set(0, 0, 0);
          }
          this.previousHeadPos.copy(headPos);
          
          if (locomotionSuppressed) {
            if (legIkWorld) {
              legIkWorld.playerSpeed = 0;
              if (legIkWorld.playerMoveDir) {
                legIkWorld.playerMoveDir.set(0, 0, 0);
              }
            }
            this.horizontalSpeed = 0;
            this._smoothedHorizontalSpeed = THREE.MathUtils.lerp(
              this._smoothedHorizontalSpeed,
              0,
              Math.min(1, dt * 24)
            );
            this._rawMoveDir.set(0, 0, 0);
            this.lateralSpeed = 0;
            this.forwardSpeed = 0;
          } else {
            const vrLoco = this.rig?.components?.['vr-locomotion'];
            const stick = vrLoco?.thumbstickMove?.left;
            const stickMag = Math.hypot(stick?.x || 0, stick?.y || 0);
            const rotatingInPlace = Math.abs(vrLoco?._lastYawDelta || 0) > 0.0005 && stickMag < 0.04;

            let headHorizontalSpeed = Math.hypot(this.headVelocity.x, this.headVelocity.z);
            if (rotatingInPlace) headHorizontalSpeed = 0;

            const physicsSpeed = legIkWorld?.playerSpeed || 0;
            const intentDir = legIkWorld?.playerMoveDir;
            const hasMoveIntent = intentDir && intentDir.lengthSq() > 0.0001 && physicsSpeed > 0.04;

            // Prefer physics intent when stick is active â€” head tangential vel from snap-turn is not walk speed.
            if (stickMag > 0.04 || hasMoveIntent) {
              this.horizontalSpeed = physicsSpeed;
            } else if (headHorizontalSpeed > 0.08) {
              this.horizontalSpeed = headHorizontalSpeed;
            } else {
              this.horizontalSpeed = 0;
            }

            this._smoothedHorizontalSpeed = THREE.MathUtils.lerp(
              this._smoothedHorizontalSpeed,
              this.horizontalSpeed,
              Math.min(1, dt * 10)
            );

            const yawQuat = this._isLocalRigChild()
              ? this._getWorldLocomotionYawQuat()
              : this._getYawQuat();
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(yawQuat);
            const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(yawQuat);

            if (hasMoveIntent) {
              this._rawMoveDir.copy(intentDir);
              this.lateralSpeed = Math.abs(intentDir.dot(right)) * physicsSpeed;
              this.forwardSpeed = Math.abs(intentDir.dot(fwd)) * physicsSpeed;
            } else if (headHorizontalSpeed > 0.08) {
              this._rawMoveDir.set(this.headVelocity.x, 0, this.headVelocity.z).normalize();
              this.lateralSpeed = Math.abs(this.headVelocity.x * right.x + this.headVelocity.z * right.z);
              this.forwardSpeed = Math.abs(this.headVelocity.x * fwd.x + this.headVelocity.z * fwd.z);
            } else {
              this._rawMoveDir.set(0, 0, 0);
              this.lateralSpeed = 0;
              this.forwardSpeed = 0;
            }
          }
          
          this.el.sceneEl._bodyLocomotionState = {
            horizontalSpeed: this.horizontalSpeed,
            smoothedHorizontalSpeed: this._smoothedHorizontalSpeed,
            rawMoveDir: this._rawMoveDir.clone(),
            lateralSpeed: this.lateralSpeed,
            forwardSpeed: this.forwardSpeed,
            headVelocity: this.headVelocity.clone()
          };
        },
        
        updateFingerPoses: function(dt) {
          dt = Math.max(0.001, Math.min(dt || 0.016, 0.1));
          // Get gamepad data
          const leftGamepad = this.leftController.components['tracked-controls']?.controller?.gamepad;
          const rightGamepad = this.rightController.components['tracked-controls']?.controller?.gamepad;
          
          if (!this.fingerDebugLogged) {
            console.log('[Finger Tracking] Left gamepad buttons:', leftGamepad?.buttons?.length);
            if (leftGamepad && leftGamepad.buttons) {
              console.log('[Finger Tracking] Button details:');
              leftGamepad.buttons.forEach((btn, i) => {
                if (btn.touched || btn.pressed) {
                  console.log(`  Button ${i}: pressed=${btn.pressed}, touched=${btn.touched}, value=${btn.value}`);
                }
              });
              console.log('[Finger Tracking] Touch any button/surface and check console to see which index it is');
            }
            this.fingerDebugLogged = true;
          }
          
          // Update target curls for LEFT hand (skip grip-driven fist during surface grab)
          const leftSurfaceGrab =
            this._grabAnchorActiveLeft && this._grabSurfaceContactLeft;
          if (leftGamepad && leftGamepad.buttons && !leftSurfaceGrab) {
            const trigger = leftGamepad.buttons[0]?.value || 0; // Trigger - index finger
            const grip = leftGamepad.buttons[1]?.value || 0;    // Grip - middle/ring/pinky
            
            // Thumb curls when touching ANY touch-sensitive surface:
            // Button 2: Often grip button or touchpad
            // Button 3: Thumbstick
            // Button 4: A/X button (face button lower)
            // Button 5: B/Y button (face button upper)
            // Button 6: Sometimes touchpad or additional surface
            let anyThumbTouch = 0;
            for (let i = 2; i <= 6; i++) {
              if (leftGamepad.buttons[i]?.touched) {
                anyThumbTouch = 1;
                break;
              }
            }
            
            this.updateTargetCurls('left', trigger, grip, anyThumbTouch);
          }
          
          // Update target curls for RIGHT hand (skip grip-driven fist during surface grab)
          const rightSurfaceGrab =
            this._grabAnchorActiveRight && this._grabSurfaceContactRight;
          if (rightGamepad && rightGamepad.buttons && !rightSurfaceGrab) {
            const trigger = rightGamepad.buttons[0]?.value || 0;
            const grip = rightGamepad.buttons[1]?.value || 0;
            
            let anyThumbTouch = 0;
            for (let i = 2; i <= 6; i++) {
              if (rightGamepad.buttons[i]?.touched) {
                anyThumbTouch = 1;
                break;
              }
            }
            
            this.updateTargetCurls('right', trigger, grip, anyThumbTouch);
          }
          
          ['left', 'right'].forEach((hand) => {
            this._applyGrabSurfaceFingerTargets(hand);
          });

          // Per-finger surface raycasts update target curls before smoothing â€”
          // but only while a surface grab is still settling. Once frozen, the
          // conformed finger pose is held constant until release.
          ['left', 'right'].forEach((hand) => {
            const frozen = hand === 'left' ? this._grabFingersFrozenLeft : this._grabFingersFrozenRight;
            const store = hand === 'left' ? this._grabFrozenCurlsLeft : this._grabFrozenCurlsRight;
            if (frozen && store) {
              ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach((f) => {
                this.targetCurls[hand][f] = store[f];
              });
              return;
            }
            this._adaptFingersToSurfaceRaycast(hand, dt);
          });

          // Smooth exponential blend toward target curls (no snapping)
          ['left', 'right'].forEach(hand => {
            const surfaceGrab =
              (hand === 'left' && this._grabAnchorActiveLeft && this._grabSurfaceContactLeft) ||
              (hand === 'right' && this._grabAnchorActiveRight && this._grabSurfaceContactRight);
            const frozen = hand === 'left' ? this._grabFingersFrozenLeft : this._grabFingersFrozenRight;
            const store = hand === 'left' ? this._grabFrozenCurlsLeft : this._grabFrozenCurlsRight;
            if (frozen && store) {
              ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach((finger) => {
                this.currentCurls[hand][finger] = store[finger];
              });
              return;
            }
            const alpha = 1 - Math.exp(-dt * (surfaceGrab ? 12 : this.fingerCurlSmoothRate));
            ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach(finger => {
              const current = this.currentCurls[hand][finger];
              const target = this.targetCurls[hand][finger];
              this.currentCurls[hand][finger] = current + (target - current) * alpha;
            });
          });

          this.applyFingerCurls('left', this.currentCurls.left);
          this.applyFingerCurls('right', this.currentCurls.right);

          ['left', 'right'].forEach((hand) => {
            const frozen = hand === 'left' ? this._grabFingersFrozenLeft : this._grabFingersFrozenRight;
            if (frozen) return; // frozen fingers must not be nudged
            if (this._applySoftFingerPenetrationFix(hand, dt)) {
              this.applyFingerCurls(hand, this.currentCurls[hand]);
            }
          });

          // Capture the conformed finger pose once the grab has settled, then
          // hold it. The hand is already frozen in world space, so the fingers
          // converge on a stable surface within the settle window.
          ['left', 'right'].forEach((hand) => {
            const wristLocked = hand === 'left' ? this._grabWristLockLeft : this._grabWristLockRight;
            const surfaceGrab =
              (hand === 'left' && this._grabAnchorActiveLeft && this._grabSurfaceContactLeft) ||
              (hand === 'right' && this._grabAnchorActiveRight && this._grabSurfaceContactRight);
            const frozen = hand === 'left' ? this._grabFingersFrozenLeft : this._grabFingersFrozenRight;
            if (!surfaceGrab || !wristLocked || frozen) return;
            const t = (hand === 'left'
              ? (this._grabFingerSettleLeft += dt)
              : (this._grabFingerSettleRight += dt));
            if (t >= 0.3) {
              const store = {};
              ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach((f) => {
                store[f] = this.currentCurls[hand][f];
              });
              if (hand === 'left') {
                this._grabFrozenCurlsLeft = store;
                this._grabFingersFrozenLeft = true;
              } else {
                this._grabFrozenCurlsRight = store;
                this._grabFingersFrozenRight = true;
              }
            }
          });
        },

        _resolveFingerCollisions: function (hand, hardPass) {
          if (this.data.isMirror) return;
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (!legIk || !legIk.clampFingerTips || !this.model) return;

          const grabbing = hand === 'left' ? this._grabAnchorActiveLeft : this._grabAnchorActiveRight;
          const surfaceGrab = hand === 'left' ? this._grabSurfaceContactLeft : this._grabSurfaceContactRight;

          const prefix = hand === 'left' ? 'left' : 'right';
          const fingerNames = ['thumb', 'index', 'middle', 'ring', 'pinky'];
          const distalMap = {
            thumb: this.bones[`${prefix}HandThumb3`],
            index: this.bones[`${prefix}HandIndex3`],
            middle: this.bones[`${prefix}HandMiddle3`],
            ring: this.bones[`${prefix}HandRing3`],
            pinky: this.bones[`${prefix}HandPinky3`]
          };

          if (!this._fingerTipState) this._fingerTipState = { left: {}, right: {} };
          const state = this._fingerTipState[hand];
          const radius = legIk.fingerCollisionRadius || 0.012;
          const tmp = new THREE.Vector3();
          const maxIter = hardPass ? 12 : (grabbing && surfaceGrab ? 8 : 6);
          const curls = this.currentCurls[hand];

          for (let iter = 0; iter < maxIter; iter++) {
            this.model.updateMatrixWorld(true);
            if (this.skeleton) this.skeleton.update();

            const tips = [];
            fingerNames.forEach((name) => {
              const bone = distalMap[name];
              if (!bone) return;
              this._getFingerTipWorldPos(hand, name, tmp);
              const prev = state[name] || {};
              tips.push({
                name,
                bone,
                desired: tmp.clone(),
                lastValid: prev.lastValid || null,
                lastTrack: prev.lastTrack || null,
                tracking: tmp.clone(),
                radius
              });
            });
            if (!tips.length) return;

            const result = legIk.clampFingerTips(tips);
            let blocked = false;

            result.tips.forEach((clamped, i) => {
              const entry = tips[i];
              if (!entry) return;
              const penetration = entry.desired.distanceTo(clamped);
              state[entry.name] = {
                lastValid: clamped.clone(),
                lastTrack: entry.tracking.clone()
              };
              if (penetration > 0.001) {
                blocked = true;
                const reduce = THREE.MathUtils.clamp(penetration / (surfaceGrab ? 0.05 : 0.035), 0.1, 0.45);
                curls[entry.name] = Math.max(surfaceGrab ? -0.08 : 0, (curls[entry.name] || 0) - reduce);
              }
            });

            if (!blocked) break;
            this.applyFingerCurls(hand, curls);
          }

          if (hardPass && legIk.physics && legIk.physics.resolveSphere) {
            this.model.updateMatrixWorld(true);
            if (this.skeleton) this.skeleton.update();
            fingerNames.forEach((name) => {
              const bone = distalMap[name];
              if (!bone) return;
              this._getFingerTipWorldPos(hand, name, tmp);
              const resolved = legIk.physics.resolveSphere(tmp, radius);
              if (resolved.hit && resolved.position.distanceTo(tmp) > 0.0002) {
                curls[name] = Math.max(surfaceGrab ? -0.08 : 0, (curls[name] || 0) - 0.12);
                this.applyFingerCurls(hand, curls);
              }
            });
          }
        },
        
        updateTargetCurls: function(hand, trigger, grip, thumbTouch) {
          // Natural resting pose: fingers have slight curl (0.15-0.25)
          // This makes the hand look relaxed rather than stiff/straight
          const restingCurls = {
            thumb: 0.1,    // Thumb slightly relaxed
            index: 0.15,   // Index finger slightly curved
            middle: 0.2,   // Middle finger more curved
            ring: 0.25,    // Ring finger even more curved
            pinky: 0.25    // Pinky most curved (natural hand pose)
          };
          
          // Calculate active curl values
          const activeCurls = {
            thumb: thumbTouch * 0.8,  // Thumb curls when touching buttons
            index: trigger,            // Index follows trigger only
            middle: grip * 1.1,        // Middle curls slightly more than input
            ring: grip * 1.15,         // Ring curls more (natural grip)
            pinky: grip * 1.2          // Pinky curls most (anatomically correct)
          };
          
          // When gripping without trigger, keep index straighter
          // This prevents index from curling too much when only grip is pressed
          if (grip > 0.1 && trigger < 0.1) {
            activeCurls.index = 0; // Index stays straight when gripping without trigger
          }
          
          // Combine resting pose with active input (use the greater value)
          const curls = {
            thumb: Math.max(restingCurls.thumb, activeCurls.thumb),
            index: Math.max(restingCurls.index, activeCurls.index),
            middle: Math.max(restingCurls.middle, activeCurls.middle),
            ring: Math.max(restingCurls.ring, activeCurls.ring),
            pinky: Math.max(restingCurls.pinky, activeCurls.pinky)
          };
          
          // Override index finger when gripping without trigger - make it straighter than resting
          if (grip > 0.1 && trigger < 0.1) {
            curls.index = 0.05; // Very slight curl, straighter than resting pose
          };
          
          // Special case: "Thumbs up" gesture when grip is pressed but thumb is not on buttons
          if (grip > 0.5 && thumbTouch < 0.5) {
            curls.thumb = -0.15; // Extend thumb upward slightly (overrides resting pose, more natural)
          }
          
          this.targetCurls[hand] = curls;
        },
        
        applyFingerCurls: function(hand, curls) {
          // Apply curl values to finger bones
          const fingerBones = {
            thumb: hand === 'left' ? [this.bones.leftHandThumb1, this.bones.leftHandThumb2, this.bones.leftHandThumb3] : 
                                     [this.bones.rightHandThumb1, this.bones.rightHandThumb2, this.bones.rightHandThumb3],
            index: hand === 'left' ? [this.bones.leftHandIndex1, this.bones.leftHandIndex2, this.bones.leftHandIndex3] :
                                     [this.bones.rightHandIndex1, this.bones.rightHandIndex2, this.bones.rightHandIndex3],
            middle: hand === 'left' ? [this.bones.leftHandMiddle1, this.bones.leftHandMiddle2, this.bones.leftHandMiddle3] :
                                      [this.bones.rightHandMiddle1, this.bones.rightHandMiddle2, this.bones.rightHandMiddle3],
            ring: hand === 'left' ? [this.bones.leftHandRing1, this.bones.leftHandRing2, this.bones.leftHandRing3] :
                                    [this.bones.rightHandRing1, this.bones.rightHandRing2, this.bones.rightHandRing3],
            pinky: hand === 'left' ? [this.bones.leftHandPinky1, this.bones.leftHandPinky2, this.bones.leftHandPinky3] :
                                     [this.bones.rightHandPinky1, this.bones.rightHandPinky2, this.bones.rightHandPinky3]
          };
          
          // Apply curls to finger bones
          Object.keys(fingerBones).forEach(fingerName => {
            const bones = fingerBones[fingerName];
            const curl = curls[fingerName];
            
            // Thumb uses different axis/sign than other fingers
            const isThumb = fingerName === 'thumb';
            const axis = isThumb ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
            // Left hand: fingers=1, thumb=-1
            // Right hand: fingers=1 (same as left), thumb=1
            const sign = isThumb ? (hand === 'left' ? -1 : 1) : 1;
            
            bones.forEach((bone, i) => {
              if (!bone) return;
              
              // Reset to T-pose first
              const initialRot = this.initialBoneRotations[bone.name];
              if (initialRot) {
                bone.quaternion.copy(initialRot);
              }
              
              // Apply curl rotation (more curl for distal bones)
              const curlAmount = curl * (0.5 + i * 0.25); // Progressive curl
              const curlAngle = curlAmount * Math.PI * 0.6 * sign; // curl angle
              
              const curlQuat = new THREE.Quaternion().setFromAxisAngle(axis, curlAngle);
              
              bone.quaternion.multiply(curlQuat);
            });
          });
        },
        
        applyFingerPose: function(hand, gesture) {
          // Gesture from hand-controls can be: 'fist', 'point', 'thumbUp', 'pistol', etc.
          // For now, let's get the actual finger curl values if available
          
          const handControls = hand === 'left' ? this.leftController.components['hand-controls'] : this.rightController.components['hand-controls'];
          
          // Check if hand tracking is available with finger data
          if (!handControls || !handControls.mesh || !handControls.mesh.userData) return;
          
          // Try to get XR hand data
          const xrHand = handControls.el.components['hand-tracking'];
          if (xrHand && xrHand.bones) {
            // Use actual hand tracking data
            this.applyXRHandTracking(hand, xrHand.bones);
          } else {
            // Fallback: Use gesture-based poses
            this.applyGesturePose(hand, gesture);
          }
        },
        
        applyXRHandTracking: function(hand, xrBones) {
          // Map XR hand bones directly to Mixamo finger bones
          // This would require mapping each XR joint to corresponding Mixamo bone
          // For now, we'll use the simpler gesture-based approach
        },
        
        applyGesturePose: function(hand, gesture) {
          // Apply finger rotations based on gesture
          // Mixamo finger bones curl on X-axis (local space)
          
          const fingerBones = {
            thumb: hand === 'left' ? [this.bones.leftHandThumb1, this.bones.leftHandThumb2, this.bones.leftHandThumb3] : 
                                     [this.bones.rightHandThumb1, this.bones.rightHandThumb2, this.bones.rightHandThumb3],
            index: hand === 'left' ? [this.bones.leftHandIndex1, this.bones.leftHandIndex2, this.bones.leftHandIndex3] :
                                     [this.bones.rightHandIndex1, this.bones.rightHandIndex2, this.bones.rightHandIndex3],
            middle: hand === 'left' ? [this.bones.leftHandMiddle1, this.bones.leftHandMiddle2, this.bones.leftHandMiddle3] :
                                      [this.bones.rightHandMiddle1, this.bones.rightHandMiddle2, this.bones.rightHandMiddle3],
            ring: hand === 'left' ? [this.bones.leftHandRing1, this.bones.leftHandRing2, this.bones.leftHandRing3] :
                                    [this.bones.rightHandRing1, this.bones.rightHandRing2, this.bones.rightHandRing3],
            pinky: hand === 'left' ? [this.bones.leftHandPinky1, this.bones.leftHandPinky2, this.bones.leftHandPinky3] :
                                     [this.bones.rightHandPinky1, this.bones.rightHandPinky2, this.bones.rightHandPinky3]
          };
          
          // Default curl amounts (0 = straight, 1 = fully curled)
          let curls = { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 };
          
          // Adjust curls based on gesture
          if (gesture === 'fist') {
            curls = { thumb: 1, index: 1, middle: 1, ring: 1, pinky: 1 };
          } else if (gesture === 'point') {
            curls = { thumb: 0.3, index: 0, middle: 1, ring: 1, pinky: 1 };
          } else if (gesture === 'thumbUp') {
            curls = { thumb: 0, index: 1, middle: 1, ring: 1, pinky: 1 };
          } else if (gesture === 'pistol') {
            curls = { thumb: 0, index: 0, middle: 0, ring: 1, pinky: 1 };
          }
          
          // Apply curls to finger bones
          const sign = hand === 'left' ? 1 : -1; // Mirror for right hand
          
          Object.keys(fingerBones).forEach(fingerName => {
            const bones = fingerBones[fingerName];
            const curl = curls[fingerName];
            
            bones.forEach((bone, i) => {
              if (!bone) return;
              
              // Reset to T-pose first
              const initialRot = this.initialBoneRotations[bone.name];
              if (initialRot) {
                bone.quaternion.copy(initialRot);
              }
              
              // Apply curl rotation (more curl for distal bones)
              const curlAmount = curl * (0.4 + i * 0.3); // Progressive curl
              const curlAngle = curlAmount * Math.PI * 0.5 * sign; // Up to 90 degrees
              
              const curlQuat = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(1, 0, 0), // X-axis
                curlAngle
              );
              
              bone.quaternion.multiply(curlQuat);
            });
          });
        },

        _measureHandPalmOffsets: function () {
          if (this.data.isMirror) return;

          this._palmContactLocalLeft = new THREE.Vector3(0, -0.04, -0.08);
          this._palmContactLocalRight = new THREE.Vector3(0, -0.04, -0.08);
          this._palmProbeLocalLeft = new THREE.Vector3(0, -0.04, -0.12);
          this._palmProbeLocalRight = new THREE.Vector3(0, -0.04, -0.12);
          this._palmForwardLocalLeft = new THREE.Vector3(0, -1, 0);
          this._palmForwardLocalRight = new THREE.Vector3(0, -1, 0);
          this._palmNormalLocalLeft = new THREE.Vector3(0, -1, 0);
          this._palmNormalLocalRight = new THREE.Vector3(0, -1, 0);
          this._palmLocalLeft = this._palmContactLocalLeft;
          this._palmLocalRight = this._palmContactLocalRight;
          if (!this.model || !this.bones.leftHandBone) return;

          this.model.updateMatrixWorld(true);
          if (this.skeleton) this.skeleton.update();

          const measure = (hand) => {
            const handBone = this.bones[`${hand}HandBone`];
            const middle1 = this.bones[`${hand}HandMiddle1`];
            const index1 = this.bones[`${hand}HandIndex1`];
            const pinky1 = this.bones[`${hand}HandPinky1`];
            if (!handBone || !middle1) return null;

            const wristW = new THREE.Vector3();
            const midW = new THREE.Vector3();
            handBone.getWorldPosition(wristW);
            middle1.getWorldPosition(midW);

            const forwardW = midW.clone().sub(wristW);
            if (forwardW.lengthSq() < 1e-8) forwardW.set(0, -1, 0);
            else forwardW.normalize();

            // Palm-facing normal (perpendicular to the palm plane, toward objects).
            // Baked with a palms-down heuristic; corrected at runtime by the live
            // contact normal when actually touching a surface.
            let palmNormalW = null;
            if (index1 && pinky1) {
              const iW = new THREE.Vector3();
              const pW = new THREE.Vector3();
              index1.getWorldPosition(iW);
              pinky1.getWorldPosition(pW);
              const acrossW = pW.clone().sub(iW);
              palmNormalW = new THREE.Vector3().crossVectors(forwardW, acrossW);
              if (palmNormalW.lengthSq() < 1e-8) palmNormalW = null;
              else {
                palmNormalW.normalize();
                if (palmNormalW.dot(new THREE.Vector3(0, -1, 0)) < 0) palmNormalW.negate();
              }
            }
            if (!palmNormalW) palmNormalW = new THREE.Vector3(0, -1, 0);

            // Palm center (wrist â†’ middle knuckle), then offset to outer palmar skin.
            const palmCenterW = wristW.clone().lerp(midW, 0.55);
            const contactW = palmCenterW.clone().addScaledVector(palmNormalW, this.palmSurfaceOffset);
            // Probe center sits (radius - touchGap) behind the skin along the palm
            // normal, so the sphere's leading edge is the palm skin: when the sphere
            // rests on a surface, the palm touches it.
            const probeDepth = Math.max(0, this.palmProbeRadius - this.palmTouchGap);
            const probeW = contactW.clone().addScaledVector(palmNormalW, -probeDepth);

            const contactLocal = handBone.worldToLocal(contactW.clone());
            const probeLocal = handBone.worldToLocal(probeW.clone());
            const forwardLocal = handBone.worldToLocal(wristW.clone().add(forwardW)).sub(
              handBone.worldToLocal(wristW.clone())
            );
            if (forwardLocal.lengthSq() < 1e-8) forwardLocal.set(0, -1, 0);
            else forwardLocal.normalize();

            const normalLocal = handBone.worldToLocal(wristW.clone().add(palmNormalW)).sub(
              handBone.worldToLocal(wristW.clone())
            );
            if (normalLocal.lengthSq() < 1e-8) normalLocal.set(0, -1, 0);
            else normalLocal.normalize();

            return { contactLocal, probeLocal, forwardLocal, normalLocal };
          };

          const left = measure('left');
          const right = measure('right');
          if (left) {
            this._palmContactLocalLeft = left.contactLocal;
            this._palmProbeLocalLeft = left.probeLocal;
            this._palmForwardLocalLeft = left.forwardLocal;
            this._palmNormalLocalLeft = left.normalLocal;
            this._palmLocalLeft = left.contactLocal;
          }
          if (right) {
            this._palmContactLocalRight = right.contactLocal;
            this._palmProbeLocalRight = right.probeLocal;
            this._palmForwardLocalRight = right.forwardLocal;
            this._palmNormalLocalRight = right.normalLocal;
            this._palmLocalRight = right.contactLocal;
          }
          this._syncHandCollisionWireframeOffsets();
        },

        _measureFingerTipOffsets: function () {
          if (this.data.isMirror) return;
          const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'];
          const defaultLen = 0.024;

          ['left', 'right'].forEach((hand) => {
            fingers.forEach((finger) => {
              const bone = this.bones[`${hand}Hand${finger}3`];
              if (!bone) {
                this._fingerTipLocal[hand][finger.toLowerCase()] = new THREE.Vector3(0, -defaultLen, 0);
                return;
              }
              const p0 = new THREE.Vector3();
              const p1 = new THREE.Vector3();
              bone.getWorldPosition(p0);
              bone.updateMatrixWorld(true);
              p1.set(0, -defaultLen, 0).applyMatrix4(bone.matrixWorld);
              const tipLocal = bone.worldToLocal(p1.clone());
              if (tipLocal.lengthSq() < 1e-6) {
                tipLocal.set(0, -defaultLen, 0);
              }
              this._fingerTipLocal[hand][finger.toLowerCase()] = tipLocal;
            });
          });
          this._syncHandCollisionWireframeOffsets();
        },

        _syncHandCollisionWireframeOffsets: function () {
          if (!this._handWireframesReady) return;
          ['left', 'right'].forEach((side) => {
            const visuals = side === 'left' ? this._leftHandDebug : this._rightHandDebug;
            if (!visuals) return;
            // Palm sphere + skin marker are world-space now (positioned each frame
            // in _updateHandCollisionDebug), so nothing to sync here.
            if (visuals.fingers) {
              const names = ['thumb', 'index', 'middle', 'ring', 'pinky'];
              visuals.fingers.forEach((sphere, i) => {
                const tipLocal = this._fingerTipLocal[side][names[i]];
                if (tipLocal) sphere.position.copy(tipLocal);
              });
            }
          });
        },

        _syncHandCollisionRadiiToLegIk: function () {
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (!legIk) return;
          legIk.handCollisionRadius = this.palmProbeRadius;
          legIk.fingerCollisionRadius = this.fingerCollisionRadius;
          legIk.knuckleCollisionRadius = this.knuckleCollisionRadius;
        },

        _getPalmForwardWorld: function (hand, dest) {
          const handBone = this.bones[`${hand}HandBone`];
          const forwardLocal = hand === 'left' ? this._palmForwardLocalLeft : this._palmForwardLocalRight;
          if (!handBone || !forwardLocal) return dest.set(0, -1, 0);
          if (this.model) this.model.updateMatrixWorld(true);
          if (this.skeleton) this.skeleton.update();
          const q = new THREE.Quaternion();
          handBone.getWorldQuaternion(q);
          return dest.copy(forwardLocal).applyQuaternion(q).normalize();
        },

        // Palm-facing normal in world space (points from the palm toward objects
        // it would press against). Uses the baked local normal, sign-corrected by
        // the live physics contact normal whenever the palm is actually touching.
        _getPalmNormalWorld: function (hand, dest) {
          // Purely the baked palm normal rotated into the current hand pose. It is
          // FIXED relative to the hand and never depends on live contact, so the
          // probe/collision sphere stays glued inside the hand and never jumps.
          const handBone = this.bones[`${hand}HandBone`];
          const normalLocal = hand === 'left' ? this._palmNormalLocalLeft : this._palmNormalLocalRight;
          if (!handBone || !normalLocal) return this._getPalmForwardWorld(hand, dest);
          if (this.model) this.model.updateMatrixWorld(true);
          if (this.skeleton) this.skeleton.update();
          const q = new THREE.Quaternion();
          handBone.getWorldQuaternion(q);
          return dest.copy(normalLocal).applyQuaternion(q).normalize();
        },

        _getPalmProbeDepth: function () {
          return Math.max(0, this.palmProbeRadius - (this.palmTouchGap || 0));
        },

        // Unit normal of the palm plane (wrist Ã— indexâ€“pinky span), biased toward the palmar side.
        _getPalmOutwardWorld: function (hand, dest) {
          const handBone = this.bones[`${hand}HandBone`];
          const index1 = this.bones[`${hand}HandIndex1`];
          const pinky1 = this.bones[`${hand}HandPinky1`];
          if (!handBone || !index1 || !pinky1) {
            return this._getPalmForwardWorld(hand, dest).negate();
          }
          if (this.model) this.model.updateMatrixWorld(true);
          if (this.skeleton) this.skeleton.update();

          const wrist = new THREE.Vector3();
          const iPos = new THREE.Vector3();
          const pPos = new THREE.Vector3();
          handBone.getWorldPosition(wrist);
          index1.getWorldPosition(iPos);
          pinky1.getWorldPosition(pPos);

          const across = pPos.clone().sub(iPos);
          const fwd = this._getPalmForwardWorld(hand, new THREE.Vector3());
          dest.crossVectors(fwd, across);
          if (dest.lengthSq() < 1e-8) return this._getPalmForwardWorld(hand, dest).negate();
          dest.normalize();

          const palm = this._getHandPalmContactWorldPos(hand, new THREE.Vector3());
          const ctrl = hand === 'left' ? this.leftController : this.rightController;
          if (ctrl) {
            const push = new THREE.Vector3();
            ctrl.object3D.getWorldPosition(push);
            push.sub(palm);
            if (push.lengthSq() > 1e-8 && dest.dot(push) < 0) dest.negate();
          }
          return dest;
        },

        // Same nearest-surface strategy as fingertips: cast from the palm patch in
        // several outward directions and keep the closest hit.
        _raycastPalmToNearestSurface: function (hand) {
          if (this.data.isMirror) return null;
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (!legIk || !legIk.physics || !legIk.physics.castRay || !this.model) return null;

          this.model.updateMatrixWorld(true);
          if (this.skeleton) this.skeleton.update();

          const palm = this._getHandPalmContactWorldPos(hand, this._palmWorldTmp || new THREE.Vector3());
          const radius = this.palmProbeRadius;
          const maxDist = this.fingerRaycastMaxDist || 0.22;
          const fwd = this._getPalmForwardWorld(hand, this._palmWorldTmp2 || new THREE.Vector3());
          const out = this._getPalmOutwardWorld(hand, new THREE.Vector3());
          const tmpDir = new THREE.Vector3();
          const dirs = [];

          // Only cast outward from the palm â€” never through the object to the far side.
          const ctrl = hand === 'left' ? this.leftController : this.rightController;
          if (ctrl) {
            ctrl.object3D.getWorldPosition(tmpDir);
            tmpDir.sub(palm);
            if (tmpDir.lengthSq() > 1e-8) dirs.push(tmpDir.normalize());
          }
          dirs.push(fwd.clone().negate(), out.clone());

          let bestHit = null;
          let bestDist = Infinity;
          const origin = new THREE.Vector3();
          const hitPt = new THREE.Vector3();
          const rayDir = new THREE.Vector3();

          for (let i = 0; i < dirs.length; i++) {
            rayDir.copy(dirs[i]);
            origin.copy(palm).addScaledVector(rayDir, radius + 0.012);
            const hit = legIk.physics.castRay(origin, rayDir, maxDist);
            if (!hit || !hit.normal) continue;

            // Front face only â€” reject back-face hits that would snap to the far side.
            const nd = hit.normal.x * rayDir.x + hit.normal.y * rayDir.y + hit.normal.z * rayDir.z;
            if (nd > -0.05) continue;

            hitPt.set(hit.point.x, hit.point.y, hit.point.z);
            const dist = origin.distanceTo(hitPt);
            if (dist < bestDist) {
              bestDist = dist;
              bestHit = hit;
            }
          }

          if (!bestHit) {
            this._palmRayHits[hand] = null;
            return null;
          }

          const rec = this._palmRayHits[hand] || (this._palmRayHits[hand] = { palm: new THREE.Vector3(), hit: new THREE.Vector3() });
          rec.palm.copy(palm);
          rec.hit.set(bestHit.point.x, bestHit.point.y, bestHit.point.z);
          return rec;
        },

        _getHandPalmContactWorldPos: function (hand, dest) {
          const handBone = this.bones[`${hand}HandBone`];
          const contactLocal = hand === 'left' ? this._palmContactLocalLeft : this._palmContactLocalRight;
          if (!handBone || !contactLocal) return this._getHandPalmWorldPos(hand, dest);
          if (this.model) this.model.updateMatrixWorld(true);
          if (this.skeleton) this.skeleton.update();
          return dest.copy(contactLocal).applyMatrix4(handBone.matrixWorld);
        },

        _getHandPalmProbeWorldPos: function (hand, dest) {
          const handBone = this.bones[`${hand}HandBone`];
          const probeLocal = hand === 'left' ? this._palmProbeLocalLeft : this._palmProbeLocalRight;
          if (!handBone || !probeLocal) return this._getHandPalmContactWorldPos(hand, dest);
          // Fixed hand-local probe point (baked so the sphere's front edge is the
          // palm skin). Transformed straight to world â†’ never jumps on contact.
          if (this.model) this.model.updateMatrixWorld(true);
          if (this.skeleton) this.skeleton.update();
          return dest.copy(probeLocal).applyMatrix4(handBone.matrixWorld);
        },

        /** VR shot ray from the posed virtual hand (palm origin, finger-forward direction). */
        getHandShotAim: function (hand, out) {
          out = out || {};
          const handBone = this.bones[`${hand}HandBone`];
          if (!handBone || this.data.isMirror) {
            out.ok = false;
            return out;
          }

          const frame = this.el.sceneEl?.time;
          if (frame != null && this._handShotAimFrame === frame && this._handShotAimHand === hand && this._handShotAimCached?.ok) {
            const c = this._handShotAimCached;
            if (!out.origin) out.origin = new THREE.Vector3();
            if (!out.direction) out.direction = new THREE.Vector3();
            out.ok = true;
            out.origin.copy(c.origin);
            out.direction.copy(c.direction);
            out.handBone = c.handBone;
            out.localOrigin = c.localOrigin;
            return out;
          }

          if (this.model) this.model.updateMatrixWorld(true);

          const origin = out.origin || new THREE.Vector3();
          const direction = out.direction || new THREE.Vector3();
          const contactLocal = hand === 'left' ? this._palmContactLocalLeft : this._palmContactLocalRight;
          const forwardLocal = hand === 'left' ? this._palmForwardLocalLeft : this._palmForwardLocalRight;
          if (!contactLocal || !forwardLocal) {
            out.ok = false;
            return out;
          }

          origin.copy(contactLocal).applyMatrix4(handBone.matrixWorld);
          if (!this._handShotAimQuat) this._handShotAimQuat = new THREE.Quaternion();
          handBone.getWorldQuaternion(this._handShotAimQuat);
          direction.copy(forwardLocal).applyQuaternion(this._handShotAimQuat).normalize();
          if (direction.lengthSq() < 1e-8) {
            out.ok = false;
            return out;
          }

          if (!this._handShotAimCached) {
            this._handShotAimCached = {
              ok: true,
              origin: new THREE.Vector3(),
              direction: new THREE.Vector3(),
              handBone: handBone,
              localOrigin: contactLocal.clone()
            };
          }
          this._handShotAimCached.ok = true;
          this._handShotAimCached.origin.copy(origin);
          this._handShotAimCached.direction.copy(direction);
          this._handShotAimCached.handBone = handBone;
          this._handShotAimCached.localOrigin.copy(contactLocal);
          this._handShotAimFrame = frame;
          this._handShotAimHand = hand;

          out.ok = true;
          out.origin = origin;
          out.direction = direction;
          out.handBone = handBone;
          out.localOrigin = this._handShotAimCached.localOrigin;
          return out;
        },

        _probeWorldToContactWorld: function (hand, probeWorld, dest) {
          const n = this._getPalmNormalWorld(hand, this._palmProbeNormalTmp || (this._palmProbeNormalTmp = new THREE.Vector3()));
          return dest.copy(probeWorld).addScaledVector(n, this._getPalmProbeDepth());
        },

        _contactWorldToProbeWorld: function (hand, contactWorld, dest) {
          const n = this._getPalmNormalWorld(hand, this._palmProbeNormalTmp || (this._palmProbeNormalTmp = new THREE.Vector3()));
          return dest.copy(contactWorld).addScaledVector(n, -this._getPalmProbeDepth());
        },

        _getFingerTipWorldPos: function (hand, fingerName, dest) {
          const prefix = hand === 'left' ? 'left' : 'right';
          const cap = fingerName.charAt(0).toUpperCase() + fingerName.slice(1);
          const bone = this.bones[`${prefix}Hand${cap}3`];
          if (!bone) return dest.set(0, 0, 0);
          if (this.model) this.model.updateMatrixWorld(true);
          if (this.skeleton) this.skeleton.update();
          const tipLocal = this._fingerTipLocal[hand][fingerName];
          if (tipLocal) return dest.copy(tipLocal).applyMatrix4(bone.matrixWorld);
          return bone.getWorldPosition(dest);
        },

        _smoothPalmContactWorld: function (hand, desiredContact, dest, dt) {
          const smoothedKey = hand === 'left' ? '_smoothedPalmContactLeft' : '_smoothedPalmContactRight';
          const hasKey = hand === 'left' ? '_hasSmoothedPalmContactLeft' : '_hasSmoothedPalmContactRight';
          const smoothed = this[smoothedKey];
          if (!this[hasKey]) {
            smoothed.copy(desiredContact);
            this[hasKey] = true;
            return dest.copy(smoothed);
          }
          const maxStep = this.palmContactMaxStep * (dt / 0.016);
          const dx = desiredContact.x - smoothed.x;
          const dy = desiredContact.y - smoothed.y;
          const dz = desiredContact.z - smoothed.z;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist > maxStep && dist > 1e-8) {
            const t = maxStep / dist;
            smoothed.x += dx * t;
            smoothed.y += dy * t;
            smoothed.z += dz * t;
          } else {
            const alpha = 1 - Math.exp(-(this.palmContactSmoothRate || 16) * dt);
            smoothed.lerp(desiredContact, alpha);
          }
          return dest.copy(smoothed);
        },

        _adaptFingersToSurfaceRaycast: function (hand, dt) {
          if (this.data.isMirror) return;
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (!legIk || !legIk.physics || !legIk.physics.castRay || !this.model) return;

          const surfaceGrab =
            (hand === 'left' && this._grabAnchorActiveLeft && this._grabSurfaceContactLeft) ||
            (hand === 'right' && this._grabAnchorActiveRight && this._grabSurfaceContactRight);

          const prefix = hand === 'left' ? 'left' : 'right';
          const fingerNames = ['thumb', 'index', 'middle', 'ring', 'pinky'];
          const palmFwd = this._palmWorldTmp2 || new THREE.Vector3();
          this._getPalmForwardWorld(hand, palmFwd);
          const tip = new THREE.Vector3();
          const proximal = new THREE.Vector3();
          const rayDir = new THREE.Vector3();
          const origin = new THREE.Vector3();
          const hitPt = new THREE.Vector3();
          const curls = this.targetCurls[hand];
          const radius = this.fingerCollisionRadius;
          const maxDist = this.fingerRaycastMaxDist;
          const rate = this.fingerPenetrationCurlRate * dt;

          this.model.updateMatrixWorld(true);
          if (this.skeleton) this.skeleton.update();

          fingerNames.forEach((name) => {
            const cap = name.charAt(0).toUpperCase() + name.slice(1);
            const proximalBone = this.bones[`${prefix}Hand${cap}1`];
            if (!this.bones[`${prefix}Hand${cap}3`]) return;

            this._getFingerTipWorldPos(hand, name, tip);
            if (proximalBone) proximalBone.getWorldPosition(proximal);
            else proximal.copy(tip).addScaledVector(palmFwd, -0.03);

            rayDir.subVectors(tip, proximal);
            if (rayDir.lengthSq() < 1e-8) rayDir.copy(palmFwd).negate();
            else rayDir.normalize();

            origin.copy(tip).addScaledVector(rayDir, radius + 0.012);
            let hit = legIk.physics.castRay(origin, rayDir, maxDist);
            if (!hit) {
              origin.copy(tip).addScaledVector(palmFwd, radius + 0.015);
              rayDir.copy(palmFwd).negate();
              hit = legIk.physics.castRay(origin, rayDir, maxDist);
            }
            if (!hit) {
              this._fingerRayHits[hand][name] = null;
              return;
            }

            hitPt.set(hit.point.x, hit.point.y, hit.point.z);
            // Record the fingertipâ†’surface ray for debug visualization.
            const rec = this._fingerRayHits[hand][name] || (this._fingerRayHits[hand][name] = { tip: new THREE.Vector3(), hit: new THREE.Vector3() });
            rec.tip.copy(tip);
            rec.hit.copy(hitPt);
            const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
            if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
            else n.normalize();
            const desiredTip = hitPt.clone().addScaledVector(n, radius);
            const signedGap = tip.clone().sub(desiredTip).dot(n);
            const weight = surfaceGrab ? 1 : THREE.MathUtils.clamp(1 - tip.distanceTo(hitPt) / 0.14, 0, 1);
            if (weight < 0.05) return;
            const adjust = THREE.MathUtils.clamp(signedGap * 2.4 * rate, -0.06, 0.06) * weight;
            curls[name] = THREE.MathUtils.clamp((curls[name] || 0) + adjust, -0.35, 0.95);
          });
        },

        _applySoftFingerPenetrationFix: function (hand, dt) {
          if (this.data.isMirror) return false;
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (!legIk || !legIk.physics || !legIk.physics.resolveSphere || !this.model) return false;

          const prefix = hand === 'left' ? 'left' : 'right';
          const fingerNames = ['thumb', 'index', 'middle', 'ring', 'pinky'];
          const radius = this.fingerCollisionRadius;
          const knuckleRadius = this.knuckleCollisionRadius || 0.016;
          const tmp = this._palmWorldTmp || new THREE.Vector3();
          const curls = this.currentCurls[hand];
          const step = this.fingerPenetrationCurlRate * dt;
          let changed = false;

          this.model.updateMatrixWorld(true);
          if (this.skeleton) this.skeleton.update();

          fingerNames.forEach((name) => {
            const cap = name.charAt(0).toUpperCase() + name.slice(1);
            if (!this.bones[`${prefix}Hand${cap}3`]) return;
            this._getFingerTipWorldPos(hand, name, tmp);
            let resolved = legIk.physics.resolveSphere(tmp, radius);
            let push = resolved.hit ? resolved.position.distanceTo(tmp) : 0;
            const knuckle = this.bones[`${prefix}Hand${cap}1`];
            if (knuckle) {
              knuckle.getWorldPosition(tmp);
              resolved = legIk.physics.resolveSphere(tmp, knuckleRadius);
              const kPush = resolved.hit ? resolved.position.distanceTo(tmp) : 0;
              if (kPush > push) push = kPush;
            }
            if (push > 0.0004) {
              curls[name] = Math.max(
                -0.1,
                (curls[name] || 0) - step * THREE.MathUtils.clamp(push / 0.02, 0.15, 1)
              );
              changed = true;
            }
          });
          return changed;
        },

        _collectHandCollisionProbes: function (hand, options) {
          options = options || {};
          const prefix = hand === 'left' ? 'left' : 'right';
          const probes = [];
          const tmp = this._palmWorldTmp || new THREE.Vector3();

          probes.push({
            kind: 'palm',
            radius: this.palmProbeRadius,
            getWorldPos: () => this._getHandPalmProbeWorldPos(hand, tmp.clone())
          });

          if (options.palmOnly) return probes;

          // Bone-centered spheres (finger tips, knuckles) sit inside the flesh, so
          // their outer edge protrudes past the skin and would hold the hand off
          // the surface. Shift each center back along the palm normal by
          // (radius - touchGap) so its FRONT edge lands on the palm-skin plane â€”
          // matching the palm probe. A flat press then brings palm + knuckles +
          // finger tips to the surface together and the palm can actually touch.
          ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach((name) => {
            const cap = name.charAt(0).toUpperCase() + name.slice(1);
            probes.push({
              kind: 'finger',
              finger: name,
              radius: this.fingerCollisionRadius,
              getWorldPos: () => this._getFingerColliderWorldPos(hand, name, tmp.clone())
            });
            const knuckle = this.bones[`${prefix}Hand${cap}1`];
            if (knuckle) {
              probes.push({
                kind: 'knuckle',
                finger: name,
                radius: this.knuckleCollisionRadius,
                getWorldPos: () => {
                  knuckle.getWorldPosition(tmp);
                  return this._skinOffsetAlongPalmNormal(hand, tmp.clone(), this.knuckleCollisionRadius);
                }
              });
            }
          });

          return probes;
        },

        // Shift a bone-centered collider back along the palm normal so its front
        // edge lands on the palm-skin plane (touchGap in front). Lets the whole
        // hand reach a surface together instead of standing off by the radius.
        _skinOffsetAlongPalmNormal: function (hand, pos, radius) {
          const gap = this.palmTouchGap || 0;
          const n = this._getPalmNormalWorld(hand, this._palmSkinNormalTmp || (this._palmSkinNormalTmp = new THREE.Vector3()));
          return pos.addScaledVector(n, -Math.max(0, radius - gap));
        },

        _getFingerColliderWorldPos: function (hand, name, dest) {
          this._getFingerTipWorldPos(hand, name, dest);
          return this._skinOffsetAlongPalmNormal(hand, dest, this.fingerCollisionRadius);
        },

        // Treat the whole hand (palm + finger tips + knuckles) as a rigid set of
        // spheres and translate the wrist target until none of them penetrate any
        // geometry. Each sphere is resolved with a *swept* test from its previous
        // (known-outside) position, so it depenetrates correctly at ANY depth â€”
        // unlike axis-ray push-out, which fails once a sphere is more than its
        // radius past a face. No per-frame cap: pushes are bounded by real
        // penetration and the surface is continuous, so motion stays smooth.
        _blockHandRigid: function (hand, handBone, targetHandPos, applyTwoBoneIK, options) {
          options = options || {};
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (!legIk || !legIk.physics || !legIk.physics.slideHandSphere) return false;

          const probes = this._collectHandCollisionProbes(hand, options);
          if (!probes.length) return false;

          const maxIter = options.singlePass ? 1 : 10;
          const preferToward = options.preferToward || null;
          const maxDelta = options.maxDelta != null ? options.maxDelta : 0.08;

          if (!this._handProbeLast) this._handProbeLast = {};
          let lastArr = this._handProbeLast[hand];
          if (!lastArr || lastArr.length !== probes.length) {
            lastArr = new Array(probes.length).fill(null);
          }

          const resolveOne = (i, cur) => {
            let last = lastArr[i];
            // Drop stale history (teleport / large jump) so we never sweep across
            // unrelated geometry and yank the hand.
            if (last && last.distanceTo(cur) > 0.5) last = null;
            return legIk.physics.slideHandSphere(last, last || cur, cur, probes[i].radius, cur, {
              preferToward,
              maxDelta
            });
          };

          let everHit = false;

          for (let iter = 0; iter < maxIter; iter++) {
            this.model.updateMatrixWorld(true);
            if (this.skeleton) this.skeleton.update();

            let deepest = 0;
            let bestDelta = null;
            for (let i = 0; i < probes.length; i++) {
              const cur = probes[i].getWorldPos();
              const slide = resolveOne(i, cur);
              if (slide.hit) {
                const dx = slide.position.x - cur.x;
                const dy = slide.position.y - cur.y;
                const dz = slide.position.z - cur.z;
                const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                if (d > deepest) {
                  deepest = d;
                  bestDelta = new THREE.Vector3(dx, dy, dz);
                }
              }
            }

            if (!bestDelta || deepest < 0.0006) break;
            if (deepest > 0.8) break; // pathological â€” ignore this frame's push
            // Cap a single rigid correction so probes never yank the wrist across the scene.
            if (deepest > maxDelta) {
              bestDelta.multiplyScalar(maxDelta / deepest);
              deepest = maxDelta;
            }
            everHit = true;
            targetHandPos.add(bestDelta);
            applyTwoBoneIK(true);
          }

          // Record each sphere's final (outside) position for next frame's sweep.
          this.model.updateMatrixWorld(true);
          if (this.skeleton) this.skeleton.update();
          for (let i = 0; i < probes.length; i++) {
            const cur = probes[i].getWorldPos();
            const slide = resolveOne(i, cur);
            lastArr[i] = slide.position.clone();
          }
          this._handProbeLast[hand] = lastArr;

          return everHit;
        },


        _getHandPalmWorldPos: function (hand, dest) {
          return this._getHandPalmContactWorldPos(hand, dest);
        },

        _getEstimatedPalmOffsetWorld: function (hand, handWorldQuat) {
          const palmLocal = hand === 'left' ? this._palmLocalLeft : this._palmLocalRight;
          if (!palmLocal) return new THREE.Vector3();

          const q = handWorldQuat.clone();
          q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
          q.multiply(new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            hand === 'left' ? Math.PI / 2 : -Math.PI / 2
          ));
          return palmLocal.clone().applyQuaternion(q);
        },

        _isGrabPressed: function (hand) {
          const ctrl = hand === 'left' ? this.leftController : this.rightController;
          const gamepad = ctrl && ctrl.components['tracked-controls']
            ? ctrl.components['tracked-controls'].controller?.gamepad
            : null;
          const btn = gamepad && gamepad.buttons ? gamepad.buttons[1] : null;
          if (!btn) return false;
          return btn.pressed || btn.value >= this.grabButtonThreshold;
        },

        _pulseHandHaptic: function (hand, intensity, durationMs) {
          const ctrl = hand === 'left' ? this.leftController : this.rightController;
          if (!ctrl || !ctrl.components) return;

          const compNames = ['tracked-controls', 'oculus-touch-controls', 'meta-touch-controls'];
          let actuator = null;
          for (let i = 0; i < compNames.length; i++) {
            const comp = ctrl.components[compNames[i]];
            const gamepad = comp && comp.controller && comp.controller.gamepad;
            if (!gamepad) continue;
            if (gamepad.hapticActuators && gamepad.hapticActuators[0]) {
              actuator = gamepad.hapticActuators[0];
              break;
            }
            if (gamepad.vibrationActuator) {
              actuator = gamepad.vibrationActuator;
              break;
            }
          }
          if (!actuator || typeof actuator.pulse !== 'function') return;

          const clamped = Math.max(0, Math.min(1, intensity));
          const duration = Math.max(10, durationMs | 0);
          actuator.pulse(clamped, duration).catch(function () {});
        },

        _stopHandHaptic: function (hand) {
          this._pulseHandHaptic(hand, 0, 1);
          const slideKey = hand === 'left' ? '_lastSlideHapticLeft' : '_lastSlideHapticRight';
          const ragKey = hand === 'left' ? '_lastRagdollHoldHapticLeft' : '_lastRagdollHoldHapticRight';
          this[slideKey] = 0;
          this[ragKey] = 0;
        },

        _updateRagdollHoldHaptics: function (hand, ragHoldActive, handWorldPos) {
          const wasKey = hand === 'left' ? '_ragdollHoldWasActiveLeft' : '_ragdollHoldWasActiveRight';
          const lastPulseKey = hand === 'left' ? '_lastRagdollHoldHapticLeft' : '_lastRagdollHoldHapticRight';
          const nearTouchKey = hand === 'left' ? '_ragdollNearTouchLeft' : '_ragdollNearTouchRight';
          const wasActive = !!this[wasKey];
          const comp = document.querySelector('#grab-dummy')?.components['grabbable-ragdoll'];

          if (ragHoldActive && !wasActive) {
            this._pulseHandHaptic(hand, 0.65, 115);
            const ctrl = hand === 'left' ? this.leftController : this.rightController;
            const lastPosKey = hand === 'left' ? '_lastCtrlHapticPosLeft' : '_lastCtrlHapticPosRight';
            if (ctrl) {
              if (!this[lastPosKey]) this[lastPosKey] = new THREE.Vector3();
              ctrl.object3D.getWorldPosition(this[lastPosKey]);
            }
          }

          if (!ragHoldActive && wasActive) {
            this._stopHandHaptic(hand);
            if (comp?.wasForceDetached?.(hand)) {
              // Forced detach â€” no release pulse, vibrations already stopped.
            } else {
              this._pulseHandHaptic(hand, 0.16, 70);
            }
          }

          if (ragHoldActive && comp) {
            const motionI = comp.getHoldMotionIntensity(hand);
            const slideSpeed = this._getHandSlideSpeed(hand);
            const combined = Math.max(motionI, slideSpeed * 0.45);
            if (combined > 0.06) {
              const now = performance.now();
              const intervalMs = Math.max(28, 58 - combined * 12);
              if (now - (this[lastPulseKey] || 0) >= intervalMs) {
                const t = Math.min(1, combined / 2.4);
                this._pulseHandHaptic(hand, 0.1 + t * 0.3, 30);
                this[lastPulseKey] = now;
              }
            }
          } else if (!ragHoldActive && comp && handWorldPos) {
            const near = comp.isHandNearGrabbable(hand, handWorldPos);
            const wasNear = this[nearTouchKey];
            if (near && !wasNear) {
              this._pulseHandHaptic(hand, 0.4, 42);
            }
            this[nearTouchKey] = near;
            if (!near) this[lastPulseKey] = 0;
          } else {
            this[nearTouchKey] = false;
          }

          this[wasKey] = ragHoldActive;
        },

        _getHandSlideSpeed: function (hand) {
          const ctrl = hand === 'left' ? this.leftController : this.rightController;
          if (!ctrl) return 0;

          const lastKey = hand === 'left' ? '_lastCtrlHapticPosLeft' : '_lastCtrlHapticPosRight';
          const tmp = hand === 'left' ? this._leftCtrlWorldTmp : this._rightCtrlWorldTmp;
          if (!this[lastKey]) {
            this[lastKey] = new THREE.Vector3();
            ctrl.object3D.getWorldPosition(this[lastKey]);
            return 0;
          }

          ctrl.object3D.getWorldPosition(tmp);
          const speed = tmp.distanceTo(this[lastKey]) / Math.max(this._handHapticDt, 0.001);
          this[lastKey].copy(tmp);
          return speed;
        },

        _updateHandHaptics: function (hand, collisionHit, grabActive, grabWasActive) {
          const touchKey = hand === 'left' ? '_handPalmTouchLeft' : '_handPalmTouchRight';
          const lastSlideKey = hand === 'left' ? '_lastSlideHapticLeft' : '_lastSlideHapticRight';
          const wasTouching = this[touchKey];

          if (!wasTouching && collisionHit) {
            const lastPosKey = hand === 'left' ? '_lastCtrlHapticPosLeft' : '_lastCtrlHapticPosRight';
            const ctrl = hand === 'left' ? this.leftController : this.rightController;
            if (ctrl) {
              if (!this[lastPosKey]) this[lastPosKey] = new THREE.Vector3();
              ctrl.object3D.getWorldPosition(this[lastPosKey]);
            }
            this._pulseHandHaptic(hand, 0.42, 45);
          }

          if (grabActive && !grabWasActive) {
            this._pulseHandHaptic(hand, 0.6, 105);
          } else if (!grabActive && grabWasActive) {
            this._stopHandHaptic(hand);
            this._pulseHandHaptic(hand, 0.18, 75);
          }

          if (collisionHit || grabActive) {
            const slideSpeed = this._getHandSlideSpeed(hand);
            const moveThreshold = grabActive ? 0.06 : 0.15;
            if (slideSpeed > moveThreshold) {
              const now = performance.now();
              const intervalMs = grabActive ? 62 : 48;
              if (now - (this[lastSlideKey] || 0) >= intervalMs) {
                const t = Math.min(1, slideSpeed / (grabActive ? 2.8 : 2.5));
                const base = grabActive ? 0.14 : 0.3;
                this._pulseHandHaptic(hand, base * (0.5 + 0.5 * t), grabActive ? 26 : 32);
                this[lastSlideKey] = now;
              }
            }
          } else {
            this[lastSlideKey] = 0;
          }

          this[touchKey] = !!collisionHit;
        },

        _getGrabPullRefObject3D: function () {
          return (this._grabPullRef || this.rig)?.object3D || null;
        },

        _readControllerInGrabPullSpace: function (ctrl, dest) {
          const refObj = this._getGrabPullRefObject3D();
          if (!ctrl || !refObj) {
            dest.set(0, 0, 0);
            return dest;
          }
          ctrl.object3D.getWorldPosition(dest);
          refObj.worldToLocal(dest);
          return dest;
        },

        _seedGrabPullTracking: function (hand, anchorWorld) {
          const ctrl = hand === 'left' ? this.leftController : this.rightController;
          const last = hand === 'left' ? this._grabLastCtrlLocalLeft : this._grabLastCtrlLocalRight;
          this._readControllerInGrabPullSpace(ctrl, last);

          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (legIk && legIk.physics && !this._grabPullLastRigPosActive) {
            const p = legIk.physics.getPlayerTranslation();
            this._grabPullLastRigPos.set(p.x, p.y, p.z);
            this._grabPullLastRigPosActive = true;
          }

          if (ctrl && anchorWorld) {
            ctrl.object3D.getWorldPosition(this._grabPullTmp);
            const baseline = this._grabPullTmp.distanceTo(anchorWorld);
            if (hand === 'left') {
              this._grabReleaseBaselineLeft = baseline;
              this._grabCollisionMissLeft = 0;
            } else {
              this._grabReleaseBaselineRight = baseline;
              this._grabCollisionMissRight = 0;
            }
          }
        },

        _shouldReleaseGrab: function (hand, ctrl, anchorWorld, collisionHit) {
          const missKey = hand === 'left' ? '_grabCollisionMissLeft' : '_grabCollisionMissRight';
          const baseline = hand === 'left' ? this._grabReleaseBaselineLeft : this._grabReleaseBaselineRight;

          if (!collisionHit) {
            this[missKey] = (this[missKey] || 0) + 1;
            return this[missKey] > 10;
          }

          this[missKey] = 0;

          if (!ctrl || !anchorWorld) {
            return false;
          }

          ctrl.object3D.getWorldPosition(this._grabPullTmp);
          const dist = this._grabPullTmp.distanceTo(anchorWorld);
          return dist > baseline + this.grabReleaseDist;
        },

        _getGrabLockedHandLocal: function (hand) {
          if (hand === 'left' && this._grabHandLockLeft) {
            return this._grabLockedHandQuatLeft;
          }
          if (hand === 'right' && this._grabHandLockRight) {
            return this._grabLockedHandQuatRight;
          }
          return null;
        },

        _getGrabLockedHandWorld: function (hand) {
          const rag = this._ragdollArmHold?.[hand];
          if (rag?.active && rag.hasHandQuat) return rag.handQuat;
          if (hand === 'left' && this._grabHandLockLeft) {
            return this._grabLockedHandWorldLeft;
          }
          if (hand === 'right' && this._grabHandLockRight) {
            return this._grabLockedHandWorldRight;
          }
          return null;
        },

        _lockGrabHandOrientation: function (hand, handBone) {
          const localQuat = hand === 'left' ? this._grabLockedHandQuatLeft : this._grabLockedHandQuatRight;
          const worldQuat = hand === 'left' ? this._grabLockedHandWorldLeft : this._grabLockedHandWorldRight;
          const lockFlag = hand === 'left' ? '_grabHandLockLeft' : '_grabHandLockRight';
          localQuat.copy(handBone.quaternion);
          handBone.getWorldQuaternion(worldQuat);
          this[lockFlag] = true;
        },

        _getGrabSurfaceFingerCurls: function () {
          // Open hand â€” fingertips reach the surface, not a power grip fist.
          return {
            thumb: 0.08,
            index: -0.02,
            middle: 0,
            ring: 0.02,
            pinky: 0.05
          };
        },

        _applyGrabSurfaceFingerTargets: function (hand) {
          const grabbing = hand === 'left' ? this._grabAnchorActiveLeft : this._grabAnchorActiveRight;
          if (!grabbing) return;
          const surface = hand === 'left' ? this._grabSurfaceContactLeft : this._grabSurfaceContactRight;
          if (!surface) return;
          this.targetCurls[hand] = this._getGrabSurfaceFingerCurls();
        },

        _resetGrabFingerCurls: function (hand) {
          const open = this._getGrabSurfaceFingerCurls();
          this.targetCurls[hand] = Object.assign({}, open);
          this.currentCurls[hand] = Object.assign({}, open);
        },

        _estimatePalmNormalFromPhysics: function (palmPos, destNormal) {
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (!legIk || !legIk.physics || !legIk.physics.castRay) {
            destNormal.set(0, 1, 0);
            return;
          }
          const radius = this.palmProbeRadius;
          const origin = palmPos.clone();
          const dirs = [
            [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
          ];
          let bestDist = Infinity;
          const tmp = new THREE.Vector3();
          for (let i = 0; i < dirs.length; i++) {
            tmp.set(dirs[i][0], dirs[i][1], dirs[i][2]);
            const rayOrigin = origin.clone().addScaledVector(tmp, radius * 0.5);
            const hit = legIk.physics.castRay(rayOrigin, tmp, radius * 2.5);
            if (!hit) continue;
            const hp = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
            const dist = rayOrigin.distanceTo(hp);
            if (dist < bestDist) {
              bestDist = dist;
              destNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
              if (destNormal.lengthSq() < 1e-8) destNormal.set(0, 1, 0);
              else destNormal.normalize();
            }
          }
          if (bestDist === Infinity) destNormal.set(0, 1, 0);
        },

        _enforceGrabPalmClear: function () {
          /* removed: smooth palm contact avoids iterative palm teleport */
        },

        _conformGrabbingFingersToSurface: function () { /* removed: smooth collision */ },


        _finalizeSurfaceGrabHands: function () { /* removed: smooth collision */ },


        _restoreHandBoneRestPosition: function (hand) {
          const handBone = this.bones[`${hand}HandBone`];
          if (!handBone || !this.initialBonePositions) return;
          const rest = this.initialBonePositions[handBone.name];
          if (rest) handBone.position.copy(rest);
        },

        // Hold the wrist at lockedWristWorld without touching handBone.position
        // (which severs the Mixamo wristâ†’forearm bind). Compensates residual IK
        // error by nudging the IK target and re-solving â€” hierarchy stays intact.
        _solveFrozenGrabWrist: function (hand, handBone, lockedWristWorld, targetHandPos, applyTwoBoneIK) {
          this._restoreHandBoneRestPosition(hand);
          const corr = hand === 'left' ? this._grabWristCorrLeft : this._grabWristCorrRight;
          const err = this._grabWristErrTmp;
          targetHandPos.copy(lockedWristWorld).add(corr);
          applyTwoBoneIK(true);
          for (let i = 0; i < 2; i++) {
            this.model.updateMatrixWorld(true);
            if (this.skeleton) this.skeleton.update();
            handBone.getWorldPosition(err);
            err.subVectors(lockedWristWorld, err);
            if (err.lengthSq() < 1e-10) break;
            corr.add(err);
            targetHandPos.copy(lockedWristWorld).add(corr);
            applyTwoBoneIK(true);
          }
          // Soft-cap correction so a bad frame can't accumulate forever.
          const maxCorr = 0.12;
          if (corr.lengthSq() > maxCorr * maxCorr) {
            corr.setLength(maxCorr);
          }
        },

        _releaseGrabHand: function (hand) {
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (legIk && legIk._handLastTrack) {
            legIk._handLastTrack[hand] = null;
          }
          this._restoreHandBoneRestPosition(hand);
          if (hand === 'left') {
            this._grabAnchorActiveLeft = false;
            this._hasStablePalmLeft = false;
            this._hasPalmTrackLeft = false;
            this._hasSmoothCollPalmLeft = false;
            this._smoothCollHitLeft = false;
            this._grabCollisionMissLeft = 0;
            this._grabHandLockLeft = false;
            this._grabWristLockLeft = false;
            this._grabSurfaceContactLeft = false;
            this._hasSmoothedPalmContactLeft = false;
            this._grabFingersFrozenLeft = false;
            this._grabFingerSettleLeft = 0;
            this._grabFrozenCurlsLeft = null;
            this._grabWristCorrLeft.set(0, 0, 0);
          } else {
            this._grabAnchorActiveRight = false;
            this._hasStablePalmRight = false;
            this._hasPalmTrackRight = false;
            this._hasSmoothCollPalmRight = false;
            this._smoothCollHitRight = false;
            this._grabCollisionMissRight = 0;
            this._grabHandLockRight = false;
            this._grabWristLockRight = false;
            this._grabSurfaceContactRight = false;
            this._hasSmoothedPalmContactRight = false;
            this._grabFingersFrozenRight = false;
            this._grabFingerSettleRight = 0;
            this._grabFrozenCurlsRight = null;
            this._grabWristCorrRight.set(0, 0, 0);
          }
        },

        _updateGrabPullLocomotion: function (dt) {
          if (this.data.isMirror) return;
          // CapVR: BoltVR owns wall grabs — never start mixamo grab-pull (teleports #rig).
          const player = document.getElementById('player');
          const rig = document.getElementById('rig');
          if (player && rig && player.contains(rig) && player.components?.['zerog-player']) {
            const legIk = this.el.sceneEl?.components?.['leg-ik-world'];
            if (legIk) legIk.grabPullLocomotionActive = false;
            return;
          }

          const legIk = this.el.sceneEl.components['leg-ik-world'];
          if (!legIk || !legIk.applyGrabPullMovementDelta) return;

          const grabbing = this._grabAnchorActiveLeft || this._grabAnchorActiveRight;

          if (this._grabPullWasActive && !grabbing && legIk.transferGrabPullMomentum) {
            legIk.transferGrabPullMomentum();
          }

          if (grabbing && !this._grabPullWasActive) {
            this.horizontalSpeed = 0;
            this._smoothedHorizontalSpeed = 0;
            this._resetMoveYawTwist();
            if (legIk.playerMoveDir) {
              legIk.playerMoveDir.set(0, 0, 0);
            }
            legIk.playerSpeed = 0;
          }

          legIk.grabPullLocomotionActive = grabbing;
          this._grabPullWasActive = grabbing;

          if (!grabbing) {
            if (legIk._ledgeMantleActive && legIk.clearLedgeMantle) {
              legIk.clearLedgeMantle();
            }
            this._grabPullLastRigPosActive = false;
            return;
          }

          const refObj = this._getGrabPullRefObject3D();
          if (!refObj) return;

          const curRig = this._leftCtrlWorldTmp;
          if (legIk.physics) {
            const p = legIk.physics.getPlayerTranslation();
            curRig.set(p.x, p.y, p.z);
          } else if (this.rig) {
            this.rig.object3D.getWorldPosition(curRig);
          } else {
            return;
          }

          const rigDeltaLocal = this._grabPullRigDeltaLocalTmp;
          rigDeltaLocal.set(0, 0, 0);
          if (this._grabPullLastRigPosActive) {
            rigDeltaLocal.set(
              curRig.x - this._grabPullLastRigPos.x,
              curRig.y - this._grabPullLastRigPos.y,
              curRig.z - this._grabPullLastRigPos.z
            );
            refObj.getWorldQuaternion(this._grabPullQuatTmp);
            this._grabPullInvQuatTmp.copy(this._grabPullQuatTmp).invert();
            rigDeltaLocal.applyQuaternion(this._grabPullInvQuatTmp);
          }

          const localCur = this._grabPullLocalTmp;
          const localDelta = this._grabPullLocalDeltaTmp;
          const pull = this._grabPullTmp;
          pull.set(0, 0, 0);
          let pullCount = 0;

          if (this._grabAnchorActiveLeft && this.leftController) {
            this._readControllerInGrabPullSpace(this.leftController, localCur);
            localDelta.subVectors(localCur, this._grabLastCtrlLocalLeft);
            localDelta.sub(rigDeltaLocal);
            this._grabLastCtrlLocalLeft.copy(localCur);
            pull.sub(localDelta);
            pullCount++;
          }

          if (this._grabAnchorActiveRight && this.rightController) {
            this._readControllerInGrabPullSpace(this.rightController, localCur);
            localDelta.subVectors(localCur, this._grabLastCtrlLocalRight);
            localDelta.sub(rigDeltaLocal);
            this._grabLastCtrlLocalRight.copy(localCur);
            pull.sub(localDelta);
            pullCount++;
          }

          if (pullCount > 1) {
            pull.multiplyScalar(1 / pullCount);
          }

          pull.applyQuaternion(refObj.getWorldQuaternion(this._grabPullQuatTmp));

          const climbHints = {
            waistOffset: this.modelHipsLocalY || 1.02,
            grabAnchors: []
          };
          if (this._grabAnchorActiveLeft) climbHints.grabAnchors.push(this._grabAnchorLeft);
          if (this._grabAnchorActiveRight) climbHints.grabAnchors.push(this._grabAnchorRight);
          legIk.applyGrabPullMovementDelta(pull, dt, climbHints);

          if (legIk.physics) {
            const p = legIk.physics.getPlayerTranslation();
            this._grabPullLastRigPos.set(p.x, p.y, p.z);
          } else {
            this._grabPullLastRigPos.copy(curRig);
          }
          this._grabPullLastRigPosActive = true;
        },

        _nudgeWristForPalmSkinContact: function (hand, handBone, desiredSkinWorld, targetHandPos, applyTwoBoneIK) {
          // Move the wrist until the palm SKIN point (not the probe center) sits on
          // the surface target. This is what actually makes the palm touch objects.
          const tmp = this._palmWorldTmp2 || new THREE.Vector3();
          const firstSkin = this._getHandPalmContactWorldPos(hand, tmp);
          const initialErr = desiredSkinWorld.distanceTo(firstSkin);
          if (initialErr < 1e-5) return;
          if (initialErr > 1.5) return;

          for (let iter = 0; iter < 8; iter++) {
            const curSkin = this._getHandPalmContactWorldPos(hand, tmp);
            const err = desiredSkinWorld.clone().sub(curSkin);
            if (err.lengthSq() < 1e-8) break;
            targetHandPos.add(err);
            applyTwoBoneIK(true);
          }
        },

        _nudgeWristForPalmContact: function (hand, handBone, desiredProbe, targetHandPos, applyTwoBoneIK, dt, maxStepScale) {
          // Move the wrist so the palm probe lands on the collision-corrected point.
          const tmp = this._palmWorldTmp2 || new THREE.Vector3();
          const firstProbe = this._getHandPalmProbeWorldPos(hand, tmp);
          const initialErr = desiredProbe.distanceTo(firstProbe);
          if (initialErr < 1e-5) return;
          if (initialErr > 1.5) return;

          for (let iter = 0; iter < 8; iter++) {
            const curProbe = this._getHandPalmProbeWorldPos(hand, tmp);
            const err = desiredProbe.clone().sub(curProbe);
            if (err.lengthSq() < 1e-8) break;
            targetHandPos.add(err);
            applyTwoBoneIK(true);
          }
        },

        _applyAnchoredPalmIK: function (hand, handBone, handWorldQuat, palmTarget, targetHandPos, applyTwoBoneIK) {
          this._nudgeWristForPalmContact(
            hand, handBone, palmTarget, targetHandPos, applyTwoBoneIK, this._handHapticDt || 0.016, 1
          );
        },

        _setHandDebugSphereScale: function (group, worldRadius) {
          const baseRadius = this.palmProbeRadius;
          const scale = worldRadius / baseRadius;
          group.scale.set(scale, scale, scale);
        },

        _createPlayerCapsuleWireframe: function (radius, cylLen, midY) {
          const group = new THREE.Group();
          group.name = 'player-body-collision-wireframe';

          const geo = new THREE.CapsuleGeometry(radius, cylLen, 10, 20);
          const wire = new THREE.Mesh(
            geo,
            new THREE.MeshBasicMaterial({
              color: 0xffcc33,
              wireframe: true,
              transparent: true,
              opacity: 0.95,
              depthTest: false,
              depthWrite: false
            })
          );
          wire.renderOrder = 1002;
          wire.position.y = midY;
          group.add(wire);

          const fill = new THREE.Mesh(
            geo.clone(),
            new THREE.MeshBasicMaterial({
              color: 0xffcc33,
              wireframe: false,
              transparent: true,
              opacity: 0.07,
              depthTest: false,
              depthWrite: false
            })
          );
          fill.renderOrder = 1001;
          fill.position.y = midY;
          group.add(fill);

          const cap = this.el.sceneEl.components['leg-ik-world']?.physics?.capsule;
          if (cap) {
            const endMat = new THREE.MeshBasicMaterial({
              color: 0xffffff,
              wireframe: true,
              transparent: true,
              opacity: 0.85,
              depthTest: false,
              depthWrite: false
            });
            const endGeo = new THREE.SphereGeometry(radius * 0.22, 8, 6);
            const end1 = new THREE.Mesh(endGeo, endMat);
            end1.renderOrder = 1003;
            end1.position.set(cap.center1.x, cap.center1.y, cap.center1.z);
            group.add(end1);
            const end2 = new THREE.Mesh(endGeo.clone(), endMat.clone());
            end2.renderOrder = 1003;
            end2.position.set(cap.center2.x, cap.center2.y, cap.center2.z);
            group.add(end2);
          }

          group.frustumCulled = false;
          group.visible = false;
          return { group, wire, fill };
        },

        _updatePlayerBodyCollisionWireframe: function () {
          if (this.data.isMirror || !this.showPlayerBodyCollisionDebug) {
            if (this._playerBodyDebug) {
              this._playerBodyDebug.group.visible = false;
            }
            return;
          }

          const legIk = this.el.sceneEl.components['leg-ik-world'];
          const physics = legIk?.physics;
          if (!physics || physics.playerColliderDisabled || !physics.capsule) {
            if (this._playerBodyDebug) {
              this._playerBodyDebug.group.visible = false;
            }
            return;
          }

          const cap = physics.capsule;
          const r = cap.radius;
          const c1y = cap.center1.y;
          const c2y = cap.center2.y;
          const cylLen = Math.max(0.001, c2y - c1y);
          const midY = (c1y + c2y) * 0.5;
          const geoKey = r.toFixed(3) + '_' + cylLen.toFixed(3);

          if (!this._playerBodyDebug) {
            const built = this._createPlayerCapsuleWireframe(r, cylLen, midY);
            this._playerBodyDebug = built;
            this.el.sceneEl.object3D.add(built.group);
            this._playerCapsuleGeoKey = geoKey;
          } else if (this._playerCapsuleGeoKey !== geoKey) {
            const built = this._createPlayerCapsuleWireframe(r, cylLen, midY);
            this.el.sceneEl.object3D.remove(this._playerBodyDebug.group);
            if (this._playerBodyDebug.wire?.geometry) {
              this._playerBodyDebug.wire.geometry.dispose();
            }
            if (this._playerBodyDebug.fill?.geometry) {
              this._playerBodyDebug.fill.geometry.dispose();
            }
            this._playerBodyDebug = built;
            this.el.sceneEl.object3D.add(built.group);
            this._playerCapsuleGeoKey = geoKey;
          }

          const p = physics.getPlayerTranslation();
          this._playerBodyDebug.group.position.set(p.x, p.y, p.z);
          this._playerBodyDebug.group.visible = true;
        },

        _createHandCollisionWireframe: function (color, radiusScale, filled) {
          const radius = this.palmProbeRadius * (radiusScale || 1);
          const group = new THREE.Group();
          group.name = 'hand-collision-wireframe';

          const wire = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 16, 12),
            new THREE.MeshBasicMaterial({
              color: color,
              wireframe: true,
              transparent: true,
              opacity: 0.95,
              depthTest: false,
              depthWrite: false
            })
          );
          wire.renderOrder = 1001;
          group.add(wire);

          if (filled) {
            const solid = new THREE.Mesh(
              new THREE.SphereGeometry(radius * 0.98, 14, 10),
              new THREE.MeshBasicMaterial({
                color: color,
                wireframe: false,
                transparent: true,
                opacity: 0.12,
                depthTest: false,
                depthWrite: false
              })
            );
            solid.renderOrder = 1000;
            group.add(solid);
          }

          group.frustumCulled = false;
          group.visible = false;
          group.userData.collisionRadius = radius;
          return group;
        },

        _makeDebugLine: function (color) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
          const mat = new THREE.LineBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.9,
            depthTest: false,
            depthWrite: false
          });
          const line = new THREE.Line(geo, mat);
          line.renderOrder = 1002;
          line.frustumCulled = false;
          line.visible = false;
          return line;
        },

        _setDebugLine: function (line, from, to, visible) {
          if (!line) return;
          if (!visible || !from || !to) {
            line.visible = false;
            return;
          }
          const pos = line.geometry.attributes.position;
          pos.setXYZ(0, from.x, from.y, from.z);
          pos.setXYZ(1, to.x, to.y, to.z);
          pos.needsUpdate = true;
          line.geometry.computeBoundingSphere();
          line.visible = true;
        },

        _createFingerCollisionWireframes: function (hand, color) {
          const fingerRadius = this.fingerCollisionRadius;
          const scale = fingerRadius / this.palmProbeRadius;
          const names = ['thumb', 'index', 'middle', 'ring', 'pinky'];
          const prefix = hand === 'left' ? 'left' : 'right';
          return names.map((name) => {
            const cap = name.charAt(0).toUpperCase() + name.slice(1);
            const bone = this.bones[`${prefix}Hand${cap}3`];
            const g = this._createHandCollisionWireframe(color, scale, false);
            g.name = 'finger-collision-' + name;
            if (bone) {
              bone.add(g);
              const tipLocal = this._fingerTipLocal[hand][name];
              if (tipLocal) g.position.copy(tipLocal);
            }
            return g;
          });
        },

        _initHandCollisionWireframes: function () {
          if (this.data.isMirror || this._handWireframesReady) return;
          if (!this.bones.leftHandBone || !this.bones.leftHandIndex3) return;

          const sceneRoot = this.el.sceneEl.object3D;
          const attachHand = (side) => {
            const handBone = this.bones[`${side}HandBone`];
            const probeLocal = side === 'left' ? this._palmProbeLocalLeft : this._palmProbeLocalRight;
            const contactLocal = side === 'left' ? this._palmContactLocalLeft : this._palmContactLocalRight;
            const palmColor = side === 'left' ? 0x66ff99 : 0x66ccff;
            const fingerColor = side === 'left' ? 0xaaffcc : 0xaaddee;

            // Palm sphere + skin marker live in WORLD space (scene root) and are
            // positioned every frame. Parenting them to the hand bone inherits the
            // arm's non-uniform stretch scale, which distorts/hides the wireframe.
            const primary = this._createHandCollisionWireframe(palmColor, 1, true);
            primary.name = 'palm-collision-sphere';
            sceneRoot.add(primary);

            const probeMarker = this._createHandCollisionWireframe(palmColor, 0.35, false);
            probeMarker.name = 'palm-skin-marker';
            sceneRoot.add(probeMarker);

            const penetration = this._createHandCollisionWireframe(0xff4444, 1, false);
            sceneRoot.add(penetration);

            const fingers = this._createFingerCollisionWireframes(side, fingerColor);

            // Debug ray lines (world space, parented to scene root).
            const wristLineColor = side === 'left' ? 0xffdd33 : 0xffaa33;
            const wristLine = this._makeDebugLine(wristLineColor);
            sceneRoot.add(wristLine);
            const ragdollLineColor = side === 'left' ? 0xff66ff : 0xcc66ff;
            const ragdollLine = this._makeDebugLine(ragdollLineColor);
            ragdollLine.name = 'ragdoll-palm-ray';
            sceneRoot.add(ragdollLine);
            const ragdollSkinLineColor = side === 'left' ? 0xff99cc : 0xdd88ff;
            const ragdollSkinLine = this._makeDebugLine(ragdollSkinLineColor);
            ragdollSkinLine.name = 'ragdoll-skin-to-surface';
            sceneRoot.add(ragdollSkinLine);
            const ragdollHitMarker = this._createHandCollisionWireframe(ragdollLineColor, 0.28, true);
            ragdollHitMarker.name = 'ragdoll-surface-hit';
            sceneRoot.add(ragdollHitMarker);
            const fingerLines = {};
            ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach((name) => {
              const line = this._makeDebugLine(fingerColor);
              sceneRoot.add(line);
              fingerLines[name] = line;
            });

            return { primary, probeMarker, penetration, fingers, wristLine, ragdollLine, ragdollSkinLine, ragdollHitMarker, fingerLines };
          };

          this._leftHandDebug = attachHand('left');
          this._rightHandDebug = attachHand('right');
          this._handWireframesReady = true;
        },

        _setHandWireframeVisibility: function (hand, visible) {
          const visuals = hand === 'left' ? this._leftHandDebug : this._rightHandDebug;
          if (!visuals) return;
          visuals.primary.visible = visible;
          if (visuals.probeMarker) visuals.probeMarker.visible = visible;
          if (visuals.fingers) visuals.fingers.forEach((f) => { f.visible = visible; });
          if (!visible) {
            if (visuals.penetration) visuals.penetration.visible = false;
            if (visuals.wristLine) visuals.wristLine.visible = false;
            if (visuals.ragdollLine) visuals.ragdollLine.visible = false;
            if (visuals.ragdollSkinLine) visuals.ragdollSkinLine.visible = false;
            if (visuals.ragdollHitMarker) visuals.ragdollHitMarker.visible = false;
            if (visuals.fingerLines) {
              Object.keys(visuals.fingerLines).forEach((k) => { visuals.fingerLines[k].visible = false; });
            }
          }
        },

        _updateHandDebugRays: function (hand, visuals) {
          const palmRec = this._palmRayHits[hand];
          const ragComp = document.querySelector('#grab-dummy')?.components['grabbable-ragdoll'];

          // Same palm world point as the orange static-environment line.
          const palmTmp = this._palmWorldTmp || new THREE.Vector3();
          const palm = palmRec?.palm
            ? palmTmp.copy(palmRec.palm)
            : this._getHandPalmContactWorldPos(hand, palmTmp);

          const ragRec = ragComp?.isPalmNearRagdoll?.(palm)
            ? ragComp.projectPalmOntoRagdoll?.(hand, palm)
            : null;
          const ragNear = !!(ragRec && ragRec.near);

          // Magenta: same palm â†’ visible ragdoll limb surface (only within touch radius).
          if (visuals.ragdollLine) {
            if (ragNear && ragRec.palm && ragRec.hit) {
              this._setDebugLine(visuals.ragdollLine, ragRec.palm, ragRec.hit, true);
            } else {
              this._setDebugLine(visuals.ragdollLine, null, null, false);
            }
          }
          if (visuals.ragdollSkinLine) {
            visuals.ragdollSkinLine.visible = false;
          }
          if (visuals.ragdollHitMarker) {
            if (ragNear && ragRec.hit) {
              visuals.ragdollHitMarker.visible = true;
              visuals.ragdollHitMarker.position.copy(ragRec.hit);
            } else {
              visuals.ragdollHitMarker.visible = false;
            }
          }

          // Orange: palm â†’ static environment (independent of ragdoll).
          if (visuals.wristLine) {
            if (palmRec && palmRec.palm && palmRec.hit) {
              this._setDebugLine(visuals.wristLine, palmRec.palm, palmRec.hit, true);
            } else {
              this._setDebugLine(visuals.wristLine, null, null, false);
            }
          }

          // Each fingertip â†’ surface hit point from the latest surface raycast.
          if (visuals.fingerLines) {
            const hits = this._fingerRayHits[hand] || {};
            ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach((name) => {
              const line = visuals.fingerLines[name];
              const rec = hits[name];
              if (rec && rec.tip && rec.hit) {
                this._setDebugLine(line, rec.tip, rec.hit, true);
              } else {
                this._setDebugLine(line, null, null, false);
              }
            });
          }
        },

        _updateHandCollisionDebug: function (hand, debug, palmPos, controllerPos) {
          if (this.data.isMirror || !this._handWireframesReady) return;

          const visuals = hand === 'left' ? this._leftHandDebug : this._rightHandDebug;
          if (!visuals) return;

          if (!this.showHandCollisionDebug) {
            this._setHandWireframeVisibility(hand, false);
            return;
          }

          this._setHandWireframeVisibility(hand, true);

          // Palm collision sphere (large) sits at the live probe center; the small
          // marker sits at the palm skin contact point. Both are world-space.
          if (visuals.primary) {
            const pw = this._primaryProbeTmp || (this._primaryProbeTmp = new THREE.Vector3());
            this._getHandPalmProbeWorldPos(hand, pw);
            visuals.primary.position.copy(pw);
          }
          if (visuals.probeMarker) {
            const cw = this._primaryContactTmp || (this._primaryContactTmp = new THREE.Vector3());
            this._getHandPalmContactWorldPos(hand, cw);
            visuals.probeMarker.position.copy(cw);
          }

          // Keep the finger-tip debug spheres on their (skin-offset) colliders so
          // the wireframe matches where collision actually happens.
          if (visuals.fingers) {
            const prefix = hand === 'left' ? 'left' : 'right';
            const names = ['thumb', 'index', 'middle', 'ring', 'pinky'];
            const wp = this._palmWorldTmp || new THREE.Vector3();
            visuals.fingers.forEach((sphere, i) => {
              const cap = names[i].charAt(0).toUpperCase() + names[i].slice(1);
              const bone = this.bones[`${prefix}Hand${cap}3`];
              if (!bone || !sphere.parent) return;
              this._getFingerColliderWorldPos(hand, names[i], wp);
              sphere.position.copy(sphere.parent.worldToLocal(wp.clone()));
            });
          }

          this._updateHandDebugRays(hand, visuals);

          const ctrl = controllerPos || debug?.controller;
          const contactPt = debug?.contactPoint || debug?.sticky;
          if (debug && debug.hit && ctrl && contactPt) {
            const contactDistance = contactPt.distanceTo(ctrl);
            if (contactDistance > 0.008) {
              visuals.penetration.visible = true;
              visuals.penetration.position.copy(ctrl);
              this._setHandDebugSphereScale(visuals.penetration, Math.max(contactDistance, 0.001));
            } else {
              visuals.penetration.visible = false;
            }
          } else {
            visuals.penetration.visible = false;
          }
        },

        _updateHandCollisionWireframes: function () {
          if (!this.showHandCollisionDebug) {
            this._setHandWireframeVisibility('left', false);
            this._setHandWireframeVisibility('right', false);
            return;
          }

          if (!this.data.isMirror) {
            this._initHandCollisionWireframes();
          }
          if (!this._handWireframesReady) return;

          if (this.skeleton && this.model) {
            this.model.updateMatrixWorld(true);
            this.skeleton.update();
          }

          // Palm raycast after arm IK so the orange line matches the current pose.
          this._raycastPalmToNearestSurface('left');
          this._raycastPalmToNearestSurface('right');

          if (!this._palmWorldTmp) this._palmWorldTmp = new THREE.Vector3();
          if (!this._palmWorldTmp2) this._palmWorldTmp2 = new THREE.Vector3();
          if (!this._leftCtrlWorldTmp) this._leftCtrlWorldTmp = new THREE.Vector3();
          if (!this._rightCtrlWorldTmp) this._rightCtrlWorldTmp = new THREE.Vector3();

          let leftPalm = null;
          let rightPalm = null;

          if (this.skeleton) {
            leftPalm = this._getHandPalmWorldPos('left', this._palmWorldTmp);
            rightPalm = this._getHandPalmWorldPos('right', this._palmWorldTmp2);
          }

          let leftCtrl = null;
          let rightCtrl = null;
          if (this.leftController) {
            leftCtrl = this._leftCtrlWorldTmp;
            this.leftController.object3D.getWorldPosition(leftCtrl);
          }
          if (this.rightController) {
            rightCtrl = this._rightCtrlWorldTmp;
            this.rightController.object3D.getWorldPosition(rightCtrl);
          }

          this._updateHandCollisionDebug('left', this._handCollisionDebugLeft, leftPalm, leftCtrl);
          this._updateHandCollisionDebug('right', this._handCollisionDebugRight, rightPalm, rightCtrl);
        },

        updateLocalBody: function(dt) {
          const track = this._trackingTmp || (this._trackingTmp = {
            headPos: new THREE.Vector3(),
            headQuat: new THREE.Quaternion(),
            leftPos: new THREE.Vector3(),
            leftQuat: new THREE.Quaternion(),
            rightPos: new THREE.Vector3(),
            rightQuat: new THREE.Quaternion(),
            space: 'world'
          });
          this._readTrackingTransforms(track);

          const headWorldPos = new THREE.Vector3();
          const headWorldQuat = new THREE.Quaternion();
          const leftHandWorldPos = new THREE.Vector3();
          const leftHandWorldQuat = new THREE.Quaternion();
          const rightHandWorldPos = new THREE.Vector3();
          const rightHandWorldQuat = new THREE.Quaternion();
          this.camera.object3D.getWorldPosition(headWorldPos);
          this.camera.object3D.getWorldQuaternion(headWorldQuat);
          this.leftController.object3D.getWorldPosition(leftHandWorldPos);
          this.leftController.object3D.getWorldQuaternion(leftHandWorldQuat);
          this.rightController.object3D.getWorldPosition(rightHandWorldPos);
          this.rightController.object3D.getWorldQuaternion(rightHandWorldQuat);

          this._applyRagdollDummyArmHold(leftHandWorldPos, rightHandWorldPos);

          if (!this.useAnimatedLocomotion) {
            this.calculateTorsoOrientation(
              track.headPos, track.headQuat,
              track.leftPos, track.rightPos,
              dt
            );
          }
          this.calculateBodyTilt(track.headPos, track.leftPos, track.rightPos, dt);

          if (!this.data.isMirror) {
            this._updateZeroGLegModeBlend(dt);
          }

          const footRoot = this._getLegIKFootRoot(headWorldPos);
          this._anchorBodyAtFeet(footRoot);

          this._handHapticDt = dt;
          this._updateGrabPullLocomotion(dt);

          const legIkWorld = this.el.sceneEl.components['leg-ik-world'];
          const mantleAmt = legIkWorld ? (legIkWorld.mantleCrouchAmount || 0) : 0;
          const mantleActive = legIkWorld && (legIkWorld._ledgeMantleActive || mantleAmt > 0.01);

          const legBlend = this._zeroGLegModeBlend;
          const zeroG = this._isZeroGMode();
          const suppressWalkAnim = zeroG && legBlend > 0.85;
          if (this.useAnimatedLocomotion && !suppressWalkAnim) {
            if (mantleActive) {
              if (this.bones.hips && this._standingHipsLocalY !== undefined) {
                this._animatedHipsLocalY = this._standingHipsLocalY;
              } else if (this.bones.hips) {
                this._animatedHipsLocalY = this.bones.hips.position.y;
              }
              this._applyMantleCrouchBlend(dt, mantleAmt);
            } else {
              this._updateLocomotionAnimation(dt);
            }
          } else if (!this.data.isMirror) {
            this._hideLocalHeadMesh();
            if (mantleActive && !suppressWalkAnim) {
              this._applyMantleCrouchBlend(dt, mantleAmt);
            }
          }

          this._applyPreLegIKPosture(headWorldPos);
          this._applyLegIKTerrain(dt, footRoot);
          if (legBlend < 0.12) this._applyPostLegIKGrounding(headWorldPos, dt);
          this._updateLegDebug();

          this.updateBones(headWorldPos, headWorldQuat, leftHandWorldPos, rightHandWorldPos, leftHandWorldQuat, rightHandWorldQuat, dt);

          if (this._pendingFootCalibration) {
            this._finalizeCalibrationFromFeet();
          }

          if (mantleActive) {
            this._applyMantleCrouchBlend(dt, mantleAmt);
          } else if (this._wasMantleCrouching && this.bones.hips) {
            const standY = this._standingHipsLocalY ?? this._animatedHipsLocalY;
            if (standY !== undefined) {
              this.bones.hips.position.y = standY;
            }
            this._crouchAnimWeight = 0;
            if (this.animClips.crouchStand && this.mixer) {
              this.mixer.clipAction(this.animClips.crouchStand).setEffectiveWeight(0);
            }
          }
          this._wasMantleCrouching = !!mantleActive;

          if (
            legIkWorld &&
            legIkWorld._checkHeadCollision &&
            (this._grabAnchorActiveLeft || this._grabAnchorActiveRight)
          ) {
            legIkWorld._checkHeadCollision(true);
          }

          this._updatePlayerBodyCollisionWireframe();
        },

        _refreshHandCollisionDebugAfterRagdoll: function () {
          if (!this.showHandCollisionDebug || this.data.isMirror) return;
          this._updateHandCollisionWireframes();
        },

        _publishPoseSnapshot: function() {
          if (this.data.isMirror || !this.skeleton || !this.model) return;
          const bones = {};
          for (let i = 0; i < this.skeleton.bones.length; i++) {
            const bone = this.skeleton.bones[i];
            const useRestHeadPos = bone === this.bones.head || bone === this.bones.headTop;
            bones[bone.name] = {
              q: bone.quaternion.clone(),
              p: useRestHeadPos && this.initialBonePositions[bone.name]
                ? this.initialBonePositions[bone.name].clone()
                : bone.position.clone(),
              s: bone.scale.clone()
            };
          }
          this._poseSnapshot = {
            modelY: this.model.position.y,
            modelScaleY: this.model.scale.y,
            headFacingQuat: this._headFacingQuat.clone(),
            torsoRotation: this.torsoRotation.clone(),
            entityWorldPos: new THREE.Vector3(),
            entityWorldQuat: new THREE.Quaternion(),
            bones
          };
          this.el.object3D.getWorldPosition(this._poseSnapshot.entityWorldPos);
          this.el.object3D.getWorldQuaternion(this._poseSnapshot.entityWorldQuat);
          this.el.sceneEl._localBodyPoseSnapshot = this._poseSnapshot;
        },

        // Mirror is a spatial clone of the local skeleton â€” one pose solve, copied each frame.
        syncPoseFromLocal: function() {
          const localEl = document.querySelector('#local-body');
          const local = localEl?.components['mixamo-body'];
          const snap = local?._poseSnapshot;
          if (!local || !snap || !this.skeleton || !this.model) return;

          this.torsoRotation.copy(snap.torsoRotation);
          this._headFacingQuat.copy(snap.headFacingQuat);

          // Same world placement as the local body, shifted 2 m in scene âˆ’Z (not re-derived from head).
          const mirrorPos = snap.entityWorldPos.clone().add(new THREE.Vector3(0, 0, -this.mirrorDistance));
          const facing = snap.entityWorldQuat.clone();

          if (this.manualRotationY !== 0) {
            const headWorldPos = new THREE.Vector3();
            this.camera.object3D.getWorldPosition(headWorldPos);
            const mirrorCenter = new THREE.Vector3(
              headWorldPos.x,
              headWorldPos.y - 0.3,
              headWorldPos.z - this.mirrorDistance
            );
            const rot = new THREE.Matrix4().makeRotationY(this.manualRotationY);
            mirrorPos.sub(mirrorCenter).applyMatrix4(rot).add(mirrorCenter);
            const manualQuat = new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(0, 1, 0),
              this.manualRotationY
            );
            facing.premultiply(manualQuat);
          }

          this.el.object3D.position.copy(mirrorPos);
          this.el.object3D.quaternion.copy(facing);

          this.model.position.y = snap.modelY;
          this.model.scale.set(1, snap.modelScaleY, 1);

          for (let i = 0; i < this.skeleton.bones.length; i++) {
            const bone = this.skeleton.bones[i];
            const src = snap.bones[bone.name];
            if (!src) continue;
            bone.quaternion.copy(src.q);
            bone.position.copy(src.p);
            if (bone === this.bones.head || bone === this.bones.headTop) {
              bone.scale.set(1, 1, 1);
            } else {
              bone.scale.copy(src.s);
            }
          }
          this.skeleton.update();
        },

        updateMirrorBody: function(dt) {
          // Legacy path â€” mirror now uses syncPoseFromLocal() each frame.
          this.syncPoseFromLocal();
        },

        _isRagdollDummyHeld: function (hand) {
          const comp = document.querySelector('#grab-dummy')?.components['grabbable-ragdoll'];
          const hold = comp?.getPlayerArmHold?.();
          return !!(hold && hold[hand]?.active);
        },

        /** Drop palm sweep history so the next frame re-approaches from the controller. */
        invalidateHandCollisionHistory: function (hand) {
          if (!hand || hand === 'left') {
            this._hasStablePalmLeft = false;
            this._hasPalmTrackLeft = false;
            this._hasSmoothCollPalmLeft = false;
            this._smoothCollHitLeft = false;
            if (this._handProbeLast) this._handProbeLast.left = null;
          }
          if (!hand || hand === 'right') {
            this._hasStablePalmRight = false;
            this._hasPalmTrackRight = false;
            this._hasSmoothCollPalmRight = false;
            this._smoothCollHitRight = false;
            if (this._handProbeLast) this._handProbeLast.right = null;
          }
        },

        /**
         * Temporally smooth the palm probe used for wrist IK so surface contact
         * never stutters, while physics lastStable stays on the raw slide result.
         */
        _smoothHandCollisionProbe: function (hand, rawProbe, dest, dt, hit) {
          const sKey = hand === 'left' ? '_smoothCollPalmLeft' : '_smoothCollPalmRight';
          const hKey = hand === 'left' ? '_hasSmoothCollPalmLeft' : '_hasSmoothCollPalmRight';
          const hitKey = hand === 'left' ? '_smoothCollHitLeft' : '_smoothCollHitRight';
          const smoothed = this[sKey];

          if (!this[hKey]) {
            smoothed.copy(rawProbe);
            this[hKey] = true;
            this[hitKey] = !!hit;
            return dest.copy(smoothed);
          }

          const prev = this._smoothCollPrevTmp || (this._smoothCollPrevTmp = new THREE.Vector3());
          prev.copy(smoothed);

          const rate = hit
            ? (this.handCollisionSmoothRateHit || 18)
            : (this.handCollisionSmoothRateFree || 28);
          const alpha = 1 - Math.exp(-rate * Math.max(dt, 1e-4));
          smoothed.lerp(rawProbe, alpha);

          const maxStepBase = hit
            ? (this.handCollisionMaxStepHit || 0.022)
            : (this.handCollisionMaxStepFree || 0.05);
          const maxStep = maxStepBase * Math.max(dt / 0.016, 0.35);
          const moved = smoothed.distanceTo(prev);
          if (moved > maxStep && moved > 1e-8) {
            const dir = this._palmWorldTmp || new THREE.Vector3();
            dir.subVectors(smoothed, prev).normalize();
            smoothed.copy(prev).addScaledVector(dir, maxStep);
          }

          this[hitKey] = !!hit;
          return dest.copy(smoothed);
        },

        _applyRagdollDummyArmHold: function(leftHandWorldPos, rightHandWorldPos) {
          if (this.data.isMirror) return;
          this._ragdollArmHold.left.active = false;
          this._ragdollArmHold.left.overloaded = false;
          this._ragdollArmHold.left.hasHandQuat = false;
          this._ragdollArmHold.right.active = false;
          this._ragdollArmHold.right.overloaded = false;
          this._ragdollArmHold.right.hasHandQuat = false;
          const comp = document.querySelector('#grab-dummy')?.components['grabbable-ragdoll'];
          if (!comp || !comp.getPlayerArmHold) return;
          const hold = comp.getPlayerArmHold();
          if (hold.left?.active) {
            this._ragdollArmHold.left.active = true;
            this._ragdollArmHold.left.overloaded = !!hold.left.overloaded;
            this._ragdollArmHold.left.wristWorld.copy(hold.left.wristWorld);
            if (hold.left.hasHandQuat && hold.left.handQuat) {
              this._ragdollArmHold.left.handQuat.copy(hold.left.handQuat);
              this._ragdollArmHold.left.hasHandQuat = true;
            }
          }
          if (hold.right?.active) {
            this._ragdollArmHold.right.active = true;
            this._ragdollArmHold.right.overloaded = !!hold.right.overloaded;
            this._ragdollArmHold.right.wristWorld.copy(hold.right.wristWorld);
            if (hold.right.hasHandQuat && hold.right.handQuat) {
              this._ragdollArmHold.right.handQuat.copy(hold.right.handQuat);
              this._ragdollArmHold.right.hasHandQuat = true;
            }
          }
        },

        calculateTorsoOrientation: function(headPos, headQuat, leftHandPos, rightHandPos, dt) {
          const headForwardFlat = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuat);
          headForwardFlat.y = 0;
          if (headForwardFlat.lengthSq() < 1e-6) return;
          headForwardFlat.normalize();
          const shoulderLine = rightHandPos.clone().sub(leftHandPos);
          shoulderLine.y = 0;
          const shoulderDist = shoulderLine.length();
          shoulderLine.normalize();
          
          const controllerForward = new THREE.Vector3().crossVectors(shoulderLine, new THREE.Vector3(0, 1, 0));
          controllerForward.normalize();
          
          if (controllerForward.dot(headForwardFlat) < 0) {
            controllerForward.negate();
          }
          
          // Weight adjustment based on hand distance
          let controllerWeight = 0.8;
          if (shoulderDist < 0.25) {
            controllerWeight = 0.3;
          } else if (shoulderDist > 0.35) {
            controllerWeight = 1.0;
          }
          
          const blendedForward = new THREE.Vector3()
            .addScaledVector(controllerForward, controllerWeight)
            .addScaledVector(headForwardFlat, 1.0 - controllerWeight)
            .normalize();
          
          const targetRotation = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 0, -1),
            blendedForward
          );
          
          if (this.torsoRotation.dot(targetRotation) < 0) {
            targetRotation.negate();
          }
          
          this.torsoRotation.slerp(targetRotation, this.smoothingFactor);
        },

        calculateBodyTilt: function(headPos, leftHandPos, rightHandPos, dt) {
          // Disabled body tilt at entity level to prevent body movement
          // Spine bending is now handled entirely through individual spine bones
          this.bodyTilt.identity();
        },

        updateBones: function(headPos, headQuat, leftHandPos, rightHandPos, leftHandQuat, rightHandQuat, dt) {
          if (!this.useAnimatedLocomotion) {
            if (this.bones.hips) this.bones.hips.quaternion.identity();
            if (this.bones.spine) this.bones.spine.quaternion.identity();
            if (this.bones.spine1) this.bones.spine1.quaternion.identity();
            if (this.bones.spine2) this.bones.spine2.quaternion.identity();
            
            const bodyCenter = headPos.clone();
            bodyCenter.y -= 0.5;
            
            const leftRelative = leftHandPos.clone().sub(bodyCenter);
            const rightRelative = rightHandPos.clone().sub(bodyCenter);
            const avgHandPos = new THREE.Vector3()
              .addVectors(leftRelative, rightRelative)
              .multiplyScalar(0.5);
            
            const invTorsoRot = this.torsoRotation.clone().invert();
            avgHandPos.applyQuaternion(invTorsoRot);
            
            const handForwardLean = Math.max(-0.08, Math.min(0.05, -avgHandPos.z * 0.08));
            const handSideLean = Math.max(-0.08, Math.min(0.08, avgHandPos.x * 0.1));
            
            // Prefer thruster / float velocity in zero-g for torso trail lean.
            const leanSrc = this._isZeroGMode()
              ? this._getZeroGWorldVelocity().clone()
              : this.headVelocity.clone();
            const localVelocity = leanSrc.applyQuaternion(invTorsoRot);
            
            const targetLean = new THREE.Vector3(
              localVelocity.z * 0.8,
              0,
              -localVelocity.x * 0.5
            );
            
            this.torsoLean.lerp(targetLean, this.torsoLeanVelocity);
            
            const totalForwardLean = handForwardLean + this.torsoLean.x;
            const totalSideLean = handSideLean + this.torsoLean.z;
            const breathingExpansion = Math.sin(this.breathingPhase) * this.breathingAmount;
            
            if (this.bones.spine || this.bones.spine1 || this.bones.spine2) {
              const spineRotations = [
                { bone: this.bones.spine, amount: 0.25, breathingAmount: 0.3 },
                { bone: this.bones.spine1, amount: 0.35, breathingAmount: 0.4 },
                { bone: this.bones.spine2, amount: 0.4, breathingAmount: 0.3 }
              ];
              
              spineRotations.forEach(({ bone, amount, breathingAmount }) => {
                if (bone) {
                  const breathingLean = -breathingExpansion * breathingAmount;
                  const euler = new THREE.Euler(
                    -totalForwardLean * amount + breathingLean,
                    0,
                    -totalSideLean * amount,
                    'YXZ'
                  );
                  bone.quaternion.setFromEuler(euler);
                }
              });
            }
          }
          
          // Arms (with forearm twist)
          this.solveArmIK('left', leftHandPos, leftHandQuat, { dt: this._handHapticDt });
          this.solveArmIK('right', rightHandPos, rightHandQuat, { dt: this._handHapticDt });
          
          this._syncVRUpperBodyToHead(headPos, headQuat);

          // Zero-G legs after hip/spine reset â€” blend smoothly with grounded leg IK/animation.
          const legBlend = this._zeroGLegModeBlend;
          if (legBlend > 0.001) {
            if (this.bones.hips && this.initialBonePositions[this.bones.hips?.name]) {
              this.bones.hips.position.copy(this.initialBonePositions[this.bones.hips.name]);
            }
            this._applyZeroGLegs(dt, legBlend);
          } else if (this._isGrabHangActive()) {
            if (this.bones.hips && this.initialBonePositions[this.bones.hips?.name]) {
              this.bones.hips.position.copy(this.initialBonePositions[this.bones.hips.name]);
            }
            this._applyGrabHangLegs(dt);
          }
        },
        
        // Neck follows headset orientation. Head mesh is hidden â€” keep bind-pose head
        // position so extreme look-up pitch does not tear shoulder/arm skinning.
        _syncVRUpperBodyToHead: function(headWorldPos, headWorldQuat) {
          if (this.data.isMirror || !this.bones.head) return;

          const headName = this.bones.head.name;
          if (this.initialBonePositions[headName]) {
            this.bones.head.position.copy(this.initialBonePositions[headName]);
          }
          if (this.bones.headTop) {
            const topName = this.bones.headTop.name;
            if (this.initialBonePositions[topName]) {
              this.bones.headTop.position.copy(this.initialBonePositions[topName]);
            }
          }

          if (this.bones.neck) {
            const relativeHeadQuat = headWorldQuat.clone();
            const invBodyQuat = this._neckInvBodyQuat || (this._neckInvBodyQuat = new THREE.Quaternion());
            this._getBodyWorldQuat(invBodyQuat).invert();
            relativeHeadQuat.premultiply(invBodyQuat);
            const euler = new THREE.Euler().setFromQuaternion(relativeHeadQuat, 'YXZ');
            euler.x = -euler.x;
            euler.z = -euler.z;
            this.bones.neck.quaternion.setFromEuler(euler);
          }
        },

        _measureLegLengths: function() {
          const upLeg = this.bones.leftUpLeg;
          const leg = this.bones.leftLeg;
          const foot = this.bones.leftFoot;
          const hips = this.bones.hips;
          if (!upLeg || !leg || !foot || !hips) return;
          
          this.el.object3D.updateMatrixWorld(true);
          this.model.updateWorldMatrix(true, true);
          
          const kneePos = new THREE.Vector3();
          const footPos = new THREE.Vector3();
          const hipsPos = new THREE.Vector3();
          const thighRoot = new THREE.Vector3();
          
          upLeg.getWorldPosition(thighRoot);
          leg.getWorldPosition(kneePos);
          foot.getWorldPosition(footPos);
          hips.getWorldPosition(hipsPos);
          
          const upper = thighRoot.distanceTo(kneePos);
          const lower = kneePos.distanceTo(footPos);
          if (upper > 0.1 && lower > 0.1) {
            this.config.upperLegLength = upper;
            this.config.lowerLegLength = lower;
          }
          
          const lateral = new THREE.Vector3().subVectors(thighRoot, hipsPos);
          lateral.y = 0;
          const halfWidth = lateral.length();
          if (halfWidth > 0.05) {
            this.config.hipHalfWidth = halfWidth;
          }
        },
        
        getStepParams: function(speed) {
          const moving = speed > this.walkThreshold;
          const length = moving
            ? THREE.MathUtils.clamp(speed * this.config.stepLengthScale, this.config.minStepLength, this.config.maxStepLength)
            : this.config.minStepLength * 0.55;
          const height = moving
            ? THREE.MathUtils.clamp(length * 0.2, 0.035, this.config.maxStepHeight)
            : 0;
          return { length, height, moving };
        },
        
        getFootCycleOffset: function(phase, step) {
          const t = ((phase % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
          const stance = this.config.stanceRatio;
          
          if (!step.moving) {
            return { forward: -step.length * 0.15, height: 0 };
          }
          
          if (t < stance) {
            const u = t / stance;
            return {
              forward: THREE.MathUtils.lerp(step.length * 0.45, -step.length * 0.45, u),
              height: 0
            };
          }
          
          const u = (t - stance) / (1 - stance);
          return {
            forward: THREE.MathUtils.lerp(-step.length * 0.45, step.length * 0.45, u),
            height: Math.sin(u * Math.PI) * step.height
          };
        },
        
        computeFootTargetWorld: function(side, phase, step) {
          const hipsPos = new THREE.Vector3();
          this.bones.hips.getWorldPosition(hipsPos);
          
          const bodyQuat = this._getBodyWorldQuat(this._footBodyQuat || (this._footBodyQuat = new THREE.Quaternion()));
          const bodyForward = new THREE.Vector3(0, 0, -1).applyQuaternion(bodyQuat);
          const bodyRight = new THREE.Vector3(1, 0, 0).applyQuaternion(bodyQuat);
          const offset = this.getFootCycleOffset(phase, step);
          const lateral = (side === 'left' ? -1 : 1) * this.config.hipHalfWidth;
          
          const target = hipsPos.clone()
            .addScaledVector(bodyRight, lateral)
            .addScaledVector(bodyForward, offset.forward);
          
          const legReach = this.config.upperLegLength + this.config.lowerLegLength;
          const groundY = Math.max(0, hipsPos.y - legReach * 0.98);
          target.y = groundY + offset.height;
          
          return target;
        },
        
        smoothFootTarget: function(side, rawTarget, dt) {
          const store = this.footTargets[side];
          if (!store.ready) {
            store.current.copy(rawTarget);
            store.ready = true;
            return store.current;
          }
          const alpha = Math.min(1, dt / this.footTargetSmoothing);
          store.current.lerp(rawTarget, alpha);
          return store.current;
        },
        
        updateLegAnimation: function(dt, horizontalSpeed) {
          if (this.useAnimatedLocomotion || this._isGrabHangActive()) return;
          if (!this.bones.hips || !this.bones.leftUpLeg) return;
          
          this.el.object3D.updateMatrixWorld(true);
          this.model.updateWorldMatrix(true, true);
          
          const step = this.getStepParams(horizontalSpeed);
          
          if (step.moving) {
            const dist = horizontalSpeed * dt;
            this.walkPhase += (dist / step.length) * Math.PI;
          } else {
            this.walkPhase = THREE.MathUtils.lerp(this.walkPhase, 0, Math.min(1, dt * 6));
            this.footTargets.left.ready = false;
            this.footTargets.right.ready = false;
          }
          
          this.solveLegIK('left', this.smoothFootTarget('left', this.computeFootTargetWorld('left', this.walkPhase, step), dt));
          this.solveLegIK('right', this.smoothFootTarget('right', this.computeFootTargetWorld('right', this.walkPhase + Math.PI, step), dt));
        },
        
        solveLegIK: function(side, footWorldPos) {
          const upLegBone = this.bones[side + 'UpLeg'];
          const legBone = this.bones[side + 'Leg'];
          const footBone = this.bones[side + 'Foot'];
          if (!upLegBone || !legBone || !footBone) return;
          
          const hipWorldPos = new THREE.Vector3();
          upLegBone.getWorldPosition(hipWorldPos);
          
          const hipToFoot = footWorldPos.clone().sub(hipWorldPos);
          const distance = hipToFoot.length();
          const maxReach = (this.config.upperLegLength + this.config.lowerLegLength) * 0.999;
          const minReach = Math.abs(this.config.upperLegLength - this.config.lowerLegLength) * 1.001;
          
          let targetFootPos = footWorldPos.clone();
          if (distance > maxReach) {
            targetFootPos = hipWorldPos.clone().add(hipToFoot.normalize().multiplyScalar(maxReach));
          } else if (distance < minReach) {
            targetFootPos = hipWorldPos.clone().add(hipToFoot.normalize().multiplyScalar(minReach));
          }
          
          const toTarget = targetFootPos.clone().sub(hipWorldPos);
          const targetDist = toTarget.length();
          const toTargetDir = toTarget.normalize();
          
          const upperSq = this.config.upperLegLength * this.config.upperLegLength;
          const lowerSq = this.config.lowerLegLength * this.config.lowerLegLength;
          const distSq = targetDist * targetDist;
          const cosAngle = (upperSq + distSq - lowerSq) / (2 * this.config.upperLegLength * targetDist);
          const angle = Math.acos(THREE.MathUtils.clamp(cosAngle, -0.999, 0.999));
          
          const bodyForward = new THREE.Vector3(0, 0, -1).applyQuaternion(
            this._getBodyWorldQuat(this._legIkBodyQuat || (this._legIkBodyQuat = new THREE.Quaternion()))
          );
          let bendDir = bodyForward.clone().multiplyScalar(0.75);
          bendDir.addScaledVector(new THREE.Vector3(0, -1, 0), 0.25);
          bendDir.normalize();
          bendDir.addScaledVector(toTargetDir, -bendDir.dot(toTargetDir)).normalize();
          
          const kneeDir = new THREE.Vector3()
            .addScaledVector(toTargetDir, Math.cos(angle))
            .addScaledVector(bendDir, Math.sin(angle))
            .normalize();
          
          let kneeWorldPos = hipWorldPos.clone().addScaledVector(kneeDir, this.config.upperLegLength);
          
          const hipToKnee = kneeWorldPos.clone().sub(hipWorldPos);
          if (Math.abs(hipToKnee.length() - this.config.upperLegLength) > 0.0001) {
            kneeWorldPos.copy(hipWorldPos).add(hipToKnee.normalize().multiplyScalar(this.config.upperLegLength));
          }
          
          const kneeToFoot = targetFootPos.clone().sub(kneeWorldPos);
          if (Math.abs(kneeToFoot.length() - this.config.lowerLegLength) > 0.0001) {
            targetFootPos.copy(kneeWorldPos).add(kneeToFoot.normalize().multiplyScalar(this.config.lowerLegLength));
          }
          
          this.el.object3D.updateMatrixWorld(true);
          const tPoseDir = new THREE.Vector3(0, -1, 0);
          
          upLegBone.parent.updateMatrixWorld(true);
          const hipInParent = upLegBone.parent.worldToLocal(hipWorldPos.clone());
          const kneeInParent = upLegBone.parent.worldToLocal(kneeWorldPos.clone());
          const thighDir = hipInParent.clone().sub(kneeInParent).normalize();
          upLegBone.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(tPoseDir, thighDir));
          upLegBone.updateMatrixWorld(true);
          
          legBone.parent.updateMatrixWorld(true);
          const kneeInShinParent = legBone.parent.worldToLocal(kneeWorldPos.clone());
          const footInShinParent = legBone.parent.worldToLocal(targetFootPos.clone());
          const shinDir = kneeInShinParent.clone().sub(footInShinParent).normalize();
          legBone.quaternion.copy(new THREE.Quaternion().setFromUnitVectors(tPoseDir, shinDir));
          legBone.updateMatrixWorld(true);
          
          const groundY = Math.max(0, hipWorldPos.y - (this.config.upperLegLength + this.config.lowerLegLength) * 0.98);
          const onGround = targetFootPos.y <= groundY + 0.04;
          if (onGround) {
            const soleDown = new THREE.Vector3(0, -1, 0);
            const footParentQuat = new THREE.Quaternion();
            footBone.parent.getWorldQuaternion(footParentQuat);
            const localDown = soleDown.applyQuaternion(footParentQuat.clone().invert());
            const footAlign = new THREE.Quaternion().setFromUnitVectors(tPoseDir, localDown.normalize());
            footBone.quaternion.copy(footAlign);
          }
        },
        
        updateClavicleRotation: function(hand, handPos, headPos) {
          const shoulderBone = this.bones[`${hand}Shoulder`];
          if (!shoulderBone) return;
          
          // Calculate hand height relative to shoulders (shoulders are ~0.2m below head)
          const shoulderHeight = headPos.y - 0.2;
          const handHeight = handPos.y;
          const heightDiff = handHeight - shoulderHeight;
          
          // Get hand position relative to body center
          const bodyCenter = headPos.clone();
          bodyCenter.y -= 0.5;
          const handRelative = handPos.clone().sub(bodyCenter);
          
          // Convert to body-local space
          const invTorsoRot = this.torsoRotation.clone().invert();
          handRelative.applyQuaternion(invTorsoRot);
          
          // Calculate rotation amounts - EXTREMELY SUBTLE to prevent visual displacement
          // Z-rotation: raise clavicle when arm is raised (0 to ~3 degrees)
          const zRotation = Math.max(0, Math.min(0.05, heightDiff * 0.1)); // Max ~3 degrees
          
          // Y-rotation: protract (forward) when reaching forward (0 to ~2 degrees)
          const yRotation = Math.max(-0.03, Math.min(0.04, -handRelative.z * 0.05)); // Max ~2 degrees
          
          // X-rotation: slight inward rotation when arm extends sideways
          const xRotation = Math.abs(handRelative.x) * 0.015; // Extremely subtle
          
          // Apply rotation (different for left/right due to model orientation)
          const isLeft = (hand === 'left');
          const euler = new THREE.Euler(
            xRotation,
            isLeft ? yRotation : -yRotation,  // Mirror Y for right side
            isLeft ? zRotation : -zRotation,  // Mirror Z for right side
            'YXZ'
          );
          
          shoulderBone.quaternion.setFromEuler(euler);
        },

        solveArmIK: function(hand, handWorldPos, handWorldQuat, opts) {
          opts = opts || {};
          const shoulderBone = this.bones[`${hand}Shoulder`];
          const upperArmBone = this.bones[`${hand}UpperArm`];
          const forearmBone = this.bones[`${hand}Forearm`];
          const handBone = this.bones[`${hand}HandBone`];
          
          if (!shoulderBone || !upperArmBone || !forearmBone) {
            return;
          }
          
          const shoulderWorldPos = new THREE.Vector3();
          shoulderBone.getWorldPosition(shoulderWorldPos);

          // Determine up-front whether this hand is holding a locked grab. When it
          // is, the arm reach/stretch must be measured to the FIXED world hold, not
          // the controller â€” otherwise pulling the controller in shortens the arm
          // and the hand drifts off the hold.
          const wristLocked = hand === 'left' ? this._grabWristLockLeft : this._grabWristLockRight;
          const envLockedWristWorld = hand === 'left' ? this._grabLockedWristWorldLeft : this._grabLockedWristWorldRight;
          const freezeWristWorld = this._ragHoldFreezeWristTmp || (this._ragHoldFreezeWristTmp = new THREE.Vector3());
          let heldGrabFreeze = false;
          const ragHold = !this.data.isMirror ? this._ragdollArmHold[hand] : null;
          const ragDummyHold = !!ragHold?.active;

          // Ragdoll dummy uses the same grip button â€” keep it separate from environment grab.
          // Pin the virtual hand to the weight-limited grab contact (anchor + palmâ†’bone
          // offset). When lift limits bind, the anchor lags the controller and the
          // hand stays on the object â€” that is the weight feel.
          if (ragDummyHold && !this.data.isMirror && handBone) {
            if (hand === 'left' ? this._grabAnchorActiveLeft : this._grabAnchorActiveRight) {
              this._releaseGrabHand(hand);
            }
            heldGrabFreeze = true;
            freezeWristWorld.copy(ragHold.wristWorld);
          } else if (!this.data.isMirror && handBone && wristLocked) {
            const grabActiveNow = hand === 'left' ? this._grabAnchorActiveLeft : this._grabAnchorActiveRight;
            if (grabActiveNow && this._isGrabPressed(hand)) {
              const ctrlH = hand === 'left' ? this.leftController : this.rightController;
              const anchorH = hand === 'left' ? this._grabAnchorLeft : this._grabAnchorRight;
              if (!this._shouldReleaseGrab(hand, ctrlH, anchorH, true)) {
                heldGrabFreeze = true;
                freezeWristWorld.copy(envLockedWristWorld);
              }
            }
          }

          const adjustedHandPos = handWorldPos.clone();
          if (heldGrabFreeze) {
            // Reach is measured to the fixed hold; freezeWristWorld is already the
            // final wrist world position (no left/right offset needed).
            adjustedHandPos.copy(freezeWristWorld);
          } else {
            const leftRightOffsetLocal = new THREE.Vector3(hand === 'left' ? 0.1 : -0.1, 0, 0);
            const bodyWorldQuat = this._getBodyWorldQuat(this._ikBodyWorldQuat || (this._ikBodyWorldQuat = new THREE.Quaternion()));
            const leftRightOffsetWorld = leftRightOffsetLocal.applyQuaternion(bodyWorldQuat);
            adjustedHandPos.add(leftRightOffsetWorld);
          }
          
          // Measure reach needed vs natural arm length
          const shoulderToHand = adjustedHandPos.clone().sub(shoulderWorldPos);
          const distance = shoulderToHand.length();
          const naturalMaxReach = this.config.upperArmLength + this.config.lowerArmLength;
          const minReach = Math.abs(this.config.upperArmLength - this.config.lowerArmLength) * 1.001;
          
          // Distributed arm stretch: when controller is beyond natural reach, both
          // upper arm and forearm extend equally. This keeps the proportional
          // relationship between segments intact so neither looks obviously longer.
          // Max ~40% extension total to prevent alien arms.
          let armScale = 1.0;
          let effectiveUpperArmLength = this.config.upperArmLength;
          let effectiveForearmLength = this.config.lowerArmLength;
          
          if (distance > naturalMaxReach * 0.97) {
            // Locked holds (environment + ragdoll) may stretch to keep the anchor.
            const allowGrabStretch = heldGrabFreeze;
            armScale = THREE.MathUtils.clamp(
              distance / (naturalMaxReach * 0.97),
              1.0,
              allowGrabStretch ? 2.2 : 1.4
            );
            effectiveUpperArmLength = this.config.upperArmLength * armScale;
            effectiveForearmLength = this.config.lowerArmLength * armScale;
          }
          
          const effectiveMaxReach = (effectiveUpperArmLength + effectiveForearmLength) * 0.999;
          
          // Target hand position: always at the actual controller (no clamping to natural reach)
          let targetHandPos = adjustedHandPos.clone();
          if (heldGrabFreeze) {
            // Pin exactly to the hold â€” never shorten, or the hand drifts off it.
            targetHandPos.copy(freezeWristWorld);
          } else if (distance > effectiveMaxReach) {
            targetHandPos = shoulderWorldPos.clone().add(
              shoulderToHand.clone().normalize().multiplyScalar(effectiveMaxReach)
            );
          } else if (distance < minReach) {
            targetHandPos = shoulderWorldPos.clone().add(
              shoulderToHand.clone().normalize().multiplyScalar(minReach)
            );
          }

          let stablePalmForNextFrame = null;
          const legIk = this.el.sceneEl.components['leg-ik-world'];
          let lockedHandLocal = null;

          const applyTwoBoneIK = (lockWristTarget) => {
            // Two-bone IK with effective (possibly stretched) segment lengths
            const toTarget = targetHandPos.clone().sub(shoulderWorldPos);
            const targetDist = toTarget.length();
            const toTargetDir = targetDist > 0.0001 ? toTarget.clone().normalize() : new THREE.Vector3(0, -1, 0);
            
            const upperSq = effectiveUpperArmLength * effectiveUpperArmLength;
            const lowerSq = effectiveForearmLength * effectiveForearmLength;
            const distSq = targetDist * targetDist;
            
            const cosAngle = (upperSq + distSq - lowerSq) / (2 * effectiveUpperArmLength * targetDist);
            const clampedCos = Math.max(-0.999, Math.min(0.999, cosAngle));
            const angle = Math.acos(clampedCos);
            
            // Elbow bend direction â€” world body yaw (includes rig snap-turn).
            const ikFrame = this._ikBendQuat || (this._ikBendQuat = new THREE.Quaternion());
            this.el.object3D.getWorldQuaternion(ikFrame);
            this._yawOnlyQuat(ikFrame, ikFrame);
            const bodyForward = new THREE.Vector3(0, 0, -1).applyQuaternion(ikFrame);
            const bodyRight = new THREE.Vector3(1, 0, 0).applyQuaternion(ikFrame);
            const bodyOutward = bodyRight.clone().multiplyScalar(hand === 'left' ? -1 : 1);
            
            let bendDir = new THREE.Vector3()
              .addScaledVector(bodyOutward, 0.4)
              .addScaledVector(new THREE.Vector3(0, -1, 0), 0.4)
              .normalize();
            
            const handUp = new THREE.Vector3(0, 1, 0).applyQuaternion(handWorldQuat);
            bendDir.addScaledVector(handUp, 0.3);
            bendDir.normalize();
            bendDir.addScaledVector(toTargetDir, -bendDir.dot(toTargetDir)).normalize();
            
            const elbowDir = new THREE.Vector3()
              .addScaledVector(toTargetDir, Math.cos(angle))
              .addScaledVector(bendDir, Math.sin(angle))
              .normalize();
            
            let elbowWorldPos = shoulderWorldPos.clone().add(elbowDir.clone().multiplyScalar(effectiveUpperArmLength));
            
            // Enforce effective upper arm length
            const shoulderToElbow = elbowWorldPos.clone().sub(shoulderWorldPos);
            if (Math.abs(shoulderToElbow.length() - effectiveUpperArmLength) > 0.0001) {
              elbowWorldPos.copy(shoulderWorldPos).add(shoulderToElbow.normalize().multiplyScalar(effectiveUpperArmLength));
            }
            
            // Forearm endpoint at effective (possibly extended) length.
            // When collision locked the wrist, do not re-project into the controller ray.
            if (!lockWristTarget) {
              const elbowToHand = targetHandPos.clone().sub(elbowWorldPos);
              if (Math.abs(elbowToHand.length() - effectiveForearmLength) > 0.0001) {
                targetHandPos.copy(elbowWorldPos).add(elbowToHand.normalize().multiplyScalar(effectiveForearmLength));
              }
            }
            
            // --- Bone rotations ---
            this.el.object3D.updateMatrixWorld(true);
            const tPoseDir = new THREE.Vector3(0, -1, 0);
            
            // Upper Arm
            upperArmBone.parent.updateMatrixWorld(true);
            const shoulderInParent = upperArmBone.parent.worldToLocal(shoulderWorldPos.clone());
            const elbowInParent = upperArmBone.parent.worldToLocal(elbowWorldPos.clone());
            const upperArmParentDir = shoulderInParent.clone().sub(elbowInParent).normalize();
            const upperArmQuat = new THREE.Quaternion().setFromUnitVectors(tPoseDir, upperArmParentDir);
            
            upperArmBone.quaternion.copy(upperArmQuat);
            upperArmBone.updateMatrixWorld(true);
            
            // Forearm rotation
            forearmBone.parent.updateMatrixWorld(true);
            const elbowInUpperArm = forearmBone.parent.worldToLocal(elbowWorldPos.clone());
            const handInUpperArm = forearmBone.parent.worldToLocal(targetHandPos.clone());
            const forearmParentDir = elbowInUpperArm.clone().sub(handInUpperArm).normalize();
            const forearmQuat = new THREE.Quaternion().setFromUnitVectors(tPoseDir, forearmParentDir);
            
            // Forearm twist (pronation/supination)
            forearmBone.quaternion.copy(forearmQuat);
            forearmBone.updateMatrixWorld(true);

            if (!lockedHandLocal) {
              const forearmWorldQuat = new THREE.Quaternion();
              forearmBone.getWorldQuaternion(forearmWorldQuat);
              const handRelativeForearm = handWorldQuat.clone();
              handRelativeForearm.premultiply(forearmWorldQuat.clone().invert());
              const handEuler = new THREE.Euler().setFromQuaternion(handRelativeForearm, 'YXZ');
              const twistAngle = handEuler.y;

              const forearmTwist = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0),
                twistAngle * 0.5
              );
              forearmBone.quaternion.copy(forearmQuat).multiply(forearmTwist);
            }
            
            // Distributed arm stretch: scale both upper arm and forearm along their
            // bone length axis (Y in Mixamo) so the extension is evenly distributed
            // and neither segment looks disproportionately longer.
            // Since forearm inherits upper arm's scale, we counter-scale it so the
            // forearm segment itself only stretches by armScale (not armScale^2).
            upperArmBone.scale.set(1, armScale, 1);
            forearmBone.scale.set(1, 1, 1);
            
            forearmBone.updateMatrixWorld(true);
            
            // Hand orientation â€” controller tracking, or frozen world pose while grabbing.
            if (handBone) {
              const lockedHandWorld = this._getGrabLockedHandWorld(hand);
              if (lockedHandWorld) {
                const fwq = new THREE.Quaternion();
                forearmBone.getWorldQuaternion(fwq);
                const handLocalQuat = lockedHandWorld.clone().premultiply(fwq.clone().invert());
                handBone.quaternion.copy(handLocalQuat);
              } else if (lockedHandLocal) {
                handBone.quaternion.copy(lockedHandLocal);
              } else {
                const fwq = new THREE.Quaternion();
                forearmBone.getWorldQuaternion(fwq);

                let handLocalQuat = handWorldQuat.clone();
                handLocalQuat.premultiply(fwq.clone().invert());

                const localXFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
                handLocalQuat.multiply(localXFlip);

                const rollCorrection = new THREE.Quaternion().setFromAxisAngle(
                  new THREE.Vector3(0, 1, 0),
                  hand === 'left' ? Math.PI / 2 : -Math.PI / 2
                );
                handLocalQuat.multiply(rollCorrection);

                handBone.quaternion.copy(handLocalQuat);
              }
              
              // Undo inherited arm stretch on the hand so hand mesh stays normal size.
              if (armScale !== 1.0) {
                handBone.scale.set(1, 1 / armScale, 1);
              } else {
                handBone.scale.set(1, 1, 1);
              }
            }
          };

          const dt = opts.dt != null ? opts.dt : (this._handHapticDt || 0.016);
          let grabPressed = false;
          let grabActive = false;
          let grabWasActive = false;

          if (!this.data.isMirror && handBone) {
            grabPressed = this._isGrabPressed(hand);
            if (!ragDummyHold) {
              grabActive = hand === 'left' ? this._grabAnchorActiveLeft : this._grabAnchorActiveRight;
              grabWasActive = hand === 'left' ? this._envGrabWasActiveLeft : this._envGrabWasActiveRight;

              if (!grabPressed) {
                this._releaseGrabHand(hand);
                grabActive = false;
                lockedHandLocal = null;
              } else if (grabActive) {
                lockedHandLocal = this._getGrabLockedHandLocal(hand);
              }
            }
          }

          // While a grab is already held, freeze the hand at the world pose that
          // was captured when the grab began. Controller motion only drives
          // grab-pull locomotion (the body moves under a static hand); it must
          // NOT reposition or reorient the grabbing hand until release.
          // Ragdoll holds freeze to the weight-limited contact wrist instead.
          let handFrozen = false;
          if (heldGrabFreeze) {
            handFrozen = true;
            if (!ragDummyHold) {
              lockedHandLocal = this._getGrabLockedHandLocal(hand);
            }
            targetHandPos.copy(freezeWristWorld);
          } else if (!ragDummyHold && !this.data.isMirror && handBone && grabActive && grabWasActive && wristLocked && grabPressed) {
            // Was holding, but the pull-release threshold was crossed this frame.
            this._releaseGrabHand(hand);
            grabActive = false;
            lockedHandLocal = null;
          }

          if (handFrozen) {
            if (handBone) {
              this._solveFrozenGrabWrist(hand, handBone, freezeWristWorld, targetHandPos, applyTwoBoneIK);
              if (!ragDummyHold) {
                const bpFrozen = this._getHandPalmProbeWorldPos(hand, this._palmWorldTmp);
                stablePalmForNextFrame = bpFrozen.clone();
              }
            } else {
              applyTwoBoneIK(true);
            }
            if (ragDummyHold) {
              this._updateRagdollHoldHaptics(hand, true, handWorldPos);
            } else {
              this._updateHandHaptics(hand, true, grabActive, grabWasActive);
            }
          } else {
            applyTwoBoneIK(false);
            if (!this.data.isMirror) {
              const envGrabActive = hand === 'left' ? this._grabAnchorActiveLeft : this._grabAnchorActiveRight;
              if (ragDummyHold) {
                this._updateRagdollHoldHaptics(hand, true, handWorldPos);
              } else if (!envGrabActive) {
                this._updateRagdollHoldHaptics(hand, false, handWorldPos);
              }
            }
          }

          if (!ragDummyHold && !handFrozen && !this.data.isMirror && handBone && legIk && legIk.physics && legIk.clampHandPalmAlongTracking) {
            const anchor = hand === 'left' ? this._grabAnchorLeft : this._grabAnchorRight;
            const palmNormal = hand === 'left' ? this._grabPalmNormalLeft : this._grabPalmNormalRight;
            const ctrl = hand === 'left' ? this.leftController : this.rightController;
            const lastProbe = hand === 'left' ? this._lastStablePalmLeft : this._lastStablePalmRight;
            const hasStable = hand === 'left' ? this._hasStablePalmLeft : this._hasStablePalmRight;
            const boneProbe = this._getHandPalmProbeWorldPos(hand, this._palmWorldTmp);
            const lastStable = hasStable ? lastProbe : null;
            const stableProbe = new THREE.Vector3();
            let collisionHit = false;

            // Environment via Box3D; character via live Mixamo limb capsules.
            // Never query misaligned Box3D ragdoll capsules for hand blocking.
            // CapVR: any grabbable-ragdoll (grab-dummy + bot bodies), not only #grab-dummy.
            let ragComp = document.querySelector('#grab-dummy')?.components['grabbable-ragdoll'];
            if (!ragComp) {
              const any = document.querySelector('[grabbable-ragdoll]');
              ragComp = any?.components?.['grabbable-ragdoll'];
            }
            // Prefer nearest ragdoll to this palm for slide tests
            {
              let bestR = ragComp;
              let bestD = Infinity;
              document.querySelectorAll('[grabbable-ragdoll]').forEach((el) => {
                const c = el.components?.['grabbable-ragdoll'];
                if (!c?.slidePalmOnMesh) return;
                const bp = new THREE.Vector3();
                el.object3D.getWorldPosition(bp);
                const d = bp.distanceTo(boneProbe);
                if (d < bestD && d < 3.5) {
                  bestD = d;
                  bestR = c;
                }
              });
              ragComp = bestR;
            }
            if (legIk.physics.setHandCollideRagdoll) {
              legIk.physics.setHandCollideRagdoll(false);
            }

            // Bias depenetration toward the shoulder so embeds exit on the
            // player-facing side (near the controller), not through the wall.
            const preferToward = shoulderWorldPos;
            const lastTrackKey = hand === 'left' ? '_lastPalmTrackLeft' : '_lastPalmTrackRight';
            if (!this[lastTrackKey]) this[lastTrackKey] = new THREE.Vector3();
            const hasLastTrack = hand === 'left' ? this._hasPalmTrackLeft : this._hasPalmTrackRight;
            const lastTrack = hasLastTrack ? this[lastTrackKey] : adjustedHandPos;
            const palmRadius = this.handCollisionRadius || this.palmProbeRadius || 0.026;

            collisionHit = legIk.clampHandPalmAlongTracking(
              lastStable,
              boneProbe,
              stableProbe,
              hand,
              adjustedHandPos,
              { preferToward, lastTrack }
            );
            let hitCharacterMesh = false;

            // Character path is isolated â€” must never break environment blocking.
            try {
              if (ragComp && ragComp.slidePalmOnMesh) {
                const meshOut = this._meshPalmResolveTmp || (this._meshPalmResolveTmp = new THREE.Vector3());
                const meshSlide = ragComp.slidePalmOnMesh(lastStable, boneProbe, meshOut, {
                  radius: palmRadius,
                  preferToward,
                  tracking: adjustedHandPos
                });
                if (meshSlide && meshSlide.hit && meshSlide.position) {
                  const envBlocked = collisionHit
                    ? stableProbe.distanceToSquared(boneProbe)
                    : 0;
                  const meshBlocked = meshOut.distanceToSquared(boneProbe);
                  if (!collisionHit || meshBlocked >= envBlocked - 1e-8) {
                    stableProbe.copy(meshOut);
                    collisionHit = true;
                    hitCharacterMesh = true;
                    const debugKey = hand === 'left' ? '_handPalmDebugLeft' : '_handPalmDebugRight';
                    const n = (meshSlide.normal && meshSlide.normal.clone()) || new THREE.Vector3(0, 1, 0);
                    legIk[debugKey] = {
                      hit: true,
                      sticky: meshOut.clone(),
                      contactPoint: meshSlide.contactPoint
                        ? meshSlide.contactPoint.clone()
                        : meshOut.clone().addScaledVector(n, -palmRadius),
                      normal: n,
                      shapeId: 'mesh-limb',
                      controller: adjustedHandPos.clone(),
                      contactDistance: meshOut.distanceTo(adjustedHandPos)
                    };
                  }
                }
              }
            } catch (meshErr) {
              console.warn('[mixamo-body] character limb hand collision failed:', meshErr);
            }

            this[lastTrackKey].copy(adjustedHandPos);
            if (hand === 'left') this._hasPalmTrackLeft = true;
            else this._hasPalmTrackRight = true;

            // Always keep the corrected probe as next frame's sweep origin so a
            // fast approach can never tunnel through geometry between frames.
            lastProbe.copy(stableProbe);
            if (hand === 'left') {
              this._hasStablePalmLeft = true;
            } else {
              this._hasStablePalmRight = true;
            }
            stablePalmForNextFrame = stableProbe.clone();

            let surfaceGrab = hand === 'left' ? this._grabSurfaceContactLeft : this._grabSurfaceContactRight;
            let dbg = hand === 'left' ? legIk._handPalmDebugLeft : legIk._handPalmDebugRight;

            if (grabPressed && collisionHit && !grabWasActive) {
              // Character limb hits must not start environment grab-pull.
              const hitRagdoll = hitCharacterMesh ||
                !!(legIk.physics.isRagdollShape && legIk.physics.isRagdollShape(dbg?.shapeId)) ||
                dbg?.shapeId === 'mesh-limb' ||
                dbg?.shapeId === 'mesh-character';
              if (!hitRagdoll) {
                if (dbg && dbg.contactPoint) {
                  anchor.copy(dbg.contactPoint);
                } else {
                  this._probeWorldToContactWorld(hand, stableProbe, anchor);
                }
                if (dbg && dbg.normal) {
                  palmNormal.copy(dbg.normal);
                  if (palmNormal.lengthSq() < 1e-8) palmNormal.set(0, 1, 0);
                  else palmNormal.normalize();
                } else {
                  this._estimatePalmNormalFromPhysics(anchor, palmNormal);
                }

                this._lockGrabHandOrientation(hand, handBone);
                lockedHandLocal = this._getGrabLockedHandLocal(hand);
                if (hand === 'left') {
                  this._grabAnchorActiveLeft = true;
                  this._grabSurfaceContactLeft = true;
                } else {
                  this._grabAnchorActiveRight = true;
                  this._grabSurfaceContactRight = true;
                }
                grabActive = true;
                surfaceGrab = true;
                this._seedGrabPullTracking(hand, anchor);
                this._resetGrabFingerCurls(hand);
                stablePalmForNextFrame = stableProbe.clone();
                lastProbe.copy(stableProbe);
              }
            }

            if (collisionHit) {
              this._nudgeWristForPalmContact(
                hand, handBone, stableProbe, targetHandPos, applyTwoBoneIK, dt, 1
              );
            }

            // Light rigid pass only when palm did not already hit.
            let rigidHit = false;
            if (!collisionHit) {
              rigidHit = this._blockHandRigid(hand, handBone, targetHandPos, applyTwoBoneIK, {
                palmOnly: true,
                preferToward,
                maxDelta: 0.12,
                singlePass: true
              });
            }
            collisionHit = collisionHit || rigidHit;

            if (hand === 'left') {
              this._handCollisionDebugLeft = legIk._handPalmDebugLeft;
            } else {
              this._handCollisionDebugRight = legIk._handPalmDebugRight;
            }

            // Grab just began this frame: freeze the settled pose. Capture the
            // ACTUAL visible hand-bone world position (not targetHandPos, which is
            // the controller-derived IK target and differs from where collision
            // actually placed the hand â€” using it caused a teleport toward the
            // controller). Orientation is frozen the same way.
            if (grabActive && !grabWasActive) {
              this.model.updateMatrixWorld(true);
              if (this.skeleton) this.skeleton.update();
              this._restoreHandBoneRestPosition(hand);
              handBone.getWorldPosition(envLockedWristWorld);
              if (hand === 'left') {
                this._grabWristCorrLeft.set(0, 0, 0);
              } else {
                this._grabWristCorrRight.set(0, 0, 0);
              }
              this._lockGrabHandOrientation(hand, handBone);
              if (hand === 'left') {
                this._grabWristLockLeft = true;
              } else {
                this._grabWristLockRight = true;
              }
            }

            if (grabActive && grabPressed) {
              if (this._shouldReleaseGrab(hand, ctrl, anchor, collisionHit)) {
                this._releaseGrabHand(hand);
                grabActive = false;
                lockedHandLocal = null;
              } else {
                lockedHandLocal = this._getGrabLockedHandLocal(hand);
                if (hand === 'left') {
                  this._hasStablePalmLeft = true;
                } else {
                  this._hasStablePalmRight = true;
                }
              }
            }

            this._updateHandHaptics(hand, collisionHit, grabActive, grabWasActive);

            // Leave hand queries on ENVIRONMENT-only when done so other systems
            // (and the far hand next frame) don't pay for ragdoll broadphase hits.
            if (legIk.physics.setHandCollideRagdoll) {
              legIk.physics.setHandCollideRagdoll(false);
            }
          }

          if (!this.data.isMirror && handBone) {
            const envGrabNow = hand === 'left' ? this._grabAnchorActiveLeft : this._grabAnchorActiveRight;
            if (hand === 'left') {
              this._envGrabWasActiveLeft = envGrabNow;
            } else {
              this._envGrabWasActiveRight = envGrabNow;
            }
          }

          if (!this.data.isMirror && handBone) {
            const lastPalm = hand === 'left' ? this._lastStablePalmLeft : this._lastStablePalmRight;

            if (stablePalmForNextFrame) {
              lastPalm.copy(stablePalmForNextFrame);
              if (hand === 'left') {
                this._hasStablePalmLeft = true;
              } else {
                this._hasStablePalmRight = true;
              }
            } else {
              if (hand === 'left') {
                this._hasStablePalmLeft = false;
              } else {
                this._hasStablePalmRight = false;
              }
            }
          }
        }
      });
})();

