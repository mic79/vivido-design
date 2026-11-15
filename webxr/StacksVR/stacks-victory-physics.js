// stacks-victory-physics.js — end-of-match block debris via box3d.js (Quest + PCVR)
// Caps body count by randomly culling stacks first, then enables dynamics.
// Kinematics MUST use b3Body_SetTargetTransform (not SetTransform) so hands/floors
// push blocks instead of tunneling through them.
(function (global) {
  'use strict';

  var BOX3D_CDN = 'https://cdn.jsdelivr.net/npm/box3d.js@0.0.2/dist/box3d.inline.mjs';
  var MAX_BLOCKS_PER_CUP = 36;
  var HAND_RADIUS = 0.11;
  var SCOOP_REACH = 0.22;
  var SCOOP_MAX = 4;
  var FLING_SCALE = 1.35;

  var _b3 = null;
  var _b3Loading = null;
  var _active = false;
  var _world = null;
  var _game = null;
  var _blocks = []; // { body, mesh }
  var _kinematics = []; // { body, el?, cup?, kind, target }
  var _cupFloors = []; // { body, cup, hx, hy, hz }
  var _group = null;
  var _tmpQ = null;
  var _tmpP = null;
  var _tmpQ2 = null;
  var _tmpEuler = null;
  var _lastStep = 0;
  var _scoop = { leftHand: [], rightHand: [] };
  var _handGrip = { leftHand: false, rightHand: false };
  var _handPrev = {};
  var _boundHands = false;

  function ensureThreeHelpers() {
    if (!_tmpQ && global.THREE) {
      _tmpQ = new THREE.Quaternion();
      _tmpQ2 = new THREE.Quaternion();
      _tmpP = new THREE.Vector3();
      _tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    }
  }

  function loadBox3D() {
    if (_b3) return Promise.resolve(_b3);
    if (_b3Loading) return _b3Loading;
    _b3Loading = import(BOX3D_CDN)
      .then(function (mod) {
        var factory = mod && (mod.default || mod.Box3D || mod);
        return typeof factory === 'function' ? factory() : factory;
      })
      .then(function (b3) {
        _b3 = b3;
        _b3Loading = null;
        return b3;
      })
      .catch(function (err) {
        _b3Loading = null;
        console.warn('[StacksVictoryPhysics] box3d load failed', err);
        throw err;
      });
    return _b3Loading;
  }

  function shapeDef(b3, opts) {
    opts = opts || {};
    var sd = b3.b3DefaultShapeDef();
    sd.friction = opts.friction != null ? opts.friction : 0.55;
    sd.restitution = opts.restitution != null ? opts.restitution : 0.18;
    if (opts.density != null) sd.density = opts.density;
    return sd;
  }

  function identityRot() {
    return { v: { x: 0, y: 0, z: 0 }, s: 1 };
  }

  function quatToB3(q) {
    return { v: { x: q.x, y: q.y, z: q.z }, s: q.w };
  }

  function posRot(x, y, z, q) {
    return {
      position: { x: x, y: y, z: z },
      rotation: q ? quatToB3(q) : identityRot()
    };
  }

  /** Drive kinematic so dynamics get proper contact impulse (box3d API). */
  function setKinematicTarget(b3, body, x, y, z, q, dt) {
    if (!body || !b3) return;
    var target = posRot(x, y, z, q);
    var step = Math.max(0.001, Math.min(0.05, dt || 1 / 60));
    if (typeof b3.b3Body_SetTargetTransform === 'function') {
      try {
        b3.b3Body_SetTargetTransform(body, target, step, true);
        return;
      } catch (e1) {
        try {
          b3.b3Body_SetTargetTransform(body, target.position, target.rotation, step, true);
          return;
        } catch (e2) { /* fall through */ }
      }
    }
    // Fallback: transform + explicit velocity from previous (worse tunneling)
    var prev = b3.b3Body_GetPosition(body);
    b3.b3Body_SetTransform(body, target.position, target.rotation);
    if (b3.b3Body_SetLinearVelocity && prev) {
      b3.b3Body_SetLinearVelocity(body, {
        x: (x - prev.x) / step,
        y: (y - prev.y) / step,
        z: (z - prev.z) / step
      });
    }
  }

  function cullCup(cup, maxKeep) {
    if (!cup || !cup.removeCellAt) return 0;
    var cells = [];
    for (var y = 0; y < cup.height; y++) {
      for (var z = 0; z < cup.depth; z++) {
        for (var x = 0; x < cup.width; x++) {
          if (cup.grid[y][z][x] && cup.grid[y][z][x].mesh) {
            cells.push({ x: x, y: y, z: z });
          }
        }
      }
    }
    if (cells.length <= maxKeep) return cells.length;
    cells.sort(function (a, b) {
      return (b.y + Math.random() * 0.35) - (a.y + Math.random() * 0.35);
    });
    var removeN = cells.length - maxKeep;
    for (var i = 0; i < removeN; i++) {
      cup.removeCellAt(cells[i].x, cells[i].y, cells[i].z, false);
    }
    return cup.countBlocks ? cup.countBlocks() : maxKeep;
  }

  function collectCupBlocks(cup) {
    var out = [];
    if (!cup) return out;
    for (var y = 0; y < cup.height; y++) {
      for (var z = 0; z < cup.depth; z++) {
        for (var x = 0; x < cup.width; x++) {
          var cell = cup.grid[y][z][x];
          if (cell && cell.mesh) out.push({ cup: cup, x: x, y: y, z: z, cell: cell });
        }
      }
    }
    return out;
  }

  function addStaticBox(b3, world, x, y, z, hx, hy, hz, opts) {
    var def = b3.b3DefaultBodyDef();
    def.position = { x: x, y: y, z: z };
    def.rotation = identityRot();
    var body = b3.b3CreateBody(world, def);
    b3.b3CreateBoxShape(body, shapeDef(b3, opts || { friction: 0.85, restitution: 0.05 }), hx, hy, hz);
    return body;
  }

  function addKinematicBox(b3, world, x, y, z, hx, hy, hz, q, opts) {
    var def = b3.b3DefaultBodyDef();
    def.type = b3.b3BodyType.b3_kinematicBody;
    def.position = { x: x, y: y, z: z };
    def.rotation = q ? quatToB3(q) : identityRot();
    var body = b3.b3CreateBody(world, def);
    b3.b3CreateBoxShape(body, shapeDef(b3, opts || {
      friction: 0.95,
      restitution: 0.05
    }), hx, hy, hz);
    return body;
  }

  function addDynamicBox(b3, world, mesh, half) {
    ensureThreeHelpers();
    mesh.updateWorldMatrix(true, false);
    mesh.getWorldPosition(_tmpP);
    mesh.getWorldQuaternion(_tmpQ);
    var def = b3.b3DefaultBodyDef();
    def.type = b3.b3BodyType.b3_dynamicBody;
    def.position = { x: _tmpP.x, y: _tmpP.y, z: _tmpP.z };
    def.rotation = quatToB3(_tmpQ);
    // Light blocks scoop/fling better
    if (def.linearDamping != null) def.linearDamping = 0.15;
    if (def.angularDamping != null) def.angularDamping = 0.2;
    var body = b3.b3CreateBody(world, def);
    b3.b3CreateBoxShape(body, shapeDef(b3, {
      friction: 0.85,
      restitution: 0.12,
      density: 0.55
    }), half, half, half);
    if (b3.b3Body_EnableHitEvents) {
      try { /* optional */ } catch (e) { /* ignore */ }
    }
    if (b3.b3Body_SetAwake) b3.b3Body_SetAwake(body, true);
    return body;
  }

  function cupFloorPose(cup) {
    ensureThreeHelpers();
    var w = cup.width * cup.cellSize;
    var d = cup.depth * cup.cellSize;
    var hy = 0.035;
    // Floor plane at local y=0 of cup root, oriented with playfield yaw
    var local = new THREE.Vector3(w * 0.5, -hy, d * 0.5);
    cup.root.updateWorldMatrix(true, false);
    local.applyMatrix4(cup.root.matrixWorld);
    cup.root.getWorldQuaternion(_tmpQ);
    return {
      x: local.x,
      y: local.y,
      z: local.z,
      q: _tmpQ.clone(),
      hx: w * 0.5 + 0.04,
      hy: hy,
      hz: d * 0.5 + 0.04
    };
  }

  function syncMeshFromBody(b3, entry) {
    if (!entry.body || !entry.mesh || entry.held) return;
    var p = b3.b3Body_GetPosition(entry.body);
    var r = b3.b3Body_GetRotation(entry.body);
    entry.mesh.position.set(p.x, p.y, p.z);
    if (r && r.v) entry.mesh.quaternion.set(r.v.x, r.v.y, r.v.z, r.s);
  }

  function findBlockNear(handPos, ignoreSet) {
    var best = null;
    var bestD = SCOOP_REACH;
    for (var i = 0; i < _blocks.length; i++) {
      var b = _blocks[i];
      if (!b.body || !b.mesh || b.held) continue;
      if (ignoreSet && ignoreSet[i]) continue;
      var p = _b3.b3Body_GetPosition(b.body);
      var dx = p.x - handPos.x;
      var dy = p.y - handPos.y;
      var dz = p.z - handPos.z;
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < bestD) {
        bestD = d;
        best = { entry: b, index: i, d: d };
      }
    }
    return best;
  }

  function beginScoop(handId) {
    _handGrip[handId] = true;
    if (!_active || !_b3) return;
    var hand = document.getElementById(handId);
    if (!hand || !hand.object3D) return;
    ensureThreeHelpers();
    hand.object3D.updateWorldMatrix(true, false);
    hand.object3D.getWorldPosition(_tmpP);
    var handPos = { x: _tmpP.x, y: _tmpP.y, z: _tmpP.z };
    var grabbed = [];
    var used = {};
    for (var n = 0; n < SCOOP_MAX; n++) {
      var hit = findBlockNear(handPos, used);
      if (!hit) break;
      used[hit.index] = true;
      hit.entry.held = handId;
      // Soft kinematic follow — disable gravity influence by zeroing velocity
      if (_b3.b3Body_SetLinearVelocity) {
        _b3.b3Body_SetLinearVelocity(hit.entry.body, { x: 0, y: 0, z: 0 });
      }
      if (_b3.b3Body_SetAngularVelocity) {
        _b3.b3Body_SetAngularVelocity(hit.entry.body, { x: 0, y: 0, z: 0 });
      }
      grabbed.push({
        entry: hit.entry,
        // offset in hand space at grab time
        ox: hit.entry.mesh.position.x - handPos.x,
        oy: hit.entry.mesh.position.y - handPos.y,
        oz: hit.entry.mesh.position.z - handPos.z
      });
    }
    _scoop[handId] = grabbed;
  }

  function endScoop(handId) {
    _handGrip[handId] = false;
    var list = _scoop[handId] || [];
    _scoop[handId] = [];
    if (!_active || !_b3 || !list.length) return;
    var hand = document.getElementById(handId);
    var vx = 0, vy = 0, vz = 0;
    var prev = _handPrev[handId];
    if (hand && hand.object3D) {
      ensureThreeHelpers();
      hand.object3D.updateWorldMatrix(true, false);
      hand.object3D.getWorldPosition(_tmpP);
      if (prev && prev.t) {
        var dt = Math.max(0.008, (performance.now() - prev.t) / 1000);
        vx = (_tmpP.x - prev.x) / dt;
        vy = (_tmpP.y - prev.y) / dt;
        vz = (_tmpP.z - prev.z) / dt;
      }
    }
    var speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    // Cap fling so Quest doesn't explode
    var maxSp = 8;
    if (speed > maxSp) {
      var s = maxSp / speed;
      vx *= s; vy *= s; vz *= s;
    }
    vx *= FLING_SCALE; vy *= FLING_SCALE; vz *= FLING_SCALE;
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      g.entry.held = null;
      if (_b3.b3Body_SetLinearVelocity) {
        _b3.b3Body_SetLinearVelocity(g.entry.body, { x: vx, y: vy, z: vz });
      }
      if (_b3.b3Body_SetAwake) _b3.b3Body_SetAwake(g.entry.body, true);
      // Small spin for flair
      if (_b3.b3Body_SetAngularVelocity) {
        _b3.b3Body_SetAngularVelocity(g.entry.body, {
          x: (Math.random() - 0.5) * 6,
          y: (Math.random() - 0.5) * 6,
          z: (Math.random() - 0.5) * 6
        });
      }
    }
  }

  function tickScoopFollow(dt) {
    if (!_b3) return;
    ensureThreeHelpers();
    var step = Math.max(0.001, dt || 1 / 60);
    ['leftHand', 'rightHand'].forEach(function (handId) {
      var list = _scoop[handId];
      if (!list || !list.length) return;
      var hand = document.getElementById(handId);
      if (!hand || !hand.object3D) return;
      hand.object3D.updateWorldMatrix(true, false);
      hand.object3D.getWorldPosition(_tmpP);
      hand.object3D.getWorldQuaternion(_tmpQ);
      var prev = _handPrev[handId];
      var hvx = 0, hvy = 0, hvz = 0;
      if (prev && prev.t) {
        var hdt = Math.max(0.008, (performance.now() - prev.t) / 1000);
        hvx = (_tmpP.x - prev.x) / hdt;
        hvy = (_tmpP.y - prev.y) / hdt;
        hvz = (_tmpP.z - prev.z) / hdt;
      }
      for (var i = 0; i < list.length; i++) {
        var g = list[i];
        var tx = _tmpP.x + g.ox;
        var ty = _tmpP.y + g.oy;
        var tz = _tmpP.z + g.oz;
        // Held debris stay dynamic but are hard-driven to the hand each frame
        _b3.b3Body_SetTransform(g.entry.body, { x: tx, y: ty, z: tz }, quatToB3(_tmpQ));
        if (_b3.b3Body_SetLinearVelocity) {
          _b3.b3Body_SetLinearVelocity(g.entry.body, { x: hvx, y: hvy, z: hvz });
        }
        if (_b3.b3Body_SetAngularVelocity) {
          _b3.b3Body_SetAngularVelocity(g.entry.body, { x: 0, y: 0, z: 0 });
        }
        if (_b3.b3Body_SetAwake) _b3.b3Body_SetAwake(g.entry.body, true);
        g.entry.mesh.position.set(tx, ty, tz);
        g.entry.mesh.quaternion.copy(_tmpQ);
      }
    });
  }

  /** True if this hand could scoop a nearby debris block. */
  function canScoopNear(handEl) {
    if (!_active || !_b3 || !handEl || !handEl.object3D) return false;
    ensureThreeHelpers();
    handEl.object3D.updateWorldMatrix(true, false);
    handEl.object3D.getWorldPosition(_tmpP);
    return !!findBlockNear({ x: _tmpP.x, y: _tmpP.y, z: _tmpP.z }, null);
  }

  function bindHandScoop() {
    if (_boundHands) return;
    _boundHands = true;
    ['leftHand', 'rightHand'].forEach(function (id) {
      var hand = document.getElementById(id);
      if (!hand) return;
      hand.addEventListener('gripdown', function () {
        if (_active) beginScoop(id);
      });
      hand.addEventListener('gripup', function () {
        if (_active || (_scoop[id] && _scoop[id].length)) endScoop(id);
      });
      hand.addEventListener('triggerdown', function () {
        // Trigger also scoops during victory (easier than grip-only)
        if (_active) beginScoop(id);
      });
      hand.addEventListener('triggerup', function () {
        if (_active || (_scoop[id] && _scoop[id].length)) endScoop(id);
      });
    });
  }

  function destroyWorld() {
    endScoop('leftHand');
    endScoop('rightHand');
    if (_b3 && _world && typeof _b3.b3DestroyWorld === 'function') {
      try { _b3.b3DestroyWorld(_world); } catch (e) { /* ignore */ }
    }
    _world = null;
    _blocks = [];
    _kinematics = [];
    _cupFloors = [];
    _scoop = { leftHand: [], rightHand: [] };
  }

  function clearVisuals() {
    if (_group) {
      for (var i = _group.children.length - 1; i >= 0; i--) {
        var m = _group.children[i];
        _group.remove(m);
        if (m.geometry && m.geometry.dispose) m.geometry.dispose();
        if (m.material) {
          if (Array.isArray(m.material)) {
            for (var j = 0; j < m.material.length; j++) {
              if (m.material[j] && m.material[j].dispose) m.material[j].dispose();
            }
          } else if (m.material.dispose) m.material.dispose();
        }
      }
      if (_group.parent) _group.parent.remove(_group);
      _group = null;
    }
  }

  var Api = {
    active: function () { return _active; },

    /** Used by stacks-game grip to prefer scoop over cup-turn during victory. */
    canScoopNear: function (handEl) {
      return canScoopNear(handEl);
    },

    beginScoopForHand: function (handId) {
      beginScoop(handId);
    },

    endScoopForHand: function (handId) {
      endScoop(handId);
    },

    preload: function () {
      return loadBox3D().catch(function () { /* ignore */ });
    },

    start: function (game) {
      if (!game || !game.cups) return Promise.resolve(false);
      if (_active) Api.stop();
      _game = game;

      var blue = game.cups.blue;
      var red = game.cups.red;
      var beforeB = blue && blue.countBlocks ? blue.countBlocks() : 0;
      var beforeR = red && red.countBlocks ? red.countBlocks() : 0;
      if (beforeB + beforeR === 0) return Promise.resolve(false);

      cullCup(blue, MAX_BLOCKS_PER_CUP);
      cullCup(red, MAX_BLOCKS_PER_CUP);

      return loadBox3D().then(function (b3) {
        ensureThreeHelpers();
        bindHandScoop();
        var worldDef = b3.b3DefaultWorldDef();
        worldDef.gravity = { x: 0, y: -9.8, z: 0 };
        _world = b3.b3CreateWorld(worldDef);

        // Arena floor (static)
        addStaticBox(b3, _world, 0, -0.05, 0, 8, 0.05, 8, { friction: 0.9, restitution: 0.05 });

        // Playfield floors — kinematic, track raise/yaw so blocks react
        [blue, red].forEach(function (cup) {
          if (!cup) return;
          var fp = cupFloorPose(cup);
          var body = addKinematicBox(b3, _world, fp.x, fp.y, fp.z, fp.hx, fp.hy, fp.hz, fp.q, {
            friction: 1.05,
            restitution: 0.02
          });
          _cupFloors.push({ body: body, cup: cup, hx: fp.hx, hy: fp.hy, hz: fp.hz });
        });

        _group = new THREE.Group();
        _group.name = 'stacks-victory-phys';
        var sceneObj = (game.el && game.el.sceneEl && game.el.sceneEl.object3D) ||
          (document.querySelector('a-scene') && document.querySelector('a-scene').object3D);
        if (sceneObj) sceneObj.add(_group);
        else if (game._sceneRoot) game._sceneRoot.add(_group);

        var half = (blue && blue.cellSize ? blue.cellSize : 0.12) * 0.46;
        var kept = collectCupBlocks(blue).concat(collectCupBlocks(red));
        for (var i = 0; i < kept.length; i++) {
          var item = kept[i];
          var mesh = item.cell.mesh;
          if (!mesh) continue;
          mesh.updateWorldMatrix(true, false);
          mesh.getWorldPosition(_tmpP);
          mesh.getWorldQuaternion(_tmpQ);
          var wx = _tmpP.x, wy = _tmpP.y, wz = _tmpP.z;
          var wq = { x: _tmpQ.x, y: _tmpQ.y, z: _tmpQ.z, w: _tmpQ.w };
          item.cup.removeCellAt(item.x, item.y, item.z, true);
          _group.add(mesh);
          mesh.position.set(wx, wy, wz);
          mesh.quaternion.set(wq.x, wq.y, wq.z, wq.w);
          mesh.scale.set(1, 1, 1);
          var body = addDynamicBox(b3, _world, mesh, half);
          _blocks.push({ body: body, mesh: mesh, held: null });
        }

        // Body / avatar capsules (thicker for contact)
        var kinEls = [
          { id: 'player', kind: 'player' },
          { id: 'player-body', kind: 'avatar' },
          { id: 'bot-body', kind: 'avatar' },
          { id: 'spec-blue-body', kind: 'avatar' }
        ];
        for (var k = 0; k < kinEls.length; k++) {
          var el = document.getElementById(kinEls[k].id);
          if (!el || !el.object3D) continue;
          el.object3D.updateWorldMatrix(true, false);
          el.object3D.getWorldPosition(_tmpP);
          var kDef = b3.b3DefaultBodyDef();
          kDef.type = b3.b3BodyType.b3_kinematicBody;
          kDef.position = { x: _tmpP.x, y: Math.max(0.95, _tmpP.y), z: _tmpP.z };
          kDef.rotation = identityRot();
          var kBody = b3.b3CreateBody(_world, kDef);
          b3.b3CreateCapsuleShape(kBody, shapeDef(b3, { friction: 0.55, restitution: 0.05 }), {
            center1: { x: 0, y: -0.65, z: 0 },
            center2: { x: 0, y: 0.55, z: 0 },
            radius: 0.28
          });
          _kinematics.push({ body: kBody, el: el, kind: kinEls[k].kind });
        }

        // Hands — large palm spheres so scooping contacts work
        ['leftHand', 'rightHand'].forEach(function (hid) {
          var hand = document.getElementById(hid);
          if (!hand || !hand.object3D) return;
          hand.object3D.updateWorldMatrix(true, false);
          hand.object3D.getWorldPosition(_tmpP);
          var hDef = b3.b3DefaultBodyDef();
          hDef.type = b3.b3BodyType.b3_kinematicBody;
          hDef.position = { x: _tmpP.x, y: _tmpP.y, z: _tmpP.z };
          hDef.rotation = identityRot();
          var hBody = b3.b3CreateBody(_world, hDef);
          b3.b3CreateSphereShape(hBody, shapeDef(b3, { friction: 1.2, restitution: 0.05 }), {
            center: { x: 0, y: 0, z: 0 },
            radius: HAND_RADIUS
          });
          _kinematics.push({ body: hBody, el: hand, kind: 'hand', handId: hid });
          _handPrev[hid] = { x: _tmpP.x, y: _tmpP.y, z: _tmpP.z, t: performance.now() };
        });

        _active = true;
        _lastStep = performance.now();
        console.log('[StacksVictoryPhysics] started', _blocks.length, 'blocks',
          '(culled from', beforeB + beforeR + ')');
        return true;
      }).catch(function (err) {
        console.warn('[StacksVictoryPhysics] start failed', err);
        Api.stop();
        return false;
      });
    },

    tick: function () {
      if (!_active || !_b3 || !_world) return;
      var now = performance.now();
      var dt = Math.min(0.033, Math.max(0.001, (now - _lastStep) / 1000));
      _lastStep = now;
      ensureThreeHelpers();

      // Cup floors follow raise / rotate (kinematic → blocks react)
      for (var c = 0; c < _cupFloors.length; c++) {
        var cf = _cupFloors[c];
        if (!cf.cup || !cf.body) continue;
        var fp = cupFloorPose(cf.cup);
        setKinematicTarget(_b3, cf.body, fp.x, fp.y, fp.z, fp.q, dt);
      }

      // Hands + bodies via SetTargetTransform
      for (var i = 0; i < _kinematics.length; i++) {
        var k = _kinematics[i];
        if (!k.body || !k.el || !k.el.object3D) continue;
        k.el.object3D.updateWorldMatrix(true, false);
        k.el.object3D.getWorldPosition(_tmpP);
        if (k.kind === 'hand') {
          k.el.object3D.getWorldQuaternion(_tmpQ);
          setKinematicTarget(_b3, k.body, _tmpP.x, _tmpP.y, _tmpP.z, _tmpQ, dt);
          if (k.handId) {
            _handPrev[k.handId] = {
              x: _tmpP.x, y: _tmpP.y, z: _tmpP.z, t: now
            };
          }
        } else {
          var by = Math.max(0.95, _tmpP.y);
          setKinematicTarget(_b3, k.body, _tmpP.x, by, _tmpP.z, null, dt);
        }
      }

      // Scoop follow (held blocks ride with hand)
      tickScoopFollow(dt);

      _b3.b3World_Step(_world, dt, 6);

      for (var j = 0; j < _blocks.length; j++) {
        syncMeshFromBody(_b3, _blocks[j]);
      }
    },

    stop: function () {
      if (!_active && !_world && !_group) return;
      _active = false;
      _game = null;
      destroyWorld();
      clearVisuals();
    }
  };

  global.StacksVictoryPhysics = Api;

  function warm() {
    Api.preload();
    window.removeEventListener('pointerdown', warm);
  }
  window.addEventListener('pointerdown', warm, { once: true });
  document.addEventListener('DOMContentLoaded', function () {
    var scene = document.querySelector('a-scene');
    if (scene) scene.addEventListener('enter-vr', warm, { once: true });
  });
})(window);
