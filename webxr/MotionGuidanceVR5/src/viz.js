/** Desktop charts + Portal/Lab-style chamber HUD. */
import * as THREE from 'three';

const DEG = 180 / Math.PI;

export class DesktopViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.summaryEl = document.getElementById('summary');
    this._resize();
    addEventListener('resize', () => this._resize());
  }

  _resize() {
    const r = this.canvas.parentElement?.getBoundingClientRect();
    const w = Math.max(320, Math.floor(r?.width || 640));
    const h = Math.max(220, Math.floor(r?.height || 360));
    this.canvas.width = w * devicePixelRatio;
    this.canvas.height = h * devicePixelRatio;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    this.w = w; this.h = h;
  }

  clearLive(msg = 'Waiting for session…') {
    const { ctx, w, h } = this;
    ctx.fillStyle = '#0c1214';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#6a8a90';
    ctx.font = '13px system-ui,sans-serif';
    ctx.fillText(msg, 16, 28);
  }

  drawLive(samples, rms) {
    const { ctx, w, h } = this;
    ctx.fillStyle = '#0c1214';
    ctx.fillRect(0, 0, w, h);
    const pad = 36;
    const plotH = h - pad * 2;
    const plotW = w - pad * 2;
    const n = Math.min(samples.length, 600);
    if (!n) return;
    const slice = samples.slice(-n);
    const t0 = slice[0].t, t1 = slice[slice.length - 1].t || t0 + 1;

    ctx.strokeStyle = '#1e2e32';
    ctx.beginPath();
    ctx.moveTo(pad, pad + plotH / 2);
    ctx.lineTo(pad + plotW, pad + plotH / 2);
    ctx.stroke();

    const draw = (key, color, scaleDeg = 25) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < slice.length; i++) {
        const s = slice[i];
        const x = pad + ((s.t - t0) / (t1 - t0)) * plotW;
        const y = pad + plotH / 2 - (s[key] * DEG / scaleDeg) * (plotH / 2);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    draw('errYaw', '#5ec8ff');
    draw('errRoll', '#ff8a5c');
    ctx.strokeStyle = 'rgba(120,220,160,0.45)';
    ctx.beginPath();
    for (let i = 0; i < slice.length; i++) {
      const s = slice[i];
      const x = pad + ((s.t - t0) / (t1 - t0)) * plotW;
      const y = pad + plotH / 2 - Math.max(-1, Math.min(1, s.curvature * 4)) * (plotH / 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = '#a8c4c8';
    ctx.font = '12px system-ui,sans-serif';
    ctx.fillText(
      `errYaw (cyan)  errRoll (orange)  curv (green)   RMS yaw=${(rms.yaw * DEG).toFixed(1)}° roll=${(rms.roll * DEG).toFixed(1)}°`,
      12, 18,
    );
  }

  drawSession(capture) {
    const samples = capture.samples.filter((s) => s.phase === 1 || s.phase === 0);
    const summary = capture.summarize();
    this.drawLive(samples.length ? samples : capture.samples, capture.rmsErrors(5));

    const { ctx, w, h } = this;
    const mid = Math.floor(h * 0.58);
    ctx.fillStyle = '#0c1214';
    ctx.fillRect(0, mid, w, h - mid);

    const turnThr = 0.08;
    const turns = samples.filter((s) => Math.abs(s.curvature) >= turnThr).map((s) => Math.abs(s.errRoll) * DEG);
    const straights = samples.filter((s) => Math.abs(s.curvature) < turnThr).map((s) => Math.abs(s.errRoll) * DEG);
    this._hist(ctx, 24, mid + 28, w / 2 - 40, h - mid - 48, turns, '#ff8a5c', '|errRoll|° turns');
    this._hist(ctx, w / 2 + 16, mid + 28, w / 2 - 40, h - mid - 48, straights, '#5ec8ff', '|errRoll|° straights');

    if (this.summaryEl) {
      const r = summary.ride;
      const b = summary.baseline;
      this.summaryEl.innerHTML = `
        <div><b>${summary.meta.testName || summary.meta.testId || summary.meta.protocol}</b>
          · ${summary.durationSec.toFixed(1)}s · ${summary.nSamples} samples</div>
        <div><b>Still / baseline sway RMS</b> ${b.swayRmsMean.toFixed(4)} m</div>
        <div><b>Mean |err|</b> yaw ${r.meanAbsErrYawDeg.toFixed(2)}° · roll ${r.meanAbsErrRollDeg.toFixed(2)}°</div>
        <div><b>Peak |err|</b> yaw ${r.peakAbsErrYawDeg.toFixed(2)}° · roll ${r.peakAbsErrRollDeg.toFixed(2)}°</div>
        <div><b>Adaptation slope</b> yaw ${r.adaptationSlopeYawDeg.toFixed(2)}° · roll ${r.adaptationSlopeRollDeg.toFixed(2)}°</div>
      `;
    }
  }

  _hist(ctx, x, y, w, h, values, color, label) {
    ctx.fillStyle = '#6a8a90';
    ctx.font = '11px system-ui,sans-serif';
    ctx.fillText(label + (values.length ? ` (n=${values.length})` : ' (empty)'), x, y - 8);
    const bins = 12;
    const maxV = Math.max(20, ...values, 1);
    const counts = new Array(bins).fill(0);
    for (const v of values) {
      const i = Math.min(bins - 1, Math.floor((v / maxV) * bins));
      counts[i]++;
    }
    const maxC = Math.max(1, ...counts);
    const bw = w / bins;
    for (let i = 0; i < bins; i++) {
      const bh = (counts[i] / maxC) * (h - 4);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(x + i * bw + 1, y + h - bh, bw - 2, bh);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = '#1e2e32';
    ctx.strokeRect(x, y, w, h);
  }
}

/* Head-locked VrHud removed — in-XR guidance is worldPanel only (see chamberEnv.js). */
