// Game Modes Extension for WebXR Table Tennis
// Modular game mode system that extends the base game in index.html

AFRAME.registerComponent('game-modes', {
  schema: {
    mode: { type: 'string', default: 'default' }, // 'default', 'bouncing-ball'
    enabled: { type: 'boolean', default: false }
  },

  init: function() {
    if (!this.data.enabled) return;
    
    console.log('Game Modes Extension loaded:', this.data.mode);
    
    // Initialize the selected game mode
    switch(this.data.mode) {
      case 'bouncing-ball':
        this.initBouncingBallMode();
        break;
      default:
        console.log('Using default game mode from index.html');
        break;
    }
  },

  initBouncingBallMode: function() {
    console.log('Initializing Bouncing Ball game mode');
    
    // NOTE: Wall duplication and resetPosition override removed.
    // Back walls always use restitution 0 - balls must never physically bounce off them.
    // The bouncing-ball mode now only adds visual indicators.
    
    // Add visual indicators
    this.addModeIndicators();
    
    // Update mode display
    this.updateModeDisplay('bouncing-ball', true);
  },

  setOpposingWallToBounce: function() {
    setTimeout(() => {
      const scene = document.querySelector('a-scene');
      
      // Keep the original opposing wall (respawning type) and make it transparent
      this.respawningWall = document.querySelector('a-box[position="0 2 -8"]');
      if (this.respawningWall) {
        // Make the respawning wall transparent
        setTimeout(() => {
          this.respawningWall.setAttribute('material', 'opacity: 0; transparent: true; side: double');
        }, 100);
        this.respawningWall.setAttribute('visible', false);
      }
      
      // Create a bouncing wall (copy of side wall) at the same position - keep it solid
      const leftWall = document.querySelector('a-box[position="-2 2 0"]');
      if (leftWall) {
        this.bouncingWall = leftWall.cloneNode(true);
        this.bouncingWall.setAttribute('position', '0 2 -8');
        this.bouncingWall.setAttribute('width', '4');
        this.bouncingWall.setAttribute('height', '4'); 
        this.bouncingWall.setAttribute('depth', '0.1');
        this.bouncingWall.setAttribute('rotation', '0 0 0');
        this.bouncingWall.setAttribute('visible', true);
        this.bouncingWall.setAttribute('id', 'opposing-wall-bounce');
        // Keep solid for bouncing wall
        
        scene.appendChild(this.bouncingWall);
        console.log('✅ Created dedicated solid bouncing wall at opposing position');
      }
    }, 1000);
  },

  overrideCollisionDetection: function() {
    setTimeout(() => {
      const playerBall = document.querySelector('[simple-grab="player: player2"]');
      if (!playerBall) return;
      
      const grabComponent = playerBall.components['simple-grab'];
      if (!grabComponent) return;
      
      console.log('Overriding collision detection for bouncing ball mode');
      
      // Track wall replacement state
      this.opposingWallIsRespawning = false;
      
      // Override resetPosition to check ball position instead of relying on event state
      const originalResetPosition = grabComponent.resetPosition.bind(grabComponent);
      
      grabComponent.resetPosition = () => {
        const ballPos = playerBall.object3D.position;
        
        // Check if ball is near opposing wall (z = -8) in bouncing mode
        if (ballPos.z < -7 && ballPos.z > -9 && this.data.enabled && this.data.mode === 'bouncing-ball' && !this.opposingWallIsRespawning) {
          return; // Block reset at opposing wall in bouncing mode (unless we want it to respawn)
        }
        
        // Allow reset for all other positions
        originalResetPosition();
        
        // After reset, restore bouncing wall if it was temporarily changed
        if (this.opposingWallIsRespawning) {
          setTimeout(() => {
            this.restoreBouncingWall();
            this.opposingWallIsRespawning = false;
          }, 500); // Wait for ball to fully reset
        }
      };
      
      // Add collision detection for side walls, floor, ceiling
      playerBall.addEventListener('obbcollisionstarted', (evt) => {
        const collider = evt.detail.withEl;
        
        // Player2's ball hits bot's target sphere
        if (collider && collider.id === 'bot-target') {
          const bot = document.querySelector('[bot]');
          const impactEffect = bot && bot.components['impact-effect'];
          if (impactEffect) impactEffect.playEffect();
          grabComponent.resetPosition();
          return;
        }
        
        // Check if ball hits side walls, floor, or ceiling
        if (collider && collider.getAttribute && collider.getAttribute('geometry')) {
          const geom = collider.getAttribute('geometry');
          const pos = collider.getAttribute('position');
          
          if (pos && geom) {
            const isSideWall = (Math.abs(pos.x - 2) < 0.01 || Math.abs(pos.x + 2) < 0.01) && geom.width === 0.1;
            const isFloor = Math.abs(pos.y - 0) < 0.01 && geom.height === 0.1;
            const isCeiling = Math.abs(pos.y - 4) < 0.01 && geom.height === 0.1;
            
            if (isSideWall || isFloor || isCeiling) {
              console.log('Ball hit side/floor/ceiling - switching opposing wall to respawn mode');
              this.switchToRespawningWall();
              this.opposingWallIsRespawning = true;
            }
          }
        }
      });
      
    }, 1500); // Wait a bit longer to ensure everything is loaded
  },

  showSpeedBoostEffect: function() {
    const scene = document.querySelector('a-scene');
    if (!scene) return;
    
    const effect = document.createElement('a-entity');
    effect.setAttribute('geometry', 'primitive: sphere; radius: 0.5');
    effect.setAttribute('material', 'color: #00ff00; opacity: 0.5; transparent: true');
    effect.setAttribute('position', '0 2 0');
    effect.setAttribute('animation', 'property: scale; from: 0.1 0.1 0.1; to: 2 2 2; dur: 500');
    effect.setAttribute('animation__fade', 'property: material.opacity; from: 0.5; to: 0; dur: 500');
    
    scene.appendChild(effect);
    
    setTimeout(() => {
      if (effect.parentNode) {
        effect.parentNode.removeChild(effect);
      }
    }, 1000);
  },

  addModeIndicators: function() {
    const scene = document.querySelector('a-scene');
    if (!scene) return;
    
    // Create mode indicator with same style as version display
    this.modeIndicator = document.createElement('a-entity');
    this.modeIndicator.setAttribute('id', 'mode-indicator');
    this.modeIndicator.setAttribute('position', '0 3.4 0'); // Below the score display
    this.modeIndicator.setAttribute('text', 'value: BOUNCING BALL; align: center; width: 1.5; color: #ffffff');
    scene.appendChild(this.modeIndicator);
  },

  updateModeDisplay: function(mode, enabled) {
    if (!this.modeIndicator) {
      // Find existing mode indicator if we don't have reference
      this.modeIndicator = document.querySelector('#mode-indicator');
    }
    
    if (this.modeIndicator) {
      const displayText = enabled ? mode.toUpperCase().replace('-', ' ') : 'DEFAULT';
      this.modeIndicator.setAttribute('text', 'value', displayText);
    }
  },

  switchToRespawningWall: function() {
    if (this.bouncingWall) {
      this.bouncingWall.setAttribute('visible', false);
    }
    if (this.respawningWall) {
      this.respawningWall.setAttribute('visible', true);
    }
    console.log('Switched to respawning wall (visibility toggle)');
  },

  restoreBouncingWall: function() {
    if (this.respawningWall) {
      this.respawningWall.setAttribute('visible', false);
    }
    if (this.bouncingWall) {
      this.bouncingWall.setAttribute('visible', true);
    }
    console.log('Restored bouncing wall (visibility toggle)');
  },

  remove: function() {
    // Cleanup when component is removed
    if (this.speedDisplayUpdateInterval) {
      clearInterval(this.speedDisplayUpdateInterval);
    }
    
    // Remove mode indicators
    const modeIndicator = document.querySelector('#mode-indicator');
    const speedDisplay = document.querySelector('#speed-multiplier-display');
    if (modeIndicator && modeIndicator.parentNode) {
      modeIndicator.parentNode.removeChild(modeIndicator);
    }
    if (speedDisplay && speedDisplay.parentNode) {
      speedDisplay.parentNode.removeChild(speedDisplay);
    }
    
    console.log('Game Modes Extension unloaded');
  }
});

console.log('Game Modes Extension (game-modes.js) loaded successfully'); 