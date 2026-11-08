/**
 * 3D courses for the calibration halls.
 *
 * A course is defined by two eased profiles over horizontal arc length s:
 *   curvature κ(s)  (1/m, + = turning LEFT)  and  grade g(s)  (dy/ds).
 * Both are piecewise-linear, so heading rate and climb rate ramp in and out
 * (clothoid-style transitions) — no instant yaw-rate or pitch-rate steps.
 * Lab frame: start at (0, startY, 0) heading +Z; +X is the participant's LEFT.
 */

const TWO_PI = Math.PI * 2;
const wrapPi = (a) => {
  let x = a;
  while (x > Math.PI) x -= TWO_PI;
  while (x < -Math.PI) x += TWO_PI;
  return x;
};
const DS = 0.05;

/** Fluent route description: straight / turn sequence + independent climbs. */
export class Route {
  constructor(startY = 0) {
    this.startY = startY;
    this.s = 0;
    this.k = [[0, 0]];
    this.g = [];
  }

  straight(len) {
    this.s += len;
    this.k.push([this.s, 0]);
    return this;
  }

  /** deg > 0 turns left. ease = transition length (m) at each end. */
  turn(deg, radius, ease = 4) {
    const th = Math.abs(deg) * Math.PI / 180;
    const k = Math.sign(deg) / radius;
    const e = Math.min(ease, th * radius);
    const Lc = th * radius - e;
    this.k.push([this.s + e, k], [this.s + e + Lc, k], [this.s + 2 * e + Lc, 0]);
    this.s += 2 * e + Lc;
    return this;
  }

  /** Climb at `grade` between absolute arc lengths [from, to] with eased ends. */
  climb(from, to, grade, ease = 4) {
    const e = Math.min(ease, (to - from) / 2);
    this.g.push([from, 0], [from + e, grade], [to - e, grade], [to, 0]);
    return this;
  }
}

const lerpKnots = (knots, s) => {
  if (!knots.length) return 0;
  if (s <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    if (s <= knots[i][0]) {
      const [s0, v0] = knots[i - 1], [s1, v1] = knots[i];
      return s1 - s0 < 1e-9 ? v1 : v0 + (v1 - v0) * (s - s0) / (s1 - s0);
    }
  }
  return knots[knots.length - 1][1];
};

export class Course {
  /** @param {{kind:'still'} | {kind:'ride', route: Route}} def */
  constructor(def = { kind: 'still' }) {
    this.kind = def.kind;
    this.z0 = 0;
    const r = def.route;
    this.startY = r?.startY ?? def.startY ?? 0;
    this.length = r ? r.s : 0;
    const n = Math.max(1, Math.ceil(this.length / DS));
    const xs = new Float32Array(n + 1), ys = new Float32Array(n + 1), zs = new Float32Array(n + 1);
    const yaws = new Float32Array(n + 1), ks = new Float32Array(n + 1), gs = new Float32Array(n + 1);
    let x = 0, y = this.startY, z = 0, th = 0;
    const gKnots = r ? [...r.g].sort((a, b) => a[0] - b[0]) : [];
    for (let i = 0; i <= n; i++) {
      const s = Math.min(this.length, i * DS);
      const k = r ? lerpKnots(r.k, s) : 0;
      const g = gKnots.length ? lerpKnots(gKnots, s) : 0;
      xs[i] = x; ys[i] = y; zs[i] = z; yaws[i] = th; ks[i] = k; gs[i] = g;
      // midpoint integration
      const kn = r ? lerpKnots(r.k, s + DS / 2) : 0;
      const gn = gKnots.length ? lerpKnots(gKnots, s + DS / 2) : 0;
      const thm = th + kn * DS / 2;
      x += Math.sin(thm) * DS;
      z += Math.cos(thm) * DS;
      y += gn * DS;
      th += kn * DS;
    }
    Object.assign(this, { _x: xs, _y: ys, _z: zs, _yaw: yaws, _k: ks, _g: gs, _n: n });
    let minR = Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i <= n; i++) {
      if (Math.abs(ks[i]) > 1e-6) minR = Math.min(minR, 1 / Math.abs(ks[i]));
      minY = Math.min(minY, ys[i]);
      maxY = Math.max(maxY, ys[i]);
    }
    this.minRadius = minR;
    this.minY = minY;
    this.maxY = maxY;
  }

  /** Position, heading (yaw: 0 = +Z), curvature (+ left), grade at arc length s (clamped). */
  sample(s) {
    const u = Math.max(0, Math.min(this.length, s));
    const f = this.length > 0 ? u / DS : 0;
    const i = Math.min(this._n - 1, Math.floor(f));
    const t = Math.max(0, Math.min(1, f - i));
    const L = (a) => a[i] + (a[Math.min(this._n, i + 1)] - a[i]) * t;
    return { x: L(this._x), y: L(this._y), z: L(this._z), s: u, yaw: L(this._yaw), curvature: L(this._k), grade: L(this._g) };
  }

  /** Evenly spaced points for drawing (lab coords). */
  points(n = 64) {
    const out = [];
    for (let i = 0; i <= n; i++) out.push(this.sample((i / n) * this.length));
    return out;
  }
}

/**
 * Cruise profile over duration T for distance L: cosine ramp up, constant cruise,
 * cosine ramp down. Velocity and acceleration are continuous; v = 0 at both ends.
 */
export function cruiseProfile(L, T, ramp = 2.5) {
  const tr = Math.max(0.1, Math.min(ramp, T / 2 - 0.01));
  const vc = L > 0 ? L / (T - tr) : 0;
  const rampS = (t) => (vc / 2) * (t - (tr / Math.PI) * Math.sin((Math.PI * t) / tr));
  const rampV = (t) => (vc * (1 - Math.cos((Math.PI * t) / tr))) / 2;
  return {
    vc,
    T,
    at(t) {
      const tc = Math.max(0, Math.min(T, t));
      if (tc < tr) return { s: rampS(tc), v: rampV(tc) };
      if (tc <= T - tr) return { s: (vc * tr) / 2 + vc * (tc - tr), v: vc };
      const rem = T - tc;
      return { s: L - rampS(rem), v: rampV(rem) };
    },
  };
}

/** Seated turn-alignment ideal: lean into the curve (positive roll = lean left). */
export function idealRoll(curvature, gain = 0.55, max = 0.28) {
  return Math.max(-max, Math.min(max, gain * curvature));
}

export function angleError(actual, ideal) {
  return wrapPi(actual - ideal);
}

export { wrapPi };
