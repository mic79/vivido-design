/**
 * Runtime JS track composer — Forest Road kit quality without Blender.
 * Builds ribbons + terrain + instanced roadside from the same placement bands
 * as tools/compose-path-map.py place_outside_forest().
 *
 * Uses window.THREE (same copy as index.html) — never import 'three' here.
 */
let THREE = globalThis.window && globalThis.window.THREE;
function useTHREE() {
    if (!THREE) THREE = globalThis.window && globalThis.window.THREE;
    if (!THREE) throw new Error('composeJsTrack: window.THREE not ready');
    return THREE;
}

const TREE_KIT_URL = 'assets/props/low_poly_forest_tree_pack.glb';
/** Same Forest Road source meshes PY compose-path-map.py scatters as FR_Grass / FR_Forest_Bush. */
const FR_SOURCE_URL = 'assets/tracks/forest-road.glb';

/**
 * Centerline metrics for review gates (FR-like: short straights, stacked shelves).
 * pts: [{x,y,z}] or THREE.Vector3[]
 */
export function measureTrackCenterline(pts) {
    var n = pts && pts.length;
    if (!n) {
        return { len: 0, elevSpan: 0, maxStraight: 0, straightRuns: 0, meanCurv: 0,
            stackHits: 0, bestStack: null, bestDy: 0, rP5: null, rMed: null };
    }
    function px(i) { var p = pts[(i + n) % n]; return { x: p.x, y: p.y, z: p.z }; }
    var len = 0, maxY = -1e9, minY = 1e9, i;
    for (i = 0; i < n; i++) {
        var a = px(i), b = px(i + 1);
        len += Math.hypot(b.x - a.x, b.z - a.z);
        if (a.y > maxY) maxY = a.y;
        if (a.y < minY) minY = a.y;
    }
    var straight = 0, maxStraight = 0, straightRuns = 0, absTurn = 0;
    var gentle = 0, maxGentle = 0;
    var radii = [];
    for (i = 0; i < n; i++) {
        var p0 = px(i - 1), p1 = px(i), p2 = px(i + 1);
        var d = Math.atan2(p2.z - p1.z, p2.x - p1.x) - Math.atan2(p1.z - p0.z, p1.x - p0.x);
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        absTurn += Math.abs(d);
        var step = Math.hypot(p2.x - p1.x, p2.z - p1.z) || 1;
        var kAbs = Math.abs(d) / step;
        if (kAbs > 0.01) radii.push(1 / kAbs);
        if (kAbs < 0.0035) {
            straight += step;
            if (straight > maxStraight) maxStraight = straight;
        } else {
            if (straight > 20) straightRuns++;
            straight = 0;
        }
        if (kAbs < 0.01) {
            gentle += step;
            if (gentle > maxGentle) maxGentle = gentle;
        } else {
            gentle = 0;
        }
    }
    if (straight > 20) straightRuns++;
    radii.sort(function(u, v) { return u - v; });
    var stackHits = 0, bestStack = 1e9, bestDy = 0;
    for (i = 0; i < n; i += 3) {
        var acc = 0;
        for (var j = 1; j < n; j++) {
            var s0 = px(i + j - 1), s1 = px(i + j);
            acc += Math.hypot(s1.x - s0.x, s1.z - s0.z);
            if (acc < 200) continue;
            if (acc > len * 0.55) break;
            var p = px(i), q = px(i + j);
            var dxz = Math.hypot(p.x - q.x, p.z - q.z);
            var dy = Math.abs(p.y - q.y);
            if (dy >= 18 && dxz < 85) {
                stackHits++;
                if (dxz < bestStack) { bestStack = dxz; bestDy = dy; }
            }
        }
    }
    function pct(arr, t) {
        if (!arr.length) return null;
        return arr[Math.min(arr.length - 1, Math.floor(arr.length * t))];
    }
    return {
        n: n,
        len: +len.toFixed(1),
        elevSpan: +(maxY - minY).toFixed(1),
        minY: +minY.toFixed(2),
        maxY: +maxY.toFixed(2),
        maxStraight: +maxStraight.toFixed(1),
        straightRuns: straightRuns,
        meanCurv: +(absTurn / Math.max(1, len)).toFixed(4),
        maxGentleRun: +maxGentle.toFixed(1),
        stackHits: stackHits,
        bestStack: bestStack < 1e8 ? +bestStack.toFixed(1) : null,
        bestDy: +bestDy.toFixed(1),
        rP5: pct(radii, 0.05) != null ? +pct(radii, 0.05).toFixed(1) : null,
        rMed: pct(radii, 0.5) != null ? +pct(radii, 0.5).toFixed(1) : null,
        maxStepDeg: (function() {
            var m = 0;
            for (var t = 0; t < n; t++) {
                var q0 = px(t), q1 = px(t + 1), q2 = px(t + 2);
                var dd = Math.atan2(q2.z - q1.z, q2.x - q1.x) - Math.atan2(q1.z - q0.z, q1.x - q0.x);
                while (dd > Math.PI) dd -= Math.PI * 2;
                while (dd < -Math.PI) dd += Math.PI * 2;
                if (Math.abs(dd) > m) m = Math.abs(dd);
            }
            return +(m * 180 / Math.PI).toFixed(2);
        })(),
        minApproach: (function() {
            var best = 1e9;
            for (var ii = 0; ii < n; ii += 4) {
                var accA = 0;
                for (var jj = 1; jj < n; jj++) {
                    var s0 = px(ii + jj - 1), s1 = px(ii + jj);
                    accA += Math.hypot(s1.x - s0.x, s1.z - s0.z);
                    if (accA < 70) continue;
                    if (accA > len * 0.45) break;
                    var dxa = Math.hypot(px(ii).x - px(ii + jj).x, px(ii).z - px(ii + jj).z);
                    if (dxa < best) best = dxa;
                }
            }
            return best < 1e8 ? +best.toFixed(1) : null;
        })(),
        turn30P50: (function() {
            var wins = [];
            for (var tw = 0; tw < n; tw += 8) {
                var tw1 = (tw + 30) % n;
                var h0 = Math.atan2(px(tw + 1).z - px(tw).z, px(tw + 1).x - px(tw).x);
                var h1 = Math.atan2(px(tw1 + 1).z - px(tw1).z, px(tw1 + 1).x - px(tw1).x);
                var dd = h1 - h0;
                while (dd > Math.PI) dd -= Math.PI * 2;
                while (dd < -Math.PI) dd += Math.PI * 2;
                wins.push(Math.abs(dd) * 180 / Math.PI);
            }
            wins.sort(function(a, b) { return a - b; });
            return wins.length ? +wins[Math.floor(0.5 * (wins.length - 1))].toFixed(1) : 0;
        })(),
        turn30P90: (function() {
            var wins = [];
            for (var tw = 0; tw < n; tw += 8) {
                var tw1 = (tw + 30) % n;
                var h0 = Math.atan2(px(tw + 1).z - px(tw).z, px(tw + 1).x - px(tw).x);
                var h1 = Math.atan2(px(tw1 + 1).z - px(tw1).z, px(tw1 + 1).x - px(tw1).x);
                var dd = h1 - h0;
                while (dd > Math.PI) dd -= Math.PI * 2;
                while (dd < -Math.PI) dd += Math.PI * 2;
                wins.push(Math.abs(dd) * 180 / Math.PI);
            }
            wins.sort(function(a, b) { return a - b; });
            return wins.length ? +wins[Math.floor(0.9 * (wins.length - 1))].toFixed(1) : 0;
        })()
    };
}

/** Unique ~2100 m closed oxbow — not Path / Loop / Meander / Hollow. */
export function jsTrackPoints() {
    var THREE = useTHREE();
    function curve(t) {
        var w = 0.11 * Math.sin(2 * t + 1.1) + 0.07 * Math.sin(5 * t + 0.4)
            + 0.045 * Math.sin(11 * t + 2.2) + 0.028 * Math.sin(17 * t + 0.9)
            + 0.014 * Math.sin(29 * t + 1.5);
        var ax = 310 * (1 + 0.45 * Math.sin(t + 0.2) + 0.12 * Math.cos(2 * t));
        var az = 240 * (1 + 0.32 * Math.cos(t + 0.9) + 0.09 * Math.sin(3 * t + 0.4));
        var x = ax * (1 + w) * Math.cos(t);
        var z = az * (1 + 0.9 * w) * Math.sin(t);
        var lat = 0.4 * (42 * Math.sin(4 * t + 0.7) + 18 * Math.sin(8 * t + 1.9));
        var tx = -Math.sin(t);
        var tz = Math.cos(t);
        x += (-tz) * lat;
        z += tx * lat;
        return [x, z];
    }
    var steps = 36000;
    var raw = [];
    for (var i = 0; i < steps; i++) raw.push(curve(2 * Math.PI * i / steps));
    var samples = [];
    var acc = 0;
    var prev = raw[0];
    var chain = raw.slice(1);
    chain.push(raw[0]);
    for (var s = 0; s < chain.length; s++) {
        var p = chain[s];
        acc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        prev = p;
        if (acc >= 1) {
            samples.push(prev);
            acc -= 1;
        }
    }
    var pts = [];
    var y = 0;
    var n = samples.length;
    for (var k = 0; k < n; k++) {
        var ang = 2 * Math.PI * k / n;
        var slope = 0.095 * Math.sin(ang + 0.8) + 0.07 * Math.sin(3 * ang + 0.3)
            + 0.045 * Math.sin(6 * ang + 1.4) + 0.028 * Math.sin(11 * ang + 0.6);
        y += slope;
        pts.push(new THREE.Vector3(samples[k][0], y, samples[k][1]));
    }
    var drift = pts[n - 1].y - pts[0].y;
    for (var d = 0; d < n; d++) pts[d].y -= drift * (d / (n - 1));
    // Low-pass grade so 1 m frames don't facet into "stairs" on steep rolls.
    for (var pass = 0; pass < 12; pass++) {
        var ny = new Array(n);
        for (var i = 0; i < n; i++) {
            var ya = pts[(i - 1 + n) % n].y;
            var yb = pts[i].y;
            var yc = pts[(i + 1) % n].y;
            ny[i] = (ya + yb * 2 + yc) * 0.25;
        }
        for (var s = 0; s < n; s++) pts[s].y = ny[s];
    }
    drift = pts[n - 1].y - pts[0].y;
    for (d = 0; d < n; d++) pts[d].y -= drift * (d / (n - 1));
    var minY = pts[0].y;
    for (var j = 1; j < n; j++) if (pts[j].y < minY) minY = pts[j].y;
    var lift = 1.5 - minY;
    for (var u = 0; u < n; u++) pts[u].y += lift;
    var dx = pts[0].x - pts[n - 1].x;
    var dz = pts[0].z - pts[n - 1].z;
    for (var c = 0; c < n; c++) {
        var ct = c / (n - 1);
        var cw = ct * ct * (3 - 2 * ct);
        pts[c].x += dx * cw;
        pts[c].z += dz * cw;
    }
    return pts;
}

/**
 * JS2 follows the in-game Forest Road dirt loop (844 m, dumped from the
 * loaded track), not a corridor with a wiggle added.
 * That loop fills roughly a 260 x 230 m plan, climbs about 41 m, and its
 * high section passes back near the low section. A 30 m window typically
 * turns about 30 degrees; the tighter windows turn about 80. Resampled to
 * 1 m, smoothed so a single step stays under 8 degrees, then scaled 1.45
 * from the centroid so Path_Grass (+/- 16 m) does not overlap.
 * Do not replace this with a parallel shelf. bank stays 0.
 */
