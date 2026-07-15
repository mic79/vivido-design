/**
 * CapVR lean Box3D physics host.
 * Replaces body-rigged4 leg-ik-world for this zero-g game:
 * init + expose queries — no crouch IK, no ground locomotion, no double-step tax.
 */
(function () {
  'use strict';

  if (typeof AFRAME === 'undefined') return;

  AFRAME.registerComponent('capvr-physics', {
    init: function () {
      this.ready = false;
      this.physics = null;
      this.b3 = null;
      this.world = null;
      this.queries = null;
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

        // Also mirror keys on this component for direct access
        this.playerShapeIds = playerShapeIds;

        console.log('[CapVR] lean Box3D physics ready (no leg-ik-world)');
        this.el.emit('capvr-physics-ready', { physics });
      } catch (e) {
        console.error('[CapVR] physics init failed', e);
      }
    },

    /**
     * Single Box3D step per frame + body sync. Cannon shim does not step.
     */
    tick: function (time, deltaTime) {
      if (!this.ready || !this.physics?.stepWorld) return;
      const phys = this.physics;
      const dt = Math.min((deltaTime || 16.6) / 1000, 0.05);
      const cw = window.CapVRCannonWorld;
      // Push only if JS moved the body (setBodyPosition skips identical + no wake).
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

  // Prefer capvr-physics; keep leg-ik-world as last-resort fallback for old tabs
  if (window.CapVRPhysics) {
    window.CapVRPhysics.get = function () {
      const scene = document.querySelector('a-scene');
      return scene?.components?.['capvr-physics']?.physics
        || scene?.components?.['leg-ik-world']?.physics
        || null;
    };
  }
})();
