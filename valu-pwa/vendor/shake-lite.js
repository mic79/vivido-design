/**
 * Minimal replacement for the abandoned shake.js 1.2.2 (same public API, same detection rules).
 *
 *   var s = new Shake({ threshold: 15, timeout: 1000 });
 *   s.start();                          // listens to devicemotion
 *   window.addEventListener('shake', fn);
 *   s.stop();
 *
 * A "shake" is fired when at least two axes of accelerationIncludingGravity change by more than
 * `threshold` between two devicemotion samples, at most once per `timeout` ms.
 */
(function (window) {
  'use strict';

  function Shake(options) {
    this.hasDeviceMotion = 'ondevicemotion' in window;
    this.options = { threshold: 15, timeout: 1000 };
    if (options && typeof options === 'object') {
      if (typeof options.threshold === 'number') this.options.threshold = options.threshold;
      if (typeof options.timeout === 'number') this.options.timeout = options.timeout;
    }
    this.lastTime = new Date();
    this.lastX = null;
    this.lastY = null;
    this.lastZ = null;
    this.event = new CustomEvent('shake', { bubbles: true, cancelable: true });
  }

  Shake.prototype.reset = function () {
    this.lastTime = new Date();
    this.lastX = null;
    this.lastY = null;
    this.lastZ = null;
  };

  Shake.prototype.start = function () {
    this.reset();
    if (this.hasDeviceMotion) window.addEventListener('devicemotion', this, false);
  };

  Shake.prototype.stop = function () {
    if (this.hasDeviceMotion) window.removeEventListener('devicemotion', this, false);
    this.reset();
  };

  Shake.prototype.devicemotion = function (e) {
    var current = e.accelerationIncludingGravity;
    if (!current) return;

    if (this.lastX === null && this.lastY === null && this.lastZ === null) {
      this.lastX = current.x;
      this.lastY = current.y;
      this.lastZ = current.z;
      return;
    }

    var dx = Math.abs(this.lastX - current.x);
    var dy = Math.abs(this.lastY - current.y);
    var dz = Math.abs(this.lastZ - current.z);
    var t = this.options.threshold;

    if ((dx > t && dy > t) || (dx > t && dz > t) || (dy > t && dz > t)) {
      var now = new Date();
      if (now.getTime() - this.lastTime.getTime() > this.options.timeout) {
        window.dispatchEvent(this.event);
        this.lastTime = now;
      }
    }

    this.lastX = current.x;
    this.lastY = current.y;
    this.lastZ = current.z;
  };

  Shake.prototype.handleEvent = function (e) {
    if (typeof this[e.type] === 'function') return this[e.type](e);
  };

  window.Shake = Shake;
})(window);
