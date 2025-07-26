/**
 * Ball Physics System for WebXR Zero-G Environment
 * Grabbable balls with AmmoJS physics and realistic throwing mechanics
 */

AFRAME.registerComponent('grabbable-ball', {
    schema: {
        player: { type: 'string', default: 'player' },
        mass: { type: 'number', default: 1.0 },
        radius: { type: 'number', default: 0.1 },
        restitution: { type: 'number', default: 0.9 },
        friction: { type: 'number', default: 0.1 }
    },

    init: function() {
        DebugUtils.log('BALL', `Initializing grabbable ball for ${this.data.player}`);
        
        // Wait for physics world
        this.waitForPhysics();
        
        // Ball state
        this.isGrabbed = false;
        this.grabbingHand = null;
        this.physicsBody = null;
        
        // Throwing mechanics
        this.velocityHistory = [];
        this.maxHistorySize = 5;
        this.lastHandPosition = new THREE.Vector3();
        this.lastHandRotation = new THREE.Quaternion();
        this.lastTime = 0;
        this.lastReleaseTime = 0;
        
        // Magnus effect (spin-based curve)
        this.enableMagnusEffect = true;
        this.magnusStrength = 0.008;
        
        // Store initial position for reset
        this.initialPosition = new THREE.Vector3();
        this.el.object3D.getWorldPosition(this.initialPosition);
        
        // Track creation time for shot ball handling
        this.creationTime = performance.now();
        
        DebugUtils.log('BALL', `Ball initialized at position:`, this.initialPosition);
    },

    waitForPhysics: function() {
        if (!window.PhysicsWorld) {
            console.log(`Ball waiting for physics world...`);
            setTimeout(() => this.waitForPhysics(), 100);
            return;
        }
        console.log(`Ball physics world ready, setting up physics...`);
        this.setupPhysics();
    },

    setupPhysics: function() {
        if (!window.PhysicsWorld) {
            DebugUtils.log('BALL', 'Physics world not ready, retrying...');
            setTimeout(() => this.setupPhysics(), 100);
            return;
        }

        // Create sphere shape
        const shape = window.PhysicsWorld.createSphereShape(this.data.radius);
        
        // Get ball position
        const position = new THREE.Vector3();
        this.el.object3D.getWorldPosition(position);
        
        // Create dynamic rigid body with proper collision groups
        // Group 2: Balls, Mask: 1 (static surfaces only - no player collision)
        this.physicsBody = window.PhysicsWorld.createDynamicBody(this.data.mass, shape, position, null, 2, 1);
        
        // ENSURE ball starts as dynamic (not kinematic)
        const initialFlags = this.physicsBody.getCollisionFlags();
        if (initialFlags & 2) { // Remove kinematic if present
            this.physicsBody.setCollisionFlags(initialFlags & (~2));
            DebugUtils.log('BALL', `Removed initial kinematic flag from ball`);
        }
        
        // Set ball properties
        this.physicsBody.setFriction(this.data.friction);
        this.physicsBody.setRestitution(this.data.restitution);
        this.physicsBody.setDamping(0.001, 0.001); // Very low damping for zero gravity
        
        // Force activation to ensure physics simulation
        this.physicsBody.forceActivationState(1); // ACTIVE_TAG
        this.physicsBody.activate(true);
        
        // Store reference for cleanup
        this.el.physicsBody = this.physicsBody;
        
        // Add collision detection for debugging
        this.addCollisionListeners();
        
        // Verify physics body creation (only log errors)
        try {
            const collisionFlags = this.physicsBody.getCollisionFlags();
            if (collisionFlags !== 0) {
                console.log(`Ball collision flags warning: ${collisionFlags} (should be 0)`);
            }
        } catch (error) {
            console.log(`Ball physics setup error: ${error.message}`);
        }
        
        // Mark component as ready
        this.physicsReady = true;
        console.log(`Ball physics setup complete: this.physicsBody=${!!this.physicsBody}, this.el.physicsBody=${!!this.el.physicsBody}`);
        
        // Create wireframe for debugging
        this.createWireframe();
    },
    
    createWireframe: function() {
        // Create wireframe visualization of physics collision
        const wireframe = document.createElement('a-sphere');
        wireframe.setAttribute('radius', this.data.radius);
        wireframe.setAttribute('material', 'wireframe: true; color: #00ff00; opacity: 0.3; transparent: true');
        wireframe.setAttribute('visible', 'false');
        wireframe.classList.add('physics-wireframe');
        
        this.el.appendChild(wireframe);
    },
    
    addCollisionListeners: function() {
        // Note: AmmoJS doesn't have built-in collision events like CannonJS
        // We'll implement collision detection in the tick method
        this.lastCollisionCheck = 0;
        this.collisionCheckInterval = 100; // Check every 100ms
    },

    onGrab: function(hand) {
        if (this.isGrabbed) return;
        
        // Prevent immediate re-grab after release (200ms cooldown)
        const currentTime = performance.now();
        if (currentTime - this.lastReleaseTime < 200) {
            DebugUtils.log('BALL', 'Grab blocked - still in release cooldown');
            return;
        }
        
        this.isGrabbed = true;
        this.grabbingHand = hand;
        
        DebugUtils.log('BALL', `Ball grabbed by ${hand.id}`);
        
        // Stop physics simulation while grabbed
        if (this.physicsBody) {
            window.PhysicsWorld.setVelocity(this.physicsBody, new THREE.Vector3(0, 0, 0));
            window.PhysicsWorld.setAngularVelocity(this.physicsBody, new THREE.Vector3(0, 0, 0));
        }
        
        // Initialize hand tracking
        this.velocityHistory = [];
        this.lastHandPosition.copy(ControllerUtils.getWorldPosition(hand));
        this.lastHandRotation.copy(ControllerUtils.getWorldQuaternion(hand));
        this.lastTime = performance.now();
        
        // Visual feedback
        this.setGrabbedAppearance(true);
        
        // Haptic feedback
        ControllerUtils.playHaptic(hand, 0.7, 150);
    },

        onRelease: function(throwVelocity) {
        if (!this.isGrabbed) {
            DebugUtils.log('BALL', 'Release called but ball not grabbed');
            return;
        }

        DebugUtils.log('BALL', 'Ball release initiated');

        // Calculate final throw velocity from hand movement history
        let finalVelocity = new THREE.Vector3(0, 0, 0);

                if (this.velocityHistory.length > 0) {
            finalVelocity = ZeroGMath.calculateThrowVelocity(this.velocityHistory, 1.5);
        } else if (throwVelocity && throwVelocity.length() > 0) {
            finalVelocity = throwVelocity.clone();
        } 
        
        // Only apply minimum velocity for truly stationary releases (< 0.1 m/s)
        if (finalVelocity.length() < 0.1) {
            // Very gentle release - just drop the ball
            finalVelocity = new THREE.Vector3(0, -0.5, 0); // Gentle downward drop
        }
        
        console.log(`🏀 Ball thrown with velocity: ${finalVelocity.length().toFixed(1)} m/s`);
        
                        // Apply velocity to physics body - SIMPLIFIED AND ROBUST
        if (this.physicsBody) {
            try {
                // Ensure ball is dynamic (not kinematic)
                const currentFlags = this.physicsBody.getCollisionFlags();
                if (currentFlags & 2) {
                    this.physicsBody.setCollisionFlags(currentFlags & (~2));
                }

                // Position the physics body at visual position
                const currentPos = new THREE.Vector3();
                this.el.object3D.getWorldPosition(currentPos);
                PhysicsUtils.setBodyTransform(this.physicsBody, currentPos, this.el.object3D.quaternion);

                // Apply velocity
                window.PhysicsWorld.setVelocity(this.physicsBody, finalVelocity);
                this.physicsBody.forceActivationState(1);
                this.physicsBody.activate(true);

                // Verify and re-apply velocity if needed (multiple attempts)
                let attempts = 0;
                const verifyVelocity = () => {
                    attempts++;
                    const verifyVel = window.PhysicsWorld.getVelocity(this.physicsBody);
                    if (verifyVel.length() < 2.0 && attempts < 3) {
                        console.log(`🔄 Ball velocity retry ${attempts}: ${verifyVel.length().toFixed(2)} m/s -> ${finalVelocity.length().toFixed(2)} m/s`);
                        window.PhysicsWorld.setVelocity(this.physicsBody, finalVelocity);
                        this.physicsBody.activate(true);
                        setTimeout(verifyVelocity, 30);
                    } else if (attempts >= 3 && verifyVel.length() < 2.0) {
                        console.log(`❌ Ball velocity failed after 3 attempts: ${verifyVel.length().toFixed(2)} m/s`);
                    } else {
                        console.log(`✅ Ball velocity confirmed: ${verifyVel.length().toFixed(2)} m/s`);
                    }
                };
                setTimeout(verifyVelocity, 50);

                // Apply spin
                try {
                    const angularVelocity = this.calculateSpinFromHandRotation();
                    if (angularVelocity.length() > 0) {
                        window.PhysicsWorld.setAngularVelocity(this.physicsBody, angularVelocity);
                    }
                } catch (spinError) {
                    // Skip spin if it fails
                }

            } catch (error) {
                console.log(`Ball physics error: ${error.message}`);
            }
        } else {
            DebugUtils.log('BALL', `❌ NO PHYSICS BODY found for ball release!`);
        }
        
        // Reset state - CRITICAL: Do this FIRST to prevent re-grabbing
        this.isGrabbed = false;
        const releasingHand = this.grabbingHand;
        this.grabbingHand = null;
        this.velocityHistory = [];
        this.lastHandPosition = new THREE.Vector3();
        this.lastHandRotation = new THREE.Quaternion();
        this.lastTime = 0;
        
        // Visual feedback
        this.setGrabbedAppearance(false);
        
        // Light haptic feedback for release
        if (releasingHand) {
            ControllerUtils.playHaptic(releasingHand, 0.2, 50);
        }
        
        // Set release cooldown to prevent immediate re-grab
        this.lastReleaseTime = performance.now();
        
        // Sync visual position with physics body
        if (this.physicsBody) {
            window.PhysicsWorld.syncToThreeJS(this.physicsBody, this.el.object3D);
        }
    },

    calculateSpinFromHandRotation: function() {
        if (!this.grabbingHand || !this.lastHandRotation) {
            return new THREE.Vector3(0, 0, 0);
        }
        
        try {
            const currentRotation = ControllerUtils.getWorldQuaternion(this.grabbingHand);
            
            // Calculate rotation difference
            const deltaRotation = new THREE.Quaternion().multiplyQuaternions(
                currentRotation,
                this.lastHandRotation.clone().invert()
            );
            
            // Convert to angular velocity
            const angle = 2 * Math.acos(Math.abs(deltaRotation.w));
            if (angle > 0.0001) {
                const axis = new THREE.Vector3(deltaRotation.x, deltaRotation.y, deltaRotation.z).normalize();
                const spin = axis.multiplyScalar(angle * 40);
                return spin;
            }
            
        } catch (error) {
            // Silent failure
        }
        
        return new THREE.Vector3(0, 0, 0);
    },

    setGrabbedAppearance: function(grabbed) {
        const material = this.el.getAttribute('material') || {};
        
        if (grabbed) {
            // Brighten when grabbed
            this.el.setAttribute('material', {
                ...material,
                emissiveIntensity: (material.emissiveIntensity || 1.5) + 0.5
            });
        } else {
            // Restore original intensity
            this.el.setAttribute('material', {
                ...material,
                emissiveIntensity: material.originalEmissiveIntensity || 1.5
            });
        }
    },

    updateHandTracking: function() {
        if (!this.isGrabbed || !this.grabbingHand) return;
        
        const currentTime = performance.now();
        const currentHandPosition = ControllerUtils.getWorldPosition(this.grabbingHand);
        const currentHandRotation = ControllerUtils.getWorldQuaternion(this.grabbingHand);
        
        // Update ball position to follow hand
        this.el.object3D.position.copy(currentHandPosition);
        this.el.object3D.quaternion.copy(currentHandRotation);
        
        // When grabbed, disable physics collisions with player to prevent affecting player movement
        if (this.physicsBody) {
            // Make the ball kinematic (doesn't respond to forces) when grabbed
            this.physicsBody.setCollisionFlags(this.physicsBody.getCollisionFlags() | 2); // KINEMATIC_OBJECT
            PhysicsUtils.setBodyTransform(this.physicsBody, currentHandPosition, currentHandRotation);
            window.PhysicsWorld.setVelocity(this.physicsBody, new THREE.Vector3(0, 0, 0));
            window.PhysicsWorld.setAngularVelocity(this.physicsBody, new THREE.Vector3(0, 0, 0));
        }
        
        // Track velocity for throwing
        if (this.lastTime > 0) {
            const deltaTime = Math.max((currentTime - this.lastTime) / 1000, 0.001);
            const displacement = new THREE.Vector3().subVectors(currentHandPosition, this.lastHandPosition);
            const velocity = displacement.divideScalar(deltaTime);
            
            // Track even small movements to capture all hand motion
            if (velocity.length() > 0.005) { // More sensitive threshold
                this.velocityHistory.push(velocity.clone());
                if (this.velocityHistory.length > this.maxHistorySize) {
                    this.velocityHistory.shift();
                }
                
                // Debug velocity tracking occasionally
                if (Math.random() < 0.01) {
                    DebugUtils.log('BALL', `Hand velocity tracked: ${velocity.length().toFixed(3)} m/s, history: ${this.velocityHistory.length}`);
                }
            }
        }
        
        // Store for next frame
        this.lastHandPosition.copy(currentHandPosition);
        this.lastHandRotation.copy(currentHandRotation);
        this.lastTime = currentTime;
    },

    updatePhysics: function() {
        if (!this.physicsBody) return;
        
        if (this.isGrabbed) {
            DebugUtils.log('BALL', 'updatePhysics called but ball is grabbed - should not sync');
            return;
        }
        
        // CRITICAL: Don't sync for shot balls immediately after creation
        const isShotBall = this.el.dataset.shotBall === 'true';
        const timeSinceCreation = performance.now() - (this.creationTime || 0);
        
        if (!isShotBall || timeSinceCreation > 1000) {
            // Sync visual position with physics (but not for fresh shot balls)
            window.PhysicsWorld.syncToThreeJS(this.physicsBody, this.el.object3D);
        }
        
        // Get current velocities
        const velocity = window.PhysicsWorld.getVelocity(this.physicsBody);
        const angularVelocity = window.PhysicsWorld.getAngularVelocity(this.physicsBody);
        
        // Only log errors for shot balls
        if (isShotBall && velocity.length() < 5.0 && Math.random() < 0.01) {
            DebugUtils.log('BALL', `❌ Shot ball velocity too low: ${velocity.length().toFixed(1)} m/s`);
        }
        
        // Skip damping and Magnus effect for shot balls (let them fly free)
        if (!isShotBall) {
            // Apply Magnus effect for spinning balls
            if (this.enableMagnusEffect && velocity.length() > 0.1) {
                this.applyMagnusEffect();
            }
            
            // Apply very minimal damping only for extremely slow balls
            if (velocity.length() < 0.2 && angularVelocity.length() < 0.5) {
                velocity.multiplyScalar(0.998); // Very light damping
                angularVelocity.multiplyScalar(0.998);
                window.PhysicsWorld.setVelocity(this.physicsBody, velocity);
                window.PhysicsWorld.setAngularVelocity(this.physicsBody, angularVelocity);
            }
        }
        
        // Skip collision detection for shot balls (let them fly uninterrupted)
        if (!isShotBall) {
            this.checkCollisions();
        }
        
        // Only log if ball is moving very fast
        if (velocity.length() > 10.0 && Math.random() < 0.01) {
            console.log(`Fast ball: ${velocity.length().toFixed(1)} m/s`);
        }
    },

    applyMagnusEffect: function() {
        const velocity = window.PhysicsWorld.getVelocity(this.physicsBody);
        const angularVelocity = window.PhysicsWorld.getAngularVelocity(this.physicsBody);
        
        const speed = velocity.length();
        const spin = angularVelocity.length();
        
        // Only apply Magnus effect if ball is moving and spinning
        if (speed > 0.5 && spin > 0.1) {
            // Calculate Magnus force (perpendicular to both velocity and spin)
            const magnusForce = new THREE.Vector3().crossVectors(angularVelocity, velocity);
            magnusForce.multiplyScalar(this.magnusStrength);
            
            // Apply as acceleration
            const acceleration = magnusForce.multiplyScalar(1/60); // Assume 60fps
            const newVelocity = velocity.add(acceleration);
            
            window.PhysicsWorld.setVelocity(this.physicsBody, newVelocity);
            
            // Occasional debug info
            if (Math.random() < 0.01) {
                DebugUtils.log('BALL', `Magnus effect - Speed: ${speed.toFixed(2)}, Spin: ${spin.toFixed(2)}`);
            }
        }
    },
    
    checkCollisions: function() {
        const currentTime = performance.now();
        if (currentTime - this.lastCollisionCheck < this.collisionCheckInterval) return;
        
        this.lastCollisionCheck = currentTime;
        
        if (!this.physicsBody || this.isGrabbed) return;
        
        // Get ball position
        const ballPos = new THREE.Vector3();
        this.el.object3D.getWorldPosition(ballPos);
        
        // Check collision with physics world using simplified sphere collision
        const collisionResult = window.PhysicsWorld.sphereCollision(ballPos, this.data.radius);
        
        if (collisionResult) {
            // Simple bounce effect
            const velocity = window.PhysicsWorld.getVelocity(this.physicsBody);
            if (velocity.length() > 0.5) {
                velocity.multiplyScalar(0.8);
                window.PhysicsWorld.setVelocity(this.physicsBody, velocity);
            }
        }
    },

    resetPosition: function() {
        DebugUtils.log('BALL', `Resetting ball to initial position:`, this.initialPosition);
        
        // Reset visual position
        this.el.object3D.position.copy(this.initialPosition);
        this.el.object3D.quaternion.set(0, 0, 0, 1);
        
        // Reset physics
        if (this.physicsBody) {
            PhysicsUtils.setBodyTransform(this.physicsBody, this.initialPosition, new THREE.Quaternion());
            window.PhysicsWorld.setVelocity(this.physicsBody, new THREE.Vector3(0, 0, 0));
            window.PhysicsWorld.setAngularVelocity(this.physicsBody, new THREE.Vector3(0, 0, 0));
        }
        
        // Clear state
        this.isGrabbed = false;
        this.grabbingHand = null;
        this.velocityHistory = [];
        this.setGrabbedAppearance(false);
    },

    tick: function() {
        // Shot balls should never be grabbed and always use physics
        if (this.el.dataset.shotBall === 'true') {
            this.isGrabbed = false;
            this.grabbingHand = null;
            this.updatePhysics();
            return;
        }
        
        // Normal balls: check grab state
        if (this.isGrabbed && this.grabbingHand) {
            this.updateHandTracking();
        } else {
            this.updatePhysics();
            
            // Minimal state checking
            if (Math.random() < 0.001 && this.isGrabbed && !this.grabbingHand) {
                console.log('Ball state error: grabbed but no hand');
            }
        }
    },

    remove: function() {
        // Clean up physics body
        if (this.physicsBody && window.PhysicsWorld) {
            window.PhysicsWorld.removeRigidBody(this.physicsBody);
            Ammo.destroy(this.physicsBody);
        }
        
        DebugUtils.log('BALL', `Ball component removed for ${this.data.player}`);
    }
});

