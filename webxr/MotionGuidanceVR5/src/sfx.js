/**
 * Procedural sound design (WebAudio, no assets):
 * - room tone: soft filtered air + low drone, through a reverb sized to the room
 * - motion: airflow that follows glide speed
 * - gaze tone: rises in pitch while a target fills
 * - chimes: confirm / step / target / complete / enter
 * Everything is quiet and slow-enveloped — it sits under the music and voice.
 */
export class Sfx {
  constructor() {
    this.ctx = null;
    this.on = true;
  }

  unlock() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    this.verb = ctx.createConvolver();
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.32;
    this.verb.connect(this.verbGain).connect(this.master);
    this._setReverb(2.2);

    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { b = 0.97 * b + 0.03 * (Math.random() * 2 - 1); d[i] = b * 6; }

    // room tone
    this.amb = ctx.createGain();
    this.amb.gain.value = 0;
    this.amb.connect(this.master);
    this.amb.connect(this.verb);
    const air = this._loopNoise();
    this.airLP = ctx.createBiquadFilter();
    this.airLP.type = 'lowpass';
    this.airLP.frequency.value = 500;
    const airG = ctx.createGain();
    airG.gain.value = 0.035;
    air.connect(this.airLP).connect(airG).connect(this.amb);
    this.drones = [0, 1].map((k) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 55 * (k ? 1.5 : 1);
      const g = ctx.createGain();
      g.gain.value = k ? 0.010 : 0.016;
      o.connect(g).connect(this.amb);
      o.start();
      return o;
    });

    // motion airflow
    const mo = this._loopNoise();
    this.motionBP = ctx.createBiquadFilter();
    this.motionBP.type = 'bandpass';
    this.motionBP.Q.value = 0.6;
    this.motionBP.frequency.value = 300;
    this.motion = ctx.createGain();
    this.motion.gain.value = 0;
    mo.connect(this.motionBP).connect(this.motion).connect(this.master);

    // gaze tone
    this.gazeOsc = ctx.createOscillator();
    this.gazeOsc.type = 'sine';
    this.gazeOsc.frequency.value = 440;
    this.gazeGain = ctx.createGain();
    this.gazeGain.gain.value = 0;
    this.gazeOsc.connect(this.gazeGain);
    this.gazeGain.connect(this.master);
    this.gazeGain.connect(this.verb);
    this.gazeOsc.start();
  }

  _loopNoise() {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.start(0, Math.random() * 1.5);
    return s;
  }

  _setReverb(sec) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * sec);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    this.verb.buffer = ir;
  }

  /** Re-tune the room tone for a new room (call while the screen is black). */
  setRoom(sound = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._setReverb(sound.size ?? 2);
    this.airLP.frequency.setTargetAtTime(sound.bright ?? 500, t, 0.3);
    this.drones[0].frequency.setTargetAtTime(sound.drone ?? 55, t, 0.3);
    this.drones[1].frequency.setTargetAtTime((sound.drone ?? 55) * 1.5, t, 0.3);
    this._ambLevel = sound.level ?? 0.8;
  }

  ambient(on) {
    if (!this.ctx) return;
    this.amb.gain.setTargetAtTime(on && this.on ? (this._ambLevel ?? 0.8) : 0, this.ctx.currentTime, on ? 1.2 : 0.5);
  }

  /** speed in m/s */
  setMotion(speed) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = Math.min(1, speed / 2);
    this.motion.gain.setTargetAtTime(this.on ? v * 0.09 : 0, t, 0.15);
    this.motionBP.frequency.setTargetAtTime(220 + v * 700, t, 0.2);
  }

  /** progress 0..1 while a target is being filled; active=false fades it out. */
  setGaze(progress, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.gazeOsc.frequency.setTargetAtTime(392 * Math.pow(2, progress), t, 0.05);
    this.gazeGain.gain.setTargetAtTime(active && this.on ? 0.022 + 0.02 * progress : 0, t, active ? 0.05 : 0.12);
  }

  chime(kind) {
    if (!this.ctx || !this.on) return;
    const notes = {
      confirm: [[880, 0]],
      step: [[659.3, 0], [987.8, 0.09]],
      target: [[784, 0], [1174.7, 0.07], [1568, 0.14]],
      complete: [[523.3, 0], [659.3, 0.11], [784, 0.22], [1046.5, 0.36]],
      enter: [[293.7, 0], [440, 0.15]],
    }[kind] || [[660, 0]];
    const soft = kind === 'enter';
    for (const [f, dt] of notes) this._bell(f, dt, soft ? 0.05 : 0.07, soft ? 0.5 : 0.006, soft ? 2.6 : 1.6);
  }

  _bell(freq, delay, peak, attack, decay) {
    const ctx = this.ctx;
    const t0 = ctx.currentTime + delay;
    for (const [mul, amp] of [[1, 1], [2.01, 0.28], [3.0, 0.1]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak * amp, t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay / mul);
      o.connect(g);
      g.connect(this.master);
      g.connect(this.verb);
      o.start(t0);
      o.stop(t0 + attack + decay + 0.1);
    }
  }
}
