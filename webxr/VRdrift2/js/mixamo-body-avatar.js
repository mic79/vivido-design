      AFRAME.registerComponent('mixamo-body-avatar', {
        schema: {
          playerId: { type: 'string', default: 'local' },
          color: { type: 'color', default: '#4A90E2' },
          modelPath: { type: 'string', default: 'character.glb' },
          isRemote: { type: 'boolean', default: false },
          isBot: { type: 'boolean', default: false },
          hideHead: { type: 'boolean', default: false },
          hideBelowGut: { type: 'boolean', default: false },
          /** Hide skinned arm/hand meshes (use controller hand-controls models in VR) */
          hideArms: { type: 'boolean', default: false },
          /** 0–1 opacity on hips/chest skinned verts (1 = solid). */
          ghostTorsoOpacity: { type: 'number', default: 1 },
          lod: { type: 'string', default: 'high' } // high, medium, low
        },

        init: function() {
          this.skeleton = null;
          this.bones = {};
          this._palmDebug = {};
          this.model = null;
          this.modelLoaded = false;
          
          // References (will be set after init)
          this.camera = null;
          this.leftController = null;
          this.rightController = null;
          this.rig = null;
          
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
            leftUpLeg: 'mixamorigLeftUpLeg',
            leftLeg: 'mixamorigLeftLeg',
            leftFoot: 'mixamorigLeftFoot',
            rightUpLeg: 'mixamorigRightUpLeg',
            rightLeg: 'mixamorigRightLeg',
            rightFoot: 'mixamorigRightFoot',
            // Fingers (shortened for performance)
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
            upperArmLength: 0.31,
            lowerArmLength: 0.31,
            upperLegLength: 0.45,
            lowerLegLength: 0.45
          };
          
          // Smoothing
          this.torsoRotation = new THREE.Quaternion();
          this.bodyTilt = new THREE.Quaternion();
          this.smoothingFactor = 0.15;
          
          // Body dynamics
          this.previousHeadPos = new THREE.Vector3();
          this.previousHeadPosInitialized = false;
          this.headVelocity = new THREE.Vector3();
          this.headAcceleration = new THREE.Vector3();
          this.previousHeadVelocity = new THREE.Vector3();
          this.torsoLean = new THREE.Vector3();
          this.torsoLeanVelocity = 0.15;
          
          // Leg animation
          this.legIdlePhase = 0;
          this.legIdleRate = 0.3;
          this.legIdleAmount = 3;
          this.smoothedLegPose = {
            left: { hipFlex: 0, hipSpread: 0, kneeBend: 0, ankleFlex: 0, ankleSway: 0 },
            right: { hipFlex: 0, hipSpread: 0, kneeBend: 0, ankleFlex: 0, ankleSway: 0 }
          };
          this.legSmoothingFactor = 0.15;
          this.currentDominantDirection = 'rest';
          this.directionSwitchThreshold = 0.35;
          this.directionMaintainThreshold = 0.15;
          
          // Leg poses
          this.legPoses = {
            rest: { hipFlex: -10, hipSpread: 8, kneeBend: 20, ankleFlex: 15 },
            forward: { hipFlex: -5, hipSpread: 6, kneeBend: 15, ankleFlex: 10 },  // More upright for zero-G
            backward: { hipFlex: -20, hipSpread: 10, kneeBend: 30, ankleFlex: 25 },  // Less extreme bend
            up: { hipFlex: 5, hipSpread: 10, kneeBend: 25, ankleFlex: 30 },  // Reduced upward pose
            down: { hipFlex: -25, hipSpread: 8, kneeBend: 35, ankleFlex: 30 },  // Much less extreme
            sideways: { hipFlex: -5, hipSpread: 4, kneeBend: 25, ankleFlex: 25 }
          };
          this.currentLegPose = { ...this.legPoses.rest };
          this.legPoseBlendSpeed = 0.1;
          
          // Finger tracking
          this.targetCurls = {
            left: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
            right: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 }
          };
          this.currentCurls = {
            left: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
            right: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 }
          };
          this.fingerSmoothingFactor = 0.3;
          
          // Breathing
          this.breathingPhase = 0;
          this.breathingRate = 0.25;
          this.breathingAmount = 0.015;
          
          // Remote body pose data
          this.remotePoseData = null;
          
          this.belowGutBoneNames = new Set([
            this.boneNames.leftUpLeg,
            this.boneNames.leftLeg,
            this.boneNames.leftFoot,
            this.boneNames.rightUpLeg,
            this.boneNames.rightLeg,
            this.boneNames.rightFoot
          ]);

          this.loadModel();
        },

        hideBoneVisual: function (bone) {
          if (!bone) return;
          bone.scale.set(0.001, 0.001, 0.001);
          bone.visible = false;
        },

        shouldHideArmBone: function (name) {
          if (!this.data.hideArms) return false;
          const armSet = new Set([
            this.boneNames.leftShoulder,
            this.boneNames.rightShoulder,
            this.boneNames.leftArm,
            this.boneNames.rightArm,
            this.boneNames.leftForeArm,
            this.boneNames.rightForeArm,
            this.boneNames.leftHand,
            this.boneNames.rightHand,
            this.boneNames.leftHandThumb1,
            this.boneNames.leftHandThumb2,
            this.boneNames.leftHandThumb3,
            this.boneNames.leftHandIndex1,
            this.boneNames.leftHandIndex2,
            this.boneNames.leftHandIndex3,
            this.boneNames.leftHandMiddle1,
            this.boneNames.leftHandMiddle2,
            this.boneNames.leftHandMiddle3,
            this.boneNames.leftHandRing1,
            this.boneNames.leftHandRing2,
            this.boneNames.leftHandRing3,
            this.boneNames.leftHandPinky1,
            this.boneNames.leftHandPinky2,
            this.boneNames.leftHandPinky3,
            this.boneNames.rightHandThumb1,
            this.boneNames.rightHandThumb2,
            this.boneNames.rightHandThumb3,
            this.boneNames.rightHandIndex1,
            this.boneNames.rightHandIndex2,
            this.boneNames.rightHandIndex3,
            this.boneNames.rightHandMiddle1,
            this.boneNames.rightHandMiddle2,
            this.boneNames.rightHandMiddle3,
            this.boneNames.rightHandRing1,
            this.boneNames.rightHandRing2,
            this.boneNames.rightHandRing3,
            this.boneNames.rightHandPinky1,
            this.boneNames.rightHandPinky2,
            this.boneNames.rightHandPinky3
          ]);
          return armSet.has(name);
        },

        /** Fade torso/hip skinned vertices (single mesh) — temporary ball visibility aid. */
        applyGhostTorsoMaterial: function (mesh) {
          const ghost = this.data.ghostTorsoOpacity;
          if (!mesh || !mesh.skeleton || !ghost || ghost >= 0.999) return;

          const torsoNames = [
            this.boneNames.hips,
            this.boneNames.spine,
            this.boneNames.spine1,
            this.boneNames.spine2,
            this.boneNames.leftShoulder,
            this.boneNames.rightShoulder
          ];
          const indices = [];
          torsoNames.forEach((name) => {
            const i = mesh.skeleton.bones.findIndex((b) => b.name === name);
            if (i >= 0) indices.push(i);
          });
          if (!indices.length) return;

          const idxArr = new Float32Array(8);
          indices.forEach((i, n) => {
            if (n < 8) idxArr[n] = i;
          });
          const boneCount = indices.length;

          const mat = mesh.material;
          mat.transparent = true;
          mat.depthWrite = false;

          mat.onBeforeCompile = (shader) => {
            shader.uniforms.uGhostTorsoOpacity = { value: ghost };
            shader.uniforms.uTorsoBoneCount = { value: boneCount };
            shader.uniforms.uTorsoBoneIndices = { value: idxArr };

            shader.vertexShader =
              'uniform float uTorsoBoneCount;\n' +
              'uniform float uTorsoBoneIndices[8];\n' +
              'varying float vTorsoMask;\n' +
              shader.vertexShader;

            shader.vertexShader = shader.vertexShader.replace(
              '#include <skinning_vertex>',
              '#include <skinning_vertex>\n' +
                'float torsoMask = 0.0;\n' +
                'for (int ti = 0; ti < 8; ti++) {\n' +
                '  if (float(ti) >= uTorsoBoneCount) break;\n' +
                '  float bIdx = uTorsoBoneIndices[ti];\n' +
                '  for (int j = 0; j < 4; j++) {\n' +
                '    if (abs(skinIndex[j] - bIdx) < 0.5) torsoMask = max(torsoMask, skinWeight[j]);\n' +
                '  }\n' +
                '}\n' +
                'vTorsoMask = torsoMask;\n'
            );

            shader.fragmentShader =
              'uniform float uGhostTorsoOpacity;\n' +
              'varying float vTorsoMask;\n' +
              shader.fragmentShader;

            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <output_fragment>',
              'diffuseColor.a *= mix(1.0, uGhostTorsoOpacity, clamp(vTorsoMask, 0.0, 1.0));\n' +
                '#include <output_fragment>'
            );
          };
          mat.needsUpdate = true;
        },

        loadModel: function() {
          const path = this.data.modelPath || 'character.glb';
          const isGlb = /\.glb$/i.test(path) || /\.gltf$/i.test(path);

          // CapVR pattern: character.glb via GLTFLoader (FBX is optional fallback)
          if (isGlb) {
            const tryGltf = () => {
              const LoaderCtor =
                (window.BodyRiggedLoaders && window.BodyRiggedLoaders.GLTFLoader) ||
                (window.THREE && window.THREE.GLTFLoader) ||
                (window.AFRAME && window.AFRAME.THREE && window.AFRAME.THREE.GLTFLoader);
              if (!LoaderCtor) {
                if (!window.BodyRiggedLoaders || !window.BodyRiggedLoaders.ready) {
                  setTimeout(tryGltf, 50);
                  return;
                }
                console.error('[Body Avatar] No GLTFLoader for', path);
                return;
              }
              new LoaderCtor().load(
                path,
                (gltf) => this.onModelLoaded(gltf.scene || gltf, { isGltf: true }),
                undefined,
                (error) => console.error('[Body Avatar] GLB load error:', error)
              );
            };
            tryGltf();
            return;
          }

          const FBXCtor =
            (window.BodyRiggedLoaders && window.BodyRiggedLoaders.FBXLoader) ||
            (window.THREE && window.THREE.FBXLoader);
          if (!FBXCtor) {
            console.error('[Body Avatar] No FBXLoader for', path);
            return;
          }
          new FBXCtor().load(
            path,
            (fbx) => this.onModelLoaded(fbx, { isGltf: false }),
            undefined,
            (error) => console.error('[Body Avatar] FBX load error:', error)
          );
        },

        onModelLoaded: function(fbx, meta) {
          this.modelLoaded = true;
          this.model = fbx;
          this.isGltf = !!(meta && meta.isGltf);

          // FBX Mixamo is cm-scale; CapVR character.glb is already metres
          if (this.isGltf) {
            fbx.scale.set(1, 1, 1);
            fbx.position.y = 0.05;
          } else {
            fbx.scale.set(0.01, 0.01, 0.01);
          }
          fbx.rotation.y = Math.PI;

          this.el.object3D.add(fbx);

          fbx.traverse((node) => {
            if (node.isSkinnedMesh && node.skeleton) {
              this.skeleton = node.skeleton;
              this.mapBones();
              this.skinnedMesh = node;
              node.material = node.material.clone();
              node.material.color.set(this.data.color);
              this.applyGhostTorsoMaterial(node);
            }
            if (node.isMesh && !node.isSkinnedMesh) {
              node.material = node.material.clone();
              node.material.color.set(this.data.color);
            }
          });

          console.log(
            '[Body Avatar] Loaded for ' +
              this.data.playerId +
              (this.isGltf ? ' (glb)' : ' (fbx)')
          );
        },

        mapBones: function() {
          this.initialBoneRotations = {};
          
          this.skeleton.bones.forEach((bone) => {
            const name = bone.name;
            this.initialBoneRotations[name] = bone.quaternion.clone();
            
            // Map bones EXACTLY like reference project (explicit mappings)
            if (name === this.boneNames.hips) this.bones.hips = bone;
            else if (name === this.boneNames.spine) this.bones.spine = bone;
            else if (name === this.boneNames.spine1) this.bones.spine1 = bone;
            else if (name === this.boneNames.spine2) this.bones.spine2 = bone;
            else if (name === this.boneNames.neck) this.bones.neck = bone;
            else if (name === this.boneNames.head) {
              this.bones.head = bone;
              // Hide head if specified
              if (this.data.hideHead) {
                bone.scale.set(0.001, 0.001, 0.001);
              }
            }
            // Arms (CRITICAL: Use correct property names for IK)
            else if (name === this.boneNames.leftShoulder) this.bones.leftShoulder = bone;
            else if (name === this.boneNames.leftArm) this.bones.leftUpperArm = bone;  // NOTE: leftArm â†’ leftUpperArm
            else if (name === this.boneNames.leftForeArm) this.bones.leftForearm = bone;  // NOTE: leftForeArm â†’ leftForearm
            else if (name === this.boneNames.leftHand) this.bones.leftHandBone = bone;  // NOTE: leftHand â†’ leftHandBone
            else if (name === this.boneNames.rightShoulder) this.bones.rightShoulder = bone;
            else if (name === this.boneNames.rightArm) this.bones.rightUpperArm = bone;  // NOTE: rightArm â†’ rightUpperArm
            else if (name === this.boneNames.rightForeArm) this.bones.rightForearm = bone;  // NOTE: rightForeArm â†’ rightForearm
            else if (name === this.boneNames.rightHand) this.bones.rightHandBone = bone;  // NOTE: rightHand â†’ rightHandBone
            // Legs (optional hide — torso/arms IK unchanged)
            else if (name === this.boneNames.leftUpLeg) {
              this.bones.leftUpLeg = bone;
              if (this.data.hideBelowGut) this.hideBoneVisual(bone);
            } else if (name === this.boneNames.leftLeg) {
              this.bones.leftLeg = bone;
              if (this.data.hideBelowGut) this.hideBoneVisual(bone);
            } else if (name === this.boneNames.leftFoot) {
              this.bones.leftFoot = bone;
              if (this.data.hideBelowGut) this.hideBoneVisual(bone);
            } else if (name === this.boneNames.rightUpLeg) {
              this.bones.rightUpLeg = bone;
              if (this.data.hideBelowGut) this.hideBoneVisual(bone);
            } else if (name === this.boneNames.rightLeg) {
              this.bones.rightLeg = bone;
              if (this.data.hideBelowGut) this.hideBoneVisual(bone);
            } else if (name === this.boneNames.rightFoot) {
              this.bones.rightFoot = bone;
              if (this.data.hideBelowGut) this.hideBoneVisual(bone);
            }
            // Fingers (keep short form for reference bone names)
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

            if (this.shouldHideArmBone(name)) this.hideBoneVisual(bone);
          });
          this.setupPalmDebugMeshes();
        },

        getKnuckleCenter: function (side, out) {
          const knuckles =
            side === 'left'
              ? [
                  this.bones.leftHandIndex1,
                  this.bones.leftHandMiddle1,
                  this.bones.leftHandRing1
                ]
              : [
                  this.bones.rightHandIndex1,
                  this.bones.rightHandMiddle1,
                  this.bones.rightHandRing1
                ];
          out.set(0, 0, 0);
          let n = 0;
          knuckles.forEach((bone) => {
            if (!bone) return;
            bone.updateMatrixWorld(true);
            const p = new THREE.Vector3();
            bone.getWorldPosition(p);
            out.add(p);
            n++;
          });
          if (!n) return false;
          out.divideScalar(n);
          return true;
        },

        getPalmWorldCenter: function (side, out) {
          const handBone =
            side === 'left' ? this.bones.leftHandBone : this.bones.rightHandBone;
          const midBone =
            side === 'left' ? this.bones.leftHandMiddle1 : this.bones.rightHandMiddle1;
          if (!handBone || !midBone) return false;
          handBone.updateMatrixWorld(true);
          const wrist = new THREE.Vector3();
          handBone.getWorldPosition(wrist);
          const palmCenter = new THREE.Vector3();
          if (!this.getKnuckleCenter(side, palmCenter)) {
            midBone.updateMatrixWorld(true);
            midBone.getWorldPosition(palmCenter);
          }
          const fingerForward = palmCenter.clone().sub(wrist);
          if (fingerForward.lengthSq() < 1e-8) return false;
          fingerForward.normalize();
          const cfg = window.VRDRIFT || {};
          const along =
            cfg.PALM_BONE_CENTER_ALONG_FINGERS != null
              ? cfg.PALM_BONE_CENTER_ALONG_FINGERS
              : 0.02;
          out.copy(palmCenter).add(fingerForward.multiplyScalar(along));
          return true;
        },

        /**
         * Knuckle center (world) + mirrored bone-local palm tilt (IK wrist rotation).
         */
        getPalmBoneLocalMatrix: function (side, outMatrix) {
          const handBone =
            side === 'left' ? this.bones.leftHandBone : this.bones.rightHandBone;
          if (!handBone || !window.VRDriftPalmFrame) return false;

          const center = new THREE.Vector3();
          if (!this.getPalmWorldCenter(side, center)) return false;

          handBone.updateMatrixWorld(true);
          const boneQuat = new THREE.Quaternion();
          handBone.getWorldQuaternion(boneQuat);
          const palmQuat = window.VRDriftPalmFrame.composeSymmetricPalmLocalQuat(side);
          const worldQuat = boneQuat.clone().multiply(palmQuat);

          const worldM = new THREE.Matrix4().compose(
            center,
            worldQuat,
            new THREE.Vector3(1, 1, 1)
          );
          const inv = handBone.matrixWorld.clone().invert();
          outMatrix.multiplyMatrices(inv, worldM);
          return true;
        },

        syncPalmDebugTransforms: function () {
          if (!window.VRDriftPalmFrame) return;
          const center = new THREE.Vector3();
          const centerLocal = new THREE.Vector3();
          ['left', 'right'].forEach((side) => {
            const mesh = this._palmDebug[side];
            const handBone =
              side === 'left' ? this.bones.leftHandBone : this.bones.rightHandBone;
            if (!mesh || !handBone || !this.getPalmWorldCenter(side, center)) return;
            handBone.updateMatrixWorld(true);
            handBone.worldToLocal(centerLocal.copy(center));
            mesh.position.copy(centerLocal);
            mesh.quaternion.copy(
              window.VRDriftPalmFrame.composeSymmetricPalmLocalQuat(side)
            );
          });
        },

        setupPalmDebugMeshes: function () {
          if (!window.VRDriftPalmFrame) return;
          const show = (window.VRDRIFT || {}).SHOW_HAND_COLLISION_DEBUG === true;
          const ext = window.VRDriftPalmFrame.palmHalfExtents();
          ['left', 'right'].forEach((side) => {
            if (this._palmDebug[side]) return;
            const bone =
              side === 'left' ? this.bones.leftHandBone : this.bones.rightHandBone;
            if (!bone) return;
            const geom = new THREE.BoxGeometry(ext.hx * 2, ext.hy * 2, ext.hz * 2);
            const mat = new THREE.MeshBasicMaterial({
              wireframe: true,
              color: 0x88ddff,
              transparent: true,
              opacity: 0.85,
              depthTest: false
            });
            const mesh = new THREE.Mesh(geom, mat);
            mesh.name = 'palm-debug-' + side;
            const modelScale =
              this.model && this.model.scale ? this.model.scale.x : 0.01;
            const inv = modelScale > 0 ? 1 / modelScale : 100;
            mesh.scale.set(inv, inv, inv);
            bone.add(mesh);
            mesh.visible = show;
            mesh.renderOrder = 999;
            this._palmDebug[side] = mesh;
          });
          this.syncPalmDebugTransforms();
        },

        getPalmWorldPose: function (side, outPos, outQuat) {
          const bone =
            side === 'left' ? this.bones.leftHandBone : this.bones.rightHandBone;
          if (!bone) return false;
          bone.updateMatrixWorld(true);
          const localM = new THREE.Matrix4();
          if (!this.getPalmBoneLocalMatrix(side, localM)) return false;
          const worldM = new THREE.Matrix4().multiplyMatrices(bone.matrixWorld, localM);
          const scale = new THREE.Vector3();
          worldM.decompose(outPos, outQuat, scale);
          return true;
        },

        setPalmDebugVisible: function (show) {
          Object.keys(this._palmDebug || {}).forEach((side) => {
            const mesh = this._palmDebug[side];
            if (mesh) mesh.visible = !!show;
          });
        },

        setPalmDebugActive: function (side, active) {
          const mesh = this._palmDebug && this._palmDebug[side];
          if (!mesh || !mesh.material) return;
          mesh.material.color.setHex(active ? 0xffee88 : 0x88ddff);
          mesh.material.opacity = active ? 0.9 : 0.85;
        },

        tickOrder: 2,

        tick: function(time, deltaTime) {
          if (!this.modelLoaded || !this.skeleton) return;
          
          const dt = Math.min(deltaTime / 1000, 0.1);
          
          // Update breathing
          this.breathingPhase += dt * this.breathingRate * Math.PI * 2;
          if (this.breathingPhase > Math.PI * 2) {
            this.breathingPhase -= Math.PI * 2;
          }
          
          if (this.data.isRemote) {
            this.updateRemoteBody(dt);
          } else if (this.data.isBot) {
            this.updateBotBody(dt);
          } else {
            // Local player body
            this.updateLocalBody(dt);
          }
          
          // Only update fingers for local player (not remote/bots)
          if (!this.data.isRemote && !this.data.isBot) {
            this.updateFingerPoses();
          }
        },

        updateLocalBody: function(dt) {
          // Get references if not set (use EXACT selectors from reference)
          if (!this.camera) {
            this.camera = document.querySelector('#camera');
            this.leftController = document.querySelector('#leftHand');
            this.rightController = document.querySelector('#rightHand');
            this.rig = document.querySelector('#rig');
          }
          
          if (!this.camera || !this.leftController || !this.rightController) {
            return;
          }
          
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
          
          // Calculate velocity
          if (this.previousHeadPosInitialized) {
            const newVelocity = headWorldPos.clone().sub(this.previousHeadPos).divideScalar(dt);
            this.headAcceleration.copy(newVelocity).sub(this.previousHeadVelocity).divideScalar(dt);
            this.headVelocity.copy(newVelocity);
            this.previousHeadVelocity.copy(newVelocity);
          } else {
            this.previousHeadPosInitialized = true;
          }
          this.previousHeadPos.copy(headWorldPos);
          
          this.calculateTorsoOrientation(headWorldPos, headWorldQuat, leftHandWorldPos, rightHandWorldPos, dt);
          this.calculateBodyTilt(headWorldPos, leftHandWorldPos, rightHandWorldPos, dt);
          
          // Position body
          const desiredHipsY = headWorldPos.y - 0.65;
          const modelHipsLocalY = 1.0;
          const bodyY = desiredHipsY - modelHipsLocalY;
          
          const backwardOffset = new THREE.Vector3(0, 0, 0.15);
          backwardOffset.applyQuaternion(this.torsoRotation);
          const bodyX = headWorldPos.x + backwardOffset.x;
          const bodyZ = headWorldPos.z + backwardOffset.z;
          this.el.object3D.position.set(bodyX, bodyY, bodyZ);
          
          const combinedRotation = new THREE.Quaternion()
            .copy(this.torsoRotation)
            .multiply(this.bodyTilt);
          this.el.object3D.quaternion.copy(combinedRotation);
          
          // Update bones
          this.updateBones(headWorldPos, headWorldQuat, leftHandWorldPos, rightHandWorldPos,
                          leftHandWorldQuat, rightHandWorldQuat, dt);
          this.syncPalmDebugTransforms();
        },

        updateRemoteBody: function(dt) {
          // Wait for networked bodyPose — no-op while hidden / not joined yet
          if (!this.remotePoseData) {
            if (!this.el.object3D || !this.el.object3D.visible) return;
            // VRdrift2 pose anchors are #remote-N (not CapVR #remote-player-N)
            const m = String(this.data.playerId || '').match(/(\d+)$/);
            const slot = m ? m[1] : null;
            const remotePlayerEntity = slot != null
              ? document.querySelector('#remote-' + slot) ||
                document.querySelector('#remote-player-' + slot)
              : null;
            if (!remotePlayerEntity || !remotePlayerEntity.object3D) return;

            const remoteWorldPos = new THREE.Vector3();
            remotePlayerEntity.object3D.getWorldPosition(remoteWorldPos);
            this.el.object3D.position.copy(remoteWorldPos);
            const idleHeadPos = remoteWorldPos.clone();
            idleHeadPos.y += 0.2;
            const idleHeadQuat = new THREE.Quaternion();
            const idleLeftHand = remoteWorldPos.clone();
            idleLeftHand.x -= 0.3;
            const idleRightHand = remoteWorldPos.clone();
            idleRightHand.x += 0.3;
            this.headVelocity.set(0, 0, 0);
            this.updateBones(
              idleHeadPos,
              idleHeadQuat,
              idleLeftHand,
              idleRightHand,
              idleHeadQuat,
              idleHeadQuat,
              dt
            );
            return;
          }

          const data = this.remotePoseData;
          this.el.object3D.position.set(data.bodyX, data.bodyY, data.bodyZ);
          this.el.object3D.quaternion.set(data.bodyQX, data.bodyQY, data.bodyQZ, data.bodyQW);
          this.torsoRotation.copy(this.el.object3D.quaternion);

          const headWorldPos = new THREE.Vector3(data.headX, data.headY, data.headZ);
          const headWorldQuat = new THREE.Quaternion(data.headQX, data.headQY, data.headQZ, data.headQW);
          const leftHandWorldPos = new THREE.Vector3(data.lhX, data.lhY, data.lhZ);
          const leftHandWorldQuat = new THREE.Quaternion(data.lhQX, data.lhQY, data.lhQZ, data.lhQW);
          const rightHandWorldPos = new THREE.Vector3(data.rhX, data.rhY, data.rhZ);
          const rightHandWorldQuat = new THREE.Quaternion(data.rhQX, data.rhQY, data.rhQZ, data.rhQW);

          this.headVelocity.set(data.velX || 0, data.velY || 0, data.velZ || 0);
          this.updateBones(
            headWorldPos,
            headWorldQuat,
            leftHandWorldPos,
            rightHandWorldPos,
            leftHandWorldQuat,
            rightHandWorldQuat,
            dt
          );

          if (data.fingerCurls) {
            this.currentCurls = data.fingerCurls;
            this.applyFingerCurls('left', this.currentCurls.left);
            this.applyFingerCurls('right', this.currentCurls.right);
          }
        },

        updateBotBody: function(dt) {
          // Clamp dt to prevent extreme values causing oscillations
          dt = Math.min(dt, 0.05); // Cap at 50ms (20 FPS minimum)
          
          // Bot bodies follow their physics body
          // Since body is now at root level, query the bot entity by ID
          let botEntity;
          if (this.data.playerId === 'bot_red') {
            botEntity = document.querySelector('#zerog-bot-red');
          } else if (this.data.playerId === 'bot_blue') {
            botEntity = document.querySelector('#zerog-bot-blue');
          } else if (this.data.playerId === 'bot_green') {
            botEntity = document.querySelector('#zerog-bot-green');
          }
          
          if (!botEntity) {
            if (!this.botErrorLogged) {
              console.error(`[Body Avatar] âŒ BOT ENTITY NOT FOUND for ${this.data.playerId}`);
              this.botErrorLogged = true;
            }
            return;
          }
          
          // Get the bot's target sphere for positioning
          const botTarget = botEntity.querySelector('a-sphere[id*="bot"]');
          if (!botTarget) {
            if (!this.botTargetErrorLogged) {
              console.error(`[Body Avatar] âŒ BOT TARGET NOT FOUND for ${this.data.playerId}`);
              this.botTargetErrorLogged = true;
            }
            return;
          }
          
          const botWorldPos = new THREE.Vector3();
          botTarget.object3D.getWorldPosition(botWorldPos);
          
          // Calculate bot velocity from position changes with smoothing
          if (!this.previousBotPos) {
            this.previousBotPos = botWorldPos.clone();
            this.headVelocity.set(0, 0, 0);
            this.smoothedBotVelocity = new THREE.Vector3(0, 0, 0);
          } else {
            // Calculate instantaneous velocity
            const newVelocity = botWorldPos.clone().sub(this.previousBotPos).divideScalar(dt);
            
            // Smooth velocity to reduce oscillations (exponential moving average)
            if (!this.smoothedBotVelocity) {
              this.smoothedBotVelocity = newVelocity.clone();
            } else {
              const smoothingFactor = 0.3; // Lower = smoother but more lag
              this.smoothedBotVelocity.lerp(newVelocity, smoothingFactor);
            }
            
            // Scale down velocity for leg animation (bots should have more subtle leg movements in zero-G)
            this.headVelocity.copy(this.smoothedBotVelocity).multiplyScalar(0.5);
            this.previousBotPos.copy(botWorldPos);
          }
          
          // Position body at bot position (align body center with bot center, which is at chest level)
          this.el.object3D.position.copy(botWorldPos);
          // Bot target sphere is at chest/torso height
          // The Mixamo model's hips are at Y=1.0 in local space, so we need to offset down
          // to place the chest/torso at the bot's position
          this.el.object3D.position.y -= 1.0; // Offset down to place chest at bot position
          
          // Use the bot entity's rotation (from AI system) but correct for coordinate system mismatch
          // Bot faces +Z, but Mixamo body model faces -Z, so we need to rotate 180 degrees around Y
          const botRotation = botEntity.object3D.quaternion.clone();
          
          // Extract only the Y-axis rotation (yaw) to keep body upright
          // Convert quaternion to euler angles
          const euler = new THREE.Euler();
          euler.setFromQuaternion(botRotation, 'YXZ');
          
          // Keep only the Y rotation (yaw), zero out pitch and roll to keep upright
          euler.x = 0; // No pitch
          euler.z = 0; // No roll
          
          // Convert back to quaternion with only Y rotation
          const uprightRotation = new THREE.Quaternion();
          uprightRotation.setFromEuler(euler);
          
          // Apply the 180-degree correction for Mixamo coordinate system
          const correction = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
          const targetRotation = new THREE.Quaternion().multiplyQuaternions(uprightRotation, correction);
          
          // Smoothly interpolate rotation to avoid jerky movements during turns
          if (!this.previousBotRotation) {
            this.previousBotRotation = targetRotation.clone();
            this.el.object3D.quaternion.copy(targetRotation);
          } else {
            this.el.object3D.quaternion.slerp(targetRotation, 0.2); // Smooth rotation interpolation
            this.previousBotRotation.copy(this.el.object3D.quaternion);
          }
          
          // CRITICAL: Set torsoRotation to match bot's facing direction for correct leg animation
          // The leg animation system uses torsoRotation to convert world velocity to local space
          this.torsoRotation.copy(this.el.object3D.quaternion);
          
          // Simple bot head and hand positioning (like before enhancements)
          const botHeadPos = botWorldPos.clone();
          botHeadPos.y += 0.2; // Head offset
          
          const botHeadQuat = this.el.object3D.quaternion.clone();
          
          // Calculate body forward direction for hand positioning
          const bodyRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.el.object3D.quaternion);
          const bodyForward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.el.object3D.quaternion);
          
          // Calculate thrust direction
          const thrustDirection = new THREE.Vector3();
          const hasVelocity = this.headVelocity.length() > 0.1;
          if (hasVelocity) {
            thrustDirection.copy(this.headVelocity).normalize();
          } else {
            // Default thrust direction when stationary: forward
            thrustDirection.copy(bodyForward);
          }
          
          // Check if bot is holding the capture ball
          const botComponent = botEntity.components['zerog-bot'];
          const isHoldingBall = botComponent && botComponent.isGrabbingBall;
          const thrusterLeft = botComponent && botComponent.thrusterActive.left;
          const thrusterRight = botComponent && botComponent.thrusterActive.right;
          
          // Initialize target hand positions if not exist (for smooth transitions)
          if (!this.botHandTargets) {
            this.botHandTargets = {
              left: new THREE.Vector3(),
              right: new THREE.Vector3()
            };
            this.botHandCurrent = {
              left: new THREE.Vector3(),
              right: new THREE.Vector3()
            };
          }
          
          // Position hands relative to body rotation
          
          if (hasVelocity && (thrusterLeft || thrusterRight)) {
            // LEFT HAND
            if (thrusterLeft) {
              // Position hand extended in the thrust direction
              // Start from body center
              this.botHandTargets.left.copy(botWorldPos);
              
              // ALWAYS add forward offset to prevent hands going behind/through body
              const minForwardOffset = bodyForward.clone().multiplyScalar(0.2); // 20cm forward minimum
              this.botHandTargets.left.add(minForwardOffset);
              
              // Add thrust direction component (scaled based on direction)
              const thrustComponent = thrustDirection.clone();
              
              // If moving forward, add MORE forward reach (total ~1.0m forward)
              const forwardAmount = Math.max(0, -thrustComponent.dot(bodyForward));
              const upAmount = thrustComponent.y; // Positive when moving up, negative when moving down
              
              if (forwardAmount > 0.5) {
                // Moving mostly forward - extend hand much more forward
                thrustComponent.multiplyScalar(0.8);
              } else {
                // Other directions - extend but keep forward bias
                thrustComponent.multiplyScalar(0.6);
              }
              
              this.botHandTargets.left.add(thrustComponent);
              
              // ADAPTIVE HAND SPACING: Adjust lateral offset based on movement direction
              let lateralOffset = -0.15; // Base left offset
              
              if (upAmount < -0.3) {
                // Moving DOWN - spread hands wider to avoid body clipping
                lateralOffset = -0.35;
              } else if (forwardAmount > 0.5 || upAmount > 0.5) {
                // Moving FORWARD or UP - hands can be closer together
                lateralOffset = -0.1;
              }
              
              this.botHandTargets.left.add(bodyRight.clone().multiplyScalar(lateralOffset));
            } else {
              // Default position: slightly forward and to the left
              this.botHandTargets.left.copy(botWorldPos);
              this.botHandTargets.left.add(bodyRight.clone().multiplyScalar(-0.25));
              this.botHandTargets.left.add(bodyForward.clone().multiplyScalar(0.2));
            }
            
            // RIGHT HAND
            if (isHoldingBall) {
              // When holding the ball, position right hand at the ball's center
              const captureBall = document.querySelector('#capture-ball');
              if (captureBall) {
                captureBall.object3D.getWorldPosition(this.botHandTargets.right);
              } else {
                this.botHandTargets.right.copy(botWorldPos);
                this.botHandTargets.right.add(bodyRight.clone().multiplyScalar(0.25));
                this.botHandTargets.right.add(bodyForward.clone().multiplyScalar(0.2));
              }
            } else if (thrusterRight) {
              // Position hand extended in the thrust direction
              // Start from body center
              this.botHandTargets.right.copy(botWorldPos);
              
              // ALWAYS add forward offset to prevent hands going behind/through body
              const minForwardOffset = bodyForward.clone().multiplyScalar(0.2); // 20cm forward minimum
              this.botHandTargets.right.add(minForwardOffset);
              
              // Add thrust direction component (scaled based on direction)
              const thrustComponent = thrustDirection.clone();
              
              // If moving forward, add MORE forward reach (total ~1.0m forward)
              const forwardAmount = Math.max(0, -thrustComponent.dot(bodyForward));
              const upAmount = thrustComponent.y; // Positive when moving up, negative when moving down
              
              if (forwardAmount > 0.5) {
                // Moving mostly forward - extend hand much more forward
                thrustComponent.multiplyScalar(0.8);
              } else {
                // Other directions - extend but keep forward bias
                thrustComponent.multiplyScalar(0.6);
              }
              
              this.botHandTargets.right.add(thrustComponent);
              
              // ADAPTIVE HAND SPACING: Adjust lateral offset based on movement direction
              let lateralOffset = 0.15; // Base right offset
              
              if (upAmount < -0.3) {
                // Moving DOWN - spread hands wider to avoid body clipping
                lateralOffset = 0.35;
              } else if (forwardAmount > 0.5 || upAmount > 0.5) {
                // Moving FORWARD or UP - hands can be closer together
                lateralOffset = 0.1;
              }
              
              this.botHandTargets.right.add(bodyRight.clone().multiplyScalar(lateralOffset));
            } else {
              this.botHandTargets.right.copy(botWorldPos);
              this.botHandTargets.right.add(bodyRight.clone().multiplyScalar(0.25));
              this.botHandTargets.right.add(bodyForward.clone().multiplyScalar(0.2));
            }
          } else {
            // No velocity or no thrusters - default positions
            this.botHandTargets.left.copy(botWorldPos);
            this.botHandTargets.left.add(bodyRight.clone().multiplyScalar(-0.25));
            this.botHandTargets.left.add(bodyForward.clone().multiplyScalar(0.2));
            
            if (!isHoldingBall) {
              this.botHandTargets.right.copy(botWorldPos);
              this.botHandTargets.right.add(bodyRight.clone().multiplyScalar(0.25));
              this.botHandTargets.right.add(bodyForward.clone().multiplyScalar(0.2));
            } else {
              const captureBall = document.querySelector('#capture-ball');
              if (captureBall) {
                captureBall.object3D.getWorldPosition(this.botHandTargets.right);
              }
            }
          }
          
          // Smooth interpolation of hand positions (0.15 = smooth transitions)
          const handSmoothingFactor = 0.15;
          this.botHandCurrent.left.lerp(this.botHandTargets.left, handSmoothingFactor);
          this.botHandCurrent.right.lerp(this.botHandTargets.right, handSmoothingFactor);
          
          // Use smoothed positions for final hand placement
          const botLeftHand = this.botHandCurrent.left.clone();
          const botRightHand = this.botHandCurrent.right.clone();
          
          // Calculate hand quaternions based on thruster state and direction
          // Initialize target quaternions if not exist
          if (!this.botHandQuatTargets) {
            this.botHandQuatTargets = {
              left: this.el.object3D.quaternion.clone(),
              right: this.el.object3D.quaternion.clone()
            };
            this.botHandQuatCurrent = {
              left: this.el.object3D.quaternion.clone(),
              right: this.el.object3D.quaternion.clone()
            };
          }
          
          // Default quaternion (matches body rotation)
          const defaultQuat = this.el.object3D.quaternion.clone();
          
          // Calculate hand rotation based on actual thrust direction
          // Apply a forward-pointing rotation like VR controllers
          const forwardHandRotation = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(1, 0, 0), // X-axis
            Math.PI / 2 // +90 degrees = hand points forward (not backward!)
          );
          
          // Calculate hand roll (rotation around forward axis) based on thrust direction
          let leftHandRoll = 0;
          let rightHandRoll = 0;
          
          if (hasVelocity && (thrusterLeft || thrusterRight)) {
            // Calculate roll based on sideways and vertical movement
            const invBodyQuat = this.el.object3D.quaternion.clone().invert();
            const localThrustDir = thrustDirection.clone().applyQuaternion(invBodyQuat);
            
            // Roll hands inward slightly when moving sideways (more natural wrist angle)
            const sidewaysAmount = localThrustDir.x; // Positive = right, negative = left
            const upAmount = localThrustDir.y; // Positive = up, negative = down
            
            // Left hand rolls
            if (thrusterLeft) {
              leftHandRoll = sidewaysAmount * 0.3; // Roll with sideways movement
              if (upAmount < -0.3) {
                // Rolling down - rotate hands outward
                leftHandRoll += 0.4;
              } else if (upAmount > 0.3) {
                // Rolling up - rotate hands inward slightly
                leftHandRoll -= 0.2;
              }
            }
            
            // Right hand rolls (mirrored)
            if (thrusterRight && !isHoldingBall) {
              rightHandRoll = -sidewaysAmount * 0.3; // Roll with sideways movement (opposite)
              if (upAmount < -0.3) {
                // Rolling down - rotate hands outward
                rightHandRoll -= 0.4;
              } else if (upAmount > 0.3) {
                // Rolling up - rotate hands inward slightly
                rightHandRoll += 0.2;
              }
            }
          }
          
          // Apply forward rotation + roll
          const leftRollQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), leftHandRoll);
          const rightRollQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rightHandRoll);
          
          if (hasVelocity && (thrusterLeft || thrusterRight)) {
            // When thrusters active, hands point forward (palm facing movement direction) + roll
            this.botHandQuatTargets.left.copy(defaultQuat).multiply(forwardHandRotation).multiply(leftRollQuat);
            this.botHandQuatTargets.right.copy(defaultQuat).multiply(forwardHandRotation).multiply(rightRollQuat);
          } else {
            // No velocity - also point forward
            this.botHandQuatTargets.left.copy(defaultQuat).multiply(forwardHandRotation);
            this.botHandQuatTargets.right.copy(defaultQuat).multiply(forwardHandRotation);
          }
          
          // Smooth interpolation of hand rotations
          this.botHandQuatCurrent.left.slerp(this.botHandQuatTargets.left, handSmoothingFactor);
          this.botHandQuatCurrent.right.slerp(this.botHandQuatTargets.right, handSmoothingFactor);
          
          this.updateBones(botHeadPos, botHeadQuat, botLeftHand, botRightHand,
                          this.botHandQuatCurrent.left, this.botHandQuatCurrent.right, dt);
          
          // BOT FINGER ANIMATION: Curl fingers naturally like human players
          // Set target curls based on thruster state and ball holding
          const leftTargetCurls = {
            thumb: 0.3,    // Slightly curved
            index: 0.5,    // More curved
            middle: 0.5,
            ring: 0.6,     // Most curved
            pinky: 0.6
          };
          
          const rightTargetCurls = {
            thumb: isHoldingBall ? 0.8 : 0.3,   // Grip ball or slightly curved
            index: isHoldingBall ? 0.9 : 0.5,   // Grip ball or more curved
            middle: isHoldingBall ? 0.9 : 0.5,
            ring: isHoldingBall ? 0.8 : 0.6,
            pinky: isHoldingBall ? 0.8 : 0.6
          };
          
          // Smoothly animate finger curls
          this.animateBotFingerCurls('left', leftTargetCurls, dt);
          this.animateBotFingerCurls('right', rightTargetCurls, dt);
        },
        
        animateBotFingerCurls: function(hand, targetCurls, dt) {
          // Initialize current curls if needed
          if (!this.botCurrentCurls) {
            this.botCurrentCurls = {
              left: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
              right: { thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 }
            };
          }
          
          const currentCurls = this.botCurrentCurls[hand];
          const blendSpeed = 5.0 * dt; // Smooth transition
          
          // Blend current curls toward targets
          for (const finger in targetCurls) {
            currentCurls[finger] = THREE.MathUtils.lerp(
              currentCurls[finger],
              targetCurls[finger],
              blendSpeed
            );
          }
          
          // Apply curls to finger bones
          const fingerMap = {
            thumb: ['Thumb1', 'Thumb2', 'Thumb3'],
            index: ['Index1', 'Index2', 'Index3'],
            middle: ['Middle1', 'Middle2', 'Middle3'],
            ring: ['Ring1', 'Ring2', 'Ring3'],
            pinky: ['Pinky1', 'Pinky2', 'Pinky3']
          };
          
          for (const finger in fingerMap) {
            const curl = currentCurls[finger];
            const segments = fingerMap[finger];
            
            segments.forEach((segment, i) => {
              const boneName = `${hand}Hand${segment}`;
              const bone = this.bones[boneName];
              if (bone) {
                // Thumb needs special handling - much less curl, different progression
                if (finger === 'thumb') {
                  // Thumb: Very light curl, tip bends inward slightly
                  // Segments: 0% (base doesn't curl), 10% (middle barely), 50% (tip curls inward)
                  const thumbSegmentCurls = [0.0, 0.2, 0.5]; // Progressive from base to tip
                  const segmentCurl = curl * thumbSegmentCurls[i];
                  
                  const curlAngle = segmentCurl * Math.PI * 0.3; // Max 54 degrees (much less than other fingers)
                  const curlQuat = new THREE.Quaternion().setFromAxisAngle(
                    new THREE.Vector3(1, 0, 0),
                    curlAngle // POSITIVE for both hands - inward curl
                  );
                  
                  if (this.initialBoneRotations[bone.name]) {
                    bone.quaternion.copy(this.initialBoneRotations[bone.name]).multiply(curlQuat);
                  }
                } else {
                  // Other fingers: Normal curl, same for both hands
                  const segmentCurl = curl * (0.4 + i * 0.3); // 40%, 70%, 100% of target curl
                  
                  const curlAngle = segmentCurl * Math.PI * 0.5; // Max 90 degrees
                  const curlQuat = new THREE.Quaternion().setFromAxisAngle(
                    new THREE.Vector3(1, 0, 0),
                    curlAngle // POSITIVE for both hands
                  );
                  
                  if (this.initialBoneRotations[bone.name]) {
                    bone.quaternion.copy(this.initialBoneRotations[bone.name]).multiply(curlQuat);
                  }
                }
              }
            });
          }
        },

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
          
          const currentBodyForward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.torsoRotation);
          currentBodyForward.y = 0;
          currentBodyForward.normalize();
          
          const controllerDot = controllerForward.dot(currentBodyForward);
          if (controllerDot < 0) {
            controllerForward.negate();
          }
          
          // CRITICAL FIX: Constrain torso to not face backwards relative to head
          // Check if controller direction would make body face backwards
          const controllerVsHead = controllerForward.dot(headForwardFlat);
          if (controllerVsHead < -0.3) { // If controller points > 107Â° away from head
            // Body can't physically face backwards - clamp controller influence
            // Project controller forward onto the valid hemisphere around head direction
            const perpToHead = new THREE.Vector3().crossVectors(headForwardFlat, new THREE.Vector3(0, 1, 0));
            const projOnPerp = perpToHead.multiplyScalar(controllerForward.dot(perpToHead));
            controllerForward.copy(headForwardFlat).multiplyScalar(0.3).add(projOnPerp).normalize();
          }
          
          let controllerWeight = 0.8;
          if (shoulderDist < 0.25) {
            controllerWeight = 0.2;
          } else if (shoulderDist > 0.35) {
            controllerWeight = 0.9;
          }
          
          const blendedForward = new THREE.Vector3()
            .addScaledVector(controllerForward, controllerWeight)
            .addScaledVector(headForwardFlat, 1.0 - controllerWeight)
            .normalize();
          
          const targetRotation = new THREE.Quaternion().setFromUnitVectors(
            new THREE.Vector3(0, 0, -1),
            blendedForward
          );
          
          this.torsoRotation.slerp(targetRotation, this.smoothingFactor * 0.7);
        },

        calculateBodyTilt: function(headPos, leftHandPos, rightHandPos, dt) {
          this.bodyTilt.identity();
        },

        updateBones: function(headPos, headQuat, leftHandPos, rightHandPos, leftHandQuat, rightHandQuat, dt) {
          // Reset bones
          if (this.bones.hips) this.bones.hips.quaternion.identity();
          if (this.bones.spine) this.bones.spine.quaternion.identity();
          if (this.bones.spine1) this.bones.spine1.quaternion.identity();
          if (this.bones.spine2) this.bones.spine2.quaternion.identity();
          
          // Spine bending
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
          
          const localVelocity = this.headVelocity.clone();
          localVelocity.applyQuaternion(invTorsoRot);
          
          const targetLean = new THREE.Vector3(
            localVelocity.z * 0.6,
            0,
            -localVelocity.x * 0.5
          );
          
          targetLean.x = Math.max(-0.35, Math.min(0.35, targetLean.x));
          targetLean.z = Math.max(-0.3, Math.min(0.3, targetLean.z));
          
          this.torsoLean.x = THREE.MathUtils.lerp(this.torsoLean.x, targetLean.x, this.torsoLeanVelocity);
          this.torsoLean.y = THREE.MathUtils.lerp(this.torsoLean.y, targetLean.y, this.torsoLeanVelocity);
          this.torsoLean.z = THREE.MathUtils.lerp(this.torsoLean.z, targetLean.z, this.torsoLeanVelocity);
          
          const totalForwardLean = handForwardLean + this.torsoLean.x;
          const totalSideLean = handSideLean + this.torsoLean.z;
          
          const breathingExpansion = Math.sin(this.breathingPhase) * this.breathingAmount;
          
          if (this.bones.spine || this.bones.spine1 || this.bones.spine2) {
            // Bot spine twist (enhancement #5) - upper body leads turns
            const spineTwistAmount = this.data.isBot && this.botAnimState ? this.botAnimState.spineFlexAmount : 0;
            
            const spineRotations = [
              { bone: this.bones.hips, amount: 1.5, breathingAmount: 0.0, twistAmount: 0.0 },
              { bone: this.bones.spine, amount: -1.0, breathingAmount: 0.3, twistAmount: 0.3 },
              { bone: this.bones.spine1, amount: -0.3, breathingAmount: 0.4, twistAmount: 0.5 },
              { bone: this.bones.spine2, amount: -0.2, breathingAmount: 0.3, twistAmount: 0.7 }
            ];
            
            spineRotations.forEach(({ bone, amount, breathingAmount, twistAmount }) => {
              if (bone) {
                const breathingLean = -breathingExpansion * breathingAmount;
                const spineTwist = spineTwistAmount * twistAmount; // Upper spine twists more
                
                const euler = new THREE.Euler(
                  -totalForwardLean * amount + breathingLean,
                  spineTwist, // Y-axis twist for turning
                  -totalSideLean * amount,
                  'YXZ'
                );
                bone.quaternion.setFromEuler(euler);
              }
            });
          }
          
          // Head
          if (this.bones.neck) {
            const relativeHeadQuat = headQuat.clone();
            const invBodyQuat = this.torsoRotation.clone().invert();
            relativeHeadQuat.premultiply(invBodyQuat);
            
            const euler = new THREE.Euler().setFromQuaternion(relativeHeadQuat, 'YXZ');
            euler.x = -euler.x;
            euler.z = -euler.z;
            
            const correctedQuat = new THREE.Quaternion().setFromEuler(euler);
            this.bones.neck.quaternion.copy(correctedQuat);
          }
          
          // Arms
          this.solveArmIK('left', leftHandPos, leftHandQuat);
          this.solveArmIK('right', rightHandPos, rightHandQuat);
          
          // Legs
          this.updateZeroGLegs(headPos, leftHandPos, rightHandPos, dt);
        },

        updateZeroGLegs: function(headPos, leftHandPos, rightHandPos, dt) {
          if (this.data.hideBelowGut) return;

          const invTorsoRot = this.torsoRotation.clone().invert();
          const localVel = this.headVelocity.clone().applyQuaternion(invTorsoRot);
          
          const speed = localVel.length();
          const targetPose = { ...this.legPoses.rest };
          
          if (speed > 0.1) {
            const velNorm = localVel.clone().normalize();
            
            const forwardAmount = Math.max(0, -velNorm.z);
            const backwardAmount = Math.max(0, velNorm.z);
            const upAmount = Math.max(0, velNorm.y);
            const downAmount = Math.max(0, -velNorm.y);
            const sidewaysAmount = Math.abs(velNorm.x);
            
            const directions = [
              { name: 'forward', amount: forwardAmount },
              { name: 'backward', amount: backwardAmount },
              { name: 'up', amount: upAmount },
              { name: 'down', amount: downAmount },
              { name: 'sideways', amount: sidewaysAmount }
            ];
            const strongest = directions.reduce((max, d) => d.amount > max.amount ? d : max);
            
            const threshold = (this.currentDominantDirection === strongest.name) 
              ? this.directionMaintainThreshold
              : this.directionSwitchThreshold;
            
            if (strongest.amount > threshold || speed < 0.2) {
              this.currentDominantDirection = strongest.name;
            }
            if (speed < 0.2) {
              this.currentDominantDirection = 'rest';
            }
            
            const poseWeights = [
              { pose: this.legPoses.forward, weight: forwardAmount * (this.currentDominantDirection === 'forward' ? 1.3 : 1.0) },
              { pose: this.legPoses.backward, weight: backwardAmount * (this.currentDominantDirection === 'backward' ? 1.3 : 1.0) },
              { pose: this.legPoses.up, weight: upAmount * (this.currentDominantDirection === 'up' ? 1.3 : 1.0) },
              { pose: this.legPoses.down, weight: downAmount * (this.currentDominantDirection === 'down' ? 1.3 : 1.0) },
              { pose: this.legPoses.sideways, weight: sidewaysAmount * (this.currentDominantDirection === 'sideways' ? 1.3 : 1.0) }
            ];
            
            targetPose.hipFlex = 0;
            targetPose.hipSpread = 0;
            targetPose.kneeBend = 0;
            targetPose.ankleFlex = 0;
            
            let totalWeight = 0;
            poseWeights.forEach(({ pose, weight }) => {
              if (weight > 0) {
                targetPose.hipFlex += pose.hipFlex * weight;
                targetPose.hipSpread += pose.hipSpread * weight;
                targetPose.kneeBend += pose.kneeBend * weight;
                targetPose.ankleFlex += pose.ankleFlex * weight;
                totalWeight += weight;
              }
            });
            
            if (totalWeight > 0) {
              targetPose.hipFlex /= totalWeight;
              targetPose.hipSpread /= totalWeight;
              targetPose.kneeBend /= totalWeight;
              targetPose.ankleFlex /= totalWeight;
            }
            
            const speedFactor = Math.min(1.0, speed);
            targetPose.hipFlex = THREE.MathUtils.lerp(this.legPoses.rest.hipFlex, targetPose.hipFlex, speedFactor);
            targetPose.hipSpread = THREE.MathUtils.lerp(this.legPoses.rest.hipSpread, targetPose.hipSpread, speedFactor);
            targetPose.kneeBend = THREE.MathUtils.lerp(this.legPoses.rest.kneeBend, targetPose.kneeBend, speedFactor);
            targetPose.ankleFlex = THREE.MathUtils.lerp(this.legPoses.rest.ankleFlex, targetPose.ankleFlex, speedFactor);
          }
          
          this.currentLegPose.hipFlex = THREE.MathUtils.lerp(this.currentLegPose.hipFlex, targetPose.hipFlex, this.legPoseBlendSpeed);
          this.currentLegPose.hipSpread = THREE.MathUtils.lerp(this.currentLegPose.hipSpread, targetPose.hipSpread, this.legPoseBlendSpeed);
          this.currentLegPose.kneeBend = THREE.MathUtils.lerp(this.currentLegPose.kneeBend, targetPose.kneeBend, this.legPoseBlendSpeed);
          this.currentLegPose.ankleFlex = THREE.MathUtils.lerp(this.currentLegPose.ankleFlex, targetPose.ankleFlex, this.legPoseBlendSpeed);
          
          const leftPose = { ...this.currentLegPose };
          const rightPose = { ...this.currentLegPose };
          
          const sidewaysVel = localVel.x;
          const sidewaysAmount = Math.abs(sidewaysVel);
          
          this.legIdlePhase += dt * this.legIdleRate;
          
          const idleInfluence = Math.max(0, 1.0 - speed * 2.0);
          const leftIdleOffset = Math.sin(this.legIdlePhase) * this.legIdleAmount * idleInfluence;
          const rightIdleOffset = Math.sin(this.legIdlePhase + Math.PI) * this.legIdleAmount * idleInfluence;
          
          leftPose.hipFlex += leftIdleOffset * 0.5;
          leftPose.kneeBend += leftIdleOffset;
          leftPose.ankleFlex += leftIdleOffset * 0.3;
          rightPose.hipFlex += rightIdleOffset * 0.5;
          rightPose.kneeBend += rightIdleOffset;
          rightPose.ankleFlex += rightIdleOffset * 0.3;
          
          if (sidewaysAmount > 0.1) {
            if (sidewaysVel < 0) {
              leftPose.kneeBend *= 0.6;
              rightPose.kneeBend *= 1.4;
              leftPose.ankleSway = -15;
              rightPose.ankleSway = 10;
            } else {
              rightPose.kneeBend *= 0.6;
              leftPose.kneeBend *= 1.4;
              rightPose.ankleSway = 15;
              leftPose.ankleSway = -10;
            }
          } else {
            leftPose.ankleSway = 0;
            rightPose.ankleSway = 0;
          }
          
          ['hipFlex', 'hipSpread', 'kneeBend', 'ankleFlex', 'ankleSway'].forEach(prop => {
            this.smoothedLegPose.left[prop] = THREE.MathUtils.lerp(
              this.smoothedLegPose.left[prop],
              leftPose[prop] || 0,
              this.legSmoothingFactor
            );
            this.smoothedLegPose.right[prop] = THREE.MathUtils.lerp(
              this.smoothedLegPose.right[prop],
              rightPose[prop] || 0,
              this.legSmoothingFactor
            );
          });
          
          this.applyLegPose('left', this.smoothedLegPose.left);
          this.applyLegPose('right', this.smoothedLegPose.right);
        },

        applyLegPose: function(side, pose) {
          const upLegBone = this.bones[`${side}UpLeg`];
          const legBone = this.bones[`${side}Leg`];
          const footBone = this.bones[`${side}Foot`];
          
          if (!upLegBone || !legBone || !footBone) return;
          
          const hipFlexRad = THREE.MathUtils.degToRad(pose.hipFlex);
          const hipSpreadRad = THREE.MathUtils.degToRad(pose.hipSpread) * (side === 'left' ? 1 : -1);
          const kneeBendRad = THREE.MathUtils.degToRad(pose.kneeBend);
          const ankleFlexRad = THREE.MathUtils.degToRad(pose.ankleFlex);
          const ankleSwayRad = THREE.MathUtils.degToRad(pose.ankleSway || 0);
          
          const hipZRot = Math.PI + hipSpreadRad;
          upLegBone.rotation.set(hipFlexRad, 0, hipZRot, 'XYZ');
          legBone.rotation.set(-kneeBendRad, 0, 0, 'XYZ');
          footBone.rotation.set(ankleFlexRad, 0, ankleSwayRad, 'XYZ');
        },

        solveArmIK: function(hand, handWorldPos, handWorldQuat) {
          const shoulderBone = this.bones[`${hand}Shoulder`];
          const upperArmBone = this.bones[`${hand}UpperArm`];
          const forearmBone = this.bones[`${hand}Forearm`];
          const handBone = this.bones[`${hand}HandBone`];
          
          if (!shoulderBone || !upperArmBone || !forearmBone) {
            return;
          }
          
          const shoulderWorldPos = new THREE.Vector3();
          shoulderBone.getWorldPosition(shoulderWorldPos);
          
          const adjustedHandPos = handWorldPos.clone();
          const leftRightOffsetLocal = new THREE.Vector3(hand === 'left' ? 0.1 : -0.1, 0, 0);
          const leftRightOffsetWorld = leftRightOffsetLocal.applyQuaternion(this.el.object3D.quaternion);
          adjustedHandPos.add(leftRightOffsetWorld);
          
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
          
          const toTarget = targetHandPos.clone().sub(shoulderWorldPos);
          const targetDist = toTarget.length();
          const toTargetDir = toTarget.normalize();
          
          const upperSq = this.config.upperArmLength * this.config.upperArmLength;
          const lowerSq = this.config.lowerArmLength * this.config.lowerArmLength;
          const distSq = targetDist * targetDist;
          
          const cosAngle = (upperSq + distSq - lowerSq) / (2 * this.config.upperArmLength * targetDist);
          const clampedCos = Math.max(-0.999, Math.min(0.999, cosAngle));
          const angle = Math.acos(clampedCos);
          
          const bodyForward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.torsoRotation);
          const bodyRight = new THREE.Vector3(1, 0, 0).applyQuaternion(this.torsoRotation);
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
          
          let elbowWorldPos = shoulderWorldPos.clone().add(elbowDir.multiplyScalar(this.config.upperArmLength));
          
          const shoulderToElbow = elbowWorldPos.clone().sub(shoulderWorldPos);
          if (Math.abs(shoulderToElbow.length() - this.config.upperArmLength) > 0.0001) {
            elbowWorldPos.copy(shoulderWorldPos).add(shoulderToElbow.normalize().multiplyScalar(this.config.upperArmLength));
          }
          
          const elbowToHand = targetHandPos.clone().sub(elbowWorldPos);
          if (Math.abs(elbowToHand.length() - this.config.lowerArmLength) > 0.0001) {
            targetHandPos.copy(elbowWorldPos).add(elbowToHand.normalize().multiplyScalar(this.config.lowerArmLength));
          }
          
          this.el.object3D.updateMatrixWorld(true);
          
          upperArmBone.parent.updateMatrixWorld(true);
          const shoulderInParent = upperArmBone.parent.worldToLocal(shoulderWorldPos.clone());
          const elbowInParent = upperArmBone.parent.worldToLocal(elbowWorldPos.clone());
          const upperArmParentDir = shoulderInParent.clone().sub(elbowInParent).normalize();
          const tPoseDir = new THREE.Vector3(0, -1, 0);
          const upperArmQuat = new THREE.Quaternion().setFromUnitVectors(tPoseDir, upperArmParentDir);
          upperArmBone.quaternion.copy(upperArmQuat);
          upperArmBone.updateMatrixWorld(true);
          
          forearmBone.parent.updateMatrixWorld(true);
          const elbowInUpperArm = forearmBone.parent.worldToLocal(elbowWorldPos.clone());
          const handInUpperArm = forearmBone.parent.worldToLocal(targetHandPos.clone());
          const forearmParentDir = elbowInUpperArm.clone().sub(handInUpperArm).normalize();
          const forearmQuat = new THREE.Quaternion().setFromUnitVectors(tPoseDir, forearmParentDir);
          
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
          
          if (handBone) {
            forearmBone.updateMatrixWorld(true);
            const forearmWorldQuat2 = new THREE.Quaternion();
            forearmBone.getWorldQuaternion(forearmWorldQuat2);
            let handLocalQuat = handWorldQuat.clone();
            handLocalQuat.premultiply(forearmWorldQuat2.clone().invert());
            const localXFlip = new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(1, 0, 0),
              Math.PI
            );
            handLocalQuat.multiply(localXFlip);
            const rollCorrection = new THREE.Quaternion().setFromAxisAngle(
              new THREE.Vector3(0, 1, 0),
              hand === 'left' ? Math.PI / 2 : -Math.PI / 2
            );
            handLocalQuat.multiply(rollCorrection);
            handBone.quaternion.copy(handLocalQuat);
          }
        },

        updateFingerPoses: function() {
          if (!this.leftController || !this.rightController) return;
          
          const leftGamepad = this.leftController.components['tracked-controls']?.controller?.gamepad;
          const rightGamepad = this.rightController.components['tracked-controls']?.controller?.gamepad;
          
          if (leftGamepad && leftGamepad.buttons) {
            const trigger = leftGamepad.buttons[0]?.value || 0;
            const grip = leftGamepad.buttons[1]?.value || 0;
            
            let anyThumbTouch = 0;
            for (let i = 2; i <= 6; i++) {
              if (leftGamepad.buttons[i]?.touched) {
                anyThumbTouch = 1;
                break;
              }
            }
            
            this.updateTargetCurls('left', trigger, grip, anyThumbTouch);
          }
          
          if (rightGamepad && rightGamepad.buttons) {
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
          const restingCurls = {
            thumb: 0.1,
            index: 0.15,
            middle: 0.2,
            ring: 0.25,
            pinky: 0.25
          };
          
          const activeCurls = {
            thumb: thumbTouch * 0.8,
            index: trigger,
            middle: grip * 1.1,
            ring: grip * 1.15,
            pinky: grip * 1.2
          };
          
          if (grip > 0.1 && trigger < 0.1) {
            activeCurls.index = 0;
          }
          
          const curls = {
            thumb: Math.max(restingCurls.thumb, activeCurls.thumb),
            index: Math.max(restingCurls.index, activeCurls.index),
            middle: Math.max(restingCurls.middle, activeCurls.middle),
            ring: Math.max(restingCurls.ring, activeCurls.ring),
            pinky: Math.max(restingCurls.pinky, activeCurls.pinky)
          };
          
          if (grip > 0.1 && trigger < 0.1) {
            curls.index = 0.05;
          }
          
          if (grip > 0.5 && thumbTouch < 0.5) {
            curls.thumb = -0.15;
          }
          
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
              if (initialRot) {
                bone.quaternion.copy(initialRot);
              }
              
              const curlAmount = curl * (0.5 + i * 0.25);
              const curlAngle = curlAmount * Math.PI * 0.6 * sign;
              
              const curlQuat = new THREE.Quaternion().setFromAxisAngle(axis, curlAngle);
              bone.quaternion.multiply(curlQuat);
            });
          });
        },

        // Update remote pose data (called by network sync)
        updateRemotePoseData: function(poseData) {
          this.remotePoseData = poseData;
        }
      });
