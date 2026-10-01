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
// ═══════════════════════════════════════════════════════════════════════════════
// ICC colour management (migrated from engine IccHandler, 20260912)
//
// vips is fundamentally a file-transcoding library (Little CMS built in), so ICC
// colour transforms belong to the files layer alongside TIFF/PNG container ops —
// NOT the engine render worker. These are the byte-for-byte transcriptions of the
// old `core/engine/worker/handlers/icc.ts` pipelines; moving them here lets the
// engine worker drop wasm-vips entirely (one vips instance instead of two).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert image bytes with a non-sRGB ICC profile to sRGB RGBA (8-bit).
 * vips reads the embedded profile and uses Little CMS for accurate conversion
 * (Adobe RGB, ProPhoto, Display P3, CMYK, custom profiles, …).
 *
 * @param {Uint8Array} bytes - Encoded image bytes (JPEG/PNG/WebP/TIFF/…)
 * @returns {{ width: number, height: number, data: Uint8Array, iccProfileData?: Uint8Array }}
 */
async function iccToSrgb(bytes) {
  const v = await initVips();

  // newFromBuffer automatically reads embedded ICC profiles.
  const image = v.Image.newFromBuffer(bytes, '', { access: 'sequential' });

  // Extract raw ICC profile bytes BEFORE conversion (for round-trip export).
  let iccProfileData;
  try {
    const iccRaw = image.get('icc-profile-data');
    if (iccRaw instanceof Uint8Array && iccRaw.length > 0) {
      iccProfileData = new Uint8Array(iccRaw);
    }
  } catch { /* no ICC profile embedded */ }

  // Convert to sRGB via Little CMS.
  let rgb = image;
  if (image.interpretation !== 'srgb' && image.interpretation !== 'b-w') {
    rgb = image.colourspace('srgb');
  }

  // Ensure 8-bit.
  let img8 = rgb;
  if (rgb.format !== 'uchar') {
    if (rgb.format === 'ushort') {
      img8 = rgb.linear(1.0 / 257.0, 0).cast('uchar');
    } else {
      img8 = rgb.cast('uchar');
    }
  }

  // Ensure RGBA (4 bands).
  let rgba = img8;
  if (!img8.hasAlpha()) {
    rgba = img8.bandjoin(255);
  } else if (img8.bands > 4) {
    rgba = img8.extractBand(0, { n: 4 });
  }

  const width = rgba.width;
  const height = rgba.height;
  const rawBuffer = rgba.writeToBuffer('.raw');
  const data = new Uint8Array(rawBuffer);

  // Cleanup
  image.delete();
  if (rgb !== image) rgb.delete();
  if (img8 !== rgb) img8.delete();
  if (rgba !== img8) rgba.delete();

  return { width, height, data, iccProfileData };
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

  const bandFormat = options?.bitDepth === 16 ? 'ushort' : 'uchar';
  let image = v.Image.newFromMemory(rgbaData, width, height, 4, bandFormat);

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
// Multi-page TIFF Support
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


/**
 * Unified files-layer decode entry (20260912 shared lib-vips proposal).
 *
 * ONE vips pass produces the 8-bit display RGBA AND, when `wantHighDepth`, the
 * naked high-bit-depth RGBA (ushort or float) — mirroring RAW's dual output.
 *
 * ⚠️ BIT-EXACTNESS: the 8-bit path here is a byte-for-byte transcription of the
 * engine FileIoHandler.decodeTiff (file-io.ts) so migrating TIFF/PNG off
 * `pixels.fileIO` produces identical pixels (no color regression):
 *   • honor `preserveColorSpace` (skip colourspace('srgb') when true)
 *   • ushort → linear(1/257).cast('uchar'); other non-uchar → cast('uchar')
 *   • ensure RGBA via bandjoin(255) / extractBand
 *
 * ⚠️ HIGH-DEPTH path mirrors engine FileIoHandler.decodeHighDepth: it is
 * color-management-AGNOSTIC (NO colourspace()), reads a FRESH image, routes
 * float/double → naked Float32Array and everything else → naked Uint16Array
 * (uchar promoted via linear(257).cast('ushort')). f16 packing is done on the
 * MAIN thread in lib-vips.ts (color/float16), so we only ship naked buffers.
 *
 * ⚠️ `page` (default 0) selects the page inside a multi-page container and MUST
 * be honoured by BOTH reads below. This is the only vips entry that emits the
 * 8-bit display pixels and the high-depth naked pixels from ONE pass, so it is
 * also the only way per-page high-depth is physically obtainable; honouring it
 * on just the 8-bit read would pair page i's tags with page 0's pixels — worse
 * than not supporting it at all.
 *
 * @param {Uint8Array} bytes
 * @param {{ preserveColorSpace?: boolean, wantHighDepth?: boolean, page?: number }} [opts]
 */
async function decode(bytes, opts) {
  const v = await initVips();
  const { preserveColorSpace = false, wantHighDepth = false, page = 0 } = opts || {};

  // ── 8-bit display path (bit-exact with engine decodeTiff) ──────────────────
  const image = v.Image.newFromBuffer(bytes, '', { page, access: 'sequential' });

  let rgb = image;
  if (!preserveColorSpace && image.interpretation !== 'srgb' && image.interpretation !== 'b-w') {
    rgb = image.colourspace('srgb');
  }

  let img8 = rgb;
  if (rgb.format !== 'uchar') {
    if (rgb.format === 'ushort') {
      img8 = rgb.linear(1.0 / 257.0, 0).cast('uchar');
    } else {
      img8 = rgb.cast('uchar');
    }
  }

  let rgba = img8;
  if (!img8.hasAlpha()) {
    rgba = img8.bandjoin(255);
  } else if (img8.bands > 4) {
    rgba = img8.extractBand(0, { n: 4 });
  }

  const width = rgba.width;
  const height = rgba.height;
  const data = new Uint8Array(rgba.writeToBuffer('.raw'));

  image.delete();
  if (rgb !== image) rgb.delete();
  if (img8 !== rgb) img8.delete();
  if (rgba !== img8) rgba.delete();

  const result = { width, height, data };

  // ── High-bit-depth naked pixels (mirrors engine decodeHighDepth) ───────────
  if (wantHighDepth) {
    const hi = v.Image.newFromBuffer(bytes, '', { page, access: 'sequential' });
    const fmt = hi.format;
    const isFloat = fmt === 'float' || fmt === 'double';
    const sourceBitDepth = fmt === 'ushort' ? 16 : isFloat ? 32 : 8;

    const interp = hi.interpretation;
    const sourceTrc = interp === 'scrgb' || interp === 'xyz' ? 'linear' : 'srgb-trc';

    let hw;
    let hh;
    let naked;

    if (isFloat) {
      // double → float so the naked buffer is 4-byte f32 (main-thread packing
      // reads Float32Array); precision-preserving down-cast.
      const src = fmt === 'double' ? hi.cast('float') : hi;

      let hrgba = src;
      if (!src.hasAlpha()) {
        hrgba = src.bandjoin(1); // opaque alpha in float space = 1.0
      } else if (src.bands > 4) {
        hrgba = src.extractBand(0, { n: 4 });
      }

      hw = hrgba.width;
      hh = hrgba.height;
      const raw = hrgba.writeToMemory();
      const f32 = new Float32Array(raw.buffer, raw.byteOffset, hw * hh * 4);
      naked = new Float32Array(f32); // copy → standalone transferable buffer

      hi.delete();
      if (src !== hi) src.delete();
      if (hrgba !== src) hrgba.delete();
    } else {
      // ushort branch (+ uchar promotion). No colourspace() — precision axis is
      // color-management-agnostic. uchar → linear(257).cast('ushort') so /65535
      // downstream yields the same [0,1] value the 8-bit path would.
      let src = hi;
      if (fmt !== 'ushort') {
        src = fmt === 'uchar' ? hi.linear(257, 0).cast('ushort') : hi.cast('ushort');
      }

      let hrgba = src;
      if (!src.hasAlpha()) {
        hrgba = src.bandjoin(65535); // opaque alpha in the 16-bit range
      } else if (src.bands > 4) {
        hrgba = src.extractBand(0, { n: 4 });
      }

      hw = hrgba.width;
      hh = hrgba.height;
      const raw = hrgba.writeToMemory();
      const u16 = new Uint16Array(raw.buffer, raw.byteOffset, hw * hh * 4);
      naked = new Uint16Array(u16); // copy → standalone transferable buffer

      hi.delete();
      if (src !== hi) src.delete();
      if (hrgba !== src) hrgba.delete();
    }

    // Only surface high-depth when the source is GENUINELY >8-bit; an 8-bit
    // source promoted to ushort must NOT fatten to f16 (caller keeps 8-bit path).
    if (sourceBitDepth > 8) {
      result.highDepth = { width: hw, height: hh, naked, isFloat, sourceBitDepth, sourceTrc };
    }
  }

  return result;
}

/**
 * Encode RGBA pixel data → PNG bytes (supports 8/16-bit).
 *
 * @param {Uint8Array} rgbaData - RGBA pixel data (8-bit uchar or 16-bit ushort)
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {object} options - Encode options
 * @param {number} [options.compression=6] - Compression level 0-9
 * @param {number} [options.dpi=72] - DPI
 * @param {Uint8Array} [options.iccProfileBytes] - Optional ICC Profile bytes
 * @param {number} [options.bitDepth=8] - 8 or 16
 * @returns {Promise<Uint8Array>}
 */
async function encodePng(rgbaData, width, height, options) {
  const v = await initVips();

  const {
    compression = 6,
    dpi = 72,
    iccProfileBytes,
    bitDepth = 8,
  } = options || {};

  const bandFormat = bitDepth === 16 ? 'ushort' : 'uchar';
  let image = v.Image.newFromMemory(rgbaData, width, height, 4, bandFormat);

  if (iccProfileBytes && iccProfileBytes.length > 0) {
    try {
      image.set('icc-profile-data', iccProfileBytes);
    } catch (e) {
      console.warn('[vips-worker] ICC attachment failed in encodePng:', e?.message);
    }
  }

  const saveOpts = {
    compression: Number(compression) || 6,
    xres: dpi / 25.4,
    yres: dpi / 25.4,
  };

  const pngBuffer = image.writeToBuffer('.png', saveOpts);
  image.delete();

  return new Uint8Array(pngBuffer);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Message Handler
// ═══════════════════════════════════════════════════════════════════════════════

const handlers = { decode, decodeTiff, encodeTiff, encodePng, tiffPageCount, tiffDecodePage, iccToSrgb };

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
    // Unified `decode` also ships naked high-depth pixels (ushort/float).
    if (result.highDepth && result.highDepth.naked && result.highDepth.naked.buffer) {
      transferables.push(result.highDepth.naked.buffer);
    }
    // `iccToSrgb` also returns the raw ICC profile bytes (for round-trip export).
    if (result.iccProfileData instanceof Uint8Array && result.iccProfileData.buffer) {
      transferables.push(result.iccProfileData.buffer);
    }
  }
  return transferables;
}
