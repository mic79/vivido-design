/**
 * PinballVR2 table layout + editor utilities (pure data / no THREE/CANNON).
 */
export const SNAP_ROT_DEG = 15;
export const GRID_STEP = 0.5;
export const SHOOTER_LANE_X = 4.3;
export const SHOOTER_LANE_Z = 4;
export const UNDO_MAX = 40;

export const LIBRARY_TYPES = [
    { id: 'bumper', label: 'Bumper', color: '#00ccff' },
    { id: 'post', label: 'Post', color: '#cccccc' },
    { id: 'target', label: 'Target', color: '#ff0066' },
    { id: 'rollover', label: 'Rollover', color: '#ff8800' },
    { id: 'slingshot', label: 'Slingshot', color: '#ff4444' },
    { id: 'wall', label: 'Wall', color: '#aabbcc' },
    { id: 'spinner', label: 'Spinner', color: '#aaccff' },
    { id: 'dropTarget', label: 'Drop Target', color: '#ff00aa' },
    { id: 'kickout', label: 'Kick-out', color: '#8800ff' },
    { id: 'ramp', label: 'Ramp', color: '#668844' },
    { id: 'magnet', label: 'Magnet', color: '#00ffaa' },
    { id: 'laneGuide', label: 'Lane Guide', color: '#aaaaaa' },
    { id: 'starRollover', label: 'Star Rollover', color: '#ffdd00' },
    { id: 'flipper', label: 'Flipper', color: '#ff4400' },
    { id: 'curveWall', label: 'Round Wall', color: '#8899aa' },
    { id: 'ballGate', label: 'Ball Gate', color: '#99aacc' },
    { id: 'habitrail', label: 'Habitrail', color: '#88aa66' },
];

export const DEFAULT_FLIPPERS = [
    { type: 'flipper', side: 'left', x: -2.9, z: 8, button: 'a' },
    { type: 'flipper', side: 'right', x: 2.4, z: 8, button: 'l' },
];

export const DEFAULT_CURVE_WALLS = [
    { type: 'curveWall', x: -3, z: 4.75, radius: 2, arcStart: -180, arcLength: -54, segments: 12 },
    { type: 'curveWall', x: 2.25, z: 4.75, radius: 2, arcStart: 0, arcLength: 54, segments: 12 },
];

export const DEFAULT_SCORES = {
    bumper: 100,
    post: 0,
    target: 200,
    rollover: 50,
    slingshot: 10,
    wall: 0,
    spinner: 100,
    dropTarget: 500,
    kickout: 0,
    ramp: 25,
    magnet: 0,
    laneGuide: 0,
    starRollover: 150,
    flipper: 0,
    curveWall: 0,
    ballGate: 0,
    habitrail: 0,
};

export function defaultComponent(type, index, bankCounter) {
    const base = {
        type,
        x: 0,
        z: 0,
        rot: 0,
        color: index % 3,
        score: DEFAULT_SCORES[type] ?? 100,
        scale: 1,
        bankId: type === 'dropTarget' ? 'bank' + (bankCounter ?? 1) : '',
        dropped: false,
        bumpForce: type === 'bumper' ? 3 : 0,
    };
    if (type === 'magnet') base.magnetStrength = 8;
    if (type === 'kickout') base.ejectZ = -2;
    if (type === 'wall') base.width = 1;
    if (type === 'ballGate') base.width = 1;
    if (type === 'flipper') {
        base.side = 'left';
        base.button = 'a';
        base.scale = 1;
        base.x = -2.9;
        base.z = 8;
    }
    if (type === 'curveWall') {
        base.radius = 2;
        base.arcStart = -180;
        base.arcLength = -54;
        base.segments = 12;
        base.x = -3;
        base.z = 4.75;
    }
    if (type === 'habitrail') {
        base.wireRadius = 0.55;
        base.path = [];
    }
    return base;
}

