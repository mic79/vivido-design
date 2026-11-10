// cup.js — playfield grid, occupancy, construction height, visual cup for StacksVR
(function (global) {
  'use strict';

  var CELL = (global.StacksShapes && global.StacksShapes.CELL) || 0.12;

  function Cup(opts) {
    opts = opts || {};
    this.id = opts.id || 'cup';
    this.side = opts.side || 'blue'; // blue | red
    this.width = opts.width || 6;
    this.depth = opts.depth || 6;
    this.height = opts.height || 12;
    this.cellSize = CELL;
    this.position = opts.position || { x: 0, y: 0.9, z: 0 };
    this.yaw = 0;

    // grid[y][z][x] = null | { color, owner, garbage, mesh }
    this.grid = [];
    this._resetGrid();

    var w0 = this.width * this.cellSize;
    var d0 = this.depth * this.cellSize;

    // Pivot at playfield center so yaw spins the cup in place
    this.pivot = new THREE.Group();
    this.pivot.name = 'cup-pivot-' + this.id;
    this.pivot.position.set(
      this.position.x + w0 / 2,
      this.position.y,
      this.position.z + d0 / 2
    );

    this.root = new THREE.Group();
    this.root.name = 'cup-' + this.id;
    this.root.position.set(-w0 / 2, 0, -d0 / 2);
    this.pivot.add(this.root);

    this.blocksRoot = new THREE.Group();
    this.blocksRoot.name = 'blocks';
    this.root.add(this.blocksRoot);
    this._shellMats = [];
    this._buildShell();
  }

  Cup.prototype._resetGrid = function () {
    this.grid = [];
    for (var y = 0; y < this.height; y++) {
      var layer = [];
      for (var z = 0; z < this.depth; z++) {
        var row = [];
        for (var x = 0; x < this.width; x++) row.push(null);
        layer.push(row);
      }
      this.grid.push(layer);
    }
    this.constructionHeight = 0;
  };

  Cup.prototype._buildShell = function () {
    var w = this.width * this.cellSize;
    var d = this.depth * this.cellSize;
    var h = this.height * this.cellSize;
    var rimColor = this.side === 'blue' ? 0x4A90E2 : 0xE25A4A;

    var floor = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.04, 0.04, d + 0.04),
      new THREE.MeshStandardMaterial({ color: 0x222830, roughness: 0.7, metalness: 0.1 })
    );
    floor.position.set(w / 2, -0.02, d / 2);
    this.root.add(floor);

    var wallMat = new THREE.MeshStandardMaterial({
      color: rimColor,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      roughness: 0.4,
      metalness: 0.2
    });
    var edgeMat = new THREE.MeshStandardMaterial({ color: rimColor, roughness: 0.35, metalness: 0.4 });

    var self = this;
    function tagGrab(m) {
      m.userData.cupGrab = true;
      m.userData.cupId = self.id;
      return m;
    }
    function wall(geo, px, py, pz) {
      var mat = wallMat.clone();
      self._shellMats.push(mat);
      var m = tagGrab(new THREE.Mesh(geo, mat));
      m.position.set(px, py, pz);
      return m;
    }

    // Four thin walls
    this.root.add(wall(new THREE.BoxGeometry(0.02, h, d), -0.01, h / 2, d / 2));
    this.root.add(wall(new THREE.BoxGeometry(0.02, h, d), w + 0.01, h / 2, d / 2));
    this.root.add(wall(new THREE.BoxGeometry(w, h, 0.02), w / 2, h / 2, -0.01));
    this.root.add(wall(new THREE.BoxGeometry(w, h, 0.02), w / 2, h / 2, d + 0.01));

    // Top rim — primary grab handle
    var rimMat = edgeMat.clone();
    this._shellMats.push(rimMat);
    this._rimMat = rimMat;
    var rim = tagGrab(new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.06, 0.03, d + 0.06),
      rimMat
    ));
    rim.position.set(w / 2, h, d / 2);
    this.root.add(rim);
    this._rim = rim;

    // Guide lines on floor
    var lineMat = new THREE.LineBasicMaterial({ color: rimColor, transparent: true, opacity: 0.35 });
    for (var x = 0; x <= this.width; x++) {
      var g1 = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x * this.cellSize, 0.001, 0),
        new THREE.Vector3(x * this.cellSize, 0.001, d)
      ]);
      this.root.add(new THREE.Line(g1, lineMat));
    }
    for (var z = 0; z <= this.depth; z++) {
      var g2 = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.001, z * this.cellSize),
        new THREE.Vector3(w, 0.001, z * this.cellSize)
      ]);
      this.root.add(new THREE.Line(g2, lineMat));
    }
  };

  Cup.prototype.setYaw = function (yaw) {
    this.yaw = yaw;
    if (this.pivot) this.pivot.rotation.y = yaw;
    else this.root.rotation.y = yaw;
  };

  Cup.prototype.setHeight = function (y) {
    var minY = 0.35;
    var maxY = 1.75;
    this.heightOffset = THREE.MathUtils.clamp(y, minY, maxY);
    if (this.pivot) this.pivot.position.y = this.heightOffset;
    else this.root.position.y = this.heightOffset;
  };

  Cup.prototype.getHeight = function () {
    if (this.pivot) return this.pivot.position.y;
    return this.root.position.y;
  };

  Cup.prototype.getWorldCenter = function (out) {
    out = out || new THREE.Vector3();
    if (this.pivot) {
      this.pivot.updateWorldMatrix(true, false);
      this.pivot.getWorldPosition(out);
      return out;
    }
    var w = this.width * this.cellSize;
    var d = this.depth * this.cellSize;
    out.set(this.position.x + w / 2, this.position.y, this.position.z + d / 2);
    return out;
  };

  /** Pulse rim for incoming garbage telegraph. urgency 0..1 */
  Cup.prototype.setThreat = function (urgency) {
    urgency = Math.max(0, Math.min(1, urgency || 0));
    if (!this._rimMat) return;
    var base = this.side === 'blue' ? 0x4A90E2 : 0xE25A4A;
    if (!this._rimMat.emissive) this._rimMat.emissive = new THREE.Color(0x000000);
    if (urgency <= 0) {
      this._rimMat.color.setHex(base);
      this._rimMat.emissive.setHex(0x000000);
      this._rimMat.emissiveIntensity = 0;
      return;
    }
    var flash = 0.35 + 0.65 * Math.sin(performance.now() * 0.02 * (1 + urgency * 3));
    this._rimMat.emissive.setHex(0xff3300);
    this._rimMat.emissiveIntensity = urgency * flash * 1.4;
    this._rimMat.color.setHex(urgency > 0.7 ? 0xff6644 : base);
  };

  Cup.prototype.localToCell = function (localPos) {
    return {
      x: Math.floor(localPos.x / this.cellSize),
      y: Math.floor(localPos.y / this.cellSize),
      z: Math.floor(localPos.z / this.cellSize)
    };
  };

  Cup.prototype.cellCenterLocal = function (cx, cy, cz) {
    return new THREE.Vector3(
      (cx + 0.5) * this.cellSize,
      (cy + 0.5) * this.cellSize,
      (cz + 0.5) * this.cellSize
    );
  };

  Cup.prototype.inBounds = function (cx, cy, cz) {
    return cx >= 0 && cx < this.width &&
      cy >= 0 && cy < this.height &&
      cz >= 0 && cz < this.depth;
  };

  Cup.prototype.isEmpty = function (cx, cy, cz) {
    if (!this.inBounds(cx, cy, cz)) return false;
    return this.grid[cy][cz][cx] === null;
  };

  Cup.prototype.canPlace = function (cells) {
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!this.isEmpty(c[0], c[1], c[2])) return false;
    }
    return true;
  };

  Cup.prototype._makeBlockMesh = function (color) {
    var geo = new THREE.BoxGeometry(this.cellSize * 0.92, this.cellSize * 0.92, this.cellSize * 0.92);
    var mat = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.45,
      metalness: 0.15,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.1
    });
    return new THREE.Mesh(geo, mat);
  };

  Cup.prototype.placeCells = function (cells, meta) {
    meta = meta || {};
    var color = meta.color || (meta.garbage ? '#9E9E9E' : '#EEEEEE');
    var placed = [];
    for (var i = 0; i < cells.length; i++) {
      var cx = cells[i][0], cy = cells[i][1], cz = cells[i][2];
      if (!this.isEmpty(cx, cy, cz)) return null;
    }
    for (var j = 0; j < cells.length; j++) {
      var x = cells[j][0], y = cells[j][1], z = cells[j][2];
      var mesh = this._makeBlockMesh(color);
      var center = this.cellCenterLocal(x, y, z);
      mesh.position.copy(center);
      this.blocksRoot.add(mesh);
      var cell = {
        color: color,
        owner: meta.owner || this.side,
        garbage: !!meta.garbage,
        shapeType: meta.shapeType || null,
        mesh: mesh
      };
      this.grid[y][z][x] = cell;
      placed.push({ x: x, y: y, z: z, cell: cell });
    }
    this._recomputeHeight();
    return placed;
  };

  Cup.prototype.clearLayer = function (y) {
    var removed = [];
    for (var z = 0; z < this.depth; z++) {
      for (var x = 0; x < this.width; x++) {
        var cell = this.grid[y][z][x];
        if (cell) {
          if (cell.mesh && cell.mesh.parent) cell.mesh.parent.remove(cell.mesh);
          removed.push({ x: x, y: y, z: z, cell: cell });
          this.grid[y][z][x] = null;
        }
      }
    }
    return removed;
  };

  Cup.prototype.isLayerFull = function (y) {
    for (var z = 0; z < this.depth; z++) {
      for (var x = 0; x < this.width; x++) {
        if (!this.grid[y][z][x]) return false;
      }
    }
    return true;
  };

  Cup.prototype.collapseAbove = function (clearedYs) {
    // Remove cleared layers and drop everything above down
    clearedYs = clearedYs.slice().sort(function (a, b) { return a - b; });
    if (clearedYs.length === 0) return;

    var keep = [];
    for (var y = 0; y < this.height; y++) {
      if (clearedYs.indexOf(y) >= 0) continue;
      keep.push(this.grid[y]);
    }
    while (keep.length < this.height) {
      var empty = [];
      for (var z = 0; z < this.depth; z++) {
        var row = [];
        for (var x = 0; x < this.width; x++) row.push(null);
        empty.push(row);
      }
      keep.push(empty);
    }
    this.grid = keep;

    // Reposition meshes
    for (var yy = 0; yy < this.height; yy++) {
      for (var zz = 0; zz < this.depth; zz++) {
        for (var xx = 0; xx < this.width; xx++) {
          var c = this.grid[yy][zz][xx];
          if (c && c.mesh) {
            c.mesh.position.copy(this.cellCenterLocal(xx, yy, zz));
          }
        }
      }
    }
    this._recomputeHeight();
  };

  Cup.prototype._recomputeHeight = function () {
    var maxY = -1;
    for (var y = 0; y < this.height; y++) {
      for (var z = 0; z < this.depth; z++) {
        for (var x = 0; x < this.width; x++) {
          if (this.grid[y][z][x]) maxY = y;
        }
      }
    }
    this.constructionHeight = maxY + 1;
  };

  Cup.prototype.isToppedOut = function () {
    // Any block in the top layer counts as overflow
    var y = this.height - 1;
    for (var z = 0; z < this.depth; z++) {
      for (var x = 0; x < this.width; x++) {
        if (this.grid[y][z][x]) return true;
      }
    }
    return false;
  };

  Cup.prototype.isPerfectlyClear = function () {
    return this.constructionHeight === 0;
  };

  Cup.prototype.clearAll = function () {
    for (var y = 0; y < this.height; y++) this.clearLayer(y);
    this._resetGrid();
    while (this.blocksRoot.children.length) {
      this.blocksRoot.remove(this.blocksRoot.children[0]);
    }
  };

  Cup.prototype.occupiedCount = function () {
    var n = 0;
    for (var y = 0; y < this.height; y++) {
      for (var z = 0; z < this.depth; z++) {
        for (var x = 0; x < this.width; x++) {
          if (this.grid[y][z][x]) n++;
        }
      }
    }
    return n;
  };

  Cup.prototype.serialize = function () {
    var cells = [];
    for (var y = 0; y < this.height; y++) {
      for (var z = 0; z < this.depth; z++) {
        for (var x = 0; x < this.width; x++) {
          var c = this.grid[y][z][x];
          if (c) cells.push({ x: x, y: y, z: z, color: c.color, garbage: !!c.garbage, owner: c.owner });
        }
      }
    }
    return {
      id: this.id,
      side: this.side,
      width: this.width,
      depth: this.depth,
      height: this.height,
      yaw: this.yaw,
      heightY: this.getHeight ? this.getHeight() : this.position.y,
      constructionHeight: this.constructionHeight,
      cells: cells
    };
  };

  Cup.prototype.applySnapshot = function (snap) {
    this.clearAll();
    if (!snap || !snap.cells) return;
    for (var i = 0; i < snap.cells.length; i++) {
      var c = snap.cells[i];
      this.placeCells([[c.x, c.y, c.z]], { color: c.color, garbage: c.garbage, owner: c.owner });
    }
    if (typeof snap.yaw === 'number') this.setYaw(snap.yaw);
    if (typeof snap.heightY === 'number' && this.setHeight) this.setHeight(snap.heightY);
  };

  Cup.prototype.applyTransform = function (t) {
    if (!t) return;
    if (typeof t.yaw === 'number') this.setYaw(t.yaw);
    if (typeof t.heightY === 'number' && this.setHeight) this.setHeight(t.heightY);
  };

  // Spawn garbage layer(s) from the bottom, pushing stack up.
  // holeSpecs: optional array of [{x,z}, ...] per layer for deterministic multiplayer.
  Cup.prototype.spawnGarbageLayers = function (count, holeCount, holeSpecs) {
    holeCount = holeCount == null ? 1 : holeCount;
    var results = [];
    for (var n = 0; n < count; n++) {
      // Shift everything up by 1
      for (var y = this.height - 1; y >= 1; y--) {
        for (var z = 0; z < this.depth; z++) {
          for (var x = 0; x < this.width; x++) {
            this.grid[y][z][x] = this.grid[y - 1][z][x];
            var cell = this.grid[y][z][x];
            if (cell && cell.mesh) cell.mesh.position.copy(this.cellCenterLocal(x, y, z));
          }
        }
      }
      // Clear bottom + fill garbage with holes
      var holes = {};
      var spec = holeSpecs && holeSpecs[n];
      if (spec && spec.length) {
        for (var hs = 0; hs < spec.length; hs++) {
          holes[spec[hs].x + ',' + spec[hs].z] = true;
        }
      } else {
        for (var h = 0; h < holeCount; h++) {
          var hx = Math.floor(Math.random() * this.width);
          var hz = Math.floor(Math.random() * this.depth);
          holes[hx + ',' + hz] = true;
        }
      }
      for (var z2 = 0; z2 < this.depth; z2++) {
        for (var x2 = 0; x2 < this.width; x2++) {
          if (holes[x2 + ',' + z2]) {
            this.grid[0][z2][x2] = null;
            continue;
          }
          var mesh = this._makeBlockMesh('#9E9E9E');
          mesh.position.copy(this.cellCenterLocal(x2, 0, z2));
          this.blocksRoot.add(mesh);
          this.grid[0][z2][x2] = { color: '#9E9E9E', owner: 'garbage', garbage: true, mesh: mesh };
        }
      }
      results.push(true);
    }
    this._recomputeHeight();
    return results;
  };

  global.StacksCup = Cup;
})(window);
