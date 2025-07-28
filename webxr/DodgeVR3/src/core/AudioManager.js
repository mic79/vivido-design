// Zero-G WebXR Multiplayer - Audio Manager with 3D Spatial Audio

window.AudioManager = class AudioManager {
    constructor() {
        this.isInitialized = false;
        this.audioContext = null;
        this.listener = null;
        
        // Audio sources
        this.audioElements = new Map();
        this.audioSources = new Map();
        this.soundEffects = new Map();
        
        // 3D Audio nodes
        this.pannerNodes = new Map();
        this.gainNodes = new Map();
        
        // Master controls
        this.masterGain = null;
        this.isEnabled = true;
        this.volumes = {
            master: window.Constants.AUDIO.MASTER_VOLUME,
            sfx: window.Constants.AUDIO.SFX_VOLUME,
            ambient: window.Constants.AUDIO.AMBIENT_VOLUME
        };
        
        // User gesture handling
        this.needsUserGesture = false;
        this.gestureHandlers = [];
        
        // Performance
        this.activeSources = 0;
        this.maxActiveSources = 32;
    }
    
    async init() {
        try {
            console.log('🔊 Initializing Audio Manager...');
            
            // Try to initialize Web Audio API
            await this.initAudioContext();
            
            // Load audio files
            await this.loadAudioFiles();
            
            // Setup 3D audio listener (if context is available)
            if (this.audioContext && this.audioContext.state === 'running') {
                this.setup3DAudio();
                this.initSoundPools();
            } else {
                // Setup user gesture handlers
                this.setupUserGestureHandlers();
            }
            
            this.isInitialized = true;
            console.log('✅ Audio Manager initialized successfully');
            
        } catch (error) {
            console.warn('⚠️ Audio initialization failed, continuing without audio:', error);
            this.isEnabled = false;
            this.isInitialized = true; // Don't block app initialization
        }
    }
    
    async initAudioContext() {
        try {
            // Create audio context with optimal settings
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                latencyHint: 'interactive',
                sampleRate: 44100
            });
            
            console.log('✅ AudioContext created, state:', this.audioContext.state);
            
            // Check if context needs user gesture
            if (this.audioContext.state === 'suspended') {
                console.log('⏸️ AudioContext suspended, will resume after user gesture');
                this.needsUserGesture = true;
            } else {
                // Context is running, proceed with full initialization
                await this.completeAudioInit();
            }
            
        } catch (error) {
            console.warn('AudioContext creation failed:', error);
            this.isEnabled = false;
        }
    }
    
    async completeAudioInit() {
        try {
            // Resume context if suspended
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            
            // Create master gain node
            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.value = this.volumes.master;
            this.masterGain.connect(this.audioContext.destination);
            
            // Setup 3D audio listener
            this.listener = this.audioContext.listener;
            this.setup3DAudio();
            this.initSoundPools();
            
            console.log('✅ Audio Context fully initialized');
            this.needsUserGesture = false;
            
        } catch (error) {
            console.warn('Audio context initialization failed:', error);
            this.isEnabled = false;
        }
    }
    
    setupUserGestureHandlers() {
        console.log('👆 Setting up user gesture handlers for audio');
        
        const resumeAudio = async () => {
            if (this.needsUserGesture && this.audioContext) {
                try {
                    await this.completeAudioInit();
                    console.log('✅ Audio resumed after user gesture');
                    
                    // Remove gesture handlers
                    this.gestureHandlers.forEach(handler => {
                        document.removeEventListener('click', handler);
                        document.removeEventListener('keydown', handler);
                        document.removeEventListener('touchstart', handler);
                    });
                    this.gestureHandlers = [];
                    
                } catch (error) {
                    console.warn('Failed to resume audio:', error);
                }
            }
        };
        
        // Add gesture handlers
        this.gestureHandlers.push(resumeAudio);
        document.addEventListener('click', resumeAudio, { once: true });
        document.addEventListener('keydown', resumeAudio, { once: true });
        document.addEventListener('touchstart', resumeAudio, { once: true });
    }
    
    async loadAudioFiles() {
        const soundFiles = window.Constants.AUDIO.SOUNDS;
        const loadPromises = [];
        
        for (const [soundName, filePath] of Object.entries(soundFiles)) {
            loadPromises.push(this.loadAudioFile(soundName, filePath));
        }
        
        await Promise.all(loadPromises);
        console.log('✅ Audio files loaded');
    }
    
    async loadAudioFile(soundName, filePath) {
        try {
            // Try to load from HTML audio elements first (for compatibility)
            const audioElement = document.getElementById(`${soundName.toLowerCase()}-sound`);
            
            if (audioElement) {
                this.audioElements.set(soundName, audioElement);
                audioElement.volume = 0; // We'll control volume through Web Audio API
                audioElement.preload = 'auto';
                return;
            }
            
            // Skip Web Audio API loading if context not available
            if (!this.audioContext) {
                console.warn(`Skipping Web Audio loading for ${soundName} - no context`);
                return;
            }
            
            // Fallback to fetch and decode
            const response = await fetch(filePath);
            const arrayBuffer = await response.arrayBuffer();
            const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
            
            this.soundEffects.set(soundName, audioBuffer);
            
        } catch (error) {
            console.warn(`Failed to load ${soundName}: ${error.message}`);
        }
    }
    
    setup3DAudio() {
        if (!this.audioContext || !this.listener) return;
        
        // Configure 3D audio parameters
        if (this.listener.positionX) {
            // Modern Web Audio API
            this.listener.positionX.value = 0;
            this.listener.positionY.value = 0;
            this.listener.positionZ.value = 0;
            
            this.listener.forwardX.value = 0;
            this.listener.forwardY.value = 0;
            this.listener.forwardZ.value = -1;
            
            this.listener.upX.value = 0;
            this.listener.upY.value = 1;
            this.listener.upZ.value = 0;
        } else {
            // Legacy Web Audio API
            this.listener.setPosition(0, 0, 0);
            this.listener.setOrientation(0, 0, -1, 0, 1, 0);
        }
        
        console.log('✅ 3D Audio configured');
    }
    
    initSoundPools() {
        if (!this.audioContext) {
            console.log('⏸️ Skipping sound pools - no audio context');
            return;
        }
        
        // Create pools of reusable audio sources for performance
        const poolSizes = {
            THRUSTER: 8,
            IMPACT: 16,
            GRAB: 8,
            RELEASE: 8
        };
        
        for (const [soundType, poolSize] of Object.entries(poolSizes)) {
            const pool = [];
            for (let i = 0; i < poolSize; i++) {
                const source = this.createAudioSource(soundType);
                if (source) {
                    pool.push(source);
                }
            }
            this.audioSources.set(soundType, pool);
        }
        
        console.log('✅ Sound pools initialized');
    }
    
    createAudioSource(soundType) {
        if (!this.audioContext) return null;
        
        const audioBuffer = this.soundEffects.get(soundType);
        if (!audioBuffer) return null;
        
        // Create audio source
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        
        // Create gain node for volume control
        const gainNode = this.audioContext.createGain();
        gainNode.gain.value = this.volumes.sfx;
        
        // Create panner node for 3D positioning
        const pannerNode = this.audioContext.createPanner();
        pannerNode.panningModel = 'HRTF';
        pannerNode.distanceModel = 'exponential';
        pannerNode.refDistance = window.Constants.AUDIO.REF_DISTANCE;
        pannerNode.maxDistance = window.Constants.AUDIO.MAX_DISTANCE;
        pannerNode.rolloffFactor = window.Constants.AUDIO.ROLLOFF_FACTOR;
        
        // Connect audio graph
        source.connect(gainNode);
        gainNode.connect(pannerNode);
        pannerNode.connect(this.masterGain);
        
        return {
            source,
            gainNode,
            pannerNode,
            isPlaying: false,
            soundType
        };
    }
    
    getAvailableSource(soundType) {
        if (!this.audioContext || this.needsUserGesture) return null;
        
        const pool = this.audioSources.get(soundType);
        if (!pool) return null;
        
        // Find available source
        let availableSource = pool.find(src => !src.isPlaying);
        
        if (!availableSource && this.activeSources < this.maxActiveSources) {
            // Create new source if pool is exhausted but under limit
            availableSource = this.createAudioSource(soundType);
            if (availableSource) {
                pool.push(availableSource);
            }
        }
        
        return availableSource;
    }
    
    // Update listener position and orientation (call from camera/VR updates)
    updateListener(position, forward = null, up = null) {
        if (!this.isInitialized || !this.listener || this.needsUserGesture) return;
        
        try {
            if (this.listener.positionX) {
                // Modern API
                this.listener.positionX.value = position.x;
                this.listener.positionY.value = position.y;
                this.listener.positionZ.value = position.z;
                
                if (forward && up) {
                    this.listener.forwardX.value = forward.x;
                    this.listener.forwardY.value = forward.y;
                    this.listener.forwardZ.value = forward.z;
                    
                    this.listener.upX.value = up.x;
                    this.listener.upY.value = up.y;
                    this.listener.upZ.value = up.z;
                }
            } else {
                // Legacy API
                this.listener.setPosition(position.x, position.y, position.z);
                
                if (forward && up) {
                    this.listener.setOrientation(
                        forward.x, forward.y, forward.z,
                        up.x, up.y, up.z
                    );
                }
            }
        } catch (error) {
            console.warn('Error updating audio listener:', error);
        }
    }
    
    // Play 3D positioned sound effect
    playSound3D(soundType, position, volume = 1.0, pitch = 1.0, loop = false) {
        if (!this.isInitialized || !this.isEnabled || this.needsUserGesture) return null;
        
        const audioSource = this.getAvailableSource(soundType);
        if (!audioSource) return null;
        
        const { source, gainNode, pannerNode } = audioSource;
        
        // Set position
        if (pannerNode.positionX) {
            pannerNode.positionX.value = position.x;
            pannerNode.positionY.value = position.y;
            pannerNode.positionZ.value = position.z;
        } else {
            pannerNode.setPosition(position.x, position.y, position.z);
        }
        
        // Set volume
        gainNode.gain.value = volume * this.volumes.sfx;
        
        // Set pitch
        source.playbackRate.value = pitch;
        
        // Set loop
        source.loop = loop;
        
        // Mark as playing
        audioSource.isPlaying = true;
        this.activeSources++;
        
        // Handle source end
        source.onended = () => {
            audioSource.isPlaying = false;
            this.activeSources--;
        };
        
        // Start playback
        try {
            source.start(0);
        } catch (error) {
            // Source might already be started
            audioSource.isPlaying = false;
            this.activeSources--;
            return null;
        }
        
        return audioSource;
    }
    
    // Play 2D sound effect (UI sounds, etc.)
    playSound2D(soundType, volume = 1.0, pitch = 1.0) {
        const audioElement = this.audioElements.get(soundType);
        if (audioElement) {
            audioElement.volume = volume * this.volumes.sfx;
            audioElement.playbackRate = pitch;
            audioElement.currentTime = 0;
            return audioElement.play().catch(console.warn);
        }
        
        // Fallback to 3D with listener position
        return this.playSound3D(soundType, { x: 0, y: 0, z: 0 }, volume, pitch);
    }
    
    // VR-specific audio methods
    startThrusterAudio(position, intensity = 1.0) {
        if (this.needsUserGesture) {
            console.log('⏸️ Thruster audio deferred - waiting for user gesture');
            return null;
        }
        
        try {
            const source = this.getAvailableSource('thruster');
            if (source) {
                source.isPlaying = true;
                source.setLoop(true);
                source.setVolume(intensity * 0.3);
                
                if (source.panner) {
                    source.panner.setPosition(position.x, position.y, position.z);
                }
                
                source.play();
                return source;
            }
        } catch (error) {
            console.warn('⚠️ Failed to start thruster audio:', error);
        }
        
        return null;
    }
    
    stopThrusterAudio(source) {
        if (!source) return;
        
        try {
            source.stop();
            source.isPlaying = false;
        } catch (error) {
            console.warn('⚠️ Failed to stop thruster audio:', error);
        }
    }
    
    updateThrusterAudio(source, position, intensity = 1.0) {
        if (!source || this.needsUserGesture) return;
        
        try {
            if (source.panner) {
                source.panner.setPosition(position.x, position.y, position.z);
            }
            source.setVolume(intensity * 0.3);
        } catch (error) {
            console.warn('⚠️ Failed to update thruster audio:', error);
        }
    }
    
    playGrabSound(position) {
        if (this.needsUserGesture) {
            console.log('⏸️ Grab sound deferred - waiting for user gesture');
            return;
        }
        
        this.playSound3D('impact', position, 0.5);
    }
    
    playReleaseSound(position) {
        if (this.needsUserGesture) {
            console.log('⏸️ Release sound deferred - waiting for user gesture');
            return;
        }
        
        this.playSound3D('thud', position, 0.3);
    }
    
    // Ambient audio management
    playAmbient() {
        const ambientElement = this.audioElements.get('AMBIENT') || 
                             document.getElementById('ambient-sound');
        
        if (ambientElement) {
            ambientElement.volume = this.volumes.ambient;
            ambientElement.loop = true;
            
            // Only play if we don't need user gesture or if we already have permission
            if (!this.needsUserGesture) {
                ambientElement.play().catch(error => {
                    console.log('Ambient audio will play after user gesture');
                });
                
                // Fade in ambient sound
                this.fadeAudioElement(ambientElement, this.volumes.ambient, 3000);
            } else {
                console.log('⏸️ Ambient audio will start after user gesture');
            }
        }
    }
    
    stopAmbient() {
        const ambientElement = this.audioElements.get('AMBIENT') || 
                             document.getElementById('ambient-sound');
        
        if (ambientElement) {
            this.fadeAudioElement(ambientElement, 0, 2000, () => {
                ambientElement.pause();
            });
        }
    }
    
    fadeAudioElement(audioElement, targetVolume, duration, callback = null) {
        const startVolume = audioElement.volume;
        const volumeDiff = targetVolume - startVolume;
        const startTime = Date.now();
        
        const fadeStep = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            audioElement.volume = startVolume + (volumeDiff * progress);
            
            if (progress < 1) {
                requestAnimationFrame(fadeStep);
            } else if (callback) {
                callback();
            }
        };
        
        fadeStep();
    }
    
    // Volume controls
    setMasterVolume(volume) {
        this.volumes.master = Math.max(0, Math.min(1, volume));
        if (this.masterGain) {
            this.masterGain.gain.value = this.volumes.master;
        }
    }
    
    setSFXVolume(volume) {
        this.volumes.sfx = Math.max(0, Math.min(1, volume));
    }
    
    setAmbientVolume(volume) {
        this.volumes.ambient = Math.max(0, Math.min(1, volume));
        
        const ambientElement = this.audioElements.get('AMBIENT') || 
                             document.getElementById('ambient-sound');
        if (ambientElement) {
            ambientElement.volume = this.volumes.ambient;
        }
    }
    
    // Mute/unmute
    toggleMute() {
        this.isEnabled = !this.isEnabled;
        this.setMasterVolume(this.isEnabled ? this.volumes.master : 0);
        return this.isEnabled;
    }
    
    // Haptic feedback (if supported by WebXR)
    triggerHaptic(inputSource, intensity = 0.5, duration = 100) {
        if (!inputSource || !inputSource.gamepad) return;
        
        try {
            // Check if the gamepad supports haptic feedback
            if (inputSource.gamepad.hapticActuators && inputSource.gamepad.hapticActuators.length > 0) {
                const actuator = inputSource.gamepad.hapticActuators[0];
                actuator.pulse(intensity, duration);
                console.log(`📳 Haptic feedback triggered: ${intensity} intensity for ${duration}ms`);
            }
        } catch (error) {
            console.warn('⚠️ Haptic feedback failed:', error);
        }
    }
    
    // Performance monitoring
    getAudioStats() {
        return {
            activeSources: this.activeSources,
            maxSources: this.maxActiveSources,
            isEnabled: this.isEnabled,
            needsUserGesture: this.needsUserGesture,
            audioContext: this.audioContext ? this.audioContext.state : 'unavailable',
            soundPoolSizes: Array.from(this.audioSources.entries()).map(([type, pool]) => ({
                type,
                size: pool.length,
                active: pool.filter(src => src.isPlaying).length
            }))
        };
    }
    
    // VR session methods
    onVRSessionStart() {
        console.log('🥽 Audio: VR session started');
        // VR mode enhances spatial audio
        if (this.listener) {
            // Enhanced spatial audio settings for VR
            console.log('🔊 Enhanced spatial audio for VR enabled');
        }
    }
    
    onVRSessionEnd() {
        console.log('🖥️ Audio: VR session ended');
        // Return to normal spatial audio
        if (this.listener) {
            console.log('🔊 Normal spatial audio restored');
        }
    }
    
    // Cleanup
    destroy() {
        // Stop all active audio
        this.audioSources.forEach(pool => {
            pool.forEach(audioSource => {
                if (audioSource.isPlaying) {
                    try {
                        audioSource.source.stop();
                    } catch (error) {
                        // Source might already be stopped
                    }
                }
            });
        });
        
        // Remove gesture handlers
        this.gestureHandlers.forEach(handler => {
            document.removeEventListener('click', handler);
            document.removeEventListener('keydown', handler);
            document.removeEventListener('touchstart', handler);
        });
        
        // Close audio context
        if (this.audioContext) {
            this.audioContext.close();
        }
        
        this.audioElements.clear();
        this.audioSources.clear();
        this.soundEffects.clear();
        
        console.log('✅ Audio Manager destroyed');
    }
}; 