var JS2_FR_LOOP = [
-72.43,4.61,-134.52,
-71.05,4.63,-135.15,
-69.71,4.66,-135.8,
-68.4,4.68,-136.46,
-67.1,4.71,-137.1,
-65.8,4.74,-137.72,
-64.49,4.77,-138.32,
-63.19,4.81,-138.91,
-61.87,4.87,-139.46,
-60.55,4.93,-139.97,
-59.22,5.01,-140.47,
-57.9,5.09,-141,
-56.6,5.18,-141.56,
-55.28,5.25,-142.11,
-53.94,5.32,-142.61,
-52.57,5.38,-143.04,
-51.18,5.43,-143.4,
-49.78,5.49,-143.74,
-48.4,5.57,-144.1,
-47.04,5.66,-144.51,
-45.7,5.76,-144.95,
-44.35,5.87,-145.38,
-42.97,5.97,-145.73,
-41.57,6.06,-146,
-40.14,6.16,-146.2,
-38.71,6.26,-146.37,
-37.27,6.37,-146.53,
-35.84,6.48,-146.72,
-34.41,6.58,-146.97,
-33,6.69,-147.27,
-31.59,6.79,-147.6,
-30.19,6.91,-147.94,
-28.78,7.02,-148.23,
-27.36,7.14,-148.45,
-25.92,7.26,-148.61,
-24.48,7.38,-148.71,
-23.03,7.5,-148.77,
-21.58,7.62,-148.8,
-20.13,7.75,-148.82,
-18.69,7.88,-148.83,
-17.24,8,-148.82,
-15.79,8.12,-148.79,
-14.34,8.24,-148.74,
-12.89,8.37,-148.67,
-11.45,8.5,-148.58,
-10,8.65,-148.48,
-8.56,8.8,-148.38,
-7.11,8.96,-148.26,
-5.67,9.13,-148.11,
-4.24,9.3,-147.94,
-2.81,9.48,-147.74,
-1.39,9.66,-147.51,
0.02,9.83,-147.22,
1.41,10,-146.87,
2.8,10.17,-146.46,
4.17,10.34,-146.02,
5.54,10.5,-145.58,
6.9,10.66,-145.11,
8.24,10.82,-144.6,
9.55,10.97,-144.04,
10.86,11.14,-143.47,
12.17,11.32,-142.89,
13.48,11.51,-142.31,
14.78,11.7,-141.7,
16.08,11.88,-141.06,
17.37,12.07,-140.43,
18.67,12.27,-139.82,
19.99,12.47,-139.24,
21.3,12.66,-138.66,
22.6,12.86,-138.03,
23.85,13.05,-137.34,
25.05,13.24,-136.56,
26.2,13.44,-135.7,
27.29,13.63,-134.78,
28.37,13.83,-133.85,
29.48,14.02,-132.95,
30.63,14.22,-132.1,
31.81,14.4,-131.29,
32.98,14.59,-130.47,
34.12,14.76,-129.6,
35.21,14.94,-128.67,
36.27,15.12,-127.68,
37.28,15.31,-126.65,
38.27,15.5,-125.59,
39.21,15.69,-124.5,
40.11,15.87,-123.37,
40.96,16.05,-122.21,
41.75,16.21,-121.01,
42.49,16.37,-119.77,
43.21,16.52,-118.53,
43.92,16.67,-117.27,
44.62,16.81,-116.02,
45.28,16.95,-114.76,
45.9,17.09,-113.49,
46.52,17.24,-112.23,
47.2,17.39,-110.99,
47.96,17.55,-109.79,
48.75,17.7,-108.61,
49.53,17.85,-107.42,
50.23,18,-106.19,
50.85,18.16,-104.91,
51.42,18.33,-103.62,
52.02,18.49,-102.33,
52.66,18.66,-101.06,
53.3,18.81,-99.8,
53.88,18.95,-98.51,
54.37,19.08,-97.19,
54.82,19.21,-95.85,
55.31,19.34,-94.52,
55.88,19.47,-93.23,
56.53,19.61,-91.98,
57.2,19.75,-90.74,
57.85,19.89,-89.48,
58.5,20.04,-88.21,
59.16,20.19,-86.94,
59.85,20.35,-85.67,
60.55,20.53,-84.41,
61.27,20.72,-83.16,
62.03,20.92,-81.93,
62.82,21.11,-80.72,
63.66,21.29,-79.54,
64.52,21.45,-78.38,
65.41,21.59,-77.23,
66.33,21.73,-76.11,
67.26,21.87,-75,
68.21,22.02,-73.91,
69.17,22.17,-72.83,
70.15,22.32,-71.75,
71.14,22.47,-70.71,
72.17,22.62,-69.7,
73.26,22.77,-68.76,
74.41,22.92,-67.9,
75.61,23.07,-67.12,
76.84,23.2,-66.39,
78.09,23.33,-65.66,
79.33,23.45,-64.93,
80.58,23.56,-64.2,
81.84,23.67,-63.52,
83.14,23.75,-62.91,
84.47,23.82,-62.42,
85.85,23.87,-62.05,
87.26,23.92,-61.79,
88.69,23.98,-61.6,
90.13,24.04,-61.49,
91.57,24.11,-61.44,
93.02,24.19,-61.46,
94.46,24.26,-61.55,
95.89,24.33,-61.71,
97.31,24.41,-61.94,
98.71,24.49,-62.26,
100.06,24.56,-62.68,
101.37,24.63,-63.22,
102.65,24.7,-63.87,
103.89,24.78,-64.59,
105.1,24.86,-65.36,
106.27,24.96,-66.19,
107.37,25.08,-67.1,
108.37,25.21,-68.11,
109.29,25.36,-69.21,
110.15,25.5,-70.37,
110.96,25.65,-71.56,
111.76,25.79,-72.75,
112.57,25.91,-73.92,
113.41,26.03,-75.05,
114.28,26.14,-76.13,
115.16,26.27,-77.21,
116.04,26.4,-78.31,
116.9,26.55,-79.44,
117.77,26.69,-80.59,
118.64,26.85,-81.74,
119.5,27.01,-82.89,
120.34,27.18,-84.05,
121.19,27.35,-85.21,
122.08,27.54,-86.34,
123.03,27.72,-87.43,
124.03,27.9,-88.46,
125.09,28.08,-89.44,
126.18,28.24,-90.39,
127.29,28.41,-91.32,
128.41,28.59,-92.24,
129.54,28.78,-93.14,
130.7,28.98,-94,
131.9,29.19,-94.79,
133.15,29.39,-95.5,
134.44,29.59,-96.13,
135.76,29.78,-96.7,
137.1,29.98,-97.25,
138.44,30.17,-97.79,
139.78,30.37,-98.33,
141.14,30.58,-98.83,
142.51,30.79,-99.27,
143.9,31.01,-99.65,
145.31,31.24,-99.98,
146.71,31.47,-100.29,
148.12,31.72,-100.58,
149.53,31.96,-100.84,
150.95,32.2,-101.05,
152.38,32.44,-101.17,
153.81,32.66,-101.21,
155.25,32.89,-101.16,
156.66,33.12,-101,
158.04,33.36,-100.71,
159.37,33.61,-100.25,
160.64,33.86,-99.65,
161.88,34.12,-98.92,
163.07,34.38,-98.12,
164.24,34.64,-97.26,
165.36,34.91,-96.36,
166.45,35.18,-95.41,
167.51,35.45,-94.42,
168.53,35.73,-93.4,
169.53,36,-92.37,
170.49,36.27,-91.32,
171.38,36.54,-90.24,
172.16,36.81,-89.1,
172.81,37.08,-87.87,
173.34,37.34,-86.57,
173.82,37.59,-85.22,
174.3,37.86,-83.86,
174.83,38.13,-82.51,
175.41,38.43,-81.19,
176.04,38.73,-79.89,
176.69,39.05,-78.61,
177.32,39.36,-77.31,
177.87,39.67,-75.99,
178.34,39.97,-74.64,
178.75,40.25,-73.26,
179.15,40.52,-71.89,
179.58,40.79,-70.52,
180.05,41.05,-69.17,
180.52,41.32,-67.82,
180.97,41.58,-66.47,
181.4,41.86,-65.11,
181.84,42.14,-63.74,
182.33,42.43,-62.39,
182.87,42.73,-61.05,
183.43,43.02,-59.71,
183.98,43.31,-58.38,
184.53,43.59,-57.03,
185.07,43.86,-55.69,
185.63,44.12,-54.36,
186.23,44.37,-53.05,
186.87,44.61,-51.75,
187.54,44.85,-50.47,
188.24,45.08,-49.21,
188.98,45.3,-47.97,
189.76,45.52,-46.76,
190.58,45.73,-45.57,
191.41,45.93,-44.39,
192.23,46.15,-43.2,
193.02,46.37,-41.99,
193.78,46.6,-40.77,
194.55,46.83,-39.56,
195.35,47.06,-38.37,
196.19,47.3,-37.2,
197.08,47.54,-36.07,
197.99,47.78,-34.94,
198.89,48.02,-33.81,
199.79,48.25,-32.67,
200.68,48.47,-31.52,
201.55,48.69,-30.37,
202.41,48.91,-29.2,
203.22,49.14,-28.01,
203.98,49.36,-26.78,
204.67,49.58,-25.52,
205.29,49.8,-24.22,
205.87,50.03,-22.9,
206.41,50.26,-21.56,
206.94,50.5,-20.21,
207.44,50.74,-18.85,
207.89,50.98,-17.47,
208.28,51.21,-16.08,
208.59,51.44,-14.68,
208.83,51.65,-13.26,
208.99,51.86,-11.82,
209.1,52.07,-10.38,
209.18,52.27,-8.94,
209.26,52.47,-7.49,
209.36,52.69,-6.05,
209.48,52.92,-4.62,
209.6,53.15,-3.21,
209.64,53.39,-1.83,
209.54,53.61,-0.46,
209.27,53.82,0.89,
208.87,54.04,2.22,
208.36,54.25,3.53,
207.76,54.47,4.8,
207.03,54.68,6.01,
206.21,54.9,7.17,
205.31,55.11,8.29,
204.37,55.31,9.38,
203.38,55.52,10.43,
202.33,55.72,11.41,
201.22,55.93,12.29,
200.03,56.14,13.07,
198.78,56.36,13.73,
197.49,56.6,14.33,
196.17,56.83,14.89,
194.84,57.06,15.4,
193.49,57.29,15.82,
192.11,57.5,16.12,
190.69,57.71,16.3,
189.26,57.92,16.39,
187.82,58.13,16.43,
186.37,58.34,16.42,
184.92,58.55,16.37,
183.48,58.77,16.26,
182.05,58.97,16.09,
180.63,59.18,15.86,
179.21,59.37,15.59,
177.79,59.57,15.32,
176.36,59.76,15.1,
174.93,59.97,14.93,
173.49,60.18,14.81,
172.04,60.4,14.73,
170.6,60.61,14.65,
169.15,60.82,14.58,
167.7,61.03,14.5,
166.26,61.23,14.43,
164.81,61.43,14.37,
163.36,61.61,14.31,
161.91,61.78,14.25,
160.46,61.93,14.18,
159.02,62.07,14.11,
157.57,62.18,14.05,
156.12,62.29,14,
154.67,62.38,13.96,
153.22,62.46,13.92,
151.77,62.54,13.89,
150.32,62.63,13.88,
148.88,62.73,13.88,
147.43,62.85,13.9,
145.98,62.97,13.94,
144.53,63.08,14.01,
143.09,63.18,14.12,
141.65,63.27,14.27,
140.22,63.35,14.47,
138.79,63.42,14.71,
137.37,63.48,14.95,
135.94,63.53,15.18,
134.51,63.56,15.36,
133.08,63.58,15.52,
131.64,63.58,15.68,
130.21,63.57,15.85,
128.78,63.54,16.03,
127.36,63.51,16.25,
125.95,63.48,16.53,
124.55,63.46,16.88,
123.16,63.45,17.27,
121.78,63.43,17.68,
120.39,63.41,18.09,
119,63.38,18.5,
117.62,63.35,18.91,
116.25,63.33,19.37,
114.89,63.31,19.85,
113.54,63.31,20.35,
112.17,63.31,20.84,
110.81,63.31,21.31,
109.43,63.33,21.75,
108.05,63.35,22.15,
106.67,63.38,22.54,
105.3,63.41,22.96,
103.96,63.43,23.46,
102.65,63.44,24.04,
101.36,63.45,24.68,
100.07,63.45,25.35,
98.79,63.45,26.02,
97.5,63.45,26.68,
96.21,63.45,27.33,
94.92,63.45,27.98,
93.64,63.45,28.66,
92.39,63.45,29.37,
91.16,63.45,30.14,
89.96,63.45,30.94,
88.76,63.45,31.75,
87.55,63.45,32.54,
86.32,63.45,33.31,
85.08,63.45,34.06,
83.84,63.45,34.8,
82.6,63.45,35.54,
81.36,63.45,36.29,
80.12,63.45,37.04,
78.9,63.45,37.82,
77.71,63.44,38.63,
76.53,63.43,39.47,
75.37,63.41,40.33,
74.21,63.38,41.2,
73.06,63.35,42.08,
71.91,63.33,42.96,
70.76,63.31,43.84,
69.6,63.31,44.71,
68.43,63.3,45.56,
67.24,63.3,46.39,
66.05,63.29,47.21,
64.85,63.28,48.03,
63.65,63.26,48.85,
62.46,63.23,49.66,
61.28,63.2,50.49,
60.13,63.18,51.33,
59.04,63.16,52.23,
58,63.14,53.16,
56.96,63.12,54.1,
55.89,63.1,55.02,
54.79,63.07,55.91,
53.65,63.04,56.8,
52.52,63.01,57.68,
51.37,62.99,58.54,
50.21,62.95,59.39,
49.03,62.9,60.21,
47.86,62.85,61.04,
46.71,62.81,61.91,
45.57,62.77,62.79,
44.44,62.74,63.7,
43.32,62.71,64.61,
42.2,62.68,65.51,
41.06,62.65,66.36,
39.87,62.63,67.12,
38.62,62.61,67.74,
37.3,62.61,68.23,
35.93,62.63,68.66,
34.55,62.65,69.07,
33.17,62.68,69.49,
31.79,62.71,69.95,
30.44,62.74,70.46,
29.1,62.78,71.02,
27.78,62.82,71.6,
26.46,62.87,72.21,
25.15,62.92,72.8,
23.81,62.96,73.36,
22.46,62.99,73.87,
21.09,63.01,74.32,
19.71,63.02,74.74,
18.33,63.03,75.17,
16.96,63.05,75.62,
15.61,63.08,76.12,
14.27,63.11,76.67,
12.93,63.14,77.22,
11.59,63.17,77.76,
10.25,63.2,78.3,
8.9,63.23,78.85,
7.56,63.26,79.4,
6.23,63.28,79.97,
4.9,63.3,80.54,
3.57,63.3,81.12,
2.23,63.31,81.68,
0.89,63.31,82.22,
-0.45,63.31,82.75,
-1.79,63.33,83.29,
-3.12,63.35,83.84,
-4.44,63.38,84.42,
-5.76,63.41,85,
-7.09,63.43,85.57,
-8.42,63.44,86.13,
-9.74,63.45,86.7,
-11.05,63.45,87.3,
-12.37,63.45,87.89,
-13.68,63.45,88.49,
-14.99,63.45,89.09,
-16.29,63.45,89.71,
-17.58,63.45,90.35,
-18.88,63.45,90.98,
-20.18,63.45,91.61,
-21.47,63.45,92.25,
-22.75,63.45,92.91,
-24.03,63.45,93.58,
-25.31,63.45,94.26,
-26.6,63.45,94.92,
-27.89,63.45,95.56,
-29.19,63.45,96.21,
-30.47,63.45,96.88,
-31.74,63.45,97.58,
-32.97,63.45,98.33,
-34.16,63.44,99.14,
-35.33,63.43,99.99,
-36.47,63.41,100.88,
-37.62,63.38,101.76,
-38.77,63.35,102.63,
-39.94,63.33,103.48,
-41.13,63.31,104.31,
-42.3,63.31,105.14,
-43.46,63.31,106.02,
-44.57,63.31,106.93,
-45.66,63.32,107.89,
-46.71,63.34,108.88,
-47.74,63.36,109.9,
-48.76,63.39,110.93,
-49.79,63.42,111.94,
-50.84,63.44,112.93,
-51.91,63.46,113.91,
-52.99,63.48,114.88,
-54.05,63.51,115.86,
-55.1,63.54,116.86,
-56.12,63.55,117.89,
-57.1,63.55,118.94,
-58.04,63.53,120.03,
-58.96,63.49,121.15,
-59.86,63.45,122.28,
-60.77,63.4,123.4,
-61.67,63.36,124.53,
-62.55,63.31,125.68,
-63.38,63.26,126.85,
-64.18,63.18,128.05,
-64.96,63.09,129.27,
-65.75,62.99,130.48,
-66.55,62.87,131.68,
-67.35,62.75,132.89,
-68.14,62.64,134.11,
-68.91,62.55,135.33,
-69.7,62.47,136.55,
-70.49,62.4,137.76,
-71.3,62.32,138.96,
-72.11,62.22,140.16,
-72.91,62.1,141.37,
-73.67,61.96,142.6,
-74.37,61.8,143.86,
-74.99,61.63,145.15,
-75.55,61.45,146.48,
-76.04,61.25,147.84,
-76.5,61.06,149.21,
-76.97,60.86,150.57,
-77.48,60.66,151.92,
-78.06,60.45,153.23,
-78.72,60.24,154.51,
-79.44,60.03,155.76,
-80.22,59.82,156.98,
-81.03,59.62,158.18,
-81.84,59.42,159.38,
-82.61,59.22,160.58,
-83.32,59.02,161.81,
-83.98,58.82,163.07,
-84.64,58.61,164.33,
-85.35,58.39,165.56,
-86.16,58.16,166.73,
-87.05,57.91,167.86,
-88,57.67,168.95,
-88.98,57.43,170,
-89.98,57.2,171.06,
-90.96,57,172.11,
-91.93,56.81,173.17,
-92.9,56.64,174.21,
-93.9,56.47,175.19,
-94.99,56.29,176.05,
-96.18,56.09,176.78,
-97.46,55.89,177.38,
-98.79,55.67,177.84,
-100.18,55.46,178.16,
-101.59,55.24,178.34,
-103.02,55.02,178.41,
-104.46,54.81,178.38,
-105.9,54.6,178.3,
-107.33,54.4,178.15,
-108.74,54.2,177.91,
-110.1,53.99,177.54,
-111.41,53.77,177.02,
-112.67,53.55,176.37,
-113.9,53.33,175.63,
-115.12,53.1,174.86,
-116.34,52.87,174.09,
-117.56,52.65,173.33,
-118.77,52.43,172.55,
-119.92,52.2,171.71,
-121,51.96,170.78,
-122,51.72,169.76,
-122.96,51.48,168.7,
-123.9,51.24,167.61,
-124.85,51.02,166.52,
-125.82,50.81,165.45,
-126.8,50.61,164.38,
-127.75,50.4,163.3,
-128.66,50.18,162.18,
-129.49,49.96,161.02,
-130.25,49.72,159.8,
-130.96,49.49,158.56,
-131.63,49.25,157.29,
-132.26,49.02,155.99,
-132.82,48.8,154.67,
-133.31,48.58,153.32,
-133.74,48.36,151.94,
-134.15,48.14,150.55,
-134.58,47.92,149.18,
-135.07,47.69,147.82,
-135.63,47.47,146.5,
-136.26,47.24,145.21,
-136.94,47.01,143.94,
-137.6,46.78,142.67,
-138.2,46.56,141.37,
-138.71,46.34,140.05,
-139.14,46.12,138.69,
-139.55,45.9,137.32,
-140,45.69,135.97,
-140.54,45.47,134.66,
-141.15,45.25,133.4,
-141.82,45.02,132.17,
-142.49,44.79,130.93,
-143.16,44.54,129.67,
-143.85,44.3,128.43,
-144.61,44.04,127.23,
-145.45,43.79,126.08,
-146.33,43.53,124.94,
-147.2,43.27,123.8,
-148.04,43,122.64,
-148.88,42.72,121.46,
-149.73,42.42,120.3,
-150.62,42.13,119.16,
-151.52,41.84,118.02,
-152.41,41.56,116.89,
-153.29,41.3,115.74,
-154.15,41.04,114.59,
-155.02,40.79,113.45,
-155.93,40.52,112.35,
-156.89,40.23,111.3,
-157.87,39.93,110.25,
-158.81,39.61,109.18,
-159.71,39.28,108.06,
-160.56,38.96,106.91,
-161.42,38.66,105.76,
-162.31,38.37,104.65,
-163.24,38.1,103.58,
-164.19,37.84,102.54,
-165.09,37.59,101.47,
-165.93,37.33,100.33,
-166.66,37.08,99.12,
-167.3,36.81,97.85,
-167.85,36.55,96.54,
-168.36,36.28,95.2,
-168.84,36.02,93.86,
-169.26,35.76,92.51,
-169.56,35.49,91.16,
-169.71,35.22,89.78,
-169.7,34.96,88.37,
-169.62,34.69,86.95,
-169.5,34.44,85.52,
-169.35,34.18,84.09,
-169.13,33.92,82.68,
-168.8,33.65,81.29,
-168.36,33.37,79.95,
-167.83,33.09,78.63,
-167.25,32.83,77.32,
-166.64,32.59,76.04,
-165.97,32.37,74.79,
-165.2,32.15,73.59,
-164.34,31.93,72.46,
-163.41,31.69,71.36,
-162.42,31.45,70.31,
-161.41,31.2,69.27,
-160.37,30.97,68.27,
-159.3,30.75,67.29,
-158.21,30.54,66.34,
-157.09,30.34,65.41,
-155.97,30.13,64.5,
-154.83,29.93,63.61,
-153.67,29.73,62.75,
-152.48,29.52,61.93,
-151.26,29.32,61.19,
-150,29.13,60.52,
-148.72,28.94,59.9,
-147.42,28.75,59.31,
-146.11,28.55,58.76,
-144.77,28.36,58.29,
-143.4,28.18,57.93,
-142,28.02,57.64,
-140.58,27.85,57.39,
-139.15,27.69,57.15,
-137.72,27.53,56.9,
-136.3,27.36,56.64,
-134.89,27.19,56.38,
-133.48,27.03,56.14,
-132.09,26.87,55.97,
-130.7,26.73,55.91,
-129.31,26.59,55.96,
-127.9,26.45,56.06,
-126.48,26.31,56.13,
-125.05,26.17,56.14,
-123.61,26.04,56.09,
-122.17,25.92,55.99,
-120.74,25.79,55.83,
-119.33,25.66,55.59,
-117.93,25.52,55.28,
-116.53,25.38,54.93,
-115.13,25.24,54.58,
-113.74,25.11,54.23,
-112.36,24.99,53.85,
-111.01,24.88,53.38,
-109.71,24.76,52.8,
-108.44,24.66,52.13,
-107.2,24.57,51.4,
-106,24.48,50.62,
-104.86,24.41,49.76,
-103.82,24.34,48.82,
-102.9,24.27,47.75,
-102.12,24.2,46.58,
-101.43,24.12,45.34,
-100.78,24.05,44.06,
-100.12,23.99,42.77,
-99.44,23.94,41.49,
-98.77,23.9,40.22,
-98.14,23.86,38.93,
-97.6,23.81,37.62,
-97.19,23.74,36.27,
-96.9,23.66,34.88,
-96.72,23.56,33.47,
-96.6,23.46,32.03,
-96.55,23.35,30.6,
-96.58,23.22,29.16,
-96.71,23.08,27.73,
-96.93,22.93,26.32,
-97.19,22.77,24.91,
-97.42,22.62,23.5,
-97.6,22.49,22.12,
-97.74,22.36,20.75,
-97.94,22.25,19.42,
-98.26,22.13,18.11,
-98.67,22,16.8,
-99.12,21.87,15.48,
-99.57,21.74,14.13,
-100.04,21.59,12.79,
-100.58,21.42,11.47,
-101.23,21.24,10.2,
-101.96,21.05,8.96,
-102.74,20.85,7.75,
-103.55,20.65,6.55,
-104.35,20.47,5.34,
-105.12,20.29,4.12,
-105.85,20.12,2.88,
-106.52,19.96,1.62,
-107.15,19.8,0.35,
-107.81,19.65,-0.92,
-108.51,19.5,-2.16,
-109.26,19.37,-3.38,
-110.02,19.25,-4.6,
-110.78,19.12,-5.83,
-111.53,18.99,-7.07,
-112.28,18.84,-8.3,
-113.05,18.68,-9.53,
-113.82,18.52,-10.76,
-114.59,18.34,-11.98,
-115.37,18.18,-13.19,
-116.19,18.02,-14.37,
-117.01,17.88,-15.54,
-117.8,17.74,-16.73,
-118.54,17.59,-17.95,
-119.22,17.43,-19.21,
-119.87,17.27,-20.49,
-120.53,17.1,-21.77,
-121.22,16.94,-23.05,
-121.92,16.79,-24.31,
-122.61,16.65,-25.58,
-123.25,16.51,-26.87,
-123.81,16.36,-28.2,
-124.3,16.19,-29.55,
-124.71,16.01,-30.93,
-125.07,15.81,-32.33,
-125.38,15.61,-33.75,
-125.68,15.42,-35.16,
-125.96,15.23,-36.58,
-126.26,15.05,-38,
-126.58,14.89,-39.4,
-126.92,14.72,-40.81,
-127.22,14.55,-42.22,
-127.48,14.37,-43.64,
-127.68,14.18,-45.07,
-127.82,14,-46.51,
-127.93,13.82,-47.95,
-128.01,13.64,-49.4,
-128.06,13.45,-50.85,
-128.07,13.25,-52.3,
-128.06,13.05,-53.75,
-128.03,12.84,-55.19,
-127.97,12.63,-56.64,
-127.9,12.42,-58.09,
-127.83,12.21,-59.54,
-127.75,12.02,-60.99,
-127.66,11.84,-62.43,
-127.55,11.66,-63.88,
-127.41,11.49,-65.32,
-127.24,11.32,-66.75,
-127.03,11.14,-68.17,
-126.74,10.95,-69.57,
-126.38,10.75,-70.95,
-125.98,10.56,-72.31,
-125.57,10.38,-73.67,
-125.21,10.21,-75.05,
-124.87,10.05,-76.44,
-124.49,9.9,-77.81,
-124.03,9.73,-79.15,
-123.48,9.56,-80.45,
-122.85,9.38,-81.74,
-122.2,9.21,-83.02,
-121.55,9.05,-84.3,
-120.92,8.89,-85.59,
-120.33,8.74,-86.89,
-119.82,8.59,-88.21,
-119.35,8.46,-89.55,
-118.87,8.34,-90.86,
-118.29,8.23,-92.12,
-117.58,8.12,-93.32,
-116.78,8.01,-94.48,
-115.95,7.89,-95.65,
-115.17,7.76,-96.85,
-114.43,7.63,-98.09,
-113.75,7.51,-99.35,
-113.09,7.4,-100.62,
-112.4,7.29,-101.87,
-111.63,7.18,-103.08,
-110.78,7.07,-104.23,
-109.85,6.97,-105.33,
-108.87,6.88,-106.39,
-107.87,6.78,-107.44,
-106.85,6.67,-108.46,
-105.8,6.55,-109.44,
-104.72,6.42,-110.39,
-103.64,6.3,-111.33,
-102.57,6.18,-112.28,
-101.53,6.08,-113.27,
-100.5,5.99,-114.28,
-99.47,5.89,-115.28,
-98.39,5.78,-116.23,
-97.27,5.67,-117.14,
-96.13,5.56,-118.02,
-95,5.46,-118.91,
-93.91,5.39,-119.84,
-92.86,5.33,-120.82,
-91.84,5.29,-121.82,
-90.8,5.24,-122.8,
-89.71,5.18,-123.73,
-88.57,5.1,-124.61,
-87.41,5.03,-125.46,
-86.23,4.96,-126.3,
-85.05,4.9,-127.12,
-83.84,4.84,-127.91,
-82.63,4.8,-128.69,
-81.42,4.76,-129.48,
-80.22,4.73,-130.27,
-79.01,4.7,-131.08,
-77.8,4.67,-131.87,
-76.54,4.64,-132.61,
-75.21,4.62,-133.28,
-73.83,4.61,-133.91
];
export function js2TrackPoints() {
    var THREE = useTHREE();
    var pts = [];
    for (var i = 0; i < JS2_FR_LOOP.length; i += 3) {
        pts.push(new THREE.Vector3(JS2_FR_LOOP[i], JS2_FR_LOOP[i + 1], JS2_FR_LOOP[i + 2]));
    }
    return pts;
}

