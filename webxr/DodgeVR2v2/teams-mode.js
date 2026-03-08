/* teams-mode.js — 2v2 Match Mode for DodgeVR
 *
 * Manages arena scaling, extra ball/bot creation, player positioning,
 * and team-mode orchestration. Works alongside the existing 1v1 systems.
 */

(function () {
  'use strict';

  // ---- Constants ----
  var ARENA_1V1 = {
    width: 4,
    halfWidth: 2,
    wallX: 2,
    backWallWidth: 4,
    playerX: 0,
    botX: 0,
    ballSpawnX: 0
  };

  var ARENA_2V2 = {
    width: 8,
    halfWidth: 4,
    wallX: 4,
    backWallWidth: 8,
    playerX1: -2,   // left-lane player
    playerX2: 2,    // right-lane player
    botX1: -2,
    botX2: 2,
    ballSpawnX1: -2,
    ballSpawnX2: 2
  };

  // ---- Utility: replace a CANNON body for a box wall ----
  // cannon.js 0.6.2 lacks Body.removeShape, so we remove the old body
  // from the world entirely and create a fresh one with the new dimensions.
  function updateBoxPhysicsBody(el, newWidth, newHeight, newDepth, newPos) {
    var physComp = el.components['static-physics'];
    if (!physComp) return;
    var oldBody = physComp.body;
    var w = window.world;
    if (!w) return;

    // Preserve material from old body (backWall vs default)
    var mat = (oldBody && oldBody.material) ? oldBody.material : null;

    // Remove old body from the physics world
    if (oldBody) {
      try { w.removeBody(oldBody); } catch (e) { /* already removed */ }
    }

    var shape = new CANNON.Box(new CANNON.Vec3(newWidth / 2, newHeight / 2, newDepth / 2));
    var px = newPos ? newPos.x : 0;
    var py = newPos ? newPos.y : 0;
    var pz = newPos ? newPos.z : 0;

    var newBody = new CANNON.Body({
      mass: 0,
      shape: shape,
      material: mat,
      type: CANNON.Body.STATIC,
      collisionFilterGroup: 1,
      collisionFilterMask: 1
    });
    newBody.position.set(px, py, pz);

    // Copy rotation from old body
    if (oldBody) {
      newBody.quaternion.copy(oldBody.quaternion);
    }

    newBody.el = el;
    newBody.isRacket = false;
    w.addBody(newBody);
    physComp.body = newBody;
  }

  // ---- Arena scaling ----
  function scaleArena(format) {
    var is2v2 = (format === '2v2');
    var w = is2v2 ? ARENA_2V2.width : ARENA_1V1.width;
    var hw = is2v2 ? ARENA_2V2.halfWidth : ARENA_1V1.halfWidth;

    // Floor — update width only (preserves other geometry props)
    var floor = document.getElementById('arena-floor');
    if (floor) {
      floor.setAttribute('geometry', 'width', w);
      updateBoxPhysicsBody(floor, w, 0.1, 16, { x: 0, y: 0, z: 0 });
    }

    // Ceiling
    var ceiling = document.getElementById('arena-ceiling');
    if (ceiling) {
      ceiling.setAttribute('geometry', 'width', w);
      updateBoxPhysicsBody(ceiling, w, 0.1, 16, { x: 0, y: 4, z: 0 });
    }

    // Left wall
    var leftWall = document.getElementById('arena-left-wall');
    if (leftWall) {
      leftWall.setAttribute('position', { x: -hw, y: 2, z: 0 });
      updateBoxPhysicsBody(leftWall, 0.1, 4, 16, { x: -hw, y: 2, z: 0 });
    }

    // Right wall
    var rightWall = document.getElementById('arena-right-wall');
    if (rightWall) {
      rightWall.setAttribute('position', { x: hw, y: 2, z: 0 });
      updateBoxPhysicsBody(rightWall, 0.1, 4, 16, { x: hw, y: 2, z: 0 });
    }

    // Back wall (z=-8) — update width only
    var backWall = document.getElementById('arena-back-wall');
    if (backWall) {
      backWall.setAttribute('geometry', 'width', w);
      updateBoxPhysicsBody(backWall, w, 4, 0.1, { x: 0, y: 2, z: -8 });
    }

    // Front wall (z=+8) — update width only
    var frontWall = document.getElementById('arena-front-wall');
    if (frontWall) {
      frontWall.setAttribute('geometry', 'width', w);
      updateBoxPhysicsBody(frontWall, w, 4, 0.1, { x: 0, y: 2, z: 8 });
    }

    // Update honeycomb shield dimensions if present
    [floor, ceiling, leftWall, rightWall, backWall, frontWall].forEach(function (el) {
      try {
        if (el && el.components['honeycomb-shield'] &&
            typeof el.components['honeycomb-shield'].updateShaderUniforms === 'function') {
          el.components['honeycomb-shield'].updateShaderUniforms();
        }
      } catch (e) { /* shield update optional */ }
    });

    // Scale boundary lines
    scaleBoundaryLines(w, hw);

    // Add/remove center lane divider for 2v2
    manageCenterDivider(is2v2);

    console.log('[TeamsMode] Arena scaled to ' + format + ' (width=' + w + 'm)');
  }

  function scaleBoundaryLines(width, halfWidth) {
    try {
      var allBoxes = document.querySelectorAll('a-box');
      allBoxes.forEach(function (box) {
        var geom = box.getAttribute('geometry');
        var pos = box.getAttribute('position');
        if (!geom || !pos) return;
        if (box.id && box.id.startsWith('arena-')) return;

        var w = geom.width, h = geom.height, d = geom.depth;

        // Horizontal floor/ceiling lines: thin h+d, wide w
        if (h <= 0.01 && d <= 0.01 && (w === 4 || w === 8)) {
          box.setAttribute('geometry', 'width', width);
        }

        // Floor/ceiling side lines running along Z: thin w+h, long d (~4)
        if (w <= 0.01 && h <= 0.01 && Math.abs(d - 4) < 0.5) {
          if (Math.abs(Math.abs(pos.x) - 2) < 0.15 || Math.abs(Math.abs(pos.x) - 4) < 0.15) {
            var sign = pos.x > 0 ? 1 : -1;
            box.setAttribute('position', { x: sign * halfWidth, y: pos.y, z: pos.z });
          }
        }

        // Wall vertical lines: thin w+d, tall h (~4), at x near ±1.95 or ±3.95
        if (w <= 0.01 && d <= 0.01 && h > 0.1) {
          if (Math.abs(Math.abs(pos.x) - 1.95) < 0.15 || Math.abs(Math.abs(pos.x) - 3.95) < 0.15) {
            var sign = pos.x > 0 ? 1 : -1;
            box.setAttribute('position', { x: sign * (halfWidth - 0.05), y: pos.y, z: pos.z });
          }
        }
      });
    } catch (e) {
      console.warn('[TeamsMode] Boundary line scaling error (non-critical):', e);
    }
  }

  var _centerDivider = null;
  function manageCenterDivider(show) {
    if (show && !_centerDivider) {
      _centerDivider = document.createElement('a-entity');
      _centerDivider.setAttribute('id', 'center-lane-divider');
      // Floor line at x=0 running from z=-8 to z=8
      var line = document.createElement('a-box');
      line.setAttribute('position', '0 0.06 0');
      line.setAttribute('width', '0.005');
      line.setAttribute('height', '0.001');
      line.setAttribute('depth', '16');
      line.setAttribute('color', '#ffffff');
      line.setAttribute('material', 'shader: standard; emissive: #ffffff; emissiveIntensity: 0; metalness: 1; roughness: 0; opacity: 0.4; transparent: true');
      _centerDivider.appendChild(line);
      document.querySelector('a-scene').appendChild(_centerDivider);
    } else if (!show && _centerDivider) {
      if (_centerDivider.parentNode) _centerDivider.parentNode.removeChild(_centerDivider);
      _centerDivider = null;
    }
  }

  // ---- Dynamic ball creation for 2v2 ----
  var _extraBalls = []; // [blue2, red2]

  function createExtraBalls() {
    if (_extraBalls.length > 0) return;
    var scene = document.querySelector('a-scene');

    // Blue2 ball (player2b) — right lane teammate
    var blue2 = createBallEntity('player2b', { x: ARENA_2V2.ballSpawnX2, y: 1, z: 5.5 }, '#0000ff', 'blue2-ball-hum');
    scene.appendChild(blue2);
    _extraBalls.push(blue2);

    // Red2 ball (player1b) — right lane opponent
    var red2 = createBallEntity('player1b', { x: ARENA_2V2.ballSpawnX2, y: 1, z: -5.5 }, '#ff0000', 'red2-ball-hum');
    scene.appendChild(red2);
    _extraBalls.push(red2);

    console.log('[TeamsMode] Created 2 extra balls for 2v2');
  }

  function removeExtraBalls() {
    _extraBalls.forEach(function (ball) {
      try {
        var grab = ball.components && ball.components['simple-grab'];
        if (grab && grab.body && window.world) {
          window.world.removeBody(grab.body);
        }
      } catch (e) { console.warn('[TeamsMode] Error removing ball body:', e); }
      if (ball.parentNode) ball.parentNode.removeChild(ball);
    });
    _extraBalls = [];
    console.log('[TeamsMode] Removed extra balls');
  }

  function createBallEntity(playerSlot, pos, color, humId) {
    var sphere = document.createElement('a-sphere');
    sphere.setAttribute('id', 'ball-' + playerSlot);
    sphere.setAttribute('position', pos.x + ' ' + pos.y + ' ' + pos.z);
    sphere.setAttribute('radius', '0.1');
    sphere.setAttribute('color', color);
    sphere.setAttribute('glow', 'color: ' + color + '; intensity: 1.5');
    sphere.setAttribute('simple-grab', 'player: ' + playerSlot);
    sphere.setAttribute('ball-trail', 'color: ' + color);
    sphere.setAttribute('debug-collider', '');
    sphere.setAttribute('obb-collider', '');

    var light = document.createElement('a-entity');
    light.setAttribute('light', 'type: point; color: ' + color + '; intensity: 1.5; distance: 5; decay: 2');
    light.setAttribute('position', '0 0 0');
    sphere.appendChild(light);

    var wireframe = document.createElement('a-sphere');
    wireframe.setAttribute('radius', '0.1');
    wireframe.setAttribute('color', color);
    wireframe.setAttribute('material', 'wireframe: true; color: ' + color + '; opacity: 0.5');
    sphere.appendChild(wireframe);

    var hum = document.createElement('a-entity');
    hum.setAttribute('id', humId);
    hum.setAttribute('sound', 'src: url(audio/electric-hum.wav); autoplay: false; loop: true; volume: 0.6; positional: true; distanceModel: inverse; refDistance: 1; maxDistance: 4; rolloffFactor: 1; poolSize: 1;');
    sphere.appendChild(hum);

    return sphere;
  }

  // ---- Second bot entity for 2v2 ----
  var _bot2Entity = null;
  var _bot2Body = null;
  var _bot2Target = null;
  var _bot2BodyCollider = null;

  function createSecondBot() {
    if (_bot2Entity) return;
    var scene = document.querySelector('a-scene');

    _bot2Entity = document.createElement('a-entity');
    _bot2Entity.setAttribute('id', 'bot2');
    _bot2Entity.setAttribute('position', ARENA_2V2.botX2 + ' 1.6 -6');
    _bot2Entity.setAttribute('advanced-bot', 'enabled: false; difficulty: medium; debug: true');

    // Opponent nickname
    var nick = document.createElement('a-text');
    nick.setAttribute('id', 'bot2-nickname');
    nick.setAttribute('value', '');
    nick.setAttribute('position', '0 0.7 0');
    nick.setAttribute('align', 'center');
    nick.setAttribute('width', '6');
    nick.setAttribute('color', '#ffcc00');
    nick.setAttribute('visible', 'false');
    _bot2Entity.appendChild(nick);

    // Target sphere
    _bot2Target = document.createElement('a-entity');
    _bot2Target.setAttribute('id', 'bot2-target');
    _bot2Target.setAttribute('position', '0 0.4 0');
    _bot2Target.setAttribute('geometry', 'primitive: sphere; radius: 0.125; segmentsWidth: 8; segmentsHeight: 6');
    _bot2Target.setAttribute('material', 'color: #ff0000; opacity: 0; transparent: true; depthWrite: false');
    _bot2Target.setAttribute('obb-collider', '');
    _bot2Target.setAttribute('impact-effect', 'color: #ff0000');

    var impactSphere = document.createElement('a-sphere');
    impactSphere.setAttribute('id', 'bot2-impact');
    impactSphere.setAttribute('radius', '0.05');
    impactSphere.setAttribute('visible', 'false');
    impactSphere.setAttribute('material', 'side: double; transparent: true; opacity: 0; color: #ff0000; emissive: #ff0000; emissiveIntensity: 1.5');
    _bot2Target.appendChild(impactSphere);
    _bot2Entity.appendChild(_bot2Target);

    // Body collider
    _bot2BodyCollider = document.createElement('a-box');
    _bot2BodyCollider.setAttribute('id', 'bot2-body-collider');
    _bot2BodyCollider.setAttribute('position', '0 -0.05 0');
    _bot2BodyCollider.setAttribute('width', '0.4');
    _bot2BodyCollider.setAttribute('height', '0.7');
    _bot2BodyCollider.setAttribute('depth', '0.25');
    _bot2BodyCollider.setAttribute('material', 'color: #ff0000; opacity: 0; transparent: true; depthWrite: false');
    _bot2BodyCollider.setAttribute('obb-collider', '');
    _bot2Entity.appendChild(_bot2BodyCollider);

    scene.appendChild(_bot2Entity);

    // Bot body (rigged mesh)
    _bot2Body = document.createElement('a-entity');
    _bot2Body.setAttribute('id', 'bot2-body');
    _bot2Body.setAttribute('mixamo-body', 'mode: bot; color: #E24A4A; botEntitySelector: #bot2');
    scene.appendChild(_bot2Body);

    console.log('[TeamsMode] Created second bot entity');
  }

  function removeSecondBot() {
    if (_bot2Entity && _bot2Entity.parentNode) _bot2Entity.parentNode.removeChild(_bot2Entity);
    if (_bot2Body && _bot2Body.parentNode) _bot2Body.parentNode.removeChild(_bot2Body);
    _bot2Entity = null;
    _bot2Body = null;
    _bot2Target = null;
    _bot2BodyCollider = null;
    console.log('[TeamsMode] Removed second bot entity');
  }

  // ---- Blue teammate bot for singleplayer 2v2 ----
  var _blueBotEntity = null;
  var _blueBotBody = null;
  var _blueBotState = null;

  function createBlueTeammateBot() {
    if (_blueBotEntity) return;
    var scene = document.querySelector('a-scene');

    _blueBotEntity = document.createElement('a-entity');
    _blueBotEntity.setAttribute('id', 'blue-teammate-bot');
    _blueBotEntity.setAttribute('position', ARENA_2V2.playerX2 + ' 0 6');

    var target = document.createElement('a-entity');
    target.setAttribute('id', 'blue2-target');
    target.setAttribute('position', '0 1.6 0');
    target.setAttribute('geometry', 'primitive: sphere; radius: 0.2; segmentsWidth: 8; segmentsHeight: 6');
    target.setAttribute('material', 'color: #0000ff; opacity: 0; transparent: true; depthWrite: false');
    target.setAttribute('obb-collider', '');
    target.setAttribute('impact-effect', 'color: #0000ff');

    var impactSphere = document.createElement('a-sphere');
    impactSphere.setAttribute('id', 'blue2-impact');
    impactSphere.setAttribute('radius', '0.05');
    impactSphere.setAttribute('visible', 'false');
    impactSphere.setAttribute('material', 'side: double; transparent: true; opacity: 0; color: #0000ff; emissive: #0000ff; emissiveIntensity: 1.5');
    target.appendChild(impactSphere);
    _blueBotEntity.appendChild(target);

    var bodyCol = document.createElement('a-box');
    bodyCol.setAttribute('id', 'blue2-body-collider');
    bodyCol.setAttribute('position', '0 1.2 0');
    bodyCol.setAttribute('width', '0.4');
    bodyCol.setAttribute('height', '0.7');
    bodyCol.setAttribute('depth', '0.25');
    bodyCol.setAttribute('material', 'color: #0000ff; opacity: 0; transparent: true; depthWrite: false');
    bodyCol.setAttribute('obb-collider', '');
    _blueBotEntity.appendChild(bodyCol);

    scene.appendChild(_blueBotEntity);

    _blueBotBody = document.createElement('a-entity');
    _blueBotBody.setAttribute('id', 'blue-teammate-body');
    _blueBotBody.setAttribute('mixamo-body', 'mode: bot; color: #4A90E2; botEntitySelector: #blue-teammate-bot');
    _blueBotBody.setAttribute('visible', 'true');
    scene.appendChild(_blueBotBody);

    // Initialize bot AI state
    _blueBotState = {
      homePos: new THREE.Vector3(ARENA_2V2.playerX2, 1.6, 6),
      currentPos: new THREE.Vector3(ARENA_2V2.playerX2, 1.6, 6),
      reactState: 'idle',
      reactStartTime: 0,
      reactReactionDelay: 0,
      reactDodgeTarget: new THREE.Vector3(),
      reactExecuteStart: 0,
      reactRecoverStart: 0,
      reactRecoverFrom: new THREE.Vector3(),
      lastThrowTime: performance.now(),
      throwInterval: 3500 + Math.random() * 2000,
      isHit: false,
      lastHitTime: 0
    };

    console.log('[TeamsMode] Created blue teammate bot');
  }

  function removeBlueTeammateBot() {
    if (_blueBotEntity && _blueBotEntity.parentNode) _blueBotEntity.parentNode.removeChild(_blueBotEntity);
    if (_blueBotBody && _blueBotBody.parentNode) _blueBotBody.parentNode.removeChild(_blueBotBody);
    _blueBotEntity = null;
    _blueBotBody = null;
    _blueBotState = null;
    console.log('[TeamsMode] Removed blue teammate bot');
  }

  // ---- Blue teammate bot AI tick ----
  function tickBlueTeammate(time) {
    if (!_blueBotState || !_blueBotEntity) return;
    var s = _blueBotState;

    // Clear hit state after 1 second
    if (s.isHit && time - s.lastHitTime > 1000) {
      s.isHit = false;
    }

    // Dodge incoming red balls
    dodgeBlueTeammate();

    // Throw blue2 ball (only during active match)
    var matchActive = typeof window.isMatchActive === 'function' ? window.isMatchActive() : false;
    if (!matchActive) {
      // Reset throw timer so bot doesn't immediately throw when match starts
      if (s.lastThrowTime < time - 2000) s.lastThrowTime = time;
    } else if (!s.isHit && time - s.lastThrowTime > s.throwInterval) {
      throwBlueTeammateBall(time);
      s.lastThrowTime = time;
      s.throwInterval = 3000 + Math.random() * 2000;
    }

    // Update entity position
    _blueBotEntity.object3D.position.set(s.currentPos.x, 0, s.currentPos.z);

    // Update body
    if (_blueBotBody && _blueBotBody.components['mixamo-body']) {
      _blueBotBody.components['mixamo-body'].remoteHandData = {
        head: { x: s.currentPos.x, y: s.currentPos.y, z: s.currentPos.z,
                qx: 0, qy: 0, qz: 0, qw: 1 },
        leftHand: { x: s.currentPos.x - 0.3, y: s.currentPos.y - 0.5, z: s.currentPos.z - 0.25,
                    qx: 0, qy: 0, qz: 0, qw: 1 },
        rightHand: { x: s.currentPos.x + 0.3, y: s.currentPos.y - 0.5, z: s.currentPos.z - 0.25,
                     qx: 0, qy: 0, qz: 0, qw: 1 }
      };
    }
  }

  function dodgeBlueTeammate() {
    if (!_blueBotState) return;
    var s = _blueBotState;

    // Check both red balls for incoming threats
    var redBalls = document.querySelectorAll('[simple-grab^="player: player1"]');
    var mostThreatening = null;
    var minArrivalTime = Infinity;

    redBalls.forEach(function (ball) {
      var grab = ball.components && ball.components['simple-grab'];
      if (!grab || !grab.body) return;
      var bp = grab.body.position;
      var bv = grab.body.velocity;
      if (bv.z <= 2) return;
      var speed = Math.sqrt(bv.x * bv.x + bv.y * bv.y + bv.z * bv.z);
      if (speed < 3) return;
      if (bp.z >= s.homePos.z - 2) return;
      var t = (s.homePos.z - bp.z) / bv.z;
      if (t > 0 && t < minArrivalTime) {
        minArrivalTime = t;
        mostThreatening = { pos: bp, vel: bv, t: t };
      }
    });

    var now = performance.now();

    switch (s.reactState) {
      case 'idle':
        if (mostThreatening && minArrivalTime < 3) {
          s.reactState = 'perceiving';
          s.reactStartTime = now;
          s.reactReactionDelay = 250 + Math.random() * 150;
        }
        break;

      case 'perceiving':
        if (now - s.reactStartTime < s.reactReactionDelay) break;
        if (!mostThreatening) { s.reactState = 'idle'; break; }
        var bp = mostThreatening.pos;
        var bv = mostThreatening.vel;
        var t = mostThreatening.t;
        var arrivalX = bp.x + bv.x * t + (Math.random() - 0.5) * 0.4;
        var arrivalY = bp.y + bv.y * t + (Math.random() - 0.5) * 0.2;
        var offsetX = arrivalX - s.homePos.x;
        var dodgeX = offsetX > 0 ? -0.5 : 0.5;
        if (Math.random() < 0.15) dodgeX = -dodgeX;
        var dodgeY = 0;
        if (arrivalY - s.homePos.y > 0.3) dodgeY = -0.25;
        else if (arrivalY - s.homePos.y < -0.3) dodgeY = 0.15;
        s.reactDodgeTarget.set(s.homePos.x + dodgeX, s.homePos.y + dodgeY, s.homePos.z);
        s.reactState = 'executing';
        s.reactExecuteStart = now;
        break;

      case 'executing':
        var execElapsed = now - s.reactExecuteStart;
        var execT = Math.min(1, execElapsed / 300);
        var easedT = execT * execT * (3 - 2 * execT);
        s.currentPos.lerpVectors(s.homePos, s.reactDodgeTarget, easedT);
        if (execElapsed > 2000 || !mostThreatening) {
          s.reactState = 'recovering';
          s.reactRecoverStart = now;
          s.reactRecoverFrom.copy(s.currentPos);
        }
        break;

      case 'recovering':
        var recElapsed = now - s.reactRecoverStart;
        var recT = Math.min(1, recElapsed / 500);
        var easedRecT = recT * recT * (3 - 2 * recT);
        s.currentPos.lerpVectors(s.reactRecoverFrom, s.homePos, easedRecT);
        if (recT >= 1) {
          s.currentPos.copy(s.homePos);
          s.reactState = 'idle';
        }
        break;
    }
  }

  function throwBlueTeammateBall(time) {
    var ball = document.getElementById('ball-player2b') ||
              document.querySelector('[simple-grab="player: player2b"]');
    if (!ball) return;
    var grab = ball.components['simple-grab'];
    if (!grab || !grab.body) return;
    if (grab.isGrabbed || grab._respawnPhase) return;

    var distToSpawn = grab.body.position.distanceTo(grab.initialPosition);
    var ballSpeed = grab.body.velocity.length();
    if (distToSpawn > 1.5 && ballSpeed > 1) return;

    grab.resetPosition();
    grab._pendingAction = 'throw';
    if (grab.snapshotOpponentPos) grab.snapshotOpponentPos();

    var force = 8 + Math.random() * 7;
    var throwType = Math.random();
    var vx, vy, vz;
    if (throwType < 0.4) {
      vx = (Math.random() - 0.5) * 0.35;
      vy = (Math.random() - 0.5) * 0.25;
      vz = -1;
    } else if (throwType < 0.7) {
      var bounceChoice = Math.random();
      if (bounceChoice < 0.25) {
        vx = 0.6 + Math.random() * 0.3; vy = (Math.random() - 0.5) * 0.3; vz = -1;
      } else if (bounceChoice < 0.5) {
        vx = -(0.6 + Math.random() * 0.3); vy = (Math.random() - 0.5) * 0.3; vz = -1;
      } else if (bounceChoice < 0.75) {
        vx = (Math.random() - 0.5) * 0.3; vy = 0.5 + Math.random() * 0.3; vz = -1;
      } else {
        vx = (Math.random() - 0.5) * 0.3; vy = -(0.3 + Math.random() * 0.2); vz = -1;
      }
    } else {
      var curveSide = Math.random() < 0.5 ? 1 : -1;
      vx = curveSide * (0.3 + Math.random() * 0.3);
      vy = (Math.random() - 0.5) * 0.2;
      vz = -1;
    }
    var mag = Math.sqrt(vx * vx + vy * vy + vz * vz);
    grab.body.velocity.set((vx / mag) * force, (vy / mag) * force, (vz / mag) * force);
  }

  // ---- Check if blue teammate was hit by red ball ----
  function checkBlueTeammateHit(time) {
    if (!_blueBotState || _blueBotState.isHit) return;
    var s = _blueBotState;

    var redBalls = document.querySelectorAll('[simple-grab^="player: player1"]');
    redBalls.forEach(function (ball) {
      if (s.isHit) return;
      var grab = ball.components && ball.components['simple-grab'];
      if (!grab || !grab.body) return;
      if (grab.isReturning || grab._respawnPhase) return;

      var bp = grab.body.position;
      var bodyY = s.currentPos.y - 0.3;
      var dx = bp.x - s.currentPos.x;
      var dy = bp.y - bodyY;
      var dz = bp.z - s.currentPos.z;
      var horizDistSq = dx * dx + dz * dz;
      var speed = grab.body.velocity.length();

      if (horizDistSq < 0.6 * 0.6 && Math.abs(dy) < 0.9 && speed > 2) {
        s.isHit = true;
        s.lastHitTime = time;
        if (typeof window.resetStage === 'function') window.resetStage('player2b');
        grab.isReturning = true;
        grab.returningStartTime = Date.now();
        grab.returningGraceUntil = Date.now() + 2000;
        grab.body.velocity.set(0, 0, 0);
        grab.body.angularVelocity.set(0, 0, 0);
        var sp = grab.initialPosition;
        var ddx = sp.x - bp.x, ddy = sp.y - bp.y, ddz = sp.z - bp.z;
        var dist = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        if (dist > 0.01) {
          grab.body.velocity.set((ddx / dist) * 10, (ddy / dist) * 10, (ddz / dist) * 10);
        } else {
          grab.resetPosition();
        }

        // Score for red team — pass blue2-target so impact shows on correct teammate
        var gm = document.querySelector('#game-manager');
        if (gm && gm.components['game-manager']) gm.components['game-manager'].onPlayerHit('blue2-target');
      }
    });
  }

  // ---- Player position management ----
  function setPlayerPosition(format) {
    var player = document.getElementById('player');
    if (!player) return;

    if (format === '2v2') {
      player.setAttribute('position', ARENA_2V2.playerX1 + ' 0 6');
    } else {
      player.setAttribute('position', '0 0 6');
    }
  }

  // ---- Move primary bot + ball spawn positions for 2v2 ----
  function adjustPrimaryEntities(format) {
    var is2v2 = (format === '2v2');

    // Move primary bot to left lane
    var botEntity = document.querySelector('[advanced-bot]');
    if (botEntity) {
      var bx = is2v2 ? ARENA_2V2.botX1 : 0;
      botEntity.object3D.position.set(bx, 1.6, -6);
      var bot = botEntity.components['advanced-bot'];
      if (bot) {
        bot._homePos.set(bx, 1.6, -6);
      }
    }

    // Move primary ball spawn positions
    var blueBall = document.querySelector('[simple-grab="player: player2"]');
    if (blueBall && blueBall.components['simple-grab']) {
      var bsx = is2v2 ? ARENA_2V2.ballSpawnX1 : 0;
      blueBall.components['simple-grab'].initialPosition.set(bsx, 1.0, 5.5);
      blueBall.components['simple-grab'].resetPosition();
    }

    var redBall = document.querySelector('[simple-grab="player: player1"]');
    if (redBall && redBall.components['simple-grab']) {
      var rsx = is2v2 ? ARENA_2V2.ballSpawnX1 : 0;
      redBall.components['simple-grab'].initialPosition.set(rsx, 1.0, -5.5);
      redBall.components['simple-grab'].resetPosition();
    }

    // Move player zones
    var zone1 = document.querySelector('[player-zone="player: player1; radius: 1"]');
    var zone2 = document.querySelector('[player-zone="player: player2; radius: 1"]');
    if (zone1) zone1.setAttribute('position', (is2v2 ? ARENA_2V2.botX1 : 0) + ' 0.05 -6');
    if (zone2) zone2.setAttribute('position', (is2v2 ? ARENA_2V2.playerX1 : 0) + ' 0.05 6');
  }

  // ---- Main 2v2 activation / deactivation ----
  function activate2v2() {
    if (window.matchFormat === '2v2') return;
    window.matchFormat = '2v2';
    console.log('[TeamsMode] Activating 2v2 mode');

    try { scaleArena('2v2'); } catch (e) { console.error('[TeamsMode] scaleArena error:', e); }
    try { setPlayerPosition('2v2'); } catch (e) { console.error('[TeamsMode] setPlayerPosition error:', e); }
    try { adjustPrimaryEntities('2v2'); } catch (e) { console.error('[TeamsMode] adjustPrimaryEntities error:', e); }
    try { createExtraBalls(); } catch (e) { console.error('[TeamsMode] createExtraBalls error:', e); }
    try { createSecondBot(); } catch (e) { console.error('[TeamsMode] createSecondBot error:', e); }
    try { createBlueTeammateBot(); } catch (e) { console.error('[TeamsMode] createBlueTeammateBot error:', e); }

    // Set ball references after entities have time to initialize
    // (enabled + gameStarted are handled by game-manager.startMatch, not here)
    setTimeout(function () {
      try {
        var bot2 = document.getElementById('bot2');
        if (bot2) {
          var botComp = bot2.components['advanced-bot'];
          if (botComp) {
            botComp._homePos.set(ARENA_2V2.botX2, 1.6, -6);
            var b1b = document.getElementById('ball-player1b') ||
                      document.querySelector('[simple-grab="player: player1b"]');
            var b2b = document.getElementById('ball-player2b') ||
                      document.querySelector('[simple-grab="player: player2b"]');
            botComp.ball = b1b;
            botComp.playerBall = b2b;
            console.log('[TeamsMode] bot2 ball refs set:', !!b1b, !!b2b);
          }
        }
      } catch (e) { console.error('[TeamsMode] bot2 setup error:', e); }
    }, 500);
  }

  function deactivate2v2() {
    if (window.matchFormat === '1v1') return;
    window.matchFormat = '1v1';
    console.log('[TeamsMode] Deactivating 2v2 mode');

    try { removeExtraBalls(); } catch (e) { console.error('[TeamsMode] removeExtraBalls error:', e); }
    try { removeSecondBot(); } catch (e) { console.error('[TeamsMode] removeSecondBot error:', e); }
    try { removeBlueTeammateBot(); } catch (e) { console.error('[TeamsMode] removeBlueTeammateBot error:', e); }
    try { scaleArena('1v1'); } catch (e) { console.error('[TeamsMode] scaleArena error:', e); }
    try { setPlayerPosition('1v1'); } catch (e) { console.error('[TeamsMode] setPlayerPosition error:', e); }
    try { adjustPrimaryEntities('1v1'); } catch (e) { console.error('[TeamsMode] adjustPrimaryEntities error:', e); }
  }

  // ---- Tick for 2v2 bots ----
  function tick2v2(time) {
    if (window.matchFormat !== '2v2') return;

    // Blue teammate bot AI
    tickBlueTeammate(time);
    checkBlueTeammateHit(time);

    // Second red bot maintenance
    var bot2 = document.getElementById('bot2');
    if (bot2 && bot2.components['advanced-bot']) {
      var bot2Comp = bot2.components['advanced-bot'];

      // Ensure ball references point to the CORRECT 2v2 balls (not primary balls).
      // The loaded event in advanced-bot.init may have set these to the primary balls.
      var correctBall = document.getElementById('ball-player1b') ||
                        document.querySelector('[simple-grab="player: player1b"]');
      var correctPlayerBall = document.getElementById('ball-player2b') ||
                              document.querySelector('[simple-grab="player: player2b"]');
      if (correctBall && bot2Comp.ball !== correctBall) {
        bot2Comp.ball = correctBall;
      }
      if (correctPlayerBall && bot2Comp.playerBall !== correctPlayerBall) {
        bot2Comp.playerBall = correctPlayerBall;
      }

      // Ensure _homePos is correct
      if (bot2Comp._homePos.x !== ARENA_2V2.botX2) {
        bot2Comp._homePos.set(ARENA_2V2.botX2, 1.6, -6);
      }

      // When idle, keep entity at _homePos so colliders are at the right height
      if (bot2Comp._reactState === 'idle') {
        bot2.object3D.position.copy(bot2Comp._homePos);
      }
    }

    // Drive bot2-body's mixamo-body via remoteHandData
    if (_bot2Body && _bot2Body.components && _bot2Body.components['mixamo-body']) {
      var bot2El = document.getElementById('bot2');
      if (bot2El) {
        var bp = bot2El.object3D.position;
        var headY = bp.y + 0.3;
        // Bot2 faces +Z (toward player), so head quat = 180° around Y
        _bot2Body.components['mixamo-body'].remoteHandData = {
          head: { x: bp.x, y: headY, z: bp.z,
                  qx: 0, qy: 1, qz: 0, qw: 0 },
          leftHand: { x: bp.x + 0.3, y: headY - 0.5, z: bp.z + 0.25,
                      qx: 0, qy: 1, qz: 0, qw: 0 },
          rightHand: { x: bp.x - 0.3, y: headY - 0.5, z: bp.z + 0.25,
                       qx: 0, qy: 1, qz: 0, qw: 0 }
        };
      }
    }
  }

  // ---- Check if a collider ID belongs to a red team target ----
  function isRedTeamTarget(colliderId) {
    return colliderId === 'bot-target' || colliderId === 'bot-body-collider' ||
           colliderId === 'bot2-target' || colliderId === 'bot2-body-collider';
  }

  function isBlueTeamTarget(colliderId) {
    return colliderId === 'player-target' || colliderId === 'player-body-collider' ||
           colliderId === 'blue2-target' || colliderId === 'blue2-body-collider';
  }

  function isRedBallPlayer(playerSlot) {
    return playerSlot === 'player1' || playerSlot === 'player1b';
  }

  function isBlueBallPlayer(playerSlot) {
    return playerSlot === 'player2' || playerSlot === 'player2b';
  }

  // ---- Expose API ----
  window.teamsMode = {
    activate2v2: activate2v2,
    deactivate2v2: deactivate2v2,
    tick2v2: tick2v2,
    isRedTeamTarget: isRedTeamTarget,
    isBlueTeamTarget: isBlueTeamTarget,
    isRedBallPlayer: isRedBallPlayer,
    isBlueBallPlayer: isBlueBallPlayer,
    scaleArena: scaleArena,
    ARENA_1V1: ARENA_1V1,
    ARENA_2V2: ARENA_2V2,
    getBlueTeammateState: function () { return _blueBotState; },
    getBot2Entity: function () { return _bot2Entity; },
    getExtraBalls: function () { return _extraBalls; }
  };

  console.log('[TeamsMode] teams-mode.js loaded');
})();
