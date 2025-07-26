/**
 * Environment System for WebXR Zero-G Environment
 * Static surfaces, collision objects, and grabbable environment elements
 */

/**
 * Grab Surface Component
 * Creates static surfaces that players can grab and push off from
 */
AFRAME.registerComponent('grab-surface', {
    schema: {
        type: { type: 'string', default: 'static' }, // static, dynamic
        friction: { type: 'number', default: 0.8 },
        restitution: { type: 'number', default: 0.3 },
        strength: { type: 'number', default: 1.0 }, // Grabbing strength multiplier
        grabbable: { type: 'boolean', default: true }
    },

    init: function() {
        DebugUtils.log('ENVIRONMENT', 'Initializing grab surface:', this.el.tagName);
        
        // Wait for physics world
        this.waitForPhysics();
        
        // Surface state
        this.physicsBody = null;
        this.isBeingGrabbed = false;
        this.grabbingHands = new Set();
        
        // Visual state
        this.originalMaterial = null;
        this.storeOriginalMaterial();
        
        // Mark as grabbable
        this.el.classList.add('grabbable-surface');
    },

    waitForPhysics: function() {
        if (!window.PhysicsWorld) {
            setTimeout(() => this.waitForPhysics(), 100);
            return;
        }
        this.setupPhysics();
    },

    storeOriginalMaterial: function() {
        this.originalMaterial = this.el.getAttribute('material') || {};
        
        // Store original color for restoration
        if (!this.originalMaterial.originalColor) {
            this.originalMaterial.originalColor = this.originalMaterial.color || '#ffffff';
        }
    },

    setupPhysics: function() {
        if (!window.PhysicsWorld) {
            DebugUtils.log('ENVIRONMENT', 'Physics world not ready, retrying...');
            setTimeout(() => this.setupPhysics(), 100);
            return;
        }

        // Get geometry information
        const geometry = this.el.getAttribute('geometry');
        if (!geometry) {
            DebugUtils.log('ENVIRONMENT', 'No geometry found for surface, skipping physics');
            return;
        }

        // Create appropriate collision shape
        let shape = null;
        
        switch (geometry.primitive) {
            case 'box':
                shape = window.PhysicsWorld.createBoxShape(
                    geometry.width || 1,
                    geometry.height || 1,
                    geometry.depth || 1
                );
                break;
                
            case 'sphere':
                shape = window.PhysicsWorld.createSphereShape(geometry.radius || 0.5);
                break;
                
            case 'cylinder':
                shape = window.PhysicsWorld.createCylinderShape(
                    geometry.radius || 0.5,
                    geometry.height || 1
                );
                break;
                
            default:
                DebugUtils.log('ENVIRONMENT', `Unsupported geometry type: ${geometry.primitive}`);
                return;
        }

        // Create static physics body with proper collision groups
        // Group 4: Static surfaces, Mask: -1 (collide with everything)
        this.physicsBody = window.PhysicsWorld.createStaticMeshBody(this.el.object3D, shape, 4, -1);
        
        // Set custom surface properties
        this.physicsBody.setFriction(this.data.friction);
        this.physicsBody.setRestitution(this.data.restitution);
        
        // Store reference
        this.el.physicsBody = this.physicsBody;
        
        DebugUtils.log('ENVIRONMENT', `Physics body created for ${geometry.primitive} surface`);
        
        // Create wireframe for debugging
        this.createWireframe(geometry);
    },

    createWireframe: function(geometry) {
        // Create wireframe visualization of physics collision
        const wireframe = document.createElement('a-entity');
        
        if (geometry.primitive === 'box') {
            wireframe.setAttribute('geometry', `primitive: box; width: ${geometry.width}; height: ${geometry.height}; depth: ${geometry.depth}`);
        } else if (geometry.primitive === 'cylinder') {
            wireframe.setAttribute('geometry', `primitive: cylinder; radius: ${geometry.radius}; height: ${geometry.height}`);
        }
        
        wireframe.setAttribute('material', 'wireframe: true; color: #ffff00; opacity: 0.3; transparent: true');
        wireframe.setAttribute('visible', 'false');
        wireframe.classList.add('physics-wireframe');
        
        this.el.appendChild(wireframe);
    },

    onGrab: function(hand) {
        if (!this.data.grabbable) return;
        
        this.grabbingHands.add(hand);
        
        if (!this.isBeingGrabbed) {
            this.isBeingGrabbed = true;
            this.setGrabbedAppearance(true);
            DebugUtils.log('ENVIRONMENT', 'Surface grabbed by:', hand.id);
        }
        
        // Haptic feedback for successful grab
        ControllerUtils.playHaptic(hand, 0.6, 120);
        
        // CRITICAL: Notify player controller of surface grab for locomotion
        this.notifyPlayerController(hand, true);
        
        DebugUtils.log('ENVIRONMENT', `Surface grab state: isBeingGrabbed=${this.isBeingGrabbed}, hands=${this.grabbingHands.size}`);
    },

    onRelease: function(hand) {
        if (hand) {
            this.grabbingHands.delete(hand);
            DebugUtils.log('ENVIRONMENT', 'Surface release attempted by:', hand.id || 'unknown');
        }
        
        if (this.grabbingHands.size === 0) {
            this.isBeingGrabbed = false;
            this.setGrabbedAppearance(false);
            DebugUtils.log('ENVIRONMENT', 'Surface fully released');
        }
        
        // Light haptic feedback for release
        if (hand) {
            ControllerUtils.playHaptic(hand, 0.2, 50);
            // Notify player controller of surface release
            this.notifyPlayerController(hand, false);
        }
    },

    setGrabbedAppearance: function(grabbed) {
        if (grabbed) {
            // Highlight when grabbed
            this.el.setAttribute('material', {
                ...this.originalMaterial,
                color: '#00ff00',
                emissive: '#004400',
                emissiveIntensity: 0.3
            });
        } else {
            // Restore original appearance
            this.el.setAttribute('material', {
                ...this.originalMaterial,
                color: this.originalMaterial.originalColor,
                emissive: '#000000',
                emissiveIntensity: 0
            });
        }
    },

    notifyPlayerController: function(hand, isGrabbing) {
        const player = document.querySelector('[zerog-player]');
        if (player && player.components['zerog-player']) {
            const handKey = hand.id === 'leftHand' ? 'left' : 'right';
            DebugUtils.log('ENVIRONMENT', `Notifying player: ${handKey} hand ${isGrabbing ? 'grabbed' : 'released'} surface`);
            player.components['zerog-player'].setGrabState(handKey, isGrabbing);
        } else {
            DebugUtils.log('ENVIRONMENT', 'ERROR: Player component not found for grab notification!');
        }
    },

    remove: function() {
        // Clean up physics body
        if (this.physicsBody && window.PhysicsWorld) {
            window.PhysicsWorld.removeRigidBody(this.physicsBody);
            Ammo.destroy(this.physicsBody);
        }
        
        DebugUtils.log('ENVIRONMENT', 'Grab surface component removed');
    }
});

