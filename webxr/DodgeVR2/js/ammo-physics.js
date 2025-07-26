/**
 * Ammo-Physics Component for Triangle Mesh Collision
 * Exactly like the reference project - creates detailed collision from OBJ geometry
 */

AFRAME.registerComponent('ammo-physics', {
    init: function() {
        console.log('🔧 Ammo-physics component initialized for:', this.el.id);
        
        this.el.addEventListener('model-loaded', () => {
            console.log('🔧 Model loaded event received for:', this.el.id);
            setTimeout(() => {
                this.setupAmmoMeshPhysics();
            }, 2000); // Wait for Ammo to be ready
        });
        
        // Also try after scene is loaded
        this.el.sceneEl.addEventListener('loaded', () => {
            setTimeout(() => {
                if (!this.physicsReady) {
                    console.log('🔧 Trying ammo-physics setup after scene load for:', this.el.id);
                    this.setupAmmoMeshPhysics();
                }
            }, 3000);
        });
    },

    setupAmmoMeshPhysics: function() {
        if (!Ammo || !window.PhysicsWorld) {
            console.error('❌ Ammo.js not ready for mesh physics');
            setTimeout(() => this.setupAmmoMeshPhysics(), 1000);
            return;
        }

        const entityObject3D = this.el.object3D;
        console.log('🔧 Setting up Ammo.js mesh physics (dual-mesh approach)');
        console.log('🎯 COLLISION MESH: Simple OBJ geometry for physics (invisible)');
        console.log('🎨 VISUAL MESH: Detailed GLB model for appearance (no physics)');

        // Find the mesh in the OBJ
        let meshObject = null;
        entityObject3D.traverse((child) => {
            if (child.isMesh && child.geometry) {
                meshObject = child;
                console.log('Found mesh for Ammo physics:', child.name || 'unnamed');
                console.log('Mesh vertices:', child.geometry.attributes.position.count);
            }
        });

        if (!meshObject) {
            console.error('No mesh found for Ammo physics');
            return;
        }

        this.createAmmoTriangleMesh(meshObject.geometry);
    },

    createAmmoTriangleMesh: function(geometry) {
        console.log('🔧 Creating Ammo.js triangle mesh from geometry');

        // Get entity transforms
        const entityPosition = this.el.getAttribute('position') || { x: 0, y: 0, z: 0 };
        const entityRotation = this.el.getAttribute('rotation') || { x: 0, y: 0, z: 0 };
        const entityScale = this.el.getAttribute('scale') || { x: 1, y: 1, z: 1 };

        // Create triangle mesh
        const triangle_mesh = new Ammo.btTriangleMesh(true, true);
        
        // Extract vertices
        const vertices = [];
        const positionAttribute = geometry.attributes.position;
        
        for (let i = 0; i < positionAttribute.count; i++) {
            vertices.push({
                x: positionAttribute.getX(i),
                y: positionAttribute.getY(i),
                z: positionAttribute.getZ(i)
            });
        }

        console.log('📊 Geometry vertices:', vertices.length);

        // Create temporary vectors for triangle vertices
        const vectA = new Ammo.btVector3(0, 0, 0);
        const vectB = new Ammo.btVector3(0, 0, 0);
        const vectC = new Ammo.btVector3(0, 0, 0);

        let triangleCount = 0;
        const indices = geometry.index;

        if (indices) {
            // Indexed geometry
            console.log('🔧 Processing indexed geometry...');
            for (let i = 0; i < indices.count; i += 3) {
                const a = indices.getX(i);
                const b = indices.getX(i + 1);
                const c = indices.getX(i + 2);

                vectA.setX(vertices[a].x * entityScale.x);
                vectA.setY(vertices[a].y * entityScale.y);
                vectA.setZ(vertices[a].z * entityScale.z);

                vectB.setX(vertices[b].x * entityScale.x);
                vectB.setY(vertices[b].y * entityScale.y);
                vectB.setZ(vertices[b].z * entityScale.z);

                vectC.setX(vertices[c].x * entityScale.x);
                vectC.setY(vertices[c].y * entityScale.y);
                vectC.setZ(vertices[c].z * entityScale.z);

                triangle_mesh.addTriangle(vectA, vectB, vectC, true);
                triangleCount++;
            }
        } else {
            // Non-indexed geometry
            console.log('🔧 Processing non-indexed geometry...');
            for (let i = 0; i < vertices.length - 2; i += 3) {
                vectA.setX(vertices[i].x * entityScale.x);
                vectA.setY(vertices[i].y * entityScale.y);
                vectA.setZ(vertices[i].z * entityScale.z);

                vectB.setX(vertices[i + 1].x * entityScale.x);
                vectB.setY(vertices[i + 1].y * entityScale.y);
                vectB.setZ(vertices[i + 1].z * entityScale.z);

                vectC.setX(vertices[i + 2].x * entityScale.x);
                vectC.setY(vertices[i + 2].y * entityScale.y);
                vectC.setZ(vertices[i + 2].z * entityScale.z);

                triangle_mesh.addTriangle(vectA, vectB, vectC, true);
                triangleCount++;
            }
        }

        console.log('🔧 Added', triangleCount, 'triangles to physics mesh');

        // Clean up vectors
        Ammo.destroy(vectA);
        Ammo.destroy(vectB);
        Ammo.destroy(vectC);

        // Create BVH triangle mesh shape for concave meshes
        let shape = new Ammo.btBvhTriangleMeshShape(triangle_mesh, true, true);
        
        // Create rigid body
        let transform = new Ammo.btTransform();
        transform.setIdentity();
        transform.setOrigin(new Ammo.btVector3(entityPosition.x, entityPosition.y, entityPosition.z));
        
        // Apply rotation
        let quat = new Ammo.btQuaternion();
        quat.setEulerZYX(
            entityRotation.z * Math.PI / 180,
            entityRotation.y * Math.PI / 180, 
            entityRotation.x * Math.PI / 180
        );
        transform.setRotation(quat);

        let motionState = new Ammo.btDefaultMotionState(transform);
        let localInertia = new Ammo.btVector3(0, 0, 0);
        let mass = 0; // Static body

        let rigidBodyInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
        this.physicsBody = new Ammo.btRigidBody(rigidBodyInfo);

        // Add environment with collision group 4 (static surfaces), collides with all groups (-1)
        window.PhysicsWorld.world.addRigidBody(this.physicsBody, 4, -1);
        window.PhysicsWorld.rigidBodies.push(this.physicsBody);

        console.log('✅ COLLISION MESH: BVH triangle mesh added to Ammo.js physics world!');
        console.log('🎯 DUAL MESH SETUP: Simple collision OBJ + Detailed visual GLB!');
        console.log('🔧 Collision mesh stats:', {
            trianglesAdded: triangleCount,
            geometryType: indices ? 'indexed' : 'non-indexed',
            shapeType: 'BVH_TRIANGLE_MESH_SHAPE'
        });

        // Create wireframe visualization
        this.createPhysicsWireframe(vertices, indices, entityPosition, entityRotation, entityScale);

        this.physicsReady = true;
    },

    createPhysicsWireframe: function(vertices, geometryIndices, entityPosition, entityRotation, entityScale) {
        console.log('🔧 Creating physics wireframe visualization...');
        
        const wireframeGeometry = new THREE.BufferGeometry();
        const wireframeVertices = [];
        
        if (geometryIndices) {
            // Indexed geometry - create lines from triangles
            for (let i = 0; i < geometryIndices.count; i += 3) {
                const a = geometryIndices.getX(i);
                const b = geometryIndices.getX(i + 1);
                const c = geometryIndices.getX(i + 2);
                
                // Triangle edges
                wireframeVertices.push(
                    vertices[a].x * entityScale.x, vertices[a].y * entityScale.y, vertices[a].z * entityScale.z,
                    vertices[b].x * entityScale.x, vertices[b].y * entityScale.y, vertices[b].z * entityScale.z,
                    
                    vertices[b].x * entityScale.x, vertices[b].y * entityScale.y, vertices[b].z * entityScale.z,
                    vertices[c].x * entityScale.x, vertices[c].y * entityScale.y, vertices[c].z * entityScale.z,
                    
                    vertices[c].x * entityScale.x, vertices[c].y * entityScale.y, vertices[c].z * entityScale.z,
                    vertices[a].x * entityScale.x, vertices[a].y * entityScale.y, vertices[a].z * entityScale.z
                );
            }
        } else {
            // Non-indexed geometry
            for (let i = 0; i < vertices.length - 2; i += 3) {
                // Triangle edges
                wireframeVertices.push(
                    vertices[i].x * entityScale.x, vertices[i].y * entityScale.y, vertices[i].z * entityScale.z,
                    vertices[i + 1].x * entityScale.x, vertices[i + 1].y * entityScale.y, vertices[i + 1].z * entityScale.z,
                    
                    vertices[i + 1].x * entityScale.x, vertices[i + 1].y * entityScale.y, vertices[i + 1].z * entityScale.z,
                    vertices[i + 2].x * entityScale.x, vertices[i + 2].y * entityScale.y, vertices[i + 2].z * entityScale.z,
                    
                    vertices[i + 2].x * entityScale.x, vertices[i + 2].y * entityScale.y, vertices[i + 2].z * entityScale.z,
                    vertices[i].x * entityScale.x, vertices[i].y * entityScale.y, vertices[i].z * entityScale.z
                );
            }
        }
        
        wireframeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wireframeVertices, 3));
        
        const wireframeMaterial = new THREE.LineBasicMaterial({
            color: 0xff00ff,
            transparent: true,
            opacity: 0.5
        });
        
        this.physicsWireframe = new THREE.LineSegments(wireframeGeometry, wireframeMaterial);
        this.physicsWireframe.position.set(entityPosition.x, entityPosition.y, entityPosition.z);
        this.physicsWireframe.rotation.set(
            entityRotation.x * Math.PI / 180,
            entityRotation.y * Math.PI / 180,
            entityRotation.z * Math.PI / 180
        );
        
        // Add to scene
        this.el.sceneEl.object3D.add(this.physicsWireframe);
        
        // Hide by default
        this.physicsWireframe.visible = false;
        
        console.log('✅ Physics wireframe created');
    },

    toggleWireframe: function() {
        if (this.physicsWireframe) {
            this.physicsWireframe.visible = !this.physicsWireframe.visible;
            console.log('🔧 Ammo-physics wireframe:', this.physicsWireframe.visible ? 'ON' : 'OFF');
        }
    },

    remove: function() {
        if (this.physicsWireframe) {
            this.el.sceneEl.object3D.remove(this.physicsWireframe);
        }
        if (this.physicsBody && window.PhysicsWorld) {
            window.PhysicsWorld.world.removeRigidBody(this.physicsBody);
            const index = window.PhysicsWorld.rigidBodies.indexOf(this.physicsBody);
            if (index > -1) {
                window.PhysicsWorld.rigidBodies.splice(index, 1);
            }
        }
    }
});

// Export for ES6 modules if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {};
} 