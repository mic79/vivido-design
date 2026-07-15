/**
 * CapVR lean Box3D physics host.
 * Replaces body-rigged4 leg-ik-world for this zero-g game:
 * init + expose queries + hand surface clamp — no crouch IK / ground locomotion.
 */
(function () {
  'use strict';

  if (typeof AFRAME === 'undefined') return;

  const THREE = (window.AFRAME && window.AFRAME.THREE) || window.THREE;

  AFRAME.registerComponent('capvr-physics', {
    init: function () {
      this.ready = false;
      this.physics = null;
      this.b3 = null;
      this.world = null;
      this.queries = null;
      this.handCollisionRadius = 0.026;
      this._handPalmDebugLeft = null;
      this._handPalmDebugRight = null;
      this._initPhysics();
    },

    _initPhysics: async function () {
      try {
        if (!window.Box3DPhysicsWorld) {
          setTimeout(() => this._initPhysics(), 50);
          return;
        }
        const physics = new window.Box3DPhysicsWorld();
        await physics.init({
          gravity: { x: 0, y: 0, z: 0 },
          skipDemoColliders: true
        });
        this.physics = physics;
        this.b3 = physics.b3;
        this.world = physics.world;
        this.queries = physics.queries;
        this.ready = true;

        // Minimal stub so leftover body-foundation reads don't null-crash.
        // CapVR never runs MixamoLegIK (see body-foundation _initLegIK guard).
        const scene = this.el;
        const playerShapeIds = physics.playerShapeIds || [];
        let terrain = null;
        try {
          if (window.Box3DTerrainQuery) {
            terrain = new window.Box3DTerrainQuery({
              queries: this.queries,
              groundY: -10
            });
          }
        } catch (e) { /* */ }

        scene.legIkWorld = {
          ready: true,
          ragdollActive: false,
          queries: this.queries,
          playerShapeIds,
          terrain,
          // Expose physics so older code paths that read legIkWorld.physics still work
          physics,
          playerRootPos: new THREE.Vector3(0, 0, 0),
          isPlayerGrounded: false,
          playerSpeed: 0,
          playerMoveDir: new THREE.Vector3(),
          crouchAmount: 0,
          mantleCrouchAmount: 0,
          standingEyeLocalY: 1.6,
          configuredStandingEyeY: 1.6,
          maxCrouchAmount: 0,
          cameraFloorOffsetM: 0,
          bodyForwardOffsetM: 0,
          bodyLateralOffsetM: 0,
          modelVerticalScale: 1,
          ankleToSoleM: 0.08
        };

        this.playerShapeIds = playerShapeIds;

        console.log('[CapVR] lean Box3D physics ready (hand surface clamp ON)');
        this.el.emit('capvr-physics-ready', { physics });
      } catch (e) {
        console.error('[CapVR] physics init failed', e);
      }
    },

    /**
     * body-rigged4 palm clamp — ONLY Box3D slideHandSphere against ENV statics.
     * Do not layer CapVR AABB/OBB push: that path only "helps" axis boxes, ignores
     * octa/tetra mesh faces, and teleports palms on flat surfaces.
     */
    clampHandPalmAlongTracking: function (lastValid, desired, dest, hand, trackingPos, options) {
      options = options || {};
      const debugKey = hand === 'left' ? '_handPalmDebugLeft' : '_handPalmDebugRight';
      const track = trackingPos || desired;
      const emptyDebug = {
        hit: false,
        sticky: null,
        contactPoint: null,
        normal: new THREE.Vector3(0, 1, 0),
        shapeId: null,
        controller: track.clone ? track.clone() : new THREE.Vector3(track.x, track.y, track.z),
        contactDistance: 0
      };

      if (!this.ready || !this.physics || !this.physics.queries || !this.physics.slideHandSphere) {
        dest.copy(desired);
        this[debugKey] = emptyDebug;
        return false;
      }

      const radius = this.handCollisionRadius || 0.05;
      const resetDist = 0.5;

      // If the tracked hand jumped far (teleport / respawn), drop the history so
      // we don't try to slide across the whole scene in one frame.
      if (lastValid && lastValid.distanceTo(desired) > resetDist) {
        lastValid = null;
      }

      // lastTrack should be prior controller/palm tracking, not lastValid — that
      // keeps depenetration biased toward the real hand approach.
      const lastTrack = options.lastTrack || track;
      const slide = this.physics.slideHandSphere(
        lastValid,
        lastTrack,
        desired,
        radius,
        track,
        {
          preferToward: options.preferToward || null
        }
      );
      dest.copy(slide.position);

      const n = slide.normal ? slide.normal.clone() : new THREE.Vector3(0, 1, 0);
      if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
      else n.normalize();

      const blocked = slide.hit || dest.distanceTo(desired) > 1e-4;
      this[debugKey] = {
        hit: blocked,
        sticky: slide.position.clone(),
        contactPoint: slide.contactPoint
          ? slide.contactPoint.clone()
          : slide.position.clone().addScaledVector(n, -radius),
        normal: n,
        shapeId: slide.shapeId != null ? slide.shapeId : null,
        controller: track.clone ? track.clone() : new THREE.Vector3(track.x, track.y, track.z),
        contactDistance: blocked ? slide.position.distanceTo(track) : 0
      };
      return blocked;
    },

    clampHandWorldPos: function (src, dest) {
      if (!this.physics?.resolveSphere) {
        dest.copy(src);
        return false;
      }
      const result = this.physics.resolveSphere(src, this.handCollisionRadius || 0.05);
      dest.copy(result.position);
      return !!result.hit;
    },

    /**
     * Single Box3D step per frame + body sync. Cannon shim does not step.
     */
    tick: function (time, deltaTime) {
      if (!this.ready || !this.physics?.stepWorld) return;
      const phys = this.physics;
      const dt = Math.min((deltaTime || 16.6) / 1000, 0.05);
      const cw = window.CapVRCannonWorld;
      if (cw?.syncBodiesToB3) cw.syncBodiesToB3(phys);
      else if (cw?.bodies) {
        cw.bodies.forEach((b) => {
          if (!b._b3Body) b._ensureB3?.(phys);
          if (b.mass > 0 && b._b3Body) b._syncToB3?.(phys);
        });
      }
      phys.stepWorld(dt);
      if (cw?.syncBodiesFromB3) cw.syncBodiesFromB3(phys);
      else if (cw?.bodies) {
        cw.bodies.forEach((b) => {
          if (b.mass > 0 && b._b3Body) b._syncFromB3?.(phys);
        });
      }
      cw?._emitProximityCollides?.();
    }
  });

  if (window.CapVRPhysics) {
    const prev = window.CapVRPhysics;
    window.CapVRPhysics.get = function () {
      const scene = document.querySelector('a-scene');
      return scene?.components?.['capvr-physics']?.physics
        || scene?.components?.['leg-ik-world']?.physics
        || null;
    };
    window.CapVRPhysics.ready = prev.ready?.bind(prev) || function (cb) {
      const tryIt = () => {
        const p = window.CapVRPhysics.get();
        if (p?.world && p.b3) return cb(p);
        setTimeout(tryIt, 50);
      };
      tryIt();
    };
    window.CapVRPhysics.host = prev.host?.bind(prev) || function () {
      return document.querySelector('a-scene')?.components?.['capvr-physics'] || null;
    };
    window.CapVRPhysics.rebuildArenaStatics = prev.rebuildArenaStatics?.bind(prev)
      || function () { return 0; };
  }

  function scheduleArenaRebuild(reason) {
    const go = () => {
      const n = window.CapVRPhysics?.rebuildArenaStatics?.() || 0;
      console.log('[CapVR] hand ENV bake (' + reason + '):', n);
      return n;
    };
    // Surfaces may still be attaching Cannon bodies — retry until bake lands.
    setTimeout(() => go(), 100);
    setTimeout(() => go(), 400);
    setTimeout(() => go(), 1200);
    setTimeout(() => go(), 3000);
    setTimeout(() => go(), 6000);
  }

  // Hook after lean physics is up
  document.addEventListener('DOMContentLoaded', () => {
    const scene = document.querySelector('a-scene');
    const attach = () => {
      scene?.addEventListener('capvr-physics-ready', () => scheduleArenaRebuild('physics-ready'), { once: true });
      if (scene?.components?.['capvr-physics']?.ready) scheduleArenaRebuild('already-ready');
    };
    if (scene?.hasLoaded) attach();
    else scene?.addEventListener('loaded', attach, { once: true });
  });
  document.addEventListener('arena-physics-ready', () => scheduleArenaRebuild('arena-ready'));
})();