/** Minimum cage radius (table units) so the ball fits inside the wire loop. */
export function habitRailMinWireRadiusTableUnits(ballRadiusM, s) {
    s = s || 0.0584;
    ballRadiusM = ballRadiusM > 0 ? ballRadiusM : 0.0146;
    const wireTubeTable = 0.006;
    return Math.max(0.35, ballRadiusM / s + wireTubeTable + 0.03);
}

/** Chord between adjacent wire centre-lines on cage circle radius R with N rails. */
export function habitRailWireGapChord(wireRadiusM, wireCount) {
    if (wireCount < 2) return wireRadiusM * 2;
    return 2 * wireRadiusM * Math.sin(Math.PI / wireCount);
}

/** Minimum rail count so every gap chord ≤ 2·ballRadius (ball cannot slip between wires). */
export function habitRailWireCount(wireRadiusM, ballRadiusM, wireTubeM) {
    ballRadiusM = ballRadiusM > 0 ? ballRadiusM : 0.0146;
    wireTubeM = wireTubeM > 0 ? wireTubeM : 0.00035;
    wireRadiusM = Math.max(wireRadiusM, ballRadiusM * 1.05);
    const maxGap = 2 * ballRadiusM + 2 * wireTubeM;
    const ratio = Math.min(0.999, maxGap / (2 * wireRadiusM));
    const minN = Math.PI / Math.asin(ratio);
    const base = Math.max(6, Math.min(16, Math.ceil(minN)));
    return Math.min(32, base * 2);
}

/** Evenly spaced rails around the cage; half-step offset → two rails straddle the bottom (270°). */
export function habitRailWireAngles(wireRadiusM, ballRadiusM, wireTubeM) {
    const n = habitRailWireCount(wireRadiusM, ballRadiusM, wireTubeM);
    const step = 360 / n;
    const angles = [];
    for (let i = 0; i < n; i++) angles.push((i + 0.5) * step);
    return angles;
}

function normalizeHabitPoint(p) {
    return {
        x: +p.x || 0,
        z: +p.z || 0,
        y: +(p.y || 0),
        rot: p.rot != null ? +p.rot : 0,
    };
}

function catmullRom1(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
        (2 * p1) +
        (-p0 + p2) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
}

function catmullRomDeriv1(p0, p1, p2, p3, t) {
    const t2 = t * t;
    return 0.5 * (
        (-p0 + p2) +
        2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t +
        3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t2
    );
}

function lerpAngle(a, b, t) {
    let d = ((b - a + 540) % 360) - 180;
    return a + d * t;
}

/** Default open path when spawning a new habitrail at (x, z). */
export function defaultHabitRailPath(x, z) {
    x = +x || 0;
    z = +z || 0;
    return [
        { x, z, y: 0, rot: 0 },
        { x, z: z - 2, y: 0.45, rot: 0 },
        { x: x + 1, z: z - 3, y: 0.45, rot: 0 },
    ];
}

/** Build / normalize control points (open polyline with rot per point). */
export function ensureHabitRailPath(data) {
    const sx = +data.x || 0;
    const sz = +data.z || 0;
    if (Array.isArray(data.path) && data.path.length >= 2) {
        return data.path.map(normalizeHabitPoint);
    }
    if (data.midX != null || data.endX != null) {
        return [
            { x: sx, z: sz, y: 0, rot: 0 },
            { x: data.midX != null ? +data.midX : sx, z: data.midZ != null ? +data.midZ : sz - 2, y: data.peakY != null ? +data.peakY : 0.45, rot: 0 },
            { x: data.endX != null ? +data.endX : sx + 1, z: data.endZ != null ? +data.endZ : sz - 3, y: data.endY != null ? +data.endY : 0.45, rot: 0 },
        ];
    }
    return defaultHabitRailPath(sx, sz);
}

export function syncHabitRailPathFields(data) {
    const path = ensureHabitRailPath(data);
    data.path = path;
    data.x = path[0].x;
    data.z = path[0].z;
    return path;
}

export function insertHabitRailPoint(data, index, point) {
    const path = ensureHabitRailPath(data).map(p => ({ ...p }));
    const idx = Math.max(1, Math.min(path.length, Math.round(index)));
    path.splice(idx, 0, normalizeHabitPoint(point));
    data.path = path;
    syncHabitRailPathFields(data);
    return idx;
}

