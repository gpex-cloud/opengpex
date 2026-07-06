/**
 * OpenGPEX - TIFF Worker (wasm-vips powered)
 *
 * This Worker handles TIFF decode/encode operations using wasm-vips (libvips compiled to WebAssembly).
 * It is lazily loaded by the TiffHandler when TIFF files are imported or exported.
 *
 * Protocol: { id, fn, args } → { id, out } | { id, error }
 *
 * Functions:
 * - decodeTiff(bytes: Uint8Array) → { width, height, data: Uint8Array (RGBA) }
 * - encodeTiff(rgbaData: Uint8Array, width, height, options) → Uint8Array (TIFF bytes)
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

let vips = null;

/**
 * Initialize wasm-vips from locally-served files (/ext/wasm/vips/).
 */
async function initVips() {
  if (vips) return vips;

  // Import the JS glue from local static path (same origin as this worker)
  importScripts('/ext/wasm/vips/vips.js');

  // The imported script exposes a global `Vips` factory function
  // NOTE: wasm-vips uses Emscripten pthreads — it spawns sub-Workers internally.
  // We must set mainScriptUrlOrBlob so pthread workers can find vips.js.
  vips = await self.Vips({
    mainScriptUrlOrBlob: '/ext/wasm/vips/vips.js',
    locateFile: (fileName) => `/ext/wasm/vips/${fileName}`,
    // Do NOT load optional dynamic libraries (vips-jxl.wasm, vips-heif.wasm)
    dynamicLibraries: [],
    print: () => {},
    printErr: () => {},
  });

  // console.log('[VipsWorker] wasm-vips initialized (local WASM)');
  return vips;
}

/**
 * Decode TIFF bytes → RGBA pixel data.
 */
async function decodeTiff(bytes) {
  const v = await initVips();

  const image = v.Image.newFromBuffer(bytes, '', {
    page: 0,
    access: 'sequential',
  });

  // Convert to sRGB if needed (handles CMYK, Lab, etc.)
  let rgb = image;
  if (image.interpretation !== 'srgb' && image.interpretation !== 'b-w') {
    rgb = image.colourspace('srgb');
  }

  // Ensure 8-bit
  let img8 = rgb;
  if (rgb.format !== 'uchar') {
    if (rgb.format === 'ushort') {
      img8 = rgb.linear(1.0 / 257.0, 0).cast('uchar');
    } else {
      img8 = rgb.cast('uchar');
    }
  }

  // Ensure RGBA
  let rgba = img8;
  if (!img8.hasAlpha()) {
    rgba = img8.bandjoin(255);
  } else if (img8.bands > 4) {
    rgba = img8.extractBand(0, { n: 4 });
  }

  const width = rgba.width;
  const height = rgba.height;
  const data = rgba.writeToBuffer('.raw');

  // Cleanup
  image.delete();
  if (rgb !== image) rgb.delete();
  if (img8 !== rgb) img8.delete();
  if (rgba !== img8) rgba.delete();

  return { width, height, data: new Uint8Array(data) };
}

/**
 * Encode RGBA pixel data → TIFF bytes.
 *
 * @param {Uint8Array} rgbaData - RGBA pixel data
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {object} options - Encode options
 * @param {string} options.compression - 'none'|'lzw'|'zip'
 * @param {number} options.dpi - Output DPI
 * @param {Uint8Array} [options.iccProfileBytes] - Optional ICC Profile bytes to embed
 */
async function encodeTiff(rgbaData, width, height, options) {
  const v = await initVips();

  const { compression = 'lzw', dpi = 72, iccProfileBytes } = options || {};
  let image = v.Image.newFromMemory(rgbaData, width, height, 4, 'uchar');

  // Attach ICC Profile if provided
  if (iccProfileBytes && iccProfileBytes.length > 0) {
    // wasm-vips supports attaching ICC profile data via set()
    // The 'icc-profile-data' field is a VipsBlob that TIFF/PNG writers honor
    try {
      image.set('icc-profile-data', iccProfileBytes);
    } catch (e) {
      // Fallback: if set() doesn't work, try via copy + metadata
      console.warn('[vips-worker] ICC attachment failed:', e?.message);
    }
  }

  const compressionMap = { 'none': 'none', 'lzw': 'lzw', 'zip': 'deflate' };
  const vipsCompression = compressionMap[compression] || 'lzw';

  const tiffBuffer = image.writeToBuffer('.tiff', {
    compression: vipsCompression,
    xres: dpi / 25.4,
    yres: dpi / 25.4,
    resunit: 'inch',
  });

  image.delete();
  return new Uint8Array(tiffBuffer);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Message Handler
// ═══════════════════════════════════════════════════════════════════════════════

const handlers = { decodeTiff, encodeTiff };

self.onmessage = async ({ data: msg }) => {
  const { id, fn, args } = msg;

  if (!handlers[fn]) {
    self.postMessage({ id, error: `Unknown function: ${fn}` });
    return;
  }

  try {
    const result = await handlers[fn](...(args || []));
    self.postMessage({ id, out: result }, getTransferables(result));
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};

function getTransferables(result) {
  const transferables = [];
  if (result && typeof result === 'object') {
    if (result.data instanceof Uint8Array && result.data.buffer) {
      transferables.push(result.data.buffer);
    } else if (result instanceof Uint8Array && result.buffer) {
      transferables.push(result.buffer);
    }
  }
  return transferables;
}
