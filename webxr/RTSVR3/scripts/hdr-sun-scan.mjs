/**
 * One-off: decode Radiance RGBE, find brightest pixel (sun proxy), print UV + rough world angles.
 * Run: node scripts/hdr-sun-scan.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HDR = path.join(__dirname, '..', 'assets', 'earthlike_planet.hdr');

function decodeRgbeToRgba8(buffer) {
  const rgbe_read_error = 1;
  const rgbe_format_error = 3;
  const rgbe_memory_error = 4;
  const rgbe_error = (code, msg) => {
    throw new Error(`RGBE ${code}: ${msg || ''}`);
  };
  const NEWLINE = '\n';
  const fgets = (buf, lineLimit, consume) => {
    const chunkSize = 128;
    lineLimit = !lineLimit ? 1024 : lineLimit;
    let p = buf.pos;
    let i = -1;
    let len = 0;
    let s = '';
    let chunk = String.fromCharCode.apply(null, new Uint16Array(buf.subarray(p, p + chunkSize)));
    while (0 > (i = chunk.indexOf(NEWLINE)) && len < lineLimit && p < buf.byteLength) {
      s += chunk;
      len += chunk.length;
      p += chunkSize;
      chunk += String.fromCharCode.apply(null, new Uint16Array(buf.subarray(p, p + chunkSize)));
    }
    if (-1 < i) {
      if (false !== consume) buf.pos += len + i + 1;
      return s + chunk.slice(0, i);
    }
    return false;
  };
  const RGBE_ReadHeader = (buf) => {
    const magic_token_re = /^#\?(\S+)/;
    const gamma_re = /^\s*GAMMA\s*=\s*(\d+(\.\d+)?)\s*$/;
    const exposure_re = /^\s*EXPOSURE\s*=\s*(\d+(\.\d+)?)\s*$/;
    const format_re = /^\s*FORMAT=(\S+)\s*$/;
    const dimensions_re = /^\s*\-Y\s+(\d+)\s+\+X\s+(\d+)\s*$/;
    const header = {
      valid: 0,
      string: '',
      comments: '',
      programtype: 'RGBE',
      format: '',
      gamma: 1.0,
      exposure: 1.0,
      width: 0,
      height: 0,
    };
    let line;
    let match;
    if (buf.pos >= buf.byteLength || !(line = fgets(buf))) rgbe_error(rgbe_read_error, 'no header');
    if (!(match = line.match(magic_token_re))) rgbe_error(rgbe_format_error, 'bad initial token');
    header.valid |= 1;
    header.programtype = match[1];
    header.string += line + '\n';
    while (true) {
      line = fgets(buf);
      if (false === line) break;
      header.string += line + '\n';
      if ('#' === line.charAt(0)) {
        header.comments += line + '\n';
        continue;
      }
      if ((match = line.match(gamma_re))) header.gamma = parseFloat(match[1]);
      if ((match = line.match(exposure_re))) header.exposure = parseFloat(match[1]);
      if ((match = line.match(format_re))) {
        header.valid |= 2;
        header.format = match[1];
      }
      if ((match = line.match(dimensions_re))) {
        header.valid |= 4;
        header.height = parseInt(match[1], 10);
        header.width = parseInt(match[2], 10);
      }
      if ((header.valid & 2) && (header.valid & 4)) break;
    }
    if (!(header.valid & 2)) rgbe_error(rgbe_format_error, 'missing format');
    if (!(header.valid & 4)) rgbe_error(rgbe_format_error, 'missing dimensions');
    return header;
  };
  const RGBE_ReadPixels_RLE = (buf, w, h) => {
    const scanline_width = w;
    if (
      scanline_width < 8 ||
      scanline_width > 0x7fff ||
      2 !== buf[0] ||
      2 !== buf[1] ||
      buf[2] & 0x80
    ) {
      return new Uint8Array(buf);
    }
    if (scanline_width !== ((buf[2] << 8) | buf[3])) rgbe_error(rgbe_format_error, 'wrong scanline width');
    const data_rgba = new Uint8Array(4 * w * h);
    let offset = 0;
    let pos = 0;
    const ptr_end = 4 * scanline_width;
    const rgbeStart = new Uint8Array(4);
    const scanline_buffer = new Uint8Array(ptr_end);
    let num_scanlines = h;
    while (num_scanlines > 0 && pos < buf.byteLength) {
      if (pos + 4 > buf.byteLength) rgbe_error(rgbe_read_error, 'truncated');
      rgbeStart[0] = buf[pos++];
      rgbeStart[1] = buf[pos++];
      rgbeStart[2] = buf[pos++];
      rgbeStart[3] = buf[pos++];
      if (
        2 != rgbeStart[0] ||
        2 != rgbeStart[1] ||
        ((rgbeStart[2] << 8) | rgbeStart[3]) != scanline_width
      ) {
        rgbe_error(rgbe_format_error, 'bad rgbe scanline format');
      }
      let ptr = 0;
      let count;
      while (ptr < ptr_end && pos < buf.byteLength) {
        count = buf[pos++];
        const isEncodedRun = count > 128;
        if (isEncodedRun) count -= 128;
        if (0 === count || ptr + count > ptr_end) rgbe_error(rgbe_format_error, 'bad scanline data');
        if (isEncodedRun) {
          const byteValue = buf[pos++];
          for (let i = 0; i < count; i++) scanline_buffer[ptr++] = byteValue;
        } else {
          scanline_buffer.set(buf.subarray(pos, pos + count), ptr);
          ptr += count;
          pos += count;
        }
      }
      const l = scanline_width;
      for (let i = 0; i < l; i++) {
        let off = 0;
        data_rgba[offset] = scanline_buffer[i + off];
        off += scanline_width;
        data_rgba[offset + 1] = scanline_buffer[i + off];
        off += scanline_width;
        data_rgba[offset + 2] = scanline_buffer[i + off];
        off += scanline_width;
        data_rgba[offset + 3] = scanline_buffer[i + off];
        offset += 4;
      }
      num_scanlines--;
    }
    return data_rgba;
  };

  const byteArray = new Uint8Array(buffer);
  byteArray.pos = 0;
  const hdr = RGBE_ReadHeader(byteArray);
  const w = hdr.width;
  const h = hdr.height;
  const rgba = RGBE_ReadPixels_RLE(byteArray.subarray(byteArray.pos), w, h);
  return { w, h, rgba, header: hdr };
}

function rgbeLum(rgba, i) {
  const e = rgba[i + 3];
  const s = Math.pow(2.0, e - 128.0) / 255.0;
  const r = rgba[i] * s;
  const g = rgba[i + 1] * s;
  const b = rgba[i + 2] * s;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Matches Three.js direction → equirect UV (see equirectangular shader), then inverse for reporting. */
