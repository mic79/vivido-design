import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

let physicsWorld, rigidBodies = [];
const margin = 0.05;

function init() {
    Ammo().then(function (AmmoLib) {
        window.Ammo = AmmoLib;
        new Game();
    });
}

class Game {
    constructor() {
        this.initPhysics();
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 5000);
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.xr.enabled = true;
        this.renderer.shadowMap.enabled = true;
        document.body.appendChild(this.renderer.domElement);
        document.body.appendChild(VRButton.createButton(this.renderer));

        this.clock = new THREE.Clock();
        this.keys = {};
        this.transformAux1 = new Ammo.btTransform();
        
        // Heli Physics Params
        this.mass = 1500;
        this.heliBody = null; // Physics body
        this.heliMesh = null; // Visual group

        this.initScene();
        this.animate();
    }

    initPhysics() {
        const collisionConfiguration = new Ammo.btDefaultCollisionConfiguration();
        const dispatcher = new Ammo.btCollisionDispatcher(collisionConfiguration);
        const overlappingPairCache = new Ammo.btDbvtBroadphase();
        const solver = new Ammo.btSequentialImpulseConstraintSolver();
        physicsWorld = new Ammo.btDiscreteDynamicsWorld(dispatcher, overlappingPairCache, solver, collisionConfiguration);
        physicsWorld.setGravity(new Ammo.btVector3(0, -9.81, 0));
    }

    initScene() {
        this.scene.background = new THREE.Color(0x87ceeb);
        this.scene.fog = new THREE.Fog(0x87ceeb, 200, 2000);

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);
        
        const sunLight = new THREE.DirectionalLight(0xffffff, 1);
        sunLight.position.set(100, 500, 100);
        sunLight.castShadow = true;
        this.scene.add(sunLight);

        // Group to hold both camera and heli for XR tracking
        this.playerGroup = new THREE.Group();
        this.scene.add(this.playerGroup);
        this.playerGroup.add(this.camera); // Add camera to the group

        this.createCanyon();
        this.createPhysicalHelicopter();
        
        window.addEventListener('keydown', (e) => {
            this.keys[e.code] = true;
            if (e.code === 'Space' && !this.renderer.xr.isPresenting) this.shoot();
        });
        window.addEventListener('keyup', (e) => this.keys[e.code] = false);
        window.addEventListener('mousedown', () => this.shoot());
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

        // High friction for heli ground contact
        body.setFriction(0.8);

        if (isHeli) {
            body.setActivationState(4); // Disable deactivation
            this.heliBody = body;
        }

        mesh.userData.physicsBody = body;
        if (mass > 0) rigidBodies.push(mesh);

        this.scene.add(mesh);
        physicsWorld.addRigidBody(body);
        return body;
    }

    createCanyon() {
        const wallMat = new THREE.MeshPhongMaterial({ color: 0x5d4037, flatShading: true });
        
        // Floor
        const groundGeo = new THREE.BoxGeometry(2000, 2, 8000);
        const ground = new THREE.Mesh(groundGeo, new THREE.MeshPhongMaterial({ color: 0x3d2b1f }));
        this.createRigidBody(ground, new Ammo.btBoxShape(new Ammo.btVector3(1000, 1, 4000)), 0, new THREE.Vector3(0, -1, 0), new THREE.Quaternion(0, 0, 0, 1));

        // Create a winding trail, not just a straight alley
        for (let i = 0; i < 120; i++) {
            const z = (i - 60) * 60;
            const xOffset = Math.sin(i * 0.15) * 150; // Winding effect
            
            // Left Wall
            const lW = 200, lH = 200 + Math.random() * 500, lD = 65;
            const lWall = new THREE.Mesh(new THREE.BoxGeometry(lW, lH, lD), wallMat);
            const lShape = new Ammo.btBoxShape(new Ammo.btVector3(lW/2, lH/2, lD/2));
            this.createRigidBody(lWall, lShape, 0, new THREE.Vector3(xOffset - 250, lH/2, z), new THREE.Quaternion(0, 0, 0, 1));

            // Right Wall
            const rW = 200, rH = 200 + Math.random() * 500, rD = 65;
            const rWall = new THREE.Mesh(new THREE.BoxGeometry(rW, rH, rD), wallMat);
            const rShape = new Ammo.btBoxShape(new Ammo.btVector3(rW/2, rH/2, rD/2));
            this.createRigidBody(rWall, rShape, 0, new THREE.Vector3(xOffset + 250, rH/2, z), new THREE.Quaternion(0, 0, 0, 1));

            // Random middle pillars to weave through
            if (i % 8 === 0) {
                const pW = 30, pH = 150 + Math.random() * 200;
                const pillar = new THREE.Mesh(new THREE.BoxGeometry(pW, pH, pW), wallMat);
                this.createRigidBody(pillar, new Ammo.btBoxShape(new Ammo.btVector3(pW/2, pH/2, pW/2)), 0, new THREE.Vector3(xOffset + (Math.random()-0.5)*150, pH/2, z + 30), new THREE.Quaternion(0,0,0,1));
            }

            // Destructible Overhangs
            if (Math.random() > 0.7) {
                const oW = 200, oH = 10, oD = 40;
                const overhang = new THREE.Mesh(new THREE.BoxGeometry(oW, oH, oD), wallMat);
                overhang.userData.breakable = true;
                this.createRigidBody(overhang, new Ammo.btBoxShape(new Ammo.btVector3(oW/2, oH/2, oD/2)), 0, new THREE.Vector3(xOffset + (i%2==0? -100 : 100), 100 + Math.random()*50, z), new THREE.Quaternion(0,0,0,1));
            }
        }
    }

    createPhysicalHelicopter() {
        this.heliMesh = new THREE.Group();
        const bodyMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 6), new THREE.MeshStandardMaterial({color: 0x244424}));
        bodyMesh.castShadow = true;
        this.heliMesh.add(bodyMesh);

        this.rotor = new THREE.Mesh(new THREE.BoxGeometry(10, 0.1, 0.4), new THREE.MeshStandardMaterial({color: 0x111111}));
        this.rotor.position.set(0, 2.2, 0);
        this.heliMesh.add(this.rotor);

        const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.5, 4), new THREE.MeshStandardMaterial({color: 0x244424}));
        tail.position.set(0, 0, -4);
        this.heliMesh.add(tail);

        // Use a Capsule or Box for the heli physics
        const shape = new Ammo.btBoxShape(new Ammo.btVector3(1.2, 1, 4));
        this.createRigidBody(this.heliMesh, shape, this.mass, new THREE.Vector3(0, 50, 0), new THREE.Quaternion(0, 0, 0, 1), true);
    }

    shoot() {
        const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.heliMesh.quaternion);
        const pos = this.heliMesh.position.clone().add(dir.clone().multiplyScalar(10));
        
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshBasicMaterial({color: 0xffaa00}));
        const body = this.createRigidBody(ball, new Ammo.btSphereShape(0.5), 100, pos, new THREE.Quaternion(0, 0, 0, 1));
        body.setLinearVelocity(new Ammo.btVector3(dir.x * 300, dir.y * 300, dir.z * 300));
    }

    updateHeliPhysics(delta) {
        if (!this.heliBody) return;

        // "Battlefield/GTA" Flight Physics
        // W/S: Collective (Engine Thrust)
        // Arrows: Pitch & Roll
        // A/D: Yaw
        
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.heliMesh.quaternion);
        
        // Input state
        let pitch = (this.keys['ArrowUp'] ? 1 : 0) + (this.keys['ArrowDown'] ? -1 : 0);
        let roll = (this.keys['ArrowLeft'] ? -1 : 0) + (this.keys['ArrowRight'] ? 1 : 0);
        let yaw = (this.keys['KeyA'] ? 1 : 0) + (this.keys['KeyD'] ? -1 : 0);
        let thrustInput = (this.keys['KeyW'] ? 1 : 0) + (this.keys['KeyS'] ? -0.2 : 0);

        // Quest 3 Controller Inputs
        if (this.renderer.xr.isPresenting) {
            const session = this.renderer.xr.getSession();
            if (session && session.inputSources) {
                for (const source of session.inputSources) {
                    if (source.gamepad) {
                        const axes = source.gamepad.axes; // [thumbstickX, thumbstickY, ...]
                        const buttons = source.gamepad.buttons;
                        
                        if (source.handedness === 'right') {
                            // Right stick: Pitch/Roll
                            roll += axes[2] || 0; // standard xr mapping
                            pitch -= axes[3] || 0;
                            // Right Trigger to shoot handled by event listener, but also:
                            if (buttons[0].pressed) this.shoot(); 
                        } else if (source.handedness === 'left') {
                            // Left stick: Thrust/Yaw
                            yaw -= axes[2] || 0; // Inverted yaw direction
                            thrustInput -= axes[3] || 0;
                        }
                    }
                }
            }
        }
        
        // 1. Thrust (Collective)
        let thrustMag = thrustInput * 100000;
        if (thrustInput === 0) thrustMag = 0; // maintain hover bias handled by physics tuning
        
        const thrust = new Ammo.btVector3(up.x * thrustMag, up.y * thrustMag, up.z * thrustMag);
        this.heliBody.applyCentralForce(thrust);

        // 2. Torques (Pitch, Roll, Yaw)
        const torqueScale = 12000;
        const localTorque = new THREE.Vector3(pitch * torqueScale, yaw * torqueScale * 1.5, roll * torqueScale);
        localTorque.applyQuaternion(this.heliMesh.quaternion);
        
        this.heliBody.applyTorque(new Ammo.btVector3(localTorque.x, localTorque.y, localTorque.z));

        // 3. Air Resistance (Damping)
        this.heliBody.setDamping(0.3, 0.8);

        // Visual rotor
        this.rotor.rotation.y += delta * 30;
    }

    updatePhysics(delta) {
        physicsWorld.stepSimulation(delta, 10);

        for (let i = 0; i < rigidBodies.length; i++) {
            const objThree = rigidBodies[i];
            const objPhys = objThree.userData.physicsBody;
            const ms = objPhys.getMotionState();
            if (ms) {
                ms.getWorldTransform(this.transformAux1);
                const p = this.transformAux1.getOrigin();
                const q = this.transformAux1.getRotation();
                objThree.position.set(p.x(), p.y(), p.z());
                objThree.quaternion.set(q.x(), q.y(), q.z(), q.w());
            }
        }

        this.checkCollisions();
    }

    checkCollisions() {
        const dispatcher = physicsWorld.getDispatcher();
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
                physicsWorld.removeRigidBody(body);
                mesh.userData.breakable = false;
                
                // Switch to dynamic
                const pos = mesh.position.clone();
                const quat = mesh.quaternion.clone();
                const size = mesh.geometry.parameters;
                this.scene.remove(mesh);
                
                this.createRigidBody(mesh, new Ammo.btBoxShape(new Ammo.btVector3(size.width/2, size.height/2, size.depth/2)), 500, pos, quat);
                mesh.userData.physicsBody.applyCentralImpulse(new Ammo.btVector3(0, -2000, 0));
            }
        });
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        this.renderer.setAnimationLoop(() => {
            const delta = Math.min(this.clock.getDelta(), 0.05);
            this.updateHeliPhysics(delta);
            this.updatePhysics(delta);

            if (this.renderer.xr.isPresenting) {
                // In VR, parent the camera to the heli for cockpit view
                this.playerGroup.position.copy(this.heliMesh.position);
                this.playerGroup.quaternion.copy(this.heliMesh.quaternion);
                
                // Rotation correction: Three.js XR camera defaults to looking down -Z.
                // Our heli is built looking towards +Z.
                // We rotate the playerGroup (or individual components) so VR "forward" matches Heli "forward"
                this.playerGroup.rotateY(Math.PI); 

                // Position camera inside cockpit
                this.camera.position.set(0, -2.0, 2); 
                this.playerGroup.position.y -= 2.0;
            } else {
                // Third person follow for desktop
                const camOffset = new THREE.Vector3(0, 5, -20).applyQuaternion(this.heliMesh.quaternion);
                this.camera.position.lerp(this.heliMesh.position.clone().add(camOffset), 0.1);
                this.camera.lookAt(this.heliMesh.position);
            }

            this.renderer.render(this.scene, this.camera);
        });
    }
}

init();
