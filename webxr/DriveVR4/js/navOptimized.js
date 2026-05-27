/**
 * Sparse runtime nav — sorted cell-index arrays (no giant Map; avoids "Map maximum size exceeded").
 * Load DV2N fmt=2 directly, or convert dense fmt=1 after read.
 */

export function isSparseNavGrid(grid) {
    return !!(grid && grid.sparse);
}

export function navCellIndex(grid, ix, iz) {
    return iz * grid.gridW + ix;
}

function sortedIndexOf(sortedIdx, cellIdx) {
    var lo = 0;
    var hi = sortedIdx.length - 1;
    while (lo <= hi) {
        var mid = (lo + hi) >>> 1;
        var v = sortedIdx[mid];
        if (v === cellIdx) return mid;
        if (v < cellIdx) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}

function sortedInsertPos(sortedIdx, cellIdx) {
    var lo = 0;
    var hi = sortedIdx.length;
    while (lo < hi) {
        var mid = (lo + hi) >>> 1;
        if (sortedIdx[mid] < cellIdx) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function sparseWaterManualHas(grid, idx) {
    var m = grid.waterManual;
    if (!m) return false;
    if (m instanceof Set) return m.has(idx);
    return sortedIndexOf(m, idx) >= 0;
}

function sparseWaterManualAdd(grid, idx) {
    if (sparseWaterManualHas(grid, idx)) return;
    var m = grid.waterManual;
    if (!m || (m instanceof Set && m.size === 0)) {
        grid.waterManual = new Uint32Array([idx]);
        return;
    }
    if (m instanceof Set) {
        m.add(idx);
        return;
    }
    var arr = Array.from(m);
    arr.push(idx);
    arr.sort(function(a, b) { return a - b; });
    grid.waterManual = new Uint32Array(arr);
}

function sortSparseParallel(grid) {
    var n = grid.walkIdx.length;
    if (n > 1) {
        var order = new Uint32Array(n);
        for (var i = 0; i < n; i++) order[i] = i;
        order.sort(function(a, b) { return grid.walkIdx[a] - grid.walkIdx[b]; });
        var wIdx = new Uint32Array(n);
        var wY = new Float32Array(n);
        var wL = new Int32Array(n);
        for (var j = 0; j < n; j++) {
            var o = order[j];
            wIdx[j] = grid.walkIdx[o];
            wY[j] = grid.walkY[o];
            wL[j] = grid.walkLabel[o];
        }
        grid.walkIdx = wIdx;
        grid.walkY = wY;
        grid.walkLabel = wL;
    }
    var nw = grid.waterIdx.length;
    if (nw > 1) {
        var o2 = new Uint32Array(nw);
        for (var k = 0; k < nw; k++) o2[k] = k;
        o2.sort(function(a, b) { return grid.waterIdx[a] - grid.waterIdx[b]; });
        var wi = new Uint32Array(nw);
        var wy = new Float32Array(nw);
        for (var m = 0; m < nw; m++) {
            var p = o2[m];
            wi[m] = grid.waterIdx[p];
            wy[m] = grid.waterY[p];
        }
        grid.waterIdx = wi;
        grid.waterY = wy;
    }
    var ng = grid.greyIdx.length;
    if (ng > 1) {
        var gArr = Array.from(grid.greyIdx);
        gArr.sort(function(a, b) { return a - b; });
        grid.greyIdx = new Uint32Array(gArr);
    }
}

function finalizeSparseGrid(grid, walkIdx, walkY, walkLabel, waterIdx, waterY, greyIdx) {
    grid.walkIdx = new Uint32Array(walkIdx);
    grid.walkY = new Float32Array(walkY);
    if (walkLabel.length === walkIdx.length) {
        grid.walkLabel = new Int32Array(walkLabel);
    } else {
        grid.walkLabel = new Int32Array(walkIdx.length);
    }
    grid.waterIdx = new Uint32Array(waterIdx);
    grid.waterY = new Float32Array(waterY);
    grid.greyIdx = new Uint32Array(greyIdx);
    sortSparseParallel(grid);
    return grid;
}

function sparseWalkSlot(grid, cellIdx) {
    return sortedIndexOf(grid.walkIdx, cellIdx);
}

function sparseWaterSlot(grid, cellIdx) {
    return sortedIndexOf(grid.waterIdx, cellIdx);
}

function sparseGreySlot(grid, cellIdx) {
    return sortedIndexOf(grid.greyIdx, cellIdx);
}

export function navIsDrivableAt(grid, ix, iz) {
    if (ix < 0 || iz < 0 || ix >= grid.gridW || iz >= grid.gridH) return false;
    if (!grid.sparse) {
        var idx = navCellIndex(grid, ix, iz);
        if (!grid.walkable || !grid.walkable[idx]) return false;
        if (grid.water && grid.water[idx]) return false;
        return true;
    }
    var idx = navCellIndex(grid, ix, iz);
    return sparseWalkSlot(grid, idx) >= 0;
}

export function navGetCellFlags(grid, idx) {
    if (!grid.sparse) {
        return {
            walkable: !!(grid.walkable && grid.walkable[idx]),
            water: !!(grid.water && grid.water[idx]),
            waterSurface: !!(grid.water && grid.waterSurface[idx]),
            waterManual: !!(grid.waterManual && grid.waterManual[idx]),
            grey: !!(grid.landBase && grid.landBase[idx]),
            floorY: grid.floorY && isFinite(grid.floorY[idx]) ? grid.floorY[idx] : 0.35,
            label: grid.labels ? grid.labels[idx] : 0
        };
    }
    var ws = sparseWalkSlot(grid, idx);
    if (ws >= 0) {
        return {
            walkable: true,
            water: false,
            waterSurface: false,
            waterManual: sparseWaterManualHas(grid, idx),
            grey: false,
            floorY: grid.walkY[ws],
            label: grid.walkLabel[ws]
        };
    }
    var ts = sparseWaterSlot(grid, idx);
    if (ts >= 0) {
        return {
            walkable: false,
            water: true,
            waterSurface: true,
            waterManual: sparseWaterManualHas(grid, idx),
            grey: false,
            floorY: grid.waterY[ts],
            label: 0
        };
    }
    return {
        walkable: false,
        water: false,
        waterSurface: false,
        waterManual: false,
        grey: sparseGreySlot(grid, idx) >= 0,
        floorY: 0.35,
        label: 0
    };
}

export function navGetFloorYAt(grid, ix, iz) {
    var idx = navCellIndex(grid, ix, iz);
    return navGetCellFlags(grid, idx).floorY;
}

function createEmptySparseGrid(gridW, gridH, cellSize, minX, minZ, largestComponentId) {
    return {
        sparse: true,
        gridW: gridW,
        gridH: gridH,
        cellSize: cellSize,
        minX: minX,
        minZ: minZ,
        largestComponentId: largestComponentId | 0,
        walkIdx: new Uint32Array(0),
        walkY: new Float32Array(0),
        walkLabel: new Int32Array(0),
        waterIdx: new Uint32Array(0),
        waterY: new Float32Array(0),
        greyIdx: new Uint32Array(0),
        waterManual: new Uint32Array(0)
    };
}

/** Parse DV2N fmt=2 body into sparse runtime (sorted arrays). */
export function parseCompactDv2nToSparseGrid(dv, o, gridW, gridH, cellSize, minX, minZ, largestComponentId) {
    var grid = createEmptySparseGrid(gridW, gridH, cellSize, minX, minZ, largestComponentId);
    var walkIdx = [];
    var walkY = [];
    var walkN = dv.getUint32(o, true); o += 4;
    for (var wi = 0; wi < walkN; wi++) {
        walkIdx.push(dv.getUint32(o, true)); o += 4;
        walkY.push(dv.getFloat32(o, true)); o += 4;
    }
    var waterIdx = [];
    var waterY = [];
    var waterN = dv.getUint32(o, true); o += 4;
    for (var si = 0; si < waterN; si++) {
        waterIdx.push(dv.getUint32(o, true)); o += 4;
        waterY.push(dv.getFloat32(o, true)); o += 4;
    }
    var greyIdx = [];
    var greyN = dv.getUint32(o, true); o += 4;
    for (var gi = 0; gi < greyN; gi++) {
        greyIdx.push(dv.getUint32(o, true)); o += 4;
    }
    finalizeSparseGrid(grid, walkIdx, walkY, [], waterIdx, waterY, greyIdx);
    labelSparseNavComponents(grid);
    return grid;
}

/** Convert dense bake arrays to sparse runtime (releases dense arrays). */
export function optimizeDenseBuildObject(b, minGroundY) {
    if (b.sparse) return b;
    var w = b.gridW | 0;
    var h = b.gridH | 0;
    var total = w * h;
    var minY = (minGroundY != null ? minGroundY : -4) - 0.5;

    var walkIdx = [];
    var walkY = [];
    var walkLabel = [];
    var waterIdx = [];
    var waterY = [];
    var greyIdx = [];

    var walk = b.walkable;
    var water = b.water;
    var landBase = b.landBase;
    var floorY = b.floorY;
    var labels = b.labels;
    var waterManual = b.waterManual;

    for (var i = 0; i < total; i++) {
        if (walk && walk[i] && !(water && water[i])) {
            walkIdx.push(i);
            walkY.push(floorY ? floorY[i] : 0.35);
            walkLabel.push(labels ? labels[i] : 0);
        } else if (water && water[i]) {
            waterIdx.push(i);
            waterY.push(floorY ? floorY[i] : 0.35);
        } else {
            var grey = landBase && landBase[i];
            if (!grey && floorY && floorY[i] > minY) grey = true;
            if (grey) greyIdx.push(i);
        }
    }

    var grid = createEmptySparseGrid(w, h, b.cellSize, b.minX, b.minZ, b.largestComponentId | 0);
    if (waterManual) {
        var manualIdx = [];
        for (var mi = 0; mi < total; mi++) {
            if (waterManual[mi]) manualIdx.push(mi);
        }
        if (manualIdx.length) grid.waterManual = new Uint32Array(manualIdx);
    }
    finalizeSparseGrid(grid, walkIdx, walkY, walkLabel, waterIdx, waterY, greyIdx);
    if (!grid.largestComponentId) {
        labelSparseNavComponents(grid);
    }

    b.sparse = true;
    b.gridW = grid.gridW;
    b.gridH = grid.gridH;
    b.cellSize = grid.cellSize;
    b.minX = grid.minX;
    b.minZ = grid.minZ;
    b.largestComponentId = grid.largestComponentId;
    b.walkIdx = grid.walkIdx;
    b.walkY = grid.walkY;
    b.walkLabel = grid.walkLabel;
    b.waterIdx = grid.waterIdx;
    b.waterY = grid.waterY;
    b.greyIdx = grid.greyIdx;
    b.waterManual = grid.waterManual;
    b.walkable = null;
    b.waterSurface = null;
    b.floorY = null;
    b.floorNy = null;
    b.labels = null;
    b.landBase = null;

    return b;
}

export function labelSparseNavComponents(grid) {
    var w = grid.gridW;
    var h = grid.gridH;
    var n = grid.walkIdx.length;
    var compId = 0;
    var sizes = [];
    var stack = [];

    for (var i = 0; i < n; i++) {
        grid.walkLabel[i] = 0;
    }

    function flood(startSlot) {
        stack.length = 0;
        stack.push(startSlot);
        grid.walkLabel[startSlot] = compId;
        var size = 0;
        while (stack.length) {
            var slot = stack.pop();
            size++;
            var idx = grid.walkIdx[slot];
            var ix = idx % w;
            var iz = (idx / w) | 0;
            var neighbors = [
                ix > 0 ? idx - 1 : -1,
                ix < w - 1 ? idx + 1 : -1,
                iz > 0 ? idx - w : -1,
                iz < h - 1 ? idx + w : -1
            ];
            for (var ni = 0; ni < neighbors.length; ni++) {
                var nidx = neighbors[ni];
                if (nidx < 0) continue;
                var ns = sparseWalkSlot(grid, nidx);
                if (ns < 0 || grid.walkLabel[ns]) continue;
                grid.walkLabel[ns] = compId;
                stack.push(ns);
            }
        }
        return size;
    }

    for (var si = 0; si < n; si++) {
        if (grid.walkLabel[si]) continue;
        compId++;
        sizes.push(flood(si));
    }

    var largestId = 0;
    var largestSize = 0;
    for (var ci = 1; ci <= compId; ci++) {
        if (sizes[ci - 1] > largestSize) {
            largestSize = sizes[ci - 1];
            largestId = ci;
        }
    }
    grid.largestComponentId = largestId;
}

export function sparseSetWaterCell(grid, idx, floorY, manual) {
    var ws = sparseWalkSlot(grid, idx);
    if (ws >= 0) {
        removeWalkSlot(grid, ws);
    }
    insertWaterCell(grid, idx, floorY);
    if (manual) sparseWaterManualAdd(grid, idx);
}

export function sparseSetLandCell(grid, idx, floorY, manual) {
    var ts = sparseWaterSlot(grid, idx);
    if (ts >= 0) {
        removeWaterSlot(grid, ts);
    }
    insertWalkCell(grid, idx, floorY, 0);
    if (manual) sparseWaterManualAdd(grid, idx);
}

function insertWalkCell(grid, idx, floorY, label) {
    var slot = sortedIndexOf(grid.walkIdx, idx);
    if (slot >= 0) {
        grid.walkY[slot] = floorY;
        grid.walkLabel[slot] = label;
        return;
    }
    slot = sortedInsertPos(grid.walkIdx, idx);
    var w0 = grid.walkIdx.slice(0, slot);
    var w1 = grid.walkIdx.slice(slot);
    grid.walkIdx = new Uint32Array(w0.length + 1 + w1.length);
    grid.walkIdx.set(w0, 0);
    grid.walkIdx[w0.length] = idx;
    grid.walkIdx.set(w1, w0.length + 1);
    var y0 = Array.from(grid.walkY.slice(0, slot));
    var y1 = Array.from(grid.walkY.slice(slot));
    y0.splice(slot, 0, floorY);
    grid.walkY = new Float32Array(y0.concat(y1));
    var l0 = Array.from(grid.walkLabel.slice(0, slot));
    var l1 = Array.from(grid.walkLabel.slice(slot));
    l0.splice(slot, 0, label);
    grid.walkLabel = new Int32Array(l0.concat(l1));
}

function removeWalkSlot(grid, slot) {
    var w0 = grid.walkIdx.slice(0, slot);
    var w1 = grid.walkIdx.slice(slot + 1);
    grid.walkIdx = new Uint32Array(w0.length + w1.length);
    grid.walkIdx.set(w0, 0);
    grid.walkIdx.set(w1, w0.length);
    var yArr = [];
    var lArr = [];
    for (var i = 0; i < grid.walkIdx.length; i++) {
        var s = i < slot ? i : i + 1;
        yArr.push(grid.walkY[s]);
        lArr.push(grid.walkLabel[s]);
    }
    grid.walkY = new Float32Array(yArr);
    grid.walkLabel = new Int32Array(lArr);
}

function insertWaterCell(grid, idx, floorY) {
    var slot = sortedIndexOf(grid.waterIdx, idx);
    if (slot >= 0) {
        grid.waterY[slot] = floorY;
        return;
    }
    slot = sortedInsertPos(grid.waterIdx, idx);
    var a0 = grid.waterIdx.slice(0, slot);
    var a1 = grid.waterIdx.slice(slot);
    grid.waterIdx = new Uint32Array(a0.length + 1 + a1.length);
    grid.waterIdx.set(a0, 0);
    grid.waterIdx[a0.length] = idx;
    grid.waterIdx.set(a1, a0.length + 1);
    var y0 = Array.from(grid.waterY.slice(0, slot));
    var y1 = Array.from(grid.waterY.slice(slot));
    y0.splice(slot, 0, floorY);
    grid.waterY = new Float32Array(y0.concat(y1));
}

function removeWaterSlot(grid, slot) {
    var a0 = grid.waterIdx.slice(0, slot);
    var a1 = grid.waterIdx.slice(slot + 1);
    grid.waterIdx = new Uint32Array(a0.length + a1.length);
    grid.waterIdx.set(a0, 0);
    grid.waterIdx.set(a1, a0.length);
    var yArr = [];
    for (var i = 0; i < grid.waterIdx.length; i++) {
        yArr.push(grid.waterY[i < slot ? i : i + 1]);
    }
    grid.waterY = new Float32Array(yArr);
}

export function paintNavMapPixels(px, grid, minGroundY) {
    var w = grid.gridW;
    var mainId = grid.largestComponentId;
    var minY = (minGroundY != null ? minGroundY : -4) - 0.5;

    for (var i = 0; i < px.length; i += 4) {
        px[i + 3] = 0;
    }

    if (!grid.sparse) {
        var walk = grid.walkable;
        var labels = grid.labels;
        var water = grid.water;
        var landBase = grid.landBase;
        var floorY = grid.floorY;
        for (var iz = 0; iz < grid.gridH; iz++) {
            for (var ix = 0; ix < w; ix++) {
                var idx = iz * w + ix;
                var p = idx * 4;
                if (water && water[idx]) {
                    px[p] = 50; px[p + 1] = 140; px[p + 2] = 255; px[p + 3] = 170;
                    continue;
                }
                var isLandBase = landBase && landBase[idx];
                if (!isLandBase && floorY && floorY[idx] > minY && !walk[idx]) {
                    isLandBase = true;
                }
                if (isLandBase && !walk[idx]) {
                    px[p] = 120; px[p + 1] = 125; px[p + 2] = 135; px[p + 3] = 200;
                    continue;
                }
                if (!walk[idx]) continue;
                var isMain = !mainId || labels[idx] === mainId;
                if (isMain) {
                    px[p] = 0; px[p + 1] = 255; px[p + 2] = 110; px[p + 3] = 150;
                } else {
                    px[p] = 170; px[p + 1] = 210; px[p + 2] = 70; px[p + 3] = 90;
                }
            }
        }
        return;
    }

    function stamp(ix, iz, r, g, b, a) {
        if (ix < 0 || iz < 0 || ix >= w || iz >= grid.gridH) return;
        var p = (iz * w + ix) * 4;
        px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = a;
    }

    for (var gi = 0; gi < grid.greyIdx.length; gi++) {
        var gidx = grid.greyIdx[gi];
        stamp(gidx % w, (gidx / w) | 0, 120, 125, 135, 200);
    }
    for (var si = 0; si < grid.waterIdx.length; si++) {
        var sidx = grid.waterIdx[si];
        stamp(sidx % w, (sidx / w) | 0, 50, 140, 255, 170);
    }
    for (var wi = 0; wi < grid.walkIdx.length; wi++) {
        var widx = grid.walkIdx[wi];
        var isMain = !mainId || grid.walkLabel[wi] === mainId;
        if (isMain) {
            stamp(widx % w, (widx / w) | 0, 0, 255, 110, 150);
        } else {
            stamp(widx % w, (widx / w) | 0, 170, 210, 70, 90);
        }
    }
}

export function findCityNavPathWorldSparse(grid, startX, startZ, goalX, goalZ, helpers) {
    var findNearest = helpers.findNearestDrivableNavCell;
    var cellCenter = helpers.navCellCenterWorld;
    var simplify = helpers.simplifyCityNavPathPoints;
    var margin = helpers.applyCityNavPathMargin;

    var startIx = Math.floor((startX - grid.minX) / grid.cellSize);
    var startIz = Math.floor((startZ - grid.minZ) / grid.cellSize);
    var goalIx = Math.floor((goalX - grid.minX) / grid.cellSize);
    var goalIz = Math.floor((goalZ - grid.minZ) / grid.cellSize);
    var startCell = findNearest(grid, startIx, startIz, 40);
    var goalCell = findNearest(grid, goalIx, goalIz, 40);
    if (!startCell || !goalCell) return null;

    var w = grid.gridW;
    var startIdx = startCell.iz * w + startCell.ix;
    var goalIdx = goalCell.iz * w + goalCell.ix;
    if (startIdx === goalIdx) {
        return margin([cellCenter(grid, startCell.ix, startCell.iz)], grid);
    }

    var gScore = new Map();
    var fScore = new Map();
    var cameFrom = new Map();
    var closed = new Set();

    function heuristic(ix, iz) {
        var dx = Math.abs(ix - goalCell.ix);
        var dz = Math.abs(iz - goalCell.iz);
        var m = Math.min(dx, dz);
        return (dx + dz) + (1.41421356 - 2) * m;
    }

    gScore.set(startIdx, 0);
    fScore.set(startIdx, heuristic(startCell.ix, startCell.iz));
    var open = [startIdx];
    var neighbors = [
        [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
        [1, 1, 1.41421356], [1, -1, 1.41421356], [-1, 1, 1.41421356], [-1, -1, 1.41421356]
    ];

    while (open.length) {
        var bestOi = 0;
        var bestF = fScore.get(open[0]) ?? Infinity;
        for (var oi = 1; oi < open.length; oi++) {
            var f = fScore.get(open[oi]) ?? Infinity;
            if (f < bestF) {
                bestF = f;
                bestOi = oi;
            }
        }
        var current = open[bestOi];
        open[bestOi] = open[open.length - 1];
        open.pop();

        if (current === goalIdx) {
            var pathCells = [];
            var cur = current;
            while (true) {
                pathCells.push({ ix: cur % w, iz: (cur / w) | 0 });
                if (cur === startIdx) break;
                cur = cameFrom.get(cur);
            }
            pathCells.reverse();
            var worldPts = [];
            for (var pi = 0; pi < pathCells.length; pi++) {
                worldPts.push(cellCenter(grid, pathCells[pi].ix, pathCells[pi].iz));
            }
            return margin(simplify(worldPts), grid);
        }

        closed.add(current);
        var cix = current % w;
        var ciz = (current / w) | 0;

        for (var ni = 0; ni < neighbors.length; ni++) {
            var ndx = neighbors[ni][0];
            var ndz = neighbors[ni][1];
            var nx = cix + ndx;
            var nz = ciz + ndz;
            if (!navIsDrivableAt(grid, nx, nz)) continue;
            if (ndx !== 0 && ndz !== 0) {
                if (!navIsDrivableAt(grid, cix + ndx, ciz) ||
                    !navIsDrivableAt(grid, cix, ciz + ndz)) {
                    continue;
                }
            }
            var nidx = nz * w + nx;
            if (closed.has(nidx)) continue;
            var tentative = (gScore.get(current) ?? Infinity) + neighbors[ni][2];
            var prevG = gScore.get(nidx);
            var inOpen = open.indexOf(nidx);
            if (prevG != null && tentative >= prevG && inOpen >= 0) continue;
            cameFrom.set(nidx, current);
            gScore.set(nidx, tentative);
            fScore.set(nidx, tentative + heuristic(nx, nz));
            if (inOpen < 0) open.push(nidx);
        }
    }
    return null;
}

export function packSparseGridToCompactBinary(grid, cacheKey) {
    var enc = new TextEncoder();
    var keyBytes = enc.encode(cacheKey || '');
    var oBeforeKey = 10;
    var keyPad = (4 - ((oBeforeKey + keyBytes.length) % 4)) % 4;
    var bodyBytes = grid.walkIdx.length * 8 + grid.waterIdx.length * 8 + grid.greyIdx.length * 4 + 12;
    var headerBytes = oBeforeKey + keyBytes.length + keyPad + 6 * 4 + 12;
    var totalBytes = headerBytes + bodyBytes;
    var out = new ArrayBuffer(totalBytes);
    var dv = new DataView(out);
    var u8 = new Uint8Array(out);
    var o = 0;
    u8[o++] = 0x44; u8[o++] = 0x56; u8[o++] = 0x32; u8[o++] = 0x4e;
    dv.setUint32(o, 2, true); o += 4;
    dv.setUint16(o, keyBytes.length, true); o += 2;
    u8.set(keyBytes, o); o += keyBytes.length;
    while (o % 4 !== 0) { u8[o++] = 0; }
    dv.setUint32(o, grid.gridW, true); o += 4;
    dv.setUint32(o, grid.gridH, true); o += 4;
    dv.setFloat32(o, grid.cellSize, true); o += 4;
    dv.setFloat32(o, grid.minX, true); o += 4;
    dv.setFloat32(o, grid.minZ, true); o += 4;
    dv.setInt32(o, grid.largestComponentId | 0, true); o += 4;
    dv.setUint32(o, grid.walkIdx.length, true); o += 4;
    for (var wi = 0; wi < grid.walkIdx.length; wi++) {
        dv.setUint32(o, grid.walkIdx[wi], true); o += 4;
        dv.setFloat32(o, grid.walkY[wi], true); o += 4;
    }
    dv.setUint32(o, grid.waterIdx.length, true); o += 4;
    for (var si = 0; si < grid.waterIdx.length; si++) {
        dv.setUint32(o, grid.waterIdx[si], true); o += 4;
        dv.setFloat32(o, grid.waterY[si], true); o += 4;
    }
    dv.setUint32(o, grid.greyIdx.length, true); o += 4;
    for (var gi = 0; gi < grid.greyIdx.length; gi++) {
        dv.setUint32(o, grid.greyIdx[gi], true); o += 4;
    }
    return out;
}

export function sparseNavStats(grid) {
    if (!grid.sparse) return null;
    return {
        drivable: grid.walkIdx.length,
        water: grid.waterIdx.length,
        grey: grid.greyIdx.length,
        cells: grid.gridW * grid.gridH
    };
}