/**
 * Environment Surface Component
 * For complex 3D models that need collision but aren't grabbable
 */
AFRAME.registerComponent('environment-surface', {
    schema: {
        friction: { type: 'number', default: 0.8 },
        restitution: { type: 'number', default: 0.3 },
        convex: { type: 'boolean', default: false } // Use convex decomposition for complex shapes
    },

    init: function() {
        DebugUtils.log('ENVIRONMENT', 'Initializing environment surface for 3D model');
        
        // Wait for both physics and model to load
        this.waitForModelAndPhysics();
        
        this.physicsBody = null;
    },

    waitForModelAndPhysics: function() {
        // Wait for both model to load and physics to be ready
        if (!window.PhysicsWorld) {
            setTimeout(() => this.waitForModelAndPhysics(), 100);
            return;
        }
        
        // For OBJ models, wait for obj-model component to load
        if (this.el.hasAttribute('obj-model')) {
            if (!this.el.components['obj-model'] || !this.el.components['obj-model'].model) {
                setTimeout(() => this.waitForModelAndPhysics(), 100);
                return;
            }
        } else if (!this.el.object3D.children.length) {
            // For other models, wait for children
            setTimeout(() => this.waitForModelAndPhysics(), 100);
            return;
        }
        
        this.setupPhysics();
    },

    setupPhysics: function() {
        DebugUtils.log('ENVIRONMENT', 'Setting up physics for environment model');
        
        try {
            let shape;
            
            // Check if this is an OBJ model
            if (this.el.hasAttribute('obj-model')) {
                DebugUtils.log('ENVIRONMENT', 'Creating triangle mesh collision for OBJ model');
                
                // Get the geometry from the loaded OBJ model
                let geometry = null;
                this.el.object3D.traverse((child) => {
                    if (child.isMesh && child.geometry && !geometry) {
                        geometry = child.geometry;
                    }
                });
                
                if (geometry && geometry.attributes.position) {
                    // Create triangle mesh collision for accurate collision
                    const vertices = geometry.attributes.position.array;
                    const indices = geometry.index ? geometry.index.array : null;
                    
                    shape = window.PhysicsWorld.createTriangleMeshShape(vertices, indices);
                    DebugUtils.log('ENVIRONMENT', 'Created triangle mesh collision from OBJ geometry');
                } else {
                    throw new Error('Could not extract geometry from OBJ model');
                }
            } else {
                // For other models, use simplified box collision
                const bbox = new THREE.Box3().setFromObject(this.el.object3D);
                const size = bbox.getSize(new THREE.Vector3());
                shape = window.PhysicsWorld.createBoxShape(size.x, size.y, size.z);
                DebugUtils.log('ENVIRONMENT', 'Created box collision with size:', size);
            }
            
            // Create static body with proper collision groups
            // Group 4: Static surfaces, Mask: -1 (collide with everything)
            this.physicsBody = window.PhysicsWorld.createStaticMeshBody(this.el.object3D, shape, 4, -1);
            
            // Set custom properties
            this.physicsBody.setFriction(this.data.friction);
            this.physicsBody.setRestitution(this.data.restitution);
            
            DebugUtils.log('ENVIRONMENT', 'Environment collision setup complete');
            
            // Create wireframe for debugging
            this.createEnvironmentWireframe();
            
        } catch (error) {
            console.log('Environment collision setup failed:', error.message);
            // Fallback to simple box
            const bbox = new THREE.Box3().setFromObject(this.el.object3D);
            const size = bbox.getSize(new THREE.Vector3());
            const shape = window.PhysicsWorld.createBoxShape(size.x, size.y, size.z);
            this.physicsBody = window.PhysicsWorld.createStaticMeshBody(this.el.object3D, shape, 4, -1);
            
            DebugUtils.log('ENVIRONMENT', 'Used fallback box collision');
        }
    },

    createEnvironmentWireframe: function() {
        // Create wireframe visualization of environment collision
        const wireframe = document.createElement('a-entity');
        
        if (this.el.hasAttribute('obj-model')) {
            // For OBJ models, create a wireframe version of the actual geometry
            const objSrc = this.el.getAttribute('obj-model').obj;
            wireframe.setAttribute('obj-model', `obj: ${objSrc}`);
            wireframe.setAttribute('material', 'wireframe: true; color: #ff00ff; opacity: 0.3; transparent: true');
            DebugUtils.log('ENVIRONMENT', 'Created OBJ wireframe for collision visualization');
        } else {
            // For other models, use bounding box
            const bbox = new THREE.Box3().setFromObject(this.el.object3D);
            const size = bbox.getSize(new THREE.Vector3());
            wireframe.setAttribute('geometry', `primitive: box; width: ${size.x}; height: ${size.y}; depth: ${size.z}`);
            wireframe.setAttribute('material', 'wireframe: true; color: #ff00ff; opacity: 0.3; transparent: true');
            DebugUtils.log('ENVIRONMENT', 'Created box wireframe for collision visualization');
        }
        
        wireframe.setAttribute('visible', 'false');
        wireframe.classList.add('physics-wireframe');
        
        this.el.appendChild(wireframe);
    },

    remove: function() {
        if (this.physicsBody && window.PhysicsWorld) {
            window.PhysicsWorld.removeRigidBody(this.physicsBody);
            Ammo.destroy(this.physicsBody);
        }
    }
});