/**
 * JS3 — the approved plan (2026-10-06). North arch and east hook, then the
 * same kind of bend through the south and west. Not a sine wave. bank stays 0.
 * S grows the drawing evenly so the sharp hooks stay round enough for the
 * grass and the two close passes stay apart. Do not replace this with a
 * curvature wiggle.
 */
export function js3TrackPoints() {
    var THREE = useTHREE();
    var ctrl = [
        [-20, 150, 12],
        [90, 130, 16],
        [35, 45, 28],
        [155, 75, 44],
        [185, 5, 52],
        [110, -45, 44],
        [30, -15, 36],
        [75, -105, 30],
        [-15, -55, 22],
        [-95, -115, 16],
        [-165, -45, 12],
        [-95, 5, 14],
        [-175, 55, 10],
        [-70, 95, 12]
    ];
    var S = 1.55;
    var n = ctrl.length;
    var raw = [];
    var i, s, a, b, c, v1x, v1z, v2x, v2z, l1, l2, u1x, u1z, u2x, u2z, dot, turn, tLen;
    var p1x, p1z, p2x, p2z, bisx, bisz, bisL, half, dist, cx, cz, a0, a1, sweep, steps, rr, t, ang;
    for (i = 0; i < n; i++) {
        a = ctrl[(i - 1 + n) % n];
        b = ctrl[i];
        c = ctrl[(i + 1) % n];
        v1x = a[0] - b[0]; v1z = a[1] - b[1];
        v2x = c[0] - b[0]; v2z = c[1] - b[1];
        l1 = Math.hypot(v1x, v1z) || 1;
        l2 = Math.hypot(v2x, v2z) || 1;
        u1x = v1x / l1; u1z = v1z / l1;
        u2x = v2x / l2; u2z = v2z / l2;
        dot = u1x * u2x + u1z * u2z;
        if (dot > 1) dot = 1;
        if (dot < -1) dot = -1;
        turn = Math.PI - Math.acos(dot);
        tLen = Math.min(l1, l2) * 0.46;
        p1x = b[0] + u1x * tLen; p1z = b[1] + u1z * tLen;
        p2x = b[0] + u2x * tLen; p2z = b[1] + u2z * tLen;
        bisx = u1x + u2x; bisz = u1z + u2z;
        bisL = Math.hypot(bisx, bisz) || 1;
        half = Math.max(0.2, turn / 2);
        dist = tLen / Math.sin(half);
        cx = b[0] + (bisx / bisL) * dist;
        cz = b[1] + (bisz / bisL) * dist;
        a0 = Math.atan2(p1z - cz, p1x - cx);
        a1 = Math.atan2(p2z - cz, p2x - cx);
        sweep = a1 - a0;
        while (sweep > Math.PI) sweep -= Math.PI * 2;
        while (sweep < -Math.PI) sweep += Math.PI * 2;
        steps = Math.max(6, Math.round(Math.abs(sweep) * 12));
        rr = Math.hypot(p1x - cx, p1z - cz);
        for (s = 0; s <= steps; s++) {
            t = s / steps;
            ang = a0 + sweep * t;
            raw.push({
                x: (cx + Math.cos(ang) * rr) * S,
                z: (cz + Math.sin(ang) * rr) * S,
                y: b[2] * (1 - t) + c[2] * t
            });
        }
    }
    var clean = [];
    for (i = 0; i < raw.length; i++) {
        var p = raw[i];
        var q = clean.length ? clean[clean.length - 1] : null;
        if (q && Math.hypot(p.x - q.x, p.z - q.z) < 0.05) continue;
        clean.push(p);
    }
    var total = 0;
    var seg = [];
    for (i = 0; i < clean.length; i++) {
        var bpt = clean[(i + 1) % clean.length];
        var d = Math.hypot(bpt.x - clean[i].x, bpt.z - clean[i].z);
        seg.push(d);
        total += d;
    }
    var count = Math.max(8, Math.round(total));
    var pts = [];
    var acc = 0, si = 0;
    for (i = 0; i < count; i++) {
        var target = (i / count) * total;
        while (si < clean.length - 1 && acc + seg[si] < target) {
            acc += seg[si];
            si++;
        }
        var edge = seg[si] || 1;
        var u = Math.min(1, (target - acc) / edge);
        var pa = clean[si];
        var pb = clean[(si + 1) % clean.length];
        pts.push(new THREE.Vector3(
            pa.x + (pb.x - pa.x) * u,
            pa.y + (pb.y - pa.y) * u,
            pa.z + (pb.z - pa.z) * u
        ));
    }
    var pass, k;
    for (pass = 0; pass < 2; pass++) {
        var nxt = [];
        for (k = 0; k < pts.length; k++) {
            var p0 = pts[(k - 1 + pts.length) % pts.length];
            var p1 = pts[k];
            var p2 = pts[(k + 1) % pts.length];
            nxt.push(new THREE.Vector3(
                p0.x * 0.25 + p1.x * 0.5 + p2.x * 0.25,
                p0.y * 0.25 + p1.y * 0.5 + p2.y * 0.25,
                p0.z * 0.25 + p1.z * 0.5 + p2.z * 0.25
            ));
        }
        pts = nxt;
    }
    return pts;
}

