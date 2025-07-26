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
        // Hand states like reference project
        this.hands = {
            left: {
                isGrabbing: false,
                nearbyObject: null,
                grabInfo: null,
                gripHeld: false
            },
            right: {
                isGrabbing: false,
                nearbyObject: null,
                grabInfo: null,
                gripHeld: false
            }
        };
        
        // Legacy grab states for compatibility
        this.grabStates = { left: false, right: false };
        
        // Rotation state
        this.rotationY = 0;
        this.thumbstickRotation = { left: 0, right: 0 };
        
        // Wireframe toggle state
        this.wireframesVisible = false;
        
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
        
        // Setup grip event handlers (like reference project)
        this.setupHandEvents();
        
        DebugUtils.log('PLAYER', 'Player references setup complete');
    },

    setupHandEvents: function() {
        // Grip controls for grabbing surfaces AND balls (EchoVR style)
        this.el.sceneEl.addEventListener('gripdown', (evt) => {
            const hand = evt.target;
            const isLeft = hand.id === 'leftHand';
            const handKey = isLeft ? 'left' : 'right';
            
            // Track grip state for continuous ball grabbing
            this.hands[handKey].gripHeld = true;
            
            // Try to grab balls first (priority), then static surfaces
            console.log(`Grip down: ${handKey} hand - trying to grab ball`);
            this.tryGrabBall(hand);
            
            // If no ball was grabbed, try environment grabbing if nearby
            if (!this.hands[handKey].isGrabbing && this.hands[handKey].nearbyObject === 'environment') {
                console.log(`Grip down: ${handKey} hand - grabbing environment`);
                this.grabEnvironment(handKey);
            }
        });
        
        this.el.sceneEl.addEventListener('gripup', (evt) => {
            const hand = evt.target;
            const isLeft = hand.id === 'leftHand';
            const handKey = isLeft ? 'left' : 'right';
            
            // Track grip state
            this.hands[handKey].gripHeld = false;
            
            // Release whatever is being grabbed (ball or environment)
            if (this.hands[handKey].isGrabbing) {
                this.releaseGrabbedObject(handKey);
            }
        });
    },

    tryGrabBall: function(hand) {
        const isLeft = hand.id === 'leftHand';
        const handKey = isLeft ? 'left' : 'right';
        
        // Check if there's a nearby ball
        const nearestBall = this.findNearestBall(hand);
        if (nearestBall) {
            console.log(`✅ ${handKey} hand grabbing ball`);
            this.hands[handKey].isGrabbing = true;
            this.hands[handKey].nearbyObject = nearestBall;
            this.hands[handKey].grabInfo = {
                isBall: true,
                ball: nearestBall,
                handPositionAtGrab: new THREE.Vector3().copy(hand.object3D.position),
                grabStartTime: performance.now()
            };
            
            // Notify the ball component
            if (nearestBall.components['grabbable-ball']) {
                nearestBall.components['grabbable-ball'].onGrab(hand);
            }
        }
    },

    grabEnvironment: function(handKey) {
        const hand = this[handKey + 'Hand'];
        if (!hand) return;
        
        const handPos = new THREE.Vector3();
        hand.object3D.getWorldPosition(handPos);
        
        this.hands[handKey].isGrabbing = true;
        this.hands[handKey].grabInfo = {
            isBall: false,
            grabPoint: handPos.clone(),
            handPositionAtGrab: handPos.clone(),
            grabStartTime: performance.now()
        };
        
        console.log(`✅ ${handKey} hand grabbing environment`);
    },

    releaseGrabbedObject: function(handKey) {
        const handState = this.hands[handKey];
        if (!handState.isGrabbing) return;
        
        console.log(`Release: ${handKey} hand releasing object`);
        
        if (handState.grabInfo && handState.grabInfo.isBall && handState.grabInfo.ball) {
            // Release ball
            const ball = handState.grabInfo.ball;
            if (ball.components['grabbable-ball']) {
                // Calculate throw velocity
                const throwVelocity = this.calculateThrowVelocity(handKey);
                ball.components['grabbable-ball'].onRelease(throwVelocity);
            }
        }
        
        // Clear grab state
        handState.isGrabbing = false;
        handState.grabInfo = null;
        handState.nearbyObject = null;
    },

    calculateThrowVelocity: function(handKey) {
        // Simple velocity calculation - could be enhanced
        return new THREE.Vector3(0, 0, -2); // Default forward throw
    },

    setupPhysics: function() {
        if (!window.PhysicsWorld || !Ammo) {
            console.log('🚫 Cannot create player physics body - Ammo.js not ready');
            setTimeout(() => {
                if (!this.playerPhysicsBody) {
                    this.setupPhysics();
                }
            }, 1000);
            return;
        }

        if (this.playerPhysicsBody) {
            console.log('🔧 Player physics body already exists');
            return;
        }

        console.log('🔧 Creating real physics body for player (like reference project)');
        
        // Create sphere shape for player body (like reference project)
        const radius = 0.4; // 40cm radius sphere for player (same as reference)
        const shape = new Ammo.btSphereShape(radius);
        
        // Create DYNAMIC body with mass (like reference project)
        const mass = 1;
        const localInertia = new Ammo.btVector3(0, 0, 0);
        shape.calculateLocalInertia(mass, localInertia);
        
        const transform = new Ammo.btTransform();
        transform.setIdentity();
        
        // Get current camera position to initialize physics body there
        if (this.camera) {
            const cameraWorldPos = new THREE.Vector3();
            this.camera.object3D.getWorldPosition(cameraWorldPos);
            transform.setOrigin(new Ammo.btVector3(cameraWorldPos.x, cameraWorldPos.y, cameraWorldPos.z));
            console.log('🔧 Player physics body initialized at camera position:', cameraWorldPos.toArray().map(x => x.toFixed(2)));
        } else {
            transform.setOrigin(new Ammo.btVector3(0, 1.6, -2)); // Fallback position
            console.log('🔧 Player physics body initialized at fallback position');
        }
        
        const motionState = new Ammo.btDefaultMotionState(transform);
        const rigidBodyInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
        this.playerPhysicsBody = new Ammo.btRigidBody(rigidBodyInfo);
        
        // Set damping (like reference project)
        this.playerPhysicsBody.setDamping(0.01, 0.1); // Low linear damping, medium angular damping
        
        // Prevent rotation (player should only translate, not tumble)
        this.playerPhysicsBody.setAngularFactor(new Ammo.btVector3(0, 0, 0));
        
        // Add velocity API (like reference project)
        this.setupPlayerVelocityAPI();
        
        // Add player with collision filtering (same as reference project)
        const PLAYER_GROUP = 2;
        const PLAYER_MASK = 1 | 16; // Collide with environment (1) and enemy balls (16), not hands (4) or player ball (8)
        window.PhysicsWorld.world.addRigidBody(this.playerPhysicsBody, PLAYER_GROUP, PLAYER_MASK);
        
        console.log(`👤 PLAYER: Physics body successfully added to physics world!`);
        console.log(`👤 PLAYER: Group: ${PLAYER_GROUP}, Mask: ${PLAYER_MASK} (env + enemy balls)`);
        
        // Create collision visualization
        this.createCollisionVisualization();
        
        console.log('✅ Player physics body added to Ammo.js physics world (dynamic sphere, like reference)');
        
        // Position the physics body correctly after a delay
        setTimeout(() => {
            this.repositionPlayerPhysicsBody();
        }, 2000);
        
        // Create hand physics bodies after environment is ready
        setTimeout(() => {
            this.createHandPhysicsBodies();
        }, 3000);
    },

    setupPlayerVelocityAPI: function() {
        // Add velocity API to player physics body (same as reference project)
        this.playerPhysicsBody.velocity = {
            set: (x, y, z) => {
                const velocity = new Ammo.btVector3(x, y, z);
                this.playerPhysicsBody.setLinearVelocity(velocity);
                Ammo.destroy(velocity);
            },
            add: (x, y, z) => {
                const currentVel = this.playerPhysicsBody.getLinearVelocity();
                const newVel = new Ammo.btVector3(currentVel.x() + x, currentVel.y() + y, currentVel.z() + z);
                this.playerPhysicsBody.setLinearVelocity(newVel);
                Ammo.destroy(newVel);
            },
            length: () => {
                const vel = this.playerPhysicsBody.getLinearVelocity();
                const length = Math.sqrt(vel.x() * vel.x() + vel.y() * vel.y() + vel.z() * vel.z());
                return length;
            },
            multiplyScalar: (scalar) => {
                const vel = this.playerPhysicsBody.getLinearVelocity();
                const newVel = new Ammo.btVector3(vel.x() * scalar, vel.y() * scalar, vel.z() * scalar);
                this.playerPhysicsBody.setLinearVelocity(newVel);
                Ammo.destroy(newVel);
            }
        };
        
        this.playerPhysicsBody.position = {
            copy: (vector3) => {
                const transform = new Ammo.btTransform();
                this.playerPhysicsBody.getMotionState().getWorldTransform(transform);
                const origin = transform.getOrigin();
                
                // Safety check for valid origin
                if (origin && typeof origin.x === 'function') {
                    vector3.set(origin.x(), origin.y(), origin.z());
                }
                Ammo.destroy(transform);
            }
        };
    },

    repositionPlayerPhysicsBody: function() {
        if (!this.playerPhysicsBody || !Ammo) return;
        
        if (!this.camera) return;
        
        const cameraWorldPos = new THREE.Vector3();
        this.camera.object3D.getWorldPosition(cameraWorldPos);
        
        // Move physics body to current camera position
        const transform = new Ammo.btTransform();
        this.playerPhysicsBody.getMotionState().getWorldTransform(transform);
        transform.setOrigin(new Ammo.btVector3(cameraWorldPos.x, cameraWorldPos.y, cameraWorldPos.z));
        this.playerPhysicsBody.getMotionState().setWorldTransform(transform);
        this.playerPhysicsBody.setCenterOfMassTransform(transform);
        this.playerPhysicsBody.activate();
        
        console.log('🔧 Repositioned player physics body to camera position:', cameraWorldPos.toArray().map(x => x.toFixed(2)));
        
        Ammo.destroy(transform);
    },

    createCollisionVisualization: function() {
        // Create wireframe sphere to visualize collision body (same as reference)
        if (this.playerWireframe) {
            this.playerWireframe.parentNode.removeChild(this.playerWireframe);
        }
        
        this.playerWireframe = document.createElement('a-sphere');
        this.playerWireframe.setAttribute('radius', '0.4'); // Same as physics body
        this.playerWireframe.setAttribute('material', 'wireframe: true; color: #00ff00; opacity: 0.8');
        this.playerWireframe.setAttribute('visible', false);
        
        // Position wireframe at current camera position (like reference project)
        if (this.camera) {
            const cameraWorldPos = new THREE.Vector3();
            this.camera.object3D.getWorldPosition(cameraWorldPos);
            this.playerWireframe.setAttribute('position', `${cameraWorldPos.x} ${cameraWorldPos.y} ${cameraWorldPos.z}`);
        } else {
            this.playerWireframe.setAttribute('position', '0 1.6 0'); // Fallback position
        }
        
        this.el.sceneEl.appendChild(this.playerWireframe);
        
        // Store reference for wireframe toggle
        this.collisionVisualization = this.playerWireframe;
        
        console.log('✅ Player wireframe sphere created');
        
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
        
        let totalThrust = new THREE.Vector3(0, 0, 0);
        
        // Left hand thruster  
        if (this.thrusterStates.left) {
            const leftDirection = this.getThrusterDirection(this.leftHand);
            totalThrust.add(leftDirection.multiplyScalar(this.data.thrusterForce * deltaTime));
        }
        
        // Right hand thruster
        if (this.thrusterStates.right) {
            const rightDirection = this.getThrusterDirection(this.rightHand);
            totalThrust.add(rightDirection.multiplyScalar(this.data.thrusterForce * deltaTime));
        }
        
        // Apply thrust to velocity (like reference project)
        if (totalThrust.length() > 0) {
            this.velocity.add(totalThrust);
            
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

    updateEnvironmentGrabbing: function() {
        // Real environment grabbing - track hand movement relative to grab point (like reference project)
        ['left', 'right'].forEach(handKey => {
            const handState = this.hands[handKey];
            
            if (handState.isGrabbing && handState.nearbyObject === 'environment' && handState.grabInfo) {
                // CRITICAL: Only process if this is actually environment grabbing (not ball grabbing)
                if (handState.grabInfo.isBall) {
                    return; // Skip ball grabs - this function is only for environment grabbing
                }
                
                const hand = handKey === 'left' ? this.leftHand : this.rightHand;
                if (!hand) return;
                
                const grabInfo = handState.grabInfo;
                
                // Safety check for valid grabInfo structure
                if (!grabInfo.handPositionAtGrab) {
                    console.log('⚠️ Invalid grabInfo structure for environment grabbing');
                    return;
                }
                
                // Calculate how much the hand has moved since grab started
                const currentHandPos = new THREE.Vector3();
                hand.object3D.getWorldPosition(currentHandPos);
                
                const handMovement = currentHandPos.clone().sub(grabInfo.handPositionAtGrab);
                
                // Apply opposite movement to player (if hand moves right, player moves left)
                // Moderate amplification for natural feel without stuttering
                const playerMovement = handMovement.clone().multiplyScalar(-1.5);
                
                // Limit movement speed to prevent wild flinging and stuttering
                const maxMovementPerFrame = 0.15; // 15cm max to prevent oscillation
                if (playerMovement.length() > maxMovementPerFrame) {
                    playerMovement.normalize().multiplyScalar(maxMovementPerFrame);
                }
                
                // Add smoothing to prevent stuttering
                if (playerMovement.length() < 0.005) { // Ignore tiny movements (0.5cm threshold)
                    return; // Skip very small movements that can cause jitter
                }
                
                // Apply movement directly to VR rig position for immediate response
                if (this.rig) {
                    this.rig.object3D.position.add(playerMovement);
                    
                    // Update physics body to follow the new rig position immediately
                    this.updatePhysicsBodyToFollowRig();
                    
                    // Track movement for momentum on release
                    const movementVelocity = playerMovement.clone().multiplyScalar(80);
                    this.velocity.lerp(movementVelocity, 0.2);
                    
                    if (Math.random() < 0.01) { // 1% chance to log
                        DebugUtils.log('PLAYER', `Environment grab movement: ${playerMovement.length().toFixed(3)}m`);
                    }
                }
                
                // CRITICAL: DON'T update the grab reference point - keep it fixed at original grab location
            }
        });
    },

    createHandPhysicsBodies: function() {
        if (!Ammo || !window.PhysicsWorld) {
            console.log('🚫 Cannot create hand physics bodies - Ammo.js not ready');
            setTimeout(() => this.createHandPhysicsBodies(), 1000);
            return;
        }
        
        ['left', 'right'].forEach(handKey => {
            const hand = this[handKey + 'Hand'];
            if (!hand) return;
            
            // Create physics sphere for hand
            const radius = 0.05; // 5cm radius for hand collision
            const shape = new Ammo.btSphereShape(radius);
            
            const transform = new Ammo.btTransform();
            transform.setIdentity();
            
            const handPos = new THREE.Vector3();
            hand.object3D.getWorldPosition(handPos);
            transform.setOrigin(new Ammo.btVector3(handPos.x, handPos.y, handPos.z));
            
            const motionState = new Ammo.btDefaultMotionState(transform);
            const mass = 0; // Kinematic body
            const localInertia = new Ammo.btVector3(0, 0, 0);
            
            const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
            const body = new Ammo.btRigidBody(rbInfo);
            
            // Make it kinematic
            body.setCollisionFlags(body.getCollisionFlags() | 2);
            body.setActivationState(4);
            
            // Add hands with collision filtering - don't collide with player body or balls
            const HAND_GROUP = 4;
            const HAND_MASK = 1; // Only collide with environment (group 1)
            
            window.PhysicsWorld.world.addRigidBody(body, HAND_GROUP, HAND_MASK);
            
            // Store reference
            this.hands[handKey].physicsBody = body;
            
            // Create physics wireframe sphere
            const wireSphere = document.createElement('a-sphere');
            wireSphere.setAttribute('radius', radius);
            wireSphere.setAttribute('material', {
                color: '#0000ff',
                wireframe: true,
                opacity: 0.5,
                transparent: true
            });
            wireSphere.setAttribute('position', '0 0 0');
            hand.appendChild(wireSphere);
            this.hands[handKey].physicsWireframe = wireSphere;
            
            // Clean up Ammo objects
            Ammo.destroy(transform);
            Ammo.destroy(localInertia);
            Ammo.destroy(rbInfo);
        });
        
        console.log('✅ Created physics bodies and visualizations for hands');
    },

    updateHandPhysicsBodies: function() {
        if (!Ammo) return;
        
        ['left', 'right'].forEach(handKey => {
            const hand = handKey === 'left' ? this.leftHand : this.rightHand;
            const handState = this.hands[handKey];
            if (!hand || !handState.physicsBody) return;
            
            // Update hand physics body position to follow actual hand
            const handPos = new THREE.Vector3();
            hand.object3D.getWorldPosition(handPos);
            
            const transform = new Ammo.btTransform();
            handState.physicsBody.getMotionState().getWorldTransform(transform);
            transform.setOrigin(new Ammo.btVector3(handPos.x, handPos.y, handPos.z));
            handState.physicsBody.getMotionState().setWorldTransform(transform);
            handState.physicsBody.setCenterOfMassTransform(transform);
            
            Ammo.destroy(transform);
        });
    },

    checkHandCollisions: function() {
        if (!Ammo || !window.PhysicsWorld) return;
        
        // Update hand physics body positions first
        this.updateHandPhysicsBodies();
        
        ['left', 'right'].forEach(handKey => {
            const handState = this.hands[handKey];
            if (!handState.physicsBody) return;
            
            // Reset nearbyObject detection for this frame
            handState.nearbyObject = null;
            
            // Check for collisions with environment
            const numManifolds = window.PhysicsWorld.world.getDispatcher().getNumManifolds();
            let isColliding = false;
            let collisionNormal = new THREE.Vector3();
            
            for (let i = 0; i < numManifolds; i++) {
                const contactManifold = window.PhysicsWorld.world.getDispatcher().getManifoldByIndexInternal(i);
                const body0 = Ammo.castObject(contactManifold.getBody0(), Ammo.btRigidBody);
                const body1 = Ammo.castObject(contactManifold.getBody1(), Ammo.btRigidBody);
                
                if (Ammo.compare(body0, handState.physicsBody) || Ammo.compare(body1, handState.physicsBody)) {
                    const numContacts = contactManifold.getNumContacts();
                    
                    for (let j = 0; j < numContacts; j++) {
                        const contactPoint = contactManifold.getContactPoint(j);
                        const distance = contactPoint.getDistance();
                        
                        if (distance < 0.1) { // Close contact
                            isColliding = true;
                            const normal = contactPoint.get_m_normalWorldOnB();
                            
                            // Safety check for valid normal vector
                            if (normal && typeof normal.x === 'function') {
                                // Get normal direction (away from surface)
                                let normalDir = new THREE.Vector3(normal.x(), normal.y(), normal.z());
                                if (Ammo.compare(body1, handState.physicsBody)) {
                                    normalDir.negate(); // Flip if hand is body1
                                }
                                
                                collisionNormal.add(normalDir);
                            }
                            break;
                        }
                    }
                }
            }
            
            if (isColliding) {
                // Hand is touching environment - can push against it
                // BUT: Don't set to 'environment' if already grabbing a ball
                if (!handState.isGrabbing || (handState.grabInfo && !handState.grabInfo.isBall)) {
                    handState.nearbyObject = 'environment';
                }
                // If grabbing a ball, keep the current nearbyObject (don't change it)
                
                // Environment grabbing is handled in updateEnvironmentGrabbing()
            } else {
                // Only check for nearby ball if not already grabbing something
                if (!handState.isGrabbing) {
                    const ball = this.findNearestBall(this[handKey + 'Hand']);
                    handState.nearbyObject = ball;
                }
                // If already grabbing, keep the current nearbyObject
            }
        });
    },

    findNearestBall: function(hand) {
        const handPos = new THREE.Vector3();
        hand.object3D.getWorldPosition(handPos);
        const handRadius = 0.08; // Hand collision radius
        
        // Look for balls only
        const balls = document.querySelectorAll('[grabbable-ball]');
        let nearestBall = null;
        let minDistance = Infinity;
        
        balls.forEach(ball => {
            const ballPos = new THREE.Vector3();
            ball.object3D.getWorldPosition(ballPos);
            const distance = handPos.distanceTo(ballPos);
            
            // If hand is touching or very close to ball (within 10cm for easier grabbing)
            if (distance <= 0.10) {
                if (distance < minDistance) {
                    minDistance = distance;
                    nearestBall = ball;
                }
            }
        });
        
        return nearestBall;
    },

    checkHandRaycastCollision: function(handKey) {
        const hand = handKey === 'left' ? this.leftHand : this.rightHand;
        if (!hand) return false;

        // Get hand position
        const handPos = new THREE.Vector3();
        hand.object3D.getWorldPosition(handPos);

        // Cast rays in multiple directions from hand position
        const directions = [
            new THREE.Vector3(0, 0, -1), // Forward
            new THREE.Vector3(0, 0, 1),  // Backward
            new THREE.Vector3(1, 0, 0),  // Right
            new THREE.Vector3(-1, 0, 0), // Left
            new THREE.Vector3(0, 1, 0),  // Up
            new THREE.Vector3(0, -1, 0), // Down
        ];

        const raycaster = new THREE.Raycaster();
        const maxDistance = 0.1; // 10cm

        for (let direction of directions) {
            raycaster.set(handPos, direction);
            
            // Check collision with hallway-collision entity
            const hallwayCollision = document.querySelector('#hallway-collision');
            if (hallwayCollision && hallwayCollision.object3D) {
                const intersects = raycaster.intersectObject(hallwayCollision.object3D, true);
                if (intersects.length > 0 && intersects[0].distance < maxDistance) {
                    if (Math.random() < 0.01) { // Debug occasionally
                        console.log(`🎯 ${handKey} hand raycast hit at distance: ${intersects[0].distance.toFixed(3)}m`);
                    }
                    return true;
                }
            }
        }

        return false;
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

    applyVelocityToRig: function(deltaTime) {
        if (this.velocity.length() > 0) {
            const movement = this.velocity.clone().multiplyScalar(deltaTime);
            this.rig.object3D.position.add(movement);
        }
    },

    updatePhysicsBodyToFollowRig: function() {
        if (!this.playerPhysicsBody || !Ammo || !this.camera) return;
        
        // Get current camera world position (like reference project)
        const cameraWorldPos = new THREE.Vector3();
        this.camera.object3D.getWorldPosition(cameraWorldPos);
        
        // Move physics body to current camera position
        const transform = new Ammo.btTransform();
        this.playerPhysicsBody.getMotionState().getWorldTransform(transform);
        transform.setOrigin(new Ammo.btVector3(cameraWorldPos.x, cameraWorldPos.y, cameraWorldPos.z));
        this.playerPhysicsBody.getMotionState().setWorldTransform(transform);
        this.playerPhysicsBody.setCenterOfMassTransform(transform);
        this.playerPhysicsBody.activate();
        
        // Update wireframe position to match physics body (at camera position)
        if (this.playerWireframe) {
            this.playerWireframe.setAttribute('position', `${cameraWorldPos.x} ${cameraWorldPos.y} ${cameraWorldPos.z}`);
        }
        
        Ammo.destroy(transform);
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
        if (!this.rig) return;
        
        const dt = Math.min(deltaTime / 1000, 0.033); // Cap at 30fps for stability
        
        // Apply thumbstick rotation
        this.applyRotation(dt);
        
        // Apply thruster forces to velocity (like reference project)
        this.applyThrusterForces(dt);
        
        // Apply damping to velocity
        this.applyDamping(dt);
        
        // Check if grabbing environment (affects multiple systems)
        const isGrabbingEnvironment = this.hands.left.isGrabbing && this.hands.left.nearbyObject === 'environment' ||
                                     this.hands.right.isGrabbing && this.hands.right.nearbyObject === 'environment';
        

        
        // Apply velocity to move VR rig (like reference project) - but not when grabbing environment
        if (!isGrabbingEnvironment) {
            this.applyVelocityToRig(dt);
        }
        
        // Update physics body to follow VR rig position (for collision detection)
        if (!isGrabbingEnvironment) {
            this.updatePhysicsBodyToFollowRig();
        }
        
        // Handle environment grabbing movement (replaces old applyGrabMovement)
        this.updateEnvironmentGrabbing();
        
        // Check for hand collisions with environment (like reference project)
        this.checkHandCollisions();
        
        // Check for physics collisions and adjust velocity (like reference project)
        this.checkPhysicsCollisionAndAdjust(dt);
    },

    checkPhysicsCollisionAndAdjust: function(dt) {
        if (!this.playerPhysicsBody || !Ammo || !window.PhysicsWorld) return;
        
        // Debug counter to verify collision detection is running
        if (!this.collisionCheckCount) this.collisionCheckCount = 0;
        this.collisionCheckCount++;
        if (this.collisionCheckCount % 300 === 0) { // Every 5 seconds at 60fps
            console.log(`🔍 COLLISION CHECK: Running ${this.collisionCheckCount} times`);
        }
        
        // Check if physics body is colliding with environment
        const numManifolds = window.PhysicsWorld.world.getDispatcher().getNumManifolds();
        let isColliding = false;
        let collisionNormal = new THREE.Vector3();
        
        for (let i = 0; i < numManifolds; i++) {
            const contactManifold = window.PhysicsWorld.world.getDispatcher().getManifoldByIndexInternal(i);
            const body0 = Ammo.castObject(contactManifold.getBody0(), Ammo.btRigidBody);
            const body1 = Ammo.castObject(contactManifold.getBody1(), Ammo.btRigidBody);
            
            // Check if one of the bodies is our physics body
            if (Ammo.compare(body0, this.playerPhysicsBody) || Ammo.compare(body1, this.playerPhysicsBody)) {
                const numContacts = contactManifold.getNumContacts();
                
                for (let j = 0; j < numContacts; j++) {
                    const contactPoint = contactManifold.getContactPoint(j);
                    const distance = contactPoint.getDistance();
                    
                    if (distance < 0.1) { // Close contact
                        isColliding = true;
                        const normal = contactPoint.get_m_normalWorldOnB();
                        
                        // Safety check for valid normal vector
                        if (normal && typeof normal.x === 'function') {
                            // Get normal direction (away from surface)
                            let normalDir = new THREE.Vector3(normal.x(), normal.y(), normal.z());
                            if (Ammo.compare(body1, this.playerPhysicsBody)) {
                                normalDir.negate(); // Flip if player is body1
                            }
                            
                            collisionNormal.add(normalDir);
                        }
                        break;
                    }
                }
            }
        }
        
        if (isColliding) {
            // Normalize collision normal
            collisionNormal.normalize();
            
            // SMOOTH collision response like reference project
            // Add velocity away from collision surface instead of jumping position
            const dotProduct = this.velocity.dot(collisionNormal);
            if (dotProduct < 0) { // Moving into surface
                const reflection = collisionNormal.clone().multiplyScalar(-dotProduct * 0.8); // 80% reflection
                this.velocity.add(reflection);
            }
            
            // Add gentle push away from surface to prevent clipping
            this.velocity.add(collisionNormal.clone().multiplyScalar(0.1));
            
            // Debug occasionally
            if (Math.random() < 0.1) {
                console.log('🏗️ Player collision detected and velocity adjusted');
            }
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
        if (this.playerWireframe) {
            this.playerWireframe.setAttribute('visible', this.wireframesVisible);
        }
        
        // Toggle hand collision wireframes
        ['left', 'right'].forEach(handKey => {
            if (this.hands[handKey] && this.hands[handKey].physicsWireframe) {
                this.hands[handKey].physicsWireframe.setAttribute('visible', this.wireframesVisible);
            }
        });
        
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