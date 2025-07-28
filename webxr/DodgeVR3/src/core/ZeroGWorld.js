// Zero-G WebXR Multiplayer - 3D World Manager

window.ZeroGWorld = class ZeroGWorld {
    constructor(physicsManager) {
        this.physics = physicsManager;
        this.isInitialized = false;
        
        // Three.js core objects
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        
        // Environment objects
        this.environment = new Map();
        this.floatingObjects = [];
        this.players = new Map();
        this.particles = [];
        
        // Lighting
        this.lights = {};
        
        // Asset loading
        this.loader = null;
        this.textureLoader = null;
        
        // Performance tracking
        this.lastFrameTime = 0;
        this.frameCount = 0;
    }
    
    async init() {
        try {
            console.log('🌍 Initializing Zero-G World...');
            
            // Initialize Three.js scene
            this.initScene();
            
            // Initialize camera
            this.initCamera();
            
            // Initialize renderer with WebXR support
            this.initRenderer();
            
            // Setup lighting
            this.initLighting();
            
            // Load and create environment
            await this.createEnvironment();
            
            // Create floating objects
            this.createFloatingObjects();
            
            // Create particle systems
            this.initParticleSystems();
            
            this.isInitialized = true;
            console.log('✅ Zero-G World initialized successfully');
            
        } catch (error) {
            console.error('❌ Failed to initialize world:', error);
            throw error;
        }
    }
    
    initScene() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0a);
        
        // Add fog for depth perception
        this.scene.fog = new THREE.Fog(0x0a0a0a, 30, 100);
        
        console.log('✅ Scene created');
    }
    
    initCamera() {
        const aspect = window.innerWidth / window.innerHeight;
        this.camera = new THREE.PerspectiveCamera(
            window.Constants.RENDERING.FOV,
            aspect,
            window.Constants.RENDERING.NEAR,
            window.Constants.RENDERING.FAR
        );
        
        // Initial camera position
        this.camera.position.set(0, 0, 5);
        this.camera.lookAt(0, 0, 0);
        
        console.log('✅ Camera created');
    }
    
    initRenderer() {
        this.renderer = new THREE.WebGLRenderer({
            antialias: window.Constants.RENDERING.ANTIALIAS,
            alpha: window.Constants.RENDERING.ALPHA,
            preserveDrawingBuffer: window.Constants.RENDERING.PRESERVE_DRAWING_BUFFER,
            powerPreference: window.Constants.RENDERING.POWER_PREFERENCE
        });
        
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        
        // Enable shadows
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        
        // Enable WebXR
        this.renderer.xr.enabled = true;
        
        // Add to DOM
        document.body.appendChild(this.renderer.domElement);
        
        // Handle resize
        window.addEventListener('resize', this.onWindowResize.bind(this));
        
        console.log('✅ Renderer created with WebXR support');
    }
    
    initLighting() {
        // Ambient light for overall illumination
        this.lights.ambient = new THREE.AmbientLight(
            0x404040, 
            window.Constants.RENDERING.AMBIENT_INTENSITY
        );
        this.scene.add(this.lights.ambient);
        
        // Main directional light (simulates distant sun)
        this.lights.directional = new THREE.DirectionalLight(
            0xffffff, 
            window.Constants.RENDERING.DIRECTIONAL_INTENSITY
        );
        this.lights.directional.position.set(50, 50, 50);
        this.lights.directional.castShadow = true;
        
        // Configure shadow mapping
        this.lights.directional.shadow.mapSize.width = window.Constants.RENDERING.SHADOW_MAP_SIZE;
        this.lights.directional.shadow.mapSize.height = window.Constants.RENDERING.SHADOW_MAP_SIZE;
        this.lights.directional.shadow.camera.near = 0.5;
        this.lights.directional.shadow.camera.far = 200;
        this.lights.directional.shadow.camera.left = -50;
        this.lights.directional.shadow.camera.right = 50;
        this.lights.directional.shadow.camera.top = 50;
        this.lights.directional.shadow.camera.bottom = -50;
        
        this.scene.add(this.lights.directional);
        
        // Point lights for atmospheric effect
        this.createAtmosphericLights();
        
        console.log('✅ Lighting system initialized');
    }
    
    createAtmosphericLights() {
        const colors = [0x00d4ff, 0xff6b35, 0x4ecdc4];
        const positions = [
            [-20, 10, -15],
            [25, -15, 20],
            [-10, -20, 25]
        ];
        
        this.lights.points = [];
        
        for (let i = 0; i < 3; i++) {
            const pointLight = new THREE.PointLight(
                colors[i], 
                window.Constants.RENDERING.POINT_LIGHT_INTENSITY * 0.5, 
                30
            );
            pointLight.position.set(...positions[i]);
            
            this.lights.points.push(pointLight);
            this.scene.add(pointLight);
        }
    }
    
    async createEnvironment() {
        // Initialize loaders with fallbacks
        this.textureLoader = new THREE.TextureLoader();
        
        // Check if GLTFLoader is available
        if (typeof THREE.GLTFLoader === 'function') {
            this.loader = new THREE.GLTFLoader();
            console.log('✅ GLTFLoader available');
        } else {
            console.warn('⚠️ GLTFLoader not available, using procedural geometry only');
            this.loader = null;
        }
        
        // Create space station environment
        await this.createSpaceStation();
        
        // Create starfield background
        this.createStarField();
        
        // Create energy fields/nebula effect
        this.createEnergyFields();
        
        console.log('✅ Environment created');
    }
    
    async createSpaceStation() {
        try {
            console.log('🏗️ Loading simple wall-hole environment...');
            
            // Load only the wall-hole model as requested
            await this.loadWallHoleEnvironment();
            
            console.log('✅ Simple environment loaded');
        } catch (error) {
            console.warn('⚠️ Failed to load wall-hole model, using minimal fallback:', error);
            this.createMinimalEnvironment();
        }
    }
    
    async loadWallHoleEnvironment() {
        if (!this.loader) {
            console.warn('⚠️ GLTFLoader not available, using minimal environment');
            this.createMinimalEnvironment();
            return;
        }
        
        try {
            // Load the wall-hole GLB model
            const wallHole = await this.loadGLTFModel('assets/wall-hole.glb');
            if (wallHole) {
                wallHole.position.set(0, 0, -10);
                wallHole.scale.set(2, 2, 2);
                this.scene.add(wallHole);
                this.physics.addStaticMesh(wallHole, 'environment');
                this.environment.set('wallHole', wallHole);
                console.log('✅ Wall-hole model loaded');
            }
            
            // Create a simple room/corridor
            this.createSimpleRoom();
            
        } catch (error) {
            console.warn('Could not load wall-hole model:', error);
            this.createMinimalEnvironment();
        }
    }
    
    createSimpleRoom() {
        // Create a simple rectangular room
        const roomSize = 20;
        const wallHeight = 8;
        const wallThickness = 0.5;
        
        const wallGeometry = new THREE.BoxGeometry(roomSize, wallHeight, wallThickness);
        const wallMaterial = new THREE.MeshLambertMaterial({ 
            color: 0x333333,
            transparent: true,
            opacity: 0.8
        });
        
        // Create walls
        const walls = [
            { pos: [0, 0, roomSize/2], rot: [0, 0, 0] }, // Front wall
            { pos: [0, 0, -roomSize/2], rot: [0, 0, 0] }, // Back wall
            { pos: [roomSize/2, 0, 0], rot: [0, Math.PI/2, 0] }, // Right wall
            { pos: [-roomSize/2, 0, 0], rot: [0, Math.PI/2, 0] }, // Left wall
        ];
        
        walls.forEach((config, index) => {
            const wall = new THREE.Mesh(wallGeometry, wallMaterial);
            wall.position.set(...config.pos);
            wall.rotation.set(...config.rot);
            wall.castShadow = true;
            wall.receiveShadow = true;
            this.scene.add(wall);
            this.physics.addStaticMesh(wall, 'wall');
            this.environment.set(`wall_${index}`, wall);
        });
        
        // Create floor and ceiling
        const floorGeometry = new THREE.BoxGeometry(roomSize, wallThickness, roomSize);
        const floorMaterial = new THREE.MeshLambertMaterial({ color: 0x222222 });
        
        const floor = new THREE.Mesh(floorGeometry, floorMaterial);
        floor.position.set(0, -wallHeight/2, 0);
        floor.castShadow = true;
        floor.receiveShadow = true;
        this.scene.add(floor);
        this.physics.addStaticMesh(floor, 'floor');
        this.environment.set('floor', floor);
        
        const ceiling = new THREE.Mesh(floorGeometry, floorMaterial);
        ceiling.position.set(0, wallHeight/2, 0);
        ceiling.castShadow = true;
        ceiling.receiveShadow = true;
        this.scene.add(ceiling);
        this.physics.addStaticMesh(ceiling, 'ceiling');
        this.environment.set('ceiling', ceiling);
        
        console.log('✅ Simple room created');
    }
    
    createMinimalEnvironment() {
        console.log('🔧 Creating minimal fallback environment');
        
        // Just create a simple platform and some basic walls
        const platformGeometry = new THREE.BoxGeometry(10, 0.5, 10);
        const platformMaterial = new THREE.MeshLambertMaterial({ color: 0x444444 });
        
        const platform = new THREE.Mesh(platformGeometry, platformMaterial);
        platform.position.set(0, -2, 0);
        platform.castShadow = true;
        platform.receiveShadow = true;
        this.scene.add(platform);
        this.physics.addStaticMesh(platform, 'platform');
        this.environment.set('platform', platform);
        
        console.log('✅ Minimal environment created');
    }
    
    async loadGLTFModel(path) {
        return new Promise((resolve, reject) => {
            this.loader.load(
                path,
                (gltf) => {
                    const model = gltf.scene;
                    
                    // Ensure all meshes cast and receive shadows
                    model.traverse((child) => {
                        if (child.isMesh) {
                            child.castShadow = true;
                            child.receiveShadow = true;
                            
                            // Ensure materials are properly set up
                            if (child.material) {
                                if (Array.isArray(child.material)) {
                                    child.material.forEach(mat => {
                                        if (mat.isMeshStandardMaterial) {
                                            mat.envMapIntensity = 0.1;
                                        }
                                    });
                                } else if (child.material.isMeshStandardMaterial) {
                                    child.material.envMapIntensity = 0.1;
                                }
                            }
                        }
                    });
                    
                    resolve(model);
                },
                (progress) => {
                    console.log(`Loading ${path}: ${Math.round((progress.loaded / progress.total) * 100)}%`);
                },
                (error) => {
                    console.error(`Failed to load ${path}:`, error);
                    reject(error);
                }
            );
        });
    }
    
    createAdditionalStructures() {
        // Add some additional sci-fi elements to complement the loaded models
        
        // Energy core at the center
        const coreGeometry = new THREE.SphereGeometry(0.5, 16, 12);
        const coreMaterial = new THREE.MeshLambertMaterial({ 
            color: 0x00aaff,
            emissive: 0x004488,
            transparent: true,
            opacity: 0.8
        });
        
        const energyCore = new THREE.Mesh(coreGeometry, coreMaterial);
        energyCore.position.set(0, 1, 0);
        this.scene.add(energyCore);
        this.environment.set('energyCore', energyCore);
        
        // Rotating rings around the core
        const ringGeometry = new THREE.TorusGeometry(2, 0.1, 8, 32);
        const ringMaterial = new THREE.MeshLambertMaterial({ 
            color: 0x0066cc,
            emissive: 0x003366
        });
        
        for (let i = 0; i < 3; i++) {
            const ring = new THREE.Mesh(ringGeometry, ringMaterial);
            ring.position.set(0, 1, 0);
            ring.rotation.x = (i * Math.PI) / 3;
            ring.userData.rotationSpeed = 0.01 + i * 0.005;
            this.scene.add(ring);
            this.environment.set(`ring_${i}`, ring);
        }
        
        // Add some point lights for sci-fi atmosphere
        const lightPositions = [
            [10, 5, 10],
            [-10, 5, 10],
            [10, 5, -10],
            [-10, 5, -10]
        ];
        
        lightPositions.forEach((pos, index) => {
            const light = new THREE.PointLight(0x0088ff, 1, 20);
            light.position.set(...pos);
            this.scene.add(light);
            this.environment.set(`scifi_light_${index}`, light);
        });
    }
    
    createFallbackEnvironment() {
        console.log('🔧 Creating fallback procedural environment');
        
        // Create a simple station structure if models fail to load
        const stationSize = window.Constants.ENVIRONMENT.STATION_SIZE;
        
        // Main station structure - modular corridor system
        const corridors = this.createCorridorSystem();
        this.environment.set('corridors', corridors);
        
        // Central hub
        const hub = this.createCentralHub();
        this.environment.set('hub', hub);
        
        // Docking modules
        const dockingBays = this.createDockingBays();
        this.environment.set('docking', dockingBays);
        
        // Add all to scene
        corridors.forEach(corridor => this.scene.add(corridor));
        this.scene.add(hub);
        dockingBays.forEach(bay => this.scene.add(bay));
    }
    
    createCorridorSystem() {
        const corridors = [];
        const corridorLength = 20;
        const corridorWidth = window.Constants.ENVIRONMENT.CORRIDOR_WIDTH;
        
        // Create main corridors in cross pattern
        const corridorPositions = [
            { pos: [0, 0, 0], rot: [0, 0, 0] }, // Main horizontal
            { pos: [0, 0, 0], rot: [0, Math.PI/2, 0] }, // Main vertical
            { pos: [0, corridorWidth, 0], rot: [Math.PI/2, 0, 0] }, // Upper vertical
            { pos: [0, -corridorWidth, 0], rot: [Math.PI/2, 0, 0] } // Lower vertical
        ];
        
        corridorPositions.forEach((config, index) => {
            const corridor = this.createCorridor(corridorLength, corridorWidth);
            corridor.position.set(...config.pos);
            corridor.rotation.set(...config.rot);
            corridor.name = `corridor_${index}`;
            corridors.push(corridor);
            
            // Add physics collision
            this.physics.addStaticMesh(corridor, 'environment');
        });
        
        return corridors;
    }
    
    createCorridor(length, width) {
        const group = new THREE.Group();
        
        // Corridor geometry
        const wallThickness = 0.2;
        const height = width;
        
        // Materials
        const wallMaterial = new THREE.MeshLambertMaterial({ 
            color: 0x2a2a2a,
            map: this.createMetalTexture()
        });
        
        const panelMaterial = new THREE.MeshLambertMaterial({ 
            color: 0x1a4a6a,
            emissive: 0x001122
        });
        
        // Floor
        const floorGeometry = new THREE.BoxGeometry(length, wallThickness, width);
        const floor = new THREE.Mesh(floorGeometry, wallMaterial);
        floor.position.y = -height/2;
        floor.receiveShadow = true;
        group.add(floor);
        
        // Ceiling
        const ceiling = new THREE.Mesh(floorGeometry, wallMaterial);
        ceiling.position.y = height/2;
        ceiling.receiveShadow = true;
        group.add(ceiling);
        
        // Walls
        const wallGeometry = new THREE.BoxGeometry(length, height, wallThickness);
        
        const leftWall = new THREE.Mesh(wallGeometry, wallMaterial);
        leftWall.position.z = width/2;
        leftWall.castShadow = true;
        leftWall.receiveShadow = true;
        group.add(leftWall);
        
        const rightWall = new THREE.Mesh(wallGeometry, wallMaterial);
        rightWall.position.z = -width/2;
        rightWall.castShadow = true;
        rightWall.receiveShadow = true;
        group.add(rightWall);
        
        // Add control panels and details
        this.addCorridorDetails(group, length, width, height, panelMaterial);
        
        return group;
    }
    
    addCorridorDetails(corridor, length, width, height, panelMaterial) {
        // Control panels
        const panelGeometry = new THREE.BoxGeometry(0.8, 0.6, 0.1);
        const panelCount = Math.floor(length / 4);
        
        for (let i = 0; i < panelCount; i++) {
            const x = -length/2 + (i + 1) * (length / (panelCount + 1));
            
            // Left wall panel
            const leftPanel = new THREE.Mesh(panelGeometry, panelMaterial);
            leftPanel.position.set(x, 0, width/2 - 0.05);
            corridor.add(leftPanel);
            
            // Right wall panel
            const rightPanel = new THREE.Mesh(panelGeometry, panelMaterial);
            rightPanel.position.set(x, 0, -width/2 + 0.05);
            corridor.add(rightPanel);
            
            // Add some random blinking lights
            if (Math.random() > 0.7) {
                const light = new THREE.PointLight(0x00ff88, 0.5, 5);
                light.position.copy(leftPanel.position);
                light.position.z += 0.2;
                corridor.add(light);
            }
        }
        
        // Ceiling lights
        const lightGeometry = new THREE.CylinderGeometry(0.1, 0.1, 0.05);
        const lightMaterial = new THREE.MeshLambertMaterial({ 
            color: 0xffffff,
            emissive: 0xaaaaaa
        });
        
        for (let i = 0; i < 3; i++) {
            const x = -length/3 + i * (length/3);
            const ceilingLight = new THREE.Mesh(lightGeometry, lightMaterial);
            ceilingLight.position.set(x, height/2 - 0.1, 0);
            corridor.add(ceilingLight);
            
            // Add actual light source
            const lightSource = new THREE.PointLight(0xffffff, 1, 10);
            lightSource.position.copy(ceilingLight.position);
            lightSource.position.y -= 0.5;
            corridor.add(lightSource);
        }
    }
    
    createCentralHub() {
        const group = new THREE.Group();
        const radius = 8;
        
        // Main hub sphere (with openings for corridors)
        const hubGeometry = new THREE.SphereGeometry(radius, 32, 16);
        const hubMaterial = new THREE.MeshLambertMaterial({ 
            color: 0x3a3a3a,
            transparent: true,
            opacity: 0.9
        });
        
        const hub = new THREE.Mesh(hubGeometry, hubMaterial);
        hub.castShadow = true;
        hub.receiveShadow = true;
        group.add(hub);
        
        // Central control console
        const consoleGeometry = new THREE.CylinderGeometry(2, 2.5, 1);
        const consoleMaterial = new THREE.MeshLambertMaterial({ 
            color: 0x1a4a6a,
            emissive: 0x002244
        });
        
        const console = new THREE.Mesh(consoleGeometry, consoleMaterial);
        console.position.y = 0;
        group.add(console);
        
        // Add physics
        this.physics.addStaticMesh(group, 'environment');
        
        return group;
    }
    
    createDockingBays() {
        const dockingBays = [];
        const bayPositions = [
            [30, 0, 0],
            [-30, 0, 0],
            [0, 30, 0],
            [0, -30, 0]
        ];
        
        bayPositions.forEach((pos, index) => {
            const bay = this.createDockingBay();
            bay.position.set(...pos);
            bay.name = `docking_bay_${index}`;
            dockingBays.push(bay);
            
            this.physics.addStaticMesh(bay, 'environment');
        });
        
        return dockingBays;
    }
    
    createDockingBay() {
        const group = new THREE.Group();
        
        // Bay structure
        const bayGeometry = new THREE.BoxGeometry(8, 6, 4);
        const bayMaterial = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
        
        const bay = new THREE.Mesh(bayGeometry, bayMaterial);
        bay.castShadow = true;
        bay.receiveShadow = true;
        group.add(bay);
        
        return group;
    }
    
    createMetalTexture() {
        // Create a simple procedural metal texture
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 256;
        const context = canvas.getContext('2d');
        
        // Base metal color
        context.fillStyle = '#2a2a2a';
        context.fillRect(0, 0, 256, 256);
        
        // Add some noise/detail
        for (let i = 0; i < 1000; i++) {
            const x = Math.random() * 256;
            const y = Math.random() * 256;
            const brightness = Math.random() * 50 + 30;
            context.fillStyle = `rgb(${brightness}, ${brightness}, ${brightness})`;
            context.fillRect(x, y, 2, 2);
        }
        
        const texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(4, 4);
        
        return texture;
    }
    
    createStarField() {
        const starGeometry = new THREE.BufferGeometry();
        const starCount = window.Constants.ENVIRONMENT.STAR_FIELD_COUNT;
        
        const positions = new Float32Array(starCount * 3);
        const colors = new Float32Array(starCount * 3);
        
        for (let i = 0; i < starCount; i++) {
            const i3 = i * 3;
            
            // Random position in sphere around station
            const radius = 200 + Math.random() * 300;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.random() * Math.PI;
            
            positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
            positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
            positions[i3 + 2] = radius * Math.cos(phi);
            
            // Random star color (white to blue)
            const intensity = 0.5 + Math.random() * 0.5;
            colors[i3] = intensity;
            colors[i3 + 1] = intensity;
            colors[i3 + 2] = Math.min(1, intensity + Math.random() * 0.3);
        }
        
        starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        starGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        
        const starMaterial = new THREE.PointsMaterial({ 
            size: 2,
            vertexColors: true,
            sizeAttenuation: false
        });
        
        const stars = new THREE.Points(starGeometry, starMaterial);
        this.scene.add(stars);
        
        this.environment.set('stars', stars);
    }
    
    createEnergyFields() {
        // Add some subtle energy field effects around the station
        const fieldGeometry = new THREE.SphereGeometry(60, 32, 16);
        const fieldMaterial = new THREE.MeshBasicMaterial({
            color: 0x004466,
            transparent: true,
            opacity: 0.1,
            side: THREE.BackSide
        });
        
        const energyField = new THREE.Mesh(fieldGeometry, fieldMaterial);
        this.scene.add(energyField);
        
        this.environment.set('energyField', energyField);
    }
    
    createFloatingObjects() {
        const objectCount = window.Constants.ENVIRONMENT.FLOATING_OBJECTS_COUNT;
        const spawnRadius = window.Constants.ENVIRONMENT.OBJECT_SPAWN_RADIUS;
        const objectTypes = window.Constants.ENVIRONMENT.OBJECT_TYPES;
        
        for (let i = 0; i < objectCount; i++) {
            const objectType = objectTypes[Math.floor(Math.random() * objectTypes.length)];
            const object = this.createFloatingObject(objectType);
            
            // Random position around station
            const angle = Math.random() * Math.PI * 2;
            const height = (Math.random() - 0.5) * 10;
            const radius = 10 + Math.random() * spawnRadius;
            
            object.position.set(
                Math.cos(angle) * radius,
                height,
                Math.sin(angle) * radius
            );
            
            // Random rotation
            object.rotation.set(
                Math.random() * Math.PI,
                Math.random() * Math.PI,
                Math.random() * Math.PI
            );
            
            this.scene.add(object);
            this.floatingObjects.push(object);
            
            // Add physics
            this.physics.addDynamicObject(object, window.Constants.PHYSICS.OBJECT_MASS);
        }
        
        console.log(`✅ Created ${objectCount} floating objects`);
    }
    
    createFloatingObject(type) {
        let geometry;
        const size = 0.5 + Math.random() * 0.5;
        
        switch (type) {
            case 'cube':
                geometry = new THREE.BoxGeometry(size, size, size);
                break;
            case 'sphere':
                geometry = new THREE.SphereGeometry(size * 0.7, 16, 12);
                break;
            case 'cylinder':
                geometry = new THREE.CylinderGeometry(size * 0.5, size * 0.5, size, 12);
                break;
            case 'tool':
                geometry = new THREE.CylinderGeometry(0.1, 0.1, size, 8);
                break;
            default:
                geometry = new THREE.BoxGeometry(size, size * 0.2, size * 0.8);
        }
        
        const material = new THREE.MeshLambertMaterial({
            color: new THREE.Color().setHSL(Math.random(), 0.7, 0.6)
        });
        
        const object = new THREE.Mesh(geometry, material);
        object.castShadow = true;
        object.receiveShadow = true;
        object.userData.objectType = type;
        object.userData.isFloatingObject = true;
        
        return object;
    }
    
    initParticleSystems() {
        // Will be used for thruster effects and other particle systems
        this.particles = [];
        console.log('✅ Particle systems initialized');
    }
    
    // Player management
    addPlayer(playerId, position = new THREE.Vector3(0, 0, 0), color = 0x00d4ff) {
        const player = this.createPlayerAvatar(color);
        player.position.copy(position);
        player.userData.playerId = playerId;
        
        this.scene.add(player);
        this.players.set(playerId, player);
        
        // Add physics
        this.physics.addPlayerRigidBody(player, window.Constants.PHYSICS.PLAYER_MASS);
        
        console.log(`✅ Player ${playerId} added to world`);
        return player;
    }
    
    removePlayer(playerId) {
        const player = this.players.get(playerId);
        if (player) {
            this.scene.remove(player);
            this.players.delete(playerId);
            this.physics.removeRigidBody(player);
            console.log(`✅ Player ${playerId} removed from world`);
        }
    }
    
    createPlayerAvatar(color = 0x00d4ff) {
        const group = new THREE.Group();
        
        // Main body (capsule shape)
        const bodyGeometry = new THREE.CapsuleGeometry(0.3, 1.4, 8, 16);
        const bodyMaterial = new THREE.MeshLambertMaterial({ color });
        const body = new THREE.Mesh(bodyGeometry, bodyMaterial);
        body.castShadow = true;
        group.add(body);
        
        // Helmet
        const helmetGeometry = new THREE.SphereGeometry(0.25, 16, 12);
        const helmetMaterial = new THREE.MeshLambertMaterial({ 
            color: 0xffffff,
            transparent: true,
            opacity: 0.8
        });
        const helmet = new THREE.Mesh(helmetGeometry, helmetMaterial);
        helmet.position.y = 0.8;
        helmet.castShadow = true;
        group.add(helmet);
        
        // Jetpack/thrusters
        const thrusterGeometry = new THREE.BoxGeometry(0.2, 0.3, 0.1);
        const thrusterMaterial = new THREE.MeshLambertMaterial({ color: 0x333333 });
        
        const leftThruster = new THREE.Mesh(thrusterGeometry, thrusterMaterial);
        leftThruster.position.set(-0.15, 0, -0.35);
        group.add(leftThruster);
        
        const rightThruster = new THREE.Mesh(thrusterGeometry, thrusterMaterial);
        rightThruster.position.set(0.15, 0, -0.35);
        group.add(rightThruster);
        
        return group;
    }
    
    // Update methods
    update() {
        if (!this.isInitialized) return;
        
        // Update floating objects with gentle rotation
        this.floatingObjects.forEach(object => {
            object.rotation.x += 0.002;
            object.rotation.y += 0.001;
            object.rotation.z += 0.0015;
        });
        
        // Update energy fields
        const energyField = this.environment.get('energyField');
        if (energyField) {
            energyField.rotation.y += 0.0005;
        }
        
        // Update atmospheric lights
        if (this.lights.points) {
            const time = Date.now() * 0.001;
            this.lights.points.forEach((light, index) => {
                light.intensity = window.Constants.RENDERING.POINT_LIGHT_INTENSITY * 0.5 + 
                    Math.sin(time + index * 2) * 0.2;
            });
        }
        
        this.frameCount++;
    }
    
    render() {
        if (!this.isInitialized) return;
        
        this.renderer.render(this.scene, this.camera);
    }
    
    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
    
    // Public API methods
    getScene() { return this.scene; }
    getCamera() { return this.camera; }
    getRenderer() { return this.renderer; }
    getPlayer(playerId) { return this.players.get(playerId); }
    getAllPlayers() { return Array.from(this.players.values()); }
    getFloatingObjects() { return this.floatingObjects; }
    
    // Cleanup
    destroy() {
        if (this.renderer) {
            this.renderer.dispose();
            document.body.removeChild(this.renderer.domElement);
        }
        
        // Dispose of all geometries and materials
        this.scene.traverse((object) => {
            if (object.geometry) object.geometry.dispose();
            if (object.material) {
                if (Array.isArray(object.material)) {
                    object.material.forEach(material => material.dispose());
                } else {
                    object.material.dispose();
                }
            }
        });
        
        console.log('✅ Zero-G World destroyed');
    }
}; 