export function removeHabitRailPoint(data, index) {
    const path = ensureHabitRailPath(data).map(p => ({ ...p }));
    if (path.length <= 2) return false;
    const idx = Math.max(0, Math.min(path.length - 1, Math.round(index)));
    path.splice(idx, 1);
    data.path = path;
    syncHabitRailPathFields(data);
    return true;
}

/** Sample smooth open path through control points (table units). */
export function sampleHabitRailCenterPath(path, samplesPerSeg) {
    samplesPerSeg = Math.max(4, Math.min(24, samplesPerSeg || 10));
    if (!path || path.length < 2) return [];
    const out = [];
    for (let i = 0; i < path.length - 1; i++) {
        const p0 = path[Math.max(0, i - 1)];
        const p1 = path[i];
        const p2 = path[i + 1];
        const p3 = path[Math.min(path.length - 1, i + 2)];
        for (let j = 0; j < samplesPerSeg; j++) {
            const t = j / samplesPerSeg;
            out.push({
                x: catmullRom1(p0.x, p1.x, p2.x, p3.x, t),
                z: catmullRom1(p0.z, p1.z, p2.z, p3.z, t),
                y: catmullRom1(p0.y, p1.y, p2.y, p3.y, t),
                rot: lerpAngle(p1.rot || 0, p2.rot || 0, t),
                seg: i,
                t,
            });
        }
    }
    const last = path[path.length - 1];
    out.push({ ...normalizeHabitPoint(last), seg: path.length - 2, t: 1 });
    return out;
}

function rotateAroundPlayfieldY(x, y, z, rotDeg) {
    const r = (rotDeg || 0) * Math.PI / 180;
    const c = Math.cos(r), sn = Math.sin(r);
    return {
        x: x * c + z * sn,
        y,
        z: -x * sn + z * c,
    };
}

/** Cross-section frame perpendicular to path tangent (playfield-local). */
function habitFramePerp(tangentX, tangentY, tangentZ) {
    let tx = tangentX, ty = tangentY, tz = tangentZ;
    const tLen = Math.hypot(tx, ty, tz) || 1;
    tx /= tLen; ty /= tLen; tz /= tLen;
    let rx, ry, rz;
    if (Math.abs(ty) > 0.95) {
        rx = 1; ry = 0; rz = 0;
    } else {
        rx = (-tz);
        ry = 0;
        rz = tx;
        const rLen = Math.hypot(rx, rz) || 1;
        rx /= rLen; rz /= rLen;
    }
    let ux = ty * rz - tz * ry;
    let uy = tz * rx - tx * rz;
    let uz = tx * ry - ty * rx;
    const uLen = Math.hypot(ux, uy, uz) || 1;
    ux /= uLen; uy /= uLen; uz /= uLen;
    rx = uy * tz - uz * ty;
    ry = uz * tx - ux * tz;
    rz = ux * ty - uy * tx;
    return { tx, ty, tz, rx, ry, rz, ux, uy, uz };
}

/** One wire direction in the cage cross-section; rot = yaw around playfield Y. */
function wireUnitOffset(frame, baseAngDeg, rotDeg) {
    const rad = baseAngDeg * Math.PI / 180;
    const c = Math.cos(rad), sn = Math.sin(rad);
    const ox = frame.rx * c + frame.ux * sn;
    const oy = frame.ry * c + frame.uy * sn;
    const oz = frame.rz * c + frame.uz * sn;
    return rotateAroundPlayfieldY(ox, oy, oz, rotDeg);
}

