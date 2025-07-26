/**
 * Utility Functions for WebXR Zero-G Environment
 * Common helper functions used across modules
 */

// Global state management
window.ZeroGState = {
    isMenuVisible: false,
    ammoWorld: null,
    debugMode: false,
    physicsObjects: new Map(),
    grabInstructions: new Map()
};

/**
 * Vector3 utility functions for common operations
 */
window.Vector3Utils = {
    /**
     * Create a THREE.Vector3 from AmmoJS btVector3
     */
    fromAmmo: function(ammoVec) {
        return new THREE.Vector3(ammoVec.x(), ammoVec.y(), ammoVec.z());
    },

    /**
     * Create AmmoJS btVector3 from THREE.Vector3
     */
    toAmmo: function(threeVec) {
        return new Ammo.btVector3(threeVec.x, threeVec.y, threeVec.z);
    },

    /**
     * Copy THREE.Vector3 to AmmoJS btVector3
     */
    copyToAmmo: function(threeVec, ammoVec) {
        ammoVec.setX(threeVec.x);
        ammoVec.setY(threeVec.y);
        ammoVec.setZ(threeVec.z);
    },

    /**
     * Get distance between two objects with 3D positions
     */
    distance: function(pos1, pos2) {
        const dx = pos1.x - pos2.x;
        const dy = pos1.y - pos2.y;
        const dz = pos1.z - pos2.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
};

/**
 * Physics utility functions
 */
window.PhysicsUtils = {
    /**
     * Create AmmoJS transform from position and rotation
     */
    createTransform: function(position, rotation) {
        const transform = new Ammo.btTransform();
        transform.setIdentity();
        
        const origin = new Ammo.btVector3(position.x, position.y, position.z);
        transform.setOrigin(origin);
        
        if (rotation) {
            const quaternion = new Ammo.btQuaternion(
                rotation.x, rotation.y, rotation.z, rotation.w
            );
            transform.setRotation(quaternion);
        }
        
        Ammo.destroy(origin);
        return transform;
    },

    /**
     * Apply transform to rigid body
     */
    setBodyTransform: function(body, position, rotation) {
        const transform = new Ammo.btTransform();
        body.getMotionState().getWorldTransform(transform);
        
        const origin = new Ammo.btVector3(position.x, position.y, position.z);
        transform.setOrigin(origin);
        
        if (rotation) {
            const quaternion = new Ammo.btQuaternion(
                rotation.x, rotation.y, rotation.z, rotation.w
            );
            transform.setRotation(quaternion);
        }
        
        body.getMotionState().setWorldTransform(transform);
        body.setWorldTransform(transform);
        
        Ammo.destroy(origin);
        Ammo.destroy(transform);
    }
};

/**
 * Debug and console utilities
 */
window.DebugUtils = {
    /**
     * Enhanced console logging with timestamps and categories
     */
    log: function(category, message, data) {
        const timestamp = new Date().toISOString().slice(11, 23);
        const prefix = `[${timestamp}] [${category}]`;
        
        if (data !== undefined) {
            console.log(prefix, message, data);
        } else {
            console.log(prefix, message);
        }
    },

    /**
     * Performance monitoring
     */
    startTimer: function(name) {
        if (!window.ZeroGState.debugTimers) {
            window.ZeroGState.debugTimers = new Map();
        }
        window.ZeroGState.debugTimers.set(name, performance.now());
    },

    endTimer: function(name) {
        if (!window.ZeroGState.debugTimers || !window.ZeroGState.debugTimers.has(name)) {
            return;
        }
        const duration = performance.now() - window.ZeroGState.debugTimers.get(name);
        window.ZeroGState.debugTimers.delete(name);
        this.log('PERF', `${name}: ${duration.toFixed(2)}ms`);
        return duration;
    },

    /**
     * Display physics debug info in HUD
     */
    updatePhysicsDebug: function(info) {
        const physicsInfo = document.querySelector('#physics-info');
        if (physicsInfo && window.ZeroGState.debugMode) {
            const text = `Physics: AmmoJS • Bodies: ${info.bodyCount} • FPS: ${info.fps}`;
            physicsInfo.setAttribute('text', 'value', text);
        }
    }
};

/**
 * VR Controller utilities
 */
window.ControllerUtils = {
    /**
     * Check if a controller is connected and available
     */
    isControllerReady: function(hand) {
        return hand && hand.components && 
               (hand.components['oculus-touch-controls'] || 
                hand.components['vive-controls'] || 
                hand.components['windows-motion-controls']);
    },

    /**
     * Get controller gamepad for haptic feedback
     */
    getGamepad: function(hand) {
        if (!this.isControllerReady(hand)) return null;
        
        const trackedControls = hand.components['tracked-controls'];
        return trackedControls && trackedControls.controller ? 
               trackedControls.controller.gamepad : null;
    },

    /**
     * Play haptic feedback on controller
     */
    playHaptic: function(hand, intensity = 0.5, duration = 100) {
        const gamepad = this.getGamepad(hand);
        if (gamepad && gamepad.hapticActuators && gamepad.hapticActuators[0]) {
            gamepad.hapticActuators[0].pulse(intensity, duration).catch(() => {
                // Silently handle haptic errors
            });
        }
    },

    /**
     * Get world position of controller
     */
    getWorldPosition: function(hand) {
        const worldPos = new THREE.Vector3();
        if (hand && hand.object3D) {
            hand.object3D.getWorldPosition(worldPos);
        }
        return worldPos;
    },

    /**
     * Get world quaternion of controller
     */
    getWorldQuaternion: function(hand) {
        const worldQuat = new THREE.Quaternion();
        if (hand && hand.object3D) {
            hand.object3D.getWorldQuaternion(worldQuat);
        }
        return worldQuat;
    }
};

/**
 * Math utilities specific to zero-gravity physics
 */
window.ZeroGMath = {
    /**
     * Calculate throw velocity from hand movement history
     */
    calculateThrowVelocity: function(velocityHistory, multiplier = 1.5) {
        if (velocityHistory.length === 0) {
            return new THREE.Vector3(0, 0, 0);
        }

        let velocity = new THREE.Vector3(0, 0, 0);
        let totalWeight = 0;

        // Weighted average of recent velocities (more recent = higher weight)
        for (let i = 0; i < velocityHistory.length; i++) {
            const weight = (i + 1) / velocityHistory.length;
            const sample = velocityHistory[i];
            velocity.add(sample.clone().multiplyScalar(weight));
            totalWeight += weight;
        }

        velocity.divideScalar(totalWeight);
        velocity.multiplyScalar(multiplier);

        // Cap maximum throw speed
        const maxSpeed = 15;
        if (velocity.length() > maxSpeed) {
            velocity.normalize().multiplyScalar(maxSpeed);
        }

        return velocity;
    },

    /**
     * Apply damping to velocity (frame-rate independent)
     */
    applyDamping: function(velocity, dampingFactor, deltaTime) {
        const frameIndependentDamping = Math.pow(dampingFactor, deltaTime * 60);
        velocity.multiplyScalar(frameIndependentDamping);
        
        // Stop very slow movement
        const minVelocity = 0.01;
        if (velocity.length() < minVelocity) {
            velocity.set(0, 0, 0);
        }
    },

    /**
     * Calculate attraction force for tractor beam effect
     */
    calculateAttractionForce: function(objectPos, targetPos, maxForce = 20) {
        const attractionVector = new THREE.Vector3().subVectors(targetPos, objectPos);
        const distance = attractionVector.length();
        
        if (distance < 0.01) return new THREE.Vector3(0, 0, 0);
        
        attractionVector.normalize();
        
        // Adaptive force based on distance
        let forceMultiplier;
        if (distance > 2.0) {
            forceMultiplier = maxForce;
        } else if (distance > 0.5) {
            forceMultiplier = maxForce * 0.7;
        } else {
            forceMultiplier = maxForce * 0.4;
        }
        
        return attractionVector.multiplyScalar(forceMultiplier);
    }
};

/**
 * Fix for hand-controls clipAction and thumbstick errors
 */
AFRAME.registerComponent('custom-hand-controls', {
    init: function() {
        // Override the problematic animation methods to prevent clipAction errors
        setTimeout(() => {
            const handControls = this.el.components['hand-controls'];
            if (handControls) {
                // Store original methods
                this.originalAnimateGesture = handControls.animateGesture;
                this.originalPlayAnimation = handControls.playAnimation;
                
                // Override with no-op functions
                handControls.animateGesture = function() {};
                handControls.playAnimation = function() {};
                
                DebugUtils.log('UTILS', `Fixed hand-controls clipAction error for ${this.el.id}`);
            }
        }, 100);
    },
    
    remove: function() {
        // Restore original methods if needed
        const handControls = this.el.components['hand-controls'];
        if (handControls && this.originalAnimateGesture && this.originalPlayAnimation) {
            handControls.animateGesture = this.originalAnimateGesture;
            handControls.playAnimation = this.originalPlayAnimation;
        }
    }
});

/**
 * Fast physics-based shot ball component (like original)
 */
AFRAME.registerComponent('shot-ball-physics', {
    init: function() {
        // Wait a frame for position to be set, then create physics body
        setTimeout(() => {
            this.createPhysicsBody();
        }, 10);
        
        // Auto-cleanup after 8 seconds
        setTimeout(() => {
            this.remove();
        }, 8000);
    },
    
    createPhysicsBody: function() {
        if (!window.PhysicsWorld || !Ammo) {
            console.log('❌ Physics world or Ammo not ready');
            return;
        }
        
        const spawnPos = this.el.getAttribute('position');
        const radius = 0.1;
        
        // Create sphere shape directly with Ammo
        const shape = new Ammo.btSphereShape(radius);
        const mass = 1.0;
        
        // Create transform
        const transform = new Ammo.btTransform();
        transform.setIdentity();
        transform.setOrigin(new Ammo.btVector3(spawnPos.x, spawnPos.y, spawnPos.z));
        
        // Create body
        const localInertia = new Ammo.btVector3(0, 0, 0);
        shape.calculateLocalInertia(mass, localInertia);
        
        const motionState = new Ammo.btDefaultMotionState(transform);
        const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
        this.physicsBody = new Ammo.btRigidBody(rbInfo);
        
        // Set physics properties for zero gravity
        this.physicsBody.setGravity(new Ammo.btVector3(0, 0, 0));
        this.physicsBody.setDamping(0.001, 0.001); // Much lower damping for zero gravity
        this.physicsBody.setFriction(0.3);
        this.physicsBody.setRestitution(0.8);
        this.physicsBody.forceActivationState(1); // Always active
        
        // Add to physics world (Group 2: Balls, Mask 4: Static surfaces only) 
        window.PhysicsWorld.world.addRigidBody(this.physicsBody, 2, 4);
        window.PhysicsWorld.rigidBodies.push(this.physicsBody);
        
        // Register for automatic syncing
        if (window.PhysicsWorld && window.PhysicsWorld.shotBalls) {
            window.PhysicsWorld.shotBalls.push({
                entity: this.el,
                body: this.physicsBody
            });
            console.log(`📝 Shot ball registered for sync. Total shot balls: ${window.PhysicsWorld.shotBalls.length}`);
        } else {
            console.log(`❌ Cannot register shot ball: PhysicsWorld.shotBalls not available`);
        }
        
        // Verify physics body position
        const verifyTransform = new Ammo.btTransform();
        this.physicsBody.getMotionState().getWorldTransform(verifyTransform);
        const origin = verifyTransform.getOrigin();
        console.log(`✅ Shot ball physics body created at [${spawnPos.x.toFixed(1)}, ${spawnPos.y.toFixed(1)}, ${spawnPos.z.toFixed(1)}]`);
        console.log(`   Physics body actual pos: [${origin.x().toFixed(1)}, ${origin.y().toFixed(1)}, ${origin.z().toFixed(1)}]`);
        Ammo.destroy(verifyTransform);
        
        // Clean up temp objects
        Ammo.destroy(transform);
        Ammo.destroy(localInertia);
        Ammo.destroy(rbInfo);
    },
    
    tick: function() {
        // Syncing is now handled automatically by physics world
        // No manual syncing needed
    },
    
    remove: function() {
        if (this.physicsBody && window.PhysicsWorld) {
            // Remove from physics world
            window.PhysicsWorld.world.removeRigidBody(this.physicsBody);
            
            // Remove from shot balls sync list
            if (window.PhysicsWorld.shotBalls) {
                const index = window.PhysicsWorld.shotBalls.findIndex(obj => obj.entity === this.el);
                if (index !== -1) {
                    window.PhysicsWorld.shotBalls.splice(index, 1);
                }
            }
            
            // Remove from rigid bodies list
            const rbIndex = window.PhysicsWorld.rigidBodies.indexOf(this.physicsBody);
            if (rbIndex > -1) {
                window.PhysicsWorld.rigidBodies.splice(rbIndex, 1);
            }
        }
        
        // Remove element from scene
        if (this.el.parentNode) {
            this.el.parentNode.removeChild(this.el);
        }
    }
});

/**
 * Initialize utilities when DOM is ready
 */
document.addEventListener('DOMContentLoaded', function() {
    DebugUtils.log('UTILS', 'Zero-G utilities initialized');
    
    // Set up global keyboard shortcuts
    document.addEventListener('keydown', function(event) {
        switch(event.key.toLowerCase()) {
            case 'c':
                // Toggle collision visualization
                window.ZeroGState.debugMode = !window.ZeroGState.debugMode;
                DebugUtils.log('DEBUG', 'Debug mode:', window.ZeroGState.debugMode);
                
                // Notify all physics objects to update collision visualization
                if (window.PhysicsWorld && window.PhysicsWorld.toggleCollisionVisualization) {
                    window.PhysicsWorld.toggleCollisionVisualization();
                }
                break;
                
            case 'd':
                // Toggle physics debug display
                const physicsInfo = document.querySelector('#physics-info');
                if (physicsInfo) {
                    const isVisible = physicsInfo.getAttribute('visible');
                    physicsInfo.setAttribute('visible', !isVisible);
                }
                break;
        }
    });
});

// Export for ES6 modules if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        Vector3Utils,
        PhysicsUtils,
        DebugUtils,
        ControllerUtils,
        ZeroGMath
    };
} 