function uvToDirectionThree(u, v) {
  const lon = (u * 2 - 1) * Math.PI;
  const lat = (v * 2 - 1) * (Math.PI * 0.5);
  const y = Math.sin(lat);
  const cosLat = Math.cos(lat);
  return { x: cosLat * Math.sin(lon), y, z: cosLat * Math.cos(lon) };
}

const buf = fs.readFileSync(HDR);
console.log('Decoding', HDR, '…');
const { w, h, rgba, header } = decodeRgbeToRgba8(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
console.log('Size', w, 'x', h, 'gamma', header.gamma, 'exposure', header.exposure);

let maxL = 0;
let maxIx = 0;
let maxIy = 0;
const stride = 4;
for (let y = 0; y < h; y += stride) {
  const row = y * w * 4;
  for (let x = 0; x < w; x += stride) {
    const i = row + x * 4;
    const L = rgbeLum(rgba, i);
    if (L > maxL) {
      maxL = L;
      maxIx = x;
      maxIy = y;
    }
  }
}

const u = (maxIx + 0.5) / w;
const v = (maxIy + 0.5) / h;
const dir = uvToDirectionThree(u, v);
const azDeg = (Math.atan2(dir.x, dir.z) * 180) / Math.PI;
const elDeg = (Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI;

console.log('\nBrightest sample (stride', stride, ') ~ sun:');
console.log('  pixel', maxIx, maxIy, '  luminance~', maxL.toExponential(3));
console.log('  UV u,v =', u.toFixed(4), v.toFixed(4));
console.log('  direction (Three-like Y-up):', dir.x.toFixed(3), dir.y.toFixed(3), dir.z.toFixed(3));
console.log('  azimuth atan2(x,z) deg:', azDeg.toFixed(1), '  elevation asin(y) deg:', elDeg.toFixed(1));

console.log('\n--- VR / desktop start view (RTSVR2 index.html) ---');
console.log('cameraRig position: (0, 40, 0), camera rotation: -75° X (pitch down toward map).');
console.log(
  'Approx. camera forward in world (Y-up, default A-Frame camera looks -Z, then Rx(-75°)):'
);
const deg = (-75 * Math.PI) / 180;
const fx = 0;
const fy = Math.sin(deg);
const fz = -Math.cos(deg);
const len = Math.hypot(fx, fy, fz);
const fwd = { x: fx / len, y: fy / len, z: fz / len };
console.log('  forward ~', fwd.x.toFixed(3), fwd.y.toFixed(3), fwd.z.toFixed(3), '(mostly -Y = down toward ground)');
console.log(
  'So the **center of the screen** samples the HDR along **-forward** = sky behind/above the tilted view; the **upper** viewport shows the horizon band opposite the ground.'
);
console.log(
  '\nExact overlap sun/Earth vs reticle needs matching Three equirect ↔ world (PMREM); open the HDR in an equirect viewer with (u,v) crosshair at',
  u.toFixed(3),
  v.toFixed(3),
  'to see the sun disk in the source art.'
);