/** Table-local mesh + wire collision data for a habitrail (meters, playfield-local). */
export function buildHabitRailGeometry(data, s, ft, ballRadiusM) {
    s = s || 0.0584;
    ft = ft != null ? ft : 0.002;
    const path = ensureHabitRailPath(data);
    const wireRadiusTable = Math.max(
        habitRailMinWireRadiusTableUnits(ballRadiusM, s),
        +(data.wireRadius ?? data.width) || 0.55
    );
    const wireRadius = wireRadiusTable * s;
    const wireRad = Math.max(0.0015, 0.006 * s);
    const ringTube = Math.max(0.0012, 0.004 * s);
    const wireAngles = habitRailWireAngles(wireRadius, ballRadiusM, wireRad);
    const wireCount = wireAngles.length;
    const floorOff = ft / 2 + 0.002;
    const samplesPerSeg = Math.max(6, Math.min(16, +(data.segments) || 10));
    const centerPath = sampleHabitRailCenterPath(path, samplesPerSeg);
    const wires = [];
    const rings = [];
    const centerLine = [];

    function toLocal(p) {
        return { x: p.x * s, y: floorOff + p.y * s, z: p.z * s };
    }

    for (let i = 0; i < centerPath.length; i++) {
        const p = centerPath[i];
        const prev = centerPath[Math.max(0, i - 1)];
        const next = centerPath[Math.min(centerPath.length - 1, i + 1)];
        const dx = (next.x - prev.x) * s;
        const dy = (next.y - prev.y) * s;
        const dz = (next.z - prev.z) * s;
        const loc = toLocal(p);
        centerLine.push(loc.x, loc.y, loc.z);
        const frame = habitFramePerp(dx, dy, dz);
        if (i < centerPath.length - 1) {
            const p2 = centerPath[i + 1];
            const loc2 = toLocal(p2);
            const prev2 = centerPath[i];
            const next2 = centerPath[Math.min(centerPath.length - 1, i + 2)];
            const dx2 = (next2.x - prev2.x) * s;
            const dy2 = (next2.y - prev2.y) * s;
            const dz2 = (next2.z - prev2.z) * s;
            const frame2 = habitFramePerp(dx2, dy2, dz2);
            for (const ang of wireAngles) {
                const off = wireUnitOffset(frame, ang, p.rot);
                const off2 = wireUnitOffset(frame2, ang, p2.rot);
                wires.push({
                    ax: loc.x + off.x * wireRadius, ay: loc.y + off.y * wireRadius, az: loc.z + off.z * wireRadius,
                    bx: loc2.x + off2.x * wireRadius, by: loc2.y + off2.y * wireRadius, bz: loc2.z + off2.z * wireRadius,
                    radius: wireRad,
                });
            }
        }
    }

    for (let i = 0; i < path.length; i++) {
        const p = path[i];
        const prev = path[Math.max(0, i - 1)];
        const next = path[Math.min(path.length - 1, i + 1)];
        const dx = next.x - prev.x;
        const dy = next.y - prev.y;
        const dz = next.z - prev.z;
        const loc = toLocal(p);
        const frame = habitFramePerp(dx * s, dy * s, dz * s);
        rings.push({
            x: loc.x, y: loc.y, z: loc.z,
            rx: frame.rx, ry: frame.ry, rz: frame.rz,
            ux: frame.ux, uy: frame.uy, uz: frame.uz,
            tx: frame.tx, ty: frame.ty, tz: frame.tz,
            tube: ringTube,
            // Torus major radius: inner edge (R − tube) sits on outer wire surface, not through wire centers.
            radius: wireRadius + wireRad + ringTube,
            rot: p.rot || 0,
        });
    }

    return {
        path,
        centerPath,
        centerLine,
        wires,
        rings,
        endPt: path[path.length - 1],
        wireRadius,
        wireRadiusTable,
        wireCount,
        wireAngles,
        wireGapChord: habitRailWireGapChord(wireRadius, wireCount),
        wireRad,
        floorOff,
    };
}

