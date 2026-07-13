/** BattleVR forward laser for menu / .clickable interaction (trigger = click). */
(function () {
  AFRAME.registerComponent('forward-raycaster', {
    schema: {
      hand: { type: 'string', default: 'right' },
      lineColor: { type: 'color', default: '#ffffff' },
      maxLength: { type: 'number', default: 10 },
      enabled: { type: 'boolean', default: false },
      objects: { type: 'string', default: '.clickable' }
    },

    init: function () {
      this.raycaster = new THREE.Raycaster();
      this.intersection = null;
      this.line = null;
      this.lastIntersectedEl = null;
      this.currentTarget = null;
      this.intersectedEls = [];
      this.intersections = [];
      this.createLine();
      this.bindEvents();
    },

    createLine: function () {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, -1)
      ]);
      const material = new THREE.LineBasicMaterial({
        color: new THREE.Color(this.data.lineColor),
        opacity: 0.85,
        transparent: true
      });
      this.line = new THREE.Line(geometry, material);
      this.line.name = 'forward-raycaster-line';
      this.line.scale.z = this.data.maxLength;
      this.line.rotation.x = -Math.PI / 2;
      this.el.object3D.add(this.line);
    },

    bindEvents: function () {
      this.el.addEventListener('triggerdown', () => {
        if (this.currentTarget) this.currentTarget.emit('click');
      });
    },

    update: function (oldData) {
      if (this.line && oldData.lineColor !== this.data.lineColor) {
        this.line.material.color.set(this.data.lineColor);
      }
    },

    tick: function () {
      if (!this.line || !this.data.enabled) {
        if (this.line) this.line.visible = false;
        if (this.lastIntersectedEl) {
          this.lastIntersectedEl.emit('mouseleave');
          this.lastIntersectedEl = null;
        }
        this.currentTarget = null;
        return;
      }

      this.line.visible = true;
      const origin = new THREE.Vector3();
      this.el.object3D.getWorldPosition(origin);
      const direction = new THREE.Vector3(0, 0, -1);
      const lineQuaternion = new THREE.Quaternion().setFromEuler(this.line.rotation);
      const worldQuaternion = new THREE.Quaternion();
      this.el.object3D.getWorldQuaternion(worldQuaternion);
      worldQuaternion.multiply(lineQuaternion);
      direction.applyQuaternion(worldQuaternion);

      this.raycaster.set(origin, direction.normalize());
      this.raycaster.far = this.data.maxLength;

      const selectors = (this.data.objects || '.clickable')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      let targetElements = [];
      selectors.forEach((selector) => {
        targetElements = targetElements.concat(
          Array.from(document.querySelectorAll(selector))
        );
      });

      const meshes = [];
      targetElements.forEach((el) => {
        if (!el.object3D) return;
        el.object3D.traverse((node) => {
          if (node.isMesh) {
            node.el = el;
            meshes.push(node);
          }
        });
      });

      const intersections = this.raycaster.intersectObjects(meshes, false);
      this.intersections = intersections;
      this.intersectedEls = [];

      if (intersections.length > 0) {
        this.intersection = intersections[0];
        this.line.scale.z = this.intersection.distance;
        let intersectedEl = this.intersection.object.el;
        if (!intersectedEl && this.intersection.object.parent) {
          intersectedEl = this.intersection.object.parent.el;
        }
        if (intersectedEl) this.intersectedEls.push(intersectedEl);
        if (intersectedEl) {
          if (this.lastIntersectedEl !== intersectedEl) {
            if (this.lastIntersectedEl) this.lastIntersectedEl.emit('mouseleave');
            intersectedEl.emit('mouseenter');
            this.lastIntersectedEl = intersectedEl;
          }
          this.currentTarget = intersectedEl;
        }
      } else {
        this.line.scale.z = this.data.maxLength;
        if (this.lastIntersectedEl) {
          this.lastIntersectedEl.emit('mouseleave');
          this.lastIntersectedEl = null;
        }
        this.currentTarget = null;
      }
    },

    refreshObjects: function () {}
  });
})();
