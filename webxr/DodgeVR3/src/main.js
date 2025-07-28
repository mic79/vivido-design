// Zero-G WebXR Multiplayer - Main Application Entry Point

class ZeroGApp {
    constructor() {
        this.isInitialized = false;
        this.isVRMode = false;
        this.loadingProgress = 0;
        
        // Core systems
        this.world = null;
        this.physics = null;
        this.network = null;
        this.audio = null;
        this.vrControls = null;
        this.desktopControls = null;
        this.performanceMonitor = null;
        
        // Initialize polyfill for older browsers
        if (window.WebXRPolyfill) {
            new WebXRPolyfill();
        }
        
        this.init();
    }
    
    async init() {
        try {
            console.log('🚀 Initializing Zero-G WebXR Application...');
            this.updateLoadingStatus('Checking WebXR support...', 10);
            
            // Check WebXR support
            this.checkWebXRSupport();
            
            // Initialize core systems
            this.updateLoadingStatus('Loading physics engine...', 25);
            await this.initPhysics();
            
            this.updateLoadingStatus('Creating 3D world...', 50);
            await this.initWorld();
            
            this.updateLoadingStatus('Setting up audio...', 70);
            await this.initAudio();
            
            this.updateLoadingStatus('Initializing controls...', 85);
            await this.initControls();
            
            // Skip network initialization - start in singleplayer mode
            console.log('🔌 Starting in singleplayer mode (multiplayer disabled)');
            
            // Initialize monitoring
            this.updateLoadingStatus('Starting performance monitor...', 95);
            this.initPerformanceMonitor();
            
            // Start render loop
            this.updateLoadingStatus('Ready!', 100);
            this.startRenderLoop();
            
            console.log('✅ Zero-G WebXR Application initialized successfully');
            
            // Hide loading screen and show success
            this.hideLoadingScreen();
            
        } catch (error) {
            console.error('❌ Failed to initialize application:', error);
            this.updateLoadingStatus(`Error: ${error.message}`, 0, true);
        }
    }
    
    async checkWebXRSupport() {
        // Check for WebXR support
        if ('xr' in navigator) {
            try {
                const isSupported = await navigator.xr.isSessionSupported('immersive-vr');
                console.log('WebXR VR Support:', isSupported);
            } catch (error) {
                console.warn('WebXR check failed:', error);
            }
        } else {
            console.warn('WebXR not supported, falling back to desktop mode');
        }
    }
    
    async initPhysics() {
        this.physics = new window.PhysicsManager();
        await this.physics.init();
        console.log('✅ Physics engine initialized');
    }
    
    async initWorld() {
        this.world = new window.ZeroGWorld(this.physics);
        await this.world.init();
        
        // Setup VR button
        this.setupVRButton();
        
        console.log('✅ 3D world initialized');
    }
    
    async initAudio() {
        this.audio = new window.AudioManager();
        await this.audio.init();
        console.log('✅ Audio system initialized');
    }
    
    async initControls() {
        console.log('🎮 Initializing control systems...');
        
        // Initialize VR controller system
        this.vrControls = new window.VRControllerSystem(this.world, this.physics, this.audio);
        await this.vrControls.init();
        
        // Initialize desktop controls
        this.desktopControls = new window.DesktopControls(this.world, this.physics);
        await this.desktopControls.init();
        
        // Setup VR button
        this.setupVRButton();
        
        // Set up VR session event listeners
        const renderer = this.world.getRenderer();
        renderer.xr.addEventListener('sessionstart', () => {
            this.onVRSessionStart();
        });
        
        renderer.xr.addEventListener('sessionend', () => {
            this.onVRSessionEnd();
        });
        
        console.log('✅ Control systems initialized');
    }
    
    setupVRButton() {
        const container = document.getElementById('vr-button-container');
        if (container && this.world.getRenderer().xr.enabled) {
            const vrButton = window.THREE.VRButton.createButton(this.world.getRenderer());
            vrButton.className = 'webxr-button';
            container.appendChild(vrButton);
            console.log('✅ VR button created');
        } else {
            console.warn('⚠️ VR button container not found or WebXR not enabled');
        }
    }
    
