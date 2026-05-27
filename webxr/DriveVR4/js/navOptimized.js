/**
 * Sparse runtime nav — sorted cell-index arrays + DV2N fmt=4 (varint walk, water bitmap, gzip).
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

function navIsWaterAt(grid, idx) {
    if (grid.waterBitmap) {
        var b = grid.waterBitmap[idx >> 3];
        return ((b >> (idx & 7)) & 1) !== 0;
    }
    return sparseWaterSlot(grid, idx) >= 0;
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
    if (grid.waterIdx && grid.waterIdx.length > 1) {
        var nw = grid.waterIdx.length;
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
    if (grid.greyIdx && grid.greyIdx.length > 1) {
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
    grid.waterIdx = new Uint32Array(waterIdx || []);
    grid.waterY = new Float32Array(waterY || []);
    grid.greyIdx = new Uint32Array(greyIdx || []);
    sortSparseParallel(grid);
    return grid;
}

function sparseWalkSlot(grid, cellIdx) {
    return sortedIndexOf(grid.walkIdx, cellIdx);
}

function sparseWaterSlot(grid, cellIdx) {
    if (grid.waterBitmap) return navIsWaterAt(grid, cellIdx) ? 0 : -1;
    return sortedIndexOf(grid.waterIdx, cellIdx);
}

function sparseGreySlot(grid, cellIdx) {
    return sortedIndexOf(grid.greyIdx, cellIdx);
}

/** Build 1-bit-per-cell water mask (~gridCells/8 bytes vs millions of uint32+float pairs). */
export function buildWaterBitmapFromSparse(grid) {
    var total = grid.gridW * grid.gridH;
    var bytes = (total + 7) >>> 3;
    var bm = new Uint8Array(bytes);
    var list = grid.waterIdx;
    for (var i = 0; i < list.length; i++) {
        var idx = list[i];
        bm[idx >> 3] |= 1 << (idx & 7);
    }
    return bm;
}

