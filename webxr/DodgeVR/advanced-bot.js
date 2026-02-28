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
    this.playerBall = null;
    this.lastThrowTime = 0;
    this.isHit = false;
    this.hitCooldown = 2000;
    this.lastHitTime = 0;
    this.playerHistory = [];
    this.maxHistoryLength = 10;
    this.currentStrategy = this.data.strategy;
    this.difficultyMultiplier = this.getDifficultyMultiplier();
    this.gameStarted = false;
    this.isMultiplayer = false;

    this._homePos = new THREE.Vector3(0, 1.6, -6);
    this._reactState = 'idle';
    this._reactStartTime = 0;
    this._reactAction = null;
    this._reactArrival = null;
    this._reactDodgeTarget = new THREE.Vector3();
    this._reactExecuteStart = 0;
    this._reactRecoverStart = 0;
    this._reactReactionDelay = 0;
    this._lastBallVelZ = 0;
    this._reactRecoverFrom = new THREE.Vector3();
    window.botReactionTarget = null;

    this._initReactionParams();
    
    if (this.data.debug) {
      this.debugSphere = document.createElement('a-sphere');
      this.debugSphere.setAttribute('radius', 0.05);
      this.debugSphere.setAttribute('color', '#ff0000');
      this.debugSphere.setAttribute('opacity', 0.5);
      this.debugSphere.setAttribute('visible', false);
      this.el.sceneEl.appendChild(this.debugSphere);
    }
    
    this.el.sceneEl.addEventListener('loaded', () => {
      this.ball = this.el.sceneEl.querySelector('[simple-grab="player: player1"]');
      this.playerBall = this.el.sceneEl.querySelector('[simple-grab="player: player2"]');
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

      if (this._reactState !== 'idle') {
        this._reactState = 'recovering';
        this._reactRecoverStart = performance.now();
        this._reactRecoverFrom = this.el.object3D.position.clone();
      }

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

  _initReactionParams: function() {
    var d = this.data.difficulty;
    if (d === 'easy') {
      this._rp = {
        reactionMin: 400, reactionMax: 600,
        predictionError: 0.4,
        wrongChoiceChance: 0.30,
        moveSpeed: 1.8,
        executeDuration: 400,
        recoverDuration: 800,
        dodgeDist: 0.45
      };
    } else if (d === 'hard') {
      this._rp = {
        reactionMin: 150, reactionMax: 250,
        predictionError: 0.05,
        wrongChoiceChance: 0.05,
        moveSpeed: 3.5,
        executeDuration: 250,
        recoverDuration: 300,
        dodgeDist: 0.55
      };
    } else {
      this._rp = {
        reactionMin: 250, reactionMax: 400,
        predictionError: 0.2,
        wrongChoiceChance: 0.15,
        moveSpeed: 2.5,
        executeDuration: 300,
        recoverDuration: 500,
        dodgeDist: 0.5
      };
    }
  },

  _predictArrival: function(ballPos, ballVel) {
    var botZ = this._homePos.z;
    if (ballVel.z >= -1) return null;
    var t = (botZ - ballPos.z) / ballVel.z;
    if (t < 0 || t > 3) return null;
    return {
      x: ballPos.x + ballVel.x * t,
      y: ballPos.y + ballVel.y * t,
      t: t
    };
  },

  _smoothstep: function(t) {
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
  },

  _updateReaction: function(time) {
    if (!this.playerBall) return;
    var grab = this.playerBall.components['simple-grab'];
    if (!grab || !grab.body) return;

    var ballPos = grab.body.position;
    var ballVel = grab.body.velocity;
    var rp = this._rp;
    var now = performance.now();

    switch (this._reactState) {

      case 'idle':
        if (grab.isGrabbed) break;
        var speed = Math.sqrt(ballVel.x * ballVel.x + ballVel.y * ballVel.y + ballVel.z * ballVel.z);
        if (ballVel.z < -2 && speed > 3 && ballPos.z > this._homePos.z + 2) {
          this._reactState = 'perceiving';
          this._reactStartTime = now;
          this._reactReactionDelay = rp.reactionMin +
            Math.random() * (rp.reactionMax - rp.reactionMin);
        }
        break;

      case 'perceiving':
        if (now - this._reactStartTime < this._reactReactionDelay) break;

        var arrival = this._predictArrival(ballPos, ballVel);
        if (!arrival) {
          this._reactState = 'idle';
          break;
        }

        var errorX = (Math.random() - 0.5) * 2 * rp.predictionError;
        var errorY = (Math.random() - 0.5) * 2 * rp.predictionError * 0.5;
        arrival.x += errorX;
        arrival.y += errorY;
        this._reactArrival = arrival;

        var offsetX = arrival.x - this._homePos.x;
        var offsetY = arrival.y - this._homePos.y;
        var dodgeX, dodgeY;

        if (Math.random() < rp.wrongChoiceChance) {
          dodgeX = offsetX > 0 ? rp.dodgeDist : -rp.dodgeDist;
        } else {
          dodgeX = offsetX > 0 ? -rp.dodgeDist : rp.dodgeDist;
        }

        dodgeY = 0;
        if (offsetY > 0.3) {
          dodgeY = -0.25;
        } else if (offsetY < -0.3) {
          dodgeY = 0.15;
        }

        this._reactDodgeTarget.set(
          this._homePos.x + dodgeX,
          this._homePos.y + dodgeY,
          this._homePos.z
        );

        var handTarget = null;
        if (Math.abs(offsetX) < 0.4 && Math.abs(offsetY) < 0.4) {
          handTarget = {
            x: arrival.x,
            y: Math.max(this._homePos.y - 0.5, arrival.y),
            z: this._homePos.z + 0.4
          };
        }
        window.botReactionTarget = { handTarget: handTarget, progress: 0 };

        this._reactState = 'executing';
        this._reactExecuteStart = now;
        this._reactAction = 'dodge';
        break;

      case 'executing':
        var execElapsed = now - this._reactExecuteStart;
        var execT = Math.min(1, execElapsed / rp.executeDuration);
        var easedT = this._smoothstep(execT);

        this.el.object3D.position.lerpVectors(
          this._homePos, this._reactDodgeTarget, easedT
        );

        if (window.botReactionTarget) {
          window.botReactionTarget.progress = easedT;
        }

        var ballPassed = ballPos.z < this._homePos.z - 1.5;
        var ballStopped = Math.sqrt(ballVel.x * ballVel.x + ballVel.y * ballVel.y + ballVel.z * ballVel.z) < 0.5;
        var ballReversed = ballVel.z > 0.5;
        var timeout = execElapsed > 2000;

        if (ballPassed || ballStopped || ballReversed || timeout) {
          this._reactState = 'recovering';
          this._reactRecoverStart = now;
          this._reactRecoverFrom = this.el.object3D.position.clone();
        }
        break;

      case 'recovering':
        var recElapsed = now - this._reactRecoverStart;
        var recT = Math.min(1, recElapsed / rp.recoverDuration);
        var easedRecT = this._smoothstep(recT);

        this.el.object3D.position.lerpVectors(
          this._reactRecoverFrom, this._homePos, easedRecT
        );

        if (window.botReactionTarget) {
          window.botReactionTarget.progress = 1 - easedRecT;
        }

        if (recT >= 1) {
          this.el.object3D.position.copy(this._homePos);
          this._reactState = 'idle';
          this._reactAction = null;
          window.botReactionTarget = null;
        }
        break;
    }
  },

  throwBall: function() {
    if (!this.ball || !this.ball.components['simple-grab']) return;
    
    var arenaTarget = window._arenaRedBotTargetOverride;
    var playerPos;

    if (arenaTarget) {
      playerPos = new THREE.Vector3(arenaTarget.x, arenaTarget.y, arenaTarget.z);
    } else {
      var player = document.querySelector('#player');
      if (!player) return;
      var camera = document.querySelector('[camera]');
      if (!camera) return;
      playerPos = new THREE.Vector3();
      camera.object3D.getWorldPosition(playerPos);
      playerPos.y += 0.5;
    }

    this.updatePlayerHistory(playerPos);
    
    const predictedPos = arenaTarget ? playerPos : (this.predictPlayerPosition() || playerPos);
    
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
    var throwAngle;
    if (arenaTarget) {
      var throwType = Math.random();
      var vx, vy, vz;
      if (throwType < 0.4) {
        vx = (Math.random() - 0.5) * 0.35;
        vy = (Math.random() - 0.5) * 0.25;
        vz = 1;
      } else if (throwType < 0.7) {
        var bounceChoice = Math.random();
        if (bounceChoice < 0.25) {
          vx = 0.6 + Math.random() * 0.3; vy = (Math.random() - 0.5) * 0.3; vz = 1;
        } else if (bounceChoice < 0.5) {
          vx = -(0.6 + Math.random() * 0.3); vy = (Math.random() - 0.5) * 0.3; vz = 1;
        } else if (bounceChoice < 0.75) {
          vx = (Math.random() - 0.5) * 0.3; vy = 0.5 + Math.random() * 0.3; vz = 1;
        } else {
          vx = (Math.random() - 0.5) * 0.3; vy = -(0.3 + Math.random() * 0.2); vz = 1;
        }
      } else {
        var curveSide = Math.random() < 0.5 ? 1 : -1;
        vx = curveSide * (0.3 + Math.random() * 0.3);
        vy = (Math.random() - 0.5) * 0.2;
        vz = 1;
      }
      var mag = Math.sqrt(vx * vx + vy * vy + vz * vz);
      throwAngle = new THREE.Vector3(vx / mag, vy / mag, vz / mag);
    } else {
      throwAngle = this.calculateThrowAngle(predictedPos);
    }
    
    // Calculate throw force based on difficulty and strategy, capped by stage
    const baseForce = this.data.minThrowForce + 
      Math.random() * (this.data.maxThrowForce - this.data.minThrowForce);
    const rawForce = baseForce * this.difficultyMultiplier;
    const maxSpd = window.getStageMaxSpeed
      ? window.getStageMaxSpeed((window.playerStages || {})['player1'] || 1)
      : rawForce;
    const throwForce = Math.min(rawForce, maxSpd);
    
    // Reset ball position
    this.ball.components['simple-grab'].resetPosition();
    this.ball.components['simple-grab']._pendingAction = 'throw';
    this.ball.components['simple-grab'].snapshotOpponentPos();
    
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

    var isPlayingClip = window.motionPlayback && window.motionPlayback.isPlaying;

    if (isPlayingClip && this._reactState !== 'idle') {
      this._reactState = 'idle';
      this.el.object3D.position.copy(this._homePos);
      window.botReactionTarget = null;
    }

    if (!isPlayingClip) {
      this._updateReaction(time);
    }

    if (window.botRecordedMode) {
      if (window.botRecordedSubMode === 'single') {
        return;
      }

      if (isPlayingClip) return;

      const grab = this.ball.components['simple-grab'];
      if (!grab || !grab.body) return;

      const distToSpawn = grab.body.position.distanceTo(grab.initialPosition);
      const ballSpeed = grab.body.velocity.length();
      const ballAtSpawn = distToSpawn < 0.5 && ballSpeed < 1;

      if (ballAtSpawn && !this.isHit) {
        if (!this._recServeReady) {
          this._recServeReady = true;
          this._recServeReadyTime = time;
        }
        if (time - this._recServeReadyTime > 1000) {
          if (window.motionPlayback && window.motionPlayback.hasClips('serve')) {
            window.motionPlayback.startClip('serve');
          } else {
            this.throwBall();
          }
          this._recServeReady = false;
          this._recBallAwayTime = 0;
        }
      } else {
        this._recServeReady = false;
        if (!this._recBallAwayTime) {
          this._recBallAwayTime = time;
        }
        if (time - this._recBallAwayTime > 15000) {
          grab.resetPosition();
          this._recBallAwayTime = 0;
        }
      }
      return;
    }

    const throwInterval = this.data.throwInterval / this.difficultyMultiplier;
    if (time - this.lastThrowTime > throwInterval && !this.isHit) {
      this.throwBall();
      this.lastThrowTime = time;
    }
  }
}); 