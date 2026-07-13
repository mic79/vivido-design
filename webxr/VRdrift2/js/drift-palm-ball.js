/**
 * Palm dynamic spheres (surface + game ball) + torso column.
 * In contact: physics integrates (roll/spin). In air: snap to tracked hand.
 */
(function () {
  const C = window.VRDRIFT || {};
  const GROUP_STATIC = 4;
  const GROUP_WALL = 32;
  const GROUP_GAME_BALL = 8;
  const GROUP_PALM = 16;
  const GROUP_BODY = 64;
  const GROUP_PLAYER = 1;

  function makePalmSphere(radius, material) {
    const body = new CANNON.Body({
      mass: C.PALM_SPHERE_MASS != null ? C.PALM_SPHERE_MASS : 0.12,
      shape: new CANNON.Sphere(radius),
      material: material,
      linearDamping: 0.04,
      angularDamping: 0.06,
      allowSleep: false,
      collisionFilterGroup: GROUP_PALM,
      /* Floors + game ball only — walls react on the player rig, not by bouncing palms. */
      collisionFilterMask: GROUP_STATIC | GROUP_GAME_BALL
    });
    return body;
  }

  function makeBodyCapsule(radius, height, material) {
    const body = new CANNON.Body({
      mass: 0,
      type:
        typeof CANNON !== 'undefined' && CANNON.Body.KINEMATIC != null
          ? CANNON.Body.KINEMATIC
          : 1,
      material: material,
      collisionFilterGroup: GROUP_BODY,
      collisionFilterMask: GROUP_STATIC | GROUP_WALL | GROUP_GAME_BALL
    });
    body.addShape(new CANNON.Cylinder(radius, radius, height, 12));
    return body;
  }

  function isStaticBody(b) {
    return b && (b.mass === 0 || b.type === (CANNON.Body && CANNON.Body.STATIC));
  }

  window.VRDriftPalmBall = {
    left: null,
    right: null,
    torso: null,
    _torsoH: 0,
    _torsoPrev: new THREE.Vector3(),
    _torsoReady: false,
    _gameContact: { left: false, right: false },
    _staticContact: { left: false, right: false },
    _wasGameContact: { left: false, right: false },
    _wasStaticContact: { left: false, right: false },
    _staticNormal: {
      left: new CANNON.Vec3(0, 1, 0),
      right: new CANNON.Vec3(0, 1, 0)
    },
    _prevHandPos: { left: new THREE.Vector3(), right: new THREE.Vector3() },
    _ready: { left: false, right: false },
    _debugMesh: { left: null, right: null },

    init: function () {
      const Phys = window.VRDriftPhysics;
      if (!Phys || !Phys.world || !Phys.palmMat) return false;
      if (this.left) return true;

      const r = C.PALM_SPHERE_RADIUS != null ? C.PALM_SPHERE_RADIUS : 0.05;
      this.left = makePalmSphere(r, Phys.palmMat);
      this.right = makePalmSphere(r, Phys.palmMat);

      const capR =
        C.PLAYER_COLLISION_RADIUS != null ? C.PLAYER_COLLISION_RADIUS : 0.24;
      this.torso = makeBodyCapsule(capR, 1.6, Phys.playerMat);

      Phys.world.addBody(this.left);
      Phys.world.addBody(this.right);
      Phys.world.addBody(this.torso);

      const self = this;
      function bindContact(key, palmBody) {
        palmBody.addEventListener('collide', function (e) {
          const other = e.body === palmBody ? e.target : e.body;
          if (!other) return;
          const gb = window.VRDriftGameBall && window.VRDriftGameBall.getBody();
          if (gb && other === gb) {
            self._gameContact[key] = true;
            return;
          }
          if (!isStaticBody(other)) return;
          self._staticContact[key] = true;
          const contact = e.contact;
          if (contact && contact.ni) {
            let nx = contact.ni.x;
            let ny = contact.ni.y;
            let nz = contact.ni.z;
            if (e.body !== palmBody) {
              nx = -nx;
              ny = -ny;
              nz = -nz;
            }
            const n = self._staticNormal[key];
            n.set(nx, ny, nz);
            const len = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z);
            if (len > 1e-6) n.scale(1 / len, n);
          }
        });
      }
      bindContact('left', this.left);
      bindContact('right', this.right);
      return true;
    },

    resetFrameContacts: function () {
      this._gameContact.left = false;
      this._gameContact.right = false;
      this._staticContact.left = false;
      this._staticContact.right = false;
    },

    finishPhysicsStep: function () {
      this._wasGameContact.left = this._gameContact.left;
      this._wasGameContact.right = this._gameContact.right;
      this._wasStaticContact.left = this._staticContact.left;
      this._wasStaticContact.right = this._staticContact.right;
      this.enforcePalmsAboveFloor();
      this.enforceAllPalmGameBallSolid(true);
    },

    getGameBallBody: function () {
      return window.VRDriftGameBall && window.VRDriftGameBall.getBody
        ? window.VRDriftGameBall.getBody()
        : null;
    },

    gameBallRadius: function () {
      return C.GAME_BALL_RADIUS != null ? C.GAME_BALL_RADIUS : 0.25;
    },

    palmNearGameBall: function (palmBody) {
      const gb = this.getGameBallBody();
      if (!gb || !palmBody) return false;
      const gap =
        C.PALM_CONTACT_DIST != null ? C.PALM_CONTACT_DIST : 0.008;
      const minD = this.palmRadius() + this.gameBallRadius() + gap;
      const dx = palmBody.position.x - gb.position.x;
      const dy = palmBody.position.y - gb.position.y;
      const dz = palmBody.position.z - gb.position.z;
      return dx * dx + dy * dy + dz * dz <= minD * minD;
    },

    /**
     * Separation only when penetrating — no continuous velocity pumping (avoids sticky ball).
     */
    resolvePalmGameBallSolid: function (palmBody, handVx, handVy, handVz, allowImpulse) {
      const gb = this.getGameBallBody();
      if (!gb || !palmBody) return false;

      const rp = this.palmRadius();
      const rb = this.gameBallRadius();
      const minD = rp + rb;

      let dx = palmBody.position.x - gb.position.x;
      let dy = palmBody.position.y - gb.position.y;
      let dz = palmBody.position.z - gb.position.z;
      let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist < 1e-8) {
        dx = 0;
        dy = 1;
        dz = 0;
        dist = minD;
      }

      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;
      const pen = minD - dist;

      if (pen <= 1e-6) return false;

      const mp = palmBody.mass;
      const mb = gb.mass;
      const total = mp + mb;
      const palmShare = mb / total;
      const ballShare = mp / total;
      palmBody.position.x += nx * pen * palmShare;
      palmBody.position.y += ny * pen * palmShare;
      palmBody.position.z += nz * pen * palmShare;
      gb.position.x -= nx * pen * ballShare;
      gb.position.y -= ny * pen * ballShare;
      gb.position.z -= nz * pen * ballShare;

      if (allowImpulse) {
        const e = 0;
        const maxDv = C.PALM_GAME_BALL_MAX_DV != null ? C.PALM_GAME_BALL_MAX_DV : 2.8;
        const pvx = handVx != null ? handVx : palmBody.velocity.x;
        const pvy = handVy != null ? handVy : palmBody.velocity.y;
        const pvz = handVz != null ? handVz : palmBody.velocity.z;
        const vPn = pvx * nx + pvy * ny + pvz * nz;
        const vBn = gb.velocity.x * nx + gb.velocity.y * ny + gb.velocity.z * nz;
        const approach = vPn - vBn;
        if (approach > 0.08) {
          const driveMass = Math.max(mp, mb * 0.4);
          let dvb = ((1 + e) * driveMass * approach) / mb;
          if (dvb > maxDv) dvb = maxDv;
          gb.velocity.x += nx * dvb;
          gb.velocity.y += ny * dvb;
          gb.velocity.z += nz * dvb;
        }
      }

      gb.wakeUp();
      palmBody.wakeUp();
      return true;
    },

    enforceAllPalmGameBallSolid: function (allowImpulse) {
      ['left', 'right'].forEach((key) => {
        const palm = this.getPalmBody(key);
        if (!palm) return;
        if (!this._gameContact[key] && !this._wasGameContact[key]) return;
        this.resolvePalmGameBallSolid(palm, null, null, null, allowImpulse);
      });
    },

    /** Hard clamp after Cannon step — never allow palm centers below walkable floor. */
    enforcePalmsAboveFloor: function () {
      if (this.left) this.constrainPalmFromFloor(this.left);
      if (this.right) this.constrainPalmFromFloor(this.right);
    },

    /** Hands own palm pose — snap Cannon sphere back if physics drifted (never on floor plant). */
    snapPalmsToHands: function (getHandColliderPose, leftHand, rightHand, skipFloor) {
      if (!getHandColliderPose) return;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      [
        ['left', this.left, leftHand],
        ['right', this.right, rightHand]
      ].forEach(([key, body, hand]) => {
        if (!body || !hand) return;
        if (skipFloor && skipFloor(key)) return;
        getHandColliderPose(hand, pos, quat);
        body.position.set(pos.x, pos.y, pos.z);
        body.angularVelocity.set(0, 0, 0);
      });
    },

    hadGameBallContact: function (key) {
      return !!this._gameContact[key];
    },

    hadStaticContact: function (key) {
      return !!this._staticContact[key];
    },

    getPalmBody: function (key) {
      return key === 'left' ? this.left : this.right;
    },

    getPalmWorldPosition: function (key, out) {
      const body = this.getPalmBody(key);
      if (!body) return false;
      out.set(body.position.x, body.position.y, body.position.z);
      return true;
    },

    getPalmWorldQuaternion: function (key, out) {
      const body = this.getPalmBody(key);
      if (!body || !body.quaternion) return false;
      out.set(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w);
      return true;
    },

    getStaticContactNormal: function (key, out) {
      const n = this._staticNormal[key];
      if (!n) return false;
      out.set(n.x, n.y, n.z);
      if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
      else out.normalize();
      return true;
    },

    syncBodyCapsule: function (opts) {
      if (!this.torso || !opts) return;
      const r = opts.radius != null ? opts.radius : 0.24;
      const floorY = opts.floorY;
      const topY = opts.topY;
      if (floorY == null || topY == null) return;
      const h = Math.max(0.15, topY - floorY);
      const cx = opts.anchorX;
      const cz = opts.anchorZ;
      const cy = floorY + h * 0.5;

      if (Math.abs(h - this._torsoH) > 0.02) {
        this.torso.shapes = [];
        this.torso.addShape(new CANNON.Cylinder(r, r, h, 12));
        this._torsoH = h;
      }

      const step = opts.dt > 1e-6 ? opts.dt : 1 / 90;
      let vx = 0;
      let vy = 0;
      let vz = 0;
      if (this._torsoReady) {
        vx = (cx - this._torsoPrev.x) / step;
        vy = (cy - this._torsoPrev.y) / step;
        vz = (cz - this._torsoPrev.z) / step;
      } else {
        this._torsoReady = true;
      }
      this.torso.position.set(cx, cy, cz);
      this.torso.velocity.set(vx, vy, vz);
      this._torsoPrev.set(cx, cy, cz);
    },

    palmRadius: function () {
      return C.PALM_SPHERE_RADIUS != null ? C.PALM_SPHERE_RADIUS : 0.05;
    },

    /** Keep palm sphere center on/above walkable floor (Y only at current XZ). */
    constrainPalmFromFloor: function (body) {
      const Col = window.VRDriftCollision;
      if (!Col || !body) return;
      const r = this.palmRadius();
      const pos = body.position;
      const floorY = Col.getWalkableHeightAt(pos.x, pos.z, '[drift-floor]', pos.y + r + 2);
      if (floorY == null) return;
      const minY = floorY + r;
      if (pos.y < minY) {
        pos.y = minY;
        if (body.velocity.y < 0) body.velocity.y = 0;
      }
    },

    pinPalmToFloorGrip: function (body, grip) {
      if (!body || !grip || !grip.anchorWorld) return;
      const r = this.palmRadius();
      const n = grip.floorNormal;
      const ax = grip.anchorWorld.x;
      const ay = grip.anchorWorld.y;
      const az = grip.anchorWorld.z;
      if (n) {
        body.position.set(ax + n.x * r, ay + n.y * r, az + n.z * r);
      } else {
        body.position.set(ax, ay + r, az);
      }
      body.velocity.set(0, 0, 0);
      body.angularVelocity.set(0, 0, 0);
    },

    /** Post-step: only floor-grip pins — do not kinematically shove palms (Cannon owns contact). */
    constrainPalms: function () {
      /* Floor grip no longer pins palms — Cannon contact + locomotion coupling own motion. */
    },

    /**
     * Transfer palm Cannon velocity to player ball — no scripted push/skate forces.
     */
    drivePlayerFromPalms: function (playerBody, dt, skipDrive) {
      if (skipDrive || !playerBody || !dt) return;
      const blendK =
        C.PALM_PLAYER_VELOCITY_BLEND != null ? C.PALM_PLAYER_VELOCITY_BLEND : 2.8;
      const maxDv = C.PALM_DRIVE_MAX_DV != null ? C.PALM_DRIVE_MAX_DV : 0.22;
      const alpha = 1 - Math.exp(-blendK * dt);
      if (alpha < 1e-6) return;

      let dvx = 0;
      let dvy = 0;
      let dvz = 0;
      let nContact = 0;
      const n = { x: 0, y: 1, z: 0 };

      ['left', 'right'].forEach((key) => {
        if (!this.hadStaticContact(key)) return;
        const palm = this.getPalmBody(key);
        if (!palm) return;
        const sn = this._staticNormal[key];
        if (sn) {
          n.x = sn.x;
          n.y = sn.y;
          n.z = sn.z;
        } else {
          n.x = 0;
          n.y = 1;
          n.z = 0;
        }
        const pvx = palm.velocity.x;
        const pvy = palm.velocity.y;
        const pvz = palm.velocity.z;
        const vn = pvx * n.x + pvy * n.y + pvz * n.z;
        let tx = pvx;
        let ty = pvy;
        let tz = pvz;
        if (vn < 0) {
          tx -= n.x * vn;
          ty -= n.y * vn;
          tz -= n.z * vn;
        }
        dvx += (tx - playerBody.velocity.x) * alpha;
        dvy += (ty - playerBody.velocity.y) * alpha;
        dvz += (tz - playerBody.velocity.z) * alpha;
        nContact++;
      });

      if (nContact < 1) return;
      dvx /= nContact;
      dvy /= nContact;
      dvz /= nContact;
      const dLen = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
      if (dLen > maxDv && dLen > 1e-8) {
        const s = maxDv / dLen;
        dvx *= s;
        dvy *= s;
        dvz *= s;
      }
      playerBody.wakeUp();
      playerBody.velocity.x += dvx;
      playerBody.velocity.y += dvy;
      playerBody.velocity.z += dvz;
    },

    /**
     * Post-step: blend palm Cannon velocity into arena game ball (full 3D, immediate push feel).
     */
    driveGameBallFromPalms: function (gameBody, dt) {
      if (!gameBody || !dt) return;
      const blendK =
        C.PALM_GAME_BALL_VELOCITY_BLEND != null ? C.PALM_GAME_BALL_VELOCITY_BLEND : 16;
      const maxDv = C.PALM_GAME_BALL_MAX_DV != null ? C.PALM_GAME_BALL_MAX_DV : 1.1;
      const alpha = 1 - Math.exp(-blendK * dt);
      if (alpha < 1e-6) return;

      let dvx = 0;
      let dvy = 0;
      let dvz = 0;
      let nContact = 0;

      ['left', 'right'].forEach((key) => {
        if (!this._gameContact[key]) return;
        const palm = this.getPalmBody(key);
        if (!palm) return;
        dvx += (palm.velocity.x - gameBody.velocity.x) * alpha;
        dvy += (palm.velocity.y - gameBody.velocity.y) * alpha;
        dvz += (palm.velocity.z - gameBody.velocity.z) * alpha;
        nContact++;
      });

      if (nContact < 1) return;
      dvx /= nContact;
      dvy /= nContact;
      dvz /= nContact;
      const dLen = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
      if (dLen > maxDv && dLen > 1e-8) {
        const s = maxDv / dLen;
        dvx *= s;
        dvy *= s;
        dvz *= s;
      }
      gameBody.wakeUp();
      gameBody.velocity.x += dvx;
      gameBody.velocity.y += dvy;
      gameBody.velocity.z += dvz;
    },

    /**
     * Pre-step: match hand when airborne; when touching surfaces let Cannon roll (velocity chase only).
     * Floor grip: palm pinned to anchor on surface (tracked hand moves the rig via locomotion).
     */
    sync: function (dt, getHandColliderPose, leftHand, rightHand, camera, bodyCapsule, opts) {
      if (!this.init()) return;
      this.resetFrameContacts();
      if (bodyCapsule) {
        bodyCapsule.dt = dt;
        this.syncBodyCapsule(bodyCapsule);
      }
      const step = dt > 1e-6 ? dt : 1 / 90;
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const chase = C.PALM_HAND_CHASE_GAIN != null ? C.PALM_HAND_CHASE_GAIN : 14;
      const ballChase =
        C.PALM_GAME_BALL_CHASE_GAIN != null ? C.PALM_GAME_BALL_CHASE_GAIN : 20;
      const airChase = C.PALM_AIR_CHASE_GAIN != null ? C.PALM_AIR_CHASE_GAIN : 22;

      [
        ['left', this.left, leftHand],
        ['right', this.right, rightHand]
      ].forEach(([key, body, hand]) => {
        if (!hand || !body) return;

        getHandColliderPose(hand, pos, quat);

        let vx = 0;
        let vy = 0;
        let vz = 0;
        if (this._ready[key]) {
          vx = (pos.x - this._prevHandPos[key].x) / step;
          vy = (pos.y - this._prevHandPos[key].y) / step;
          vz = (pos.z - this._prevHandPos[key].z) / step;
        } else {
          this._ready[key] = true;
          body.position.set(pos.x, pos.y, pos.z);
          body.velocity.set(0, 0, 0);
          body.angularVelocity.set(0, 0, 0);
        }

        body.wakeUp();

        const sn = this._staticNormal[key];
        let floorPlant = false;
        if (this._wasStaticContact[key] && sn) {
          const sl = Math.sqrt(sn.x * sn.x + sn.y * sn.y + sn.z * sn.z);
          const inclineNy =
            C.PALM_FLOOR_SKATE_INCLINE_NY != null ? C.PALM_FLOOR_SKATE_INCLINE_NY : 0.92;
          if (sl > 1e-6 && sn.y / sl >= inclineNy) floorPlant = true;
        }

        /* Hands own palm pose everywhere except floor plant (Cannon roll on walkable). */
        if (!floorPlant) {
          body.position.set(pos.x, pos.y, pos.z);
          body.velocity.set(vx, vy, vz);
          body.angularVelocity.set(0, 0, 0);
          this.constrainPalmFromFloor(body);
          this._prevHandPos[key].copy(pos);
          return;
        }

        if (this._wasStaticContact[key]) {
          let nx = 0;
          let ny = 1;
          let nz = 0;
          if (sn) {
            const sl = Math.sqrt(sn.x * sn.x + sn.y * sn.y + sn.z * sn.z);
            if (sl > 1e-6) {
              nx = sn.x / sl;
              ny = sn.y / sl;
              nz = sn.z / sl;
            }
          }
          let ex = pos.x - body.position.x;
          let ey = pos.y - body.position.y;
          let ez = pos.z - body.position.z;
          const en = ex * nx + ey * ny + ez * nz;
          ex -= nx * en;
          ey -= ny * en;
          ez -= nz * en;
          const chaseMax =
            C.PALM_CHASE_MAX_SPEED != null ? C.PALM_CHASE_MAX_SPEED : 2.2;
          let cx = vx + ex * chase;
          let cy = vy + ey * chase;
          let cz = vz + ez * chase;
          const vn = cx * nx + cy * ny + cz * nz;
          if (vn < 0) {
            cx -= nx * vn;
            cy -= ny * vn;
            cz -= nz * vn;
          }
          const cs = Math.sqrt(cx * cx + cy * cy + cz * cz);
          const hs = Math.sqrt(vx * vx + vy * vy + vz * vz);
          const cap = Math.max(chaseMax, hs + 0.4);
          if (cs > cap && cs > 1e-6) {
            const s = cap / cs;
            cx *= s;
            cy *= s;
            cz *= s;
          }
          body.velocity.set(cx, cy, cz);
        } else if (
          !this._wasStaticContact[key] &&
          (this._wasGameContact[key] || this.palmNearGameBall(body))
        ) {
          const ex = pos.x - body.position.x;
          const ey = pos.y - body.position.y;
          const ez = pos.z - body.position.z;
          const chaseMax =
            C.PALM_CHASE_MAX_SPEED != null ? C.PALM_CHASE_MAX_SPEED : 2.2;
          let cx = vx + ex * ballChase;
          let cy = vy + ey * ballChase;
          let cz = vz + ez * ballChase;
          const cs = Math.sqrt(cx * cx + cy * cy + cz * cz);
          const hs = Math.sqrt(vx * vx + vy * vy + vz * vz);
          const cap = Math.max(chaseMax + 1.2, hs + 0.8);
          if (cs > cap && cs > 1e-6) {
            const s = cap / cs;
            cx *= s;
            cy *= s;
            cz *= s;
          }
          body.velocity.set(cx, cy, cz);
        } else {
          const ex = pos.x - body.position.x;
          const ey = pos.y - body.position.y;
          const ez = pos.z - body.position.z;
          const chaseMax =
            C.PALM_CHASE_MAX_SPEED != null ? C.PALM_CHASE_MAX_SPEED : 2.2;
          let cx = vx + ex * airChase;
          let cy = vy + ey * airChase;
          let cz = vz + ez * airChase;
          const cs = Math.sqrt(cx * cx + cy * cy + cz * cz);
          const hs = Math.sqrt(vx * vx + vy * vy + vz * vz);
          const cap = Math.max(chaseMax + 0.8, hs + 0.6);
          if (cs > cap && cs > 1e-6) {
            const s = cap / cs;
            cx *= s;
            cy *= s;
            cz *= s;
          }
          body.velocity.set(cx, cy, cz);
          body.angularVelocity.set(0, 0, 0);
        }

        this.constrainPalmFromFloor(body);
        this._prevHandPos[key].copy(pos);
      });
    },

    showPalmSphereDebug: function () {
      return (
        C.SHOW_PALM_SPHERE_DEBUG === true || C.SHOW_HAND_COLLISION_DEBUG === true
      );
    },

    _stripeTexture: null,

    makeStripeTexture: function (THREE) {
      if (this._stripeTexture) return this._stripeTexture;
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      for (let row = 0; row < 8; row++) {
        ctx.fillStyle = row % 2 === 0 ? '#55ccff' : '#1a4488';
        ctx.fillRect(0, row * 8, 64, 8);
      }
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, 32);
      ctx.lineTo(64, 32);
      ctx.stroke();
      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(1, 2);
      this._stripeTexture = tex;
      return tex;
    },

    ensureDebugMeshes: function () {
      if (!this.showPalmSphereDebug()) return;
      const root = document.querySelector('#hand-collision-debug');
      if (!root || !AFRAME || !AFRAME.THREE) return;
      const THREE = AFRAME.THREE;
      const r = C.PALM_SPHERE_RADIUS != null ? C.PALM_SPHERE_RADIUS : 0.05;
      const tex = this.makeStripeTexture(THREE);
      ['left', 'right'].forEach((side) => {
        let mesh = this._debugMesh[side];
        if (mesh && mesh.parent !== root.object3D) {
          root.object3D.add(mesh);
          mesh.scale.set(1, 1, 1);
        }
        if (mesh) return;
        const geom = new THREE.SphereGeometry(r, 20, 14);
        const mat = new THREE.MeshStandardMaterial({
          map: tex,
          color: side === 'left' ? 0xaaffcc : 0xaaccff,
          roughness: 0.45,
          metalness: 0.05,
          transparent: true,
          opacity: 0.88,
          depthTest: true
        });
        mesh = new THREE.Mesh(geom, mat);
        const wire = new THREE.Mesh(
          geom,
          new THREE.MeshBasicMaterial({
            color: 0xffffff,
            wireframe: true,
            transparent: true,
            opacity: 0.35,
            depthTest: true
          })
        );
        mesh.add(wire);
        mesh.name = 'palm-sphere-debug-' + side;
        mesh.renderOrder = 998;
        mesh.frustumCulled = false;
        root.object3D.add(mesh);
        this._debugMesh[side] = mesh;
      });
      root.setAttribute('visible', true);
      root.object3D.visible = true;
    },

    /** Match debug mesh to Cannon body pose (position + rotation) after physics. */
    syncDebugMeshes: function (opts) {
      const show = this.showPalmSphereDebug();
      const root = document.querySelector('#hand-collision-debug');
      if (!show) {
        if (root) root.setAttribute('visible', false);
        ['left', 'right'].forEach((side) => {
          const m = this._debugMesh[side];
          if (m) m.visible = false;
        });
        return;
      }
      this.init();
      this.ensureDebugMeshes();
      if (root) {
        root.setAttribute('visible', true);
        root.object3D.visible = true;
      }
      const touchL = opts && (opts.left || opts.grabL || opts.floorL);
      const touchR = opts && (opts.right || opts.grabR || opts.floorR);
      ['left', 'right'].forEach((side) => {
        const mesh = this._debugMesh[side];
        const body = this.getPalmBody(side);
        if (!mesh) return;
        mesh.visible = true;
        if (body) {
          mesh.position.set(body.position.x, body.position.y, body.position.z);
          mesh.quaternion.set(
            body.quaternion.x,
            body.quaternion.y,
            body.quaternion.z,
            body.quaternion.w
          );
        }
        const active = side === 'left' ? touchL : touchR;
        mesh.material.color.setHex(active ? 0xffeeaa : side === 'left' ? 0xccffdd : 0xccddee);
        mesh.material.emissive.setHex(active ? 0x554400 : 0x000000);
        mesh.material.emissiveIntensity = active ? 0.35 : 0;
        if (mesh.children[0] && mesh.children[0].material) {
          mesh.children[0].material.color.setHex(active ? 0xffffaa : 0xffffff);
        }
      });
      const avatarEl = document.querySelector('#local-body');
      const avatar = avatarEl && avatarEl.components['mixamo-body-avatar'];
      if (avatar && avatar.setPalmDebugVisible) avatar.setPalmDebugVisible(false);
    },

    syncHandCollisionDebug: function (opts) {
      this.syncDebugMeshes(opts);
    }
  };
})();
