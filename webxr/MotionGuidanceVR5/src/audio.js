/**
 * Guided audio — languageVR pattern:
 * - pre-recorded VO clips per chamber / cue
 * - soft looping BGM (same calm track as languageVR), ducked under VO
 */

const BGM_URL = 'assets/audio/calm-bgm.mp3';
const VOICE_BASE = 'assets/audio/voice/';
// Bust browser/CDN cache when clips are replaced (same filename, new content).
const VOICE_VER = '20261110b';

const BGM_VOL = 0.14;
const BGM_DUCK = 0.045;
const VOICE_VOL = 0.92;

export class GuideAudio {
  constructor() {
    this.bgm = null;
    this.voice = null;
    this.musicOn = true;
    this.voiceOn = true;
    this._unlocked = false;
    this._voiceEndCbs = [];
    this._cache = new Map();
  }

  /** Call from a user gesture (Enter chamber). */
  unlock() {
    if (this._unlocked) return;
    this._unlocked = true;
    try {
      this.bgm = new Audio(BGM_URL);
      this.bgm.loop = true;
      this.bgm.volume = BGM_VOL;
      this.bgm.preload = 'auto';
    } catch (e) {
      console.warn('[MGVR5 audio] BGM init failed', e);
    }
  }

  setMusic(on) {
    this.musicOn = !!on;
    if (!this.bgm) return;
    if (this.musicOn) {
      this.bgm.volume = this.voice && !this.voice.paused ? BGM_DUCK : BGM_VOL;
      this.bgm.play().catch(() => {});
    } else {
      this.bgm.pause();
    }
  }

  setVoice(on) {
    this.voiceOn = !!on;
    if (!on) this.stopVoice();
  }

  startSessionMusic() {
    this.unlock();
    if (this.musicOn) this.setMusic(true);
  }

  stopSessionMusic() {
    if (this.bgm) {
      this.bgm.pause();
      try { this.bgm.currentTime = 0; } catch (e) { /* */ }
    }
  }

  _duck(on) {
    if (!this.bgm || !this.musicOn) return;
    this.bgm.volume = on ? BGM_DUCK : BGM_VOL;
  }

  stopVoice() {
    if (this.voice) {
      try {
        this.voice.onended = null;
        this.voice.pause();
        this.voice.currentTime = 0;
      } catch (e) { /* */ }
      this.voice = null;
    }
    this._duck(false);
    const cbs = this._voiceEndCbs.splice(0);
    for (const cb of cbs) {
      try { cb({ skipped: true }); } catch (e) { /* */ }
    }
  }

  /**
   * @param {string} id clip id without path (e.g. C01_still, begin, complete)
   * @returns {Promise<{skipped?:boolean, missing?:boolean}>}
   */
  play(id) {
    this.unlock();
    this.stopVoice();
    if (!this.voiceOn || !id) {
      return Promise.resolve({ skipped: true });
    }
    const url = `${VOICE_BASE}${id}.mp3?v=${VOICE_VER}`;
    return new Promise((resolve) => {
      const a = new Audio(url);
      a.volume = VOICE_VOL;
      a.preload = 'auto';
      this.voice = a;
      this._duck(true);

      const finish = (info) => {
        if (this.voice === a) this.voice = null;
        this._duck(false);
        const i = this._voiceEndCbs.indexOf(finishWrapped);
        if (i >= 0) this._voiceEndCbs.splice(i, 1);
        resolve(info);
      };
      const finishWrapped = () => finish({ skipped: true });
      this._voiceEndCbs.push(finishWrapped);

      a.onended = () => finish({});
      a.onerror = () => {
        console.warn('[MGVR5 audio] missing/failed VO', url);
        finish({ missing: true });
      };
      a.play().catch((e) => {
        console.warn('[MGVR5 audio] VO play blocked', e);
        finish({ skipped: true });
      });
    });
  }

  /** True while a briefing/cue is speaking. */
  get speaking() {
    return !!(this.voice && !this.voice.paused);
  }

  /** Skip current VO (trigger during briefing). */
  skipVoice() {
    if (!this.speaking) return false;
    this.stopVoice();
    return true;
  }
}