/** Drop waterIdx after bitmap is built (saves RAM). */
export function attachWaterBitmap(grid) {
    if (!grid.waterIdx || !grid.waterIdx.length) {
        grid.waterBitmap = new Uint8Array(((grid.gridW * grid.gridH) + 7) >>> 3);
        grid.waterIdx = new Uint32Array(0);
        grid.waterY = new Float32Array(0);
        return grid;
    }
    grid.waterBitmap = buildWaterBitmapFromSparse(grid);
    grid.waterIdx = new Uint32Array(0);
    grid.waterY = new Float32Array(0);
    return grid;
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
    if (sparseWalkSlot(grid, idx) < 0) return false;
    return !navIsWaterAt(grid, idx);
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
    if (navIsWaterAt(grid, idx)) {
        return {
            walkable: false,
            water: true,
            waterSurface: true,
            waterManual: sparseWaterManualHas(grid, idx),
            grey: false,
            floorY: 0.35,
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
        waterBitmap: null,
        greyIdx: new Uint32Array(0),
        waterManual: new Uint32Array(0)
    };
}

function writeVarintU32(buf, o, n) {
    n = n >>> 0;
    while (n >= 0x80) {
        buf[o++] = (n & 0x7f) | 0x80;
        n >>>= 7;
    }
    buf[o++] = n;
    return o;
}

function readVarintU32(u8, state) {
    var shift = 0;
    var result = 0;
    while (true) {
        if (state.o >= u8.length) throw new Error('varint truncated');
        var b = u8[state.o++];
        result |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
        if (shift > 28) throw new Error('varint too large');
    }
    return result >>> 0;
}

function encodeWalkVarintBody(walkIdx) {
    var n = walkIdx.length;
    if (!n) return new Uint8Array(8);
    var buf = new Uint8Array(4 + n * 6);
    var dv = new DataView(buf.buffer);
    var o = 0;
    dv.setUint32(o, walkIdx[0], true);
    o = 4;
    for (var i = 1; i < n; i++) {
        o = writeVarintU32(buf, o, walkIdx[i] - walkIdx[i - 1]);
    }
    return buf.subarray(0, o);
}

function decodeWalkVarintBody(u8, walkN) {
    var state = { o: 0 };
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var first = dv.getUint32(state.o, true);
    state.o = 4;
    var walkIdx = new Uint32Array(walkN);
    var walkY = new Float32Array(walkN);
    walkIdx[0] = first;
    for (var i = 1; i < walkN; i++) {
        walkIdx[i] = walkIdx[i - 1] + readVarintU32(u8, state);
    }
    return { walkIdx: walkIdx, walkY: walkY, nextOffset: state.o };
}

function validateFmt4Counts(walkN, gridW, gridH, bmLen) {
    var total = (gridW | 0) * (gridH | 0);
    if (!total || walkN < 0 || walkN > total || walkN > 30000000) {
        throw new Error('nav fmt=4 bad walk count ' + walkN + ' for ' + gridW + '×' + gridH);
    }
    var expectBm = (total + 7) >>> 3;
    if (bmLen < 0 || bmLen > expectBm + 8) {
        throw new Error('nav fmt=4 bad water bitmap size ' + bmLen + ' (expected ~' + expectBm + ')');
    }
}

/** Fast path: walkN + uint32[walkN] + int16[walkN] + bitmap (no per-cell varint loop). */
function decodeFmt4WalkFlat(u8, walkN, gridW, gridH) {
    var o = 0;
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var walkNRead = dv.getUint32(o, true); o += 4;
    if (walkNRead !== walkN) walkN = walkNRead;
    validateFmt4Counts(walkN, gridW, gridH, 0);
    var walkBytes = walkN * 4;
    if (o + walkBytes + walkN * 2 + 4 > u8.length) {
        throw new Error('nav fmt=4 flat payload truncated');
    }
    var walkIdx = new Uint32Array(walkN);
    var walkOff = u8.byteOffset + o;
    if ((walkOff & 3) === 0) {
        walkIdx.set(new Uint32Array(u8.buffer, walkOff, walkN));
    } else {
        walkIdx.set(new Uint32Array(u8.slice(o, o + walkBytes).buffer));
    }
    o += walkBytes;
    var walkY = new Float32Array(walkN);
    for (var yi = 0; yi < walkN; yi++) {
        walkY[yi] = dv.getInt16(o, true) / 20;
        o += 2;
    }
    var bmLen = dv.getUint32(o, true); o += 4;
    validateFmt4Counts(walkN, gridW, gridH, bmLen);
    return { walkIdx: walkIdx, walkY: walkY, nextOffset: o, bmLen: bmLen };
}

function expectedFmt4FlatPayloadBytes(walkN, gridW, gridH) {
    var bmLen = ((gridW * gridH) + 7) >>> 3;
    return 4 + walkN * 6 + 4 + bmLen;
}

function buildFmt4Payload(grid, opts) {
    opts = opts || {};
    var walkIdx = grid.walkIdx;
    var walkY = grid.walkY;
    var mainId = grid.largestComponentId | 0;
    if (opts.mainComponentOnly && mainId > 0 && grid.walkLabel && grid.walkLabel.length) {
        var fIdx = [];
        var fY = [];
        var fL = [];
        for (var fi = 0; fi < walkIdx.length; fi++) {
            if (grid.walkLabel[fi] === mainId) {
                fIdx.push(walkIdx[fi]);
                fY.push(walkY[fi]);
                fL.push(grid.walkLabel[fi]);
            }
        }
        walkIdx = new Uint32Array(fIdx);
        walkY = new Float32Array(fY);
        grid = Object.assign({}, grid, {
            walkIdx: walkIdx,
            walkY: walkY,
            walkLabel: new Int32Array(fL)
        });
    }

    var waterBm = grid.waterBitmap;
    if (!waterBm) {
        waterBm = buildWaterBitmapFromSparse(grid);
    }

    var walkN = walkIdx.length;
    var yQm = new Int16Array(walkN);
    for (var yi = 0; yi < walkN; yi++) {
        var q = Math.round(walkY[yi] * 20);
        if (q > 32767) q = 32767;
        if (q < -32768) q = -32768;
        yQm[yi] = q;
    }

    var headerLen = 4 + walkN * 4 + walkN * 2 + 4 + waterBm.byteLength;
    var payload = new Uint8Array(headerLen);
    var dv = new DataView(payload.buffer);
    var o = 0;
    dv.setUint32(o, walkN, true); o += 4;
    for (var wi = 0; wi < walkN; wi++) {
        dv.setUint32(o, walkIdx[wi], true); o += 4;
    }
    for (var yj = 0; yj < walkN; yj++) {
        dv.setInt16(o, yQm[yj], true);
        o += 2;
    }
    dv.setUint32(o, waterBm.byteLength, true); o += 4;
    payload.set(waterBm, o);
    return payload;
}

async function gzipBuffer(buf) {
    if (typeof CompressionStream === 'undefined') {
        return buf;
    }
    var stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'));
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
}

async function gunzipBuffer(buf) {
    if (typeof DecompressionStream === 'undefined') {
        throw new Error('nav fmt=4 needs gzip (Chrome/Edge 80+ or Firefox 113+)');
    }
    if (!buf.length || buf[0] !== 0x1f || buf[1] !== 0x8b) {
        throw new Error('nav fmt=4 gzip payload missing (bad header bytes)');
    }
    var stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    var ab = await new Response(stream).arrayBuffer();
    var out = new Uint8Array(ab);
    if (out.length < 16) {
        throw new Error('nav fmt=4 gzip decompress produced empty payload');
    }
    return out;
}

function writeDv2nHeader(dv, u8, o, fmt, keyBytes, grid) {
    u8[o++] = 0x44; u8[o++] = 0x56; u8[o++] = 0x32; u8[o++] = 0x4e;
    dv.setUint32(o, fmt, true); o += 4;
    dv.setUint16(o, keyBytes.length, true); o += 2;
    u8.set(keyBytes, o); o += keyBytes.length;
    while (o % 4 !== 0) { u8[o++] = 0; }
    dv.setUint32(o, grid.gridW, true); o += 4;
    dv.setUint32(o, grid.gridH, true); o += 4;
    dv.setFloat32(o, grid.cellSize, true); o += 4;
    dv.setFloat32(o, grid.minX, true); o += 4;
    dv.setFloat32(o, grid.minZ, true); o += 4;
    dv.setInt32(o, grid.largestComponentId | 0, true); o += 4;
    return o;
}

/**
 * DV2N fmt=4: gzip(uint32 walk idx + int16 Y + water bitmap). ~20–30 MB gzip for VRrunner city.
 */
export async function packSparseGridToOptimizedBinary(grid, cacheKey, opts) {
    opts = opts || {};
    var payload = buildFmt4Payload(grid, opts);
    var compressed = await gzipBuffer(payload);
    var enc = new TextEncoder();
    var keyBytes = enc.encode(cacheKey || '');
    var oBeforeKey = 10;
    var keyPad = (4 - ((oBeforeKey + keyBytes.length) % 4)) % 4;
    var headerBytes = oBeforeKey + keyBytes.length + keyPad + 6 * 4 + 8;
    var out = new Uint8Array(headerBytes + compressed.byteLength);
    var dv = new DataView(out.buffer);
    var o = writeDv2nHeader(dv, out, 0, 4, keyBytes, grid);
    dv.setUint32(o, payload.byteLength, true); o += 4;
    dv.setUint32(o, compressed.byteLength, true); o += 4;
    out.set(compressed, o);
    return out.buffer;
}

/** Sync fmt=4 without gzip (still ~75 MB vs 369 MB). */
export function packSparseGridToOptimizedBinarySync(grid, cacheKey, opts) {
    var payload = buildFmt4Payload(grid, opts || {});
    var enc = new TextEncoder();
    var keyBytes = enc.encode(cacheKey || '');
    var oBeforeKey = 10;
    var keyPad = (4 - ((oBeforeKey + keyBytes.length) % 4)) % 4;
    var headerBytes = oBeforeKey + keyBytes.length + keyPad + 6 * 4 + 4;
    var out = new Uint8Array(headerBytes + payload.byteLength);
    var dv = new DataView(out.buffer);
    var o = writeDv2nHeader(dv, out, 0, 4, keyBytes, grid);
    dv.setUint32(o, payload.byteLength, true); o += 4;
    out.set(payload, o);
    return out.buffer;
}

function applyBundledWalkLabels(grid, largestComponentId) {
    var n = grid.walkIdx.length;
    grid.walkLabel = new Int32Array(n);
    var mainId = largestComponentId | 0;
    if (mainId > 0) {
        for (var i = 0; i < n; i++) grid.walkLabel[i] = mainId;
    }
}

export async function parseOptimizedDv4Body(buf, gridW, gridH, cellSize, minX, minZ, largestComponentId) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (u8.length < 12) throw new Error('nav fmt=4 payload too small');
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var walkN = dv.getUint32(0, true);
    validateFmt4Counts(walkN, gridW, gridH, 0);

    var decoded;
    var flatNeed = expectedFmt4FlatPayloadBytes(walkN, gridW, gridH);
    if (u8.length >= flatNeed - 8 && u8.length <= flatNeed + 8) {
        decoded = decodeFmt4WalkFlat(u8, walkN, gridW, gridH);
    } else {
        decoded = decodeWalkVarintBody(u8.subarray(4), walkN);
        var o = 4 + decoded.nextOffset;
        for (var yi = 0; yi < walkN; yi++) {
            decoded.walkY[yi] = dv.getInt16(o, true) / 20;
            o += 2;
        }
        decoded.bmLen = dv.getUint32(o, true);
        decoded.nextOffset = o + 4;
        validateFmt4Counts(walkN, gridW, gridH, decoded.bmLen);
    }

    var o = decoded.nextOffset;
    var bmLen = decoded.bmLen != null ? decoded.bmLen : dv.getUint32(o, true);
    if (decoded.bmLen == null) o += 4;
    if (o + bmLen > u8.length) {
        throw new Error('nav fmt=4 water bitmap truncated');
    }
    var waterBitmap = u8.subarray(o, o + bmLen);

    var grid = createEmptySparseGrid(gridW, gridH, cellSize, minX, minZ, largestComponentId);
    grid.walkIdx = decoded.walkIdx;
    grid.walkY = decoded.walkY;
    grid.waterBitmap = new Uint8Array(waterBitmap);
    grid.waterIdx = new Uint32Array(0);
    grid.waterY = new Float32Array(0);
    applyBundledWalkLabels(grid, largestComponentId);
    return grid;
}

