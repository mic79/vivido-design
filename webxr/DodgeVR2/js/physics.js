/**
 * Physics System for WebXR Zero-G Environment
 * AmmoJS physics world and collision detection
 */

// Global physics world reference
window.PhysicsWorld = null;

/**
 * Initialize AmmoJS and create physics world
 */
function initializePhysics() {
    return new Promise((resolve) => {
        // AmmoJS is loaded asynchronously, wait for it
        if (typeof Ammo === 'undefined') {
            console.error('AmmoJS not loaded yet');
            setTimeout(() => initializePhysics().then(resolve), 100);
            return;
        }

        Ammo().then(function(AmmoLib) {
            window.Ammo = AmmoLib;
            
            // Create collision configuration
            const collisionConfig = new Ammo.btDefaultCollisionConfiguration();
            
            // Create dispatcher
            const dispatcher = new Ammo.btCollisionDispatcher(collisionConfig);
            
            // Create broadphase
            const overlappingPairCache = new Ammo.btDbvtBroadphase();
            
            // Create constraint solver
            const solver = new Ammo.btSequentialImpulseConstraintSolver();
            
            // Create dynamics world
            const dynamicsWorld = new Ammo.btDiscreteDynamicsWorld(
                dispatcher, overlappingPairCache, solver, collisionConfig
            );
            
            // Set zero gravity for space environment
            const gravity = new Ammo.btVector3(0, 0, 0);
            dynamicsWorld.setGravity(gravity);
            Ammo.destroy(gravity);
            
            // Create physics world manager
            window.PhysicsWorld = new PhysicsWorldManager(dynamicsWorld);
            window.ZeroGState.ammoWorld = dynamicsWorld;
            
            DebugUtils.log('PHYSICS', 'AmmoJS physics world initialized with zero gravity');
            DebugUtils.log('PHYSICS', 'Collision Groups: 1=Player(mask:4), 2=Balls(mask:4), 4=Static(mask:-1)');
            DebugUtils.log('PHYSICS', 'Player and balls do NOT collide with each other - only with static surfaces');
            DebugUtils.log('PHYSICS', '🎯 X button shoots new balls, Grip grabs objects, Trigger for thrusters');
            resolve();
        });
    });
}

/**
 * Physics World Manager Class
 */
class PhysicsWorldManager {
    constructor(world) {
        this.world = world;
        this.rigidBodies = [];
        this.shotBalls = []; // Track shot balls for syncing
        this.clock = new THREE.Clock();
        this.transformAux = new Ammo.btTransform();
        this.tempVector = new Ammo.btVector3();
        this.collisionVisualizationEnabled = false;
        
        // Collision statistics
        this.collisionGroups = { 1: 'Player', 2: 'Balls', 4: 'Static' };
        this.bodyGroups = {}; // Track which group each body belongs to
        
        // Performance tracking
        this.lastTime = 0;
        this.frameCount = 0;
        this.fps = 0;
        
        DebugUtils.log('PHYSICS', 'Physics World Manager created');
    }

    /**
     * Add rigid body to physics world
     */
    addRigidBody(body, group = 1, mask = -1) {
        this.world.addRigidBody(body, group, mask);
        this.rigidBodies.push(body);
        this.bodyGroups[this.rigidBodies.length - 1] = group;
        
        const groupName = this.collisionGroups[group] || `Group${group}`;
        DebugUtils.log('PHYSICS', `Added ${groupName} rigid body - Group: ${group}, Mask: ${mask} (total: ${this.rigidBodies.length})`);
    }

    /**
     * Remove rigid body from physics world
     */
    removeRigidBody(body) {
        this.world.removeRigidBody(body);
        const index = this.rigidBodies.indexOf(body);
        if (index > -1) {
            this.rigidBodies.splice(index, 1);
        }
    }

