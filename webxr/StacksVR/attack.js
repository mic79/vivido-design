// attack.js — damage buffer, delay, cap, garbage for StacksVR (Battleblocks-inspired)
(function (global) {
  'use strict';

  function AttackSystem(opts) {
    opts = opts || {};
    this.damageCap = opts.damageCap != null ? opts.damageCap : 4;
    this.damageDelayMs = opts.damageDelayMs != null ? opts.damageDelayMs : 1500;
    this.garbageHoles = opts.garbageHoles != null ? opts.garbageHoles : 1;
    // single layer does not remove/cancel damage
    this.singleClearsDamage = false;

    // per-side buffers: { pending: number, timers: [...] }
    this.buffers = {
      blue: { pending: 0, queue: [] },
      red: { pending: 0, queue: [] }
    };
  }

  AttackSystem.prototype.reset = function () {
    this.buffers.blue = { pending: 0, queue: [] };
    this.buffers.red = { pending: 0, queue: [] };
  };

  AttackSystem.prototype.getPending = function (side) {
    return this.buffers[side] ? this.buffers[side].pending : 0;
  };

  /**
   * Apply a clear's attack from attacker toward defender.
   * Healing: clearing can cancel buffered incoming damage first, then send leftover.
   * Example: 3 layers (2 dmg) with 1 buffered → cancel 1, send 1.
   * Single layer: no cancel (unless configured).
   */
  AttackSystem.prototype.onClear = function (attackerSide, clearResult, now) {
    now = now || performance.now();
    var defender = attackerSide === 'blue' ? 'red' : 'blue';
    var dmg = clearResult.damage || 0;
    var layers = clearResult.layersCleared || 0;

    var buf = this.buffers[attackerSide];
    var cancelled = 0;

    if (layers >= 2 || this.singleClearsDamage) {
      cancelled = Math.min(buf.pending, dmg);
      buf.pending -= cancelled;
      // Drop matching queued packets
      var left = cancelled;
      while (left > 0 && buf.queue.length) {
        var q = buf.queue[0];
        var take = Math.min(q.amount, left);
        q.amount -= take;
        left -= take;
        if (q.amount <= 0) buf.queue.shift();
      }
      dmg -= cancelled;
    }

    var sent = 0;
    if (dmg > 0) {
      var def = this.buffers[defender];
      var room = Math.max(0, this.damageCap - def.pending);
      sent = Math.min(dmg, room);
      if (sent > 0) {
        def.pending += sent;
        def.queue.push({ amount: sent, readyAt: now + this.damageDelayMs, from: attackerSide });
      }
    }

    return { cancelled: cancelled, sent: sent, pendingSelf: buf.pending, pendingOpp: this.buffers[defender].pending };
  };

  /**
   * Flush ready garbage onto cups. cups = { blue: Cup, red: Cup }
   * Returns list of { side, layers }.
   */
  AttackSystem.prototype.tick = function (cups, now) {
    now = now || performance.now();
    var applied = [];
    var sides = ['blue', 'red'];
    for (var s = 0; s < sides.length; s++) {
      var side = sides[s];
      var buf = this.buffers[side];
      var cup = cups[side];
      if (!cup || !buf.queue.length) continue;

      var total = 0;
      while (buf.queue.length && buf.queue[0].readyAt <= now) {
        var pkt = buf.queue.shift();
        total += pkt.amount;
        buf.pending = Math.max(0, buf.pending - pkt.amount);
      }
      if (total > 0) {
        // Cap applied garbage this flush to remaining damageCap semantics (already capped on send)
        cup.spawnGarbageLayers(total, this.garbageHoles);
        applied.push({ side: side, layers: total });
      }
    }
    return applied;
  };

  AttackSystem.prototype.serialize = function () {
    return {
      blue: { pending: this.buffers.blue.pending, queue: this.buffers.blue.queue.slice() },
      red: { pending: this.buffers.red.pending, queue: this.buffers.red.queue.slice() }
    };
  };

  AttackSystem.prototype.applySerialized = function (data) {
    if (!data) return;
    this.buffers.blue = {
      pending: data.blue ? data.blue.pending : 0,
      queue: (data.blue && data.blue.queue) ? data.blue.queue.slice() : []
    };
    this.buffers.red = {
      pending: data.red ? data.red.pending : 0,
      queue: (data.red && data.red.queue) ? data.red.queue.slice() : []
    };
  };

  global.StacksAttack = AttackSystem;
})(window);
