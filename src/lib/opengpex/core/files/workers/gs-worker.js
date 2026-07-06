/**
 * OpenGPEX - EPS Rasterizer Worker (ghostpdl-wasm)
 *
 * Dedicated Worker for EPS/PS → PNG rasterization using Ghostscript WASM.
 * Lazily loaded by VectorHandler when EPS files are imported.
 *
 * Protocol: { id, fn, args } → { id, out } | { id, error }
 *
 * Functions:
 * - transcodeEps(epsBytes: Uint8Array, params: { width, height, dpi }) → Uint8Array (PNG)
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

let gsInstance = null;

async function ensureGsReady() {
  if (gsInstance) return;

  // Dynamic import of the Ghostscript Emscripten module
  const gsModule = await import('/ext/wasm/gs/gs.js');
  const GsModuleFactory = gsModule.default;

  gsInstance = await GsModuleFactory({
    locateFile: (path) => `/ext/wasm/gs/${path}`,
    print: () => {},
    printErr: () => {},
  });

  console.log('[GsWorker] ghostpdl-wasm initialized');
}

/**
 * Transcode EPS bytes → PNG bytes using Ghostscript WASM.
 */
async function transcodeEps(epsBytes, params) {
  await ensureGsReady();

  // Write EPS to Ghostscript virtual filesystem
  gsInstance.FS.writeFile('/input.eps', new Uint8Array(epsBytes));

  // ═══════════════════════════════════════════════════════════════════════════
  // Ghostscript command-line arguments: EPS → PNG with alpha
  //
  // Why -dEPSFitPage (not -dEPSCrop):
  //   -dEPSCrop only sets the device page size from BoundingBox but does NOT
  //   guarantee the EPS content fills the output. Many EPS files have internal
  //   transforms (scale/translate) that cause the artwork to render smaller
  //   than the BoundingBox area — resulting in "image smaller than canvas".
  //
  //   -dEPSFitPage scales the EPS content to FIT the device page, matching
  //   Photoshop's "Open EPS" behavior where image always equals canvas size.
  //
  // -g<w>x<h>: forces exact output pixel dimensions.
  //   width/height come from parseEpsBoundingBox() in vector.ts (urx-llx, ury-lly).
  // -r<dpi>: resolution. At 72 DPI, 1 PostScript point = 1 pixel.
  // ═══════════════════════════════════════════════════════════════════════════
  const dpi = params.dpi || 72;
  const args = [
    '-sDEVICE=pngalpha',
    `-r${dpi}`,
    `-g${params.width}x${params.height}`,
    '-dEPSFitPage',
    '-dBATCH',
    '-dNOPAUSE',
    '-dQUIET',
    '-dTextAlphaBits=4',
    '-dGraphicsAlphaBits=4',
    '-sOutputFile=/output.png',
    '-f', '/input.eps'
  ];

  gsInstance.callMain(args);

  // Read output PNG from virtual filesystem
  const pngData = gsInstance.FS.readFile('/output.png');

  // Clean up virtual filesystem
  try {
    gsInstance.FS.unlink('/input.eps');
    gsInstance.FS.unlink('/output.png');
  } catch { /* ignore cleanup errors */ }

  return new Uint8Array(pngData);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Message Handler
// ═══════════════════════════════════════════════════════════════════════════════

const handlers = { transcodeEps };

self.onmessage = async ({ data: msg }) => {
  const { id, fn, args } = msg;

  if (!handlers[fn]) {
    self.postMessage({ id, error: `Unknown function: ${fn}` });
    return;
  }

  try {
    const result = await handlers[fn](...(args || []));
    const transfer = result?.buffer ? [result.buffer] : [];
    self.postMessage({ id, out: result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
