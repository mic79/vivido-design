/**
 * Procedural surface sets for the halls (cached). All UVs in the halls are metric,
 * so `repeat` converts metres → tiles. Normal maps come from drawn height fields.
 */
import * as THREE from 'three';

const cache = new Map();

function canvas(n) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  return [c, c.getContext('2d', { willReadFrequently: true })];
}

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

/** Height canvas (grey) → tangent-space normal map texture. */
function normalFromHeight(hc, strength) {
  const n = hc.width;
  const src = hc.getContext('2d').getImageData(0, 0, n, n).data;
  const h = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) h[i] = src[i * 4] / 255;
  const [c, g] = canvas(n);
  const img = g.createImageData(n, n);
  const at = (x, y) => h[((y + n) % n) * n + ((x + n) % n)];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * n + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return tex(c, false);
}

function tex(c, srgb = true, repeatMetres = 0) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (repeatMetres) t.repeat.set(1 / repeatMetres, 1 / repeatMetres);
  return t;
}

const setRepeat = (set, m) => {
  for (const t of Object.values(set)) if (t?.isTexture) t.repeat.set(1 / m, 1 / m);
  return set;
};

/** Polished engineered-stone floor: 2.5 m panels, fine aggregate, crisp seams. Tile = 5 m. */
export function floorSet() {
  if (cache.has('floor')) return cache.get('floor');
  const N = 1024, half = N / 2;
  const r = rng(11);
  const [ac, a] = canvas(N), [hc, h] = canvas(N), [rc, rr] = canvas(N);
  a.fillStyle = '#fff'; a.fillRect(0, 0, N, N);
  h.fillStyle = '#fff'; h.fillRect(0, 0, N, N);
  rr.fillStyle = 'rgb(0,30,0)'; rr.fillRect(0, 0, N, N);
  for (const [x, y] of [[0, 0], [half, 0], [0, half], [half, half]]) {
    const t = 0.94 + r() * 0.05;
    a.fillStyle = `rgb(${244 * t | 0},${245 * t | 0},${246 * t | 0})`;
    a.fillRect(x, y, half, half);
    // soft cloudy veining
    for (let k = 0; k < 18; k++) {
      const gx = x + r() * half, gy = y + r() * half, rad = 40 + r() * 140;
      const gr = a.createRadialGradient(gx, gy, 0, gx, gy, rad);
      const v = r() < 0.5 ? '255,255,255' : '214,216,220';
      gr.addColorStop(0, `rgba(${v},0.10)`);
      gr.addColorStop(1, `rgba(${v},0)`);
      a.fillStyle = gr;
      a.fillRect(gx - rad, gy - rad, rad * 2, rad * 2);
    }
  }
  for (let i = 0; i < 26000; i++) {
    const v = 150 + r() * 105 | 0, s = r() < 0.92 ? 1 : 2;
    a.fillStyle = `rgba(${v},${v},${v + 4},0.22)`;
    a.fillRect(r() * N, r() * N, s, s);
  }
  for (let i = 0; i < 9000; i++) {
    const v = 22 + r() * 30 | 0;
    rr.fillStyle = `rgb(0,${v},0)`;
    rr.fillRect(r() * N, r() * N, 3, 3);
  }
  const seam = (ctx, w, style) => {
    ctx.fillStyle = style;
    for (const p of [0, half]) {
      ctx.fillRect(p - w / 2, 0, w, N);
      ctx.fillRect(0, p - w / 2, N, w);
    }
    ctx.fillRect(N - w / 2, 0, w, N);
    ctx.fillRect(0, N - w / 2, N, w);
  };
  seam(a, 4, 'rgba(60,64,70,0.75)');
  seam(h, 9, 'rgb(150,150,150)');
  seam(h, 4, 'rgb(40,40,40)');
  seam(rr, 6, 'rgb(0,190,0)');
  const set = { map: tex(ac), normalMap: normalFromHeight(hc, 2.2), roughnessMap: tex(rc, false) };
  cache.set('floor', setRepeat(set, 5));
  return set;
}

