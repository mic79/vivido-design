/**
 * Shoot the grabbable ragdoll dummy.
 * Desktop: left mousedown on the 3D view (center-screen ray through THREE camera).
 * VR: right trigger — aim from virtual hand; preview = physics ray (floor/walls) +
 * cheap dummy capsules; full mesh raycast only when firing.
 */
(function () {
  'use strict';

  const THREE = (window.AFRAME && window.AFRAME.THREE) || window.THREE;
  const MAX_RANGE = 48;
  const SHOT_STRENGTH = 1;
  const FLASH_MS = 280;

  AFRAME.registerComponent('ragdoll-shooter', {
    schema: {
      desktopKey: { type: 'string', default: 'KeyH' }
    },

    init: function () {
      this.cameraEl = document.querySelector('#camera');
      this.rightHand = document.querySelector('#right-hand');
      this.localBodyEl = document.querySelector('#local-body');
      this.dummyEl = document.querySelector('#grab-dummy');
      this._rayOri = new THREE.Vector3();
      this._rayDir = new THREE.Vector3();
      this._handAim = { origin: new THREE.Vector3(), direction: new THREE.Vector3() };
      this._aimEnd = new THREE.Vector3();
      this._envHitPoint = new THREE.Vector3();
      this._envHitNormal = new THREE.Vector3();
      this._ndcCenter = new THREE.Vector2(0, 0);
      this._raycaster = new THREE.Raycaster();
      this._flashUntil = 0;
      this._flashGroup = null;
      this._triggerWas = false;
      this._shootQueued = false;
      this._keyShootWas = false;
      this._crosshair = document.getElementById('aim-crosshair');
      this._aimLine = null;
      this._vrAimFrame = -1;
      this._vrAimReady = false;
      this._vrAimPreview = null;
      this._fireQueued = false;

      this._onMouseDown = (e) => {
        if (e.button !== 0) return;
        if (this.el.is('vr-mode')) return;
        if (!this._isViewportEvent(e)) return;
        this._shootQueued = true;
      };

      window.addEventListener('mousedown', this._onMouseDown, true);
    },

    remove: function () {
      window.removeEventListener('mousedown', this._onMouseDown, true);
      this._removeFlash();
      this._removeAimLine();
      this._setRightLaserVisible(true);
    },

    _isViewportEvent: function (e) {
      const t = e.target;
      if (t && (t.closest('#ui') || t.closest('#height-cal') || t.closest('#vr-height-panel'))) {
        return false;
      }
      const canvas = this.el.canvas;
      if (!canvas) return true;
      if (document.pointerLockElement === canvas) return true;
      if (t === canvas) return true;
      if (t && t.closest && t.closest('.a-canvas')) return true;
      return false;
    },

    _getDummyComp: function () {
      return this.dummyEl?.components?.['grabbable-ragdoll'] || null;
    },

    _getMixamoBody: function () {
      return this.localBodyEl?.components?.['mixamo-body'] || null;
    },

    _getCollisionQueries: function () {
      return this.el.sceneEl?.legIkWorld?.queries || null;
    },

    _getRightTrigger: function () {
      const session = this.el.renderer?.xr?.getSession?.();
      if (session?.inputSources) {
        for (let i = 0; i < session.inputSources.length; i++) {
          const src = session.inputSources[i];
          if (src.handedness === 'right' && src.gamepad?.buttons?.[0]) {
            return src.gamepad.buttons[0];
          }
        }
      }
      const tc = this.rightHand?.components?.['tracked-controls'];
      return tc?.controller?.gamepad?.buttons?.[0] || null;
    },

    _setRightLaserVisible: function (visible) {
      const lc = this.rightHand?.components?.['laser-controls'];
      if (!lc) return;
      if (lc.rayEl?.object3D) lc.rayEl.object3D.visible = visible;
      if (lc.cursorEl?.object3D) lc.cursorEl.object3D.visible = visible;
    },

    _aimFromCamera: function () {
      const camEl = this.cameraEl;
      if (!camEl) return false;

      const threeCam = camEl.components.camera && camEl.components.camera.camera;
      if (!threeCam) {
        camEl.object3D.updateMatrixWorld(true);
        this._rayOri.setFromMatrixPosition(camEl.object3D.matrixWorld);
        camEl.object3D.getWorldDirection(this._rayDir).normalize();
        return true;
      }

      camEl.object3D.updateMatrixWorld(true);
      threeCam.updateMatrixWorld(true);
      this._raycaster.setFromCamera(this._ndcCenter, threeCam);
      this._rayOri.copy(this._raycaster.ray.origin);
      this._rayDir.copy(this._raycaster.ray.direction).normalize();
      return true;
    },

    _aimFromRightController: function () {
      if (!this.rightHand) return false;
      const obj = this.rightHand.object3D;
      obj.updateMatrixWorld(true);
      this._rayOri.setFromMatrixPosition(obj.matrixWorld);
      this._rayDir.set(0, 0, -1).applyQuaternion(obj.quaternion).normalize();
      return true;
    },

    _aimFromVirtualHand: function () {
      const body = this._getMixamoBody();
      if (!body?.getHandShotAim) return false;
      const aim = body.getHandShotAim('right', this._handAim);
      if (!aim.ok) return false;
      this._rayOri.copy(aim.origin);
      this._rayDir.copy(aim.direction).normalize();
      return true;
    },

    _aimForVr: function () {
      if (this._aimFromVirtualHand()) return true;
      return this._aimFromRightController();
    },

    /** Box3D environment ray — floor, walls, blocks (cheap WASM, not skinned mesh). */
    _raycastEnvironment: function (origin, direction, maxDist) {
      const queries = this._getCollisionQueries();
      if (!queries?.castRay) return null;

      const hit = queries.castRay(
        { x: origin.x, y: origin.y, z: origin.z },
        { x: direction.x, y: direction.y, z: direction.z },
        maxDist
      );
      if (!hit?.point) return null;

      const n = hit.normal || { x: 0, y: 1, z: 0 };
      const point = this._envHitPoint.set(hit.point.x, hit.point.y, hit.point.z);
      const normal = this._envHitNormal.set(n.x, n.y, n.z);
      const distance = hit.timeOfImpact != null
        ? hit.timeOfImpact
        : origin.distanceTo(point);

      return {
        point,
        normal,
        distance,
        environment: true
      };
    },

    _pickClosestAimHit: function (candidates) {
      let best = null;
      let bestDist = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        const h = candidates[i];
        if (!h) continue;
        const d = h.distance != null ? h.distance : this._rayOri.distanceTo(h.point);
        if (d < bestDist) {
          bestDist = d;
          best = h;
        }
      }
      return best;
    },

    /** Once per frame (tock): hand aim + env physics ray + dummy bone capsules. */
    _refreshVrAimPreview: function () {
      const frame = this.el.sceneEl?.time;
      if (frame != null && frame === this._vrAimFrame) return this._vrAimReady;

      this._vrAimFrame = frame != null ? frame : this._vrAimFrame + 1;
      this._vrAimReady = this._aimForVr();
      this._vrAimPreview = null;

      if (this._vrAimReady) {
        const candidates = [];
        const envHit = this._raycastEnvironment(this._rayOri, this._rayDir, MAX_RANGE);
        if (envHit) candidates.push(envHit);

        const comp = this._getDummyComp();
        if (comp?.raycastAimPreview) {
          const dummyHit = comp.raycastAimPreview(this._rayOri, this._rayDir, MAX_RANGE);
          if (dummyHit) candidates.push(dummyHit);
        }

        this._vrAimPreview = this._pickClosestAimHit(candidates);
      }

      return this._vrAimReady;
    },

    _raycastDummy: function (comp) {
      if (!comp?.raycastFromShot) return null;
      return comp.raycastFromShot(this._rayOri, this._rayDir, MAX_RANGE);
    },

    _spawnFlash: function (from, to, hit) {
      const sceneObj = this.el.object3D;
      this._removeFlash();

      const group = new THREE.Group();
      group.frustumCulled = false;
      group.renderOrder = 9999;

      const delta = new THREE.Vector3().subVectors(to, from);
      const len = delta.length();
      if (len > 0.02) {
        const mid = from.clone().add(to).multiplyScalar(0.5);
        const dir = delta.clone().normalize();
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(0.022, 0.012, len, 6),
          new THREE.MeshBasicMaterial({
            color: hit ? 0xff5533 : 0xffdd44,
            transparent: true,
            opacity: 1,
            depthTest: false,
            depthWrite: false,
            toneMapped: false
          })
        );
        beam.frustumCulled = false;
        beam.renderOrder = 9999;
        beam.position.copy(mid);
        const up = new THREE.Vector3(0, 1, 0);
        if (Math.abs(dir.dot(up)) > 0.999) {
          beam.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
        } else {
          beam.quaternion.setFromUnitVectors(up, dir);
        }
        group.add(beam);
      }

      sceneObj.add(group);
      this._flashGroup = group;
      this._flashUntil = performance.now() + FLASH_MS;
    },

    _removeFlash: function () {
      if (!this._flashGroup) return;
      this.el.object3D.remove(this._flashGroup);
      this._flashGroup.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
        if (node.material) node.material.dispose();
      });
      this._flashGroup = null;
    },

    _ensureAimLine: function () {
      if (this._aimLine) return;

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(6, 3));

      const mat = new THREE.LineBasicMaterial({
        color: 0xff6644,
        transparent: true,
        opacity: 0.72,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      });

      this._aimLine = new THREE.Line(geo, mat);
      this._aimLine.frustumCulled = false;
      this._aimLine.renderOrder = 8000;
      this._aimLine.visible = false;
      this.el.object3D.add(this._aimLine);
    },

    _updateAimLine: function (from, to, onDummy) {
      this._ensureAimLine();
      const pos = this._aimLine.geometry.attributes.position;
      pos.setXYZ(0, from.x, from.y, from.z);
      pos.setXYZ(1, to.x, to.y, to.z);
      pos.needsUpdate = true;
      this._aimLine.material.opacity = onDummy ? 0.88 : 0.62;
      this._aimLine.material.color.setHex(onDummy ? 0xff4422 : 0xff8866);
      this._aimLine.visible = true;
    },

    _removeAimLine: function () {
      if (!this._aimLine) return;
      this.el.object3D.remove(this._aimLine);
      this._aimLine.geometry?.dispose();
      this._aimLine.material?.dispose();
      this._aimLine = null;
    },

    _updateVrAimPreview: function () {
      if (!this._refreshVrAimPreview()) {
        if (this._aimLine) this._aimLine.visible = false;
        return;
      }

      const hit = this._vrAimPreview;
      const end = this._aimEnd;
      if (hit) {
        end.copy(hit.point);
      } else {
        end.copy(this._rayOri).addScaledVector(this._rayDir, MAX_RANGE);
      }

      this._updateAimLine(this._rayOri, end, !!(hit && !hit.environment));
    },

    /**
     * Register damage from the skinned-mesh ray. Capsule preview is aim-assist only —
     * using it for hits made chest shots land on the oversized head/neck capsules.
     */
    _resolveShotHit: function (comp, fromVrHand) {
      if (comp?.raycastFromShot) {
        const meshHit = comp.raycastFromShot(this._rayOri, this._rayDir, MAX_RANGE);
        if (meshHit) return meshHit;
      }

      // Fallback when the mesh is thin/misses but the aim line was clearly on the dummy.
      const preview = fromVrHand ? this._vrAimPreview : null;
      if (fromVrHand) {
        if (!preview || preview.environment || !preview.point) return null;
        return {
          point: preview.point.clone ? preview.point.clone() : preview.point,
          normal: preview.normal?.clone
            ? preview.normal.clone()
            : this._rayDir.clone().negate(),
          distance: preview.distance,
          regionId: preview.regionId || null
        };
      }
      if (comp?.raycastAimPreview) {
        return comp.raycastAimPreview(this._rayOri, this._rayDir, MAX_RANGE);
      }
      return null;
    },

    _fireShot: function (fromVrHand) {
      if (fromVrHand) {
        if (!this._refreshVrAimPreview()) return;
      } else if (!this._aimFromCamera()) {
        return;
      }

      const comp = this._getDummyComp();
      const hit = this._resolveShotHit(comp, fromVrHand);
      const preview = fromVrHand ? this._vrAimPreview : null;
      const end = hit
        ? hit.point
        : (preview?.point
          ? (preview.point.clone ? preview.point.clone() : preview.point)
          : this._rayOri.clone().addScaledVector(this._rayDir, MAX_RANGE));

      this._spawnFlash(this._rayOri, end, !!(hit || preview));
      if (!comp || !hit) return;
      if (!window.RagdollShatter?.fracture) return;
      comp.shatterFromShot(hit.point, hit.normal, this._rayDir, SHOT_STRENGTH, hit.regionId);
    },

    tick: function () {
      const vr = this.el.is('vr-mode');
      if (this._crosshair) {
        this._crosshair.classList.toggle('hidden', vr);
      }

      if (this._flashGroup && performance.now() > this._flashUntil) {
        this._removeFlash();
      }

      if (!vr) {
        this._setRightLaserVisible(true);
        if (this._aimLine) this._aimLine.visible = false;

        if (this._shootQueued) {
          this._shootQueued = false;
          this._fireShot(false);
        }

        const keys = window._bodyRiggedKeys || {};
        const keyCode = this.data.desktopKey || 'KeyH';
        const keyDown = !!keys[keyCode];
        if (keyDown && !this._keyShootWas) {
          this._fireShot(false);
        }
        this._keyShootWas = keyDown;
        return;
      }

      this._setRightLaserVisible(false);

      const trig = this._getRightTrigger();
      const pressed = !!(trig && (trig.pressed || trig.value > 0.55));
      const fire = pressed && !this._triggerWas;
      this._triggerWas = pressed;
      if (fire) this._fireQueued = true;
    },

    tock: function () {
      if (!this.el.is('vr-mode')) return;

      this._updateVrAimPreview();

      if (this._fireQueued) {
        this._fireQueued = false;
        this._fireShot(true);
      }
    }
  });
})();