/** Single tube collision mesh (inner wall). Ball stays inside; open at both ends. */
export function buildHabitRailTubeTrimesh(built, s) {
    const path = built.centerPath;
    if (!path || path.length < 2) return { pos: [], idx: [] };
    s = s || 0.0584;
    const floorOff = built.floorOff;
    const tubeR = Math.max(built.wireRad * 2, built.wireRadius - built.wireRad);
    // Finer cross-section than visual wires — reduces facet snagging on the trimesh.
    const azSteps = Math.max(24, (built.wireCount || 8) * 2);
    const pos = [];
    const idx = [];

    function toLocal(p) {
        return { x: p.x * s, y: floorOff + p.y * s, z: p.z * s };
    }

    function ringVerts(i) {
        const p = path[i];
        const prev = path[Math.max(0, i - 1)];
        const next = path[Math.min(path.length - 1, i + 1)];
        const dx = (next.x - prev.x) * s;
        const dy = (next.y - prev.y) * s;
        const dz = (next.z - prev.z) * s;
        const loc = toLocal(p);
        const frame = habitFramePerp(dx, dy, dz);
        const verts = [];
        for (let j = 0; j < azSteps; j++) {
            const ang = (j / azSteps) * 360;
            const off = wireUnitOffset(frame, ang, p.rot || 0);
            verts.push(
                loc.x + off.x * tubeR,
                loc.y + off.y * tubeR,
                loc.z + off.z * tubeR
            );
        }
        return { loc, verts };
    }

    const rings = [];
    for (let i = 0; i < path.length; i++) rings.push(ringVerts(i));

    for (let i = 0; i < rings.length - 1; i++) {
        const base0 = pos.length / 3;
        pos.push(...rings[i].verts);
        const base1 = pos.length / 3;
        pos.push(...rings[i + 1].verts);
        for (let j = 0; j < azSteps; j++) {
            const jn = (j + 1) % azSteps;
            const a = base0 + j;
            const b = base0 + jn;
            const c = base1 + jn;
            const d = base1 + j;
            // inward-facing (ball pushes back into tube)
            idx.push(a, d, b, b, d, c);
        }
    }

    return { pos, idx, tubeRadius: tubeR };
}

/** Add standard left/right flippers when a layout has none (playable table). */
export function ensureFlippersInLayout(components) {
    if (components.some(c => c.type === 'flipper')) return components;
    const max = maxComponentIdNum(components);
    const flippers = DEFAULT_FLIPPERS.map((f, i) => ({
        ...f,
        id: 'c' + (max + 1 + i),
    }));
    return components.concat(flippers);
}

/** Add default gutter curve walls when a layout has none. */
export function ensureCurveWallsInLayout(components) {
    if (components.some(c => c.type === 'curveWall')) return components;
    const max = maxComponentIdNum(components);
    const walls = DEFAULT_CURVE_WALLS.map((w, i) => ({
        ...w,
        id: 'c' + (max + 1 + i),
    }));
    return components.concat(walls);
}

/** Ensure flippers + round gutter walls exist on every playable layout. */
export function ensureTableDefaults(components) {
    return ensureCurveWallsInLayout(ensureFlippersInLayout(components));
}

export function normalizeComponent(raw, index) {
    const type = raw.type || 'bumper';
    const d = defaultComponent(type, index);
    return {
        id: raw.id || ('c' + index),
        type,
        x: +raw.x || 0,
        z: +raw.z || 0,
        rot: raw.rot != null ? +raw.rot : d.rot,
        color: raw.color != null ? +raw.color : d.color,
        score: raw.score != null ? +raw.score : d.score,
        scale: raw.scale != null ? +raw.scale : 1,
        bankId: raw.bankId != null ? String(raw.bankId) : d.bankId,
        dropped: !!raw.dropped,
        bumpForce: raw.bumpForce != null ? +raw.bumpForce : d.bumpForce,
        magnetStrength: raw.magnetStrength != null ? +raw.magnetStrength : (d.magnetStrength || 8),
        ejectZ: raw.ejectZ != null ? +raw.ejectZ : (d.ejectZ ?? -2),
        width: raw.width != null ? +raw.width : (d.width ?? 1),
        side: raw.side === 'right' ? 'right' : 'left',
        button: raw.button === 'l' ? 'l' : 'a',
        radius: raw.radius != null ? +raw.radius : (d.radius ?? 2),
        arcStart: raw.arcStart != null ? +raw.arcStart : (d.arcStart ?? -180),
        arcLength: raw.arcLength != null ? +raw.arcLength : (d.arcLength ?? -54),
        segments: raw.segments != null ? Math.max(3, Math.min(32, +raw.segments)) : (d.segments ?? 12),
        wireRadius: raw.wireRadius != null ? +raw.wireRadius : (raw.width != null ? +raw.width : (d.wireRadius ?? 0.55)),
        path: Array.isArray(raw.path)
            ? raw.path.map(p => normalizeHabitPoint(p))
            : [],
    };
}

