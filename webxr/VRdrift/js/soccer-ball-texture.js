/** Soccer-ball canvas texture (from VRKnockout) — pentagon pattern shows roll clearly. */
(function () {
  function vkSoccerIcosahedronVertsNormalized() {
    const phi = (1 + Math.sqrt(5)) / 2;
    const raw = [
      [0, 1, phi], [0, 1, -phi], [0, -1, phi], [0, -1, -phi],
      [1, phi, 0], [1, -phi, 0], [-1, phi, 0], [-1, -phi, 0],
      [phi, 0, 1], [phi, 0, -1], [-phi, 0, 1], [-phi, 0, -1]
    ];
    return raw.map(([x, y, z]) => {
      const L = Math.sqrt(x * x + y * y + z * z);
      return [x / L, y / L, z / L];
    });
  }

  function vkCanvasDrawPentagon(ctx, cx, cy, rPx, fillStyle, strokeStyle, lineW) {
    ctx.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = -Math.PI / 2 + k * ((2 * Math.PI) / 5);
      const px = cx + rPx * Math.cos(a);
      const py = cy + rPx * Math.sin(a);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    if (fillStyle) {
      ctx.fillStyle = fillStyle;
      ctx.fill();
    }
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineW || 2;
      ctx.stroke();
    }
  }

  window.VRDriftSoccerTexture = {
    create: function (THREE, tintHex) {
      const w = 1536;
      const h = 768;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#f2f2f0';
      ctx.fillRect(0, 0, w, h);
      const verts = vkSoccerIcosahedronVertsNormalized();
      const rPx = 50;
      verts.forEach((p) => {
        const lon = Math.atan2(p[2], p[0]);
        const lat = Math.asin(Math.max(-1, Math.min(1, p[1])));
        const u = 0.5 + lon / (2 * Math.PI);
        const v = 0.5 - lat / Math.PI;
        const cx = u * w;
        const cy = v * h;
        vkCanvasDrawPentagon(ctx, cx, cy, rPx, 'rgba(22,22,24,0.94)', '#080808', 2.5);
        if (cx < rPx + 10) vkCanvasDrawPentagon(ctx, cx + w, cy, rPx, 'rgba(22,22,24,0.94)', '#080808', 2.5);
        if (cx > w - rPx - 10) vkCanvasDrawPentagon(ctx, cx - w, cy, rPx, 'rgba(22,22,24,0.94)', '#080808', 2.5);
      });
      const tex = new THREE.CanvasTexture(canvas);
      if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.needsUpdate = true;
      const col = new THREE.Color(tintHex || '#44aaff');
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        color: 0xffffff,
        roughness: 0.36,
        metalness: 0.08,
        emissive: col,
        emissiveIntensity: 0.12
      });
      return { texture: tex, material: mat };
    }
  };
})();
