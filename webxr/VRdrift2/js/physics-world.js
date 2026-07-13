/**
 * Box3D physics world — body ball, palm ball-wheels, game ball, floor/wall statics.
 */
(function () {
  'use strict';

  const CDN = 'https://cdn.jsdelivr.net/npm/box3d.js@0.0.2/dist/box3d.inline.mjs';
  const IDENTITY = { v: { x: 0, y: 0, z: 0 }, s: 1 };

  class DriftPhysicsWorld {
    constructor() {
      this.b3 = null;
      this.world = null;
      this.queries = null;
      this.ready = false;
      this.playerBody = null;
      this.playerShapeIds = [];
      this.gameBallBody = null;
      this.gameBallShapeIds = [];
      this.palmBodies = { left: null, right: null };
      this.palmShapeIds = { left: [], right: [] };
      this.floorBodies = new Set();
      this.wallBodies = new Set();
      this.gripBodies = new Set();
      this.staticBodies = [];
      this.CATEGORY = window.Box3DCollision.CATEGORY;
      this._accum = 0;
      this._step = 1 / (window.VRDRIFT?.PHYSICS_HZ || 90);
      this._contactsBuffer = null;
      this._contactScratch = null;
      this._manifoldScratch = null;
    }

    async init() {
      const C = window.VRDRIFT;
      const Box3D = (await import(CDN)).default;
      this.b3 = await Box3D();
      const worldDef = this.b3.b3DefaultWorldDef();
      worldDef.gravity = { x: 0, y: C.GRAVITY, z: 0 };
      this.world = this.b3.b3CreateWorld(worldDef);
      this.queries = window.Box3DCollision.createCollisionQueries(this.b3, this.world);
      if (this.b3.createContactsBuffer) {
        this._contactsBuffer = this.b3.createContactsBuffer();
        this._contactScratch = this.b3.createContact();
        this._manifoldScratch = this.b3.createManifold();
      }
      this.ready = true;
      return this;
    }

    _shapeDef(opts) {
      const sd = window.Box3DCollision.makeShapeDef(this.b3, {
        category: opts.category,
        mask: opts.mask,
        friction: opts.friction ?? 0.7,
        restitution: opts.restitution ?? 0.05
      });
      if (opts.density != null) sd.density = opts.density;
      if (opts.enableContactEvents && sd) sd.enableContactEvents = true;
      return sd;
    }

    addStaticBox(x, y, z, halfX, halfY, halfZ, opts) {
      if (!this.ready) return null;
      const isFloor = !!opts?.isFloor;
      const cat = isFloor ? this.CATEGORY.FLOOR : this.CATEGORY.WALL;
      const mask = isFloor
        ? this.CATEGORY.PLAYER | this.CATEGORY.PALM | this.CATEGORY.GAME_BALL
        : this.CATEGORY.PLAYER | this.CATEGORY.PALM | this.CATEGORY.GAME_BALL;
      const def = this.b3.b3DefaultBodyDef();
      def.position = { x, y, z };
      if (opts?.qx != null) {
        def.rotation = { v: { x: opts.qx, y: opts.qy, z: opts.qz }, s: opts.qw };
      }
      const body = this.b3.b3CreateBody(this.world, def);
      this.b3.b3CreateBoxShape(
        body,
        this._shapeDef({
          category: cat,
          mask,
          friction: opts?.friction ?? (isFloor ? 0.7 : 0.55),
          restitution: opts?.restitution ?? 0.04
        }),
        halfX,
        halfY,
        halfZ
      );
      this.staticBodies.push(body);
      if (isFloor) this.floorBodies.add(body);
      else this.wallBodies.add(body);
      if (opts?.isGrip) this.gripBodies.add(body);
      return body;
    }

    addStaticCylinder(x, y, z, radius, halfHeight, opts) {
      if (!this.ready) return null;
      const isFloor = !!opts?.isFloor;
      const cat = isFloor ? this.CATEGORY.FLOOR : this.CATEGORY.WALL;
      const mask = isFloor
        ? this.CATEGORY.PLAYER | this.CATEGORY.PALM | this.CATEGORY.GAME_BALL
        : this.CATEGORY.PLAYER | this.CATEGORY.PALM | this.CATEGORY.GAME_BALL;
      const def = this.b3.b3DefaultBodyDef();
      def.position = { x, y, z };
      const body = this.b3.b3CreateBody(this.world, def);
      this.b3.b3CreateCapsuleShape(
        body,
        this._shapeDef({
          category: cat,
          mask,
          friction: opts?.friction ?? 0.9,
          restitution: 0.04
        }),
        {
          center1: { x: 0, y: -halfHeight, z: 0 },
          center2: { x: 0, y: halfHeight, z: 0 },
          radius
        }
      );
      this.staticBodies.push(body);
      if (isFloor) this.floorBodies.add(body);
      else this.wallBodies.add(body);
      if (opts?.isGrip) this.gripBodies.add(body);
      return body;
    }

    addStaticFromElement(el, opts) {
      if (!this.ready || !el || !el.object3D) return null;
      el.object3D.updateMatrixWorld(true);
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      el.object3D.matrixWorld.decompose(pos, quat, scale);

      const geo = el.getAttribute('geometry') || {};
      const tag = (el.tagName || '').toLowerCase();
      const isCyl =
        tag === 'a-cylinder' ||
        geo.primitive === 'cylinder' ||
        el.components?.geometry?.data?.primitive === 'cylinder';

      const isFloor = !!(opts?.isFloor || el.hasAttribute('drift-floor'));
      const o = Object.assign({}, opts, {
        qx: quat.x,
        qy: quat.y,
        qz: quat.z,
        qw: quat.w,
        isFloor,
        isGrip: !!(opts?.isGrip || el.hasAttribute('drift-grip'))
      });

      if (isCyl) {
        const r = (Number(geo.radius) || el.getAttribute('radius') || 0.5) * Math.max(scale.x, scale.z);
        const h = (Number(geo.height) || el.getAttribute('height') || 1) * scale.y;
        return this.addStaticCylinder(pos.x, pos.y, pos.z, r, h / 2, o);
      }

      const w = (Number(geo.width) || el.getAttribute('width') || 1) * scale.x;
      const h = (Number(geo.height) || el.getAttribute('height') || 1) * scale.y;
      const d = (Number(geo.depth) || el.getAttribute('depth') || 1) * scale.z;
      return this.addStaticBox(pos.x, pos.y, pos.z, w / 2, h / 2, d / 2, o);
    }

    createPlayerBall(x, y, z) {
      const C = window.VRDRIFT;
      const def = this.b3.b3DefaultBodyDef();
      def.type = this.b3.b3BodyType.b3_dynamicBody;
      def.position = { x, y, z };
      this.playerBody = this.b3.b3CreateBody(this.world, def);

      const sd = this._shapeDef({
        category: this.CATEGORY.PLAYER,
        mask: this.CATEGORY.FLOOR | this.CATEGORY.WALL,
        friction: C.PLAYER_BALL_FRICTION != null ? C.PLAYER_BALL_FRICTION : 0.18,
        restitution: 0,
        density: C.BODY_BALL_DENSITY
      });
      this.b3.b3CreateSphereShape(this.playerBody, sd, {
        center: { x: 0, y: 0, z: 0 },
        radius: C.BODY_BALL_RADIUS
      });
      this.playerShapeIds = this.b3.b3Body_GetShapes(this.playerBody);
      if (this.b3.b3Body_SetLinearDamping) {
        this.b3.b3Body_SetLinearDamping(this.playerBody, C.LINEAR_DAMPING);
      }
      if (this.b3.b3Body_SetAngularDamping) {
        this.b3.b3Body_SetAngularDamping(this.playerBody, C.ANGULAR_DAMPING);
      }
      if (this.b3.b3Body_SetBullet) this.b3.b3Body_SetBullet(this.playerBody, true);
      if (this.b3.b3Body_EnableSleep) this.b3.b3Body_EnableSleep(this.playerBody, false);
      return this.playerBody;
    }

    createPalmSphere(side, x, y, z) {
      const C = window.VRDRIFT;
      const r = C.PALM_SPHERE_RADIUS != null ? C.PALM_SPHERE_RADIUS : 0.05;
      const mass = C.PALM_SPHERE_MASS != null ? C.PALM_SPHERE_MASS : 1.5;
      const vol = (4 / 3) * Math.PI * r * r * r;
      const density = mass / Math.max(vol, 1e-8);

      const def = this.b3.b3DefaultBodyDef();
      def.type = this.b3.b3BodyType.b3_dynamicBody;
      def.position = { x, y, z };
      const body = this.b3.b3CreateBody(this.world, def);

      const sd = this._shapeDef({
        category: this.CATEGORY.PALM,
        mask: this.CATEGORY.FLOOR | this.CATEGORY.WALL | this.CATEGORY.GAME_BALL,
        friction: C.PALM_BALL_FRICTION != null ? C.PALM_BALL_FRICTION : 0.62,
        restitution: 0,
        density,
        enableContactEvents: true
      });
      this.b3.b3CreateSphereShape(body, sd, { center: { x: 0, y: 0, z: 0 }, radius: r });
      if (this.b3.b3Body_SetLinearDamping) this.b3.b3Body_SetLinearDamping(body, 0.04);
      if (this.b3.b3Body_SetAngularDamping) this.b3.b3Body_SetAngularDamping(body, 0.06);
      if (this.b3.b3Body_EnableSleep) this.b3.b3Body_EnableSleep(body, false);

      this.palmBodies[side] = body;
      this.palmShapeIds[side] = this.b3.b3Body_GetShapes(body);
      return body;
    }

    createGameBall(x, y, z) {
      const C = window.VRDRIFT;
      const def = this.b3.b3DefaultBodyDef();
      def.type = this.b3.b3BodyType.b3_dynamicBody;
      def.position = { x, y, z };
      this.gameBallBody = this.b3.b3CreateBody(this.world, def);

      const sd = this._shapeDef({
        category: this.CATEGORY.GAME_BALL,
        mask:
          this.CATEGORY.FLOOR |
          this.CATEGORY.WALL |
          this.CATEGORY.PALM,
        friction: 0.45,
        restitution: C.GAME_BALL_RESTITUTION != null ? C.GAME_BALL_RESTITUTION : 0.05,
        density: C.GAME_BALL_DENSITY
      });
      this.b3.b3CreateSphereShape(this.gameBallBody, sd, {
        center: { x: 0, y: 0, z: 0 },
        radius: C.GAME_BALL_RADIUS
      });
      this.gameBallShapeIds = this.b3.b3Body_GetShapes(this.gameBallBody);
      if (this.b3.b3Body_SetLinearDamping) {
        this.b3.b3Body_SetLinearDamping(this.gameBallBody, 0.04);
      }
      if (this.b3.b3Body_SetAngularDamping) {
        this.b3.b3Body_SetAngularDamping(this.gameBallBody, 0.1);
      }
      return this.gameBallBody;
    }

    getPlayerPosition() {
      if (!this.playerBody) return { x: 0, y: 0.24, z: 0 };
      return this.b3.b3Body_GetPosition(this.playerBody);
    }

    getPlayerVelocity() {
      if (!this.playerBody) return { x: 0, y: 0, z: 0 };
      return this.b3.b3Body_GetLinearVelocity(this.playerBody);
    }

    setPlayerVelocity(vx, vy, vz) {
      if (!this.playerBody || !this.b3.b3Body_SetLinearVelocity) return;
      this.b3.b3Body_SetLinearVelocity(this.playerBody, { x: vx, y: vy, z: vz });
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(this.playerBody, true);
    }

    setPlayerPosition(x, y, z) {
      if (!this.playerBody) return;
      const rot =
        this.b3.b3Body_GetRotation?.(this.playerBody) || IDENTITY;
      this.b3.b3Body_SetTransform(this.playerBody, { x, y, z }, rot);
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(this.playerBody, true);
      // Hard teleport (jump/spawn) — reseed visual stream
      if (!this._visPrev) this._visPrev = { x, y, z };
      if (!this._visCurr) this._visCurr = { x, y, z };
      this._visPrev.x = x;
      this._visPrev.y = y;
      this._visPrev.z = z;
      this._visCurr.x = x;
      this._visCurr.y = y;
      this._visCurr.z = z;
      this._visAlpha = 0;
    }

    /** Soft shift that keeps visual interpolation continuous (no hitch). */
    nudgePlayerPosition(dx, dy, dz) {
      if (!this.playerBody) return;
      const p = this.getPlayerPosition();
      const x = p.x + (dx || 0);
      const y = p.y + (dy || 0);
      const z = p.z + (dz || 0);
      const rot =
        this.b3.b3Body_GetRotation?.(this.playerBody) || IDENTITY;
      this.b3.b3Body_SetTransform(this.playerBody, { x, y, z }, rot);
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(this.playerBody, true);
      if (this._visPrev) {
        this._visPrev.x += dx || 0;
        this._visPrev.y += dy || 0;
        this._visPrev.z += dz || 0;
      }
      if (this._visCurr) {
        this._visCurr.x += dx || 0;
        this._visCurr.y += dy || 0;
        this._visCurr.z += dz || 0;
      }
    }

    getPlayerRotation() {
      if (!this.playerBody) return IDENTITY;
      return this.b3.b3Body_GetRotation(this.playerBody) || IDENTITY;
    }

    setPlayerAngularVelocity(wx, wy, wz) {
      if (!this.playerBody || !this.b3.b3Body_SetAngularVelocity) return;
      this.b3.b3Body_SetAngularVelocity(this.playerBody, { x: wx, y: wy, z: wz });
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(this.playerBody, true);
    }

    /** No-slip roll: ω = n × v / radius (matches ball-wheel spinning). */
    applyRollingSpin(body, vx, vy, vz, nx, ny, nz, radius) {
      if (!body || !this.b3.b3Body_SetAngularVelocity || !radius) return;
      // ω = n × v / r
      const wx = (ny * vz - nz * vy) / radius;
      const wy = (nz * vx - nx * vz) / radius;
      const wz = (nx * vy - ny * vx) / radius;
      this.b3.b3Body_SetAngularVelocity(body, { x: wx, y: wy, z: wz });
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);
    }

    applyPlayerForce(fx, fy, fz) {
      if (!this.playerBody || !this.b3.b3Body_ApplyForceToCenter) return;
      this.b3.b3Body_ApplyForceToCenter(this.playerBody, { x: fx, y: fy, z: fz }, true);
    }

    applyPlayerImpulse(ix, iy, iz) {
      if (!this.playerBody || !this.b3.b3Body_ApplyLinearImpulseToCenter) return;
      this.b3.b3Body_ApplyLinearImpulseToCenter(this.playerBody, { x: ix, y: iy, z: iz }, true);
    }

    getPalmBody(side) {
      return this.palmBodies[side];
    }

    getPalmPosition(side) {
      const body = this.palmBodies[side];
      if (!body) return null;
      return this.b3.b3Body_GetPosition(body);
    }

    getPalmVelocity(side) {
      const body = this.palmBodies[side];
      if (!body) return { x: 0, y: 0, z: 0 };
      return this.b3.b3Body_GetLinearVelocity(body);
    }

    setPalmTransform(side, x, y, z) {
      const body = this.palmBodies[side];
      if (!body) return;
      const rot = this.b3.b3Body_GetRotation?.(body) || IDENTITY;
      this.b3.b3Body_SetTransform(body, { x, y, z }, rot);
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);
    }

    setPalmVelocity(side, vx, vy, vz, opts) {
      const body = this.palmBodies[side];
      if (!body || !this.b3.b3Body_SetLinearVelocity) return;
      this.b3.b3Body_SetLinearVelocity(body, { x: vx, y: vy, z: vz });
      // Default: keep angular velocity so planted palms can roll.
      // Pass { clearAngular: true } when snapping airborne palms to hands.
      if (opts && opts.clearAngular && this.b3.b3Body_SetAngularVelocity) {
        this.b3.b3Body_SetAngularVelocity(body, { x: 0, y: 0, z: 0 });
      }
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(body, true);
    }

    getPalmRotation(side) {
      const body = this.palmBodies[side];
      if (!body) return IDENTITY;
      return this.b3.b3Body_GetRotation(body) || IDENTITY;
    }

    /**
     * Read current contacts for a palm. Returns { floor, gameBall, normal }.
     * Uses contact manifolds when available; falls back to overlap + down-ray.
     */
    readPalmContacts(side) {
      const body = this.palmBodies[side];
      const out = {
        floor: false,
        wall: false,
        gameBall: false,
        normal: { x: 0, y: 1, z: 0 }
      };
      if (!body) return out;
      const C = window.VRDRIFT;
      const r = C.PALM_SPHERE_RADIUS != null ? C.PALM_SPHERE_RADIUS : 0.05;
      const p = this.b3.b3Body_GetPosition(body);

      // Game ball proximity
      if (this.gameBallBody) {
        const gp = this.b3.b3Body_GetPosition(this.gameBallBody);
        const gr = C.GAME_BALL_RADIUS || 0.25;
        const d = Math.hypot(p.x - gp.x, p.y - gp.y, p.z - gp.z);
        if (d < r + gr + 0.02) out.gameBall = true;
      }

      // Contact buffer (best)
      if (this._contactsBuffer && this.b3.getBodyContactData) {
        try {
          this.b3.getBodyContactData(this._contactsBuffer, body);
          const n = this.b3.getNumContacts(this._contactsBuffer);
          let bestNy = -2;
          let bestAny = -2;
          let bestN = null;
          for (let i = 0; i < n; i++) {
            this.b3.getContactAt(this._contactScratch, this._contactsBuffer, i);
            const otherBody =
              this._contactScratch.bodyIdA != null
                ? this._contactScratch.bodyIdA === body
                  ? this._contactScratch.bodyIdB
                  : this._contactScratch.bodyIdA
                : null;
            if (otherBody != null && this.floorBodies.has(otherBody)) {
              out.floor = true;
            }
            if (otherBody != null && this.wallBodies.has(otherBody)) {
              out.wall = true;
            }
            if (this._contactScratch.manifoldCount) {
              for (let m = 0; m < this._contactScratch.manifoldCount; m++) {
                this.b3.getManifoldAt(this._manifoldScratch, this._contactScratch, m);
                const mn = this._manifoldScratch.normal;
                if (!mn) continue;
                let nx = mn.x;
                let ny = mn.y;
                let nz = mn.z;
                // Prefer outward normals (away from surface into free space)
                const absNy = Math.abs(ny);
                if (absNy > bestAny) {
                  bestAny = absNy;
                  bestN = { x: nx, y: ny, z: nz };
                }
                if (ny < 0) {
                  nx = -nx;
                  ny = -ny;
                  nz = -nz;
                }
                if (ny > bestNy) {
                  bestNy = ny;
                  out.normal = { x: nx, y: ny, z: nz };
                  if (ny > 0.3) out.floor = true;
                }
              }
            }
          }
          // Non-floor wall plant: keep manifold normal (outward from wall)
          if (out.wall && !out.floor && bestN) {
            out.normal = { x: bestN.x, y: bestN.y, z: bestN.z };
          }
        } catch (e) {
          /* fall through */
        }
      }

      // Overlap / ray fallback — reliable floor plant detection
      if (!out.floor && this.queries) {
        const hit = this.queries.castRayDown(p.x, p.y + 0.02, p.z, r + 0.08, null);
        if (hit && hit.point && p.y - hit.point.y <= r + 0.025) {
          out.floor = true;
          if (hit.normal) {
            out.normal = {
              x: hit.normal.x,
              y: Math.abs(hit.normal.y) < 0.01 ? 1 : hit.normal.y,
              z: hit.normal.z
            };
            if (out.normal.y < 0) {
              out.normal.x *= -1;
              out.normal.y *= -1;
              out.normal.z *= -1;
            }
          }
        }
      }

      return out;
    }

    getGameBallPosition() {
      if (!this.gameBallBody) return null;
      return this.b3.b3Body_GetPosition(this.gameBallBody);
    }

    getGameBallVelocity() {
      if (!this.gameBallBody || !this.b3.b3Body_GetLinearVelocity) return { x: 0, y: 0, z: 0 };
      return this.b3.b3Body_GetLinearVelocity(this.gameBallBody);
    }

    getGameBallAngularVelocity() {
      if (!this.gameBallBody || !this.b3.b3Body_GetAngularVelocity) return { x: 0, y: 0, z: 0 };
      return this.b3.b3Body_GetAngularVelocity(this.gameBallBody);
    }

    getGameBallRotation() {
      if (!this.gameBallBody) return IDENTITY;
      return this.b3.b3Body_GetRotation(this.gameBallBody);
    }

    getGameBallState() {
      if (!this.gameBallBody) return null;
      const p = this.getGameBallPosition();
      const v = this.getGameBallVelocity();
      const w = this.getGameBallAngularVelocity();
      const r = this.getGameBallRotation() || IDENTITY;
      return {
        px: p.x,
        py: p.y,
        pz: p.z,
        vx: v.x,
        vy: v.y,
        vz: v.z,
        wx: w.x,
        wy: w.y,
        wz: w.z,
        qx: r.v ? r.v.x : 0,
        qy: r.v ? r.v.y : 0,
        qz: r.v ? r.v.z : 0,
        qw: r.s != null ? r.s : 1
      };
    }

    setGameBallState(s) {
      if (!this.gameBallBody || !s) return;
      const rot = {
        v: { x: s.qx || 0, y: s.qy || 0, z: s.qz || 0 },
        s: s.qw != null ? s.qw : 1
      };
      this.b3.b3Body_SetTransform(this.gameBallBody, { x: s.px, y: s.py, z: s.pz }, rot);
      if (this.b3.b3Body_SetLinearVelocity) {
        this.b3.b3Body_SetLinearVelocity(this.gameBallBody, {
          x: s.vx || 0,
          y: s.vy || 0,
          z: s.vz || 0
        });
      }
      if (this.b3.b3Body_SetAngularVelocity) {
        this.b3.b3Body_SetAngularVelocity(this.gameBallBody, {
          x: s.wx || 0,
          y: s.wy || 0,
          z: s.wz || 0
        });
      }
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(this.gameBallBody, true);
    }

    applyGameBallImpulse(ix, iy, iz) {
      if (!this.gameBallBody || !this.b3.b3Body_ApplyLinearImpulseToCenter) return;
      this.b3.b3Body_ApplyLinearImpulseToCenter(this.gameBallBody, { x: ix, y: iy, z: iz }, true);
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(this.gameBallBody, true);
    }

    setGameBallVelocity(vx, vy, vz) {
      if (!this.gameBallBody || !this.b3.b3Body_SetLinearVelocity) return;
      this.b3.b3Body_SetLinearVelocity(this.gameBallBody, { x: vx, y: vy, z: vz });
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(this.gameBallBody, true);
    }

    setGameBallPosition(x, y, z) {
      if (!this.gameBallBody) return;
      const rot = this.b3.b3Body_GetRotation?.(this.gameBallBody) || IDENTITY;
      this.b3.b3Body_SetTransform(this.gameBallBody, { x, y, z }, rot);
      if (this.b3.b3Body_SetAwake) this.b3.b3Body_SetAwake(this.gameBallBody, true);
    }

    sampleFloorY(x, y, z) {
      const hit = this.queries.castRayDown(x, y + 0.05, z, 4, this.playerShapeIds);
      return hit ? hit.point.y : null;
    }

    step(dt) {
      if (!this.ready) return;
      // One physics step per display frame — avoids 0/1/2 substep hitching
      const h = Math.max(1 / 240, Math.min(dt || this._step, 1 / 45));
      const p0 = this.getPlayerPosition();
      if (!this._visPrev) this._visPrev = { x: p0.x, y: p0.y, z: p0.z };
      if (!this._visCurr) this._visCurr = { x: p0.x, y: p0.y, z: p0.z };
      this._visPrev.x = this._visCurr.x;
      this._visPrev.y = this._visCurr.y;
      this._visPrev.z = this._visCurr.z;
      this.b3.b3World_Step(this.world, h);
      const p = this.getPlayerPosition();
      this._visCurr.x = p.x;
      this._visCurr.y = p.y;
      this._visCurr.z = p.z;
      this._accum = 0;
      this._lastFrameDt = h;
      this._visSteps = 1;
      this._visAlpha = 0;
    }

    /** Camera follows physics each frame (1:1 with display step). */
    getPlayerVisualPosition() {
      return this.getPlayerPosition();
    }
  }

  window.DriftPhysicsWorld = DriftPhysicsWorld;

  AFRAME.registerComponent('drift-physics-world', {
    init: function () {
      this.phys = new DriftPhysicsWorld();
      window.DriftPhys = this.phys;
      this.el.sceneEl.emit('drift-physics-pending');
      this.phys
        .init()
        .then(() => {
          this.el.sceneEl.emit('drift-physics-ready', { phys: this.phys });
          console.log('[VRdrift2] Box3D physics ready (palm wheels)');
        })
        .catch((err) => {
          console.error('[VRdrift2] Box3D init failed', err);
        });
    }
  });
})();
