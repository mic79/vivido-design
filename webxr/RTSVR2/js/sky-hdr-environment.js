/**
 * Local RGBE `.hdr` → equirect `DataTexture` → PMREM for IBL + **same equirect** for `scene.background`.
 * Uses `window.THREE` from A-Frame (no second Three.js module). RGBE parse derived from THREE.RGBELoader (r173), float path only.
 *
 * **Quality:** `scene.background` uses the decoded equirect (sharp). `scene.environment` uses PMREM (blurry cube-UV
 * atlas by design) so distant Earth edges are not limited by PMREM resolution. Large HDRs are still capped before
 * float decode — default long edge **4096** (~256 MB float buffer for 2:1). Full 8192: set
 * `window.RTS_HDR_EQUIRECT_MAX_LONG_EDGE = 8192` before the module loads (~512 MB).
 */

/** Same path as on disk: `RTSVR2/assets/earthlike_planet.hdr` when served from the RTSVR2 root. */
const DEFAULT_HDR_REL = 'assets/earthlike_planet.hdr';

const HDR_EQUIRECT_MAX_LONG_EDGE_DEFAULT = 4096;

function assetUrlCandidates(relativePath) {
  const out = [];
  try {
    out.push(new URL(`../${relativePath}`, import.meta.url).href);
  } catch (_) {
    /* file:// or opaque origin */
  }
  out.push(relativePath);
  return out;
}

