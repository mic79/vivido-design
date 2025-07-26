/**
 * Interaction System for WebXR Zero-G Environment
 * VR hand tracking, grabbing mechanics, and thruster controls
 */

/**
 * Hand Interaction Component
 * Handles VR controller input and object interaction
 */
AFRAME.registerComponent('hand-interaction', {
    schema: {
        hand: { type: 'string', default: 'left' }
    },

    init: function() {
        this.hand = this.el;
        this.handKey = this.data.hand;
        
        // Interaction state
        this.isGripPressed = false;
        this.isTriggerPressed = false;
        this.grabbedObject = null;
        this.thrusterActive = false;
        
        // Velocity tracking for throwing
        this.velocityHistory = [];
        this.maxHistorySize = 5;
        this.lastPosition = new THREE.Vector3();
        this.lastTime = 0;
        
        this.setupEventListeners();
        
        DebugUtils.log('INTERACTION', `Hand interaction initialized for ${this.handKey} hand`);
    },

    setupEventListeners: function() {
        // Grip controls for grabbing
        this.el.addEventListener('gripdown', (event) => {
            this.onGripDown();
        });
        
        this.el.addEventListener('gripup', (event) => {
            this.onGripUp();
        });
        
        // Trigger controls for thrusters
        this.el.addEventListener('triggerdown', (event) => {
            this.onTriggerDown();
        });
        
        this.el.addEventListener('triggerup', (event) => {
            this.onTriggerUp();
        });
        
        // Additional controller events
        this.el.addEventListener('thumbstickdown', (event) => {
            this.onThumbstickDown();
        });
        
        // Handle thumbstick movement for different controller types
        this.el.addEventListener('thumbstickmoved', (event) => {
            this.onThumbstickMoved(event.detail);
        });
        
        this.el.addEventListener('axismove', (event) => {
            // Handle Meta Touch controller thumbstick
            if (event.detail.axis && event.detail.axis[0] !== undefined) {
                this.onThumbstickMoved({ x: event.detail.axis[0], y: event.detail.axis[1] || 0 });
            }
        });
        
        this.el.addEventListener('abuttondown', (event) => {
            this.onAButtonDown();
        });
        
        // X button shooting handled at scene level in player component
    },

    onGripDown: function() {
        this.isGripPressed = true;
        
        DebugUtils.log('INTERACTION', `${this.handKey} grip pressed`);
        
        // Small delay to prevent immediate re-grab after release
        setTimeout(() => {
            if (this.isGripPressed) { // Only grab if grip is still held
                this.attemptGrab();
            }
        }, 50);
        
        // Haptic feedback
        ControllerUtils.playHaptic(this.hand, 0.5, 100);
    },

    onGripUp: function() {
        this.isGripPressed = false;
        
        DebugUtils.log('INTERACTION', `${this.handKey} grip released`);
        
        // Release grabbed object
        if (this.grabbedObject) {
            this.releaseObject();
            
            // Also notify player controller about release
            this.notifyPlayerController('grab', false);
        }
    },

    onTriggerDown: function() {
        this.isTriggerPressed = true;
        this.thrusterActive = true;
        
        DebugUtils.log('INTERACTION', `${this.handKey} thruster activated`);
        
        // Show thruster effect
        this.showThrusterEffect();
        
        // Notify player controller
        this.notifyPlayerController('thruster', true);
        
        // Light haptic feedback for thruster activation
        ControllerUtils.playHaptic(this.hand, 0.3, 50);
    },

    onTriggerUp: function() {
        this.isTriggerPressed = false;
        this.thrusterActive = false;
        
        DebugUtils.log('INTERACTION', `${this.handKey} thruster deactivated`);
        
        // Hide thruster effect
        this.hideThrusterEffect();
        
        // Notify player controller
        this.notifyPlayerController('thruster', false);
    },

    onThumbstickDown: function() {
        // Emergency brake / stop movement
        DebugUtils.log('INTERACTION', `${this.handKey} thumbstick pressed - emergency brake`);
        
        // Notify player controller for braking
        this.notifyPlayerController('brake', true);
        
        // Strong haptic feedback for emergency action
        ControllerUtils.playHaptic(this.hand, 0.8, 200);
    },

    onThumbstickMoved: function(detail) {
        // Use right thumbstick for rotation, left for other controls
        if (this.handKey === 'right' && detail.x !== undefined) {
            DebugUtils.log('INTERACTION', `Right thumbstick moved: ${detail.x.toFixed(2)}`);
            this.notifyPlayerController('rotation', detail.x);
        }
    },

    onAButtonDown: function() {
        // Toggle collision visualization or other debug features
        if (window.ZeroGState.debugMode) {
            DebugUtils.log('INTERACTION', 'A button pressed - debug action');
        }
    },
    
    // onXButtonDown removed - now handled at scene level in player component

    attemptGrab: function() {
        if (this.grabbedObject) {
            DebugUtils.log('INTERACTION', `${this.handKey} already grabbing:`, this.grabbedObject.tagName);
            return; // Already grabbing something
        }
        
        const handPosition = ControllerUtils.getWorldPosition(this.hand);
        const grabRadius = 0.4; // 40cm grab radius (increased for easier grabbing)
        
        // Find nearby grabbable objects
        const grabbableObjects = document.querySelectorAll('[grab-surface], [grabbable-ball]');
        let nearestObject = null;
        let nearestDistance = Infinity;
        
        DebugUtils.log('INTERACTION', `${this.handKey} checking ${grabbableObjects.length} grabbable objects`);
        
        // Debug: List grabbable objects occasionally  
        if (Math.random() < 0.1) {
            console.log(`🔍 ${this.handKey} checking ${grabbableObjects.length} grabbable objects`);
        }
        
        grabbableObjects.forEach(object => {
            const objectPosition = new THREE.Vector3();
            object.object3D.getWorldPosition(objectPosition);
            
            const distance = handPosition.distanceTo(objectPosition);
            
            if (distance <= grabRadius) {
                DebugUtils.log('INTERACTION', `${this.handKey} object in range:`, object.tagName, `distance: ${distance.toFixed(2)}m`);
                if (distance < nearestDistance) {
                    nearestDistance = distance;
                    nearestObject = object;
                }
            }
        });
        
        if (nearestObject) {
            DebugUtils.log('INTERACTION', `${this.handKey} grabbing nearest:`, nearestObject.tagName, `at ${nearestDistance.toFixed(2)}m`);
            this.grabObject(nearestObject);
            // Notify player controller about grab state with object info
            this.notifyPlayerController('grab', true, nearestObject);
        } else {
            // Check if environment grabbing is possible via hand collision detection
            this.attemptEnvironmentGrab();
        }
    },

    attemptEnvironmentGrab: function() {
        // No longer needed - grip handling is now done directly in player controller
    },

    grabObject: function(object) {
        this.grabbedObject = object;
        
        DebugUtils.log('INTERACTION', `${this.handKey} hand grabbed:`, object.tagName);
        
        // Initialize velocity tracking
        this.velocityHistory = [];
        this.lastPosition.copy(ControllerUtils.getWorldPosition(this.hand));
        this.lastTime = performance.now();
        
        // Notify the object it's being grabbed
        if (object.components['grabbable-ball']) {
            DebugUtils.log('INTERACTION', `Calling ball onGrab for ${this.handKey} hand`);
            object.components['grabbable-ball'].onGrab(this.hand);
        } else if (object.components['grab-surface']) {
            DebugUtils.log('INTERACTION', `Calling surface onGrab for ${this.handKey} hand`);
            object.components['grab-surface'].onGrab(this.hand);
        } else {
            DebugUtils.log('INTERACTION', `ERROR: Object has no grabbable component!`, object.tagName);
        }
        
        // Visual feedback
        this.setObjectGrabVisual(object, true);
        
        // Strong haptic feedback for successful grab
        ControllerUtils.playHaptic(this.hand, 0.7, 150);
    },

    releaseObject: function() {
        if (!this.grabbedObject) return;
        
        // Handle environment release differently
        if (this.grabbedObject === 'environment') {
            DebugUtils.log('INTERACTION', `${this.handKey} hand released environment grab`);
        } else {
            DebugUtils.log('INTERACTION', `${this.handKey} hand released:`, this.grabbedObject.tagName);
            
            // Calculate throw velocity from hand movement
            const throwVelocity = ZeroGMath.calculateThrowVelocity(this.velocityHistory);
            
            // Notify the object it's being released
            if (this.grabbedObject.components['grabbable-ball']) {
                this.grabbedObject.components['grabbable-ball'].onRelease(throwVelocity);
            } else if (this.grabbedObject.components['grab-surface']) {
                this.grabbedObject.components['grab-surface'].onRelease(this.hand);
            }
            
            // Visual feedback
            this.setObjectGrabVisual(this.grabbedObject, false);
        }
        
        // Clear grabbed object reference
        this.grabbedObject = null;
        this.velocityHistory = [];
        
        // Notify player controller about grab release
        this.notifyPlayerController('grab', false);
        
        // Light haptic feedback for release
        ControllerUtils.playHaptic(this.hand, 0.2, 50);
    },

    setObjectGrabVisual: function(object, isGrabbed) {
        // Change object appearance when grabbed
        const material = object.getAttribute('material') || {};
        
        if (isGrabbed) {
            // Brighten and add glow effect when grabbed
            object.setAttribute('material', {
                ...material,
                emissive: '#ffffff',
                emissiveIntensity: 0.2
            });
        } else {
            // Restore original appearance
            object.setAttribute('material', {
                ...material,
                emissive: material.originalEmissive || '#000000',
                emissiveIntensity: material.originalEmissiveIntensity || 0
            });
        }
    },

    showThrusterEffect: function() {
        const thrusterVFX = this.hand.querySelector('.thruster-vfx');
        if (thrusterVFX) {
            thrusterVFX.setAttribute('visible', true);
            thrusterVFX.setAttribute('material', 'opacity', 0.8);
        }
    },

    hideThrusterEffect: function() {
        const thrusterVFX = this.hand.querySelector('.thruster-vfx');
        if (thrusterVFX) {
            thrusterVFX.setAttribute('visible', false);
        }
    },

    notifyPlayerController: function(action, state, extraData = null) {
        // Find the player controller and notify it of hand actions
        const player = document.querySelector('[zerog-player]');
        if (player && player.components['zerog-player']) {
            const playerComponent = player.components['zerog-player'];
            
            switch(action) {
                case 'thruster':
                    playerComponent.setThrusterState(this.handKey, state);
                    break;
                case 'brake':
                    if (state) {
                        playerComponent.activateBraking();
                    }
                    break;
                case 'grab':
                    playerComponent.setGrabState(this.handKey, state, extraData);
                    break;
                case 'rotation':
                    playerComponent.setThumbstickRotation(this.handKey, state);
                    break;
            }
        }
    },

    tick: function() {
        // Update velocity tracking for grabbed objects
        if (this.grabbedObject && this.isGripPressed) {
            this.updateVelocityTracking();
        }
        
        // Update grab proximity indicators
        this.updateGrabIndicators();
    },

    updateVelocityTracking: function() {
        const currentTime = performance.now();
        const currentPosition = ControllerUtils.getWorldPosition(this.hand);
        
        if (this.lastTime > 0) {
            const deltaTime = Math.max((currentTime - this.lastTime) / 1000, 0.001);
            const displacement = new THREE.Vector3().subVectors(currentPosition, this.lastPosition);
            const velocity = displacement.divideScalar(deltaTime);
            
            this.velocityHistory.push(velocity.clone());
            if (this.velocityHistory.length > this.maxHistorySize) {
                this.velocityHistory.shift();
            }
        }
        
        this.lastPosition.copy(currentPosition);
        this.lastTime = currentTime;
    },

    updateGrabIndicators: function() {
        if (this.grabbedObject) return; // Don't show indicators when already grabbing
        
        const handPosition = ControllerUtils.getWorldPosition(this.hand);
        const grabRadius = 0.15;
        
        // Find objects in grab range and highlight them
        const grabbableObjects = document.querySelectorAll('[grab-surface], [grabbable-ball]');
        
        grabbableObjects.forEach(object => {
            const objectPosition = new THREE.Vector3();
            object.object3D.getWorldPosition(objectPosition);
            
            const distance = handPosition.distanceTo(objectPosition);
            const isInRange = distance <= grabRadius;
            
            // Visual feedback for grabbable objects in range
            if (isInRange && !object.classList.contains('being-grabbed')) {
                this.setObjectHighlight(object, true);
            } else if (!isInRange) {
                this.setObjectHighlight(object, false);
            }
        });
    },

    setObjectHighlight: function(object, highlighted) {
        if (highlighted) {
            object.setAttribute('material', 'color', '#00ff00');
            object.classList.add('grab-highlighted');
        } else {
            object.setAttribute('material', 'color', object.getAttribute('data-original-color') || '#ffffff');
            object.classList.remove('grab-highlighted');
        }
    },

    remove: function() {
        // Clean up when component is removed
        if (this.grabbedObject) {
            this.releaseObject();
        }
    }
});

