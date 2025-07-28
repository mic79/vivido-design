// Zero-G WebXR Multiplayer - Performance Monitor

window.PerformanceMonitor = class PerformanceMonitor {
    constructor(world, physics, network) {
        this.world = world;
        this.physics = physics;
        this.network = network;
        this.isActive = false;
        
        // Performance tracking
        this.startTime = 0;
        this.lastTime = 0;
        this.frameCount = 0;
        this.deltaTime = 0;
        
        // FPS tracking
        this.fps = 0;
        this.fpsHistory = [];
        this.fpsHistorySize = window.Constants.PERFORMANCE.FPS_SAMPLE_SIZE;
        this.lastFpsUpdate = 0;
        
        // Memory tracking
        this.memoryInfo = {
            used: 0,
            total: 0,
            limit: 0
        };
        this.lastMemoryCheck = 0;
        
        // Physics performance
        this.physicsPerformance = {
            stepTime: 0,
            objectCount: 0,
            averageStepTime: 0
        };
        
        // Network performance
        this.networkPerformance = {
            ping: 0,
            packetsPerSecond: 0,
            bytesPerSecond: 0
        };
        
        // UI elements
        this.uiElements = {
            fps: null,
            objects: null,
            ping: null
        };
        
        // Performance warnings
        this.warningThresholds = {
            lowFps: 30,
            highMemory: 0.8,
            highPing: 200
        };
        
        this.warnings = new Set();
    }
    
    start() {
        if (this.isActive) return;
        
        this.isActive = true;
        this.startTime = performance.now();
        this.lastTime = this.startTime;
        this.frameCount = 0;
        
        // Get UI elements
        this.findUIElements();
        
        // Setup periodic tasks
        this.setupPeriodicTasks();
        
        console.log('📊 Performance Monitor started');
    }
    
    stop() {
        this.isActive = false;
        console.log('📊 Performance Monitor stopped');
    }
    
    findUIElements() {
        this.uiElements.fps = document.getElementById('fps-counter');
        this.uiElements.objects = document.getElementById('physics-objects');
        this.uiElements.ping = document.getElementById('network-ping');
    }
    
    setupPeriodicTasks() {
        // Memory check interval
        setInterval(() => {
            if (this.isActive) {
                this.updateMemoryInfo();
            }
        }, window.Constants.PERFORMANCE.MEMORY_CHECK_INTERVAL);
        
        // Performance logging interval
        setInterval(() => {
            if (this.isActive) {
                this.logPerformanceStats();
            }
        }, window.Constants.PERFORMANCE.PERFORMANCE_LOG_INTERVAL);
    }
    
    update() {
        if (!this.isActive) return;
        
        const now = performance.now();
        this.deltaTime = now - this.lastTime;
        this.lastTime = now;
        this.frameCount++;
        
        // Update FPS
        this.updateFPS();
        
        // Update physics performance
        this.updatePhysicsPerformance();
        
        // Update network performance
        this.updateNetworkPerformance();
        
        // Update UI
        this.updateUI();
        
        // Check for performance warnings
        this.checkPerformanceWarnings();
    }
    
    updateFPS() {
        // Calculate instantaneous FPS
        const instantFps = 1000 / this.deltaTime;
        
        // Add to history
        this.fpsHistory.push(instantFps);
        if (this.fpsHistory.length > this.fpsHistorySize) {
            this.fpsHistory.shift();
        }
        
        // Update FPS every 500ms
        const now = performance.now();
        if (now - this.lastFpsUpdate > 500) {
            // Calculate average FPS from history
            this.fps = this.fpsHistory.reduce((sum, fps) => sum + fps, 0) / this.fpsHistory.length;
            this.lastFpsUpdate = now;
        }
    }
    
    updatePhysicsPerformance() {
        if (!this.physics) return;
        
        const physicsStats = this.physics.getStats();
        this.physicsPerformance.objectCount = physicsStats.objectCount;
        
        // Physics step time would need to be measured in PhysicsManager
        // For now, we'll estimate based on object count
        this.physicsPerformance.stepTime = physicsStats.objectCount * 0.1; // Rough estimate
    }
    
    updateNetworkPerformance() {
        if (!this.network) return;
        
        const networkStats = this.network.getNetworkStats();
        this.networkPerformance.ping = networkStats.averagePing;
        
        // Calculate packets per second (simplified)
        const totalPackets = networkStats.packetsReceived + networkStats.packetsSent;
        const elapsedSeconds = (performance.now() - this.startTime) / 1000;
        this.networkPerformance.packetsPerSecond = totalPackets / elapsedSeconds;
    }
    
    updateMemoryInfo() {
        if (performance.memory) {
            this.memoryInfo.used = performance.memory.usedJSHeapSize / 1048576; // MB
            this.memoryInfo.total = performance.memory.totalJSHeapSize / 1048576; // MB
            this.memoryInfo.limit = performance.memory.jsHeapSizeLimit / 1048576; // MB
        }
    }
    
    updateUI() {
        // Update FPS counter
        if (this.uiElements.fps) {
            const fpsText = `FPS: ${Math.round(this.fps)}`;
            const color = this.fps >= 60 ? '#00ff00' : this.fps >= 30 ? '#ffff00' : '#ff0000';
            this.uiElements.fps.textContent = fpsText;
            this.uiElements.fps.style.color = color;
        }
        
        // Update physics objects count
        if (this.uiElements.objects) {
            this.uiElements.objects.textContent = `Objects: ${this.physicsPerformance.objectCount}`;
        }
        
        // Update ping
        if (this.uiElements.ping) {
            const pingText = `Ping: ${Math.round(this.networkPerformance.ping)}ms`;
            const color = this.networkPerformance.ping <= 50 ? '#00ff00' : 
                         this.networkPerformance.ping <= 100 ? '#ffff00' : '#ff0000';
            this.uiElements.ping.textContent = pingText;
            this.uiElements.ping.style.color = color;
        }
    }
    
    checkPerformanceWarnings() {
        const newWarnings = new Set();
        
        // Check FPS
        if (this.fps < this.warningThresholds.lowFps) {
            newWarnings.add('low_fps');
        }
        
        // Check memory usage
        if (this.memoryInfo.used / this.memoryInfo.limit > this.warningThresholds.highMemory) {
            newWarnings.add('high_memory');
        }
        
        // Check ping
        if (this.networkPerformance.ping > this.warningThresholds.highPing) {
            newWarnings.add('high_ping');
        }
        
        // Check for new warnings
        for (const warning of newWarnings) {
            if (!this.warnings.has(warning)) {
                this.onPerformanceWarning(warning);
            }
        }
        
        // Check for resolved warnings
        for (const warning of this.warnings) {
            if (!newWarnings.has(warning)) {
                this.onPerformanceWarningResolved(warning);
            }
        }
        
        this.warnings = newWarnings;
    }
    
    onPerformanceWarning(warningType) {
        const messages = {
            low_fps: `Low FPS detected: ${Math.round(this.fps)}fps`,
            high_memory: `High memory usage: ${Math.round((this.memoryInfo.used / this.memoryInfo.limit) * 100)}%`,
            high_ping: `High ping detected: ${Math.round(this.networkPerformance.ping)}ms`
        };
        
        console.warn('⚠️ Performance Warning:', messages[warningType]);
        
        // Auto-optimization suggestions
        this.suggestOptimizations(warningType);
    }
    
    onPerformanceWarningResolved(warningType) {
        const messages = {
            low_fps: 'FPS improved',
            high_memory: 'Memory usage normalized',
            high_ping: 'Network latency improved'
        };
        
        console.log('✅ Performance Warning Resolved:', messages[warningType]);
    }
    
    suggestOptimizations(warningType) {
        switch (warningType) {
            case 'low_fps':
                console.log('💡 Optimization suggestions:');
                console.log('  - Reduce render quality');
                console.log('  - Decrease physics object count');
                console.log('  - Lower particle count');
                console.log('  - Disable shadows');
                
                // Auto-apply some optimizations
                this.autoOptimizeFPS();
                break;
                
            case 'high_memory':
                console.log('💡 Memory optimization suggestions:');
                console.log('  - Dispose unused geometries/materials');
                console.log('  - Reduce texture sizes');
                console.log('  - Clear audio buffers');
                
                this.autoOptimizeMemory();
                break;
                
            case 'high_ping':
                console.log('💡 Network optimization suggestions:');
                console.log('  - Reduce update rate');
                console.log('  - Compress data packets');
                console.log('  - Use interpolation');
                break;
        }
    }
    
    autoOptimizeFPS() {
        if (!this.world) return;
        
        const renderer = this.world.getRenderer();
        
        // Reduce pixel ratio
        if (renderer.getPixelRatio() > 1) {
            renderer.setPixelRatio(Math.max(1, renderer.getPixelRatio() * 0.8));
            console.log('🔧 Reduced pixel ratio for better performance');
        }
        
        // Disable shadows if enabled
        if (renderer.shadowMap.enabled) {
            renderer.shadowMap.enabled = false;
            console.log('🔧 Disabled shadows for better performance');
        }
    }
    
    autoOptimizeMemory() {
        // Trigger garbage collection if available
        if (window.gc) {
            window.gc();
            console.log('🗑️ Triggered garbage collection');
        }
        
        // Dispose unused resources
        this.disposeUnusedResources();
    }
    
    disposeUnusedResources() {
        if (!this.world) return;
        
        const scene = this.world.getScene();
        let disposedCount = 0;
        
        scene.traverse((object) => {
            // Dispose of geometries and materials that are no longer in use
            if (object.geometry && object.geometry.dispose) {
                // Check if geometry is used elsewhere
                const isUnique = scene.getObjectByProperty('geometry', object.geometry) === object;
                if (isUnique) {
                    object.geometry.dispose();
                    disposedCount++;
                }
            }
            
            if (object.material) {
                if (Array.isArray(object.material)) {
                    object.material.forEach(material => {
                        if (material.dispose) {
                            material.dispose();
                            disposedCount++;
                        }
                    });
                } else if (object.material.dispose) {
                    object.material.dispose();
                    disposedCount++;
                }
            }
        });
        
        if (disposedCount > 0) {
            console.log(`🗑️ Disposed ${disposedCount} unused resources`);
        }
    }
    
    logPerformanceStats() {
        const stats = this.getPerformanceStats();
        
        console.log('📊 Performance Stats:', {
            fps: Math.round(stats.fps),
            frameTime: Math.round(stats.frameTime * 100) / 100,
            memoryUsage: Math.round(stats.memory.usage * 100) / 100,
            physicsObjects: stats.physics.objectCount,
            networkPing: Math.round(stats.network.ping),
            uptime: Math.round(stats.uptime / 1000)
        });
    }
    
    // Public API methods
    getPerformanceStats() {
        return {
            fps: this.fps,
            frameTime: this.deltaTime,
            frameCount: this.frameCount,
            uptime: performance.now() - this.startTime,
            
            memory: {
                used: this.memoryInfo.used,
                total: this.memoryInfo.total,
                limit: this.memoryInfo.limit,
                usage: this.memoryInfo.used / this.memoryInfo.limit
            },
            
            physics: {
                objectCount: this.physicsPerformance.objectCount,
                stepTime: this.physicsPerformance.stepTime
            },
            
            network: {
                ping: this.networkPerformance.ping,
                packetsPerSecond: this.networkPerformance.packetsPerSecond
            },
            
            warnings: Array.from(this.warnings)
        };
    }
    
    getFPSHistory() {
        return [...this.fpsHistory];
    }
    
    getAverageFPS() {
        return this.fps;
    }
    
    getMemoryUsage() {
        return this.memoryInfo.used / this.memoryInfo.limit;
    }
    
    isPerformanceGood() {
        return this.fps >= 60 && 
               this.getMemoryUsage() < 0.8 && 
               this.networkPerformance.ping < 100;
    }
    
    // Profiling methods
    startProfile(name) {
        if (console.time) {
            console.time(name);
        }
        return performance.now();
    }
    
    endProfile(name, startTime = null) {
        if (console.timeEnd) {
            console.timeEnd(name);
        }
        
        if (startTime !== null) {
            const duration = performance.now() - startTime;
            console.log(`⏱️ ${name}: ${Math.round(duration * 100) / 100}ms`);
            return duration;
        }
    }
    
    // Benchmark method
    benchmark(name, fn, iterations = 1000) {
        const startTime = performance.now();
        
        for (let i = 0; i < iterations; i++) {
            fn();
        }
        
        const endTime = performance.now();
        const totalTime = endTime - startTime;
        const averageTime = totalTime / iterations;
        
        console.log(`🏃 Benchmark ${name}:`, {
            totalTime: Math.round(totalTime * 100) / 100 + 'ms',
            averageTime: Math.round(averageTime * 1000) / 1000 + 'ms',
            iterations,
            opsPerSecond: Math.round(1000 / averageTime)
        });
        
        return {
            totalTime,
            averageTime,
            iterations,
            opsPerSecond: 1000 / averageTime
        };
    }
    
    // Export performance data
    exportPerformanceData() {
        const data = {
            timestamp: new Date().toISOString(),
            session: {
                startTime: this.startTime,
                duration: performance.now() - this.startTime,
                frameCount: this.frameCount
            },
            performance: this.getPerformanceStats(),
            fpsHistory: this.getFPSHistory(),
            warnings: Array.from(this.warnings)
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `zerog-performance-${Date.now()}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
        
        console.log('📁 Performance data exported');
    }
    
    // Cleanup
    destroy() {
        this.stop();
        this.warnings.clear();
        this.fpsHistory = [];
        
        console.log('✅ Performance Monitor destroyed');
    }
}; 