export function buildClosedFrames(pts) {
    var n = pts.length;
    var frames = [];
    var dist = 0;
    for (var i = 0; i < n; i++) {
        var prev = pts[(i - 1 + n) % n];
        var next = pts[(i + 1) % n];
        var fx = next.x - prev.x;
        var fz = next.z - prev.z;
        var fl = Math.hypot(fx, fz) || 1;
        fx /= fl;
        fz /= fl;
        if (i > 0) dist += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
        frames.push({
            x: pts[i].x, y: pts[i].y, z: pts[i].z,
            rx: fz, rz: -fx, fx: fx, fz: fz,
            dist: dist, turn: 0, bank: 0
        });
    }
    var gap = Math.hypot(pts[0].x - pts[n - 1].x, pts[0].z - pts[n - 1].z);
    dist += gap;
    var f0 = frames[0];
    frames.push({
        x: f0.x, y: f0.y, z: f0.z,
        rx: f0.rx, rz: f0.rz, fx: f0.fx, fz: f0.fz,
        dist: dist, turn: 0, bank: 0
    });
    for (var t = 1; t < frames.length; t++) {
        var a = Math.atan2(frames[t].fz, frames[t].fx);
        var b = Math.atan2(frames[t - 1].fz, frames[t - 1].fx);
        var turn = a - b;
        while (turn > Math.PI) turn -= Math.PI * 2;
        while (turn < -Math.PI) turn += Math.PI * 2;
        frames[t].turn = turn;
    }
    return frames;
}

/**
 * Subdivide sharp bends so dirt/roadbed ribbons never tear open (grass showing
 * through as a rectangular hole from overhead).
 */
export function densifyFrames(frames, opts) {
    opts = opts || {};
    var maxTurn = opts.maxTurn != null ? opts.maxTurn : 0.10; // ~5.7°
    var maxStep = opts.maxStep != null ? opts.maxStep : 0.85;
    if (!frames || frames.length < 2) return frames || [];
    var out = [];
    for (var i = 0; i < frames.length - 1; i++) {
        var a = frames[i];
        var b = frames[i + 1];
        out.push(a);
        var turn = Math.abs(b.turn || 0);
        var step = Math.hypot(b.x - a.x, b.z - a.z);
        var n = 1;
        if (turn > maxTurn) n = Math.max(n, Math.ceil(turn / maxTurn));
        if (step > maxStep) n = Math.max(n, Math.ceil(step / maxStep));
        if (n > 12) n = 12;
        for (var k = 1; k < n; k++) {
            var t = k / n;
            var angA = Math.atan2(a.fz, a.fx);
            var angB = Math.atan2(b.fz, b.fx);
            var dang = angB - angA;
            while (dang > Math.PI) dang -= Math.PI * 2;
            while (dang < -Math.PI) dang += Math.PI * 2;
            var ang = angA + dang * t;
            var fx = Math.cos(ang);
            var fz = Math.sin(ang);
            out.push({
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
                z: a.z + (b.z - a.z) * t,
                fx: fx, fz: fz, rx: fz, rz: -fx,
                dist: a.dist + (b.dist - a.dist) * t,
                turn: dang / n,
                bank: 0
            });
        }
    }
    out.push(frames[frames.length - 1]);
    return out;
}

/** PY slide_frames — Path_Roadbed half-step ahead so a dirt crack still has dirt under it. */
export function slideFrames(src, delta) {
    if (!src || src.length < 2) return src || [];
    var total = src[src.length - 1].dist;
    var out = [];
    var j = 0;
    for (var i = 0; i < src.length; i++) {
        var f = src[i];
        var target = Math.min(total, f.dist + delta);
        while (j + 1 < src.length && src[j + 1].dist < target) j++;
        var a = src[j];
        var b = src[Math.min(j + 1, src.length - 1)];
        var span = b.dist - a.dist;
        var t = span < 1e-6 ? 0 : Math.max(0, Math.min(1, (target - a.dist) / span));
        var fx = a.fx + (b.fx - a.fx) * t;
        var fz = a.fz + (b.fz - a.fz) * t;
        var fl = Math.hypot(fx, fz) || 1;
        out.push({
            dist: f.dist,
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            z: a.z + (b.z - a.z) * t,
            fx: fx / fl,
            fz: fz / fl,
            rx: fz / fl,
            rz: -fx / fl,
            turn: a.turn || 0,
            bank: (a.bank || 0) + ((b.bank || 0) - (a.bank || 0)) * t
        });
    }
    return out;
}

/** PY ribbon_y — grass bowls under dirt; dirt gets a slight crown. */
function ribbonY(name, lat, yOff) {
    var a = Math.abs(lat);
    if (/^Path_Grass/i.test(name)) {
        var t = Math.min(1, a / 7.5);
        var s = t * t * (3 - 2 * t);
        return yOff - 0.16 * (1 - s);
    }
    if (/^Path_Dirt|^Path_Roadbed/i.test(name)) {
        var span = /^Path_Dirt/i.test(name) ? 5.5 : 4.2;
        t = Math.min(1, a / span);
        s = t * t * (3 - 2 * t);
        return yOff + 0.035 * (1 - s);
    }
    return yOff;
}

/**
 * Road ribbon. uvMode 'strip' = U along path / V across; 'planar' = world XZ.
 * Lateral lat_step matches compose-path-map make_ribbon (bend-following).
 * Carriage ribbons use parallel-transport laterals so sharp bends don't fold
 * the strip inside-out (was: grass rectangle through the dirt from overhead).
 */