/**
 * Proximity Indicator for Grabbable Surfaces
 */
AFRAME.registerComponent('surface-proximity-indicator', {
    init: function() {
        this.hands = [];
        this.proximityVisuals = new Map();
        this.checkInterval = 100; // Check every 100ms
        this.lastCheck = 0;
        
        // Get hands when scene loads
        this.el.sceneEl.addEventListener('loaded', () => {
            this.hands = [
                document.querySelector('#leftHand'),
                document.querySelector('#rightHand')
            ].filter(hand => hand !== null);
            
            this.setupProximityVisuals();
        });
    },

    setupProximityVisuals: function() {
        // Create proximity indicators for grabbable surfaces
        const grabbableSurfaces = document.querySelectorAll('[grab-surface]');
        
        grabbableSurfaces.forEach(surface => {
            const indicator = document.createElement('a-entity');
            indicator.setAttribute('geometry', {
                primitive: 'ring',
                radiusInner: 0.08,
                radiusOuter: 0.12,
                segmentsTheta: 16
            });
            indicator.setAttribute('material', {
                color: '#00ff00',
                transparent: true,
                opacity: 0,
                side: 'double'
            });
            indicator.setAttribute('visible', false);
            
            surface.appendChild(indicator);
            this.proximityVisuals.set(surface, indicator);
        });
        
        DebugUtils.log('ENVIRONMENT', `Created proximity indicators for ${grabbableSurfaces.length} surfaces`);
    },

    tick: function(time) {
        // Throttle proximity checks
        if (time - this.lastCheck < this.checkInterval) return;
        this.lastCheck = time;
        
        if (!this.hands.length) return;
        
        // Check proximity for each surface
        this.proximityVisuals.forEach((indicator, surface) => {
            this.updateSurfaceProximity(surface, indicator);
        });
    },

    updateSurfaceProximity: function(surface, indicator) {
        let nearestDistance = Infinity;
        let hasNearbyHand = false;
        
        // Check distance to each hand
        this.hands.forEach(hand => {
            const handPos = ControllerUtils.getWorldPosition(hand);
            const surfacePos = new THREE.Vector3();
            surface.object3D.getWorldPosition(surfacePos);
            
            const distance = handPos.distanceTo(surfacePos);
            const grabRadius = 0.15; // 15cm grab radius
            
            if (distance <= grabRadius) {
                hasNearbyHand = true;
                nearestDistance = Math.min(nearestDistance, distance);
            }
        });
        
        // Update indicator
        if (hasNearbyHand) {
            const opacity = 1 - (nearestDistance / 0.15);
            indicator.setAttribute('visible', true);
            indicator.setAttribute('material', 'opacity', opacity * 0.8);
            
            // Color gradient from green (far) to yellow (near)
            const hue = (nearestDistance / 0.15) * 120; // 120 = green, 0 = red
            indicator.setAttribute('material', 'color', `hsl(${hue}, 100%, 50%)`);
        } else {
            indicator.setAttribute('visible', false);
        }
    }
});

