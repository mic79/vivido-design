/** 1 m floor grid overlay on the main arena deck. */
(function () {
  AFRAME.registerComponent('drift-floor-grid', {
    schema: {
      size: { type: 'number', default: 48 },
      cellM: { type: 'number', default: 1 },
      y: { type: 'number', default: 0.002 },
      bg: { type: 'color', default: '#2a3344' },
      line: { type: 'color', default: '#46566e' }
    },

    init: function () {
      const THREE = window.THREE;
      const size = this.data.size;
      const cell = this.data.cellM;
      const repeat = size / cell;
      const res = 64;

      const canvas = document.createElement('canvas');
      canvas.width = res;
      canvas.height = res;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = this.data.bg;
      ctx.fillRect(0, 0, res, res);
      ctx.strokeStyle = this.data.line;
      ctx.lineWidth = 2;
      ctx.strokeRect(0.5, 0.5, res - 1, res - 1);

      const tex = new THREE.CanvasTexture(canvas);
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(repeat, repeat);
      if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;

      const plane = document.createElement('a-plane');
      plane.setAttribute('id', 'arena-floor-grid');
      plane.setAttribute('rotation', '-90 0 0');
      plane.setAttribute('width', size);
      plane.setAttribute('height', size);
      plane.setAttribute('position', '0 ' + this.data.y + ' 0');
      plane.setAttribute(
        'material',
        'shader: standard; roughness: 0.85; metalness: 0.08; color: #ffffff'
      );
      this.el.appendChild(plane);

      plane.addEventListener('loaded', () => {
        const mesh = plane.object3D.children[0];
        if (!mesh || !mesh.material) return;
        mesh.material.map = tex;
        mesh.material.color.setHex(0xffffff);
        mesh.material.needsUpdate = true;
        mesh.receiveShadow = true;
        mesh.castShadow = false;
      });
    }
  });
})();