/** Legacy pipe: type:x,z,color,rot,score */
function decodeLegacyPipe(param) {
    return param.split('|').filter(Boolean).map((seg, i) => {
        const colon = seg.indexOf(':');
        const type = colon >= 0 ? seg.slice(0, colon) : 'bumper';
        const rest = colon >= 0 ? seg.slice(colon + 1) : seg;
        const pts = rest.split(',').map(v => (v === '' ? NaN : Number(v)));
        return normalizeComponent({
            id: 'c' + i,
            type,
            x: pts[0],
            z: pts[1],
            color: pts[2],
            rot: pts[3],
            score: pts[4],
        }, i);
    });
}

export function decodeLayoutParam(param) {
    if (!param) return [];
    if (param.startsWith('b64:')) {
        try {
            const arr = JSON.parse(atob(param.slice(4)));
            return arr.map((c, i) => normalizeComponent(c, i));
        } catch (_) { return []; }
    }
    if (param.startsWith('{') || param.startsWith('[')) {
        try {
            const arr = JSON.parse(param);
            return (Array.isArray(arr) ? arr : arr.components || []).map((c, i) => normalizeComponent(c, i));
        } catch (_) { return []; }
    }
    return decodeLegacyPipe(param);
}

export function encodeLayoutParam(components) {
    return components.map(c => {
        let s = c.type + ':' + c.x + ',' + c.z;
        if (c.color != null) s += ',' + c.color;
        if (c.rot) s += ',' + c.rot;
        if (c.score != null && c.score !== DEFAULT_SCORES[c.type]) s += ',' + c.score;
        return s;
    }).join('|');
}

export function encodeLayoutJson(components) {
    return JSON.stringify(components.map(c => ({
        type: c.type,
        x: c.x,
        z: c.z,
        rot: c.rot || 0,
        color: c.color,
        score: c.score,
        scale: c.scale || 1,
        bankId: c.bankId || '',
        bumpForce: c.bumpForce,
        magnetStrength: c.magnetStrength,
        ejectZ: c.ejectZ,
        width: c.width,
        side: c.side,
        button: c.button,
        radius: c.radius,
        arcStart: c.arcStart,
        arcLength: c.arcLength,
        segments: c.segments,
        wireRadius: c.wireRadius,
        path: c.path,
    })), null, 2);
}

export function encodeLayoutB64(components) {
    return 'b64:' + btoa(JSON.stringify(components));
}

export function snapGrid(x, z, step) {
    step = step || GRID_STEP;
    return {
        x: Math.round(x / step) * step,
        z: Math.round(z / step) * step,
    };
}

export function snapRot(deg) {
    return Math.round(deg / SNAP_ROT_DEG) * SNAP_ROT_DEG;
}

export function isInShooterLane(x, z) {
    return x > SHOOTER_LANE_X - 0.6 && z > SHOOTER_LANE_Z;
}

