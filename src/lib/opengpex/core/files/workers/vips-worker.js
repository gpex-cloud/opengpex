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

  const {
    compression = 'lzw',
    dpi = 72,
    iccProfileBytes,
    jpegQuality = 85,
    // Advanced options
    predictor = 'none',
    bigtiff = false,
    tile = false,
    tileWidth = 256,
    tileHeight = 256,
  } = options || {};

  let image = v.Image.newFromMemory(rgbaData, width, height, 4, 'uchar');

  // Attach ICC Profile if provided
  if (iccProfileBytes && iccProfileBytes.length > 0) {
    try {
      image.set('icc-profile-data', iccProfileBytes);
    } catch (e) {
      console.warn('[vips-worker] ICC attachment failed:', e?.message);
    }
  }

  const compressionMap = { 'none': 'none', 'lzw': 'lzw', 'zip': 'deflate', 'jpeg': 'jpeg' };
  const vipsCompression = compressionMap[compression] || 'lzw';

  // Build tiff save options
  const saveOpts = {
    compression: vipsCompression,
    xres: dpi / 25.4,
    yres: dpi / 25.4,
    resunit: 'inch',
    bigtiff,
  };

  // JPEG compression requires tiling and quality parameter
  if (compression === 'jpeg') {
    saveOpts.Q = jpegQuality;
    saveOpts.tile = true;
    saveOpts.tile_width = tileWidth;
    saveOpts.tile_height = tileHeight;
  } else if (tile) {
    // User-requested tiling for non-JPEG
    saveOpts.tile = true;
    saveOpts.tile_width = tileWidth;
    saveOpts.tile_height = tileHeight;
  }

  // Predictor (only effective for LZW/ZIP)
  if ((compression === 'lzw' || compression === 'zip') && predictor !== 'none') {
    const predictorMap = { 'horizontal': 'horizontal', 'float': 'float' };
    saveOpts.predictor = predictorMap[predictor] || 'none';
  }

  const tiffBuffer = image.writeToBuffer('.tiff', saveOpts);

  image.delete();
  return new Uint8Array(tiffBuffer);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 6: Multi-page TIFF Support
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get page count and per-page dimensions of a multi-page TIFF.
 *
 * Strategy: probe successive pages (page=0, page=1, ...) until loading fails.
 * This is the most reliable approach across all wasm-vips versions since
 * metadata fields like 'n-pages' and 'page-height' may not be available.
 *
 * @param {Uint8Array} bytes - TIFF file bytes
 * @returns {{ pages: number, pageWidth: number, pageHeight: number }}
 */
async function tiffPageCount(bytes) {
  const v = await initVips();

  // First, try metadata-based detection (fast path)
  let metadataPages = 0;
  try {
    const testImg = v.Image.newFromBuffer(bytes, '', { access: 'sequential' });
    // Try to get n-pages from the loader
    try { metadataPages = testImg.get('n-pages'); } catch {}
    testImg.delete();
  } catch {}

  if (metadataPages > 1) {
    // Metadata gave us the answer — get first page dimensions
    const firstPage = v.Image.newFromBuffer(bytes, '', { page: 0, access: 'sequential' });
    const pageWidth = firstPage.width;
    const pageHeight = firstPage.height;
    firstPage.delete();
    console.log('[vips-worker] tiffPageCount (metadata): pages=' + metadataPages + ', w=' + pageWidth + ', h=' + pageHeight);
    return { pages: metadataPages, pageWidth, pageHeight };
  }

  // Fallback: probe pages by trying to load them sequentially
  // Load page 0 to get base dimensions
  const page0 = v.Image.newFromBuffer(bytes, '', { page: 0, access: 'sequential' });
  const pageWidth = page0.width;
  const pageHeight = page0.height;
  page0.delete();

  // Try loading page 1, 2, 3... until it fails
  let pages = 1;
  const MAX_PAGES = 1000; // Safety limit
  for (let i = 1; i < MAX_PAGES; i++) {
    try {
      const testPage = v.Image.newFromBuffer(bytes, '', { page: i, access: 'sequential' });
      testPage.delete();
      pages++;
    } catch {
      // Page doesn't exist — we've found the count
      break;
    }
  }

  console.log('[vips-worker] tiffPageCount (probe): pages=' + pages + ', w=' + pageWidth + ', h=' + pageHeight);
  return { pages, pageWidth, pageHeight };
}

/**
 * Decode a specific page of a multi-page TIFF to RGBA pixel data.
 *
 * @param {Uint8Array} bytes - TIFF file bytes
 * @param {number} page - Zero-based page index
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
async function tiffDecodePage(bytes, page) {
  const v = await initVips();

  const image = v.Image.newFromBuffer(bytes, '', {
    page,
    access: 'sequential',
  });

  // Convert to sRGB if needed
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

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 6: Multi-layer 16-bit Composite Export
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Composite multiple layers into a single 16-bit TIFF/PNG output using vips.
 *
 * Each layer is provided as raw file bytes (TIFF/PNG/RAW for 16-bit, or 8-bit PNG display).
 * Layers without raw source are upsampled from 8-bit to 16-bit (value * 257).
 *
 * @param {object} params
 * @param {Array<{bytes: Uint8Array, x: number, y: number, blendMode: string, opacity: number, is8bit: boolean}>} params.layers
 * @param {number} params.canvasWidth
 * @param {number} params.canvasHeight
 * @param {object} params.outputOptions - { format, compression, dpi, jpegQuality, bigtiff, tile, tileWidth, tileHeight }
 * @returns {Uint8Array} - Encoded output bytes
 */
