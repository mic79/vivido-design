/**
 * Endless — open dirt road streamed in sections.
 * Each section is the same ribbon / kit / roadside pass as a JS track, on the
 * next stretch of frames only. The cursor keeps heading and slope so the join
 * is the same point the previous section ended on.
 */
import {
    buildRibbon,
    densifyFrames,
    slideFrames,
    buildSoftGravel,
    beginFrameIndex,
    endFrameIndex,
    sealGrassUnderCarriage,
    placeForestKit,
    placeFrRoadside,
    applyForestRoadSurfaceMats
} from './composeJsTrack.js';

var SECTION_M = 140;
var AHEAD_M = 240;
var BEHIND_M = 100;
var STEP_M = 2;
// Grass is ±16 m and the kit plants trees out to ~70 m, so a later bend
// must stay this far from any older centerline or it drives through that forest.
var CLEAR_M = 88;
var TAIL_SKIP_M = 180;
var MAX_CURV = 0.024;

function mulberry32(seed) {
    var a = seed | 0;
    return function() {
        a = (a + 0x6D2B79F5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function createEndlessCursor(seed) {
    return {
        rng: mulberry32(seed || 1),
        x: 0,
        y: 14,
        z: 0,
        heading: 0.4,
        curv: 0.018,
        target: 0.018,
        hold: 0,
        phase: 'hook',
        bendSign: 1,
        sameRun: 0,
        lastPhrase: '',
        prevPhrase: '',
        goal: 1.3,
        goalSign: 1,
        elevTarget: 28,
        elevV: 0,
        gradeTarget: 0.02,
        gradeHold: 160,
        nextGrade: 0.02,
        plan: [],
        dist: 0,
        trail: [{ x: 0, z: 0, dist: 0 }]
    };
}

var PLAN_AHEAD_M = 1100;

function wrapPi(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

function buildNearGrid(cursor) {
    var cell = 32;
    var grid = new Map();
    var trail = cursor.trail;
    var i;
    for (i = 0; i < trail.length; i += 2) {
        var p = trail[i];
        var key = (Math.floor(p.x / cell)) + ',' + (Math.floor(p.z / cell));
        var bucket = grid.get(key);
        if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
        }
        bucket.push(p);
    }
    cursor.nearGrid = grid;
    cursor.nearCell = cell;
}

function nearestOld(cursor, x, z) {
    var grid = cursor.nearGrid;
    if (!grid) buildNearGrid(cursor);
    grid = cursor.nearGrid;
    var cell = cursor.nearCell || 32;
    var cx = Math.floor(x / cell);
    var cz = Math.floor(z / cell);
    var best = Infinity;
    var bx = x;
    var bz = z;
    var here = cursor.dist;
    var a;
    var b;
    for (a = -3; a <= 3; a++) {
        for (b = -3; b <= 3; b++) {
            var bucket = grid.get((cx + a) + ',' + (cz + b));
            if (!bucket) continue;
            var i;
            for (i = 0; i < bucket.length; i++) {
                var p = bucket[i];
                // A backward extension uses its own distance numbers. Only skip
                // the recent centerline of this same chain. The other chain is
                // a real road and must stay out of the way.
                var sameChain = (p.chain || 0) === (cursor.chain || 0);
                if (sameChain && Math.abs(here - p.dist) < TAIL_SKIP_M) continue;
                // Leaving an existing road: ignore that road near the join, or the
                // first steps are "too close" to the pavement they start on.
                if (!sameChain && cursor.attach) {
                    var ax = cursor.attach.x;
                    var az = cursor.attach.z;
                    if (Math.hypot(x - ax, z - az) < TAIL_SKIP_M &&
                        Math.hypot(p.x - ax, p.z - az) < TAIL_SKIP_M) continue;
                }
                var d = Math.hypot(x - p.x, z - p.z);
                if (d < best) {
                    best = d;
                    bx = p.x;
                    bz = p.z;
                }
            }
        }
    }
    if (best === Infinity) return { d: 999, x: x, z: z };
    return { d: best, x: bx, z: bz };
}

function copyState(state) {
    return {
        heading: state.heading,
        x: state.x,
        z: state.z,
        dist: state.dist,
        y: state.y,
        elevV: state.elevV || 0,
        gradeTarget: state.gradeTarget || 0,
        gradeHold: state.gradeHold || 0,
        nextGrade: state.nextGrade != null ? state.nextGrade : (state.gradeTarget || 0),
        bank: state.bank || 0,
        style: state.style || 0
    };
}

function advanceElev(state, rng) {
    if (state.gradeHold <= 0) {
        state.nextGrade = (rng() - 0.5) * 0.18;
        state.gradeHold = 180 + rng() * 160;
    }
    state.gradeHold -= STEP_M;
    var want = state.nextGrade != null ? state.nextGrade : 0;
    // Start leveling before the floor or ceiling. Clamping y while the
    // slope is still steep turns a downhill into a flat in one step, and
    // the nose bottoms the suspension on that kink.
    if (state.y < 18 && want < 0.03) want = 0.03;
    if (state.y > 42 && want > -0.03) want = -0.03;
    var gt = (state.gradeTarget || 0) + (want - (state.gradeTarget || 0)) * 0.08;
    var ev = (state.elevV || 0) + (gt - (state.elevV || 0)) * 0.12;
    var prev = state.elevV || 0;
    // About 0.8% of grade per metre: a 17% slope needs ~20 m to level out,
    // which is several wheelbases, so the front axle is not slammed flat.
    var maxStep = 0.016;
    if (ev > prev + maxStep) ev = prev + maxStep;
    if (ev < prev - maxStep) ev = prev - maxStep;
    if (ev > 0.17) ev = 0.17;
    if (ev < -0.17) ev = -0.17;
    var y = state.y + ev * STEP_M;
    if (y < 9) {
        y = 9;
        if (ev < 0) ev = prev + Math.min(maxStep, -prev);
        if (gt < 0) gt = 0;
    }
    if (y > 52) {
        y = 52;
        if (ev > 0) ev = prev - Math.min(maxStep, prev);
        if (gt > 0) gt = 0;
    }
    state.gradeTarget = gt;
    state.elevV = ev;
    state.y = y;
}

function simulateFrom(cursor, state, curv, meters) {
    var s = copyState(state);
    var minD = Infinity;
    var pts = [];
    var n = Math.max(1, Math.round(meters / STEP_M));
    var i;
    for (i = 0; i < n; i++) {
        s.heading += curv * STEP_M;
        s.x += Math.cos(s.heading) * STEP_M;
        s.z += Math.sin(s.heading) * STEP_M;
        s.dist += STEP_M;
        advanceElev(s, cursor.rng);
        s.bank = 0;
        var saved = cursor.dist;
        cursor.dist = s.dist;
        var d = nearestOld(cursor, s.x, s.z).d;
        cursor.dist = saved;
        if (d < minD) minD = d;
        pts.push({
            heading: s.heading, x: s.x, y: s.y, z: s.z,
            dist: s.dist, curv: curv, elevV: s.elevV,
            bank: s.bank || 0, style: s.style || 0
        });
        if (d < 76) break;
    }
    return { minD: minD, pts: pts, state: s };
}

function drivePieces(cursor, state, pieces) {
    var s = state;
    var pts = [];
    var minD = Infinity;
    var i;
    var k;
    for (i = 0; i < pieces.length; i++) {
        var sim = simulateFrom(cursor, s, pieces[i].curv, pieces[i].meters);
        if (sim.minD < minD) minD = sim.minD;
        for (k = 0; k < sim.pts.length; k++) pts.push(sim.pts[k]);
        s = sim.state;
        if (minD < 76) break;
    }
    return { minD: minD, pts: pts, state: s };
}

/** Angles far enough apart that one corner cannot look like the next. */
var TURN_BOOK = [
    { id: 'nick', deg: 16, curv: 0.0065 },
    { id: 'bend', deg: 48, curv: 0.013 },
    { id: 'corner', deg: 88, curv: 0.018 },
    { id: 'hook', deg: 122, curv: 0.021 },
    { id: 'hairpin', deg: 168, curv: 0.024 }
];
var GRADE_BOOK = [-0.16, -0.08, 0.02, 0.10, 0.17];

function turnPieces(book, sign) {
    var curv = sign * book.curv;
    var meters = (book.deg * Math.PI / 180) / Math.abs(book.curv);
    return [
        { curv: curv * 0.4, meters: meters * 0.2 },
        { curv: curv, meters: meters * 0.6 },
        { curv: curv * 0.3, meters: meters * 0.2 }
    ];
}

/** Keep the new heading. Turning back immediately is the left-right wave. */
function appendRun(cursor, sim, meters) {
    var state = sim.state;
    var left = meters;
    var wobble = (cursor.rng() - 0.5) * 0.005;
    var got = 0;
    while (left > 0) {
        var step = simulateFrom(cursor, state, wobble, STEP_M);
        if (step.minD < CLEAR_M) {
            step = simulateFrom(cursor, state, 0, STEP_M);
            if (step.minD < CLEAR_M) break;
        }
        sim.pts.push(step.pts[0]);
        state = step.state;
        if (step.minD < sim.minD) sim.minD = step.minD;
        left -= STEP_M;
        got += STEP_M;
    }
    sim.state = state;
    return got;
}

function recentTravel(cursor, state) {
    var trail = cursor.trail;
    var best = null;
    var bestErr = Infinity;
    var i;
    for (i = 0; i < trail.length; i += 3) {
        var err = Math.abs((state.dist - trail[i].dist) - 320);
        if (err < bestErr) { bestErr = err; best = trail[i]; }
    }
    if (!best || bestErr > 180) return state.heading;
    return Math.atan2(state.z - best.z, state.x - best.x);
}

function chooseLeg(cursor, state) {
    buildNearGrid(cursor);
    var rng = cursor.rng;
    var pool = GRADE_BOOK;
    if (state.y > 34) pool = [-0.16, -0.09, -0.03];
    else if (state.y < 18) pool = [0.05, 0.11, 0.17];
    var gi = Math.floor(rng() * pool.length);
    var grade = pool[gi];
    if (Math.abs(grade - (cursor.nextGrade || 0)) < 0.05 && pool.length > 1) grade = pool[(gi + 1) % pool.length];
    var style = ((cursor.lastStyle || 0) + 1 + Math.floor(rng() * 3)) % 4;
    var runM = 220 + Math.floor(rng() * 160);
    var goalStep = (60 + rng() * 55) * Math.PI / 180 * (rng() < 0.42 ? -1 : 1);
    var goal = wrapPi((cursor.goal != null ? cursor.goal : state.heading) + goalStep);
    state.nextGrade = grade;
    state.gradeHold = 700;
    state.style = style;
    var legal = [];
    var bi;
    var si;
    function gather(isStrict) {
        var found = [];
        for (bi = 0; bi < TURN_BOOK.length; bi++) {
            var book = TURN_BOOK[bi];
            if (isStrict && (book.id === cursor.lastPhrase || book.id === cursor.prevPhrase)) continue;
            if (isStrict && cursor.lastDeg && Math.abs(book.deg - cursor.lastDeg) < 40) continue;
            if (state.dist < 280 && book.deg < 80) continue;
            for (si = 0; si < 2; si++) {
                var sign = si === 0 ? 1 : -1;
                if (isStrict && sign === cursor.lastSign && book.deg > 100 && (cursor.lastDeg || 0) > 90) continue;
                if (cursor.ban && Math.abs(state.dist - cursor.ban.dist) < 8 && sign === cursor.ban.sign) continue;
                var sim = drivePieces(cursor, state, turnPieces(book, sign));
                if (sim.minD < CLEAR_M) continue;
                var got = appendRun(cursor, sim, runM);
                if (isStrict && got < 90) continue;
                var err = Math.abs(wrapPi(sim.state.heading - goal));
                var typeW = { nick: 1.15, bend: 1.35, corner: 1.3, hook: 1.05, hairpin: 0.42 };
                sim.id = book.id;
                sim.sign = sign;
                sim.deg = book.deg;
                sim.w = typeW[book.id] * (0.45 + Math.abs(book.deg - (cursor.lastDeg || 40)) / 45) / (0.3 + err);
                found.push(sim);
            }
        }
        return found;
    }
    legal = gather(true);
    if (!legal.length) legal = gather(false);
    var best = null;
    if (legal.length) {
        var total = 0;
        var li;
        for (li = 0; li < legal.length; li++) total += legal[li].w;
        var pick = rng() * total;
        var acc = 0;
        for (li = 0; li < legal.length; li++) {
            acc += legal[li].w;
            if (acc >= pick) { best = legal[li]; break; }
        }
        if (!best) best = legal[legal.length - 1];
    }
    if (!best) return null;
    stampLeg(cursor, best);
    cursor.lastStyle = style;
    cursor.nextGrade = grade;
    cursor.goal = goal;
    return best;
}

function tipState(cursor) {
    if (cursor.plan.length) {
        var last = cursor.plan[cursor.plan.length - 1];
        return {
            heading: last.heading, x: last.x, z: last.z, dist: last.dist,
            y: last.y, elevV: last.elevV || 0,
            gradeTarget: cursor.gradeTarget || 0,
            gradeHold: cursor.gradeHold || 0,
            nextGrade: cursor.nextGrade || 0,
            bank: last.bank || 0,
            style: last.style || 0
        };
    }
    return {
        heading: cursor.heading, x: cursor.x, z: cursor.z, dist: cursor.dist,
        y: cursor.y, elevV: cursor.elevV || 0,
        gradeTarget: cursor.gradeTarget || 0,
        gradeHold: cursor.gradeHold || 0,
        nextGrade: cursor.nextGrade || 0,
        bank: cursor.bank || 0,
        style: cursor.style || 0
    };
}

function rememberLeg(cursor, leg) {
    if (!cursor.stack) cursor.stack = [];
    cursor.stack.push({
        n: leg.pts.length,
        sign: leg.sign,
        dist: leg.pts.length ? leg.pts[0].dist : cursor.dist,
        lastSign: leg.prevSign,
        sameRun: leg.prevRun,
        lastDeg: leg.prevDeg,
        lastPhrase: leg.prevPhrase,
        prevPhrase: leg.prevPrevPhrase,
        goal: leg.prevGoal,
        goalSign: leg.prevGoalSign,
        gradeTarget: leg.prevGradeTarget,
        gradeHold: leg.prevGradeHold,
        nextGrade: leg.prevNextGrade,
        elevV: leg.prevElevV,
        lastStyle: leg.prevStyle
    });
    var i;
    for (i = 0; i < leg.pts.length; i++) {
        var p = leg.pts[i];
        cursor.plan.push(p);
        cursor.trail.push({ x: p.x, z: p.z, dist: p.dist, chain: cursor.chain || 0 });
    }
    if (!cursor.phraseLog) cursor.phraseLog = [];
    cursor.phraseLog.push(leg.id + ':' + Math.round(leg.deg || 0));
    cursor.gradeTarget = leg.state.gradeTarget;
    cursor.gradeHold = leg.state.gradeHold;
    cursor.nextGrade = leg.state.nextGrade;
    cursor.elevV = leg.state.elevV;
}

function rewindLeg(cursor) {
    var stack = cursor.stack;
    if (!stack || !stack.length) return false;
    var mark = stack[stack.length - 1];
    if (cursor.plan.length < mark.n) return false;
    stack.pop();
    cursor.plan.splice(cursor.plan.length - mark.n, mark.n);
    cursor.trail.splice(cursor.trail.length - mark.n, mark.n);
    if (cursor.phraseLog && cursor.phraseLog.length) cursor.phraseLog.pop();
    cursor.ban = { sign: mark.sign, dist: mark.dist };
    cursor.lastSign = mark.lastSign;
    cursor.sameRun = mark.sameRun;
    cursor.lastDeg = mark.lastDeg;
    cursor.lastPhrase = mark.lastPhrase || '';
    cursor.prevPhrase = mark.prevPhrase || '';
    cursor.goal = mark.goal;
    cursor.goalSign = mark.goalSign || 1;
    cursor.gradeTarget = mark.gradeTarget || 0;
    cursor.gradeHold = mark.gradeHold || 0;
    cursor.nextGrade = mark.nextGrade || 0;
    cursor.elevV = mark.elevV || 0;
    cursor.lastStyle = mark.lastStyle || 0;
    return true;
}

function stampLeg(cursor, best) {
    best.prevSign = cursor.lastSign;
    best.prevRun = cursor.sameRun || 0;
    best.prevDeg = cursor.lastDeg;
    best.prevPhrase = cursor.lastPhrase || '';
    best.prevPrevPhrase = cursor.prevPhrase || '';
    best.prevGoal = cursor.goal;
    best.prevGoalSign = cursor.goalSign || 1;
    best.prevGradeTarget = cursor.gradeTarget || 0;
    best.prevGradeHold = cursor.gradeHold || 0;
    best.prevNextGrade = cursor.nextGrade || 0;
    best.prevElevV = cursor.elevV || 0;
    best.prevStyle = cursor.lastStyle || 0;
    cursor.sameRun = best.sign === cursor.lastSign ? (cursor.sameRun || 0) + 1 : 0;
    cursor.lastSign = best.sign;
    cursor.lastDeg = best.deg;
    cursor.prevPhrase = cursor.lastPhrase || '';
    cursor.lastPhrase = best.id;
}

/** Last resort when every phrase is boxed in. A short clear step, no new random rolls. */
function squeezeLeg(cursor, state) {
    buildNearGrid(cursor);
    var best = null;
    var turn;
    var cx = 0;
    var cz = 0;
    var cn = 0;
    var ti;
    var trail = cursor.trail;
    for (ti = 0; ti < trail.length; ti += 4) {
        if (state.dist - trail[ti].dist < 60 || state.dist - trail[ti].dist > 700) continue;
        cx += trail[ti].x;
        cz += trail[ti].z;
        cn++;
    }
    var outH = cn ? Math.atan2(state.z - cz / cn, state.x - cx / cn) : state.heading;
    for (turn = -0.022; turn <= 0.0221; turn += 0.004) {
        var sim = simulateFrom(cursor, state, turn, 72);
        if (sim.minD < 76) continue;
        var out = Math.abs(wrapPi(sim.state.heading - outH));
        sim.score = sim.minD + (Math.PI - out) * 40;
        if (!best || sim.score > best.score) best = sim;
    }
    if (!best) return null;
    best.id = 'squeeze';
    best.sign = (best.pts[best.pts.length - 1].curv || 0) >= 0 ? 1 : -1;
    best.deg = 24;
    stampLeg(cursor, best);
    return best;
}

/** Centerline only, far enough ahead that the next bends already avoid each other. */
function ensurePlan(cursor, untilDist) {
    if (cursor.failDist && cursor.dist < cursor.failDist) return;
    var guard = 0;
    var rewinds = 0;
    var squeezes = 0;
    while (guard++ < 80) {
        var tip = tipState(cursor);
        if (tip.dist >= untilDist) {
            cursor.failDist = 0;
            return;
        }
        var leg = chooseLeg(cursor, tip);
        if (leg) {
            rememberLeg(cursor, leg);
            rewinds = 0;
            squeezes = 0;
            continue;
        }
        if (rewinds++ <= 16 && rewindLeg(cursor)) continue;
        if (squeezes++ < 6) {
            var sq = squeezeLeg(cursor, tipState(cursor));
            if (sq) {
                rememberLeg(cursor, sq);
                rewinds = 0;
                continue;
            }
        }
        cursor.failDist = cursor.dist + 120;
        return;
    }
}

function stepCursor(cursor) {
    ensurePlan(cursor, cursor.dist + PLAN_AHEAD_M);
    if (!cursor.plan.length) return;
    var nxt = cursor.plan.shift();
    cursor.curv = nxt.curv;
    cursor.heading = nxt.heading;
    cursor.x = nxt.x;
    cursor.y = nxt.y;
    cursor.z = nxt.z;
    cursor.elevV = nxt.elevV || 0;
    cursor.bank = nxt.bank || 0;
    cursor.style = nxt.style || 0;
    cursor.dist = nxt.dist;
}

/** Centerline only — used to prove the road does not coil or cross itself. */
export function walkEndless(seed, meters) {
    var cursor = createEndlessCursor(seed);
    var pts = [{ x: cursor.x, y: cursor.y, z: cursor.z, dist: 0 }];
    var guard = 0;
    var prevDist = -1;
    while (cursor.dist < meters && guard < meters) {
        guard++;
        prevDist = cursor.dist;
        stepCursor(cursor);
        if (cursor.dist <= prevDist) break;
        pts.push({ x: cursor.x, y: cursor.y, z: cursor.z, dist: cursor.dist });
    }
    pts.phrases = cursor.phraseLog || [];
    return pts;
}

function buildOpenFrames(pts, dist0) {
    var frames = [];
    var dist = dist0;
    var i;
    for (i = 0; i < pts.length; i++) {
        var prev = pts[Math.max(0, i - 1)];
        var next = pts[Math.min(pts.length - 1, i + 1)];
        var fx = next.x - prev.x;
        var fz = next.z - prev.z;
        var fl = Math.hypot(fx, fz) || 1;
        fx /= fl;
        fz /= fl;
        if (i > 0) dist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        frames.push({
            x: pts[i].x, y: pts[i].y, z: pts[i].z,
            fx: fx, fz: fz, rx: fz, rz: -fx,
            dist: dist, turn: 0, bank: pts[i].bank || 0
        });
    }
    for (i = 1; i < frames.length; i++) {
        var a = Math.atan2(frames[i].fz, frames[i].fx);
        var b = Math.atan2(frames[i - 1].fz, frames[i - 1].fx);
        var turn = a - b;
        while (turn > Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        frames[i].turn = turn;
    }
    return frames;
}

function openSkirt(frames) {
    var THREE = window.THREE;
    var lats = [16, 28, 44, 64, 88];
    var positions = [];
    var uvs = [];
    var indices = [];
    function addSide(sign) {
        var rows = [];
        var fi, li;
        for (fi = 0; fi < frames.length; fi++) {
            var f = frames[fi];
            var row = [];
            for (li = 0; li < lats.length; li++) {
                var lat = sign * lats[li];
                var fade = (lats[li] - 16) / 72;
                var px = f.x + f.rx * lat;
                var pz = f.z + f.rz * lat;
                var y = f.y - 0.05 - fade * 0.35;
                row.push(positions.length / 3);
                positions.push(px, y, pz);
                uvs.push(px * 0.08, pz * 0.08);
            }
            rows.push(row);
        }
        var r, c;
        for (r = 0; r < rows.length - 1; r++) {
            for (c = 0; c < lats.length - 1; c++) {
                var a = rows[r][c];
                var b = rows[r][c + 1];
                var d = rows[r + 1][c];
                var e = rows[r + 1][c + 1];
                indices.push(a, d, b, b, d, e);
            }
        }
    }
    addSide(1);
    addSide(-1);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: 0x5d7348, roughness: 1, metalness: 0, side: THREE.DoubleSide
    }));
    mesh.name = 'Terrain_Outer';
    mesh.receiveShadow = true;
    return mesh;
}

function rebaseFrames(frames) {
    var d0 = frames[0].dist;
    return frames.map(function(f) {
        return {
            x: f.x, y: f.y, z: f.z,
            fx: f.fx, fz: f.fz, rx: f.rx, rz: f.rz,
            dist: f.dist - d0, turn: f.turn, bank: f.bank || 0
        };
    });
}

function appendSection(cursor) {
    var THREE = window.THREE;
    var startDist = cursor.dist;
    var raw = [{ x: cursor.x, y: cursor.y, z: cursor.z, bank: cursor.bank || 0, style: cursor.style || 0 }];
    var guard = 0;
    while ((cursor.dist - startDist) < SECTION_M && guard < 200) {
        guard++;
        stepCursor(cursor);
        raw.push({ x: cursor.x, y: cursor.y, z: cursor.z, bank: cursor.bank || 0, style: cursor.style || 0 });
    }
    var frames = buildOpenFrames(raw, startDist);
    var points = frames.map(function(f) {
        return new THREE.Vector3(f.x, f.y, f.z);
    });
    return {
        id: 0,
        startDist: startDist,
        endDist: frames[frames.length - 1].dist,
        frames: frames,
        points: points,
        group: null,
        dropped: false,
        style: raw[raw.length - 1].style || 0
    };
}

function framesTouch(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return false;
    var p = a[a.length - 1];
    var q = b[0];
    return Math.hypot(p.x - q.x, p.z - q.z) < 8;
}

function xzSpanOf(frames) {
    if (!frames || frames.length < 2) return 0;
    var a = frames[0];
    var b = frames[frames.length - 1];
    return Math.hypot(b.x - a.x, b.z - a.z);
}

function buildRoad(section, bag, prevFrames, nextFrames) {
    var base = section.frames;
    // Only stitch a neighbor that actually meets this section. A failed
    // backward walk sits on one point; stitching the real road onto it
    // stretches a ribbon across the gap and deletes the spawn.
    if (prevFrames && prevFrames.length > 3 && framesTouch(prevFrames, base)) {
        base = prevFrames.slice(-40, -1).concat(base);
    }
    if (nextFrames && nextFrames.length > 3 && framesTouch(base, nextFrames)) {
        base = base.concat(nextFrames.slice(1, 40));
    }
    var frames = densifyFrames(base, { maxTurn: 0.10, maxStep: 0.9 });
    var grass = buildRibbon(frames, -16, 16, {
        name: 'Path_Grass', uvMode: 'planar', uvPerM: 0.08, y: 0.01, order: 1,
        color: 0x6a7a4a, latStep: 2
    });
    var bedFrames = slideFrames(frames, 0.5);
    var roadbed = buildRibbon(bedFrames, -4.2, 4.2, {
        name: 'Path_Roadbed', uvPerM: 0.12, y: 0.012, order: 2, color: 0x5a4a38,
        v0: 0.22, v1: 0.78, latStep: 1.5
    });
    var dirt = buildRibbon(frames, -5.5, 5.5, {
        name: 'Path_Dirt', uvPerM: 0.12, y: 0.02, order: 2, color: 0x8d7b62,
        v0: 0.0, v1: 1.0, latStep: 1.5
    });
    var gravelR = buildSoftGravel(frames, 4.4, 6.2, { name: 'Path_Gravel_R', y: 0.03, order: 4 });
    var gravelL = buildSoftGravel(frames, -6.2, -4.4, {
        name: 'Path_Gravel_L', y: 0.03, order: 4, v0: 0.92, v1: 0.42
    });
    beginFrameIndex(frames, 24);
    sealGrassUnderCarriage(frames, grass, 5.2);
    endFrameIndex();
    var skirt = openSkirt(frames);
    applyForestRoadSurfaceMats({
        grass: grass, dirt: dirt, roadbed: roadbed,
        gravelR: gravelR, gravelL: gravelL, terrainOuter: skirt
    }, bag);
    if (dirt.material) {
        dirt.material.transparent = true;
        dirt.material.depthWrite = false;
        dirt.material.alphaTest = 0.04;
        dirt.material.needsUpdate = true;
    }
    gravelR.visible = true;
    gravelL.visible = true;
    var group = new window.THREE.Group();
    group.name = 'endless_section';
    group.add(grass, roadbed, dirt, gravelR, gravelL, skirt);
    section.group = group;
    section.ground = [dirt, grass, skirt];
    return group;
}

function collectBag(gltf) {
    var bag = {};
    gltf.scene.traverse(function(o) {
        if (!o.isMesh || !o.material) return;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        var n = (mats[0] && mats[0].name) || '';
        if (n === 'Dirt_Road.001' && !bag.dirtMesh) { bag.dirt = mats[0]; bag.dirtMesh = o; }
        else if (n === 'Road_Edge_Gravel_Dusty.001') bag.gravel = mats[0];
        else if (n === 'Grass_Close.001') bag.grass = mats[0];
        else if (n === 'Ground_Dirt.002') bag.ground = mats[0];
    });
    return bag;
}

/**
 * @param {object} api scene, loader, splash, setRoot, addGround, dropGroup,
 *   installPath, armSolids, carPos, onReady
 */
function bootSeed() {
    var q = '';
    try { q = window.location.search || ''; } catch (e) { q = ''; }
    var m = /(?:\?|&)seed=(\d+)/.exec(q);
    if (m) return (parseInt(m[1], 10) | 0) || 1;
    return (Date.now() ^ (Math.random() * 0x7fffffff)) | 0;
}

/** Reject a seed whose first 2 km already boxes in. A boxed seed is a dead end, not an endless road. */
function createPlayableCursor(seed) {
    var base = seed | 0;
    var i;
    for (i = 0; i < 6; i++) {
        var cursor = createEndlessCursor((base + i * 997) | 0);
        ensurePlan(cursor, 2200);
        if (tipState(cursor).dist >= 2000) return cursor;
    }
    var fallback = createEndlessCursor(base);
    ensurePlan(fallback, 2200);
    return fallback;
}

export function startEndlessTrack(api) {
    var sections = [];
    var root = new window.THREE.Group();
    root.name = 'endless_track';
    api.scene.add(root);
    api.setRoot(root);
    var cursor = createPlayableCursor(bootSeed());
    var bag = null;
    var gltf = null;
    var dead = false;
    var building = false;
    var timer = 0;
    var nextId = 1;
    var backCursor = null;
    var backFailAt = 0;
    var everSeated = false;
    var lowArchive = [];
    var highArchive = [];

    function pathPoints() {
        var pts = [];
        sections.forEach(function(section, si) {
            if (xzSpanOf(section.frames) < 20) return;
            section.points.forEach(function(p, i) {
                if (si > 0 && i === 0) return;
                pts.push(p);
            });
        });
        return pts;
    }

    function publishPath() {
        var pts = pathPoints();
        if (pts.length >= 8) api.installPath(pts);
    }

    function distAt(pos) {
        if (!pos || !sections.length) return null;
        var best = null;
        var bestD = 1e18;
        var s;
        var i;
        for (s = 0; s < sections.length; s++) {
            var fr = sections[s].frames;
            if (xzSpanOf(fr) < 20) continue;
            for (i = 0; i < fr.length; i += 2) {
                var dx = fr[i].x - pos.x;
                var dz = fr[i].z - pos.z;
                var d = dx * dx + dz * dz;
                if (d < bestD) { bestD = d; best = fr[i].dist; }
            }
        }
        return best;
    }

    function carDist() {
        var c = api.carPos && api.carPos();
        var d = distAt(c);
        // No chassis yet, or it is still at the world origin. The road also
        // starts at the origin, so that point must not be treated as the car
        // or every tick grows a fake section backward and drops the spawn.
        if (d == null) return spawnDist;
        return d;
    }

    function windowSpan() {
        // The window follows the player only. A stuck police car used to pin
        // `lo` at its own distance, so every section behind the driver stayed
        // resident and the road never unloaded.
        var dist = carDist();
        return { dist: dist, lo: dist, hi: dist };
    }

    function disposeSectionGroup(group) {
        var meshes = [];
        group.traverse(function(o) {
            if (o.isMesh) meshes.push(o);
        });
        var i = 0;
        function pump() {
            var n = 0;
            var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
            while (i < meshes.length && n < 6) {
                var o = meshes[i++];
                var mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
                var mi;
                for (mi = 0; mi < mats.length; mi++) {
                    if (mats[mi] && mats[mi].dispose) mats[mi].dispose();
                }
                // Trunks, cards, and verge plants share the kit geometry. Disposing it
                // deletes the GPU buffer still used by every section still on screen.
                if (o.isInstancedMesh) {
                    if (o.dispose) o.dispose();
                } else if (o.geometry && o.geometry.dispose) {
                    o.geometry.dispose();
                }
                n++;
                var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                if (now - t0 > 3) break;
            }
            if (i < meshes.length) setTimeout(pump, 0);
        }
        setTimeout(pump, 0);
    }

    function dropSection(section) {
        section.dropped = true;
        if (!section.group) return;
        var group = section.group;
        api.dropGroup(group);
        if (group.parent) group.parent.remove(group);
        disposeSectionGroup(group);
    }

    function varySectionDress(group, style) {
    if (!group || !style) return;
    var THREE = window.THREE;
    var mat = new THREE.Matrix4();
    var pos = new THREE.Vector3();
    var quat = new THREE.Quaternion();
    var scl = new THREE.Vector3();
    group.updateMatrixWorld(true);
    group.traverse(function(o) {
        if (!o.isInstancedMesh || !o.count) return;
        var name = o.name || '';
        var changed = false;
        var i;
        for (i = 0; i < o.count; i++) {
            o.getMatrixAt(i, mat);
            mat.decompose(pos, quat, scl);
            if (scl.x < 0.05) continue;
            var n = (i * 13 + style * 7) % 10;
            var touch = false;
            if (/Background_Tree|Card/i.test(name)) {
                if ((style === 1 && n < 8) || (style === 2 && n < 7) || (style === 3 && n < 4)) {
                    pos.y = -500;
                    scl.set(0.001, 0.001, 0.001);
                    touch = true;
                }
            } else if (/Trunk/i.test(name)) {
                scl.multiplyScalar(style === 1 ? 0.48 : (style === 2 ? 0.72 : 1.45));
                touch = true;
            } else if (/Rocks/i.test(name) && style === 2) {
                scl.multiplyScalar(1.75);
                touch = true;
            } else if (/Sapling/i.test(name) && style === 1) {
                scl.multiplyScalar(1.45);
                touch = true;
            }
            if (!touch) continue;
            mat.compose(pos, quat, scl);
            o.setMatrixAt(i, mat);
            changed = true;
        }
        if (changed) {
            o.instanceMatrix.needsUpdate = true;
            o.computeBoundingSphere();
        }
    });
}

function clearTreesOffDirt(groups, trail) {
        var THREE = window.THREE;
        var mat = new THREE.Matrix4();
        var world = new THREE.Matrix4();
        var pos = new THREE.Vector3();
        var quat = new THREE.Quaternion();
        var scl = new THREE.Vector3();
        var limit = 7.2 * 7.2;
        var cell = 16;
        var grid = new Map();
        var t;
        for (t = 0; t < trail.length; t += 2) {
            var tp = trail[t];
            var key = ((tp.x / cell) | 0) + ',' + ((tp.z / cell) | 0);
            var bucket = grid.get(key);
            if (!bucket) {
                bucket = [];
                grid.set(key, bucket);
            }
            bucket.push(tp);
        }
        groups.forEach(function(group) {
            if (!group) return;
            group.updateMatrixWorld(true);
            group.traverse(function(o) {
                if (!o.isInstancedMesh || !o.count) return;
                if (!/Trunk|Sapling|Branch|Background_Tree|Rocks_JS/i.test(o.name || '')) return;
                var changed = false;
                for (var i = 0; i < o.count; i++) {
                    o.getMatrixAt(i, mat);
                    world.multiplyMatrices(o.matrixWorld, mat);
                    world.decompose(pos, quat, scl);
                    if (scl.x < 0.05) continue;
                    var bad = false;
                    var gx = (pos.x / cell) | 0;
                    var gz = (pos.z / cell) | 0;
                    var ga;
                    var gb;
                    for (ga = -1; ga <= 1 && !bad; ga++) {
                        for (gb = -1; gb <= 1 && !bad; gb++) {
                            var near = grid.get((gx + ga) + ',' + (gz + gb));
                            if (!near) continue;
                            for (var ni = 0; ni < near.length; ni++) {
                                var dx = pos.x - near[ni].x;
                                var dz = pos.z - near[ni].z;
                                if (dx * dx + dz * dz < limit) { bad = true; break; }
                            }
                        }
                    }
                    if (!bad) continue;
                    // Bury it. Scale 0 still gets a minimum physics cylinder.
                    pos.y = -500;
                    scl.set(0.001, 0.001, 0.001);
                    mat.compose(pos, quat, scl);
                    o.setMatrixAt(i, mat);
                    changed = true;
                }
                if (changed) {
                    o.instanceMatrix.needsUpdate = true;
                    o.computeBoundingSphere();
                }
            });
        });
    }

    function dress(section) {
        if (dead || section.dropped || !section.group) return Promise.resolve();
        var local = rebaseFrames(section.frames);
        return placeForestKit(api.loader, local, section.group).then(function() {
            if (dead || section.dropped) return null;
            return placeFrRoadside(api.loader, local, section.group, { gltf: gltf });
        }).then(function() {
            if (dead || section.dropped || !section.group) return;
            clearTreesOffDirt(sections.map(function(s) { return s.group; }), cursor.trail);
            varySectionDress(section.group, section.style);
            var solids = [];
            section.group.traverse(function(o) {
                if (!o.isInstancedMesh) return;
                if (/Trunk_JS|Sapling_JS|Rocks_JS/i.test(o.name || '')) solids.push(o);
            });
            if (solids.length) api.armSolids(solids);
            section.dressed = true;
        });
    }

    function addSection() {
        var prev = sections.length ? sections[sections.length - 1].frames : null;
        var section = appendSection(cursor);
        section.id = nextId++;
        var group = buildRoad(section, bag, prev);
        root.add(group);
        sections.push(section);
        publishPath();
        var grounds = section.ground || [];
        var chain = Promise.resolve();
        grounds.forEach(function(mesh) {
            chain = chain.then(function() {
                if (dead || section.dropped) return null;
                return api.addGround(mesh);
            });
        });
        return chain.then(function() { return dress(section); }).then(function() {
            console.log('🛤️ Endless section', section.id,
                Math.round(section.startDist) + '–' + Math.round(section.endDist) + 'm');
            return section;
        });
    }

    function finishSection(section, where) {
        var grounds = section.ground || [];
        var chain = Promise.resolve();
        grounds.forEach(function(mesh) {
            chain = chain.then(function() {
                if (dead || section.dropped) return null;
                return api.addGround(mesh);
            });
        });
        return chain.then(function() { return dress(section); }).then(function() {
            console.log('🛤️ Endless section', section.id,
                Math.round(section.startDist) + '–' + Math.round(section.endDist) + 'm',
                where || '');
            return section;
        });
    }

    function ensureBackCursor(head) {
        if (backCursor) return;
        var origin = head.frames[0];
        var ahead = head.frames[Math.min(4, head.frames.length - 1)];
        var run = Math.hypot(ahead.x - origin.x, ahead.z - origin.z) || 1;
        var forwardGrade = (ahead.y - origin.y) / run;
        backCursor = createEndlessCursor((bootSeed() ^ 0x51ed) || 1);
        backCursor.chain = 1;
        backCursor.trail = cursor.trail;
        backCursor.plan = [];
        backCursor.stack = [];
        backCursor.nearGrid = null;
        backCursor.x = origin.x;
        backCursor.y = origin.y;
        backCursor.z = origin.z;
        backCursor.heading = Math.atan2(-origin.fz, -origin.fx);
        backCursor.elevV = -forwardGrade;
        backCursor.gradeTarget = -forwardGrade;
        backCursor.nextGrade = -forwardGrade;
        backCursor.gradeHold = 80;
        // Own distance space so clearance does not confuse this chain with the forward road.
        backCursor.dist = 10000000;
        backCursor.attach = { x: origin.x, z: origin.z };
    }

    function addBackSection() {
        var head = sections[0];
        if (!head || !head.frames || head.frames.length < 2) return Promise.resolve();
        ensureBackCursor(head);
        var anchorWorld = head.startDist;
        var anchorCursor = backCursor.dist;
        var section = appendSection(backCursor);
        if (xzSpanOf(section.frames) < 40) {
            // The walk never left the join. Drop the stuck cursor so the
            // next attempt starts clean, and do not publish a point-section.
            backCursor = null;
            backFailAt = Date.now();
            return Promise.resolve();
        }
        var length = Math.max(1, section.endDist - anchorCursor);
        var raw = [];
        var i;
        for (i = section.frames.length - 1; i >= 0; i--) {
            var f = section.frames[i];
            raw.push({ x: f.x, y: f.y, z: f.z, bank: f.bank || 0, style: f.style || 0 });
        }
        var frames = buildOpenFrames(raw, anchorWorld - length);
        section.frames = frames;
        section.points = frames.map(function(fr) {
            return new window.THREE.Vector3(fr.x, fr.y, fr.z);
        });
        section.startDist = frames[0].dist;
        section.endDist = frames[frames.length - 1].dist;
        section.id = nextId++;
        section.dropped = false;
        var group = buildRoad(section, bag, null, head.frames);
        root.add(group);
        sections.unshift(section);
        publishPath();
        return finishSection(section, 'back');
    }

    function restoreSection(section, end) {
        section.dropped = false;
        section.group = null;
        section.ground = null;
        var prev = end === 'high' ? sections[sections.length - 1] : null;
        var next = end === 'low' ? sections[0] : null;
        var group = buildRoad(section, bag, prev && prev.frames, next && next.frames);
        root.add(group);
        if (end === 'low') sections.unshift(section);
        else sections.push(section);
        publishPath();
        return finishSection(section, 'restored');
    }

    function extendForward() {
        var archived = highArchive.length ? highArchive[highArchive.length - 1] : null;
        if (archived) {
            highArchive.pop();
            building = true;
            restoreSection(archived, 'high').then(function() { building = false; }, function(err) {
                building = false;
                console.warn('Endless section failed', err);
            });
            return;
        }
        building = true;
        addSection().then(function() { building = false; }, function(err) {
            building = false;
            console.warn('Endless section failed', err);
        });
    }

    function extendBack() {
        if (backFailAt && (Date.now() - backFailAt) < 2500) return;
        var archived = lowArchive.length ? lowArchive[lowArchive.length - 1] : null;
        if (archived) {
            lowArchive.pop();
            building = true;
            restoreSection(archived, 'low').then(function() { building = false; }, function(err) {
                building = false;
                console.warn('Endless back section failed', err);
            });
            return;
        }
        building = true;
        addBackSection().then(function() { building = false; }, function(err) {
            building = false;
            console.warn('Endless back section failed', err);
        });
    }

    function retireSection(section, which) {
        dropSection(section);
        section.group = null;
        section.ground = null;
        if (which === 'low') lowArchive.push(section);
        else highArchive.push(section);
    }

    function frameNearDist(dist) {
        var best = null;
        var bestErr = 1e9;
        var s;
        var i;
        for (s = 0; s < sections.length; s++) {
            var fr = sections[s].frames;
            if (!fr || xzSpanOf(fr) < 20) continue;
            for (i = 0; i < fr.length; i++) {
                var err = Math.abs(fr[i].dist - dist);
                if (err < bestErr) { bestErr = err; best = fr[i]; }
            }
        }
        return best;
    }

    function firstLongSection() {
        var i;
        for (i = 0; i < sections.length; i++) {
            if (xzSpanOf(sections[i].frames) >= 40) return sections[i];
        }
        return sections[0];
    }

    function tick(forcedDist) {
        if (dead || building || !bag || !sections.length) return;
        // The splash and the menu have no car on the road. Streaming then
        // would grow backward and drop the spawn section.
        if (forcedDist == null && api.started && !api.started()) return;
        var span = windowSpan();
        // Boot already has a full section behind the spawn and road ahead of
        // it. Leave that window alone until the car has driven off it.
        // A chassis that is not near the spawn yet (origin, or not created)
        // must not move the window either.
        if (forcedDist == null) {
            var seat = api.carPos && api.carPos();
            if (!seat) return;
            // Only the boot gate needs the spawn section to still be loaded.
            // After it is dropped, frameNearDist(spawnDist) is gone and a
            // required home check here froze streaming for the rest of the drive.
            if (!everSeated) {
                var home = frameNearDist(spawnDist);
                if (!home) return;
                if (Math.hypot(seat.x - home.x, seat.z - home.z) < 40) everSeated = true;
                if (!everSeated) return;
            }
            if (Math.abs(span.dist - spawnDist) < 50) return;
        }
        var lo = forcedDist != null ? forcedDist : span.lo;
        var hi = forcedDist != null ? forcedDist : span.hi;
        // Drop from the back once the player has left it. holdsSpawn used to
        // freeze the spawn section at the front of the list, and every later
        // section stayed loaded behind it.
        while (sections.length > 2 && sections[0].endDist < lo - BEHIND_M) {
            retireSection(sections.shift(), 'low');
            publishPath();
        }
        while (sections.length > 2 && sections[sections.length - 1].startDist > hi + AHEAD_M) {
            retireSection(sections.pop(), 'high');
            publishPath();
        }
        var first = firstLongSection();
        var last = sections[sections.length - 1];
        if (!first || !last) return;
        var backGap = lo - first.startDist;
        var forwardGap = last.endDist - hi;
        // The road in front is the one the player is about to drive off.
        // Filling behind first was using the only build slot and the
        // forward road stopped appearing.
        if (forwardGap < AHEAD_M) extendForward();
        else if (backGap < BEHIND_M) extendBack();
    }

    var lastPumpMs = 0;
    var STREAM_MS = 400;

    function pump() {
        if (dead) return;
        var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (lastPumpMs && (now - lastPumpMs) < STREAM_MS) return;
        lastPumpMs = now;
        tick(null);
    }

    function stop() {
        dead = true;
        if (timer) clearInterval(timer);
        timer = 0;
    }

    var handle = {
        stop: stop,
        sections: sections,
        // Quest immersive throttles window timers. Call pump() from the XR
        // animation loop. tickAt stays for forced tests.
        pump: pump,
        tickAt: function(dist) { tick(dist); },
        get closed() { return false; },
        get endDist() { return sections.length ? sections[sections.length - 1].endDist : 0; },
        get busy() { return building; },
        get spawnDist() { return spawnDist; },
        get spawnPos() {
            var best = frameNearDist(spawnDist);
            return best ? { x: best.x, y: best.y, z: best.z } : null;
        }
    };
    var spawnDist = SECTION_M;
    window.__endless = handle;

    api.splash(12, 'Loading Endless materials…');
    api.loader.load('assets/tracks/forest-road.glb', function(loaded) {
        if (dead) return;
        try {
            gltf = loaded;
            bag = collectBag(loaded);
            api.splash(40, 'Laying the first bends…');
            building = true;
            addSection().then(function() {
                return addSection();
            }).then(function() {
                return addSection();
            }).then(function() {
                // The join between the first two sections is a hard edge. Sitting
                // on it drops the chassis through the cut. Spawn part-way into
                // the second section so a full section is behind the car and
                // the road ahead is already meshed.
                var under = sections.length > 1 ? sections[1] : sections[0];
                if (under) {
                    spawnDist = under.startDist + (under.endDist - under.startDist) * 0.45;
                }
                building = false;
                if (dead) return;
                api.splash(100, 'Ready');
                api.onReady();
                // Desktop backup only. Standalone Quest XR does not run this
                // reliably once the immersive session has started — pump() does.
                timer = setInterval(pump, STREAM_MS);
            }).catch(function(err) {
                building = false;
                console.error('Endless boot failed', err);
                api.splash(100, 'Endless failed');
                api.onReady();
            });
        } catch (err) {
            building = false;
            console.error('Endless boot failed', err);
            api.onReady();
        }
    }, undefined, function(err) {
        console.error('Endless material load failed', err);
        api.onReady();
    });

    return handle;
}
