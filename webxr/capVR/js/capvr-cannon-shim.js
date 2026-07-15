/**
 * Cannon.js → Box3D shim for CapVR.
 * Provides enough of the CANNON API that BoltVR grab-surface / zerog-ball / bot / goal
 * keep running, while all simulation is Box3D.
 *
 * Load AFTER box3d stack + capvr-box3d-ext, BEFORE the main game script that does `new CANNON.World()`.
 * Or load as a replacement for the Cannon CDN script tag.
 */
(function () {
  'use strict';

  function waitPhysics(cb) {
    const tryIt = () => {
      const p = window.CapVRPhysics?.get?.();
      if (p?.b3 && p.world) return cb(p);
      setTimeout(tryIt, 30);
    };
    tryIt();
  }

  class Vec3 {
    constructor(x, y, z) {
      this.x = x || 0; this.y = y || 0; this.z = z || 0;
    }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone() { return new Vec3(this.x, this.y, this.z); }
    length() { return Math.hypot(this.x, this.y, this.z); }
    lengthSquared() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    distanceTo(v) {
      const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
      return Math.hypot(dx, dy, dz);
    }
    distanceSquared(v) {
      const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
      return dx * dx + dy * dy + dz * dz;
    }
    normalize() {
      const l = this.length() || 1;
      this.x /= l; this.y /= l; this.z /= l;
      return this;
    }
    scale(s, target) {
      const t = target || this;
      t.x = this.x * s; t.y = this.y * s; t.z = this.z * s;
      return t;
    }
    vadd(v, target) {
      const t = target || new Vec3();
      t.x = this.x + v.x; t.y = this.y + v.y; t.z = this.z + v.z;
      return t;
    }
    vsub(v, target) {
      const t = target || new Vec3();
      t.x = this.x - v.x; t.y = this.y - v.y; t.z = this.z - v.z;
      return t;
    }
    almostEquals(v, precision) {
      const p = precision != null ? precision : 1e-6;
      return Math.abs(this.x - v.x) < p && Math.abs(this.y - v.y) < p && Math.abs(this.z - v.z) < p;
    }
  }

  class Quaternion {
    constructor(x, y, z, w) {
      this.x = x || 0; this.y = y || 0; this.z = z || 0; this.w = w != null ? w : 1;
    }
    set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
    copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    setFromEuler(x, y, z, order) {
      // Simplified YXZ
      const c1 = Math.cos(x / 2), s1 = Math.sin(x / 2);
      const c2 = Math.cos(y / 2), s2 = Math.sin(y / 2);
      const c3 = Math.cos(z / 2), s3 = Math.sin(z / 2);
      this.x = s1 * c2 * c3 - c1 * s2 * s3;
      this.y = c1 * s2 * c3 + s1 * c2 * s3;
      this.z = c1 * c2 * s3 + s1 * s2 * c3;
      this.w = c1 * c2 * c3 - s1 * s2 * s3;
      return this;
    }
  }

  class Sphere { constructor(radius) { this.radius = radius; this.type = 'sphere'; } }
  class Box {
    constructor(halfExtents) {
      this.halfExtents = halfExtents || new Vec3(0.5, 0.5, 0.5);
      this.type = 'box';
    }
  }
  class Cylinder {
    constructor(radiusTop, radiusBottom, height, numSegments) {
      this.radiusTop = radiusTop;
      this.radiusBottom = radiusBottom;
      this.height = height;
      this.numSegments = numSegments || 8;
      this.type = 'cylinder';
    }
  }
  class ConvexPolyhedron {
    constructor(vertices, faces) {
      this.vertices = vertices;
      this.faces = faces;
      this.type = 'convex';
    }
  }

  class Material { constructor(name) { this.name = name; } }
  class ContactMaterial {
    constructor(m1, m2, opts) {
      this.materials = [m1, m2];
      this.friction = opts?.friction ?? 0.3;
      this.restitution = opts?.restitution ?? 0.3;
    }
  }

  class Body {
    constructor(options) {
      options = options || {};
      this.mass = options.mass != null ? options.mass : 0;
      this.type = this.mass === 0 ? 0 : 1; // static / dynamic
      this.position = new Vec3();
      if (options.position) this.position.copy(options.position);
      this.velocity = new Vec3();
      this.angularVelocity = new Vec3();
      this.quaternion = new Quaternion();
      this.shapes = [];
      this.shape = null;
      this.el = null;
      this._b3Body = null;
      this._pending = true;
      this.collisionFilterGroup = options.collisionFilterGroup != null ? options.collisionFilterGroup : 1;
      this.collisionFilterMask = options.collisionFilterMask != null ? options.collisionFilterMask : -1;
      this.collisionResponse = true;
      this.linearDamping = 0.01;
      this.angularDamping = 0.01;
      this.allowSleep = true;
      this.sleepState = 0;
      this._listeners = {};
      this.ccdSpeedThreshold = -1;
      this.ccdIterations = 0;
      // BoltVR balls call body.gravity.set(...) — World has gravity; Body needs a no-op stub.
      this.gravity = new Vec3(0, 0, 0);
      if (options.shape) this.addShape(options.shape);
    }

    addShape(shape) {
      this.shapes.push(shape);
      this.shape = shape;
      return this;
    }

    addEventListener(type, fn) {
      this._listeners[type] = this._listeners[type] || [];
      this._listeners[type].push(fn);
    }

    removeEventListener(type, fn) {
      const arr = this._listeners[type];
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }

    _emit(type, evt) {
      (this._listeners[type] || []).forEach((fn) => {
        try { fn(evt); } catch (e) { console.warn(e); }
      });
    }

    /** Create / refresh underlying Box3D body once physics is ready. */
    _ensureB3(phys) {
      if (this._b3Body || !phys?.b3) return;
      const shape = this.shape || this.shapes[0];
      if (!shape) return;
      const p = this.position;
      const quat = {
        x: this.quaternion.x, y: this.quaternion.y, z: this.quaternion.z, w: this.quaternion.w
      };

      if (this.mass === 0) {
        if (shape.type === 'sphere') {
          this._b3Body = phys.addArenaStaticSphere(p.x, p.y, p.z, shape.radius, { quat, el: this.el });
        } else if (shape.type === 'cylinder') {
          const r = shape.radiusTop || shape.radiusBottom || 0.5;
          const h = shape.height || 1;
          const def = phys.b3.b3DefaultBodyDef();
          def.position = { x: p.x, y: p.y, z: p.z };
          def.rotation = { v: { x: quat.x, y: quat.y, z: quat.z }, s: quat.w };
          this._b3Body = phys.b3.b3CreateBody(phys.world, def);
          phys.b3.b3CreateCapsuleShape(this._b3Body, phys._shapeDef(), {
            center1: { x: 0, y: -h * 0.5, z: 0 },
            center2: { x: 0, y: h * 0.5, z: 0 },
            radius: r
          });
          phys.arenaBodies = phys.arenaBodies || [];
          phys.arenaBodies.push(this._b3Body);
        } else if (shape.type === 'box') {
          const he = shape.halfExtents;
          this._b3Body = phys.addArenaStaticBox(p.x, p.y, p.z, he.x, he.y, he.z, quat, { el: this.el });
        } else if (shape.type === 'convex' && shape.vertices?.length) {
          // CapVR mistake was baking every octa/tetra as a triangle mesh soup.
          // BoltVR uses a simple convex; Box3D AABB box around verts matches gameplay
          // and is what the shim already fell back to — use it first.
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          shape.vertices.forEach((v) => {
            minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
            minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
            minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
          });
          this._b3Body = phys.addArenaStaticBox(
            p.x, p.y, p.z,
            Math.max(0.05, (maxX - minX) * 0.5),
            Math.max(0.05, (maxY - minY) * 0.5),
            Math.max(0.05, (maxZ - minZ) * 0.5),
            quat,
            { el: this.el }
          );
        } else if (this.el && typeof phys.addArenaStaticFromEl === 'function') {
          // Torus / unknown — bake visual mesh
          this._b3Body = phys.addArenaStaticFromEl(this.el, { el: this.el });
        }

        if (!this._b3Body && shape.vertices?.length) {
          let minX = Infinity, minY = Infinity, minZ = Infinity;
          let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
          shape.vertices.forEach((v) => {
            minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
            minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
            minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
          });
          this._b3Body = phys.addArenaStaticBox(
            p.x, p.y, p.z,
            Math.max(0.05, (maxX - minX) * 0.5),
            Math.max(0.05, (maxY - minY) * 0.5),
            Math.max(0.05, (maxZ - minZ) * 0.5),
            quat,
            { el: this.el }
          );
        }
        if (!this._b3Body) {
          this._b3Body = phys.addArenaStaticBox(p.x, p.y, p.z, 0.5, 0.5, 0.5, quat, { el: this.el });
        }
      } else {
        const r = shape.type === 'sphere' ? shape.radius : 0.2;
        this._b3Body = phys.createDynamicSphere(p.x, p.y, p.z, r, this.mass, { el: this.el });
      }

      if (this._b3Body && this.el) {
        const meta = phys._bodyMeta?.get(this._b3Body);
        if (meta) meta.el = this.el;
      }
      this._pending = false;
      this._syncFromB3(phys);
    }

    _syncFromB3(phys) {
      if (!this._b3Body || !phys) return;
      // Statics never move in CapVR — reading them every frame was pure waste
      // (Arena One = hundreds of grab-surface bodies × getBodyPosition/frame).
      // BoltVR/Cannon does not do this; CapVR shim invented it.
      if (this.mass <= 0) return;
      const pos = phys.getBodyPosition(this._b3Body);
      this.position.set(pos.x, pos.y, pos.z);
      const vel = phys.getBodyVelocity(this._b3Body);
      this.velocity.set(vel.x, vel.y, vel.z);
      const q = phys.getBodyQuaternion(this._b3Body);
      this.quaternion.set(q.x, q.y, q.z, q.w);
    }

    _syncToB3(phys) {
      if (!this._b3Body || !phys) return;
      if (this._capvrFrozen) return;
      phys.setBodyPosition(this._b3Body, this.position.x, this.position.y, this.position.z);
      if (this.mass > 0) {
        phys.setBodyVelocity(this._b3Body, this.velocity.x, this.velocity.y, this.velocity.z);
      }
    }

    wakeUp() {
      const phys = window.CapVRPhysics?.get?.();
      if (phys?.b3?.b3Body_SetAwake && this._b3Body) phys.b3.b3Body_SetAwake(this._b3Body, true);
    }

    sleep() {
      const phys = window.CapVRPhysics?.get?.();
      if (phys?.b3?.b3Body_SetAwake && this._b3Body) phys.b3.b3Body_SetAwake(this._b3Body, false);
      this.velocity.set(0, 0, 0);
      this.angularVelocity.set(0, 0, 0);
    }
  }

  class World {
    constructor() {
      this.bodies = [];
      this.gravity = new Vec3(0, 0, 0);
      this.gravity.set = (x, y, z) => {
        this.gravity.x = x; this.gravity.y = y; this.gravity.z = z;
        const phys = window.CapVRPhysics?.get?.();
        phys?.setGravity?.(x, y, z);
      };
      this.broadphase = { dirty: false };
      this.solver = { iterations: 10 };
      this._contacts = [];
      window.CapVRCannonWorld = this;
      console.log('[CapVR] Box3D-backed CANNON.World created (shim)');
    }

    addContactMaterial() { /* materials handled in Box3D shape defs */ }

    addBody(body) {
      if (!body || this.bodies.indexOf(body) >= 0) return;
      this.bodies.push(body);
      waitPhysics((phys) => {
        body._ensureB3(phys);
        // Link el.body
        if (body.el) body.el.body = body;
      });
    }

    removeBody(body) {
      const i = this.bodies.indexOf(body);
      if (i >= 0) this.bodies.splice(i, 1);
      const phys = window.CapVRPhysics?.get?.();
      if (phys && body?._b3Body) {
        phys.destroyBody(body._b3Body);
        body._b3Body = null;
      }
    }

    /** Sync JS → Box3D (push only). Pull + contacts happen after step in [capvr-physics]. */
    syncBodiesToB3(phys) {
      if (!phys?.world) return;
      this.bodies.forEach((b) => {
        if (!b._b3Body) b._ensureB3(phys);
        if (b.mass > 0 && b._b3Body) b._syncToB3(phys);
      });
    }

    syncBodiesFromB3(phys) {
      if (!phys?.world) return;
      this.bodies.forEach((b) => {
        if (b.mass > 0 && b._b3Body) b._syncFromB3(phys);
      });
    }

    /** @deprecated use syncBodiesToB3 / syncBodiesFromB3 — kept for old callers */
    syncBodies(phys) {
      this.syncBodiesToB3(phys);
      this.syncBodiesFromB3(phys);
      this._emitProximityCollides();
    }

    step(/* dt */) {
      // True no-op. BoltVR's physics-world still calls world.step() up to 8×/frame;
      // CapVR must NOT sync/emit here (that was waking every body + spam collide mid-frame).
      // [capvr-physics] owns the single Box3D step.
    }

    _pairKey(a, b) {
      const ia = this.bodies.indexOf(a);
      const ib = this.bodies.indexOf(b);
      return ia < ib ? ia + ':' + ib : ib + ':' + ia;
    }

    _emitProximityCollides() {
      // Mimic Cannon beginContact: fire collide once when a pair enters proximity,
      // not every frame while overlapping (old CapVR shim bug).
      if (!this._activePairs) this._activePairs = new Set();
      const next = new Set();
      const balls = this.bodies.filter((b) => b.mass > 0 && b.shape?.type === 'sphere' && b.el);
      for (const ball of balls) {
        const br = ball.shape.radius || 0.1;
        for (const other of this.bodies) {
          if (other === ball || !other.el) continue;
          let hit = false;
          if (other.mass === 0 && other.shape?.type === 'cylinder') {
            const dx = ball.position.x - other.position.x;
            const dz = ball.position.z - other.position.z;
            const dy = Math.abs(ball.position.y - other.position.y);
            const r = other.shape.radiusTop || 0.8;
            hit = Math.hypot(dx, dz) < r + br && dy < 1.5;
          } else if (other.mass > 0) {
            const or = other.shape?.radius || 0.2;
            const d = Math.hypot(
              ball.position.x - other.position.x,
              ball.position.y - other.position.y,
              ball.position.z - other.position.z
            );
            hit = d < br + or + 0.05;
          }
          if (!hit) continue;
          const key = this._pairKey(ball, other);
          next.add(key);
          if (this._activePairs.has(key)) continue; // still overlapping — skip
          ball._emit('collide', { body: other, target: ball, type: 'collide' });
          other._emit('collide', { body: ball, target: other, type: 'collide' });
        }
      }
      this._activePairs = next;
    }
  }

  class NaiveBroadphase {}

  // Install shim — replaces real Cannon if already loaded, or provides CANNON before game script
  window.CANNON = {
    World,
    Body,
    Sphere,
    Box,
    Cylinder,
    ConvexPolyhedron,
    Vec3,
    Quaternion,
    Material,
    ContactMaterial,
    NaiveBroadphase,
    Body: Body
  };
  // Fix duplicate Body key
  window.CANNON.Body = Body;
  Body.STATIC = 0;
  Body.DYNAMIC = 1;
  Body.KINEMATIC = 2;

  window.CapVRCannonShim = { active: true, World, Body };
  console.log('[CapVR] CANNON→Box3D shim installed');
})();
