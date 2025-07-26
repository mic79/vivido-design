/**
 * Zero-G Player Controller for WebXR Environment
 * Handles VR locomotion, collision detection, and physics in zero gravity
 */

AFRAME.registerComponent('zerog-player', {
    schema: {
        mass: { type: 'number', default: 70 }, // kg
        radius: { type: 'number', default: 0.3 }, // Collision radius
        height: { type: 'number', default: 1.8 }, // Player height
        thrusterForce: { type: 'number', default: 0.8 },
        maxSpeed: { type: 'number', default: 8 },
        damping: { type: 'number', default: 0.98 }
    },

    init: function() {
        DebugUtils.log('PLAYER', 'Zero-G Player Controller initializing...');
        
        // Wait for physics world to be ready
        this.waitForPhysics();
        
        // Movement state
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.thrusterStates = { left: false, right: false };
        this.isBraking = false;
        this.grabStates = { left: false, right: false };
        
        // Rotation state
        this.rotationY = 0;
        this.thumbstickRotation = { left: 0, right: 0 };
        
        // Wireframe toggle state
        this.wireframesVisible = false;
        
        // Grab tracking for surface locomotion
        this.leftGrabPosition = null;
        this.rightGrabPosition = null;
        
        // Collision detection
        this.collisionBody = null;
        this.collisionVisualization = null;
        this.showCollisionVisualization = false;
        
        // Hand references
        this.leftHand = null;
        this.rightHand = null;
        this.rig = null;
        this.camera = null;
        
        // Initialize references
        this.el.sceneEl.addEventListener('loaded', () => {
            this.setupReferences();
        });
        
        // Listen for collision visualization toggle
        document.addEventListener('collision-visualization-changed', (event) => {
            this.showCollisionVisualization = event.detail.enabled;
        });
        
        // X button for shooting balls (scene level like reference)
        this.el.sceneEl.addEventListener('xbuttondown', (evt) => {
            DebugUtils.log('PLAYER', 'X button pressed - shooting ball from camera');
            this.shootBallFromCamera();
        });
        
        // Y button for wireframe toggle (with debouncing)
        this.lastYButtonPress = 0;
        this.el.sceneEl.addEventListener('ybuttondown', (evt) => {
            const now = performance.now();
            if (now - this.lastYButtonPress < 500) { // 500ms debounce
                DebugUtils.log('PLAYER', '🚫 Y button: Ignoring rapid double-press');
                return;
            }
            this.lastYButtonPress = now;
            
            DebugUtils.log('PLAYER', 'Y button pressed - toggling wireframes');
            this.toggleWireframes();
        });
        
        // Thumbstick input handled via interaction component
    },

    waitForPhysics: function() {
        if (!window.PhysicsWorld) {
            setTimeout(() => this.waitForPhysics(), 100);
            return;
        }
        this.setupPhysics();
    },

    setupReferences: function() {
        this.leftHand = document.querySelector('#leftHand');
        this.rightHand = document.querySelector('#rightHand');
        this.rig = document.querySelector('#rig');
        this.camera = document.querySelector('[camera]');
        
        DebugUtils.log('PLAYER', 'Player references setup complete');
    },

    setupPhysics: function() {
        if (!window.PhysicsWorld) {
            DebugUtils.log('PLAYER', 'Physics world not ready, retrying...');
            setTimeout(() => this.setupPhysics(), 100);
            return;
        }

        // Create capsule collision shape for player
        const shape = window.PhysicsWorld.createCapsuleShape(this.data.radius, this.data.height - this.data.radius * 2);
        
        // Create rigid body at player position with proper collision groups
        const position = this.rig ? this.rig.object3D.position : new THREE.Vector3(0, 2, 8);
        // Group 1: Player, Mask: 4 (static surfaces only - no ball collision)
        this.collisionBody = window.PhysicsWorld.createDynamicBody(this.data.mass, shape, position, null, 1, 4);
        
        // Set collision properties
        this.collisionBody.setFriction(0.8);
        this.collisionBody.setRestitution(0.1);
        this.collisionBody.setDamping(this.data.damping, this.data.damping);
        
        // Prevent rotation (player should stay upright in zero-g)
        this.collisionBody.setAngularFactor(new Ammo.btVector3(0, 1, 0)); // Only allow Y-axis rotation
        
        // Create collision visualization
        this.createCollisionVisualization();
        
        DebugUtils.log('PLAYER', 'Player physics body created with capsule collision and added to world');
    },

    createCollisionVisualization: function() {
        if (!this.camera) return;
        
        // Create wireframe capsule visualization
        const capsuleGeometry = new THREE.CapsuleGeometry(this.data.radius, this.data.height - this.data.radius * 2, 8, 16);
        const wireframeMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            wireframe: true,
            transparent: true,
            opacity: 0.5
        });
        
        const capsuleMesh = new THREE.Mesh(capsuleGeometry, wireframeMaterial);
        
        // Create A-Frame entity for the visualization
        this.collisionVisualization = document.createElement('a-entity');
        this.collisionVisualization.setAttribute('position', '0 -0.9 0'); // Offset to center on camera
        this.collisionVisualization.object3D.add(capsuleMesh);
        this.collisionVisualization.setAttribute('visible', false);
        
        // Attach to camera so it follows player
        this.camera.appendChild(this.collisionVisualization);
        
        DebugUtils.log('PLAYER', 'Collision visualization created');
    },

    updateCollisionVisualization: function() {
        if (this.collisionVisualization) {
            this.collisionVisualization.setAttribute('visible', this.showCollisionVisualization);
        }
    },

    setThrusterState: function(hand, active) {
        this.thrusterStates[hand] = active;
        DebugUtils.log('PLAYER', `Thruster ${hand}: ${active ? 'ON' : 'OFF'}`);
    },

    setGrabState: function(hand, grabbing) {
        const wasGrabbing = this.grabStates[hand];
        this.grabStates[hand] = grabbing;
        
        DebugUtils.log('PLAYER', `${hand} hand grab state changed: ${wasGrabbing} -> ${grabbing}`);
        
        if (grabbing) {
            // Store the initial grab position for surface pushing
            const handElement = hand === 'left' ? this.leftHand : this.rightHand;
            if (handElement) {
                this[`${hand}GrabPosition`] = ControllerUtils.getWorldPosition(handElement).clone();
                DebugUtils.log('PLAYER', `${hand} hand grabbed surface at position:`, this[`${hand}GrabPosition`].toArray());
            } else {
                DebugUtils.log('PLAYER', `ERROR: ${hand} hand element not found!`);
            }
        } else {
            // Clear grab position when releasing
            this[`${hand}GrabPosition`] = null;
            DebugUtils.log('PLAYER', `${hand} hand released surface`);
        }
    },

    setThumbstickRotation: function(hand, value) {
        // PROPER thumbstick handling - no momentum
        if (hand === 'right') {
            this.thumbstickRotation.right = Math.abs(value) > 0.1 ? -value : 0;
            DebugUtils.log('PLAYER', `Right thumbstick set: ${this.thumbstickRotation.right.toFixed(2)}`);
        } else if (hand === 'left') {
            this.thumbstickRotation.left = Math.abs(value) > 0.1 ? -value : 0;
            DebugUtils.log('PLAYER', `Left thumbstick set: ${this.thumbstickRotation.left.toFixed(2)}`);
        }
    },

    activateBraking: function() {
        this.isBraking = true;
        
        // Apply immediate velocity reduction
        this.velocity.multiplyScalar(0.5);
        if (this.collisionBody) {
            window.PhysicsWorld.setVelocity(this.collisionBody, this.velocity);
        }
        
        // Reset braking after short duration
        setTimeout(() => {
            this.isBraking = false;
        }, 500);
        
        DebugUtils.log('PLAYER', 'Emergency braking activated');
    },

    applyThrusterForces: function(deltaTime) {
        if (!this.leftHand || !this.rightHand) return;
        
        let totalForce = new THREE.Vector3(0, 0, 0);
        
        // Left hand thruster  
        if (this.thrusterStates.left) {
            const leftDirection = this.getThrusterDirection(this.leftHand);
            totalForce.add(leftDirection.multiplyScalar(this.data.thrusterForce));
        }
        
        // Right hand thruster
        if (this.thrusterStates.right) {
            const rightDirection = this.getThrusterDirection(this.rightHand);
            totalForce.add(rightDirection.multiplyScalar(this.data.thrusterForce));
        }
        
        // Apply force to velocity
        if (totalForce.length() > 0) {
            const forceScaled = totalForce.multiplyScalar(deltaTime);
            this.velocity.add(forceScaled);
            
            // Cap maximum velocity
            if (this.velocity.length() > this.data.maxSpeed) {
                this.velocity.normalize().multiplyScalar(this.data.maxSpeed);
            }
        }
    },

    getThrusterDirection: function(hand) {
        // Get thrust direction from controller orientation (pointing down from controller)
        const direction = new THREE.Vector3(0, -1, 0);
        const quaternion = new THREE.Quaternion();
        hand.object3D.getWorldQuaternion(quaternion);
        direction.applyQuaternion(quaternion);
        return direction;
    },

    applyGrabMovement: function(deltaTime) {
        // Handle movement from grabbing and pushing off static surfaces
        let grabMovement = new THREE.Vector3(0, 0, 0);
        
        // Check for grab movement from both hands
        ['left', 'right'].forEach(hand => {
            if (this.grabStates[hand] && this[`${hand}GrabPosition`]) {
                const handElement = hand === 'left' ? this.leftHand : this.rightHand;
                if (handElement) {
                    const currentHandPos = ControllerUtils.getWorldPosition(handElement);
                    const initialGrabPos = this[`${hand}GrabPosition`];
                    
                    // Calculate how much the hand has moved since grabbing
                    const handMovement = new THREE.Vector3().subVectors(currentHandPos, initialGrabPos);
                    
                    // Apply movement for any hand motion (more sensitive)
                    if (handMovement.length() > 0.005) {
                        // Apply movement in opposite direction (Newton's 3rd law)
                        // Player pulls themselves toward the static object
                        const pullForce = handMovement.clone().negate().multiplyScalar(5.0); // Increased multiplier
                        grabMovement.add(pullForce);
                        
                        // Update grab position for continuous movement
                        this[`${hand}GrabPosition`] = currentHandPos;
                        
                        DebugUtils.log('PLAYER', `${hand} hand grab movement applied: ${pullForce.length().toFixed(3)}, hand moved: ${handMovement.length().toFixed(3)}`);
                    }
                }
            } else if (this.grabStates[hand]) {
                // If grab state is true but no position, something is wrong
                DebugUtils.log('PLAYER', `${hand} hand grab state is true but no grab position!`);
            }
        });
        
        if (grabMovement.length() > 0) {
            const oldVelocity = this.velocity.length();
            this.velocity.add(grabMovement.multiplyScalar(deltaTime));
            
            // Cap velocity to prevent excessive speeds
            const maxGrabSpeed = 8.0; // Increased for better responsiveness
            if (this.velocity.length() > maxGrabSpeed) {
                this.velocity.normalize().multiplyScalar(maxGrabSpeed);
            }
            
            DebugUtils.log('PLAYER', `GRAB MOVEMENT: Force ${grabMovement.length().toFixed(3)}, Old vel: ${oldVelocity.toFixed(3)}, New vel: ${this.velocity.length().toFixed(3)}`);
        } else {
            // Debug why no grab movement is being applied
            const activeGrabs = ['left', 'right'].filter(hand => this.grabStates[hand]);
            if (activeGrabs.length > 0) {
                DebugUtils.log('PLAYER', `No grab movement despite active grabs: ${activeGrabs.join(', ')}`);
            }
        }
    },

    applyRotation: function(deltaTime) {
        if (!this.rig) return;
        
        // Apply rotation from right thumbstick - NO MOMENTUM
        const rotationInput = this.thumbstickRotation.right;
        if (Math.abs(rotationInput) > 0.1) {
            const rotationSpeed = 2.0 * deltaTime; // deltaTime is already in seconds
            this.rotationY += rotationInput * rotationSpeed;
            
            // Apply rotation to the rig only (no physics body)
            this.rig.object3D.rotation.y = this.rotationY;
            
            DebugUtils.log('PLAYER', `🔄 Rotation applied: input=${rotationInput.toFixed(2)}, Y=${this.rotationY.toFixed(2)}`);
        }
        // When thumbstick is released, rotation stops immediately (no momentum)
    },

    applyDamping: function(deltaTime) {
        // Apply velocity damping for realistic space movement
        ZeroGMath.applyDamping(this.velocity, this.data.damping, deltaTime);
        
        // Enhanced braking when active
        if (this.isBraking) {
            this.velocity.multiplyScalar(0.9);
        }
    },

        checkCollisions: function() {
        // Let the physics engine handle collisions automatically
        // Instead of manual collision detection, we'll let AmmoJS handle player-surface collisions
        // and just apply damping to prevent excessive bouncing
        
        if (this.velocity.length() > this.data.maxSpeed) {
            this.velocity.normalize().multiplyScalar(this.data.maxSpeed);
        }
        
        // Only debug occasionally
        if (Math.random() < 0.001) {
            DebugUtils.log('PLAYER', `Velocity: ${this.velocity.length().toFixed(2)} m/s`);
        }
    },

    updatePhysicsBody: function() {
        if (!this.collisionBody || !this.rig) return;
        
        // Update physics body position to match VR rig
        const rigPosition = this.rig.object3D.position;
        const rigQuaternion = this.rig.object3D.quaternion;
        
        PhysicsUtils.setBodyTransform(this.collisionBody, rigPosition, rigQuaternion);
        window.PhysicsWorld.setVelocity(this.collisionBody, this.velocity);
        
        // Debug physics body sync occasionally
        if (Math.random() < 0.001) { // Very rare debug
            DebugUtils.log('PLAYER', `Physics body synced to position:`, rigPosition.toArray(), `velocity:`, this.velocity.length().toFixed(2));
        }
    },

    applyMovement: function(deltaTime) {
        if (!this.rig) return;
        
        // Apply velocity to move VR rig
        if (this.velocity.length() > 0.01) {
            const movement = this.velocity.clone().multiplyScalar(deltaTime);
            this.rig.object3D.position.add(movement);
        }
    },

    tick: function(time, deltaTime) {
        if (!window.PhysicsWorld || !this.collisionBody) return;
        
        const dt = Math.min(deltaTime / 1000, 0.033); // Cap at 30fps for stability
        
        // Apply forces and movement
        this.applyThrusterForces(dt);
        this.applyGrabMovement(dt);
        this.applyRotation(dt);
        this.applyDamping(dt);
        
        // Check collisions
        this.checkCollisions();
        
        // Apply movement to VR rig
        this.applyMovement(dt);
        
        // Update physics body
        this.updatePhysicsBody();
        
        // Only log significant velocity changes
        if (this.velocity.length() > 5.0 && Math.random() < 0.01) {
            console.log(`Player velocity: ${this.velocity.length().toFixed(1)} m/s`);
        }
    },
    
    shootBallFromCamera: function() {
        // Throttle shooting to prevent spam (max one shot per 300ms)
        const now = performance.now();
        if (this.lastShotTime && now - this.lastShotTime < 300) {
            return;
        }
        this.lastShotTime = now;
        
        // Limit total number of active shot balls
        const activeShotBalls = document.querySelectorAll('.shot-ball').length;
        if (activeShotBalls >= 5) {
            return;
        }
        
        const camera = document.querySelector('[camera]');
        if (!camera) {
            console.log('No camera found for ball shooting');
            return;
        }

        // Get camera position and direction  
        const cameraPos = new THREE.Vector3();
        const cameraQuat = new THREE.Quaternion();
        camera.object3D.getWorldPosition(cameraPos);
        camera.object3D.getWorldQuaternion(cameraQuat);

        // Calculate forward direction
        const forwardDir = new THREE.Vector3(0, 0, -1);
        forwardDir.applyQuaternion(cameraQuat);

        // Create spawn position slightly in front of camera
        const spawnPos = cameraPos.clone().add(forwardDir.clone().multiplyScalar(0.5));

        console.log(`🎯 Camera pos: [${cameraPos.x.toFixed(1)}, ${cameraPos.y.toFixed(1)}, ${cameraPos.z.toFixed(1)}]`);
        console.log(`🎯 Forward dir: [${forwardDir.x.toFixed(2)}, ${forwardDir.y.toFixed(2)}, ${forwardDir.z.toFixed(2)}]`);
        console.log(`🎯 Spawn pos: [${spawnPos.x.toFixed(1)}, ${spawnPos.y.toFixed(1)}, ${spawnPos.z.toFixed(1)}]`);

        // Create shot ball
        this.createDirectShotBall(spawnPos, forwardDir);
    },
    
    createDirectShotBall: function(position, direction) {
        const scene = document.querySelector('a-scene');
        if (!scene) return;

        const shotId = `shot-ball-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const ball = document.createElement('a-sphere');

        ball.id = shotId;
        ball.classList.add('shot-ball');
        ball.setAttribute('radius', '0.1');
        ball.setAttribute('color', '#ff0000');
        ball.setAttribute('material', 'shader: standard; emissive: #ff0000; emissiveIntensity: 2.0');
        ball.setAttribute('position', `${position.x} ${position.y} ${position.z}`);

        // Add light for visibility
        const light = document.createElement('a-entity');
        light.setAttribute('light', 'type: point; color: #ff0000; intensity: 1; distance: 5');
        ball.appendChild(light);

        // Use pure physics (like original) instead of animation
        ball.setAttribute('shot-ball-physics', '');

        scene.appendChild(ball);

        // Apply velocity after physics body is created
        setTimeout(() => {
            this.applyShotBallVelocity(ball, direction);
        }, 100);
    },

    applyShotBallVelocity: function(ballEl, direction) {
        const ballComponent = ballEl.components['shot-ball-physics'];
        
        if (ballComponent && ballComponent.physicsBody) {
            // Apply forward velocity (7.5 m/s like requested - half of original 15)
            const velocity = direction.clone().multiplyScalar(7.5);
            
            // Use Ammo.js directly (like original)
            const ammoVel = new Ammo.btVector3(velocity.x, velocity.y, velocity.z);
            ballComponent.physicsBody.setLinearVelocity(ammoVel);
            ballComponent.physicsBody.activate();
            Ammo.destroy(ammoVel);
            
            console.log(`🚀 Shot ball velocity applied: ${velocity.length().toFixed(1)} m/s`);
            
            // Immediate verification
            setTimeout(() => {
                const currentVel = window.PhysicsWorld.getVelocity(ballComponent.physicsBody);
                const currentSpeed = currentVel.length();
                console.log(`🔍 Shot ball velocity check: ${currentSpeed.toFixed(2)} m/s (expected: 7.5)`);
                
                if (currentSpeed < 1.0) {
                    console.log(`❌ Shot ball velocity lost! Checking collision flags...`);
                    const flags = ballComponent.physicsBody.getCollisionFlags();
                    const isActive = ballComponent.physicsBody.isActive();
                    console.log(`   Collision flags: ${flags}, Active: ${isActive}`);
                }
            }, 100);
        } else {
            console.log(`❌ Shot ball physics not ready yet`);
            // Retry once more
            setTimeout(() => {
                this.applyShotBallVelocity(ballEl, direction);
            }, 100);
        }
    },

    toggleWireframes: function() {
        // Toggle wireframe visibility for all physics objects
        this.wireframesVisible = !this.wireframesVisible;
        
        // Toggle grabbable ball wireframes
        document.querySelectorAll('[grabbable-ball]').forEach(ball => {
            const wireframe = ball.querySelector('.physics-wireframe');
            if (wireframe) {
                wireframe.setAttribute('visible', this.wireframesVisible);
            }
        });
        
        // Toggle grab surface wireframes  
        document.querySelectorAll('[grab-surface]').forEach(surface => {
            const wireframe = surface.querySelector('.physics-wireframe');
            if (wireframe) {
                wireframe.setAttribute('visible', this.wireframesVisible);
            }
        });
        
        // Toggle environment wireframes
        document.querySelectorAll('[environment-surface]').forEach(env => {
            const wireframe = env.querySelector('.physics-wireframe');
            if (wireframe) {
                wireframe.setAttribute('visible', this.wireframesVisible);
            }
        });
        
        // Toggle ammo-physics wireframes
        document.querySelectorAll('[ammo-physics]').forEach(ammoEntity => {
            const component = ammoEntity.components['ammo-physics'];
            if (component && component.physicsWireframe) {
                component.physicsWireframe.visible = this.wireframesVisible;
            }
        });
        
        // Toggle player collision wireframe
        if (this.collisionVisualization) {
            this.collisionVisualization.setAttribute('visible', this.wireframesVisible);
        }
        
        DebugUtils.log('PLAYER', `Wireframes ${this.wireframesVisible ? 'SHOWN' : 'HIDDEN'}`);
    },
    

    
    remove: function() {
        // Clean up physics body
        if (this.collisionBody && window.PhysicsWorld) {
            window.PhysicsWorld.removeRigidBody(this.collisionBody);
            Ammo.destroy(this.collisionBody);
        }
        
        // Clean up collision visualization
        if (this.collisionVisualization && this.collisionVisualization.parentNode) {
            this.collisionVisualization.parentNode.removeChild(this.collisionVisualization);
        }
        
        DebugUtils.log('PLAYER', 'Player controller removed');
    }
});

/**
 * Player Statistics Component
 * Tracks and displays player movement statistics
 */
AFRAME.registerComponent('player-stats', {
    init: function() {
        this.stats = {
            totalDistance: 0,
            maxSpeed: 0,
            thrusterTime: 0,
            collisions: 0
        };
        
        this.lastPosition = new THREE.Vector3();
        this.statsDisplay = null;
        
        // Create stats display
        this.createStatsDisplay();
        
        // Update stats periodically
        this.statsInterval = setInterval(() => {
            this.updateStatsDisplay();
        }, 1000);
    },

    createStatsDisplay: function() {
        if (!window.ZeroGState.debugMode) return;
        
        const camera = document.querySelector('[camera]');
        if (!camera) return;
        
        this.statsDisplay = document.createElement('a-entity');
        this.statsDisplay.setAttribute('position', '0 -0.3 -0.8');
        this.statsDisplay.setAttribute('text', {
            value: 'Player Stats\nDistance: 0m\nMax Speed: 0 m/s\nCollisions: 0',
            align: 'center',
            width: 1.2,
            color: '#ffffff',
            background: '#000000',
            backgroundOpacity: 0.8
        });
        this.statsDisplay.setAttribute('visible', false);
        
        camera.appendChild(this.statsDisplay);
    },

    updateStats: function(playerPosition, velocity) {
        // Update distance traveled
        if (this.lastPosition.length() > 0) {
            const distance = playerPosition.distanceTo(this.lastPosition);
            this.stats.totalDistance += distance;
        }
        this.lastPosition.copy(playerPosition);
        
        // Update max speed
        const currentSpeed = velocity.length();
        this.stats.maxSpeed = Math.max(this.stats.maxSpeed, currentSpeed);
    },

    updateStatsDisplay: function() {
        if (!this.statsDisplay || !window.ZeroGState.debugMode) return;
        
        const statsText = `Player Stats
Distance: ${this.stats.totalDistance.toFixed(1)}m
Max Speed: ${this.stats.maxSpeed.toFixed(2)} m/s
Collisions: ${this.stats.collisions}`;
        
        this.statsDisplay.setAttribute('text', 'value', statsText);
        this.statsDisplay.setAttribute('visible', true);
    },

    tick: function() {
        if (!window.ZeroGState.debugMode) return;
        
        const player = document.querySelector('[zerog-player]');
        if (!player || !player.components['zerog-player']) return;
        
        const playerComponent = player.components['zerog-player'];
        const rig = document.querySelector('#rig');
        
        if (rig && playerComponent.velocity) {
            this.updateStats(rig.object3D.position, playerComponent.velocity);
        }
    },

    remove: function() {
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
        }
        
        if (this.statsDisplay && this.statsDisplay.parentNode) {
            this.statsDisplay.parentNode.removeChild(this.statsDisplay);
        }
    }
});

// Auto-attach player stats in debug mode
document.addEventListener('DOMContentLoaded', function() {
    // Wait for debug mode to be determined
    setTimeout(() => {
        if (window.ZeroGState.debugMode) {
            const scene = document.querySelector('a-scene');
            if (scene && !scene.hasAttribute('player-stats')) {
                scene.setAttribute('player-stats', '');
            }
        }
    }, 1000);
    
    DebugUtils.log('PLAYER', 'Player controller module loaded');
}); 