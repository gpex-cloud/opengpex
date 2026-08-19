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
    // Load vips-heif.wasm for AVIF/HEIC encoding support (libheif + libaom)
    dynamicLibraries: ['vips-heif.wasm'],
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
// Worker Message Handler
// ═══════════════════════════════════════════════════════════════════════════════

const handlers = { decodeTiff, encodeTiff, tiffPageCount, tiffDecodePage };

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