async function composite16bit(params) {
  const v = await initVips();

  const { layers, canvasWidth, canvasHeight, outputOptions = {} } = params;
  const {
    format = 'tiff',
    compression = 'lzw',
    dpi = 72,
    jpegQuality = 85,
    bigtiff = false,
    tile = false,
    tileWidth = 256,
    tileHeight = 256,
  } = outputOptions;

  // Create transparent 16-bit RGBA base canvas
  // vips uses bands for channels: 4 bands = RGBA
  let base = v.Image.black(canvasWidth, canvasHeight, { bands: 4 }).cast('ushort');
  // Ensure all bands are zero (transparent black in premultiplied or straight alpha)

  const overlayImages = [];
  const blendModes = [];
  const xPositions = [];
  const yPositions = [];

  for (const layer of layers) {
    try {
      // Load layer image from bytes
      let img = v.Image.newFromBuffer(layer.bytes, '', { access: 'sequential' });

      // Convert to sRGB if needed
      if (img.interpretation !== 'srgb' && img.interpretation !== 'b-w' && img.interpretation !== 'rgb16') {
        img = img.colourspace('srgb');
      }

      // If 8-bit source, upscale to 16-bit (value * 257)
      if (layer.is8bit || img.format === 'uchar') {
        img = img.linear(257.0, 0).cast('ushort');
      } else if (img.format === 'float' || img.format === 'double') {
        img = img.linear(65535.0, 0).cast('ushort');
      }
      // 'ushort' is already 16-bit

      // Ensure RGBA (4 bands)
      if (!img.hasAlpha()) {
        // Add fully opaque alpha channel (65535 for 16-bit)
        const alpha = v.Image.black(img.width, img.height).add(65535).cast('ushort');
        img = img.bandjoin(alpha);
      }
      if (img.bands > 4) {
        img = img.extractBand(0, { n: 4 });
      }

      // Apply opacity by scaling the alpha channel
      if (layer.opacity < 1.0) {
        // Extract RGB and alpha separately
        const rgb = img.extractBand(0, { n: 3 });
        let alpha = img.extractBand(3);
        alpha = alpha.linear(layer.opacity, 0);
        img = rgb.bandjoin(alpha);
      }

      overlayImages.push(img);
      blendModes.push(v.BlendMode[layer.blendMode] ?? v.BlendMode.over);
      xPositions.push(Math.round(layer.x));
      yPositions.push(Math.round(layer.y));
    } catch (err) {
      console.warn('[vips-worker] Failed to process layer:', err?.message);
      // Skip this layer
    }
  }

  // Composite all layers onto base
  if (overlayImages.length > 0) {
    base = base.composite(overlayImages, blendModes, {
      x: xPositions,
      y: yPositions,
    });
  }

  // Ensure output is 16-bit ushort RGBA
  if (base.format !== 'ushort') {
    base = base.cast('ushort');
  }

  // Write output
  let outputBuffer;
  if (format === 'png') {
    outputBuffer = base.writeToBuffer('.png', { bitdepth: 16 });
  } else {
    const compressionMap = { 'none': 'none', 'lzw': 'lzw', 'zip': 'deflate', 'jpeg': 'jpeg' };
    const vipsCompression = compressionMap[compression] || 'lzw';
    const saveOpts = {
      bitdepth: 16,
      compression: vipsCompression,
      xres: dpi / 25.4,
      yres: dpi / 25.4,
      resunit: 'inch',
      bigtiff,
    };
    if (compression === 'jpeg') {
      saveOpts.Q = jpegQuality;
      saveOpts.tile = true;
      saveOpts.tile_width = tileWidth;
      saveOpts.tile_height = tileHeight;
      // JPEG TIFF doesn't support 16-bit, downcast to 8-bit
      base = base.linear(1.0 / 257.0, 0).cast('uchar');
      delete saveOpts.bitdepth;
    } else if (tile) {
      saveOpts.tile = true;
      saveOpts.tile_width = tileWidth;
      saveOpts.tile_height = tileHeight;
    }
    outputBuffer = base.writeToBuffer('.tiff', saveOpts);
  }

  // Cleanup
  base.delete();
  for (const img of overlayImages) img.delete();

  return new Uint8Array(outputBuffer);
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

const handlers = { decodeTiff, encodeTiff, exportHighRes, tiffPageCount, tiffDecodePage, composite16bit };

// 🔍 Diagnostic: log available handlers on worker load
console.log('[vips-worker] v2026-0708-phase6 loaded. Available handlers:', Object.keys(handlers).join(', '));

self.onmessage = async ({ data: msg }) => {
  const { id, fn, args } = msg;

  if (!handlers[fn]) {
    console.error('[vips-worker] Unknown function requested:', fn, '| Available:', Object.keys(handlers).join(', '));
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