    initPerformanceMonitor() {
        console.log('📊 Starting performance monitor...');
        
        this.performanceMonitor = new window.PerformanceMonitor();
        this.performanceMonitor.start();
        
        console.log('✅ Performance monitor started');
    }
    
    startRenderLoop() {
        const animate = () => {
            this.world.getRenderer().setAnimationLoop(animate);
            
            // Update systems
            this.world.update();
            this.physics.update();
            this.vrControls.update();
            this.desktopControls.update();
            
            if (this.performanceMonitor) {
                this.performanceMonitor.update();
            }
            
            // Render frame
            this.world.render();
        };
        
        animate();
    }
    
    onVRSessionStart() {
        console.log('🥽 VR session started');
        this.isVRMode = true;
        
        // Hide desktop UI in VR
        const uiOverlay = document.getElementById('ui-overlay');
        if (uiOverlay) {
            uiOverlay.style.display = 'none';
        }
        
        // Enable VR controls
        this.vrControls.enable();
        this.desktopControls.disable();
    }
    
    onVRSessionEnd() {
        console.log('🖥️ VR session ended');
        this.isVRMode = false;
        
        // Show desktop UI
        const uiOverlay = document.getElementById('ui-overlay');
        if (uiOverlay) {
            uiOverlay.style.display = 'block';
        }
        
        // Enable desktop controls
        this.vrControls.disable();
        this.desktopControls.enable();
    }
    
    updateStatus(message, type = 'info') {
        console.log(`Status: ${message}`);
        
        // Update UI if elements exist
        const statusElement = document.getElementById('status-message');
        if (statusElement) {
            statusElement.textContent = message;
            statusElement.className = type;
        }
    }
    
    updateLoadingStatus(message, progress = 0, isError = false) {
        console.log(`📊 Loading: ${message} (${progress}%)`);
        
        const loadingText = document.getElementById('loading-text');
        const loadingProgress = document.getElementById('loading-progress');
        
        if (loadingText) {
            loadingText.textContent = message;
            loadingText.style.color = isError ? '#ff6666' : '#ffffff';
        }
        
        if (loadingProgress) {
            loadingProgress.style.width = `${progress}%`;
        }
    }
    
    hideLoadingScreen() {
        const loadingScreen = document.getElementById('loading-screen');
        if (loadingScreen) {
            // Smooth fade out
            loadingScreen.style.transition = 'opacity 0.5s ease-out';
            loadingScreen.style.opacity = '0';
            
            setTimeout(() => {
                loadingScreen.style.display = 'none';
                console.log('✅ Loading screen hidden - game ready!');
                
                // Update connection status
                this.updateConnectionStatus();
            }, 500);
        }
    }
    
    updateConnectionStatus() {
        const connectionStatus = document.getElementById('connection-status');
        if (connectionStatus) {
            connectionStatus.textContent = 'Singleplayer Mode';
            connectionStatus.className = 'offline';
        }
    }
    
    // Public API methods
    getWorld() { return this.world; }
    getPhysics() { return this.physics; }
    getAudio() { return this.audio; }
    getVRControls() { return this.vrControls; }
    getDesktopControls() { return this.desktopControls; }
    
    // Cleanup method
    destroy() {
        if (this.performanceMonitor) this.performanceMonitor.stop();
        if (this.audio) this.audio.destroy();
        if (this.physics) this.physics.destroy();
        if (this.world) this.world.destroy();
        if (this.vrControls) this.vrControls.destroy();
        if (this.desktopControls) this.desktopControls.destroy();
    }
};

// Global error handling
window.addEventListener('error', (event) => {
    console.error('Global error:', event.error);
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
});

// Initialize application - handle both cases: DOM already loaded or still loading
function initializeApp() {
    console.log('🎯 Starting Zero-G Application...');
    window.zeroGApp = new ZeroGApp();
}

// Check if DOM is already loaded (since we're loading scripts dynamically)
if (document.readyState === 'loading') {
    // DOM is still loading, wait for it
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    // DOM is already loaded, initialize immediately
    initializeApp();
}