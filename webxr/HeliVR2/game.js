import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { RescueSystem } from './systems/rescue.js';
import { HudSystem } from './systems/hud.js';

export class Game {
    constructor(env) {
        this.env = env;
        this.physicsWorld = null;
        this.rigidBodies = [];
        this.rescueSystem = null;
        this.hud = null;

        this.initPhysics();
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000);
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.xr.enabled = true;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        document.body.appendChild(this.renderer.domElement);
        document.body.appendChild(VRButton.createButton(this.renderer));

        this.clock = new THREE.Clock();
        this.keys = {};
        this.transformAux1 = new Ammo.btTransform();

        this.heliBody = null;
        this.heliMesh = null;
        this.rotorBody = null;
        this.rotorMesh = null;
        this.thrust = { x: 0, y: 147, z: 0 };
        this.stableLift = 147;
        this.chaseCamV = new THREE.Vector3();

        this.initScene();
        this.animate();
    }

    initPhysics() {
        const cc = new Ammo.btDefaultCollisionConfiguration();
        const dp = new Ammo.btCollisionDispatcher(cc);
        const bp = new Ammo.btDbvtBroadphase();
        const sv = new Ammo.btSequentialImpulseConstraintSolver();
        this.physicsWorld = new Ammo.btDiscreteDynamicsWorld(dp, bp, sv, cc);
        this.physicsWorld.setGravity(new Ammo.btVector3(0, -9.81, 0));
    }

    initScene() {
        this.scene.background = new THREE.Color(this.env.fogColor || 0x87ceeb);
        this.scene.fog = new THREE.Fog(this.env.fogColor || 0x87ceeb, this.env.fogNear || 200, this.env.fogFar || 2000);

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const sunLight = new THREE.DirectionalLight(0xffffff, 1);
        sunLight.position.set(100, 500, 100);
        sunLight.castShadow = true;
        sunLight.shadow.mapSize.width = 4096;
        sunLight.shadow.mapSize.height = 4096;
        sunLight.shadow.camera.near = 0.5;
        sunLight.shadow.camera.far = 1500;
        sunLight.shadow.camera.left = -500;
        sunLight.shadow.camera.right = 500;
        sunLight.shadow.camera.top = 500;
        sunLight.shadow.camera.bottom = -500;
        this.scene.add(sunLight);

        this.playerGroup = new THREE.Group();
        this.scene.add(this.playerGroup);
        this.playerGroup.add(this.camera);

        const createRigidBody = this.createRigidBody.bind(this);
        this.env.build({ scene: this.scene, createRigidBody, physicsWorld: this.physicsWorld });

        this.createPhysicalHelicopter();

        // Rescue system
        const pickups = this.env.getPickupPoints();
        const dropoffs = this.env.getDropoffPoints();
        if (pickups.length > 0 && dropoffs.length > 0) {
            this.rescueSystem = new RescueSystem(this.scene, pickups, dropoffs);
            this.hud = new HudSystem();
            this.hud.createVRHud(this.playerGroup);
        } else {
            const hudEl = document.getElementById('hud');
            if (hudEl) hudEl.style.display = 'none';
        }

        window.addEventListener('keydown', (e) => {
            this.keys[e.code] = true;
            if (e.code === 'Space' && !this.renderer.xr.isPresenting) this.shoot();
        });
        window.addEventListener('keyup', (e) => this.keys[e.code] = false);
        window.addEventListener('mousedown', () => this.shoot());
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    createRigidBody(mesh, shape, mass, pos, quat, isHeli = false) {
        mesh.position.copy(pos);
        mesh.quaternion.copy(quat);

        const transform = new Ammo.btTransform();
        transform.setIdentity();
        transform.setOrigin(new Ammo.btVector3(pos.x, pos.y, pos.z));
        transform.setRotation(new Ammo.btQuaternion(quat.x, quat.y, quat.z, quat.w));
        const motionState = new Ammo.btDefaultMotionState(transform);

        const localInertia = new Ammo.btVector3(0, 0, 0);
        shape.calculateLocalInertia(mass, localInertia);

        const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
        const body = new Ammo.btRigidBody(rbInfo);
        body.setFriction(0.8);

        if (isHeli) {
            body.setActivationState(4);
            this.heliBody = body;
        }

        mesh.userData.physicsBody = body;
        if (mass > 0) this.rigidBodies.push(mesh);

        this.scene.add(mesh);
        this.physicsWorld.addRigidBody(body);
        return body;
    }

    createPhysicalHelicopter() {
        const spawn = this.env.spawnPosition || new THREE.Vector3(0, 50, 0);

        this.heliMesh = new THREE.Group();
        const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 6), new THREE.MeshStandardMaterial({ color: 0x244424 }));
        bodyMesh.castShadow = true;
        this.heliMesh.add(bodyMesh);

        const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.5, 4), new THREE.MeshStandardMaterial({ color: 0x244424 }));
        tail.position.set(0, 0, -4);
        tail.castShadow = true;
        this.heliMesh.add(tail);

        const skidGeo = new THREE.BoxGeometry(0.2, 0.1, 3);
        const skidMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
        const skidL = new THREE.Mesh(skidGeo, skidMat);
        skidL.position.set(-0.8, -1.2, 0);
        skidL.castShadow = true;
        this.heliMesh.add(skidL);
        const skidR = new THREE.Mesh(skidGeo, skidMat);
        skidR.position.set(0.8, -1.2, 0);
        skidR.castShadow = true;
        this.heliMesh.add(skidR);

        this.chaseCam = new THREE.Object3D();
        this.chaseCamPivot = new THREE.Object3D();
        this.chaseCamPivot.position.set(0, 5, -15);
        this.chaseCam.add(this.chaseCamPivot);
        this.heliMesh.add(this.chaseCam);

        const heliShape = new Ammo.btBoxShape(new Ammo.btVector3(1.2, 1, 4));
        this.createRigidBody(this.heliMesh, heliShape, 5, spawn.clone(), new THREE.Quaternion(0,0,0,1), true);
        this.heliBody.setDamping(0, 0.9);

        this.rotorMesh = new THREE.Mesh(
            new THREE.BoxGeometry(10, 0.1, 0.4),
            new THREE.MeshStandardMaterial({ color: 0x111111 })
        );
        this.rotorMesh.castShadow = true;
        this.scene.add(this.rotorMesh);

        const rotorShape = new Ammo.btSphereShape(0.2);
        const rotorTransform = new Ammo.btTransform();
        rotorTransform.setIdentity();
        rotorTransform.setOrigin(new Ammo.btVector3(spawn.x, spawn.y + 2, spawn.z));
        const rotorMS = new Ammo.btDefaultMotionState(rotorTransform);
        const rotorInertia = new Ammo.btVector3(0, 0, 0);
        rotorShape.calculateLocalInertia(10, rotorInertia);
        const rotorRbInfo = new Ammo.btRigidBodyConstructionInfo(10, rotorMS, rotorShape, rotorInertia);
        this.rotorBody = new Ammo.btRigidBody(rotorRbInfo);
        this.rotorBody.setDamping(0.5, 0);
        this.rotorBody.setActivationState(4);
        this.physicsWorld.addRigidBody(this.rotorBody);

        const pivotH = new Ammo.btVector3(0, 2, 0);
        const pivotR = new Ammo.btVector3(0, 0, 0);
        const constraint = new Ammo.btPoint2PointConstraint(this.heliBody, this.rotorBody, pivotH, pivotR);
        this.physicsWorld.addConstraint(constraint, true);
    }

    shoot() {
        const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.heliMesh.quaternion);
        const pos = this.heliMesh.position.clone().add(dir.clone().multiplyScalar(10));
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshBasicMaterial({ color: 0xffaa00 }));
        const body = this.createRigidBody(ball, new Ammo.btSphereShape(0.5), 100, pos, new THREE.Quaternion(0,0,0,1));
        body.setLinearVelocity(new Ammo.btVector3(dir.x * 300, dir.y * 300, dir.z * 300));
    }

    updateHeliPhysics(delta) {
        if (!this.heliBody || !this.rotorBody) return;

        const rotorAngVel = this.rotorBody.getAngularVelocity();
        let rotorAngVelY = rotorAngVel.y();
        let climbing = false, yawing = false, pitching = false, banking = false;

        if (this.keys['KeyW']) {
            if (this.thrust.y < 400) { this.thrust.y += 50 * delta; climbing = true; }
        }
        if (this.keys['KeyS']) {
            if (this.thrust.y > 0) { this.thrust.y -= 50 * delta; climbing = true; }
        }
        if (this.keys['KeyA']) {
            if (rotorAngVelY < 2.0) rotorAngVelY += 5 * delta;
            yawing = true;
        }
        if (this.keys['KeyD']) {
            if (rotorAngVelY > -2.0) rotorAngVelY -= 5 * delta;
            yawing = true;
        }
        if (this.keys['ArrowUp'] || this.keys['Numpad8']) {
            if (this.thrust.z <= 250) this.thrust.z += 80 * delta;
            pitching = true;
        }
        if (this.keys['ArrowDown'] || this.keys['Numpad5']) {
            if (this.thrust.z >= -250) this.thrust.z -= 80 * delta;
            pitching = true;
        }
        if (this.keys['ArrowLeft'] || this.keys['Numpad4']) {
            if (this.thrust.x <= 100) this.thrust.x += 50 * delta;
            banking = true;
        }
        if (this.keys['ArrowRight'] || this.keys['Numpad6']) {
            if (this.thrust.x >= -100) this.thrust.x -= 50 * delta;
            banking = true;
        }

        if (this.renderer.xr.isPresenting) {
            const session = this.renderer.xr.getSession();
            if (session && session.inputSources) {
                for (const source of session.inputSources) {
                    if (!source.gamepad) continue;
                    const axes = source.gamepad.axes;
                    const buttons = source.gamepad.buttons;
                    if (source.handedness === 'right') {
                        const bk = axes[2] || 0;
                        const pt = -(axes[3] || 0);
                        if (Math.abs(bk) > 0.1) { this.thrust.x = -bk * 100; banking = true; }
                        if (Math.abs(pt) > 0.1) { this.thrust.z = pt * 250; pitching = true; }
                        if (buttons[0] && buttons[0].pressed) this.shoot();
                    } else if (source.handedness === 'left') {
                        const yw = -(axes[2] || 0);
                        const th = -(axes[3] || 0);
                        if (Math.abs(yw) > 0.1) { rotorAngVelY = yw * 2.0; yawing = true; }
                        if (Math.abs(th) > 0.1) {
                            this.thrust.y = Math.max(0, Math.min(400, this.stableLift + th * 250));
                            climbing = true;
                        }
                    }
                }
            }
        }

        if (!yawing) {
            if (rotorAngVelY < 0) rotorAngVelY += 1 * delta;
            if (rotorAngVelY > 0) rotorAngVelY -= 1 * delta;
        }

        const heliAngVel = this.heliBody.getAngularVelocity();
        this.heliBody.setAngularVelocity(new Ammo.btVector3(heliAngVel.x(), rotorAngVelY, heliAngVel.z()));
        this.rotorBody.setAngularVelocity(new Ammo.btVector3(rotorAngVel.x(), rotorAngVelY, rotorAngVel.z()));

        if (!pitching) {
            if (this.thrust.z < 0) this.thrust.z += 25 * delta;
            if (this.thrust.z > 0) this.thrust.z -= 25 * delta;
        }
        if (!banking) {
            if (this.thrust.x < 0) this.thrust.x += 25 * delta;
            if (this.thrust.x > 0) this.thrust.x -= 25 * delta;
        }
        if (!climbing && this.heliMesh.position.y > 5) {
            this.thrust.y = this.stableLift;
        }

        const rotorTransform = this.rotorBody.getWorldTransform();
        const rotorRot = rotorTransform.getRotation();
        const q = new THREE.Quaternion(rotorRot.x(), rotorRot.y(), rotorRot.z(), rotorRot.w());
        const worldForce = new THREE.Vector3(this.thrust.x, this.thrust.y, this.thrust.z).applyQuaternion(q);
        this.rotorBody.applyCentralForce(new Ammo.btVector3(worldForce.x, worldForce.y, worldForce.z));
    }

    updatePhysics(delta) {
        this.physicsWorld.stepSimulation(delta, 10);

        for (let i = 0; i < this.rigidBodies.length; i++) {
            const obj = this.rigidBodies[i];
            const phys = obj.userData.physicsBody;
            const ms = phys.getMotionState();
            if (ms) {
                ms.getWorldTransform(this.transformAux1);
                const p = this.transformAux1.getOrigin();
                const r = this.transformAux1.getRotation();
                obj.position.set(p.x(), p.y(), p.z());
                obj.quaternion.set(r.x(), r.y(), r.z(), r.w());
            }
        }

        this.checkCollisions();
    }

    checkCollisions() {
        const dispatcher = this.physicsWorld.getDispatcher();
        for (let i = 0; i < dispatcher.getNumManifolds(); i++) {
            const manifold = dispatcher.getManifoldByIndexInternal(i);
            const body0 = Ammo.castObject(manifold.getBody0(), Ammo.btRigidBody);
            const body1 = Ammo.castObject(manifold.getBody1(), Ammo.btRigidBody);
            this.checkBreak(body0);
            this.checkBreak(body1);
        }
    }

    checkBreak(body) {
        this.scene.traverse(mesh => {
            if (mesh.userData && mesh.userData.physicsBody === body && mesh.userData.breakable) {
                this.physicsWorld.removeRigidBody(body);
                mesh.userData.breakable = false;
                const pos = mesh.position.clone();
                const quat = mesh.quaternion.clone();
                const size = mesh.geometry.parameters;
                this.scene.remove(mesh);
                this.createRigidBody(mesh, new Ammo.btBoxShape(new Ammo.btVector3(size.width/2, size.height/2, size.depth/2)), 500, pos, quat);
                mesh.userData.physicsBody.applyCentralImpulse(new Ammo.btVector3(0, -2000, 0));
            }
        });
    }

    animate() {
        this.renderer.setAnimationLoop(() => {
            const delta = Math.min(this.clock.getDelta(), 0.05);
            this.updateHeliPhysics(delta);
            this.updatePhysics(delta);

            if (this.rotorBody) {
                const ms = this.rotorBody.getMotionState();
                if (ms) {
                    ms.getWorldTransform(this.transformAux1);
                    const p = this.transformAux1.getOrigin();
                    this.rotorMesh.position.set(p.x(), p.y(), p.z());
                }
                this.rotorMesh.rotateY(this.thrust.y * delta * 0.2);
            }

            if (this.env.update) this.env.update(delta);

            if (this.rescueSystem) {
                this.rescueSystem.update(delta, this.heliMesh, this.heliBody);
            }

            if (this.hud && this.rescueSystem) {
                this.hud.update(this.heliMesh, this.rescueSystem);
                if (this.renderer.xr.isPresenting) {
                    const target = this.rescueSystem.getActiveTarget();
                    this.hud.updateVRHud(this.rescueSystem, target);
                }
            }

            if (this.renderer.xr.isPresenting) {
                this.playerGroup.position.copy(this.heliMesh.position);
                this.playerGroup.quaternion.copy(this.heliMesh.quaternion);
                this.playerGroup.rotateY(Math.PI);
                this.camera.position.set(0, -2.0, 2);
                this.playerGroup.position.y -= 2.0;
            } else {
                this.playerGroup.position.set(0, 0, 0);
                this.playerGroup.quaternion.identity();
                this.chaseCamPivot.getWorldPosition(this.chaseCamV);
                if (this.chaseCamV.y < 1) this.chaseCamV.y = 1;
                this.camera.position.lerpVectors(this.camera.position, this.chaseCamV, 0.05);
                this.camera.lookAt(this.heliMesh.position);
            }

            this.renderer.render(this.scene, this.camera);
        });
    }
}