export function buildRibbon(frames, latA, latB, opts) {
    var THREE = useTHREE();
    opts = opts || {};
    var uvPerM = opts.uvPerM != null ? opts.uvPerM : 0.12;
    var yOff = opts.y != null ? opts.y : 0;
    var uvMode = opts.uvMode || 'strip';
    var name = opts.name || 'Path_Ribbon';
    var latStep = opts.latStep != null ? opts.latStep : 2.0;
    var carriage = /^Path_Dirt|^Path_Roadbed|^Path_Grass/i.test(name);
    if (latB < latA) {
        var tmp = latA; latA = latB; latB = tmp;
        if (opts.v0 != null && opts.v1 != null) {
            tmp = opts.v0; opts.v0 = opts.v1; opts.v1 = tmp;
        }
    }
    var span = Math.max(1e-4, latB - latA);
    var nlat = Math.max(1, Math.ceil(span / latStep));
    var lats = [];
    for (var li = 0; li <= nlat; li++) lats.push(latA + span * li / nlat);
    var v0 = opts.v0 != null ? opts.v0 : 0.18;
    var v1 = opts.v1 != null ? opts.v1 : 0.82;
    var positions = [];
    var uvs = [];
    var indices = [];
    var cols = nlat + 1;
    // Parallel-transport right vector — prevents lateral flip across hairpins.
    var prx = frames[0].rx, prz = frames[0].rz;
    var rights = [];
    for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        if (i > 0 && carriage) {
            // Project previous right onto plane ⊥ forward; renormalize.
            var dot = prx * f.fx + prz * f.fz;
            var rx = prx - f.fx * dot;
            var rz = prz - f.fz * dot;
            var rl = Math.hypot(rx, rz);
            if (rl < 1e-5) {
                rx = f.rx; rz = f.rz;
            } else {
                rx /= rl; rz /= rl;
            }
            // Keep consistent side vs geometric right.
            if (rx * f.rx + rz * f.rz < 0) { rx = -rx; rz = -rz; }
            prx = rx; prz = rz;
            rights.push({ rx: rx, rz: rz });
        } else {
            rights.push({ rx: f.rx, rz: f.rz });
            prx = f.rx; prz = f.rz;
        }
    }
    for (i = 0; i < frames.length; i++) {
        f = frames[i];
        var R = rights[i];
        for (var e = 0; e < cols; e++) {
            var lat = lats[e];
            var x = f.x + R.rx * lat;
            var z = f.z + R.rz * lat;
            positions.push(x, f.y + ribbonY(name, lat, yOff), z);
            if (uvMode === 'planar') {
                uvs.push(x * uvPerM, z * uvPerM);
            } else {
                uvs.push(f.dist * uvPerM, v0 + (v1 - v0) * ((lat - latA) / span));
            }
        }
    }
    // Winding must face +Y.
    for (var s = 0; s < frames.length - 1; s++) {
        var row = s * cols;
        var next = (s + 1) * cols;
        for (var j = 0; j < nlat; j++) {
            var a = row + j, b = row + j + 1, c = next + j, d = next + j + 1;
            indices.push(a, c, b, b, c, d);
        }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    var mat = opts.material || new THREE.MeshStandardMaterial({
        color: opts.color || 0x6a7a4a, roughness: 1, metalness: 0, side: THREE.FrontSide
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.renderOrder = opts.order != null ? opts.order : 2;
    return mesh;
}

function smoothstep(t) {
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
}

function valueNoise2(x, z) {
    function h2(ix, iz) {
        var n = (Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263)) >>> 0;
        n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
        return (n & 1023) / 1023;
    }
    var ix = Math.floor(x), iz = Math.floor(z);
    var tx = x - ix, tz = z - iz;
    tx = tx * tx * (3 - 2 * tx);
    tz = tz * tz * (3 - 2 * tz);
    var v00 = h2(ix, iz), v10 = h2(ix + 1, iz);
    var v01 = h2(ix, iz + 1), v11 = h2(ix + 1, iz + 1);
    return (v00 * (1 - tx) + v10 * tx) * (1 - tz) + (v01 * (1 - tx) + v11 * tx) * tz;
}

function idwHeight(loop, x, z, k) {
    k = k || 8;
    var nearest = [];
    for (var i = 0; i < loop.length; i++) {
        var f = loop[i];
        var d = (f.x - x) * (f.x - x) + (f.z - z) * (f.z - z);
        if (nearest.length < k) {
            nearest.push({ d: d, y: f.y });
            nearest.sort(function(a, b) { return a.d - b.d; });
        } else if (d < nearest[nearest.length - 1].d) {
            nearest[nearest.length - 1] = { d: d, y: f.y };
            nearest.sort(function(a, b) { return a.d - b.d; });
        }
    }
    var accH = 0, accW = 0;
    for (var j = 0; j < nearest.length; j++) {
        var w = 1 / Math.max(nearest[j].d, 9);
        accH += w * nearest[j].y;
        accW += w;
    }
    return accH / Math.max(accW, 1e-9);
}

/**
 * Interior meadow (inside the loop) — NEVER covers the carriageway.
 * Old grid sat at road Y with 10 m chords → visible/collidable dirt stairs.
 */
export function buildInteriorTerrain(frames, opts) {
    var THREE = useTHREE();
    opts = opts || {};
    var loop = frames.slice(0, -1);
    var area = 0;
    for (var i = 0; i < loop.length; i++) {
        var n = loop[(i + 1) % loop.length];
        area += loop[i].x * n.z - n.x * loop[i].z;
    }
    // Inner skirt = grass edge toward loop interior.
    // Shelf tracks (JS2): narrower corridor — use insideGrass/latClear opts so
    // Terrain_Flat can fill the strip between valley + high shelf.
    var grassEdge = opts.insideGrass != null ? opts.insideGrass : 16;
    var latClear = opts.latClear != null ? opts.latClear : 15;
    var insideLat = area > 0 ? -grassEdge : grassEdge;
    var bound = [];
    for (var b = 0; b < loop.length; b++) {
        var f = loop[b];
        bound.push({
            x: f.x + f.rx * insideLat,
            y: f.y,
            z: f.z + f.rz * insideLat
        });
    }
    var xs = bound.map(function(p) { return p.x; });
    var zs = bound.map(function(p) { return p.z; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minZ = Math.min.apply(null, zs), maxZ = Math.max.apply(null, zs);
    var step = opts.step || 12;
    var positions = [];
    var uvs = [];
    var indices = [];
    var cols = [];
    var samples = [];
    for (var si = 0; si < bound.length; si += 3) samples.push(bound[si]);

    for (var z = minZ + step * 0.5, iz = 0; z < maxZ; z += step, iz++) {
        var row = [];
        for (var x = minX + step * 0.5, ix = 0; x < maxX; x += step, ix++) {
            if (!pointInPoly(x, z, bound)) {
                row.push(-1);
                continue;
            }
            var nf = nearestFrame(loop, x, z);
            // Keep clear of carriageway; meet Path_Grass near |lat|≈grassEdge.
            if (Math.abs(nf.lat) < latClear) {
                row.push(-1);
                continue;
            }
            var y = idwHeight(samples, x, z, 8);
            var dist = Math.hypot(x - nf.x, z - nf.z);
            var fade = smoothstep((dist - 22) / 80);
            var roll = valueNoise2(x * 0.0016, z * 0.0015) - 0.5;
            var mid = valueNoise2(x * 0.0042 + 11, z * 0.0038) - 0.5;
            var fine = valueNoise2(x * 0.009 + 3, z * 0.008) - 0.5;
            // Gentle meadow only — old ±50 m spikes read as floating green sheets.
            y += fade * (roll * 4.5 + mid * 2.2 + fine * 1.1);
            // Near grass edge: match road Y (no ditch). Far: soft bowls, never above road.
            var edgeBlend = smoothstep((Math.abs(nf.lat) - 15) / 10);
            y = nf.y * (1 - edgeBlend) + Math.min(y, nf.y) * edgeBlend;
            // Never above nearest road frame (pierce gate vs Path_Dirt).
            y = Math.max(nf.y - 4.5, Math.min(nf.y - 0.05, y));
            row.push(positions.length / 3);
            positions.push(x, y, z);
            uvs.push(x * 0.08, z * 0.08);
        }
        cols.push(row);
    }
    for (var r = 0; r < cols.length - 1; r++) {
        for (var c = 0; c < cols[r].length - 1; c++) {
            var a = cols[r][c], b = cols[r][c + 1], d = cols[r + 1][c], e = cols[r + 1][c + 1];
            // A square with one corner off the meadow used to be dropped whole,
            // which left a background hole along the road. Keep any full triangle.
            if (a >= 0 && d >= 0 && b >= 0) indices.push(a, d, b);
            if (b >= 0 && d >= 0 && e >= 0) indices.push(b, d, e);
        }
    }
    // Continuous lip on the grass edge so the 8 m grid cannot leave a seam.
    var lipSign = insideLat >= 0 ? 1 : -1;
    var lipLats = [grassEdge, grassEdge + 5, grassEdge + 12, grassEdge + 22, grassEdge + 36];
    var lipRows = [];
    var lfi, lli;
    for (lfi = 0; lfi < loop.length; lfi++) {
        var lf = loop[lfi];
        var lipRow = [];
        for (lli = 0; lli < lipLats.length; lli++) {
            var lipLat = lipSign * lipLats[lli];
            lipRow.push(positions.length / 3);
            positions.push(
                lf.x + lf.rx * lipLat,
                lf.y - 0.12 - lli * 0.01,
                lf.z + lf.rz * lipLat
            );
            uvs.push((lf.x + lf.rx * lipLat) * 0.08, (lf.z + lf.rz * lipLat) * 0.08);
        }
        lipRows.push(lipRow);
    }
    if (lipRows.length > 2) lipRows.push(lipRows[0]);
    var lr, lc;
    for (lr = 0; lr < lipRows.length - 1; lr++) {
        for (lc = 0; lc < lipLats.length - 1; lc++) {
            var la = lipRows[lr][lc], lb = lipRows[lr][lc + 1];
            var ld = lipRows[lr + 1][lc], le = lipRows[lr + 1][lc + 1];
            indices.push(la, ld, lb, lb, ld, le);
        }
    }
    if (!indices.length) return null;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    var mesh = new THREE.Mesh(geo, opts.material || new THREE.MeshStandardMaterial({
        color: 0x5d7348, roughness: 1, metalness: 0
    }));
    mesh.name = 'Terrain_Flat';
    mesh.receiveShadow = true;
    mesh.renderOrder = 0;
    sealTerrainToPath(frames, mesh, -0.08);
    return mesh;
}

/**
 * Oxbow fix: Path_Grass is ±16 m, so an elevated segment’s grass sheet covers a
 * nearby lower carriageway and reads as a bright green rectangle on the dirt.
 * Any grass vert whose nearest path |lat| is inside the dirt half-width is sunk
 * under that road so dirt/roadbed always win from above.
 */
export function sealGrassUnderCarriage(frames, grassMesh, halfW) {
    if (!grassMesh || !grassMesh.geometry || !frames || !frames.length) return 0;
    halfW = halfW != null ? halfW : 5.2;
    var loop = frames.slice();
    if (loop.length > 2) {
        var a0 = loop[0], aN = loop[loop.length - 1];
        if (Math.hypot(a0.x - aN.x, a0.z - aN.z) < 0.05) loop = loop.slice(0, -1);
    }
    var pos = grassMesh.geometry.attributes.position;
    var n = 0;
    for (var i = 0; i < pos.count; i++) {
        var x = pos.getX(i), z = pos.getZ(i);
        var nf = nearestFrame(loop, x, z);
        if (Math.abs(nf.lat) <= halfW) {
            var yMax = nf.y - 0.08;
            if (pos.getY(i) > yMax) {
                pos.setY(i, yMax);
                n++;
            }
        }
    }
    if (n) {
        pos.needsUpdate = true;
        grassMesh.geometry.computeVertexNormals();
    }
    return n;
}

/** Clamp terrain verts to nearest path frame Y — kills oxbow “floating sheet” pierce. */
function sealTerrainToPath(frames, mesh, below) {
    if (!mesh || !mesh.geometry || !frames || !frames.length) return;
    below = below != null ? below : -0.08;
    var loop = frames.slice();
    if (loop.length > 2) {
        var a0 = loop[0], aN = loop[loop.length - 1];
        if (Math.hypot(a0.x - aN.x, a0.z - aN.z) < 0.05) loop = loop.slice(0, -1);
    }
    var pos = mesh.geometry.attributes.position;
    for (var i = 0; i < pos.count; i++) {
        var x = pos.getX(i), z = pos.getZ(i);
        var nf = nearestFrame(loop, x, z);
        var maxY = nf.y + below;
        if (pos.getY(i) > maxY) pos.setY(i, maxY);
    }
    pos.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
}

/**
 * Second seal: any terrain vert within rXZ of a dirt sample must sit under it.
 * Oxbow folds put two path segments close in XZ with different Y — frame seal alone
 * leaves a few pierce samples vs the wrong dirt ribbon.
 */
export function sealTerrainUnderDirt(terrain, dirt, rXZ) {
    if (!terrain || !terrain.geometry || !dirt || !dirt.geometry) return 0;
    rXZ = rXZ != null ? rXZ : 7.5;
    var r2 = rXZ * rXZ;
    dirt.updateMatrixWorld(true);
    terrain.updateMatrixWorld(true);
    var THREE = useTHREE();
    var dPos = dirt.geometry.attributes.position;
    var samples = [];
    var tmp = new THREE.Vector3();
    var stride = Math.max(1, Math.floor(dPos.count / 3500));
    for (var di = 0; di < dPos.count; di += stride) {
        tmp.fromBufferAttribute(dPos, di).applyMatrix4(dirt.matrixWorld);
        samples.push(tmp.x, tmp.y, tmp.z);
    }
    var tPos = terrain.geometry.attributes.position;
    var inv = new THREE.Matrix4().copy(terrain.matrixWorld).invert();
    var world = new THREE.Vector3();
    var local = new THREE.Vector3();
    var n = 0;
    for (var ti = 0; ti < tPos.count; ti++) {
        world.fromBufferAttribute(tPos, ti).applyMatrix4(terrain.matrixWorld);
        var minDirtY = Infinity;
        for (var s = 0; s < samples.length; s += 3) {
            var dx = samples[s] - world.x, dz = samples[s + 2] - world.z;
            if (dx * dx + dz * dz < r2) {
                if (samples[s + 1] < minDirtY) minDirtY = samples[s + 1];
            }
        }
        if (minDirtY < Infinity && world.y > minDirtY - 0.06) {
            world.y = minDirtY - 0.06;
            local.copy(world).applyMatrix4(inv);
            tPos.setXYZ(ti, local.x, local.y, local.z);
            n++;
        }
    }
    if (n) {
        tPos.needsUpdate = true;
        terrain.geometry.computeVertexNormals();
    }
    return n;
}

/**
 * Outer hills sealed to Path_Grass edge — ring strips from each frame so there
 * are NO black voids beside the road (old XZ grid left 16–22 m seam holes).
 */
export function buildOuterTerrain(frames, opts) {
    var THREE = useTHREE();
    opts = opts || {};
    var loop = frames.slice(0, -1);
    var area = 0;
    for (var i = 0; i < loop.length; i++) {
        var n = loop[(i + 1) % loop.length];
        area += loop[i].x * n.z - n.x * loop[i].z;
    }
    // Both outer skirts (left + right of road).
    var sides = area > 0 ? [1, -1] : [-1, 1];
    // First lat MUST match Path_Grass outer edge so meshes meet.
    var grassEdge = opts.grassEdge != null ? opts.grassEdge : 16;
    // Denser rings — coarse lats made huge tris that read as floating sheets.
    var lats = opts.lats || [grassEdge, 18, 22, 28, 36, 48, 64, 84, 108];
    var frameStep = opts.frameStep != null ? opts.frameStep : 1;
    var positions = [];
    var uvs = [];
    var indices = [];

    function addSkirt(sideSign) {
        var rows = [];
        for (var fi = 0; fi < loop.length; fi += frameStep) {
            var f = loop[fi];
            var row = [];
            for (var li = 0; li < lats.length; li++) {
                var lat = sideSign * lats[li];
                var x = f.x + f.rx * lat;
                var z = f.z + f.rz * lat;
                var fade = smoothstep((lats[li] - grassEdge) / 70);
                var roll = valueNoise2(x * 0.0016 + 40, z * 0.0015) - 0.5;
                var mid = valueNoise2(x * 0.0042 + 51, z * 0.0038) - 0.5;
                var fine = valueNoise2(x * 0.009 + 7, z * 0.008) - 0.5;
                // Edge lat == grass: exact road Y. Far skirts stay near ground — never
                // sky-high sheets (old roll*28 looked like floating planes).
                var dy = fade * (roll * 2.8 + mid * 1.4 + fine * 0.7);
                dy = Math.max(-3.2, Math.min(2.2, dy));
                // Stay under Path_Dirt (continuity pierce gate: terrain ≤ dirtY−0.02).
                var y = f.y + dy;
                if (lats[li] <= grassEdge + 0.01) y = f.y - 0.08;
                else y = Math.min(y, f.y - 0.06);
                row.push(positions.length / 3);
                positions.push(x, y, z);
                uvs.push(x * 0.08, z * 0.08);
            }
            rows.push(row);
        }
        // Close the loop
        if (rows.length > 2) rows.push(rows[0]);
        for (var r = 0; r < rows.length - 1; r++) {
            for (var c = 0; c < lats.length - 1; c++) {
                var a = rows[r][c], b = rows[r][c + 1];
                var d = rows[r + 1][c], e = rows[r + 1][c + 1];
                indices.push(a, d, b, b, d, e);
            }
        }
    }
    addSkirt(sides[0]);
    addSkirt(sides[1]);
    if (!indices.length) return null;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    var mesh = new THREE.Mesh(geo, opts.material || new THREE.MeshStandardMaterial({
        color: 0x5d7348, roughness: 1, metalness: 0
    }));
    mesh.name = 'Terrain_Outer';
    mesh.receiveShadow = true;
    mesh.renderOrder = 0;
    sealTerrainToPath(frames, mesh, -0.08);
    return mesh;
}

/** Soft gravel shoulder ribbons — PY Path_Gravel_L/R (atlas soft V toward grass). */
export function buildSoftGravel(frames, latInner, latOuter, opts) {
    var THREE = useTHREE();
    opts = opts || {};
    var name = opts.name || 'Path_Gravel';
    var uvPerM = opts.uvPerM != null ? opts.uvPerM : 0.14;
    var yOff = opts.y != null ? opts.y : 0.03;
    // Inner (dirt) more solid; outer fades — matches make_soft_gravel.
    var v0 = opts.v0 != null ? opts.v0 : 0.42;
    var v1 = opts.v1 != null ? opts.v1 : 0.92;
    if (latOuter < latInner) {
        var tmp = latInner; latInner = latOuter; latOuter = tmp;
        tmp = v0; v0 = v1; v1 = tmp;
    }
    var positions = [];
    var uvs = [];
    var indices = [];
    for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        positions.push(
            f.x + f.rx * latInner, f.y + yOff, f.z + f.rz * latInner,
            f.x + f.rx * latOuter, f.y + yOff, f.z + f.rz * latOuter
        );
        uvs.push(f.dist * uvPerM, v0, f.dist * uvPerM, v1);
        if (i) {
            var a = (i - 1) * 2, b = a + 1, c = i * 2, d = c + 1;
            indices.push(a, c, b, b, c, d);
        }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    var mesh = new THREE.Mesh(geo, opts.material || new THREE.MeshBasicMaterial({
        color: 0x8a7a60, side: THREE.DoubleSide
    }));
    mesh.name = name;
    mesh.receiveShadow = true;
    mesh.renderOrder = opts.order != null ? opts.order : 4;
    return mesh;
}

/** Spatial hash so FR scatter / seals aren't O(nFrames) per query. */
var _frameIndex = null;
export function beginFrameIndex(frames, cell) {
    cell = cell != null ? cell : 20;
    var grid = new Map();
    var list = frames;
    var n = list.length;
    if (n > 2 && Math.hypot(list[0].x - list[n - 1].x, list[0].z - list[n - 1].z) < 0.05) {
        list = list.slice(0, -1);
        n = list.length;
    }
    for (var i = 0; i < n; i++) {
        var f = list[i];
        var key = (Math.floor(f.x / cell)) + '_' + (Math.floor(f.z / cell));
        var bucket = grid.get(key);
        if (!bucket) { bucket = []; grid.set(key, bucket); }
        bucket.push(f);
    }
    _frameIndex = { grid: grid, cell: cell, frames: list };
    return _frameIndex;
}
export function endFrameIndex() {
    _frameIndex = null;
}

function nearestFrame(frames, x, z) {
    var best = null;
    var bestD = Infinity;
    var bestLat = 0;
    var candidates;
    if (_frameIndex) {
        var cell = _frameIndex.cell;
        var gx = Math.floor(x / cell), gz = Math.floor(z / cell);
        candidates = [];
        for (var ox = -1; ox <= 1; ox++) {
            for (var oz = -1; oz <= 1; oz++) {
                var b = _frameIndex.grid.get((gx + ox) + '_' + (gz + oz));
                if (b) {
                    for (var bi = 0; bi < b.length; bi++) candidates.push(b[bi]);
                }
            }
        }
        if (!candidates.length) candidates = _frameIndex.frames;
    } else {
        candidates = frames;
    }
    for (var i = 0; i < candidates.length; i++) {
        var f = candidates[i];
        var dx = x - f.x, dz = z - f.z;
        var lat = dx * f.rx + dz * f.rz;
        var dd = dx * dx + dz * dz;
        if (dd < bestD) {
            bestD = dd;
            best = f;
            bestLat = lat;
        }
    }
    if (!best) best = (frames && frames[0]) || { x: x, y: 0, z: z, dist: 0 };
    return { x: best.x, y: best.y, z: best.z, lat: bestLat, dist: best.dist };
}

function pointInPoly(x, z, frames) {
    var inside = false;
    for (var i = 0, j = frames.length - 1; i < frames.length; j = i++) {
        var xi = frames[i].x, zi = frames[i].z;
        var xj = frames[j].x, zj = frames[j].z;
        var intersect = ((zi > z) !== (zj > z))
            && (x < (xj - xi) * (z - zi) / ((zj - zi) || 1e-9) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function h01(i, salt) {
    var n = (Math.imul(i | 0, 374761393) + Math.imul(salt | 0, 668265263)) >>> 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
    n ^= n >>> 16;
    return (n & 0xffffff) / 0xffffff;
}

function sampleQ(r, p10, p50, p90) {
    r = Math.max(0, Math.min(1, r));
    if (r < 0.5) return p10 + (p50 - p10) * (r / 0.5);
    return p50 + (p90 - p50) * ((r - 0.5) / 0.5);
}

function framePose(frames, along) {
    var end = frames[frames.length - 1].dist;
    var d = ((along % end) + end) % end;
    for (var i = 1; i < frames.length; i++) {
        if (frames[i].dist >= d) {
            var a = frames[i - 1], b = frames[i];
            var u = (d - a.dist) / ((b.dist - a.dist) || 1);
            return {
                x: a.x + (b.x - a.x) * u,
                y: a.y + (b.y - a.y) * u,
                z: a.z + (b.z - a.z) * u,
                rx: a.rx, rz: a.rz, fx: a.fx, fz: a.fz
            };
        }
    }
    return frames[frames.length - 1];
}

function geomFromObject(obj) {
    var THREE = useTHREE();
    obj.updateWorldMatrix(true, false);
    var geo = obj.geometry.clone();
    geo.applyMatrix4(obj.matrixWorld);
    // Re-center XZ on origin, sit on Y=0 for placement.
    geo.computeBoundingBox();
    var box = geo.boundingBox;
    var cx = (box.min.x + box.max.x) * 0.5;
    var cz = (box.min.z + box.max.z) * 0.5;
    var y0 = box.min.y;
    geo.translate(-cx, -y0, -cz);
    geo.computeBoundingBox();
    geo.computeVertexNormals();
    return {
        geo: geo,
        h: box.max.y - box.min.y,
        w: Math.max(box.max.x - box.min.x, box.max.z - box.min.z),
        material: obj.material
    };
}

function gatherKitPrefabs(root) {
    var THREE = useTHREE();
    var trunks = [];
    var branches = [];
    var cards = [];
    var rocks = [];
    root.updateMatrixWorld(true);
    root.traverse(function(o) {
        if (!o.isMesh || !o.geometry) return;
        var n = o.name || '';
        if (/Tree_Trunk/i.test(n)) trunks.push(o);
        else if (/Tree_Branches/i.test(n)) branches.push(o);
        else if (/Background_Tree_Atlas/i.test(n)) cards.push(o);
        else if (/Rocks/i.test(n)) rocks.push(o);
    });
    var trees = [];
    for (var i = 0; i < trunks.length; i++) {
        var t = geomFromObject(trunks[i]);
        var br = null;
        var tx = trunks[i].getWorldPosition(new THREE.Vector3());
        var best = Infinity;
        for (var b = 0; b < branches.length; b++) {
            var bx = branches[b].getWorldPosition(new THREE.Vector3());
            var d = tx.distanceToSquared(bx);
            if (d < best) { best = d; br = branches[b]; }
        }
        trees.push({
            trunk: t,
            branch: br ? geomFromObject(br) : null,
            h: t.h
        });
    }
    var tallCards = cards.map(geomFromObject).filter(function(p) { return p.h > 6; });
    if (!tallCards.length) tallCards = cards.map(geomFromObject);
    var rockPrefs = rocks.map(geomFromObject);
    var small = trees.filter(function(t) { return t.h < 8; });
    var tall = trees.filter(function(t) { return t.h >= 8; });
    if (!tall.length) tall = trees;
    return { trees: tall.length ? tall : trees, smallTrees: small, cards: tallCards, rocks: rockPrefs };
}

function snapBatchToGround(parent, list) {
    if (!list || !list.length || !parent) return list || [];
    var THREE = useTHREE();
    var grid = parent.userData && parent.userData._jsGroundGrid;
    if (!grid) {
        var cells = new Map();
        var cell = 3;
        parent.updateMatrixWorld(true);
        var v = new THREE.Vector3();
        parent.traverse(function(o) {
            if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
            if (!/Terrain_|Path_Grass|Path_Dirt/i.test(o.name || '')) return;
            var pos = o.geometry.attributes.position;
            var step = Math.max(1, Math.floor(pos.count / 12000));
            for (var i = 0; i < pos.count; i += step) {
                v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
                var key = Math.floor(v.x / cell) + ',' + Math.floor(v.z / cell);
                var bucket = cells.get(key);
                if (!bucket) { bucket = []; cells.set(key, bucket); }
                bucket.push(v.y);
            }
        });
        grid = { cells: cells, cell: cell };
        if (!parent.userData) parent.userData = {};
        parent.userData._jsGroundGrid = grid;
    }
    if (!grid.cells.size) return list;
    var kept = [];
    for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it) continue;
        var gx = Math.floor(it.x / grid.cell);
        var gz = Math.floor(it.z / grid.cell);
        var gy = null;
        for (var ox = -1; ox <= 1; ox++) {
            for (var oz = -1; oz <= 1; oz++) {
                var bucket = grid.cells.get((gx + ox) + ',' + (gz + oz));
                if (!bucket) continue;
                for (var b = 0; b < bucket.length; b++) {
                    var hy = bucket[b];
                    if (hy > it.y + 1.5) continue;
                    if (gy == null || hy > gy) gy = hy;
                }
            }
        }
        if (gy == null) continue;
        if (it.y > gy + 0.15) it.y = gy;
        kept.push(it);
    }
    return kept;
}

/**
 * Forest Road roadside bands (compose-path-map.py). InstancedMesh batches.
 */
export async function placeForestKit(loader, frames, parent) {
    var THREE = useTHREE();
    var gltf = await new Promise(function(resolve, reject) {
        loader.load(TREE_KIT_URL, resolve, undefined, reject);
    });
    var kit = gatherKitPrefabs(gltf.scene);
    var end = frames[frames.length - 1].dist;
    beginFrameIndex(frames, 24);
    // Grid claims — linear scan of thousands of points was O(n²).
    var claimGrid = new Map();
    function blocked(x, z, spacing) {
        var s2 = spacing * spacing;
        var cell = Math.max(spacing, 2);
        var gx = Math.floor(x / cell), gz = Math.floor(z / cell);
        for (var ox = -1; ox <= 1; ox++) {
            for (var oz = -1; oz <= 1; oz++) {
                var list = claimGrid.get((gx + ox) + '_' + (gz + oz));
                if (!list) continue;
                for (var i = 0; i < list.length; i++) {
                    var dx = x - list[i].x, dz = z - list[i].z;
                    if (dx * dx + dz * dz < s2) return true;
                }
            }
        }
        return false;
    }
    function claim(x, z, spacing) {
        var cell = Math.max(spacing || 4, 2);
        var key = Math.floor(x / cell) + '_' + Math.floor(z / cell);
        if (!claimGrid.has(key)) claimGrid.set(key, []);
        claimGrid.get(key).push({ x: x, z: z });
    }
    function nearestRoad(x, z) {
        return Math.abs(nearestFrame(frames, x, z).lat);
    }

    var batches = {
        trunk: [], branch: [], card: [], rock: [], sapling: []
    };
    var atlasLat = [16, 70];
    var sapLat = [8.2, 16];
    var birchLat = [28, 75];
    // Near-verge pines so drivers actually hit trunks (was 11–42 → sparse at road).
    var pineLat = [8.4, 36];
    var rockLat = [7.2, 15];

    var n = 0;
    var dist = 3;
    while (dist < end) {
        for (var side = -1; side <= 1; side += 2) {
            var r1 = h01(n, 1), r2 = h01(n, 2), r3 = h01(n, 3);
            var r4 = h01(n, 4), r5 = h01(n, 5);
            var along = dist + (h01(n, 8) - 0.5) * 5;
            // Background atlas denser — Meander tree band is mostly far cards.
            if (kit.cards.length) {
                var lat = side * (atlasLat[0] + (atlasLat[1] - atlasLat[0]) * r2);
                var pref = kit.cards[n % kit.cards.length];
                var sc = Math.max(0.35, Math.min(1.7, sampleQ(r3, 14, 24, 34) / Math.max(pref.h, 0.2)));
                var sk = pref.h * sc * sampleQ(r4, 0.02, 0.1, 0.35);
                var pose = framePose(frames, along);
                var x = pose.x + pose.rx * lat;
                var z = pose.z + pose.rz * lat;
                if (nearestRoad(x, z) >= 14 && !blocked(x, z, 2.9)) {
                    batches.card.push({ pref: pref, x: x, y: pose.y - sk, z: z, yaw: r5 * Math.PI * 2, sc: sc });
                    claim(x, z, 2.9);
                }
            }
            if (kit.smallTrees.length && (n % 5) === 0) {
                lat = side * (sapLat[0] + (sapLat[1] - sapLat[0]) * r1);
                var sapTree = kit.smallTrees[(n / 5 | 0) % kit.smallTrees.length];
                pref = sapTree.trunk;
                sc = Math.max(0.3, Math.min(1.4, sampleQ(r2, 1.5, 2.6, 5.5) / Math.max(sapTree.h, 0.2)));
                sk = sapTree.h * sc * sampleQ(r4, 0.05, 0.2, 0.55);
                pose = framePose(frames, along + 0.4);
                x = pose.x + pose.rx * lat;
                z = pose.z + pose.rz * lat;
                if (nearestRoad(x, z) >= 8.5 && !blocked(x, z, 3.8)) {
                    batches.sapling.push({ pref: pref, x: x, y: pose.y - sk, z: z, yaw: r3 * Math.PI * 2, sc: sc });
                    if (sapTree.branch) {
                        batches.branch.push({
                            pref: sapTree.branch, x: x, y: pose.y - sk, z: z,
                            yaw: r3 * Math.PI * 2, sc: sc
                        });
                    }
                    claim(x, z, 3.8);
                }
            }
            if (kit.rocks.length && r1 < 0.10) {
                lat = side * (rockLat[0] + (rockLat[1] - rockLat[0]) * r3);
                pref = kit.rocks[n % kit.rocks.length];
                sc = Math.max(0.25, Math.min(1.2, sampleQ(r2, 0.35, 0.58, 1.1) / Math.max(pref.h, 0.2)));
                sk = pref.h * sc * sampleQ(r5, 0.4, 1.0, 1.35);
                pose = framePose(frames, along + 0.15);
                x = pose.x + pose.rx * lat;
                z = pose.z + pose.rz * lat;
                if (nearestRoad(x, z) >= 7.5 && !blocked(x, z, 4.8)) {
                    batches.rock.push({ pref: pref, x: x, y: pose.y - sk, z: z, yaw: r4 * Math.PI * 2, sc: sc });
                    claim(x, z, 4.8);
                }
            }
            n++;
        }
        dist += 0.72;
    }

    // Meander tree clusters — target capped so kit placement stays under a few seconds.
    var oakTarget = Math.min(3800, (end * 2.2) | 0);
    var birchExtra = (end * 0.45) | 0;
    var guard = 0;
    while (batches.trunk.length < oakTarget + birchExtra && guard < 60000 && kit.trees.length) {
        guard++;
        var alongT = 8 + h01(guard, 1) * (end - 16);
        var sideT = h01(guard, 2) < 0.5 ? 1 : -1;
        var r3t = h01(guard, 3), r4t = h01(guard, 4), r5t = h01(guard, 5), r6t = h01(guard, 6);
        var isBirch = r3t < 0.20 && kit.trees.length > 1;
        var idx = isBirch ? 0 : (1 + (guard % Math.max(1, kit.trees.length - 1)));
        if (idx >= kit.trees.length) idx = kit.trees.length - 1;
        var band = isBirch ? birchLat : pineLat;
        var latT = sideT * (band[0] + (band[1] - band[0]) * r4t);
        var treeT = kit.trees[idx];
        var prefT = treeT.trunk;
        if (!prefT || !prefT.geo) continue;
        var scT = Math.max(0.35, Math.min(1.7, sampleQ(r5t, isBirch ? 4.7 : 8, isBirch ? 7 : 14, isBirch ? 14 : 28) / Math.max(treeT.h, 0.2)));
        var skT = treeT.h * scT * sampleQ(r6t, 0.02, 0.08, 0.4);
        var poseT = framePose(frames, alongT);
        var xt = poseT.x + poseT.rx * latT;
        var zt = poseT.z + poseT.rz * latT;
        var minRoad = isBirch ? 24 : 8.2;
        var spacing = isBirch ? 7.5 : 3.6;
        if (nearestRoad(xt, zt) < minRoad || blocked(xt, zt, spacing)) continue;
        var yawT = h01(guard, 9) * Math.PI * 2;
        batches.trunk.push({ pref: prefT, x: xt, y: poseT.y - skT, z: zt, yaw: yawT, sc: scT });
        if (treeT.branch && treeT.branch.geo) {
            batches.branch.push({ pref: treeT.branch, x: xt, y: poseT.y - skT, z: zt, yaw: yawT, sc: scT });
        }
        claim(xt, zt, spacing);
    }

    // Explicit near-verge trunk line — guarantees driveline collision presence.
    if (kit.trees.length) {
        var vergeDist = 2.5;
        var vergeN = 0;
        while (vergeDist < end) {
            for (var vs = -1; vs <= 1; vs += 2) {
                if (h01(vergeN, 41) > 0.72) { vergeN++; continue; }
                var vAlong = vergeDist + (h01(vergeN, 42) - 0.5) * 1.8;
                var vLat = vs * (8.5 + 3.5 * h01(vergeN, 43));
                var vPose = framePose(frames, vAlong);
                var vx = vPose.x + vPose.rx * vLat;
                var vz = vPose.z + vPose.rz * vLat;
                if (nearestRoad(vx, vz) < 8.0 || blocked(vx, vz, 2.8)) { vergeN++; continue; }
                var vTree = kit.trees[vergeN % kit.trees.length];
                if (!vTree.trunk || !vTree.trunk.geo) { vergeN++; continue; }
                var vSc = Math.max(0.45, Math.min(1.35,
                    sampleQ(h01(vergeN, 44), 7, 11, 18) / Math.max(vTree.h, 0.2)));
                var vSk = vTree.h * vSc * sampleQ(h01(vergeN, 45), 0.02, 0.06, 0.2);
                var vYaw = h01(vergeN, 46) * Math.PI * 2;
                batches.trunk.push({
                    pref: vTree.trunk, x: vx, y: vPose.y - vSk, z: vz, yaw: vYaw, sc: vSc
                });
                if (vTree.branch && vTree.branch.geo) {
                    batches.branch.push({
                        pref: vTree.branch, x: vx, y: vPose.y - vSk, z: vz, yaw: vYaw, sc: vSc
                    });
                }
                claim(vx, vz, 2.8);
                vergeN++;
            }
            vergeDist += 4.0;
        }
    }

    var holder = new THREE.Group();
    holder.name = 'js_forest_kit';
    batches.trunk = snapBatchToGround(parent, batches.trunk);
    batches.branch = snapBatchToGround(parent, batches.branch);
    batches.card = snapBatchToGround(parent, batches.card);
    batches.rock = snapBatchToGround(parent, batches.rock);
    batches.sapling = snapBatchToGround(parent, batches.sapling);
    var dummy = new THREE.Object3D();
    var stats = { trunk: 0, branch: 0, card: 0, rock: 0, sapling: 0, draws: 0 };

    function emit(list, namePrefix, solid) {
        if (!list.length) return;
        // Group by geometry uuid
        var groups = new Map();
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!item || !item.pref || !item.pref.geo) continue;
            var key = item.pref.geo.uuid;
            if (!groups.has(key)) groups.set(key, { pref: item.pref, items: [] });
            groups.get(key).items.push(item);
        }
        if (!groups.size) return;
        groups.forEach(function(g) {
            var mat = Array.isArray(g.pref.material) ? g.pref.material.map(function(m) { return m.clone(); }) : g.pref.material.clone();
            var mats = Array.isArray(mat) ? mat : [mat];
            mats.forEach(function(m) {
                if (!m) return;
                var mn = (m.name || '') + namePrefix;
                if (/branch|atlas|background|bush|grass|vegetation/i.test(mn)) {
                    m.transparent = false;
                    m.depthWrite = true;
                    m.alphaTest = Math.max(m.alphaTest || 0, 0.35);
                    m.side = THREE.DoubleSide;
                } else {
                    m.transparent = false;
                    m.depthWrite = true;
                    m.alphaTest = 0;
                }
                if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
                if (m.color) m.color.set(0xffffff);
                if ('metalness' in m) m.metalness = 0;
                m.needsUpdate = true;
            });
            var im = new THREE.InstancedMesh(g.pref.geo, Array.isArray(mat) ? mats : mats[0], g.items.length);
            im.name = namePrefix;
            im.castShadow = !!solid;
            im.receiveShadow = true;
            im.frustumCulled = true;
            if (solid) im.userData.environmentClass = 'solid';
            for (var k = 0; k < g.items.length; k++) {
                var it = g.items[k];
                dummy.position.set(it.x, it.y, it.z);
                dummy.rotation.set(0, it.yaw, 0);
                dummy.scale.set(it.sc, it.sc, it.sc);
                dummy.updateMatrix();
                im.setMatrixAt(k, dummy.matrix);
            }
            im.instanceMatrix.needsUpdate = true;
            holder.add(im);
            stats.draws++;
        });
    }

    emit(batches.trunk, 'Trunk_JS', true);
    stats.trunk = batches.trunk.length;
    emit(batches.branch, 'Tree_Branches_JS', false);
    stats.branch = batches.branch.length;
    emit(batches.sapling, 'Sapling_JS', true);
    stats.sapling = batches.sapling.length;
    emit(batches.card, 'Background_Tree_JS', false);
    stats.card = batches.card.length;
    emit(batches.rock, 'Rocks_JS', true);
    stats.rock = batches.rock.length;

    parent.add(holder);
    // Dispose kit scene (geometries kept by instances via clone)
    gltf.scene.traverse(function(o) {
        if (o.isMesh && o.geometry) {
            // keep — cloned into prefabs
        }
    });
    endFrameIndex();
    console.log('🌲 JS forest kit', stats);
    return stats;
}

/**
 * Spatial face chop → small FR tuft prefabs (compose-path-map._pick_standins).
 */
function pickStandins(mesh, minH, maxH, maxSpan, keep, minFaces) {
    var THREE = useTHREE();
    if (!mesh || !mesh.geometry) return [];
    mesh.updateWorldMatrix(true, false);
    var geo = mesh.geometry;
    var pos = geo.attributes.position;
    if (!pos) return [];
    var idx = geo.index;
    var uvAttr = geo.attributes.uv;
    var triCount = idx ? (idx.count / 3) | 0 : (pos.count / 3) | 0;
    if (triCount < minFaces) return [];
    var cell = Math.max(maxSpan * 0.55, 1.2);
    var buckets = new Map();
    var v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
    var mw = mesh.matrixWorld;

    function triCorner(t, corner) {
        var i = idx ? idx.getX(t * 3 + corner) : (t * 3 + corner);
        return i;
    }

    for (var t = 0; t < triCount; t++) {
        var i0 = triCorner(t, 0), i1 = triCorner(t, 1), i2 = triCorner(t, 2);
        v0.fromBufferAttribute(pos, i0).applyMatrix4(mw);
        v1.fromBufferAttribute(pos, i1).applyMatrix4(mw);
        v2.fromBufferAttribute(pos, i2).applyMatrix4(mw);
        var cx = (v0.x + v1.x + v2.x) / 3;
        var cz = (v0.z + v1.z + v2.z) / 3;
        var key = (Math.floor(cx / cell)) + '_' + (Math.floor(cz / cell));
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(t);
    }

    var picked = [];
    buckets.forEach(function(tris) {
        if (tris.length < minFaces) return;
        var positions = [];
        var uvs = [];
        var indices = [];
        var remap = new Map();
        function addVert(vi) {
            if (remap.has(vi)) return remap.get(vi);
            v0.fromBufferAttribute(pos, vi).applyMatrix4(mw);
            var id = positions.length / 3;
            positions.push(v0.x, v0.y, v0.z);
            if (uvAttr) uvs.push(uvAttr.getX(vi), uvAttr.getY(vi));
            else uvs.push(0, 0);
            remap.set(vi, id);
            return id;
        }
        for (var k = 0; k < tris.length; k++) {
            var tt = tris[k];
            var a = addVert(triCorner(tt, 0));
            var b = addVert(triCorner(tt, 1));
            var c = addVert(triCorner(tt, 2));
            indices.push(a, b, c);
        }
        var g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        g.setIndex(indices);
        g.computeBoundingBox();
        var box = g.boundingBox;
        var h = box.max.y - box.min.y;
        var span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
        if (h < minH || h > maxH || span > maxSpan * 1.35) {
            g.dispose();
            return;
        }
        var cx2 = (box.min.x + box.max.x) * 0.5;
        var cz2 = (box.min.z + box.max.z) * 0.5;
        g.translate(-cx2, -box.min.y, -cz2);
        g.computeBoundingBox();
        g.computeVertexNormals();
        picked.push({
            geo: g,
            h: h,
            w: span,
            faces: tris.length,
            material: mesh.material
        });
    });
    if (!picked.length) return [];
    picked.sort(function(a, b) { return (b.faces - a.faces) || (b.h - a.h); });
    if (picked.length <= keep) return picked;
    var out = [];
    for (var i = 0; i < keep; i++) {
        out.push(picked[Math.floor((i + 0.5) * picked.length / keep)]);
    }
    // Dispose unused geos
    var keepSet = new Set(out);
    for (var p = 0; p < picked.length; p++) {
        if (!keepSet.has(picked[p])) picked[p].geo.dispose();
    }
    return out;
}

function findFrSourceMesh(root, baseName) {
    var best = null;
    var bestScore = -1;
    root.traverse(function(o) {
        if (!o.isMesh || !o.geometry) return;
        var n = o.name || '';
        if (n.indexOf(baseName) < 0) return;
        var score = (/NOCOL/i.test(n) ? 1000 : 0) + (o.geometry.index ? o.geometry.index.count : 0);
        if (score > bestScore) { bestScore = score; best = o; }
    });
    return best;
}

/**
 * PY leaf_cards() — largest connected Fallen_Maple_Leaves / Rock_Decal clusters
 * flattened to XZ with real UVs (not solid-color quads).
 */
function extractGroundCards(mesh, keep, minSize) {
    var THREE = useTHREE();
    keep = keep != null ? keep : 16;
    minSize = minSize != null ? minSize : 0.4;
    if (!mesh || !mesh.geometry) return [];
    mesh.updateWorldMatrix(true, false);
    var geo = mesh.geometry;
    var pos = geo.attributes.position;
    var uvAttr = geo.attributes.uv;
    if (!pos || !uvAttr) return [];
    var idx = geo.index;
    var triCount = idx ? (idx.count / 3) | 0 : (pos.count / 3) | 0;
    if (triCount < 1) return [];
    var mw = mesh.matrixWorld;
    var v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();

    function triCorner(t, corner) {
        return idx ? idx.getX(t * 3 + corner) : (t * 3 + corner);
    }
    function keyXZ(x, z) {
        return (Math.round(x * 50) / 50) + '_' + (Math.round(z * 50) / 50);
    }

    // Union-find on shared edges (PY leaf_cards).
    var parent = new Array(triCount);
    for (var i = 0; i < triCount; i++) parent[i] = i;
    function find(a) {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
    }
    function union(a, b) {
        var ra = find(a), rb = find(b);
        if (ra !== rb) parent[rb] = ra;
    }
    var edge = new Map();
    function addEdge(t, ia, ib) {
        v0.fromBufferAttribute(pos, ia).applyMatrix4(mw);
        v1.fromBufferAttribute(pos, ib).applyMatrix4(mw);
        var ka = keyXZ(v0.x, v0.z), kb = keyXZ(v1.x, v1.z);
        var ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        if (edge.has(ek)) union(edge.get(ek), t);
        else edge.set(ek, t);
    }
    for (var t = 0; t < triCount; t++) {
        var i0 = triCorner(t, 0), i1 = triCorner(t, 1), i2 = triCorner(t, 2);
        addEdge(t, i0, i1); addEdge(t, i1, i2); addEdge(t, i2, i0);
    }
    var groups = new Map();
    for (var g = 0; g < triCount; g++) {
        var r = find(g);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(g);
    }

    var cards = [];
    groups.forEach(function(tris) {
        var xs = [], zs = [];
        var localTris = [];
        for (var k = 0; k < tris.length; k++) {
            var tt = tris[k];
            var a = triCorner(tt, 0), b = triCorner(tt, 1), c = triCorner(tt, 2);
            v0.fromBufferAttribute(pos, a).applyMatrix4(mw);
            v1.fromBufferAttribute(pos, b).applyMatrix4(mw);
            v2.fromBufferAttribute(pos, c).applyMatrix4(mw);
            xs.push(v0.x, v1.x, v2.x);
            zs.push(v0.z, v1.z, v2.z);
            localTris.push({
                ax: v0.x, az: v0.z, bx: v1.x, bz: v1.z, cx: v2.x, cz: v2.z,
                ua: uvAttr.getX(a), va: uvAttr.getY(a),
                ub: uvAttr.getX(b), vb: uvAttr.getY(b),
                uc: uvAttr.getX(c), vc: uvAttr.getY(c)
            });
        }
        var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
        var minZ = Math.min.apply(null, zs), maxZ = Math.max.apply(null, zs);
        var w = maxX - minX, h = maxZ - minZ;
        if (w < minSize || h < minSize || w > 14 || h > 14) return;
        var cx = (minX + maxX) * 0.5, cz = (minZ + maxZ) * 0.5;
        var out = [];
        for (var j = 0; j < localTris.length; j++) {
            var tr = localTris[j];
            out.push({
                ax: tr.ax - cx, az: tr.az - cz,
                bx: tr.bx - cx, bz: tr.bz - cz,
                cx: tr.cx - cx, cz: tr.cz - cz,
                ua: tr.ua, va: tr.va, ub: tr.ub, vb: tr.vb, uc: tr.uc, vc: tr.vc
            });
        }
        cards.push({ area: w * h, tris: out, r: Math.hypot(w, h) * 0.5 });
    });
    cards.sort(function(a, b) { return b.area - a.area; });
    return cards.slice(0, keep);
}

/** PY road_point — seat a card vertex on path bend + grade. */
function roadPoint(frames, along, lat, yOff) {
    var pose = framePose(frames, along);
    return {
        x: pose.x + pose.rx * lat,
        y: pose.y + yOff,
        z: pose.z + pose.rz * lat
    };
}

function groundCardMaterial(srcMesh) {
    var THREE = useTHREE();
    var src = srcMesh && srcMesh.material
        ? (Array.isArray(srcMesh.material) ? srcMesh.material[0] : srcMesh.material)
        : null;
    var map = src && src.map ? src.map : null;
    if (map) {
        map.colorSpace = THREE.SRGBColorSpace;
        map.needsUpdate = true;
    }
    var m = new THREE.MeshBasicMaterial({
        map: map,
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        depthWrite: true,
        alphaTest: 0.35,
        toneMapped: true,
        fog: true
    });
    m.polygonOffset = true;
    m.polygonOffsetFactor = -1;
    m.polygonOffsetUnits = -1;
    return m;
}

/** PY place_leaf_cards — one Path_Leaves mesh, FR UVs, seated on dirt/verge. */
function placeLeafCardsMesh(frames, cards, srcMesh, opts) {
    var THREE = useTHREE();
    opts = opts || {};
    if (!cards.length) return null;
    var yOff = opts.yOff != null ? opts.yOff : 0.06;
    var latMin = opts.latMin != null ? opts.latMin : 0.4;
    var latMax = opts.latMax != null ? opts.latMax : 11.0;
    var stepMin = opts.stepMin != null ? opts.stepMin : 3.5;
    var stepMax = opts.stepMax != null ? opts.stepMax : 8.0;
    var end = frames[frames.length - 1].dist - 6;
    var positions = [];
    var uvs = [];
    var indices = [];
    var dist = 8.0;
    var n = 0;
    while (dist < end) {
        var ang = ((n * 47) % 180) * Math.PI / 180;
        var sides = ((n * 3) % 4) ? [1, -1] : [1];
        for (var si = 0; si < sides.length; si++) {
            var use = cards[(n * 7 + si) % cards.length].tris;
            var lat = sides[si] * (latMin + ((n * 13 + si * 37) % 100) / 99 * (latMax - latMin));
            var along = (((n * 17 + si * 11) % 10) / 10 - 0.5) * 2.2;
            var aang = ang + si * 1.3;
            var ca = Math.cos(aang), sa = Math.sin(aang);
            for (var ti = 0; ti < use.length; ti++) {
                var tr = use[ti];
                var base = positions.length / 3;
                var corners = [
                    [tr.ax, tr.az, tr.ua, tr.va],
                    [tr.bx, tr.bz, tr.ub, tr.vb],
                    [tr.cx, tr.cz, tr.uc, tr.vc]
                ];
                for (var ci = 0; ci < 3; ci++) {
                    var lx = corners[ci][0], ly = corners[ci][1];
                    var rx = ca * lx - sa * ly;
                    var ry = sa * lx + ca * ly;
                    var p = roadPoint(frames, dist + along + rx, lat + ry, yOff);
                    positions.push(p.x, p.y, p.z);
                    uvs.push(corners[ci][2], corners[ci][3]);
                }
                indices.push(base, base + 1, base + 2);
            }
        }
        dist += stepMin + ((n * 29) % 100) / 99 * (stepMax - stepMin);
        n++;
    }
    if (!indices.length) return null;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    var mesh = new THREE.Mesh(geo, groundCardMaterial(srcMesh));
    mesh.name = opts.name || 'Path_Leaves';
    mesh.renderOrder = 4;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData.environmentClass = 'nocoll';
    mesh.userData.groundCardPlaced = n;
    return mesh;
}

/** PY place_pebble_cards — Rock_Decal islands as Path_Pebbles on dirt. */
function placePebbleCardsMesh(frames, cards, srcMesh, opts) {
    var THREE = useTHREE();
    opts = opts || {};
    if (!cards.length) return null;
    var yOff = opts.yOff != null ? opts.yOff : 0.012;
    var latMax = opts.latMax != null ? opts.latMax : 3.2;
    var gap = opts.gap != null ? opts.gap : 0.45;
    var end = frames[frames.length - 1].dist - 8;
    var positions = [];
    var uvs = [];
    var indices = [];
    var dist = 10.0;
    var n = 0;
    while (dist < end) {
        var idx = (n * 5) % cards.length;
        var card = cards[idx];
        // Cap spacing radius — huge FR islands otherwise leave sparse dirt.
        var r = Math.min(1.15, card.r || 0.4);
        var nxtR = Math.min(1.15, cards[(idx + 5) % cards.length].r || 0.4);
        var ang = ((n * 47) % 180) * Math.PI / 180;
        var ca = Math.cos(ang), sa = Math.sin(ang);
        var lat = (((n * 13) % 100) / 99 - 0.5) * 2 * latMax;
        var center = dist + r;
        var use = card.tris;
        for (var ti = 0; ti < use.length; ti++) {
            var tr = use[ti];
            var base = positions.length / 3;
            var corners = [
                [tr.ax, tr.az, tr.ua, tr.va],
                [tr.bx, tr.bz, tr.ub, tr.vb],
                [tr.cx, tr.cz, tr.uc, tr.vc]
            ];
            for (var ci = 0; ci < 3; ci++) {
                var lx = corners[ci][0], ly = corners[ci][1];
                var rx = ca * lx - sa * ly;
                var ry = sa * lx + ca * ly;
                var p = roadPoint(frames, center + rx, lat + ry, yOff);
                positions.push(p.x, p.y, p.z);
                uvs.push(corners[ci][2], corners[ci][3]);
            }
            indices.push(base, base + 1, base + 2);
        }
        dist = center + r + nxtR + gap;
        n++;
    }
    if (!indices.length) return null;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    var mesh = new THREE.Mesh(geo, groundCardMaterial(srcMesh));
    mesh.name = opts.name || 'Path_Pebbles';
    mesh.renderOrder = 4;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.userData.environmentClass = 'nocoll';
    mesh.userData.groundCardPlaced = n;
    return mesh;
}

function yieldFrame() {
    return new Promise(function(resolve) {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function() { resolve(); });
        else setTimeout(resolve, 0);
    });
}

/**
 * Stamp Forest Road verge — same sources + densities as compose-path-map
 * scatter_fr_veg() (Grass_Vegetation_* / Forest_Bush standins).
 * opts.gltf — reuse already-loaded forest-road.glb (skips a second full decode).
 * opts.onProgress(pct01, msg) — splash updates while scattering.
 */
export async function placeFrRoadside(loader, frames, parent, opts) {
    var THREE = useTHREE();
    opts = opts || {};
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    function prog(p, msg) { if (onProgress) onProgress(p, msg); }

    prog(0.02, 'FR verge — loading…');
    var gltf = opts.gltf;
    if (!gltf) {
        gltf = await new Promise(function(resolve, reject) {
            loader.load(FR_SOURCE_URL, resolve, undefined, reject);
        });
    }
    gltf.scene.updateMatrixWorld(true);
    await yieldFrame();

    prog(0.08, 'FR verge — standins…');
    var drySrc = findFrSourceMesh(gltf.scene, 'Grass_Vegetation_Dry');
    var greenSrc = findFrSourceMesh(gltf.scene, 'Grass_Vegetation_Green');
    var bushSrc = findFrSourceMesh(gltf.scene, 'Forest_Bush');
    var leafSrc = findFrSourceMesh(gltf.scene, 'Fallen_Maple_Leaves')
        || findFrSourceMesh(gltf.scene, 'Maple_Leaf');
    var pebbleSrc = findFrSourceMesh(gltf.scene, 'Rock_Decal');

    // Fewer/larger standins — pickStandins walks every FR face (was the stall).
    var dry = drySrc ? pickStandins(drySrc, 0.5, 3.2, 3.4, 20, 12) : [];
    await yieldFrame();
    var green = greenSrc ? pickStandins(greenSrc, 0.5, 2.6, 3.0, 20, 14) : [];
    await yieldFrame();
    var bush = bushSrc ? pickStandins(bushSrc, 0.6, 2.8, 4.0, 16, 12) : [];
    await yieldFrame();
    var leafCards = leafSrc ? extractGroundCards(leafSrc, 12, 0.45) : [];
    var pebbleCards = pebbleSrc ? extractGroundCards(pebbleSrc, 12, 0.4) : [];
    await yieldFrame();

    if (!dry.length && !green.length && !bush.length) {
        console.warn('FR verge standins empty', {
            drySrc: drySrc && drySrc.name,
            greenSrc: greenSrc && greenSrc.name,
            bushSrc: bushSrc && bushSrc.name
        });
        return { dry: 0, green: 0, bush: 0, leaves: 0, pebbles: 0 };
    }

    beginFrameIndex(frames, 24);

    var end = frames[frames.length - 1].dist;
    // Grid claims — same spirit as PY occupied_v (O(1) neighbor check).
    var grids = new Map();
    function blocked(x, z, spacing) {
        var gx = Math.floor(x / spacing), gz = Math.floor(z / spacing);
        for (var ox = -1; ox <= 1; ox++) {
            for (var oz = -1; oz <= 1; oz++) {
                var list = grids.get((gx + ox) + '_' + (gz + oz));
                if (!list) continue;
                for (var i = 0; i < list.length; i++) {
                    var dx = x - list[i].x, dz = z - list[i].z;
                    if (dx * dx + dz * dz < spacing * spacing) return true;
                }
            }
        }
        return false;
    }
    function claim(x, z, spacing) {
        var key = Math.floor(x / spacing) + '_' + Math.floor(z / spacing);
        if (!grids.has(key)) grids.set(key, []);
        grids.get(key).push({ x: x, z: z });
    }

    function pickLat(r, bands) {
        var acc = 0;
        for (var i = 0; i < bands.length; i++) acc += bands[i][2];
        var t = r * acc;
        for (var j = 0; j < bands.length; j++) {
            t -= bands[j][2];
            if (t <= 0) return bands[j];
        }
        return bands[bands.length - 1];
    }

    function scatter(prefs, bands, step, spacing, minRoad, chance, sinkF, scaleRange, out) {
        if (!prefs.length) return;
        var dist = 4.0;
        var n = 0;
        while (dist < end) {
            for (var side = -1; side <= 1; side += 2) {
                if (h01(n, 31) > chance) { n++; continue; }
                var band = pickLat(h01(n, 32), bands);
                var lat = side * (band[0] + (band[1] - band[0]) * h01(n, 33));
                var along = dist + (h01(n, 34) - 0.5) * step * 0.55;
                var pose = framePose(frames, along);
                var x = pose.x + pose.rx * lat;
                var z = pose.z + pose.rz * lat;
                var roadLat = Math.abs(nearestFrame(frames, x, z).lat);
                if (roadLat < minRoad || blocked(x, z, spacing)) { n++; continue; }
                var pref = prefs[n % prefs.length];
                var sc = scaleRange[0] + (scaleRange[1] - scaleRange[0]) * h01(n, 35);
                var sk = pref.h * sc * sampleQ(h01(n, 36), sinkF[0], sinkF[1], sinkF[2]);
                // Tiny lift so flat cards clear Path_Dirt / Path_Grass z-fight.
                var lift = (pref.h < 0.35) ? 0.045 : 0.01;
                out.push({
                    pref: pref,
                    x: x, y: pose.y - sk + lift, z: z,
                    yaw: h01(n, 37) * Math.PI * 2,
                    sc: sc
                });
                claim(x, z, spacing);
                n++;
            }
            dist += step;
        }
    }

    var dryPlaced = [];
    var greenPlaced = [];
    var bushPlaced = [];
    // Slightly coarser steps than raw PY — same look, far fewer nearest-frame probes.
    prog(0.35, 'FR verge — dry grass…');
    scatter(
        dry,
        [[5.2, 9.0, 0.50], [9.0, 14, 0.35], [14, 20, 0.15]],
        0.48, 1.2, 5.0, 0.90,
        [0.45, 0.62, 0.82], [0.85, 1.15], dryPlaced
    );
    await yieldFrame();
    prog(0.55, 'FR verge — green grass…');
    scatter(
        green,
        [[5.0, 8.8, 0.50], [8.8, 14, 0.35], [14, 20, 0.15]],
        0.45, 1.15, 4.9, 0.92,
        [0.40, 0.55, 0.75], [0.9, 1.2], greenPlaced
    );
    await yieldFrame();
    prog(0.70, 'FR verge — bushes…');
    scatter(
        bush,
        [[5.5, 10.0, 0.50], [10.0, 16, 0.35], [16, 22, 0.15]],
        1.15, 1.7, 5.2, 0.92,
        [0.05, 0.20, 0.40], [0.95, 1.25], bushPlaced
    );
    await yieldFrame();

    var holder = new THREE.Group();
    holder.name = 'js_fr_roadside';
    var dummy = new THREE.Object3D();

    function emit(list, namePrefix, alphaTest) {
        if (!list.length) return 0;
        var groups = new Map();
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            if (!item.pref || !item.pref.geo) continue;
            var key = item.pref.geo.uuid;
            if (!groups.has(key)) groups.set(key, { pref: item.pref, items: [] });
            groups.get(key).items.push(item);
        }
        var draws = 0;
        groups.forEach(function(g) {
            var mat = Array.isArray(g.pref.material)
                ? g.pref.material.map(function(m) { return m.clone(); })
                : g.pref.material.clone();
            var mats = Array.isArray(mat) ? mat : [mat];
            mats.forEach(function(m) {
                if (!m) return;
                m.transparent = false;
                m.depthWrite = true;
                m.alphaTest = Math.max(m.alphaTest || 0, alphaTest);
                m.side = THREE.DoubleSide;
                if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
                if (m.color) m.color.set(0xffffff);
                if ('metalness' in m) m.metalness = 0;
                if ('envMapIntensity' in m) m.envMapIntensity = 0;
                m.needsUpdate = true;
            });
            var im = new THREE.InstancedMesh(
                g.pref.geo,
                Array.isArray(mat) ? mats : mats[0],
                g.items.length
            );
            im.name = namePrefix;
            im.castShadow = false;
            im.receiveShadow = true;
            im.frustumCulled = true;
            for (var k = 0; k < g.items.length; k++) {
                var it = g.items[k];
                dummy.position.set(it.x, it.y, it.z);
                dummy.rotation.set(0, it.yaw, 0);
                dummy.scale.set(it.sc, it.sc, it.sc);
                dummy.updateMatrix();
                im.setMatrixAt(k, dummy.matrix);
            }
            im.instanceMatrix.needsUpdate = true;
            holder.add(im);
            draws++;
        });
        return draws;
    }

    prog(0.82, 'FR verge — instances…');
    dryPlaced = snapBatchToGround(parent, dryPlaced);
    greenPlaced = snapBatchToGround(parent, greenPlaced);
    bushPlaced = snapBatchToGround(parent, bushPlaced);
    emit(dryPlaced, 'FR_Grass_Dry_JS', 0.35);
    await yieldFrame();
    emit(greenPlaced, 'FR_Grass_Green_JS', 0.35);
    await yieldFrame();
    emit(bushPlaced, 'FR_Forest_Bush_JS', 0.35);
    await yieldFrame();

    // PY Path_Leaves / Path_Pebbles — textured FR cards seated on the road (NOT neon quads).
    prog(0.90, 'FR verge — leaves / pebbles…');
    var leafMesh = leafCards.length
        ? placeLeafCardsMesh(frames, leafCards, leafSrc, {
            name: 'Path_Leaves', yOff: 0.04, latMin: 0.4, latMax: 11.0,
            stepMin: 3.5, stepMax: 8.0
        })
        : null;
    await yieldFrame();
    var pebbleMesh = pebbleCards.length
        ? placePebbleCardsMesh(frames, pebbleCards, pebbleSrc, {
            name: 'Path_Pebbles', yOff: 0.015, latMax: 3.8, gap: 0.35
        })
        : null;
    if (leafMesh) holder.add(leafMesh);
    if (pebbleMesh) holder.add(pebbleMesh);
    if (!leafCards.length) console.warn('JS Path_Leaves: no FR leaf cards from', leafSrc && leafSrc.name);
    if (!pebbleCards.length) console.warn('JS Path_Pebbles: no FR rock cards from', pebbleSrc && pebbleSrc.name);

    parent.add(holder);
    endFrameIndex();
    prog(1, 'FR verge done');
    var leafN = leafMesh ? (leafMesh.userData.groundCardPlaced || 0) : 0;
    var pebN = pebbleMesh ? (pebbleMesh.userData.groundCardPlaced || 0) : 0;
    var leafTris = leafMesh && leafMesh.geometry.index
        ? (leafMesh.geometry.index.count / 3) | 0 : 0;
    var pebTris = pebbleMesh && pebbleMesh.geometry.index
        ? (pebbleMesh.geometry.index.count / 3) | 0 : 0;
    var stats = {
        dry: dryPlaced.length,
        green: greenPlaced.length,
        bush: bushPlaced.length,
        leaves: leafN,
        pebbles: pebN,
        leafTris: leafTris,
        pebbleTris: pebTris,
        prefabs: {
            dry: dry.length, green: green.length, bush: bush.length,
            leaves: leafCards.length, pebbles: pebbleCards.length
        }
    };
    console.log('🌿 JS FR roadside', stats);
    return stats;
}

