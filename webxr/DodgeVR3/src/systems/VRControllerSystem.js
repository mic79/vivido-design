// Zero-G WebXR Multiplayer - VR Controller System

window.VRControllerSystem = class VRControllerSystem {
    constructor(world, physics, audio) {
        this.world = world;
        this.physics = physics;
        this.audio = audio;
        this.isInitialized = false;
        this.isEnabled = false;
        
        // VR session and controllers
        this.session = null;
        this.controllers = new Map();
        this.hands = new Map();
        
        // Player reference
        this.localPlayer = null;
        
        // Thruster system
        this.thrusterActive = { left: false, right: false };
        this.thrusterAudio = { left: null, right: null };
        this.thrusterParticles = { left: null, right: null };
        
        // Grabbing system
        this.grabbedObjects = new Map();
        this.grabConstraints = new Map();
        this.grabRaycasters = new Map();
        
        // Input state
        this.inputStates = new Map();
        this.lastFrameInputs = new Map();
        
        // Movement settings
        this.thrusterForce = 2.0;
        this.rotationSpeed = 1.5;
        
        // Performance tracking
        this.updateCount = 0;
        this.lastUpdateTime = 0;
    }
    
    async init() {
        try {
            console.log('🎮 Initializing VR Controller System...');
            
            // Setup controller templates
            this.initControllerTemplates();
            
            // Setup event listeners
            this.setupEventListeners();
            
            // Initialize raycasters for interaction
            this.initRaycasters();
            
            this.isInitialized = true;
            console.log('✅ VR Controller System initialized');
            
        } catch (error) {
            console.error('❌ Failed to initialize VR controllers:', error);
            throw error;
        }
    }
    
    initControllerTemplates() {
        // Controller geometry for visualization
        this.controllerGeometry = new THREE.CylinderGeometry(0.05, 0.05, 0.15, 8);
        this.controllerMaterial = new THREE.MeshLambertMaterial({ color: 0x444444 });
        
        // Hand geometry for hand tracking
        this.handGeometry = new THREE.SphereGeometry(0.02, 8, 6);
        this.handMaterial = new THREE.MeshLambertMaterial({ color: 0xffc0cb });
    }
    
    setupEventListeners() {
        // Listen for VR session events
        const renderer = this.world.getRenderer();
        
        renderer.xr.addEventListener('sessionstart', () => {
            this.onSessionStart();
        });
        
        renderer.xr.addEventListener('sessionend', () => {
            this.onSessionEnd();
        });
    }
    
    initRaycasters() {
        // Create raycasters for each potential controller
        for (let i = 0; i < 2; i++) {
            const raycaster = new THREE.Raycaster();
            raycaster.far = window.Constants.VR.GRAB_DISTANCE;
            this.grabRaycasters.set(i, raycaster);
        }
    }
    
    onSessionStart() {
        console.log('🥽 VR session started - initializing controllers');
        this.session = this.world.getRenderer().xr.getSession();
        this.isEnabled = true;
        
        // Get local player reference
        this.localPlayer = this.getLocalPlayer();
        
        // Setup controllers
        this.setupControllers();
        
        // Enable audio spatial tracking
        if (this.audio) {
            this.audio.onVRSessionStart();
        }
    }
    
    onSessionEnd() {
        console.log('🖥️ VR session ended - cleaning up controllers');
        this.isEnabled = false;
        
        // Stop all thrusters
        this.stopAllThrusters();
        
        // Clean up controllers
        this.cleanupControllers();
        
        // Disable audio VR mode
        if (this.audio) {
            this.audio.onVRSessionEnd();
        }
    }
    
    getLocalPlayer() {
        // Get the local player from the world
        const players = this.world.getAllPlayers();
        return players.length > 0 ? players[0] : null;
    }
    
    setupControllers() {
        const renderer = this.world.getRenderer();
        
        console.log('🎮 Setting up VR controllers...');
        
        // Setup both controllers (left and right)
        for (let i = 0; i < 2; i++) {
            const controller = renderer.xr.getController(i);
            const controllerGrip = renderer.xr.getControllerGrip(i);
            
            console.log(`🎮 Setting up controller ${i}...`);
            
            // Create visible controller representation
            const controllerMesh = new THREE.Mesh(this.controllerGeometry, this.controllerMaterial);
            controller.add(controllerMesh); // Add to controller, not controllerGrip
            
            // Create thruster visual effect
            this.createThrusterVisual(controller, i); // Add to controller for better visibility
            
            // Add both controller and grip to scene
            this.world.getScene().add(controller);
            this.world.getScene().add(controllerGrip);
            
            // Make controllers visible by default
            controller.visible = true;
            controllerGrip.visible = true;
            
            // Setup input events
            this.setupControllerEvents(controller, i);
            
            // Store controller reference
            this.controllers.set(i, {
                controller,
                controllerGrip,
                controllerMesh,
                inputSource: null,
                gamepad: null
            });
            
            // Initialize input state
            this.inputStates.set(i, {
                trigger: 0,
                grip: 0,
                thumbstick: { x: 0, y: 0 },
                buttons: {},
                wasPressed: { trigger: false, grip: false }
            });
            
            this.lastFrameInputs.set(i, {
                trigger: 0,
                grip: 0,
                thumbstick: { x: 0, y: 0 },
                buttons: {},
                wasPressed: { trigger: false, grip: false }
            });
            
            console.log(`✅ Controller ${i} setup complete`);
        }
        
        console.log('✅ All VR controllers setup complete');
    }
    
    createThrusterVisual(controller, index) {
        // Create thruster visual effect (cone pointing away from controller)
        const thrusterGeometry = new THREE.ConeGeometry(0.03, 0.15, 8);
        const thrusterMaterial = new THREE.MeshBasicMaterial({ 
            color: 0x00aaff,
            transparent: true,
            opacity: 0.9
        });
        
        const thrusterMesh = new THREE.Mesh(thrusterGeometry, thrusterMaterial);
        thrusterMesh.position.set(0, 0, -0.1); // Position in front of controller
        thrusterMesh.rotation.x = Math.PI; // Point away from controller
        thrusterMesh.visible = false;
        
        controller.add(thrusterMesh);
        controller.thrusterVisual = thrusterMesh;
        
        console.log(`🚀 Thruster visual created for controller ${index}`);
    }
    
    setupControllerEvents(controller, index) {
        controller.addEventListener('connected', (event) => {
            console.log(`🎮 Controller ${index} connected:`, event.data.handedness);
            
            const inputSource = event.data;
            const controllerData = this.controllers.get(index);
            
            if (controllerData) {
                controllerData.inputSource = inputSource;
                controllerData.gamepad = inputSource.gamepad;
                
                // Make sure controller is visible
                controller.visible = true;
                
                // Add a visible indicator that controller is connected
                const indicatorGeometry = new THREE.SphereGeometry(0.02, 8, 6);
                const indicatorMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
                const indicator = new THREE.Mesh(indicatorGeometry, indicatorMaterial);
                indicator.position.set(0, 0.05, 0);
                controller.add(indicator);
                controller.connectionIndicator = indicator;
                
                console.log(`✅ Controller ${index} (${inputSource.handedness}) fully connected`);
            }
        });
        
        controller.addEventListener('disconnected', () => {
            console.log(`🎮 Controller ${index} disconnected`);
            
            const controllerData = this.controllers.get(index);
            if (controllerData) {
                controllerData.inputSource = null;
                controllerData.gamepad = null;
                
                // Remove connection indicator
                if (controller.connectionIndicator) {
                    controller.remove(controller.connectionIndicator);
                    controller.connectionIndicator = null;
                }
            }
        });
        
        // Button events with better logging
        controller.addEventListener('selectstart', () => {
            console.log(`🔫 Trigger pressed on controller ${index}`);
            this.onTriggerPress(index);
        });
        
        controller.addEventListener('selectend', () => {
            console.log(`🔫 Trigger released on controller ${index}`);
            this.onTriggerRelease(index);
        });
        
        controller.addEventListener('squeezestart', () => {
            console.log(`✊ Grip pressed on controller ${index}`);
            this.onGripPress(index);
        });
        
        controller.addEventListener('squeezeend', () => {
            console.log(`🖐️ Grip released on controller ${index}`);
            this.onGripRelease(index);
        });
    }
    
    // Input handling with better feedback
    onTriggerPress(controllerIndex) {
        console.log(`🔫 Trigger pressed on controller ${controllerIndex}`);
        
        // Start thruster
        const handKey = controllerIndex === 0 ? 'left' : 'right';
        this.startThruster(handKey);
        
        // Haptic feedback
        this.triggerHaptic(controllerIndex, 0.5, 100);
    }
    
    onTriggerRelease(controllerIndex) {
        console.log(`🔫 Trigger released on controller ${controllerIndex}`);
        
        // Stop thruster
        const handKey = controllerIndex === 0 ? 'left' : 'right';
        this.stopThruster(handKey);
    }
    
    onGripPress(controllerIndex) {
        console.log(`✊ Grip pressed on controller ${controllerIndex}`);
        
        // Try to grab object
        this.attemptGrab(controllerIndex);
        
        // Haptic feedback
        this.triggerHaptic(controllerIndex, 0.7, 150);
    }
    
    onGripRelease(controllerIndex) {
        console.log(`🖐️ Grip released on controller ${controllerIndex}`);
        
        // Release grabbed object
        this.releaseGrabbedObject(controllerIndex);
    }
    
    // Thruster system
    startThruster(hand) {
        if (this.thrusterActive[hand]) return;
        
        this.thrusterActive[hand] = true;
        
        const controllerIndex = hand === 'left' ? 0 : 1;
        const controllerData = this.controllers.get(controllerIndex);
        
        if (controllerData) {
            // Show thruster visual
            if (controllerData.controller.thrusterVisual) {
                controllerData.controller.thrusterVisual.visible = true;
                console.log(`🚀 Thruster visual enabled for ${hand} hand`);
            }
            
            // Start thruster audio
            const thrusterAudio = this.audio.startThrusterAudio(controllerData.controller.position, 1.0);
            this.thrusterAudio[hand] = thrusterAudio;
        }
        
        console.log(`🚀 Thruster ${hand} started`);
    }
    
    stopThruster(hand) {
        if (!this.thrusterActive[hand]) return;
        
        this.thrusterActive[hand] = false;
        
        const controllerIndex = hand === 'left' ? 0 : 1;
        const controllerData = this.controllers.get(controllerIndex);
        
        if (controllerData) {
            // Hide thruster visual
            if (controllerData.controller.thrusterVisual) {
                controllerData.controller.thrusterVisual.visible = false;
                console.log(`🚀 Thruster visual disabled for ${hand} hand`);
            }
        }
        
        // Stop thruster audio
        const thrusterAudio = this.thrusterAudio[hand];
        if (thrusterAudio) {
            this.audio.stopThrusterAudio(thrusterAudio);
            this.thrusterAudio[hand] = null;
        }
        
        console.log(`🚀 Thruster ${hand} stopped`);
    }
    
    stopAllThrusters() {
        this.stopThruster('left');
        this.stopThruster('right');
    }
    
    updateThrusters() {
        if (!this.localPlayer) return;
        
        const dt = 0.016; // 60fps delta time
        
        // Apply thruster forces based on controller directions
        this.applyThrusterForces(dt);
        
        // Update thruster audio positions
        this.updateThrusterAudio();
    }
    
    applyThrusterForces(dt) {
        if (!this.localPlayer) return;
        
        const totalForce = new THREE.Vector3();
        
        // Left hand thruster
        if (this.thrusterActive.left) {
            const leftController = this.controllers.get(0);
            if (leftController) {
                const leftDir = new THREE.Vector3(0, 0, -1);
                leftDir.applyQuaternion(leftController.controller.quaternion);
                leftDir.multiplyScalar(this.thrusterForce * dt);
                totalForce.add(leftDir);
            }
        }
        
        // Right hand thruster
        if (this.thrusterActive.right) {
            const rightController = this.controllers.get(1);
            if (rightController) {
                const rightDir = new THREE.Vector3(0, 0, -1);
                rightDir.applyQuaternion(rightController.controller.quaternion);
                rightDir.multiplyScalar(this.thrusterForce * dt);
                totalForce.add(rightDir);
            }
        }
        
        // Apply total force to player
        if (totalForce.length() > 0) {
            this.physics.applyForce(this.localPlayer.uuid, totalForce);
            
            // Clamp velocity to prevent runaway speed
            this.physics.clampVelocity(this.localPlayer.uuid, window.Constants.PHYSICS.MAX_VELOCITY);
        }
    }
    
    updateThrusterAudio() {
        // Update left thruster audio
        if (this.thrusterActive.left && this.thrusterAudio.left) {
            const leftController = this.controllers.get(0);
            if (leftController) {
                this.audio.updateThrusterAudio(
                    this.thrusterAudio.left,
                    leftController.controller.position,
                    1.0
                );
            }
        }
        
        // Update right thruster audio
        if (this.thrusterActive.right && this.thrusterAudio.right) {
            const rightController = this.controllers.get(1);
            if (rightController) {
                this.audio.updateThrusterAudio(
                    this.thrusterAudio.right,
                    rightController.controller.position,
                    1.0
                );
            }
        }
    }
    
    // Rotation controls using thumbsticks
    updateRotation() {
        if (!this.localPlayer) return;
        
        for (const [index, controllerData] of this.controllers) {
            if (!controllerData.gamepad) continue;
            
            const inputState = this.inputStates.get(index);
            if (!inputState) continue;
            
            // Use thumbstick for rotation
            const thumbstickX = inputState.thumbstick.x;
            
            if (Math.abs(thumbstickX) > 0.1) {
                // Apply rotation to player
                const rotationForce = thumbstickX * this.rotationSpeed * 0.016; // 60fps delta
                
                // Rotate player around Y axis
                this.localPlayer.rotation.y += rotationForce;
                
                // Update physics body rotation if available
                const rigidBody = this.physics.getRigidBody(this.localPlayer.uuid);
                if (rigidBody) {
                    // Apply angular velocity for smooth rotation
                    const angularVelocity = new THREE.Vector3(0, rotationForce * 10, 0);
                    // Note: Rapier angular velocity would need proper implementation
                }
            }
        }
    }
    
    // Grabbing system
    attemptGrab(controllerIndex) {
        const controllerData = this.controllers.get(controllerIndex);
        if (!controllerData || this.grabbedObjects.has(controllerIndex)) return;
        
        // Perform raycast to find grabbable objects
        const raycaster = this.grabRaycasters.get(controllerIndex);
        if (!raycaster) return;
        
        // Update raycaster with controller position and direction
        const controllerPosition = controllerData.controller.position;
        const controllerDirection = new THREE.Vector3(0, 0, -1);
        controllerDirection.applyQuaternion(controllerData.controller.quaternion);
        
        raycaster.set(controllerPosition, controllerDirection);
        
        // Get floating objects to test against
        const floatingObjects = this.world.getFloatingObjects();
        const intersects = raycaster.intersectObjects(floatingObjects);
        
        if (intersects.length > 0) {
            const targetObject = intersects[0].object;
            
            // Check if object is already grabbed by another controller
            let alreadyGrabbed = false;
            for (const [otherIndex, grabbedObject] of this.grabbedObjects) {
                if (grabbedObject === targetObject) {
                    alreadyGrabbed = true;
                    break;
                }
            }
            
            if (!alreadyGrabbed) {
                this.grabObject(controllerIndex, targetObject, intersects[0].point);
            }
        }
    }
    
    grabObject(controllerIndex, object, grabPoint) {
        const controllerData = this.controllers.get(controllerIndex);
        if (!controllerData) return;
        
        // Store grabbed object
        this.grabbedObjects.set(controllerIndex, object);
        
        // Create physics constraint
        if (this.localPlayer) {
            const constraint = this.physics.createGrabConstraint(
                this.localPlayer.uuid,
                object.uuid,
                grabPoint
            );
            
            if (constraint) {
                this.grabConstraints.set(controllerIndex, constraint);
            }
        }
        
        // Visual feedback
        object.material.emissive.setHex(0x444444);
        
        // Audio feedback
        this.audio.playGrabSound(object.position);
        
        // Haptic feedback
        this.triggerHaptic(controllerIndex, 0.7, 150);
        
        console.log(`✋ Object grabbed by controller ${controllerIndex}`);
    }
    
    releaseGrabbedObject(controllerIndex) {
        const grabbedObject = this.grabbedObjects.get(controllerIndex);
        if (!grabbedObject) return;
        
        // Remove physics constraint
        const constraint = this.grabConstraints.get(controllerIndex);
        if (constraint) {
            this.physics.removeConstraint(constraint);
            this.grabConstraints.delete(controllerIndex);
        }
        
        // Reset visual feedback
        grabbedObject.material.emissive.setHex(0x000000);
        
        // Audio feedback
        this.audio.playReleaseSound(grabbedObject.position);
        
        // Remove from grabbed objects
        this.grabbedObjects.delete(controllerIndex);
        
        console.log(`🖐️ Object released by controller ${controllerIndex}`);
    }
    
    // Haptic feedback
    triggerHaptic(controllerIndex, intensity = 0.5, duration = 100) {
        const controllerData = this.controllers.get(controllerIndex);
        if (!controllerData || !controllerData.inputSource) return;
        
        this.audio.triggerHaptic(controllerData.inputSource, intensity, duration);
    }
    
    // Update method (called from main loop)
    update() {
        if (!this.isEnabled || !this.isInitialized) return;
        
        const now = performance.now();
        
        // Update local player reference
        if (!this.localPlayer) {
            this.localPlayer = this.getLocalPlayer();
        }
        
        // Update controller input states
        this.updateInputStates();
        
        // Update thrusters
        this.updateThrusters();
        
        // Update rotation controls
        this.updateRotation();
        
        // Update grabbed objects
        this.updateGrabbedObjects();
        
        // Update audio listener position (use camera/head position)
        this.updateAudioListener();
        
        this.updateCount++;
        this.lastUpdateTime = now;
    }
    
    updateInputStates() {
        for (const [index, controllerData] of this.controllers) {
            if (!controllerData.gamepad) continue;
            
            const currentInput = this.inputStates.get(index);
            const lastInput = this.lastFrameInputs.get(index);
            
            if (!currentInput || !lastInput) continue;
            
            // Copy current to last frame
            lastInput.trigger = currentInput.trigger;
            lastInput.grip = currentInput.grip;
            lastInput.thumbstick.x = currentInput.thumbstick.x;
            lastInput.thumbstick.y = currentInput.thumbstick.y;
            lastInput.wasPressed.trigger = currentInput.wasPressed.trigger;
            lastInput.wasPressed.grip = currentInput.wasPressed.grip;
            
            // Update current input state
            const gamepad = controllerData.gamepad;
            
            // Trigger (index finger)
            const triggerValue = gamepad.buttons[0] ? gamepad.buttons[0].value : 0;
            currentInput.trigger = triggerValue;
            currentInput.wasPressed.trigger = triggerValue > 0.5;
            
            // Grip (middle fingers)
            const gripValue = gamepad.buttons[1] ? gamepad.buttons[1].value : 0;
            currentInput.grip = gripValue;
            currentInput.wasPressed.grip = gripValue > 0.5;
            
            // Thumbstick
            if (gamepad.axes.length >= 2) {
                currentInput.thumbstick.x = gamepad.axes[0];
                currentInput.thumbstick.y = gamepad.axes[1];
            }
            
            // Other buttons
            for (let i = 2; i < gamepad.buttons.length; i++) {
                currentInput.buttons[i] = gamepad.buttons[i] ? gamepad.buttons[i].pressed : false;
            }
            
            // Check for button state changes and trigger events
            if (currentInput.wasPressed.trigger && !lastInput.wasPressed.trigger) {
                this.onTriggerPress(index);
            } else if (!currentInput.wasPressed.trigger && lastInput.wasPressed.trigger) {
                this.onTriggerRelease(index);
            }
            
            if (currentInput.wasPressed.grip && !lastInput.wasPressed.grip) {
                this.onGripPress(index);
            } else if (!currentInput.wasPressed.grip && lastInput.wasPressed.grip) {
                this.onGripRelease(index);
            }
        }
    }
    
    updateGrabbedObjects() {
        for (const [index, grabbedObject] of this.grabbedObjects) {
            const controllerData = this.controllers.get(index);
            if (!controllerData) continue;
            
            // Update object position to follow controller (in case physics constraint fails)
            const controllerPosition = controllerData.controller.position;
            const direction = new THREE.Vector3(0, 0, -0.3);
            direction.applyQuaternion(controllerData.controller.quaternion);
            
            const targetPosition = controllerPosition.clone().add(direction);
            
            // Smoothly move object towards target position
            grabbedObject.position.lerp(targetPosition, 0.1);
        }
    }
    
    updateAudioListener() {
        if (!this.audio) return;
        
        // Use the camera position as the audio listener position
        const camera = this.world.getCamera();
        const position = camera.position;
        
        // Get forward and up vectors from camera
        const forward = new THREE.Vector3(0, 0, -1);
        const up = new THREE.Vector3(0, 1, 0);
        
        forward.applyQuaternion(camera.quaternion);
        up.applyQuaternion(camera.quaternion);
        
        this.audio.updateListener(position, forward, up);
    }
    
    cleanupControllers() {
        // Remove controllers from scene and clean up
        for (const [index, controllerData] of this.controllers) {
            const { controller, controllerGrip } = controllerData;
            
            this.world.getScene().remove(controller);
            this.world.getScene().remove(controllerGrip);
            
            // Release any grabbed objects
            this.releaseGrabbedObject(index);
        }
        
        this.controllers.clear();
        this.inputStates.clear();
        this.lastFrameInputs.clear();
    }
    
    // Public API methods
    enable() {
        this.isEnabled = true;
    }
    
    disable() {
        this.isEnabled = false;
        
        // Stop all thrusters
        this.stopAllThrusters();
        
        // Clean up active states
        this.cleanupControllers();
    }
    
    getControllerCount() {
        return this.controllers.size;
    }
    
    getController(index) {
        return this.controllers.get(index);
    }
    
    isControllerConnected(index) {
        const controllerData = this.controllers.get(index);
        return controllerData && controllerData.inputSource !== null;
    }
    
    getInputState(index) {
        return this.inputStates.get(index);
    }
    
    getStats() {
        return {
            isEnabled: this.isEnabled,
            controllerCount: this.controllers.size,
            activeThrusters: Object.values(this.thrusterActive).filter(active => active).length,
            grabbedObjects: this.grabbedObjects.size,
            updateCount: this.updateCount
        };
    }
    
    // Cleanup
    destroy() {
        this.disable();
        
        // Clean up all resources
        this.controllers.clear();
        this.hands.clear();
        this.grabbedObjects.clear();
        this.grabConstraints.clear();
        this.grabRaycasters.clear();
        this.thrusterAudio = { left: null, right: null };
        this.inputStates.clear();
        this.lastFrameInputs.clear();
        
        console.log('✅ VR Controller System destroyed');
    }
}; 