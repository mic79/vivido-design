/**
 * Palm ball-wheels — Box3D spheres that roll on floors & walls, hit the game ball.
 *
 * Rules (consistent for floor and walls):
 * - Never hard-teleport into a surface (that tunnels and "disappears" the ball).
 * - Near surface: soft tangent chase; balls stay on the outside of the surface.
 * - Soft press: locomotion lifts/pushes the player (palms stay planted).
 * - Hard slap / push-off: jump / launch via locomotion.
 * - Airborne free space: snap to hand, then clamp out of walls/floor.
 */
(function () {
  'use strict';

  const C = () => window.VRDRIFT || {};
  const Col = () => window.VRDriftCollision;
  const _n = new THREE.Vector3();
  const _err = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _pt = new THREE.Vector3();

  window.VRDriftPalmBall = {
    _ready: false,
    _wasFloor: { left: false, right: false },
    _wasWall: { left: false, right: false },
    _wasGame: { left: false, right: false },
    _floor: { left: false, right: false },
    _wall: { left: false, right: false },
    _game: { left: false, right: false },
    _normal: {
      left: new THREE.Vector3(0, 1, 0),
      right: new THREE.Vector3(0, 1, 0)
    },
    _debug: { left: null, right: null },

    init: function () {
      const phys = window.DriftPhys;
      if (!phys?.ready || this._ready) return !!this._ready;
      const r = C().PALM_SPHERE_RADIUS != null ? C().PALM_SPHERE_RADIUS : 0.05;
      const p = phys.getPlayerPosition();
      phys.createPalmSphere('left', p.x - 0.2, p.y + 0.8, p.z);
      phys.createPalmSphere('right', p.x + 0.2, p.y + 0.8, p.z);
      this.ensureDebug();
      this._ready = true;
      console.log('[VRdrift2] Palm ball-wheels ready (r=' + r + ')');
      return true;
    },

    ensureDebug: function () {
      const show = C().SHOW_PALM_SPHERE_DEBUG !== false;
      ['left', 'right'].forEach((side) => {
        if (this._debug[side]) {
          const mesh = this._debug[side].getObject3D('mesh');
          if (mesh) mesh.visible = show;
          return;
        }
        const el = document.createElement('a-entity');
        el.setAttribute('id', 'palm-ball-' + side);
        document.querySelector('a-scene').appendChild(el);
        const THREE = AFRAME.THREE;
        const r = C().PALM_SPHERE_RADIUS != null ? C().PALM_SPHERE_RADIUS : 0.05;
        const geo = new THREE.SphereGeometry(r, 16, 12);
        let mat;
        if (window.VRDriftSoccerTexture) {
          mat = window.VRDriftSoccerTexture.create(THREE, side === 'left' ? '#88ffcc' : '#ffcc88').material;
          mat.transparent = true;
          mat.opacity = 0.7;
        } else {
          mat = new THREE.MeshStandardMaterial({
            color: side === 'left' ? '#88ffcc' : '#ffcc88',
            transparent: true,
            opacity: 0.65
          });
        }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.visible = show;
        mesh.frustumCulled = false;
        el.setObject3D('mesh', mesh);
        this._debug[side] = el;
      });
    },

    palmRadius: function () {
      return C().PALM_SPHERE_RADIUS != null ? C().PALM_SPHERE_RADIUS : 0.05;
    },

    gameBallRadius: function () {
      return C().GAME_BALL_RADIUS != null ? C().GAME_BALL_RADIUS : 0.25;
    },

    palmNearGameBall: function (x, y, z) {
      const phys = window.DriftPhys;
      if (!phys?.gameBallBody) return false;
      const gp = phys.getGameBallPosition();
      if (!gp) return false;
      const gap = C().PALM_GAME_BALL_TOUCH_GAP != null ? C().PALM_GAME_BALL_TOUCH_GAP : 0.04;
      const minD = this.palmRadius() + this.gameBallRadius() + gap;
      return Math.hypot(x - gp.x, y - gp.y, z - gp.z) <= minD;
    },

    /** Geometric wall proximity (works before Box3D contact latches). */
    palmNearWall: function (x, y, z, outNormal) {
      if (!Col()) return false;
      const r = this.palmRadius();
      const gap = C().PALM_WALL_TOUCH_GAP != null ? C().PALM_WALL_TOUCH_GAP : 0.012;
      _pt.set(x, y, z);
      const hit = Col().getBestWallContact(_pt, r + gap);
      if (!hit) return false;
      if (outNormal) {
        if (hit.normal) outNormal.copy(hit.normal);
        else if (hit.push && hit.push.lengthSq() > 1e-8) outNormal.copy(hit.push).normalize();
        else outNormal.set(0, 0, 1);
      }
      return true;
    },

    /**
     * Keep palm sphere outside walls + above floor. Call after every pose write.
     * This is what stops tunneling / "disappearing" into walls.
     */
    constrainPalmFromSurfaces: function (side) {
      const phys = window.DriftPhys;
      if (!phys?.ready) return;
      const p = phys.getPalmPosition(side);
      if (!p) return;
      const r = this.palmRadius();
      _pt.set(p.x, p.y, p.z);
      let changed = false;

      if (Col()) {
        // Push out of walls (may need a couple passes for corners)
        for (let i = 0; i < 3; i++) {
          if (!Col().enforceSphereOutsideWalls(_pt, r, 0.12)) break;
          changed = true;
        }
      }

      const fy = phys.sampleFloorY(_pt.x, _pt.y + 0.5, _pt.z);
      if (fy != null) {
        const minY = fy + r;
        if (_pt.y < minY) {
          _pt.y = minY;
          changed = true;
        }
      }

      if (changed) {
        phys.setPalmTransform(side, _pt.x, _pt.y, _pt.z);
        const v = phys.getPalmVelocity(side);
        // Kill velocity into the nearest wall if we just got pushed out
        if (Col()) {
          const hit = Col().getBestWallContact(_pt, r + 0.02);
          if (hit && hit.push && hit.push.lengthSq() > 1e-8) {
            _n.copy(hit.push).normalize();
            const vn = v.x * _n.x + v.y * _n.y + v.z * _n.z;
            if (vn < 0) {
              phys.setPalmVelocity(side, v.x - _n.x * vn, v.y - _n.y * vn, v.z - _n.z * vn);
            }
          } else if (v.y < 0 && fy != null && _pt.y <= fy + r + 0.001) {
            phys.setPalmVelocity(side, v.x, 0, v.z);
          }
        }
      }
    },

    separatePalmFromGameBall: function (side) {
      const phys = window.DriftPhys;
      if (!phys?.gameBallBody) return false;
      const pp = phys.getPalmPosition(side);
      const gp = phys.getGameBallPosition();
      if (!pp || !gp) return false;
      const pr = this.palmRadius();
      const gr = this.gameBallRadius();
      const minD = pr + gr;
      let dx = gp.x - pp.x;
      let dy = gp.y - pp.y;
      let dz = gp.z - pp.z;
      let dist = Math.hypot(dx, dy, dz);
      if (dist >= minD - 1e-5) return false;
      if (dist < 1e-5) {
        dx = 0;
        dy = 1;
        dz = 0;
        dist = 1;
      }
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;
      const push = minD - dist + 0.002;
      phys.setGameBallPosition(gp.x + nx * push, gp.y + ny * push, gp.z + nz * push);

      const pv = phys.getPalmVelocity(side);
      const bv = phys.getGameBallVelocity();
      const closing =
        (bv.x - pv.x) * -nx + (bv.y - pv.y) * -ny + (bv.z - pv.z) * -nz;
      let vx = bv.x;
      let vy = bv.y;
      let vz = bv.z;
      if (closing > 0) {
        vx += nx * closing;
        vy += ny * closing;
        vz += nz * closing;
      }
      const along = pv.x * nx + pv.y * ny + pv.z * nz;
      if (along > 0) {
        const boost = along * 0.85;
        vx += nx * boost;
        vy += ny * boost;
        vz += nz * boost;
      }
      phys.setGameBallVelocity(vx, vy, vz);
      this._game[side] = true;
      this._wasGame[side] = true;
      return true;
    },

    hadFloorContact: function (side) {
      return !!this._wasFloor[side];
    },

    hadWallContact: function (side) {
      return !!this._wasWall[side];
    },

    hadGameContact: function (side) {
      return !!this._wasGame[side];
    },

    /** Floor or wall plant (ball on a solid surface). */
    hadSurfaceContact: function (side) {
      return !!this._wasFloor[side] || !!this._wasWall[side];
    },

    getStaticContactNormal: function (side, out) {
      out = out || new THREE.Vector3();
      out.copy(this._normal[side]);
      return out.lengthSq() > 1e-8;
    },

    getPalmWorldPosition: function (side, out) {
      out = out || new THREE.Vector3();
      const phys = window.DriftPhys;
      const p = phys && phys.getPalmPosition(side);
      if (!p) return null;
      out.set(p.x, p.y, p.z);
      return out;
    },

    /** Soft chase toward hand while staying outside the contact normal. */
    chaseAlongSurface: function (side, pose, gain, chaseMax) {
      const phys = window.DriftPhys;
      const pp = phys.getPalmPosition(side);
      if (!pp) return;
      _n.copy(this._normal[side]);
      if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
      else _n.normalize();

      const vx = pose.vx || 0;
      const vy = pose.vy || 0;
      const vz = pose.vz || 0;
      _err.set(pose.x - pp.x, pose.y - pp.y, pose.z - pp.z);
      const en = _err.dot(_n);
      _err.addScaledVector(_n, -en);

      _v.set(vx + _err.x * gain, vy + _err.y * gain, vz + _err.z * gain);
      const vn = _v.dot(_n);
      if (vn < 0) _v.addScaledVector(_n, -vn);

      const cs = _v.length();
      const hs = Math.hypot(vx, vy, vz);
      const cap = Math.max(chaseMax, hs + 0.4);
      if (cs > cap && cs > 1e-6) _v.multiplyScalar(cap / cs);
      phys.setPalmVelocity(side, _v.x, _v.y, _v.z);
    },

    sync: function (dt, getHandPose) {
      const phys = window.DriftPhys;
      if (!phys?.ready || !this._ready) return;
      const inclineNy =
        C().PALM_FLOOR_SKATE_INCLINE_NY != null ? C().PALM_FLOOR_SKATE_INCLINE_NY : 0.92;
      const chase = C().PALM_HAND_CHASE_GAIN != null ? C().PALM_HAND_CHASE_GAIN : 4.5;
      const ballChase =
        C().PALM_GAME_BALL_CHASE_GAIN != null ? C().PALM_GAME_BALL_CHASE_GAIN : 22;
      const chaseMax = C().PALM_CHASE_MAX_SPEED != null ? C().PALM_CHASE_MAX_SPEED : 2.2;

      ['left', 'right'].forEach((side) => {
        const pose = getHandPose(side);
        if (!pose) return;

        // Detect wall BEFORE snapping — geometric, so we never teleport through
        const wallProbe = this.palmNearWall(pose.x, pose.y, pose.z, _n);
        if (wallProbe) {
          this._normal[side].copy(_n);
          this._wasWall[side] = true;
          this._wall[side] = true;
        }

        const sn = this._normal[side];
        const floorPlant = this._wasFloor[side] && sn.y >= inclineNy;
        const wallPlant = (this._wasWall[side] || wallProbe) && !floorPlant;
        const nearBall =
          this._wasGame[side] || this.palmNearGameBall(pose.x, pose.y, pose.z);

        if (!floorPlant && !wallPlant && !nearBall) {
          phys.setPalmTransform(side, pose.x, pose.y, pose.z);
          phys.setPalmVelocity(side, pose.vx || 0, pose.vy || 0, pose.vz || 0, {
            clearAngular: true
          });
          this.constrainPalmFromSurfaces(side);
          return;
        }

        if (nearBall && !floorPlant && !wallPlant) {
          const pp = phys.getPalmPosition(side);
          if (!pp) return;
          _err.set(pose.x - pp.x, pose.y - pp.y, pose.z - pp.z);
          _v.set(
            (pose.vx || 0) + _err.x * ballChase,
            (pose.vy || 0) + _err.y * ballChase,
            (pose.vz || 0) + _err.z * ballChase
          );
          const cs = _v.length();
          const hs = Math.hypot(pose.vx || 0, pose.vy || 0, pose.vz || 0);
          const cap = Math.max(chaseMax + 1.5, hs + 1.0);
          if (cs > cap && cs > 1e-6) _v.multiplyScalar(cap / cs);
          phys.setPalmVelocity(side, _v.x, _v.y, _v.z);
          this.separatePalmFromGameBall(side);
          this.constrainPalmFromSurfaces(side);
          return;
        }

        // Floor or wall plant — roll on surface, never slam through
        this.chaseAlongSurface(side, pose, chase, chaseMax);
        this.constrainPalmFromSurfaces(side);
        if (nearBall) this.separatePalmFromGameBall(side);
      });
    },

    finishPhysicsStep: function () {
      const phys = window.DriftPhys;
      if (!phys?.ready || !this._ready) return;
      const r = this.palmRadius();
      const plantGap =
        C().PALM_STATIC_FLOOR_GAP != null ? C().PALM_STATIC_FLOOR_GAP : 0.028;
      const inclineNy =
        C().PALM_FLOOR_SKATE_INCLINE_NY != null ? C().PALM_FLOOR_SKATE_INCLINE_NY : 0.92;

      ['left', 'right'].forEach((side) => {
        this.constrainPalmFromSurfaces(side);
        const c = phys.readPalmContacts(side);
        const p = phys.getPalmPosition(side);
        let nearFloor = !!c.floor;
        if (!nearFloor && p) {
          const fy = phys.sampleFloorY(p.x, p.y + 0.5, p.z);
          if (fy != null && p.y - fy <= r + plantGap) nearFloor = true;
        }
        let nearWall = !!c.wall && !nearFloor;
        if (!nearWall && p && this.palmNearWall(p.x, p.y, p.z, _n)) {
          nearWall = true;
          if (!nearFloor) this._normal[side].copy(_n);
        }
        let nearGame = !!c.gameBall;
        if (!nearGame && p) nearGame = this.palmNearGameBall(p.x, p.y, p.z);

        this._floor[side] = nearFloor;
        this._wall[side] = nearWall;
        this._game[side] = nearGame;
        this._wasFloor[side] = nearFloor;
        this._wasWall[side] = nearWall;
        this._wasGame[side] = nearGame;

        if (c.floor || (c.wall && c.normal)) {
          this._normal[side].set(c.normal.x, c.normal.y, c.normal.z);
          if (this._normal[side].lengthSq() > 1e-8) this._normal[side].normalize();
        } else if (nearFloor) {
          this._normal[side].set(0, 1, 0);
        }
        // Floor wins over wall when both claim contact
        if (nearFloor && this._normal[side].y >= inclineNy) {
          this._wall[side] = false;
          this._wasWall[side] = false;
        }
        if (nearGame) this.separatePalmFromGameBall(side);
      });
    },

    offsetPalms: function () {},

    syncDebugMeshes: function () {
      const phys = window.DriftPhys;
      if (!phys?.ready || !this._ready) return;
      this.ensureDebug();
      ['left', 'right'].forEach((side) => {
        const p = phys.getPalmPosition(side);
        const rot = phys.getPalmRotation(side);
        if (p && this._debug[side]) {
          this._debug[side].object3D.position.set(p.x, p.y, p.z);
          this._debug[side].object3D.visible = true;
          const mesh = this._debug[side].getObject3D('mesh');
          if (mesh) mesh.visible = C().SHOW_PALM_SPHERE_DEBUG !== false;
          if (rot && rot.v) {
            this._debug[side].object3D.quaternion.set(rot.v.x, rot.v.y, rot.v.z, rot.s);
          }
        }
      });
    },

    snapPalmsToHands: function (getHandPose) {
      const phys = window.DriftPhys;
      if (!phys?.ready || !this._ready) return;
      const inclineNy =
        C().PALM_FLOOR_SKATE_INCLINE_NY != null ? C().PALM_FLOOR_SKATE_INCLINE_NY : 0.92;
      const chase = C().PALM_HAND_CHASE_GAIN != null ? C().PALM_HAND_CHASE_GAIN : 4.5;
      const chaseMax = C().PALM_CHASE_MAX_SPEED != null ? C().PALM_CHASE_MAX_SPEED : 2.2;

      ['left', 'right'].forEach((side) => {
        const pose = getHandPose(side);
        if (!pose) return;
        const wallProbe = this.palmNearWall(pose.x, pose.y, pose.z, _n);
        if (wallProbe) {
          this._normal[side].copy(_n);
          this._wasWall[side] = true;
        }
        const planted = this._wasFloor[side] && this._normal[side].y >= inclineNy;
        const wallPlant = (this._wasWall[side] || wallProbe) && !planted;
        const nearBall =
          this._wasGame[side] || this.palmNearGameBall(pose.x, pose.y, pose.z);

        if (planted || wallPlant) {
          this.chaseAlongSurface(side, pose, chase, chaseMax);
          this.constrainPalmFromSurfaces(side);
          if (nearBall) this.separatePalmFromGameBall(side);
          return;
        }
        if (nearBall) {
          this.constrainPalmFromSurfaces(side);
          this.separatePalmFromGameBall(side);
          return;
        }
        phys.setPalmTransform(side, pose.x, pose.y, pose.z);
        phys.setPalmVelocity(side, pose.vx || 0, pose.vy || 0, pose.vz || 0, {
          clearAngular: true
        });
        this.constrainPalmFromSurfaces(side);
      });
    },

    driveGameBallFromPalms: function (dt) {
      const phys = window.DriftPhys;
      if (!phys?.gameBallBody || !this._ready || !dt) return;

      ['left', 'right'].forEach((side) => this.separatePalmFromGameBall(side));

      const blendK =
        C().PALM_GAME_BALL_VELOCITY_BLEND != null ? C().PALM_GAME_BALL_VELOCITY_BLEND : 22;
      const maxDv = C().PALM_GAME_BALL_MAX_DV != null ? C().PALM_GAME_BALL_MAX_DV : 2.8;
      const alpha = 1 - Math.exp(-blendK * dt);
      if (alpha < 1e-6) return;

      const gb = phys.getGameBallVelocity();
      let dvx = 0;
      let dvy = 0;
      let dvz = 0;
      let nContact = 0;

      ['left', 'right'].forEach((side) => {
        if (!this._wasGame[side] && !this._game[side]) return;
        const pv = phys.getPalmVelocity(side);
        dvx += (pv.x - gb.x) * alpha;
        dvy += (pv.y - gb.y) * alpha;
        dvz += (pv.z - gb.z) * alpha;
        nContact++;
      });
      if (nContact < 1) return;
      dvx /= nContact;
      dvy /= nContact;
      dvz /= nContact;
      const dLen = Math.hypot(dvx, dvy, dvz);
      if (dLen > maxDv && dLen > 1e-8) {
        const s = maxDv / dLen;
        dvx *= s;
        dvy *= s;
        dvz *= s;
      }
      phys.setGameBallVelocity(gb.x + dvx, gb.y + dvy, gb.z + dvz);
    },

    driveGameBallFromBody: function (dt) {
      const phys = window.DriftPhys;
      if (!phys?.gameBallBody || !phys.playerBody || !dt) return;
      const gp = phys.getGameBallPosition();
      const pp = phys.getPlayerPosition();
      if (!gp || !pp) return;

      const carryR =
        C().BODY_BALL_CARRY_RADIUS != null
          ? C().BODY_BALL_CARRY_RADIUS
          : C().BODY_BALL_RADIUS != null
            ? C().BODY_BALL_RADIUS
            : 0.24;
      const gr = C().GAME_BALL_RADIUS != null ? C().GAME_BALL_RADIUS : 0.25;
      let dx = gp.x - pp.x;
      let dy = gp.y - pp.y;
      let dz = gp.z - pp.z;
      let dist = Math.hypot(dx, dy, dz);
      if (dist < 1e-5) {
        dx = 0;
        dy = 0;
        dz = 1;
        dist = 1;
      }
      const minD = carryR + gr;
      const gap = dist - minD;
      if (gap > 0.12) return;

      let nx = dx / dist;
      let ny = dy / dist;
      let nz = dz / dist;

      if (gap < 0) {
        const fix = -gap;
        phys.setGameBallPosition(gp.x + nx * fix, gp.y + ny * fix, gp.z + nz * fix);
      }

      const pv = phys.getPlayerVelocity();
      const bv = phys.getGameBallVelocity();
      const blend = C().BODY_BALL_CARRY_BLEND != null ? C().BODY_BALL_CARRY_BLEND : 10;
      const pushK = C().BODY_BALL_CARRY_PUSH != null ? C().BODY_BALL_CARRY_PUSH : 1;
      const t = Math.min(1, blend * dt);
      let vx = bv.x + (pv.x - bv.x) * t;
      let vy = bv.y + (pv.y - bv.y) * t;
      let vz = bv.z + (pv.z - bv.z) * t;

      const closing = (pv.x - bv.x) * nx + (pv.y - bv.y) * ny + (pv.z - bv.z) * nz;
      if (closing > 0.05 && gap < 0.04) {
        vx += nx * closing * pushK;
        vy += ny * closing * pushK * 0.35;
        vz += nz * closing * pushK;
      }

      const intoPlayer = vx * -nx + vy * -ny + vz * -nz;
      if (intoPlayer > 0) {
        vx += nx * intoPlayer;
        vy += ny * intoPlayer;
        vz += nz * intoPlayer;
      }

      phys.setGameBallVelocity(vx, vy, vz);
    }
  };
})();
