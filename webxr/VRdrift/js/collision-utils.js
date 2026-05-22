/* Sphere vs oriented A-Frame primitives (boxes/cylinders respect rotation). */
(function () {
  const _center = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _inv = new THREE.Quaternion();
  const _scale = new THREE.Vector3();
  const _local = new THREE.Vector3();
  const _closest = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _normal = new THREE.Vector3();
  const _topLocal = new THREE.Vector3();
  const _topWorld = new THREE.Vector3();

  function surfaceFrame(el) {
    el.object3D.updateMatrixWorld(true);
    el.object3D.matrixWorld.decompose(_center, _quat, _scale);
    _inv.copy(_quat).invert();
    return { center: _center, quat: _quat, inv: _inv, scale: _scale };
  }

  function toLocal(point, frame) {
    return _local.copy(point).sub(frame.center).applyQuaternion(frame.inv);
  }

  function normalToWorld(localNormal, frame) {
    return _normal.copy(localNormal).applyQuaternion(frame.quat).normalize();
  }

  function boxHalfExtents(geo, frame) {
    const sc = frame.scale;
    const sx = sc && Math.abs(sc.x) > 1e-6 ? Math.abs(sc.x) : 1;
    const sy = sc && Math.abs(sc.y) > 1e-6 ? Math.abs(sc.y) : 1;
    const sz = sc && Math.abs(sc.z) > 1e-6 ? Math.abs(sc.z) : 1;
    const w = Number(geo.width) || 1;
    const h = Number(geo.height) || 1;
    const d = Number(geo.depth) || 1;
    return { x: (w / 2) * sx, y: (h / 2) * sy, z: (d / 2) * sz };
  }

  function closestOnBox(localPoint, hw, hh, hd) {
    _closest.set(
      Math.max(-hw, Math.min(hw, localPoint.x)),
      Math.max(-hh, Math.min(hh, localPoint.y)),
      Math.max(-hd, Math.min(hd, localPoint.z))
    );
    return _closest;
  }

  function boxContact(localPoint, radius, geo, frame) {
    const h = boxHalfExtents(geo, frame);
    const closest = closestOnBox(localPoint, h.x, h.y, h.z);
    const dist = localPoint.distanceTo(closest);
    const pen = radius - dist;
    if (pen <= 0) {
      return { distance: dist - radius, push: null, normal: null };
    }
    _dir.copy(localPoint).sub(closest);
    if (_dir.lengthSq() < 1e-10) {
      const ax = Math.abs(localPoint.x) - h.x;
      const ay = Math.abs(localPoint.y) - h.y;
      const az = Math.abs(localPoint.z) - h.z;
      if (ax >= ay && ax >= az) _dir.set(Math.sign(localPoint.x) || 1, 0, 0);
      else if (ay >= az) _dir.set(0, Math.sign(localPoint.y) || 1, 0);
      else _dir.set(0, 0, Math.sign(localPoint.z) || 1);
    }
    _dir.normalize();
    return {
      distance: dist - radius,
      push: normalToWorld(_dir.clone().multiplyScalar(pen), frame),
      normal: normalToWorld(_dir, frame)
    };
  }

  function cylinderContact(localPoint, radius, geo, frame) {
    const sy = Math.abs(frame.scale.y) || 1;
    const sxz = Math.max(Math.abs(frame.scale.x), Math.abs(frame.scale.z)) || 1;
    const cr = (geo.radius || 0.5) * sxz;
    const ch = (geo.height || 2) * sy;
    const radial = Math.sqrt(localPoint.x * localPoint.x + localPoint.z * localPoint.z);
    let d;
    if (Math.abs(localPoint.y) <= ch / 2) d = Math.max(0, radial - cr);
    else {
      const endD = Math.abs(localPoint.y) - ch / 2;
      d = radial <= cr ? endD : Math.sqrt(endD * endD + (radial - cr) * (radial - cr));
    }
    const pen = radius - d;
    if (pen <= 0) return { distance: d - radius, push: null, normal: null };
    if (Math.abs(localPoint.y) <= ch / 2) _dir.set(localPoint.x, 0, localPoint.z);
    else _dir.copy(localPoint);
    if (_dir.lengthSq() < 1e-10) _dir.set(0, 1, 0);
    _dir.normalize();
    return {
      distance: d - radius,
      push: normalToWorld(_dir.clone().multiplyScalar(pen), frame),
      normal: normalToWorld(_dir, frame)
    };
  }

  function sphereContact(localPoint, radius, geo, frame) {
    const s = Math.max(Math.abs(frame.scale.x), Math.abs(frame.scale.y), Math.abs(frame.scale.z)) || 1;
    const sr = (geo.radius || 0.5) * s;
    const dist = localPoint.length();
    const pen = radius + sr - dist;
    if (pen <= 0) return { distance: dist - radius - sr, push: null, normal: null };
    if (dist < 1e-8) _dir.set(0, 1, 0);
    else _dir.copy(localPoint).divideScalar(dist);
    return {
      distance: dist - radius - sr,
      push: normalToWorld(_dir.clone().multiplyScalar(pen), frame),
      normal: normalToWorld(_dir, frame)
    };
  }

  function isArenaGameBall(el) {
    return (
      el &&
      (el.id === 'arena-game-ball' ||
        (el.components && el.components['drift-game-ball']))
    );
  }

  /** World-space sphere for #arena-game-ball (mesh-only entity, no geometry attr). */
  function gameBallContact(point, probeRadius, el) {
    const C = window.VRDRIFT || {};
    const ballR = C.GAME_BALL_RADIUS != null ? C.GAME_BALL_RADIUS : 0.5;
    el.object3D.updateMatrixWorld(true);
    el.object3D.getWorldPosition(_center);
    el.object3D.getWorldScale(_scale);
    const s = Math.max(Math.abs(_scale.x), Math.abs(_scale.y), Math.abs(_scale.z)) || 1;
    const sr = ballR * s;
    _dir.copy(point).sub(_center);
    const dist = _dir.length();
    const surfaceDist = dist - probeRadius - sr;
    if (surfaceDist > 0) {
      return { distance: surfaceDist, push: null, normal: null };
    }
    if (dist < 1e-8) _dir.set(0, 1, 0);
    else _dir.divideScalar(dist);
    const pen = probeRadius + sr - dist;
    return {
      distance: surfaceDist,
      push: _dir.clone().multiplyScalar(pen),
      normal: _dir.clone()
    };
  }

  function contactAt(point, radius, el) {
    if (isArenaGameBall(el)) return gameBallContact(point, radius, el);
    const geo = el.getAttribute('geometry');
    if (!geo) return { distance: Infinity, push: null, normal: null };
    const frame = surfaceFrame(el);
    const lp = toLocal(point, frame);
    const prim = geo.primitive || 'box';
    if (prim === 'box') return boxContact(lp, radius, geo, frame);
    if (prim === 'cylinder') return cylinderContact(lp, radius, geo, frame);
    if (prim === 'sphere') return sphereContact(lp, radius, geo, frame);
    return { distance: Infinity, push: null, normal: null };
  }

  /** World Y of the walkable top of a box at (worldX, worldZ), or null if outside footprint. */
  function boxTopHeightAt(el, worldX, worldZ) {
    const geo = el.getAttribute('geometry');
    if (!geo || (geo.primitive || 'box') !== 'box') return null;
    const frame = surfaceFrame(el);
    _local.set(worldX, 0, worldZ).sub(frame.center).applyQuaternion(frame.inv);
    const h = boxHalfExtents(geo, frame);
    if (Math.abs(_local.x) > h.x + 0.05 || Math.abs(_local.z) > h.z + 0.05) return null;
    const lx = Math.max(-h.x, Math.min(h.x, _local.x));
    const lz = Math.max(-h.z, Math.min(h.z, _local.z));
    _topLocal.set(lx, h.y, lz);
    _topWorld.copy(_topLocal).applyQuaternion(frame.quat).add(frame.center);
    const up = normalToWorld(new THREE.Vector3(0, 1, 0), frame);
    if (up.y < 0.4) return null;
    return _topWorld.y;
  }

  /** World-space up normal of walkable top at (worldX, worldZ). */
  function boxTopNormalAt(el, worldX, worldZ) {
    const geo = el.getAttribute('geometry');
    if (!geo || (geo.primitive || 'box') !== 'box') return null;
    const frame = surfaceFrame(el);
    _local.set(worldX, 0, worldZ).sub(frame.center).applyQuaternion(frame.inv);
    const h = boxHalfExtents(geo, frame);
    if (Math.abs(_local.x) > h.x + 0.05 || Math.abs(_local.z) > h.z + 0.05) return null;
    const up = normalToWorld(new THREE.Vector3(0, 1, 0), frame);
    if (up.y < 0.4) return null;
    return up;
  }

  window.VRDriftCollision = {
    contactAt: contactAt,

    distanceToSurface: function (point, radius, el) {
      return contactAt(point, radius, el).distance;
    },

    /**
     * Highest walkable floor at (worldX, worldZ). Only [drift-floor] — never walls/ceiling.
     * Optional maxY ignores surfaces far above the player (e.g. ceilings).
     */
    getWalkableHeightAt: function (worldX, worldZ, selector, maxY) {
      let best = -Infinity;
      const surfaces = selector
        ? Array.from(document.querySelectorAll(selector))
        : [];
      surfaces.forEach((el) => {
        const y = boxTopHeightAt(el, worldX, worldZ);
        if (y == null) return;
        if (maxY != null && y > maxY) return;
        if (y > best) best = y;
      });
      return best > -Infinity ? best : null;
    },

    /**
     * Walkable height near the player — ignores deck far above (ramp slope projection teleports).
     */
    getSupportFloorHeightAt: function (worldX, worldZ, selector, refY, maxAbove) {
      const reach =
        maxAbove != null
          ? maxAbove
          : window.VRDRIFT && window.VRDRIFT.MAX_FLOOR_SUPPORT_REACH != null
            ? window.VRDRIFT.MAX_FLOOR_SUPPORT_REACH
            : 0.55;
      let best = -Infinity;
      const surfaces = selector
        ? Array.from(document.querySelectorAll(selector))
        : [];
      surfaces.forEach((el) => {
        const y = boxTopHeightAt(el, worldX, worldZ);
        if (y == null) return;
        if (refY != null && y > refY + reach) return;
        if (y > best) best = y;
      });
      return best > -Infinity ? best : null;
    },

    getFloorNormalAt: function (worldX, worldZ, selector, maxY) {
      let bestY = -Infinity;
      let bestNormal = null;
      const surfaces = selector
        ? Array.from(document.querySelectorAll(selector))
        : [];
      surfaces.forEach((el) => {
        const y = boxTopHeightAt(el, worldX, worldZ);
        if (y == null) return;
        if (maxY != null && y > maxY) return;
        if (y >= bestY) {
          bestY = y;
          bestNormal = boxTopNormalAt(el, worldX, worldZ);
        }
      });
      return bestNormal;
    },

    /** World-space closest point on the surface mesh to `point`. */
    closestPointOnSurface: function (point, el, out) {
      const o = out || new THREE.Vector3();
      const c = contactAt(point, 0, el);
      if (c.normal && isFinite(c.distance)) {
        return o.copy(point).sub(c.normal.clone().multiplyScalar(c.distance));
      }
      return o.copy(point);
    },

    getSurfaceNormal: function (point, el) {
      const c = contactAt(point, 0.075, el);
      if (c.normal) return c.normal.clone();
      const geo = el.getAttribute('geometry');
      if (!geo || (geo.primitive || 'box') !== 'box') return new THREE.Vector3(0, 1, 0);
      const frame = surfaceFrame(el);
      const lp = toLocal(point, frame);
      const h = boxHalfExtents(geo, frame);
      closestOnBox(lp, h.x, h.y, h.z);
      _dir.copy(lp).sub(_closest);
      if (_dir.lengthSq() < 1e-10) return new THREE.Vector3(0, 1, 0);
      return normalToWorld(_dir.normalize(), frame);
    },

    getCollisionPush: function (point, radius, el, margin) {
      const m = margin == null ? 0.02 : margin;
      const c = contactAt(point, radius + m, el);
      return c.push || new THREE.Vector3(0, 0, 0);
    },

    /**
     * Resolve sphere vs [drift-floor] — full correction (no per-frame cap).
     * Returns true if point was adjusted.
     */
    enforceSphereAboveFloors: function (point, radius, maxFix) {
      if (!point || radius == null) return false;
      const cap = maxFix != null ? maxFix : null;
      let changed = false;

      this.querySurfaces('[drift-floor]').forEach((el) => {
        if (isArenaGameBall(el)) return;
        const push = this.getCollisionPush(point, radius, el, 0.001);
        const len = push.length();
        if (len < 1e-8) return;
        if (cap != null && len > cap) push.multiplyScalar(cap / len);
        point.add(push);
        changed = true;
      });

      const floorY = this.getWalkableHeightAt(
        point.x,
        point.z,
        '[drift-floor]',
        point.y + radius + 2
      );
      if (floorY != null) {
        const minY = floorY + radius;
        if (point.y < minY - 1e-5) {
          if (cap != null) point.y += Math.min(minY - point.y, cap);
          else point.y = minY;
          changed = true;
        }
      }
      return changed;
    },

    /** Push sphere center out of non-floor [drift-surface] walls (mirrors floor enforce). */
    enforceSphereOutsideWalls: function (point, radius, maxFix) {
      if (!point || radius == null) return false;
      const cap = maxFix != null ? maxFix : null;
      let changed = false;

      this.querySurfaces('[drift-surface]').forEach((el) => {
        if (el.hasAttribute('drift-floor')) return;
        if (isArenaGameBall(el)) return;
        const push = this.getCollisionPush(point, radius, el, 0.001);
        const len = push.length();
        if (len < 1e-8) return;
        if (cap != null && len > cap) push.multiplyScalar(cap / len);
        point.add(push);
        changed = true;
      });

      return changed;
    },

    /** Deepest wall penetration at point (for palm wall contact). */
    getBestWallContact: function (point, radius) {
      let bestEl = null;
      let bestPush = null;
      let bestLen = 0;
      this.querySurfaces('[drift-surface]').forEach((el) => {
        if (el.hasAttribute('drift-floor')) return;
        if (isArenaGameBall(el)) return;
        const push = this.getCollisionPush(point, radius, el, 0.001);
        const len = push.length();
        if (len > bestLen) {
          bestLen = len;
          bestPush = push;
          bestEl = el;
        }
      });
      if (!bestPush || bestLen < 1e-8) return null;
      return {
        el: bestEl,
        push: bestPush,
        normal: bestPush.clone().multiplyScalar(1 / bestLen),
        depth: bestLen
      };
    },

    querySurfaces: function (selector) {
      return Array.from(document.querySelectorAll(selector));
    }
  };
})();
