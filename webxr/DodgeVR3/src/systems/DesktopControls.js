// Zero-G WebXR Multiplayer - Desktop Controls System

window.DesktopControls = class DesktopControls {
    constructor(world, physics, audio) {
        this.world = world;
        this.physics = physics;
        this.audio = audio;
        this.isInitialized = false;
        this.isEnabled = false;
        
        // Camera controls
        this.camera = null;
        this.cameraControls = null;
        
        // Input state
        this.keys = {};
        this.mouse = {
            x: 0,
            y: 0,
            buttons: {}
        };
        
        // Movement state
        this.moveDirection = new THREE.Vector3();
        this.thrusterActive = false;
        this.thrusterAudio = null;
        
        // Interaction
        this.raycaster = new THREE.Raycaster();
        this.grabbedObject = null;
        this.grabConstraint = null;
        this.grabDistance = 2.0;
        
        // Settings
        this.sensitivity = 0.002;
        this.moveSpeed = 1.0;
        this.dampingFactor = 0.95;
        
        // Performance tracking
        this.updateCount = 0;
        this.lastUpdateTime = 0;
    }
    
    async init() {
        try {
            console.log('🖱️ Initializing Desktop Controls...');
            
            this.camera = this.world.getCamera();
            
            // Setup orbit controls for mouse look
            this.initCameraControls();
            
            // Setup event listeners
            this.setupEventListeners();
            
            // Initialize raycaster
            this.raycaster.far = 50;
            
            this.isInitialized = true;
            console.log('✅ Desktop Controls initialized');
            
        } catch (error) {
            console.error('❌ Failed to initialize desktop controls:', error);
            throw error;
        }
    }
    
    initCameraControls() {
        // Use OrbitControls for camera movement
        this.cameraControls = new THREE.OrbitControls(this.camera, this.world.getRenderer().domElement);
        
        // Configure controls for zero-g feel
        this.cameraControls.enableDamping = true;
        this.cameraControls.dampingFactor = 0.05;
        this.cameraControls.enableZoom = true;
        this.cameraControls.enablePan = true;
        this.cameraControls.enableRotate = true;
        
        // Set rotation speed
        this.cameraControls.rotateSpeed = 0.5;
        this.cameraControls.panSpeed = 0.8;
        this.cameraControls.zoomSpeed = 1.2;
        
        // Set limits
        this.cameraControls.minDistance = 1;
        this.cameraControls.maxDistance = 100;
        
        // No auto-rotate
        this.cameraControls.autoRotate = false;
        
        console.log('✅ Camera controls initialized');
    }
    
    setupEventListeners() {
        // Keyboard events
        document.addEventListener('keydown', this.onKeyDown.bind(this));
        document.addEventListener('keyup', this.onKeyUp.bind(this));
        
        // Mouse events
        document.addEventListener('mousedown', this.onMouseDown.bind(this));
        document.addEventListener('mouseup', this.onMouseUp.bind(this));
        document.addEventListener('mousemove', this.onMouseMove.bind(this));
        document.addEventListener('wheel', this.onMouseWheel.bind(this));
        
        // Focus events
        window.addEventListener('blur', this.onWindowBlur.bind(this));
        
        // Pointer lock events
        document.addEventListener('pointerlockchange', this.onPointerLockChange.bind(this));
        
        console.log('✅ Event listeners setup');
    }
    
    // Event handlers
    onKeyDown(event) {
        if (!this.isEnabled) return;
        
        this.keys[event.code] = true;
        
        // Handle special keys
        switch (event.code) {
            case 'KeyE':
                // Interact/grab
                if (!event.repeat) {
                    this.handleInteraction();
                }
                break;
            case 'KeyR':
                // Release grabbed object
                if (!event.repeat) {
                    this.releaseGrabbedObject();
                }
                break;
            case 'KeyF':
                // Toggle pointer lock
                if (!event.repeat) {
                    this.togglePointerLock();
                }
                break;
            case 'Escape':
                // Exit pointer lock
                if (document.pointerLockElement) {
                    document.exitPointerLock();
                }
                break;
        }
        
        // Prevent default for movement keys
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
            event.preventDefault();
        }
    }
    
    onKeyUp(event) {
        if (!this.isEnabled) return;
        
        this.keys[event.code] = false;
    }
    
    onMouseDown(event) {
        if (!this.isEnabled) return;
        
        this.mouse.buttons[event.button] = true;
        
        // Left click - grab object
        if (event.button === 0) {
            this.handleMouseGrab(event);
        }
        
        // Right click - request pointer lock
        if (event.button === 2) {
            this.requestPointerLock();
        }
    }
    
    onMouseUp(event) {
        if (!this.isEnabled) return;
        
        this.mouse.buttons[event.button] = false;
        
        // Left click release - release object
        if (event.button === 0 && this.grabbedObject) {
            this.releaseGrabbedObject();
        }
    }
    
    onMouseMove(event) {
        if (!this.isEnabled) return;
        
        this.mouse.x = event.clientX;
        this.mouse.y = event.clientY;
        
        // Handle pointer lock movement
        if (document.pointerLockElement) {
            this.handlePointerLockMovement(event);
        }
    }
    
    onMouseWheel(event) {
        if (!this.isEnabled) return;
        
        // Zoom with mouse wheel (handled by OrbitControls)
        event.preventDefault();
    }
    
    onWindowBlur() {
        // Clear all keys when window loses focus
        this.keys = {};
        this.mouse.buttons = {};
        this.stopThrusters();
    }
    
    onPointerLockChange() {
        if (document.pointerLockElement) {
            console.log('🔒 Pointer lock enabled');
            // Disable orbit controls when in pointer lock
            this.cameraControls.enabled = false;
        } else {
            console.log('🔓 Pointer lock disabled');
            // Re-enable orbit controls
            this.cameraControls.enabled = true;
        }
    }
    
    // Pointer lock handling
    requestPointerLock() {
        const canvas = this.world.getRenderer().domElement;
        canvas.requestPointerLock = canvas.requestPointerLock || 
                                   canvas.mozRequestPointerLock || 
                                   canvas.webkitRequestPointerLock;
        
        if (canvas.requestPointerLock) {
            canvas.requestPointerLock();
        }
    }
    
    togglePointerLock() {
        if (document.pointerLockElement) {
            document.exitPointerLock();
        } else {
            this.requestPointerLock();
        }
    }
    
    handlePointerLockMovement(event) {
        const movementX = event.movementX || event.mozMovementX || event.webkitMovementX || 0;
        const movementY = event.movementY || event.mozMovementY || event.webkitMovementY || 0;
        
        // Rotate camera based on mouse movement
        this.camera.rotation.y -= movementX * this.sensitivity;
        this.camera.rotation.x -= movementY * this.sensitivity;
        
        // Clamp vertical rotation
        this.camera.rotation.x = Math.max(-Math.PI/2, Math.min(Math.PI/2, this.camera.rotation.x));
    }
    
    // Movement handling
    updateMovement() {
        if (!this.isEnabled) return;
        
        // Reset movement direction
        this.moveDirection.set(0, 0, 0);
        
        // Calculate movement based on camera orientation
        const forward = new THREE.Vector3(0, 0, -1);
        const right = new THREE.Vector3(1, 0, 0);
        const up = new THREE.Vector3(0, 1, 0);
        
        // Apply camera rotation to movement vectors
        forward.applyQuaternion(this.camera.quaternion);
        right.applyQuaternion(this.camera.quaternion);
        up.applyQuaternion(this.camera.quaternion);
        
        // WASD movement
        if (this.keys['KeyW']) this.moveDirection.add(forward);
        if (this.keys['KeyS']) this.moveDirection.sub(forward);
        if (this.keys['KeyA']) this.moveDirection.sub(right);
        if (this.keys['KeyD']) this.moveDirection.add(right);
        
        // Vertical movement
        if (this.keys['Space']) this.moveDirection.add(up);
        if (this.keys['ShiftLeft'] || this.keys['ShiftRight']) this.moveDirection.sub(up);
        
        // Normalize movement direction
        if (this.moveDirection.length() > 0) {
            this.moveDirection.normalize();
            
            // Apply thruster force
            this.applyMovementForce();
            
            // Start thruster audio if not already active
            if (!this.thrusterActive) {
                this.startThrusters();
            }
        } else {
            // Stop thrusters if no movement input
            if (this.thrusterActive) {
                this.stopThrusters();
            }
        }
    }
    
    applyMovementForce() {
        // Get local player
        const localPlayer = this.getLocalPlayer();
        if (!localPlayer) return;
        
        // Calculate thrust force
        const thrustForce = this.moveDirection.clone();
        thrustForce.multiplyScalar(window.Constants.PHYSICS.THRUST_FORCE * this.moveSpeed);
        
        // Apply force to player
        this.physics.applyForce(localPlayer.uuid, thrustForce);
        
        // Clamp velocity to prevent runaway speed
        this.physics.clampVelocity(localPlayer.uuid, window.Constants.PHYSICS.MAX_VELOCITY);
    }
    
    startThrusters() {
        this.thrusterActive = true;
        
        // Start thruster audio
        const localPlayer = this.getLocalPlayer();
        if (localPlayer && this.audio) {
            this.thrusterAudio = this.audio.startThrusterAudio(localPlayer.position, 0.8);
        }
    }
    
    stopThrusters() {
        this.thrusterActive = false;
        
        // Stop thruster audio
        if (this.thrusterAudio && this.audio) {
            this.audio.stopThrusterAudio(this.thrusterAudio);
            this.thrusterAudio = null;
        }
    }
    
    updateThrusters() {
        if (this.thrusterActive && this.thrusterAudio) {
            const localPlayer = this.getLocalPlayer();
            if (localPlayer) {
                // Update thruster audio position
                this.audio.updateThrusterAudio(this.thrusterAudio, localPlayer.position, 0.8);
            }
        }
    }
    
    // Interaction handling
    handleInteraction() {
        // Get mouse position in normalized device coordinates
        const mouse = new THREE.Vector2();
        mouse.x = (this.mouse.x / window.innerWidth) * 2 - 1;
        mouse.y = -(this.mouse.y / window.innerHeight) * 2 + 1;
        
        // Update raycaster
        this.raycaster.setFromCamera(mouse, this.camera);
        
        // Check for objects to grab
        const floatingObjects = this.world.getFloatingObjects();
        const intersects = this.raycaster.intersectObjects(floatingObjects);
        
        if (intersects.length > 0) {
            const targetObject = intersects[0].object;
            const distance = intersects[0].distance;
            
            if (distance <= this.grabDistance) {
                this.grabObject(targetObject, intersects[0].point);
            }
        }
    }
    
    handleMouseGrab(event) {
        // Calculate mouse position
        const mouse = new THREE.Vector2();
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
        
        // Update raycaster
        this.raycaster.setFromCamera(mouse, this.camera);
        
        // Check for objects to grab
        const floatingObjects = this.world.getFloatingObjects();
        const intersects = this.raycaster.intersectObjects(floatingObjects);
        
        if (intersects.length > 0) {
            const targetObject = intersects[0].object;
            const distance = intersects[0].distance;
            
            if (distance <= this.grabDistance && !this.grabbedObject) {
                this.grabObject(targetObject, intersects[0].point);
            }
        }
    }
    
    grabObject(object, grabPoint) {
        if (this.grabbedObject) return;
        
        const localPlayer = this.getLocalPlayer();
        if (!localPlayer) return;
        
        this.grabbedObject = object;
        
        // Create physics constraint
        this.grabConstraint = this.physics.createGrabConstraint(
            localPlayer.uuid,
            object.uuid,
            grabPoint
        );
        
        // Visual feedback
        object.material.emissive.setHex(0x444444);
        
        // Audio feedback
        if (this.audio) {
            this.audio.playGrabSound(object.position);
        }
        
        console.log('✋ Object grabbed with mouse');
    }
    
    releaseGrabbedObject() {
        if (!this.grabbedObject) return;
        
        // Remove physics constraint
        if (this.grabConstraint) {
            this.physics.removeConstraint(this.grabConstraint);
            this.grabConstraint = null;
        }
        
        // Reset visual feedback
        this.grabbedObject.material.emissive.setHex(0x000000);
        
        // Audio feedback
        if (this.audio) {
            this.audio.playReleaseSound(this.grabbedObject.position);
        }
        
        this.grabbedObject = null;
        
        console.log('🖐️ Object released');
    }
    
    updateGrabbedObject() {
        if (!this.grabbedObject) return;
        
        // Calculate target position for grabbed object
        const cameraDirection = new THREE.Vector3(0, 0, -1);
        cameraDirection.applyQuaternion(this.camera.quaternion);
        
        const targetPosition = this.camera.position.clone();
        targetPosition.add(cameraDirection.multiplyScalar(this.grabDistance));
        
        // Smoothly move object towards target position
        this.grabbedObject.position.lerp(targetPosition, 0.1);
    }
    
    // Helper methods
    getLocalPlayer() {
        // This should be set by the network manager or main app
        // For now, we'll try to find the local player
        const players = this.world.getAllPlayers();
        return players.length > 0 ? players[0] : null;
    }
    
    // Update method (called from main loop)
    update() {
        if (!this.isEnabled || !this.isInitialized) return;
        
        const now = performance.now();
        
        // Update camera controls
        if (this.cameraControls && this.cameraControls.enabled) {
            this.cameraControls.update();
        }
        
        // Update movement
        this.updateMovement();
        
        // Update thrusters
        this.updateThrusters();
        
        // Update grabbed object
        this.updateGrabbedObject();
        
        // Update audio listener position
        this.updateAudioListener();
        
        this.updateCount++;
        this.lastUpdateTime = now;
    }
    
    updateAudioListener() {
        if (!this.audio) return;
        
        // Use camera position and orientation for audio
        const position = this.camera.position;
        
        // Get forward and up vectors from camera
        const forward = new THREE.Vector3(0, 0, -1);
        const up = new THREE.Vector3(0, 1, 0);
        
        forward.applyQuaternion(this.camera.quaternion);
        up.applyQuaternion(this.camera.quaternion);
        
        this.audio.updateListener(position, forward, up);
    }
    
    // Settings
    setSensitivity(sensitivity) {
        this.sensitivity = Math.max(0.0001, Math.min(0.01, sensitivity));
    }
    
    setMoveSpeed(speed) {
        this.moveSpeed = Math.max(0.1, Math.min(5.0, speed));
    }
    
    setGrabDistance(distance) {
        this.grabDistance = Math.max(1.0, Math.min(10.0, distance));
    }
    
    // Public API methods
    enable() {
        this.isEnabled = true;
        
        // Enable camera controls
        if (this.cameraControls) {
            this.cameraControls.enabled = true;
        }
        
        console.log('🖱️ Desktop controls enabled');
    }
    
    disable() {
        this.isEnabled = false;
        
        // Clear input states
        this.keys = {};
        this.mouse.buttons = {};
        
        // Stop thrusters
        this.stopThrusters();
        
        // Release grabbed object
        this.releaseGrabbedObject();
        
        // Disable camera controls
        if (this.cameraControls) {
            this.cameraControls.enabled = false;
        }
        
        // Exit pointer lock
        if (document.pointerLockElement) {
            document.exitPointerLock();
        }
        
        console.log('🖱️ Desktop controls disabled');
    }
    
    getInputState() {
        return {
            keys: { ...this.keys },
            mouse: { ...this.mouse },
            grabbedObject: this.grabbedObject ? this.grabbedObject.uuid : null,
            thrusterActive: this.thrusterActive
        };
    }
    
    getStats() {
        return {
            isEnabled: this.isEnabled,
            pointerLocked: !!document.pointerLockElement,
            grabbedObject: !!this.grabbedObject,
            thrusterActive: this.thrusterActive,
            updateCount: this.updateCount,
            cameraPosition: this.camera.position.clone(),
            cameraRotation: this.camera.rotation.clone()
        };
    }
    
    // Cleanup
    destroy() {
        this.disable();
        
        // Remove event listeners
        document.removeEventListener('keydown', this.onKeyDown);
        document.removeEventListener('keyup', this.onKeyUp);
        document.removeEventListener('mousedown', this.onMouseDown);
        document.removeEventListener('mouseup', this.onMouseUp);
        document.removeEventListener('mousemove', this.onMouseMove);
        document.removeEventListener('wheel', this.onMouseWheel);
        window.removeEventListener('blur', this.onWindowBlur);
        document.removeEventListener('pointerlockchange', this.onPointerLockChange);
        
        // Dispose camera controls
        if (this.cameraControls) {
            this.cameraControls.dispose();
        }
        
        console.log('✅ Desktop Controls destroyed');
    }
}; 