/**
 * Environment Manager Component
 * Manages all environment elements and their interactions
 */
AFRAME.registerComponent('environment-manager', {
    init: function() {
        this.surfaces = [];
        this.environmentModels = [];
        
        // Scan for environment elements when scene loads
        this.el.sceneEl.addEventListener('loaded', () => {
            this.scanEnvironment();
            this.setupEnvironmentInteractions();
        });
        
        DebugUtils.log('ENVIRONMENT', 'Environment manager initialized');
    },

    scanEnvironment: function() {
        // Find all grabbable surfaces
        const grabbableSurfaces = document.querySelectorAll('[grab-surface]');
        this.surfaces = Array.from(grabbableSurfaces);
        
        // Find all environment models
        const environmentModels = document.querySelectorAll('[environment-surface]');
        this.environmentModels = Array.from(environmentModels);
        
        DebugUtils.log('ENVIRONMENT', `Found ${this.surfaces.length} grabbable surfaces and ${this.environmentModels.length} environment models`);
    },

    setupEnvironmentInteractions: function() {
        // Set up any global environment interactions here
        // For example, environmental hazards, moving platforms, etc.
        
        // Add visual feedback for all grabbable surfaces
        this.surfaces.forEach(surface => {
            this.enhanceSurfaceVisuals(surface);
        });
    },

    enhanceSurfaceVisuals: function(surface) {
        // Add subtle visual enhancements to indicate grabbable surfaces
        const material = surface.getAttribute('material') || {};
        
        // Add a subtle glow effect
        if (!material.emissive) {
            surface.setAttribute('material', {
                ...material,
                emissive: '#002200',
                emissiveIntensity: 0.1
            });
        }
        
        // Add grabbable class for CSS styling if needed
        surface.classList.add('grabbable-enhanced');
    },

    createEnvironmentHazard: function(position, radius, damage) {
        // Example of how to create environmental hazards
        const hazard = document.createElement('a-sphere');
        hazard.setAttribute('position', position);
        hazard.setAttribute('radius', radius);
        hazard.setAttribute('material', {
            color: '#ff0000',
            emissive: '#ff0000',
            emissiveIntensity: 0.5,
            transparent: true,
            opacity: 0.7
        });
        hazard.setAttribute('animation', {
            property: 'material.emissiveIntensity',
            from: 0.5,
            to: 1.0,
            dur: 1000,
            dir: 'alternate',
            loop: true
        });
        
        this.el.sceneEl.appendChild(hazard);
        
        DebugUtils.log('ENVIRONMENT', `Created hazard at position:`, position);
        return hazard;
    },

    resetEnvironment: function() {
        // Reset all dynamic environment elements
        this.surfaces.forEach(surface => {
            if (surface.components['grab-surface']) {
                surface.components['grab-surface'].setGrabbedAppearance(false);
            }
        });
        
        DebugUtils.log('ENVIRONMENT', 'Environment reset completed');
    },

    getGrabbableSurfacesInRadius: function(position, radius) {
        return this.surfaces.filter(surface => {
            const surfacePos = new THREE.Vector3();
            surface.object3D.getWorldPosition(surfacePos);
            return position.distanceTo(surfacePos) <= radius;
        });
    },

    tick: function() {
        // Environmental updates (moving platforms, hazards, etc.)
        // Currently minimal, but can be expanded
        
        if (window.ZeroGState.debugMode && Math.random() < 0.002) {
            const activeSurfaces = this.surfaces.filter(surface => 
                surface.components['grab-surface'] && 
                surface.components['grab-surface'].isBeingGrabbed
            );
            
            if (activeSurfaces.length > 0) {
                DebugUtils.log('ENVIRONMENT', `${activeSurfaces.length} surfaces being grabbed`);
            }
        }
    }
});

