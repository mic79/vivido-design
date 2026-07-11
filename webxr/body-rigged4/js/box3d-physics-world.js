/**
 * Box3D physics world for body-rigged4 — world setup, player mover, hand queries, ragdoll.
 * Supports runtime gravity changes for grounded ↔ zero-g modes.
 */
(function () {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/box3d.js@0.0.2/dist/box3d.inline.mjs';

  class Box3DPhysicsWorld {
    constructor() {
      this.b3 = null;
      this.world = null;
      this.queries = null;
      this.meshHandles = [];
      this.playerBody = null;
      this.playerShapeIds = [];
      this.playerPosition = { x: 0, y: 0, z: 0 };
      this.playerVelocity = { x: 0, y: 0, z: 0 };
      this.playerGrounded = true;
      this.playerVelY = 0;
      this.ragdollHuman = null;
      this.ragdollVisual = null;
      this.ragdollMirrorVisual = null;
      this.ragdollMirrorOpts = null;
      this.ragdollShowDebug = false;
      this.ragdollActive = false;
      this.ragdollGroup = 1;
      this.playerColliderDisabled = false;
      this.ragdollShapeIdSet = new Set();

      this._capsuleCrouchT = -1;
      this.capsule = {
        center1: { x: 0, y: 0.3, z: 0 },
        center2: { x: 0, y: 1.5, z: 0 },
        radius: 0.18
      };
      this.moverFilter = null;
      this.CATEGORY = window.Box3DCollision.CATEGORY;
    }

    async init(options) {
      const Box3D = (await import(CDN)).default;
      this.b3 = await Box3D();
      const worldDef = this.b3.b3DefaultWorldDef();
      const g = options?.gravity
        || (window.BodyRiggedGravity?.isZeroG?.()
          ? window.BodyRiggedGravity.gravityZeroG
          : null)
        || { x: 0, y: -20, z: 0 };
      worldDef.gravity = { x: g.x, y: g.y, z: g.z };
      this._gravity = { x: g.x, y: g.y, z: g.z };
      this.world = this.b3.b3CreateWorld(worldDef);
      this.queries = window.Box3DCollision.createCollisionQueries(this.b3, this.world);
      this.moverFilter = this.b3.b3DefaultQueryFilter();
      this.moverFilter.maskBits = this.CATEGORY.ENVIRONMENT;

      this._addGround();
      this._addSceneColliders();
      return this;
    }

    /** Update world gravity (e.g. grounded ↔ zero-g). Affects dynamic bodies / ragdolls. */
    setGravity(x, y, z) {
      if (!this.b3 || !this.world) return;
      const gx = x ?? 0;
      const gy = y ?? 0;
      const gz = z ?? 0;
      this._gravity = { x: gx, y: gy, z: gz };
      if (typeof this.b3.b3World_SetGravity === 'function') {
        this.b3.b3World_SetGravity(this.world, this._gravity);
      } else if (this.world.gravity) {
        this.world.gravity.x = gx;
        this.world.gravity.y = gy;
        this.world.gravity.z = gz;
      }
    }

    getGravity() {
      return this._gravity || { x: 0, y: -20, z: 0 };
    }

    _shapeDef(opts) {
      return window.Box3DCollision.makeShapeDef(this.b3, {
        category: this.CATEGORY.ENVIRONMENT,
        mask: this.CATEGORY.PLAYER | this.CATEGORY.HAND | this.CATEGORY.RAGDOLL | this.CATEGORY.ENVIRONMENT,
        friction: opts?.friction ?? 0.85,
        restitution: opts?.restitution ?? 0.02
      });
    }

    _addGround() {
      const def = this.b3.b3DefaultBodyDef();
      def.position = { x: 0, y: -0.05, z: 0 };
      const body = this.b3.b3CreateBody(this.world, def);
      this.b3.b3CreateBoxShape(body, this._shapeDef(), 20, 0.05, 20);
    }

    _addSceneColliders() {
      const wallDef = this.b3.b3DefaultBodyDef();
      wallDef.position = { x: 2.5, y: 1, z: -1 };
      const wall = this.b3.b3CreateBody(this.world, wallDef);
      this.b3.b3CreateBoxShape(wall, this._shapeDef(), 0.2, 1.0, 1.0);

      const pillarDef = this.b3.b3DefaultBodyDef();
      pillarDef.position = { x: -1.5, y: 1, z: -1.5 };
      const pillar = this.b3.b3CreateBody(this.world, pillarDef);
      this.b3.b3CreateCapsuleShape(pillar, this._shapeDef(), {
        center1: { x: 0, y: -1, z: 0 },
        center2: { x: 0, y: 1, z: 0 },
        radius: 0.3
      });
    }

    addStaticBox(x, y, z, halfX, halfY, halfZ, opts) {
      if (!this.b3 || !this.world) return null;
      const def = this.b3.b3DefaultBodyDef();
      def.position = { x, y, z };
      const body = this.b3.b3CreateBody(this.world, def);
      this.b3.b3CreateBoxShape(body, this._shapeDef(opts), halfX, halfY, halfZ);
      return body;
    }

    addTrimeshFromObject(model) {
      const vertices = [];
      const indices = [];
      let indexOffset = 0;
      model.updateWorldMatrix(true, true);

      model.traverse((child) => {
        if (!child.isMesh) return;
        const geo = child.geometry.clone();
        geo.applyMatrix4(child.matrixWorld);
        const pos = geo.getAttribute('position');
        for (let i = 0; i < pos.count; i++) {
          vertices.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        }
        const idx = geo.getIndex();
        if (idx) {
          for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + indexOffset);
        } else {
          for (let i = 0; i < pos.count; i++) indices.push(i + indexOffset);
        }
        indexOffset += pos.count;
      });

      if (!vertices.length) return null;

      const positions = new Float32Array(vertices);
      const tris = new Uint32Array(indices);
      const meshData = this.b3.b3CreateMesh(positions, tris);
      this.meshHandles.push(meshData);

      const bodyDef = this.b3.b3DefaultBodyDef();
      bodyDef.position = { x: 0, y: 0, z: 0 };
      const body = this.b3.b3CreateBody(this.world, bodyDef);
      this.b3.b3CreateMeshShape(body, this._shapeDef({ friction: 0.7 }), meshData, { x: 1, y: 1, z: 1 });
      return body;
    }

    initPlayerAt(x, y, z) {
      const playerDef = this.b3.b3DefaultBodyDef();
      playerDef.type = this.b3.b3BodyType.b3_kinematicBody;
      playerDef.position = { x, y, z };
      this.playerBody = this.b3.b3CreateBody(this.world, playerDef);

      const sd = window.Box3DCollision.makeShapeDef(this.b3, {
        category: this.CATEGORY.PLAYER,
        mask: this.CATEGORY.ENVIRONMENT,
        friction: 0,
        restitution: 0
      });
      const cap = this.b3.b3CreateCapsuleShape(this.playerBody, sd, this.capsule);
      this.playerShapeIds = this.b3.b3Body_GetShapes(this.playerBody);
      this.playerPosition = { x, y, z };
      this.playerGrounded = true;
      return cap;
    }

    setPlayerTranslation(x, y, z) {
      this.playerPosition = { x, y, z };
      if (this.playerBody) {
        this.b3.b3Body_SetTransform(
          this.playerBody,
          { x, y, z },
          { v: { x: 0, y: 0, z: 0 }, s: 1 }
        );
      }
    }

    getPlayerTranslation() {
      if (this.playerBody) {
        const p = this.b3.b3Body_GetPosition(this.playerBody);
        this.playerPosition = { x: p.x, y: p.y, z: p.z };
      }
      return this.playerPosition;
    }

    /** Resize player capsule for VR crouch / mantle (matches body-rigged2 Rapier scaling). */
    setPlayerCapsuleForCrouch(crouchT, base) {
      if (!this.playerBody || !this.b3) return false;

      const t = Math.max(0, Math.min(1, crouchT));
      if (this._capsuleCrouchT >= 0 && Math.abs(this._capsuleCrouchT - t) < 0.02) return false;
      this._capsuleCrouchT = t;

      const halfH = (base?.halfH ?? 0.6) * (1 - 0.32 * t);
      const radius = (base?.radius ?? 0.18) * (1 - 0.1 * t);
      const centerY = (base?.centerY ?? 0.9) - 0.4 * t;

      this.capsule = {
        center1: { x: 0, y: centerY - halfH, z: 0 },
        center2: { x: 0, y: centerY + halfH, z: 0 },
        radius
      };

      const shapes = this.playerShapeIds || [];
      for (let i = 0; i < shapes.length; i++) {
        this.b3.b3DestroyShape(shapes[i], false);
      }

      const sd = window.Box3DCollision.makeShapeDef(this.b3, {
        category: this.CATEGORY.PLAYER,
        mask: this.CATEGORY.ENVIRONMENT,
        friction: 0,
        restitution: 0
      });
      this.b3.b3CreateCapsuleShape(this.playerBody, sd, this.capsule);
      this.playerShapeIds = this.b3.b3Body_GetShapes(this.playerBody);
      return true;
    }

    movePlayer(delta, options) {
      const horizontalOnly = options && options.horizontalOnly;
      const d = horizontalOnly
        ? { x: delta.x, y: 0, z: delta.z }
        : { x: delta.x, y: delta.y, z: delta.z };

      const moved = this.queries.moveCapsuleMover(this.playerPosition, d, this.capsule, this.moverFilter);
      this.playerPosition = moved.position;
      this.setPlayerTranslation(moved.position.x, moved.position.y, moved.position.z);
      this._updateGroundedState(d, moved.delta);
      return moved;
    }

    setPlayerColliderEnabled(enabled) {
      if (!this.playerBody) return;
      if (!enabled) {
        const p = this.getPlayerTranslation();
        this._savedPlayerPos = { x: p.x, y: p.y, z: p.z };
        this.setPlayerTranslation(p.x, -50, p.z);
        this.playerColliderDisabled = true;
        return;
      }
      this.playerColliderDisabled = false;
      this._savedPlayerPos = null;
    }

    _feetOffsetY() {
      return this.capsule.center1.y - this.capsule.radius;
    }

    _updateGroundedState(requested, actual) {
      const feetY = this.playerPosition.y + this._feetOffsetY();
      const groundHit = this.queries.castRayDown(
        this.playerPosition.x,
        feetY + 0.25,
        this.playerPosition.z,
        0.45,
        this.playerShapeIds
      );
      const nearGround = !!groundHit && Math.abs(groundHit.point.y - feetY) < 0.15;

      if (requested.y < -1e-6) {
        const hitFloor = actual.y > requested.y + 1e-4;
        this.playerGrounded = hitFloor || nearGround;
      } else if (requested.y > 1e-6) {
        this.playerGrounded = nearGround;
      } else {
        this.playerGrounded = nearGround;
      }
    }

    _hasGround(x, y, z) {
      const hit = this.queries.castRayDown(x, y + 0.4, z, 0.75, this.playerShapeIds);
      if (!hit) return false;
      return Math.abs(hit.point.y - y) < 0.12;
    }

    step(dt) {
      this.b3.b3World_Step(this.world, Math.min(dt, 0.033), 4);
      if (!this.ragdollActive || !this.ragdollHuman || !this.ragdollShowDebug) return;
      if (this.ragdollVisual) {
        window.Box3DRagdoll.syncHumanToThree(this.b3, this.ragdollHuman, this.ragdollVisual);
      }
      if (this.ragdollMirrorVisual && this.ragdollMirrorOpts && this.ragdollVisual) {
        const rig = typeof document !== 'undefined' ? document.getElementById('rig') : null;
        const vrLoco = rig?.components?.['vr-locomotion'];
        if (vrLoco) {
          this.ragdollMirrorOpts.manualRotationY = vrLoco.mirrorRotationY || 0;
        }
        window.Box3DRagdoll.ensureMirrorVisualMeshes(this.b3, this.ragdollHuman, this.ragdollMirrorVisual);
        window.Box3DRagdoll.syncMirroredHumanToThree(
          this.ragdollVisual,
          this.ragdollMirrorVisual,
          this.ragdollMirrorOpts
        );
      }
    }

    resolveSphere(pos, radius, opts) {
      return this.queries.resolveSphereAgainstColliders(pos, radius, {
        excludeShapeIds: opts?.exclude ?? this.playerShapeIds,
        horizontalOnly: opts?.horizontalOnly
      });
    }

    // Push a sphere center out of any geometry it overlaps.
    // Bias toward a free reference (controller / previous probe), then axis-ray.
    _depenetrateSphere(center, radius, exclude, awayRef, opts) {
      opts = opts || {};
      const q = this.queries;
      const overlaps = (p) => q.sphereOverlaps({ x: p.x, y: p.y, z: p.z }, radius, exclude);
      const pos = center.clone();
      if (!overlaps(pos)) return pos;

      const tryWalk = (target) => {
        if (!target) return false;
        const dir = target.clone
          ? target.clone().sub(center)
          : new THREE.Vector3(target.x - center.x, target.y - center.y, target.z - center.z);
        if (dir.lengthSq() < 1e-10) return false;
        dir.normalize();
        pos.copy(center);
        for (let i = 0; i < 48; i++) {
          if (!overlaps(pos)) return true;
          pos.addScaledVector(dir, radius * 0.25 + 0.004);
        }
        return !overlaps(pos);
      };

      // Prefer shoulder / controller so we exit on the player-facing side.
      if (tryWalk(opts.preferToward)) return pos;
      if (tryWalk(opts.tracking || awayRef)) return pos;
      if (awayRef && awayRef !== opts.tracking && tryWalk(awayRef)) return pos;

      // Axis-ray push-out — the reliable wall blocker.
      const resolved = q.resolveSphereAgainstColliders(center, radius, {
        excludeShapeIds: exclude,
        maxIterations: 24
      });
      return resolved.position;
    }

    // Continuous collide-and-slide from a free start toward `desired`.
    // No soft-clamp: a hit must fully stop the probe or hands tunnel through walls.
    slideHandSphere(lastValid, lastTrack, desired, radius, trackingPos, opts) {
      opts = opts || {};
      const exclude = this.playerShapeIds;
      const q = this.queries;
      const skin = 0.0015;
      const overlaps = (p) => q.sphereOverlaps({ x: p.x, y: p.y, z: p.z }, radius, exclude);
      const preferToward = opts.preferToward || null;
      const tracking = trackingPos || lastTrack || desired;
      const depOpts = { preferToward, tracking };

      let normal = new THREE.Vector3(0, 1, 0);
      let hitShapeId = null;
      const finish = (pos, wasHit, n) => {
        if (n && n.lengthSq() > 1e-8) normal.copy(n).normalize();
        return {
          position: pos,
          hit: wasHit,
          normal,
          shapeId: hitShapeId,
          contactPoint: pos.clone().addScaledVector(normal, -radius)
        };
      };

      let pos;
      if (lastValid) {
        pos = overlaps(lastValid)
          ? this._depenetrateSphere(lastValid, radius, exclude, lastTrack || tracking, depOpts)
          : lastValid.clone();
      } else {
        if (!overlaps(desired)) {
          return finish(desired.clone(), false, normal);
        }
        pos = this._depenetrateSphere(desired, radius, exclude, tracking || lastTrack, depOpts);
      }

      let vel = desired.clone().sub(pos);
      let hit = false;
      for (let iter = 0; iter < 6; iter++) {
        const dist = vel.length();
        if (dist < 1e-5) break;
        const to = pos.clone().add(vel);
        const sweep = q.castSphereSweep(pos, to, radius, exclude);
        if (!sweep.hit) {
          pos.copy(to);
          break;
        }
        hit = true;
        if (sweep.shapeId != null) hitShapeId = sweep.shapeId;
        const n = new THREE.Vector3(sweep.normal.x, sweep.normal.y, sweep.normal.z);
        if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
        else n.normalize();
        normal.copy(n);

        const frac = Math.min(1, Math.max(0, sweep.fraction != null ? sweep.fraction : 0));
        const advance = Math.max(0, frac - 0.001);
        pos.addScaledVector(vel, advance);
        vel.multiplyScalar(1 - advance);

        const vn = vel.dot(n);
        if (vn < 0) vel.addScaledVector(n, -vn);

        let guard = 0;
        while (guard++ < 6 && overlaps(pos)) {
          pos.addScaledVector(n, skin * 3);
        }
        pos.addScaledVector(n, skin);
      }

      if (overlaps(pos)) {
        pos = this._depenetrateSphere(pos, radius, exclude, lastValid || tracking, depOpts);
        hit = true;
      } else if (overlaps(desired)) {
        // Sweep missed while desired is embedded (stale/tunneled history).
        pos = this._depenetrateSphere(desired, radius, exclude, lastValid || tracking, depOpts);
        hit = true;
      }

      return finish(pos, hit, normal);
    }

    /** Enable/disable RAGDOLL in hand sphere queries (call per-hand when near). */
    setHandCollideRagdoll(enabled) {
      if (this.queries && this.queries.setHandCollideRagdoll) {
        this.queries.setHandCollideRagdoll(!!enabled);
      }
    }

    registerRagdollQueryShapes(human) {
      this.ragdollShapeIdSet.clear();
      if (!human) return;
      if (human.shapeIds && human.shapeIds.length) {
        for (let i = 0; i < human.shapeIds.length; i++) {
          this.ragdollShapeIdSet.add(human.shapeIds[i]);
        }
        return;
      }
      if (!this.b3 || !this.b3.b3Body_GetShapes || !human.bodies) return;
      for (let i = 0; i < human.bodies.length; i++) {
        const shapes = this.b3.b3Body_GetShapes(human.bodies[i]);
        if (!shapes) continue;
        for (let s = 0; s < shapes.length; s++) this.ragdollShapeIdSet.add(shapes[s]);
      }
    }

    clearRagdollQueryShapes() {
      this.ragdollShapeIdSet.clear();
    }

    isRagdollShape(shapeId) {
      return shapeId != null && this.ragdollShapeIdSet.has(shapeId);
    }

    castRay(origin, direction, maxDist) {
      if (!this.queries) return null;
      const len = direction.length();
      if (len < 1e-8) return null;
      const dir = { x: direction.x / len, y: direction.y / len, z: direction.z / len };
      return this.queries.castRay(
        { x: origin.x, y: origin.y, z: origin.z },
        dir,
        maxDist,
        this.queries.handFilter
      );
    }

    clampFingerTips(fingerTips, radius) {
      let anyHit = false;
      const out = [];
      for (let i = 0; i < fingerTips.length; i++) {
        const tip = fingerTips[i];
        const last = tip.lastValid || tip.desired;
        const slide = this.slideHandSphere(last, tip.lastTrack || last, tip.desired, radius || tip.radius || 0.012, tip.tracking);
        out.push(slide.position);
        if (slide.hit) anyHit = true;
        tip.lastValid = slide.position.clone();
        tip.lastTrack = (tip.tracking || tip.desired).clone();
      }
      return { tips: out, hit: anyHit };
    }

    spawnRagdoll(sceneRoot, position, opts) {
      opts = opts || {};
      this.destroyRagdoll();
      this.ragdollShowDebug = !!opts.showDebug;
      this.ragdollMirrorOpts = opts.mirrorOpts || null;

      if (this.ragdollShowDebug) {
        this.ragdollVisual = new THREE.Group();
        this.ragdollVisual.name = 'box3d-ragdoll-visual';
        sceneRoot.add(this.ragdollVisual);
        if (this.ragdollMirrorOpts) {
          this.ragdollMirrorVisual = new THREE.Group();
          this.ragdollMirrorVisual.name = 'box3d-ragdoll-mirror-visual';
          sceneRoot.add(this.ragdollMirrorVisual);
        }
      }

      this.ragdollHuman = window.Box3DRagdoll.createHuman(
        this.b3,
        this.world,
        position,
        this.ragdollGroup++,
        // Joint friction scales each joint's motor torque (stiffness). Wrists need
        // enough resistance to track the forearm instead of spinning freely.
        opts.jointFriction ?? 0.14,
        undefined,
        undefined,
        { dynamicBones: opts.dynamicBones || null }
      );
      this.registerRagdollQueryShapes(this.ragdollHuman);
      this.ragdollActive = true;
      this.setPlayerColliderEnabled(false);

      if (this.ragdollShowDebug && this.ragdollMirrorVisual) {
        window.Box3DRagdoll.ensureMirrorVisualMeshes(this.b3, this.ragdollHuman, this.ragdollMirrorVisual);
      }

      return this.ragdollHuman;
    }

    destroyRagdoll() {
      if (this.ragdollHuman) {
        window.Box3DRagdoll.destroyHuman(this.b3, this.ragdollHuman);
        this.ragdollHuman = null;
      }
      this.clearRagdollQueryShapes();
      this.setHandCollideRagdoll(false);
      if (this.ragdollVisual && this.ragdollVisual.parent) {
        this.ragdollVisual.parent.remove(this.ragdollVisual);
      }
      this.ragdollVisual = null;
      if (this.ragdollMirrorVisual && this.ragdollMirrorVisual.parent) {
        this.ragdollMirrorVisual.parent.remove(this.ragdollMirrorVisual);
      }
      this.ragdollMirrorVisual = null;
      this.ragdollMirrorOpts = null;
      this.ragdollShowDebug = false;
      this.ragdollActive = false;
    }

    destroy() {
      this.destroyRagdoll();
      if (this.world) {
        for (let i = 0; i < this.meshHandles.length; i++) {
          try { this.meshHandles[i].delete(); } catch (e) { /* ignore */ }
        }
        this.b3.b3DestroyWorld(this.world);
        this.world = null;
      }
    }
  }

  window.Box3DPhysicsWorld = Box3DPhysicsWorld;
})();