/** Ashlar wall stone: staggered 2.5 × 1.25 m blocks with fine reveals. Tile = 5 m. */
export function wallSet() {
  if (cache.has('wall')) return cache.get('wall');
  const N = 1024, bw = N / 2, bh = N / 4;
  const r = rng(29);
  const [ac, a] = canvas(N), [hc, h] = canvas(N);
  h.fillStyle = '#fff'; h.fillRect(0, 0, N, N);
  for (let row = 0; row < 4; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let k = -1; k < 3; k++) {
      const x = off + k * bw, y = row * bh;
      const t = 0.95 + r() * 0.05;
      a.fillStyle = `rgb(${246 * t | 0},${244 * t | 0},${240 * t | 0})`;
      a.fillRect(x, y, bw, bh);
      const gr = a.createLinearGradient(x, y, x, y + bh);
      gr.addColorStop(0, 'rgba(255,255,255,0.05)');
      gr.addColorStop(1, 'rgba(0,0,0,0.03)');
      a.fillStyle = gr;
      a.fillRect(x, y, bw, bh);
      h.fillStyle = 'rgb(120,120,120)';
      h.fillRect(x - 3, y, 6, bh);
      h.fillStyle = 'rgb(40,40,40)';
      h.fillRect(x - 1, y, 2, bh);
    }
    h.fillStyle = 'rgb(120,120,120)';
    h.fillRect(0, row * bh - 3, N, 6);
    h.fillStyle = 'rgb(40,40,40)';
    h.fillRect(0, row * bh - 1, N, 2);
  }
  for (let i = 0; i < 14000; i++) {
    const v = 190 + r() * 65 | 0;
    a.fillStyle = `rgba(${v},${v},${v},0.16)`;
    a.fillRect(r() * N, r() * N, 2, 2);
  }
  // reveals read darker in albedo too
  a.globalCompositeOperation = 'multiply';
  a.drawImage(hc, 0, 0);
  a.globalCompositeOperation = 'source-over';
  const set = { map: tex(ac), normalMap: normalFromHeight(hc, 1.6) };
  cache.set('wall', setRepeat(set, 5));
  return set;
}

/** One deep stepped coffer per UV unit with a small light at its heart. */
export function cofferSet() {
  if (cache.has('coffer')) return cache.get('coffer');
  const N = 512;
  const [ac, a] = canvas(N), [hc, h] = canvas(N), [ec, e] = canvas(N);
  const steps = [
    [0.0, 255, 250], // frame
    [0.11, 200, 236],
    [0.17, 150, 222],
    [0.25, 95, 206],
    [0.31, 60, 196],
  ];
  for (const [inset, hv, av] of steps) {
    const p = inset * N;
    // bevel: slight gradient band before each step
    h.fillStyle = `rgb(${hv},${hv},${hv})`;
    h.fillRect(p, p, N - 2 * p, N - 2 * p);
    a.fillStyle = `rgb(${av},${av - 1},${av - 4})`;
    a.fillRect(p, p, N - 2 * p, N - 2 * p);
  }
  // grazing-light shading on the step faces
  const gr = a.createLinearGradient(0, 0, 0, N);
  gr.addColorStop(0, 'rgba(0,0,0,0.05)');
  gr.addColorStop(1, 'rgba(255,255,255,0.03)');
  a.fillStyle = gr;
  a.fillRect(0, 0, N, N);
  // central lens + champagne ring
  a.fillStyle = 'rgb(214,196,160)';
  a.beginPath(); a.arc(N / 2, N / 2, N * 0.07, 0, Math.PI * 2); a.fill();
  h.fillStyle = 'rgb(110,110,110)';
  h.beginPath(); h.arc(N / 2, N / 2, N * 0.07, 0, Math.PI * 2); h.fill();
  e.fillStyle = '#000'; e.fillRect(0, 0, N, N);
  const eg = e.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N * 0.05);
  eg.addColorStop(0, '#fff');
  eg.addColorStop(0.7, 'rgba(255,255,255,0.9)');
  eg.addColorStop(1, 'rgba(255,255,255,0)');
  e.fillStyle = eg;
  e.beginPath(); e.arc(N / 2, N / 2, N * 0.05, 0, Math.PI * 2); e.fill();
  const set = { map: tex(ac), normalMap: normalFromHeight(hc, 3.2), emissiveMap: tex(ec) };
  cache.set('coffer', set);
  return set;
}

export function disposeTextures() {
  for (const set of cache.values()) for (const t of Object.values(set)) t?.dispose?.();
  cache.clear();
}
