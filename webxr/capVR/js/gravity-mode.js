/**
 * Gravity / locomotion mode manager for body-rigged4.
 *
 * Modes:
 *   grounded — normal gravity walk / crouch / floor leg IK
 *   zerog    — free-float thrusters / boost / airbrake / floating legs
 *
 * Apps can lock to one mode (foundation for gravity-only or space-only titles)
 * or allowSwitch:true for dual-mode experiences.
 *
 * URL: ?mode=grounded | ?mode=zerog
 * API:  window.BodyRiggedGravity.setMode('zerog')
 * Event: scene emits 'gravity-mode-changed' { previous, mode }
 */
(function () {
  'use strict';

  const MODES = Object.freeze({
    GROUNDED: 'grounded',
    ZEROG: 'zerog'
  });

  function normalizeMode(value) {
    const m = String(value || '').toLowerCase().trim();
    if (m === 'zerog' || m === 'zero-g' || m === 'zero' || m === 'space' || m === 'float') {
      return MODES.ZEROG;
    }
    if (m === 'grounded' || m === 'gravity' || m === 'normal' || m === 'walk') {
      return MODES.GROUNDED;
    }
    return null;
  }

  function parseInitialMode() {
    try {
      const q = new URLSearchParams(window.location.search);
      const fromUrl = normalizeMode(q.get('mode') || q.get('gravity'));
      if (fromUrl) return fromUrl;
    } catch (e) { /* ignore */ }
    return MODES.GROUNDED;
  }

  class GravityModeController {
    constructor() {
      this.mode = parseInitialMode();
      this.allowSwitch = true;
      this._listeners = [];
      /** World gravity vector applied to Box3D (ragdolls / dynamic bodies). */
      this.gravityGrounded = { x: 0, y: -20, z: 0 };
      this.gravityZeroG = { x: 0, y: 0, z: 0 };
    }

    get MODES() { return MODES; }
    getMode() { return this.mode; }
    isZeroG() { return this.mode === MODES.ZEROG; }
    isGrounded() { return this.mode === MODES.GROUNDED; }

    onChange(fn) {
      if (typeof fn !== 'function') return () => {};
      this._listeners.push(fn);
      return () => {
        this._listeners = this._listeners.filter((f) => f !== fn);
      };
    }

    setMode(next, opts) {
      const mode = normalizeMode(next);
      if (!mode) return false;
      if (mode === this.mode) {
        this._applyPhysicsGravity();
        return true;
      }
      if (!this.allowSwitch && !(opts && opts.force)) return false;

      const previous = this.mode;
      this.mode = mode;
      this._applyPhysicsGravity();
      this._resetPlayerVelocityForMode(previous, mode);
      this._notify({ previous, mode });
      this._syncUrl(mode);
      const vrLoco = document.getElementById('rig')?.components?.['vr-locomotion'];
      if (vrLoco?._applyRigYawOnly) vrLoco._applyRigYawOnly();
      return true;
    }

    toggle(opts) {
      return this.setMode(this.isZeroG() ? MODES.GROUNDED : MODES.ZEROG, opts);
    }

    _notify(detail) {
      for (let i = 0; i < this._listeners.length; i++) {
        try { this._listeners[i](detail); } catch (e) { console.warn('[gravity-mode]', e); }
      }
      const scene = document.querySelector('a-scene');
      if (scene && scene.emit) scene.emit('gravity-mode-changed', detail, false);
    }

    _syncUrl(mode) {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('mode', mode);
        window.history.replaceState({}, '', url);
      } catch (e) { /* ignore */ }
    }

    _getPhysics() {
      return window.CapVRPhysics?.get?.() || null;
    }

    _applyPhysicsGravity() {
      const physics = this._getPhysics();
      if (!physics || typeof physics.setGravity !== 'function') return;
      const g = this.isZeroG() ? this.gravityZeroG : this.gravityGrounded;
      physics.setGravity(g.x, g.y, g.z);
    }

    _resetPlayerVelocityForMode(previous, mode) {
      const phys = this._getPhysics();
      const zc = document.getElementById('rig')?.components?.['zerog-locomotion'];

      if (mode === MODES.ZEROG) {
        if (phys) {
          phys.playerVelY = 0;
          phys.playerGrounded = false;
        }
        if (zc && zc.resetForEnterZeroG) zc.resetForEnterZeroG(null);
      } else if (previous === MODES.ZEROG) {
        if (zc && zc.resetForLeaveZeroG) zc.resetForLeaveZeroG(null);
        if (phys) {
          phys.playerVelY = -2;
          phys.playerGrounded = !!phys.playerGrounded;
        }
      }
    }
  }

  window.BodyRiggedGravity = new GravityModeController();
  // MODES is exposed via GravityModeController getter (do not reassign).

  if (typeof AFRAME !== 'undefined') {
    AFRAME.registerComponent('gravity-mode', {
      schema: {
        mode: { type: 'string', default: '' },
        allowSwitch: { type: 'boolean', default: true }
      },

      init: function () {
        const g = window.BodyRiggedGravity;
        g.allowSwitch = this.data.allowSwitch;
        if (this.data.mode) g.setMode(this.data.mode, { force: true });
        else g._applyPhysicsGravity();
        this.el.sceneEl.gravityMode = g;
        this._onKey = (evt) => {
          if (!g.allowSwitch) return;
          if (evt.repeat) return;
          const t = evt.target;
          if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
          if (evt.key === 'g' || evt.key === 'G') g.toggle();
        };
        // Quest left-hand X face button — same toggle as desktop G / UI buttons.
        // (Y is reserved for left thruster in zero-g.)
        this._onXToggle = () => {
          if (!g.allowSwitch) return;
          g.toggle();
        };
        window.addEventListener('keydown', this._onKey);
        this.el.sceneEl.addEventListener('xbuttondown', this._onXToggle);
      },

      update: function (oldData) {
        const g = window.BodyRiggedGravity;
        g.allowSwitch = this.data.allowSwitch;
        if (this.data.mode && this.data.mode !== oldData.mode) {
          g.setMode(this.data.mode, { force: true });
        }
      },

      remove: function () {
        if (this._onKey) window.removeEventListener('keydown', this._onKey);
        if (this._onXToggle && this.el.sceneEl) {
          this.el.sceneEl.removeEventListener('xbuttondown', this._onXToggle);
        }
      }
    });
  }
})();
