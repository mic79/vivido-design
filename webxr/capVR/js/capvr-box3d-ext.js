/**
 * CapVR Box3D physics core — arena statics, dynamic balls/flags, goal sensors.
 * Extends body-rigged4 Box3DPhysicsWorld.
 */
(function () {
  'use strict';

  // Extra collision categories for gameplay objects
  if (window.Box3DCollision?.CATEGORY) {
    window.Box3DCollision.CATEGORY.BALL = 16n;
    window.Box3DCollision.CATEGORY.GOAL = 32n;
    window.Box3DCollision.CATEGORY.BOT = 64n;
  }

  const Proto = window.Box3DPhysicsWorld?.prototype;
  if (!Proto) {
    console.error('[CapVR] Box3DPhysicsWorld missing — load box3d-physics-world.js first');
    return;
  }

  // --- Constructor patches via wrapping init ---
  const origInit = Proto.init;
  Proto.init = async function (options) {
    this.arenaBodies = this.arenaBodies || [];
    this.dynamicBodies = this.dynamicBodies || [];
    this.sensorBodies = this.sensorBodies || [];
    this.skipDemoColliders = options?.skipDemoColliders !== false;
    this._bodyMeta = this._bodyMeta || new Map(); // body -> { kind, el, radius }
    const result = await origInit.call(this, {
      gravity: options?.gravity || { x: 0, y: 0, z: 0 },
      ...options
    });
    // Enlarge ground for CTF arenas
    return result;
  };

  // Echo Arena floor sits near y=-10. Never place a mid-chamber slab at y=0 —
  // that traps zero-g play and looks like "spawning above the ceiling".
  Proto._addGround = function () {
    if (!this.b3 || !this.world) return;
    const def = this.b3.b3DefaultBodyDef();
    def.position = { x: 0, y: -10.55, z: 0 };
    const body = this.b3.b3CreateBody(this.world, def);
    this.b3.b3CreateBoxShape(body, this._shapeDef(), 40, 0.55, 60);
  };

  // CapVR arenas come from BoltVR grab-surface → Box3D statics; skip body-rigged demo props.
  Proto._addSceneColliders = function () { /* no-op */ };

  Proto.clearArenaBodies = function () {
    if (!this.b3 || !this.world) return;
    (this.arenaBodies || []).forEach((body) => {
      try { this.b3.b3DestroyBody(body); } catch (e) { /* */ }
    });
    this.arenaBodies = [];
  };

  Proto.addArenaStaticBox = function (x, y, z, halfX, halfY, halfZ, quat, opts) {
    if (!this.b3 || !this.world) return null;
    const def = this.b3.b3DefaultBodyDef();
    def.position = { x, y, z };
    if (quat && (quat.x || quat.y || quat.z || quat.w != null)) {
      def.rotation = { v: { x: quat.x || 0, y: quat.y || 0, z: quat.z || 0 }, s: quat.w != null ? quat.w : 1 };
    }
    const body = this.b3.b3CreateBody(this.world, def);
    this.b3.b3CreateBoxShape(body, this._shapeDef(opts), halfX, halfY, halfZ);
    this.arenaBodies = this.arenaBodies || [];
    this.arenaBodies.push(body);
    this._bodyMeta?.set(body, { kind: 'arena' });
    return body;
  };

  Proto.addArenaStaticSphere = function (x, y, z, radius, opts) {
    if (!this.b3 || !this.world) return null;
    const def = this.b3.b3DefaultBodyDef();
    def.position = { x, y, z };
    if (opts?.quat) {
      const q = opts.quat;
      def.rotation = { v: { x: q.x || 0, y: q.y || 0, z: q.z || 0 }, s: q.w != null ? q.w : 1 };
    }
    const body = this.b3.b3CreateBody(this.world, def);
    this.b3.b3CreateSphereShape(body, this._shapeDef(opts), {
      center: { x: 0, y: 0, z: 0 },
      radius
    });
    this.arenaBodies = this.arenaBodies || [];
    this.arenaBodies.push(body);
    this._bodyMeta?.set(body, { kind: 'arena', el: opts?.el || null });
    return body;
  };

  /**
   * Static triangle mesh collider (octahedron / tetrahedron / torus / any non-box).
   * `positions` = Float32Array xyz local verts, `indices` = Uint32Array triangles.
   */
  Proto.addArenaStaticMesh = function (x, y, z, quat, positions, indices, opts) {
    if (!this.b3 || !this.world) return null;
    if (!positions?.length || !indices?.length) return null;
    const posArr = positions instanceof Float32Array ? positions : new Float32Array(positions);
    const idxArr = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
    const meshData = this.b3.b3CreateMesh(posArr, idxArr);
    this.meshHandles = this.meshHandles || [];
    this.meshHandles.push(meshData);

    const def = this.b3.b3DefaultBodyDef();
    def.position = { x, y, z };
    if (quat && (quat.x || quat.y || quat.z || quat.w != null)) {
      def.rotation = { v: { x: quat.x || 0, y: quat.y || 0, z: quat.z || 0 }, s: quat.w != null ? quat.w : 1 };
    }
    const body = this.b3.b3CreateBody(this.world, def);
    this.b3.b3CreateMeshShape(body, this._shapeDef(opts), meshData, { x: 1, y: 1, z: 1 });
    this.arenaBodies = this.arenaBodies || [];
    this.arenaBodies.push(body);
    this._bodyMeta?.set(body, { kind: 'arena-mesh', el: opts?.el || null });
    return body;
  };

  /** Build a static mesh collider from an A-Frame / THREE entity's visual geometry (local space). */
  Proto.addArenaStaticFromEl = function (el, opts) {
    if (!this.b3 || !this.world || !el?.object3D) return null;
    const THREE = window.AFRAME?.THREE || window.THREE;
    if (!THREE) return null;

    el.object3D.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(el.object3D.matrixWorld).invert();
    const vertices = [];
    const indices = [];
    let indexOffset = 0;

    el.object3D.traverse((child) => {
      if (!child.isMesh || !child.geometry) return;
      // Skip debug / wireframe children
      if (child.material?.wireframe) return;
      const geo = child.geometry.index
        ? child.geometry.toNonIndexed()
        : child.geometry.clone();
      const pos = geo.getAttribute('position');
      if (!pos) return;
      const m = new THREE.Matrix4().multiplyMatrices(inv, child.matrixWorld);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        vertices.push(v.x, v.y, v.z);
      }
      for (let i = 0; i < pos.count; i++) indices.push(indexOffset + i);
      indexOffset += pos.count;
      geo.dispose?.();
    });

    if (vertices.length < 9 || indices.length < 3) return null;

    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    el.object3D.getWorldPosition(worldPos);
    el.object3D.getWorldQuaternion(worldQuat);

    return this.addArenaStaticMesh(
      worldPos.x, worldPos.y, worldPos.z,
      { x: worldQuat.x, y: worldQuat.y, z: worldQuat.z, w: worldQuat.w },
      new Float32Array(vertices),
      new Uint32Array(indices),
      { ...opts, el }
    );
  };

  /** Convex polyhedron (octa / tetra) → triangulated mesh collider. */
  Proto.addArenaStaticConvex = function (x, y, z, quat, vertices, faces, opts) {
    if (!vertices?.length || !faces?.length) return null;
    const positions = new Float32Array(vertices.length * 3);
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
    }
    const indices = [];
    for (let f = 0; f < faces.length; f++) {
      const face = faces[f];
      if (!face || face.length < 3) continue;
      for (let i = 1; i < face.length - 1; i++) {
        indices.push(face[0], face[i], face[i + 1]);
      }
    }
    if (indices.length < 3) return null;
    return this.addArenaStaticMesh(x, y, z, quat, positions, new Uint32Array(indices), opts);
  };

  /**
   * Dynamic sphere for balls / flags. Returns Box3D body id.
   */
  Proto.createDynamicSphere = function (x, y, z, radius, mass, opts) {
    if (!this.b3 || !this.world) return null;
    const CAT = this.CATEGORY;
    const def = this.b3.b3DefaultBodyDef();
    def.type = this.b3.b3BodyType.b3_dynamicBody;
    def.position = { x, y, z };
    def.linearDamping = opts?.linearDamping ?? 0.05;
    def.angularDamping = opts?.angularDamping ?? 0.05;
    const body = this.b3.b3CreateBody(this.world, def);
    const sd = window.Box3DCollision.makeShapeDef(this.b3, {
      category: opts?.category ?? CAT.BALL ?? 16n,
      mask: opts?.mask ?? (CAT.ENVIRONMENT | CAT.PLAYER | CAT.HAND | CAT.RAGDOLL | (CAT.BALL || 16n) | (CAT.GOAL || 32n) | (CAT.BOT || 64n)),
      friction: opts?.friction ?? 0.4,
      restitution: opts?.restitution ?? 0.35
    });
    const vol = (4 / 3) * Math.PI * radius * radius * radius;
    sd.density = mass && vol > 0 ? mass / vol : 1;
    this.b3.b3CreateSphereShape(body, sd, {
      center: { x: 0, y: 0, z: 0 },
      radius
    });
    if (this.b3.b3Body_ApplyMassFromShapes) this.b3.b3Body_ApplyMassFromShapes(body);
    this.dynamicBodies = this.dynamicBodies || [];
    this.dynamicBodies.push(body);
    this._bodyMeta?.set(body, { kind: 'ball', radius, el: opts?.el || null });
    return body;
  };

  Proto.createGoalSensor = function (x, y, z, radius, height, opts) {
    if (!this.b3 || !this.world) return null;
    const CAT = this.CATEGORY;
    const def = this.b3.b3DefaultBodyDef();
    def.position = { x, y, z };
    const body = this.b3.b3CreateBody(this.world, def);
    const sd = window.Box3DCollision.makeShapeDef(this.b3, {
      category: CAT.GOAL ?? 32n,
      mask: CAT.BALL ?? 16n,
      isSensor: true,
      friction: 0,
      restitution: 0
    });
    // Approximate cylinder as box or capsule
    this.b3.b3CreateCapsuleShape(body, sd, {
      center1: { x: 0, y: -height * 0.5, z: 0 },
      center2: { x: 0, y: height * 0.5, z: 0 },
      radius
    });
    this.sensorBodies = this.sensorBodies || [];
    this.sensorBodies.push(body);
    this._bodyMeta?.set(body, { kind: 'goal', el: opts?.el || null, team: opts?.team });
    return body;
  };

  Proto.destroyBody = function (body) {
    if (!this.b3 || !body) return;
    try { this.b3.b3DestroyBody(body); } catch (e) { /* */ }
    this.arenaBodies = (this.arenaBodies || []).filter((b) => b !== body);
    this.dynamicBodies = (this.dynamicBodies || []).filter((b) => b !== body);
    this.sensorBodies = (this.sensorBodies || []).filter((b) => b !== body);
    this._bodyMeta?.delete(body);
  };

  Proto.getBodyPosition = function (body) {
    if (!this.b3 || !body) return { x: 0, y: 0, z: 0 };
    const p = this.b3.b3Body_GetPosition(body);
    return { x: p.x, y: p.y, z: p.z };
  };

  Proto.setBodyPosition = function (body, x, y, z) {
    if (!this.b3 || !body) return;
    const r = this.b3.b3Body_GetRotation?.(body) || { v: { x: 0, y: 0, z: 0 }, s: 1 };
    this.b3.b3Body_SetTransform(body, { x, y, z }, r);
    if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);
  };

  Proto.getBodyVelocity = function (body) {
    if (!this.b3?.b3Body_GetLinearVelocity || !body) return { x: 0, y: 0, z: 0 };
    const v = this.b3.b3Body_GetLinearVelocity(body);
    return { x: v.x, y: v.y, z: v.z };
  };

  Proto.setBodyVelocity = function (body, x, y, z) {
    if (!this.b3?.b3Body_SetLinearVelocity || !body) return;
    this.b3.b3Body_SetLinearVelocity(body, { x, y, z });
    if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);
  };

  Proto.getBodyQuaternion = function (body) {
    if (!this.b3?.b3Body_GetRotation || !body) return { x: 0, y: 0, z: 0, w: 1 };
    const r = this.b3.b3Body_GetRotation(body);
    // Box3D uses { v: xyz, s: w }
    if (r.v) return { x: r.v.x, y: r.v.y, z: r.v.z, w: r.s };
    return { x: r.x || 0, y: r.y || 0, z: r.z || 0, w: r.w != null ? r.w : 1 };
  };

  Proto.stepWorld = function (dt) {
    if (!this.b3 || !this.world) return;
    const clamped = Math.min(dt || 1 / 60, 0.033);
    this.b3.b3World_Step(this.world, clamped, 4);
  };

  /**
   * Sphere overlap query for goal scoring / sticky attach.
   */
  Proto.overlapSphere = function (x, y, z, radius, maskBits) {
    if (!this.queries?.overlapSphere) {
      // Fallback: check known dynamic bodies by distance
      const hits = [];
      (this.dynamicBodies || []).forEach((body) => {
        const p = this.getBodyPosition(body);
        const d = Math.hypot(p.x - x, p.y - y, p.z - z);
        const meta = this._bodyMeta?.get(body);
        const r = meta?.radius || 0.2;
        if (d < radius + r) hits.push({ body, el: meta?.el, distance: d });
      });
      return hits;
    }
    return this.queries.overlapSphere({ x, y, z }, radius, maskBits) || [];
  };

  window.CapVRPhysics = {
    get() {
      const scene = document.querySelector('a-scene');
      return scene?.components?.['capvr-physics']?.physics
        || scene?.components?.['leg-ik-world']?.physics
        || null;
    },
    ready(cb) {
      const tryIt = () => {
        const p = this.get();
        if (p?.world && p.b3) return cb(p);
        setTimeout(tryIt, 50);
      };
      tryIt();
    },
    /** Host component (queries / stub accessors). */
    host() {
      const scene = document.querySelector('a-scene');
      return scene?.components?.['capvr-physics']
        || scene?.components?.['leg-ik-world']
        || null;
    }
  };

  console.log('[CapVR] Box3D physics extensions loaded');
})();
