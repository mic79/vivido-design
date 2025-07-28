// Zero-G WebXR Multiplayer - Application Constants

window.Constants = {
    // Physics Configuration
    PHYSICS: {
        GRAVITY: [0, 0, 0], // Zero gravity
        TIMESTEP: 1/60,
        MAX_SUBSTEPS: 3,
        
        // Material properties
        PLAYER_MASS: 80, // kg
        OBJECT_MASS: 5, // kg for small objects
        
        // Collision groups (bit flags)
        COLLISION_GROUPS: {
            PLAYER: 1,
            ENVIRONMENT: 2,
            OBJECTS: 4,
            TRIGGERS: 8
        },
        
        // Movement forces
        THRUST_FORCE: 200,
        MAX_VELOCITY: 10,
        DAMPING: 0.95,
        ANGULAR_DAMPING: 0.98
    },
    
    // Networking Configuration
    NETWORK: {
        MAX_PLAYERS: 4,
        UPDATE_RATE: 20, // Hz
        TIMEOUT: 10000, // ms
        RECONNECT_ATTEMPTS: 3,
        ROOM_ID_LENGTH: 6,
        
        // Message types
        MESSAGE_TYPES: {
            PLAYER_UPDATE: 'player_update',
            OBJECT_UPDATE: 'object_update',
            PHYSICS_EVENT: 'physics_event',
            CHAT: 'chat',
            SYSTEM: 'system'
        }
    },
    
    // VR Configuration
    VR: {
        CONTROLLER_RANGE: 1.0, // meters
        HAPTIC_INTENSITY: 0.5,
        HAPTIC_DURATION: 100, // ms
        
        // Thruster settings
        THRUSTER_PARTICLE_COUNT: 20,
        THRUSTER_PARTICLE_LIFE: 0.5,
        THRUSTER_FORCE_MULTIPLIER: 1.5,
        
        // Grabbing
        GRAB_DISTANCE: 1.5, // meters
        GRAB_FORCE: 500,
        GRAB_SPRING_STRENGTH: 50
    },
    
    // Audio Configuration
    AUDIO: {
        MASTER_VOLUME: 0.7,
        SFX_VOLUME: 0.8,
        AMBIENT_VOLUME: 0.3,
        
        // 3D Audio
        MAX_DISTANCE: 50,
        ROLLOFF_FACTOR: 1,
        REF_DISTANCE: 1,
        
        // File paths
        SOUNDS: {
            THRUSTER: 'audio/electric-hum.wav',
            IMPACT: 'audio/impact-cinematic-boom-5-352465.mp3',
            AMBIENT: 'audio/submarine-sonar.mp3',
            GRAB: 'audio/sound-design-elements-impact-sfx-ps-077-353190.mp3',
            RELEASE: 'audio/sound-design-elements-impact-sfx-ps-084-353199.mp3'
        }
    },
    
    // Rendering Configuration
    RENDERING: {
        TARGET_FPS: 90, // VR target
        DESKTOP_TARGET_FPS: 60,
        SHADOW_MAP_SIZE: 2048,
        
        // Quality settings
        ANTIALIAS: true,
        ALPHA: false,
        PRESERVE_DRAWING_BUFFER: false,
        POWER_PREFERENCE: 'high-performance',
        
        // Camera settings
        FOV: 75,
        NEAR: 0.1,
        FAR: 1000,
        
        // Lighting
        AMBIENT_INTENSITY: 0.3,
        DIRECTIONAL_INTENSITY: 0.8,
        POINT_LIGHT_INTENSITY: 1.0
    },
    
    // Environment Configuration
    ENVIRONMENT: {
        STATION_SIZE: 50, // meters
        ROOM_COUNT: 8,
        CORRIDOR_WIDTH: 3,
        
        // Object spawning
        FLOATING_OBJECTS_COUNT: 15,
        OBJECT_SPAWN_RADIUS: 20,
        OBJECT_TYPES: ['cube', 'sphere', 'cylinder', 'tool', 'panel'],
        
        // Visual effects
        PARTICLE_COUNT: 100,
        STAR_FIELD_COUNT: 1000,
        NEBULA_OPACITY: 0.5
    },
    
    // Performance Configuration
    PERFORMANCE: {
        OBJECT_CULLING_DISTANCE: 100,
        LOD_DISTANCES: [10, 25, 50],
        MAX_PHYSICS_OBJECTS: 50,
        
        // Memory management
        TEXTURE_MAX_SIZE: 1024,
        GEOMETRY_MERGE_THRESHOLD: 10,
        
        // Monitoring
        FPS_SAMPLE_SIZE: 60,
        MEMORY_CHECK_INTERVAL: 5000, // ms
        PERFORMANCE_LOG_INTERVAL: 10000 // ms
    },
    
    // Gameplay Configuration
    GAMEPLAY: {
        RESPAWN_TIME: 3000, // ms
        SAFE_ZONE_SIZE: 5, // meters
        
        // Player customization
        PLAYER_COLORS: [
            '#00d4ff', // Cyan
            '#ff6b35', // Orange
            '#4ecdc4', // Teal
            '#45b7d1', // Blue
            '#96ceb4', // Green
            '#feca57', // Yellow
            '#ff9ff3', // Pink
            '#54a0ff'  // Light Blue
        ],
        
        // UI
        HUD_FADE_TIME: 300, // ms
        NOTIFICATION_DURATION: 3000, // ms
        CHAT_MAX_MESSAGES: 50
    },
    
    // Development Configuration
    DEBUG: {
        PHYSICS_WIREFRAMES: false,
        SHOW_FPS: true,
        SHOW_STATS: true,
        LOG_NETWORK: false,
        LOG_PHYSICS: false,
        
        // Testing
        AUTO_CONNECT: false,
        SKIP_INTRO: false,
        GOD_MODE: false
    }
}; 