async function fetchFirstBuffer(urls) {
  let lastErr;
  for (const u of urls) {
    try {
      const res = await fetch(u);
      if (res.ok) return await res.arrayBuffer();
      lastErr = new Error(String(res.status));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('fetch failed');
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {{ width: number, height: number, data: Float32Array }}
 */
function parseRGBEToFloatRgba(buffer) {
  const rgbe_read_error = 1;
  const rgbe_format_error = 3;
  const rgbe_memory_error = 4;
  const rgbe_error = function (code, msg) {
    switch (code) {
      case rgbe_read_error:
        throw new Error('RGBE: Read Error: ' + (msg || ''));
      case rgbe_format_error:
        throw new Error('RGBE: Bad File Format: ' + (msg || ''));
      default:
      case rgbe_memory_error:
        throw new Error('RGBE: Memory Error: ' + (msg || ''));
    }
  };

  const RGBE_VALID_PROGRAMTYPE = 1;
  const RGBE_VALID_FORMAT = 2;
  const RGBE_VALID_DIMENSIONS = 4;
  const NEWLINE = '\n';

  const fgets = function (buf, lineLimit, consume) {
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

  const RGBE_ReadHeader = function (buf) {
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
    if (buf.pos >= buf.byteLength || !(line = fgets(buf))) {
      rgbe_error(rgbe_read_error, 'no header found');
    }
    if (!(match = line.match(magic_token_re))) {
      rgbe_error(rgbe_format_error, 'bad initial token');
    }
    header.valid |= RGBE_VALID_PROGRAMTYPE;
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
      if ((match = line.match(gamma_re))) {
        header.gamma = parseFloat(match[1]);
      }
      if ((match = line.match(exposure_re))) {
        header.exposure = parseFloat(match[1]);
      }
      if ((match = line.match(format_re))) {
        header.valid |= RGBE_VALID_FORMAT;
        header.format = match[1];
      }
      if ((match = line.match(dimensions_re))) {
        header.valid |= RGBE_VALID_DIMENSIONS;
        header.height = parseInt(match[1], 10);
        header.width = parseInt(match[2], 10);
      }
      if ((header.valid & RGBE_VALID_FORMAT) && (header.valid & RGBE_VALID_DIMENSIONS)) break;
    }
    if (!(header.valid & RGBE_VALID_FORMAT)) {
      rgbe_error(rgbe_format_error, 'missing format specifier');
    }
    if (!(header.valid & RGBE_VALID_DIMENSIONS)) {
      rgbe_error(rgbe_format_error, 'missing image size specifier');
    }
    return header;
  };

  const RGBE_ReadPixels_RLE = function (buf, w, h) {
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
    if (scanline_width !== ((buf[2] << 8) | buf[3])) {
      rgbe_error(rgbe_format_error, 'wrong scanline width');
    }
    const data_rgba = new Uint8Array(4 * w * h);
    if (!data_rgba.length) {
      rgbe_error(rgbe_memory_error, 'unable to allocate buffer space');
    }
    let offset = 0;
    let pos = 0;
    const ptr_end = 4 * scanline_width;
    const rgbeStart = new Uint8Array(4);
    const scanline_buffer = new Uint8Array(ptr_end);
    let num_scanlines = h;
    while (num_scanlines > 0 && pos < buf.byteLength) {
      if (pos + 4 > buf.byteLength) {
        rgbe_error(rgbe_read_error);
      }
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
        if (0 === count || ptr + count > ptr_end) {
          rgbe_error(rgbe_format_error, 'bad scanline data');
        }
        if (isEncodedRun) {
          const byteValue = buf[pos++];
          for (let i = 0; i < count; i++) {
            scanline_buffer[ptr++] = byteValue;
          }
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

  const RGBEByteToRGBFloat = function (sourceArray, sourceOffset, destArray, destOffset) {
    const e = sourceArray[sourceOffset + 3];
    const scale = Math.pow(2.0, e - 128.0) / 255.0;
    destArray[destOffset + 0] = sourceArray[sourceOffset + 0] * scale;
    destArray[destOffset + 1] = sourceArray[sourceOffset + 1] * scale;
    destArray[destOffset + 2] = sourceArray[sourceOffset + 2] * scale;
    destArray[destOffset + 3] = 1;
  };

  const byteArray = new Uint8Array(buffer);
  byteArray.pos = 0;
  const rgbe_header_info = RGBE_ReadHeader(byteArray);
  const w = rgbe_header_info.width;
  const h = rgbe_header_info.height;
  const image_rgba_data = RGBE_ReadPixels_RLE(byteArray.subarray(byteArray.pos), w, h);

  let maxLong =
    typeof window !== 'undefined' && Number.isFinite(window.RTS_HDR_EQUIRECT_MAX_LONG_EDGE)
      ? Math.max(256, Math.floor(window.RTS_HDR_EQUIRECT_MAX_LONG_EDGE))
      : HDR_EQUIRECT_MAX_LONG_EDGE_DEFAULT;
  const maxDim = Math.max(w, h);
  let tw = w;
  let th = h;
  if (maxDim > maxLong) {
    const s = maxLong / maxDim;
    tw = Math.max(1, Math.round(w * s));
    th = Math.max(1, Math.round(h * s));
  }

  const floatArray = new Float32Array(tw * th * 4);
  if (tw === w && th === h) {
    const n = w * h;
    for (let j = 0; j < n; j++) {
      RGBEByteToRGBFloat(image_rgba_data, j * 4, floatArray, j * 4);
    }
  } else {
    for (let ty = 0; ty < th; ty++) {
      const ySrc = Math.min(h - 1, Math.floor((ty + 0.5) * (h / th)));
      for (let tx = 0; tx < tw; tx++) {
        const xSrc = Math.min(w - 1, Math.floor((tx + 0.5) * (w / tw)));
        const src = (ySrc * w + xSrc) * 4;
        const dst = (ty * tw + tx) * 4;
        RGBEByteToRGBFloat(image_rgba_data, src, floatArray, dst);
      }
    }
  }
  return { width: tw, height: th, data: floatArray };
}

/**
 * @param {HTMLElement} sceneEl — `<a-scene>`
 * @param {string} [relativePath] — project-relative, e.g. `assets/earthlike_planet.hdr`
 * @returns {Promise<void>}
 */
export async function applyHdrSkyEnvironment(sceneEl, relativePath = DEFAULT_HDR_REL) {
  const THREE = window.THREE;
  const renderer = sceneEl && sceneEl.renderer;
  const scene = sceneEl && sceneEl.object3D;
  if (!THREE || !renderer || !scene || !THREE.PMREMGenerator) {
    console.warn('RTSVR2: HDR sky skipped (THREE / renderer / PMREM missing)');
    return;
  }

  let buffer;
  try {
    buffer = await fetchFirstBuffer(assetUrlCandidates(relativePath));
  } catch (e) {
    console.warn('RTSVR2: HDR fetch failed', relativePath, e);
    return;
  }

  let parsed;
  try {
    parsed = parseRGBEToFloatRgba(buffer);
  } catch (e) {
    console.warn('RTSVR2: HDR parse failed', e);
    return;
  }

  const eq = new THREE.DataTexture(
    parsed.data,
    parsed.width,
    parsed.height,
    THREE.RGBAFormat,
    THREE.FloatType
  );
  eq.mapping = THREE.EquirectangularReflectionMapping;
  eq.minFilter = THREE.LinearFilter;
  eq.magFilter = THREE.LinearFilter;
  eq.generateMipmaps = false;
  eq.flipY = true;
  const cap = renderer.capabilities && renderer.capabilities.getMaxAnisotropy && renderer.capabilities.getMaxAnisotropy();
  if (cap) eq.anisotropy = Math.min(16, cap);
  if ('colorSpace' in eq && THREE.LinearSRGBColorSpace) {
    eq.colorSpace = THREE.LinearSRGBColorSpace;
  }
  eq.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  if (typeof pmrem.compileEquirectangularShader === 'function') {
    pmrem.compileEquirectangularShader();
  }
  let envMap;
  try {
    envMap = pmrem.fromEquirectangular(eq).texture;
  } catch (e) {
    console.warn('RTSVR2: PMREM from HDR failed', e);
    eq.dispose();
    pmrem.dispose();
    return;
  }

  /** PMREM cube-UV is low effective res for `background`; keep equirect here so planets stay sharp. */
  scene.background = eq;
  scene.environment = envMap;
  if ('backgroundIntensity' in scene && typeof scene.backgroundIntensity === 'number') {
    scene.backgroundIntensity = 1;
  }
  /** Keep IBL subtle so moon regolith / units are not dominated by the sky HDR. */
  if ('environmentIntensity' in scene && typeof scene.environmentIntensity === 'number') {
    scene.environmentIntensity = 0.4;
  }

  pmrem.dispose();

  const sky = document.querySelector('a-sky');
  if (sky) sky.setAttribute('visible', false);
}
