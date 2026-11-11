// shapes.js — tetromino definitions, bag, and mesh helpers for StacksVR
(function (global) {
  'use strict';

  var CELL = 0.12;
  var HALF_PI = Math.PI / 2;
  // BattleBlocks look: bright white play blocks (dark debris is background only)
  var BLOCK_COLOR = '#ffffff';
  var GARBAGE_COLOR = '#f0f0f4';

  /** White play blocks — bright + clearcoat so arena IBL/lights read as reflections. */
  function makeBlockMaterial(color) {
    var Mat = THREE.MeshPhysicalMaterial || THREE.MeshStandardMaterial;
    return new Mat({
      color: color || BLOCK_COLOR,
      roughness: 0.32,
      metalness: 0.04,
      clearcoat: 0.55,
      clearcoatRoughness: 0.22,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.42,
      envMapIntensity: 1.35,
      toneMapped: false
    });
  }

  // Relative cell offsets for each shape (y-up). Default pose is flat on XZ.
  var DEFS = {
    I: { color: BLOCK_COLOR, cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]] },
    O: { color: BLOCK_COLOR, cells: [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1]] },
    T: { color: BLOCK_COLOR, cells: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [1, 0, 1]] },
    L: { color: BLOCK_COLOR, cells: [[0, 0, 0], [0, 0, 1], [0, 0, 2], [1, 0, 2]] },
    J: { color: BLOCK_COLOR, cells: [[1, 0, 0], [1, 0, 1], [1, 0, 2], [0, 0, 2]] },
    S: { color: BLOCK_COLOR, cells: [[1, 0, 0], [2, 0, 0], [0, 0, 1], [1, 0, 1]] },
    Z: { color: BLOCK_COLOR, cells: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [2, 0, 1]] }
  };

  var BAG_ORDER = ['I', 'O', 'T', 'L', 'J', 'S', 'Z'];

  var _v = null;
  var _e = null;
  var _q = null;
  var _m = null;
  var _cubeQuats = null;
  var _roundedBlockGeo = null;

  /** Shared bevelled cell cube — solid one-color blocks with soft corners. */
  function roundedBlockGeo() {
    if (_roundedBlockGeo) return _roundedBlockGeo;
    if (typeof THREE === 'undefined') return null;
    var s = CELL * 0.92;
    var r = Math.min(0.02, s * 0.2);
    var h = s / 2;
    var shape = new THREE.Shape();
    shape.moveTo(-h + r, -h);
    shape.lineTo(h - r, -h);
    shape.quadraticCurveTo(h, -h, h, -h + r);
    shape.lineTo(h, h - r);
    shape.quadraticCurveTo(h, h, h - r, h);
    shape.lineTo(-h + r, h);
    shape.quadraticCurveTo(-h, h, -h, h - r);
    shape.lineTo(-h, -h + r);
    shape.quadraticCurveTo(-h, -h, -h + r, -h);
    var geo = new THREE.ExtrudeGeometry(shape, {
      depth: s - r,
      bevelEnabled: true,
      bevelThickness: r * 0.55,
      bevelSize: r * 0.45,
      bevelSegments: 2,
      curveSegments: 4
    });
    geo.computeBoundingBox();
    var bb = geo.boundingBox;
    geo.translate(
      -(bb.min.x + bb.max.x) * 0.5,
      -(bb.min.y + bb.max.y) * 0.5,
      -(bb.min.z + bb.max.z) * 0.5
    );
    _roundedBlockGeo = geo;
    return geo;
  }

  function _tmp() {
    if (typeof THREE === 'undefined') return;
    if (!_v) {
      _v = new THREE.Vector3();
      _e = new THREE.Euler(0, 0, 0, 'XYZ');
      _q = new THREE.Quaternion();
      _m = new THREE.Matrix4();
    }
  }

  /** All 24 orientations of a cube (90° multiples). */
  function cubeOrients() {
    if (_cubeQuats) return _cubeQuats;
    _tmp();
    var list = [];
    var seen = {};
    for (var ix = 0; ix < 4; ix++) {
      for (var iy = 0; iy < 4; iy++) {
        for (var iz = 0; iz < 4; iz++) {
          _e.set(ix * HALF_PI, iy * HALF_PI, iz * HALF_PI, 'XYZ');
          _q.setFromEuler(_e);
          // Canonicalize sign (q and -q are the same rotation)
          if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
          var key = [ _q.x, _q.y, _q.z, _q.w ].map(function (v) {
            return Math.round(v * 1000);
          }).join(',');
          if (seen[key]) continue;
          seen[key] = true;
          list.push(_q.clone());
        }
      }
    }
    _cubeQuats = list;
    return list;
  }

  function cloneCells(cells) {
    return cells.map(function (c) { return [c[0], c[1], c[2]]; });
  }

  function rotateX(cells, turns) {
    turns = ((turns % 4) + 4) % 4;
    var out = cloneCells(cells);
    for (var t = 0; t < turns; t++) {
      for (var i = 0; i < out.length; i++) {
        var y = out[i][1], z = out[i][2];
        out[i][1] = -z;
        out[i][2] = y;
      }
    }
    return out;
  }

  function rotateY(cells, turns) {
    turns = ((turns % 4) + 4) % 4;
    var out = cloneCells(cells);
    for (var t = 0; t < turns; t++) {
      for (var i = 0; i < out.length; i++) {
        var x = out[i][0], z = out[i][2];
        out[i][0] = z;
        out[i][2] = -x;
      }
    }
    return out;
  }

  function rotateZ(cells, turns) {
    turns = ((turns % 4) + 4) % 4;
    var out = cloneCells(cells);
    for (var t = 0; t < turns; t++) {
      for (var i = 0; i < out.length; i++) {
        var x = out[i][0], y = out[i][1];
        out[i][0] = -y;
        out[i][1] = x;
      }
    }
    return out;
  }

  function normalizeXYZ(cells) {
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i][0] < minX) minX = cells[i][0];
      if (cells[i][1] < minY) minY = cells[i][1];
      if (cells[i][2] < minZ) minZ = cells[i][2];
    }
    return cells.map(function (c) {
      return [c[0] - minX, c[1] - minY, c[2] - minZ];
    });
  }

  // Back-compat alias (also shifts Y — flat shapes already have minY=0)
  function normalizeXZ(cells) {
    return normalizeXYZ(cells);
  }

  function extentOfCells(cells) {
    var maxX = 0, maxY = 0, maxZ = 0;
    for (var i = 0; i < cells.length; i++) {
      if (cells[i][0] > maxX) maxX = cells[i][0];
      if (cells[i][1] > maxY) maxY = cells[i][1];
      if (cells[i][2] > maxZ) maxZ = cells[i][2];
    }
    return { cells: cells, maxX: maxX, maxY: maxY, maxZ: maxZ };
  }

  /**
   * Snap an arbitrary quaternion to the nearest of the 24 cube orientations.
   * Uses max |dot| (q and -q represent the same rotation).
   */
  function snapQuatToGrid(q) {
    var cands = cubeOrients();
    var best = cands[0];
    var bestAbs = -1;
    for (var i = 0; i < cands.length; i++) {
      var d = Math.abs(q.dot(cands[i]));
      if (d > bestAbs) {
        bestAbs = d;
        best = cands[i];
      }
    }
    return best.clone();
  }

  /**
   * Rotate polycube cells by quaternion snapped to 90°, via an integer
   * rotation matrix (no float centroid rounding — that breaks tetrominoes).
   */
  function orientCells(cells, quat) {
    _tmp();
    var q = snapQuatToGrid(quat);
    _m.makeRotationFromQuaternion(q);
    var te = _m.elements;
    // Column-major: p' = M * p
    var r00 = Math.round(te[0]), r01 = Math.round(te[4]), r02 = Math.round(te[8]);
    var r10 = Math.round(te[1]), r11 = Math.round(te[5]), r12 = Math.round(te[9]);
    var r20 = Math.round(te[2]), r21 = Math.round(te[6]), r22 = Math.round(te[10]);

    var out = [];
    for (var i = 0; i < cells.length; i++) {
      var x = cells[i][0], y = cells[i][1], z = cells[i][2];
      out.push([
        r00 * x + r01 * y + r02 * z,
        r10 * x + r11 * y + r12 * z,
        r20 * x + r21 * y + r22 * z
      ]);
    }
    return normalizeXYZ(out);
  }

  function cellsOriented(type, quat) {
    var def = DEFS[type];
    if (!def) return [];
    return orientCells(def.cells, quat);
  }

  function orientKey(quat) {
    var q = snapQuatToGrid(quat);
    // Stable short key from snapped quaternion components
    return [q.x, q.y, q.z, q.w].map(function (v) {
      return Math.round(v * 1000);
    }).join(',');
  }

  /** Deterministic PRNG (mulberry32). Same seed ⇒ same stream. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Fresh per-match seed (unique across sessions). */
  function newBagSeed() {
    var t = Date.now() & 0xffffffff;
    var r = (Math.random() * 0x100000000) >>> 0;
    return (t ^ r ^ ((performance && performance.now)
      ? (performance.now() * 1000) >>> 0
      : 0)) >>> 0;
  }

  /**
   * 7-bag randomizer. Pass the same seed to two bags for fair mirrored PvP —
   * each side's Nth piece matches; refill streams stay aligned by piece index.
   */
  function ShapeBag(seed) {
    this._bag = [];
    this.seed = seed == null ? null : (seed >>> 0);
    this._rng = this.seed == null ? Math.random.bind(Math) : mulberry32(this.seed);
  }

  ShapeBag.prototype._refill = function () {
    var next = BAG_ORDER.slice();
    var rand = this._rng;
    for (var i = next.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var tmp = next[i]; next[i] = next[j]; next[j] = tmp;
    }
    this._bag = this._bag.concat(next);
  };

  ShapeBag.prototype.next = function () {
    if (this._bag.length === 0) this._refill();
    return this._bag.shift();
  };

  ShapeBag.prototype.peek = function (n) {
    n = n || 1;
    while (this._bag.length < n) this._refill();
    return this._bag.slice(0, n);
  };

  function shapeExtent(type, rot) {
    var cells = normalizeXYZ(rotateY(DEFS[type].cells, rot || 0));
    return extentOfCells(cells);
  }

  function createShapeMesh(type, opts) {
    opts = opts || {};
    var def = DEFS[type];
    if (!def) return null;

    var cells;
    if (opts.cells) {
      cells = normalizeXYZ(opts.cells);
    } else if (opts.orientQuat) {
      cells = cellsOriented(type, opts.orientQuat);
    } else {
      var rot = opts.rotationY || 0;
      cells = normalizeXYZ(rotateY(def.cells, rot));
    }

    var group = new THREE.Group();
    group.userData.shapeType = type;
    group.userData.rotationY = opts.rotationY || 0;
    group.userData.cells = cells;
    group.userData.color = def.color;
    group.userData.isGarbage = !!opts.garbage;
    group.userData.placed = false;
    group.userData.isGhost = !!opts.ghost;

    var color = opts.garbage ? GARBAGE_COLOR : BLOCK_COLOR;
    var geo = roundedBlockGeo() || new THREE.BoxGeometry(CELL * 0.92, CELL * 0.92, CELL * 0.92);
    var mat;
    if (opts.ghost) {
      var ghostCol = opts.valid === false ? '#E53935' : '#69F0AE';
      mat = new THREE.MeshBasicMaterial({
        color: ghostCol,
        transparent: true,
        opacity: opts.valid === false ? 0.55 : 0.9,
        depthWrite: false,
        toneMapped: false
      });
    } else {
      mat = makeBlockMaterial(color);
    }

    for (var i = 0; i < cells.length; i++) {
      var mesh = new THREE.Mesh(geo, mat.clone());
      mesh.position.set(
        (cells[i][0] + 0.5) * CELL,
        (cells[i][1] + 0.5) * CELL,
        (cells[i][2] + 0.5) * CELL
      );
      if (opts.ghost) {
        mesh.renderOrder = 2;
      } else {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
      group.add(mesh);
    }

    if (opts.centerPivot) {
      var cx = 0, cy = 0, cz = 0;
      for (var j = 0; j < cells.length; j++) {
        cx += cells[j][0] + 0.5;
        cy += cells[j][1] + 0.5;
        cz += cells[j][2] + 0.5;
      }
      cx = (cx / cells.length) * CELL;
      cy = (cy / cells.length) * CELL;
      cz = (cz / cells.length) * CELL;
      for (var k = 0; k < group.children.length; k++) {
        group.children[k].position.x -= cx;
        group.children[k].position.y -= cy;
        group.children[k].position.z -= cz;
      }
      group.userData.pivotOffset = { x: cx, y: cy, z: cz };
    }
    return group;
  }

  global.StacksShapes = {
    CELL: CELL,
    BLOCK_COLOR: BLOCK_COLOR,
    GARBAGE_COLOR: GARBAGE_COLOR,
    makeBlockMaterial: makeBlockMaterial,
    DEFS: DEFS,
    BAG_ORDER: BAG_ORDER,
    ShapeBag: ShapeBag,
    newBagSeed: newBagSeed,
    roundedBlockGeo: roundedBlockGeo,
    createShapeMesh: createShapeMesh,
    shapeExtent: shapeExtent,
    extentOfCells: extentOfCells,
    rotateX: rotateX,
    rotateY: rotateY,
    rotateZ: rotateZ,
    normalizeXZ: normalizeXZ,
    normalizeXYZ: normalizeXYZ,
    cloneCells: cloneCells,
    snapQuatToGrid: snapQuatToGrid,
    orientCells: orientCells,
    cellsOriented: cellsOriented,
    orientKey: orientKey,
    cubeOrients: cubeOrients
  };
})(window);
