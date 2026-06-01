/**
 * GTAVR — chase-focused performance helpers (spatial broadphase, budgets).
 * Designed to scale toward large unit counts without O(n²) JS work per frame.
 */

export const ChasePerf = {
    /** Hard cap on simultaneous simulated pursuers (desktop). */
    maxActiveUnits: 24,
    maxActiveUnitsQuest: 8,
    /** Cap spawned at max wanted (5★ × 2 = 10 → 8 by default). ?chasers=N overrides per-star count. */
    maxPursuersDesktop: 8,
    maxPursuersQuest: 6,
    /** Hypothetical registry size — pool slots reserved, not all sim-full. */
    maxUnitSlots: 100,
    /** Full AI + city hull rays inside this radius (m). */
    fullSimRadiusM: 140,
    /** Mesh-only follow physics between fullSim and park (m). */
    liteSimRadiusM: 200,
    /** Beyond this: remove raycast vehicle action until player approaches. */
    lodParkRadiusM: 220,
    physicsMaxSubstepsDesktop: 6,
    /** Match DriveVR2/3 — low substeps make wheel rays miss streets on Quest. */
    physicsMaxSubstepsQuest: 10,
    physicsMaxSubstepsXR: 10,
    /** Max chase↔player collision pair checks per frame (after spatial filter). */
    collisionPairBudget: 48,
    /** Max pursuers getting replan/LOS work per frame. */
    aiUpdateBudget: 6,
    /** Full botSync stride (per pursuer index). */
    chaseAiSyncStride: 2,
    /** City BVH depenetrate stride for pursuers (player every frame). */
    chaseCityCollisionStride: 2,
    /** Only this many nearest cars run SpotLight beacons. */
    policeSpotlightMax: 4,
    spatialCellSizeM: 32,
    /** Must stay false — Quest needs Bullet walkable tris for wheel raycasts (BVH-only = no traction). */
    skipCityBulletOnQuest: false,
    rearviewMirrorFrameSkipQuest: 2,
    rearviewMirrorFrameSkipDesktop: 1,
};

export function getMaxPursuers() {
    return detectQuest() ? ChasePerf.maxPursuersQuest : ChasePerf.maxPursuersDesktop;
}

export function detectQuest() {
    return navigator.userAgent.includes('Quest') || navigator.userAgent.includes('Oculus');
}

export function getMaxActiveUnits() {
    return detectQuest() ? ChasePerf.maxActiveUnitsQuest : ChasePerf.maxActiveUnits;
}

export function getPhysicsMaxSubsteps(inXR) {
    if (detectQuest()) return ChasePerf.physicsMaxSubstepsQuest;
    return inXR ? ChasePerf.physicsMaxSubstepsXR : ChasePerf.physicsMaxSubstepsDesktop;
}

/** Uniform grid on XZ for broadphase — O(n) insert, O(k) neighbor queries. */
export class SpatialHashXZ {
    constructor(cellSize) {
        this.cellSize = cellSize > 0 ? cellSize : 32;
        this.invCell = 1 / this.cellSize;
        this.cells = new Map();
    }

    _key(ix, iz) {
        return ix + ',' + iz;
    }

    clear() {
        this.cells.clear();
    }

    insert(id, x, z, payload) {
        var ix = Math.floor(x * this.invCell);
        var iz = Math.floor(z * this.invCell);
        var key = this._key(ix, iz);
        var bucket = this.cells.get(key);
        if (!bucket) {
            bucket = [];
            this.cells.set(key, bucket);
        }
        bucket.push({ id: id, x: x, z: z, payload: payload });
    }

    /** Visit self cell + 8 neighbors. */
    forEachNeighbor(x, z, fn) {
        var ix = Math.floor(x * this.invCell);
        var iz = Math.floor(z * this.invCell);
        for (var dx = -1; dx <= 1; dx++) {
            for (var dz = -1; dz <= 1; dz++) {
                var bucket = this.cells.get(this._key(ix + dx, iz + dz));
                if (!bucket) continue;
                for (var i = 0; i < bucket.length; i++) {
                    fn(bucket[i]);
                }
            }
        }
    }
}

/**
 * Registers vehicle bodies once per frame; yields candidate pairs near player
 * without scanning all manifolds × all pairs.
 */
export class ChaseCollisionBroadphase {
    constructor(cellSize) {
        this.hash = new SpatialHashXZ(cellSize);
        this._bodies = [];
    }

    clear() {
        this.hash.clear();
        this._bodies.length = 0;
    }

    register(body, type, payload) {
        if (!body) return;
        var p = payload && payload.worldPos;
        if (!p) return;
        var id = this._bodies.length;
        this._bodies.push({ body: body, type: type, payload: payload, id: id });
        this.hash.insert(id, p.x, p.z, this._bodies[id]);
    }

    /**
     * @param {function(a,b):void} pairFn
     * @param {number} budget max pairs per call
     * @param {boolean} skipChaseChase skip chase-chase pairs
     */
    forEachPairNear(playerPos, pairFn, budget, skipChaseChase) {
        var checked = 0;
        var seen = new Set();
        var self = this;
        this.hash.forEachNeighbor(playerPos.x, playerPos.z, function (item) {
            if (checked >= budget) return;
            var a = item.payload;
            if (!a) return;
            self.hash.forEachNeighbor(item.x, item.z, function (other) {
                if (checked >= budget) return;
                if (other.id <= item.id) return;
                var key = item.id + ':' + other.id;
                if (seen.has(key)) return;
                seen.add(key);
                var b = other.payload;
                if (!b) return;
                if (skipChaseChase && a.type === 'chase' && b.type === 'chase') return;
                if (a.type === 'remote' || b.type === 'remote') return;
                pairFn(a, b);
                checked++;
            });
        });
    }
}

/** Stagger work across frames by unit index. */
export function shouldRunUnitTick(unitIndex, frameId, stride) {
    stride = stride > 0 ? stride : 4;
    return (unitIndex + frameId) % stride === 0;
}

export function horizDistSq(ax, az, bx, bz) {
    var dx = ax - bx;
    var dz = az - bz;
    return dx * dx + dz * dz;
}