export async function parseOptimizedDv4FromBuffer(buf, keyFromHeader) {
    var u8 = new Uint8Array(buf);
    var dv = new DataView(buf);
    var o = 4;
    var fmt = dv.getUint32(o, true); o += 4;
    if (fmt !== 4) throw new Error('expected fmt=4');
    var keyLen = dv.getUint16(o, true); o += 2;
    var key = keyFromHeader || new TextDecoder().decode(u8.subarray(o, o + keyLen));
    o += keyLen;
    while (o % 4 !== 0) { o++; }
    var gridW = dv.getUint32(o, true); o += 4;
    var gridH = dv.getUint32(o, true); o += 4;
    var cellSize = dv.getFloat32(o, true); o += 4;
    var minX = dv.getFloat32(o, true); o += 4;
    var minZ = dv.getFloat32(o, true); o += 4;
    var largestComponentId = dv.getInt32(o, true); o += 4;
    var rawLen = dv.getUint32(o, true); o += 4;
    var compLen = dv.getUint32(o, true); o += 4;
    var comp = u8.subarray(o, o + compLen);
    var payload;
    if (compLen > 0 && compLen < rawLen) {
        payload = await gunzipBuffer(comp);
        if (payload.length !== rawLen && Math.abs(payload.length - rawLen) > 64) {
            console.warn('🗺️ nav fmt=4 gzip size', payload.length, 'expected', rawLen);
        }
    } else if (compLen === 0 && rawLen > 0) {
        payload = u8.subarray(o, o + rawLen);
    } else {
        throw new Error('nav fmt=4 bad lengths raw=' + rawLen + ' comp=' + compLen);
    }
    var grid = await parseOptimizedDv4Body(payload, gridW, gridH, cellSize, minX, minZ, largestComponentId);
    return { key: key, b: grid };
}

