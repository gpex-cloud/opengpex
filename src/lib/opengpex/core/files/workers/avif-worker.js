/**
 * OpenGPEX - AVIF Codec Worker (@jsquash/avif ST encode + decode)
 *
 * Dedicated Worker for AVIF encoding AND decoding using @jsquash/avif
 * (Emscripten ST builds). Lazily loaded by AvifHandler for AVIF export and
 * by the `avif-proxy` ingest channel (15b / 16-wg) for high-depth decode.
 *
 * - Encode: ST encoder (avif_enc.js) — no MT pthreads.
 * - Decode: libavif/dav1d wasm (avif_dec.js) — bit-exact at native depth
 *   (gpex-cloud/probes/avif B2: meanDev ≤ 0.86/255 across all samples,
 *   lossless ramps round-trip with zero error; 12MP ≈ 0.57s steady-state).
 *   The decoder is probed-validated against @jsquash/avif 2.1.1 EXACTLY —
 *   bumping the package requires re-running the probe sample gate.
 * - WASM + JS served from /ext/wasm/avif/ (enc) and /ext/wasm/avif/dec/ (dec).
 * - Protocol:
 *     encode: { id, rgbaData, width, height, options } → { id, avifBytes } | { id, error }
 *     decode: { id, op: 'decode', avifBytes, bitDepth } →
 *             { id, pixels, width, height, isU16, bitDepth } | { id, error }
 *   (messages without `op` are encodes — backward compatible)
 *
 * SPDX-License-Identifier: GPL-3.0-only
 */

let avifModule = null;
let avifDecModule = null;

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

async function ensureAvifDecReady() {
  if (avifDecModule) return;

  const avifDec = await import('/ext/wasm/avif/dec/avif_dec.js');
  avifDecModule = await avifDec.default({
    locateFile: (file) => `/ext/wasm/avif/dec/${file}`,
  });

  console.log('[AvifWorker] avif_dec.wasm initialized (libavif decode)');
}

/**
 * Encode RGBA → AVIF.
 *
 * `rgbaData` is a `Uint8Array` (SDR lane, 8-bit) or a `Uint16Array` (HDR lane,
 * PQ code values 0..1023 with `options.bitDepth: 10`) — the encoder's
 * `bitDepth` option selects how the buffer words are read; the SDR default
 * path is unchanged.
 */
async function encodeAvif(rgbaData, width, height, options) {
  await ensureAvifReady();

  const encOpts = { ...defaultOptions, ...options };
  const bytes = new Uint8Array(
    rgbaData.buffer,
    rgbaData.byteOffset,
    rgbaData.byteLength,
  );
  const output = avifModule.encode(bytes, width, height, encOpts);

  if (!output) {
    throw new Error('Encoding error — encoder returned null');
  }

  return new Uint8Array(output.buffer || output);
}

/**
 * Decode AVIF → raw RGBA at the requested bit depth.
 * Returns a `Uint16Array` at NATIVE depth (0..2^bit−1 — NOT left-aligned ×64;
 * probe-calibrated) for bitDepth 10/12/16, or an 8-bit `Uint8ClampedArray`
 * ImageData-shaped buffer for the default 8.
 */
async function decodeAvif(avifBytes, bitDepth) {
  await ensureAvifDecReady();
  const img = avifDecModule.decode(new Uint8Array(avifBytes), bitDepth ?? 8);
  if (!img) {
    throw new Error('Decoding error — decoder returned null');
  }
  return img;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Worker Message Handler
// ═══════════════════════════════════════════════════════════════════════════════

self.onmessage = async ({ data: msg }) => {
  const { id, op } = msg;

  try {
    if (op === 'decode') {
      const img = await decodeAvif(msg.avifBytes, msg.bitDepth);
      const pixels = img.data instanceof Uint16Array
        ? new Uint16Array(img.data)
        : new Uint8ClampedArray(img.data.buffer || img.data);
      self.postMessage(
        { id, pixels, width: img.width, height: img.height, isU16: img.data instanceof Uint16Array, bitDepth: msg.bitDepth ?? 8 },
        [pixels.buffer],
      );
      return;
    }

    // default: encode (legacy messages carry no `op`)
    const { rgbaData, width, height, options } = msg;
    const avifBytes = await encodeAvif(rgbaData, width, height, options || {});
    self.postMessage({ id, avifBytes }, [avifBytes.buffer]);
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};
