// Advanced Bot Logic Component
AFRAME.registerComponent('advanced-bot', {
  schema: {
    enabled: { type: 'boolean', default: false },
    difficulty: { type: 'string', default: 'medium' }, // easy, medium, hard
    predictionTime: { type: 'number', default: 0.5 }, // Time in seconds to predict player movement
    throwInterval: { type: 'number', default: 3000 }, // Base throw interval in ms
    minThrowForce: { type: 'number', default: 5 },
    maxThrowForce: { type: 'number', default: 15 },
    accuracy: { type: 'number', default: 0.8 }, // 0-1, affects aim accuracy
    reactionTime: { type: 'number', default: 0.2 }, // Time in seconds before bot reacts
    strategy: { type: 'string', default: 'balanced' }, // balanced, aggressive, defensive
    debug: { type: 'boolean', default: true } // Enable debug visualization
  },

  init: function() {
    this.ball = null;
    this.lastThrowTime = 0;
    this.isHit = false;
    this.hitCooldown = 2000;
    this.lastHitTime = 0;
    this.playerHistory = []; // Store recent player positions for prediction
    this.maxHistoryLength = 10;
    this.currentStrategy = this.data.strategy;
    this.difficultyMultiplier = this.getDifficultyMultiplier();
    this.gameStarted = false;
    this.isMultiplayer = false;
    
    // Create debug visualization
    if (this.data.debug) {
      this.debugSphere = document.createElement('a-sphere');
      this.debugSphere.setAttribute('radius', 0.05);
      this.debugSphere.setAttribute('color', '#ff0000');
      this.debugSphere.setAttribute('opacity', 0.5);
      this.debugSphere.setAttribute('visible', false);
      this.el.sceneEl.appendChild(this.debugSphere);
    }
    
    // Find the bot's ball
    this.el.sceneEl.addEventListener('loaded', () => {
      this.ball = this.el.sceneEl.querySelector('[simple-grab="player: player1"]');
    });

    // Listen for collisions
    this.el.addEventListener('obbcollisionstarted', (evt) => {
      if (!this.data.enabled || !this.gameStarted || this.isMultiplayer) return;
      this.onCollision(evt);
    });

    // Listen for game start
    this.el.sceneEl.addEventListener('gameStarted', () => {
      this.gameStarted = true;
    });

    // Listen for multiplayer state changes
    this.el.sceneEl.addEventListener('multiplayer-start', () => {
      this.isMultiplayer = true;
      // Disable bot behavior in multiplayer
      this.data.enabled = false;
    });

    this.el.sceneEl.addEventListener('multiplayer-end', () => {
      this.isMultiplayer = false;
      // Re-enable bot behavior when returning to singleplayer
      this.data.enabled = true;
    });

    // Initialize strategy weights
    this.strategyWeights = {
      balanced: { direct: 0.4, bounce: 0.4, curve: 0.2 },
      aggressive: { direct: 0.6, bounce: 0.3, curve: 0.1 },
      defensive: { direct: 0.2, bounce: 0.5, curve: 0.3 }
    };
  },

  getDifficultyMultiplier: function() {
    switch(this.data.difficulty) {
      case 'easy': return 0.7;
      case 'medium': return 1.0;
      case 'hard': return 1.3;
      default: return 1.0;
    }
  },

  onCollision: function(evt) {
    const now = Date.now();
    if (now - this.lastHitTime < this.hitCooldown) return;
    
    const collider = evt.detail.withEl;
    
    if (collider && collider.getAttribute('simple-grab') && 
        collider.getAttribute('simple-grab').player === 'player2') {
      // Check grace period - ball returning from back wall shouldn't score
      const grab = collider.components?.['simple-grab'];
      if (grab) {
        if (grab.isGrabbed) return;
        // Detect ball that is behind the bot (past them, near back wall)
        if (!grab.isReturning && grab.body && grab.body.position.z < -6.5) {
          grab.isReturning = true;
          grab.returningGraceUntil = Date.now() + 2000;
          return;
        }
        if (grab.isReturning && Date.now() < grab.returningGraceUntil) return;
      }

      this.isHit = true;
      this.lastHitTime = now;
      
      // Visual feedback
      const botSphere = this.el.querySelector('a-sphere');
      if (botSphere) {
        botSphere.setAttribute('color', '#ff0000');
        setTimeout(() => {
          botSphere.setAttribute('color', '#ff0000');
          this.isHit = false;
        }, 1000);
      }
      
      // Play impact effect
      const impactEffect = this.el.components['impact-effect'];
      if (impactEffect) {
        impactEffect.playEffect();
      }
      
      // Update score
      const gameManager = this.el.sceneEl.querySelector('#game-manager');
      if (gameManager && gameManager.components['game-manager']) {
        gameManager.components['game-manager'].onBotHit();
      }

      // Adjust strategy based on hit
      this.adjustStrategy();
    }
  },

  adjustStrategy: function() {
    // Randomly adjust strategy weights based on performance
    const currentWeights = this.strategyWeights[this.currentStrategy];
    const adjustment = (Math.random() - 0.5) * 0.1;
    
    // Adjust weights while keeping sum = 1
    const newWeights = {
      direct: Math.max(0.1, Math.min(0.7, currentWeights.direct + adjustment)),
      bounce: Math.max(0.1, Math.min(0.7, currentWeights.bounce - adjustment/2)),
      curve: Math.max(0.1, Math.min(0.7, currentWeights.curve - adjustment/2))
    };
    
    // Normalize weights
    const sum = newWeights.direct + newWeights.bounce + newWeights.curve;
    this.strategyWeights[this.currentStrategy] = {
      direct: newWeights.direct / sum,
      bounce: newWeights.bounce / sum,
      curve: newWeights.curve / sum
    };
  },

  updatePlayerHistory: function(playerPos) {
    this.playerHistory.push({
      position: playerPos.clone(),
      timestamp: Date.now()
    });
    
    // Keep only recent history
    while (this.playerHistory.length > this.maxHistoryLength) {
      this.playerHistory.shift();
    }
  },

  predictPlayerPosition: function() {
    if (this.playerHistory.length < 2) return null;
    
    const recent = this.playerHistory.slice(-2);
    const velocity = new THREE.Vector3()
      .subVectors(recent[1].position, recent[0].position)
      .divideScalar((recent[1].timestamp - recent[0].timestamp) / 1000);
    
    const predictionTime = this.data.predictionTime * this.difficultyMultiplier;
    const predictedPos = recent[1].position.clone().add(
      velocity.multiplyScalar(predictionTime)
    );
    
    // Add some randomness based on accuracy
    const accuracy = this.data.accuracy * this.difficultyMultiplier;
    const randomOffset = new THREE.Vector3(
      (Math.random() - 0.5) * (1 - accuracy) * 2,
      (Math.random() - 0.5) * (1 - accuracy) * 2,
      (Math.random() - 0.5) * (1 - accuracy) * 2
    );
    
    return predictedPos.add(randomOffset);
  },

  calculateThrowAngle: function(targetPos) {
    const botPos = new THREE.Vector3();
    this.el.object3D.getWorldPosition(botPos);
    
    // Get current strategy weights
    const weights = this.strategyWeights[this.currentStrategy];
    
    // Randomly choose throw type based on weights
    const rand = Math.random();
    let throwType;
    if (rand < weights.direct) {
      throwType = 'direct';
    } else if (rand < weights.direct + weights.bounce) {
      throwType = 'bounce';
    } else {
      throwType = 'curve';
    }
    
    switch(throwType) {
      case 'direct':
        return this.calculateDirectThrow(botPos, targetPos);
      case 'bounce':
        return this.calculateBounceThrow(botPos, targetPos);
      case 'curve':
        return this.calculateCurveThrow(botPos, targetPos);
      default:
        return this.calculateDirectThrow(botPos, targetPos);
    }
  },

  calculateDirectThrow: function(botPos, targetPos) {
    return new THREE.Vector3()
      .subVectors(targetPos, botPos)
      .normalize();
  },

  calculateBounceThrow: function(botPos, targetPos) {
    const bounceTypes = [
      { axis: 'x', value: 2 },    // Right wall
      { axis: 'x', value: -2 },   // Left wall
      { axis: 'y', value: 4 },    // Ceiling
      { axis: 'y', value: 0 },    // Floor
      { axis: 'z', value: 8 },    // Front wall
      { axis: 'z', value: -8 }    // Back wall
    ];
    
    // Choose bounce point based on current position and target
    const bounce = bounceTypes[Math.floor(Math.random() * bounceTypes.length)];
    const bouncePoint = new THREE.Vector3();
    bouncePoint[bounce.axis] = bounce.value;
    
    // Calculate vectors for bounce
    const toBounce = new THREE.Vector3()
      .subVectors(bouncePoint, botPos)
      .normalize();
    
    const fromBounce = new THREE.Vector3()
      .subVectors(targetPos, bouncePoint)
      .normalize();
    
    return new THREE.Vector3()
      .addVectors(toBounce, fromBounce)
      .normalize();
  },

  calculateCurveThrow: function(botPos, targetPos) {
    const directVector = new THREE.Vector3()
      .subVectors(targetPos, botPos)
      .normalize();
    
    // Add a curved trajectory
    const curveAmount = 0.3 * this.difficultyMultiplier;
    const perpendicular = new THREE.Vector3(
      -directVector.z,
      0,
      directVector.x
    ).normalize();
    
    return new THREE.Vector3()
      .addVectors(
        directVector,
        perpendicular.multiplyScalar(curveAmount)
      )
      .normalize();
  },

  throwBall: function() {
    if (!this.ball || !this.ball.components['simple-grab']) return;
    
    // Get player position and predict future position
    const player = document.querySelector('#player');
    if (!player) return;
    
    // Get the camera position (head height)
    const camera = document.querySelector('[camera]');
    if (!camera) return;
    
    const playerPos = new THREE.Vector3();
    camera.object3D.getWorldPosition(playerPos);
    
    // Add height offset (50cm higher)
    playerPos.y += 0.5;
    
    this.updatePlayerHistory(playerPos);
    
    const predictedPos = this.predictPlayerPosition() || playerPos;
    
    // Update debug visualization
    if (this.data.debug && this.debugSphere) {
      this.debugSphere.object3D.position.copy(predictedPos);
      this.debugSphere.setAttribute('visible', true);
      // Hide after 1 second
      setTimeout(() => {
        this.debugSphere.setAttribute('visible', false);
      }, 1000);
    }
    
    // Calculate throw angle
    const throwAngle = this.calculateThrowAngle(predictedPos);
    
    // Calculate throw force based on difficulty and strategy
    const baseForce = this.data.minThrowForce + 
      Math.random() * (this.data.maxThrowForce - this.data.minThrowForce);
    const throwForce = baseForce * this.difficultyMultiplier;
    
    // Reset ball position
    this.ball.components['simple-grab'].resetPosition();
    
    // Apply velocity
    const ballBody = this.ball.components['simple-grab'].body;
    if (ballBody) {
      ballBody.velocity.set(
        throwAngle.x * throwForce,
        throwAngle.y * throwForce,
        throwAngle.z * throwForce
      );
    }
  },

  tick: function(time) {
    if (!this.ball || !this.data.enabled || !this.gameStarted || this.isMultiplayer) return;
    if (window.botMirrorMode) return;

    // Check if it's time to throw
    const throwInterval = this.data.throwInterval / this.difficultyMultiplier;
    if (time - this.lastThrowTime > throwInterval && !this.isHit) {
      this.throwBall();
      this.lastThrowTime = time;
    }
  }
}); 