/**
 * Road surfaces: MeshBasic albedo (no IBL sky-mirror). Dirt/gravel use atlas
 * soft alpha like PY BLEND overlays; opaque roadbed sits underneath.
 */
export function applyForestRoadSurfaceMats(meshes, bag) {
    var THREE = useTHREE();
    function basicFrom(src, fallbackHex, opts) {
        opts = opts || {};
        var map = src && src.map ? src.map : null;
        if (map) {
            map.colorSpace = THREE.SRGBColorSpace;
            map.wrapS = THREE.RepeatWrapping;
            map.wrapT = opts.clampV ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
            map.needsUpdate = true;
        }
        var m = new THREE.MeshBasicMaterial({
            map: map || null,
            color: map ? 0xffffff : fallbackHex,
            side: THREE.DoubleSide,
            toneMapped: true,
            fog: true
        });
        if (opts.softBlend) {
            // PY tuneForestMaterial(..., 'blend'): soft shoulder feather, roadbed below.
            m.transparent = true;
            m.alphaTest = 0.04;
            m.depthWrite = false;
            m.opacity = 1;
        } else {
            m.transparent = false;
            m.depthWrite = true;
            m.alphaTest = 0;
        }
        m.polygonOffset = true;
        m.polygonOffsetFactor = opts.order || 1;
        m.polygonOffsetUnits = opts.order || 1;
        m.needsUpdate = true;
        return m;
    }
    if (meshes.grass) {
        meshes.grass.material = basicFrom(bag && bag.grass, 0x6a7a4a, { order: 1 });
        meshes.grass.material.side = THREE.FrontSide;
        meshes.grass.renderOrder = 1;
    }
    if (meshes.dirt) {
        // Same as Path GLB runtime: atlas acid rim at V 0/1, alphaTest 0.82.
        // softBlend (alphaTest 0.04) left a bright grass rail at the dirt edge.
        meshes.dirt.material = basicFrom(bag && bag.dirt, 0x8d7b62, {
            order: 2, clampV: true
        });
        meshes.dirt.material.transparent = false;
        meshes.dirt.material.depthWrite = true;
        meshes.dirt.material.alphaTest = 0.82;
        meshes.dirt.material.side = THREE.FrontSide;
        meshes.dirt.renderOrder = 2;
    }
    if (meshes.roadbed) {
        meshes.roadbed.material = basicFrom(
            (bag && (bag.dirt || bag.ground)) || null,
            0x5a4a38,
            { order: 2, clampV: true }
        );
        meshes.roadbed.material.alphaTest = 0;
        meshes.roadbed.material.transparent = false;
        meshes.roadbed.material.depthWrite = true;
        meshes.roadbed.visible = true;
    }
    if (meshes.gravelR) {
        meshes.gravelR.material = basicFrom(bag && (bag.gravel || bag.dirt), 0x8a7a60, {
            order: 4, softBlend: true, clampV: true
        });
        // Default hidden — JS compose unhides for soft dirt|grass feather.
        meshes.gravelR.visible = false;
    }
    if (meshes.gravelL) {
        meshes.gravelL.material = basicFrom(bag && (bag.gravel || bag.dirt), 0x8a7a60, {
            order: 4, softBlend: true, clampV: true
        });
        meshes.gravelL.visible = false;
    }
    if (meshes.terrain) {
        meshes.terrain.material = basicFrom(
            bag && (bag.grass || bag.ground),
            0x5d7348,
            { order: 0 }
        );
    }
    if (meshes.terrainOuter) {
        meshes.terrainOuter.material = basicFrom(
            bag && (bag.grass || bag.ground),
            0x5d7348,
            { order: 0 }
        );
    }
}

/** Hide gravel/blend strips applyPathDressing adds — they paint hard rails / mirrors. */
export function sanitizeJsPathDressing(root) {
    if (!root) return 0;
    var n = 0;
    root.traverse(function(o) {
        if (!o.isMesh) return;
        var name = o.name || '';
        var mat = o.material;
        // Only hide dressing leftovers — never our JS Path_Gravel_L/R or Path_Leaves_JS.
        if (/^Path_Gravel$|^path_leaves$|^Path_Trails/i.test(name)) {
            o.visible = false;
            n++;
            return;
        }
        if (!name && mat && (mat.transparent || (mat.opacity != null && mat.opacity < 1))) {
            o.visible = false;
            n++;
        }
    });
    return n;
}