/** Half-extents from component center in S-units (+x, -x, +z, -z). */
function panelExtents(data) {
    const w = Math.max(0.25, +(data?.width ?? 1) || 1);
    const halfT = 0.075;
    const halfD = 0.25 * w;
    const rad = ((+(data?.rot) || 0) * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const sn = Math.abs(Math.sin(rad));
    const ex = halfT * c + halfD * sn;
    const ez = halfT * sn + halfD * c;
    return { px: ex, nx: ex, pz: ez, nz: ez };
}

function curveWallExtents(data) {
    const r = Math.max(0.5, +(data?.radius) || 2);
    const arcStart = ((+(data?.arcStart) || -180) * Math.PI) / 180;
    const arcLen = ((+(data?.arcLength) || -54) * Math.PI) / 180;
    const segs = Math.max(3, Math.min(32, +(data?.segments) || 12));
    let minX = 0, maxX = 0, minZ = 0, maxZ = 0;
    for (let i = 0; i <= segs; i++) {
        const t = arcStart + (i / segs) * arcLen;
        const lx = Math.cos(t) * r;
        const lz = Math.sin(t) * r;
        if (i === 0) { minX = maxX = lx; minZ = maxZ = lz; }
        else {
            minX = Math.min(minX, lx); maxX = Math.max(maxX, lx);
            minZ = Math.min(minZ, lz); maxZ = Math.max(maxZ, lz);
        }
    }
    return { nx: -minX, px: maxX, nz: -minZ, pz: maxZ };
}

function flipperExtents(data) {
    const isLeft = data?.side !== 'right';
    const sc = Math.max(0.5, Math.min(1.5, +(data?.scale) || 1));
    const len = 2.4 * sc;
    const pad = 0.15;
    const w = 0.25 * sc;
    return {
        nx: isLeft ? pad : len + pad,
        px: isLeft ? len + pad : pad,
        nz: w,
        pz: w,
    };
}

function ballGateExtents(data) {
    const widthMult = Math.max(0.25, +(data?.width ?? 1) || 1);
    const halfSpan = 0.25 * widthMult;
    const halfZ = 0.05;
    const rad = ((+(data?.rot) || 0) * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad));
    const sn = Math.abs(Math.sin(rad));
    const ex = halfSpan * c + halfZ * sn;
    const ez = halfSpan * sn + halfZ * c;
    return { px: ex, nx: ex, pz: ez, nz: ez };
}

function habitrailExtents(data) {
    const path = ensureHabitRailPath(data);
    let minX = path[0].x, maxX = path[0].x, minZ = path[0].z, maxZ = path[0].z;
    for (const p of path) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const hw = Math.max(0.35, (+(data?.wireRadius ?? data?.width) || 0.55) / 2 + 0.15);
    const cx = (+data.x || 0);
    const cz = (+data.z || 0);
    return {
        nx: Math.max(0, cx - minX) + hw,
        px: Math.max(0, maxX - cx) + hw,
        nz: Math.max(0, cz - minZ) + hw,
        pz: Math.max(0, maxZ - cz) + hw,
    };
}

/** Directional reach from center for playfield clamping (S-units). */
export function componentExtents(data) {
    if (!data) return { nx: 0.35, px: 0.35, nz: 0.35, pz: 0.35 };
    const sc = Math.max(0.5, +(data.scale) || 1);
    switch (data.type) {
        case 'wall':
        case 'slingshot':
            return panelExtents(data);
        case 'ballGate':
            return ballGateExtents(data);
        case 'curveWall':
            return curveWallExtents(data);
        case 'flipper':
            return flipperExtents(data);
        case 'habitrail':
            return habitrailExtents(data);
        case 'bumper':
            return { nx: 0.75 * sc, px: 0.75 * sc, nz: 0.75 * sc, pz: 0.75 * sc };
        case 'post':
        case 'laneGuide':
            return { nx: 0.12, px: 0.12, nz: 0.12, pz: 0.12 };
        case 'target':
        case 'dropTarget':
            return { nx: 0.2 * sc, px: 0.2 * sc, nz: 0.35 * sc, pz: 0.35 * sc };
        case 'rollover':
            return { nx: 0.3, px: 0.3, nz: 0.125, pz: 0.125 };
        case 'starRollover':
            return { nx: 0.22, px: 0.22, nz: 0.22, pz: 0.22 };
        case 'spinner':
            return { nx: 0.35, px: 0.35, nz: 0.1, pz: 0.1 };
        case 'kickout':
            return { nx: 0.14, px: 0.14, nz: 0.14, pz: 0.14 };
        case 'ramp':
            return { nx: 0.45, px: 0.45, nz: 0.6, pz: 0.6 };
        case 'magnet':
            return { nx: 0.2, px: 0.2, nz: 0.2, pz: 0.2 };
        default:
            return { nx: 0.35, px: 0.35, nz: 0.35, pz: 0.35 };
    }
}

