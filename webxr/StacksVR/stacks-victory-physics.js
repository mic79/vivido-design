// stacks-victory-physics.js — end-of-match block debris via box3d.js (Quest + PCVR)
// Caps body count by randomly culling stacks first, then enables dynamics.
// Kinematics MUST use b3Body_SetTargetTransform (not SetTransform) so hands/floors
// push blocks instead of tunneling through them.
(function (global) {
  'use strict';

  var BOX3D_CDN = 'https://cdn.jsdelivr.net/npm/box3d.js@0.0.2/dist/box3d.inline.mjs';
  var MAX_BLOCKS_PER_CUP = 36;
  // CapVR-proven palm contact (grip-local). Thin box, not a fat sphere.
  var HAND_PALM_LOCAL = { x: 0, y: -0.04, z: -0.08 };
  var HAND_BOX = { hx: 0.05, hy: 0.02, hz: 0.06 }; // half-extents (metres)
  var SCOOP_REACH = 0.18;
  var TRANSFER_REACH = 0.22; // hand-to-hand steal of held debris
  var SCOOP_MAX = 3;
  var FLING_SCALE = 1.55;
  var FLING_MAX = 10;

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
  var _triggerScoop = { leftHand: false, rightHand: false }; // trigger-only (grip = playfield)
  var _handPrev = {};
  var _handVel = { leftHand: { x: 0, y: 0, z: 0 }, rightHand: { x: 0, y: 0, z: 0 } };
  var _boundHands = false;
  var _tmpOff = null;

  function ensureThreeHelpers() {
    if (!_tmpQ && global.THREE) {
      _tmpQ = new THREE.Quaternion();
      _tmpQ2 = new THREE.Quaternion();
      _tmpP = new THREE.Vector3();
      _tmpOff = new THREE.Vector3();
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
    // box3d reads friction/restitution from baseMaterial (not top-level fields)
    if (!sd.baseMaterial && typeof b3.b3DefaultSurfaceMaterial === 'function') {
      sd.baseMaterial = b3.b3DefaultSurfaceMaterial();
    }
    if (sd.baseMaterial) {
      sd.baseMaterial.friction = opts.friction != null ? opts.friction : 0.55;
      sd.baseMaterial.restitution = opts.restitution != null ? opts.restitution : 0.18;
    } else {
      sd.friction = opts.friction != null ? opts.friction : 0.55;
      sd.restitution = opts.restitution != null ? opts.restitution : 0.18;
    }
    if (opts.density != null) sd.density = opts.density;
    return sd;
  }

  function identityQuatArr() {
    return [0, 0, 0, 1];
  }

  function quatToArr(q) {
    if (!q) return identityQuatArr();
    return [q.x, q.y, q.z, q.w];
  }

  function quatToB3Rot(q) {
    if (!q) return { v: { x: 0, y: 0, z: 0 }, s: 1 };
    return { v: { x: q.x, y: q.y, z: q.z }, s: q.w };
  }

  /**
   * Drive kinematic so dynamics get contact impulse.
   * box3d.js@0.0.2 REQUIRES { p:{x,y,z}, q:{v:{x,y,z},s:w} } — NOT position/quaternion.
   * Wrong shape throws "Missing field: p"; swallowing that and SetTransform-teleporting
   * is what made floors ignore yaw and hands shove from a distance.
   */
  function setKinematicTarget(b3, body, x, y, z, q, dt) {
    if (!body || !b3) return;
    var step = Math.max(0.001, Math.min(0.05, dt || 1 / 60));
    b3.b3Body_SetTargetTransform(body, {
      p: { x: x, y: y, z: z },
      q: quatToB3Rot(q)
    }, step, true);
  }

  function handWorldPose(handEl, outPos, outQuat) {
    ensureThreeHelpers();
    handEl.object3D.updateWorldMatrix(true, false);
    handEl.object3D.getWorldPosition(outPos);
    handEl.object3D.getWorldQuaternion(outQuat);
    // Grip → palm (same local offset CapVR uses for contact)
    var off = new THREE.Vector3(HAND_PALM_LOCAL.x, HAND_PALM_LOCAL.y, HAND_PALM_LOCAL.z);
    off.applyQuaternion(outQuat);
    outPos.add(off);
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
    def.rotation = quatToB3Rot(null);
    var body = b3.b3CreateBody(world, def);
    b3.b3CreateBoxShape(body, shapeDef(b3, opts || { friction: 0.85, restitution: 0.05 }), hx, hy, hz);
    return body;
  }

  function addKinematicBox(b3, world, x, y, z, hx, hy, hz, q, opts) {
    opts = opts || {};
    var def = b3.b3DefaultBodyDef();
    def.type = b3.b3BodyType.b3_kinematicBody;
    def.position = { x: x, y: y, z: z };
    def.rotation = quatToB3Rot(q);
    // Fast cup yaw needs this or angular velocity is clamped and blocks slip
    if (opts.allowFastRotation && def.allowFastRotation != null) {
      def.allowFastRotation = true;
    }
    var body = b3.b3CreateBody(world, def);
    b3.b3CreateBoxShape(body, shapeDef(b3, {
      friction: opts.friction != null ? opts.friction : 0.95,
      restitution: opts.restitution != null ? opts.restitution : 0.05
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
    def.rotation = quatToB3Rot(_tmpQ);
    // Victory debris must stay interactive — sleep freezes piles until a wake
    // chain hits them, which reads as "physics stopped" on untouched blocks.
    if (def.enableSleep != null) def.enableSleep = false;
    if (def.linearDamping != null) def.linearDamping = 0.08;
    if (def.angularDamping != null) def.angularDamping = 0.12;
    var body = b3.b3CreateBody(world, def);
    // Heavier + slightly slipperier so towers tumble instead of looking glued
    b3.b3CreateBoxShape(body, shapeDef(b3, {
      friction: 0.55,
      restitution: 0.15,
      density: 3.5
    }), half, half, half);
    if (b3.b3Body_EnableSleep) {
      try { b3.b3Body_EnableSleep(body, false); } catch (e) { /* ignore */ }
    }
    if (b3.b3Body_SetAwake) b3.b3Body_SetAwake(body, true);
    // Break stable stacks on enable — without this, high-friction towers sit
    // perfectly still and look like physics never started on those blocks.
    if (b3.b3Body_SetLinearVelocity) {
      b3.b3Body_SetLinearVelocity(body, {
        x: (Math.random() - 0.5) * 0.55,
        y: Math.random() * 0.35,
        z: (Math.random() - 0.5) * 0.55
      });
    }
    if (b3.b3Body_SetAngularVelocity) {
      b3.b3Body_SetAngularVelocity(body, {
        x: (Math.random() - 0.5) * 3.5,
        y: (Math.random() - 0.5) * 3.5,
        z: (Math.random() - 0.5) * 3.5
      });
    }
    return body;
  }

  /** Drop held flag + re-enable simulation (no fling). */
  function releaseBlockEntry(entry, vel) {
    if (!entry || !entry.body) return;
    entry.held = null;
    if (!_b3) return;
    if (_b3.b3Body_SetLinearVelocity) {
      _b3.b3Body_SetLinearVelocity(entry.body, vel || { x: 0, y: 0, z: 0 });
    }
    if (_b3.b3Body_SetAwake) _b3.b3Body_SetAwake(entry.body, true);
    if (_b3.b3Body_EnableSleep) {
      try { _b3.b3Body_EnableSleep(entry.body, false); } catch (e) { /* ignore */ }
    }
  }

  /** Any held=true block not in an active scoop list is frozen — repair. */
  function repairOrphanHolds() {
    var inScoop = [];
    ['leftHand', 'rightHand'].forEach(function (hid) {
      var list = _scoop[hid] || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].entry) inScoop.push(list[i].entry);
      }
    });
    for (var j = 0; j < _blocks.length; j++) {
      var b = _blocks[j];
      if (!b.held) continue;
      if (inScoop.indexOf(b) >= 0) continue;
      releaseBlockEntry(b, { x: 0, y: 0, z: 0 });
    }
  }

  function cupFloorPose(cup) {
    ensureThreeHelpers();
    var w = cup.width * cup.cellSize;
    var d = cup.depth * cup.cellSize;
    // Thin slab just under the cell grid (y=0). No walls/ceiling — open top.
    // Use pivot world pose so yaw/height raise drive the kinematic floor correctly.
    var hy = 0.018;
    var pivot = cup.pivot || cup.root;
    pivot.updateWorldMatrix(true, false);
    // Floor center = pivot origin, dropped by hy along world-up of the cup
    pivot.getWorldPosition(_tmpP);
    pivot.getWorldQuaternion(_tmpQ);
    var down = new THREE.Vector3(0, -hy, 0);
    down.applyQuaternion(_tmpQ);
    return {
      x: _tmpP.x + down.x,
      y: _tmpP.y + down.y,
      z: _tmpP.z + down.z,
      q: _tmpQ.clone(),
      hx: w * 0.5 + 0.02,
      hy: hy,
      hz: d * 0.5 + 0.02
    };
  }

  function syncMeshFromBody(b3, entry) {
    if (!entry.body || !entry.mesh || entry.held) return;
    var p = b3.b3Body_GetPosition(entry.body);
    var r = b3.b3Body_GetRotation(entry.body);
    entry.mesh.position.set(p.x, p.y, p.z);
    if (r && r.v) entry.mesh.quaternion.set(r.v.x, r.v.y, r.v.z, r.s);
  }

  function otherHandId(handId) {
    return handId === 'leftHand' ? 'rightHand' : 'leftHand';
  }

  function makeGrabRecord(entry, handPos, invQ) {
    var bp = _b3.b3Body_GetPosition(entry.body);
    var br = _b3.b3Body_GetRotation(entry.body);
    _tmpOff.set(bp.x - handPos.x, bp.y - handPos.y, bp.z - handPos.z);
    _tmpOff.applyQuaternion(invQ);
    var blockQ = new THREE.Quaternion(
      br && br.v ? br.v.x : 0,
      br && br.v ? br.v.y : 0,
      br && br.v ? br.v.z : 0,
      br && br.s != null ? br.s : 1
    );
    var relQ = invQ.clone().multiply(blockQ);
    if (_b3.b3Body_SetLinearVelocity) {
      _b3.b3Body_SetLinearVelocity(entry.body, { x: 0, y: 0, z: 0 });
    }
    if (_b3.b3Body_SetAngularVelocity) {
      _b3.b3Body_SetAngularVelocity(entry.body, { x: 0, y: 0, z: 0 });
    }
    return {
      entry: entry,
      lx: _tmpOff.x, ly: _tmpOff.y, lz: _tmpOff.z,
      rq: { x: relQ.x, y: relQ.y, z: relQ.z, w: relQ.w }
    };
  }

  /**
   * @param {string|null} allowStealFrom  other hand id — include that hand's held blocks
   */
  function findBlockNear(handPos, ignoreSet, allowStealFrom, maxDist) {
    var best = null;
    var bestD = maxDist != null ? maxDist : SCOOP_REACH;
    for (var i = 0; i < _blocks.length; i++) {
      var b = _blocks[i];
      if (!b.body || !b.mesh) continue;
      if (ignoreSet && ignoreSet[i]) continue;
      if (b.held) {
        // Own holds already scooped; only steal from the other hand
        if (!allowStealFrom || b.held !== allowStealFrom) continue;
      }
      var p = _b3.b3Body_GetPosition(b.body);
      var dx = p.x - handPos.x;
      var dy = p.y - handPos.y;
      var dz = p.z - handPos.z;
      var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < bestD) {
        bestD = d;
        best = { entry: b, index: i, d: d, steal: !!b.held };
      }
    }
    return best;
  }

  /** Pull entry out of a hand's scoop list without flinging. */
  function detachScoopEntry(handId, entry) {
    var list = _scoop[handId] || [];
    var kept = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].entry !== entry) kept.push(list[i]);
    }
    _scoop[handId] = kept;
  }

  function beginScoop(handId) {
    if (!_active || !_b3) return;
    // Already holding — do NOT re-grab (prevents orphan held freezes).
    if (_scoop[handId] && _scoop[handId].length) return;
    var hand = document.getElementById(handId);
    if (!hand || !hand.object3D) return;
    ensureThreeHelpers();
    handWorldPose(hand, _tmpP, _tmpQ);
    var handPos = { x: _tmpP.x, y: _tmpP.y, z: _tmpP.z };
    var invQ = _tmpQ.clone().invert();
    var other = otherHandId(handId);
    var grabbed = [];
    var used = {};
    for (var n = 0; n < SCOOP_MAX; n++) {
      // Prefer steal from other hand, then free debris
      var hit = findBlockNear(handPos, used, other, TRANSFER_REACH) ||
        findBlockNear(handPos, used, null, SCOOP_REACH);
      if (!hit) break;
      used[hit.index] = true;
      if (hit.steal) detachScoopEntry(other, hit.entry);
      hit.entry.held = handId;
      grabbed.push(makeGrabRecord(hit.entry, handPos, invQ));
    }
    _scoop[handId] = grabbed;
  }

  function endScoop(handId) {
    var list = _scoop[handId] || [];
    _scoop[handId] = [];
    if (_active && _b3 && list.length) {
      // Use EMA hand velocity (updated BEFORE _handPrev overwrite) — old code
      // read _handPrev after it was set to current pose → ~zero fling.
      var hv = _handVel[handId] || { x: 0, y: 0, z: 0 };
      var vx = hv.x * FLING_SCALE;
      var vy = hv.y * FLING_SCALE;
      var vz = hv.z * FLING_SCALE;
      var speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed > FLING_MAX) {
        var s = FLING_MAX / speed;
        vx *= s; vy *= s; vz *= s;
      }
      for (var i = 0; i < list.length; i++) {
        var g = list[i];
        releaseBlockEntry(g.entry, { x: vx, y: vy, z: vz });
        if (_b3.b3Body_SetAngularVelocity) {
          _b3.b3Body_SetAngularVelocity(g.entry.body, {
            x: (Math.random() - 0.5) * 4 + hv.z * 0.15,
            y: (Math.random() - 0.5) * 4,
            z: (Math.random() - 0.5) * 4 - hv.x * 0.15
          });
        }
      }
    }
    for (var j = 0; j < _blocks.length; j++) {
      if (_blocks[j].held === handId) {
        releaseBlockEntry(_blocks[j], { x: 0, y: 0, z: 0 });
      }
    }
  }

  function onTriggerDown(handId) {
    _triggerScoop[handId] = true;
    if (_active) beginScoop(handId);
  }

  function onTriggerUp(handId) {
    _triggerScoop[handId] = false;
    endScoop(handId);
  }

  function tickScoopFollow(dt) {
    if (!_b3) return;
    ensureThreeHelpers();
    var step = Math.max(0.001, dt || 1 / 60);
    ['leftHand', 'rightHand'].forEach(function (handId) {
      // While trigger held with empty hand, keep trying to pick up
      if (_triggerScoop[handId] && (!_scoop[handId] || !_scoop[handId].length)) {
        beginScoop(handId);
      }
      var list = _scoop[handId];
      if (!list || !list.length) return;
      var hand = document.getElementById(handId);
      if (!hand || !hand.object3D) return;
      handWorldPose(hand, _tmpP, _tmpQ);
      for (var i = 0; i < list.length; i++) {
        var g = list[i];
        _tmpOff.set(g.lx, g.ly, g.lz).applyQuaternion(_tmpQ);
        var tx = _tmpP.x + _tmpOff.x;
        var ty = _tmpP.y + _tmpOff.y;
        var tz = _tmpP.z + _tmpOff.z;
        _tmpQ2.set(g.rq.x, g.rq.y, g.rq.z, g.rq.w);
        _tmpQ2.premultiply(_tmpQ);
        // SetTargetTransform (not SetTransform) so contacts stay physical
        setKinematicTarget(_b3, g.entry.body, tx, ty, tz, _tmpQ2, step);
        if (_b3.b3Body_SetAwake) _b3.b3Body_SetAwake(g.entry.body, true);
        g.entry.mesh.position.set(tx, ty, tz);
        g.entry.mesh.quaternion.copy(_tmpQ2);
      }
    });
  }

  /** Sample palm velocity BEFORE overwriting _handPrev (critical for fling). */
  function updateHandVelocity(handId, x, y, z, now) {
    var prev = _handPrev[handId];
    var vx = 0, vy = 0, vz = 0;
    if (prev && prev.t) {
      var hdt = Math.max(0.008, (now - prev.t) / 1000);
      vx = (x - prev.x) / hdt;
      vy = (y - prev.y) / hdt;
      vz = (z - prev.z) / hdt;
    }
    // EMA — smooth Quest tracking noise, keep throw readable
    var old = _handVel[handId] || { x: 0, y: 0, z: 0 };
    var a = 0.45;
    _handVel[handId] = {
      x: old.x * (1 - a) + vx * a,
      y: old.y * (1 - a) + vy * a,
      z: old.z * (1 - a) + vz * a
    };
    _handPrev[handId] = { x: x, y: y, z: z, t: now };
  }

  /** True if this hand could scoop a nearby debris block (incl. steal). */
  function canScoopNear(handEl) {
    if (!_active || !_b3 || !handEl || !handEl.object3D) return false;
    ensureThreeHelpers();
    handWorldPose(handEl, _tmpP, _tmpQ);
    var handId = handEl.id;
    var other = handId ? otherHandId(handId) : null;
    var pos = { x: _tmpP.x, y: _tmpP.y, z: _tmpP.z };
    return !!(findBlockNear(pos, null, other, TRANSFER_REACH) ||
      findBlockNear(pos, null, null, SCOOP_REACH));
  }

  function bindHandScoop() {
    if (_boundHands) return;
    _boundHands = true;
    ['leftHand', 'rightHand'].forEach(function (id) {
      var hand = document.getElementById(id);
      if (!hand) return;
      // Trigger = debris only. Grip stays free for playfield yaw/raise in stacks-game.
      hand.addEventListener('triggerdown', function () { onTriggerDown(id); });
      hand.addEventListener('triggerup', function () { onTriggerUp(id); });
    });
  }

  function destroyWorld() {
    _triggerScoop = { leftHand: false, rightHand: false };
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
        if (worldDef.enableSleep != null) worldDef.enableSleep = false;
        _world = b3.b3CreateWorld(worldDef);

        // Arena floor (static)
        addStaticBox(b3, _world, 0, -0.05, 0, 8, 0.05, 8, { friction: 0.9, restitution: 0.05 });

        // Playfield floors — kinematic, track raise/yaw so blocks react
        [blue, red].forEach(function (cup) {
          if (!cup) return;
          var fp = cupFloorPose(cup);
          var body = addKinematicBox(b3, _world, fp.x, fp.y, fp.z, fp.hx, fp.hy, fp.hz, fp.q, {
            friction: 1.2,
            restitution: 0.02,
            allowFastRotation: true
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

        // No player/avatar body capsules — a 16cm torso capsule was shoving the
        // pile whenever the user leaned in, while visible hands were still far away.

        // Hands — thin kinematic palm boxes at CapVR grip→palm offset
        ['leftHand', 'rightHand'].forEach(function (hid) {
          var hand = document.getElementById(hid);
          if (!hand || !hand.object3D) return;
          handWorldPose(hand, _tmpP, _tmpQ);
          var hBody = addKinematicBox(
            b3, _world,
            _tmpP.x, _tmpP.y, _tmpP.z,
            HAND_BOX.hx, HAND_BOX.hy, HAND_BOX.hz,
            _tmpQ,
            { friction: 1.25, restitution: 0.02 }
          );
          _kinematics.push({ body: hBody, el: hand, kind: 'hand', handId: hid });
          _handPrev[hid] = { x: _tmpP.x, y: _tmpP.y, z: _tmpP.z, t: performance.now() };
          _handVel[hid] = { x: 0, y: 0, z: 0 };
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
        if (k.kind === 'hand') {
          handWorldPose(k.el, _tmpP, _tmpQ);
          // Velocity from previous pose BEFORE we overwrite it
          if (k.handId) updateHandVelocity(k.handId, _tmpP.x, _tmpP.y, _tmpP.z, now);
          setKinematicTarget(_b3, k.body, _tmpP.x, _tmpP.y, _tmpP.z, _tmpQ, dt);
        } else {
          k.el.object3D.updateWorldMatrix(true, false);
          k.el.object3D.getWorldPosition(_tmpP);
          var by = Math.max(0.95, _tmpP.y);
          setKinematicTarget(_b3, k.body, _tmpP.x, by, _tmpP.z, null, dt);
        }
      }

      // Scoop follow (held blocks ride with hand)
      tickScoopFollow(dt);
      repairOrphanHolds();

      _b3.b3World_Step(_world, dt, 6);

      for (var j = 0; j < _blocks.length; j++) {
        syncMeshFromBody(_b3, _blocks[j]);
      }
    },

    stop: function () {
      if (!_active && !_world && !_group) return;
      var game = _game;
      _active = false;
      _game = null;
      destroyWorld();
      clearVisuals();
      // Allow deferred cup-height ease now that the kinematic floor is gone
      if (game && typeof game._flushPendingCupHeightReset === 'function') {
        try { game._flushPendingCupHeightReset(); } catch (e) { /* ignore */ }
      }
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
