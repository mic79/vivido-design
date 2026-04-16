/**
 * In-headset game UI: hover feedback, minimap clicks, build/production buttons.
 * Uses window.__rtsVrMinimapClick(wx, wz, moveMode) from ui.js after init.
 */
(function () {
  AFRAME.registerComponent('vr-button-hover', {
    schema: {
      hoverColor: { type: 'color', default: '#4a7a4a' },
      hoverOpacity: { type: 'number', default: 1 },
    },
    init: function () {
      this.baseColor = '#333333';
      this.baseOpacity = 1;
      this.onEnter = this.onEnter.bind(this);
      this.onLeave = this.onLeave.bind(this);
      this.onLoaded = this.onLoaded.bind(this);
      this.el.addEventListener('loaded', this.onLoaded);
      if (this.el.sceneEl && this.el.sceneEl.hasLoaded) {
        this.el.sceneEl.addEventListener('loaded', this.onLoaded);
      }
      this.el.addEventListener('mouseenter', this.onEnter);
      this.el.addEventListener('mouseleave', this.onLeave);
    },
    onLoaded: function () {
      const mesh = this.el.getObject3D('mesh');
      if (!mesh || !mesh.material || !mesh.material.color) return;
      this.baseColor = '#' + mesh.material.color.getHexString();
      this.baseOpacity =
        mesh.material.opacity !== undefined ? mesh.material.opacity : 1;
    },
    onEnter: function () {
      if (!this.el.classList.contains('clickable')) return;
      this.el.setAttribute('material', 'color', this.data.hoverColor);
      this.el.setAttribute('material', 'opacity', this.data.hoverOpacity);
    },
    onLeave: function () {
      this.el.setAttribute('material', 'color', this.baseColor);
      this.el.setAttribute('material', 'opacity', this.baseOpacity);
    },
    remove: function () {
      this.el.removeEventListener('loaded', this.onLoaded);
      this.el.removeEventListener('mouseenter', this.onEnter);
      this.el.removeEventListener('mouseleave', this.onLeave);
    },
  });

  AFRAME.registerComponent('rts-vr-minimap', {
    schema: {
      mapSize: { type: 'number', default: 200 },
    },
    init: function () {
      this.onClick = this.onClick.bind(this);
      this.el.addEventListener('click', this.onClick);
    },
    onClick: function (evt) {
      const visible = this.el.getAttribute('visible');
      if (visible === false || visible === 'false') return;
      if (!this.el.classList.contains('clickable')) return;

      const inter = evt.detail && evt.detail.intersection;
      const uv = inter && inter.uv;
      if (!uv) return;

      const half = this.data.mapSize / 2;
      const u = uv.x;
      const v = uv.y;
      // Match flat minimap (ui.js handleMinimapClick): wx mirrors U; WZ uses V upward (Three UV v=0 bottom)
      const wx = (1 - u) * this.data.mapSize - half;
      const wz = v * this.data.mapSize - half;

      const grip =
        typeof window.__rtsIsVrGripHeld === 'function'
          ? window.__rtsIsVrGripHeld()
          : false;
      const moveMode = grip;

      if (typeof window.__rtsVrMinimapClick === 'function') {
        window.__rtsVrMinimapClick(wx, wz, moveMode);
      }
    },
    remove: function () {
      this.el.removeEventListener('click', this.onClick);
    },
  });

  AFRAME.registerComponent('rts-vr-build-btn', {
    schema: {
      kind: { type: 'string', default: 'produce' },
      buildingId: { type: 'string', default: '' },
      unitType: { type: 'string', default: '' },
      buildingType: { type: 'string', default: '' },
    },
    init: function () {
      this.onClick = this.onClick.bind(this);
      this.el.addEventListener('click', this.onClick);
    },
    onClick: function () {
      if (!this.el.classList.contains('clickable')) return;
      const root = document.getElementById('vr-build-panel-root');
      if (root) {
        const vis = root.getAttribute('visible');
        if (vis === false || vis === 'false') return;
      }

      const k = this.data.kind;
      if (k === 'build' && window._startBuildMode) {
        window._startBuildMode(this.data.buildingType);
      } else if (k === 'produce' && window._queueUnit) {
        window._queueUnit(this.data.buildingId, this.data.unitType);
      } else if (k === 'cancel' && window._cancelQueueUnit) {
        window._cancelQueueUnit(this.data.buildingId, this.data.unitType);
      } else if (k === 'deployMobileHq' && window._deployMobileHq) {
        window._deployMobileHq();
      }
    },
    remove: function () {
      this.el.removeEventListener('click', this.onClick);
    },
  });
})();