/** Parse DV2N fmt=2/3 sparse body into runtime grids. */
export function parseCompactDv2nToSparseGrid(dv, o, gridW, gridH, cellSize, minX, minZ, largestComponentId, includeGrey) {
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
    if (includeGrey !== false) {
        var greyN = dv.getUint32(o, true); o += 4;
        for (var gi = 0; gi < greyN; gi++) {
            greyIdx.push(dv.getUint32(o, true)); o += 4;
        }
    }
    finalizeSparseGrid(grid, walkIdx, walkY, [], waterIdx, waterY, greyIdx);
    attachWaterBitmap(grid);
    if (largestComponentId > 0) {
        applyBundledWalkLabels(grid, largestComponentId);
    } else {
        labelSparseNavComponents(grid);
    }
    return grid;
}

/** Convert dense bake arrays to sparse runtime (releases dense arrays). */
export function optimizeDenseBuildObject(b, minGroundY) {
    if (b.sparse) return b;
    var w = b.gridW | 0;
    var h = b.gridH | 0;
    var total = w * h;

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
        } else if (landBase && landBase[i]) {
            greyIdx.push(i);
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
    attachWaterBitmap(grid);
    if (!grid.largestComponentId) {
        labelSparseNavComponents(grid);
    } else {
        applyBundledWalkLabels(grid, grid.largestComponentId);
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
    b.waterBitmap = grid.waterBitmap;
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
    if (!grid.waterBitmap) {
        insertWaterCell(grid, idx, floorY);
    } else {
        grid.waterBitmap[idx >> 3] |= 1 << (idx & 7);
    }
    if (manual) sparseWaterManualAdd(grid, idx);
}

export function sparseSetLandCell(grid, idx, floorY, manual) {
    if (grid.waterBitmap) {
        grid.waterBitmap[idx >> 3] &= ~(1 << (idx & 7));
    } else {
        var ts = sparseWaterSlot(grid, idx);
        if (ts >= 0) removeWaterSlot(grid, ts);
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

    if (grid.waterBitmap) {
        var bm = grid.waterBitmap;
        for (var bi = 0; bi < bm.length; bi++) {
            var byte = bm[bi];
            if (!byte) continue;
            for (var bit = 0; bit < 8; bit++) {
                if ((byte >> bit) & 1) {
                    var idx = (bi << 3) | bit;
                    stamp(idx % w, (idx / w) | 0, 50, 140, 255, 170);
                }
            }
        }
    } else {
        for (var si = 0; si < grid.waterIdx.length; si++) {
            var sidx = grid.waterIdx[si];
            stamp(sidx % w, (sidx / w) | 0, 50, 140, 255, 170);
        }
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

/**
 * Paint a local nav window straight onto a 2D canvas (minimap HUD / VR).
 * Does not need the full-grid texture used by the world overlay.
 */
export function paintNavMapRegion(ctx, grid, minGroundY, centerIx, centerIz, cellR, destX, destY, destSize) {
    var w = grid.gridW;
    var h = grid.gridH;
    var mainId = grid.largestComponentId;
    var ix0 = Math.max(0, centerIx - cellR);
    var ix1 = Math.min(w - 1, centerIx + cellR);
    var iz0 = Math.max(0, centerIz - cellR);
    var iz1 = Math.min(h - 1, centerIz + cellR);
    var cells = cellR * 2 + 1;
    var cellPx = destSize / cells;
    var pad = cellPx < 2 ? 0.5 : 0;

    ctx.fillStyle = 'rgba(28,28,34,0.95)';
    ctx.fillRect(destX, destY, destSize, destSize);

    for (var iz = iz0; iz <= iz1; iz++) {
        for (var ix = ix0; ix <= ix1; ix++) {
            var flags = navGetCellFlags(grid, navCellIndex(grid, ix, iz));
            var px = destX + (ix - centerIx + cellR) * cellPx;
            var py = destY + (iz - centerIz + cellR) * cellPx;
            if (flags.water) {
                ctx.fillStyle = 'rgba(50,140,255,0.85)';
            } else if (flags.grey) {
                ctx.fillStyle = 'rgba(120,125,135,0.78)';
            } else if (flags.walkable) {
                var isMain = !mainId || flags.label === mainId;
                ctx.fillStyle = isMain ? 'rgba(0,255,110,0.72)' : 'rgba(170,210,70,0.55)';
            } else {
                continue;
            }
            ctx.fillRect(px, py, cellPx + pad, cellPx + pad);
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
    return packSparseNavBinary(grid, cacheKey, 2, true);
}

export function packSparseGridToSlimBinary(grid, cacheKey) {
    return packSparseNavBinary(grid, cacheKey, 3, false);
}

export function estimateSparseNavBundleBytes(grid, includeGrey) {
    var total = grid.gridW * grid.gridH;
    var body = encodeWalkVarintBody(grid.walkIdx).byteLength + grid.walkIdx.length * 2 +
        4 + ((total + 7) >>> 3) + 8;
    if (includeGrey) body += grid.greyIdx.length * 4 + 4;
    return body;
}

function packSparseNavBinary(grid, cacheKey, fmt, includeGrey) {
    var enc = new TextEncoder();
    var keyBytes = enc.encode(cacheKey || '');
    var oBeforeKey = 10;
    var keyPad = (4 - ((oBeforeKey + keyBytes.length) % 4)) % 4;
    var bodyBytes = grid.walkIdx.length * 8 + grid.waterIdx.length * 8 + 12;
    if (includeGrey) bodyBytes += grid.greyIdx.length * 4 + 4;
    var headerBytes = oBeforeKey + keyBytes.length + keyPad + 6 * 4 + 12;
    var totalBytes = headerBytes + bodyBytes;
    var out = new ArrayBuffer(totalBytes);
    var dv = new DataView(out);
    var u8 = new Uint8Array(out);
    var o = writeDv2nHeader(dv, u8, 0, fmt, keyBytes, grid);
    dv.setUint32(o, grid.walkIdx.length, true); o += 4;
    for (var wi = 0; wi < grid.walkIdx.length; wi++) {
        dv.setUint32(o, grid.walkIdx[wi], true); o += 4;
        dv.setFloat32(o, grid.walkY[wi], true); o += 4;
    }
    var waterList = grid.waterIdx;
    var waterYList = grid.waterY;
    if (grid.waterBitmap && !waterList.length) {
        waterList = [];
        waterYList = [];
    }
    dv.setUint32(o, waterList.length, true); o += 4;
    for (var si = 0; si < waterList.length; si++) {
        dv.setUint32(o, waterList[si], true); o += 4;
        dv.setFloat32(o, waterYList[si], true); o += 4;
    }
    if (includeGrey) {
        dv.setUint32(o, grid.greyIdx.length, true); o += 4;
        for (var gi = 0; gi < grid.greyIdx.length; gi++) {
            dv.setUint32(o, grid.greyIdx[gi], true); o += 4;
        }
    }
    return out;
}

export function sparseNavStats(grid) {
    if (!grid.sparse) return null;
    var waterCells = grid.waterIdx.length;
    if (grid.waterBitmap) {
        waterCells = 0;
        for (var bi = 0; bi < grid.waterBitmap.length; bi++) {
            var byte = grid.waterBitmap[bi];
            if (!byte) continue;
            for (var bit = 0; bit < 8; bit++) {
                if ((byte >> bit) & 1) waterCells++;
            }
        }
    }
    return {
        drivable: grid.walkIdx.length,
        water: waterCells,
        grey: grid.greyIdx.length,
        cells: grid.gridW * grid.gridH
    };
}