/**
 * Ball Manager Component
 * Manages multiple balls and their interactions
 */
AFRAME.registerComponent('ball-manager', {
    init: function() {
        this.balls = [];
        this.lastCollisionCheck = 0;
        this.collisionCheckInterval = 100; // Check every 100ms
        
        // Find all balls in scene
        this.el.sceneEl.addEventListener('loaded', () => {
            this.findBalls();
            this.setupCollisionDetection();
        });
        
        DebugUtils.log('BALL', 'Ball manager initialized');
    },

    findBalls: function() {
        const ballElements = document.querySelectorAll('[grabbable-ball]');
        this.balls = Array.from(ballElements).map(el => ({
            element: el,
            component: el.components['grabbable-ball'],
            physicsBody: el.physicsBody
        }));
        
        DebugUtils.log('BALL', `Found ${this.balls.length} balls in scene`);
    },

    setupCollisionDetection: function() {
        // Set up collision callbacks for ball-to-surface impacts
        this.balls.forEach(ball => {
            if (ball.physicsBody) {
                // Add collision detection here if needed
                // AmmoJS collision callbacks can be complex, simplified for now
            }
        });
    },

    checkBallCollisions: function() {
        const currentTime = performance.now();
        if (currentTime - this.lastCollisionCheck < this.collisionCheckInterval) {
            return;
        }
        this.lastCollisionCheck = currentTime;
        
        // Check each ball for interesting collisions
        this.balls.forEach(ball => {
            if (!ball.component.isGrabbed && ball.physicsBody) {
                this.checkBallSurfaceCollisions(ball);
            }
        });
    },

    checkBallSurfaceCollisions: function(ball) {
        const velocity = window.PhysicsWorld.getVelocity(ball.physicsBody);
        const speed = velocity.length();
        
        // Only check for significant impacts
        if (speed < 0.5) return;
        
        const ballPosition = new THREE.Vector3();
        ball.element.object3D.getWorldPosition(ballPosition);
        
        // Check collision with surfaces
        const surfaces = document.querySelectorAll('[grab-surface], [environment-surface]');
        surfaces.forEach(surface => {
            const surfacePosition = new THREE.Vector3();
            surface.object3D.getWorldPosition(surfacePosition);
            
            const distance = ballPosition.distanceTo(surfacePosition);
            const minDistance = 0.15; // Ball radius + surface tolerance
            
            if (distance < minDistance && speed > 1.0) {
                this.handleBallSurfaceImpact(ball, surface, speed);
            }
        });
    },

    handleBallSurfaceImpact: function(ball, surface, speed) {
        // Play impact sound effect if available
        this.playImpactSound(ball.element.object3D.position, speed);
        
        // Visual effect (sparks, etc.) could be added here
        
        DebugUtils.log('BALL', `Ball impact with surface at speed: ${speed.toFixed(2)} m/s`);
    },

    playImpactSound: function(position, intensity) {
        // Create or reuse impact sound entity
        let impactSound = document.querySelector('#ball-impact-sound');
        
        if (!impactSound) {
            impactSound = document.createElement('a-entity');
            impactSound.id = 'ball-impact-sound';
            impactSound.setAttribute('sound', {
                src: 'url(https://cdn.aframe.io/basic-guide/audio/backgroundnoise.wav)',
                autoplay: false,
                loop: false,
                volume: 0.5,
                positional: true,
                poolSize: 4
            });
            this.el.sceneEl.appendChild(impactSound);
        }
        
        // Position sound at impact location
        impactSound.object3D.position.copy(position);
        
        // Play sound with volume based on impact intensity
        const volume = Math.min(intensity / 10, 1.0);
        impactSound.setAttribute('sound', 'volume', volume);
        
        if (impactSound.components.sound) {
            impactSound.components.sound.playSound();
        }
    },

    resetAllBalls: function() {
        DebugUtils.log('BALL', 'Resetting all balls to initial positions');
        
        this.balls.forEach(ball => {
            if (ball.component && ball.component.resetPosition) {
                ball.component.resetPosition();
            }
        });
    },

    tick: function() {
        // Periodic collision checking
        this.checkBallCollisions();
        
        // Debug info
        if (window.ZeroGState.debugMode && Math.random() < 0.005) {
            const activeBalls = this.balls.filter(ball => 
                !ball.component.isGrabbed && 
                ball.physicsBody && 
                window.PhysicsWorld.getVelocity(ball.physicsBody).length() > 0.1
            );
            
            if (activeBalls.length > 0) {
                DebugUtils.log('BALL', `${activeBalls.length} balls in motion`);
            }
        }
    }
});

// Auto-attach ball manager to scene
document.addEventListener('DOMContentLoaded', function() {
    const scene = document.querySelector('a-scene');
    if (scene && !scene.hasAttribute('ball-manager')) {
        scene.setAttribute('ball-manager', '');
    }
    
    DebugUtils.log('BALL', 'Ball physics module loaded');
}); 