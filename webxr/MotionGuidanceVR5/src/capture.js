/** Ring-buffer capture, derived metrics, JSONL + summary export. */
import { angleError } from './path.js';

const DEG = 180 / Math.PI;

export class SignalCapture {
  constructor(opts = {}) {
    this.capacity = opts.capacity || 120000; // ~30 min @ 72 Hz
    this.samples = [];
    this.events = [];
    this.meta = {
      participantId: '',
      protocol: 'seated',
      startedAt: null,
      endedAt: null,
      speedMps: 0.9,
      baselineSec: 15,
      rideSec: 90,
    };
    this._prev = null;
    this._swayWin = [];
    this._swayWinSec = 2.0;
  }

  reset(meta = {}) {
    Object.assign(this.meta, meta);
    this.samples.length = 0;
    this.events.length = 0;
    this._prev = null;
    this._swayWin.length = 0;
    this.meta.startedAt = new Date().toISOString();
    this.meta.endedAt = null;
  }

  mark(type, extra = {}) {
    const t = this.samples.length ? this.samples[this.samples.length - 1].t : 0;
    this.events.push({ t, type, ...extra });
  }

  /**
   * Push one sample.
   * @param {object} p
   * @param {number} p.t session seconds
   * @param {number} p.phase 0 baseline 1 ride 2 end
   * @param {object} p.path { s, speed, curvature (+ = left turn), yaw, x, y, z, grade }
   * @param {object} p.head { x,y,z, yaw,pitch,roll, qx,qy,qz,qw }
   * @param {object} p.ideal { yaw, pitch, roll }
   * @param {object} [p.ctrl]
   * @param {number} p.calm 0..1
   */
  push(p) {
    if (this.samples.length >= this.capacity) this.samples.shift();

    const errYaw = angleError(p.head.yaw, p.ideal.yaw);
    const errPitch = angleError(p.head.pitch, p.ideal.pitch);
    const errRoll = angleError(p.head.roll, p.ideal.roll);

    let angVelYaw = 0, angVelPitch = 0, angVelRoll = 0;
    let angAccYaw = 0, angAccPitch = 0, angAccRoll = 0;
    if (this._prev) {
      const dt = Math.max(1e-4, p.t - this._prev.t);
      angVelYaw = angleError(p.head.yaw, this._prev.head.yaw) / dt;
      angVelPitch = angleError(p.head.pitch, this._prev.head.pitch) / dt;
      angVelRoll = angleError(p.head.roll, this._prev.head.roll) / dt;
      angAccYaw = (angVelYaw - this._prev.angVelYaw) / dt;
      angAccPitch = (angVelPitch - this._prev.angVelPitch) / dt;
      angAccRoll = (angVelRoll - this._prev.angVelRoll) / dt;
    }

    // Sway in viewer frame: path is kept under the user (origin), so lateral drift is head XZ.
    const hx = p.head.x;
    const hz = p.head.z;
    this._swayWin.push({ t: p.t, hx, hz });
    const cut = p.t - this._swayWinSec;
    while (this._swayWin.length && this._swayWin[0].t < cut) this._swayWin.shift();
    let swayRms = 0, swayPath = 0;
    if (this._swayWin.length > 1) {
      let sum = 0;
      for (let i = 0; i < this._swayWin.length; i++) {
        const w = this._swayWin[i];
        sum += w.hx * w.hx + w.hz * w.hz;
        if (i) {
          const a = this._swayWin[i - 1];
          swayPath += Math.hypot(w.hx - a.hx, w.hz - a.hz);
        }
      }
      swayRms = Math.sqrt(sum / this._swayWin.length);
    }

    const row = {
      t: +p.t.toFixed(4),
      frame: this.samples.length,
      phase: p.phase,
      s: +p.path.s.toFixed(4),
      speed: +p.path.speed.toFixed(4),
      curvature: +p.path.curvature.toFixed(5),
      pathYaw: +p.path.yaw.toFixed(5),
      pathX: +(p.path.x ?? 0).toFixed(4),
      pathZ: +(p.path.z ?? 0).toFixed(4),
      pathY: +(p.path.y ?? 0).toFixed(4),
      grade: +(p.path.grade ?? 0).toFixed(4),
      hx: +p.head.x.toFixed(4),
      hy: +p.head.y.toFixed(4),
      hz: +p.head.z.toFixed(4),
      yaw: +p.head.yaw.toFixed(5),
      pitch: +p.head.pitch.toFixed(5),
      roll: +p.head.roll.toFixed(5),
      idealYaw: +p.ideal.yaw.toFixed(5),
      idealPitch: +p.ideal.pitch.toFixed(5),
      idealRoll: +p.ideal.roll.toFixed(5),
      errYaw: +errYaw.toFixed(5),
      errPitch: +errPitch.toFixed(5),
      errRoll: +errRoll.toFixed(5),
      angVelYaw: +angVelYaw.toFixed(4),
      angVelPitch: +angVelPitch.toFixed(4),
      angVelRoll: +angVelRoll.toFixed(4),
      angAccYaw: +angAccYaw.toFixed(3),
      angAccPitch: +angAccPitch.toFixed(3),
      angAccRoll: +angAccRoll.toFixed(3),
      swayRms: +swayRms.toFixed(5),
      swayPath: +swayPath.toFixed(5),
      calm: +p.calm.toFixed(3),
    };
    if (p.ctrl) {
      row.cx = +p.ctrl.x.toFixed(4);
      row.cy = +p.ctrl.y.toFixed(4);
      row.cz = +p.ctrl.z.toFixed(4);
    }
    this.samples.push(row);
    this._prev = {
      t: p.t,
      head: { yaw: p.head.yaw, pitch: p.head.pitch, roll: p.head.roll },
      angVelYaw, angVelPitch, angVelRoll,
    };
    return row;
  }