    /**
     * Create static mesh body for environment collision
     */
    createStaticMeshBody(mesh, shape, group = 4, mask = -1) {
        const transform = PhysicsUtils.createTransform(mesh.position, mesh.quaternion);
        
        const motionState = new Ammo.btDefaultMotionState(transform);
        const rbInfo = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, this.tempVector);
        const body = new Ammo.btRigidBody(rbInfo);
        
        // Set static body properties (NOT kinematic - truly static)
        body.setFriction(0.8);
        body.setRestitution(0.3);
        // Do NOT set kinematic flag - let it be truly static
        
        // Add to world with specified collision groups
        this.addRigidBody(body, group, mask);
        
        Ammo.destroy(transform);
        Ammo.destroy(rbInfo);
        
        return body;
    }

    /**
     * Create box shape for collision
     */
    createBoxShape(width, height, depth) {
        const halfExtents = new Ammo.btVector3(width/2, height/2, depth/2);
        const shape = new Ammo.btBoxShape(halfExtents);
        Ammo.destroy(halfExtents);
        return shape;
    }

    /**
     * Create sphere shape for collision
     */
    createSphereShape(radius) {
        return new Ammo.btSphereShape(radius);
    }

    /**
     * Create cylinder shape for collision
     */
    createCylinderShape(radius, height) {
        const halfExtents = new Ammo.btVector3(radius, height/2, radius);
        const shape = new Ammo.btCylinderShape(halfExtents);
        Ammo.destroy(halfExtents);
        return shape;
    }

    /**
     * Create triangle mesh collision shape for complex models
     */
    createTriangleMeshShape(vertices, indices) {
        const trimesh = new Ammo.btTriangleMesh();
        
        if (indices) {
            // Indexed geometry
            for (let i = 0; i < indices.length; i += 3) {
                const i0 = indices[i] * 3;
                const i1 = indices[i + 1] * 3;
                const i2 = indices[i + 2] * 3;
                
                const v0 = new Ammo.btVector3(vertices[i0], vertices[i0 + 1], vertices[i0 + 2]);
                const v1 = new Ammo.btVector3(vertices[i1], vertices[i1 + 1], vertices[i1 + 2]);
                const v2 = new Ammo.btVector3(vertices[i2], vertices[i2 + 1], vertices[i2 + 2]);
                
                trimesh.addTriangle(v0, v1, v2);
                
                Ammo.destroy(v0);
                Ammo.destroy(v1);
                Ammo.destroy(v2);
            }
        } else {
            // Non-indexed geometry
            for (let i = 0; i < vertices.length; i += 9) {
                const v0 = new Ammo.btVector3(vertices[i], vertices[i + 1], vertices[i + 2]);
                const v1 = new Ammo.btVector3(vertices[i + 3], vertices[i + 4], vertices[i + 5]);
                const v2 = new Ammo.btVector3(vertices[i + 6], vertices[i + 7], vertices[i + 8]);
                
                trimesh.addTriangle(v0, v1, v2);
                
                Ammo.destroy(v0);
                Ammo.destroy(v1);
                Ammo.destroy(v2);
            }
        }
        
        return new Ammo.btBvhTriangleMeshShape(trimesh, true);
    }

    /**
     * Create capsule shape for player collision
     */
    createCapsuleShape(radius, height) {
        return new Ammo.btCapsuleShape(radius, height);
    }

    /**
     * Create dynamic rigid body (for balls, player, etc.)
     */
    createDynamicBody(mass, shape, position, rotation, group = 1, mask = -1) {
        const transform = PhysicsUtils.createTransform(position, rotation);
        
        // Calculate inertia
        const localInertia = new Ammo.btVector3(0, 0, 0);
        if (mass > 0) {
            shape.calculateLocalInertia(mass, localInertia);
        }
        
        const motionState = new Ammo.btDefaultMotionState(transform);
        const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
        const body = new Ammo.btRigidBody(rbInfo);
        
        // Zero gravity setup - no gravity force
        body.setGravity(new Ammo.btVector3(0, 0, 0));
        
        // Set damping for realistic space movement
        body.setDamping(0.02, 0.02); // Linear and angular damping
        
        // Add to world with specified collision groups
        this.addRigidBody(body, group, mask);
        
        Ammo.destroy(transform);
        Ammo.destroy(localInertia);
        Ammo.destroy(rbInfo);
        
        return body;
    }

    /**
     * Update physics simulation
     */
    step(deltaTime) {
        if (!this.world) return;
        
        // Debug: Occasionally log when shot balls exist (reduced frequency)
        if (this.shotBalls && this.shotBalls.length > 0 && Math.random() < 0.001) {
            console.log(`⚙️ Physics step running, deltaTime: ${(deltaTime*1000).toFixed(1)}ms, shotBalls: ${this.shotBalls.length}`);
        }
        
        // Cap delta time to prevent physics instability
        const maxDeltaTime = 1/60; // 60fps max
        const clampedDeltaTime = Math.min(deltaTime, maxDeltaTime);
        
        // Step the physics world
        this.world.stepSimulation(clampedDeltaTime, 10, 1/240);
        
        // Debug: Log physics step activity
        if (this.shotBalls && this.shotBalls.length > 0 && Math.random() < 0.01) {
            console.log(`⚙️ Physics step: ${this.shotBalls.length} shot balls to sync`);
        }
        
        // Sync shot balls (if any exist)
        if (this.shotBalls && this.shotBalls.length > 0) {
            for (let i = this.shotBalls.length - 1; i >= 0; i--) {
                const shotBall = this.shotBalls[i];
                if (shotBall.entity && shotBall.entity.parentNode && shotBall.body) {
                    // Get current velocity to check if body is moving
                    const velocity = this.getVelocity(shotBall.body);
                    const speed = velocity.length();
                    
                    // Store old position for comparison
                    const oldPos = shotBall.entity.object3D.position.clone();
                    
                    // Sync position
                    this.syncToThreeJS(shotBall.body, shotBall.entity.object3D);
                    
                    // Debug: Log detailed sync info very occasionally
                    if (Math.random() < 0.0005) {
                        const newPos = shotBall.entity.object3D.position;
                        const moved = oldPos.distanceTo(newPos);
                        
                        // Get physics body position directly
                        const physicsTransform = new Ammo.btTransform();
                        shotBall.body.getMotionState().getWorldTransform(physicsTransform);
                        const physicsOrigin = physicsTransform.getOrigin();
                        
                        console.log(`📍 Shot ball sync: speed=${speed.toFixed(2)}, moved=${moved.toFixed(3)}`);
                        console.log(`   Visual pos: [${newPos.x.toFixed(1)}, ${newPos.y.toFixed(1)}, ${newPos.z.toFixed(1)}]`);
                        console.log(`   Physics pos: [${physicsOrigin.x().toFixed(1)}, ${physicsOrigin.y().toFixed(1)}, ${physicsOrigin.z().toFixed(1)}]`);
                        
                        Ammo.destroy(physicsTransform);
                    }
                } else {
                    // Remove invalid entries
                    this.shotBalls.splice(i, 1);
                }
            }
        }
        
        // Minimal physics debug (only show if many bodies are moving)
        if (Math.random() < 0.001) {
            let movingBodies = 0;
            for (let body of this.rigidBodies) {
                if (body) {
                    const vel = this.getVelocity(body);
                    if (vel.length() > 0.1) {
                        movingBodies++;
                    }
                }
            }
            if (movingBodies > 3) {
                console.log(`Physics: ${movingBodies} moving bodies`);
            }
        }
        
        // Update performance metrics
        this.frameCount++;
        const currentTime = performance.now();
        if (currentTime - this.lastTime >= 1000) {
            this.fps = Math.round(this.frameCount * 1000 / (currentTime - this.lastTime));
            this.frameCount = 0;
            this.lastTime = currentTime;
            
            // Update debug display
            DebugUtils.updatePhysicsDebug({
                bodyCount: this.rigidBodies.length,
                fps: this.fps
            });
        }
    }

    /**
     * Sync rigid body transform to Three.js object
     */
    syncToThreeJS(body, threeObject) {
        const motionState = body.getMotionState();
        if (motionState) {
            motionState.getWorldTransform(this.transformAux);
            const origin = this.transformAux.getOrigin();
            const rotation = this.transformAux.getRotation();
            
            threeObject.position.set(origin.x(), origin.y(), origin.z());
            threeObject.quaternion.set(rotation.x(), rotation.y(), rotation.z(), rotation.w());
        }
    }

    /**
     * Apply force to rigid body
     */
    applyForce(body, force, relativePosition) {
        const ammoForce = Vector3Utils.toAmmo(force);
        
        if (relativePosition) {
            const ammoRelPos = Vector3Utils.toAmmo(relativePosition);
            body.applyForce(ammoForce, ammoRelPos);
            Ammo.destroy(ammoRelPos);
        } else {
            body.applyCentralForce(ammoForce);
        }
        
        Ammo.destroy(ammoForce);
    }

    /**
     * Apply impulse to rigid body
     */
    applyImpulse(body, impulse, relativePosition) {
        const ammoImpulse = Vector3Utils.toAmmo(impulse);
        
        if (relativePosition) {
            const ammoRelPos = Vector3Utils.toAmmo(relativePosition);
            body.applyImpulse(ammoImpulse, ammoRelPos);
            Ammo.destroy(ammoRelPos);
        } else {
            body.applyCentralImpulse(ammoImpulse);
        }
        
        Ammo.destroy(ammoImpulse);
    }

    /**
     * Get rigid body velocity
     */
    getVelocity(body) {
        const velocity = body.getLinearVelocity();
        return Vector3Utils.fromAmmo(velocity);
    }

    /**
     * Set rigid body velocity
     */
    setVelocity(body, velocity) {
        const ammoVelocity = Vector3Utils.toAmmo(velocity);
        body.setLinearVelocity(ammoVelocity);
        Ammo.destroy(ammoVelocity);
    }

    /**
     * Get rigid body angular velocity
     */
    getAngularVelocity(body) {
        const angularVelocity = body.getAngularVelocity();
        return Vector3Utils.fromAmmo(angularVelocity);
    }

    /**
     * Set rigid body angular velocity
     */
    setAngularVelocity(body, angularVelocity) {
        const ammoAngularVelocity = Vector3Utils.toAmmo(angularVelocity);
        body.setAngularVelocity(ammoAngularVelocity);
        Ammo.destroy(ammoAngularVelocity);
    }

    /**
     * Simple collision check using distance to rigid bodies
     */
    raycast(startPos, endPos) {
        // Simplified collision detection using distance checks
        const direction = new THREE.Vector3().subVectors(endPos, startPos);
        const distance = direction.length();
        
        // Check against all rigid bodies for intersection
        for (let body of this.rigidBodies) {
            if (!body) continue;
            
            // Get body transform
            const transform = new Ammo.btTransform();
            body.getMotionState().getWorldTransform(transform);
            const origin = transform.getOrigin();
            
            const bodyPos = new THREE.Vector3(origin.x(), origin.y(), origin.z());
            const distanceToBody = startPos.distanceTo(bodyPos);
            
            // Simple sphere approximation for collision
            const approximateRadius = 0.5; // Rough estimate for collision size
            
            if (distanceToBody <= distance + approximateRadius) {
                Ammo.destroy(transform);
                return {
                    hit: true,
                    point: bodyPos,
                    normal: new THREE.Vector3(0, 1, 0),
                    body: body
                };
            }
            
            Ammo.destroy(transform);
        }
        
        return { hit: false };
    }

    /**
     * Check sphere collision at position using raycast approximation
     */
    sphereCollision(position, radius) {
        // Use multiple raycasts to approximate sphere collision
        const directions = [
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(-1, 0, 0),
            new THREE.Vector3(0, 1, 0),
            new THREE.Vector3(0, -1, 0),
            new THREE.Vector3(0, 0, 1),
            new THREE.Vector3(0, 0, -1)
        ];
        
        for (let direction of directions) {
            const startPos = position.clone();
            const endPos = position.clone().add(direction.multiplyScalar(radius));
            
            const rayResult = this.raycast(startPos, endPos);
            if (rayResult.hit) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * Toggle collision visualization
     */
    toggleCollisionVisualization() {
        this.collisionVisualizationEnabled = !this.collisionVisualizationEnabled;
        DebugUtils.log('PHYSICS', 'Collision visualization:', this.collisionVisualizationEnabled);
        
        // Notify all physics objects about visualization change
        document.dispatchEvent(new CustomEvent('collision-visualization-changed', {
            detail: { enabled: this.collisionVisualizationEnabled }
        }));
    }

    /**
     * Cleanup physics world
     */
    destroy() {
        if (this.world) {
            // Remove all rigid bodies
            for (let i = this.rigidBodies.length - 1; i >= 0; i--) {
                this.world.removeRigidBody(this.rigidBodies[i]);
                Ammo.destroy(this.rigidBodies[i]);
            }
            this.rigidBodies = [];
            
            // Destroy world
            Ammo.destroy(this.world);
            this.world = null;
        }
        
        // Destroy utility objects
        if (this.transformAux) {
            Ammo.destroy(this.transformAux);
        }
        if (this.tempVector) {
            Ammo.destroy(this.tempVector);
        }
    }
}

/**
 * A-Frame Physics World Component
 */
AFRAME.registerComponent('physics-world', {
    init: function() {
        DebugUtils.log('PHYSICS', 'Initializing A-Frame physics world component');
        
        // Initialize physics when Ammo is ready
        initializePhysics().then(() => {
            this.setupPhysicsLoop();
        });
    },

    setupPhysicsLoop: function() {
        this.lastTime = 0;
        DebugUtils.log('PHYSICS', 'Physics update loop started');
    },
    
    tick: function(time) {
        if (!window.PhysicsWorld) return;
        
        const deltaTime = Math.min((time - this.lastTime) / 1000, 0.033); // Cap at 30fps
        
        if (deltaTime > 0) {
            window.PhysicsWorld.step(deltaTime);
        }
        
        this.lastTime = time;
    },

    remove: function() {
        if (window.PhysicsWorld) {
            window.PhysicsWorld.destroy();
            window.PhysicsWorld = null;
        }
    }
});

/**
 * FPS Counter Component
 */
AFRAME.registerComponent('fps-counter', {
    init: function() {
        this.frameCount = 0;
        this.lastTime = performance.now();
        this.fps = 0;
        this.updateInterval = 500; // Update every 500ms
        this.lastUpdate = 0;
    },

    tick: function() {
        const currentTime = performance.now();
        this.frameCount++;

        if (currentTime - this.lastUpdate >= this.updateInterval) {
            const deltaTime = currentTime - this.lastTime;
            this.fps = Math.round((this.frameCount * 1000) / deltaTime);

            // Update version display with FPS
            const versionDisplay = document.querySelector('#version-display');
            if (versionDisplay) {
                versionDisplay.setAttribute('text', 'value', `Zero-G v2.0 AmmoJS | ${this.fps} FPS`);
            }

            this.frameCount = 0;
            this.lastTime = currentTime;
            this.lastUpdate = currentTime;
        }
    }
});

// Initialize physics when page loads
document.addEventListener('DOMContentLoaded', function() {
    DebugUtils.log('PHYSICS', 'Physics module loaded, waiting for A-Frame scene');
}); 