/**
 * Proximity Indicator Component
 * Shows visual feedback for interactive objects near hands
 */
AFRAME.registerComponent('proximity-indicator', {
    init: function() {
        this.hands = [];
        this.indicators = new Map();
        
        // Wait for hands to be available
        this.el.sceneEl.addEventListener('loaded', () => {
            this.hands = [
                document.querySelector('#leftHand'),
                document.querySelector('#rightHand')
            ].filter(hand => hand !== null);
            
            this.setupIndicators();
        });
    },

    setupIndicators: function() {
        // Create proximity indicators for each hand
        this.hands.forEach((hand, index) => {
            const indicator = document.createElement('a-ring');
            indicator.setAttribute('geometry', {
                radiusInner: 0.05,
                radiusOuter: 0.07,
                segmentsTheta: 16
            });
            indicator.setAttribute('material', {
                color: '#00ff00',
                transparent: true,
                opacity: 0,
                side: 'double'
            });
            indicator.setAttribute('position', '0 0 0');
            
            hand.appendChild(indicator);
            this.indicators.set(hand, indicator);
        });
    },

    tick: function() {
        if (!this.hands.length) return;
        
        // Update proximity indicators
        this.hands.forEach(hand => {
            this.updateProximityIndicator(hand);
        });
    },

    updateProximityIndicator: function(hand) {
        const indicator = this.indicators.get(hand);
        if (!indicator) return;
        
        const handPosition = ControllerUtils.getWorldPosition(hand);
        const grabRadius = 0.15;
        
        // Find nearest grabbable object
        const grabbableObjects = document.querySelectorAll('[grab-surface], [grabbable-ball]');
        let nearestDistance = Infinity;
        let hasNearbyObject = false;
        
        grabbableObjects.forEach(object => {
            const objectPosition = new THREE.Vector3();
            object.object3D.getWorldPosition(objectPosition);
            
            const distance = handPosition.distanceTo(objectPosition);
            
            if (distance <= grabRadius) {
                hasNearbyObject = true;
                nearestDistance = Math.min(nearestDistance, distance);
            }
        });
        
        // Update indicator based on proximity
        if (hasNearbyObject) {
            const opacity = 1 - (nearestDistance / grabRadius);
            indicator.setAttribute('material', 'opacity', opacity * 0.7);
            
            // Change color based on distance
            const hue = (nearestDistance / grabRadius) * 120; // Green to red
            const color = `hsl(${hue}, 100%, 50%)`;
            indicator.setAttribute('material', 'color', color);
        } else {
            indicator.setAttribute('material', 'opacity', 0);
        }
    }
});