export function clampPlayfield(x, z, tableW, tableL, s, extents) {
    const ext = typeof extents === 'number'
        ? { nx: extents, px: extents, nz: extents, pz: extents }
        : (extents || { nx: 0.35, px: 0.35, nz: 0.35, pz: 0.35 });
    const eps = 0.01;
    // Inner faces of fixed side/back rails (S-units)
    const wtHalf = 0.25;
    const innerLeft = -(tableW / (2 * s) + wtHalf) + wtHalf;
    const innerRight = (tableW / (2 * s) + wtHalf) - wtHalf;
    const innerBack = -(tableL / (2 * s) + wtHalf) + wtHalf;
    const innerFront = tableL / (2 * s);

    const minX = innerLeft + ext.nx + eps;
    const maxXWall = innerRight - ext.px - eps;
    const laneEdge = SHOOTER_LANE_X - 0.075 - ext.px - eps;
    const maxX = Math.min(maxXWall, laneEdge);
    const minZ = innerBack + ext.nz + eps;
    const maxZ = innerFront - ext.pz - eps;

    let cx = Math.max(minX, Math.min(maxX, x));
    let cz = Math.max(minZ, Math.min(maxZ, z));
    if (isInShooterLane(cx, cz)) {
        cx = Math.min(cx, SHOOTER_LANE_X - 0.15 - ext.px);
    }
    return { x: cx, z: cz };
}

/** Highest numeric cN id in a component list (+1 ready for next). */
export function maxComponentIdNum(components) {
    let max = -1;
    for (const c of components) {
        const m = /^c(\d+)$/.exec(String(c.id || ''));
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max;
}

export function cloneComponentData(data) {
    return {
        ...data,
        x: +data.x || 0,
        z: +data.z || 0,
        rot: data.rot != null ? +data.rot : 0,
    };
}

export function duplicateComponent(data, nextId, dx, dz) {
    dx = dx != null ? dx : GRID_STEP;
    dz = dz != null ? dz : 0;
    const copy = {
        ...data,
        id: nextId,
        x: (+data.x || 0) + dx,
        z: (+data.z || 0) + dz,
        dropped: false,
    };
    if (data.type === 'habitrail') {
        copy.path = ensureHabitRailPath(data).map(p => ({
            x: p.x + dx, z: p.z + dz, y: p.y, rot: p.rot || 0,
        }));
        syncHabitRailPathFields(copy);
    }
    return copy;
}

export function selectionCentroid(components) {
    if (!components.length) return { x: 0, z: 0 };
    let sx = 0, sz = 0;
    for (const c of components) {
        sx += +c.x || 0;
        sz += +c.z || 0;
    }
    return { x: sx / components.length, z: sz / components.length };
}

/** Mirror in place across vertical plane x = centerX (group pivot, keeps same id). */
export function applyMirrorAcrossX(data, centerX) {
    data.x = 2 * centerX - (+data.x || 0);
    data.rot = snapRot(-(+(data.rot || 0)));
    return data;
}

export class UndoStack {
    constructor(maxSize) {
        this.max = maxSize || UNDO_MAX;
        this.undo = [];
        this.redo = [];
    }
    snapshot(components) {
        return JSON.parse(JSON.stringify(components));
    }
    push(components) {
        this.undo.push(this.snapshot(components));
        if (this.undo.length > this.max) this.undo.shift();
        this.redo.length = 0;
    }
    canUndo() { return this.undo.length > 0; }
    canRedo() { return this.redo.length > 0; }
    popUndo(current) {
        if (!this.canUndo()) return null;
        this.redo.push(this.snapshot(current));
        return this.undo.pop();
    }
    popRedo(current) {
        if (!this.canRedo()) return null;
        this.undo.push(this.snapshot(current));
        return this.redo.pop();
    }
}
