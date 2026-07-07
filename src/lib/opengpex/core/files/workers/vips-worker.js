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
// Phase 5: 16-bit High-Resolution Export
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Export high-resolution 16-bit TIFF/PNG from raw source bytes.
 *
 * This function keeps the entire pipeline in 16-bit domain:
 * - Reads the original file at full precision (no quantization to 8-bit)
 * - Applies geometric transforms (crop/resize) in 16-bit
 * - Writes output as 16-bit TIFF or PNG
 *
 * @param {Uint8Array} rawBytes - Original file bytes (16-bit TIFF/PNG/RAW)
 * @param {object} options - Export options
 * @param {string} options.format - Output format: 'tiff' or 'png'
 * @param {string} [options.compression] - TIFF compression: 'none'|'lzw'|'zip' (default: 'lzw')
 * @param {number} [options.dpi] - Output DPI (default: 72)
 * @param {object} [options.crop] - Optional crop rect: { x, y, w, h }
 * @param {object} [options.resize] - Optional resize: { w, h }
 * @param {Uint8Array} [options.iccProfileBytes] - Optional ICC Profile bytes to embed
 * @returns {Uint8Array} - Encoded 16-bit output bytes
 */
async function exportHighRes(rawBytes, options) {
  const v = await initVips();

  const {
    format = 'tiff',
    compression = 'lzw',
    pngCompression = 6,
    dpi = 72,
    crop,
    resize,
    iccProfileBytes
  } = options || {};

  // 1. Load image from raw bytes at full precision (no cast to uchar!)
  let image = v.Image.newFromBuffer(rawBytes, '', {
    page: 0,
    access: 'sequential',
  });

  // 2. Convert to sRGB color space if needed (preserving bit depth)
  if (image.interpretation !== 'srgb' && image.interpretation !== 'b-w'
      && image.interpretation !== 'rgb16') {
    image = image.colourspace('srgb');
  }

  // 3. Apply crop if specified (in 16-bit domain)
  if (crop && crop.x >= 0 && crop.y >= 0 && crop.w > 0 && crop.h > 0) {
    image = image.extractArea(crop.x, crop.y, crop.w, crop.h);
  }

  // 4. Apply resize if specified (in 16-bit domain)
  if (resize && resize.w > 0 && resize.h > 0) {
    const hscale = resize.w / image.width;
    const vscale = resize.h / image.height;
    image = image.resize(hscale, { vscale });
  }

  // 5. Ensure 16-bit precision for output
  // If image is already ushort (16-bit), keep it; if float, convert to ushort
  if (image.format === 'uchar') {
    // Upscale 8-bit to 16-bit (edge case: shouldn't happen with raw source)
    image = image.linear(257.0, 0).cast('ushort');
  } else if (image.format === 'float' || image.format === 'double') {
    // Float → 16-bit (scale 0..1 → 0..65535)
    image = image.linear(65535.0, 0).cast('ushort');
  }
  // 'ushort' format is already 16-bit — no conversion needed

  // 6. Attach ICC Profile if provided
  if (iccProfileBytes && iccProfileBytes.length > 0) {
    try {
      image.set('icc-profile-data', iccProfileBytes);
    } catch {
      // Non-critical: ICC attachment failure
    }
  }

  // 7. Write output in requested format
  let outputBuffer;
  if (format === 'png') {
    outputBuffer = image.writeToBuffer('.png', {
      bitdepth: 16,
      compression: pngCompression,
    });
  } else {
    // Default: TIFF 16-bit
    const compressionMap = { 'none': 'none', 'lzw': 'lzw', 'zip': 'deflate' };
    const vipsCompression = compressionMap[compression] || 'lzw';
    outputBuffer = image.writeToBuffer('.tiff', {
      bitdepth: 16,
      compression: vipsCompression,
      xres: dpi / 25.4,
      yres: dpi / 25.4,
      resunit: 'inch',
    });
  }

  image.delete();
  return new Uint8Array(outputBuffer);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Message Handler
// ═══════════════════════════════════════════════════════════════════════════════

const handlers = { decodeTiff, encodeTiff, exportHighRes };

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
