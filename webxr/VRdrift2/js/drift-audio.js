/**
 * Spatialized skate/roll SFX — CapVR pattern: sounds already on hands in HTML.
 * Drive play + volume/rate each frame (never recreate; never leave volume stuck at 0).
 */
(function () {
  'use strict';

  const C = () => window.VRDRIFT || {};

  function resumeAudio() {
    try {
      const ctx =
        (window.AFRAME &&
          AFRAME.scenes[0] &&
          AFRAME.scenes[0].audioListener &&
          AFRAME.scenes[0].audioListener.context) ||
        null;
      if (ctx && ctx.state === 'suspended') ctx.resume();
    } catch (e) {
      /* ignore */
    }
  }

  /**
   * Set loop playing state + audible volume/rate.
   * Writes both component data AND live THREE sources (playSound reads data.volume).
   */
  function driveLoop(el, on, rate, volume) {
    if (!el || !el.components || !el.components.sound) return;
    const sc = el.components.sound;
    try {
      sc.data.volume = on ? volume : 0;
      sc.data.playbackRate = rate;
      if (sc.pool && sc.pool.children) {
        for (let i = 0; i < sc.pool.children.length; i++) {
          const src = sc.pool.children[i];
          if (!src) continue;
          if (typeof src.setPlaybackRate === 'function') src.setPlaybackRate(rate);
          else if (src.playbackRate !== undefined) src.playbackRate = rate;
          if (typeof src.setVolume === 'function') src.setVolume(on ? volume : 0);
          else if (src.gain && src.gain.gain) src.gain.gain.value = on ? volume : 0;
        }
      }
      if (on) {
        resumeAudio();
        if (!sc.isPlaying) sc.playSound();
      } else if (sc.isPlaying) {
        sc.stopSound();
      }
    } catch (e) {
      /* ignore */
    }
  }

  function speedNorm(spd, minSpd, maxSpd) {
    if (spd < minSpd) return 0;
    return Math.min(1, (spd - minSpd) / Math.max(0.01, maxSpd - minSpd));
  }

  const api = {
    _bodyEl: null,
    _palmEl: { left: null, right: null },
    _bounceEl: null,
    _lastBounce: 0,
    _prevBallVel: null,
    _bound: false,

    bind: function () {
      if (this._bound) return;
      this._bodyEl = document.getElementById('drift-body-roll-sound');
      this._palmEl.left = document.querySelector('#leftHand .palm-roll-sound');
      this._palmEl.right = document.querySelector('#rightHand .palm-roll-sound');
      this._bound = !!(this._palmEl.left || this._palmEl.right || this._bodyEl);
    },

    onEnterVr: function () {
      resumeAudio();
      this.bind();
    },

    updateThrusters: function (leftOn, rightOn) {
      try {
        const left = document.querySelector('#leftHand .thruster-sound');
        const right = document.querySelector('#rightHand .thruster-sound');
        if (left && left.components && left.components.sound) {
          if (leftOn) {
            resumeAudio();
            if (!left.components.sound.isPlaying) left.components.sound.playSound();
          } else if (left.components.sound.isPlaying) {
            left.components.sound.stopSound();
          }
        }
        if (right && right.components && right.components.sound) {
          if (rightOn) {
            resumeAudio();
            if (!right.components.sound.isPlaying) right.components.sound.playSound();
          } else if (right.components.sound.isPlaying) {
            right.components.sound.stopSound();
          }
        }
      } catch (e) {
        /* ignore */
      }
    },

    updateMotionLoops: function (loco) {
      try {
        this.bind();
        if (!loco || !loco.phys || !loco._spawned) return;

        const pos = loco.phys.getPlayerPosition();
        const v = loco.phys.getPlayerVelocity();
        const horiz = Math.hypot(v.x || 0, v.z || 0);
        const bodySpd = Math.hypot(v.x || 0, v.y || 0, v.z || 0);
        const br = C().BODY_BALL_RADIUS != null ? C().BODY_BALL_RADIUS : 0.24;
        const minSpd = C().SFX_SKATE_MIN_SPEED != null ? C().SFX_SKATE_MIN_SPEED : 0.25;
        const maxSpd = C().SFX_SKATE_MAX_SPEED != null ? C().SFX_SKATE_MAX_SPEED : 8;

        // Body ball roll — follow physics ball in world space
        if (this._bodyEl && this._bodyEl.object3D) {
          this._bodyEl.object3D.position.set(pos.x, pos.y, pos.z);
          const floorY = loco.phys.sampleFloorY
            ? loco.phys.sampleFloorY(pos.x, pos.y + 2, pos.z)
            : null;
          const onFloor = floorY != null && pos.y - br <= floorY + 0.12;
          const bodyOn = onFloor && horiz >= minSpd;
          const t = speedNorm(horiz, minSpd, maxSpd);
          driveLoop(this._bodyEl, bodyOn, 0.85 + 0.55 * t, bodyOn ? 0.075 + 0.125 * t : 0);
        }

        // Palm rolls — entities live on the hands (spatialized with controllers)
        const pb = window.VRDriftPalmBall;
        ['left', 'right'].forEach((key) => {
          const el = this._palmEl[key];
          if (!el) return;

          const onSurf =
            pb && (pb.hadFloorContact(key) || pb.hadWallContact(key) || pb.hadSurfaceContact(key));
          const hv = loco.handVel && loco.handVel[key];
          const handSpd = hv && typeof hv.length === 'function' ? hv.length() : 0;
          // Any plant while skating / moving body (incl. lift) → play
          const skating = !!loco._palmSkateActive;
          const spd = Math.max(handSpd, onSurf ? bodySpd : 0);
          const palmOn = !!onSurf && (skating || spd >= 0.08 || handSpd > 0.04);
          const t = speedNorm(Math.max(spd, skating && onSurf ? 0.5 : 0), 0.08, maxSpd);
          // Softer than body, higher pitch — but clearly audible
          driveLoop(el, palmOn, 1.45 + 0.65 * t, palmOn ? 0.12 + 0.22 * t : 0);
        });
      } catch (e) {
        /* never break locomotion */
      }
    },

    palmSurfaceHit: function () {},
    palmBallHit: function () {},
    bodyOrHeadImpact: function () {},

    ballThud: function (worldPos, intensity) {
      try {
        if (!this._bounceEl) {
          const ball = document.querySelector('#arena-game-ball');
          if (!ball) return;
          let el = document.getElementById('drift-bounce-sound');
          if (!el) {
            el = document.createElement('a-entity');
            el.id = 'drift-bounce-sound';
            ball.appendChild(el);
            el.setAttribute(
              'sound',
              'src: url(audio/impact-cinematic-boom-5-352465.mp3); autoplay: false; loop: false; volume: 0.55; positional: true; distanceModel: inverse; refDistance: 0.4; maxDistance: 30; rolloffFactor: 1.6; poolSize: 3'
            );
          }
          this._bounceEl = el;
        }
        const now = performance.now();
        if (now - this._lastBounce < 70) return;
        this._lastBounce = now;
        const i = Math.max(0.15, Math.min(1, intensity != null ? intensity : 0.5));
        const sc = this._bounceEl.components && this._bounceEl.components.sound;
        if (!sc) return;
        sc.data.volume = 0.28 + 0.4 * i;
        sc.data.playbackRate = 0.9 + i * 0.35;
        resumeAudio();
        sc.stopSound();
        sc.playSound();
      } catch (e) {
        /* ignore */
      }
    },

    updateBallSurface: function () {
      try {
        const phys = window.DriftPhys;
        if (!phys || !phys.gameBallBody) return;
        const gp = phys.getGameBallPosition();
        const bv = phys.getGameBallVelocity();
        if (!gp || !bv) return;
        if (!this._prevBallVel) this._prevBallVel = { x: 0, y: 0, z: 0 };
        const gr = C().GAME_BALL_RADIUS != null ? C().GAME_BALL_RADIUS : 0.25;
        const floorY = phys.sampleFloorY ? phys.sampleFloorY(gp.x, gp.y + 1, gp.z) : null;
        const nearFloor = floorY != null && gp.y - gr <= floorY + 0.04;
        const speedDrop =
          Math.hypot(this._prevBallVel.x, this._prevBallVel.y, this._prevBallVel.z) -
          Math.hypot(bv.x, bv.y, bv.z);
        const hitFloor =
          nearFloor && this._prevBallVel.y < -0.8 && bv.y > this._prevBallVel.y * 0.2;
        const hitWall =
          speedDrop > 1.2 &&
          Math.hypot(bv.x - this._prevBallVel.x, bv.z - this._prevBallVel.z) > 0.8;
        if (hitFloor || hitWall) {
          this.ballThud(
            gp,
            Math.min(1, Math.max(0.2, Math.abs(this._prevBallVel.y) * 0.15 + speedDrop * 0.12))
          );
        }
        this._prevBallVel.x = bv.x;
        this._prevBallVel.y = bv.y;
        this._prevBallVel.z = bv.z;
      } catch (e) {
        /* ignore */
      }
    }
  };

  window.VRDriftAudio = api;

  AFRAME.registerComponent('drift-audio', {
    init: function () {
      const bind = () => api.bind();
      this.el.sceneEl.addEventListener('loaded', bind);
      this.el.sceneEl.addEventListener('enter-vr', () => api.onEnterVr());
      if (this.el.sceneEl.hasLoaded) bind();
    }
  });
})();
