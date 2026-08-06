/**
 * OpenGPEX - AVIF Encoder Worker (@jsquash/avif ST mode)
 *
 * Dedicated Worker for AVIF encoding using @jsquash/avif (Emscripten ST encoder).
 * Lazily loaded by AvifHandler when AVIF export is triggered.
 *
 * - Forces ST encoder (avif_enc.js) — no MT pthreads.
 * - WASM + JS served from /ext/wasm/avif/ via locateFile override.
 * - Protocol: { id, rgbaData, width, height, options } → { id, avifBytes } | { id, error }
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

let avifModule = null;

/** Default encoding options (inlined from @jsquash/avif/meta.js) */
const defaultOptions = {
  quality: 50,
  qualityAlpha: -1,
  denoiseLevel: 0,
  tileColsLog2: 0,
  tileRowsLog2: 0,
  speed: 6,
  subsample: 1,   // YUV420
  chromaDeltaQ: false,
  sharpness: 0,
  tune: 0,        // AVIFTune.auto
  enableSharpYUV: false,
  bitDepth: 8,
  lossless: false,
};

async function ensureAvifReady() {
  if (avifModule) return;

  // Dynamic import of the Emscripten ST encoder module (served from same directory)
  const avifEnc = await import('/ext/wasm/avif/avif_enc.js');

  // Call the Emscripten factory with locateFile to resolve .wasm path
  avifModule = await avifEnc.default({
    locateFile: (file) => `/ext/wasm/avif/${file}`,
  });

  console.log('[AvifWorker] avif_enc.wasm initialized (ST mode)');
}

/**
 * Encode RGBA → AVIF.
 */
async function encodeAvif(rgbaData, width, height, options) {
  await ensureAvifReady();

  const encOpts = { ...defaultOptions, ...options };
  const output = avifModule.encode(
    new Uint8Array(rgbaData.buffer || rgbaData),
    width,
    height,
    encOpts,
  );

  if (!output) {
    throw new Error('Encoding error — encoder returned null');
  }

  return new Uint8Array(output.buffer || output);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Message Handler
// ═══════════════════════════════════════════════════════════════════════════════

self.onmessage = async ({ data: msg }) => {
  const { id, rgbaData, width, height, options } = msg;

  try {
    const avifBytes = await encodeAvif(rgbaData, width, height, options || {});
    self.postMessage({ id, avifBytes }, [avifBytes.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
