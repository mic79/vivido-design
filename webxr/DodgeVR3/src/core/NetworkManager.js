// Zero-G WebXR Multiplayer - Network Manager using PeerJS

window.NetworkManager = class NetworkManager {
    constructor(world, physics) {
        this.world = world;
        this.physics = physics;
        this.isInitialized = false;
        this.isOfflineMode = false;
        
        // PeerJS components
        this.peer = null;
        this.isHost = false;
        this.roomId = null;
        this.playerId = null;
        
        // Connection management
        this.connections = new Map();
        this.players = new Map();
        this.localPlayer = null;
        
        // Message handling
        this.messageQueue = [];
        this.lastUpdateTime = 0;
        this.updateInterval = 1000 / window.Constants.NETWORK.UPDATE_RATE;
        
        // Event handling
        this.eventCallbacks = new Map();
        
        // Performance tracking
        this.pingTimes = new Map();
        this.packetsReceived = 0;
        this.packetsSent = 0;
        
        // Player state
        this.localPlayerState = {
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            velocity: { x: 0, y: 0, z: 0 },
            timestamp: 0
        };
    }
    
    async init() {
        try {
            console.log('🌐 Initializing Network Manager...');
            
            // Generate unique player ID
            this.playerId = this.generatePlayerId();
            
            // Try to initialize PeerJS with timeout
            const success = await this.initPeerJSWithTimeout(5000);
            
            if (success) {
                // Setup message handling for online mode
                this.setupMessageHandlers();
                
                // Start update loop
                this.startUpdateLoop();
                
                console.log('✅ Network Manager initialized successfully (Online Mode)');
            } else {
                // Fall back to offline mode
                this.initOfflineMode();
                console.log('✅ Network Manager initialized successfully (Offline Mode)');
            }
            
            this.isInitialized = true;
            
        } catch (error) {
            console.warn('⚠️ Network initialization failed, continuing in offline mode:', error);
            this.initOfflineMode();
            this.isInitialized = true; // Don't block app initialization
        }
    }
    
    async initPeerJSWithTimeout(timeout = 5000) {
        return new Promise((resolve) => {
            let resolved = false;
            
            // Set timeout
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    console.warn('⏰ PeerJS connection timeout, switching to offline mode');
                    resolve(false);
                }
            }, timeout);
            
            // Try to initialize PeerJS
            this.initPeerJS()
                .then(() => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        resolve(true);
                    }
                })
                .catch((error) => {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeoutId);
                        console.warn('PeerJS initialization failed:', error);
                        resolve(false);
                    }
                });
        });
    }
    
    async initPeerJS() {
        return new Promise((resolve, reject) => {
            // Try multiple PeerJS servers
            const peerJSServers = [
                { host: 'peerjs-server.herokuapp.com', port: 443, secure: true },
                { host: '0.peerjs.com', port: 443, secure: true, path: '/peerjs' },
                { host: 'peerjs-server.com', port: 443, secure: true }
            ];
            
            let serverIndex = 0;
            
            const tryNextServer = () => {
                if (serverIndex >= peerJSServers.length) {
                    reject(new Error('All PeerJS servers failed'));
                    return;
                }
                
                const config = peerJSServers[serverIndex];
                console.log(`🌐 Trying PeerJS server: ${config.host}`);
                
                // Clean up previous peer if exists
                if (this.peer) {
                    this.peer.destroy();
                }
                
                // Initialize PeerJS with current server configuration
                this.peer = new Peer(this.playerId, {
                    ...config,
                    debug: 1,
                    config: {
                        iceServers: [
                            { urls: 'stun:stun.l.google.com:19302' },
                            { urls: 'stun:stun1.l.google.com:19302' }
                        ]
                    }
                });
                
                const connectionTimeout = setTimeout(() => {
                    console.warn(`⏰ Connection timeout for ${config.host}`);
                    serverIndex++;
                    tryNextServer();
                }, 3000);
                
                this.peer.on('open', (id) => {
                    clearTimeout(connectionTimeout);
                    console.log(`✅ PeerJS connected to ${config.host} with ID:`, id);
                    this.playerId = id;
                    this.setupPeerEventHandlers();
                    resolve();
                });
                
                this.peer.on('error', (error) => {
                    clearTimeout(connectionTimeout);
                    console.warn(`❌ PeerJS error with ${config.host}:`, error.message);
                    serverIndex++;
                    tryNextServer();
                });
            };
            
            tryNextServer();
        });
    }
    
    setupPeerEventHandlers() {
        this.peer.on('connection', (conn) => {
            this.handleIncomingConnection(conn);
        });
        
        this.peer.on('disconnected', () => {
            console.warn('⚠️ PeerJS disconnected, attempting reconnection...');
            this.attemptReconnection();
        });
        
        this.peer.on('error', (error) => {
            console.warn('⚠️ PeerJS runtime error:', error);
            // Don't crash, just log the error
        });
    }
    
    initOfflineMode() {
        this.isOfflineMode = true;
        this.peer = null;
        
        // Create a local player for offline mode
        this.createLocalPlayer();
        
        // Start a simple update loop for offline mode
        this.startUpdateLoop();
        
        console.log('🔌 Running in offline mode - multiplayer disabled');
    }
    
    setupMessageHandlers() {
        if (this.isOfflineMode) return;
        
        // Handle different message types
        this.on('playerUpdate', this.handlePlayerUpdate.bind(this));
        this.on('objectUpdate', this.handleObjectUpdate.bind(this));
        this.on('physicsEvent', this.handlePhysicsEvent.bind(this));
        this.on('playerJoined', this.handlePlayerJoined.bind(this));
        this.on('playerLeft', this.handlePlayerLeft.bind(this));
    }
    
    // Room management
    createRoom() {
        if (this.isOfflineMode || !this.isInitialized) {
            console.warn('⚠️ Cannot create room in offline mode');
            return null;
        }
        
        this.roomId = this.generateRoomId();
        this.isHost = true;
        
        // Create local player
        this.createLocalPlayer();
        
        console.log(`🏠 Room created: ${this.roomId}`);
        this.emit('roomCreated', this.roomId);
        
        return this.roomId;
    }
    
    async joinRoom(roomId) {
        if (this.isOfflineMode || !this.isInitialized) {
            console.warn('⚠️ Cannot join room in offline mode');
            return false;
        }
        
        try {
            this.roomId = roomId.toUpperCase();
            this.isHost = false;
            
            // Find host peer ID (in a real implementation, you'd have a matchmaking server)
            const hostId = await this.findHostForRoom(roomId);
            
            if (!hostId) {
                throw new Error('Room not found or host is offline');
            }
            
            // Connect to host
            const conn = this.peer.connect(hostId, {
                label: 'game-connection',
                metadata: {
                    roomId: this.roomId,
                    playerId: this.playerId,
                    playerName: `Player_${this.playerId.slice(-4)}`
                }
            });
            
            await this.setupConnection(conn);
            
            // Create local player
            this.createLocalPlayer();
            
            console.log(`🚪 Joined room: ${this.roomId}`);
            this.emit('roomJoined', this.roomId);
            
            return true;
            
        } catch (error) {
            console.error('Failed to join room:', error);
            this.emit('connectionError', error.message);
            return false;
        }
    }
    
    async findHostForRoom(roomId) {
        // Simplified room discovery - in production, use a matchmaking server
        // For now, we'll use a naming convention: host ID = room ID
        return new Promise((resolve) => {
            if (!this.peer) {
                resolve(null);
                return;
            }
            
            // Try to connect to a peer with the room ID
            const testConn = this.peer.connect(roomId);
            
            testConn.on('open', () => {
                testConn.close();
                resolve(roomId);
            });
            
            testConn.on('error', () => {
                resolve(null);
            });
            
            // Timeout after 5 seconds
            setTimeout(() => {
                testConn.close();
                resolve(null);
            }, 5000);
        });
    }
    
    handleIncomingConnection(conn) {
        console.log('📞 Incoming connection from:', conn.peer);
        
        if (this.connections.size >= window.Constants.NETWORK.MAX_PLAYERS - 1) {
            conn.close();
            return;
        }
        
        this.setupConnection(conn);
    }
    
    async setupConnection(conn) {
        return new Promise((resolve, reject) => {
            conn.on('open', () => {
                console.log(`✅ Connected to ${conn.peer}`);
                
                this.connections.set(conn.peer, conn);
                
                // Setup message handling
                conn.on('data', (data) => {
                    this.handleMessage(conn.peer, data);
                });
                
                conn.on('close', () => {
                    this.handleDisconnection(conn.peer);
                });
                
                conn.on('error', (error) => {
                    console.error(`Connection error with ${conn.peer}:`, error);
                    this.handleDisconnection(conn.peer);
                });
                
                // Send initial handshake
                this.sendTo(conn.peer, {
                    type: 'handshake',
                    playerId: this.playerId,
                    roomId: this.roomId,
                    timestamp: Date.now()
                });
                
                this.emit('playerJoined', conn.peer);
                resolve();
            });
            
            conn.on('error', (error) => {
                console.error('Connection setup error:', error);
                reject(error);
            });
        });
    }
    
    handleDisconnection(peerId) {
        console.log(`📴 Player ${peerId} disconnected`);
        
        this.connections.delete(peerId);
        
        // Remove player from world
        const player = this.players.get(peerId);
        if (player) {
            this.world.removePlayer(peerId);
            this.players.delete(peerId);
        }
        
        this.emit('playerLeft', peerId);
    }
    
    // Message handling
    handleMessage(senderId, data) {
        if (!data || !data.type) return;
        
        this.packetsReceived++;
        
        // Handle ping/pong for latency measurement
        if (data.type === 'ping') {
            this.sendTo(senderId, { type: 'pong', timestamp: data.timestamp });
            return;
        }
        
        if (data.type === 'pong') {
            const pingTime = Date.now() - data.timestamp;
            this.pingTimes.set(senderId, pingTime);
            return;
        }
        
        // Add sender info and emit event
        data.senderId = senderId;
        this.emit(data.type, data);
        
        // Forward messages to other peers if we're the host
        if (this.isHost && data.type !== 'handshake') {
            this.forwardMessage(senderId, data);
        }
    }
    
    forwardMessage(originalSender, data) {
        // Forward message to all other connected peers
        for (const [peerId, conn] of this.connections) {
            if (peerId !== originalSender) {
                this.sendTo(peerId, data);
            }
        }
    }
    
    // Player management
    createLocalPlayer() {
        const spawnPosition = this.getSpawnPosition();
        const playerColor = this.getPlayerColor();
        
        this.localPlayer = this.world.addPlayer(this.playerId, spawnPosition, playerColor);
        this.players.set(this.playerId, this.localPlayer);
        
        console.log(`👤 Local player created at`, spawnPosition);
    }
    
    getSpawnPosition() {
        const spawnRadius = 8;
        const angle = Math.random() * Math.PI * 2;
        const height = (Math.random() - 0.5) * 4;
        
        return new THREE.Vector3(
            Math.cos(angle) * spawnRadius,
            height,
            Math.sin(angle) * spawnRadius
        );
    }
    
    getPlayerColor() {
        const colors = window.Constants.GAMEPLAY.PLAYER_COLORS;
        const usedColors = Array.from(this.players.values()).map(p => p.material?.color?.getHex());
        
        for (const color of colors) {
            const colorHex = new THREE.Color(color).getHex();
            if (!usedColors.includes(colorHex)) {
                return colorHex;
            }
        }
        
        // Fallback to random color if all are used
        return colors[Math.floor(Math.random() * colors.length)];
    }
    
    // Message handlers
    handlePlayerUpdate(data) {
        const { senderId, position, rotation, velocity, timestamp } = data;
        
        let player = this.players.get(senderId);
        if (!player) {
            // Create remote player
            const playerColor = this.getPlayerColor();
            player = this.world.addPlayer(senderId, new THREE.Vector3(), playerColor);
            this.players.set(senderId, player);
        }
        
        // Apply position with interpolation for smooth movement
        this.interpolatePlayerPosition(player, position, rotation, velocity, timestamp);
    }
    
    interpolatePlayerPosition(player, targetPos, targetRot, velocity, timestamp) {
        if (!player) return;
        
        // Simple linear interpolation for smooth movement
        const currentPos = player.position;
        const lerpFactor = 0.2;
        
        currentPos.lerp(new THREE.Vector3(targetPos.x, targetPos.y, targetPos.z), lerpFactor);
        
        // Update rotation
        player.quaternion.slerp(
            new THREE.Quaternion(targetRot.x, targetRot.y, targetRot.z, targetRot.w),
            lerpFactor
        );
        
        // Apply velocity to physics body if available
        const rigidBody = this.physics.getRigidBody(player.uuid);
        if (rigidBody && velocity) {
            this.physics.setVelocity(player.uuid, velocity);
        }
    }
    
    handleObjectUpdate(data) {
        // Handle floating object state updates
        const { objectId, position, rotation, velocity } = data;
        
        const floatingObjects = this.world.getFloatingObjects();
        const object = floatingObjects.find(obj => obj.uuid === objectId);
        
        if (object) {
            object.position.copy(position);
            object.quaternion.copy(rotation);
            
            if (velocity) {
                this.physics.setVelocity(objectId, velocity);
            }
        }
    }
    
    handlePhysicsEvent(data) {
        // Handle physics events like collisions, grabs, etc.
        const { eventType, objectId, playerId, force, position } = data;
        
        switch (eventType) {
            case 'grab':
                this.handleRemoteGrab(playerId, objectId, position);
                break;
            case 'release':
                this.handleRemoteRelease(playerId, objectId);
                break;
            case 'collision':
                this.handleRemoteCollision(data);
                break;
        }
    }
    
    handleRemoteGrab(playerId, objectId, position) {
        // Visual/audio feedback for remote player grabbing an object
        console.log(`Player ${playerId} grabbed object ${objectId}`);
    }
    
    handleRemoteRelease(playerId, objectId) {
        // Visual/audio feedback for remote player releasing an object
        console.log(`Player ${playerId} released object ${objectId}`);
    }
    
    handleRemoteCollision(data) {
        // Handle remote collision events
        console.log('Remote collision:', data);
    }
    
    handlePlayerJoined(data) {
        const { senderId } = data;
        console.log(`🎉 Player ${senderId} joined the game`);
    }
    
    handlePlayerLeft(data) {
        const { senderId } = data;
        console.log(`👋 Player ${senderId} left the game`);
    }
    
    // Sending methods
    broadcast(message) {
        if (this.isOfflineMode) return;
        
        for (const [peerId, conn] of this.connections) {
            this.sendTo(peerId, message);
        }
        this.packetsSent += this.connections.size;
    }
    
    sendTo(peerId, message) {
        if (this.isOfflineMode) return;
        
        const conn = this.connections.get(peerId);
        if (conn && conn.open) {
            try {
                conn.send(message);
                this.packetsSent++;
            } catch (error) {
                console.error(`Failed to send message to ${peerId}:`, error);
            }
        }
    }
    
    // Update loop
    startUpdateLoop() {
        const update = () => {
            const now = Date.now();
            
            if (now - this.lastUpdateTime >= this.updateInterval) {
                if (!this.isOfflineMode) {
                    this.sendPlayerUpdate();
                    this.sendPings();
                }
                this.lastUpdateTime = now;
            }
            
            requestAnimationFrame(update);
        };
        
        update();
    }
    
    sendPlayerUpdate() {
        if (!this.localPlayer || this.connections.size === 0) return;
        
        // Get current player state
        const position = this.localPlayer.position;
        const rotation = this.localPlayer.quaternion;
        const velocity = this.physics.getVelocity(this.localPlayer.uuid);
        
        this.localPlayerState = {
            position: { x: position.x, y: position.y, z: position.z },
            rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
            velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
            timestamp: Date.now()
        };
        
        this.broadcast({
            type: window.Constants.NETWORK.MESSAGE_TYPES.PLAYER_UPDATE,
            ...this.localPlayerState
        });
    }
    
    sendPings() {
        const timestamp = Date.now();
        for (const peerId of this.connections.keys()) {
            this.sendTo(peerId, { type: 'ping', timestamp });
        }
    }
    
    // Public API methods
    sendPhysicsEvent(eventType, data) {
        if (this.isOfflineMode) return;
        
        this.broadcast({
            type: window.Constants.NETWORK.MESSAGE_TYPES.PHYSICS_EVENT,
            eventType,
            playerId: this.playerId,
            timestamp: Date.now(),
            ...data
        });
    }
    
    sendObjectUpdate(objectId, position, rotation, velocity) {
        if (this.isOfflineMode) return;
        
        this.broadcast({
            type: window.Constants.NETWORK.MESSAGE_TYPES.OBJECT_UPDATE,
            objectId,
            position,
            rotation,
            velocity,
            timestamp: Date.now()
        });
    }
    
    getConnectedPlayers() {
        return Array.from(this.players.entries()).map(([id, player]) => ({
            id,
            name: `Player_${id.slice(-4)}`,
            isLocal: id === this.playerId,
            ping: this.pingTimes.get(id) || 0
        }));
    }
    
    getPingTime(playerId) {
        return this.pingTimes.get(playerId) || 0;
    }
    
    getNetworkStats() {
        return {
            isOfflineMode: this.isOfflineMode,
            isHost: this.isHost,
            roomId: this.roomId,
            connectedPlayers: this.isOfflineMode ? 1 : this.connections.size + 1,
            packetsReceived: this.packetsReceived,
            packetsSent: this.packetsSent,
            averagePing: this.isOfflineMode ? 0 : Array.from(this.pingTimes.values()).reduce((a, b) => a + b, 0) / this.pingTimes.size || 0
        };
    }
    
    // Event system
    on(eventType, callback) {
        if (!this.eventCallbacks.has(eventType)) {
            this.eventCallbacks.set(eventType, []);
        }
        this.eventCallbacks.get(eventType).push(callback);
    }
    
    emit(eventType, data) {
        const callbacks = this.eventCallbacks.get(eventType);
        if (callbacks) {
            callbacks.forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    console.error(`Error in ${eventType} callback:`, error);
                }
            });
        }
    }
    
    // Utility methods
    generatePlayerId() {
        return 'player_' + Math.random().toString(36).substr(2, 9);
    }
    
    generateRoomId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < window.Constants.NETWORK.ROOM_ID_LENGTH; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
    
    attemptReconnection() {
        if (this.peer && this.peer.destroyed) {
            setTimeout(() => {
                this.initPeerJS().catch(error => {
                    console.warn('Reconnection failed:', error);
                    // Could switch to offline mode here
                });
            }, 2000);
        }
    }
    
    // Update method (called from main loop)
    update() {
        // Process any queued messages or network operations
        // This is called from the main render loop
    }
    
    // Cleanup
    destroy() {
        if (this.peer) {
            this.peer.destroy();
        }
        
        this.connections.clear();
        this.players.clear();
        this.eventCallbacks.clear();
        
        console.log('✅ Network Manager destroyed');
    }
}; 