// stacks-victory-physics.js — end-of-match block debris via box3d.js (Quest + PCVR)
// Caps body count by randomly culling stacks first, then enables dynamics.
(function (global) {
  'use strict';

  var BOX3D_CDN = 'https://cdn.jsdelivr.net/npm/box3d.js@0.0.2/dist/box3d.inline.mjs';
  // Quest-friendly: two cups × this many boxes
  var MAX_BLOCKS_PER_CUP = 36;
  var HALF = ((global.StacksShapes && global.StacksShapes.CELL) || 0.12) * 0.46;

  var _b3 = null;
  var _b3Loading = null;
  var _active = false;
  var _world = null;
  var _blocks = []; // { body, mesh }
  var _kinematics = []; // { body, el, kind }
  var _statics = [];
  var _group = null;
  var _tmpQ = null;
  var _tmpP = null;
  var _scratchPos = { x: 0, y: 0, z: 0 };
  var _scratchRot = { v: { x: 0, y: 0, z: 0 }, s: 1 };
  var _lastStep = 0;

  function ensureThreeHelpers() {
    if (!_tmpQ && global.THREE) {
      _tmpQ = new THREE.Quaternion();
      _tmpP = new THREE.Vector3();
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

  /** Randomly cull each cup down to MAX_BLOCKS_PER_CUP (prefer higher cells). */
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
    // Weight toward removing higher blocks first (shuffle with y bias)
    cells.sort(function (a, b) {
      var ja = a.y + Math.random() * 0.35;
      var jb = b.y + Math.random() * 0.35;
      return jb - ja;
    });
    var removeN = cells.length - maxKeep;
    for (var i = 0; i < removeN; i++) {
      var c = cells[i];
      cup.removeCellAt(c.x, c.y, c.z, false);
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
    b3.b3CreateBoxShape(body, shapeDef(b3, opts || { friction: 0.7, restitution: 0.05 }), hx, hy, hz);
    _statics.push(body);
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
    var body = b3.b3CreateBody(world, def);
    b3.b3CreateBoxShape(body, shapeDef(b3, {
      friction: 0.5,
      restitution: 0.22,
      density: 1.2
    }), half, half, half);
    if (b3.b3Body_SetAwake) b3.b3Body_SetAwake(body, true);
    return body;
  }

  function addKinematicCapsule(b3, world, x, y, z) {
    var def = b3.b3DefaultBodyDef();
    def.type = b3.b3BodyType.b3_kinematicBody;
    def.position = { x: x, y: y, z: z };
    def.rotation = identityRot();
    var body = b3.b3CreateBody(world, def);
    var cap = {
      center1: { x: 0, y: -0.55, z: 0 },
      center2: { x: 0, y: 0.55, z: 0 },
      radius: 0.2
    };
    b3.b3CreateCapsuleShape(body, shapeDef(b3, { friction: 0.35, restitution: 0.1 }), cap);
    return body;
  }

  function cupFloorWorld(cup) {
    ensureThreeHelpers();
    var w = cup.width * cup.cellSize;
    var d = cup.depth * cup.cellSize;
    // Floor sits at local y=0 of cup root — sample center
    var local = new THREE.Vector3(w * 0.5, 0, d * 0.5);
    cup.root.updateWorldMatrix(true, false);
    local.applyMatrix4(cup.root.matrixWorld);
    return {
      x: local.x,
      y: local.y,
      z: local.z,
      hx: w * 0.5 + 0.02,
      hy: 0.04,
      hz: d * 0.5 + 0.02
    };
  }

  function reparentMeshToGroup(mesh, group) {
    ensureThreeHelpers();
    mesh.updateWorldMatrix(true, false);
    mesh.getWorldPosition(_tmpP);
    mesh.getWorldQuaternion(_tmpQ);
    if (mesh.parent) mesh.parent.remove(mesh);
    group.add(mesh);
    mesh.position.copy(_tmpP);
    mesh.quaternion.copy(_tmpQ);
    mesh.scale.set(1, 1, 1);
  }

  function syncMeshFromBody(b3, entry) {
    if (!entry.body || !entry.mesh) return;
    var p = b3.b3Body_GetPosition(entry.body);
    var r = b3.b3Body_GetRotation(entry.body);
    entry.mesh.position.set(p.x, p.y, p.z);
    if (r && r.v) {
      entry.mesh.quaternion.set(r.v.x, r.v.y, r.v.z, r.s);
    }
  }

  function syncKinematicFromEl(b3, entry) {
    if (!entry.body || !entry.el || !entry.el.object3D) return;
    ensureThreeHelpers();
    entry.el.object3D.updateWorldMatrix(true, false);
    entry.el.object3D.getWorldPosition(_tmpP);
    // Capsule center ~ torso mid
    var y = _tmpP.y;
    if (entry.kind === 'player') y = Math.max(0.9, _tmpP.y);
    else y = Math.max(0.85, _tmpP.y);
    b3.b3Body_SetTransform(entry.body, { x: _tmpP.x, y: y, z: _tmpP.z }, identityRot());
  }

  function destroyWorld() {
    if (_b3 && _world && typeof _b3.b3DestroyWorld === 'function') {
      try { _b3.b3DestroyWorld(_world); } catch (e) { /* ignore */ }
    }
    _world = null;
    _blocks = [];
    _kinematics = [];
    _statics = [];
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

    preload: function () {
      return loadBox3D().catch(function () { /* ignore */ });
    },

    /**
     * Cull tall stacks, then enable box3d debris until stop().
     * @param {object} game — stacks-game component instance
     */
    start: function (game) {
      if (!game || !game.cups) return Promise.resolve(false);
      if (_active) Api.stop();

      var blue = game.cups.blue;
      var red = game.cups.red;
      var beforeB = blue && blue.countBlocks ? blue.countBlocks() : 0;
      var beforeR = red && red.countBlocks ? red.countBlocks() : 0;
      if (beforeB + beforeR === 0) return Promise.resolve(false);

      cullCup(blue, MAX_BLOCKS_PER_CUP);
      cullCup(red, MAX_BLOCKS_PER_CUP);

      return loadBox3D().then(function (b3) {
        ensureThreeHelpers();
        var worldDef = b3.b3DefaultWorldDef();
        worldDef.gravity = { x: 0, y: -9.8, z: 0 };
        _world = b3.b3CreateWorld(worldDef);

        // Arena floor
        addStaticBox(b3, _world, 0, -0.05, 0, 8, 0.05, 8, { friction: 0.85, restitution: 0.05 });

        // Cup floors (static) at current playfield pose
        if (blue) {
          var bf = cupFloorWorld(blue);
          addStaticBox(b3, _world, bf.x, bf.y - bf.hy, bf.z, bf.hx, bf.hy, bf.hz);
        }
        if (red) {
          var rf = cupFloorWorld(red);
          addStaticBox(b3, _world, rf.x, rf.y - rf.hy, rf.z, rf.hx, rf.hy, rf.hz);
        }

        _group = new THREE.Group();
        _group.name = 'stacks-victory-phys';
        // Parent on scene root so mesh world coords stay identity-local for box3d
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
          // Capture world pose while still parented under the cup
          mesh.updateWorldMatrix(true, false);
          mesh.getWorldPosition(_tmpP);
          mesh.getWorldQuaternion(_tmpQ);
          var wx = _tmpP.x, wy = _tmpP.y, wz = _tmpP.z;
          var wq = { x: _tmpQ.x, y: _tmpQ.y, z: _tmpQ.z, w: _tmpQ.w };
          // Detach from grid so later clearAll won't dispose mid-sim
          item.cup.removeCellAt(item.x, item.y, item.z, true);
          _group.add(mesh);
          mesh.position.set(wx, wy, wz);
          mesh.quaternion.set(wq.x, wq.y, wq.z, wq.w);
          mesh.scale.set(1, 1, 1);
          var body = addDynamicBox(b3, _world, mesh, half);
          _blocks.push({ body: body, mesh: mesh });
        }

        // Kinematic player / avatar pushers
        var kinEls = [
          { id: 'player', kind: 'player' },
          { id: 'player-body', kind: 'avatar' },
          { id: 'bot-body', kind: 'avatar' },
          { id: 'spec-blue-body', kind: 'avatar' }
        ];
        for (var k = 0; k < kinEls.length; k++) {
          var el = document.getElementById(kinEls[k].id);
          if (!el || !el.object3D) continue;
          if (kinEls[k].kind === 'avatar' && el.getAttribute('visible') === false &&
              el.object3D && !el.object3D.visible) continue;
          el.object3D.updateWorldMatrix(true, false);
          el.object3D.getWorldPosition(_tmpP);
          var bodyK = addKinematicCapsule(b3, _world, _tmpP.x, Math.max(0.9, _tmpP.y), _tmpP.z);
          _kinematics.push({ body: bodyK, el: el, kind: kinEls[k].kind });
        }
        // Controller hands as small kinematic spheres for shove
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
          b3.b3CreateSphereShape(hBody, shapeDef(b3, { friction: 0.4, restitution: 0.2 }), {
            center: { x: 0, y: 0, z: 0 },
            radius: 0.07
          });
          _kinematics.push({ body: hBody, el: hand, kind: 'hand' });
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

      for (var i = 0; i < _kinematics.length; i++) {
        var k = _kinematics[i];
        if (k.kind === 'hand') {
          if (!k.el || !k.el.object3D) continue;
          k.el.object3D.updateWorldMatrix(true, false);
          k.el.object3D.getWorldPosition(_tmpP);
          _b3.b3Body_SetTransform(k.body, { x: _tmpP.x, y: _tmpP.y, z: _tmpP.z }, identityRot());
        } else {
          syncKinematicFromEl(_b3, k);
        }
      }

      _b3.b3World_Step(_world, dt, 4);

      for (var j = 0; j < _blocks.length; j++) {
        syncMeshFromBody(_b3, _blocks[j]);
      }
    },

    stop: function () {
      if (!_active && !_world && !_group) return;
      _active = false;
      destroyWorld();
      clearVisuals();
    }
  };

  global.StacksVictoryPhysics = Api;

  // Warm WASM after first pointer / VR enter so match-end isn't a hitch
  function warm() {
    Api.preload();
    window.removeEventListener('pointerdown', warm);
    window.removeEventListener('enter-vr', warm);
  }
  window.addEventListener('pointerdown', warm, { once: true });
  document.addEventListener('DOMContentLoaded', function () {
    var scene = document.querySelector('a-scene');
    if (scene) scene.addEventListener('enter-vr', warm, { once: true });
  });
})(window);
