// Zero-G WebXR Multiplayer - Physics Manager using Rapier

window.PhysicsManager = class PhysicsManager {
    constructor() {
        this.isInitialized = false;
        this.world = null;
        this.RAPIER = null;
        this.isMockPhysics = false;
        
        // Physics objects tracking
        this.rigidBodies = new Map();
        this.colliders = new Map();
        
        // Event handling
        this.eventQueue = null;
        this.collisionCallbacks = new Map();
        
        // Performance tracking
        this.lastStepTime = 0;
        this.physicsObjects = 0;
    }
    
    async init() {
        try {
            console.log('⚛️ Initializing Rapier Physics...');
            
            // Wait for Rapier to be available
            await this.waitForRapier();
            
            // Check if we're using mock physics
            if (this.isMockPhysics) {
                console.warn('⚠️ Using mock physics - some features may be limited');
                this.RAPIER = window.RAPIER;
                this.initMockWorld();
            } else {
                // Initialize real Rapier
                if (window.RAPIER.init) {
                    await window.RAPIER.init();
                }
                this.RAPIER = window.RAPIER;
                this.initRealWorld();
            }
            
            this.isInitialized = true;
            console.log('✅ Physics engine initialized successfully');
            
        } catch (error) {
            console.error('❌ Failed to initialize physics:', error);
            throw error;
        }
    }
    
    async waitForRapier() {
        return new Promise((resolve, reject) => {
            const maxAttempts = 200; // Increased attempts
            let attempts = 0;
            
            const checkRapier = () => {
                attempts++;
                
                if (typeof window.RAPIER !== 'undefined') {
                    console.log('✅ Rapier found on window object');
                    
                    // Check if it's mock physics
                    this.isMockPhysics = window.RAPIER._isMock || 
                                       !window.RAPIER.init || 
                                       typeof window.RAPIER.World !== 'function';
                    
                    if (this.isMockPhysics) {
                        console.warn('⚠️ Mock Rapier detected');
                    }
                    
                    resolve();
                } else if (attempts >= maxAttempts) {
                    console.error('❌ Rapier not found, creating emergency mock');
                    this.createEmergencyMock();
                    resolve();
                } else {
                    setTimeout(checkRapier, 25); // Faster checking
                }
            };
            
            checkRapier();
        });
    }
    
    createEmergencyMock() {
        // Create a very basic mock for emergency fallback
        window.RAPIER = {
            _isMock: true,
            World: class MockWorld {
                constructor() { this.bodies = new Map(); this.colliders = new Map(); }
                step() {}
                createRigidBody(desc) {
                    const body = {
                        uuid: Math.random().toString(36),
                        translation: () => ({ x: 0, y: 0, z: 0 }),
                        rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
                        setLinvel: () => {},
                        linvel: () => ({ x: 0, y: 0, z: 0 }),
                        setLinearDamping: () => {},
                        setAngularDamping: () => {},
                        lockRotations: () => {},
                        enableCcd: () => {},
                        addForce: () => {},
                        applyImpulse: () => {}
                    };
                    this.bodies.set(body.uuid, body);
                    return body;
                }
                createCollider() { return { uuid: Math.random().toString(36) }; }
                removeRigidBody() {}
                removeCollider() {}
                castRay() { return null; }
                createImpulseJoint() { return { uuid: Math.random().toString(36) }; }
                removeImpulseJoint() {}
            },
            Vector3: class MockVector3 {
                constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
            },
            RigidBodyDesc: {
                dynamic: () => ({
                    setTranslation: function() { return this; },
                    setRotation: function() { return this; },
                    setLinearDamping: function() { return this; },
                    setAngularDamping: function() { return this; }
                })
            },
            ColliderDesc: {
                ball: () => ({ setMass: function() { return this; }, setCollisionGroups: function() { return this; }, setRestitution: function() { return this; }, setFriction: function() { return this; } }),
                cuboid: () => ({ setMass: function() { return this; }, setCollisionGroups: function() { return this; }, setRestitution: function() { return this; }, setFriction: function() { return this; } }),
                cylinder: () => ({ setMass: function() { return this; }, setCollisionGroups: function() { return this; }, setRestitution: function() { return this; }, setFriction: function() { return this; } }),
                capsule: () => ({ setMass: function() { return this; }, setCollisionGroups: function() { return this; }, setRestitution: function() { return this; }, setFriction: function() { return this; } })
            },
            JointDesc: {
                spherical: () => ({ setContactsEnabled: function() { return this; } })
            },
            EventQueue: class MockEventQueue {
                constructor() {}
                drainCollisionEvents() {}
            },
            Ray: class MockRay {
                constructor() {}
                pointAt() { return { x: 0, y: 0, z: 0 }; }
            }
        };
        this.isMockPhysics = true;
        console.warn('🚨 Emergency mock physics created');
    }
    
    initRealWorld() {
        // Create physics world with zero gravity
        const gravity = new this.RAPIER.Vector3(...window.Constants.PHYSICS.GRAVITY);
        this.world = new this.RAPIER.World(gravity);
        
        // Setup event queue for collision detection
        this.eventQueue = new this.RAPIER.EventQueue(true);
        
        console.log('✅ Real Rapier physics world created');
    }
    
    initMockWorld() {
        // Create mock world
        this.world = new this.RAPIER.World();
        this.eventQueue = new this.RAPIER.EventQueue();
        
        console.log('⚠️ Mock physics world created');
    }
    
    // Create static mesh collider for environment
    addStaticMesh(threeMesh, collisionGroup = 'environment') {
        if (!this.isInitialized) return null;
        
        const meshId = threeMesh.uuid;
        
        try {
            // Create collider based on mesh geometry
            const colliderDesc = this.createColliderFromGeometry(threeMesh);
            colliderDesc.setCollisionGroups(this.getCollisionGroup(collisionGroup));
            
            // Set position and rotation from Three.js mesh
            const position = threeMesh.position;
            const rotation = threeMesh.quaternion;
            
            colliderDesc.setTranslation(position.x, position.y, position.z);
            colliderDesc.setRotation(rotation);
            
            const collider = this.world.createCollider(colliderDesc);
            
            this.colliders.set(meshId, {
                collider,
                threeMesh,
                type: 'static',
                group: collisionGroup
            });
            
            this.physicsObjects++;
            return collider;
        } catch (error) {
            console.warn('Failed to create static mesh collider:', error);
            return null;
        }
    }
    
    // Create dynamic rigid body for objects that can move
    addDynamicObject(threeMesh, mass = 1.0, collisionGroup = 'objects') {
        if (!this.isInitialized) return null;
        
        const meshId = threeMesh.uuid;
        
        try {
            // Create rigid body
            const rigidBodyDesc = this.RAPIER.RigidBodyDesc.dynamic();
            rigidBodyDesc.setTranslation(
                threeMesh.position.x,
                threeMesh.position.y,
                threeMesh.position.z
            );
            rigidBodyDesc.setRotation(threeMesh.quaternion);
            
            // Set mass and damping for zero-g feel
            rigidBodyDesc.setLinearDamping(window.Constants.PHYSICS.DAMPING);
            rigidBodyDesc.setAngularDamping(window.Constants.PHYSICS.ANGULAR_DAMPING);
            
            const rigidBody = this.world.createRigidBody(rigidBodyDesc);
            
            // Create collider
            const colliderDesc = this.createColliderFromGeometry(threeMesh);
            colliderDesc.setMass(mass);
            colliderDesc.setCollisionGroups(this.getCollisionGroup(collisionGroup));
            colliderDesc.setRestitution(0.6); // Bouncy for fun interactions
            colliderDesc.setFriction(0.4);
            
            const collider = this.world.createCollider(colliderDesc, rigidBody);
            
            this.rigidBodies.set(meshId, {
                rigidBody,
                collider,
                threeMesh,
                type: 'dynamic',
                group: collisionGroup,
                mass
            });
            
            this.physicsObjects++;
            return { rigidBody, collider };
        } catch (error) {
            console.warn('Failed to create dynamic object:', error);
            return null;
        }
    }
    
    // Create player rigid body with special properties
    addPlayerRigidBody(threeMesh, mass = window.Constants.PHYSICS.PLAYER_MASS) {
        if (!this.isInitialized) return null;
        
        const result = this.addDynamicObject(threeMesh, mass, 'player');
        
        if (result && !this.isMockPhysics) {
            const { rigidBody } = result;
            
            try {
                // Special player physics properties
                rigidBody.setLinearDamping(0.8); // More damping for controllable movement
                rigidBody.setAngularDamping(0.9);
                
                // Lock rotation around X and Z axes to keep upright
                if (rigidBody.lockRotations) {
                    rigidBody.lockRotations(true, false, true);
                }
                
                // Set CCD for fast-moving players
                if (rigidBody.enableCcd) {
                    rigidBody.enableCcd(true);
                }
            } catch (error) {
                console.warn('Failed to set player physics properties:', error);
            }
        }
        
        return result;
    }
    
    createColliderFromGeometry(threeMesh) {
        const geometry = threeMesh.geometry;
        
        if (!geometry) {
            // Default to sphere if no geometry
            return this.RAPIER.ColliderDesc.ball(0.5);
        }
        
        try {
            // Get bounding box for size estimation
            geometry.computeBoundingBox();
            const box = geometry.boundingBox;
            const size = new THREE.Vector3();
            box.getSize(size);
            
            // Choose appropriate collider shape
            if (geometry.type === 'SphereGeometry') {
                const radius = Math.max(size.x, size.y, size.z) / 2;
                return this.RAPIER.ColliderDesc.ball(radius);
            } else if (geometry.type === 'CylinderGeometry') {
                const radius = Math.max(size.x, size.z) / 2;
                const height = size.y;
                return this.RAPIER.ColliderDesc.cylinder(height / 2, radius);
            } else if (geometry.type === 'CapsuleGeometry') {
                const radius = Math.max(size.x, size.z) / 2;
                const height = size.y - 2 * radius;
                return this.RAPIER.ColliderDesc.capsule(height / 2, radius);
            } else {
                // Default to box collider
                return this.RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2);
            }
        } catch (error) {
            console.warn('Failed to create collider from geometry, using default:', error);
            return this.RAPIER.ColliderDesc.ball(0.5);
        }
    }
    
    getCollisionGroup(groupName) {
        const groups = window.Constants.PHYSICS.COLLISION_GROUPS;
        return groups[groupName.toUpperCase()] || groups.OBJECTS;
    }
    
    // Apply force to rigid body (for thrusters, etc.)
    applyForce(meshId, force, point = null) {
        const physicsObj = this.rigidBodies.get(meshId);
        if (!physicsObj || physicsObj.type !== 'dynamic') return;
        
        const { rigidBody } = physicsObj;
        
        if (this.isMockPhysics) {
            // Mock implementation - just move the Three.js object
            const threeMesh = physicsObj.threeMesh;
            threeMesh.position.add(new THREE.Vector3(force.x * 0.001, force.y * 0.001, force.z * 0.001));
            return;
        }
        
        try {
            const forceVector = new this.RAPIER.Vector3(force.x, force.y, force.z);
            
            if (point && rigidBody.addForceAtPoint) {
                const pointVector = new this.RAPIER.Vector3(point.x, point.y, point.z);
                rigidBody.addForceAtPoint(forceVector, pointVector, true);
            } else if (rigidBody.addForce) {
                rigidBody.addForce(forceVector, true);
            }
        } catch (error) {
            console.warn('Failed to apply force:', error);
        }
    }
    
    // Apply impulse for instant force
    applyImpulse(meshId, impulse, point = null) {
        const physicsObj = this.rigidBodies.get(meshId);
        if (!physicsObj || physicsObj.type !== 'dynamic') return;
        
        const { rigidBody } = physicsObj;
        
        if (this.isMockPhysics) {
            // Mock implementation
            const threeMesh = physicsObj.threeMesh;
            threeMesh.position.add(new THREE.Vector3(impulse.x * 0.01, impulse.y * 0.01, impulse.z * 0.01));
            return;
        }
        
        try {
            const impulseVector = new this.RAPIER.Vector3(impulse.x, impulse.y, impulse.z);
            
            if (point && rigidBody.applyImpulseAtPoint) {
                const pointVector = new this.RAPIER.Vector3(point.x, point.y, point.z);
                rigidBody.applyImpulseAtPoint(impulseVector, pointVector, true);
            } else if (rigidBody.applyImpulse) {
                rigidBody.applyImpulse(impulseVector, true);
            }
        } catch (error) {
            console.warn('Failed to apply impulse:', error);
        }
    }
    
    // Set velocity directly
    setVelocity(meshId, velocity) {
        const physicsObj = this.rigidBodies.get(meshId);
        if (!physicsObj || physicsObj.type !== 'dynamic') return;
        
        const { rigidBody } = physicsObj;
        
        if (this.isMockPhysics || !rigidBody.setLinvel) return;
        
        try {
            const velocityVector = new this.RAPIER.Vector3(velocity.x, velocity.y, velocity.z);
            rigidBody.setLinvel(velocityVector, true);
        } catch (error) {
            console.warn('Failed to set velocity:', error);
        }
    }
    
    // Get velocity
    getVelocity(meshId) {
        const physicsObj = this.rigidBodies.get(meshId);
        if (!physicsObj || physicsObj.type !== 'dynamic') return new THREE.Vector3();
        
        const { rigidBody } = physicsObj;
        
        if (this.isMockPhysics || !rigidBody.linvel) {
            return new THREE.Vector3();
        }
        
        try {
            const velocity = rigidBody.linvel();
            return new THREE.Vector3(velocity.x, velocity.y, velocity.z);
        } catch (error) {
            console.warn('Failed to get velocity:', error);
            return new THREE.Vector3();
        }
    }
    
    // Clamp velocity to maximum speed
    clampVelocity(meshId, maxSpeed = window.Constants.PHYSICS.MAX_VELOCITY) {
        if (this.isMockPhysics) return;
        
        const velocity = this.getVelocity(meshId);
        if (velocity.length() > maxSpeed) {
            velocity.normalize().multiplyScalar(maxSpeed);
            this.setVelocity(meshId, velocity);
        }
    }
    
    // Raycast for grabbing and interaction
    raycast(origin, direction, maxDistance = 10.0, filterGroups = null) {
        if (!this.isInitialized || this.isMockPhysics) return null;
        
        try {
            const ray = new this.RAPIER.Ray(origin, direction);
            const hit = this.world.castRay(ray, maxDistance, true, filterGroups);
            
            if (hit) {
                const collider = hit.collider;
                const point = ray.pointAt(hit.toi);
                const normal = hit.normal;
                
                // Find corresponding Three.js mesh
                let threeMesh = null;
                for (const [meshId, physicsObj] of this.rigidBodies) {
                    if (physicsObj.collider === collider) {
                        threeMesh = physicsObj.threeMesh;
                        break;
                    }
                }
                
                if (!threeMesh) {
                    for (const [meshId, physicsObj] of this.colliders) {
                        if (physicsObj.collider === collider) {
                            threeMesh = physicsObj.threeMesh;
                            break;
                        }
                    }
                }
                
                return {
                    distance: hit.toi,
                    point: new THREE.Vector3(point.x, point.y, point.z),
                    normal: new THREE.Vector3(normal.x, normal.y, normal.z),
                    collider,
                    threeMesh
                };
            }
        } catch (error) {
            console.warn('Raycast failed:', error);
        }
        
        return null;
    }
    
    // Create physics constraint/joint for grabbing objects
    createGrabConstraint(playerMeshId, objectMeshId, attachPoint) {
        if (this.isMockPhysics) {
            // Return a mock constraint
            return { _isMock: true, playerMeshId, objectMeshId };
        }
        
        const playerPhysics = this.rigidBodies.get(playerMeshId);
        const objectPhysics = this.rigidBodies.get(objectMeshId);
        
        if (!playerPhysics || !objectPhysics) return null;
        
        try {
            // Create a point-to-point joint
            const anchor1 = new this.RAPIER.Vector3(attachPoint.x, attachPoint.y, attachPoint.z);
            const anchor2 = new this.RAPIER.Vector3(0, 0, 0);
            
            const joint = this.RAPIER.JointDesc.spherical(anchor1, anchor2);
            joint.setContactsEnabled(false);
            
            const impulseJoint = this.world.createImpulseJoint(
                joint,
                playerPhysics.rigidBody,
                objectPhysics.rigidBody,
                true
            );
            
            return impulseJoint;
        } catch (error) {
            console.warn('Failed to create grab constraint:', error);
            return null;
        }
    }
    
    // Remove constraint
    removeConstraint(joint) {
        if (!joint) return;
        
        if (joint._isMock) {
            // Mock constraint cleanup
            return;
        }
        
        try {
            this.world.removeImpulseJoint(joint, true);
        } catch (error) {
            console.warn('Failed to remove constraint:', error);
        }
    }
    
    // Collision event handling
    onCollision(callback) {
        this.collisionCallbacks.set(this.collisionCallbacks.size, callback);
    }
    
    processCollisionEvents() {
        if (!this.eventQueue || this.isMockPhysics) return;
        
        try {
            this.eventQueue.drainCollisionEvents((handle1, handle2, started) => {
                const collider1 = this.world.getCollider(handle1);
                const collider2 = this.world.getCollider(handle2);
                
                if (collider1 && collider2) {
                    // Find corresponding meshes
                    let mesh1 = null, mesh2 = null;
                    
                    for (const [meshId, physicsObj] of [...this.rigidBodies, ...this.colliders]) {
                        if (physicsObj.collider === collider1) mesh1 = physicsObj.threeMesh;
                        if (physicsObj.collider === collider2) mesh2 = physicsObj.threeMesh;
                    }
                    
                    if (mesh1 && mesh2) {
                        const event = {
                            mesh1,
                            mesh2,
                            started,
                            collider1,
                            collider2
                        };
                        
                        // Call all registered callbacks
                        this.collisionCallbacks.forEach(callback => {
                            try {
                                callback(event);
                            } catch (error) {
                                console.error('Collision callback error:', error);
                            }
                        });
                    }
                }
            });
        } catch (error) {
            console.warn('Failed to process collision events:', error);
        }
    }
    
    // Update physics simulation
    update() {
        if (!this.isInitialized) return;
        
        const now = performance.now();
        const deltaTime = this.lastStepTime ? (now - this.lastStepTime) / 1000 : window.Constants.PHYSICS.TIMESTEP;
        this.lastStepTime = now;
        
        try {
            // Step physics simulation
            if (!this.isMockPhysics) {
                this.world.step(this.eventQueue);
                
                // Process collision events
                this.processCollisionEvents();
            }
            
            // Update Three.js meshes from physics
            this.syncPhysicsToThree();
        } catch (error) {
            console.warn('Physics update failed:', error);
        }
    }
    
    syncPhysicsToThree() {
        // Update dynamic rigid bodies
        for (const [meshId, physicsObj] of this.rigidBodies) {
            if (physicsObj.type === 'dynamic') {
                const { rigidBody, threeMesh } = physicsObj;
                
                if (this.isMockPhysics) {
                    // Mock physics - minimal updates
                    continue;
                }
                
                try {
                    // Get position and rotation from physics
                    const position = rigidBody.translation();
                    const rotation = rigidBody.rotation();
                    
                    // Update Three.js mesh
                    threeMesh.position.set(position.x, position.y, position.z);
                    threeMesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
                    
                    // Clamp velocity to prevent runaway objects
                    this.clampVelocity(meshId);
                } catch (error) {
                    console.warn('Failed to sync physics to Three.js:', error);
                }
            }
        }
    }
    
    // Remove rigid body
    removeRigidBody(threeMesh) {
        const meshId = threeMesh.uuid;
        const physicsObj = this.rigidBodies.get(meshId) || this.colliders.get(meshId);
        
        if (physicsObj) {
            try {
                if (physicsObj.rigidBody && !this.isMockPhysics) {
                    this.world.removeRigidBody(physicsObj.rigidBody);
                }
                if (physicsObj.collider && !this.isMockPhysics) {
                    this.world.removeCollider(physicsObj.collider, true);
                }
                
                this.rigidBodies.delete(meshId);
                this.colliders.delete(meshId);
                this.physicsObjects--;
            } catch (error) {
                console.warn('Failed to remove rigid body:', error);
            }
        }
    }
    
    // Get physics stats
    getStats() {
        return {
            objectCount: this.physicsObjects,
            rigidBodyCount: this.rigidBodies.size,
            colliderCount: this.colliders.size,
            isActive: this.isInitialized,
            isMockPhysics: this.isMockPhysics
        };
    }
    
    // Public API methods
    getRigidBody(meshId) {
        const physicsObj = this.rigidBodies.get(meshId);
        return physicsObj ? physicsObj.rigidBody : null;
    }
    
    getCollider(meshId) {
        const physicsObj = this.rigidBodies.get(meshId) || this.colliders.get(meshId);
        return physicsObj ? physicsObj.collider : null;
    }
    
    // Utility method to get rigid body by ID
    getRigidBody(objectId) {
        try {
            return this.rigidBodies.get(objectId) || null;
        } catch (error) {
            if (!this.isMockPhysics) {
                console.warn(`⚠️ Failed to get rigid body for ${objectId}:`, error);
            }
            return null;
        }
    }
    
    // Clamp velocity to prevent runaway speeds
    clampVelocity(objectId, maxVelocity = 20) {
        try {
            if (this.isMockPhysics) return;
            
            const rigidBody = this.rigidBodies.get(objectId);
            if (!rigidBody) return;
            
            // Check if linvel method exists (it might not in mock physics or different Rapier versions)
            if (typeof rigidBody.linvel !== 'function') {
                return; // Skip velocity clamping if method doesn't exist
            }
            
            const velocity = rigidBody.linvel();
            const speed = Math.sqrt(velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z);
            
            if (speed > maxVelocity) {
                const scale = maxVelocity / speed;
                
                // Check if setLinvel method exists
                if (typeof rigidBody.setLinvel === 'function') {
                    rigidBody.setLinvel({
                        x: velocity.x * scale,
                        y: velocity.y * scale,
                        z: velocity.z * scale
                    }, true);
                }
            }
        } catch (error) {
            // Silently continue if physics operations fail - this prevents spam
            // Only log occasionally to avoid console spam
            if (Math.random() < 0.001) { // Log only 0.1% of failures
                console.warn(`⚠️ Physics velocity clamp failed for ${objectId}:`, error.message);
            }
        }
    }
    
    // Cleanup
    destroy() {
        try {
            if (this.world && !this.isMockPhysics) {
                this.world.free();
            }
            
            this.rigidBodies.clear();
            this.colliders.clear();
            this.collisionCallbacks.clear();
            
            console.log('✅ Physics Manager destroyed');
        } catch (error) {
            console.warn('Error during physics cleanup:', error);
        }
    }
}; 