// Auto-attach environment manager and surface proximity indicators to scene
document.addEventListener('DOMContentLoaded', function() {
    const scene = document.querySelector('a-scene');
    
    if (scene && !scene.hasAttribute('environment-manager')) {
        scene.setAttribute('environment-manager', '');
    }
    
    if (scene && !scene.hasAttribute('surface-proximity-indicator')) {
        scene.setAttribute('surface-proximity-indicator', '');
    }
    
    DebugUtils.log('ENVIRONMENT', 'Environment module loaded');
    
    // Note: Dual-mesh system should be set up manually in HTML like reference project
    // setTimeout(initializeDualMeshEnvironment, 1000);
});

/**
 * Initialize dual-mesh environment system (like reference project)
 */
function initializeDualMeshEnvironment() {
    const scene = document.querySelector('a-scene');
    if (!scene) {
        setTimeout(initializeDualMeshEnvironment, 100);
        return;
    }
    
    // Create collision mesh (invisible OBJ for accurate physics)
    const collisionMesh = document.createElement('a-entity');
    collisionMesh.id = 'environment-collision';
    collisionMesh.setAttribute('obj-model', 'obj: url(assets/wall-hole.obj)');
    collisionMesh.setAttribute('environment-surface', 'friction: 0.7; restitution: 0.3');
    collisionMesh.setAttribute('visible', 'false');
    collisionMesh.setAttribute('position', '0 0 0');
    collisionMesh.setAttribute('scale', '1 1 1');
    
    DebugUtils.log('ENVIRONMENT', 'Creating collision mesh with OBJ file');
    
    // Create visual mesh (visible GLB for appearance)
    const visualMesh = document.createElement('a-entity');
    visualMesh.id = 'environment-visual';
    visualMesh.setAttribute('gltf-model', 'url(assets/sci_fi_hallway_center.glb)');
    visualMesh.setAttribute('position', '0 0 0');
    visualMesh.setAttribute('scale', '1 1 1');
    
    scene.appendChild(collisionMesh);
    scene.appendChild(visualMesh);
    
    DebugUtils.log('ENVIRONMENT', 'Dual-mesh system initialized: OBJ collision + GLB visual');
} 