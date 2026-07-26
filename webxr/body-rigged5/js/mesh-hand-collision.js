/**
 * Local posed-mesh hand collision via three-mesh-bvh.
 * Bakes skinned character vertices into a BVH and resolves a palm sphere against
 * nearby surface only. Debug shows the active query sphere + contact, not the
 * full BVH tree.
 */
(function () {
  'use strict';

  function getLib() {
    return window.MeshBVHLib || null;
  }

  function getTHREE() {
    return window.AFRAME?.THREE || window.THREE || null;
  }

  class CharacterMeshCollider {
    constructor(skinnedMeshes, opts) {
      opts = opts || {};
      const THREE = getTHREE();
      const lib = getLib();
      if (!THREE || !lib?.MeshBVH || !lib?.StaticGeometryGenerator) {
        throw new Error('[MeshHandCollision] three-mesh-bvh MeshBVH/StaticGeometryGenerator required');
      }

      this.THREE = THREE;
      this.lib = lib;
      this.skinnedMeshes = (skinnedMeshes || []).filter((m) => m && m.isSkinnedMesh);
      this.queryRadius = opts.queryRadius != null ? opts.queryRadius : 0.32;
      this.skin = 0.0015;

      this._tmp = new THREE.Vector3();
      this._tmp2 = new THREE.Vector3();
      this._tmp3 = new THREE.Vector3();
      this._normal = new THREE.Vector3();
      this._hitPoint = new THREE.Vector3();
      this._hitInfo = { point: this._hitPoint, distance: Infinity, faceIndex: -1 };

      this.generator = new lib.StaticGeometryGenerator(this.skinnedMeshes);
      this.generator.attributes = ['position'];
      if ('applyWorldTransforms' in this.generator) {
        this.generator.applyWorldTransforms = true;
      }
      this.geometry = this.generator.generate();
      this.geometry.boundsTree = new lib.MeshBVH(this.geometry, {
        maxLeafTris: 10,
        verbose: false
      });

      // Invisible carrier for the baked world-space geometry (no full-tree helper).
      this.helperMesh = new THREE.Mesh(this.geometry);
      this.helperMesh.visible = false;
      this.helperMesh.frustumCulled = false;
      this.helperMesh.matrixAutoUpdate = false;
      this.helperMesh.matrix.identity();
      this.helperMesh.matrixWorld.identity();

      this._debugRoot = null;
      this._debugQuerySphere = null;
      this._debugContact = null;
      this._lastBakeMs = 0;
      this._bakeMinIntervalMs = opts.bakeMinIntervalMs != null ? opts.bakeMinIntervalMs : 32;
      this._lastContact = null;
    }

    dispose() {
      this.clearDebug();
      if (this.helperMesh?.parent) this.helperMesh.parent.remove(this.helperMesh);
      if (this.geometry) {
        if (this.geometry.disposeBoundsTree) this.geometry.disposeBoundsTree();
        this.geometry.dispose();
      }
      this.geometry = null;
      this.helperMesh = null;
      this.generator = null;
    }

    ensureParented(sceneRoot) {
      if (!this.helperMesh || !sceneRoot) return;
      if (this.helperMesh.parent !== sceneRoot) sceneRoot.add(this.helperMesh);
    }

    clearDebug() {
      if (!this._debugRoot) return;
      if (this._debugRoot.parent) this._debugRoot.parent.remove(this._debugRoot);
      this._debugRoot.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
      this._debugRoot = null;
      this._debugQuerySphere = null;
      this._debugContact = null;
    }

    /**
     * Show only the active palm query sphere and last contact point — not BVH cubes.
     */
    setActiveDebug(sceneRoot, queryCenter, queryRadius, contact) {
      const THREE = this.THREE;
      if (!sceneRoot) return;

      if (!this._debugRoot) {
        this._debugRoot = new THREE.Group();
        this._debugRoot.name = 'mesh-hand-collision-active-debug';
        this._debugRoot.frustumCulled = false;

        this._debugQuerySphere = new THREE.Mesh(
          new THREE.SphereGeometry(1, 16, 12),
          new THREE.MeshBasicMaterial({
            color: 0x00e5ff,
            wireframe: true,
            transparent: true,
            opacity: 0.85,
            depthTest: false,
            depthWrite: false
          })
        );
        this._debugQuerySphere.renderOrder = 1005;
        this._debugRoot.add(this._debugQuerySphere);

        this._debugContact = new THREE.Mesh(
          new THREE.SphereGeometry(1, 10, 8),
          new THREE.MeshBasicMaterial({
            color: 0xff66aa,
            transparent: true,
            opacity: 0.95,
            depthTest: false,
            depthWrite: false
          })
        );
        this._debugContact.renderOrder = 1006;
        this._debugRoot.add(this._debugContact);
        sceneRoot.add(this._debugRoot);
      }

      this._debugRoot.visible = true;
      if (queryCenter && this._debugQuerySphere) {
        this._debugQuerySphere.visible = true;
        this._debugQuerySphere.position.copy(queryCenter);
        const s = Math.max(0.005, queryRadius || 0.026);
        this._debugQuerySphere.scale.set(s, s, s);
      } else if (this._debugQuerySphere) {
        this._debugQuerySphere.visible = false;
      }

      if (contact && this._debugContact) {
        this._debugContact.visible = true;
        this._debugContact.position.copy(contact);
        this._debugContact.scale.set(0.012, 0.012, 0.012);
      } else if (this._debugContact) {
        this._debugContact.visible = false;
      }
    }

    setDebugVisible(visible) {
      if (!visible) {
        if (this._debugRoot) this._debugRoot.visible = false;
      }
    }

    update(force) {
      if (!this.generator || !this.geometry) return false;
      const now = performance.now();
      if (!force && now - this._lastBakeMs < this._bakeMinIntervalMs) return false;

      for (let i = 0; i < this.skinnedMeshes.length; i++) {
        const m = this.skinnedMeshes[i];
        if (m.skeleton) m.skeleton.update();
        m.updateMatrixWorld(true);
      }

      this.generator.generate(this.geometry);
      if (this.geometry.boundsTree?.refit) {
        this.geometry.boundsTree.refit();
      } else {
        this.geometry.boundsTree = new this.lib.MeshBVH(this.geometry, {
          maxLeafTris: 10,
          verbose: false
        });
      }
      this.helperMesh.matrix.identity();
      this.helperMesh.matrixWorld.identity();
      this._lastBakeMs = now;
      return true;
    }

    _closest(center, maxDist) {
      const bvh = this.geometry?.boundsTree;
      if (!bvh || typeof bvh.closestPointToPoint !== 'function') return null;

      this._hitInfo.point = this._hitPoint;
      this._hitInfo.distance = Infinity;
      this._hitInfo.faceIndex = -1;

      let found = null;
      try {
        found = bvh.closestPointToPoint(center, this._hitInfo, 0, maxDist);
      } catch (e) {
        try {
          found = bvh.closestPointToPoint(center, this._hitInfo);
        } catch (e2) {
          return null;
        }
      }

      if (!found) return null;
      const dist = found.distance != null ? found.distance : this._hitInfo.distance;
      const point = found.point || this._hitInfo.point;
      if (!point || !isFinite(dist) || dist > maxDist) return null;
      return { point, distance: dist, faceIndex: found.faceIndex };
    }

    resolveSphere(center, radius, preferToward) {
      const THREE = this.THREE;
      const maxDist = radius + 0.06;
      const info = this._closest(center, maxDist);
      if (!info || info.distance >= radius - 1e-5) {
        return {
          position: center.clone(),
          hit: false,
          normal: new THREE.Vector3(0, 1, 0),
          contactPoint: center.clone(),
          shapeId: null
        };
      }

      const normal = this._normal;
      normal.copy(center).sub(info.point);
      if (normal.lengthSq() < 1e-10) {
        if (preferToward) normal.copy(preferToward).sub(info.point);
        else normal.set(0, 1, 0);
      }
      if (normal.lengthSq() < 1e-10) normal.set(0, 1, 0);
      else normal.normalize();

      if (preferToward) {
        const outward = this._tmp.copy(preferToward).sub(info.point);
        if (outward.lengthSq() > 1e-8) {
          outward.normalize();
          if (normal.dot(outward) < 0.2) normal.copy(outward);
        }
      }

      const pos = info.point.clone().addScaledVector(normal, radius + this.skin);
      this._lastContact = info.point.clone();
      return {
        position: pos,
        hit: true,
        normal: normal.clone(),
        contactPoint: info.point.clone(),
        shapeId: 'mesh-character'
      };
    }

    slideSphere(lastValid, desired, radius, opts) {
      opts = opts || {};
      const THREE = this.THREE;
      const preferToward = opts.preferToward || null;
      const maxDelta = opts.maxDelta != null ? opts.maxDelta : 0.09;

      const freeDesired = this.resolveSphere(desired, radius, preferToward);
      if (!freeDesired.hit) {
        return {
          position: desired.clone(),
          hit: false,
          normal: new THREE.Vector3(0, 1, 0),
          contactPoint: desired.clone(),
          shapeId: null,
          recovered: false
        };
      }

      let recovered = false;
      let result = freeDesired;

      if (lastValid) {
        const start = this.resolveSphere(lastValid, radius, preferToward);
        if (start.hit) {
          recovered = true;
          result = start;
        } else {
          const delta = this._tmp2.copy(desired).sub(lastValid);
          let lo = 0;
          let hi = 1;
          for (let i = 0; i < 10; i++) {
            const mid = (lo + hi) * 0.5;
            const p = this._tmp3.copy(lastValid).addScaledVector(delta, mid);
            if (this.resolveSphere(p, radius, preferToward).hit) hi = mid;
            else lo = mid;
          }
          const contact = this._tmp3.copy(lastValid).addScaledVector(delta, hi);
          result = this.resolveSphere(contact, radius, preferToward);
          if (!result.hit) result = freeDesired;
        }
      }

      const prev = lastValid || opts.tracking || desired;
      if (prev && result.position.distanceTo(prev) > maxDelta) {
        const clamped = this._tmp.copy(result.position).sub(prev);
        const len = clamped.length();
        if (len > 1e-8) {
          result.position.copy(prev).addScaledVector(clamped, maxDelta / len);
          const again = this.resolveSphere(result.position, radius, preferToward);
          if (again.hit) {
            const step = this._tmp2.copy(again.position).sub(prev);
            if (step.length() > maxDelta) {
              again.position.copy(prev).addScaledVector(step.normalize(), maxDelta);
            }
            result = again;
          }
          recovered = true;
        }
      }

      return {
        position: result.position,
        hit: true,
        normal: result.normal,
        contactPoint: result.contactPoint,
        shapeId: 'mesh-character',
        recovered
      };
    }
  }

  function createCharacterCollider(skinnedMeshes, opts) {
    if (!getLib()?.MeshBVH || !getLib()?.StaticGeometryGenerator) {
      console.warn('[MeshHandCollision] three-mesh-bvh not loaded');
      return null;
    }
    if (!skinnedMeshes?.length) return null;
    try {
      return new CharacterMeshCollider(skinnedMeshes, opts);
    } catch (e) {
      console.warn('[MeshHandCollision] init failed:', e);
      return null;
    }
  }

  window.MeshHandCollision = {
    getLib,
    createCharacterCollider,
    CharacterMeshCollider
  };
})();