/**
 * Hand Position Tracker Component
 * Tracks hand positions for physics calculations
 */
AFRAME.registerComponent('hand-position-tracker', {
    init: function() {
        this.leftHand = null;
        this.rightHand = null;
        this.handPositions = {
            left: new THREE.Vector3(),
            right: new THREE.Vector3()
        };
        this.handVelocities = {
            left: new THREE.Vector3(),
            right: new THREE.Vector3()
        };
        this.lastPositions = {
            left: new THREE.Vector3(),
            right: new THREE.Vector3()
        };
        this.lastTime = 0;
        
        // Get hand references when scene loads
        this.el.sceneEl.addEventListener('loaded', () => {
            this.leftHand = document.querySelector('#leftHand');
            this.rightHand = document.querySelector('#rightHand');
        });
    },

    tick: function() {
        if (!this.leftHand || !this.rightHand) return;
        
        const currentTime = performance.now();
        
        // Update hand positions
        this.leftHand.object3D.getWorldPosition(this.handPositions.left);
        this.rightHand.object3D.getWorldPosition(this.handPositions.right);
        
        // Calculate velocities
        if (this.lastTime > 0) {
            const deltaTime = (currentTime - this.lastTime) / 1000;
            
            if (deltaTime > 0) {
                this.handVelocities.left.subVectors(this.handPositions.left, this.lastPositions.left)
                                        .divideScalar(deltaTime);
                this.handVelocities.right.subVectors(this.handPositions.right, this.lastPositions.right)
                                         .divideScalar(deltaTime);
            }
        }
        
        // Store for next frame
        this.lastPositions.left.copy(this.handPositions.left);
        this.lastPositions.right.copy(this.handPositions.right);
        this.lastTime = currentTime;
        
        // Make data available globally
        window.ZeroGState.handData = {
            positions: this.handPositions,
            velocities: this.handVelocities
        };
    },

    getHandPosition: function(hand) {
        return hand === 'left' ? this.handPositions.left : this.handPositions.right;
    },

    getHandVelocity: function(hand) {
        return hand === 'left' ? this.handVelocities.left : this.handVelocities.right;
    }
});

// Auto-attach interaction components to scene
document.addEventListener('DOMContentLoaded', function() {
    const scene = document.querySelector('a-scene');
    if (scene && !scene.hasAttribute('proximity-indicator')) {
        scene.setAttribute('proximity-indicator', '');
    }
    if (scene && !scene.hasAttribute('hand-position-tracker')) {
        scene.setAttribute('hand-position-tracker', '');
    }
    
    DebugUtils.log('INTERACTION', 'Interaction system initialized');
}); 