  /** Rolling RMS of |errYaw| and |errRoll| over last `sec` seconds. */
  rmsErrors(sec = 5) {
    if (!this.samples.length) return { yaw: 0, roll: 0, pitch: 0 };
    const t1 = this.samples[this.samples.length - 1].t;
    const t0 = t1 - sec;
    let n = 0, y = 0, r = 0, p = 0;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i];
      if (s.t < t0) break;
      y += s.errYaw * s.errYaw;
      r += s.errRoll * s.errRoll;
      p += s.errPitch * s.errPitch;
      n++;
    }
    if (!n) return { yaw: 0, roll: 0, pitch: 0 };
    return { yaw: Math.sqrt(y / n), roll: Math.sqrt(r / n), pitch: Math.sqrt(p / n) };
  }

  summarize() {
    this.meta.endedAt = new Date().toISOString();
    const ride = this.samples.filter((s) => s.phase === 1);
    const base = this.samples.filter((s) => s.phase === 0);
    const meanAbs = (arr, k) => arr.length ? arr.reduce((a, s) => a + Math.abs(s[k]), 0) / arr.length : 0;
    const peakAbs = (arr, k) => arr.length ? Math.max(...arr.map((s) => Math.abs(s[k]))) : 0;
    const third = Math.floor(ride.length / 3) || 1;
    const early = ride.slice(0, third);
    const late = ride.slice(-third);
    const slope = (k) => meanAbs(late, k) - meanAbs(early, k); // negative => adapting

    const turnThr = 0.08; // 1/m
    const turns = ride.filter((s) => Math.abs(s.curvature) >= turnThr);
    const straights = ride.filter((s) => Math.abs(s.curvature) < turnThr);

    return {
      meta: { ...this.meta },
      nSamples: this.samples.length,
      nEvents: this.events.length,
      durationSec: this.samples.length ? this.samples[this.samples.length - 1].t : 0,
      baseline: {
        swayRmsMean: meanAbs(base, 'swayRms'),
        swayPathMean: base.length ? base.reduce((a, s) => a + s.swayPath, 0) / base.length : 0,
      },
      ride: {
        meanAbsErrYawDeg: meanAbs(ride, 'errYaw') * DEG,
        meanAbsErrRollDeg: meanAbs(ride, 'errRoll') * DEG,
        meanAbsErrPitchDeg: meanAbs(ride, 'errPitch') * DEG,
        peakAbsErrYawDeg: peakAbs(ride, 'errYaw') * DEG,
        peakAbsErrRollDeg: peakAbs(ride, 'errRoll') * DEG,
        adaptationSlopeYawDeg: slope('errYaw') * DEG,
        adaptationSlopeRollDeg: slope('errRoll') * DEG,
        turnMeanAbsErrRollDeg: meanAbs(turns, 'errRoll') * DEG,
        straightMeanAbsErrRollDeg: meanAbs(straights, 'errRoll') * DEG,
        turnMeanAbsErrYawDeg: meanAbs(turns, 'errYaw') * DEG,
        straightMeanAbsErrYawDeg: meanAbs(straights, 'errYaw') * DEG,
        meanSwayRms: meanAbs(ride, 'swayRms'),
      },
      events: this.events,
    };
  }

  toJSONL() {
    const lines = [];
    lines.push(JSON.stringify({ type: 'meta', ...this.meta }));
    for (const e of this.events) lines.push(JSON.stringify({ type: 'event', ...e }));
    for (const s of this.samples) lines.push(JSON.stringify({ type: 'sample', ...s }));
    return lines.join('\n') + '\n';
  }

  download() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = (this.meta.participantId || 'anon').replace(/[^\w-]+/g, '_');
    const base = `session-${id}-${this.meta.protocol}-${stamp}`;
    downloadBlob(`${base}.jsonl`, this.toJSONL(), 'application/x-ndjson');
    downloadBlob(`${base}-summary.json`, JSON.stringify(this.summarize(), null, 2), 'application/json');
    return base;
  }
}

function downloadBlob(name, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
