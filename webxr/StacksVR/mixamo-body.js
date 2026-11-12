// mixamo-body.js — extracted from DodgeVR for StacksVR
(function () {
  'use strict';
      AFRAME.registerComponent('mixamo-body', {
        schema: {
          mode: { type: 'string', default: 'player' },
          color: { type: 'color', default: '#4A90E2' },
          modelPath: { type: 'string', default: 'assets/YBot.fbx' },
          botEntitySelector: { type: 'string', default: '#cup-bot' },
          emissiveIntensity: { type: 'number', default: 0.3 },
          rimIntensity: { type: 'number', default: 1.2 },
          rimPower: { type: 'number', default: 2.5 }
        },

        init: function() {
          this.isBot = this.data.mode === 'bot';

          if (!this.isBot) {
            // Player mode - reference VR controller entities
            this.camera = document.querySelector('[camera]');
            this.leftController = document.querySelector('#leftHand');
            this.rightController = document.querySelector('#rightHand');
            this.rig = document.querySelector('#rig');

            // Hide default hand-controls models (Y Bot has its own hands)
            // Must NOT hide racket child entities -- only the hand-controls mesh
            const hideHandModel = (controller) => {
              if (!controller) return;
              const tryHide = () => {
                const handControls = controller.components['hand-controls'];
                if (handControls && handControls.loader) {
                  // Build a set of Object3Ds that belong to child A-Frame entities (rackets, etc.)
                  const childEntityObj3Ds = new Set();
                  controller.querySelectorAll('*').forEach((childEl) => {
                    if (childEl.object3D) {
                      childEl.object3D.traverse((obj) => childEntityObj3Ds.add(obj));
                    }
                  });
                  // Only hide meshes from the hand-controls model itself
                  const handModel = controller.getObject3D('mesh');
                  if (handModel) {
                    handModel.traverse((child) => {
                      if (child.isMesh) {
                        child.visible = false;
                      }
                    });
                  }
                }
              };
              controller.addEventListener('model-loaded', tryHide);
              controller.addEventListener('object3dset', tryHide);
              tryHide();
            };
            hideHandModel(this.leftController);
            hideHandModel(this.rightController);
          } else {
            // Bot mode - reference the bot entity
            this.botEntity = document.querySelector(this.data.botEntitySelector);
            if (!this.botEntity) {
              this.el.sceneEl.addEventListener('loaded', () => {
                this.botEntity = document.querySelector(this.data.botEntitySelector);
              });
            }
            this.idleTime = 0;
          }

          this.skeleton = null;
          this.bones = {};
          this.model = null;
          this.modelLoaded = false;

          // Mixamo bone names
          this.boneNames = {
            hips: 'mixamorigHips',
            spine: 'mixamorigSpine',
            spine1: 'mixamorigSpine1',
            spine2: 'mixamorigSpine2',
            neck: 'mixamorigNeck',
            head: 'mixamorigHead',
            leftShoulder: 'mixamorigLeftShoulder',
            leftArm: 'mixamorigLeftArm',
            leftForeArm: 'mixamorigLeftForeArm',
            leftHand: 'mixamorigLeftHand',
            rightShoulder: 'mixamorigRightShoulder',
            rightArm: 'mixamorigRightArm',
            rightForeArm: 'mixamorigRightForeArm',
            rightHand: 'mixamorigRightHand',
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
            rightHandPinky3: 'mixamorigRightHandPinky3'
          };

          // IK config
          this.config = {
            shoulderWidth: 0.34,
            shoulderForward: 0.08,
            upperArmLength: 0.31,
            lowerArmLength: 0.31
          };

          // Smoothing
          this.torsoRotation = new THREE.Quaternion();
          this.bodyTilt = new THREE.Quaternion();
          this.smoothingFactor = 0.15;

          // Initialize torso rotation for bot (facing +Z toward player)
          if (this.isBot) {
            this.torsoRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
          }

          // Finger curl smoothing
          this.targetCurls = {
            left: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
            right: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 }
          };
          this.currentCurls = {
            left: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
            right: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 }
          };
          this.fingerSmoothingFactor = 0.3;

          // Breathing animation
          this.breathingPhase = 0;
          this.breathingRate = 0.25;
          this.breathingAmount = 0.015;

          // Body dynamics
          this.previousHeadPos = new THREE.Vector3();
          this.previousHeadPosInitialized = false;
          this.headVelocity = new THREE.Vector3();
          this.torsoLean = new THREE.Vector3();
          this.torsoLeanVelocity = 0.15;

          // Pose blend state (idle <-> serve transitions)
          this.blendDuration = 0.5;
          this._blendState = 'none';
          this._blendProgress = 0;
          this._blendFromPose = null;
          this._lastAppliedPose = null;
          this._wasInPlayback = false;

          // Enable local clipping
          this.el.sceneEl.addEventListener('loaded', () => {
            const renderer = this.el.sceneEl.renderer;
            if (renderer) renderer.localClippingEnabled = true;
          });

          // Load FBX model
          const loader = new THREE.FBXLoader();
          loader.load(
            this.data.modelPath,
            (fbx) => this.onModelLoaded(fbx),
            undefined,
            (error) => console.error('[Mixamo Body] Load error:', error)
          );
        },

        onModelLoaded: function(fbx) {
          this.modelLoaded = true;
          this.model = fbx;

          // Mixamo models export at 100x scale
          fbx.scale.set(0.01, 0.01, 0.01);
          // T-pose faces +Z, rotate 180 to face -Z (forward)
          fbx.rotation.y = Math.PI;

          this.el.object3D.add(fbx);

          // Find skeleton and set up materials with Fresnel rim + emissive shader
          fbx.traverse((node) => {
            if (node.isSkinnedMesh && node.skeleton) {
              this.skeleton = node.skeleton;
              this.mapBones();
              this.skinnedMesh = node;

              // Replace with custom Fresnel + emissive shader (skinning enabled)
              node.material = this.createFresnelMaterial(true);
            }
            if (node.isMesh && !node.isSkinnedMesh) {
              // Replace with custom Fresnel + emissive shader (no skinning)
              node.material = this.createFresnelMaterial(false);
            }
          });

          // For bot body, create racket meshes for multiplayer (scene-level, not bone-attached)
          // Positioned directly at remote hand positions each frame for accurate placement
          if (this.isBot) {
            this.botRackets = { left: null, right: null };
            const racketGeo = new THREE.BoxGeometry(0.2, 0.2, 0.02);
            const racketColor = new THREE.Color(this.data.color || '#ff4444');
            const racketMat = new THREE.MeshBasicMaterial({
              color: racketColor,
              wireframe: true,
              transparent: true,
              opacity: 0.8
            });
            ['left', 'right'].forEach((side) => {
              const mesh = new THREE.Mesh(racketGeo, racketMat.clone());
              mesh.visible = false;
              this.el.sceneEl.object3D.add(mesh);
              this.botRackets[side] = mesh;
            });
            // Pre-allocate reusable objects for per-frame racket positioning
            this._racketOffset = new THREE.Vector3(0, 0, -0.15);
            this._racketRotOffset = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0));
            this._tmpRacketQuat = new THREE.Quaternion();
            this._tmpRacketOffsetVec = new THREE.Vector3();
          }

          // Keep body visible against dark scenes (desktop + VR)
          fbx.traverse((node) => {
            if (node.isMesh) {
              node.frustumCulled = false;
              if (node.material) {
                node.material.emissiveIntensity = Math.max(node.material.emissiveIntensity || 0, 0.55);
                node.material.needsUpdate = true;
              }
            }
          });
          console.log('[Mixamo Body]', this.data.mode, 'body loaded');
        },

        // Create Fresnel rim + emissive material using MeshStandardMaterial with onBeforeCompile
        // This preserves built-in skinning support and is compatible with all THREE.js versions
        createFresnelMaterial: function(useSkinning) {
          const bodyColor = new THREE.Color(this.data.color);
          const rimIntensity = this.data.rimIntensity;
          const rimPower = this.data.rimPower;

          const material = new THREE.MeshStandardMaterial({
            color: bodyColor,
            emissive: bodyColor,
            emissiveIntensity: this.data.emissiveIntensity,
            roughness: 0.8,
            metalness: 0.0,
            side: THREE.DoubleSide
          });

          // Inject Fresnel rim lighting into the standard shader
          const rimIntVal = rimIntensity;
          const rimPowVal = rimPower;
          material.onBeforeCompile = function(shader) {
            // Add rim uniforms
            shader.uniforms.uRimIntensity = { value: rimIntVal };
            shader.uniforms.uRimPower = { value: rimPowVal };
            shader.uniforms.uRimColor = { value: bodyColor };

            // Add varying for world normal and position to vertex shader
            shader.vertexShader = shader.vertexShader.replace(
              'void main() {',
              `varying vec3 vWorldNormalRim;
               varying vec3 vWorldPositionRim;
               void main() {`
            );
            // After all transforms, compute world normal and position
            shader.vertexShader = shader.vertexShader.replace(
              '#include <worldpos_vertex>',
              `#include <worldpos_vertex>
               vWorldNormalRim = normalize((modelMatrix * vec4(transformedNormal, 0.0)).xyz);
               vWorldPositionRim = (modelMatrix * vec4(transformed, 1.0)).xyz;`
            );

            // Add rim calculation to fragment shader
            shader.fragmentShader = shader.fragmentShader.replace(
              'void main() {',
              `uniform float uRimIntensity;
               uniform float uRimPower;
               uniform vec3 uRimColor;
               varying vec3 vWorldNormalRim;
               varying vec3 vWorldPositionRim;
               void main() {`
            );
            // Add rim glow to the final output
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <dithering_fragment>',
              `#include <dithering_fragment>
               vec3 rimViewDir = normalize(cameraPosition - vWorldPositionRim);
               vec3 rimNormal = normalize(vWorldNormalRim);
               float rim = 1.0 - max(0.0, dot(rimViewDir, rimNormal));
               rim = pow(rim, uRimPower);
               gl_FragColor.rgb += uRimColor * rim * uRimIntensity;`
            );
          };

          return material;
        },

        mapBones: function() {
          this.initialBoneRotations = {};
          this.legBones = [];

          this.skeleton.bones.forEach((bone) => {
            const name = bone.name;
            this.initialBoneRotations[name] = bone.quaternion.clone();

            // Hide legs (upper body only)
            const lowerName = name.toLowerCase();
            if (lowerName.includes('leg') || lowerName.includes('upleg') ||
                lowerName.includes('foot') || lowerName.includes('toe')) {
              this.legBones.push(bone);
              bone.scale.set(0.001, 0.001, 0.001);
            }

            if (name === this.boneNames.hips) this.bones.hips = bone;
            else if (name === this.boneNames.spine) this.bones.spine = bone;
            else if (name === this.boneNames.spine1) this.bones.spine1 = bone;
            else if (name === this.boneNames.spine2) this.bones.spine2 = bone;
            else if (name === this.boneNames.neck) this.bones.neck = bone;
            else if (name === this.boneNames.head) {
              this.bones.head = bone;
              // Hide head for local player only (blocks VR view); show for bot
              if (!this.isBot) {
                bone.scale.set(0.001, 0.001, 0.001);
              }
            }
            else if (name === this.boneNames.leftShoulder) this.bones.leftShoulder = bone;
            else if (name === this.boneNames.leftArm) this.bones.leftUpperArm = bone;
            else if (name === this.boneNames.leftForeArm) this.bones.leftForearm = bone;
            else if (name === this.boneNames.leftHand) this.bones.leftHandBone = bone;
            else if (name === this.boneNames.leftHandThumb1) this.bones.leftHandThumb1 = bone;
            else if (name === this.boneNames.leftHandThumb2) this.bones.leftHandThumb2 = bone;
            else if (name === this.boneNames.leftHandThumb3) this.bones.leftHandThumb3 = bone;
            else if (name === this.boneNames.leftHandIndex1) this.bones.leftHandIndex1 = bone;
            else if (name === this.boneNames.leftHandIndex2) this.bones.leftHandIndex2 = bone;
            else if (name === this.boneNames.leftHandIndex3) this.bones.leftHandIndex3 = bone;
            else if (name === this.boneNames.leftHandMiddle1) this.bones.leftHandMiddle1 = bone;
            else if (name === this.boneNames.leftHandMiddle2) this.bones.leftHandMiddle2 = bone;
            else if (name === this.boneNames.leftHandMiddle3) this.bones.leftHandMiddle3 = bone;
            else if (name === this.boneNames.leftHandRing1) this.bones.leftHandRing1 = bone;
            else if (name === this.boneNames.leftHandRing2) this.bones.leftHandRing2 = bone;
            else if (name === this.boneNames.leftHandRing3) this.bones.leftHandRing3 = bone;
            else if (name === this.boneNames.leftHandPinky1) this.bones.leftHandPinky1 = bone;
            else if (name === this.boneNames.leftHandPinky2) this.bones.leftHandPinky2 = bone;
            else if (name === this.boneNames.leftHandPinky3) this.bones.leftHandPinky3 = bone;
            else if (name === this.boneNames.rightShoulder) this.bones.rightShoulder = bone;
            else if (name === this.boneNames.rightArm) this.bones.rightUpperArm = bone;
            else if (name === this.boneNames.rightForeArm) this.bones.rightForearm = bone;
            else if (name === this.boneNames.rightHand) this.bones.rightHandBone = bone;
            else if (name === this.boneNames.rightHandThumb1) this.bones.rightHandThumb1 = bone;
            else if (name === this.boneNames.rightHandThumb2) this.bones.rightHandThumb2 = bone;
            else if (name === this.boneNames.rightHandThumb3) this.bones.rightHandThumb3 = bone;
            else if (name === this.boneNames.rightHandIndex1) this.bones.rightHandIndex1 = bone;
            else if (name === this.boneNames.rightHandIndex2) this.bones.rightHandIndex2 = bone;
            else if (name === this.boneNames.rightHandIndex3) this.bones.rightHandIndex3 = bone;
            else if (name === this.boneNames.rightHandMiddle1) this.bones.rightHandMiddle1 = bone;
            else if (name === this.boneNames.rightHandMiddle2) this.bones.rightHandMiddle2 = bone;
            else if (name === this.boneNames.rightHandMiddle3) this.bones.rightHandMiddle3 = bone;
            else if (name === this.boneNames.rightHandRing1) this.bones.rightHandRing1 = bone;
            else if (name === this.boneNames.rightHandRing2) this.bones.rightHandRing2 = bone;
            else if (name === this.boneNames.rightHandRing3) this.bones.rightHandRing3 = bone;
            else if (name === this.boneNames.rightHandPinky1) this.bones.rightHandPinky1 = bone;
            else if (name === this.boneNames.rightHandPinky2) this.bones.rightHandPinky2 = bone;
            else if (name === this.boneNames.rightHandPinky3) this.bones.rightHandPinky3 = bone;
          });
        },

        tick: function(time, deltaTime) {
          if (!this.modelLoaded || !this.skeleton) return;

          const dt = Math.min(deltaTime / 1000, 0.1);

          // Update breathing
          this.breathingPhase += dt * this.breathingRate * Math.PI * 2;
          if (this.breathingPhase > Math.PI * 2) this.breathingPhase -= Math.PI * 2;

          if (this.isBot) {
            this.updateBotBody(time, dt);
          } else {
            if (!this.camera || !this.leftController || !this.rightController) return;
            this.updatePlayerBody(dt);
            this.updateFingerPoses();
          }
        },

        // ---- Finger tracking (player mode only) ----

        updateFingerPoses: function() {
          const leftGamepad = this.leftController.components['tracked-controls']?.controller?.gamepad;
          const rightGamepad = this.rightController.components['tracked-controls']?.controller?.gamepad;

          if (leftGamepad && leftGamepad.buttons) {
            const trigger = leftGamepad.buttons[0]?.value || 0;
            const grip = leftGamepad.buttons[1]?.value || 0;
            let anyThumbTouch = 0;
            for (let i = 2; i <= 6; i++) {
              if (leftGamepad.buttons[i]?.touched) { anyThumbTouch = 1; break; }
            }
            this.updateTargetCurls('left', trigger, grip, anyThumbTouch);
          }

          if (rightGamepad && rightGamepad.buttons) {
            const trigger = rightGamepad.buttons[0]?.value || 0;
            const grip = rightGamepad.buttons[1]?.value || 0;
            let anyThumbTouch = 0;
            for (let i = 2; i <= 6; i++) {
              if (rightGamepad.buttons[i]?.touched) { anyThumbTouch = 1; break; }
            }
            this.updateTargetCurls('right', trigger, grip, anyThumbTouch);
          }

          ['left', 'right'].forEach(hand => {
            ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach(finger => {
              const current = this.currentCurls[hand][finger];
              const target = this.targetCurls[hand][finger];
              this.currentCurls[hand][finger] = current + (target - current) * this.fingerSmoothingFactor;
            });
          });

          this.applyFingerCurls('left', this.currentCurls.left);
          this.applyFingerCurls('right', this.currentCurls.right);
        },

        updateTargetCurls: function(hand, trigger, grip, thumbTouch) {
          const restingCurls = { thumb: 0.1, index: 0.15, middle: 0.2, ring: 0.25, pinky: 0.25 };
          const activeCurls = {
            thumb: thumbTouch * 0.8,
            index: trigger,
            middle: grip * 1.1,
            ring: grip * 1.15,
            pinky: grip * 1.2
          };
          if (grip > 0.1 && trigger < 0.1) activeCurls.index = 0;
          const curls = {
            thumb: Math.max(restingCurls.thumb, activeCurls.thumb),
            index: Math.max(restingCurls.index, activeCurls.index),
            middle: Math.max(restingCurls.middle, activeCurls.middle),
            ring: Math.max(restingCurls.ring, activeCurls.ring),
            pinky: Math.max(restingCurls.pinky, activeCurls.pinky)
          };
          if (grip > 0.1 && trigger < 0.1) curls.index = 0.05;
          if (grip > 0.5 && thumbTouch < 0.5) curls.thumb = -0.15;
          this.targetCurls[hand] = curls;
        },

        applyFingerCurls: function(hand, curls) {
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

          Object.keys(fingerBones).forEach(fingerName => {
            const bones = fingerBones[fingerName];
            const curl = curls[fingerName];
            const isThumb = fingerName === 'thumb';
            const axis = isThumb ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
            const sign = isThumb ? (hand === 'left' ? -1 : 1) : 1;

            bones.forEach((bone, i) => {
              if (!bone) return;
              const initialRot = this.initialBoneRotations[bone.name];
              if (initialRot) bone.quaternion.copy(initialRot);
              const curlAmount = curl * (0.5 + i * 0.25);
              const curlAngle = curlAmount * Math.PI * 0.6 * sign;
              const curlQuat = new THREE.Quaternion().setFromAxisAngle(axis, curlAngle);
              bone.quaternion.multiply(curlQuat);
            });
          });
        },

        // Mirrored racket impact (same physics as static-physics racket but for bot's ball)
        _applyMirroredRacketImpact: function(ballGrab, racketPos, racketQuat, racketVel) {
          const ballBody = ballGrab.body;
          if (!ballBody) return;
          const invQ = racketQuat.clone().invert();
          const ballPos = new THREE.Vector3(ballBody.position.x, ballBody.position.y, ballBody.position.z);
          const localBall = ballPos.clone().sub(racketPos).applyQuaternion(invQ);
          const halfW = 0.1, halfH = 0.1, halfD = 0.01;
          const cx = Math.max(-halfW, Math.min(halfW, localBall.x));
          const cy = Math.max(-halfH, Math.min(halfH, localBall.y));
          const cz = Math.max(-halfD, Math.min(halfD, localBall.z));
          var localN = new THREE.Vector3(localBall.x-cx, localBall.y-cy, localBall.z-cz);
          if (localN.lengthSq() < 0.0001) localN.set(0, 0, localBall.z >= 0 ? 1 : -1);
          else localN.normalize();
          const normal = localN.applyQuaternion(racketQuat);

          const paddleVel = racketVel.clone();
          const ballVel = new THREE.Vector3(ballBody.velocity.x, ballBody.velocity.y, ballBody.velocity.z);
          const ballAngVel = new THREE.Vector3(ballBody.angularVelocity.x, ballBody.angularVelocity.y, ballBody.angularVelocity.z);
          const ballRadius = ballBody.shapes[0] ? ballBody.shapes[0].radius : 0.1;
          const inertiaCoeff = 0.4;
          const relVel = ballVel.clone().sub(paddleVel);
          const vn = relVel.dot(normal);
          if (vn > 0) return;

          const vperp = normal.clone().multiplyScalar(vn);
          const vpar = relVel.clone().sub(vperp);
          const vrot = new THREE.Vector3().crossVectors(ballAngVel, normal.clone().multiplyScalar(-ballRadius));
          const perpRestitution = 0.80;
          const parRestitution = 0.0;
          const frictionCoeff = 0.9;
          const fperpFactor = 1 + Math.sqrt(perpRestitution);
          const vperpimp = vperp.clone().multiplyScalar(-fperpFactor);
          const fparFactor = 1 + Math.sqrt(parRestitution);
          const vparimp = vpar.clone().add(vrot).multiplyScalar(-fparFactor / (1.0 + 1.0/inertiaCoeff));
          const vperpimpMag = vperpimp.length();
          const vparimpMag = vparimp.length();
          const vparmax = frictionCoeff * vperpimpMag;
          if (vparimpMag > vparmax && vparimpMag > 0.001) vparimp.multiplyScalar(vparmax / vparimpMag);
          relVel.add(vperpimp).add(vparimp);
          const spinChange = new THREE.Vector3().crossVectors(normal, vparimp).divideScalar(inertiaCoeff * ballRadius);
          ballAngVel.sub(spinChange);
          const newVel = relVel.add(paddleVel);
          ballBody.velocity.set(newVel.x, newVel.y, newVel.z);
          const mirrorBallPlayer = ballGrab.data?.player || 'player1';
          if (ballGrab) ballGrab._pendingAction = 'racket';
          capBallSpeed(mirrorBallPlayer, ballBody);
          var _mrRacketMax = getStageMaxSpeed(playerStages[mirrorBallPlayer] || 1) * 0.5;
          var _mrRacketSpd = ballBody.velocity.length();
          if (_mrRacketSpd > _mrRacketMax) {
            var _mrf = _mrRacketMax / _mrRacketSpd;
            ballBody.velocity.x *= _mrf;
            ballBody.velocity.y *= _mrf;
            ballBody.velocity.z *= _mrf;
          }
          ballBody.angularVelocity.set(ballAngVel.x, ballAngVel.y, ballAngVel.z);
          if (ballGrab.isReturning) { ballGrab.isReturning = false; ballGrab.returningGraceUntil = 0; }

          const bv = ballBody.velocity;
          window.playBounceSound(ballPos, Math.sqrt(bv.x*bv.x + bv.y*bv.y + bv.z*bv.z));
        },

        // ---- Player body update (VR-driven) ----

        updatePlayerBody: function(dt) {
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

          // Head velocity for dynamic lean
          if (this.previousHeadPosInitialized) {
            this.headVelocity.copy(headWorldPos).sub(this.previousHeadPos).divideScalar(dt);
          } else {
            this.previousHeadPosInitialized = true;
          }
          this.previousHeadPos.copy(headWorldPos);

          // Calculate torso orientation from head + hand positions
          this.calculateTorsoOrientation(headWorldPos, headWorldQuat, leftHandWorldPos, rightHandWorldPos, dt);

          // Position body so hips are at correct height
          const desiredHipsY = headWorldPos.y - 0.65;
          const modelHipsLocalY = 1.0;
          const bodyY = desiredHipsY - modelHipsLocalY;

          // 15cm backward offset in body-local space
          const backwardOffset = new THREE.Vector3(0, 0, 0.15);
          backwardOffset.applyQuaternion(this.torsoRotation);

          this.el.object3D.position.set(
            headWorldPos.x + backwardOffset.x,
            bodyY,
            headWorldPos.z + backwardOffset.z
          );
          this.el.object3D.quaternion.copy(this.torsoRotation);

          // Update bones with IK
          this.updateBones(headWorldPos, headWorldQuat, leftHandWorldPos, rightHandWorldPos, leftHandWorldQuat, rightHandWorldQuat);
        },

        // ---- Bot body update (AI idle animation) ----

        updateBotBody: function(time, dt) {
          // Singleplayer: only the primary bot body drives mirror/recorded/idle logic.
          // Spectator bodies (invisible) share the same getFrame() playback object;
          // if they also call it, they corrupt shared state (_prevBg, _frameIdx)
          // and cause clips to appear randomly interrupted.
          // Only the primary bot-body may run idle/AI without remote pose data.
          // Lobby remotes (remote-body-N / spec-blue) stay quiet until posed.
          var id = this.el && this.el.id;
          var isPrimaryBot = id === 'bot-body';
          var isRemotePool = id && String(id).indexOf('remote-body-') === 0;
          if (!this.remoteHandData && !isPrimaryBot) return;
          if (isRemotePool && !this.remoteHandData) return;

          // --- Multiplayer: use real remote player tracking data ---
          if (this.remoteHandData) {
            const rd = this.remoteHandData;
            if (!rd.head || typeof rd.head.x !== 'number') return;

            // Ensure remote-driven bodies are visible once posed
            if (this.el.object3D && !this.el.object3D.visible) {
              this.el.object3D.visible = true;
              this.el.setAttribute('visible', true);
            }
            if (this.el.dataset) this.el.dataset.posed = '1';

            const headPos = new THREE.Vector3(rd.head.x, rd.head.y, rd.head.z);
            const headQuat = (rd.head.qx !== undefined)
              ? new THREE.Quaternion(rd.head.qx, rd.head.qy, rd.head.qz, rd.head.qw)
              : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

            // Default hand positions near body if not yet received
            const leftHandPos = rd.leftHand
              ? new THREE.Vector3(rd.leftHand.x, rd.leftHand.y, rd.leftHand.z)
              : new THREE.Vector3(headPos.x + 0.3, headPos.y - 0.5, headPos.z + 0.25);
            const rightHandPos = rd.rightHand
              ? new THREE.Vector3(rd.rightHand.x, rd.rightHand.y, rd.rightHand.z)
              : new THREE.Vector3(headPos.x - 0.3, headPos.y - 0.5, headPos.z + 0.25);

            const leftHandQuat = rd.leftHand
              ? new THREE.Quaternion(rd.leftHand.qx, rd.leftHand.qy, rd.leftHand.qz, rd.leftHand.qw)
              : new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
            const rightHandQuat = rd.rightHand
              ? new THREE.Quaternion(rd.rightHand.qx, rd.rightHand.qy, rd.rightHand.qz, rd.rightHand.qw)
              : new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));

            // Head velocity for dynamic lean
            if (this.previousHeadPosInitialized) {
              this.headVelocity.copy(headPos).sub(this.previousHeadPos).divideScalar(dt || 0.016);
            } else {
              this.previousHeadPosInitialized = true;
            }
            this.previousHeadPos.copy(headPos);

            // Calculate torso from remote head + hand positions (same as player body)
            this.calculateTorsoOrientation(headPos, headQuat, leftHandPos, rightHandPos, dt);

            // Position body so hips are at correct height (same as updatePlayerBody)
            const desiredHipsY = headPos.y - 0.65;
            const modelHipsLocalY = 1.0;
            const bodyY = desiredHipsY - modelHipsLocalY;

            const backwardOffset = new THREE.Vector3(0, 0, 0.15);
            backwardOffset.applyQuaternion(this.torsoRotation);

            this.el.object3D.position.set(
              headPos.x + backwardOffset.x,
              bodyY,
              headPos.z + backwardOffset.z
            );
            this.el.object3D.quaternion.copy(this.torsoRotation);

            this.updateBones(headPos, headQuat, leftHandPos, rightHandPos, leftHandQuat, rightHandQuat);

            // Position remote player's rackets directly at hand positions (bypasses IK)
            if (this.botRackets) {
              // Left hand racket
              if (rd.leftHand) {
                this._tmpRacketQuat.set(rd.leftHand.qx, rd.leftHand.qy, rd.leftHand.qz, rd.leftHand.qw);
                this._tmpRacketOffsetVec.copy(this._racketOffset).applyQuaternion(this._tmpRacketQuat);
                this.botRackets.left.position.set(
                  rd.leftHand.x + this._tmpRacketOffsetVec.x,
                  rd.leftHand.y + this._tmpRacketOffsetVec.y,
                  rd.leftHand.z + this._tmpRacketOffsetVec.z
                );
                this.botRackets.left.quaternion.copy(this._tmpRacketQuat).multiply(this._racketRotOffset);
              }
              // Right hand racket
              if (rd.rightHand) {
                this._tmpRacketQuat.set(rd.rightHand.qx, rd.rightHand.qy, rd.rightHand.qz, rd.rightHand.qw);
                this._tmpRacketOffsetVec.copy(this._racketOffset).applyQuaternion(this._tmpRacketQuat);
                this.botRackets.right.position.set(
                  rd.rightHand.x + this._tmpRacketOffsetVec.x,
                  rd.rightHand.y + this._tmpRacketOffsetVec.y,
                  rd.rightHand.z + this._tmpRacketOffsetVec.z
                );
                this.botRackets.right.quaternion.copy(this._tmpRacketQuat).multiply(this._racketRotOffset);
              }

              // StacksVR has no DodgeVR racketMode — keep wireframe rackets hidden
              if (!window.replayActive) {
                var rm = window.racketMode && window.racketMode.player1;
                this.botRackets.left.visible = !!(rm && rm.left);
                this.botRackets.right.visible = !!(rm && rm.right);
              }
            }
            return;
          }

          // --- Singleplayer: Mirror mode (bot mirrors player body) ---
          if (window.botMirrorMode) {
            if (!this._mirrorRefs) {
              this._mirrorRefs = true;
              this._mirrorCamera = document.querySelector('[camera]');
              this._mirrorLeftCtrl = document.querySelector('#leftHand');
              this._mirrorRightCtrl = document.querySelector('#rightHand');
              this._mirrorPlayerBall = document.querySelector('[simple-grab="player: player2"]');
              this._mirrorBotBall = document.querySelector('[simple-grab="player: player1"]');
              this._mirrorPlayerWasGrabbed = false;
              this._mirrorYFlip = new THREE.Quaternion(0, 1, 0, 0); // 180° around Y
              // Swept collision tracking for mirrored rackets
              this._mrLastPos = { left: null, right: null };
              this._mrLastQuat = { left: new THREE.Quaternion(), right: new THREE.Quaternion() };
              this._mrLastTime = 0;
              this._mrVel = { left: new THREE.Vector3(), right: new THREE.Vector3() };
              this._mrLastHit = 0;
              this._mrTmpVec = new THREE.Vector3();
              this._mrTmpLocal = new THREE.Vector3();
              this._mrTmpInvQ = new THREE.Quaternion();
              this._mrTmpRp = new THREE.Vector3();
              this._mrTmpBp = new THREE.Vector3();
            }

            const cam = this._mirrorCamera;
            const lCtrl = this._mirrorLeftCtrl;
            const rCtrl = this._mirrorRightCtrl;
            if (!cam || !lCtrl || !rCtrl) return;

            const pHeadPos = new THREE.Vector3();
            const pHeadQuat = new THREE.Quaternion();
            const pLeftPos = new THREE.Vector3();
            const pLeftQuat = new THREE.Quaternion();
            const pRightPos = new THREE.Vector3();
            const pRightQuat = new THREE.Quaternion();

            cam.object3D.getWorldPosition(pHeadPos);
            cam.object3D.getWorldQuaternion(pHeadQuat);
            lCtrl.object3D.getWorldPosition(pLeftPos);
            lCtrl.object3D.getWorldQuaternion(pLeftQuat);
            rCtrl.object3D.getWorldPosition(pRightPos);
            rCtrl.object3D.getWorldQuaternion(pRightQuat);

            // 180° Y rotation: negate X and Z, same hand mapping (no swap)
            const mHeadPos = new THREE.Vector3(-pHeadPos.x, pHeadPos.y, -pHeadPos.z);
            const mLeftPos = new THREE.Vector3(-pLeftPos.x, pLeftPos.y, -pLeftPos.z);
            const mRightPos = new THREE.Vector3(-pRightPos.x, pRightPos.y, -pRightPos.z);

            // Rotate quaternions 180° around Y (same pattern as multiplayer mirroring)
            const mHeadQuat = pHeadQuat.clone().premultiply(this._mirrorYFlip);
            const mLeftQuat = pLeftQuat.clone().premultiply(this._mirrorYFlip);
            const mRightQuat = pRightQuat.clone().premultiply(this._mirrorYFlip);

            // Head velocity for dynamic lean
            if (this.previousHeadPosInitialized) {
              this.headVelocity.copy(mHeadPos).sub(this.previousHeadPos).divideScalar(dt || 0.016);
            } else {
              this.previousHeadPosInitialized = true;
            }
            this.previousHeadPos.copy(mHeadPos);

            this.calculateTorsoOrientation(mHeadPos, mHeadQuat, mLeftPos, mRightPos, dt);

            const desiredHipsY = mHeadPos.y - 0.65;
            const modelHipsLocalY = 1.0;
            const bodyY = desiredHipsY - modelHipsLocalY;

            const backOff = new THREE.Vector3(0, 0, 0.15);
            backOff.applyQuaternion(this.torsoRotation);

            this.el.object3D.position.set(
              mHeadPos.x + backOff.x,
              bodyY,
              mHeadPos.z + backOff.z
            );
            this.el.object3D.quaternion.copy(this.torsoRotation);

            this.updateBones(mHeadPos, mHeadQuat, mLeftPos, mRightPos, mLeftQuat, mRightQuat);
            this._storePose(mHeadPos, mHeadQuat, mLeftPos, mRightPos, mLeftQuat, mRightQuat);

            // Position mirrored rackets and check collisions with bot's ball
            if (this.botRackets) {
              // Left hand racket
              this._tmpRacketQuat.copy(mLeftQuat);
              this._tmpRacketOffsetVec.copy(this._racketOffset).applyQuaternion(this._tmpRacketQuat);
              this.botRackets.left.position.set(
                mLeftPos.x + this._tmpRacketOffsetVec.x,
                mLeftPos.y + this._tmpRacketOffsetVec.y,
                mLeftPos.z + this._tmpRacketOffsetVec.z
              );
              this.botRackets.left.quaternion.copy(this._tmpRacketQuat).multiply(this._racketRotOffset);

              // Right hand racket
              this._tmpRacketQuat.copy(mRightQuat);
              this._tmpRacketOffsetVec.copy(this._racketOffset).applyQuaternion(this._tmpRacketQuat);
              this.botRackets.right.position.set(
                mRightPos.x + this._tmpRacketOffsetVec.x,
                mRightPos.y + this._tmpRacketOffsetVec.y,
                mRightPos.z + this._tmpRacketOffsetVec.z
              );
              this.botRackets.right.quaternion.copy(this._tmpRacketQuat).multiply(this._racketRotOffset);

              // Mirror the player's racket visibility (player2 state → bot rackets)
              var rm2 = window.racketMode && window.racketMode.player2;
              this.botRackets.left.visible = !!(rm2 && rm2.left);
              this.botRackets.right.visible = !!(rm2 && rm2.right);

              // Swept collision detection for mirrored rackets vs player1's ball
              const mrNow = performance.now();
              const mrDt = Math.max((mrNow - (this._mrLastTime || mrNow)) / 1000, 0.001);
              this._mrLastTime = mrNow;
              const botBallGrab = this._mirrorBotBall?.components?.['simple-grab'];
              const playerHolding = this._mirrorPlayerBall?.components?.['simple-grab']?.isGrabbed;
              if (botBallGrab?.body && !playerHolding && mrNow - this._mrLastHit > 100) {
                const sides = ['left', 'right'];
                for (let si = 0; si < sides.length; si++) {
                  const side = sides[si];
                  if (!this.botRackets[side].visible) continue;
                  const curPos = this.botRackets[side].position;
                  const curQuat = this.botRackets[side].quaternion;
                  if (!this._mrLastPos[side]) {
                    this._mrLastPos[side] = curPos.clone();
                    this._mrLastQuat[side].copy(curQuat);
                    continue;
                  }
                  // Compute racket velocity
                  this._mrVel[side].subVectors(curPos, this._mrLastPos[side]).divideScalar(mrDt);
                  // Swept box-sphere collision (same logic as static-physics rackets)
                  const halfW = 0.1, halfH = 0.1, halfD = 0.01;
                  const ballBody = botBallGrab.body;
                  const ballR = ballBody.shapes[0] ? ballBody.shapes[0].radius : 0.1;
                  const ballPos = this._mrTmpVec.set(ballBody.position.x, ballBody.position.y, ballBody.position.z);
                  this._mrTmpInvQ.copy(curQuat).invert();
                  const startP = this._mrLastPos[side];
                  const endP = curPos;
                  const moveDist = startP.distanceTo(endP);
                  const numSteps = Math.min(Math.max(Math.ceil(Math.max(moveDist, 0.001) * 40), 5), 30);
                  let hit = false;
                  for (let i = 0; i <= numSteps; i++) {
                    const t = i / numSteps;
                    this._mrTmpRp.lerpVectors(startP, endP, t);
                    this._mrTmpLocal.copy(ballPos).sub(this._mrTmpRp).applyQuaternion(this._mrTmpInvQ);
                    const lx = this._mrTmpLocal.x, ly = this._mrTmpLocal.y, lz = this._mrTmpLocal.z;
                    const cx = Math.max(-halfW, Math.min(halfW, lx));
                    const cy = Math.max(-halfH, Math.min(halfH, ly));
                    const cz = Math.max(-halfD, Math.min(halfD, lz));
                    const dx = lx-cx, dy = ly-cy, dz = lz-cz;
                    if (dx*dx + dy*dy + dz*dz <= ballR*ballR) { hit = true; break; }
                  }
                  if (hit) {
                    this._mrLastHit = mrNow;
                    this._applyMirroredRacketImpact(botBallGrab, curPos, curQuat, this._mrVel[side]);
                  }
                  this._mrLastPos[side].copy(curPos);
                  this._mrLastQuat[side].copy(curQuat);
                }
              } else {
                // Update tracking even when not checking collision
                if (this._mrLastPos.left) this._mrLastPos.left.copy(this.botRackets.left.position);
                else this._mrLastPos.left = this.botRackets.left.position.clone();
                if (this._mrLastPos.right) this._mrLastPos.right.copy(this.botRackets.right.position);
                else this._mrLastPos.right = this.botRackets.right.position.clone();
                this._mrLastQuat.left.copy(this.botRackets.left.quaternion);
                this._mrLastQuat.right.copy(this.botRackets.right.quaternion);
              }
            }

            // Move bot entity (hit targets) to follow mirrored head
            if (!this.botEntity) {
              this.botEntity = document.querySelector(this.data.botEntitySelector);
            }
            if (this.botEntity) {
              this.botEntity.object3D.position.set(mHeadPos.x, mHeadPos.y - 0.4, mHeadPos.z);
            }

            // Finger curls: same hand mapping (no swap)
            const lGP = lCtrl.components['tracked-controls']?.controller?.gamepad;
            const rGP = rCtrl.components['tracked-controls']?.controller?.gamepad;
            if (lGP && lGP.buttons) {
              const t = lGP.buttons[0]?.value || 0;
              const g = lGP.buttons[1]?.value || 0;
              let th = 0;
              for (let i = 2; i <= 6; i++) { if (lGP.buttons[i]?.touched) { th = 1; break; } }
              this.updateTargetCurls('left', t, g, th);
            }
            if (rGP && rGP.buttons) {
              const t = rGP.buttons[0]?.value || 0;
              const g = rGP.buttons[1]?.value || 0;
              let th = 0;
              for (let i = 2; i <= 6; i++) { if (rGP.buttons[i]?.touched) { th = 1; break; } }
              this.updateTargetCurls('right', t, g, th);
            }
            ['left', 'right'].forEach(hand => {
              ['thumb', 'index', 'middle', 'ring', 'pinky'].forEach(finger => {
                const cur = this.currentCurls[hand][finger];
                const tgt = this.targetCurls[hand][finger];
                this.currentCurls[hand][finger] = cur + (tgt - cur) * this.fingerSmoothingFactor;
              });
            });
            this.applyFingerCurls('left', this.currentCurls.left);
            this.applyFingerCurls('right', this.currentCurls.right);

            // --- Mirror ball tracking ---
            const pGrab = this._mirrorPlayerBall?.components?.['simple-grab'];
            const bGrab = this._mirrorBotBall?.components?.['simple-grab'];
            if (pGrab && bGrab) {
              const playerGrabbed = pGrab.isGrabbed;

              if (playerGrabbed && pGrab.grabbingHand) {
                const hPos = new THREE.Vector3();
                pGrab.grabbingHand.object3D.getWorldPosition(hPos);
                const mirBallPos = new THREE.Vector3(-hPos.x, hPos.y, -hPos.z);

                bGrab.body.position.set(mirBallPos.x, mirBallPos.y, mirBallPos.z);
                bGrab.body.velocity.set(0, 0, 0);
                bGrab.body.angularVelocity.set(0, 0, 0);
                bGrab.body.gravity.set(0, 0, 0);
                bGrab.body.mass = 1000;
                bGrab.body.updateMassProperties();
                this._mirrorBotBall.object3D.position.copy(mirBallPos);
              } else if (this._mirrorPlayerWasGrabbed && !playerGrabbed) {
                const vel = pGrab.body.velocity;
                bGrab.body.velocity.set(-vel.x, vel.y, -vel.z);
                const avel = pGrab.body.angularVelocity;
                bGrab.body.angularVelocity.set(-avel.x, avel.y, -avel.z);
                bGrab.body.mass = 1;
                bGrab.body.updateMassProperties();
                bGrab.body.gravity.set(0, 0, 0);
                bGrab.isReturning = false;
              }

              this._mirrorPlayerWasGrabbed = playerGrabbed;
            }

            // --- Motion recording for clip library ---
            if (window.motionRecorder) {
              var pGrabRec = this._mirrorPlayerBall ? this._mirrorPlayerBall.components['simple-grab'] : null;
              var bGrabRec = this._mirrorBotBall ? this._mirrorBotBall.components['simple-grab'] : null;
              var recBallPos = null;
              if (pGrabRec && pGrabRec.isGrabbed && pGrabRec.grabbingHand) {
                var hpRec = new THREE.Vector3();
                pGrabRec.grabbingHand.object3D.getWorldPosition(hpRec);
                recBallPos = { x: -hpRec.x, y: hpRec.y, z: -hpRec.z };
              }
              window.motionRecorder.recordFrame({
                hp: mHeadPos, hq: mHeadQuat,
                lp: mLeftPos, lq: mLeftQuat,
                rp: mRightPos, rq: mRightQuat,
                lc: this.currentCurls.left,
                rc: this.currentCurls.right,
                bg: pGrabRec ? pGrabRec.isGrabbed : false,
                bp: recBallPos,
                obv: bGrabRec && bGrabRec.body ? bGrabRec.body.velocity : null,
                oba: bGrabRec && bGrabRec.body ? bGrabRec.body.angularVelocity : null
              });
            }

            return;
          }

          // --- Singleplayer: Recorded mode clip playback ---
          if (window.botRecordedMode && window.motionPlayback && window.motionPlayback.isPlaying) {
            var pbFrame = window.motionPlayback.getFrame();
            if (pbFrame) {
              this._ensureBlendPose();

              if (!this._pbRefs) {
                this._pbRefs = true;
                this._pbBotBall = document.querySelector('[simple-grab="player: player1"]');
                this._pbBallHeld = false;
              }

              var pbHeadPos = new THREE.Vector3(pbFrame.hp[0], pbFrame.hp[1], pbFrame.hp[2]);
              var pbHeadQuat = new THREE.Quaternion(pbFrame.hq[0], pbFrame.hq[1], pbFrame.hq[2], pbFrame.hq[3]);
              var pbLeftPos = new THREE.Vector3(pbFrame.lp[0], pbFrame.lp[1], pbFrame.lp[2]);
              var pbLeftQuat = new THREE.Quaternion(pbFrame.lq[0], pbFrame.lq[1], pbFrame.lq[2], pbFrame.lq[3]);
              var pbRightPos = new THREE.Vector3(pbFrame.rp[0], pbFrame.rp[1], pbFrame.rp[2]);
              var pbRightQuat = new THREE.Quaternion(pbFrame.rq[0], pbFrame.rq[1], pbFrame.rq[2], pbFrame.rq[3]);

              var targetPose = { headPos: pbHeadPos, headQuat: pbHeadQuat, leftPos: pbLeftPos, rightPos: pbRightPos, leftQuat: pbLeftQuat, rightQuat: pbRightQuat };

              if (!this._wasInPlayback && this._lastAppliedPose) {
                this._blendState = 'into';
                this._blendProgress = 0;
                this._blendFromPose.headPos.copy(this._lastAppliedPose.headPos);
                this._blendFromPose.headQuat.copy(this._lastAppliedPose.headQuat);
                this._blendFromPose.leftPos.copy(this._lastAppliedPose.leftPos);
                this._blendFromPose.rightPos.copy(this._lastAppliedPose.rightPos);
                this._blendFromPose.leftQuat.copy(this._lastAppliedPose.leftQuat);
                this._blendFromPose.rightQuat.copy(this._lastAppliedPose.rightQuat);
                this._blendFromBodyPos.copy(this.el.object3D.position);
                this._blendFromBodyQuat.copy(this.el.object3D.quaternion);
              }
              this._wasInPlayback = true;

              var headPos, headQuat, leftHandPos, rightHandPos, leftHandQuat, rightHandQuat;
              if (this._blendState === 'into') {
                this._blendProgress += (dt || 0.016) / this.blendDuration;
                var rawT = Math.min(1, this._blendProgress);
                var t = rawT * rawT * (3 - 2 * rawT);
                this._bodyBlendT = rawT < 1 ? t : undefined;
                var blended = this._blendPose(this._blendFromPose, targetPose, t, this._lastAppliedPose);
                headPos = blended.headPos;
                headQuat = blended.headQuat;
                leftHandPos = blended.leftPos;
                rightHandPos = blended.rightPos;
                leftHandQuat = blended.leftQuat;
                rightHandQuat = blended.rightQuat;
                if (rawT >= 1) this._blendState = 'none';
              } else {
                headPos = pbHeadPos;
                headQuat = pbHeadQuat;
                leftHandPos = pbLeftPos;
                rightHandPos = pbRightPos;
                leftHandQuat = pbLeftQuat;
                rightHandQuat = pbRightQuat;
              }

              this._storePose(headPos, headQuat, leftHandPos, rightHandPos, leftHandQuat, rightHandQuat);

              if (this.previousHeadPosInitialized) {
                this.headVelocity.copy(headPos).sub(this.previousHeadPos).divideScalar(dt || 0.016);
              } else {
                this.previousHeadPosInitialized = true;
              }
              this.previousHeadPos.copy(headPos);

              this.calculateTorsoOrientation(headPos, headQuat, leftHandPos, rightHandPos, dt);

              var pbHipsY = headPos.y - 0.65;
              var pbBodyY = pbHipsY - 1.0;
              var pbBackOff = new THREE.Vector3(0, 0, 0.15);
              pbBackOff.applyQuaternion(this.torsoRotation);
              if (this._bodyBlendT !== undefined) {
                var _tbp = new THREE.Vector3(headPos.x + pbBackOff.x, pbBodyY, headPos.z + pbBackOff.z);
                this.el.object3D.position.lerpVectors(this._blendFromBodyPos, _tbp, this._bodyBlendT);
                this.el.object3D.quaternion.copy(this._blendFromBodyQuat).slerp(this.torsoRotation, this._bodyBlendT);
                this._bodyBlendT = undefined;
              } else {
                this.el.object3D.position.set(headPos.x + pbBackOff.x, pbBodyY, headPos.z + pbBackOff.z);
                this.el.object3D.quaternion.copy(this.torsoRotation);
              }

              this.updateBones(headPos, headQuat, leftHandPos, rightHandPos, leftHandQuat, rightHandQuat);

              if (pbFrame.fc && pbFrame.fc.length === 10) {
                this.applyFingerCurls('left', {
                  thumb: pbFrame.fc[0], index: pbFrame.fc[1], middle: pbFrame.fc[2],
                  ring: pbFrame.fc[3], pinky: pbFrame.fc[4]
                });
                this.applyFingerCurls('right', {
                  thumb: pbFrame.fc[5], index: pbFrame.fc[6], middle: pbFrame.fc[7],
                  ring: pbFrame.fc[8], pinky: pbFrame.fc[9]
                });
              }

              if (!this.botEntity) this.botEntity = document.querySelector(this.data.botEntitySelector);
              if (this.botEntity) this.botEntity.object3D.position.set(headPos.x, headPos.y - 0.4, headPos.z);

              var pbBallGrab = this._pbBotBall ? this._pbBotBall.components['simple-grab'] : null;
              if (pbBallGrab && pbBallGrab.body) {
                if (pbFrame.bg && !pbFrame.justReleased) {
                  var bpx, bpy, bpz;
                  if (pbFrame.bp) {
                    bpx = pbFrame.bp[0]; bpy = pbFrame.bp[1]; bpz = pbFrame.bp[2];
                  } else {
                    bpx = pbRightPos.x; bpy = pbRightPos.y; bpz = pbRightPos.z;
                  }
                  pbBallGrab.body.position.set(bpx, bpy, bpz);
                  pbBallGrab.body.velocity.set(0, 0, 0);
                  pbBallGrab.body.angularVelocity.set(0, 0, 0);
                  pbBallGrab.body.gravity.set(0, 0, 0);
                  pbBallGrab.body.mass = 1000;
                  pbBallGrab.body.updateMassProperties();
                  pbBallGrab.isGrabbed = true;
                  this._pbBotBall.object3D.position.set(bpx, bpy, bpz);
                  this._pbBallHeld = true;
                  this._pbReleaseGraceEnd = 0;
                } else if (pbFrame.justReleased && pbFrame.rv) {
                  pbBallGrab._pendingAction = 'throw';
                  pbBallGrab.snapshotOpponentPos();
                  pbBallGrab.body.velocity.set(pbFrame.rv.x, pbFrame.rv.y, pbFrame.rv.z);
                  capBallSpeed('player1', pbBallGrab.body);
                  var rav = pbFrame.rav;
                  pbBallGrab.body.angularVelocity.set(
                    rav ? rav.x : 0, rav ? rav.y : 0, rav ? rav.z : 0);
                  pbBallGrab.body.mass = 1;
                  pbBallGrab.body.updateMassProperties();
                  pbBallGrab.body.gravity.set(0, 0, 0);
                  pbBallGrab.isReturning = false;
                  this._pbBallHeld = false;
                  this._pbReleaseGraceEnd = performance.now() + 300;
                } else if (this._pbReleaseGraceEnd && performance.now() > this._pbReleaseGraceEnd) {
                  pbBallGrab.isGrabbed = false;
                  pbBallGrab.grabbingHand = null;
                  this._pbReleaseGraceEnd = 0;
                }
              }

              return;
            }
            // Clip ended: start blend-out from last frame to idle, then reset
            this._wasInPlayback = false;
            if (this._lastAppliedPose) {
              this._blendState = 'outof';
              this._blendProgress = 0;
              this._blendFromPose.headPos.copy(this._lastAppliedPose.headPos);
              this._blendFromPose.headQuat.copy(this._lastAppliedPose.headQuat);
              this._blendFromPose.leftPos.copy(this._lastAppliedPose.leftPos);
              this._blendFromPose.rightPos.copy(this._lastAppliedPose.rightPos);
              this._blendFromPose.leftQuat.copy(this._lastAppliedPose.leftQuat);
              this._blendFromPose.rightQuat.copy(this._lastAppliedPose.rightQuat);
              this._blendFromBodyPos.copy(this.el.object3D.position);
              this._blendFromBodyQuat.copy(this.el.object3D.quaternion);
            }
            if (this.botEntity) this.botEntity.object3D.position.set(0, 1.6, -6);
            var clipEndGrab = this._pbBotBall ? this._pbBotBall.components['simple-grab'] : null;
            if (clipEndGrab) {
              clipEndGrab.isGrabbed = false;
              clipEndGrab.grabbingHand = null;
            }
            if (this._pbBallHeld) {
              if (clipEndGrab) clipEndGrab.resetPosition();
              this._pbBallHeld = false;
            }
            this._pbReleaseGraceEnd = 0;
            this._pbRefs = false;
          }

          // --- Singleplayer: Blend-out (serve end -> idle) ---
          if (window.botRecordedMode && this._blendState === 'outof') {
            if (!this.botEntity) {
              this.botEntity = document.querySelector(this.data.botEntitySelector);
              if (!this.botEntity) return;
            }
            const botWorldPos = new THREE.Vector3();
            this.botEntity.object3D.getWorldPosition(botWorldPos);
            const bodyCenter = botWorldPos.clone();
            const idleHeadPos = new THREE.Vector3(bodyCenter.x, bodyCenter.y + 0.3, bodyCenter.z);
            const idleHeadQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
            const idleLeftPos = new THREE.Vector3(bodyCenter.x + 0.3, bodyCenter.y - 0.2, bodyCenter.z + 0.25);
            const idleRightPos = new THREE.Vector3(bodyCenter.x - 0.3, bodyCenter.y - 0.2, bodyCenter.z + 0.25);
            const idleLeftQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
            const idleRightQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
            const idlePose = { headPos: idleHeadPos, headQuat: idleHeadQuat, leftPos: idleLeftPos, rightPos: idleRightPos, leftQuat: idleLeftQuat, rightQuat: idleRightQuat };

            this._blendProgress += (dt || 0.016) / this.blendDuration;
            var rawT = Math.min(1, this._blendProgress);
            var t = rawT * rawT * (3 - 2 * rawT);
            var blended = this._blendPose(this._blendFromPose, idlePose, t, this._lastAppliedPose);
            this._storePose(blended.headPos, blended.headQuat, blended.leftPos, blended.rightPos, blended.leftQuat, blended.rightQuat);

            if (this.previousHeadPosInitialized) {
              this.headVelocity.copy(blended.headPos).sub(this.previousHeadPos).divideScalar(dt || 0.016);
            } else {
              this.previousHeadPosInitialized = true;
            }
            this.previousHeadPos.copy(blended.headPos);
            this.calculateTorsoOrientation(blended.headPos, blended.headQuat, blended.leftPos, blended.rightPos, dt);
            const modelChestLocalY = 1.25;
            const backwardOffset = new THREE.Vector3(0, 0, 0.15);
            backwardOffset.applyQuaternion(this.torsoRotation);
            var targetBodyPos = new THREE.Vector3(bodyCenter.x + backwardOffset.x, bodyCenter.y - modelChestLocalY, bodyCenter.z + backwardOffset.z);
            if (rawT < 1) {
              this.el.object3D.position.lerpVectors(this._blendFromBodyPos, targetBodyPos, t);
              this.el.object3D.quaternion.copy(this._blendFromBodyQuat).slerp(this.torsoRotation, t);
            } else {
              this.el.object3D.position.copy(targetBodyPos);
              this.el.object3D.quaternion.copy(this.torsoRotation);
            }
            this.updateBones(blended.headPos, blended.headQuat, blended.leftPos, blended.rightPos, blended.leftQuat, blended.rightQuat);
            const botCurls = { thumb: 0.15, index: 0.2, middle: 0.25, ring: 0.3, pinky: 0.3 };
            this.applyFingerCurls('left', botCurls);
            this.applyFingerCurls('right', botCurls);
            if (rawT >= 1) this._blendState = 'none';
            return;
          }

          // --- Singleplayer: AI idle animation ---
          if (!this.botEntity) {
            this.botEntity = document.querySelector(this.data.botEntitySelector);
            if (!this.botEntity) return;
          }

          const botWorldPos = new THREE.Vector3();
          this.botEntity.object3D.getWorldPosition(botWorldPos);

          this.idleTime += dt;

          // Use the bot entity position as the body's anchor point
          const bodyCenter = botWorldPos.clone();

          // Head is ~0.3m above the body center
          headPos = new THREE.Vector3(bodyCenter.x, bodyCenter.y + 0.3, bodyCenter.z);

          // Head facing +Z (toward player)
          headQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

          // Idle hand animation with subtle sway
          const swayX = Math.sin(this.idleTime * 1.5) * 0.03;
          const swayY = Math.sin(this.idleTime * 2.0) * 0.02;
          const swayZ = Math.cos(this.idleTime * 1.2) * 0.02;

          // Hands relative to body center (ready stance)
          // Note: positions are mirrored because the model has double rotation
          // (FBX PI + entity PI), so the IK solver's left/right is flipped
          leftHandPos = new THREE.Vector3(
            bodyCenter.x + 0.3 - swayX,
            bodyCenter.y - 0.2 + swayY,
            bodyCenter.z + 0.25 + swayZ
          );
          rightHandPos = new THREE.Vector3(
            bodyCenter.x - 0.3 + swayX,
            bodyCenter.y - 0.2 + swayY,
            bodyCenter.z + 0.25 - swayZ
          );

          // Hand orientations (palms facing inward)
          leftHandQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));
          rightHandQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI, 0));

          var rt = window.botReactionTarget;
          if (rt && rt.handTarget && rt.progress > 0) {
            var ht = rt.handTarget;
            var p = rt.progress;
            if (ht.x >= bodyCenter.x) {
              leftHandPos.lerp(new THREE.Vector3(ht.x, ht.y, ht.z), p);
            } else {
              rightHandPos.lerp(new THREE.Vector3(ht.x, ht.y, ht.z), p);
            }
          }

          if (rt && rt.progress > 0) {
            if (this.previousHeadPosInitialized) {
              this.headVelocity.subVectors(headPos, this.previousHeadPos).multiplyScalar(1 / dt);
            }
          } else {
            this.headVelocity.set(0, 0, 0);
          }
          if (!this.previousHeadPosInitialized) this.previousHeadPosInitialized = true;
          this.previousHeadPos.copy(headPos);

          // Torso faces +Z (toward player)
          const targetRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
          this.torsoRotation.slerp(targetRotation, this.smoothingFactor);

          // Position body so chest (model local y~1.25) aligns with bot entity center
          const modelChestLocalY = 1.25;
          const backwardOffset = new THREE.Vector3(0, 0, 0.15);
          backwardOffset.applyQuaternion(this.torsoRotation);

          this.el.object3D.position.set(
            bodyCenter.x + backwardOffset.x,
            bodyCenter.y - modelChestLocalY,
            bodyCenter.z + backwardOffset.z
          );
          this.el.object3D.quaternion.copy(this.torsoRotation);

          // Update bones with IK
          this.updateBones(headPos, headQuat, leftHandPos, rightHandPos, leftHandQuat, rightHandQuat);

          this._storePose(headPos, headQuat, leftHandPos, rightHandPos, leftHandQuat, rightHandQuat);

          // Apply relaxed finger curls for bot
          const botCurls = { thumb: 0.15, index: 0.2, middle: 0.25, ring: 0.3, pinky: 0.3 };
          this.applyFingerCurls('left', botCurls);
          this.applyFingerCurls('right', botCurls);
        },

        // ---- Pose blending (idle <-> serve transitions) ----

        _ensureBlendPose: function() {
          if (!this._lastAppliedPose) {
            this._lastAppliedPose = {
              headPos: new THREE.Vector3(),
              headQuat: new THREE.Quaternion(),
              leftPos: new THREE.Vector3(),
              rightPos: new THREE.Vector3(),
              leftQuat: new THREE.Quaternion(),
              rightQuat: new THREE.Quaternion()
            };
          }
          if (!this._blendFromPose) {
            this._blendFromPose = {
              headPos: new THREE.Vector3(),
              headQuat: new THREE.Quaternion(),
              leftPos: new THREE.Vector3(),
              rightPos: new THREE.Vector3(),
              leftQuat: new THREE.Quaternion(),
              rightQuat: new THREE.Quaternion()
            };
          }
          if (!this._blendFromBodyPos) this._blendFromBodyPos = new THREE.Vector3();
          if (!this._blendFromBodyQuat) this._blendFromBodyQuat = new THREE.Quaternion();
        },

        _storePose: function(headPos, headQuat, leftPos, rightPos, leftQuat, rightQuat) {
          this._ensureBlendPose();
          var p = this._lastAppliedPose;
          p.headPos.copy(headPos);
          p.headQuat.copy(headQuat);
          p.leftPos.copy(leftPos);
          p.rightPos.copy(rightPos);
          p.leftQuat.copy(leftQuat);
          p.rightQuat.copy(rightQuat);
        },

        _blendPose: function(from, to, t, out) {
          out.headPos.lerpVectors(from.headPos, to.headPos, t);
          out.headQuat.copy(from.headQuat).slerp(to.headQuat, t);
          out.leftPos.lerpVectors(from.leftPos, to.leftPos, t);
          out.rightPos.lerpVectors(from.rightPos, to.rightPos, t);
          out.leftQuat.copy(from.leftQuat).slerp(to.leftQuat, t);
          out.rightQuat.copy(from.rightQuat).slerp(to.rightQuat, t);
          return out;
        },

        // ---- Torso orientation (blends head forward + shoulder line) ----

        calculateTorsoOrientation: function(headPos, headQuat, leftHandPos, rightHandPos, dt) {
          const headForwardFlat = new THREE.Vector3(0, 0, -1).applyQuaternion(headQuat);
          headForwardFlat.y = 0;
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

          let controllerWeight = 0.8;
          if (shoulderDist < 0.25) controllerWeight = 0.3;
          else if (shoulderDist > 0.35) controllerWeight = 1.0;

          const blendedForward = new THREE.Vector3()
            .addScaledVector(controllerForward, controllerWeight)
            .addScaledVector(headForwardFlat, 1.0 - controllerWeight)
            .normalize();

          const targetRotation = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 0, -1),
            blendedForward
          );

          this.torsoRotation.slerp(targetRotation, this.smoothingFactor);
        },

        // ---- Bone update (spine, head, IK arms) ----

        updateBones: function(headPos, headQuat, leftHandPos, rightHandPos, leftHandQuat, rightHandQuat) {
          // Reset bones to T-pose
          if (this.bones.hips) this.bones.hips.quaternion.identity();
          if (this.bones.spine) this.bones.spine.quaternion.identity();
          if (this.bones.spine1) this.bones.spine1.quaternion.identity();
          if (this.bones.spine2) this.bones.spine2.quaternion.identity();

          // Spine bending from hand positions + movement lean
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

          // Dynamic movement lean
          const localVelocity = this.headVelocity.clone();
          localVelocity.applyQuaternion(invTorsoRot);

          const targetLean = new THREE.Vector3(
            localVelocity.z * 0.8,
            0,
            -localVelocity.x * 0.5
          );
          this.torsoLean.lerp(targetLean, this.torsoLeanVelocity);

          const totalForwardLean = handForwardLean + this.torsoLean.x;
          const totalSideLean = handSideLean + this.torsoLean.z;

          // Breathing
          const breathingExpansion = Math.sin(this.breathingPhase) * this.breathingAmount;

          // Distribute lean across spine segments
          if (this.bones.spine || this.bones.spine1 || this.bones.spine2) {
            const spineRotations = [
              { bone: this.bones.spine, amount: 0.25, ba: 0.3 },
              { bone: this.bones.spine1, amount: 0.35, ba: 0.4 },
              { bone: this.bones.spine2, amount: 0.4, ba: 0.3 }
            ];

            spineRotations.forEach(({ bone, amount, ba }) => {
              if (bone) {
                const breathingLean = -breathingExpansion * ba;
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

          // Head rotation relative to body
          if (this.bones.neck) {
            const relativeHeadQuat = headQuat.clone();
            const invBodyQuat = this.torsoRotation.clone().invert();
            relativeHeadQuat.premultiply(invBodyQuat);

            // Model is rotated 180 Y - flip X and Z
            const euler = new THREE.Euler().setFromQuaternion(relativeHeadQuat, 'YXZ');
            euler.x = -euler.x;
            euler.z = -euler.z;

            const correctedQuat = new THREE.Quaternion().setFromEuler(euler);
            this.bones.neck.quaternion.copy(correctedQuat);
          }

          // Solve arm IK
          this.solveArmIK('left', leftHandPos, leftHandQuat);
          this.solveArmIK('right', rightHandPos, rightHandQuat);
        },

        // ---- Two-bone IK solver for arms ----

        solveArmIK: function(hand, handWorldPos, handWorldQuat) {
          const shoulderBone = this.bones[`${hand}Shoulder`];
          const upperArmBone = this.bones[`${hand}UpperArm`];
          const forearmBone = this.bones[`${hand}Forearm`];
          const handBone = this.bones[`${hand}HandBone`];

          if (!shoulderBone || !upperArmBone || !forearmBone) return;

          // Get shoulder world position from skeleton
          const shoulderWorldPos = new THREE.Vector3();
          shoulderBone.getWorldPosition(shoulderWorldPos);

          // Adjust hand position for hand bone offset
          const adjustedHandPos = handWorldPos.clone();
          const leftRightOffsetLocal = new THREE.Vector3(hand === 'left' ? 0.1 : -0.1, 0, 0);
          const leftRightOffsetWorld = leftRightOffsetLocal.applyQuaternion(this.el.object3D.quaternion);
          adjustedHandPos.add(leftRightOffsetWorld);

          // Clamp to reachable range
          const shoulderToHand = adjustedHandPos.clone().sub(shoulderWorldPos);
          const distance = shoulderToHand.length();
          const maxReach = (this.config.upperArmLength + this.config.lowerArmLength) * 0.999;
          const minReach = Math.abs(this.config.upperArmLength - this.config.lowerArmLength) * 1.001;

          let targetHandPos = adjustedHandPos.clone();
          if (distance > maxReach) {
            targetHandPos = shoulderWorldPos.clone().add(shoulderToHand.normalize().multiplyScalar(maxReach));
          } else if (distance < minReach) {
            targetHandPos = shoulderWorldPos.clone().add(shoulderToHand.normalize().multiplyScalar(minReach));
          }

          // Law of cosines for elbow angle
          const toTarget = targetHandPos.clone().sub(shoulderWorldPos);
          const targetDist = toTarget.length();
          const toTargetDir = toTarget.normalize();

          const upperSq = this.config.upperArmLength * this.config.upperArmLength;
          const lowerSq = this.config.lowerArmLength * this.config.lowerArmLength;
          const distSq = targetDist * targetDist;

          const cosAngle = (upperSq + distSq - lowerSq) / (2 * this.config.upperArmLength * targetDist);
          const clampedCos = Math.max(-0.999, Math.min(0.999, cosAngle));
          const angle = Math.acos(clampedCos);

          // Elbow bend direction
          const bodyRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.torsoRotation);
          const bodyOutward = bodyRight.clone().multiplyScalar(hand === 'left' ? -1 : 1);

          let bendDir = new THREE.Vector3()
            .addScaledVector(bodyOutward, 0.4)
            .addScaledVector(new THREE.Vector3(0, -1, 0), 0.4)
            .normalize();

          // Blend hand orientation into elbow direction
          const handUp = new THREE.Vector3(0, 1, 0).applyQuaternion(handWorldQuat);
          bendDir.addScaledVector(handUp, 0.3);
          bendDir.normalize();

          // Make bend perpendicular to shoulder-hand direction
          bendDir.addScaledVector(toTargetDir, -bendDir.dot(toTargetDir)).normalize();

          // Calculate elbow position
          const elbowDir = new THREE.Vector3()
            .addScaledVector(toTargetDir, Math.cos(angle))
            .addScaledVector(bendDir, Math.sin(angle))
            .normalize();

          let elbowWorldPos = shoulderWorldPos.clone().add(elbowDir.multiplyScalar(this.config.upperArmLength));

          // Enforce exact bone lengths
          const shoulderToElbow = elbowWorldPos.clone().sub(shoulderWorldPos);
          if (Math.abs(shoulderToElbow.length() - this.config.upperArmLength) > 0.0001) {
            elbowWorldPos.copy(shoulderWorldPos).add(shoulderToElbow.normalize().multiplyScalar(this.config.upperArmLength));
          }

          const elbowToHand = targetHandPos.clone().sub(elbowWorldPos);
          if (Math.abs(elbowToHand.length() - this.config.lowerArmLength) > 0.0001) {
            targetHandPos.copy(elbowWorldPos).add(elbowToHand.normalize().multiplyScalar(this.config.lowerArmLength));
          }

          // Convert to bone rotations in local space
          this.el.object3D.updateMatrixWorld(true);

          // Upper arm rotation
          upperArmBone.parent.updateMatrixWorld(true);
          const shoulderInParent = upperArmBone.parent.worldToLocal(shoulderWorldPos.clone());
          const elbowInParent = upperArmBone.parent.worldToLocal(elbowWorldPos.clone());
          const upperArmParentDir = shoulderInParent.clone().sub(elbowInParent).normalize();
          const tPoseDir = new THREE.Vector3(0, -1, 0);
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
          forearmBone.updateMatrixWorld(true);
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
          forearmBone.updateMatrixWorld(true);

          // Hand bone orientation
          if (handBone) {
            forearmBone.updateMatrixWorld(true);

            const fwq = new THREE.Quaternion();
            forearmBone.getWorldQuaternion(fwq);

            let handLocalQuat = handWorldQuat.clone();
            handLocalQuat.premultiply(fwq.clone().invert());

            // 180 X flip correction for model rotation
            const localXFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
            handLocalQuat.multiply(localXFlip);

            // Roll correction
            const rollCorrection = new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(0, 1, 0),
              hand === 'left' ? Math.PI / 2 : -Math.PI / 2
            );
            handLocalQuat.multiply(rollCorrection);

            handBone.quaternion.copy(handLocalQuat);
          }
        }
      });
})();
